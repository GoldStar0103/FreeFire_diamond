'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  payWithCard,
  placeOrder,
  validatePlayer,
  type CheckoutState,
  type ValidateState,
} from './actions';
import { trackPixel } from '../../../lib/pixel';

interface PayTo {
  bank: string;
  clabe: string;
  holder: string;
  oxxo: string | null;
}

interface Props {
  comboKey: string;
  comboName: string;
  price: string;
  priceMxn: number;
  diamonds: string;
  /** Null when nobody has configured where the money goes. */
  payTo: PayTo | null;
  /** Stripe is configured. */
  cardEnabled: boolean;
  /** Stripe Checkout also offers OXXO cash vouchers. */
  cardIncludesOxxo: boolean;
  /** The customer came back from Stripe without paying. */
  cancelledNotice: string | null;
  supportNumber: string;
}

type Method = 'card' | 'transfer';
type Step = 'datos' | 'pago' | 'confirmacion';

const STEPS: { key: Step; label: string }[] = [
  { key: 'datos', label: 'Datos' },
  { key: 'pago', label: 'Pago' },
  { key: 'confirmacion', label: 'Confirmación' },
];

/** 18 digits read as three groups, the way a bank statement prints them. */
const groupClabe = (clabe: string): string =>
  clabe.replace(/^(\d{3})(\d{3})(\d{11})(\d)$/, '$1 $2 $3 $4');

