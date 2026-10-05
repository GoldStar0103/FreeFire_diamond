/**
 * Provider catalog parsing.
 *
 * RecargasAmérica retired the old two-endpoint catalog (`/products/games` +
 * `/products/pins`) on 2026-09-20 in favour of one unified `/products/catalog`
 * — the "catálogo unificado" that had existed as an additive BETA since
 * 2026-09-11 (see recargasamerica.ts's own doc comment) suddenly became the
 * only option, with no migration window. The three delivery behaviours this
 * module has always cared about still exist, just distinguished by
 * `type`/`required_fields` instead of by which endpoint a row came from:
 *
 *   - `type: "recharge"`, `required_fields: ["manual_id"]` — direct top-up to
 *     the player's account, WITH pre-purchase validation (`pins_recharge`).
 *     Was the only Free Fire diamond family on 2026-09-20; later removed from
 *     the live catalog in favour of the `player_id` family below.
 *   - `type: "recharge"`, `required_fields: ["player_id"]` — direct top-up
 *     (`games`). As of 2026-10-05 this is what the live catalog actually
 *     returns for the six diamond packs, and `/catalog/validate` reports
 *     `supported:true` for those ids (confirmed against product id 5).
 *   - anything else (`type: "pin"`) — a redeemable code, not a top-up
 *     (`pins_code`) — never sold as a recarga, same as before.
 *
 * `canValidate` follows what `/catalog/validate` actually supports today, not
 * the 2026-09-20 snapshot that had `supported:false` for the `player_id`
 * family. Leaving that flag false after the provider dropped `manual_id`
 * SKUs left the storefront with zero active validatable products and blocked
 * every checkout at step 1.
 *
 * Its product names are still free text. Turning that into the six base
 * denominations LevelUp actually builds combos from is guesswork on strings,
 * so it lives here — one implementation, tested, shared by both the Phase 0
 * discovery script and the catalog sync.
 */

import type { EndpointKind, UsdTenK } from './types.js';
import { parseUsd } from './types.js';

/** The six commodity SKUs every competitor also resells. */
export const BASE_DENOMINATIONS = [100, 310, 520, 1060, 2180, 5600] as const;

/**
 * Delivered amount (base + Garena's 10% bonus) for each base denomination,
 * exactly as confirmed live on 2026-09-09 — see `phase0/out/REPORT.md`:
 * 100->110, 310->341, 520->572, 1060->1166, 2180->2398, 5600->6160.
 *
 * The provider's product names have named the *base* count so far ("1060
 * Diamonds"), which is what `extractDiamonds` was written against. Their
 * 2026-09-15 catalog change is exactly the kind of rename that could switch
 * to naming what actually lands in the account instead ("1166 Diamantes"), and
 * a number that isn't one of the six base denominations currently falls
 * through as unparseable — silently dropping that SKU from the sync. Mapping
 * a delivered figure back to its base keeps that rename from taking a
 * denomination offline.
 */
const DELIVERED_TO_BASE = new Map<number, number>(
  BASE_DENOMINATIONS.map((base) => [Math.round(base * 1.1), base]),
);

/** `n` if it's already a base denomination, or the base it delivers, else null. */
const resolveDenomination = (n: number): number | null =>
  (BASE_DENOMINATIONS as readonly number[]).includes(n) ? n : (DELIVERED_TO_BASE.get(n) ?? null);

export interface ProviderProduct {
  providerProductId: string;
  endpointKind: EndpointKind;
  name: string;
  sku: string | null;
  /** Face value before Garena's +10% bonus. Null when the name is unparseable. */
  diamondsBase: number | null;
  costUsd: UsdTenK | null;
  requiresServerId: boolean;
  canValidate: boolean;
  /** The untouched provider row, kept for audit and for fields we do not model. */
  raw: unknown;
}

export const isFreeFire = (text: unknown): boolean =>
  /free\s*fire|\bff\b/i.test(String(text ?? ''));

/**
 * Pull a diamond count out of a product name, as the *base* denomination.
 *
 * Handles "1060 Diamonds", "1.060 Diamantes", "2180💎", "Free Fire (MY) 5600",
 * and a name quoting the delivered (post-bonus) figure instead, e.g. "1166
 * Diamantes" for the 1,060 product. A number adjacent to a diamond word wins;
 * otherwise the first value resolving to a known denomination is taken, which
 * avoids "(MY)" or a region code being mistaken for a quantity.
 */
