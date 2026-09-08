/**
 * LevelUp Store — catalog source of truth (Phase 0)
 *
 * Every recipe here was transcribed from the client's "CONFIGURACIÓN DE PROMOCIONES"
 * message. Advertised diamond counts carry a provenance tag so we never silently
 * treat a number read off a flyer thumbnail as if the client had confirmed it.
 *
 * This file has no dependency on the provider API — the combo audit runs offline.
 */

/** Garena applies a standing +10% bonus to each base denomination on delivery. */
export const BONUS_PCT = 10;

/** The six commodity SKUs every competitor resells. LevelUp's raw material. */
export const BASE_DENOMINATIONS = [100, 310, 520, 1060, 2180, 5600];

/**
 * Diamonds actually delivered for one base recharge, bonus included.
 * Integer arithmetic — `d * 1.1` is lossy in float (1060 * 1.1 = 1166.0000000000002).
 */
export const deliveredFor = (denomination) => (denomination * (100 + BONUS_PCT)) / 100;

/**
 * Provenance of an advertised diamond count:
 *   'client'   — the client typed the number in chat
 *   'flyer'    — read from the full-resolution flyer the client supplied
 *   'estimate' — read from a low-res thumbnail; MUST be confirmed before launch
 *
 * 'client' and 'flyer' are both authoritative. Only 'estimate' blocks launch.
 */
const CLIENT = 'client';
const FLYER = 'flyer';
const ESTIMATE = 'estimate';

/**
 * Competitor retail pricing (HydraUp, screenshot supplied by the client),
 * keyed by base denomination. These are what a customer pays elsewhere for the
 * same delivered diamonds — the yardstick LevelUp's combos are judged against.
 *
 * NOT provider cost. Real margin still needs the live catalog from Phase 0.
 */
export const MARKET_REFERENCE_MXN = {
  100: 19.02,
  310: 56.76,
  520: 95.84,
  1060: 177.94,
  2180: 353.24,
  5600: 899.19,
};

/** Shorthand: `rep(5600, 3)` -> [5600, 5600, 5600] (three provider calls). */
const rep = (denomination, times) => Array(times).fill(denomination);

export const CAMPAIGNS = [
  {
    key: 'mega_oferta',
    name: 'MEGA OFERTA',
    permanent: true,
    note: 'Entry offer. The trust-breaker for first-time buyers — always active.',
    combos: [
      { key: 'mega_10', name: 'Mega Oferta 110', priceMxn: 10, advertised: 110, advertisedSource: CLIENT, recipe: [100] },
    ],
  },
  {
    key: 'descuentos_chidos',
    name: 'DESCUENTOS CHIDOS',
    permanent: false,
    combos: [
      { key: 'chidos_1700', name: 'Descuentos Chidos 1700', priceMxn: 260, advertised: 1700, advertisedSource: CLIENT, recipe: [1060, 520] },
      { key: 'chidos_3000', name: 'Descuentos Chidos 3000', priceMxn: 400, advertised: 3000, advertisedSource: CLIENT, recipe: [2180, 520, 100] },
      { key: 'chidos_4800', name: 'Descuentos Chidos 4800', priceMxn: 580, advertised: 4800, advertisedSource: CLIENT, recipe: rep(2180, 2) },
    ],
  },
  {
    key: 'lluvia_de_diamantes',
    name: 'LLUVIA DE DIAMANTES',
    permanent: false,
    combos: [
      { key: 'lluvia_2400', name: 'Lluvia de Diamantes 2400', priceMxn: 330, advertised: 2400, advertisedSource: CLIENT, recipe: [2180] },
      { key: 'lluvia_3900', name: 'Lluvia de Diamantes 3900', priceMxn: 500, advertised: 3900, advertisedSource: CLIENT, recipe: [2180, 1060, 310] },
      { key: 'lluvia_6200', name: 'Lluvia de Diamantes 6200', priceMxn: 750, advertised: 6200, advertisedSource: CLIENT, recipe: [5600, 100] },
    ],
  },
  {
    key: 'super_packs',
    name: 'SUPER PACKS',
    permanent: false,
    note: 'Client typed names + prices; diamond counts read from the HD flyer.',
    combos: [
      { key: 'pack_huesito', name: 'Pack Huesito', priceMxn: 185, advertised: 1100, advertisedSource: FLYER, recipe: [1060] },
      { key: 'pack_good', name: 'Pack Good', priceMxn: 455, advertised: 3600, advertisedSource: FLYER, recipe: [2180, 1060] },
      { key: 'pack_insano', name: 'Pack Insano', priceMxn: 860, advertised: 7200, advertisedSource: FLYER, recipe: [5600, 1060] },
      { key: 'pack_prime', name: 'Pack Prime', priceMxn: 1030, advertised: 8500, advertisedSource: FLYER, recipe: [5600, 2180] },
      // HD flyer reads 10,900 — not the 11,000 an earlier thumbnail suggested.
      { key: 'pack_super_prime', name: 'Pack Súper Prime', priceMxn: 1375, advertised: 10900, advertisedSource: FLYER, recipe: [5600, 2180, 2180] },
    ],
  },
  {
    key: 'packs_mega_prime',
    name: 'PACKS MEGA PRIME',
    permanent: false,
    note: 'Advertised counts interpreted from "12k + 200 de Bonus" style labels.',
    combos: [
      { key: 'mega_prime_12k', name: 'Mega Prime 12k +200', priceMxn: 1530, advertised: 12200, advertisedSource: CLIENT, recipe: rep(5600, 2) },
      { key: 'mega_prime_18k', name: 'Mega Prime 18k +300', priceMxn: 2250, advertised: 18300, advertisedSource: CLIENT, recipe: rep(5600, 3) },
      { key: 'mega_prime_24k', name: 'Mega Prime 24k +400', priceMxn: 3050, advertised: 24400, advertisedSource: CLIENT, recipe: rep(5600, 4) },
      { key: 'mega_prime_30k', name: 'Mega Prime 30k +500', priceMxn: 3680, advertised: 30500, advertisedSource: CLIENT, recipe: rep(5600, 5) },
      { key: 'mega_prime_36k', name: 'Mega Prime 36k +600', priceMxn: 4420, advertised: 36600, advertisedSource: CLIENT, recipe: rep(5600, 6) },
      { key: 'mega_prime_42k', name: 'Mega Prime 42k +700', priceMxn: 5050, advertised: 42700, advertisedSource: CLIENT, recipe: rep(5600, 7) },
      { key: 'mega_prime_48k', name: 'Mega Prime 48k +800', priceMxn: 5850, advertised: 48800, advertisedSource: CLIENT, recipe: rep(5600, 8) },
    ],
  },
];

