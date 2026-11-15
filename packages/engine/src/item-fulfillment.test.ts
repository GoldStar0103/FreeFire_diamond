import { describe, expect, it } from 'vitest';
import { RocketPassError, type CreateOrderInput, type RocketPassOrderStatus } from '@levelup/rocketpass';
import {
  applyRocketPassWebhookOrder,
  decideItemFulfillment,
  fulfillItemOrder,
  type ItemFulfillmentDeps,
  type ItemFulfillmentStore,
  type ItemOrderRecord,
  type ItemWebhookDeps,
  type ItemWebhookStore,
  type RocketPassOrderClient,
} from './item-fulfillment.js';
import { MemoryAlerter } from './testing.js';

describe('decideItemFulfillment', () => {
  it('DELIVERED completes the order', () => {
    const decision = decideItemFulfillment({ ok: true, rocketpassOrderId: 'ORD-1', status: 'DELIVERED' }, 1, 3);
    expect(decision).toEqual({
      itemStatus: 'delivered',
      orderStatus: 'completed',
      rocketpassOrderId: 'ORD-1',
      alert: null,
    });
  });

  it('PARTIAL escalates to review with a warn alert', () => {
    const decision = decideItemFulfillment({ ok: true, rocketpassOrderId: 'ORD-1', status: 'PARTIAL' }, 1, 3);
    expect(decision.itemStatus).toBe('partial');
    expect(decision.orderStatus).toBe('needs_review');
    expect(decision.alert?.level).toBe('warn');
  });

  it('FAILED escalates to review with a critical alert', () => {
    const decision = decideItemFulfillment({ ok: true, rocketpassOrderId: 'ORD-1', status: 'FAILED' }, 1, 3);
    expect(decision.itemStatus).toBe('failed');
    expect(decision.orderStatus).toBe('needs_review');
    expect(decision.alert?.level).toBe('critical');
  });

  it('CANCELLED escalates to review with a warn alert', () => {
    const decision = decideItemFulfillment({ ok: true, rocketpassOrderId: 'ORD-1', status: 'CANCELLED' }, 1, 3);
    expect(decision.itemStatus).toBe('cancelled');
    expect(decision.orderStatus).toBe('needs_review');
  });

  it('PENDING/PROCESSING records the RocketPass id and leaves orders.status alone, no alert', () => {
    for (const status of ['PENDING', 'PROCESSING'] as const) {
      const decision = decideItemFulfillment({ ok: true, rocketpassOrderId: 'ORD-1', status }, 1, 3);
      expect(decision).toEqual({
        itemStatus: 'processing',
        orderStatus: null,
        rocketpassOrderId: 'ORD-1',
        alert: null,
      });
    }
  });

  it('OUT_OF_STOCK marks awaiting_stock without touching orders.status', () => {
    const decision = decideItemFulfillment({ ok: false, code: 'OUT_OF_STOCK', retryable: false }, 1, 3);
    expect(decision.itemStatus).toBe('awaiting_stock');
    expect(decision.orderStatus).toBeNull();
    expect(decision.alert?.level).toBe('warn');
  });

  it('an account/license problem fails the item and alerts critically', () => {
    const decision = decideItemFulfillment({ ok: false, code: 'INSUFFICIENT_BALANCE', retryable: false }, 1, 3);
    expect(decision.itemStatus).toBe('failed');
    expect(decision.orderStatus).toBe('needs_review');
    expect(decision.alert).toMatchObject({ level: 'critical', title: 'RocketPass account/license problem' });
  });

  it.each(['DUPLICATE_ORDER', 'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_PROGRESS'])(
    '%s never claims success or failure — escalates immediately, regardless of attempt count',
    (code) => {
      const decision = decideItemFulfillment({ ok: false, code, retryable: false }, 1, 3);
      expect(decision.itemStatus).toBe('processing');
      expect(decision.orderStatus).toBe('needs_review');
      expect(decision.rocketpassOrderId).toBeNull();
      expect(decision.alert?.level).toBe('critical');
    },
  );

  it('a retryable error under the attempt cap stays processing, silently', () => {
    const decision = decideItemFulfillment({ ok: false, code: 'RATE_LIMIT', retryable: true }, 2, 3);
    expect(decision).toEqual({ itemStatus: 'processing', orderStatus: null, rocketpassOrderId: null, alert: null });
  });

  it('a retryable error at the attempt cap fails and alerts', () => {
    const decision = decideItemFulfillment({ ok: false, code: 'RATE_LIMIT', retryable: true }, 3, 3);
    expect(decision.itemStatus).toBe('failed');
    expect(decision.orderStatus).toBe('needs_review');
    expect(decision.alert?.title).toContain('exhausting retries');
  });

  it('a non-retryable, unrecognised code fails immediately on the first attempt', () => {
    const decision = decideItemFulfillment({ ok: false, code: 'INVALID_UID', retryable: false }, 1, 3);
    expect(decision.itemStatus).toBe('failed');
    expect(decision.orderStatus).toBe('needs_review');
    expect(decision.alert?.title).toBe('RocketPass refused this order');
  });
});

