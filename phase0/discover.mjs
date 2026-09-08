#!/usr/bin/env node
/**
 * LevelUp Store — Phase 0 discovery
 *
 * Answers the questions that decide the architecture, before a line of
 * fulfillment code gets written:
 *
 *   1. Is Free Fire sold as a direct top-up, or only as redeemable PINs?
 *   2. Which endpoint serves it — /buy/games or /buy/pins?
 *   3. Can we validate a player ID and show their nickname before charging?
 *   4. Is a Server ID required at checkout?
 *   5. What do the six base denominations actually cost in USD?
 *   6. Do the 19 combos hold up on diamonds delivered and on margin?
 *
 * Runs with no API key: performs the offline combo audit only (question 6).
 * Runs with an API key: everything.
 *
 * Never spends money unless BOTH --test-purchase and RA_CONFIRM_SPEND=yes are given.
 *
 * Usage (PowerShell):
 *   $env:RA_API_KEY = "ra_..."
 *   $env:RA_TEST_PLAYER_ID = "123456789"
 *   & "C:\Program Files\nodejs\node.exe" phase0\discover.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_DENOMINATIONS,
  BONUS_PCT,
  auditAll,
  usedDenominations,
  maxCallsPerOrder,
} from './catalog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'out');

const BASE_URL = process.env.RA_BASE_URL ?? 'https://panel.recargasamerica.com/api/v1';
const API_KEY = process.env.RA_API_KEY ?? '';
const TEST_PLAYER_ID = process.env.RA_TEST_PLAYER_ID ?? '';
const FX_USD_MXN = Number(process.env.FX_USD_MXN ?? 18.5);
const FX_IS_DEFAULT = process.env.FX_USD_MXN === undefined;
const REQUEST_TIMEOUT_MS = 20_000;

const args = process.argv.slice(2);
const wantsPurchaseTest = args.includes('--test-purchase');
const spendConfirmed = process.env.RA_CONFIRM_SPEND === 'yes';

/** Everything observed this run. Written to disk verbatim so nothing is lost. */
const findings = {
  startedAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  mode: API_KEY ? 'live' : 'offline',
  fxUsdMxn: FX_USD_MXN,
  fxIsDefault: FX_IS_DEFAULT,
  calls: [],
  wallet: null,
  freeFireProducts: { games: [], pins: [] },
  denominationMap: {},
  validation: null,
  purchaseTest: null,
  /** 'direct_topup' | 'pin_code' | 'unknown' — decided by the live purchase test. */
  deliveryMode: 'unknown',
  stockSignal: null,
  comboAudit: [],
  verdict: null,
  openQuestions: [],
};

// ── output helpers ────────────────────────────────────────────────────────────

const OK = '[ OK ]';
const WARN = '[WARN]';
const FAIL = '[FAIL]';
const INFO = '[ .. ]';

const log = (...a) => console.log(...a);
const section = (title) => log(`\n${'─'.repeat(74)}\n${title}\n${'─'.repeat(74)}`);
const money = (n, dp = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(dp) : '—');
const pad = (s, w) => String(s ?? '').padEnd(w);
const padL = (s, w) => String(s ?? '').padStart(w);

// ── provider client ───────────────────────────────────────────────────────────

/**
 * One provider request. Records timing and the raw body on every path,
 * including failures — the whole point of Phase 0 is the raw evidence.
 */
async function api(method, path, body) {
  const url = `${BASE_URL}${path}`;
  const started = Date.now();
  const record = { method, path, startedAt: new Date().toISOString() };

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* non-JSON response is itself a finding — keep the text */
    }

    Object.assign(record, {
      httpStatus: res.status,
      ok: res.ok,
      durationMs: Date.now() - started,
      body: parsed ?? text.slice(0, 2000),
    });
    findings.calls.push(record);
    return record;
  } catch (err) {
    Object.assign(record, {
      httpStatus: null,
      ok: false,
      durationMs: Date.now() - started,
      error: err.name === 'TimeoutError' ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : String(err),
    });
    findings.calls.push(record);
    return record;
  }
}

