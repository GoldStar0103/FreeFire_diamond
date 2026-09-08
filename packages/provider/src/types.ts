/**
 * Provider abstraction.
 *
 * The RecargasAmérica API has no idempotency key, no client-supplied reference,
 * and no transactions-list endpoint. When a purchase call times out there is no
 * supported way to ask whether it happened.
 *
 * So `PurchaseOutcome` makes ambiguity a first-class result rather than an
 * exception. A caller cannot accidentally treat a timeout as a failure and
 * retry it — the type system will not let the `ambiguous` case go unhandled.
 */

/**
 * USD in ten-thousandths, matching `numeric(12,4)` in the schema.
 * Provider money never passes through a float.
 */
export type UsdTenK = number & { readonly __brand: 'usd_ten_thousandths' };

export function parseUsd(value: string | number): UsdTenK {
  const text = typeof value === 'number' ? value.toFixed(4) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new RangeError(`Unparseable provider amount: ${JSON.stringify(value)}`);
  }
  const [whole, frac = ''] = text.split('.');
  const sign = text.startsWith('-') ? -1 : 1;
  const digits = (frac + '0000').slice(0, 4);
  const magnitude = Math.abs(Number(whole)) * 10_000 + Number(digits);
  return (sign * magnitude) as UsdTenK;
}

export const formatUsd = (v: UsdTenK): string => (v / 10_000).toFixed(4);

/** Which endpoint fulfils a SKU. Decided by Phase 0, stored on `base_products`. */
export type EndpointKind = 'games' | 'pins_recharge' | 'pins_code';

export interface PurchaseRequest {
  endpointKind: EndpointKind;
  providerProductId: string;
  playerId: string;
  serverId?: string;
  /**
   * Written into the provider's optional `client_name`. Not an idempotency key —
   * the API does not offer one — but it puts our order reference in their panel,
   * which makes manual reconciliation tractable.
   */
  clientReference: string;
}

export type PurchaseOutcome =
  /** Clean success. Diamonds are in the player's account. */
  | {
      kind: 'succeeded';
      providerTransactionId: string;
      providerReference: string | null;
      amountCharged: UsdTenK;
    }
  /** Accepted but not finished. Only `/buy/games` can reach this state. */
  | {
      kind: 'pending';
      providerTransactionId: string;
      providerReference: string;
      amountCharged: UsdTenK;
    }
  /**
   * Definitively did not happen. Safe to retry once the cause is addressed —
   * `retryable` distinguishes a transient cause (no balance) from a permanent
   * one (wrong product type, which is a config bug).
   */
  | {
      kind: 'failed';
      code: string;
      message: string;
      retryable: boolean;
      httpStatus: number | null;
    }
  /**
   * We do not know whether the provider charged us and delivered.
   * NEVER retry this. Resolve it with `resolveAmbiguous` against the wallet
   * balance, and escalate to a human if that is inconclusive.
   */
  | {
      kind: 'ambiguous';
      reason: 'timeout' | 'provider_error' | 'network';
      message: string;
      httpStatus: number | null;
    }
  /**
   * The provider returned redeemable codes instead of topping up the account.
   * This breaks the "recarga directa al ID" premise the whole product rests on,
   * so it is a distinct outcome rather than a success with extra fields.
   */
  | {
      kind: 'delivered_as_code';
      providerTransactionId: string;
      pins: string[];
      amountCharged: UsdTenK;
    };

export interface OrderStatus {
  reference: string;
  status: 'COMPLETED' | 'PENDING';
  /** Populated means codes, not a top-up — the `delivered_as_code` case again. */
  pins: string[];
  /** Null while PENDING; the provider only names the item on completion. */
  product: string | null;
}

export interface PlayerValidation {
  found: boolean;
  /** The in-game nickname. Shown as "¿Eres tú, X?" before taking any money. */
  nickname: string | null;
}

export interface TopupProvider {
  /**
   * Free Fire products the reseller account can sell, from both catalog
   * endpoints. Costs move without notice, so the sync re-reads this and
   * surfaces changes rather than trusting what was stored at seed time.
   */
  listFreeFireCatalog(): Promise<import('./catalog.js').ProviderProduct[]>;

  /** Prepaid wallet, in USD. The only pre-flight signal the API gives us. */
  getBalance(): Promise<UsdTenK>;

  /**
   * Pre-purchase player check. Only available for `pins_recharge` products;
   * throws `ValidationUnsupportedError` otherwise, because a caller silently
   * skipping this would be shipping diamonds to unverified IDs.
   */
  validatePlayer(providerProductId: string, playerId: string): Promise<PlayerValidation>;

  purchase(request: PurchaseRequest): Promise<PurchaseOutcome>;

  /** Poll a `pending` outcome. Only `/buy/games` orders have a reference. */
  getOrderStatus(reference: string): Promise<OrderStatus | null>;
}

export class ValidationUnsupportedError extends Error {
  constructor(providerProductId: string) {
    super(
      `Product ${providerProductId} does not support pre-purchase validation ` +
        `(only type=recharge does). Checkout must fall back to double-entry ` +
        `confirmation of the player ID.`,
    );
    this.name = 'ValidationUnsupportedError';
  }
}
