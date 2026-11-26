'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  confirmStripeCardPayment,
  payWithMercadoPagoCard,
  payWithMercadoPagoCardCheckoutPro,
  payWithMercadoPagoOxxo,
  payWithMercadoPagoSpei,
  payWithMercadoPagoSpeiEmbedded,
  payWithStripeCard,
  payWithStripeOxxo,
  payWithStripeSpei,
  placeOrder,
  validatePlayer,
  type CheckoutState,
  type EmbeddedCheckoutState,
  type ValidateState,
} from './actions';
import { CardPaymentBrick } from './card-payment-brick';
import { StripePaymentElement } from './stripe-payment-element';
import { setPixelUserData, trackPixel } from '../../../lib/pixel';
import { GatewayTabNotice, useStripeTabRedirect } from '../../../lib/gateway-tab-redirect';
import { getMercadoPagoDeviceSessionId, loadMercadoPagoSecurity } from '../../../lib/mercadopago-device';
import { BankIcon, CardIcon, StoreIcon } from '../../icons';

interface PayTo {
  bank: string;
  clabe: string;
  holder: string;
  oxxo: string | null;
  cardNumber: string | null;
}

interface Props {
  comboKey: string;
  comboName: string;
  price: string;
  priceMxn: number;
  diamonds: string;
  /** Set only when a valid, currently-active Vault discount resolved server-side for this visitor. */
  vaultOfferId?: string | null;
  /** The combo's ordinary price, for the struck-through comparison — set together with `vaultOfferId`. */
  publicPrice?: string | null;
  /** Null when nobody has configured where the money goes. */
  payTo: PayTo | null;
  /** Stripe is configured for card — its own explicit "Tarjeta" button, embedded (Payment Element), never a redirect. */
  cardEnabled: boolean;
  /** Stripe's publishable (non-secret) key for the Payment Element — null means the card button can't render even if `cardEnabled` is true. */
  stripePublishableKey: string | null;
  /**
   * Stripe is configured for OXXO — the "Depósito OXXO" box redirects
   * straight to Stripe's own OXXO reference instead of the manual one below.
   */
  cardIncludesOxxo: boolean;
  /**
   * Stripe is configured for SPEI (customer_balance) — the "Transferencia
   * bancaria" box redirects straight to Stripe's own transfer instructions
   * instead of the manual CLABE below.
   */
  cardIncludesSpei: boolean;
  /**
   * Mercado Pago is configured for OXXO — takes priority over Stripe's own
   * OXXO (see lib/mercadopago.ts) since Stripe's OXXO settlement via PPRO has
   * proven unreliable; this is the fix for that, not just another option.
   */
  mercadoPagoOxxoEnabled: boolean;
  /**
   * Mercado Pago is configured for SPEI — takes priority over Stripe's own
   * SPEI (see lib/mercadopago.ts), same reason as OXXO above: Stripe's own
   * SPEI settlement via PPRO proved unreliable too.
   */
  mercadoPagoSpeiEnabled: boolean;
  /**
   * Mercado Pago's hosted Checkout Pro is configured for card — its own
   * explicit "Mercado Pago" button, always shown next to Stripe's "Tarjeta"
   * one, not a fallback for it (see mercadopago.ts's own doc comment).
   * Still wins over the dormant embedded Orders-API card flow below in case
   * that one is somehow still on too — see that prop's own comment.
   */
  mercadoPagoCardCheckoutProEnabled: boolean;
  /**
   * Mercado Pago's embedded Checkout (Orders API) is configured for card —
   * dormant as of 2026-11-26 (see lib/mercadopago-embedded.ts), kept wired
   * rather than deleted. Only still used if, for some reason, Checkout Pro's
   * card flag above is off and this one is somehow still on.
   */
  mercadoPagoCardEnabled: boolean;
  /**
   * Mercado Pago's embedded Checkout is configured for SPEI — takes priority
   * over both the Checkout-Pro Mercado Pago SPEI and Stripe's own, per the
   * client's ask to move SPEI off Checkout Pro onto an embedded flow too.
   */
  mercadoPagoSpeiEmbeddedEnabled: boolean;
  /** Public (non-secret) key for Mercado Pago's client-side SDK — null means the embedded flow can't render even if the flags above are on. */
  mercadoPagoPublicKey: string | null;
  /** Owner switch for the manual (human-reviewed) transfer — only matters when neither gateway's SPEI is on. */
  transferEnabled: boolean;
  /** Owner switch for the manual (human-reviewed) OXXO reference — only matters when Stripe's OXXO is off. */
  oxxoEnabled: boolean;
  /** The customer came back from Stripe without paying. */
  cancelledNotice: string | null;
  supportNumber: string;
  isLoggedIn: boolean;
}

/**
 * What's actually being paid, one screen at a time. `transferencia` and
 * `oxxo` both submit as the same backend `transfer_manual` order — see
 * schema.ts's own comment on that enum value — this is a display distinction
 * for the two account numbers a customer might send money to, not two
 * different payment integrations. `tarjeta-stripe` and `tarjeta-mp` ARE two
 * different integrations (Stripe's own embedded card vs. whichever Mercado
 * Pago card flow is live) — the client's own ask, 2026-11-26, is that both
 * show as separate, always-visible buttons, never one ladder that silently
 * picks between them.
 */
type PayView = 'choose' | 'tarjeta-stripe' | 'tarjeta-mp' | 'transferencia' | 'oxxo';
type Step = 'datos' | 'pago' | 'confirmacion';

const STEPS: { key: Step; label: string }[] = [
  { key: 'datos', label: 'Datos' },
  { key: 'pago', label: 'Pago' },
  { key: 'confirmacion', label: 'Confirmación' },
];

/** 18 digits read as three groups, the way a bank statement prints them. */
const groupClabe = (clabe: string): string =>
  clabe.replace(/^(\d{3})(\d{3})(\d{11})(\d)$/, '$1 $2 $3 $4');

/** 16 digits read in the four groups printed on the card itself. */
const groupCard = (card: string): string => card.replace(/(\d{4})(?=\d)/g, '$1 ');

