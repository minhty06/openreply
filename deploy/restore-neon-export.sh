#!/usr/bin/env bash
#
# Load a Neon per-table export into the self-hosted Postgres.
#
# Neon's UI exports one file per table containing data-only INSERTs — no schema,
# no dependency ordering. Two consequences drive this script:
#
#   1. The schema must already exist. Run `npm run db:migrate` (prisma migrate
#      deploy) first; it also populates _prisma_migrations, which is why the
#      export's own _prisma_migrations.sql is deliberately skipped below —
#      loading it would collide on the primary key.
#
#   2. The files must load in foreign-key order. Loading them alphabetically
#      fails immediately (DmLog before Automation, and so on).
#
# The whole load runs in one transaction, so a failure leaves an empty database
# rather than a half-populated one.
#
# Usage:
#   export DATABASE_URL='postgresql://openreply:...@127.0.0.1:5432/openreply'
#   restore-neon-export.sh ~/neon_db
#
# Connects with DATABASE_URL rather than a bare database name on purpose: as the
# ubuntu user, `psql -d openreply` would fall through to peer authentication and
# fail with "role ubuntu does not exist".

set -euo pipefail

DIR="${1:?usage: restore-neon-export.sh <export-dir>}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set (see /etc/openreply/db-credentials.txt)}"
PSQL=(psql "$DATABASE_URL" --quiet --no-psqlrc -v ON_ERROR_STOP=1)

# Foreign-key order. Tables with no file are skipped, so this can safely list
# tables that happened to be empty at export time (Neon omits those).
ORDER=(
  User
  Account
  Session
  VerificationToken
  Workspace
  WorkspaceMember
  WorkspaceInvitation
  InstagramAccount
  Automation
  TrackedLink
  DmLog
  LinkClick
  FollowerSnapshot
  ProcessedComment
  OperationalEvent
  WebhookEvent
)

# Written by `prisma migrate deploy`, never restored from the export.
SKIP=(_prisma_migrations)

log() { printf '==> %s\n' "$*"; }

[ -d "$DIR" ] || { echo "restore: $DIR is not a directory" >&2; exit 1; }

# Fail loudly on an export containing a table this script does not know how to
# order, rather than silently leaving its rows behind.
unknown=()
for file in "$DIR"/*.sql; do
  [ -e "$file" ] || continue
  table="$(basename "$file" .sql)"
  known=false
  for candidate in "${ORDER[@]}" "${SKIP[@]}"; do
    [ "$table" = "$candidate" ] && known=true && break
  done
  [ "$known" = true ] || unknown+=("$table")
done

if [ ${#unknown[@]} -gt 0 ]; then
  echo "restore: unrecognised table(s) in the export: ${unknown[*]}" >&2
  echo "restore: add them to ORDER in the correct foreign-key position first" >&2
  exit 1
fi

# Refuse to load on top of existing data. A second load would fail on primary
# keys anyway; this just makes the reason obvious.
existing="$("${PSQL[@]}" --tuples-only --no-align \
  -c 'select count(*) from "User"' 2>/dev/null || true)"
if [ -z "$existing" ]; then
  echo "restore: cannot query \"User\" — run 'npm run db:migrate' first" >&2
  exit 1
fi
if [ "$existing" != "0" ] && [ "${FORCE:-}" != "1" ]; then
  echo "restore: the database already has $existing User row(s); refusing to load." >&2
  echo "restore: set FORCE=1 only if you intend to load into a non-empty database." >&2
  exit 1
fi

present=()
for table in "${ORDER[@]}"; do
  [ -f "$DIR/$table.sql" ] && present+=("$table")
done

log "Loading ${#present[@]} table(s) in foreign-key order"
printf '    %s\n' "${present[@]}"

# One transaction for the whole stream: BEGIN/COMMIT come from --single-transaction.
for table in "${present[@]}"; do cat "$DIR/$table.sql"; done \
  | "${PSQL[@]}" --single-transaction

log "Row counts"
for table in "${present[@]}"; do
  count="$("${PSQL[@]}" --tuples-only --no-align \
    -c "select count(*) from \"$table\"")"
  printf '    %-22s %s\n' "$table" "$count"
done

log "Done. Compare the counts above against the source before cutting over."
