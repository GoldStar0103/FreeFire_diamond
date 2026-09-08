/**
 * The failure matrix.
 *
 * These are the scenarios the client's partner is sceptical about. Each test
 * scripts the simulator into a specific failure, then checks that reconciliation
 * reaches the right verdict from the wallet balance alone — the simulator never
 * tells it whether money moved.
 */

import { describe, expect, it } from 'vitest';
import { hasSufficientBalance, isSafeToRetry, resolveAmbiguous } from './reconcile.js';
import { ProviderSimulator } from './simulator.js';
import { parseUsd, ValidationUnsupportedError, type UsdTenK } from './types.js';

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

/** The six commodity SKUs, priced roughly at LevelUp's real cost structure. */
const PRICES = {
  d100: 0.55,
  d310: 1.65,
  d520: 2.75,
  d1060: 5.4,
  d2180: 10.8,
  d5600: 27.5,
};

const newSim = (balanceUsd = 500) =>
  new ProviderSimulator({
    initialBalanceUsd: balanceUsd,
    prices: PRICES,
    validatableProducts: ['d100', 'd1060'],
    knownPlayers: { '7288567050': 'ElCarneseca' },
  });

const req = (productId: string, overrides = {}) => ({
  endpointKind: 'pins_recharge' as const,
  providerProductId: productId,
  playerId: '7288567050',
  clientReference: 'LU-000123-1',
  ...overrides,
});

// ── the ambiguous cases, which are the whole point ────────────────────────────

describe('timeout where the provider DID charge', () => {
  it('is resolved as charged, so the item is never retried', async () => {
    const sim = newSim();
    sim.program({ mode: 'timeout', charged: true });

    const before = await sim.getBalance();
    const outcome = await sim.purchase(req('d2180'));
    const after = await sim.getBalance();

    expect(outcome.kind).toBe('ambiguous');

    const resolution = resolveAmbiguous({
      balanceBefore: before,
      balanceAfter: after,
      expectedCost: usd(PRICES.d2180),
    });

    expect(resolution.verdict).toBe('charged');
    expect(isSafeToRetry(resolution)).toBe(false);
    // The customer got their diamonds exactly once.
    expect(sim.deliveryCount).toBe(1);
  });
});

describe('timeout where the provider did NOT charge', () => {
  it('is resolved as not charged, so a retry is safe', async () => {
    const sim = newSim();
    sim.program({ mode: 'timeout', charged: false }, { mode: 'succeed' });

    const before = await sim.getBalance();
    await sim.purchase(req('d2180'));
    const after = await sim.getBalance();

    const resolution = resolveAmbiguous({
      balanceBefore: before,
      balanceAfter: after,
      expectedCost: usd(PRICES.d2180),
    });

    expect(resolution.verdict).toBe('not_charged');
    expect(isSafeToRetry(resolution)).toBe(true);

    const retry = await sim.purchase(req('d2180'));
    expect(retry.kind).toBe('succeeded');
    // Charged once overall — the retry was the only delivery.
    expect(sim.deliveryCount).toBe(1);
  });
});

describe('502 PROVIDER_ERROR after the wallet was debited', () => {
  it('does not double-deliver', async () => {
    const sim = newSim();
    sim.program({ mode: 'provider_error', charged: true });

    const before = await sim.getBalance();
    const outcome = await sim.purchase(req('d5600'));
    const after = await sim.getBalance();

    expect(outcome).toMatchObject({ kind: 'ambiguous', reason: 'provider_error' });
    expect(
      resolveAmbiguous({
        balanceBefore: before,
        balanceAfter: after,
        expectedCost: usd(PRICES.d5600),
      }).verdict,
    ).toBe('charged');
    expect(sim.deliveryCount).toBe(1);
  });
});

describe('a concurrent call breaking the single-flight guarantee', () => {
  it('refuses to guess and escalates instead', async () => {
    const sim = newSim();
    // Two purchases land between our two balance reads, which is exactly what
    // the advisory lock exists to prevent.
    sim.program({ mode: 'timeout', charged: true }, { mode: 'succeed' });

    const before = await sim.getBalance();
    await sim.purchase(req('d2180'));
    await sim.purchase(req('d1060'));
    const after = await sim.getBalance();

    const resolution = resolveAmbiguous({
      balanceBefore: before,
      balanceAfter: after,
      expectedCost: usd(PRICES.d2180),
    });

    expect(resolution.verdict).toBe('indeterminate');
    expect(isSafeToRetry(resolution)).toBe(false);
    if (resolution.verdict === 'indeterminate') {
      expect(resolution.reason).toMatch(/in flight/i);
    }
  });
});

