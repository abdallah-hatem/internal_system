#!/usr/bin/env bash
# The production half of a release, one step at a time, in the order they
# must happen — the schema before the code that reads it:
#
#   scripts/ship-prod.sh status            migrations production has not had
#   scripts/ship-prod.sh migrate           apply them
#   scripts/ship-prod.sh env               set PUBLIC_BASE_URL on the API if absent
#   git push origin master                 (the deploy — not this script's job)
#   scripts/ship-prod.sh stranded [--fix]  drafts left on cycles that moved on
#   scripts/ship-prod.sh smoke             read-only checks against the live API
#
# Production settings come from `vercel env pull` into a temp file removed on
# exit. Nothing secret is printed, and nothing is written into the repo.
# Migrations use the unpooled URL: Neon's pooler drops the advisory lock
# `migrate deploy` takes.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
API_DIR="$ROOT/apps/api"
API_URL=https://internal-system-api.vercel.app
WEB_URL=https://internal-system-web-three.vercel.app

step=${1:-}
[[ -z "$step" ]] && { sed -n 2,15p "$0"; exit 1; }

env_file=$(mktemp)
trap 'rm -f "$env_file"' EXIT

prod_env() {
  vercel env pull "$env_file" --environment=production --yes --cwd "$API_DIR" >/dev/null 2>&1
  local url
  url=$(grep -E '^DATABASE_URL_UNPOOLED=' "$env_file" | cut -d= -f2- | tr -d '"')
  [[ "$url" == postgresql://* ]] || { echo "  No production database URL came back."; exit 1; }
  export DATABASE_URL="$url"
}

case "$step" in
  status | migrate)
    prod_env
    cd "$API_DIR"
    verb=$([[ "$step" == status ]] && echo status || echo deploy)
    npx prisma migrate "$verb" 2>&1 | grep -vE '^$|prisma.config|Prisma schema loaded' |
      sed -E 's#(://[^:]+:)[^@]+@#\1***@#'
    ;;

  env)
    if vercel env ls production --cwd "$API_DIR" 2>/dev/null | grep -q '^ *PUBLIC_BASE_URL '; then
      echo "  PUBLIC_BASE_URL is already set in production."
    else
      printf '%s' "$API_URL" | vercel env add PUBLIC_BASE_URL production --cwd "$API_DIR" >/dev/null
      echo "  PUBLIC_BASE_URL set to $API_URL (takes effect on the next deploy)."
    fi
    ;;

  stranded)
    # The same rule as scripts/confirm-stranded-orders.sh, through the API's
    # Prisma client, because psql is not installed here.
    prod_env
    cd "$API_DIR"
    FIX=$([[ "${2:-}" == --fix ]] && echo 1 || echo 0) node -e '
      const { PrismaClient } = require("@prisma/client");
      const db = new PrismaClient();
      const PAST = `(${["IN_TRANSIT","ARRIVED_UAE","IN_TRANSIT_TO_EGYPT","ARRIVED_EGYPT",
        "VERIFICATION","SELLING","SETTLEMENT","CLOSED"].map((s) => `'"'"'${s}'"'"'`).join(",")})`;
      const find = () => db.$queryRawUnsafe(`SELECT c.code, c.status::text, po.reference
        FROM purchase_orders po JOIN import_cycles c ON c.id = po.cycle_id
        WHERE po.status = '"'"'DRAFT'"'"' AND c.status::text IN ${PAST} ORDER BY c.code`);
      (async () => {
        const rows = await find();
        if (!rows.length) return console.log("  No stranded drafts.");
        console.log(`  ${rows.length} purchase order(s) still DRAFT on a cycle that has moved on:`);
        for (const r of rows) console.log(`    ${r.code}  ${r.status}  ${r.reference}`);
        if (process.env.FIX !== "1") return console.log("  Nothing changed. Re-run with --fix.");
        await db.$executeRawUnsafe(`UPDATE purchase_orders po SET status = '"'"'CONFIRMED'"'"'
          FROM import_cycles c WHERE c.id = po.cycle_id AND po.status = '"'"'DRAFT'"'"'
          AND c.status::text IN ${PAST}`);
        const left = await find();
        console.log(left.length ? `  Still ${left.length} left.` : `  Confirmed ${rows.length}. None left.`);
        if (left.length) process.exitCode = 1;
      })().finally(() => db.$disconnect());
    '
    ;;

  smoke)
    fail=0
    check() { # name, expected, actual
      if [[ "$3" == "$2" ]]; then echo "  ok    $1"; else echo "  FAIL  $1 — expected $2, got $3"; fail=1; fi
    }
    meta=$(curl -s "$API_URL/.well-known/oauth-authorization-server")
    check "OAuth metadata names the public address" "$API_URL" \
      "$(node -e 'try{console.log(JSON.parse(process.argv[1]).issuer)}catch{console.log("none")}' "$meta")"
    check "office routes still refuse a stranger" 401 \
      "$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/v1/payments")"
    check "login reaches the database" 401 "$(curl -s -o /dev/null -w '%{http_code}' \
      -H 'content-type: application/json' -d '{"email":"nobody@example.com","password":"wrong-password"}' \
      "$API_URL/api/v1/auth/login")"
    headers=$(curl -s -D - -o /dev/null -X POST -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$API_URL/mcp")
    check "/mcp without a token is 401" 401 "$(awk 'NR==1{print $2}' <<<"$headers")"
    check "/mcp points Claude at the sign-in metadata" yes \
      "$(grep -qi '^www-authenticate:.*resource_metadata=' <<<"$headers" && echo yes || echo no)"
    check "office app answers" 307 "$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/")"
    exit $fail
    ;;

  *) sed -n 2,15p "$0"; exit 1 ;;
esac
