/**
 * Mi LevelUp: everything the logged-in customer's own dashboard, badge
 * collection and order history need to read, plus profile editing.
 *
 * Public-facing reads (Top 50, a public player profile) are deliberately
 * separate functions from the "my own profile" ones below, each selecting
 * only the columns the spec's own privacy table allows public — see
 * `getPublicProfile`/`getPublicTop50` and their own comments.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import {
  badgeDefinitions,
  badgeOwnerships,
  featuredBadges,
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  orders,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
  vaultOffers,
  combos,
} from '../schema.js';
import { getLevelPassCheckpoints } from './level-pass-settings.js';

// ── my dashboard ─────────────────────────────────────────────────────────────

export interface MyProfile {
  id: string;
  playerId: string;
  displayName: string | null;
  avatarAssetUrl: string | null;
  lifetimeDiamondsPurchased: number;
  lifetimeRechargeCount: number;
  createdAt: Date;
}

export async function getMyProfile(db: Database, playerProfileId: string): Promise<MyProfile | null> {
  const [row] = await db.select().from(playerProfiles).where(eq(playerProfiles.id, playerProfileId)).limit(1);
  return row ?? null;
}

export interface MyCheckpointProgress {
  lp: number;
  rewardDiamonds: number;
  reached: boolean;
  status: 'pending' | 'granted' | 'reversed' | null;
}

export interface MyVaultOffer {
  /** Needed to actually buy the offer — see `/comprar/[combo]?oferta=`. */
  vaultOfferId: string;
  comboKey: string;
  comboName: string;
  publicPriceMxnCents: number;
  vaultPriceMxnCents: number;
}

export interface MyFeaturedBadge {
  ownershipId: string;
  badgeKey: string;
  title: string;
  artworkAssetUrl: string | null;
  rarity: string;
  sortOrder: number;
}

export interface MyLevelUpOverview {
  season: { id: string; seasonNumber: number; endsAt: Date } | null;
  lp: number;
  seasonalDiamonds: number;
  /** Null when there is no active season, or this player has no rows in it yet. */
  rank: number | null;
  checkpoints: MyCheckpointProgress[];
  vault: { unlocked: boolean; expiresAt: Date | null; offers: MyVaultOffer[] };
  featuredBadges: MyFeaturedBadge[];
}

export async function getMyLevelUpOverview(db: Database, playerProfileId: string): Promise<MyLevelUpOverview> {
  const [season] = await db
    .select({ id: seasons.id, seasonNumber: seasons.seasonNumber, endsAt: seasons.endsAt })
    .from(seasons)
    .where(eq(seasons.status, 'active'))
    .orderBy(desc(seasons.seasonNumber))
    .limit(1);

  if (!season) {
    return { season: null, lp: 0, seasonalDiamonds: 0, rank: null, checkpoints: [], vault: { unlocked: false, expiresAt: null, offers: [] }, featuredBadges: [] };
  }

  const [stats] = await db
    .select({ lp: seasonPlayerStats.lp, seasonalDiamonds: seasonPlayerStats.seasonalDiamonds })
    .from(seasonPlayerStats)
    .where(and(eq(seasonPlayerStats.seasonId, season.id), eq(seasonPlayerStats.playerProfileId, playerProfileId)))
    .limit(1);

  const rankRows = await db.execute<{ rank: string }>(sql`
    SELECT rank FROM (
      SELECT player_profile_id, RANK() OVER (ORDER BY seasonal_diamonds DESC) AS rank
      FROM season_player_stats WHERE season_id = ${season.id}
    ) ranked WHERE player_profile_id = ${playerProfileId}
  `);
  const rank = rankRows[0] ? Number(rankRows[0].rank) : null;

  const checkpointConfig = await getLevelPassCheckpoints(db);
  const reachedRows = await db
    .select({ checkpointLp: levelPassCheckpointEvents.checkpointLp, status: levelPassCheckpointEvents.status })
    .from(levelPassCheckpointEvents)
    .where(and(eq(levelPassCheckpointEvents.seasonId, season.id), eq(levelPassCheckpointEvents.playerProfileId, playerProfileId)));
  const reachedByLp = new Map(reachedRows.map((r) => [r.checkpointLp, r.status]));

  const checkpoints: MyCheckpointProgress[] = [...checkpointConfig]
    .sort((a, b) => a.lp - b.lp)
    .map((cp) => ({
      lp: cp.lp,
      rewardDiamonds: cp.rewardDiamonds,
      reached: reachedByLp.has(cp.lp),
      status: reachedByLp.get(cp.lp) ?? null,
    }));

  const [vaultEntitlement] = await db
    .select({ expiresAt: vaultEntitlements.expiresAt, status: vaultEntitlements.status })
    .from(vaultEntitlements)
    .where(and(eq(vaultEntitlements.seasonId, season.id), eq(vaultEntitlements.playerProfileId, playerProfileId)))
    .limit(1);
  const vaultUnlocked = vaultEntitlement?.status === 'active';

  const offerRows = vaultUnlocked
    ? await db
        .select({
          vaultOfferId: vaultOffers.id,
          comboKey: combos.key,
          comboName: combos.name,
          publicPriceMxnCents: combos.priceMxnCents,
          vaultPriceMxnCents: vaultOffers.vaultPriceMxnCents,
        })
        .from(vaultOffers)
        .innerJoin(combos, eq(combos.id, vaultOffers.comboId))
        .where(eq(vaultOffers.active, true))
        .orderBy(vaultOffers.sortOrder)
    : [];

  const featured = await db
    .select({
      ownershipId: featuredBadges.badgeOwnershipId,
      sortOrder: featuredBadges.sortOrder,
      badgeKey: badgeDefinitions.badgeKey,
      title: badgeDefinitions.title,
      artworkAssetUrl: badgeDefinitions.artworkAssetUrl,
      rarity: badgeDefinitions.rarity,
    })
    .from(featuredBadges)
    .innerJoin(badgeOwnerships, eq(badgeOwnerships.id, featuredBadges.badgeOwnershipId))
    .innerJoin(badgeDefinitions, eq(badgeDefinitions.id, badgeOwnerships.badgeDefinitionId))
    .where(eq(featuredBadges.playerProfileId, playerProfileId))
    .orderBy(featuredBadges.sortOrder);

  return {
    season,
    lp: stats?.lp ?? 0,
    seasonalDiamonds: stats?.seasonalDiamonds ?? 0,
    rank,
    checkpoints,
    vault: { unlocked: vaultUnlocked, expiresAt: vaultEntitlement?.expiresAt ?? null, offers: offerRows },
    featuredBadges: featured,
  };
}

