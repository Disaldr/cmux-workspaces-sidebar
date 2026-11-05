// workspaces-tree — a cmux custom sidebar: workspaces with the tabs running
// inside them, as ONE flat drag surface (a workspace header plus its tab rows
// form a block).  https://github.com/Disaldr/cmux-workspaces-sidebar
//   • triple-click a workspace or tab   -> rename it in place
//   • ✕ on hover                        -> close the tab / workspace
//   • drag a workspace header           -> reorder workspaces (whole block)
//   • drag a tab                        -> reorder it, or move it to another workspace
//   • right-click a workspace           -> Rename / Color… / Collapse / New / Close
//   • chevron on a workspace            -> collapse / expand its tabs
//   • double-click blank space below    -> create "workspace N" at the end
//   • top panel                         -> Claude / Codex usage limits
// A tab shows a Claude / Codex / … glyph or a terminal icon.

const ACCENT = "#4C9EEB";
// Blank space only takes clicks where something is painted, and the sidebar
// scrolls, so the zone under the list is sized to fill roughly this height.
// cmux doesn't tell the sidebar its height: keep this at or below the visible
// panel height, or the zone overflows and the sidebar starts to scroll.
const PANEL_HEIGHT = 880;
// Approximate row heights, only for sizing that zone.
const HEADER_H = 32;
const TAB_H = 23;
const BLOCK_GAP = 6;   // space between workspace blocks
const PALETTE_H = 100;
const FOOTER_H = 60;

// NB: this runtime's signal setter stores whatever it gets (no updater fns),
// so every toggle reads the current value and writes a fresh one.
const [editingId, setEditingId] = signal(null);   // "w:<wsId>" | "t:<tabId>"
const [pickerId, setPickerId] = signal(null);     // workspace id with open palette
const [collapsed, setCollapsed] = signal([]);     // workspace ids (reset on reload)
const [pending, setPending] = signal(null);       // { title, known: [ids] }
const [tailId, setTailId] = signal(null);         // new workspace shown last until cmux agrees
// Optimistic drops: drawn instantly, dropped once cmux's data (refreshed ~1 s)
// agrees, or after 4 s if the move failed.
const [tabMove, setTabMove] = signal(null);       // { tabId, to, before, at }
const [orderOverride, setOrderOverride] = signal(null); // { ids, at }

const isCollapsed = (id) => collapsed().includes(id);
const toggleCollapsed = (id) =>
  setCollapsed(isCollapsed(id) ? collapsed().filter((x) => x !== id) : [...collapsed(), id]);
const startEdit = (id) => { setPickerId(null); setEditingId(id); };
const openPicker = (id) => { setEditingId(null); setPickerId(id); };

// Triple click: three taps on the same row, each within 500 ms of the last.
// Every row tap also stamps `rowTapAt` (see newWorkspaceZone).
const clicks = { key: null, n: 0, at: 0 };
let rowTapAt = 0;
function isTripleClick(key) {
  const now = Date.now();
  rowTapAt = now;
  if (clicks.key === key && now - clicks.at < 500) clicks.n += 1;
  else { clicks.key = key; clicks.n = 1; }
  clicks.at = now;
  if (clicks.n < 3) return false;
  clicks.n = 0;
  return true;
}

// Inline palette (real colored circles; set_color accepts any hex).
const PALETTE = [
  "#EF4444", "#F97316", "#F59E0B", "#EAB308", "#84CC16", "#22C55E", "#10B981", "#14B8A6",
  "#06B6D4", "#0EA5E9", "#3B82F6", "#1E3A8A", "#6366F1", "#8B5CF6", "#A855F7", "#D946EF",
  "#EC4899", "#F43F5E", "#92400E", "#78716C", "#64748B", "#6B7280", "#27272A", "#E4E4E7",
];

// Agent glyphs (the sidebar renderer only draws SF Symbols, not cmux's logo
// assets), tinted in each agent's brand color.
const AGENTS = {
  claude:   { symbol: "asterisk", color: "#D97757" },
  codex:    { symbol: "hexagon",  color: "#E6E6E6" },
  gemini:   { symbol: "sparkle",  color: "#8AB4F8" },
  opencode: { symbol: "chevron.left.forwardslash.chevron.right", color: "#CFCFCF" },
};
const styleOf = (a) => {
  const k = String(a.kind ?? "").toLowerCase();
  const id = Object.keys(AGENTS).find((name) => k.includes(name));
  return id ? AGENTS[id] : { symbol: "sparkles", color: "#C47BE6" };
};

