import { describe, expect, it, vi } from 'vitest';
import { ProviderSimulator, type UsdTenK } from '@levelup/provider';
import { pollPendingOrders, recoverStalledItems, type RecoveryStore, type StalledItem } from './poller.js';
import { InMemoryLock } from './ports.js';
import { buildOrder, MemoryAlerter, MemoryStore } from './testing.js';

const PRICES = { d5600: 27.5 };
const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

/** MemoryStore plus the two read queries the crons need. */
class RecoveryMemoryStore extends MemoryStore implements RecoveryStore {
  pendingItems: StalledItem[] = [];
  stalledItems: StalledItem[] = [];

  async findPendingProviderItems(): Promise<StalledItem[]> {
    return this.pendingItems;
  }
  async findStalledSendingItems(): Promise<StalledItem[]> {
    return this.stalledItems;
  }
}

const stalled = (overrides: Partial<StalledItem> = {}): StalledItem => ({
  orderId: 'order-1',
  orderNumber: 'LU-000900',
  itemId: 'item-1',
  provider: 'recargas_america',
  providerReference: null,
  costUsd: usd(PRICES.d5600),
  walletBeforeUsd: null,
  ageMs: 60_000,
  attemptCount: 1,
  ...overrides,
});

function harness(balanceUsd = 500) {
  const store = new RecoveryMemoryStore(
    buildOrder({ orderNumber: 'LU-000900', items: [['d5600', 5600, PRICES.d5600]] }),
  );
  const alerter = new MemoryAlerter();
  const sim = new ProviderSimulator({ initialBalanceUsd: balanceUsd, prices: PRICES });
  return { store, alerter, sim, lock: new InMemoryLock() };
}

