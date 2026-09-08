import { describe, expect, it, vi } from 'vitest';
import type { UsdTenK } from '@levelup/provider';
import {
  createOrder,
  defaultOrderNumber,
  type ComboForOrder,
  type CreateOrderInput,
  type NewOrder,
  type OrderingStore,
  type RecipeEntry,
} from './ordering.js';

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

const entry = (sequence: number, diamondsBase: number, overrides: Partial<RecipeEntry> = {}): RecipeEntry => ({
  sequence,
  baseProductId: `bp-${diamondsBase}`,
  providerProductId: `d${diamondsBase}`,
  endpointKind: 'pins_recharge',
  diamondsBase,
  costUsd: usd(diamondsBase / 200),
  active: true,
  requiresServerId: false,
  ...overrides,
});

/**
 * Mega Prime 48k — 5,600 eight times, advertised as 48,800.
 *
 * When a test overrides the recipe without also setting `advertisedDiamonds`,
 * the advertised figure is derived from what the new recipe delivers. Otherwise
 * the under-delivery guard fires first and masks whatever the test is actually
 * about.
 */
const megaPrime48k = (overrides: Partial<ComboForOrder> = {}): ComboForOrder => {
  const recipe = overrides.recipe ?? Array.from({ length: 8 }, (_, i) => entry(i, 5600));
  const delivered = recipe.reduce((sum, r) => sum + (r.diamondsBase * 110) / 100, 0);

  return {
    id: 'combo-1',
    key: 'mega_prime_48k',
    name: 'Mega Prime 48k +800',
    campaignName: 'PACKS MEGA PRIME',
    priceMxnCents: 585_000,
    advertisedDiamonds: overrides.recipe ? delivered : 48_800,
    maxPerPlayer: null,
    active: true,
    startsAt: null,
    endsAt: null,
    campaignActive: true,
    ...overrides,
    recipe,
  };
};

function harness(combo: ComboForOrder | null, priorOrders = 0) {
  const persisted: NewOrder[] = [];
  const store: OrderingStore = {
    findComboForOrder: vi.fn(async () => combo),
    countPlayerOrders: vi.fn(async () => priorOrders),
    persist: vi.fn(async (order: NewOrder) => {
      persisted.push(order);
      return { id: 'order-1', orderNumber: order.orderNumber };
    }),
  };
  return {
    store,
    persisted,
    deps: {
      store,
      now: () => new Date('2026-09-15T12:00:00Z'),
      generateOrderNumber: () => 'LU-260915-TEST',
    },
  };
}

const input = (overrides: Partial<CreateOrderInput> = {}): CreateOrderInput => ({
  comboKey: 'mega_prime_48k',
  playerId: '7288567050',
  paymentMethod: 'transfer_manual',
  source: 'storefront',
  ...overrides,
});

describe('combo expansion', () => {
  it('turns one purchase into eight provider calls', async () => {
    const { deps, persisted } = harness(megaPrime48k());

    const result = await createOrder(deps, input());

    expect(result.ok).toBe(true);
    expect(persisted[0]?.items).toHaveLength(8);
    expect(persisted[0]?.priceMxnCents).toBe(585_000);
  });

  it('re-indexes sequence so gaps cannot look like missing calls', async () => {
    const combo = megaPrime48k({
      recipe: [entry(3, 5600), entry(11, 2180), entry(7, 1060)],
    });
    const { deps, persisted } = harness(combo);

    await createOrder(deps, input());

    // Sorted by the stored sequence, then renumbered contiguously.
    expect(persisted[0]?.items.map((i) => i.sequence)).toEqual([0, 1, 2]);
    expect(persisted[0]?.items.map((i) => i.diamondsBase)).toEqual([5600, 1060, 2180]);
  });

  it('snapshots price, recipe and cost at creation', async () => {
    const { deps, persisted } = harness(megaPrime48k());

    await createOrder(deps, input());
    const snapshot = persisted[0]!.comboSnapshot;

    // An OXXO voucher paid weeks later must still deliver this recipe, even if
    // the client has since edited or retired the combo.
    expect(snapshot.recipe).toHaveLength(8);
    expect(snapshot.deliveredDiamonds).toBe(49_280);
    expect(snapshot.advertisedDiamonds).toBe(48_800);
    expect(snapshot.recipe[0]?.costUsd).toBe('28.0000');
    expect(snapshot.frozenAt).toBe('2026-09-15T12:00:00.000Z');
  });

  it('carries provider cost onto each item for wallet reconciliation', async () => {
    const { deps, persisted } = harness(megaPrime48k());
    await createOrder(deps, input());
    expect(persisted[0]?.items.every((i) => i.costUsd === usd(28))).toBe(true);
  });
});

describe('recipe validation', () => {
  it('refuses a combo that delivers less than it advertises', async () => {
    // Pack Good: 2,180 + 1,060 delivers 3,564 against 3,600 advertised.
    const combo = megaPrime48k({
      name: 'Pack Good',
      advertisedDiamonds: 3600,
      recipe: [entry(0, 2180), entry(1, 1060)],
    });
    const { deps, persisted } = harness(combo);

    const result = await createOrder(deps, input());

    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'RECIPE_UNDER_DELIVERS', advertised: 3600, delivered: 3564 },
    });
    expect(persisted).toHaveLength(0);
  });

  it('accepts exact delivery', async () => {
    const combo = megaPrime48k({ advertisedDiamonds: 110, recipe: [entry(0, 100)] });
    expect((await createOrder(harness(combo).deps, input())).ok).toBe(true);
  });

  it('refuses an empty recipe', async () => {
    const { deps } = harness(megaPrime48k({ recipe: [] }));
    expect(await createOrder(deps, input())).toMatchObject({
      failure: { code: 'RECIPE_EMPTY' },
    });
  });

  it('refuses when a provider product has gone inactive', async () => {
    const combo = megaPrime48k({ recipe: [entry(0, 5600, { active: false })] });
    expect(await createOrder(harness(combo).deps, input())).toMatchObject({
      failure: { code: 'PRODUCT_UNAVAILABLE' },
    });
  });

  it('refuses when the catalog has never been synced', async () => {
    // Without a cost, every ambiguous call on this order would escalate.
    const combo = megaPrime48k({ recipe: [entry(0, 5600, { costUsd: null })] });
    expect(await createOrder(harness(combo).deps, input())).toMatchObject({
      failure: { code: 'CATALOG_NOT_SYNCED' },
    });
  });
});

