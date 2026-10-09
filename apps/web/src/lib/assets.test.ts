import { describe, expect, it } from 'vitest';
import { avatarUrl, badgeArtworkUrl, flyerUrl } from './assets.js';

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

describe('avatarUrl', () => {
  it('resolves a stored avatar key to a media URL', () => {
    expect(avatarUrl('avatars/profile-1/abc123.jpg')).toBe('/media/avatars/profile-1/abc123.jpg');
  });

  it('passes an absolute https URL through untouched', () => {
    expect(avatarUrl('https://cdn.example.com/avatar.jpg')).toBe('https://cdn.example.com/avatar.jpg');
  });

  it('returns null for nothing stored', () => {
    expect(avatarUrl(null)).toBeNull();
    expect(avatarUrl(undefined)).toBeNull();
    expect(avatarUrl('')).toBeNull();
  });

  it('refuses a key outside the avatars/ prefix — including comprobantes and flyers', () => {
    expect(avatarUrl('comprobantes/LU-1/abc.jpg')).toBeNull();
    expect(avatarUrl('flyers/promo/abc.jpg')).toBeNull();
  });

  it('refuses path traversal and an absolute path', () => {
    expect(avatarUrl('avatars/../../etc/passwd')).toBeNull();
    expect(avatarUrl('/etc/passwd')).toBeNull();
  });

  it('refuses a non-http protocol', () => {
    expect(avatarUrl('javascript:alert(1)')).toBeNull();
    expect(avatarUrl('data:image/png;base64,abc')).toBeNull();
  });

  it('refuses a bare prefix with nothing after it', () => {
    expect(avatarUrl('avatars/')).toBeNull();
  });
});

describe('badgeArtworkUrl', () => {
  it('turns a stored key into a URL', () => {
    expect(badgeArtworkUrl('badges/top_10/9f8e7d6c.png')).toBe('/media/badges/top_10/9f8e7d6c.png');
  });

  it('passes an absolute https URL through, so artwork can live on a CDN', () => {
    expect(badgeArtworkUrl('https://cdn.example.mx/top10.png')).toBe(
      'https://cdn.example.mx/top10.png',
    );
  });

  it('refuses a key outside badges/ — this column is admin-editable', () => {
    expect(badgeArtworkUrl('comprobantes/LU-1/abc.jpg')).toBeNull();
    expect(badgeArtworkUrl('avatars/abc/def.jpg')).toBeNull();
  });

  it('refuses traversal, absolute paths and non-http protocols', () => {
    expect(badgeArtworkUrl('badges/../../etc/passwd')).toBeNull();
    expect(badgeArtworkUrl('/etc/passwd')).toBeNull();
    expect(badgeArtworkUrl('javascript:alert(1)')).toBeNull();
  });

  it('refuses a bare prefix and empty input', () => {
    expect(badgeArtworkUrl('badges/')).toBeNull();
    expect(badgeArtworkUrl(null)).toBeNull();
  });
});
