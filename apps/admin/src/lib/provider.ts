/**
 * Provider singletons for the admin panel.
 *
 * Used to confirm a player ID before creating a manual order (against
 * whichever provider is currently active — that is what will actually
 * fulfil it), and to read both wallet balances for the Inicio dashboard
 * tiles. The panel never purchases — the worker owns that, and keeping it
 * that way means there is exactly one place in the system that spends money.
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
import {
  CentralOneProvider,
  ProviderSimulator,
  RecargasAmericaProvider,
  type ProviderName,
  type TopupProvider,
} from '@levelup/provider';
import { getActiveProvider as getActiveProviderSetting } from '@levelup/db';
import { getDb } from './db.js';

declare global {
  // eslint-disable-next-line no-var
  var __adminProviders: Partial<Record<ProviderName, TopupProvider>> | undefined;
}

function build(name: ProviderName): TopupProvider {
  if (process.env.ADMIN_DRY_RUN === 'true') {
    return new ProviderSimulator({
      validatableProducts: ['351', '348', '350', '347', '346', '349'],
      knownPlayers: { '7288567050': 'ElCarneseca' },
    });
  }

  if (name === 'central_one') {
    const apiKey = process.env.CENTRALONE_API_KEY;
    if (!apiKey) throw new Error('CENTRALONE_API_KEY is not set (or set ADMIN_DRY_RUN=true)');
    return new CentralOneProvider({
      baseUrl: process.env.CENTRALONE_BASE_URL ?? 'https://portal.centraloneglobal.com/api/v1',
      apiKey,
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

/** One named provider client — used by the dashboard to show both balances regardless of which is active. */
export function getProvider(name: ProviderName): TopupProvider {
  const cache = (globalThis.__adminProviders ??= {});
  const existing = cache[name];
  if (existing) return existing;
  const built = build(name);
  if (process.env.NODE_ENV !== 'production') cache[name] = built;
  return built;
}

/** Whichever provider is currently serving orders — what a manual order's player-id check should run against. */
export async function getActiveProvider(): Promise<TopupProvider> {
  const { provider } = await getActiveProviderSetting(getDb());
  return getProvider(provider);
}
