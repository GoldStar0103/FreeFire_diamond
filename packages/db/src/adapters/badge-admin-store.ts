/**
 * Admin badge management — create/edit definitions, manual award/revoke, and
 * the holder count the spec asks for ("see how many users own it").
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import {
  auditLog,
  badgeDefinitions,
  badgeOwnerships,
  playerProfiles,
  seasons,
  type badgeCategory,
  type badgeRarity,
} from '../schema.js';

export interface BadgeDefinitionDraft {
  badgeKey: string;
  title: string;
  description: string | null;
  category: (typeof badgeCategory.enumValues)[number];
  rarity: (typeof badgeRarity.enumValues)[number];
  artworkAssetUrl: string | null;
  seasonScoped: boolean;
  eligibilityStartsAt: Date | null;
  eligibilityEndsAt: Date | null;
  obtainable: boolean;
}

export interface BadgeDefinitionRow extends BadgeDefinitionDraft {
  id: string;
  holderCount: number;
}

export async function listBadgeDefinitions(db: Database): Promise<BadgeDefinitionRow[]> {
  const rows = await db
    .select({
      id: badgeDefinitions.id,
      badgeKey: badgeDefinitions.badgeKey,
      title: badgeDefinitions.title,
      description: badgeDefinitions.description,
      category: badgeDefinitions.category,
      rarity: badgeDefinitions.rarity,
      artworkAssetUrl: badgeDefinitions.artworkAssetUrl,
      seasonScoped: badgeDefinitions.seasonScoped,
      eligibilityStartsAt: badgeDefinitions.eligibilityStartsAt,
      eligibilityEndsAt: badgeDefinitions.eligibilityEndsAt,
      obtainable: badgeDefinitions.obtainable,
      holderCount: sql<string>`COUNT(${badgeOwnerships.id}) FILTER (WHERE ${badgeOwnerships.revokedAt} IS NULL)::text`,
    })
    .from(badgeDefinitions)
    .leftJoin(badgeOwnerships, eq(badgeOwnerships.badgeDefinitionId, badgeDefinitions.id))
    .groupBy(badgeDefinitions.id)
    .orderBy(badgeDefinitions.badgeKey);

  return rows.map((r) => ({ ...r, holderCount: Number(r.holderCount) }));
}

export async function getBadgeDefinition(db: Database, badgeKey: string): Promise<BadgeDefinitionRow | null> {
  const all = await listBadgeDefinitions(db);
  return all.find((b) => b.badgeKey === badgeKey) ?? null;
}

/** Create or update by `badgeKey` — the stable identifier the spec calls out as never changing. */
export async function saveBadgeDefinition(
  db: Database,
  draft: BadgeDefinitionDraft,
  adminUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(badgeDefinitions)
      .values(draft)
      .onConflictDoUpdate({ target: badgeDefinitions.badgeKey, set: draft })
      .returning({ id: badgeDefinitions.id });

    await tx.insert(auditLog).values({
      adminUserId,
      action: 'badge_definition.save',
      entityType: 'badge_definition',
      entityId: row!.id,
      detail: draft,
    });
  });
}

export async function setBadgeObtainable(
  db: Database,
  badgeKey: string,
  obtainable: boolean,
  adminUserId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(badgeDefinitions)
      .set({ obtainable })
      .where(eq(badgeDefinitions.badgeKey, badgeKey))
      .returning({ id: badgeDefinitions.id });
    if (!row) return;

    await tx.insert(auditLog).values({
      adminUserId,
      action: 'badge_definition.set_obtainable',
      entityType: 'badge_definition',
      entityId: row.id,
      detail: { badgeKey, obtainable },
    });
  });
}

export type AwardBadgeResult =
  | { ok: true }
  | { ok: false; reason: 'player_not_found' | 'badge_not_found' | 'season_not_found' | 'season_required' };

