'use server';

import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminUsers } from '@levelup/db';
import { getDb } from '../../lib/db';
import { createSessionToken, signPurposeToken, verifyPassword } from '../../lib/auth';
import { clearSessionCookie, setSessionCookie } from '../../lib/session';
import { PENDING_2FA_COOKIE, PENDING_2FA_PURPOSE, PENDING_2FA_TTL_SECONDS } from './pending-2fa';

export interface LoginState {
  error?: string;
}

/** Same message for every failure — never reveal whether an email exists. */
const GENERIC_FAILURE = 'Correo o contraseña incorrectos.';

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) return { error: 'Ingresa tu correo y contraseña.' };

  const [user] = await getDb()
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.email, email))
    .limit(1);

  // Hash even when the user does not exist, so response time does not leak
  // which addresses are registered.
  const stored = user?.passwordHash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88);
  const valid = await verifyPassword(password, stored);

  if (!user || !valid || !user.active) return { error: GENERIC_FAILURE };

  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error('ADMIN_SESSION_SECRET is not set');

  if (user.totpSecret) {
    // Password is correct, but the second factor is not proven yet — do not
    // issue a real session. A short-lived pending cookie carries identity to
    // the verify step; nothing here grants panel access on its own.
    const store = await cookies();
    store.set(
      PENDING_2FA_COOKIE,
      signPurposeToken({ adminUserId: user.id, email: user.email }, secret, PENDING_2FA_PURPOSE, PENDING_2FA_TTL_SECONDS),
      {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: PENDING_2FA_TTL_SECONDS,
      },
    );
    redirect('/login/verify');
  }

  await setSessionCookie(
    createSessionToken({ adminUserId: user.id, email: user.email }, secret),
  );

  redirect('/');
}

export async function logout(): Promise<void> {
  await clearSessionCookie();
  redirect('/login');
}
