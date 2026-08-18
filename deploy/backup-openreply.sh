#!/usr/bin/env bash
#
# Nightly Postgres dumps for the self-hosted OpenReply box.
#
# Two dumps, because two very different things are being protected against:
#
#   full-YYYYMMDD.sql.gz      Everything. Recovers from a bad migration or an
#                             accidental delete. A couple of MB.
#
#   critical-YYYYMMDD.sql.gz  Only the tables that cannot be reconstructed from
#                             any other source. A few kB:
#                               TrackedLink       every /r/<slug> link already
#                                                 delivered in a DM lives in
#                                                 somebody's inbox forever; lose
#                                                 these rows and every one of
#                                                 them silently redirects to the
#                                                 homepage, permanently.
#                               FollowerSnapshot  Instagram retains ~30 days of
#                                                 insights, so older history
#                                                 exists nowhere else.
#                               Automation        the campaigns themselves.
#                               InstagramAccount  the encrypted token.
#
# These stay on the box, which does not protect against losing the instance —
# Oracle can reclaim Always Free instances. Pull them down periodically:
#
#   rsync -avz ubuntu@<box-ip>:/var/backups/openreply/ ~/Backups/openreply/
#
# KEEP is deliberately generous so forgetting for a week costs nothing.
#
# Runs as root from /etc/cron.d/openreply.

set -euo pipefail

DEST="${DEST:-/var/backups/openreply}"
DB="${DB:-openreply}"
KEEP="${KEEP:-14}"
STAMP="$(date -u +%Y%m%d)"

CRITICAL_TABLES=(TrackedLink Automation FollowerSnapshot InstagramAccount)

mkdir -p "$DEST"
# The dumps contain encrypted access tokens and user email addresses.
chown ubuntu:ubuntu "$DEST"
chmod 700 "$DEST"

# runuser keeps the caller's working directory and the postgres user cannot read
# /home/ubuntu, so every pg_dump would print a "could not change directory"
# warning to stderr — noise that hides a real failure in cron mail.
cd /

dump() {
  local out="$1"
  shift
  local tmp="${out}.partial"

  # runuser rather than sudo: this runs from cron with no tty, and peer auth as
  # the postgres system user needs no stored password.
  if ! runuser -u postgres -- pg_dump --no-owner --no-privileges "$@" "$DB" \
    | gzip > "$tmp"; then
    rm -f "$tmp"
    echo "backup: pg_dump failed for $out" >&2
    return 1
  fi

  # A truncated or empty dump is worse than no dump, because it looks like one.
  if ! gzip -t "$tmp" 2>/dev/null || [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    echo "backup: $out failed verification" >&2
    return 1
  fi

  mv "$tmp" "$out"
  # Owned by ubuntu, not root: these are pulled off the box with rsync as that
  # user, and root-owned 0600 files fail with "Permission denied". Still
  # unreadable to anyone else — they hold encrypted tokens and email addresses.
  chown ubuntu:ubuntu "$out"
  chmod 600 "$out"
}

table_args=()
for table in "${CRITICAL_TABLES[@]}"; do
  # Prisma's table names are mixed case, so they need quoting inside -t.
  table_args+=(-t "\"$table\"")
done

dump "$DEST/full-$STAMP.sql.gz"
dump "$DEST/critical-$STAMP.sql.gz" "${table_args[@]}"

# Rotate each series independently so one growing faster cannot evict the other.
for prefix in full critical; do
  # shellcheck disable=SC2012
  ls -1t "$DEST/$prefix-"*.sql.gz 2>/dev/null \
    | tail -n +$((KEEP + 1)) \
    | xargs -r rm -f
done

printf 'backup: wrote %s and %s\n' \
  "$(basename "$DEST/full-$STAMP.sql.gz")" \
  "$(basename "$DEST/critical-$STAMP.sql.gz")"
