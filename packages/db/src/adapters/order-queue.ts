/**
 * The work queue.
 *
 * There isn't a separate queue: the `orders` table is the queue. A payment
 * webhook writing `payment_confirmed` in its own transaction *is* the enqueue,
 * which removes the dual-write problem a message broker would reintroduce —
 * no way to commit the payment and lose the job, or vice versa.
 *
 * At this volume (hundreds of orders a day, provider calls pinned to one in
 * flight) a broker would add moving parts and buy nothing.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../index.js';

export interface ClaimedOrder {
  id: string;
  orderNumber: string;
  /** True when this order was recovered from a stalled `processing` state. */
  recovered: boolean;
}

export class DrizzleOrderQueue {
  constructor(private readonly db: Database) {}

  /**
   * Atomically claim the next order to fulfil.
   *
   * One statement, so the claim cannot be lost between reading and marking.
   * `FOR UPDATE SKIP LOCKED` means a second worker takes the next row rather
   * than blocking, and never the same one.
   *
   * The `processing` branch makes this self-healing: an order whose worker died
   * after claiming it sits untouched until it goes stale, then gets picked up
   * again. Item-level state decides what actually still needs sending, so
   * re-running is safe.
   */
  async claimNext(staleAfterMs: number): Promise<ClaimedOrder | null> {
    const staleSeconds = staleAfterMs / 1000;

    // The previous status is captured in the CTE because RETURNING reports the
    // NEW row, which is always 'processing' by then. Postgres 18 could use
    // `RETURNING OLD.status`, but the client's server may be older.
    const rows = await this.db.execute<{
      id: string;
      order_number: string;
      prev_status: string;
    }>(sql`
      WITH candidate AS (
        SELECT o.id, o.status AS prev_status
          FROM orders o
         WHERE o.status IN ('payment_confirmed', 'partially_delivered')
            OR (o.status = 'processing'
                AND o.updated_at < now() - make_interval(secs => ${staleSeconds}))
         ORDER BY o.created_at ASC
         LIMIT 1
           FOR UPDATE SKIP LOCKED
      )
      UPDATE orders o
         SET status = 'processing', updated_at = now()
        FROM candidate c
       WHERE o.id = c.id
   RETURNING o.id, o.order_number, c.prev_status
    `);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      orderNumber: row.order_number,
      recovered: row.prev_status === 'processing',
    };
  }

  /** Depth by status, for the admin dashboard and the low-throughput alert. */
  async depth(): Promise<Record<string, number>> {
    const rows = await this.db.execute<{ status: string; count: string }>(sql`
      SELECT status, COUNT(*)::text AS count
        FROM orders
       WHERE status IN ('payment_confirmed', 'processing', 'partially_delivered', 'needs_review')
       GROUP BY status
    `);

    return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  }
}
