/**
 * Provider singleton for the admin panel.
 *
 * Only used to confirm a player ID before creating a manual order. The panel
 * never purchases — the worker owns that, and keeping it that way means there
 * is exactly one place in the system that spends money.
 */

import 'server-only';
import { ProviderSimulator, RecargasAmericaProvider, type TopupProvider } from '@levelup/provider';

declare global {
  // eslint-disable-next-line no-var
  var __adminProvider: TopupProvider | undefined;
}

function build(): TopupProvider {
  if (process.env.ADMIN_DRY_RUN === 'true') {
    return new ProviderSimulator({
      validatableProducts: ['351', '348', '350', '347', '346', '349'],
      knownPlayers: { '7288567050': 'ElCarneseca' },
    });
  }

  const apiKey = process.env.RA_API_KEY;
  if (!apiKey) throw new Error('RA_API_KEY is not set (or set ADMIN_DRY_RUN=true)');

  return new RecargasAmericaProvider({
    baseUrl: process.env.RA_BASE_URL ?? 'https://panel.recargasamerica.com/api/v1',
    apiKey,
    // Someone is waiting at a form with a customer on WhatsApp.
    timeoutMs: 12_000,
  });
}

export const provider: TopupProvider = globalThis.__adminProvider ?? build();
if (process.env.NODE_ENV !== 'production') globalThis.__adminProvider = provider;
