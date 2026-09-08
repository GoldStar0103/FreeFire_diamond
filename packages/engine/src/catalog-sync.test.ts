import { describe, expect, it, vi } from 'vitest';
import { ProviderSimulator, type ProviderProduct, type UsdTenK } from '@levelup/provider';
import {
  summariseSync,
  syncCatalog,
  type CatalogSyncStore,
  type ProductUpsert,
  type StoredProduct,
} from './catalog-sync.js';

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

const product = (overrides: Partial<ProviderProduct> = {}): ProviderProduct => ({
  providerProductId: 'd5600',
  endpointKind: 'pins_recharge',
  name: 'Free Fire 5600 Diamonds',
  sku: 'FF5600',
  diamondsBase: 5600,
  costUsd: usd(27.5),
  requiresServerId: false,
  canValidate: true,
  raw: {},
  ...overrides,
});

function harness(catalog: ProviderProduct[], stored: StoredProduct[] = []) {
  const upserted: ProductUpsert[][] = [];
  const deactivated: string[][] = [];

  const store: CatalogSyncStore = {
    listStoredProducts: vi.fn(async () => stored),
    upsertProducts: vi.fn(async (p: ProductUpsert[]) => void upserted.push(p)),
    deactivateProducts: vi.fn(async (ids: string[]) => void deactivated.push(ids)),
  };

  const provider = new ProviderSimulator();
  provider.programCatalog(catalog);

  return { store, provider, upserted, deactivated, deps: { store, provider } };
}

const allSix = (): ProviderProduct[] =>
  [100, 310, 520, 1060, 2180, 5600].map((d) =>
    product({
      providerProductId: `d${d}`,
      diamondsBase: d,
      name: `Free Fire ${d} Diamonds`,
      costUsd: usd(d / 200),
    }),
  );

describe('mapping the six denominations', () => {
  it('maps a complete catalog', async () => {
    const { deps, upserted } = harness(allSix());

    const result = await syncCatalog(deps);

    expect(result.mapped).toEqual([100, 310, 520, 1060, 2180, 5600]);
    expect(result.missing).toEqual([]);
    expect(result.blocked).toBe(false);
    expect(upserted[0]).toHaveLength(6);
  });

  it('reports denominations the provider does not offer', async () => {
    // Combos using 310 cannot be fulfilled until this is resolved.
    const partial = allSix().filter((p) => p.diamondsBase !== 310);
    const { deps } = harness(partial);

    const result = await syncCatalog(deps);

    expect(result.missing).toEqual([310]);
    expect(result.mapped).not.toContain(310);
  });

  it('flags a completely empty Free Fire catalog as blocked', async () => {
    const { deps } = harness([]);
    const result = await syncCatalog(deps);

    expect(result.blocked).toBe(true);
    expect(result.missing).toHaveLength(6);
  });

  it('prefers a validatable recharge over a games package', async () => {
    // The nickname gate before charging is worth more than pollability: a
    // mistyped ID sends diamonds to a stranger, irreversibly.
    const { deps, upserted } = harness([
      product({ providerProductId: 'game-5600', endpointKind: 'games', canValidate: false }),
      product({ providerProductId: 'pin-5600', endpointKind: 'pins_recharge', canValidate: true }),
    ]);

    await syncCatalog(deps);

    expect(upserted[0]?.[0]?.providerProductId).toBe('pin-5600');
    expect(upserted[0]?.[0]?.canValidate).toBe(true);
  });

  it('falls back to a games package when that is all there is', async () => {
    const { deps, upserted } = harness([
      product({ providerProductId: 'game-5600', endpointKind: 'games', canValidate: false }),
    ]);

    const result = await syncCatalog(deps);

    expect(result.mapped).toEqual([5600]);
    expect(upserted[0]?.[0]?.endpointKind).toBe('games');
  });

  it('carries the server-ID requirement through to checkout', async () => {
    const { deps, upserted } = harness([
      product({ endpointKind: 'games', requiresServerId: true, canValidate: false }),
    ]);

    await syncCatalog(deps);
    expect(upserted[0]?.[0]?.requiresServerId).toBe(true);
  });
});

