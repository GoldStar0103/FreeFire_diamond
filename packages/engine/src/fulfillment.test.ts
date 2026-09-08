/**
 * End-to-end fulfilment scenarios.
 *
 * Every test drives the real engine against the real provider adapter contract
 * (via the simulator). Nothing is stubbed except persistence and the clock.
 */

import { describe, expect, it } from 'vitest';
import { ProviderSimulator } from '@levelup/provider';
import { fulfillOrder, PROVIDER_LOCK_KEY, type FulfillmentDeps } from './fulfillment.js';
import { InMemoryLock } from './ports.js';
import { buildOrder, FakeClock, MemoryAlerter, MemoryStore } from './testing.js';

const PRICES = { d100: 0.55, d1060: 5.4, d2180: 10.8, d5600: 27.5 };

/** Mega Prime 48k: 5,600 eight times, one purchase for the customer. */
const megaPrime48k = () =>
  buildOrder({ orderNumber: 'LU-000900', items: Array(8).fill(['d5600', 5600, PRICES.d5600]) });

/** Descuentos Chidos 3000: 2,180 + 520 + 100. */
const chidos3000 = () =>
  buildOrder({
    orderNumber: 'LU-000300',
    items: [
      ['d2180', 2180, PRICES.d2180],
      ['d1060', 1060, PRICES.d1060],
      ['d100', 100, PRICES.d100],
    ],
  });

function harness(order = chidos3000(), balanceUsd = 500) {
  const store = new MemoryStore(order);
  const alerter = new MemoryAlerter();
  const sim = new ProviderSimulator({ initialBalanceUsd: balanceUsd, prices: PRICES });
  const deps: FulfillmentDeps = {
    store,
    provider: sim,
    lock: new InMemoryLock(),
    alerter,
    clock: new FakeClock(),
    config: { interCallDelayMs: 0 },
  };
  return { store, alerter, sim, deps };
}

describe('happy path', () => {
  it('completes a 3-call combo as one order', async () => {
    const { deps, sim, store } = harness();
    sim.program({ mode: 'succeed' });

    const result = await fulfillOrder(deps, 'order-1');

    expect(result.finalStatus).toBe('completed');
    expect(result.delivered).toBe(3);
    expect(sim.deliveryCount).toBe(3);
    expect(store.current.items.every((i) => i.status === 'succeeded')).toBe(true);
  });

  it('completes all eight calls of Mega Prime 48k', async () => {
    const { deps, sim } = harness(megaPrime48k());
    sim.program({ mode: 'succeed' });

    const result = await fulfillOrder(deps, 'order-1');

    expect(result.finalStatus).toBe('completed');
    expect(result.delivered).toBe(8);
    expect(sim.deliveryCount).toBe(8);
  });

  it('records intent before every provider call', async () => {
    // Crash recovery depends on this ordering: a `sending` row must exist
    // before the HTTP request goes out, or a dead process leaves no evidence.
    const { deps, sim, store } = harness();
    sim.program({ mode: 'succeed' });
    await fulfillOrder(deps, 'order-1');

    const itemWrites = store.writes.filter((w) => w.includes('item-1'));
    expect(itemWrites[0]).toBe('sending:item-1');
    expect(itemWrites[1]).toMatch(/^settle:item-1:succeeded/);
  });
});

describe('mid-combo timeout that DID charge', () => {
  it('resolves via wallet delta and never double-delivers', async () => {
    const { deps, sim, store, alerter } = harness(megaPrime48k());
    sim.program(
      { mode: 'succeed' },
      { mode: 'succeed' },
      { mode: 'succeed' },
      { mode: 'timeout', charged: true }, // call 4
      { mode: 'succeed' },
    );

    const result = await fulfillOrder(deps, 'order-1');

    expect(result.finalStatus).toBe('completed');
    expect(result.delivered).toBe(8);
    // Nine would mean we retried a call that had already landed.
    expect(sim.deliveryCount).toBe(8);

    const resolved = store.writes.find((w) => w.includes('wallet_delta'));
    expect(resolved).toBe('settle:item-4:succeeded:wallet_delta');
    expect(alerter.sent.some((a) => a.title.includes('resolved as delivered'))).toBe(true);
  });
});

