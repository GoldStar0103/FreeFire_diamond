import { describe, expect, it } from 'vitest';
import type { UsdTenK } from '@levelup/provider';
import {
  reviewCampaignDraft,
  reviewComboDraft,
  type AvailableProduct,
  type CampaignDraft,
  type ComboDraft,
} from './catalog-admin.js';

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;
const FX = 18.5;

/** The six real denominations with the provider's actual costs. */
const PRODUCTS: AvailableProduct[] = [
  { diamondsBase: 100, costUsd: usd(0.7), active: true },
  { diamondsBase: 310, costUsd: usd(2.1), active: true },
  { diamondsBase: 520, costUsd: usd(3.55), active: true },
  { diamondsBase: 1060, costUsd: usd(6.59), active: true },
  { diamondsBase: 2180, costUsd: usd(13.07), active: true },
  { diamondsBase: 5600, costUsd: usd(33.27), active: true },
];

const draft = (overrides: Partial<ComboDraft> = {}): ComboDraft => ({
  key: 'pack_insano',
  name: 'Pack Insano',
  priceMxnCents: 86_000,
  advertisedDiamonds: 7200,
  maxPerPlayer: null,
  recipe: [5600, 1060],
  active: true,
  ...overrides,
});

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('a healthy combo', () => {
  it('passes and reports the maths', () => {
    const review = reviewComboDraft(draft(), PRODUCTS, FX);

    expect(review.canActivate).toBe(true);
    expect(review.errors).toEqual([]);
    expect(review.delivered).toBe(7326);
    expect(review.gap).toBe(126);
    expect(review.callCount).toBe(2);
    expect(review.costUsd).toBeCloseTo(39.86, 2);
    expect(review.marginPct).toBeCloseTo(14.3, 1);
  });
});

describe('the rule that matters', () => {
  it('blocks activation when the flyer promises more than the recipe delivers', () => {
    // Pack Good as originally specified: 3,600 advertised, 3,564 delivered.
    const review = reviewComboDraft(
      draft({ advertisedDiamonds: 3600, recipe: [2180, 1060] }),
      PRODUCTS,
      FX,
    );

    expect(review.canActivate).toBe(false);
    expect(codes(review.errors)).toContain('UNDER_DELIVERS');
    expect(review.errors[0]?.message).toContain('Faltan 36');
  });

  it('allows the corrected figure the client chose', () => {
    // They relabelled the flyer to 3,500 rather than change the recipe.
    expect(reviewComboDraft(draft({ advertisedDiamonds: 3500, recipe: [2180, 1060] }), PRODUCTS, FX).canActivate).toBe(true);
  });

  it('allows a few diamonds short, and says so', () => {
    // The client rounds for visual appeal and over-delivers on most combos.
    const review = reviewComboDraft(
      draft({ advertisedDiamonds: 2400, recipe: [2180] }),
      PRODUCTS,
      FX,
    );

    expect(review.canActivate).toBe(true);
    expect(review.roundedDown).toBe(true);
    expect(codes(review.warnings)).toContain('ROUNDED_DOWN');
  });
});

describe('recipe problems', () => {
  it('rejects an empty recipe without pretending to compute a margin', () => {
    const review = reviewComboDraft(draft({ recipe: [] }), PRODUCTS, FX);

    expect(codes(review.errors)).toContain('EMPTY_RECIPE');
    expect(review.marginPct).toBeNull();
    expect(review.callCount).toBe(0);
  });

  it('rejects a denomination the provider does not sell', () => {
    const review = reviewComboDraft(draft({ recipe: [5600, 999] }), PRODUCTS, FX);
    expect(codes(review.errors)).toContain('UNKNOWN_PRODUCT');
  });

  it('rejects a withdrawn product', () => {
    const withdrawn = PRODUCTS.map((p) =>
      p.diamondsBase === 5600 ? { ...p, active: false } : p,
    );
    const review = reviewComboDraft(draft(), withdrawn, FX);

    expect(codes(review.errors)).toContain('INACTIVE_PRODUCT');
    expect(review.canActivate).toBe(false);
  });

  it('warns rather than blocks on a very long recipe', () => {
    // Mega Prime 48k is eight calls and is legitimate; nine is worth a nudge.
    const review = reviewComboDraft(
      draft({ advertisedDiamonds: 55_000, recipe: Array(9).fill(5600), priceMxnCents: 700_000 }),
      PRODUCTS,
      FX,
    );

    expect(review.canActivate).toBe(true);
    expect(codes(review.warnings)).toContain('MANY_CALLS');
  });

  it('accepts eight calls without complaint', () => {
    const review = reviewComboDraft(
      draft({ advertisedDiamonds: 48_800, recipe: Array(8).fill(5600), priceMxnCents: 585_000 }),
      PRODUCTS,
      FX,
    );
    expect(codes(review.warnings)).not.toContain('MANY_CALLS');
  });
});

