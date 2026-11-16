// Teams building each Unit as a piece of work of their own (#2410): where the
// home is, what the Unit plan says about each Unit (likely repos, what it waits
// on), which Units the lead's own walk leaves for takes, and a Unit's build. Built on
// aidlc-lib.ts, which requires it lazily where its own functions need it.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactFilename } from "./aidlc-artifact-vocabulary.ts";
import { validateUnitName } from "./aidlc-unit-dag.ts";
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
  hasAnyUnitClaimRefs,
  intentDisplayLabel,
  intentRepos,
  teamsAcrossReposLine,
  intentsDir,
  isPerUnitStage,
  isTeamUnitOwnership,
  isValidRepoName,
  SPACE_NAME_REGEX,
  LEARNINGS_CORRECTION_CHOICES,
  listIntentDirs,
  plannedStages,
  type StageEntry,
  unitMajorConstructionStageSlugs,
  markPersonLinesHeard,
  personLineHeard,
  loadScopeMapping,
  loadStageGraphAll,
  markdownBlocks,
  parseBoltDag,
  readAtomicReplacedFileNoFollowOrThrow,
  readAuditShardEvents,
  writeRecordFileNoFollow,
  readRecordedSourceCheckouts,
  readStateFile,
  readUnitGateRhythm,
  recordedCheckoutOfListingPath,
  removeField,
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
import { gitUserName } from "./aidlc-git-name.ts";
import { projectInRepo } from "./aidlc-git.ts";
import { applicableTeamUnitScopeStamp, idSuffix, listIntents, onlyOwnLookRows, resolveWorkflowSelection, setCheckbox } from "./aidlc-record-core.ts";
import { UNIT_PROGRESS_NOTE, unitProgressSectionRange } from "./aidlc-unit-landing.ts";
import { isReadOnlyEngineProbe } from "./aidlc-locks.ts";
import { gitAddressKey } from "./aidlc-workspace-repos.ts";
import { homeCopyName, planRecordRef } from "./aidlc-unit-holders.ts";
import { withoutCredentials } from "./aidlc-workspace-manifest.ts";

// Where the home of team-built work is: the address of the code repository its
// plan is shared in (with any user and token left out), or "local" while there
// is none. Recorded as teams are chosen, and again when the plan is shared in
// another repository; every copy of the workspace reads it. Its presence puts the work on teams building each Unit as a piece of
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

// Which place a work's claims use (aidlc-unit-holders.ts names both): main's
// flow keeps its claim branches, for team work that records no Home Location
// and is not a Unit's build; every other work's claims are records (work that
// records Home Location, a Unit's build, solo work one Unit at a time).
export function claimsOnBranches(stateContent: string | null): boolean {
  return isTeamUnitOwnership(stateContent) && homeLocation(stateContent) === null && unitBuildOf(stateContent) === null;
}

