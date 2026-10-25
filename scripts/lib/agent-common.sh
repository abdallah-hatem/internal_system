# Shared by scripts/agent-env.sh and scripts/agent-servers.sh. Sourced, not run.
#
# One agent = one name = one database `motorcycle_parts_<name>` + one slot.
# The slot is a small number recorded per name, and every port follows from it:
#
#   API        31N1     (slot 1 → 3111, slot 2 → 3121, … slot 12 → 3221)
#   storefront 31N2
#   office     31N3
#
# i.e. base = 3100 + 10·slot. Nothing below 3110 is used, so the developer's
# own 3000–3003 and every slot stay apart.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONTAINER=${CONTAINER:-motorcycle_parts_db}
DB_PREFIX=motorcycle_parts
TEMPLATE_DB=${DB_PREFIX}_template
MAX_SLOT=89

# The registry has to be seen by every worktree of this repo, so it lives in
# the git directory they share rather than in any one checkout.
_common="$(git -C "$ROOT" rev-parse --git-common-dir)"
case "$_common" in /*|[A-Za-z]:/*) ;; *) _common="$ROOT/$_common" ;; esac
REGISTRY="$(cd "$_common" && pwd)/agent-env"
mkdir -p "$REGISTRY"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$1" >&2; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$1" >&2; }
die()  { printf '\033[1;31mx  \033[0m %s\n' "$1" >&2; exit 1; }

valid_name() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9_]{0,29}$ ]] || die "Name '$1': use 1–30 of a-z, 0-9, _ (starting with a letter or digit)."
  [ "$1" != "template" ] || die "'template' is the name of the database every agent is copied from."
}

db_name()   { echo "${DB_PREFIX}_$1"; }
db_url()    { echo "postgresql://postgres:postgres@localhost:5432/$(db_name "$1")?schema=public"; }
slot_file() { echo "$REGISTRY/$1.slot"; }
slot_of()   { [ -f "$(slot_file "$1")" ] && cat "$(slot_file "$1")"; }
api_port()   { echo $((3100 + 10 * $1 + 1)); }
store_port() { echo $((3100 + 10 * $1 + 2)); }
web_port()   { echo $((3100 + 10 * $1 + 3)); }

# A lock made with mkdir, which is atomic. Two agents starting at once must not
# both rebuild the template, or both take slot 1.
with_lock() {
  local lock="$REGISTRY/$1.lock" i=0
  shift
  until mkdir "$lock" 2>/dev/null; do
    i=$((i + 1))
    # A lock older than ten minutes belongs to a run that died holding it.
    if [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$lock" 2>/dev/null || true; fi
    [ $i -gt 600 ] && die "Timed out waiting for $lock"
    sleep 1
  done
  # shellcheck disable=SC2064
  trap "rmdir '$lock' 2>/dev/null || true" EXIT
  "$@"
  local rc=$?
  rmdir "$lock" 2>/dev/null || true
  trap - EXIT
  return $rc
}

psql_admin() { docker exec -i -e PGOPTIONS='-c client_min_messages=warning' "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

db_exists() {
  [ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname='$1'")" = "1" ]
}

need_docker() {
  docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1 ||
    die "The database container '$CONTAINER' is not running. Start it: open -a Docker && docker compose up -d postgres"
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }
