// Teams building each Unit as a piece of work of their own (#2410): where the
// home is, what the Unit plan says about each Unit (likely repos, what it waits
// on), which Units the lead's own walk leaves for takes, and a Unit's build. Built on
// aidlc-lib.ts, which requires it lazily where its own functions need it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactFilename } from "./aidlc-artifact-vocabulary.ts";
import {
  type AuditShardEvent,
  auditBlockField,
  type BoltDagResolution,
  committedTextBytes,
  docsRoot,
  ENGINE_DIR,
  engineDir,
  filterProducesByKind,
  getField,
  intentDisplayLabel,
  intentRepos,
  intentsDir,
  isPerUnitStage,
  isTeamUnitOwnership,
  LEARNINGS_CORRECTION_CHOICES,
  listIntentDirs,
  loadScopeMapping,
  loadStageGraphAll,
  markdownBlocks,
  parseBoltDag,
  readAtomicReplacedFileNoFollowOrThrow,
  readAuditShardEvents,
  readRecordedSourceCheckouts,
  readStateFile,
  recordedCheckoutOfListingPath,
  removeRecordFileNoFollow,
  repoDir,
  REQUEST_TEXT_DIR,
  sourceCheckoutListingRel,
  stateDigest,
  UNIT_GATE_RHYTHM_FIELD,
  unitDependencyPath,
  writeEngineFileNoFollow,
} from "./aidlc-lib.ts";
import { visibleMarkdownLines } from "./aidlc-markdown.ts";
import { applicableTeamUnitScopeStamp, idSuffix, listIntents } from "./aidlc-record-core.ts";
import { gitAddressKey } from "./aidlc-workspace-repos.ts";
import { withoutCredentials } from "./aidlc-workspace-manifest.ts";

// Where the home of team-built work is: the address the workspace's own
// remote points to (origin, else its one remote; read, never set, with any user
// and token left out), or "local" for a workspace with no remote. Recorded once, when teams are chosen; every copy of the workspace
// reads it. Its presence puts the work on teams building each Unit as a piece of
// work of their own; team work without it keeps the claim, publish, pin, gate
// and land flow it started on.
export const HOME_LOCATION_FIELD = "Home Location";

// Who settled a piece of work's project type (aidlc-utility.ts reads it); a
// Unit's build takes the type its home settled.
export const PROJECT_TYPE_SOURCE_FIELD = "Project Type Source";
export const PROJECT_TYPE_SOURCE_HOME = "the home";

export function homeLocation(stateContent: string | null): string | null {
  const value = stateContent === null ? null : getField(stateContent, HOME_LOCATION_FIELD)?.trim();
  return value ? value : null;
}

// The offer to approve each team's Unit once at its end instead of after every
// stage, said with the step of a Unit the lead's walk builds and put on the
// lead's board, while it can still change (unitGateRhythmCanBe).
export const TEAM_RHYTHM_OFFER = "Each team will approve its Unit after every stage. Do you want them to approve once " +
  "at the end of each Unit instead? I'd keep after every stage, so a wrong turn is caught at the stage where it happens.";

// The offer is put only until the lead answers it: either answer runs the
// setter, which records the rhythm, so nothing asks it again.
export function unitGateRhythmChosen(stateContent: string): boolean {
  return getField(stateContent, UNIT_GATE_RHYTHM_FIELD) !== null;
}

// Which team flow new team work takes, decided once as teams are chosen: the
// build-out (assign, take, push, the team's own merge) for work whose code is
// in repos of its own, recorded for the work, where main's landing cannot
// carry it; main's claim, publish, pin, gate and land for work whose code is
// the workspace's own repo. The Home Location to record, or null for main's
// flow. `teammateTook`: a teammate took a Unit of solo work (switchSoloToTeams),
// which only the build-out carries, so the home is recorded on one repo too.
export function buildOutHomeLocation(projectDir: string, teammateTook = false): string | null {
  return teammateTook || intentRepos(projectDir).length > 0 ? workspaceHomeLocation(projectDir) : null;
}

// What to record as the home's location for a workspace, or null when it is not
// a git repo (teams then keep today's flow in one checkout).
export function workspaceHomeLocation(projectDir: string): string | null {
  if (!existsSync(join(projectDir, ".git"))) return null;
  const read = (args: string[]): string => spawnSync("git", args, { cwd: projectDir, encoding: "utf-8" }).stdout?.trim() ?? "";
  const remotes = read(["remote"]).split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
  const address = remote === null ? "" : read(["remote", "get-url", remote]);
  return address ? withoutCredentials(address.trim()) : "local";
}

// Each Unit's likely repos, as Units Generation proposed them (a guide only),
// read from the authored units block. Empty when the block names none or
// cannot be read.
export function unitLikelyRepos(projectDir: string, intent?: string, space?: string): Map<string, string[]> {
  try {
    return unitLikelyReposFrom(readFileSync(unitDependencyPath(projectDir, intent, space), "utf-8"));
  } catch {
    // No units block yet.
    return new Map();
  }
}

// The same, from a Unit plan's own text.
export function unitLikelyReposFrom(dependencyBody: string): Map<string, string[]> {
  const likely = new Map<string, string[]>();
  const parsed = parseBoltDag(dependencyBody);
  if (!parsed.ok) return likely;
  for (const unit of parsed.units) {
    if (unit.repos !== undefined && unit.repos.length > 0) likely.set(unit.name, unit.repos);
  }
  return likely;
}

// Each Unit's direct dependencies, from the authored units block.
export function unitDependencies(projectDir: string, intent?: string, space?: string): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  try {
    const parsed = parseBoltDag(readFileSync(unitDependencyPath(projectDir, intent, space), "utf-8"));
    if (parsed.ok) for (const unit of parsed.units) deps.set(unit.name, unit.depends_on);
  } catch {
    // No units block yet.
  }
  return deps;
}

// The given Units in the order the person's plan writes them.
export function unitsInPlanOrder(projectDir: string, units: readonly string[]): string[] {
  return [...unitDependencies(projectDir).keys(), ...units].filter((unit, at, all) =>
    units.includes(unit) && all.indexOf(unit) === at);
}

// The rows since the person last chose teams, in time order, and whether a
// Unit started at the lead's project before that (UNIT_STARTED): work that was
// built one Unit at a time first, or switched to teams by a teammate's take.
function sinceTeams(rows: readonly AuditShardEvent[]): { after: AuditShardEvent[]; startedBefore: boolean } {
  const ordered = [...rows].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  let teamsAt = -1;
  ordered.forEach((row, at) => {
    if (row.event === "UNIT_OWNERSHIP_SET" && auditBlockField(row.block, "Mode") === "team") teamsAt = at;
  });
  return { after: ordered.slice(teamsAt + 1), startedBefore: ordered.slice(0, Math.max(teamsAt, 0)).some((row) => row.event === "UNIT_STARTED") };
}

