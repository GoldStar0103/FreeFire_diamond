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
import {
  isFreeFire,
  normaliseGameProduct,
  normalisePinProduct,
  type ProviderProduct,
} from './catalog.js';

interface RawGameRow {
  id?: number | string;
  game?: string;
  package?: string;
  price?: number | string;
  input_fields?: Array<{ name?: string; label?: string }>;
}

interface RawPinRow {
  id?: number | string;
  sku?: string;
  name?: string;
  type?: string;
  price?: number | string;
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
    const [games, pins] = await Promise.all([
      this.call<RawGameRow[]>('GET', '/products/games'),
      this.call<RawPinRow[]>('GET', '/products/pins'),
    ]);

    // Both endpoints must answer. Half a catalog would look like products
    // disappearing, and the sync would deactivate SKUs that are perfectly fine.
    if (!games.ok) throw new ProviderProtocolError(`Could not list games: ${games.message}`);
    if (!pins.ok) throw new ProviderProtocolError(`Could not list pins: ${pins.message}`);

    return [
      ...games.data.filter((p) => isFreeFire(`${p.game} ${p.package}`)).map(normaliseGameProduct),
      ...pins.data.filter((p) => isFreeFire(`${p.name} ${p.sku}`)).map(normalisePinProduct),
    ];
  }

  async getBalance(): Promise<UsdTenK> {
    const res = await this.call<{ balance: number | string; currency: string }>('GET', '/wallet');
    if (!res.ok) throw new ProviderProtocolError(`Could not read wallet: ${res.message}`);
    return parseUsd(res.data.balance);
  }

  async validatePlayer(providerProductId: string, playerId: string): Promise<PlayerValidation> {
    const res = await this.call<{ status: boolean; account_name: string | null }>(
      'POST',
      '/pins/validate',
      { product_id: coerceId(providerProductId), service_user_id: playerId },
    );

    if (!res.ok) {
      // The API rejects anything that is not type=recharge. Surface that as a
      // capability problem, not as "player not found" — the difference decides
      // whether checkout shows a nickname gate or a double-entry fallback.
      if (res.code === 'INVALID_PRODUCT_TYPE') {
        throw new ValidationUnsupportedError(providerProductId);
      }
      throw new ProviderProtocolError(`Validation failed: ${res.message}`);
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
    const body: Record<string, unknown> = {
      package_id: productId,
      input1: request.playerId,
      client_name: request.clientReference,
    };
    if (request.serverId) body.input2 = request.serverId;
    return { path: '/buy/games', body };
  }

  if (request.endpointKind === 'pins_recharge') {
    // The docs shout: "NUNCA se mandan quantity y redemption_id juntos."
    // Enforced by construction — `quantity` is never set on this path.
    return {
      path: '/buy/pins',
      body: {
        product_id: productId,
        redemption_id: request.playerId,
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
