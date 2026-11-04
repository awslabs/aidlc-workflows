import type { IntentModel } from "../../../../core/command-center/server/types";
import { fmtTime, fmtTokens, tilde } from "../format";
import { agentTime, fmtDur } from "./derive";

/** Intent header: name, title, chips, the five KPIs and any data notes (⚠). */
export function Kpis({ model: m, wsLabel }: { model: IntentModel; wsLabel: string }) {
  const at = agentTime(m);
  const modes = m.events.filter((e) => e.kind === "AUTONOMY_MODE_SET" && e.raw?.fields?.Mode);
  const recordPath = `${m.workspace}/aidlc/spaces/${m.space}/intents/${m.dir}`;
  const notes = [...m.notes, ...(m.unparsed ? [`${m.unparsed} audit block${m.unparsed === 1 ? "" : "s"} could not be parsed (no timestamp) and are not shown`] : [])];
  return (
    <>
      <div className="ihead">
        <div>
          <h2>{m.name}</h2>
          {m.title ? <div className="dim">{m.title}</div> : <div className="faint" title="aidlc-state.md has no Project line">No project title recorded</div>}
          <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
            <span className="chip" title={m.workspace}>workspace {wsLabel}</span>
            <span className="chip">scope {m.scope ?? "—"}</span>
            <span className="chip">depth {m.depth ?? "—"}</span>
            <span className="chip" title={m.started ?? "start not recorded"}>started {m.started ? fmtTime(m.started) : "—"}</span>
            {m.status !== "in-flight" && <span className="chip">{m.status}</span>}
            {modes.length > 0 && (
              <span className="chip" title={modes.map((e) => `${fmtTime(e.ts)} → ${e.raw.fields.Mode}`).join("\n")}>
                autonomy: {modes.at(-1)!.raw.fields.Mode}{modes.length > 1 ? ` · changed ×${modes.length}` : ""}
              </span>
            )}
          </div>
        </div>
        <div className="mono faint" style={{ fontSize: ".8rem", maxWidth: 360, textAlign: "right", overflowWrap: "anywhere" }} title={recordPath}>{tilde(recordPath)}</div>
      </div>
      {notes.map((n) => <div className="warn" key={n} style={{ margin: "-4px 0 8px" }}>⚠ {n}</div>)}
      <div className="kpis">
        <div className="kpi" title="Done ÷ planned (EXECUTE) stages. Skipped stages are excluded from the denominator.">
          <span className="s">Progress</span><span className="v">{m.doneCount} of {m.plannedCount}</span>
          <span className="s">planned stages · {m.skippedCount} skipped by scope</span>
        </div>
        <div className="kpi" title={m.unitsPlanned === null ? "No planned-unit count: inception/units-generation/unit-of-work.md is missing or lists no units." : "A unit is complete when its code-generation step is done (or inferred done)."}>
          <span className="s">Units</span><span className="v">{m.unitsDone} / {m.unitsPlanned ?? "—"}</span>
          <span className="s">{m.unitsPlanned === null ? "planned units not recorded" : "construction units complete"}</span>
        </div>
        <div className="kpi" title="Per stage: first STAGE_STARTED → STAGE_COMPLETED, minus time the workflow was parked. It includes time spent waiting on you at gates and questions, so it is elapsed time, not agent working time.">
          <span className="s">Stage time (unparked)</span><span className="v">{at ? fmtDur(at.ms) : "—"}</span>
          <span className="s">{at ? `across ${at.stages} timed stage${at.stages === 1 ? "" : "s"}` : "no stage has both a start and a completion event"}</span>
        </div>
        <div className="kpi" title="REVIEW_COMPLETED verdicts in the audit">
          <span className="s">Reviews</span>
          <span className="v">{m.reviews.ready} <span className="ok" style={{ fontSize: ".85rem" }}>✓</span> {m.reviews.notReady} <span className="bad" style={{ fontSize: ".85rem" }}>✗</span></span>
          <span className="s">READY / NOT-READY verdicts</span>
        </div>
        <div className="kpi" title={m.tokens.recorded ? `${m.tokens.value.input.toLocaleString()} input · ${m.tokens.value.output.toLocaleString()} output` : m.tokens.reason}>
          <span className="s">Tokens</span>
          {m.tokens.recorded
            ? <><span className="v">{fmtTokens(m.tokens.value.input)}</span><span className="s">in · {fmtTokens(m.tokens.value.output)} out</span></>
            : <><span className="v">—</span><span className="s">{m.tokens.reason}</span></>}
        </div>
      </div>
    </>
  );
}
