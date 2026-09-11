#!/usr/bin/env bash
#
# One-time bootstrap for a fresh Ubuntu 24.04 VPS: Docker from Docker's own
# repository, a deploy user, SSH hardening, a firewall, automatic security
# updates, fail2ban and swap. Everything after this is docs/RUNBOOK.md §1.
#
# Run as root, on the server:
#
#   scp scripts/server-setup.sh root@<vps-ip>:/root/
#   ssh root@<vps-ip>
#   bash /root/server-setup.sh
#
# The deploy user is "levelup" unless you say otherwise:
#
#   DEPLOY_USER=someone bash /root/server-setup.sh
#
# Safe to re-run — every step checks before it changes anything. Once root
# login is off, re-run it as the deploy user: `sudo bash /root/server-setup.sh`
# (sudo drops environment variables: `sudo DEPLOY_USER=someone bash ...`).
# On a box where the store is already running it skips the package upgrade,
# because that can restart Docker underneath a worker that is halfway through
# a paid combo.
#
# The one step that can lock everybody out is SSH hardening, so it only runs
# once the deploy user demonstrably has a key to log in with. Even then: keep
# this root session open until you have logged in as the deploy user from a
# second terminal.

set -Eeuo pipefail

# A bare "set -e" exit says nothing about where it stopped. At 3am the line
# number is the difference between fixing it and starting over.
trap 'printf "\n[setup] STOPPED at line %s: %s\n[setup] Fix the cause and re-run; the script is safe to re-run.\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

DEPLOY_USER="${DEPLOY_USER:-levelup}"
APP_DIR="/srv/levelup"
SWAP_FILE="/swapfile"
# "00-" so it sorts before anything a provider image drops in: sshd keeps the
# FIRST value it reads for each setting, and cloud images commonly ship
# 50-cloud-init.conf with "PasswordAuthentication yes".
SSHD_DROPIN="/etc/ssh/sshd_config.d/00-levelup-hardening.conf"
SUDOERS_FILE="/etc/sudoers.d/90-levelup-deploy"
F2B_JAIL="/etc/fail2ban/jail.d/levelup-sshd.local"
# Docker's release signing key, as published on docs.docker.com. Checked so a
# tampered download fails here rather than becoming a trusted apt source.
DOCKER_GPG_FINGERPRINT="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"

EXIT_CODE=0
SSH_STATUS="not attempted"

log()  { printf '\n[setup] %s\n' "$*"; }
warn() { printf '\n[setup] WARNING: %s\n' "$*" >&2; }
die()  { printf '\n[setup] FAILED: %s\n' "$*" >&2; exit 1; }
banner() {
  local line
  printf '\n%s\n' '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' >&2
  for line in "$@"; do printf '!!  %s\n' "$line" >&2; done
  printf '%s\n\n' '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' >&2
}

# ── preflight ─────────────────────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  die "run this as root (or: sudo bash $0)"
fi

if [ ! -r /etc/os-release ]; then
  die "cannot read /etc/os-release; this script is for Ubuntu 24.04"
fi
# shellcheck source=/dev/null
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  die "this script is for Ubuntu 24.04; this machine is ${PRETTY_NAME:-unknown}"
fi
if [ "${VERSION_ID:-}" != "24.04" ]; then
  warn "written and checked for Ubuntu 24.04; this is ${VERSION_ID:-unknown}. Continuing — read the output."
fi

if [ "$DEPLOY_USER" = "root" ] || ! [[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  die "DEPLOY_USER='$DEPLOY_USER' is not a usable name for a non-root user"
fi

# apt must never stop to ask a question: this may be running over a flaky SSH
# session, and a prompt nobody sees looks exactly like a hang.
export DEBIAN_FRONTEND=noninteractive

apt_get() {
  # The lock timeout matters on a VPS's first minutes: cloud-init or the daily
  # apt job is often still holding the dpkg lock, and without it apt fails
  # immediately instead of waiting its turn. confdef/confold keep any config
  # file the provider customised rather than prompting about it.
  apt-get -y -q \
    -o DPkg::Lock::Timeout=600 \
    -o Dpkg::Options::=--force-confdef \
    -o Dpkg::Options::=--force-confold \
    "$@"
}

# ── timezone ──────────────────────────────────────────────────────────────────
# UTC, deliberately — not America/Mexico_City. The app stores every time as
# timestamptz, an absolute instant, and the containers run in UTC whatever the
# host says, so the host's zone changes nothing in the data. It only changes
# what logs, cron and `date` print, and UTC keeps those agreeing with Postgres,
# Caddy and Docker without anyone converting in their head mid-incident.
# The cost is that cron times are UTC: Mexico City is UTC-6 all year (no DST
# since 2022), which docs/RUNBOOK.md §3 accounts for in the backup schedule.

current_tz="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
case "$current_tz" in
  UTC | Etc/UTC)
    log "timezone: $current_tz — leaving it"
    ;;
  *)
    timedatectl set-timezone Etc/UTC
    log "timezone: was '${current_tz:-unknown}', now Etc/UTC"
    ;;
