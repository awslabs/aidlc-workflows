// Teams building each Unit as a piece of work of their own (#2410): what the
// Unit plan says about them (likely repos, dependencies). Built on aidlc-lib.ts,
// never imported by it.

import { readFileSync } from "node:fs";
import { intentRepos, parseBoltDag, unitDependencyPath } from "./aidlc-lib.ts";

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
