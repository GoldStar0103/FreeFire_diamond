'use server';

import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import {
  adminUsers,
  reviewFxRate,
  reviewPaymentDetails,
  saveFxRate,
  savePaymentDetails,
} from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { readPurposeToken, signPurposeToken, verifyPassword } from '../../../lib/auth';
import { generateSecret, otpauthUri, verifyTotp } from '../../../lib/totp';

export interface SettingsFormState {
  saved?: boolean;
  issues?: string[];
}

/**
 * Where customers send their money, and the rate used to show costs.
 *
 * Saved together because they are one screen to the owner, but validated
 * independently — a wrong exchange rate should not stop him correcting a bank
 * account, which is the urgent one.
 */
export async function saveSettings(
  _prev: SettingsFormState,
  formData: FormData,
): Promise<SettingsFormState> {
  // A server action is a public endpoint; the panel layout's gate does not
  // cover it. This one changes where every customer is told to send money.
  await requireSession();

  const { details, issues: payIssues } = reviewPaymentDetails({
    bank: String(formData.get('bank') ?? ''),
    clabe: String(formData.get('clabe') ?? ''),
    holder: String(formData.get('holder') ?? ''),
    oxxo: String(formData.get('oxxo') ?? ''),
  });

  const { rate, issues: fxIssues } = reviewFxRate(String(formData.get('fxRate') ?? ''));

  const issues = [...payIssues, ...fxIssues];
  if (issues.length > 0 || !details || rate === null) {
    // Nothing is written if anything is wrong. A half-saved payment screen is
    // the failure this whole change exists to remove.
    return { issues: issues.map((i) => i.message) };
  }

  await savePaymentDetails(getDb(), details);
  await saveFxRate(getDb(), rate);

  return { saved: true };
}

// ── two-factor authentication (TOTP) ────────────────────────────────────────

/**
 * Carries `{ adminUserId, secret }` for a secret that has been generated but
 * not yet proven — see `startTotpEnrollment`. Signed with `signPurposeToken`
 * under its own purpose, distinct from the login-2FA pending cookie, so
 * neither can be replayed as the other even though both are short-lived and
 * carry an `adminUserId`.
 */
const PENDING_ENROLL_COOKIE = 'levelup_admin_pending_totp_enroll';
const PENDING_ENROLL_PURPOSE = 'totp-enroll';
const PENDING_ENROLL_TTL_SECONDS = 5 * 60;

export interface TotpStartState {
  secret?: string;
  uri?: string;
  error?: string;
}

/**
 * Generates a new TOTP secret and hands it to the browser to display, but
 * does **not** write it to `admin_users` yet. A secret saved before its owner
 * proves they can generate a matching code risks a self-inflicted lockout on
 * a mis-scanned QR or a fat-fingered manual entry — the database only ever
 * gets a secret that has already produced one correct code.
 */
export async function startTotpEnrollment(
  _prev: TotpStartState,
  _formData: FormData,
): Promise<TotpStartState> {
  const session = await requireSession();

  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set');

  const totpSecret = generateSecret();
  const uri = otpauthUri(totpSecret, session.email);

  const store = await cookies();
  store.set(
    PENDING_ENROLL_COOKIE,
    signPurposeToken({ adminUserId: session.adminUserId, secret: totpSecret }, secret, PENDING_ENROLL_PURPOSE, PENDING_ENROLL_TTL_SECONDS),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: PENDING_ENROLL_TTL_SECONDS,
    },
  );

  return { secret: totpSecret, uri };
}

export interface TotpConfirmState {
  enrolled?: boolean;
  error?: string;
}

/**
 * The confirm step: the admin types back the 6-digit code their app now
 * generates. Only on a real match does `totp_secret` get written — along
 * with `totp_last_step` set to the step that just matched, so that exact
 * code cannot be replayed once 2FA is live.
 */
export async function confirmTotpEnrollment(
  _prev: TotpConfirmState,
  formData: FormData,
): Promise<TotpConfirmState> {
  const session = await requireSession();
  const code = String(formData.get('code') ?? '').trim();

  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set');

  const store = await cookies();
  const pending = readPurposeToken(store.get(PENDING_ENROLL_COOKIE)?.value, secret, PENDING_ENROLL_PURPOSE);

  if (!pending || pending.adminUserId !== session.adminUserId || typeof pending.secret !== 'string') {
    return { error: 'El código expiró. Genera uno nuevo.' };
  }

  const result = verifyTotp(pending.secret, code);
  if (!result.valid) {
    return { error: 'Código incorrecto. Revisa la hora de tu teléfono e inténtalo de nuevo.' };
  }

  await getDb()
    .update(adminUsers)
    .set({ totpSecret: pending.secret, totpLastStep: result.step })
    .where(eq(adminUsers.id, session.adminUserId));

  store.delete(PENDING_ENROLL_COOKIE);

  return { enrolled: true };
}

export interface TotpDisableState {
  disabled?: boolean;
  error?: string;
}

/**
 * Turning 2FA off is destructive — it is the thing standing between a
 * stolen password and the panel — so it is gated behind the current password
 * again, the same bar as changing it.
 */
export async function disableTotp(
  _prev: TotpDisableState,
  formData: FormData,
): Promise<TotpDisableState> {
  const session = await requireSession();
  const password = String(formData.get('password') ?? '');

  const [user] = await getDb()
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.id, session.adminUserId))
    .limit(1);

  if (!user) return { error: 'No se pudo verificar tu cuenta.' };

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { error: 'Contraseña incorrecta.' };

  await getDb()
    .update(adminUsers)
    .set({ totpSecret: null, totpLastStep: null })
    .where(eq(adminUsers.id, session.adminUserId));

  return { disabled: true };
}
