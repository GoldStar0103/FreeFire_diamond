import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyNewOrder } from './telegram.js';

const ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALERT_CHAT_ID'] as const;
const saved: Record<string, string | undefined> = {};

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setEnv(token: string | undefined, chatId: string | undefined) {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = token;
  if (chatId === undefined) delete process.env.TELEGRAM_ALERT_CHAT_ID;
  else process.env.TELEGRAM_ALERT_CHAT_ID = chatId;
}

const NOTICE = { orderNumber: 'LU-260912-AB12', comboName: 'Pack Huesito', price: '$185 MXN' };

describe('notifyNewOrder', () => {
  it('posts to the configured bot and chat with the order details', async () => {
    setEnv('test-token', '12345');
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 }));

    await notifyNewOrder(NOTICE, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/bottest-token/sendMessage');
    const body = JSON.parse(init!.body as string);
    expect(body.chat_id).toBe('12345');
    expect(body.text).toContain('LU-260912-AB12');
    expect(body.text).toContain('Pack Huesito');
    expect(body.text).toContain('$185 MXN');
  });

  it('does nothing when Telegram is not configured, rather than throwing', async () => {
    setEnv(undefined, undefined);
    const fetchImpl = vi.fn();

    await expect(notifyNewOrder(NOTICE, fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows a Telegram error rather than letting it reach checkout', async () => {
    setEnv('test-token', '12345');
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(notifyNewOrder(NOTICE, fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
  });

  it('logs but does not throw when Telegram rejects the message', async () => {
    setEnv('test-token', '12345');
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 401 }));

    await expect(notifyNewOrder(NOTICE, fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
