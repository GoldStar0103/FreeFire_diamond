import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MercadoPagoGateway, paymentState } from './mercadopago.js';
import { GatewayError } from './types.js';

const SECRET = 'mp-secret-test';
const NOW_MS = 1_760_000_000_000;

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
    const next = responses.shift() ?? { status: 500, body: { message: 'no script' } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function gateway(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof MercadoPagoGateway>[0]> = {}) {
  return new MercadoPagoGateway({
    accessToken: 'APP_USR-test-token',
    webhookSecret: SECRET,
    fetch: fetchImpl,
    now: () => NOW_MS,
    ...extra,
  });
}

const chargeInput = {
  orderId: 'ord-uuid-1',
  orderNumber: 'LU-260924-AB12',
  amountCents: 1_800,
  method: 'oxxo' as const,
  description: 'Mini Pack — 110 diamantes',
  returnUrl: 'https://levelupstore.mx/pedido/LU-260924-AB12?id=123456789',
  cancelUrl: 'https://levelupstore.mx/comprar/mini_pack?cancelado=LU-260924-AB12&id=123456789',
};

describe('createCharge', () => {
  it('creates a preference restricted to the ticket family, keyed on the order', async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: 'pref_1', init_point: 'https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_1' } },
    ]);

    const created = await gateway(impl).createCharge(chargeInput);

    expect(created).toEqual({
      gateway: 'mercadopago',
      // The order number, not the preference id — see the doc comment on
      // this field in mercadopago.ts for why: it's the only thing Mercado
      // Pago echoes back on the eventual Payment.
      gatewayChargeId: 'LU-260924-AB12',
      amountCents: 1_800,
      instructions: { kind: 'redirect', url: 'https://www.mercadopago.com.mx/checkout/v1/redirect?pref_id=pref_1' },
      expiresAt: null,
    });

    const [call] = calls;
    expect(call?.url).toBe('https://api.mercadopago.com/checkout/preferences');
    expect(call?.headers.Authorization).toBe('Bearer APP_USR-test-token');
    expect(call?.headers['X-Idempotency-Key']).toBe('levelup-mp-ord-uuid-1');

    const body = JSON.parse(call!.body!);
    expect(body.external_reference).toBe('LU-260924-AB12');
    expect(body.items[0]).toMatchObject({ title: 'Mini Pack — 110 diamantes', quantity: 1, currency_id: 'MXN', unit_price: 18 });
    expect(body.back_urls).toEqual({
      success: chargeInput.returnUrl,
      pending: chargeInput.returnUrl,
      failure: chargeInput.cancelUrl,
    });
    // Everything but the ticket family excluded, so OXXO is the only option
    // Checkout Pro's own page can offer — never card, never a bank transfer.
    const excludedIds = body.payment_methods.excluded_payment_types.map((t: { id: string }) => t.id);
    expect(excludedIds).toEqual(
      expect.arrayContaining(['credit_card', 'debit_card', 'bank_transfer', 'account_money']),
    );
    expect(excludedIds).not.toContain('ticket');
  });

  it('keys the idempotency on the order, not the amount or description', async () => {
    const ok = { status: 200, body: { id: 'pref_1', init_point: 'https://x' } };
    const { impl, calls } = fakeFetch([ok, ok]);
    const gw = gateway(impl);

    await gw.createCharge(chargeInput);
    await gw.createCharge(chargeInput);

    expect(calls[0]?.headers['X-Idempotency-Key']).toBe(calls[1]?.headers['X-Idempotency-Key']);
  });

  it('refuses any method other than oxxo — card and SPEI stay on Stripe', async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(gateway(impl).createCharge({ ...chargeInput, method: 'card' })).rejects.toBeInstanceOf(
      GatewayError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses without return URLs, before calling Mercado Pago', async () => {
    const { impl, calls } = fakeFetch([]);
    const { returnUrl: _r, ...noReturn } = chargeInput;
    await expect(gateway(impl).createCharge(noReturn)).rejects.toBeInstanceOf(GatewayError);
    expect(calls).toHaveLength(0);
  });

  it('marks outages retryable and bad requests not', async () => {
    const { impl } = fakeFetch([
      { status: 503, body: { message: 'down' } },
      { status: 400, body: { message: 'bad param' } },
    ]);
    const gw = gateway(impl);

    await expect(gw.createCharge(chargeInput)).rejects.toMatchObject({ retryable: true });
    await expect(gw.createCharge(chargeInput)).rejects.toMatchObject({ retryable: false });
  });
});

