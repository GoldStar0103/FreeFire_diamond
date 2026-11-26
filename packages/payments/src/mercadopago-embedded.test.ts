import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MercadoPagoEmbeddedGateway, orderState } from './mercadopago-embedded.js';
import { GatewayError } from './types.js';

const SECRET = 'mp-embedded-secret-test';
const NOW_MS = 1_760_000_000_000;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
    });
    const next = responses.shift() ?? { status: 500, body: { message: 'no script' } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function gateway(
  fetchImpl: typeof fetch,
  extra: Partial<ConstructorParameters<typeof MercadoPagoEmbeddedGateway>[0]> = {},
) {
  return new MercadoPagoEmbeddedGateway({
    accessToken: 'APP_USR-test-token',
    webhookSecret: SECRET,
    fetch: fetchImpl,
    now: () => NOW_MS,
    ...extra,
  });
}

const cardInput = {
  orderId: 'ord-uuid-1',
  orderNumber: 'LU-260924-AB12',
  amountCents: 1_800,
  method: 'card' as const,
  description: 'Mini Pack — 110 diamantes',
  cardToken: 'card_tok_abc123',
  paymentMethodId: 'visa',
  installments: 1,
  deviceSessionId: 'device-session-xyz',
};

const speiInput = {
  orderId: 'ord-uuid-2',
  orderNumber: 'LU-260924-CD34',
  amountCents: 2_500,
  method: 'spei' as const,
  description: 'Mega Pack — 500 diamantes',
};

describe('createCharge — card', () => {
  it('creates an order with a card transaction, keyed on the order and carrying the device session id', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'ord_mp_1',
          status: 'processed',
          external_reference: 'LU-260924-AB12',
          total_amount: '18.00',
          transactions: { payments: [{ id: 'txn_1', status: 'accredited', payment_method: { type: 'credit_card' } }] },
        },
      },
    ]);

    const created = await gateway(impl, { methods: ['card'] }).createCharge(cardInput);

    expect(created).toEqual({
      gateway: 'mercadopago-embedded',
      gatewayChargeId: 'ord_mp_1',
      amountCents: 1_800,
      instructions: { kind: 'resolved', state: 'paid', reference: 'txn_1', challengeUrl: null },
      expiresAt: null,
    });

    const [call] = calls;
    expect(call?.url).toBe('https://api.mercadopago.com/v1/orders');
    expect(call?.headers.Authorization).toBe('Bearer APP_USR-test-token');
    expect(call?.headers['X-Idempotency-Key']).toBe('levelup-mp-ord-uuid-1-card_tok_abc123');
    expect(call?.headers['X-meli-session-id']).toBe('device-session-xyz');

    const body = JSON.parse(call!.body!);
    expect(body.external_reference).toBe('LU-260924-AB12');
    expect(body.total_amount).toBe('18.00');
    expect(body.transactions.payments[0]).toMatchObject({
      payment_method: { id: 'visa', type: 'credit_card', token: 'card_tok_abc123', installments: 1 },
    });
    // `on_fraud_risk` over `never`: lets a risky-looking card go through its
    // bank's own verification instead of Mercado Pago flatly rejecting it —
    // confirmed in production 2026-11-24 that `never` was declining
    // legitimate repeat-use cards outright as 'high_risk' with no recourse.
    // Applied to every card charge regardless of amount (reverted the >500
    // MXN gate 2026-11-25 per Jose's explicit request — see the dedicated
    // test below for the full reasoning). `liability_shift: 'required'` is
    // mandatory whenever validation isn't 'never' (Mercado Pago's own
    // docs) — nested inside `transaction_security` itself. A first attempt
    // put it at the top level of the body instead, which broke every single
    // card charge in production (confirmed same day: "additionalProperties
    // '$.liability_shift' not allowed").
    expect(body.config).toEqual({
      online: { transaction_security: { validation: 'on_fraud_risk', liability_shift: 'required' } },
    });
    expect(body.liability_shift).toBeUndefined();
  });

  it('adds on_fraud_risk/liability_shift to every card charge, no amount gate', async () => {
    // Confirmed live 2026-11-25: Jose is deliberately running every friction
    // layer as low as Mercado Pago's API allows for several days, to measure
    // how many "rejected" orders were actually lost legitimate sales, before
    // dialing security back up gradually. A >500 MXN gate existed here for
    // one day (2026-11-24) and was reverted the next day for exactly this —
    // `on_fraud_risk` is the most permissive of the three documented values
    // that still avoids a flat decline (`'never'` is strictly more likely to
    // reject outright, not less — that was the original problem this setting
    // was built to fix); there is no literal "disable fraud checking" value
    // Mercado Pago's API exposes.
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'ord_mp_small', status: 'processed', transactions: { payments: [{ status: 'accredited' }] } } },
    ]);
    await gateway(impl, { methods: ['card'] }).createCharge({ ...cardInput, amountCents: 100 });
    const body = JSON.parse(calls[0]!.body!);
    expect(body.config).toEqual({
      online: { transaction_security: { validation: 'on_fraud_risk', liability_shift: 'required' } },
    });
    expect(body.liability_shift).toBeUndefined();
  });

  it('does not send config for SPEI — no card, no 3DS concept', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'ord_mp_1', status: 'processing', external_reference: 'LU-1', transactions: { payments: [{ status: 'pending' }] } } },
    ]);
    await gateway(impl, { methods: ['spei'] }).createCharge(speiInput);
    const body = JSON.parse(calls[0]!.body!);
    expect(body.config).toBeUndefined();
  });

  it('surfaces a card\'s 3D Secure challenge URL when the bank requires one', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'ord_mp_4',
          status: 'action_required',
          status_detail: 'pending_challenge',
          external_reference: 'LU-260924-AB12',
          transactions: {
            payments: [
              {
                id: 'txn_4',
                status: 'action_required',
                payment_method: {
                  type: 'credit_card',
                  transaction_security: { url: 'https://mp.test/3ds/challenge/abc123' },
                },
              },
            ],
          },
        },
      },
    ]);
    const created = await gateway(impl).createCharge(cardInput);
    expect(created.instructions).toEqual({
      kind: 'resolved',
      state: 'pending',
      reference: 'txn_4',
      challengeUrl: 'https://mp.test/3ds/challenge/abc123',
    });
  });

  it('normalizes a debit card\'s payment_method_id to the bare network name and sets type: debit_card', async () => {
    // Confirmed in production 2026-11-24: Mercado Pago's own Brick reports
    // 'debvisa'/'debmaster' for a debit card, which the Orders API rejects
    // outright — it only accepts 'visa'/'master'/'amex', with debit-vs-credit
    // conveyed through `type` instead. This was blocking every debit card,
    // not an edge case, since most Mexican cards are debit.
    const ok = {
      status: 200,
      body: { id: 'ord_mp_1', status: 'processed', external_reference: 'LU-1', transactions: { payments: [{ id: 'txn_1', status: 'accredited' }] } },
    };
    const { impl, calls } = fakeFetch([ok]);
    await gateway(impl).createCharge({ ...cardInput, paymentMethodId: 'debvisa' });

    const body = JSON.parse(calls[0]!.body!);
    expect(body.transactions.payments[0].payment_method).toMatchObject({ id: 'visa', type: 'debit_card' });
  });

  it('retries once with the exact payment_method.id Mercado Pago\'s own 400 names, when the first guess is wrong', async () => {
    // Confirmed in production 2026-11-24: a second real debit card hit the
    // mirror-image failure of the one above — our stripped bare id was
    // rejected, and Mercado Pago's own error said only the prefixed id would
    // work for this token. No static prefix rule survives every card, so the
    // adapter must retry using exactly what the error names.
    const rejection = {
      status: 400,
      body: {
        errors: [
          {
            code: 'property_value',
            message: 'Invalid value for property',
            details: ["'$.transactions.payments[0].payment_method.id' - value must be one of 'debmaster', 'debvisa'"],
          },
        ],
      },
    };
    const ok = {
      status: 200,
      body: { id: 'ord_mp_retry', status: 'processed', external_reference: 'LU-1', transactions: { payments: [{ id: 'txn_retry', status: 'accredited' }] } },
    };
    const { impl, calls } = fakeFetch([rejection, ok]);
    const result = await gateway(impl).createCharge({ ...cardInput, paymentMethodId: 'master' });

    expect(calls).toHaveLength(2);
    const firstBody = JSON.parse(calls[0]!.body!);
    expect(firstBody.transactions.payments[0].payment_method).toMatchObject({ id: 'master', type: 'credit_card' });
    const retryBody = JSON.parse(calls[1]!.body!);
    expect(retryBody.transactions.payments[0].payment_method).toMatchObject({ id: 'debmaster', type: 'debit_card' });
    expect(calls[1]!.headers['X-Idempotency-Key']).not.toBe(calls[0]!.headers['X-Idempotency-Key']);
    expect(result.gatewayChargeId).toBe('ord_mp_retry');
  });

  it('does not retry a payment_method.id rejection it cannot resolve, and surfaces the original error', async () => {
    const rejection = {
      status: 400,
      body: {
        errors: [{ code: 'property_value', message: 'Invalid value for property', details: ['some other unrelated field'] }],
      },
    };
    const { impl, calls } = fakeFetch([rejection]);
    await expect(gateway(impl).createCharge({ ...cardInput, paymentMethodId: 'master' })).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toHaveLength(1);
  });

  it('refuses a card charge with no token, before calling Mercado Pago', async () => {
    const { impl, calls } = fakeFetch([]);
    const { cardToken: _t, ...noToken } = cardInput;
    await expect(gateway(impl).createCharge(noToken)).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toHaveLength(0);
  });

  it('reports a declined card as a resolved, failed result if it ever arrives on a 2xx — not a thrown error', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'ord_mp_2',
          status: 'processed',
          external_reference: 'LU-260924-AB12',
          total_amount: '18.00',
          transactions: { payments: [{ id: 'txn_2', status: 'rejected', status_detail: 'cc_rejected_insufficient_amount' }] },
        },
      },
    ]);
    const created = await gateway(impl).createCharge(cardInput);
    expect(created.instructions).toEqual({ kind: 'resolved', state: 'failed', reference: 'txn_2', challengeUrl: null });
  });

  it('reports a declined card as resolved/failed on the real 402 shape — order nested under `data`, not thrown', async () => {
    // Confirmed against Mercado Pago's real sandbox (2026-11-22, OTHE test
    // card): a declined card comes back as HTTP 402 with the order under
    // `data`, not the 2xx-with-rejected-status shape the test above assumes
    // and not a request-level error either — the order was genuinely
    // created, the transaction was just declined.
    const { impl } = fakeFetch([
      {
        status: 402,
        body: {
          errors: [{ code: 'failed', message: 'The following transactions failed', details: ['PAY1: rejected_by_issuer'] }],
          data: {
            id: 'ord_mp_3',
            status: 'failed',
            status_detail: 'failed',
            external_reference: 'LU-260924-AB12',
            total_amount: '18.00',
            transactions: { payments: [{ id: 'txn_3', status: 'failed', status_detail: 'rejected_by_issuer' }] },
          },
        },
      },
    ]);
    const created = await gateway(impl).createCharge(cardInput);
    expect(created.instructions).toEqual({ kind: 'resolved', state: 'failed', reference: 'txn_3', challengeUrl: null });
    expect(created.gatewayChargeId).toBe('ord_mp_3');
  });

  it('keys the idempotency on the order plus card token — a literal duplicate submission coalesces', async () => {
    const ok = {
      status: 200,
      body: { id: 'ord_mp_1', status: 'processing', external_reference: 'LU-1', transactions: { payments: [{ status: 'processing' }] } },
    };
    const { impl, calls } = fakeFetch([ok, ok]);
    const gw = gateway(impl);

    await gw.createCharge(cardInput);
    await gw.createCharge(cardInput);

    expect(calls[0]?.headers['X-Idempotency-Key']).toBe(calls[1]?.headers['X-Idempotency-Key']);
  });

  it('gives a real retry (a new card token) a different idempotency key', async () => {
    // Confirmed in production 2026-11-24: keying purely on the order id (the
    // original design) broke every single retry — a customer resuming a
    // pending order after a decline, or switching payment method, always
    // gets a fresh card token, so Mercado Pago rejected every retry with a
    // 409 idempotency_key_already_used. This is the regression test for that.
    const ok = {
      status: 200,
      body: { id: 'ord_mp_1', status: 'processing', external_reference: 'LU-1', transactions: { payments: [{ status: 'processing' }] } },
    };
    const { impl, calls } = fakeFetch([ok, ok]);
    const gw = gateway(impl);

    await gw.createCharge(cardInput);
    await gw.createCharge({ ...cardInput, cardToken: 'card_tok_a_different_one' });

    expect(calls[0]?.headers['X-Idempotency-Key']).not.toBe(calls[1]?.headers['X-Idempotency-Key']);
  });

  it('refuses spei when only card is configured', async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(gateway(impl, { methods: ['card'] }).createCharge(speiInput)).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toHaveLength(0);
  });

  it('refuses oxxo outright — that family stays on Checkout Pro', async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(gateway(impl).createCharge({ ...cardInput, method: 'oxxo' })).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toHaveLength(0);
  });

  it('marks outages retryable and bad requests not', async () => {
    const { impl } = fakeFetch([
      { status: 503, body: { message: 'down' } },
      { status: 400, body: { message: 'bad param' } },
    ]);
    const gw = gateway(impl);
    await expect(gw.createCharge(cardInput)).rejects.toMatchObject({ retryable: true });
    await expect(gw.createCharge(cardInput)).rejects.toMatchObject({ retryable: false });
  });
});

