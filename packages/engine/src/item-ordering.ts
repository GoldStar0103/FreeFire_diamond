/**
 * Order creation for a RocketPass vendor item (`orders.order_type = 'item'`).
 *
 * The item equivalent of `ordering.ts`'s `createOrder`. Three things are
 * frozen at creation and never re-read afterwards, same discipline as a
 * combo order: the item's name, its unit sale price in MXN cents (the
 * admin-typed `item_catalog.price_mxn_cents`, same manual-price model as
 * `combos.priceMxnCents` — no markup formula anymore, see `item-catalog-
 * queries.ts`'s doc comment), and its unit cost in MXN cents (RocketPass's
 * own ARS charge, converted at the admin-set rate) —
 * `item_order_details.unit_cost_cents_snapshot` is what `findUnprocessedOrders`
 * later subtracts from the sale price to compute Level Pass LP/Golden
 * Tickets for this order, exactly like a diamond order's profit.
 *
 * `arsRate` is passed in rather than read from settings here, so this stays
 * a pure function over its inputs like `createOrder` — the caller (the
 * adapter or the web action) is responsible for fetching it first via
 * `getArsRate`. It's only used for the internal cost snapshot now; the sale
 * price itself is read straight off `item.priceMxnCents`.
 *
 * There is no stock-reservation mechanism anywhere in this system (confirmed
 * against `item-fulfillment.ts`'s own design) — the stock check below is a
 * soft, advisory one against the last-synced mirror. Real availability is
 * only ever settled at RocketPass's own order-time response, which is what
 * `awaiting_stock` already exists to handle.
 */

import { defaultOrderNumber, PLAYER_ID_PATTERN } from './ordering.js';
import type { PaymentMethod } from './payments.js';

export type { PaymentMethod };

export type ItemKind = 'gift' | 'membership';

export interface ItemForOrder {
  id: string;
  sku: string;
  displayName: string;
  kind: ItemKind;
  /** RocketPass's last-synced ARS price for one unit — used only for the internal cost snapshot now. */
  priceArs: number;
  /** Admin-typed sale price for one unit, in MXN cents. Null means not priced yet — treated as unavailable. */
  priceMxnCents: number | null;
  maxQuantity: number;
  /** LevelUp's own minimum order quantity — admin-set, never vendor-synced. 1 means no minimum. */
  minQuantity: number;
  active: boolean;
  rocketpassAvailable: boolean;
  /** Region code -> quantity. Always empty for `kind === 'membership'`. */
  stockByRegion: Record<string, number>;
}

export interface CreateItemOrderInput {
  sku: string;
  quantity: number;
  /** Required for `kind === 'gift'`; ignored for `kind === 'membership'`. */
  region?: string | null;
  /** The Free Fire ID receiving the item — RocketPass's `target_uid`. */
  targetUid: string;
  targetNickname?: string | null;
  contactWhatsapp?: string | null;
  paymentMethod: PaymentMethod;
  /** Admin-created orders skip the storefront's own `active` gate, so they are marked. */
  source: 'storefront' | 'admin';
  tracking?: {
    fbp?: string | null;
    fbc?: string | null;
    clientIp?: string | null;
    userAgent?: string | null;
  };
  buyerProfileId?: string | null;
}

export interface ItemSnapshot {
  itemSku: string;
  itemName: string;
  kind: ItemKind;
  quantity: number;
  region: string | null;
  unitPriceMxnCents: number;
  unitCostMxnCents: number;
  frozenAt: string;
}

export interface NewItemOrder {
  orderNumber: string;
  playerId: string;
  playerNickname: string | null;
  contactWhatsapp: string | null;
  priceMxnCents: number;
  paymentMethod: PaymentMethod;
  item: ItemSnapshot;
  tracking?: CreateItemOrderInput['tracking'];
  playerProfileId?: string | null;
}

export type CreateItemOrderFailure =
  | { code: 'ITEM_NOT_FOUND'; message: string }
  | { code: 'ITEM_INACTIVE'; message: string }
  | { code: 'ITEM_UNAVAILABLE'; message: string }
  | { code: 'PRICE_NOT_SET'; message: string }
  | { code: 'INVALID_QUANTITY'; message: string; min: number; max: number }
  | { code: 'REGION_REQUIRED'; message: string }
  | { code: 'OUT_OF_STOCK'; message: string }
  | { code: 'INVALID_PLAYER_ID'; message: string };

