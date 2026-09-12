// covers: function:bootstrapDirectiveMemory, subcommand:aidlc-orchestrate:next
//
// Run-stage diary creation belongs to the deterministic engine emission
// boundary when learnings is on. These tests spawn the real CLI for ceremony
// changes and creation/idempotency, and call the ctx-less guard directly.

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { bootstrapDirectiveMemory } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seedStateFile,
} from "../harness/fixtures.ts";

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const TEMPLATE = join(
  AIDLC_SRC,
  "knowledge",
  "aidlc-shared",
  "memory-template.md",
);
const projects: string[] = [];

afterEach(() => {
  for (const project of projects.splice(0)) cleanupTestProject(project);
});

function installedProject(seedFixture = true): string {
  const project = createOrchestrationTestProject();
  projects.push(project);
  if (seedFixture) seedStateFile(project, join(FIXTURES_DIR, "state-mid-inception.md"));
  const installedTemplate = join(
    project,
    ".claude",
    "knowledge",
    "aidlc-shared",
    "memory-template.md",
  );
  mkdirSync(dirname(installedTemplate), { recursive: true });
  copyFileSync(TEMPLATE, installedTemplate);
  return project;
}

function emitRunStage(project: string, env?: Record<string, string | undefined>): Record<string, unknown> {
  const result = runOrchestrateNext(ORCHESTRATE, project, [], { env });
  expect(
    result.status,
    `orchestrate failed:\n${result.stdout}\n${result.stderr}`,
  ).toBe(0);
  expect(result.directive?.kind).toBe("run-stage");
  return result.directive ?? {};
}

describe("t316 run-stage memory bootstrap", () => {
  test("directive emission creates memory.md with the exact template bytes", () => {
    const project = installedProject();
    const directive = emitRunStage(project);
    const memoryPath = directive.memory_path;
    expect(typeof memoryPath).toBe("string");
    const memory = join(project, memoryPath as string);
    expect(existsSync(memory)).toBe(true);
    expect(readFileSync(memory)).toEqual(readFileSync(TEMPLATE));
  });

  test("re-emission preserves an existing diary instead of overwriting it", () => {
    const project = installedProject();
    const first = emitRunStage(project);
    const memory = join(project, first.memory_path as string);
    const observation =
      "- 2026-08-20T12:00:00Z - preserved observation across re-emission\n";
    appendFileSync(memory, observation);
    const expected = readFileSync(memory);

    const second = emitRunStage(project);
    expect(second.memory_path).toBe(first.memory_path);
    expect(readFileSync(memory)).toEqual(expected);
  });

  test("classic creates no diary until learnings is enabled", () => {
    const project = installedProject(false);
    const env = {
      ...process.env,
      AIDLC_DISABLE_SENSORS: "0",
      AIDLC_DISABLE_LEARNINGS: "0",
      AIDLC_DISABLE_SUMMARY_CONFIRMATION: "0",
    };
    const created = Bun.spawnSync({
      cmd: [process.execPath, UTILITY, "intent-create", "--scope", "classic",
        "--arguments", "diary ceremony fixture", "--label", "diary", "--project-dir", project],
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(created.exitCode, created.stderr.toString()).toBe(0);

    const first = emitRunStage(project, env);
    expect(typeof first.memory_path).toBe("string");
    expect(first.ceremony).toMatchObject({ learnings: "off" });
    const memory = join(project, first.memory_path as string);
    expect(existsSync(memory)).toBe(false);

    const enabled = Bun.spawnSync({
      cmd: [process.execPath, UTILITY, "config-change", "--learnings", "on", "--project-dir", project],
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(enabled.exitCode, enabled.stderr.toString()).toBe(0);
    const second = emitRunStage(project, env);
    expect(second.ceremony).toMatchObject({ learnings: "on" });
    expect(second.memory_path).toBe(first.memory_path);
    expect(existsSync(memory)).toBe(true);
  });

  test("the Stop hook's internal next probe remains write-free", () => {
    const project = installedProject();
    const result = runOrchestrateNext(ORCHESTRATE, project, [], {
      env: { ...process.env, AIDLC_STOP_HOOK_PROBE: "1" },
    });
    expect(result.status).toBe(0);
    expect(result.directive?.kind).toBe("run-stage");
    const memoryPath = result.directive?.memory_path;
    expect(typeof memoryPath).toBe("string");
    expect(existsSync(join(project, memoryPath as string))).toBe(false);
  });

  test("ctx-less and unresolved isolated builds create nothing", () => {
    const project = installedProject();
    const ctxLess = "isolated/ctx-less/memory.md";
    bootstrapDirectiveMemory(ctxLess);
    expect(existsSync(join(project, ctxLess))).toBe(false);

    const unresolved = "isolated/{unit-name}/memory.md";
    bootstrapDirectiveMemory(unresolved, { projectDir: project });
    expect(existsSync(join(project, "isolated"))).toBe(false);
  });
});
