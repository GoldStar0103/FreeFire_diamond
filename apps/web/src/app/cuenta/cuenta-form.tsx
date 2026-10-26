'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  checkPlayerId,
  completeSignup,
  requestOtp,
  verifyOtp,
  type CheckPlayerIdState,
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
  const [checkState, checkAction, checkPending] = useActionState<CheckPlayerIdState, FormData>(
    checkPlayerId,
    { status: 'idle' },
  );
  const [signupState, signupAction, signupPending] = useActionState<CompleteSignupState, FormData>(
    completeSignup,
    { status: 'idle' },
  );

  const [step, setStep] = useState<Step>('request');
  const [email, setEmail] = useState('');
  const [identityConfirmed, setIdentityConfirmed] = useState(false);

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
    const found = checkState.status === 'found';

    // Confirmed: swap to the real create-account submit. The hidden field
    // carries the id forward, but completeSignup re-validates independently
    // rather than trusting it — same principle as checkout's own placeOrder.
    if (found && identityConfirmed) {
      return (
        <form className="card" action={signupAction}>
          <input type="hidden" name="playerId" value={checkState.playerId} />
          <div className="confirm">
            <div className="confirm-q">Tu cuenta</div>
            <div className="confirm-name">{checkState.nickname ?? 'Cuenta verificada'}</div>
          </div>
          <p className="hint">
            Este ID es el que cuenta para el ranking. Puedes recargar otros IDs con la misma cuenta:
            igual suman al Level Pass y La Bóveda. Solo puedes cambiarlo una vez por temporada.
          </p>

          {signupState.status === 'error' && <div className="alert bad">{signupState.message}</div>}

          <button className="btn primary wide" type="submit" disabled={signupPending}>
            {signupPending ? 'Creando cuenta…' : 'Crear mi cuenta'}
          </button>
        </form>
      );
    }

    return (
      <form className="card" action={checkAction}>
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
            defaultValue={checkState.playerId ?? ''}
            required
            autoFocus
            disabled={checkPending}
          />
        </label>

        {checkState.message && <div className="alert bad">{checkState.message}</div>}

        {found ? (
          <div className="confirm">
            <div className="confirm-q">¿Eres tú?</div>
            <div className="confirm-name">{checkState.nickname ?? 'Cuenta verificada'}</div>
            <div className="row">
              <button type="submit" className="btn ghost" disabled={checkPending}>
                No, cambiar ID
              </button>
              <button type="button" className="btn primary" onClick={() => setIdentityConfirmed(true)}>
                Sí, soy yo
              </button>
            </div>
          </div>
        ) : (
          <button className="btn primary wide" type="submit" disabled={checkPending}>
            {checkPending ? 'Buscando…' : 'Buscar mi cuenta'}
          </button>
        )}
      </form>
    );
  }

  return null;
}
