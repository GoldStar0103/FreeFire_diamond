'use server';

/**
 * Mi LevelUp: email OTP sign-in and account creation.
 *
 * Three steps, each its own action: request a code, verify it, and — only
 * for an email with no account yet — supply the Free Fire ID to create one.
 * See customer-session.ts's "pending signup" cookie for why step three
 * cannot simply trust a hidden form field carrying the email.
 */

import {
  awardFounderBadgeIfEligible,
  consumeOtpCode,
  createOtpCode,
  createPlayerProfile,
  findActiveOtpCode,
  findProfileByEmail,
  incrementOtpAttempts,
} from '@levelup/db';
import {
  createCustomerSessionToken,
  generateOtpCode,
  hashOtpCode,
  normaliseEmail,
  verifyOtpCode,
} from '../../lib/customer-auth.js';
import {
  clearPendingSignupCookie,
  getPendingSignupEmail,
  setCustomerSessionCookie,
  setPendingSignupCookie,
} from '../../lib/customer-session.js';
import { getDb, otpRequestLimiter } from '../../lib/server.js';
import { buildEmailSender } from '../../lib/email-sender.js';
import { verifyPlayerId } from '../../lib/player-validation.js';

const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;

function otpSecret(): string {
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('CUSTOMER_SESSION_SECRET is missing or too short (needs 32+ characters)');
  }
  return secret;
}

// ── step 1: request a code ───────────────────────────────────────────────────

export interface RequestOtpState {
  status: 'idle' | 'sent' | 'error';
  email?: string;
  message?: string;
}

export async function requestOtp(_prev: RequestOtpState, formData: FormData): Promise<RequestOtpState> {
  const email = normaliseEmail(String(formData.get('email') ?? ''));
  if (!email) {
    return { status: 'error', message: 'Escribe un correo válido.' };
  }

  const decision = otpRequestLimiter.check(email);
  if (!decision.allowed) {
    return {
      status: 'error',
      message: `Ya pedimos varios códigos a este correo. Espera ${Math.ceil(decision.retryAfterMs / 1000)} segundos.`,
    };
  }

  const code = generateOtpCode();
  const codeHash = hashOtpCode(code, otpSecret());
  await createOtpCode(getDb(), email, codeHash, new Date(Date.now() + OTP_TTL_MS));

  try {
    await buildEmailSender().sendOtpCode(email, code);
  } catch (err) {
    console.error(`[cuenta] Could not send OTP to ${email}: ${String(err)}`);
    return { status: 'error', message: 'No pudimos enviar el código. Intenta de nuevo en un momento.' };
  }

  return { status: 'sent', email };
}

// ── step 2: verify it ─────────────────────────────────────────────────────────

export interface VerifyOtpState {
  status: 'idle' | 'logged_in' | 'need_player_id' | 'error';
  email?: string;
  message?: string;
}

export async function verifyOtp(_prev: VerifyOtpState, formData: FormData): Promise<VerifyOtpState> {
  const email = normaliseEmail(String(formData.get('email') ?? ''));
  const code = String(formData.get('code') ?? '').trim();
  if (!email || !/^\d{6}$/.test(code)) {
    return email
      ? { status: 'error', email, message: 'Escribe el código de 6 dígitos.' }
      : { status: 'error', message: 'Escribe un correo válido.' };
  }

  const db = getDb();
  const active = await findActiveOtpCode(db, email);
  if (!active) {
    return { status: 'error', email, message: 'El código expiró o no existe. Pide uno nuevo.' };
  }
  if (active.attempts >= OTP_MAX_ATTEMPTS) {
    return { status: 'error', email, message: 'Demasiados intentos con este código. Pide uno nuevo.' };
  }

  if (!verifyOtpCode(code, active.codeHash, otpSecret())) {
    await incrementOtpAttempts(db, active.id);
    return { status: 'error', email, message: 'Código incorrecto.' };
  }

  // Compare-and-set: if a concurrent request already consumed this exact
  // code (two tabs submitting the same code at once), only one succeeds.
  if (!(await consumeOtpCode(db, active.id))) {
    return { status: 'error', email, message: 'Ese código ya se usó. Pide uno nuevo.' };
  }

  const profile = await findProfileByEmail(db, email);
  if (profile) {
    const token = createCustomerSessionToken(
      { playerProfileId: profile.id, playerId: profile.playerId },
      otpSecret(),
    );
    await setCustomerSessionCookie(token);
    return { status: 'logged_in' };
  }

  // Proven control of this mailbox, but no account yet — the address the
  // code was actually sent to, carried forward for completeSignup to trust
  // instead of a bare form field. See customer-session.ts's own comment.
  await setPendingSignupCookie(email);
  return { status: 'need_player_id', email };
}

// ── step 3: create the account (new emails only) ─────────────────────────────

export interface CheckPlayerIdState {
  status: 'idle' | 'found' | 'error';
  playerId?: string;
  nickname?: string | null;
  message?: string;
}

/**
 * Preview before committing — same reason checkout shows the nickname
 * before charging anything: a player ID is a string of digits with no
 * other confirmation, and seeing your own in-game name is both the typo
 * check and the proof the account is real.
 *
 * Purely a preview. completeSignup below re-validates independently and
 * never trusts a nickname carried in from the form — same as checkout's
 * own placeOrder never trusting the client for exactly that reason.
 */
export async function checkPlayerId(
  _prev: CheckPlayerIdState,
  formData: FormData,
): Promise<CheckPlayerIdState> {
  const playerId = String(formData.get('playerId') ?? '').trim();
  const verification = await verifyPlayerId(playerId);
  if (!verification.ok) {
    return { status: 'error', message: verification.message };
  }
  return { status: 'found', playerId, nickname: verification.nickname };
}

export interface CompleteSignupState {
  status: 'idle' | 'done' | 'error';
  message?: string;
}

export async function completeSignup(_prev: CompleteSignupState, formData: FormData): Promise<CompleteSignupState> {
  const email = await getPendingSignupEmail();
  if (!email) {
    return { status: 'error', message: 'Tu verificación expiró. Vuelve a pedir un código.' };
  }

  const playerId = String(formData.get('playerId') ?? '').trim();

  // Checked against the provider, not just the digit-count shape: an ID
  // that was never real stays wrong for this account's whole lifetime —
  // every future recharge and every Level Pass reward — not just one order.
  const verification = await verifyPlayerId(playerId);
  if (!verification.ok) {
    return { status: 'error', message: verification.message };
  }

  const db = getDb();
  const result = await createPlayerProfile(db, { playerId, email });
  if (!result.ok) {
    return {
      status: 'error',
      message:
        result.reason === 'player_id_taken'
          ? 'Ese ID de Free Fire ya tiene una cuenta LevelUp.'
          : 'Ese correo ya tiene una cuenta LevelUp.',
    };
  }

  await awardFounderBadgeIfEligible(db, result.profile.id);

  const token = createCustomerSessionToken(
    { playerProfileId: result.profile.id, playerId: result.profile.playerId },
    otpSecret(),
  );
  await setCustomerSessionCookie(token);
  await clearPendingSignupCookie();

  return { status: 'done' };
}
