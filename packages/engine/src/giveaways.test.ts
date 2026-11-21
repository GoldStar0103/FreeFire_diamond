import { describe, expect, it } from 'vitest';
import { isOpenForEntry, meetsMinimum, pickWinner, pickWinners, type GiveawayWindow } from './giveaways.js';

const window = (overrides: Partial<GiveawayWindow> = {}): GiveawayWindow => ({
  status: 'open',
  opensAt: new Date('2026-11-01T00:00:00Z'),
  closesAt: new Date('2026-11-08T00:00:00Z'),
  ...overrides,
});

describe('isOpenForEntry', () => {
  it('is open between opensAt and closesAt while status is open', () => {
    expect(isOpenForEntry(window(), new Date('2026-11-05T00:00:00Z'))).toBe(true);
  });

  it('is closed before opensAt', () => {
    expect(isOpenForEntry(window(), new Date('2026-10-31T00:00:00Z'))).toBe(false);
  });

  it('is closed at or after closesAt', () => {
    expect(isOpenForEntry(window(), new Date('2026-11-08T00:00:00Z'))).toBe(false);
  });

  it('is closed when status is not open', () => {
    expect(isOpenForEntry(window({ status: 'closed_pending_draw' }), new Date('2026-11-05T00:00:00Z'))).toBe(
      false,
    );
  });
});

describe('meetsMinimum', () => {
  it('passes when total entries reach the minimum', () => {
    expect(meetsMinimum(10, 10)).toBe(true);
    expect(meetsMinimum(10, 25)).toBe(true);
  });

  it('fails when total entries are below the minimum', () => {
    expect(meetsMinimum(10, 9)).toBe(false);
  });

  it('a minimum of zero is always met', () => {
    expect(meetsMinimum(0, 0)).toBe(true);
  });
});

describe('pickWinner', () => {
  it('returns null for an empty pool', () => {
    expect(pickWinner([])).toBeNull();
  });

  it('is deterministic for a single entrant', () => {
    const winner = pickWinner([{ playerProfileId: 'p1', entryCount: 5 }], () => 0.5);
    expect(winner).toBe('p1');
  });

  it('weights the pick by entryCount', () => {
    const entries = [
      { playerProfileId: 'low', entryCount: 1 },
      { playerProfileId: 'high', entryCount: 9 },
    ];
    // total=10; random()=0.05 -> target=0.5, falls within "low"'s [0,1) slice
    expect(pickWinner(entries, () => 0.05)).toBe('low');
    // random()=0.5 -> target=5, past "low"'s slice, into "high"'s [1,10)
    expect(pickWinner(entries, () => 0.5)).toBe('high');
  });

  it('falls back to the last entry if random() returns 1', () => {
    const entries = [
      { playerProfileId: 'a', entryCount: 1 },
      { playerProfileId: 'b', entryCount: 1 },
    ];
    expect(pickWinner(entries, () => 1)).toBe('b');
  });
});

describe('pickWinners', () => {
  it('returns an empty list for an empty pool', () => {
    expect(pickWinners([], 3)).toEqual([]);
  });

  it('draws distinct winners without replacement, up to count', () => {
    const entries = [
      { playerProfileId: 'a', entryCount: 1 },
      { playerProfileId: 'b', entryCount: 1 },
      { playerProfileId: 'c', entryCount: 1 },
    ];
    // random() always returns the same value — if replacement happened, every
    // round would pick the same player and the result would have duplicates.
    const winners = pickWinners(entries, 2, () => 0.9);
    expect(winners).toHaveLength(2);
    expect(new Set(winners).size).toBe(2);
    winners.forEach((w) => expect(['a', 'b', 'c']).toContain(w));
  });

  it('returns every entrant, not an error, when count exceeds the pool size', () => {
    const entries = [
      { playerProfileId: 'a', entryCount: 1 },
      { playerProfileId: 'b', entryCount: 1 },
    ];
    const winners = pickWinners(entries, 5, () => 0.1);
    expect(winners).toHaveLength(2);
    expect(new Set(winners)).toEqual(new Set(['a', 'b']));
  });

  it('is deterministic and weighted the same way pickWinner is, per round', () => {
    const entries = [
      { playerProfileId: 'low', entryCount: 1 },
      { playerProfileId: 'high', entryCount: 9 },
    ];
    // First round: random()=0.05 -> target=0.5 -> "low". Second round, "low"
    // removed, pool is just "high" -> whatever random() returns, it's "high".
    expect(pickWinners(entries, 2, () => 0.05)).toEqual(['low', 'high']);
  });
});
