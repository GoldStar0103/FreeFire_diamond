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
      instructions: { kind: 'resolved', state: 'paid', reference: 'txn_1' },
      expiresAt: null,
    });

    const [call] = calls;
    expect(call?.url).toBe('https://api.mercadopago.com/v1/orders');
    expect(call?.headers.Authorization).toBe('Bearer APP_USR-test-token');
    expect(call?.headers['X-Idempotency-Key']).toBe('levelup-mp-ord-uuid-1');
    expect(call?.headers['X-meli-session-id']).toBe('device-session-xyz');

    const body = JSON.parse(call!.body!);
    expect(body.external_reference).toBe('LU-260924-AB12');
    expect(body.total_amount).toBe('18.00');
    expect(body.transactions.payments[0]).toMatchObject({
      payment_method: { id: 'visa', type: 'credit_card', token: 'card_tok_abc123', installments: 1 },
    });
  });

  it('refuses a card charge with no token, before calling Mercado Pago', async () => {
    const { impl, calls } = fakeFetch([]);
    const { cardToken: _t, ...noToken } = cardInput;
    await expect(gateway(impl).createCharge(noToken)).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toHaveLength(0);
  });

  it('reports a declined card as a resolved, failed result — not a thrown error', async () => {
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
    expect(created.instructions).toEqual({ kind: 'resolved', state: 'failed', reference: 'txn_2' });
  });

  it('keys the idempotency on the order, not the card token or amount', async () => {
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
