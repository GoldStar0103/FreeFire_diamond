import { describe, expect, it } from 'vitest';
import { buildEmailSender, ConsoleEmailSender, SmtpEmailSender } from './email-sender.js';

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
