import { describe, expect, it } from 'vitest';
import { diamonds, initials, mxn } from './format.js';

describe('mxn', () => {
  it('formats whole pesos with an explicit currency label', () => {
    expect(mxn(18_500)).toBe('$185 MXN');
  });

  it('groups thousands the way es-MX does', () => {
    expect(mxn(4_928_000)).toBe('$49,280 MXN');
  });
});

describe('diamonds', () => {
  it('groups thousands', () => {
    expect(diamonds(48800)).toBe('48,800');
  });
});

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Carlos MTZ')).toBe('CM');
  });

  it('uppercases regardless of input casing', () => {
    expect(initials('fernanda gg')).toBe('FG');
  });

  it('falls back to one letter for a single name', () => {
    expect(initials('Ana')).toBe('A');
  });

  it('ignores extra whitespace between words', () => {
    expect(initials('  Luis   Fire  ')).toBe('LF');
  });

  it('never shows more than two letters for a long name', () => {
    expect(initials('José Manuel Ramírez Mojica')).toBe('JM');
  });

  it('falls back to a placeholder for an empty name', () => {
    expect(initials('   ')).toBe('?');
  });
});
