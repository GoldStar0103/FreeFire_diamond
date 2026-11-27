'use client';

import { useActionState, useState } from 'react';
import { useRouter } from 'next/navigation';
import { cancelPendingOrder, continuePendingOrder, type CancelState, type ContinueState } from './actions';
import { confirmStripeCardPayment } from '../../comprar/[combo]/actions';
import { StripePaymentElement } from '../../comprar/[combo]/stripe-payment-element';
import { GatewayTabNotice, useStripeTabRedirect } from '../../../lib/gateway-tab-redirect';

/**
 * "Continuar pago" — for a customer who started a card/OXXO/SPEI checkout and
 * lost the gateway tab before paying. Opens a fresh session on the *same*
 * order rather than sending them back to `/comprar/[combo]`, which would
 * create a second order for the same combo.
 *
 * Stripe card is a different shape from every other method here: it never
 * redirects, so `continuePendingOrder` hands back a `clientSecret` instead
 * of a `checkoutUrl`, and this component mounts a `StripePaymentElement` in
 * place (mirroring checkout.tsx's own `stripeSession` state) rather than
 * opening a tab. Added 2026-11-27 — every resume attempt on a card order was
 * previously failing outright (see `ContinueState`'s own doc comment).
 */
export function ContinuePaymentButton({
  orderNumber,
  playerId,
  gatewayLabel,
  stripePublishableKey,
}: {
  orderNumber: string;
  playerId: string;
  gatewayLabel: string;
  stripePublishableKey: string | null;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ContinueState, FormData>(continuePendingOrder, {});
  const openTab = useStripeTabRedirect(state);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (state.clientSecret && state.gatewayChargeId && state.orderNumber && stripePublishableKey) {
    const handleConfirmed = async (_status: string) => {
      setConfirming(true);
      setConfirmError(null);

      const fd = new FormData();
      fd.set('gatewayChargeId', state.gatewayChargeId!);
      fd.set('orderNumber', state.orderNumber!);
      fd.set('playerId', state.playerId ?? playerId);

      const result = await confirmStripeCardPayment({}, fd);
      setConfirming(false);

      if (result.error) {
        setConfirmError(result.error);
        return;
      }
      router.push(result.orderPageUrl ?? `/pedido/${orderNumber}?id=${encodeURIComponent(playerId)}`);
    };

    return (
      <div style={{ marginTop: 14 }}>
        {confirmError && (
          <p className="alert bad" style={{ marginBottom: 10 }}>
            {confirmError}
          </p>
        )}
        <StripePaymentElement
          publishableKey={stripePublishableKey}
          clientSecret={state.clientSecret}
          submitLabel="Pagar"
          disabled={confirming}
          onConfirmed={handleConfirmed}
          onError={setConfirmError}
        />
      </div>
    );
  }

  return (
    <form action={action} onSubmit={() => openTab()} style={{ marginTop: 14 }}>
      <input type="hidden" name="orderNumber" value={orderNumber} />
      <input type="hidden" name="playerId" value={playerId} />
      <GatewayTabNotice provider={gatewayLabel} />
      {state.error && (
        <p className="alert bad" style={{ marginBottom: 10 }}>
          {state.error}
        </p>
      )}
      <button className="btn-primary" type="submit" disabled={pending}>
        {pending ? 'Abriendo pago…' : 'Continuar pago'}
      </button>
    </form>
  );
}

/** "Cancelar" — only ever shown for a manual-transfer order still pending or under review. */
export function CancelOrderButton({ orderNumber, playerId }: { orderNumber: string; playerId: string }) {
  const [state, action, pending] = useActionState<CancelState, FormData>(cancelPendingOrder, {});

  if (state.ok) {
    return (
      <p className="hint center" style={{ marginTop: 14 }}>
        Pedido cancelado.
      </p>
    );
  }

  return (
    <form action={action} style={{ marginTop: 10 }}>
      <input type="hidden" name="orderNumber" value={orderNumber} />
      <input type="hidden" name="playerId" value={playerId} />
      {state.error && (
        <p className="alert bad" style={{ marginBottom: 10 }}>
          {state.error}
        </p>
      )}
      <button className="btn-ghost" type="submit" disabled={pending}>
        {pending ? 'Cancelando…' : 'Cancelar pedido'}
      </button>
    </form>
  );
}
