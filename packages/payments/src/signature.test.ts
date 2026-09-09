import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { signPayload, verifySignature } from './signature.js';

const SECRET = 'whsec_test_0123456789abcdef';
const BODY = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

describe('a genuine delivery', () => {
  it('verifies', () => {
    const header = signPayload(BODY, SECRET, NOW_S);
    expect(verifySignature(BODY, header, SECRET, { now })).toEqual({ ok: true });
  });

  it('verifies inside the tolerance window, in both directions', () => {
    for (const skew of [-299, -60, 0, 60, 299]) {
      const header = signPayload(BODY, SECRET, NOW_S + skew);
      expect(verifySignature(BODY, header, SECRET, { now }).ok).toBe(true);
    }
  });

  it('accepts any of several signatures during a secret rotation', () => {
    const valid = createHmac('sha256', SECRET).update(`${NOW_S}.${BODY}`).digest('hex');
    const header = `t=${NOW_S},v1=${'0'.repeat(64)},v1=${valid}`;
    expect(verifySignature(BODY, header, SECRET, { now }).ok).toBe(true);
  });
});

describe('forgery', () => {
  it('rejects a body that was altered after signing', () => {
    // The attack that matters: take a real webhook, change the amount.
    const header = signPayload(BODY, SECRET, NOW_S);
    const tampered = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', amount: 1 });

    expect(verifySignature(tampered, header, SECRET, { now })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature made with a different secret', () => {
    const header = signPayload(BODY, 'whsec_someone_elses', NOW_S);
    expect(verifySignature(BODY, header, SECRET, { now }).reason).toBe('bad_signature');
  });

  it('rejects a signature lifted from a different timestamp', () => {
    // Recomputing t without recomputing v1 must not pass.
    const header = signPayload(BODY, SECRET, NOW_S);
    const moved = header.replace(`t=${NOW_S}`, `t=${NOW_S + 10}`);
    expect(verifySignature(BODY, moved, SECRET, { now }).reason).toBe('bad_signature');
  });
});

describe('replay', () => {
  it('rejects a delivery replayed later', () => {
    // A signature with no timestamp check is valid forever.
    const header = signPayload(BODY, SECRET, NOW_S - 3600);
    expect(verifySignature(BODY, header, SECRET, { now })).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects a timestamp from the future', () => {
    // Accepting one would widen the replay window rather than narrow it.
    const header = signPayload(BODY, SECRET, NOW_S + 3600);
    expect(verifySignature(BODY, header, SECRET, { now }).reason).toBe('stale_timestamp');
  });

  it('honours a tighter tolerance', () => {
    const header = signPayload(BODY, SECRET, NOW_S - 120);
    expect(verifySignature(BODY, header, SECRET, { now, toleranceSeconds: 60 }).reason).toBe(
      'stale_timestamp',
    );
  });
});

describe('malformed input', () => {
  it.each([
    ['missing header', undefined, 'missing_signature'],
    ['empty header', '', 'missing_signature'],
    ['no timestamp', 'v1=abc', 'malformed_signature'],
    ['no signature', `t=${NOW_S}`, 'malformed_signature'],
    ['non-numeric timestamp', 't=ayer,v1=abc', 'malformed_signature'],
    ['junk', 'garbage', 'malformed_signature'],
  ])('rejects %s', (_label, header, reason) => {
    expect(verifySignature(BODY, header, SECRET, { now }).reason).toBe(reason);
  });

  it('fails closed when no secret is configured', () => {
    // A missing secret must never be read as "skip verification". This is the
    // misconfiguration that silently turns the endpoint into an open door.
    const header = signPayload(BODY, SECRET, NOW_S);
    expect(verifySignature(BODY, header, '', { now })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects an empty body signed as something else', () => {
    const header = signPayload(BODY, SECRET, NOW_S);
    expect(verifySignature('', header, SECRET, { now }).reason).toBe('bad_signature');
  });
});

describe('exact bytes', () => {
  it('fails when the body is re-serialised rather than passed through', () => {
    // The classic integration bug: reading req.body (parsed) instead of the raw
    // text. Key order and whitespace change, and nothing ever verifies.
    const original = '{"id":"evt_1",  "amount":  1000}';
    const header = signPayload(original, SECRET, NOW_S);
    const reserialised = JSON.stringify(JSON.parse(original));

    expect(reserialised).not.toBe(original);
    expect(verifySignature(reserialised, header, SECRET, { now }).ok).toBe(false);
    expect(verifySignature(original, header, SECRET, { now }).ok).toBe(true);
  });

  it('handles a body with non-ASCII content', () => {
    // Combo names carry accents; UTF-8 byte length differs from string length.
    const body = JSON.stringify({ description: 'Recarga Súper Prime — 10,900 💎' });
    const header = signPayload(body, SECRET, NOW_S);
    expect(verifySignature(body, header, SECRET, { now }).ok).toBe(true);
  });
});
