/**
 * RecargasAmérica client.
 *
 * Implements the same `TopupProvider` interface as the simulator, so every
 * scenario in the failure matrix exercises the code path production uses.
 *
 * The error mapping is the substance here. Getting it wrong in either direction
 * is expensive: treat an ambiguous timeout as a failure and you double-deliver
 * diamonds you cannot claw back; treat a definitive failure as ambiguous and
 * every hiccup lands on an admin's desk.
 *
 * `/products/games`, `/products/pins` and `/pins/validate` were retired
 * without notice on 2026-09-20 in favour of the unified `/products/catalog` +
 * `/catalog/validate` — see catalog.ts's own doc comment for how the unified
 * shape was reverse-engineered against the live API (no public docs found for
 * it). `/buy/games` and `/buy/pins` were still answering normally at first
 * (real orders completed minutes after that migration), so purchase was left
 * untouched at first — but RA extended the retirement to them too a couple of
 * hours later, confirmed both by real orders failing in production
 * (`ENDPOINT_DISABLED`) and by a deliberately safe empty-body probe against
 * `/buy/pins` returning the same "Este endpoint fue dado de baja."
 *
 * The replacement is `/buy/catalog`. Its required fields were found the same
 * safe way as `/catalog/validate`'s — reading the "missing field" errors from
 * incomplete requests, never a request complete enough to actually purchase
 * something:
 *
 *   POST /buy/catalog {}                    -> "product id es requerido"
 *   POST /buy/catalog {product_id:5}        -> {"error":"Campo requerido: manual_id","code":"MISSING_FIELD"}
 *
 * `product_id` is unchanged from the old `/buy/pins` body. The player-id field
 * was renamed `redemption_id` -> `manual_id`, matching the field name
 * `/products/catalog` itself declares in `required_fields` for this product
 * family — see catalog.ts. The probe deliberately stopped there rather than
 * supplying a real player id alongside a real product id, which risks
 * actually completing a purchase; `client_name` was kept as before (already
 * documented as optional) since nothing indicated otherwise. The `games`
 * family (`/buy/games`, unused by any of today's combos) is migrated the same
 * way but its exact contract past `product_id` is NOT empirically confirmed —
 * only mirrored from `/products/catalog`'s own declared `required_fields:
 * ["player_id"]` for that family, since there is no live traffic to safely
 * probe it against.
 */

import {
  parseUsd,
  ValidationUnsupportedError,
  type EndpointKind,
  type OrderStatus,
  type PlayerValidation,
  type PurchaseOutcome,
  type PurchaseRequest,
  type TopupProvider,
  type UsdTenK,
} from './types.js';
import { isFreeFire, normaliseCatalogProduct, type ProviderProduct } from './catalog.js';

interface RawCatalogRow {
  id?: number | string;
  sku?: string;
  name?: string;
  type?: string;
  price?: number | string;
  required_fields?: string[];
}

export interface RecargasAmericaOptions {
  baseUrl?: string;
  apiKey: string;
  timeoutMs?: number;
  /** Injected so the failure matrix can drive the real client too. */
  fetchImpl?: typeof fetch;
  onApiCall?: (record: ApiCallRecord) => void;
}

export interface ApiCallRecord {
  method: string;
  path: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  httpStatus: number | null;
  durationMs: number;
  error?: string;
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
}

/** Thrown for genuinely unexpected shapes — never for a documented failure. */
export class ProviderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderProtocolError';
  }
}

