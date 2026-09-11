#!/usr/bin/env bash
#
# Deploy LevelUp Store. Two subcommands, both meant to be run from
# /srv/levelup as the `levelup` deploy user — the same `cd /srv/levelup`
# convention docs/RUNBOOK.md uses throughout, and how scripts/backup.sh is
# invoked:
#
#   ./scripts/deploy.sh init                     # first deployment  — RUNBOOK §1
#   ./scripts/deploy.sh update                    # deploying a change — RUNBOOK §2
#   ./scripts/deploy.sh init <email> [password]   # non-interactive first admin
#
# This automates the MECHANICAL steps that docs/RUNBOOK.md §1 and §2 already
# describe by hand, in the same order, with real health checks instead of
# "wait and hope". It does not change what those sections say to do — read
# them if anything here is surprising; they are the ground truth.
#
# THE ONE RULE THIS MUST NEVER BREAK: migrations are not run automatically on
# a routine redeploy. `update` refuses to continue if the pull touched
# packages/db/migrations/, and tells the operator to run db:migrate by hand
# first. See run_migration_gate below. `init` is the one place migrations run
# automatically, and only because a brand-new database has no schema yet for
# that to silently alter (see docker-compose.prod.yml's own comment on the
# `tools` service).
#
set -Eeuo pipefail

# A bare "set -e" exit says nothing about where it stopped. At 3am the line
# number is the difference between fixing it and starting over. (-E above
# makes this fire inside functions too, not just top level — same reasoning
# as scripts/server-setup.sh's trap.) Kept in a variable, not inlined in the
# trap call, so run_quiet (below) can switch it off and back on around
# commands whose non-zero exit is an expected, handled outcome rather than a
# bug — without that, this generic message would fire (the ERR trap runs on
# any qualifying failure whether or not errexit is currently on) ahead of,
# and on top of, the specific one those callers print instead.
ERR_TRAP='printf "\n[deploy] STOPPED at line %s: %s\n[deploy] Fix the cause and re-run the same subcommand — both are safe to repeat.\n" "$LINENO" "$BASH_COMMAND" >&2'
trap "$ERR_TRAP" ERR

log()  { printf '\n[deploy] %s\n' "$*"; }
warn() { printf '\n[deploy] WARNING: %s\n' "$*" >&2; }
die()  { printf '\n[deploy] FAILED: %s\n' "$*" >&2; exit 1; }
banner() {
  local line
  printf '\n%s\n' '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' >&2
  for line in "$@"; do printf '!!  %s\n' "$line" >&2; done
  printf '%s\n\n' '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' >&2
}

COMPOSE_FILE="docker-compose.prod.yml"
dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

# Runs "$@" with errexit and the ERR trap both switched off for the duration,
# leaving its exit status in $QUIET_RC — for a command whose non-zero exit is
# something this script inspects and reports on itself (below), not a bug to
# dump a generic trace for.
QUIET_RC=0
run_quiet() {
  trap - ERR
  set +e
  "$@"
  QUIET_RC=$?
  set -e
  trap "$ERR_TRAP" ERR
}

# Runs one step and, on failure, names it before exiting — the ERR trap alone
# would only print the raw command and a line number, which is not much use
# to whoever is reading this at 3am.
run_step() {
  local desc="$1"
  shift
  log "==> $desc"
  run_quiet "$@"
  if [ "$QUIET_RC" -ne 0 ]; then
    die "step failed: $desc (exit $QUIET_RC). Command was: $*"
  fi
}

# ── reading .env ────────────────────────────────────────────────────────────
# Never `source .env`: it holds values with spaces (LEGAL_ADDRESS) and dashes
# that a shell would try to run as a command. This is the same problem and the
# same fix as scripts/backup.sh's env_file_value — grep the one line, strip
# quoting by hand. Kept identical here for consistency between the two
# scripts, not because deploy.sh needs the environment-variable-override
# layer backup.sh's `setting()` adds on top of it.
env_file_value() {
  local key="$1" file=".env" line value
  [ -r "$file" ] || return 0
  # Last assignment wins, as compose itself does.
  line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
    *)
      # Unquoted: drop a " # comment" and trailing spaces, as compose does.
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$value"
}

# ── shared sanity checks ────────────────────────────────────────────────────

require_repo_root() {
  if [ ! -f "$COMPOSE_FILE" ]; then
    die "no $COMPOSE_FILE in the current directory. Run this from the repo root: cd /srv/levelup && ./scripts/deploy.sh ..."
  fi
}