esac

# ── packages ──────────────────────────────────────────────────────────────────

stack_running=false
if command -v docker >/dev/null 2>&1 && [ -n "$(docker ps -q 2>/dev/null || true)" ]; then
  stack_running=true
fi

# needrestart (installed by default on 24.04) otherwise stops apt to ask which
# services to restart. On a fresh box, restart them; with the store running,
# only list them — restarting services is not this script's call to make there.
if [ "$stack_running" = true ]; then
  export NEEDRESTART_MODE=l
else
  export NEEDRESTART_MODE=a
fi

# A run cut off mid-install (a dropped SSH session, say) leaves dpkg half
# done, and every apt command after that refuses to run until this is fixed.
if [ -n "$(dpkg --audit 2>/dev/null || true)" ]; then
  log "apt: finishing an install interrupted by an earlier run"
  dpkg --configure -a
fi

log "apt: updating package lists"
apt_get update

if [ "$stack_running" = true ]; then
  # Upgrading docker-ce or containerd.io restarts the daemon, and every
  # container with it — including a worker that may be holding a paid combo.
  # Security updates keep arriving through unattended-upgrades (below), which
  # never touches Docker's repository.
  warn "containers are running, so the full package upgrade is skipped. Upgrade by hand at a quiet hour (see docs/RUNBOOK.md §2 on stopping the worker cleanly)."
else
  log "apt: upgrading installed packages"
  # --with-new-pkgs so a new kernel is actually installed rather than "kept
  # back"; unlike full-upgrade it never removes anything.
  apt_get upgrade --with-new-pkgs
fi

log "apt: installing base tools"
# python3-systemd: lets fail2ban read sshd's log from the journal, which works
# whether or not the image writes /var/log/auth.log. rclone: off-box backups,
# see scripts/backup.sh. git: the repo is cloned onto the server.
apt_get install \
  curl ca-certificates gnupg git \
  ufw fail2ban python3-systemd unattended-upgrades \
  rclone

# ── Docker Engine, from Docker's apt repository ───────────────────────────────
# Not Ubuntu's docker.io (older, and its compose is a different package), and
# not the curl|sh convenience script (which Docker itself says not to use in
# production). The official repo gets security fixes the day they ship.

conflicts=()
for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  status="$(dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null || true)"
  if [ "$status" = "install ok installed" ]; then
    conflicts+=("$pkg")
  fi
done
if [ "${#conflicts[@]}" -gt 0 ]; then
  warn "removing packages that conflict with Docker's own: ${conflicts[*]}"
  apt_get remove "${conflicts[@]}"
fi

log "docker: adding Docker's apt repository"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc.new

gpg_home="$(mktemp -d)"
key_fpr="$(GNUPGHOME="$gpg_home" gpg --batch --show-keys --with-colons /etc/apt/keyrings/docker.asc.new 2>/dev/null \
  | awk -F: '$1 == "fpr" && !seen { print $10; seen = 1 }' || true)"
rm -rf "$gpg_home"
if [ "$key_fpr" != "$DOCKER_GPG_FINGERPRINT" ]; then
  rm -f /etc/apt/keyrings/docker.asc.new
  die "Docker's signing key has fingerprint '${key_fpr:-unreadable}', expected $DOCKER_GPG_FINGERPRINT. Either the download was tampered with or Docker rotated its key — check https://docs.docker.com/engine/install/ubuntu/ before changing DOCKER_GPG_FINGERPRINT."
fi
mv /etc/apt/keyrings/docker.asc.new /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

