import { describe, expect, it } from 'vitest';
import { flyerUrl } from './assets.js';

describe('flyerUrl', () => {
  it('turns a stored key into a URL the browser can actually fetch', () => {
    // The bug this exists to prevent: rendered as-is, this is a relative path,
    // so the browser resolves it against the current page and 404s.
    expect(flyerUrl('flyers/lluvia/9f8e7d6c.jpg')).toBe('/media/flyers/lluvia/9f8e7d6c.jpg');
  });

  it('passes an absolute https URL through, so a CDN move needs no code change', () => {
    expect(flyerUrl('https://cdn.example.mx/superpacks.jpg')).toBe(
      'https://cdn.example.mx/superpacks.jpg',
    );
  });

  it('renders nothing when the campaign has no flyer', () => {
    expect(flyerUrl(null)).toBeNull();
    expect(flyerUrl(undefined)).toBeNull();
    expect(flyerUrl('')).toBeNull();
    expect(flyerUrl('   ')).toBeNull();
  });

  it('refuses a comprobante key even though it is a valid stored path', () => {
    // The whole reason uploads live outside the web root. A receipt shows a
    // name, a bank account and an amount; it must not become public because
    // someone pasted a key into the wrong column.
    expect(flyerUrl('comprobantes/LU-260909-RVBH/abc.jpg')).toBeNull();
  });

  it.each([
    ['flyers/../comprobantes/x.jpg', 'traversal'],
    ['flyers/..%2Fx.jpg', 'encoded traversal'],
    ['/etc/passwd', 'an absolute path'],
    ['//evil.mx/flyer.jpg', 'a protocol-relative URL'],
    ['javascript:alert(1)', 'a script URL'],
    ['data:image/png;base64,AAAA', 'a data URL'],
    ['flyers', 'the bare prefix with no file'],
    ['flyers/', 'a prefix with nothing after it'],
    ['promos/lluvia/x.jpg', 'a key outside the flyer prefix'],
  ])('refuses %s (%s)', (input) => {
    expect(flyerUrl(input)).toBeNull();
  });

  it('percent-encodes each segment without mangling the separators', () => {
    expect(flyerUrl('flyers/mega oferta/a b.png')).toBe('/media/flyers/mega%20oferta/a%20b.png');
  });

  it('tolerates the whitespace an operator pastes in', () => {
    expect(flyerUrl('  flyers/lluvia/x.webp  ')).toBe('/media/flyers/lluvia/x.webp');
  });
});
