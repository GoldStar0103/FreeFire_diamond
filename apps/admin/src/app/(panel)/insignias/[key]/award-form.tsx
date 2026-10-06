'use client';

import { useActionState } from 'react';
import { awardBadge, type AwardFormState } from '../actions';

export function AwardForm({ badgeKey, seasonScoped }: { badgeKey: string; seasonScoped: boolean }) {
  const [state, action, pending] = useActionState<AwardFormState, FormData>(awardBadge, {});

  return (
    <form action={action}>
      <input type="hidden" name="badgeKey" value={badgeKey} />
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label className="field">
          <span>ID de Free Fire</span>
          <input name="playerId" inputMode="numeric" pattern="\d*" required />
        </label>
        {seasonScoped && (
          <label className="field">
            <span>Temporada</span>
            <input name="seasonNumber" type="number" min={1} required />
          </label>
        )}
        <label className="field" style={{ flex: 1, minWidth: 200 }}>
          <span>Motivo (queda en el registro)</span>
          <input name="reason" required />
        </label>
      </div>

      {state.error && <div className="alert bad">{state.error}</div>}
      {state.ok && <div className="alert ok">Insignia otorgada.</div>}

      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Otorgando…' : 'Otorgar manualmente'}
      </button>
    </form>
  );
}
