/**
 * Which provider is currently active.
 *
 * Written by `activateProvider` (`@levelup/engine`) once it has actually
 * repointed at least one denomination — never on a no-op, so this setting
 * only ever reflects a switch that genuinely happened. Same `settings`
 * key-value table as `emergency_mode`/`payment_methods_enabled`; see
 * `emergency-mode.ts` for the pattern this copies.
 */

import { eq } from 'drizzle-orm';
import type { ProviderName } from '@levelup/provider';
import type { Database } from '../index.js';
import { auditLog, settings } from '../schema.js';

export const ACTIVE_PROVIDER_KEY = 'active_provider';

export interface ActiveProviderSetting {
  provider: ProviderName;
}

const DEFAULT_ACTIVE_PROVIDER: ActiveProviderSetting = { provider: 'recargas_america' };

function isActiveProviderSetting(value: unknown): value is ActiveProviderSetting {
  if (typeof value !== 'object' || value === null) return false;
  const provider = (value as Record<string, unknown>).provider;
  return provider === 'recargas_america' || provider === 'central_one';
}

/** Defaults to RecargasAmérica — an unconfigured deployment behaves exactly as it did before this existed. */
export async function getActiveProvider(db: Database): Promise<ActiveProviderSetting> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, ACTIVE_PROVIDER_KEY))
    .limit(1);

  return isActiveProviderSetting(row?.value) ? row.value : DEFAULT_ACTIVE_PROVIDER;
}

/** The `setActiveProvider` callback `activateProvider` (`@levelup/engine`) expects. */
export async function setActiveProvider(
  db: Database,
  provider: ProviderName,
  adminUserId: string | null,
): Promise<void> {
  const value: ActiveProviderSetting = { provider };

  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: ACTIVE_PROVIDER_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });

    await tx.insert(auditLog).values({
      adminUserId,
      action: 'settings.active_provider_changed',
      entityType: 'settings',
      entityId: ACTIVE_PROVIDER_KEY,
      detail: { provider },
    });
  });
}
