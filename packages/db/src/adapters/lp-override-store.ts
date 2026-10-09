/**
 * Applying an admin's manual Level Points override to an order.
 *
 * `planLpOverride` decides; this applies it in one transaction. The shape
 * deliberately mirrors `reverseCompletedOrder` — same checkpoint policy, same
 * SQL-side floors, same audit row — because an override downward and a refund
 * do the same thing to a player's standing and should not diverge.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { planLpOverride, type LpOverridePlan, type ReversibleCheckpoint } from '@levelup/engine';
import type { Database } from '../index.js';
import {
  auditLog,
  badgeDefinitions,
  badgeOwnerships,
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
} from '../schema.js';
import { getLevelPassCheckpoints } from './level-pass-settings.js';

export type OverrideLpResult =
  | { ok: true; plan: LpOverridePlan }
  | { ok: false; reason: 'no_lp_transaction' | 'reversed' | 'invalid_lp' };

export interface OverrideLpInput {
  orderId: string;
  adminUserId: string;
  newAwardedLp: number;
  reason?: string;
}

/** Guard rail on a free-text admin field: a typo should not mint 100,000 LP. */
const MAX_MANUAL_LP = 100_000;

export interface OrderLpSummary {
  /** What the profit formula produced. Never changed by an override. */
  calculatedLp: number;
  /** What the player actually received. */
  awardedLp: number;
  overridden: boolean;
  overrideReason: string | null;
  reversedAt: Date | null;
}

/** Null when this order never earned Level Pass progress. */
export async function getOrderLpSummary(
  db: Database,
  orderId: string,
): Promise<OrderLpSummary | null> {
  const [row] = await db
    .select({
      calculatedLp: levelPassLpTransactions.calculatedLp,
      awardedLp: levelPassLpTransactions.awardedLp,
      overriddenByAdminId: levelPassLpTransactions.overriddenByAdminId,
      overrideReason: levelPassLpTransactions.overrideReason,
      reversedAt: levelPassLpTransactions.reversedAt,
    })
    .from(levelPassLpTransactions)
    .where(eq(levelPassLpTransactions.orderId, orderId))
    .limit(1);
  if (!row) return null;

  return {
    calculatedLp: row.calculatedLp,
    awardedLp: row.awardedLp,
    overridden: row.overriddenByAdminId !== null,
    overrideReason: row.overrideReason,
    reversedAt: row.reversedAt,
  };
}

