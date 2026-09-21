import { describe, expect, it } from 'vitest';
import { googleSiteVerification } from './google-verification.js';

/**
 * The token is interpolated into a meta tag on every storefront page.
 * The rejection cases are the point: each one is something that could
 * otherwise end up as an attribute value we did not intend.
 */
const INJECTIONS = [
  'abcdefghijklmnop"><script>alert(1)</script>',
  'abcdefghijklmnop</script><script>alert(1)</script>',
  "abcdefghijklmnop' onload='alert(1)",
  'abcdefghijklmno p',
  'abcdefghijklmnop\nalert(1)',
  '<script>',
  '${alert(1)}',
  '`',
];

describe('googleSiteVerification', () => {
  it('accepts the token Search Console shows for the HTML tag', () => {
    expect(googleSiteVerification('abcdefghijklmnopqrstuv')).toBe('abcdefghijklmnopqrstuv');
    expect(googleSiteVerification('G-abcDEF0123_xyz-token99')).toBe('G-abcDEF0123_xyz-token99');
  });

  it('trims what gets pasted around it', () => {
    expect(googleSiteVerification('  abcdefghijklmnopqrstuv\n')).toBe('abcdefghijklmnopqrstuv');
  });

  it.each([undefined, '', '   ', 'shorttoken', 'abcdefghijklmno'])(
    'treats %p as unset',
    (value) => {
      expect(googleSiteVerification(value)).toBeNull();
    },
  );

  it.each(INJECTIONS)('never lets %p through', (value) => {
    expect(googleSiteVerification(value)).toBeNull();
  });
});
