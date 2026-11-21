'use server';

import { revalidatePath } from 'next/cache';
import { DrizzleGiveawayEntryStore, getMyEntry } from '@levelup/db';
import { enterGiveaway, type EnterGiveawayFailure } from '@levelup/engine';
import { getDb } from '../../../lib/server';
import { requireCustomerSession } from '../../../lib/customer-session';
import { verifyPlayerId } from '../../../lib/player-validation';

export interface EnterGiveawayState {
  error?: string;
  ok?: { entryCount: number; resultingBalance: number };
}

function explain(failure: EnterGiveawayFailure): string {
  switch (failure.code) {
    case 'GIVEAWAY_NOT_FOUND':
    case 'GIVEAWAY_CLOSED':
      return 'Este sorteo ya no está abierto para participar.';
    case 'INVALID_ENTRY_COUNT':
      return 'La cantidad de entradas no es válida.';
    case 'INSUFFICIENT_TICKETS':
      return `No tienes suficientes tickets — te faltan ${failure.cost - failure.balance}.`;
    case 'MAX_ENTRIES_PER_PLAYER_EXCEEDED':
      return 'Ya alcanzaste el máximo de entradas por jugador para este sorteo.';
    case 'GIVEAWAY_FULL':
      return 'Este sorteo ya alcanzó su máximo de participantes.';
    default:
      return 'No pudimos registrar tu entrada. Intenta de nuevo.';
  }
}

/**
 * Ticket balance is tied to the logged-in account, so this requires a real
 * session — no guest path. The client asked for Free Fire ID verification on
 * entry so a prize is delivered to an ID the winner actually proved was
 * theirs — the ID is verified once, on a player's first entry into a given
 * giveaway (same provider lookup checkout uses), then locked in at the store
 * layer (`spendTicketsForEntry`'s COALESCE); every later entry just reuses
 * it, so this never has to re-call the provider or the rate limiter for a
 * player who already verified.
 */
export async function enterGiveawayAction(
  _prev: EnterGiveawayState,
  formData: FormData,
): Promise<EnterGiveawayState> {
  const session = await requireCustomerSession();
  const giveawayId = String(formData.get('giveawayId') ?? '');
  const entryCount = Number(formData.get('entryCount') ?? 1);

  const existing = await getMyEntry(getDb(), giveawayId, session.playerProfileId);
  let freeFireId = existing?.freeFireId ?? null;
  let freeFireNickname = existing?.freeFireNickname ?? null;

  if (!freeFireId) {
    const submittedId = String(formData.get('freeFireId') ?? '').trim();
    if (!submittedId) return { error: 'Escribe tu ID de Free Fire para participar.' };

    const verification = await verifyPlayerId(submittedId);
    if (!verification.ok) return { error: verification.message };

    freeFireId = submittedId;
    freeFireNickname = verification.nickname;
  }

  const result = await enterGiveaway(
    { store: new DrizzleGiveawayEntryStore(getDb()) },
    { giveawayId, playerProfileId: session.playerProfileId, entryCount, freeFireId, freeFireNickname },
  );

  if (!result.ok) return { error: explain(result.failure) };

  revalidatePath(`/sorteos/${giveawayId}`);
  revalidatePath('/sorteos');

  return { ok: { entryCount: result.entryCount, resultingBalance: result.resultingBalance } };
}
