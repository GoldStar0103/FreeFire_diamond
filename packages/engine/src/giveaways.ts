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

/**
 * Draw up to `count` DISTINCT winners, weighted by `entryCount`, without
 * replacement — each round removes the player just picked from the pool
 * before the next round runs, so someone with 50 entries can't win every one
 * of a giveaway's several prizes. Returns fewer than `count` only when the
 * pool itself has fewer than `count` distinct players — every entrant wins in
 * that case, never an error (a giveaway with 3 winner slots and 2 entrants is
 * a valid, if odd, admin configuration).
 */
export function pickWinners(
  entries: WeightedEntry[],
  count: number,
  random: () => number = Math.random,
): string[] {
  const pool = entries.filter((e) => e.entryCount > 0).map((e) => ({ ...e }));
  const winners: string[] = [];

  while (winners.length < count && pool.length > 0) {
    const winnerId = pickWinner(pool, random);
    if (!winnerId) break;
    winners.push(winnerId);
    const index = pool.findIndex((e) => e.playerProfileId === winnerId);
    if (index >= 0) pool.splice(index, 1);
  }

  return winners;
}