function listField(block: string, name: string): string[] {
  const value = auditBlockField(block, name);
  return value === null || value === "none" ? [] : value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

// Whether a Unit started at the lead's project before teams were chosen: the
// lead was building the work one Unit at a time first.
export function unitStartedBeforeTeams(rows: readonly AuditShardEvent[]): boolean {
  return sinceTeams(rows).startedBefore;
}

// The Units the lead asked to build at the lead's project (`assign --here`)
// since teams were chosen.
export function unitsAskedHere(rows: readonly AuditShardEvent[]): Set<string> {
  const here = new Set<string>();
  for (const row of sinceTeams(rows).after) {
    if (row.event === "UNITS_ASSIGNED") for (const unit of listField(row.block, "Here")) here.add(unit);
  }
  return here;
}

// The Units the lead's own walk leaves for anyone to take: every Unit but the
// walking skeleton, the lead's own build-here claims (`own`), a Unit asked
// here whose claim was never written, and one the lead's project builds with
// no claim of its own (leadBuildsWithoutClaim, as the take reads it). A released claim on a Unit asked here
// is open again. Where the lead's walk keeps every Unit nobody took
// (`keepsWalk`: a Unit started at the lead's project before teams, or teams
// that came from a teammate's take of solo work, where the lead was never
// asked), only such a released Unit is left.
export function unitsLeftForTakes(
  rows: readonly AuditShardEvent[],
  units: readonly string[],
  skeleton: string | null,
  claims: ReadonlyMap<string, { status: string }>,
  own: ReadonlySet<string>,
  keepsWalk: boolean,
): Set<string> {
  const here = unitsAskedHere(rows);
  if (keepsWalk) {
    return new Set(units.filter((unit) => here.has(unit) && claims.get(unit)?.status === "released"));
  }
  return new Set(units.filter((unit) => unit !== skeleton && !own.has(unit) && !(here.has(unit) && !claims.has(unit)) &&
    !leadBuildsWithoutClaim(rows, unit, claims.get(unit))));
}

// A Unit the lead's project started and builds with no claim of its own: none
// at all, or a released one on a Unit the lead never asked to build here (the
// claim `assign --here` wrote is the one its release gives up).
export function leadBuildsWithoutClaim(
  rows: readonly AuditShardEvent[],
  unit: string,
  claim: { status: string } | null | undefined,
): boolean {
  if (claim?.status === "claimed" || !unitsStartedAtLeadsProject(rows).has(unit)) return false;
  return claim === null || claim === undefined || !unitsAskedHere(rows).has(unit);
}

// A team's build that follows the lead's rules too (Arden's call): the lead's
// practices (memory/team.md) and project rules (memory/project.md),
// each read where it is and never written from the build, and loaded before
// the team's own file of the same name, so the team's own are on top. The
// field lists the lead's files that hold any.
export const LEAD_RULES_FIELD = "Lead Project Rules";

// The lead's rules a team's take can follow: the files, as LEAD_RULES_FIELD
// records them, and the headings of each that hold one of the lead's own, not
// only the template's notes, for the take question to name. `read` reads a
// path of the lead's workspace: this checkout's file, or the lead's commit
// when the lead's project is reached by its address.
export function leadRules(
  projectDir: string,
  homeSpace: string,
  read: (rel: string) => string | null = (rel) => readTextOrNull(join(projectDir, ...rel.split("/"))),
): { paths: string[]; practices: string[]; project: string[] } {
  const path = (file: string) => `aidlc/spaces/${homeSpace}/memory/${file}`;
  const practices = memoryRuleNames(read(path("team.md")));
  const project = memoryRuleNames(read(path("project.md")));
  return {
    paths: [...(practices.length > 0 ? [path("team.md")] : []), ...(project.length > 0 ? [path("project.md")] : [])],
    practices,
    project,
  };
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// A lead's project address git is given, as opposed to a remote's name.
export function isGitAddress(target: string): boolean {
  return /[:/\\]/.test(target);
}

// Where the lead's copy of their workspace is kept in a team's workspace that
// reaches the lead's project by its address (aidlc-unit take).
export function leadCopyRef(homeId8: string): string {
  return `refs/aidlc/home/${homeId8}/integration`;
}

// The commit of the lead's copy here, or null when it is not here.
export function leadCopyAt(projectDir: string, homeId8: string): string | null {
  const read = spawnSync("git", ["rev-parse", "--verify", "--quiet", leadCopyRef(homeId8)], { cwd: projectDir, encoding: "utf-8" });
  return read.status === 0 && read.stdout.trim() !== "" ? read.stdout.trim() : null;
}

// A path of the lead's workspace at a commit here, or null.
export function textAt(projectDir: string, commit: string, rel: string): string | null {
  const shown = spawnSync("git", ["show", `${commit}:${rel}`, "--"], { cwd: projectDir, encoding: "utf-8" });
  return shown.status === 0 ? shown.stdout : null;
}

// The lead's files a team's build follows (LEAD_RULES_FIELD), each read where
// it is: in this checkout when the lead's record is here, else in the lead's
// copy AI-DLC fetched with the claims (leadCopyRef), at the same paths, so the
// team's own default memory is never read as the lead's. `text` is null for a
// file that cannot be read now; `fromCopy` marks one read from the copy.
export function leadRuleFiles(projectDir: string, stateContent: string): Array<{ path: string; text: string | null; fromCopy: boolean }> {
  const paths = (getField(stateContent, LEAD_RULES_FIELD) ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (paths.length === 0) return [];
  const build = unitBuildOf(stateContent);
  if (build === null || leadRecordHere(projectDir, build.homeRecord) || !isGitAddress(build.homeLocation)) {
    return paths.map((path) => ({ path, text: readTextOrNull(join(projectDir, ...path.split("/"))), fromCopy: false }));
  }
  const copy = leadCopyRef(idSuffix(build.homeWork));
  return paths.map((path) => ({ path, text: textAt(projectDir, copy, path), fromCopy: true }));
}

// Whether the lead's record (`<space>/<dirName>`, a build's Home Record) is in
// this workspace: a clone of the lead's, or the lead's own. A record name
// without a space is taken as here, so nothing is read from elsewhere for it.
export function leadRecordHere(projectDir: string, homeRecord: string): boolean {
  const at = homeRecord.indexOf("/");
  return at < 0 || existsSync(join(intentsDir(projectDir, homeRecord.slice(0, at)), homeRecord.slice(at + 1), "aidlc-state.md"));
}

// The line said once when a lead's file the build follows cannot be read: the
// step goes on under the team's own rules. Null when every one was read.
export function leadRulesUnreadLine(projectDir: string, stateContent: string): string | null {
  const unread = leadRuleFiles(projectDir, stateContent).filter((file) => file.text === null).map((file) => file.path);
  if (unread.length === 0) return null;
  const kinds = [
    ...(unread.some((path) => path.endsWith("/team.md")) ? ["practices"] : []),
    ...(unread.some((path) => path.endsWith("/project.md")) ? ["project rules"] : []),
  ];
  return `The lead's ${kinds.length > 0 ? kinds.join(" and ") : "rules"} could not be read just now, so this step follows your team's own rules.`;
}

// The headings of one of the lead's memory files that hold a rule of its own.
// Empty when it has none, or it cannot be read.
function memoryRuleNames(text: string | null): string[] {
  if (text === null) return [];
  const names: string[] = [];
  let heading: string | null = null;
  for (const line of visibleMarkdownLines(text)) {
    const named = /^##\s+(.+?)\s*$/.exec(line);
    if (named) {
      heading = named[1];
      continue;
    }
    if (heading !== null && line.trim() !== "" && !line.trim().startsWith(">") && !names.includes(heading)) names.push(heading);
  }
  return names;
}

// A Unit's UNIT_MERGED rows that still stand: none recorded before the lead's
// Build and Test last sent it back (UNIT_SENT_BACK), in audit order.
export function unitMergesStanding(rows: readonly AuditShardEvent[], unit: string): AuditShardEvent[] {
  const ordered = [...rows].sort((a, b) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1)
    : a.shardIndex !== b.shardIndex ? a.shardIndex - b.shardIndex : a.pos - b.pos));
  const mine = ordered.filter((row) => auditBlockField(row.block, "Unit") === unit);
  const back = mine.findLastIndex((row) => row.event === "UNIT_SENT_BACK");
  return mine.slice(back + 1).filter((row) => row.event === "UNIT_MERGED");
}

// At the lead's project teams build for, a project learning is offered to any
// team that takes a Unit (its project rules, at the take), and the learnings
// choice says so (Arden's call).
export const LEARNINGS_PROJECT_CHOICE_AT_HOME = "Yes, for this project, and offered to any team that takes a Unit";
export function learningsCorrectionChoices(stateContent: string): string[] {
  const home = homeLocation(stateContent) !== null && unitBuildOf(stateContent) === null;
  return home ? [LEARNINGS_PROJECT_CHOICE_AT_HOME, ...LEARNINGS_CORRECTION_CHOICES.slice(1)] : [...LEARNINGS_CORRECTION_CHOICES];
}

// Whether the options offered are the learnings correction question's, in either wording.
export function offersLearningsCorrectionChoices(has: (choice: string) => boolean): boolean {
  return LEARNINGS_CORRECTION_CHOICES.slice(1).every(has) &&
    (has(LEARNINGS_CORRECTION_CHOICES[0]) || has(LEARNINGS_PROJECT_CHOICE_AT_HOME));
}

// The line for likely repos the work does not record: said once, kept as
// written. Null when every one names a recorded repo, or the work records none
// (its likely folders are inside the one repo).
export function unknownLikelyReposLine(projectDir: string): string | null {
  const recorded = intentRepos(projectDir);
  if (recorded.length === 0) return null;
  const unknown: string[] = [];
  for (const [unit, repos] of unitLikelyRepos(projectDir)) {
    for (const repo of repos) {
      if (!recorded.includes(repo.split("/")[0])) unknown.push(`${repo} for ${unit}`);
    }
  }
  if (unknown.length === 0) return null;
  return `The Unit plan names ${unknown.join(", ")}, which is not one of this work's repos (${recorded.join(", ")}). ` +
    "It stays as written, as a guide.";
}

// A per-Unit stage runs for a Unit of this kind when it produces something
// for that kind (filterProducesByKind, its required produces only).
export function teamUnitStageApplies(
  stage: { produces?: string[]; produces_kinds?: Record<string, string[]> },
  unitKind: string | null,
): boolean {
  const names = stage.produces ?? [];
  return names.length > 0 && filterProducesByKind(stage.produces_kinds, names, unitKind).length > 0;
}

// The Units built and approved here, one at a time, before the work switched
// to teams: done at the home as they were, never recorded as merged. One whose
// last gate (its checkpoint, or its stage's gate) was still open is not done:
// the home's own walk puts that gate to the person here. None in main's own
// team flow (no Home Location), which reads its Units as main does.
export function unitsBuiltBeforeTeams(stateContent: string, rows: readonly AuditShardEvent[], finalStage: string): Set<string> {
  if (homeLocation(stateContent) === null) return new Set();
  return builtBeforeTeams(rows, finalStage).approved;
}

// The Units built at the lead's project before teams whose last gate was still
// open: the home's walk asks that gate once, at the Unit's end, as their
// checkpoint did, and its approval covers the Unit's stages. None anywhere but
// the lead's own project.
export function unitsBuiltHereGateOpen(
  projectDir: string,
  stateContent: string,
  finalStage: string,
  rows?: readonly AuditShardEvent[],
): Set<string> {
  if (homeLocation(stateContent) === null || applicableTeamUnitScopeStamp(projectDir, stateContent) !== null) return new Set();
  return builtBeforeTeams(rows ?? readAuditShardEvents(projectDir), finalStage).open;
}

function builtBeforeTeams(rows: readonly AuditShardEvent[], finalStage: string): { approved: Set<string>; open: Set<string> } {
  const ordered = [...rows].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  let teamsAt = -1;
  ordered.forEach((row, at) => {
    if (row.event === "UNIT_OWNERSHIP_SET" && auditBlockField(row.block, "Mode") === "team") teamsAt = at;
  });
  if (teamsAt < 0) return { approved: new Set(), open: new Set() };
  const before = ordered.slice(0, teamsAt);
  const gates = new Set<string | null>(before
    .filter((row) => row.event === "GATE_APPROVED" && auditBlockField(row.block, "Stage") === finalStage)
    .map((row) => auditBlockField(row.block, "Unit")));
  const built = [...soloUnitsProgress(before, finalStage).done];
  const approved = (unit: string) => gates.has(unit) || gates.has(null);
  return { approved: new Set(built.filter(approved)), open: new Set(built.filter((unit) => !approved(unit))) };
}

// Who builds a Unit, as its claim has it: the person who took it (a pushed
// result's own `by` first), else the claim's owner. A line names a person,
// never a team.
export function builderOf(claim: { owner: string; payload: { taken_by?: string; result?: { by?: string } } }): string {
  return claim.payload.result?.by ?? claim.payload.taken_by ?? claim.owner;
}

// A build's space as a line says it (" in the pay space", or `short` " in
// pay"). A default space is never named: anywhere but a workspace teams share,
// it reads as the reader's own.
export function spaceWords(space: string, short = false): string {
  return space === "default" ? "" : short ? ` in ${space}` : ` in the ${space} space`;
}

// --- A Unit's build -----------------------------------------------------------
//
// The piece of work a team builds one Unit of the home's work as, in its own
// space. Its state names the home's location, the home's work, where its record
// is, the Unit and the claim attempt it came from.
export const UNIT_BUILD_FIELD = "Unit Build";
// "later" while the person has not asked for the push yet, "unsent" when the
// code went but the home did not take the result, "pushed" once it reached home.
export const UNIT_PUSH_FIELD = "Unit Push";
// The branch the build's code goes on in each repo: the name the person gave
// (`push --branch`, a team's own branch rule), else the Unit's name.
export const UNIT_BRANCH_FIELD = "Unit Branch";

export function unitBranchOf(stateContent: string, unit: string): string {
  return getField(stateContent, UNIT_BRANCH_FIELD)?.trim() || unit;
}

export interface UnitBuild {
  unit: string;
  homeLocation: string;
  homeWork: string;
  homeRecord: string;
  attempt: number;
}

export function unitBuildOf(stateContent: string | null): UnitBuild | null {
  if (stateContent === null) return null;
  const unit = getField(stateContent, UNIT_BUILD_FIELD)?.trim();
  if (!unit) return null;
  return {
    unit,
    homeLocation: getField(stateContent, HOME_LOCATION_FIELD)?.trim() ?? "",
    homeWork: getField(stateContent, "Home Work")?.trim() ?? "",
    homeRecord: getField(stateContent, "Home Record")?.trim() ?? "",
    attempt: Number.parseInt(getField(stateContent, "Home Attempt")?.trim() ?? "1", 10) || 1,
  };
}

// A Unit's build ends with its push home, and its record finishes only after
// the push or the person's Not now: whatever the push then asks of them (a
// way back to Code Generation, say) is still their move inside the work.
export function buildWaitsForPush(stateContent: string): boolean {
  return unitBuildOf(stateContent) !== null && getField(stateContent, UNIT_PUSH_FIELD)?.trim() !== "later";
}

// The build of a home's Unit in this workspace, in any space: what taking that
// Unit again here carries on. A build given back (archived) is not carried on.
export function findUnitBuild(projectDir: string, homeWork: string, unit: string): { space: string; dirName: string } | null {
  return findBuild(projectDir, (build) => build.unit === unit && build.homeWork === homeWork);
}

// A build here of a Unit of the lead's record (`<space>/<dirName>`), found
// with no read of the lead's project.
export function findUnitBuildOfRecord(projectDir: string, homeRecord: string, unit: string): { space: string; dirName: string } | null {
  return findBuild(projectDir, (build) => build.unit === unit && build.homeRecord === homeRecord);
}

function findBuild(projectDir: string, matches: (build: UnitBuild) => boolean): { space: string; dirName: string } | null {
  let spaces: string[];
  try {
    spaces = readdirSync(join(projectDir, "aidlc", "spaces"));
  } catch {
    return null;
  }
  for (const space of spaces) {
    for (const dirName of listIntentDirs(projectDir, space)) {
      let state: string;
      try {
        state = readStateFile(projectDir, dirName, space);
      } catch {
        continue;
      }
      const build = unitBuildOf(state);
      if (build !== null && matches(build) && getField(state, "Status")?.trim() !== "Archived") return { space, dirName };
    }
  }
  return null;
}

// A fact, not a task: the agent carried the earlier words (with their command
// list) into every later look as a to-do.
export const CHECK_IN_LINE = "Your teammates see where this work stands once aidlc/ is committed and pushed.";

// Teams across repos share AI-DLC's record by git, and the person checks it in.
// The callers say this at the stopping points (a stop, the push or the
// person's Not now to it, the lead's Build and Test approval), never from what
// git status shows: AI-DLC's own audit rows change aidlc/ at every step. Null for other work (main's team Units on the workspace's own
// repo commit the record for the person) and where there is no remote to push.
export function checkInLine(projectDir: string, stateContent?: string): string | null {
  let state = stateContent;
  if (state === undefined) {
    try {
      state = readStateFile(projectDir);
    } catch {
      return null;
    }
  }
  if (unitBuildOf(state) === null && !(isTeamUnitOwnership(state) && homeLocation(state) !== null)) return null;
  const remotes = spawnSync("git", ["-C", projectDir, "remote"], { encoding: "utf-8", timeout: 10_000 });
  return remotes.status === 0 && remotes.stdout.trim() !== "" ? CHECK_IN_LINE : null;
}

// What the person's last `git pull` here that brought changes brought from the
// other spaces of a workspace teams share: each record by its Unit and where it
// is, or the lead's work by its own name. Read from this clone's own reflog (a pull
// that brought nothing writes no entry), so nothing is written. Null with no
// such pull here, nothing from others, or no git.
export function arrivedAtLastPull(projectDir: string, ownSpace: string): string | null {
  const reflog = spawnSync("git", ["-C", projectDir, "reflog", "-n", "200", "--format=%H%x00%gs"], { encoding: "utf-8", timeout: 10_000 });
  if (reflog.status !== 0) return null;
  const rows = reflog.stdout.split("\n").filter((row) => row.includes("\u0000")).map((row) => row.split("\u0000") as [string, string]);
  // Newest first. A pull is one entry; a rebase pull writes its steps
  // ("pull --rebase (finish)", "(pick)") back to its "(start)" entry.
  const first = rows.findIndex(([, subject]) => /^pull\b/.test(subject));
  if (first === -1) return null;
  let last = first;
  if (/^pull\b[^:]*\((?!start\))[^)]*\):/.test(rows[first][1])) {
    const start = rows.findIndex(([, subject], at) => at > first && /^pull\b[^:]*\(start\):/.test(subject));
    if (start !== -1) last = start;
  }
  if (last + 1 >= rows.length) return null;
  const diff = spawnSync("git", ["-C", projectDir, "diff", "--name-only", rows[last + 1][0], rows[first][0], "--", "aidlc/spaces"], { encoding: "utf-8", timeout: 10_000 });
  if (diff.status !== 0) return null;
  // Each record once, by where it is: a Unit's build by its Unit and space (a
  // default space is never named), the lead's own work as the lead's.
  const records = new Map<string, string>();
  for (const path of diff.stdout.split("\n")) {
    const match = /^aidlc\/spaces\/([^/]+)\/intents\/([^/]+)\//.exec(path.trim());
    if (match === null || match[1] === ownSpace) continue;
    const [, space, dirName] = match;
    if (records.has(`${space}/${dirName}`)) continue;
    let said = `${dirName}${spaceWords(space, true)}`;
    try {
      const state = readStateFile(projectDir, dirName, space);
      const build = unitBuildOf(state);
      const entry = listIntents(projectDir, space).find((intent) => intent.dirName === dirName);
      const label = build?.unit ?? (entry !== undefined ? intentDisplayLabel(entry) : dirName);
      said = build === null && homeLocation(state) !== null ? `the lead's ${label}` : `${label}${spaceWords(space, true)}`;
    } catch {
      // A record no longer here keeps its folder name.
    }
    records.set(`${space}/${dirName}`, said);
  }
  if (records.size === 0) return null;
  return [...records.values()].join("; ");
}

