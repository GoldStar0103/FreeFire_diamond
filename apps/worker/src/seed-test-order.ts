/**
 * Place a real order through the real ordering path, optionally approving the
 * payment so the worker picks it up.
 *
 * Useful locally, and on the client's staging environment when they want to
 * watch a combo run end to end before trusting it with money.
 *
 *   DATABASE_URL=... TEST_PLAYER_ID=... pnpm --filter @levelup/worker seed-test-order mega_prime_48k --approve
 *
 * TEST_PLAYER_ID has no default. Every Free Fire ID is a real account —
 * there is no such thing as a made-up one that is safe to guess — and this
 * script's own default silently pointed at an actual customer's account for
 * most of this project, discovered only when a live run really delivered
 * diamonds to them. Whoever runs this now has to consciously supply an ID
 * they actually control or expect, rather than trusting a stale fallback.
 */

import { createDb, DrizzleOrderingStore, DrizzlePaymentStore } from '@levelup/db';
import { approvePayment, createOrder } from '@levelup/engine';

const comboKey = process.argv[2] ?? 'mega_prime_48k';
const approve = process.argv.includes('--approve');
const playerId = process.env.TEST_PLAYER_ID;
if (!playerId) {
  throw new Error(
    'TEST_PLAYER_ID is required — every Free Fire ID is a real account, so ' +
      'there is no safe default. Set it to an ID you actually control or expect.',
  );
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const { db, client } = createDb(databaseUrl);

try {
  const created = await createOrder(
    { store: new DrizzleOrderingStore(db) },
    {
      comboKey,
      playerId,
      playerNickname: 'ElCarneseca',
      paymentMethod: 'transfer_manual',
      // Admin source so a combo seeded inactive can still be exercised.
      source: 'admin',
    },
  );

  if (!created.ok) {
    console.error(`Could not create the order: ${created.failure.code}`);
    console.error(created.failure.message);
    process.exitCode = 1;
  } else {
    const { order } = created;
    console.log(
      `${order.orderNumber}  ${order.comboSnapshot.name}  ` +
        `$${(order.priceMxnCents / 100).toFixed(2)} MXN  ` +
        `${order.items.length} provider call(s)  ` +
        `${order.comboSnapshot.deliveredDiamonds.toLocaleString('en-US')} 💎`,
    );

    if (approve) {
      // What an admin tapping "aprobar" on a comprobante does. This write is
      // the enqueue — the worker can claim the order from here.
      const approval = await approvePayment(
        { store: new DrizzlePaymentStore(db) },
        { orderId: order.id, adminUserId: null, reference: 'SEED-TEST' },
      );

      if (approval.ok) {
        console.log(`Approved — the worker will pick it up.`);
      } else {
        console.error(`Approval failed: ${approval.failure.code} — ${approval.failure.message}`);
        process.exitCode = 1;
      }
    } else {
      console.log(`Left as pending_payment. Re-run with --approve to enqueue it.`);
    }
  }
} finally {
  await client.end({ timeout: 5 });
}
