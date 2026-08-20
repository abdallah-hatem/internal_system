#!/usr/bin/env bash
# Stop the local stack and close the Terminal windows dev.sh opened.
set -uo pipefail

TAG="motoparts-dev"

echo "==> Stopping servers on :3000 and :3001"
lsof -ti:3000,3001 2>/dev/null | xargs -r kill -9 2>/dev/null || true

echo "==> Closing dev Terminal windows"
"$(dirname "${BASH_SOURCE[0]}")/close-dev-windows.sh" || true

echo "==> Stopping database"
docker compose stop >/dev/null 2>&1 || true
echo "Done."
