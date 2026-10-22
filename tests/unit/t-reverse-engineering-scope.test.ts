// covers: function:reverseEngineeringScopeNarration, function:RE_LARGE_SCOPE_REPOS
//
// Reverse Engineering's opening step says how many repositories the work
// records, after the stage's own progress line, and from RE_LARGE_SCOPE_REPOS
// what reading them all costs. The count is the recorded set, which `--repos`,
// `intent add-repo` and `intent remove-repo` can make differ from the folders
// on disk; the gate shown again keeps saying what the stage produced.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject, FIXTURES_DIR, REPO_ROOT, seededStateFile } from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  RE_LARGE_SCOPE_REPOS,
  reverseEngineeringScopeNarration,
} from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";

const projects: string[] = [];
const ARTIFACTS = [
  "business-overview", "architecture", "code-structure", "api-documentation", "component-inventory",
  "technology-stack", "dependencies", "code-quality-assessment", "reverse-engineering-timestamp",
];

// A brownfield work recording `recorded` of `onDisk` sibling git folders, with
// Reverse Engineering in progress (`-`) or at its gate (`?`).
function workspace(recorded: number, onDisk = recorded, mark: "-" | "?" = "-"): { proj: string; repos: string[] } {
  const proj = createTestProject();
  projects.push(proj);
  cpSync(join(REPO_ROOT, "dist", "claude", "aidlc"), join(proj, "aidlc"), { recursive: true, force: false, errorOnExist: false });
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace(/^(- \*\*Current Stage\*\*: ).*$/m, "$1reverse-engineering")
    .replace(/^- \[.\] reverse-engineering/m, `- [${mark}] reverse-engineering`);
  writeFileSync(seededStateFile(proj), state, "utf-8");
  const repos = Array.from({ length: onDisk }, (_, index) => `repo-${index}`);
  for (const repo of repos) mkdirSync(join(proj, repo, ".git"), { recursive: true });
  const registry = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
  const rows = JSON.parse(readFileSync(registry, "utf-8"));
  rows[0].repos = repos.slice(0, recorded);
  writeFileSync(registry, `${JSON.stringify(rows, null, 2)}\n`);
  return { proj, repos: repos.slice(0, recorded) };
}

// `next` on the packaged Claude tree as the agent runs it, through every rules part.
function next(proj: string): Record<string, unknown> {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_DISABLE_ENSEMBLE_EVIDENCE: "1" };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const tool = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-orchestrate.ts");
  let args = ["next"];
  for (let part = 0; part < 20; part++) {
    const res = spawnSync(process.execPath, [tool, ...args, "--project-dir", proj], {
      encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    const directive = JSON.parse((res.stdout ?? "").trim()) as Record<string, unknown>;
    if (directive.kind !== "load-steering") return directive;
    args = ["continue", String(directive.receipt)];
  }
  throw new Error("the rules parts did not end");
}

afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

describe("reverseEngineeringScopeNarration", () => {
  test("says nothing for a work that records one repository or none", () => {
    expect(reverseEngineeringScopeNarration(workspace(1).proj)).toBeNull();
    expect(reverseEngineeringScopeNarration(workspace(0).proj)).toBeNull();
  });

  test("names the repository count for a scope larger than one", () => {
    const line = reverseEngineeringScopeNarration(workspace(3).proj);
    expect(line).toBe("Reverse Engineering reads 3 repositories here.");
  });

  test("counts the repositories the work records, not the folders on disk", () => {
    expect(reverseEngineeringScopeNarration(workspace(2, 5).proj)).toBe("Reverse Engineering reads 2 repositories here.");
  });

  test("explains the time and token cost at the large-scope threshold", () => {
    const line = reverseEngineeringScopeNarration(workspace(RE_LARGE_SCOPE_REPOS).proj);
    expect(line).toContain(`reads ${RE_LARGE_SCOPE_REPOS} repositories`);
    expect(line).toContain("may take significant time and consume many tokens");
    expect(line).toContain("all 10 are analysed");
    expect(line).not.toContain("limit");
  });
});

describe("the line on Reverse Engineering's steps", () => {
  test("follows the stage's progress line as the analysis starts", () => {
    const step = next(workspace(3).proj);
    expect(step.kind, JSON.stringify(step).slice(0, 400)).toBe("run-stage");
    expect(String(step.narration)).toMatch(/^Bringing in the developer to work on Reverse Engineering \(stage \d+ of \d+\)\. /);
    expect(String(step.narration)).toEndWith("Reverse Engineering reads 3 repositories here.");
  });

  test("is not said when the gate is shown again", () => {
    const { proj, repos } = workspace(3, 3, "?");
    for (const repo of repos) {
      const store = join(proj, "aidlc", "spaces", "default", "codekb", repo);
      mkdirSync(store, { recursive: true });
      for (const name of ARTIFACTS) writeFileSync(join(store, `${name}.md`), `# ${name}\n`);
    }
    const gate = next(proj);
    expect(gate.gate_only, JSON.stringify(gate).slice(0, 400)).toBe(true);
    expect(String(gate.narration)).toStartWith("Reverse Engineering is ready for your review.");
    expect(String(gate.narration)).not.toContain("repositories here");
  });
});
