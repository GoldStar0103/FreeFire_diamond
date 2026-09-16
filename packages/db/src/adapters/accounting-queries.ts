/**
 * Sales/accounting reports for the admin panel — day/week/month/custom-range
 * statements: gross and net sales, recharge cost, an *estimated* payment-
 * platform fee, and a detailed movement history.
 *
 * "Estimated" is not a hedge — there is no Stripe fee tracking in this system
 * (no balance-transaction lookups), so the fee figure is computed from
 * Stripe's own published Mexico rates, not read back from a real charge.
 * Label it that way everywhere it's shown. Exact, per-charge fees are a
 * separate, pricier feature (reading each charge's real balance transaction
 * from Stripe) that this deliberately does not attempt.
 */

import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../index.js';
import { orderItems, orders, payments } from '../schema.js';
import { getFxRate } from './payment-settings.js';
import type { DateRange } from './mexico-city-time.js';

// ── estimated Stripe fee ─────────────────────────────────────────────────────

/**
 * Stripe's published Mexico rates, checked 2026-09-15 against
 * stripe.com/mx/pricing and stripe.com/mx/pricing/local-payment-methods, plus
 * 16% IVA (Mexican law applies VAT to Stripe's own fees). Revisit if Stripe
 * changes these — that's why this lives in one small table, not scattered
 * arithmetic.
 */
const IVA = 1.16;
const STRIPE_FEE_RATES: Record<string, { pct: number; fixedCents: number }> = {
  card: { pct: 0.036, fixedCents: 300 }, // 3.6% + $3.00 MXN
  oxxo: { pct: 0.04, fixedCents: 300 }, // 4% + $3.00 MXN
  spei: { pct: 0, fixedCents: 700 }, // $7.00 MXN flat
};

/** `gateway` is null for the manual comprobante flow — schema.ts's own comment on that column. */
function estimateFeeCents(gateway: string | null, method: string, amountCents: number): number {
  if (gateway !== 'stripe') return 0;
  const rate = STRIPE_FEE_RATES[method];
  if (!rate) return 0; // no published rate for this method yet (e.g. paypal, unimplemented)
  return Math.round((amountCents * rate.pct + rate.fixedCents) * IVA);
}

// ── status buckets, matching the client's own three words ────────────────────

const PENDING_STATUSES = [
  'pending_payment',
  'payment_confirmed',
  'processing',
  'partially_delivered',
  'needs_review',
];
const CANCELLED_STATUSES = ['cancelled', 'payment_expired', 'refund_required'];

export interface AccountingMovement {
  orderNumber: string;
  comboName: string;
  priceMxnCents: number;
  status: string;
  paymentMethod: string | null;
  paymentGateway: string | null;
  costUsd: number | null;
  estimatedFeeCents: number;
  completedAt: Date;
}

export interface AccountingSummary {
  grossSalesCents: number;
  /** Recharge cost, converted to MXN at the current settings rate. */
  recargaCostCents: number;
  /** True when at least one item's cost is missing — recargaCostCents is a floor, not exact. */
  costDataIncomplete: boolean;
  estimatedFeeCents: number;
  netSalesCents: number;
  estimatedProfitCents: number;
  orderCounts: { completed: number; pending: number; cancelled: number };
  totalsByMethod: Array<{ method: string; totalCents: number; count: number }>;
  movements: AccountingMovement[];
}

/**
 * Known, deliberate v1 limitation: the order status machine (see
 * packages/engine/src/states.ts) has no transition from `completed` to a
 * refunded/charged-back state — a dispute on an already-delivered order has
 * nowhere to land today, and would keep counting as revenue here forever.
 * Acceptable to ship without solving; not something to discover by surprise
 * later, so it's written down here rather than only in the design notes.
 */
