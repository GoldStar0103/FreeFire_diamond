/**
 * `CentralOneProvider` — every response shape here is taken verbatim from
 * live calls against Central One's real API (2026-11-03/04), not guessed.
 * See this module's own doc comment for the full provenance.
 */

import { describe, expect, it } from 'vitest';
import { CentralOneProtocolError, CentralOneProvider } from './central-one.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>, calls: Call[] = []) {
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    const next = responses.shift() ?? {
      status: 500,
      body: { error: { code: 'internal_error', message: 'no script', request_id: 'x' } },
    };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return impl;
}

function provider(fetchImpl: typeof fetch) {
  return new CentralOneProvider({ apiKey: 'co_test', fetchImpl });
}

const REQUEST = {
  endpointKind: 'games' as const,
  providerProductId: 'e7d8be5d-de17-4731-a3a0-9c6554c5ca78',
  playerId: '465890109',
  clientReference: 'LU-260911-AB12-0',
};

describe('listFreeFireCatalog', () => {
  it('keeps only active LATAM Free Fire products validated by a single player_id field', async () => {
    const items = [
      {
        product_id: '1',
        sku: 'FF-110-DIAMONDS',
        name: 'Free Fire 110 Diamantes (100 + 10% de bono)',
        region: 'LATAM',
        product_family_id: 'free-fire',
        status: 'active',
        reseller_price: '0.6550',
        target_fields: ['player_id'],
      },
      // Wrong region — the exact mistake Jose asked us to guard against.
      {
        product_id: '2',
        sku: 'TOPUP-FREEFIRE-BR-110',
        name: 'Free Fire (BR) · 110 Diamantes',
        region: 'BR',
        product_family_id: 'free-fire',
        status: 'active',
        reseller_price: '0.8423',
        target_fields: ['game_user_id'],
      },
      // Right region, wrong family.
      {
        product_id: '3',
        sku: 'ZEPETO-110',
        name: 'Zepeto · 110 Coins',
        region: 'LATAM',
        product_family_id: 'zepeto',
        status: 'active',
        reseller_price: '1.0000',
        target_fields: ['player_id'],
      },
      // Right region and family, inactive.
      {
        product_id: '4',
        sku: 'FF-OLD',
        name: 'Free Fire 999 Diamantes',
        region: 'LATAM',
        product_family_id: 'free-fire',
        status: 'inactive',
        reseller_price: '5.0000',
        target_fields: ['player_id'],
      },
    ];
    const p = provider(fakeFetch([{ status: 200, body: { items } }]));

    const result = await p.listFreeFireCatalog();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      providerProductId: '1',
      endpointKind: 'games',
      diamondsBase: 100,
      canValidate: true,
      requiresServerId: false,
    });
    expect(result[0]?.costUsd).toBe(6550);
  });

  it('throws a protocol error on a non-2xx response', async () => {
    const p = provider(
      fakeFetch([
        { status: 500, body: { error: { code: 'internal_error', message: 'boom', request_id: 'x' } } },
      ]),
    );
    await expect(p.listFreeFireCatalog()).rejects.toThrow(CentralOneProtocolError);
  });
});

describe('getBalance', () => {
  it('parses available_balance', async () => {
    const p = provider(
      fakeFetch([
        {
          status: 200,
          body: { currency: 'USD', available_balance: '9.3450', held_balance: '0.0000', total_balance: '9.3450' },
        },
      ]),
    );
    expect(await p.getBalance()).toBe(93450);
  });
});

describe('validatePlayer', () => {
  it('reports a valid player with their nickname', async () => {
    const p = provider(
      fakeFetch([
        { status: 200, body: { success: true, status: 'valid', product_id: 'x', player: { name: 'ʜᴋᴇᴢᴇᴋɪᴇʟ' } } },
      ]),
    );
    expect(await p.validatePlayer('x', '465890109')).toEqual({ found: true, nickname: 'ʜᴋᴇᴢᴇᴋɪᴇʟ' });
  });

  it('reports an invalid player as not found, with no player object at all', async () => {
    const p = provider(fakeFetch([{ status: 200, body: { success: true, status: 'invalid', product_id: 'x' } }]));
    expect(await p.validatePlayer('x', '0000000000')).toEqual({ found: false, nickname: null });
  });

  it('sends product_id and a nested target_payload, not a flat player_id', async () => {
    const calls: Call[] = [];
    const p = provider(
      fakeFetch([{ status: 200, body: { success: true, status: 'valid', player: { name: 'X' } } }], calls),
    );
    await p.validatePlayer('prod-1', '465890109');

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({ product_id: 'prod-1', target_payload: { player_id: '465890109' } });
  });
});

