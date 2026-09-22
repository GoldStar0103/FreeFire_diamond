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
  /** Null when nobody has configured where the money goes. */
  payTo: PayTo | null;
  /** Stripe is configured. */
  cardEnabled: boolean;
  /** Stripe Checkout also offers OXXO cash vouchers. */
  cardIncludesOxxo: boolean;
  /** Stripe Checkout also offers automatic SPEI bank transfer (customer_balance). */
  cardIncludesSpei: boolean;
  /** Owner switch, independent of whether payTo is configured — see Ajustes. */
  transferEnabled: boolean;
  /** Owner switch for the manual OXXO/SPIN reference — distinct from Stripe's own OXXO. */
  oxxoEnabled: boolean;
  /** The customer came back from Stripe without paying. */
  cancelledNotice: string | null;
  supportNumber: string;
}

/**
 * What's actually being paid, one screen at a time. `transferencia` and
 * `oxxo` both submit as the same backend `transfer_manual` order — see
 * schema.ts's own comment on that enum value — this is a display distinction
 * for the two account numbers a customer might send money to, not two
 * different payment integrations.
 */
type PayView = 'choose' | 'tarjeta' | 'transferencia' | 'oxxo';
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

/**
 * Stripe's own Checkout page is what actually lets the customer pick between
 * whichever of these are enabled — this button just has to stop promising
 * "Tarjeta" alone once there's more behind it.
 */
