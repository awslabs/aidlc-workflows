// Pure view logic for Home at scale (no React, no DOM): status buckets, search, sort, grouping, the AUTO
// cards/compact choice and list windowing. Unit-tested in tests/home-view.test.ts.
import type { IntentSummary, WorkspaceSummary } from "../../../../core/command-center/server/types";
import { liveNow } from "../intent/derive";

export type StatusKey = "waiting" | "active" | "idle" | "ended" | "done";
export const STATUS_KEYS: StatusKey[] = ["waiting", "active", "idle", "ended", "done"];
/** Chip glyph, label and colour class per bucket (status is always glyph + label + colour). */
export const STATUS_META: Record<StatusKey, { glyph: string; label: string; cls: string }> = {
  waiting: { glyph: "?", label: "Waiting on you", cls: "wait" },
  active: { glyph: "●", label: "Active", cls: "run" },
  idle: { glyph: "◌", label: "Idle", cls: "dim" },
  ended: { glyph: "■", label: "Ended", cls: "dim" },
  done: { glyph: "✓", label: "Done / archived", cls: "ok" },
};

export type SortKey = "needs" | "recent" | "name" | "progress";
export const SORTS: { key: SortKey; label: string }[] = [
  { key: "needs", label: "Needs you first" }, { key: "recent", label: "Recent activity" }, { key: "name", label: "Name" }, { key: "progress", label: "Progress" },
];
export type GroupKey = "workspace" | "status" | "none";
export const GROUPINGS: { key: GroupKey; label: string }[] = [{ key: "workspace", label: "Workspace" }, { key: "status", label: "Status" }, { key: "none", label: "None" }];
export type ViewKind = "cards" | "compact";

export interface HomePrefs { filters: StatusKey[]; q: string; sort: SortKey; reverse: boolean; group: GroupKey }
export const DEFAULT_PREFS: HomePrefs = { filters: [], q: "", sort: "needs", reverse: false, group: "workspace" };

/** Prefs read back from storage: every field checked against the known keys; anything else is the default. */
export function sanitizePrefs(raw: unknown): HomePrefs {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PREFS, filters: [] };
  const o = raw as Record<string, unknown>;
  const filters = Array.isArray(o.filters) ? [...new Set(o.filters.filter((f): f is StatusKey => STATUS_KEYS.includes(f as StatusKey)))] : [];
  return {
    filters,
    q: typeof o.q === "string" ? o.q.slice(0, 200) : DEFAULT_PREFS.q,
    sort: SORTS.some((x) => x.key === o.sort) ? (o.sort as SortKey) : DEFAULT_PREFS.sort,
    reverse: o.reverse === true,
    group: GROUPINGS.some((x) => x.key === o.group) ? (o.group as GroupKey) : DEFAULT_PREFS.group,
  };
}

/** Registry statuses that mean the intent is finished; archived counts with done. */
export const isDoneStatus = (s: string) => /^(done|complete|completed|closed|archived)$/i.test(s.trim());

/**
 * The bucket a card's status line falls in, in the card's own order (IntentStatus): waiting on you, then
 * client-side liveness (active decays to idle with `now`), then the registry's done/archived, then ended.
 * Parked intents count as idle (the card still says ⏸ parked).
 */
export function statusOf(i: IntentSummary, now: number): StatusKey {
  if (i.needs.length) return "waiting";
  const live = liveNow(i.liveness, i.lastEventTs, now);
  if (live === "active") return "active";
  if (/park/i.test(i.status)) return "idle";
  if (isDoneStatus(i.status)) return "done";
  return live === "ended" ? "ended" : "idle";
}

/** Case-insensitive substring over name, title, workspace label, current stage and unit (and stages waiting on you). */
export function matchesSearch(i: IntentSummary, wsLabel: string, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const hay = [i.name, i.title, wsLabel, i.current.stage, i.current.unit, ...i.needs.map((n) => n.stage)];
  return hay.some((h) => !!h && h.toLowerCase().includes(s));
}

export type Counts = Record<StatusKey, number>;
const zero = (): Counts => ({ waiting: 0, active: 0, idle: 0, ended: 0, done: 0 });

/** Chip counts: every intent matching the search, by bucket (the chips themselves do not narrow their counts). */
export function statusCounts(ws: WorkspaceSummary[], now: number, q: string): Counts {
  const c = zero();
  for (const w of ws) for (const i of w.intents) if (matchesSearch(i, w.label, q)) c[statusOf(i, now)]++;
  return c;
}

export interface Row { i: IntentSummary; w: WorkspaceSummary; status: StatusKey }
export interface ViewGroup {
  key: string; title: string;
  /** Set when the group is one status bucket (group by status). */
  status: StatusKey | null;
  /** Set when the group is one workspace (its learned strip, notes and origin belong to it). */
  ws: WorkspaceSummary | null;
  rows: Row[];
  /** Done/archived rows, shown under "Show N completed". Empty when the Done filter is selected (then they are in `rows`). */
  completed: Row[];
  /** Workspaces that could not be read (missing / partial / empty): rendered as error cards in this group. */
  errors: WorkspaceSummary[];
  counts: Counts;
  /** Intents in the group before any filter or search ("3 of 9 intents"). */
  total: number;
}
export interface HomeView {
  groups: ViewGroup[]; counts: Counts; visible: number;
  /** Problem workspaces (missing / partial / empty) matching the search but hidden because a status chip is on. */
  hiddenProblems: number;
}

