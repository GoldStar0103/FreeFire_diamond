import { describe, expect, it } from 'vitest';
import { metaPixelId, tiktokPixelId } from './pixel-ids.js';

/**
 * Both values are interpolated into inline scripts on every storefront page.
 * The rejection cases are the point of these tests: each one is something that
 * could otherwise end up executing as code.
 */
const INJECTIONS = [
  "C4ABCDEFGHIJKLMNOPQR');alert(1);//",
  'C4ABCDEFGHIJKLMNOPQR</script><script>alert(1)</script>',
  "123456789012345');fbq('init','1",
  'C4ABCDEFGHIJ KLMNOPQR',
  'C4ABCDEFGHIJKLMNOPQR\nalert(1)',
  '<script>',
  '${alert(1)}',
  '`',
];

describe('metaPixelId', () => {
  it('accepts the long number from Events Manager', () => {
    expect(metaPixelId('1234567890123456')).toBe('1234567890123456');
  });

  it('trims what gets pasted around it', () => {
    expect(metaPixelId('  1234567890123456\n')).toBe('1234567890123456');
  });

  it.each([undefined, '', '   ', '1234567', '123456789012345678901', '12345678a'])(
    'treats %p as unset',
    (value) => {
      expect(metaPixelId(value)).toBeNull();
    },
  );

  it.each(INJECTIONS)('never lets %p through', (value) => {
    expect(metaPixelId(value)).toBeNull();
  });
});

describe('tiktokPixelId', () => {
  it('accepts a pixel code as Ads Manager shows it', () => {
    expect(tiktokPixelId('C4ABCDEFGHIJKLMNOPQR')).toBe('C4ABCDEFGHIJKLMNOPQR');
    expect(tiktokPixelId('D0Q1A2B3C4E5F6G7H8IJ')).toBe('D0Q1A2B3C4E5F6G7H8IJ');
  });

  it('trims what gets pasted around it', () => {
    expect(tiktokPixelId(' C4ABCDEFGHIJKLMNOPQR \r\n')).toBe('C4ABCDEFGHIJKLMNOPQR');
  });

  it('allows some slack in length, so a longer code does not silently switch tracking off', () => {
    expect(tiktokPixelId('C4ABCDEFGHIJKLMN')).toBe('C4ABCDEFGHIJKLMN');
    expect(tiktokPixelId('C4ABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).toBe('C4ABCDEFGHIJKLMNOPQRSTUVWXYZ0123');
  });

  it.each([
    [undefined, 'unset'],
    ['', 'empty'],
    ['   ', 'blank'],
    ['C4ABCDEFGHIJKL', 'too short to be a pixel code'],
    ['C4ABCDEFGHIJKLMNOPQRSTUVWXYZ01234', 'too long to be a pixel code'],
    ['c4abcdefghijklmnopqr', 'lowercase — not what Ads Manager shows'],
    ['C4ABCDEFGHIJ-KLMNOPQR', 'punctuation'],
    ['C4ABCDEFGHIJKLMNOPQÑ', 'a letter outside A–Z'],
  ])('treats %p as unset (%s)', (value, _why) => {
    expect(tiktokPixelId(value)).toBeNull();
  });

  it.each(INJECTIONS)('never lets %p through', (value) => {
    expect(tiktokPixelId(value)).toBeNull();
  });
});
