/**
 * Golden Tickets giveaways — pure draw/eligibility logic, no store
 * dependency. Same spirit as `golden-tickets.ts`/`level-pass.ts`'s decision
 * functions.
 */

export type GiveawayStatus = 'draft' | 'open' | 'closed_pending_draw' | 'drawn' | 'delivered' | 'cancelled';

export interface GiveawayWindow {
  status: GiveawayStatus;
  opensAt: Date;
  closesAt: Date;
}

export function isOpenForEntry(giveaway: GiveawayWindow, now: Date): boolean {
  return giveaway.status === 'open' && now >= giveaway.opensAt && now < giveaway.closesAt;
}

export function meetsMinimum(minEntries: number, totalEntryCount: number): boolean {
  return totalEntryCount >= minEntries;
}

export interface WeightedEntry {
  playerProfileId: string;
  entryCount: number;
}

/**
 * Weighted-by-`entryCount` winner pick. `random` is injected (defaults to
 * `Math.random`) so tests can assert exact outcomes with a mocked function
 * instead of asserting on distributions. Returns `null` only for an empty
 * pool — callers must not invoke this with zero entries.
 */
export function pickWinner(entries: WeightedEntry[], random: () => number = Math.random): string | null {
  const totalEntries = entries.reduce((sum, e) => sum + e.entryCount, 0);
  if (totalEntries <= 0) return null;

  let target = random() * totalEntries;
  for (const entry of entries) {
    target -= entry.entryCount;
    if (target < 0) return entry.playerProfileId;
  }
  // random() returned exactly 1 (or floating-point rounding never dipped
  // below 0) — fall back to the last entry rather than null for a non-empty pool.
  return entries[entries.length - 1]!.playerProfileId;
}
