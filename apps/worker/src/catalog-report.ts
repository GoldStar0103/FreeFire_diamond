/**
 * What a catalog sync result means to a human.
 *
 * Shared by the worker's periodic sync and the `sync-catalog` CLI, so the two
 * can never disagree about what deserves a Telegram message. The rule is that
 * a sync which changed nothing says nothing: it runs every hour, and an alert
 * channel that pings hourly with "all fine" is one the owner mutes — right
 * before the day it matters.
 *
 * Levels:
 *   critical — the store cannot sell something, or is selling on a catalog we
 *              could not confirm. Someone needs to act.
 *   warn     — the store is fine, but the provider changed something that
 *              moves money: an id replacement or a cost change.
 */

import type { AlertLevel, CatalogSyncResult, DeactivationSkipReason } from '@levelup/engine';
import { describeReplacement } from '@levelup/engine';

export interface SyncAlert {
  level: AlertLevel;
  title: string;
  detail: Record<string, unknown>;
}

const SKIP_REASONS: Record<DeactivationSkipReason, string> = {
  empty_catalog: 'the provider returned no Free Fire products at all',
  nothing_mapped: 'no product name could be matched to one of the six denominations',
};

export function catalogSyncAlerts(result: CatalogSyncResult): SyncAlert[] {
  const alerts: SyncAlert[] = [];

  if (result.deactivationSkipped) {
    // Blocked. Deliberately NOT acted on: the previous catalog stays live,
    // because a provider mid-migration returning `[]` is far likelier than it
    // having withdrawn every Free Fire product. But nobody has confirmed the
    // old ids still work, so this is the most urgent alert here.
    alerts.push({
      level: 'critical',
      title: 'Catalog sync found no usable Free Fire products — nothing was deactivated',
      detail: {
        reason: SKIP_REASONS[result.deactivationSkipped.reason],
        keptActive: result.deactivationSkipped.keptActive.join(', ') || '(none)',
        action:
          'Still selling on the previous catalog. Run phase0/discover.mjs and ' +
          'place a $10 test order before trusting it.',
      },
    });
  } else if (result.missing.length) {
    alerts.push({
      level: 'critical',
      title: 'Catalog sync is missing denominations',
      detail: {
        missing: result.missing.join(', '),
        effect: 'Combos using these cannot be ordered until the provider offers them again.',
      },
    });
  }

  if (result.denominationConflicts.length) {
    alerts.push({
      level: 'critical',
      title: 'Provider ids now sell a different amount — refused',
      detail: {
        conflicts: result.denominationConflicts
          .map((c) => `${c.providerProductId}: ${c.storedDiamonds} -> ${c.offeredDiamonds}`)
          .join(', '),
        action:
          'Taken off sale. Any unsent order still on these ids would deliver the ' +
          'wrong amount — stop the worker and check them before resuming.',
      },
    });
  }

  if (result.replaced.length || result.repointed.length) {
    alerts.push({
      level: 'warn',
      title: 'Provider product ids changed — recipes and unsent orders moved over',
      detail: {
        ...(result.replaced.length
          ? { replaced: result.replaced.map(describeReplacement).join('; ') }
          : {}),
        recipeItems: result.repointed.reduce((n, r) => n + r.recipeItems, 0),
        unsentOrderItems: result.repointed.reduce((n, r) => n + r.orderItems, 0),
        action: 'Place a $10 test order to confirm the new ids actually deliver.',
      },
    });
  }

  // A cost rise silently eats a whole month of margin, so this is an alert and
  // not just a log line.
  if (result.costChanges.length) {
    alerts.push({
      level: 'warn',
      title: 'Provider costs changed — re-check combo margins',
      detail: {
        changes: result.costChanges
          .map((c) => `${c.diamondsBase}: ${c.pctChange.toFixed(1)}%`)
          .join(', '),
      },
    });
  }

  return alerts;
}

const usd = (tenK: number) => (tenK / 10_000).toFixed(4);

/** The detail lines under the one-line summary, for a console. */
export function describeSync(result: CatalogSyncResult): string[] {
  const lines: string[] = [];

  if (result.added.length) lines.push(`  added:       ${result.added.join(', ')}`);
  if (result.deactivated.length) lines.push(`  deactivated: ${result.deactivated.join(', ')}`);

  if (result.replaced.length) {
    lines.push('', '  Replaced (recipes and unsent orders follow the new id):');
    for (const r of result.replaced) lines.push(`    ${describeReplacement(r)}`);
  }

  if (result.repointed.length) {
    lines.push('', '  Re-pointed:');
    for (const r of result.repointed) {
      lines.push(
        `    ${r.denomination}: ${r.fromProviderProductId} -> ${r.toProviderProductId}  ` +
          `${r.recipeItems} recipe item(s), ${r.orderItems} unsent order item(s)`,
      );
    }
  }

  if (result.skipped.length) {
    lines.push('', '  Skipped:');
    for (const s of result.skipped) lines.push(`    ${s.providerProductId} — ${s.reason}`);
  }

  if (result.costChanges.length) {
    lines.push('', '  Cost changes:');
    for (const change of result.costChanges) {
      const direction = change.deltaUsd > 0 ? 'up' : 'down';
      lines.push(
        `    ${change.diamondsBase} 💎  ${usd(change.previousUsd)} -> ` +
          `${usd(change.currentUsd)} USD  (${direction} ${change.pctChange.toFixed(1)}%)`,
      );
    }
  }

  if (result.deactivationSkipped) {
    lines.push(
      '',
      `BLOCKED — ${SKIP_REASONS[result.deactivationSkipped.reason]}.`,
      'Nothing was deactivated; the store is still selling on the previous catalog.',
    );
  } else if (result.missing.length) {
    lines.push(
      '',
      `WARNING — no product for: ${result.missing.join(', ')}`,
      'Combos using these denominations cannot be fulfilled.',
    );
  }

  return lines;
}
