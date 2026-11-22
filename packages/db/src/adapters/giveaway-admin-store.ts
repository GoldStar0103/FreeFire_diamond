/**
 * Admin-facing CRUD + lifecycle transitions for Golden Tickets giveaways.
 *
 * Mirrors `item-catalog-admin-store.ts`'s shape (constructor takes a
 * `Database`, every write takes an `adminUserId`). `closeDueGiveaways` is the
 * sweep-step body the worker's `runGiveawayDraws` calls every tick: it closes
 * a past-due giveaway and, the moment it meets its minimum AND already has a
 * `prizeValueCents` set, draws the winner(s) in the same pass — no admin
 * click needed (per the client's request to stop waiting on a manual draw).
 * If `prizeValueCents` hasn't been set yet, it falls back to leaving the
 * giveaway in `closed_pending_draw` for a manual `drawWinners` call — the
 * one thing a missing prize value still requires. `drawWinners` itself stays
 * public/admin-callable for that fallback and for re-running a draw by hand;
 * both paths share the same `drawWinnersInTx` winner-picking logic so a
 * giveaway is decided identically either way. It can pick several winners
 * (`giveaways.winnerCount`), per the client's request.
 *
 * This class also implements `GiveawayPrizeDeliveryStore` (the "automatic
 * diamond-prize delivery" half, see `giveaway-prize-delivery.ts`) — same
 * dual-interface shape `DrizzleLevelPassStore` already uses for Level Pass
 * reward delivery, reusing one store instance rather than splitting a
 * tightly-related set of writes across two classes.
 */

import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import {
  defaultOrderNumber,
  meetsMinimum,
  pickWinners,
  GIVEAWAY_PRIZE_COMBO_KEY,
  type GiveawayPrizeDeliveryStore,
  type GrantableGiveawayPrize,
  type PendingGiveawayWinner,
  type ResolvedGiveawayPrizeCatalogEntry,
  type ResolvedGiveawayPrizeItem,
} from '@levelup/engine';
import { parseUsd } from '@levelup/provider';
import type { Database } from '../index.js';
import {
  baseProducts,
  financialLedgerEntries,
  giveawayEntries,
  giveaways,
  giveawayWinners,
  notifications,
  orderItems,
  orders,
  playerProfiles,
  seasons,
  ticketTransactions,
} from '../schema.js';
import { toNumericString } from './mapping.js';

export type GiveawayStatus = 'draft' | 'open' | 'closed_pending_draw' | 'drawn' | 'delivered' | 'cancelled';
export type GiveawayScheduleType = 'daily' | 'weekly' | 'monthly' | 'flash';
export type GiveawayPrizeType = 'manual' | 'diamonds';
export type GiveawayWinnerDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface GiveawayAdminRow {
  id: string;
  title: string;
  description: string;
  prizeDescription: string;
  prizeValueCents: number | null;
  entryCostTickets: number;
  scheduleType: GiveawayScheduleType;
  minEntries: number;
  maxEntriesPerPlayer: number | null;
  maxParticipants: number | null;
  winnerCount: number;
  prizeType: GiveawayPrizeType;
  prizeDiamonds: number | null;
  opensAt: Date;
  closesAt: Date;
  status: GiveawayStatus;
  drawnAt: Date | null;
  cancelReason: string | null;
  totalEntryCount: number;
  totalEntrants: number;
  createdAt: Date;
}

export interface GiveawayEntryAdminRow {
  playerProfileId: string;
  playerId: string;
  playerDisplayName: string | null;
  entryCount: number;
  ticketsSpent: number;
  createdAt: Date;
}

export interface GiveawayWinnerAdminRow {
  id: string;
  playerProfileId: string;
  playerId: string;
  playerDisplayName: string | null;
  freeFireId: string;
  position: number;
  costCentsSnapshot: number;
  deliveryStatus: GiveawayWinnerDeliveryStatus;
  deliveryNote: string | null;
  deliveredAt: Date | null;
}

export interface CreateGiveawayInput {
  title: string;
  description: string;
  prizeDescription: string;
  prizeValueCents?: number | null;
  entryCostTickets: number;
  scheduleType: GiveawayScheduleType;
  minEntries: number;
  maxEntriesPerPlayer?: number | null;
  maxParticipants?: number | null;
  winnerCount: number;
  prizeType: GiveawayPrizeType;
  prizeDiamonds?: number | null;
  /** Already-resolved recipe (baseProductId pinned) — see `resolveGiveawayPrizeRecipe` for how a plain denomination draft becomes this. */
  prizeRecipe?: { baseProductId: string; diamondsBase: number }[] | null;
  opensAt: Date;
  closesAt: Date;
}

