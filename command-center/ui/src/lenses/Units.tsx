import type { CellState, UnitRow } from "../../../../core/command-center/server/types";
import { phaseName } from "../format";
import { CONSTRUCTION, sortUnits, unitLabel } from "../intent/derive";
import type { XLensProps } from "./common";

const INFERRED = "Inferred from artifacts plus a READY review for this unit; no UNIT_COMPLETED event was recorded";
function Cell({ c }: { c: CellState | undefined }) {
  switch (c) {
    case "done": return <span className="cell c-done" title="UNIT_COMPLETED recorded">✓</span>;
    case "inferred": return <span className="cell c-done inf" title={INFERRED}>✓ inferred</span>;
    case "running": return <span className="cell c-run">▶ running</span>;
    case "waiting": return <span className="cell c-wait" title="Waiting on you">? waiting</span>;
    case "paused": return <span className="cell c-na" title="UNIT_PAUSED with no later resume">⏸ paused</span>;
    case "na": return <span className="cell c-na" title="The unit's kind prunes this stage">— n/a</span>;
    default: return <span className="cell c-todo" title="Not started">○</span>;
  }
}
/** Where a unit row opens in the Story: its live cell, else its furthest started cell, else functional-design. */
function focusStage(u: UnitRow, cols: string[]): string {
  const live = cols.find((s) => u.cells[s] === "waiting" || u.cells[s] === "running" || u.cells[s] === "paused");
  if (live) return live;
  return [...cols].reverse().find((s) => u.cells[s] === "done" || u.cells[s] === "inferred") ?? cols[0]!;
}

/** Unit × construction-stage matrix. */
export function Units({ model: m, filter, selUnit, onSelect }: XLensProps) {
  const units = sortUnits(m.units);
  const cols = m.unitStages?.length ? m.unitStages : CONSTRUCTION;
  const more = m.unitsPlanned !== null ? m.unitsPlanned - units.length : null;
  return (
    <div data-loaded="">
      {filter.phase && filter.phase !== "construction" && <div className="dim" style={{ fontSize: ".86rem", marginBottom: 8 }}>Units run in Construction, so {phaseName(filter.phase)} has none — the matrix below is the whole intent's.</div>}
      <table>
        <thead><tr><th>Unit</th>{cols.map((s) => <th key={s} title={s}>{unitLabel(s, m.stages)}</th>)}</tr></thead>
        <tbody>
          {units.map((u) => (
            <tr key={u.name} className="clk" title="Open this unit's Story" onClick={() => onSelect(focusStage(u, cols), u.name)}
              style={u.name === selUnit ? { outline: "1px solid var(--run)", outlineOffset: -1 } : undefined}>
              <td><b>{u.name}</b><br /><span className="faint mono" title={u.batch === null ? "No batch recorded for this unit" : undefined}>{u.batch !== null ? `batch ${u.batch}` : "batch —"}{u.kind ? ` · ${u.kind}` : ""}</span></td>
              {cols.map((s) => <td key={s}><Cell c={u.cells[s]} /></td>)}
            </tr>
          ))}
          {!units.length && <tr><td colSpan={8} className="dim">No unit has started yet.</td></tr>}
          {more !== null && more > 0 && <tr><td colSpan={8} className="dim" title={`${m.unitsPlanned} units planned at units-generation`}>○ {more} more unit{more === 1 ? "" : "s"} — not started</td></tr>}
          {m.unitsPlanned === null && <tr><td colSpan={8} className="faint" title="No unit plan was found in the record">Planned unit count — not recorded</td></tr>}
        </tbody>
      </table>
      <div className="dim" style={{ fontSize: ".82rem", marginTop: 8 }}>Cells come from UNIT_* events; where those are missing, a cell is marked <span className="inf">inferred</span> from artifacts plus a READY review. “n/a” = the unit's kind prunes that stage.</div>
    </div>
  );
}
