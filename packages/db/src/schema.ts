/**
 * LevelUp Store — database schema
 *
 * Three constraints from the provider API shape almost everything here:
 *
 *   1. No idempotency key and no transactions-list endpoint. When a purchase
 *      call times out we cannot ask whether it happened, so `order_items`
 *      records intent *before* the call and captures the wallet balance either
 *      side of it. Balance comparison resolves the ambiguity afterwards.
 *   2. `/buy/pins` returns no reference and cannot be polled. Only `/buy/games`
 *      orders are pollable, so `provider_reference` is nullable by necessity.
 *   3. No stock signal on Free Fire products. Wallet balance is the only
 *      pre-flight check, hence `wallet_snapshots`.
 *
 * Money rule: MXN is stored as integer centavos, provider cost as NUMERIC.
 * No floating point touches money anywhere in this system.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ── enums ─────────────────────────────────────────────────────────────────────

/** Which provider endpoint fulfils a base SKU. Decided by Phase 0 discovery. */
export const endpointKind = pgEnum('endpoint_kind', [
  'games', // POST /buy/games      — direct top-up, pollable, no validation
  'pins_recharge', // POST /buy/pins       — direct top-up, validatable, not pollable
  'pins_code', // POST /buy/pins       — redeemable code; breaks the product model
]);

export const orderStatus = pgEnum('order_status', [
  'pending_payment',
  'payment_confirmed',
  'processing',
  'partially_delivered',
  'completed',
  'payment_expired',
  'needs_review', // ambiguous outcome or retries exhausted — human required
  'refund_required',
  'cancelled',
]);

export const orderItemStatus = pgEnum('order_item_status', [
  'queued',
  'sending', // written and committed BEFORE the HTTP call goes out
  'succeeded',
  'failed', // definitively did not happen; safe to retry
  'unknown', // ambiguous; NEVER auto-retry, resolve by wallet delta
  'provider_pending', // provider returned PENDING; poll /orders/{reference}
]);

/** How an item's final state was established. Audit trail for ambiguous calls. */
export const resolutionSource = pgEnum('resolution_source', [
  'response', // clean HTTP response
  'wallet_delta', // balance comparison after a timeout
  'polling', // /orders/{reference}
  'manual', // an admin decided
]);

export const paymentMethod = pgEnum('payment_method', [
  'transfer_manual', // BBVA / OXXO deposit + comprobante — the launch path
  'spei',
  'oxxo',
  'card',
  'paypal',
]);

export const paymentStatus = pgEnum('payment_status', [
  'pending',
  'under_review', // comprobante uploaded, awaiting admin approval
  'paid',
  'expired',
  'failed',
  'amount_mismatch', // received != expected; never fulfil on this
]);

// ── provider catalog ──────────────────────────────────────────────────────────

/**
 * Mirror of the provider's Free Fire SKUs — the six commodity denominations
 * that every competitor also resells. Synced from /products/*, never hand-edited.
 */
export const baseProducts = pgTable(
  'base_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerProductId: text('provider_product_id').notNull(),
    endpointKind: endpointKind('endpoint_kind').notNull(),
    sku: text('sku'),
    name: text('name').notNull(),

    /** Face value, e.g. 5600. The +10% bonus is applied by Garena on delivery. */
    diamondsBase: integer('diamonds_base').notNull(),
    bonusPct: integer('bonus_pct').notNull().default(10),

    costUsd: numeric('cost_usd', { precision: 12, scale: 4 }),
    requiresServerId: boolean('requires_server_id').notNull().default(false),
    canValidate: boolean('can_validate').notNull().default(false),

    active: boolean('active').notNull().default(true),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('base_products_provider_id_idx').on(t.providerProductId)],
);

// ── merchandising ─────────────────────────────────────────────────────────────