describe('mid-combo timeout that did NOT charge', () => {
  it('leaves the item retryable and the order partially delivered', async () => {
    const { deps, sim, store } = harness();
    sim.program({ mode: 'succeed' }, { mode: 'timeout', charged: false }, { mode: 'succeed' });

    const result = await fulfillOrder(deps, 'order-1');

    // Item 2 is `failed` but under the retry ceiling, so the order is not yet
    // finished and is not yet a human's problem.
    expect(result.finalStatus).toBe('partially_delivered');
    expect(store.current.items[1]?.status).toBe('failed');
    expect(store.writes).toContain('settle:item-2:failed:wallet_delta');
  });

  it('finishes on a second run', async () => {
    const { deps, sim } = harness();
    sim.program({ mode: 'succeed' }, { mode: 'timeout', charged: false }, { mode: 'succeed' });
    await fulfillOrder(deps, 'order-1');

    sim.program({ mode: 'succeed' });
    const second = await fulfillOrder(deps, 'order-1');

    expect(second.finalStatus).toBe('completed');
    // Three deliveries total: the timed-out call genuinely never landed.
    expect(second.delivered).toBe(3);
  });
});

describe('indeterminate outcome', () => {
  it('halts the order instead of spending on the remaining items', async () => {
    // The provider's price has drifted since our last catalog sync: we recorded
    // $27.50 for a 5,600 SKU, they now charge $30.00. A timeout then moves the
    // wallet by an amount matching no item we know about, and guessing which
    // one landed is exactly what must not happen with money.
    const store = new MemoryStore(megaPrime48k());
    const alerter = new MemoryAlerter();
    const sim = new ProviderSimulator({
      initialBalanceUsd: 500,
      prices: { ...PRICES, d5600: 30.0 },
    });
    sim.program({ mode: 'timeout', charged: true });

    const result = await fulfillOrder(
      {
        store,
        provider: sim,
        lock: new InMemoryLock(),
        alerter,
        clock: new FakeClock(),
        config: { interCallDelayMs: 0 },
      },
      'order-1',
    );

    expect(result.haltedReason).toBe('indeterminate');
    expect(result.finalStatus).toBe('needs_review');
    // One attempt only. The other seven calls were never made.
    expect(sim.attempts.length).toBe(1);
    expect(store.current.items[0]?.status).toBe('unknown');
    expect(alerter.has('critical')).toBe(true);
  });
});

describe('code delivery', () => {
  it('halts immediately — the customer bought a top-up, not a code', async () => {
    const { deps, sim, alerter } = harness();
    sim.program({ mode: 'succeed_as_code', pins: ['ABC-123'] });

    const result = await fulfillOrder(deps, 'order-1');

    expect(result.haltedReason).toBe('code_delivery');
    expect(result.finalStatus).toBe('needs_review');
    expect(sim.attempts.length).toBe(1);
    expect(alerter.sent.some((a) => a.title.includes('code, not a top-up'))).toBe(true);
  });
});

describe('permanent failure', () => {
  it('stops rather than burning the remaining items on the same config bug', async () => {
    const { deps, sim } = harness(megaPrime48k());
    sim.program({ mode: 'invalid_product_type' });

    const result = await fulfillOrder(deps, 'order-1');

    expect(result.haltedReason).toBe('permanent_failure');
    expect(result.finalStatus).toBe('needs_review');
    expect(sim.attempts.length).toBe(1);
  });
});

describe('insufficient balance', () => {
  it('pauses before starting an order it cannot finish', async () => {
    // 8 x $27.50 = $220 needed, $90 available.
    const { deps, sim, alerter } = harness(megaPrime48k(), 90);
    sim.program({ mode: 'succeed' });

    const result = await fulfillOrder(deps, 'order-1');

    expect(result.haltedReason).toBe('insufficient_balance');
    expect(result.finalStatus).toBe('needs_review');
    // Nothing was attempted — no partial delivery to reconcile later.
    expect(sim.attempts.length).toBe(0);
    expect(sim.deliveryCount).toBe(0);
    expect(alerter.has('critical')).toBe(true);
  });
});

