'use server';

import { cookies } from 'next/headers';
import { NOTICE_SEEN_COOKIE } from '../lib/account-notices';
import { getCustomerSession } from '../lib/customer-session';

/** Clears the unread marker for this account on this browser. */
export async function markNoticesRead(): Promise<void> {
  const session = await getCustomerSession();
  if (!session) return;
  const store = await cookies();
  store.set(NOTICE_SEEN_COOKIE, `${session.playerProfileId}|${Date.now()}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 180,
  });
}