docker_codename="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
if [ -z "$docker_codename" ]; then
  die "cannot tell which Ubuntu release this is (no UBUNTU_CODENAME in /etc/os-release)"
fi
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' \
  "$(dpkg --print-architecture)" "$docker_codename" > /etc/apt/sources.list.d/docker.list

apt_get update
log "docker: installing Engine and the compose plugin"
# --no-upgrade: on a re-run, an already-installed Docker stays exactly as it
# is. Upgrading it restarts every container, and that is a decision for a
# human at a quiet hour, not a side effect of re-running a setup script.
apt_get install --no-upgrade \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now containerd.service docker.service

docker_version="$(docker version --format '{{.Server.Version}}')"
compose_version="$(docker compose version --short)"
log "docker: Engine $docker_version, compose $compose_version"

# ── deploy user ───────────────────────────────────────────────────────────────

if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  log "user: $DEPLOY_USER already exists"
else
  # Password '*' is "no password will ever match", not "locked": key logins
  # work whatever sshd's UsePAM says, and password logins cannot.
  useradd --create-home --user-group --shell /bin/bash --password '*' "$DEPLOY_USER"
  log "user: created $DEPLOY_USER"
fi
usermod -aG sudo,docker "$DEPLOY_USER"
DEPLOY_GROUP="$(id -gn "$DEPLOY_USER")"
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"

# Passwordless sudo. The account has no password (logins are key-only), so
# without this it could not use sudo at all. And it is in the docker group,
# which is root-equivalent anyway — anyone in it can mount / into a container —
# so a sudo password would add a prompt, not protection. The SSH key is the
# credential; guard that.
sudoers_tmp="$(mktemp)"
printf '# Managed by scripts/server-setup.sh.\n%s ALL=(ALL:ALL) NOPASSWD:ALL\n' "$DEPLOY_USER" > "$sudoers_tmp"
chmod 0440 "$sudoers_tmp"
if ! visudo -cqf "$sudoers_tmp"; then
  rm -f "$sudoers_tmp"
  die "the generated sudoers entry failed visudo's check; nothing was installed"
fi
install -m 0440 -o root -g root "$sudoers_tmp" "$SUDOERS_FILE"
rm -f "$sudoers_tmp"

# Keys: root's authorized_keys, merged in line by line so a re-run never drops
# a key someone has since added for the deploy user.
ssh_dir="$DEPLOY_HOME/.ssh"
auth_keys="$ssh_dir/authorized_keys"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "$ssh_dir"
if [ ! -f "$auth_keys" ]; then
  install -m 0600 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" /dev/null "$auth_keys"
fi

if [ -s /root/.ssh/authorized_keys ]; then
  # Appending to a file whose last line has no newline would glue two keys
  # into one line that matches neither.
  if [ -s "$auth_keys" ] && [ -n "$(tail -c 1 "$auth_keys")" ]; then
    printf '\n' >> "$auth_keys"
  fi
  added=0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      '' | '#'*) continue ;;
    esac
    # A line that does not start with the key type carries options, and some
    # images give root's keys a command="echo please log in as ..." that ends
    # the session. Copied over, that would pass every check below and then
    # lock out the deploy user the moment root login is switched off.
    case "${line%%[[:space:]]*}" in
      ssh-* | ecdsa-* | sk-*) ;;
      *)
        warn "not copying one of root's keys: it has options in front of it (${line:0:40}...). Add that key to $auth_keys by hand if it is needed."
        continue
        ;;
    esac
    if ! grep -qxF -- "$line" "$auth_keys"; then
      printf '%s\n' "$line" >> "$auth_keys"
      added=$((added + 1))
    fi
  done < /root/.ssh/authorized_keys
  log "user: copied $added new key(s) from root's authorized_keys"
else
  log "user: root has no authorized_keys to copy"
fi
chown "$DEPLOY_USER:$DEPLOY_GROUP" "$auth_keys"
chmod 0600 "$auth_keys"

# ssh-keygen parses the file the way sshd will, so a garbled line does not
# count as a key. It exits non-zero when there are none.
key_count="$(ssh-keygen -l -f "$auth_keys" 2>/dev/null | wc -l || true)"
key_count="${key_count//[[:space:]]/}"
if [ -z "$key_count" ]; then
  key_count=0
fi

