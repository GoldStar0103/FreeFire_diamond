/**
 * Public read models for the Golden Tickets giveaways storefront + account
 * page. Mirrors `item-catalog-queries.ts`'s shape and boundary — no admin
 * fields (`createdByAdminId`, `drawnByAdminId`, `cancelReason`) ever cross
 * into these shapes.
 */

import { and, desc, eq, gt, lt } from 'drizzle-orm';
import type { Database } from '../index.js';
import { giveawayEntries, giveaways } from '../schema.js';

export interface OpenGiveaway {
  id: string;
  title: string;
  description: string;
  prizeDescription: string;
  entryCostTickets: number;
  scheduleType: 'daily' | 'weekly' | 'monthly' | 'flash';
  closesAt: Date;
  totalEntryCount: number;
}

export interface MyGiveawayEntry {
  giveawayId: string;
  title: string;
  prizeDescription: string;
  status: 'draft' | 'open' | 'closed_pending_draw' | 'drawn' | 'delivered' | 'cancelled';
  entryCount: number;
  ticketsSpent: number;
  isWinner: boolean;
  closesAt: Date;
  enteredAt: Date;
}

/** Everything open for entry right now — `status = 'open'` and within its entry window. */
export async function listOpenGiveaways(db: Database, now: Date = new Date()): Promise<OpenGiveaway[]> {
  const rows = await db
    .select({
      id: giveaways.id,
      title: giveaways.title,
      description: giveaways.description,
      prizeDescription: giveaways.prizeDescription,
      entryCostTickets: giveaways.entryCostTickets,
      scheduleType: giveaways.scheduleType,
      closesAt: giveaways.closesAt,
    })
    .from(giveaways)
    .where(and(eq(giveaways.status, 'open'), lt(giveaways.opensAt, now), gt(giveaways.closesAt, now)))
    .orderBy(giveaways.closesAt);

  if (rows.length === 0) return [];

  const counts = await Promise.all(
    rows.map((r) =>
      db
        .select({ entryCount: giveawayEntries.entryCount })
        .from(giveawayEntries)
        .where(eq(giveawayEntries.giveawayId, r.id)),
    ),
  );

  return rows.map((r, i) => ({
    ...r,
    totalEntryCount: counts[i]!.reduce((sum, e) => sum + e.entryCount, 0),
  }));
}

/** One giveaway, for its entry page. Null when it is not currently open for entry. */
export async function getOpenGiveaway(db: Database, id: string, now: Date = new Date()): Promise<OpenGiveaway | null> {
  const [row] = await db
    .select({
      id: giveaways.id,
      title: giveaways.title,
      description: giveaways.description,
      prizeDescription: giveaways.prizeDescription,
      entryCostTickets: giveaways.entryCostTickets,
      scheduleType: giveaways.scheduleType,
      closesAt: giveaways.closesAt,
    })
    .from(giveaways)
    .where(and(eq(giveaways.id, id), eq(giveaways.status, 'open'), lt(giveaways.opensAt, now), gt(giveaways.closesAt, now)))
    .limit(1);

  if (!row) return null;

  const entryRows = await db
    .select({ entryCount: giveawayEntries.entryCount })
    .from(giveawayEntries)
    .where(eq(giveawayEntries.giveawayId, id));

  return { ...row, totalEntryCount: entryRows.reduce((sum, e) => sum + e.entryCount, 0) };
}

/** This player's current entry in one giveaway, or null if they haven't entered it. */
export async function getMyEntry(
  db: Database,
  giveawayId: string,
  playerProfileId: string,
): Promise<{ entryCount: number; ticketsSpent: number } | null> {
  const [row] = await db
    .select({ entryCount: giveawayEntries.entryCount, ticketsSpent: giveawayEntries.ticketsSpent })
    .from(giveawayEntries)
    .where(and(eq(giveawayEntries.giveawayId, giveawayId), eq(giveawayEntries.playerProfileId, playerProfileId)))
    .limit(1);
  return row ?? null;
}

/** Every giveaway this player has entered, newest first — open, drawn, delivered, or cancelled. */
export async function listMyGiveawayEntries(db: Database, playerProfileId: string): Promise<MyGiveawayEntry[]> {
  const rows = await db
    .select({
      giveawayId: giveaways.id,
      title: giveaways.title,
      prizeDescription: giveaways.prizeDescription,
      status: giveaways.status,
      closesAt: giveaways.closesAt,
      winnerPlayerProfileId: giveaways.winnerPlayerProfileId,
      entryCount: giveawayEntries.entryCount,
      ticketsSpent: giveawayEntries.ticketsSpent,
      enteredAt: giveawayEntries.createdAt,
    })
    .from(giveawayEntries)
    .innerJoin(giveaways, eq(giveaways.id, giveawayEntries.giveawayId))
    .where(eq(giveawayEntries.playerProfileId, playerProfileId))
    .orderBy(desc(giveawayEntries.createdAt));

  return rows.map((r) => ({
    giveawayId: r.giveawayId,
    title: r.title,
    prizeDescription: r.prizeDescription,
    status: r.status,
    entryCount: r.entryCount,
    ticketsSpent: r.ticketsSpent,
    isWinner: r.winnerPlayerProfileId === playerProfileId,
    closesAt: r.closesAt,
    enteredAt: r.enteredAt,
  }));
}
