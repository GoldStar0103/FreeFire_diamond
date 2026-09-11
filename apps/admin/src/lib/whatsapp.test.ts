import { describe, expect, it } from 'vitest';
import { orderWhatsappMessage, waNumber, waUrl } from './whatsapp.js';

describe('waNumber', () => {
  it('accepts a plain digit-only number', () => {
    expect(waNumber('5212345678')).toBe('5212345678');
  });

  it('strips the punctuation people write phone numbers with', () => {
    expect(waNumber('+52 (123) 456-78-90')).toBe('521234567890');
  });

  it('keeps a leading 52 as-is — it is not stripped or assumed missing', () => {
    expect(waNumber('521234567890')).toBe('521234567890');
    expect(waNumber('1234567890')).toBe('1234567890');
  });

  it.each([null, undefined, '', '   ', '+', 'abc', '1234567'])('rejects %p', (value) => {
    // Anything under eight digits is a typo, not a phone number — a 3-digit
    // string like the customer typing "abc" or "123" must never produce a link.
    expect(waNumber(value)).toBeNull();
  });

  it('rejects an implausibly long number', () => {
    expect(waNumber('1234567890123456789')).toBeNull();
  });
});

describe('waUrl', () => {
  it('builds a wa.me link with no message', () => {
    expect(waUrl('5212345678')).toBe('https://wa.me/5212345678');
  });

  it('attaches an encoded message', () => {
    expect(waUrl('5212345678', 'Hola, pedido LU-1.')).toBe(
      'https://wa.me/5212345678?text=Hola%2C%20pedido%20LU-1.',
    );
  });

  it('returns null for an unusable number, so the caller can render nothing', () => {
    // The bug this replaces: a broken `https://wa.me/` link with no number.
    expect(waUrl(undefined, 'cualquier cosa')).toBeNull();
    expect(waUrl('', 'cualquier cosa')).toBeNull();
    expect(waUrl('abc', 'cualquier cosa')).toBeNull();
    expect(waUrl('123', 'cualquier cosa')).toBeNull();
  });
});

describe('orderWhatsappMessage', () => {
  it('builds a general opener with the order number', () => {
    const message = orderWhatsappMessage({ orderNumber: 'LU-1042' }, 'general');
    expect(message).toContain('LU-1042');
    expect(message.length).toBeGreaterThan(10);
  });

  it('mentions the combo when available', () => {
    const message = orderWhatsappMessage(
      { orderNumber: 'LU-1042', comboName: 'Pack Insano', advertisedDiamonds: 7200 },
      'general',
    );
    expect(message).toContain('LU-1042');
    expect(message).toContain('Pack Insano');
    expect(message).toContain('7200');
  });

  it('builds a mismatch opener that names the amount problem', () => {
    const message = orderWhatsappMessage({ orderNumber: 'LU-2001' }, 'mismatch');
    expect(message).toContain('LU-2001');
    expect(message.toLowerCase()).toContain('monto');
  });

  it('includes both amounts in the mismatch opener when given', () => {
    const message = orderWhatsappMessage({ orderNumber: 'LU-2001' }, 'mismatch', {
      receivedMxn: '$800.00',
      expectedMxn: '$860.00',
    });
    expect(message).toContain('$800.00');
    expect(message).toContain('$860.00');
  });
});
