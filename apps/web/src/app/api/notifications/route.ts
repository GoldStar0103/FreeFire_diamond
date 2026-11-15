/**
 * What the site header's bell polls — see `notification-bell.tsx`. No
 * realtime push exists anywhere in this app (see the new-features plan), so
 * the client calls this every ~25s instead of holding a connection open.
 */

import { NextResponse } from 'next/server';
import { listMyNotifications } from '@levelup/db';
import { getCustomerSession } from '../../../lib/customer-session';
import { getDb } from '../../../lib/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCustomerSession();
  if (!session) return NextResponse.json({ unreadCount: 0, items: [] });

  const result = await listMyNotifications(getDb(), session.playerProfileId);
  return NextResponse.json(result);
}
