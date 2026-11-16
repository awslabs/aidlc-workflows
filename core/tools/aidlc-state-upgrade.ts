// A record an earlier State Version wrote, brought up to the current one in
// place the first time the engine reads it, so work started on an older
// AI-DLC carries on after an update with nothing asked and nothing said.
// One owner: the engine's state read (loadStateFileIfPresent in
// aidlc-orchestrate.ts) calls bringStateUpToDate, and doctor and status read
// hasStateUpgrade and stateUpgradeRecord, so they never disagree with it.
// A record a newer AI-DLC wrote is never brought down: newerStateStep names
// the release it needs and the person's step, for next, report, doctor and the
// unit commands alike.
// Which State Version a record carries is owned here too: the versions this
// build reads (classifyStateVersion) and the one write that raises a record
// to the team version (recordHomeLocation).
import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import { findStageBySlug, nextInScopeStage, setOrInsertField } from "./aidlc-lib.ts";
import { isReadOnlyEngineProbe, withAuditLock, writeFileAtomic } from "./aidlc-locks.ts";
import { auditBlockField, getField, readAuditShardEvents, setField, writeStateFile } from "./aidlc-record-core.ts";
import { packageManagerForExecutable } from "./aidlc-install-paths.ts";
import { releaseHostLabel } from "./aidlc-release.ts";
import { aidlcInvocation, compiledExecutable, entrySkillInvocation, runtimeHarnessName, typedHarnessName } from "./aidlc-runtime-paths.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";
import { HOME_LOCATION_FIELD } from "./aidlc-unit-teams.ts";

// -----------------------------------------------------------------------------
// State-schema-version classification (shared by runtime + doctor)
// -----------------------------------------------------------------------------
// The persisted `aidlc-state.md` carries a `- **State Version**: N` line naming
// the state-graph schema the workflow was created under. v8 renamed the Inception
// `application-design` stage to `domain-design` and inserted `contract-design`,
// so a pre-v8 state file's stage rows no longer match the compiled graph. The
// engine's state read brings a version a step covers up in place
// (bringStateUpToDate, below); a state no step covers must be refused up front by
// BOTH runtime commands (aidlc-orchestrate.ts `next`/`report`) and by
// `aidlc --doctor`, and both callers must classify the state identically; otherwise the doctor and the
// runtime disagree on whether a state is "malformed" vs "future" vs "past".
// classifyStateVersion() is the single source of truth for that classification,
// so a new schema bump only touches the versions in this file.

/** The current state-graph schema version. Bump when the graph adds/renames/removes rows. */
export const CURRENT_STATE_VERSION = "8";

// Team work that records where its home is says 9, written with that record
// (recordHomeLocation): 2.11 has no Home Location and would build its Units on
// main's older team flow, so the version is what it stops at. Every other
// record keeps CURRENT_STATE_VERSION, and this build reads both.
export const TEAM_STATE_VERSION = "9";

export type StateVersionClassification =
  | { kind: "ok"; version: string }
  | { kind: "unparseable"; message: string }
  | { kind: "past"; version: string; message: string }
  | { kind: "future"; version: string; message: string };

/**
 * Classify a state-file's `State Version` field.
 *
 * `unparseable` covers: missing field, empty value, non-numeric token, or
 * trailing content after the numeric token (e.g. `State Version: 8 garbage`).
 * `past`/`future` cover explicit numeric versions on either side of the current
 * one. `ok` is the current version with no trailing content.
 *
 * The parser uses horizontal whitespace only (`[ \t]*`) to avoid a `\s*` regex
 * that would span the newline after an empty value and capture the leading `-`
 * of the next state bullet as a bogus version. The tail is anchored to the end
 * of the line, so trailing content on the value line is rejected: a schema
 * token must be a bare integer on its own line.
 */
export function classifyStateVersion(stateContent: string): StateVersionClassification {
  const unparseableMessage =
    "Incompatible workflow state: the State Version field is missing, empty, " +
    "or unparseable in aidlc-state.md, so this state cannot be matched to the " +
    `current v${CURRENT_STATE_VERSION} stage graph and cannot be advanced safely. ` +
    "Put its `- **State Version**:` line back as it was (git has it if the file " +
    `was committed), then try again. Run \`${entrySkillInvocation()} --doctor\` for the full diagnosis.`;
  // Anchor the tail with `[ \t]*$`: the schema token is a bare integer with
  // no trailing content on the line, so `State Version: 8 garbage` fails to
  // match and falls into the unparseable branch.
  const versionMatch = stateContent.match(/^- \*\*State Version\*\*:[ \t]*(\S+)[ \t]*$/m);
  if (versionMatch === null) return { kind: "unparseable", message: unparseableMessage };
  const v = versionMatch[1];
  if (!/^\d+$/.test(v)) return { kind: "unparseable", message: unparseableMessage };
  if (v === CURRENT_STATE_VERSION || v === TEAM_STATE_VERSION) return { kind: "ok", version: v };
  if (Number(v) > Number(TEAM_STATE_VERSION)) {
    return {
      kind: "future",
      version: v,
      message:
        `Incompatible workflow state: State Version ${v} is newer than the ` +
        `current v${CURRENT_STATE_VERSION} stage graph this build understands, so ` +
        "it cannot be advanced safely. Upgrade the framework to a build that ships " +
        `state schema v${v} (or newer), or finish this workflow on the shell that ` +
        `produced it. Run \`${entrySkillInvocation()} --doctor\` for the full diagnosis.`,
    };
  }
  return {
    kind: "past",
    version: v,
    message:
      `Incompatible workflow state: State Version ${v} predates the current ` +
      `v${CURRENT_STATE_VERSION} stage graph. v8 renamed the Inception ` +
      "`application-design` stage to `domain-design` and inserted " +
      "`contract-design`, so this state's stage rows no longer match the graph " +
      "and cannot be advanced safely. Finish this workflow on the prior shell. " +
      `Run \`${entrySkillInvocation()} --doctor\` for the full diagnosis.`,
  };
}

