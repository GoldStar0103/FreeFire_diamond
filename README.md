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
  payments/  gateway port and webhook signature verification
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
recipe items until that runs.

### Commands

| | |
|---|---|
| `pnpm test` | everything (495 tests) |
| `pnpm typecheck` | strict, with `noUncheckedIndexedAccess` |
| `pnpm pg:start` / `pg:stop` | local Postgres from npm binaries, no Docker |
| `pnpm db:migrate` / `db:seed` / `db:studio` | schema and data |
| `pnpm --filter @levelup/worker seed-test-order <combo> --approve` | put a real order through the real path |
| `node phase0/discover.mjs` | probe the live provider API |

The 154 tests in `packages/db` run against a real Postgres and **skip silently
when none is reachable**. `pnpm pg:start` first, or they will pass without
having tested anything.

CI (`.github/workflows/ci.yml`) runs typecheck, the full suite against a
Postgres service, and a production build of both apps. It runs
`packages/db/scripts/require-pg.mjs` *before* the tests, so a database that is
unreachable fails the build instead of silently skipping 154 tests — which is
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

## Status

Built and tested: storefront, panel, fulfilment engine, provider client,
manual comprobante payments, deployment stack.

Not yet wired: a card gateway (the port and webhook verification exist, no
adapter), Meta Pixel/CAPI, and off-box backup copying. Launch runs on the
manual comprobante flow the client already uses, so none of those are on the
critical path.
