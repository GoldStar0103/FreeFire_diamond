import { describe, expect, it } from 'vitest';
import { vipGroupUrl } from './vip.js';

describe('vipGroupUrl', () => {
  it('accepts the invite the client sent, tracking parameters and all', () => {
    // Copied straight out of WhatsApp, which appends how it was shared.
    expect(
      vipGroupUrl('https://chat.whatsapp.com/G36Z7hKEOVSJ4PYoT39lXR?s=sh&p=i&mlu=4&ilr=4'),
    ).toBe('https://chat.whatsapp.com/G36Z7hKEOVSJ4PYoT39lXR');
  });

  it('accepts a bare invite and tolerates stray whitespace and slashes', () => {
    expect(vipGroupUrl('  https://chat.whatsapp.com/G36Z7hKEOVSJ4PYoT39lXR/  ')).toBe(
      'https://chat.whatsapp.com/G36Z7hKEOVSJ4PYoT39lXR',
    );
  });

  it('hides the block when unset, rather than rendering a dead button', () => {
    expect(vipGroupUrl(undefined)).toBeNull();
    expect(vipGroupUrl('')).toBeNull();
    expect(vipGroupUrl('   ')).toBeNull();
  });

  it.each([
    ['javascript:alert(1)', 'a script URL'],
    ['http://chat.whatsapp.com/G36Z7hKEOVSJ4PYoT39lXR', 'plain http'],
    ['https://chat.whatsapp.com.evil.mx/G36Z7hKEOVSJ4PYoT39lXR', 'a lookalike host'],
    ['https://chat.whatsapp.com/', 'no invite code'],
    ['https://chat.whatsapp.com/short', 'an implausibly short code'],
    ['https://chat.whatsapp.com/bad code!', 'characters an invite code cannot contain'],
    ['not a url at all', 'junk'],
  ])('rejects %s (%s)', (input) => {
    // This value lands in an href on a page customers open from WhatsApp. A
    // typo in an env var must fail closed, not become a live link.
    expect(vipGroupUrl(input)).toBeNull();
  });

  it('does not care about host casing', () => {
    expect(vipGroupUrl('https://CHAT.WhatsApp.COM/G36Z7hKEOVSJ4PYoT39lXR')).toBe(
      'https://chat.whatsapp.com/G36Z7hKEOVSJ4PYoT39lXR',
    );
  });
});
