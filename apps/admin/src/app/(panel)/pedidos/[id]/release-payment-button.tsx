'use client';

import { useActionState, type FormEvent } from 'react';
import { releasePayment, type ReleaseState } from './actions';

interface Props {
  orderId: string;
  orderNumber: string;
}

const confirmFirst = (message: string) => (event: FormEvent<HTMLFormElement>) => {
  if (!window.confirm(message)) event.preventDefault();
};

/**
 * Only rendered by the order-detail page for a `pending_payment` order whose
 * method is a SPEI/OXXO gateway — see that page's own condition. Never for
 * card (never asked for) or `transfer_manual` (already has its own release —
 * the comprobante approval in Aprobaciones).
 */
export function ReleasePaymentButton({ orderId, orderNumber }: Props) {
  const [state, action, pending] = useActionState<ReleaseState, FormData>(releasePayment, {});

  return (
    <div className="card" style={{ borderColor: 'var(--warn)' }}>
      <h2 style={{ marginTop: 0 }}>Liberar recarga sin confirmación del proveedor de pago</h2>
      <p className="subtitle">
        Úsalo solo cuando el cliente ya mostró pruebas de que sí pagó y el sistema no lo detectó —
        un fallo del proveedor de pago, no algo que puedas corregir de otra forma. Esto marca el
        pago como confirmado y empieza la recarga de inmediato, como si el banco u OXXO ya lo
        hubieran reportado.
      </p>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">{state.ok}</div>}

      <form
        action={action}
        onSubmit={confirmFirst(
          `¿Confirmas que ${orderNumber} sí fue pagado y quieres liberar la recarga ahora, sin esperar la confirmación automática?`,
        )}
      >
        <input type="hidden" name="orderId" value={orderId} />
        <button className="btn danger wide" type="submit" disabled={pending}>
          {pending ? 'Liberando…' : '🔓 Liberar recarga'}
        </button>
      </form>
    </div>
  );
}
