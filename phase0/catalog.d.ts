/** Types for catalog.mjs, so the seed script consumes it type-safely. */

export type AdvertisedSource = 'client' | 'flyer' | 'estimate';

export interface Combo {
  key: string;
  name: string;
  priceMxn: number;
  advertised: number;
  advertisedSource: AdvertisedSource;
  /** Base denominations in call order. Repeated entries mean repeated calls. */
  recipe: number[];
}

export interface Campaign {
  key: string;
  name: string;
  permanent: boolean;
  note?: string;
  combos: Combo[];
}

export interface ComboAudit extends Combo {
  campaignKey: string;
  campaignName: string;
  callCount: number;
  delivered: number;
  gap: number;
  shortfall: boolean;
  needsConfirmation: boolean;
  marketMxn: number;
  savingMxn: number;
  savingPct: number | null;
  pricedAboveMarket: boolean;
  costUsd?: number;
  costMxn?: number;
  marginMxn?: number;
  marginPct?: number;
}

export declare const BONUS_PCT: number;
export declare const BASE_DENOMINATIONS: number[];
export declare const MARKET_REFERENCE_MXN: Record<number, number>;
export declare const CAMPAIGNS: Campaign[];
export declare const ALL_COMBOS: (Combo & { campaignKey: string; campaignName: string })[];
export declare const RETIRED_CAMPAIGNS: string[];
export declare function deliveredFor(denomination: number): number;
export declare function auditCombo(
  combo: Combo,
  costUsdByDenomination?: Record<number, number>,
  fxUsdMxn?: number,
): ComboAudit;
export declare function auditAll(
  costUsdByDenomination?: Record<number, number>,
  fxUsdMxn?: number,
): ComboAudit[];
export declare function usedDenominations(): number[];
export declare function maxCallsPerOrder(): number;
