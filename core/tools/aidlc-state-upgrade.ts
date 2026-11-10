// A record an earlier State Version wrote, brought up to the current one in
// place the first time the engine reads it, so work started on an older
// AI-DLC carries on after an update with nothing asked and nothing said.
// One owner: the engine's state read (loadStateFileIfPresent in
// aidlc-orchestrate.ts) calls bringStateUpToDate, and doctor and status read
// hasStateUpgrade and stateUpgradeRecord, so they never disagree with it.
import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import { classifyStateVersion, findStageBySlug, nextInScopeStage } from "./aidlc-lib.ts";
import { isReadOnlyEngineProbe, withAuditLock, writeFileAtomic } from "./aidlc-locks.ts";
import { auditBlockField, getField, readAuditShardEvents, setField, writeStateFile } from "./aidlc-record-core.ts";

export const STATE_UPGRADED_EVENT = "STATE_UPGRADED";

interface StageRename {
  from: string;
  to: string;
  // The names the person read, for the one field that holds a name (Next Action).
  fromName: string;
  toName: string;
}

interface StateUpgrade {
  to: string;
  renamed: StageRename[];
  // No row is written for an added stage: a record without one is the case the
  // engine already places for a stage a newer release adds (a missing row reads
  // as pending, and the move onto it writes it). addedStagesPassedOver reads
  // them from this step's audit row, so work that had just passed one goes back
  // to it.
  added: string[];
}

// Keyed by the version a step starts from. 2.1.x to 2.3.0 wrote 7; 8 renamed
// Application Design to Domain Design and added Contract Design.
const STATE_UPGRADES: Readonly<Record<string, StateUpgrade>> = {
  "7": {
    to: "8",
    renamed: [{ from: "application-design", to: "domain-design", fromName: "Application Design", toName: "Domain Design" }],
    added: ["contract-design"],
  },
};

// The fields that hold one stage slug; the person's own words (Project) are never touched.
const STAGE_FIELDS = ["Current Stage", "Next Stage", "In Progress", "Last Completed Stage", "Parked At Stage"];

export function hasStateUpgrade(version: string): boolean {
  return Object.hasOwn(STATE_UPGRADES, version);
}

function upgradedText(content: string, step: StateUpgrade): string {
  let text = content.replace(/^(- \*\*State Version\*\*:)[ \t]*\S+[ \t]*$/m, `$1 ${step.to}`);
  for (const r of step.renamed) {
    text = text.replace(new RegExp(`^(- \\[[ xSR?-]\\] )${r.from}( \\u2014)`, "gm"), `$1${r.to}$2`);
    for (const field of STAGE_FIELDS) {
      if (getField(text, field) === r.from) text = setField(text, field, r.to);
    }
    const action = getField(text, "Next Action");
    if (action?.includes(r.fromName)) text = setField(text, "Next Action", action.replaceAll(r.fromName, r.toName));
    const skipped = getField(text, "Stages to Skip");
    if (skipped?.includes(`(${r.from}`)) text = setField(text, "Stages to Skip", skipped.replaceAll(`(${r.from}`, `(${r.to}`));
  }
  return text;
}

// Whether an earlier State Version wrote this record, one a step brings up to
// the current one (bringStateUpToDate) the next time the engine reads it.
export function waitsToBeBroughtUp(content: string): boolean {
  const verdict = classifyStateVersion(content);
  return verdict.kind === "past" && hasStateUpgrade(verdict.version);
}

// The content as the current State Version reads it. When the version is one
// a step brings up, the state as it was is kept beside it first
// (aidlc-state.v<N>.md), each renamed stage's record folders move to the new
// name, the state is written and one audit row says what changed. A read-only
// engine probe gets the brought-up text and writes nothing. A write that fails
// leaves the original whole (the copy comes first, the state by rename) and
// this step carries on with the brought-up text; the next one tries again.
export function bringStateUpToDate(
  projectDir: string,
  statePath: string,
  content: string,
  intent?: string,
  space?: string,
): string {
  if (!waitsToBeBroughtUp(content)) return content;
  const verdict = classifyStateVersion(content);
  if (verdict.kind !== "past") return content;
  let text = content;
  let version = verdict.version;
  const renamed: StageRename[] = [];
  const added: string[] = [];
  while (hasStateUpgrade(version)) {
    const step = STATE_UPGRADES[version];
    text = upgradedText(text, step);
    renamed.push(...step.renamed);
    added.push(...step.added);
    version = step.to;
  }
  // The next stage as this graph routes it (a stage the newer graph added comes
  // first), which status reads; a scope the graph does not know keeps its field.
  const after = nextInScopeStage(getField(text, "Current Stage") ?? "", getField(text, "Scope") ?? "", text);
  if (after) text = setField(text, "Next Stage", after.slug);
  if (isReadOnlyEngineProbe()) return text;
  try {
    const recordDir = dirname(statePath);
    const kept = join(recordDir, `aidlc-state.v${verdict.version}.md`);
    if (!existsSync(kept)) writeFileAtomic(kept, content);
    const moved: string[] = [];
    for (const r of renamed) {
      const phase = findStageBySlug(r.to)?.phase;
      for (const parent of [phase, ".aidlc-sensors"]) {
        if (!parent) continue;
        const from = join(recordDir, parent, r.from);
        const to = join(recordDir, parent, r.to);
        if (!existsSync(from) || existsSync(to)) continue;
        renameSync(from, to);
        moved.push(`${parent}/${r.from} to ${parent}/${r.to}`);
      }
    }
    withAuditLock(projectDir, () => {
      writeStateFile(projectDir, text, intent, space);
      appendAuditEntryUnlocked("STATE_UPGRADED", {
        From: verdict.version,
        To: version,
        Renamed: renamed.map((r) => `${r.from} to ${r.to}`).join(", "),
        "Stages added": added.join(", "),
        Moved: moved.length > 0 ? moved.join(", ") : "none",
        Original: basename(kept),
      }, projectDir, intent, space);
    }, intent, space);
  } catch {
    // The original stays as it was; the next step tries again.
  }
  return text;
}

// The latest bring-up the record holds, for doctor and status to show on purpose.
export function stateUpgradeRecord(
  projectDir: string,
  intent?: string,
  space?: string,
): { from: string; date: string; original: string } | null {
  try {
    const row = readAuditShardEvents(projectDir, intent, space)
      .filter((e) => e.event === STATE_UPGRADED_EVENT)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .at(-1);
    if (!row) return null;
    return {
      from: auditBlockField(row.block, "From") ?? "",
      date: row.timestamp.slice(0, 10),
      original: auditBlockField(row.block, "Original") ?? "",
    };
  } catch {
    return null;
  }
}
