#!/usr/bin/env bash
# Give one agent its own database and port block, so several can run e2e at once.
#
#   eval "$(scripts/agent-env.sh alice)"     create (or reuse) and export
#   scripts/agent-env.sh alice --drop        remove alice's database and slot
#   scripts/agent-env.sh --list              who has which slot
#
# Before this, every agent queued for the one `motorcycle_parts` database and
# the fixed ports 3000–3003 (CLAUDE.md §6), which turned a night of parallel
# work into hours of waiting. Now each agent gets:
#
#   - database `motorcycle_parts_<name>`, copied from `motorcycle_parts_template`
#     (migrated and seeded at the reference level). The template is rebuilt
#     whenever the migrations, the schema or the seed change, and the copy is
#     a file-level clone, so a new agent costs about a second;
#   - a slot N and the ports API 31N1, storefront 31N2, office 31N3;
#   - the exports below on stdout. Everything else goes to stderr, so `eval`
#     sees only the exports.
#
# The e2e harness reads all of it from the environment (apps/web/tests/
# support/env.ts) and snapshots, reseeds and restores only this database.
# scripts/agent-servers.sh starts the three apps on these ports.
set -euo pipefail
# shellcheck source=lib/agent-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/agent-common.sh"

usage() { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 1; }

if [ "${1:-}" = "--list" ]; then
  for f in "$REGISTRY"/*.slot; do
    [ -e "$f" ] || { echo "(no agent environments)" >&2; exit 0; }
    n=$(basename "$f" .slot); s=$(cat "$f")
    printf '%-20s slot %-3s api %s  store %s  web %s  db %s\n' "$n" "$s" \
      "$(api_port "$s")" "$(store_port "$s")" "$(web_port "$s")" "$(db_name "$n")"
  done
  exit 0
fi

NAME=${1:-}; [ -n "$NAME" ] || usage
valid_name "$NAME"
DB=$(db_name "$NAME")
need_docker

# ── --drop ───────────────────────────────────────────────────────────────
if [ "${2:-}" = "--drop" ]; then
  slot=$(slot_of "$NAME" || true)
  if [ -n "$slot" ] && port_busy "$(api_port "$slot")"; then
    warn "Something is still listening on $(api_port "$slot") — stop it first: scripts/agent-servers.sh $NAME stop"
  fi
  say "Dropping $DB"
  psql_admin -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);"
  rm -f "$(slot_file "$NAME")"
  # A snapshot left by an unfinished run would otherwise be "restored" into the
  # next database of this name, which never held it.
  rm -f "/tmp/motoparts-pretest-snapshot-$DB.sql" "/tmp/motoparts-e2e-$DB.lock"
  say "Done — slot ${slot:-none} is free"
  exit 0
fi
[ -z "${2:-}" ] || usage

[ -x "$ROOT/apps/api/node_modules/.bin/prisma" ] ||
  die "apps/api has no node_modules in this checkout. Run: (cd apps/api && npm ci)"

# ── 1. The template ──────────────────────────────────────────────────────
# Its fingerprint is everything that decides what a fresh database holds: each
# migration, the schema and the seed. Stored on the database itself, so it
# cannot drift from what the template really contains.
fingerprint() {
  (cd "$ROOT/apps/api/prisma" &&
    find migrations -type f -name '*.sql' | LC_ALL=C sort | xargs cat &&
    cat schema.prisma seed.ts) | shasum -a 256 | cut -c1-16
}

# Quiet unless it fails: Prisma's banners on stderr would bury the one line
# that matters, and an `eval` reader never sees stderr anyway.
prisma_on() {
  local url=$1 out; shift
  out=$(cd "$ROOT/apps/api" && DATABASE_URL="$url" npx prisma "$@" 2>&1) || { echo "$out" >&2; die "prisma $* failed"; }
}

refresh_template() {
  local want have url
  want=$(fingerprint)
  have=$(psql_admin -c "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname='$TEMPLATE_DB'")
  [ "$have" = "$want" ] && return 0

  say "Building $TEMPLATE_DB (migrations or seed changed: ${have:-none} → $want)"
  url="postgresql://postgres:postgres@localhost:5432/$TEMPLATE_DB?schema=public"
  psql_admin -c "DROP DATABASE IF EXISTS $TEMPLATE_DB WITH (FORCE);"
  psql_admin -c "CREATE DATABASE $TEMPLATE_DB OWNER postgres;"
  prisma_on "$url" migrate deploy
  (cd "$ROOT/apps/api" && DATABASE_URL="$url" SEED_REFERENCE=1 npx prisma db seed >/dev/null 2>&1) ||
    die "Seeding $TEMPLATE_DB failed — run it by hand to see why: (cd apps/api && DATABASE_URL='$url' SEED_REFERENCE=1 npx prisma db seed)"
  psql_admin -c "COMMENT ON DATABASE $TEMPLATE_DB IS '$want';"
}
with_lock template refresh_template

# ── 2. The agent's database ──────────────────────────────────────────────
if db_exists "$DB"; then
  # Reused: bring it up to this checkout's migrations, which may be newer than
  # the ones it was copied with.
  say "$DB exists — applying any new migrations"
  prisma_on "$(db_url "$NAME")" migrate deploy
else
  say "Creating $DB from $TEMPLATE_DB"
  # CREATE … TEMPLATE needs nobody connected to the template; the template lock
  # keeps a rebuild from starting underneath it.
  with_lock template psql_admin -c "CREATE DATABASE $DB TEMPLATE $TEMPLATE_DB OWNER postgres;"
fi

# ── 3. The slot ──────────────────────────────────────────────────────────
take_slot() {
  local s
  if s=$(slot_of "$NAME"); then echo "$s"; return; fi
  for s in $(seq 1 $MAX_SLOT); do
    if ! grep -qx "$s" "$REGISTRY"/*.slot 2>/dev/null; then
      echo "$s" > "$(slot_file "$NAME")"
      echo "$s"
      return
    fi
  done
  die "All $MAX_SLOT slots are taken: scripts/agent-env.sh --list"
}
SLOT=$(with_lock slots take_slot)
API_PORT=$(api_port "$SLOT"); STORE_PORT=$(store_port "$SLOT"); WEB_PORT=$(web_port "$SLOT")

for p in $API_PORT $STORE_PORT $WEB_PORT; do
  if port_busy "$p" && [ ! -f "$ROOT/.agent-servers/$NAME/pids" ]; then
    warn "Port $p is already in use by something other than this agent's servers"
  fi
done

say "$NAME: slot $SLOT, database $DB, api $API_PORT, store $STORE_PORT, web $WEB_PORT"

# ── 4. The exports ───────────────────────────────────────────────────────
# PORT is the API's (Nest reads it). agent-servers.sh passes each app its own
# port explicitly, so a `next dev` started there never picks this one up.
cat <<EOF
export AGENT_NAME=$NAME
export AGENT_SLOT=$SLOT
export DATABASE_URL='$(db_url "$NAME")'
export API_PORT=$API_PORT
export STORE_PORT=$STORE_PORT
export WEB_PORT=$WEB_PORT
export PORT=$API_PORT
export API_BASE=http://localhost:$API_PORT/api/v1
export NEXT_PUBLIC_API_URL=http://localhost:$API_PORT/api/v1
export WEB_URL=http://localhost:$WEB_PORT
export STORE_URL=http://localhost:$STORE_PORT
export WEB_ORIGIN=http://localhost:$WEB_PORT
export STORE_ORIGIN=http://localhost:$STORE_PORT
export CRON_SECRET=local-cron-secret
EOF
