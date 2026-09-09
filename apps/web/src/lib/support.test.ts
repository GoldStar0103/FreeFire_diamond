import { describe, expect, it } from 'vitest';
import { supportNumber, supportUrl } from './support.js';

describe('supportNumber', () => {
  it('accepts the configured number', () => {
    expect(supportNumber('522206161171')).toBe('522206161171');
  });

  it('strips the punctuation people write phone numbers with', () => {
    expect(supportNumber('+52 (220) 616-11-71')).toBe('522206161171');
  });

  it.each([undefined, '', '   ', '+', 'abc', '12345'])('rejects %p', (value) => {
    // Anything under eight digits is a misconfiguration, not a phone number.
    expect(supportNumber(value)).toBeNull();
  });

  it('rejects an implausibly long number', () => {
    expect(supportNumber('1234567890123456789')).toBeNull();
  });
});

describe('supportUrl', () => {
  it('builds a wa.me link', () => {
    expect(supportUrl(undefined, '522206161171')).toBe('https://wa.me/522206161171');
  });

  it('attaches an encoded message', () => {
    expect(supportUrl('Hola, pedido LU-1 (ID 123).', '522206161171')).toBe(
      'https://wa.me/522206161171?text=Hola%2C%20pedido%20LU-1%20(ID%20123).',
    );
  });

  it('returns null when unconfigured, so the caller can hide the link', () => {
    // The bug this replaces: `https://wa.me/${x ?? ''}` renders a link to
    // `https://wa.me/`, which opens a WhatsApp error page. On a failed order
    // that is the one button a customer is offered.
    expect(supportUrl('cualquier cosa', undefined)).toBeNull();
    expect(supportUrl('cualquier cosa', '')).toBeNull();
  });
});
