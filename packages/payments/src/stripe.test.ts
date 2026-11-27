import { describe, expect, it } from 'vitest';
import { signPayload } from './signature.js';
import { formEncode, StripeGateway } from './stripe.js';
import { GatewayError } from './types.js';

const SECRET = 'whsec_test_levelup';
const NOW_MS = 1_760_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that records what was sent and answers from a script. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    });
    const next = responses.shift() ?? { status: 500, body: { error: { message: 'no script' } } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof StripeGateway>[0]> = {}) {
  return new StripeGateway({
    secretKey: 'sk_test_123',
    webhookSecret: SECRET,
    fetch: fetchImpl,
    now: () => NOW_MS,
    ...extra,
  });
}

const chargeInput = {
  orderId: 'ord-uuid-1',
  orderNumber: 'LU-260910-AB12',
  amountCents: 26_000,
  method: 'card' as const,
  description: 'Descuentos Chidos 1700 — 1,700 diamantes',
  returnUrl: 'https://levelupstore.mx/pedido/LU-260910-AB12?id=123456789',
  cancelUrl: 'https://levelupstore.mx/comprar/dc_1700?cancelado=LU-260910-AB12&id=123456789',
};

describe('formEncode', () => {
  it('uses Stripe bracket notation for nesting and arrays', () => {
    const encoded = decodeURIComponent(
      formEncode({ a: 1, b: { c: 'x', d: [{ e: 2 }] }, f: ['card', 'oxxo'], skip: undefined }),
    );
    expect(encoded).toBe('a=1&b[c]=x&b[d][0][e]=2&f[0]=card&f[1]=oxxo');
  });

  it('escapes values so a combo name cannot inject parameters', () => {
    expect(formEncode({ name: 'A&b=c' })).toBe('name=A%26b%3Dc');
  });
});

