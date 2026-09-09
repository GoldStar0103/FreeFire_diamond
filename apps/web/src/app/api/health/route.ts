/**
 * Liveness and readiness for the storefront.
 *
 * Used by the compose healthcheck and by Caddy before sending traffic to a
 * freshly started container. It touches the database on purpose: a Next process
 * that has booted but cannot reach Postgres serves an error page to every
 * visitor, and "the port is open" would call that healthy.
 *
 * The body is deliberately dull. This endpoint is reachable without auth, so it
 * reports whether we are up and nothing whatsoever about how.
 */

import { sql } from 'drizzle-orm';
import { getDb } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
  } catch {
    // No error detail: the reason is in the logs, where it is not public.
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
