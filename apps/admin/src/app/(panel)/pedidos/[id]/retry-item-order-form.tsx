'use client';

import { useActionState, type FormEvent } from 'react';
import { retryItemOrder, type ItemRetryState } from './actions';

interface Props {
  orderId: string;
  orderNumber: string;
}

const confirmFirst = (message: string) => (event: FormEvent<HTMLFormElement>) => {
  if (!window.confirm(message)) event.preventDefault();
};

/**
 * Only rendered by the order-detail page for an item order that's
 * `needs_review` AND has no RocketPass order id on file yet — see that
 * page's own condition. For a case like `INSUFFICIENT_BALANCE`: RocketPass
 * refused it outright, so nothing was ever created there and resending is
 * safe. If RocketPass *does* already have an order for this (shown just
 * above), use "Liberar" instead, after checking its own portal.
 */
export function RetryItemOrderForm({ orderId, orderNumber }: Props) {
  const [state, action, pending] = useActionState<ItemRetryState, FormData>(retryItemOrder, {});

  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <h2 style={{ marginTop: 0 }}>Reintentar con RocketPass</h2>
      <p className="subtitle">
        RocketPass nunca llegó a crear este pedido (por ejemplo, rechazado por saldo insuficiente de
        la cuenta). Úsalo una vez que hayas resuelto lo que lo bloqueó — se enviará de nuevo en el
        siguiente ciclo del worker.
      </p>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">{state.ok}</div>}

      <form
        action={action}
        onSubmit={confirmFirst(`¿Confirmas que ya resolviste el problema y quieres reintentar ${orderNumber}?`)}
      >
        <input type="hidden" name="orderId" value={orderId} />
        <textarea
          name="note"
          rows={2}
          placeholder="Por qué es seguro reintentar ahora (ej. ya se recargó el saldo de RocketPass)."
          required
          disabled={pending}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <div className="spacer" />
          <button className="btn" type="submit" disabled={pending}>
            {pending ? 'Reintentando…' : '🔁 Reintentar'}
          </button>
        </div>
      </form>
    </div>
  );
}