const dataOf = (record) => (record.ok && record.body?.success ? record.body.data : null);

// ── product parsing ───────────────────────────────────────────────────────────

const isFreeFire = (text) => /free\s*fire|\bff\b/i.test(String(text ?? ''));

/**
 * Pull a diamond count out of a product name.
 * Handles "1060 Diamonds", "1.060 Diamantes", "2180💎", "Free Fire (MY) 5600".
 */
function extractDiamonds(text) {
  if (!text) return null;
  const norm = String(text).replace(/(\d)[.,](\d{3})\b/g, '$1$2');

  const adjacent = norm.match(/(\d{2,6})\s*(?:x\s*)?(?:💎|diamond|diamante|dias?\b)/i);
  if (adjacent) return Number(adjacent[1]);

  const numbers = [...norm.matchAll(/\d{2,6}/g)].map((m) => Number(m[0]));
  return numbers.find((n) => BASE_DENOMINATIONS.includes(n)) ?? null;
}

/** Normalise a games-catalog entry into the shape the report expects. */
function normaliseGame(p) {
  const label = [p.game, p.package].filter(Boolean).join(' ');
  const inputFields = Array.isArray(p.input_fields) ? p.input_fields : [];
  return {
    source: 'games',
    id: p.id,
    label,
    priceUsd: typeof p.price === 'number' ? p.price : null,
    diamonds: extractDiamonds(label),
    inputFields: inputFields.map((f) => ({ name: f.name, label: f.label })),
    requiresServerId: inputFields.some((f) => /server/i.test(`${f.label} ${f.name}`)),
    canValidate: false, // /pins/validate rejects anything that is not a pins recharge
    raw: p,
  };
}

/** Normalise a pins-catalog entry. `type` decides whether this is usable at all. */
function normalisePin(p) {
  const label = [p.name, p.sku].filter(Boolean).join(' ');
  return {
    source: 'pins',
    id: p.id,
    sku: p.sku ?? null,
    type: p.type ?? null,
    label: p.name ?? label,
    priceUsd: typeof p.price === 'number' ? p.price : null,
    diamonds: extractDiamonds(label),
    inputFields: [],
    requiresServerId: false,
    canValidate: p.type === 'recharge',
    raw: p,
  };
}

// ── discovery steps ───────────────────────────────────────────────────────────

async function checkWallet() {
  section('1. Wallet — auth check and starting balance');

  const res = await api('GET', '/wallet');
  if (!res.ok) {
    log(`${FAIL} GET /wallet -> ${res.httpStatus ?? res.error}`);
    log('       Auth failed or the panel is unreachable. Nothing else can run.');
    return false;
  }

  const data = dataOf(res);
  findings.wallet = data;
  log(`${OK} Balance: ${money(data?.balance)} ${data?.currency ?? '?'}   (${res.durationMs}ms)`);

  if (data?.currency && data.currency !== 'USD') {
    findings.openQuestions.push(`Wallet currency is ${data.currency}, not the documented USD.`);
  }

  // A single Mega Prime 48k order can exceed a modest prepaid balance outright.
  if (typeof data?.balance === 'number' && data.balance < 100) {
    log(`${WARN} Balance is low. Large combos may fail mid-order — see the wallet monitor in Phase 2.`);
  }
  return true;
}

