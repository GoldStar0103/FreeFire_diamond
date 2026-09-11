'use client';

import { useActionState } from 'react';
import {
  confirmTotpEnrollment,
  disableTotp,
  startTotpEnrollment,
  type TotpConfirmState,
  type TotpDisableState,
  type TotpStartState,
} from './actions';

interface Props {
  /** Whether `totp_secret` is already set for the logged-in admin. */
  enabled: boolean;
}

export function TwoFactorForm({ enabled }: Props) {
  const [startState, startAction, starting] = useActionState<TotpStartState, FormData>(startTotpEnrollment, {});
  const [confirmState, confirmAction, confirming] = useActionState<TotpConfirmState, FormData>(
    confirmTotpEnrollment,
    {},
  );
  const [disableState, disableAction, disabling] = useActionState<TotpDisableState, FormData>(disableTotp, {});

  const isEnabledNow = (enabled && !disableState.disabled) || confirmState.enrolled;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0, fontSize: 16 }}>Verificación en dos pasos</h2>

      {isEnabledNow && !confirmState.enrolled && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            Está activada. Cada inicio de sesión pedirá, además de tu contraseña, un código de tu
            app de autenticación.
          </p>
          <form action={disableAction}>
            <label className="field">
              <span>Confirma tu contraseña para desactivarla</span>
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            {disableState.error && <div className="alert bad">{disableState.error}</div>}
            <div className="row">
              <div className="spacer" />
              <button className="btn" type="submit" disabled={disabling}>
                {disabling ? 'Desactivando…' : 'Desactivar'}
              </button>
            </div>
          </form>
        </>
      )}

      {confirmState.enrolled && (
        <div className="alert ok">
          Activada. La próxima vez que inicies sesión te pedirá un código de tu app de
          autenticación.
        </div>
      )}

      {disableState.disabled && (
        <div className="alert ok">Desactivada. Puedes volver a activarla cuando quieras.</div>
      )}

      {!isEnabledNow && !disableState.disabled && (
        <>
          {!startState.secret && (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                Agrega un código de 6 dígitos, generado por una app en tu teléfono (Google
                Authenticator, Authy, 1Password…), como segundo paso al iniciar sesión.
              </p>
              {startState.error && <div className="alert bad">{startState.error}</div>}
              <form action={startAction}>
                <div className="row">
                  <div className="spacer" />
                  <button className="btn primary" type="submit" disabled={starting}>
                    {starting ? 'Generando…' : 'Activar'}
                  </button>
                </div>
              </form>
            </>
          )}

          {startState.secret && (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                Escanea esta clave en tu app de autenticación, o escríbela manualmente. Tienes 5
                minutos antes de que expire.
              </p>
              <p className="mono" style={{ wordBreak: 'break-all' }}>
                {startState.secret}
              </p>
              <p className="hint" style={{ wordBreak: 'break-all' }}>
                {startState.uri}
              </p>

              <form action={confirmAction}>
                <label className="field" style={{ maxWidth: 180 }}>
                  <span>Código de tu app</span>
                  <input
                    name="code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    className="mono"
                    autoComplete="one-time-code"
                    required
                    autoFocus
                  />
                </label>
                {confirmState.error && <div className="alert bad">{confirmState.error}</div>}
                <div className="row">
                  <div className="spacer" />
                  <button className="btn primary" type="submit" disabled={confirming}>
                    {confirming ? 'Verificando…' : 'Confirmar y activar'}
                  </button>
                </div>
              </form>
            </>
          )}
        </>
      )}
    </div>
  );
}