require_env_file() {
  if [ ! -f .env ]; then
    die "no .env here. cp .env.example .env, then edit it — docs/RUNBOOK.md §1 lists what must be right. Not proceeding without it."
  fi
}

# The handful of variables docs/RUNBOOK.md §1's table calls "must be right",
# plus TELEGRAM_BOT_TOKEN/TELEGRAM_ALERT_CHAT_ID: the worker refuses to start
# without them. Warns, does not hard-fail — an operator may have a reason the
# script cannot know, and the containers themselves will refuse to start (or
# run unhealthy) if something here is genuinely broken, which surfaces later
# in this same run.
REQUIRED_VARS=(
  POSTGRES_PASSWORD
  DATABASE_URL
  RA_API_KEY
  PUBLIC_DOMAIN
  ADMIN_DOMAIN
  TLS_EMAIL
  ADMIN_SESSION_SECRET
  TELEGRAM_BOT_TOKEN
  TELEGRAM_ALERT_CHAT_ID
)

check_required_vars() {
  local key value lower problems=()
  for key in "${REQUIRED_VARS[@]}"; do
    value="$(env_file_value "$key")"
    if [ -z "$value" ]; then
      problems+=("$key is empty")
      continue
    fi
    lower="${value,,}"
    if [[ "$lower" == *changeme* ]]; then
      problems+=("$key still looks like a placeholder ('$value')")
    fi
  done
  # Two specific, real defaults from .env.example that a plain `cp` carries
  # straight into production if nobody edits them.
  if [ "$(env_file_value POSTGRES_PASSWORD)" = "levelup_dev" ]; then
    problems+=("POSTGRES_PASSWORD is still .env.example's dev default ('levelup_dev') — generate one, do not reuse anything")
  fi
  case "$(env_file_value DATABASE_URL)" in
    *levelup_dev@*) problems+=("DATABASE_URL still embeds the dev password ('levelup_dev')") ;;
  esac

  if [ "${#problems[@]}" -gt 0 ]; then
    warn "some .env values look wrong — docs/RUNBOOK.md §1's table says these must be right:"
    local p
    for p in "${problems[@]}"; do
      printf '  - %s\n' "$p" >&2
    done
    warn "continuing anyway. Ctrl-C now if you want to fix .env first."
  else
    log ".env: the required values are at least non-empty and not obvious placeholders"
  fi
}

# ── postgres health ──────────────────────────────────────────────────────────
# Polls the container's own healthcheck instead of sleeping a fixed time. The
# healthcheck's start_period is 30s (docker-compose.prod.yml) because the
# first boot initialises the cluster; a slow first boot is exactly when a
# fixed sleep would be wrong.
wait_for_postgres_healthy() {
  local timeout=180 interval=3 waited=0 cid status
  log "waiting for postgres to report healthy (up to ${timeout}s)"
  while true; do
    cid="$(dc ps -q postgres)"
    if [ -n "$cid" ]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"
      case "$status" in
        healthy)
          log "postgres: healthy"
          return 0
          ;;
        unhealthy)
          die "postgres reported unhealthy. Check: dc logs postgres --tail 50"
          ;;
      esac
    fi
    if [ "$waited" -ge "$timeout" ]; then
      die "postgres did not report healthy within ${timeout}s. Check: dc ps ; dc logs postgres --tail 50"
    fi
    sleep "$interval"
    waited=$((waited + interval))
  done
}

# ── smoke test ────────────────────────────────────────────────────────────
# Same throwaway node:24-alpine container docs/RUNBOOK.md §1/§2 describe: the
# server has no Node of its own, and the script has no dependencies. Uses the
# real domains from .env, not the shell (.env is never sourced — see above).
run_smoke_test() {
  local public_domain admin_domain rc
  public_domain="$(env_file_value PUBLIC_DOMAIN)"
  admin_domain="$(env_file_value ADMIN_DOMAIN)"
  if [ -z "$public_domain" ] || [ -z "$admin_domain" ]; then
    die "PUBLIC_DOMAIN or ADMIN_DOMAIN is empty in .env — cannot run the smoke test. Fix .env and re-run."
  fi

  log "smoke test: https://$public_domain and https://$admin_domain"
  run_quiet docker run --rm -v "$PWD/scripts:/scripts:ro" node:24-alpine \
    node /scripts/smoke.mjs "https://$public_domain" "https://$admin_domain"
  rc=$QUIET_RC

  if [ "$rc" -ne 0 ]; then
    die "smoke test failed (exit $rc) — see its output above for what to fix. It is read-only and safe to re-run: docker run --rm -v \"\$PWD/scripts:/scripts:ro\" node:24-alpine node /scripts/smoke.mjs https://$public_domain https://$admin_domain"
  fi
  log "smoke test: passed"
}

