'use client';

import { useActionState } from 'react';
import {
  saveAvatar,
  saveDisplayName,
  saveLinkedPlayerId,
  type AvatarFormState,
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
  const [state, action, pending] = useActionState<LinkedIdFormState, FormData>(saveLinkedPlayerId, {});

  return (
    <form action={action}>
      <label className="field">
        <span>ID de Free Fire para el ranking</span>
        <input
          name="playerId"
          inputMode="numeric"
          pattern="\d*"
          defaultValue={playerId}
          required
          disabled={!canChange || pending}
        />
      </label>
      <p className="hint">
        Solo este ID suma al ranking de la temporada. Puedes recargar otros IDs y igual suman al
        Level Pass y La Bóveda.
        {seasonNumber
          ? canChange
            ? ` Puedes cambiarlo una vez en la Temporada ${seasonNumber}.`
            : ` Ya lo cambiaste esta temporada.`
          : ''}
      </p>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">ID actualizado.</div>}

      {canChange && (
        <button className="btn primary" type="submit" disabled={pending}>
          {pending ? 'Guardando…' : 'Cambiar ID'}
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