// A build walks only its own Unit: its copy of the home's plan names every
// Unit, and the others are the home's or other teams' to build.
export function onlyTheBuildsUnit(
  projectDir: string,
  resolution: BoltDagResolution,
  intent?: string,
  space?: string,
): BoltDagResolution {
  if (resolution.state !== "ok") return resolution;
  let unit: string | null = null;
  try {
    unit = unitBuildOf(readStateFile(projectDir, intent, space))?.unit ?? null;
  } catch {
    // No state yet: the plan as authored.
  }
  if (unit === null || !resolution.units.includes(unit)) return resolution;
  const kind = resolution.unitKinds?.get(unit);
  return { state: "ok", batches: [[unit]], units: [unit], unitKinds: kind === undefined ? null : new Map([[unit, kind]]) };
}

// Two spellings of one git address (gitAddressKey).
export function sameGitAddress(a: string, b: string): boolean {
  return gitAddressKey(a) === gitAddressKey(b);
}

// The home's work that git copied into a team's own workspace: its recorded
// home is not this workspace's own origin. It is the home's, read only, never
// this team's to carry on; nothing in the copy is changed.
export function isHomesCopiedWork(projectDir: string, state: string): boolean {
  const home = isTeamUnitOwnership(state) ? homeLocation(state) : null;
  if (home === null || home === "local") return false;
  return !sameGitAddress(home, workspaceHomeLocation(projectDir) ?? "");
}