function fakeOrder(overrides: Partial<ItemOrderRecord> = {}): ItemOrderRecord {
  return {
    id: 'order-uuid-1',
    orderNumber: 'LU-260101-AAAA',
    playerId: '7288567050',
    sku: 'crate',
    itemName: 'Universal Evo Token Crate',
    quantity: 1,
    region: 'SAC',
    fulfillmentStatus: 'pending',
    rocketpassOrderId: null,
    attemptCount: 0,
    ...overrides,
  };
}

function harness(
  order: ItemOrderRecord,
  respond: (input: CreateOrderInput) => Promise<{ order: { orderId: string; status: RocketPassOrderStatus } }>,
) {
  const applied: Array<{ orderId: string; decision: unknown }> = [];
  const sent: string[] = [];
  const store: ItemFulfillmentStore = {
    loadItemOrder: async (id) => (id === order.id ? order : null),
    markSending: async (id) => {
      sent.push(id);
    },
    applyDecision: async (id, decision) => {
      applied.push({ orderId: id, decision });
    },
  };
  const alerter = new MemoryAlerter();
  const client: RocketPassOrderClient = { createOrder: respond };
  const deps: ItemFulfillmentDeps = { store, client, alerter, config: { maxAttempts: 3 } };
  return { deps, applied, sent, alerter };
}

