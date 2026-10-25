// covers: subcommand:aidlc-jump:execute, audit:STAGE_JUMPED
//
// t-jump-one-step: a stage or phase jump the person asks for over running work
// is made by that `next`, which hands back the step it lands on, so the agent
// makes one engine call where it made three (a print naming the jump, the jump,
// then `next`). The jump's own line rides that step. Where the plan-approval
// guard judges the jump at its own door (Code Generation is the step on record)
// and on a read-only probe, `next` still names the jump command and changes
// nothing.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAuditFile,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

const TOOL = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const CONSTRUCTION = join(FIXTURES_DIR, "state-construction.md");
const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");
// A state file's stage rows separate the slug from its action with an em dash.
const ROW = (mark: string, slug: string): string => `- [${mark}] ${slug} \u2014 EXECUTE`;
const JUMP_PRINT = /^Run `[^`]*aidlc-jump\.ts execute --target ([a-z-]+) --direction ([a-z]+) [^`]*` to perform the jump/;

let proj = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

// The host session's own markers stay out: this is a project with no chat.
function cleanEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(CLAUDE|AIDLC_|CODEX|KIRO|COPILOT)/.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

// The one call the agent makes: `next <args>`, as it prints it.
function nextOnce(args: string[], extra: Record<string, string> = {}): Record<string, unknown> {
  const res = spawnSync(process.execPath, [TOOL, "next", "--project-dir", proj, ...args], {
    cwd: proj,
    encoding: "utf-8",
    env: cleanEnv(extra),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS, { phase: "jump next" }),
  });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout.trim()) as Record<string, unknown>;
}

// That call followed through its rules parts, as the agent's `continue` calls do.
function nextToStep(args: string[]): Record<string, unknown> {
  const res = runOrchestrateNext(TOOL, proj, args, { cwd: proj, env: cleanEnv() });
  expect(res.status, res.out).toBe(0);
  return res.directive as Record<string, unknown>;
}

const state = (): string => readFileSync(seededStateFile(proj), "utf-8");
const field = (content: string, name: string): string =>
  new RegExp(`^- \\*\\*${name}\\*\\*:[ \\t]*(.*)$`, "m").exec(content)?.[1]?.trim() ?? "";
const events = (name: string) => readAuditShardEvents(proj).filter((row) => row.event === name);
const notices = (directive: Record<string, unknown>): string[] =>
  Array.isArray(directive.change_notices) ? (directive.change_notices as string[]) : [];

// The t25 seed with Code Generation as the step in hand.
function seedAtCodeGeneration(): void {
  seedStateFile(proj, CONSTRUCTION);
  let at = state();
  for (const slug of ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design"]) {
    at = at.replace(ROW(slug === "functional-design" ? "-" : " ", slug), ROW("x", slug));
  }
  at = at
    .replace(ROW(" ", "code-generation"), ROW("-", "code-generation"))
    .replace("- **Current Stage**: functional-design", "- **Current Stage**: code-generation")
    .replace("- **In Progress**: functional-design", "- **In Progress**: code-generation");
  expect(field(at, "Current Stage")).toBe("code-generation");
  writeFileSync(seededStateFile(proj), at);
}

describe("t-jump-one-step: the jump is made by the `next` the person's request reaches", () => {
  test("a phase jump back from Construction returns Intent Capture's step in the same call", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, CONSTRUCTION);
    seedAuditFile(proj);
    const first = nextOnce(["--phase", "ideation"]);
    expect(String(first.message ?? ""), JSON.stringify(first)).not.toMatch(JUMP_PRINT);
    expect(["load-steering", "run-stage"]).toContain(String(first.kind));
    expect(first.stage).toBe("intent-capture");
    // That one call made the jump: the state and the record moved with it.
    expect(field(state(), "Current Stage")).toBe("intent-capture");
    expect(field(state(), "Lifecycle Phase")).toBe("IDEATION");
    const jumped = events("STAGE_JUMPED");
    expect(jumped).toHaveLength(1);
    expect(jumped[0].block).toContain("**Direction**: BACKWARD");
    expect(jumped[0].block).toContain("**Target**: intent-capture");
  });

  test("the step it lands on carries the jump's own line, once", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, CONSTRUCTION);
    const step = nextToStep(["--phase", "ideation"]);
    expect(step.kind).toBe("run-stage");
    expect(step.stage).toBe("intent-capture");
    const line = "Moved back to Intent Capture & Framing. You can return to Functional Design any time.";
    expect(notices(step).filter((notice) => notice === line)).toHaveLength(1);
  });

  test("in a chat, the backward line rides the step's lines for the person, said once", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, CONSTRUCTION);
    const chat = { AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-0000000000a5", AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };
    // This chat's hooks are running.
    const health = join(seededRecordDir(proj), ".aidlc-engine", "hooks-health");
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "pre-tool-use.last"), new Date().toISOString());
    const res = runOrchestrateNext(TOOL, proj, ["--phase", "ideation"], { cwd: proj, env: cleanEnv(chat) });
    const step = res.directive as Record<string, unknown>;
    expect(step.kind, res.out).toBe("run-stage");
    expect(step.stage).toBe("intent-capture");
    const line = "Moved back to Intent Capture & Framing. You can return to Functional Design any time.";
    expect(notices(step).filter((notice) => notice === line)).toHaveLength(1);
    expect(String(step.narration ?? "")).not.toContain(line);
  });

  test("a forward stage jump returns that stage's step with the line naming what it skipped", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, MID_IDEATION);
    const step = nextToStep(["--stage", "requirements-analysis"]);
    expect(step.kind).toBe("run-stage");
    expect(step.stage).toBe("requirements-analysis");
    expect(field(state(), "Current Stage")).toBe("requirements-analysis");
    const moved = notices(step).filter((notice) => notice.startsWith("Moved to Requirements Analysis; skipped "));
    expect(moved, JSON.stringify(notices(step))).toHaveLength(1);
    expect(moved[0]).toEndWith("You can go back to Feasibility & Constraints any time.");
    expect(events("STAGE_JUMPED")).toHaveLength(1);
    expect(events("STAGE_SKIPPED").length).toBeGreaterThan(0);
  });
});

describe("t-jump-one-step: where `next` still names the jump and changes nothing", () => {
  test("with Code Generation as the step, the guard's door stays: the print, the state untouched", () => {
    proj = createOrchestrationTestProject();
    seedAtCodeGeneration();
    const before = state();
    const print = nextOnce(["--stage", "requirements-analysis"]);
    expect(print.kind).toBe("print");
    expect(JUMP_PRINT.exec(String(print.message))?.slice(1)).toEqual(["requirements-analysis", "backward"]);
    expect(state()).toBe(before);
    expect(events("STAGE_JUMPED")).toHaveLength(0);
  });

  test("a route-check probe names the jump and writes nothing", () => {
    proj = createOrchestrationTestProject();
    seedStateFile(proj, CONSTRUCTION);
    const before = state();
    const print = nextOnce(["--phase", "ideation"], { AIDLC_ROUTE_CHECK: "1" });
    expect(print.kind).toBe("print");
    expect(JUMP_PRINT.exec(String(print.message))?.slice(1)).toEqual(["intent-capture", "backward"]);
    expect(state()).toBe(before);
    expect(events("STAGE_JUMPED")).toHaveLength(0);
  });
});