/** A monthly flyer. The client rotates these themselves; no developer involved. */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    flyerAssetUrl: text('flyer_asset_url'),
    badge: text('badge'), // "PROMO ACTIVA", "MÁS POPULAR", "ELITE"
    sortOrder: integer('sort_order').notNull().default(0),

    /** Permanent campaigns (the $10 Mega Oferta) survive the monthly rotation. */
    permanent: boolean('permanent').notNull().default(false),
    active: boolean('active').notNull().default(true),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('campaigns_key_idx').on(t.key)],
);

/**
 * What the customer buys. The whole business model lives here: a combo is a
 * bundle of base SKUs sold under one name at one price, so LevelUp competes on
 * perceived value rather than on the commodity price everyone else matches.
 */
export const combos = pgTable(
  'combos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    name: text('name').notNull(),

    priceMxnCents: integer('price_mxn_cents').notNull(),

    /** What the flyer promises. Must never exceed what the recipe delivers. */
    advertisedDiamonds: integer('advertised_diamonds').notNull(),

    /** Lifetime cap per player. 1 for the Mega Oferta ("solo clientes nuevos"). */
    maxPerPlayer: integer('max_per_player'),

    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('combos_key_idx').on(t.key),
    index('combos_campaign_idx').on(t.campaignId),
  ],
);

/** One provider call. Mega Prime 48k has eight of these rows. */
export const comboItems = pgTable(
  'combo_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    comboId: uuid('combo_id')
      .notNull()
      .references(() => combos.id, { onDelete: 'cascade' }),
    baseProductId: uuid('base_product_id')
      .notNull()
      .references(() => baseProducts.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
  },
  (t) => [uniqueIndex('combo_items_seq_idx').on(t.comboId, t.sequence)],
);

// ── orders ────────────────────────────────────────────────────────────────────

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderNumber: text('order_number').notNull(),

    playerId: text('player_id').notNull(),
    /**
     * The Mi LevelUp account that was signed in when this order was placed.
     * Level Pass / Vault credit this profile even when `player_id` is a
     * different Free Fire ID (secondaries). Season ranking still uses the
     * profile's single linked `player_profiles.player_id`.
     */
    playerProfileId: uuid('player_profile_id').references(() => playerProfiles.id, { onDelete: 'set null' }),
    /** From /pins/validate. Shown as "¿Eres tú, X?" and kept as evidence. */
    playerNickname: text('player_nickname'),
    serverId: text('server_id'),

    contactEmail: text('contact_email'),
    contactWhatsapp: text('contact_whatsapp'),

    comboId: uuid('combo_id').references(() => combos.id, { onDelete: 'set null' }),
    /** Denormalised so the Mega Oferta partial unique index can reference it. */
    comboKey: text('combo_key').notNull(),

    /** Set on `payment.rejected` so the customer's own tracking page can show why — see rejectPayment. */
    cancelReason: text('cancel_reason'),

    /**
     * The combo frozen at creation: name, price, advertised diamonds, full
     * recipe. Fulfilment reads ONLY this. An OXXO voucher paid on 2 Oct for a
     * September combo must still deliver September's recipe, even after the
     * client has rotated the flyer and edited the combo.
     */
    comboSnapshot: jsonb('combo_snapshot').notNull(),

    priceMxnCents: integer('price_mxn_cents').notNull(),
    status: orderStatus('status').notNull().default('pending_payment'),

    /** Shared by browser Pixel and server-side CAPI so Meta deduplicates. */
    eventId: uuid('event_id').notNull().defaultRandom(),
    /** Captured at creation; CAPI needs them hours later when OXXO settles. */
    fbp: text('fbp'),
    fbc: text('fbc'),
    clientIp: text('client_ip'),
    userAgent: text('user_agent'),
    /**
     * When the server-side Purchase reached Meta. The worker reports every paid
     * storefront order once; null means not yet, and the attempts counter stops
     * it retrying forever against a revoked token.
     */
    capiSentAt: timestamp('capi_sent_at', { withTimezone: true }),
    capiAttempts: integer('capi_attempts').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_number_idx').on(t.orderNumber),
    index('orders_player_idx').on(t.playerId),
    index('orders_player_profile_idx').on(t.playerProfileId),
    index('orders_status_idx').on(t.status),
    // What the conversions sweep scans: paid, not yet reported.
    index('orders_capi_pending_idx').on(t.paidAt).where(sql`capi_sent_at IS NULL`),

    /**
     * The Mega Oferta is a loss leader marked "válido solo para clientes
     * nuevos". Application checks cannot hold that line alone: OXXO settles
     * hours after checkout, so two orders can race past validation. The
     * database refuses the second one.
     */
    uniqueIndex('one_mega_oferta_per_player')
      .on(t.playerId)
      .where(
        sql`combo_key = 'mega_10' AND status NOT IN ('cancelled', 'payment_expired')`,
      ),
  ],
);

