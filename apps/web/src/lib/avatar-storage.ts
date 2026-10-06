/**
 * Customer avatar storage — same pattern as storage.ts's comprobante
 * handling, but public: an avatar is shown on the leaderboard and public
 * profiles to visitors who never logged in, so it is served back out through
 * `/media/avatars/...` rather than an authenticated route.
 */

import 'server-only';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { avatarPath, validateImageUpload, type UploadRejection } from '@levelup/shared';
import { resolveKey } from './storage.js';

export type StoreAvatarResult = { ok: true; key: string } | { ok: false; rejection: UploadRejection };

export async function storeAvatar(playerProfileId: string, bytes: Uint8Array): Promise<StoreAvatarResult> {
  const validation = validateImageUpload(bytes);
  if (!validation.ok) return { ok: false, rejection: validation.rejection };

  const key = avatarPath(playerProfileId, validation.extension, randomUUID());
  const target = resolveKey(key);

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: 'w' }); // overwrite: a re-upload replaces the previous file at a fresh key

  return { ok: true, key };
}
