'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  confirmItemStripeCardPayment,
  payWithItemMercadoPagoCard,
  payWithItemMercadoPagoCardCheckoutPro,
  payWithItemStripeCard,
  validateItemPlayer,
  type CheckoutState,
  type EmbeddedCheckoutState,
  type ValidateState,
} from './actions';
import { CardPaymentBrick } from '../../comprar/[combo]/card-payment-brick';
import { StripePaymentElement } from '../../comprar/[combo]/stripe-payment-element';
import { setPixelUserData, trackPixel } from '../../../lib/pixel';
import { mxn } from '../../../lib/format';
import { GatewayTabNotice, useStripeTabRedirect } from '../../../lib/gateway-tab-redirect';
import { getMercadoPagoDeviceSessionId, loadMercadoPagoSecurity } from '../../../lib/mercadopago-device';

type Step = 'datos' | 'confirmacion';

/**
 * Must match `packages/payments/src/stripe.ts`'s own `MIN_CARD_AMOUNT_CENTS_MXN`
 * — confirmed in production 2026-11-27 (a $1 MXN order failed with Stripe's
 * real `400: Amount must be at least $10.00 MXN`). Used to skip straight to
 * Mercado Pago when the order's real total can't clear Stripe's own floor,
 * instead of offering a card option guaranteed to fail.
 */
const STRIPE_MIN_CARD_CENTS = 1000;

interface Props {
  sku: string;
  displayName: string;
  kind: 'gift' | 'membership';
  price: string;
  priceMxn: number;
  maxQuantity: number;
  /** Region code -> quantity. Empty for a membership. */
  stockByRegion: Record<string, number>;
  cancelledNotice: string | null;
  /** Mercado Pago's hosted Checkout Pro is configured for card — its own explicit button next to Stripe's, same as the combo checkout. */
  mercadoPagoCardCheckoutProEnabled: boolean;
  /** Mercado Pago's embedded Checkout is configured for card — dormant as of 2026-11-26, see the combo checkout's own doc comment. */
  mercadoPagoCardEnabled: boolean;
  mercadoPagoPublicKey: string | null;
  /** Stripe's publishable (non-secret) key for the Payment Element — see the combo checkout's own prop. */
  stripePublishableKey: string | null;
}

const REGION_LABEL: Record<string, string> = { US: 'Estados Unidos', SAC: 'Sudamérica' };

/**
 * Step 1 confirms identity via RocketPass's own `GET /players/{uid}` — see
 * `validateItemPlayer`'s doc comment in `actions.ts`. Unlike the combo
 * checkout's identity step, there is no separate region picker: the same
 * lookup that confirms the ID also returns the account's real region, so
 * the region shown below is detected, not chosen.
 */
