/** Admin Vault offer management against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { adminUsers, auditLog, campaigns, combos, vaultOffers } from '../schema.js';
import {
  deleteVaultOffer,
  listActiveCombosForOffers,
  listVaultOffersForAdmin,
  saveVaultOffer,
  toggleVaultOffer,
} from './vault-admin-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_vault_admin_test';

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
  await db.execute(raw`TRUNCATE vault_offers, combos, campaigns, admin_users, audit_log RESTART IDENTITY CASCADE`);
});

async function seedAdmin(): Promise<string> {
  const [admin] = await db.insert(adminUsers).values({ email: `admin-${Date.now()}-${Math.random()}@test.com`, passwordHash: 'x' }).returning();
  return admin!.id;
}

async function seedCombo(priceMxnCents = 10_000): Promise<string> {
  const [campaign] = await db.insert(campaigns).values({ key: 'test', name: 'Test' }).returning();
  const [combo] = await db
    .insert(combos)
    .values({ campaignId: campaign!.id, key: `combo-${Math.random()}`, name: 'Combo de prueba', priceMxnCents, advertisedDiamonds: 100, active: true })
    .returning();
  return combo!.id;
}

describe('listActiveCombosForOffers', () => {
  it('lists only active combos', async () => {
    await seedCombo();
    const [campaign] = await db.insert(campaigns).values({ key: 'c2', name: 'C2' }).returning();
    await db.insert(combos).values({ campaignId: campaign!.id, key: 'inactive', name: 'Inactivo', priceMxnCents: 5_000, advertisedDiamonds: 50, active: false });

    const options = await listActiveCombosForOffers(db);
    expect(options).toHaveLength(1);
    expect(options[0]?.name).toBe('Combo de prueba');
  });
});

describe('saveVaultOffer', () => {
  it('refuses a Vault price that is not lower than the public price', async () => {
    const comboId = await seedCombo(10_000);
    const adminUserId = await seedAdmin();

    const result = await saveVaultOffer(db, { comboId, vaultPriceMxnCents: 10_000, sortOrder: 0, active: true }, adminUserId);
    expect(result).toEqual({ ok: false, reason: 'price_not_lower' });
    expect(await db.select().from(vaultOffers)).toEqual([]);
  });

  it('creates an offer and logs it', async () => {
    const comboId = await seedCombo(10_000);
    const adminUserId = await seedAdmin();

    const result = await saveVaultOffer(db, { comboId, vaultPriceMxnCents: 7_000, sortOrder: 1, active: true }, adminUserId);
    expect(result.ok).toBe(true);

    const offers = await listVaultOffersForAdmin(db);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ comboName: 'Combo de prueba', publicPriceMxnCents: 10_000, vaultPriceMxnCents: 7_000 });

    const [log] = await db.select().from(auditLog);
    expect(log).toMatchObject({ adminUserId, action: 'vault_offer.create' });
  });

  it('updates the same offer when an id is given', async () => {
    const comboId = await seedCombo(10_000);
    const adminUserId = await seedAdmin();
    const created = await saveVaultOffer(db, { comboId, vaultPriceMxnCents: 7_000, sortOrder: 1, active: true }, adminUserId);
    if (!created.ok) throw new Error('unreachable');

    await saveVaultOffer(db, { id: created.id, comboId, vaultPriceMxnCents: 6_500, sortOrder: 2, active: false }, adminUserId);

    const offers = await listVaultOffersForAdmin(db);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ vaultPriceMxnCents: 6_500, sortOrder: 2, active: false });
  });
});

describe('toggleVaultOffer / deleteVaultOffer', () => {
  it('toggles active and logs it', async () => {
    const comboId = await seedCombo(10_000);
    const adminUserId = await seedAdmin();
    const created = await saveVaultOffer(db, { comboId, vaultPriceMxnCents: 7_000, sortOrder: 0, active: true }, adminUserId);
    if (!created.ok) throw new Error('unreachable');

    await toggleVaultOffer(db, created.id, false, adminUserId);
    const [offer] = await db.select().from(vaultOffers).where(eq(vaultOffers.id, created.id));
    expect(offer?.active).toBe(false);
  });

  it('deletes the offer and logs it', async () => {
    const comboId = await seedCombo(10_000);
    const adminUserId = await seedAdmin();
    const created = await saveVaultOffer(db, { comboId, vaultPriceMxnCents: 7_000, sortOrder: 0, active: true }, adminUserId);
    if (!created.ok) throw new Error('unreachable');

    await deleteVaultOffer(db, created.id, adminUserId);
    expect(await listVaultOffersForAdmin(db)).toEqual([]);
  });
});
