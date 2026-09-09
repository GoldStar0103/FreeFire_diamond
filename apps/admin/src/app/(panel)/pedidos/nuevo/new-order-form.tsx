'use client';

import { useActionState, useState } from 'react';
import {
  createManualOrder,
  lookupPlayer,
  type CreateState,
  type LookupState,
} from './actions';

export interface ComboOption {
  key: string;
  label: string;
  price: string;
  campaignName: string;
  active: boolean;
}

export function NewOrderForm({ combos }: { combos: ComboOption[] }) {
  const [lookup, lookupAction, looking] = useActionState<LookupState, FormData>(lookupPlayer, {
    status: 'idle',
  });
  const [create, createAction, creating] = useActionState<CreateState, FormData>(
    createManualOrder,
    {},
  );
  const [confirmed, setConfirmed] = useState(false);

  const found = lookup.status === 'found';

  return (
    <>
      <div className="card">
        <div className="step-head">
          <span className="step-num">1</span>
          <h2>Cuenta del cliente</h2>
        </div>

        {!confirmed ? (
          <form action={lookupAction}>
            <div className="row">
              <input
                name="playerId"
                placeholder="ID de Free Fire"
                inputMode="numeric"
                defaultValue={lookup.playerId ?? ''}
                required
                autoFocus
                disabled={looking}
                style={{ maxWidth: 240 }}
              />
              <button className="btn" type="submit" disabled={looking}>
                {looking ? 'Buscando…' : 'Buscar'}
              </button>
            </div>

            {lookup.message && (
              <div className={lookup.status === 'error' ? 'alert bad' : 'alert warn'}>
                {lookup.message}
              </div>
            )}

            {found && (
              <div className="alert ok">
                <div className="row">
                  <div>
                    Cuenta encontrada: <strong>{lookup.nickname}</strong>
                  </div>
                  <div className="spacer" />
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => setConfirmed(true)}
                  >
                    Es correcta
                  </button>
                </div>
              </div>
            )}
          </form>
        ) : (
          <div className="row">
            <div>
              <strong>{lookup.nickname}</strong>
              <div className="mono" style={{ color: 'var(--muted)', fontSize: 13 }}>
                ID {lookup.playerId}
              </div>
            </div>
            <div className="spacer" />
            <button type="button" className="btn sm" onClick={() => setConfirmed(false)}>
              Cambiar
            </button>
          </div>
        )}
      </div>

      <div className={confirmed ? 'card' : 'card step disabled'}>
        <div className="step-head">
          <span className="step-num">2</span>
          <h2>Pedido</h2>
        </div>

        {!confirmed ? (
          <p className="hint">Primero confirma la cuenta del cliente.</p>
        ) : (
          <form action={createAction}>
            <input type="hidden" name="playerId" value={lookup.playerId ?? ''} />

            <label className="field">
              <span>Combo</span>
              <select name="comboKey" required defaultValue="">
                <option value="" disabled>
                  Elige un combo…
                </option>
                {combos.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.campaignName} — {c.label} · {c.price}
                    {!c.active ? ' (apagado)' : ''}
                  </option>
                ))}
              </select>
              <span className="hint">
                Puedes usar combos apagados: sirve para honrar una promoción que ya retiraste.
              </span>
            </label>

            <div className="row">
              <label className="field grow">
                <span>WhatsApp del cliente (opcional)</span>
                <input name="whatsapp" type="tel" placeholder="52 220 616 1171" />
              </label>
              <label className="field grow">
                <span>Referencia del pago (opcional)</span>
                <input name="reference" placeholder="Folio del depósito o transferencia" />
              </label>
            </div>

            <label className="row" style={{ gap: 8, marginBottom: 12 }}>
              <input
                type="checkbox"
                name="markPaid"
                value="true"
                defaultChecked
                style={{ width: 'auto' }}
              />
              <span>
                Ya me pagó — recargar de inmediato
                <span className="hint">
                  {' '}
                  Si lo dejas sin marcar, el pedido queda esperando en Aprobaciones.
                </span>
              </span>
            </label>

            {create.error && <div className="alert bad">{create.error}</div>}

            <button className="btn primary" type="submit" disabled={creating}>
              {creating ? 'Creando…' : 'Crear pedido'}
            </button>
          </form>
        )}
      </div>
    </>
  );
}