// ── badge collection ─────────────────────────────────────────────────────────

export interface MyBadgeRow {
  ownershipId: string;
  badgeKey: string;
  title: string;
  description: string | null;
  category: string;
  rarity: string;
  artworkAssetUrl: string | null;
  seasonNumber: number | null;
  achievementData: unknown;
  earnedAt: Date;
  featured: boolean;
}

export async function listMyBadges(db: Database, playerProfileId: string): Promise<MyBadgeRow[]> {
  const rows = await db
    .select({
      ownershipId: badgeOwnerships.id,
      badgeKey: badgeDefinitions.badgeKey,
      title: badgeDefinitions.title,
      description: badgeDefinitions.description,
      category: badgeDefinitions.category,
      rarity: badgeDefinitions.rarity,
      artworkAssetUrl: badgeDefinitions.artworkAssetUrl,
      seasonNumber: seasons.seasonNumber,
      achievementData: badgeOwnerships.achievementData,
      earnedAt: badgeOwnerships.earnedAt,
      featuredOwnershipId: featuredBadges.badgeOwnershipId,
    })
    .from(badgeOwnerships)
    .innerJoin(badgeDefinitions, eq(badgeDefinitions.id, badgeOwnerships.badgeDefinitionId))
    .leftJoin(seasons, eq(seasons.id, badgeOwnerships.seasonId))
    .leftJoin(featuredBadges, eq(featuredBadges.badgeOwnershipId, badgeOwnerships.id))
    .where(and(eq(badgeOwnerships.playerProfileId, playerProfileId), sql`${badgeOwnerships.revokedAt} IS NULL`))
    .orderBy(desc(badgeOwnerships.earnedAt));

  return rows.map((r) => ({ ...r, featured: r.featuredOwnershipId !== null }));
}

export type SetFeaturedResult = { ok: true } | { ok: false; reason: 'not_owned' | 'too_many' };

/** Max featured badges shown on the main profile — see the spec's own "3-4 featured badges" guidance. */
const MAX_FEATURED_BADGES = 4;