async function fetchCatalog() {
  section('2. Catalog — where does Free Fire actually live?');

  const games = await api('GET', '/products/games');
  const pins = await api('GET', '/products/pins');

  if (games.ok) {
    const all = dataOf(games) ?? [];
    findings.freeFireProducts.games = all
      .filter((p) => isFreeFire(`${p.game} ${p.package}`))
      .map(normaliseGame);
    log(`${OK} /products/games -> ${all.length} products, ${findings.freeFireProducts.games.length} Free Fire`);
  } else {
    log(`${FAIL} /products/games -> ${games.httpStatus ?? games.error}`);
  }

  if (pins.ok) {
    const all = dataOf(pins) ?? [];
    findings.freeFireProducts.pins = all
      .filter((p) => isFreeFire(`${p.name} ${p.sku}`))
      .map(normalisePin);
    log(`${OK} /products/pins  -> ${all.length} products, ${findings.freeFireProducts.pins.length} Free Fire`);
  } else {
    log(`${FAIL} /products/pins  -> ${pins.httpStatus ?? pins.error}`);
  }

  const found = [...findings.freeFireProducts.games, ...findings.freeFireProducts.pins];
  if (found.length === 0) {
    log(`${FAIL} No Free Fire products found. Check the reseller account's enabled catalog.`);
    return found;
  }

  log('');
  log(`  ${pad('SOURCE', 8)}${pad('ID', 8)}${pad('TYPE', 10)}${padL('USD', 9)}  ${padL('💎', 7)}  NAME`);
  for (const p of found) {
    log(
      `  ${pad(p.source, 8)}${pad(p.id, 8)}${pad(p.type ?? 'game', 10)}` +
        `${padL(money(p.priceUsd), 9)}  ${padL(p.diamonds ?? '?', 7)}  ${p.label}`,
    );
  }

  // Streaming products carry `stock` / `available`; games and pins carry neither.
  // If that holds here, wallet balance is our ONLY pre-flight signal and every
  // other failure surfaces as a 502 after the customer has already paid.
  const anyStockField = found.some(
    (p) => p.raw?.stock !== undefined || p.raw?.available !== undefined,
  );
  findings.stockSignal = anyStockField ? 'present' : 'absent';
  if (!anyStockField) {
    log(`\n${WARN} No stock/availability field on any Free Fire product.`);
    log('       Wallet balance is the only pre-flight check we get. Everything else');
    log('       fails at purchase time, after payment. Pre-flight balance gating is');
    log('       therefore mandatory, not optional.');
  }

  const serverIdNeeded = findings.freeFireProducts.games.filter((p) => p.requiresServerId);
  if (serverIdNeeded.length) {
    log(`\n${WARN} Server ID is required by ${serverIdNeeded.length} game package(s).`);
    log('       Checkout needs a second field the client does not collect today.');
    findings.openQuestions.push('Server ID required at checkout — confirm the value for MX/LATAM players.');
  }

  return found;
}

/** Pick the best product for each of the six denominations, preferring direct top-up + validation. */
function mapDenominations(products) {
  section('3. Denomination mapping — all six base SKUs');

  const rank = (p) => {
    if (p.source === 'pins' && p.type === 'recharge') return 0; // direct top-up + validation
    if (p.source === 'games') return 1; // direct top-up, no validation
    return 2; // type=pin — redeemable code, not a top-up
  };

  log(`  ${pad('💎 BASE', 10)}${pad('DELIVERED', 11)}${pad('PATH', 18)}${pad('ID', 8)}${padL('USD', 9)}  STATUS`);

  for (const denomination of BASE_DENOMINATIONS) {
    const candidates = products
      .filter((p) => p.diamonds === denomination)
      .sort((a, b) => rank(a) - rank(b));
    const best = candidates[0] ?? null;

    const path = best
      ? best.source === 'games'
        ? '/buy/games'
        : `/buy/pins (${best.type})`
      : '—';

    let status = `${FAIL} not found`;
    if (best && rank(best) === 0) status = `${OK} top-up + validate`;
    else if (best && rank(best) === 1) status = `${WARN} top-up, no validate`;
    else if (best) status = `${FAIL} PIN code only`;

    findings.denominationMap[denomination] = best
      ? {
          productId: best.id,
          source: best.source,
          type: best.type ?? 'game',
          costUsd: best.priceUsd,
          canValidate: best.canValidate,
          requiresServerId: best.requiresServerId,
          label: best.label,
          alternatives: candidates.length - 1,
        }
      : null;

    log(
      `  ${pad(denomination, 10)}${pad((denomination * (100 + BONUS_PCT)) / 100, 11)}` +
        `${pad(path, 18)}${pad(best?.id ?? '—', 8)}${padL(money(best?.priceUsd), 9)}  ${status}`,
    );
  }

  const missing = BASE_DENOMINATIONS.filter((d) => !findings.denominationMap[d]);
  if (missing.length) {
    findings.openQuestions.push(`Denominations with no provider product: ${missing.join(', ')}.`);
  }
  return missing;
}