// The usage feed's service workspace (~/.config/cmux/usage-feed.sh writes
// "cmux-usage:<json>" into its description) is hidden and only feeds the footer.
const FEED_MARK = "cmux-usage:";
const isFeed = (w) => String(w.description ?? "").startsWith(FEED_MARK);
const allWs = () => data.workspaces() ?? [];               // cmux's full order
const wsList = () => allWs().filter((w) => !isFeed(w));   // what the list shows
const wsById = (id) => allWs().find((w) => w.id === id);
const agentFor = (w, t) => (w.agents ?? []).find((a) => a.panelId === t.id);

// --- colors ------------------------------------------------------------------
// One ladder per workspace, built from its color (neutral gray without one),
// in rising strength. Values are the opacity you end up SEEING:
const LEVEL = {
  idle: 0.10,        // 1. background of an inactive workspace
  idleFocus: 0.17,   //    its focused tab (the one you land on when switching)
  idleHover: 0.24,   // 2. hover on a tab / name in an inactive workspace
  active: 0.32,      // 3. background of the active workspace
  activeTab: 0.50,   // 4. active tab of the active workspace
  activeHover: 0.62, // 5. hover on a tab / name in the active workspace
};
const NEUTRAL = "#8E8E93";
const baseOf = (w) => (w && w.color && w.color.length === 7 ? w.color : NEUTRAL);
const withAlpha = (hex, a) =>
  hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0").toUpperCase();
// A translucent layer of alpha x over one of alpha `under` reads as
// 1-(1-under)(1-x); this is the x that makes the pair read as `target`.
const over = (target, under) => 1 - (1 - target) / (1 - under);
// Row background (level 1 or 3); a workspace without a color stays clear when idle.
const bgLevel = (w) => (!w ? 0 : w.selected ? LEVEL.active : w.color ? LEVEL.idle : 0);
const rowFill = (w) => (bgLevel(w) ? withAlpha(baseOf(w), bgLevel(w)) : null);
// Header hover replaces the header's own background (same view).
const headerHover = (w) => withAlpha(baseOf(w), w && w.selected ? LEVEL.activeHover : LEVEL.idleHover);
// Tab pills sit ON the row background, so they add only the difference.
const pillFill = (w, t) => {
  if (!w || !t.focused) return null;
  return withAlpha(baseOf(w), over(w.selected ? LEVEL.activeTab : LEVEL.idleFocus, bgLevel(w)));
};
const pillHover = (w) =>
  withAlpha(baseOf(w), over(w && w.selected ? LEVEL.activeHover : LEVEL.idleHover, bgLevel(w)));

// --- new workspace -----------------------------------------------------------
// Named "workspace N" with N = workspace count + 1. cmux inserts it after the
// current workspace; this sidebar draws it LAST from the very first frame it
// exists (see `ordered`) and moves it to the end in cmux behind the scenes.
// One workspace per gesture: macOS keeps counting a click series, so a triple
// click fires the double-click handler twice. Ignore requests while a create
// is in flight (until it shows up in the data, at most 5 s) or within 1.5 s.
let lastCreateAt = 0;
function createWorkspace() {
  const now = Date.now();
  const p = pending();
  if ((p && now - p.at < 5000) || now - lastCreateAt < 1500) return;
  lastCreateAt = now;
  const ws = wsList();
  const title = "workspace " + (ws.length + 1);
  setPending({ title, known: allWs().map((w) => w.id), at: now });
  cmux("workspace.create", { title, focus: true });
}

const newcomer = () => {
  const p = pending();
  return p ? wsList().find((w) => w.title === p.title && !p.known.includes(w.id)) : null;
};

// Workspace order as drawn: cmux's order, with the new workspace pinned last.
const ordered = computed(() => {
  let ws = wsList();
  const o = orderOverride();
  if (o) {
    const rank = new Map(o.ids.map((id, i) => [id, i]));
    ws = [...ws].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }
  const tail = newcomer()?.id ?? tailId();
  const x = tail ? ws.find((w) => w.id === tail) : null;
  return x ? [...ws.filter((w) => w.id !== tail), x] : ws;
});

