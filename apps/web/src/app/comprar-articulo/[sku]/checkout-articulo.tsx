'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  confirmItemStripeCardPayment,
  payWithItemMercadoPagoCard,
  payWithItemMercadoPagoCardCheckoutPro,
  payWithItemStripeCard,
  type CheckoutState,
  type EmbeddedCheckoutState,
} from './actions';
import { CardPaymentBrick } from '../../comprar/[combo]/card-payment-brick';
import { StripePaymentElement } from '../../comprar/[combo]/stripe-payment-element';
import { setPixelUserData, trackPixel } from '../../../lib/pixel';
import { GatewayTabNotice, useStripeTabRedirect } from '../../../lib/gateway-tab-redirect';
import { getMercadoPagoDeviceSessionId, loadMercadoPagoSecurity } from '../../../lib/mercadopago-device';

type Step = 'datos' | 'confirmacion';

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
 * Two screens, not three — there is no identity-confirmation step like the
 * combo checkout's "¿Eres tú, X?", because RocketPass's own API has no
 * validate-uid endpoint to check against (confirmed in `packages/rocketpass`).
 * The warning below is the honest substitute: double-check before paying,
 * since an item sent to the wrong ID is exactly as unrecoverable as a
 * diamond recharge would be.
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
  const regions = Object.keys(stockByRegion);
  const [step, setStep] = useState<Step>('datos');
  const [targetUid, setTargetUid] = useState('');
  const [targetNickname, setTargetNickname] = useState('');
  const [region, setRegion] = useState<string | null>(kind === 'gift' ? (regions[0] ?? null) : null);
  const [quantity, setQuantity] = useState(1);
  const router = useRouter();

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
  // Only asked when there is a real choice to make — a single configured
  // card method just renders directly, same as this page always did before
  // Mercado Pago's card option existed.
  const [cardChoice, setCardChoice] = useState<'stripe' | 'mercadopago' | null>(null);
  // No real choice without Mercado Pago configured too — defaults straight
  // to Stripe, same as this page always did before that option existed.
  const effectiveCardChoice: 'stripe' | 'mercadopago' = cardChoice ?? 'stripe';
  const showCardChooser = mpCardOption && cardChoice === null;

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
  const regionRef = useRef(region);
  regionRef.current = region;
  const quantityRef = useRef(quantity);
  quantityRef.current = quantity;
  const targetNicknameRef = useRef(targetNickname);
  targetNicknameRef.current = targetNickname;

  useEffect(() => {
    loadMercadoPagoSecurity();
  }, []);

  const pixel = {
    value: priceMxn,
    currency: 'MXN' as const,
    content_ids: [sku],
    content_type: 'product' as const,
  };

  useEffect(() => {
    trackPixel('ViewContent', { ...pixel, content_name: displayName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const idValid = /^\d{6,15}$/.test(targetUid);
  const regionValid = kind === 'membership' || Boolean(region);
  const canContinue = idValid && regionValid && quantity >= 1 && quantity <= maxQuantity;

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
    fd.set('region', regionRef.current ?? '');
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
          {price.replace(/\s*MXN$/i, '')} <small>MXN</small>
        </div>
      </div>

      {cancelledNotice && <div className="alert warn">{cancelledNotice}</div>}

      {step === 'datos' && (
        <section className="paso">
          <h2>
            <span className="n" aria-hidden="true">
              1
            </span>
            Datos de la entrega
          </h2>
          <p className="ayuda">
            Revisa bien tu ID — no podemos verificarlo contra el juego antes de cobrar, así que un
            ID equivocado no se puede corregir después.
          </p>

          <label className="field">
            <span>Tu ID de Free Fire</span>
            <input
              inputMode="numeric"
              pattern="\d*"
              placeholder="Ej. 123456789"
              value={targetUid}
              onChange={(e) => setTargetUid(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </label>

          <label className="field">
            <span>Tu nombre en el juego (opcional)</span>
            <input
              placeholder="Para confirmar que es tu cuenta"
              value={targetNickname}
              onChange={(e) => setTargetNickname(e.target.value)}
            />
          </label>

          {kind === 'gift' && regions.length > 0 && (
            <div className="field">
              <span>Región de tu cuenta</span>
              <div className="pagos" style={{ marginTop: 6 }}>
                {regions.map((r) => {
                  const stock = stockByRegion[r] ?? 0;
                  return (
                    <button
                      key={r}
                      type="button"
                      className={`pago tarjeta${region === r ? ' is-selected' : ''}`}
                      disabled={stock <= 0}
                      onClick={() => setRegion(r)}
                      style={{ cursor: stock <= 0 ? 'not-allowed' : 'pointer', opacity: stock <= 0 ? 0.5 : 1 }}
                    >
                      <div className="head">
                        <h3>{REGION_LABEL[r] ?? r}</h3>
                      </div>
                      <p className="hint">{stock > 0 ? `${stock} disponibles` : 'Sin stock'}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className="field">
            <span>Cantidad</span>
            <input
              type="number"
              min={1}
              max={maxQuantity}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.min(maxQuantity, Number(e.target.value) || 1)))}
            />
          </label>

          <button
            className="btn-primary"
            type="button"
            disabled={!canContinue}
            onClick={confirmStep}
            style={{ marginTop: 12 }}
          >
            Continuar →
          </button>
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
              <span className="v total">{price}</span>
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
                  amountMxn={priceMxn}
                  publicKey={mercadoPagoPublicKey}
                  onToken={async ({ token, paymentMethodId, installments, payerEmail, payerIdentification }) => {
                    setMpCardSubmitting(true);
                    const fd = new FormData();
                    fd.set('sku', sku);
                    fd.set('targetUid', targetUidRef.current);
                    fd.set('targetNickname', targetNicknameRef.current);
                    fd.set('region', regionRef.current ?? '');
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
              <input type="hidden" name="region" value={region ?? ''} />
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
                {mpCheckoutProRedirecting ? 'Abriendo pago seguro…' : `Pagar con tarjeta — ${price}`}
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
                    submitLabel={`Pagar con tarjeta — ${price}`}
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