# ── /srv/levelup ──────────────────────────────────────────────────────────────
# Owned by the deploy user so it can clone, pull and edit .env without sudo.
# 0750: .env holds every secret the store has, and the default umask would
# leave it world-readable. Backups are written by root's cron job and are 0600
# inside; see scripts/backup.sh.

install -d -m 0750 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "$APP_DIR"
install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_GROUP" "$APP_DIR/backups"
# install -d does not reliably re-apply ownership to a directory that already
# exists. Not recursive: backup files inside stay root's.
chown "$DEPLOY_USER:$DEPLOY_GROUP" "$APP_DIR" "$APP_DIR/backups"
chmod 0750 "$APP_DIR"
chmod 0700 "$APP_DIR/backups"
log "dirs: $APP_DIR and $APP_DIR/backups owned by $DEPLOY_USER"

# ── swap ──────────────────────────────────────────────────────────────────────
# Building the two Next images is this box's memory peak, well above what the
# running stack needs. Without swap, an OOM kill there fails the deploy — or
# worse, lands on Postgres. 2GB is a safety net for builds, not working memory.

make_swapfile() {
  # $1: fallocate (instant, fine on ext4) or dd (slow, works everywhere —
  # some filesystems refuse a preallocated file as swap).
  rm -f "$SWAP_FILE"
  if [ "$1" = "fallocate" ]; then
    fallocate -l 2G "$SWAP_FILE"
  else
    dd if=/dev/zero of="$SWAP_FILE" bs=1M count=2048 status=none
  fi
  chmod 0600 "$SWAP_FILE"
  mkswap "$SWAP_FILE" >/dev/null
}

active_swaps="$(swapon --show=NAME --noheadings 2>/dev/null || true)"
if [ -n "$active_swaps" ]; then
  log "swap: already present ($(printf '%s' "$active_swaps" | tr '\n' ' ')), leaving it"
elif [ -f "$SWAP_FILE" ]; then
  # Left by an earlier run or by someone else. Use it, but do not guess
  # whether it is safe to delete.
  chmod 0600 "$SWAP_FILE"
  if ! swapon "$SWAP_FILE"; then
    die "$SWAP_FILE exists but will not work as swap. Check it (ls -l $SWAP_FILE), remove it if it is a leftover, and re-run."
  fi
  log "swap: $SWAP_FILE on"
else
  if ! { make_swapfile fallocate && swapon "$SWAP_FILE"; } 2>/dev/null; then
    make_swapfile dd
    swapon "$SWAP_FILE"
  fi
  log "swap: $SWAP_FILE (2GB) created and on"
fi

# Persist it, but only if /swapfile is what is actually in use — never add a
# line for a file that may not be valid swap, or the next boot trips over it.
active_swaps="$(swapon --show=NAME --noheadings 2>/dev/null || true)"
case $'\n'"$active_swaps"$'\n' in
  *$'\n'"$SWAP_FILE"$'\n'*)
    if ! grep -qE "^[[:space:]]*${SWAP_FILE}[[:space:]]" /etc/fstab; then
      printf '%s none swap sw 0 0\n' "$SWAP_FILE" >> /etc/fstab
      log "swap: added $SWAP_FILE to /etc/fstab so it survives a reboot"
    fi
    ;;
esac

# ── firewall (ufw) ────────────────────────────────────────────────────────────
# Default deny in, then exactly what the store needs: SSH, HTTP (Let's Encrypt
# and the redirect to HTTPS), HTTPS, and 443/udp for HTTP/3.
#
# Docker-published ports BYPASS ufw: Docker writes its own iptables rules and
# they are consulted before ufw's. That is acceptable here only because Caddy
# is the one service that publishes anything, and 80/443 are meant to be open.
# Adding `ports:` to any other service in docker-compose.prod.yml puts it on
# the internet no matter what ufw says — the panel's port, or Postgres's, most
# of all. If something must be reachable for debugging, bind it to 127.0.0.1
# and use an SSH tunnel.
#
# Hostinger's own firewall (hPanel → VPS → Security) sits in front of all
# this and must allow the same ports.

# sshd refuses to validate or print its config without its runtime directory,
# which on 24.04 only exists while ssh.service is running. Harmless if present.
install -d -m 0755 /run/sshd