// The newcomer goes to the end of the visible list, i.e. right before the
// hidden limits workspace, which stays last in cmux's order.
const placeNewcomer = computed(() => {
  const ws = allWs();
  const n = newcomer();
  if (n) {
    setPending(null);
    setTailId(n.id);
    const target = ws.length - 1 - (ws.some(isFeed) ? 1 : 0);
    if (ws.findIndex((w) => w.id === n.id) !== target) {
      cmux("workspace.reorder", { workspace_id: n.id, index: target });
    }
    return;
  }
  const tail = tailId();
  const vis = wsList();
  if (tail && (!vis.some((w) => w.id === tail) || vis[vis.length - 1].id === tail)) setTailId(null);
});

// cmux selects a neighbour when a workspace closes, and that can be the hidden
// limits workspace. Never leave it selected: go back to the most recently
// selected workspace that still exists (else the last visible one).
const recentSel = [];
let lastRedirectAt = 0;
const guardFeedSelection = computed(() => {
  const sel = allWs().find((w) => w.selected);
  if (!sel) return;
  if (!isFeed(sel)) {
    if (recentSel[0] !== sel.id) {
      const i = recentSel.indexOf(sel.id);
      if (i > 0) recentSel.splice(i, 1);
      recentSel.unshift(sel.id);
      if (recentSel.length > 20) recentSel.length = 20;
    }
    return;
  }
  if (Date.now() - lastRedirectAt < 1000) return;
  const vis = wsList();
  const back = recentSel.find((id) => vis.some((w) => w.id === id)) ?? vis[vis.length - 1]?.id;
  if (!back) return;
  lastRedirectAt = Date.now();
  cmux("workspace.select", { workspace_id: back });
});

const homeOf = (tabId) => allWs().find((w) => (w.tabs ?? []).some((x) => x.id === tabId));

// A workspace's tabs as drawn: cmux's list with a pending drop applied.
function tabsOf(w) {
  const m = tabMove();
  const tabs = (w.tabs ?? []).filter((t) => !m || t.id !== m.tabId);
  if (m && w.id === m.to) {
    const t = (homeOf(m.tabId)?.tabs ?? []).find((x) => x.id === m.tabId);
    if (t) {
      const i = m.before ? tabs.findIndex((x) => x.id === m.before) : -1;
      tabs.splice(i < 0 ? tabs.length : i, 0, t);
    }
  }
  return tabs;
}

const settleOverrides = computed(() => {
  const now = Date.now();
  const m = tabMove();
  if (m) {
    const ids = (wsById(m.to)?.tabs ?? []).map((t) => t.id);
    const i = ids.indexOf(m.tabId);
    const placed = i >= 0 && (m.before ? ids[i + 1] === m.before : i === ids.length - 1);
    if (placed || now - m.at > 4000) setTabMove(null);
  }
  const o = orderOverride();
  if (o) {
    const vis = wsList().map((w) => w.id).filter((id) => o.ids.includes(id));
    const want = o.ids.filter((id) => vis.includes(id));
    if (vis.join() === want.join() || now - o.at > 4000) setOrderOverride(null);
  }
});

// --- flat rows ---------------------------------------------------------------
// Header "w:<id>", palette "p:<id>", tab "t:<wsId>:<tabId>" (":edit" while
// renaming). Non-header rows carry their header's key as `block`, so dragging
// a header moves the whole block while a tab can be dragged out on its own.
const entries = computed(() => {
  const eid = editingId();
  const pid = pickerId();
  const col = collapsed();
  const out = [];
  for (const w of ordered()) {
    const start = out.length;
    const hEdit = eid === "w:" + w.id;
    const hk = "w:" + w.id + (hEdit ? ":edit" : "");
    out.push({ key: hk, kind: "header", wsId: w.id, editing: hEdit, first: start === 0 });
    if (pid === w.id) out.push({ key: "p:" + w.id, kind: "palette", wsId: w.id, block: hk });
    if (!col.includes(w.id)) {
      for (const t of tabsOf(w)) {
        const tEdit = eid === "t:" + t.id;
        out.push({
          // Keyed by the tab alone: a tab moved to another workspace keeps its
          // row (and the drop animation) instead of being re-created.
          key: "t:" + t.id + (tEdit ? ":edit" : ""),
          kind: "tab", wsId: w.id, tabId: t.id, surfaceId: t.surfaceId, block: hk, editing: tEdit,
        });
      }
    }
  }
  return out;
});

