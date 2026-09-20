/**
 * Resume a needs_review order from the command line.
 *
 * What "Reanudar" in Pedidos does, for when there is no admin session at hand
 * to click it — e.g. a stuck order being recovered right after a provider
 * outage is fixed. Runs through the same @levelup/engine applyReviewAction
 * used by the panel, so the same guards (refuses while any item's outcome is
 * still unknown, so a click here can never cause a double delivery) and the
 * same audit log entry apply.
 *
 *   DATABASE_URL=... pnpm --filter @levelup/worker resume-order <orderId> <adminUserId>
 */

import { createDb, DrizzleReviewStore } from '@levelup/db';
import { applyReviewAction } from '@levelup/engine';

const orderId = process.argv[2];
const adminUserId = process.argv[3];

if (!orderId || !adminUserId) {
  throw new Error('Usage: resume-order <orderId> <adminUserId>');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');

const { db, client } = createDb(databaseUrl);

try {
  const result = await applyReviewAction(
    { store: new DrizzleReviewStore(db) },
    { orderId, adminUserId, action: { kind: 'resume' } },
  );

  if (result.ok) {
    console.log(`${result.orderNumber} resumed — now ${result.nextStatus}. The worker will retry it.`);
  } else {
    console.error(`Could not resume: ${result.failure.code} — ${result.failure.message}`);
    process.exitCode = 1;
  }
} finally {
  await client.end({ timeout: 5 });
}
