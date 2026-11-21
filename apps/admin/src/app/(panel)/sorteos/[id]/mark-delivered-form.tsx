'use client';

import { useActionState } from 'react';
import { markWinnerDeliveredAction, type MarkDeliveredState } from '../actions';

interface Props {
  giveawayId: string;
  winnerId: string;
}

/** One button per pending winner of a `prizeType = 'manual'` giveaway — see the detail page. */
export function MarkDeliveredForm({ giveawayId, winnerId }: Props) {
  const [state, action, pending] = useActionState<MarkDeliveredState, FormData>(markWinnerDeliveredAction, {});

  if (state.ok) return <span className="badge ok">{state.ok}</span>;

  return (
    <form action={action}>
      <input type="hidden" name="giveawayId" value={giveawayId} />
      <input type="hidden" name="winnerId" value={winnerId} />
      {state.error && <div className="alert bad">{state.error}</div>}
      <button className="btn primary sm" type="submit" disabled={pending}>
        {pending ? 'Guardando…' : 'Marcar entregado'}
      </button>
    </form>
  );
}
