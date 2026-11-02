// The issue log: a filterable list of recorded issues (newest first) beside a detail panel with the original message,
// the cause AIDLC recorded, the remedy, the resolution and the exact source lines. Shared by the Health page (every
// workspace) and an intent's Issues tab. Read-only: CSV and the text report are built in the browser.
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { GROUP_META, type IssueGroup, type Recoverable, type ScopedIssue, type SupportingFile, GROUPS, shortPhase } from "../../../../core/command-center/server/hooks-map";
import { get, q } from "../api";
import {
  type AnyIssue, applyFilter, baseFilter, type Chip, chipCounts, issuesCsv, issuesReport, issueText, type LogFilter, NO_FILTER, type Range, sortByRecorded,
  STATE_META, type StateFilter, stateOf, subOf, titleOf, wsLabel,
} from "./issueReport";

export const REC: Record<Recoverable, { g: string; label: string; cls: string; title: string }> = {
  yes: { g: "↻", label: "Recovers", cls: "ok", title: "AIDLC or the agent recovers from this on its own" },
  "needs-you": { g: "◆", label: "Needs you", cls: "wait", title: "A person has to act before this is fixed" },
  no: { g: "✗", label: "Not recoverable", cls: "bad", title: "What was lost cannot be recovered" },
};
const RANGES: [Range, string][] = [["24h", "Last 24 h"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["all", "All time"]];
const STATES: [StateFilter, string][] = [["all", "All states"], ["open", "Open"], ["resolved", "Resolved"], ["accepted", "Accepted at gate"]];
const p2 = (n: number) => String(n).padStart(2, "0");
const dOf = (iso: string) => new Date(iso);
const okDate = (iso: string | null | undefined): iso is string => !!iso && !Number.isNaN(Date.parse(iso));
export const fmtDay = (iso: string) => dOf(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const fmtHm = (iso: string) => { const d = dOf(iso); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; };
const tzName = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"; } catch { return "local time"; } };

export function GroupChip({ g }: { g: IssueGroup }) {
  const m = GROUP_META[g];
  return <span className={`chip il-g il-g-${g}`} title={g === "accepted" ? "A non-blocking check that still failed (or did not run) when its stage passed its gate" : undefined}><span aria-hidden>{m.glyph}</span> {m.label}</span>;
}
export function StateChip({ i }: { i: AnyIssue }) {
  const s = STATE_META[stateOf(i)];
  return <span className={`chip il-st ${s.cls}`} title={i.resolved ? `Resolved by ${i.resolved.by}${i.resolved.at ? ` at ${i.resolved.at}` : ""}` : s.title}><span aria-hidden>{s.glyph}</span> {s.label}</span>;
}
/** Verbatim text with code-like spans (backticks, UPPER_SNAKE codes, paths, flags) in monospace. */
export function Verbatim({ text }: { text: string }) {
  // Paths need a leading `/` or `./` or a file extension (so "and/or" stays prose), and keep their `:line[:col]`.
  const parts: ReactNode[] = []; const re = /`([^`\n]+)`|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\bE[A-Z]{3,}\b|(?:(?<![\w.])(?:\.{1,2})?\/[\w.-]+(?:\/[\w.-]+)*|[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z][\w]*)(?::\d+(?::\d+)?)?|--[a-z][\w-]*/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<code key={k++}>{m[1] ?? m[0]}</code>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
/** The remedy with its source: AIDLC's own text, or the dashboard's documented hint. */
export function Remedy({ fix }: { fix: AnyIssue["fix"] }) {
  if (!fix) return <span className="faint" title="AIDLC records no remedy for this and there is no documented hint">— No remedy recorded.</span>;
  return <span><span className={`chip hl-fix ${fix.source}`} title={fix.source === "aidlc" ? "AIDLC's own remedy text" : "A short documented hint from the dashboard, not AIDLC's words"}>{fix.source === "aidlc" ? "AIDLC" : "Hint"}</span> <Verbatim text={fix.text} /></span>;
}

async function copyText(s: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(s); return true; } catch { /* fall back */ }
  try {
    const t = document.createElement("textarea"); t.value = s; t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select(); const ok = document.execCommand("copy"); t.remove(); return ok;
  } catch { return false; }
}
function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface FileView { path: string; body: string; truncated: boolean; size: number }
/** A read-only, line-numbered view of one workspace file (from `/api/file`), scrolled to `line`. */
export function FileViewer({ ws, path, line, onClose }: { ws: string; path: string; line: number | null; onClose: () => void }) {
  const [st, setSt] = useState<{ f: FileView | null; err: string | null }>({ f: null, err: null });
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let off = false;
    get<FileView>(`/api/file?${q({ ws, path })}`).then((f) => { if (!off) setSt({ f, err: null }); })
      .catch((e: Error) => { if (!off) setSt({ f: null, err: /^404/.test(e.message) ? "This file is not readable here (gone, not text, or outside the workspace's aidlc folder)." : e.message }); });
    return () => { off = true; };
  }, [ws, path]);
  useEffect(() => { if (st.f && line) box.current?.querySelector(`[data-line="${line}"]`)?.scrollIntoView?.({ block: "center" }); }, [st.f, line]);
  useEffect(() => { const k = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }; addEventListener("keydown", k, true); return () => removeEventListener("keydown", k, true); }, [onClose]);
  const lines = st.f?.body.replace(/\n$/, "").split("\n") ?? [];
  return (
    <div className="modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dlg il-viewer" role="dialog" aria-modal="true" aria-label={`Read-only view of ${path}`}>
        <div className="row between"><b className="mono" style={{ overflowWrap: "anywhere" }}>{path}</b><button type="button" className="iconbtn" onClick={onClose} aria-label="Close the file view">Close</button></div>
        <div className="faint" style={{ fontSize: ".8rem", margin: "2px 0 8px" }}>Read-only{line ? ` · line ${line}` : ""}{st.f ? ` · ${st.f.size} bytes` : ""}</div>
        <div className="il-code il-viewbody" ref={box}>
          {st.err ? <div className="dim" style={{ padding: 8 }}>{st.err}</div> : !st.f ? <div className="dim" style={{ padding: 8 }}>Loading…</div>
            : lines.map((l, k) => <div key={k} data-line={k + 1} className={`il-ln${k + 1 === line ? " il-focus" : ""}`}><span className="il-no">{k + 1}</span><span className="il-tx">{l || " "}</span></div>)}
        </div>
        {st.f?.truncated && <div className="warn">Showing the first 1 MB of this file.</div>}
      </div>
    </div>
  );
}

const Fact = ({ k, children }: { k: string; children: ReactNode }) => <div className="il-fact"><div className="il-k">{k}</div><div className="il-v">{children}</div></div>;

/** The detail panel for one issue. `onIntent`: opens the intent at this issue (Health page only). */
export function IssueDetail({ i, index, total, onStep, onIntent, showWorkspace, onView }: {
  i: AnyIssue; index: number; total: number; onStep: (d: -1 | 1) => void; onIntent?: (i: ScopedIssue) => void; showWorkspace: boolean;
  onView: (path: string, line: number | null) => void;
}) {
  const s = i as ScopedIssue; const r = REC[i.recoverable]; const w = i.where;
  const [copied, setCopied] = useState<string | null>(null);
  const su = [w.stage, w.unit].filter(Boolean).join(" · ");
  const ev = i.evidence ?? null;
  const span = i.at ? (i.firstAt && i.firstAt !== i.at && okDate(i.firstAt) && okDate(i.at)
    ? (fmtDay(i.firstAt) === fmtDay(i.at) ? `${fmtDay(i.at)} · ${fmtHm(i.firstAt)}–${fmtHm(i.at)}` : `${fmtDay(i.firstAt)} ${fmtHm(i.firstAt)} – ${fmtDay(i.at)} ${fmtHm(i.at)}`)
    : okDate(i.at) ? `${fmtDay(i.at)} · ${fmtHm(i.at)}` : i.at) : null;
  return (
    <div className="panel il-detail" data-issue={i.id} aria-label="Issue detail">
      <div className="row between">
        <span className="row" style={{ gap: 6 }}><GroupChip g={i.group} /><StateChip i={i} /></span>
        <span className="row dim il-step" style={{ gap: 4 }}>
          <button type="button" className="iconbtn" aria-label="Previous entry" disabled={index <= 0} onClick={() => onStep(-1)}>←</button>
          <span>Entry {index + 1} of {total}</span>
          <button type="button" className="iconbtn" aria-label="Next entry" disabled={index >= total - 1} onClick={() => onStep(1)}>→</button>
        </span>
      </div>
      <h3 className="il-title">{titleOf(i)}</h3>
      <div className="il-facts">
        {showWorkspace && <Fact k="Workspace"><span title={s.workspace}>{s.workspace ? wsLabel(s.workspace) : "—"}</span></Fact>}
        <Fact k="Intent">{s.intentKey ? (onIntent ? <button type="button" className="linkbtn" onClick={() => onIntent(s)} title="Open this intent's Issues tab at this entry">{s.intentName} ↗</button> : <span>{s.intentName}</span>)
          : <span className="faint" title="A workspace-level record: it belongs to no single intent">— workspace level</span>}</Fact>
        <Fact k="Stage / unit">{su ? <span className={w.inferred ? "hl-inferred" : undefined} title={w.inferred ?? undefined}>{su}{w.inferred ? <span className="faint"> · inferred</span> : null}</span>
          : w.inferred ? <span className="hl-inferred faint" title={w.inferred}>inferred</span> : <span className="faint" title="The record names no stage or unit">—</span>}</Fact>
        {w.hook ? <Fact k="Hook / phase"><span className="mono">{w.hook}{w.hookPhase ? ` · ${shortPhase(w.hookPhase)}` : ""}</span>{w.tool ? <span className="mono dim"> · {w.tool}</span> : null}</Fact>
          : <Fact k="Tool">{w.tool ? <span className="mono">{w.tool}</span> : <span className="faint" title="The record names no hook or tool">—</span>}</Fact>}
      </div>
      <div className="il-sec">Original message</div>
      <div className="il-msg"><Verbatim text={i.message} /></div>
      {i.detail && <div className="dim il-note"><Verbatim text={i.detail} /></div>}
      <div className="il-stats">
        <Fact k="Recorded count"><b>{i.count} occurrence{i.count === 1 ? "" : "s"}</b></Fact>
        <Fact k="First / last recorded">{span ? <b title={`${i.firstAt ? `first ${i.firstAt} · ` : ""}last ${i.at}`}>{span}</b> : <span className="faint" title="The record has no timestamp">—</span>}</Fact>
        <Fact k="Recoverability"><b className={r.cls} title={r.title}><span aria-hidden>{r.g}</span> {r.label}</b></Fact>
      </div>
      <div className="il-cause">
        <div className="il-sec">Cause (from the records) {i.cause && <span className="chip hl-fix aidlc" title="Built from AIDLC's records">AIDLC</span>}</div>
        {i.cause ? <>
          <div><Verbatim text={i.cause.summary} /></div>
          {i.cause.points.length > 0 && <dl className="il-points">{i.cause.points.map((p, k) => <div key={k}><dt>{p.label}</dt><dd><Verbatim text={p.value} /></dd></div>)}</dl>}
        </> : <div className="faint">No cause recorded — AIDLC wrote only the message above.</div>}
      </div>
      <div className="il-remedy"><div className="il-sec">Recorded remedy</div><Remedy fix={i.fix} /></div>
      <div className="il-resolution"><b>Resolution</b> {i.resolved ? <span className="ok">✓ Resolved by {i.resolved.by}{i.resolved.at ? ` at ${okDate(i.resolved.at) ? `${fmtDay(i.resolved.at)} ${fmtHm(i.resolved.at)}` : i.resolved.at}` : ""}</span> : <span className="dim">No resolution recorded.</span>}</div>
      <div className="il-evidence">
        <div className="il-evhead row between">
          <b>Source evidence</b>
          {ev ? <button type="button" className="linkbtn" onClick={() => onView(ev.auditFile, ev.focusLine ?? ev.startLine)} title={`Open ${ev.auditFile} read-only at line ${ev.focusLine ?? ev.startLine}`}>Open audit file ↗</button>
            : <span className="mono faint" style={{ fontSize: ".78rem" }} title="This record is not inside the workspace's aidlc folder, so it is not opened here">{i.source.file}{i.source.line ? `:${i.source.line}` : ""}</span>}
        </div>
        {ev ? <>
          <div className="mono faint il-evfile">{ev.auditFile}</div>
          <div className="il-code">{ev.lines.map((l, k) => { const n = ev.startLine + k; return <div key={n} className={`il-ln${n === ev.focusLine ? " il-focus" : ""}`}><span className="il-no">{n}</span><span className="il-tx">{l || " "}</span></div>; })}</div>
          {ev.supporting.map((f: SupportingFile) => (
            <div key={f.path} className="il-support row">
              <span aria-hidden className="faint">▤</span>
              <div className="grow" style={{ minWidth: 0 }}><div className="mono" style={{ overflowWrap: "anywhere" }}>{f.path.split("/").at(-1)}</div><div className="faint" style={{ fontSize: ".8rem" }}>Supporting file · {f.label}</div></div>
              <button type="button" className="linkbtn" onClick={() => onView(f.path, null)} title={f.path}>View file →</button>
            </div>
          ))}
        </> : <div className="faint" style={{ padding: "6px 10px" }}>No record lines are available for this entry.</div>}
      </div>
      <div className="il-foot row between">
        <span className="mono faint" style={{ overflowWrap: "anywhere" }} title="The record this entry was read from">{i.source.file}{i.source.line ? `:${i.source.line}` : ""}</span>
        <span className="row" style={{ gap: 6 }}>{copied && <span className="faint" role="status">{copied}</span>}
          <button type="button" className="btn ghost" onClick={async () => setCopied((await copyText(issueText(i))) ? "Copied" : "Could not copy")}>Copy this issue</button></span>
      </div>
    </div>
  );
}

/**
 * Toolbar, group chips, the list and the detail panel. `scoped` (the Health page): rows carry their workspace and
 * intent, the toolbar has a Workspace filter, and Enter or the Intent link opens the intent at the entry.
 */
export function IssueLog({ issues, scoped, now, initial, onOpen, title, subtitle, wsOptions = [] }: {
  issues: AnyIssue[]; scoped: boolean; now: number; initial?: string | null; onOpen?: (i: ScopedIssue) => void;
  title: string; subtitle: ReactNode; wsOptions?: string[];
}) {
  const [f, setF] = useState<LogFilter>(NO_FILTER);
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const [cur, setCur] = useState<string | null>(initial ?? null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState<string | null>(null);
  const [view, setView] = useState<{ path: string; line: number | null } | null>(null);
  const list = useRef<HTMLDivElement>(null); const all = useRef<HTMLInputElement>(null);
  useEffect(() => { if (initial) { setCur(initial); setF(NO_FILTER); } }, [initial]);
  const base = useMemo(() => baseFilter(issues, f, now), [issues, f, now]);
  const counts = useMemo(() => chipCounts(base), [base]);
  const shown = useMemo(() => sortByRecorded(applyFilter(issues, f, now), dir), [issues, f, now, dir]);
  const idx = Math.max(0, shown.findIndex((i) => i.id === cur));
  const sel = shown[idx] ?? null;
  const occ = shown.reduce((a, i) => a + i.count, 0);
  const nChecked = shown.filter((i) => checked.has(i.id)).length;
  useEffect(() => { if (all.current) all.current.indeterminate = nChecked > 0 && nChecked < shown.length; }, [nChecked, shown.length]);
  useEffect(() => { list.current?.querySelector(`[data-row="${sel?.id}"]`)?.scrollIntoView?.({ block: "nearest" }); }, [sel?.id]);
  const set = (p: Partial<LogFilter>) => setF((x) => ({ ...x, ...p }));
  const step = (d: number) => { const n = shown[Math.min(shown.length - 1, Math.max(0, idx + d))]; if (n) setCur(n.id); };
  const toggle = (id: string) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const picked = () => (nChecked ? shown.filter((i) => checked.has(i.id)) : shown);
  const flash = (s: string) => { setNote(s); setTimeout(() => setNote(null), 2500); };
  const onKey = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement; const tag = t.tagName;
    if ((tag === "INPUT" && (t as HTMLInputElement).type !== "checkbox") || tag === "SELECT" || tag === "TEXTAREA" || view) return;
    const rowBtn = t.classList.contains("hl-rowbtn");
    if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); step(1); }
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "Escape") { e.preventDefault(); setChecked(new Set()); }
    else if (e.key === "Enter" && (rowBtn || (tag !== "BUTTON" && tag !== "A")) && sel && onOpen && (sel as ScopedIssue).intentKey) { e.preventDefault(); onOpen(sel as ScopedIssue); }
    else if (e.key === " " && tag !== "BUTTON" && tag !== "INPUT" && sel) { e.preventDefault(); toggle(sel.id); }
  };
  const chips: [Chip, string, string][] = [["all", "", "All"], ...GROUPS.map((g): [Chip, string, string] => [g, GROUP_META[g].glyph, GROUP_META[g].label]), ["resolved", "✓", "Resolved"]];
  const wsName = (ws: string) => wsLabel(ws);
  return (
    <div className="il" onKeyDown={onKey}>
      <div className="row between il-head">
        <div><h2 style={{ margin: 0 }}>{title}</h2><div className="dim" style={{ fontSize: ".92rem" }}>{subtitle}</div></div>
        <div className="row" style={{ gap: 8 }}>
          {note && <span className="faint" role="status">{note}</span>}
          <button type="button" className="btn ghost" onClick={() => { const n = picked(); download(`aidlc-issues-${new Date(now).toISOString().slice(0, 10)}.csv`, issuesCsv(n)); flash(`CSV of ${n.length} entr${n.length === 1 ? "y" : "ies"}`); }} title={nChecked ? "The selected entries as CSV" : "Every visible entry as CSV"}>⤓ Download CSV</button>
          <button type="button" className="btn" onClick={async () => { const n = picked(); flash((await copyText(issuesReport(n, new Date(now).toISOString()))) ? `Copied ${n.length} entr${n.length === 1 ? "y" : "ies"}` : "Could not copy"); }} title={nChecked ? "The selected entries as a plain-text report" : "Every visible entry as a plain-text report"}>⧉ Copy report</button>
        </div>
      </div>
      <div className="panel il-toolbar">
        <label className="il-field il-q"><span>Find an issue</span><input type="search" value={f.q} placeholder="Search the recorded message, kind, stage, unit, hook or tool…" onChange={(e) => set({ q: e.target.value })} aria-label="Find an issue" /></label>
        <label className="il-field"><span>Time range</span><select value={f.range} onChange={(e) => set({ range: e.target.value as Range })} aria-label="Time range">{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        {scoped && <label className="il-field"><span>Workspace</span><select value={f.ws} onChange={(e) => set({ ws: e.target.value })} aria-label="Workspace">
          <option value="">All workspaces</option>{wsOptions.map((w) => <option key={w} value={w}>{wsName(w)}</option>)}</select></label>}
        <label className="il-field"><span>State</span><select value={f.state} onChange={(e) => set({ state: e.target.value as StateFilter })} aria-label="State">{STATES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
      </div>
      <div className="row il-chips" role="group" aria-label="Filter by group">
        {chips.map(([c, g, l]) => (
          <button key={c} type="button" className={`chip clk il-chip il-chip-${c}${f.chip === c ? " on" : ""}`} aria-pressed={f.chip === c} onClick={() => set({ chip: f.chip === c && c !== "all" ? "all" : c })}
            title={c === "all" ? "Every entry in these filters" : c === "resolved" ? "Entries a later record shows resolved" : `Unresolved ${l.toLowerCase()} entries`}>
            {g && <span aria-hidden>{g}</span>} {l} <b>{counts[c]}</b>
          </button>
        ))}
        <span className="grow" />
        <span className="dim">{shown.length} entr{shown.length === 1 ? "y" : "ies"} · {occ} recorded occurrence{occ === 1 ? "" : "s"}</span>
      </div>
      <div className="il-body">
        <div className="panel il-list" ref={list} tabIndex={0} aria-label="Recorded issues: arrow keys move between entries">
          <div className="row between il-listhead">
            <span><b>Recorded issues</b> <span className="dim">· {dir === "desc" ? "newest first" : "oldest first"}</span></span>
            {nChecked > 0 && <span className="row" style={{ gap: 8 }}><span className="run">{nChecked} selected</span><span className="faint">|</span><button type="button" className="linkbtn" onClick={() => setChecked(new Set())}>Clear</button></span>}
          </div>
          {!shown.length ? <div className="dim il-empty">No issues match these filters.</div> : (
            <table className="il-table">
              <thead><tr>
                <th className="il-ck"><input ref={all} type="checkbox" aria-label="Select every visible entry" checked={nChecked > 0 && nChecked === shown.length} onChange={() => setChecked(nChecked === shown.length ? new Set() : new Set(shown.map((i) => i.id)))} /></th>
                <th aria-sort={dir === "desc" ? "descending" : "ascending"}><button type="button" className="linkbtn il-sort" onClick={() => setDir((d) => (d === "desc" ? "asc" : "desc"))} title="Sort by when it was recorded">Recorded {dir === "desc" ? "↓" : "↑"}</button></th>
                <th>Issue</th><th>{scoped ? "Workspace / intent" : "Stage"}</th><th className="il-statecol">State</th><th className="il-n">Count</th>
              </tr></thead>
              <tbody>
                {shown.map((i) => {
                  const s = i as ScopedIssue; const on = i.id === sel?.id;
                  return (
                    <tr key={i.id} data-row={i.id} className={`clk${on ? " il-on" : ""}${checked.has(i.id) ? " il-checked" : ""}`} aria-selected={on} onClick={() => setCur(i.id)}>
                      <td className="il-ck" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={checked.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Select ${titleOf(i)}`} /></td>
                      <td className="il-when" title={i.at ? `${i.firstAt ? `first ${i.firstAt} · ` : ""}${i.at}` : "The record has no timestamp"}>
                        {okDate(i.at) ? <><div>{fmtDay(i.at)}</div><div className="dim">{fmtHm(i.at)}</div></> : <span className="faint">—</span>}
                      </td>
                      <td>
                        <GroupChip g={i.group} /><span className="il-inl"> <StateChip i={i} /> <span className="dim">×{i.count}</span></span>
                        <div className="il-rtitle"><button type="button" className="linkbtn hl-rowbtn" aria-pressed={on} aria-label={`${GROUP_META[i.group].label}: ${titleOf(i)} — show detail`} onClick={(e) => { e.stopPropagation(); setCur(i.id); }}>{titleOf(i)}</button></div>
                        {/* On the intent tab the Stage column already says where; the sub-line then names the hook or tool only. */}
                        {(() => { const sub = scoped ? subOf(i) : i.where.hook ? subOf({ ...i, where: { ...i.where, stage: null, unit: null } }) : i.where.stage ? "" : i.where.tool ?? "";
                          return sub ? <div className={`dim il-sub${scoped && i.where.inferred ? " hl-inferred" : ""}`} title={scoped ? i.where.inferred ?? undefined : undefined}>{sub}</div> : null; })()}
                      </td>
                      <td className={scoped ? "il-ws" : "il-ws il-stagecol"}>{scoped ? <><b title={s.workspace}>{s.workspace ? wsName(s.workspace) : "—"}</b><div className="dim">{s.intentKey ? s.intentName : <span className="faint" title="A workspace-level record">workspace level</span>}</div></>
                        : i.where.stage || i.where.unit ? <span className={i.where.inferred ? "hl-inferred" : undefined} title={[i.where.stage, i.where.unit].filter(Boolean).join(" · ") + (i.where.inferred ? ` — ${i.where.inferred}` : "")}>{i.where.stage ? <b>{i.where.stage}</b> : <b className="faint" title="The record names a unit but no stage">—</b>}{i.where.unit ? <div className="dim">{i.where.unit}</div> : null}</span> : <span className="faint" title="The record names no stage or unit">—</span>}</td>
                      <td className="il-statecol"><StateChip i={i} /></td>
                      <td className="il-n">×{i.count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="row between il-listfoot dim"><span>Showing {shown.length} of {issues.length} entries</span><span>All recorded times in {tzName()}</span></div>
        </div>
        <div className="il-side">
          {sel ? <IssueDetail i={sel} index={idx} total={shown.length} onStep={step} onIntent={scoped ? onOpen : undefined} showWorkspace={scoped} onView={(path, line) => setView({ path, line })} />
            : <div className="panel dim">No issues match these filters.</div>}
        </div>
      </div>
      <div className="faint" style={{ fontSize: ".8rem", marginTop: 6 }}>Keys: ↑ ↓ or ← → move between entries · Space selects · Enter opens the intent · Esc clears the selection.</div>
      {view && sel && <FileViewer ws={(sel as ScopedIssue).workspace} path={view.path} line={view.line} onClose={() => setView(null)} />}
    </div>
  );
}
