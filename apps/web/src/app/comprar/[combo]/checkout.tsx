'use client';

import { useActionState, useState } from 'react';
import {
  placeOrder,
  validatePlayer,
  type CheckoutState,
  type ValidateState,
} from './actions';

interface Props {
  comboKey: string;
  comboName: string;
  price: string;
  diamonds: string;
  bankDetails: { bank: string; clabe: string; holder: string; oxxo: string };
}

/**
 * Two steps, and the gate between them matters: the customer cannot reach the
 * payment details until their Free Fire ID has been confirmed against the game.
 * Diamonds sent to a wrong ID are unrecoverable, so this ordering is the
 * product working correctly, not a UX preference.
 */
export function Checkout({ comboKey, comboName, price, diamonds, bankDetails }: Props) {
  const [validation, validateAction, validating] = useActionState<ValidateState, FormData>(
    validatePlayer,
    { status: 'idle' },
  );
  const [checkout, checkoutAction, placing] = useActionState<CheckoutState, FormData>(
    placeOrder,
    {},
  );
  const [confirmed, setConfirmed] = useState(false);

  const found = validation.status === 'found';

  return (
    <div className="checkout">
      <div className="summary card">
        <div className="summary-name">{comboName}</div>
        <div className="summary-diamonds">{diamonds} 💎</div>
        <div className="summary-price">{price}</div>
      </div>

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
                  <button type="button" className="btn primary" onClick={() => setConfirmed(true)}>
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
          <h2>Paga y sube tu comprobante</h2>
        </div>

        {!confirmed ? (
          <p className="hint">Primero confirma tu ID de Free Fire.</p>
        ) : (
          <>
            <div className="pay-box">
              <div className="pay-row">
                <span>Transferencia {bankDetails.bank}</span>
                <strong className="mono">{bankDetails.clabe}</strong>
              </div>
              <div className="pay-row">
                <span>A nombre de</span>
                <strong>{bankDetails.holder}</strong>
              </div>
              <div className="pay-row">
                <span>Depósito OXXO</span>
                <strong className="mono">{bankDetails.oxxo}</strong>
              </div>
              <div className="pay-row total">
                <span>Monto exacto</span>
                <strong>{price}</strong>
              </div>
            </div>

            <form action={checkoutAction}>
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

              <label className="field">
                <span>Tu WhatsApp (opcional)</span>
                <input
                  type="tel"
                  name="whatsapp"
                  inputMode="tel"
                  placeholder="Para avisarte cuando esté lista"
                  disabled={placing}
                />
              </label>

              {checkout.error && <div className="alert bad">{checkout.error}</div>}

              <button className="btn primary wide" type="submit" disabled={placing}>
                {placing ? 'Enviando…' : 'Enviar mi pedido'}
              </button>
              <p className="hint center">
                Revisamos tu pago y la recarga entra automáticamente.
              </p>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
