'use server';

import { revalidatePath } from 'next/cache';
import {
  reviewLevelPassCheckpoints,
  saveLevelPassCheckpoints,
  startFirstSeason,
  type CheckpointIssue,
} from '@levelup/db';
import { getDb } from '../../../lib/db';
import { requireSession } from '../../../lib/session';

const SEASON_LENGTH_DAYS = 60;

export async function startSeason(): Promise<void> {
  const session = await requireSession();
  // Silently a no-op if one already exists — the page only shows this button
  // when `getCurrentSeason` found none, but a second tab could race it.
  await startFirstSeason(getDb(), { lengthDays: SEASON_LENGTH_DAYS, adminUserId: session.adminUserId });
  revalidatePath('/temporadas');
}

export interface CheckpointFormState {
  issues?: CheckpointIssue[];
  error?: string;
  ok?: boolean;
}

/**
 * Rows arrive as parallel `lp[]`/`rewardDiamonds[]`/`costCents[]`/`recipe[]`
 * fields, one index per checkpoint. `recipe` is a comma-joined list of
 * denominations, the same hidden-input convention the combo form uses.
 */
function readCheckpointRows(formData: FormData) {
  const lps = formData.getAll('lp').map(Number);
  const rewards = formData.getAll('rewardDiamonds').map(Number);
  const costs = formData.getAll('costCents').map(Number);
  const recipes = formData.getAll('recipe').map((r) =>
    String(r)
      .split(',')
      .filter((d) => d !== '')
      .map(Number),
  );
  return lps.map((lp, i) => ({
    lp,
    rewardDiamonds: rewards[i] ?? 0,
    costCents: costs[i] ?? 0,
    recipe: recipes[i] ?? [],
  }));
}

export async function saveCheckpoints(
  _prev: CheckpointFormState,
  formData: FormData,
): Promise<CheckpointFormState> {
  await requireSession();

  const draft = readCheckpointRows(formData);
  const { checkpoints, issues } = reviewLevelPassCheckpoints(draft);
  if (!checkpoints) return { issues };

  try {
    await saveLevelPassCheckpoints(getDb(), checkpoints);
  } catch (err) {
    return { error: String(err instanceof Error ? err.message : err) };
  }
  revalidatePath('/temporadas');
  return { ok: true };
}
