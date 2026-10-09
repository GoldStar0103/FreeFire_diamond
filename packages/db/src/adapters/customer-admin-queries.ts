/**
 * The internal customer view: a player's season economics and progression as
 * the admin sees them, including the figures the customer must never see.
 *
 * Deliberately a separate module from `customer-profile-store.ts`, which
 * serves the player's own screens and the public profile. Keeping the
 * admin-only numbers — profit generated, reward cost, retained profit — in a
 * file nothing customer-facing imports makes "never expose LevelUp's margins"
 * a structural property rather than a review check on every new page.
 */

import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import {
  badgeOwnerships,
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  orders,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
} from '../schema.js';

export interface AdminCustomerRow {
  playerProfileId: string;
  displayName: string | null;
  /** The linked Free Fire ID — what the season ranking counts. */
  playerId: string;
  email: string;
  lp: number;
  seasonalDiamonds: number;
  rank: number | null;
  vaultActive: boolean;
  lifetimeDiamondsPurchased: number;
  lifetimeRechargeCount: number;
}

export interface ListAdminCustomersInput {
  /** Matches display name, linked Free Fire ID or email. */
  search?: string;
  /** Defaults to the most recent season. */
  seasonId?: string;
  /** Drill-down: only players who reached this checkpoint in the season. */
  checkpointLp?: number;
  limit?: number;
}

async function resolveSeasonId(db: Database, seasonId?: string): Promise<string | null> {
  if (seasonId) return seasonId;
  const [row] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .orderBy(desc(seasons.seasonNumber))
    .limit(1);
  return row?.id ?? null;
}

/**
 * One ranked page of customers. Ordered by seasonal diamonds so the list
 * opens on the players who matter most commercially, which is also the order
 * the ranking itself uses.
 */
export async function listAdminCustomers(
  db: Database,
  input: ListAdminCustomersInput = {},
): Promise<AdminCustomerRow[]> {
  const seasonId = await resolveSeasonId(db, input.seasonId);
  const limit = input.limit ?? 100;
  const search = input.search?.trim();

  const filters = [];
  if (search) {
    const like = `%${search}%`;
    filters.push(
      or(
        ilike(playerProfiles.displayName, like),
        ilike(playerProfiles.playerId, like),
        ilike(playerProfiles.email, like),
      )!,
    );
  }
  if (seasonId && input.checkpointLp !== undefined) {
    const reached = db
      .select({ id: levelPassCheckpointEvents.playerProfileId })
      .from(levelPassCheckpointEvents)
      .where(
        and(
          eq(levelPassCheckpointEvents.seasonId, seasonId),
          eq(levelPassCheckpointEvents.checkpointLp, input.checkpointLp),
        ),
      );
    filters.push(inArray(playerProfiles.id, reached));
  }

  const rows = await db
    .select({
      playerProfileId: playerProfiles.id,
      displayName: playerProfiles.displayName,
      playerId: playerProfiles.playerId,
      email: playerProfiles.email,
      lifetimeDiamondsPurchased: playerProfiles.lifetimeDiamondsPurchased,
      lifetimeRechargeCount: playerProfiles.lifetimeRechargeCount,
      lp: seasonPlayerStats.lp,
      seasonalDiamonds: seasonPlayerStats.seasonalDiamonds,
      vaultStatus: vaultEntitlements.status,
    })
    .from(playerProfiles)
    .leftJoin(
      seasonPlayerStats,
      seasonId
        ? and(
            eq(seasonPlayerStats.playerProfileId, playerProfiles.id),
            eq(seasonPlayerStats.seasonId, seasonId),
          )
        : sql`false`,
    )
    .leftJoin(
      vaultEntitlements,
      seasonId
        ? and(
            eq(vaultEntitlements.playerProfileId, playerProfiles.id),
            eq(vaultEntitlements.seasonId, seasonId),
            eq(vaultEntitlements.status, 'active'),
          )
        : sql`false`,
    )
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(sql`COALESCE(${seasonPlayerStats.seasonalDiamonds}, 0)`), playerProfiles.createdAt)
    .limit(limit);

  const ranks = seasonId ? await rankMap(db, seasonId) : new Map<string, number>();

  return rows.map((row) => ({
    playerProfileId: row.playerProfileId,
    displayName: row.displayName,
    playerId: row.playerId,
    email: row.email,
    lp: row.lp ?? 0,
    seasonalDiamonds: row.seasonalDiamonds ?? 0,
    rank: ranks.get(row.playerProfileId) ?? null,
    vaultActive: row.vaultStatus === 'active',
    lifetimeDiamondsPurchased: row.lifetimeDiamondsPurchased,
    lifetimeRechargeCount: row.lifetimeRechargeCount,
  }));
}