describe('purchase', () => {
  it('sends items[] wrapping the product and a per-item Idempotency-Key', async () => {
    const calls: Call[] = [];
    const p = provider(
      fakeFetch(
        [
          {
            status: 200,
            body: {
              order: {
                id: 'order-1',
                reference_code: 'CO-ORD-1',
                status: 'completed',
                total_sale_amount: '0.6550',
                currency: 'USD',
                created_at: '2026-11-04T04:15:17Z',
              },
            },
          },
        ],
        calls,
      ),
    );

    await p.purchase(REQUEST);

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({
      items: [
        { product_id: REQUEST.providerProductId, target_payload: { player_id: REQUEST.playerId }, quantity: 1 },
      ],
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe(REQUEST.clientReference);
  });

  it('treats an order that already reads back completed as succeeded', async () => {
    const p = provider(
      fakeFetch([
        {
          status: 200,
          body: {
            order: {
              id: 'order-1',
              reference_code: 'CO-ORD-1',
              status: 'completed',
              total_sale_amount: '0.6550',
              currency: 'USD',
              created_at: '2026-11-04T04:15:17Z',
            },
          },
        },
      ]),
    );

    const outcome = await p.purchase(REQUEST);

    expect(outcome).toEqual({
      kind: 'succeeded',
      providerTransactionId: 'order-1',
      providerReference: 'order-1',
      amountCharged: 6550,
    });
  });

  it('treats a freshly confirmed (not yet completed) order as pending, for the poller to resolve', async () => {
    const p = provider(
      fakeFetch([
        {
          status: 200,
          body: {
            order: {
              id: 'order-1',
              reference_code: 'CO-ORD-1',
              status: 'confirmed',
              total_sale_amount: '0.6550',
              currency: 'USD',
              created_at: '2026-11-04T04:15:17Z',
            },
          },
        },
      ]),
    );

    const outcome = await p.purchase(REQUEST);

    expect(outcome).toEqual({
      kind: 'pending',
      providerTransactionId: 'order-1',
      providerReference: 'order-1',
      amountCharged: 6550,
    });
  });

  it('maps maintenance_mode to a definitive, retryable failure — it is documented as a guaranteed no-op', async () => {
    const p = provider(
      fakeFetch([
        {
          status: 503,
          body: { error: { code: 'maintenance_mode', message: 'Mantenimiento', request_id: 'x' } },
        },
      ]),
    );

    const outcome = await p.purchase(REQUEST);

    expect(outcome).toEqual({
      kind: 'failed',
      code: 'MAINTENANCE_MODE',
      message: 'Mantenimiento',
      retryable: true,
      httpStatus: 503,
    });
  });

  it('maps a generic 500/503 to ambiguous — no indication whether it was charged', async () => {
    const p = provider(
      fakeFetch([{ status: 500, body: { error: { code: 'internal_error', message: 'boom', request_id: 'x' } } }]),
    );
    const outcome = await p.purchase(REQUEST);
    expect(outcome).toMatchObject({ kind: 'ambiguous', reason: 'provider_error' });
  });

  it('maps idempotency_key_reused to ambiguous/duplicate — proves nothing about the first attempt', async () => {
    const p = provider(
      fakeFetch([
        {
          status: 422,
          body: { error: { code: 'idempotency_key_reused', message: 'reused', request_id: 'x' } },
        },
      ]),
    );
    const outcome = await p.purchase(REQUEST);
    expect(outcome).toMatchObject({ kind: 'ambiguous', reason: 'duplicate' });
  });

  it.each(['insufficient_balance', 'insufficient_stock', 'rate_limited'])(
    'maps %s to a retryable failure',
    async (code) => {
      const p = provider(
        fakeFetch([{ status: 409, body: { error: { code, message: 'x', request_id: 'x' } } }]),
      );
      const outcome = await p.purchase(REQUEST);
      expect(outcome).toMatchObject({ kind: 'failed', code, retryable: true });
    },
  );

  it.each(['invalid_request', 'invalid_api_key', 'insufficient_scope', 'not_found'])(
    'maps %s to a permanent, non-retryable failure',
    async (code) => {
      const p = provider(
        fakeFetch([{ status: 400, body: { error: { code, message: 'x', request_id: 'x' } } }]),
      );
      const outcome = await p.purchase(REQUEST);
      expect(outcome).toMatchObject({ kind: 'failed', code, retryable: false });
    },
  );

  it('maps a network/transport failure to ambiguous', async () => {
    const throwing = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const p = provider(throwing);
    const outcome = await p.purchase(REQUEST);
    expect(outcome).toMatchObject({ kind: 'ambiguous', reason: 'network' });
  });
});

describe('getOrderStatus', () => {
  it('reports a completed order, with its product name and no pins', async () => {
    const p = provider(
      fakeFetch([
        {
          status: 200,
          body: {
            order: {
              id: 'order-1',
              reference_code: 'CO-ORD-1',
              status: 'completed',
              total_sale_amount: '0.6550',
              currency: 'USD',
              items: [{ id: 'item-1', product_sku: 'FF-110-DIAMONDS', product_name: 'Free Fire 110 Diamantes', status: 'completed', failure: null }],
              failure: null,
            },
          },
        },
      ]),
    );

    expect(await p.getOrderStatus('order-1')).toEqual({
      reference: 'order-1',
      status: 'COMPLETED',
      pins: [],
      product: 'Free Fire 110 Diamantes',
    });
  });

  it('reports anything short of completed as PENDING', async () => {
    const p = provider(
      fakeFetch([
        {
          status: 200,
          body: {
            order: {
              id: 'order-1',
              reference_code: 'CO-ORD-1',
              status: 'confirmed',
              total_sale_amount: '0.6550',
              currency: 'USD',
              items: [],
            },
          },
        },
      ]),
    );

    expect((await p.getOrderStatus('order-1'))?.status).toBe('PENDING');
  });

  it('returns null for a 404 — the provider no longer recognises the reference', async () => {
    const p = provider(
      fakeFetch([{ status: 404, body: { error: { code: 'not_found', message: 'gone', request_id: 'x' } } }]),
    );
    expect(await p.getOrderStatus('missing')).toBeNull();
  });

  it('throws a protocol error for anything else', async () => {
    const p = provider(
      fakeFetch([{ status: 500, body: { error: { code: 'internal_error', message: 'boom', request_id: 'x' } } }]),
    );
    await expect(p.getOrderStatus('order-1')).rejects.toThrow(CentralOneProtocolError);
  });
});
