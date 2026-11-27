import { describe, expect, it, vi } from 'vitest';
import { ProviderSimulator, type UsdTenK } from '@levelup/provider';
import { InMemoryLock, PROVIDER_LOCK_KEYS } from '@levelup/engine';
import {
  MemoryAlerter,
  MemoryCatalogStore,
  MemoryStore,
  buildOrder,
} from '@levelup/engine/testing';
import type {
  AdvisoryLock,
  ExpiryStore,
  ItemFulfillmentStore,
  OverduePayment,
  RecoveryStore,
  RocketPassOrderClient,
  StalledItem,
  StoredProduct,
  StuckGatewayPayment,
  StuckPaymentStore,
} from '@levelup/engine';
import { loadConfig } from './config.js';
import {
  CATALOG_SYNC_RETRY_MS,
  CatalogSyncSchedule,
  checkWallet,
  ORDER_BOUNDARY_KEY,
  runCatalogSync,
  runFulfillmentLoop,
  runGatewayReconcile,
  runItemFulfillmentLoop,
  runItemReconcile,
  runRocketPassSync,
  runSweepOnce,
  ShutdownSignal,
  type RunnerDeps,
} from './runner.js';

class QueueStore extends MemoryStore implements RecoveryStore, ExpiryStore, StuckPaymentStore {
  async findPendingProviderItems(): Promise<StalledItem[]> {
    return [];
  }
  async findStalledSendingItems(): Promise<StalledItem[]> {
    return [];
  }
  async findOverduePayments(): Promise<OverduePayment[]> {
    return [];
  }
  async expirePayment(): Promise<void> {
    return undefined;
  }
  async findStuckGatewayPayments(): Promise<StuckGatewayPayment[]> {
    return [];
  }
  async markStuckAlertSent(): Promise<void> {
    return undefined;
  }
}

/**
 * `finally`, not a trailing restore — a test that expects loadConfig to throw
 * would otherwise leak its override into every test that follows.
 */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, env);
    return fn();
  } finally {
    process.env = previous;
  }
}

function testConfig(overrides: Record<string, string> = {}) {
  return withEnv(
    {
      DATABASE_URL: 'postgres://x@localhost/x',
      WORKER_DRY_RUN: 'true',
      FULFILLMENT_IDLE_POLL_MS: '1',
      ...overrides,
    },
    loadConfig,
  );
}

function harness(
  claims: Array<{ id: string; orderNumber: string; recovered: boolean } | null>,
  isEmergencyMode: () => Promise<boolean> = async () => false,
) {
  const store = new QueueStore(
    buildOrder({ orderNumber: 'LU-1', items: [['d100', 100, 0.55]] }),
  );
  const alerter = new MemoryAlerter();
  const provider = new ProviderSimulator({ initialBalanceUsd: 500, prices: { d100: 0.55 } });
  provider.program({ mode: 'succeed' });
  // A separate, never-programmed simulator — every existing single-provider
  // test manipulates only `provider` (RA's), so Central One's sync stays on
  // its own quiet, unchanging default catalog throughout and never adds a
  // second alert these tests do not expect.
  const centralOneProvider = new ProviderSimulator({ initialBalanceUsd: 500 });

  const queue = {
    claimNext: vi.fn(async () => claims.shift() ?? null),
    depth: vi.fn(async () => ({ payment_confirmed: 1 })),
  };

  const catalog = new MemoryCatalogStore();

  const deps: RunnerDeps = {
    queue,
    store,
    catalog,
    providers: { recargas_america: provider, central_one: centralOneProvider },
    lock: new InMemoryLock(),
    orderBoundary: new InMemoryLock(),
    alerter,
    config: testConfig(),
    isEmergencyMode,
    // Checkout Pro/Stripe not configured in these tests — the sweep step is
    // a no-op; its own behavior is covered directly in
    // @levelup/engine's gateway-reconcile.test.ts and runGatewayReconcile's
    // own test below.
    gatewayReconcile: { store: new FakeGatewayReconcileStore(), mercadoPagoCheckoutPro: null, stripe: null },
    // RocketPass not configured in these tests — the sweep step is a no-op;
    // its own behavior is covered directly in @levelup/engine's
    // item-reconcile.test.ts and runItemReconcile's own test below.
    itemReconcile: null,
  };
  return { deps, queue, store, catalog, alerter, provider, centralOneProvider };
}

