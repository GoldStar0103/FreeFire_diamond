import { NextResponse } from 'next/server';
import { markNotificationsRead } from '@levelup/db';
import { getCustomerSession } from '../../../../lib/customer-session';
import { getDb } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const session = await getCustomerSession();
  if (!session) return NextResponse.json({ ok: false }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { ids?: string[]; all?: boolean } | null;
  const ids = body?.all ? 'all' : (body?.ids ?? []);
  await markNotificationsRead(getDb(), session.playerProfileId, ids);
  return NextResponse.json({ ok: true });
}
