/**
 * Mercado Pago adapter — embedded Checkout (Orders API), card and SPEI.
 *
 * Deliberately a separate file/class from mercadopago.ts, not a rewrite of it.
 * That adapter is Checkout Pro — a hosted redirect Preference, correlated back
 * to an order only through `external_reference` because a Preference is never
 * referenced again, with a webhook that's a lightweight "go check payment X"
 * ping requiring a follow-up GET. This adapter is Mercado Pago's newer Orders
 * API (`/v1/orders`): the charge is created and resolved in one call (no
 * Preference indirection — the order id this returns IS the thing to look up
 * later), and its webhook (`topic=orders`) carries the full order state in the
 * body itself, no follow-up GET needed. These are genuinely different wire
 * protocols; forcing them into one class would recreate the exact "two copies
 * of the same steps, quietly drifting apart" problem gateway-report.ts's own
 * doc comment warns against — just inverted, since here the steps are not the
 * same to begin with.
 *
 * Card tokenization happens in the browser via Mercado Pago's own JS (the
 * Card Payment Brick) — raw card data never reaches this server, only a
 * single-use `cardToken`. SPEI has no card to tokenize; its "embedded"-ness is
 * that the CLABE/reference comes back in this same API response and is
 * rendered on LevelUp's own page, instead of redirecting to a Mercado-Pago-
 * hosted one.
 *
 * Fraud control: every charge is expected to carry a `deviceSessionId` (Mercado
 * Pago's own `security.js`-collected fingerprint), forwarded verbatim as the
 * `X-meli-session-id` header — this is what actually feeds their risk engine,
 * not something this adapter computes.
 *
 * No SDK, same reasoning as the other two adapters in this package: a handful
 * of REST calls don't justify a dependency to keep patched.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  GatewayError,
  type ChargeCreated,
  type ChargeSnapshot,
  type ChargeState,
  type CreateChargeInput,
  type GatewayMethod,
  type PaymentEvent,
  type PaymentGateway,
  type WebhookVerification,
} from './types.js';

const MERCADOPAGO_API_BASE = 'https://api.mercadopago.com';

export interface MercadoPagoEmbeddedGatewayOptions {
  accessToken: string;
  /** The webhook Secret Signature from Your Integrations → Webhooks, for the `orders` topic. */
  webhookSecret: string;
  /** 'card' and/or 'spei' — OXXO stays on Checkout Pro, out of scope here. */
  methods?: readonly Extract<GatewayMethod, 'card' | 'spei'>[];
  apiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

type MpOrderStatus = 'created' | 'processing' | 'action_required' | 'processed' | 'canceled' | 'failed';
type MpTransactionStatus =
  | 'pending'
  | 'processing'
  | 'action_required'
  | 'accredited'
  | 'rejected'
  // Confirmed against the real sandbox (2026-11-22): a declined card's
  // transaction comes back with this status, not 'rejected' — both are
  // real and both land in TERMINAL_FAILED below.
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'charged_back';

interface MpOrderPaymentMethod {
  id?: string;
  type?: string;
  token?: string;
  installments?: number;
  reference?: string | null;
  ticket_url?: string | null;
  /** Present when this card needs a 3D Secure bank challenge completed — see `transaction_security.url` below. */
  transaction_security?: { url?: string | null };
}

interface MpOrderTransactionPayment {
  id?: string;
  status?: MpTransactionStatus;
  status_detail?: string;
  payment_method?: MpOrderPaymentMethod;
}

/** The subset of a Mercado Pago Order (Orders API) this adapter reads/writes. */
interface MpOrder {
  id: string;
  status?: MpOrderStatus;
  status_detail?: string;
  external_reference?: string;
  total_amount?: string;
  transactions?: {
    payments?: MpOrderTransactionPayment[];
  };
}

const TERMINAL_FAILED = new Set<MpOrderStatus | MpTransactionStatus>(['rejected', 'cancelled', 'canceled', 'failed']);

/**
 * Mercado Pago's own order/transaction states, reduced to the gateway-neutral
 * ones this system acts on. Prefers the transaction's own status over the
 * order's when both exist — a declined card still leaves the order itself in
 * some wrapper state, but it's the transaction that says what actually
 * happened to the money.
 */
