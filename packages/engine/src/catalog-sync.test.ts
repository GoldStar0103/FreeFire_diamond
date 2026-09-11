import { describe, expect, it, vi } from 'vitest';
import { ProviderSimulator, type ProviderProduct, type UsdTenK } from '@levelup/provider';
import {
  summariseSync,
  syncCatalog,
  type CatalogSyncStore,
  type ProductUpsert,
  type Repoint,
  type RepointOutcome,
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

/**
 * `moved` scripts what the store reports back from a re-point — how many rows
 * it found to move — so the engine's reporting can be checked without a DB.
 */
function harness(
  catalog: ProviderProduct[],
  stored: StoredProduct[] = [],
  moved: (r: Repoint) => { recipeItems: number; orderItems: number } = () => ({
    recipeItems: 0,
    orderItems: 0,
  }),
) {
  const upserted: ProductUpsert[][] = [];
  const deactivated: string[][] = [];
  const repointed: Repoint[][] = [];
  /** Store calls in order — re-pointing has to sit between upsert and deactivate. */
  const calls: string[] = [];

  const store: CatalogSyncStore = {
    listStoredProducts: vi.fn(async () => stored),
    upsertProducts: vi.fn(async (p: ProductUpsert[]) => {
      calls.push('upsert');
      upserted.push(p);
    }),
    deactivateProducts: vi.fn(async (ids: string[]) => {
      calls.push('deactivate');
      deactivated.push(ids);
    }),
    repointProducts: vi.fn(async (r: Repoint[]): Promise<RepointOutcome[]> => {
      calls.push('repoint');
      repointed.push(r);
      return r.map((x) => ({ ...x, ...moved(x) }));
    }),
  };

  const provider = new ProviderSimulator();
  provider.programCatalog(catalog);

  return { store, provider, upserted, deactivated, repointed, calls, deps: { store, provider } };
}

const storedRow = (overrides: Partial<StoredProduct> = {}): StoredProduct => ({
  id: `bp-${overrides.providerProductId ?? 'd5600'}`,
  providerProductId: 'd5600',
  endpointKind: 'pins_recharge',
  diamondsBase: 5600,
  costUsd: usd(28),
  active: true,
  ...overrides,
});

/** The six products as the live catalog stores them today (phase0/out/REPORT.md). */
const LIVE_IDS: Record<number, string> = {
  100: '351',
  310: '348',
  520: '350',
  1060: '347',
  2180: '346',
  5600: '349',
};

const storedLive = (): StoredProduct[] =>
  Object.entries(LIVE_IDS).map(([d, id]) =>
    storedRow({ providerProductId: id, diamondsBase: Number(d), costUsd: usd(Number(d) / 200) }),
  );

const catalogWithIds = (ids: Record<number, string>): ProviderProduct[] =>
  Object.entries(ids).map(([d, id]) =>
    product({
      providerProductId: id,
      diamondsBase: Number(d),
      name: `Free Fire ${d} Diamantes`,
      costUsd: usd(Number(d) / 200),
    }),
  );

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

  it('still deactivates one withdrawn product when the rest of the catalog is healthy', async () => {
    // The guard below is for a broken catalog, not for a product that is
    // genuinely gone — combos using 310 must fail loudly, not keep selling.
    const offered = { ...LIVE_IDS } as Record<number, string>;
    delete offered[310];
    const { deps, deactivated } = harness(catalogWithIds(offered), storedLive());

    const result = await syncCatalog(deps);

    expect(result.deactivated).toEqual(['348']);
    expect(deactivated[0]).toEqual(['348']);
    expect(result.deactivationSkipped).toBeNull();
    expect(result.missing).toEqual([310]);
    expect(result.replaced).toEqual([]);
  });
});

