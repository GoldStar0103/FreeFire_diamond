/**
 * Stripe adapter — hosted Checkout, card and optionally OXXO.
 *
 * Hosted Checkout rather than Elements, for two reasons that both come from the
 * audience. Card numbers never touch LevelUp's servers or pages, so there is no
 * PCI surface to maintain on a one-VPS deployment. And a buyer who has been
 * scammed before sees a stripe.com page with their bank's own 3-D Secure
 * prompt, which is a stronger trust signal than anything this storefront could
 * render itself.
 *
 * No SDK: the three calls needed are form-encoded POSTs and a GET, and the
 * provider client already shows the pattern. One fewer dependency to keep
 * patched on a server nobody watches daily.
 *
 * Money arrives in two shapes, and the difference matters downstream:
 *
 *   - Card: `checkout.session.completed` with `payment_status: paid`. Done.
 *   - OXXO: `checkout.session.completed` with `payment_status: unpaid` means a
 *     voucher was *issued*. The money arrives days later, if ever, as
 *     `checkout.session.async_payment_succeeded`.
 *
 * Treating the first OXXO event as a payment would ship diamonds against a
 * piece of paper. It maps to `pending` here, and only `paid` ever approves.
 */

import { verifySignature, type VerifyOptions } from './signature.js';
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

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/** Stripe refuses anything shorter. */
const MIN_SESSION_MINUTES = 30;
/** And anything longer. */
const MAX_SESSION_MINUTES = 24 * 60;

export interface StripeGatewayOptions {
  secretKey: string;
  webhookSecret: string;
  /** Which methods Checkout offers. Card always; OXXO only when enabled on the account. */
  methods?: readonly Extract<GatewayMethod, 'card' | 'oxxo'>[];
  /** How long the customer has to finish the Checkout page. Clamped to 30–1440. */
  sessionMinutes?: number;
  /** Days an OXXO voucher stays payable. Stripe allows 1–7. */
  oxxoExpiresAfterDays?: number;
  apiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
  webhookTolerance?: VerifyOptions['toleranceSeconds'];
}

/** The subset of a Checkout Session this adapter reads. */
interface StripeSession {
  id: string;
  object?: string;
  url?: string | null;
  status?: 'open' | 'complete' | 'expired' | null;
  payment_status?: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total?: number | null;
  currency?: string | null;
  expires_at?: number | null;
  metadata?: Record<string, string> | null;
  payment_intent?: string | StripePaymentIntent | null;
}

interface StripePaymentIntent {
  id: string;
  next_action?: {
    oxxo_display_details?: { hosted_voucher_url?: string | null } | null;
  } | null;
}

interface StripeEvent {
  id?: string;
  type?: string;
  created?: number;
  data?: { object?: StripeSession };
}

/**
 * Flatten nested params into Stripe's bracket form: `a[b][0]=c`.
 *
 * Exported for the tests, which assert on the exact wire format — Stripe
 * silently ignores a misspelled key rather than rejecting it, so a typo here
 * would ship a session missing its metadata without any error at all.
 */
export function formEncode(params: Record<string, unknown>): string {
  const pairs: string[] = [];

  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        walk(prefix ? `${prefix}[${k}]` : k, v);
      }
    } else {
      pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
    }
  };

  walk('', params);
  return pairs.join('&');
}

/**
 * What a session says about the money, reduced to the gateway-neutral states.
 *
 * `complete` alone is not "paid" — an OXXO session is complete the moment the
 * voucher is shown. Only `payment_status` says whether money moved.
 */
export function sessionState(session: StripeSession): ChargeState {
  if (session.payment_status === 'paid') return 'paid';
  if (session.status === 'expired') return 'expired';
  return 'pending';
}

function paymentIntentId(session: StripeSession): string | null {
  const pi = session.payment_intent;
  if (!pi) return null;
  return typeof pi === 'string' ? pi : pi.id;
}

function voucherUrl(session: StripeSession): string | null {
  const pi = session.payment_intent;
  if (!pi || typeof pi === 'string') return null;
  return pi.next_action?.oxxo_display_details?.hosted_voucher_url ?? null;
}

