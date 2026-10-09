'use client';

import { useActionState, useState } from 'react';
import { overrideLp, type LpOverrideState } from './actions';

/**
 * Both figures stay on screen while editing: the admin needs to see what the
 * formula said before deciding to disagree with it.
 */
export function LpOverrideForm({
  orderId,
  calculatedLp,
  awardedLp,
  overridden,
  overrideReason,
}: {
  orderId: string;
  calculatedLp: number;
  awardedLp: number;
  overridden: boolean;
  overrideReason: string | null;
}) {
  const [state, action, pending] = useActionState<LpOverrideState, FormData>(overrideLp, {});
  const [open, setOpen] = useState(false);

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h2 className="mini-title">Level Points</h2>
      <dl className="kv">
        <dt>Calculado</dt>
        <dd>{calculatedLp}</dd>
        <dt>Otorgado</dt>
        <dd>
          {awardedLp}
          {overridden && (
            <span className="badge warn" style={{ marginLeft: 6 }}>
              ajustado a mano
            </span>
          )}
        </dd>
        {overrideReason && (
          <>
            <dt>Motivo</dt>
            <dd>{overrideReason}</dd>
          </>
        )}
      </dl>

      {state.ok && <div className="alert ok">{state.ok}</div>}
      {state.warning && <div className="alert warn">{state.warning}</div>}

      {!open ? (
        <button type="button" className="btn sm" onClick={() => setOpen(true)}>
          Ajustar LP a mano
        </button>
      ) : (
        <form action={action}>
          <input type="hidden" name="orderId" value={orderId} />
          <p className="hint">
            Cambia los LP que este pedido le dio al jugador. Si con el nuevo valor alcanza o pierde
            un checkpoint, el sistema lo ajusta solo. El valor calculado se conserva.
          </p>
          <label className="field">
            <span>LP otorgados</span>
            <input name="lp" type="number" min={0} step={1} defaultValue={awardedLp} required autoFocus />
          </label>
          <label className="field">
            <span>Motivo</span>
            <input name="reason" required minLength={3} maxLength={200} />
          </label>
          {state.error && <div className="alert bad">{state.error}</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm primary" type="submit" disabled={pending}>
              {pending ? 'Guardando…' : 'Guardar'}
            </button>
            <button type="button" className="btn sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancelar
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
