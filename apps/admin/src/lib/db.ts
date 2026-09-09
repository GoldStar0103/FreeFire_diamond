/**
 * Database singleton.
 *
 * Next dev reloads modules on every edit, so the connection is cached on
 * `globalThis` — otherwise each hot reload opens a fresh pool and Postgres runs
 * out of connections within a few minutes of editing.
 */

import 'server-only';
import { createDb } from '@levelup/db';

declare global {
  // eslint-disable-next-line no-var
  var __levelupDb: ReturnType<typeof createDb> | undefined;
}

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  // The admin panel is read-mostly and low-traffic; the worker owns throughput.
  return createDb(url, { max: 5 });
}

let handle: ReturnType<typeof createDb> | undefined;

/**
 * Opened on first use, not at import.
 *
 * `next build` evaluates every route's modules to collect page data, so
 * connecting at import made DATABASE_URL a *build-time* requirement — and the
 * container image builds with no environment at all, so `docker build` would
 * have failed on it, as would CI. Building should not need infrastructure.
 *
 * The module-level `handle` is the real singleton; the `globalThis` copy exists
 * only to survive the module reloads Next does on every edit in development,
 * which would otherwise leak a pool per save.
 */
function getHandle(): ReturnType<typeof createDb> {
  handle ??= globalThis.__levelupDb ?? connect();
  if (process.env.NODE_ENV !== 'production') globalThis.__levelupDb = handle;
  return handle;
}

export const getDb = (): ReturnType<typeof createDb>['db'] => getHandle().db;
export const getSqlClient = (): ReturnType<typeof createDb>['client'] => getHandle().client;
