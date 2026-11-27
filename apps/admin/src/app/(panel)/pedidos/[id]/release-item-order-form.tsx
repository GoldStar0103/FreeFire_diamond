'use client';

import { useActionState, type FormEvent } from 'react';
import { releaseItemOrder, type ItemReleaseState } from './actions';

interface Props {
  orderId: string;
  orderNumber: string;
}

const confirmFirst = (message: string) => (event: FormEvent<HTMLFormElement>) => {
  if (!window.confirm(message)) event.preventDefault();
};

/**
 * Only rendered by the order-detail page for an item (RocketPass) order
 * that isn't already closed — see that page's own condition. The item-order
 * equivalent of `ReviewPanel`'s "📦 Entregado a mano" action for diamonds:
 * use it once you've confirmed directly in RocketPass's own portal that the
 * order went through, even though this app never got a settlement for it
 * (webhook missed, or the automatic reconcile sweep still hasn't caught up).
 */
export function ReleaseItemOrderForm({ orderId, orderNumber }: Props) {
  const [state, action, pending] = useActionState<ItemReleaseState, FormData>(releaseItemOrder, {});

  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <h2 style={{ marginTop: 0 }}>Liberar artículo sin confirmación de RocketPass</h2>
      <p className="subtitle">
        Úsalo solo cuando ya revisaste directamente en el panel de RocketPass que este pedido sí se
        entregó, y el sistema todavía no lo marcó así aquí. Esto cierra el pedido como completado de
        inmediato.
      </p>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">{state.ok}</div>}

      <form
        action={action}
        onSubmit={confirmFirst(
          `¿Confirmas que revisaste en RocketPass y ${orderNumber} sí se entregó? Esto lo cerrará como completado.`,
        )}
      >
        <input type="hidden" name="orderId" value={orderId} />
        <textarea
          name="note"
          rows={2}
          placeholder="Cómo lo confirmaste: ID de pedido en RocketPass, captura, etc."
          required
          disabled={pending}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <div className="spacer" />
          <button className="btn danger" type="submit" disabled={pending}>
            {pending ? 'Liberando…' : '📦 Liberar artículo'}
          </button>
        </div>
      </form>
    </div>
  );
}
