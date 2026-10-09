/**
 * Manual entries in the financial ledger — the "other expenses" line the
 * spec's real-net-profit formula needs, plus the income counterpart.
 *
 * These are the only ledger rows a human writes directly. Everything else
 * (reward cost, refunds) is posted by the system as a side effect of
 * something that happened, which is why only this file needs a delete: a
 * mistyped rent figure has no other way to be taken back.
 */

import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type { Database } from '../index.js';
import { adminUsers, auditLog, financialLedgerEntries, seasons } from '../schema.js';
import type { DateRange } from './mexico-city-time.js';

export type ManualEntryKind = 'expense' | 'income';

export interface AddManualEntryInput {
  kind: ManualEntryKind;
  /** Always positive; the sign is applied here from `kind`. */
  amountCents: number;
  /** The day it belongs to, which is not necessarily today. */
  occurredAt: Date;
  note: string;
  adminUserId: string;
}

export type AddManualEntryResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'invalid_amount' | 'note_required' };

const MAX_ENTRY_CENTS = 100_000_000; // $1,000,000 MXN — a typo guard, not a policy

export async function addManualLedgerEntry(
  db: Database,
  input: AddManualEntryInput,
): Promise<AddManualEntryResult> {
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > MAX_ENTRY_CENTS
  ) {
    return { ok: false, reason: 'invalid_amount' };
  }
  const note = input.note.trim();
  if (note.length < 3) return { ok: false, reason: 'note_required' };

  return db.transaction(async (tx) => {
    // Tagged with the season it falls in, so a season's cumulative figures
    // can include the expenses that belong to it.
    const [season] = await tx
      .select({ id: seasons.id })
      .from(seasons)
      .where(and(lt(seasons.startsAt, input.occurredAt), gte(seasons.endsAt, input.occurredAt)))
      .orderBy(desc(seasons.seasonNumber))
      .limit(1);

    const [row] = await tx
      .insert(financialLedgerEntries)
      .values({
        entryType: input.kind === 'expense' ? 'manual_expense' : 'manual_income',
        // The ledger's convention: expenses negative, income positive.
        amountCents: input.kind === 'expense' ? -input.amountCents : input.amountCents,
        occurredAt: input.occurredAt,
        seasonId: season?.id ?? null,
        sourceType: 'manual',
        note,
        createdByAdminId: input.adminUserId,
      })
      .returning({ id: financialLedgerEntries.id });

    await tx.insert(auditLog).values({
      adminUserId: input.adminUserId,
      action: `ledger.${input.kind}.create`,
      entityType: 'financial_ledger_entry',
      entityId: row!.id,
      detail: { amountCents: input.amountCents, occurredAt: input.occurredAt.toISOString(), note },
    });

    return { ok: true, id: row!.id } as const;
  });
}

export interface ManualLedgerEntry {
  id: string;
  kind: ManualEntryKind;
  /** Positive, however it is stored. */
  amountCents: number;
  occurredAt: Date;
  note: string | null;
  createdByEmail: string | null;
}

/** The manual entries inside a reporting range, newest first. */
export async function listManualLedgerEntries(
  db: Database,
  range: DateRange,
): Promise<ManualLedgerEntry[]> {
  const rows = await db
    .select({
      id: financialLedgerEntries.id,
      entryType: financialLedgerEntries.entryType,
      amountCents: financialLedgerEntries.amountCents,
      occurredAt: financialLedgerEntries.occurredAt,
      note: financialLedgerEntries.note,
      createdByEmail: adminUsers.email,
    })
    .from(financialLedgerEntries)
    .leftJoin(adminUsers, eq(adminUsers.id, financialLedgerEntries.createdByAdminId))
    .where(
      and(
        gte(financialLedgerEntries.occurredAt, range.start),
        lt(financialLedgerEntries.occurredAt, range.end),
      ),
    )
    .orderBy(desc(financialLedgerEntries.occurredAt));

  return rows
    .filter((row) => row.entryType === 'manual_expense' || row.entryType === 'manual_income')
    .map((row) => ({
      id: row.id,
      kind: row.entryType === 'manual_expense' ? 'expense' : 'income',
      amountCents: Math.abs(row.amountCents),
      occurredAt: row.occurredAt,
      note: row.note,
      createdByEmail: row.createdByEmail,
    }));
}

/**
 * Only a manual row can be deleted. A reward expense or a refund is the
 * record of something that really happened, and removing it would make the
 * accounts disagree with the orders behind them.
 */
export async function deleteManualLedgerEntry(
  db: Database,
  id: string,
  adminUserId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ entryType: financialLedgerEntries.entryType })
      .from(financialLedgerEntries)
      .where(eq(financialLedgerEntries.id, id))
      .limit(1);
    if (!row || (row.entryType !== 'manual_expense' && row.entryType !== 'manual_income')) {
      return false;
    }

    await tx.delete(financialLedgerEntries).where(eq(financialLedgerEntries.id, id));
    await tx.insert(auditLog).values({
      adminUserId,
      action: 'ledger.manual.delete',
      entityType: 'financial_ledger_entry',
      entityId: id,
    });
    return true;
  });
}