export function CheckoutArticulo({
  sku,
  displayName,
  kind,
  price,
  priceMxn,
  maxQuantity,
  stockByRegion,
  cancelledNotice,
  mercadoPagoCardCheckoutProEnabled,
  mercadoPagoCardEnabled,
  mercadoPagoPublicKey,
  stripePublishableKey,
}: Props) {
  const [step, setStep] = useState<Step>('datos');
  const [validation, validateAction, validating] = useActionState<ValidateState, FormData>(
    validateItemPlayer,
    { status: 'idle' },
  );
  const found = validation.status === 'found';
  const targetUid = validation.playerId ?? '';
  const targetNickname = validation.nickname ?? '';
  const region = kind === 'gift' ? (validation.region ?? null) : null;
  const [quantity, setQuantity] = useState(1);
  const router = useRouter();

  // `price`/`priceMxn` are the item's per-unit price — real everywhere a
  // quantity-aware total is needed (what's actually charged, what a payment
  // brick needs to match the server-side charge, what's shown as "Total").
  // Confirmed missing in production 2026-11-27: every one of these read the
  // flat per-unit price regardless of the selected quantity.
  const totalMxnCents = Math.round(priceMxn * 100) * quantity;
  const totalMxn = totalMxnCents / 100;
  const totalLabel = mxn(totalMxnCents);

  const [mpCheckoutProCard, mpCheckoutProCardAction, mpCheckoutProRedirecting] = useActionState<
    CheckoutState,
    FormData
  >(payWithItemMercadoPagoCardCheckoutPro, {});
  const openMpCheckoutProCardTab = useStripeTabRedirect(mpCheckoutProCard);

  // Card is two always-visible buttons, not a ladder — same reasoning as the
  // combo checkout's own 2026-11-26 restructure: Stripe's own embedded card,
  // and whichever Mercado Pago card integration is live (Checkout Pro
  // winning over the dormant embedded one, same reason as before).
  const mpCardKind: 'mercadopago-checkoutpro' | 'mercadopago-embedded' | null =
    mercadoPagoCardCheckoutProEnabled
      ? 'mercadopago-checkoutpro'
      : mercadoPagoCardEnabled && mercadoPagoPublicKey
        ? 'mercadopago-embedded'
        : null;
  const mpCardOption = mpCardKind !== null;
  // Stripe refuses any card charge under $10 MXN outright (its own hard
  // floor, confirmed in production) — below that, Stripe isn't a real choice
  // regardless of whether it's configured.
  const stripeCardAllowed = totalMxnCents >= STRIPE_MIN_CARD_CENTS;
  // Only asked when there is a real choice to make — a single configured
  // card method just renders directly, same as this page always did before
  // Mercado Pago's card option existed.
  const [cardChoice, setCardChoice] = useState<'stripe' | 'mercadopago' | null>(null);
  // No real choice without Mercado Pago configured too — defaults straight
  // to Stripe, same as this page always did before that option existed,
  // unless the total can't clear Stripe's own minimum and Mercado Pago is
  // available to take it instead.
  const effectiveCardChoice: 'stripe' | 'mercadopago' =
    cardChoice ?? (!stripeCardAllowed && mpCardOption ? 'mercadopago' : 'stripe');
  const showCardChooser = mpCardOption && stripeCardAllowed && cardChoice === null;

  const [mpCardResult, setMpCardResult] = useState<EmbeddedCheckoutState | null>(null);
  const [mpCardSubmitting, setMpCardSubmitting] = useState(false);
  const [mpCardWhatsapp, setMpCardWhatsapp] = useState('');
  const mpCardWhatsappRef = useRef(mpCardWhatsapp);
  mpCardWhatsappRef.current = mpCardWhatsapp;

  // Same fix as the combo checkout (confirmed needed in production
  // 2026-11-24): scroll whichever status message just appeared into view the
  // instant it does, for both "processing" and the final result.
  const mpCardStatusRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mpCardSubmitting || mpCardResult) {
      mpCardStatusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [mpCardSubmitting, mpCardResult]);
  // Stripe's embedded card — same two-phase shape as the combo checkout's
  // own `payWithStripeCard`/`confirmStripeCardPayment`, see that file's doc
  // comment for why this is genuinely two server round trips.
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

  const targetUidRef = useRef(targetUid);
  targetUidRef.current = targetUid;
  const quantityRef = useRef(quantity);
  quantityRef.current = quantity;
  const targetNicknameRef = useRef(targetNickname);
  targetNicknameRef.current = targetNickname;

  useEffect(() => {
    loadMercadoPagoSecurity();
  }, []);

  const pixel = {
    value: totalMxn,
    currency: 'MXN' as const,
    content_ids: [sku],
    content_type: 'product' as const,
  };

  useEffect(() => {
    trackPixel('ViewContent', { ...pixel, content_name: displayName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const regionValid = kind === 'membership' || Boolean(region);
  // Stock per region is a soft, last-synced mirror of RocketPass's own
  // inventory (see `item-ordering.ts`'s doc comment) — it can show *some*
  // stock while still being less than what the customer is trying to buy.
  // `createItemOrder` already refuses this server-side (`OUT_OF_STOCK`), but
  // catching it here too means the customer sees it before entering payment
  // details, not after — confirmed needed per Jose's own report of this case.
  const stockAvailable = kind === 'gift' && region ? (stockByRegion[region] ?? 0) : null;
  const insufficientStock = stockAvailable !== null && quantity > stockAvailable;
  const canContinue =
    found && regionValid && quantity >= 1 && quantity <= maxQuantity && !insufficientStock;

  const confirmStep = () => {
    setStep('confirmacion');
    setPixelUserData({ playerId: targetUid });
    trackPixel('InitiateCheckout', pixel);
  };

  const trackPaymentInfo = (form: HTMLFormElement) => {
    const whatsapp = String(new FormData(form).get('whatsapp') ?? '');
    if (whatsapp) setPixelUserData({ whatsapp });
    trackPixel('AddPaymentInfo', pixel);
  };

  // Stripe's Payment Element has no `<form>` of its own to submit — see the
  // combo checkout's identical trio of functions for the full reasoning.
  const startStripeCard = async () => {
    setStripeStarting(true);
    setStripeStartError(null);

    const whatsapp = stripeWhatsappRef.current.trim();
    setPixelUserData({ whatsapp });
    trackPixel('AddPaymentInfo', pixel);

    const fd = new FormData();
    fd.set('sku', sku);
    fd.set('targetUid', targetUidRef.current);
    fd.set('targetNickname', targetNicknameRef.current);
    fd.set('quantity', String(quantityRef.current));
    fd.set('whatsapp', whatsapp);

    const result = await payWithItemStripeCard({}, fd);
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
    fd.set('targetUid', targetUidRef.current);

    const result = await confirmItemStripeCardPayment({}, fd);
    setStripeConfirming(false);

    if (result.error) {
      setStripeConfirmError(result.error);
      return;
    }
    router.push(result.orderPageUrl ?? '/');
  };

  const handleStripeError = (message: string) => {
    setStripeConfirmError(message);
  };

  return (
    <div className="ck">
      <div className="resumen">
        <div className="txt">
          <b>{displayName}</b>
          <span>{kind === 'gift' ? 'Artículo RocketPass' : 'Membresía RocketPass'}</span>
        </div>
        <div className="pr">
          {totalLabel.replace(/\s*MXN$/i, '')} <small>MXN</small>
        </div>
      </div>

      {cancelledNotice && <div className="alert warn">{cancelledNotice}</div>}

      {step === 'datos' && (
        <section className={`paso${found ? ' confirmado' : ''}`}>
          <h2>
            <span className="n" aria-hidden="true">
              1
            </span>
            Datos de la entrega
          </h2>
          <p className="ayuda">Lo encuentras en tu perfil dentro del juego, debajo de tu nombre.</p>

          <form action={validateAction}>
            <label className="field">
              <span>Tu ID de Free Fire</span>
              <input
                name="playerId"
                inputMode="numeric"
                pattern="\d*"
                placeholder="Ej. 123456789"
                defaultValue={validation.playerId ?? ''}
                required
                autoFocus
                disabled={validating}
              />
            </label>

            {validation.message && (
              <div className={validation.status === 'error' ? 'alert bad' : 'alert warn'}>
                {validation.message}
              </div>
            )}

            {found ? (
              <div className="eres">
                <p>¿Eres tú?</p>
                {validation.avatarUrl && (
                  <img
                    src={validation.avatarUrl}
                    alt=""
                    width={56}
                    height={56}
                    style={{ borderRadius: '50%', display: 'block', margin: '0 auto 8px' }}
                  />
                )}
                <b>{validation.nickname ?? 'Cuenta verificada'}</b>
                {(validation.level != null || region) && (
                  <p className="hint center" style={{ marginTop: 2 }}>
                    {validation.level != null ? `Nivel ${validation.level}` : null}
                    {validation.level != null && region ? ' · ' : null}
                    {region ? `Región: ${REGION_LABEL[region] ?? region}` : null}
                  </p>
                )}
                <div className="fila">
                  <button type="submit" className="btn-ghost" disabled={validating}>
                    No, cambiar ID
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

          {found && (
            <label className="field">
              <span>Cantidad ({price} c/u)</span>
              <input
                type="number"
                min={1}
                max={maxQuantity}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Math.min(maxQuantity, Number(e.target.value) || 1)))}
              />
            </label>
          )}

          {found && insufficientStock && (
            <div className="alert warn">
              Solo quedan {stockAvailable} disponibles en esta región. Reduce la cantidad para continuar.
            </div>
          )}

          {found && quantity > 1 && (
            <p className="hint" style={{ marginTop: -4 }}>
              Total: {totalLabel}
            </p>
          )}

          {found && (
            <button
              className="btn-primary"
              type="button"
              disabled={!canContinue}
              onClick={confirmStep}
              style={{ marginTop: 12 }}
            >
              Continuar →
            </button>
          )}
        </section>
      )}

      {step === 'confirmacion' && (
        <section className="paso">
          <h2>
            <span className="n" aria-hidden="true">
              2
            </span>
            Revisa y paga
          </h2>

          <div className="datos" style={{ marginTop: 12 }}>
            <div className="fila">
              <span className="k">Artículo</span>
              <span className="v">{displayName}</span>
            </div>
            <div className="fila">
              <span className="k">Cantidad</span>
              <span className="v">{quantity}</span>
            </div>
            {region && (
              <div className="fila">
                <span className="k">Región</span>
                <span className="v">{REGION_LABEL[region] ?? region}</span>
              </div>
            )}
            <div className="fila">
              <span className="k">ID</span>
              <span className="v mono">{targetUid}</span>
            </div>
            <div className="fila">
              <span className="k">Total</span>
              <span className="v total">{totalLabel}</span>
            </div>
          </div>

          {showCardChooser ? (
            <div className="pagos">
              <button
                type="button"
                className="pago tarjeta"
                onClick={() => setCardChoice('stripe')}
                style={{ cursor: 'pointer' }}
              >
                <div className="head">
                  <h3>Tarjeta de crédito/débito</h3>
                </div>
                <p className="hint">Visa · Mastercard · Amex</p>
              </button>
              <button
                type="button"
                className="pago tarjeta"
                onClick={() => setCardChoice('mercadopago')}
                style={{ cursor: 'pointer' }}
              >
                <div className="head">
                  <h3>Mercado Pago</h3>
                </div>
                <p className="hint">Abre la app si la tienes instalada</p>
              </button>
            </div>
          ) : effectiveCardChoice === 'mercadopago' && mpCardKind === 'mercadopago-embedded' && mercadoPagoPublicKey ? (
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
                <div style={mpCardSubmitting ? { opacity: 0.5, pointerEvents: 'none' } : undefined}>
                <CardPaymentBrick
                  amountMxn={totalMxn}
                  publicKey={mercadoPagoPublicKey}
                  onToken={async ({ token, paymentMethodId, installments, payerEmail, payerIdentification }) => {
                    setMpCardSubmitting(true);
                    const fd = new FormData();
                    fd.set('sku', sku);
                    fd.set('targetUid', targetUidRef.current);
                    fd.set('targetNickname', targetNicknameRef.current);
                    fd.set('quantity', String(quantityRef.current));
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

                    const result = await payWithItemMercadoPagoCard({}, fd);
                    setMpCardResult(result);
                    setMpCardSubmitting(false);

                    const approved =
                      result.instructions?.kind === 'resolved' && result.instructions.state === 'paid';
                    // A 3DS/bank-review charge sends the customer to the order
                    // page too, not just an approval — that page already polls
                    // for the bank's own challenge link, this form has nothing
                    // left to do (see the combo checkout's identical fix,
                    // confirmed needed in production 2026-11-24).
                    const pending =
                      result.instructions?.kind === 'resolved' && result.instructions.state === 'pending';
                    if (approved || pending) {
                      // Purchase fires on the order page instead (same fix as
                      // the combo checkout, 2026-11-24) — firing it here too,
                      // with no eventId, double-counted every instantly-
                      // approved card as two separate, undeduplicated
                      // Purchase events.
                      router.push(result.orderPageUrl ?? '/');
                      return;
                    }
                    // Only a genuine gateway/order-creation error rejects the
                    // Brick's promise — a real resolved outcome (declined)
                    // must resolve normally, or the Brick's own generic
                    // overlay hides this screen's own specific Spanish
                    // messages (confirmed in production 2026-11-24).
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
          ) : effectiveCardChoice === 'mercadopago' && mpCardKind === 'mercadopago-checkoutpro' ? (
            <form
              action={mpCheckoutProCardAction}
              onSubmit={(e) => {
                openMpCheckoutProCardTab();
                trackPaymentInfo(e.currentTarget);
              }}
            >
              <input type="hidden" name="sku" value={sku} />
              <input type="hidden" name="targetUid" value={targetUid} />
              <input type="hidden" name="targetNickname" value={targetNickname} />
              <input type="hidden" name="quantity" value={quantity} />

              <label className="field">
                <span>Tu WhatsApp</span>
                <input
                  type="tel"
                  name="whatsapp"
                  inputMode="tel"
                  placeholder="Solo por si necesitamos contactarte"
                  disabled={mpCheckoutProRedirecting}
                  required
                />
              </label>

              <GatewayTabNotice provider="Mercado Pago" />

              {mpCheckoutProCard.error && <div className="alert bad">{mpCheckoutProCard.error}</div>}

              <button className="btn-primary" type="submit" disabled={mpCheckoutProRedirecting}>
                {mpCheckoutProRedirecting ? 'Abriendo pago seguro…' : `Pagar con tarjeta — ${totalLabel}`}
              </button>
              <p className="hint center">
                🔒 Pagas en la página segura de Mercado Pago. Nunca vemos ni guardamos tu tarjeta.
              </p>
            </form>
          ) : (
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
                    submitLabel={`Pagar con tarjeta — ${totalLabel}`}
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

              <p className="hint center">🔒 Pagas directo con Stripe. Nunca vemos ni guardamos tu tarjeta.</p>
            </div>
          )}

          {mpCardOption && cardChoice !== null && (
            <button type="button" className="btn-ghost" onClick={() => setCardChoice(null)}>
              ← Elegir otro método
            </button>
          )}

          <button type="button" className="btn-ghost" onClick={() => setStep('datos')}>
            ← Volver
          </button>
        </section>
      )}
    </div>
  );
}
