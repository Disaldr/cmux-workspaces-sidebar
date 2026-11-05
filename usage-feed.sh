#!/bin/zsh
# usage-feed: publishes Claude & Codex usage limits for the workspaces-tree
# cmux sidebar (https://github.com/Disaldr/cmux-workspaces-sidebar).
#
# Must run inside a cmux terminal: socketControlMode=cmuxOnly only admits
# processes started by cmux. It writes the numbers into ITS OWN workspace's
# description as "cmux-usage:<json>"; the sidebar hides that workspace and
# draws the limits in a footer.
#
#   usage-feed.sh          loop forever, every $USAGE_INTERVAL seconds (default 300)
#   usage-feed.sh --once   a single update
#
# Source: the claude-dashboard plugin's check-usage.js (--json).
set -u

CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
MARK="cmux-usage:"
INTERVAL="${USAGE_INTERVAL:-300}"
WS="${CMUX_WORKSPACE_ID:?run me inside a cmux terminal}"

check_usage_js() {
  local root="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/cache/claude-dashboard/claude-dashboard"
  # newest x.y.z that ships dist/check-usage.js
  ls -1 "$root" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1n -k2,2n -k3,3n |
    while read -r v; do [ -f "$root/$v/dist/check-usage.js" ] && echo "$root/$v/dist/check-usage.js"; done | tail -1
}

update() {
  local js raw payload
  js=$(check_usage_js)
  [ -n "$js" ] || { echo "$(date '+%H:%M') claude-dashboard check-usage.js not found"; return 1; }
  raw=$(node "$js" --json 2>/dev/null) || { echo "$(date '+%H:%M') check-usage failed"; return 1; }
  # p5/p7 = % used in the 5h / 7d windows, r5/r7 = reset time (epoch s).
  payload=$(jq -c '
    def ts: if . == null then null else sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 end;
    def pick: if . == null or (.available | not) or .error then null
      else { p5: .fiveHourPercent, p7: .sevenDayPercent, r5: (.fiveHourReset | ts), r7: (.sevenDayReset | ts) } end;
    { at: (now | floor), c: (.claude | pick), x: (.codex | pick) }' <<<"$raw") || return 1
  "$CMUX" rpc workspace.action "$(jq -nc --arg id "$WS" --arg d "$MARK$payload" \
    '{action: "set_description", workspace_id: $id, description: $d}')" >/dev/null || return 1
  echo "$(date '+%H:%M') $payload"
}

if [ "${1:-}" = "--once" ]; then
  update
  exit
fi

echo "usage-feed: updating every ${INTERVAL}s (Ctrl-C to stop)"
while true; do
  update
  sleep "$INTERVAL"
done