export async function getAccountingSummary(
  db: Database,
  range: DateRange,
): Promise<AccountingSummary> {
  const fxRate = await getFxRate(db);

  // Order-volume counts: by CREATED date, not completed — a pending order in
  // this range has no completedAt yet, so filtering all three buckets by
  // completedAt would silently drop every non-completed order from the count.
  const statusRows = await db
    .select({ status: orders.status, n: sql<string>`COUNT(*)::text` })
    .from(orders)
    .where(and(gte(orders.createdAt, range.start), lt(orders.createdAt, range.end)))
    .groupBy(orders.status);

  const orderCounts = { completed: 0, pending: 0, cancelled: 0 };
  for (const row of statusRows) {
    const n = Number(row.n);
    if (row.status === 'completed') orderCounts.completed += n;
    else if (PENDING_STATUSES.includes(row.status)) orderCounts.pending += n;
    else if (CANCELLED_STATUSES.includes(row.status)) orderCounts.cancelled += n;
  }

  // Everything below is anchored on completedAt: this is a sales/revenue
  // report, and completed is the FSM's terminal, irreversible recognition
  // point (matches the existing Inicio dashboard tile).
  const completedFilter = and(
    eq(orders.status, 'completed'),
    gte(orders.completedAt, range.start),
    lt(orders.completedAt, range.end),
  );

  const [gross] = await db
    .select({ totalCents: sql<string>`COALESCE(SUM(${orders.priceMxnCents}), 0)::text` })
    .from(orders)
    .where(completedFilter);
  const grossSalesCents = Number(gross?.totalCents ?? 0);

  const costRows = await db
    .select({
      orderId: orderItems.orderId,
      costUsd: orderItems.costUsd,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(completedFilter);

  let costUsdTotal = 0;
  let costDataIncomplete = false;
  const costByOrder = new Map<string, number>();
  for (const row of costRows) {
    // Loose check: a genuinely-null numeric column can come back as either
    // `null` or `undefined` depending on the driver, and both mean "no cost
    // recorded for this item" — never coerce either into NaN via Number().
    if (row.costUsd == null) {
      costDataIncomplete = true;
      continue;
    }
    const usd = Number(row.costUsd);
    costUsdTotal += usd;
    costByOrder.set(row.orderId, (costByOrder.get(row.orderId) ?? 0) + usd);
  }
  const recargaCostCents = Math.round(costUsdTotal * fxRate * 100);

  // The PAID payment per order — never sum across attempts. An order can have
  // a failed/expired try before a successful retry; only the row that
  // actually settled represents real money and a real processor fee.
  const paidRows = await db
    .select({
      orderId: payments.orderId,
      method: payments.method,
      gateway: payments.gateway,
      amountReceivedCents: payments.amountReceivedCents,
    })
    .from(payments)
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(completedFilter, eq(payments.status, 'paid')));

  let estimatedFeeCents = 0;
  const methodTotals = new Map<string, { totalCents: number; count: number }>();
  const feeByOrder = new Map<string, number>();
  const methodByOrder = new Map<string, string>();
  for (const row of paidRows) {
    const amount = row.amountReceivedCents ?? 0;
    const fee = estimateFeeCents(row.gateway, row.method, amount);
    estimatedFeeCents += fee;
    feeByOrder.set(row.orderId, fee);
    methodByOrder.set(row.orderId, row.method);

    const bucket = methodTotals.get(row.method) ?? { totalCents: 0, count: 0 };
    bucket.totalCents += amount;
    bucket.count += 1;
    methodTotals.set(row.method, bucket);
  }

  const netSalesCents = grossSalesCents - recargaCostCents - estimatedFeeCents;

  const movementRows = await db
    .select({
      orderNumber: orders.orderNumber,
      comboSnapshot: orders.comboSnapshot,
      priceMxnCents: orders.priceMxnCents,
      status: orders.status,
      id: orders.id,
      completedAt: orders.completedAt,
    })
    .from(orders)
    .where(completedFilter)
    .orderBy(orders.completedAt);

  const paymentInfoByOrder = new Map(
    paidRows.map((r) => [r.orderId, { method: r.method, gateway: r.gateway }]),
  );

  const movements: AccountingMovement[] = movementRows.map((row) => {
    const snapshot = row.comboSnapshot as { name?: string };
    const payment = paymentInfoByOrder.get(row.id);
    return {
      orderNumber: row.orderNumber,
      comboName: snapshot.name ?? 'Recarga',
      priceMxnCents: row.priceMxnCents,
      status: row.status,
      paymentMethod: payment?.method ?? null,
      paymentGateway: payment?.gateway ?? null,
      costUsd: costByOrder.get(row.id) ?? null,
      estimatedFeeCents: feeByOrder.get(row.id) ?? 0,
      // Safe: completedFilter already requires completedAt to be non-null and in range.
      completedAt: row.completedAt!,
    };
  });

  return {
    grossSalesCents,
    recargaCostCents,
    costDataIncomplete,
    estimatedFeeCents,
    netSalesCents,
    estimatedProfitCents: netSalesCents,
    orderCounts,
    totalsByMethod: [...methodTotals.entries()].map(([method, v]) => ({ method, ...v })),
    movements,
  };
}
