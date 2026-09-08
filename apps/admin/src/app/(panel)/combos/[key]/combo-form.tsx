'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import type { ComboDraft } from '@levelup/engine';
import { previewCombo, saveCombo, type ComboFormState } from '../actions';

interface Props {
  draft: ComboDraft;
  campaignKey: string;
  campaigns: Array<{ key: string; name: string }>;
  /** Denominations the provider currently sells, with their delivered amount. */
  available: Array<{ diamondsBase: number; delivered: number; active: boolean }>;
  isNew: boolean;
}

const peso = (cents: number) => (cents / 100).toFixed(2);
const num = (n: number) => n.toLocaleString('es-MX');

export function ComboForm({ draft, campaignKey, campaigns, available, isNew }: Props) {
  const [recipe, setRecipe] = useState<number[]>(draft.recipe);
  const [advertised, setAdvertised] = useState(draft.advertisedDiamonds);
  const [price, setPrice] = useState(peso(draft.priceMxnCents));

  const [preview, previewAction] = useActionState<ComboFormState, FormData>(previewCombo, {});
  const [saved, saveAction, saving] = useActionState<ComboFormState, FormData>(saveCombo, {});

  const formRef = useRef<HTMLFormElement>(null);

  // Re-check on every change. Margin needs live provider costs, so this has to
  // round-trip to the server rather than being computed in the browser.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!formRef.current) return;
      previewAction(new FormData(formRef.current));
    }, 350);
    return () => clearTimeout(timer);
  }, [recipe, advertised, price, previewAction]);

  const review = saved.review ?? preview.review;
  const delivered = review?.delivered ?? 0;
  const gap = review?.gap ?? 0;

  const add = (d: number) => setRecipe((r) => [...r, d]);
  const removeAt = (i: number) => setRecipe((r) => r.filter((_, idx) => idx !== i));

  return (
    <form ref={formRef} action={saveAction}>
      <input type="hidden" name="recipe" value={recipe.join(',')} />

      <div className="card">
        <div className="row">
          <label className="field grow">
            <span>Nombre</span>
            <input name="name" defaultValue={draft.name} required />
          </label>
          <label className="field">
            <span>Clave</span>
            <input
              name="key"
              defaultValue={draft.key}
              readOnly={!isNew}
              required
              className="mono"
            />
          </label>
        </div>

        <div className="row">
          <label className="field">
            <span>Promoción</span>
            <select name="campaignKey" defaultValue={campaignKey}>
              {campaigns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Precio MXN</span>
            <input
              name="priceMxn"
              type="number"
              step="1"
              min="0"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              required
            />
          </label>
          <label className="field">
            <span>Diamantes del flyer</span>
            <input
              name="advertisedDiamonds"
              type="number"
              min="0"
              value={advertised}
              onChange={(e) => setAdvertised(Number(e.target.value) || 0)}
              required
            />
          </label>
          <label className="field">
            <span>Máx. por jugador</span>
            <input
              name="maxPerPlayer"
              type="number"
              min="1"
              defaultValue={draft.maxPerPlayer ?? ''}
              placeholder="sin límite"
            />
          </label>
        </div>
      </div>

      <h2>Receta</h2>
      <p className="subtitle">
        Las recargas que hacemos al proveedor, en orden. El cliente nunca ve esto.
      </p>

      <div className="card">
        <div className="row">
          {available.map((p) => (
            <button
              key={p.diamondsBase}
              type="button"
              className="btn sm"
              onClick={() => add(p.diamondsBase)}
              disabled={!p.active}
              title={p.active ? `Entrega ${num(p.delivered)} 💎` : 'No disponible'}
            >
              + {num(p.diamondsBase)}
            </button>
          ))}
        </div>

        {recipe.length === 0 ? (
          <p className="hint">Agrega al menos una recarga.</p>
        ) : (
          <ol className="recipe">
            {recipe.map((d, i) => (
              <li key={`${d}-${i}`}>
                <span>
                  {num(d)} 💎 <span className="hint">+10% bono</span>
                </span>
                <button type="button" className="btn sm danger" onClick={() => removeAt(i)}>
                  Quitar
                </button>
              </li>
            ))}
          </ol>
        )}

        {review && (
          <div className="review">
            <div className="review-row">
              <span>Entrega</span>
              <strong>{num(delivered)} 💎</strong>
            </div>
            <div className="review-row">
              <span>Diferencia contra el flyer</span>
              <strong className={gap < 0 ? 'bad' : 'ok'}>
                {gap > 0 ? '+' : ''}
                {num(gap)}
              </strong>
            </div>
            <div className="review-row">
              <span>Llamadas al proveedor</span>
              <strong>{review.callCount}</strong>
            </div>
            <div className="review-row">
              <span>Costo</span>
              <strong>
                {review.costMxnCents === null ? '—' : `$${peso(review.costMxnCents)}`}
              </strong>
            </div>
            <div className="review-row">
              <span>Ganancia</span>
              <strong className={(review.marginMxnCents ?? 0) < 0 ? 'bad' : 'ok'}>
                {review.marginMxnCents === null
                  ? '—'
                  : `$${peso(review.marginMxnCents)} (${review.marginPct?.toFixed(1)}%)`}
              </strong>
            </div>
          </div>
        )}
      </div>

      {review?.errors.map((e) => (
        <div className="alert bad" key={e.code}>
          {e.message}
        </div>
      ))}
      {review?.warnings.map((w) => (
        <div className="alert warn" key={w.code}>
          {w.message}
        </div>
      ))}
      {saved.error && <div className="alert bad">{saved.error}</div>}

      <div className="card">
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            name="active"
            value="true"
            defaultChecked={draft.active}
            style={{ width: 'auto' }}
          />
          <span>
            Poner a la venta
            {review && !review.canActivate && (
              <span className="hint"> — corrige los errores primero</span>
            )}
          </span>
        </label>

        <div className="row" style={{ marginTop: 14 }}>
          <a className="btn" href="/combos">
            Cancelar
          </a>
          <div className="spacer" />
          <button className="btn primary" type="submit" disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
        <p className="hint">
          Siempre puedes guardarlo apagado como borrador, aunque tenga errores.
        </p>
      </div>
    </form>
  );
}