// The home recorded on a piece of work, and with it the version an older
// AI-DLC stops at: 8 becomes 9 in the same write. A 7 is brought up by its own
// step (bringStateUpToDate), and a version this build does not know is kept.
export function recordHomeLocation(content: string, home: string): string {
  const text = setOrInsertField(content, "## Runtime State", HOME_LOCATION_FIELD, home);
  const verdict = classifyStateVersion(text);
  return verdict.kind === "ok" && verdict.version === CURRENT_STATE_VERSION
    ? setField(text, "State Version", TEAM_STATE_VERSION)
    : text;
}

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

// --- A record a newer AI-DLC wrote ---
//
// The first release that writes each State Version newer than this build
// reads, so the person hears which AI-DLC their teammate's work needs. 2.12
// writes 9 on team work (#2783). The schema names the first release that
// writes it, never the one that did, so it is said "or newer".
export const STATE_VERSION_RELEASES: Readonly<Record<string, string>> = Object.freeze({ "9": "2.12" });

/** The AI-DLC a newer State Version needs, as the person reads it. */
export function newerStateRelease(version: string): string {
  return Object.hasOwn(STATE_VERSION_RELEASES, version)
    ? `AI-DLC ${STATE_VERSION_RELEASES[version]} or newer`
    : "a newer AI-DLC";
}

/**
 * How this computer gets a newer AI-DLC: the native `aidlc` updates itself; a
 * copy installed by hand, a pinned project and a package manager's install
 * each have their own step, which AI-DLC names and never takes for them.
 */
export type NewerWorkInstall =
  | { kind: "native" }
  | { kind: "copy" }
  | { kind: "pinned" }
  | { kind: "managed"; name: string; remediation: string };

export function newerWorkInstall(projectDir: string): NewerWorkInstall {
  if (aidlcInvocation() !== "aidlc") return { kind: "copy" };
  if (existsSync(join(projectDir, ".aidlc-version"))) return { kind: "pinned" };
  const executable = compiledExecutable();
  const manager = executable ? packageManagerForExecutable(executable) : null;
  return manager ? { kind: "managed", ...manager } : { kind: "native" };
}

// The project's own refresh, for the harness this runs in.
function refreshCommand(projectDir: string): string {
  return `${aidlcInvocation()} config --harness ${typedHarnessName(runtimeHarnessName(projectDir))}`;
}

/** The refresh the update is followed by, as the agent runs it. */
export function newerWorkRefresh(projectDir: string): string {
  return `${refreshCommand(projectDir)} --yes`;
}

/** What the work's first sentence names: the plan asked about, or the work selected when the request is new work. */
export function newerWorkLead(version: string, newWork = false): string {
  return `${newWork ? "The work selected here" : "This plan"} was set up with ${newerStateRelease(version)}`;
}

// The release host a copy's runtime comes from, as config names it; an
// unreadable machine setting names the configured mirror.
function releaseHost(): string {
  try {
    return releaseHostLabel();
  } catch {
    return "the configured release mirror";
  }
}

/**
 * The person's one line for a record a newer AI-DLC wrote, with this
 * install's one step to carry on: for every place that cannot ask (doctor,
 * the terminal unit commands, and the installs AI-DLC does not update itself).
 */
export function newerStateStep(projectDir: string, version: string, newWork = false): string {
  return newerWorkStep(projectDir, newerWorkLead(version, newWork), newerStateRelease(version));
}

// The same step for a plan whose format number is above this release's: the
// release is named by no table, so it is "a newer AI-DLC".
export function newerPlanStep(projectDir: string): string {
  return newerWorkStep(projectDir, "This plan was set up with a newer AI-DLC", "a newer AI-DLC");
}

// The same step for a Unit's record a newer AI-DLC wrote (its unit.json is
// of a version above this release's): the take writes nothing over it.
export function newerRecordStep(projectDir: string, unit: string, repo: string): string {
  return newerWorkStep(projectDir, `${unit}'s record in ${repo} was written by a newer AI-DLC`, "a newer AI-DLC");
}

function newerWorkStep(projectDir: string, lead: string, needs: string): string {
  const install = newerWorkInstall(projectDir);
  const refresh = `\`${newerWorkRefresh(projectDir)}\``;
  switch (install.kind) {
    case "copy":
      return `${lead}, and this project has AI-DLC ${AIDLC_VERSION}, copied in by hand. To carry on, get the copy ` +
        `runtime of ${needs} (aidlc-copy-runtime-<version>.tar.gz and its .sha256, from the releases on ` +
        `${releaseHost()}) into one folder, then run \`${refreshCommand(projectDir)} --from <that file>\` in this project.`;
    case "pinned":
      return `${lead}, and this project is pinned to AI-DLC ${AIDLC_VERSION} in .aidlc-version. To carry on, pin it ` +
        `to the release your teammate uses with \`${aidlcInvocation()} config --pin <that version> --yes\`; the pin changes for ` +
        "everyone on the project.";
    case "managed":
      return `${lead}, and this computer has ${AIDLC_VERSION} from ${install.name}. To carry on: ` +
        `${install.remediation}, then ${refresh} in this project.`;
    default:
      return `${lead}, and this computer has ${AIDLC_VERSION}. To carry on: \`aidlc update\`, then ${refresh} in ` +
        "this project.";
  }
}
