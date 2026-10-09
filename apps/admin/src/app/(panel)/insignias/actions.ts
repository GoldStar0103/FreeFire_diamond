'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  manuallyAwardBadge,
  revokeBadgeOwnership,
  saveBadgeDefinition,
  setBadgeObtainable,
  type BadgeDefinitionDraft,
} from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';
import { storeBadgeArtwork } from '../../../lib/badge-artwork';

export interface BadgeFormState {
  error?: string;
  ok?: boolean;
}

function readBadgeForm(formData: FormData): BadgeDefinitionDraft {
  const parseDate = (value: FormDataEntryValue | null): Date | null => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  return {
    badgeKey: String(formData.get('badgeKey') ?? '').trim().toLowerCase(),
    title: String(formData.get('title') ?? '').trim(),
    description: String(formData.get('description') ?? '').trim() || null,
    category: String(formData.get('category') ?? 'special') as BadgeDefinitionDraft['category'],
    rarity: String(formData.get('rarity') ?? 'common') as BadgeDefinitionDraft['rarity'],
    artworkAssetUrl: String(formData.get('artworkAssetUrl') ?? '').trim() || null,
    seasonScoped: formData.get('seasonScoped') === 'true',
    eligibilityStartsAt: parseDate(formData.get('eligibilityStartsAt')),
    eligibilityEndsAt: parseDate(formData.get('eligibilityEndsAt')),
    obtainable: formData.get('obtainable') === 'true',
  };
}

export async function saveBadge(_prev: BadgeFormState, formData: FormData): Promise<BadgeFormState> {
  const session = await requireSession();
  const draft = readBadgeForm(formData);

  if (!draft.badgeKey || !/^[a-z0-9_]+$/.test(draft.badgeKey)) {
    return { error: 'La clave debe usar solo minúsculas, números y guión bajo.' };
  }
  if (!draft.title) return { error: 'Escribe un título.' };

  // An uploaded file wins over the URL box. Keeping both means the client can
  // upload art here or point at a CDN later without a code change — the same
  // arrangement campaign flyers already have.
  const file = formData.get('artworkFile');
  if (file instanceof File && file.size > 0) {
    const stored = await storeBadgeArtwork(draft.badgeKey, new Uint8Array(await file.arrayBuffer()));
    if (!stored.ok) return { error: stored.rejection.message };
    draft.artworkAssetUrl = stored.key;
  }

  await saveBadgeDefinition(getDb(), draft, session.adminUserId);
  revalidatePath('/insignias');
  redirect(`/insignias/${encodeURIComponent(draft.badgeKey)}`);
}

export async function toggleObtainable(formData: FormData): Promise<void> {
  const session = await requireSession();
  const badgeKey = String(formData.get('badgeKey') ?? '');
  const next = formData.get('obtainable') === 'true';
  if (!badgeKey) return;

  await setBadgeObtainable(getDb(), badgeKey, next, session.adminUserId);
  revalidatePath('/insignias');
  revalidatePath(`/insignias/${encodeURIComponent(badgeKey)}`);
}

export interface AwardFormState {
  error?: string;
  ok?: boolean;
}

export async function awardBadge(_prev: AwardFormState, formData: FormData): Promise<AwardFormState> {
  const session = await requireSession();
  const badgeKey = String(formData.get('badgeKey') ?? '');
  const playerId = String(formData.get('playerId') ?? '').trim();
  const reason = String(formData.get('reason') ?? '').trim();
  const seasonRaw = String(formData.get('seasonNumber') ?? '').trim();

  if (!/^\d{6,15}$/.test(playerId)) return { error: 'El ID de Free Fire debe tener entre 6 y 15 números.' };
  if (!reason) return { error: 'Escribe un motivo para el otorgamiento manual.' };

  const result = await manuallyAwardBadge(getDb(), {
    playerId,
    badgeKey,
    reason,
    adminUserId: session.adminUserId,
    ...(seasonRaw ? { seasonNumber: Number(seasonRaw) } : {}),
  });

  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      player_not_found: 'No hay ninguna cuenta LevelUp con ese ID de Free Fire.',
      badge_not_found: 'Esa insignia ya no existe.',
      season_required: 'Esta insignia es por temporada — indica el número de temporada.',
      season_not_found: 'No existe esa temporada.',
    };
    return { error: messages[result.reason] };
  }

  revalidatePath(`/insignias/${encodeURIComponent(badgeKey)}`);
  return { ok: true };
}

export async function revokeBadge(formData: FormData): Promise<void> {
  const session = await requireSession();
  const ownershipId = String(formData.get('ownershipId') ?? '');
  const badgeKey = String(formData.get('badgeKey') ?? '');
  if (!ownershipId) return;

  await revokeBadgeOwnership(getDb(), ownershipId, session.adminUserId, 'Revocado desde el panel');
  revalidatePath(`/insignias/${encodeURIComponent(badgeKey)}`);
}