/**
 * One provider call per row, with everything needed to reconstruct what
 * happened — including the wallet balance either side, which is how an
 * ambiguous timeout gets resolved without an idempotency key.
 */
export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),

    baseProductId: uuid('base_product_id').references(() => baseProducts.id, {
      onDelete: 'set null',
    }),
    providerProductId: text('provider_product_id').notNull(),
    diamondsBase: integer('diamonds_base').notNull(),

    status: orderItemStatus('status').notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),

    providerTransactionId: text('provider_transaction_id'),
    /** Null for /buy/pins — that endpoint returns nothing pollable. */
    providerReference: text('provider_reference'),

    requestPayload: jsonb('request_payload'),
    responsePayload: jsonb('response_payload'),
    httpStatus: integer('http_status'),
    errorCode: text('error_code'),

    /** Read immediately before the call and again after an ambiguous outcome. */
    walletBeforeUsd: numeric('wallet_before_usd', { precision: 12, scale: 4 }),
    walletAfterUsd: numeric('wallet_after_usd', { precision: 12, scale: 4 }),
    costUsd: numeric('cost_usd', { precision: 12, scale: 4 }),
    resolvedBy: resolutionSource('resolved_by'),

    sentAt: timestamp('sent_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** Set when the client dismisses this row from the Inicio dashboard's wallet-resolved-delivery list. */
    dashboardDismissedAt: timestamp('dashboard_dismissed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('order_items_seq_idx').on(t.orderId, t.sequence),
    index('order_items_status_idx').on(t.status),
  ],
);

// ── payments ──────────────────────────────────────────────────────────────────

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    method: paymentMethod('method').notNull(),
    status: paymentStatus('status').notNull().default('pending'),
    gateway: text('gateway'), // null for the manual comprobante flow
    gatewayChargeId: text('gateway_charge_id'),

    amountExpectedCents: integer('amount_expected_cents').notNull(),
    amountReceivedCents: integer('amount_received_cents'),

    clabe: text('clabe'),
    reference: text('reference'),
    /** Receipt photo for the BBVA/OXXO flow they run today. */
    comprobanteAssetUrl: text('comprobante_asset_url'),
    reviewedByAdminId: uuid('reviewed_by_admin_id'),

    expiresAt: timestamp('expires_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Set once the "this gateway payment has been pending unusually long"
     * alert has fired for it, so the sweep sends it exactly once instead of
     * every cycle. Real incident, 2026-09-23/24: three separate real OXXO
     * deposits sat unconfirmed for hours (Stripe's own OXXO settlement via
     * PPRO, not anything this codebase controls) and only surfaced because
     * the customer happened to say something — nothing here watched for it.
     */
    stuckAlertSentAt: timestamp('stuck_alert_sent_at', { withTimezone: true }),

    /**
     * Set when the client dismisses this row from the Inicio dashboard's
     * stuck-payment list. Distinct from `stuckAlertSentAt`: that one gates
     * the once-only Telegram alert, this one only affects what the dashboard
     * shows — dismissing does not silence a future alert, and an alert does
     * not dismiss the dashboard row.
     */
    dashboardDismissedAt: timestamp('dashboard_dismissed_at', { withTimezone: true }),
  },
  (t) => [
    index('payments_order_idx').on(t.orderId),
    index('payments_status_idx').on(t.status),
  ],
);