describe('pollPendingOrders', () => {
  it('settles an order the provider has since completed', async () => {
    const { store, alerter, sim, lock } = harness();
    sim.program({ mode: 'pending', completesAfterPolls: 1 });
    const outcome = await sim.purchase({
      endpointKind: 'games',
      providerProductId: 'd5600',
      playerId: '7288567050',
      clientReference: 'LU-000900-0',
    });
    if (outcome.kind !== 'pending') throw new Error('unreachable');

    store.pendingItems = [stalled({ providerReference: outcome.providerReference })];
    const result = await pollPendingOrders({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(result.completed).toBe(1);
    expect(store.current.items[0]?.status).toBe('succeeded');
    expect(store.writes).toContain('settle:item-1:succeeded:polling');
  });

  it('leaves a genuinely still-pending order alone', async () => {
    const { store, alerter, sim, lock } = harness();
    sim.program({ mode: 'pending_forever' });
    const outcome = await sim.purchase({
      endpointKind: 'games',
      providerProductId: 'd5600',
      playerId: '7288567050',
      clientReference: 'LU-000900-0',
    });
    if (outcome.kind !== 'pending') throw new Error('unreachable');

    store.pendingItems = [
      stalled({ providerReference: outcome.providerReference, ageMs: 60_000 }),
    ];
    const result = await pollPendingOrders({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(result.stillPending).toBe(1);
    expect(result.escalated).toBe(0);
    expect(alerter.sent).toHaveLength(0);
  });

  it('escalates a stuck order rather than polling it forever', async () => {
    const { store, alerter, sim, lock } = harness();
    sim.program({ mode: 'pending_forever' });
    const outcome = await sim.purchase({
      endpointKind: 'games',
      providerProductId: 'd5600',
      playerId: '7288567050',
      clientReference: 'LU-000900-0',
    });
    if (outcome.kind !== 'pending') throw new Error('unreachable');

    store.pendingItems = [
      stalled({ providerReference: outcome.providerReference, ageMs: 20 * 60_000 }),
    ];
    const result = await pollPendingOrders({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(result.escalated).toBe(1);
    expect(store.current.status).toBe('needs_review');
    expect(alerter.has('critical')).toBe(true);
  });

  it('escalates when the provider forgets a reference it issued', async () => {
    const { store, alerter, sim, lock } = harness();
    store.pendingItems = [stalled({ providerReference: 'GONE-999' })];

    const result = await pollPendingOrders({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(result.escalated).toBe(1);
    expect(store.writes).toContain('settle:item-1:unknown:-');
  });

  it('escalates a PENDING item that has no reference to poll', async () => {
    const { store, alerter, sim, lock } = harness();
    store.pendingItems = [stalled({ providerReference: null })];

    const result = await pollPendingOrders({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(result.escalated).toBe(1);
    expect(store.current.status).toBe('needs_review');
  });

  it('treats a completed order carrying codes as project-breaking', async () => {
    const { store, alerter, lock } = harness();
    const provider = {
      listFreeFireCatalog: async () => [],
      getBalance: async () => usd(500),
      validatePlayer: async () => ({ found: false, nickname: null }),
      purchase: async () => {
        throw new Error('not used');
      },
      getOrderStatus: async () => ({
        reference: 'REF1',
        status: 'COMPLETED' as const,
        pins: ['ABC-123'],
        product: 'Free Fire 5600',
      }),
    };
    store.pendingItems = [stalled({ providerReference: 'REF1' })];

    const result = await pollPendingOrders({
      store,
      providers: { recargas_america: provider, central_one: provider },
      lock,
      alerter,
    });

    expect(result.escalated).toBe(1);
    expect(result.completed).toBe(0);
    expect(store.current.items[0]?.status).toBe('unknown');
  });
});

describe('recoverStalledItems', () => {
  it('recovers a crashed call that had already been charged', async () => {
    const { store, alerter, sim, lock } = harness(500);
    // The worker died after the provider debited $27.50 and before settlement.
    sim.topUp(-PRICES.d5600);
    store.stalledItems = [stalled({ walletBeforeUsd: usd(500) })];

    const result = await recoverStalledItems({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(result.resolvedByWallet).toBe(1);
    expect(store.current.items[0]?.status).toBe('succeeded');
    expect(store.writes).toContain('settle:item-1:succeeded:wallet_delta');
  });

  it('requeues a crashed call that never landed', async () => {
    const { store, alerter, sim, lock } = harness(500);
    store.stalledItems = [stalled({ walletBeforeUsd: usd(500), attemptCount: 1 })];

    const result = await recoverStalledItems({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(result.resolvedByWallet).toBe(1);
    expect(store.current.items[0]?.status).toBe('failed');
  });

  it('sends a crashed call to review once retries are exhausted', async () => {
    const { store, alerter, sim, lock } = harness(500);
    store.stalledItems = [stalled({ walletBeforeUsd: usd(500), attemptCount: 3 })];

    await recoverStalledItems({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(store.current.items[0]?.status).toBe('unknown');
  });

  it('escalates when the balance moved by an unexplainable amount', async () => {
    const { store, alerter, sim, lock } = harness(500);
    sim.topUp(-100); // matches no item we know about
    store.stalledItems = [stalled({ walletBeforeUsd: usd(500) })];

    const result = await recoverStalledItems({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(result.escalated).toBe(1);
    expect(store.current.items[0]?.status).toBe('unknown');
    expect(alerter.has('critical')).toBe(true);
  });

  it('escalates when there is no pre-call snapshot to compare against', async () => {
    const { store, alerter, sim, lock } = harness();
    store.stalledItems = [stalled({ walletBeforeUsd: null })];

    const result = await recoverStalledItems({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

    expect(result.escalated).toBe(1);
    expect(store.writes).toContain('settle:item-1:unknown:-');
  });

  it('skips entirely while a combo holds the provider lock', async () => {
    const { store, alerter, sim } = harness();
    store.stalledItems = [stalled({ walletBeforeUsd: usd(500) })];

    // A lock that is always already taken.
    const busyLock = {
      withLock: async <T>(_k: string, fn: () => Promise<T>) => fn(),
      tryWithLock: async () => null,
    };

    const result = await recoverStalledItems({ store, providers: { recargas_america: sim, central_one: sim }, lock: busyLock, alerter });

    expect(result.skipped).toBe(true);
    expect(result.examined).toBe(0);
    // Nothing touched — the live run's own reconciliation covers this item.
    expect(store.writes).toHaveLength(0);
  });

  it('does nothing when there is nothing stalled', async () => {
    const { store, alerter, sim, lock } = harness();
    const result = await recoverStalledItems({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });
    expect(result.examined).toBe(0);
    expect(store.writes).toHaveLength(0);
  });

  describe('in emergency mode', () => {
    /** A second item that was never attempted — stays `queued` throughout. */
    function twoItemHarness(balanceUsd = 500) {
      const store = new RecoveryMemoryStore(
        buildOrder({
          orderNumber: 'LU-000900',
          items: [
            ['d5600', 5600, PRICES.d5600],
            ['d5600', 5600, PRICES.d5600],
          ],
        }),
      );
      const alerter = new MemoryAlerter();
      const sim = new ProviderSimulator({ initialBalanceUsd: balanceUsd, prices: PRICES });
      return { store, alerter, sim, lock: new InMemoryLock() };
    }

    it('holds the order for manual fulfillment instead of leaving it claimable again', async () => {
      // One item crashed mid-send and never landed; the other was never
      // attempted. Recovery alone would derive `processing` — exactly the
      // status `queue.claimNext` picks back up once it goes stale, silently
      // skipping emergency mode until that happens.
      const { store, alerter, sim, lock } = twoItemHarness();
      store.stalledItems = [stalled({ walletBeforeUsd: usd(500) })];

      const result = await recoverStalledItems({
        store,
        providers: { recargas_america: sim, central_one: sim },
        lock,
        alerter,
        isEmergencyMode: async () => true,
      });

      expect(result.resolvedByWallet).toBe(1);
      expect(store.current.status).toBe('needs_review');
      expect(store.current.items[1]?.status).toBe('queued'); // untouched
      expect(alerter.sent).toContainEqual(
        expect.objectContaining({ level: 'warn', title: expect.stringMatching(/emergency mode/i) }),
      );
    });

    it('leaves a fully resolved order completed even while emergency mode is on', async () => {
      // Both items landed — there is no automatic work left to protect
      // against, so the recovered order should simply finish.
      const { store, alerter, sim, lock } = harness(500);
      sim.topUp(-PRICES.d5600);
      store.stalledItems = [stalled({ walletBeforeUsd: usd(500) })];

      await recoverStalledItems({
        store,
        providers: { recargas_america: sim, central_one: sim },
        lock,
        alerter,
        isEmergencyMode: async () => true,
      });

      expect(store.current.status).toBe('completed');
    });

    it('is unaffected when emergency mode is not supplied at all', async () => {
      // Regression guard: the many tests above construct `PollerDeps` without
      // `isEmergencyMode`, and must keep behaving exactly as before.
      const { store, alerter, sim, lock } = twoItemHarness();
      store.stalledItems = [stalled({ walletBeforeUsd: usd(500) })];

      await recoverStalledItems({ store, providers: { recargas_america: sim, central_one: sim }, lock, alerter });

      expect(store.current.status).toBe('processing');
    });

    it('defaults to the normally derived status when the flag cannot be read', async () => {
      const { store, alerter, sim, lock } = twoItemHarness();
      store.stalledItems = [stalled({ walletBeforeUsd: usd(500) })];
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await recoverStalledItems({
        store,
        providers: { recargas_america: sim, central_one: sim },
        lock,
        alerter,
        isEmergencyMode: async () => {
          throw new Error('settings table unreachable');
        },
      });

      expect(store.current.status).toBe('processing');
      error.mockRestore();
    });
  });
});

describe('recovering stalled items from two providers', () => {
  it('locks each provider independently — a busy RA lock does not block recovering a Central One item', async () => {
    const store = new RecoveryMemoryStore(
      buildOrder({
        orderNumber: 'LU-000900',
        items: [
          ['d5600', 5600, PRICES.d5600, 'recargas_america'],
          ['co-100', 100, 0.655, 'central_one'],
        ],
      }),
    );
    const alerter = new MemoryAlerter();
    const ra = new ProviderSimulator({ initialBalanceUsd: 500, prices: PRICES });
    const co = new ProviderSimulator({ initialBalanceUsd: 500 - 0.655, prices: { 'co-100': 0.655 } });
    const lock = new InMemoryLock();

    store.stalledItems = [
      stalled({ itemId: 'item-1', provider: 'recargas_america', walletBeforeUsd: usd(500) }),
      stalled({
        itemId: 'item-2',
        provider: 'central_one',
        walletBeforeUsd: usd(500),
        costUsd: usd(0.655),
      }),
    ];

    // RA's lock is held by something else for the whole sweep.
    const held = lock.withLock(
      'provider:recargasamerica',
      () => new Promise((resolve) => setTimeout(resolve, 20)),
    );

    const result = await recoverStalledItems({
      store,
      providers: { recargas_america: ra, central_one: co },
      lock,
      alerter,
    });

    await held;

    // Both eventually recover, but the Central One item's write lands first in
    // the log — proof its group never waited behind RA's busy lock, even
    // though `InMemoryLock` has no `tryWithLock` and so queues rather than
    // skips. If the two groups shared one lock, or ran one after the other,
    // RA's settlement (unblocked only after 20ms) would have to land first.
    expect(result.resolvedByWallet).toBe(2);
    const settleWrites = store.writes.filter((w) => w.startsWith('settle:'));
    expect(settleWrites[0]).toMatch(/^settle:item-2:/);
    expect(settleWrites[1]).toMatch(/^settle:item-1:/);
  });
});