/** The numbered progress header from the client's mockup. */
function Stepper({ step }: { step: Step }) {
  const current = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="stepper" aria-label="Pasos de la compra">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          className={`step ${i < current ? 'done' : i === current ? 'on' : ''}`}
        >
          <i aria-hidden="true">{i < current ? '✓' : i + 1}</i>
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** A value next to a button that copies it — for an account number nobody wants to retype. */
function CopyRow({ label, value, display }: { label: string; value: string; display: string }) {
  return (
    <div className="pay-row">
      <span>{label}</span>
      <span className="pay-copy">
        <strong className="mono">{display}</strong>
        <button
          type="button"
          className="copy-btn"
          aria-label={`Copiar ${label}`}
          onClick={() => {
            navigator.clipboard?.writeText(value).catch(() => {
              /* Clipboard access can be denied; the value is still on screen to copy by hand. */
            });
          }}
        >
          📋
        </button>
      </span>
    </div>
  );
}

/** One tappable option on the "choose how to pay" screen. */
function PayOptionCard({
  tone,
  icon: Icon,
  badge,
  title,
  features,
  extra,
  ctaLabel,
  onClick,
  showAutoBadge = true,
}: {
  tone: 'blue' | 'red' | 'purple';
  icon: (props: { className?: string }) => React.ReactElement;
  badge?: string;
  title: string;
  features: string[];
  extra?: React.ReactNode;
  ctaLabel: string;
  onClick: () => void;
  /** Jose: credit card must not show the Automático / Recarga automática chip. */
  showAutoBadge?: boolean;
}) {
  const kind = tone === 'purple' ? 'tarjeta' : tone === 'blue' ? 'spei' : 'oxxo';
  const estadoRojo = tone === 'red' && Boolean(badge?.includes('24'));
  return (
    <section className={`pago ${kind}`}>
      <div className="head">
        <span className="ic" aria-hidden="true">
          <Icon className="icon" />
        </span>
        <h3>{title}</h3>
        {badge && (
          <span className={`estado${estadoRojo ? ' rojo' : ''}`}>{badge.replace(/^⚡\s*/, '')}</span>
        )}
      </div>
      {showAutoBadge && <span className="badge-auto">Recarga automática</span>}
      <ul>
        {features.map((f) => (
          <li key={f}>
            <span aria-hidden="true">✓</span> {f}
          </li>
        ))}
      </ul>
      {extra}
      <button type="button" className="btn-primary" onClick={onClick}>
        {ctaLabel}
      </button>
    </section>
  );
}

/**
 * Three full screens instead of stacked cards, matching the client's own
 * mockup (Compra-Datos / Método de Pago / Confirmación). The gate between
 * "Datos" and the rest still matters exactly as before: the customer cannot
 * reach payment until their Free Fire ID has been confirmed against the
 * game, since diamonds sent to a wrong ID are unrecoverable.
 *
 * Deliberately NOT in this version, even though earlier mockups showed them:
 * a "Servidor" field and a mid-checkout package-switch step (neither is real
 * — nothing downstream reads a server id, and the package is fixed by which
 * combo card the customer tapped to get here), and PayPal (not built). The
 * transfer/OXXO comparison cards ARE real — both submit the same
 * `transfer_manual` order, just with a different account shown, exactly as
 * `schema.ts`'s own comment on that enum value describes.
 */
export function Checkout({
  comboKey,
  comboName,
  price,
  priceMxn,
  diamonds,
  vaultOfferId = null,
  publicPrice = null,
  payTo,
  cardEnabled,
  stripePublishableKey,
  cardIncludesOxxo,
  cardIncludesSpei,
  mercadoPagoOxxoEnabled,
  mercadoPagoSpeiEnabled,
  mercadoPagoCardCheckoutProEnabled,
  mercadoPagoCardEnabled,
  mercadoPagoSpeiEmbeddedEnabled,
  mercadoPagoPublicKey,
  transferEnabled,
  oxxoEnabled,
  cancelledNotice,
  supportNumber,
  isLoggedIn,
}: Props) {
  const [validation, validateAction, validating] = useActionState<ValidateState, FormData>(
    validatePlayer,
    { status: 'idle' },
  );
  const [transfer, transferAction, placing] = useActionState<CheckoutState, FormData>(
    placeOrder,
    {},
  );
  const [stripeOxxo, stripeOxxoAction, oxxoRedirecting] = useActionState<CheckoutState, FormData>(
    payWithStripeOxxo,
    {},
  );
  const [stripeSpei, stripeSpeiAction, speiRedirecting] = useActionState<CheckoutState, FormData>(
    payWithStripeSpei,
    {},
  );
  const [mpOxxo, mpOxxoAction, mpOxxoRedirecting] = useActionState<CheckoutState, FormData>(
    payWithMercadoPagoOxxo,
    {},
  );
  const [mpSpei, mpSpeiAction, mpSpeiRedirecting] = useActionState<CheckoutState, FormData>(
    payWithMercadoPagoSpei,
    {},
  );
  const [mpCard, mpCardAction, mpCardRedirecting] = useActionState<CheckoutState, FormData>(
    payWithMercadoPagoCardCheckoutPro,
    {},
  );
  const [mpSpeiEmbedded, mpSpeiEmbeddedAction, mpSpeiEmbeddedProcessing] = useActionState<
    EmbeddedCheckoutState,
    FormData
  >(payWithMercadoPagoSpeiEmbedded, {});
  const openOxxoTab = useStripeTabRedirect(stripeOxxo);
  const openSpeiTab = useStripeTabRedirect(stripeSpei);
  const openMpOxxoTab = useStripeTabRedirect(mpOxxo);
  const openMpSpeiTab = useStripeTabRedirect(mpSpei);
  const openMpCardTab = useStripeTabRedirect(mpCard);
  const [step, setStep] = useState<Step>('datos');
  const router = useRouter();

  // The order page already builds exactly the layout a CLABE result needs —
  // loading state up top, payment details (CLABE/beneficiary/reference) in
  // the middle swapping to a confirmed state once paid, order summary at the
  // bottom — and already polls for that confirmation. Sending the customer
  // there once the CLABE exists avoids maintaining a second, static copy of
  // the same screen here that never updates once payment lands. Confirmed
  // needed in production 2026-11-24 (Jose): the inline version here had the
  // order summary above the payment details, the reverse of what he wanted,
  // and no account-holder/reference fields.
  useEffect(() => {
    if (mpSpeiEmbedded.instructions?.kind === 'spei' && mpSpeiEmbedded.orderPageUrl) {
      router.push(mpSpeiEmbedded.orderPageUrl);
    }
  }, [mpSpeiEmbedded, router]);

  // Mercado Pago's Card Payment Brick owns its own submit round trip (see
  // card-payment-brick.tsx's doc comment) — it needs the real result the
  // instant the charge resolves, which `useActionState`'s own dispatch does
  // not hand back synchronously, so this one path calls the server action
  // directly instead of going through a `<form action={...}>`.
  const [mpCardResult, setMpCardResult] = useState<EmbeddedCheckoutState | null>(null);
  const [mpCardSubmitting, setMpCardSubmitting] = useState(false);
  const [mpCardWhatsapp, setMpCardWhatsapp] = useState('');
  const mpCardWhatsappRef = useRef(mpCardWhatsapp);
  mpCardWhatsappRef.current = mpCardWhatsapp;

  // Confirmed in production 2026-11-24: clicking Pagar gave no visible
  // feedback until Mercado Pago's own push notification showed up seconds
  // later — the result, once set, rendered above a card form the customer
  // had already scrolled past, so it was easy to never see at all. Scroll
  // whichever status message just appeared into view the instant it does,
  // for both "processing" and the final result.
  const mpCardStatusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mpCardSubmitting || mpCardResult) {
      mpCardStatusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [mpCardSubmitting, mpCardResult]);

  // Stripe's embedded card (Payment Element) — same two-phase shape as the
  // Mercado Pago Brick above, but genuinely two server round trips, not one:
  // `payWithStripeCard` only gets as far as a `clientSecret` (Stripe's own
  // JS confirms the charge in the browser, see stripe-payment-element.tsx),
  // and `confirmStripeCardPayment` reports what that confirmation actually
  // decided once it resolves.
  const [stripeWhatsapp, setStripeWhatsapp] = useState('');
  const stripeWhatsappRef = useRef(stripeWhatsapp);
  stripeWhatsappRef.current = stripeWhatsapp;
  const [stripeStarting, setStripeStarting] = useState(false);
  const [stripeSession, setStripeSession] = useState<{
    clientSecret: string;
    gatewayChargeId: string;
    orderNumber: string;
  } | null>(null);
  const [stripeStartError, setStripeStartError] = useState<string | null>(null);
  const [stripeConfirmError, setStripeConfirmError] = useState<string | null>(null);
  const [stripeConfirming, setStripeConfirming] = useState(false);

  // The embedded SPEI form has no Brick on screen to collect the device id
  // automatically — read it fresh right before submit instead of baking a
  // possibly-stale value into the hidden input at render time.
  const deviceInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Harmless to load even when only SPEI (or neither) is on — a few KB of
    // script, and the device id it sets is simply unused if no embedded
    // method ends up charging anything.
    loadMercadoPagoSecurity();
  }, []);

  const found = validation.status === 'found';

  // A gateway's own automatic version of each method wins over the manual,
  // human-reviewed one when it's actually enabled on the account — the client
  // asked for exactly one clean box per method instead of both showing at
  // once. The manual flow stays as the fallback for whichever method no
  // gateway has turned on, same as before. OXXO specifically has two possible
  // automatic gateways: Mercado Pago wins over Stripe's own OXXO when both are
  // configured, since Stripe's OXXO settlement via PPRO is the unreliable one
  // Mercado Pago was brought in to replace.
  const manualTransfer = payTo !== null && transferEnabled;
  const manualOxxo = payTo !== null && payTo.oxxo !== null && oxxoEnabled;
  const oxxoAutomatic: 'mercadopago' | 'stripe' | null = mercadoPagoOxxoEnabled
    ? 'mercadopago'
    : cardIncludesOxxo
      ? 'stripe'
      : null;
  // Embedded SPEI wins over Checkout-Pro Mercado Pago, which wins over
  // Stripe — same "newest automatic integration wins" ladder as OXXO above,
  // extended by one rung now that SPEI has two possible Mercado Pago paths.
  const transferAutomatic: 'mercadopago-embedded' | 'mercadopago' | 'stripe' | null =
    mercadoPagoSpeiEmbeddedEnabled && mercadoPagoPublicKey
      ? 'mercadopago-embedded'
      : mercadoPagoSpeiEnabled
        ? 'mercadopago'
        : cardIncludesSpei
          ? 'stripe'
          : null;
  // Card is no longer one ladder with Stripe as the fallback rung — the
  // client's own ask, 2026-11-26, is two always-visible buttons: Stripe's
  // own embedded card, and whichever Mercado Pago card integration is live
  // (Checkout Pro winning over the dormant embedded Orders-API one, same
  // reason as before — that one was declining ~80% of real cards).
  const stripeCardOption = cardEnabled && Boolean(stripePublishableKey);
  const mpCardKind: 'mercadopago-checkoutpro' | 'mercadopago-embedded' | null =
    mercadoPagoCardCheckoutProEnabled
      ? 'mercadopago-checkoutpro'
      : mercadoPagoCardEnabled && mercadoPagoPublicKey
        ? 'mercadopago-embedded'
        : null;
  const mpCardOption = mpCardKind !== null;

  const transferOption = transferAutomatic !== null || manualTransfer;
  const oxxoOption = oxxoAutomatic !== null || manualOxxo;
  const optionCount = [stripeCardOption, mpCardOption, transferOption, oxxoOption].filter(Boolean).length;
  const noPaymentConfigured = optionCount === 0;

  // Always shows the comparison screen, even with exactly one method
  // enabled — the owner turns methods on/off from Ajustes (e.g. card-only
  // overnight), and a customer landing straight on "Paga tu recarga" with no
  // card to tap first reads as broken, not as a shortcut.
  const [payView, setPayView] = useState<PayView>('choose');

  const pixel = { value: priceMxn, currency: 'MXN' as const, content_ids: [comboKey], content_type: 'product' as const };

  /**
   * Passes the WhatsApp along for Advanced Matching before firing
   * AddPaymentInfo — `setPixelUserData` must run first, since Meta's SDK only
   * attaches `userData` to `track` calls made after the `set`, never
   * retroactively to the one about to fire.
   */
  const trackPaymentInfo = (form: HTMLFormElement) => {
    const whatsapp = String(new FormData(form).get('whatsapp') ?? '');
    if (whatsapp) setPixelUserData({ whatsapp });
    trackPixel('AddPaymentInfo', pixel);
  };

  useEffect(() => {
    trackPixel('ViewContent', { ...pixel, content_name: comboName });
    // Once per page view, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmIdentity = () => {
    setStep('pago');
    // Set before tracking — see `trackPaymentInfo`'s comment above.
    if (validation.playerId) setPixelUserData({ playerId: validation.playerId });
    trackPixel('InitiateCheckout', pixel);
  };

  const methodLabel =
    payView === 'tarjeta-stripe'
      ? 'Tarjeta'
      : payView === 'tarjeta-mp'
        ? 'Mercado Pago'
        : payView === 'oxxo'
          ? 'Depósito OXXO'
          : 'Transferencia bancaria';
  const isCardView = payView === 'tarjeta-stripe' || payView === 'tarjeta-mp';

  // Stripe's embedded Payment Element has no `<form>` of its own to submit —
  // `onClick` on the "Continuar" button starts the charge directly instead,
  // so AddPaymentInfo fires there (see `startStripeCard` below) rather than
  // from a form's `onSubmit` the way every other method fires it.
  const startStripeCard = async () => {
    setStripeStarting(true);
    setStripeStartError(null);

    const whatsapp = stripeWhatsappRef.current.trim();
    setPixelUserData({ whatsapp });
    trackPixel('AddPaymentInfo', pixel);

    const fd = new FormData();
    fd.set('comboKey', comboKey);
    fd.set('playerId', validation.playerId ?? '');
    if (vaultOfferId) fd.set('vaultOfferId', vaultOfferId);
    fd.set('whatsapp', whatsapp);

    const result = await payWithStripeCard({}, fd);
    setStripeStarting(false);

    if (result.error || !result.clientSecret || !result.gatewayChargeId || !result.orderNumber) {
      setStripeStartError(result.error ?? 'No pudimos abrir el pago con tarjeta. Intenta de nuevo.');
      return;
    }
    setStripeSession({
      clientSecret: result.clientSecret,
      gatewayChargeId: result.gatewayChargeId,
      orderNumber: result.orderNumber,
    });
  };

  const handleStripeConfirmed = async (_status: string) => {
    if (!stripeSession) return;
    setStripeConfirming(true);
    setStripeConfirmError(null);

    const fd = new FormData();
    fd.set('gatewayChargeId', stripeSession.gatewayChargeId);
    fd.set('orderNumber', stripeSession.orderNumber);
    fd.set('playerId', validation.playerId ?? '');

    const result = await confirmStripeCardPayment({}, fd);
    setStripeConfirming(false);

    if (result.error) {
      setStripeConfirmError(result.error);
      return;
    }
    // Purchase fires on the order page (live.tsx's PurchasePixel), not here —
    // same reasoning as the Mercado Pago Brick flow above: no eventId here
    // would double-count the one event ad spend is actually optimised
    // against.
    router.push(result.orderPageUrl ?? '/');
  };

  const handleStripeError = (message: string) => {
    // A client-side decline (Stripe's own `error.message`) — the Payment
    // Element stays mounted and usable for a different card, same as a
    // decline on the Mercado Pago Brick above.
    setStripeConfirmError(message);
  };

  // The placeholder promises only what happens. Nothing messages the customer
  // automatically — the number reaches a person in the panel, who uses it if
  // something about the order needs sorting out. "We'll let you know when it's
  // ready" was a promise to a market that has been lied to before, and a
  // customer waiting for a message that never comes assumes the worst.
  //
  // Required on every payment method, not just the manual transfer: it was
  // "(opcional)" on Tarjeta/OXXO/SPEI, and most buyers skipped it — leaving
  // Meta's Conversions API with no phone to hash for match quality on most
  // purchases (no email is ever collected either, so phone is the only extra
  // identifier this checkout can offer beyond IP/UA/fbp/fbc).
  const whatsappField = (disabled: boolean) => (
    <label className="field">
      <span>Tu WhatsApp</span>
      <input
        type="tel"
        name="whatsapp"
        inputMode="tel"
        placeholder="Solo por si necesitamos contactarte"
        disabled={disabled}
        required
      />
    </label>
  );

  /**
   * Mercado Pago's embedded SPEI flow has no Brick on screen (unlike card),
   * so there is nothing else to supply the `payer.email` their Orders API
   * requires on every order — confirmed in sandbox 2026-11-23, SPEI throws
   * the same `$.payer` error card did before its Brick-collected email was
   * wired through. Only rendered for this one payment view.
   */
  const mpEmailField = (disabled: boolean) => (
    <label className="field">
      <span>Tu correo</span>
      {/* Confirmed in production 2026-11-24 (Jose, screenshot): the old
          placeholder ("Para generar tu pago con Mercado Pago") was too long
          for a mobile input and got cut off mid-word — read as broken/unfinished
          text. The label above already says what the field is for. */}
      <input type="email" name="email" placeholder="tu@correo.com" disabled={disabled} required />
    </label>
  );

  const identityRow = (
    <div className="ck-top" style={{ marginBottom: 14 }}>
      <div className="ck-user" style={{ marginLeft: 0 }}>
        <span className="av" aria-hidden="true">
          {(validation.nickname ?? validation.playerId ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <div>
          <b>{validation.nickname ?? 'Cuenta verificada'}</b>
          <span>ID {validation.playerId}</span>
        </div>
        <button type="button" className="cambiar" onClick={() => setStep('datos')}>
          Cambiar
        </button>
      </div>
    </div>
  );

  return (
    <div className="ck">
      {step === 'datos' && (
        <div className="resumen">
          <div className="txt">
            <b>
              {diamonds} diamantes
              {vaultOfferId ? ' · Precio de la Bóveda' : ''}
            </b>
            <span>
              {comboName}
              {publicPrice ? ` · antes ${publicPrice}` : ' · entrega automática'}
            </span>
          </div>
          <div className="pr">
            {price.replace(/\s*MXN$/i, '')} <small>MXN</small>
          </div>
        </div>
      )}

      <Stepper step={step} />

      {!isLoggedIn && step === 'datos' && (
        <p className="aviso">
          Estás comprando <b>como invitado</b>. Crea tu cuenta Mi LevelUp — cualquier ID que
          recargues con la cuenta suma al Level Pass y La Bóveda. El ranking usa un solo ID.
        </p>
      )}

      {cancelledNotice && <div className="alert warn">{cancelledNotice}</div>}

      {/* Step 1 — identity */}
      {step === 'datos' && (
        <section className={`paso${found ? ' confirmado' : ''}`}>
          <h2>
            <span className="n" aria-hidden="true">
              1
            </span>
            Tu ID de Free Fire
          </h2>
          <p className="ayuda">Lo encuentras en tu perfil dentro del juego, debajo de tu nombre.</p>

          <form action={validateAction}>
            <label className="campo">
              <input
                name="playerId"
                inputMode="numeric"
                pattern="\d*"
                placeholder="Ej. 123456789"
                defaultValue={validation.playerId ?? ''}
                required
                autoFocus
                disabled={validating}
                aria-label="ID de Free Fire"
              />
            </label>

            {validation.message && (
              <div
                className={validation.status === 'error' ? 'alert bad' : 'alert warn'}
                style={{ marginTop: 12 }}
              >
                {validation.message}
              </div>
            )}

            {found ? (
              <div className="eres">
                <p>¿Eres tú?</p>
                <b>{validation.nickname ?? 'Cuenta verificada'}</b>
                <div className="fila">
                  <button type="submit" className="btn-ghost" disabled={validating}>
                    No, cambiar ID
                  </button>
                  <button type="button" className="btn-primary" onClick={confirmIdentity}>
                    Sí, soy yo
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ marginTop: 12 }}>
                <button className="btn-primary" type="submit" disabled={validating}>
                  {validating ? 'Buscando…' : 'Buscar mi cuenta'}
                </button>
              </div>
            )}
          </form>
        </section>
      )}

      {/* Step 2 — payment method */}
      {step === 'pago' && (
        <section className={payView === 'choose' ? undefined : 'paso'}>
          {payView !== 'choose' && (
            <>
              <h2>
                <span className="n" aria-hidden="true">
                  2
                </span>
                {isCardView
                  ? 'Paga tu recarga'
                  : `Datos para tu ${payView === 'oxxo' ? 'depósito' : 'transferencia'}`}
              </h2>
              {!isCardView && (
                <span className="badge-auto" style={{ marginBottom: 12 }}>
                  Recarga automática
                </span>
              )}
            </>
          )}

          {identityRow}

          {noPaymentConfigured ? (
            /* No configured account and no card gateway. Showing the box with a
               blank CLABE would leave someone holding their phone with nowhere to
               send the money — so say so plainly and hand them a human. Their
               order is not created, because an order nobody can pay for is just
               a customer who thinks they bought something. */
            <div className="alert warn">
              <strong>Estamos actualizando nuestros datos de pago.</strong>
              <p style={{ margin: '6px 0 0' }}>
                Escríbenos por WhatsApp y te pasamos los datos al momento para completar tu compra.
              </p>
              {supportNumber && (
                <a
                  className="btn-primary"
                  style={{ marginTop: 12 }}
                  href={`https://wa.me/${supportNumber}?text=${encodeURIComponent(
                    `Hola, quiero comprar ${comboName} (${price}) y no aparecen los datos de pago.`,
                  )}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Pedir los datos por WhatsApp
                </a>
              )}
            </div>
          ) : payView === 'choose' ? (
            <>
              <div className="pagos">
                {stripeCardOption && (
                  <PayOptionCard
                    tone="purple"
                    icon={CardIcon}
                    title="Tarjeta de crédito/débito"
                    showAutoBadge={false}
                    features={['Pago instantáneo', 'Visa · Mastercard · Amex']}
                    ctaLabel="Pagar con tarjeta →"
                    onClick={() => setPayView('tarjeta-stripe')}
                  />
                )}
                {mpCardOption && (
                  <PayOptionCard
                    tone="purple"
                    icon={CardIcon}
                    title="Mercado Pago"
                    showAutoBadge={false}
                    features={['Pago instantáneo', 'Abre la app si la tienes instalada']}
                    ctaLabel="Pagar con Mercado Pago →"
                    onClick={() => setPayView('tarjeta-mp')}
                  />
                )}
                {transferOption &&
                  (transferAutomatic ? (
                    <PayOptionCard
                      tone="blue"
                      icon={BankIcon}
                      badge="⚡ Automático"
                      title="Transferencia bancaria"
                      features={[
                        'Paga desde tu app bancaria (SPEI)',
                        'Recarga automática al confirmarse',
                      ]}
                      ctaLabel="Pagar por transferencia →"
                      onClick={() => setPayView('transferencia')}
                    />
                  ) : (
                    <PayOptionCard
                      tone="blue"
                      icon={BankIcon}
                      badge="⭐ Recomendado"
                      title="Transferencia bancaria"
                      features={[
                        'Paga desde tu app bancaria',
                        'Sin comisiones extras',
                        'Todos los bancos aceptados',
                        'Sube tu comprobante de pago',
                      ]}
                      extra={
                        <div className="pay-option-banks">
                          <span>BBVA · Santander · Banamex · Banorte · HSBC · Scotiabank</span>
                          <span className="hint">+20 bancos más — ¡todos los bancos aceptados!</span>
                        </div>
                      }
                      ctaLabel="Pagar por transferencia →"
                      onClick={() => setPayView('transferencia')}
                    />
                  ))}
                {oxxoOption &&
                  (oxxoAutomatic ? (
                    <PayOptionCard
                      tone="red"
                      icon={StoreIcon}
                      badge="⚡ Automático"
                      title="Depósito OXXO"
                      features={['Paga en cualquier tienda OXXO', 'Recarga automática al confirmarse']}
                      ctaLabel="Pagar en OXXO →"
                      onClick={() => setPayView('oxxo')}
                    />
                  ) : (
                    <PayOptionCard
                      tone="red"
                      icon={StoreIcon}
                      badge="🕐 Disponible 24/7"
                      title="Depósito OXXO"
                      features={[
                        'Paga en cualquier tienda OXXO',
                        'Sin necesidad de cuenta bancaria',
                        'Mismo número de cuenta siempre',
                        'Sube tu comprobante de pago',
                      ]}
                      extra={
                        <div className="pay-option-note">
                          🏬 Verás los datos de pago al dar clic en esta opción.
                        </div>
                      }
                      ctaLabel="Pagar en OXXO →"
                      onClick={() => setPayView('oxxo')}
                    />
                  ))}
              </div>
              <p className="aviso" style={{ marginTop: 16 }}>
                Los pagos se procesan con la pasarela de la tienda. LevelUp no guarda los datos de
                tu tarjeta. El estado de tu pedido se actualiza solo cuando el pago queda
                verificado.
              </p>
            </>
          ) : isCardView ? (
            <>
              <div className="pay-box">
                <div className="pay-row">
                  <span>Aceptamos</span>
                  <strong>Visa · Mastercard · Amex</strong>
                </div>
                <div className="pay-row total">
                  <span>Total</span>
                  <strong>{price}</strong>
                </div>
              </div>
              <button className="btn-primary" type="button" onClick={() => setStep('confirmacion')}>
                Continuar →
              </button>
              <p className="hint center">🔒 Pagos 100% seguros. Nunca vemos ni guardamos tu tarjeta.</p>
            </>
          ) : payView === 'oxxo' && oxxoAutomatic ? (
            <>
              <div className="pay-box">
                <div className="pay-row total">
                  <span>Total a depositar</span>
                  <strong>{price}</strong>
                </div>
              </div>
              <p className="hint center">
                🏪 Al continuar, te damos la referencia para depositar en cualquier OXXO.
              </p>
              <button className="btn-primary" type="button" onClick={() => setStep('confirmacion')}>
                Continuar →
              </button>
            </>
          ) : payView === 'transferencia' && transferAutomatic ? (
            <>
              <div className="pay-box">
                <div className="pay-row total">
                  <span>Total a transferir</span>
                  <strong>{price}</strong>
                </div>
              </div>
              <p className="hint center">
                🏦 Al continuar, te damos la cuenta CLABE para tu transferencia SPEI.
              </p>
              <button className="btn-primary" type="button" onClick={() => setStep('confirmacion')}>
                Continuar →
              </button>
            </>
          ) : payView === 'oxxo' && payTo?.oxxo ? (
            <>
              <div className="pay-box">
                <div className="pay-row">
                  <span>Método</span>
                  <strong>SPIN OXXO</strong>
                </div>
                <CopyRow label="Titular" value={payTo.holder} display={payTo.holder} />
                <CopyRow label="Número de cuenta" value={payTo.oxxo} display={groupCard(payTo.oxxo)} />
                <div className="pay-row total">
                  <span>Monto exacto</span>
                  <strong>{price}</strong>
                </div>
              </div>
              <ul className="pay-instructions">
                <li>🏪 Acude a cualquier tienda OXXO</li>
                <li>🧾 Indica en caja el número de cuenta</li>
                <li>💲 Deposita el monto exacto para agilizar la validación</li>
                <li>📤 Después sube tu comprobante</li>
              </ul>
              {/* Client request, 2026-09-27: this used to be a small muted
                  caption below the button, easy to skip entirely — it needs
                  to actually be read before confirming, since it's the whole
                  reason the recharge isn't instant on this method. */}
              <div className="alert warn">
                🕐 Tu comprobante será revisado por nuestro equipo. Puede tomar de{' '}
                <strong>5 minutos hasta 3 horas</strong> en aprobarse y procesar la recarga.
              </div>
              <button className="btn-primary" type="button" onClick={() => setStep('confirmacion')}>
                Ya deposité, continuar →
              </button>
            </>
          ) : payTo ? (
            <>
              <div className="pay-box">
                <div className="pay-row">
                  <span>Banco</span>
                  <strong>{payTo.bank}</strong>
                </div>
                <CopyRow label="Titular" value={payTo.holder} display={payTo.holder} />
                {payTo.cardNumber && (
                  <CopyRow
                    label="Número de tarjeta"
                    value={payTo.cardNumber}
                    display={groupCard(payTo.cardNumber)}
                  />
                )}
                <CopyRow label="CLABE bancaria" value={payTo.clabe} display={groupClabe(payTo.clabe)} />
                <div className="pay-row total">
                  <span>Monto exacto</span>
                  <strong>{price}</strong>
                </div>
              </div>
              <ul className="pay-instructions">
                <li>🏦 Puedes transferir desde cualquier banco</li>
                <li>📋 Copia los datos y realiza tu pago</li>
                <li>💲 Usa el monto exacto para agilizar la validación</li>
                <li>📤 Después sube tu comprobante</li>
              </ul>
              <button className="btn-primary" type="button" onClick={() => setStep('confirmacion')}>
                Ya transferí, continuar →
              </button>
              <p className="hint center">
                🔒 Tu comprobante será revisado automáticamente. La recarga se reflejará en unos
                minutos.
              </p>
            </>
          ) : null}

          {payView !== 'choose' && optionCount > 1 && (
            <button type="button" className="btn-ghost" onClick={() => setPayView('choose')}>
              ← Elegir otro método
            </button>
          )}
        </section>
      )}

      {/* Step 3 — review and confirm */}
      {step === 'confirmacion' && !noPaymentConfigured && (
        <section className="paso">
          <h2>
            <span className="n" aria-hidden="true">
              3
            </span>
            Revisa tu pedido
          </h2>

          <div className="datos" style={{ marginTop: 12 }}>
            <div className="fila">
              <span className="k">Paquete</span>
              <span className="v">{comboName}</span>
            </div>
            <div className="fila">
              <span className="k">Diamantes</span>
              <span className="v">{diamonds}</span>
            </div>
            <div className="fila">
              <span className="k">ID</span>
              <span className="v mono">{validation.playerId}</span>
            </div>
            <div className="fila">
              <span className="k">Método</span>
              <span className="v">{methodLabel}</span>
            </div>
            <div className="fila">
              <span className="k">Total</span>
              <span className="v total">{price}</span>
            </div>
          </div>

          {payView === 'tarjeta-mp' && mpCardKind === 'mercadopago-embedded' && mercadoPagoPublicKey ? (
            <div>
              <label className="field">
                <span>Tu WhatsApp</span>
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="Solo por si necesitamos contactarte"
                  value={mpCardWhatsapp}
                  onChange={(e) => setMpCardWhatsapp(e.target.value)}
                  disabled={mpCardSubmitting}
                  required
                />
              </label>

              {/* Confirmed in production 2026-11-24 (Jose): clicking Pagar gave
                  no visible feedback at all until Mercado Pago's own push
                  notification arrived, seconds later — our result (even once
                  it existed) rendered off-screen above a card form that still
                  looked fully active, so it read as "nothing happened" and
                  "the Brick form just sits there." Two separate problems, both
                  fixed here: nothing told the customer their click was even
                  received (added below), and the eventual result never
                  scrolled into view (the ref + effect below). */}
              {mpCardSubmitting && (
                <div className="alert warn" ref={mpCardStatusRef}>
                  Procesando tu pago… no cierres ni recargues esta página.
                </div>
              )}
              {mpCardResult?.error && (
                <div className="alert bad" ref={mpCardStatusRef}>
                  {mpCardResult.error}
                </div>
              )}
              {mpCardResult?.instructions?.kind === 'resolved' &&
                mpCardResult.instructions.state === 'failed' && (
                  <div className="alert bad" ref={mpCardStatusRef}>
                    Tu banco rechazó el pago. Revisa los datos de tu tarjeta o intenta con otra.
                  </div>
                )}
              {mpCardResult?.instructions?.kind === 'resolved' &&
                mpCardResult.instructions.state === 'pending' &&
                (mpCardResult.instructions.challengeUrl ? (
                  <div className="alert warn">
                    <p style={{ marginTop: 0 }}>
                      Tu banco necesita que confirmes este pago. Haz clic abajo y sigue sus instrucciones —
                      cuando termines, tu recarga se confirma sola.
                    </p>
                    <a
                      className="btn-primary"
                      href={mpCardResult.instructions.challengeUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Verificar con mi banco →
                    </a>
                  </div>
                ) : (
                  <div className="alert warn">
                    Tu pago está siendo verificado por tu banco. Te avisaremos en cuanto se confirme.
                  </div>
                ))}

              {mpCardWhatsapp.trim() ? (
                <div
                  // Dimmed, non-interactive while a submission is in flight —
                  // otherwise the Brick just sits there looking fully active
                  // (confirmed in production 2026-11-24: exactly what read as
                  // "clicked Pagar and nothing happened").
                  style={mpCardSubmitting ? { opacity: 0.5, pointerEvents: 'none' } : undefined}
                >
                <CardPaymentBrick
                  amountMxn={priceMxn}
                  publicKey={mercadoPagoPublicKey}
                  onToken={async ({ token, paymentMethodId, installments, payerEmail, payerIdentification }) => {
                    setMpCardSubmitting(true);
                    const fd = new FormData();
                    fd.set('comboKey', comboKey);
                    fd.set('playerId', validation.playerId ?? '');
                    if (vaultOfferId) fd.set('vaultOfferId', vaultOfferId);
                    fd.set('whatsapp', mpCardWhatsappRef.current.trim());
                    fd.set('cardToken', token);
                    fd.set('paymentMethodId', paymentMethodId);
                    fd.set('installments', String(installments));
                    fd.set('deviceSessionId', getMercadoPagoDeviceSessionId() ?? '');
                    if (payerEmail) fd.set('payerEmail', payerEmail);
                    if (payerIdentification) {
                      fd.set('payerIdentificationType', payerIdentification.type);
                      fd.set('payerIdentificationNumber', payerIdentification.number);
                    }

                    setPixelUserData({ whatsapp: mpCardWhatsappRef.current.trim() });
                    trackPixel('AddPaymentInfo', pixel);

                    const result = await payWithMercadoPagoCard({}, fd);
                    setMpCardResult(result);
                    setMpCardSubmitting(false);

                    const approved =
                      result.instructions?.kind === 'resolved' && result.instructions.state === 'paid';
                    // A 3DS/bank-review charge is NOT a dead end to sit on this
                    // page waiting out — confirmed in production 2026-11-24,
                    // a real customer stuck exactly here: the generic "tu
                    // banco está verificando" message showed, but the card
                    // form stayed fully active right below it with nowhere to
                    // go, and clicking Pagar again did nothing. The order
                    // page already has the real tracker for this (polls every
                    // 5s via AutoRefresh, shows the bank's own challenge link
                    // the moment the webhook delivers one) — send the
                    // customer there instead of leaving them on a form that
                    // has already done its job. Only a true decline stays
                    // here, since that's the one outcome worth a same-page
                    // "try another card" retry.
                    const pending =
                      result.instructions?.kind === 'resolved' && result.instructions.state === 'pending';
                    if (approved || pending) {
                      // Purchase fires on the order page instead (`live.tsx`'s
                      // `PurchasePixel`), not here — flagged and fixed
                      // 2026-11-24 auditing Meta Pixel accuracy: firing it
                      // here too, with no eventId, meant every instantly-
                      // approved card produced two separate client-side
                      // Purchase events Meta had no way to deduplicate
                      // against each other, double-counting the one event ad
                      // spend is actually optimised against.
                      router.push(result.orderPageUrl ?? '/');
                      return;
                    }
                    // Only a genuine gateway/order-creation error rejects the
                    // Brick's promise — that's the one case its own inline
                    // error UI is actually right for. A real resolved outcome
                    // (declined) must resolve normally: rejecting here makes
                    // the Brick render ITS OWN generic overlay on top of the
                    // specific Spanish messages above, which a real
                    // production test (2026-11-24, a SPEI-style
                    // action_required/declined card) confirmed completely
                    // hides them from the customer.
                    if (result.error) {
                      throw new Error(result.error);
                    }
                  }}
                  onBrickError={() => {
                    // Mercado Pago's own tokenization failed — before our
                    // server ever sees a request. Nothing to retry on our
                    // side, but at least show something specific instead of
                    // leaving only the Brick's own opaque overlay on screen.
                    setMpCardResult({
                      error:
                        'No pudimos procesar tu tarjeta en este momento. Verifica los datos o intenta de nuevo en unos minutos.',
                    });
                  }}
                />
                </div>
              ) : (
                <p className="hint center">Ingresa tu WhatsApp para continuar.</p>
              )}

              <p className="hint center">
                🔒 Pagas directo con Mercado Pago. Nunca vemos ni guardamos tu tarjeta.
              </p>
            </div>
          ) : payView === 'tarjeta-mp' && mpCardKind === 'mercadopago-checkoutpro' ? (
            <form
              action={mpCardAction}
              onSubmit={(e) => {
                openMpCardTab();
                trackPaymentInfo(e.currentTarget);
              }}
            >
              <input type="hidden" name="comboKey" value={comboKey} />
              <input type="hidden" name="playerId" value={validation.playerId ?? ''} />
              {vaultOfferId && <input type="hidden" name="vaultOfferId" value={vaultOfferId} />}

              {whatsappField(mpCardRedirecting)}

              <GatewayTabNotice provider="Mercado Pago" />

              {mpCard.error && <div className="alert bad">{mpCard.error}</div>}

              <button className="btn-primary" type="submit" disabled={mpCardRedirecting}>
                {mpCardRedirecting ? 'Abriendo pago seguro…' : `Confirmar pedido — ${price}`}
              </button>
              <p className="hint center">
                🔒 Pagas en la página segura de Mercado Pago. Nunca vemos ni guardamos tu tarjeta.
              </p>
            </form>
          ) : payView === 'tarjeta-stripe' ? (
            <div>
              <label className="field">
                <span>Tu WhatsApp</span>
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="Solo por si necesitamos contactarte"
                  value={stripeWhatsapp}
                  onChange={(e) => setStripeWhatsapp(e.target.value)}
                  disabled={stripeStarting || stripeSession !== null}
                  required
                />
              </label>

              {stripeStartError && <div className="alert bad">{stripeStartError}</div>}
              {stripeConfirmError && <div className="alert bad">{stripeConfirmError}</div>}
              {stripeConfirming && (
                <div className="alert warn">Confirmando tu pago… no cierres ni recargues esta página.</div>
              )}

              {stripeSession && stripePublishableKey ? (
                <div style={stripeConfirming ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
                  <StripePaymentElement
                    publishableKey={stripePublishableKey}
                    clientSecret={stripeSession.clientSecret}
                    submitLabel={`Confirmar pedido — ${price}`}
                    disabled={stripeConfirming}
                    onConfirmed={handleStripeConfirmed}
                    onError={handleStripeError}
                  />
                </div>
              ) : stripeWhatsapp.trim() ? (
                <button className="btn-primary" type="button" disabled={stripeStarting} onClick={startStripeCard}>
                  {stripeStarting ? 'Cargando…' : 'Continuar →'}
                </button>
              ) : (
                <p className="hint center">Ingresa tu WhatsApp para continuar.</p>
              )}

              <p className="hint center">
                🔒 Pagas directo con Stripe. Nunca vemos ni guardamos tu tarjeta.
              </p>
            </div>
          ) : payView === 'oxxo' && oxxoAutomatic === 'mercadopago' ? (
            <form
              action={mpOxxoAction}
              onSubmit={(e) => {
                openMpOxxoTab();
                trackPaymentInfo(e.currentTarget);
              }}
            >
              <input type="hidden" name="comboKey" value={comboKey} />
              <input type="hidden" name="playerId" value={validation.playerId ?? ''} />
              {vaultOfferId && <input type="hidden" name="vaultOfferId" value={vaultOfferId} />}

              {whatsappField(mpOxxoRedirecting)}

              <GatewayTabNotice provider="Mercado Pago" />

              {mpOxxo.error && <div className="alert bad">{mpOxxo.error}</div>}

              <button className="btn-primary" type="submit" disabled={mpOxxoRedirecting}>
                {mpOxxoRedirecting ? 'Abriendo pago seguro…' : `Confirmar pedido — ${price}`}
              </button>
              <p className="hint center">🔒 Te damos tu referencia de depósito OXXO al continuar.</p>
            </form>
          ) : payView === 'oxxo' && oxxoAutomatic === 'stripe' ? (
            <form
              action={stripeOxxoAction}
              onSubmit={(e) => {
                openOxxoTab();
                trackPaymentInfo(e.currentTarget);
              }}
            >
              <input type="hidden" name="comboKey" value={comboKey} />
              <input type="hidden" name="playerId" value={validation.playerId ?? ''} />
              {vaultOfferId && <input type="hidden" name="vaultOfferId" value={vaultOfferId} />}

              {whatsappField(oxxoRedirecting)}

              <GatewayTabNotice provider="Stripe" />

              {stripeOxxo.error && <div className="alert bad">{stripeOxxo.error}</div>}

              <button className="btn-primary" type="submit" disabled={oxxoRedirecting}>
                {oxxoRedirecting ? 'Abriendo pago seguro…' : `Confirmar pedido — ${price}`}
              </button>
              <p className="hint center">🔒 Stripe te da tu referencia de depósito OXXO al continuar.</p>
            </form>
          ) : payView === 'transferencia' && transferAutomatic === 'mercadopago-embedded' ? (
            mpSpeiEmbedded.instructions?.kind === 'spei' ? (
              // Transient — the effect above redirects to the order page the
              // instant this renders, which already has the real CLABE
              // screen (loading state, payment details, order summary, in
              // that order). Nothing here needs to be built twice.
              <div className="estado-card revisando" role="status">
                <div className="spin" aria-hidden="true" />
                <h2>Generando tu CLABE…</h2>
              </div>
            ) : (
              <form
                action={mpSpeiEmbeddedAction}
                onSubmit={(e) => {
                  if (deviceInputRef.current) {
                    deviceInputRef.current.value = getMercadoPagoDeviceSessionId() ?? '';
                  }
                  trackPaymentInfo(e.currentTarget);
                }}
              >
                <input type="hidden" name="comboKey" value={comboKey} />
                <input type="hidden" name="playerId" value={validation.playerId ?? ''} />
                {vaultOfferId && <input type="hidden" name="vaultOfferId" value={vaultOfferId} />}
                <input type="hidden" name="deviceSessionId" ref={deviceInputRef} defaultValue="" />

                {/* Boxed to match the polished-card look the rest of this
                    flow already has (the CLABE/payment-details screen) —
                    flagged live 2026-11-24 (Jose, circled repeatedly): bare
                    labels/inputs floating directly on the page background
                    read as unfinished next to everything else. */}
                <div className="pay-box">
                  {whatsappField(mpSpeiEmbeddedProcessing)}
                  {mpEmailField(mpSpeiEmbeddedProcessing)}

                  {mpSpeiEmbedded.error && <div className="alert bad">{mpSpeiEmbedded.error}</div>}

                  <button className="btn-primary" type="submit" disabled={mpSpeiEmbeddedProcessing}>
                    {mpSpeiEmbeddedProcessing ? 'Generando tu CLABE…' : `Confirmar pedido — ${price}`}
                  </button>
                  <p className="hint center">
                    🏦 Te damos tu cuenta CLABE para SPEI al continuar, en esta misma pantalla.
                  </p>
                </div>
              </form>
            )
          ) : payView === 'transferencia' && transferAutomatic === 'mercadopago' ? (
            <form
              action={mpSpeiAction}
              onSubmit={(e) => {
                openMpSpeiTab();
                trackPaymentInfo(e.currentTarget);
              }}
            >
              <input type="hidden" name="comboKey" value={comboKey} />
              <input type="hidden" name="playerId" value={validation.playerId ?? ''} />
              {vaultOfferId && <input type="hidden" name="vaultOfferId" value={vaultOfferId} />}

              {whatsappField(mpSpeiRedirecting)}

              <GatewayTabNotice provider="Mercado Pago" />

              {mpSpei.error && <div className="alert bad">{mpSpei.error}</div>}

              <button className="btn-primary" type="submit" disabled={mpSpeiRedirecting}>
                {mpSpeiRedirecting ? 'Abriendo pago seguro…' : `Confirmar pedido — ${price}`}
              </button>
              <p className="hint center">🔒 Te damos tu cuenta CLABE para SPEI al continuar.</p>
            </form>
          ) : payView === 'transferencia' && transferAutomatic === 'stripe' ? (
            <form
              action={stripeSpeiAction}
              onSubmit={(e) => {
                openSpeiTab();
                trackPaymentInfo(e.currentTarget);
              }}
            >
              <input type="hidden" name="comboKey" value={comboKey} />
              <input type="hidden" name="playerId" value={validation.playerId ?? ''} />
              {vaultOfferId && <input type="hidden" name="vaultOfferId" value={vaultOfferId} />}

              {whatsappField(speiRedirecting)}

              <GatewayTabNotice provider="Stripe" />

              {stripeSpei.error && <div className="alert bad">{stripeSpei.error}</div>}

              <button className="btn-primary" type="submit" disabled={speiRedirecting}>
                {speiRedirecting ? 'Abriendo pago seguro…' : `Confirmar pedido — ${price}`}
              </button>
              <p className="hint center">🔒 Stripe te da tu cuenta CLABE para SPEI al continuar.</p>
            </form>
          ) : (
            <form action={transferAction} onSubmit={(e) => trackPaymentInfo(e.currentTarget)}>
              <input type="hidden" name="comboKey" value={comboKey} />
              <input type="hidden" name="playerId" value={validation.playerId ?? ''} />
              {vaultOfferId && <input type="hidden" name="vaultOfferId" value={vaultOfferId} />}
              {/* No nickname field: the server re-validates and takes the name
                  from the provider, so nothing the form sends could forge it. */}

              <label className="field">
                <span>Foto de tu comprobante</span>
                <input
                  type="file"
                  name="comprobante"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  required
                  disabled={placing}
                />
              </label>

              {whatsappField(placing)}

              {transfer.error && <div className="alert bad">{transfer.error}</div>}

              <button className="btn-primary" type="submit" disabled={placing}>
                {placing ? 'Enviando…' : 'Confirmar pedido'}
              </button>
              <p className="hint center">
                Revisamos tu pago y la recarga entra automáticamente.
              </p>
            </form>
          )}

          <button type="button" className="btn-ghost" onClick={() => setStep('pago')}>
            ← Volver
          </button>
        </section>
      )}
    </div>
  );
}
