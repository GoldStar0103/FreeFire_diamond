'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { setFeaturedBadges, updateAvatar, updateDisplayName } from '@levelup/db';
import { getDb } from '../../lib/server.js';
import { requireCustomerSession, clearCustomerSessionCookie } from '../../lib/customer-session.js';
import { storeAvatar } from '../../lib/avatar-storage.js';

export async function logout(): Promise<void> {
  await clearCustomerSessionCookie();
  redirect('/');
}

export interface DisplayNameFormState {
  error?: string;
  ok?: boolean;
}

export async function saveDisplayName(
  _prev: DisplayNameFormState,
  formData: FormData,
): Promise<DisplayNameFormState> {
  const session = await requireCustomerSession();
  const raw = String(formData.get('displayName') ?? '');

  const result = await updateDisplayName(getDb(), session.playerProfileId, raw);
  if (!result.ok) return { error: result.message };

  revalidatePath('/cuenta');
  revalidatePath('/cuenta/perfil');
  return { ok: true };
}

export interface AvatarFormState {
  error?: string;
  ok?: boolean;
}

export async function saveAvatar(_prev: AvatarFormState, formData: FormData): Promise<AvatarFormState> {
  const session = await requireCustomerSession();
  const file = formData.get('avatar');

  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Selecciona una foto.' };
  }

  const stored = await storeAvatar(session.playerProfileId, new Uint8Array(await file.arrayBuffer()));
  if (!stored.ok) return { error: stored.rejection.message };

  await updateAvatar(getDb(), session.playerProfileId, stored.key);
  revalidatePath('/cuenta');
  revalidatePath('/cuenta/perfil');
  return { ok: true };
}

export async function saveFeaturedBadges(formData: FormData): Promise<void> {
  const session = await requireCustomerSession();
  const ownershipIds = formData.getAll('ownershipId').map(String);

  await setFeaturedBadges(getDb(), session.playerProfileId, ownershipIds);
  revalidatePath('/cuenta');
  revalidatePath('/cuenta/insignias');
}
