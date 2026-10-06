/**
 * `LevelPassStore`/`LevelPassSweepStore` against real Postgres.
 *
 * `findUnprocessedOrders` deliberately issues one small query per candidate
 * order (items, then the paid payment) rather than one large aggregate join.
 * This runs in a background sweep over a bounded batch, not a request path —
 * correctness and readability win over a cleverer join here.
 */

import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type {
  LevelPassCheckpointConfig,
  LevelPassCurrentState,
  LevelPassDecision,
  LevelPassOrderFinancials,
  LevelPassSweepStore,
} from '@levelup/engine';
import type { Database } from '../index.js';
import {
  badgeDefinitions,
  badgeOwnerships,
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  orderItems,
  orders,
  payments,
  playerProfiles,
  seasonPlayerStats,
  seasons,
  vaultEntitlements,
} from '../schema.js';
import { estimateFeeCents } from './accounting-queries.js';
import { getFxRate } from './payment-settings.js';
import { getLevelPassCheckpoints } from './level-pass-settings.js';

export class DrizzleLevelPassStore implements LevelPassSweepStore {
  constructor(private readonly db: Database) {}

  async findActiveSeason(): Promise<{ id: string; endsAt: Date } | null> {
    const [row] = await this.db
      .select({ id: seasons.id, endsAt: seasons.endsAt })
      .from(seasons)
      .where(eq(seasons.status, 'active'))
      .orderBy(desc(seasons.seasonNumber))
      .limit(1);
    return row ?? null;
  }

  async getPlayerState(seasonId: string, playerId: string): Promise<LevelPassCurrentState | null> {
    const [profile] = await this.db
      .select({ id: playerProfiles.id })
      .from(playerProfiles)
      .where(eq(playerProfiles.playerId, playerId))
      .limit(1);
    if (!profile) return null;

    const [stats] = await this.db
      .select({ lp: seasonPlayerStats.lp })
      .from(seasonPlayerStats)
      .where(
        and(eq(seasonPlayerStats.seasonId, seasonId), eq(seasonPlayerStats.playerProfileId, profile.id)),
      )
      .limit(1);

    const reachedRows = await this.db
      .select({ checkpointLp: levelPassCheckpointEvents.checkpointLp })
      .from(levelPassCheckpointEvents)
      .where(
        and(
          eq(levelPassCheckpointEvents.seasonId, seasonId),
          eq(levelPassCheckpointEvents.playerProfileId, profile.id),
        ),
      );

    return {
      seasonId,
      playerProfileId: profile.id,
      currentLp: stats?.lp ?? 0,
      reachedCheckpoints: reachedRows.map((r) => r.checkpointLp),
    };
  }

  getCheckpointConfig(): Promise<LevelPassCheckpointConfig[]> {
    return getLevelPassCheckpoints(this.db);
  }