// `index` is the dragged row's slot after the move. For a block it counts
// rows without that block; for a single row, rows without that row.
function handleMove(key, index, extra) {
  const all = entries();
  const moved = all.find((e) => e.key === key);
  if (!moved) return;

  if (moved.kind === "header") {
    const rest = all.filter((e) => e.wsId !== moved.wsId);
    const next = rest.slice(index).find((e) => e.kind === "header");
    const order = allWs().map((w) => w.id).filter((id) => id !== moved.wsId);
    const to = next ? order.indexOf(next.wsId) : order.length;
    const vis = ordered().map((w) => w.id).filter((id) => id !== moved.wsId);
    const at = next ? vis.indexOf(next.wsId) : vis.length;
    vis.splice(at < 0 ? vis.length : at, 0, moved.wsId);
    setOrderOverride({ ids: vis, at: Date.now() });
    cmux("workspace.reorder", { workspace_id: moved.wsId, index: to });
    return;
  }
  if (moved.kind !== "tab" || !moved.surfaceId) return;

  const rest = all.filter((e) => e.key !== key);
  const above = rest[index - 1];
  const below = rest[index];
  // At a block boundary the pointer's X picks the side: "below" joins the
  // workspace underneath (as its first tab), otherwise join the one above.
  let target;
  if (below && below.kind === "header" && extra && extra.side === "below") target = below.wsId;
  else target = above ? above.wsId : below ? below.wsId : moved.wsId;

  const params = { surface_id: moved.surfaceId, workspace_id: target, focus: false };
  let before = null;
  if (below && below.kind === "tab" && below.wsId === target) before = below;
  else if (below && below.wsId === target) {
    before = rest.find((e) => e.kind === "tab" && e.wsId === target) ?? null;
  }
  if (before && before.surfaceId) params.before_surface_id = before.surfaceId;
  setTabMove({ tabId: moved.tabId, to: target, before: before ? before.tabId : null, at: Date.now() });
  cmux("surface.move", params);
}

// --- actions -----------------------------------------------------------------
function closeTab(w, t) {
  // cmux refuses to close a workspace's last surface: close the workspace.
  if ((w.tabs ?? []).length <= 1) cmux("workspace.close", { workspace_id: w.id });
  else if (t.surfaceId) cmux("surface.close", { surface_id: t.surfaceId });
}

function focusTab(w, t) {
  if (!w) return;
  cmux("workspace.select", { workspace_id: w.id });
  if (t.surfaceId) cmux("surface.focus", { surface_id: t.surfaceId });
}

function wsContextMenu(w) {
  return [
    Button("Rename", () => startEdit("w:" + w().id)),
    Button("Color…", () => openPicker(w().id)),
    Button(() => (isCollapsed(w().id) ? "Expand" : "Collapse"), () => toggleCollapsed(w().id)),
    Divider(),
    Button("New workspace", () => createWorkspace()),
    Divider(),
    Button("Close", () => cmux("workspace.close", { workspace_id: w().id })).destructive(),
  ];
}

// --- rows --------------------------------------------------------------------
// Space between blocks, outside the tint; none above the first workspace.
const gap = (e) =>
  Rectangle().fill("#00000000").frame(() => ({ maxWidth: "infinity", height: e().first ? 0 : BLOCK_GAP }));


const closeIcon = (help, onTap) =>
  Image("xmark")
    .font(9).weight("semibold").color("tertiary")
    .frame({ width: 14, height: 14 })
    .cursor("pointer")
    .help(help)
    .showOnHover()
    .onTap(onTap);