# Allow whatever port sshd is actually configured on, not just 22: enabling a
# firewall that blocks the SSH port you are connected through is the classic
# way to lose a server.
ssh_ports="$(/usr/sbin/sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' || true)"

ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
if ! ufw allow OpenSSH >/dev/null; then
  ufw allow 22/tcp >/dev/null
fi
for port in $ssh_ports; do
  if [ "$port" != "22" ]; then
    ufw allow "${port}/tcp" >/dev/null
  fi
done
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
log "firewall: ufw on — SSH, 80/tcp, 443/tcp, 443/udp"

# ── fail2ban ──────────────────────────────────────────────────────────────────
# The stock sshd jail, reading the journal. Every public IPv4 gets password
# guessing within minutes of coming up; with password auth off this is mostly
# log hygiene, and a real brake if password auth ever has to stay on.

cat > "$F2B_JAIL" <<'EOF'
# Managed by scripts/server-setup.sh. The stock sshd jail, reading the journal
# so it works whether or not the image writes /var/log/auth.log.
[sshd]
enabled = true
backend = systemd
EOF
systemctl enable fail2ban.service >/dev/null 2>&1
systemctl restart fail2ban.service

f2b_ok=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if fail2ban-client status sshd >/dev/null 2>&1; then
    f2b_ok=true
    break
  fi
  sleep 1
done
if [ "$f2b_ok" = true ]; then
  log "fail2ban: sshd jail active"
else
  warn "fail2ban did not report an active sshd jail. Check: systemctl status fail2ban; journalctl -u fail2ban -n 50"
  EXIT_CODE=1
fi

# ── automatic security updates ────────────────────────────────────────────────
# Ubuntu's stock policy (50unattended-upgrades) installs from the -security
# pocket only, which is what we want. Docker's repository is deliberately NOT
# in it: upgrading Docker restarts every container, including a worker that
# may be halfway through a paid combo. Automatic reboots stay off for the same
# reason — /var/run/reboot-required appears when a kernel update needs one.

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
// Managed by scripts/server-setup.sh: refresh package lists and install
// security updates daily.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades.service >/dev/null 2>&1
log "updates: unattended security upgrades on"

# ── SSH hardening ─────────────────────────────────────────────────────────────
# Last, because it is the one step that can lock everybody out. Password login
# and root login go off only if the deploy user has at least one key sshd can
# parse. A fresh VPS is often handed over with only a root password, and
# switching that off with no key in place leaves nothing but the provider's
# recovery console.

if [ "$key_count" -eq 0 ]; then
  SSH_STATUS="SKIPPED: $DEPLOY_USER has no SSH key. Password and root login are still ON."
  banner \
    "SSH HARDENING SKIPPED" \
    "" \
    "$DEPLOY_USER has no SSH key, so password login and root login were left ON." \
    "The server is reachable, but not hardened, and $DEPLOY_USER cannot log in yet." \
    "" \
    "Fix: from your own computer, put your public key on root:" \
    "    ssh-copy-id root@<vps-ip>" \
    "then run this script again. It copies the key to $DEPLOY_USER and" \
    "finishes the hardening. (docs/RUNBOOK.md section 1 has a Windows version.)"
  if [ -f "$SSHD_DROPIN" ]; then
    warn "$SSHD_DROPIN already exists from an earlier run, so password login may already be off. Do not close this session until someone can log in with a key."
  fi
  EXIT_CODE=1
else
  log "ssh: $DEPLOY_USER has $key_count key(s):"
  ssh-keygen -l -f "$auth_keys" || true

  install -d -m 0755 /etc/ssh/sshd_config.d
  previous_dropin=""
  if [ -f "$SSHD_DROPIN" ]; then
    previous_dropin="$(mktemp)"
    cp -p "$SSHD_DROPIN" "$previous_dropin"
  fi

  cat > "$SSHD_DROPIN" <<'EOF'
