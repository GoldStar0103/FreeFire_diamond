'use client';

import { useActionState, useState } from 'react';
import { createGiveawayAction, type CreateGiveawayFormState } from './actions';

const SCHEDULE_LABEL: Record<string, string> = {
  daily: 'Diario',
  weekly: 'Semanal',
  monthly: 'Mensual',
  flash: 'Flash',
};

/** Hides behind a disclosure, same pattern as `ReverseOrderForm` — creating a giveaway is occasional, not an everyday action. */
export function NewGiveawayForm() {
  const [state, action, pending] = useActionState<CreateGiveawayFormState, FormData>(createGiveawayAction, {});
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn primary" onClick={() => setOpen(true)} style={{ marginBottom: 16 }}>
        Nuevo sorteo
      </button>
    );
  }

  return (
    <form action={action} className="card">
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Nuevo sorteo</h2>

      <label className="field">
        <span>Título</span>
        <input name="title" required maxLength={120} placeholder="Sorteo semanal de diamantes" />
      </label>

      <label className="field">
        <span>Descripción (la ve el jugador)</span>
        <textarea name="description" required maxLength={500} rows={2} />
      </label>

      <label className="field">
        <span>Premio</span>
        <input name="prizeDescription" required maxLength={200} placeholder="5000 diamantes" />
      </label>

      <div className="row">
        <label className="field" style={{ maxWidth: 200 }}>
          <span>Costo por entrada (tickets)</span>
          <input name="entryCostTickets" type="number" min={1} step={1} defaultValue={10} required />
        </label>
        <label className="field" style={{ maxWidth: 200 }}>
          <span>Mínimo de entradas</span>
          <input name="minEntries" type="number" min={0} step={1} defaultValue={10} required />
        </label>
        <label className="field" style={{ maxWidth: 200 }}>
          <span>Tipo</span>
          <select name="scheduleType" defaultValue="daily">
            {Object.entries(SCHEDULE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="row">
        <label className="field" style={{ maxWidth: 220 }}>
          <span>Máx. entradas por jugador (opcional)</span>
          <input name="maxEntriesPerPlayer" type="number" min={1} step={1} placeholder="Sin límite" />
        </label>
        <label className="field" style={{ maxWidth: 220 }}>
          <span>Máx. participantes (opcional)</span>
          <input name="maxParticipants" type="number" min={1} step={1} placeholder="Sin límite" />
        </label>
      </div>

      <div className="row">
        <label className="field">
          <span>Abre (hora Ciudad de México)</span>
          <input name="opensAt" type="datetime-local" required />
        </label>
        <label className="field">
          <span>Cierra (hora Ciudad de México)</span>
          <input name="closesAt" type="datetime-local" required />
        </label>
      </div>

      <p className="hint">
        Si no se alcanza el mínimo de entradas al cerrar, el sorteo se cancela solo y se devuelven
        los tickets a quienes participaron. Nadie se sortea automáticamente — eso siempre lo haces
        tú desde el detalle del sorteo.
      </p>

      {state.issues?.map((issue) => (
        <div className="alert bad" key={issue}>
          {issue}
        </div>
      ))}
      {state.created && (
        <div className="alert ok">Sorteo creado como borrador. Públicalo cuando esté listo.</div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Creando…' : 'Crear sorteo'}
        </button>
        <button type="button" className="btn sm" onClick={() => setOpen(false)} disabled={pending}>
          Cancelar
        </button>
      </div>
    </form>
  );
}
