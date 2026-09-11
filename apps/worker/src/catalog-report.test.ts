import { describe, expect, it } from 'vitest';
import type { UsdTenK } from '@levelup/provider';
import type { CatalogSyncResult } from '@levelup/engine';
import { catalogSyncAlerts, describeSync } from './catalog-report.js';

const usd = (n: number) => Math.round(n * 10_000) as UsdTenK;

const quiet = (overrides: Partial<CatalogSyncResult> = {}): CatalogSyncResult => ({
  mapped: [100, 310, 520, 1060, 2180, 5600],
  missing: [],
  added: [],
  updated: ['351', '348', '350', '347', '346', '349'],
  deactivated: [],
  costChanges: [],
  replaced: [],
  repointed: [],
  denominationConflicts: [],
  skipped: [],
  blocked: false,
  deactivationSkipped: null,
  ...overrides,
});

const replacement = {
  denomination: 100,
  fromProviderProductId: '351',
  toProviderProductId: '901',
  previousCostUsd: usd(0.7),
  currentCostUsd: usd(0.72),
};

describe('catalogSyncAlerts', () => {
  it('says nothing when nothing changed', () => {
    expect(catalogSyncAlerts(quiet())).toEqual([]);
  });

  it('raises one critical alert for a blocked catalog, not two', () => {
    // Blocked implies all six missing; a second "missing" alert adds nothing.
    const alerts = catalogSyncAlerts(
      quiet({
        mapped: [],
        missing: [100, 310, 520, 1060, 2180, 5600],
        updated: [],
        blocked: true,
        deactivationSkipped: { reason: 'empty_catalog', keptActive: ['351', '348'] },
      }),
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      level: 'critical',
      title: expect.stringMatching(/nothing was deactivated/),
      detail: { keptActive: '351, 348', reason: expect.stringMatching(/no Free Fire products/) },
    });
  });

  it('is critical about missing denominations', () => {
    const [alert] = catalogSyncAlerts(quiet({ mapped: [100], missing: [310] }));
    expect(alert).toMatchObject({ level: 'critical', detail: { missing: '310' } });
  });

  it('is critical about an id that changed denomination', () => {
    const [alert] = catalogSyncAlerts(
      quiet({
        denominationConflicts: [
          { providerProductId: '351', name: 'FF 5600', storedDiamonds: 100, offeredDiamonds: 5600 },
        ],
      }),
    );
    expect(alert).toMatchObject({ level: 'critical', detail: { conflicts: '351: 100 -> 5600' } });
  });

  it('warns about a replacement, with what moved', () => {
    const alerts = catalogSyncAlerts(
      quiet({
        replaced: [replacement],
        repointed: [
          {
            denomination: 100,
            fromProviderProductId: '351',
            toProviderProductId: '901',
            costUsd: usd(0.72),
            recipeItems: 7,
            orderItems: 2,
          },
        ],
      }),
    );

    expect(alerts).toEqual([
      expect.objectContaining({
        level: 'warn',
        detail: expect.objectContaining({
          replaced: '100: 351 -> 901 ($0.70 -> $0.72)',
          recipeItems: 7,
          unsentOrderItems: 2,
        }),
      }),
    ]);
  });

  it('warns about stragglers moved off an already-retired id', () => {
    const [alert] = catalogSyncAlerts(
      quiet({
        repointed: [
          {
            denomination: 100,
            fromProviderProductId: '351',
            toProviderProductId: '901',
            costUsd: usd(0.72),
            recipeItems: 0,
            orderItems: 1,
          },
        ],
      }),
    );
    expect(alert?.level).toBe('warn');
    expect(alert?.detail).not.toHaveProperty('replaced');
    expect(alert?.detail).toMatchObject({ unsentOrderItems: 1 });
  });

  it('warns about cost changes', () => {
    const [alert] = catalogSyncAlerts(
      quiet({
        costChanges: [
          {
            providerProductId: '349',
            diamondsBase: 5600,
            previousUsd: usd(33.27),
            currentUsd: usd(35),
            deltaUsd: usd(1.73),
            pctChange: 5.2,
          },
        ],
      }),
    );
    expect(alert).toMatchObject({ level: 'warn', detail: { changes: '5600: 5.2%' } });
  });
});

describe('describeSync', () => {
  it('prints each replacement', () => {
    const lines = describeSync(quiet({ replaced: [replacement], deactivated: ['351'] }));
    expect(lines).toContain('    100: 351 -> 901 ($0.70 -> $0.72)');
    expect(lines).toContain('  deactivated: 351');
  });

  it('prints nothing for a quiet sync', () => {
    expect(describeSync(quiet())).toEqual([]);
  });

  it('spells out that a blocked sync left the store selling', () => {
    const lines = describeSync(
      quiet({
        mapped: [],
        blocked: true,
        deactivationSkipped: { reason: 'nothing_mapped', keptActive: [] },
      }),
    );
    expect(lines.join('\n')).toMatch(/BLOCKED[\s\S]*Nothing was deactivated/);
  });
});
