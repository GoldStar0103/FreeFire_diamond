'use client';

import { useCallback, useMemo, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';

/**
 * Wraps Stripe's own Payment Element — card, Apple Pay, Google Pay and Link
 * all confirm in-page through this, never a redirect to a new tab (the
 * client's own ask, 2026-11-26, after a prior hosted-Checkout "white screen"
 * issue). Wallets beyond raw card need no extra wiring here: the Payment
 * Element auto-surfaces whichever are enabled in the Stripe dashboard's own
 * Payment Methods settings for this account/domain.
 *
 * `loadStripe` is cached per publishable key, same reasoning as
 * `card-payment-brick.tsx`'s own `mpInitialized` — Stripe's own JS should
 * load once, not be torn down and reinitialized on every re-render.
 */
let stripePromiseCache: { key: string; promise: Promise<Stripe | null> } | null = null;

function getStripePromise(publishableKey: string): Promise<Stripe | null> {
  if (stripePromiseCache?.key !== publishableKey) {
    stripePromiseCache = { key: publishableKey, promise: loadStripe(publishableKey) };
  }
  return stripePromiseCache.promise;
}

export interface StripePaymentElementProps {
  publishableKey: string;
  clientSecret: string;
  submitLabel: string;
  disabled?: boolean;
  /**
   * Called once `stripe.confirmPayment` resolves, whatever the outcome —
   * even a client-side decline, since the caller still needs to re-check the
   * real state with our own server (never trusting what the browser alone
   * says happened) and settle the order accordingly.
   */
  onConfirmed: (status: string) => void | Promise<void>;
  /** A client-side-detected problem (invalid card, immediate decline) — Stripe's own message, in Spanish per `locale` below. */
  onError: (message: string) => void;
}

export function StripePaymentElement({
  publishableKey,
  clientSecret,
  submitLabel,
  disabled = false,
  onConfirmed,
  onError,
}: StripePaymentElementProps) {
  const stripePromise = useMemo(() => getStripePromise(publishableKey), [publishableKey]);
  // `options` must stay referentially stable across renders unrelated to the
  // charge itself — same discipline card-payment-brick.tsx documents for the
  // Mercado Pago Brick, and for the same reason: recreating it tears down
  // and remounts the Payment Element's own iframes.
  const options = useMemo(() => ({ clientSecret, locale: 'es-419' as const }), [clientSecret]);

  return (
    <Elements key={clientSecret} stripe={stripePromise} options={options}>
      <StripePaymentForm submitLabel={submitLabel} disabled={disabled} onConfirmed={onConfirmed} onError={onError} />
    </Elements>
  );
}

function StripePaymentForm({
  submitLabel,
  disabled,
  onConfirmed,
  onError,
}: Pick<StripePaymentElementProps, 'submitLabel' | 'disabled' | 'onConfirmed' | 'onError'>) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!stripe || !elements) return;
    setSubmitting(true);

    // `allow_redirects: 'never'` on the PaymentIntent itself (see stripe.ts)
    // already guarantees no redirect-requiring method is ever offered here —
    // 3D Secure for card is handled inline by Stripe.js regardless (a modal,
    // not a navigation), so there is nothing this needs a return_url for.
    const { error, paymentIntent } = await stripe.confirmPayment({
      elements,
      redirect: 'if_required',
    });

    setSubmitting(false);

    if (error) {
      // Stripe's own card declines leave the PaymentIntent at
      // `requires_payment_method`, not a dead end — the same Payment Element
      // stays mounted and usable for a different card, exactly like Mercado
      // Pago's own Brick does on a decline.
      onError(error.message ?? 'No pudimos procesar tu tarjeta. Revisa los datos o intenta con otra.');
      return;
    }

    await onConfirmed(paymentIntent?.status ?? 'unknown');
  }, [stripe, elements, onConfirmed, onError]);

  return (
    <div>
      <PaymentElement />
      <button
        type="button"
        className="btn-primary"
        disabled={disabled || submitting || !stripe || !elements}
        onClick={handleSubmit}
        style={{ marginTop: 12 }}
      >
        {submitting ? 'Procesando…' : submitLabel}
      </button>
    </div>
  );
}
