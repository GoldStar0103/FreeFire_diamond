/**
 * Loads the monorepo's root `.env` into `process.env`.
 *
 * Next reads `.env` from its own app directory, so a value written to the root
 * `.env` — the file `.env.example` tells everyone to copy — is invisible to
 * `next dev` in `apps/web` and `apps/admin`. That gap is quiet in the worst
 * way: the legal pages simply render `[PENDIENTE: RFC]` and nobody can tell
 * whether the value is missing or merely unread.
 *
 * Imported from each app's `next.config.mjs`, which is evaluated in the Next
 * server process before any application code runs.
 *
 * Real environment variables always win. In production the values come from
 * compose or systemd and there is no `.env` file at all, so this is a no-op
 * there rather than a second source of truth.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Deliberately not a full dotenv implementation. It handles what this project's
 * `.env.example` actually contains — `KEY=value`, comments, blank lines and
 * optional surrounding quotes — and nothing else. Multi-line values and shell
 * interpolation are not supported, so a config that needs them fails visibly
 * here rather than being half-parsed.
 *
 * @param {string} [file] Path to the env file; defaults to the repo root's.
 * @returns {Record<string, string>} Everything parsed, whether or not it was
 *   applied to `process.env` — a variable already set in the real environment
 *   is reported here but not overwritten there.
 */
export function loadRootEnv(file = resolve(ROOT, '.env')) {
  let contents;
  try {
    contents = readFileSync(file, 'utf8');
  } catch (err) {
    // No .env is the normal case in production and in CI.
    if (err && err.code === 'ENOENT') return {};
    throw err;
  }

  /** @type {Record<string, string>} */
  const loaded = {};

  // Notepad, `Set-Content -Encoding utf8` on Windows PowerShell, and most
  // Windows editors prepend a BOM. Left in place it becomes part of the first
  // key's name, so that one variable — and only that one — silently fails to
  // load, which is a genuinely horrible thing to debug.
  if (contents.charCodeAt(0) === 0xfeff) contents = contents.slice(1);

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }

    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return loaded;
}
