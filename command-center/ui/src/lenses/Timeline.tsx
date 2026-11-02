import { useMemo, useState } from "react";
import { fmtTime } from "../format";
import { type AEvent, attribute, fmtDur, GAP_MS, liveNow, sortUnits } from "../intent/derive";
import type { HealthPayload } from "../../../../core/command-center/server/hooks-map";
import { GROUP_META } from "../../../../core/command-center/server/hooks-map";
import { lensVersion, openIssue, phaseOf, useLens, type XLensProps } from "./common";

/** A compressed idle gap occupies a fixed 40 minutes of active time. */
const GAP_SLOT = 40 * 60_000;
type RowT = { key: string; unit: boolean; s: number; e: number; n: number };
/** `issue`: the Issues-tab item a mark opens. */
type Mark = { at: number; g: string; cls: string; title: string; issue?: string };

const ms = (iso: string) => Date.parse(iso);
function mark(e: AEvent): Omit<Mark, "at"> & { lane: 0 | 1 | 2 } | null {
  const where = `${e.aStage ?? "no stage"}${e.aUnit ? ` · ${e.aUnit}` : ""}`;
  const t = (s: string) => `${s} · ${where} · ${e.ts}`;
  switch (e.kind) {
    case "GATE_APPROVED": return { lane: 0, g: "◆", cls: "ok", title: t("Gate approved by you") };
    case "STAGE_AWAITING_APPROVAL": return { lane: 0, g: "◆", cls: "wait", title: t("Gate opened — awaiting approval") };
    case "PLAN_APPROVAL_RECORDED": case "PLAN_APPROVAL_OVERRIDDEN": return { lane: 0, g: "◇", cls: "ok", title: t("Plan approval") };
    case "QUESTION_ANSWERED": return { lane: 0, g: "?", cls: "wait", title: t("Questions answered") };
    case "WORKFLOW_PARKED": return { lane: 1, g: "⏸", cls: "dim", title: t("Parked") };
    case "UNIT_PAUSED": return { lane: 1, g: "⏸", cls: "dim", title: t("Unit paused") };
    case "GATE_REJECTED": return { lane: 2, g: "✗", cls: "bad", title: t("Gate rejected") };
    case "REVIEW_COMPLETED": return e.raw?.fields?.Verdict === "NOT-READY" ? { lane: 2, g: "✗", cls: "bad", title: t("Review NOT-READY") } : null;
    default: return null;
  }
}

/**
 * Deliberate: a selected unit is highlighted, not filtered. The stepper always picks a unit inside Construction, so
 * filtering would collapse the Gantt to one row and hide the batch overlap it exists to show (Units does the same).
 */
