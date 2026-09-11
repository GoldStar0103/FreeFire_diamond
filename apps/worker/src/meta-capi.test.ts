import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConversionOrder } from '@levelup/engine';
import { buildPurchaseEvent, MetaConversionsReporter, normaliseMxPhone } from './meta-capi.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

const order: ConversionOrder = {
  orderId: 'order-1',
  orderNumber: 'LU-260915-AB12',
  eventId: '6f1c0b7e-0000-4000-8000-000000000001',
  comboKey: 'pack_insano',
  priceMxnCents: 86_000,
  paidAt: new Date('2026-09-15T11:00:00Z'),
  playerId: '7288567050',
  contactEmail: null,
  contactWhatsapp: '+52 1 55 1234 5678',
  fbp: 'fb.1.1757000000000.123',
  fbc: null,
  clientIp: '189.1.2.3',
  userAgent: 'Mozilla/5.0 (iPhone)',
  attempts: 0,
};

describe('normaliseMxPhone', () => {
  it.each([
    ['55 1234 5678', '525512345678'],
    ['+52 55 1234 5678', '525512345678'],
    ['+52 1 55 1234 5678', '525512345678'], // the old mobile prefix
    ['0052-55-1234-5678', '525512345678'],
  ])('%s -> %s', (input, expected) => {
    expect(normaliseMxPhone(input)).toBe(expected);
  });

  it('refuses what cannot be a Mexican number, rather than hashing noise', () => {
    expect(normaliseMxPhone('12345')).toBeNull();
    expect(normaliseMxPhone('+1 415 555 0100')).toBeNull();
    expect(normaliseMxPhone(null)).toBeNull();
  });
});

describe('buildPurchaseEvent', () => {
  const event = buildPurchaseEvent(order, 'https://levelupstore.mx');

  it('carries the order’s own event_id so Meta dedupes it with the browser Pixel', () => {
    expect(event.event_id).toBe(order.eventId);
    expect(event.event_name).toBe('Purchase');
    expect(event.event_time).toBe(Math.floor(order.paidAt.getTime() / 1000));
  });

  it('hashes personal data and never sends the player ID in the clear', () => {
    expect(event.user_data.external_id).toEqual([sha('7288567050')]);
    expect(event.user_data.ph).toEqual([sha('525512345678')]);
    expect(event.user_data.country).toEqual([sha('mx')]);
    expect(JSON.stringify(event)).not.toContain('7288567050');
  });

  it('sends the browser identifiers unhashed, as Meta requires', () => {
    expect(event.user_data).toMatchObject({
      client_ip_address: '189.1.2.3',
      client_user_agent: 'Mozilla/5.0 (iPhone)',
      fbp: 'fb.1.1757000000000.123',
    });
    expect(event.user_data).not.toHaveProperty('fbc');
  });

  it('reports the value in pesos against the public combo key', () => {
    expect(event.custom_data).toMatchObject({
      currency: 'MXN',
      value: 860,
      content_ids: ['pack_insano'],
      order_id: 'LU-260915-AB12',
    });
    expect(event.event_source_url).toBe('https://levelupstore.mx/comprar/pack_insano');
  });
});

describe('MetaConversionsReporter', () => {
  function reporter(status: number, body: unknown, testEventCode?: string) {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;

    return {
      calls,
      reporter: new MetaConversionsReporter({
        pixelId: '1234567890123456',
        accessToken: 'EAAB-token',
        siteOrigin: 'https://levelupstore.mx',
        testEventCode,
        fetch: fetchImpl,
      }),
    };
  }

  it('posts to the pixel’s events edge', async () => {
    const { reporter: r, calls } = reporter(200, { events_received: 1 }, 'TEST123');
    expect(await r.reportPurchase(order)).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://graph.facebook.com/v23.0/1234567890123456/events');
    expect(calls[0]?.body.test_event_code).toBe('TEST123');
  });

  it('marks a bad token permanent and a Meta outage retryable', async () => {
    const bad = await reporter(400, { error: { message: 'Invalid OAuth access token' } }).reporter.reportPurchase(order);
    expect(bad).toMatchObject({ ok: false, retryable: false });
    expect(bad.ok === false && bad.message).toContain('Invalid OAuth');

    const down = await reporter(503, {}).reporter.reportPurchase(order);
    expect(down).toMatchObject({ ok: false, retryable: true });
  });

  it('refuses a pixel id that is not one', () => {
    expect(
      () => new MetaConversionsReporter({ pixelId: 'abc', accessToken: 't', siteOrigin: 'https://x.mx' }),
    ).toThrow(/numeric/);
  });
});