describe('createCharge', () => {
  // OXXO stands in for every test below that's really about hosted
  // Checkout's own mechanics (idempotency, retry, expiry, URLs) rather than
  // about any one payment method — card moved off this endpoint entirely
  // 2026-11-26 (see the 'card — embedded PaymentIntent' block further down),
  // so these use `method: 'oxxo'` instead of plain `chargeInput` now.
  const oxxoInput = { ...chargeInput, method: 'oxxo' as const };
  const oxxoOnly = { methods: ['oxxo' as const] };

  it('creates an MXN Checkout session carrying the order on both session and intent', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'cs_test_1',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          amount_total: 26_000,
          expires_at: NOW_S + 3600,
        },
      },
    ]);

    const created = await gateway(impl, oxxoOnly).createCharge(oxxoInput);

    expect(created).toMatchObject({
      gateway: 'stripe',
      gatewayChargeId: 'cs_test_1',
      amountCents: 26_000,
      instructions: { kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_1' },
    });

    const [call] = calls;
    expect(call?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(call?.headers.Authorization).toBe('Bearer sk_test_123');
    const body = new URLSearchParams(call?.body);
    expect(body.get('line_items[0][price_data][currency]')).toBe('mxn');
    expect(body.get('line_items[0][price_data][unit_amount]')).toBe('26000');
    expect(body.get('metadata[order_id]')).toBe('ord-uuid-1');
    expect(body.get('payment_intent_data[metadata][order_number]')).toBe('LU-260910-AB12');
    expect(body.get('client_reference_id')).toBe('LU-260910-AB12');
    expect(body.get('payment_method_types[0]')).toBe('oxxo');
    expect(body.get('payment_method_types[1]')).toBeNull();
    expect(body.get('locale')).toBe('es-419');
  });

  it('keys the request on the order so a double tap cannot open two sessions', async () => {
    const ok = { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } };
    const { impl, calls } = fakeFetch([ok, ok]);
    const gw = gateway(impl, oxxoOnly);

    await gw.createCharge(oxxoInput);
    await gw.createCharge(oxxoInput);

    expect(calls[0]?.headers['Idempotency-Key']).toBe('levelup-checkout-ord-uuid-1');
    expect(calls[1]?.headers['Idempotency-Key']).toBe(calls[0]?.headers['Idempotency-Key']);
  });

  it('retries under a fresh key when Stripe refuses a reused one with different params', async () => {
    // Real production case: `expires_at` is computed from the clock, so a
    // retry seconds/minutes later ("Continuar pago", a resubmit after a
    // stuck tab) sends a different payload under the same order-keyed
    // Idempotency-Key. Stripe rejects that outright instead of creating a
    // new session — this must recover by retrying once under a de-duplicated
    // key, not surface "No pudimos abrir el pago con tarjeta" to the customer.
    const { impl, calls } = fakeFetch([
      {
        status: 400,
        body: {
          error: {
            message:
              "Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than 'levelup-checkout-ord-uuid-1' if you meant to execute a different request.",
          },
        },
      },
      { status: 200, body: { id: 'cs_2', url: 'https://retry', amount_total: 26_000 } },
    ]);

    const created = await gateway(impl, oxxoOnly).createCharge(oxxoInput);

    expect(created).toMatchObject({ gatewayChargeId: 'cs_2', instructions: { url: 'https://retry' } });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.headers['Idempotency-Key']).toBe('levelup-checkout-ord-uuid-1');
    expect(calls[1]?.headers['Idempotency-Key']).toBe(`levelup-checkout-ord-uuid-1-${NOW_MS}`);
  });

  it('does not retry a plain 400 that has nothing to do with idempotency', async () => {
    const { impl } = fakeFetch([{ status: 400, body: { error: { message: 'bad param' } } }]);
    await expect(gateway(impl, oxxoOnly).createCharge(oxxoInput)).rejects.toMatchObject({ retryable: false });
  });

  it('requests only the single method the customer picked, never the others enabled', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } },
    ]);
    // All three are enabled on the account, but the customer specifically
    // tapped "OXXO" — the session must offer OXXO alone, not a bundle, so
    // Stripe's own page never invites them to switch to card or a transfer.
    await gateway(impl, { methods: ['card', 'oxxo', 'spei'], oxxoExpiresAfterDays: 30 }).createCharge({
      ...chargeInput,
      method: 'oxxo',
    });

    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get('payment_method_types[0]')).toBe('oxxo');
    expect(body.get('payment_method_types[1]')).toBeNull();
    expect(body.get('payment_method_options[oxxo][expires_after_days]')).toBe('7');
    expect(body.get('payment_method_options[customer_balance]')).toBeNull();
  });

  it('maps spei to the customer_balance wire type and creates a real Customer first', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'cus_1' } },
      { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } },
    ]);
    await gateway(impl, { methods: ['card', 'spei'] }).createCharge({ ...chargeInput, method: 'spei' });

    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/customers');
    expect(calls[0]?.headers['Idempotency-Key']).toBe('levelup-customer-ord-uuid-1');

    const body = new URLSearchParams(calls[1]?.body);
    expect(body.get('payment_method_types[0]')).toBe('customer_balance');
    expect(body.get('payment_method_types[1]')).toBeNull();
    expect(body.get('payment_method_options[customer_balance][funding_type]')).toBe('bank_transfer');
    expect(body.get('payment_method_options[customer_balance][bank_transfer][type]')).toBe(
      'mx_bank_transfer',
    );
    // Stripe rejects a session sent with both `customer` and `customer_email`.
    expect(body.get('customer')).toBe('cus_1');
    expect(body.get('customer_email')).toBeNull();
    expect(body.get('customer_creation')).toBeNull();
  });

  it('does not create a Customer for an OXXO charge, and keeps customer_email', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } },
    ]);
    await gateway(impl, oxxoOnly).createCharge({
      ...oxxoInput,
      customerEmail: 'buyer@example.com',
    });

    expect(calls).toHaveLength(1);
    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get('customer_email')).toBe('buyer@example.com');
    expect(body.get('customer')).toBeNull();
  });

  it('refuses a method the account does not have enabled, before calling Stripe', async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(
      gateway(impl, { methods: ['card'] }).createCharge({ ...chargeInput, method: 'oxxo' }),
    ).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(0);
  });

  it('never asks for a session shorter than Stripe accepts', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } },
    ]);
    await gateway(impl, { ...oxxoOnly, sessionMinutes: 5 }).createCharge(oxxoInput);

    const expiresAt = Number(new URLSearchParams(calls[0]?.body).get('expires_at'));
    expect(expiresAt - NOW_S).toBeGreaterThanOrEqual(30 * 60);
  });

  it('refuses without return URLs, before calling Stripe — OXXO/SPEI still need the hosted page', async () => {
    const { impl, calls } = fakeFetch([]);
    const { returnUrl: _r, ...noReturn } = oxxoInput;
    await expect(gateway(impl, oxxoOnly).createCharge(noReturn)).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toHaveLength(0);
  });

  it('marks Stripe outages retryable and bad requests not', async () => {
    const { impl } = fakeFetch([
      { status: 503, body: { error: { message: 'down' } } },
      { status: 400, body: { error: { message: 'bad param' } } },
    ]);
    const gw = gateway(impl);

    await expect(gw.createCharge(chargeInput)).rejects.toMatchObject({ retryable: true });
    await expect(gw.createCharge(chargeInput)).rejects.toMatchObject({ retryable: false });
  });
});

