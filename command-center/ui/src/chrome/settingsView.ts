// Pure view logic for Workspaces & settings (no React, no DOM): the rows and derived columns of the four tables,
// the config edits every action PUTs (add / remove / hide), and the shared sort and filter. Unit-tested in
// tests/settings.test.tsx. Nothing here guesses: a value the payload does not record is `null` and renders "—".
import type { RepoHost } from "../../../../core/command-center/server/repos";
import { repoHost, repoUrlProblem } from "../../../../core/command-center/server/repos";
import type { WorkspaceSummary } from "../../../../core/command-center/server/types";
import type { Config } from "../api";
import { tilde } from "../format";

/** The four tables; each one is also the `Config` array it edits. */
export type TableKey = "roots" | "pins" | "repos" | "hidden";
/** An Undo offer stays this long after a removal or a hide. */
export const UNDO_MS = 15_000;
/** A filter box appears in a table's header once it has more rows than this. */
export const FILTER_ABOVE = 8;
/** Trailing separators never change which folder a path means. */
export const norm = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
export const samePath = (a: string | null, b: string) => a !== null && norm(a) === norm(b);
/** True when `child` sits strictly below `parent`. */
export function isUnder(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  return c !== p && (c.startsWith(`${p}/`) || c.startsWith(`${p}\\`));
}
/** The last path segment, for naming a folder the payload did not label. */
export const baseName = (p: string) => norm(p).split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Status is always glyph + label + colour; `title` carries the detail (the problem the server reported). */
export interface StatusCell { glyph: string; label: string; cls: string; title?: string }
const WS_STATUS: Record<WorkspaceSummary["status"], StatusCell> = {
  ok: { glyph: "✓", label: "OK", cls: "ok" },
  partial: { glyph: "⚠", label: "partial", cls: "wait" },
  missing: { glyph: "⚠", label: "not found", cls: "wait" },
  empty: { glyph: "◌", label: "no intents yet", cls: "dim" },
};
/** How one workspace read, with whatever the server said about it as the detail. */
export const wsStatus = (w: WorkspaceSummary): StatusCell => ({ ...WS_STATUS[w.status], title: w.problem ?? undefined });
/** Before /api/home answers, every derived column is unknown — it is never filled in with a guess. */
const NOT_READ: StatusCell = { glyph: "·", label: "not read yet", cls: "faint", title: "The dashboard has not finished reading your workspaces." };
/** Every project a root found is hidden: that is not the same as finding nothing, and must not read like it. */
const allHidden = (n: number): StatusCell => ({
  glyph: "◌", label: `all ${n} hidden`, cls: "dim",
  title: "Every project found under this root is hidden. Bring one back from the Hidden table below.",
});
/** A root the dashboard has read and found nothing under: stated, never silently dropped. */
const NO_PROJECTS: StatusCell = { glyph: "◌", label: "no AIDLC projects found", cls: "dim", title: "Nothing with an aidlc/ folder under this root (searched 4 levels deep)." };
const HIDDEN: StatusCell = { glyph: "◌", label: "hidden", cls: "dim", title: "Hidden: left out of Home and of discovery. Unhide to see it again." };
/** The newest `lastEventTs` recorded by any intent of these workspaces; null when none records one. */
export function lastActivity(ws: WorkspaceSummary[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const w of ws) {
    for (const i of w.intents) {
      const t = i.lastEventTs ? Date.parse(i.lastEventTs) : NaN;
      if (Number.isFinite(t) && t > bestMs) { bestMs = t; best = i.lastEventTs; }
    }
  }
  return best;
}
export function pinStatus(loaded: boolean, hidden: boolean, w: WorkspaceSummary | null): StatusCell {
  if (hidden) return HIDDEN;
  if (!loaded) return NOT_READ;
  if (!w) return { glyph: "·", label: "not listed", cls: "faint", title: "Saved here, but the dashboard did not list it — another entry may already cover this folder." };
  return wsStatus(w);
}

/**
 * `owner/name` from a repo URL when its path has two or more segments; null when it has fewer (then the URL
 * column is the only honest answer). Azure DevOps' `org/project/_git/repo` reads as `project/repo`.
 */
export function repoOwnerName(url: string): string | null {
  const scp = /^git@[^\s:]+:(.*)$/.exec(url);
  let raw = scp?.[1] ?? "";
  if (!scp) { try { raw = new URL(url).pathname; } catch { return null; } }
  const segs = raw.split(/[\\/]/).filter(Boolean).map((s) => s.replace(/\.git$/i, ""));
  const g = segs.indexOf("_git");
  if (g > 0 && segs.length > g + 1) return `${segs[g - 1]}/${segs[g + 1]}`;
  if (segs.length < 2) return null;
  return `${segs[segs.length - 2]}/${segs[segs.length - 1]}`;
}

