#!/bin/zsh
# usage-feed: publishes Claude & Codex usage limits for the workspaces-tree
# cmux sidebar (https://github.com/Disaldr/cmux-workspaces-sidebar).
#
# Must run inside a cmux terminal: socketControlMode=cmuxOnly only admits
# processes started by cmux. Each cmux window has its own workspace list (and
# sidebar), so every window gets a hidden "⏱ limits" carrier workspace; the
# numbers go into each carrier's description as "cmux-usage:<json>".
#
#   usage-feed.sh          loop, every $USAGE_INTERVAL seconds (default 300).
#                          Only one loop runs: if another is alive, this does
#                          a single update and exits.
#   usage-feed.sh --once   a single update
#
# Source: the claude-dashboard plugin's check-usage.js (--json).
set -u

CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
MARK="cmux-usage:"
TITLE="⏱ limits"
INTERVAL="${USAGE_INTERVAL:-300}"
LOCK="${TMPDIR:-/tmp}/cmux-usage-feed.pid"
: "${CMUX_WORKSPACE_ID:?run me inside a cmux terminal}"

check_usage_js() {
  local root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/claude-dashboard/claude-dashboard"
  # newest x.y.z that ships dist/check-usage.js
  ls -1 "$root" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n |
    while read -r v; do [ -f "$root/$v/dist/check-usage.js" ] && echo "$root/$v/dist/check-usage.js"; done | tail -1
}

# The carrier workspace of every cmux window, created where missing (and moved
# to the end of that window's list). Prints one workspace id per line.
carriers() {
  local win id n
  for win in $("$CMUX" rpc window.list '{}' | jq -r '.windows[].id'); do
    id=$("$CMUX" rpc workspace.list "$(jq -nc --arg w "$win" '{window_id: $w}')" |
      jq -r --arg m "$MARK" --arg t "$TITLE" \
        '[.workspaces[] | select(((.description // "") | startswith($m)) or .title == $t)][0].id // empty')
    if [ -z "$id" ]; then
      id=$("$CMUX" rpc workspace.create "$(jq -nc --arg w "$win" --arg t "$TITLE" \
        '{window_id: $w, title: $t, focus: "false"}')" | jq -r '.workspace_id // empty')
      [ -n "$id" ] || continue
      n=$("$CMUX" rpc workspace.list "$(jq -nc --arg w "$win" '{window_id: $w}')" | jq '.workspaces | length')
      "$CMUX" rpc workspace.reorder "$(jq -nc --arg id "$id" --argjson i $((n - 1)) \
        '{workspace_id: $id, index: $i}')" >/dev/null 2>&1
      echo "$(date '+%H:%M') created the carrier in window $win" >&2
    fi
    echo "$id"
  done
}

update() {
  local js raw payload id
  js=$(check_usage_js)
  [ -n "$js" ] || { echo "$(date '+%H:%M') claude-dashboard check-usage.js not found"; return 1; }
  raw=$(node "$js" --json 2>/dev/null) || { echo "$(date '+%H:%M') check-usage failed"; return 1; }
  # p5/p7 = % used in the 5h / 7d windows, r5/r7 = reset time (epoch s).
  payload=$(jq -c '
    def ts: if . == null then null else sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 end;
    def pick: if . == null or (.available | not) or .error then null
      else { p5: .fiveHourPercent, p7: .sevenDayPercent, r5: (.fiveHourReset | ts), r7: (.sevenDayReset | ts) } end;
    { at: (now | floor), c: (.claude | pick), x: (.codex | pick) }' <<<"$raw") || return 1
  for id in $(carriers); do
    "$CMUX" rpc workspace.action "$(jq -nc --arg id "$id" --arg d "$MARK$payload" \
      '{action: "set_description", workspace_id: $id, description: $d}')" >/dev/null
  done
  echo "$(date '+%H:%M') $payload"
}

if [ "${1:-}" = "--once" ]; then
  update
  exit
fi

# Single loop: a live pid in the lock file that is a usage-feed process wins.
if [ -f "$LOCK" ]; then
  pid=$(cat "$LOCK" 2>/dev/null)
  if [ -n "$pid" ] && ps -p "$pid" -o command= 2>/dev/null | grep -q usage-feed; then
    echo "usage-feed already runs (pid $pid); updating once"
    update
    exit
  fi
fi
echo $$ >"$LOCK"
trap 'rm -f "$LOCK"' EXIT INT TERM

echo "usage-feed: updating every ${INTERVAL}s (Ctrl-C to stop)"
while true; do
  update
  sleep "$INTERVAL"
done
