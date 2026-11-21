/**
 * Drizzle implementation of the engine's `GiveawayEntryStore` port — the
 * checkout-side "spend tickets entering a giveaway" write. Mirrors
 * `item-ordering-store.ts`'s shape: one transaction, and the balance check
 * is `WHERE ticket_balance >= :cost` so an insufficient balance writes
 * nothing, rather than relying on a defensive floor (the
 * `GREATEST(...,0)` floor `order-reversal-store.ts` uses for refunds is not
 * safe to reuse here — an entry must never be allowed to go negative).
 *
 * The optional `maxEntriesPerPlayer`/`maxParticipants` caps are checked in
 * the same transaction, after locking the `giveaways` row with
 * `FOR UPDATE` — same `.for('update')` pattern `catalog-sync-store.ts`
 * already uses — so two concurrent entries for the same giveaway can't both
 * slip past a `maxParticipants` cap.
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import type { GiveawayEntryStore, GiveawayForEntry, SpendTicketsResult } from '@levelup/engine';
import type { Database } from '../index.js';
import { giveawayEntries, giveaways, playerProfiles, ticketTransactions } from '../schema.js';

export class DrizzleGiveawayEntryStore implements GiveawayEntryStore {
  constructor(private readonly db: Database) {}

  async findGiveawayForEntry(giveawayId: string): Promise<GiveawayForEntry | null> {
    const [row] = await this.db
      .select({
        id: giveaways.id,
        status: giveaways.status,
        opensAt: giveaways.opensAt,
        closesAt: giveaways.closesAt,
        entryCostTickets: giveaways.entryCostTickets,
      })
      .from(giveaways)
      .where(eq(giveaways.id, giveawayId))
      .limit(1);
    return row ?? null;
  }

  async spendTicketsForEntry(input: {
    giveawayId: string;
    playerProfileId: string;
    entryCount: number;
    costTickets: number;
  }): Promise<SpendTicketsResult> {
    return this.db.transaction(async (tx) => {
      const [giveaway] = await tx
        .select({ maxEntriesPerPlayer: giveaways.maxEntriesPerPlayer, maxParticipants: giveaways.maxParticipants })
        .from(giveaways)
        .where(eq(giveaways.id, input.giveawayId))
        .for('update');

      const [existingEntry] = await tx
        .select({ entryCount: giveawayEntries.entryCount })
        .from(giveawayEntries)
        .where(
          and(eq(giveawayEntries.giveawayId, input.giveawayId), eq(giveawayEntries.playerProfileId, input.playerProfileId)),
        )
        .limit(1);
      const priorEntryCount = existingEntry?.entryCount ?? 0;

      if (giveaway?.maxEntriesPerPlayer != null && priorEntryCount + input.entryCount > giveaway.maxEntriesPerPlayer) {
        return { ok: false, reason: 'max_entries_per_player', currentEntryCount: priorEntryCount };
      }

      if (!existingEntry && giveaway?.maxParticipants != null) {
        const [countRow] = await tx
          .select({ count: sql<string>`count(*)` })
          .from(giveawayEntries)
          .where(eq(giveawayEntries.giveawayId, input.giveawayId));
        if (Number(countRow!.count) >= giveaway.maxParticipants) {
          return { ok: false, reason: 'giveaway_full' };
        }
      }

      const [profileAfter] = await tx
        .update(playerProfiles)
        .set({
          ticketBalance: sql`${playerProfiles.ticketBalance} - ${input.costTickets}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(playerProfiles.id, input.playerProfileId),
            gte(playerProfiles.ticketBalance, input.costTickets),
          ),
        )
        .returning({ ticketBalance: playerProfiles.ticketBalance });

      if (!profileAfter) {
        const [current] = await tx
          .select({ ticketBalance: playerProfiles.ticketBalance })
          .from(playerProfiles)
          .where(eq(playerProfiles.id, input.playerProfileId))
          .limit(1);
        return { ok: false, reason: 'insufficient_tickets', currentBalance: current?.ticketBalance ?? 0 };
      }

      const [entry] = await tx
        .insert(giveawayEntries)
        .values({
          giveawayId: input.giveawayId,
          playerProfileId: input.playerProfileId,
          entryCount: input.entryCount,
          ticketsSpent: input.costTickets,
        })
        .onConflictDoUpdate({
          target: [giveawayEntries.giveawayId, giveawayEntries.playerProfileId],
          set: {
            entryCount: sql`${giveawayEntries.entryCount} + ${input.entryCount}`,
            ticketsSpent: sql`${giveawayEntries.ticketsSpent} + ${input.costTickets}`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ entryCount: giveawayEntries.entryCount, ticketsSpent: giveawayEntries.ticketsSpent });

      await tx.insert(ticketTransactions).values({
        playerProfileId: input.playerProfileId,
        type: 'entry',
        amount: -input.costTickets,
        resultingBalance: profileAfter.ticketBalance,
        giveawayId: input.giveawayId,
      });

      return {
        ok: true,
        resultingBalance: profileAfter.ticketBalance,
        totalEntryCount: entry!.entryCount,
        totalTicketsSpent: entry!.ticketsSpent,
      };
    });
  }
}
