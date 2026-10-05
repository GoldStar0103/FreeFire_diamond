import { describe, expect, it } from 'vitest';
import {
  BASE_DENOMINATIONS,
  extractDiamonds,
  mapDenominations,
  normaliseCatalogProduct,
  rankProduct,
} from './catalog.js';

describe('extractDiamonds', () => {
  it('reads the base count from names seen in the live catalog', () => {
    expect(extractDiamonds('1060 Diamonds')).toBe(1060);
    expect(extractDiamonds('1.060 Diamantes')).toBe(1060);
    expect(extractDiamonds('2180💎')).toBe(2180);
    expect(extractDiamonds('Free Fire (MY) 5600')).toBe(5600);
    expect(extractDiamonds('100 Diamonds')).toBe(100);
  });

  // The exact case the 2026-09-15 catalog change threatens: RecargasAmérica
  // renaming products to quote what actually lands in the account.
  it('resolves a delivered (post-bonus) figure back to its base denomination', () => {
    expect(extractDiamonds('110 Diamantes')).toBe(100);
    expect(extractDiamonds('341 Diamantes')).toBe(310);
    expect(extractDiamonds('572 Diamantes')).toBe(520);
    expect(extractDiamonds('1166 Diamantes')).toBe(1060);
    expect(extractDiamonds('2398 Diamantes')).toBe(2180);
    expect(extractDiamonds('6160💎')).toBe(5600);
  });

  it('resolves a delivered figure even without a diamond word adjacent to it', () => {
    // Falls to the general number scan, same as a bare base figure would.
    expect(extractDiamonds('FFCH1166')).toBe(1060);
  });

  it('prefers a number adjacent to a diamond word over an unrelated one earlier in the string', () => {
    // A region or SKU number must not be mistaken for the quantity, whether
    // the adjacent figure is a base or a delivered count.
    expect(extractDiamonds('Free Fire (MY) 1060 Diamonds')).toBe(1060);
    expect(extractDiamonds('Free Fire (MY) 1166 Diamantes')).toBe(1060);
  });

  it('still returns an adjacent number verbatim when it resolves to neither shape', () => {
    // Existing behaviour: a diamond-adjacent number that is not one of the six
    // denominations or their delivered figures is returned as-is, so
    // mapDenominations (which filters on the six bases) simply finds no match
    // for it rather than the whole product silently vanishing as unparseable.
    expect(extractDiamonds('9999 Diamantes')).toBe(9999);
  });

  it('returns null with nothing to go on', () => {
    expect(extractDiamonds('Free Fire (MY)')).toBeNull();
    expect(extractDiamonds(null)).toBeNull();
    expect(extractDiamonds(undefined)).toBeNull();
  });
});

describe('normaliseCatalogProduct with delivered-figure names', () => {
  it('still maps a games-family product (player_id) renamed to its delivered count', () => {
    const product = normaliseCatalogProduct({
      id: 1,
      name: 'Free Fire 1166 Diamantes',
      type: 'recharge',
      required_fields: ['player_id'],
      price: 6.59,
    });
    expect(product.diamondsBase).toBe(1060);
    expect(product.endpointKind).toBe('games');
    expect(product.canValidate).toBe(true);
  });

  it('still maps a direct-to-account recharge product renamed to its delivered count', () => {
    const product = normaliseCatalogProduct({
      id: 5,
      sku: 'FFCH110',
      name: '110 Diamantes',
      type: 'recharge',
      required_fields: ['manual_id'],
      price: 0.7,
    });
    expect(product.diamondsBase).toBe(100);
    expect(product.endpointKind).toBe('pins_recharge');
    expect(product.canValidate).toBe(true);
  });

  it('maps a "pin" (redeemable code) product as pins_code, never validatable', () => {
    const product = normaliseCatalogProduct({
      id: 11,
      sku: 'ADS011',
      name: 'Pin Free Fire 100 Diamantes',
      type: 'pin',
      required_fields: [],
      price: 0.68,
    });
    expect(product.endpointKind).toBe('pins_code');
    expect(product.canValidate).toBe(false);
  });

  it('lets mapDenominations pick up a renamed product for its base slot', () => {
    const products = [
      normaliseCatalogProduct({
        id: 5,
        sku: 'FFCH110',
        name: '110 Diamantes',
        type: 'recharge',
        required_fields: ['manual_id'],
        price: 0.7,
      }),
    ];
    const matches = mapDenominations(products);
    const hundred = matches.find((m) => m.denomination === 100);
    expect(hundred?.chosen?.providerProductId).toBe('5');
  });
});

describe('rankProduct', () => {
  it('prefers a validatable recharge over a games package over a redeemable code', () => {
    const recharge = normaliseCatalogProduct({
      id: 1,
      name: '100',
      type: 'recharge',
      required_fields: ['manual_id'],
      price: 1,
    });
    const game = normaliseCatalogProduct({
      id: 2,
      name: 'Free Fire 100',
      type: 'recharge',
      required_fields: ['player_id'],
      price: 1,
    });
    const code = normaliseCatalogProduct({ id: 3, name: '100', type: 'pin', required_fields: [], price: 1 });
    expect(rankProduct(recharge)).toBeLessThan(rankProduct(game));
    expect(rankProduct(game)).toBeLessThan(rankProduct(code));
  });
});

describe('BASE_DENOMINATIONS', () => {
  it('is exactly the six commodity SKUs the catalog sync maps', () => {
    expect(BASE_DENOMINATIONS).toEqual([100, 310, 520, 1060, 2180, 5600]);
  });
});
