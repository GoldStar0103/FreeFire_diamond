/**
 * RocketPass HTTP client.
 *
 * Mirrors `packages/payments`' gateway clients: a thin, fully-typed wrapper
 * that only ever reports what RocketPass said. Nothing here decides what a
 * response *means* for an order — that belongs to whatever calls this,
 * the same separation `settleGatewayCharge` keeps for Stripe/Mercado Pago.
 *
 * `listStock()` is deliberately not implemented — `GET /catalog`'s own
 * `stock_by_region` per item already gives us exactly what the catalog sync
 * needs, and `GET /stock`'s aggregate-by-family shape has no use here.
 */

import type {
  Catalog,
  CatalogItem,
  CreateOrderInput,
  CreateOrderResult,
  PlayerLookup,
  RocketPassItem,
  RocketPassOrder,
  RocketPassRegion,
} from './types.js';
import { RocketPassError, RocketPassUnreachableError } from './types.js';

export interface RocketPassClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://rocketpass.store/api/v1';
const DEFAULT_TIMEOUT_MS = 15_000;

/** 429/500/503 are the only statuses worth a caller retrying. */
const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 503]);

interface RawCatalogItem {
  item: string;
  name: string;
  kind: string;
  price_ars: number;
  max_quantity: number;
  available: boolean;
  stock_by_region: Record<string, number> | null;
  affordable_units: number;
}

export interface RawOrder {
  order_id: string;
  status: string;
  item: string;
  item_name: string;
  quantity: number;
  delivered: number;
  target_uid: string;
  target_nickname: string | null;
  region: string | null;
  unit_price_ars: number;
  total_ars: number;
  refunded_ars: number;
  charged_ars: number;
  reference: string | null;
  test: boolean;
  created_at: string;
  completed_at: string | null;
}

interface RawPlayerLookup {
  uid: string;
  valid: boolean;
  found: boolean;
  region_autocorrected: boolean;
  warning: string | null;
  nickname: string;
  level: number | null;
  region: string;
  requested_region: string;
  region_mismatch: boolean;
  suggested_region: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  clan_name: string | null;
  error: string | null;
}

function toPlayerLookup(raw: RawPlayerLookup): PlayerLookup {
  return {
    uid: raw.uid,
    valid: raw.valid,
    found: raw.found,
    nickname: raw.nickname || null,
    level: raw.level,
    region: raw.region as RocketPassRegion,
    requestedRegion: raw.requested_region as RocketPassRegion,
    regionMismatch: raw.region_mismatch,
    regionAutocorrected: raw.region_autocorrected,
    suggestedRegion: raw.suggested_region as RocketPassRegion | null,
    avatarUrl: raw.avatar_url,
    bannerUrl: raw.banner_url,
    clanName: raw.clan_name,
    warning: raw.warning,
    error: raw.error,
  };
}

function toCatalogItem(raw: RawCatalogItem): CatalogItem {
  return {
    item: raw.item as RocketPassItem,
    name: raw.name,
    kind: raw.kind as CatalogItem['kind'],
    priceArs: raw.price_ars,
    maxQuantity: raw.max_quantity,
    available: raw.available,
    stockByRegion: raw.stock_by_region as CatalogItem['stockByRegion'],
    affordableUnits: raw.affordable_units,
  };
}

export function toOrder(raw: RawOrder): RocketPassOrder {
  return {
    orderId: raw.order_id,
    status: raw.status as RocketPassOrder['status'],
    item: raw.item as RocketPassItem,
    itemName: raw.item_name,
    quantity: raw.quantity,
    delivered: raw.delivered,
    targetUid: raw.target_uid,
    targetNickname: raw.target_nickname,
    region: raw.region as RocketPassRegion | null,
    unitPriceArs: raw.unit_price_ars,
    totalArs: raw.total_ars,
    refundedArs: raw.refunded_ars,
    chargedArs: raw.charged_ars,
    reference: raw.reference,
    test: raw.test,
    createdAt: raw.created_at,
    completedAt: raw.completed_at,
  };
}

export class RocketPassClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RocketPassClientOptions) {
    if (!options.apiKey) throw new Error('RocketPass API key is required');
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** `rpk_test_...` keys never charge or ship — see `RocketPassOrder.test`. */
  get isSandbox(): boolean {
    return this.options.apiKey.startsWith('rpk_test_');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': this.options.apiKey,
          'Content-Type': 'application/json',
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RocketPassUnreachableError(`RocketPass ${method} ${path} unreachable: ${String(err)}`);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new RocketPassError(
        `RocketPass ${method} ${path} returned non-JSON (${response.status})`,
        'INTERNAL',
        response.status,
        RETRYABLE_STATUS.has(response.status),
      );
    }

    const envelope = parsed as { success?: boolean; data?: T; error?: { code?: string; message?: string } };

    if (!envelope?.success) {
      const code = envelope?.error?.code ?? 'INTERNAL';
      throw new RocketPassError(
        envelope?.error?.message ?? `RocketPass ${method} ${path} failed (${response.status})`,
        code,
        response.status,
        RETRYABLE_STATUS.has(response.status),
      );
    }

    return envelope.data as T;
  }

  async listCatalog(): Promise<Catalog> {
    const data = await this.request<{
      items: RawCatalogItem[];
      regions: { code: string; name: string }[];
      balance_ars: number;
      currency: string;
    }>('GET', '/catalog');

    return {
      items: data.items.map(toCatalogItem),
      regions: data.regions.map((r) => ({ code: r.code as RocketPassRegion, name: r.name })),
      balanceArs: data.balance_ars,
      currency: data.currency,
    };
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const data = await this.request<{
      order: RawOrder;
      queued: boolean;
      queue_code: 'large_order' | 'high_demand' | null;
      retry_after_seconds: number | null;
      balance_ars: number;
    }>(
      'POST',
      '/orders',
      {
        body: {
          item: input.item,
          target_uid: input.targetUid,
          quantity: input.quantity ?? 1,
          region: input.region ?? 'SAC',
          ...(input.targetNickname ? { target_nickname: input.targetNickname } : {}),
          ...(input.giftMessage ? { gift_message: input.giftMessage } : {}),
          reference: input.reference,
        },
        idempotencyKey: input.idempotencyKey,
      },
    );

    return {
      order: toOrder(data.order),
      queued: data.queued,
      queueCode: data.queue_code,
      retryAfterSeconds: data.retry_after_seconds,
      balanceArs: data.balance_ars,
    };
  }

  /**
   * Confirm a Free Fire UID before dispatching — nick, level, avatar, and
   * the account's real region, regardless of what `region` was requested
   * with (see `PlayerLookup`'s own doc comment). `region` is ignored by
   * RocketPass for an account that doesn't need one (memberships) — omit it
   * when the item being bought is a membership.
   *
   * Requires the `players:read` scope on the API key.
   */
  async getPlayer(uid: string, region?: RocketPassRegion): Promise<PlayerLookup> {
    const query = region ? `?region=${encodeURIComponent(region)}` : '';
    const data = await this.request<RawPlayerLookup>('GET', `/players/${encodeURIComponent(uid)}${query}`);
    return toPlayerLookup(data);
  }

  /**
   * The docs say this "returns the same order object as POST /orders" —
   * assumed to mean the same `{ order: {...} }` wrapper under `data`, not
   * `data` being the order directly. Worth confirming against the sandbox
   * key before this is relied on in production polling.
   */
  async getOrder(orderId: string): Promise<RocketPassOrder> {
    const data = await this.request<{ order: RawOrder }>('GET', `/orders/${encodeURIComponent(orderId)}`);
    return toOrder(data.order);
  }
}
