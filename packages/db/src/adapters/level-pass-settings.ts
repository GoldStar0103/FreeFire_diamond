/**
 * Level Pass checkpoint configuration: LP thresholds, the diamonds awarded at
 * each, the internal cost frozen onto the grant, and the delivery recipe —
 * the same settings-row pattern as `getFxRate`/`saveFxRate` in
 * payment-settings.ts, for the same reason: a business value the owner must
 * be able to change without a redeploy, with a safe default so an
 * unconfigured deployment still works.
 *
 * Changing this does NOT retroactively change history: every grant already
 * recorded keeps the cost it was actually given, in
 * `level_pass_checkpoint_events.internal_cost_cents` — see schema.ts's own
 * comment on why this config is not snapshotted onto `seasons`.
 *
 * The recipe is resolved and pinned at save time, exactly like a combo's —
 * see `saveLevelPassCheckpoints` — so `LevelPassCheckpointConfig` (what gets
 * persisted and read back) carries real `baseProductId`s, while the admin
 * form only ever deals in plain denominations (`LevelPassCheckpointDraft`).
 */

import { eq } from 'drizzle-orm';
import { checkRecipe } from '@levelup/shared/money';
import type { LevelPassCheckpointConfig } from '@levelup/engine';
import type { Database } from '../index.js';
import { baseProducts, settings } from '../schema.js';

export const LEVEL_PASS_CHECKPOINTS_KEY = 'level_pass_checkpoints';

/**
 * The LP/reward/cost numbers are the spec's own worked example. `recipe` is
 * deliberately empty rather than a guessed provider SKU — reward delivery
 * treats an empty recipe as "unresolved" and alerts instead of guessing, so
 * an unconfigured deployment fails loudly in /temporadas rather than
 * fabricating what the provider actually sells.
 */
export const DEFAULT_LEVEL_PASS_CHECKPOINTS: LevelPassCheckpointConfig[] = [
  { lp: 60, rewardDiamonds: 110, costCents: 1_200, recipe: [] },
  { lp: 260, rewardDiamonds: 340, costCents: 4_000, recipe: [] },
  { lp: 585, rewardDiamonds: 570, costCents: 6_500, recipe: [] },
  { lp: 1_185, rewardDiamonds: 1_160, costCents: 12_000, recipe: [] },
];

function isCheckpointList(value: unknown): value is LevelPassCheckpointConfig[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (v): v is LevelPassCheckpointConfig =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as Record<string, unknown>).lp === 'number' &&
      typeof (v as Record<string, unknown>).rewardDiamonds === 'number' &&
      typeof (v as Record<string, unknown>).costCents === 'number' &&
      Array.isArray((v as Record<string, unknown>).recipe),
  );
}

export async function getLevelPassCheckpoints(db: Database): Promise<LevelPassCheckpointConfig[]> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, LEVEL_PASS_CHECKPOINTS_KEY))
    .limit(1);

  return isCheckpointList(row?.value) ? row.value : DEFAULT_LEVEL_PASS_CHECKPOINTS;
}

export interface CheckpointIssue {
  index: number;
  message: string;
}

/**
 * What the admin form actually edits: plain denominations, the same shape
 * `ComboDraft.recipe` uses, resolved to real `base_products` rows only at
 * save time (`saveLevelPassCheckpoints`) — not the pinned
 * `LevelPassCheckpointConfig` shape this module reads back.
 */
export interface LevelPassCheckpointDraft {
  lp: number;
  rewardDiamonds: number;
  costCents: number;
  recipe: number[];
}

/**
 * Validates a draft checkpoint ladder before it is saved: strictly ascending
 * LP thresholds (a ladder that doesn't climb cannot be "cumulative"), every
 * number a positive integer — a decimal or negative LP/diamonds/cost value
 * would corrupt every grant computed against it afterwards — and a recipe
 * that actually delivers at least `rewardDiamonds`, via the same
 * `checkRecipe` a combo is held to.
 */
