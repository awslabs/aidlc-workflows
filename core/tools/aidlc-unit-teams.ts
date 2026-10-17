// Teams building each Unit as a piece of work of their own (#2410): where the
// home is, what the Unit plan says about each Unit (likely repos, what it waits
// on), and whether who builds which Unit was answered. Built on aidlc-lib.ts,
// never imported by it.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AuditShardEvent,
  auditBlockField,
  getField,
  intentRepos,
  parseBoltDag,
  unitDependencyPath,
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
