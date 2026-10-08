// What a person reads about a Unit-by-Unit walk, shared by the status line hook
// and `/aidlc --status`. No aidlc-lib import: the status line runs on every
// render, so this stays a few file reads.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The planned Units, in order: the names in the Unit DAG's edge block, or,
// when that file is not there, in the engine's compiled copy of the same DAG
// (runtime-graph.json, the view Construction walks). Empty when neither reads.
function plannedUnits(recordDir: string): string[] {
  try {
    const dag = readFileSync(join(recordDir, "inception", "units-generation", "unit-of-work-dependency.md"), "utf-8");
    const block = /## Machine-Readable Edge Block[\s\S]*?```ya?ml\r?\n([\s\S]*?)```/.exec(dag)?.[1] ?? "";
    return [...block.matchAll(/^\s*-\s+name:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*$/gm)].map((m) => m[1]);
  } catch {
    try {
      const graph = JSON.parse(readFileSync(join(recordDir, "runtime-graph.json"), "utf-8")) as {
        bolt_dag?: { units?: Array<{ name?: unknown }> };
      };
      return (graph.bolt_dag?.units ?? [])
        .map((unit) => unit.name)
        .filter((name): name is string => typeof name === "string" && UNIT_NAME.test(name));
    } catch {
      return [];
    }
  }
}

// Working one Unit at a time, the stage checkboxes tick only once every Unit
// has finished a stage, so the stage count reads 0 until the last Unit. While
// a Unit is still open the count is of Units instead: the one the person is
// on, of the Units planned. A Unit counts as done from its approval
// (GATE_APPROVED at the construction-unit checkpoint) until a later rejection
// of it. Null when the walk is not Unit-by-Unit, the DAG cannot be read, or
// every Unit is done.
export function unitProgress(
  recordDir: string,
  constructionIteration: string,
): { current: number; total: number } | null {
  if (constructionIteration.trim() !== "unit-major") return null;
  try {
    const units = plannedUnits(recordDir);
    if (units.length === 0) return null;
    const rows: Array<{ at: string; approved: boolean; unit: string }> = [];
    const auditDir = join(recordDir, "audit");
    for (const name of readdirSync(auditDir).filter((file) => file.endsWith(".md"))) {
      for (const entry of readFileSync(join(auditDir, name), "utf-8").split(/\n## /)) {
        if (!/^\*\*Checkpoint\*\*: construction-unit$/m.test(entry)) continue;
        const event = /^\*\*Event\*\*:\s*(\S+)/m.exec(entry)?.[1] ?? "";
        if (event !== "GATE_APPROVED" && event !== "GATE_REJECTED") continue;
        const unit = /^\*\*Unit\*\*:\s*(.+)$/m.exec(entry)?.[1]?.trim() ?? "";
        const at = /^\*\*Timestamp\*\*:\s*(.+)$/m.exec(entry)?.[1]?.trim() ?? "";
        rows.push({ at, approved: event === "GATE_APPROVED", unit });
      }
    }
    const done = new Set<string>();
    for (const row of rows.sort((a, b) => a.at.localeCompare(b.at))) {
      if (!units.includes(row.unit)) continue;
      if (row.approved) done.add(row.unit);
      else done.delete(row.unit);
    }
    if (done.size >= units.length) return null;
    return { current: done.size + 1, total: units.length };
  } catch {
    return null;
  }
}
