/**
 * Mercado Pago adapter — Checkout Pro, OXXO only.
 *
 * Card and SPEI stay on Stripe; this exists specifically because Stripe's own
 * OXXO settlement (via PPRO) proved unreliable in practice — real vouchers,
 * really paid at the till, sometimes taking most of a day or more to report
 * back (see stuck-payments.ts's own doc comment for the incident). Mercado
 * Pago is well established for OXXO in Mexico, so this adapter only ever
 * requests that one method.
 *
 * Structurally different from stripe.ts in one real way: Stripe's webhook body
 * carries the full Checkout Session, so verifying it is a pure, synchronous
 * signature check. Mercado Pago's webhook is a lightweight "go check payment
 * X" ping — the body never carries payment status — so `verifyWebhook` here
 * genuinely does I/O: check the signature, then fetch the Payment by id.
 *
 * No SDK, same reasoning as stripe.ts: two calls (create a Preference, read a
 * Payment) don't justify a dependency to keep patched.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
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

export const MERCADOPAGO_API_BASE = 'https://api.mercadopago.com';

/** Every payment type except `ticket` (the family `oxxo` belongs to) — excluded so Checkout Pro offers OXXO alone. */
const NON_TICKET_PAYMENT_TYPES = [
  'credit_card',
  'debit_card',
  'prepaid_card',
  'atm',
  'digital_wallet',
  'bank_transfer',
  'account_money',
] as const;

