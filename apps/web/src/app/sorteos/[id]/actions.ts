'use server';

import { revalidatePath } from 'next/cache';
import { DrizzleGiveawayEntryStore } from '@levelup/db';
import { enterGiveaway, type EnterGiveawayFailure } from '@levelup/engine';
import { getDb } from '../../../lib/server';
import { requireCustomerSession } from '../../../lib/customer-session';

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

/** Ticket balance is tied to the logged-in account, so this requires a real session — no guest path. */
export async function enterGiveawayAction(
  _prev: EnterGiveawayState,
  formData: FormData,
): Promise<EnterGiveawayState> {
  const session = await requireCustomerSession();
  const giveawayId = String(formData.get('giveawayId') ?? '');
  const entryCount = Number(formData.get('entryCount') ?? 1);

  const result = await enterGiveaway(
    { store: new DrizzleGiveawayEntryStore(getDb()) },
    { giveawayId, playerProfileId: session.playerProfileId, entryCount },
  );

  if (!result.ok) return { error: explain(result.failure) };

  revalidatePath(`/sorteos/${giveawayId}`);
  revalidatePath('/sorteos');

  return { ok: { entryCount: result.entryCount, resultingBalance: result.resultingBalance } };
}
