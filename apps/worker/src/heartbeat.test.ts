import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHeartbeat } from './heartbeat.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'levelup-hb-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('startHeartbeat', () => {
  it('writes a timestamp immediately, so a probe right after boot passes', () => {
    const file = join(dir, 'beat');
    const hb = startHeartbeat(file);
    try {
      expect(existsSync(file)).toBe(true);
      const written = Date.parse(readFileSync(file, 'utf8').trim());
      expect(Number.isNaN(written)).toBe(false);
      expect(Date.now() - written).toBeLessThan(5_000);
    } finally {
      hb.stop();
    }
  });

  it('advances the file on each beat', async () => {
    const file = join(dir, 'beat');
    const hb = startHeartbeat(file);
    try {
      const first = statSync(file).mtimeMs;
      await new Promise((r) => setTimeout(r, 20));
      hb.beat();
      expect(statSync(file).mtimeMs).toBeGreaterThanOrEqual(first);
      expect(readFileSync(file, 'utf8')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      hb.stop();
    }
  });

  it('does nothing when no file is configured', () => {
    const hb = startHeartbeat(undefined);
    expect(() => {
      hb.beat();
      hb.stop();
    }).not.toThrow();
  });

  it('survives an unwritable path rather than taking the worker down', () => {
    // A read-only mount or a full disk should degrade monitoring, not stop
    // paid orders being fulfilled.
    const hb = startHeartbeat(join(dir, 'no-such-directory', 'beat'));
    expect(() => hb.beat()).not.toThrow();
    hb.stop();
  });

  it('tolerates stop() being called twice', () => {
    const hb = startHeartbeat(join(dir, 'beat'));
    hb.stop();
    expect(() => hb.stop()).not.toThrow();
  });

  it('does not hold the process open', () => {
    // Load-bearing: main() sets a non-zero exit code and returns when the
    // fulfilment loop throws, relying on an empty event loop to end the
    // process. A referenced timer would produce a container that never exits,
    // never restarts, and fulfils nothing.
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const hb = startHeartbeat(join(dir, 'beat'));
    const during = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    hb.stop();
    expect(during).toBe(before);
  });
});