/**
 * Manual award, same as an automatic one but `source: 'manual'` and a
 * required `reason` for the audit trail. For a season-scoped badge, the
 * caller must supply the season it applies to — the spec treats "Top 10 —
 * Season 2" and "Top 10 — Season 7" as distinct historical records, and a
 * manual award is no exception.
 */
export async function manuallyAwardBadge(
  db: Database,
  input: { playerId: string; badgeKey: string; seasonNumber?: number; reason: string; adminUserId: string },
): Promise<AwardBadgeResult> {
  const [profile] = await db.select({ id: playerProfiles.id }).from(playerProfiles).where(eq(playerProfiles.playerId, input.playerId)).limit(1);
  if (!profile) return { ok: false, reason: 'player_not_found' };

  const [badge] = await db
    .select({ id: badgeDefinitions.id, seasonScoped: badgeDefinitions.seasonScoped })
    .from(badgeDefinitions)
    .where(eq(badgeDefinitions.badgeKey, input.badgeKey))
    .limit(1);
  if (!badge) return { ok: false, reason: 'badge_not_found' };

  let seasonId: string | null = null;
  if (badge.seasonScoped) {
    if (input.seasonNumber === undefined) return { ok: false, reason: 'season_required' };
    const [season] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.seasonNumber, input.seasonNumber)).limit(1);
    if (!season) return { ok: false, reason: 'season_not_found' };
    seasonId = season.id;
  }

  await db.transaction(async (tx) => {
    const [ownership] = await tx
      .insert(badgeOwnerships)
      .values({
        playerProfileId: profile.id,
        badgeDefinitionId: badge.id,
        seasonId,
        source: 'manual',
        awardedByAdminId: input.adminUserId,
        reason: input.reason,
      })
      .onConflictDoNothing()
      .returning({ id: badgeOwnerships.id });

    if (ownership) {
      await tx.insert(auditLog).values({
        adminUserId: input.adminUserId,
        action: 'badge.manual_award',
        entityType: 'badge_ownership',
        entityId: ownership.id,
        detail: { playerId: input.playerId, badgeKey: input.badgeKey, seasonNumber: input.seasonNumber, reason: input.reason },
      });
    }
  });

  return { ok: true };
}

export async function revokeBadgeOwnership(db: Database, ownershipId: string, adminUserId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(badgeOwnerships)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(badgeOwnerships.id, ownershipId), isNull(badgeOwnerships.revokedAt)))
      .returning({ id: badgeOwnerships.id });
    if (!row) return;

    await tx.insert(auditLog).values({
      adminUserId,
      action: 'badge.revoke',
      entityType: 'badge_ownership',
      entityId: ownershipId,
      detail: { reason },
    });
  });
}

export interface BadgeHolderRow {
  ownershipId: string;
  playerId: string;
  displayName: string | null;
  seasonNumber: number | null;
  source: 'automatic' | 'manual';
  earnedAt: Date;
  revokedAt: Date | null;
}

export async function listBadgeHolders(db: Database, badgeKey: string): Promise<BadgeHolderRow[]> {
  return db
    .select({
      ownershipId: badgeOwnerships.id,
      playerId: playerProfiles.playerId,
      displayName: playerProfiles.displayName,
      seasonNumber: seasons.seasonNumber,
      source: badgeOwnerships.source,
      earnedAt: badgeOwnerships.earnedAt,
      revokedAt: badgeOwnerships.revokedAt,
    })
    .from(badgeOwnerships)
    .innerJoin(badgeDefinitions, eq(badgeDefinitions.id, badgeOwnerships.badgeDefinitionId))
    .innerJoin(playerProfiles, eq(playerProfiles.id, badgeOwnerships.playerProfileId))
    .leftJoin(seasons, eq(seasons.id, badgeOwnerships.seasonId))
    .where(eq(badgeDefinitions.badgeKey, badgeKey))
    .orderBy(desc(badgeOwnerships.earnedAt));
}