  async hasProcessedOrder(orderId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: levelPassLpTransactions.id })
      .from(levelPassLpTransactions)
      .where(eq(levelPassLpTransactions.orderId, orderId))
      .limit(1);
    return row !== undefined;
  }

  async applyDecision(
    seasonId: string,
    playerProfileId: string,
    order: LevelPassOrderFinancials,
    decision: LevelPassDecision,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // The real idempotency guard: if another process already recorded this
      // order between this call's own `hasProcessedOrder` check and now, the
      // unique index refuses the insert and we stop here rather than
      // double-applying every counter below.
      const inserted = await tx
        .insert(levelPassLpTransactions)
        .values({
          orderId: order.orderId,
          seasonId,
          playerProfileId,
          saleAmountCents: order.saleAmountCents,
          productCostCents: order.productCostCents,
          paymentFeeCents: order.paymentFeeCents,
          estimatedProfitCents: decision.estimatedProfitCents,
          calculatedLp: decision.calculatedLp,
          awardedLp: decision.awardedLp,
          overriddenByAdminId: order.manualLpOverride?.adminId ?? null,
          overrideReason: order.manualLpOverride?.reason ?? null,
        })
        .onConflictDoNothing({ target: levelPassLpTransactions.orderId })
        .returning({ id: levelPassLpTransactions.id });
      if (inserted.length === 0) return;

      await tx
        .insert(seasonPlayerStats)
        .values({
          seasonId,
          playerProfileId,
          lp: decision.awardedLp,
          seasonalDiamonds: order.diamonds,
        })
        .onConflictDoUpdate({
          target: [seasonPlayerStats.seasonId, seasonPlayerStats.playerProfileId],
          set: {
            lp: sql`${seasonPlayerStats.lp} + ${decision.awardedLp}`,
            seasonalDiamonds: sql`${seasonPlayerStats.seasonalDiamonds} + ${order.diamonds}`,
            updatedAt: sql`now()`,
          },
        });

      await tx
        .update(playerProfiles)
        .set({
          lifetimeDiamondsPurchased: sql`${playerProfiles.lifetimeDiamondsPurchased} + ${order.diamonds}`,
          lifetimeRechargeCount: sql`${playerProfiles.lifetimeRechargeCount} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(playerProfiles.id, playerProfileId));

      for (const grant of decision.newlyCrossedCheckpoints) {
        // Status stays 'pending' here — this records that the checkpoint was
        // reached, not that the reward diamonds were delivered. The financial
        // ledger entry belongs to that later fulfilment step (not built yet),
        // matching the spec's own wording: the expense is recorded "when a
        // reward is actually granted", not when it is merely earned.
        await tx
          .insert(levelPassCheckpointEvents)
          .values({
            seasonId,
            playerProfileId,
            checkpointLp: grant.checkpointLp,
            rewardDiamonds: grant.rewardDiamonds,
            internalCostCents: grant.costCents,
            status: 'pending',
            source: 'automatic',
            relatedOrderId: order.orderId,
          })
          .onConflictDoNothing({
            target: [
              levelPassCheckpointEvents.seasonId,
              levelPassCheckpointEvents.playerProfileId,
              levelPassCheckpointEvents.checkpointLp,
            ],
          });
      }

      if (decision.vaultUnlocked) {
        const [season] = await tx
          .select({ endsAt: seasons.endsAt })
          .from(seasons)
          .where(eq(seasons.id, seasonId))
          .limit(1);
        if (season) {
          await tx
            .insert(vaultEntitlements)
            .values({ seasonId, playerProfileId, status: 'active', expiresAt: season.endsAt })
            .onConflictDoNothing({
              target: [vaultEntitlements.seasonId, vaultEntitlements.playerProfileId],
            });
        }

        const [badgeDef] = await tx
          .select({ id: badgeDefinitions.id })
          .from(badgeDefinitions)
          .where(eq(badgeDefinitions.badgeKey, 'level_pass_completed'))
          .limit(1);
        if (badgeDef) {
          await tx
            .insert(badgeOwnerships)
            .values({ playerProfileId, badgeDefinitionId: badgeDef.id, seasonId, source: 'automatic' })
            .onConflictDoNothing();
        } else {
          // Not an error: badge catalogue is admin-managed (see schema.ts),
          // and "level_pass_completed" may simply not be defined yet.
          console.warn(
            '[level-pass] "level_pass_completed" badge definition not found; skipping badge award',
          );
        }
      }
    });
  }

  async findUnprocessedOrders(input: {
    completedAfter: Date;
    limit: number;
  }): Promise<LevelPassOrderFinancials[]> {
    const fxRate = await getFxRate(this.db);

    const candidates = await this.db
      .select({
        orderId: orders.id,
        playerId: orders.playerId,
        priceMxnCents: orders.priceMxnCents,
      })
      .from(orders)
      .leftJoin(levelPassLpTransactions, eq(levelPassLpTransactions.orderId, orders.id))
      .where(
        and(
          eq(orders.status, 'completed'),
          gte(orders.completedAt, input.completedAfter),
          isNull(levelPassLpTransactions.id),
        ),
      )
      .orderBy(orders.completedAt)
      .limit(input.limit);

    if (candidates.length === 0) return [];
    const orderIds = candidates.map((c) => c.orderId);

    const itemRows = await this.db
      .select({
        orderId: orderItems.orderId,
        costUsd: orderItems.costUsd,
        diamondsBase: orderItems.diamondsBase,
        status: orderItems.status,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds));

    const costUsdByOrder = new Map<string, number>();
    const diamondsByOrder = new Map<string, number>();
    for (const item of itemRows) {
      if (item.costUsd != null) {
        costUsdByOrder.set(item.orderId, (costUsdByOrder.get(item.orderId) ?? 0) + Number(item.costUsd));
      }
      if (item.status === 'succeeded') {
        diamondsByOrder.set(item.orderId, (diamondsByOrder.get(item.orderId) ?? 0) + item.diamondsBase);
      }
    }

    const paidRows = await this.db
      .select({
        orderId: payments.orderId,
        method: payments.method,
        gateway: payments.gateway,
        amountReceivedCents: payments.amountReceivedCents,
      })
      .from(payments)
      .where(and(inArray(payments.orderId, orderIds), eq(payments.status, 'paid')));
    const paidByOrder = new Map(paidRows.map((p) => [p.orderId, p]));

    return candidates.map((row) => {
      const paid = paidByOrder.get(row.orderId);
      const paymentFeeCents = paid
        ? estimateFeeCents(paid.gateway, paid.method, paid.amountReceivedCents ?? 0)
        : 0;
      return {
        orderId: row.orderId,
        playerId: row.playerId,
        saleAmountCents: row.priceMxnCents,
        productCostCents: Math.round((costUsdByOrder.get(row.orderId) ?? 0) * fxRate * 100),
        paymentFeeCents,
        diamonds: diamondsByOrder.get(row.orderId) ?? 0,
      };
    });
  }
}
