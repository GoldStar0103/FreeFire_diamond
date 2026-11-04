/**
 * Detects primary-provider instability and reports it, without changing any
 * purchase/balance behaviour itself — every call still resolves or throws
 * exactly as the wrapped provider would. `fulfillOrder` and the poller are
 * untouched; this only observes what already flows through them.
 *
 * Mirrors the three trigger conditions Jose gave for activating a backup
 * provider (2026-11-03), with the third generalised as he asked:
 *
 *   1. RA is under maintenance and says so. RA's own error messages have been
 *      observed naming it directly ("en mantenimiento" — see
 *      recargasamerica.ts's history of the 2026-09-20 retirement), so this is
 *      read straight from the message rather than inferred from timing.
 *   2. The wallet cannot be read. `getBalance()` throwing is itself the
 *      signal — fired on the very first occurrence, not waited out.
 *   3. Three orders in a row come back as an "API error" — an `ambiguous`
 *      purchase outcome (timeout/provider_error/network/duplicate): no clean
 *      response from the provider at all. A `failed` outcome does not count;
 *      that is RA telling us something definitive (bad balance, bad
 *      product), not the provider itself misbehaving.
 *
 * `onTrigger` is expected to be idempotent-ish from the caller's side — this
 * module does not know whether a human has already turned the backup off
 * since the last trigger, so it fires every time a condition is met rather
 * than trying to suppress repeats itself.
 */

import type { PurchaseOutcome, PurchaseRequest, TopupProvider, UsdTenK } from './types.js';

export interface ProviderHealthTrigger {
  reason: 'maintenance_detected' | 'wallet_unreadable' | 'consecutive_api_errors';
  message: string;
}

export interface ProviderHealthConfig {
  /** How many ambiguous purchase outcomes in a row before escalating. */
  consecutiveErrorThreshold: number;
  /** Case-insensitive substrings that mark an error message as a maintenance notice. */
  maintenanceKeywords: string[];
}

export const defaultProviderHealthConfig: ProviderHealthConfig = {
  consecutiveErrorThreshold: 3,
  maintenanceKeywords: ['mantenimiento', 'maintenance'],
};

export function wrapWithHealthMonitor(
  provider: TopupProvider,
  onTrigger: (trigger: ProviderHealthTrigger) => void | Promise<void>,
  config: Partial<ProviderHealthConfig> = {},
): TopupProvider {
  const cfg = { ...defaultProviderHealthConfig, ...config };
  let consecutiveApiErrors = 0;

  const isMaintenanceMessage = (text: string): boolean =>
    cfg.maintenanceKeywords.some((kw) => text.toLowerCase().includes(kw.toLowerCase()));

  const fire = async (trigger: ProviderHealthTrigger): Promise<void> => {
    try {
      await onTrigger(trigger);
    } catch (err) {
      // The trigger failing to record itself must never take down fulfilment.
      console.error(`[provider-health] onTrigger failed for '${trigger.reason}': ${String(err)}`);
    }
  };

  return {
    listFreeFireCatalog: () => provider.listFreeFireCatalog(),
    validatePlayer: (providerProductId, playerId) =>
      provider.validatePlayer(providerProductId, playerId),
    getOrderStatus: (reference) => provider.getOrderStatus(reference),

    async getBalance(): Promise<UsdTenK> {
      try {
        return await provider.getBalance();
      } catch (err) {
        await fire({
          reason: 'wallet_unreadable',
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },

    async purchase(request: PurchaseRequest): Promise<PurchaseOutcome> {
      const outcome = await provider.purchase(request);

      if (outcome.kind !== 'ambiguous') {
        consecutiveApiErrors = 0;
        return outcome;
      }

      if (isMaintenanceMessage(outcome.message)) {
        consecutiveApiErrors = 0;
        await fire({ reason: 'maintenance_detected', message: outcome.message });
        return outcome;
      }

      consecutiveApiErrors++;
      if (consecutiveApiErrors >= cfg.consecutiveErrorThreshold) {
        await fire({
          reason: 'consecutive_api_errors',
          message: `${consecutiveApiErrors} purchase attempts in a row came back ambiguous — latest: ${outcome.message}`,
        });
        // Reset rather than fire again on every single subsequent error —
        // the caller has already been told once; it decides when to re-arm.
        consecutiveApiErrors = 0;
      }

      return outcome;
    },
  };
}
