import { describe, expect, it } from 'vitest';
import {
  createItemOrder,
  type CreateItemOrderInput,
  type ItemForOrder,
  type ItemOrderingStore,
  type NewItemOrder,
} from './item-ordering.js';

const evoCrate = (overrides: Partial<ItemForOrder> = {}): ItemForOrder => ({
  id: 'item-1',
  sku: 'crate',
  displayName: 'Evo Crate',
  kind: 'gift',
  priceArs: 1000,
  priceMxnCents: 2100,
  maxQuantity: 10,
  minQuantity: 1,
  active: true,
  rocketpassAvailable: true,
  stockByRegion: { US: 5, SAC: 5 },
  ...overrides,
});

const weeklyMembership = (overrides: Partial<ItemForOrder> = {}): ItemForOrder => ({
  id: 'item-2',
  sku: 'weekly',
  displayName: 'Booyah Weekly',
  kind: 'membership',
  priceArs: 2000,
  priceMxnCents: 4200,
  maxQuantity: 1,
  minQuantity: 1,
  active: true,
  rocketpassAvailable: true,
  stockByRegion: {},
  ...overrides,
});

function harness(item: ItemForOrder | null, storeOverrides: Partial<ItemOrderingStore> = {}) {
  const persisted: NewItemOrder[] = [];
  const store: ItemOrderingStore = {
    findItemForOrder: async () => item,
    persist: async (order) => {
      persisted.push(order);
      return { id: 'order-1', orderNumber: order.orderNumber };
    },
    ...storeOverrides,
  };
  return { store, persisted };
}

const baseInput: CreateItemOrderInput = {
  sku: 'crate',
  quantity: 2,
  region: 'US',
  targetUid: '123456789',
  paymentMethod: 'card',
  source: 'storefront',
};

describe('createItemOrder', () => {
  it('creates an order using the admin-typed price, with cost still derived from ARS', async () => {
    const { store, persisted } = harness(evoCrate());

    const result = await createItemOrder({ store, arsRate: 0.015 }, baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // cost: 1000 ARS * 0.015 = 15 MXN = 1500 cents/unit (vendor-derived, internal only)
    // sale: 2100 cents/unit (admin-typed), x2 quantity = 4200
    expect(result.order.item.unitCostMxnCents).toBe(1500);
    expect(result.order.item.unitPriceMxnCents).toBe(2100);
    expect(result.order.priceMxnCents).toBe(4200);
    expect(result.order.item.region).toBe('US');
    expect(result.order.playerId).toBe('123456789');
    expect(persisted).toHaveLength(1);
  });

  it('rejects an unknown sku', async () => {
    const { store } = harness(null);
    const result = await createItemOrder({ store, arsRate: 0.015 }, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('ITEM_NOT_FOUND');
  });

  it('rejects a storefront purchase of an item the admin turned off', async () => {
    const { store } = harness(evoCrate({ active: false }));
    const result = await createItemOrder({ store, arsRate: 0.015 }, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('ITEM_INACTIVE');
  });

  it('allows an admin-created order even when the item is off', async () => {
    const { store } = harness(evoCrate({ active: false }));
    const result = await createItemOrder({ store, arsRate: 0.015 }, { ...baseInput, source: 'admin' });
    expect(result.ok).toBe(true);
  });

  it('rejects an item RocketPass itself no longer reports available', async () => {
    const { store } = harness(evoCrate({ rocketpassAvailable: false }));
    const result = await createItemOrder({ store, arsRate: 0.015 }, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('ITEM_UNAVAILABLE');
  });

  it('rejects an item with no price set yet, even for an admin-created order', async () => {
    const { store } = harness(evoCrate({ priceMxnCents: null }));
    const result = await createItemOrder({ store, arsRate: 0.015 }, { ...baseInput, source: 'admin' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('PRICE_NOT_SET');
  });

  it('rejects a quantity over maxQuantity', async () => {
    const { store } = harness(evoCrate({ maxQuantity: 1 }));
    const result = await createItemOrder({ store, arsRate: 0.015 }, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_QUANTITY');
  });

  it('rejects a quantity under the admin-set minQuantity', async () => {
    const { store } = harness(evoCrate({ minQuantity: 25, maxQuantity: 500, stockByRegion: { US: 500 } }));
    const result = await createItemOrder({ store, arsRate: 0.015 }, { ...baseInput, quantity: 10 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_QUANTITY');
    if (result.failure.code !== 'INVALID_QUANTITY') return;
    expect(result.failure.min).toBe(25);
  });

  it('allows a quantity at exactly minQuantity', async () => {
    const { store } = harness(evoCrate({ minQuantity: 25, maxQuantity: 500, stockByRegion: { US: 500 } }));
    const result = await createItemOrder({ store, arsRate: 0.015 }, { ...baseInput, quantity: 25 });
    expect(result.ok).toBe(true);
  });

  it('requires a region for a gift-kind item', async () => {
    const { store } = harness(evoCrate());
    const result = await createItemOrder({ store, arsRate: 0.015 }, { ...baseInput, region: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('REGION_REQUIRED');
  });

  it('rejects a quantity over the mirrored stock for that region', async () => {
    const { store } = harness(evoCrate({ stockByRegion: { US: 1 } }));
    const result = await createItemOrder({ store, arsRate: 0.015 }, baseInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('OUT_OF_STOCK');
  });

  it('never requires a region for a membership-kind item', async () => {
    const { store } = harness(weeklyMembership());
    const result = await createItemOrder(
      { store, arsRate: 0.015 },
      { ...baseInput, sku: 'weekly', quantity: 1, region: null },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.item.region).toBeNull();
  });

  it('rejects an invalid Free Fire ID', async () => {
    const { store } = harness(evoCrate());
    const result = await createItemOrder({ store, arsRate: 0.015 }, { ...baseInput, targetUid: 'abc' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_PLAYER_ID');
  });
});
