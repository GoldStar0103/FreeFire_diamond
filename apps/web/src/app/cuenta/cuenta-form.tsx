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

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M4 7l8 6 8-6" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M2.5 11.2 21 3l-8.2 18.5-2.1-7.2z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

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
      <form className="login" action={requestAction}>
        <label htmlFor="mc-correo">Tu correo</label>
        <div className="campo">
          <MailIcon />
          <input
            id="mc-correo"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="tunombre@correo.com"
            required
            autoFocus
            disabled={requestPending}
          />
        </div>

        {requestState.status === 'error' && <div className="alert bad">{requestState.message}</div>}

        <button className="btn-codigo" type="submit" disabled={requestPending}>
          <SendIcon />
          {requestPending ? 'Enviando…' : 'Enviar código'}
          <ArrowIcon />
        </button>
        <p className="nota">
          Te llega un código al correo. Sin contraseñas: nunca te pedimos tus datos de Free Fire.
        </p>
      </form>
    );
  }

  if (step === 'verify') {
    return (
      <form className="login" action={verifyAction}>
        <input type="hidden" name="email" value={email} />
        <p className="nota" style={{ marginTop: 0, marginBottom: 10, textAlign: 'left' }}>
          Te mandamos un código de 6 dígitos a {email}.
        </p>

        <label htmlFor="mc-codigo">Código</label>
        <div className="campo">
          <input
            id="mc-codigo"
            name="code"
            className="mono"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            required
            autoFocus
            disabled={verifyPending}
            style={{ paddingLeft: 14 }}
          />
        </div>

        {verifyState.status === 'error' && <div className="alert bad">{verifyState.message}</div>}

        <button className="btn-codigo" type="submit" disabled={verifyPending}>
          {verifyPending ? 'Verificando…' : 'Entrar'}
          <ArrowIcon />
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
        <form className="login" action={signupAction}>
          <input type="hidden" name="playerId" value={checkState.playerId} />
          <div className="confirm">
            <div className="confirm-q">Tu cuenta</div>
            <div className="confirm-name">{checkState.nickname ?? 'Cuenta verificada'}</div>
          </div>
          <p className="nota" style={{ textAlign: 'left', marginTop: 10 }}>
            Este ID es el que cuenta para el ranking. Puedes recargar otros IDs con la misma cuenta:
            igual suman al Level Pass y La Bóveda. Solo puedes cambiarlo una vez por temporada.
          </p>

          {signupState.status === 'error' && <div className="alert bad">{signupState.message}</div>}

          <button className="btn-codigo" type="submit" disabled={signupPending}>
            {signupPending ? 'Creando cuenta…' : 'Crear mi cuenta'}
            <ArrowIcon />
          </button>
        </form>
      );
    }

    return (
      <form className="login" action={checkAction}>
        <p className="nota" style={{ textAlign: 'left', marginTop: 0, marginBottom: 10 }}>
          Este ID es el que cuenta para el ranking. Puedes recargar otros IDs con la misma cuenta:
          igual suman al Level Pass y La Bóveda. Solo puedes cambiarlo una vez por temporada.
        </p>

        <label htmlFor="mc-playerid">ID de Free Fire para el ranking</label>
        <div className="campo">
          <input
            id="mc-playerid"
            name="playerId"
            inputMode="numeric"
            pattern="\d*"
            placeholder="123456789"
            defaultValue={checkState.playerId ?? ''}
            required
            autoFocus
            disabled={checkPending}
            style={{ paddingLeft: 14 }}
          />
        </div>

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
          <button className="btn-codigo" type="submit" disabled={checkPending}>
            {checkPending ? 'Buscando…' : 'Buscar mi cuenta'}
            <ArrowIcon />
          </button>
        )}
      </form>
    );
  }

  return null;
}
