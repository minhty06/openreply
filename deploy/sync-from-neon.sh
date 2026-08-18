#!/usr/bin/env bash
#
# Replace the local database's contents with a fresh copy from the old hosted
# database, immediately before cutting DNS over.
#
# Why this exists: the first data load happens hours or days before cutover, and
# the old database keeps taking writes the whole time. Most of that drift is
# WebhookEvent rows nobody misses — but DmLog matters. DmLog is what tells the
# polling reconciler a comment has already been handled, so a DmLog row that
# exists only in the old database means the first sweep after cutover treats
# that comment as new and DMs the person a second time.
#
# Data-only, into the schema `prisma migrate deploy` already created. The dump
# runs as the source's own user; the restore runs as the local postgres
# superuser, because both TRUNCATE and --disable-triggers need that.
#
#   SOURCE_URL=postgresql://...neon.tech/...  \
#   DATABASE_URL=postgresql://openreply@127.0.0.1/openreply \
#   sync-from-neon.sh
#
# Run it as close to the DNS change as possible: rows written to the source
# after this point are lost.

set -euo pipefail

SOURCE_URL="${SOURCE_URL:?SOURCE_URL must be set (the old hosted database)}"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set (the local database)}"
DB_NAME="${DB_NAME:-openreply}"

# Prisma's migration bookkeeping is created locally by `prisma migrate deploy`.
# Copying the source's copy over it would duplicate every row.
EXCLUDE=_prisma_migrations

log() { printf '\n==> %s\n' "$*"; }

# pg_dump refuses to read a server newer than itself, and the distro client is
# usually older than a managed provider's server. Pick the newest local one.
PG_DUMP="$(ls -d /usr/lib/postgresql/*/bin/pg_dump 2>/dev/null | sort -V | tail -1)"
PG_DUMP="${PG_DUMP:-pg_dump}"
log "Using $($PG_DUMP --version)"

SRC_VERSION="$(psql "$SOURCE_URL" -tAc 'show server_version' | cut -d. -f1)"
DUMP_VERSION="$($PG_DUMP --version | grep -oE '[0-9]+' | head -1)"
if [ "$DUMP_VERSION" -lt "$SRC_VERSION" ]; then
  echo "sync: pg_dump $DUMP_VERSION cannot read a PostgreSQL $SRC_VERSION server." >&2
  echo "sync: install postgresql-client-$SRC_VERSION from the PGDG repo first." >&2
  exit 1
fi

TABLES="$(psql "$DATABASE_URL" -tAc "
  select string_agg(format('%I', tablename), ',')
  from pg_tables
  where schemaname = 'public' and tablename <> '$EXCLUDE'")"

if [ -z "$TABLES" ]; then
  echo "sync: no tables found — run 'npm run db:migrate' first." >&2
  exit 1
fi

log "Source row counts (before)"
psql "$SOURCE_URL" -tA -F' ' -c "
  select relname, n_live_tup from pg_stat_user_tables order by relname" | sed 's/^/    /'

log "Truncating local tables"
# One statement so foreign keys never see a partially empty database.
sudo runuser -u postgres -- psql -q -d "$DB_NAME" -v ON_ERROR_STOP=1 \
  -c "truncate table $TABLES restart identity cascade"

log "Copying data"
# --disable-triggers so foreign keys do not constrain the load order, which
# data-only dumps do not guarantee.
# transaction_timeout is a PostgreSQL 17+ setting that pg_dump 18 always emits in
# its header. Restoring into an older server aborts on it with "unrecognized
# configuration parameter" — after the truncate has already run, which empties
# the database. Strip that one parameter rather than all SET lines, which also
# carry client_encoding and search_path.
"$PG_DUMP" --data-only --no-owner --no-privileges --disable-triggers \
  --exclude-table="$EXCLUDE" "$SOURCE_URL" \
  | grep -v '^SET transaction_timeout' \
  | sudo runuser -u postgres -- psql -q -d "$DB_NAME" -v ON_ERROR_STOP=1

log "Comparing row counts"
mismatch=0
for table in $(psql "$DATABASE_URL" -tAc "
  select tablename from pg_tables
  where schemaname='public' and tablename <> '$EXCLUDE' order by tablename"); do
  src="$(psql "$SOURCE_URL" -tAc "select count(*) from \"$table\"")"
  dst="$(psql "$DATABASE_URL" -tAc "select count(*) from \"$table\"")"
  if [ "$src" = "$dst" ]; then
    printf '    %-22s %-8s ok\n' "$table" "$dst"
  else
    printf '    %-22s local=%-8s source=%-8s MISMATCH\n' "$table" "$dst" "$src"
    mismatch=1
  fi
done

if [ "$mismatch" -ne 0 ]; then
  echo "
sync: row counts differ. A small difference in WebhookEvent or LinkClick just
means the source took writes while this ran. A difference in DmLog, Automation,
TrackedLink or InstagramAccount means something went wrong — do not cut over." >&2
  exit 1
fi

log "In sync. Safe to cut DNS over."
