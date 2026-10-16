// outcomes.ts - what a live test asserts: what the person meets or what the
// engine recorded, never the route the agent happened to take (which file it
// read first, how many commands it typed, how it worded a menu). Two runs a
// person cannot tell apart pass or fail together.
//
// Whether each decision recorded as the person's has a reply of theirs behind
// it is the person-turn check every driver already runs (person-turns.ts); it
// has no second version here.

type EngineReader = Pick<
  typeof import("../../dist/claude/.claude/tools/aidlc-lib.ts"),
  "auditBlockField" | "readAuditShardEvents" | "parseStateStageSuffixes" | "parseCheckboxes"
>;
let reader: EngineReader | undefined;
// The engine's own readers, loaded on first use, as person-turns.ts loads them.
function engine(): EngineReader {
  reader ??= require("../../dist/claude/.claude/tools/aidlc-lib.ts") as EngineReader;
  return reader;
}

/**
 * How many `event` rows the active work's audit holds for `stage`; with
 * `workflow`, only that workflow's (a `--single` run's is `single-stage:<stage>`).
 */
export function stageEvents(projectDir: string, event: string, stage: string, workflow?: string): number {
  const { auditBlockField, readAuditShardEvents } = engine();
  return readAuditShardEvents(projectDir).filter((row) =>
    row.event === event &&
    auditBlockField(row.block, "Stage") === stage &&
    (workflow === undefined || auditBlockField(row.block, "Workflow") === workflow)
  ).length;
}

/** The stages whose plan action turned SKIP between two state files, sorted. */
export function newlySkipped(before: string, after: string): string[] {
  const { parseStateStageSuffixes } = engine();
  const was = parseStateStageSuffixes(before);
  return [...parseStateStageSuffixes(after)]
    .filter(([slug, action]) => action === "SKIP" && was.get(slug) !== "SKIP")
    .map(([slug]) => slug)
    .sort();
}

/**
 * The stages whose run state changed between two state files, except the
 * `current` stage starting (pending to in-progress): the agent carrying on
 * into the stage the work stands at.
 */
export function markersChanged(before: string, after: string, current?: string): string[] {
  const { parseCheckboxes } = engine();
  const was = new Map(parseCheckboxes(before).map((line) => [line.slug, line.state]));
  return parseCheckboxes(after)
    .filter((line) => line.state !== was.get(line.slug) &&
      !(line.slug === current && was.get(line.slug) === "pending" && line.state === "in-progress"))
    .map((line) => line.slug);
}