/**
 * Raw webhook log. The unique constraint IS the deduplication — a repeated
 * delivery violates it and is discarded, rather than relying on application
 * logic to notice.
 */
export const paymentEvents = pgTable(
  'payment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gateway: text('gateway').notNull(),
    gatewayEventId: text('gateway_event_id').notNull(),
    eventType: text('event_type'),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    payload: jsonb('payload').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payment_events_gateway_id_idx').on(t.gateway, t.gatewayEventId)],
);

// ── operations ────────────────────────────────────────────────────────────────

/** Every provider request and response, for audit and dispute resolution. */
export const providerApiLog = pgTable(
  'provider_api_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderItemId: uuid('order_item_id').references(() => orderItems.id, {
      onDelete: 'set null',
    }),
    method: text('method').notNull(),
    path: text('path').notNull(),
    requestPayload: jsonb('request_payload'),
    responsePayload: jsonb('response_payload'),
    httpStatus: integer('http_status'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('provider_api_log_created_idx').on(t.createdAt)],
);

/**
 * Wallet balance over time. Serves two purposes: the low-balance alert, and the
 * historical record that makes wallet-delta resolution auditable after the fact.
 */
export const walletSnapshots = pgTable(
  'wallet_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    balanceUsd: numeric('balance_usd', { precision: 12, scale: 4 }).notNull(),
    currency: text('currency').notNull().default('USD'),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('wallet_snapshots_taken_idx').on(t.takenAt)],
);

export const adminUsers = pgTable(
  'admin_users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    totpSecret: text('totp_secret'),
    /**
     * The last TOTP time-step index (30s each) accepted for this admin.
     * Anti-replay: a code is valid for its whole ±30s window, so without this
     * a shoulder-surfed or intercepted code could be reused seconds later.
     * Verification rejects any step `<= totpLastStep`.
     */
    totpLastStep: integer('totp_last_step'),
    name: text('name'),
    role: text('role').notNull().default('operator'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('admin_users_email_idx').on(t.email)],
);

/** Who changed what. Required for anything touching money or fulfilment. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminUserId: uuid('admin_user_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    action: text('action').notNull(),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    detail: jsonb('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);

/** Runtime configuration the client can change without a deploy: FX rate, retry limits. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── player accounts, seasons, Level Pass, Vault, badges ───────────────────────
//
// Keyed on `orders.player_id` (the Free Fire UID) rather than a new FK column
// on `orders` — see player_profiles' own comment. Checkpoint thresholds and
// reward diamonds/costs live in `settings` (key-value, already the pattern for
// admin-tunable values), NOT snapshotted onto `seasons`: the one thing that
// must freeze historically is the cost actually paid per grant, which
// `level_pass_checkpoint_events.internal_cost_cents` captures directly.
// Manual overrides use the existing `audit_log` table — no parallel audit
// mechanism — recorded by the adapter in the same transaction as the write.

export const seasonStatus = pgEnum('season_status', ['active', 'closed']);

export const badgeCategory = pgEnum('badge_category', [
  'ranking',
  'level_pass',
  'special',
  'event',
]);

export const badgeRarity = pgEnum('badge_rarity', [
  'common',
  'rare',
  'epic',
  'legendary',
  'exclusive',
]);

/** Shared by badge ownership and Level Pass checkpoint events: who caused it. */
export const awardSource = pgEnum('award_source', ['automatic', 'manual']);

export const rewardStatus = pgEnum('reward_status', ['pending', 'granted', 'reversed']);

export const vaultStatus = pgEnum('vault_status', ['active', 'expired']);

export const ledgerEntryType = pgEnum('ledger_entry_type', [
  'level_pass_reward',
  'manual_expense',
  'manual_income',
]);

/**
 * A persistent player identity, independent of any season. `player_id` is the
 * single linked Free Fire ID that counts for the season ranking. Paid orders
 * may stamp `orders.player_profile_id` so Level Pass / Vault credit this
 * account even when the top-up went to a different Free Fire ID.
 *
 * `lifetime_*` counters are maintained (updated transactionally at order
 * completion), never recalculated by aggregation — the same discipline as
 * every other counter in this schema.
 */
