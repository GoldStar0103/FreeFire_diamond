'use client';

import { useActionState } from 'react';
import { saveBadge, type BadgeFormState } from './actions';

export interface BadgeFormInitial {
  badgeKey: string;
  title: string;
  description: string | null;
  category: string;
  rarity: string;
  artworkAssetUrl: string | null;
  seasonScoped: boolean;
  eligibilityStartsAt: Date | null;
  eligibilityEndsAt: Date | null;
  obtainable: boolean;
}

const toInputDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

export function BadgeForm({ initial, locked }: { initial?: BadgeFormInitial; locked?: boolean }) {
  const [state, action, pending] = useActionState<BadgeFormState, FormData>(saveBadge, {});

  return (
    <form action={action}>
      <label className="field">
        <span>Clave interna (no cambia después)</span>
        <input name="badgeKey" defaultValue={initial?.badgeKey} required disabled={locked} className="mono" />
      </label>

      <label className="field">
        <span>Título</span>
        <input name="title" defaultValue={initial?.title} required />
      </label>

      <label className="field">
        <span>Descripción</span>
        <textarea name="description" defaultValue={initial?.description ?? ''} rows={2} />
      </label>

      <div className="row" style={{ gap: 12 }}>
        <label className="field">
          <span>Categoría</span>
          <select name="category" defaultValue={initial?.category ?? 'special'}>
            <option value="ranking">Ranking</option>
            <option value="level_pass">Level Pass</option>
            <option value="special">Especial</option>
            <option value="event">Evento</option>
          </select>
        </label>
        <label className="field">
          <span>Rareza</span>
          <select name="rarity" defaultValue={initial?.rarity ?? 'common'}>
            <option value="common">Común</option>
            <option value="rare">Rara</option>
            <option value="epic">Épica</option>
            <option value="legendary">Legendaria</option>
            <option value="exclusive">Exclusiva</option>
          </select>
        </label>
      </div>

      <label className="field">
        <span>Subir imagen</span>
        <input type="file" name="artworkFile" accept="image/jpeg,image/png,image/webp" />
      </label>
      <label className="field">
        <span>…o pegar una URL</span>
        <input name="artworkAssetUrl" defaultValue={initial?.artworkAssetUrl ?? ''} />
        <span className="hint">Si subes un archivo, se usa ese y se ignora la URL.</span>
      </label>

      <label className="field row" style={{ alignItems: 'center', gap: 8 }}>
        <input type="checkbox" name="seasonScoped" value="true" defaultChecked={initial?.seasonScoped ?? false} />
        <span>Es por temporada (ej. "Top 10 — Temporada 7" en vez de una insignia permanente única)</span>
      </label>

      <div className="row" style={{ gap: 12 }}>
        <label className="field">
          <span>Disponible desde (opcional)</span>
          <input type="date" name="eligibilityStartsAt" defaultValue={toInputDate(initial?.eligibilityStartsAt ?? null)} />
        </label>
        <label className="field">
          <span>Disponible hasta (opcional)</span>
          <input type="date" name="eligibilityEndsAt" defaultValue={toInputDate(initial?.eligibilityEndsAt ?? null)} />
        </label>
      </div>
      <p className="hint">Para Founder: deja ambas fechas iguales a la ventana de lanzamiento que quieras.</p>

      <label className="field row" style={{ alignItems: 'center', gap: 8 }}>
        <input type="checkbox" name="obtainable" value="true" defaultChecked={initial?.obtainable ?? true} />
        <span>Se puede obtener actualmente</span>
      </label>

      {state.error && <div className="alert bad">{state.error}</div>}

      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Guardando…' : 'Guardar insignia'}
      </button>
    </form>
  );
}
