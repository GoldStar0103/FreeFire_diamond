/**
 * In-memory implementations of the engine ports, for tests.
 *
 * `MemoryStore` deliberately mirrors what the Drizzle implementation must do —
 * `markItemSending` records intent separately from settlement, so a test can
 * assert the write-before-call ordering that crash recovery depends on.
 */

import type { ProviderName, UsdTenK } from '@levelup/provider';
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
  ActiveRecipeProduct,
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
  /**
   * One entry per provider call: [providerProductId, diamonds, costUsd], with
   * an optional 4th element for which provider — defaults to
   * `'recargas_america'` so every single-provider test keeps working unchanged.
   */
  items: Array<[string, number, number] | [string, number, number, ProviderName]>;
}

export function buildOrder(options: BuildOrderOptions): OrderRecord {
  return {
    id: 'order-1',
    orderNumber: options.orderNumber ?? 'LU-000123',
    playerId: options.playerId ?? '7288567050',
    serverId: options.serverId ?? null,
    status: options.status ?? 'payment_confirmed',
    items: options.items.map(([providerProductId, diamondsBase, costUsd, provider], index) => ({
      id: `item-${index + 1}`,
      sequence: index,
      provider: provider ?? 'recargas_america',
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
  readonly products: Array<StoredProduct & { provider: ProviderName }>;
  readonly repoints: Repoint[] = [];
  moved: (r: Repoint) => { recipeItems: number; orderItems: number } = () => ({
    recipeItems: 0,
    orderItems: 0,
  });
  /**
   * What combo recipes currently point at, per denomination — kept in sync by
   * `repointProducts`. Backs `listActiveRecipeProducts`.
   *
   * Initialised from whichever `initial` products are `active: true` AND on
   * `recargas_america` — the only realistic starting state, since every
   * system predates a second provider ever being active. A dual-provider test
   * that needs a different starting point sets this map directly after
   * construction; inferring it from "any active row, any provider" would be
   * ambiguous the moment two providers both have an active row for the same
   * denomination, which is an entirely normal state (see `provider-routing.ts`).
   */
  activeRecipe = new Map<number, { provider: ProviderName; providerProductId: string }>();

  constructor(initial: Array<StoredProduct & { provider?: ProviderName }> = []) {
    this.products = initial.map((p) => ({ ...p, provider: p.provider ?? 'recargas_america' }));
    for (const p of this.products) {
      if (p.active && p.provider === 'recargas_america') {
        this.activeRecipe.set(p.diamondsBase, { provider: p.provider, providerProductId: p.providerProductId });
      }
    }
  }

  async listStoredProducts(provider: ProviderName): Promise<StoredProduct[]> {
    return this.products
      .filter((p) => p.provider === provider)
      .map(({ provider: _provider, ...rest }) => ({ ...rest }));
  }

  async upsertProducts(provider: ProviderName, products: ProductUpsert[]): Promise<void> {
    for (const p of products) {
      const existing = this.products.find(
        (s) => s.provider === provider && s.providerProductId === p.providerProductId,
      );
      const row = {
        providerProductId: p.providerProductId,
        endpointKind: p.endpointKind,
        diamondsBase: p.diamondsBase,
        costUsd: p.costUsd,
        active: true,
        provider,
      };
      if (existing) Object.assign(existing, row);
      else this.products.push({ id: `bp-${provider}-${p.providerProductId}`, ...row });
    }
  }

  async deactivateProducts(provider: ProviderName, providerProductIds: string[]): Promise<void> {
    for (const p of this.products) {
      if (p.provider === provider && providerProductIds.includes(p.providerProductId)) p.active = false;
    }
  }

  async repointProducts(repoints: Repoint[]): Promise<RepointOutcome[]> {
    this.repoints.push(...repoints);
    for (const r of repoints) {
      this.activeRecipe.set(r.denomination, {
        provider: r.toProvider,
        providerProductId: r.toProviderProductId,
      });
    }
    return repoints.map((r) => ({ ...r, ...this.moved(r) }));
  }

  async listActiveRecipeProducts(): Promise<ActiveRecipeProduct[]> {
    return [...this.activeRecipe.entries()].map(([denomination, v]) => ({ denomination, ...v }));
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