describe('a broken catalog response', () => {
  it('deactivates nothing when the provider returns zero Free Fire products', async () => {
    // A provider mid-migration answering `[]` is not evidence that every SKU
    // was withdrawn. Believing it would take the whole store down.
    const { deps, store } = harness([], storedLive());

    const result = await syncCatalog(deps);

    expect(store.deactivateProducts).not.toHaveBeenCalled();
    expect(store.upsertProducts).not.toHaveBeenCalled();
    expect(store.repointProducts).not.toHaveBeenCalled();
    expect(result.blocked).toBe(true);
    expect(result.deactivated).toEqual([]);
    expect(result.deactivationSkipped).toEqual({
      reason: 'empty_catalog',
      keptActive: Object.values(LIVE_IDS),
    });
  });

  it('deactivates nothing when products come back but none can be mapped', async () => {
    // Renamed into strings extractDiamonds cannot read — the catalog is not
    // empty, but it says nothing about which denominations exist.
    const garbled = catalogWithIds(LIVE_IDS).map((p) => ({
      ...p,
      name: 'Free Fire Paquete',
      diamondsBase: null,
    }));
    const { deps, store } = harness(garbled, storedLive());

    const result = await syncCatalog(deps);

    expect(store.deactivateProducts).not.toHaveBeenCalled();
    expect(result.blocked).toBe(true);
    expect(result.deactivationSkipped?.reason).toBe('nothing_mapped');
    expect(result.deactivationSkipped?.keptActive).toHaveLength(6);
  });

  it('deactivates nothing when every product is a redeemable code', async () => {
    const codes = catalogWithIds(LIVE_IDS).map((p) => ({
      ...p,
      endpointKind: 'pins_code' as const,
      canValidate: false,
    }));
    const { deps, store } = harness(codes, storedLive());

    const result = await syncCatalog(deps);

    expect(store.deactivateProducts).not.toHaveBeenCalled();
    expect(result.blocked).toBe(true);
    expect(result.deactivationSkipped?.reason).toBe('nothing_mapped');
  });

  it('is not triggered on a first sync into an empty database', async () => {
    const { deps } = harness([]);
    const result = await syncCatalog(deps);

    expect(result.blocked).toBe(true);
    expect(result.deactivationSkipped).toEqual({ reason: 'empty_catalog', keptActive: [] });
  });
});

