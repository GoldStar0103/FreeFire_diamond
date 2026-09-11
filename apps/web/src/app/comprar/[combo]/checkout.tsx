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

/** 18 digits read as three groups, the way a bank statement prints them. */
const groupClabe = (clabe: string): string =>
  clabe.replace(/^(\d{3})(\d{3})(\d{11})(\d)$/, '$1 $2 $3 $4');

/**
 * Two steps, and the gate between them matters: the customer cannot reach the
 * payment details until their Free Fire ID has been confirmed against the game.
 * Diamonds sent to a wrong ID are unrecoverable, so this ordering is the
 * product working correctly, not a UX preference.
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
  const [confirmed, setConfirmed] = useState(false);
  // Card first when it exists: one tap to a familiar bank prompt beats typing
  // a CLABE into a banking app and photographing the receipt.
  const [method, setMethod] = useState<Method>(cardEnabled ? 'card' : 'transfer');

  const found = validation.status === 'found';
  const pixel = { value: priceMxn, currency: 'MXN' as const, content_ids: [comboKey], content_type: 'product' as const };

  useEffect(() => {
    trackPixel('ViewContent', { ...pixel, content_name: comboName });
    // Once per page view, not per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmIdentity = () => {
    setConfirmed(true);
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

      {cancelledNotice && <div className="alert warn">{cancelledNotice}</div>}

      {/* Step 1 — identity */}
      <section className="card step">
        <div className="step-head">
          <span className="step-num">1</span>
          <h2>Tu ID de Free Fire</h2>
        </div>

        {!confirmed ? (
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
        ) : (
          <div className="row confirmed">
            <div>
              <div className="confirm-name">{validation.nickname}</div>
              <div className="hint mono">ID {validation.playerId}</div>
            </div>
            <div className="spacer" />
            <button type="button" className="btn ghost sm" onClick={() => setConfirmed(false)}>
              Cambiar
            </button>
          </div>
        )}
      </section>

      {/* Step 2 — payment. Deliberately unreachable until step 1 passes. */}
      <section className={confirmed ? 'card step' : 'card step disabled'}>
        <div className="step-head">
          <span className="step-num">2</span>
          <h2>{method === 'card' && cardEnabled ? 'Paga tu recarga' : 'Paga y sube tu comprobante'}</h2>
        </div>

        {!confirmed ? (
          <p className="hint">Primero confirma tu ID de Free Fire.</p>
        ) : !payTo && !cardEnabled ? (
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
            {cardEnabled && payTo && (
              <div className="method-tabs" role="tablist" aria-label="Forma de pago">
                <button
                  type="button"
                  role="tab"
                  aria-selected={method === 'card'}
                  className={method === 'card' ? 'method-tab active' : 'method-tab'}
                  onClick={() => setMethod('card')}
                >
                  💳 {cardIncludesOxxo ? 'Tarjeta u OXXO' : 'Tarjeta'}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={method === 'transfer'}
                  className={method === 'transfer' ? 'method-tab active' : 'method-tab'}
                  onClick={() => setMethod('transfer')}
                >
                  🏦 Transferencia
                </button>
              </div>
            )}

            {method === 'card' && cardEnabled ? (
              <form action={cardAction} onSubmit={() => trackPixel('AddPaymentInfo', pixel)}>
                <input type="hidden" name="comboKey" value={comboKey} />
                <input type="hidden" name="playerId" value={validation.playerId ?? ''} />

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

                {whatsappField(redirecting)}

                {card.error && <div className="alert bad">{card.error}</div>}

                <button className="btn primary wide" type="submit" disabled={redirecting}>
                  {redirecting ? 'Abriendo pago seguro…' : `Pagar ${price}`}
                </button>
                <p className="hint center">
                  🔒 Pagas en la página segura de Stripe. Nunca vemos ni guardamos tu tarjeta.
                  <br />
                  Tu recarga entra automáticamente al confirmarse el pago.
                </p>
              </form>
            ) : payTo ? (
              <>
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
                    {placing ? 'Enviando…' : 'Enviar mi pedido'}
                  </button>
                  <p className="hint center">
                    Revisamos tu pago y la recarga entra automáticamente.
                  </p>
                </form>
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
