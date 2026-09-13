/**
 * Reject a pending/under-review payment from the command line.
 *
 * What "rechazar" in Aprobaciones does, for when there is no admin session at
 * hand to click it — e.g. reviewing a comprobante that was pulled and checked
 * outside the panel. Runs through the same @levelup/engine rejectPayment used
 * by the panel, so the same guards (no rejecting money that already arrived)
 * and the same audit log entry apply.
 *
 *   DATABASE_URL=... pnpm --filter @levelup/worker reject-payment <orderId> "<reason>" [adminUserId]
 */

import { createDb, DrizzlePaymentStore } from '@levelup/db';
import { rejectPayment } from '@levelup/engine';

const orderId = process.argv[2];
const reason = process.argv[3];
const adminUserId = process.argv[4] ?? null;

if (!orderId || !reason) {
  throw new Error('Usage: reject-payment <orderId> "<reason>" [adminUserId]');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const { db, client } = createDb(databaseUrl);

try {
  const result = await rejectPayment(
    { store: new DrizzlePaymentStore(db) },
    { orderId, adminUserId, reason },
  );

  if (result.ok) {
    console.log(`${result.orderNumber} rejected and cancelled.`);
  } else {
    console.error(`Could not reject: ${result.failure.code} — ${result.failure.message}`);
    process.exitCode = 1;
  }
} finally {
  await client.end({ timeout: 5 });
}