class FakeGatewayReconcileStore {
  async listPendingGatewayPayments(): Promise<never[]> {
    return [];
  }
  async findPayable(): Promise<null> {
    return null;
  }
  async confirmPayment(): Promise<void> {
    return undefined;
  }
  async flagMismatch(): Promise<void> {
    return undefined;
  }
  async rejectPayment(): Promise<void> {
    return undefined;
  }
  async expirePayment(): Promise<void> {
    return undefined;
  }
}

describe('runFulfillmentLoop', () => {
  it('claims and fulfils an available order', async () => {
    const { deps, provider } = harness([{ id: 'order-1', orderNumber: 'LU-1', recovered: false }]);

    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 2 });

    expect(result.processed).toBe(1);
    expect(provider.deliveryCount).toBe(1);
  });

  it('idles without error when the queue is empty', async () => {
    const { deps, queue } = harness([]);

    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 3 });

    expect(result.processed).toBe(0);
    expect(queue.claimNext).toHaveBeenCalledTimes(3);
  });

  it('stops claiming once shutdown is requested', async () => {
    const { deps, queue } = harness([]);
    const signal = new ShutdownSignal();
    signal.stop();

    await runFulfillmentLoop(deps, signal, { maxIterations: 5 });

    expect(queue.claimNext).not.toHaveBeenCalled();
  });

  it('survives a database blip while claiming', async () => {
    const { deps, queue } = harness([]);
    queue.claimNext
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(null);

    // A transient database error must not take the worker down.
    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 2 });

    expect(result.processed).toBe(0);
    expect(queue.claimNext).toHaveBeenCalledTimes(2);
  });

  it('alerts and keeps going when fulfilment throws', async () => {
    const { deps, alerter } = harness([
      { id: 'does-not-exist', orderNumber: 'LU-404', recovered: false },
    ]);

    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 1 });

    // The order stays `processing`; the staleness window brings it back rather
    // than us guessing what the provider did.
    expect(result.processed).toBe(0);
    expect(alerter.has('critical')).toBe(true);
  });

  it('logs a recovered order distinctly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = harness([{ id: 'order-1', orderNumber: 'LU-1', recovered: true }]);

    await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 1 });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Recovered abandoned order LU-1'));
    warn.mockRestore();
  });
});

describe('runFulfillmentLoop and the catalog sync', () => {
  it('holds the order boundary for the whole of each order', async () => {
    // What keeps a re-point out of the gap between two calls of one combo.
    const { deps } = harness([{ id: 'order-1', orderNumber: 'LU-1', recovered: false }]);
    const boundary = vi.spyOn(deps.orderBoundary, 'withLock');

    await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 1 });

    expect(boundary).toHaveBeenCalledWith(ORDER_BOUNDARY_KEY, expect.any(Function));
  });
});

describe('runFulfillmentLoop in emergency mode', () => {
  it('holds a claimed order for manual fulfillment instead of calling the provider', async () => {
    const { deps, store, alerter, provider } = harness(
      [{ id: 'order-1', orderNumber: 'LU-1', recovered: false }],
      async () => true,
    );
    store.current.status = 'processing';

    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 1 });

    expect(result.processed).toBe(1);
    expect(provider.deliveryCount).toBe(0);
    expect(store.current.status).toBe('needs_review');
    expect(store.current.items.every((i) => i.status === 'queued')).toBe(true);
    expect(alerter.sent).toEqual([
      expect.objectContaining({ level: 'warn', title: expect.stringMatching(/emergency mode/i) }),
    ]);
  });

  it('defaults to automatic fulfillment when the flag cannot be read', async () => {
    const { deps, provider } = harness(
      [{ id: 'order-1', orderNumber: 'LU-1', recovered: false }],
      async () => {
        throw new Error('settings table unreachable');
      },
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 1 });

    expect(result.processed).toBe(1);
    expect(provider.deliveryCount).toBe(1);
    error.mockRestore();
  });
});

function itemHarness(
  claims: Array<{ id: string; orderNumber: string; recovered: boolean } | null>,
  respond: (orderId: string) => Promise<{ order: { orderId: string; status: 'DELIVERED' | 'FAILED' } }>,
) {
  const alerter = new MemoryAlerter();
  const queue = { claimNext: vi.fn(async () => claims.shift() ?? null) };
  const applied: unknown[] = [];
  const store: ItemFulfillmentStore = {
    loadItemOrder: async (id) => ({
      id,
      orderNumber: 'LU-ITEM-1',
      playerId: '7288567050',
      sku: 'crate',
      itemName: 'Universal Evo Token Crate',
      quantity: 1,
      region: 'SAC',
      fulfillmentStatus: 'pending',
      rocketpassOrderId: null,
      attemptCount: 0,
    }),
    markSending: async () => undefined,
    applyDecision: async (id, decision) => {
      applied.push({ id, decision });
    },
  };
  const client: RocketPassOrderClient = { createOrder: async (input) => respond(input.targetUid) };
  const deps = {
    queue,
    store,
    client,
    alerter,
    config: { maxAttempts: 3, staleOrderMs: 300_000, idlePollMs: 1 },
  };
  return { deps, queue, alerter, applied };
}