describe('createCharge — card, embedded PaymentIntent', () => {
  it('creates a PaymentIntent with redirects forbidden, never a Checkout Session', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'pi_test_1', object: 'payment_intent', amount: 26_000, client_secret: 'pi_test_1_secret_abc' } },
    ]);

    const created = await gateway(impl).createCharge(chargeInput);

    expect(created).toMatchObject({
      gateway: 'stripe',
      gatewayChargeId: 'pi_test_1',
      amountCents: 26_000,
      instructions: { kind: 'stripe_elements', clientSecret: 'pi_test_1_secret_abc' },
      expiresAt: null,
    });

    const [call] = calls;
    expect(call?.url).toBe('https://api.stripe.com/v1/payment_intents');
    const body = new URLSearchParams(call?.body);
    expect(body.get('amount')).toBe('26000');
    expect(body.get('currency')).toBe('mxn');
    expect(body.get('automatic_payment_methods[enabled]')).toBe('true');
    // The one thing that must never happen for this flow — see this file's
    // own doc comment on why: a redirect here would be the exact "white
    // screen" regression the client asked to avoid.
    expect(body.get('automatic_payment_methods[allow_redirects]')).toBe('never');
    // Confirmed live in Stripe's own sandbox 2026-11-26: OXXO is a voucher,
    // not a redirect, so it kept appearing on this card intent even with
    // redirects forbidden — must be excluded explicitly, since OXXO is its
    // own separate, manual button in this checkout, never this one.
    expect(body.get('excluded_payment_method_types[0]')).toBe('oxxo');
    // Confirmed in production 2026-11-26: Stripe's own default here is
    // `automatic_async`, which can leave the final status lagging the
    // confirm call by several minutes — a real payment authorized fine but
    // arrived after this app's own order had already expired. Forced to
    // synchronous so `getCharge` right after confirm already has the truth.
    expect(body.get('capture_method')).toBe('automatic');
    expect(body.get('metadata[order_id]')).toBe('ord-uuid-1');
    expect(body.get('metadata[order_number]')).toBe('LU-260910-AB12');
  });

  it('needs no return/cancel URL — card never leaves this page', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'pi_1', object: 'payment_intent', amount: 26_000, client_secret: 'secret' } },
    ]);
    const { returnUrl: _r, cancelUrl: _c, ...noUrls } = chargeInput;

    await expect(gateway(impl).createCharge(noUrls)).resolves.toMatchObject({ gatewayChargeId: 'pi_1' });
    expect(calls).toHaveLength(1);
  });

  it('passes the customer email through as a receipt email', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'pi_1', object: 'payment_intent', amount: 26_000, client_secret: 'secret' } },
    ]);
    await gateway(impl).createCharge({ ...chargeInput, customerEmail: 'buyer@example.com' });

    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get('receipt_email')).toBe('buyer@example.com');
  });

  it('keys the request on the order, same as the Checkout Session path', async () => {
    const ok = { status: 200, body: { id: 'pi_1', object: 'payment_intent', amount: 26_000, client_secret: 'secret' } };
    const { impl, calls } = fakeFetch([ok, ok]);
    const gw = gateway(impl);

    await gw.createCharge(chargeInput);
    await gw.createCharge(chargeInput);

    expect(calls[0]?.headers['Idempotency-Key']).toBe('levelup-pi-ord-uuid-1');
    expect(calls[1]?.headers['Idempotency-Key']).toBe(calls[0]?.headers['Idempotency-Key']);
  });

  it('retries under a fresh key when Stripe refuses a reused one with different params', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 400,
        body: {
          error: {
            message:
              "Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than 'levelup-pi-ord-uuid-1' if you meant to execute a different request.",
          },
        },
      },
      { status: 200, body: { id: 'pi_2', object: 'payment_intent', amount: 26_000, client_secret: 'secret-2' } },
    ]);

    const created = await gateway(impl).createCharge(chargeInput);

    expect(created).toMatchObject({ gatewayChargeId: 'pi_2' });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers['Idempotency-Key']).toBe(`levelup-pi-ord-uuid-1-${NOW_MS}`);
  });

  it('refuses a card charge with no client secret rather than hand the Brick nothing to mount', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { id: 'pi_1', object: 'payment_intent', amount: 26_000 } }]);
    await expect(gateway(impl).createCharge(chargeInput)).rejects.toBeInstanceOf(GatewayError);
  });

  it('refuses a card charge below Stripe\'s $10 MXN minimum before ever calling Stripe', async () => {
    const { impl, calls } = fakeFetch([]);
    const err = await gateway(impl)
      .createCharge({ ...chargeInput, amountCents: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).message).toMatch(/10\.00 MXN/);
    expect(calls).toHaveLength(0);
  });

  it('allows a card charge at exactly the $10 MXN minimum', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'pi_1', object: 'payment_intent', amount: 1000, client_secret: 'secret-1' } },
    ]);
    await expect(
      gateway(impl).createCharge({ ...chargeInput, amountCents: 1000 }),
    ).resolves.toMatchObject({ gatewayChargeId: 'pi_1' });
  });

  it('still refuses card when the account does not have it enabled', async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(gateway(impl, { methods: ['oxxo'] }).createCharge(chargeInput)).rejects.toMatchObject({
      retryable: false,
    });
    expect(calls).toHaveLength(0);
  });
});

