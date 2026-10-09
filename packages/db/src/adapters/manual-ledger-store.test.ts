/** Manual ledger entries against real Postgres. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { sql as raw } from 'drizzle-orm';
import { createDb, type Database } from '../index.js';
import { adminUsers, auditLog, financialLedgerEntries, seasons } from '../schema.js';
import {
  addManualLedgerEntry,
  deleteManualLedgerEntry,
  listManualLedgerEntries,
} from './manual-ledger-store.js';
import { getAccountingSummary } from './accounting-queries.js';
import { mexicoCityDayRange } from './mexico-city-time.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'migrations');
const BASE_URL = process.env.TEST_PG_URL ?? 'postgres://levelup@127.0.0.1:54329';
const TEST_DB = 'levelup_manual_ledger_test';

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
let adminId: string;

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
    raw`TRUNCATE financial_ledger_entries, seasons, audit_log, admin_users RESTART IDENTITY CASCADE`,
  );
  const [admin] = await db
    .insert(adminUsers)
    .values({ email: `admin-${Math.random()}@test.com`, passwordHash: 'x' })
    .returning();
  adminId = admin!.id;
});

const DAY = new Date('2026-02-10T18:00:00Z');

describe.skipIf(!PG_AVAILABLE)('addManualLedgerEntry', () => {
  it('refuses a zero, negative, fractional or absurd amount', async () => {
    for (const amountCents of [0, -100, 10.5, 100_000_001]) {
      expect(
        await addManualLedgerEntry(db, {
          kind: 'expense',
          amountCents,
          occurredAt: DAY,
          note: 'Renta',
          adminUserId: adminId,
        }),
      ).toEqual({ ok: false, reason: 'invalid_amount' });
    }
  });

  it('requires a note — an unexplained figure is useless a month later', async () => {
    expect(
      await addManualLedgerEntry(db, {
        kind: 'expense',
        amountCents: 5_000,
        occurredAt: DAY,
        note: ' ',
        adminUserId: adminId,
      }),
    ).toEqual({ ok: false, reason: 'note_required' });
  });

  it('stores an expense as negative and income as positive', async () => {
    await addManualLedgerEntry(db, { kind: 'expense', amountCents: 5_000, occurredAt: DAY, note: 'Renta', adminUserId: adminId });
    await addManualLedgerEntry(db, { kind: 'income', amountCents: 2_000, occurredAt: DAY, note: 'Venta de equipo', adminUserId: adminId });

    const rows = await db.select().from(financialLedgerEntries);
    const expense = rows.find((r) => r.entryType === 'manual_expense');
    const income = rows.find((r) => r.entryType === 'manual_income');
    expect(expense?.amountCents).toBe(-5_000);
    expect(income?.amountCents).toBe(2_000);
  });

  it('tags the entry with the season its date falls in', async () => {
    const [season] = await db
      .insert(seasons)
      .values({ seasonNumber: 1, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-03-01'), status: 'active' })
      .returning();

    await addManualLedgerEntry(db, { kind: 'expense', amountCents: 5_000, occurredAt: DAY, note: 'Renta', adminUserId: adminId });

    const [row] = await db.select().from(financialLedgerEntries);
    expect(row?.seasonId).toBe(season!.id);
  });

  it('leaves the season null when the date falls outside every season', async () => {
    await db
      .insert(seasons)
      .values({ seasonNumber: 1, startsAt: new Date('2025-01-01'), endsAt: new Date('2025-03-01'), status: 'closed' });

    await addManualLedgerEntry(db, { kind: 'expense', amountCents: 5_000, occurredAt: DAY, note: 'Renta', adminUserId: adminId });

    const [row] = await db.select().from(financialLedgerEntries);
    expect(row?.seasonId).toBeNull();
  });

  it('reaches real net profit through the accounting summary', async () => {
    await addManualLedgerEntry(db, { kind: 'expense', amountCents: 5_000, occurredAt: DAY, note: 'Renta', adminUserId: adminId });
    await addManualLedgerEntry(db, { kind: 'income', amountCents: 1_500, occurredAt: DAY, note: 'Reembolso proveedor', adminUserId: adminId });

    const summary = await getAccountingSummary(db, mexicoCityDayRange(DAY));

    expect(summary.otherExpensesCents).toBe(5_000);
    expect(summary.manualIncomeCents).toBe(1_500);
    // No sales at all, so real net profit is exactly the manual lines.
    expect(summary.realNetProfitCents).toBe(-5_000 + 1_500);
  });

  it('records who added it', async () => {
    await addManualLedgerEntry(db, { kind: 'expense', amountCents: 5_000, occurredAt: DAY, note: 'Renta', adminUserId: adminId });

    const [entry] = await db.select().from(auditLog);
    expect(entry).toMatchObject({ adminUserId: adminId, action: 'ledger.expense.create' });
  });
});

describe.skipIf(!PG_AVAILABLE)('listManualLedgerEntries', () => {
  it('returns only manual rows in the range, newest first', async () => {
    await addManualLedgerEntry(db, { kind: 'expense', amountCents: 1_000, occurredAt: new Date('2026-02-10T10:00:00Z'), note: 'Uno', adminUserId: adminId });
    await addManualLedgerEntry(db, { kind: 'expense', amountCents: 2_000, occurredAt: new Date('2026-02-10T20:00:00Z'), note: 'Dos', adminUserId: adminId });
    // A system-posted row, which must not appear in a list offering deletion.
    await db.insert(financialLedgerEntries).values({
      entryType: 'level_pass_reward',
      amountCents: -1_200,
      occurredAt: DAY,
    });

    const rows = await listManualLedgerEntries(db, mexicoCityDayRange(DAY));

    expect(rows.map((r) => r.note)).toEqual(['Dos', 'Uno']);
    // Reported positive whatever the stored sign.
    expect(rows.every((r) => r.amountCents > 0)).toBe(true);
    expect(rows[0]?.createdByEmail).toContain('@test.com');
  });

  it('excludes entries outside the range', async () => {
    await addManualLedgerEntry(db, { kind: 'expense', amountCents: 1_000, occurredAt: new Date('2026-02-09T10:00:00Z'), note: 'Ayer', adminUserId: adminId });

    expect(await listManualLedgerEntries(db, mexicoCityDayRange(DAY))).toEqual([]);
  });
});

describe.skipIf(!PG_AVAILABLE)('deleteManualLedgerEntry', () => {
  it('deletes a manual entry and records it', async () => {
    const added = await addManualLedgerEntry(db, { kind: 'expense', amountCents: 5_000, occurredAt: DAY, note: 'Error', adminUserId: adminId });
    if (!added.ok) throw new Error('seed failed');

    expect(await deleteManualLedgerEntry(db, added.id, adminId)).toBe(true);
    expect(await db.select().from(financialLedgerEntries)).toHaveLength(0);
    expect((await db.select().from(auditLog)).some((e) => e.action === 'ledger.manual.delete')).toBe(true);
  });

  it('refuses to delete a system-posted row', async () => {
    const [row] = await db
      .insert(financialLedgerEntries)
      .values({ entryType: 'level_pass_reward', amountCents: -1_200, occurredAt: DAY })
      .returning({ id: financialLedgerEntries.id });

    expect(await deleteManualLedgerEntry(db, row!.id, adminId)).toBe(false);
    expect(await db.select().from(financialLedgerEntries)).toHaveLength(1);
  });

  it('is a no-op for an id that does not exist', async () => {
    expect(
      await deleteManualLedgerEntry(db, '00000000-0000-0000-0000-000000000000', adminId),
    ).toBe(false);
  });
});
