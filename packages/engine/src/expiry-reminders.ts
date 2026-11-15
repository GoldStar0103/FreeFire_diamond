/**
 * Warning a customer their payment window is about to close.
 *
 * One reminder window for every payment method, not one tuned per method's
 * own TTL (2h for card/SPEI, 48h for transfer/OXXO — see `paymentTtlMsFor`):
 * the spec only ever specifies the instant-method case ("90 min" into a 2h
 * window, i.e. 30 min before it closes), so this applies that same 30-minute
 * margin uniformly rather than guessing an unstated number for the manual
 * methods.
 *
 * Only ever reaches an order that has a linked account — a guest checkout has
 * no bell to ring, same gate every other notification in this module uses.
 */

export interface ExpiringPayment {
  orderId: string;
  orderNumber: string;
}

export interface ExpiryReminderStore {
  /**
   * Pending payments whose deadline falls inside the reminder window from
   * now, for an order with a linked account that has not already been
   * reminded. All of that filtering belongs in the query so a caller cannot
   * accidentally widen it — see the implementation's own comment.
   */
  findExpiringPayments(now: Date, windowMs: number, limit: number): Promise<ExpiringPayment[]>;
  /** Idempotent — see the `(order_id, type)` unique index backing this. */
  sendReminder(orderId: string): Promise<void>;
}

export interface ExpiryReminderConfig {
  windowMs: number;
  batchSize: number;
}

export const defaultExpiryReminderConfig: ExpiryReminderConfig = {
  windowMs: 30 * 60_000,
  batchSize: 50,
};

export interface ExpiryReminderDeps {
  store: ExpiryReminderStore;
  config?: Partial<ExpiryReminderConfig>;
  now?: () => Date;
}

export interface ExpiryReminderResult {
  examined: number;
  reminded: number;
  failed: number;
}

export async function sendExpiryReminders(deps: ExpiryReminderDeps): Promise<ExpiryReminderResult> {
  const config = { ...defaultExpiryReminderConfig, ...deps.config };
  const now = (deps.now ?? (() => new Date()))();
  const expiring = await deps.store.findExpiringPayments(now, config.windowMs, config.batchSize);

  let reminded = 0;
  let failed = 0;

  for (const payment of expiring) {
    try {
      await deps.store.sendReminder(payment.orderId);
      reminded++;
    } catch (err) {
      // One bad row must not stop the rest — the next sweep gets another go.
      failed++;
      console.error(`[expiry-reminders] Could not remind ${payment.orderNumber}: ${String(err)}`);
    }
  }

  return { examined: expiring.length, reminded, failed };
}