const tsOf = (i: IntentSummary) => { const t = i.lastEventTs ? Date.parse(i.lastEventTs) : NaN; return Number.isFinite(t) ? t : -Infinity; };
const progress = (i: IntentSummary) => (i.plannedCount ? i.doneCount / i.plannedCount : 0);
const RANK: Record<StatusKey, number> = { waiting: 0, active: 1, idle: 2, ended: 2, done: 2 };
const byName = (a: Row, b: Row) => a.i.name.localeCompare(b.i.name, undefined, { numeric: true, sensitivity: "base" }) || a.w.label.localeCompare(b.w.label);

export function compareRows(sort: SortKey): (a: Row, b: Row) => number {
  switch (sort) {
    case "needs": return (a, b) => RANK[a.status] - RANK[b.status] || tsOf(b.i) - tsOf(a.i) || byName(a, b);
    case "recent": return (a, b) => tsOf(b.i) - tsOf(a.i) || byName(a, b);
    case "name": return byName;
    case "progress": return (a, b) => progress(b.i) - progress(a.i) || b.i.doneCount - a.i.doneCount || byName(a, b);
  }
}

/**
 * Filters, sorts and groups the Home intents. Group by workspace keeps the payload's workspace order; error
 * workspaces stay in their own group (by status/none they collect in a trailing "errors" group). Groups left
 * with nothing to show are dropped. Error cards are hidden while a status chip is on, or when the search does
 * not match the workspace label.
 */
export function buildHomeView(ws: WorkspaceSummary[], now: number, p: HomePrefs): HomeView {
  const filters = new Set(p.filters);
  const cmp = compareRows(p.sort);
  const ord = (a: Row, b: Row) => (p.reverse ? -cmp(a, b) : cmp(a, b));
  const keepDone = filters.has("done");
  const showErr = (w: WorkspaceSummary) => w.status !== "ok" && !filters.size && (!p.q.trim() || w.label.toLowerCase().includes(p.q.trim().toLowerCase()));

  const all: Row[] = ws.flatMap((w) => w.intents.map((i) => ({ i, w, status: statusOf(i, now) })));
  const shown = (r: Row) => (!filters.size || filters.has(r.status)) && matchesSearch(r.i, r.w.label, p.q);

  const make = (key: string, title: string, w: WorkspaceSummary | null, members: Row[], errors: WorkspaceSummary[], status: StatusKey | null = null): ViewGroup => {
    const vis = members.filter(shown).sort(ord);
    const counts = zero(); for (const r of vis) counts[r.status]++;
    return {
      key, title, status, ws: w, errors, counts, total: members.length,
      rows: keepDone ? vis : vis.filter((r) => r.status !== "done"),
      completed: keepDone ? [] : vis.filter((r) => r.status === "done"),
    };
  };

  let groups: ViewGroup[];
  if (p.group === "workspace") {
    groups = ws.map((w) => make(`ws:${w.path}`, w.label, w, all.filter((r) => r.w === w), showErr(w) ? [w] : []));
  } else {
    const errs = ws.filter(showErr);
    groups = p.group === "status"
      ? STATUS_KEYS.map((k) => make(`status:${k}`, STATUS_META[k].label, null, all.filter((r) => r.status === k), [], k))
      : [make("all", "All intents", null, all, [])];
    if (errs.length) groups.push(make("errors", "⚠ Workspaces that could not be read", null, [], errs));
  }
  groups = groups.filter((g) => g.rows.length || g.completed.length || g.errors.length);
  const counts = zero(); for (const r of all) if (matchesSearch(r.i, r.w.label, p.q)) counts[r.status]++;
  const q = p.q.trim().toLowerCase();
  const hiddenProblems = filters.size ? ws.filter((w) => w.status !== "ok" && (!q || w.label.toLowerCase().includes(q))).length : 0;
  return { groups, counts, visible: groups.reduce((n, g) => n + g.rows.length + g.completed.length, 0), hiddenProblems };
}

/** Above this many visible intents the AUTO view is the compact list. */
export const AUTO_COMPACT_ABOVE = 15;
export const resolveView = (pref: ViewKind | null, visible: number): ViewKind => pref ?? (visible > AUTO_COMPACT_ABOVE ? "compact" : "cards");

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const VIEW_KEY = "cc-home-view";
export function loadViewPref(s: Store): ViewKind | null {
  try { const v = s.getItem(VIEW_KEY); return v === "cards" || v === "compact" ? v : null; } catch { return null; }
}
/** `null` = back to AUTO. */
export function saveViewPref(s: Store, v: ViewKind | null): void {
  try { if (v) s.setItem(VIEW_KEY, v); else s.removeItem(VIEW_KEY); } catch { /* storage unavailable: the choice lasts this page only */ }
}
export const COLLAPSED_KEY = "cc-home-collapsed";
export function loadCollapsed(s: Store): Set<string> {
  try { const v = JSON.parse(s.getItem(COLLAPSED_KEY) ?? "[]"); return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []); } catch { return new Set(); }
}
export function saveCollapsed(s: Store, keys: Set<string>): void {
  try { if (keys.size) s.setItem(COLLAPSED_KEY, JSON.stringify([...keys])); else s.removeItem(COLLAPSED_KEY); } catch { /* best effort */ }
}

/** Past this many visible rows the compact list renders only the rows near the viewport. */
export const WINDOW_ABOVE = 100;
/**
 * Rows [start, end) to render for a list whose top is `offset` px above the viewport top (negative: below it),
 * with `overscan` extra rows either side.
 */
export function windowRange(offset: number, viewH: number, rowH: number, count: number, overscan = 8): { start: number; end: number } {
  const clamp = (n: number) => Math.max(0, Math.min(count, n));
  const end = clamp(Math.ceil((offset + viewH) / rowH) + overscan);
  const start = Math.min(clamp(Math.floor(offset / rowH) - overscan), end);
  return { start, end };
}