/**
 * Retired campaign, kept so the recipe knowledge is not lost if it rotates back.
 * The client used it as their worked example; the VIP group announced its final
 * 24 hours, so it is not part of the September catalog.
 *
 *   Recargas Locochonas — 2850 x $385 | 5300 x $660 | 7600 x $915
 *   Known recipe: 2850 = 2180 + 310 + 100  (delivers 2,849)
 *   Recipes for 5300 and 7600 were never supplied.
 */
export const RETIRED_CAMPAIGNS = ['recargas_locochonas'];

/** Flat list of every combo, campaign metadata folded in. */
export const ALL_COMBOS = CAMPAIGNS.flatMap((c) =>
  c.combos.map((combo) => ({ ...combo, campaignKey: c.key, campaignName: c.name })),
);

/**
 * Audit one combo: how many provider calls it costs us, what it actually
 * delivers, and whether that falls short of what the customer was promised.
 *
 * @param {object} combo
 * @param {Record<number, number>} [costUsdByDenomination] provider cost per base SKU
 * @param {number} [fxUsdMxn] USD -> MXN rate
 */
export function auditCombo(combo, costUsdByDenomination, fxUsdMxn) {
  const delivered = combo.recipe.reduce((sum, d) => sum + deliveredFor(d), 0);
  const gap = delivered - combo.advertised;

  // What the same delivered diamonds cost at a competitor's retail price.
  // This is the number the customer is implicitly comparing against.
  const marketMxn = combo.recipe.reduce((sum, d) => sum + (MARKET_REFERENCE_MXN[d] ?? 0), 0);
  const savingMxn = marketMxn - combo.priceMxn;

  const audit = {
    ...combo,
    callCount: combo.recipe.length,
    delivered,
    gap,
    shortfall: gap < 0,
    needsConfirmation: combo.advertisedSource === ESTIMATE,
    marketMxn,
    savingMxn,
    savingPct: marketMxn > 0 ? (savingMxn / marketMxn) * 100 : null,
    pricedAboveMarket: savingMxn < 0,
  };

  // Margin needs live provider costs; skip cleanly when Phase 0 hasn't run yet.
  const haveAllCosts =
    costUsdByDenomination && combo.recipe.every((d) => typeof costUsdByDenomination[d] === 'number');

  if (haveAllCosts && typeof fxUsdMxn === 'number') {
    const costUsd = combo.recipe.reduce((sum, d) => sum + costUsdByDenomination[d], 0);
    const costMxn = costUsd * fxUsdMxn;
    const marginMxn = combo.priceMxn - costMxn;
    Object.assign(audit, {
      costUsd,
      costMxn,
      marginMxn,
      marginPct: (marginMxn / combo.priceMxn) * 100,
    });
  }

  return audit;
}

/** Audit every combo at once. */
export const auditAll = (costUsdByDenomination, fxUsdMxn) =>
  ALL_COMBOS.map((c) => auditCombo(c, costUsdByDenomination, fxUsdMxn));

/** Distinct base denominations actually used by the active catalog. */
export const usedDenominations = () =>
  [...new Set(ALL_COMBOS.flatMap((c) => c.recipe))].sort((a, b) => a - b);

/** Highest number of provider calls any single order can require. */
export const maxCallsPerOrder = () => Math.max(...ALL_COMBOS.map((c) => c.recipe.length));
