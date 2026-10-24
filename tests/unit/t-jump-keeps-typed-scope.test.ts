// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:scope-change, function:jumpAfterChange
//
// On running work the person types the guide's own example,
// `/aidlc --scope enterprise --stage code-generation`, and the skill hands it
// to `next` as typed. The jump used to run in the work's old scope and the
// scope they typed was dropped with no line: the plan stayed bugfix. Now the
// change they typed (a scope, with any settings beside it, or settings alone)
// is named first and the jump they asked for after it, so the jump runs in the
// work as changed. A same-scope `--scope` with nothing else still jumps alone.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  runOrchestrateNext,
  seedAuditFile,
  seedStateFile,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const TOOLS = join(AIDLC_SRC, "tools");
const ORCH = join(TOOLS, "aidlc-orchestrate.ts");
const UTILITY = join(TOOLS, "aidlc-utility.ts");
const JUMP = join(TOOLS, "aidlc-jump.ts");

type Directive = { kind: string; message?: string; stage?: string; narration?: string };

const created: string[] = [];
afterEach(() => {
  for (const proj of created.splice(0)) cleanupTestProject(proj);
});

/** Bugfix work running at Requirements Analysis. */
function runningBugfix(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  seedStateFile(proj, "state-mid-inception.md");
  seedAuditFile(proj);
  return proj;
}

function next(proj: string, args: string[]): Directive {
  const res = runOrchestrateNext(ORCH, proj, args);
  expect(res.directive, res.out).not.toBeNull();
  return res.directive as Directive;
}

function run(tool: string, proj: string, args: string[]): string {
  const res = spawnSync(process.execPath, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    // The human turn is not driven here, so the jump's presence check stands aside.
    env: { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" },
  });
  expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
  return `${res.stdout}${res.stderr}`;
}

const commands = (d: Directive): string[] => [...String(d.message ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const field = (proj: string, name: string): string =>
  new RegExp(`^- \\*\\*${name}\\*\\*: ?(\\S+)`, "m").exec(readFileSync(seededStateFile(proj), "utf-8"))?.[1] ?? "";

/** Runs the change the step names, then the jump `next` it names, as the agent would. */
function followChangeThenJump(proj: string, step: Directive, jumpArgs: string[]): void {
  const [change, jump] = commands(step);
  const scope = /engine scope change (.+)$/.exec(change ?? "");
  expect(scope, step.message).not.toBeNull();
  run(UTILITY, proj, ["scope-change", ...scope![1].split(" ")]);
  expect(jump).toBe(`bun .claude/tools/aidlc-orchestrate.ts next ${jumpArgs.join(" ")}`);
  const after = next(proj, jumpArgs);
  const execute = commands(after).find((c) => c.includes("aidlc-jump.ts execute"));
  if (execute) run(JUMP, proj, execute.replace(/^bun \S+ /, "").split(" "));
}

describe("t-jump-keeps-typed-scope: a scope typed with a jump over running work changes the scope, then jumps", () => {
  for (const args of [
    ["--scope", "enterprise", "--stage", "code-generation"],
    ["--stage", "code-generation", "--scope", "enterprise"],
  ]) {
    test(`next ${args.join(" ")}: the scope change first, then the jump, in the new scope`, () => {
      const proj = runningBugfix();
      const step = next(proj, args);
      expect(step.kind, JSON.stringify(step)).toBe("print");
      const named = commands(step);
      expect(named[0]).toBe("bun .claude/tools/aidlc.ts engine scope change --scope enterprise");
      expect(String(step.message)).not.toContain("aidlc-jump.ts execute");
      // Nothing says where the work picks up before the jump moves it.
      expect(step.narration).toBeUndefined();
      followChangeThenJump(proj, step, ["--stage", "code-generation"]);
      expect(field(proj, "Scope")).toBe("enterprise");
      expect(field(proj, "Current Stage")).toBe("code-generation");
    });
  }

  test("a phase jump with a scope names the scope change, then the phase jump", () => {
    const proj = runningBugfix();
    const step = next(proj, ["--scope", "enterprise", "--phase", "construction"]);
    expect(commands(step)[0]).toBe("bun .claude/tools/aidlc.ts engine scope change --scope enterprise");
    expect(commands(step)[1]).toBe("bun .claude/tools/aidlc-orchestrate.ts next --phase construction");
  });

  test("a setting typed beside the scope rides the scope change, as the guide's --depth example does", () => {
    const proj = runningBugfix();
    const step = next(proj, ["--scope", "enterprise", "--depth", "standard", "--stage", "code-generation"]);
    expect(commands(step)[0]).toBe("bun .claude/tools/aidlc.ts engine scope change --scope enterprise --depth standard");
    expect(commands(step)[1]).toBe("bun .claude/tools/aidlc-orchestrate.ts next --stage code-generation");
  });

  test("a setting typed alone with a jump is set first, then the jump", () => {
    const proj = runningBugfix();
    const step = next(proj, ["--depth", "comprehensive", "--stage", "code-generation"]);
    expect(commands(step)[0]).toBe("bun .claude/tools/aidlc.ts engine config set depth comprehensive");
    expect(commands(step)[1]).toBe("bun .claude/tools/aidlc-orchestrate.ts next --stage code-generation");
  });

  test("the scope the work already has, with nothing else, still jumps alone", () => {
    const proj = runningBugfix();
    const step = next(proj, ["--scope", "bugfix", "--stage", "code-generation"]);
    expect(JSON.stringify(step)).not.toContain("scope change");
    expect(JSON.stringify(step)).not.toContain("config set");
  });
});
