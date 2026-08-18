#!/usr/bin/env bash
#
# Provision the FULL OpenReply stack on the Oracle box: Postgres, Redis, Caddy,
# the web app and the worker, all on one host with no external datastore.
#
# Run as the default `ubuntu` user:
#   bash deploy/oracle-box-setup.sh
#
# Safe to re-run; every step checks before acting.
#
# IMPORTANT — this script deliberately does NOT touch the running worker's
# environment and does NOT restart it. Until you cut over, the worker keeps
# talking to whatever database it is already configured for. It writes the new
# local connection strings to /etc/openreply/db-credentials.txt for you to paste
# in at cutover time; wiring them in earlier would mean an unattended crash
# restart silently repointed a live worker at an empty database.
#
# Sized for VM.Standard.E2.1.Micro (1 GB, 956 MB usable). Measured on the box
# with only the worker running: 411 MB used, 2 GB swapfile already 238 MB in.
# Adding Postgres (~90M), Redis (~25M), the web app (~150M) and Caddy (~20M)
# lands around 700 MB, so the tuning below is load-bearing, not hardening.

set -euo pipefail

# apt has no controlling tty here, and on 1/8 OCPU the package unpacking is slow
# enough that an interactive SSH session can drop mid-install. Run this detached
# so a lost connection cannot take the provisioning with it:
#   setsid nohup bash deploy/oracle-box-setup.sh > /tmp/provision.log 2>&1 &
export DEBIAN_FRONTEND=noninteractive

APP_DIR="/home/ubuntu/openreply"
WEB_DIR="/home/ubuntu/openreply-web"
ENV_DIR="/etc/openreply"
DB_NAME="${DB_NAME:-openreply}"
DB_USER="${DB_USER:-openreply}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
DOMAIN="${DOMAIN:-dm.nomadminh.com}"

log() { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

[ -d "$APP_DIR/.git" ] || {
  echo "Expected the repo at $APP_DIR. Run deploy/oracle-worker-setup.sh first." >&2
  exit 1
}

# ---------------------------------------------------------------- clock -------
# The heartbeat in lib/ops/worker-health.ts is compared against the reader's
# clock, so a skewed host clock would make /api/health report the worker as down
# while it is sending fine. Asserted rather than fixed — this box is already on
# UTC with NTP, and this keeps it that way on a rebuild.
log "Asserting the clock is UTC with NTP"
sudo timedatectl set-timezone UTC
sudo timedatectl set-ntp true
note "$(timedatectl show --property=TimeUSec --value 2>/dev/null || date -u)"

# ----------------------------------------------------------------- swap -------
log "Ensuring a $SWAP_SIZE swapfile"
if ! sudo swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l "$SWAP_SIZE" /swapfile || \
    sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || \
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  # Swap here is an emergency cushion against an OOM kill, not a place to run
  # from — 1/8 OCPU makes swap thrashing very slow.
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-openreply.conf >/dev/null
  sudo sysctl -q --system
else
  note "already present"
fi
free -h | sed 's/^/    /'

# -------------------------------------------------------------- packages ------
log "Installing Postgres and Redis"
sudo apt-get update -qq
sudo apt-get install -y -qq postgresql curl ca-certificates gnupg

# Redis from the official repo, not the distro. Ubuntu 22.04 ships 6.0.16 and
# BullMQ — which is the queue that actually delivers the DMs — warns that it
# wants 6.2.0 as a minimum.
if ! command -v redis-server >/dev/null 2>&1; then
  curl -fsSL https://packages.redis.io/gpg \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/redis-archive-keyring.gpg
  sudo chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb jammy main" \
    | sudo tee /etc/apt/sources.list.d/redis.list >/dev/null
  sudo apt-get update -qq
fi
sudo apt-get install -y -qq redis-server

PG_VERSION="$(ls /etc/postgresql | sort -V | tail -1)"
PG_CONF_DIR="/etc/postgresql/$PG_VERSION/main"
note "Postgres $PG_VERSION at $PG_CONF_DIR"

log "Installing Caddy"
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
else
  note "already installed"
fi

# -------------------------------------------------------------- postgres ------
# Debian's postgresql.conf ends with include_dir = 'conf.d', so a drop-in is the
# idempotent way to tune without ever rewriting the packaged config.
log "Tuning Postgres for a 1 GB host"
sudo tee "$PG_CONF_DIR/conf.d/openreply.conf" >/dev/null <<'PGEOF'
# Sized for a 1 GB box shared with Redis, a Node web app and a Node worker.
# The whole database is ~16 MB, so 64MB of shared_buffers holds it entirely;
# anything more would be memory taken from the app processes for nothing.
listen_addresses = 'localhost'
max_connections = 20
shared_buffers = 64MB
effective_cache_size = 192MB
work_mem = 4MB
maintenance_work_mem = 32MB
# The app stores UTC in `timestamp without time zone` columns; keep the server
# in UTC so anything that does use now() agrees with the stored values.
timezone = 'UTC'
PGEOF
sudo systemctl restart postgresql
sudo systemctl enable -q postgresql

# The postgres user cannot read /home/ubuntu, and runuser keeps the caller's
# working directory, so every psql call would print a "could not change
# directory" warning. Harmless, but it buries real errors in the log.
cd /

log "Creating the $DB_NAME database"
if ! sudo runuser -u postgres -- psql -tAc \
  "select 1 from pg_roles where rolname='$DB_USER'" | grep -q 1; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  sudo runuser -u postgres -- psql -q -c \
    "create role \"$DB_USER\" with login password '$DB_PASSWORD'"
  sudo mkdir -p "$ENV_DIR"
  sudo tee "$ENV_DIR/db-credentials.txt" >/dev/null <<EOF
# Generated by deploy/oracle-box-setup.sh. Paste these into BOTH
# $ENV_DIR/worker.env and $ENV_DIR/web.env at cutover time — not before.
DATABASE_URL=postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME
REDIS_URL=redis://127.0.0.1:6379
EOF
  sudo chmod 600 "$ENV_DIR/db-credentials.txt"
  note "credentials written to $ENV_DIR/db-credentials.txt"
else
  note "role $DB_USER already exists; leaving its password alone"
fi

if ! sudo runuser -u postgres -- psql -tAc \
  "select 1 from pg_database where datname='$DB_NAME'" | grep -q 1; then
  sudo runuser -u postgres -- createdb -O "$DB_USER" "$DB_NAME"
  note "created database $DB_NAME"
else
  note "database $DB_NAME already exists"
fi

# ----------------------------------------------------------------- redis ------
log "Configuring Redis"
sudo tee /etc/redis/openreply.conf >/dev/null <<'REDISEOF'
# Plain "127.0.0.1" rather than "127.0.0.1 -::1": the optional-address dash
# prefix is Redis 6.2+, and Ubuntu 22.04 ships 6.0, where it is a parse error
# that stops the server from starting at all.
bind 127.0.0.1
maxmemory 64mb
# noeviction is mandatory, not a preference: this Redis holds the BullMQ send
# queue, and evicting a key under memory pressure would silently drop queued
# DMs. Better to fail a write loudly than to lose a send.
maxmemory-policy noeviction
# The official Redis package ships a Type=notify unit, which needs the server to
# signal readiness. Without this, redis starts and is then killed by systemd
# with result 'protocol' — and because both app units declare
# Requires=redis-server, they go down with it.
supervised systemd
daemonize no
REDISEOF
# Redis has no conf.d; later directives win, so the include goes at the end.
# The grep needs sudo — redis.conf is 0640 root:redis, and an unprivileged grep
# fails with "Permission denied", which reads as "not present" and appends a
# duplicate include on every run.
if ! sudo grep -q '^include /etc/redis/openreply.conf' /etc/redis/redis.conf; then
  echo 'include /etc/redis/openreply.conf' | sudo tee -a /etc/redis/redis.conf >/dev/null
fi
sudo systemctl restart redis-server
sudo systemctl enable -q redis-server
redis-cli ping >/dev/null 2>&1 && note "redis responding" || {
  echo "Redis did not come up; check: journalctl -xeu redis-server" >&2
  exit 1
}

# ------------------------------------------------------------- web layout -----
log "Preparing the web release layout"
sudo -u ubuntu mkdir -p "$WEB_DIR/releases"
note "$WEB_DIR/releases (deploy/pull-release.sh fills this)"

if [ ! -f "$ENV_DIR/web.env" ]; then
  sudo tee "$ENV_DIR/web.env" >/dev/null <<'ENVEOF'
# OpenReply web app environment. Fill in every REPLACE_ME.
# ENCRYPTION_KEY must be byte-identical to the worker's, or every send fails to
# decrypt its Instagram token.
DATABASE_URL=REPLACE_ME
REDIS_URL=REPLACE_ME
ENCRYPTION_KEY=REPLACE_ME
NEXTAUTH_URL=https://dm.nomadminh.com
NEXTAUTH_SECRET=REPLACE_ME
CRON_SECRET=REPLACE_ME
RESEND_API_KEY=REPLACE_ME
EMAIL_FROM=REPLACE_ME
INSTAGRAM_APP_ID=REPLACE_ME
INSTAGRAM_APP_SECRET=REPLACE_ME
FACEBOOK_APP_SECRET=REPLACE_ME
WEBHOOK_VERIFY_TOKEN=REPLACE_ME
META_GRAPH_API_VERSION=v25.0

# Retention windows (lib/ops/retention.ts). Defaults shown; DmLog has a 4-day
# floor because it is also the reconciler's idempotency ledger.
# RETENTION_WEBHOOK_EVENT_DAYS=7
# RETENTION_LINK_CLICK_DAYS=30
# RETENTION_OPERATIONAL_EVENT_DAYS=30
# RETENTION_DM_LOG_DAYS=90
ENVEOF
  sudo chown root:root "$ENV_DIR/web.env"
  sudo chmod 600 "$ENV_DIR/web.env"
  note "created $ENV_DIR/web.env"
else
  note "$ENV_DIR/web.env already exists, leaving it alone"
fi

# ------------------------------------------------------------ units, cron -----
log "Installing systemd units, Caddy config and cron jobs"
sudo cp "$APP_DIR/deploy/openreply-web.service" /etc/systemd/system/
sudo cp "$APP_DIR/deploy/openreply-worker.service" /etc/systemd/system/
sudo cp "$APP_DIR/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo install -m 0644 -o root -g root \
  "$APP_DIR/deploy/openreply.crontab" /etc/cron.d/openreply
sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy
chmod +x "$APP_DIR"/deploy/*.sh
sudo systemctl daemon-reload
# Enabled but NOT started, all three of them:
#   - the web app has no release yet;
#   - starting the worker here would be a cutover, which is a separate step;
#   - Caddy would immediately try to get a certificate for a domain whose DNS
#     still points somewhere else. Let's Encrypt would send the HTTP-01
#     challenge to the old host, every attempt would fail, and the failed
#     validations count against a rate limit we need at cutover. Start Caddy
#     AFTER the DNS change so its first attempt is the one that succeeds.
sudo systemctl enable -q openreply-web
sudo systemctl enable -q caddy
# The Debian package starts Caddy on install, before this script has written its
# Caddyfile. Stop it explicitly: leaving it running would have it pick up this
# config on any later reload and start failing ACME challenges against a domain
# that still resolves elsewhere.
sudo systemctl stop caddy 2>/dev/null || true

# The cron jobs are installed disabled: cron.d ignores filenames containing a
# dot. Before cutover they would run against the newly restored local database
# while production still runs elsewhere — refresh-tokens in particular would
# rotate the Instagram token into a database nothing is serving from yet.
if [ -f /etc/cron.d/openreply ]; then
  sudo mv /etc/cron.d/openreply /etc/cron.d/openreply.disabled
fi

# -------------------------------------------------------------- firewall ------
log "Opening 80/443 in the host firewall"
sudo apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
for port in 80 443; do
  if sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    note "$port already allowed"
  else
    # Oracle's images end the INPUT chain with a REJECT, so this has to go in
    # front of it rather than being appended.
    sudo iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
    note "$port allowed"
  fi
done
sudo netfilter-persistent save >/dev/null

cat <<EOF

────────────────────────────────────────────────────────────────────────
Provisioning done. Nothing has been cut over — the worker is untouched and
still pointed at its current database.

Remaining, in order:

  1. Open ingress for TCP 80 and 443 in the OCI console security list for
     this instance's subnet. The host firewall is done; OCI is not, and it
     cannot be done from here.

  2. Fill in $ENV_DIR/web.env (every REPLACE_ME). Take ENCRYPTION_KEY,
     NEXTAUTH_SECRET, CRON_SECRET and the Meta/Resend values from Vercel so
     they match exactly.

  3. Apply the schema and load the data. There is no .env on this box, so the
     connection string has to be exported for both commands:
       sudo cat $ENV_DIR/db-credentials.txt        # copy the DATABASE_URL
       export DATABASE_URL='postgresql://...'
       cd $APP_DIR && npm run db:migrate
       deploy/restore-neon-export.sh ~/neon_db

  4. Deploy the web app:
       deploy/pull-release.sh

  5. Verify before touching DNS:
       curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:3000/terms

  6. Cut over, in this order:
       a. paste the values from $ENV_DIR/db-credentials.txt into both env files
       b. point the DNS A record for $DOMAIN at this box and let the TTL lapse
       c. sudo systemctl start caddy          # first ACME attempt now succeeds
       d. sudo systemctl restart openreply-web openreply-worker
       e. sudo mv /etc/cron.d/openreply.disabled /etc/cron.d/openreply
────────────────────────────────────────────────────────────────────────
EOF
