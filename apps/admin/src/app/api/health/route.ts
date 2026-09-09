/**
 * Liveness and readiness for the admin panel.
 *
 * Unauthenticated by design — a healthcheck that needs a session cannot run
 * before there is one — so it says only whether the process and its database
 * are up. No counts, no order data, no configuration.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.execute(sql`select 1`);
  } catch {
    return Response.json(
      { status: 'degraded', database: 'unreachable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  return Response.json(
    { status: 'ok' },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