describe('createCharge — spei', () => {
  it('creates an order with a bank_transfer transaction and returns the CLABE inline, not a redirect', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'ord_mp_3',
          status: 'action_required',
          external_reference: 'LU-260924-CD34',
          transactions: {
            payments: [
              {
                id: 'txn_3',
                status: 'pending',
                payment_method: { id: 'clabe', type: 'bank_transfer', reference: '012180001234567895', ticket_url: 'https://mp.test/ticket' },
              },
            ],
          },
        },
      },
    ]);

    const created = await gateway(impl, { methods: ['spei'] }).createCharge(speiInput);

    expect(created.instructions).toEqual({
      kind: 'spei',
      clabe: '012180001234567895',
      bank: '',
      reference: '012180001234567895',
    });

    const body = JSON.parse(calls[0]!.body!);
    expect(body.transactions.payments[0].payment_method).toEqual({ id: 'clabe', type: 'bank_transfer' });
  });

  it('gives each SPEI attempt on the same order its own idempotency key', async () => {
    // SPEI's payment body is static (no card token to vary it between
    // attempts), so a retry on the same resumed order needs a fresh random
    // nonce instead — the same production bug the card regression test
    // above covers, confirmed for SPEI too on 2026-11-24.
    const ok = {
      status: 200,
      body: { id: 'ord_mp_3', status: 'processing', external_reference: 'LU-1', transactions: { payments: [{ status: 'pending' }] } },
    };
    const { impl, calls } = fakeFetch([ok, ok]);
    const gw = gateway(impl, { methods: ['spei'] });

    await gw.createCharge(speiInput);
    await gw.createCharge(speiInput);

    expect(calls[0]?.headers['X-Idempotency-Key']).not.toBe(calls[1]?.headers['X-Idempotency-Key']);
  });
});

