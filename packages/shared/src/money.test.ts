import { describe, expect, it } from 'vitest';
import {
  addCentavos,
  checkRecipe,
  computeMargin,
  deliveredDiamonds,
  formatMxn,
  pesosToCentavos,
  usdToCentavos,
} from './money.js';

describe('diamonds', () => {
  // `base * 1.1` is lossy in float — 1060 * 1.1 === 1166.0000000000002.
  it.each([
    [100, 110],
    [310, 341],
    [520, 572],
    [1060, 1166],
    [2180, 2398],
    [5600, 6160],
  ])('%i base delivers %i with the +10%% bonus', (base, expected) => {
    expect(deliveredDiamonds(base)).toBe(expected);
  });
});

describe('checkRecipe', () => {
  it('accepts a combo that over-delivers', () => {
    // Mega Prime 48k: 5,600 eight times, advertised as 48,800.
    expect(checkRecipe(48_800, Array(8).fill(5600))).toEqual({
      delivered: 49_280,
      gap: 480,
      ok: true,
      withinTolerance: false,
    });
  });

  it('treats exact delivery as acceptable', () => {
    expect(checkRecipe(110, [100]).ok).toBe(true);
  });

  it.each([
    ['Descuentos Chidos 4800', 4800, [2180, 2180], 4796, -4],
    ['Lluvia de Diamantes 2400', 2400, [2180], 2398, -2],
  ])('allows %s — rounded down by a handful of diamonds', (_n, advertised, recipe, delivered, gap) => {
    // The client rounds flyer numbers for visual appeal and over-delivers on
    // most combos, so a few diamonds short is deliberate, not a defect.
    expect(checkRecipe(advertised, recipe)).toEqual({
      delivered,
      gap,
      ok: true,
      withinTolerance: true,
    });
  });

  it('still blocks a shortfall customers would notice', () => {
    // Pack Good at 3,600 advertised was 36 diamonds short — the client
    // relabelled the flyer to 3,500 rather than ship it.
    expect(checkRecipe(3600, [2180, 1060])).toEqual({
      delivered: 3564,
      gap: -36,
      ok: false,
      withinTolerance: false,
    });
  });

  it('accepts Pack Good at its corrected figure', () => {
    expect(checkRecipe(3500, [2180, 1060]).ok).toBe(true);
  });

  it('respects a stricter tolerance when one is given', () => {
    expect(checkRecipe(4800, [2180, 2180], 10, 0).ok).toBe(false);
  });
});

describe('money', () => {
  it('converts pesos to centavos', () => {
    expect(pesosToCentavos(1530)).toBe(153_000);
    expect(pesosToCentavos(10)).toBe(1_000);
  });

  it('rejects amounts finer than one centavo rather than rounding silently', () => {
    expect(() => pesosToCentavos(10.005)).toThrow(RangeError);
  });

  it('formats for Mexico', () => {
    expect(formatMxn(pesosToCentavos(1530))).toBe('$1,530.00');
  });

  it('sums without float drift', () => {
    const total = addCentavos(pesosToCentavos(0.1), pesosToCentavos(0.2));
    expect(total).toBe(30);
  });

  it('converts provider USD cost at the configured rate', () => {
    expect(usdToCentavos(10, 18.5)).toBe(18_500);
  });

  it('rejects a nonsensical FX rate', () => {
    expect(() => usdToCentavos(10, 0)).toThrow(RangeError);
  });
});

describe('computeMargin', () => {
  it('computes margin against provider cost', () => {
    const m = computeMargin(pesosToCentavos(580), 20, 18.5);
    expect(m.costCents).toBe(37_000);
    expect(m.marginCents).toBe(21_000);
    expect(m.marginPct).toBeCloseTo(36.2, 1);
  });

  it('reports a negative margin when cost exceeds price', () => {
    // The $10 Mega Oferta is a deliberate loss leader; the maths must say so.
    expect(computeMargin(pesosToCentavos(10), 1.5, 18.5).marginCents).toBeLessThan(0);
  });
});
