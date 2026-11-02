import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { WorkspaceSummary } from "../../../../core/command-center/server/types";
import type { Config } from "../api";
import { intentHash, tilde } from "../format";
import { useLiveClock, useLiveCtx } from "../useLive";
import { CompactList } from "./CompactList";
import { HomeToolbar } from "./HomeToolbar";
import {
  buildHomeView, type HomePrefs, loadCollapsed, loadViewPref, resolveView, type Row, sanitizePrefs, saveCollapsed, saveViewPref,
  type SortKey, STATUS_KEYS, STATUS_META, type ViewGroup, type ViewKind, WINDOW_ABOVE,
} from "./homeView";
import { IntentCard } from "./IntentCard";
import { NeedsStrip } from "./NeedsStrip";

interface Props { config: Config | null; saveConfig: (c: Config) => Promise<boolean> }

const PREFS_KEY = "cc-home-prefs";
/** Filters, search, sort and grouping last for the browser tab (so opening an intent and coming back keeps them). */
function loadPrefs(): HomePrefs {
  try { return sanitizePrefs(JSON.parse(sessionStorage.getItem(PREFS_KEY) ?? "null")); } catch { return sanitizePrefs(null); }
}

export function Home({ config, saveConfig }: Props) {
  const { home, watchModes } = useLiveCtx();
  const { now, frozen } = useLiveClock();
  const [prefs, setPrefsState] = useState<HomePrefs>(loadPrefs);
  const [viewPref, setViewPrefState] = useState<ViewKind | null>(() => loadViewPref(localStorage));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(localStorage));
  const [openDone, setOpenDone] = useState<Set<string>>(new Set());
  useEffect(() => { try { sessionStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* best effort */ } }, [prefs]);

  // The view is recomputed at most every second (the live clock) — cheap even for hundreds of intents.
  const view = useMemo(() => (home ? buildHomeView(home.workspaces, now, prefs) : null), [home, now, prefs]);
  if (!home || !view) return <div className="panel dim">Loading workspaces…</div>;

  const total = home.workspaces.reduce((n, w) => n + w.intents.length, 0);
  const kind = resolveView(viewPref, view.visible);
  const setViewPref = (v: ViewKind | null) => { saveViewPref(localStorage, v); setViewPrefState(v); };
  const flip = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
  const toggleGroup = (k: string) => setCollapsed((c) => { const n = flip(c, k); saveCollapsed(localStorage, n); return n; });
  const onSort = (k: SortKey) => setPrefsState((p) => (p.sort === k ? { ...p, reverse: !p.reverse } : { ...p, sort: k, reverse: false }));
  const polling = (ws: string) => watchModes[ws] === "poll";
  const windowed = kind === "compact" && view.visible > WINDOW_ABOVE;

  const roots = new Map<string, number>();
  for (const w of home.workspaces) if (w.origin === "root") roots.set(w.root ?? "", (roots.get(w.root ?? "") ?? 0) + 1);
  const pinned = home.workspaces.filter((w) => w.origin === "pin").length;
  const emptyRoots = (config?.roots ?? []).filter((r) => !roots.has(r));

  const body = (rows: Row[]) => kind === "compact"
    ? <CompactList rows={rows} now={now} frozen={frozen} windowed={windowed} sort={prefs.sort} reverse={prefs.reverse} onSort={onSort} polling={polling} showWs={prefs.group !== "workspace"} />
    : <div className="cards">{rows.map(({ i, w }) => <IntentCard key={`${w.path}::${i.key}`} i={i} now={now} frozen={frozen} polling={polling(w.path)} fix={home?.health?.byIntent[`${w.path}::${i.key}`] ?? 0} />)}</div>;

  return (
    <>
      <NeedsStrip needs={home.needs} now={now} frozen={frozen} />
      {total > 0 && (
        <HomeToolbar prefs={prefs} setPrefs={setPrefsState} counts={view.counts} visible={view.visible} total={total}
          view={kind} viewPref={viewPref} setViewPref={setViewPref}
          hiddenProblems={view.hiddenProblems} onClearFilters={() => setPrefsState({ ...prefs, filters: [] })} />
      )}
      {(roots.size > 0 || pinned > 0) && (
        <div className="wsroots dim">
          {[...roots.entries()].map(([r, n]) => <span key={r}>Discovered under <span className="mono" title={r}>{tilde(r)}</span> · {n} workspace{n === 1 ? "" : "s"} · watching for new ones</span>)}
          {pinned > 0 && <span>Pinned · {pinned} workspace{pinned === 1 ? "" : "s"}</span>}
        </div>
      )}
      {emptyRoots.map((r) => (
        <div className="ws" key={`e:${r}`}>
          <div className="wshead"><div><span className="lbl" style={{ display: "inline" }}>Discovered under</span> <span className="mono" title={r}>{tilde(r)}</span></div><span className="dim" style={{ fontSize: ".85rem" }}>0 workspaces · watching for new ones</span></div>
          <div className="dim" style={{ fontSize: ".9rem" }}>No <span className="mono">aidlc/</span> projects found under this folder yet.</div>
        </div>
      ))}
      {view.groups.map((g) => (
        <Group key={g.key} g={g} collapsed={collapsed.has(g.key)} onToggle={() => toggleGroup(g.key)}
          doneOpen={openDone.has(g.key)} onToggleDone={() => setOpenDone((s) => flip(s, g.key))}
          body={body} polling={polling} config={config} saveConfig={saveConfig} />
      ))}
      {total > 0 && view.groups.length === 0 && (
        <div className="panel dim">No intents match these filters. <button type="button" className="linkbtn" onClick={() => setPrefsState({ ...prefs, filters: [], q: "" })}>Clear filters</button></div>
      )}
      {home.workspaces.length === 0 && !emptyRoots.length && (
        <div className="panel dim">No workspaces are being watched. Open <b>Workspaces</b> to add a folder.</div>
      )}
    </>
  );
}

