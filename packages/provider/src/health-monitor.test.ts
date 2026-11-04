import { describe, expect, it, vi } from 'vitest';
import { wrapWithHealthMonitor } from './health-monitor.js';
import type { PurchaseOutcome, PurchaseRequest, TopupProvider, UsdTenK } from './types.js';

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

const REQUEST: PurchaseRequest = {
  endpointKind: 'pins_recharge',
  providerProductId: '351',
  playerId: '182938102',
  clientReference: 'LU-260911-AB12-0',
};

const ambiguous = (message: string): PurchaseOutcome => ({
  kind: 'ambiguous',
  reason: 'provider_error',
  message,
  httpStatus: 502,
});

const succeeded: PurchaseOutcome = {
  kind: 'succeeded',
  providerTransactionId: 'tx-1',
  providerReference: null,
  amountCharged: usd(1),
};

/** A stub provider whose purchase/getBalance behaviour is scripted per test. */
function stubProvider(overrides: Partial<TopupProvider> = {}): TopupProvider {
  return {
    listFreeFireCatalog: async () => [],
    getBalance: async () => usd(500),
    validatePlayer: async () => ({ found: false, nickname: null }),
    purchase: async () => succeeded,
    getOrderStatus: async () => null,
    ...overrides,
  };
}

describe('wrapWithHealthMonitor', () => {
  it('passes through a clean purchase without ever firing', async () => {
    const onTrigger = vi.fn();
    const provider = wrapWithHealthMonitor(stubProvider(), onTrigger);

    const outcome = await provider.purchase(REQUEST);

    expect(outcome).toEqual(succeeded);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('fires wallet_unreadable the first time getBalance throws, and still throws', async () => {
    const onTrigger = vi.fn();
    const inner = stubProvider({
      getBalance: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const provider = wrapWithHealthMonitor(inner, onTrigger);

    await expect(provider.getBalance()).rejects.toThrow('ECONNRESET');
    expect(onTrigger).toHaveBeenCalledWith({ reason: 'wallet_unreadable', message: 'ECONNRESET' });
  });

  it('fires maintenance_detected immediately on a maintenance-worded error, without waiting for a streak', async () => {
    const onTrigger = vi.fn();
    const inner = stubProvider({
      purchase: async () => ambiguous('RA está en mantenimiento, intenta más tarde'),
    });
    const provider = wrapWithHealthMonitor(inner, onTrigger);

    await provider.purchase(REQUEST);

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'maintenance_detected' }),
    );
  });

  it('does not fire on the first two ambiguous outcomes, only the third in a row', async () => {
    const onTrigger = vi.fn();
    let call = 0;
    const inner = stubProvider({
      purchase: async () => ambiguous(`timeout #${++call}`),
    });
    const provider = wrapWithHealthMonitor(inner, onTrigger);

    await provider.purchase(REQUEST);
    expect(onTrigger).not.toHaveBeenCalled();
    await provider.purchase(REQUEST);
    expect(onTrigger).not.toHaveBeenCalled();
    await provider.purchase(REQUEST);

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'consecutive_api_errors' }),
    );
  });

  it('a clean outcome in between resets the streak', async () => {
    const onTrigger = vi.fn();
    const outcomes: PurchaseOutcome[] = [
      ambiguous('timeout 1'),
      ambiguous('timeout 2'),
      succeeded,
      ambiguous('timeout 3'),
      ambiguous('timeout 4'),
    ];
    const inner = stubProvider({ purchase: async () => outcomes.shift()! });
    const provider = wrapWithHealthMonitor(inner, onTrigger);

    for (let i = 0; i < outcomes.length + 5 && outcomes.length > 0; i++) {
      await provider.purchase(REQUEST);
    }

    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('a definitive failed outcome does not count toward the streak', async () => {
    const onTrigger = vi.fn();
    const failed: PurchaseOutcome = {
      kind: 'failed',
      code: 'INSUFFICIENT_BALANCE',
      message: 'no balance',
      retryable: true,
      httpStatus: 422,
    };
    const outcomes: PurchaseOutcome[] = [
      ambiguous('timeout 1'),
      ambiguous('timeout 2'),
      failed,
      ambiguous('timeout 3'),
    ];
    const inner = stubProvider({ purchase: async () => outcomes.shift()! });
    const provider = wrapWithHealthMonitor(inner, onTrigger);

    for (let i = 0; i < 4; i++) await provider.purchase(REQUEST);

    // 2 ambiguous, then a 'failed' (irrelevant to the streak), then a 3rd
    // ambiguous — still only 1 consecutive ambiguous since the reset, so no fire.
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('re-arms after escalating — a second streak of three fires again', async () => {
    const onTrigger = vi.fn();
    let call = 0;
    const inner = stubProvider({ purchase: async () => ambiguous(`timeout #${++call}`) });
    const provider = wrapWithHealthMonitor(inner, onTrigger);

    for (let i = 0; i < 6; i++) await provider.purchase(REQUEST);

    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it('swallows an onTrigger that throws, never surfacing it to the caller', async () => {
    const onTrigger = vi.fn().mockRejectedValue(new Error('db unreachable'));
    const inner = stubProvider({
      getBalance: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const provider = wrapWithHealthMonitor(inner, onTrigger);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(provider.getBalance()).rejects.toThrow('ECONNRESET');
    error.mockRestore();
  });

  it('leaves every other method untouched', async () => {
    const catalog = [{ providerProductId: '1' }] as unknown as Awaited<
      ReturnType<TopupProvider['listFreeFireCatalog']>
    >;
    const inner = stubProvider({
      listFreeFireCatalog: async () => catalog,
      validatePlayer: async () => ({ found: true, nickname: 'Test' }),
      getOrderStatus: async () => ({ reference: 'R1', status: 'COMPLETED', pins: [], product: 'x' }),
    });
    const provider = wrapWithHealthMonitor(inner, vi.fn());

    expect(await provider.listFreeFireCatalog()).toBe(catalog);
    expect(await provider.validatePlayer('1', '2')).toEqual({ found: true, nickname: 'Test' });
    expect(await provider.getOrderStatus('R1')).toEqual({
      reference: 'R1',
      status: 'COMPLETED',
      pins: [],
      product: 'x',
    });
  });
});
