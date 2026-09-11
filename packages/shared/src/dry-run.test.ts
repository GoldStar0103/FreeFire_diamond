import { afterEach, describe, expect, it } from 'vitest';
import { assertDryRunDatabaseIsSafe, DEFAULT_DRY_RUN_OVERRIDE_VAR } from './dry-run.js';

const FLAG = { flagName: 'WORKER_DRY_RUN' };

afterEach(() => {
  delete process.env[DEFAULT_DRY_RUN_OVERRIDE_VAR];
  delete process.env.CUSTOM_OVERRIDE;
});

describe('assertDryRunDatabaseIsSafe', () => {
  it('does nothing when dry run is off, whatever the database', () => {
    expect(() =>
      assertDryRunDatabaseIsSafe('postgres://levelup:x@postgres:5432/levelup', false, FLAG),
    ).not.toThrow();
  });

  it.each([
    'postgres://levelup@localhost:54329/levelup',
    'postgres://levelup@127.0.0.1:54329/levelup',
    'postgres://levelup@[::1]:54329/levelup',
  ])('allows dry run against a local database: %s', (url) => {
    expect(() => assertDryRunDatabaseIsSafe(url, true, FLAG)).not.toThrow();
  });

  it('refuses dry run against the production compose hostname', () => {
    // What .env.example documents: "DATABASE_URL — must match the Postgres
    // vars, host is `postgres`". Exactly the value a stale or copy-pasted
    // .env would carry into a dry run started by mistake.
    expect(() =>
      assertDryRunDatabaseIsSafe('postgres://levelup:x@postgres:5432/levelup', true, FLAG),
    ).toThrow(/WORKER_DRY_RUN=true refuses/);
  });

  it('refuses dry run against a managed/remote host', () => {
    expect(() =>
      assertDryRunDatabaseIsSafe('postgres://u:p@db.example.com:5432/levelup', true, FLAG),
    ).toThrow(/"db\.example\.com"/);
  });

  it('names the offending flag in the error, not a hardcoded one', () => {
    expect(() =>
      assertDryRunDatabaseIsSafe('postgres://u:p@postgres:5432/levelup', true, {
        flagName: 'ADMIN_DRY_RUN',
      }),
    ).toThrow(/ADMIN_DRY_RUN=true refuses/);
  });

  it('is lifted by the override variable', () => {
    process.env[DEFAULT_DRY_RUN_OVERRIDE_VAR] = 'true';
    expect(() =>
      assertDryRunDatabaseIsSafe('postgres://u:p@staging.example.com:5432/levelup', true, FLAG),
    ).not.toThrow();
  });

  it('supports a caller-specific override variable name', () => {
    process.env.CUSTOM_OVERRIDE = 'true';
    expect(() =>
      assertDryRunDatabaseIsSafe('postgres://u:p@staging.example.com:5432/levelup', true, {
        ...FLAG,
        overrideVarName: 'CUSTOM_OVERRIDE',
      }),
    ).not.toThrow();
  });

  it('does not accept the override variable set to anything other than exactly "true"', () => {
    process.env[DEFAULT_DRY_RUN_OVERRIDE_VAR] = '1';
    expect(() =>
      assertDryRunDatabaseIsSafe('postgres://u:p@postgres:5432/levelup', true, FLAG),
    ).toThrow();
  });

  it('lets a malformed URL through — the real connection attempt will report it', () => {
    expect(() => assertDryRunDatabaseIsSafe('not-a-url', true, FLAG)).not.toThrow();
  });
});
