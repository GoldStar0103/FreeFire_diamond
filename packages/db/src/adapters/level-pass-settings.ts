/**
 * Level Pass checkpoint configuration: LP thresholds, the diamonds awarded at
 * each, and the internal cost frozen onto the grant — the same settings-row
 * pattern as `getFxRate`/`saveFxRate` in payment-settings.ts, for the same
 * reason: a business value the owner must be able to change without a
 * redeploy, with a safe default so an unconfigured deployment still works.
 *
 * Changing this does NOT retroactively change history: every grant already
 * recorded keeps the cost it was actually given, in
 * `level_pass_checkpoint_events.internal_cost_cents` — see schema.ts's own
 * comment on why this config is not snapshotted onto `seasons`.
 */

import { eq } from 'drizzle-orm';
import type { LevelPassCheckpointConfig } from '@levelup/engine';
import type { Database } from '../index.js';
import { settings } from '../schema.js';

export const LEVEL_PASS_CHECKPOINTS_KEY = 'level_pass_checkpoints';

/** The numbers in the spec's own worked example — a safe, documented starting point. */
export const DEFAULT_LEVEL_PASS_CHECKPOINTS: LevelPassCheckpointConfig[] = [
  { lp: 60, rewardDiamonds: 110, costCents: 1_200 },
  { lp: 260, rewardDiamonds: 340, costCents: 4_000 },
  { lp: 585, rewardDiamonds: 570, costCents: 6_500 },
  { lp: 1_185, rewardDiamonds: 1_160, costCents: 12_000 },
];

function isCheckpointList(value: unknown): value is LevelPassCheckpointConfig[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (v): v is LevelPassCheckpointConfig =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as Record<string, unknown>).lp === 'number' &&
      typeof (v as Record<string, unknown>).rewardDiamonds === 'number' &&
      typeof (v as Record<string, unknown>).costCents === 'number',
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
 * Validates a draft checkpoint ladder before it is saved: strictly ascending
 * LP thresholds (a ladder that doesn't climb cannot be "cumulative"), and
 * every number a positive integer — a decimal or negative LP/diamonds/cost
 * value would corrupt every grant computed against it afterwards.
 */
export function reviewLevelPassCheckpoints(
  draft: LevelPassCheckpointConfig[],
): { checkpoints: LevelPassCheckpointConfig[] | null; issues: CheckpointIssue[] } {
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
  });

  if (issues.length > 0) return { checkpoints: null, issues };
  return { checkpoints: draft, issues: [] };
}

export async function saveLevelPassCheckpoints(
  db: Database,
  checkpoints: LevelPassCheckpointConfig[],
): Promise<void> {
  await db
    .insert(settings)
    .values({ key: LEVEL_PASS_CHECKPOINTS_KEY, value: checkpoints })
    .onConflictDoUpdate({ target: settings.key, set: { value: checkpoints } });
}