export const playerProfiles = pgTable(
  'player_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: text('player_id').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    avatarAssetUrl: text('avatar_asset_url'),

    lifetimeDiamondsPurchased: integer('lifetime_diamonds_purchased').notNull().default(0),
    lifetimeRechargeCount: integer('lifetime_recharge_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('player_profiles_player_id_idx').on(t.playerId),
    uniqueIndex('player_profiles_email_idx').on(t.email),
    // Only enforced among profiles that have actually set one.
    uniqueIndex('player_profiles_display_name_idx')
      .on(t.displayName)
      .where(sql`display_name IS NOT NULL`),
  ],
);

/** Short-lived email login codes. Never store the code itself, only its hash. */
export const playerOtpCodes = pgTable(
  'player_otp_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('player_otp_codes_email_idx').on(t.email)],
);

/** A 60-day Level Pass / ranking cycle. Exactly one row should be `active`. */
export const seasons = pgTable(
  'seasons',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seasonNumber: integer('season_number').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: seasonStatus('status').notNull().default('active'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('seasons_number_idx').on(t.seasonNumber)],
);

/**
 * One linked-ID change per season. The first change in a season inserts a
 * row; a second attempt finds it and is refused.
 */
export const playerLinkedIdChanges = pgTable(
  'player_linked_id_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerProfileId: uuid('player_profile_id')
      .notNull()
      .references(() => playerProfiles.id, { onDelete: 'restrict' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'restrict' }),
    fromPlayerId: text('from_player_id').notNull(),
    toPlayerId: text('to_player_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('player_linked_id_changes_once_per_season_idx').on(t.playerProfileId, t.seasonId)],
);

/**
 * The maintained per-player, per-season counters: current Level Pass LP and
 * seasonal ranking diamonds. Two independent metrics in one row because
 * they're written together on every eligible order and read together on
 * every profile view — see the spec's explicit warning that LP and ranking
 * diamonds "must never be conflated" despite sharing a lifecycle.
 */
export const seasonPlayerStats = pgTable(
  'season_player_stats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'restrict' }),
    playerProfileId: uuid('player_profile_id')
      .notNull()
      .references(() => playerProfiles.id, { onDelete: 'restrict' }),
    lp: integer('lp').notNull().default(0),
    seasonalDiamonds: integer('seasonal_diamonds').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('season_player_stats_unique_idx').on(t.seasonId, t.playerProfileId),
    // Powers the Top 50 query: one season, ordered by diamonds, limited.
    index('season_player_stats_ranking_idx').on(t.seasonId, t.seasonalDiamonds),
  ],
);

/**
 * The frozen financial calculation behind one order's awarded LP. Stored at
 * order-completion time so a later edit to product cost or pricing can never
 * change what a historical order appears to have earned — the same
 * `comboSnapshot` discipline `orders` already uses, applied to profit/LP.
 */
export const levelPassLpTransactions = pgTable(
  'level_pass_lp_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'restrict' }),
    // Plain columns, not inline `.references()` — see the identical comment
    // on `level_pass_checkpoint_events`; both FK names here also truncate.
    playerProfileId: uuid('player_profile_id').notNull(),

    saleAmountCents: integer('sale_amount_cents').notNull(),
    productCostCents: integer('product_cost_cents').notNull(),
    paymentFeeCents: integer('payment_fee_cents').notNull(),
    estimatedProfitCents: integer('estimated_profit_cents').notNull(),
    calculatedLp: integer('calculated_lp').notNull(),
    awardedLp: integer('awarded_lp').notNull(),

    /** Both null unless an admin manually overrode the calculated LP. */
    overriddenByAdminId: uuid('overridden_by_admin_id'),
    overrideReason: text('override_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('level_pass_lp_tx_order_idx').on(t.orderId),
    index('level_pass_lp_tx_player_season_idx').on(t.playerProfileId, t.seasonId),
    foreignKey({
      columns: [t.playerProfileId],
      foreignColumns: [playerProfiles.id],
      name: 'lp_lp_tx_profile_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.overriddenByAdminId],
      foreignColumns: [adminUsers.id],
      name: 'lp_lp_tx_overridden_admin_fk',
    }).onDelete('set null'),
  ],
);