/** Gantt of stages (outside Construction) and units over compressed active time, with lanes for gates/asks, parks and failures. */
export function Timeline({ model: m, ws, filter, selUnit }: XLensProps) {
  const [wall, setWall] = useState(false);
  const issuesLens = useLens<HealthPayload>("issues", ws, m.key, lensVersion(m));
  const health = issuesLens.data;
  /** The issues lens failed: fall back to the logged errors so the lane is never silently empty. */
  const fallback = !health && !!issuesLens.err;
  const all = useMemo(() => attribute(m), [m]);
  const view = useMemo(() => {
    const units = new Set(m.units.map((u) => u.name));
    const rows = new Map<string, RowT>();
    const inView = (e: AEvent) => {
      const p = phaseOf(m.stages, e.aStage);
      if (filter.phase ? p !== filter.phase : p === "initialization") return false;
      return true;
    };
    const evs = all.filter((e) => Number.isFinite(ms(e.ts)) && inView(e));
    for (const e of evs) {
      const p = phaseOf(m.stages, e.aStage); const t = ms(e.ts);
      const key = p === "construction" ? (e.aUnit && units.has(e.aUnit) ? e.aUnit : null) : e.aStage;
      if (!key) continue;
      const r = rows.get(key) ?? { key, unit: p === "construction", s: t, e: t, n: 0 };
      r.s = Math.min(r.s, t); r.e = Math.max(r.e, t); r.n++; rows.set(key, r);
    }
    const order = new Map(sortUnits(m.units).map((u, i) => [u.name, i]));
    const list = [...rows.values()].sort((a, b) => (a.unit === b.unit ? (a.unit ? (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0) || a.s - b.s : a.s - b.s) : a.unit ? 1 : -1));
    const times = [...new Set(evs.map((e) => ms(e.ts)))].sort((a, b) => a - b);
    const map = new Map<number, number>(); const gaps: { at: number; len: number }[] = []; let acc = 0;
    times.forEach((x, i) => {
      if (i) { const d = x - times[i - 1]!; if (d > GAP_MS) { gaps.push({ at: acc + GAP_SLOT / 2, len: d }); acc += GAP_SLOT; } else acc += d; }
      map.set(x, acc);
    });
    const marks: Mark[][] = [[], [], []];
    for (const e of evs) { const k = mark(e); if (k) marks[k.lane]!.push({ at: ms(e.ts), g: k.g, cls: k.cls, title: k.title }); }
    if (fallback) for (const e of evs) if (e.kind === "ERROR_LOGGED") marks[2]!.push({ at: ms(e.ts), g: "✗", cls: "bad", title: `Error logged · ${e.aStage ?? "no stage"}${e.aUnit ? ` · ${e.aUnit}` : ""} · ${e.ts}` });
    // Issues (errors, failed checks, checks that did not run, guard blocks…) from the Issues lens: open ones, by their time.
    const t0 = times[0] ?? 0; const t1 = times.at(-1) ?? 0;
    for (const i of health?.issues ?? []) {
      if (i.resolved || i.group === "bypass" || i.group === "accepted" || !i.at) continue;
      const at = ms(i.at); if (!Number.isFinite(at) || at < t0 || at > t1) continue;
      const p = phaseOf(m.stages, i.where.stage ?? null);
      if (i.where.stage && (filter.phase ? p !== filter.phase : p === "initialization")) continue;
      const g = GROUP_META[i.group];
      marks[2]!.push({ at, g: "✗", cls: i.group === "refused" ? "wait" : "bad", issue: i.id, title: `${g.label} · ${i.kind}${i.count > 1 ? ` ×${i.count}` : ""} · ${i.where.stage ?? "no stage"}${i.where.unit ? ` · ${i.where.unit}` : ""} · ${i.at} — click to open it in Issues` });
    }
    return { list, times, map, gaps, active: acc, marks };
  }, [all, m.stages, m.units, filter.phase, health, fallback]);

  const { list, times, map, gaps, active, marks } = view;
  if (!times.length) return <div className="dim" data-loaded="">No audit events in this scope yet.</div>;
  const t0 = times[0]!; const t1 = times.at(-1)!;
  const W = wall ? Math.max(1, t1 - t0) : Math.max(1, active);
  /** Compressed position of any instant: that of the newest event at or before it (exact for event times). */
  const at = (x: number) => { const v = map.get(x); if (v !== undefined) return v; let lo = 0; for (let i = 0; i < times.length && times[i]! <= x; i++) lo = i; return map.get(times[lo]!) ?? 0; };
  const pos = (x: number) => ((wall ? x - t0 : at(x)) / W) * 100;
  const cur = liveNow(m.liveness, m.lastEventTs, Date.now()) === "active" ? (m.current.phase === "construction" ? m.current.unit : m.current.stage) : null;
  const gm = wall ? null : gaps.map((g, i) => <span key={i} className="gm" style={{ left: `${(g.at / W) * 100}%` }} title={`Idle gap of ${fmtDur(g.len)}, compressed`} />);

  return (
    <div data-loaded="">
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" className={`chip clk${wall ? "" : " on"}`} aria-pressed={!wall} onClick={() => setWall(false)}>Active time</button>
        <button type="button" className={`chip clk${wall ? " on" : ""}`} aria-pressed={wall} onClick={() => setWall(true)}>Wall clock</button>
        <span className="grow" />
        <span className="dim" style={{ fontSize: ".85rem" }}>{wall ? `Linear time · ${fmtDur(t1 - t0)} from first to last event` : `┆┆ = idle gap over 2h compressed — hover for its length · ${gaps.length} gap${gaps.length === 1 ? "" : "s"}`}</span>
      </div>
      <div className="panel gantt">
        {list.map((r) => {
          const l = pos(r.s); const w = Math.max(pos(r.e) - l, 0.6); const live = r.key === cur;
          return (
            <div key={r.key} className="gr" style={r.unit && r.key === selUnit ? { background: "var(--runbg)", borderRadius: 4 } : undefined}>
              <span className="nm" title={r.key}>{r.unit ? "▸ " : ""}{r.key}</span>
              <span className="tr"><i className={live ? "r" : ""} style={{ left: `${l}%`, width: `${w}%` }} title={`${r.key}: first event ${fmtTime(new Date(r.s).toISOString())} → last ${fmtTime(new Date(r.e).toISOString())} · ${r.n} events · span ${fmtDur(r.e - r.s)}${live ? " · running now" : ""}`} />{gm}</span>
            </div>
          );
        })}
        {!list.length && <div className="dim">No stage or unit rows in this scope.</div>}
        {([["◆ gates · ? asks", "wait"], ["⏸ parked", "dim"], ["✗ issues", "bad"]] as const).map(([nm, cls], lane) => (
          <div key={nm} className="gr">
            <span className={`nm ${cls}`}>{nm}</span>
            <span className="tr" style={{ background: "transparent" }}>{marks[lane]!.map((k, i) => k.issue
              ? <button key={i} type="button" className={`mk mkbtn ${k.cls}`} style={{ left: `${pos(k.at)}%` }} title={k.title} aria-label={k.title} onClick={() => openIssue(ws, m.key, k.issue!)}>{k.g}</button>
              : <span key={i} className={`mk ${k.cls}`} style={{ left: `${pos(k.at)}%` }} title={k.title}>{k.g}</span>)}</span>
          </div>
        ))}
        <div className="gr faint" style={{ fontSize: ".78rem" }}><span className="nm" /><span className="row between grow"><span title={new Date(t0).toISOString()}>{fmtTime(new Date(t0).toISOString())}</span><span title={new Date(t1).toISOString()}>{fmtTime(new Date(t1).toISOString())}</span></span></div>
      </div>
      {fallback && <div className="warn" role="note" data-timeline-fallback="">Issues could not be loaded ({issuesLens.err}); the ✗ issues lane shows logged errors only.</div>}
      <div className="dim" style={{ fontSize: ".82rem", marginTop: 8 }}>Bars span each stage's (or unit's) first to last audit event. Construction is drawn per unit; events with no stage take the stage running at that moment. The ✗ issues lane shows open errors, failed checks and checks that did not run (click one to open it in Issues), plus rejected gates and NOT-READY reviews.</div>
    </div>
  );
}
