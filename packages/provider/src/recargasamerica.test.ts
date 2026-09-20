/**
 * `RecargasAmericaProvider.purchase`'s failure mapping — the part that decides
 * whether a call gets retried, escalated, or reconciled against the wallet.
 * Getting this wrong in either direction is expensive: see the doc comment on
 * `PurchaseOutcome` in types.ts.
 */

import { describe, expect, it } from 'vitest';
import { buildPurchaseBody, ProviderProtocolError, RecargasAmericaProvider } from './recargasamerica.js';
import { ValidationUnsupportedError } from './types.js';

/** A fetch that answers from a fixed script, one response per call. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const impl = (async () => {
    const next = responses.shift() ?? { status: 500, body: { success: false, error: 'no script' } };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof fetch;
  return impl;
}

function provider(fetchImpl: typeof fetch) {
  return new RecargasAmericaProvider({ apiKey: 'ra_test', fetchImpl });
}

const REQUEST = {
  endpointKind: 'pins_recharge' as const,
  providerProductId: '351',
  playerId: '182938102',
  clientReference: 'LU-260911-AB12-0',
};

describe('buildPurchaseBody', () => {
  // Locks in the 2026-09-20 migration to /buy/catalog, confirmed against the
  // live API by reading "missing field" errors from incomplete requests —
  // never a request complete enough to actually purchase something. See this
  // module's own doc comment for the exact probe and its response.
  it('targets /buy/catalog with manual_id for a pins_recharge product', () => {
    expect(
      buildPurchaseBody({
        endpointKind: 'pins_recharge',
        providerProductId: '5',
        playerId: '182938102',
        clientReference: 'LU-260920-AB12-0',
      }),
    ).toEqual({
      path: '/buy/catalog',
      body: { product_id: 5, manual_id: '182938102', client_name: 'LU-260920-AB12-0' },
    });
  });

  it('targets /buy/catalog with player_id (and server_id) for a games product', () => {
    expect(
      buildPurchaseBody({
        endpointKind: 'games',
        providerProductId: '1',
        playerId: '182938102',
        serverId: 'na',
        clientReference: 'LU-260920-AB12-0',
      }),
    ).toEqual({
      path: '/buy/catalog',
      body: {
        product_id: 1,
        player_id: '182938102',
        server_id: 'na',
        client_name: 'LU-260920-AB12-0',
      },
    });
  });

  it('refuses to purchase a pins_code product — it delivers a code, not a top-up', () => {
    expect(() =>
      buildPurchaseBody({
        endpointKind: 'pins_code',
        providerProductId: '11',
        playerId: '182938102',
        clientReference: 'LU-260920-AB12-0',
      }),
    ).toThrow(/delivers redeemable codes/);
  });
});

describe('purchase failure mapping', () => {
  it('maps a definitive 422 to a non-retryable-by-default failure', async () => {
    const outcome = await provider(
      fakeFetch([{ status: 422, body: { success: false, error: 'Saldo insuficiente.', code: 'PURCHASE_FAILED' } }]),
    ).purchase(REQUEST);

    expect(outcome).toEqual({
      kind: 'failed',
      code: 'PURCHASE_FAILED',
      message: 'Saldo insuficiente.',
      retryable: true,
      httpStatus: 422,
    });
  });

  it('maps a 502 provider error to ambiguous, never to a definitive failure', async () => {
    const outcome = await provider(
      fakeFetch([{ status: 502, body: { success: false, error: 'El proveedor rechazó la orden.', code: 'PROVIDER_ERROR' } }]),
    ).purchase(REQUEST);

    expect(outcome).toEqual({
      kind: 'ambiguous',
      reason: 'provider_error',
      message: 'El proveedor rechazó la orden.',
      httpStatus: 502,
    });
  });

  it('maps a transport failure (no response at all) to ambiguous', async () => {
    const throwing = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    const outcome = await provider(throwing).purchase(REQUEST);

    expect(outcome).toMatchObject({ kind: 'ambiguous', httpStatus: null });
  });

  it('maps 409 DUPLICATE_REQUEST to ambiguous/duplicate, not a definitive failure', async () => {
    // `buildPurchaseBody` is deterministic per order item, so a same-item
    // retry within the provider's 120s dedup window can genuinely produce
    // this. A 409 proves nothing about whether the FIRST attempt charged us —
    // treating it as a definitive, non-retryable failure would halt the whole
    // order and fire a critical alert over what may just be our own retry.
    const outcome = await provider(
      fakeFetch([
        { status: 409, body: { success: false, error: 'Solicitud duplicada.', code: 'DUPLICATE_REQUEST' } },
      ]),
    ).purchase(REQUEST);

    expect(outcome).toEqual({
      kind: 'ambiguous',
      reason: 'duplicate',
      message: 'Solicitud duplicada.',
      httpStatus: 409,
    });
  });

  it('still maps an unrecognised 4xx to a definitive, non-retryable failure', async () => {
    const outcome = await provider(
      fakeFetch([{ status: 404, body: { success: false, error: 'Producto no encontrado.', code: 'NOT_FOUND' } }]),
    ).purchase(REQUEST);

    expect(outcome).toEqual({
      kind: 'failed',
      code: 'NOT_FOUND',
      message: 'Producto no encontrado.',
      retryable: false,
      httpStatus: 404,
    });
  });
});

describe('validatePlayer', () => {
  // The client reported this exact pattern in production: a brand-new
  // player ID fails validation the first time and then succeeds on an
  // immediate retry with the identical request — the provider's own lookup
  // is flaky on a cold ID, not our request. One silent retry here is what
  // turns that into a single successful search instead of a customer having
  // to click twice (or worse, giving up).
  it('retries once on a failed lookup and returns the result of the second attempt', async () => {
    const result = await provider(
      fakeFetch([
        { status: 502, body: { success: false, error: 'Upstream error' } },
        {
          status: 200,
          body: { success: true, data: { supported: true, status: true, account_name: 'ShadowFF' } },
        },
      ]),
    ).validatePlayer('351', '182938102');

    expect(result).toEqual({ found: true, nickname: 'ShadowFF' });
  });

  it('throws if the retry also fails, without retrying a second time', async () => {
    const calls: Array<{ status: number; body: unknown }> = [
      { status: 502, body: { success: false, error: 'Upstream error' } },
      { status: 502, body: { success: false, error: 'Still down' } },
    ];
    let callCount = 0;
    const countingFetch = (async () => {
      callCount += 1;
      const next = calls.shift();
      return new Response(JSON.stringify(next?.body ?? { success: false }), {
        status: next?.status ?? 500,
      });
    }) as unknown as typeof fetch;

    await expect(provider(countingFetch).validatePlayer('351', '182938102')).rejects.toThrow(
      ProviderProtocolError,
    );
    expect(callCount).toBe(2);
  });

  it('does not retry a capability rejection (supported:false) — it is a 200, not a transport failure', async () => {
    // Unlike the old /pins/validate, an unsupported product is not an HTTP
    // error any more — the request itself succeeds and the capability
    // question is answered in the body, so there is nothing transient here
    // for a retry to fix.
    let callCount = 0;
    const countingFetch = (async () => {
      callCount += 1;
      return new Response(JSON.stringify({ success: true, data: { supported: false } }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    await expect(provider(countingFetch).validatePlayer('351', '182938102')).rejects.toThrow(
      ValidationUnsupportedError,
    );
    expect(callCount).toBe(1);
  });

  it('does not retry a found result — the fast path stays fast', async () => {
    let callCount = 0;
    const countingFetch = (async () => {
      callCount += 1;
      return new Response(
        JSON.stringify({ success: true, data: { supported: true, status: true, account_name: 'ShadowFF' } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await provider(countingFetch).validatePlayer('351', '182938102');
    expect(callCount).toBe(1);
  });
});