/** Which saved entry a hidden path came from: the deepest root or pin above it, the pin itself, or nothing. */
export type HiddenFrom = { kind: "root" | "pin"; path: string } | { kind: "self" } | null;
export function hiddenOrigin(path: string, c: Config): HiddenFrom {
  const under = [
    ...c.roots.map((p) => ({ kind: "root" as const, path: p })),
    ...c.pins.map((p) => ({ kind: "pin" as const, path: p })),
  ].filter((e) => isUnder(path, e.path)).sort((a, b) => norm(b.path).length - norm(a.path).length);
  if (under[0]) return under[0];
  return c.pins.some((p) => samePath(p, path)) ? { kind: "self" } : null;
}

export interface ProjectRow {
  /** The row's identity: the project's path, or `root:<path>` for a root with no project to show. */
  id: string;
  /** The discovery root that found this project (or the root that found nothing). */
  root: string;
  /** The discovered project; null for a root with none, and before the payload arrives. */
  ws: WorkspaceSummary | null;
  /** Folder name, path, intent count and newest activity — all null when there is no project. */
  name: string | null; path: string | null; intents: number | null; last: string | null;
  /** Hidden paths under this row's root: they are not in the payload, so they are counted from the config. */
  hiddenCount: number;
  status: StatusCell;
}
export interface PinRow {
  path: string; name: string; ws: WorkspaceSummary | null; hidden: boolean;
  intents: number | null; status: StatusCell; last: string | null;
}
export interface RepoRow { url: string; host: RepoHost; repo: string | null }
export interface HiddenRow { path: string; origin: HiddenFrom }

/**
 * One row per discovered project, in root order and then by project name, so the reader sees the projects
 * themselves rather than folders to open. A root with nothing under it keeps exactly one row, which says so.
 */
export function projectRows(c: Config, ws: WorkspaceSummary[], loaded: boolean): ProjectRow[] {
  const out: ProjectRow[] = [];
  for (const root of c.roots) {
    const hiddenCount = hiddenUnder(c, root).length;
    const found = ws.filter((w) => w.origin === "root" && samePath(w.root, root))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
    if (!found.length) {
      const status = !loaded ? NOT_READ : hiddenCount ? allHidden(hiddenCount) : NO_PROJECTS;
      out.push({ id: `root:${root}`, root, ws: null, name: null, path: null, intents: null, last: null, hiddenCount, status });
      continue;
    }
    for (const w of found) {
      out.push({ id: w.path, root, ws: w, name: w.label, path: w.path, intents: w.intents.length, last: lastActivity([w]), hiddenCount, status: wsStatus(w) });
    }
  }
  return out;
}
/**
 * The Root column's sort key: the root first, then the project inside it. Two keys, not one joined string — a
 * separator would be folded away by the locale comparison, and `/srv/a` would then sort against `/srv/ab` by
 * what follows it.
 */
export const rootSortKey = (r: ProjectRow): SortValue => [norm(r.root), r.name ?? ""];
/**
 * What a path cell matches on: the absolute path and the abbreviated form the cell shows, so a reader can filter
 * by either. "" when there is no path (the cell shows "—").
 */
export const pathText = (p: string | null) => (p ? (tilde(p) === p ? p : `${p} ${tilde(p)}`) : "");

export function pinRows(c: Config, ws: WorkspaceSummary[], loaded: boolean): PinRow[] {
  return c.pins.map((path) => {
    const w = ws.find((x) => samePath(x.path, path)) ?? null;
    const hidden = c.hidden.some((h) => samePath(h, path));
    return {
      path, hidden, ws: w,
      name: w?.label ?? baseName(path),
      intents: loaded && !hidden ? (w?.intents.length ?? 0) : null,
      status: pinStatus(loaded, hidden, w), last: lastActivity(w ? [w] : []),
    };
  });
}
export const repoRows = (c: Config): RepoRow[] => c.repos.map((url) => ({ url, host: repoHost(url), repo: repoOwnerName(url) }));
export const hiddenRows = (c: Config): HiddenRow[] => c.hidden.map((path) => ({ path, origin: hiddenOrigin(path, c) }));

/** The hidden paths at or under one root — what discovery left out of the payload. */
export const hiddenUnder = (c: Config, root: string) => c.hidden.filter((h) => samePath(h, root) || isUnder(h, root));

/** Paths of the projects discovered under these roots (what "Hide" means for a root row). */
export function projectsUnder(ws: WorkspaceSummary[], roots: string[]): string[] {
  return ws.filter((w) => w.origin === "root" && roots.some((r) => samePath(w.root, r))).map((w) => w.path);
}

