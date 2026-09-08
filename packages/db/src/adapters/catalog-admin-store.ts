/**
 * Persistence for combo and campaign authoring.
 *
 * Saving a combo replaces its whole recipe, so the delete and the re-insert go
 * in one transaction. A partial write would leave a live combo with a recipe
 * that delivers less than it advertises — the exact failure the validator
 * exists to prevent.
 *
 * Nothing here is destructive to history: a combo is deactivated rather than
 * deleted, because orders reference it and a past order must stay readable.
 */

import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { parseUsd } from '@levelup/provider';
import type { AvailableProduct, CampaignDraft, ComboDraft } from '@levelup/engine';
import type { Database } from '../index.js';
import { auditLog, baseProducts, campaigns, comboItems, combos } from '../schema.js';

export interface CampaignOption {
  id: string;
  key: string;
  name: string;
  active: boolean;
}

export class DrizzleCatalogAdminStore {
  constructor(private readonly db: Database) {}

  /** Denominations the provider currently offers, for the recipe builder. */
  async listAvailableProducts(): Promise<AvailableProduct[]> {
    const rows = await this.db
      .select({
        diamondsBase: baseProducts.diamondsBase,
        costUsd: baseProducts.costUsd,
        active: baseProducts.active,
      })
      .from(baseProducts)
      .orderBy(asc(baseProducts.diamondsBase));

    return rows.map((r) => ({
      diamondsBase: r.diamondsBase,
      costUsd: r.costUsd === null ? null : parseUsd(r.costUsd),
      active: r.active,
    }));
  }

  async listCampaignOptions(): Promise<CampaignOption[]> {
    return this.db
      .select({
        id: campaigns.id,
        key: campaigns.key,
        name: campaigns.name,
        active: campaigns.active,
      })
      .from(campaigns)
      .orderBy(asc(campaigns.sortOrder), asc(campaigns.name));
  }

  /** One combo with its recipe, for editing. */
  async loadComboDraft(
    comboKey: string,
  ): Promise<(ComboDraft & { campaignId: string; sortOrder: number }) | null> {
    const [combo] = await this.db
      .select()
      .from(combos)
      .where(eq(combos.key, comboKey))
      .limit(1);

    if (!combo) return null;

    const recipe = await this.db
      .select({ diamondsBase: baseProducts.diamondsBase, sequence: comboItems.sequence })
      .from(comboItems)
      .innerJoin(baseProducts, eq(baseProducts.id, comboItems.baseProductId))
      .where(eq(comboItems.comboId, combo.id))
      .orderBy(asc(comboItems.sequence));

    return {
      key: combo.key,
      name: combo.name,
      priceMxnCents: combo.priceMxnCents,
      advertisedDiamonds: combo.advertisedDiamonds,
      maxPerPlayer: combo.maxPerPlayer,
      recipe: recipe.map((r) => r.diamondsBase),
      active: combo.active,
      campaignId: combo.campaignId,
      sortOrder: combo.sortOrder,
    };
  }

  /**
   * Create or update a combo and its recipe.
   *
   * Recipe entries resolve to the ACTIVE product for each denomination, so a
   * combo saved today points at whatever the provider currently sells rather
   * than at a withdrawn SKU that happens to share the denomination.
   */
  async saveCombo(
    draft: ComboDraft,
    options: { campaignId: string; sortOrder: number; adminUserId: string | null },
  ): Promise<{ comboId: string; created: boolean }> {
    return this.db.transaction(async (tx) => {
      const products = await tx
        .select({ id: baseProducts.id, diamondsBase: baseProducts.diamondsBase })
        .from(baseProducts)
        .where(eq(baseProducts.active, true));

      const byDenomination = new Map(products.map((p) => [p.diamondsBase, p.id]));

      const missing = draft.recipe.filter((d) => !byDenomination.has(d));
      if (missing.length > 0) {
        // The validator should have caught this; if it reaches here the
        // catalog changed under us and the write must not proceed.
        throw new Error(`No active provider product for: ${[...new Set(missing)].join(', ')}`);
      }

      const [saved] = await tx
        .insert(combos)
        .values({
          campaignId: options.campaignId,
          key: draft.key,
          name: draft.name.trim(),
          priceMxnCents: draft.priceMxnCents,
          advertisedDiamonds: draft.advertisedDiamonds,
          maxPerPlayer: draft.maxPerPlayer,
          sortOrder: options.sortOrder,
          active: draft.active,
        })
        .onConflictDoUpdate({
          target: combos.key,
          set: {
            campaignId: options.campaignId,
            name: draft.name.trim(),
            priceMxnCents: draft.priceMxnCents,
            advertisedDiamonds: draft.advertisedDiamonds,
            maxPerPlayer: draft.maxPerPlayer,
            sortOrder: options.sortOrder,
            active: draft.active,
          },
        })
        .returning({ id: combos.id, createdAt: combos.createdAt });

      if (!saved) throw new Error('Combo upsert returned no row');

      // Replace the recipe wholesale — reconciling positions would be more
      // code for no benefit, and it happens inside the transaction.
      await tx.delete(comboItems).where(eq(comboItems.comboId, saved.id));

      if (draft.recipe.length > 0) {
        await tx.insert(comboItems).values(
          draft.recipe.map((denomination, sequence) => ({
            comboId: saved.id,
            baseProductId: byDenomination.get(denomination)!,
            sequence,
          })),
        );
      }

      await tx.insert(auditLog).values({
        adminUserId: options.adminUserId,
        action: 'combo.saved',
        entityType: 'combo',
        entityId: saved.id,
        detail: {
          key: draft.key,
          active: draft.active,
          priceMxnCents: draft.priceMxnCents,
          advertisedDiamonds: draft.advertisedDiamonds,
          recipe: draft.recipe,
        },
      });

      const created = Date.now() - saved.createdAt.getTime() < 2000;
      return { comboId: saved.id, created };
    });
  }

