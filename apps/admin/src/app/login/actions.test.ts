/**
 * `login`'s 2FA branching, with the DB, cookies and `redirect()` mocked out
 * so this exercises real password verification and real token signing
 * (`../../lib/auth` is not mocked) without a database.
 *
 * The point of this file is the first test: an admin with no `totp_secret`
 * must see byte-for-byte the same outcome as before 2FA existed — a session
 * cookie and a redirect to `/`, nothing else. That has to be proven, not
 * just implied by the second test passing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const cookieStore = { set: vi.fn(), get: vi.fn(), delete: vi.fn() };
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => cookieStore) }));

vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

const setSessionCookieMock = vi.fn(async () => {});
vi.mock('../../lib/session', () => ({
  setSessionCookie: setSessionCookieMock,
  clearSessionCookie: vi.fn(async () => {}),
}));

let mockUser: Record<string, unknown> | undefined;
vi.mock('../../lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (mockUser ? [mockUser] : []),
        }),
      }),
    }),
  }),
}));

// Only the table reference `eq()` needs — never queried against a real DB here.
vi.mock('@levelup/db', () => ({ adminUsers: { email: 'email-column' } }));

const { hashPassword } = await import('../../lib/auth');
const { login } = await import('./actions');

const PASSWORD = 'correct horse battery';

describe('login — admins with no 2FA are unaffected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = undefined;
    process.env.ADMIN_SESSION_SECRET = 'x'.repeat(40);
  });

  it('issues a session immediately and redirects to / — same as before 2FA existed', async () => {
    mockUser = {
      id: 'admin-no-2fa',
      email: 'jose@levelupstore.mx',
      passwordHash: await hashPassword(PASSWORD),
      active: true,
      totpSecret: null,
    };

    const formData = new FormData();
    formData.set('email', 'jose@levelupstore.mx');
    formData.set('password', PASSWORD);

    await expect(login({}, formData)).rejects.toThrow('REDIRECT:/');

    expect(setSessionCookieMock).toHaveBeenCalledTimes(1);
    // No pending-2FA cookie, or any other cookie, is ever set for this admin.
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});

describe('login — an admin with 2FA enabled gets a pending step instead', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = undefined;
    process.env.ADMIN_SESSION_SECRET = 'x'.repeat(40);
  });

  it('does not issue a session, sets a pending cookie, and redirects to /login/verify', async () => {
    mockUser = {
      id: 'admin-with-2fa',
      email: 'ana@levelupstore.mx',
      passwordHash: await hashPassword(PASSWORD),
      active: true,
      totpSecret: 'JBSWY3DPEHPK3PXP',
    };

    const formData = new FormData();
    formData.set('email', 'ana@levelupstore.mx');
    formData.set('password', PASSWORD);

    await expect(login({}, formData)).rejects.toThrow('REDIRECT:/login/verify');

    expect(setSessionCookieMock).not.toHaveBeenCalled();
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    const [cookieName] = cookieStore.set.mock.calls[0]!;
    expect(cookieName).toBe('levelup_admin_pending_2fa');
  });
});

describe('login — wrong password', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = undefined;
    process.env.ADMIN_SESSION_SECRET = 'x'.repeat(40);
  });

  it('returns the generic failure and never sets any cookie, 2FA or not', async () => {
    mockUser = {
      id: 'admin-1',
      email: 'jose@levelupstore.mx',
      passwordHash: await hashPassword(PASSWORD),
      active: true,
      totpSecret: null,
    };

    const formData = new FormData();
    formData.set('email', 'jose@levelupstore.mx');
    formData.set('password', 'not the password');

    const result = await login({}, formData);

    expect(result.error).toBeTruthy();
    expect(setSessionCookieMock).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });
});