describe('PENDING items', () => {
  it('leaves the order processing for the poller to finish', async () => {
    const { deps, sim, store } = harness();
    sim.program({ mode: 'pending', completesAfterPolls: 2 }, { mode: 'succeed' });

    const result = await fulfillOrder(deps, 'order-1');

    expect(result.finalStatus).toBe('processing');
    expect(store.current.items[0]?.status).toBe('provider_pending');
    expect(store.current.items[0]?.providerReference).toMatch(/^SIM/);
  });
});

describe('guards', () => {
  it('refuses to fulfil an unpaid order', async () => {
    const { deps, sim } = harness(
      buildOrder({ status: 'pending_payment', items: [['d100', 100, PRICES.d100]] }),
    );
    const result = await fulfillOrder(deps, 'order-1');

    expect(result.finalStatus).toBe('pending_payment');
    expect(sim.attempts.length).toBe(0);
  });

  it('is idempotent on an already completed order', async () => {
    const { deps, sim, store } = harness();
    sim.program({ mode: 'succeed' });
    await fulfillOrder(deps, 'order-1');

    const again = await fulfillOrder(deps, 'order-1');
    expect(again.finalStatus).toBe('completed');
    // Re-running the worker must not re-deliver anything.
    expect(sim.deliveryCount).toBe(3);
    expect(store.current.items.every((i) => i.status === 'succeeded')).toBe(true);
  });

  it('throws for an unknown order rather than failing quietly', async () => {
    const { deps } = harness();
    await expect(fulfillOrder(deps, 'nope')).rejects.toThrow(/not found/);
  });
});

describe('retry ceiling', () => {
  it('sends an item to review once attempts are exhausted', async () => {
    const { deps, sim, alerter } = harness(
      buildOrder({ items: [['d100', 100, PRICES.d100]] }),
    );
    sim.program({ mode: 'timeout', charged: false });

    let last = await fulfillOrder(deps, 'order-1');
    for (let i = 0; i < 3 && last.finalStatus !== 'needs_review'; i++) {
      last = await fulfillOrder(deps, 'order-1');
    }

    expect(last.finalStatus).toBe('needs_review');
    expect(sim.deliveryCount).toBe(0);
    expect(alerter.has('critical')).toBe(true);
  });
});

describe('the advisory lock', () => {
  it('serialises concurrent orders so wallet comparison stays valid', async () => {
    const lock = new InMemoryLock();
    const observed: string[] = [];

    await Promise.all(
      ['a', 'b', 'c'].map((tag) =>
        lock.withLock(PROVIDER_LOCK_KEY, async () => {
          observed.push(`${tag}:enter`);
          await new Promise((r) => setTimeout(r, 5));
          observed.push(`${tag}:exit`);
        }),
      ),
    );

    // No interleaving: every enter is immediately followed by its own exit.
    for (let i = 0; i < observed.length; i += 2) {
      const tag = observed[i]!.split(':')[0];
      expect(observed[i]).toBe(`${tag}:enter`);
      expect(observed[i + 1]).toBe(`${tag}:exit`);
    }
  });

  it('does not let one failure poison the queue', async () => {
    const lock = new InMemoryLock();
    await expect(
      lock.withLock('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(lock.withLock('k', async () => 'fine')).resolves.toBe('fine');
  });
});

describe('inter-call delay', () => {
  it('paces calls so eight rapid top-ups do not trip velocity checks', async () => {
    const store = new MemoryStore(megaPrime48k());
    const clock = new FakeClock();
    const sim = new ProviderSimulator({ initialBalanceUsd: 500, prices: PRICES });
    sim.program({ mode: 'succeed' });

    await fulfillOrder(
      {
        store,
        provider: sim,
        lock: new InMemoryLock(),
        alerter: new MemoryAlerter(),
        clock,
        config: { interCallDelayMs: 1500 },
      },
      'order-1',
    );

    // Seven gaps between eight calls.
    expect(clock.sleeps).toEqual(Array(7).fill(1500));
  });
});
