import type { IntentModel, PhaseKey } from "../../../../core/command-center/server/types";
import { PHASES } from "../format";
import { FIVE, phaseCounts, type PhaseState } from "./derive";

const G: Record<PhaseState, [string, string, string]> = {
  done: ["✓", "ok", "done"], running: ["▶", "run", "running"], waiting: ["?", "wait", "waiting on you"], todo: ["○", "faint", "not started"], skip: ["–", "faint", "skipped by scope"],
};

/** Five phases, always visible: count, progress bar, status glyph. Selecting one scopes the rail and every lens. */
export function Stepper({ model: m, phase, onPhase }: { model: IntentModel; phase: PhaseKey; onPhase: (p: PhaseKey) => void }) {
  return (
    <div className="stepper">
      {FIVE.map((k) => {
        const c = phaseCounts(m.stages, k); const [g, cls, word] = G[c.state];
        const cons = k === "construction";
        const none = !c.planned && !c.skipped;
        const cnt = cons ? `${m.unitsDone}/${m.unitsPlanned ?? "—"} units` : none ? "no stages in the plan" : `${c.done}/${c.planned}${c.skipped ? ` · ${c.skipped} skipped` : ""}`;
        const pct = cons ? (m.unitsPlanned ? Math.round((100 * m.unitsDone) / m.unitsPlanned) : 0) : c.planned ? Math.round((100 * c.done) / c.planned) : 0;
        const title = cons
          ? (m.unitsPlanned === null ? "Planned unit count not recorded (no unit list in units-generation/unit-of-work.md)" : `${m.unitsDone} of ${m.unitsPlanned} planned units complete`) + ` · ${c.done}/${c.planned} construction stages done`
          : `${c.done} of ${c.planned} planned stages done${c.skipped ? ` · ${c.skipped} skipped by scope (not counted)` : ""}`;
        const name = PHASES.find((p) => p.key === k)!.name;
        return (
          <button key={k} type="button" className={`step${phase === k ? " on" : ""}`} onClick={() => onPhase(k)} title={title} aria-pressed={phase === k}>
            <div className="nm"><span className={cls} aria-label={word}>{g}</span> {name}</div>
            <div className="ct">{cnt}</div>
            <div className="pb"><i style={{ width: `${pct}%`, ...(c.state === "running" || c.state === "waiting" ? { background: "var(--run)" } : {}) }} /></div>
          </button>
        );
      })}
    </div>
  );
}
