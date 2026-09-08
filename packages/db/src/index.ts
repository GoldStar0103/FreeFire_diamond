import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';
export * from './adapters/advisory-lock.js';
export * from './adapters/fulfillment-store.js';
export * from './adapters/mapping.js';

/**
 * Provider calls are serialised to one in flight globally (the wallet-delta
 * reconciliation depends on it), so the pool stays small. Raising `max` does
 * not raise fulfilment throughput.
 *
 * The pool does need headroom beyond the worker itself: `PostgresAdvisoryLock`
 * reserves a connection for the whole duration of a combo, so a `max` of 1
 * would deadlock the moment the engine tried to read anything while holding it.
 */
export function createDb(connectionString: string, options?: { max?: number }) {
  // postgres.js already returns NUMERIC as a string rather than coercing it to
  // a float, which is exactly what money needs — no custom type override.
  const client = postgres(connectionString, { max: options?.max ?? 10 });
  return { db: drizzle(client, { schema }), client };
}

export type Database = ReturnType<typeof createDb>['db'];
export * from './adapters/recovery-store.js';
export * from './adapters/order-queue.js';
export * from './adapters/ordering-store.js';
export * from './adapters/payment-store.js';
export * from './adapters/catalog-sync-store.js';
export * from './adapters/admin-queries.js';
export * from './adapters/storefront-queries.js';
export * from './adapters/catalog-admin-store.js';
