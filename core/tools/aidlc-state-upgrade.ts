// A record an earlier State Version wrote, brought up to the current one in
// place the first time the engine reads it, so work started on an older
// AI-DLC carries on after an update with nothing asked and nothing said.
// One owner: the engine's state read (loadStateFileIfPresent in
// aidlc-orchestrate.ts) calls bringStateUpToDate, and doctor and status read
// hasStateUpgrade and stateUpgradeRecord, so they never disagree with it.
// A record a newer AI-DLC wrote is never brought down: newerStateStep names
// the release it needs and the person's step, for next, report, doctor and the
// unit commands alike.
import { existsSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import { classifyStateVersion, findStageBySlug, nextInScopeStage } from "./aidlc-lib.ts";
import { isReadOnlyEngineProbe, withAuditLock, writeFileAtomic } from "./aidlc-locks.ts";
import { auditBlockField, getField, readAuditShardEvents, setField, writeStateFile } from "./aidlc-record-core.ts";
import { packageManagerForExecutable } from "./aidlc-install-paths.ts";
import { releaseHostLabel } from "./aidlc-release.ts";
import { aidlcInvocation, compiledExecutable, runtimeHarnessName, typedHarnessName } from "./aidlc-runtime-paths.ts";
import { AIDLC_VERSION } from "./aidlc-version.ts";

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
  const lead = newerWorkLead(version, newWork);
  const needs = newerStateRelease(version);
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
      return `${lead}, and this computer has ${AIDLC_VERSION} from ${install.name}. ` +
        carryOnStep(install, "`aidlc update`", refresh);
    default:
      return `${lead}, and this computer has ${AIDLC_VERSION}. ${carryOnStep(install, "`aidlc update`", refresh)}`;
  }
}

/** The one step to a newer AI-DLC: `update` natively, a package manager's own update, then `refresh`. */
export function carryOnStep(install: NewerWorkInstall, update: string, refresh: string, how = ""): string {
  return `To carry on${how}: ${install.kind === "managed" ? install.remediation : update}, then ${refresh} in this project.`;
}
