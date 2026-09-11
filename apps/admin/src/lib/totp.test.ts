import { describe, expect, it } from 'vitest';
import { generateSecret, otpauthUri, totpCode, verifyTotp } from './totp';

// RFC 6238 Appendix B's SHA-1 test vectors use the 20-byte ASCII secret
// "12345678901234567890" and 8-digit codes. Base32 of that secret is
// GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ (cross-checked independently, not derived
// from this implementation). This codebase only ever produces 6-digit codes,
// but 6-digit truncation is `binary % 10^6`, and 10^8 is a multiple of 10^6,
// so the 6-digit code is exactly the last 6 digits of the published 8-digit
// vector — e.g. at T=59s the RFC's 94287082 becomes 287082 here. That gives a
// real independent check on the HMAC/truncation logic, not just self-consistency.
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totpCode against RFC 6238 Appendix B vectors (SHA-1, last 6 digits)', () => {
  it.each([
    [59_000, '287082'],
    [1_111_111_109_000, '081804'],
    [1_111_111_111_000, '050471'],
    [1_234_567_890_000, '005924'],
    [2_000_000_000_000, '279037'],
  ])('matches the published vector at t=%i ms', (atMs, expected) => {
    expect(totpCode(RFC_SECRET_B32, 30, 6, atMs)).toBe(expected);
  });
});

describe('generateSecret', () => {
  it('returns unpadded base32 (RFC 4648 alphabet only)', () => {
    const secret = generateSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret).not.toContain('=');
  });

  it('is different every call', () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
  });

  it('round-trips through totpCode/verifyTotp (a generated secret actually works)', () => {
    const secret = generateSecret();
    const at = 1_700_000_000_000;
    const code = totpCode(secret, 30, 6, at);
    expect(verifyTotp(secret, code, { at })).toEqual({
      valid: true,
      step: Math.floor(at / 1000 / 30),
    });
  });
});

describe('verifyTotp — window tolerance', () => {
  const secret = RFC_SECRET_B32;
  // A step boundary, so "N seconds before/after" lands in a predictable step.
  const boundary = 1_700_000_000_000 - (1_700_000_000_000 % 30_000);

  it('accepts the current code', () => {
    const code = totpCode(secret, 30, 6, boundary);
    expect(verifyTotp(secret, code, { at: boundary })).toEqual({
      valid: true,
      step: boundary / 1000 / 30,
    });
  });

  it('accepts a code from 29 seconds ago (previous step, within ±1)', () => {
    const at = boundary - 29_000;
    const code = totpCode(secret, 30, 6, at);
    const result = verifyTotp(secret, code, { at: boundary });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.step).toBe(Math.floor(at / 1000 / 30));
  });

  it('accepts a code from 29 seconds ahead (within ±1)', () => {
    const at = boundary + 29_000;
    const code = totpCode(secret, 30, 6, at);
    const result = verifyTotp(secret, code, { at: boundary });
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.step).toBe(Math.floor(at / 1000 / 30));
  });

  it('rejects a code from 90 seconds away (3 steps, outside ±1)', () => {
    const code = totpCode(secret, 30, 6, boundary - 90_000);
    expect(verifyTotp(secret, code, { at: boundary })).toEqual({ valid: false });
  });

  it('rejects a code from 61 seconds ahead (2 steps, outside ±1)', () => {
    const code = totpCode(secret, 30, 6, boundary + 61_000);
    expect(verifyTotp(secret, code, { at: boundary })).toEqual({ valid: false });
  });

  it('cannot be widened past ±1 step by a caller-supplied window', () => {
    const code = totpCode(secret, 30, 6, boundary + 61_000);
    // Ask for a huge window; the implementation must clamp it.
    expect(verifyTotp(secret, code, { at: boundary, window: 100 })).toEqual({ valid: false });
  });

  it('a window of 0 accepts only the exact current step', () => {
    const codeNow = totpCode(secret, 30, 6, boundary);
    const codePrev = totpCode(secret, 30, 6, boundary - 29_000);
    expect(verifyTotp(secret, codeNow, { at: boundary, window: 0 }).valid).toBe(true);
    expect(verifyTotp(secret, codePrev, { at: boundary, window: 0 }).valid).toBe(false);
  });
});

describe('verifyTotp — malformed input, never throws', () => {
  const secret = RFC_SECRET_B32;

  it.each([
    ['empty code', ''],
    ['too short', '12345'],
    ['too long', '1234567'],
    ['non-numeric', '12a456'],
    ['contains spaces', '123 456'],
    ['negative sign', '-12345'],
  ])('rejects %s without throwing', (_label, code) => {
    expect(() => verifyTotp(secret, code)).not.toThrow();
    expect(verifyTotp(secret, code)).toEqual({ valid: false });
  });

  it('rejects an empty secret without throwing', () => {
    const code = totpCode(secret, 30, 6);
    expect(() => verifyTotp('', code)).not.toThrow();
    expect(verifyTotp('', code)).toEqual({ valid: false });
  });

  it('rejects a secret with invalid base32 characters without throwing', () => {
    expect(() => verifyTotp('not-valid-base32!!!', '123456')).not.toThrow();
    expect(verifyTotp('not-valid-base32!!!', '123456')).toEqual({ valid: false });
  });

  it('rejects a well-formed but wrong code', () => {
    const wrong = totpCode(secret, 30, 6, Date.now() + 10 * 60 * 1000); // 10 minutes away
    expect(verifyTotp(secret, wrong)).toEqual({ valid: false });
  });
});

describe('otpauthUri', () => {
  it('produces a standard otpauth:// URI with the expected parameters', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'jose@levelupstore.mx');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=LevelUp%20Store');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    // Label is "Issuer:account", both percent-encoded.
    expect(uri).toContain('LevelUp%20Store:jose%40levelupstore.mx');
  });

  it('accepts a custom issuer', () => {
    const uri = otpauthUri('JBSWY3DPEHPK3PXP', 'a@b.com', 'Custom Issuer');
    expect(uri).toContain('issuer=Custom%20Issuer');
    expect(uri).toContain('Custom%20Issuer:a%40b.com');
  });
});
