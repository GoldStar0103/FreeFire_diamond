/**
 * Spend Golden Tickets entering a giveaway — the giveaway equivalent of
 * `item-ordering.ts`'s `createItemOrder`. Entries accumulate per
 * (giveaway, player) — see `giveaway-entry-store.ts`'s upsert — so
 * re-entering an already-entered giveaway just buys more chances, it never
 * creates a second row.
 */

import { isOpenForEntry, type GiveawayWindow } from './giveaways.js';

export interface GiveawayForEntry extends GiveawayWindow {
  id: string;
  entryCostTickets: number;
}

export interface EnterGiveawayInput {
  giveawayId: string;
  playerProfileId: string;
  entryCount: number;
}

export type EnterGiveawayFailure =
  | { code: 'GIVEAWAY_NOT_FOUND'; message: string }
  | { code: 'GIVEAWAY_CLOSED'; message: string }
  | { code: 'INVALID_ENTRY_COUNT'; message: string }
  | { code: 'INSUFFICIENT_TICKETS'; message: string; balance: number; cost: number }
  | { code: 'MAX_ENTRIES_PER_PLAYER_EXCEEDED'; message: string; currentEntryCount: number }
  | { code: 'GIVEAWAY_FULL'; message: string };

export type EnterGiveawayResult =
  | { ok: true; entryCount: number; ticketsSpent: number; resultingBalance: number }
  | { ok: false; failure: EnterGiveawayFailure };

export type SpendTicketsResult =
  | { ok: true; resultingBalance: number; totalEntryCount: number; totalTicketsSpent: number }
  | { ok: false; reason: 'insufficient_tickets'; currentBalance: number }
  | { ok: false; reason: 'max_entries_per_player'; currentEntryCount: number }
  | { ok: false; reason: 'giveaway_full' };

export interface GiveawayEntryStore {
  findGiveawayForEntry(giveawayId: string): Promise<GiveawayForEntry | null>;
  /** Atomically debits the player's ticket balance (a no-op write, never
   *  below 0, if insufficient) and upserts the giveaway_entries row. */
  spendTicketsForEntry(input: {
    giveawayId: string;
    playerProfileId: string;
    entryCount: number;
    costTickets: number;
  }): Promise<SpendTicketsResult>;
}

export interface GiveawayEntryDeps {
  store: GiveawayEntryStore;
  now?: () => Date;
}

export async function enterGiveaway(
  deps: GiveawayEntryDeps,
  input: EnterGiveawayInput,
): Promise<EnterGiveawayResult> {
  const now = deps.now?.() ?? new Date();
  const fail = (failure: EnterGiveawayFailure): EnterGiveawayResult => ({ ok: false, failure });

  const entryCount = Math.trunc(input.entryCount);
  if (!Number.isFinite(entryCount) || entryCount < 1) {
    return fail({ code: 'INVALID_ENTRY_COUNT', message: 'Entry count must be at least 1.' });
  }

  const giveaway = await deps.store.findGiveawayForEntry(input.giveawayId);
  if (!giveaway) return fail({ code: 'GIVEAWAY_NOT_FOUND', message: 'This giveaway no longer exists.' });
  if (!isOpenForEntry(giveaway, now)) {
    return fail({ code: 'GIVEAWAY_CLOSED', message: 'This giveaway is not open for entries right now.' });
  }

  const costTickets = entryCount * giveaway.entryCostTickets;
  const spent = await deps.store.spendTicketsForEntry({
    giveawayId: giveaway.id,
    playerProfileId: input.playerProfileId,
    entryCount,
    costTickets,
  });

  if (!spent.ok) {
    if (spent.reason === 'giveaway_full') {
      return fail({ code: 'GIVEAWAY_FULL', message: 'This giveaway has reached its participant limit.' });
    }
    if (spent.reason === 'max_entries_per_player') {
      return fail({
        code: 'MAX_ENTRIES_PER_PLAYER_EXCEEDED',
        message: 'You have reached the maximum entries allowed per player for this giveaway.',
        currentEntryCount: spent.currentEntryCount,
      });
    }
    return fail({
      code: 'INSUFFICIENT_TICKETS',
      message: 'You do not have enough Golden Tickets for this many entries.',
      balance: spent.currentBalance,
      cost: costTickets,
    });
  }

  return {
    ok: true,
    entryCount: spent.totalEntryCount,
    ticketsSpent: spent.totalTicketsSpent,
    resultingBalance: spent.resultingBalance,
  };
}
