#!/usr/bin/env bash
# Purchase orders left as drafts on cycles that have already moved on.
#
# Orders are confirmed when a cycle leaves PURCHASING. That rule is new, so any
# cycle that passed that point before it existed is holding a draft that will
# never be confirmed — the transition that would do it has already happened and
# does not repeat.
#
# It matters because `addItem` refuses on a non-DRAFT order. While these stay
# drafts, lines can still be added to orders whose stock is already received and
# costed, which is the thing the rule exists to prevent.
#
# Reports by default. Deliberate, because it edits records the business has
# already acted on:
#
#   scripts/confirm-stranded-orders.sh
#   scripts/confirm-stranded-orders.sh --fix
#   DATABASE_URL="<production url>" scripts/confirm-stranded-orders.sh --fix
set -euo pipefail
DB=${DB:-motorcycle_parts}
CONTAINER=${CONTAINER:-motorcycle_parts_db}

FIX=false
[[ "${1:-}" == "--fix" ]] && FIX=true

# Every status that means the goods are moving or have arrived. PLANNING,
# FUNDING and PURCHASING are excluded on purpose — an order still being built
# is *supposed* to be a draft.
PAST="'IN_TRANSIT','ARRIVED_UAE','IN_TRANSIT_TO_EGYPT','ARRIVED_EGYPT','VERIFICATION','SELLING','SETTLEMENT','CLOSED'"

FIND="SELECT c.code, c.status, po.reference
        FROM purchase_orders po
        JOIN import_cycles c ON c.id = po.cycle_id
       WHERE po.status = 'DRAFT' AND c.status IN ($PAST)
       ORDER BY c.code;"

run() { docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tA -F'|' -c "$1" 2>/dev/null; }
if [[ -n "${DATABASE_URL:-}" ]]; then
  run() { psql "$DATABASE_URL" -tA -F'|' -c "$1"; }
  echo "  (using DATABASE_URL, not the local container)"
fi

rows=$(run "$FIND" || true)

if [[ -z "$rows" ]]; then
  echo "  No stranded drafts. Every cycle past purchasing has confirmed orders."
  exit 0
fi

count=$(wc -l <<<"$rows" | tr -d ' ')
echo "  $count purchase order(s) still DRAFT on a cycle that has moved on:"
echo
while IFS='|' read -r code status ref; do
  [[ -z "$code" ]] && continue
  printf "    %-16s %-16s %s\n" "$code" "$status" "$ref"
done <<<"$rows"
echo

if [[ "$FIX" != true ]]; then
  echo "  Nothing changed. Re-run with --fix to confirm them."
  echo "  They are confirmed as-is: no line is added or altered, only the status,"
  echo "  which is what the cycle's own history already implies."
  exit 0
fi

run "UPDATE purchase_orders po
        SET status = 'CONFIRMED'
       FROM import_cycles c
      WHERE c.id = po.cycle_id
        AND po.status = 'DRAFT'
        AND c.status IN ($PAST);" >/dev/null

left=$(run "$FIND" || true)
if [[ -z "$left" ]]; then
  echo "  Confirmed $count order(s). None left."
else
  echo "  Still $(wc -l <<<"$left" | tr -d ' ') left — check the output above."
  exit 1
fi