// ── webhooks ──────────────────────────────────────────────────────────────────

function event(type: string, session: Record<string, unknown>, id = 'evt_1') {
  return JSON.stringify({
    id,
    type,
    created: NOW_S,
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        currency: 'mxn',
        amount_total: 26_000,
        payment_intent: 'pi_123',
        ...session,
      },
    },
  });
}

function deliver(body: string, secret = SECRET) {
  return gateway(fakeFetch([]).impl).verifyWebhook(body, {
    'stripe-signature': signPayload(body, secret, NOW_S),
  });
}

describe('verifyWebhook', () => {
  it('reads a paid card checkout as paid, with the amount and intent reference', async () => {
    const result = await deliver(
      event('checkout.session.completed', { status: 'complete', payment_status: 'paid' }),
    );
    expect(result).toMatchObject({
      ok: true,
      event: {
        eventId: 'evt_1',
        gatewayChargeId: 'cs_test_1',
        state: 'paid',
        amountReceivedCents: 26_000,
        reference: 'pi_123',
      },
    });
  });

  it('reads an issued OXXO voucher as pending — a voucher is not money', async () => {
    const result = await deliver(
      event('checkout.session.completed', { status: 'complete', payment_status: 'unpaid' }),
    );
    expect(result).toMatchObject({ ok: true, event: { state: 'pending', amountReceivedCents: null } });
  });

  it('reads the OXXO settlement, lapse and abandoned sessions', async () => {
    expect(await deliver(event('checkout.session.async_payment_succeeded', { payment_status: 'paid' })))
      .toMatchObject({ ok: true, event: { state: 'paid', amountReceivedCents: 26_000 } });
    expect(await deliver(event('checkout.session.async_payment_failed', {})))
      .toMatchObject({ ok: true, event: { state: 'failed' } });
    expect(await deliver(event('checkout.session.expired', { status: 'expired' })))
      .toMatchObject({ ok: true, event: { state: 'expired' } });
  });

  it('rejects a forged signature before looking at the body', async () => {
    const body = event('checkout.session.completed', { payment_status: 'paid' });
    expect(await deliver(body, 'whsec_attacker')).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a delivery with no signature header', async () => {
    const body = event('checkout.session.completed', { payment_status: 'paid' });
    expect(await gateway(fakeFetch([]).impl).verifyWebhook(body, {})).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('refuses a session in another currency rather than compare it to pesos', async () => {
    const body = event('checkout.session.completed', { payment_status: 'paid', currency: 'usd' });
    expect(await deliver(body)).toEqual({ ok: false, reason: 'malformed_payload' });
  });

  it('acknowledges authentic events it does not act on as unsupported', async () => {
    const body = JSON.stringify({ id: 'evt_2', type: 'customer.created', data: { object: {} } });
    expect(await deliver(body)).toEqual({ ok: false, reason: 'unsupported_event' });
  });
});

function intentEvent(type: string, intent: Record<string, unknown>, id = 'evt_pi_1') {
  return JSON.stringify({
    id,
    type,
    created: NOW_S,
    data: {
      object: {
        id: 'pi_test_1',
        object: 'payment_intent',
        currency: 'mxn',
        amount: 26_000,
        metadata: { order_number: 'LU-260910-AB12' },
        ...intent,
      },
    },
  });
}

describe('verifyWebhook — card, embedded PaymentIntent', () => {
  it('reads a succeeded PaymentIntent as paid, with amount_received and the order number for self-heal', async () => {
    const result = await deliver(intentEvent('payment_intent.succeeded', { amount_received: 26_000 }));
    expect(result).toMatchObject({
      ok: true,
      event: {
        eventId: 'evt_pi_1',
        gatewayChargeId: 'pi_test_1',
        state: 'paid',
        amountReceivedCents: 26_000,
        reference: 'pi_test_1',
        orderNumber: 'LU-260910-AB12',
      },
    });
  });

  it('falls back to amount when amount_received is missing', async () => {
    const result = await deliver(intentEvent('payment_intent.succeeded', {}));
    expect(result).toMatchObject({ ok: true, event: { amountReceivedCents: 26_000 } });
  });

  it('reads a declined or canceled intent as failed, never as money', async () => {
    expect(await deliver(intentEvent('payment_intent.payment_failed', {})))
      .toMatchObject({ ok: true, event: { state: 'failed', amountReceivedCents: null } });
    expect(await deliver(intentEvent('payment_intent.canceled', {})))
      .toMatchObject({ ok: true, event: { state: 'failed', amountReceivedCents: null } });
  });

  it('rejects a PaymentIntent in another currency rather than compare it to pesos', async () => {
    const body = intentEvent('payment_intent.succeeded', { currency: 'usd' });
    expect(await deliver(body)).toEqual({ ok: false, reason: 'malformed_payload' });
  });

  it('rejects a forged signature before looking at the body', async () => {
    const body = intentEvent('payment_intent.succeeded', {});
    expect(await deliver(body, 'whsec_attacker')).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('getCharge', () => {
  it('reports an OXXO voucher still to be paid, with its hosted voucher', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'cs_1',
          status: 'complete',
          payment_status: 'unpaid',
          amount_total: 26_000,
          payment_intent: {
            id: 'pi_1',
            next_action: { oxxo_display_details: { hosted_voucher_url: 'https://voucher' } },
          },
        },
      },
    ]);

    const snapshot = await gateway(impl).getCharge('cs_1');
    expect(snapshot).toMatchObject({ state: 'pending', voucherUrl: 'https://voucher', reference: 'pi_1' });
    expect(calls[0]?.url).toContain('expand[]=payment_intent');
  });

  it('reports SPEI bank-transfer instructions still to be paid', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'cs_1',
          status: 'complete',
          payment_status: 'unpaid',
          amount_total: 26_000,
          payment_intent: {
            id: 'pi_1',
            next_action: {
              display_bank_transfer_instructions: {
                hosted_instructions_url: 'https://payments.stripe.com/instructions',
                reference: 'REF123',
                financial_addresses: [
                  { type: 'clabe', clabe: { clabe: '002313392375982033', bank_name: 'STP' } },
                ],
              },
            },
          },
        },
      },
    ]);

    const snapshot = await gateway(impl).getCharge('cs_1');
    expect(snapshot).toMatchObject({
      state: 'pending',
      reference: 'pi_1',
      bankTransfer: {
        hostedInstructionsUrl: 'https://payments.stripe.com/instructions',
        clabe: '002313392375982033',
        bankName: 'STP',
        reference: 'REF123',
      },
    });
  });

  it('returns null for a session Stripe does not know', async () => {
    const { impl } = fakeFetch([{ status: 404, body: { error: { message: 'No such session' } } }]);
    expect(await gateway(impl).getCharge('cs_nope')).toBeNull();
  });

  it('routes a pi_ id to the PaymentIntent endpoint instead of Checkout Sessions', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'pi_1', object: 'payment_intent', status: 'succeeded', amount: 26_000, amount_received: 26_000 } },
    ]);

    const snapshot = await gateway(impl).getCharge('pi_1');

    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/payment_intents/pi_1');
    expect(snapshot).toMatchObject({ state: 'paid', amountReceivedCents: 26_000, reference: 'pi_1' });
  });

  it('carries the order number through from the PaymentIntent metadata', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'pi_1', object: 'payment_intent', status: 'succeeded', amount: 26_000, amount_received: 26_000, metadata: { order_number: 'LU-261126-AB12' } } },
    ]);
    expect(await gateway(impl).getCharge('pi_1')).toMatchObject({ orderNumber: 'LU-261126-AB12' });
  });

  it('reports a card still awaiting confirmation (3DS, etc.) as pending, with no amount', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'pi_1', object: 'payment_intent', status: 'requires_action', amount: 26_000 } },
    ]);
    expect(await gateway(impl).getCharge('pi_1')).toMatchObject({ state: 'pending', amountReceivedCents: null });
  });

  it('returns null for a PaymentIntent Stripe does not know', async () => {
    const { impl } = fakeFetch([{ status: 404, body: { error: { message: 'No such payment_intent' } } }]);
    expect(await gateway(impl).getCharge('pi_nope')).toBeNull();
  });
});

