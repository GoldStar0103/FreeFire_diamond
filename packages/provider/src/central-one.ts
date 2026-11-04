/**
 * Central One client — the backup provider Jose asked for, to take over Free
 * Fire top-ups when RecargasAmérica is unstable (see `health-monitor.ts` for
 * the RA-side of that policy; this file is purely "how to talk to Central
 * One").
 *
 * Every shape below was confirmed empirically against the live API
 * (2026-11-03/04), using Jose's own account and his explicit go-ahead to
 * spend real wallet balance on real test purchases — not from guesswork:
 *
 *   - `GET /catalog` returns `{ items: [...] }`. Free Fire exists under SEVEN
 *     regions (LATAM, BR, GLOBAL, EU, ID, CIS, MY) at different prices with
 *     different target fields — Jose flagged this explicitly as something to
 *     get right. Only `region === 'LATAM'` is what this project sells; those
 *     SKUs use `target_fields: ["player_id"]` and match this project's six
 *     base denominations exactly (100->110 ... 5600->6160, same bonus math
 *     `catalog.ts` already encodes for RecargasAmérica).
 *   - `GET /balance` returns `{ currency, available_balance, held_balance,
 *     total_balance }` directly, no envelope.
 *   - `POST /player/validate` takes `{ product_id, target_payload: { player_id } }`
 *     — NOT a flat `player_id` field, confirmed by reading its progressive
 *     "missing/unknown field" errors. Returns `{ success, status: "valid" |
 *     "invalid", product_id, player?: { name } }` — `player` is only present
 *     on a valid hit.
 *   - `POST /orders` takes `{ items: [{ product_id, target_payload, quantity }] }`
 *     (again read from a "required_put_each_line_inside_items" error, not
 *     guessed) with a mandatory `Idempotency-Key` header. Returns
 *     `{ order: { id, reference_code, status, total_sale_amount, currency,
 *     created_at } }`. Three live orders all came back `status: "confirmed"`
 *     immediately, settling to `"completed"` a few seconds later on
 *     `GET /orders/{id}` — so a fresh order is never treated as finished
 *     until it reads back `"completed"`; anything else is `pending` and left
 *     for the existing poller to resolve, exactly like RA's `/buy/games`.
 *   - `GET /orders/{id}` adds `items[]`, each with its own `status`,
 *     `delivered_count`, `refund`, and `failure`. This project's own API key
 *     has no `codes:read` scope (confirmed via a live 403), so codes can
 *     never be read back through it even if a product returned them — not a
 *     concern for the LATAM direct-top-up family this provider sells, which
 *     has no pins at all.
 *   - Webhooks are documented (`order.delivered` / `order.failed` events) but
 *     are NOT active on this account yet — every `/webhooks/*` route 404s
 *     until Central One turns it on. So resolution is poll-only for now,
 *     same mechanism the existing poller already uses for RA.
 *   - Every error response shares one envelope:
 *     `{ error: { code, message, request_id, fields? } }`. The documented
 *     code table (confirmed from Jose's own docs screenshots, 2026-11-04):
 *       400 invalid_request        — bad body/params
 *       401 invalid_api_key        — key missing/invalid/revoked
 *       403 insufficient_scope     — key valid, lacks the permission
 *       404 not_found              — resource doesn't exist or isn't ours
 *       409 insufficient_balance   — wallet too low for this order
 *       409 insufficient_stock     — not enough inventory
 *       422 idempotency_key_reused — same key, different order — proves
 *                                     nothing about the first attempt
 *       429 rate_limited           — comes with Retry-After; never loop-retry
 *       500 internal_error         — generic failure
 *       503 service_unavailable    — temporary
 *       503 maintenance_mode       — "no orders are created, nothing starts"
 *                                     — unlike a generic 503, this one is
 *                                     documented as a guaranteed no-op, so it
 *                                     maps to a definitive failure, not an
 *                                     ambiguous one.
 */

import {
  parseUsd,
  type OrderStatus,
  type PlayerValidation,
  type PurchaseOutcome,
  type PurchaseRequest,
  type TopupProvider,
  type UsdTenK,
} from './types.js';
import { extractDiamonds, type ProviderProduct } from './catalog.js';

export interface CentralOneOptions {
  baseUrl?: string;
  apiKey: string;
  timeoutMs?: number;
  /** Injected so the failure matrix can drive the real client too. */
  fetchImpl?: typeof fetch;
  onApiCall?: (record: CentralOneApiCallRecord) => void;
}

