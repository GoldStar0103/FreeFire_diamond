'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { CardPayment, initMercadoPago } from '@mercadopago/sdk-react';
import { logCardBrickError } from '../../../lib/log-card-brick-error';

/**
 * Wraps Mercado Pago's own Card Payment Brick — the one piece of this
 * checkout that unavoidably needs a vendor dependency, since tokenizing a
 * card requires Mercado Pago's own JS running in the browser (raw card data
 * must never reach this server). Shared between the combo checkout and the
 * RocketPass item-shop checkout, which mirror each other's payment flow.
 *
 * The Brick's `onSubmit` is a round trip, not a plain event: Mercado Pago
 * expects the promise to resolve when the charge succeeds and reject when it
 * doesn't, and shows its own inline error state on a rejection. `onToken`
 * here is expected to do exactly that — build the real server-action call,
 * await it, and throw if the result wasn't a successful charge — rather than
 * just reporting the token upward and returning immediately.
 *
 * Every prop here MUST stay referentially stable across re-renders.
 * `CardPayment`'s own source (@mercadopago/sdk-react) re-runs its entire
 * setup effect — tearing down and recreating the Brick, including the
 * `secure-fields.mercadopago.com` iframes the card number/expiry/CVV
 * actually live in — whenever `initialization`, `customization`, `onSubmit`,
 * `onError`, `onReady`, or `onBinChange` change by reference, not by value.
 * Passing inline object/function literals (what every earlier version of
 * this file did) means EVERY re-render of the parent page — typing a single
 * character into the WhatsApp field, any sibling state update — tore the
 * Brick down and rebuilt it, repeatedly and often before the iframes
 * finished their own setup. Confirmed in production 2026-11-24: Mercado
 * Pago's own onError reported `cause: 'fields_setup_failed_after_3_tries'`,
 * `message: 'The integration with Secure Fields failed'`, firing over and
 * over in a tight loop for a real customer — almost certainly the actual
 * cause behind a large share of that day's "Ha ocurrido un error" reports,
 * not a Mercado Pago-side problem at all.
 */

let mpInitialized: string | null = null;

/** Never changes across renders — defined once, not recreated per mount. */
const CARD_CUSTOMIZATION = { paymentMethods: { minInstallments: 1, maxInstallments: 1 } };

export interface CardPaymentBrickProps {
  amountMxn: number;
  publicKey: string;
  onToken: (data: {
    token: string;
    paymentMethodId: string;
    installments: number;
    payerEmail: string | null;
    payerIdentification: { type: string; number: string } | null;
  }) => Promise<void>;
  /**
   * Fires when the Brick itself fails — tokenization, not our own backend —
   * which `onSubmit` is never even called for. Optional only so existing
   * callers don't break; every real caller should pass this, since without
   * it a customer who hits this has nothing on screen but Mercado Pago's own
   * opaque generic overlay and we have no server-side record it happened.
   */
  onBrickError?: (error: { type: 'non_critical' | 'critical'; cause: string; message: string }) => void;
}

export function CardPaymentBrick({ amountMxn, publicKey, onToken, onBrickError }: CardPaymentBrickProps) {
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const onBrickErrorRef = useRef(onBrickError);
  onBrickErrorRef.current = onBrickError;

  useEffect(() => {
    if (mpInitialized !== publicKey) {
      initMercadoPago(publicKey, { locale: 'es-MX' });
      mpInitialized = publicKey;
    }
  }, [publicKey]);

  // Referentially stable across renders — see the file-level comment above
  // for exactly why this matters. `amountMxn` is the only real input, so
  // this only changes when the price actually does (never, mid-checkout).
  const initialization = useMemo(() => ({ amount: amountMxn }), [amountMxn]);

  const handleSubmit = useCallback(async (formData: {
    token: string;
    payment_method_id: string;
    installments: number;
    payer?: { email?: string; identification?: { type?: string; number?: string } };
  }) => {
    try {
      await onTokenRef.current({
        token: formData.token,
        paymentMethodId: formData.payment_method_id,
        installments: formData.installments,
        payerEmail: formData.payer?.email ?? null,
        payerIdentification:
          formData.payer?.identification?.type && formData.payer?.identification?.number
            ? {
                type: formData.payer.identification.type,
                number: formData.payer.identification.number,
              }
            : null,
      });
    } catch (err) {
      // The page was open across a deploy — the server action this tab is
      // calling no longer exists in the new build. No charge was ever
      // attempted (the request never reached our server at all), so the
      // only real fix is a fresh copy of the page, not a retry Mercado
      // Pago's own Brick has no way to recover from — confirmed to be
      // exactly what a real customer kept hitting in production 2026-11-24,
      // each time mistaken for a new payment bug.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Failed to find Server Action')) {
        window.location.reload();
        return;
      }
      throw err;
    }
  }, []);

  const handleError = useCallback((error: { type: 'non_critical' | 'critical'; cause: string; message: string }) => {
    console.error('[mercadopago-brick] error', error);
    logCardBrickError(error).catch(() => {
      /* Best-effort — losing the log is better than breaking the page over it. */
    });
    onBrickErrorRef.current?.(error);
  }, []);

  return (
    <CardPayment
      initialization={initialization}
      customization={CARD_CUSTOMIZATION}
      locale="es-MX"
      onSubmit={handleSubmit}
      onError={handleError}
    />
  );
}