export type PersistedItemOrder = NewItemOrder & { id: string };

export type CreateItemOrderResult =
  | { ok: true; order: PersistedItemOrder }
  | { ok: false; failure: CreateItemOrderFailure };

export interface ItemOrderingStore {
  findItemForOrder(sku: string): Promise<ItemForOrder | null>;
  persist(order: NewItemOrder): Promise<{ id: string; orderNumber: string }>;
}

export interface ItemOrderingDeps {
  store: ItemOrderingStore;
  /** MXN per 1 ARS — from `getArsRate`. Only feeds the internal cost snapshot now. */
  arsRate: number;
  now?: () => Date;
  generateOrderNumber?: () => string;
}

export async function createItemOrder(
  deps: ItemOrderingDeps,
  input: CreateItemOrderInput,
): Promise<CreateItemOrderResult> {
  const now = deps.now?.() ?? new Date();
  const fail = (failure: CreateItemOrderFailure): CreateItemOrderResult => ({ ok: false, failure });

  if (!PLAYER_ID_PATTERN.test(input.targetUid)) {
    return fail({
      code: 'INVALID_PLAYER_ID',
      message: `"${input.targetUid}" is not a valid Free Fire ID.`,
    });
  }

  const item = await deps.store.findItemForOrder(input.sku);
  if (!item) {
    return fail({ code: 'ITEM_NOT_FOUND', message: `No item with sku "${input.sku}".` });
  }

  // Same split as `createOrder`'s combo-active check: an admin fixing/placing
  // an order manually is a real scenario and skips the storefront-only gate.
  if (input.source === 'storefront' && !item.active) {
    return fail({ code: 'ITEM_INACTIVE', message: `"${item.displayName}" is not on sale.` });
  }

  if (!item.rocketpassAvailable) {
    return fail({ code: 'ITEM_UNAVAILABLE', message: `"${item.displayName}" is unavailable right now.` });
  }

  if (item.priceMxnCents == null) {
    return fail({ code: 'PRICE_NOT_SET', message: `"${item.displayName}" doesn't have a price set yet.` });
  }

  const quantity = Math.trunc(input.quantity);
  if (!Number.isFinite(quantity) || quantity < item.minQuantity || quantity > item.maxQuantity) {
    return fail({
      code: 'INVALID_QUANTITY',
      message: `Quantity must be between ${item.minQuantity} and ${item.maxQuantity}.`,
      min: item.minQuantity,
      max: item.maxQuantity,
    });
  }

  let region: string | null = null;
  if (item.kind === 'gift') {
    region = input.region?.trim() || null;
    if (!region) {
      return fail({ code: 'REGION_REQUIRED', message: `"${item.displayName}" needs a region.` });
    }
    const stock = item.stockByRegion[region] ?? 0;
    if (stock < quantity) {
      return fail({ code: 'OUT_OF_STOCK', message: `"${item.displayName}" is out of stock in ${region}.` });
    }
  }

  const unitCostMxnCents = Math.round(item.priceArs * deps.arsRate * 100);
  const unitPriceMxnCents = item.priceMxnCents;

  const snapshot: ItemSnapshot = {
    itemSku: item.sku,
    itemName: item.displayName,
    kind: item.kind,
    quantity,
    region,
    unitPriceMxnCents,
    unitCostMxnCents,
    frozenAt: now.toISOString(),
  };

  const order: NewItemOrder = {
    orderNumber: (deps.generateOrderNumber ?? (() => defaultOrderNumber(now)))(),
    playerId: input.targetUid,
    playerNickname: input.targetNickname ?? null,
    contactWhatsapp: input.contactWhatsapp ?? null,
    priceMxnCents: unitPriceMxnCents * quantity,
    paymentMethod: input.paymentMethod,
    item: snapshot,
    ...(input.tracking ? { tracking: input.tracking } : { tracking: undefined }),
    playerProfileId: input.buyerProfileId ?? null,
  };

  const persisted = await deps.store.persist(order);
  return {
    ok: true,
    order: { ...order, id: persisted.id, orderNumber: persisted.orderNumber },
  };
}