export class RecargasAmericaProvider implements TopupProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onApiCall: ((record: ApiCallRecord) => void) | undefined;

  constructor(options: RecargasAmericaOptions) {
    if (!options.apiKey) throw new Error('RecargasAmérica API key is required');
    this.baseUrl = (options.baseUrl ?? 'https://panel.recargasamerica.com/api/v1').replace(
      /\/+$/,
      '',
    );
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onApiCall = options.onApiCall;
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<
    | { ok: true; data: T; httpStatus: number }
    | { ok: false; httpStatus: number; code: string | null; message: string }
    | { ok: false; httpStatus: null; code: null; message: string; transport: true }
  > {
    const started = Date.now();
    const record: ApiCallRecord = {
      method,
      path,
      httpStatus: null,
      durationMs: 0,
      ...(body === undefined ? {} : { requestPayload: body }),
    };

    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const text = await res.text();
      let parsed: Envelope<T> | null = null;
      try {
        parsed = JSON.parse(text) as Envelope<T>;
      } catch {
        /* non-JSON body is itself the finding — keep the text below */
      }

      record.httpStatus = res.status;
      record.durationMs = Date.now() - started;
      record.responsePayload = parsed ?? text.slice(0, 2000);
      this.onApiCall?.(record);

      if (res.ok && parsed?.success && parsed.data !== undefined) {
        return { ok: true, data: parsed.data, httpStatus: res.status };
      }

      return {
        ok: false,
        httpStatus: res.status,
        code: parsed?.code ?? null,
        message: parsed?.error ?? `HTTP ${res.status}`,
      };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      record.durationMs = Date.now() - started;
      record.error = isTimeout ? `timeout after ${this.timeoutMs}ms` : String(err);
      this.onApiCall?.(record);

      return { ok: false, httpStatus: null, code: null, message: record.error, transport: true };
    }
  }

  async listFreeFireCatalog(): Promise<ProviderProduct[]> {
    const res = await this.call<RawCatalogRow[]>('GET', '/products/catalog');
    if (!res.ok) throw new ProviderProtocolError(`Could not list catalog: ${res.message}`);

    // The unified catalog covers every game this reseller account can sell,
    // not just Free Fire — the filter is load-bearing, not tidiness.
    return res.data
      .filter((p) => isFreeFire(`${p.name} ${p.sku}`))
      .map(normaliseCatalogProduct);
  }

  async getBalance(): Promise<UsdTenK> {
    const res = await this.call<{ balance: number | string; currency: string }>('GET', '/wallet');
    if (!res.ok) throw new ProviderProtocolError(`Could not read wallet: ${res.message}`);
    return parseUsd(res.data.balance);
  }

  async validatePlayer(providerProductId: string, playerId: string): Promise<PlayerValidation> {
    const attempt = () =>
      this.call<{ supported: boolean; status: boolean; account_name: string | null }>(
        'POST',
        '/catalog/validate',
        { product_id: coerceId(providerProductId), service_user_id: playerId },
      );

    let res = await attempt();

    // The provider's own lookup is observably flaky on a brand-new player ID:
    // the exact same request that just failed reliably succeeds on an
    // immediate retry, which is otherwise indistinguishable from "come back
    // later" to a first-time buyer deciding whether this store is real. One
    // silent retry here is cheaper than losing that buyer to a false alarm —
    // never retried again after this, so a genuinely dead endpoint still
    // surfaces as an error rather than doubling every request's latency.
    //
    // Unlike the old /pins/validate, a capability rejection is not a
    // transport-level failure any more — it comes back as `res.ok` with
    // `supported: false` (handled below) — so unconditionally retrying a real
    // `!res.ok` here is correct: there is no longer a definitive-failure case
    // hiding inside it worth skipping the retry for.
    if (!res.ok) {
      res = await attempt();
    }

    if (!res.ok) {
      throw new ProviderProtocolError(`Validation failed: ${res.message}`);
    }

    // Capability check: /catalog/validate sets supported:false for product
    // families that cannot look up a nickname (e.g. redeemable pins). Direct
    // diamond recharges — both manual_id and player_id — return supported:true
    // on the live catalog as of 2026-10-05; see catalog.ts.
    if (!res.data.supported) {
      throw new ValidationUnsupportedError(providerProductId);
    }

    return res.data.status
      ? { found: true, nickname: res.data.account_name }
      : { found: false, nickname: null };
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
    const { path, body } = buildPurchaseBody(request);
    const res = await this.call<PurchaseResponse>('POST', path, body);

    if (!res.ok) return mapPurchaseFailure(res);

    const data = res.data;
    const amountCharged = parseUsd(data.amount_charged ?? 0);
    const txId = String(data.transaction_id);

    // Codes rather than a top-up. Distinct outcome — see types.ts.
    if (Array.isArray(data.pins) && data.pins.length > 0) {
      return { kind: 'delivered_as_code', providerTransactionId: txId, pins: data.pins, amountCharged };
    }

    if (data.status === 'PENDING') {
      if (!data.reference) {
        // PENDING with no reference is unpollable and therefore unrecoverable.
        return {
          kind: 'ambiguous',
          reason: 'provider_error',
          message: 'Provider returned PENDING without a reference; status cannot be polled.',
          httpStatus: res.httpStatus,
        };
      }
      return {
        kind: 'pending',
        providerTransactionId: txId,
        providerReference: data.reference,
        amountCharged,
      };
    }

    return {
      kind: 'succeeded',
      providerTransactionId: txId,
      providerReference: data.reference ?? null,
      amountCharged,
    };
  }

  async getOrderStatus(reference: string): Promise<OrderStatus | null> {
    const res = await this.call<{
      reference: string;
      status: string;
      pins?: string[];
      product?: string | null;
    }>('GET', `/orders/${encodeURIComponent(reference)}`);

    if (!res.ok) {
      if (res.httpStatus === 404) return null;
      throw new ProviderProtocolError(`Could not read order ${reference}: ${res.message}`);
    }

    return {
      reference: res.data.reference,
      status: res.data.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING',
      pins: res.data.pins ?? [],
      product: res.data.product ?? null,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface PurchaseResponse {
  transaction_id: number | string;
  reference?: string;
  status?: string;
  amount_charged?: number | string;
  pins?: string[];
  api_data?: unknown;
}

/** Product ids arrive as strings from the DB but the API wants numbers. */
const coerceId = (id: string): number | string => (/^\d+$/.test(id) ? Number(id) : id);

export function buildPurchaseBody(request: PurchaseRequest): {
  path: string;
  body: Record<string, unknown>;
} {
  const productId = coerceId(request.providerProductId);

  if (request.endpointKind === 'games') {
    // Unverified against live traffic — see this file's doc comment. Mirrors
    // `/products/catalog`'s own required_fields:["player_id"] for this family.
    const body: Record<string, unknown> = {
      product_id: productId,
      player_id: request.playerId,
      client_name: request.clientReference,
    };
    if (request.serverId) body.server_id = request.serverId;
    return { path: '/buy/catalog', body };
  }

  if (request.endpointKind === 'pins_recharge') {
    return {
      path: '/buy/catalog',
      body: {
        product_id: productId,
        manual_id: request.playerId,
        client_name: request.clientReference,
      },
    };
  }

  // `pins_code` products deliver redeemable codes, not top-ups. Refusing here
  // means a mis-synced catalog cannot quietly start selling codes as recargas.
  throw new Error(
    `Refusing to purchase product ${request.providerProductId}: endpointKind ` +
      `'pins_code' delivers redeemable codes, not a direct top-up.`,
  );
}

function mapPurchaseFailure(
  res:
    | { ok: false; httpStatus: number; code: string | null; message: string }
    | { ok: false; httpStatus: null; code: null; message: string; transport: true },
): PurchaseOutcome {
  // No response at all: the request may or may not have reached the provider.
  if (res.httpStatus === null) {
    return {
      kind: 'ambiguous',
      reason: res.message.startsWith('timeout') ? 'timeout' : 'network',
      message: res.message,
      httpStatus: null,
    };
  }

  // 422 is documented and definitive — the provider tells us it did nothing.
  if (res.httpStatus === 422) {
    return {
      kind: 'failed',
      code: res.code ?? 'PURCHASE_FAILED',
      message: res.message,
      // Insufficient balance is fixable; a wrong product type is a config bug.
      retryable: res.code !== 'INVALID_PRODUCT_TYPE',
      httpStatus: 422,
    };
  }

  // 502 PROVIDER_ERROR gives no indication whether the upstream charged us.
  if (res.httpStatus >= 500) {
    return {
      kind: 'ambiguous',
      reason: 'provider_error',
      message: res.message,
      httpStatus: res.httpStatus,
    };
  }

  // 409 DUPLICATE_REQUEST: the provider saw this exact payload within its 120s
  // window and refused to act on it again. `buildPurchaseBody` is deterministic
  // per order item, so a same-item retry can genuinely hit this. It proves
  // nothing about whether the *first* attempt charged us — never a definitive
  // failure, and never retried again until the window has had time to pass.
  if (res.httpStatus === 409) {
    return {
      kind: 'ambiguous',
      reason: 'duplicate',
      message: res.message,
      httpStatus: 409,
    };
  }

  // 400/401/403/404 — our request was wrong. Nothing was charged; retrying the
  // same payload will fail identically.
  return {
    kind: 'failed',
    code: res.code ?? `HTTP_${res.httpStatus}`,
    message: res.message,
    retryable: false,
    httpStatus: res.httpStatus,
  };
}
