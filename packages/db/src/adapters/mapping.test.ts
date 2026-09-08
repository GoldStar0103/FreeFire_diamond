import { describe, expect, it } from 'vitest';
import { lockKeyFor } from './advisory-lock.js';
import { toNumericString, toOrderItemRecord, toOrderRecord, type OrderItemRow } from './mapping.js';
import type { UsdTenK } from '@levelup/provider';

const row = (overrides: Partial<OrderItemRow> = {}): OrderItemRow => ({
  id: 'item-1',
  sequence: 0,
  providerProductId: '42',
  diamondsBase: 5600,
  costUsd: '27.5000',
  status: 'queued',
  attemptCount: 0,
  providerReference: null,
  walletBeforeUsd: null,
  ...overrides,
});

const order = {
  id: 'order-1',
  orderNumber: 'LU-000900',
  playerId: '7288567050',
  serverId: null,
  status: 'payment_confirmed' as const,
};

describe('toOrderItemRecord', () => {
  it('parses numeric strings without going through a float', () => {
    // postgres.js hands back `numeric` as text on purpose; 27.5 -> 275000 tenk.
    expect(toOrderItemRecord(row()).costUsd).toBe(275_000);
  });

  it('parses a wallet snapshot when one is present', () => {
    expect(toOrderItemRecord(row({ walletBeforeUsd: '150.0000' })).walletBeforeUsd).toBe(1_500_000);
  });

  it('leaves the wallet snapshot null before the first dispatch', () => {
    expect(toOrderItemRecord(row()).walletBeforeUsd).toBeNull();
  });

  it('throws when cost is missing rather than defaulting to zero', () => {
    // A zero cost would make every ambiguous outcome indeterminate, which looks
    // like a provider problem instead of an un-synced catalog.
    expect(() => toOrderItemRecord(row({ costUsd: null }))).toThrow(/catalog sync/);
  });
});

describe('toOrderRecord', () => {
  it('orders items by the recipe sequence, not by row order', () => {
    const record = toOrderRecord(order, [
      row({ id: 'c', sequence: 2 }),
      row({ id: 'a', sequence: 0 }),
      row({ id: 'b', sequence: 1 }),
    ]);
    expect(record.items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('refuses an order with no items', () => {
    expect(() => toOrderRecord(order, [])).toThrow(/no items/);
  });
});

describe('toNumericString', () => {
  it.each([
    [275_000, '27.5000'],
    [5_500, '0.5500'],
    [1_500_000, '150.0000'],
    [1, '0.0001'],
  ])('formats %i as %s', (input, expected) => {
    expect(toNumericString(input as UsdTenK)).toBe(expected);
  });

  it('round-trips through the parser', () => {
    const original = 275_000 as UsdTenK;
    expect(toOrderItemRecord(row({ costUsd: toNumericString(original) })).costUsd).toBe(original);
  });
});

describe('lockKeyFor', () => {
  it('is deterministic', () => {
    expect(lockKeyFor('provider:recargasamerica')).toBe(lockKeyFor('provider:recargasamerica'));
  });

  it('separates different keys', () => {
    expect(lockKeyFor('provider:recargasamerica')).not.toBe(lockKeyFor('provider:other'));
  });

  it('stays inside int4, which is what pg_advisory_lock accepts', () => {
    for (const key of ['provider:recargasamerica', 'poller', '', 'x'.repeat(500), '🎮']) {
      const id = lockKeyFor(key);
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(-(2 ** 31));
      expect(id).toBeLessThanOrEqual(2 ** 31 - 1);
    }
  });
});