/** Ranking position for everyone in the season, in one pass. */
async function rankMap(db: Database, seasonId: string): Promise<Map<string, number>> {
  const rows = await db.execute<{ player_profile_id: string; rank: string }>(sql`
    SELECT player_profile_id, RANK() OVER (ORDER BY seasonal_diamonds DESC) AS rank
    FROM season_player_stats WHERE season_id = ${seasonId}
  `);
  return new Map(rows.map((r) => [r.player_profile_id, Number(r.rank)]));
}

export interface AdminCustomerCheckpoint {
  checkpointLp: number;
  rewardDiamonds: number;
  internalCostCents: number;
  status: 'pending' | 'granted' | 'reversed';
  reachedAt: Date;
  grantedAt: Date | null;
}

export interface AdminCustomerOrder {
  orderId: string;
  orderNumber: string;
  comboName: string;
  priceMxnCents: number;
  status: string;
  completedAt: Date | null;
  /** Null when the order never earned Level Pass progress. */
  awardedLp: number | null;
  estimatedProfitCents: number | null;
  lpReversedAt: Date | null;
}

export interface AdminCustomerDetail {
  playerProfileId: string;
  displayName: string | null;
  playerId: string;
  email: string;
  memberSince: Date;
  badgeCount: number;

  season: {
    id: string;
    seasonNumber: number;
    lp: number;
    seasonalDiamonds: number;
    rank: number | null;
    vault: { active: boolean; expiresAt: Date | null };
    checkpoints: AdminCustomerCheckpoint[];
  } | null;

  lifetimeDiamondsPurchased: number;
  lifetimeRechargeCount: number;

  /**
   * Admin-only economics for the selected season. `profitGeneratedCents`
   * excludes reversed LP transactions, so a refunded order stops counting
   * toward what this customer earned the business.
   */
  economics: {
    profitGeneratedCents: number;
    rewardCostCents: number;
    retainedProfitCents: number;
    lpAwarded: number;
  };

  orders: AdminCustomerOrder[];
}