async function testValidation() {
  section('4. Player ID validation — the nickname confirmation gate');

  const rechargeProduct = Object.values(findings.denominationMap).find((m) => m?.canValidate);

  if (!rechargeProduct) {
    log(`${WARN} No Free Fire product of type=recharge, so /pins/validate cannot be used.`);
    log('       Consequence: no nickname confirmation before payment. A mistyped ID');
    log('       sends diamonds to a stranger, irreversibly.');
    findings.validation = { available: false, reason: 'no recharge-type Free Fire product' };
    findings.openQuestions.push(
      'No pre-purchase player validation available — ask the provider whether a recharge-type FF SKU exists.',
    );
    return;
  }

  if (!TEST_PLAYER_ID) {
    log(`${INFO} Skipped: set RA_TEST_PLAYER_ID to a real Free Fire ID to test.`);
    findings.validation = { available: 'untested', productId: rechargeProduct.productId };
    return;
  }

  const res = await api('POST', '/pins/validate', {
    product_id: rechargeProduct.productId,
    service_user_id: TEST_PLAYER_ID,
  });

  const data = dataOf(res);
  if (res.ok && data?.status === true) {
    log(`${OK} ID ${TEST_PLAYER_ID} -> "${data.account_name}"  (${res.durationMs}ms)`);
    log('       Nickname confirmation is available. This is the strongest trust signal');
    log('       in the whole checkout, and it prevents unrecoverable mis-sends.');
    findings.validation = { available: true, accountName: data.account_name, latencyMs: res.durationMs };
  } else if (res.ok && data?.status === false) {
    log(`${WARN} ID ${TEST_PLAYER_ID} returned status=false (account not found).`);
    log('       Endpoint works; re-test with a known-good ID to confirm the happy path.');
    findings.validation = { available: true, accountName: null, note: 'test ID not found' };
  } else {
    log(`${FAIL} /pins/validate -> ${res.httpStatus ?? res.error} ${JSON.stringify(res.body ?? '')}`);
    findings.validation = { available: false, reason: `HTTP ${res.httpStatus ?? res.error}` };
  }
}

/**
 * Optional live purchase of the cheapest denomination.
 *
 * Also the first real proof of the wallet-delta reconciliation technique the
 * whole fulfillment engine depends on: if balance drops by exactly the charged
 * amount, an ambiguous timeout can be resolved without an idempotency key.
 */
