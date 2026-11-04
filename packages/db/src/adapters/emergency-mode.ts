/**
 * Emergency manual-fulfillment mode.
 *
 * When on, the worker stops calling the provider for new orders and parks them
 * in `needs_review` instead, so the owner can deliver them by hand through a
 * third, API-less provider while RecargasAmérica (or whatever is down) recovers
 * — then mark each one delivered from the panel. Same `settings` key-value
 * table as `payment_methods_enabled`; see that adapter for the pattern this
 * copies.
 */

import { eq } from 'drizzle-orm';
import type { Database } from '../index.js';
import { auditLog, settings } from '../schema.js';

export const EMERGENCY_MODE_KEY = 'emergency_mode';

export interface EmergencyModeSetting {
  enabled: boolean;
}

const DEFAULT_EMERGENCY_MODE: EmergencyModeSetting = { enabled: false };

function isEmergencyModeSetting(value: unknown): value is EmergencyModeSetting {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as Record<string, unknown>).enabled === 'boolean';
}

/** Defaults off — an unconfigured deployment behaves exactly as it did before this existed. */
export async function getEmergencyMode(db: Database): Promise<EmergencyModeSetting> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, EMERGENCY_MODE_KEY))
    .limit(1);

  return isEmergencyModeSetting(row?.value) ? row.value : DEFAULT_EMERGENCY_MODE;
}

export async function saveEmergencyMode(
  db: Database,
  value: EmergencyModeSetting,
  adminUserId: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: EMERGENCY_MODE_KEY, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } });

    await tx.insert(auditLog).values({
      adminUserId,
      action: value.enabled ? 'settings.emergency_mode_enabled' : 'settings.emergency_mode_disabled',
      entityType: 'settings',
      entityId: EMERGENCY_MODE_KEY,
    });
  });
}
