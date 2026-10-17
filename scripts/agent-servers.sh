#!/usr/bin/env bash
# Start or stop one agent's API, office app and storefront on its own ports.
#
#   scripts/agent-servers.sh alice start     (after scripts/agent-env.sh alice)
#   scripts/agent-servers.sh alice stop
#   scripts/agent-servers.sh alice status
#
# Each app runs in its own process group, and the group ids go in
# .agent-servers/<name>/pids in this checkout. `stop` kills exactly those
# groups, then anything still holding this agent's own three ports — never a
# pattern like `pkill -f next-server`, which would take down every other
# agent's servers with it. Logs: .agent-servers/<name>/{api,web,store}.log.
#
# One stack per checkout. `next dev` keeps its build in the app's `.next` and
# Nest builds into `dist`, both inside the checkout, so two stacks from one
# worktree would rebuild each other's files (Next refuses the second outright).
# Each agent works in its own worktree; that is what makes `.next` its own.
# Never run `next build` in a checkout whose `next dev` is up for the same
# reason.
set -euo pipefail
# shellcheck source=lib/agent-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/agent-common.sh"

NAME=${1:-}; CMD=${2:-}
[ -n "$NAME" ] && [ -n "$CMD" ] || { sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 1; }
valid_name "$NAME"
SLOT=$(slot_of "$NAME") || die "No environment named '$NAME'. Create it first: eval \"\$(scripts/agent-env.sh $NAME)\""
API_PORT=$(api_port "$SLOT"); STORE_PORT=$(store_port "$SLOT"); WEB_PORT=$(web_port "$SLOT")
STATE="$ROOT/.agent-servers/$NAME"
PIDS="$STATE/pids"
API_URL="http://localhost:$API_PORT/api/v1"

group_alive() { kill -0 -- "-$1" 2>/dev/null; }

running() {
  [ -f "$PIDS" ] || return 1
  local _ pgid
  while read -r _ pgid; do group_alive "$pgid" && return 0; done < "$PIDS"
  return 1
}

# Starts "$@" in apps/$dir as its own process group and records the group id.
launch() {
  local label=$1 dir=$2; shift 2
  set -m
  (cd "$ROOT/apps/$dir" && exec nohup "$@") >"$STATE/$label.log" 2>&1 < /dev/null &
  local pid=$!
  set +m
  echo "$label $pid" >> "$PIDS"
}

wait_for() {
  local label=$1 url=$2 i
  for i in $(seq 1 180); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)" != "000" ]; then
      say "$label answers on $url (${i}s)"
      return 0
    fi
    sleep 1
  done
  warn "$label did not answer on $url within 180s — see $STATE/$label.log"
  return 1
}

start() {
  if running; then say "$NAME is already running (api $API_PORT, web $WEB_PORT, store $STORE_PORT)"; return; fi
  for other in "$ROOT"/.agent-servers/*/pids; do
    [ -e "$other" ] || continue
    local o; o=$(basename "$(dirname "$other")")
    [ "$o" = "$NAME" ] && continue
    while read -r _ pgid; do
      group_alive "$pgid" && die "This checkout is already running '$o'. One stack per checkout: .next and dist are shared within it."
    done < "$other"
  done
  for p in $API_PORT $STORE_PORT $WEB_PORT; do
    port_busy "$p" && die "Port $p is in use (pid $(lsof -ti:"$p" -sTCP:LISTEN | tr '\n' ' ')). Not starting over somebody else's server."
  done
  for app in api web storefront; do
    [ -d "$ROOT/apps/$app/node_modules" ] || die "apps/$app has no node_modules. Run: (cd apps/$app && npm ci)"
  done
  need_docker

  # The API reads its secrets (JWT, VAPID) from apps/api/.env, which git does
  # not carry into a new worktree. Take the main checkout's; everything this
  # agent must differ in is passed below and wins over the file.
  if [ ! -f "$ROOT/apps/api/.env" ]; then
    local main; main="$(dirname "$REGISTRY")/.."
    [ -f "$main/apps/api/.env" ] || die "apps/api/.env is missing here and in the main checkout."
    cp "$main/apps/api/.env" "$ROOT/apps/api/.env"
    say "Copied apps/api/.env from the main checkout"
  fi

  mkdir -p "$STATE"; : > "$PIDS"
  local db; db=$(db_url "$NAME")
  launch api api env -u PORT DATABASE_URL="$db" PORT="$API_PORT" \
    WEB_ORIGIN="http://localhost:$WEB_PORT" STORE_ORIGIN="http://localhost:$STORE_PORT" \
    CRON_SECRET=local-cron-secret npm run start:dev
  launch web web env -u PORT NEXT_PUBLIC_API_URL="$API_URL" npx next dev -p "$WEB_PORT"
  launch store storefront env -u PORT NEXT_PUBLIC_API_URL="$API_URL" npx next dev -p "$STORE_PORT"

  local ok=0
  wait_for api "http://localhost:$API_PORT/api/docs" || ok=1
  wait_for web "http://localhost:$WEB_PORT/en/login" || ok=1
  wait_for store "http://localhost:$STORE_PORT/" || ok=1
  [ $ok -eq 0 ] || { stop; die "$NAME did not come up; stopped what it started."; }
  say "$NAME up — api $API_PORT, web $WEB_PORT, store $STORE_PORT (pids in ${PIDS#"$ROOT"/})"
}

stop() {
  if [ -f "$PIDS" ]; then
    local label pgid i
    while read -r label pgid; do
      group_alive "$pgid" || continue
      kill -TERM -- "-$pgid" 2>/dev/null || true
      for i in $(seq 1 20); do group_alive "$pgid" || break; sleep 0.5; done
      group_alive "$pgid" && kill -KILL -- "-$pgid" 2>/dev/null || true
      say "stopped $label (group $pgid)"
    done < "$PIDS"
    rm -f "$PIDS"
  fi
  # A child that left its group (next-server does on some versions) still holds
  # the port. These three ports are this agent's alone.
  local p
  for p in $API_PORT $STORE_PORT $WEB_PORT; do
    if port_busy "$p"; then
      lsof -ti:"$p" -sTCP:LISTEN | xargs kill 2>/dev/null || true
      say "freed port $p"
    fi
  done
}

status() {
  local p
  for p in $API_PORT $STORE_PORT $WEB_PORT; do
    if port_busy "$p"; then echo "$p listening (pid $(lsof -ti:"$p" -sTCP:LISTEN | tr '\n' ' '))"; else echo "$p free"; fi
  done
}

case "$CMD" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) die "Unknown command '$CMD': start | stop | status" ;;
esac
