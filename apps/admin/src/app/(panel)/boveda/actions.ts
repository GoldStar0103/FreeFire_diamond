'use server';

import { revalidatePath } from 'next/cache';
import { deleteVaultOffer, saveVaultOffer, toggleVaultOffer } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

export interface VaultOfferFormState {
  error?: string;
  ok?: boolean;
}

export async function saveOffer(_prev: VaultOfferFormState, formData: FormData): Promise<VaultOfferFormState> {
  const session = await requireSession();

  const comboId = String(formData.get('comboId') ?? '');
  const pesos = Number(formData.get('vaultPriceMxn'));
  const sortOrder = Number(formData.get('sortOrder')) || 0;
  const idRaw = String(formData.get('id') ?? '').trim();

  if (!comboId) return { error: 'Selecciona un combo.' };
  if (!Number.isFinite(pesos) || pesos <= 0) return { error: 'El precio de la Bóveda debe ser mayor que cero.' };

  const result = await saveVaultOffer(
    getDb(),
    {
      ...(idRaw ? { id: idRaw } : {}),
      comboId,
      vaultPriceMxnCents: Math.round(pesos * 100),
      sortOrder,
      active: formData.get('active') === 'true',
    },
    session.adminUserId,
  );

  if (!result.ok) {
    return { error: 'El precio de la Bóveda debe ser menor que el precio público del combo.' };
  }

  revalidatePath('/boveda');
  return { ok: true };
}

export async function toggleOffer(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');
  const next = formData.get('active') === 'true';
  if (!id) return;

  await toggleVaultOffer(getDb(), id, next, session.adminUserId);
  revalidatePath('/boveda');
}

export async function deleteOffer(formData: FormData): Promise<void> {
  const session = await requireSession();
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  await deleteVaultOffer(getDb(), id, session.adminUserId);
  revalidatePath('/boveda');
}
