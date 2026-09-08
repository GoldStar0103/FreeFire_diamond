import { describe, expect, it } from 'vitest';
import { contentTypeForKey, safeStorageKey } from './paths.js';

describe('safeStorageKey', () => {
  it('accepts a key we generated', () => {
    expect(safeStorageKey('comprobantes/LU-260915-AB12/abc123.jpg')).toEqual({
      ok: true,
      relative: 'comprobantes/LU-260915-AB12/abc123.jpg',
    });
  });

  it.each([
    ['posix traversal', '../../etc/passwd'],
    ['nested traversal', 'comprobantes/../../etc/passwd'],
    ['windows traversal', '..\\..\\windows\\system32\\config\\sam'],
    ['mixed separators', 'comprobantes\\..\\..\\secret'],
    ['trailing traversal', 'comprobantes/..'],
    ['hidden by dot segments', 'comprobantes/./../../etc/passwd'],
  ])('rejects %s', (_label, key) => {
    expect(safeStorageKey(key).ok).toBe(false);
  });

  it.each([
    ['absolute posix', '/etc/shadow'],
    ['absolute windows', 'C:/Windows/System32/config/sam'],
    ['lowercase drive', 'c:\\windows\\win.ini'],
  ])('rejects %s', (_label, key) => {
    expect(safeStorageKey(key).ok).toBe(false);
  });

  it('rejects a null byte, which can truncate a path in some APIs', () => {
    expect(safeStorageKey('comprobantes/a.jpg\0.php').ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['only separators', '///'],
    ['only dot segments', './././'],
  ])('rejects %s', (_label, key) => {
    expect(safeStorageKey(key).ok).toBe(false);
  });

  it('rejects an absurdly long key', () => {
    expect(safeStorageKey('a/'.repeat(400)).ok).toBe(false);
  });

  it('collapses redundant separators rather than rejecting outright', () => {
    expect(safeStorageKey('comprobantes//LU-1///x.jpg')).toEqual({
      ok: true,
      relative: 'comprobantes/LU-1/x.jpg',
    });
  });

  it('normalises windows separators on a key written by another platform', () => {
    // Keys are stored with forward slashes, but be tolerant reading them back.
    expect(safeStorageKey('comprobantes\\LU-1\\x.jpg')).toEqual({
      ok: true,
      relative: 'comprobantes/LU-1/x.jpg',
    });
  });
});

describe('contentTypeForKey', () => {
  it.each([
    ['comprobantes/a/b.jpg', 'image/jpeg'],
    ['comprobantes/a/b.jpeg', 'image/jpeg'],
    ['comprobantes/a/b.PNG', 'image/png'],
    ['comprobantes/a/b.webp', 'image/webp'],
    ['comprobantes/a/b.pdf', 'application/pdf'],
  ])('maps %s', (key, expected) => {
    expect(contentTypeForKey(key)).toBe(expected);
  });

  it.each([
    ['comprobantes/a/b.php'],
    ['comprobantes/a/b.html'],
    ['comprobantes/a/b.svg'],
    ['comprobantes/a/b'],
  ])('refuses to serve %s', (key) => {
    // An allowlist: anything we did not write ourselves is not served, so a
    // stray file in the upload directory cannot be turned into stored XSS.
    expect(contentTypeForKey(key)).toBeNull();
  });
});
