/**
 * Payment gateway abstraction.
 *
 * The client has moved from Conekta to asking about Stripe while the build was
 * in progress, which is exactly why this is a port rather than a direct
 * integration. Swapping providers should be one adapter, not a rewrite.
 *
 * Two rules hold for every implementation:
 *
 *   1. A webhook is untrusted input until its signature verifies. It arrives on
 *      a public endpoint and says "this order was paid" — the single most
 *      valuable sentence an attacker could forge.
 *   2. Confirming a payment never happens here. This layer reports what the
 *      gateway said; `approvePayment` in the engine decides what it means, so
 *      a manual comprobante and a gateway webhook go down the same path with
 *      the same amount checks and the same idempotency.
 */

export type GatewayMethod = 'spei' | 'oxxo' | 'card';

export interface CreateChargeInput {
  orderId: string;
  orderNumber: string;
  amountCents: number;
  method: GatewayMethod;
  /** Shown on the customer's statement or OXXO slip. */
  description: string;
  customerEmail?: string | null;
  customerPhone?: string | null;
  /** OXXO vouchers and SPEI references expire; the order expires with them. */
  expiresAt?: Date | null;
}

/**
 * What the customer needs in order to pay.
 *
 * Deliberately a union: an OXXO voucher and a card redirect are not the same
 * shape, and flattening them into optional fields invites rendering a barcode
 * that is not there.
 */
export type PaymentInstructions =
  | { kind: 'spei'; clabe: string; bank: string; reference: string | null }
  | { kind: 'oxxo'; reference: string; voucherUrl: string | null; barcodeUrl: string | null }
  | { kind: 'redirect'; url: string };

export interface ChargeCreated {
  gateway: string;
  gatewayChargeId: string;
  amountCents: number;
  instructions: PaymentInstructions;
  expiresAt: Date | null;
}

export type ChargeState = 'pending' | 'paid' | 'expired' | 'failed' | 'refunded';

export interface ChargeSnapshot {
  gatewayChargeId: string;
  state: ChargeState;
  /** What actually arrived. May differ from the amount requested. */
  amountReceivedCents: number | null;
  paidAt: Date | null;
}

/** A verified webhook, reduced to what the engine acts on. */
export interface PaymentEvent {
  /** Gateway's own event id. The unique constraint on it is the dedupe. */
  eventId: string;
  type: string;
  gatewayChargeId: string | null;
  /** Present on payment events; null on everything else. */
  state: ChargeState | null;
  amountReceivedCents: number | null;
  occurredAt: Date;
  /** The raw payload, stored verbatim for audit. */
  raw: unknown;
}

export type WebhookVerification =
  | { ok: true; event: PaymentEvent }
  | { ok: false; reason: WebhookRejection };

export type WebhookRejection =
  | 'missing_signature'
  | 'malformed_signature'
  | 'bad_signature'
  | 'stale_timestamp'
  | 'malformed_payload'
  | 'unsupported_event';

export interface PaymentGateway {
  readonly name: string;
  /** Methods this gateway is actually configured for, not what it can do. */
  readonly supportedMethods: readonly GatewayMethod[];

  createCharge(input: CreateChargeInput): Promise<ChargeCreated>;

  /**
   * Verify and parse a webhook.
   *
   * Takes the RAW body, never a parsed object: signatures are computed over
   * exact bytes, and `JSON.parse` followed by `JSON.stringify` will not
   * reproduce them.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): WebhookVerification;

  /**
   * Ask the gateway directly. Used by the reconciliation cron to catch payments
   * whose webhook never arrived — never trust the webhook as the only path.
   */
  getCharge(gatewayChargeId: string): Promise<ChargeSnapshot | null>;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly gateway: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}
