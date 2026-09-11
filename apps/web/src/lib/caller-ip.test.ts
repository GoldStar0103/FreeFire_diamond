import { describe, expect, it } from 'vitest';
import { pickCallerIp, type HeaderLike } from './caller-ip.js';

const headers = (values: Record<string, string | undefined>): HeaderLike => ({
  get: (name) => values[name.toLowerCase()] ?? null,
});

describe('pickCallerIp', () => {
  it('uses X-Real-IP — the header Caddy actually overwrites', () => {
    expect(pickCallerIp(headers({ 'x-real-ip': '189.1.2.3' }))).toBe('189.1.2.3');
  });

  it('prefers X-Real-IP over X-Forwarded-For when both are present', () => {
    expect(
      pickCallerIp(headers({ 'x-real-ip': '189.1.2.3', 'x-forwarded-for': '6.6.6.6' })),
    ).toBe('189.1.2.3');
  });

  // The bug this guards against: a client sending a fresh X-Forwarded-For on
  // every request used to get a fresh rate-limit bucket every time, because
  // that header was read first and Caddy does not overwrite it (by default it
  // appends to whatever the client already sent).
  it('does not let a spoofed X-Forwarded-For override the real address', () => {
    expect(
      pickCallerIp(headers({ 'x-real-ip': '189.1.2.3', 'x-forwarded-for': '1.1.1.1, 189.1.2.3' })),
    ).toBe('189.1.2.3');
  });

  it('falls back to X-Forwarded-For only when X-Real-IP is absent (local dev without Caddy)', () => {
    expect(pickCallerIp(headers({ 'x-forwarded-for': '10.0.0.5, 189.1.2.3' }))).toBe('10.0.0.5');
  });

  it('returns "unknown" rather than throwing when neither header is present', () => {
    expect(pickCallerIp(headers({}))).toBe('unknown');
  });

  it('treats a blank X-Real-IP the same as a missing one', () => {
    expect(pickCallerIp(headers({ 'x-real-ip': '  ', 'x-forwarded-for': '10.0.0.5' }))).toBe(
      '10.0.0.5',
    );
  });
});
