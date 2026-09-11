# LevelUp Store

Free Fire diamond top-ups for the Mexican market. Mobile-first storefront, an
admin panel the owner runs the business from, and a worker that does the actual
fulfilment.

Traffic arrives almost entirely from TikTok, Instagram and WhatsApp, on phones,
from buyers who have often been scammed before by someone selling the same
thing. That shapes more of this codebase than any technical constraint.

---

## The one idea worth understanding first

LevelUp buys six commodity SKUs from RecargasAmérica — 100, 310, 520, 1060,
2180 and 5600 diamonds, each with a 10% bonus — and repackages them into 19
combos across five campaigns. **A customer makes one purchase; behind it, up to
eight separate provider calls run.**

The provider API has no idempotency key, no way to look up a transaction by our
own reference, and `/buy/pins` returns nothing pollable. So when a purchase call
times out, there is no way to ask whether it went through.

The answer is the prepaid wallet balance. Read it before the call, read it
after, and the delta says whether money moved. That is sound only while exactly
one provider call is in flight globally, which a Postgres advisory lock
enforces. Everything else follows from this:

- `ambiguous` is a first-class outcome in the type system, not an error case.
  See `packages/provider/src/types.ts` — a caller pattern-matching on
  `succeeded` cannot silently mistake an ambiguous result for a success.
- Intent is committed to the database *before* every HTTP call, so a crash
  mid-call leaves evidence.
- Reconciliation resolves to `charged`, `not_charged` or `indeterminate`, and
  only `not_charged` is safe to retry. Diamonds cannot be clawed back once they
  reach a player's account.
- `indeterminate` freezes the order for a human. That is the correct answer, not
  a failure of the design.

This was verified against the live provider, not assumed. See
`packages/provider/src/reconcile.test.ts`.

## Layout

```
apps/
  web/       storefront          (Next 15, App Router)
  admin/     panel               (Next 15, App Router)
  worker/    fulfilment loop     (long-running, no HTTP)
packages/
  shared/    money, uploads, paths, rate limiting
  provider/  RecargasAmérica client, simulator, reconciliation
  engine/    ordering, payments, fulfilment, catalog rules — no I/O
  db/        Drizzle schema, migrations, and the adapters engine talks through
  payments/  gateway port, webhook signature verification, Stripe adapter
phase0/      live API discovery, and the transcribed combo catalog
docker/      images and the Caddy config
docs/        RUNBOOK.md — deploy, restore, what to do when something breaks
             MANUAL.md  — the owner's guide, in Spanish
```

`engine` holds the business rules and performs no I/O; `db` provides the
adapters it talks through. That is why the rules can be tested exhaustively
without a database, and why the database tests can be about the database.

## Running it locally

Requires Node 24 and pnpm 9.

```bash
pnpm install
cp .env.example .env          # then edit — see below
```

Two values must be changed before anything works:

- `DATABASE_URL` — a reachable Postgres.
- `UPLOAD_DIR` — **must be an absolute path.** A relative one resolves against
  each process's working directory, so the panel would write flyers somewhere
  the storefront never looks. The apps refuse to start rather than let that
  happen silently.

Then:

```bash
docker compose up -d          # Postgres, or use pnpm pg:start (no Docker needed)
pnpm db:migrate
pnpm db:seed                  # 19 combos from phase0/catalog.mjs

pnpm --filter @levelup/web dev      # storefront  :3000
pnpm --filter @levelup/admin dev    # panel       :3001
pnpm --filter @levelup/admin create-admin
WORKER_DRY_RUN=true pnpm worker     # simulated provider — spends no money
```

`WORKER_DRY_RUN=true` swaps the real provider for a simulator that can be
scripted into timeouts, partial charges and code-instead-of-topup deliveries.
Use it. The real one spends real balance.

The seed links recipes to `base_products`, which are populated by the provider
catalog sync rather than seeded, so a fresh database will report unlinked
recipe items until that runs. The worker runs it at startup and hourly;
`pnpm --filter @levelup/worker sync-catalog` runs it now.

### Commands

| | |
|---|---|
| `pnpm test` | everything (870 tests) |
| `pnpm typecheck` | strict, with `noUncheckedIndexedAccess` |
| `pnpm pg:start` / `pg:stop` | local Postgres from npm binaries, no Docker |
| `pnpm db:migrate` / `db:seed` / `db:studio` | schema and data |
| `pnpm --filter @levelup/worker seed-test-order <combo> --approve` | put a real order through the real path |
| `pnpm --filter @levelup/worker sync-catalog` | provider catalog sync, now — the worker also runs it hourly |
| `node phase0/discover.mjs` | probe the live provider API |
| `node scripts/smoke.mjs <store-url> [panel-url]` | verify a running deployment — read-only, no credentials |

The 244 tests in `packages/db` run against a real Postgres and **skip silently
when none is reachable**. `pnpm pg:start` first, or they will pass without
having tested anything.

