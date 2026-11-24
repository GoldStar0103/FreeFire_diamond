'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { payWithItemCard, payWithItemMercadoPagoCard, type CheckoutState, type EmbeddedCheckoutState } from './actions';
import { CardPaymentBrick } from '../../comprar/[combo]/card-payment-brick';
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
  /** Mercado Pago's embedded Checkout is configured for card — takes priority over Stripe, same ladder as the combo checkout. */
  mercadoPagoCardEnabled: boolean;
  mercadoPagoPublicKey: string | null;
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
  mercadoPagoCardEnabled,
  mercadoPagoPublicKey,
}: Props) {
  const regions = Object.keys(stockByRegion);
  const [step, setStep] = useState<Step>('datos');
  const [targetUid, setTargetUid] = useState('');
  const [targetNickname, setTargetNickname] = useState('');
  const [region, setRegion] = useState<string | null>(kind === 'gift' ? (regions[0] ?? null) : null);
  const [quantity, setQuantity] = useState(1);
  const router = useRouter();

  const [card, cardAction, redirecting] = useActionState<CheckoutState, FormData>(payWithItemCard, {});
  const openCardTab = useStripeTabRedirect(card);

  const cardAutomatic: 'mercadopago' | 'stripe' | null =
    mercadoPagoCardEnabled && mercadoPagoPublicKey ? 'mercadopago' : 'stripe';
  const [mpCardResult, setMpCardResult] = useState<EmbeddedCheckoutState | null>(null);
  const [mpCardSubmitting, setMpCardSubmitting] = useState(false);
  const [mpCardWhatsapp, setMpCardWhatsapp] = useState('');
  const mpCardWhatsappRef = useRef(mpCardWhatsapp);
  mpCardWhatsappRef.current = mpCardWhatsapp;
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

          {cardAutomatic === 'mercadopago' && mercadoPagoPublicKey ? (
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

              {mpCardResult?.error && <div className="alert bad">{mpCardResult.error}</div>}
              {mpCardResult?.instructions?.kind === 'resolved' &&
                mpCardResult.instructions.state === 'failed' && (
                  <div className="alert bad">
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
                    if (approved) {
                      trackPixel('Purchase', pixel);
                      router.push(result.orderPageUrl ?? '/');
                      return;
                    }
                    // Only a genuine gateway/order-creation error rejects the
                    // Brick's promise — a real resolved outcome (declined, or
                    // pending on 3DS/bank review) must resolve normally, or
                    // the Brick's own generic overlay hides this screen's own
                    // specific Spanish messages (confirmed in production,
                    // see the combo checkout's identical fix, 2026-11-24).
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
              ) : (
                <p className="hint center">Ingresa tu WhatsApp para continuar.</p>
              )}

              <p className="hint center">
                🔒 Pagas directo con Mercado Pago. Nunca vemos ni guardamos tu tarjeta.
              </p>
            </div>
          ) : (
            <form
              action={cardAction}
              onSubmit={(e) => {
                openCardTab();
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
                  disabled={redirecting}
                  required
                />
              </label>

              <GatewayTabNotice provider="Stripe" />

              {card.error && <div className="alert bad">{card.error}</div>}

              <button className="btn-primary" type="submit" disabled={redirecting}>
                {redirecting ? 'Abriendo pago seguro…' : `Pagar con tarjeta — ${price}`}
              </button>
              <p className="hint center">🔒 Pagas en la página segura de Stripe. Nunca vemos ni guardamos tu tarjeta.</p>
            </form>
          )}

          <button type="button" className="btn-ghost" onClick={() => setStep('datos')}>
            ← Volver
          </button>
        </section>
      )}
    </div>
  );
}
