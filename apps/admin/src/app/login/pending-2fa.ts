/**
 * Constants for the pending-2FA cookie shared between the password step
 * (`login/actions.ts`), the verify step (`login/verify/actions.ts` and
 * `login/verify/page.tsx`).
 *
 * Not a `'use server'` file: those may only export async functions, and these
 * are plain constants read from both server actions and a server component.
 */

/**
 * Carries `{ adminUserId, email }` between the password step and the TOTP
 * step for an admin who has 2FA enabled. Deliberately a separate cookie from
 * `SESSION_COOKIE`, signed with `signPurposeToken` (not `createSessionToken`)
 * so it can never itself function as a logged-in session — see auth.ts.
 */
export const PENDING_2FA_COOKIE = 'levelup_admin_pending_2fa';
export const PENDING_2FA_PURPOSE = 'login-2fa';
/**
 * Five minutes: long enough to open an authenticator app, short enough that
 * an abandoned login attempt does not leave a usable half-session lying
 * around.
 */
export const PENDING_2FA_TTL_SECONDS = 5 * 60;