CI (`.github/workflows/ci.yml`) runs typecheck, the full suite against a
Postgres service, and a production build of both apps. It runs
`packages/db/scripts/require-pg.mjs` *before* the tests, so a database that is
unreachable fails the build instead of silently skipping 244 tests — which is
the whole reason for running them there. That check opens a real connection and
issues a query rather than probing the port: Postgres accepts connections while
still in crash recovery and rejects every query with "the database system is
starting up".

## Configuration

Every setting is documented in `.env.example`. Two rules:

1. **Secrets only ever live in the environment.** Never in the repo, never in a
   Docker image. `.dockerignore` and `.gitignore` both exclude `.env`.
2. **Production reads real environment variables, not a file.** The root `.env`
   is a development convenience, loaded by each app's `next.config.mjs`. The
   standalone production build does not run that config, so compose and systemd
   supply the values directly.

Pages that render configuration — the legal notices — are `force-dynamic` for
this reason. Prerendered, they would bake in whatever was set at *build* time,
and an image built without `LEGAL_*` would ship an aviso de privacidad reading
`[PENDIENTE: RFC]` that no restart could fix.

## Deployment

See **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml --profile tools run --rm tools pnpm db:migrate
```

Caddy terminates TLS and is the only service publishing ports. Postgres, both
apps and the worker are reachable only on the compose network.

Migrations are not run automatically — a deploy should never silently alter the
schema. The `tools` profile exists for that and for seeding and creating admin
users; it builds from the same source and lockfile as everything else, so a
migration can never be applied from a stale checkout on the server.

The images have not been built yet: this was developed on a machine without
Docker. What *is* verified is that both apps build and run correctly from
Next's `standalone` output, which is what the images wrap.

## Things that will bite you

- **Only ever run one worker.** The advisory lock makes a second one safe but
  useless, and wallet-delta reconciliation assumes a single provider call in
  flight globally. `docker-compose.prod.yml` pins `replicas: 1`.
- **The rate limiter is in-process.** Fine for one instance of each app; it
  silently weakens if either is ever scaled out. `packages/shared/src/rate-limit.ts`
  says so too.
- **NUMERIC comes back from Postgres as a string.** Money is handled as integer
  centavos (MXN) and ten-thousandths of a dollar (USD) precisely to avoid
  float arithmetic on money. See `packages/shared/src/money.ts`.
- **The seed never touches a combo's `active` flag on re-run.** An operator
  switching something off in the panel outranks a re-seed. The consequence is
  that a combo the seeder once deactivated stays off until someone turns it
  back on by hand.
- **Uploads are not in the database.** Back up the volume as well as the dump,
  or you will restore payment records with none of the receipts proving them.
- **The worker rewires the catalog by itself.** At startup and every
  `CATALOG_SYNC_INTERVAL_MS` (default an hour) it syncs the provider catalog.
  When a denomination moves to a new provider id, combo recipes and unsent
  (`queued`/`failed`) order items follow it, at the new cost, with an
  `audit_log` row per change; anything that may have reached the provider, and
  every closed order, is left alone. An empty or unparseable catalog
  deactivates nothing and raises a critical alert instead. What each alert
  means is in [the runbook](docs/RUNBOOK.md#the-provider-changed-its-catalog).
- **`WORKER_DRY_RUN=true` (and `WEB_DRY_RUN`/`ADMIN_DRY_RUN`) refuse to start
  against a non-local database.** The simulator's catalog has its own ids, and
  the sync would faithfully treat that as the provider replacing every
  product — re-pointing live recipes and paid orders onto ids that do not
  exist. `packages/shared/src/dry-run.ts` enforces this: dry run is allowed
  only against `localhost`/`127.0.0.1`/`::1`, or with
  `DRY_RUN_ALLOW_REMOTE_DATABASE=true` set explicitly for a genuine disposable
  staging database.

## Status

Built and tested: storefront, panel, fulfilment engine, provider client,
manual comprobante payments, Stripe card (and optional OXXO) payments, Meta
and TikTok Pixels plus server-side Meta Conversions API, automatic provider
catalog sync, panel tools for resolving an order stuck in review (settle a
recharge by hand, resume delivery, flag/close a refund), a one-tap WhatsApp
button wherever the panel shows an order's number, optional TOTP two-factor
login for the panel, one-click deployment scripting (`scripts/deploy.sh`),
deployment stack.

Stripe, Meta, TikTok and per-admin 2FA are switched on by their own
configuration and are invisible without it — see `docs/RUNBOOK.md`. Card
payments and Meta have been tested against their documented contracts, not yet
against the client's live accounts: the first real $10 order through each is
the remaining proof.

Off-box backup copying is built but needs its one-time rclone setup on the
server — see `docs/RUNBOOK.md` §3. The deploy scripts (`scripts/server-setup.sh`,
`scripts/deploy.sh`) have never run against a real server: this was developed
on a machine with neither bash nor Docker, so their first real test is the
client's actual VPS.