/**
 * One row per checkpoint a player ever crosses. The unique index is the
 * guard against a double grant — "cannot be granted twice for the same
 * user/season/checkpoint" is enforced by Postgres, not application code.
 */
export const levelPassCheckpointEvents = pgTable(
  'level_pass_checkpoint_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'restrict' }),
    // Plain column, not inline `.references()` — the auto-derived FK name for
    // this table+column pair exceeds Postgres's 63-byte identifier limit and
    // gets silently truncated. Named explicitly below instead.
    playerProfileId: uuid('player_profile_id').notNull(),
    checkpointLp: integer('checkpoint_lp').notNull(),
    rewardDiamonds: integer('reward_diamonds').notNull(),
    /** Frozen at grant time — a later change to this checkpoint's cost must not alter history. */
    internalCostCents: integer('internal_cost_cents').notNull(),
    status: rewardStatus('status').notNull().default('pending'),
    source: awardSource('source').notNull().default('automatic'),
    /** The order whose completion crossed this checkpoint, if any. */
    relatedOrderId: uuid('related_order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    /**
     * The synthetic `$0` order that delivers this specific reward — distinct
     * from `related_order_id`, which is the paid order that crossed the
     * checkpoint. Null until `createPendingRewardOrders` creates one; once
     * set, it never changes — a second attempt is a different concept this
     * schema does not need yet.
     */
    rewardOrderId: uuid('reward_order_id').references(() => orders.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    reachedAt: timestamp('reached_at', { withTimezone: true }).notNull().defaultNow(),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('level_pass_checkpoint_unique_idx').on(
      t.seasonId,
      t.playerProfileId,
      t.checkpointLp,
    ),
    foreignKey({
      columns: [t.playerProfileId],
      foreignColumns: [playerProfiles.id],
      name: 'lp_checkpoint_events_profile_fk',
    }).onDelete('restrict'),
  ],
);

/** One per player per season — closes automatically when the season ends. */
export const vaultEntitlements = pgTable(
  'vault_entitlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'restrict' }),
    playerProfileId: uuid('player_profile_id')
      .notNull()
      .references(() => playerProfiles.id, { onDelete: 'restrict' }),
    status: vaultStatus('status').notNull().default('active'),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('vault_entitlements_unique_idx').on(t.seasonId, t.playerProfileId)],
);

/**
 * The (up to 6) discounted offers shown once the Vault unlocks. Each
 * references an existing public combo so the "normal price vs. Vault price"
 * comparison is always accurate — no duplicated product data to drift.
 */
export const vaultOffers = pgTable(
  'vault_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    comboId: uuid('combo_id')
      .notNull()
      .references(() => combos.id, { onDelete: 'restrict' }),
    vaultPriceMxnCents: integer('vault_price_mxn_cents').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('vault_offers_combo_idx').on(t.comboId)],
);

/**
 * A badge *type* (Top 10, Founder, Level Pass Completed...), not an award.
 * One definition is reused across every season for season-scoped categories —
 * `badge_ownerships.season_id` is what makes "Top 10 — Season 7" a distinct
 * historical record from "Top 10 — Season 2", not a proliferation of rows here.
 */
export const badgeDefinitions = pgTable(
  'badge_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    badgeKey: text('badge_key').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    category: badgeCategory('category').notNull(),
    rarity: badgeRarity('rarity').notNull().default('common'),
    artworkAssetUrl: text('artwork_asset_url'),
    seasonScoped: boolean('season_scoped').notNull().default(false),
    /** Null means always obtainable (subject to `obtainable`); set for Founder. */
    eligibilityStartsAt: timestamp('eligibility_starts_at', { withTimezone: true }),
    eligibilityEndsAt: timestamp('eligibility_ends_at', { withTimezone: true }),
    obtainable: boolean('obtainable').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('badge_definitions_key_idx').on(t.badgeKey)],
);