const ADMIN_ROW_SELECTION = {
  id: giveaways.id,
  title: giveaways.title,
  description: giveaways.description,
  prizeDescription: giveaways.prizeDescription,
  prizeValueCents: giveaways.prizeValueCents,
  entryCostTickets: giveaways.entryCostTickets,
  scheduleType: giveaways.scheduleType,
  minEntries: giveaways.minEntries,
  maxEntriesPerPlayer: giveaways.maxEntriesPerPlayer,
  maxParticipants: giveaways.maxParticipants,
  winnerCount: giveaways.winnerCount,
  prizeType: giveaways.prizeType,
  prizeDiamonds: giveaways.prizeDiamonds,
  opensAt: giveaways.opensAt,
  closesAt: giveaways.closesAt,
  status: giveaways.status,
  drawnAt: giveaways.drawnAt,
  cancelReason: giveaways.cancelReason,
  createdAt: giveaways.createdAt,
};

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type RefundEntrant = { playerProfileId: string; ticketsSpent: number };

/**
 * Every winner of a giveaway resolved and delivered, so it's safe to show
 * "premio entregado" at the giveaway level — mirrors `grantReward`'s
 * idempotency discipline: a no-op update (zero rows, `status = 'drawn'`
 * already not true) when another process finalized it first.
 */
async function maybeFinalizeGiveaway(tx: Tx, giveawayId: string): Promise<void> {
  const [row] = await tx
    .select({
      total: sql<string>`count(*)`,
      delivered: sql<string>`count(*) filter (where ${giveawayWinners.deliveryStatus} = 'delivered')`,
    })
    .from(giveawayWinners)
    .where(eq(giveawayWinners.giveawayId, giveawayId));
  if (row && Number(row.total) > 0 && Number(row.total) === Number(row.delivered)) {
    await tx
      .update(giveaways)
      .set({ status: 'delivered', updatedAt: sql`now()` })
      .where(and(eq(giveaways.id, giveawayId), eq(giveaways.status, 'drawn')));
  }
}

export class DrizzleGiveawayAdminStore implements GiveawayPrizeDeliveryStore {
  constructor(private readonly db: Database) {}

  async listForAdmin(): Promise<GiveawayAdminRow[]> {
    const rows = await this.db
      .select({
        ...ADMIN_ROW_SELECTION,
        totalEntryCount: sql<string>`coalesce(sum(${giveawayEntries.entryCount}), 0)`,
        totalEntrants: sql<string>`count(${giveawayEntries.id})`,
      })
      .from(giveaways)
      .leftJoin(giveawayEntries, eq(giveawayEntries.giveawayId, giveaways.id))
      .groupBy(
        giveaways.id,
        giveaways.title,
        giveaways.description,
        giveaways.prizeDescription,
        giveaways.prizeValueCents,
        giveaways.entryCostTickets,
        giveaways.scheduleType,
        giveaways.minEntries,
        giveaways.maxEntriesPerPlayer,
        giveaways.maxParticipants,
        giveaways.winnerCount,
        giveaways.prizeType,
        giveaways.prizeDiamonds,
        giveaways.opensAt,
        giveaways.closesAt,
        giveaways.status,
        giveaways.drawnAt,
        giveaways.cancelReason,
        giveaways.createdAt,
      )
      .orderBy(desc(giveaways.createdAt));

    return rows.map((r) => ({
      ...r,
      totalEntryCount: Number(r.totalEntryCount),
      totalEntrants: Number(r.totalEntrants),
    }));
  }

  async getForAdmin(id: string): Promise<GiveawayAdminRow | null> {
    const [row] = await this.db.select(ADMIN_ROW_SELECTION).from(giveaways).where(eq(giveaways.id, id)).limit(1);
    if (!row) return null;

    const [agg] = await this.db
      .select({
        totalEntryCount: sql<string>`coalesce(sum(${giveawayEntries.entryCount}), 0)`,
        totalEntrants: sql<string>`count(${giveawayEntries.id})`,
      })
      .from(giveawayEntries)
      .where(eq(giveawayEntries.giveawayId, id));
    const { totalEntryCount, totalEntrants } = agg!;

    return { ...row, totalEntryCount: Number(totalEntryCount), totalEntrants: Number(totalEntrants) };
  }

