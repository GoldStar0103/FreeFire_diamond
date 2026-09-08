import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  hashPassword,
  readSessionToken,
  verifyPassword,
} from './auth';

const SECRET = 'a'.repeat(48);
const session = { adminUserId: 'admin-1', email: 'jose@levelupstore.mx' };

describe('password hashing', () => {
  it('accepts the correct password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse batterz', stored)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b);
    // Both still verify — a rainbow table against one is useless against the other.
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse battery', b)).toBe(true);
  });

  it('records its own parameters so they can be raised later', async () => {
    expect(await hashPassword('correct horse battery')).toMatch(/^scrypt\$16384\$8\$1\$/);
  });

  it('refuses a short password outright', async () => {
    // This panel moves money; a six-character password is not a user choice.
    await expect(hashPassword('hunter2')).rejects.toThrow(/at least 12/);
  });

  it.each([
    ['empty', ''],
    ['not scrypt', 'bcrypt$16384$8$1$c2FsdA==$aGFzaA=='],
    ['truncated', 'scrypt$16384$8$1$c2FsdA=='],
    ['non-numeric params', 'scrypt$x$8$1$c2FsdA==$aGFzaA=='],
    ['wrong hash length', 'scrypt$16384$8$1$c2FsdA==$aGFzaA=='],
  ])('rejects a malformed stored hash (%s)', async (_label, stored) => {
    expect(await verifyPassword('correct horse battery', stored)).toBe(false);
  });
});

describe('session tokens', () => {
  it('round-trips a valid session', () => {
    const token = createSessionToken(session, SECRET);
    expect(readSessionToken(token, SECRET)).toMatchObject(session);
  });

  it('rejects a tampered payload', () => {
    // Swap in a different admin id and re-encode, leaving the signature alone.
    const token = createSessionToken(session, SECRET);
    const [, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...session, adminUserId: 'someone-else', expiresAt: 9_999_999_999 }),
    ).toString('base64url');

    expect(readSessionToken(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = createSessionToken(session, SECRET);
    expect(readSessionToken(token, 'b'.repeat(48))).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = createSessionToken(session, SECRET, 60);
    const later = () => Date.now() + 61_000;
    expect(readSessionToken(token, SECRET, later)).toBeNull();
  });

  it('accepts a token that has not expired yet', () => {
    const token = createSessionToken(session, SECRET, 3600);
    expect(readSessionToken(token, SECRET, () => Date.now() + 60_000)).toMatchObject(session);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['empty payload', '.signature'],
    ['garbage payload', '!!!!.signature'],
  ])('rejects a malformed token (%s)', (_label, token) => {
    expect(readSessionToken(token, SECRET)).toBeNull();
  });

  it('rejects a payload missing required fields', () => {
    // Correctly signed, but not a session — must not be trusted.
    const encoded = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url');
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url');

    expect(readSessionToken(`${encoded}.${signature}`, SECRET)).toBeNull();
  });

  it('refuses to issue a token with a weak secret', () => {
    expect(() => createSessionToken(session, 'short')).toThrow(/at least 32/);
  });

  it('rejects everything when no secret is configured', () => {
    const token = createSessionToken(session, SECRET);
    expect(readSessionToken(token, '')).toBeNull();
  });
});