describe('fulfillItemOrder', () => {
  it('skips the call entirely once RocketPass already has an id for this order', async () => {
    const order = fakeOrder({ rocketpassOrderId: 'ORD-already-placed' });
    let called = false;
    const { deps, applied, sent } = harness(order, async () => {
      called = true;
      throw new Error('must not be called');
    });

    const outcome = await fulfillItemOrder(deps, order.id);
    expect(outcome).toEqual({ kind: 'already_placed' });
    expect(called).toBe(false);
    expect(sent).toHaveLength(0);
    expect(applied).toHaveLength(0);
  });

  it('marks sending before calling RocketPass, sends the right idempotency key and reference', async () => {
    const order = fakeOrder();
    const calls: unknown[] = [];
    const { deps, sent, applied } = harness(order, async (input: unknown) => {
      calls.push(input);
      return { order: { orderId: 'ORD-1', status: 'DELIVERED' } };
    });

    await fulfillItemOrder(deps, order.id);

    expect(sent).toEqual([order.id]);
    expect(calls[0]).toMatchObject({
      item: 'crate',
      targetUid: '7288567050',
      quantity: 1,
      region: 'SAC',
      reference: 'LU-260101-AAAA',
      idempotencyKey: 'order-uuid-1',
    });
    expect(applied[0]).toMatchObject({ orderId: order.id, decision: { itemStatus: 'delivered', orderStatus: 'completed' } });
  });

  it('omits region for a membership item', async () => {
    const order = fakeOrder({ sku: 'weekly', region: null });
    const calls: unknown[] = [];
    const { deps } = harness(order, async (input: unknown) => {
      calls.push(input);
      return { order: { orderId: 'ORD-1', status: 'DELIVERED' } };
    });

    await fulfillItemOrder(deps, order.id);
    expect(calls[0]).not.toHaveProperty('region');
  });

  it('converts a thrown RocketPassError into the right decision and sends the alert', async () => {
    const order = fakeOrder();
    const { deps, applied, alerter } = harness(order, async () => {
      throw new RocketPassError('sin stock', 'OUT_OF_STOCK', 409, false);
    });

    await fulfillItemOrder(deps, order.id);

    expect(applied[0]).toMatchObject({ decision: { itemStatus: 'awaiting_stock' } });
    expect(alerter.has('warn')).toBe(true);
  });

  it('treats a plain network failure as a retryable UNREACHABLE', async () => {
    const order = fakeOrder({ attemptCount: 0 });
    const { deps, applied, alerter } = harness(order, async () => {
      throw new Error('ECONNRESET');
    });

    await fulfillItemOrder(deps, order.id);

    expect(applied[0]).toMatchObject({ decision: { itemStatus: 'processing', orderStatus: null } });
    expect(alerter.sent).toHaveLength(0);
  });

  it('passes attemptCount + 1 through to the decision, so the cap is enforced across retries', async () => {
    const order = fakeOrder({ attemptCount: 2 });
    const { deps, applied } = harness(order, async () => {
      throw new Error('ECONNRESET');
    });

    await fulfillItemOrder(deps, order.id);
    // attemptCount+1 (3) >= maxAttempts (3) -> exhausted, not silently retried.
    expect(applied[0]).toMatchObject({ decision: { itemStatus: 'failed', orderStatus: 'needs_review' } });
  });

  it('throws when the order does not exist, rather than silently doing nothing', async () => {
    const order = fakeOrder();
    const { deps } = harness(order, async () => {
      throw new Error('must not be called');
    });
    await expect(fulfillItemOrder(deps, 'does-not-exist')).rejects.toThrow(/not found/);
  });
});

describe('applyRocketPassWebhookOrder', () => {
  function webhookHarness(lookup: { orderId: string; attemptCount: number } | null) {
    const applied: Array<{ orderId: string; decision: unknown }> = [];
    const store: ItemWebhookStore = {
      findItemOrderByRocketpassId: async () => lookup,
      applyDecision: async (orderId, decision) => {
        applied.push({ orderId, decision });
      },
    };
    const alerter = new MemoryAlerter();
    const deps: ItemWebhookDeps = { store, alerter, config: { maxAttempts: 3 } };
    return { deps, applied, alerter };
  }

  it('applies the same decision a synchronous DELIVERED response would have', async () => {
    const { deps, applied } = webhookHarness({ orderId: 'order-uuid-1', attemptCount: 1 });

    const outcome = await applyRocketPassWebhookOrder(deps, { rocketpassOrderId: 'ORD-1', status: 'DELIVERED' });

    expect(outcome).toMatchObject({ kind: 'applied', orderId: 'order-uuid-1' });
    expect(applied[0]).toMatchObject({
      orderId: 'order-uuid-1',
      decision: { itemStatus: 'delivered', orderStatus: 'completed' },
    });
  });

  it('sends the alert for a PARTIAL settlement, same as the synchronous path', async () => {
    const { deps, applied, alerter } = webhookHarness({ orderId: 'order-uuid-1', attemptCount: 1 });

    await applyRocketPassWebhookOrder(deps, { rocketpassOrderId: 'ORD-1', status: 'PARTIAL' });

    expect(applied[0]).toMatchObject({ decision: { itemStatus: 'partial', orderStatus: 'needs_review' } });
    expect(alerter.has('warn')).toBe(true);
  });

  it('is a no-op for a RocketPass order id this store has never heard of', async () => {
    const { deps, applied } = webhookHarness(null);

    const outcome = await applyRocketPassWebhookOrder(deps, { rocketpassOrderId: 'ORD-unknown', status: 'DELIVERED' });

    expect(outcome).toEqual({ kind: 'unrecognised' });
    expect(applied).toHaveLength(0);
  });
});
