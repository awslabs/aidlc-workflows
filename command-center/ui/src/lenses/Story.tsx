import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { IntentModel, PhaseKey, Recorded, Tokens } from "../../../../core/command-center/server/types";
import { get, q } from "../api";
import { fmtAgo, fmtTime, fmtTokens, fmtWaitLive } from "../format";
import { type AEvent, attribute, fmtDur, fold, GROUPS, groupOf, leadLabel, liveNow, parkedSpans, recordRel, restLabel, type Row, storyEvents, timeSpan } from "../intent/derive";
import { useLiveClock, useLiveCtx } from "../useLive";
import { openArtifact } from "./common";

export interface LensProps {
  model: IntentModel; ws: string; scope: { phase: PhaseKey; stage: string | null; unit: string | null };
  replayAt: string | null; onSelect: (stage: string, unit?: string | null) => void;
}
type Breakdown = { totals: Tokens; byStage: Record<string, Tokens> };

/** Dot colour (timeline bullet), text colour class, glyph, label. */
type Look = { dot: "" | "r" | "g" | "x" | "h" | "p"; cls: string; g: string; label: string };
const L = (dot: Look["dot"], cls: string, g: string, label: string): Look => ({ dot, cls, g, label });

function look(e: AEvent): Look {
  const f = e.raw?.fields ?? {};
  switch (e.kind) {
    case "STAGE_STARTED": return L("r", "run", "▶", "Started");
    case "STAGE_COMPLETED": return L("g", "ok", "✓", "Completed");
    case "UNIT_STARTED": return L("r", "run", "▶", `Unit started${e.unit ? ` · ${e.unit}` : ""}`);
    case "UNIT_COMPLETED": return L("g", "ok", "✓", `Unit complete${e.unit ? ` · ${e.unit}` : ""}`);
    case "UNIT_RESUMED": return L("", "", "↺", "Unit resumed");
    case "UNIT_PAUSED": return L("p", "dim", "⏸", "Unit paused");
    case "REVIEW_COMPLETED": return f.Verdict === "NOT-READY" ? L("x", "bad", "✗", "Review NOT-READY") : f.Verdict === "READY" ? L("g", "ok", "✓", "Review READY") : L("", "", "·", `Review ${f.Verdict ?? "completed"}`);
    case "REVIEW_REQUESTED": return L("", "dim", "·", "Review requested");
    case "STAGE_AWAITING_APPROVAL": return L("h", "wait", "◆", "Gate opened — awaiting approval");
    case "GATE_APPROVED": return L("g", "ok", "◆", "Approved by you");
    case "GATE_REJECTED": return L("x", "bad", "↺", "Gate rejected");
    case "STAGE_JUMPED": return L("h", "wait", "↺", "Redo");
    case "STAGE_REVISING": return L("h", "wait", "↺", "Revising");
    case "WORKFLOW_PARKED": return L("p", "dim", "⏸", "Parked");
    case "WORKFLOW_UNPARKED": return L("", "", "↺", "Resumed");
    case "ERROR_LOGGED": return L("x", "bad", "✗", "Error");
    case "QUESTION_ANSWERED": return L("h", "wait", "?", "Answered");
    case "DECISION_RECORDED": return L("", "", "◇", "Decision");
    case "SUMMARY_CONFIRMATION_RECORDED": return L("", "", "◇", "Summary confirmed");
    case "ARTIFACT_CREATED": return L("", "", "✎", "Wrote");
    case "ARTIFACT_UPDATED": return L("", "", "✎", "Edited");
    case "ARTIFACT_REUSED": return L("", "", "✎", "Reused artifacts");
    case "AUTONOMY_MODE_SET": return L("", "", "⚙", `Autonomy → ${f.Mode ?? "?"}`);
    case "RULE_LEARNED": return L("", "pur", "✦", "Rule learned");
    case "SENSOR_FAILED": return L("", "dim", "⚠", "Sensor findings");
    default: return L("", "dim", "·", e.kind.toLowerCase().replace(/_/g, " "));
  }
}