// The person's words for a Unit command never go on its line (a shell would
// read their quotes): the agent writes them, as they typed them, to the file
// the command names, with its file tool, and the command reads them from there
// (readRequestFile, as `unit gate` does).
export function unitWordsArg(verb: string, unit?: string): string {
  const name = [verb, ...(unit === undefined ? [] : [unit])].join("-").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `--request-file ${REQUEST_TEXT_DIR}/unit-${name}.txt`;
}

// The clause of the line solo work's switch to teams says, while the lead's
// sign-off is off: the step carrying it carries the setter too.
export const SIGN_OFF_CLAUSE = "and you can ask to sign off a teammate's result yourself before it counts as done";

export const UNIT_WORDS_NOTE =
  "Where a command names a --request-file, write the person's words to it first, as they typed them, with your " +
  "file tool, never a shell, then run the command.";

// --- A Unit's result, and whether it merged -----------------------------------
//
// What a team's push sends home on the claim: per repo, the branch, the commit
// the Unit started from, every head pushed (the last is current), each changed
// path's blob at the head (null when deleted) and the change's patch-id. The
// home checks each repo against its own integration branch with git alone.

export interface RepoResult {
  // A repo name, or "." for the workspace's own repo.
  repo: string;
  branch: string;
  base: string;
  heads: string[];
  paths: Record<string, string | null>;
  patch_id?: string;
}