  async listEntries(giveawayId: string): Promise<GiveawayEntryAdminRow[]> {
    return this.db
      .select({
        playerProfileId: giveawayEntries.playerProfileId,
        playerId: playerProfiles.playerId,
        playerDisplayName: playerProfiles.displayName,
        entryCount: giveawayEntries.entryCount,
        ticketsSpent: giveawayEntries.ticketsSpent,
        createdAt: giveawayEntries.createdAt,
      })
      .from(giveawayEntries)
      .innerJoin(playerProfiles, eq(playerProfiles.id, giveawayEntries.playerProfileId))
      .where(eq(giveawayEntries.giveawayId, giveawayId))
      .orderBy(desc(giveawayEntries.entryCount));
  }

  async listWinners(giveawayId: string): Promise<GiveawayWinnerAdminRow[]> {
    return this.db
      .select({
        id: giveawayWinners.id,
        playerProfileId: giveawayWinners.playerProfileId,
        playerId: playerProfiles.playerId,
        playerDisplayName: playerProfiles.displayName,
        freeFireId: giveawayWinners.freeFireId,
        position: giveawayWinners.position,
        costCentsSnapshot: giveawayWinners.costCentsSnapshot,
        deliveryStatus: giveawayWinners.deliveryStatus,
        deliveryNote: giveawayWinners.deliveryNote,
        deliveredAt: giveawayWinners.deliveredAt,
      })
      .from(giveawayWinners)
      .innerJoin(playerProfiles, eq(playerProfiles.id, giveawayWinners.playerProfileId))
      .where(eq(giveawayWinners.giveawayId, giveawayId))
      .orderBy(giveawayWinners.position);
  }

  /**
   * Resolves a plain-denomination prize recipe draft to real `base_products`
   * rows, exactly like `saveLevelPassCheckpoints` does for a Level Pass
   * checkpoint — only ever called for `prizeType = 'diamonds'`. Throws (the
   * caller surfaces it as a validation error) rather than silently pinning a
   * denomination the provider no longer sells.
   */
  async resolveGiveawayPrizeRecipe(
    diamondsBase: number[],
  ): Promise<{ baseProductId: string; diamondsBase: number }[]> {
    const products = await this.db
      .select({ id: baseProducts.id, diamondsBase: baseProducts.diamondsBase })
      .from(baseProducts)
      .where(eq(baseProducts.active, true));

    const byDenomination = new Map<number, string>();
    for (const p of products) {
      if (!byDenomination.has(p.diamondsBase)) byDenomination.set(p.diamondsBase, p.id);
    }

    const missing = new Set<number>();
    const recipe = diamondsBase.map((d) => {
      const baseProductId = byDenomination.get(d);
      if (!baseProductId) missing.add(d);
      return { baseProductId: baseProductId ?? '', diamondsBase: d };
    });

    if (missing.size > 0) {
      throw new Error(`No hay producto activo del proveedor para: ${[...missing].join(', ')}`);
    }

    return recipe;
  }

  async create(input: CreateGiveawayInput, adminUserId: string): Promise<string> {
    const [row] = await this.db
      .insert(giveaways)
      .values({ ...input, createdByAdminId: adminUserId })
      .returning({ id: giveaways.id });
    return row!.id;
  }

  /** Only permitted while `status = 'draft'` — once published, entries may already depend on these values. */
  async update(id: string, input: Partial<CreateGiveawayInput>, _adminUserId: string): Promise<boolean> {
    const updated = await this.db
      .update(giveaways)
      .set({ ...input, updatedAt: sql`now()` })
      .where(and(eq(giveaways.id, id), eq(giveaways.status, 'draft')))
      .returning({ id: giveaways.id });
    return updated.length > 0;
  }

  async publish(id: string, _adminUserId: string): Promise<boolean> {
    const updated = await this.db
      .update(giveaways)
      .set({ status: 'open', updatedAt: sql`now()` })
      .where(and(eq(giveaways.id, id), eq(giveaways.status, 'draft')))
      .returning({ id: giveaways.id });
    return updated.length > 0;
  }