/**
 * One real historical achievement. `revokedAt` rather than deletion — a
 * revoked badge still answers "did this ever happen" for audit purposes.
 *
 * Two partial unique indexes instead of one plain unique index: Postgres
 * treats every NULL as distinct, so a plain `unique(player, badge, season)`
 * would silently allow the same non-seasonal badge (Founder) to be granted
 * to one player any number of times, since every row would have `season_id
 * IS NULL` and NULLs never compare equal to each other.
 */
export const badgeOwnerships = pgTable(
  'badge_ownerships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerProfileId: uuid('player_profile_id')
      .notNull()
      .references(() => playerProfiles.id, { onDelete: 'restrict' }),
    badgeDefinitionId: uuid('badge_definition_id')
      .notNull()
      .references(() => badgeDefinitions.id, { onDelete: 'restrict' }),
    seasonId: uuid('season_id').references(() => seasons.id, { onDelete: 'restrict' }),
    achievementData: jsonb('achievement_data'),
    source: awardSource('source').notNull().default('automatic'),
    awardedByAdminId: uuid('awarded_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    earnedAt: timestamp('earned_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('badge_ownerships_seasonal_unique_idx')
      .on(t.playerProfileId, t.badgeDefinitionId, t.seasonId)
      .where(sql`season_id IS NOT NULL`),
    uniqueIndex('badge_ownerships_evergreen_unique_idx')
      .on(t.playerProfileId, t.badgeDefinitionId)
      .where(sql`season_id IS NULL`),
    index('badge_ownerships_player_idx').on(t.playerProfileId),
  ],
);

/** Which owned badges a player has chosen to show on their banner, and in what order. */
export const featuredBadges = pgTable(
  'featured_badges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerProfileId: uuid('player_profile_id')
      .notNull()
      .references(() => playerProfiles.id, { onDelete: 'cascade' }),
    badgeOwnershipId: uuid('badge_ownership_id')
      .notNull()
      .references(() => badgeOwnerships.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('featured_badges_unique_idx').on(t.playerProfileId, t.badgeOwnershipId)],
);

/**
 * The podium frozen at season close, with the nickname/avatar as they stood
 * at that moment — a later profile-picture or display-name change must not
 * rewrite how a past Hall of Fame entry is remembered.
 */
export const hallOfFameEntries = pgTable(
  'hall_of_fame_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seasonId: uuid('season_id')
      .notNull()
      .references(() => seasons.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    playerProfileId: uuid('player_profile_id')
      .notNull()
      .references(() => playerProfiles.id, { onDelete: 'restrict' }),
    displayNameSnapshot: text('display_name_snapshot'),
    avatarAssetUrlSnapshot: text('avatar_asset_url_snapshot'),
    seasonalDiamonds: integer('seasonal_diamonds').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('hall_of_fame_unique_idx').on(t.seasonId, t.position)],
);

/**
 * The single ledger backing every Level-Pass-adjacent financial report
 * (daily P&L, reward ledger, profit-vs-reward-cost). Sales-side profit is
 * already fully derivable from `orders`/`order_items`/`payments`; this table
 * exists for what those don't capture: reward cost and manual adjustments.
 */
export const financialLedgerEntries = pgTable(
  'financial_ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    entryType: ledgerEntryType('entry_type').notNull(),
    /** Signed: reward/expense rows are negative, manual income is positive. */
    amountCents: integer('amount_cents').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    seasonId: uuid('season_id').references(() => seasons.id, { onDelete: 'set null' }),
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    note: text('note'),
    createdByAdminId: uuid('created_by_admin_id').references(() => adminUsers.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('financial_ledger_occurred_idx').on(t.occurredAt)],
);
