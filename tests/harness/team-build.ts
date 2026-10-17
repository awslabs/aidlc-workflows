// Shared fixture for teams building each Unit as work of their own (#2410):
// a home workspace repo at the first Construction step, pushed to a bare
// "host", the checkout example's Units (refunds, checkout-ui, reporting; reporting
// waits on refunds), code repos as bare hosts, and clones for each team.
// Every git call is offline and hermetic.

import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
} from "./fixtures.ts";

export const UNIT = join(AIDLC_SRC, "tools", "aidlc-unit.ts");
export const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
export const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
export const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");

const D = String.fromCharCode(0x2014);
const dirs: string[] = [];
const projects: string[] = [];

/** Remove every workspace, clone and host a case made; register as afterEach. */
export function cleanupTeamBuild(): void {
  while (projects.length > 0) cleanupTestProject(projects.pop()!);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
}

// Offline and without background maintenance (git 2.47+ repacks after writes,
// which races back-to-back commands in small repos).
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};

export function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", env: GIT_ENV });
  if ((result.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr}`);
  return (result.stdout ?? "").trim();
}

export function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `aidlc-team-${label}-`)));
  dirs.push(dir);
  return dir;
}

export const DEPENDENCIES = `# Unit dependencies

\`\`\`yaml
units:
  - name: refunds
    kind: service
    repos: [checkout-api, billing]
    depends_on: []
  - name: checkout-ui
    kind: ui
    repos: [checkout-web]
    depends_on: []
  - name: reporting
    kind: service
    repos: [billing]
    depends_on: [refunds]
\`\`\`
`;

/** The home's state as Inception ends: Construction entered, nothing built, nobody asked who builds. */
export function homeState(extraRuntime: string[] = []): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: checkout revamp
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8

## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Checkpoints**: enabled
- **Construction Iteration**: unit-major
- **Construction Execution**: serial
${extraRuntime.join("\n")}

## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] requirements-analysis ${D} EXECUTE
- [x] units-generation ${D} EXECUTE
- [x] delivery-planning ${D} EXECUTE

### CONSTRUCTION PHASE
- [-] functional-design ${D} EXECUTE
- [ ] nfr-requirements ${D} EXECUTE
- [ ] nfr-design ${D} EXECUTE
- [ ] infrastructure-design ${D} EXECUTE
- [ ] code-generation ${D} EXECUTE
- [ ] build-and-test ${D} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`;
}

export interface Home {
  /** The lead's clone: the home workspace. */
  dir: string;
  /** The bare host the workspace is pushed to. */
  remote: string;
}

/** The home workspace, committed and pushed to its own bare host. */
export function makeHome(options: { state?: string; dependencies?: string } = {}): Home {
  const dir = createTestProject();
  projects.push(dir);
  seedAidlcMemory(dir);
  writeFileSync(seededStateFile(dir), options.state ?? homeState());
  const units = join(seededRecordDir(dir), "inception", "units-generation");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "unit-of-work-dependency.md"), options.dependencies ?? DEPENDENCIES);
  writeFileSync(join(units, "unit-of-work.md"), "# Units of work\n\nrefunds, checkout-ui, reporting.\n");
  const requirements = join(seededRecordDir(dir), "inception", "requirements-analysis");
  mkdirSync(requirements, { recursive: true });
  writeFileSync(join(requirements, "requirements.md"), "# Requirements\n\nFR1 refunds.\n");
  writeFileSync(
    join(dir, ".gitignore"),
    "aidlc/.aidlc-clone-id\naidlc/.aidlc-sessions/\naidlc/active-space\naidlc/spaces/*/intents/active-intent\n" +
      "aidlc/.aidlc-unit-scope.json\naidlc/.aidlc-claim-generations.json\naidlc/.aidlc-claim-registry.json\n" +
      "**/aidlc/spaces/*/intents/**/.aidlc-engine/\n",
  );
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.name", "lead"]);
  git(dir, ["config", "user.email", "lead@example.test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "inception"]);
  const remote = tempDir("home-host");
  git(remote, ["init", "-q", "--bare", "-b", "main"]);
  git(dir, ["remote", "add", "origin", remote]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  return { dir, remote };
}

/** A teammate's clone of a workspace host. */
export function cloneOf(remote: string, label: string): string {
  const parent = tempDir(`clone-${label}`);
  const dir = join(parent, "workspace");
  git(parent, ["clone", "-q", remote, dir]);
  git(dir, ["config", "user.name", label]);
  git(dir, ["config", "user.email", `${label}@example.test`]);
  return dir;
}

export const ENV: NodeJS.ProcessEnv = {
  ...GIT_ENV,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};

export interface RunResult {
  status: number;
  out: string;
  stdout: string;
  json: Record<string, unknown> | null;
}

export function run(tool: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = ENV): RunResult {
  const result = spawnSync(process.execPath, [tool, ...args, "--project-dir", cwd], { cwd, encoding: "utf-8", env });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse((result.stdout ?? "").trim().split("\n").at(-1) ?? "") as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, stdout: result.stdout ?? "", json };
}

/** `next`, with rules delivered in parts taken as the agent takes them. */
export function next(cwd: string, env: NodeJS.ProcessEnv = ENV): Record<string, unknown> {
  let result = run(ORCH, ["next"], cwd, env);
  for (let parts = 0; parts < 50; parts++) {
    expect(result.status, result.out).toBe(0);
    const directive = JSON.parse(result.stdout) as Record<string, unknown>;
    if (directive.kind !== "load-steering" || typeof directive.receipt !== "string") return directive;
    result = run(ORCH, ["continue", directive.receipt], cwd, env);
  }
  throw new Error("rules never finished arriving");
}

export function claimPayload(remote: string, intentId8: string, unit: string): Record<string, unknown> | null {
  const ref = `refs/heads/claim/${intentId8}/${unit}`;
  const tip = spawnSync("git", ["rev-parse", "--verify", ref], { cwd: remote, encoding: "utf-8", env: GIT_ENV });
  if (tip.status !== 0) return null;
  return JSON.parse(git(remote, ["show", `${tip.stdout.trim()}:.aidlc-unit-claim.json`])) as Record<string, unknown>;
}

export function stateOf(dir: string): string {
  return readFileSync(seededStateFile(dir), "utf-8");
}