const EVENT_STATES: Record<string, (s: StripeSession) => ChargeState> = {
  // Card: paid. OXXO: voucher issued, still pending.
  'checkout.session.completed': sessionState,
  'checkout.session.async_payment_succeeded': () => 'paid',
  // The OXXO voucher lapsed unpaid.
  'checkout.session.async_payment_failed': () => 'failed',
  // Nobody finished the Checkout page in time.
  'checkout.session.expired': () => 'expired',
};

export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe';
  readonly supportedMethods: readonly GatewayMethod[];

  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: StripeGatewayOptions) {
    if (!options.secretKey) throw new Error('Stripe secret key is required');
    if (!options.webhookSecret) {
      // A gateway that can take money but cannot verify the webhook telling us
      // it arrived would either never confirm anything or be talked into
      // confirming anything. Refuse to exist rather than be either.
      throw new Error('Stripe webhook secret is required');
    }
    this.supportedMethods = options.methods?.length ? [...options.methods] : ['card'];
    this.apiBase = options.apiBase ?? STRIPE_API_BASE;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** True for a test-mode key. Surfaced in the panel so nobody launches on one. */
  get testMode(): boolean {
    return this.options.secretKey.startsWith('sk_test_') || this.options.secretKey.startsWith('rk_test_');
  }

  get oxxoExpiresAfterDays(): number {
    return Math.min(7, Math.max(1, Math.round(this.options.oxxoExpiresAfterDays ?? 2)));
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeCreated> {
    if (!input.returnUrl || !input.cancelUrl) {
      throw new GatewayError('Stripe Checkout needs returnUrl and cancelUrl', this.name, false);
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new GatewayError(`Invalid amount ${input.amountCents}`, this.name, false);
    }

    const minutes = Math.min(
      MAX_SESSION_MINUTES,
      Math.max(MIN_SESSION_MINUTES, Math.round(this.options.sessionMinutes ?? 60)),
    );
    // A second of slack: Stripe measures the 30-minute floor from its own
    // clock, and a session that asks for exactly 30 can be refused.
    const expiresAt = Math.floor(this.now() / 1000) + minutes * 60 + 1;

    const metadata = { order_id: input.orderId, order_number: input.orderNumber };
    const methods = this.supportedMethods.filter((m) => m === 'card' || m === 'oxxo');

    const params: Record<string, unknown> = {
      mode: 'payment',
      locale: 'es-419',
      client_reference_id: input.orderNumber,
      success_url: input.returnUrl,
      cancel_url: input.cancelUrl,
      expires_at: expiresAt,
      payment_method_types: methods,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'mxn',
            unit_amount: input.amountCents,
            product_data: { name: input.description },
          },
        },
      ],
      metadata,
      // Copied onto the PaymentIntent too, so the order number shows in the
      // Stripe dashboard next to the charge — which is where the owner will be
      // looking when a customer disputes one.
      payment_intent_data: {
        description: `${input.orderNumber} · ${input.description}`,
        metadata,
      },
      ...(methods.includes('oxxo')
        ? { payment_method_options: { oxxo: { expires_after_days: this.oxxoExpiresAfterDays } } }
        : {}),
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    };

    // One session per order, however many times the button is pressed or the
    // request retried. Stripe replays the original response for 24h.
    const session = await this.request<StripeSession>('POST', '/checkout/sessions', params, {
      idempotencyKey: `levelup-checkout-${input.orderId}`,
    });

    if (!session.url) {
      throw new GatewayError(`Session ${session.id} came back without a URL`, this.name, true);
    }

    return {
      gateway: this.name,
      gatewayChargeId: session.id,
      amountCents: session.amount_total ?? input.amountCents,
      instructions: { kind: 'redirect', url: session.url },
      expiresAt: session.expires_at ? new Date(session.expires_at * 1000) : new Date(expiresAt * 1000),
    };
  }

  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): WebhookVerification {
    const header = headers['stripe-signature'] ?? headers['Stripe-Signature'];
    const check = verifySignature(rawBody, header, this.options.webhookSecret, {
      now: this.now,
      ...(this.options.webhookTolerance !== undefined
        ? { toleranceSeconds: this.options.webhookTolerance }
        : {}),
    });
    if (!check.ok) return { ok: false, reason: check.reason ?? 'bad_signature' };

    let event: StripeEvent;
    try {
      event = JSON.parse(rawBody) as StripeEvent;
    } catch {
      return { ok: false, reason: 'malformed_payload' };
    }

    if (!event.id || !event.type) return { ok: false, reason: 'malformed_payload' };

    const toState = EVENT_STATES[event.type];
    // Authentic but not something we act on. The caller acknowledges it so
    // Stripe stops redelivering, rather than treating it as an attack.
    if (!toState) return { ok: false, reason: 'unsupported_event' };

    const session = event.data?.object;
    if (!session?.id || session.object !== 'checkout.session') {
      return { ok: false, reason: 'malformed_payload' };
    }

    // Every amount in this system is MXN centavos. A session in any other
    // currency was not created by this code, and its amount would be compared
    // against a peso figure as though it were one.
    if (session.currency && session.currency.toLowerCase() !== 'mxn') {
      return { ok: false, reason: 'malformed_payload' };
    }

    const state = toState(session);

    const verified: PaymentEvent = {
      eventId: event.id,
      type: event.type,
      gatewayChargeId: session.id,
      state,
      amountReceivedCents: state === 'paid' ? (session.amount_total ?? null) : null,
      reference: paymentIntentId(session),
      occurredAt: new Date((event.created ?? Math.floor(this.now() / 1000)) * 1000),
      raw: event,
    };
    return { ok: true, event: verified };
  }

  async getCharge(gatewayChargeId: string): Promise<ChargeSnapshot | null> {
    let session: StripeSession;
    try {
      session = await this.request<StripeSession>(
        'GET',
        `/checkout/sessions/${encodeURIComponent(gatewayChargeId)}?expand[]=payment_intent`,
      );
    } catch (err) {
      if (err instanceof StripeNotFound) return null;
      throw err;
    }

    const state = sessionState(session);
    return {
      gatewayChargeId: session.id,
      state,
      amountReceivedCents: state === 'paid' ? (session.amount_total ?? null) : null,
      paidAt: null,
      reference: paymentIntentId(session),
      voucherUrl: voucherUrl(session),
    };
  }

  /**
   * Close a session the customer walked away from.
   *
   * Only an `open` session can be expired, and that is the point: once the
   * customer has paid, or been issued an OXXO voucher, this refuses — so a
   * cancel link can never void a payment that is already on its way.
   */
  async expireSession(gatewayChargeId: string): Promise<'expired' | 'not_open'> {
    try {
      await this.request('POST', `/checkout/sessions/${encodeURIComponent(gatewayChargeId)}/expire`, {});
      return 'expired';
    } catch (err) {
      // 400 is Stripe saying the session is no longer open. A 401 or 403 is a
      // key problem and must surface, not be read as "already paid".
      if (err instanceof StripeApiError && err.status === 400) return 'not_open';
      throw err;
    }
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    params?: Record<string, unknown>,
    opts: { idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.secretKey}`,
    };
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: formEncode(params ?? {}) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new GatewayError(`Stripe unreachable: ${String(err)}`, this.name, true);
    }

    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Fall through with the raw text in the message below.
    }

    if (response.ok) return body as T;

    const message =
      (body as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 200);
    if (response.status === 404) throw new StripeNotFound(message);

    // 429 and 5xx are Stripe's to fix and worth another go; anything else is a
    // request that will fail identically next time.
    const retryable = response.status === 429 || response.status >= 500;
    throw new StripeApiError(`Stripe ${response.status}: ${message}`, response.status, retryable);
  }
}

class StripeApiError extends GatewayError {
  constructor(
    message: string,
    readonly status: number,
    retryable: boolean,
  ) {
    super(message, 'stripe', retryable);
    this.name = 'StripeApiError';
  }
}

class StripeNotFound extends StripeApiError {
  constructor(message: string) {
    super(message, 404, false);
    this.name = 'StripeNotFound';
  }
}
