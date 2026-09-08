'use client';

import { useActionState } from 'react';
import { login, type LoginState } from './actions';

export default function LoginPage() {
  const [state, formAction, pending] = useActionState<LoginState, FormData>(login, {});

  return (
    <main className="login-page">
      <form className="card login-card" action={formAction}>
        <div className="brand" style={{ padding: '0 0 18px' }}>
          LEVELUP STORE
        </div>

        {state.error && <div className="alert bad">{state.error}</div>}

        <div className="field">
          <label htmlFor="email">Correo</label>
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus />
        </div>

        <div className="field">
          <label htmlFor="password">Contraseña</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </div>

        <button className="btn primary" type="submit" disabled={pending} style={{ width: '100%' }}>
          {pending ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
