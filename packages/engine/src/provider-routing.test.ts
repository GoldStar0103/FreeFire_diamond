import { describe, expect, it, vi } from 'vitest';
import type { ProviderName, UsdTenK } from '@levelup/provider';
import { activateProvider } from './provider-routing.js';
import { MemoryAlerter, MemoryCatalogStore } from './testing.js';
import type { StoredProduct } from './catalog-sync.js';

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

const row = (
  overrides: Partial<StoredProduct> & { diamondsBase: number; provider: ProviderName },
): StoredProduct & { provider: ProviderName } => ({
  id: `bp-${overrides.providerProductId ?? 'x'}`,
  providerProductId: 'x',
  endpointKind: 'pins_recharge',
  costUsd: usd(1),
  active: true,
  ...overrides,
});

function harness() {
  const alerter = new MemoryAlerter();
  const setActiveProvider = vi.fn(async () => undefined);
  return { alerter, setActiveProvider };
}

describe('activateProvider', () => {
  it('switches every denomination that has a ready target candidate', async () => {
    const store = new MemoryCatalogStore([
      row({ providerProductId: 'ra-100', diamondsBase: 100, provider: 'recargas_america' }),
      row({ providerProductId: 'ra-310', diamondsBase: 310, provider: 'recargas_america' }),
      row({ providerProductId: 'co-100', diamondsBase: 100, provider: 'central_one' }),
      row({ providerProductId: 'co-310', diamondsBase: 310, provider: 'central_one' }),
    ]);
    const { alerter, setActiveProvider } = harness();

    const result = await activateProvider({ store, alerter, setActiveProvider }, 'central_one');

    expect(result.switched.sort()).toEqual([100, 310]);
    expect(result.alreadyActive).toEqual([]);
    expect(setActiveProvider).toHaveBeenCalledWith('central_one', null);
    expect(await store.listActiveRecipeProducts()).toEqual(
      expect.arrayContaining([
        { denomination: 100, provider: 'central_one', providerProductId: 'co-100' },
        { denomination: 310, provider: 'central_one', providerProductId: 'co-310' },
      ]),
    );
    expect(alerter.has('critical')).toBe(false);
  });

  it('passes the admin id through to setActiveProvider for the audit trail', async () => {
    const store = new MemoryCatalogStore([
      row({ providerProductId: 'ra-100', diamondsBase: 100, provider: 'recargas_america' }),
      row({ providerProductId: 'co-100', diamondsBase: 100, provider: 'central_one' }),
    ]);
    const { alerter, setActiveProvider } = harness();

    await activateProvider({ store, alerter, setActiveProvider }, 'central_one', 'admin-1');

    expect(setActiveProvider).toHaveBeenCalledWith('central_one', 'admin-1');
  });

  it('skips a denomination with no ready target candidate, and alerts critically', async () => {
    const store = new MemoryCatalogStore([
      row({ providerProductId: 'ra-100', diamondsBase: 100, provider: 'recargas_america' }),
      row({ providerProductId: 'ra-310', diamondsBase: 310, provider: 'recargas_america' }),
      // Central One is only ready for 100, not 310.
      row({ providerProductId: 'co-100', diamondsBase: 100, provider: 'central_one' }),
    ]);
    const { alerter, setActiveProvider } = harness();

    const result = await activateProvider({ store, alerter, setActiveProvider }, 'central_one');

    expect(result.switched).toEqual([100]);
    expect(result.skipped).toContain(310);
    expect(setActiveProvider).toHaveBeenCalledWith('central_one', null);
    expect(alerter.has('critical')).toBe(true);
  });

  it('never activates on an inactive or priceless target row', async () => {
    const store = new MemoryCatalogStore([
      row({ providerProductId: 'ra-100', diamondsBase: 100, provider: 'recargas_america' }),
      row({ providerProductId: 'co-100', diamondsBase: 100, provider: 'central_one', active: false }),
      row({ providerProductId: 'co-310', diamondsBase: 310, provider: 'central_one', costUsd: null }),
      row({ providerProductId: 'ra-310', diamondsBase: 310, provider: 'recargas_america' }),
    ]);
    const { alerter, setActiveProvider } = harness();

    const result = await activateProvider({ store, alerter, setActiveProvider }, 'central_one');

    expect(result.switched).toEqual([]);
    expect(result.skipped.sort()).toEqual([100, 310]);
    expect(setActiveProvider).not.toHaveBeenCalled();
    expect(alerter.has('critical')).toBe(true);
  });

  it('is a no-op, with no alert and no settings write, when already fully on the target', async () => {
    const store = new MemoryCatalogStore([
      row({ providerProductId: 'co-100', diamondsBase: 100, provider: 'central_one' }),
    ]);
    // Already switched by an earlier call — the recipe points at Central One.
    store.activeRecipe.set(100, { provider: 'central_one', providerProductId: 'co-100' });
    const { alerter, setActiveProvider } = harness();

    const result = await activateProvider({ store, alerter, setActiveProvider }, 'central_one');

    expect(result.switched).toEqual([]);
    expect(result.alreadyActive).toEqual([100]);
    expect(setActiveProvider).not.toHaveBeenCalled();
    expect(alerter.sent).toHaveLength(0);
  });

  it('leaves a denomination alone, and reports nothing, when nothing currently sells it at all', async () => {
    // Central One has a 100-diamond row ready, but nothing today references
    // any 100-diamond product — there is nothing to repoint FROM, and no gap
    // to report either: switching providers cannot break what wasn't sold.
    const store = new MemoryCatalogStore([
      row({ providerProductId: 'co-100', diamondsBase: 100, provider: 'central_one', active: true }),
    ]);
    store.activeRecipe.clear(); // nothing currently active for any denomination
    const { alerter, setActiveProvider } = harness();

    const result = await activateProvider({ store, alerter, setActiveProvider }, 'central_one');

    expect(result.switched).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.alreadyActive).toEqual([]);
    expect(setActiveProvider).not.toHaveBeenCalled();
    expect(alerter.sent).toHaveLength(0);
  });

  it('reuses repointProducts, moving combo recipes and unsent order items atomically', async () => {
    const store = new MemoryCatalogStore([
      row({ providerProductId: 'ra-100', diamondsBase: 100, provider: 'recargas_america' }),
      row({ providerProductId: 'co-100', diamondsBase: 100, provider: 'central_one' }),
    ]);
    store.moved = () => ({ recipeItems: 3, orderItems: 1 });
    const { alerter, setActiveProvider } = harness();

    const result = await activateProvider({ store, alerter, setActiveProvider }, 'central_one');

    expect(store.repoints).toEqual([
      {
        denomination: 100,
        fromProvider: 'recargas_america',
        fromProviderProductId: 'ra-100',
        toProvider: 'central_one',
        toProviderProductId: 'co-100',
        costUsd: usd(1),
      },
    ]);
    expect(result.repointed[0]).toMatchObject({ recipeItems: 3, orderItems: 1 });
  });
});