describe('margin warnings', () => {
  it('flags a combo that loses money without blocking it', () => {
    // The $10 Mega Oferta costs $12.93 and is deliberate customer acquisition.
    const review = reviewComboDraft(
      draft({ key: 'mega_10', name: 'Mega Oferta', priceMxnCents: 1_000, advertisedDiamonds: 110, recipe: [100] }),
      PRODUCTS,
      FX,
    );

    expect(review.canActivate).toBe(true);
    expect(codes(review.warnings)).toContain('NEGATIVE_MARGIN');
    expect(review.marginMxnCents).toBeLessThan(0);
  });

  it('flags a thin margin an FX move could erase', () => {
    const review = reviewComboDraft(draft({ priceMxnCents: 78_000 }), PRODUCTS, FX);
    expect(codes(review.warnings)).toContain('THIN_MARGIN');
  });

  it('says nothing about a healthy margin', () => {
    const review = reviewComboDraft(draft(), PRODUCTS, FX);
    expect(codes(review.warnings)).not.toContain('THIN_MARGIN');
    expect(codes(review.warnings)).not.toContain('NEGATIVE_MARGIN');
  });

  it('refuses to guess a margin when a cost is missing', () => {
    const uncosted = PRODUCTS.map((p) =>
      p.diamondsBase === 1060 ? { ...p, costUsd: null } : p,
    );
    const review = reviewComboDraft(draft(), uncosted, FX);

    // A partial sum would understate the cost and overstate the margin.
    expect(review.marginPct).toBeNull();
    expect(codes(review.warnings)).toContain('NO_COST');
  });
});

describe('field validation', () => {
  it.each([
    ['uppercase', 'Pack_Insano'],
    ['spaces', 'pack insano'],
    ['too short', 'ab'],
    ['punctuation', 'pack-insano!'],
  ])('rejects a key with %s', (_label, key) => {
    expect(codes(reviewComboDraft(draft({ key }), PRODUCTS, FX).errors)).toContain('BAD_KEY');
  });

  it.each([
    ['empty name', { name: '  ' }, 'BAD_NAME'],
    ['zero price', { priceMxnCents: 0 }, 'BAD_PRICE'],
    ['negative price', { priceMxnCents: -100 }, 'BAD_PRICE'],
    ['zero advertised', { advertisedDiamonds: 0 }, 'BAD_ADVERTISED'],
    ['zero cap', { maxPerPlayer: 0 }, 'BAD_LIMIT'],
  ])('rejects %s', (_label, overrides, code) => {
    expect(codes(reviewComboDraft(draft(overrides), PRODUCTS, FX).errors)).toContain(code);
  });

  it('accepts a null cap as "sin límite"', () => {
    expect(reviewComboDraft(draft({ maxPerPlayer: null }), PRODUCTS, FX).canActivate).toBe(true);
  });

  it('accepts the Mega Oferta cap of one per player', () => {
    expect(reviewComboDraft(draft({ maxPerPlayer: 1 }), PRODUCTS, FX).canActivate).toBe(true);
  });
});

describe('reviewCampaignDraft', () => {
  const campaign = (overrides: Partial<CampaignDraft> = {}): CampaignDraft => ({
    key: 'super_packs',
    name: 'SUPER PACKS',
    badge: null,
    permanent: false,
    active: true,
    startsAt: null,
    endsAt: null,
    ...overrides,
  });

  it('accepts a valid campaign', () => {
    expect(reviewCampaignDraft(campaign())).toEqual([]);
  });

  it('rejects a window that ends before it starts', () => {
    const issues = reviewCampaignDraft(
      campaign({
        startsAt: new Date('2026-10-01'),
        endsAt: new Date('2026-09-01'),
      }),
    );
    expect(codes(issues)).toContain('BAD_WINDOW');
  });

  it('accepts an open-ended window, which is how a permanent promo works', () => {
    expect(reviewCampaignDraft(campaign({ permanent: true, endsAt: null }))).toEqual([]);
  });

  it('rejects a bad key or name', () => {
    expect(codes(reviewCampaignDraft(campaign({ key: 'BAD KEY' })))).toContain('BAD_KEY');
    expect(codes(reviewCampaignDraft(campaign({ name: '' })))).toContain('BAD_NAME');
  });
});