export interface UnitResult {
  by: string;
  repos: RepoResult[];
  // Record-relative paths of the Unit outputs the home's later stages read,
  // carried as files in the claim commit's tree under RESULT_FILES_ROOT.
  outputs: string[];
  // Shared inputs the team's own edit was kept for, made on the version before
  // the home's change (record-relative).
  kept_edits?: string[];
}

export const RESULT_FILES_ROOT = ".aidlc-unit-result";

function gitIn(dir: string, args: string[], input?: string): { ok: boolean; out: string } {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8", input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, out: result.stdout ?? "" };
}

// Each path's blob at a commit; a path the commit does not have is left out.
export function blobsAt(dir: string, commit: string, paths: readonly string[]): Map<string, string> {
  const blobs = new Map<string, string>();
  if (paths.length === 0) return blobs;
  const listed = gitIn(dir, ["ls-tree", "-r", "--full-tree", commit, "--", ...paths]);
  for (const line of listed.out.split("\n").filter(Boolean)) {
    const tab = line.indexOf("\t");
    blobs.set(line.slice(tab + 1), line.slice(0, tab).split(" ")[2]);
  }
  return blobs;
}

// The stable patch-id of the change from one commit to another over the paths.
export function patchIdOf(dir: string, from: string, to: string, paths: readonly string[]): string | null {
  const diff = gitIn(dir, ["diff", "--no-ext-diff", "--no-textconv", from, to, "--", ...paths]);
  if (!diff.ok || diff.out.length === 0) return null;
  return gitIn(dir, ["patch-id", "--stable"], diff.out).out.split(" ")[0] || null;
}

export type MergeVerdict =
  | { merged: true; commit: string; how: "ancestry" | "same content" | "same change" }
  | { merged: false };

// Whether a repo's part of a Unit is in its integration branch: the last head
// is an ancestor of it (a merge commit, a fast-forward); or a first-parent
// commit after the base has every changed path at the head's blob and every
// deleted path gone (a squash, a rebase; a later edit to the same files comes
// after it); or one first-parent commit is the same change by patch-id.
// Anything else is not merged yet.
// ponytail: the walk reads the latest 500 first-parent commits after the base.
export function unitMergeVerdict(dir: string, integration: string, result: RepoResult): MergeVerdict {
  const head = result.heads.at(-1);
  if (head && gitIn(dir, ["merge-base", "--is-ancestor", head, integration]).ok) {
    return { merged: true, commit: head, how: "ancestry" };
  }
  const paths = Object.keys(result.paths);
  if (paths.length === 0) return { merged: false };
  const known = gitIn(dir, ["rev-parse", "--verify", "--quiet", `${result.base}^{commit}`]).ok;
  const commits = gitIn(dir, ["rev-list", "--first-parent", "--reverse", "--max-count=500", known ? `${result.base}..${integration}` : integration])
    .out.split("\n").filter(Boolean);
  for (const commit of commits) {
    const at = blobsAt(dir, commit, paths);
    if (paths.every((path) => (result.paths[path] === null ? !at.has(path) : at.get(path) === result.paths[path]))) {
      return { merged: true, commit, how: "same content" };
    }
  }
  if (result.patch_id) {
    for (const commit of commits) {
      if (patchIdOf(dir, `${commit}^`, commit, paths) === result.patch_id) return { merged: true, commit, how: "same change" };
    }
  }
  return { merged: false };
}

// The Unit outputs the home's stages after the per-Unit ones read (Build and
// Test reads Code Generation's summary and test instructions): record-relative
// paths, for the scope's stages that run.
export function unitOutputsHomeReads(unit: string, scope: string): string[] {
  const graph = loadStageGraphAll();
  const grid = loadScopeMapping()[scope]?.stages ?? {};
  const perUnit = graph.filter((stage) => isPerUnitStage(stage));
  const outputs = new Set<string>();
  for (const stage of graph) {
    if ((stage.phase !== "construction" && stage.phase !== "operation") || isPerUnitStage(stage)) continue;
    if (grid[stage.slug] !== "EXECUTE") continue;
    for (const consume of stage.consumes ?? []) {
      const producer = perUnit.find((entry) =>
        [...(entry.produces ?? []), ...(entry.optional_produces ?? [])].includes(consume.artifact)
      );
      if (producer) outputs.add(`construction/${unit}/${producer.slug}/${artifactFilename(consume.artifact)}`);
    }
    // What the stage's own checks read of each Unit, beside what it consumes.
    // Loaded here only: this module also runs beside the library in hooks.
    const coverage = require("./aidlc-sensor-traceability.ts") as typeof import("./aidlc-sensor-traceability.ts");
    if (stage.slug === coverage.CROSS_UNIT_COVERAGE_STAGE) {
      for (const rel of coverage.crossUnitCoverageReads()) outputs.add(`construction/${unit}/${rel}`);
    }
  }
  return [...outputs].sort();
}

