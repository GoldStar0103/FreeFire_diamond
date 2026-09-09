/**
 * Webhook signature verification.
 *
 * A payment webhook is a public endpoint that says "this order was paid" — the
 * single most valuable sentence an attacker could forge. Verification therefore
 * fails closed on every ambiguity, and the timestamp is checked as well as the
 * signature: a signature alone is replayable forever, so an attacker who ever
 * observes one valid delivery could re-send it indefinitely.
 *
 * The scheme implemented here is Stripe's (`t=…,v1=…`), which Conekta and
 * several others follow closely enough that the same code covers them with a
 * different header name.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { WebhookRejection } from './types.js';

/** How far out of step a delivery's clock may be. Stripe's own default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface SignatureCheck {
  ok: boolean;
  reason?: WebhookRejection;
}

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

/** `t=1699999999,v1=abc...,v1=def...` — multiple v1 entries during key rotation. */
function parseSignatureHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;

    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();

    if (key === 't') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return null;
      timestamp = parsed;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function constantTimeEquals(a: string, b: string): boolean {
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  // Length is not secret; the contents are.
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  now?: () => number;
}

/**
 * Verify a signed webhook body.
 *
 * `rawBody` must be the exact bytes received. Re-serialising a parsed object
 * changes key order and whitespace, and the signature will never match.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  options: VerifyOptions = {},
): SignatureCheck {
  if (!secret) {
    // A missing secret must never mean "skip the check".
    return { ok: false, reason: 'bad_signature' };
  }
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return { ok: false, reason: 'malformed_signature' };

  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);

  // Rejected in both directions: a future timestamp is as suspicious as an old
  // one, and accepting it would widen the replay window.
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  // Every candidate is checked so a rotating secret does not drop deliveries.
  const matched = parsed.signatures.some((candidate) => constantTimeEquals(candidate, expected));

  return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/** Sign a payload the same way, for tests and for a local webhook harness. */
export function signPayload(rawBody: string, secret: string, timestampSeconds: number): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8')
    .digest('hex');
  return `t=${timestampSeconds},v1=${signature}`;
}
