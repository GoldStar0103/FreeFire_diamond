import { describe, expect, it } from 'vitest';
import { whatsappChannelUrl } from './whatsapp-channel.js';

describe('whatsappChannelUrl', () => {
  it('accepts a real channel invite, tracking parameters and all', () => {
    expect(
      whatsappChannelUrl('https://whatsapp.com/channel/0029VaABCDEFGHIJKLMN?s=sh&p=i'),
    ).toBe('https://whatsapp.com/channel/0029VaABCDEFGHIJKLMN');
  });

  it('tolerates stray whitespace and a trailing slash', () => {
    expect(whatsappChannelUrl('  https://whatsapp.com/channel/0029VaABCDEFGHIJKLMN/  ')).toBe(
      'https://whatsapp.com/channel/0029VaABCDEFGHIJKLMN',
    );
  });

  it('hides the popup when unset, rather than rendering a dead button', () => {
    expect(whatsappChannelUrl(undefined)).toBeNull();
    expect(whatsappChannelUrl('')).toBeNull();
    expect(whatsappChannelUrl('   ')).toBeNull();
  });

  it.each([
    ['javascript:alert(1)', 'a script URL'],
    ['http://whatsapp.com/channel/0029VaABCDEFGHIJKLMN', 'plain http'],
    ['https://whatsapp.com.evil.mx/channel/0029VaABCDEFGHIJKLMN', 'a lookalike host'],
    ['https://chat.whatsapp.com/0029VaABCDEFGHIJKLMN', 'the group-invite host, not the channel one'],
    ['https://whatsapp.com/channel/', 'no invite code'],
    ['https://whatsapp.com/channel/short', 'an implausibly short code'],
    ['https://whatsapp.com/channel/bad code!', 'characters an invite code cannot contain'],
    ['https://whatsapp.com/', 'no path at all'],
    ['not a url at all', 'junk'],
  ])('rejects %s (%s)', (input) => {
    // This value lands in an href on a popup shown to every visitor. A typo
    // in an env var must fail closed, not become a live link.
    expect(whatsappChannelUrl(input)).toBeNull();
  });

  it('does not care about host casing', () => {
    expect(whatsappChannelUrl('https://WhatsApp.COM/channel/0029VaABCDEFGHIJKLMN')).toBe(
      'https://whatsapp.com/channel/0029VaABCDEFGHIJKLMN',
    );
  });
});
