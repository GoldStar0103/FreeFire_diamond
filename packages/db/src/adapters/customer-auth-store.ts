/**
 * Player accounts and WhatsApp OTP codes.
 *
 * Free-function query module (not an engine port — there is no shared
 * business logic here beyond plain CRUD and a couple of guarded writes),
 * matching admin-queries.ts's own shape.
 */

import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { badgeDefinitions, badgeOwnerships, playerOtpCodes, playerProfiles } from '../schema.js';

/** Postgres unique-violation — see ordering-store.ts's own identical constant. */
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;

// ── OTP codes ─────────────────────────────────────────────────────────────────

export interface OtpCodeRow {
  id: string;
  whatsapp: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

export async function createOtpCode(
  db: Database,
  whatsapp: string,
  codeHash: string,
  expiresAt: Date,
): Promise<OtpCodeRow> {
  const [row] = await db
    .insert(playerOtpCodes)
    .values({ whatsapp, codeHash, expiresAt })
    .returning();
  return row!;
}

/** The newest unconsumed, unexpired code for this number — there should only ever be one live. */
export async function findActiveOtpCode(db: Database, whatsapp: string, now = new Date()): Promise<OtpCodeRow | null> {
  const [row] = await db
    .select()
    .from(playerOtpCodes)
    .where(and(eq(playerOtpCodes.whatsapp, whatsapp), isNull(playerOtpCodes.consumedAt), gt(playerOtpCodes.expiresAt, now)))
    .orderBy(desc(playerOtpCodes.createdAt))
    .limit(1);
  return row ?? null;
}

/** Returns the new attempt count, so the caller can compare against its own limit without a second read. */
export async function incrementOtpAttempts(db: Database, id: string): Promise<number> {
  const [row] = await db
    .update(playerOtpCodes)
    .set({ attempts: sql`${playerOtpCodes.attempts} + 1` })
    .where(eq(playerOtpCodes.id, id))
    .returning({ attempts: playerOtpCodes.attempts });
  return row?.attempts ?? 0;
}

/**
 * Compare-and-set on `consumedAt IS NULL`, same discipline as the admin 2FA
 * anti-replay guard (`apps/admin/.../verify/actions.ts`): two concurrent
 * verify attempts with the same code must not both succeed.
 */
export async function consumeOtpCode(db: Database, id: string): Promise<boolean> {
  const rows = await db
    .update(playerOtpCodes)
    .set({ consumedAt: sql`now()` })
    .where(and(eq(playerOtpCodes.id, id), isNull(playerOtpCodes.consumedAt)))
    .returning({ id: playerOtpCodes.id });
  return rows.length > 0;
}

// ── player profiles ─────────────────────────────────────────────────────────

export interface PlayerProfileRow {
  id: string;
  playerId: string;
  whatsapp: string;
  displayName: string | null;
  avatarAssetUrl: string | null;
}

export async function findProfileByWhatsapp(db: Database, whatsapp: string): Promise<PlayerProfileRow | null> {
  const [row] = await db.select().from(playerProfiles).where(eq(playerProfiles.whatsapp, whatsapp)).limit(1);
  return row ?? null;
}

export async function findProfileByPlayerId(db: Database, playerId: string): Promise<PlayerProfileRow | null> {
  const [row] = await db.select().from(playerProfiles).where(eq(playerProfiles.playerId, playerId)).limit(1);
  return row ?? null;
}

export type CreateProfileResult =
  | { ok: true; profile: PlayerProfileRow }
  | { ok: false; reason: 'whatsapp_taken' | 'player_id_taken' };

/**
 * Creates the account. No backfill step needed for historical orders:
 * `orders.player_id` already joins to this row by the same string — see
 * schema.ts's own comment on why that is a deliberate choice rather than a
 * gap.
 */
export async function createPlayerProfile(
  db: Database,
  input: { playerId: string; whatsapp: string },
): Promise<CreateProfileResult> {
  try {
    const [profile] = await db
      .insert(playerProfiles)
      .values({ playerId: input.playerId, whatsapp: input.whatsapp })
      .returning();
    return { ok: true, profile: profile! };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const message = String(err);
      if (message.includes('player_profiles_whatsapp_idx')) return { ok: false, reason: 'whatsapp_taken' };
      if (message.includes('player_profiles_player_id_idx')) return { ok: false, reason: 'player_id_taken' };
    }
    throw err;
  }
}

/**
 * Awards the Founder badge if (a) a "founder" badge definition exists and is
 * obtainable, and (b) `now` falls inside its configured eligibility window —
 * an unset bound on either side is open-ended, matching the spec's own
 * wording ("obtainable only during its configured launch eligibility
 * window"). Silently does nothing otherwise; this is an opportunistic bonus
 * at signup, not a step that can fail account creation.
 */
export async function awardFounderBadgeIfEligible(
  db: Database,
  profileId: string,
  now: Date = new Date(),
): Promise<void> {
  const [badge] = await db
    .select({ id: badgeDefinitions.id, startsAt: badgeDefinitions.eligibilityStartsAt, endsAt: badgeDefinitions.eligibilityEndsAt })
    .from(badgeDefinitions)
    .where(and(eq(badgeDefinitions.badgeKey, 'founder'), eq(badgeDefinitions.obtainable, true)))
    .limit(1);
  if (!badge) return;

  if (badge.startsAt && now < badge.startsAt) return;
  if (badge.endsAt && now > badge.endsAt) return;

  await db
    .insert(badgeOwnerships)
    .values({ playerProfileId: profileId, badgeDefinitionId: badge.id, seasonId: null, source: 'automatic' })
    .onConflictDoNothing();
}
