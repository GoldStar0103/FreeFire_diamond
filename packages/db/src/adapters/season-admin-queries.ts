/**
 * Admin-facing season queries: starting the very first season (nothing in the
 * Level Pass/ranking system activates until one exists — `closeDueSeasons`
 * only ever CLOSES a due season, it never creates the first one), and season
 * history for the panel.
 */

import { desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../index.js';
import { auditLog, hallOfFameEntries, seasons } from '../schema.js';

export interface SeasonOverview {
  id: string;
  seasonNumber: number;
  startsAt: Date;
  endsAt: Date;
  status: 'active' | 'closed';
}

export async function getCurrentSeason(db: Database): Promise<SeasonOverview | null> {
  const [row] = await db
    .select({ id: seasons.id, seasonNumber: seasons.seasonNumber, startsAt: seasons.startsAt, endsAt: seasons.endsAt, status: seasons.status })
    .from(seasons)
    .where(eq(seasons.status, 'active'))
    .orderBy(desc(seasons.seasonNumber))
    .limit(1);
  return row ?? null;
}

/**
 * The two most recent seasons as date ranges, for the Contabilidad
 * "Temporada actual / anterior" filters.
 *
 * "Current" is the most recent season by number, which is the active one
 * whenever a season is open; after a season closes and before the next
 * starts, it is that just-closed season, which is what an admin looking at
 * "this season's numbers" the morning after a close expects to see. Either
 * side is null when that season does not exist yet.
 *
 * The end is clamped to now so an in-progress season does not report a range
 * stretching weeks into the future — harmless for summing past rows, but it
 * would make the on-screen date range read as if the period had already
 * finished.
 */
export async function getSeasonRanges(
  db: Database,
  now: Date = new Date(),
): Promise<{ current: SeasonDateRange | null; previous: SeasonDateRange | null }> {
  const rows = await db
    .select({ seasonNumber: seasons.seasonNumber, startsAt: seasons.startsAt, endsAt: seasons.endsAt })
    .from(seasons)
    .orderBy(desc(seasons.seasonNumber))
    .limit(2);

  const toRange = (row: (typeof rows)[number] | undefined): SeasonDateRange | null =>
    row
      ? {
          seasonNumber: row.seasonNumber,
          start: row.startsAt,
          end: row.endsAt.getTime() > now.getTime() ? now : row.endsAt,
        }
      : null;

  return { current: toRange(rows[0]), previous: toRange(rows[1]) };
}

export interface SeasonDateRange {
  seasonNumber: number;
  start: Date;
  /** Exclusive, clamped to now for a season still running. */
  end: Date;
}

export async function hasAnySeason(db: Database): Promise<boolean> {
  const [row] = await db.select({ id: seasons.id }).from(seasons).limit(1);
  return row !== undefined;
}

export type StartFirstSeasonResult =
  | { ok: true; season: SeasonOverview }
  | { ok: false; reason: 'already_exists' };

/**
 * Creates season #1. Guarded on "no season row exists at all", not just "no
 * active one" — once the system has ever had a season, every later one comes
 * from `closeDueSeasons`'s own rollover, and this action should not be a way
 * to fork a second season number 1 or jump the sequence.
 */
export async function startFirstSeason(
  db: Database,
  input: { lengthDays: number; adminUserId: string; now?: Date },
): Promise<StartFirstSeasonResult> {
  if (await hasAnySeason(db)) return { ok: false, reason: 'already_exists' };

  const now = input.now ?? new Date();
  const endsAt = new Date(now.getTime() + input.lengthDays * 86_400_000);

  return db.transaction(async (tx) => {
    const [season] = await tx
      .insert(seasons)
      .values({ seasonNumber: 1, startsAt: now, endsAt, status: 'active' })
      .returning();
    await tx.insert(auditLog).values({
      adminUserId: input.adminUserId,
      action: 'season.start_first',
      entityType: 'season',
      entityId: season!.id,
      detail: { seasonNumber: 1, startsAt: now.toISOString(), endsAt: endsAt.toISOString(), lengthDays: input.lengthDays },
    });
    return { ok: true, season: season! };
  });
}

export interface SeasonHistoryEntry {
  id: string;
  seasonNumber: number;
  startsAt: Date;
  endsAt: Date;
  closedAt: Date | null;
  podium: Array<{
    position: number;
    playerProfileId: string;
    displayName: string | null;
    avatarAssetUrlSnapshot: string | null;
    seasonalDiamonds: number;
  }>;
}

export async function listSeasonHistory(db: Database, limit = 20): Promise<SeasonHistoryEntry[]> {
  const closedSeasons = await db
    .select({ id: seasons.id, seasonNumber: seasons.seasonNumber, startsAt: seasons.startsAt, endsAt: seasons.endsAt, closedAt: seasons.closedAt })
    .from(seasons)
    .where(eq(seasons.status, 'closed'))
    .orderBy(desc(seasons.seasonNumber))
    .limit(limit);

  if (closedSeasons.length === 0) return [];

  const podiumRows = await db
    .select({
      seasonId: hallOfFameEntries.seasonId,
      position: hallOfFameEntries.position,
      playerProfileId: hallOfFameEntries.playerProfileId,
      displayName: hallOfFameEntries.displayNameSnapshot,
      avatarAssetUrlSnapshot: hallOfFameEntries.avatarAssetUrlSnapshot,
      seasonalDiamonds: hallOfFameEntries.seasonalDiamonds,
    })
    .from(hallOfFameEntries)
    .where(inArray(hallOfFameEntries.seasonId, closedSeasons.map((s) => s.id)))
    .orderBy(hallOfFameEntries.position);

  return closedSeasons.map((season) => ({
    ...season,
    podium: podiumRows
      .filter((p) => p.seasonId === season.id)
      .map((p) => ({
        position: p.position,
        playerProfileId: p.playerProfileId,
        displayName: p.displayName,
        avatarAssetUrlSnapshot: p.avatarAssetUrlSnapshot,
        seasonalDiamonds: p.seasonalDiamonds,
      })),
  }));
}
