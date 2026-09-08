#!/usr/bin/env node
/**
 * Local Postgres for integration tests.
 *
 * Uses the binaries shipped by the `embedded-postgres` npm package, so there is
 * no Docker, no winget and no system-wide install to arrange.
 *
 * Two Windows quirks this works around, both discovered the hard way:
 *
 *   1. `postgres.exe` refuses to run under an account with administrative
 *      privileges. `pg_ctl` exists precisely to drop those privileges and
 *      relaunch in a restricted token, so everything goes through pg_ctl.
 *
 *   2. `pg_ctl start` leaves the daemon holding stdout, so a parent that waits
 *      on the pipe hangs forever even though the server came up fine. The child
 *      is spawned detached with stdio ignored.
 *
 *   node scripts/pg.mjs start | stop | status
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, '.pgdata');
const LOG_FILE = join(DATA_DIR, 'postgres.log');
const PORT = Number(process.env.TEST_PG_PORT ?? 54329);
const USER = 'levelup';

/** pnpm keeps the platform package under .pnpm, so resolve by walking. */
function findBinDir() {
  const roots = [join(ROOT, 'node_modules', '.pnpm'), join(ROOT, 'node_modules')];
  const wanted = process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';

  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      if (!entry.includes('embedded-postgres')) continue;
      const candidate = join(
        root,
        entry,
        entry.startsWith('@') ? '' : 'node_modules',
        '@embedded-postgres',
        `${process.platform === 'win32' ? 'windows' : process.platform}-x64`,
        'native',
        'bin',
      );
      if (existsSync(join(candidate, wanted))) return candidate;
    }
  }
  throw new Error(
    'Postgres binaries not found. Run: pnpm --filter @levelup/db add -D embedded-postgres',
  );
}

const bin = (name) =>
  join(findBinDir(), process.platform === 'win32' ? `${name}.exe` : name);

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 1000 });
    socket.on('connect', () => (socket.destroy(), resolve(true)));
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => (socket.destroy(), resolve(false)));
  });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${command} exited ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

async function start() {
  if (await isListening(PORT)) {
    console.log(`Postgres already listening on ${PORT}`);
    return;
  }

  const initialised = existsSync(join(DATA_DIR, 'PG_VERSION'));
  if (!initialised) {
    mkdirSync(DATA_DIR, { recursive: true });
    console.log(`Initialising cluster in ${DATA_DIR}`);
    // trust auth: this cluster is local, disposable and test-only.
    run(bin('initdb'), [
      '-D',
      DATA_DIR,
      '-U',
      USER,
      '--auth-local=trust',
      '--auth-host=trust',
      '--encoding=UTF8',
    ]);
  }

  console.log(`Starting Postgres on ${PORT}`);
  const child = spawn(bin('pg_ctl'), ['-D', DATA_DIR, '-o', `-p ${PORT}`, '-l', LOG_FILE, 'start'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 60; i++) {
    if (await isListening(PORT)) {
      console.log(`Ready: postgres://${USER}@127.0.0.1:${PORT}`);
      console.log(`Logs:  ${LOG_FILE}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  throw new Error(`Postgres did not accept connections within 30s. See ${LOG_FILE}`);
}

async function stop() {
  if (!existsSync(join(DATA_DIR, 'PG_VERSION'))) {
    console.log('No cluster to stop');
    return;
  }
  try {
    run(bin('pg_ctl'), ['-D', DATA_DIR, '-m', 'fast', 'stop']);
    console.log('Stopped');
  } catch (err) {
    // Already down is not a failure worth a non-zero exit.
    console.log(`Not running (${String(err).split('\n')[0]})`);
  }
}

async function status() {
  const up = await isListening(PORT);
  console.log(`Port ${PORT}: ${up ? 'listening' : 'closed'}`);
  if (existsSync(DATA_DIR)) {
    console.log(`Data dir: ${DATA_DIR} (${statSync(DATA_DIR).isDirectory() ? 'present' : '?'})`);
  }
  process.exitCode = up ? 0 : 1;
}

const command = process.argv[2] ?? 'status';
const actions = { start, stop, status };

if (!actions[command]) {
  console.error(`Usage: node scripts/pg.mjs start|stop|status`);
  process.exitCode = 1;
} else {
  actions[command]().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