describe('orderState', () => {
  it('prefers the transaction status over the wrapper order status', () => {
    expect(
      orderState({ id: '1', status: 'processed', transactions: { payments: [{ status: 'rejected' }] } }),
    ).toBe('failed');
  });

  it('treats accredited/processed as paid', () => {
    expect(orderState({ id: '1', transactions: { payments: [{ status: 'accredited' }] } })).toBe('paid');
  });

  it('treats refunded and charged_back as refunded', () => {
    for (const status of ['refunded', 'charged_back'] as const) {
      expect(orderState({ id: '1', transactions: { payments: [{ status }] } })).toBe('refunded');
    }
  });

  it('treats rejected and cancelled as failed', () => {
    for (const status of ['rejected', 'cancelled'] as const) {
      expect(orderState({ id: '1', transactions: { payments: [{ status }] } })).toBe('failed');
    }
  });

  it('treats everything else as pending, never settled by default', () => {
    for (const status of ['pending', 'processing', 'action_required'] as const) {
      expect(orderState({ id: '1', transactions: { payments: [{ status }] } })).toBe('pending');
    }
  });
});

// ── webhooks ──────────────────────────────────────────────────────────────────

function signMp(orderId: string, requestId: string, ts: number, secret = SECRET): string {
  const manifest = `id:${orderId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac('sha256', secret).update(manifest, 'utf8').digest('hex');
  return `ts=${ts},v1=${v1}`;
}

function webhookBody(orderId: string, action = 'order.processed', notificationId: number | string | null = 9001) {
  return JSON.stringify({ ...(notificationId != null ? { id: notificationId } : {}), type: 'order', action, data: { id: orderId } });
}

describe('verifyWebhook', () => {
  it('reads a processed/accredited order as paid, with the amount and order id', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'ord_mp_1',
          status: 'processed',
          total_amount: '18.00',
          external_reference: 'LU-260924-AB12',
          transactions: { payments: [{ id: 'txn_1', status: 'accredited' }] },
        },
      },
    ]);
    const result = await gateway(impl).verifyWebhook(webhookBody('ord_mp_1'), {
      'x-signature': signMp('ord_mp_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toMatchObject({
      ok: true,
      event: { gatewayChargeId: 'ord_mp_1', state: 'paid', amountReceivedCents: 1_800, reference: 'txn_1' },
    });
  });

  it('carries the order\'s own external_reference, so a caller can recover it when the local link is missing', async () => {
    // What apps/web's gateway-report.ts self-heals with when
    // `attachGatewayCharge`'s own write failed or got overwritten — see its
    // own doc comment, confirmed in production 2026-11-26.
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'ord_mp_1',
          status: 'processed',
          total_amount: '50.00',
          external_reference: 'LU-261125-WJ47',
          transactions: { payments: [{ id: 'txn_1', status: 'accredited' }] },
        },
      },
    ]);
    const result = await gateway(impl).verifyWebhook(webhookBody('ord_mp_1'), {
      'x-signature': signMp('ord_mp_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toMatchObject({ ok: true, event: { orderNumber: 'LU-261125-WJ47' } });
  });

  it('reads a pending SPEI reference as pending, not money yet', async () => {
    const { impl } = fakeFetch([
      { status: 200, body: { id: 'ord_mp_3', status: 'action_required', transactions: { payments: [{ status: 'pending' }] } } },
    ]);
    const result = await gateway(impl).verifyWebhook(webhookBody('ord_mp_3'), {
      'x-signature': signMp('ord_mp_3', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toMatchObject({ ok: true, event: { state: 'pending', amountReceivedCents: null } });
  });

  it('rejects a forged signature before ever calling Mercado Pago', async () => {
    const { impl, calls } = fakeFetch([]);
    const result = await gateway(impl).verifyWebhook(webhookBody('ord_mp_1'), {
      'x-signature': signMp('ord_mp_1', 'req_1', 1000, 'wrong-secret'),
      'x-request-id': 'req_1',
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a delivery with no signature header', async () => {
    const { impl } = fakeFetch([]);
    expect(await gateway(impl).verifyWebhook(webhookBody('ord_mp_1'), {})).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('acknowledges an authentic non-order event as unsupported, without fetching anything', async () => {
    const { impl, calls } = fakeFetch([]);
    const body = JSON.stringify({ id: 1, type: 'payment', data: { id: 'pay_1' } });
    const result = await gateway(impl).verifyWebhook(body, {
      'x-signature': signMp('pay_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toEqual({ ok: false, reason: 'unsupported_event' });
    expect(calls).toHaveLength(0);
  });

  it('ignores a merchant_order-topic notification as unsupported, even though its data has no id at all', async () => {
    // Real capture, production 2026-11-24: this account also delivers other
    // topics to this same URL, and this one's `data` never had an order id
    // to begin with. The type must be checked before the id is ever looked
    // for, or this is misreported as a corrupt payload — exactly what
    // happened 15 times in one 6h window before this was fixed.
    const body = JSON.stringify({
      action: 'update',
      application_id: '',
      data: { currency_id: '', marketplace: 'NONE', status: 'closed' },
      date_created: '2026-11-18T01:15:11.637-04:00',
      id: '46240606338',
      live_mode: true,
      status: 'closed',
      type: 'topic_merchant_order_wh',
      user_id: 3715714054,
      version: 2,
    });
    const { impl, calls } = fakeFetch([]);
    const result = await gateway(impl).verifyWebhook(body, {
      'x-signature': 'ts=1000,v1=irrelevant',
      'x-request-id': 'req_1',
    });
    expect(result).toEqual({ ok: false, reason: 'unsupported_event' });
    expect(calls).toHaveLength(0);
  });

  it('falls back to a synthetic event id when the notification carries none, so a repeated identical ping still dedupes', async () => {
    const response = {
      status: 200,
      body: { id: 'ord_mp_1', status: 'processed', total_amount: '18.00', transactions: { payments: [{ status: 'accredited' }] } },
    };
    const { impl: impl1 } = fakeFetch([response]);
    const first = await gateway(impl1).verifyWebhook(webhookBody('ord_mp_1', 'order.processed', null), {
      'x-signature': signMp('ord_mp_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    const { impl: impl2 } = fakeFetch([response]);
    const second = await gateway(impl2).verifyWebhook(webhookBody('ord_mp_1', 'order.processed', null), {
      'x-signature': signMp('ord_mp_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(first).toMatchObject({ ok: true, event: { eventId: expect.any(String) } });
    expect((first as { event: { eventId: string } }).event.eventId).toBe(
      (second as { event: { eventId: string } }).event.eventId,
    );
  });

  it('treats an order Mercado Pago no longer has as a malformed payload, not a crash', async () => {
    const { impl } = fakeFetch([{ status: 404, body: { message: 'not found' } }]);
    const result = await gateway(impl).verifyWebhook(webhookBody('ord_gone'), {
      'x-signature': signMp('ord_gone', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_payload' });
  });
});

describe('getCharge', () => {
  it('fetches the order directly by its own id — no Preference indirection, unlike Checkout Pro', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'ord_mp_1',
          status: 'processed',
          total_amount: '18.00',
          transactions: { payments: [{ id: 'txn_1', status: 'accredited' }] },
        },
      },
    ]);
    const snapshot = await gateway(impl).getCharge('ord_mp_1');
    expect(snapshot).toMatchObject({ state: 'paid', amountReceivedCents: 1_800, reference: 'txn_1' });
    expect(calls[0]?.url).toBe('https://api.mercadopago.com/v1/orders/ord_mp_1');
  });

  it('returns null for an order id Mercado Pago has never heard of', async () => {
    const { impl } = fakeFetch([{ status: 404, body: { message: 'not found' } }]);
    expect(await gateway(impl).getCharge('nope')).toBeNull();
  });

  it('also carries the order\'s own external_reference', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: {
          id: 'ord_mp_1',
          status: 'processed',
          total_amount: '18.00',
          external_reference: 'LU-260924-AB12',
          transactions: { payments: [{ id: 'txn_1', status: 'accredited' }] },
        },
      },
    ]);
    const snapshot = await gateway(impl).getCharge('ord_mp_1');
    expect(snapshot).toMatchObject({ orderNumber: 'LU-260924-AB12' });
  });
});

describe('construction', () => {
  it('refuses to exist without a webhook secret', () => {
    expect(() => new MercadoPagoEmbeddedGateway({ accessToken: 'x', webhookSecret: '' })).toThrow(/webhook/);
  });

  it('refuses to exist without an access token', () => {
    expect(() => new MercadoPagoEmbeddedGateway({ accessToken: '', webhookSecret: SECRET })).toThrow(/access token/);
  });
});

describe('idempotent request body stability', () => {
  it('sends a byte-identical request body across two calls for the same order, unlike Stripe\'s checkout-session bug', async () => {
    const ok = {
      status: 200,
      body: { id: 'ord_mp_1', status: 'processing', transactions: { payments: [{ status: 'processing' }] } },
    };
    const { impl, calls } = fakeFetch([ok, ok]);
    const gw = gateway(impl);
    await gw.createCharge(cardInput);
    await gw.createCharge(cardInput);
    expect(calls[0]?.body).toBe(calls[1]?.body);
  });
});
