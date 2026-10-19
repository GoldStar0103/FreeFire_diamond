'use client';

import { useActionState, useState } from 'react';
import {
  checkLinkedPlayerId,
  saveAvatar,
  saveDisplayName,
  saveLinkedPlayerId,
  type AvatarFormState,
  type CheckLinkedIdState,
  type DisplayNameFormState,
  type LinkedIdFormState,
} from '../profile-actions';

export function DisplayNameForm({ initial }: { initial: string }) {
  const [state, action, pending] = useActionState<DisplayNameFormState, FormData>(saveDisplayName, {});

  return (
    <form action={action}>
      <label className="field">
        <span>Nombre de jugador</span>
        <input name="displayName" defaultValue={initial} maxLength={20} required />
      </label>
      <p className="hint">Esto es lo que ven los demás jugadores en el ranking — nunca tu nombre real.</p>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">Guardado.</div>}

      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Guardando…' : 'Guardar nombre'}
      </button>
    </form>
  );
}

export function LinkedIdForm({
  playerId,
  canChange,
  seasonNumber,
}: {
  playerId: string;
  canChange: boolean;
  seasonNumber: number | null;
}) {
  const [checkState, checkAction, checkPending] = useActionState<CheckLinkedIdState, FormData>(
    checkLinkedPlayerId,
    { status: 'idle' },
  );
  const [state, action, pending] = useActionState<LinkedIdFormState, FormData>(saveLinkedPlayerId, {});
  const [identityConfirmed, setIdentityConfirmed] = useState(false);

  const seasonHint = seasonNumber
    ? canChange
      ? ` Puedes cambiarlo una vez en la Temporada ${seasonNumber}.`
      : ` Ya lo cambiaste esta temporada.`
    : '';

  if (!canChange) {
    return (
      <form>
        <label className="field">
          <span>ID de Free Fire para el ranking</span>
          <input name="playerId" defaultValue={playerId} disabled />
        </label>
        <p className="hint">
          Solo este ID suma al ranking de la temporada. Puedes recargar otros IDs y igual suman al
          Level Pass y La Bóveda.{seasonHint}
        </p>
      </form>
    );
  }

  const found = checkState.status === 'found';

  // Confirmed: swap to the real save. saveLinkedPlayerId re-validates
  // independently rather than trusting the nickname shown here — same
  // principle as checkout's own placeOrder.
  if (found && identityConfirmed) {
    return (
      <form action={action}>
        <input type="hidden" name="playerId" value={checkState.playerId} />
        <div className="confirm">
          <div className="confirm-q">Nuevo ID</div>
          <div className="confirm-name">{checkState.nickname}</div>
        </div>
        <p className="hint">
          Solo este ID suma al ranking de la temporada. Puedes recargar otros IDs y igual suman al
          Level Pass y La Bóveda.{seasonHint}
        </p>

        {state.error && <div className="alert bad">{state.error}</div>}
        {state.ok && <div className="alert ok">ID actualizado.</div>}

        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Guardando…' : 'Cambiar ID'}
        </button>
      </form>
    );
  }

  return (
    <form action={checkAction}>
      <label className="field">
        <span>ID de Free Fire para el ranking</span>
        <input
          name="playerId"
          inputMode="numeric"
          pattern="\d*"
          defaultValue={checkState.playerId ?? playerId}
          required
          disabled={checkPending}
        />
      </label>
      <p className="hint">
        Solo este ID suma al ranking de la temporada. Puedes recargar otros IDs y igual suman al
        Level Pass y La Bóveda.{seasonHint}
      </p>

      {checkState.message && <div className="alert bad">{checkState.message}</div>}

      {found ? (
        <div className="confirm">
          <div className="confirm-q">¿Eres tú?</div>
          <div className="confirm-name">{checkState.nickname}</div>
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
        <button className="btn primary" type="submit" disabled={checkPending}>
          {checkPending ? 'Buscando…' : 'Buscar ID'}
        </button>
      )}
    </form>
  );
}

export function AvatarForm() {
  const [state, action, pending] = useActionState<AvatarFormState, FormData>(saveAvatar, {});

  return (
    <form action={action}>
      <label className="field">
        <span>Foto de perfil</span>
        <input type="file" name="avatar" accept="image/jpeg,image/png,image/webp" required />
      </label>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">Foto actualizada.</div>}

      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Subiendo…' : 'Subir foto'}
      </button>
    </form>
  );
}
