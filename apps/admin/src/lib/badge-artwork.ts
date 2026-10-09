/**
 * Badge artwork upload — the same shape as flyers.ts, under its own prefix.
 *
 * Public, like a flyer: a badge is shown on the leaderboard and on public
 * player profiles to visitors who never logged in, so the storefront serves
 * it from `/media/badges/...`. Images only; a PDF badge is meaningless.
 */

import 'server-only';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { badgeArtworkPath, safeStorageKey, uploadRoot, validateImageUpload, type UploadRejection } from '@levelup/shared';

export type BadgeArtworkResult =
  | { ok: true; key: string }
  | { ok: false; rejection: UploadRejection };

export async function storeBadgeArtwork(
  badgeKey: string,
  bytes: Uint8Array,
): Promise<BadgeArtworkResult> {
  const validation = validateImageUpload(bytes);
  if (!validation.ok) return { ok: false, rejection: validation.rejection };

  const key = badgeArtworkPath(badgeKey, validation.extension, randomUUID());

  const checked = safeStorageKey(key);
  if (!checked.ok) throw new Error(`Refusing to store badge artwork: ${checked.reason}`);

  const rootPath = uploadRoot();
  const target = resolve(join(rootPath, checked.relative));
  if (!target.startsWith(rootPath + sep)) {
    throw new Error('Refusing to store badge artwork outside the upload root');
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'wx' });

  return { ok: true, key };
}