/** Absolute paths inside audit text are shown relative to the project's `aidlc/` folder (spec §8). */
const relPaths = (s: string) => s.replace(/(?:\/[^\s/"'`]+)*\/aidlc\//g, "aidlc/");
/** "14:50–15:10", or "14:50–08-12 09:53" when the fold crosses a day (local time). */
const span = (r: Row) => { const a = fmtTime(r.e.ts); const b = fmtTime(r.last.ts); return `${a.slice(6)}–${a.slice(0, 5) === b.slice(0, 5) ? b.slice(6) : b}`; };
const clip = (s: string, n = 220) => { const r = relPaths(s); return r.length > n ? `${r.slice(0, n - 1)}…` : r; };

function text(r: Row, all: AEvent[]): { body: string; extra: ReactNode } {
  const e = r.e; const f = e.raw?.fields ?? {};
  switch (e.kind) {
    case "ARTIFACT_CREATED": case "ARTIFACT_UPDATED": {
      const name = r.file ? r.file.split("/").at(-1)! : relPaths(e.text);
      return { body: r.count > 1 ? `${name} · ${r.count} edits · ${span(r)}` : name, extra: null };
    }
    case "ARTIFACT_REUSED": return { body: [f.Decision, f.Artifacts].filter(Boolean).join(" · "), extra: null };
    case "SENSOR_FAILED": {
      const ids = [...new Set(r.members.map((x) => x.raw?.fields?.["Sensor ID"]).filter(Boolean))];
      return { body: `${r.count} sensor check${r.count === 1 ? "" : "s"} reported findings${ids.length ? ` (${ids.join(", ")})` : ""}${r.count > 1 ? ` · ${span(r)}` : ""}`, extra: null };
    }
    case "STAGE_STARTED": return { body: f.Agent ? `by ${f.Agent}` : "", extra: null };
    case "REVIEW_COMPLETED": case "REVIEW_REQUESTED": return { body: [f.Reviewer, f.Iteration ? `iteration ${f.Iteration}` : null, e.unit].filter(Boolean).join(" · "), extra: null };
    case "GATE_APPROVED": return { body: f["User Input"] && !/^approve$/i.test(f["User Input"]) ? f["User Input"] : "", extra: null };
    case "STAGE_JUMPED": return { body: [f.Source && f.Target ? `${f.Source} → ${f.Target}` : null, f.Direction].filter(Boolean).join(" · "), extra: f.Details ? <div className="ind">{clip(f.Details, 400)}</div> : null };
    case "WORKFLOW_UNPARKED": {
      const park = [...all].reverse().find((x) => x.idx < e.idx && x.kind === "WORKFLOW_PARKED");
      return { body: park ? `after ${fmtDur(Date.parse(e.ts) - Date.parse(park.ts))} parked` : "", extra: null };
    }
    case "ERROR_LOGGED": return { body: clip(f.Error ?? e.text ?? ""), extra: f.Tool || f.Command ? <div className="ind mono" style={{ fontSize: ".8rem" }}>{[f.Tool, f.Command ? clip(f.Command, 160) : null].filter(Boolean).join(" · ")}</div> : null };
    case "UNIT_PAUSED": return { body: clip(f.Reason ?? e.text), extra: f["Next Action"] ? <div className="ind"><b>Next action:</b> {clip(f["Next Action"], 400)}</div> : null };
    case "RULE_LEARNED": return { body: clip([f.Heading, f.Destination ? `→ ${f.Destination}` : null].filter(Boolean).join(" ")), extra: null };
    default: return { body: clip(e.text ?? ""), extra: null };
  }
}

function EventRow({ r, all }: { r: Row; all: AEvent[] }) {
  const l = look(r.e); const { body, extra } = text(r, all);
  const when = r.count > 1 ? `${fmtTime(r.e.ts)} → ${fmtTime(r.last.ts)}` : r.e.ts;
  const how = r.e.how === "timing" ? "Stage inferred from timing: this audit entry names no stage." : r.e.how === "file" ? "Stage taken from the artifact's folder." : r.e.how === "park" ? "The stage that was parked." : "";
  const unitHow = r.e.unitInferred && r.e.aUnit ? `Unit inferred: this entry names no unit; ${r.e.aUnit} was running at the time.` : "";
  const folded = r.count > 1 ? `${r.count} entries folded (first ${fmtTime(r.e.ts)}, last ${fmtTime(r.last.ts)})` : "";
  return (
    <div className={`e ${l.dot}`} title={[r.e.kind, when, how, unitHow, folded].filter(Boolean).join(" · ")}>
      <span className="t mono">{fmtTime(r.e.ts)}</span>
      <span className={l.cls}>{l.g} {l.label}{body ? " · " : ""}</span>{body}
      {extra}
    </div>
  );
}

const sameUnit = (a: string | null, b: string | null) => !a || !b || a === b;

/** Narrative of the selected stage (or unit × stage). */
export function Story({ model: m, ws, scope, replayAt }: LensProps) {
  const { connected } = useLiveCtx();
  const { now, frozen } = useLiveClock();
  const [grouped, setGrouped] = useState(false);
  const [tok, setTok] = useState<Recorded<Breakdown> | null>(null);
  useEffect(() => {
    let off = false;
    get<Recorded<Breakdown>>(`/api/lens/tokens?${q({ ws, key: m.key })}`).then((t) => { if (!off) setTok(t); }).catch(() => { if (!off) setTok({ recorded: false, reason: "Token breakdown could not be loaded" }); });
    return () => { off = true; };
  }, [ws, m.key, m.doneCount]);

  const all = useMemo(() => attribute(m), [m]);
  const { stage, unit } = scope;
  const sv = m.stages.find((s) => s.slug === stage) ?? null;
  const evs = useMemo(() => storyEvents(all, stage, unit, replayAt), [all, stage, unit, replayAt]);
  const rows = useMemo(() => fold(evs, m.dir), [evs, m.dir]);
  if (!stage) return <div className="dim">Pick a stage in the rail to read its story.</div>;

  const cell = unit ? m.units.find((u) => u.name === unit)?.cells[stage] ?? "todo" : null;
  const isCurrent = !replayAt && stage === m.current.stage && sameUnit(unit, m.current.unit);
  const live = liveNow(m.liveness, m.lastEventTs, now);
  const rest = restLabel(live, m.lastEventTs, now);
  const hc = m.hiddenCounts?.[stage];
  const untagged = m.hiddenCounts?.["_"]?.humanTurns ?? 0;
  const need = !replayAt ? m.needs.find((n) => n.stage === stage && sameUnit(unit, n.unit)) : undefined;
  const doneNow = unit ? cell === "done" || cell === "inferred" : sv?.state === "done";
  // While replaying, "complete" must be true as of the replay instant, not merely now.
  const doneThen = !replayAt ? doneNow
    : unit ? evs.some((e) => e.kind === "UNIT_COMPLETED") || (cell === "inferred" && evs.some((e) => e.kind === "REVIEW_COMPLETED" && e.raw?.fields?.Verdict === "READY"))
    : !!sv?.completed && Date.parse(sv.completed) <= Date.parse(replayAt);
  const done = doneNow && doneThen;

  const status = need ? <span className="wait">? waiting on you</span>
    : isCurrent && live === "active" ? <span className="run"><span className="live-dot" />{connected ? "live" : "last known: live"}</span>
    : done ? <span className="ok">✓ complete{cell === "inferred" ? " (inferred)" : ""}</span>
    : isCurrent ? <span className="dim" title={m.lastEventTs ?? undefined}>{rest}</span>
    : replayAt && evs.length ? <span className="run" title="State at the replay instant">▶ in progress then</span>
    : sv?.state === "skip" ? <span className="faint">– skipped by scope</span>
    : (unit ? cell === "todo" : sv?.state === "todo") ? <span className="faint">○ not started</span> : null;

  const files = new Map<string, number>();
  for (const e of evs) if (e.kind.startsWith("ARTIFACT_C") || e.kind.startsWith("ARTIFACT_U")) { const p = e.raw?.fields?.File; if (p) { const r = recordRel(p, m.dir); files.set(r, (files.get(r) ?? 0) + 1); } }

  const list = (rs: Row[]) => rs.map((r) => <EventRow key={r.e.idx} r={r} all={all} />);
  const liveTail = need
    ? <div className="e h live"><span className="t mono">now</span><span className="wait">? waiting on you · </span>{need.detail} <span className="faint" title={frozen ? "Live stream disconnected — timer paused" : need.since ?? "start not recorded"}>· {fmtWaitLive(need.since, now, frozen)}</span></div>
    : isCurrent && live === "active"
      ? <div className="e r live"><span className="t mono">now</span><span className="run"><span className="live-dot" />{connected ? "agent working…" : "agent was working when the live stream dropped"}</span></div>
      : isCurrent ? <div className="e p"><span className="t mono">now</span><span className="dim">{live === "ended" ? `■ the session ended · last event ${fmtAgo(m.lastEventTs, now)}` : `◌ idle — no events since ${fmtAgo(m.lastEventTs, now)}`}</span></div> : null;

  return (
    <>
      <div className="row between" style={{ marginBottom: 6 }}>
        <div><b style={{ fontSize: "1.12rem" }} title={sv?.name}>{stage}{unit ? ` · ${unit}` : ""}</b> <span className="dim">· lead: {leadLabel(sv?.lead ?? "orchestrator")}</span></div>
        <div className="row">
          {status}
          <button type="button" className={`chip clk${grouped ? "" : " on"}`} onClick={() => setGrouped(false)} aria-pressed={!grouped}>Narrative</button>
          <button type="button" className={`chip clk${grouped ? " on" : ""}`} onClick={() => setGrouped(true)} aria-pressed={grouped}>Group by type</button>
        </div>
      </div>
      {done && <Outcome model={m} all={all} stage={stage} unit={unit} tok={tok} replayAt={replayAt} />}
      {rows.length || liveTail ? (
        grouped
          ? GROUPS.map((g) => { const rs = rows.filter((r) => groupOf(r.e.kind) === g); return rs.length ? <div key={g}><div className="lbl" style={{ marginTop: 8 }}>{g} · {rs.length}</div><div className="tl">{list(rs)}</div></div> : null; })
          : <div className="tl">{list(rows)}{liveTail}</div>
      ) : (
        <div className="dim">{replayAt ? `No events for this selection by ${fmtTime(replayAt)}.` : (unit ? cell === "todo" : sv?.state === "todo") ? "Not started yet — planned for this intent." : sv?.state === "skip" ? `Skipped by scope ${m.scope ?? ""}.` : "No audit events were recorded for this selection."}</div>
      )}
      {hc && (hc.sensorPassed || hc.sensorFired || hc.humanTurns || hc.sensorNotRun) ? (
        <div className="faint" style={{ fontSize: ".84rem", marginTop: 8 }} title="Folded out of the narrative; counted across the whole stage (all units, not cut by replay)">
          {[`${hc.sensorPassed} sensor check${hc.sensorPassed === 1 ? "" : "s"} passed`, hc.sensorNotRun ? `${hc.sensorNotRun} did not run (not counted as passed)` : null, hc.sensorFired ? `${hc.sensorFired} sensor fire${hc.sensorFired === 1 ? "" : "s"}` : null,
            hc.humanTurns ? `${hc.humanTurns} human turn${hc.humanTurns === 1 ? "" : "s"}` : untagged ? "human turns are not stage-tagged" : null].filter(Boolean).join(" · ")}
          {!hc.humanTurns && untagged > 0 && <span title={`${untagged} HUMAN_TURN entries in this intent name no stage`}> ({untagged} in this intent)</span>}
        </div>
      ) : null}
      {files.size > 0 && (
        <>
          <div className="lbl" style={{ marginTop: 14 }}>Artifacts from this {unit ? "unit step" : "stage"}</div>
          <table><tbody>
            {[...files.entries()].map(([p, n]) => (
              <tr key={p} className="clk" onClick={() => openArtifact(ws, m.key, p)}>
                <td>✎ {p.split("/").at(-1)}</td><td className="mono dim" title={p}>{p}</td><td className="dim">{n} write{n === 1 ? "" : "s"}</td><td className="dim">open →</td>
              </tr>
            ))}
          </tbody></table>
        </>
      )}
    </>
  );
}

/** Stage outcome: agent time, calendar, iterations, last review verdict, stage tokens. */
function Outcome({ model: m, all, stage, unit, tok, replayAt }: { model: IntentModel; all: AEvent[]; stage: string; unit: string | null; tok: Recorded<Breakdown> | null; replayAt: string | null }) {
  const sv = m.stages.find((s) => s.slug === stage);
  const mine = all.filter((e) => e.aStage === stage && (!unit || e.aUnit === unit));
  let start: string | null; let end: string | null; let iters: number; let iterNote: string;
  if (unit) {
    const starts = mine.filter((e) => e.kind === "UNIT_STARTED" || e.kind === "UNIT_RESUMED");
    start = starts[0]?.ts ?? null; end = mine.filter((e) => e.kind === "UNIT_COMPLETED").at(-1)?.ts ?? null;
    iters = Math.max(1, mine.filter((e) => e.kind === "UNIT_STARTED").length); iterNote = "UNIT_STARTED runs";
  } else {
    start = sv?.firstStart ?? null; end = sv?.completed ?? null; iters = 1 + (sv?.redos ?? 0); iterNote = sv?.redos ? `${sv.redos} redo` : "no redo";
  }
  const span = timeSpan(start, end, parkedSpans(m.events));
  const reviews = mine.filter((e) => e.kind === "REVIEW_COMPLETED");
  const lastRev = reviews.at(-1);
  const st = tok === null ? null : !tok.recorded ? { v: "—", s: tok.reason } : unit ? { v: "—", s: "tokens are recorded per stage, not per unit" }
    : tok.value.byStage[stage] ? { v: fmtTokens(tok.value.byStage[stage]!.input), s: `in · ${fmtTokens(tok.value.byStage[stage]!.output)} out` } : { v: "—", s: "no token entry for this stage" };
  return (
    <>
    {replayAt && <div className="faint" style={{ fontSize: ".8rem", marginBottom: 4 }}>Stage outcome as finally recorded — not cut by the replay</div>}
    <div className="kpis" title={replayAt ? "Outcome as finally recorded (not cut by replay)" : undefined}>
      <div className="kpi" title="First start → completion, minus parked time. Includes time waiting on you, so it is elapsed time, not agent working time."><span className="s">Stage time (unparked)</span><span className="v">{span ? fmtDur(span.agentMs) : "—"}</span><span className="s">{span ? "excludes parked time" : "start or completion not recorded"}</span></div>
      <div className="kpi" title={start && end ? `${start} → ${end}` : undefined}><span className="s">Calendar</span><span className="v">{span ? fmtDur(span.calendarMs) : "—"}</span><span className="s">{span ? (span.parkedMs ? `parked ${fmtDur(span.parkedMs)}` : "never parked") : "start or completion not recorded"}</span></div>
      <div className="kpi" title={unit ? "Number of UNIT_STARTED events for this unit step" : "1 + backward STAGE_JUMPED (redo) count"}><span className="s">Iterations</span><span className="v">{iters}</span><span className="s">{iterNote}</span></div>
      <div className="kpi"><span className="s">Review</span>
        {lastRev
          ? <><span className={`v ${lastRev.raw.fields.Verdict === "READY" ? "ok" : lastRev.raw.fields.Verdict === "NOT-READY" ? "bad" : ""}`}>{lastRev.raw.fields.Verdict === "NOT-READY" ? "✗ " : lastRev.raw.fields.Verdict === "READY" ? "✓ " : ""}{lastRev.raw.fields.Verdict ?? "—"}</span><span className="s">{leadLabel(lastRev.raw.fields.Reviewer ?? "reviewer")} · ×{reviews.length}</span></>
          : <><span className="v">—</span><span className="s">no review recorded for this stage</span></>}
      </div>
      <div className="kpi"><span className="s">Tokens</span><span className="v">{st?.v ?? "…"}</span><span className="s">{st?.s ?? "loading"}</span></div>
    </div>
    </>
  );
}
