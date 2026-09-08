/**
 * Admin authentication.
 *
 * This panel approves payments and can trigger real money leaving the provider
 * wallet, so the two primitives here are deliberately conservative and use only
 * `node:crypto` — no dependency whose next version could weaken them quietly.
 *
 *   - scrypt for password hashing, with a per-password salt
 *   - HMAC-signed, expiring session cookies (no server-side session store)
 *
 * Both hash comparison and signature comparison are timing-safe. A stateless
 * cookie means logout is client-side only; for a panel with three or four users
 * that is an acceptable trade, and rotating ADMIN_SESSION_SECRET invalidates
 * every session at once if it is ever needed.
 */

import {
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

// `promisify` picks scrypt's 3-argument overload, which drops the options
// parameter the cost factors live in. Restate the signature we actually use.
const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
/** OWASP-recommended floor for scrypt; ~100ms per hash on a modest VPS. */
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

// ── passwords ─────────────────────────────────────────────────────────────────

/** Returns `scrypt$N$r$p$salt$hash`, self-describing so params can change later. */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new Error('Admin passwords must be at least 12 characters');
  }
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS)) as Buffer;
  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let expected: Buffer;
  let salt: Buffer;
  try {
    expected = Buffer.from(hashB64!, 'base64');
    salt = Buffer.from(saltB64!, 'base64');
  } catch {
    return false;
  }
  if (expected.length !== KEY_LENGTH) return false;

  const derived = (await scrypt(password, salt, KEY_LENGTH, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;

  return timingSafeEqual(derived, expected);
}

// ── sessions ──────────────────────────────────────────────────────────────────

export const SESSION_COOKIE = 'levelup_admin_session';

export interface SessionPayload {
  adminUserId: string;
  email: string;
  /** Unix seconds. */
  expiresAt: number;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function createSessionToken(
  session: Omit<SessionPayload, 'expiresAt'>,
  secret: string,
  ttlSeconds = 12 * 60 * 60,
): string {
  if (!secret || secret.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET must be at least 32 characters');
  }
  const payload: SessionPayload = {
    ...session,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

/**
 * Returns the session, or null for anything wrong: bad shape, bad signature,
 * expired. Callers cannot accidentally treat a tampered token as valid because
 * there is no error path that yields a payload.
 */
export function readSessionToken(
  token: string | undefined,
  secret: string,
  now = () => Date.now(),
): SessionPayload | null {
  if (!token || !secret) return null;

  const dot = token.indexOf('.');
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(encoded, secret);

  // Length check first: timingSafeEqual throws on a length mismatch.
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (
    typeof payload?.adminUserId !== 'string' ||
    typeof payload?.email !== 'string' ||
    typeof payload?.expiresAt !== 'number'
  ) {
    return null;
  }

  if (payload.expiresAt * 1000 <= now()) return null;

  return payload;
}
