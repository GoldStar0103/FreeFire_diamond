import { describe, expect, it } from 'vitest';
import {
  buildEmailSender,
  ConsoleEmailSender,
  SmtpEmailSender,
  smtpEnvelopeAddress,
  smtpFromHeader,
} from './email-sender.js';

describe('buildEmailSender', () => {
  it('falls back to the console sender when SMTP is unset outside production', () => {
    const sender = buildEmailSender({ NODE_ENV: 'test' });
    expect(sender).toBeInstanceOf(ConsoleEmailSender);
  });

  it('throws in production when SMTP is missing', () => {
    expect(() => buildEmailSender({ NODE_ENV: 'production' })).toThrow(/SMTP_HOST/);
  });

  it('builds an SMTP sender when the mailbox is configured', () => {
    const sender = buildEmailSender({
      NODE_ENV: 'production',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'noreply@levelupstore.mx',
      SMTP_PASS: 'secret',
      SMTP_FROM: 'LevelUp <noreply@levelupstore.mx>',
    });
    expect(sender).toBeInstanceOf(SmtpEmailSender);
  });
});

describe('smtpEnvelopeAddress', () => {
  it('keeps a bare mailbox', () => {
    expect(smtpEnvelopeAddress('noreply@levelupstore.mx')).toBe('noreply@levelupstore.mx');
  });

  it('pulls the mailbox out of a display-name From', () => {
    expect(smtpEnvelopeAddress('LevelUp <noreply@levelupstore.mx>')).toBe('noreply@levelupstore.mx');
  });

  it('rejects junk so MAIL FROM cannot be sent as <LevelUp <addr>>', () => {
    expect(() => smtpEnvelopeAddress('not-an-email')).toThrow(/not a mailbox/);
  });
});

describe('smtpFromHeader', () => {
  it('wraps a bare mailbox', () => {
    expect(smtpFromHeader('noreply@levelupstore.mx')).toBe('LevelUp Store <noreply@levelupstore.mx>');
  });

  it('leaves a display-name From alone', () => {
    expect(smtpFromHeader('LevelUp <noreply@levelupstore.mx>')).toBe('LevelUp <noreply@levelupstore.mx>');
  });
});
