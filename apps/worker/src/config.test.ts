/**
 * The one thing this file tests directly: `loadConfig` refuses a dry run
 * pointed at a non-local database before anything else about the config is
 * even considered. The rest of `loadConfig`'s env-var plumbing is exercised
 * end to end by the worker actually starting in CI and in every dry run this
 * repo's own scripts do locally.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  process.env = saved;
});

/** Just enough env for `loadConfig` to reach the check under test. */
function setBaseEnv(databaseUrl: string) {
  process.env.DATABASE_URL = databaseUrl;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_ALERT_CHAT_ID;
  delete process.env.DRY_RUN_ALLOW_REMOTE_DATABASE;
}

describe('loadConfig dry-run database guard', () => {
  it('refuses WORKER_DRY_RUN=true against the production compose hostname', () => {
    setBaseEnv('postgres://levelup:x@postgres:5432/levelup');
    process.env.WORKER_DRY_RUN = 'true';

    expect(() => loadConfig()).toThrow(/WORKER_DRY_RUN=true refuses/);
  });

  it('allows WORKER_DRY_RUN=true against a local database', () => {
    setBaseEnv('postgres://levelup@127.0.0.1:54329/levelup');
    process.env.WORKER_DRY_RUN = 'true';

    const config = loadConfig();
    expect(config.dryRun).toBe(true);
    expect(config.databaseUrl).toBe('postgres://levelup@127.0.0.1:54329/levelup');
  });

  it('never checks the database host when dry run is off', () => {
    setBaseEnv('postgres://levelup:x@postgres:5432/levelup');
    delete process.env.WORKER_DRY_RUN;
    process.env.RA_API_KEY = 'ra_test';
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    process.env.TELEGRAM_ALERT_CHAT_ID = 'chat-id';

    expect(() => loadConfig()).not.toThrow();
  });

  it('is lifted by DRY_RUN_ALLOW_REMOTE_DATABASE for a genuine disposable database', () => {
    setBaseEnv('postgres://u:p@staging.example.com:5432/levelup');
    process.env.WORKER_DRY_RUN = 'true';
    process.env.DRY_RUN_ALLOW_REMOTE_DATABASE = 'true';

    expect(() => loadConfig()).not.toThrow();
  });
});