// A Unit's writes by the repo each is in, as its source manifest records them,
// with the folder its push runs in and how the source walk names that folder's
// files (its listing keys' prefix): a write names its repo; or is a recorded
// checkout's (`<label>@checkout/<path>`, a worktree or clone the agent built
// in and recorded), read as the recorded repo that checkout is of by git's own
// repository, in the checkout's folder; or is in the work's one recorded repo;
// or in the workspace's own repo ("."). A checkout of no recorded repo keeps
// its write at the workspace, where the push names it.
export function unitWriteTargets(
  projectDir: string,
  writes: ReadonlyArray<{ path: string; repo?: string }>,
): Map<string, { dir: string; paths: string[]; listedAs: string }> {
  const recorded = intentRepos(projectDir);
  const checkouts = writes.some((write) => write.repo === undefined) ? readRecordedSourceCheckouts(projectDir) : [];
  const repoOf = checkoutRepoReader(projectDir, recorded);
  const targets = new Map<string, { dir: string; paths: string[]; listedAs: string }>();
  const add = (repo: string, dir: string, listedAs: string, path: string): void => {
    const at = targets.get(repo) ?? { dir, paths: [], listedAs };
    at.paths.push(path);
    targets.set(repo, at);
  };
  for (const write of writes) {
    const inCheckout = write.repo === undefined ? recordedCheckoutOfListingPath(write.path, checkouts) : null;
    if (inCheckout !== null && inCheckout.rest !== "") {
      const { checkout, rest } = inCheckout;
      const repo = repoOf(checkout.real);
      if (repo) {
        add(repo, checkout.real, `\0${sourceCheckoutListingRel(checkout.label)}/`, rest);
        continue;
      }
    }
    const repo = write.repo ?? (recorded.length === 1 ? recorded[0] : ".");
    add(repo, repo === "." ? projectDir : repoDir(projectDir, repo), repo === "." ? "\0" : `${repo}\0`, write.path);
  }
  return targets;
}

// Which recorded repo a recorded checkout's folder is of: a worktree shares
// its repo's own git folder, a clone of it its origin; null for neither.
function checkoutRepoReader(projectDir: string, recorded: readonly string[]): (real: string) => string | null {
  const commonDir = (dir: string): string | null => {
    const read = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf-8" });
    return read.status === 0 && read.stdout.trim() ? resolve(dir, read.stdout.trim()) : null;
  };
  const originOf = (dir: string): string | null => {
    const read = spawnSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf-8" });
    return read.status === 0 && read.stdout.trim() ? read.stdout.trim() : null;
  };
  const seen = new Map<string, string | null>();
  return (real) => {
    if (!seen.has(real)) {
      const own = commonDir(real);
      const origin = originOf(real);
      seen.set(real,
        recorded.find((repo) => own !== null && commonDir(repoDir(projectDir, repo)) === own) ??
          recorded.find((repo) => {
            const theirs = origin === null ? null : originOf(repoDir(projectDir, repo));
            return theirs !== null && sameGitAddress(origin!, theirs);
          }) ??
          null);
    }
    return seen.get(real) ?? null;
  };
}

// A Unit output as the lead's project reads it: a traceability table's targets
// in one of the work's repos, as this workspace has it (the folder
// repos.local.json gives it, or a folder recorded as a checkout of it), are
// spelled `<repo>/<path>`, where the lead's checks find the file; the team's
// own record stays as written. Anything else, or a table that does not read,
// as it is.
export function outputForLead(projectDir: string, rel: string, text: string): string {
  if (!rel.endsWith("/traceability.json")) return text;
  try {
    const table = JSON.parse(text) as { coverage?: Array<{ target?: unknown }> };
    if (!Array.isArray(table.coverage)) return text;
    const recorded = intentRepos(projectDir).filter((repo) => repo !== ".");
    const checkouts = readRecordedSourceCheckouts(projectDir);
    if (checkouts.length === 0 && recorded.length === 0) return text;
    const repoOf = checkoutRepoReader(projectDir, recorded);
    // Each folder a target may sit in, with the repo it is of.
    const roots: Array<{ roots: string[]; repo: () => string | null }> = [
      ...checkouts.map((checkout) => ({ roots: [checkout.real, resolve(projectDir, checkout.path)], repo: () => repoOf(checkout.real) })),
      ...recorded.map((repo) => ({ roots: [resolve(repoDir(projectDir, repo))], repo: () => repo })),
    ];
    let changed = false;
    for (const entry of table.coverage) {
      if (typeof entry?.target !== "string") continue;
      const at = resolve(projectDir, entry.target.trim().replace(/\\/g, "/"));
      for (const root of roots) {
        const within = root.roots
          .map((folder) => relative(folder, at))
          .find((path) => path !== "" && !path.startsWith("..") && !isAbsolute(path));
        const repo = within === undefined ? null : root.repo();
        if (within !== undefined && repo) {
          const spelled = `${repo}/${within.split(sep).join("/")}`;
          if (spelled !== entry.target) {
            entry.target = spelled;
            changed = true;
          }
          break;
        }
      }
    }
    return changed ? `${JSON.stringify(table, null, 2)}\n` : text;
  } catch {
    return text;
  }
}

// The same, by repo only.
export function writesByRepo(projectDir: string, writes: ReadonlyArray<{ path: string; repo?: string }>): Map<string, string[]> {
  return new Map([...unitWriteTargets(projectDir, writes)].map(([repo, target]) => [repo, target.paths]));
}

// --- The board ----------------------------------------------------------------
//
// One line per Unit, the same at the home and in every team's workspace.

export interface UnitBoardRow {
  unit: string;
  /** Where it is built: a take's space ("payments space"), "here", "" for a take in a default space (no column), null when open. */
  team: string | null;
  status: string;
}

export function renderUnitBoard(label: string, rows: readonly UnitBoardRow[]): string {
  return [`Units of ${label}:`, ...rows.map((row) => `- ${row.unit}${row.team === "" ? "" : `, ${row.team ?? "open"}`}: ${row.status}`)].join("\n");
}

// --- The lead's project waits on the teams ------------------------------------
//
// When `next` at the lead's project has nothing to build there and the board is
// its step, it records the Units that wait on teams, bound to the state it
// leaves (as a step on record is bound), so the plan-approval guard reads the
// wait rather than asking for a `next` that only prints the board again. A
// command that can give the lead's project a Unit to build, or count one
// merged, clears it (aidlc-unit.ts main); the next `next` decides again.

