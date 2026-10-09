/**
 * Reversing a completed order: the spec's cancellation/refund policy, applied.
 *
 * `planOrderReversal` in the engine decides WHAT to unwind and why; this file
 * is the transactional application of that decision, plus the two things only
 * the database can do — prove the order was still `completed` when we moved
 * it, and post the money side.
 *
 * Accounting shape, deliberately: the original sale is left exactly where it
 * was and the reversal is posted on the day it happens, as an `order_refund`
 * ledger entry for the amount returned. Restating a closed period would be
 * wrong twice over — the revenue genuinely was collected then, and the
 * recharge cost and payment fee are NOT refunded to LevelUp, so deleting the
 * sale would quietly hide the real loss this refund causes.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { planOrderReversal, type OrderReversalPlan, type ReversibleCheckpoint } from '@levelup/engine';
import type { Database } from '../index.js';
import {
  auditLog,
  financialLedgerEntries,
  levelPassCheckpointEvents,
  levelPassLpTransactions,
  orderItems,
  orders,
  playerProfiles,
  seasonPlayerStats,
  vaultEntitlements,
} from '../schema.js';

export type ReverseOrderResult =
  | { ok: true; plan: OrderReversalPlan | null; refundedCents: number }
  | { ok: false; reason: 'not_found' | 'not_completed' };

export interface ReverseOrderInput {
  orderId: string;
  adminUserId: string;
  /** Shown to the customer on their own tracking page, so write it for them. */
  reason: string;
}

/**
 * `plan` is null when the order never earned Level Pass progress — placed by
 * a guest, or completed before any season was open. The money side still
 * happens; there is simply nothing to unwind.
 */