function headerRow(e) {
  const w = () => wsById(e().wsId) ?? { id: e().wsId, title: "", tabs: [] };
  return VStack({ spacing: 0 }, [
    gap(e),
    HStack({ spacing: 6 }, [
      Text(() => w().title)
        .font(12)
        .weight(() => (w().selected ? "bold" : "semibold"))
        .lineLimit(1).truncation("tail")
        .color(() => (w().selected ? "primary" : "secondary")),
      Spacer(),
      Text(() => (w().unread > 0 ? String(w().unread) : "")).font(10).color("red"),
      // tab count, shown only while collapsed
      Text(() => (isCollapsed(w().id) ? String((w().tabs ?? []).length) : ""))
        .font(10).color("tertiary").monospaced(),
      closeIcon("Close workspace", () => cmux("workspace.close", { workspace_id: w().id })),
      Image("chevron.right")
        .font(9).weight("semibold").color("tertiary")
        .rotation(() => (isCollapsed(w().id) ? 0 : 90))
        .frame({ width: 16, height: 16 })
        .cursor("pointer")
        .help(() => (isCollapsed(w().id) ? "Expand" : "Collapse"))
        .onTap(() => toggleCollapsed(w().id)),
    ])
      .frame({ maxWidth: "infinity" })
      .paddingHorizontal(6).paddingVertical(5)
      .background(() => rowFill(w()))
      .hoverBackground(() => headerHover(w())),
  ])
    .frame({ maxWidth: "infinity" })
    .fixed()
    .block(e().key)
    .onTap(() => {
      if (isTripleClick(e().key)) startEdit("w:" + w().id);
      else cmux("workspace.select", { workspace_id: w().id });
    })
    .contextMenu(wsContextMenu(w));
}

function nameEditor(initial, onCommit) {
  return TextField(initial, {
    autofocus: true,
    onSubmit: (text) => {
      const title = (text ?? "").trim();
      if (title) onCommit(title);
      setEditingId(null);
    },
    onCancel: () => setEditingId(null),
  });
}

function headerEditRow(e) {
  const w = () => wsById(e().wsId) ?? { id: e().wsId, title: "" };
  return VStack({ spacing: 0 }, [
    gap(e),
    HStack({ spacing: 6 }, [
      nameEditor(() => w().title, (title) =>
        cmux("workspace.action", { action: "rename", workspace_id: w().id, title })),
    ])
      .frame({ maxWidth: "infinity" })
      .paddingHorizontal(6).paddingVertical(4)
      .background(() => rowFill(w())),
  ])
    .frame({ maxWidth: "infinity" })
    .fixed()
    .block(e().key);
}

function paletteRow(e) {
  const w = () => wsById(e().wsId) ?? { id: e().wsId };
  const current = (hex) => String(w().color ?? "").toUpperCase() === hex;
  const swatch = (hex) =>
    ZStack([
      Circle({ size: 16 }).fill(hex),
      Image("checkmark").font(8).weight("bold").color(() => (current(hex) ? "#FFFFFF" : "#00000000")),
    ])
      .frame({ width: 20, height: 20 })
      .cursor("pointer")
      .onTap(() => {
        cmux("workspace.action", { action: "set_color", workspace_id: w().id, color: hex });
        setPickerId(null);
      });
  const row = (from) => HStack({ spacing: 4 }, PALETTE.slice(from, from + 8).map(swatch));
  return VStack({ spacing: 4 }, [
    row(0),
    row(8),
    row(16),
    HStack({ spacing: 8 }, [
      Text("No color").font(10).color("secondary").cursor("pointer").onTap(() => {
        cmux("workspace.action", { action: "clear_color", workspace_id: w().id });
        setPickerId(null);
      }),
      Spacer(),
      Text("Done").font(10).color("tertiary").cursor("pointer").onTap(() => setPickerId(null)),
    ]),
  ])
    .frame({ maxWidth: "infinity" })
    .paddingLeading(12).paddingTrailing(6).paddingVertical(5)
    .background(() => rowFill(w()))
    .fixed()
    .block(() => e().block);
}

// w: the workspace the row is drawn under; the tab itself (and its agent) is
// looked up where cmux has it, which differs from w while a drop is pending.
function tabParts(e) {
  const w = () => wsById(e().wsId);
  const t = () => (homeOf(e().tabId)?.tabs ?? []).find((x) => x.id === e().tabId) ?? { id: e().tabId, title: "" };
  return { w, t };
}

const tabIcon = (w, t) => {
  const agent = () => { const h = homeOf(t().id); return h ? agentFor(h, t()) : null; };
  return Image("terminal")
    .systemName(() => (agent() ? styleOf(agent()).symbol : "terminal"))
    .font(10)
    .color(() => (agent() ? styleOf(agent()).color : "secondary"))
    .frame({ width: 15 });
};