export interface MercadoPagoGatewayOptions {
  accessToken: string;
  /** The webhook Secret Signature from Your Integrations → Webhooks. */
  webhookSecret: string;
  /** Only 'oxxo' is ever meaningful here; kept as a list for symmetry with StripeGateway. */
  methods?: readonly Extract<GatewayMethod, 'oxxo'>[];
  apiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The subset of a Mercado Pago Preference this adapter reads back. */
interface MpPreference {
  id: string;
  init_point?: string;
}

/** The subset of a Mercado Pago Payment this adapter reads. */
interface MpPayment {
  id: number | string;
  status?: 'pending' | 'approved' | 'authorized' | 'in_process' | 'in_mediation' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back';
  status_detail?: string;
  transaction_amount?: number;
  external_reference?: string;
  date_approved?: string | null;
  transaction_details?: {
    external_resource_url?: string | null;
  } | null;
  barcode?: {
    content?: string | null;
  } | null;
}

const TERMINAL_FAILED = new Set(['rejected', 'cancelled']);

/** Mercado Pago's own states, reduced to the gateway-neutral ones this system acts on. */
export function paymentState(payment: MpPayment): ChargeState {
  if (payment.status === 'approved') return 'paid';
  if (payment.status === 'refunded' || payment.status === 'charged_back') return 'refunded';
  if (payment.status && TERMINAL_FAILED.has(payment.status)) return 'failed';
  return 'pending';
}

/**
 * `x-signature: ts=…,v1=…` plus the `x-request-id` header and the payment id
 * from the body — Mercado Pago signs a manifest of those three, never the
 * body itself, which is why this cannot share Stripe's signature.ts scheme.
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

export class MercadoPagoGateway implements PaymentGateway {
  readonly name = 'mercadopago';
  readonly supportedMethods: readonly GatewayMethod[];

  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: MercadoPagoGatewayOptions) {
    if (!options.accessToken) throw new Error('Mercado Pago access token is required');
    if (!options.webhookSecret) {
      // Same refusal as StripeGateway's own: a gateway that can take money but
      // cannot verify who is telling us it arrived must not exist at all.
      throw new Error('Mercado Pago webhook secret is required');
    }
    this.supportedMethods = options.methods?.length ? [...options.methods] : ['oxxo'];
    this.apiBase = options.apiBase ?? MERCADOPAGO_API_BASE;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeCreated> {
    if (!input.returnUrl || !input.cancelUrl) {
      throw new GatewayError('Mercado Pago Checkout Pro needs returnUrl and cancelUrl', this.name, false);
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new GatewayError(`Invalid amount ${input.amountCents}`, this.name, false);
    }
    if (input.method !== 'oxxo' || !this.supportedMethods.includes('oxxo')) {
      throw new GatewayError(`Mercado Pago does not have ${input.method} enabled`, this.name, false);
    }

    const params = {
      external_reference: input.orderNumber,
      items: [
        {
          title: input.description,
          quantity: 1,
          currency_id: 'MXN',
          unit_price: Math.round(input.amountCents) / 100,
        },
      ],
      payer: input.customerEmail ? { email: input.customerEmail } : undefined,
      back_urls: {
        success: input.returnUrl,
        pending: input.returnUrl,
        failure: input.cancelUrl,
      },
      auto_return: 'approved',
      // Only the `ticket` family (OXXO's own type) stays offered — everything
      // else excluded, so Checkout Pro's page never invites the customer to
      // pay by card or transfer instead of the one method this button promised.
      payment_methods: {
        excluded_payment_types: NON_TICKET_PAYMENT_TYPES.map((id) => ({ id })),
      },
      // Not set here: the app-level webhook (configured once in Your
      // Integrations → Webhooks) already covers every preference this
      // account creates — no need to repeat it per request.
      metadata: { order_id: input.orderId, order_number: input.orderNumber },
    };

    const preference = await this.request<MpPreference>('POST', '/checkout/preferences', params, {
      // One preference per order, however many times the button is pressed —
      // same reasoning as Stripe's Idempotency-Key on session creation.
      idempotencyKey: `levelup-mp-${input.orderId}`,
    });

    if (!preference.init_point) {
      throw new GatewayError(`Preference ${preference.id} came back without an init_point`, this.name, true);
    }

    return {
      gateway: this.name,
      gatewayChargeId: preference.id,
      amountCents: input.amountCents,
      instructions: { kind: 'redirect', url: preference.init_point },
      // Mercado Pago does not hand back an expiry on the preference itself —
      // the OXXO ticket's own expiry is read later, off the Payment, once one
      // actually exists.
      expiresAt: null,
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

    let body: { type?: string; action?: string; data?: { id?: string | number } };
    try {
      body = JSON.parse(rawBody) as typeof body;
    } catch {
      return { ok: false, reason: 'malformed_payload' };
    }

    const paymentId = body.data?.id != null ? String(body.data.id) : null;
    if (!paymentId) return { ok: false, reason: 'malformed_payload' };

    // The manifest is id/request-id/ts — never the body — which is exactly
    // why this cannot reuse signature.ts's Stripe-shaped scheme.
    const manifest = `id:${paymentId.toLowerCase()};${requestId ? `request-id:${requestId};` : ''}ts:${parsed.ts};`;
    const expected = createHmac('sha256', this.options.webhookSecret).update(manifest, 'utf8').digest('hex');
    if (!constantTimeEquals(parsed.v1, expected)) return { ok: false, reason: 'bad_signature' };

    if (body.type !== 'payment') {
      // Authentic but not something acted on (e.g. `merchant_order`) —
      // acknowledged so Mercado Pago stops redelivering, not treated as an attack.
      return { ok: false, reason: 'unsupported_event' };
    }

    // The body only ever says "go look at payment X" — never its status —
    // so resolving what actually happened means asking for it directly.
    let payment: MpPayment;
    try {
      payment = await this.request<MpPayment>('GET', `/v1/payments/${encodeURIComponent(paymentId)}`);
    } catch (err) {
      if (err instanceof MpNotFound) return { ok: false, reason: 'malformed_payload' };
      throw err;
    }

    const event: PaymentEvent = {
      eventId: `${paymentId}:${body.action ?? 'payment.updated'}`,
      type: body.action ?? 'payment.updated',
      gatewayChargeId: payment.external_reference ?? null,
      state: paymentState(payment),
      amountReceivedCents:
        paymentState(payment) === 'paid' && payment.transaction_amount != null
          ? Math.round(payment.transaction_amount * 100)
          : null,
      reference: String(payment.id),
      occurredAt: payment.date_approved ? new Date(payment.date_approved) : new Date(this.now()),
      raw: { webhook: body, payment },
    };
    return { ok: true, event };
  }

  async getCharge(gatewayChargeId: string): Promise<ChargeSnapshot | null> {
    let payment: MpPayment | null;
    try {
      payment = await this.findPaymentByExternalReference(gatewayChargeId);
    } catch (err) {
      if (err instanceof MpNotFound) return null;
      throw err;
    }
    if (!payment) return null;

    const state = paymentState(payment);
    return {
      gatewayChargeId,
      state,
      amountReceivedCents:
        state === 'paid' && payment.transaction_amount != null
          ? Math.round(payment.transaction_amount * 100)
          : null,
      paidAt: payment.date_approved ? new Date(payment.date_approved) : null,
      reference: String(payment.id),
      voucherUrl: payment.transaction_details?.external_resource_url ?? null,
    };
  }

  /**
   * `gatewayChargeId` for this adapter is the *order number* (the Preference's
   * `external_reference`), not a Mercado Pago id — a Preference is closed the
   * moment it is created and is not itself searchable by payment status; the
   * Payment that eventually gets made against it is. Search rather than a
   * direct lookup because the Payment's own id is only known once it exists,
   * which is exactly the thing being asked for here.
   */
  private async findPaymentByExternalReference(orderNumber: string): Promise<MpPayment | null> {
    const result = await this.request<{ results: MpPayment[] }>(
      'GET',
      `/v1/payments/search?external_reference=${encodeURIComponent(orderNumber)}&sort=date_created&criteria=desc`,
    );
    return result.results[0] ?? null;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, unknown>,
    opts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.accessToken}`,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

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
    super(message, 'mercadopago', retryable);
    this.name = 'MpApiError';
  }
}

class MpNotFound extends MpApiError {
  constructor(message: string) {
    super(message, 404, false);
    this.name = 'MpNotFound';
  }
}