const ABS = /^(\/|[A-Za-z]:[\\/])/;
/** Why `value` cannot be added, or null. Shape and duplicates only — whether a folder exists needs the server. */
export function addProblem(c: Config, k: TableKey, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (k === "repos") {
    const problem = repoUrlProblem(v);
    if (problem) return problem;
    // Normalised the same way removal is, so a URL that differs only by a trailing slash is the same repository.
    return c.repos.some((x) => norm(x) === norm(v)) ? "Already added" : null;
  }
  if (!ABS.test(v)) return "Use a full path starting with / (~ is not expanded), or Browse…";
  return c[k].some((x) => samePath(x, v)) ? "Already added" : null;
}
/** Appends to one list; the caller has already checked `addProblem`. */
export function addEntry(c: Config, k: "roots" | "pins" | "repos", value: string): Config {
  return { ...c, [k]: [...c[k], value.trim()] };
}
/**
 * Drops entries from one list. Removing roots or pins also forgets hidden paths that no remaining root or pin
 * watches any more, so the Hidden table never fills up with paths nothing can bring back. The argument is never
 * mutated, so Undo can PUT the previous config verbatim.
 */
export function removeEntries(c: Config, k: TableKey, values: string[]): Config {
  const gone = new Set(values.map(norm));
  const next = { ...c, [k]: c[k].filter((x) => !gone.has(norm(x))) };
  if (k !== "roots" && k !== "pins") return next;
  const covers = (list: string[], h: string) => list.some((e) => samePath(e, h) || isUnder(h, e));
  const kept = [...next.roots, ...next.pins];
  return { ...next, hidden: next.hidden.filter((h) => !covers(values, h) || covers(kept, h)) };
}
/** Adds paths to `hidden`, deduped, keeping the existing order. */
export function hideEntries(c: Config, values: string[]): Config {
  const out = [...c.hidden];
  for (const v of values) if (!out.some((x) => samePath(x, v))) out.push(v);
  return { ...c, hidden: out };
}
/** Locate…: the pin moves to `to` (deduped) and the old path leaves `hidden` too, so it is not left behind there. */
export function relocatePin(c: Config, from: string, to: string): Config {
  return { ...c, pins: c.pins.map((x) => (x === from ? to : x)).filter((x, i, a) => a.indexOf(x) === i), hidden: c.hidden.filter((x) => x !== from) };
}

/** One value per column, or several when a column sorts on more than one key (most significant first). */
export type SortValue = string | number | null | readonly (string | number)[];
const compareOne = (x: string | number, y: string | number) =>
  typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
/** Compares key by key; a shorter key list sorts first when the keys it has all match. */
function compareKeys(a: SortValue, b: SortValue): number {
  const xs = Array.isArray(a) ? a : [a as string | number];
  const ys = Array.isArray(b) ? b : [b as string | number];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const d = compareOne(xs[i]!, ys[i]!);
    if (d) return d;
  }
  return xs.length - ys.length;
}
/** Sorts a copy by one column. Rows whose value is unknown stay last in both directions. */
export function sortRows<T>(rows: T[], value: (r: T) => SortValue, reverse: boolean): T[] {
  const known: T[] = [];
  const unknown: T[] = [];
  for (const r of rows) (value(r) === null ? unknown : known).push(r);
  known.sort((a, b) => {
    const d = compareKeys(value(a), value(b));
    return reverse ? -d : d;
  });
  return [...known, ...unknown];
}
/** Case-insensitive substring over every column's text. */
export function filterRows<T>(rows: T[], q: string, text: (r: T) => (string | null)[]): T[] {
  const s = q.trim().toLowerCase();
  if (!s) return rows;
  return rows.filter((r) => text(r).some((t) => !!t && t.toLowerCase().includes(s)));
}

/**
 * Where a folder chosen in "Add a project folder" goes. A folder with its own `aidlc/` is one project (a pin);
 * anything else is watched as a folder of projects (a root), with the projects one level down counted for the
 * confirmation. Discovery searches deeper than one level, so `found: 0` is "none directly inside", not "none".
 */
export type Placement = { kind: "pins" } | { kind: "roots"; found: number };
export function placementFor(l: { entries: { name: string; isAidlc: boolean }[] }): Placement {
  if (l.entries.some((e) => e.name === "aidlc")) return { kind: "pins" };
  return { kind: "roots", found: l.entries.filter((e) => e.isAidlc).length };
}
/**
 * Why a folder cannot be added in "Add a project folder", or null: the path's shape, an exact duplicate in either
 * list, or a folder an existing root already watches (it would only be listed twice).
 */
export function addFolderProblem(c: Config, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!ABS.test(v)) return "Use a full path starting with / (~ is not expanded), or Choose a folder…";
  if (c.roots.some((x) => samePath(x, v)) || c.pins.some((x) => samePath(x, v))) return "Already added";
  const root = c.roots.find((r) => isUnder(v, r));
  return root ? `Already watched — it is inside ${tilde(root)}` : null;
}
/** The confirmation after an add, e.g. "~/work added — 3 AIDLC projects found inside." */
export function addedText(path: string, p: Placement): string {
  if (p.kind === "pins") return `${baseName(path)} added as a project.`;
  const n = p.found;
  return n
    ? `${tilde(path)} added — ${n} AIDLC ${n === 1 ? "project" : "projects"} found inside.`
    : `${tilde(path)} added — no AIDLC projects directly inside yet; projects deeper down and new ones appear automatically.`;
}
