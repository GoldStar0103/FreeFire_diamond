/**
 * Comprobante storage.
 *
 * Files land on the VPS disk, outside anything the web server serves directly.
 * A bank receipt shows a name, an account and an amount, so it must not be
 * fetchable by anyone who guesses a URL — the admin app reads it back through
 * an authenticated route instead.
 *
 * What gets stored on the order is the KEY, not a URL. That keeps the storage
 * backend swappable: moving to R2 later changes this file and nothing else.
 */

import 'server-only';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { comprobantePath, uploadRoot, validateUpload, type UploadRejection } from '@levelup/shared';

export type StoreResult =
  | { ok: true; key: string; byteLength: number }
  | { ok: false; rejection: UploadRejection };

/**
 * Resolve a storage key to an absolute path, refusing anything that escapes
 * the upload root.
 *
 * `comprobantePath` already sanitises its inputs, so this is belt and braces —
 * but it is the last line before a filesystem write, and the cost of being
 * wrong here is arbitrary file write.
 */
export function resolveKey(key: string): string {
  const root = uploadRoot();
  const full = resolve(join(root, normalize(key)));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Refusing to resolve a key outside the upload root: ${key}`);
  }
  return full;
}

export async function storeComprobante(
  orderNumber: string,
  bytes: Uint8Array,
): Promise<StoreResult> {
  const validation = validateUpload(bytes);
  if (!validation.ok) return { ok: false, rejection: validation.rejection };

  const key = comprobantePath(orderNumber, validation.extension, randomUUID());
  const target = resolveKey(key);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });

  return { ok: true, key, byteLength: validation.byteLength };
}
