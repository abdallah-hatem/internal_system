#!/usr/bin/env bash
# Photo files with nothing pointing at them.
#
# The test harness rolls the database back after a run but does not roll back
# the disk, so every import-request test leaves a directory of stripped,
# re-encoded WebPs that no row references. They are harmless and they
# accumulate, and after enough runs a stray is indistinguishable from a
# photograph a real shop sent.
#
# This only reports. Deleting needs --delete, and that is deliberate: these are
# customer photographs, and one the business still needs looks exactly like one
# it does not.
#
#   scripts/check-uploads.sh
#   scripts/check-uploads.sh --delete
set -euo pipefail
DB=${DB:-motorcycle_parts}
CONTAINER=${CONTAINER:-motorcycle_parts_db}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
UPLOADS="$ROOT/apps/api/uploads/product-requests"

DELETE=false
[[ "${1:-}" == "--delete" ]] && DELETE=true

if [[ ! -d "$UPLOADS" ]]; then
  echo "  no uploads directory — nothing to check"
  exit 0
fi

# Every request id the database still has a photo row for. The directory is
# named for the request, and the url carries it.
REFERENCED=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -tAc \
  "SELECT DISTINCT import_request_id FROM import_request_photos;" 2>/dev/null || true)

if [[ -z "$REFERENCED" ]]; then
  echo "  ⚠ The database has no photo rows at all, so everything below counts as"
  echo "    orphaned. That is usually not a disk problem — the Playwright harness"
  echo "    restores the database after a run and takes every photo row with it,"
  echo "    while leaving the files. Photographs a real shop sent look exactly the"
  echo "    same here. Check the dates against when you last ran the suite before"
  echo "    deleting anything."
  echo
fi

orphans=()
for dir in "$UPLOADS"/*/; do
  [[ -d "$dir" ]] || continue
  name=$(basename "$dir")
  if ! grep -qx "$name" <<<"$REFERENCED"; then orphans+=("$name"); fi
done

total=$(find "$UPLOADS" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
echo "  $total director(ies) on disk"
echo "  $((total - ${#orphans[@]})) still referenced by a request"
echo "  ${#orphans[@]} orphaned"
echo

if [[ ${#orphans[@]} -eq 0 ]]; then exit 0; fi

for name in "${orphans[@]}"; do
  size=$(du -sh "$UPLOADS/$name" | cut -f1)
  when=$(date -r "$UPLOADS/$name" "+%Y-%m-%d %H:%M")
  printf "    %s  %6s  %s\n" "$name" "$size" "$when"
done

echo
if [[ "$DELETE" != true ]]; then
  echo "  Nothing deleted. Look at the dates above, then re-run with --delete."
  echo "  A directory older than your last test run is more likely to be a real"
  echo "  request whose row the harness rolled back than a stray the tests made."
  exit 0
fi

for name in "${orphans[@]}"; do rm -rf "${UPLOADS:?}/$name"; done
echo "  Deleted ${#orphans[@]} orphaned director(ies)."
