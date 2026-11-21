'use client';

import { useActionState } from 'react';
import { setPrizeValueAction, type SetPrizeValueState } from '../actions';

interface Props {
  giveawayId: string;
  /** Pesos, as a plain decimal string for the input's defaultValue — e.g. "750.00". */
  currentValuePesos: string | null;
}

/** Rendered whenever status !== 'delivered' — the value can be set or corrected any time up to delivery. */
export function SetPrizeValueForm({ giveawayId, currentValuePesos }: Props) {
  const [state, action, pending] = useActionState<SetPrizeValueState, FormData>(setPrizeValueAction, {});

  return (
    <form action={action}>
      <input type="hidden" name="id" value={giveawayId} />
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ maxWidth: 180, margin: 0 }}>
          <span>Valor del premio (MXN)</span>
          <input
            name="prizeValue"
            type="text"
            inputMode="decimal"
            placeholder="750.00"
            defaultValue={currentValuePesos ?? ''}
          />
        </label>
        <button className="btn sm" type="submit" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
      {state.ok && <div className="alert ok">{state.ok}</div>}
      {state.error && <div className="alert bad">{state.error}</div>}
    </form>
  );
}
