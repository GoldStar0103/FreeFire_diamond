# Runbook

Deploying and operating LevelUp Store. Written to be followed by someone who
did not build it, at 3am, under pressure.

Throughout: `cd /srv/levelup` first, and `dc` means
`docker compose -f docker-compose.prod.yml`.

---

## 1. First deployment

### Before you start

- A VPS running Ubuntu 24.04 with nothing else on it. The client's is a
  Hostinger KVM 2 (2 vCPU, 8GB). Docker and the rest come from
  `scripts/server-setup.sh`, the first of the steps below.
- An SSH key on the computer you are working from. Hostinger hands the VPS
  over with a root password; the setup script switches password logins off,
  and only does so once a key is in place.
- DNS pointing at it. **Set this up first.** Caddy requests certificates on
  startup, and Let's Encrypt rate-limits failed attempts.

#### DNS for levelupstore.mx (registered at Hostinger)

hPanel → Domains → levelupstore.mx → **DNS / Nameservers** → DNS records.
Keep Hostinger's nameservers. Delete any existing `A` record for `@` and the
`CNAME` for `www` that Hostinger creates by default (they point at its parking
page), then add:

| Type | Name | Points to | TTL |
|---|---|---|---|
| A | `@` | the VPS's IPv4 | 3600 |
| A | `www` | the VPS's IPv4 | 3600 |
| A | `panel` | the VPS's IPv4 | 3600 |

`www` only redirects to the bare domain (see the Caddyfile), but it needs a
record so the certificate for it can be issued. If the VPS has IPv6, add the
matching `AAAA` records too — or none at all; a wrong `AAAA` breaks it for
every phone on an IPv6 carrier, which in Mexico is most of them.

Check from any machine before starting the stack:

```bash
dig +short levelupstore.mx www.levelupstore.mx panel.levelupstore.mx
```

All three must print the VPS's address. Propagation is usually minutes on a
new `.mx`, occasionally a few hours.

### Steps

> **Automated with `scripts/deploy.sh`:** `scripts/server-setup.sh` handles
> "Bootstrap the server" below. Once the code is checked out and `.env` is
> filled in (through "Get the code"), `./scripts/deploy.sh init` automates
> everything from there — build, wait for postgres to be healthy, migrate,
> seed, create the first admin user, and the verification smoke test. See
> `./scripts/deploy.sh --help`. The steps below are what it runs, and remain
> the reference for what to do by hand if something needs a closer look.

#### Bootstrap the server (once)

Put your SSH key on root first. Skip this if you gave Hostinger your key when
the VPS was created.

```bash
# On your own computer. No key yet? ssh-keygen -t ed25519
ssh-copy-id root@<vps-ip>
```

Windows has no `ssh-copy-id`; in PowerShell:
`type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@<vps-ip> "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`

Upload the setup script and run it as root. It takes a few minutes and is safe
to re-run:

```bash
scp scripts/server-setup.sh root@<vps-ip>:/root/
ssh root@<vps-ip>
bash /root/server-setup.sh
```

It installs Docker from Docker's own repository, creates the deploy user
`levelup` (sudo, docker) with root's keys, turns on the firewall, fail2ban,
automatic security updates and swap, creates `/srv/levelup`, and last, turns
off password and root logins over SSH. Read the summary it ends with:

- **SSH hardening: ON** — continue.
- **SSH hardening: SKIPPED** — `levelup` had no key. Do `ssh-copy-id` above,
  then run the script again.
- **Reboot needed: YES** — reboot, but only after the login check below
  works: a reboot ends the root session too.

**Keep the root session open** and, from a second terminal, log in as the
deploy user:

```bash
ssh levelup@<vps-ip>
sudo true && docker ps          # both must work
sudo reboot                     # only if the summary said so
```

Only then close the root session. From here on, everything is done as
`levelup`, with `sudo` when needed — root cannot log in over SSH any more. If
you do get locked out, hPanel's recovery mode for the VPS is the way back in
(its browser terminal may log in as root over SSH, and stop working with it).

