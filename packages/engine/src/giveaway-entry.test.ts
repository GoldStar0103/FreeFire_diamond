import { describe, expect, it } from 'vitest';
import {
  enterGiveaway,
  type EnterGiveawayInput,
  type GiveawayEntryStore,
  type GiveawayForEntry,
  type SpendTicketsResult,
} from './giveaway-entry.js';

const openGiveaway = (overrides: Partial<GiveawayForEntry> = {}): GiveawayForEntry => ({
  id: 'giveaway-1',
  status: 'open',
  opensAt: new Date('2026-11-01T00:00:00Z'),
  closesAt: new Date('2026-11-08T00:00:00Z'),
  entryCostTickets: 10,
  ...overrides,
});

function harness(giveaway: GiveawayForEntry | null, spendResult: SpendTicketsResult) {
  const spends: Array<{ giveawayId: string; playerProfileId: string; entryCount: number; costTickets: number }> = [];
  const store: GiveawayEntryStore = {
    findGiveawayForEntry: async () => giveaway,
    spendTicketsForEntry: async (input) => {
      spends.push(input);
      return spendResult;
    },
  };
  return { store, spends };
}

const baseInput: EnterGiveawayInput = {
  giveawayId: 'giveaway-1',
  playerProfileId: 'player-1',
  entryCount: 3,
};

const now = () => new Date('2026-11-05T00:00:00Z');

describe('enterGiveaway', () => {
  it('spends entryCount * entryCostTickets and returns the running totals', async () => {
    const { store, spends } = harness(openGiveaway(), {
      ok: true,
      resultingBalance: 70,
      totalEntryCount: 3,
      totalTicketsSpent: 30,
    });

    const result = await enterGiveaway({ store, now }, baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resultingBalance).toBe(70);
    expect(result.entryCount).toBe(3);
    expect(result.ticketsSpent).toBe(30);
    expect(spends).toEqual([
      { giveawayId: 'giveaway-1', playerProfileId: 'player-1', entryCount: 3, costTickets: 30 },
    ]);
  });

  it('rejects an unknown giveaway', async () => {
    const { store } = harness(null, { ok: true, resultingBalance: 0, totalEntryCount: 0, totalTicketsSpent: 0 });
    const result = await enterGiveaway({ store, now }, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('GIVEAWAY_NOT_FOUND');
  });

  it('rejects entering before opensAt', async () => {
    const { store } = harness(openGiveaway({ opensAt: new Date('2026-12-01T00:00:00Z') }), {
      ok: true,
      resultingBalance: 0,
      totalEntryCount: 0,
      totalTicketsSpent: 0,
    });
    const result = await enterGiveaway({ store, now }, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('GIVEAWAY_CLOSED');
  });

  it('rejects entering a giveaway that is not status=open', async () => {
    const { store } = harness(openGiveaway({ status: 'closed_pending_draw' }), {
      ok: true,
      resultingBalance: 0,
      totalEntryCount: 0,
      totalTicketsSpent: 0,
    });
    const result = await enterGiveaway({ store, now }, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('GIVEAWAY_CLOSED');
  });

  it('rejects a zero or negative entry count', async () => {
    const { store } = harness(openGiveaway(), {
      ok: true,
      resultingBalance: 0,
      totalEntryCount: 0,
      totalTicketsSpent: 0,
    });
    const result = await enterGiveaway({ store, now }, { ...baseInput, entryCount: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_ENTRY_COUNT');
  });

  it('surfaces insufficient tickets without spending anything', async () => {
    const { store } = harness(openGiveaway(), { ok: false, currentBalance: 5 });
    const result = await enterGiveaway({ store, now }, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INSUFFICIENT_TICKETS');
    if (result.failure.code !== 'INSUFFICIENT_TICKETS') return;
    expect(result.failure.balance).toBe(5);
    expect(result.failure.cost).toBe(30);
  });
});
