/**
 * Admin-facing CRUD + lifecycle transitions for Golden Tickets giveaways.
 *
 * Mirrors `item-catalog-admin-store.ts`'s shape (constructor takes a
 * `Database`, every write takes an `adminUserId`). `closeDueGiveaways` is the
 * sweep-step body the worker's `runGiveawayDraws` calls every tick — it only
 * ever closes-for-draw or cancels-and-refunds, never picks a winner.
 * `drawWinner` is admin-triggered only, never called from the worker (see
 * the plan's "admin-triggered draw" decision).
 */

import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { meetsMinimum, pickWinner } from '@levelup/engine';
import type { Database } from '../index.js';
import { giveawayEntries, giveaways, notifications, playerProfiles, ticketTransactions } from '../schema.js';

export type GiveawayStatus = 'draft' | 'open' | 'closed_pending_draw' | 'drawn' | 'delivered' | 'cancelled';
export type GiveawayScheduleType = 'daily' | 'weekly' | 'monthly' | 'flash';

export interface GiveawayAdminRow {
  id: string;
  title: string;
  description: string;
  prizeDescription: string;
  entryCostTickets: number;
  scheduleType: GiveawayScheduleType;
  minEntries: number;
  maxEntriesPerPlayer: number | null;
  maxParticipants: number | null;
  opensAt: Date;
  closesAt: Date;
  status: GiveawayStatus;
  winnerPlayerProfileId: string | null;
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

export interface CreateGiveawayInput {
  title: string;
  description: string;
  prizeDescription: string;
  entryCostTickets: number;
  scheduleType: GiveawayScheduleType;
  minEntries: number;
  maxEntriesPerPlayer?: number | null;
  maxParticipants?: number | null;
  opensAt: Date;
  closesAt: Date;
}

const ADMIN_ROW_SELECTION = {
  id: giveaways.id,
  title: giveaways.title,
  description: giveaways.description,
  prizeDescription: giveaways.prizeDescription,
  entryCostTickets: giveaways.entryCostTickets,
  scheduleType: giveaways.scheduleType,
  minEntries: giveaways.minEntries,
  maxEntriesPerPlayer: giveaways.maxEntriesPerPlayer,
  maxParticipants: giveaways.maxParticipants,
  opensAt: giveaways.opensAt,
  closesAt: giveaways.closesAt,
  status: giveaways.status,
  winnerPlayerProfileId: giveaways.winnerPlayerProfileId,
  drawnAt: giveaways.drawnAt,
  cancelReason: giveaways.cancelReason,
  createdAt: giveaways.createdAt,
};

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type RefundEntrant = { playerProfileId: string; ticketsSpent: number };

export class DrizzleGiveawayAdminStore {
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
        giveaways.entryCostTickets,
        giveaways.scheduleType,
        giveaways.minEntries,
        giveaways.maxEntriesPerPlayer,
        giveaways.maxParticipants,
        giveaways.opensAt,
        giveaways.closesAt,
        giveaways.status,
        giveaways.winnerPlayerProfileId,
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
   * The sweep-step body: every `open` giveaway past `closesAt` either moves
   * to `closed_pending_draw` (minimum met, awaiting an admin's draw action)
   * or `cancelled` with every entrant refunded (minimum not met). The
   * `status = 'open'` clause in each UPDATE's WHERE is the idempotency
   * guard against a racing/duplicate sweep tick processing the same giveaway
   * twice — same pattern `expireOverduePayments` already relies on.
   */
  async closeDueGiveaways(now: Date): Promise<{ closedPendingDraw: number; cancelledAndRefunded: number }> {
    const due = await this.db
      .select({ id: giveaways.id, minEntries: giveaways.minEntries })
      .from(giveaways)
      .where(and(eq(giveaways.status, 'open'), lte(giveaways.closesAt, now)));

    let closedPendingDraw = 0;
    let cancelledAndRefunded = 0;

    for (const g of due) {
      const [totalRow] = await this.db
        .select({ total: sql<string>`coalesce(sum(${giveawayEntries.entryCount}), 0)` })
        .from(giveawayEntries)
        .where(eq(giveawayEntries.giveawayId, g.id));
      const totalEntries = Number(totalRow!.total);

      if (meetsMinimum(g.minEntries, totalEntries)) {
        const updated = await this.db
          .update(giveaways)
          .set({ status: 'closed_pending_draw', updatedAt: sql`now()` })
          .where(and(eq(giveaways.id, g.id), eq(giveaways.status, 'open')))
          .returning({ id: giveaways.id });
        if (updated.length > 0) closedPendingDraw++;
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

    return { closedPendingDraw, cancelledAndRefunded };
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

  /** Admin-triggered only — never called from the worker's sweep loop. */
  async drawWinner(
    id: string,
    adminUserId: string,
    random: () => number = Math.random,
  ): Promise<{ ok: true; winnerPlayerProfileId: string } | { ok: false; reason: 'not_found' | 'wrong_status' | 'no_entries' }> {
    return this.db.transaction(async (tx) => {
      const [giveaway] = await tx
        .select({ id: giveaways.id, status: giveaways.status, title: giveaways.title, prizeDescription: giveaways.prizeDescription })
        .from(giveaways)
        .where(eq(giveaways.id, id))
        .limit(1);
      if (!giveaway) return { ok: false, reason: 'not_found' as const };
      if (giveaway.status !== 'closed_pending_draw') return { ok: false, reason: 'wrong_status' as const };

      const entries = await tx
        .select({ playerProfileId: giveawayEntries.playerProfileId, entryCount: giveawayEntries.entryCount })
        .from(giveawayEntries)
        .where(eq(giveawayEntries.giveawayId, id));

      const winnerPlayerProfileId = pickWinner(entries, random);
      if (!winnerPlayerProfileId) return { ok: false, reason: 'no_entries' as const };

      await tx
        .update(giveaways)
        .set({
          status: 'drawn',
          winnerPlayerProfileId,
          drawnAt: sql`now()`,
          drawnByAdminId: adminUserId,
          updatedAt: sql`now()`,
        })
        .where(eq(giveaways.id, id));

      await tx.insert(notifications).values({
        playerProfileId: winnerPlayerProfileId,
        type: 'giveaway_won',
        title: '¡Ganaste un sorteo!',
        message: `Ganaste "${giveaway.title}": ${giveaway.prizeDescription}`,
        targetUrl: `/sorteos/${id}`,
      });

      return { ok: true, winnerPlayerProfileId };
    });
  }

  /** Confirmation that the prize was actually sent — a manual, separate step from drawing. */
  async markDelivered(id: string, _adminUserId: string): Promise<boolean> {
    const updated = await this.db
      .update(giveaways)
      .set({ status: 'delivered', updatedAt: sql`now()` })
      .where(and(eq(giveaways.id, id), eq(giveaways.status, 'drawn')))
      .returning({ id: giveaways.id });
    return updated.length > 0;
  }
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
