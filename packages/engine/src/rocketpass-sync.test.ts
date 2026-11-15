import { describe, expect, it, vi } from 'vitest';
import {
  syncRocketPassCatalog,
  type RocketPassCatalogClient,
  type RocketPassCatalogStore,
  type SyncedCatalogItem,
} from './rocketpass-sync.js';

const giftItem = {
  item: 'crate' as const,
  name: 'Universal Evo Token Crate',
  kind: 'gift' as const,
  priceArs: 400,
  maxQuantity: 500,
  available: true,
  stockByRegion: { SAC: 312, US: 87 },
  affordableUnits: 210,
};

const membershipItem = {
  item: 'weekly' as const,
  name: 'Weekly Membership',
  kind: 'membership' as const,
  priceArs: 1200,
  maxQuantity: 1,
  available: true,
  stockByRegion: null,
  affordableUnits: 50,
};

const levelPassItem = {
  item: 'lvl_10' as unknown as never,
  name: 'Level 10 Pass',
  kind: 'level_pass' as unknown as 'gift',
  priceArs: 800,
  maxQuantity: 1,
  available: true,
  stockByRegion: null,
  affordableUnits: 20,
};

function harness(items: unknown[], upsert?: RocketPassCatalogStore['upsertCatalog']) {
  const client: RocketPassCatalogClient = {
    listCatalog: vi.fn(async () => ({
      items: items as never,
      regions: [{ code: 'SAC' as const, name: 'Sudamérica' }],
      balanceArs: 10_000,
      currency: 'ARS',
    })),
  };
  const store: RocketPassCatalogStore = { upsertCatalog: upsert ?? vi.fn(async () => undefined) };
  return { client, store, deps: { client, store } };
}

describe('syncRocketPassCatalog', () => {
  it('upserts every gift/membership item', async () => {
    const { store, deps } = harness([giftItem, membershipItem]);
    const result = await syncRocketPassCatalog(deps);

    expect(result).toEqual({ synced: 2, skipped: 0 });
    expect(store.upsertCatalog).toHaveBeenCalledTimes(1);
    const [items] = vi.mocked(store.upsertCatalog).mock.calls[0]!;
    expect(items).toEqual([
      {
        sku: 'crate',
        name: 'Universal Evo Token Crate',
        kind: 'gift',
        priceArs: 400,
        maxQuantity: 500,
        available: true,
        stockByRegion: { SAC: 312, US: 87 },
      },
      {
        sku: 'weekly',
        name: 'Weekly Membership',
        kind: 'membership',
        priceArs: 1200,
        maxQuantity: 1,
        available: true,
        stockByRegion: null,
      },
    ] satisfies SyncedCatalogItem[]);
  });

  it('never persists RocketPass\'s own level_pass items, even if the catalog returns one', async () => {
    const { store, deps } = harness([giftItem, levelPassItem]);
    const result = await syncRocketPassCatalog(deps);

    expect(result).toEqual({ synced: 1, skipped: 1 });
    const [items] = vi.mocked(store.upsertCatalog).mock.calls[0]!;
    expect((items as SyncedCatalogItem[]).map((i) => i.sku)).toEqual(['crate']);
  });

  it('passes the injected clock through to the store', async () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const { store, deps } = harness([giftItem]);
    await syncRocketPassCatalog({ ...deps, now: () => now });

    const [, syncedAt] = vi.mocked(store.upsertCatalog).mock.calls[0]!;
    expect(syncedAt).toBe(now);
  });

  it('does nothing when the catalog is empty', async () => {
    const { store, deps } = harness([]);
    expect(await syncRocketPassCatalog(deps)).toEqual({ synced: 0, skipped: 0 });
    expect(store.upsertCatalog).toHaveBeenCalledWith([], expect.any(Date));
  });
});