describe('replaced provider products', () => {
  it('detects a denomination moving to a new provider id', async () => {
    // The 2026-09-15 scenario: same six denominations, new ids.
    const { deps } = harness(
      catalogWithIds({ ...LIVE_IDS, 100: '901' }).map((p) =>
        p.providerProductId === '901' ? { ...p, costUsd: usd(0.72) } : p,
      ),
      storedLive(),
    );

    const result = await syncCatalog(deps);

    expect(result.replaced).toEqual([
      {
        denomination: 100,
        fromProviderProductId: '351',
        toProviderProductId: '901',
        previousCostUsd: usd(0.5),
        currentCostUsd: usd(0.72),
      },
    ]);
    expect(result.added).toEqual(['901']);
    expect(result.deactivated).toEqual(['351']);
    expect(result.mapped).toHaveLength(6);
    expect(result.missing).toEqual([]);
  });

  it('re-points to the new product at its new cost, between upsert and deactivation', async () => {
    // Re-pointing needs the new row to exist, and must land before the old one
    // is switched off so no recipe ever points at an inactive row while its
    // replacement sits ready.
    const { deps, repointed, calls } = harness(
      catalogWithIds({ ...LIVE_IDS, 100: '901' }).map((p) =>
        p.providerProductId === '901' ? { ...p, costUsd: usd(0.72) } : p,
      ),
      storedLive(),
    );

    await syncCatalog(deps);

    expect(calls).toEqual(['upsert', 'repoint', 'deactivate']);
    expect(repointed[0]).toEqual([
      {
        denomination: 100,
        fromProviderProductId: '351',
        toProviderProductId: '901',
        costUsd: usd(0.72),
      },
    ]);
  });

  it('replaces all six at once', async () => {
    const newIds = { 100: '901', 310: '902', 520: '903', 1060: '904', 2180: '905', 5600: '906' };
    const { deps, repointed } = harness(catalogWithIds(newIds), storedLive());

    const result = await syncCatalog(deps);

    expect(result.replaced.map((r) => [r.fromProviderProductId, r.toProviderProductId])).toEqual(
      Object.keys(LIVE_IDS).map((d) => [
        LIVE_IDS[Number(d)],
        newIds[Number(d) as keyof typeof newIds],
      ]),
    );
    expect(repointed[0]).toHaveLength(6);
    expect(result.deactivated.sort()).toEqual(Object.values(LIVE_IDS).sort());
    expect(result.deactivationSkipped).toBeNull();
  });

  it('reports the rows the store actually moved', async () => {
    const { deps } = harness(
      catalogWithIds({ ...LIVE_IDS, 100: '901' }),
      storedLive(),
      () => ({ recipeItems: 4, orderItems: 2 }),
    );

    const result = await syncCatalog(deps);

    expect(result.repointed).toEqual([
      expect.objectContaining({ fromProviderProductId: '351', recipeItems: 4, orderItems: 2 }),
    ]);
  });

  it('sweeps stragglers off a product an earlier sync already retired', async () => {
    // An order created in the instant a previous sync was re-pointing can still
    // carry the old id. It gets moved on the next pass, but it is not a new
    // replacement and must not be reported as one.
    const stored = [
      ...storedLive(),
      storedRow({ providerProductId: 'ancient-100', diamondsBase: 100, active: false }),
    ];
    const { deps, repointed } = harness(catalogWithIds(LIVE_IDS), stored, (r) =>
      r.fromProviderProductId === 'ancient-100'
        ? { recipeItems: 0, orderItems: 1 }
        : { recipeItems: 0, orderItems: 0 },
    );

    const result = await syncCatalog(deps);

    expect(result.replaced).toEqual([]);
    expect(repointed[0]).toEqual([
      expect.objectContaining({ fromProviderProductId: 'ancient-100', toProviderProductId: '351' }),
    ]);
    expect(result.repointed).toEqual([
      expect.objectContaining({ fromProviderProductId: 'ancient-100', orderItems: 1 }),
    ]);
  });

  it('does not call the store at all when nothing was replaced', async () => {
    const { deps, store } = harness(catalogWithIds(LIVE_IDS), storedLive());

    const result = await syncCatalog(deps);

    expect(store.repointProducts).not.toHaveBeenCalled();
    expect(result.replaced).toEqual([]);
    expect(result.repointed).toEqual([]);
  });

  it('keeps the incumbent when the provider lists old and new side by side', async () => {
    // Mid-migration both may be listed, in an order that changes between
    // calls. Flipping on every sync would re-point recipes back and forth.
    const { deps } = harness(
      [
        product({ providerProductId: '901', diamondsBase: 100, name: 'Free Fire 100' }),
        ...catalogWithIds(LIVE_IDS),
      ],
      storedLive(),
    );

    const result = await syncCatalog(deps);

    expect(result.replaced).toEqual([]);
    expect(result.deactivated).toEqual([]);
    expect(result.added).toEqual([]);
  });

  it('still switches to a strictly better product', async () => {
    // A validatable recharge beats a games package even when the package is
    // what we sell today — the nickname check is worth the move.
    const stored = [storedRow({ providerProductId: 'game-5600', endpointKind: 'games' })];
    const { deps } = harness(
      [
        product({ providerProductId: 'game-5600', endpointKind: 'games', canValidate: false }),
        product({ providerProductId: 'pin-5600' }),
      ],
      stored,
    );

    const result = await syncCatalog(deps);

    expect(result.replaced).toEqual([
      expect.objectContaining({ fromProviderProductId: 'game-5600', toProviderProductId: 'pin-5600' }),
    ]);
    expect(result.deactivated).toEqual(['game-5600']);
  });
});

