import { describe, expect, it, vi } from 'vitest';
import type { UsdTenK } from '@levelup/provider';
import {
  createPendingGiveawayPrizeOrders,
  grantCompletedGiveawayPrizes,
  type GiveawayPrizeDeliveryStore,
  type GrantableGiveawayPrize,
  type PendingGiveawayWinner,
  type ResolvedGiveawayPrizeCatalogEntry,
} from './giveaway-prize-delivery.js';

const usd = (n: number) => (n * 10_000) as UsdTenK;

const winner = (overrides: Partial<PendingGiveawayWinner> = {}): PendingGiveawayWinner => ({
  winnerId: 'winner-1',
  giveawayId: 'giveaway-1',
  giveawayTitle: 'Sorteo de prueba',
  freeFireId: '123456789',
  prizeDiamonds: 100,
  recipe: [{ baseProductId: 'bp-100', diamondsBase: 100 }],
  ...overrides,
});

const catalogEntry = (overrides: Partial<ResolvedGiveawayPrizeCatalogEntry> = {}): ResolvedGiveawayPrizeCatalogEntry => ({
  baseProductId: 'bp-100',
  provider: 'recargas_america',
  providerProductId: 'prov-100',
  endpointKind: 'pins_recharge',
  diamondsBase: 100,
  costUsd: usd(1),
  active: true,
  ...overrides,
});

function storeHarness(overrides: Partial<GiveawayPrizeDeliveryStore> = {}): GiveawayPrizeDeliveryStore {
  return {
    findPendingGiveawayWinners: vi.fn(async () => []),
    resolveGiveawayPrizeCatalog: vi.fn(async () => [catalogEntry()]),
    createGiveawayPrizeOrder: vi.fn(async () => ({ created: true, orderId: 'order-1', orderNumber: 'LU-TEST' })),
    findCompletedGiveawayPrizeOrders: vi.fn(async () => []),
    grantGiveawayPrize: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createPendingGiveawayPrizeOrders', () => {
  it('does nothing when no winner is pending', async () => {
    const store = storeHarness();
    const result = await createPendingGiveawayPrizeOrders({ store }, 50);
    expect(result).toEqual({ examined: 0, created: 0, unresolved: 0, failed: 0 });
  });

  it('resolves the recipe against the live catalog and creates an order', async () => {
    const store = storeHarness({ findPendingGiveawayWinners: vi.fn(async () => [winner()]) });
    const result = await createPendingGiveawayPrizeOrders({ store }, 50);

    expect(result).toEqual({ examined: 1, created: 1, unresolved: 0, failed: 0 });
    expect(store.resolveGiveawayPrizeCatalog).toHaveBeenCalledWith(['bp-100']);
    expect(store.createGiveawayPrizeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ winnerId: 'winner-1' }),
      [
        expect.objectContaining({
          sequence: 0,
          baseProductId: 'bp-100',
          providerProductId: 'prov-100',
          provider: 'recargas_america',
          diamondsBase: 100,
          costUsd: usd(1),
        }),
      ],
    );
  });

  it('counts as unresolved, not failed, when the recipe product is inactive', async () => {
    const store = storeHarness({
      findPendingGiveawayWinners: vi.fn(async () => [winner()]),
      resolveGiveawayPrizeCatalog: vi.fn(async () => [catalogEntry({ active: false })]),
    });
    const result = await createPendingGiveawayPrizeOrders({ store }, 50);
    expect(result).toEqual({ examined: 1, created: 0, unresolved: 1, failed: 0 });
    expect(store.createGiveawayPrizeOrder).not.toHaveBeenCalled();
  });

  it('counts as unresolved when the catalog has no synced cost yet', async () => {
    const store = storeHarness({
      findPendingGiveawayWinners: vi.fn(async () => [winner()]),
      resolveGiveawayPrizeCatalog: vi.fn(async () => [catalogEntry({ costUsd: null })]),
    });
    const result = await createPendingGiveawayPrizeOrders({ store }, 50);
    expect(result.unresolved).toBe(1);
  });

  it('counts as unresolved when a recipe line has no matching catalog row at all', async () => {
    const store = storeHarness({
      findPendingGiveawayWinners: vi.fn(async () => [winner()]),
      resolveGiveawayPrizeCatalog: vi.fn(async () => []),
    });
    const result = await createPendingGiveawayPrizeOrders({ store }, 50);
    expect(result.unresolved).toBe(1);
  });

  it('keeps going and reports the failure when one winner throws', async () => {
    const store = storeHarness({
      findPendingGiveawayWinners: vi.fn(async () => [winner({ winnerId: 'a' }), winner({ winnerId: 'b' })]),
      createGiveawayPrizeOrder: vi
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce({ created: true, orderId: 'order-2', orderNumber: 'LU-TEST2' }),
    });
    const result = await createPendingGiveawayPrizeOrders({ store }, 50);
    expect(result).toEqual({ examined: 2, created: 1, unresolved: 0, failed: 1 });
  });
});

describe('grantCompletedGiveawayPrizes', () => {
  const grantable = (overrides: Partial<GrantableGiveawayPrize> = {}): GrantableGiveawayPrize => ({
    winnerId: 'winner-1',
    giveawayId: 'giveaway-1',
    deliveryOrderId: 'order-1',
    internalCostCents: 1_200,
    ...overrides,
  });

  it('does nothing when nothing has completed', async () => {
    const store = storeHarness();
    const result = await grantCompletedGiveawayPrizes({ store }, 50);
    expect(result).toEqual({ examined: 0, granted: 0, failed: 0 });
  });

  it('grants every completed prize order', async () => {
    const store = storeHarness({
      findCompletedGiveawayPrizeOrders: vi.fn(async () => [grantable({ winnerId: 'a' }), grantable({ winnerId: 'b' })]),
    });
    const result = await grantCompletedGiveawayPrizes({ store }, 50);
    expect(result).toEqual({ examined: 2, granted: 2, failed: 0 });
    expect(store.grantGiveawayPrize).toHaveBeenCalledTimes(2);
  });

  it('keeps going and reports the failure when one grant throws', async () => {
    const store = storeHarness({
      findCompletedGiveawayPrizeOrders: vi.fn(async () => [grantable({ winnerId: 'a' }), grantable({ winnerId: 'b' })]),
      grantGiveawayPrize: vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(undefined),
    });
    const result = await grantCompletedGiveawayPrizes({ store }, 50);
    expect(result).toEqual({ examined: 2, granted: 1, failed: 1 });
  });
});