const SEP = "\u00a0· ";
const PROBLEM = { missing: "⚠ folder not found", partial: "⚠ partial", empty: "○ no intents yet", ok: "" } as const;
/** "workspace-a · 6 intents · 1 waiting · 2 active" — only the statuses present, in urgency order. */
function GroupSummary({ g }: { g: ViewGroup }) {
  const shown = g.rows.length + g.completed.length;
  const label = { waiting: "waiting", active: "active", idle: "idle", ended: "ended", done: "done" } as const;
  const cls = { waiting: "wait", active: "run", idle: "dim", ended: "dim", done: "ok" } as const;
  return (
    <>
      {g.total > 0 && <span className="dim">{SEP}{shown === g.total ? `${g.total} intent${g.total === 1 ? "" : "s"}` : `${shown} of ${g.total} intents`}</span>}
      {!g.status && STATUS_KEYS.filter((k) => g.counts[k]).map((k) => <span key={k} className={cls[k]}>{SEP}{g.counts[k]} {label[k]}</span>)}
    </>
  );
}

function Group({ g, collapsed, onToggle, doneOpen, onToggleDone, body, polling, config, saveConfig }: {
  g: ViewGroup; collapsed: boolean; onToggle: () => void; doneOpen: boolean; onToggleDone: () => void;
  body: (rows: Row[]) => ReactNode; polling: (ws: string) => boolean; config: Config | null; saveConfig: Props["saveConfig"];
}) {
  const w = g.ws;
  const origin = w ? (w.origin === "pin" ? "pinned" : `under ${tilde(w.root ?? "")}`) : null;
  const errs = g.errors.map((e) => <ErrorCard key={`err:${e.path}`} w={e} config={config} saveConfig={saveConfig} />);
  const showLearned = w && w.status === "ok" && w.intents.length > 0;
  return (
    <section className={`ws hgroup${collapsed ? " closed" : ""}`} aria-label={g.title}>
      <div className="wshead">
        <button type="button" className="ghead" aria-expanded={!collapsed} onClick={onToggle}>
          <span className="caret" aria-hidden>{collapsed ? "▸" : "▾"}</span>
          {g.status && <span className={`${STATUS_META[g.status].cls} gglyph`} aria-hidden>{STATUS_META[g.status].glyph}</span>}<b>{g.title}</b><GroupSummary g={g} />
          {w && w.status !== "ok" && <span className={w.status === "empty" ? "dim" : "wait"}>{SEP}{PROBLEM[w.status]}</span>}
        </button>
        {origin && <span className="dim" style={{ fontSize: ".85rem" }} title={w!.path}>{w && polling(w.path) ? "polling every 10 s · " : ""}{origin}</span>}
      </div>
      {!collapsed && (
        <>
          {g.rows.length > 0 && body(g.rows)}
          {errs.length > 0 && <div className="cards" style={{ marginTop: g.rows.length ? 12 : 0 }}>{errs}</div>}
          {g.completed.length > 0 && (
            <>
              <button type="button" className="showdone" aria-expanded={doneOpen} onClick={onToggleDone}>
                <span aria-hidden>{doneOpen ? "▾" : "▸"}</span> {doneOpen ? "Hide" : "Show"} {g.completed.length} completed <span className="ok" aria-hidden>✓</span>
              </button>
              {doneOpen && body(g.completed)}
            </>
          )}
          {w && w.status === "ok" && w.problem && <div className="warn">⚠ {w.label}: {w.problem}</div>}
          {showLearned && <Learned w={w} />}
        </>
      )}
    </section>
  );
}

