import { describe, expect, it, vi } from 'vitest';
import { ProviderSimulator } from '@levelup/provider';
import { InMemoryLock } from '@levelup/engine';
import { MemoryAlerter, MemoryStore, buildOrder } from '@levelup/engine/testing';
import type { RecoveryStore, StalledItem } from '@levelup/engine';
import { loadConfig } from './config.js';
import { checkWallet, runFulfillmentLoop, ShutdownSignal, type RunnerDeps } from './runner.js';

class QueueStore extends MemoryStore implements RecoveryStore {
  async findPendingProviderItems(): Promise<StalledItem[]> {
    return [];
  }
  async findStalledSendingItems(): Promise<StalledItem[]> {
    return [];
  }
}

/**
 * `finally`, not a trailing restore — a test that expects loadConfig to throw
 * would otherwise leak its override into every test that follows.
 */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, env);
    return fn();
  } finally {
    process.env = previous;
  }
}

function testConfig(overrides: Record<string, string> = {}) {
  return withEnv(
    {
      DATABASE_URL: 'postgres://x@localhost/x',
      WORKER_DRY_RUN: 'true',
      FULFILLMENT_IDLE_POLL_MS: '1',
      ...overrides,
    },
    loadConfig,
  );
}

function harness(claims: Array<{ id: string; orderNumber: string; recovered: boolean } | null>) {
  const store = new QueueStore(
    buildOrder({ orderNumber: 'LU-1', items: [['d100', 100, 0.55]] }),
  );
  const alerter = new MemoryAlerter();
  const provider = new ProviderSimulator({ initialBalanceUsd: 500, prices: { d100: 0.55 } });
  provider.program({ mode: 'succeed' });

  const queue = {
    claimNext: vi.fn(async () => claims.shift() ?? null),
    depth: vi.fn(async () => ({ payment_confirmed: 1 })),
  };

  const deps: RunnerDeps = {
    queue,
    store,
    provider,
    lock: new InMemoryLock(),
    alerter,
    config: testConfig(),
  };
  return { deps, queue, store, alerter, provider };
}

describe('runFulfillmentLoop', () => {
  it('claims and fulfils an available order', async () => {
    const { deps, provider } = harness([{ id: 'order-1', orderNumber: 'LU-1', recovered: false }]);

    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 2 });

    expect(result.processed).toBe(1);
    expect(provider.deliveryCount).toBe(1);
  });

  it('idles without error when the queue is empty', async () => {
    const { deps, queue } = harness([]);

    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 3 });

    expect(result.processed).toBe(0);
    expect(queue.claimNext).toHaveBeenCalledTimes(3);
  });

  it('stops claiming once shutdown is requested', async () => {
    const { deps, queue } = harness([]);
    const signal = new ShutdownSignal();
    signal.stop();

    await runFulfillmentLoop(deps, signal, { maxIterations: 5 });

    expect(queue.claimNext).not.toHaveBeenCalled();
  });

  it('survives a database blip while claiming', async () => {
    const { deps, queue } = harness([]);
    queue.claimNext
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(null);

    // A transient database error must not take the worker down.
    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 2 });

    expect(result.processed).toBe(0);
    expect(queue.claimNext).toHaveBeenCalledTimes(2);
  });

  it('alerts and keeps going when fulfilment throws', async () => {
    const { deps, alerter } = harness([
      { id: 'does-not-exist', orderNumber: 'LU-404', recovered: false },
    ]);

    const result = await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 1 });

    // The order stays `processing`; the staleness window brings it back rather
    // than us guessing what the provider did.
    expect(result.processed).toBe(0);
    expect(alerter.has('critical')).toBe(true);
  });

  it('logs a recovered order distinctly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = harness([{ id: 'order-1', orderNumber: 'LU-1', recovered: true }]);

    await runFulfillmentLoop(deps, new ShutdownSignal(), { maxIterations: 1 });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Recovered abandoned order LU-1'));
    warn.mockRestore();
  });
});

describe('checkWallet', () => {
  it('alerts when the balance drops below the threshold', async () => {
    const { deps, alerter } = harness([]);
    const provider = new ProviderSimulator({ initialBalanceUsd: 10 });

    await checkWallet({ ...deps, provider });

    expect(alerter.has('critical')).toBe(true);
    expect(alerter.sent[0]?.title).toMatch(/wallet is low/i);
  });

  it('stays quiet when the balance is healthy', async () => {
    const { deps, alerter } = harness([]);
    await checkWallet(deps);
    expect(alerter.sent).toHaveLength(0);
  });

  it('does not throw when the wallet cannot be read', async () => {
    const { deps } = harness([]);
    const provider = {
      ...deps.provider,
      getBalance: async () => {
        throw new Error('provider down');
      },
    } as typeof deps.provider;

    await expect(checkWallet({ ...deps, provider })).resolves.toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('refuses to start without alerting configured', () => {
    // Silent failures defeat the entire needs_review design.
    expect(() =>
      withEnv({ DATABASE_URL: 'postgres://x@localhost/x', RA_API_KEY: 'k' }, loadConfig),
    ).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('requires a provider key outside dry run', () => {
    expect(() =>
      withEnv(
        {
          DATABASE_URL: 'postgres://x@localhost/x',
          TELEGRAM_BOT_TOKEN: 't',
          TELEGRAM_ALERT_CHAT_ID: 'c',
          WORKER_DRY_RUN: 'false',
        },
        loadConfig,
      ),
    ).toThrow(/RA_API_KEY/);
  });

  it('rejects a non-numeric override instead of silently using NaN', () => {
    expect(() => testConfig({ RA_INTER_CALL_DELAY_MS: 'soon' })).toThrow(/must be a number/);
  });

  it('applies sensible defaults', () => {
    const config = testConfig();
    expect(config.provider.interCallDelayMs).toBe(1500);
    expect(config.fulfillment.maxAttempts).toBe(3);
  });
});
