/**
 * Flyer storage.
 *
 * Unlike comprobantes, flyers are public — they are the brand, and the same
 * images go out on social every month. They still go through the same magic-byte
 * validation, because the upload form is reachable by anyone who gets a session
 * and the bytes end up on disk either way.
 *
 * Stored under the shared UPLOAD_DIR and served by the storefront, so the two
 * apps need the same volume mounted.
 */

import 'server-only';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { safeStorageKey, uploadRoot, validateUpload, type UploadRejection } from '@levelup/shared';

export type FlyerResult =
  | { ok: true; key: string }
  | { ok: false; rejection: UploadRejection };

export async function storeFlyer(campaignKey: string, bytes: Uint8Array): Promise<FlyerResult> {
  const validation = validateUpload(bytes);
  if (!validation.ok) return { ok: false, rejection: validation.rejection };

  if (validation.kind === 'pdf') {
    return {
      ok: false,
      rejection: { code: 'UNSUPPORTED_TYPE', message: 'El flyer debe ser una imagen, no un PDF.' },
    };
  }

  // Built from values we control; the campaign key is sanitised anyway.
  const safeCampaign = campaignKey.replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'promo';
  const key = `flyers/${safeCampaign}/${randomUUID()}.${validation.extension}`;

  const checked = safeStorageKey(key);
  if (!checked.ok) throw new Error(`Refusing to store flyer: ${checked.reason}`);

  const rootPath = uploadRoot();
  const target = resolve(join(rootPath, checked.relative));
  if (!target.startsWith(rootPath + sep)) {
    throw new Error('Refusing to store a flyer outside the upload root');
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });

  return { ok: true, key };
}
