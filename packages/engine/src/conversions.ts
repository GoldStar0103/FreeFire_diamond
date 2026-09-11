/**
 * Reporting paid orders to the ad platform, server-side.
 *
 * Almost every customer arrives from a TikTok or Instagram ad, and the ad
 * account can only optimise towards buyers it is told about. The browser Pixel
 * reports some purchases, but iOS and ad blockers drop a large share, and an
 * OXXO voucher settles hours later with no browser anywhere — so the worker
 * reports every paid storefront order itself, carrying the same `event_id` the
 * browser used so the two are counted once.
 *
 * Rules:
 *
 *   1. Only orders whose payment was actually confirmed. A pending order is
 *      not a sale, and teaching the ad account that it is would optimise the
 *      budget towards people who abandon at the payment step.
 *   2. Never block anything that matters. This runs in the sweep, catches its
 *      own failures, and a dead token costs attribution, not deliveries.
 *   3. Give up eventually. Meta refuses events older than seven days, and a
 *      revoked token fails identically forever; both end in one alert rather
 *      than an alert every thirty seconds.
 */

export interface ConversionOrder {
  orderId: string;
  orderNumber: string;
  eventId: string;
  comboKey: string;
  priceMxnCents: number;
  paidAt: Date;
  playerId: string;
  contactEmail: string | null;
  contactWhatsapp: string | null;
  fbp: string | null;
  fbc: string | null;
  clientIp: string | null;
  userAgent: string;
  attempts: number;
}

export interface ConversionStore {
  /** Paid, unreported storefront orders, oldest first, within the window. */
  findUnreported(input: { paidAfter: Date; maxAttempts: number; limit: number }): Promise<ConversionOrder[]>;
  markReported(orderId: string, at: Date): Promise<void>;
  recordFailedAttempt(orderId: string): Promise<void>;
}

export type ReportOutcome =
  | { ok: true }
  /** `retryable` false means the same request will fail the same way. */
  | { ok: false; retryable: boolean; message: string };

export interface ConversionReporter {
  readonly name: string;
  reportPurchase(order: ConversionOrder): Promise<ReportOutcome>;
}

export interface ConversionAlerter {
  send(level: 'warn' | 'critical', title: string, detail: Record<string, unknown>): Promise<void>;
}

export interface ConversionDeps {
  store: ConversionStore;
  reporter: ConversionReporter;
  alerter: ConversionAlerter;
  now?: () => Date;
  config?: Partial<ConversionConfig>;
}

export interface ConversionConfig {
  /** Meta rejects events older than this. */
  windowMs: number;
  maxAttempts: number;
  batchSize: number;
}

export const defaultConversionConfig: ConversionConfig = {
  windowMs: 7 * 24 * 60 * 60 * 1000,
  maxAttempts: 5,
  batchSize: 25,
};

export interface ConversionResult {
  examined: number;
  reported: number;
  failed: number;
  gaveUp: number;
}

export async function reportConversions(deps: ConversionDeps): Promise<ConversionResult> {
  const config = { ...defaultConversionConfig, ...deps.config };
  const now = (deps.now ?? (() => new Date()))();

  // A few minutes of margin inside Meta's own limit, so an event picked up at
  // the edge of the window is not refused by the time it arrives.
  const paidAfter = new Date(now.getTime() - config.windowMs + 10 * 60_000);
  const pending = await deps.store.findUnreported({
    paidAfter,
    maxAttempts: config.maxAttempts,
    limit: config.batchSize,
  });

  const result: ConversionResult = { examined: pending.length, reported: 0, failed: 0, gaveUp: 0 };

  for (const order of pending) {
    let outcome: ReportOutcome;
    try {
      outcome = await deps.reporter.reportPurchase(order);
    } catch (err) {
      outcome = { ok: false, retryable: true, message: String(err) };
    }

    if (outcome.ok) {
      await deps.store.markReported(order.orderId, now);
      result.reported++;
      continue;
    }

    result.failed++;
    await deps.store.recordFailedAttempt(order.orderId);

    // Retryable failures (Meta down, a timeout) get the full budget. A
    // permanent one — bad token, bad pixel id — will not improve, so it is
    // reported once, loudly, when this order's budget runs out.
    const attemptsNow = order.attempts + 1;
    if (attemptsNow >= config.maxAttempts || !outcome.retryable) {
      if (attemptsNow >= config.maxAttempts) result.gaveUp++;
      if (attemptsNow >= config.maxAttempts || attemptsNow === 1) {
        await deps.alerter.send('warn', `${deps.reporter.name}: purchase not reported`, {
          orderNumber: order.orderNumber,
          attempts: attemptsNow,
          reason: outcome.message.slice(0, 300),
        });
      }
    }

    // A permanent failure is almost always configuration, and every other
    // order in this batch will hit it too. Stop rather than burn their budget.
    if (!outcome.retryable) break;
  }

  return result;
}
