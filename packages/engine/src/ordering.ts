/**
 * Order creation — combo expansion.
 *
 * This is the business model in code. The customer buys "Mega Prime 48k" and
 * sees one purchase; internally it becomes eight calls to the provider. That
 * asymmetry is what lets LevelUp compete on perceived value rather than on the
 * commodity price every competitor matches.
 *
 * Three things are frozen at creation and never re-read afterwards:
 *
 *   1. The recipe. The client rotates flyers monthly, so an OXXO voucher paid
 *      on 2 October for a September combo must still deliver September's
 *      recipe — even after the combo has been edited or retired.
 *   2. The price. Same reason.
 *   3. Per-item provider cost. Fulfilment reconciles ambiguous calls against
 *      the wallet using this figure; a later catalog re-sync must not silently
 *      change what an in-flight order expects to be charged.
 */

import { checkRecipe } from '@levelup/shared/money';
import type { UsdTenK } from '@levelup/provider';
import type { EndpointKind } from '@levelup/provider';
// Payment concepts live in payments.ts; ordering only needs to record the
// chosen method on the payment row it creates alongside the order.
import type { PaymentMethod } from './payments.js';

export type { PaymentMethod };

export interface RecipeEntry {
  sequence: number;
  baseProductId: string;
  providerProductId: string;
  endpointKind: EndpointKind;
  diamondsBase: number;
  costUsd: UsdTenK | null;
  active: boolean;
  requiresServerId: boolean;
}

export interface ComboForOrder {
  id: string;
  key: string;
  name: string;
  campaignName: string;
  priceMxnCents: number;
  advertisedDiamonds: number;
  maxPerPlayer: number | null;
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  campaignActive: boolean;
  recipe: RecipeEntry[];
}

export interface CreateOrderInput {
  comboKey: string;
  playerId: string;
  playerNickname?: string | null;
  serverId?: string | null;
  contactEmail?: string | null;
  contactWhatsapp?: string | null;
  paymentMethod: PaymentMethod;
  /** Admin-created orders skip the storefront's own guards, so they are marked. */
  source: 'storefront' | 'admin';
  tracking?: {
    fbp?: string | null;
    fbc?: string | null;
    clientIp?: string | null;
    userAgent?: string | null;
  };
}

export interface ComboSnapshot {
  comboKey: string;
  name: string;
  campaignName: string;
  priceMxnCents: number;
  advertisedDiamonds: number;
  deliveredDiamonds: number;
  recipe: Array<{
    sequence: number;
    providerProductId: string;
    diamondsBase: number;
    costUsd: string;
  }>;
  frozenAt: string;
}

export interface NewOrderItem {
  sequence: number;
  baseProductId: string;
  providerProductId: string;
  diamondsBase: number;
  costUsd: UsdTenK;
}

export interface NewOrder {
  orderNumber: string;
  playerId: string;
  playerNickname: string | null;
  serverId: string | null;
  contactEmail: string | null;
  contactWhatsapp: string | null;
  comboId: string;
  comboKey: string;
  comboSnapshot: ComboSnapshot;
  priceMxnCents: number;
  paymentMethod: PaymentMethod;
  items: NewOrderItem[];
  tracking: CreateOrderInput['tracking'];
}

export type CreateOrderFailure =
  | { code: 'COMBO_NOT_FOUND'; message: string }
  | { code: 'COMBO_INACTIVE'; message: string }
  | { code: 'COMBO_EXPIRED'; message: string }
  | { code: 'RECIPE_EMPTY'; message: string }
  | { code: 'RECIPE_UNDER_DELIVERS'; message: string; advertised: number; delivered: number }
  | { code: 'PRODUCT_UNAVAILABLE'; message: string }
  | { code: 'CATALOG_NOT_SYNCED'; message: string }
  | { code: 'SERVER_ID_REQUIRED'; message: string }
  | { code: 'PLAYER_LIMIT_REACHED'; message: string; limit: number }
  | { code: 'INVALID_PLAYER_ID'; message: string };

/** The persisted order carries its id — callers need it to approve payment,
 *  to redirect to a status page, and to link an order from the admin panel. */
export type PersistedOrder = NewOrder & { id: string };

export type CreateOrderResult =
  | { ok: true; order: PersistedOrder }
  | { ok: false; failure: CreateOrderFailure };

export interface OrderingStore {
  findComboForOrder(comboKey: string): Promise<ComboForOrder | null>;
  /** Non-cancelled orders this player already has for this combo. */
  countPlayerOrders(playerId: string, comboKey: string): Promise<number>;
  persist(order: NewOrder): Promise<{ id: string; orderNumber: string }>;
}

export interface OrderingDeps {
  store: OrderingStore;
  now?: () => Date;
  /** Injectable so tests are deterministic. */
  generateOrderNumber?: () => string;
}

/** Free Fire IDs are numeric and roughly 8-12 digits. */
const PLAYER_ID_PATTERN = /^\d{6,15}$/;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * `LU-YYMMDD-XXXX`. Short enough to read over WhatsApp, and the random tail
 * avoids leaking daily order volume to competitors the way a counter would.
 * Uniqueness is ultimately guaranteed by the unique index, not by this.
 */
export function defaultOrderNumber(now: Date = new Date()): string {
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  let tail = '';
  for (let i = 0; i < 4; i++) {
    tail += CROCKFORD[Math.floor(Math.random() * CROCKFORD.length)];
  }
  return `LU-${yy}${mm}${dd}-${tail}`;
}