export interface CentralOneApiCallRecord {
  method: string;
  path: string;
  requestPayload?: unknown;
  responsePayload?: unknown;
  httpStatus: number | null;
  durationMs: number;
  error?: string;
}

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    fields?: Array<{ field: string; reason: string }>;
  };
}

/** Thrown for genuinely unexpected shapes — never for a documented failure. */
export class CentralOneProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CentralOneProtocolError';
  }
}

type CallResult<T> =
  | { ok: true; data: T; httpStatus: number }
  | {
      ok: false;
      httpStatus: number;
      code: string | null;
      message: string;
      fields?: Array<{ field: string; reason: string }>;
    }
  | { ok: false; httpStatus: null; code: null; message: string; transport: true };

const ONLY_REGION = 'LATAM';
const FREE_FIRE_FAMILY = 'free-fire';

interface RawCatalogItem {
  product_id: string;
  sku?: string;
  name?: string;
  region?: string;
  product_family_id?: string;
  status?: string;
  reseller_price?: string | number;
  target_fields?: string[];
}

interface RawOrderItem {
  id: string;
  product_sku?: string;
  product_name?: string | null;
  status: string;
  failure: { code?: string; message?: string } | null;
}

interface RawOrder {
  id: string;
  reference_code: string;
  status: string;
  total_sale_amount: string | number;
  currency: string;
  items?: RawOrderItem[];
  failure?: { code?: string; message?: string } | null;
}

