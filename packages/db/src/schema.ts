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
    /** From /pins/validate. Shown as "¿Eres tú, X?" and kept as evidence. */
    playerNickname: text('player_nickname'),
    serverId: text('server_id'),

    contactEmail: text('contact_email'),
    contactWhatsapp: text('contact_whatsapp'),

    comboId: uuid('combo_id').references(() => combos.id, { onDelete: 'set null' }),
    /** Denormalised so the Mega Oferta partial unique index can reference it. */
    comboKey: text('combo_key').notNull(),

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

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('orders_number_idx').on(t.orderNumber),
    index('orders_player_idx').on(t.playerId),
    index('orders_status_idx').on(t.status),

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
