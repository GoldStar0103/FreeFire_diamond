/**
 * Postgres advisory lock — the single-flight guarantee the whole fulfilment
 * design rests on.
 *
 * Two decisions here are load-bearing and easy to get wrong:
 *
 * 1. SESSION-scoped, not transaction-scoped.
 *
 *    `pg_advisory_xact_lock` would be safer in isolation — it releases
 *    automatically at commit and cannot leak. But it would force the whole
 *    critical section into one transaction, and the engine must COMMIT the
 *    `sending` row *before* the provider call goes out. That commit is the only
 *    evidence a call was attempted if the process dies mid-flight. A
 *    transaction-scoped lock would make crash recovery impossible, so we take
 *    the session-scoped lock and release it explicitly.
 *
 * 2. Held on a RESERVED connection.
 *
 *    Session-scoped locks belong to a connection. With a pool, acquiring on one
 *    connection and releasing on another silently leaks the lock forever —
 *    every later order then blocks. `sql.reserve()` pins one connection for the
 *    duration so acquire and release provably happen on the same session.
 *
 * The crash-safety property falls out of this: if the process dies, the
 * connection dies, and Postgres releases the lock. No stuck queue.
 */

import type { AdvisoryLock } from '@levelup/engine';
import type { Sql } from 'postgres';

/** Namespace for this application's locks, so keys cannot collide with anyone else's. */
const LOCK_NAMESPACE = 0x4c55; // 'LU'

/**
 * FNV-1a, folded to a signed 32-bit int.
 *
 * Deliberately not Postgres's `hashtext()`: that is an internal function with
 * no stability guarantee across major versions, and a lock key that changes
 * after an upgrade would silently stop excluding anything.
 */
export function lockKeyFor(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

export interface PostgresAdvisoryLockOptions {
  /**
   * Give up acquiring after this long rather than blocking forever behind a
   * hung worker. An eight-call combo with a 1.5s pacing delay needs well under
   * a minute, so a couple of minutes is generous without being indefinite.
   */
  lockTimeoutMs?: number;
}

export class PostgresAdvisoryLock implements AdvisoryLock {
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly sql: Sql,
    options: PostgresAdvisoryLockOptions = {},
  ) {
    const timeout = options.lockTimeoutMs ?? 120_000;
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new RangeError(`lockTimeoutMs must be a positive integer, got ${timeout}`);
    }
    this.lockTimeoutMs = timeout;
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockId = lockKeyFor(key);
    const conn = await this.sql.reserve();

    try {
      // Integer-validated in the constructor, so this interpolation is safe —
      // SET does not accept bind parameters.
      await conn.unsafe(`SET lock_timeout = ${this.lockTimeoutMs}`);
      await conn`SELECT pg_advisory_lock(${LOCK_NAMESPACE}::int, ${lockId}::int)`;

      try {
        return await fn();
      } finally {
        // Must run on the same connection that acquired it. Failing to release
        // is worse than failing the work, so this is not conditional.
        await conn`SELECT pg_advisory_unlock(${LOCK_NAMESPACE}::int, ${lockId}::int)`;
      }
    } finally {
      conn.release();
    }
  }

  /**
   * Non-blocking variant. Returns `null` when the lock is already held.
   *
   * The pollers and recovery crons use this: if fulfilment is mid-combo there
   * is nothing useful for them to do, and queueing up behind it would just
   * stack timers.
   */
  async tryWithLock<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
    const lockId = lockKeyFor(key);
    const conn = await this.sql.reserve();

    try {
      const [row] = await conn<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_lock(${LOCK_NAMESPACE}::int, ${lockId}::int) AS acquired
      `;
      if (!row?.acquired) return null;

      try {
        return await fn();
      } finally {
        await conn`SELECT pg_advisory_unlock(${LOCK_NAMESPACE}::int, ${lockId}::int)`;
      }
    } finally {
      conn.release();
    }
  }
}
