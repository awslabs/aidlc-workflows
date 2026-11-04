import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isPerUnitStage, relativeSpaceRecordPrefix } from "./aidlc-lib.ts";

// `<prefix>/construction/<unit>/<stage>/memory.md`: one Unit's own diary for a
// per-Unit stage, the path a per-Unit wave entry and the run-stage directive
// name.
export function unitMemoryPath(stageSlug: string, unit: string, recordPrefix: string | null): string {
  return `${recordPrefix ?? relativeSpaceRecordPrefix()}/construction/${unit}/${stageSlug}/memory.md`;
}

// A per-Unit stage's step for a named Unit keeps its notes in the Unit's own
// folder, whoever owns the Unit, so `construction/` holds Unit folders and only
// the stage-level stages' folders. Null when the stage-level diary
// applies. The run-stage directive and the learnings step both read it here.
export function unitStageMemoryPath(
  stage: { slug: string; for_each?: string },
  unit: string | null,
  recordPrefix: string | null,
): string | null {
  if (!unit || !isPerUnitStage(stage)) return null;
  return unitMemoryPath(stage.slug, unit, recordPrefix);
}

// The texts of a per-Unit stage's Unit diaries under the record dir `record`:
// the named Unit's, or every Unit's in name order. Work started before the
// notes moved keeps the stage-level diary too; the reader reads it as well.
export function unitStageDiaryTexts(record: string, slug: string, unit: string | null): string[] {
  const construction = join(record, "construction");
  let units = unit ? [unit] : [];
  if (!unit) {
    try {
      units = readdirSync(construction).sort();
    } catch {
      units = [];
    }
  }
  return units
    .map((name) => join(construction, name, slug, "memory.md"))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf-8"));
}

// An older stage-level diary without the copies a wave Unit's completion made
// of that Unit's own notes (each copied line followed by its
// `<!-- aidlc-wave-memory:... -->` marker): the Unit's own diary is read now,
// so a copy would count its note twice.
export function withoutWaveCopies(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^[^\n]*\n<!-- aidlc-wave-memory:[^\n]*-->[ \t]*$/gm, "");
}
