/**
 * RocketPass catalog/stock sync.
 *
 * Much simpler than `catalog-sync.ts`'s diamond-provider sync: RocketPass's
 * `item` values are fixed enum strings (`crate`, `token`, `pass`,
 * `weekly_basic`, `weekly`, `monthly`), never reassigned to a different
 * product the way a provider's numeric SKU can be — so there is no
 * repoint/conflict-detection problem to solve, only a plain upsert keyed on
 * `sku`.
 *
 * Deliberately filters out RocketPass's own `level_pass` kind on every sync,
 * not just at the type level — even if RocketPass's catalog response ever
 * includes one, it must never be persisted. See the new-features plan's
 * scope decision on why that category is excluded from this build entirely.
 */

import type { Catalog, RocketPassItem, RocketPassRegion } from '@levelup/rocketpass';

const SUPPORTED_KINDS: ReadonlySet<string> = new Set(['gift', 'membership']);

export interface SyncedCatalogItem {
  sku: RocketPassItem;
  name: string;
  kind: 'gift' | 'membership';
  priceArs: number;
  maxQuantity: number;
  available: boolean;
  /** Null for memberships — RocketPass tracks no per-region stock for those. */
  stockByRegion: Partial<Record<RocketPassRegion, number>> | null;
}

export interface RocketPassCatalogClient {
  listCatalog(): Promise<Catalog>;
}

export interface RocketPassCatalogStore {
  /** Upserts by `sku`. Never touches the admin-editable display name — see the implementation's own comment. */
  upsertCatalog(items: SyncedCatalogItem[], syncedAt: Date): Promise<void>;
}

export interface RocketPassSyncDeps {
  client: RocketPassCatalogClient;
  store: RocketPassCatalogStore;
  now?: () => Date;
}

export interface RocketPassSyncResult {
  synced: number;
  /** Items RocketPass returned that this sync deliberately never persists (currently: `level_pass`). */
  skipped: number;
}

export async function syncRocketPassCatalog(deps: RocketPassSyncDeps): Promise<RocketPassSyncResult> {
  const catalog = await deps.client.listCatalog();
  const now = (deps.now ?? (() => new Date()))();

  const supported = catalog.items.filter((i) => SUPPORTED_KINDS.has(i.kind));

  await deps.store.upsertCatalog(
    supported.map((i) => ({
      sku: i.item,
      name: i.name,
      kind: i.kind as 'gift' | 'membership',
      priceArs: i.priceArs,
      maxQuantity: i.maxQuantity,
      available: i.available,
      stockByRegion: i.stockByRegion,
    })),
    now,
  );

  return { synced: supported.length, skipped: catalog.items.length - supported.length };
}
