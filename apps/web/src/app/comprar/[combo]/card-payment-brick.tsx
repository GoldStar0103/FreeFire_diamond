'use client';

import { useEffect, useRef } from 'react';
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
 */

let mpInitialized: string | null = null;

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

  return (
    <CardPayment
      initialization={{ amount: amountMxn }}
      customization={{ paymentMethods: { minInstallments: 1, maxInstallments: 1 } }}
      locale="es-MX"
      onSubmit={async (formData) => {
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
          // The page was open across a deploy — the server action this tab
          // is calling no longer exists in the new build. No charge was ever
          // attempted (the request never reached our server at all), so the
          // only real fix is a fresh copy of the page, not a retry Mercado
          // Pago's own Brick has no way to recover from — confirmed to be
          // exactly what a real customer kept hitting in production
          // 2026-11-24, each time mistaken for a new payment bug.
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('Failed to find Server Action')) {
            window.location.reload();
            return;
          }
          throw err;
        }
      }}
      onError={(error) => {
        console.error('[mercadopago-brick] error', error);
        logCardBrickError(error).catch(() => {
          /* Best-effort — losing the log is better than breaking the page over it. */
        });
        onBrickErrorRef.current?.(error);
      }}
    />
  );
}
