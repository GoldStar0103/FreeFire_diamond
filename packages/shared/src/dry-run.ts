/**
 * Guards a dry-run flag against pointing at a real database.
 *
 * `*_DRY_RUN=true` swaps the provider client for `ProviderSimulator` — it does
 * not swap the database. For the worker that matters more than it sounds: the
 * catalog sync runs regardless of dry run and writes whatever the simulator's
 * fake catalog reports into `base_products`, and can re-point real combo
 * recipes and real unsent order items onto simulator product ids if it is
 * ever pointed at production by mistake (a stale `.env`, a copy-pasted
 * compose override). The storefront and panel's dry run is lower-stakes — no
 * catalog sync — but would still let a fake-validated test order land in a
 * real database.
 *
 * `localhost` / `127.0.0.1` / `::1` are trusted as "obviously not
 * production": every local workflow here runs Postgres on one of them
 * (`pnpm pg:start`, or Docker's host-port mapping), and production's
 * `DATABASE_URL` names the compose service (`postgres`) or a managed host,
 * never a loopback address. Anything else needs an explicit override, because
 * a genuine disposable staging database is a real use case this must not block.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface DryRunGuardOptions {
  /** Which flag turned dry run on, named in the error — e.g. "WORKER_DRY_RUN". */
  flagName: string;
  /** Escape hatch for a genuine non-local throwaway database. Default below. */
  overrideVarName?: string;
}

export const DEFAULT_DRY_RUN_OVERRIDE_VAR = 'DRY_RUN_ALLOW_REMOTE_DATABASE';

/**
 * Throws when `dryRun` is true and `databaseUrl` is not a recognisably local
 * host, unless the override environment variable is set to `"true"`.
 *
 * A malformed `databaseUrl` is let through — that is a different failure,
 * and the real connection attempt right after this will report it clearly.
 */
export function assertDryRunDatabaseIsSafe(
  databaseUrl: string,
  dryRun: boolean,
  options: DryRunGuardOptions,
): void {
  if (!dryRun) return;

  const overrideVar = options.overrideVarName ?? DEFAULT_DRY_RUN_OVERRIDE_VAR;
  if (process.env[overrideVar] === 'true') return;

  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return;
  }

  if (LOCAL_HOSTS.has(host)) return;

  throw new Error(
    `${options.flagName}=true refuses to run with DATABASE_URL pointed at "${host}". ` +
      'Dry run replaces the provider with a simulator, not the database — against a real ' +
      'one it can write fake data into it, and for the worker specifically it can re-point ' +
      `live combo recipes onto simulator product ids. If "${host}" is genuinely a disposable ` +
      `database, set ${overrideVar}=true.`,
  );
}