describe('a balance that increased mid-call', () => {
  it('is indeterminate rather than assumed uncharged', () => {
    const resolution = resolveAmbiguous({
      balanceBefore: usd(100),
      balanceAfter: usd(150), // client topped up while the call was out
      expectedCost: usd(10.8),
    });
    expect(resolution.verdict).toBe('indeterminate');
    expect(isSafeToRetry(resolution)).toBe(false);
  });
});

// ── definitive failures ───────────────────────────────────────────────────────

describe('definitive failures', () => {
  it('marks insufficient balance retryable — the cause is fixable', async () => {
    const sim = newSim(1);
    sim.program({ mode: 'insufficient_balance' });
    const outcome = await sim.purchase(req('d5600'));
    expect(outcome).toMatchObject({ kind: 'failed', code: 'PURCHASE_FAILED', retryable: true });
    expect(sim.deliveryCount).toBe(0);
  });

  it('marks an invalid product type permanent — it is a config bug', async () => {
    const sim = newSim();
    sim.program({ mode: 'invalid_product_type' });
    const outcome = await sim.purchase(req('d100'));
    expect(outcome).toMatchObject({ code: 'INVALID_PRODUCT_TYPE', retryable: false });
  });

  it('treats a pre-send network error as ambiguous, not as a clean failure', async () => {
    const sim = newSim();
    sim.program({ mode: 'network_error' });
    const outcome = await sim.purchase(req('d100'));
    // Even though nothing was charged, the caller cannot know that from the
    // error alone — it must still go through reconciliation.
    expect(outcome).toMatchObject({ kind: 'ambiguous', reason: 'network' });
  });
});

// ── pending orders ────────────────────────────────────────────────────────────

describe('PENDING orders', () => {
  it('resolves to COMPLETED after polling', async () => {
    const sim = newSim();
    sim.program({ mode: 'pending', completesAfterPolls: 3 });

    const outcome = await sim.purchase(req('d1060', { endpointKind: 'games' }));
    expect(outcome.kind).toBe('pending');
    if (outcome.kind !== 'pending') throw new Error('unreachable');

    expect((await sim.getOrderStatus(outcome.providerReference))?.status).toBe('PENDING');
    expect((await sim.getOrderStatus(outcome.providerReference))?.status).toBe('PENDING');
    expect((await sim.getOrderStatus(outcome.providerReference))?.status).toBe('COMPLETED');
  });

  it('never resolves for a stuck order, so polling must have a ceiling', async () => {
    const sim = newSim();
    sim.program({ mode: 'pending_forever' });
    const outcome = await sim.purchase(req('d1060', { endpointKind: 'games' }));
    if (outcome.kind !== 'pending') throw new Error('unreachable');

    for (let i = 0; i < 50; i++) {
      expect((await sim.getOrderStatus(outcome.providerReference))?.status).toBe('PENDING');
    }
    // The worker must escalate to needs_review rather than poll indefinitely.
  });

  it('returns null for an unknown reference', async () => {
    expect(await newSim().getOrderStatus('NOPE')).toBeNull();
  });
});

// ── the project-breaking case ─────────────────────────────────────────────────

describe('code delivery instead of a top-up', () => {
  it('is a distinct outcome, never mistaken for success', async () => {
    const sim = newSim();
    sim.program({ mode: 'succeed_as_code', pins: ['ABC-123'] });
    const outcome = await sim.purchase(req('d100'));

    expect(outcome.kind).toBe('delivered_as_code');
    // A caller pattern-matching on 'succeeded' will not silently accept this,
    // which is what stops us telling a customer their diamonds are on the way
    // when all they actually got was a code.
    expect(outcome.kind).not.toBe('succeeded');
  });
});

// ── an 8-call combo end to end ────────────────────────────────────────────────

