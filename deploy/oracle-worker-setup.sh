#!/usr/bin/env bash
#
# Provision an always-on OpenReply DM worker on a fresh Ubuntu VM
# (written for an Oracle Cloud "Always Free" instance, but any Ubuntu box works).
#
# Run as the default `ubuntu` user:
#   curl -fsSL <raw-url-of-this-file> -o setup.sh && bash setup.sh
# or copy it over and: bash setup.sh
#
# Secrets are NOT in this script. It creates /etc/openreply/worker.env with
# placeholder values and stops; you fill that in, then start the service.

set -euo pipefail

REPO="${REPO:-https://github.com/minhty06/openreply.git}"
APP_DIR="/home/ubuntu/openreply"
ENV_DIR="/etc/openreply"
ENV_FILE="$ENV_DIR/worker.env"
NODE_MAJOR="${NODE_MAJOR:-22}"

echo "==> Installing Node ${NODE_MAJOR} and git"
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates gnupg
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node -v

echo "==> Fetching the app"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth=1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  git clone --depth=1 "$REPO" "$APP_DIR"
fi

echo "==> Installing dependencies"
cd "$APP_DIR"
# The worker runs TypeScript through tsx, so devDependencies are required.
# `npm ci` needs the lockfile, which is committed.
npm ci --no-audit --no-fund

echo "==> Generating the Prisma client"
# Only the client — never `migrate deploy` here. Migrations are applied from the
# web app's build and by hand; a worker that migrates on boot can race a deploy.
npm run db:generate

echo "==> Preparing the secrets file"
sudo mkdir -p "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  sudo tee "$ENV_FILE" >/dev/null <<'ENVEOF'
# OpenReply worker environment. Fill in every REPLACE_ME value.
# These must match the web app exactly — in particular ENCRYPTION_KEY, or every
# send fails to decrypt its Instagram token.
DATABASE_URL=REPLACE_ME
REDIS_URL=REPLACE_ME
ENCRYPTION_KEY=REPLACE_ME
NEXTAUTH_URL=REPLACE_ME
NEXTAUTH_SECRET=REPLACE_ME
META_GRAPH_API_VERSION=v25.0

# Optional polling-reconciler tuning; defaults are fine.
# COMMENT_POLL_INTERVAL_MS=300000
# COMMENT_POLL_MAX_PER_SWEEP=30
# COMMENT_POLL_LOOKBACK_HOURS=72
ENVEOF
  echo "    created $ENV_FILE"
else
  echo "    $ENV_FILE already exists, leaving it alone"
fi
sudo chown root:root "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"

echo "==> Installing the systemd unit"
sudo cp "$APP_DIR/deploy/openreply-worker.service" /etc/systemd/system/openreply-worker.service
sudo systemctl daemon-reload
sudo systemctl enable openreply-worker >/dev/null

echo
echo "Done. Next:"
echo "  1. sudo nano $ENV_FILE     # paste the real values"
echo "  2. sudo systemctl start openreply-worker"
echo "  3. sudo systemctl status openreply-worker --no-pager"
echo "     journalctl -u openreply-worker -f"
