'use client';

import { useActionState } from 'react';
import { saveCampaign, type CampaignFormState } from '../../actions';

interface Props {
  isNew: boolean;
  initial: {
    key: string;
    name: string;
    badge: string;
    permanent: boolean;
    active: boolean;
    startsAt: string;
    endsAt: string;
    sortOrder: number;
    hasFlyer: boolean;
  };
}

export function CampaignForm({ isNew, initial }: Props) {
  const [state, action, saving] = useActionState<CampaignFormState, FormData>(saveCampaign, {});

  return (
    <form action={action}>
      <input type="hidden" name="sortOrder" value={initial.sortOrder} />

      <div className="card">
        <div className="row">
          <label className="field grow">
            <span>Nombre</span>
            <input name="name" defaultValue={initial.name} placeholder="SUPER PACKS" required />
          </label>
          <label className="field">
            <span>Clave</span>
            <input
              name="key"
              defaultValue={initial.key}
              placeholder="super_packs"
              readOnly={!isNew}
              className="mono"
              required
            />
          </label>
        </div>

        <label className="field">
          <span>Etiqueta (opcional)</span>
          <input name="badge" defaultValue={initial.badge} placeholder="MÁS POPULAR" />
        </label>

        <div className="row">
          <label className="field">
            <span>Empieza (opcional)</span>
            <input type="date" name="startsAt" defaultValue={initial.startsAt} />
          </label>
          <label className="field">
            <span>Termina (opcional)</span>
            <input type="date" name="endsAt" defaultValue={initial.endsAt} />
          </label>
        </div>
        <p className="hint">
          Al pasar la fecha de fin, la promoción y sus combos dejan de aparecer solos.
        </p>
      </div>

      <div className="card">
        <label className="field">
          <span>Flyer</span>
          <input type="file" name="flyer" accept="image/jpeg,image/png,image/webp" />
        </label>
        <p className="hint">
          {initial.hasFlyer
            ? 'Ya hay un flyer cargado. Si no subes otro, se queda el actual.'
            : 'Sube la imagen que publicas en redes. JPG, PNG o WEBP.'}
        </p>
      </div>

      <div className="card">
        <label className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input
            type="checkbox"
            name="permanent"
            value="true"
            defaultChecked={initial.permanent}
            style={{ width: 'auto' }}
          />
          <span>
            Permanente
            {/* The $10 offer is the entry hook and must lead the page. */}
            <span className="hint"> — aparece primero y no entra en la rotación mensual</span>
          </span>
        </label>

        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            name="active"
            value="true"
            defaultChecked={initial.active}
            style={{ width: 'auto' }}
          />
          <span>Visible en la tienda</span>
        </label>
      </div>

      {state.errors?.map((e) => (
        <div className="alert bad" key={e.code}>
          {e.message}
        </div>
      ))}
      {state.error && <div className="alert bad">{state.error}</div>}

      <div className="row">
        <a className="btn" href="/combos">
          Cancelar
        </a>
        <div className="spacer" />
        <button className="btn primary" type="submit" disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar promoción'}
        </button>
      </div>
    </form>
  );
}
