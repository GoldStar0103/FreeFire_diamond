'use client';

import { useActionState } from 'react';
import { lookupOrder, type LookupState } from './actions';

export function LookupForm() {
  const [state, action, pending] = useActionState<LookupState, FormData>(lookupOrder, {});

  return (
    <form className="card" action={action}>
      <label className="field">
        <span>Número de pedido</span>
        <input
          name="orderNumber"
          placeholder="LU-260915-AB12"
          className="mono"
          required
          autoFocus
          autoCapitalize="characters"
          disabled={pending}
        />
      </label>

      <label className="field">
        <span>Tu ID de Free Fire</span>
        <input
          name="playerId"
          inputMode="numeric"
          pattern="\d*"
          placeholder="123456789"
          required
          disabled={pending}
        />
      </label>

      {state.error && <div className="alert bad">{state.error}</div>}

      <button className="btn primary wide" type="submit" disabled={pending}>
        {pending ? 'Buscando…' : 'Ver mi pedido'}
      </button>
    </form>
  );
}
