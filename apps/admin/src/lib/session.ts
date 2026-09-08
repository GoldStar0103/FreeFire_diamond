/**
 * Server-side session access.
 *
 * The gate lives in the panel layout as a server component rather than in
 * middleware: middleware runs on the Edge runtime, where `node:crypto` is
 * unavailable, and rewriting the HMAC against Web Crypto to satisfy a routing
 * detail would be the tail wagging the dog.
 */

import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { readSessionToken, SESSION_COOKIE, type SessionPayload } from './auth';

function sessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    // Failing loudly beats silently accepting forged cookies.
    throw new Error(
      'ADMIN_SESSION_SECRET is missing or too short (needs 32+ characters). ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return secret;
}

export async function getSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  return readSessionToken(store.get(SESSION_COOKIE)?.value, sessionSecret());
}

/** Use in every panel route. Redirects to the login page when unauthenticated. */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Set behind Caddy in production; relaxed locally so http://localhost works.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 12 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
