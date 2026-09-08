/**
 * Money handling.
 *
 * Two currencies with different roles: revenue is MXN (fixed monthly by flyer),
 * provider cost is USD (a prepaid wallet). The gap between them is live FX
 * exposure — prices are locked for a month while cost floats.
 *
 * MXN is stored and passed around as integer centavos. Floats never touch money:
 * `0.1 + 0.2 !== 0.3`, and `1060 * 1.1 === 1166.0000000000002`.
 */

export type Centavos = number & { readonly __brand: 'centavos' };

const isSafeInteger = (n: number) => Number.isInteger(n) && Number.isSafeInteger(n);

/** Pesos -> centavos. Rejects sub-centavo input rather than rounding silently. */
export function pesosToCentavos(pesos: number): Centavos {
  const cents = Math.round(pesos * 100);
  if (Math.abs(pesos * 100 - cents) > 1e-9) {
    throw new RangeError(`Price ${pesos} MXN is finer than one centavo`);
  }
  return cents as Centavos;
}

export const centavosToPesos = (c: Centavos): number => c / 100;

/** "$1,530.00" — the format the flyers and the storefront both use. */
export const formatMxn = (c: Centavos): string =>
  new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(
    centavosToPesos(c),
  );

export function addCentavos(...values: Centavos[]): Centavos {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (!isSafeInteger(total)) throw new RangeError('Centavo overflow');
  return total as Centavos;
}

/**
 * Provider cost in USD, converted at the configured rate.
 *
 * The rate is a setting the client maintains, not a live feed — margins are
 * reviewed deliberately rather than drifting between page loads.
 */
export function usdToCentavos(usd: number, fxUsdMxn: number): Centavos {
  if (!(fxUsdMxn > 0)) throw new RangeError(`Invalid FX rate: ${fxUsdMxn}`);
  return Math.round(usd * fxUsdMxn * 100) as Centavos;
}

export interface Margin {
  priceCents: Centavos;
  costCents: Centavos;
  marginCents: Centavos;
  marginPct: number;
}

export function computeMargin(
  priceCents: Centavos,
  costUsd: number,
  fxUsdMxn: number,
): Margin {
  const costCents = usdToCentavos(costUsd, fxUsdMxn);
  const marginCents = (priceCents - costCents) as Centavos;
  return {
    priceCents,
    costCents,
    marginCents,
    marginPct: priceCents === 0 ? 0 : (marginCents / priceCents) * 100,
  };
}

// ── diamonds ──────────────────────────────────────────────────────────────────

/**
 * Diamonds delivered for one base recharge, Garena's +10% bonus included.
 * Integer arithmetic throughout — see the float note above.
 */
export const deliveredDiamonds = (base: number, bonusPct = 10): number =>
  (base * (100 + bonusPct)) / 100;

/**
 * A combo must never deliver less than its flyer advertises. Three of the
 * nineteen September combos did; the admin panel blocks publishing on this.
 */
export function checkRecipe(
  advertised: number,
  recipe: readonly number[],
  bonusPct = 10,
): { delivered: number; gap: number; ok: boolean } {
  const delivered = recipe.reduce((sum, d) => sum + deliveredDiamonds(d, bonusPct), 0);
  const gap = delivered - advertised;
  return { delivered, gap, ok: gap >= 0 };
}
