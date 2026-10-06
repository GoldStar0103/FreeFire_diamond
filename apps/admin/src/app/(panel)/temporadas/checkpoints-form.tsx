'use client';

import { useActionState, useState } from 'react';
import { saveCheckpoints, type CheckpointFormState } from './actions';

interface Row {
  lp: string;
  rewardDiamonds: string;
  costCents: string;
}

const toRow = (cp: { lp: number; rewardDiamonds: number; costCents: number }): Row => ({
  lp: String(cp.lp),
  rewardDiamonds: String(cp.rewardDiamonds),
  costCents: String(cp.costCents),
});

export function CheckpointsForm({
  initial,
}: {
  initial: Array<{ lp: number; rewardDiamonds: number; costCents: number }>;
}) {
  const [state, action, pending] = useActionState<CheckpointFormState, FormData>(saveCheckpoints, {});
  const [rows, setRows] = useState<Row[]>(initial.map(toRow));

  const update = (index: number, field: keyof Row, value: string) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  return (
    <form action={action}>
      <table>
        <thead>
          <tr>
            <th>LP necesarios</th>
            <th>Diamantes de recompensa</th>
            <th>Costo interno (MXN)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>
                <input
                  name="lp"
                  type="number"
                  value={row.lp}
                  onChange={(e) => update(i, 'lp', e.target.value)}
                  required
                />
              </td>
              <td>
                <input
                  name="rewardDiamonds"
                  type="number"
                  value={row.rewardDiamonds}
                  onChange={(e) => update(i, 'rewardDiamonds', e.target.value)}
                  required
                />
              </td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  value={row.costCents === '' ? '' : (Number(row.costCents) / 100).toFixed(2)}
                  onChange={(e) => update(i, 'costCents', String(Math.round(Number(e.target.value) * 100)))}
                  required
                />
                <input type="hidden" name="costCents" value={row.costCents} />
              </td>
              <td>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  Quitar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <button
          type="button"
          className="btn sm"
          onClick={() => setRows((prev) => [...prev, { lp: '', rewardDiamonds: '', costCents: '' }])}
        >
          Agregar checkpoint
        </button>
        <div className="spacer" />
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar checkpoints'}
        </button>
      </div>

      {state.issues && state.issues.length > 0 && (
        <div className="alert bad" style={{ marginTop: 10 }}>
          {state.issues.map((issue, i) => (
            <div key={i}>{issue.message}</div>
          ))}
        </div>
      )}
      {state.ok && (
        <div className="alert ok" style={{ marginTop: 10 }}>
          Checkpoints guardados.
        </div>
      )}
    </form>
  );
}