function Learned({ w }: { w: WorkspaceSummary }) {
  const first = w.intents[0]!;
  return (
    <div className="learned">
      <span className="pur" style={{ fontSize: "1.2rem" }}>✦</span>
      <span className="grow">
        <b>What AIDLC has learned in {w.label}:</b>{" "}
        {w.rulesLearned
          ? <>{w.rulesLearned} rule{w.rulesLearned === 1 ? "" : "s"} in this space's memory{w.sampleRule && <> — e.g. “{w.sampleRule}”</>}</>
          : <span className="dim">no rules recorded yet — rules appear here once a stage's learnings are kept.</span>}
      </span>
      {w.rulesLearned > 0 && <a href={intentHash(w.path, first.key, "learnings")}>see all →</a>}
    </div>
  );
}

function ErrorCard({ w, config, saveConfig }: { w: WorkspaceSummary; config: Config | null; saveConfig: Props["saveConfig"] }) {
  const hide = () => config && saveConfig({ ...config, hidden: [...new Set([...config.hidden, w.path])] });
  const remove = () => config && saveConfig({ ...config, pins: config.pins.filter((p) => p !== w.path) });
  const locate = () => {
    if (!config) return;
    const p = prompt(`Where is ${w.label} now? Enter the full folder path:`, w.path)?.trim();
    if (!p || p === w.path) return;
    void saveConfig({ ...config, pins: [...new Set(config.pins.map((x) => (x === w.path ? p : x)))] });
  };
  const status = w.status === "missing" ? "⚠ Folder not found" : w.status === "partial" ? "⚠ Partial" : null;
  return (
    <div className="card err">
      <div className="row between"><h3 className="dim">{w.label}</h3>{status ? <span className="wait">{status}</span> : <span className="dim">○ no intents</span>}</div>
      <div className="mono dim" style={{ margin: "6px 0", overflowWrap: "anywhere" }} title={w.path}>{tilde(w.path)}</div>
      {w.status === "empty" && <div className="dim" style={{ fontSize: ".9rem" }}>Initialized, no intents yet</div>}
      {w.status === "partial" && <div className="dim" style={{ fontSize: ".9rem" }}>{w.problem}</div>}
      {w.status === "missing" && (
        <div className="row">
          {w.origin === "pin" && <button className="btn ghost" type="button" onClick={locate}>Locate…</button>}
          <button className="btn ghost" type="button" onClick={hide}>Hide</button>
          {w.origin === "pin" && <button className="btn ghost" type="button" onClick={remove}>Remove</button>}
        </div>
      )}
    </div>
  );
}