# Managed by scripts/server-setup.sh. Keys only, and no root.
# Log in as the deploy user and use sudo.
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
  chmod 0644 "$SSHD_DROPIN"

  # Validate before reloading. A config sshd cannot parse means the next
  # connection fails to start sshd at all, which is a lockout of its own.
  if ! /usr/sbin/sshd -t; then
    if [ -n "$previous_dropin" ]; then
      mv "$previous_dropin" "$SSHD_DROPIN"
    else
      rm -f "$SSHD_DROPIN"
    fi
    SSH_STATUS="FAILED: sshd rejected the config. Previous config restored; nothing reloaded."
    warn "$SSH_STATUS"
    EXIT_CODE=1
  else
    if [ -n "$previous_dropin" ]; then
      rm -f "$previous_dropin"
    fi

    # sshd keeps the first value it reads for each setting, so something read
    # earlier (a line above the Include in sshd_config) could still win.
    # Check what sshd will actually do instead of assuming.
    effective="$(/usr/sbin/sshd -T 2>/dev/null || true)"
    eff_password="$(printf '%s\n' "$effective" | awk '$1 == "passwordauthentication" { v = $2 } END { print v }')"
    eff_root="$(printf '%s\n' "$effective" | awk '$1 == "permitrootlogin" { v = $2 } END { print v }')"

    # Ubuntu 24.04 starts sshd through ssh.socket. While anyone is connected
    # (you, now) ssh.service is running and a reload makes it re-read its
    # config; existing sessions are not dropped. If only the socket is up,
    # the next connection starts sshd, which reads the new file anyway.
    if systemctl is-active --quiet ssh.service; then
      systemctl reload ssh.service
    elif systemctl is-active --quiet ssh.socket; then
      log "ssh: socket-activated and idle; the next connection uses the new config"
    else
      warn "neither ssh.service nor ssh.socket is active. Check with: systemctl status ssh.service ssh.socket"
      EXIT_CODE=1
    fi

    if [ "$eff_password" = "no" ] && [ "$eff_root" = "no" ]; then
      SSH_STATUS="ON: keys only, root login off."
      log "ssh: hardened (passwordauthentication $eff_password, permitrootlogin $eff_root)"
    else
      SSH_STATUS="WRITTEN BUT NOT EFFECTIVE: sshd reports passwordauthentication='${eff_password:-?}', permitrootlogin='${eff_root:-?}'."
      warn "$SSH_STATUS Something earlier in /etc/ssh/sshd_config or sshd_config.d/ overrides $SSHD_DROPIN. Find it with: grep -rniE 'passwordauth|permitroot' /etc/ssh/"
      EXIT_CODE=1
    fi
  fi
fi

# ── done: what now ────────────────────────────────────────────────────────────

server_ip="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
server_ip="${server_ip:-<vps-ip>}"

reboot_note="no"
if [ -f /var/run/reboot-required ]; then
  if [ "$stack_running" = true ]; then
    reboot_note="YES — at a quiet hour, after stopping the worker cleanly (docs/RUNBOOK.md §2)"
  else
    reboot_note="YES — after step 1 below works (a reboot ends this root session too): sudo reboot"
  fi
fi

swap_now="$(swapon --show=NAME,SIZE --noheadings 2>/dev/null | tr -s ' \n' '  ' || true)"
tz_now="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"

cat <<EOF

========================================================================
 Server setup finished
========================================================================
 Docker          Engine ${docker_version}, compose ${compose_version}
 Deploy user     ${DEPLOY_USER} (sudo, docker), ${key_count} SSH key(s)
 SSH hardening   ${SSH_STATUS}
 Firewall        ufw: SSH, 80/tcp, 443/tcp, 443/udp
 Swap            ${swap_now:-none}
 Timezone        ${tz_now:-?}
 App directory   ${APP_DIR} (owner ${DEPLOY_USER})
 Reboot needed   ${reboot_note}
========================================================================

 Next:

 1. KEEP THIS ROOT SESSION OPEN. In a second terminal:

        ssh ${DEPLOY_USER}@${server_ip}
        sudo true && docker ps

    Both must work before you close this one.

 2. In hPanel, check the VPS firewall (VPS -> Security -> Firewall).
    If a firewall is configured there it must allow TCP 22, 80, 443 and
    UDP 443, or Let's Encrypt and your customers never reach this box.

 3. As ${DEPLOY_USER}, continue with docs/RUNBOOK.md section 1, "Steps":
    get the repo into ${APP_DIR}, create .env from .env.example, then
    docker compose -f docker-compose.prod.yml up -d --build

 4. Then docs/RUNBOOK.md section 3: the nightly backup cron job, and the
    one-time rclone setup that copies backups off this server.

EOF

exit "$EXIT_CODE"
