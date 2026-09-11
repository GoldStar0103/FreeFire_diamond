/**
 * Card-gateway bookkeeping against real Postgres.
 *
 * The claims worth a real database: the webhook dedupe really is the unique
 * index, a half-processed delivery really is retried, and a session can only
 * attach to a payment nobody has acted on.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createOrder, settleGatewayCharge } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import { baseProducts, campaigns, comboItems, combos, orders, paymentEvents, payments } from '../schema.js';
import { DrizzleOrderingStore } from './ordering-store.js';
import { DrizzlePaymentStore } from './payment-store.js';
import {
  attachGatewayCharge,
  extendPaymentDeadline,
  findGatewayPayment,
  markPaymentEventProcessed,
  recordPaymentEvent,
} from './gateway-payments.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_gateway_test';

const PG_AVAILABLE = await (async () => {
  const probe = postgres(`${BASE_URL}/postgres`, { max: 1, connect_timeout: 3 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 2 }).catch(() => undefined);
  }
})();

let db: Database;
let client: ReturnType<typeof createDb>['client'];

beforeAll(async () => {
  if (!PG_AVAILABLE) return;
  const admin = postgres(`${BASE_URL}/postgres`, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  ({ db, client } = createDb(`${BASE_URL}/${TEST_DB}`, { max: 5 }));
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 180_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
}, 30_000);

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(
    raw`TRUNCATE orders, order_items, payments, payment_events, combo_items, combos, campaigns, base_products, audit_log RESTART IDENTITY CASCADE`,
  );

  const [product] = await db
    .insert(baseProducts)
    .values({
      providerProductId: '351',
      endpointKind: 'pins_recharge',
      name: 'Free Fire 100',
      diamondsBase: 100,
      costUsd: '0.7000',
      canValidate: true,
    })
    .returning();
  const [campaign] = await db
    .insert(campaigns)
    .values({ key: 'mega_oferta', name: 'MEGA OFERTA', permanent: true })
    .returning();
  const [combo] = await db
    .insert(combos)
    .values({
      campaignId: campaign!.id,
      key: 'mega_10',
      name: 'Mega Oferta 110',
      priceMxnCents: 1_000,
      advertisedDiamonds: 110,
      maxPerPlayer: 1,
    })
    .returning();
  await db.insert(comboItems).values({ comboId: combo!.id, baseProductId: product!.id, sequence: 0 });
});

async function cardOrder(playerId = '7288567050') {
  const result = await createOrder(
    { store: new DrizzleOrderingStore(db) },
    { comboKey: 'mega_10', playerId, paymentMethod: 'card', source: 'storefront' },
  );
  if (!result.ok) throw new Error(result.failure.code);
  return result.order;
}

describe.skipIf(!PG_AVAILABLE)('attaching a session', () => {
  it('links the session and pulls the deadline in to the session’s own', async () => {
    const order = await cardOrder();
    const expiresAt = new Date(Date.now() + 90 * 60_000);

    expect(
      await attachGatewayCharge(db, {
        orderId: order.id,
        gateway: 'stripe',
        gatewayChargeId: 'cs_1',
        expiresAt,
      }),
    ).toBe(true);

    const found = await findGatewayPayment(db, 'stripe', 'cs_1');
    expect(found).toMatchObject({ orderId: order.id, orderNumber: order.orderNumber, paymentStatus: 'pending' });
    expect(found?.expiresAt?.getTime()).toBe(expiresAt.getTime());
  });

  it('refuses to attach to a payment that has already moved on', async () => {
    const order = await cardOrder();
    await db.update(payments).set({ status: 'paid' }).where(eq(payments.orderId, order.id));

    expect(
      await attachGatewayCharge(db, { orderId: order.id, gateway: 'stripe', gatewayChargeId: 'cs_1', expiresAt: null }),
    ).toBe(false);
    expect(await findGatewayPayment(db, 'stripe', 'cs_1')).toBeNull();
  });

  it('does not find a session under another gateway’s name', async () => {
    const order = await cardOrder();
    await attachGatewayCharge(db, { orderId: order.id, gateway: 'stripe', gatewayChargeId: 'cs_1', expiresAt: null });
    expect(await findGatewayPayment(db, 'conekta', 'cs_1')).toBeNull();
  });
});

describe.skipIf(!PG_AVAILABLE)('OXXO voucher deadline', () => {
  it('extends a pending payment, and never shortens one', async () => {
    const order = await cardOrder();
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    const later = new Date(Date.now() + 4 * 86_400_000);

    await extendPaymentDeadline(db, payment!.id, later);
    await extendPaymentDeadline(db, payment!.id, new Date(Date.now() + 60_000));

    const [after] = await db.select().from(payments).where(eq(payments.id, payment!.id));
    expect(after?.expiresAt?.getTime()).toBe(later.getTime());
  });
});

describe.skipIf(!PG_AVAILABLE)('webhook event log', () => {
  const event = { gateway: 'stripe', eventId: 'evt_1', eventType: 'checkout.session.completed', payload: { id: 'evt_1' } };

  it('records a delivery once, however often it arrives', async () => {
    const first = await recordPaymentEvent(db, event);
    const second = await recordPaymentEvent(db, event);

    expect(second.id).toBe(first.id);
    expect(await db.select().from(paymentEvents)).toHaveLength(1);
  });

  it('retries a delivery that was recorded but never finished', async () => {
    // The failure this guards against: record, crash, and every redelivery
    // after that dropped as a duplicate — a paid customer who never gets served.
    const first = await recordPaymentEvent(db, event);
    expect(first.alreadyProcessed).toBe(false);
    expect((await recordPaymentEvent(db, event)).alreadyProcessed).toBe(false);

    await markPaymentEventProcessed(db, first.id, null);
    expect((await recordPaymentEvent(db, event)).alreadyProcessed).toBe(true);
  });
});

describe.skipIf(!PG_AVAILABLE)('a card payment end to end', () => {
  it('enqueues the order exactly once across redelivered webhooks', async () => {
    const order = await cardOrder();
    await attachGatewayCharge(db, { orderId: order.id, gateway: 'stripe', gatewayChargeId: 'cs_1', expiresAt: null });
    const deps = { store: new DrizzlePaymentStore(db) };
    const report = { orderId: order.id, state: 'paid' as const, amountReceivedCents: 1_000, reference: 'pi_1' };

    const results = await Promise.all([
      settleGatewayCharge(deps, report),
      settleGatewayCharge(deps, report).catch((err: unknown) => ({ action: 'raced', err })),
    ]);

    // One wins; the other either sees it already paid or loses the guarded
    // update and throws — never a second enqueue.
    expect(results.filter((r) => r.action === 'approved')).toHaveLength(1);
    const [row] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(row?.status).toBe('payment_confirmed');
    const [payment] = await db.select().from(payments).where(eq(payments.orderId, order.id));
    expect(payment).toMatchObject({ status: 'paid', amountReceivedCents: 1_000, reference: 'pi_1' });
  });

  it('frees the Mega Oferta slot when the checkout is abandoned', async () => {
    const order = await cardOrder();
    await settleGatewayCharge(
      { store: new DrizzlePaymentStore(db) },
      { orderId: order.id, state: 'expired', amountReceivedCents: null, reference: null },
    );

    // The same player can try again — the one-per-player index ignores
    // expired orders.
    await expect(cardOrder()).resolves.toBeDefined();
  });
});
