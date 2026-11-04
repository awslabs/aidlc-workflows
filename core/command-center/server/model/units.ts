import type { AuditEvent, CatalogStage, CellState, UnitRow } from "../types";
/** Used only when no compiled stage graph says which stages run per unit (absent, or older than `for_each`). */
export const CONSTRUCTION = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation", "build-and-test", "ci-pipeline"];

/**
 * The unit matrix columns: the graph's per-unit (`for_each`) stages in graph order, then any other stage that
 * has recorded unit events (a plugin stage, or one a team configured), in catalog order, else first-seen order.
 */
export function unitStagesOf(catalog: CatalogStage[], events: AuditEvent[]): string[] {
  const perUnit = catalog.filter((c) => c.perUnit).map((c) => c.slug);
  const base = perUnit.length ? perUnit : [...CONSTRUCTION]; // no graph, or one too old to mark for_each
  const seen: string[] = [];
  for (const e of events) { const s = e.fields.Stage; if (e.fields.Unit && s && !base.includes(s) && !seen.includes(s)) seen.push(s); }
  const pos = (s: string) => { const i = catalog.findIndex((c) => c.slug === s); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
  return [...base, ...seen.sort((a, b) => pos(a) - pos(b))];
}

/**
 * The stage that finishes a unit: the last per-unit stage in graph order, so a configured or plugin stage after code
 * generation has to finish too; code generation when no graph marks per-unit stages.
 */
export function unitFinishOf(catalog: CatalogStage[]): string {
  return catalog.filter((c) => c.perUnit).at(-1)?.slug ?? "code-generation";
}

export function buildUnits(events: AuditEvent[], current: { stage: string | null; unit: string | null }, stages: string[] = CONSTRUCTION, finish = "code-generation"): { units: UnitRow[]; planned: number | null; done: number } {
  const rows = new Map<string, UnitRow>();
  const row = (n: string) => { let r = rows.get(n); if (!r) { r = { name: n, batch: null, kind: null, cells: Object.fromEntries(stages.map((s) => [s, "todo" as CellState])) }; rows.set(n, r); } return r; };
  for (const e of events) {
    const u = e.fields.Unit; const s = e.fields.Stage; if (!u || !s || !stages.includes(s)) continue;
    const r = row(u); const c = r.cells[s];
    if (e.event === "UNIT_STARTED" || e.event === "UNIT_RESUMED") r.cells[s] = c === "done" ? c : "running";
    else if (e.event === "UNIT_PAUSED") r.cells[s] = "paused";
    else if (e.event === "UNIT_COMPLETED") r.cells[s] = "done";
    else if (e.event === "REVIEW_COMPLETED" && e.fields.Verdict === "READY" && c !== "done" && c !== "running" && c !== "paused") r.cells[s] = "inferred";
  }
  if (current.unit && current.stage && stages.includes(current.stage)) { const r = row(current.unit); if (r.cells[current.stage] !== "done") r.cells[current.stage] = "running"; }
  const units = [...rows.values()];
  const done = units.filter((u) => u.cells[finish] === "done" || u.cells[finish] === "inferred").length;
  return { units, planned: null, done };
}