async function testPurchase() {
  section('5. Live purchase test — wallet-delta proof');

  if (!wantsPurchaseTest) {
    log(`${INFO} Skipped. Pass --test-purchase (and RA_CONFIRM_SPEND=yes) to run it.`);
    return;
  }
  if (!spendConfirmed) {
    log(`${FAIL} --test-purchase given without RA_CONFIRM_SPEND=yes. Refusing to spend money.`);
    return;
  }
  if (!TEST_PLAYER_ID) {
    log(`${FAIL} RA_TEST_PLAYER_ID is required for a purchase test.`);
    return;
  }

  const target = findings.denominationMap[100];
  if (!target) {
    log(`${FAIL} No product mapped for 100 diamonds; not risking a larger denomination.`);
    return;
  }

  log(`${WARN} Spending real balance: ${target.label} (~$${money(target.costUsd)} USD)`);

  const before = dataOf(await api('GET', '/wallet'))?.balance ?? null;

  const isGame = target.source === 'games';
  const body = isGame
    ? { package_id: target.productId, input1: TEST_PLAYER_ID, client_name: 'LU-PHASE0-TEST' }
    : { product_id: target.productId, redemption_id: TEST_PLAYER_ID, client_name: 'LU-PHASE0-TEST' };

  // The docs shout: "NUNCA se mandan quantity y redemption_id juntos."
  // Assert it at the boundary rather than trusting the caller.
  if (body.quantity !== undefined && body.redemption_id !== undefined) {
    log(`${FAIL} Refusing to send quantity and redemption_id together.`);
    return;
  }

  const purchase = await api('POST', isGame ? '/buy/games' : '/buy/pins', body);

  const after = dataOf(await api('GET', '/wallet'))?.balance ?? null;
  const data = dataOf(purchase);
  const delta = before !== null && after !== null ? before - after : null;

  findings.purchaseTest = {
    endpoint: isGame ? '/buy/games' : '/buy/pins',
    httpStatus: purchase.httpStatus,
    durationMs: purchase.durationMs,
    response: purchase.body,
    walletBefore: before,
    walletAfter: after,
    walletDelta: delta,
    amountCharged: data?.amount_charged ?? null,
    providerStatus: data?.status ?? null,
    providerReference: data?.reference ?? null,
  };

  log(`  HTTP ${purchase.httpStatus} in ${purchase.durationMs}ms`);
  log(`  status:        ${data?.status ?? '(not returned)'}`);
  log(`  reference:     ${data?.reference ?? '(not returned — order is NOT pollable)'}`);
  log(`  amount_charged:${money(data?.amount_charged)} USD`);
  log(`  wallet:        ${money(before)} -> ${money(after)}  (delta ${money(delta, 4)})`);

  // THE decisive check. The docs contradict themselves: /buy/games shows
  // "pins": [] for Free Fire 100 Diamonds, while /orders/{ref} shows
  // "pins": ["ABC-123"] for the same product. A populated array means the
  // customer receives a code to redeem, not diamonds in their account —
  // which breaks the "recarga directa al ID" premise the project rests on.
  const pins = Array.isArray(data?.pins) ? data.pins : null;
  findings.purchaseTest.pinsReturned = pins;

  if (!isGame) {
    // type=recharge posts a redemption_id straight to the player account.
    findings.deliveryMode = 'direct_topup';
    log(`  delivery:      direct top-up (type=recharge)`);
  } else if (pins === null) {
    findings.deliveryMode = 'unknown';
    log(`  delivery:      UNKNOWN — no pins field in the response`);
  } else if (pins.length > 0) {
    findings.deliveryMode = 'pin_code';
    log(`  delivery:      PIN CODE — response carried ${pins.length} code(s)`);
    log(`\n${FAIL} The customer receives a redeemable code, not an automatic top-up.`);
    log('       This breaks the core premise. Stop and escalate to the client today.');
    findings.openQuestions.push(
      'Purchase returned PIN codes rather than a direct top-up — the "recarga directa al ID" model does not hold on this path.',
    );
  } else {
    findings.deliveryMode = 'direct_topup';
    log(`  delivery:      direct top-up (pins array empty, as expected)`);
  }

  // Confirm the player actually received the diamonds before trusting any of this.
  log(`\n${INFO} Verify in-game that ID ${TEST_PLAYER_ID} received the diamonds.`);

  if (delta !== null && data?.amount_charged != null) {
    const matches = Math.abs(delta - data.amount_charged) < 0.0001;
    log(
      matches
        ? `\n${OK} Wallet delta matches amount_charged exactly.\n` +
            '       Ambiguous timeouts can be resolved by balance comparison. This is the\n' +
            '       safety property the fulfillment engine is built on — confirmed.'
        : `\n${WARN} Wallet delta does not match amount_charged. Reconciliation needs rethinking.`,
    );
    findings.purchaseTest.walletDeltaMatches = matches;
  }

  if (!data?.reference) {
    findings.openQuestions.push(
      'Purchase returns no reference — status cannot be polled. Ask the provider for an idempotency key and a transactions-list endpoint.',
    );
  }
}

