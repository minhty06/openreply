#!/usr/bin/env bash
#
# Invoke one of the app's cron endpoints on localhost.
#
# These jobs used to be Vercel crons (see vercel.json). They are HTTP endpoints
# rather than scripts, so moving them off Vercel means calling them locally on a
# schedule — see deploy/openreply.crontab.
#
# The shared secret is read from the env file rather than baked into the crontab,
# because /etc/cron.d entries are world-readable and the env file is 0600 root.
#
# Usage: run-cron-job.sh <endpoint>       e.g. run-cron-job.sh refresh-tokens

set -euo pipefail

ENDPOINT="${1:?usage: run-cron-job.sh <endpoint>}"
ENV_FILE="${ENV_FILE:-/etc/openreply/web.env}"
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"

if [ ! -r "$ENV_FILE" ]; then
  echo "run-cron-job: cannot read $ENV_FILE (run as root)" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Mirrors the app's own fallback in app/api/cron/*/route.ts.
SECRET="${CRON_SECRET:-${NEXTAUTH_SECRET:-}}"
if [ -z "$SECRET" ]; then
  echo "run-cron-job: neither CRON_SECRET nor NEXTAUTH_SECRET is set in $ENV_FILE" >&2
  exit 1
fi

# --fail so a non-2xx becomes a non-zero exit, which cron surfaces instead of
# silently swallowing. Token refresh in particular must not fail quietly: if it
# stops working the Instagram token eventually expires and every send fails.
exec curl --fail --silent --show-error --max-time 300 \
  -H "Authorization: Bearer ${SECRET}" \
  "${BASE_URL}/api/cron/${ENDPOINT}"
