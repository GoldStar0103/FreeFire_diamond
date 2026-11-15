/**
 * Golden Tickets: a second, non-seasonal reward currency earned alongside
 * Level Points on every delivered order, spent entering giveaways (Module 2).
 *
 * Deliberately a pure function with no store dependency, same spirit as
 * `decideLevelPassOutcome` — the amount is a function of the LP an order
 * already earned, nothing more, so it is awarded/reversed inline wherever LP
 * already is (`level-pass-store.ts`'s `applyDecision`,
 * `order-reversal-store.ts`) instead of a second pipeline.
 */

/**
 * Golden Tickets = the order's awarded LP rounded to the nearest ten (5 rounds
 * up). An order worth fewer than 5 LP earns 0 tickets.
 *
 * Examples straight from the spec: 47 -> 50, 132 -> 130, 45 -> 50, 44 -> 40,
 * 8 -> 10, 4 -> 0.
 */
export function ticketsForLp(lp: number): number {
  return Math.floor((Math.max(0, lp) + 5) / 10) * 10;
}
