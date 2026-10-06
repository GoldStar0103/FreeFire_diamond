/** Level Pass checkpoint settings against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { baseProducts } from '../schema.js';
import {
  DEFAULT_LEVEL_PASS_CHECKPOINTS,
  getLevelPassCheckpoints,
  reviewLevelPassCheckpoints,
  saveLevelPassCheckpoints,
  type LevelPassCheckpointDraft,
} from './level-pass-settings.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_level_pass_settings_test';

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

/** A minimal active provider product for the given denomination, for recipe resolution. */
async function seedProduct(diamondsBase: number): Promise<void> {
  await db.insert(baseProducts).values({
    providerProductId: `prov-${diamondsBase}`,
    endpointKind: 'pins_recharge',
    name: `Test ${diamondsBase}`,
    diamondsBase,
    costUsd: '1.0000',
    active: true,
  });
}

const draft = (overrides: Partial<LevelPassCheckpointDraft> = {}): LevelPassCheckpointDraft => ({
  lp: 10,
  rewardDiamonds: 5,
  costCents: 50,
  recipe: [5],
  ...overrides,
});

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(raw`TRUNCATE settings, base_products CASCADE`);
});

describe('getLevelPassCheckpoints', () => {
  it('returns the default ladder when nothing has been saved', async () => {
    expect(await getLevelPassCheckpoints(db)).toEqual(DEFAULT_LEVEL_PASS_CHECKPOINTS);
  });

  it('returns a saved ladder, pinned to the active product for its recipe, and saving again overwrites it', async () => {
    await seedProduct(5);
    await saveLevelPassCheckpoints(db, [draft()]);
    const [saved] = await getLevelPassCheckpoints(db);
    expect(saved).toMatchObject({ lp: 10, rewardDiamonds: 5, costCents: 50 });
    expect(saved?.recipe).toHaveLength(1);
    expect(saved?.recipe[0]?.diamondsBase).toBe(5);

    await seedProduct(15);
    await saveLevelPassCheckpoints(db, [draft({ lp: 20, rewardDiamonds: 15, costCents: 150, recipe: [15] })]);
    const [resaved] = await getLevelPassCheckpoints(db);
    expect(resaved).toMatchObject({ lp: 20, rewardDiamonds: 15, costCents: 150 });
  });

  it('refuses to save a recipe denomination with no active provider product', async () => {
    await expect(saveLevelPassCheckpoints(db, [draft({ recipe: [999] })])).rejects.toThrow(/999/);
  });
});

describe('reviewLevelPassCheckpoints', () => {
  it('accepts a strictly ascending, positive-integer ladder with a delivering recipe', () => {
    const result = reviewLevelPassCheckpoints([
      draft({ lp: 60, rewardDiamonds: 110, costCents: 1_200, recipe: [100] }),
      draft({ lp: 260, rewardDiamonds: 340, costCents: 4_000, recipe: [310] }),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.checkpoints).not.toBeNull();
  });

  it('rejects an empty ladder', () => {
    const result = reviewLevelPassCheckpoints([]);
    expect(result.checkpoints).toBeNull();
    expect(result.issues).toHaveLength(1);
  });

  it('rejects LP thresholds that are not strictly increasing', () => {
    const result = reviewLevelPassCheckpoints([draft({ lp: 100 }), draft({ lp: 100 })]);
    expect(result.checkpoints).toBeNull();
    expect(result.issues.some((i) => i.message.includes('crecientes'))).toBe(true);
  });

  it('rejects a non-integer or non-positive reward/cost value', () => {
    const result = reviewLevelPassCheckpoints([draft({ rewardDiamonds: -5, costCents: 1.5 })]);
    expect(result.checkpoints).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('rejects an empty recipe', () => {
    const result = reviewLevelPassCheckpoints([draft({ recipe: [] })]);
    expect(result.checkpoints).toBeNull();
    expect(result.issues.some((i) => i.message.includes('receta'))).toBe(true);
  });

  it('rejects a recipe that under-delivers against the promised reward', () => {
    // 5 diamonds + 10% bonus = 5 (rounded down), nowhere near 500.
    const result = reviewLevelPassCheckpoints([draft({ rewardDiamonds: 500, recipe: [5] })]);
    expect(result.checkpoints).toBeNull();
    expect(result.issues.some((i) => i.message.includes('entrega'))).toBe(true);
  });
});
