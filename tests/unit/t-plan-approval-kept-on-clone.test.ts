// covers: function:planApprovalPromptSha256, function:evaluateCodeGenerationApproval, function:publishPlanApprovalAsk
//
// A code plan approved on one checkout, then carried on in a git clone of it (a teammate's clone, the same
// person's second laptop). The receipt the approval wrote lives in the checkout's git-ignored runtime folder, so
// the clone never has it; what reaches the clone is the committed record: the questions file and the
// PLAN_APPROVAL_RECORDED row. The clone asked the plan question again and its questions file lost the answer
// ("[Answer]:" blank). Now the committed approval for this plan, target and stage attempt stands in for the
// receipt on a checkout that has none, under every Guard Policy: the clone asks nothing, keeps the answer, and
// the build starts. A plan changed on the clone, a redo (a new attempt) and a clone the approval row never reached
// still ask, and a clone whose files Git checked out with CRLF keeps the approval.
//
// Real git clones of a project carrying the .gitignore AI-DLC ships; the real `next`, human-turn hook, answer
// command, jump tool and plan-approval guard.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, runOrchestrateNext, seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  readAuditShardEvents, readIssuedDirectiveMarker, stateDigest, writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(180_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const ALICE = "01995000-7a11-7000-8000-00000000a11c";
const BOB = "01995000-7a11-7000-8000-000000000b0b";
const PIECE = "fixture-8000000000000001";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

type Step = Record<string, unknown> & { kind?: string; ask_type?: string; plan_approval?: Record<string, unknown> };

const engineEnv = (proj: string, chat: string) => ({
  ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", AIDLC_SESSION_OVERRIDE: chat,
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", [
    "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "init.defaultBranch=main",
    "-c", "maintenance.auto=false", "-c", "gc.auto=0", ...args,
  ], { cwd, encoding: "utf-8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  expect(result.status, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result.stdout ?? "";
}

/** Alice's checkout at Code Generation, committed with the .gitignore AI-DLC ships. */
function alicesCheckout(policy: "strict" | "relaxed" | "off", locked = false): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)",
      `- **Guard Policy**: ${policy} (from scope poc)\n- **Plan Approval**: on (set by you)`)
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  if (locked) {
    const memory = join(proj, "aidlc", "spaces", "default", "memory", "project.md");
    const content = readFileSync(memory, "utf-8");
    writeFileSync(memory, `${content.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`);
  }
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  writeFileSync(join(proj, ".gitignore"), readFileSync(join(AIDLC_SRC, "..", ".gitignore"), "utf-8"));
  git(proj, ["init", "-q"]);
  git(proj, ["add", "-A"]);
  git(proj, ["commit", "-qm", "work at code generation"]);
  return proj;
}

const stageDir = (proj: string) => join(seededRecordDir(proj), "construction", "code-generation");

