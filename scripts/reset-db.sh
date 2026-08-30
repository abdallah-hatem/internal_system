#!/usr/bin/env bash
# Rebuild the database from nothing, at a chosen level of content.
#
#   ./scripts/reset-db.sh              reference data (the usual one)
#   ./scripts/reset-db.sh minimal      sign-in accounts only
#   ./scripts/reset-db.sh demo         the full worked example
#
# Always backs up first. Dropping and recreating rather than truncating,
# because truncation leaves the migration history and any column added by a
# migration you have since edited — a fresh database is the only way to be sure
# the schema matches the migrations.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB=${DB:-motorcycle_parts}
CONTAINER=${CONTAINER:-motorcycle_parts_db}
LEVEL="${1:-reference}"

case "$LEVEL" in
  minimal|reference|demo) ;;
  *) echo "Unknown level '$LEVEL'. Use: minimal | reference | demo"; exit 1 ;;
esac

say() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }

if ! docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  echo "Database container '$CONTAINER' is not running. Start it with: npm run dev"
  exit 1
fi

mkdir -p "$ROOT/.backups"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$ROOT/.backups/before-reset-$STAMP.sql"
say "Backing up to $(basename "$BACKUP")"
docker exec "$CONTAINER" pg_dump -U postgres -d "$DB" --no-owner > "$BACKUP" 2>/dev/null || {
  echo "  (nothing to back up — carrying on)"; rm -f "$BACKUP";
}

# The product photographs and the pictures customers attach to import requests.
#
# These live on disk, not in the database, so a pg_dump on its own restores a
# catalogue of broken images and import requests whose evidence has vanished.
# The FileAsset rows come back and point at files that are no longer there.
UPLOADS="$ROOT/apps/api/uploads"
if [ -d "$UPLOADS" ] && [ -n "$(ls -A "$UPLOADS" 2>/dev/null)" ]; then
  IMAGES="$ROOT/.backups/before-reset-$STAMP-uploads.tar.gz"
  say "Backing up uploads to $(basename "$IMAGES")"
  tar -czf "$IMAGES" -C "$ROOT/apps/api" uploads
else
  say "No uploads to back up"
fi

say "Recreating the database"
# The API holds connections open; Postgres will not drop a database in use.
docker exec "$CONTAINER" psql -U postgres -d postgres -q -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DB' AND pid<>pg_backend_pid();" >/dev/null
docker exec "$CONTAINER" psql -U postgres -d postgres -q -c "DROP DATABASE IF EXISTS $DB;"
docker exec "$CONTAINER" psql -U postgres -d postgres -q -c "CREATE DATABASE $DB OWNER postgres;"

say "Applying migrations"
(cd "$ROOT/apps/api" && npx prisma migrate deploy >/dev/null)

say "Seeding ($LEVEL)"
case "$LEVEL" in
  minimal)   ENV_FLAG="SEED_MINIMAL=1" ;;
  reference) ENV_FLAG="SEED_REFERENCE=1" ;;
  demo)      ENV_FLAG="" ;;
esac
(cd "$ROOT/apps/api" && env $ENV_FLAG npx prisma db seed 2>&1 | grep -E '^(✅|🎉|   )' || true)

say "Checking consistency"
if bash "$ROOT/scripts/check-data.sh" >/dev/null 2>&1; then
  echo "  all clear"
else
  echo "  ⚠️  something is off — run: npm run db:check"
fi

echo
say "Done. The API caches its connection, so restart it if it is running:"
echo "     npm run dev"
