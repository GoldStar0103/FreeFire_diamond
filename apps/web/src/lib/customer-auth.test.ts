import { describe, expect, it } from 'vitest';
import {
  createCustomerSessionToken,
  generateOtpCode,
  hashOtpCode,
  normaliseWhatsapp,
  readCustomerSessionToken,
  readPurposeToken,
  signPurposeToken,
  verifyOtpCode,
} from './customer-auth.js';

const SECRET = 'a'.repeat(48);

describe('generateOtpCode', () => {
  it('always returns 6 digits, zero-padded', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe('OTP hashing', () => {
  it('accepts the correct code', () => {
    const hash = hashOtpCode('123456', SECRET);
    expect(verifyOtpCode('123456', hash, SECRET)).toBe(true);
  });

  it('rejects the wrong code', () => {
    const hash = hashOtpCode('123456', SECRET);
    expect(verifyOtpCode('654321', hash, SECRET)).toBe(false);
  });

  it('rejects the right code hashed under a different secret', () => {
    const hash = hashOtpCode('123456', SECRET);
    expect(verifyOtpCode('123456', hash, 'b'.repeat(48))).toBe(false);
  });

  it('is deterministic for the same code and secret', () => {
    expect(hashOtpCode('123456', SECRET)).toBe(hashOtpCode('123456', SECRET));
  });
});

describe('normaliseWhatsapp', () => {
  it.each([
    ['55 1234 5678', '525512345678'],
    ['5512345678', '525512345678'],
    ['+52 55 1234 5678', '525512345678'],
    ['525512345678', '525512345678'],
    ['00525512345678', '525512345678'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normaliseWhatsapp(input)).toBe(expected);
  });

  it.each(['abc', '123', '12345678901234567890'])('rejects implausible input (%s)', (input) => {
    expect(normaliseWhatsapp(input)).toBeNull();
  });
});

describe('customer session tokens', () => {
  const session = { playerProfileId: 'profile-1', playerId: '123456789' };

  it('round-trips a valid session', () => {
    const token = createCustomerSessionToken(session, SECRET);
    expect(readCustomerSessionToken(token, SECRET)).toMatchObject(session);
  });

  it('rejects a tampered payload', () => {
    const token = createCustomerSessionToken(session, SECRET);
    const [, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...session, playerProfileId: 'someone-else', expiresAt: 9_999_999_999 }),
    ).toString('base64url');

    expect(readCustomerSessionToken(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects an expired session', () => {
    const token = createCustomerSessionToken(session, SECRET, -1);
    expect(readCustomerSessionToken(token, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = createCustomerSessionToken(session, SECRET);
    expect(readCustomerSessionToken(token, 'b'.repeat(48))).toBeNull();
  });

  it('refuses to sign with a short secret', () => {
    expect(() => createCustomerSessionToken(session, 'short')).toThrow(/32 characters/);
  });

  it.each(['', 'no-dot-here', 'a.b.c'])('rejects a malformed token (%s)', (token) => {
    // 'a.b.c' is handled by taking the first dot, so the signature becomes 'b.c' and fails verification.
    expect(readCustomerSessionToken(token, SECRET)).toBeNull();
  });
});

describe('purpose-bound tokens', () => {
  it('round-trips for the same purpose', () => {
    const token = signPurposeToken({ whatsapp: '525512345678' }, SECRET, 'pending-signup', 600);
    expect(readPurposeToken(token, SECRET, 'pending-signup')).toMatchObject({ whatsapp: '525512345678' });
  });

  it('never verifies for a different purpose, even with the right secret', () => {
    const token = signPurposeToken({ whatsapp: '525512345678' }, SECRET, 'pending-signup', 600);
    expect(readPurposeToken(token, SECRET, 'something-else')).toBeNull();
  });

  it('a purpose token never verifies as a plain session token, and vice versa', () => {
    const purposeToken = signPurposeToken({ playerProfileId: 'x', playerId: 'y' }, SECRET, 'pending-signup', 600);
    expect(readCustomerSessionToken(purposeToken, SECRET)).toBeNull();

    const sessionToken = createCustomerSessionToken({ playerProfileId: 'x', playerId: 'y' }, SECRET);
    expect(readPurposeToken(sessionToken, SECRET, 'pending-signup')).toBeNull();
  });

  it('rejects an expired purpose token', () => {
    const token = signPurposeToken({ whatsapp: '525512345678' }, SECRET, 'pending-signup', -1);
    expect(readPurposeToken(token, SECRET, 'pending-signup')).toBeNull();
  });
});
