'use client';

import { useActionState, useState } from 'react';
import { saveCheckpoints, type CheckpointFormState } from './actions';

interface Row {
  lp: string;
  rewardDiamonds: string;
  costCents: string;
  recipe: number[];
}

const num = (n: number) => n.toLocaleString('es-MX');

const toRow = (cp: { lp: number; rewardDiamonds: number; costCents: number; recipe: number[] }): Row => ({
  lp: String(cp.lp),
  rewardDiamonds: String(cp.rewardDiamonds),
  costCents: String(cp.costCents),
  recipe: cp.recipe,
});

export function CheckpointsForm({
  initial,
  available,
}: {
  initial: Array<{ lp: number; rewardDiamonds: number; costCents: number; recipe: number[] }>;
  /** Denominations the provider currently sells, for the recipe builder — same shape the combo form uses. */
  available: Array<{ diamondsBase: number; active: boolean }>;
}) {
  const [state, action, pending] = useActionState<CheckpointFormState, FormData>(saveCheckpoints, {});
  const [rows, setRows] = useState<Row[]>(initial.map(toRow));

  const update = (index: number, field: 'lp' | 'rewardDiamonds' | 'costCents', value: string) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const addToRecipe = (index: number, denomination: number) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, recipe: [...row.recipe, denomination] } : row)));
  };

  const removeFromRecipe = (index: number, recipeIndex: number) => {
    setRows((prev) =>
      prev.map((row, i) =>
        i === index ? { ...row, recipe: row.recipe.filter((_, ri) => ri !== recipeIndex) } : row,
      ),
    );
  };

  return (
    <form action={action}>
      {rows.map((row, i) => (
        <input key={i} type="hidden" name="recipe" value={row.recipe.join(',')} />
      ))}

      <table>
        <thead>
          <tr>
            <th>LP necesarios</th>
            <th>Diamantes de recompensa</th>
            <th>Costo interno (MXN)</th>
            <th>Receta de entrega</th>
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
                <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {available.map((p) => (
                    <button
                      key={p.diamondsBase}
                      type="button"
                      className="btn sm"
                      disabled={!p.active}
                      onClick={() => addToRecipe(i, p.diamondsBase)}
                      title={p.active ? undefined : 'No disponible'}
                    >
                      + {num(p.diamondsBase)}
                    </button>
                  ))}
                </div>
                {row.recipe.length === 0 ? (
                  <p className="hint">Sin receta — esta recompensa no podrá entregarse.</p>
                ) : (
                  <ol className="recipe">
                    {row.recipe.map((d, ri) => (
                      <li key={`${d}-${ri}`}>
                        <span>{num(d)} 💎</span>
                        <button type="button" className="btn sm danger" onClick={() => removeFromRecipe(i, ri)}>
                          Quitar
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </td>
              <td>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                >
                  Quitar checkpoint
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
          onClick={() =>
            setRows((prev) => [...prev, { lp: '', rewardDiamonds: '', costCents: '', recipe: [] }])
          }
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
      {state.error && (
        <div className="alert bad" style={{ marginTop: 10 }}>
          {state.error}
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
