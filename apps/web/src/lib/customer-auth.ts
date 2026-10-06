/**
 * Customer authentication: WhatsApp OTP codes and session cookies.
 *
 * A separate primitive from apps/admin/src/lib/auth.ts, deliberately — this
 * repo does not share code across the apps/* boundary (see
 * apps/admin/src/lib/whatsapp.ts's own comment on the same point), and more
 * importantly a customer session must never be forgeable from an admin
 * session or vice versa: distinct secret env var, distinct cookie name,
 * distinct signing key.
 *
 * OTP codes are hashed with a fast HMAC, not scrypt. A 6-digit code has far
 * less entropy than a password — slow hashing would not meaningfully raise
 * the cost of guessing it. The real defenses are the attempt cap and the
 * request rate limit, both enforced by the caller (see cuenta/actions.ts).
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

// ── OTP codes ─────────────────────────────────────────────────────────────────

export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function hmac(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function hashOtpCode(code: string, secret: string): string {
  return hmac(code, secret);
}

export function verifyOtpCode(code: string, hash: string, secret: string): boolean {
  const expected = hmac(code, secret);
  if (expected.length !== hash.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(hash));
}

// ── WhatsApp number normalisation ────────────────────────────────────────────

/**
 * A Mexican phone in the E.164 digits the WhatsApp API wants: `52` plus ten
 * digits, or null for anything that doesn't come out as a plausible number.
 * Same rule as pixel.ts's `normaliseMxPhone` and the worker's
 * meta-capi.ts — kept as its own copy per this repo's "no sharing code
 * across apps/*" convention, not an oversight.
 */
export function normaliseWhatsapp(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 13 && digits.startsWith('521')) digits = `52${digits.slice(3)}`;
  if (digits.length === 10) digits = `52${digits}`;
  return /^52\d{10}$/.test(digits) ? digits : null;
}

// ── sessions ──────────────────────────────────────────────────────────────────

export const CUSTOMER_SESSION_COOKIE = 'levelup_customer_session';
export const CUSTOMER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — a loyalty account, not an admin panel.

export interface CustomerSessionPayload {
  playerProfileId: string;
  playerId: string;
  /** Unix seconds. */
  expiresAt: number;
}

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createCustomerSessionToken(
  session: Omit<CustomerSessionPayload, 'expiresAt'>,
  secret: string,
  ttlSeconds = CUSTOMER_SESSION_TTL_SECONDS,
): string {
  if (!secret || secret.length < 32) {
    throw new Error('CUSTOMER_SESSION_SECRET must be at least 32 characters');
  }
  const payload: CustomerSessionPayload = {
    ...session,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * Returns the session, or null for anything wrong: bad shape, bad signature,
 * expired. There is no error path that yields a payload, so a caller cannot
 * accidentally treat a tampered or stale token as valid.
 */
export function readCustomerSessionToken(
  token: string | undefined,
  secret: string,
  now = () => Date.now(),
): CustomerSessionPayload | null {
  if (!token || !secret) return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(encoded, secret);

  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let payload: CustomerSessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload?.playerProfileId !== 'string' ||
    typeof payload?.playerId !== 'string' ||
    typeof payload?.expiresAt !== 'number'
  ) {
    return null;
  }

  if (payload.expiresAt * 1000 <= now()) return null;

  return payload;
}

// ── short-lived purpose-bound tokens (verified-but-no-account-yet state) ────

/**
 * Same generalised primitive as admin's `signPurposeToken`/`readPurposeToken`
 * (apps/admin/src/lib/auth.ts), duplicated rather than imported per this
 * repo's apps/* boundary rule. Needed here for the same reason it exists
 * there: `verifyOtp` proves a visitor controls a WhatsApp number, but when no
 * account exists yet, `completeSignup` still needs to know this WITHOUT
 * trusting a bare form field — otherwise anyone could create an account for
 * any WhatsApp number without ever receiving a code. `purpose` is mixed into
 * the signing key, so this can never verify as a real session token even if
 * a cookie is ever misread under the wrong name.
 */
export function signPurposeToken(
  payload: Record<string, unknown>,
  secret: string,
  purpose: string,
  ttlSeconds: number,
): string {
  if (!secret || secret.length < 32) {
    throw new Error('CUSTOMER_SESSION_SECRET must be at least 32 characters');
  }
  const full = { ...payload, expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = b64url(JSON.stringify(full));
  return `${encoded}.${sign(encoded, `${secret}:${purpose}`)}`;
}

export function readPurposeToken(
  token: string | undefined,
  secret: string,
  purpose: string,
  now = () => Date.now(),
): (Record<string, unknown> & { expiresAt: number }) | null {
  if (!token || !secret) return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(encoded, `${secret}:${purpose}`);

  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let payload: (Record<string, unknown> & { expiresAt?: unknown }) | null;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload?.expiresAt !== 'number') return null;
  if (payload.expiresAt * 1000 <= now()) return null;

  return payload as Record<string, unknown> & { expiresAt: number };
}
