'use client';

import { useActionState, useState } from 'react';
import { reverseOrder, type ReverseState } from './actions';

/**
 * Reversing a delivered order is destructive and rare, so it hides behind a
 * disclosure rather than sitting next to the everyday buttons: the diamonds
 * are already in someone's account and the Level Pass progress they bought is
 * about to be taken back.
 */
export function ReverseOrderForm({ orderId }: { orderId: string }) {
  const [state, action, pending] = useActionState<ReverseState, FormData>(reverseOrder, {});
  const [open, setOpen] = useState(false);

  if (state.ok) return <div className="alert ok">{state.ok}</div>;
  if (state.warning) return <div className="alert warn">{state.warning}</div>;

  if (!open) {
    return (
      <button type="button" className="btn sm" onClick={() => setOpen(true)}>
        Revertir pedido (reembolso o contracargo)
      </button>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="orderId" value={orderId} />
      <p className="hint">
        Úsalo solo si ya devolviste el dinero o el banco hizo un contracargo. Los diamantes ya
        entregados <strong>no</strong> se recuperan; esto deshace el Level Pass, el ranking y la
        venta en la contabilidad.
      </p>
      <label className="field">
        <span>Motivo (el cliente lo verá)</span>
        <input name="reason" required minLength={3} maxLength={200} autoFocus />
      </label>
      {state.error && <div className="alert bad">{state.error}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm bad" type="submit" disabled={pending}>
          {pending ? 'Revirtiendo…' : 'Confirmar reversión'}
        </button>
        <button type="button" className="btn sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