export async function setFeaturedBadges(
  db: Database,
  playerProfileId: string,
  ownershipIds: string[],
): Promise<SetFeaturedResult> {
  if (ownershipIds.length > MAX_FEATURED_BADGES) return { ok: false, reason: 'too_many' };

  if (ownershipIds.length > 0) {
    const owned = await db
      .select({ id: badgeOwnerships.id })
      .from(badgeOwnerships)
      .where(and(eq(badgeOwnerships.playerProfileId, playerProfileId), inArray(badgeOwnerships.id, ownershipIds)));
    if (owned.length !== ownershipIds.length) return { ok: false, reason: 'not_owned' };
  }

  await db.transaction(async (tx) => {
    await tx.delete(featuredBadges).where(eq(featuredBadges.playerProfileId, playerProfileId));
    if (ownershipIds.length > 0) {
      await tx.insert(featuredBadges).values(
        ownershipIds.map((id, index) => ({ playerProfileId, badgeOwnershipId: id, sortOrder: index })),
      );
    }
  });

  return { ok: true };
}

// ── order history ────────────────────────────────────────────────────────────

export interface MyOrderRow {
  orderNumber: string;
  comboName: string;
  priceMxnCents: number;
  status: string;
  createdAt: Date;
  lpEarned: number | null;
}

export async function listMyOrders(db: Database, playerId: string, limit = 50): Promise<MyOrderRow[]> {
  const rows = await db
    .select({
      orderNumber: orders.orderNumber,
      comboSnapshot: orders.comboSnapshot,
      priceMxnCents: orders.priceMxnCents,
      status: orders.status,
      createdAt: orders.createdAt,
      lpEarned: levelPassLpTransactions.awardedLp,
    })
    .from(orders)
    .leftJoin(levelPassLpTransactions, eq(levelPassLpTransactions.orderId, orders.id))
    .where(eq(orders.playerId, playerId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);

  return rows.map((r) => {
    const snapshot = r.comboSnapshot as { name?: string };
    return {
      orderNumber: r.orderNumber,
      comboName: snapshot.name ?? 'Recarga',
      priceMxnCents: r.priceMxnCents,
      status: r.status,
      createdAt: r.createdAt,
      lpEarned: r.lpEarned,
    };
  });
}

// ── profile editing ──────────────────────────────────────────────────────────

export interface DisplayNameIssue {
  message: string;
}

/**
 * Length/charset only — no profanity filter yet (the spec's "prohibited-word/
 * moderation rules" is a real gap, left for the admin moderation tooling to
 * close later: an admin can already null out a display name, which puts the
 * profile back in the "pendiente de actualizar" state per the spec).
 */
export function reviewDisplayName(raw: string): { displayName: string | null; issue: DisplayNameIssue | null } {
  const trimmed = raw.trim();
  if (trimmed.length < 3) return { displayName: null, issue: { message: 'El nombre debe tener al menos 3 caracteres.' } };
  if (trimmed.length > 20) return { displayName: null, issue: { message: 'El nombre no puede tener más de 20 caracteres.' } };
  if (!/^[\p{L}\p{N}_ ]+$/u.test(trimmed)) {
    return { displayName: null, issue: { message: 'Usa solo letras, números, espacios y guión bajo.' } };
  }
  return { displayName: trimmed, issue: null };
}

export type UpdateDisplayNameResult = { ok: true } | { ok: false; reason: 'invalid' | 'taken'; message: string };

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;

export async function updateDisplayName(db: Database, playerProfileId: string, raw: string): Promise<UpdateDisplayNameResult> {
  const { displayName, issue } = reviewDisplayName(raw);
  if (issue) return { ok: false, reason: 'invalid', message: issue.message };

  try {
    await db.update(playerProfiles).set({ displayName, updatedAt: sql`now()` }).where(eq(playerProfiles.id, playerProfileId));
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'taken', message: 'Ese nombre ya lo está usando otro jugador.' };
    throw err;
  }
}

export async function updateAvatar(db: Database, playerProfileId: string, avatarAssetUrl: string): Promise<void> {
  await db.update(playerProfiles).set({ avatarAssetUrl, updatedAt: sql`now()` }).where(eq(playerProfiles.id, playerProfileId));
}

// ── public surfaces ──────────────────────────────────────────────────────────

export interface PublicRankingRow {
  playerProfileId: string;
  displayName: string | null;
  avatarAssetUrl: string | null;
  seasonalDiamonds: number;
  rank: number;
}

