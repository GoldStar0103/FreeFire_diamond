/**
 * Ad attribution, captured at the moment an order is created.
 *
 * Almost every buyer arrives from a TikTok or Instagram ad, and the ad account
 * only learns which ads sell if purchases are reported back. The browser Pixel
 * does part of that, but iOS and ad blockers drop a large share of it — so the
 * worker also reports each paid order server-side (Conversions API), and that
 * report is only matchable if it carries what the browser had: the `_fbp` and
 * `_fbc` cookies the Pixel set, the IP and the user agent.
 *
 * They are captured here rather than at payment time because an OXXO voucher
 * settles hours later, from Stripe's servers, with no browser anywhere near it.
 */

import 'server-only';
import { cookies, headers } from 'next/headers';
import { callerIp } from './server';

export interface TrackingContext {
  fbp: string | null;
  fbc: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

/** `fb.1.<ms>.<random>` — anything else is not a Pixel cookie and is dropped. */
const FB_COOKIE = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_.-]{1,500}$/;

export async function trackingContext(): Promise<TrackingContext> {
  const [jar, h] = await Promise.all([cookies(), headers()]);
  const fbp = jar.get('_fbp')?.value ?? null;
  const fbc = jar.get('_fbc')?.value ?? null;
  const ip = await callerIp();

  return {
    fbp: fbp && FB_COOKIE.test(fbp) ? fbp : null,
    fbc: fbc && FB_COOKIE.test(fbc) ? fbc : null,
    clientIp: ip === 'unknown' ? null : ip,
    userAgent: h.get('user-agent')?.slice(0, 512) ?? null,
  };
}
