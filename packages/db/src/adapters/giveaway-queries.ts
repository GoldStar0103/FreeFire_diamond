/**
 * Public read models for the Golden Tickets giveaways storefront + account
 * page. Mirrors `item-catalog-queries.ts`'s shape and boundary — no admin
 * fields (`createdByAdminId`, `drawnByAdminId`) ever cross into these
 * shapes. Winner/leaderboard names use `displayName` the same way
 * `getPublicTop50` does for the seasonal ranking — never `playerId`, never
 * ticket-spend figures.
 */

import { and, desc, eq, gt, inArray, lt } from 'drizzle-orm';
import type { Database } from '../index.js';
import { giveawayEntries, giveaways, giveawayWinners, playerProfiles } from '../schema.js';
import type { GiveawayStatus } from './giveaway-admin-store.js';

export interface OpenGiveaway {
  id: string;
  title: string;
  description: string;
  prizeDescription: string;
  entryCostTickets: number;
  scheduleType: 'daily' | 'weekly' | 'monthly' | 'flash';
  closesAt: Date;
  maxParticipants: number | null;
  totalEntryCount: number;
  totalEntrants: number;
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
      maxParticipants: giveaways.maxParticipants,
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
    totalEntrants: counts[i]!.length,
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
      maxParticipants: giveaways.maxParticipants,
    })
    .from(giveaways)
    .where(and(eq(giveaways.id, id), eq(giveaways.status, 'open'), lt(giveaways.opensAt, now), gt(giveaways.closesAt, now)))
    .limit(1);

  if (!row) return null;

  const entryRows = await db
    .select({ entryCount: giveawayEntries.entryCount })
    .from(giveawayEntries)
    .where(eq(giveawayEntries.giveawayId, id));

  return {
    ...row,
    totalEntryCount: entryRows.reduce((sum, e) => sum + e.entryCount, 0),
    totalEntrants: entryRows.length,
  };
}

/** This player's current entry in one giveaway, or null if they haven't entered it. */
export async function getMyEntry(
  db: Database,
  giveawayId: string,
  playerProfileId: string,
): Promise<{ entryCount: number; ticketsSpent: number; freeFireId: string | null; freeFireNickname: string | null } | null> {
  const [row] = await db
    .select({
      entryCount: giveawayEntries.entryCount,
      ticketsSpent: giveawayEntries.ticketsSpent,
      freeFireId: giveawayEntries.freeFireId,
      freeFireNickname: giveawayEntries.freeFireNickname,
    })
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
      entryCount: giveawayEntries.entryCount,
      ticketsSpent: giveawayEntries.ticketsSpent,
      enteredAt: giveawayEntries.createdAt,
    })
    .from(giveawayEntries)
    .innerJoin(giveaways, eq(giveaways.id, giveawayEntries.giveawayId))
    .where(eq(giveawayEntries.playerProfileId, playerProfileId))
    .orderBy(desc(giveawayEntries.createdAt));

  if (rows.length === 0) return [];

  const won = await db
    .select({ giveawayId: giveawayWinners.giveawayId })
    .from(giveawayWinners)
    .where(
      and(eq(giveawayWinners.playerProfileId, playerProfileId), inArray(giveawayWinners.giveawayId, rows.map((r) => r.giveawayId))),
    );
  const wonGiveawayIds = new Set(won.map((w) => w.giveawayId));

  return rows.map((r) => ({
    giveawayId: r.giveawayId,
    title: r.title,
    prizeDescription: r.prizeDescription,
    status: r.status,
    entryCount: r.entryCount,
    ticketsSpent: r.ticketsSpent,
    isWinner: wonGiveawayIds.has(r.giveawayId),
    closesAt: r.closesAt,
    enteredAt: r.enteredAt,
  }));
}

// ── full transparency: works for any status, not just 'open' ───────────────

export interface PublicGiveaway {
  id: string;
  title: string;
  description: string;
  prizeDescription: string;
  entryCostTickets: number;
  scheduleType: 'daily' | 'weekly' | 'monthly' | 'flash';
  status: GiveawayStatus;
  opensAt: Date;
  closesAt: Date;
  maxEntriesPerPlayer: number | null;
  maxParticipants: number | null;
  totalEntryCount: number;
  totalEntrants: number;
  /** One per winner — a giveaway can draw several, per the client's request. Empty before it's drawn. */
  winnerDisplayNames: string[];
  drawnAt: Date | null;
  cancelReason: string | null;
}

function publicDisplayName(displayName: string | null, playerId: string): string {
  return displayName ?? `Jugador ${playerId}`;
}

/**
 * One giveaway for public display, at any point in its lifecycle — unlike
 * `getOpenGiveaway`, this doesn't 404 once a giveaway closes/draws/cancels,
 * so the result page stays viewable (entry progress, leaderboard, winner,
 * or cancellation reason) after it stops accepting entries. Drafts are
 * admin-only and never returned here.
 */