describe('a provider id that changes denomination', () => {
  it('is refused rather than silently changing what recipes deliver', async () => {
    // If the "catálogo unificado" reuses 351 for 5,600 diamonds, upserting it
    // would turn every 100-diamond recipe slot into a 5,600 purchase.
    const reused = catalogWithIds({ ...LIVE_IDS, 100: '901', 5600: '351' });
    const { deps, upserted } = harness(reused, storedLive());

    const result = await syncCatalog(deps);

    expect(result.denominationConflicts).toEqual([
      { providerProductId: '351', name: 'Free Fire 5600 Diamantes', storedDiamonds: 100, offeredDiamonds: 5600 },
    ]);
    expect(upserted[0]?.map((u) => u.providerProductId)).not.toContain('351');
    expect(result.missing).toEqual([5600]);
    expect(result.skipped[0]?.reason).toMatch(/refusing/i);
    // The stored 351 stops being sold, and 100 follows its new product.
    expect(result.deactivated).toContain('351');
    expect(result.replaced).toEqual([
      expect.objectContaining({ fromProviderProductId: '351', toProviderProductId: '901' }),
    ]);
  });

  it('withdraws the conflicted product even when the rest of the catalog is unusable', async () => {
    // Unlike an empty catalog, a conflict is positive evidence: the provider
    // has told us this id now means something else.
    const { deps, deactivated } = harness(
      [product({ providerProductId: '351', diamondsBase: 5600, name: 'Free Fire 5600' })],
      [...storedLive().filter((p) => p.diamondsBase !== 5600)],
    );

    const result = await syncCatalog(deps);

    expect(result.blocked).toBe(true);
    expect(deactivated[0]).toEqual(['351']);
    expect(result.deactivationSkipped?.keptActive).not.toContain('351');
    expect(result.deactivationSkipped?.keptActive).toHaveLength(4);
  });
});

describe('a provider id offered as two denominations in the same response', () => {
  it('refuses both instead of crashing the batch upsert', async () => {
    // Two rows in this one catalog response share id 'dup' but parse to
    // different denominations — an internally inconsistent response, not a
    // stored-vs-offered conflict. Upserting both would hand `upsertProducts`'s
    // `ON CONFLICT (provider_product_id) DO UPDATE` two rows for the same
    // target within one statement, which Postgres rejects outright.
    const catalog = catalogWithIds({ ...LIVE_IDS, 100: 'dup', 310: 'dup' });
    const { deps, upserted } = harness(catalog, storedLive());

    const result = await syncCatalog(deps);

    expect(result.blocked).toBe(false);
    expect(result.denominationConflicts).toEqual([
      {
        providerProductId: 'dup',
        name: 'Free Fire 310 Diamantes',
        storedDiamonds: 100,
        offeredDiamonds: 310,
      },
    ]);
    expect(result.skipped.find((s) => s.providerProductId === 'dup')?.reason).toMatch(
      /also offered as 100 diamonds elsewhere in this same catalog response/i,
    );
    expect(result.missing).toEqual([310]);
    expect(result.mapped).toContain(100);

    // Only one row for 'dup' ever reaches the store, whichever denomination
    // claimed it first — the crash this fix prevents was two rows sharing a
    // provider id landing in the same upsert batch.
    const dupRows = upserted.flat().filter((u) => u.providerProductId === 'dup');
    expect(dupRows).toHaveLength(1);
    expect(dupRows[0]?.diamondsBase).toBe(100);
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

  it('names each replacement with its cost move', async () => {
    const { deps } = harness(
      catalogWithIds({ ...LIVE_IDS, 100: '901' }).map((p) =>
        p.providerProductId === '901' ? { ...p, costUsd: usd(0.72) } : p,
      ),
      storedLive(),
      () => ({ recipeItems: 3, orderItems: 1 }),
    );

    const summary = summariseSync(await syncCatalog(deps));

    expect(summary).toContain('1 replaced [100: 351 -> 901 ($0.50 -> $0.72)]');
    expect(summary).toContain('re-pointed 3 recipe item(s), 1 unsent order item(s)');
  });

  it('says out loud that deactivation was skipped', async () => {
    const { deps } = harness([], storedLive());
    expect(summariseSync(await syncCatalog(deps))).toContain(
      'DEACTIVATION SKIPPED (empty_catalog, 6 kept active)',
    );
  });
});
