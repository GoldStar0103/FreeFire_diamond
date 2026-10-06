'use server';

/**
 * Mi LevelUp: WhatsApp OTP sign-in and account creation.
 *
 * Three steps, each its own action: request a code, verify it, and — only
 * for a WhatsApp number with no account yet — supply the Free Fire ID to
 * create one. See customer-session.ts's "pending signup" cookie for why step
 * three cannot simply trust a hidden form field carrying the WhatsApp number.
 */

import {
  awardFounderBadgeIfEligible,
  consumeOtpCode,
  createOtpCode,
  createPlayerProfile,
  findActiveOtpCode,
  findProfileByWhatsapp,
  incrementOtpAttempts,
} from '@levelup/db';
import {
  createCustomerSessionToken,
  generateOtpCode,
  hashOtpCode,
  normaliseWhatsapp,
  verifyOtpCode,
} from '../../lib/customer-auth.js';
import {
  clearPendingSignupCookie,
  getPendingSignupWhatsapp,
  setCustomerSessionCookie,
  setPendingSignupCookie,
} from '../../lib/customer-session.js';
import { getDb, otpRequestLimiter } from '../../lib/server.js';
import { buildWhatsAppSender } from '../../lib/whatsapp-sender.js';

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
  whatsapp?: string;
  message?: string;
}

export async function requestOtp(_prev: RequestOtpState, formData: FormData): Promise<RequestOtpState> {
  const whatsapp = normaliseWhatsapp(String(formData.get('whatsapp') ?? ''));
  if (!whatsapp) {
    return { status: 'error', message: 'Escribe un número de WhatsApp válido.' };
  }

  const decision = otpRequestLimiter.check(whatsapp);
  if (!decision.allowed) {
    return {
      status: 'error',
      message: `Ya pedimos varios códigos a este número. Espera ${Math.ceil(decision.retryAfterMs / 1000)} segundos.`,
    };
  }

  const code = generateOtpCode();
  const codeHash = hashOtpCode(code, otpSecret());
  await createOtpCode(getDb(), whatsapp, codeHash, new Date(Date.now() + OTP_TTL_MS));

  try {
    await buildWhatsAppSender().sendOtpCode(whatsapp, code);
  } catch (err) {
    console.error(`[cuenta] Could not send OTP to +${whatsapp}: ${String(err)}`);
    return { status: 'error', message: 'No pudimos enviar el código. Intenta de nuevo en un momento.' };
  }

  return { status: 'sent', whatsapp };
}

// ── step 2: verify it ─────────────────────────────────────────────────────────

export interface VerifyOtpState {
  status: 'idle' | 'logged_in' | 'need_player_id' | 'error';
  whatsapp?: string;
  message?: string;
}

export async function verifyOtp(_prev: VerifyOtpState, formData: FormData): Promise<VerifyOtpState> {
  const whatsapp = normaliseWhatsapp(String(formData.get('whatsapp') ?? ''));
  const code = String(formData.get('code') ?? '').trim();
  if (!whatsapp || !/^\d{6}$/.test(code)) {
    return whatsapp
      ? { status: 'error', whatsapp, message: 'Escribe el código de 6 dígitos.' }
      : { status: 'error', message: 'Escribe un número de WhatsApp válido.' };
  }

  const db = getDb();
  const active = await findActiveOtpCode(db, whatsapp);
  if (!active) {
    return { status: 'error', whatsapp, message: 'El código expiró o no existe. Pide uno nuevo.' };
  }
  if (active.attempts >= OTP_MAX_ATTEMPTS) {
    return { status: 'error', whatsapp, message: 'Demasiados intentos con este código. Pide uno nuevo.' };
  }

  if (!verifyOtpCode(code, active.codeHash, otpSecret())) {
    await incrementOtpAttempts(db, active.id);
    return { status: 'error', whatsapp, message: 'Código incorrecto.' };
  }

  // Compare-and-set: if a concurrent request already consumed this exact
  // code (two tabs submitting the same code at once), only one succeeds.
  if (!(await consumeOtpCode(db, active.id))) {
    return { status: 'error', whatsapp, message: 'Ese código ya se usó. Pide uno nuevo.' };
  }

  const profile = await findProfileByWhatsapp(db, whatsapp);
  if (profile) {
    const token = createCustomerSessionToken(
      { playerProfileId: profile.id, playerId: profile.playerId },
      otpSecret(),
    );
    await setCustomerSessionCookie(token);
    return { status: 'logged_in' };
  }

  // Proven control of this WhatsApp number, but no account yet — the ID the
  // code was actually sent to, carried forward for completeSignup to trust
  // instead of a bare form field. See customer-session.ts's own comment.
  await setPendingSignupCookie(whatsapp);
  return { status: 'need_player_id', whatsapp };
}

// ── step 3: create the account (new WhatsApp numbers only) ──────────────────

export interface CompleteSignupState {
  status: 'idle' | 'done' | 'error';
  message?: string;
}

export async function completeSignup(_prev: CompleteSignupState, formData: FormData): Promise<CompleteSignupState> {
  const whatsapp = await getPendingSignupWhatsapp();
  if (!whatsapp) {
    return { status: 'error', message: 'Tu verificación expiró. Vuelve a pedir un código.' };
  }

  const playerId = String(formData.get('playerId') ?? '').trim();
  if (!/^\d{6,15}$/.test(playerId)) {
    return { status: 'error', message: 'El ID de Free Fire debe tener entre 6 y 15 números.' };
  }

  const db = getDb();
  const result = await createPlayerProfile(db, { playerId, whatsapp });
  if (!result.ok) {
    return {
      status: 'error',
      message:
        result.reason === 'player_id_taken'
          ? 'Ese ID de Free Fire ya tiene una cuenta LevelUp.'
          : 'Ese número de WhatsApp ya tiene una cuenta LevelUp.',
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