/** The numbered progress header from the client's mockup. */
function Stepper({ step }: { step: Step }) {
  const current = STEPS.findIndex((s) => s.key === step);
  return (
    <ol className="checkout-stepper">
      {STEPS.map((s, i) => (
        <li
          key={s.key}
          className={`checkout-step-item ${i < current ? 'done' : i === current ? 'active' : 'pending'}`}
        >
          <span className="checkout-step-dot">{i < current ? '✓' : i + 1}</span>
          <span className="checkout-step-label">{s.label}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Three full screens instead of stacked cards, matching the client's own
 * mockup (Compra-Datos / Método de Pago / Confirmación). The gate between
 * "Datos" and the rest still matters exactly as before: the customer cannot
 * reach payment until their Free Fire ID has been confirmed against the
 * game, since diamonds sent to a wrong ID are unrecoverable.
 *
 * Deliberately NOT in this version, even though the mockup shows them: a
 * "Servidor" field and a mid-checkout package-switch step (neither is real —
 * nothing downstream reads a server id, and the package is fixed by which
 * combo card the customer tapped to get here), and PayPal / a standalone
 * OXXO method (only card-via-Stripe and manual transfer actually work).
 * Showing controls that do nothing is worse than not matching a screenshot.
 */
export function Checkout({
  comboKey,
  comboName,
  price,
  priceMxn,
  diamonds,
  payTo,
  cardEnabled,
  cardIncludesOxxo,
  cancelledNotice,
  supportNumber,
}: Props) {
  const [validation, validateAction, validating] = useActionState<ValidateState, FormData>(
    validatePlayer,
    { status: 'idle' },
  );
  const [transfer, transferAction, placing] = useActionState<CheckoutState, FormData>(
    placeOrder,
    {},
  );
  const [card, cardAction, redirecting] = useActionState<CheckoutState, FormData>(
    payWithCard,
    {},
  );
  const [step, setStep] = useState<Step>('datos');
  // Card first when it exists: one tap to a familiar bank prompt beats typing
  // a CLABE into a banking app and photographing the receipt.
  const [method, setMethod] = useState<Method>(cardEnabled ? 'card' : 'transfer');

  const found = validation.status === 'found';
  const noPaymentConfigured = !payTo && !cardEnabled;
  const showMethodChooser = cardEnabled && Boolean(payTo);
  const byCard = method === 'card' && cardEnabled;
  const pixel = { value: priceMxn, currency: 'MXN' as const, content_ids: [comboKey], content_type: 'product' as const };

  useEffect(() => {
    trackPixel('ViewContent', { ...pixel, content_name: comboName });
    // Once per page view, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmIdentity = () => {
    setStep('pago');
    trackPixel('InitiateCheckout', pixel);
  };

  // The placeholder promises only what happens. Nothing messages the customer
  // automatically — the number reaches a person in the panel, who uses it if
  // something about the order needs sorting out. "We'll let you know when it's
  // ready" was a promise to a market that has been lied to before, and a
  // customer waiting for a message that never comes assumes the worst.
  const whatsappField = (disabled: boolean) => (
    <label className="field">
      <span>Tu WhatsApp (opcional)</span>
      <input
        type="tel"
        name="whatsapp"
        inputMode="tel"
        placeholder="Solo por si necesitamos contactarte"
        disabled={disabled}
      />
    </label>
  );

  return (
    <div className="checkout">
      <div className="summary card">
        <div className="summary-name">{comboName}</div>
        <div className="summary-diamonds">{diamonds} 💎</div>
        <div className="summary-price">{price}</div>
      </div>

      <Stepper step={step} />

      {cancelledNotice && <div className="alert warn">{cancelledNotice}</div>}

      {/* Step 1 — identity */}
      {step === 'datos' && (
        <section className="card step">
          <div className="step-head">
            <span className="step-num">1</span>
            <h2>Tu ID de Free Fire</h2>
          </div>

          <form action={validateAction}>
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
            <p className="hint">
              Lo encuentras en tu perfil dentro del juego, debajo de tu nombre.
            </p>

            {validation.message && (
              <div className={validation.status === 'error' ? 'alert bad' : 'alert warn'}>
                {validation.message}
              </div>
            )}

            {found ? (
              <div className="confirm">
                <div className="confirm-q">¿Eres tú?</div>
                <div className="confirm-name">{validation.nickname}</div>
                <div className="row">
                  <button type="submit" className="btn ghost" disabled={validating}>
                    No, cambiar ID
                  </button>
                  <button type="button" className="btn primary" onClick={confirmIdentity}>
                    Sí, soy yo
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn primary wide" type="submit" disabled={validating}>
                {validating ? 'Buscando…' : 'Buscar mi cuenta'}
              </button>
            )}
          </form>
        </section>
      )}

      {/* Step 2 — payment method */}
      {step === 'pago' && (
        <section className="card step">
          <div className="step-head">
            <span className="step-num">2</span>
            <h2>Selecciona tu método de pago</h2>
          </div>

          <div className="row confirmed" style={{ marginBottom: 16 }}>
            <div>
              <div className="confirm-name">{validation.nickname}</div>
              <div className="hint mono">ID {validation.playerId}</div>
            </div>
            <div className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => setStep('datos')}>
              Cambiar
            </button>
          </div>

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
                  className="btn primary wide"
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
          ) : (
            <>
              {/* Only a choice when there are two things to choose between. */}
              {showMethodChooser && (
                <div className="method-cards" role="radiogroup" aria-label="Forma de pago">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={method === 'card'}
                    className={method === 'card' ? 'method-card active' : 'method-card'}
                    onClick={() => setMethod('card')}
                  >
                    <span className="method-card-icon">💳</span>
                    <span>{cardIncludesOxxo ? 'Tarjeta u OXXO' : 'Tarjeta de crédito/débito'}</span>
                    <span className="method-card-radio" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={method === 'transfer'}
                    className={method === 'transfer' ? 'method-card active' : 'method-card'}
                    onClick={() => setMethod('transfer')}
                  >
                    <span className="method-card-icon">🏦</span>
                    <span>Transferencia bancaria</span>
                    <span className="method-card-radio" aria-hidden="true" />
                  </button>
                </div>
              )}

              {byCard ? (
                <div className="pay-box">
                  <div className="pay-row">
                    <span>Aceptamos</span>
                    <strong>
                      Visa · Mastercard · Amex{cardIncludesOxxo ? ' · Efectivo en OXXO' : ''}
                    </strong>
                  </div>
                  <div className="pay-row total">
                    <span>Total</span>
                    <strong>{price}</strong>
                  </div>
                </div>
              ) : payTo ? (
                <div className="pay-box">
                  <div className="pay-row">
                    <span>Transferencia {payTo.bank}</span>
                    <strong className="mono">{groupClabe(payTo.clabe)}</strong>
                  </div>
                  <div className="pay-row">
                    <span>A nombre de</span>
                    <strong>{payTo.holder}</strong>
                  </div>
                  {/* Only when there is one. An empty OXXO row taught customers to
                      distrust the rest of the box. */}
                  {payTo.oxxo && (
                    <div className="pay-row">
                      <span>Depósito OXXO</span>
                      <strong className="mono">{payTo.oxxo}</strong>
                    </div>
                  )}
                  <div className="pay-row total">
                    <span>Monto exacto</span>
                    <strong>{price}</strong>
                  </div>
                </div>
              ) : null}

              <button
                className="btn primary wide"
                type="button"
                onClick={() => setStep('confirmacion')}
              >
                {byCard ? 'Continuar →' : 'Ya transferí, continuar →'}
              </button>
              <p className="hint center">
                🔒 Pagos 100% seguros.{' '}
                {byCard
                  ? 'Nunca vemos ni guardamos tu tarjeta.'
                  : 'Revisamos tu comprobante y la recarga entra automáticamente.'}
              </p>
            </>
          )}
        </section>
      )}

      {/* Step 3 — review and confirm */}
      {step === 'confirmacion' && !noPaymentConfigured && (
        <section className="card step">
          <div className="step-head">
            <span className="step-num">3</span>
            <h2>Revisa tu pedido</h2>
          </div>

          <dl className="kv" style={{ marginBottom: 16 }}>
            <dt>Paquete</dt>
            <dd>{comboName}</dd>
            <dt>Diamantes</dt>
            <dd>{diamonds} 💎</dd>
            <dt>Precio</dt>
            <dd>{price}</dd>
            <dt>ID de jugador</dt>
            <dd className="mono">{validation.playerId}</dd>
            <dt>Método de pago</dt>
            <dd>{byCard ? (cardIncludesOxxo ? 'Tarjeta u OXXO' : 'Tarjeta') : 'Transferencia bancaria'}</dd>
          </dl>

          {byCard ? (
            <form action={cardAction} onSubmit={() => trackPixel('AddPaymentInfo', pixel)}>
              <input type="hidden" name="comboKey" value={comboKey} />
              <input type="hidden" name="playerId" value={validation.playerId ?? ''} />

              {whatsappField(redirecting)}

              {card.error && <div className="alert bad">{card.error}</div>}

              <button className="btn primary wide" type="submit" disabled={redirecting}>
                {redirecting ? 'Abriendo pago seguro…' : `Confirmar pedido — ${price}`}
              </button>
              <p className="hint center">
                🔒 Pagas en la página segura de Stripe. Nunca vemos ni guardamos tu tarjeta.
              </p>
            </form>
          ) : (
            <form action={transferAction} onSubmit={() => trackPixel('AddPaymentInfo', pixel)}>
              <input type="hidden" name="comboKey" value={comboKey} />
              <input type="hidden" name="playerId" value={validation.playerId ?? ''} />
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

              <button className="btn primary wide" type="submit" disabled={placing}>
                {placing ? 'Enviando…' : 'Confirmar pedido'}
              </button>
              <p className="hint center">
                Revisamos tu pago y la recarga entra automáticamente.
              </p>
            </form>
          )}

          <button type="button" className="btn ghost wide" onClick={() => setStep('pago')}>
            ← Volver
          </button>
        </section>
      )}
    </div>
  );
}
