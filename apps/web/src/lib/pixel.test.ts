import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPixelUserData, tiktokEvent, trackPixel, type PixelEvent } from './pixel.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tiktokEvent', () => {
  it.each<[PixelEvent, string]>([
    ['ViewContent', 'ViewContent'],
    ['InitiateCheckout', 'InitiateCheckout'],
    ['AddPaymentInfo', 'AddPaymentInfo'],
    // The one name that differs between the two vendors.
    ['Purchase', 'CompletePayment'],
  ])('maps %s to %s', (meta, tiktok) => {
    expect(tiktokEvent(meta)[0]).toBe(tiktok);
  });

  it('puts the combo in TikTok’s contents shape, priced, as the checkout sends it', () => {
    const [, params] = tiktokEvent('ViewContent', {
      value: 10,
      currency: 'MXN',
      content_ids: ['mega_10'],
      content_name: 'Mega Oferta',
      content_type: 'product',
    });

    expect(params).toEqual({
      value: 10,
      currency: 'MXN',
      content_type: 'product',
      contents: [
        {
          content_id: 'mega_10',
          content_type: 'product',
          content_name: 'Mega Oferta',
          quantity: 1,
          price: 10,
        },
      ],
    });
  });

  it('passes the order’s event id through for deduplication', () => {
    const call = tiktokEvent('Purchase', { value: 860, currency: 'MXN', content_ids: ['pack_insano'] }, 'evt-123');
    expect(call[2]).toEqual({ event_id: 'evt-123' });
  });

  it('sends no options at all when there is no event id', () => {
    // Nothing to deduplicate against, so no options object — the same as what
    // Meta is given for these events.
    expect(tiktokEvent('ViewContent', { value: 10 })).toHaveLength(2);
  });

  it('leaves out contents when the order page does not know the combo', () => {
    // live.tsx sends Purchase without content_ids when the combo is gone.
    const [, params] = tiktokEvent('Purchase', { value: 860, currency: 'MXN', content_type: 'product' });
    expect(params).toEqual({ value: 860, currency: 'MXN' });
  });

  it('does not invent a per-item price when there is more than one item', () => {
    const [, params] = tiktokEvent('InitiateCheckout', { value: 100, content_ids: ['a', 'b'] });
    expect(params.contents).toEqual([
      { content_id: 'a', content_type: 'product', quantity: 1 },
      { content_id: 'b', content_type: 'product', quantity: 1 },
    ]);
    expect(params.value).toBe(100);
  });

  it('keeps a value of zero rather than dropping it as falsy', () => {
    expect(tiktokEvent('Purchase', { value: 0, content_ids: ['x'] })[1]).toMatchObject({
      value: 0,
      contents: [{ price: 0 }],
    });
  });
});

describe('trackPixel', () => {
  const params = { value: 10, currency: 'MXN' as const, content_ids: ['mega_10'] };

  it('is a silent no-op with no window at all, as during server rendering', () => {
    expect(() => trackPixel('Purchase', params, 'evt-1')).not.toThrow();
  });

  it('is a silent no-op when neither pixel is loaded', () => {
    vi.stubGlobal('window', {});
    expect(() => trackPixel('ViewContent', params)).not.toThrow();
  });

  it('fires both pixels, each in its own vocabulary, with the same event id', () => {
    const fbq = vi.fn();
    const track = vi.fn();
    vi.stubGlobal('window', { fbq, ttq: { track, page: vi.fn() } });

    trackPixel('Purchase', params, 'evt-1');

    expect(fbq).toHaveBeenCalledWith('track', 'Purchase', params, { eventID: 'evt-1' });
    expect(track).toHaveBeenCalledWith(...tiktokEvent('Purchase', params, 'evt-1'));
    expect(track.mock.calls[0]?.[0]).toBe('CompletePayment');
    expect(track.mock.calls[0]?.[2]).toEqual({ event_id: 'evt-1' });
  });

  it('fires TikTok alone when only TikTok is configured', () => {
    const track = vi.fn();
    vi.stubGlobal('window', { ttq: { track, page: vi.fn() } });

    trackPixel('InitiateCheckout', params);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0]?.[0]).toBe('InitiateCheckout');
  });

  it('still reports to TikTok when Meta’s script throws, and the other way round', () => {
    const track = vi.fn();
    vi.stubGlobal('window', {
      fbq: () => {
        throw new Error('fbevents.js blew up');
      },
      ttq: { track, page: vi.fn() },
    });
    expect(() => trackPixel('AddPaymentInfo', params)).not.toThrow();
    expect(track).toHaveBeenCalledTimes(1);

    const fbq = vi.fn();
    vi.stubGlobal('window', {
      fbq,
      ttq: {
        track: () => {
          throw new Error('events.js blew up');
        },
        page: vi.fn(),
      },
    });
    expect(() => trackPixel('AddPaymentInfo', params)).not.toThrow();
    expect(fbq).toHaveBeenCalledTimes(1);
  });
});

describe('setPixelUserData', () => {
  it('sends the player id and a normalised phone to both pixels, in plain text — each SDK hashes it', () => {
    const fbq = vi.fn();
    const identify = vi.fn();
    vi.stubGlobal('window', { fbq, ttq: { identify, track: vi.fn(), page: vi.fn() } });

    setPixelUserData({ playerId: '123456789', whatsapp: '55 1234 5678' });

    expect(fbq).toHaveBeenCalledWith('set', 'userData', { external_id: '123456789', ph: '525512345678' });
    expect(identify).toHaveBeenCalledWith({ external_id: '123456789', phone_number: '+525512345678' });
  });

  it('sends only the player id when the phone does not come out as a plausible Mexican number', () => {
    const fbq = vi.fn();
    vi.stubGlobal('window', { fbq });

    setPixelUserData({ playerId: '123456789', whatsapp: 'abc' });

    expect(fbq).toHaveBeenCalledWith('set', 'userData', { external_id: '123456789' });
  });

  it('calls neither pixel when there is nothing usable at all', () => {
    const fbq = vi.fn();
    const identify = vi.fn();
    vi.stubGlobal('window', { fbq, ttq: { identify, track: vi.fn(), page: vi.fn() } });

    setPixelUserData({});

    expect(fbq).not.toHaveBeenCalled();
    expect(identify).not.toHaveBeenCalled();
  });

  it('is a silent no-op with no window at all, as during server rendering', () => {
    expect(() => setPixelUserData({ playerId: '123456789' })).not.toThrow();
  });

  it('still reports the phone even without a player id, and the other way round', () => {
    const fbq = vi.fn();
    vi.stubGlobal('window', { fbq });

    setPixelUserData({ whatsapp: '5512345678' });

    expect(fbq).toHaveBeenCalledWith('set', 'userData', { ph: '525512345678' });
  });
});
