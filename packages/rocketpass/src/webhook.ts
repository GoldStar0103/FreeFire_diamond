/**
 * Verifying and parsing a RocketPass webhook delivery.
 *
 * RocketPass signs exactly the way Stripe does (`t=…,v1=…`, HMAC-SHA256 over
 * `"{t}.{raw body}"`) — see RocketPass's own docs — so this reuses
 * `@levelup/payments`'s `verifySignature` rather than re-implementing the
 * same scheme under a different name.
 */

import { verifySignature, type WebhookRejection } from '@levelup/payments';
import { toOrder, type RawOrder } from './client.js';
import type { RocketPassOrder, WebhookEvent } from './types.js';

export type WebhookVerification =
  | { ok: true; event: WebhookEvent }
  | { ok: false; reason: WebhookRejection };

/**
 * `rawBody` must be the exact bytes received — re-serialising a parsed
 * object changes key order/whitespace and the signature will never match.
 */
export function verifyRocketPassWebhook(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
  now?: () => number,
): WebhookVerification {
  const check = verifySignature(rawBody, signatureHeader, secret, { ...(now ? { now } : {}) });
  if (!check.ok) return { ok: false, reason: check.reason! };

  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'malformed_payload' };
  }

  const event = raw as {
    id?: string;
    type?: string;
    created_at?: string;
    data?: { order?: unknown; contract?: Record<string, unknown>; balance?: Record<string, unknown> };
  };

  if (!event.id || !event.type || !event.created_at) return { ok: false, reason: 'malformed_payload' };

  const order: RocketPassOrder | undefined = event.data?.order
    ? toOrder(event.data.order as RawOrder)
    : undefined;

  return {
    ok: true,
    event: {
      id: event.id,
      type: event.type as WebhookEvent['type'],
      createdAt: event.created_at,
      data: {
        ...(order ? { order } : {}),
        ...(event.data?.contract
          ? {
              contract: {
                expiresAt: String(event.data.contract.expires_at ?? ''),
                daysLeft: Number(event.data.contract.days_left ?? 0),
                renewalPriceUsdt:
                  event.data.contract.renewal_price_usdt == null
                    ? null
                    : Number(event.data.contract.renewal_price_usdt),
              },
            }
          : {}),
        ...(event.data?.balance
          ? {
              balance: {
                balanceArs: Number(event.data.balance.balance_ars ?? 0),
                thresholdArs: Number(event.data.balance.threshold_ars ?? 0),
              },
            }
          : {}),
      },
    },
  };
}