export function orderState(order: MpOrder): ChargeState {
  const txn = order.transactions?.payments?.[0];
  const status = txn?.status ?? order.status;
  if (status === 'accredited' || status === 'processed') return 'paid';
  if (status === 'refunded' || status === 'charged_back') return 'refunded';
  if (status && TERMINAL_FAILED.has(status)) return 'failed';
  return 'pending';
}

function amountReceivedCents(order: MpOrder, state: ChargeState): number | null {
  if (state !== 'paid' || order.total_amount == null) return null;
  const amount = Number(order.total_amount);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

/**
 * `x-signature: ts=…,v1=…` plus `x-request-id` and the order id from the body
 * — same manifest-HMAC scheme as Checkout Pro's webhook (Mercado Pago signs a
 * manifest, never the raw body), keyed on the order id instead of a payment id.
 */
function parseMpSignature(header: string): { ts: string; v1: string } | null {
  let ts: string | null = null;
  let v1: string | null = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'v1') v1 = value;
  }
  return ts && v1 ? { ts, v1 } : null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export class MercadoPagoEmbeddedGateway implements PaymentGateway {
  readonly name = 'mercadopago-embedded';
  readonly supportedMethods: readonly GatewayMethod[];

  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: MercadoPagoEmbeddedGatewayOptions) {
    if (!options.accessToken) throw new Error('Mercado Pago access token is required');
    if (!options.webhookSecret) {
      // Same refusal as every other gateway in this package: something that
      // can take money but cannot verify who is telling us it arrived must
      // not exist at all.
      throw new Error('Mercado Pago webhook secret is required');
    }
    this.supportedMethods = options.methods?.length ? [...options.methods] : ['card'];
    this.apiBase = options.apiBase ?? MERCADOPAGO_API_BASE;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeCreated> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new GatewayError(`Invalid amount ${input.amountCents}`, this.name, false);
    }
    if (input.method !== 'card' && input.method !== 'spei') {
      throw new GatewayError(`Mercado Pago embedded does not have ${input.method} enabled`, this.name, false);
    }
    if (!this.supportedMethods.includes(input.method)) {
      throw new GatewayError(`Mercado Pago embedded does not have ${input.method} enabled`, this.name, false);
    }

    const payment: Record<string, unknown> =
      input.method === 'card'
        ? (() => {
            if (!input.cardToken) {
              throw new GatewayError('A card charge needs a cardToken from the Card Payment Brick', this.name, false);
            }
            // The Brick's own `payment_method_id` distinguishes debit at the
            // id level — 'debvisa', 'debmaster' — but the Orders API's
            // payment_method.id only accepts the bare network name ('visa',
            // 'master', 'amex') and wants debit-vs-credit conveyed through
            // `type` instead. Confirmed in production 2026-11-24: a real
            // debit card reported 'debvisa' and was rejected outright with
            // "'payment_method.id' - value must be one of 'amex', 'master',
            // 'visa'" — this was silently blocking every debit-card payment,
            // not just a rare edge case, since Mexican cards are
            // predominantly debit.
            const rawId = input.paymentMethodId ?? '';
            const isDebit = rawId.startsWith('deb');
            const normalizedId = isDebit ? rawId.slice(3) : rawId;
            return {
              amount: (input.amountCents / 100).toFixed(2),
              payment_method: {
                id: normalizedId,
                type: isDebit ? 'debit_card' : 'credit_card',
                token: input.cardToken,
                installments: input.installments && input.installments > 0 ? input.installments : 1,
              },
            };
          })()
        : {
            amount: (input.amountCents / 100).toFixed(2),
            payment_method: { id: 'clabe', type: 'bank_transfer' },
          };

    const body = {
      type: 'online',
      processing_mode: 'automatic',
      external_reference: input.orderNumber,
      total_amount: (input.amountCents / 100).toFixed(2),
      description: input.description,
      // Card only — SPEI has no card/3DS concept. `on_fraud_risk` is Mercado
      // Pago's own documented middle ground between 'never' (binary
      // approve/reject, confirmed live 2026-11-24 to outright decline
      // borderline-but-legitimate cards as 'high_risk' with no recourse) and
      // 'always' (forces a bank challenge on every charge). This lets a
      // risky-looking charge go to the customer's bank for verification
      // instead of being flatly rejected. `liability_shift: 'required'` is
      // mandatory whenever validation isn't 'never' (Mercado Pago's own docs)
      // and must be omitted when it is.
      ...(input.method === 'card'
        ? { config: { online: { transaction_security: { validation: 'on_fraud_risk' } } }, liability_shift: 'required' }
        : {}),
      payer: input.customerEmail
        ? {
            email: input.customerEmail,
            ...(input.payerIdentification
              ? {
                  identification: {
                    type: input.payerIdentification.type,
                    number: input.payerIdentification.number,
                  },
                }
              : {}),
          }
        : undefined,
      transactions: { payments: [payment] },
    };

    // Keyed on the order plus whatever actually makes this attempt distinct —
    // the card token for card (unique per tokenization, so a genuine retry
    // with a new/different card always gets a fresh key, while a literal
    // double-submit of the exact same token still coalesces safely) or a
    // fresh random nonce for SPEI (no token exists to key on there, and the
    // static SPEI payment body is otherwise identical on every attempt).
    //
    // Keying purely on the order id (as this used to) seemed safer on paper
    // but broke every single retry in practice: confirmed in production
    // 2026-11-24, a real customer resuming a pending order and trying again
    // (same or different method, always a new card token) hit Mercado Pago's
    // own 409 idempotency_key_already_used on every attempt after the first.
    const idempotencySuffix = input.method === 'card' ? input.cardToken : randomUUID();
    const headers: Record<string, string> = {
      'X-Idempotency-Key': `levelup-mp-${input.orderId}-${idempotencySuffix}`,
    };
    if (input.deviceSessionId) headers['X-meli-session-id'] = input.deviceSessionId;

    const order = await this.request<MpOrder>('POST', '/v1/orders', body, headers);

    const state = orderState(order);
    const instructions =
      input.method === 'card'
        ? ({
            kind: 'resolved',
            state,
            reference: order.transactions?.payments?.[0]?.id ?? null,
            challengeUrl: order.transactions?.payments?.[0]?.payment_method?.transaction_security?.url ?? null,
          } as const)
        : (() => {
            const pm = order.transactions?.payments?.[0]?.payment_method;
            return {
              kind: 'spei' as const,
              clabe: pm?.reference ?? '',
              // Confirm against a real sandbox order before trusting a bank
              // name ever actually arrives here — not invented if it doesn't.
              bank: '',
              reference: pm?.reference ?? null,
            };
          })();

    return {
      gateway: this.name,
      // The real Mercado Pago order id, unlike Checkout Pro's adapter — there
      // is no Preference indirection here, so this id is exactly what
      // `getCharge`/webhook lookups should ask for again.
      gatewayChargeId: order.id,
      amountCents: input.amountCents,
      instructions,
      expiresAt: input.expiresAt ?? null,
    };
  }

  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookVerification> {
    const signatureHeader = headers['x-signature'] ?? headers['X-Signature'];
    const requestId = headers['x-request-id'] ?? headers['X-Request-Id'];
    if (!signatureHeader) return { ok: false, reason: 'missing_signature' };

    const parsed = parseMpSignature(signatureHeader);
    if (!parsed) return { ok: false, reason: 'malformed_signature' };

    let body: { id?: number | string; type?: string; action?: string; data?: { id?: string | number } };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return { ok: false, reason: 'malformed_payload' };
    }

    const orderId = body.data?.id != null ? String(body.data.id) : null;
    if (!orderId) return { ok: false, reason: 'malformed_payload' };

    const manifest = `id:${orderId.toLowerCase()};${requestId ? `request-id:${requestId};` : ''}ts:${parsed.ts};`;
    const expected = createHmac('sha256', this.options.webhookSecret).update(manifest, 'utf8').digest('hex');
    if (!constantTimeEquals(parsed.v1, expected)) return { ok: false, reason: 'bad_signature' };

    if (body.type !== 'order' && body.type !== 'orders') {
      return { ok: false, reason: 'unsupported_event' };
    }

    // Unlike Checkout Pro's adapter, the Orders API's own doc describes the
    // full order (status + transactions) as already present in the webhook
    // delivery — but fetch it rather than trust the notification body's own
    // (possibly partial) copy, same "never trust the webhook as the only
    // path" discipline every gateway in this package follows.
    let order: MpOrder;
    try {
      order = await this.request<MpOrder>('GET', `/v1/orders/${encodeURIComponent(orderId)}`);
    } catch (err) {
      if (err instanceof MpNotFound) return { ok: false, reason: 'malformed_payload' };
      throw err;
    }

    const state = orderState(order);
    // The notification body's own id field is not consistently documented for
    // the Orders API the way Checkout Pro's `body.id` is — fall back to a
    // synthetic key over the fields that actually change between deliveries,
    // so a repeated "still pending" ping dedupes against itself but a later
    // "now paid" delivery for the same order does not get silently dropped.
    const eventId =
      body.id != null ? String(body.id) : `${body.action ?? 'order'}:${orderId}:${order.status}:${state}`;

    const event: PaymentEvent = {
      eventId,
      type: body.action ?? 'order.updated',
      gatewayChargeId: order.id,
      state,
      amountReceivedCents: amountReceivedCents(order, state),
      reference: order.transactions?.payments?.[0]?.id ?? null,
      occurredAt: new Date(this.now()),
      raw: { webhook: body, order },
    };
    return { ok: true, event };
  }

  async getCharge(gatewayChargeId: string): Promise<ChargeSnapshot | null> {
    let order: MpOrder;
    try {
      order = await this.request<MpOrder>('GET', `/v1/orders/${encodeURIComponent(gatewayChargeId)}`);
    } catch (err) {
      if (err instanceof MpNotFound) return null;
      throw err;
    }

    const state = orderState(order);
    const pm = order.transactions?.payments?.[0]?.payment_method;
    return {
      gatewayChargeId,
      state,
      amountReceivedCents: amountReceivedCents(order, state),
      paidAt: state === 'paid' ? new Date(this.now()) : null,
      reference: order.transactions?.payments?.[0]?.id ?? null,
      voucherUrl: null,
      challengeUrl: pm?.transaction_security?.url ?? null,
      bankTransfer: pm?.type === 'bank_transfer'
        ? { hostedInstructionsUrl: pm.ticket_url ?? null, clabe: pm.reference ?? null, bankName: null, reference: pm.reference ?? null }
        : null,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.accessToken}`,
      ...extraHeaders,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify(params ?? {}) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new GatewayError(`Mercado Pago unreachable: ${String(err)}`, this.name, true);
    }

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Fall through with the raw text in the message below.
    }

    if (response.ok) return body as T;

    // A declined card is not a failed request: Mercado Pago still creates the
    // order, it just answers with a non-2xx status (402, confirmed against
    // the real sandbox) and nests the actual order under `data` instead of
    // returning it at the top level the way a 2xx response does. Surface
    // that order like any other successful response so `createCharge` can
    // resolve it through the normal `orderState()` path — the caller's own
    // contract (see `apps/web`'s checkout action) depends on a decline never
    // being a thrown error.
    const declinedOrder = (body as { data?: { id?: unknown; status?: unknown } } | null)?.data;
    if (typeof declinedOrder?.id === 'string' && typeof declinedOrder?.status === 'string') {
      return declinedOrder as T;
    }

    const message = (body as { message?: string } | null)?.message ?? text.slice(0, 200);
    if (response.status === 404) throw new MpNotFound(message);

    const retryable = response.status === 429 || response.status >= 500;
    throw new MpApiError(`Mercado Pago ${response.status}: ${message}`, response.status, retryable);
  }
}

class MpApiError extends GatewayError {
  constructor(
    message: string,
    readonly status: number,
    retryable: boolean,
  ) {
    super(message, 'mercadopago-embedded', retryable);
    this.name = 'MpApiError';
  }
}

class MpNotFound extends MpApiError {
  constructor(message: string) {
    super(message, 404, false);
    this.name = 'MpNotFound';
  }
}
