/**
 * Stripe adapter — card via an embedded `PaymentIntent`/Payment Element,
 * OXXO and SPEI via hosted Checkout.
 *
 * Card moved off hosted Checkout 2026-11-26, per the client's own ask: the
 * redirect-to-a-new-tab flow had caused a "white screen" issue before, and
 * he wanted card to open in the same page, the way Mercado Pago's embedded
 * card already does, with Apple Pay/Google Pay/Link alongside raw card. A
 * `PaymentIntent`'s own `client_secret` is the one Stripe secret designed to
 * reach the browser — Stripe's own JS (Payment Element) collects card
 * details there and confirms the charge directly with Stripe, so raw card
 * data still never touches this server, same PCI posture hosted Checkout
 * always had. OXXO/SPEI stay on hosted Checkout — a redirect is already the
 * right shape for a method the customer is going to leave the page for
 * anyway (an OXXO till, their own banking app), and there's no comparable
 * "white screen" complaint to justify rebuilding what already works.
 *
 * No SDK for the two methods still using hosted Checkout, or for building
 * the PaymentIntent itself: those are plain form-encoded POSTs/a GET, same
 * reasoning as the provider client. The frontend Payment Element genuinely
 * needs Stripe's own JS in the browser (raw card data can't reach this
 * server any other way) — that dependency lives in apps/web, not here.
 *
 * Money arrives in two shapes, and the difference matters downstream:
 *
 *   - Card: `checkout.session.completed` with `payment_status: paid`. Done.
 *   - OXXO/SPEI: `checkout.session.completed` with `payment_status: unpaid`
 *     means a voucher or bank-transfer reference was *issued*, not paid. The
 *     money arrives later, if ever, as `checkout.session.async_payment_succeeded`.
 *
 * Treating that first event as a payment would ship diamonds against a piece
 * of paper or an unconfirmed transfer. It maps to `pending` here, and only
 * `paid` ever approves.
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

/** Our method names, mapped to what Stripe's `payment_method_types` actually calls them. */
const STRIPE_WIRE_TYPE = {
  card: 'card',
  oxxo: 'oxxo',
  // SPEI is not its own Stripe payment method — Mexican bank transfers are
  // Stripe's generic `customer_balance` funding source, configured below to
  // the `mx_bank_transfer` variant.
  spei: 'customer_balance',
} as const;

type StripeMethod = keyof typeof STRIPE_WIRE_TYPE;

export interface StripeGatewayOptions {
  secretKey: string;
  webhookSecret: string;
  /** Which methods Checkout offers. Card always; OXXO/SPEI only when enabled on the account. */
  methods?: readonly Extract<GatewayMethod, StripeMethod>[];
  /** How long the customer has to finish the Checkout page. Clamped to 30–1440. */
  sessionMinutes?: number;
  /** Days an OXXO voucher stays payable. Stripe allows 1–7. */
  oxxoExpiresAfterDays?: number;
  /**
   * Days our own payment deadline is extended by once a SPEI bank-transfer
   * session completes. Unlike OXXO, Stripe puts no fixed expiry on the
   * transfer itself — this is purely how long we wait before the sweep
   * retires an order nobody has paid yet.
   */
  speiGraceDays?: number;
  apiBase?: string;
  fetch?: typeof fetch;
  now?: () => number;
  webhookTolerance?: VerifyOptions['toleranceSeconds'];
}

/** The subset of a Checkout Session this adapter reads. */
interface StripeSession {
  id: string;
  object?: 'checkout.session';
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
    display_bank_transfer_instructions?: {
      hosted_instructions_url?: string | null;
      reference?: string | null;
      financial_addresses?: ReadonlyArray<{
        type?: string;
        clabe?: { clabe?: string | null; bank_name?: string | null } | null;
      }> | null;
    } | null;
  } | null;
}

/** The top-level object Stripe sends for a direct `PaymentIntent` — the embedded card flow's own charge, distinct from `StripePaymentIntent` above (which is a *nested* field read off an expanded Checkout Session). */
interface StripeDirectPaymentIntent {
  id: string;
  object?: 'payment_intent';
  status?: 'requires_payment_method' | 'requires_confirmation' | 'requires_action' | 'processing' | 'requires_capture' | 'succeeded' | 'canceled';
  amount?: number;
  amount_received?: number;
  currency?: string | null;
  client_secret?: string | null;
  metadata?: Record<string, string> | null;
}

