'use client';

import { useEffect, useRef } from 'react';
import { CardPayment, initMercadoPago } from '@mercadopago/sdk-react';

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
  onToken: (data: { token: string; paymentMethodId: string; installments: number }) => Promise<void>;
}

export function CardPaymentBrick({ amountMxn, publicKey, onToken }: CardPaymentBrickProps) {
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    if (mpInitialized !== publicKey) {
      initMercadoPago(publicKey, { locale: 'es-MX' });
      mpInitialized = publicKey;
    }
  }, [publicKey]);

  return (
    <CardPayment
      initialization={{ amount: amountMxn }}
      locale="es-MX"
      onSubmit={async (formData) => {
        await onTokenRef.current({
          token: formData.token,
          paymentMethodId: formData.payment_method_id,
          installments: formData.installments,
        });
      }}
      onError={(error) => {
        console.error('[mercadopago-brick] error', error);
      }}
    />
  );
}