describe('runItemFulfillmentLoop', () => {
  it('claims and places an item order', async () => {
    const { deps, applied } = itemHarness(
      [{ id: 'item-order-1', orderNumber: 'LU-ITEM-1', recovered: false }],
      async () => ({ order: { orderId: 'ORD-1', status: 'DELIVERED' } }),
    );

    const result = await runItemFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 2 });

    expect(result.processed).toBe(1);
    expect(applied).toEqual([
      { id: 'item-order-1', decision: expect.objectContaining({ itemStatus: 'delivered', orderStatus: 'completed' }) },
    ]);
  });

  it('idles without error when the queue is empty', async () => {
    const { deps, queue } = itemHarness([], async () => ({ order: { orderId: 'ORD-1', status: 'DELIVERED' } }));

    const result = await runItemFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 3 });

    expect(result.processed).toBe(0);
    expect(queue.claimNext).toHaveBeenCalledTimes(3);
  });

  it('alerts and keeps the order processing (not failed) when fulfillment throws unexpectedly', async () => {
    const { deps, alerter } = itemHarness([{ id: 'item-order-1', orderNumber: 'LU-ITEM-1', recovered: false }], async () => {
      throw new Error('boom');
    });
    // `fulfillItemOrder` itself catches RocketPassError/network errors — this
    // throw simulates something the store or client does that isn't one of
    // those (e.g. a DB connection drop), which the loop's own try/catch must
    // still survive without crashing the worker.
    deps.store.loadItemOrder = async () => {
      throw new Error('boom');
    };

    const result = await runItemFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 1 });

    expect(result.processed).toBe(0);
    expect(alerter.has('critical')).toBe(true);
  });

  it('stops claiming once shutdown is requested', async () => {
    const signal = new ShutdownSignal();
    const { deps, queue } = itemHarness(
      [
        { id: 'item-order-1', orderNumber: 'LU-ITEM-1', recovered: false },
        { id: 'item-order-2', orderNumber: 'LU-ITEM-2', recovered: false },
      ],
      async () => {
        signal.stop();
        return { order: { orderId: 'ORD-1', status: 'DELIVERED' } };
      },
    );

    await runItemFulfillmentLoop(deps, signal, { maxIterations: 5 });
    expect(queue.claimNext).toHaveBeenCalledTimes(1);
  });
});

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

/** What the harness simulator's default catalog looks like once stored. */
const storedLike = (idFor: (d: number) => string): StoredProduct[] =>
  [100, 310, 520, 1060, 2180, 5600].map((d) => ({
    id: `bp-${d}`,
    providerProductId: idFor(d),
    endpointKind: 'pins_recharge',
    diamondsBase: d,
    costUsd: usd(d === 100 ? 0.55 : 10),
    active: true,
  }));

