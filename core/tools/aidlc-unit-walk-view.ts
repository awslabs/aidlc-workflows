// What a person reads about a Unit-by-Unit walk, shared by the status line hook
// and `/aidlc --status`. No aidlc-lib import: the status line runs on every
// render, so this stays a few file reads.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseBoltDag, validateUnitName } from "./aidlc-unit-dag.ts";

// The planned Units, in the order Construction walks them: read from the Unit
// DAG's edge block with the engine's own parser, or, when that file is not
// there, from the engine's compiled copy of the same DAG (runtime-graph.json).
// A file the parser refuses gives none, as the engine reads no Units from it.
function plannedUnits(recordDir: string): string[] {
  let dag: string;
  try {
    dag = readFileSync(join(recordDir, "inception", "units-generation", "unit-of-work-dependency.md"), "utf-8");
  } catch {
    try {
      const graph = JSON.parse(readFileSync(join(recordDir, "runtime-graph.json"), "utf-8")) as {
        bolt_dag?: { units?: Array<{ name?: unknown }> };
      };
      return (graph.bolt_dag?.units ?? [])
        .map((unit) => unit.name)
        .filter((name): name is string => typeof name === "string" && validateUnitName(name) === null);
    } catch {
      return [];
    }
  }
  const parsed = parseBoltDag(dag);
  return parsed.ok ? parsed.batches.flat() : [];
}

// Working one Unit at a time, the stage checkboxes tick only once every Unit
// has finished a stage, so the stage count reads 0 until the last Unit. While
// a Unit is still open the count is of Units instead: the one the person is
// on, of the Units planned. `stepUnit` is the Unit the engine's step on record is
// for (its place in the walk's order is the count, so the count and the step
// beside it agree); without one, the Units done plus one, a Unit counting as
// done from its approval (GATE_APPROVED at the construction-unit checkpoint)
// until a later rejection of it. That fallback, for `/aidlc --status` on
// another record than the work's own, is a light copy of the walk's own rule
// (unitWalkStanding in aidlc-orchestrate.ts, which status reads for the work's
// own record): it misses a skeleton's approval and a walk without checkpoints,
// so the status line counts only with a step. Null
// when the walk is not Unit-by-Unit, the DAG cannot be read, or every Unit is
// done.
export function unitProgress(
  recordDir: string,
  constructionIteration: string,
  stepUnit?: string,
): { current: number; total: number } | null {
  if (constructionIteration.trim() !== "unit-major") return null;
  try {
    const units = plannedUnits(recordDir);
    if (units.length === 0) return null;
    const rows: Array<{ at: string; approved: boolean; unit: string }> = [];
    // The tracked shards, and a claimed team Unit's local record (its whole
    // log; a row in both is counted twice, which changes no Unit's state).
    const listed = (dir: string) =>
      readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => join(dir, file));
    const localDir = join(recordDir, ".aidlc-engine", "audit");
    let local: string[] = [];
    try {
      local = listed(localDir);
    } catch {
      // No claim in this checkout.
    }
    for (const shard of [...listed(join(recordDir, "audit")), ...local]) {
      for (const entry of readFileSync(shard, "utf-8").split(/\n## /)) {
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
    const place = stepUnit === undefined ? -1 : units.indexOf(stepUnit);
    return { current: place === -1 ? done.size + 1 : place + 1, total: units.length };
  } catch {
    return null;
  }
}
