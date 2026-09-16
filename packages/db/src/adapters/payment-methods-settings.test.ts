/**
 * `getPaymentMethodsEnabled`/`savePaymentMethodsEnabled` against real Postgres
 * — the settings-table round trip is the whole point, so a mock would test
 * nothing real.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Database } from '../index.js';
import { getPaymentMethodsEnabled, savePaymentMethodsEnabled } from './payment-settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_payment_methods_test';

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

describe.skipIf(!PG_AVAILABLE)('getPaymentMethodsEnabled / savePaymentMethodsEnabled', () => {
  it('defaults all-true when nothing has been saved — an unconfigured deployment keeps working', async () => {
    expect(await getPaymentMethodsEnabled(db)).toEqual({ card: true, transfer: true, oxxo: true });
  });

  it('saves and reads back exactly what was written', async () => {
    await savePaymentMethodsEnabled(db, { card: true, transfer: false, oxxo: false });
    expect(await getPaymentMethodsEnabled(db)).toEqual({ card: true, transfer: false, oxxo: false });
  });

  it('a later save overwrites the earlier one rather than merging', async () => {
    await savePaymentMethodsEnabled(db, { card: false, transfer: true, oxxo: true });
    expect(await getPaymentMethodsEnabled(db)).toEqual({ card: false, transfer: true, oxxo: true });

    await savePaymentMethodsEnabled(db, { card: true, transfer: true, oxxo: true });
    expect(await getPaymentMethodsEnabled(db)).toEqual({ card: true, transfer: true, oxxo: true });
  });
});
