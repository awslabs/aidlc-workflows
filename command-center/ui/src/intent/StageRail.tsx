import type { CellState, IntentModel, PhaseKey, StageState, UnitRow } from "../../../../core/command-center/server/types";
import { phaseName } from "../format";
import { CONSTRUCTION, sortUnits, unitLabel, unitState, type UnitGlyph } from "./derive";

const SG: Record<StageState, [string, string]> = { done: ["✓", "ok"], running: ["▶", "run"], waiting: ["?", "wait"], todo: ["○", "faint"], skip: ["–", "faint"] };
const UG: Record<UnitGlyph, [string, string]> = { done: ["✓", "ok"], running: ["▶", "run"], waiting: ["?", "wait"], paused: ["⏸", "dim"], todo: ["○", "faint"] };
const CG: Record<CellState, [string, string, string]> = {
  done: ["✓", "ok", "done"], inferred: ["✓", "ok", "done (inferred)"], running: ["▶", "run", "running"], waiting: ["?", "wait", "waiting on you"],
  paused: ["⏸", "dim", "paused"], na: ["—", "faint", "not applicable"], todo: ["○", "faint", "not started"],
};

interface Props { model: IntentModel; phase: PhaseKey; stage: string | null; unit: string | null; onSelect: (stage: string, unit?: string | null) => void }

export function StageRail(p: Props) {
  return p.phase === "construction" && p.model.units.length ? <UnitRail {...p} /> : <PhaseRail {...p} />;
}

function PhaseRail({ model: m, phase, stage, onSelect }: Props) {
  const rows = m.stages.filter((s) => s.phase === phase);
  return (
    <>
      <div className="lbl">{phaseName(phase)}</div>
      {rows.map((s) => s.state === "skip"
        ? <div key={s.slug} className="st skip" title={`Skipped by scope ${m.scope ?? "(scope not recorded)"}`}><span className="g">–</span>{s.slug}<span className="meta">skip</span></div>
        : (
          <div key={s.slug} className={`st${stage === s.slug ? " cur" : ""}`} role="button" tabIndex={0} title={`${s.name} · lead: ${s.lead}`}
            onClick={() => onSelect(s.slug, null)} onKeyDown={(e) => { if (e.key === "Enter") onSelect(s.slug, null); }}>
            <span className={`g ${SG[s.state][1]}`} aria-label={s.state}>{SG[s.state][0]}</span>{s.slug}
            <span className="meta" title={s.redos ? `${s.redos} backward STAGE_JUMPED to this stage` : undefined}>{s.redos ? `${s.redos} redo` : ""}</span>
          </div>
        ))}
      {!rows.length && <div className="dim" style={{ fontSize: ".88rem" }}>No stages of this phase in the plan.</div>}
      {phase === "construction" && <div className="dim" style={{ fontSize: ".85rem", marginTop: 6 }}>No construction units recorded yet.</div>}
    </>
  );
}

function UnitRail({ model: m, stage, unit, onSelect }: Props) {
  const order = m.unitStages?.length ? m.unitStages : CONSTRUCTION;
  const pick = (u: UnitRow) => {
    if (u.name === m.current.unit && m.current.stage && order.includes(m.current.stage)) return m.current.stage;
    return order.find((s) => ["running", "waiting", "paused"].includes(u.cells[s] ?? ""))
      ?? [...order].reverse().find((s) => (u.cells[s] ?? "todo") !== "todo" && u.cells[s] !== "na") ?? order[0]!;
  };
  const more = m.unitsPlanned !== null ? m.unitsPlanned - m.units.length : 0;
  return (
    <>
      <div className="lbl">Construction · by unit</div>
      {sortUnits(m.units).map((u) => {
        const waits = (st: string) => m.needs.some((n) => n.unit === u.name && n.stage === st);
        const us = m.needs.some((n) => n.unit === u.name) ? "waiting" : unitState(u);
        const [g, cls] = UG[us];
        return (
          <div key={u.name}>
            <div className={`st${unit === u.name ? " cur" : ""}`} role="button" tabIndex={0} onClick={() => onSelect(pick(u), u.name)} onKeyDown={(e) => { if (e.key === "Enter") onSelect(pick(u), u.name); }}>
              <span className={`g ${cls}`} aria-label={us}>{g}</span><span>{u.name}</span>
              <span className="meta">{[u.batch !== null ? `b${u.batch}` : null, u.kind].filter(Boolean).join(" · ")}</span>
            </div>
            {unit === u.name && (
              <div className="sub">
                {order.map((s) => {
                  const sv = m.stages.find((x) => x.slug === s);
                  if (sv?.state === "skip") return <div key={s} className="st skip" style={{ padding: "2px 6px" }} title={`Skipped by scope ${m.scope ?? ""}`}><span className="g">–</span>{unitLabel(s, m.stages)}</div>;
                  const c = (waits(s) ? "waiting" : u.cells[s] ?? "todo") as CellState; const [cg, ccls, word] = CG[c];
                  return (
                    <div key={s} className={`st${stage === s ? " cur" : ""}`} style={{ padding: "2px 6px" }} role="button" tabIndex={0} title={`${s} · ${word}`}
                      onClick={(e) => { e.stopPropagation(); onSelect(s, u.name); }} onKeyDown={(e) => { if (e.key === "Enter") onSelect(s, u.name); }}>
                      <span className={`g ${ccls}`} aria-label={word}>{cg}</span>{unitLabel(s, m.stages)}
                      {c === "inferred" && <> <span className="faint inf" title="Inferred: artifacts + READY review exist, but no UNIT_COMPLETED event">inferred</span></>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      {more > 0 && <div className="st" style={{ cursor: "default" }} title="Planned in units-generation/unit-of-work.md; no audit events yet"><span className="g faint">○</span><span className="dim">{more} more planned unit{more === 1 ? "" : "s"} — not started</span></div>}
    </>
  );
}