function writePlan(proj: string, extra = ""): void {
  mkdirSync(stageDir(proj), { recursive: true });
  writeFileSync(join(stageDir(proj), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n${extra}\n` +
      renderTestingContract(resolveTestingPosture(proj)), "utf-8");
  writeFileSync(join(stageDir(proj), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
}

function next(proj: string, args: string[] = []): Step {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, AIDLC_UNATTENDED: "0" } });
  expect(result.status, result.out).toBe(0);
  return result.directive as Step;
}

function says(proj: string, prompt: string, chat: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj, encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: chat, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

function engine(proj: string, chat: string, tool: string, args: string[]): { code: number; out: string } {
  const result = spawnSync(BUN, [join(AIDLC_SRC, "tools", tool), ...args, "--project-dir", proj], {
    cwd: proj, encoding: "utf-8", env: engineEnv(proj, chat),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Alice approves the plan the engine asks about, in her own words, and commits. */
function approvedByAlice(policy: "strict" | "relaxed" | "off", locked = false): string {
  const alice = alicesCheckout(policy, locked);
  writePlan(alice);
  expect(next(alice)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  says(alice, "looks good, approve it", ALICE);
  const recorded = engine(alice, ALICE, "aidlc-log.ts",
    ["answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan"]);
  expect(recorded.code, recorded.out).toBe(0);
  expect(next(alice).plan_approval).toEqual({ status: "approved" });
  expect(answerLine(alice)).toBe("[Answer]: A. Approve Plan");
  return alice;
}

function commit(proj: string, paths: string[] = ["-A"]): void {
  git(proj, ["add", ...paths]);
  git(proj, ["commit", "-qm", "plan approved"]);
}

/** Bob's own clone of Alice's work; Bob picks it up in a chat of their own ("carry on"). */
function bobsClone(alice: string, crlf = false): string {
  const parent = mkdtempSync(join(tmpdir(), "aidlc-clone-"));
  created.push(parent);
  const bob = join(parent, "bob");
  git(parent, [...(crlf ? ["-c", "core.autocrlf=true"] : []), "clone", "-q", "--no-local", alice, bob]);
  if (crlf) git(bob, ["config", "core.autocrlf", "true"]);
  says(bob, "/aidlc carry on", BOB);
  expect(next(bob)).toMatchObject({ kind: "ask", ask_type: "intent-pick" });
  expect(next(bob, ["--pick", PIECE]).kind).toBe("print");
  const switched = spawnSync(BUN, [DISPATCHER, "engine", "intent", "switch", PIECE], {
    cwd: bob, encoding: "utf-8", env: engineEnv(bob, BOB),
  });
  expect(switched.status, switched.stderr).toBe(0);
  return bob;
}

function answerLine(proj: string): string | undefined {
  const text = readFileSync(join(stageDir(proj), "code-generation-questions.md"), "utf-8");
  return /^\[Answer\]:.*$/m.exec(text.replace(/\r\n/g, "\n"))?.[0];
}

/** The developer handoff the build step names, as the guard sees it from Bob's chat. */
function handoff(proj: string): { code: number; stderr: string } {
  const brief = engine(proj, BOB, "aidlc-testing-posture.ts", ["brief", "--stage-level"]);
  expect(brief.code, brief.out).toBe(0);
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj, encoding: "utf-8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: BOB, cwd: proj, tool_name: "Agent",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt: brief.out },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

/** The status of each Plan Approval receipt this checkout holds. */
function receipts(proj: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "plan-approval");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.startsWith("receipt-"))
    .map((name) => (JSON.parse(readFileSync(join(dir, name), "utf-8")) as { status: string }).status);
}

const QUESTIONS = "aidlc/spaces/default/intents/fixture-8000000000000001/construction/code-generation/code-generation-questions.md";

describe("a code plan approved on one checkout holds on a clone of it", () => {
  for (const [policy, locked] of [["strict", false], ["relaxed", false], ["off", false], ["strict", true]] as const) {
    test(`Guard Policy ${policy}${locked ? " locked in memory" : ""}: the clone asks nothing, keeps the answer, and builds`, () => {
      const alice = approvedByAlice(policy, locked);
      commit(alice);
      const bob = bobsClone(alice);
      expect(readIssuedDirectiveMarker(bob, null)).toBeNull();
      const step = next(bob);
      expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
      expect(answerLine(bob)).toBe("[Answer]: A. Approve Plan");
      expect(git(bob, ["status", "--porcelain", "--", QUESTIONS])).toBe("");
      // The walk never puts the plan question again.
      for (let round = 0; round < 3; round++) expect(next(bob).ask_type).not.toBe("plan-approval");
      expect(receipts(bob)).toEqual([]);
      const handed = handoff(bob);
      expect(handed.code, handed.stderr).toBe(0);
      // The build started from the approval on record: the clone's own receipt, written by generation start.
      expect(receipts(bob)).toEqual(["generation"]);
      expect(next(bob).ask_type).not.toBe("plan-approval");
      expect(answerLine(bob)).toBe("[Answer]: A. Approve Plan");
    });
  }

  test("a clone whose last step here was at an earlier stage keeps the approval", () => {
    const alice = approvedByAlice("strict");
    commit(alice);
    const bob = bobsClone(alice);
    // The step this checkout's engine left at Functional Design, before the approved plan was pulled.
    writeActiveDirectiveMarker(bob, { kind: "run-stage", stage: "functional-design", state_sha256: stateDigest("an earlier state\n") });
    expect(readIssuedDirectiveMarker(bob, null)?.stage).toBe("functional-design");
    expect(next(bob)).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
    expect(answerLine(bob)).toBe("[Answer]: A. Approve Plan");
  });

  test("a clone whose files Git checked out with CRLF keeps the approval", () => {
    const alice = approvedByAlice("strict");
    commit(alice);
    const bob = bobsClone(alice, true);
    expect(readFileSync(join(bob, QUESTIONS), "utf-8")).toContain("\r\n");
    expect(next(bob)).toMatchObject({ kind: "run-stage", plan_approval: { status: "approved" } });
    expect(answerLine(bob)).toBe("[Answer]: A. Approve Plan");
  });
});

describe("what still asks on the clone", () => {
  test("Guard Policy strict: a fresh clone whose plan changed is asked about at its first step", () => {
    const alice = approvedByAlice("strict");
    commit(alice);
    const bob = bobsClone(alice);
    writePlan(bob, "- [ ] Step 2: also trim the title\n");
    // No step was issued on the clone yet: its first `next` reads the step it is about to issue.
    expect(readIssuedDirectiveMarker(bob, null)).toBeNull();
    expect(next(bob)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
    expect(answerLine(bob)).toBe("[Answer]:");
  });

  test("a redo of Code Generation on the clone is a new attempt, and its plan is asked about", () => {
    const alice = approvedByAlice("strict");
    commit(alice);
    const bob = bobsClone(alice);
    says(bob, "/aidlc --stage code-generation", BOB);
    const named = JSON.stringify(next(bob, ["--stage", "code-generation"]));
    const jump = /bun \.claude\/tools\/aidlc-jump\.ts (execute[^`"]*)/.exec(named)?.[1];
    expect(jump, named).toBeDefined();
    const ran = engine(bob, BOB, "aidlc-jump.ts", (jump as string).trim().split(/\s+/));
    expect(ran.code, ran.out).toBe(0);
    expect(next(bob)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });

  test("a clone the approval row never reached is asked", () => {
    const alice = approvedByAlice("strict");
    // Alice commits the plan's folder only; her audit record stays on her machine.
    commit(alice, ["--", join(stageDir(alice))]);
    const bob = bobsClone(alice);
    expect(readAuditShardEvents(bob).some((row) => row.event === "PLAN_APPROVAL_RECORDED")).toBe(false);
    expect(answerLine(bob)).toBe("[Answer]: A. Approve Plan");
    expect(next(bob)).toMatchObject({ kind: "ask", ask_type: "plan-approval" });
  });
});
