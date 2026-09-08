/**
 * Worker configuration.
 *
 * Validated once at boot and then trusted. A fulfilment worker that starts with
 * a missing provider key and discovers it on the first paid order is far worse
 * than one that refuses to start at all.
 */

export interface WorkerConfig {
  databaseUrl: string;
  provider: {
    baseUrl: string;
    apiKey: string;
    lowBalanceUsd: number;
    interCallDelayMs: number;
  };
  fulfillment: {
    maxAttempts: number;
    /** An order left `processing` longer than this is treated as abandoned. */
    staleOrderMs: number;
    /** Pause between polls when the queue is empty. */
    idlePollMs: number;
  };
  sweeps: {
    minAgeMs: number;
    escalateAfterMs: number;
    intervalMs: number;
    batchSize: number;
  };
  telegram: { botToken: string; chatId: string } | null;
  /** Runs against the simulator instead of the real provider. Never in production. */
  dryRun: boolean;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  return parsed;
}

export function loadConfig(): WorkerConfig {
  const dryRun = process.env.WORKER_DRY_RUN === 'true';

  const telegram =
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALERT_CHAT_ID
      ? { botToken: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_ALERT_CHAT_ID }
      : null;

  if (!telegram && !dryRun) {
    // Alerts are how a human learns an order needs review. Running without
    // them means failures are silent, which defeats the whole design.
    throw new Error(
      'TELEGRAM_BOT_TOKEN and TELEGRAM_ALERT_CHAT_ID are required. ' +
        'Set WORKER_DRY_RUN=true only for local runs.',
    );
  }

  return {
    databaseUrl: required('DATABASE_URL'),
    provider: {
      baseUrl: process.env.RA_BASE_URL ?? 'https://panel.recargasamerica.com/api/v1',
      apiKey: dryRun ? (process.env.RA_API_KEY ?? 'dry-run') : required('RA_API_KEY'),
      lowBalanceUsd: number('RA_LOW_BALANCE_USD', 100),
      interCallDelayMs: number('RA_INTER_CALL_DELAY_MS', 1500),
    },
    fulfillment: {
      maxAttempts: number('FULFILLMENT_MAX_ATTEMPTS', 3),
      staleOrderMs: number('FULFILLMENT_STALE_ORDER_MS', 5 * 60_000),
      idlePollMs: number('FULFILLMENT_IDLE_POLL_MS', 2_000),
    },
    sweeps: {
      minAgeMs: number('SWEEP_MIN_AGE_MS', 30_000),
      escalateAfterMs: number('SWEEP_ESCALATE_AFTER_MS', 15 * 60_000),
      intervalMs: number('SWEEP_INTERVAL_MS', 30_000),
      batchSize: number('SWEEP_BATCH_SIZE', 25),
    },
    telegram,
    dryRun,
  };
}
