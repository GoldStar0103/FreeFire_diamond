/**
 * RocketPass (rocketpass.store) vendor API — types from its OpenAPI spec.
 *
 * Deliberately excludes the `level_pass` item kind (`level_pass_complete`,
 * `lvl_6`…`lvl_30`, `level_pass_custom`) — that is RocketPass's own Free Fire
 * battle-pass product, unrelated to and confusingly named like LevelUp
 * Store's own Level Pass loyalty feature. Only `gift` (pass/crate/token) and
 * `membership` (weekly_basic/weekly/monthly) items are modelled here; see the
 * new-features plan's own note on this.
 *
 * Everything RocketPass prices is in ARS (Argentine pesos) — there is no USD
 * or MXN field anywhere except `Contrato.renewal_price_usdt`, which is the
 * license's own monthly renewal, not anything a customer pays.
 */

/** The storefront items this integration actually sells. */
export type RocketPassItem = 'pass' | 'crate' | 'token' | 'weekly_basic' | 'weekly' | 'monthly';

export type RocketPassRegion = 'SAC' | 'US';

export type RocketPassOrderStatus = 'PENDING' | 'PROCESSING' | 'DELIVERED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';

export interface CatalogItem {
  item: RocketPassItem;
  name: string;
  kind: 'gift' | 'membership';
  priceArs: number;
  maxQuantity: number;
  available: boolean;
  /** Null for membership items — RocketPass tracks no per-region stock for those. */
  stockByRegion: Partial<Record<RocketPassRegion, number>> | null;
  affordableUnits: number;
}

export interface Catalog {
  items: CatalogItem[];
  regions: { code: RocketPassRegion; name: string }[];
  balanceArs: number;
  currency: string;
}

export interface CreateOrderInput {
  item: RocketPassItem;
  /** 6–14 digits. */
  targetUid: string;
  /** Default 1. Max 1 for `pass` and memberships; max 500 for `crate`/`token`. */
  quantity?: number;
  /** Ignored for memberships. Default `SAC`. */
  region?: RocketPassRegion;
  targetNickname?: string;
  giftMessage?: string;
  /** Our own order number, echoed back — what ties their order to ours. */
  reference: string;
  /** Sent as the `Idempotency-Key` header, not the body. */
  idempotencyKey: string;
}

export interface RocketPassOrder {
  orderId: string;
  status: RocketPassOrderStatus;
  item: RocketPassItem;
  itemName: string;
  quantity: number;
  delivered: number;
  targetUid: string;
  targetNickname: string | null;
  region: RocketPassRegion | null;
  unitPriceArs: number;
  totalArs: number;
  refundedArs: number;
  chargedArs: number;
  reference: string | null;
  test: boolean;
  createdAt: string;
  completedAt: string | null;
}

/**
 * `GET /players/{uid}` — confirmed against a real live-key call 2026-11-26
 * (both a matching and a mismatched `region`, and an unknown uid): `success`
 * is `true` even when the player isn't found — `valid`/`found` are the real
 * answer, `error` is a human (Spanish) message set only then. `region` is
 * always the account's own real region regardless of what was requested;
 * `regionMismatch`/`suggestedRegion` exist so a caller doesn't have to
 * special-case "did I ask for the right one" itself. Costs nothing extra to
 * call — it's a plain read, not a deduction against the account balance.
 */
export interface PlayerLookup {
  uid: string;
  valid: boolean;
  found: boolean;
  nickname: string | null;
  level: number | null;
  /** The account's real region, regardless of what `region` was requested with. */
  region: RocketPassRegion;
  requestedRegion: RocketPassRegion;
  regionMismatch: boolean;
  regionAutocorrected: boolean;
  /** Only set when `regionMismatch` — per RocketPass's own docs, send the order with this one. */
  suggestedRegion: RocketPassRegion | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  clanName: string | null;
  /** Human (Spanish) message, e.g. explaining a region correction. Not an error. */
  warning: string | null;
  /** Human (Spanish) message set when `valid`/`found` is false. */
  error: string | null;
}

export interface CreateOrderResult {
  order: RocketPassOrder;
  /** True when RocketPass itself queued the order rather than processing it inline. */
  queued: boolean;
  queueCode: 'large_order' | 'high_demand' | null;
  retryAfterSeconds: number | null;
  balanceArs: number;
}

/** RocketPass's `error.code` values worth branching on; others pass through as strings. */
export type RocketPassErrorCode =
  | 'MISSING_API_KEY'
  | 'INVALID_API_KEY'
  | 'INSUFFICIENT_BALANCE'
  | 'CONTRACT_EXPIRED'
  | 'DAILY_LIMIT_REACHED'
  | 'LICENSE_DISABLED'
  | 'IP_NOT_ALLOWED'
  | 'PERMISSION_DENIED'
  | 'ITEM_NOT_ALLOWED'
  | 'ITEM_DISABLED'
  | 'OUT_OF_STOCK'
  | 'DUPLICATE_ORDER'
  | 'IDEMPOTENCY_IN_PROGRESS'
  | 'ORDER_REJECTED'
  | 'INVALID_UID'
  | 'INVALID_QUANTITY'
  | 'INVALID_REGION'
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'WRONG_ENDPOINT'
  | 'ORDER_NOT_FOUND'
  | 'RATE_LIMIT'
  | 'INTERNAL'
  | 'MAINTENANCE';

/** Thrown by every client call that doesn't get a `success: true` envelope back. */
export class RocketPassError extends Error {
  constructor(
    message: string,
    readonly code: RocketPassErrorCode | string,
    readonly httpStatus: number,
    /** 429/500/503 are worth retrying; everything else (a bad request, a disabled item) is not. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RocketPassError';
  }
}

/** Thrown when the HTTP call itself failed (network error, timeout) before any envelope arrived. */
export class RocketPassUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RocketPassUnreachableError';
  }
}

export interface WebhookEvent {
  id: string;
  type:
    | 'order.delivered'
    | 'order.partial'
    | 'order.failed'
    | 'contract.expiring'
    | 'contract.expired'
    | 'contract.renewed'
    | 'balance.low';
  createdAt: string;
  data: {
    order?: RocketPassOrder;
    contract?: { expiresAt: string; daysLeft: number; renewalPriceUsdt: number | null };
    balance?: { balanceArs: number; thresholdArs: number };
  };
}
