'use client';

import { useActionState, useState } from 'react';
import { cancelGiveawayAction, type CancelGiveawayState } from '../actions';

/** Hides behind a disclosure, same pattern as `ReverseOrderForm` — cancelling refunds every entrant and cannot be undone. */
export function CancelGiveawayForm({ giveawayId }: { giveawayId: string }) {
  const [state, action, pending] = useActionState<CancelGiveawayState, FormData>(cancelGiveawayAction, {});
  const [open, setOpen] = useState(false);

  if (state.ok) return <div className="alert ok">{state.ok}</div>;

  if (!open) {
    return (
      <button type="button" className="btn sm bad" onClick={() => setOpen(true)}>
        Cancelar sorteo
      </button>
    );
  }

  return (
    <form action={action}>
      <input type="hidden" name="id" value={giveawayId} />
      <p className="hint">Se devolverán los tickets a todos los que ya participaron.</p>
      <label className="field">
        <span>Motivo</span>
        <input name="reason" required minLength={3} maxLength={200} autoFocus />
      </label>
      {state.error && <div className="alert bad">{state.error}</div>}
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm bad" type="submit" disabled={pending}>
          {pending ? 'Cancelando…' : 'Confirmar cancelación'}
        </button>
        <button type="button" className="btn sm" onClick={() => setOpen(false)} disabled={pending}>
          Cerrar
        </button>
      </div>
    </form>
  );
}