// ── offline combo audit ───────────────────────────────────────────────────────

function auditCombos() {
  section('6. Combo audit — delivered vs advertised, and margin');

  const costByDenomination = {};
  for (const [d, m] of Object.entries(findings.denominationMap)) {
    if (typeof m?.costUsd === 'number') costByDenomination[Number(d)] = m.costUsd;
  }
  const haveCosts = Object.keys(costByDenomination).length > 0;
  const audit = auditAll(haveCosts ? costByDenomination : undefined, FX_USD_MXN);
  findings.comboAudit = audit;

  if (!haveCosts) {
    log(`${INFO} No provider costs available — diamond audit only, margins skipped.`);
  } else if (FX_IS_DEFAULT) {
    log(`${WARN} FX_USD_MXN not set; assuming ${FX_USD_MXN}. Set it for real margins.`);
  }

  log('');
  log(
    `  ${pad('COMBO', 26)}${padL('MXN', 7)}${padL('CALLS', 7)}${padL('ADVERT', 9)}` +
      `${padL('DELIV', 9)}${padL('GAP', 7)}${padL('MERCADO', 10)}${padL('AHORRO', 9)}${padL('%', 7)}`,
  );

  let currentCampaign = null;
  for (const c of audit) {
    if (c.campaignName !== currentCampaign) {
      currentCampaign = c.campaignName;
      log(`  ${currentCampaign}`);
    }
    const flags =
      (c.shortfall ? ' <-- SHORTFALL' : '') + (c.pricedAboveMarket ? ' <-- OVER MARKET' : '');
    log(
      `  ${pad('  ' + c.name, 26)}${padL(c.priceMxn, 7)}${padL(c.callCount, 7)}` +
        `${padL(c.advertised.toLocaleString('en-US'), 9)}${padL(c.delivered.toLocaleString('en-US'), 9)}` +
        `${padL(c.gap > 0 ? `+${c.gap}` : c.gap, 7)}${padL(money(c.marketMxn), 10)}` +
        `${padL(money(c.savingMxn), 9)}${padL(money(c.savingPct, 1), 7)}${flags}`,
    );
  }

  const shortfalls = audit.filter((c) => c.shortfall);
  const unconfirmed = audit.filter((c) => c.needsConfirmation);
  const overMarket = audit.filter((c) => c.pricedAboveMarket);
  const thinMargin = audit.filter((c) => typeof c.marginPct === 'number' && c.marginPct < 5);

  if (overMarket.length) {
    log('');
    log(`${FAIL} ${overMarket.length} combo(s) cost MORE than buying the same diamonds elsewhere:`);
    for (const c of overMarket) {
      log(
        `       ${pad(c.name, 26)} $${c.priceMxn} vs $${money(c.marketMxn)} at market ` +
          `(customer pays $${money(-c.savingMxn)} extra)`,
      );
    }
    log('       The combo model only works when the bundle beats buying the parts.');
  }

  log('');
  if (shortfalls.length) {
    log(`${FAIL} ${shortfalls.length} combo(s) deliver LESS than advertised:`);
    for (const c of shortfalls) {
      log(`       ${pad(c.name, 26)} advertised ${c.advertised}, delivers ${c.delivered} (${c.gap})`);
    }
    log('       Fix the advertised figure or the recipe before launch. The admin');
    log('       panel will block publishing these once the validator is in place.');
  } else {
    log(`${OK} Every combo delivers at least what it advertises.`);
  }

  if (unconfirmed.length) {
    log(`\n${WARN} ${unconfirmed.length} advertised count(s) were read from flyer images, not confirmed by the client:`);
    log(`       ${unconfirmed.map((c) => c.name).join(', ')}`);
  }

  if (thinMargin.length) {
    log(`\n${WARN} ${thinMargin.length} combo(s) under 5% margin: ${thinMargin.map((c) => c.name).join(', ')}`);
  }

  return { shortfalls, unconfirmed, thinMargin };
}

