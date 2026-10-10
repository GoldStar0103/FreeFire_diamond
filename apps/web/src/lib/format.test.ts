import { describe, expect, it } from 'vitest';
import { dateLabel, diamonds, initials, mxn } from './format.js';

describe('mxn', () => {
  it('formats whole pesos with an explicit currency label', () => {
    expect(mxn(18_500)).toBe('$185 MXN');
  });

  it('groups thousands the way es-MX does', () => {
    expect(mxn(4_928_000)).toBe('$49,280 MXN');
  });
});

describe('dateLabel', () => {
  it('formats a plain daytime UTC instant as the matching Mexico City day', () => {
    // 2026-09-30T18:00:00Z = noon Mexico City (UTC-6) the same day — the
    // boring case, included so a regression can't "fix" this one by
    // accident while breaking the one below.
    expect(dateLabel(new Date('2026-09-30T18:00:00Z'))).toBe('30 sep 2026');
  });

  it('does not show the UTC day for an instant that is still the previous evening in Mexico City', () => {
    // 2026-09-30T02:00:00Z = 2026-09-29T20:00 Mexico City. Production runs
    // with no TZ pin (confirmed UTC), so formatting this without an explicit
    // timeZone would show "30 sept" to a customer for whom it was still the
    // 29th — exactly the bug this function exists to prevent.
    expect(dateLabel(new Date('2026-09-30T02:00:00Z'))).toBe('29 sep 2026');
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
