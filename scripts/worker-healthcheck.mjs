/**
 * Container healthcheck for the fulfilment worker.
 *
 * Exits 0 if the heartbeat file was written recently, 1 otherwise. Docker
 * restarts the container after the configured number of consecutive failures.
 *
 *   node scripts/worker-healthcheck.mjs
 *
 * Reads WORKER_HEARTBEAT_FILE and WORKER_HEARTBEAT_MAX_AGE_MS (default 60s,
 * six times the write interval — long enough that a slow provider call or a
 * busy sweep never trips it, short enough that a wedged worker is caught
 * before a customer notices).
 */

import { statSync } from 'node:fs';

const file = process.env.WORKER_HEARTBEAT_FILE;
const maxAgeMs = Number(process.env.WORKER_HEARTBEAT_MAX_AGE_MS ?? 60_000);

if (!file) {
  // Configured without a heartbeat: nothing to assert, so do not claim the
  // worker is unhealthy. A misconfigured probe that restarts a working worker
  // mid-combo is worse than no probe.
  console.log('WORKER_HEARTBEAT_FILE is not set; skipping the check');
  process.exit(0);
}

let stats;
try {
  stats = statSync(file);
} catch {
  console.error(`No heartbeat at ${file}`);
  process.exit(1);
}

const ageMs = Date.now() - stats.mtimeMs;

if (ageMs > maxAgeMs) {
  console.error(`Heartbeat is ${Math.round(ageMs / 1000)}s old (limit ${maxAgeMs / 1000}s)`);
  process.exit(1);
}

console.log(`Heartbeat ${Math.round(ageMs / 1000)}s old`);
process.exit(0);
