// Teams building each Unit as a piece of work of their own (#2410): where the
// home is, what the Unit plan says about each Unit (likely repos, what it waits
// on), whether who builds which Unit was answered, and a Unit's build. Built on
// aidlc-lib.ts, which requires it lazily where its own functions need it.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { artifactFilename } from "./aidlc-artifact-vocabulary.ts";
import {
  type AuditShardEvent,
  auditBlockField,
  type BoltDagResolution,
  getField,
  type IntentRegistryEntry,
  intentRepos,
  intentsDir,
  isPerUnitStage,
  isTeamUnitOwnership,
  listIntentDirs,
  loadScopeMapping,
  loadStageGraphAll,
  parseBoltDag,
  readStateFile,
  unitDependencyPath,
  writeFileAtomic,
} from "./aidlc-lib.ts";

// Where the home of team-built work is: the address the workspace's own
// origin points to (read, never set), or "local" for a workspace with no
// remote. Recorded once, when teams are chosen; every copy of the workspace
// reads it. Its presence puts the work on teams building each Unit as a piece of
// work of their own; team work without it keeps the claim, publish, pin, gate
// and land flow it started on.
export const HOME_LOCATION_FIELD = "Home Location";

export function homeLocation(stateContent: string | null): string | null {
  const value = stateContent === null ? null : getField(stateContent, HOME_LOCATION_FIELD)?.trim();
  return value ? value : null;
}

// What to record as the home's location for a workspace, or null when it is not
// a git repo (teams then keep today's flow in one checkout).
export function workspaceHomeLocation(projectDir: string): string | null {
  if (!existsSync(join(projectDir, ".git"))) return null;
  const origin = spawnSync("git", ["remote", "get-url", "origin"], { cwd: projectDir, encoding: "utf-8" });
  return origin.status === 0 && origin.stdout.trim() ? origin.stdout.trim() : "local";
}

// Each Unit's likely repos, as Units Generation proposed them (a guide only),
// read from the authored units block. Empty when the block names none or
// cannot be read.
export function unitLikelyRepos(projectDir: string, intent?: string, space?: string): Map<string, string[]> {
  const likely = new Map<string, string[]>();
  try {
    const parsed = parseBoltDag(readFileSync(unitDependencyPath(projectDir, intent, space), "utf-8"));
    if (!parsed.ok) return likely;
    for (const unit of parsed.units) {
      if (unit.repos !== undefined && unit.repos.length > 0) likely.set(unit.name, unit.repos);
    }
  } catch {
    // No units block yet.
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

// Who builds which Unit was answered since the person last chose teams.
export function unitsAssignedSinceTeams(rows: readonly AuditShardEvent[]): boolean {
  const ordered = [...rows].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));
  let teamsAt = -1;
  ordered.forEach((row, at) => {
    if (row.event === "UNIT_OWNERSHIP_SET" && auditBlockField(row.block, "Mode") === "team") teamsAt = at;
  });
  return ordered.slice(teamsAt + 1).some((row) => row.event === "UNITS_ASSIGNED");
}

// Which team the lead named for each Unit at the home, as its latest
// UNITS_ASSIGNED row since teams were chosen records it.
export function unitsAssignedAtHome(rows: readonly AuditShardEvent[]): Map<string, string> {
  const named = new Map<string, string>();
  if (!unitsAssignedSinceTeams(rows)) return named;
  const latest = [...rows].filter((row) => row.event === "UNITS_ASSIGNED")
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)).at(-1);
  for (const pair of (auditBlockField(latest?.block ?? "", "Assigned") ?? "").split(",")) {
    const [unit, team] = pair.split("=").map((part) => part.trim());
    if (unit && team) named.set(unit, team);
  }
  return named;
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

// --- A Unit's build -----------------------------------------------------------
//
// The piece of work a team builds one Unit of the home's work as, in its own
// space. Its state names the home's location, the home's work, where its record
// is, the Unit and the claim attempt it came from.
export const UNIT_BUILD_FIELD = "Unit Build";
// "later" while the person has not asked for the push yet, "pushed" once it went.
export const UNIT_PUSH_FIELD = "Unit Push";

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

// The build of a home's Unit in this workspace, in any space: what taking that
// Unit again here carries on.
export function findUnitBuild(projectDir: string, homeWork: string, unit: string): { space: string; dirName: string } | null {
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
      if (build?.unit === unit && build.homeWork === homeWork) return { space, dirName };
    }
  }
  return null;
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

// Two spellings of one git address: trailing slash and `.git` aside.
export function sameGitAddress(a: string, b: string): boolean {
  const norm = (value: string): string => value.trim().replace(/[\\/]+$/, "").replace(/\.git$/, "");
  return norm(a) === norm(b);
}

// The home's work that git copied into a team's own workspace: its recorded
// home is not this workspace's own origin. It is the home's, read only, never
// this team's to carry on; nothing in the copy is changed.
export function isHomesCopiedWork(projectDir: string, state: string): boolean {
  const home = isTeamUnitOwnership(state) ? homeLocation(state) : null;
  if (home === null || home === "local") return false;
  return !sameGitAddress(home, workspaceHomeLocation(projectDir) ?? "");
}

// --- A Unit's result, and whether it merged -----------------------------------
//
// What a team's push sends home on the claim: per repo, the branch, the commit
// the Unit started from, every head pushed (the last is current), each changed
// path's blob at the head (null when deleted) and the change's patch-id. The
// home checks each repo against its own integration branch with git alone.

export interface RepoResult {
  // A repo name, or "." for the workspace's own repo.
  repo: string;
  url?: string;
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
  }
  return [...outputs].sort();
}

// A Unit's writes by the repo each is in, as its source manifest records them:
// a write names its repo, or is in the work's one recorded repo, or in the
// workspace's own repo (".").
export function writesByRepo(projectDir: string, writes: ReadonlyArray<{ path: string; repo?: string }>): Map<string, string[]> {
  const recorded = intentRepos(projectDir);
  const byRepo = new Map<string, string[]>();
  for (const write of writes) {
    const repo = write.repo ?? (recorded.length === 1 ? recorded[0] : ".");
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), write.path]);
  }
  return byRepo;
}

// --- The board ----------------------------------------------------------------
//
// One line per Unit, the same at the home and in every team's workspace.

export interface UnitBoardRow {
  unit: string;
  team: string | null;
  status: string;
}

export function renderUnitBoard(label: string, rows: readonly UnitBoardRow[]): string {
  return [`Units of ${label}:`, ...rows.map((row) => `- ${row.unit}, ${row.team ?? "open"}: ${row.status}`)].join("\n");
}

// How far a pushed Unit's repos are merged, in words: "checkout-api merged,
// billing not merged yet (1 of 2 merged)".
export function mergedStatus(verdicts: ReadonlyArray<{ repo: string; merged: boolean }>): string {
  const merged = verdicts.filter((verdict) => verdict.merged).length;
  const parts = verdicts.map((verdict) => `${verdict.repo === "." ? "the repo" : verdict.repo} ${verdict.merged ? "merged" : "not merged yet"}`);
  return verdicts.length === 1 ? parts[0] : `${parts.join(", ")} (${merged} of ${verdicts.length} merged)`;
}
