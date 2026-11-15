import { describe, expect, it } from 'vitest';
import { signPayload } from '@levelup/payments';
import { verifyRocketPassWebhook } from './webhook.js';

const SECRET = 'whsec_test_rocketpass';
const NOW_MS = 1_760_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

const orderPayload = {
  id: 'evt_9a1c4f',
  type: 'order.delivered',
  created_at: '2026-09-23T14:05:19',
  data: {
    order: {
      order_id: 'ORD-7K2M9XQ4P1',
      status: 'DELIVERED',
      item: 'crate',
      item_name: 'Universal Evo Token Crate',
      quantity: 1,
      delivered: 1,
      target_uid: '7288567050',
      target_nickname: null,
      region: 'SAC',
      unit_price_ars: 400,
      total_ars: 400,
      refunded_ars: 0,
      charged_ars: 400,
      reference: 'LU-260101-AAAA',
      test: false,
      created_at: '2026-09-23T14:05:19',
      completed_at: '2026-09-23T14:05:19',
    },
  },
};

describe('verifyRocketPassWebhook', () => {
  it('verifies a correctly signed delivery and maps the order', () => {
    const rawBody = JSON.stringify(orderPayload);
    const header = signPayload(rawBody, SECRET, NOW_S);

    const result = verifyRocketPassWebhook(rawBody, header, SECRET, () => NOW_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.event).toMatchObject({
      id: 'evt_9a1c4f',
      type: 'order.delivered',
      data: { order: { orderId: 'ORD-7K2M9XQ4P1', status: 'DELIVERED', reference: 'LU-260101-AAAA' } },
    });
  });

  it('rejects a bad signature', () => {
    const rawBody = JSON.stringify(orderPayload);
    const result = verifyRocketPassWebhook(rawBody, 't=' + NOW_S + ',v1=deadbeef', SECRET, () => NOW_MS);
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a missing signature header', () => {
    const result = verifyRocketPassWebhook(JSON.stringify(orderPayload), undefined, SECRET, () => NOW_MS);
    expect(result).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('rejects a stale timestamp', () => {
    const rawBody = JSON.stringify(orderPayload);
    const header = signPayload(rawBody, SECRET, NOW_S - 301);
    const result = verifyRocketPassWebhook(rawBody, header, SECRET, () => NOW_MS);
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a body that is not valid JSON, even with a correct signature', () => {
    const rawBody = 'not json';
    const header = signPayload(rawBody, SECRET, NOW_S);
    const result = verifyRocketPassWebhook(rawBody, header, SECRET, () => NOW_MS);
    expect(result).toEqual({ ok: false, reason: 'malformed_payload' });
  });

  it('parses a contract event with no order', () => {
    const payload = {
      id: 'evt_contract_1',
      type: 'contract.expiring',
      created_at: '2026-09-23T14:05:19',
      data: { contract: { expires_at: '2026-10-01T00:00:00', days_left: 7, renewal_price_usdt: 25 } },
    };
    const rawBody = JSON.stringify(payload);
    const header = signPayload(rawBody, SECRET, NOW_S);

    const result = verifyRocketPassWebhook(rawBody, header, SECRET, () => NOW_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.event.data.order).toBeUndefined();
    expect(result.event.data.contract).toEqual({
      expiresAt: '2026-10-01T00:00:00',
      daysLeft: 7,
      renewalPriceUsdt: 25,
    });
  });

  it('parses a balance.low event', () => {
    const payload = {
      id: 'evt_balance_1',
      type: 'balance.low',
      created_at: '2026-09-23T14:05:19',
      data: { balance: { balance_ars: 500, threshold_ars: 1000 } },
    };
    const rawBody = JSON.stringify(payload);
    const header = signPayload(rawBody, SECRET, NOW_S);

    const result = verifyRocketPassWebhook(rawBody, header, SECRET, () => NOW_MS);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.event.data.balance).toEqual({ balanceArs: 500, thresholdArs: 1000 });
  });
});
