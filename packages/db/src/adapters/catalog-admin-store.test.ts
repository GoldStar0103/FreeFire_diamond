/**
 * Combo authoring against real Postgres.
 *
 * This is the flow the client runs alone every month, so the assertions are
 * about what survives a mistake: a failed save leaves nothing half-written, and
 * retiring a promo never destroys the orders that reference it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { asc, eq, sql as raw } from 'drizzle-orm';
import { reviewComboDraft, type ComboDraft } from '@levelup/engine';
import { createDb, type Database } from '../index.js';
import { auditLog, baseProducts, campaigns, comboItems, combos } from '../schema.js';
import { DrizzleCatalogAdminStore } from './catalog-admin-store.js';
import { listStorefront } from './storefront-queries.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_catalog_admin_test';

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
let campaignId: string;

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
  await db.execute(
    raw`TRUNCATE orders, order_items, payments, combo_items, combos, campaigns, base_products, audit_log RESTART IDENTITY CASCADE`,
  );

  for (const [d, cost] of [
    [100, '0.7000'],
    [1060, '6.5900'],
    [2180, '13.0700'],
    [5600, '33.2700'],
  ] as const) {
    await db.insert(baseProducts).values({
      providerProductId: `p${d}`,
      endpointKind: 'pins_recharge',
      name: `Free Fire ${d}`,
      diamondsBase: d,
      costUsd: cost,
      canValidate: true,
    });
  }

  const [campaign] = await db
    .insert(campaigns)
    .values({ key: 'super_packs', name: 'SUPER PACKS' })
    .returning();
  campaignId = campaign!.id;
});

const store = () => new DrizzleCatalogAdminStore(db);

const draft = (overrides: Partial<ComboDraft> = {}): ComboDraft => ({
  key: 'pack_insano',
  name: 'Pack Insano',
  priceMxnCents: 86_000,
  advertisedDiamonds: 7200,
  maxPerPlayer: null,
  recipe: [5600, 1060],
  active: true,
  ...overrides,
});

const save = (d: ComboDraft, sortOrder = 0) =>
  store().saveCombo(d, { campaignId, sortOrder, adminUserId: null });

describe.skipIf(!PG_AVAILABLE)('saveCombo', () => {
  it('creates a combo with its recipe in order', async () => {
    await save(draft());

    const [combo] = await db.select().from(combos).where(eq(combos.key, 'pack_insano'));
    expect(combo?.advertisedDiamonds).toBe(7200);

    const recipe = await db
      .select({ diamondsBase: baseProducts.diamondsBase, sequence: comboItems.sequence })
      .from(comboItems)
      .innerJoin(baseProducts, eq(baseProducts.id, comboItems.baseProductId))
      .where(eq(comboItems.comboId, combo!.id))
      .orderBy(asc(comboItems.sequence));

    expect(recipe.map((r) => r.diamondsBase)).toEqual([5600, 1060]);
  });

  it('replaces the recipe wholesale on edit', async () => {
    await save(draft());
    await save(draft({ recipe: [2180, 2180, 100] }));

    const loaded = await store().loadComboDraft('pack_insano');
    expect(loaded?.recipe).toEqual([2180, 2180, 100]);
  });

  it('round-trips a draft for editing', async () => {
    await save(draft({ maxPerPlayer: 1 }));
    const loaded = await store().loadComboDraft('pack_insano');

    expect(loaded).toMatchObject({
      key: 'pack_insano',
      name: 'Pack Insano',
      priceMxnCents: 86_000,
      advertisedDiamonds: 7200,
      maxPerPlayer: 1,
      recipe: [5600, 1060],
      active: true,
    });
  });

  it('writes nothing when a denomination has no active product', async () => {
    // The validator should catch this first; if the catalog changes underneath,
    // the transaction must not leave a combo with a broken recipe.
    await db.update(baseProducts).set({ active: false }).where(eq(baseProducts.diamondsBase, 5600));

    await expect(save(draft())).rejects.toThrow(/No active provider product/);
    expect(await db.select().from(combos)).toHaveLength(0);
    expect(await db.select().from(comboItems)).toHaveLength(0);
  });

  it('leaves the previous recipe intact when an edit fails', async () => {
    await save(draft());
    await db.update(baseProducts).set({ active: false }).where(eq(baseProducts.diamondsBase, 2180));

    await expect(save(draft({ recipe: [2180, 2180] }))).rejects.toThrow();

    const loaded = await store().loadComboDraft('pack_insano');
    expect(loaded?.recipe).toEqual([5600, 1060]);
  });

  it('records who changed what', async () => {
    await save(draft());
    const [entry] = await db.select().from(auditLog);
    expect(entry?.action).toBe('combo.saved');
    expect(entry?.detail).toMatchObject({ key: 'pack_insano', recipe: [5600, 1060] });
  });

  it('returns null for a combo that does not exist', async () => {
    expect(await store().loadComboDraft('no_existe')).toBeNull();
  });
});

describe.skipIf(!PG_AVAILABLE)('activation', () => {
  it('keeps an inactive draft off the storefront', async () => {
    await save(draft({ active: false }));
    const keys = (await listStorefront(db)).flatMap((c) => c.combos.map((x) => x.key));
    expect(keys).not.toContain('pack_insano');
  });

  it('puts it on sale once activated', async () => {
    await save(draft({ active: false }));
    await store().setComboActive('pack_insano', true, null);

    const keys = (await listStorefront(db)).flatMap((c) => c.combos.map((x) => x.key));
    expect(keys).toContain('pack_insano');
  });

  it('logs activation distinctly from deactivation', async () => {
    await save(draft());
    await store().setComboActive('pack_insano', false, null);
    await store().setComboActive('pack_insano', true, null);

    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toContain('combo.deactivated');
    expect(actions).toContain('combo.activated');
  });

  it('fails loudly on an unknown combo', async () => {
    await expect(store().setComboActive('no_existe', true, null)).rejects.toThrow(/No combo/);
  });
});

describe.skipIf(!PG_AVAILABLE)('the monthly rotation', () => {
  beforeEach(async () => {
    await save(draft({ key: 'pack_a', name: 'Pack A' }), 0);
    await save(draft({ key: 'pack_b', name: 'Pack B' }), 1);
  });

  it('retires a whole promo in one action', async () => {
    const retired = await store().retireCampaign('super_packs', null);

    expect(retired).toBe(2);
    expect(await listStorefront(db)).toEqual([]);
  });

  it('deactivates rather than deletes, so past orders stay readable', async () => {
    await store().retireCampaign('super_packs', null);

    // Both rows survive; they are simply no longer on sale.
    expect(await db.select().from(combos)).toHaveLength(2);
    expect(await db.select().from(comboItems)).toHaveLength(4);
    expect((await db.select().from(campaigns))[0]?.active).toBe(false);
  });

  it('is idempotent', async () => {
    await store().retireCampaign('super_packs', null);
    expect(await store().retireCampaign('super_packs', null)).toBe(0);
  });
});

describe.skipIf(!PG_AVAILABLE)('saveCampaign', () => {
  it('does not wipe the flyer when only dates are edited', async () => {
    // Editing a campaign's window must not silently lose its image.
    await store().saveCampaign(
      {
        key: 'lluvia',
        name: 'LLUVIA DE DIAMANTES',
        badge: null,
        permanent: false,
        active: true,
        startsAt: null,
        endsAt: null,
      },
      { sortOrder: 0, flyerAssetUrl: 'flyers/lluvia.jpg', adminUserId: null },
    );

    await store().saveCampaign(
      {
        key: 'lluvia',
        name: 'LLUVIA DE DIAMANTES',
        badge: 'MÁS POPULAR',
        permanent: false,
        active: true,
        startsAt: null,
        endsAt: new Date('2026-10-01'),
      },
      { sortOrder: 0, adminUserId: null },
    );

    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.key, 'lluvia'));
    expect(campaign?.flyerAssetUrl).toBe('flyers/lluvia.jpg');
    expect(campaign?.badge).toBe('MÁS POPULAR');
  });

  it('replaces the flyer when a new one is given', async () => {
    await store().saveCampaign(
      { key: 'lluvia', name: 'LLUVIA', badge: null, permanent: false, active: true, startsAt: null, endsAt: null },
      { sortOrder: 0, flyerAssetUrl: 'flyers/old.jpg', adminUserId: null },
    );
    await store().saveCampaign(
      { key: 'lluvia', name: 'LLUVIA', badge: null, permanent: false, active: true, startsAt: null, endsAt: null },
      { sortOrder: 0, flyerAssetUrl: 'flyers/new.jpg', adminUserId: null },
    );

    const [campaign] = await db.select().from(campaigns).where(eq(campaigns.key, 'lluvia'));
    expect(campaign?.flyerAssetUrl).toBe('flyers/new.jpg');
  });
});

describe.skipIf(!PG_AVAILABLE)('validator against the live catalog', () => {
  it('blocks an under-delivering combo using real provider costs', async () => {
    const products = await store().listAvailableProducts();
    const review = reviewComboDraft(
      draft({ advertisedDiamonds: 3600, recipe: [2180, 1060] }),
      products,
      18.5,
    );

    expect(review.canActivate).toBe(false);
    expect(review.errors.map((e) => e.code)).toContain('UNDER_DELIVERS');
  });

  it('computes a margin from the synced costs', async () => {
    const products = await store().listAvailableProducts();
    const review = reviewComboDraft(draft(), products, 18.5);

    expect(review.costUsd).toBeCloseTo(39.86, 2);
    expect(review.marginPct).toBeCloseTo(14.3, 1);
  });
});

describe.skipIf(!PG_AVAILABLE)('nextComboSortOrder', () => {
  it('appends rather than landing on top', async () => {
    expect(await store().nextComboSortOrder(campaignId)).toBe(0);
    await save(draft({ key: 'a', name: 'A' }), 0);
    await save(draft({ key: 'b', name: 'B' }), 5);
    expect(await store().nextComboSortOrder(campaignId)).toBe(6);
  });
});