// ── verdict ───────────────────────────────────────────────────────────────────

function decide(missingDenominations) {
  section('DECISION GATE');

  if (findings.mode === 'offline') {
    findings.verdict = { status: 'PENDING', reason: 'No API key — live discovery not run.' };
    log(`${INFO} Offline run. The combo audit above is final; the integration path is not.`);
    log('       Set RA_API_KEY and re-run to resolve the architecture questions.');
    return;
  }

  const mapped = Object.values(findings.denominationMap).filter(Boolean);
  const pinOnly = mapped.filter((m) => m.type === 'pin');
  const canValidate = mapped.some((m) => m.canValidate);

  if (findings.deliveryMode === 'pin_code') {
    findings.verdict = {
      status: 'BLOCKED',
      reason: 'Purchase returns redeemable PIN codes, not an automatic top-up.',
    };
    log(`${FAIL} BLOCKED — the live purchase returned a code, not diamonds.`);
    log('       Escalate today: this needs a different product or a different provider.');
  } else if (missingDenominations.length === BASE_DENOMINATIONS.length) {
    findings.verdict = { status: 'BLOCKED', reason: 'No Free Fire products available on this account.' };
    log(`${FAIL} BLOCKED — no Free Fire catalog. Escalate to the client today.`);
  } else if (pinOnly.length === mapped.length) {
    findings.verdict = { status: 'BLOCKED', reason: 'Free Fire is only sold as redeemable PIN codes.' };
    log(`${FAIL} BLOCKED — PIN codes only, no direct top-up.`);
    log('       The entire "recarga directa al ID" premise does not hold. Stop and');
    log('       escalate: the client needs a different provider or a different product.');
  } else if (missingDenominations.length) {
    findings.verdict = {
      status: 'PARTIAL',
      reason: `Missing denominations: ${missingDenominations.join(', ')}`,
    };
    log(`${WARN} PARTIAL — ${missingDenominations.join(', ')} unavailable.`);
    log('       Combos using them cannot be fulfilled. Recipes need reworking.');
  } else if (!canValidate) {
    findings.verdict = { status: 'GO_NO_VALIDATION', reason: 'Direct top-up works; no pre-purchase validation.' };
    log(`${WARN} GO, with a caveat — direct top-up works, player validation does not.`);
    log('       Build the checkout with a hard double-entry confirmation of the ID');
    log('       instead of the nickname gate, and warn the customer that mis-typed');
    log('       IDs cannot be recovered.');
  } else {
    findings.verdict = { status: 'GO', reason: 'Direct top-up plus pre-purchase validation on all six SKUs.' };
    log(`${OK} GO — all six denominations available as direct top-ups with validation.`);
    log('       Proceed to Phase 1 as planned.');
  }

  if (findings.openQuestions.length) {
    log('\nOpen questions for the client or provider:');
    findings.openQuestions.forEach((q, i) => log(`  ${i + 1}. ${q}`));
  }
}

// ── report ────────────────────────────────────────────────────────────────────