export async function createOrder(
  deps: OrderingDeps,
  input: CreateOrderInput,
): Promise<CreateOrderResult> {
  const now = deps.now?.() ?? new Date();
  const fail = (failure: CreateOrderFailure): CreateOrderResult => ({ ok: false, failure });

  if (!PLAYER_ID_PATTERN.test(input.playerId)) {
    return fail({
      code: 'INVALID_PLAYER_ID',
      message: `"${input.playerId}" is not a valid Free Fire ID.`,
    });
  }

  const combo = await deps.store.findComboForOrder(input.comboKey);
  if (!combo) {
    return fail({ code: 'COMBO_NOT_FOUND', message: `No combo with key "${input.comboKey}".` });
  }

  // An admin fixing an order for a customer who paid before a promo rotated out
  // is a real scenario, so only the storefront enforces availability windows.
  if (input.source === 'storefront') {
    if (!combo.active || !combo.campaignActive) {
      return fail({ code: 'COMBO_INACTIVE', message: `"${combo.name}" is not on sale.` });
    }
    if (combo.startsAt && now < combo.startsAt) {
      return fail({ code: 'COMBO_EXPIRED', message: `"${combo.name}" has not started yet.` });
    }
    if (combo.endsAt && now > combo.endsAt) {
      return fail({ code: 'COMBO_EXPIRED', message: `"${combo.name}" has ended.` });
    }
  }

  if (combo.recipe.length === 0) {
    return fail({
      code: 'RECIPE_EMPTY',
      message: `"${combo.name}" has no recipe — run the provider catalog sync and re-seed.`,
    });
  }

  // Re-checked here even though the admin panel blocks publishing. Three of the
  // nineteen September combos under-delivered; the cost of shipping one is a
  // customer counting diamonds and posting screenshots in the VIP group.
  const check = checkRecipe(
    combo.advertisedDiamonds,
    combo.recipe.map((r) => r.diamondsBase),
  );
  if (!check.ok) {
    return fail({
      code: 'RECIPE_UNDER_DELIVERS',
      message: `"${combo.name}" advertises ${combo.advertisedDiamonds} but delivers ${check.delivered}.`,
      advertised: combo.advertisedDiamonds,
      delivered: check.delivered,
    });
  }

  const inactive = combo.recipe.find((r) => !r.active);
  if (inactive) {
    return fail({
      code: 'PRODUCT_UNAVAILABLE',
      message: `Provider product ${inactive.providerProductId} is no longer available.`,
    });
  }

  // Without a cost the wallet-delta check has nothing to compare against, so
  // every ambiguous call on this order would escalate to a human.
  const uncosted = combo.recipe.find((r) => r.costUsd === null);
  if (uncosted) {
    return fail({
      code: 'CATALOG_NOT_SYNCED',
      message: `Provider product ${uncosted.providerProductId} has no synced cost.`,
    });
  }

  if (combo.recipe.some((r) => r.requiresServerId) && !input.serverId) {
    return fail({
      code: 'SERVER_ID_REQUIRED',
      message: `"${combo.name}" needs a server ID for this player.`,
    });
  }

  // The Mega Oferta flyer says "válido solo para clientes nuevos". This is the
  // friendly check; the partial unique index is what actually holds the line
  // when two OXXO payments settle at once.
  if (combo.maxPerPlayer !== null) {
    const existing = await deps.store.countPlayerOrders(input.playerId, combo.key);
    if (existing >= combo.maxPerPlayer) {
      return fail({
        code: 'PLAYER_LIMIT_REACHED',
        message:
          combo.maxPerPlayer === 1
            ? `"${combo.name}" is limited to one per player.`
            : `"${combo.name}" is limited to ${combo.maxPerPlayer} per player.`,
        limit: combo.maxPerPlayer,
      });
    }
  }

  const items: NewOrderItem[] = combo.recipe
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((entry, index) => ({
      // Re-indexed so a gap in the stored recipe cannot leave holes that the
      // fulfilment worker would read as missing calls.
      sequence: index,
      baseProductId: entry.baseProductId,
      providerProductId: entry.providerProductId,
      diamondsBase: entry.diamondsBase,
      costUsd: entry.costUsd as UsdTenK,
    }));

  const snapshot: ComboSnapshot = {
    comboKey: combo.key,
    name: combo.name,
    campaignName: combo.campaignName,
    priceMxnCents: combo.priceMxnCents,
    advertisedDiamonds: combo.advertisedDiamonds,
    deliveredDiamonds: check.delivered,
    recipe: items.map((i) => ({
      sequence: i.sequence,
      providerProductId: i.providerProductId,
      diamondsBase: i.diamondsBase,
      costUsd: (i.costUsd / 10_000).toFixed(4),
    })),
    frozenAt: now.toISOString(),
  };

  const order: NewOrder = {
    orderNumber: (deps.generateOrderNumber ?? (() => defaultOrderNumber(now)))(),
    playerId: input.playerId,
    playerNickname: input.playerNickname ?? null,
    serverId: input.serverId ?? null,
    contactEmail: input.contactEmail ?? null,
    contactWhatsapp: input.contactWhatsapp ?? null,
    comboId: combo.id,
    comboKey: combo.key,
    comboSnapshot: snapshot,
    priceMxnCents: combo.priceMxnCents,
    paymentMethod: input.paymentMethod,
    items,
    ...(input.tracking ? { tracking: input.tracking } : { tracking: undefined }),
  };

  const persisted = await deps.store.persist(order);
  return {
    ok: true,
    order: { ...order, id: persisted.id, orderNumber: persisted.orderNumber },
  };
}