describe('runCatalogSync', () => {
  it('stays quiet when nothing changed', async () => {
    // It runs hourly. A channel that pings hourly with "all fine" gets muted.
    const { deps, alerter } = harness([]);

    await runCatalogSync(deps); // first sighting of all six
    await runCatalogSync(deps);

    expect(alerter.sent).toEqual([]);
  });

  it('warns when the provider moves a denomination to a new id', async () => {
    const { deps, alerter } = harness([]);
    const catalog = new MemoryCatalogStore(storedLike((d) => (d === 100 ? '351' : `d${d}`)));

    const result = await runCatalogSync({ ...deps, catalog });

    expect(result.recargas_america?.replaced).toHaveLength(1);
    expect(catalog.repoints).toEqual([
      expect.objectContaining({ fromProviderProductId: '351', toProviderProductId: 'd100' }),
    ]);
    expect(alerter.has('critical')).toBe(false);
    const warning = alerter.sent.find((a) => a.level === 'warn');
    expect(warning?.title).toMatch(/ids changed/i);
    expect(String(warning?.detail?.replaced)).toContain('351 -> d100');
  });

  it('is critical when the catalog comes back empty, and deactivates nothing', async () => {
    const { deps, alerter, provider, catalog } = harness([]);
    await runCatalogSync(deps);
    provider.programCatalog([]);

    const result = await runCatalogSync(deps);

    expect(result.recargas_america?.deactivationSkipped?.reason).toBe('empty_catalog');
    expect(catalog.products.every((p) => p.active)).toBe(true);
    expect(alerter.sent).toEqual([
      expect.objectContaining({ level: 'critical', title: expect.stringMatching(/nothing was deactivated/) }),
    ]);
  });

  it('is critical when a denomination disappears', async () => {
    const { deps, alerter, provider } = harness([]);
    const full = await provider.listFreeFireCatalog();
    await runCatalogSync(deps);
    provider.programCatalog(full.filter((p) => p.diamondsBase !== 310));

    await runCatalogSync(deps);

    expect(alerter.sent).toEqual([
      expect.objectContaining({ level: 'critical', detail: expect.objectContaining({ missing: '310' }) }),
    ]);
  });

  it('survives a provider failure and says so', async () => {
    const { deps, alerter, provider, catalog } = harness([]);
    provider.programCatalog(null, 'HTTP 502');

    await expect(runCatalogSync(deps)).resolves.toMatchObject({ recargas_america: null });

    // Central One's own, independent sync still succeeded quietly.
    expect(catalog.products.filter((p) => p.provider === 'recargas_america')).toEqual([]);
    expect(alerter.sent[0]).toMatchObject({ level: 'warn', title: expect.stringMatching(/failed/) });
  });

  it('survives an alerter that throws', async () => {
    const { deps, provider } = harness([]);
    provider.programCatalog(null, 'HTTP 502');
    const alerter = {
      send: async () => {
        throw new Error('telegram down');
      },
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(runCatalogSync({ ...deps, alerter })).resolves.toMatchObject({
      recargas_america: null,
    });
    error.mockRestore();
  });

  it('runs under the provider lock and the order boundary', async () => {
    // The provider lock keeps a re-point out of any call in flight; the
    // boundary keeps it out of the gaps between one combo's calls.
    const { deps, catalog } = harness([]);
    const held = new Set<string>();
    const recording: AdvisoryLock = {
      async withLock(key, fn) {
        held.add(key);
        try {
          return await fn();
        } finally {
          held.delete(key);
        }
      },
    };
    const seen: string[][] = [];
    const list = catalog.listStoredProducts.bind(catalog);
    catalog.listStoredProducts = async (provider) => {
      seen.push([...held].sort());
      return list(provider);
    };

    await runCatalogSync({ ...deps, lock: recording, orderBoundary: recording });

    expect(seen).toEqual([
      [PROVIDER_LOCK_KEYS.recargas_america, ORDER_BOUNDARY_KEY].sort(),
      [PROVIDER_LOCK_KEYS.central_one, ORDER_BOUNDARY_KEY].sort(),
    ]);
    expect(held.size).toBe(0);
  });

  it('waits for the order in flight to finish before touching the catalog', async () => {
    const { deps, catalog } = harness([]);
    let finishOrder!: () => void;
    const inFlight = deps.orderBoundary.withLock(
      ORDER_BOUNDARY_KEY,
      () => new Promise<void>((resolve) => (finishOrder = resolve)),
    );
    const list = vi.spyOn(catalog, 'listStoredProducts');

    const sync = runCatalogSync(deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(list).not.toHaveBeenCalled();

    finishOrder();
    await inFlight;
    await sync;
    // Once per provider — RA then Central One.
    expect(list).toHaveBeenCalledTimes(2);
  });
});

describe('CatalogSyncSchedule', () => {
  it('runs at startup, then once per interval', async () => {
    const { deps } = harness([]);
    const schedule = new CatalogSyncSchedule(60_000);

    expect((await schedule.runIfDue(deps, 1_000)).ran).toBe(true); // startup
    expect((await schedule.runIfDue(deps, 30_000)).ran).toBe(false);
    expect((await schedule.runIfDue(deps, 60_999)).ran).toBe(false);
    expect((await schedule.runIfDue(deps, 61_000)).ran).toBe(true);
  });

  it('retries sooner than a full interval after a failure', async () => {
    // On migration day, an hour between attempts is an hour of not knowing.
    const { deps, provider } = harness([]);
    provider.programCatalog(null, 'HTTP 502');
    const schedule = new CatalogSyncSchedule(60 * 60_000);

    const first = await schedule.runIfDue(deps, 0);
    expect(first.ran).toBe(true);
    expect(first.result?.recargas_america).toBeNull();
    expect((await schedule.runIfDue(deps, CATALOG_SYNC_RETRY_MS - 1)).ran).toBe(false);

    provider.programCatalog(null);
    const retry = await schedule.runIfDue(deps, CATALOG_SYNC_RETRY_MS);
    expect(retry.ran).toBe(true);
    expect(retry.result?.recargas_america?.mapped).toHaveLength(6);

    // Back on the normal cadence once it succeeds.
    expect((await schedule.runIfDue(deps, CATALOG_SYNC_RETRY_MS * 2)).ran).toBe(false);
  });

  it('is off entirely at 0, startup included', async () => {
    const { deps, provider } = harness([]);
    const list = vi.spyOn(provider, 'listFreeFireCatalog');
    const schedule = new CatalogSyncSchedule(0);

    expect(schedule.enabled).toBe(false);
    expect((await schedule.runIfDue(deps, 0)).ran).toBe(false);
    expect((await schedule.runIfDue(deps, 10 * 60 * 60_000)).ran).toBe(false);
    expect(list).not.toHaveBeenCalled();
  });
});

describe('checkWallet', () => {
  it('alerts when the balance drops below the threshold', async () => {
    const { deps, alerter } = harness([]);
    const provider = new ProviderSimulator({ initialBalanceUsd: 10 });

    await checkWallet({ ...deps, providers: { ...deps.providers, recargas_america: provider } });

    expect(alerter.has('critical')).toBe(true);
    expect(alerter.sent[0]?.title).toMatch(/wallet is low/i);
  });

  it('stays quiet when the balance is healthy', async () => {
    const { deps, alerter } = harness([]);
    await checkWallet(deps);
    expect(alerter.sent).toHaveLength(0);
  });

  it('does not throw when the wallet cannot be read', async () => {
    const { deps } = harness([]);
    const provider = {
      ...deps.providers.recargas_america,
      getBalance: async () => {
        throw new Error('provider down');
      },
    } as typeof deps.providers.recargas_america;

    await expect(
      checkWallet({ ...deps, providers: { ...deps.providers, recargas_america: provider } }),
    ).resolves.toBeUndefined();
  });
});

describe('runGatewayReconcile', () => {
  it('does nothing when neither gateway is configured on this deployment', async () => {
    const { deps } = harness([]);
    const listPendingGatewayPayments = vi.fn(async () => []);

    await runGatewayReconcile({
      ...deps,
      gatewayReconcile: {
        store: { ...deps.gatewayReconcile.store, listPendingGatewayPayments },
        mercadoPagoCheckoutPro: null,
        stripe: null,
      },
    });

    expect(listPendingGatewayPayments).not.toHaveBeenCalled();
  });

  it('settles a pending payment Mercado Pago now reports paid, using the sweep config knobs', async () => {
    const { deps } = harness([]);
    const confirmPayment = vi.fn(async () => undefined);
    const store = {
      ...deps.gatewayReconcile.store,
      listPendingGatewayPayments: vi.fn(async () => [
        { paymentId: 'pay-1', orderId: 'order-1', orderNumber: 'LU-261126-AB12', gatewayChargeId: 'LU-261126-AB12' },
      ]),
      findPayable: vi.fn(async () => ({
        orderId: 'order-1',
        orderNumber: 'LU-261126-AB12',
        orderStatus: 'pending_payment' as const,
        paymentId: 'pay-1',
        paymentStatus: 'pending' as const,
        method: 'card' as const,
        amountExpectedCents: 86_000,
        expiresAt: null,
      })),
      confirmPayment,
    };
    const getCharge = vi.fn(async () => ({ state: 'paid' as const, amountReceivedCents: 86_000, reference: 'mp-ref-1' }));

    await runGatewayReconcile({
      ...deps,
      gatewayReconcile: { store, mercadoPagoCheckoutPro: { getCharge }, stripe: null },
    });

    expect(store.listPendingGatewayPayments).toHaveBeenCalledWith({
      gateway: 'mercadopago',
      olderThanMs: deps.config.sweeps.minAgeMs,
      limit: deps.config.sweeps.batchSize,
    });
    expect(getCharge).toHaveBeenCalledWith('LU-261126-AB12');
    expect(confirmPayment).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1', amountReceivedCents: 86_000 }));
  });

  it('does not throw when the Mercado Pago gateway check itself fails', async () => {
    const { deps } = harness([]);
    const store = {
      ...deps.gatewayReconcile.store,
      listPendingGatewayPayments: vi.fn(async () => [
        { paymentId: 'pay-1', orderId: 'order-1', orderNumber: 'LU-261126-AB12', gatewayChargeId: 'LU-261126-AB12' },
      ]),
    };
    const getCharge = vi.fn(async () => {
      throw new Error('Mercado Pago unreachable');
    });

    await expect(
      runGatewayReconcile({ ...deps, gatewayReconcile: { store, mercadoPagoCheckoutPro: { getCharge }, stripe: null } }),
    ).resolves.toBeUndefined();
  });

  // Added 2026-11-27 — see ./stripe.ts's own doc comment: Stripe's embedded
  // card flow had no proactive reconcile at all, only the webhook and the
  // order-page fallback, which is exactly what let a real, already-paid
  // Stripe charge get retired as NOT_AWAITING_PAYMENT before either of those
  // two caught up with it.
  it('settles a pending payment Stripe now reports paid, independently of Mercado Pago', async () => {
    const { deps } = harness([]);
    const confirmPayment = vi.fn(async () => undefined);
    const store = {
      ...deps.gatewayReconcile.store,
      listPendingGatewayPayments: vi.fn(async (input: { gateway: string }) =>
        input.gateway === 'stripe'
          ? [{ paymentId: 'pay-2', orderId: 'order-2', orderNumber: 'LU-261127-N7JH', gatewayChargeId: 'pi_abc123' }]
          : [],
      ),
      findPayable: vi.fn(async () => ({
        orderId: 'order-2',
        orderNumber: 'LU-261127-N7JH',
        orderStatus: 'pending_payment' as const,
        paymentId: 'pay-2',
        paymentStatus: 'pending' as const,
        method: 'card' as const,
        amountExpectedCents: 1_500,
        expiresAt: null,
      })),
      confirmPayment,
    };
    const getCharge = vi.fn(async () => ({ state: 'paid' as const, amountReceivedCents: 1_500, reference: 'pi_abc123' }));

    await runGatewayReconcile({
      ...deps,
      gatewayReconcile: { store, mercadoPagoCheckoutPro: null, stripe: { getCharge } },
    });

    expect(store.listPendingGatewayPayments).toHaveBeenCalledWith({
      gateway: 'stripe',
      olderThanMs: deps.config.sweeps.minAgeMs,
      limit: deps.config.sweeps.batchSize,
    });
    expect(getCharge).toHaveBeenCalledWith('pi_abc123');
    expect(confirmPayment).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-2', amountReceivedCents: 1_500 }));
  });

  it('does not throw when the Stripe gateway check itself fails, and still runs Mercado Pago', async () => {
    const { deps } = harness([]);
    const mpConfirmPayment = vi.fn(async () => undefined);
    const store = {
      ...deps.gatewayReconcile.store,
      listPendingGatewayPayments: vi.fn(async (input: { gateway: string }) =>
        input.gateway === 'stripe'
          ? [{ paymentId: 'pay-2', orderId: 'order-2', orderNumber: 'LU-261127-N7JH', gatewayChargeId: 'pi_abc123' }]
          : [{ paymentId: 'pay-1', orderId: 'order-1', orderNumber: 'LU-261126-AB12', gatewayChargeId: 'LU-261126-AB12' }],
      ),
      findPayable: vi.fn(async () => ({
        orderId: 'order-1',
        orderNumber: 'LU-261126-AB12',
        orderStatus: 'pending_payment' as const,
        paymentId: 'pay-1',
        paymentStatus: 'pending' as const,
        method: 'card' as const,
        amountExpectedCents: 86_000,
        expiresAt: null,
      })),
      confirmPayment: mpConfirmPayment,
    };
    const stripeGetCharge = vi.fn(async () => {
      throw new Error('Stripe unreachable');
    });
    const mpGetCharge = vi.fn(async () => ({ state: 'paid' as const, amountReceivedCents: 86_000, reference: 'mp-ref-1' }));

    await expect(
      runGatewayReconcile({
        ...deps,
        gatewayReconcile: {
          store,
          mercadoPagoCheckoutPro: { getCharge: mpGetCharge },
          stripe: { getCharge: stripeGetCharge },
        },
      }),
    ).resolves.toBeUndefined();

    expect(mpConfirmPayment).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'order-1' }));
  });
});

