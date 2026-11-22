'use server';

import { revalidatePath } from 'next/cache';
import { DrizzleItemCatalogAdminStore } from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

/** A server action is a public endpoint; the panel layout's gate does not cover it. */
export async function toggleItemActive(formData: FormData): Promise<void> {
  const session = await requireSession();
  const sku = String(formData.get('sku') ?? '');
  const active = formData.get('active') === 'true';

  await new DrizzleItemCatalogAdminStore(getDb()).setItemActive(sku, active, session.adminUserId);

  revalidatePath('/articulos');
}

export async function renameItem(formData: FormData): Promise<void> {
  const session = await requireSession();
  const sku = String(formData.get('sku') ?? '');
  const displayName = String(formData.get('displayName') ?? '').trim();
  if (!displayName) return;

  await new DrizzleItemCatalogAdminStore(getDb()).setItemDisplayName(sku, displayName, session.adminUserId);

  revalidatePath('/articulos');
}

export async function setItemPrice(formData: FormData): Promise<void> {
  const session = await requireSession();
  const sku = String(formData.get('sku') ?? '');
  const priceMxn = Number(String(formData.get('priceMxn') ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(priceMxn) || priceMxn <= 0) return;

  await new DrizzleItemCatalogAdminStore(getDb()).setItemPriceMxnCents(
    sku,
    Math.round(priceMxn * 100),
    session.adminUserId,
  );

  revalidatePath('/articulos');
}