  /**
   * The scheduling feature the client asked for: a draft saved with a future
   * `opensAt` publishes itself once that time arrives, no manual "Publicar"
   * click needed. System-triggered (no `adminUserId` — whoever drafted it
   * keeps `createdByAdminId`), called from the worker's sweep loop right next
   * to `closeDueGiveaways`. The `status = 'draft'` clause is the same
   * idempotency guard every other sweep step in this file relies on.
   */
  async autoPublishDue(now: Date): Promise<number> {
    const updated = await this.db
      .update(giveaways)
      .set({ status: 'open', updatedAt: sql`now()` })
      .where(and(eq(giveaways.status, 'draft'), lte(giveaways.opensAt, now), gt(giveaways.closesAt, now)))
      .returning({ id: giveaways.id });
    return updated.length;
  }

  /**
   * The sweep-step body: every `open` giveaway past `closesAt` either gets
   * drawn immediately (minimum met AND a `prizeValueCents` is already set —
   * the one precondition `drawWinnersInTx` enforces), left in
   * `closed_pending_draw` awaiting a manual draw (minimum met but no prize
   * value yet), or `cancelled` with every entrant refunded (minimum not
   * met). The `status = 'open'` clause in each UPDATE's WHERE is the
   * idempotency guard against a racing/duplicate sweep tick processing the
   * same giveaway twice — same pattern `expireOverduePayments` already
   * relies on. `random` is injected (defaults to `Math.random`) purely so
   * tests can assert exact winners, same convention `drawWinners` uses.
   */
  async closeDueGiveaways(
    now: Date,
    random: () => number = Math.random,
  ): Promise<{ closedPendingDraw: number; autoDrawn: number; cancelledAndRefunded: number }> {
    const due = await this.db
      .select({ id: giveaways.id, minEntries: giveaways.minEntries })
      .from(giveaways)
      .where(and(eq(giveaways.status, 'open'), lte(giveaways.closesAt, now)));

    let closedPendingDraw = 0;
    let autoDrawn = 0;
    let cancelledAndRefunded = 0;

    for (const g of due) {
      const [totalRow] = await this.db
        .select({ total: sql<string>`coalesce(sum(${giveawayEntries.entryCount}), 0)` })
        .from(giveawayEntries)
        .where(eq(giveawayEntries.giveawayId, g.id));
      const totalEntries = Number(totalRow!.total);

      if (meetsMinimum(g.minEntries, totalEntries)) {
        const outcome = await this.db.transaction(async (tx) => {
          const updated = await tx
            .update(giveaways)
            .set({ status: 'closed_pending_draw', updatedAt: sql`now()` })
            .where(and(eq(giveaways.id, g.id), eq(giveaways.status, 'open')))
            .returning({
              id: giveaways.id,
              title: giveaways.title,
              prizeDescription: giveaways.prizeDescription,
              winnerCount: giveaways.winnerCount,
              prizeValueCents: giveaways.prizeValueCents,
            });
          if (updated.length === 0) return 'raced' as const;

          const giveaway = updated[0]!;
          if (giveaway.prizeValueCents == null) return 'awaiting_prize_value' as const;

          const winnerCount = await drawWinnersInTx(
            tx,
            { ...giveaway, prizeValueCents: giveaway.prizeValueCents },
            null,
            random,
          );
          return winnerCount > 0 ? ('auto_drawn' as const) : ('awaiting_prize_value' as const);
        });

        if (outcome === 'auto_drawn') autoDrawn++;
        else if (outcome === 'awaiting_prize_value') closedPendingDraw++;
        continue;
      }

      const refunded = await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(giveaways)
          .set({
            status: 'cancelled',
            cancelReason: 'No alcanzó el mínimo de participantes',
            updatedAt: sql`now()`,
          })
          .where(and(eq(giveaways.id, g.id), eq(giveaways.status, 'open')))
          .returning({ id: giveaways.id });
        if (updated.length === 0) return false;

        const entrants = await tx
          .select({ playerProfileId: giveawayEntries.playerProfileId, ticketsSpent: giveawayEntries.ticketsSpent })
          .from(giveawayEntries)
          .where(eq(giveawayEntries.giveawayId, g.id));

        await refundEntrants(tx, g.id, entrants, 'El sorteo no alcanzó el mínimo de participantes.');
        return true;
      });
      if (refunded) cancelledAndRefunded++;
    }

    return { closedPendingDraw, autoDrawn, cancelledAndRefunded };
  }

  /** Manual cancel — any state before `drawn`. Refunds every entrant exactly like the below-minimum auto-cancel. */
  async cancel(id: string, _adminUserId: string, reason: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(giveaways)
        .set({ status: 'cancelled', cancelReason: reason, updatedAt: sql`now()` })
        .where(and(eq(giveaways.id, id), inArray(giveaways.status, ['draft', 'open', 'closed_pending_draw'])))
        .returning({ id: giveaways.id });
      if (updated.length === 0) return false;

      const entrants = await tx
        .select({ playerProfileId: giveawayEntries.playerProfileId, ticketsSpent: giveawayEntries.ticketsSpent })
        .from(giveawayEntries)
        .where(eq(giveawayEntries.giveawayId, id));

      await refundEntrants(tx, id, entrants, reason);
      return true;
    });
  }

  /**
   * Admin-callable fallback/re-run path — also what `closeDueGiveaways` uses
   * internally (via `drawWinnersInTx`) to draw automatically the moment a
   * giveaway closes with a prize value already set. Draws up to
   * `giveaways.winnerCount` distinct winners (`pickWinners`, no
   * replacement). Requires `prizeValueCents` to already be set — for a
   * `diamonds`-type giveaway there is no later manual confirmation step to
   * gate on (delivery is automatic), so this is the one point before the
   * draw that must enforce it for both prize types alike.
   */
  async drawWinners(
    id: string,
    adminUserId: string,
    random: () => number = Math.random,
  ): Promise<
    | { ok: true; winnerCount: number }
    | { ok: false; reason: 'not_found' | 'wrong_status' | 'no_entries' | 'prize_value_required' }
  > {
    return this.db.transaction(async (tx) => {
      const [giveaway] = await tx
        .select({
          id: giveaways.id,
          status: giveaways.status,
          title: giveaways.title,
          prizeDescription: giveaways.prizeDescription,
          winnerCount: giveaways.winnerCount,
          prizeValueCents: giveaways.prizeValueCents,
        })
        .from(giveaways)
        .where(eq(giveaways.id, id))
        .limit(1);
      if (!giveaway) return { ok: false, reason: 'not_found' as const };
      if (giveaway.status !== 'closed_pending_draw') return { ok: false, reason: 'wrong_status' as const };
      if (giveaway.prizeValueCents == null) return { ok: false, reason: 'prize_value_required' as const };

      const winnerCount = await drawWinnersInTx(
        tx,
        { ...giveaway, prizeValueCents: giveaway.prizeValueCents },
        adminUserId,
        random,
      );
      if (winnerCount === 0) return { ok: false, reason: 'no_entries' as const };

      return { ok: true, winnerCount };
    });
  }

  /** Any status except `delivered` — editing after a draw only affects a FUTURE giveaway's snapshot, never an already-drawn one (see `costCentsSnapshot`). */
  async setPrizeValueCents(id: string, prizeValueCents: number, _adminUserId: string): Promise<boolean> {
    const updated = await this.db
      .update(giveaways)
      .set({ prizeValueCents, updatedAt: sql`now()` })
      .where(and(eq(giveaways.id, id), ne(giveaways.status, 'delivered')))
      .returning({ id: giveaways.id });
    return updated.length > 0;
  }

  /**
   * Manual delivery confirmation for ONE winner of a `prizeType = 'manual'`
   * giveaway — `diamonds`-type winners are never marked this way, they go
   * through the automatic `grantGiveawayPrize` path instead. Posts that
   * winner's frozen `costCentsSnapshot` to the ledger (same
   * `financialLedgerEntries` convention `level-pass-store.ts`'s `grantReward`
   * uses), then finalizes the giveaway once every winner is delivered.
   */
  async markWinnerDelivered(
    giveawayId: string,
    winnerId: string,
    adminUserId: string,
  ): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'already_delivered' }> {
    return this.db.transaction(async (tx) => {
      const [winner] = await tx
        .select({ costCentsSnapshot: giveawayWinners.costCentsSnapshot, deliveryStatus: giveawayWinners.deliveryStatus })
        .from(giveawayWinners)
        .where(and(eq(giveawayWinners.id, winnerId), eq(giveawayWinners.giveawayId, giveawayId)))
        .limit(1);
      if (!winner) return { ok: false, reason: 'not_found' as const };

      const updated = await tx
        .update(giveawayWinners)
        .set({ deliveryStatus: 'delivered', deliveredAt: sql`now()` })
        .where(and(eq(giveawayWinners.id, winnerId), eq(giveawayWinners.deliveryStatus, 'pending')))
        .returning({ id: giveawayWinners.id });
      if (updated.length === 0) return { ok: false, reason: 'already_delivered' as const };

      const [giveaway] = await tx
        .select({ title: giveaways.title, prizeDescription: giveaways.prizeDescription })
        .from(giveaways)
        .where(eq(giveaways.id, giveawayId))
        .limit(1);

      const now = new Date();
      const [season] = await tx
        .select({ id: seasons.id })
        .from(seasons)
        .where(and(lt(seasons.startsAt, now), gte(seasons.endsAt, now)))
        .orderBy(desc(seasons.seasonNumber))
        .limit(1);

      await tx.insert(financialLedgerEntries).values({
        entryType: 'giveaway_prize',
        amountCents: -winner.costCentsSnapshot,
        occurredAt: now,
        seasonId: season?.id ?? null,
        sourceType: 'giveaway',
        sourceId: giveawayId,
        note: `Premio entregado: "${giveaway?.title}" — ${giveaway?.prizeDescription}`,
        createdByAdminId: adminUserId,
      });

      await maybeFinalizeGiveaway(tx, giveawayId);

      return { ok: true };
    });
  }

  // ── automatic diamond-prize delivery (GiveawayPrizeDeliveryStore) ────────
  // Mirrors `DrizzleLevelPassStore`'s reward-delivery section almost exactly
  // — see `giveaway-prize-delivery.ts`'s module doc for why this reuses the
  // real order/fulfilment pipeline instead of a second delivery path.

  async findPendingGiveawayWinners(limit: number): Promise<PendingGiveawayWinner[]> {
    const rows = await this.db
      .select({
        winnerId: giveawayWinners.id,
        giveawayId: giveawayWinners.giveawayId,
        freeFireId: giveawayWinners.freeFireId,
        giveawayTitle: giveaways.title,
        prizeDiamonds: giveaways.prizeDiamonds,
        prizeRecipe: giveaways.prizeRecipe,
      })
      .from(giveawayWinners)
      .innerJoin(giveaways, eq(giveaways.id, giveawayWinners.giveawayId))
      .where(
        and(
          eq(giveaways.prizeType, 'diamonds'),
          eq(giveawayWinners.deliveryStatus, 'pending'),
          isNull(giveawayWinners.deliveryOrderId),
        ),
      )
      .limit(limit);

    return rows.map((r) => ({
      winnerId: r.winnerId,
      giveawayId: r.giveawayId,
      giveawayTitle: r.giveawayTitle,
      freeFireId: r.freeFireId,
      prizeDiamonds: r.prizeDiamonds ?? 0,
      recipe: r.prizeRecipe ?? [],
    }));
  }

  async resolveGiveawayPrizeCatalog(baseProductIds: string[]): Promise<ResolvedGiveawayPrizeCatalogEntry[]> {
    if (baseProductIds.length === 0) return [];
    const rows = await this.db
      .select({
        id: baseProducts.id,
        provider: baseProducts.provider,
        providerProductId: baseProducts.providerProductId,
        endpointKind: baseProducts.endpointKind,
        diamondsBase: baseProducts.diamondsBase,
        costUsd: baseProducts.costUsd,
        active: baseProducts.active,
      })
      .from(baseProducts)
      .where(inArray(baseProducts.id, baseProductIds));

    return rows.map((r) => ({
      baseProductId: r.id,
      provider: r.provider,
      providerProductId: r.providerProductId,
      endpointKind: r.endpointKind,
      diamondsBase: r.diamondsBase,
      costUsd: r.costUsd === null ? null : parseUsd(r.costUsd),
      active: r.active,
    }));
  }

  async createGiveawayPrizeOrder(
    winner: PendingGiveawayWinner,
    items: ResolvedGiveawayPrizeItem[],
  ): Promise<{ created: boolean; orderId: string; orderNumber: string }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const orderNumber = defaultOrderNumber();
      try {
        return await this.db.transaction(async (tx) => {
          const [winnerRow] = await tx
            .select({ playerProfileId: giveawayWinners.playerProfileId })
            .from(giveawayWinners)
            .where(eq(giveawayWinners.id, winner.winnerId))
            .limit(1);

          const [created] = await tx
            .insert(orders)
            .values({
              orderNumber,
              playerId: winner.freeFireId,
              playerProfileId: winnerRow?.playerProfileId ?? null,
              comboId: null,
              comboKey: GIVEAWAY_PRIZE_COMBO_KEY,
              comboSnapshot: {
                comboKey: GIVEAWAY_PRIZE_COMBO_KEY,
                name: `Premio de sorteo — ${winner.giveawayTitle}`,
                advertisedDiamonds: winner.prizeDiamonds,
                deliveredDiamonds: items.reduce((sum, i) => sum + i.diamondsBase, 0),
                recipe: items.map((i) => ({
                  sequence: i.sequence,
                  providerProductId: i.providerProductId,
                  diamondsBase: i.diamondsBase,
                  costUsd: toNumericString(i.costUsd),
                })),
                frozenAt: new Date().toISOString(),
              },
              priceMxnCents: 0,
              // Skips `pending_payment` entirely, same as a Level Pass reward
              // order — there is no payment to confirm. `paidAt` stays null on
              // purpose: the Meta CAPI sweep only scans orders where it is
              // set, so a prize can never be reported to Meta as a purchase.
              status: 'payment_confirmed',
            })
            .returning({ id: orders.id, orderNumber: orders.orderNumber });
          if (!created) throw new Error('Giveaway prize order insert returned no row');

          await tx.insert(orderItems).values(
            items.map((item) => ({
              orderId: created.id,
              sequence: item.sequence,
              baseProductId: item.baseProductId,
              provider: item.provider,
              providerProductId: item.providerProductId,
              diamondsBase: item.diamondsBase,
              costUsd: toNumericString(item.costUsd),
              status: 'queued' as const,
            })),
          );

          // The real idempotency guard: if another process already linked a
          // prize order onto this winner since we read it, this affects zero
          // rows and we throw to roll back the order/items just inserted
          // rather than leave an orphaned duplicate.
          const linked = await tx
            .update(giveawayWinners)
            .set({ deliveryOrderId: created.id })
            .where(and(eq(giveawayWinners.id, winner.winnerId), isNull(giveawayWinners.deliveryOrderId)))
            .returning({ id: giveawayWinners.id });

          if (linked.length === 0) {
            throw new Error(`Winner ${winner.winnerId} already has a prize order`);
          }

          return { created: true, orderId: created.id, orderNumber: created.orderNumber };
        });
      } catch (err) {
        if (
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === '23505' &&
          String(err).includes('orders_number_idx')
        ) {
          continue;
        }
        throw err;
      }
    }

    throw new Error('Could not allocate a unique order number after 5 attempts');
  }

  async findCompletedGiveawayPrizeOrders(limit: number): Promise<GrantableGiveawayPrize[]> {
    const rows = await this.db
      .select({
        winnerId: giveawayWinners.id,
        giveawayId: giveawayWinners.giveawayId,
        deliveryOrderId: giveawayWinners.deliveryOrderId,
        costCentsSnapshot: giveawayWinners.costCentsSnapshot,
      })
      .from(giveawayWinners)
      .innerJoin(orders, eq(orders.id, giveawayWinners.deliveryOrderId))
      .where(and(eq(giveawayWinners.deliveryStatus, 'pending'), eq(orders.status, 'completed')))
      .limit(limit);

    return rows.map((r) => ({
      winnerId: r.winnerId,
      giveawayId: r.giveawayId,
      // Safe: the inner join on `orders.id = delivery_order_id` requires it.
      deliveryOrderId: r.deliveryOrderId!,
      internalCostCents: r.costCentsSnapshot,
    }));
  }

  async grantGiveawayPrize(row: GrantableGiveawayPrize): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Idempotency guard: a second run after a process died between the
      // update and the ledger insert affects zero rows here and stops,
      // rather than double-recording the expense.
      const granted = await tx
        .update(giveawayWinners)
        .set({ deliveryStatus: 'delivered', deliveredAt: sql`now()` })
        .where(and(eq(giveawayWinners.id, row.winnerId), eq(giveawayWinners.deliveryStatus, 'pending')))
        .returning({ id: giveawayWinners.id });
      if (granted.length === 0) return;

      const [giveaway] = await tx
        .select({ title: giveaways.title, prizeDescription: giveaways.prizeDescription })
        .from(giveaways)
        .where(eq(giveaways.id, row.giveawayId))
        .limit(1);

      const now = new Date();
      const [season] = await tx
        .select({ id: seasons.id })
        .from(seasons)
        .where(and(lt(seasons.startsAt, now), gte(seasons.endsAt, now)))
        .orderBy(desc(seasons.seasonNumber))
        .limit(1);

      await tx.insert(financialLedgerEntries).values({
        entryType: 'giveaway_prize',
        amountCents: -row.internalCostCents,
        occurredAt: now,
        seasonId: season?.id ?? null,
        sourceType: 'giveaway',
        sourceId: row.giveawayId,
        note: `Premio entregado automáticamente: "${giveaway?.title}" — ${giveaway?.prizeDescription}`,
      });

      await maybeFinalizeGiveaway(tx, row.giveawayId);
    });
  }
}