function cardMethodsLabel(cardIncludesOxxo: boolean, cardIncludesSpei: boolean): string {
  if (cardIncludesOxxo && cardIncludesSpei) return 'Tarjeta, OXXO o SPEI';
  if (cardIncludesOxxo) return 'Tarjeta u OXXO';
  if (cardIncludesSpei) return 'Tarjeta o SPEI';
  return 'Tarjeta';
}

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
}: {
  tone: 'blue' | 'red' | 'purple';
  icon: (props: { className?: string }) => React.ReactElement;
  badge?: string;
  title: string;
  features: string[];
  extra?: React.ReactNode;
  ctaLabel: string;
  onClick: () => void;
}) {
  return (
    <div className={`pay-option ${tone}`}>
      <div className="pay-option-head">
        <Icon className="icon pay-option-icon" />
        {badge && <span className="pay-option-badge">{badge}</span>}
      </div>
      <div className="pay-option-title">{title}</div>
      {/* Same label on every method: card is instant, and transfer/OXXO still
          land the diamonds automatically once the comprobante is approved.
          First-time buyers read this as "my diamonds arrive by themselves",
          which is the promise the owner wants on the whole comparison screen. */}
      <span className="pay-option-manual">RECARGA AUTOMÁTICA</span>
      <ul className="pay-option-features">
        {features.map((f) => (
          <li key={f}>
            <span aria-hidden="true">✓</span> {f}
          </li>
        ))}
      </ul>
      {extra}
      <button type="button" className={`btn wide pay-option-cta ${tone}`} onClick={onClick}>
        {ctaLabel}
      </button>
    </div>
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
  payTo,
  cardEnabled,
  cardIncludesOxxo,
  cardIncludesSpei,
  transferEnabled,
  oxxoEnabled,
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

  const found = validation.status === 'found';

  const cardOption = cardEnabled;
  const transferOption = payTo !== null && transferEnabled;
  const oxxoOption = payTo !== null && payTo.oxxo !== null && oxxoEnabled;
  const optionCount = [cardOption, transferOption, oxxoOption].filter(Boolean).length;
  const noPaymentConfigured = optionCount === 0;

  // Always shows the comparison screen, even with exactly one method
  // enabled — the owner turns methods on/off from Ajustes (e.g. card-only
  // overnight), and a customer landing straight on "Paga tu recarga" with no
  // card to tap first reads as broken, not as a shortcut.
  const [payView, setPayView] = useState<PayView>('choose');

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

  const methodLabel =
    payView === 'tarjeta'
      ? cardMethodsLabel(cardIncludesOxxo, cardIncludesSpei)
      : payView === 'oxxo'
        ? 'Depósito OXXO'
        : 'Transferencia bancaria';

  // The placeholder promises only what happens. Nothing messages the customer
  // automatically — the number reaches a person in the panel, who uses it if
  // something about the order needs sorting out. "We'll let you know when it's
  // ready" was a promise to a market that has been lied to before, and a
  // customer waiting for a message that never comes assumes the worst.
  const whatsappField = (disabled: boolean, required = false) => (
    <label className="field">
      <span>Tu WhatsApp{required ? '' : ' (opcional)'}</span>
      <input
        type="tel"
        name="whatsapp"
        inputMode="tel"
        placeholder="Solo por si necesitamos contactarte"
        disabled={disabled}
        required={required}
      />
    </label>
  );

  const identityRow = (
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
            <h2>
              {payView === 'choose'
                ? 'Selecciona tu método de pago'
                : payView === 'tarjeta'
                  ? 'Paga tu recarga'
                  : `Datos para tu ${payView === 'oxxo' ? 'depósito' : 'transferencia'}`}
            </h2>
            {payView !== 'choose' && (
              <span className="pay-option-manual">RECARGA AUTOMÁTICA</span>
            )}
          </div>

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
          ) : payView === 'choose' ? (
            <>
              <div className="pay-compare">
                {cardOption && (
                  <PayOptionCard
                    tone="purple"
                    icon={CardIcon}
                    title={
                      cardIncludesOxxo || cardIncludesSpei
                        ? cardMethodsLabel(cardIncludesOxxo, cardIncludesSpei)
                        : 'Tarjeta de crédito/débito'
                    }
                    features={[
                      'Pago instantáneo',
                      'Visa · Mastercard · Amex',
                      'Recarga automática al confirmarse',
                    ]}
                    ctaLabel="Pagar con tarjeta →"
                    onClick={() => setPayView('tarjeta')}
                  />
                )}
                {transferOption && (
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
                )}
                {oxxoOption && (
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
                )}
              </div>
              <p className="hint center">
                🛡️ Pagos 100% seguros. Revisamos tu comprobante y la recarga entra automáticamente.
              </p>
            </>
          ) : payView === 'tarjeta' ? (
            <>
              <div className="pay-box">
                <div className="pay-row">
                  <span>Aceptamos</span>
                  <strong>
                    Visa · Mastercard · Amex
                    {cardIncludesOxxo ? ' · Efectivo en OXXO' : ''}
                    {cardIncludesSpei ? ' · Transferencia SPEI' : ''}
                  </strong>
                </div>
                <div className="pay-row total">
                  <span>Total</span>
                  <strong>{price}</strong>
                </div>
              </div>
              <button className="btn primary wide" type="button" onClick={() => setStep('confirmacion')}>
                Continuar →
              </button>
              <p className="hint center">🔒 Pagos 100% seguros. Nunca vemos ni guardamos tu tarjeta.</p>
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
              <button className="btn primary wide" type="button" onClick={() => setStep('confirmacion')}>
                Ya deposité, continuar →
              </button>
              <p className="hint center">
                🔒 Tu comprobante será revisado automáticamente. La recarga se reflejará en unos
                minutos.
              </p>
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
              <button className="btn primary wide" type="button" onClick={() => setStep('confirmacion')}>
                Ya transferí, continuar →
              </button>
              <p className="hint center">
                🔒 Tu comprobante será revisado automáticamente. La recarga se reflejará en unos
                minutos.
              </p>
            </>
          ) : null}

          {payView !== 'choose' && optionCount > 1 && (
            <button type="button" className="btn ghost wide" onClick={() => setPayView('choose')}>
              ← Elegir otro método
            </button>
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
            <dd>{methodLabel}</dd>
          </dl>

          {payView === 'tarjeta' ? (
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

              {whatsappField(placing, true)}

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