/** A Unit the lead's project waits on, with the space its build is in (null: open for any team). */
export interface WaitingUnit {
  unit: string;
  team: string | null;
}

const TEAMS_WAIT_FILE = "teams-wait.json";

export function noteLeadWaitsOnTeams(projectDir: string, stateContent: string, waiting: readonly WaitingUnit[]): void {
  try {
    writeEngineFileNoFollow(projectDir, TEAMS_WAIT_FILE,
      `${JSON.stringify({ state_sha256: stateDigest(stateContent), waiting })}\n`);
  } catch {
    // Without it a write at the wait is refused as before, with `next`, which records it again.
  }
}

export function clearLeadWaitsOnTeams(projectDir: string): void {
  try {
    if (existsSync(join(engineDir(projectDir), TEAMS_WAIT_FILE))) {
      removeRecordFileNoFollow(docsRoot(projectDir), `${ENGINE_DIR}/${TEAMS_WAIT_FILE}`);
    }
  } catch {
    // A record that cannot be removed is bound to the state, and goes stale with it.
  }
}

/** The Units the lead's project waits on now, as its last board on this state recorded them; null when it does not wait. */
export function leadWaitsOnTeams(projectDir: string, stateContent: string): WaitingUnit[] | null {
  try {
    const path = join(engineDir(projectDir), TEAMS_WAIT_FILE);
    if (!existsSync(path)) return null;
    const record = JSON.parse(readAtomicReplacedFileNoFollowOrThrow(path, "teams wait").toString("utf-8")) as {
      state_sha256?: unknown;
      waiting?: unknown;
    };
    if (record.state_sha256 !== stateDigest(stateContent) || !Array.isArray(record.waiting)) return null;
    const waiting = record.waiting.filter((entry): entry is WaitingUnit =>
      typeof entry?.unit === "string" && (entry.team === null || typeof entry.team === "string"));
    return waiting.length > 0 && waiting.length === record.waiting.length ? waiting : null;
  } catch {
    return null;
  }
}

