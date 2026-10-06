'use client';

import { useActionState } from 'react';
import { saveOffer, type VaultOfferFormState } from './actions';

export function OfferForm({ combos }: { combos: Array<{ id: string; name: string; priceMxnCents: number }> }) {
  const [state, action, pending] = useActionState<VaultOfferFormState, FormData>(saveOffer, {});

  return (
    <form action={action}>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label className="field" style={{ flex: 1, minWidth: 200 }}>
          <span>Combo</span>
          <select name="comboId" required defaultValue="">
            <option value="" disabled>
              Selecciona un combo…
            </option>
            {combos.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} (${(c.priceMxnCents / 100).toFixed(2)} público)
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Precio Bóveda (MXN)</span>
          <input name="vaultPriceMxn" type="number" step="0.01" min="0.01" required />
        </label>
        <label className="field">
          <span>Orden</span>
          <input name="sortOrder" type="number" defaultValue={0} />
        </label>
        <label className="field row" style={{ alignItems: 'center', gap: 8 }}>
          <input type="checkbox" name="active" value="true" defaultChecked />
          <span>Activa</span>
        </label>
      </div>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">Oferta guardada.</div>}

      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Guardando…' : 'Agregar oferta'}
      </button>
    </form>
  );
}
