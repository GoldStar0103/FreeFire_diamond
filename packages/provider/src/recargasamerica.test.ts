/**
 * `RecargasAmericaProvider.purchase`'s failure mapping — the part that decides
 * whether a call gets retried, escalated, or reconciled against the wallet.
 * Getting this wrong in either direction is expensive: see the doc comment on
 * `PurchaseOutcome` in types.ts.
 */

import { describe, expect, it } from 'vitest';
import { RecargasAmericaProvider } from './recargasamerica.js';

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
