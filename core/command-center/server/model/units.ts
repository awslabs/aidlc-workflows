import type { AuditEvent, CellState, UnitRow } from "../types";
export const CONSTRUCTION = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation", "build-and-test", "ci-pipeline"];
export function buildUnits(events: AuditEvent[], current: { stage: string | null; unit: string | null }): { units: UnitRow[]; planned: number | null; done: number } {
  const rows = new Map<string, UnitRow>();
  const row = (n: string) => { let r = rows.get(n); if (!r) { r = { name: n, batch: null, kind: null, cells: Object.fromEntries(CONSTRUCTION.map((s) => [s, "todo" as CellState])) }; rows.set(n, r); } return r; };
  for (const e of events) {
    const u = e.fields.Unit; const s = e.fields.Stage; if (!u || !s || !CONSTRUCTION.includes(s)) continue;
    const r = row(u); const c = r.cells[s];
    if (e.event === "UNIT_STARTED" || e.event === "UNIT_RESUMED") r.cells[s] = c === "done" ? c : "running";
    else if (e.event === "UNIT_PAUSED") r.cells[s] = "paused";
    else if (e.event === "UNIT_COMPLETED") r.cells[s] = "done";
    else if (e.event === "REVIEW_COMPLETED" && e.fields.Verdict === "READY" && c !== "done" && c !== "running" && c !== "paused") r.cells[s] = "inferred";
  }
  if (current.unit && current.stage && CONSTRUCTION.includes(current.stage)) { const r = row(current.unit); if (r.cells[current.stage] !== "done") r.cells[current.stage] = "running"; }
  const units = [...rows.values()];
  const done = units.filter((u) => u.cells["code-generation"] === "done" || u.cells["code-generation"] === "inferred").length;
  return { units, planned: null, done };
}