describe('runItemReconcile', () => {
  it('does nothing when RocketPass is not configured on this deployment', async () => {
    const { deps } = harness([]);
    const getOrder = vi.fn();

    await runItemReconcile({ ...deps, itemReconcile: null });

    expect(getOrder).not.toHaveBeenCalled();
  });

  it('settles an item order RocketPass now reports delivered, using the sweep config knobs', async () => {
    const { deps } = harness([]);
    const applyDecision = vi.fn(async () => undefined);
    const store = {
      listPendingItemOrders: vi.fn(async () => [
        { orderId: 'order-3', orderNumber: 'LU-261127-ZK91', rocketpassOrderId: 'rp-abc', attemptCount: 1 },
      ]),
      applyDecision,
    };
    const getOrder = vi.fn(async () => ({ status: 'DELIVERED' as const }));

    await runItemReconcile({ ...deps, itemReconcile: { store, client: { getOrder } } });

    expect(store.listPendingItemOrders).toHaveBeenCalledWith({
      olderThanMs: deps.config.sweeps.minAgeMs,
      limit: deps.config.sweeps.batchSize,
    });
    expect(getOrder).toHaveBeenCalledWith('rp-abc');
    expect(applyDecision).toHaveBeenCalledWith(
      'order-3',
      expect.objectContaining({ itemStatus: 'delivered', orderStatus: 'completed' }),
    );
  });

  it('does not throw when RocketPass\'s own check fails', async () => {
    const { deps } = harness([]);
    const store = {
      listPendingItemOrders: vi.fn(async () => [
        { orderId: 'order-3', orderNumber: 'LU-261127-ZK91', rocketpassOrderId: 'rp-abc', attemptCount: 1 },
      ]),
      applyDecision: vi.fn(async () => undefined),
    };
    const getOrder = vi.fn(async () => {
      throw new Error('RocketPass unreachable');
    });

    await expect(
      runItemReconcile({ ...deps, itemReconcile: { store, client: { getOrder } } }),
    ).resolves.toBeUndefined();

    expect(store.applyDecision).not.toHaveBeenCalled();
  });

  it('leaves an order still processing or pending at RocketPass alone', async () => {
    const { deps } = harness([]);
    const applyDecision = vi.fn(async () => undefined);
    const store = {
      listPendingItemOrders: vi.fn(async () => [
        { orderId: 'order-3', orderNumber: 'LU-261127-ZK91', rocketpassOrderId: 'rp-abc', attemptCount: 1 },
      ]),
      applyDecision,
    };
    const getOrder = vi.fn(async () => ({ status: 'PROCESSING' as const }));

    await runItemReconcile({ ...deps, itemReconcile: { store, client: { getOrder } } });

    expect(applyDecision).not.toHaveBeenCalled();
  });
});

