'use client';

import { useActionState } from 'react';
import { cancelPendingOrder, continuePendingOrder, type CancelState, type ContinueState } from './actions';
import { GatewayTabNotice, useStripeTabRedirect } from '../../../lib/gateway-tab-redirect';

/**
 * "Continuar pago" — for a customer who started a card/OXXO/SPEI checkout and
 * lost the gateway tab before paying. Opens a fresh session on the *same*
 * order rather than sending them back to `/comprar/[combo]`, which would
 * create a second order for the same combo.
 */
export function ContinuePaymentButton({
  orderNumber,
  playerId,
  gatewayLabel,
}: {
  orderNumber: string;
  playerId: string;
  gatewayLabel: string;
}) {
  const [state, action, pending] = useActionState<ContinueState, FormData>(continuePendingOrder, {});
  const openTab = useStripeTabRedirect(state);

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