export class CentralOneProvider implements TopupProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onApiCall: ((record: CentralOneApiCallRecord) => void) | undefined;

  constructor(options: CentralOneOptions) {
    if (!options.apiKey) throw new Error('Central One API key is required');
    this.baseUrl = (options.baseUrl ?? 'https://portal.centraloneglobal.com/api/v1').replace(
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
    extraHeaders?: Record<string, string>,
  ): Promise<CallResult<T>> {
    const started = Date.now();
    const record: CentralOneApiCallRecord = {
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
          ...extraHeaders,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* non-JSON body is itself the finding — kept below */
      }

      record.httpStatus = res.status;
      record.durationMs = Date.now() - started;
      record.responsePayload = parsed ?? text.slice(0, 2000);
      this.onApiCall?.(record);

      if (res.ok) {
        return { ok: true, data: parsed as T, httpStatus: res.status };
      }

      const envelope = parsed as Partial<ErrorEnvelope> | null;
      return {
        ok: false,
        httpStatus: res.status,
        code: envelope?.error?.code ?? null,
        message: envelope?.error?.message ?? `HTTP ${res.status}`,
        ...(envelope?.error?.fields ? { fields: envelope.error.fields } : {}),
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
    const res = await this.call<{ items: RawCatalogItem[] }>('GET', '/catalog');
    if (!res.ok) throw new CentralOneProtocolError(`Could not list catalog: ${res.message}`);

    return res.data.items
      .filter(
        (p) =>
          p.region === ONLY_REGION &&
          p.product_family_id === FREE_FIRE_FAMILY &&
          p.status === 'active' &&
          Array.isArray(p.target_fields) &&
          p.target_fields.length === 1 &&
          p.target_fields[0] === 'player_id',
      )
      .map(normaliseCatalogItem);
  }

  async getBalance(): Promise<UsdTenK> {
    const res = await this.call<{ available_balance: string }>('GET', '/balance');
    if (!res.ok) throw new CentralOneProtocolError(`Could not read balance: ${res.message}`);
    return parseUsd(res.data.available_balance);
  }

  async validatePlayer(providerProductId: string, playerId: string): Promise<PlayerValidation> {
    const res = await this.call<{ success: boolean; status: string; player?: { name: string } }>(
      'POST',
      '/player/validate',
      { product_id: providerProductId, target_payload: { player_id: playerId } },
    );

    if (!res.ok) throw new CentralOneProtocolError(`Validation failed: ${res.message}`);

    return res.data.status === 'valid'
      ? { found: true, nickname: res.data.player?.name ?? null }
      : { found: false, nickname: null };
  }

  async purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
    const res = await this.call<{ order: RawOrder }>(
      'POST',
      '/orders',
      {
        items: [
          {
            product_id: request.providerProductId,
            target_payload: { player_id: request.playerId },
            quantity: 1,
          },
        ],
      },
      // Deterministic per order item — exactly the property Central One's
      // idempotency key wants, and what buildPurchaseBody's RA equivalent
      // already relies on for the same reason (see types.ts's module doc).
      { 'Idempotency-Key': request.clientReference },
    );

    if (!res.ok) return mapPurchaseFailure(res);

    const { order } = res.data;
    const amountCharged = parseUsd(order.total_sale_amount);

    if (order.status === 'completed') {
      return {
        kind: 'succeeded',
        providerTransactionId: order.id,
        providerReference: order.id,
        amountCharged,
      };
    }

    // Not yet settled (observed as "confirmed" immediately after creation,
    // becoming "completed" moments later). The existing poller resolves this
    // the same way it already resolves RA's `/buy/games` PENDING orders.
    return {
      kind: 'pending',
      providerTransactionId: order.id,
      providerReference: order.id,
      amountCharged,
    };
  }

  async getOrderStatus(reference: string): Promise<OrderStatus | null> {
    const res = await this.call<{ order: RawOrder }>(
      'GET',
      `/orders/${encodeURIComponent(reference)}`,
    );

    if (!res.ok) {
      if (res.httpStatus === 404) return null;
      throw new CentralOneProtocolError(`Could not read order ${reference}: ${res.message}`);
    }

    const { order } = res.data;
    return {
      reference: order.id,
      status: order.status === 'completed' ? 'COMPLETED' : 'PENDING',
      // This key has no codes:read scope and the LATAM direct-top-up family
      // never returns codes in the first place — always empty for us.
      pins: [],
      product: order.items?.[0]?.product_name ?? null,
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function normaliseCatalogItem(raw: RawCatalogItem): ProviderProduct {
  const name = raw.name ?? raw.sku ?? '';
  return {
    providerProductId: raw.product_id,
    // Direct top-up, validatable via player_id — the same logical family
    // RecargasAmérica's 'games' endpointKind represents.
    endpointKind: 'games',
    name,
    sku: raw.sku ?? null,
    diamondsBase: extractDiamonds(name),
    costUsd: safeUsd(raw.reseller_price),
    requiresServerId: false,
    canValidate: true,
    raw,
  };
}

const safeUsd = (value: unknown): UsdTenK | null => {
  if (value === null || value === undefined) return null;
  try {
    return parseUsd(value as string | number);
  } catch {
    return null;
  }
};

function mapPurchaseFailure(
  res:
    | { ok: false; httpStatus: number; code: string | null; message: string }
    | { ok: false; httpStatus: null; code: null; message: string; transport: true },
): PurchaseOutcome {
  // No response at all: the request may or may not have reached Central One.
  if (res.httpStatus === null) {
    return {
      kind: 'ambiguous',
      reason: res.message.startsWith('timeout') ? 'timeout' : 'network',
      message: res.message,
      httpStatus: null,
    };
  }

  // Documented as a guaranteed no-op ("no orders are created, nothing
  // starts") — a definitive failure, not an ambiguous one, unlike a plain 503.
  if (res.code === 'maintenance_mode') {
    return {
      kind: 'failed',
      code: 'MAINTENANCE_MODE',
      message: res.message,
      retryable: true,
      httpStatus: res.httpStatus,
    };
  }

  // Generic 5xx gives no indication whether Central One actually processed
  // the order before failing.
  if (res.httpStatus >= 500) {
    return {
      kind: 'ambiguous',
      reason: 'provider_error',
      message: res.message,
      httpStatus: res.httpStatus,
    };
  }

  // The same Idempotency-Key was already used for a different order. Proves
  // nothing about whether *that* original attempt landed — never a
  // definitive failure, same as RA's 409 DUPLICATE_REQUEST.
  if (res.code === 'idempotency_key_reused') {
    return {
      kind: 'ambiguous',
      reason: 'duplicate',
      message: res.message,
      httpStatus: res.httpStatus,
    };
  }

  // 400/401/403/404/409(balance/stock)/422/429 — documented, definitive
  // responses. Nothing was charged. Balance, stock, and rate limits are
  // worth retrying later; a bad request, key, or missing product is a config
  // bug and retrying it will fail identically every time.
  const retryable =
    res.code === 'insufficient_balance' ||
    res.code === 'insufficient_stock' ||
    res.code === 'rate_limited';

  return {
    kind: 'failed',
    code: res.code ?? `HTTP_${res.httpStatus}`,
    message: res.message,
    retryable,
    httpStatus: res.httpStatus,
  };
}