function writeReport() {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  const jsonPath = join(OUT_DIR, `discovery-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(findings, null, 2), 'utf8');

  const a = findings.comboAudit;
  const shortfalls = a.filter((c) => c.shortfall);
  const row = (c) =>
    `| ${c.campaignName} | ${c.name} | $${c.priceMxn} | ${c.callCount} | ` +
    `${c.advertised.toLocaleString('en-US')} | ${c.delivered.toLocaleString('en-US')} | ` +
    `${c.gap > 0 ? '+' : ''}${c.gap} | ${c.marginMxn != null ? '$' + money(c.marginMxn) : '—'} | ` +
    `${c.marginPct != null ? money(c.marginPct, 1) + '%' : '—'} |`;

  const md = `# Phase 0 — Discovery Report

- **Generated:** ${findings.startedAt}
- **Mode:** ${findings.mode}${findings.mode === 'offline' ? ' (no API key — combo audit only)' : ''}
- **Verdict:** \`${findings.verdict?.status ?? 'PENDING'}\` — ${findings.verdict?.reason ?? ''}
- **FX assumed:** ${findings.fxUsdMxn} MXN/USD${findings.fxIsDefault ? ' *(default — set FX_USD_MXN)*' : ''}
${findings.wallet ? `- **Wallet:** ${money(findings.wallet.balance)} ${findings.wallet.currency}` : ''}

## Integration path

| 💎 Base | Delivered | Product ID | Path | Type | Cost USD | Validate |
|---|---|---|---|---|---|---|
${BASE_DENOMINATIONS.map((d) => {
  const m = findings.denominationMap[d];
  return `| ${d} | ${(d * (100 + BONUS_PCT)) / 100} | ${m?.productId ?? '—'} | ${
    m ? (m.source === 'games' ? '/buy/games' : '/buy/pins') : '—'
  } | ${m?.type ?? '—'} | ${m ? '$' + money(m.costUsd) : '—'} | ${m?.canValidate ? 'yes' : 'no'} |`;
}).join('\n')}

**Player validation:** ${
    findings.validation === null
      ? 'not checked (offline run)'
      : findings.validation.available === true
        ? `available${findings.validation.accountName ? ` — returned "${findings.validation.accountName}"` : ''}`
        : findings.validation.available === 'untested'
          ? 'untested (set RA_TEST_PLAYER_ID)'
          : `unavailable — ${findings.validation.reason}`
  }

**Max provider calls in one order:** ${maxCallsPerOrder()}
**Denominations used by the catalog:** ${usedDenominations().join(', ')}

## Combo audit

| Campaign | Combo | Price | Calls | Advertised | Delivered | Gap | Margin | % |
|---|---|---|---|---|---|---|---|---|
${a.map(row).join('\n')}

${
  shortfalls.length
    ? `### ⚠ Combos delivering less than advertised\n\n${shortfalls
        .map((c) => `- **${c.name}** — advertised ${c.advertised}, delivers ${c.delivered} (**${c.gap}**)`)
        .join('\n')}\n\nFix the advertised figure or the recipe before launch.`
    : '### ✅ Every combo delivers at least what it advertises.'
}

## Open questions

${findings.openQuestions.length ? findings.openQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n') : '_None recorded._'}

## Raw evidence

${findings.calls.length} provider call(s) recorded in \`${jsonPath.split(/[\\/]/).pop()}\`.
`;

  const mdPath = join(OUT_DIR, 'REPORT.md');
  writeFileSync(mdPath, md, 'utf8');

  section('OUTPUT');
  log(`  ${mdPath}`);
  log(`  ${jsonPath}`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('LevelUp Store — Phase 0 Discovery');
  log(`${BASE_URL}   mode: ${findings.mode}`);

  let missing = BASE_DENOMINATIONS;

  if (!API_KEY) {
    section('LIVE DISCOVERY SKIPPED');
    log(`${INFO} RA_API_KEY is not set, so steps 1-5 cannot run.`);
    log('       The combo audit below needs no API access and is final.');
  } else {
    if (!(await checkWallet())) {
      writeReport();
      process.exitCode = 1;
      return;
    }
    const products = await fetchCatalog();
    missing = mapDenominations(products);
    await testValidation();
    await testPurchase();
  }

  auditCombos();
  decide(missing);
  writeReport();
}

main().catch((err) => {
  console.error('\nDiscovery failed:', err);
  process.exitCode = 1;
});