export function extractDiamonds(text: unknown): number | null {
  if (text === null || text === undefined) return null;

  // Collapse thousands separators: "1.060" and "1,060" both mean 1060.
  const normalised = String(text).replace(/(\d)[.,](\d{3})\b/g, '$1$2');

  // A number adjacent to a diamond word wins outright — including one that
  // isn't a base denomination itself, e.g. "2180💎" — but a delivered figure
  // among those is still resolved back to its base, so "110 Diamantes" maps
  // to the 100-diamond product rather than being treated as an unknown SKU.
  const adjacent = normalised.match(/(\d{2,6})\s*(?:x\s*)?(?:💎|diamond|diamante|dias?\b)/i);
  if (adjacent?.[1]) {
    const n = Number(adjacent[1]);
    return resolveDenomination(n) ?? n;
  }

  const numbers = [...normalised.matchAll(/\d{2,6}/g)].map((m) => Number(m[0]));
  for (const n of numbers) {
    const resolved = resolveDenomination(n);
    if (resolved !== null) return resolved;
  }
  return null;
}

interface RawCatalogProduct {
  id?: number | string;
  sku?: string;
  name?: string;
  /** "recharge" or "pin" — orthogonal to `required_fields`, see module doc. */
  type?: string;
  price?: number | string;
  required_fields?: string[];
}

const safeUsd = (value: unknown): UsdTenK | null => {
  if (value === null || value === undefined) return null;
  try {
    return parseUsd(value as string | number);
  } catch {
    return null;
  }
};

/**
 * `/products/catalog` — the unified endpoint. `type` + `required_fields`
 * together decide which of the three delivery behaviours a row is; see the
 * module doc comment for what each combination means and how that was
 * confirmed.
 */
export function normaliseCatalogProduct(raw: RawCatalogProduct): ProviderProduct {
  const name = raw.name ?? raw.sku ?? '';
  const fields = Array.isArray(raw.required_fields) ? raw.required_fields : [];
  const isRecharge = raw.type === 'recharge';
  const isDirectToAccount = isRecharge && fields.includes('manual_id');

  if (isRecharge && fields.includes('player_id') && !fields.includes('manual_id')) {
    return {
      providerProductId: String(raw.id ?? ''),
      endpointKind: 'games',
      name,
      sku: raw.sku ?? null,
      diamondsBase: extractDiamonds(name),
      costUsd: safeUsd(raw.price),
      requiresServerId: fields.some((f) => /server/i.test(f)),
      // Live /catalog/validate returns supported:true for these diamond packs
      // (2026-10-05). Checkout looks up active+canValidate; false here bricks
      // every ID check even though fulfilment still works.
      canValidate: true,
      raw,
    };
  }

  return {
    providerProductId: String(raw.id ?? ''),
    endpointKind: isDirectToAccount ? 'pins_recharge' : 'pins_code',
    name,
    sku: raw.sku ?? null,
    diamondsBase: extractDiamonds(`${name} ${raw.sku ?? ''}`),
    costUsd: safeUsd(raw.price),
    requiresServerId: false,
    canValidate: isDirectToAccount,
    raw,
  };
}

/**
 * Pick the best product for a denomination.
 *
 * Preference order matters commercially, not just technically:
 *   1. `pins_recharge` — direct top-up (manual_id family), when the provider
 *      still lists it
 *   2. `games`         — direct top-up (player_id family); also validatable on
 *      today's catalog
 *   3. `pins_code`     — a redeemable code, which is not the product LevelUp sells
 */
export function rankProduct(product: ProviderProduct): number {
  if (product.endpointKind === 'pins_recharge') return 0;
  if (product.endpointKind === 'games') return 1;
  return 2;
}

export interface DenominationMatch {
  denomination: number;
  chosen: ProviderProduct | null;
  alternatives: ProviderProduct[];
}

/** Map the six base denominations onto the provider's Free Fire catalog. */
export function mapDenominations(products: ProviderProduct[]): DenominationMatch[] {
  return BASE_DENOMINATIONS.map((denomination) => {
    const candidates = products
      .filter((p) => p.diamondsBase === denomination)
      .sort((a, b) => rankProduct(a) - rankProduct(b));

    return {
      denomination,
      chosen: candidates[0] ?? null,
      alternatives: candidates.slice(1),
    };
  });
}
