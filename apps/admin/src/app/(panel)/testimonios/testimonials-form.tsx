'use client';

import { useActionState, useState } from 'react';
import { saveTestimonialsAction, type TestimonialsFormState } from './actions';

interface Row {
  quote: string;
  author: string;
  combo: string;
}

const EMPTY: Row = { quote: '', author: '', combo: '' };

/** Matches MAX_QUOTE in the store, so the counter agrees with the validator. */
const MAX_QUOTE = 400;

export function TestimonialsForm({ initial }: { initial: Row[] }) {
  const [state, action, saving] = useActionState<TestimonialsFormState, FormData>(
    saveTestimonialsAction,
    {},
  );

  // Seeded from the last submission when there was one, so a rejected save
  // never loses what was typed.
  const [rows, setRows] = useState<Row[]>(
    state.draft?.length
      ? state.draft.map((t) => ({ quote: t.quote, author: t.author, combo: t.combo ?? '' }))
      : initial.length
        ? initial
        : [EMPTY],
  );

  const update = (index: number, field: keyof Row, value: string) =>
    setRows((current) => current.map((r, i) => (i === index ? { ...r, [field]: value } : r)));

  const remove = (index: number) =>
    setRows((current) => (current.length === 1 ? [EMPTY] : current.filter((_, i) => i !== index)));

  return (
    <form action={action}>
      {rows.map((row, i) => (
        <div className="card" key={i}>
          <div className="row" style={{ marginBottom: 8 }}>
            <strong style={{ fontSize: 13, color: 'var(--muted)' }}>Testimonio {i + 1}</strong>
            <div className="spacer" />
            <button className="btn sm" type="button" onClick={() => remove(i)}>
              Quitar
            </button>
          </div>

          <label className="field">
            <span>Comentario</span>
            <textarea
              name="quote"
              rows={2}
              value={row.quote}
              onChange={(e) => update(i, 'quote', e.target.value)}
              placeholder="Súper rápido, en 2 minutos ya tenía mis diamantes"
            />
          </label>
          <p className="hint" style={{ textAlign: 'right' }}>
            {row.quote.length}/{MAX_QUOTE}
          </p>

          <div className="row">
            <label className="field grow">
              <span>Nombre</span>
              <input
                name="author"
                value={row.author}
                onChange={(e) => update(i, 'author', e.target.value)}
                placeholder="Carlos M."
              />
            </label>
            <label className="field grow">
              <span>Paquete (opcional)</span>
              <input
                name="combo"
                value={row.combo}
                onChange={(e) => update(i, 'combo', e.target.value)}
                placeholder="Pack Insano"
              />
            </label>
          </div>
        </div>
      ))}

      <button
        className="btn"
        type="button"
        onClick={() => setRows((current) => [...current, EMPTY])}
        style={{ marginBottom: 14 }}
      >
        + Agregar otro
      </button>

      {state.issues?.map((issue) => (
        <div className="alert bad" key={issue}>
          {issue}
        </div>
      ))}
      {state.saved && <div className="alert ok">Guardado. Ya se ven en la página de confianza.</div>}

      <div className="row">
        <a className="btn" href="/">
          Cancelar
        </a>
        <div className="spacer" />
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar testimonios'}
        </button>
      </div>
    </form>
  );
}