// The same for a work of `space` by its id: one not here is a home elsewhere,
// whose claims are records.
export function claimsOnBranchesFor(projectDir: string, space: string, intentUuid: string): boolean {
  const dirName = listIntents(projectDir, space).find((intent) => intent.uuid === intentUuid)?.dirName ?? null;
  if (dirName === null) return false;
  try {
    return claimsOnBranches(readStateFile(projectDir, dirName, space));
  } catch {
    return false;
  }
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
// build-out (assign, take, push, the team's own merge) for team work on a
// remote, whatever repository its code is in; main's claim, publish, pin, gate
// and land where the work's code is the workspace's own repo and nothing but
// this machine reaches it (no remote), or where its remote already holds
// main's claims of this work (teams chosen before, then one Unit at a time,
// then teams again). Work across repos records where its plan goes, the
// first of its repositories with an address (`planAddress`, planHomeAddress in
// aidlc-unit.ts, which imports this file), and "local" while none has one. The
// Home Location to record, or null for main's flow.
// `teammateTook`: a teammate took a Unit of solo work (switchSoloToTeams).
export function buildOutHomeLocation(
  projectDir: string,
  teammateTook: boolean,
  planAddress: (dirName: string, space: string) => string | null,
): string | null {
  const home = workspaceHomeLocation(projectDir);
  if (teammateTook) return home;
  if (intentRepos(projectDir).length > 0) {
    const { intent, space } = resolveWorkflowSelection(projectDir);
    return (intent === null ? null : planAddress(intent, space)) ?? "local";
  }
  return home === "local" || hasAnyUnitClaimRefs(projectDir, true) ? null : home;
}

// Why teams cannot each own a Unit of the work here, or null when they can:
// the one test the ownership setter and the staffing step share. A project in
// a folder below its repository's top cannot, whatever its code is.
export function buildOutBlockedLine(projectDir: string, unitCount?: number): string | null {
  const repos = intentRepos(projectDir);
  const at = projectInRepo(projectDir);
  const inFolder = at !== null && at.prefix !== "";
  if (repos.length === 0 ? !inFolder : workspaceHomeLocation(projectDir) !== null) return null;
  if (at === null || !inFolder) return teamsAcrossReposLine(repos.length, unitCount);
  const units = unitCount === undefined ? "its Units" : `its ${unitCount} Units`;
  return `This project sits in ${at.prefix.replace(/\/$/, "")} of ${at.top}, not at the top of its git repository, so ` +
    `this session builds ${units}: for teams to each own a Unit, start the work in a workspace of its own beside ` +
    "that repository, with repos.json giving its path.";
}

// What to record as the home's location for a workspace: its repository's
// remote, or "local" with none, when the workspace is that repository's top;
// null outside git or in a folder below the top, where the lead's record is not
// where a take reads it (teams then keep today's flow in one checkout).
export function workspaceHomeLocation(projectDir: string): string | null {
  const at = projectInRepo(projectDir);
  if (at === null || at.prefix !== "") return null;
  const remote = soleRemote(projectDir);
  const address = remote === null ? "" : spawnSync("git", ["remote", "get-url", remote], { cwd: projectDir, encoding: "utf-8" }).stdout?.trim() ?? "";
  return address ? withoutCredentials(address) : "local";
}

// A repository's own remote: origin, else its one remote; null with none or several.
export function soleRemote(dir: string): string | null {
  const listed = spawnSync("git", ["remote"], { cwd: dir, encoding: "utf-8" }).stdout ?? "";
  const remotes = listed.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  return remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : null;
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
// path where the lead's rules are: this checkout's file, or the plan's rules/
// (`path` names where each file sits there).
export function leadRules(
  projectDir: string,
  homeSpace: string,
  read: (rel: string) => string | null = (rel) => readTextOrNull(join(projectDir, ...rel.split("/"))),
  // Where each file is: the lead's space's memory, or the plan's rules/.
  path: (file: string) => string = (file) => `aidlc/spaces/${homeSpace}/memory/${file}`,
): { paths: string[]; practices: string[]; project: string[] } {
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

// --- The plan the lead shares: its format (aidlc-unit.ts writes it) ---------
//
// The plan is a commit of plan.json, inputs/<rel> and rules/<file> on a ref of
// AI-DLC's own in one code repository. plan.json is the index: what a team's
// take and look read of the lead's record, so nobody reads the lead's
// workspace. A reader of an older release meets a format above its own and
// reads nothing of it.
export const PLAN_FORMAT = 1;

export interface PlanJson {
  format: number;
  // The n of the commit's message, so no reader reads a message a host rule
  // or the person changed.
  version: number;
  work: { id: string; label: string; space: string };
  // The repository this plan is in: a copy of it anywhere else is not the plan.
  plan_repo: { name: string; address: string };
  repos: Array<{ name: string; address: string | null; branch: string | null }>;
  units: Array<{ name: string; waits_on: string[]; repos: string[]; record: string; word: Record<string, unknown> }>;
  skeleton: string | null;
  settings: Record<string, string>;
  stages: Record<string, string>;
  unit_stages: string[];
  inputs: Array<{ path: string; fingerprint: string; approved?: string }>;
  [key: string]: unknown;
}

// Every setting a build copies from the lead's state, by the state's own field
// name; the ceremonies' and the Guard Policy's are read as their parsed value.
export const PLAN_SETTINGS = [
  "Scope", "Depth", "Test Strategy", "Review Override", "Construction Autonomy Mode", "Guard Policy",
  "Sensors", "Learnings", "Summary Confirmation", "Plan Approval", "Collaborators",
  "Project Type", UNIT_GATE_RHYTHM_FIELD, "Lead Sign-off",
] as const;

// The one reading of plan.json: the format its text carries (0 when it has
// none or does not read), and the plan, null above PLAN_FORMAT or when any
// part of it is not what a plan holds. Anyone who can push to the plan's
// repository can write this text, and its names become paths and git
// arguments in every team's workspace, so each is checked here, once.
export function planJsonOf(text: string): { format: number; plan: PlanJson | null } {
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    return { format: 0, plan: null };
  }
  const value = read as Record<string, unknown> | null;
  const format = typeof value?.format === "number" && Number.isInteger(value.format) ? value.format : 0;
  return { format, plan: format >= 1 && format <= PLAN_FORMAT && value !== null && planShaped(value) ? value as PlanJson : null };
}

const isString = (value: unknown): value is string => typeof value === "string";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// A branch git is given as a name, never an option or a refspec.
const isPlainBranch = (value: unknown): boolean =>
  isString(value) && value !== "" && !value.startsWith("-") && !/[\s:~^?*[\\]|\.\.|@\{/.test(value) && !value.endsWith("/");
// A path inside a build's record, as homeInputPaths writes it: never a climb,
// an absolute path, a backslash, the record's state or its audit.
const isRecordPath = (value: unknown): boolean =>
  isString(value) && value !== "" && !value.startsWith("/") && !value.includes("\\") && !/^[A-Za-z]:/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  value !== "aidlc-state.md" && !value.startsWith("audit/") && !value.startsWith(".aidlc-engine/");

// One line of text: a value that goes into a state field or a message.
const isLine = (value: unknown): value is string => isString(value) && !/[\r\n]/.test(value);
const isRepo = (value: unknown): value is string => isString(value) && isValidRepoName(value);
const isUnit = (value: unknown): value is string => isString(value) && validateUnitName(value) === null;
const isStage = (value: unknown): value is string => isString(value) && /^[a-z0-9][a-z0-9-]*$/.test(value);
const isAddress = (value: unknown): value is string => isLine(value) && value !== "" && !value.startsWith("-");

function planShaped(plan: Record<string, unknown>): boolean {
  const work = plan.work;
  const home = plan.plan_repo;
  return Number.isInteger(plan.version) &&
    isObject(work) && isLine(work.id) && isLine(work.label) && isString(work.space) && SPACE_NAME_REGEX.test(work.space) &&
    isObject(home) && isRepo(home.name) && isAddress(home.address) &&
    Array.isArray(plan.repos) && plan.repos.every((repo) => isObject(repo) && isRepo(repo.name) &&
      (repo.address === null || isAddress(repo.address)) && (repo.branch === null || isPlainBranch(repo.branch))) &&
    Array.isArray(plan.units) && plan.units.every((unit) => isObject(unit) && isUnit(unit.name) &&
      Array.isArray(unit.waits_on) && unit.waits_on.every(isUnit) && Array.isArray(unit.repos) && unit.repos.every(isRepo) &&
      isRepo(unit.record) && isObject(unit.word)) &&
    (plan.skeleton === null || isUnit(plan.skeleton)) &&
    isObject(plan.settings) && Object.values(plan.settings).every(isLine) &&
    isObject(plan.stages) && Object.keys(plan.stages).every(isStage) && Object.values(plan.stages).every(isStage) &&
    Array.isArray(plan.unit_stages) && plan.unit_stages.every(isStage) &&
    Array.isArray(plan.inputs) && plan.inputs.every((input) => isObject(input) && isRecordPath(input.path) && isLine(input.fingerprint) &&
      (input.approved === undefined || isLine(input.approved)));
}

// One folder per repository read under refs/aidlc/home/<id8>/: the same for
// every spelling of one repository's address (gitAddressKey), so a fetch with
// prune on into one never removes another's copies.
export function repoCopyKey(address: string): string {
  return createHash("sha256").update(gitAddressKey(address)).digest("hex").slice(0, 12);
}

// This workspace's copy of a ref read at `address`, never pushed: the plan, a
// Unit's record, or a work's records folder (ending in "/").
export function copyOf(address: string, ref: string): string {
  const plan = /^refs\/aidlc\/plans\/([^/]+)$/.exec(ref);
  if (plan !== null) return homeCopyName(plan[1], repoCopyKey(address), "plan");
  const record = /^refs\/aidlc\/claims\/([^/]+)\/([^/]*)$/.exec(ref);
  if (record !== null) return homeCopyName(record[1], repoCopyKey(address), `claims/${record[2]}`);
  throw new Error(`No copy is kept for ${ref}.`);
}

// A path of the lead's workspace at a commit here, or null.
export function textAt(projectDir: string, commit: string, rel: string): string | null {
  const shown = spawnSync("git", ["show", `${commit}:${rel}`, "--"], { cwd: projectDir, encoding: "utf-8" });
  return shown.status === 0 ? shown.stdout : null;
}

// The lead's files a team's build follows (LEAD_RULES_FIELD), each read where
// it is: in this checkout when the lead's work is here, else in this
// workspace's copy of the plan (rules/...), so the team's own default memory is
// never read as the lead's. `text` is null for a file that cannot be read now;
// `fromCopy` marks one read from the copy.
export function leadRuleFiles(projectDir: string, stateContent: string): Array<{ path: string; text: string | null; fromCopy: boolean }> {
  const paths = (getField(stateContent, LEAD_RULES_FIELD) ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (paths.length === 0) return [];
  const build = unitBuildOf(stateContent);
  if (build === null || !takenFromPlan(projectDir, build)) {
    return paths.map((path) => ({ path, text: readTextOrNull(join(projectDir, ...path.split("/"))), fromCopy: false }));
  }
  const copy = copyOf(build.homeLocation, planRecordRef(idSuffix(build.homeWork)));
  return paths.map((path) => ({ path, text: textAt(projectDir, copy, path), fromCopy: true }));
}

// The lead's work a build is of, when its record is in this workspace (a clone
// of a workspace several teams share, or solo work's second person): found by
// the work's id in any space.
export function leadWorkHere(projectDir: string, homeWork: string): { space: string; dirName: string } | null {
  if (homeWork === "") return null;
  let spaces: string[] = [];
  try {
    spaces = readdirSync(join(projectDir, "aidlc", "spaces"));
  } catch {
    return null;
  }
  for (const space of spaces) {
    const row = listIntents(projectDir, space).find((intent) => intent.uuid === homeWork && intent.dirName);
    if (row?.dirName && existsSync(join(intentsDir(projectDir, space), row.dirName, "aidlc-state.md"))) return { space, dirName: row.dirName };
  }
  return null;
}

// A build taken from the plan where it is shared: of team work, wherever the
// lead's work is (a clone of a workspace several teams share has it on disk).
// Solo work's second person takes from the lead's work here.
export function takenFromPlan(projectDir: string, build: UnitBuild): boolean {
  if (!isGitAddress(build.homeLocation)) return false;
  const here = leadWorkHere(projectDir, build.homeWork);
  return here === null || isTeamUnitOwnership(readStateFile(projectDir, here.dirName, here.space));
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

function inAuditOrder(rows: readonly AuditShardEvent[]): AuditShardEvent[] {
  return [...rows].sort((a, b) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1)
    : a.shardIndex !== b.shardIndex ? a.shardIndex - b.shardIndex : a.pos - b.pos));
}

// The lead's word to build a Unit at the lead's project (`assign --here`).
function assignedHere(row: AuditShardEvent, unit: string): boolean {
  return row.event === "UNITS_ASSIGNED" && (auditBlockField(row.block, "Here") ?? "").split(",").some((name) => name.trim() === unit);
}

// A Unit's UNIT_MERGED rows that still stand: none recorded before the lead's
// Build and Test last sent it back (UNIT_SENT_BACK) or the lead took it back
// to build here (assign --here), in audit order.
export function unitMergesStanding(rows: readonly AuditShardEvent[], unit: string): AuditShardEvent[] {
  const mine = inAuditOrder(rows).filter((row) => auditBlockField(row.block, "Unit") === unit || assignedHere(row, unit));
  const back = mine.findLastIndex((row) => row.event === "UNIT_SENT_BACK" || row.event === "UNITS_ASSIGNED");
  return mine.slice(back + 1).filter((row) => row.event === "UNIT_MERGED");
}

// The Units a team built and merged that the lead then took back to build at
// the lead's project (assign --here after the merge), each with the stages
// reopened for it since (its GATE_REJECTED rows), none while it waits for its
// reopen. The stages before the earliest of them keep the team's approved work.
export function unitsTakenBackHere(rows: readonly AuditShardEvent[]): Map<string, string[]> {
  const taken = new Map<string, string[]>();
  const merged = new Set<string>();
  for (const row of inAuditOrder(rows)) {
    const unit = auditBlockField(row.block, "Unit");
    if (row.event === "UNIT_MERGED" && unit && auditBlockField(row.block, "Built By") !== null) merged.add(unit);
    else if (row.event === "UNIT_SENT_BACK" && unit) merged.delete(unit);
    else if (row.event === "UNITS_ASSIGNED") {
      for (const name of (auditBlockField(row.block, "Here") ?? "").split(",").map((entry) => entry.trim())) {
        if (merged.delete(name)) taken.set(name, []);
      }
    } else if (row.event === "GATE_REJECTED" && unit) {
      const stage = auditBlockField(row.block, "Stage");
      if (stage) taken.get(unit)?.push(stage);
    }
  }
  return taken;
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
  return findBuild(projectDir, (build) => isBuildOfUnit(build, homeWork, unit));
}

// Whether a build is of the home's Unit: the one match findUnitBuild and a
// build on another branch of this clone (branchWithBuild in aidlc-unit.ts) read.
export function isBuildOfUnit(build: UnitBuild, homeWork: string, unit: string): boolean {
  return build.unit === unit && build.homeWork === homeWork;
}

// A build's record while it is live: one given back (archived) is left out.
export function liveBuildOf(state: string): UnitBuild | null {
  const build = unitBuildOf(state);
  return build === null || getField(state, "Status")?.trim() === "Archived" ? null : build;
}

// The build here of a Unit of the work with this id, in any space.
export function findUnitBuildOfWork(projectDir: string, id8: string, unit: string): { space: string; dirName: string } | null {
  return findBuild(projectDir, (build) => build.unit === unit && idSuffix(build.homeWork) === id8);
}

function findBuild(projectDir: string, matches: (build: UnitBuild) => boolean): { space: string; dirName: string } | null {
  const found = unitBuildsHere(projectDir, matches, true)[0];
  return found === undefined ? null : { space: found.space, dirName: found.dirName };
}

// The builds here whose record matches, archived ones left out, with their
// state; the first one alone with `first`.
export function unitBuildsHere(
  projectDir: string,
  matches: (build: UnitBuild, state: string) => boolean,
  first = false,
): Array<{ space: string; dirName: string; build: UnitBuild }> {
  const found: Array<{ space: string; dirName: string; build: UnitBuild }> = [];
  let spaces: string[];
  try {
    spaces = readdirSync(join(projectDir, "aidlc", "spaces"));
  } catch {
    return found;
  }
  for (const space of spaces) {
    for (const dirName of listIntentDirs(projectDir, space)) {
      let state: string;
      try {
        state = readStateFile(projectDir, dirName, space);
      } catch {
        continue;
      }
      const build = liveBuildOf(state);
      if (build === null || !matches(build, state)) continue;
      found.push({ space, dirName, build });
      if (first) return found;
    }
  }
  return found;
}

// A fact, not a task: the agent carried the earlier words (with their command
// list) into every later look as a to-do.
export const CHECK_IN_LINE = "Your teammates see where this work stands once aidlc/ is committed and pushed.";

// The stages a record's counts name: every stage the plan runs after
// Initialization, but at a lead's project that teams build for not the Units'
// own stages, which run in each taker's build. Read by status's Completion
// and by the step's progress and 'stage N of M' lines.
export function stagesCounted(
  stateContent: string,
  scope: string,
  work: { projectDir: string; intent?: string; space?: string } | null,
): StageEntry[] {
  const planned = plannedStages(stateContent, scope, work);
  const unitStages = unitStagesOfTeams(stateContent, scope);
  return unitStages === null ? planned : planned.filter((stage) => !unitStages.has(stage.slug));
}

// At a lead's project that teams build for, the Units' own stages, which run in
// each taker's build: status's counts leave them out (stagesCounted), and the
// check-in reads their boxes as the engine's (teamsReadOfState). Null elsewhere.
function unitStagesOfTeams(stateContent: string, scope: string): Set<string> | null {
  if (!isTeamUnitOwnership(stateContent) || homeLocation(stateContent) === null || unitBuildOf(stateContent) !== null) return null;
  return new Set(unitMajorConstructionStageSlugs(scope, stateContent, true));
}

// What the chat that heard CHECK_IN_LINE hears once at its first look after the
// person's own commit and push, and status's line then (checkInState).
export const CHECKED_IN_LINE = "aidlc/ is committed and pushed: your teammates see where this work stands.";

// That chat's line for where the record is: with the team, or pushed on a
// branch of its own (a pull request's) that is not in the integration branch
// yet. Null when it is neither.
export function checkInNotice(state: CheckIn): string | null {
  if (typeof state === "string") return null;
  return "pushedOn" in state ? `aidlc/ is pushed on ${state.pushedOn}; your teammates see it once it is in ${state.into}.` : CHECKED_IN_LINE;
}

// Status's Checked in field for the same, or null. The branch is named, so a
// record merged by its pull request is not read as still on the branch pushed
// for it; a checkout that merge left ahead and behind hears the command that
// brings it level, losing nothing (levelByContent).
export function checkInStatus(state: CheckIn): string | null {
  if (typeof state === "string") return null;
  if ("pushedOn" in state) return `Checked in:     pushed on ${state.pushedOn}, not in ${state.into} yet`;
  const yes = `Checked in:     yes, aidlc/ is in ${state.into} on ${state.remote}`;
  if (state.split === null) return yes;
  const theirs = `${state.remote}/${state.into}`;
  // Loaded only here, as checkInState loads it: aidlc-unit.ts imports this file.
  const { CHECKOUT_STEPS } = require("./aidlc-unit.ts") as typeof import("./aidlc-unit.ts");
  return `${yes}\n${`Your ${state.into}:`.padEnd(15)} ${theirs} already has your work, merged as commits of its own, so yours is ` +
    `${state.split.ahead} ahead and ${state.split.behind} behind. \`${CHECKOUT_STEPS.level.terminal()}\` brings it level; nothing of yours is lost.`;
}

// The work's checkout on its branch that a squash or rebase merge left ahead
// and behind the remote's copy, with all of its work there (checkInState's
// split): what the offer to bring it level names, and this commit of theirs,
// its once. The branch is read against its upstream first, so a look that is
// not split reads nothing more. Null when it is not so.
export function levelDue(projectDir: string, stateContent: string):
  { head: string; remote: string; branch: string; ahead: number; behind: number } | null {
  const run = (args: string[]) => spawnSync("git", ["-C", projectDir, ...args], { encoding: "utf-8", timeout: 10_000 });
  const counted = run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
  // With no upstream, checkInState reads the work's own branch.
  const [ahead = 0, behind = 0] = counted.status === 0 ? counted.stdout.trim().split(/\s+/).map(Number) : [1, 1];
  if (!(ahead > 0 && behind > 0) || !checkInApplies(projectDir, stateContent)) return null;
  const state = checkInState(projectDir, stateContent);
  if (typeof state !== "object" || !("split" in state) || state.split === null) return null;
  const head = run(["rev-parse", "HEAD"]).stdout.trim();
  return head === "" ? null : { head, remote: state.remote, branch: state.into, ...state.split };
}

// Teams across repos share AI-DLC's record by git, and the person checks it in.
// The callers say this at the stopping points (a stop, the push or the
// person's Not now to it, the lead's Build and Test approval), unless aidlc/ is
// checked in or pushed on a branch of its own (checkInState). Null for other
// work (main's team Units on the workspace's own repo commit the record for the
// person) and where there is no remote to push.
export function checkInLine(projectDir: string, stateContent?: string): string | null {
  if (!checkInApplies(projectDir, stateContent)) return null;
  // The lead's own work shares its plan by the plan's ref: the teams never
  // read the lead's record, so its check-in is the lead's own business.
  try {
    const state = stateContent ?? readStateFile(projectDir);
    if (unitBuildOf(state) === null) return null;
  } catch {
    return null;
  }
  const state = checkInState(projectDir, stateContent);
  if (typeof state === "object") return null;
  // The chat is noted as handed the line, whichever step carries it, so its
  // first look after the check-in says it is done (checkInHandedOut).
  const session = resolveWorkflowSelection(projectDir).sessionId;
  if (session && !isReadOnlyEngineProbe()) markPersonLinesHeard(projectDir, session, [CHECK_IN_HANDED]);
  return CHECK_IN_LINE;
}

// The person-lines record's note that this chat was handed CHECK_IN_LINE; never said.
const CHECK_IN_HANDED = "(the check-in line was handed out)";

export function checkInHandedOut(projectDir: string, sessionId: string): boolean {
  return personLineHeard(projectDir, sessionId, CHECK_IN_HANDED);
}

export function checkInApplies(projectDir: string, stateContent?: string): boolean {
  let state = stateContent;
  if (state === undefined) {
    try {
      state = readStateFile(projectDir);
    } catch {
      return false;
    }
  }
  if (unitBuildOf(state) === null && !(isTeamUnitOwnership(state) && homeLocation(state) !== null)) return false;
  const remotes = spawnSync("git", ["-C", projectDir, "remote"], { encoding: "utf-8", timeout: 10_000 });
  return remotes.status === 0 && remotes.stdout.trim() !== "";
}

// A state file at a lead's project that teams build for, as the teams read it
// once what the engine rewrites from its own evidence at each look is set
// aside: in the Unit Progress section only its heading, the engine's note and
// the table rows (any other line there still counts, as for the digest), the
// boxes of the Units' own stages and the Completed count the same refresh sets
// from that table, and blank lines (a field setter's separators). The approval
// rhythm is read as each take reads it (readUnitGateRhythm), so a per-stage
// answer reads as the plan with none and a unit-end one does not. Each text
// names its own Units' stages, so two texts that differ in them differ. Null
// elsewhere, where every change counts.
function teamsReadOfState(content: string): string | null {
  const text = content.replaceAll("\r\n", "\n");
  const unitStages = unitStagesOfTeams(text, getField(text, "Scope") ?? "");
  if (unitStages === null) return null;
  let kept = text;
  const range = unitProgressSectionRange(kept);
  if (range !== null) {
    const others = kept.slice(range.start, range.end).split("\n")
      .filter((line, at) => at !== 0 && line !== UNIT_PROGRESS_NOTE && !line.startsWith("|"));
    kept = `${kept.slice(0, range.start)}${others.join("\n")}\n${kept.slice(range.end)}`;
  }
  for (const slug of unitStages) kept = setCheckbox(kept, slug, "pending");
  kept = removeField(removeField(kept, "Completed"), UNIT_GATE_RHYTHM_FIELD);
  return [`rhythm ${readUnitGateRhythm(text)}`, `unit stages ${[...unitStages].sort().join(" ")}`,
    ...kept.split("\n").filter((line) => line.trim() !== "")].join("\n");
}

// A change git status lists under aidlc/ that is only the engine's own writes
// since what is committed to a work's state file at a lead's project
// (teamsReadOfState): the board's Unit Progress, the marks it sets, a rhythm
// answer the teams read the same. Unstaged only, a file and never a link;
// anything git or the file cannot tell counts. `change.path` is git's, from the
// repository root; `prefix` is the project folder's place under it.
export function onlyEngineStateWrites(projectDir: string, prefix: string, change: { status: string; path: string }): boolean {
  if (change.status !== " M" || !change.path.startsWith(prefix)) return false;
  const rel = change.path.slice(prefix.length);
  if (!/^aidlc\/spaces\/[^/]+\/intents\/[^/]+\/aidlc-state\.md$/.test(rel)) return false;
  try {
    const file = join(projectDir, ...rel.split("/"));
    if (!lstatSync(file).isFile()) return false;
    const blob = spawnSync("git", ["-C", projectDir, "cat-file", "blob", `HEAD:${change.path}`], { encoding: "utf-8", timeout: 10_000 });
    if (blob.status !== 0) return false;
    const was = teamsReadOfState(blob.stdout);
    return was !== null && was === teamsReadOfState(readFileSync(file, "utf-8"));
  } catch {
    return false;
  }
}

// Where checkInState finds the record: in the work's integration branch on its
// remote (`split`: this checkout's own copy of that branch is ahead and behind
// it, everything it has in it by content), or pushed on a branch of its own
// that is not in it yet.
export type CheckIn =
  | "not-checked-in"
  | "unknown"
  | { pushedOn: string; into: string }
  | { into: string; remote: string; split: { ahead: number; behind: number } | null };

// The paths a diff of `range` names under `paths` (the whole repo when there
// are none): the one reader of "the same files" after a squash or rebase merge
// (checkInState, the plan's own branch). The person's diff.relative would
// narrow a whole-repo compare to this folder; -c rather than --no-relative,
// which git before 2.28 does not know. Null when git cannot tell.
export function diffNames(projectDir: string, range: string[], paths: string[]): Set<string> | null {
  const listed = spawnSync("git", ["-C", projectDir, "-c", "diff.relative=false", "diff", "--name-only", "-z", "--no-renames", ...range, "--", ...paths], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  return listed.status === 0 ? new Set(listed.stdout.split("\0").filter(Boolean)) : null;
}

// Everything `from` (HEAD unless named) changed since it left `into` is the
// same in `into`: there by ancestry, or by a squash or rebase merge that took
// the same files in. Null when git cannot tell.
export function headInByContent(projectDir: string, into: string, from = "HEAD"): boolean | null {
  const mine = diffNames(projectDir, [`${into}...${from}`], []);
  const differ = diffNames(projectDir, [into, from], []);
  return mine === null || differ === null ? null : ![...mine].some((path) => differ.has(path));
}

// Why `git reset --keep` would lose something of theirs bringing a branch level
// (levelByContent), for the line the person reads.
export type LevelBlock =
  | { why: "staged" }
  | { why: "changed"; path: string }
  | { why: "replaced"; path: string }
  | { why: "own-work" };

// A checkout on `branch` that a squash or rebase merge left ahead and behind
// `remote`'s copy of it (as this clone last fetched it), and whether `git reset
// --keep` to that copy's commit (`theirs`, read here) brings it level losing
// nothing: everything its own commits changed is in that copy by content, over
// the whole repo; nothing is staged (reset --keep would unstage it); no change
// of theirs is on a file the two differ in (it refuses); no untracked or ignored
// file of theirs sits where the copy adds one (it would replace an ignored one).
// `block` names the first that stands, null when none does. Null when the
// branch is not checked out here, it is not both ahead and behind, or git
// cannot tell. The one proof status's line and bringBranchLevel's reset read.
export function levelByContent(dir: string, remote: string, branch: string):
  { ahead: number; behind: number; theirs: string; block: LevelBlock | null } | null {
  const run = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8", timeout: 10_000 });
  if (run(["symbolic-ref", "--quiet", "HEAD"]).stdout.trim() !== `refs/heads/${branch}`) return null;
  const theirs = run(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}^{commit}`]).stdout.trim();
  if (theirs === "") return null;
  const counted = run(["rev-list", "--left-right", "--count", `HEAD...${theirs}`]);
  const [ahead = 0, behind = 0] = counted.stdout.trim().split(/\s+/).map(Number);
  if (counted.status !== 0 || !(ahead > 0 && behind > 0)) return null;
  const mine = diffNames(dir, [`${theirs}...HEAD`], []);
  const differ = diffNames(dir, [theirs, "HEAD"], []);
  const added = diffNames(dir, ["--diff-filter=A", "HEAD", theirs], []);
  const top = run(["rev-parse", "--show-toplevel"]);
  const staged = run(["diff", "--cached", "--quiet"]);
  const dirty = run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (mine === null || mine.size === 0 || differ === null || added === null || top.status !== 0 || dirty.status !== 0 ||
    (staged.status !== 0 && staged.status !== 1)) {
    return null;
  }
  const level = { ahead, behind, theirs };
  if ([...mine].some((path) => differ.has(path))) return { ...level, block: { why: "own-work" } };
  if (staged.status === 1) return { ...level, block: { why: "staged" } };
  // -z entries: "XY path", a rename's or copy's source path after it on its own.
  for (const entry of dirty.stdout.split("\0").filter(Boolean)) {
    const path = differ.has(entry) ? entry : entry.slice(3);
    if (!differ.has(path)) continue;
    return { ...level, block: entry.startsWith("??") ? { why: "replaced", path } : { why: "changed", path } };
  }
  // An ignored file git status does not list, where the copy adds one.
  for (const path of added) {
    try {
      lstatSync(join(top.stdout.trim(), ...path.split("/")));
      return { ...level, block: { why: "replaced", path } };
    } catch {
      // Not there: nothing of theirs in its way.
    }
  }
  return { ...level, block: null };
}

// Whether aidlc/ is checked in, from local git only: nothing under it changed
// but the rows each look adds to this clone's own audit file (onlyOwnLookRows,
// doctor's rule too; a decision of the person's there still counts) and, at a
// lead's project, the engine's own writes to a work's state file
// (onlyEngineStateWrites; a real edit there still counts), and what
// HEAD has of it is in the work's integration branch on its remote as this
// clone last fetched it (checkInTarget), by ancestry or, after a squash or
// rebase merge, path by path. Pushed on a branch of its own while it is not in
// it yet. Unknown when git cannot tell: no integration branch here, a branch
// never pushed, pushed only as one named like the integration branch (a fork's
// main), a detached HEAD, or git failing.
export function checkInState(projectDir: string, stateContent?: string): CheckIn {
  const run = (args: string[]) => spawnSync("git", ["-C", projectDir, ...args], { encoding: "utf-8", timeout: 10_000 });
  let target: { remote: string; branch: string } | null;
  try {
    // A build's branch is the one its take read the plan from: the home's
    // space, when the home's record is in this workspace.
    let build: UnitBuild | null = null;
    try {
      build = unitBuildOf(stateContent ?? readStateFile(projectDir));
    } catch {
      // No record selected: the active space answers.
    }
    const here = build === null ? null : leadWorkHere(projectDir, build.homeWork);
    // Loaded only here: aidlc-unit.ts imports this file, and the hooks' own tool set leaves it out.
    const { checkInTarget } = require("./aidlc-unit.ts") as typeof import("./aidlc-unit.ts");
    target = checkInTarget(projectDir, here?.space);
  } catch {
    return "unknown";
  }
  if (target === null) return "unknown";
  // Narrowed once, for the closures below.
  const integration = target;
  const into = `refs/remotes/${target.remote}/${target.branch}`;
  const prefix = run(["rev-parse", "--show-prefix"]);
  const changed = run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "aidlc"]);
  if (prefix.status !== 0 || changed.status !== 0 || run(["rev-parse", "--verify", "--quiet", into]).status !== 0) return "unknown";
  const root = prefix.stdout.trim();
  // -z entries: "XY path", a rename's or copy's source path after it.
  const entries = changed.stdout.split("\0").filter(Boolean);
  const changes: Array<{ status: string; path: string }> = [];
  for (let at = 0; at < entries.length; at++) {
    changes.push({ status: entries[at].slice(0, 2), path: entries[at].slice(3) });
    if (/^[RC]/.test(entries[at])) at++;
  }
  // The rows each look adds to this clone's own audit file, and the engine's own
  // writes to a lead's state file, do not count.
  if (!changes.every((change) => onlyOwnLookRows(projectDir, root, change) || onlyEngineStateWrites(projectDir, root, change))) {
    return "not-checked-in";
  }
  // A squash or rebase merge puts the same files in as commits of its own.
  const names = (range: string[], paths = ["aidlc"]): Set<string> | null => diffNames(projectDir, range, paths);
  // This checkout on the integration branch itself, ahead and behind it, that
  // AI-DLC can bring level losing nothing (levelByContent).
  const split = (): { ahead: number; behind: number } | null => {
    const level = levelByContent(projectDir, integration.remote, integration.branch);
    return level === null || level.block !== null ? null : { ahead: level.ahead, behind: level.behind };
  };
  const checkedIn = () => ({ into: integration.branch, remote: integration.remote, split: split() });
  const ahead = run(["log", "--format=%H", `${into}..HEAD`, "--", "aidlc"]);
  if (ahead.status !== 0) return "unknown";
  if (ahead.stdout.trim() === "") return checkedIn();
  const mine = names([`${into}...HEAD`]);
  const differ = names([into, "HEAD"]);
  if (mine === null || differ === null) return "unknown";
  if (![...mine].some((path) => differ.has(path))) return checkedIn();
  const head = run(["symbolic-ref", "--quiet", "HEAD"]);
  if (head.status !== 0) return "unknown";
  const upstream = run(["for-each-ref", "--format=%(upstream:remotename) %(upstream:remoteref)", head.stdout.trim()]);
  const [remote = "", ref = ""] = upstream.status === 0 ? upstream.stdout.trim().split(" ") : [];
  const pushedOn = ref.replace(/^refs\/heads\//, "");
  if (remote === "" || remote === "." || pushedOn === ref || pushedOn === target.branch) return "unknown";
  const unpushed = run(["log", "--format=%H", "@{upstream}..HEAD", "--", "aidlc"]);
  if (unpushed.status !== 0) return "unknown";
  return unpushed.stdout.trim() === "" ? { pushedOn, into: target.branch } : "not-checked-in";
}

// What the person's last `git pull` here that brought changes brought from
// other people, by who made each change (the git name git records on the
// pulled commits, the name the board shows), never by space: "<who>: <Unit or
// work>, ..." per person, people joined by semicolons, with no possessive so it
// reads the same for every name. Read from this clone's own reflog (a pull that
// brought nothing writes no entry), so nothing is written. Null with no such
// pull here, nothing from anyone else (the person's own changes from another
// computer are theirs), or no git. A build's name is followed by where it
// stands when the caller's reader says (status passes the take question's).
export function arrivedAtLastPull(
  projectDir: string,
  standing?: (built: { space: string; dirName: string }) => string | null,
): string | null {
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
  const log = spawnSync("git", ["-C", projectDir, "log", "--no-merges", "--name-only", "--format=%x01%an",
    `${rows[last + 1][0]}..${rows[first][0]}`, "--", "aidlc/spaces"], { encoding: "utf-8", timeout: 10_000 });
  if (log.status !== 0) return null;
  const me = gitUserName(projectDir);
  // Each record once per person who changed it, newest first as git lists them.
  const byPerson = new Map<string, string[]>();
  for (const commit of log.stdout.split("\u0001").slice(1)) {
    const [author, ...paths] = commit.split("\n");
    const who = author.trim();
    if (who === "" || who === me) continue;
    for (const path of paths) {
      const match = /^aidlc\/spaces\/([^/]+)\/intents\/([^/]+)\//.exec(path.trim());
      if (match === null) continue;
      const [, space, dirName] = match;
      let label = dirName;
      try {
        const state = readStateFile(projectDir, dirName, space);
        const entry = listIntents(projectDir, space).find((intent) => intent.dirName === dirName);
        const unit = unitBuildOf(state)?.unit;
        const where = unit === undefined ? null : standing?.({ space, dirName }) ?? null;
        label = unit === undefined ? (entry !== undefined ? intentDisplayLabel(entry) : dirName) : where === null ? unit : `${unit} (${where})`;
      } catch {
        // A record no longer here keeps its folder name.
      }
      const theirs = byPerson.get(who) ?? [];
      if (!theirs.includes(label)) byPerson.set(who, [...theirs, label]);
    }
  }
  return byPerson.size === 0 ? null : [...byPerson].map(([who, labels]) => `${who}: ${labels.join(", ")}`).join("; ");
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

// The person's words for a Unit command never go on its line (a shell would
// read their quotes): the agent writes them, as they typed them, to the file
// the command names, with its file tool, and the command reads them from there
// (readRequestFile, as `unit gate` does).
export function unitWordsArg(verb: string, unit?: string): string {
  return `--request-file ${unitWordsFile(verb, unit)}`;
}

// The file in the request-text folder for a Unit verb's words: one name rule
// for each file the agent writes there for a Unit command.
export function unitWordsFile(verb: string, name?: string): string {
  const named = [verb, ...(name === undefined ? [] : [name])].join("-").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${REQUEST_TEXT_DIR}/unit-${named}.txt`;
}

// A commit AI-DLC makes for the person carries the message the agent drafted
// for it in the repo's own style, shown in the question that ends in it, and
// the person's own words replace it. These pieces are read by the
// session-start hook too, which never loads aidlc-unit.ts.
export const RECORD_COMMIT_MESSAGE = "Update AI-DLC's record";

export const OWN_MESSAGE_SENTENCE = "when they give their own commit message, write it to that file first, with your file " +
  "tool, never a shell, exactly as they gave it";

// The agent's draft, said to nobody: over `today`, the message the commit
// carries if the draft never comes, in `file`.
export function commitDraftSentence(whose: string, repos: string, about: string, file: string, today: string): string {
  return `Draft ${whose} the way ${repos}'s own commits are written (their recent ` +
    `commits, a commitlint config or a contributing guide say how), about ${about}. Write it with your file ` +
    `tool, never a shell, over the message in \`${file}\`, which holds \`${today}\` now; leave that as it is when it ` +
    "already fits.";
}

// `today` written into the message file for the agent to draft over: true once
// written, false when it cannot be (the question then shows `today` without it).
export function writeCommitDraft(projectDir: string, file: string, today: string): boolean {
  if (isReadOnlyEngineProbe()) return false;
  try {
    writeRecordFileNoFollow(projectDir, file, `${today}\n`);
    return true;
  } catch {
    return false;
  }
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
// after it); or one first-parent commit, or a run of consecutive ones (a
// rebase merge that replays the Unit's commits one by one), is the same change
// by patch-id. Anything else is not merged yet.
// ponytail: the walk reads the latest 500 first-parent commits after the base,
// and a run is at most MERGE_RUN_MAX commits long.
const MERGE_RUN_MAX = 50;
export function unitMergeVerdict(dir: string, integration: string, result: RepoResult): MergeVerdict {
  const head = result.heads.at(-1);
  if (head && gitIn(dir, ["merge-base", "--is-ancestor", head, integration]).ok) {
    return { merged: true, commit: head, how: "ancestry" };
  }
  const paths = Object.keys(result.paths);
  if (paths.length === 0) return { merged: false };
  const range = mergeWalkRange(dir, integration, result);
  const commits = gitIn(dir, ["rev-list", "--first-parent", "--reverse", "--max-count=500", range])
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
    // A run starts and ends at a commit that changes the Unit's files.
    const touching = new Set(gitIn(dir, ["rev-list", "--first-parent", "--max-count=500", range, "--", ...paths]).out.split("\n").filter(Boolean));
    const ends = commits.flatMap((commit, at) => (touching.has(commit) ? [at] : []));
    for (const [n, from] of ends.entries()) {
      for (const to of ends.slice(n + 1)) {
        if (to - from >= MERGE_RUN_MAX) break;
        if (patchIdOf(dir, `${commits[from]}^`, commits[to], paths) === result.patch_id) {
          return { merged: true, commit: commits[to], how: "same change" };
        }
      }
    }
  }
  return { merged: false };
}

// The first-parent commits the merge check walks: those after the base, or
// all of them when the base is not here.
function mergeWalkRange(dir: string, integration: string, result: RepoResult): string {
  const known = gitIn(dir, ["rev-parse", "--verify", "--quiet", `${result.base}^{commit}`]).ok;
  return known ? `${result.base}..${integration}` : integration;
}

// For a repo the merge check finds not merged: the first first-parent commit
// after the base that changes every file of the Unit's part there, by name (a
// merge the check cannot see: a fix, a squash and the branch's deletion all
// between two looks). The board asks the lead once whether it is the merge.
export function mergeCandidate(dir: string, integration: string, result: RepoResult): { commit: string; subject: string } | null {
  const paths = Object.keys(result.paths);
  if (paths.length === 0) return null;
  const commits = gitIn(dir, ["rev-list", "--first-parent", "--reverse", "--max-count=500", mergeWalkRange(dir, integration, result), "--", ...paths])
    .out.split("\n").filter(Boolean);
  for (const commit of commits) {
    const changed = new Set(gitIn(dir, ["diff", "--name-only", "--no-renames", `${commit}^`, commit, "--", ...paths]).out.split("\n").filter(Boolean));
    if (paths.every((path) => changed.has(path))) {
      return { commit, subject: gitIn(dir, ["log", "-1", "--format=%s", commit]).out.trim() };
    }
  }
  return null;
}

// The board's line for it, said once in a chat; the lead's yes is their word
// that the repo merged (unit merged).
export function mergeCandidateLine(unit: string, repo: string, candidate: { commit: string; subject: string }): string {
  return `${repo === "." ? "The repo" : repo} has ${candidate.commit.slice(0, 7)} "${candidate.subject}" changing every file of ` +
    `${unit}; if that is ${unit} merged, say so.`;
}

// The host's refs for the pull request a commit that may be the merge names,
// in the references the hosts write by default: GitHub's squash ends its
// subject "(#41)"; GitLab's merge commit has a body line ending in
// "group/project!41" or ".../-/merge_requests/41". Both hosts' ref names for
// that number, since each host has only its own. They only pick which head the
// merge check reads; whether it is the Unit's, and the merge its content, is
// the check's.
export function pullRequestHeadRefs(message: string): string[] {
  const [subject = "", ...body] = message.split(/\r?\n/);
  const number = / \(#(\d+)\)$/.exec(subject.trimEnd())?.[1] ??
    body.map((line) => /(?:[\w.-]+\/[\w./-]*[\w.-]!|\/-\/merge_requests\/)(\d+)$/.exec(line.trim())?.[1]).find(Boolean);
  return number === undefined ? [] : [`refs/pull/${number}/head`, `refs/merge-requests/${number}/head`];
}

// A result as at a later tip of its Unit branch that AI-DLC did not push (a
// review fix by hand, a host's suggestion commit, Update branch): the tip as
// its last head, and the files changed from where the tip leaves the
// integration branch to the tip, each at the tip's blob. Null unless the tip
// is here and descends from the last head.
export function resultAtTip(dir: string, integration: string, result: RepoResult, tip: string): RepoResult | null {
  const head = result.heads.at(-1);
  if (!head || tip === head || !gitIn(dir, ["merge-base", "--is-ancestor", head, tip]).ok) return null;
  // On the workspace's own repository, AI-DLC's record that went with the
  // Unit's code (its second commit) is never the Unit's work.
  const code = (paths: string[]): string[] => result.repo === "." ? paths.filter((path) => !path.startsWith("aidlc/")) : paths;
  const names = (from: string): string[] => code(gitIn(dir, ["diff", "--name-only", "--no-renames", from, tip]).out.split("\n").filter(Boolean));
  if (names(head).length === 0) return null;
  const from = gitIn(dir, ["merge-base", tip, integration]).out.trim() || result.base;
  const changed = names(from);
  const blobs = blobsAt(dir, tip, changed);
  const id = patchIdOf(dir, from, tip, changed);
  return {
    repo: result.repo,
    branch: result.branch,
    base: result.base,
    heads: [...result.heads, tip],
    paths: Object.fromEntries(changed.map((path) => [path, blobs.get(path) ?? null])),
    ...(id ? { patch_id: id } : {}),
  };
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
// clone's audit shard: it is being built from another machine. That shard;
// null otherwise. Its last row's stage is not where that machine is: it may
// have finished or left it since.
export function builtFromAnotherMachine(
  stateContent: string,
  rows: readonly AuditShardEvent[],
  ownShard: string,
): { shard: string } | null {
  if (isTeamUnitOwnership(stateContent) || getField(stateContent, "Construction Iteration")?.trim() !== "unit-major") return null;
  const moves = rows
    .filter((row) => row.event.startsWith("UNIT_") && auditBlockField(row.block, "Unit") && auditBlockField(row.block, "Stage"))
    .sort((a, b) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1) : a.pos - b.pos));
  const last = moves.at(-1);
  // A row's shard is the shard file's path; ownShard is this clone's shard name.
  if (last === undefined || basename(last.shard) === ownShard) return null;
  return { shard: last.shard };
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
