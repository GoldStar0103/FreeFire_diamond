import { describe, expect, it } from 'vitest';
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
    const result = await pollPendingOrders({ store, provider: sim, lock, alerter });

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
    const result = await pollPendingOrders({ store, provider: sim, lock, alerter });

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
    const result = await pollPendingOrders({ store, provider: sim, lock, alerter });

    expect(result.escalated).toBe(1);
    expect(store.current.status).toBe('needs_review');
    expect(alerter.has('critical')).toBe(true);
  });

  it('escalates when the provider forgets a reference it issued', async () => {
    const { store, alerter, sim, lock } = harness();
    store.pendingItems = [stalled({ providerReference: 'GONE-999' })];

    const result = await pollPendingOrders({ store, provider: sim, lock, alerter });

    expect(result.escalated).toBe(1);
    expect(store.writes).toContain('settle:item-1:unknown:-');
  });

  it('escalates a PENDING item that has no reference to poll', async () => {
    const { store, alerter, sim, lock } = harness();
    store.pendingItems = [stalled({ providerReference: null })];

    const result = await pollPendingOrders({ store, provider: sim, lock, alerter });

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

    const result = await pollPendingOrders({ store, provider, lock, alerter });

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

    const result = await recoverStalledItems({ store, provider: sim, lock, alerter });

    expect(result.resolvedByWallet).toBe(1);
    expect(store.current.items[0]?.status).toBe('succeeded');
    expect(store.writes).toContain('settle:item-1:succeeded:wallet_delta');
  });

  it('requeues a crashed call that never landed', async () => {
    const { store, alerter, sim, lock } = harness(500);
    store.stalledItems = [stalled({ walletBeforeUsd: usd(500), attemptCount: 1 })];

    const result = await recoverStalledItems({ store, provider: sim, lock, alerter });

    expect(result.resolvedByWallet).toBe(1);
    expect(store.current.items[0]?.status).toBe('failed');
  });

  it('sends a crashed call to review once retries are exhausted', async () => {
    const { store, alerter, sim, lock } = harness(500);
    store.stalledItems = [stalled({ walletBeforeUsd: usd(500), attemptCount: 3 })];

    await recoverStalledItems({ store, provider: sim, lock, alerter });

    expect(store.current.items[0]?.status).toBe('unknown');
  });

  it('escalates when the balance moved by an unexplainable amount', async () => {
    const { store, alerter, sim, lock } = harness(500);
    sim.topUp(-100); // matches no item we know about
    store.stalledItems = [stalled({ walletBeforeUsd: usd(500) })];

    const result = await recoverStalledItems({ store, provider: sim, lock, alerter });

    expect(result.escalated).toBe(1);
    expect(store.current.items[0]?.status).toBe('unknown');
    expect(alerter.has('critical')).toBe(true);
  });

  it('escalates when there is no pre-call snapshot to compare against', async () => {
    const { store, alerter, sim, lock } = harness();
    store.stalledItems = [stalled({ walletBeforeUsd: null })];

    const result = await recoverStalledItems({ store, provider: sim, lock, alerter });

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

    const result = await recoverStalledItems({ store, provider: sim, lock: busyLock, alerter });

    expect(result.skipped).toBe(true);
    expect(result.examined).toBe(0);
    // Nothing touched — the live run's own reconciliation covers this item.
    expect(store.writes).toHaveLength(0);
  });

  it('does nothing when there is nothing stalled', async () => {
    const { store, alerter, sim, lock } = harness();
    const result = await recoverStalledItems({ store, provider: sim, lock, alerter });
    expect(result.examined).toBe(0);
    expect(store.writes).toHaveLength(0);
  });
});
