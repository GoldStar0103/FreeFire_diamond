/**
 * In-memory implementations of the engine ports, for tests.
 *
 * `MemoryStore` deliberately mirrors what the Drizzle implementation must do —
 * `markItemSending` records intent separately from settlement, so a test can
 * assert the write-before-call ordering that crash recovery depends on.
 */

import type { UsdTenK } from '@levelup/provider';
import type {
  Alerter,
  AlertLevel,
  Clock,
  FulfillmentStore,
  ItemSettlement,
  OrderItemRecord,
  OrderRecord,
} from './ports.js';
import type { OrderStatus } from './states.js';
import type {
  CatalogSyncStore,
  ProductUpsert,
  Repoint,
  RepointOutcome,
  StoredProduct,
} from './catalog-sync.js';

export interface BuildOrderOptions {
  orderNumber?: string;
  playerId?: string;
  serverId?: string | null;
  status?: OrderStatus;
  /** One entry per provider call: [providerProductId, diamonds, costUsd]. */
  items: Array<[string, number, number]>;
}

export function buildOrder(options: BuildOrderOptions): OrderRecord {
  return {
    id: 'order-1',
    orderNumber: options.orderNumber ?? 'LU-000123',
    playerId: options.playerId ?? '7288567050',
    serverId: options.serverId ?? null,
    status: options.status ?? 'payment_confirmed',
    items: options.items.map(([providerProductId, diamondsBase, costUsd], index) => ({
      id: `item-${index + 1}`,
      sequence: index,
      providerProductId,
      diamondsBase,
      costUsd: Math.round(costUsd * 10_000) as UsdTenK,
      status: 'queued' as const,
      attemptCount: 0,
      providerReference: null,
      walletBeforeUsd: null,
    })),
  };
}

export class MemoryStore implements FulfillmentStore {
  /** Ordered log of every write, so tests can assert call ordering. */
  readonly writes: string[] = [];

  constructor(private order: OrderRecord) {}

  async loadOrder(orderId: string): Promise<OrderRecord | null> {
    if (orderId !== this.order.id) return null;
    // Deep-ish copy so callers cannot mutate stored state by accident.
    return { ...this.order, items: this.order.items.map((i) => ({ ...i })) };
  }

  async markItemSending(itemId: string, walletBeforeUsd: UsdTenK): Promise<void> {
    const item = this.find(itemId);
    item.status = 'sending';
    item.attemptCount += 1;
    item.walletBeforeUsd = walletBeforeUsd;
    this.writes.push(`sending:${itemId}`);
  }

  async settleItem(itemId: string, settlement: ItemSettlement): Promise<void> {
    const item = this.find(itemId);
    item.status = settlement.status;
    if (settlement.providerReference !== undefined) {
      item.providerReference = settlement.providerReference;
    }
    this.writes.push(`settle:${itemId}:${settlement.status}:${settlement.resolvedBy ?? '-'}`);
  }

  async updateOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
    if (orderId !== this.order.id) throw new Error(`Unknown order ${orderId}`);
    this.order.status = status;
    this.writes.push(`order:${status}`);
  }

  /** Direct access for assertions — not part of the port. */
  get current(): OrderRecord {
    return this.order;
  }

  private find(itemId: string): OrderItemRecord {
    const item = this.order.items.find((i) => i.id === itemId);
    if (!item) throw new Error(`Unknown item ${itemId}`);
    return item;
  }
}

export class MemoryAlerter implements Alerter {
  readonly sent: Array<{ level: AlertLevel; title: string; detail?: Record<string, unknown> }> = [];

  async send(level: AlertLevel, title: string, detail?: Record<string, unknown>): Promise<void> {
    this.sent.push(detail === undefined ? { level, title } : { level, title, detail });
  }

  has(level: AlertLevel): boolean {
    return this.sent.some((a) => a.level === level);
  }
}

/**
 * `base_products` in memory. Upserts and deactivations behave like the Drizzle
 * store; re-points are recorded rather than applied, since there are no recipes
 * or order items here to move — `moved` scripts what the store reports back.
 */
export class MemoryCatalogStore implements CatalogSyncStore {
  readonly products: StoredProduct[];
  readonly repoints: Repoint[] = [];
  moved: (r: Repoint) => { recipeItems: number; orderItems: number } = () => ({
    recipeItems: 0,
    orderItems: 0,
  });

  constructor(initial: StoredProduct[] = []) {
    this.products = initial.map((p) => ({ ...p }));
  }

  async listStoredProducts(): Promise<StoredProduct[]> {
    return this.products.map((p) => ({ ...p }));
  }

  async upsertProducts(products: ProductUpsert[]): Promise<void> {
    for (const p of products) {
      const existing = this.products.find((s) => s.providerProductId === p.providerProductId);
      const row = {
        providerProductId: p.providerProductId,
        endpointKind: p.endpointKind,
        diamondsBase: p.diamondsBase,
        costUsd: p.costUsd,
        active: true,
      };
      if (existing) Object.assign(existing, row);
      else this.products.push({ id: `bp-${p.providerProductId}`, ...row });
    }
  }

  async deactivateProducts(providerProductIds: string[]): Promise<void> {
    for (const p of this.products) {
      if (providerProductIds.includes(p.providerProductId)) p.active = false;
    }
  }

  async repointProducts(repoints: Repoint[]): Promise<RepointOutcome[]> {
    this.repoints.push(...repoints);
    return repoints.map((r) => ({ ...r, ...this.moved(r) }));
  }
}

/** Sleeps resolve instantly but are recorded, so delay behaviour stays testable. */
export class FakeClock implements Clock {
  readonly sleeps: number[] = [];
  private t = 1_700_000_000_000;

  now(): number {
    return this.t;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
  }
}
