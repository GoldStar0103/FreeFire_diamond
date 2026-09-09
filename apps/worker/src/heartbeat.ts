/**
 * Worker liveness.
 *
 * The worker is a loop, not an HTTP service, so there is no port to probe. It
 * writes a timestamp to a file instead and the container healthcheck reads the
 * file's age. That distinguishes the two failures that matter: a process that
 * died (file stops advancing, then the container restarts) and a process that
 * is running but wedged — blocked on the advisory lock, say — which looks
 * perfectly healthy to anything that only checks whether the process exists.
 *
 * A stalled worker is not a cosmetic problem. Customers have already paid and
 * their diamonds are sitting in a queue nobody is draining.
 */

import { writeFileSync } from 'node:fs';

export interface Heartbeat {
  /** Write one beat now. */
  beat: () => void;
  /** Stop beating. Safe to call more than once. */
  stop: () => void;
}

const NOOP: Heartbeat = { beat: () => {}, stop: () => {} };

export function startHeartbeat(file: string | undefined, intervalMs = 10_000): Heartbeat {
  if (!file) return NOOP;

  const beat = () => {
    try {
      writeFileSync(file, `${new Date().toISOString()}\n`);
    } catch (err) {
      // Never take the worker down over a heartbeat. A read-only mount or a
      // full disk should degrade monitoring, not stop fulfilling paid orders.
      console.error('[worker] Could not write heartbeat:', err);
    }
  };

  beat();

  const timer = setInterval(beat, intervalMs);

  // Load-bearing. `main()` sets a non-zero exit code and returns when the
  // fulfilment loop throws, relying on an empty event loop to end the process.
  // A referenced timer would keep it alive forever: a container that never
  // exits, never restarts, and fulfils nothing — the exact zombie this file
  // exists to detect.
  timer.unref();

  return { beat, stop: () => clearInterval(timer) };
}