describe('runSweepOnce', () => {
  // Proves the real value of cfcaf64 end-to-end, not just by reading the
  // source: a payment still inside its deadline, whose only problem is that
  // nobody (webhook, page reload) ever told the app Stripe already approved
  // it, must get picked up and settled by the proactive reconcile sweep
  // without ever reaching the expiry step. Both fakes share one mutable
  // record so `findOverduePayments` genuinely reflects the settlement, the
  // same way the real `payments.status = 'pending'` filter would in
  // Postgres.
  //
  // This deliberately does NOT set `expiresAt` in the past — a payment whose
  // deadline has already passed is correctly refused by `approvePayment`'s
  // own expiry check (`PAYMENT_EXPIRED`) regardless of which sweep step
  // reaches it first or in what order; nothing in this file changes that,
  // nor should it (see payments.ts's own "OXXO voucher paid after expiry
  // needs a human" reasoning). An earlier version of this test got that
  // wrong — it set `expiresAt` in the past and expected the reorder in
  // e149bac to rescue it, which `approvePayment`'s own deadline check makes
  // structurally impossible. The real, fixable gap this sweep closes is
  // "nobody ever asked the gateway while there was still time to", not
  // "rescue something already past its deadline".
  it('reconciles a Stripe payment nobody has reported yet, before its deadline, without touching the expiry sweep', async () => {
    const { deps } = harness([]);

    const record: { status: 'pending' | 'paid' | 'expired' } = { status: 'pending' };
    const orderId = 'order-9';
    const paymentId = 'pay-9';
    const orderNumber = 'LU-261127-N7JH';
    const gatewayChargeId = 'pi_live_abc';

    const expirePayment = vi.fn(async () => {
      record.status = 'expired';
    });
    const findOverduePayments = vi.fn(async () =>
      // Not due yet — its deadline is still minutes away. This is the
      // ordinary case: the expiry sweep has nothing to do regardless of
      // whether it runs before or after reconcile this tick.
      [],
    );

    const confirmPayment = vi.fn(async () => {
      record.status = 'paid';
    });
    const gatewayStore = {
      listPendingGatewayPayments: vi.fn(async () =>
        record.status === 'pending'
          ? [{ paymentId, orderId, orderNumber, gatewayChargeId }]
          : [],
      ),
      findPayable: vi.fn(async () =>
        record.status === 'pending'
          ? {
              orderId,
              orderNumber,
              orderStatus: 'pending_payment' as const,
              paymentId,
              paymentStatus: 'pending' as const,
              method: 'card' as const,
              amountExpectedCents: 1_500,
              expiresAt: new Date(Date.now() + 10 * 60_000),
            }
          : null,
      ),
      confirmPayment,
      flagMismatch: vi.fn(async () => undefined),
      rejectPayment: vi.fn(async () => undefined),
      expirePayment: vi.fn(async () => undefined),
    };
    const getCharge = vi.fn(async () => ({
      state: 'paid' as const,
      amountReceivedCents: 1_500,
      reference: gatewayChargeId,
    }));

    deps.store.findOverduePayments = findOverduePayments;
    deps.store.expirePayment = expirePayment;

    await runSweepOnce({
      ...deps,
      gatewayReconcile: { store: gatewayStore, mercadoPagoCheckoutPro: null, stripe: { getCharge } },
    });

    expect(confirmPayment).toHaveBeenCalledTimes(1);
    expect(expirePayment).not.toHaveBeenCalled();
    expect(record.status).toBe('paid');
  });
});