describe('pendingGraceDays', () => {
  it('picks the larger of whichever async methods are actually enabled', () => {
    expect(gateway(fakeFetch([]).impl, { methods: ['card'] }).pendingGraceDays).toBe(2);
    expect(
      gateway(fakeFetch([]).impl, { methods: ['card', 'oxxo'], oxxoExpiresAfterDays: 5 }).pendingGraceDays,
    ).toBe(5);
    expect(
      gateway(fakeFetch([]).impl, { methods: ['card', 'spei'], speiGraceDays: 4 }).pendingGraceDays,
    ).toBe(4);
    expect(
      gateway(fakeFetch([]).impl, {
        methods: ['card', 'oxxo', 'spei'],
        oxxoExpiresAfterDays: 2,
        speiGraceDays: 6,
      }).pendingGraceDays,
    ).toBe(6);
  });
});

describe('expireSession', () => {
  it('distinguishes a session that is no longer open from a key problem', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'cs_1', status: 'expired' } },
      { status: 400, body: { error: { message: 'Only open sessions can be expired' } } },
      { status: 401, body: { error: { message: 'Invalid API key' } } },
    ]);
    const gw = gateway(impl);

    expect(await gw.expireSession('cs_1')).toBe('expired');
    expect(await gw.expireSession('cs_1')).toBe('not_open');
    await expect(gw.expireSession('cs_1')).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('construction', () => {
  it('refuses to exist without a webhook secret', () => {
    expect(() => new StripeGateway({ secretKey: 'sk_test_1', webhookSecret: '' })).toThrow(/webhook/);
  });

  it('knows a test key from a live one', () => {
    expect(gateway(fakeFetch([]).impl).testMode).toBe(true);
    expect(gateway(fakeFetch([]).impl, { secretKey: 'sk_live_1' }).testMode).toBe(false);
  });
});
