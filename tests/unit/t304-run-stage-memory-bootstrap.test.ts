// covers: function:bootstrapDirectiveMemory, subcommand:aidlc-orchestrate:next
//
// Run-stage diary creation belongs to the deterministic engine emission
// boundary. These tests spawn the real CLI for creation/idempotency and call
// the exported guard directly for the ctx-less builder shape.

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

function installedProject(): string {
  const project = createOrchestrationTestProject();
  projects.push(project);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-inception.md"));
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

function emitRunStage(project: string): Record<string, unknown> {
  const result = runOrchestrateNext(ORCHESTRATE, project);
  expect(
    result.status,
    `orchestrate failed:\n${result.stdout}\n${result.stderr}`,
  ).toBe(0);
  expect(result.directive?.kind).toBe("run-stage");
  return result.directive ?? {};
}

describe("t304 run-stage memory bootstrap", () => {
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
