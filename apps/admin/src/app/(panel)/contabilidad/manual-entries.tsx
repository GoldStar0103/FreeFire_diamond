'use client';

import { useActionState, useState } from 'react';
import { addLedgerEntry, removeLedgerEntry, type ManualEntryState } from './actions';

export interface ManualEntryRow {
  id: string;
  kind: 'expense' | 'income';
  amountLabel: string;
  dateLabel: string;
  note: string | null;
  createdByEmail: string | null;
}

/**
 * Gastos e ingresos that no order can produce — rent, a supplier credit, a
 * one-off fee. They are the missing term in real net profit, which is why
 * this sits on the same page as the figure it changes rather than in Ajustes.
 */
export function ManualEntries({ entries, defaultDate }: { entries: ManualEntryRow[]; defaultDate: string }) {
  const [state, action, pending] = useActionState<ManualEntryState, FormData>(addLedgerEntry, {});
  const [open, setOpen] = useState(false);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row">
        <h2 className="mini-title" style={{ margin: 0 }}>
          Gastos e ingresos manuales
        </h2>
        <div className="spacer" />
        {!open && (
          <button type="button" className="btn sm" onClick={() => setOpen(true)}>
            Agregar
          </button>
        )}
      </div>
      <p className="subtitle">
        Lo que no viene de un pedido: renta, comisiones, un reembolso de tu proveedor. Entra en la
        ganancia neta real del rango que estés viendo.
      </p>

      {state.ok && <div className="alert ok">{state.ok}</div>}

      {open && (
        <form action={action} style={{ marginBottom: 12 }}>
          <div className="row">
            <label className="field" style={{ margin: 0 }}>
              <span>Tipo</span>
              <select name="kind" defaultValue="expense">
                <option value="expense">Gasto</option>
                <option value="income">Ingreso</option>
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Monto (MXN)</span>
              <input name="amount" inputMode="decimal" placeholder="1250.00" required />
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Fecha</span>
              <input type="date" name="date" defaultValue={defaultDate} required />
            </label>
          </div>
          <label className="field">
            <span>Nota</span>
            <input name="note" required minLength={3} maxLength={200} placeholder="Renta de octubre" />
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

      {entries.length === 0 ? (
        <div className="card empty">Sin gastos ni ingresos manuales en este rango.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Tipo</th>
                <th>Nota</th>
                <th className="num">Monto</th>
                <th>Quién</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.dateLabel}</td>
                  <td>
                    <span className={`badge ${entry.kind === 'expense' ? 'warn' : 'ok'}`}>
                      {entry.kind === 'expense' ? 'Gasto' : 'Ingreso'}
                    </span>
                  </td>
                  <td>{entry.note ?? '—'}</td>
                  <td className="num">
                    {entry.kind === 'expense' ? '−' : '+'}
                    {entry.amountLabel}
                  </td>
                  <td style={{ color: 'var(--muted)', fontSize: 13 }}>{entry.createdByEmail ?? '—'}</td>
                  <td>
                    <form action={removeLedgerEntry}>
                      <input type="hidden" name="id" value={entry.id} />
                      <button className="btn sm" type="submit">
                        Borrar
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
