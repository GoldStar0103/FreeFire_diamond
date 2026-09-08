/**
 * Provider catalog parsing.
 *
 * The provider exposes Free Fire across two endpoints with three delivery
 * behaviours, and its product names are free text. Turning that into the six
 * base denominations LevelUp actually builds combos from is guesswork on
 * strings, so it lives here — one implementation, tested, shared by both the
 * Phase 0 discovery script and the catalog sync.
 */

import type { EndpointKind, UsdTenK } from './types.js';
import { parseUsd } from './types.js';

/** The six commodity SKUs every competitor also resells. */
export const BASE_DENOMINATIONS = [100, 310, 520, 1060, 2180, 5600] as const;

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
 * Pull a diamond count out of a product name.
 *
 * Handles "1060 Diamonds", "1.060 Diamantes", "2180💎", "Free Fire (MY) 5600".
 * A number adjacent to a diamond word wins; otherwise the first value matching
 * a known denomination is taken, which avoids "(MY)" or a region code being
 * mistaken for a quantity.
 */
export function extractDiamonds(text: unknown): number | null {
  if (text === null || text === undefined) return null;

  // Collapse thousands separators: "1.060" and "1,060" both mean 1060.
  const normalised = String(text).replace(/(\d)[.,](\d{3})\b/g, '$1$2');

  const adjacent = normalised.match(/(\d{2,6})\s*(?:x\s*)?(?:💎|diamond|diamante|dias?\b)/i);
  if (adjacent?.[1]) return Number(adjacent[1]);

  const numbers = [...normalised.matchAll(/\d{2,6}/g)].map((m) => Number(m[0]));
  return numbers.find((n) => (BASE_DENOMINATIONS as readonly number[]).includes(n)) ?? null;
}

interface RawGameProduct {
  id?: number | string;
  game?: string;
  package?: string;
  price?: number | string;
  input_fields?: Array<{ name?: string; label?: string }>;
}

interface RawPinProduct {
  id?: number | string;
  sku?: string;
  name?: string;
  type?: string;
  price?: number | string;
}

const safeUsd = (value: unknown): UsdTenK | null => {
  if (value === null || value === undefined) return null;
  try {
    return parseUsd(value as string | number);
  } catch {
    return null;
  }
};

/** `/products/games` — direct top-up, pollable, but no pre-purchase validation. */
export function normaliseGameProduct(raw: RawGameProduct): ProviderProduct {
  const name = [raw.game, raw.package].filter(Boolean).join(' ');
  const inputFields = Array.isArray(raw.input_fields) ? raw.input_fields : [];

  return {
    providerProductId: String(raw.id ?? ''),
    endpointKind: 'games',
    name,
    sku: null,
    diamondsBase: extractDiamonds(name),
    costUsd: safeUsd(raw.price),
    requiresServerId: inputFields.some((f) => /server/i.test(`${f.label ?? ''} ${f.name ?? ''}`)),
    // /pins/validate rejects anything that is not a pins recharge product.
    canValidate: false,
    raw,
  };
}

/** `/products/pins` — `type` decides whether this is a top-up or a code. */
export function normalisePinProduct(raw: RawPinProduct): ProviderProduct {
  const name = raw.name ?? raw.sku ?? '';
  const isRecharge = raw.type === 'recharge';

  return {
    providerProductId: String(raw.id ?? ''),
    endpointKind: isRecharge ? 'pins_recharge' : 'pins_code',
    name,
    sku: raw.sku ?? null,
    diamondsBase: extractDiamonds(`${name} ${raw.sku ?? ''}`),
    costUsd: safeUsd(raw.price),
    requiresServerId: false,
    canValidate: isRecharge,
    raw,
  };
}

/**
 * Pick the best product for a denomination.
 *
 * Preference order matters commercially, not just technically:
 *   1. `pins_recharge` — direct top-up AND a nickname check before charging
 *   2. `games`         — direct top-up, but the customer confirms their own ID
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
