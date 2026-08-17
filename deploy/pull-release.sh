#!/usr/bin/env bash
#
# Deploy a prebuilt web bundle onto the box.
#
# The 1 GB host cannot run `next build`, so the app is built by
# .github/workflows/release.yml and published as a release asset. This script
# fetches it, swaps it in behind a symlink, and rolls back automatically if the
# new release fails to come up.
#
# Usage:
#   pull-release.sh              # newest build (the rolling web-latest release)
#   pull-release.sh v1.2.3       # a pinned tag, for rollback
#
# Run as the ubuntu user; it uses sudo only to restart the service.

set -euo pipefail

TAG="${1:-web-latest}"
REPO="${REPO:-minhty06/openreply}"
ARTIFACT="openreply-web.tar.gz"
BASE="${BASE:-/home/ubuntu/openreply-web}"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
KEEP=3
# A route that renders without touching Postgres or Redis, so readiness reflects
# "the bundle boots" rather than the health of everything downstream.
READY_PATH="/terms"
READY_TIMEOUT=60

URL="https://github.com/$REPO/releases/download/$TAG/$ARTIFACT"
STAMP="$(date -u +%Y%m%d%H%M%S)"
TARGET="$RELEASES/${TAG}-${STAMP}"

log() { printf '==> %s\n' "$*"; }

mkdir -p "$RELEASES"

log "Downloading $TAG"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl --fail --location --silent --show-error -o "$TMP/$ARTIFACT" "$URL"

# A 404 from a release URL can arrive as an HTML error page; refuse to unpack it.
if ! gzip -t "$TMP/$ARTIFACT" 2>/dev/null; then
  echo "pull-release: $URL did not return a gzip archive (is the tag published?)" >&2
  exit 1
fi

log "Unpacking to $TARGET"
mkdir -p "$TARGET"
tar -xzf "$TMP/$ARTIFACT" -C "$TARGET"

if [ ! -f "$TARGET/server.js" ]; then
  echo "pull-release: archive has no server.js at its root" >&2
  rm -rf "$TARGET"
  exit 1
fi

PREVIOUS=""
if [ -L "$CURRENT" ]; then
  PREVIOUS="$(readlink -f "$CURRENT")"
fi

log "Switching current -> $TARGET"
ln -sfn "$TARGET" "$CURRENT"
sudo systemctl restart openreply-web

log "Waiting for the app to answer on $READY_PATH"
ready=false
for _ in $(seq 1 "$READY_TIMEOUT"); do
  if curl --fail --silent --output /dev/null --max-time 3 \
    "http://127.0.0.1:3000$READY_PATH"; then
    ready=true
    break
  fi
  sleep 1
done

if [ "$ready" != true ]; then
  echo "pull-release: new release did not become ready in ${READY_TIMEOUT}s" >&2
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ]; then
    echo "pull-release: rolling back to $PREVIOUS" >&2
    ln -sfn "$PREVIOUS" "$CURRENT"
    sudo systemctl restart openreply-web
  else
    echo "pull-release: no previous release to roll back to" >&2
  fi
  exit 1
fi

if [ -f "$TARGET/BUILD_INFO" ]; then
  log "Deployed:"
  sed 's/^/    /' "$TARGET/BUILD_INFO"
fi

# Keep a couple of older releases so a rollback is a symlink change, not a
# download. Never prune whatever `current` points at.
log "Pruning old releases (keeping $KEEP)"
CURRENT_TARGET="$(readlink -f "$CURRENT")"
# shellcheck disable=SC2012
ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
  if [ "$(readlink -f "$old")" != "$CURRENT_TARGET" ]; then
    rm -rf "$old"
  fi
done

log "Done"
