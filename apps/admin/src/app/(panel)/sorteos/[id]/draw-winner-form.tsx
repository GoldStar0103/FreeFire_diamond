'use client';

import { useActionState } from 'react';
import { drawWinnersAction, type DrawWinnerState } from '../actions';

interface Props {
  giveawayId: string;
  winnerCount: number;
}

/** Only rendered while `status === 'closed_pending_draw'` — see the detail page. */
export function DrawWinnerForm({ giveawayId, winnerCount }: Props) {
  const [state, action, pending] = useActionState<DrawWinnerState, FormData>(drawWinnersAction, {});

  if (state.ok) return <div className="alert ok">{state.ok}</div>;

  return (
    <form action={action}>
      <input type="hidden" name="id" value={giveawayId} />
      <p className="hint">
        Elige {winnerCount === 1 ? 'un ganador' : `${winnerCount} ganadores distintos`} al azar entre
        todas las entradas, con más chances para quien compró más entradas. Esto no se puede
        deshacer.
      </p>
      {state.error && <div className="alert bad">{state.error}</div>}
      <button className="btn primary" type="submit" disabled={pending}>
        {pending ? 'Sorteando…' : 'Sortear ganador'}
      </button>
    </form>
  );
}
