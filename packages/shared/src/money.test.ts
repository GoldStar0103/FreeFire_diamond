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
    const r = checkRecipe(48_800, Array(8).fill(5600));
    expect(r).toEqual({ delivered: 49_280, gap: 480, ok: true });
  });

  it.each([
    ['Descuentos Chidos 4800', 4800, [2180, 2180], 4796, -4],
    ['Lluvia de Diamantes 2400', 2400, [2180], 2398, -2],
    ['Pack Good', 3600, [2180, 1060], 3564, -36],
  ])('flags %s as under-delivering', (_name, advertised, recipe, delivered, gap) => {
    expect(checkRecipe(advertised, recipe)).toEqual({ delivered, gap, ok: false });
  });

  it('treats exact delivery as acceptable', () => {
    expect(checkRecipe(110, [100]).ok).toBe(true);
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
