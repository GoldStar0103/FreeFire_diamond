# Runbook

Deploying and operating LevelUp Store. Written to be followed by someone who
did not build it, at 3am, under pressure.

Throughout: `cd /srv/levelup` first, and `dc` means
`docker compose -f docker-compose.prod.yml`.

---

## 1. First deployment

### Before you start

- A VPS with Docker and the compose plugin. 2 vCPU / 4GB is comfortable.
- Two DNS A records pointing at it: the store domain and the panel domain.
  **Set these up first.** Caddy requests certificates on startup, and Let's
  Encrypt rate-limits failed attempts.

### Steps

```bash
git clone <repo> /srv/levelup && cd /srv/levelup
cp .env.example .env
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
| `UPLOAD_DIR` | leave as `/srv/levelup/uploads` — it is a path inside the container |

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

### Verify before telling anyone it is live

```bash
curl -fsS https://$PUBLIC_DOMAIN/api/health   # {"status":"ok"}
curl -fsS https://$ADMIN_DOMAIN/api/health    # {"status":"ok"}
curl -fsSI https://$PUBLIC_DOMAIN/            # 200, valid certificate
dc ps                                          # all services healthy
dc logs worker --tail 20                       # "[worker] Starting"
```

Then, and this is the one that matters:

1. Place a real order for the $10 Mega Oferta through the storefront.
2. Approve it in the panel.
3. Confirm the diamonds arrive in the game.

Nothing else proves the whole chain works.

---

## 2. Deploying a change

```bash
cd /srv/levelup
git pull
dc up -d --build
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

`scripts/backup.sh` dumps the database and the uploads volume. Install it:

```bash
crontab -e
15 4 * * * cd /srv/levelup && ./scripts/backup.sh >> /var/log/levelup-backup.log 2>&1
```

**The backups land on the same disk as the data, which protects against
nothing that destroys the disk.** Copy them off-box — `rclone` to any object
store, or `scp` on a cron from elsewhere. Until that is set up, the backup
strategy is incomplete and you should say so out loud.

### Restoring

Database:

```bash
dc stop web admin worker            # nothing writing while we restore
gunzip -c backups/db-YYYYMMDD-HHMMSS.sql.gz \
  | dc exec -T postgres psql --username levelup --dbname levelup
dc start web admin worker
```

The dump is `--clean --if-exists`, so it drops and recreates as it goes.

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

### Practise this

Do a restore into a scratch environment once, before you need it. A backup
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

This means the wallet moved by an amount that does not match what the item
costs, so we refused to guess. Resolve it by hand:

1. Open the RecargasAmérica panel and find the transaction by time and amount.
2. If it went through, mark the item delivered in the panel.
3. If it did not, retry the order.

Never guess. Diamonds cannot be recovered once delivered.

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

- Off-box backup copying. Set this up.
- Migrations on deploy. Deliberate, but it means remembering.
- Uptime alerting. The healthchecks restart containers; nothing tells a human
  the site was down. Point any external monitor at `/api/health`.
- Certificate expiry alerting. Caddy renews automatically; `TLS_EMAIL` is the
  fallback if renewal ever stops.