export async function reverseCompletedOrder(
  db: Database,
  input: ReverseOrderInput,
): Promise<ReverseOrderResult> {
  return db.transaction(async (tx) => {
    // Compare-and-set, the same discipline as every other terminal write in
    // this codebase: if a concurrent request already reversed this order, the
    // WHERE matches nothing and we stop rather than unwinding its counters a
    // second time.
    const [order] = await tx
      .update(orders)
      .set({ status: 'refunded', cancelReason: input.reason, updatedAt: sql`now()` })
      .where(and(eq(orders.id, input.orderId), eq(orders.status, 'completed')))
      .returning({
        id: orders.id,
        playerId: orders.playerId,
        priceMxnCents: orders.priceMxnCents,
      });

    if (!order) {
      const [exists] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.id, input.orderId))
        .limit(1);
      return { ok: false, reason: exists ? 'not_completed' : 'not_found' } as const;
    }

    const [lpTx] = await tx
      .select()
      .from(levelPassLpTransactions)
      .where(
        and(
          eq(levelPassLpTransactions.orderId, order.id),
          isNull(levelPassLpTransactions.reversedAt),
        ),
      )
      .limit(1);

    const plan = lpTx ? await applyLevelPassReversal(tx, order, lpTx, input) : null;

    await tx.insert(financialLedgerEntries).values({
      entryType: 'order_refund',
      amountCents: -order.priceMxnCents,
      occurredAt: new Date(),
      seasonId: lpTx?.seasonId ?? null,
      sourceType: 'order',
      sourceId: order.id,
      note: input.reason,
      createdByAdminId: input.adminUserId,
    });

    await tx.insert(auditLog).values({
      adminUserId: input.adminUserId,
      action: 'order.reverse',
      entityType: 'order',
      entityId: order.id,
      detail: { reason: input.reason, refundedCents: order.priceMxnCents, plan },
    });

    return { ok: true, plan, refundedCents: order.priceMxnCents } as const;
  });
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function applyLevelPassReversal(
  tx: Tx,
  order: { id: string; playerId: string },
  lpTx: typeof levelPassLpTransactions.$inferSelect,
  input: ReverseOrderInput,
): Promise<OrderReversalPlan> {
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

  const { diamonds, rankingDiamonds } = await resolveDiamonds(tx, order, lpTx);

  const checkpointRows = await tx
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

  const plan = planOrderReversal({
    awardedLp: lpTx.awardedLp,
    diamonds,
    rankingDiamonds,
    currentLp: stats?.lp ?? 0,
    checkpoints: checkpointRows.map(
      (row): ReversibleCheckpoint => ({
        checkpointEventId: row.checkpointEventId,
        checkpointLp: row.checkpointLp,
        status: row.status,
        rewardOrderPlaced: row.rewardOrderId !== null,
      }),
    ),
    vaultUnlocked: vault !== undefined,
  });

  await tx
    .update(levelPassLpTransactions)
    .set({
      reversedAt: new Date(),
      reversedByAdminId: input.adminUserId,
      reversalReason: input.reason,
    })
    .where(eq(levelPassLpTransactions.id, lpTx.id));

  // GREATEST(…, 0) in SQL rather than writing the computed value back: another
  // order completing between the read above and this write would otherwise be
  // clobbered by a stale total.
  await tx
    .update(seasonPlayerStats)
    .set({
      lp: sql`GREATEST(${seasonPlayerStats.lp} - ${plan.lpRemoved}, 0)`,
      seasonalDiamonds: sql`GREATEST(${seasonPlayerStats.seasonalDiamonds} - ${plan.rankingDiamondsRemoved}, 0)`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(seasonPlayerStats.seasonId, lpTx.seasonId),
        eq(seasonPlayerStats.playerProfileId, lpTx.playerProfileId),
      ),
    );

  await tx
    .update(playerProfiles)
    .set({
      lifetimeDiamondsPurchased: sql`GREATEST(${playerProfiles.lifetimeDiamondsPurchased} - ${plan.diamondsRemoved}, 0)`,
      lifetimeRechargeCount: sql`GREATEST(${playerProfiles.lifetimeRechargeCount} - 1, 0)`,
      updatedAt: sql`now()`,
    })
    .where(eq(playerProfiles.id, lpTx.playerProfileId));

  for (const eventId of plan.checkpointEventIdsToReverse) {
    await tx
      .update(levelPassCheckpointEvents)
      .set({ status: 'reversed', reason: input.reason })
      .where(
        and(
          eq(levelPassCheckpointEvents.id, eventId),
          // Still pending at write time — a reward delivered in the meantime
          // must keep its granted status and its recorded expense.
          eq(levelPassCheckpointEvents.status, 'pending'),
        ),
      );
  }

  if (plan.closeVault && vault) {
    await tx
      .update(vaultEntitlements)
      .set({ status: 'expired' })
      .where(eq(vaultEntitlements.id, vault.id));
  }

  return plan;
}

/**
 * What the order actually added to the diamond counters.
 *
 * Rows written since the reversal feature exists record both figures, so the
 * reversal subtracts precisely what was credited. Older rows predate those
 * columns and are derived instead: delivered diamonds from the items, and the
 * ranking share from whether the top-up went to the player's linked ID. That
 * derivation can disagree with history if the player has since changed their
 * linked ID — unavoidable for rows that never stored it, and the reason the
 * columns exist.
 */
async function resolveDiamonds(
  tx: Tx,
  order: { id: string; playerId: string },
  lpTx: typeof levelPassLpTransactions.$inferSelect,
): Promise<{ diamonds: number; rankingDiamonds: number }> {
  if (lpTx.diamonds !== null && lpTx.rankingDiamonds !== null) {
    return { diamonds: lpTx.diamonds, rankingDiamonds: lpTx.rankingDiamonds };
  }

  const [delivered] = await tx
    .select({ diamonds: sql<string>`COALESCE(SUM(${orderItems.diamondsBase}), 0)::text` })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, order.id), eq(orderItems.status, 'succeeded')));
  const diamonds = Number(delivered?.diamonds ?? 0);

  const [profile] = await tx
    .select({ playerId: playerProfiles.playerId })
    .from(playerProfiles)
    .where(eq(playerProfiles.id, lpTx.playerProfileId))
    .limit(1);

  return {
    diamonds,
    rankingDiamonds: profile?.playerId === order.playerId ? diamonds : 0,
  };
}