const indent = () => Rectangle().fill("#00000000").frame({ width: 14, height: 1 });

// Right-hand badge: orange = the tab's agent is waiting for your input
// (agents[].status), blue = an unread notification on the tab.
const WAITING = "#FF9F0A";
function tabBadge(w, t) {
  const a = w ? agentFor(w, t) : null;
  if (a && a.status === "needs_input") return { text: "●", color: WAITING, help: "Waiting for input" };
  if (t.hasUnread) return { text: "●", color: ACCENT, help: "Unread notification" };
  return { text: "", color: "#00000000", help: "" };
}

// The tab's ✕ lives in its indent (far from the right edge, where clicks
// aimed at the scrollbar or the next pane land); the clear box keeps the
// slot's width whether or not the hover-only icon is shown.
const tabCloseSlot = (w, t) =>
  ZStack([
    Rectangle().fill("#00000000").frame({ width: 14, height: 14 }),
    closeIcon("Close tab", () => { const h = homeOf(t().id) ?? w(); if (h) closeTab(h, t()); }),
  ]).frame({ width: 14, height: 14 });

function tabRow(e) {
  const { w, t } = tabParts(e);
  const active = () => !!(w()?.selected && t().focused);
  return HStack({ spacing: 0 }, [
    HStack({ spacing: 6 }, [
      tabCloseSlot(w, t),
      tabIcon(w, t),
      Text(() => t().title || "untitled")
        .font(11)
        .weight(() => (active() ? "semibold" : "regular"))
        .lineLimit(1).truncation("tail")
        .color(() => (active() ? "primary" : "secondary")),
      Spacer(),
      Text(() => tabBadge(homeOf(t().id), t()).text)
        .font(9)
        .color(() => tabBadge(homeOf(t().id), t()).color)
        .help(() => tabBadge(homeOf(t().id), t()).help),
    ])
      .frame({ maxWidth: "infinity" })
      .paddingHorizontal(6).paddingVertical(4)
      // focused tab: level 4 in the active workspace, a faint step when idle
      .background(() => pillFill(w(), t()))
      .hoverBackground(() => pillHover(w())),
  ])
    .frame({ maxWidth: "infinity" })
    .background(() => rowFill(w())) // workspace tint, contiguous with the header
    .block(() => e().block)
    .onTap(() => {
      if (isTripleClick(e().key)) startEdit("t:" + t().id);
      else focusTab(w(), t());
    });
}

function tabEditRow(e) {
  const { w, t } = tabParts(e);
  return HStack({ spacing: 6 }, [
    indent(),
    tabIcon(w, t),
    nameEditor(() => t().title, (title) =>
      cmux("tab.action", { action: "rename", surface_id: t().surfaceId, workspace_id: e().wsId, title })),
  ])
    .frame({ maxWidth: "infinity" })
    .paddingHorizontal(6).paddingVertical(3)
    .background(() => rowFill(w()))
    .block(() => e().block);
}

// --- blank space: double-click creates a workspace ---------------------------
const zoneHeight = computed(() => {
  let used = 0;
  for (const e of entries()) {
    used += e.kind === "tab" ? TAB_H : e.kind === "palette" ? PALETTE_H : HEADER_H + (e.first ? 0 : BLOCK_GAP);
  }
  return Math.max(140, PANEL_HEIGHT - FOOTER_H - used);
});

// macOS keeps counting clicks across views, so a click here right after a
// double-click on a row arrives as part of that series and would look like a
// double-click on the zone. Only a double-click that starts in the zone counts.
const ZONE_GUARD_MS = 700;
function newWorkspaceZone() {
  return HStack({ spacing: 0 }, [Spacer()])
    .frame(() => ({ maxWidth: "infinity", height: zoneHeight() }))
    .background("#7f7f7f05") // painted (so it takes clicks), yet invisible
    .onTap(() => {})
    .onDoubleTap(() => {
      if (Date.now() - rowTapAt < ZONE_GUARD_MS) return;
      createWorkspace();
    });
}

