#!/usr/bin/env bash
# Start the whole local stack cleanly.
#
# The thing this exists to prevent: a leftover API process from an earlier
# session keeps port 3001, the new one fails to bind, and requests are quietly
# served by yesterday's build. That looks exactly like "my change didn't work".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT=3001
WEB_PORT=3000
# The customer-facing storefront. Its own port because it is its own app, on
# its own origin — which is also why a token stored by one is invisible to the
# other, and that is the correct behaviour rather than an inconvenience.
STORE_PORT=3002

say() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$1"; }

# ── 1. Docker ────────────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  say "Docker is not running — starting Docker Desktop"
  open -a Docker
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  docker info >/dev/null 2>&1 || { warn "Docker did not start"; exit 1; }
fi

# ── 2. Database ──────────────────────────────────────────────────────────
say "Starting PostgreSQL"
(cd "$ROOT" && docker compose up -d >/dev/null)
for _ in $(seq 1 30); do
  if docker exec motorcycle_parts_db pg_isready -U postgres -d motorcycle_parts >/dev/null 2>&1; then
    say "Database ready on :5432"
    break
  fi
  sleep 2
done

# ── 3. Close windows from a previous run ─────────────────────────────────
# This must come before freeing the ports: the windows are identified by the
# project processes running in them, and killing those first would leave the
# windows behind as anonymous idle shells that pile up run after run.
say "Closing windows left by a previous run"
"$ROOT/scripts/close-dev-windows.sh" >/dev/null 2>&1 || true
sleep 1

# ── 4. Free the ports ────────────────────────────────────────────────────
for port in $API_PORT $WEB_PORT $STORE_PORT; do
  pids=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    warn "Port $port held by PID(s) $pids — stopping them"
    echo "$pids" | xargs kill -9 2>/dev/null || true
    sleep 1
  fi
done

# ── 5. Servers, each in its own visible Terminal window ──────────────────
# Windows opened by this script are titled so a later run can close its own
# leftovers instead of stacking up a new pair every time.
TAG="motoparts-dev"

say "Opening API, office and store in Terminal windows"
osascript >/dev/null <<APPLESCRIPT
tell application "Terminal"
  set apiTab to do script "cd '$ROOT/apps/api' && npm run start:dev"
  set custom title of apiTab to "$TAG — api"
  set webTab to do script "cd '$ROOT/apps/web' && npm run dev"
  set custom title of webTab to "$TAG — web"
  set storeTab to do script "cd '$ROOT/apps/storefront' && PORT=$STORE_PORT npm run dev"
  set custom title of storeTab to "$TAG — store"
  activate
end tell
APPLESCRIPT

# ── 6. Wait until both answer ────────────────────────────────────────────
wait_for() {
  local url=$1 name=$2
  for _ in $(seq 1 40); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      say "$name is up"
      return 0
    fi
    sleep 3
  done
  warn "$name did not come up — check its Terminal window"
  return 1
}

wait_for "http://localhost:$API_PORT/api/docs" "API" || true
wait_for "http://localhost:$WEB_PORT" "Web" || true
wait_for "http://localhost:$STORE_PORT" "Store" || true

cat <<EOF

  Office   http://localhost:$WEB_PORT
  Store    http://localhost:$STORE_PORT
  API      http://localhost:$API_PORT
  Swagger  http://localhost:$API_PORT/api/docs

  Login    partner.a@motoparts.com / password123

EOF
