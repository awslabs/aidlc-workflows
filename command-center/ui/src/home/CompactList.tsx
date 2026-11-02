import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmtAgo, fmtTokens, intentHash, phaseName, tilde } from "../format";
import { IntentStatus, MiniBars } from "./IntentCard";
import { type Row, type SortKey, windowRange } from "./homeView";

/** Fixed row height (px) so windowing can place rows without measuring them; matches `.clist tbody tr` in theme.css. */
export const ROW_H = 31;

const ALL_COLS: { label: string; w: number | null; sort?: SortKey; title?: string }[] = [
  { label: "Status", w: 126, sort: "needs", title: "Sort: waiting on you, then active, then most recent activity" },
  { label: "Intent", w: null, sort: "name" },
  { label: "Workspace", w: 104 },
  { label: "Phase", w: 96 },
  { label: "Stage", w: 132 },
  { label: "Unit", w: 82 },
  { label: "Phases", w: 74, title: "Init · Ideation · Inception · Construction · Operation" },
  { label: "Planned", w: 158, sort: "progress", title: "Done ÷ EXECUTE-planned stages; skipped stages are never in the denominator" },
  { label: "Units", w: 56 },
  { label: "Tokens in", w: 72 },
  { label: "Last activity", w: 98, sort: "recent" },
];

interface Props {
  rows: Row[]; now: number; frozen: boolean; windowed: boolean;
  sort: SortKey; reverse: boolean; onSort: (k: SortKey) => void;
  polling: (ws: string) => boolean;
  /** The workspace column; off when the list is already grouped by workspace (the group header names it). */
  showWs: boolean;
}

/**
 * Keeps [start, end) in step with where the list sits in the viewport; the whole list when not windowed. Re-measured
 * on scroll and resize, after every render, and on any layout shift (a ResizeObserver on the page body), so content
 * opening or closing above the list never leaves it showing blank spacer rows.
 */
function useWindow(count: number, enabled: boolean) {
  const body = useRef<HTMLTableSectionElement>(null);
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 40) });
  const measure = useCallback(() => {
    const top = body.current?.getBoundingClientRect().top; if (top === undefined) return;
    const n = windowRange(-top, innerHeight, ROW_H, count);
    setRange((p) => (p.start === n.start && p.end === n.end ? p : n));
  }, [count]);
  // Every render: cheap, and a no-op when the range is unchanged.
  useLayoutEffect(() => { if (enabled) measure(); });
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const on = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    addEventListener("scroll", on, { passive: true }); addEventListener("resize", on);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(on);
    ro?.observe(document.body);
    return () => { removeEventListener("scroll", on); removeEventListener("resize", on); ro?.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [enabled, measure]);
  return { body, ...(enabled ? range : { start: 0, end: count }) };
}

/** One dense row per intent (table semantics). Rows are focusable; click or Enter opens the intent. */
export function CompactList({ rows, now, frozen, windowed, sort, reverse, onSort, polling, showWs }: Props) {
  const { body, start, end } = useWindow(rows.length, windowed);
  const COLS = showWs ? ALL_COLS : ALL_COLS.filter((c) => c.label !== "Workspace");
  return (
    <div className="clist-wrap">
      <table className="clist">
        <colgroup>{COLS.map((c) => <col key={c.label} style={c.w ? { width: c.w } : undefined} />)}</colgroup>
        <thead>
          <tr>
            {COLS.map((c) => {
              const on = c.sort === sort;
              return (
                <th key={c.label} title={c.title} aria-sort={on ? (reverse ? "descending" : "ascending") : c.sort ? "none" : undefined}>
                  {c.sort
                    ? <button type="button" className={`thsort${on ? " on" : ""}`} onClick={() => onSort(c.sort!)}>{c.label}{on && <span aria-hidden> {reverse ? "↑" : "↓"}</span>}</button>
                    : c.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody ref={body}>
          {start > 0 && <tr className="spacer" aria-hidden style={{ height: start * ROW_H }}><td colSpan={COLS.length} /></tr>}
          {rows.slice(start, end).map(({ i, w }) => {
            const href = intentHash(i.workspace, i.key);
            const pct = i.plannedCount ? Math.round((100 * i.doneCount) / i.plannedCount) : 0;
            return (
              // The name link is the focusable, keyboard and Ctrl/Cmd-click target; a plain click anywhere on the row opens it too.
              <tr key={`${w.path}::${i.key}`} className="clk" onClick={(e) => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey) location.hash = href; }}>
                <td><IntentStatus i={i} now={now} frozen={frozen} />{polling(w.path) && <span className="faint" title="File watching unavailable for this workspace — re-read every 10 s"> ⟳</span>}</td>
                <td title={i.title ?? i.name}><a href={href} className="cname" onClick={(e) => e.stopPropagation()}>{i.name}</a>{i.title && <span className="dim"> · {i.title}</span>}</td>
                {showWs && <td className="dim" title={tilde(w.path)}>{w.label}</td>}
                <td className="dim">{i.current.stage ? phaseName(i.current.phase) : <span className="faint">—</span>}</td>
                <td className="mono" title={i.current.stage ?? "Neither the audit nor the state file names a current stage"}>{i.current.stage ?? <span className="faint">not recorded</span>}</td>
                <td className="mono dim" title={i.current.unit ?? "no unit running"}>{i.current.unit ?? <span className="faint">—</span>}</td>
                <td><MiniBars i={i} bare /></td>
                <td className="num" title={`${pct}% of planned stages done · ${i.skippedCount} skipped by scope`}><b>{i.doneCount}/{i.plannedCount}</b> planned · {i.skippedCount} skipped</td>
                <td className="num" title={i.unitsPlanned === null ? "Units complete / planned — the planned unit count is not recorded" : "Construction units complete / planned"}>{i.unitsDone}/{i.unitsPlanned === null ? "—" : i.unitsPlanned}</td>
                <td className="num">{i.tokens.recorded
                  ? <span title={`${i.tokens.value.input.toLocaleString()} input · ${i.tokens.value.output.toLocaleString()} output`}>{fmtTokens(i.tokens.value.input)}</span>
                  : <span className="inf faint" title={`Not recorded — ${i.tokens.reason}`}>—</span>}</td>
                <td className="num dim" title={i.lastEventTs ? (frozen ? `${i.lastEventTs} — live stream disconnected, clock paused` : i.lastEventTs) : "No audit events recorded"}>
                  {i.lastEventTs ? `${frozen ? "≥ " : ""}${fmtAgo(i.lastEventTs, now)}` : "—"}
                </td>
              </tr>
            );
          })}
          {end < rows.length && <tr className="spacer" aria-hidden style={{ height: (rows.length - end) * ROW_H }}><td colSpan={COLS.length} /></tr>}
        </tbody>
      </table>
    </div>
  );
}
