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
  catalogSync: {
    /**
     * How often the worker re-reads the provider catalog, and once at startup.
     * `0` switches both off — for freezing the catalog during an incident.
     */
    intervalMs: number;
  };
  telegram: { botToken: string; chatId: string } | null;
  /**
   * Server-side purchase reporting to Meta. Null unless both the pixel id and
   * the Conversions API token are set — the browser Pixel alone needs neither
   * the worker nor this.
   */
  meta: {
    pixelId: string;
    accessToken: string;
    testEventCode: string | undefined;
    siteOrigin: string;
  } | null;
  /**
   * File touched periodically so a container healthcheck can tell a wedged
   * worker from a working one. Unset outside containers.
   */
  heartbeatFile: string | undefined;
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

function loadMeta(): WorkerConfig['meta'] {
  const pixelId = process.env.META_PIXEL_ID?.trim();
  const accessToken = process.env.META_CAPI_ACCESS_TOKEN?.trim();
  if (!pixelId || !accessToken) return null;

  if (!/^\d{8,20}$/.test(pixelId)) {
    // Refuse to start rather than fail every report quietly for a week.
    throw new Error(`META_PIXEL_ID must be the numeric pixel id, got ${JSON.stringify(pixelId)}`);
  }

  // Bare hostname in the env file, as for the legal pages; Meta wants a URL.
  const domain = (process.env.PUBLIC_DOMAIN?.trim() || 'levelupstore.mx')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');

  return {
    pixelId,
    accessToken,
    testEventCode: process.env.META_CAPI_TEST_EVENT_CODE?.trim() || undefined,
    siteOrigin: `https://${domain}`,
  };
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

  // Hourly by default. The provider changes ids and prices without notice, and
  // before this ran on its own nobody learnt of a change until customers did.
  const catalogSyncIntervalMs = number('CATALOG_SYNC_INTERVAL_MS', 60 * 60_000);
  if (catalogSyncIntervalMs < 0) {
    throw new Error(
      `CATALOG_SYNC_INTERVAL_MS must be 0 (off) or a positive number, got ${catalogSyncIntervalMs}`,
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
    catalogSync: { intervalMs: catalogSyncIntervalMs },
    telegram,
    meta: loadMeta(),
    heartbeatFile: process.env.WORKER_HEARTBEAT_FILE?.trim() || undefined,
    dryRun,
  };
}