  /** Switch a combo on or off without touching anything else. */
  async setComboActive(
    comboKey: string,
    active: boolean,
    adminUserId: string | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(combos)
        .set({ active })
        .where(eq(combos.key, comboKey))
        .returning({ id: combos.id });

      if (!updated) throw new Error(`No combo with key ${comboKey}`);

      await tx.insert(auditLog).values({
        adminUserId,
        action: active ? 'combo.activated' : 'combo.deactivated',
        entityType: 'combo',
        entityId: updated.id,
        detail: { key: comboKey },
      });
    });
  }

  async saveCampaign(
    draft: CampaignDraft,
    options: { sortOrder: number; flyerAssetUrl?: string | null; adminUserId: string | null },
  ): Promise<{ campaignId: string }> {
    return this.db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(campaigns)
        .values({
          key: draft.key,
          name: draft.name.trim(),
          badge: draft.badge,
          permanent: draft.permanent,
          active: draft.active,
          startsAt: draft.startsAt,
          endsAt: draft.endsAt,
          sortOrder: options.sortOrder,
          flyerAssetUrl: options.flyerAssetUrl ?? null,
        })
        .onConflictDoUpdate({
          target: campaigns.key,
          set: {
            name: draft.name.trim(),
            badge: draft.badge,
            permanent: draft.permanent,
            active: draft.active,
            startsAt: draft.startsAt,
            endsAt: draft.endsAt,
            sortOrder: options.sortOrder,
            // Omitting the flyer leaves the existing one in place, so editing a
            // campaign's dates does not silently wipe its image.
            ...(options.flyerAssetUrl === undefined
              ? {}
              : { flyerAssetUrl: options.flyerAssetUrl }),
          },
        })
        .returning({ id: campaigns.id });

      if (!saved) throw new Error('Campaign upsert returned no row');

      await tx.insert(auditLog).values({
        adminUserId: options.adminUserId,
        action: 'campaign.saved',
        entityType: 'campaign',
        entityId: saved.id,
        detail: { key: draft.key, active: draft.active, permanent: draft.permanent },
      });

      return { campaignId: saved.id };
    });
  }

  /**
   * Retire every combo in a campaign and switch the campaign off.
   *
   * The monthly rotation in one action. Deactivation only — orders reference
   * these rows and history has to stay readable.
   */
  async retireCampaign(campaignKey: string, adminUserId: string | null): Promise<number> {
    return this.db.transaction(async (tx) => {
      const [campaign] = await tx
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(eq(campaigns.key, campaignKey))
        .limit(1);

      if (!campaign) throw new Error(`No campaign with key ${campaignKey}`);

      const retired = await tx
        .update(combos)
        .set({ active: false })
        .where(and(eq(combos.campaignId, campaign.id), ne(combos.active, false)))
        .returning({ id: combos.id });

      await tx.update(campaigns).set({ active: false }).where(eq(campaigns.id, campaign.id));

      await tx.insert(auditLog).values({
        adminUserId,
        action: 'campaign.retired',
        entityType: 'campaign',
        entityId: campaign.id,
        detail: { key: campaignKey, combosRetired: retired.length },
      });

      return retired.length;
    });
  }

  /** Next sort position, so a new item lands at the end rather than on top. */
  async nextComboSortOrder(campaignId: string): Promise<number> {
    const [row] = await this.db
      .select({ next: sql<string>`COALESCE(MAX(${combos.sortOrder}), -1) + 1` })
      .from(combos)
      .where(eq(combos.campaignId, campaignId));
    return Number(row?.next ?? 0);
  }
}