describe('runRocketPassSync', () => {
  function syncHarness(balanceArs: number) {
    const client = {
      listCatalog: vi.fn(async () => ({
        items: [],
        regions: [],
        balanceArs,
        currency: 'ARS',
      })),
    };
    const store = { upsertCatalog: vi.fn(async () => undefined) };
    const alerter = { send: vi.fn(async () => undefined) };
    return { client, store, alerter };
  }

  it('alerts when the balance drops below the threshold — the gap that let the account run dry unnoticed', async () => {
    const { client, store, alerter } = syncHarness(30_000);

    await runRocketPassSync({ client, store, alerter, lowBalanceArs: 50_000 });

    expect(alerter.send).toHaveBeenCalledWith(
      'critical',
      'RocketPass balance is low',
      expect.objectContaining({ balanceArs: 30_000, thresholdArs: 50_000 }),
    );
  });

  it('stays quiet while the balance is healthy', async () => {
    const { client, store, alerter } = syncHarness(100_000);

    await runRocketPassSync({ client, store, alerter, lowBalanceArs: 50_000 });

    expect(alerter.send).not.toHaveBeenCalled();
  });

  it('does not throw when the sync itself fails, and never alerts on a balance it never got', async () => {
    const client = { listCatalog: vi.fn(async () => { throw new Error('RocketPass unreachable'); }) };
    const store = { upsertCatalog: vi.fn(async () => undefined) };
    const alerter = { send: vi.fn(async () => undefined) };

    await expect(runRocketPassSync({ client, store, alerter, lowBalanceArs: 50_000 })).resolves.toBeNull();
    expect(alerter.send).not.toHaveBeenCalled();
  });
});