show_service_status() {
  log "service status:"
  dc ps || true
}

# ── init ──────────────────────────────────────────────────────────────────

cmd_init() {
  local email="${1:-}" password="${2:-}" generated_password=false

  check_required_vars

  run_step "docker compose up -d --build" dc up -d --build
  wait_for_postgres_healthy

  # Fine to be automatic here only: a brand-new database has no schema yet,
  # so there is nothing for a migration to silently alter. Never do this in
  # `update` — see run_migration_gate.
  run_step "migrations (db:migrate)" \
    dc --profile tools run --rm tools pnpm db:migrate
  run_step "seed (db:seed) — 19 combos from phase0/catalog.mjs" \
    dc --profile tools run --rm tools pnpm db:seed

  # First admin user. There is no sign-up page — see apps/admin/src/scripts/
  # create-admin.ts — so this is the one place an account gets made.
  if [ -z "$email" ]; then
    if [ -t 0 ]; then
      read -r -p "Owner's email for the first admin account: " email
    fi
  fi
  if [ -z "$email" ]; then
    die "no email given and no terminal to prompt on. Re-run with: ./scripts/deploy.sh init <email> [password]"
  fi

  if [ -z "$password" ]; then
    command -v openssl >/dev/null 2>&1 || die "openssl not found (needed to generate a password). Install it, or pass one: ./scripts/deploy.sh init $email <password>"
    password="$(openssl rand -base64 18)"
    generated_password=true
  fi

  # create-admin.ts: `pnpm --filter @levelup/admin create-admin <email> <password> [name]`.
  # Re-running for an existing email RESETS its password — the documented
  # account-recovery path (docs/RUNBOOK.md §1) — so this call is safe to repeat.
  #
  # Not run through run_step: its failure message echoes the full command,
  # which would print the plaintext password to the terminal/log. Redacted
  # by hand below instead.
  log "==> create first admin ($email)"
  run_quiet dc --profile tools run --rm tools \
    pnpm --filter @levelup/admin create-admin "$email" "$password"
  if [ "$QUIET_RC" -ne 0 ]; then
    die "step failed: create first admin ($email) (exit $QUIET_RC). Command was: dc --profile tools run --rm tools pnpm --filter @levelup/admin create-admin $email <password redacted>"
  fi

  if [ "$generated_password" = true ]; then
    banner \
      "FIRST ADMIN PASSWORD — SAVE THIS NOW, IT IS NOT SHOWN AGAIN" \
      "" \
      "  email:    $email" \
      "  password: $password" \
      "" \
      "Not logged anywhere else by this script. If it's lost, recover it with:" \
      "  ./scripts/deploy.sh init $email '<a-new-password>'" \
      "(re-running create-admin for an existing email resets its password)"
  else
    warn "the password you passed on the command line is now in shell history unless this shell skips space-prefixed commands (docs/RUNBOOK.md §1)."
    log "admin account ready: $email"
  fi

  run_smoke_test
  show_service_status

  banner \
    "ONE STEP LEFT — NOTHING ELSE CAN AUTOMATE THIS" \
    "" \
    "1. Place a real \$10 Mega Oferta order through the storefront." \
    "2. Approve it in the panel (Aprobaciones)." \
    "3. Confirm the diamonds arrive in the game." \
    "" \
    "Nothing else proves the whole chain works — docs/RUNBOOK.md §1."

  log "init: done"
}

# ── update ────────────────────────────────────────────────────────────────

cmd_update() {
  local previous_head new_head

  previous_head="$(git rev-parse HEAD)"
  log "current HEAD: $previous_head"

  run_step "git pull" git pull

  new_head="$(git rev-parse HEAD)"
  if [ "$previous_head" = "$new_head" ]; then
    log "git pull: already up to date"
  else
    log "git pull: $previous_head -> $new_head"
  fi

  run_migration_gate "$previous_head" "$new_head"

  run_step "docker compose up -d --build" dc up -d --build
  # Compose replaces containers one service at a time. The worker's
  # stop_grace_period is 120s so it can finish a combo it is holding —
  # docker-compose.prod.yml sets this; never pass --timeout here to shorten it.

  run_smoke_test
  show_service_status

  log "update: done"
}