// ── webhooks ──────────────────────────────────────────────────────────────────

/** Signs the way Mercado Pago does: a manifest of id/request-id/ts, never the body. */
function signMp(paymentId: string, requestId: string, ts: number, secret = SECRET): string {
  const manifest = `id:${paymentId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = createHmac('sha256', secret).update(manifest, 'utf8').digest('hex');
  return `ts=${ts},v1=${v1}`;
}

function webhookBody(paymentId: string, action = 'payment.updated', notificationId: number | string = 9001) {
  return JSON.stringify({ id: notificationId, type: 'payment', action, data: { id: paymentId } });
}

describe('verifyWebhook', () => {
  it('reads an approved payment as paid, with the amount and order number', async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        body: { id: 'pay_1', status: 'approved', transaction_amount: 18, external_reference: 'LU-260924-AB12' },
      },
    ]);
    const body = webhookBody('pay_1');
    const result = await gateway(impl).verifyWebhook(body, {
      'x-signature': signMp('pay_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });

    expect(result).toMatchObject({
      ok: true,
      event: { gatewayChargeId: 'LU-260924-AB12', state: 'paid', amountReceivedCents: 1_800, reference: 'pay_1' },
    });
  });

  it('reads a pending OXXO ticket as pending — a ticket is not money', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { id: 'pay_1', status: 'pending', external_reference: 'LU-1' } }]);
    const body = webhookBody('pay_1');
    const result = await gateway(impl).verifyWebhook(body, {
      'x-signature': signMp('pay_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toMatchObject({ ok: true, event: { state: 'pending', amountReceivedCents: null } });
  });

  it.each(['rejected', 'cancelled'] as const)('reads a %s payment as failed', async (status) => {
    const { impl } = fakeFetch([{ status: 200, body: { id: 'pay_1', status, external_reference: 'LU-1' } }]);
    const result = await gateway(impl).verifyWebhook(webhookBody('pay_1'), {
      'x-signature': signMp('pay_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toMatchObject({ ok: true, event: { state: 'failed' } });
  });

  it.each(['refunded', 'charged_back'] as const)('reads a %s payment as refunded', async (status) => {
    const { impl } = fakeFetch([{ status: 200, body: { id: 'pay_1', status, external_reference: 'LU-1' } }]);
    const result = await gateway(impl).verifyWebhook(webhookBody('pay_1'), {
      'x-signature': signMp('pay_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toMatchObject({ ok: true, event: { state: 'refunded' } });
  });

  it('rejects a forged signature before ever calling Mercado Pago', async () => {
    const { impl, calls } = fakeFetch([]);
    const result = await gateway(impl).verifyWebhook(webhookBody('pay_1'), {
      'x-signature': signMp('pay_1', 'req_1', 1000, 'wrong-secret'),
      'x-request-id': 'req_1',
    });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    expect(calls).toHaveLength(0);
  });

  it('rejects a delivery with no signature header', async () => {
    const { impl } = fakeFetch([]);
    expect(await gateway(impl).verifyWebhook(webhookBody('pay_1'), {})).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
  });

  it('rejects a signature header missing ts or v1', async () => {
    const { impl } = fakeFetch([]);
    expect(
      await gateway(impl).verifyWebhook(webhookBody('pay_1'), { 'x-signature': 'ts=1000' }),
    ).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('acknowledges an authentic non-payment event as unsupported, without fetching anything', async () => {
    const { impl, calls } = fakeFetch([]);
    const body = JSON.stringify({ id: 1, type: 'merchant_order', data: { id: 'mo_1' } });
    const result = await gateway(impl).verifyWebhook(body, {
      'x-signature': signMp('mo_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toEqual({ ok: false, reason: 'unsupported_event' });
    expect(calls).toHaveLength(0);
  });

  it('uses the notification\'s own id for eventId, not payment+action — a single payment fires "payment.updated" more than once as it moves from pending to approved, and deduping on payment+action would silently drop the real settlement as a duplicate of the earlier pending report', async () => {
    const { impl: impl1 } = fakeFetch([{ status: 200, body: { id: 'pay_1', status: 'pending', external_reference: 'LU-1' } }]);
    const pendingResult = await gateway(impl1).verifyWebhook(webhookBody('pay_1', 'payment.updated', 111), {
      'x-signature': signMp('pay_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });

    const { impl: impl2 } = fakeFetch([{ status: 200, body: { id: 'pay_1', status: 'approved', external_reference: 'LU-1' } }]);
    const approvedResult = await gateway(impl2).verifyWebhook(webhookBody('pay_1', 'payment.updated', 222), {
      'x-signature': signMp('pay_1', 'req_2', 2000),
      'x-request-id': 'req_2',
    });

    expect(pendingResult).toMatchObject({ ok: true, event: { eventId: '111', state: 'pending' } });
    expect(approvedResult).toMatchObject({ ok: true, event: { eventId: '222', state: 'paid' } });
  });

  it('rejects a notification missing its own id', async () => {
    const { impl } = fakeFetch([]);
    const body = JSON.stringify({ type: 'payment', action: 'payment.updated', data: { id: 'pay_1' } });
    const result = await gateway(impl).verifyWebhook(body, {
      'x-signature': signMp('pay_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_payload' });
  });

  it('treats a payment Mercado Pago no longer has as a malformed payload, not a crash', async () => {
    const { impl } = fakeFetch([{ status: 404, body: { message: 'not found' } }]);
    const result = await gateway(impl).verifyWebhook(webhookBody('pay_gone'), {
      'x-signature': signMp('pay_gone', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(result).toEqual({ ok: false, reason: 'malformed_payload' });
  });
});

describe('getCharge', () => {
  it('finds the payment made against an order and reports its voucher', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          results: [
            {
              id: 'pay_1',
              status: 'pending',
              transaction_details: { external_resource_url: 'https://www.mercadopago.com.mx/payments/pay_1/ticket' },
            },
          ],
        },
      },
    ]);

    const snapshot = await gateway(impl).getCharge('LU-260924-AB12');
    expect(snapshot).toMatchObject({
      state: 'pending',
      reference: 'pay_1',
      voucherUrl: 'https://www.mercadopago.com.mx/payments/pay_1/ticket',
    });
    expect(calls[0]?.url).toContain('external_reference=LU-260924-AB12');
  });

  it('returns null when nothing has been paid against this order yet', async () => {
    const { impl } = fakeFetch([{ status: 200, body: { results: [] } }]);
    expect(await gateway(impl).getCharge('LU-nope')).toBeNull();
  });
});

describe('gatewayChargeId round-trip', () => {
  it('is the same value createCharge returns, verifyWebhook reports, and getCharge accepts', async () => {
    // Real bug caught before this ever shipped: createCharge originally
    // returned the Preference id, but a Preference is never mentioned again
    // by anything Mercado Pago sends — verifyWebhook and getCharge both key
    // on the order number instead (all a Payment ever carries back is
    // external_reference). Returning the Preference id would have made
    // attachGatewayCharge store a value nothing downstream could ever find
    // again — every real webhook would have silently failed to match an order.
    const { impl: createImpl } = fakeFetch([
      { status: 200, body: { id: 'pref_1', init_point: 'https://x' } },
    ]);
    const created = await gateway(createImpl).createCharge(chargeInput);

    const { impl: webhookImpl } = fakeFetch([
      { status: 200, body: { id: 'pay_1', status: 'approved', transaction_amount: 18, external_reference: chargeInput.orderNumber } },
    ]);
    const webhookResult = await gateway(webhookImpl).verifyWebhook(webhookBody('pay_1'), {
      'x-signature': signMp('pay_1', 'req_1', 1000),
      'x-request-id': 'req_1',
    });
    expect(webhookResult).toMatchObject({ ok: true, event: { gatewayChargeId: created.gatewayChargeId } });

    const { impl: getImpl } = fakeFetch([{ status: 200, body: { results: [{ id: 'pay_1', status: 'approved' }] } }]);
    expect(await gateway(getImpl).getCharge(created.gatewayChargeId)).not.toBeNull();
  });
});

describe('paymentState', () => {
  it('treats every unrecognised or in-flight status as pending, never as settled', () => {
    for (const status of ['authorized', 'in_process', 'in_mediation'] as const) {
      expect(paymentState({ id: '1', status })).toBe('pending');
    }
  });
});

describe('construction', () => {
  it('refuses to exist without a webhook secret', () => {
    expect(() => new MercadoPagoGateway({ accessToken: 'x', webhookSecret: '' })).toThrow(/webhook/);
  });

  it('refuses to exist without an access token', () => {
    expect(() => new MercadoPagoGateway({ accessToken: '', webhookSecret: SECRET })).toThrow(/access token/);
  });
});
