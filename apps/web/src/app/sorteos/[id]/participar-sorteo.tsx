'use client';

import { useActionState, useState } from 'react';
import { enterGiveawayAction, type EnterGiveawayState } from './actions';

interface Props {
  giveawayId: string;
  entryCostTickets: number;
  ticketBalance: number;
  myEntryCount: number;
}

/**
 * One step, not a stepper — unlike buying an item, entering a giveaway needs
 * no delivery details or payment: tickets are already sitting on the
 * player's own account, so this is just "how many entries" + submit.
 */
export function ParticiparSorteo({ giveawayId, entryCostTickets, ticketBalance, myEntryCount }: Props) {
  const [state, action, pending] = useActionState<EnterGiveawayState, FormData>(enterGiveawayAction, {});
  const maxAffordable = Math.max(0, Math.floor((state.ok ? state.ok.resultingBalance : ticketBalance) / entryCostTickets));
  const [entryCount, setEntryCount] = useState(Math.min(1, maxAffordable || 1));

  const currentBalance = state.ok ? state.ok.resultingBalance : ticketBalance;
  const currentEntries = state.ok ? myEntryCount + state.ok.entryCount : myEntryCount;
  const cost = entryCount * entryCostTickets;
  const canAfford = maxAffordable >= 1 && entryCount >= 1 && cost <= currentBalance;

  return (
    <div className="card" style={{ marginTop: 14 }}>
      {currentEntries > 0 && (
        <p className="hint" style={{ marginTop: 0 }}>
          Ya tienes <b>{currentEntries}</b> entrada{currentEntries === 1 ? '' : 's'} en este sorteo.
        </p>
      )}

      {state.ok && (
        <div className="alert ok">
          ¡Listo! Ahora tienes {currentEntries} entrada{currentEntries === 1 ? '' : 's'}. Te quedan{' '}
          {currentBalance} tickets.
        </div>
      )}

      {maxAffordable < 1 ? (
        <div className="alert warn">
          Necesitas al menos {entryCostTickets} ticket{entryCostTickets === 1 ? '' : 's'} para participar —
          tienes {currentBalance}.
        </div>
      ) : (
        <form action={action}>
          <input type="hidden" name="giveawayId" value={giveawayId} />
          <label className="field">
            <span>Cantidad de entradas ({entryCostTickets} ticket{entryCostTickets === 1 ? '' : 's'} cada una)</span>
            <input
              type="number"
              name="entryCount"
              min={1}
              max={maxAffordable}
              value={entryCount}
              onChange={(e) => setEntryCount(Math.max(1, Math.min(maxAffordable, Number(e.target.value) || 1)))}
            />
          </label>
          <p className="hint">
            Costo total: <b>{cost}</b> tickets. Te quedan {Math.max(0, currentBalance - cost)} después.
          </p>

          {state.error && <div className="alert bad">{state.error}</div>}

          <button className="btn-primary" type="submit" disabled={pending || !canAfford}>
            {pending ? 'Participando…' : `Participar — ${cost} tickets`}
          </button>
        </form>
      )}
    </div>
  );
}
