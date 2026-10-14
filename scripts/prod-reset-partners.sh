#!/usr/bin/env bash
# Empty production and replace the partner logins — one transaction.
#
#   scripts/prod-reset-partners.sh "Name <email>" "Name <email>" "Name <email>"
#
# Keeps: the migration history, the FX rates and the OAuth client
# registrations (so Claude/ChatGPT can sign in again). Removes: every
# business record, every login and partner record, every assistant connection.
# Then creates one CORE_PARTNER login + partner record per argument, asking for
# each password on the terminal (never on the command line, never echoed).
#
# Run it yourself, in a terminal: it refuses to run without a terminal, and it
# asks you to type RESET PRODUCTION first. There is no backup step; take one
# with `scripts/ship-prod.sh backup` beforehand if you want one.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
API_DIR="$ROOT/apps/api"

[[ $# -ge 1 ]] || { sed -n 2,14p "$0"; exit 1; }
[[ -t 0 ]] || { echo "Run this in a terminal: it asks for passwords."; exit 1; }

people=()
for arg in "$@"; do
  if [[ "$arg" =~ ^(.+)\ \<([^\>]+@[^\>]+)\>$ ]]; then
    people+=("${BASH_REMATCH[1]}"$'\t'"${BASH_REMATCH[2]}")
  else
    echo "  Expected \"Name <email>\", got: $arg"; exit 1
  fi
done

env_file=$(mktemp)
input=$(mktemp)
chmod 600 "$input"
trap 'rm -f "$env_file" "$input"' EXIT
vercel env pull "$env_file" --environment=production --yes --cwd "$API_DIR" >/dev/null 2>&1
url=$(grep -E '^DATABASE_URL_UNPOOLED=' "$env_file" | cut -d= -f2- | tr -d '"')
[[ "$url" == postgresql://* ]] || { echo "  No production database URL came back."; exit 1; }

echo "This EMPTIES PRODUCTION and replaces every login with:"
for p in "${people[@]}"; do echo "  - ${p%%$'\t'*} <${p#*$'\t'}>"; done
read -r -p "Type RESET PRODUCTION to continue: " sure
[[ "$sure" == "RESET PRODUCTION" ]] || { echo "  Stopped. Nothing changed."; exit 1; }

: >"$input"
for p in "${people[@]}"; do
  name=${p%%$'\t'*}; email=${p#*$'\t'}
  while :; do
    read -r -s -p "Password for $email: " pw1; echo
    read -r -s -p "Again: " pw2; echo
    [[ "$pw1" == "$pw2" ]] || { echo "  They differ — again."; continue; }
    (( ${#pw1} >= 8 )) || { echo "  At least 8 characters — again."; continue; }
    break
  done
  printf '%s\t%s\t%s\n' "$name" "$email" "$pw1" >>"$input"
done

cd "$API_DIR"
DATABASE_URL="$url" node "$ROOT/scripts/lib/prod-reset-partners.cjs" "$API_DIR" <"$input"