export async function getAdminCustomerDetail(
  db: Database,
  playerProfileId: string,
  seasonIdInput?: string,
): Promise<AdminCustomerDetail | null> {
  const [profile] = await db
    .select()
    .from(playerProfiles)
    .where(eq(playerProfiles.id, playerProfileId))
    .limit(1);
  if (!profile) return null;

  const seasonId = await resolveSeasonId(db, seasonIdInput);
  const [season] = seasonId
    ? await db
        .select({ id: seasons.id, seasonNumber: seasons.seasonNumber })
        .from(seasons)
        .where(eq(seasons.id, seasonId))
        .limit(1)
    : [];

  const [badges] = await db
    .select({ n: sql<string>`COUNT(*)::text` })
    .from(badgeOwnerships)
    .where(
      and(eq(badgeOwnerships.playerProfileId, playerProfileId), isNull(badgeOwnerships.revokedAt)),
    );

  let seasonBlock: AdminCustomerDetail['season'] = null;
  let economics = {
    profitGeneratedCents: 0,
    rewardCostCents: 0,
    retainedProfitCents: 0,
    lpAwarded: 0,
  };

  if (season) {
    const [stats] = await db
      .select({ lp: seasonPlayerStats.lp, seasonalDiamonds: seasonPlayerStats.seasonalDiamonds })
      .from(seasonPlayerStats)
      .where(
        and(
          eq(seasonPlayerStats.seasonId, season.id),
          eq(seasonPlayerStats.playerProfileId, playerProfileId),
        ),
      )
      .limit(1);

    const checkpoints = await db
      .select({
        checkpointLp: levelPassCheckpointEvents.checkpointLp,
        rewardDiamonds: levelPassCheckpointEvents.rewardDiamonds,
        internalCostCents: levelPassCheckpointEvents.internalCostCents,
        status: levelPassCheckpointEvents.status,
        reachedAt: levelPassCheckpointEvents.reachedAt,
        grantedAt: levelPassCheckpointEvents.grantedAt,
      })
      .from(levelPassCheckpointEvents)
      .where(
        and(
          eq(levelPassCheckpointEvents.seasonId, season.id),
          eq(levelPassCheckpointEvents.playerProfileId, playerProfileId),
        ),
      )
      .orderBy(levelPassCheckpointEvents.checkpointLp);

    const [vault] = await db
      .select({ status: vaultEntitlements.status, expiresAt: vaultEntitlements.expiresAt })
      .from(vaultEntitlements)
      .where(
        and(
          eq(vaultEntitlements.seasonId, season.id),
          eq(vaultEntitlements.playerProfileId, playerProfileId),
        ),
      )
      .limit(1);

    const ranks = await rankMap(db, season.id);

    seasonBlock = {
      id: season.id,
      seasonNumber: season.seasonNumber,
      lp: stats?.lp ?? 0,
      seasonalDiamonds: stats?.seasonalDiamonds ?? 0,
      rank: ranks.get(playerProfileId) ?? null,
      vault: { active: vault?.status === 'active', expiresAt: vault?.expiresAt ?? null },
      checkpoints,
    };

    const [profit] = await db
      .select({
        profitCents: sql<string>`COALESCE(SUM(${levelPassLpTransactions.estimatedProfitCents}), 0)::text`,
        lp: sql<string>`COALESCE(SUM(${levelPassLpTransactions.awardedLp}), 0)::text`,
      })
      .from(levelPassLpTransactions)
      .where(
        and(
          eq(levelPassLpTransactions.seasonId, season.id),
          eq(levelPassLpTransactions.playerProfileId, playerProfileId),
          isNull(levelPassLpTransactions.reversedAt),
        ),
      );

    // Granted only, matching the season funnel: a reached-but-undelivered
    // checkpoint has cost nothing yet.
    const rewardCostCents = checkpoints
      .filter((c) => c.status === 'granted')
      .reduce((sum, c) => sum + c.internalCostCents, 0);

    const profitGeneratedCents = Number(profit?.profitCents ?? 0);
    economics = {
      profitGeneratedCents,
      rewardCostCents,
      retainedProfitCents: profitGeneratedCents - rewardCostCents,
      lpAwarded: Number(profit?.lp ?? 0),
    };
  }

  const orderRows = await db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      comboSnapshot: orders.comboSnapshot,
      priceMxnCents: orders.priceMxnCents,
      status: orders.status,
      completedAt: orders.completedAt,
      createdAt: orders.createdAt,
      awardedLp: levelPassLpTransactions.awardedLp,
      estimatedProfitCents: levelPassLpTransactions.estimatedProfitCents,
      lpReversedAt: levelPassLpTransactions.reversedAt,
    })
    .from(orders)
    .leftJoin(levelPassLpTransactions, eq(levelPassLpTransactions.orderId, orders.id))
    // Both the orders this account placed while signed in and any top-up to
    // its linked Free Fire ID — a player who bought as a guest before signing
    // up still belongs on their own page.
    .where(
      or(eq(orders.playerProfileId, playerProfileId), eq(orders.playerId, profile.playerId)),
    )
    .orderBy(desc(orders.createdAt))
    .limit(50);

  return {
    playerProfileId: profile.id,
    displayName: profile.displayName,
    playerId: profile.playerId,
    email: profile.email,
    memberSince: profile.createdAt,
    badgeCount: Number(badges?.n ?? 0),
    season: seasonBlock,
    lifetimeDiamondsPurchased: profile.lifetimeDiamondsPurchased,
    lifetimeRechargeCount: profile.lifetimeRechargeCount,
    economics,
    orders: orderRows.map((row) => ({
      orderId: row.orderId,
      orderNumber: row.orderNumber,
      comboName: (row.comboSnapshot as { name?: string }).name ?? 'Recarga',
      priceMxnCents: row.priceMxnCents,
      status: row.status,
      completedAt: row.completedAt,
      awardedLp: row.awardedLp,
      estimatedProfitCents: row.estimatedProfitCents,
      lpReversedAt: row.lpReversedAt,
    })),
  };
}