export async function overrideOrderLp(
  db: Database,
  input: OverrideLpInput,
): Promise<OverrideLpResult> {
  if (
    !Number.isInteger(input.newAwardedLp) ||
    input.newAwardedLp < 0 ||
    input.newAwardedLp > MAX_MANUAL_LP
  ) {
    return { ok: false, reason: 'invalid_lp' };
  }

  // Read outside the transaction: the ladder is a settings row nobody is
  // racing us for, and fetching it inside would mean handing a transaction
  // handle to a helper typed for the plain database.
  const checkpoints = await getLevelPassCheckpoints(db);

  return db.transaction(async (tx) => {
    const [lpTx] = await tx
      .select()
      .from(levelPassLpTransactions)
      .where(eq(levelPassLpTransactions.orderId, input.orderId))
      .limit(1);

    if (!lpTx) return { ok: false, reason: 'no_lp_transaction' } as const;
    // Editing the LP of an order whose money has been given back would put
    // progress back on a purchase that no longer exists.
    if (lpTx.reversedAt !== null) return { ok: false, reason: 'reversed' } as const;

    const [stats] = await tx
      .select({ lp: seasonPlayerStats.lp })
      .from(seasonPlayerStats)
      .where(
        and(
          eq(seasonPlayerStats.seasonId, lpTx.seasonId),
          eq(seasonPlayerStats.playerProfileId, lpTx.playerProfileId),
        ),
      )
      .limit(1);

    const existingRows = await tx
      .select({
        checkpointEventId: levelPassCheckpointEvents.id,
        checkpointLp: levelPassCheckpointEvents.checkpointLp,
        status: levelPassCheckpointEvents.status,
        rewardOrderId: levelPassCheckpointEvents.rewardOrderId,
      })
      .from(levelPassCheckpointEvents)
      .where(
        and(
          eq(levelPassCheckpointEvents.seasonId, lpTx.seasonId),
          eq(levelPassCheckpointEvents.playerProfileId, lpTx.playerProfileId),
        ),
      );

    const [vault] = await tx
      .select({ id: vaultEntitlements.id })
      .from(vaultEntitlements)
      .where(
        and(
          eq(vaultEntitlements.seasonId, lpTx.seasonId),
          eq(vaultEntitlements.playerProfileId, lpTx.playerProfileId),
          eq(vaultEntitlements.status, 'active'),
        ),
      )
      .limit(1);

    const plan = planLpOverride({
      previousAwardedLp: lpTx.awardedLp,
      newAwardedLp: input.newAwardedLp,
      currentLp: stats?.lp ?? 0,
      checkpoints,
      existing: existingRows.map(
        (row): ReversibleCheckpoint => ({
          checkpointEventId: row.checkpointEventId,
          checkpointLp: row.checkpointLp,
          status: row.status,
          rewardOrderPlaced: row.rewardOrderId !== null,
        }),
      ),
      vaultUnlocked: vault !== undefined,
    });

    // `calculated_lp` is deliberately untouched — the spec wants both the
    // formula's answer and the final one kept side by side.
    await tx
      .update(levelPassLpTransactions)
      .set({
        awardedLp: plan.newAwardedLp,
        overriddenByAdminId: input.adminUserId,
        overrideReason: input.reason?.trim() || null,
      })
      .where(eq(levelPassLpTransactions.id, lpTx.id));

    if (plan.lpDelta !== 0) {
      await tx
        .insert(seasonPlayerStats)
        .values({
          seasonId: lpTx.seasonId,
          playerProfileId: lpTx.playerProfileId,
          lp: Math.max(0, plan.lpDelta),
          seasonalDiamonds: 0,
        })
        .onConflictDoUpdate({
          target: [seasonPlayerStats.seasonId, seasonPlayerStats.playerProfileId],
          set: {
            lp: sql`GREATEST(${seasonPlayerStats.lp} + ${plan.lpDelta}, 0)`,
            updatedAt: sql`now()`,
          },
        });
    }

    for (const grant of plan.checkpointsToCreate) {
      await tx
        .insert(levelPassCheckpointEvents)
        .values({
          seasonId: lpTx.seasonId,
          playerProfileId: lpTx.playerProfileId,
          checkpointLp: grant.checkpointLp,
          rewardDiamonds: grant.rewardDiamonds,
          internalCostCents: grant.costCents,
          status: 'pending',
          // The admin caused this one, not the sweep.
          source: 'manual',
          relatedOrderId: input.orderId,
        })
        .onConflictDoNothing({
          target: [
            levelPassCheckpointEvents.seasonId,
            levelPassCheckpointEvents.playerProfileId,
            levelPassCheckpointEvents.checkpointLp,
          ],
        });
    }

    for (const eventId of plan.checkpointEventIdsToRestore) {
      await tx
        .update(levelPassCheckpointEvents)
        .set({ status: 'pending', source: 'manual', reason: input.reason?.trim() || null })
        .where(
          and(
            eq(levelPassCheckpointEvents.id, eventId),
            eq(levelPassCheckpointEvents.status, 'reversed'),
          ),
        );
    }

    for (const eventId of plan.checkpointEventIdsToReverse) {
      await tx
        .update(levelPassCheckpointEvents)
        .set({ status: 'reversed', reason: input.reason?.trim() || null })
        .where(
          and(
            eq(levelPassCheckpointEvents.id, eventId),
            eq(levelPassCheckpointEvents.status, 'pending'),
          ),
        );
    }

    if (plan.unlockVault) {
      const [season] = await tx
        .select({ endsAt: seasons.endsAt })
        .from(seasons)
        .where(eq(seasons.id, lpTx.seasonId))
        .limit(1);
      if (season) {
        await tx
          .insert(vaultEntitlements)
          .values({
            seasonId: lpTx.seasonId,
            playerProfileId: lpTx.playerProfileId,
            status: 'active',
            expiresAt: season.endsAt,
          })
          .onConflictDoUpdate({
            target: [vaultEntitlements.seasonId, vaultEntitlements.playerProfileId],
            set: { status: 'active' },
          });
      }

      // Same best-effort award as the automatic path: the badge catalogue is
      // admin-managed, so the definition may simply not exist yet.
      const [badgeDef] = await tx
        .select({ id: badgeDefinitions.id })
        .from(badgeDefinitions)
        .where(eq(badgeDefinitions.badgeKey, 'level_pass_completed'))
        .limit(1);
      if (badgeDef) {
        await tx
          .insert(badgeOwnerships)
          .values({
            playerProfileId: lpTx.playerProfileId,
            badgeDefinitionId: badgeDef.id,
            seasonId: lpTx.seasonId,
            source: 'manual',
          })
          .onConflictDoNothing();
      }
    }

    if (plan.closeVault && vault) {
      await tx.update(vaultEntitlements).set({ status: 'expired' }).where(eq(vaultEntitlements.id, vault.id));
    }

    await tx.insert(auditLog).values({
      adminUserId: input.adminUserId,
      action: 'order.lp_override',
      entityType: 'order',
      entityId: input.orderId,
      detail: {
        calculatedLp: lpTx.calculatedLp,
        previousAwardedLp: plan.previousAwardedLp,
        newAwardedLp: plan.newAwardedLp,
        reason: input.reason ?? null,
        plan,
      },
    });

    return { ok: true, plan } as const;
  });
}