describe('availability', () => {
  it('refuses an inactive combo on the storefront', async () => {
    const { deps } = harness(megaPrime48k({ active: false }));
    expect(await createOrder(deps, input())).toMatchObject({
      failure: { code: 'COMBO_INACTIVE' },
    });
  });

  it('refuses when the campaign itself is off', async () => {
    const { deps } = harness(megaPrime48k({ campaignActive: false }));
    expect(await createOrder(deps, input())).toMatchObject({
      failure: { code: 'COMBO_INACTIVE' },
    });
  });

  it('refuses a combo whose window has closed', async () => {
    const { deps } = harness(megaPrime48k({ endsAt: new Date('2026-09-01T00:00:00Z') }));
    expect(await createOrder(deps, input())).toMatchObject({
      failure: { code: 'COMBO_EXPIRED' },
    });
  });

  it('lets an admin create an order for a retired combo', async () => {
    // A customer who paid before the monthly rotation still needs their order.
    const { deps } = harness(
      megaPrime48k({ active: false, endsAt: new Date('2026-09-01T00:00:00Z') }),
    );
    expect((await createOrder(deps, input({ source: 'admin' }))).ok).toBe(true);
  });

  it('still enforces the recipe check for admins', async () => {
    // Availability is a business decision; under-delivering is never one.
    const combo = megaPrime48k({ advertisedDiamonds: 3600, recipe: [entry(0, 2180), entry(1, 1060)] });
    expect(await createOrder(harness(combo).deps, input({ source: 'admin' }))).toMatchObject({
      failure: { code: 'RECIPE_UNDER_DELIVERS' },
    });
  });
});

describe('the Mega Oferta cap', () => {
  const megaOferta = (overrides: Partial<ComboForOrder> = {}) =>
    megaPrime48k({
      key: 'mega_10',
      name: 'Mega Oferta 110',
      priceMxnCents: 1_000,
      advertisedDiamonds: 110,
      maxPerPlayer: 1,
      recipe: [entry(0, 100)],
      ...overrides,
    });

  it('allows a first-time buyer', async () => {
    const { deps } = harness(megaOferta(), 0);
    expect((await createOrder(deps, input({ comboKey: 'mega_10' }))).ok).toBe(true);
  });

  it('refuses a second purchase — "válido solo para clientes nuevos"', async () => {
    const { deps, persisted } = harness(megaOferta(), 1);

    expect(await createOrder(deps, input({ comboKey: 'mega_10' }))).toMatchObject({
      failure: { code: 'PLAYER_LIMIT_REACHED', limit: 1 },
    });
    expect(persisted).toHaveLength(0);
  });

  it('does not check the cap for uncapped combos', async () => {
    const { store } = harness(megaPrime48k(), 5);
    await createOrder({ store }, input());
    expect(store.countPlayerOrders).not.toHaveBeenCalled();
  });
});

describe('player identity', () => {
  it.each(['abc', '123', '', '7288567050x', '1'.repeat(20)])(
    'rejects %s as a Free Fire ID',
    async (playerId) => {
      const { deps } = harness(megaPrime48k());
      expect(await createOrder(deps, input({ playerId }))).toMatchObject({
        failure: { code: 'INVALID_PLAYER_ID' },
      });
    },
  );

  it('keeps the validated nickname as evidence', async () => {
    const { deps, persisted } = harness(megaPrime48k());
    await createOrder(deps, input({ playerNickname: 'ElCarneseca' }));
    expect(persisted[0]?.playerNickname).toBe('ElCarneseca');
  });

  it('requires a server ID when the product needs one', async () => {
    const combo = megaPrime48k({ recipe: [entry(0, 5600, { requiresServerId: true })] });
    expect(await createOrder(harness(combo).deps, input())).toMatchObject({
      failure: { code: 'SERVER_ID_REQUIRED' },
    });
  });

  it('accepts it when supplied', async () => {
    const combo = megaPrime48k({ recipe: [entry(0, 5600, { requiresServerId: true })] });
    expect((await createOrder(harness(combo).deps, input({ serverId: 'EE.UU.' }))).ok).toBe(true);
  });
});

describe('missing combo', () => {
  it('fails cleanly', async () => {
    const { deps } = harness(null);
    expect(await createOrder(deps, input())).toMatchObject({
      failure: { code: 'COMBO_NOT_FOUND' },
    });
  });
});

describe('defaultOrderNumber', () => {
  it('is short enough to read over WhatsApp', () => {
    const number = defaultOrderNumber(new Date('2026-09-15T12:00:00Z'));
    expect(number).toMatch(/^LU-260915-[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('does not leak daily order volume the way a counter would', () => {
    const now = new Date('2026-09-15T12:00:00Z');
    const generated = new Set(Array.from({ length: 200 }, () => defaultOrderNumber(now)));
    expect(generated.size).toBeGreaterThan(150);
  });
});
