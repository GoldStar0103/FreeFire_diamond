/** Level Pass checkpoint settings against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import {
  DEFAULT_LEVEL_PASS_CHECKPOINTS,
  getLevelPassCheckpoints,
  reviewLevelPassCheckpoints,
  saveLevelPassCheckpoints,
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

beforeEach(async () => {
  if (!PG_AVAILABLE) return;
  await db.execute(raw`TRUNCATE settings`);
});

describe('getLevelPassCheckpoints', () => {
  it('returns the default ladder when nothing has been saved', async () => {
    expect(await getLevelPassCheckpoints(db)).toEqual(DEFAULT_LEVEL_PASS_CHECKPOINTS);
  });

  it('returns a saved ladder, and saving again overwrites it', async () => {
    await saveLevelPassCheckpoints(db, [{ lp: 10, rewardDiamonds: 5, costCents: 50 }]);
    expect(await getLevelPassCheckpoints(db)).toEqual([{ lp: 10, rewardDiamonds: 5, costCents: 50 }]);

    await saveLevelPassCheckpoints(db, [{ lp: 20, rewardDiamonds: 15, costCents: 150 }]);
    expect(await getLevelPassCheckpoints(db)).toEqual([{ lp: 20, rewardDiamonds: 15, costCents: 150 }]);
  });
});

describe('reviewLevelPassCheckpoints', () => {
  it('accepts a strictly ascending, positive-integer ladder', () => {
    const result = reviewLevelPassCheckpoints(DEFAULT_LEVEL_PASS_CHECKPOINTS);
    expect(result.checkpoints).toEqual(DEFAULT_LEVEL_PASS_CHECKPOINTS);
    expect(result.issues).toEqual([]);
  });

  it('rejects an empty ladder', () => {
    const result = reviewLevelPassCheckpoints([]);
    expect(result.checkpoints).toBeNull();
    expect(result.issues).toHaveLength(1);
  });

  it('rejects LP thresholds that are not strictly increasing', () => {
    const result = reviewLevelPassCheckpoints([
      { lp: 100, rewardDiamonds: 10, costCents: 100 },
      { lp: 100, rewardDiamonds: 20, costCents: 200 },
    ]);
    expect(result.checkpoints).toBeNull();
    expect(result.issues.some((i) => i.message.includes('crecientes'))).toBe(true);
  });

  it('rejects a non-integer or non-positive reward/cost value', () => {
    const result = reviewLevelPassCheckpoints([{ lp: 100, rewardDiamonds: -5, costCents: 1.5 }]);
    expect(result.checkpoints).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });
});
