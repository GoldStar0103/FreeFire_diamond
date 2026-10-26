import 'server-only';
import { and, eq } from 'drizzle-orm';
import { baseProducts } from '@levelup/db';
import { ValidationUnsupportedError } from '@levelup/provider';
import { callerIp, getDb, getProvider, validationLimiter } from './server.js';

const PLAYER_ID_PATTERN = /^\d{6,15}$/;

/**
 * The product used for validation lookups. Validation never charges.
 *
 * Any recharge-type product validates the same account, so the cheapest one
 * on the books — nothing expensive is being touched. Active only: when the
 * provider replaces its product ids, the retired rows stay in the table (and
 * the 100 💎 one is still the cheapest), and validating against a dead id would
 * fail every customer at step one.
 */
export async function validationProductId(): Promise<string | null> {
  const [row] = await getDb()
    .select({ providerProductId: baseProducts.providerProductId })
    .from(baseProducts)
    .where(and(eq(baseProducts.canValidate, true), eq(baseProducts.active, true)))
    .orderBy(baseProducts.diamondsBase)
    .limit(1);
  return row?.providerProductId ?? null;
}

export type PlayerIdVerification =
  | { ok: true; nickname: string | null }
  | { ok: false; message: string };

/**
 * Confirm a Free Fire ID against the provider before it is permanently
 * attached to a Mi LevelUp account — signup, and changing the linked ID.
 *
 * Same lookup, same rate limiter and the same "refuse rather than guess"
 * posture as checkout's own player check (comprar/[combo]/actions.ts): an ID
 * that was never real cannot be told apart from a mistyped one after the
 * fact, and unlike a single order, an account's linked ID stays wrong for
 * every future recharge and every Level Pass reward until someone notices.
 */
export async function verifyPlayerId(playerId: string): Promise<PlayerIdVerification> {
  if (!PLAYER_ID_PATTERN.test(playerId)) {
    return { ok: false, message: 'El ID de Free Fire debe tener entre 6 y 15 números.' };
  }

  const decision = validationLimiter.check(await callerIp());
  if (!decision.allowed) {
    return {
      ok: false,
      message: `Demasiados intentos. Espera ${Math.ceil(decision.retryAfterMs / 1000)} segundos.`,
    };
  }

  const productId = await validationProductId();
  if (!productId) {
    return { ok: false, message: 'No podemos verificar tu ID en este momento. Intenta más tarde.' };
  }

  try {
    const result = await getProvider().validatePlayer(productId, playerId);
    // `found` is the actual answer — the provider has confirmed this account
    // exists. `nickname` can come back null even on a real account (seen in
    // production 2026-10-26: a stale validate-only product id returns
    // `status: true, account_name: null`); treating that as "not found" was
    // the bug, not a flaky lookup. The nickname is a nice-to-have proof for
    // the customer, not the source of truth on whether the ID is real.
    if (!result.found) {
      return { ok: false, message: 'No encontramos ese ID de Free Fire. Revísalo e intenta de nuevo.' };
    }
    return { ok: true, nickname: result.nickname };
  } catch (err) {
    if (err instanceof ValidationUnsupportedError) {
      console.error('[validate] product does not support validation', err);
      return { ok: false, message: 'No podemos verificar tu ID en este momento.' };
    }
    console.error('[validate] provider call failed', err);
    return { ok: false, message: 'No pudimos contactar al servidor de Free Fire. Intenta en un momento.' };
  }
}
