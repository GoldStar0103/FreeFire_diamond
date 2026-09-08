/**
 * Order state machine.
 *
 * Transitions are declared, not implied by whichever code path happens to run.
 * An order touching real money should never reach a state nobody designed —
 * `assertTransition` turns that from a subtle data bug into a loud crash.
 */

export type OrderStatus =
  | 'pending_payment'
  | 'payment_confirmed'
  | 'processing'
  | 'partially_delivered'
  | 'completed'
  | 'payment_expired'
  | 'needs_review'
  | 'refund_required'
  | 'cancelled';

export type OrderItemStatus =
  | 'queued'
  | 'sending'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'provider_pending';

/** Terminal for the fulfilment worker — nothing it does moves these on. */
export const TERMINAL_ORDER_STATUSES = new Set<OrderStatus>([
  'completed',
  'cancelled',
  'payment_expired',
]);

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ['payment_confirmed', 'payment_expired', 'cancelled'],
  // amount_mismatch on a confirmed payment sends it straight to review.
  payment_confirmed: ['processing', 'needs_review', 'cancelled'],
  processing: ['partially_delivered', 'completed', 'needs_review'],
  // A partially delivered order can resume and finish, or stall for a human.
  partially_delivered: ['processing', 'completed', 'needs_review'],
  // Review can end in completion (admin fulfilled it), a refund, or resumption.
  needs_review: ['processing', 'partially_delivered', 'completed', 'refund_required', 'cancelled'],
  refund_required: ['cancelled', 'needs_review'],
  completed: [],
  payment_expired: ['cancelled'],
  cancelled: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean =>
  from === to || TRANSITIONS[from].includes(to);

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal order transition: ${from} -> ${to}`);
  }
}

export interface ItemView {
  status: OrderItemStatus;
  attemptCount: number;
}

/**
 * Derive an order's status from its items.
 *
 * Order matters. `unknown` and exhausted retries outrank everything, because an
 * order that looks "completed" while one item is unresolved is the exact failure
 * the client is worried about — a customer paid, and nobody noticed a gap.
 */
export function deriveOrderStatus(items: readonly ItemView[], maxAttempts: number): OrderStatus {
  if (items.length === 0) throw new Error('Cannot derive status for an order with no items');

  const has = (s: OrderItemStatus) => items.some((i) => i.status === s);
  const succeeded = items.filter((i) => i.status === 'succeeded').length;

  // Unresolved ambiguity always wins. Never let it hide behind a partial success.
  if (has('unknown')) return 'needs_review';

  // A failure that has burned all its retries is not going to fix itself.
  if (items.some((i) => i.status === 'failed' && i.attemptCount >= maxAttempts)) {
    return 'needs_review';
  }

  if (succeeded === items.length) return 'completed';
  if (has('sending') || has('provider_pending')) return 'processing';
  if (succeeded > 0) return 'partially_delivered';
  return 'processing';
}

/** Progress for the customer-facing tracker: "6,160 / 49,280 entregados". */
export function deliveryProgress(
  items: readonly (ItemView & { diamonds: number })[],
): { delivered: number; total: number; pct: number } {
  const total = items.reduce((sum, i) => sum + i.diamonds, 0);
  const delivered = items
    .filter((i) => i.status === 'succeeded')
    .reduce((sum, i) => sum + i.diamonds, 0);
  return { delivered, total, pct: total === 0 ? 0 : (delivered / total) * 100 };
}
