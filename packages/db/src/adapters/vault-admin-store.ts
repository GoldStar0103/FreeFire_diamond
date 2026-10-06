/**
 * Admin management of the (up to 6, per spec) discounted offers shown once a
 * player unlocks the Vault. Each references an existing public combo, so the
 * "normal price vs. Vault price" comparison the spec asks for is always
 * accurate — see schema.ts's own comment on `vault_offers`.
 */

import { desc, eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { auditLog, combos, vaultOffers } from '../schema.js';

export interface VaultOfferRow {
  id: string;
  comboId: string;
  comboKey: string;
  comboName: string;
  publicPriceMxnCents: number;
  vaultPriceMxnCents: number;
  sortOrder: number;
  active: boolean;
}

export async function listVaultOffersForAdmin(db: Database): Promise<VaultOfferRow[]> {
  const rows = await db
    .select({
      id: vaultOffers.id,
      comboId: vaultOffers.comboId,
      comboKey: combos.key,
      comboName: combos.name,
      publicPriceMxnCents: combos.priceMxnCents,
      vaultPriceMxnCents: vaultOffers.vaultPriceMxnCents,
      sortOrder: vaultOffers.sortOrder,
      active: vaultOffers.active,
    })
    .from(vaultOffers)
    .innerJoin(combos, eq(combos.id, vaultOffers.comboId))
    .orderBy(vaultOffers.sortOrder, desc(vaultOffers.active));
  return rows;
}

export interface ComboOption {
  id: string;
  key: string;
  name: string;
  priceMxnCents: number;
}

/** Active combos to populate the "which combo does this offer discount" picker. */
export async function listActiveCombosForOffers(db: Database): Promise<ComboOption[]> {
  return db
    .select({ id: combos.id, key: combos.key, name: combos.name, priceMxnCents: combos.priceMxnCents })
    .from(combos)
    .where(eq(combos.active, true))
    .orderBy(combos.name);
}

export interface VaultOfferDraft {
  id?: string;
  comboId: string;
  vaultPriceMxnCents: number;
  sortOrder: number;
  active: boolean;
}

export type SaveVaultOfferResult = { ok: true; id: string } | { ok: false; reason: 'price_not_lower' };

/**
 * The Vault price must be strictly lower than the combo's public price — a
 * "discount" that isn't one would be a copy-paste mistake, not a real offer.
 */
export async function saveVaultOffer(
  db: Database,
  draft: VaultOfferDraft,
  adminUserId: string,
): Promise<SaveVaultOfferResult> {
  const [combo] = await db.select({ priceMxnCents: combos.priceMxnCents }).from(combos).where(eq(combos.id, draft.comboId)).limit(1);
  if (combo && draft.vaultPriceMxnCents >= combo.priceMxnCents) {
    return { ok: false, reason: 'price_not_lower' };
  }

  return db.transaction(async (tx) => {
    let id: string;
    if (draft.id) {
      await tx
        .update(vaultOffers)
        .set({
          comboId: draft.comboId,
          vaultPriceMxnCents: draft.vaultPriceMxnCents,
          sortOrder: draft.sortOrder,
          active: draft.active,
        })
        .where(eq(vaultOffers.id, draft.id));
      id = draft.id;
    } else {
      const [row] = await tx
        .insert(vaultOffers)
        .values({
          comboId: draft.comboId,
          vaultPriceMxnCents: draft.vaultPriceMxnCents,
          sortOrder: draft.sortOrder,
          active: draft.active,
        })
        .returning({ id: vaultOffers.id });
      id = row!.id;
    }

    await tx.insert(auditLog).values({
      adminUserId,
      action: draft.id ? 'vault_offer.update' : 'vault_offer.create',
      entityType: 'vault_offer',
      entityId: id,
      detail: draft,
    });

    return { ok: true, id };
  });
}

export async function toggleVaultOffer(db: Database, id: string, active: boolean, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.update(vaultOffers).set({ active }).where(eq(vaultOffers.id, id)).returning({ id: vaultOffers.id });
    if (!row) return;
    await tx.insert(auditLog).values({ adminUserId, action: 'vault_offer.toggle', entityType: 'vault_offer', entityId: id, detail: { active } });
  });
}

export async function deleteVaultOffer(db: Database, id: string, adminUserId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(vaultOffers).where(eq(vaultOffers.id, id)).returning({ id: vaultOffers.id });
    if (!row) return;
    await tx.insert(auditLog).values({ adminUserId, action: 'vault_offer.delete', entityType: 'vault_offer', entityId: id });
  });
}
