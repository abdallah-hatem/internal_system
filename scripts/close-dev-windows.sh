#!/usr/bin/env bash
# Close the Terminal windows this project's dev servers run in.
#
# Needs two steps, and both of them:
#   1. Kill every process on the window's tty. AppleScript's `close` raises
#      Terminal's "Ask before closing" sheet for a window with a running
#      process, and that sheet cannot be dismissed without assistive access.
#   2. Then close the window. Killing the shell alone is not enough — the
#      profile here keeps the window open after the shell exits, leaving a dead
#      window behind.
#
# Windows are matched on the custom title dev.sh stamps on them, which survives
# the process exiting; matching on the running process would miss exactly the
# stale windows worth cleaning up.
set -uo pipefail

TAG="${1:-motoparts-dev}"

list_ttys() {
  osascript 2>/dev/null <<APPLESCRIPT
tell application "Terminal"
  set out to ""
  repeat with w in (every window)
    try
      set t to selected tab of w
      if (custom title of t) contains "$TAG" then set out to out & (tty of t) & linefeed
    end try
  end repeat
  return out
end tell
APPLESCRIPT
}

ttys=$(list_ttys)

if [ -z "${ttys//[[:space:]]/}" ]; then
  echo "No $TAG windows open."
  exit 0
fi

# 1. Silence the windows.
for dev in $ttys; do
  t=${dev#/dev/}
  [ -z "$t" ] && continue
  pids=$(ps -eo pid,tty | awk -v T="$t" '$2==T {print $1}')
  [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
done
sleep 1

# 2. Close them.
closed=$(osascript 2>/dev/null <<APPLESCRIPT
tell application "Terminal"
  set doomed to {}
  repeat with w in (every window)
    try
      if (custom title of (selected tab of w)) contains "$TAG" then set end of doomed to (id of w)
    end try
  end repeat
  repeat with wid in doomed
    try
      close (first window whose id is wid) saving no
    end try
  end repeat
  return (count of doomed)
end tell
APPLESCRIPT
)

echo "Closed ${closed:-0} $TAG window(s)."
