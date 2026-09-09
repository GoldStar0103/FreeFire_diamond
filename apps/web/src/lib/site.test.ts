import { describe, expect, it } from 'vitest';
import { siteOrigin, siteUrl } from './site.js';

describe('siteOrigin', () => {
  it('adds the scheme to a bare hostname', () => {
    // PUBLIC_DOMAIN is configured bare, because the legal pages print it as
    // text. Every other consumer needs an absolute URL.
    expect(siteOrigin('levelupstore.mx')).toBe('https://levelupstore.mx');
  });

  it('accepts a value that already has one', () => {
    expect(siteOrigin('https://levelupstore.mx')).toBe('https://levelupstore.mx');
  });

  it('forces https, since that is what the site serves', () => {
    // A mixed-scheme og:image is dropped by scrapers.
    expect(siteOrigin('http://levelupstore.mx')).toBe('https://levelupstore.mx');
  });

  it('keeps http for localhost so previews resolve in development', () => {
    expect(siteOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(siteOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
  });

  it('defaults a bare local hostname to http, not https', () => {
    // `localhost:3000` is what anyone writes in a dev .env. Defaulting it to
    // https made the sitemap and canonical tags point at a URL the dev server
    // does not serve — caught by the deploy smoke test, not by a person.
    expect(siteOrigin('localhost:3000')).toBe('http://localhost:3000');
    expect(siteOrigin('127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(siteOrigin('localhost')).toBe('http://localhost');
  });

  it('does not mistake a real domain that merely starts with "localhost"', () => {
    expect(siteOrigin('localhost.levelupstore.mx')).toBe('https://localhost.levelupstore.mx');
  });

  it('strips trailing slashes and whitespace', () => {
    expect(siteOrigin('  https://levelupstore.mx/  ')).toBe('https://levelupstore.mx');
    expect(siteOrigin('levelupstore.mx//')).toBe('https://levelupstore.mx');
  });

  it('keeps a non-default port', () => {
    expect(siteOrigin('levelupstore.mx:8443')).toBe('https://levelupstore.mx:8443');
  });

  it('falls back rather than throwing on an unset or unusable value', () => {
    // This runs inside `metadataBase`, at module scope in the root layout. A
    // throw here takes down every page, not just the metadata.
    expect(siteOrigin(undefined)).toBe('https://levelupstore.mx');
    expect(siteOrigin('')).toBe('https://levelupstore.mx');
    expect(siteOrigin('   ')).toBe('https://levelupstore.mx');
    expect(siteOrigin('http://')).toBe('https://levelupstore.mx');
  });

  it('drops any path, since an origin is what callers need', () => {
    expect(siteOrigin('https://levelupstore.mx/tienda')).toBe('https://levelupstore.mx');
  });
});

describe('siteUrl', () => {
  it('builds absolute URLs', () => {
    expect(siteUrl('/')).toBe('https://levelupstore.mx/');
    expect(siteUrl('/comprar/pack_insano')).toBe('https://levelupstore.mx/comprar/pack_insano');
    expect(siteUrl('/sitemap.xml')).toBe('https://levelupstore.mx/sitemap.xml');
  });

  it('defaults to the root', () => {
    expect(siteUrl()).toBe('https://levelupstore.mx/');
  });
});
