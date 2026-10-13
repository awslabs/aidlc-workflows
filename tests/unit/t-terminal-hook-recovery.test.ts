// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:continue
import { afterEach, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR,
  seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { env, say } from "../harness/aidlc-input-corpus.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const projects: string[] = [];
afterEach(() => { for (const project of projects.splice(0)) cleanupTestProject(project); });

function project(): string {
  const root = createOrchestrationTestProject();
  projects.push(root);
  return root;
}
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return [file.slice(dir.length + 1), readFileSync(file).toString("base64")];
    }));
}
function run(root: string, args: string[], ambient = true) {
  return Bun.spawnSync([process.execPath, join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), ...args,
    "--project-dir", root,
    ...(ambient ? ["--hook-space", "default", "--hook-intent", basename(seededRecordDir(root))] : []),
  ], {
    cwd: root, env: env(root),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    stdout: "pipe", stderr: "pipe",
  });
}

for (const status of ["Completed", "Archived"]) {
  test(`${status} automatic recovery leaves the physical record untouched`, () => {
    const root = project();
    writeFileSync(seededStateFile(root), readFileSync(join(FIXTURES_DIR, "state-completed.md"), "utf-8")
      .replace("**Status**: Completed", `**Status**: ${status}`));
    const before = snapshot(seededRecordDir(root));
    for (const args of [["next"], ["continue", "Ab-_1234"]]) {
      const result = run(root, args);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toBe("");
      expect(snapshot(seededRecordDir(root))).toEqual(before);
    }
    const explicit = run(root, ["next"], false);
    expect(explicit.exitCode, explicit.stderr.toString()).toBe(0);
    expect(JSON.parse(explicit.stdout.toString()).kind).toBeDefined();
  });
}

test("automatic recovery leaves a stored setting request for the person's explicit next", async () => {
  const root = project();
  writeFileSync(seededStateFile(root), readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8"));
  const prompt = await say(root, "/aidlc --plan-approval off", "claude");
  expect(prompt.status, prompt.stdout + prompt.stderr).toBe(0);
  const ambient = run(root, ["next"]);
  expect(ambient.exitCode, ambient.stderr.toString()).toBe(0);
  expect(JSON.parse(ambient.stdout.toString()).kind).not.toBe("print");
  const explicit = run(root, ["next"], false);
  expect(explicit.exitCode, explicit.stderr.toString()).toBe(0);
  expect(JSON.parse(explicit.stdout.toString())).toMatchObject({
    kind: "print",
    message: expect.stringContaining("config set plan-approval off"),
  });
});

test("automatic recovery hands a nested team projection to explicit next without waiting on its own lock", () => {
  const root = project();
  writeFileSync(seededStateFile(root), `# AI-DLC State Tracking

## Project Information
- **Project**: recovery lock boundary
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: team
- **Unit Gate Rhythm**: per-stage

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design — EXECUTE
- [ ] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-08-20T00:00:00Z
`);
  seedBoltDag(root, ["alpha"]);
  const before = readFileSync(seededStateFile(root), "utf-8");
  const ambient = run(root, ["next"]);
  expect(ambient.exitCode, ambient.stderr.toString()).toBe(0);
  expect(JSON.parse(ambient.stdout.toString())).toMatchObject({
    kind: "error",
    message: expect.stringContaining("explicitly to finish this recovery"),
  });
  expect(readFileSync(seededStateFile(root), "utf-8")).toBe(before);
  // Both dispatches can also share a process (the compiled dispatcher does):
  // the ambient mode and pinned target must be restored before ordinary next.
  const common = ["next", "--project-dir", root];
  const explicit = Bun.spawnSync([process.execPath, "-e",
    `const { main } = await import(${JSON.stringify(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"))});
main(${JSON.stringify([...common, "--hook-space", "default", "--hook-intent", basename(seededRecordDir(root))])});
main(${JSON.stringify(common)});`,
  ], {
    cwd: root, env: env(root),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    stdout: "pipe", stderr: "pipe",
  });
  expect(explicit.exitCode, explicit.stderr.toString()).toBe(0);
  const directives = explicit.stdout.toString().trim().split("\n").map((line) => JSON.parse(line));
  expect(directives[0].kind).toBe("error");
  expect(directives[directives.length - 1].kind).not.toBe("error");
  expect(readFileSync(seededStateFile(root), "utf-8")).toContain("## Unit Progress");
});
