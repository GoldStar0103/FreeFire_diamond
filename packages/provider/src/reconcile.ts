/**
 * Wallet-delta reconciliation.
 *
 * The provider API has no idempotency key and no way to look up a transaction
 * by our own reference. When a purchase call times out, the only evidence
 * available is the prepaid wallet balance: if it dropped by the price of the
 * item, the purchase went through.
 *
 * This is only sound while exactly one provider call is in flight globally.
 * The worker enforces that with a Postgres advisory lock; without it, a
 * concurrent purchase muddies the balance and every ambiguous call resolves to
 * `indeterminate`. That failure mode is safe — it escalates to a human rather
 * than guessing — but it makes the system useless, so the lock is not optional.
 */

import type { UsdTenK } from './types.js';

export type AmbiguousResolution =
  /** Balance fell by the expected amount — treat the purchase as succeeded. */
  | { verdict: 'charged'; observedDelta: UsdTenK }
  /** Balance did not move — the call never reached the provider. Safe to retry. */
  | { verdict: 'not_charged'; observedDelta: UsdTenK }
  /**
   * The balance moved by an amount we cannot explain. Never guess with money:
   * freeze the order, alert an admin, reconcile against the provider panel.
   */
  | { verdict: 'indeterminate'; observedDelta: UsdTenK; reason: string };

/**
 * Tolerance for balance comparison, in ten-thousandths of a dollar.
 * Absorbs provider-side rounding without being wide enough to confuse two
 * different SKUs — the cheapest denomination costs far more than $0.01.
 */
const TOLERANCE: UsdTenK = 100 as UsdTenK; // $0.0100

export interface ReconcileInput {
  /** Balance read immediately before the call, committed to the DB first. */
  balanceBefore: UsdTenK;
  /** Balance read after the ambiguous outcome. */
  balanceAfter: UsdTenK;
  /** What this item should cost, from the synced provider catalog. */
  expectedCost: UsdTenK;
}

export function resolveAmbiguous(input: ReconcileInput): AmbiguousResolution {
  const { balanceBefore, balanceAfter, expectedCost } = input;
  const observedDelta = (balanceBefore - balanceAfter) as UsdTenK;

  if (expectedCost <= 0) {
    return {
      verdict: 'indeterminate',
      observedDelta,
      reason: `Expected cost is ${expectedCost}; cannot reconcile against a non-positive price.`,
    };
  }

  // Balance went UP. A refund, a top-up by the client mid-order, or a stale
  // read. Whatever it is, we cannot infer delivery from it.
  if (observedDelta < -TOLERANCE) {
    return {
      verdict: 'indeterminate',
      observedDelta,
      reason: 'Balance increased during the call — a concurrent top-up or refund.',
    };
  }

  if (Math.abs(observedDelta) <= TOLERANCE) {
    return { verdict: 'not_charged', observedDelta };
  }

  if (Math.abs(observedDelta - expectedCost) <= TOLERANCE) {
    return { verdict: 'charged', observedDelta };
  }

  // The balance moved by something other than this item's price. Most likely a
  // concurrent call slipped past the advisory lock — which is a bug worth
  // knowing about, not something to paper over with a best guess.
  return {
    verdict: 'indeterminate',
    observedDelta,
    reason:
      `Balance moved by ${observedDelta / 10_000} USD but this item costs ` +
      `${expectedCost / 10_000} USD. Another call was probably in flight.`,
  };
}

/**
 * Whether an ambiguous outcome may be retried automatically.
 *
 * Only ever true when the balance proves the call never landed. Anything else
 * risks double-delivering diamonds at LevelUp's expense, and diamonds cannot be
 * clawed back once they reach a player's account.
 */
export const isSafeToRetry = (r: AmbiguousResolution): boolean => r.verdict === 'not_charged';

/**
 * Pre-flight check before dispatching an order's remaining items.
 *
 * Free Fire products expose no stock or availability field, so wallet balance
 * is the only signal we get. Running out mid-combo leaves a customer paid-up
 * and partially delivered, so the queue pauses as a whole rather than failing
 * paid orders one at a time.
 */
export function hasSufficientBalance(
  balance: UsdTenK,
  remainingCost: UsdTenK,
  reserveFloor: UsdTenK = 0 as UsdTenK,
): { ok: boolean; shortfall: UsdTenK } {
  const available = (balance - reserveFloor) as UsdTenK;
  const shortfall = Math.max(0, remainingCost - available) as UsdTenK;
  return { ok: shortfall === 0, shortfall };
}
