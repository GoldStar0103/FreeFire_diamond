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

const handle = globalThis.__levelupDb ?? connect();
if (process.env.NODE_ENV !== 'production') globalThis.__levelupDb = handle;

export const db = handle.db;
export const sqlClient = handle.client;