describe('Mega Prime 48k — eight provider calls as one purchase', () => {
  it('completes all eight and charges exactly eight times', async () => {
    const sim = newSim(500);
    sim.program({ mode: 'succeed' });

    for (let i = 0; i < 8; i++) {
      const outcome = await sim.purchase(req('d5600', { clientReference: `LU-000900-${i}` }));
      expect(outcome.kind).toBe('succeeded');
    }

    expect(sim.deliveryCount).toBe(8);
    expect(sim.actualBalance).toBe(usd(500 - 8 * PRICES.d5600));
  });

  it('recovers a mid-combo timeout without re-running completed calls', async () => {
    const sim = newSim(500);
    // Calls 1-3 fine, call 4 times out having charged, calls 5-8 fine.
    sim.program(
      { mode: 'succeed' },
      { mode: 'succeed' },
      { mode: 'succeed' },
      { mode: 'timeout', charged: true },
      { mode: 'succeed' },
    );

    let delivered = 0;
    for (let i = 0; i < 8; i++) {
      const before = await sim.getBalance();
      const outcome = await sim.purchase(req('d5600', { clientReference: `LU-000901-${i}` }));
      const after = await sim.getBalance();

      if (outcome.kind === 'succeeded') {
        delivered++;
      } else if (outcome.kind === 'ambiguous') {
        const r = resolveAmbiguous({
          balanceBefore: before,
          balanceAfter: after,
          expectedCost: usd(PRICES.d5600),
        });
        expect(r.verdict).toBe('charged');
        delivered++; // resolved as delivered — crucially, NOT retried
      }
    }

    expect(delivered).toBe(8);
    expect(sim.deliveryCount).toBe(8); // never nine
  });

  it('runs out of balance mid-combo rather than silently under-delivering', async () => {
    // Enough for three 5,600 calls, not eight.
    const sim = newSim(90);
    sim.program({ mode: 'succeed' });

    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < 8; i++) {
      const outcome = await sim.purchase(req('d5600'));
      if (outcome.kind === 'succeeded') succeeded++;
      else failed++;
    }

    expect(succeeded).toBe(3);
    expect(failed).toBe(5);
    // Which is why the pre-flight check exists: the customer has already paid,
    // so the queue must pause before starting an order it cannot finish.
    const check = hasSufficientBalance(usd(90), usd(8 * PRICES.d5600));
    expect(check.ok).toBe(false);
    expect(check.shortfall).toBe(usd(8 * PRICES.d5600 - 90));
  });
});

// ── pre-flight balance ────────────────────────────────────────────────────────

describe('hasSufficientBalance', () => {
  it('passes when the balance covers the whole order', () => {
    expect(hasSufficientBalance(usd(500), usd(220)).ok).toBe(true);
  });

  it('respects a reserve floor', () => {
    const check = hasSufficientBalance(usd(250), usd(220), usd(100));
    expect(check.ok).toBe(false);
    expect(check.shortfall).toBe(usd(70));
  });
});

// ── validation ────────────────────────────────────────────────────────────────

describe('player validation', () => {
  it('returns the nickname for the confirmation gate', async () => {
    const v = await newSim().validatePlayer('d100', '7288567050');
    expect(v).toEqual({ found: true, nickname: 'ElCarneseca' });
  });

  it('reports a missing account rather than throwing', async () => {
    expect(await newSim().validatePlayer('d100', '0000000000')).toEqual({
      found: false,
      nickname: null,
    });
  });

  it('throws loudly for products that cannot be validated', async () => {
    // Silence here would mean shipping diamonds to unverified IDs.
    await expect(newSim().validatePlayer('d5600', '7288567050')).rejects.toThrow(
      ValidationUnsupportedError,
    );
  });
});

// ── money parsing ─────────────────────────────────────────────────────────────

describe('parseUsd', () => {
  it.each([
    ['27.50', 275_000],
    ['0.55', 5_500],
    ['150', 1_500_000],
    ['0.0001', 1],
  ])('parses %s', (input, expected) => {
    expect(parseUsd(input)).toBe(expected);
  });

  it('rejects junk rather than yielding NaN', () => {
    expect(() => parseUsd('abc')).toThrow(RangeError);
  });
});