export async function getGiveawayPublic(db: Database, id: string): Promise<PublicGiveaway | null> {
  const [row] = await db
    .select({
      id: giveaways.id,
      title: giveaways.title,
      description: giveaways.description,
      prizeDescription: giveaways.prizeDescription,
      entryCostTickets: giveaways.entryCostTickets,
      scheduleType: giveaways.scheduleType,
      status: giveaways.status,
      opensAt: giveaways.opensAt,
      closesAt: giveaways.closesAt,
      maxEntriesPerPlayer: giveaways.maxEntriesPerPlayer,
      maxParticipants: giveaways.maxParticipants,
      drawnAt: giveaways.drawnAt,
      cancelReason: giveaways.cancelReason,
    })
    .from(giveaways)
    .where(eq(giveaways.id, id))
    .limit(1);
  if (!row || row.status === 'draft') return null;

  const entryRows = await db
    .select({ entryCount: giveawayEntries.entryCount })
    .from(giveawayEntries)
    .where(eq(giveawayEntries.giveawayId, id));

  const winners = await db
    .select({ displayName: playerProfiles.displayName, playerId: playerProfiles.playerId })
    .from(giveawayWinners)
    .innerJoin(playerProfiles, eq(playerProfiles.id, giveawayWinners.playerProfileId))
    .where(eq(giveawayWinners.giveawayId, id))
    .orderBy(giveawayWinners.position);

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    prizeDescription: row.prizeDescription,
    entryCostTickets: row.entryCostTickets,
    scheduleType: row.scheduleType,
    status: row.status,
    opensAt: row.opensAt,
    closesAt: row.closesAt,
    maxEntriesPerPlayer: row.maxEntriesPerPlayer,
    maxParticipants: row.maxParticipants,
    totalEntryCount: entryRows.reduce((sum, e) => sum + e.entryCount, 0),
    totalEntrants: entryRows.length,
    winnerDisplayNames: winners.map((w) => publicDisplayName(w.displayName, w.playerId)),
    drawnAt: row.drawnAt,
    cancelReason: row.cancelReason,
  };
}

export interface GiveawayLeaderboardRow {
  playerProfileId: string;
  displayName: string;
  entryCount: number;
}

/**
 * Who's currently ahead, by entry count — never ticket-spend figures, same
 * "no spend figures" boundary `getPublicTop50` draws for the seasonal
 * ranking (entry count is a chance-in-the-draw stat, not a spend amount).
 */
export async function listGiveawayLeaderboard(
  db: Database,
  giveawayId: string,
  limit = 10,
): Promise<GiveawayLeaderboardRow[]> {
  const rows = await db
    .select({
      playerProfileId: giveawayEntries.playerProfileId,
      displayName: playerProfiles.displayName,
      playerId: playerProfiles.playerId,
      entryCount: giveawayEntries.entryCount,
    })
    .from(giveawayEntries)
    .innerJoin(playerProfiles, eq(playerProfiles.id, giveawayEntries.playerProfileId))
    .where(eq(giveawayEntries.giveawayId, giveawayId))
    .orderBy(desc(giveawayEntries.entryCount))
    .limit(limit);

  return rows.map((r) => ({
    playerProfileId: r.playerProfileId,
    displayName: publicDisplayName(r.displayName, r.playerId),
    entryCount: r.entryCount,
  }));
}

export interface CompletedGiveaway {
  id: string;
  title: string;
  prizeDescription: string;
  status: 'drawn' | 'delivered' | 'cancelled';
  /** One per winner — empty for a cancelled giveaway. */
  winnerDisplayNames: string[];
  totalEntryCount: number;
  closesAt: Date;
}

/** The last N finished giveaways (drawn, delivered, or cancelled), newest-closed first — the public history list. */
export async function listRecentCompletedGiveaways(db: Database, limit = 10): Promise<CompletedGiveaway[]> {
  const rows = await db
    .select({
      id: giveaways.id,
      title: giveaways.title,
      prizeDescription: giveaways.prizeDescription,
      status: giveaways.status,
      closesAt: giveaways.closesAt,
    })
    .from(giveaways)
    .where(inArray(giveaways.status, ['drawn', 'delivered', 'cancelled']))
    .orderBy(desc(giveaways.closesAt))
    .limit(limit);

  if (rows.length === 0) return [];

  const winnerRows = await db
    .select({
      giveawayId: giveawayWinners.giveawayId,
      displayName: playerProfiles.displayName,
      playerId: playerProfiles.playerId,
      position: giveawayWinners.position,
    })
    .from(giveawayWinners)
    .innerJoin(playerProfiles, eq(playerProfiles.id, giveawayWinners.playerProfileId))
    .where(inArray(giveawayWinners.giveawayId, rows.map((r) => r.id)))
    .orderBy(giveawayWinners.position);

  const winnerNamesByGiveaway = new Map<string, string[]>();
  for (const w of winnerRows) {
    const list = winnerNamesByGiveaway.get(w.giveawayId) ?? [];
    list.push(publicDisplayName(w.displayName, w.playerId));
    winnerNamesByGiveaway.set(w.giveawayId, list);
  }

  const counts = await Promise.all(
    rows.map((r) =>
      db
        .select({ entryCount: giveawayEntries.entryCount })
        .from(giveawayEntries)
        .where(eq(giveawayEntries.giveawayId, r.id)),
    ),
  );

  return rows.map((r, i) => ({
    id: r.id,
    title: r.title,
    prizeDescription: r.prizeDescription,
    status: r.status as 'drawn' | 'delivered' | 'cancelled',
    winnerDisplayNames: winnerNamesByGiveaway.get(r.id) ?? [],
    totalEntryCount: counts[i]!.reduce((sum, e) => sum + e.entryCount, 0),
    closesAt: r.closesAt,
  }));
}