export function reviewLevelPassCheckpoints(
  draft: LevelPassCheckpointDraft[],
): { checkpoints: LevelPassCheckpointDraft[] | null; issues: CheckpointIssue[] } {
  const issues: CheckpointIssue[] = [];

  if (draft.length === 0) {
    issues.push({ index: -1, message: 'Debe haber al menos un checkpoint.' });
    return { checkpoints: null, issues };
  }

  draft.forEach((cp, index) => {
    if (!Number.isInteger(cp.lp) || cp.lp <= 0) {
      issues.push({ index, message: 'El umbral de LP debe ser un entero positivo.' });
    }
    if (!Number.isInteger(cp.rewardDiamonds) || cp.rewardDiamonds <= 0) {
      issues.push({ index, message: 'Los diamantes de recompensa deben ser un entero positivo.' });
    }
    if (!Number.isInteger(cp.costCents) || cp.costCents < 0) {
      issues.push({ index, message: 'El costo interno debe ser un entero mayor o igual a cero.' });
    }
    if (index > 0 && cp.lp <= draft[index - 1]!.lp) {
      issues.push({ index, message: 'Los umbrales de LP deben ser estrictamente crecientes.' });
    }

    if (!Array.isArray(cp.recipe) || cp.recipe.length === 0) {
      issues.push({ index, message: 'Debe tener al menos una recarga en la receta de entrega.' });
    } else if (cp.recipe.some((d) => !Number.isInteger(d) || d <= 0)) {
      issues.push({ index, message: 'Cada recarga de la receta debe ser un entero positivo.' });
    } else if (Number.isInteger(cp.rewardDiamonds) && cp.rewardDiamonds > 0) {
      const check = checkRecipe(cp.rewardDiamonds, cp.recipe);
      if (!check.ok) {
        issues.push({
          index,
          message: `La receta entrega ${check.delivered} 💎 pero la recompensa promete ${cp.rewardDiamonds}.`,
        });
      }
    }
  });

  if (issues.length > 0) return { checkpoints: null, issues };
  return { checkpoints: draft, issues: [] };
}

/**
 * Resolves each checkpoint's recipe to the currently active provider product
 * for that denomination and persists the pinned result — the same
 * "resolve-at-save" rule `DrizzleCatalogAdminStore.saveCombo` applies to a
 * combo's recipe, so a reward reached later is delivered against whatever
 * the provider currently sells, not a row that may since have been retired.
 */
export async function saveLevelPassCheckpoints(
  db: Database,
  draft: LevelPassCheckpointDraft[],
): Promise<void> {
  const products = await db
    .select({ id: baseProducts.id, diamondsBase: baseProducts.diamondsBase })
    .from(baseProducts)
    .where(eq(baseProducts.active, true));

  const byDenomination = new Map<number, string>();
  for (const p of products) {
    if (!byDenomination.has(p.diamondsBase)) byDenomination.set(p.diamondsBase, p.id);
  }

  const missing = new Set<number>();
  const checkpoints: LevelPassCheckpointConfig[] = draft.map((cp) => ({
    lp: cp.lp,
    rewardDiamonds: cp.rewardDiamonds,
    costCents: cp.costCents,
    recipe: cp.recipe.map((diamondsBase) => {
      const baseProductId = byDenomination.get(diamondsBase);
      if (!baseProductId) missing.add(diamondsBase);
      return { baseProductId: baseProductId ?? '', diamondsBase };
    }),
  }));

  if (missing.size > 0) {
    // The validator should have caught this; if it reaches here the catalog
    // changed under us (a denomination went inactive) and the write must not
    // silently pin a reward's recipe to nothing.
    throw new Error(`No hay producto activo del proveedor para: ${[...missing].join(', ')}`);
  }

  await db
    .insert(settings)
    .values({ key: LEVEL_PASS_CHECKPOINTS_KEY, value: checkpoints })
    .onConflictDoUpdate({ target: settings.key, set: { value: checkpoints } });
}