// --- top panel: Claude / Codex usage limits ------------------------------------
const FEED_CMD = "~/.config/cmux/usage-feed.sh\n";
const STALE_S = 15 * 60; // the feed updates every 5 min
const nowS = () => data.clock()?.epoch ?? Math.floor(Date.now() / 1000);
const feedWs = () => allWs().find(isFeed);
const usage = computed(() => {
  const w = feedWs();
  if (!w) return null;
  try { return JSON.parse(String(w.description).slice(FEED_MARK.length)); } catch (err) { return null; }
});
const isStale = () => { const u = usage(); return !u || nowS() - (u.at ?? 0) > STALE_S; };
const pctColor = (p) => (p == null ? "tertiary" : p >= 80 ? "#E5484D" : p >= 50 ? "#E8C547" : "#46A758");
function fmtLeft(epoch) {
  if (!epoch) return "?";
  const s = Math.max(0, epoch - nowS());
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return Math.floor(h / 24) + "d " + (h % 24) + "h";
  return h ? h + "h " + m + "m" : m + "m";
}

// "5h ▬▬▬ 92%": label, bar, percent; the tooltip shows when it resets.
function meter(get, win) {
  const BAR = 26;
  const p = () => { const v = get(); return v ? v["p" + win] ?? null : null; };
  return HStack({ spacing: 3 }, [
    Text(win === "5" ? "5h" : "7d").font(9).color("tertiary").monospaced(),
    HStack({ spacing: 0 }, [
      Capsule()
        .fill(() => pctColor(p()))
        .frame(() => ({ width: Math.max(1, Math.round((BAR * Math.min(100, p() ?? 0)) / 100)), height: 4 })),
      Spacer(),
    ]).frame({ width: BAR, height: 4 }).background("#7f7f7f33").cornerRadius(2),
    Text(() => (p() == null ? "–" : p() + "%"))
      .font(9).monospaced().color(() => pctColor(p()))
      .frame({ width: 28, alignment: "leading" }),
  ]).help(() => { const v = get(); return v ? "resets in " + fmtLeft(v["r" + win]) : "no data"; });
}

function usageRow(label, style, key) {
  const get = () => { const u = usage(); return u ? u[key] : null; };
  return HStack({ spacing: 5 }, [
    Image(style.symbol).font(9).color(style.color).frame({ width: 12 }),
    Text(label).font(10).color("secondary").frame({ width: 38, alignment: "leading" }),
    meter(get, "5"),
    meter(get, "7"),
    Spacer(),
  ]);
}

let lastRestartAt = 0;
function usagePanel() {
  return VStack({ spacing: 3 }, [
    Text(() => {
      if (!feedWs()) return "limits feed is not set up";
      if (isStale()) return "limits outdated · click to restart";
      const u = usage();
      const ago = Math.max(0, Math.round((nowS() - u.at) / 60));
      return "updated " + (ago ? ago + "m ago" : "just now") + " · Claude 5h resets in " + fmtLeft(u.c?.r5);
    })
      .font(9).lineLimit(1).truncation("tail")
      .color(() => (feedWs() && isStale() ? "#E8C547" : "tertiary")),
    usageRow("Claude", AGENTS.claude, "c"),
    usageRow("Codex", AGENTS.codex, "x"),
    Divider(),
  ])
    .frame({ maxWidth: "infinity" })
    .paddingHorizontal(6).paddingVertical(4)
    .onTap(() => {
      // Restart the feed loop in its terminal, only when it has gone quiet
      // (typing into a live loop would just queue up in its stdin).
      const sf = feedWs()?.tabs?.[0]?.surfaceId;
      if (!sf || !isStale() || Date.now() - lastRestartAt < 60000) return;
      lastRestartAt = Date.now();
      cmux("surface.send_text", { surface_id: sf, text: FEED_CMD });
    });
}


// --- root --------------------------------------------------------------------
sidebar(() =>
  VStack({ spacing: 2 }, [
    usagePanel(),
    Reorderable(
      { items: entries, key: (e) => e.key, spacing: 0, onMove: handleMove },
      (e) => {
        const entry = e(); // kind and editing are stable per key
        if (entry.kind === "header") return entry.editing ? headerEditRow(e) : headerRow(e);
        if (entry.kind === "palette") return paletteRow(e);
        return entry.editing ? tabEditRow(e) : tabRow(e);
      }
    ),
    newWorkspaceZone(),
  ]).padding(4),
  { surface: "glass" }
)
