/**
 * Tests for `scripts/load-root-env.mjs`.
 *
 * It lives in `scripts/` because both apps' next.config.mjs import it, and it
 * is tested from here because this app is one of those consumers. It runs
 * before any application code, so when it is wrong nothing else gets a chance
 * to be right.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRootEnv } from '../../../../scripts/load-root-env.mjs';

let dir: string;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'levelup-env-'));
  saved = { ...process.env };
});

afterEach(() => {
  process.env = saved;
  rmSync(dir, { recursive: true, force: true });
});

const write = (contents: string, encoding: BufferEncoding = 'utf8') => {
  const file = join(dir, '.env');
  writeFileSync(file, contents, encoding);
  return file;
};

describe('loadRootEnv', () => {
  it('parses plain assignments', () => {
    const loaded = loadRootEnv(write('FOO=bar\nBAZ=qux\n'));
    expect(loaded).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(process.env.FOO).toBe('bar');
  });

  it('strips a UTF-8 BOM instead of losing the first variable', () => {
    // Notepad and Windows PowerShell's `Set-Content -Encoding utf8` both write
    // one. Left in place it becomes part of the first key's name, so exactly
    // one variable goes missing and nothing says why.
    const loaded = loadRootEnv(write('﻿POSTGRES_USER=levelup\nFOO=bar\n'));
    expect(Object.keys(loaded)[0]).toBe('POSTGRES_USER');
    expect(process.env.POSTGRES_USER).toBe('levelup');
  });

  it('ignores comments and blank lines', () => {
    expect(loadRootEnv(write('# a comment\n\n  # indented\nFOO=bar\n'))).toEqual({ FOO: 'bar' });
  });

  it('keeps values containing = and #', () => {
    const loaded = loadRootEnv(
      write('DATABASE_URL=postgres://u:p@host:5432/db?x=1\nHASH=a#b\n'),
    );
    expect(loaded.DATABASE_URL).toBe('postgres://u:p@host:5432/db?x=1');
    expect(loaded.HASH).toBe('a#b');
  });

  it('unwraps surrounding quotes', () => {
    const loaded = loadRootEnv(write('A="spaced value"\nB=\'single\'\nC="unbalanced\n'));
    expect(loaded.A).toBe('spaced value');
    expect(loaded.B).toBe('single');
    expect(loaded.C).toBe('"unbalanced');
  });

  it('never overrides a real environment variable', () => {
    // Production has no .env at all; where both exist, the environment is the
    // deployment's actual intent and the file is a leftover.
    process.env.ALREADY = 'from-environment';
    const loaded = loadRootEnv(write('ALREADY=from-file\n'));
    expect(loaded.ALREADY).toBe('from-file');
    expect(process.env.ALREADY).toBe('from-environment');
  });

  it('tolerates CRLF, which is what a Windows editor writes', () => {
    expect(loadRootEnv(write('FOO=bar\r\nBAZ=qux\r\n'))).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('skips malformed lines rather than inventing variables', () => {
    const loaded = loadRootEnv(write('novalue\n=novalue\n9BAD=x\nGOOD=yes\n'));
    expect(loaded).toEqual({ GOOD: 'yes' });
  });

  it('returns nothing when there is no file, which is the production case', () => {
    expect(loadRootEnv(join(dir, 'does-not-exist'))).toEqual({});
  });
});
