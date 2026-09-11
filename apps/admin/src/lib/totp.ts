/**
 * TOTP (RFC 6238) two-factor codes, built on HOTP (RFC 4226).
 *
 * Implemented from scratch on `node:crypto` only, for the same reason
 * `auth.ts` hand-rolls its password hashing and session signing: this panel
 * can trigger real provider spending, so there is no dependency here whose
 * next version could weaken it quietly. There is no built-in base32 codec
 * either, so that is hand-rolled too — it is the only encoding every
 * authenticator app (Google Authenticator, Authy, 1Password, …) accepts for
 * manual secret entry.
 *
 * Verification is timing-safe, the same way `readSessionToken` compares
 * signatures: a length check first (`timingSafeEqual` throws on a length
 * mismatch), then a constant-time byte comparison.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TIME_STEP_SECONDS = 30;
const DIGITS = 6;
const SECRET_BYTES = 20;
/** Hard ceiling on the verification window — never widen this. */
const MAX_WINDOW_STEPS = 1;

// ── base32 (RFC 4648, unpadded) ─────────────────────────────────────────────

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/** Throws on any character outside the base32 alphabet. */
function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/\s+/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A random 20-byte secret (160 bits, the RFC 4226 recommendation), base32-encoded. */
export function generateSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

// ── HOTP (RFC 4226) ──────────────────────────────────────────────────────────

function hotp(secret: Buffer, counter: number, digits: number): string {
  // 8-byte big-endian counter. `counter` stays far below 2^32 for millennia at
  // a 30s step, but split high/low properly rather than assume it always will.
  const counterBuf = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low, 4);

  const digest = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  // Dynamic truncation: 31 bits starting at `offset`, per RFC 4226 §5.3.
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────

/**
 * The code a compliant authenticator app shows right now (or at `at`).
 * SHA-1, 6 digits, 30-second steps — what every mainstream app defaults to;
 * deviating here would mean generating codes nothing can check.
 */
export function totpCode(
  secretBase32: string,
  timeStepSeconds = TIME_STEP_SECONDS,
  digits = DIGITS,
  at: number = Date.now(),
): string {
  const counter = Math.floor(at / 1000 / timeStepSeconds);
  return hotp(base32Decode(secretBase32), counter, digits);
}

export type TotpVerifyResult = { valid: true; step: number } | { valid: false };

/**
 * Checks `code` against a ±1 time-step window (±30s, to tolerate clock
 * drift) around `options.at` (default now). `options.window` can narrow that
 * window but never widen it past ±1 — a wider tolerance is a wider replay
 * surface, and is not a caller's call to make.
 *
 * On a match, `step` is the absolute time-step counter that matched, so the
 * caller can record it and refuse to accept that exact step again (anti-replay
 * — see `admin_users.totp_last_step`).
 *
 * Rejects anything that is not exactly 6 numeric characters before touching
 * crypto, and never throws — a malformed secret or code is just `{ valid: false }`.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: { at?: number; window?: number } = {},
): TotpVerifyResult {
  if (!/^\d{6}$/.test(code)) return { valid: false };
  if (!secretBase32) return { valid: false };

  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return { valid: false };
  }
  if (secret.length === 0) return { valid: false };

  const at = options.at ?? Date.now();
  const window = Math.min(MAX_WINDOW_STEPS, Math.max(0, options.window ?? MAX_WINDOW_STEPS));
  const currentStep = Math.floor(at / 1000 / TIME_STEP_SECONDS);
  const codeBuf = Buffer.from(code, 'utf8');

  for (let delta = -window; delta <= window; delta++) {
    const step = currentStep + delta;
    const candidate = hotp(secret, step, DIGITS);
    const candidateBuf = Buffer.from(candidate, 'utf8');
    // Same fixed digit count every time, so this length check never actually
    // trips — kept because `timingSafeEqual` throws on a length mismatch and
    // a defensive check costs nothing.
    if (candidateBuf.length === codeBuf.length && timingSafeEqual(candidateBuf, codeBuf)) {
      return { valid: true, step };
    }
  }
  return { valid: false };
}

/**
 * The standard `otpauth://` URI: scannable as a QR by any authenticator app
 * once rendered, and copyable as text without one. No QR image is generated
 * here — every mainstream app also accepts manual entry, so a URI is enough
 * and does not require pulling in a QR library.
 */
export function otpauthUri(secretBase32: string, accountEmail: string, issuer = 'LevelUp Store'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountEmail)}`;
  const query = [
    `secret=${encodeURIComponent(secretBase32)}`,
    `issuer=${encodeURIComponent(issuer)}`,
    'algorithm=SHA1',
    'digits=6',
    'period=30',
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}