describe('unusable products', () => {
  it('refuses a code-delivery product and says why', async () => {
    // Selling a code as a "recarga directa" would break the core promise.
    const { deps, upserted } = harness([product({ endpointKind: 'pins_code', canValidate: false })]);

    const result = await syncCatalog(deps);

    expect(result.mapped).toEqual([]);
    expect(result.missing).toContain(5600);
    expect(result.skipped[0]?.reason).toMatch(/redeemable code/i);
    expect(upserted).toHaveLength(0);
  });

  it('refuses a product with no price', async () => {
    const { deps } = harness([product({ costUsd: null })]);

    const result = await syncCatalog(deps);

    expect(result.skipped[0]?.reason).toMatch(/no price/i);
    expect(result.missing).toContain(5600);
  });

  it('ignores products that match no known denomination', async () => {
    const { deps, upserted } = harness([
      product({ providerProductId: 'x', diamondsBase: 4242, name: 'Free Fire 4242' }),
    ]);

    const result = await syncCatalog(deps);
    expect(result.mapped).toEqual([]);
    expect(upserted).toHaveLength(0);
  });
});

describe('cost changes', () => {
  const storedAt = (costUsd: UsdTenK): StoredProduct[] => [
    {
      id: 'bp-1',
      providerProductId: 'd5600',
      endpointKind: 'pins_recharge',
      diamondsBase: 5600,
      costUsd,
      active: true,
    },
  ];

  it('reports a price rise that eats into margin', async () => {
    // Revenue is fixed in MXN by a flyer for a month; cost floats in USD.
    const { deps } = harness([product({ costUsd: usd(30) })], storedAt(usd(27.5)));

    const result = await syncCatalog(deps);

    expect(result.costChanges).toHaveLength(1);
    expect(result.costChanges[0]).toMatchObject({
      providerProductId: 'd5600',
      previousUsd: usd(27.5),
      currentUsd: usd(30),
      deltaUsd: usd(2.5),
    });
    expect(result.costChanges[0]?.pctChange).toBeCloseTo(9.09, 1);
  });

  it('reports a price cut too', async () => {
    const { deps } = harness([product({ costUsd: usd(25) })], storedAt(usd(27.5)));
    expect(result_pct(await syncCatalog(deps))).toBeLessThan(0);
  });

  it('stays quiet about rounding noise below the threshold', async () => {
    const { deps } = harness([product({ costUsd: usd(27.51) })], storedAt(usd(27.5)));
    expect((await syncCatalog(deps)).costChanges).toHaveLength(0);
  });

  it('honours a custom threshold', async () => {
    const { deps } = harness([product({ costUsd: usd(27.51) })], storedAt(usd(27.5)));
    const result = await syncCatalog({ ...deps, costChangeThreshold: 0.0001 });
    expect(result.costChanges).toHaveLength(1);
  });

  it('does not report a first sighting as a change', async () => {
    const { deps } = harness([product()], []);
    const result = await syncCatalog(deps);

    expect(result.costChanges).toHaveLength(0);
    expect(result.added).toEqual(['d5600']);
  });
});

const result_pct = (r: Awaited<ReturnType<typeof syncCatalog>>) => r.costChanges[0]!.pctChange;

describe('withdrawn products', () => {
  it('deactivates rather than deletes', async () => {
    // Order items and combo recipes still point at these rows.
    const stored: StoredProduct[] = [
      {
        id: 'bp-old',
        providerProductId: 'discontinued',
        endpointKind: 'pins_recharge',
        diamondsBase: 5600,
        costUsd: usd(27.5),
        active: true,
      },
    ];
    const { deps, deactivated } = harness([product()], stored);

    const result = await syncCatalog(deps);

    expect(result.deactivated).toEqual(['discontinued']);
    expect(deactivated[0]).toEqual(['discontinued']);
  });

  it('does not re-deactivate something already inactive', async () => {
    const stored: StoredProduct[] = [
      {
        id: 'bp-old',
        providerProductId: 'gone',
        endpointKind: 'pins_recharge',
        diamondsBase: 100,
        costUsd: usd(1),
        active: false,
      },
    ];
    const { deps, store } = harness([product()], stored);

    await syncCatalog(deps);
    expect(store.deactivateProducts).not.toHaveBeenCalled();
  });
});

describe('provider failure', () => {
  it('propagates rather than reporting an empty catalog', async () => {
    // Treating a failed fetch as "no products" would deactivate everything.
    const { deps, provider, store } = harness([]);
    provider.programCatalog(null, 'HTTP 502');

    await expect(syncCatalog(deps)).rejects.toThrow(/502/);
    expect(store.upsertProducts).not.toHaveBeenCalled();
    expect(store.deactivateProducts).not.toHaveBeenCalled();
  });
});

describe('summariseSync', () => {
  it('leads with coverage', async () => {
    const { deps } = harness(allSix());
    expect(summariseSync(await syncCatalog(deps))).toMatch(/^6\/6 denominations mapped/);
  });

  it('makes missing denominations impossible to miss', async () => {
    const { deps } = harness(allSix().filter((p) => p.diamondsBase !== 310));
    expect(summariseSync(await syncCatalog(deps))).toContain('MISSING: 310');
  });
});
