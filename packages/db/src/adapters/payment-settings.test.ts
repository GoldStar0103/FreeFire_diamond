import { afterEach, describe, expect, it } from 'vitest';
import {
  isValidClabe,
  paymentDetailsFromEnv,
  reviewFxRate,
  reviewPaymentDetails,
} from './payment-settings.js';

/** Real CLABEs whose check digits are correct. */
const VALID = ['032180000118359719', '002010077777777771', '646180157042875763'];

const draft = (over: Record<string, string> = {}) => ({
  bank: 'BBVA',
  clabe: VALID[0]!,
  holder: 'TITULAR DE PRUEBA',
  ...over,
});

describe('isValidClabe', () => {
  it.each(VALID)('accepts %s', (clabe) => {
    expect(isValidClabe(clabe)).toBe(true);
  });

  it('accepts the spacing a bank statement uses', () => {
    expect(isValidClabe('032 180 00011835971 9')).toBe(true);
  });

  it('rejects a transposed digit, which a length check would let through', () => {
    // The whole reason for validating the check digit rather than the length.
    const swapped = '032180000118359791';
    expect(swapped).toHaveLength(18);
    expect(isValidClabe(swapped)).toBe(false);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidClabe('032180000118359710')).toBe(false);
  });

  it.each(['', '12345', '0321800001183597199', 'abcdefghijklmnopqr'])(
    'rejects %p',
    (value) => {
      expect(isValidClabe(value)).toBe(false);
    },
  );
});

describe('reviewPaymentDetails', () => {
  it('accepts a complete set and normalises it', () => {
    const { details, issues } = reviewPaymentDetails({
      bank: '  BBVA  ',
      clabe: '032 180 00011835971 9',
      holder: '  Jose Manuel Ramirez  ',
      oxxo: '4189 1420 0012 3456',
    });
    expect(issues).toEqual([]);
    expect(details).toEqual({
      bank: 'BBVA',
      clabe: '032180000118359719',
      holder: 'Jose Manuel Ramirez',
      oxxo: '4189142000123456',
    });
  });

  it('treats OXXO as optional', () => {
    const { details, issues } = reviewPaymentDetails(draft({ oxxo: '' }));
    expect(issues).toEqual([]);
    expect(details?.oxxo).toBeNull();
  });

  it('never returns details alongside an issue', () => {
    // The caller writes `details` straight to the database. Handing back a
    // half-valid object next to a complaint is how bad data gets saved.
    const { details, issues } = reviewPaymentDetails(draft({ clabe: '123' }));
    expect(issues.length).toBeGreaterThan(0);
    expect(details).toBeNull();
  });

  it.each([
    ['bank', { bank: '' }],
    ['holder', { holder: '' }],
    ['clabe', { clabe: '' }],
  ])('requires %s', (field, over) => {
    const { issues } = reviewPaymentDetails(draft(over));
    expect(issues.some((i) => i.field === field)).toBe(true);
  });

  it('says how many digits are actually there', () => {
    const { issues } = reviewPaymentDetails(draft({ clabe: '0321800001' }));
    expect(issues[0]?.message).toContain('10');
  });

  it('distinguishes a typo from a wrong length', () => {
    const { issues } = reviewPaymentDetails(draft({ clabe: '032180000118359710' }));
    expect(issues[0]?.message).toMatch(/no es válida/i);
  });

  it('rejects an implausible OXXO number', () => {
    expect(reviewPaymentDetails(draft({ oxxo: '123' })).issues[0]?.field).toBe('oxxo');
  });
});

describe('paymentDetailsFromEnv', () => {
  afterEach(() => {
    // The function takes an env object, so nothing global is touched — this is
    // only a guard against a future signature change.
  });

  it('reads a complete set', () => {
    expect(
      paymentDetailsFromEnv({
        PAY_BANK: 'BBVA',
        PAY_CLABE: VALID[0]!,
        PAY_HOLDER: 'LEVELUP STORE',
        PAY_OXXO: '4189142000123456',
      }),
    ).toEqual({
      bank: 'BBVA',
      clabe: VALID[0],
      holder: 'LEVELUP STORE',
      oxxo: '4189142000123456',
    });
  });

  it('returns null when anything required is missing, rather than a blank', () => {
    // Returning a partial set is exactly how an empty account number reached a
    // customer standing at the payment step.
    expect(paymentDetailsFromEnv({})).toBeNull();
    expect(paymentDetailsFromEnv({ PAY_BANK: 'BBVA' })).toBeNull();
    expect(paymentDetailsFromEnv({ PAY_BANK: 'BBVA', PAY_CLABE: VALID[0]! })).toBeNull();
    expect(paymentDetailsFromEnv({ PAY_CLABE: '', PAY_BANK: 'BBVA', PAY_HOLDER: 'X' })).toBeNull();
  });
});

describe('reviewFxRate', () => {
  it('accepts a normal rate', () => {
    expect(reviewFxRate('18.5')).toEqual({ rate: 18.5, issues: [] });
  });

  it('accepts a comma as the decimal separator', () => {
    expect(reviewFxRate('18,75').rate).toBe(18.75);
  });

  it.each(['', 'abc', '0', '-3'])('rejects %p', (value) => {
    expect(reviewFxRate(value).rate).toBeNull();
  });

  it('catches a missing decimal point', () => {
    // 185 instead of 18.5 would misreport every margin in the panel tenfold.
    expect(reviewFxRate('185').rate).toBeNull();
    expect(reviewFxRate('1.85').rate).toBeNull();
  });
});
