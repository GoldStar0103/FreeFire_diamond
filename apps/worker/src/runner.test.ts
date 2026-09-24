import { describe, expect, it, vi } from 'vitest';
import { ProviderSimulator, type UsdTenK } from '@levelup/provider';
import { InMemoryLock, PROVIDER_LOCK_KEY } from '@levelup/engine';
import {
  MemoryAlerter,
  MemoryCatalogStore,
  MemoryStore,
  buildOrder,
} from '@levelup/engine/testing';
import type {
  AdvisoryLock,
  ExpiryStore,
  OverduePayment,
  RecoveryStore,
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

function harness(claims: Array<{ id: string; orderNumber: string; recovered: boolean } | null>) {
  const store = new QueueStore(
    buildOrder({ orderNumber: 'LU-1', items: [['d100', 100, 0.55]] }),
  );
  const alerter = new MemoryAlerter();
  const provider = new ProviderSimulator({ initialBalanceUsd: 500, prices: { d100: 0.55 } });
  provider.program({ mode: 'succeed' });

  const queue = {
    claimNext: vi.fn(async () => claims.shift() ?? null),
    depth: vi.fn(async () => ({ payment_confirmed: 1 })),
  };

  const catalog = new MemoryCatalogStore();

  const deps: RunnerDeps = {
    queue,
    store,
    catalog,
    provider,
    lock: new InMemoryLock(),
    orderBoundary: new InMemoryLock(),
    alerter,
    config: testConfig(),
  };
  return { deps, queue, store, catalog, alerter, provider };
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

    expect(result?.replaced).toHaveLength(1);
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

    expect(result?.deactivationSkipped?.reason).toBe('empty_catalog');
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

    await expect(runCatalogSync(deps)).resolves.toBeNull();

    expect(catalog.products).toEqual([]);
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

    await expect(runCatalogSync({ ...deps, alerter })).resolves.toBeNull();
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
    catalog.listStoredProducts = async () => {
      seen.push([...held].sort());
      return list();
    };

    await runCatalogSync({ ...deps, lock: recording, orderBoundary: recording });

    expect(seen).toEqual([[PROVIDER_LOCK_KEY, ORDER_BOUNDARY_KEY].sort()]);
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
    expect(list).toHaveBeenCalledTimes(1);
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

    expect(await schedule.runIfDue(deps, 0)).toEqual({ ran: true, result: null });
    expect((await schedule.runIfDue(deps, CATALOG_SYNC_RETRY_MS - 1)).ran).toBe(false);

    provider.programCatalog(null);
    const retry = await schedule.runIfDue(deps, CATALOG_SYNC_RETRY_MS);
    expect(retry.ran).toBe(true);
    expect(retry.result?.mapped).toHaveLength(6);

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

    await checkWallet({ ...deps, provider });

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
      ...deps.provider,
      getBalance: async () => {
        throw new Error('provider down');
      },
    } as typeof deps.provider;

    await expect(checkWallet({ ...deps, provider })).resolves.toBeUndefined();
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
