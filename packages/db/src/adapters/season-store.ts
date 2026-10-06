/** `SeasonStore` against real Postgres — see packages/engine/src/seasons.ts. */

import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import type { DueSeason, SeasonClosePlan, SeasonRankingRow, SeasonStore } from '@levelup/engine';
import type { Database } from '../index.js';
import {
  badgeDefinitions,
  badgeOwnerships,
  hallOfFameEntries,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
} from '../schema.js';

export class DrizzleSeasonStore implements SeasonStore {
  constructor(private readonly db: Database) {}

  async findDueSeasons(now: Date): Promise<DueSeason[]> {
    return this.db
      .select({ id: seasons.id, seasonNumber: seasons.seasonNumber, endsAt: seasons.endsAt })
      .from(seasons)
      .where(and(eq(seasons.status, 'active'), lte(seasons.endsAt, now)));
  }

  async getSeasonRanking(seasonId: string): Promise<SeasonRankingRow[]> {
    return this.db
      .select({
        playerProfileId: seasonPlayerStats.playerProfileId,
        displayName: playerProfiles.displayName,
        avatarAssetUrl: playerProfiles.avatarAssetUrl,
        seasonalDiamonds: seasonPlayerStats.seasonalDiamonds,
      })
      .from(seasonPlayerStats)
      .innerJoin(playerProfiles, eq(playerProfiles.id, seasonPlayerStats.playerProfileId))
      .where(eq(seasonPlayerStats.seasonId, seasonId))
      .orderBy(desc(seasonPlayerStats.seasonalDiamonds));
  }

  async closeSeason(plan: SeasonClosePlan): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const entry of plan.hallOfFame) {
        await tx
          .insert(hallOfFameEntries)
          .values({
            seasonId: plan.seasonId,
            position: entry.position,
            playerProfileId: entry.playerProfileId,
            displayNameSnapshot: entry.displayNameSnapshot,
            avatarAssetUrlSnapshot: entry.avatarAssetUrlSnapshot,
            seasonalDiamonds: entry.seasonalDiamonds,
          })
          .onConflictDoNothing({ target: [hallOfFameEntries.seasonId, hallOfFameEntries.position] });
      }

      // One lookup for every distinct badge key this close needs, not one per award.
      const neededKeys = [...new Set(plan.badgeAwards.map((a) => a.badgeKey))];
      const defRows =
        neededKeys.length > 0
          ? await tx
              .select({ id: badgeDefinitions.id, badgeKey: badgeDefinitions.badgeKey })
              .from(badgeDefinitions)
              .where(inArray(badgeDefinitions.badgeKey, neededKeys))
          : [];
      const definitionIdByKey = new Map(defRows.map((d) => [d.badgeKey, d.id]));

      for (const award of plan.badgeAwards) {
        const definitionId = definitionIdByKey.get(award.badgeKey);
        if (!definitionId) {
          // Not an error — see level-pass-store.ts's identical note: the
          // badge catalogue is admin-managed, so a key can simply not exist yet.
          console.warn(`[seasons] badge definition "${award.badgeKey}" not found; skipping award`);
          continue;
        }
        await tx
          .insert(badgeOwnerships)
          .values({
            playerProfileId: award.playerProfileId,
            badgeDefinitionId: definitionId,
            seasonId: plan.seasonId,
            achievementData: award.achievementData,
            source: 'automatic',
          })
          .onConflictDoNothing();
      }

      await tx
        .update(vaultEntitlements)
        .set({ status: 'expired' })
        .where(and(eq(vaultEntitlements.seasonId, plan.seasonId), eq(vaultEntitlements.status, 'active')));

      await tx
        .update(seasons)
        .set({ status: 'closed', closedAt: sql`now()` })
        .where(eq(seasons.id, plan.seasonId));

      await tx.insert(seasons).values({
        seasonNumber: plan.nextSeasonNumber,
        startsAt: plan.nextSeasonStartsAt,
        endsAt: plan.nextSeasonEndsAt,
        status: 'active',
      });
    });
  }
}