interface StripeEvent {
  id?: string;
  type?: string;
  created?: number;
  data?: { object?: StripeSession | StripeDirectPaymentIntent };
}

/** A direct `PaymentIntent`'s own status, reduced to the gateway-neutral states — the embedded card flow's counterpart to `sessionState` above. */
function intentState(status: StripeDirectPaymentIntent['status']): ChargeState {
  if (status === 'succeeded') return 'paid';
  if (status === 'canceled') return 'failed';
  return 'pending';
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

type BankTransferDetails = NonNullable<ChargeSnapshot['bankTransfer']>;

function bankTransferDetails(session: StripeSession): BankTransferDetails | null {
  const pi = session.payment_intent;
  if (!pi || typeof pi === 'string') return null;
  const details = pi.next_action?.display_bank_transfer_instructions;
  if (!details) return null;

  const clabeAddress = details.financial_addresses?.find((a) => a.type === 'clabe')?.clabe;
  return {
    hostedInstructionsUrl: details.hosted_instructions_url ?? null,
    clabe: clabeAddress?.clabe ?? null,
    bankName: clabeAddress?.bank_name ?? null,
    reference: details.reference ?? null,
  };
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

/** The embedded card flow's own event types — a direct `PaymentIntent`, never a Checkout Session. */
const PAYMENT_INTENT_EVENT_STATES: Record<string, ChargeState> = {
  'payment_intent.succeeded': 'paid',
  'payment_intent.payment_failed': 'failed',
  'payment_intent.canceled': 'failed',
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

  get speiGraceDays(): number {
    return Math.min(7, Math.max(1, Math.round(this.options.speiGraceDays ?? 3)));
  }

  /**
   * How long our own payment deadline is extended once an async method's
   * Checkout session completes — the larger of whichever async methods are
   * actually enabled, since a report from Stripe does not say which one fired.
   */
  get pendingGraceDays(): number {
    const days: number[] = [];
    if (this.supportedMethods.includes('oxxo')) days.push(this.oxxoExpiresAfterDays);
    if (this.supportedMethods.includes('spei')) days.push(this.speiGraceDays);
    return days.length ? Math.max(...days) : this.oxxoExpiresAfterDays;
  }

  async createCharge(input: CreateChargeInput): Promise<ChargeCreated> {
    if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
      throw new GatewayError(`Invalid amount ${input.amountCents}`, this.name, false);
    }
    if (!this.supportedMethods.includes(input.method)) {
      throw new GatewayError(`Stripe does not have ${input.method} enabled`, this.name, false);
    }

    // Card never redirects (see this file's own doc comment), so it needs
    // neither a return/cancel URL nor any of hosted Checkout's session
    // machinery below.
    if (input.method === 'card') {
      return this.createCardIntentCharge(input);
    }

    if (!input.returnUrl || !input.cancelUrl) {
      throw new GatewayError('Stripe Checkout needs returnUrl and cancelUrl', this.name, false);
    }

    const minutes = Math.min(
      MAX_SESSION_MINUTES,
      Math.max(MIN_SESSION_MINUTES, Math.round(this.options.sessionMinutes ?? 60)),
    );
    // A second of slack: Stripe measures the 30-minute floor from its own
    // clock, and a session that asks for exactly 30 can be refused.
    const expiresAt = Math.floor(this.now() / 1000) + minutes * 60 + 1;

    const metadata = { order_id: input.orderId, order_number: input.orderNumber };
    // One Checkout Session offers exactly the method the customer picked, not
    // every enabled method bundled together — a customer who tapped "OXXO"
    // should not land on a Stripe page that also offers to redirect them into
    // a bank transfer instead. Card already branched off above, and the
    // method-is-enabled check already happened at the top of this function.
    const methods: StripeMethod[] = [input.method as 'oxxo' | 'spei'];

    const paymentMethodOptions: Record<string, unknown> = {};
    if (methods.includes('oxxo')) {
      paymentMethodOptions.oxxo = { expires_after_days: this.oxxoExpiresAfterDays };
    }
    if (methods.includes('spei')) {
      // `customer_balance` is Stripe's generic bank-transfer funding source;
      // `mx_bank_transfer` is the Mexican SPEI variant of it.
      paymentMethodOptions.customer_balance = {
        funding_type: 'bank_transfer',
        bank_transfer: { type: 'mx_bank_transfer' },
      };
    }

    // customer_balance refuses to attach to a PaymentIntent with no Customer,
    // and `customer_creation: 'always'` is not enough — Stripe rejects the
    // session up front with "requires customer to be set" unless a real
    // Customer id is passed at creation time. One Customer per order, keyed
    // the same way the session itself is, so a retried createCharge (the
    // button pressed twice, or a retry after a network error) reuses it
    // instead of leaving orphaned Customers behind.
    let customerId: string | undefined;
    if (methods.includes('spei')) {
      const customer = await this.request<{ id: string }>(
        'POST',
        '/customers',
        { email: input.customerEmail ?? undefined, metadata },
        { idempotencyKey: `levelup-customer-${input.orderId}` },
      );
      customerId = customer.id;
    }

    const params: Record<string, unknown> = {
      mode: 'payment',
      locale: 'es-419',
      client_reference_id: input.orderNumber,
      success_url: input.returnUrl,
      cancel_url: input.cancelUrl,
      expires_at: expiresAt,
      payment_method_types: methods.map((m) => STRIPE_WIRE_TYPE[m]),
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
      ...(Object.keys(paymentMethodOptions).length ? { payment_method_options: paymentMethodOptions } : {}),
      ...(customerId
        ? { customer: customerId }
        // Stripe rejects a session carrying both `customer` and
        // `customer_email` together, so this only applies without one.
        : input.customerEmail
          ? { customer_email: input.customerEmail }
          : {}),
    };

    // One session per order, however many times the button is pressed or the
    // request retried. Stripe replays the original response for 24h — but
    // only when every param matches exactly, and `expires_at` above is
    // computed from the current clock, so it differs between a first attempt
    // and any retry seconds or minutes later (a customer resubmitting after
    // a stuck tab, or "Continuar pago" on a resumed order). Stripe then
    // rejects the retry outright with a 400 instead of creating a new
    // session, which is exactly the "No pudimos abrir el pago con tarjeta"
    // customers started hitting once order resumption made retries common.
    // A genuine same-instant double-submit still gets the intended replay
    // (identical params, same second); anything else falls through to a
    // fresh session under a de-duplicated key instead of failing outright.
    let session: StripeSession;
    try {
      session = await this.request<StripeSession>('POST', '/checkout/sessions', params, {
        idempotencyKey: `levelup-checkout-${input.orderId}`,
      });
    } catch (err) {
      if (
        err instanceof StripeApiError &&
        err.status === 400 &&
        /idempotent requests/i.test(err.message)
      ) {
        session = await this.request<StripeSession>('POST', '/checkout/sessions', params, {
          idempotencyKey: `levelup-checkout-${input.orderId}-${this.now()}`,
        });
      } else {
        throw err;
      }
    }

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

  /**
   * Card, embedded — a `PaymentIntent` the browser's Payment Element confirms
   * directly with Stripe. `allow_redirects: 'never'` is deliberate: card,
   * Apple Pay, Google Pay and Link all confirm without ever leaving this
   * page, and forbidding redirects outright guarantees none of them silently
   * fall back to one — the exact "white screen" risk the client asked to
   * avoid this time, see this file's own doc comment.
   *
   * `excluded_payment_method_types: ['oxxo']` is NOT redundant with
   * `allow_redirects: 'never'` — confirmed live in Stripe's own sandbox
   * 2026-11-26: OXXO is a voucher, not a redirect, by Stripe's own
   * classification, so it kept appearing as a selectable method on THIS
   * card PaymentIntent even with redirects forbidden. OXXO is its own
   * separate, manual button in this checkout (never this one) — see
   * checkout.tsx's own 4-button design — so it must be excluded explicitly,
   * not assumed away by the redirect setting. Wallets (Apple Pay/Google
   * Pay/Link) cannot be excluded this same way and don't need to be: they
   * ride on `card`, Stripe's own API rejects trying to exclude them here.
   */
  private async createCardIntentCharge(input: CreateChargeInput): Promise<ChargeCreated> {
    const metadata = { order_id: input.orderId, order_number: input.orderNumber };
    const params: Record<string, unknown> = {
      amount: input.amountCents,
      currency: 'mxn',
      description: `${input.orderNumber} · ${input.description}`,
      metadata,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      excluded_payment_method_types: ['oxxo'],
      ...(input.customerEmail ? { receipt_email: input.customerEmail } : {}),
    };

    // Same idempotent-retry dance as the Checkout Session above — a resumed
    // order or a double-tapped button must reuse the same intent, not mint a
    // second charge, but a genuinely new attempt (seconds or minutes later)
    // must not be rejected outright either.
    let intent: StripeDirectPaymentIntent;
    try {
      intent = await this.request<StripeDirectPaymentIntent>('POST', '/payment_intents', params, {
        idempotencyKey: `levelup-pi-${input.orderId}`,
      });
    } catch (err) {
      if (err instanceof StripeApiError && err.status === 400 && /idempotent requests/i.test(err.message)) {
        intent = await this.request<StripeDirectPaymentIntent>('POST', '/payment_intents', params, {
          idempotencyKey: `levelup-pi-${input.orderId}-${this.now()}`,
        });
      } else {
        throw err;
      }
    }

    if (!intent.client_secret) {
      throw new GatewayError(`PaymentIntent ${intent.id} came back without a client secret`, this.name, true);
    }

    return {
      gateway: this.name,
      gatewayChargeId: intent.id,
      amountCents: intent.amount ?? input.amountCents,
      instructions: { kind: 'stripe_elements', clientSecret: intent.client_secret },
      // No fixed expiry the way a Checkout Session has one — same convention
      // Mercado Pago's embedded card flow already uses: nothing to set here,
      // the order's own deadline stands on its own.
      expiresAt: null,
    };
  }

  // Genuinely synchronous internally — Stripe's webhook body already carries
  // everything needed. `async` only to satisfy the shared interface, which
  // Mercado Pago's implementation needs for real.
  // eslint-disable-next-line @typescript-eslint/require-await
  async verifyWebhook(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<WebhookVerification> {
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

    if (event.type in PAYMENT_INTENT_EVENT_STATES) {
      const intent = event.data?.object;
      if (!intent?.id || intent.object !== 'payment_intent') {
        return { ok: false, reason: 'malformed_payload' };
      }
      if (intent.currency && intent.currency.toLowerCase() !== 'mxn') {
        return { ok: false, reason: 'malformed_payload' };
      }

      const piState = PAYMENT_INTENT_EVENT_STATES[event.type]!;
      const verifiedIntentEvent: PaymentEvent = {
        eventId: event.id,
        type: event.type,
        gatewayChargeId: intent.id,
        state: piState,
        amountReceivedCents: piState === 'paid' ? (intent.amount_received ?? intent.amount ?? null) : null,
        reference: intent.id,
        // Cheap insurance against the exact race `applyGatewayReport`'s own
        // self-heal was widened for (2026-11-26) — this flow is new, so
        // there's no reason to leave it without the same fallback.
        orderNumber: intent.metadata?.order_number ?? null,
        occurredAt: new Date((event.created ?? Math.floor(this.now() / 1000)) * 1000),
        raw: event,
      };
      return { ok: true, event: verifiedIntentEvent };
    }

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
    // A direct PaymentIntent id (the embedded card flow's own) vs. a
    // Checkout Session id (`cs_...`, OXXO/SPEI) — Stripe's own id prefixes
    // are the one reliable way to tell which shape to ask for, since this
    // method takes nothing else that would say so.
    if (gatewayChargeId.startsWith('pi_')) {
      return this.getCardIntentCharge(gatewayChargeId);
    }

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
      bankTransfer: bankTransferDetails(session),
    };
  }

  private async getCardIntentCharge(gatewayChargeId: string): Promise<ChargeSnapshot | null> {
    let intent: StripeDirectPaymentIntent;
    try {
      intent = await this.request<StripeDirectPaymentIntent>(
        'GET',
        `/payment_intents/${encodeURIComponent(gatewayChargeId)}`,
      );
    } catch (err) {
      if (err instanceof StripeNotFound) return null;
      throw err;
    }

    const state = intentState(intent.status);
    return {
      gatewayChargeId: intent.id,
      state,
      amountReceivedCents: state === 'paid' ? (intent.amount_received ?? intent.amount ?? null) : null,
      paidAt: null,
      reference: intent.id,
      voucherUrl: null,
      bankTransfer: null,
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