Then check **Hostinger's firewall**, which filters traffic before it reaches
the server, so the server's own firewall being right is not enough: hPanel →
VPS → Security → Firewall. If a firewall configuration is active there, it must
allow TCP 22, 80 and 443, and UDP 443. If none is configured, there is nothing
to do.

#### Get the code

The setup script already created `/srv/levelup`, owned by `levelup`, with
`backups/` inside — and `git clone` refuses a directory that is not empty. So:

```bash
cd /srv/levelup
git init
git remote add origin <repo>
git fetch origin
git checkout -t origin/main
cp .env.example .env
chmod 600 .env                  # every secret the store has is in here
```

Edit `.env`. Everything is documented there; these must be right:

| | |
|---|---|
| `POSTGRES_PASSWORD` | generate one, do not reuse anything |
| `DATABASE_URL` | must match the Postgres vars, host is `postgres` |
| `RA_API_KEY` | RecargasAmérica |
| `PUBLIC_DOMAIN`, `ADMIN_DOMAIN`, `TLS_EMAIL` | must match DNS |
| `LEGAL_*` | printed verbatim on the legal pages |
| `PAY_*` | optional — a bootstrap only. Set the bank account in the panel under Ajustes instead; leaving these blank simply means the storefront cannot take payments until you do |
| `ADMIN_SESSION_SECRET` | long and random |
| `TELEGRAM_*` | **the worker refuses to start without these.** Alerts are how a human learns an order needs review; running blind defeats the design |
| `STRIPE_*` | optional — card payments. See [Card payments](#card-payments-stripe) below |
| `META_*` | optional — Pixel and server-side purchase reporting. See [Meta](#meta-pixel-and-conversions-api) below |
| `UPLOAD_DIR` | leave as `/srv/levelup/uploads` — it is a path inside the container |
| `BACKUP_*` | leave for now — set up once the stack is running, see [Backups](#3-backups) |

Then:

```bash
dc up -d --build          # first build takes a few minutes
dc ps                     # postgres healthy before continuing
```

Migrate and seed. Migrations do not run automatically — deliberately, so a
deploy never silently alters the schema. The `tools` container is the same
source and lockfile as everything else, built from the same compose file:

```bash
dc --profile tools run --rm tools pnpm db:migrate
dc --profile tools run --rm tools pnpm db:seed
```

Create the first admin user. There is no sign-up page — this panel approves
payments, so accounts are made from the server:

```bash
dc --profile tools run --rm tools \
  pnpm --filter @levelup/admin create-admin jose@levelupstore.mx 'una contraseña larga'
```

Re-running it for an existing email resets that password, which is the
account-recovery path. Note the password appears in shell history; clear it, or
prefix the command with a space if the shell is configured to skip those.

Re-running it also clears any two-factor authentication (TOTP) on that
account. The realistic reason to reset a password from the server is an owner
locked out of the panel, and if 2FA were left in place a fresh password would
just trade one lockout for another — especially if losing the phone the
authenticator app was on is *why* they needed the reset. The owner can turn
2FA back on from Ajustes once logged in.

### Verify before telling anyone it is live

```bash
docker run --rm -v "$PWD/scripts:/scripts:ro" node:24-alpine \
  node /scripts/smoke.mjs https://levelupstore.mx https://panel.levelupstore.mx
```

The server has no Node of its own — everything runs in containers — and the
script has no dependencies, so a throwaway `node` container runs it. (From any
machine with Node, `node scripts/smoke.mjs <store> <panel>` works too.) Use the
real domains rather than `$PUBLIC_DOMAIN`: the `.env` is not loaded into your
shell, and sourcing it breaks on values with spaces such as `LEGAL_ADDRESS`.

Exits non-zero if anything is wrong, and names what. It is read-only and needs
no credentials, so it is safe against production and worth re-running after
every deploy. It checks the failures that are invisible from the outside:
legal notices still showing `[PENDIENTE]`, flyers 404ing, a sitemap advertising
the wrong domain, order pages missing `noindex`, the panel readable without a
session, and — the one that would matter most — comprobantes reachable by URL.

Also confirm the services themselves:

```bash
dc ps                        # all healthy
dc logs worker --tail 20     # "[worker] Starting"
```

### Google Search Console

The storefront already allows crawlers (`robots.txt` + `/sitemap.xml`). Google
still has to be *asked* to recrawl a new site; Search Console is that ask.

1. Open https://search.google.com/search-console with any Google account that
   can later invite the owner (`contactolevelupmexico@gmail.com`).
2. Add property → **URL prefix** → `https://levelupstore.mx`.
3. Choose **HTML tag**. Copy only the `content="…"` token into
   `GOOGLE_SITE_VERIFICATION` in `.env` (not the whole `<meta>`).
4. Deploy / restart `web` so the tag is live, then click **Verify**.
5. Settings → Users and permissions → Add user
   `contactolevelupmexico@gmail.com` as **Owner**. They have to accept the
   mail.
6. Sitemaps → add `sitemap.xml`. URL Inspection → request indexing on `/`.

Do not verify `panel.levelupstore.mx` — it is `noindex` on purpose.

Then, and this is the one no script can do:

1. Place a real order for the $10 Mega Oferta through the storefront.
2. Approve it in the panel.
3. Confirm the diamonds arrive in the game.

Nothing else proves the whole chain works.

### Card payments (Stripe)

Optional, and additive: with no `STRIPE_*` set the checkout is exactly the
transfer + comprobante flow. With both keys set, step 2 offers **Tarjeta** first
and **Transferencia** as the second tab.

1. Stripe dashboard, **test mode** first. Developers → API keys → copy the
   secret key (`sk_test_…`) into `STRIPE_SECRET_KEY`.
2. Developers → Webhooks → Add endpoint
   `https://levelupstore.mx/api/webhooks/stripe`, with exactly these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`.
   Reveal the signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
3. `dc up -d` to pick up the env. Buy the $10 Mega Oferta with Stripe's test
   card `4242 4242 4242 4242`, any future date, any CVC. The order page should
   flip to "Recargando tus diamantes" within seconds, and the webhook's delivery
   log in Stripe should show `200`.
4. Repeat steps 1–3 in **live mode** with live keys — both keys and the webhook
   secret change together; a live key with a test secret verifies nothing.
5. OXXO through Stripe: turn it on under Settings → Payment methods first, then
   set `STRIPE_OXXO=true`. With it off in Stripe, every checkout fails.

How it holds together, for whoever debugs it:

- The order is created *before* the redirect to Stripe, like a transfer
  order, so the Mega Oferta slot is reserved. Its payment deadline is the
  Stripe session's expiry plus 30 minutes, so an abandoned card checkout frees
  the slot in about 90 minutes instead of 48 hours — sooner if the customer
  presses "back", which expires the session at Stripe on the spot.
- Two paths confirm payment and both end in `approvePayment`: the webhook, and
  the customer's return to the order page, which asks Stripe directly. A
  misconfigured webhook therefore still works for anyone who comes back — but
  fix it, because OXXO payments settle hours later with nobody on the page.
- A webhook that fails half-way returns 500 and stays unprocessed in
  `payment_events`; Stripe redelivers for three days and the redelivery
  finishes the job. Duplicates of a *finished* event are acknowledged and
  ignored.
- Money that arrives and cannot be approved (wrong amount, order already
  expired or cancelled) sends a Telegram alert: *"Pago con tarjeta recibido
  pero NO aprobado"*. That is a paid customer with nothing shipping. The fix is
  in the owner's manual: a manual order, or a refund from Stripe.

### Meta Pixel and Conversions API

- `META_PIXEL_ID` alone: the browser Pixel on every storefront page, with
  `ViewContent` (combo page), `InitiateCheckout` ("Sí, soy yo"),
  `AddPaymentInfo` (pay button) and `Purchase` (order page, once paid).
- Plus `META_CAPI_ACCESS_TOKEN`: the worker also reports each paid storefront
  order server-side, once, with the same `event_id` as the browser `Purchase`
  so Meta counts one. That covers iOS, ad blockers, and OXXO payments that
  settle with no browser open. Orders entered from the panel are not reported —
  no browser, nothing for Meta to match.
- To verify: put the code from Events Manager → Test events into
  `META_CAPI_TEST_EVENT_CODE`, restart the worker (its startup line says
  `Meta CAPI ON (TEST EVENTS)`), pay a test order, and watch both a Browser and
  a Server `Purchase` arrive. **Then clear the variable and restart** — left
  set, every real sale is filed as a test event.
- A revoked token shows up as one Telegram warning per order
  (*"Meta CAPI: purchase not reported"*). Each order is retried up to five
  times; Meta refuses events older than seven days, so the backlog stops there.

---

## 2. Deploying a change

> **Automated with `scripts/deploy.sh`:** `./scripts/deploy.sh update` runs
> the steps below — pull, rebuild and restart, smoke test — and, instead of
> ever running migrations for you, refuses to continue (printing the exact
> command to run) if the pull touched `packages/db/migrations/`. See
> `./scripts/deploy.sh --help`.

```bash
cd /srv/levelup
git pull
dc up -d --build
```

Then re-run the smoke test:

```bash
docker run --rm -v "$PWD/scripts:/scripts:ro" node:24-alpine \
  node /scripts/smoke.mjs https://levelupstore.mx https://panel.levelupstore.mx
```

Compose replaces containers one service at a time. The worker gets 120 seconds
to finish the combo it is holding before it is stopped — do not shorten this,
and do not `kill -9` it. A worker killed mid-combo can leave someone who paid
for eight recharges holding three.

If the schema changed, run migrations **before** `up -d --build`:

```bash
dc --profile tools run --rm --build tools pnpm db:migrate
```

### Rolling back

```bash
git log --oneline -5
git checkout <previous-sha>
dc up -d --build
```

Rolling back code is safe. Rolling back *past a migration* is not — restore
from a backup instead.

---

## 3. Backups

`scripts/backup.sh` dumps the database and the uploads volume into
`/srv/levelup/backups` and keeps 14 days of them there. Install it in
**root's** crontab — `sudo crontab -e`, not plain `crontab -e`: the log is in
`/var/log` and the rclone login below is root's, so as `levelup` the job fails
every night without a word.

```bash
sudo crontab -e
15 10 * * * cd /srv/levelup && bash scripts/backup.sh >> /var/log/levelup-backup.log 2>&1
```

The server runs on UTC, so 10:15 is 04:15 in Mexico City. Run it once by hand
now rather than finding out tomorrow:

```bash
sudo bash scripts/backup.sh
```

**On their own, the backups land on the same disk as the data, which protects
against nothing that destroys the disk.** Until the off-box copy below is set
up, the backup strategy is incomplete and you should say so out loud.

### Off-box copies (rclone)

One-time setup. After it, every nightly run uploads its two new files to the
remote named in `BACKUP_RCLONE_REMOTE` and removes remote copies older than
`BACKUP_REMOTE_RETENTION_DAYS` (default 30). A failed upload never touches the
local backup; the run ends with a `FAILED` line in the log and a non-zero exit.

Everything runs as root (`sudo rclone …`), because the cron job does — a
remote configured as `levelup` is invisible to it. rclone keeps the login in
`/root/.config/rclone/rclone.conf`, not in `.env`.

The server holds that login, so someone who takes over the server can delete
the remote copies too. This protects against losing the server, not against an
attacker on it.

#### Google Drive (recommended)

The client already keeps the store's assets in Drive. The login is done in a
browser on a desktop; the server only receives the resulting token. The
desktop needs rclone too (rclone.org/downloads — on Windows, `rclone.exe` from
the zip is enough).

1. On the server, `sudo rclone config`, then `n` for a new remote. Answer:
   - name: `gdrive`
   - storage: `drive`
   - client_id, client_secret: leave blank
   - scope: **`drive.file`** — rclone sees only the files it created itself.
     The server then cannot read or delete anything else in the client's
     Drive, even if it is compromised.
   - "Use web browser to automatically authenticate?": **`n`** — the server
     has no browser. It prints a command like `rclone authorize "drive" "eyJ…"`.
   - everything else: the default (Enter).
2. On the desktop, run **exactly that command** — the part in quotes carries
   the scope. A browser opens: sign in with the client's Google account and
   allow access. The desktop terminal prints a token; paste it into the
   server's prompt, confirm, quit.
3. Create the folder from the server, **not by hand in Drive** — with
   `drive.file`, a folder made in the Drive website is invisible to rclone,
   and it would quietly create a second one with the same name:
   ```bash
   sudo rclone mkdir gdrive:levelup-backups
   ```
4. In `.env`: `BACKUP_RCLONE_REMOTE=gdrive:levelup-backups`. Nothing needs
   restarting; only the backup script reads it.

Space: every night uploads a full set, so the Drive needs room for 30 of them,
and Drive keeps deleted files in its trash — counted against the quota — for
another 30 days. After the first run, `du -sh backups/*` shows one set's size.
A free Google account has 15GB, shared with Gmail. If it will not fit, lower
`BACKUP_REMOTE_RETENTION_DAYS`, or make pruning skip the trash:
`sudo rclone config update gdrive use_trash false`.

#### Alternative: Cloudflare R2 or Backblaze B2

Object storage billed by the GB — cheaper than Drive at scale, and not shared
with anyone's email. Either works; the script does not care which.

**Cloudflare R2.** Dashboard → R2 → create a bucket, `levelup-backups`. Then
Manage R2 API tokens → create a token with **Object Read & Write** on that
bucket only, and note its Access Key ID, Secret Access Key and the endpoint
(`https://<account-id>.r2.cloudflarestorage.com`). Then:

```bash
sudo rclone config        # n, name r2, storage s3, provider Cloudflare,
                          # paste the two keys and the endpoint, rest default
sudo rclone config update r2 no_check_bucket true
```

The second line matters: a token limited to one bucket may not create buckets,
and without it every upload fails with `AccessDenied`. In `.env`:
`BACKUP_RCLONE_REMOTE=r2:levelup-backups`.

**Backblaze B2.** Create a private bucket, then Application Keys → a key
restricted to that bucket. Then:

```bash
sudo rclone config        # n, name b2, storage b2, keyID + applicationKey
sudo rclone config update b2 hard_delete true
```

Without `hard_delete`, B2 keeps every "deleted" file as a hidden version, and
pruning frees nothing. In `.env`: `BACKUP_RCLONE_REMOTE=b2:<bucket-name>`.

#### Check that it works

The examples here and below use `gdrive:levelup-backups`; with R2 or B2,
substitute whatever `BACKUP_RCLONE_REMOTE` says.

```bash
sudo bash scripts/backup.sh                # ends "[backup] done (local + …)"
sudo rclone lsl gdrive:levelup-backups     # tonight's two files...
sudo ls -l backups/                        # ...the same sizes as here
```

Then, once, prove a remote copy can actually be read back, not just listed:

```bash
mkdir -p /tmp/restore-test
sudo rclone copy gdrive:levelup-backups/db-YYYYMMDD-HHMMSS.sql.gz /tmp/restore-test/
sudo gunzip -t /tmp/restore-test/db-*.sql.gz && echo "readable"
sudo rm -rf /tmp/restore-test
```

A failed night says `FAILED` in the log and nothing else tells anyone (§6).
Look now and then:

```bash
tail -n 20 /var/log/levelup-backup.log
grep FAILED /var/log/levelup-backup.log
```

### Restoring

Database:

```bash
dc stop web admin worker            # nothing writing while we restore
sudo gunzip -c backups/db-YYYYMMDD-HHMMSS.sql.gz \
  | dc exec -T postgres psql --username levelup --dbname levelup
dc start web admin worker
```

The dump is `--clean --if-exists`, so it drops and recreates as it goes. The
backup files belong to root, who wrote them, hence the `sudo`.

Uploads:

```bash
docker run --rm \
  -v levelup_uploads:/data \
  -v "$PWD/backups":/backup:ro \
  alpine:3 \
  sh -c 'rm -rf /data/* && tar xzf /backup/uploads-YYYYMMDD-HHMMSS.tar.gz -C /data'
```

**Restore both, from the same night.** A database newer than the uploads means
payment records whose comprobantes are missing.

### Restoring from the off-box copy

When the server, or its disk, is gone. On a replacement server:

1. Do §1 — bootstrap, get the code, `.env`, `dc up -d --build` — but **skip
   `db:migrate`, `db:seed` and `create-admin`**: the dump brings the schema,
   the data and the admin users with it.
2. Set up the same rclone remote as above.
3. Fetch the newest pair:
   ```bash
   # newest nights last, each night's db and uploads side by side
   sudo rclone lsf gdrive:levelup-backups | sort -t- -k2 | tail -n 4
   sudo rclone copy gdrive:levelup-backups/db-YYYYMMDD-HHMMSS.sql.gz      backups/
   sudo rclone copy gdrive:levelup-backups/uploads-YYYYMMDD-HHMMSS.tar.gz backups/
   ```
4. Restore both exactly as above, then run the smoke test from §1.

`.env` is not in the backups. Keep a copy of it somewhere safe — a password
manager — or be ready to rebuild it from `.env.example` and each provider's
dashboard.

### Practise this

Do a restore into a scratch environment once, before you need it — from the
off-box copy, since that is the one you will be using when it counts. A backup
nobody has restored is a hypothesis.

---

## 4. When something is wrong

### Orders are paid but nothing is being delivered

```bash
dc ps                        # is worker healthy?
dc logs worker --tail 100
```

- **Worker unhealthy or restarting** — read the logs. It refuses to start on
  missing `RA_API_KEY` or `TELEGRAM_*`; that is intentional.
- **Worker healthy but idle** — check the provider wallet balance. Fulfilment
  pauses as a whole when the balance cannot cover an order, rather than failing
  paid orders one at a time. Top up the RecargasAmérica account.
- **Worker healthy and busy but nothing completes** — look for orders stuck in
  `needs_review` in the panel. Something reconciled as `indeterminate` and is
  waiting for a human. That is the system working correctly.

### An order is stuck in "needs review"

The engine stopped rather than guess: a call whose outcome the wallet could
not settle (`unknown`), retries that ran out (`failed` × 3), or a wallet too
low to finish the combo (items still `queued`). Resolve it from the order page
in the panel — the "Resolver este pedido" box at the top:

1. Open the RecargasAmérica panel and find each listed recharge by time and
   amount. The box shows both, plus the wallet before/after where known.
2. Per recharge: **Sí llegó** (item → `succeeded`, `resolved_by = manual`), or
   **No llegó** (item → `queued` with a fresh retry budget). For an `unknown`
   item, "No llegó" requires ticking *"Revisé en RecargasAmérica y NO se
   cobró"* — the engine refuses it otherwise.
3. **Reanudar entregas** re-enqueues the order (`payment_confirmed` or
   `partially_delivered`) and the worker sends what is left. It is refused
   while any item is `unknown` or `sending`, because that is how a customer
   gets double diamonds. A low-wallet pause needs only this, after topping up.
4. If it cannot be delivered: **Requiere reembolso** (with a reason) →
   `refund_required`; after paying the customer back, **Reembolso hecho** (with
   the reference) → `cancelled`.

Every action is compare-and-set against the statuses the page was loaded
with, in one transaction with an `audit_log` row naming the admin
(`review.*` actions). If a sweep settled something meanwhile, the panel says
the order changed and nothing is applied.

Never guess. Diamonds cannot be recovered once delivered.

### The provider changed its catalog

RecargasAmérica can change product ids, names and prices without notice — and
announced exactly that for **2026-09-15** ("se cambiará el catálogo
unificado"), with no new documentation.

**What the worker does on its own.** At startup, and every
`CATALOG_SYNC_INTERVAL_MS` (default one hour; retried after 5 minutes if it
fails), it re-reads the provider catalog under the same lock fulfilment uses:

- A denomination that now maps to a **new provider id** is a replacement.
  Combo recipes and unsent order items (`queued` or `failed`, in orders that
  are not completed, cancelled, expired or awaiting refund) move to the new id
  and its new cost. Every moved row gets an `audit_log` entry,
  `catalog.recipe_repointed` or `catalog.order_item_repointed`. Items that may
  have reached the provider (`sending`, `unknown`, `provider_pending`,
  `succeeded`) and every order's `combo_snapshot` are never touched.
- An **empty or unparseable** catalog deactivates nothing. The store keeps
  selling on the previous ids, and a critical alert says so.
- An id we know as one amount that is now listed as **another amount** is
  refused and taken off sale.

It only alerts when something changed or is wrong:

| Alert | Level | Meaning | Do |
|---|---|---|---|
| Provider product ids changed — recipes and unsent orders moved over | warn | Replacement handled. The alert lists old → new id and cost. | Place a $10 test order and confirm it arrives. |
| Provider costs changed — re-check combo margins | warn | Same ids, new prices. | Check margins in the panel. |
| Catalog sync is missing denominations | critical | One of the six is no longer sold as a direct top-up. Combos using it cannot be ordered. | Run discovery (below), contact the provider. |
| Catalog sync found no usable Free Fire products — nothing was deactivated | critical | Empty or unreadable catalog. Still selling on the old ids, which may no longer work. Repeats every hour until fixed. | Run discovery. Place a $10 test order. If the old ids are dead, switch combos off in the panel until the sync recovers. |
| Provider ids now sell a different amount — refused | critical | The provider reused an id for a different denomination. | `dc stop worker`, check paid orders still on that id in the panel, contact the provider before restarting. |
| Order item refused — its product is no longer on sale | critical | A paid order had an item still queued for a product the catalog sync has since deactivated — usually the row above, for an order placed just before the id was reassigned. Fulfilment refuses to guess and sends nothing: it will not buy the wrong amount at the wrong price just because the old id still exists. | The order sits in **Pedidos → Requiere revisión**. If a later sync finds a real replacement for that denomination, it re-points the item automatically and **Reanudar entregas** sends it. If not — the denomination may need a developer to map it by hand first; check the sync's own alerts for that same denomination before assuming "Reanudar entregas" alone will fix it. |
| Provider catalog sync failed — will retry | warn | API error. Nothing changed. | Nothing, unless it keeps repeating. |

To freeze the catalog — the provider flapping between two versions, say — set
`CATALOG_SYNC_INTERVAL_MS=0` and `dc up -d worker`. That also skips the
startup sync. Put it back afterwards.

**Checklist for 2026-09-15** (and any future catalog change). Once the provider
says the change is live, and again whenever an alert above arrives:

1. `dc logs worker --tail 50 | grep catalog` — the startup line shows
   `catalog sync 3600000ms`, not `OFF`, and the latest `[catalog]` summary
   says `6/6 denominations mapped`.
2. Confirm the provider still sells what the store is built on:
   ```bash
   dc --profile tools run --rm tools node phase0/discover.mjs
   ```
   The verdict must still be **GO**. Anything else — `GO_NO_VALIDATION`,
   `BLOCKED` — changes the product, not just the ids: stop and escalate. Note
   the six ids it reports; before the change they were 351, 348, 350, 347, 346
   and 349 (100 → 5,600 diamonds).
3. Sync now rather than waiting for the hour:
   ```bash
   dc --profile tools run --rm tools pnpm --filter @levelup/worker sync-catalog
   ```
   It is safe with the worker running. It prints each replacement as
   `100: 351 -> 901 ($0.70 -> $0.72)` and exits non-zero if it is blocked or
   refused an id.
4. Place a real order for the $10 Mega Oferta through the storefront, approve
   it, and confirm the diamonds arrive. Nothing else proves the new ids work.
5. Check Aprobaciones and `needs_review` for orders that failed during the
   provider's interruption window, and retry them — their unsent items already
   point at the new ids.

### The site is up but every page errors

Almost always the database.

```bash
curl -fsS https://$PUBLIC_DOMAIN/api/health   # reports 503 with a bad database
dc logs postgres --tail 50
dc ps
```

### Flyers show as broken images

Check the panel and storefront see the same volume:

```bash
dc exec admin ls -la /srv/levelup/uploads/flyers
dc exec web   ls -la /srv/levelup/uploads/flyers
```

Both must list the same files. If one is empty, `UPLOAD_DIR` differs between
them or the volume is not mounted in both.

### Certificates are not issuing

```bash
dc logs caddy --tail 50
```

Usually DNS: both `PUBLIC_DOMAIN` and `ADMIN_DOMAIN` must resolve to this
server before Caddy starts. Fix DNS, wait for propagation, `dc restart caddy`.

### Disk is full

```bash
df -h
docker system prune -af --volumes   # NEVER: --volumes deletes uploads
docker system prune -af             # this one is safe
du -sh backups/*
```

Log rotation is configured (10MB × 5 per service). Old backups are pruned after
14 days by the backup script.

---

## 5. Routine operations

These are the owner's, not a developer's, and they are all in the panel.

**The owner's copy is [MANUAL.md](MANUAL.md), in Spanish** — this section was
written in English for a Mexican client who has to actually use it, which made
it a document nobody could read. The Spanish version is the real one and goes
further; what follows is a summary for whoever is maintaining the system.

- **Changing the bank account** — Ajustes. This is where customers are told to
  send their money, so it is the one setting whose being wrong stops every
  sale. The CLABE's check digit is validated on save, so a mistyped one is
  caught here rather than by a customer whose transfer bounces. If nothing is
  configured the storefront refuses to show payment details at all — it offers
  WhatsApp instead — and the dashboard carries a red banner until it is fixed.
- **Rotating the monthly flyer** — Combos → the campaign → upload the image.
- **Turning a combo on or off** — Combos → the combo. A combo that would
  deliver less than it advertises is refused; that is not a bug.
- **Approving a payment** — Aprobaciones. The comprobante is shown; check the
  amount matches before approving. An approval is what enqueues fulfilment.
- **Recording a WhatsApp sale** — Pedidos → Nuevo pedido manual. It goes
  through the same fulfilment path as a storefront order, with the same audit
  trail.
- **Adding testimonials** — Testimonios. They appear on the storefront's
  Confianza page immediately. Use real messages from real customers; if there
  are none the section simply does not render, which is the right outcome.
  Invented reviews on a page about trustworthiness are the opposite of the
  thing being claimed, and in this market they get spotted.

Nothing here requires a developer, which is the point.

---

## 6. What is not automated yet

Being explicit so none of it is discovered during an incident:

- The off-box backup login. The nightly job copies backups off the server, but
  only once the one-time rclone setup in §3 is done and `BACKUP_RCLONE_REMOTE`
  is set. Until then the log says so every night, and nobody reads it.
- Backup failure alerting. A failed backup or upload ends in `FAILED` in
  `/var/log/levelup-backup.log`; nothing sends that anywhere. Read the log.
- Docker upgrades and reboots. Ubuntu's security updates install themselves;
  Docker's do not, and nothing reboots for a new kernel. Both restart every
  container, so do them by hand at a quiet hour — stop the worker cleanly
  first (§2). `/var/run/reboot-required` exists when a reboot is due.
- Migrations on deploy. Deliberate, but it means remembering.
- Uptime alerting. The healthchecks restart containers; nothing tells a human
  the site was down. Point any external monitor at `/api/health`.
- Certificate expiry alerting. Caddy renews automatically; `TLS_EMAIL` is the
  fallback if renewal ever stops.
