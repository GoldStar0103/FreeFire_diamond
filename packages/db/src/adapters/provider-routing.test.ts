/**
 * Active-provider setting's round-trip, against real Postgres.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { auditLog } from '../schema.js';
import { getActiveProvider, setActiveProvider } from './provider-routing.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_provider_routing_test';

const PG_AVAILABLE = await (async () => {
  const probe = postgres(`${BASE_URL}/postgres`, { max: 1, connect_timeout: 3 });
  try {
    await probe`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.end({ timeout: 2 }).catch(() => undefined);
  }
})();

let db: Database;
let client: ReturnType<typeof createDb>['client'];

beforeAll(async () => {
  if (!PG_AVAILABLE) return;
  const admin = postgres(`${BASE_URL}/postgres`, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  ({ db, client } = createDb(`${BASE_URL}/${TEST_DB}`, { max: 5 }));
  await migrate(db, { migrationsFolder: MIGRATIONS });
}, 180_000);

afterAll(async () => {
  await client?.end({ timeout: 5 });
}, 30_000);

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(raw`TRUNCATE settings, audit_log RESTART IDENTITY CASCADE`);
});

describe.skipIf(!PG_AVAILABLE)('active provider', () => {
  it('defaults to RecargasAmérica when nothing has been saved', async () => {
    expect(await getActiveProvider(db)).toEqual({ provider: 'recargas_america' });
  });

  it('round-trips to Central One and back', async () => {
    await setActiveProvider(db, 'central_one', null);
    expect(await getActiveProvider(db)).toEqual({ provider: 'central_one' });

    await setActiveProvider(db, 'recargas_america', null);
    expect(await getActiveProvider(db)).toEqual({ provider: 'recargas_america' });
  });

  it('audits every switch with the target provider in the detail', async () => {
    // `null` here, as every other adapter test does — a real adminUserId is a
    // foreign key into `admin_users`, which this test does not seed.
    await setActiveProvider(db, 'central_one', null);
    await setActiveProvider(db, 'recargas_america', null);

    const rows = await db.select().from(auditLog);
    expect(rows.map((r) => r.action)).toEqual([
      'settings.active_provider_changed',
      'settings.active_provider_changed',
    ]);
    expect(rows.map((r) => r.detail)).toEqual([
      { provider: 'central_one' },
      { provider: 'recargas_america' },
    ]);
  });
});
