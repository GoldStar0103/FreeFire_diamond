/**
 * `verifyLoginTotp` with the DB, cookies and `redirect()` mocked out —
 * `../../../lib/auth` and `../../../lib/totp` are real, so this exercises the
 * actual token-reading and TOTP-checking logic, including the anti-replay
 * guard (`totp_last_step`), without a database.
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
vi.mock('../../../lib/session', () => ({ setSessionCookie: setSessionCookieMock }));

let mockUser: Record<string, unknown> | undefined;
// `returning()` mirrors the real compare-and-set: one row back means this
// request won the race and the update actually applied; an empty array means
// the guarded WHERE matched nothing (lost the race — see actions.ts).
let claimedRows: Array<{ id: string }> = [{ id: 'claimed' }];
const returningMock = vi.fn(async () => claimedRows);
const whereMock = vi.fn(() => ({ returning: returningMock }));
const updateSetMock = vi.fn(() => ({ where: whereMock }));
vi.mock('../../../lib/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (mockUser ? [mockUser] : []),
        }),
      }),
    }),
    update: () => ({ set: updateSetMock }),
  }),
}));

vi.mock('@levelup/db', () => ({ adminUsers: { id: 'id-column', totpLastStep: 'totp-last-step-column' } }));

const { signPurposeToken } = await import('../../../lib/auth');
const { totpCode } = await import('../../../lib/totp');
const { verifyLoginTotp } = await import('./actions');

const SECRET = 'x'.repeat(40);
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

function pendingCookie(adminUserId: string, email: string): string {
  return signPurposeToken({ adminUserId, email }, SECRET, 'login-2fa', 300);
}

describe('verifyLoginTotp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = undefined;
    claimedRows = [{ id: 'claimed' }];
    process.env.ADMIN_SESSION_SECRET = SECRET;
  });

  it('accepts a valid code, records the step, and issues a session', async () => {
    const adminUserId = 'admin-verify-1';
    mockUser = {
      id: adminUserId,
      email: 'jose@levelupstore.mx',
      active: true,
      totpSecret: TOTP_SECRET,
      totpLastStep: null,
    };
    cookieStore.get.mockReturnValue({ value: pendingCookie(adminUserId, 'jose@levelupstore.mx') });

    const code = totpCode(TOTP_SECRET);
    const formData = new FormData();
    formData.set('code', code);

    await expect(verifyLoginTotp({}, formData)).rejects.toThrow('REDIRECT:/');

    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ totpLastStep: expect.any(Number) }),
    );
    expect(setSessionCookieMock).toHaveBeenCalledTimes(1);
    expect(cookieStore.delete).toHaveBeenCalledWith('levelup_admin_pending_2fa');
  });

  it('rejects a wrong code without issuing a session', async () => {
    const adminUserId = 'admin-verify-2';
    mockUser = {
      id: adminUserId,
      email: 'ana@levelupstore.mx',
      active: true,
      totpSecret: TOTP_SECRET,
      totpLastStep: null,
    };
    cookieStore.get.mockReturnValue({ value: pendingCookie(adminUserId, 'ana@levelupstore.mx') });

    const formData = new FormData();
    formData.set('code', '000000');

    const result = await verifyLoginTotp({}, formData);

    expect(result.error).toBeTruthy();
    expect(setSessionCookieMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('rejects a code whose step has already been used (anti-replay)', async () => {
    const adminUserId = 'admin-verify-3';
    const at = 1_700_000_000_000;
    const step = Math.floor(at / 1000 / 30);
    mockUser = {
      id: adminUserId,
      email: 'replay@levelupstore.mx',
      active: true,
      totpSecret: TOTP_SECRET,
      // Already recorded as used, as if this exact code was accepted moments ago.
      totpLastStep: step,
    };
    cookieStore.get.mockReturnValue({ value: pendingCookie(adminUserId, 'replay@levelupstore.mx') });

    const code = totpCode(TOTP_SECRET, 30, 6, at);
    const formData = new FormData();
    formData.set('code', code);

    const result = await verifyLoginTotp({}, formData);

    expect(result.error).toBeTruthy();
    expect(setSessionCookieMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('refuses a session when the compare-and-set update loses the race, even with a valid unreplayed code', async () => {
    // Simulates a second request landing between this one's read and write —
    // the guarded UPDATE matches zero rows because something else (another
    // racing request) already advanced totp_last_step past this step first.
    const adminUserId = 'admin-verify-race';
    mockUser = {
      id: adminUserId,
      email: 'race@levelupstore.mx',
      active: true,
      totpSecret: TOTP_SECRET,
      totpLastStep: null,
    };
    cookieStore.get.mockReturnValue({ value: pendingCookie(adminUserId, 'race@levelupstore.mx') });
    claimedRows = [];

    const code = totpCode(TOTP_SECRET);
    const formData = new FormData();
    formData.set('code', code);

    const result = await verifyLoginTotp({}, formData);

    expect(result.error).toBeTruthy();
    expect(setSessionCookieMock).not.toHaveBeenCalled();
  });

  it('sends back to /login when there is no pending cookie', async () => {
    cookieStore.get.mockReturnValue(undefined);

    const formData = new FormData();
    formData.set('code', '123456');

    await expect(verifyLoginTotp({}, formData)).rejects.toThrow('REDIRECT:/login');
    expect(setSessionCookieMock).not.toHaveBeenCalled();
  });

  it('a pending-enrollment token (different purpose) is not accepted as a login-pending token', async () => {
    const adminUserId = 'admin-verify-4';
    mockUser = {
      id: adminUserId,
      email: 'x@levelupstore.mx',
      active: true,
      totpSecret: TOTP_SECRET,
      totpLastStep: null,
    };
    // Signed for the wrong purpose — must not be treated as a valid pending login.
    cookieStore.get.mockReturnValue({
      value: signPurposeToken({ adminUserId, email: 'x@levelupstore.mx' }, SECRET, 'totp-enroll', 300),
    });

    const formData = new FormData();
    formData.set('code', totpCode(TOTP_SECRET));

    await expect(verifyLoginTotp({}, formData)).rejects.toThrow('REDIRECT:/login');
    expect(setSessionCookieMock).not.toHaveBeenCalled();
  });
});
