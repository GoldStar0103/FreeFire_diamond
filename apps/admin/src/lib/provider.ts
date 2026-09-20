/**
 * Provider singleton for the admin panel.
 *
 * Used to confirm a player ID before creating a manual order, and to read the
 * wallet balance for the Inicio dashboard tile. The panel never purchases —
 * the worker owns that, and keeping it that way means there is exactly one
 * place in the system that spends money.
 *
 * Built on first use, not at import — the same lesson apps/web's own
 * `getProvider()` already documents. An eager `build()` at module scope broke
 * the *admin build itself*: importing this module from a page.tsx (the
 * Inicio dashboard, to show the wallet balance) made Next.js evaluate it
 * while "collecting page data" during `next build`, where RA_API_KEY isn't
 * set — a `use server` action file happened not to trigger this the same
 * way, which is why this went unnoticed until something imported it from a
 * page directly.
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

export function getProvider(): TopupProvider {
  const existing = globalThis.__adminProvider;
  if (existing) return existing;
  const built = build();
  if (process.env.NODE_ENV !== 'production') globalThis.__adminProvider = built;
  return built;
}