describe('loadConfig', () => {
  it('refuses to start without alerting configured', () => {
    // Silent failures defeat the entire needs_review design.
    expect(() =>
      withEnv({ DATABASE_URL: 'postgres://x@localhost/x', RA_API_KEY: 'k' }, loadConfig),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('requires a provider key outside dry run', () => {
    expect(() =>
      withEnv(
        {
          DATABASE_URL: 'postgres://x@localhost/x',
          TELEGRAM_BOT_TOKEN: 't',
          TELEGRAM_ALERT_CHAT_ID: 'c',
          WORKER_DRY_RUN: 'false',
        },
        loadConfig,
      ),
    ).toThrow(/RA_API_KEY/);
  });

  it('rejects a non-numeric override instead of silently using NaN', () => {
    expect(() => testConfig({ RA_INTER_CALL_DELAY_MS: 'soon' })).toThrow(/must be a number/);
  });

  it('applies sensible defaults', () => {
    const config = testConfig();
    expect(config.provider.interCallDelayMs).toBe(1500);
    expect(config.fulfillment.maxAttempts).toBe(3);
    expect(config.catalogSync.intervalMs).toBe(60 * 60_000);
  });

  it('accepts 0 to switch the catalog sync off', () => {
    expect(testConfig({ CATALOG_SYNC_INTERVAL_MS: '0' }).catalogSync.intervalMs).toBe(0);
  });

  it('rejects a negative catalog sync interval', () => {
    expect(() => testConfig({ CATALOG_SYNC_INTERVAL_MS: '-1' })).toThrow(/CATALOG_SYNC_INTERVAL_MS/);
  });
});
