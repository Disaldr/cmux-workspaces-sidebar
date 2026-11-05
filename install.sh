#!/bin/sh
# Installer for the workspaces-tree cmux sidebar.
#   https://github.com/Disaldr/cmux-workspaces-sidebar
#
#   curl -fsSL https://github.com/Disaldr/cmux-workspaces-sidebar/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --with-limits   # + Claude/Codex limits panel
#   curl -fsSL .../install.sh | sh -s -- --uninstall
#
# Run from a cloned repo, it installs the local files instead of downloading.
# Env: CMUX_SIDEBAR_BASE   download base URL (default: latest release)
#      CMUX_SIDEBAR_NO_ACTIVATE=1   don't talk to the running cmux (for tests)
set -eu

REPO="Disaldr/cmux-workspaces-sidebar"
NAME="workspaces-tree"
BASE="${CMUX_SIDEBAR_BASE:-https://github.com/$REPO/releases/latest/download}"
CONFIG="$HOME/.config/cmux"
LIMITS_TITLE="⏱ limits"

WITH_LIMITS=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --with-limits) WITH_LIMITS=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help)
      cat <<'USAGE'
Install the workspaces-tree cmux sidebar.
  install.sh                 install / update the sidebar
  install.sh --with-limits   also install the Claude/Codex limits panel
  install.sh --uninstall     remove it
Run it from a cmux terminal to also select the sidebar and start the
limits feed (cmux's socket only admits processes started by cmux).
USAGE
      exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

CMUX=""
if command -v cmux >/dev/null 2>&1; then CMUX=$(command -v cmux)
elif [ -x /Applications/cmux.app/Contents/Resources/bin/cmux ]; then CMUX=/Applications/cmux.app/Contents/Resources/bin/cmux
fi
can_talk() { [ -n "$CMUX" ] && [ "${CMUX_SIDEBAR_NO_ACTIVATE:-0}" != 1 ]; }

# Local checkout next to this script, or download from the release.
SRC_DIR=""
case "$0" in */install.sh) [ -f "$(dirname "$0")/$NAME.js" ] && SRC_DIR=$(dirname "$0") ;; esac
get() { # get <file> <dest>
  if [ -n "$SRC_DIR" ]; then cp "$SRC_DIR/$1" "$2"
  else curl -fsSL "$BASE/$1" -o "$2"
  fi
}
backup() { [ -f "$1" ] && cp "$1" "$1.$(date +%Y%m%d-%H%M%S).bak" && say "  backed up existing $(basename "$1")"; return 0; }

if [ "$UNINSTALL" = 1 ]; then
  rm -f "$CONFIG/sidebars/$NAME.js" "$CONFIG/usage-feed.sh"
  say "Removed $CONFIG/sidebars/$NAME.js and $CONFIG/usage-feed.sh."
  say "If you used the limits panel, close the \"$LIMITS_TITLE\" workspace in cmux."
  can_talk && "$CMUX" sidebar reload >/dev/null 2>&1 || true
  exit 0
fi

say "Installing the $NAME cmux sidebar"
mkdir -p "$CONFIG/sidebars"
backup "$CONFIG/sidebars/$NAME.js"
get "$NAME.js" "$CONFIG/sidebars/$NAME.js"
say "  -> $CONFIG/sidebars/$NAME.js"

if [ "$WITH_LIMITS" = 1 ]; then
  backup "$CONFIG/usage-feed.sh"
  get usage-feed.sh "$CONFIG/usage-feed.sh"
  chmod +x "$CONFIG/usage-feed.sh"
  say "  -> $CONFIG/usage-feed.sh"
  for dep in node jq; do command -v "$dep" >/dev/null 2>&1 || warn "'$dep' is required by the limits feed"; done
  ls "$HOME/.claude/plugins/cache/claude-dashboard/claude-dashboard"/*/dist/check-usage.js >/dev/null 2>&1 ||
    warn "the claude-dashboard Claude Code plugin is required by the limits feed (it provides check-usage.js)"
fi

if ! can_talk; then
  say ""
  say "Done. In cmux: right-click the sidebar button and choose \"$NAME\"."
  exit 0
fi

"$CMUX" sidebar validate "$NAME" || { warn "cmux could not validate the sidebar"; exit 1; }
"$CMUX" sidebar reload >/dev/null 2>&1 || true

# cmux's socket only admits processes started by cmux (socketControlMode
# "cmuxOnly"), so selecting the sidebar and starting the limits feed only
# work when this installer runs inside a cmux terminal.
if [ -z "${CMUX_WORKSPACE_ID:-}" ]; then
  say ""
  say "Installed. In cmux: right-click the sidebar button and choose \"$NAME\"."
  [ "$WITH_LIMITS" = 1 ] && say "To start the limits panel, re-run with --with-limits from a cmux terminal."
  exit 0
fi

"$CMUX" sidebar select "$NAME" >/dev/null 2>&1 && say "  selected the $NAME sidebar" ||
  say "  in cmux: right-click the sidebar button and choose \"$NAME\""

if [ "$WITH_LIMITS" = 1 ]; then
  if ! command -v jq >/dev/null 2>&1; then
    warn "install jq, then re-run with --with-limits to start the limits feed"
  elif "$CMUX" rpc workspace.list '{}' | jq -e '.workspaces[] | select((.description // "") | startswith("cmux-usage:"))' >/dev/null 2>&1; then
    say "  limits workspace already exists"
  else
    # A hidden service workspace whose terminal runs the feed loop.
    created=$("$CMUX" rpc workspace.create "$(jq -nc --arg t "$LIMITS_TITLE" '{title: $t, focus: "false"}')")
    ws=$(printf '%s' "$created" | jq -r .workspace_id)
    sf=$(printf '%s' "$created" | jq -r .surface_id)
    sleep 1
    "$CMUX" rpc surface.send_text "$(jq -nc --arg s "$sf" '{surface_id: $s, text: "~/.config/cmux/usage-feed.sh\n"}')" >/dev/null
    n=$("$CMUX" rpc workspace.list '{}' | jq '.workspaces | length')
    "$CMUX" rpc workspace.reorder "$(jq -nc --arg id "$ws" --argjson i $((n - 1)) '{workspace_id: $id, index: $i}')" >/dev/null 2>&1 || true
    say "  started the limits feed in the \"$LIMITS_TITLE\" workspace (hidden by the sidebar)"
  fi
fi

say ""
say "Done."
