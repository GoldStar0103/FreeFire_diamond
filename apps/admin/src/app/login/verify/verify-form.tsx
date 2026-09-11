'use client';

import { useActionState } from 'react';
import { verifyLoginTotp, type VerifyTotpState } from './actions';

export function VerifyForm() {
  const [state, formAction, pending] = useActionState<VerifyTotpState, FormData>(verifyLoginTotp, {});

  return (
    <form action={formAction}>
      {state.error && <div className="alert bad">{state.error}</div>}

      <div className="field">
        <label htmlFor="code">Código</label>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          autoComplete="one-time-code"
          className="mono"
          required
          autoFocus
        />
      </div>

      <button className="btn primary" type="submit" disabled={pending} style={{ width: '100%' }}>
        {pending ? 'Verificando…' : 'Entrar'}
      </button>
    </form>
  );
}