# The one branch where "automate less" is correct: never run migrations on a
# routine redeploy. Detects a schema change by diffing packages/db/migrations
# between the HEAD before and after this pull, and if anything moved, stops
# instead of guessing.
#
# NOTE (least certain part of this script): this assumes an ordinary
# fast-forward `git pull` on a full, linear clone, matching docs/RUNBOOK.md's
# "Get the code" (`git fetch origin && git checkout -t origin/main`, no
# --depth). If the pull ever involves a history rewrite (force-pushed main,
# a shallow clone missing $previous_head), `git diff` between the two SHAs
# can fail outright — handled below by dying rather than silently treating
# that as "nothing changed" — but it could in principle also succeed while
# reporting a misleading diff. If the server's checkout is ever shallow or
# main is ever force-pushed, verify by hand before trusting this gate.
run_migration_gate() {
  local previous_head="$1" new_head="$2" changed_migrations diff_rc

  # Needs the diff's output as well as its exit status, so this bypasses
  # run_quiet (which only reports status) and repeats its trap/errexit
  # dance inline instead — a non-zero exit here is handled below, not a bug.
  trap - ERR
  set +e
  changed_migrations="$(git diff --name-only "$previous_head" "$new_head" -- packages/db/migrations/)"
  diff_rc=$?
  set -e
  trap "$ERR_TRAP" ERR
  if [ "$diff_rc" -ne 0 ]; then
    die "could not diff packages/db/migrations/ between $previous_head and $new_head. Do NOT assume nothing changed — check by hand: git diff --name-only $previous_head $new_head -- packages/db/migrations/"
  fi

  if [ -n "$changed_migrations" ]; then
    cat >&2 <<EOF

[deploy] STOPPED: this pull changed the schema migrations:

$changed_migrations

[deploy] Migrations are never run automatically on a redeploy — a deploy
[deploy] should never silently alter the schema (docs/RUNBOOK.md §2). Run
[deploy] this yourself, then re-run './scripts/deploy.sh update':
[deploy]
[deploy]     dc --profile tools run --rm --build tools pnpm db:migrate
[deploy]
[deploy] ("dc" = docker compose -f docker-compose.prod.yml. --build matters
[deploy] here: the tools image is stale relative to the code just pulled.)

EOF
    exit 1
  fi

  log "no migration files changed in this pull"
}

# ── usage / dispatch ─────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy.sh init [email] [password]
  ./scripts/deploy.sh update
  ./scripts/deploy.sh --help

Run from /srv/levelup (docs/RUNBOOK.md's `cd /srv/levelup` convention), as the
`levelup` deploy user, with docker-compose.prod.yml and a filled-in .env
already in this directory.

  init      First deployment (docs/RUNBOOK.md §1). Builds and starts the
            stack, waits for postgres to actually report healthy, runs
            migrations and the seed against the brand-new database (safe:
            there is no schema yet for that to silently alter), creates the
            first admin user, and runs the smoke test.

            [email]     Owner's email for the first admin account. Prompted
                         for if omitted and a terminal is attached.
            [password]  Its password. If omitted, one is generated with
                         `openssl rand -base64 18` and printed once — save
                         it, it is not shown again and not logged anywhere
                         else by this script.

            Safe to re-run: db:migrate, db:seed, create-admin (see below) and
            `up -d --build` are all safe to repeat on their own. Re-running
            create-admin for an EXISTING email RESETS its password — this is
            also the documented account-recovery path (docs/RUNBOOK.md §1).

  update    Deploying a change (docs/RUNBOOK.md §2). Pulls, then REFUSES to
            continue if the pull touched packages/db/migrations/: migrations
            are never run automatically on a redeploy. It prints the exact
            command to run by hand, then re-run `update`. Otherwise: rebuilds
            and restarts the stack (docker compose replaces containers one at
            a time; the worker gets 120s to finish a combo it is holding) and
            runs the smoke test.

Both subcommands stop at the first failed step and name it. Fix the cause and
re-run the same subcommand — every step here is safe to repeat.
EOF
}

main() {
  local cmd="${1:-}"

  case "$cmd" in
    -h|--help)
      usage
      exit 0
      ;;
    '')
      usage
      exit 1
      ;;
    init)
      shift
      require_repo_root
      require_env_file
      cmd_init "$@"
      ;;
    update)
      shift
      require_repo_root
      require_env_file
      if [ "$#" -gt 0 ]; then
        die "update takes no arguments (got: $*). See --help."
      fi
      cmd_update
      ;;
    *)
      warn "unknown subcommand '$cmd'"
      usage
      exit 1
      ;;
  esac
}

main "$@"
