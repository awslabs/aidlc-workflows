// Teams building each Unit as a piece of work of their own (#2410): where the
// home is, what the Unit plan says about each Unit (likely repos, what it waits
// on), whether who builds which Unit was answered, and a Unit's build. Built on
// aidlc-lib.ts, which requires it lazily where its own functions need it.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuditShardEvent,
  auditBlockField,
  type BoltDagResolution,
  getField,
  type IntentRegistryEntry,
  intentRepos,
  intentsDir,
  isTeamUnitOwnership,
  listIntentDirs,
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