// The wait in the person's words: some hosts show a hook's refusal to them as
// written, so it is their sentence and names no step (the step is theirs).
export function leadWaitSentence(waiting: readonly WaitingUnit[]): string {
  const parts = waiting.map(({ unit, team }, at) =>
    `${unit}${at === 0 ? " waits" : ""} ${team === null ? "for a team to take it" : `on its build${spaceWords(team)}`}`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `${list}, so nothing is built here meanwhile: the files here change only when you ask for a change.`;
}

/** The waiting Units as a row names them: `unit=team`, an open one as `unit=open`. */
export function waitingField(waiting: readonly WaitingUnit[]): string {
  return waiting.map(({ unit, team }) => `${unit}=${team ?? "open"}`).join(", ");
}

// How far a pushed Unit's repos are merged, in words: "checkout-api merged,
// billing not merged yet (1 of 2 merged)".
export function mergedStatus(verdicts: ReadonlyArray<{ repo: string; merged: boolean }>): string {
  const merged = verdicts.filter((verdict) => verdict.merged).length;
  const parts = verdicts.map((verdict) => `${verdict.repo === "." ? "the repo" : verdict.repo} ${verdict.merged ? "merged" : "not merged yet"}`);
  return verdicts.length === 1 ? parts[0] : `${parts.join(", ")} (${merged} of ${verdicts.length} merged)`;
}

// A text's fingerprint, the same for its LF and CRLF spellings.
export function textFingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(committedTextBytes(Buffer.from(text, "utf-8"))).digest("hex")}`;
}

// A table's rows as cells, from markdownBlocks: the one reading of Markdown structure.
function tableRows(lines: readonly string[], blocks: ReturnType<typeof markdownBlocks>["lines"]): string[][] {
  return lines.flatMap((line, at) => blocks[at]?.kind === "table" && blocks[at].containers.length === 0
    ? [line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim())]
    : []);
}

// --- A shared input a team proposes to change -------------------------------------
//
// A team proposes a change to one of the inputs its Unit was approved with; the
// person who owns the shared plan answers at the home; an approved change
// reaches every team building with it, once, as an amendment on its claim.

export interface Proposal {
  // Record-relative path of the input, as approved-inputs.md lists it.
  input: string;
  by: string;
  words: string;
  at: string;
  answer?: "approved" | "turned down";
  answer_words?: string;
}

export interface Amendment {
  input: string;
  at: string;
  words: string;
}

// The files a build was approved with, as its approved-inputs.md lists them.
export function approvedInputsOf(recordDir: string): Array<{ path: string; fingerprint: string }> {
  let text: string;
  try {
    text = readFileSync(join(recordDir, "approved-inputs.md"), "utf-8");
  } catch {
    return [];
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  return tableRows(normalized.split("\n"), markdownBlocks(normalized).lines)
    .filter((cells) => /^sha256:[0-9a-f]+$/.test(cells[1] ?? ""))
    .map((cells) => ({ path: cells[0], fingerprint: cells[1] }));
}

// The contract summary teams build with (Contract Design's output).
export const CONTRACT_SUMMARY_INPUT = "inception/contract-design/contract-summary.md";

// Who a change to the contract summary is for: the Units that are a party to a
// contract it changed (the Provider Unit and the Consumer cells of its row in
// the Contracts table), read from structure only: the table's cells, and the
// headings a changed section sits under. A changed row is its parties'; a
// changed section is a row's when the nearest heading above it that ties names,
// as whole tokens, both of that row's party Units or its # and one of them, for
// exactly one row. Null, so every Unit that reads it hears, when either text
// has no Contracts table, a change cannot be tied to one row, or a tied row
// names no Unit on one side.
export function contractPartiesChanged(before: string, after: string, units: readonly string[]): Set<string> | null {
  const was = contractStructure(before);
  const now = contractStructure(after);
  if (was === null || now === null) return null;
  const known = new Set(units);
  const tokens = (text: string) => new Set(text.split(/[^A-Za-z0-9_-]+/).filter(Boolean));
  const rowsById = (rows: ContractRow[]) => new Map(rows.map((row) => [row.id, row]));
  const rowsBefore = rowsById(was.rows);
  const rowsAfter = rowsById(now.rows);
  const changedRows: ContractRow[] = [];
  for (const id of new Set([...rowsBefore.keys(), ...rowsAfter.keys()])) {
    const left = rowsBefore.get(id);
    const right = rowsAfter.get(id);
    if (left?.cells.join("|") !== right?.cells.join("|")) changedRows.push(...[left, right].filter((row): row is ContractRow => row !== undefined));
  }
  const rows = now.rows.length > 0 ? now.rows : was.rows;
  const partiesOf = (row: ContractRow): string[] | null => {
    const provider = [...tokens(row.provider)].filter((token) => known.has(token));
    const consumer = [...tokens(row.consumer)].filter((token) => known.has(token));
    return provider.length === 0 || consumer.length === 0 ? null : [...provider, ...consumer];
  };
  const tie = (path: readonly string[]): ContractRow | null => {
    for (const heading of [...path].reverse()) {
      const named = tokens(heading);
      const hits = rows.filter((row) => {
        const parties = [...tokens(row.provider), ...tokens(row.consumer)].filter((token) => known.has(token));
        const both = parties.length >= 2 && parties.every((unit) => named.has(unit));
        return both || (named.has(row.id) && parties.some((unit) => named.has(unit)));
      });
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return null;
    }
    return null;
  };
  const changed: ContractRow[] = [...changedRows];
  for (const key of new Set([...was.sections.keys(), ...now.sections.keys()])) {
    if (was.sections.get(key)?.body === now.sections.get(key)?.body) continue;
    const row = tie((now.sections.get(key) ?? was.sections.get(key))!.path);
    if (row === null) return null;
    changed.push(row);
  }
  const parties = new Set<string>();
  for (const row of changed) {
    const named = partiesOf(row);
    if (named === null) return null;
    for (const unit of named) parties.add(unit);
  }
  return parties;
}

interface ContractRow {
  id: string;
  provider: string;
  consumer: string;
  cells: string[];
}

// The Contracts table's rows (header cells #, Provider Unit and Consumer) and
// every section's text outside that table, keyed by its heading path.
function contractStructure(text: string): { rows: ContractRow[]; sections: Map<string, { path: string[]; body: string }> } | null {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks = markdownBlocks(normalized).lines;
  const cellsAt = (at: number) => lines[at].trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  let header: { block: number; id: number; provider: number; consumer: number } | null = null;
  const rows: ContractRow[] = [];
  const tableLines = new Set<number>();
  for (let at = 0; at < lines.length; at++) {
    const line = blocks[at];
    if (line?.kind !== "table" || line.containers.length > 0) continue;
    const cells = cellsAt(at);
    const lower = cells.map((cell) => cell.toLowerCase());
    if (header === null || header.block !== line.block) {
      const id = lower.indexOf("#");
      const provider = lower.indexOf("provider unit");
      const consumer = lower.indexOf("consumer");
      if (id < 0 || provider < 0 || consumer < 0) continue;
      header = { block: line.block, id, provider, consumer };
    }
    tableLines.add(at);
    if (cells.every((cell) => /^:?-+:?$/.test(cell)) || cells[header.id]?.toLowerCase() === "#") continue;
    rows.push({ id: cells[header.id] ?? "", provider: cells[header.provider] ?? "", consumer: cells[header.consumer] ?? "", cells });
  }
  if (header === null) return null;
  const sections = new Map<string, { path: string[]; body: string }>();
  const path: Array<{ level: number; title: string }> = [];
  let key = "";
  let body: string[] = [];
  const close = () => {
    if (body.join("\n").trim() !== "" || sections.has(key)) sections.set(key, { path: path.map((entry) => entry.title), body: body.join("\n").trim() });
    body = [];
  };
  for (let at = 0; at < lines.length; at++) {
    const line = blocks[at];
    const atx = line?.kind === "heading" && line.containers.length === 0 ? /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/.exec(lines[at]) : null;
    if (atx !== null) {
      close();
      const level = atx[1].length;
      while (path.length > 0 && path[path.length - 1].level >= level) path.pop();
      path.push({ level, title: atx[2] });
      key = path.map((entry) => entry.title).join("\u0000");
      continue;
    }
    if (!tableLines.has(at)) body.push(lines[at]);
  }
  close();
  return { rows, sections };
}

// An input's name for the person: "contract summary" for
// inception/contract-design/contract-summary.md.
export function inputName(rel: string): string {
  return (rel.split("/").at(-1) ?? rel).replace(/\.md$/, "").replaceAll("-", " ");
}

// Which stage produced a record-relative Inception output, and as which artifact.
export function artifactAt(rel: string): { producer: string; artifact: string } | null {
  const [, producer, file] = rel.split("/");
  const stage = loadStageGraphAll().find((entry) => entry.slug === producer);
  const artifact = [...(stage?.produces ?? []), ...(stage?.optional_produces ?? [])].find((name) => artifactFilename(name) === file);
  return stage && artifact ? { producer, artifact } : null;
}

// --- Solo work driven from another machine -----------------------------------------

// Solo work built one Unit at a time whose active Unit last moved in another
// clone's audit shard: it is being built from another machine. That Unit and
// the stage it was on; null otherwise.
export function builtFromAnotherMachine(
  stateContent: string,
  rows: readonly AuditShardEvent[],
  ownShard: string,
): { unit: string; stage: string; shard: string } | null {
  if (isTeamUnitOwnership(stateContent) || getField(stateContent, "Construction Iteration")?.trim() !== "unit-major") return null;
  const moves = rows
    .filter((row) => row.event.startsWith("UNIT_") && auditBlockField(row.block, "Unit") && auditBlockField(row.block, "Stage"))
    .sort((a, b) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1) : a.pos - b.pos));
  const last = moves.at(-1);
  // A row's shard is the shard file's path; ownShard is this clone's shard name.
  if (last === undefined || basename(last.shard) === ownShard) return null;
  return { unit: auditBlockField(last.block, "Unit")!, stage: auditBlockField(last.block, "Stage")!, shard: last.shard };
}

// Whether the person who last committed a file is this clone's git identity
// (user.email, else user.name): one person's work on two machines.
export function lastCommittedByThisPerson(projectDir: string, path: string): boolean {
  const run = (args: string[]) => (spawnSync("git", args, { cwd: projectDir, encoding: "utf-8" }).stdout ?? "").trim();
  const [email = "", name = ""] = run(["log", "-1", "--format=%ae%n%an", "--", path]).split("\n");
  const mine = run(["config", "user.email"]);
  if (email && mine) return email.toLowerCase() === mine.toLowerCase();
  return name !== "" && name === run(["config", "user.name"]);
}

// The Units the lead's project started. One with no claim at all stays the
// lead's project's; a claim on it (the lead's own, released, or a take) says
// whose it is instead.
export function unitsStartedAtLeadsProject(rows: readonly AuditShardEvent[]): Set<string> {
  const started = new Set<string>();
  for (const row of rows) if (row.event === "UNIT_STARTED") started.add(auditBlockField(row.block, "Unit") ?? "");
  started.delete("");
  return started;
}

// A solo walk's Units: started when any per-Unit stage started for it, done
// when its last per-Unit stage completed.
export function soloUnitsProgress(
  rows: readonly AuditShardEvent[],
  finalStage: string,
): { started: Set<string>; done: Set<string> } {
  const started = new Set<string>();
  const done = new Set<string>();
  for (const row of rows) {
    const unit = auditBlockField(row.block, "Unit");
    if (!unit) continue;
    if (row.event === "UNIT_STARTED") started.add(unit);
    if (row.event === "UNIT_COMPLETED" && auditBlockField(row.block, "Stage") === finalStage) done.add(unit);
  }
  return { started, done };
}