/** Top 50 for the current season — the public leaderboard. No spend figures, ever. */
export async function getPublicTop50(db: Database): Promise<PublicRankingRow[]> {
  const [season] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, 'active'))
    .orderBy(desc(seasons.seasonNumber))
    .limit(1);
  if (!season) return [];

  const rows = await db
    .select({
      playerProfileId: seasonPlayerStats.playerProfileId,
      displayName: playerProfiles.displayName,
      avatarAssetUrl: playerProfiles.avatarAssetUrl,
      seasonalDiamonds: seasonPlayerStats.seasonalDiamonds,
    })
    .from(seasonPlayerStats)
    .innerJoin(playerProfiles, eq(playerProfiles.id, seasonPlayerStats.playerProfileId))
    .where(eq(seasonPlayerStats.seasonId, season.id))
    .orderBy(desc(seasonPlayerStats.seasonalDiamonds))
    .limit(50);

  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

export interface PublicProfile {
  displayName: string | null;
  avatarAssetUrl: string | null;
  memberSinceYear: number;
  currentRank: number | null;
  currentSeasonalDiamonds: number;
  levelPassesCompleted: number;
  highestHistoricalRank: number | null;
  seasonsParticipatedIn: number;
  featuredBadges: MyFeaturedBadge[];
}

/**
 * Only what the spec's own privacy table allows public. Deliberately its own
 * query rather than a trimmed version of `getMyLevelUpOverview` — a function
 * that could leak a private field through a forgotten select is a worse risk
 * than a little duplication. Never: legal name, email, phone, orders, money.
 */
export async function getPublicProfile(db: Database, playerProfileId: string): Promise<PublicProfile | null> {
  const [profile] = await db
    .select({ displayName: playerProfiles.displayName, avatarAssetUrl: playerProfiles.avatarAssetUrl, createdAt: playerProfiles.createdAt })
    .from(playerProfiles)
    .where(eq(playerProfiles.id, playerProfileId))
    .limit(1);
  if (!profile) return null;

  const [activeSeason] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.status, 'active')).orderBy(desc(seasons.seasonNumber)).limit(1);

  let currentRank: number | null = null;
  let currentSeasonalDiamonds = 0;
  if (activeSeason) {
    const [stats] = await db
      .select({ seasonalDiamonds: seasonPlayerStats.seasonalDiamonds })
      .from(seasonPlayerStats)
      .where(and(eq(seasonPlayerStats.seasonId, activeSeason.id), eq(seasonPlayerStats.playerProfileId, playerProfileId)))
      .limit(1);
    currentSeasonalDiamonds = stats?.seasonalDiamonds ?? 0;

    const rankRows = await db.execute<{ rank: string }>(sql`
      SELECT rank FROM (
        SELECT player_profile_id, RANK() OVER (ORDER BY seasonal_diamonds DESC) AS rank
        FROM season_player_stats WHERE season_id = ${activeSeason.id}
      ) ranked WHERE player_profile_id = ${playerProfileId}
    `);
    currentRank = rankRows[0] ? Number(rankRows[0].rank) : null;
  }

  const [vaultCount] = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM vault_entitlements WHERE player_profile_id = ${playerProfileId}
  `);
  const [seasonCount] = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count FROM season_player_stats WHERE player_profile_id = ${playerProfileId}
  `);
  const [bestRank] = await db.execute<{ best: string | null }>(sql`
    SELECT MIN(rank)::text AS best FROM (
      SELECT RANK() OVER (PARTITION BY season_id ORDER BY seasonal_diamonds DESC) AS rank, player_profile_id
      FROM season_player_stats
    ) ranked WHERE player_profile_id = ${playerProfileId}
  `);

  const featured = await db
    .select({
      ownershipId: featuredBadges.badgeOwnershipId,
      sortOrder: featuredBadges.sortOrder,
      badgeKey: badgeDefinitions.badgeKey,
      title: badgeDefinitions.title,
      artworkAssetUrl: badgeDefinitions.artworkAssetUrl,
      rarity: badgeDefinitions.rarity,
    })
    .from(featuredBadges)
    .innerJoin(badgeOwnerships, eq(badgeOwnerships.id, featuredBadges.badgeOwnershipId))
    .innerJoin(badgeDefinitions, eq(badgeDefinitions.id, badgeOwnerships.badgeDefinitionId))
    .where(eq(featuredBadges.playerProfileId, playerProfileId))
    .orderBy(featuredBadges.sortOrder);

  return {
    displayName: profile.displayName,
    avatarAssetUrl: profile.avatarAssetUrl,
    memberSinceYear: profile.createdAt.getFullYear(),
    currentRank,
    currentSeasonalDiamonds,
    levelPassesCompleted: Number(vaultCount?.count ?? 0),
    highestHistoricalRank: bestRank?.best ? Number(bestRank.best) : null,
    seasonsParticipatedIn: Number(seasonCount?.count ?? 0),
    featuredBadges: featured,
  };
}
