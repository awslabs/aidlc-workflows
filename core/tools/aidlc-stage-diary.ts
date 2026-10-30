import { isPerUnitStage, relativeSpaceRecordPrefix } from "./aidlc-lib.ts";
import { isTeamUnitOwnership } from "./aidlc-record-core.ts";

// `<prefix>/construction/<unit>/<stage>/memory.md`: one Unit's own diary for a
// per-Unit stage, the one path every caller builds it from.
export function unitMemoryPath(stageSlug: string, unit: string, recordPrefix: string | null): string {
  return `${recordPrefix ?? relativeSpaceRecordPrefix()}/construction/${unit}/${stageSlug}/memory.md`;
}

// Under Unit Ownership: team a Unit's per-Unit stage runs in the Unit's claimed
// checkout, which lands only the Unit's own record tree (publish leaves a
// stage-level diary out of the candidate, and pin refuses it there), so its
// diary is the Unit's own. Null when the stage-level diary applies. The
// run-stage directive and the learnings step both read it here.
export function teamUnitMemoryPath(
  stage: { slug: string; for_each?: string },
  unit: string | null,
  stateContent: string | null,
  recordPrefix: string | null,
): string | null {
  if (!unit || !isTeamUnitOwnership(stateContent) || !isPerUnitStage(stage)) return null;
  return unitMemoryPath(stage.slug, unit, recordPrefix);
}
