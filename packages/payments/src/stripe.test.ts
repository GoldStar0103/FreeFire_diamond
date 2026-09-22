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

    const created = await gateway(impl).createCharge(chargeInput);

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
    expect(body.get('payment_method_types[0]')).toBe('card');
    expect(body.get('payment_method_types[1]')).toBeNull();
    expect(body.get('locale')).toBe('es-419');
  });

  it('keys the request on the order so a double tap cannot open two sessions', async () => {
    const ok = { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } };
    const { impl, calls } = fakeFetch([ok, ok]);
    const gw = gateway(impl);

    await gw.createCharge(chargeInput);
    await gw.createCharge(chargeInput);

    expect(calls[0]?.headers['Idempotency-Key']).toBe('levelup-checkout-ord-uuid-1');
    expect(calls[1]?.headers['Idempotency-Key']).toBe(calls[0]?.headers['Idempotency-Key']);
  });

  it('offers OXXO with a bounded voucher lifetime only when enabled', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } },
    ]);
    await gateway(impl, { methods: ['card', 'oxxo'], oxxoExpiresAfterDays: 30 }).createCharge(chargeInput);

    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get('payment_method_types[1]')).toBe('oxxo');
    expect(body.get('payment_method_options[oxxo][expires_after_days]')).toBe('7');
  });

  it('maps spei to the customer_balance wire type and requires a customer', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } },
    ]);
    await gateway(impl, { methods: ['card', 'spei'] }).createCharge(chargeInput);

    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get('payment_method_types[0]')).toBe('card');
    expect(body.get('payment_method_types[1]')).toBe('customer_balance');
    expect(body.get('payment_method_options[customer_balance][funding_type]')).toBe('bank_transfer');
    expect(body.get('payment_method_options[customer_balance][bank_transfer][type]')).toBe(
      'mx_bank_transfer',
    );
    expect(body.get('customer_creation')).toBe('always');
  });

  it('carries both payment_method_options blocks when OXXO and SPEI are both on', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } },
    ]);
    await gateway(impl, { methods: ['card', 'oxxo', 'spei'] }).createCharge(chargeInput);

    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get('payment_method_options[oxxo][expires_after_days]')).toBe('2');
    expect(body.get('payment_method_options[customer_balance][funding_type]')).toBe('bank_transfer');
  });

  it('never asks for a session shorter than Stripe accepts', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'cs_1', url: 'https://x', amount_total: 26_000 } },
    ]);
    await gateway(impl, { sessionMinutes: 5 }).createCharge(chargeInput);

    const expiresAt = Number(new URLSearchParams(calls[0]?.body).get('expires_at'));
    expect(expiresAt - NOW_S).toBeGreaterThanOrEqual(30 * 60);
  });

  it('refuses without return URLs, before calling Stripe', async () => {
    const { impl, calls } = fakeFetch([]);
    const { returnUrl: _r, ...noReturn } = chargeInput;
    await expect(gateway(impl).createCharge(noReturn)).rejects.toBeInstanceOf(GatewayError);
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
  it('reads a paid card checkout as paid, with the amount and intent reference', () => {
    const result = deliver(
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

  it('reads an issued OXXO voucher as pending — a voucher is not money', () => {
    const result = deliver(
      event('checkout.session.completed', { status: 'complete', payment_status: 'unpaid' }),
    );
    expect(result).toMatchObject({ ok: true, event: { state: 'pending', amountReceivedCents: null } });
  });

  it('reads the OXXO settlement, lapse and abandoned sessions', () => {
    expect(deliver(event('checkout.session.async_payment_succeeded', { payment_status: 'paid' })))
      .toMatchObject({ ok: true, event: { state: 'paid', amountReceivedCents: 26_000 } });
    expect(deliver(event('checkout.session.async_payment_failed', {})))
      .toMatchObject({ ok: true, event: { state: 'failed' } });
    expect(deliver(event('checkout.session.expired', { status: 'expired' })))
      .toMatchObject({ ok: true, event: { state: 'expired' } });
  });

  it('rejects a forged signature before looking at the body', () => {
    const body = event('checkout.session.completed', { payment_status: 'paid' });
    expect(deliver(body, 'whsec_attacker')).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a delivery with no signature header', () => {
    const body = event('checkout.session.completed', { payment_status: 'paid' });
    expect(gateway(fakeFetch([]).impl).verifyWebhook(body, {})).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('refuses a session in another currency rather than compare it to pesos', () => {
    const body = event('checkout.session.completed', { payment_status: 'paid', currency: 'usd' });
    expect(deliver(body)).toEqual({ ok: false, reason: 'malformed_payload' });
  });

  it('acknowledges authentic events it does not act on as unsupported', () => {
    const body = JSON.stringify({ id: 'evt_2', type: 'customer.created', data: { object: {} } });
    expect(deliver(body)).toEqual({ ok: false, reason: 'unsupported_event' });
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