type DrawableGiveaway = {
  id: string;
  title: string;
  prizeDescription: string;
  winnerCount: number;
  prizeValueCents: number;
};

/**
 * The actual winner-picking write, shared by `drawWinners` (admin-triggered)
 * and `closeDueGiveaways` (automatic, right after close). `adminUserId` is
 * `null` for an automatic draw — `giveaways.drawnByAdminId` is nullable for
 * exactly this. Returns the number of distinct winners actually drawn (0 for
 * an empty entry pool); callers decide what that means for their own result
 * shape rather than this helper picking an error reason for them.
 */
async function drawWinnersInTx(
  tx: Tx,
  giveaway: DrawableGiveaway,
  adminUserId: string | null,
  random: () => number,
): Promise<number> {
  const entries = await tx
    .select({
      playerProfileId: giveawayEntries.playerProfileId,
      entryCount: giveawayEntries.entryCount,
      freeFireId: giveawayEntries.freeFireId,
      fallbackPlayerId: playerProfiles.playerId,
    })
    .from(giveawayEntries)
    .innerJoin(playerProfiles, eq(playerProfiles.id, giveawayEntries.playerProfileId))
    .where(eq(giveawayEntries.giveawayId, giveaway.id));

  const winnerIds = pickWinners(entries, giveaway.winnerCount, random);
  if (winnerIds.length === 0) return 0;

  const byPlayer = new Map(entries.map((e) => [e.playerProfileId, e]));

  await tx
    .update(giveaways)
    .set({ status: 'drawn', drawnAt: sql`now()`, drawnByAdminId: adminUserId, updatedAt: sql`now()` })
    .where(eq(giveaways.id, giveaway.id));

  for (let i = 0; i < winnerIds.length; i++) {
    const playerProfileId = winnerIds[i]!;
    const entry = byPlayer.get(playerProfileId);

    await tx.insert(giveawayWinners).values({
      giveawayId: giveaway.id,
      playerProfileId,
      freeFireId: entry?.freeFireId ?? entry?.fallbackPlayerId ?? '',
      position: i + 1,
      costCentsSnapshot: giveaway.prizeValueCents,
    });

    await tx.insert(notifications).values({
      playerProfileId,
      type: 'giveaway_won',
      title: '¡Ganaste un sorteo!',
      message: `Ganaste "${giveaway.title}": ${giveaway.prizeDescription}`,
      targetUrl: `/sorteos/${giveaway.id}`,
    });
  }

  return winnerIds.length;
}

async function refundEntrants(
  tx: Tx,
  giveawayId: string,
  entrants: RefundEntrant[],
  cancelMessage: string,
): Promise<void> {
  for (const entrant of entrants) {
    const [profileAfter] = await tx
      .update(playerProfiles)
      .set({ ticketBalance: sql`${playerProfiles.ticketBalance} + ${entrant.ticketsSpent}`, updatedAt: sql`now()` })
      .where(eq(playerProfiles.id, entrant.playerProfileId))
      .returning({ ticketBalance: playerProfiles.ticketBalance });

    await tx.insert(ticketTransactions).values({
      playerProfileId: entrant.playerProfileId,
      type: 'return',
      amount: entrant.ticketsSpent,
      resultingBalance: profileAfter!.ticketBalance,
      giveawayId,
    });

    await tx.insert(notifications).values({
      playerProfileId: entrant.playerProfileId,
      type: 'giveaway_cancelled',
      title: 'Sorteo cancelado',
      message: `${cancelMessage} Te devolvimos ${entrant.ticketsSpent} tickets.`,
      targetUrl: '/sorteos',
    });
  }
}
