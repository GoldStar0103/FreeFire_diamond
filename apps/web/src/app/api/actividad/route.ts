import { loadHomeActivity } from '../../../lib/home-activity';

export const dynamic = 'force-dynamic';

/** Polled by the home activity strip. Numbers only — no order or account data. */
export async function GET() {
  try {
    const activity = await loadHomeActivity();
    return Response.json(activity, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json(
      { error: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
