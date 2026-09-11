'use server';

import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createRateLimiter, type RateLimiter } from '@levelup/shared';
import { adminUsers } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { createSessionToken, readPurposeToken } from '../../../lib/auth';
import { verifyTotp } from '../../../lib/totp';
import { setSessionCookie } from '../../../lib/session';
import { PENDING_2FA_COOKIE, PENDING_2FA_PURPOSE } from '../pending-2fa';

export interface VerifyTotpState {
  error?: string;
}

/** Never reveal which part of the code was wrong — same instinct as the password step. */
const GENERIC_FAILURE = 'Código incorrecto o expirado.';

declare global {
  // eslint-disable-next-line no-var
  var __adminLoginTotpLimiter: RateLimiter | undefined;
}

/**
 * A handful of attempts per pending login, not per IP — the pending cookie
 * already scopes this to one admin's one login attempt, and the cookie's own
 * 5-minute TTL is the outer bound. Cached on `globalThis` for the same reason
 * `apps/web/src/lib/server.ts`'s limiters are: Next dev reloads modules on
 * every save, which would otherwise reset the counter on every edit.
 */
const loginTotpLimiter: RateLimiter =
  globalThis.__adminLoginTotpLimiter ??
  createRateLimiter({
    limit: Number(process.env.ADMIN_TOTP_RATE_LIMIT ?? 5),
    windowMs: Number(process.env.ADMIN_TOTP_RATE_WINDOW_MS ?? 5 * 60_000),
  });
if (process.env.NODE_ENV !== 'production') globalThis.__adminLoginTotpLimiter = loginTotpLimiter;

export async function verifyLoginTotp(
  _prev: VerifyTotpState,
  formData: FormData,
): Promise<VerifyTotpState> {
  const code = String(formData.get('code') ?? '').trim();

  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set');

  const store = await cookies();
  const pending = readPurposeToken(store.get(PENDING_2FA_COOKIE)?.value, secret, PENDING_2FA_PURPOSE);

  if (!pending || typeof pending.adminUserId !== 'string' || typeof pending.email !== 'string') {
    // Expired, missing, or tampered — back to the start rather than guessing.
    store.delete(PENDING_2FA_COOKIE);
    redirect('/login');
  }

  const adminUserId = pending.adminUserId;

  // A handful of wrong guesses against this pending login, then force a fresh
  // password entry — an acceptable minimum without new rate-limit infra.
  const decision = loginTotpLimiter.check(adminUserId);
  if (!decision.allowed) {
    store.delete(PENDING_2FA_COOKIE);
    redirect('/login');
  }

  const [user] = await getDb().select().from(adminUsers).where(eq(adminUsers.id, adminUserId)).limit(1);

  if (!user || !user.active || !user.totpSecret) {
    store.delete(PENDING_2FA_COOKIE);
    redirect('/login');
  }

  const result = verifyTotp(user.totpSecret, code);
  if (!result.valid || (user.totpLastStep !== null && result.step <= user.totpLastStep)) {
    return { error: GENERIC_FAILURE };
  }

  // The anti-replay guard, made a real compare-and-set rather than a plain
  // read-then-write: two requests racing this exact code (an attacker who
  // captured it, timed against the legitimate submission) could otherwise
  // both pass the check above before either write lands, and both get a
  // session. Guarding the UPDATE on the row still being at the state just
  // read means only the first to commit wins; the loser matches zero rows and
  // is refused, the same pattern `DrizzlePaymentStore.confirmPayment` uses so
  // a double-tap approval cannot enqueue twice.
  const claimed = await getDb()
    .update(adminUsers)
    .set({ totpLastStep: result.step })
    .where(
      and(
        eq(adminUsers.id, user.id),
        or(isNull(adminUsers.totpLastStep), lt(adminUsers.totpLastStep, result.step)),
      ),
    )
    .returning({ id: adminUsers.id });

  if (claimed.length === 0) {
    return { error: GENERIC_FAILURE };
  }

  store.delete(PENDING_2FA_COOKIE);
  loginTotpLimiter.reset(adminUserId);

  await setSessionCookie(createSessionToken({ adminUserId: user.id, email: user.email }, secret));

  redirect('/');
}
