'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  completeSignup,
  requestOtp,
  verifyOtp,
  type CompleteSignupState,
  type RequestOtpState,
  type VerifyOtpState,
} from './actions';

type Step = 'request' | 'verify' | 'signup' | 'done';

export function CuentaForm() {
  const [requestState, requestAction, requestPending] = useActionState<RequestOtpState, FormData>(
    requestOtp,
    { status: 'idle' },
  );
  const [verifyState, verifyAction, verifyPending] = useActionState<VerifyOtpState, FormData>(verifyOtp, {
    status: 'idle',
  });
  const [signupState, signupAction, signupPending] = useActionState<CompleteSignupState, FormData>(
    completeSignup,
    { status: 'idle' },
  );

  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (requestState.status === 'sent' && requestState.email) {
      setEmail(requestState.email);
      setStep('verify');
    }
  }, [requestState]);

  useEffect(() => {
    if (verifyState.status === 'logged_in') {
      window.location.href = '/cuenta';
    } else if (verifyState.status === 'need_player_id') {
      setStep('signup');
    }
  }, [verifyState]);

  useEffect(() => {
    if (signupState.status === 'done') {
      window.location.href = '/cuenta';
    }
  }, [signupState]);

  if (step === 'request') {
    return (
      <form className="card" action={requestAction}>
        <label className="field">
          <span>Tu correo</span>
          <input
            name="email"
            type="email"
            autoComplete="email"
            placeholder="tunombre@correo.com"
            required
            autoFocus
            disabled={requestPending}
          />
        </label>

        {requestState.status === 'error' && <div className="alert bad">{requestState.message}</div>}

        <button className="btn primary wide" type="submit" disabled={requestPending}>
          {requestPending ? 'Enviando…' : 'Enviar código'}
        </button>
      </form>
    );
  }

  if (step === 'verify') {
    return (
      <form className="card" action={verifyAction}>
        <input type="hidden" name="email" value={email} />
        <p className="hint">Te mandamos un código de 6 dígitos a {email}.</p>

        <label className="field">
          <span>Código</span>
          <input
            name="code"
            className="mono"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            required
            autoFocus
            disabled={verifyPending}
          />
        </label>

        {verifyState.status === 'error' && <div className="alert bad">{verifyState.message}</div>}

        <button className="btn primary wide" type="submit" disabled={verifyPending}>
          {verifyPending ? 'Verificando…' : 'Entrar'}
        </button>
      </form>
    );
  }

  if (step === 'signup') {
    return (
      <form className="card" action={signupAction}>
        <p className="hint">
          Este ID es el que cuenta para el ranking. Puedes recargar otros IDs con la misma cuenta:
          igual suman al Level Pass y La Bóveda. Solo puedes cambiarlo una vez por temporada.
        </p>

        <label className="field">
          <span>ID de Free Fire para el ranking</span>
          <input
            name="playerId"
            inputMode="numeric"
            pattern="\d*"
            placeholder="123456789"
            required
            autoFocus
            disabled={signupPending}
          />
        </label>

        {signupState.status === 'error' && <div className="alert bad">{signupState.message}</div>}

        <button className="btn primary wide" type="submit" disabled={signupPending}>
          {signupPending ? 'Creando cuenta…' : 'Crear mi cuenta'}
        </button>
      </form>
    );
  }

  return null;
}
