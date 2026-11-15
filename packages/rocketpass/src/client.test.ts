import { describe, expect, it } from 'vitest';
import { RocketPassClient } from './client.js';
import { RocketPassError, RocketPassUnreachableError } from './types.js';

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
    const next = responses.shift() ?? { status: 500, body: { success: false, error: { message: 'no script' } } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const client = (fetchImpl: typeof fetch, apiKey = 'rpk_test_abc123') =>
  new RocketPassClient({ apiKey, fetch: fetchImpl });

describe('listCatalog', () => {
  it('maps the snake_case envelope into camelCase', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          success: true,
          data: {
            items: [
              {
                item: 'crate',
                name: 'Universal Evo Token Crate',
                kind: 'gift',
                price_ars: 400,
                max_quantity: 500,
                available: true,
                stock_by_region: { SAC: 312, US: 87 },
                affordable_units: 210,
              },
            ],
            regions: [{ code: 'SAC', name: 'Sudamérica (SUR / SAC)' }],
            balance_ars: 84_200.5,
            currency: 'ARS',
          },
        },
      },
    ]);

    const catalog = await client(impl).listCatalog();

    expect(calls[0]).toMatchObject({ method: 'GET', url: 'https://rocketpass.store/api/v1/catalog' });
    expect(calls[0]?.headers['X-API-Key']).toBe('rpk_test_abc123');
    expect(catalog).toEqual({
      items: [
        {
          item: 'crate',
          name: 'Universal Evo Token Crate',
          kind: 'gift',
          priceArs: 400,
          maxQuantity: 500,
          available: true,
          stockByRegion: { SAC: 312, US: 87 },
          affordableUnits: 210,
        },
      ],
      regions: [{ code: 'SAC', name: 'Sudamérica (SUR / SAC)' }],
      balanceArs: 84_200.5,
      currency: 'ARS',
    });
  });

  it('throws RocketPassError with the error code and a non-retryable flag for a 4xx', async () => {
    const { impl } = fakeFetch([
      { status: 403, body: { success: false, error: { code: 'ITEM_NOT_ALLOWED', message: 'blocked' } } },
    ]);

    const err = await client(impl)
      .listCatalog()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RocketPassError);
    expect(err).toMatchObject({ code: 'ITEM_NOT_ALLOWED', httpStatus: 403, retryable: false });
  });

  it('marks 429/500/503 as retryable', async () => {
    const { impl } = fakeFetch([{ status: 429, body: { success: false, error: { code: 'RATE_LIMIT' } } }]);
    const err = (await client(impl)
      .listCatalog()
      .catch((e: unknown) => e)) as RocketPassError;
    expect(err.retryable).toBe(true);
  });

  it('throws RocketPassUnreachableError when the network call itself fails', async () => {
    const impl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(client(impl).listCatalog()).rejects.toBeInstanceOf(RocketPassUnreachableError);
  });
});

describe('createOrder', () => {
  it('sends the Idempotency-Key header and the mapped body, and parses the order back', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 201,
        body: {
          success: true,
          data: {
            order: {
              order_id: 'ORD-7K2M9XQ4P1',
              status: 'DELIVERED',
              item: 'crate',
              item_name: 'Universal Evo Token Crate',
              quantity: 1,
              delivered: 1,
              target_uid: '7288567050',
              target_nickname: null,
              region: 'SAC',
              unit_price_ars: 400,
              total_ars: 400,
              refunded_ars: 0,
              charged_ars: 400,
              reference: 'LU-260101-AAAA',
              test: true,
              created_at: '2026-09-23T14:05:19',
              completed_at: '2026-09-23T14:05:20',
            },
            queued: false,
            queue_code: null,
            retry_after_seconds: null,
            balance_ars: 83_800.5,
          },
        },
      },
    ]);

    const result = await client(impl).createOrder({
      item: 'crate',
      targetUid: '7288567050',
      reference: 'LU-260101-AAAA',
      idempotencyKey: 'ord-uuid-1',
    });

    expect(calls[0]?.headers['Idempotency-Key']).toBe('ord-uuid-1');
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toMatchObject({
      item: 'crate',
      target_uid: '7288567050',
      quantity: 1,
      region: 'SAC',
      reference: 'LU-260101-AAAA',
    });

    expect(result.order).toMatchObject({ orderId: 'ORD-7K2M9XQ4P1', status: 'DELIVERED', test: true });
    expect(result.queued).toBe(false);
  });

  it('surfaces OUT_OF_STOCK as a non-retryable error', async () => {
    const { impl } = fakeFetch([
      { status: 409, body: { success: false, error: { code: 'OUT_OF_STOCK', message: 'sin stock' } } },
    ]);

    const err = (await client(impl)
      .createOrder({ item: 'crate', targetUid: '7288567050', reference: 'LU-1', idempotencyKey: 'k' })
      .catch((e: unknown) => e)) as RocketPassError;
    expect(err).toBeInstanceOf(RocketPassError);
    expect(err.code).toBe('OUT_OF_STOCK');
    expect(err.retryable).toBe(false);
  });
});

describe('getOrder', () => {
  it('requests the right path and parses the order', async () => {
    const { impl, calls } = fakeFetch([
      {
        status: 200,
        body: {
          success: true,
          data: {
            order: {
              order_id: 'ORD-7K2M9XQ4P1',
              status: 'PENDING',
              item: 'token',
              item_name: 'Evo Shard',
              quantity: 5,
              delivered: 0,
              target_uid: '7288567050',
              target_nickname: null,
              region: 'SAC',
              unit_price_ars: 50,
              total_ars: 250,
              refunded_ars: 0,
              charged_ars: 0,
              reference: 'LU-1',
              test: true,
              created_at: '2026-09-23T14:05:19',
              completed_at: null,
            },
          },
        },
      },
    ]);

    const order = await client(impl).getOrder('ORD-7K2M9XQ4P1');
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://rocketpass.store/api/v1/orders/ORD-7K2M9XQ4P1',
    });
    expect(order).toMatchObject({ orderId: 'ORD-7K2M9XQ4P1', status: 'PENDING', quantity: 5 });
  });

  it('surfaces a 404 as ORDER_NOT_FOUND', async () => {
    const { impl } = fakeFetch([
      { status: 404, body: { success: false, error: { code: 'ORDER_NOT_FOUND', message: 'no existe' } } },
    ]);
    const err = (await client(impl)
      .getOrder('nope')
      .catch((e: unknown) => e)) as RocketPassError;
    expect(err.code).toBe('ORDER_NOT_FOUND');
  });
});

describe('isSandbox', () => {
  it('is true for a test key and false for a live one', () => {
    expect(client(async () => new Response(), 'rpk_test_abc').isSandbox).toBe(true);
    expect(client(async () => new Response(), 'rpk_live_abc').isSandbox).toBe(false);
  });
});

describe('constructor', () => {
  it('refuses an empty API key', () => {
    expect(() => new RocketPassClient({ apiKey: '' })).toThrow(/API key is required/);
  });
});
