/**
 * Server-side customer session access.
 *
 * No Next middleware, same reason as the admin panel's `session.ts`:
 * middleware runs on the Edge runtime, where `node:crypto` is unavailable.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  CUSTOMER_SESSION_COOKIE,
  CUSTOMER_SESSION_TTL_SECONDS,
  readCustomerSessionToken,
  readPurposeToken,
  signPurposeToken,
  type CustomerSessionPayload,
} from './customer-auth.js';

function sessionSecret(): string {
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      'CUSTOMER_SESSION_SECRET is missing or too short (needs 32+ characters). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return secret;
}

export async function getCustomerSession(): Promise<CustomerSessionPayload | null> {
  const store = await cookies();
  return readCustomerSessionToken(store.get(CUSTOMER_SESSION_COOKIE)?.value, sessionSecret());
}

/** For pages that need an account — redirects to the login/signup page instead of rendering logged-out. */
export async function requireCustomerSession(): Promise<CustomerSessionPayload> {
  const session = await getCustomerSession();
  if (!session) redirect('/cuenta');
  return session;
}

export async function setCustomerSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Set behind Caddy in production; relaxed locally so http://localhost works.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: CUSTOMER_SESSION_TTL_SECONDS,
  });
}

export async function clearCustomerSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(CUSTOMER_SESSION_COOKIE);
}

// ── pending signup (verified WhatsApp, no account yet) ──────────────────────

const PENDING_SIGNUP_COOKIE = 'levelup_pending_signup';
const PENDING_SIGNUP_PURPOSE = 'pending-signup';
const PENDING_SIGNUP_TTL_SECONDS = 10 * 60;

export async function setPendingSignupCookie(whatsapp: string): Promise<void> {
  const token = signPurposeToken({ whatsapp }, sessionSecret(), PENDING_SIGNUP_PURPOSE, PENDING_SIGNUP_TTL_SECONDS);
  const store = await cookies();
  store.set(PENDING_SIGNUP_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: PENDING_SIGNUP_TTL_SECONDS,
  });
}

/** The WhatsApp number a visitor proved they control via OTP, or null if that never happened (or expired). */
export async function getPendingSignupWhatsapp(): Promise<string | null> {
  const store = await cookies();
  const payload = readPurposeToken(store.get(PENDING_SIGNUP_COOKIE)?.value, sessionSecret(), PENDING_SIGNUP_PURPOSE);
  const whatsapp = payload?.whatsapp;
  return typeof whatsapp === 'string' ? whatsapp : null;
}

export async function clearPendingSignupCookie(): Promise<void> {
  const store = await cookies();
  store.delete(PENDING_SIGNUP_COOKIE);
}
