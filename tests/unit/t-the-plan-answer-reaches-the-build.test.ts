// covers: hook:aidlc-record-human-turn, function:answerPlanApproval, hook:aidlc-plan-approval-guard
//
// The person can always answer the engine's code plan question, and the build
// starts from their answer. Six ways they answer, each driven end to end over
// the real hook, the real engine, the real answer command and the real
// plan-approval guard: plain words, a lone number, a sentence, a change request
// then an approval, and a setting typed while the question is open (the check
// itself turned off, or another setting changed and then an approval).
//
// The gate this file exists for: the prompt hook reads no plain words and no
// typed switch, and the `Reply: command` mark is structural. If any of these
// six left the question unanswerable, or left the guard refusing the build
// after an answer, the person would be stuck at a gate with nothing to type.
// Each case ends with the answer on record (or the check recorded off, set by
// them), the developer dispatch and a source write admitted, and the question
// not asked again.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { getField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  evaluateCodeGenerationApproval,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const GUARD = join(AIDLC_SRC, "hooks", "aidlc-plan-approval-guard.ts");
const SESSION = "01995000-7a11-7000-8000-0000000000e1";
/** Production guards, as a person's run has them: no presence bypass, plan approval live. */
const CLEAR = {
  AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "0",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
};

interface Emitted {
  kind: string;
  ask_type?: string;
  stage?: string;
  message?: string;
  plan_approval?: { status?: string; feedback?: string };
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

/** A poc workflow at Code Generation with plan approval on, in this machine's chat. */
function project(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace(
      "- **Change Control**: strict (from scope feature)",
      "- **Guard Policy**: strict (from scope poc)\n- **Plan Approval**: on (set by you)",
    )
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  const sessions = join(proj, "aidlc", ".aidlc-sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, ".current-session"), `${SESSION}\n`, "utf-8");
  return proj;
}

function stageDir(proj: string): string {
  return join(seededRecordDir(proj), "construction", "code-generation");
}

function writePlan(proj: string, extraStep = ""): void {
  mkdirSync(stageDir(proj), { recursive: true });
  writeFileSync(
    join(stageDir(proj), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n" + extraStep + "\n" +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(join(stageDir(proj), "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test`.\n", "utf-8");
}

function next(proj: string, args: string[] = []): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, ...CLEAR } });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

function askFor(proj: string): void {
  writePlan(proj);
  const step = next(proj);
  expect(step.kind, JSON.stringify(step)).toBe("ask");
  expect(step.ask_type).toBe("plan-approval");
}

function reply(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

/** The agent records the choice it read in their words. */
function answer(proj: string, details: string, extra: string[] = []): { code: number; message: string } {
  const result = spawnSync(BUN, [
    LOG, "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--details", details, ...extra, "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, message: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function configSet(proj: string, args: string[]): { code: number; out: string } {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", ...args, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function guardWrite(proj: string, path: string): { code: number; stderr: string } {
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Write",
      tool_input: { file_path: path, content: "export const slug = (s: string) => s;\n" },
    }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

function guardDispatch(proj: string): { code: number; stderr: string } {
  // The developer handoff is the engine's own brief, handed over verbatim, which
  // is what its refusal asks for: the marker lines alone are refused.
  const approval = evaluateCodeGenerationApproval(proj, { unit: null });
  expect(approval.ok, approval.reason).toBe(true);
  const brief = spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-testing-posture.ts"), "brief", "--stage-level", "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(brief.status, brief.stderr).toBe(0);
  const result = spawnSync(BUN, [GUARD], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: SESSION,
      cwd: proj,
      tool_name: "Agent",
      tool_input: { subagent_type: "aidlc-developer-agent", prompt: brief.stdout },
    }),
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

const rows = (proj: string, event: string): number =>
  readAuditShardEvents(proj).filter((row) => row.event === event).length;

function theBuildStarts(proj: string, note: string): void {
  const build = next(proj);
  expect(build.kind, `${note}: ${JSON.stringify(build)}`).toBe("run-stage");
  expect(build.ask_type, note).toBeUndefined();
  const dispatch = guardDispatch(proj);
  expect(dispatch.code, `${note}: dispatch refused: ${dispatch.stderr}`).toBe(0);
  const write = guardWrite(proj, join(proj, "src", "slugify.ts"));
  expect(write.code, `${note}: source write refused: ${write.stderr}`).toBe(0);
  const after = next(proj);
  expect(after.ask_type, `${note}: asked again: ${JSON.stringify(after)}`).not.toBe("plan-approval");
}

describe("the person's answer to the code plan question always lands, and the build starts", () => {
  test.each([
    ["plain words", "approve"],
    ["a lone number", "1"],
    ["a sentence", "looks good, go ahead"],
  ])("%s: the answer is recorded and the build starts", (note, words) => {
    const proj = project();
    askFor(proj);
    reply(proj, words);
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, `${note}: ${recorded.message}`).toBe(0);
    expect(rows(proj, "PLAN_APPROVAL_RECORDED"), note).toBeGreaterThan(0);
    theBuildStarts(proj, note);
  });

  test("a change request, then an approval: the revision runs, then the build", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "Request changes: add a test for empty names");
    const changes = answer(proj, "Request Changes");
    expect(changes.code, changes.message).toBe(0);
    const revise = next(proj);
    expect(revise.kind, JSON.stringify(revise)).toBe("run-stage");
    expect(revise.plan_approval?.status).toBe("revise");
    writePlan(proj, "- [ ] Step 2: a unit test for an empty name\n");
    const asked = next(proj);
    expect(asked.ask_type, JSON.stringify(asked)).toBe("plan-approval");
    reply(proj, "approve");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    theBuildStarts(proj, "after a change request");
  });

  test("plan approval typed off while the question is open: the check goes off, set by them, and the build starts", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "/aidlc --plan-approval off");
    // The hook applies nothing; the agent runs the setter the engine names.
    expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Plan Approval")).toBe("on (set by you)");
    const lowered = configSet(proj, ["plan-approval", "off"]);
    expect(lowered.code, lowered.out).toBe(0);
    expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Plan Approval")).toBe("off (set by you)");
    theBuildStarts(proj, "plan approval typed off at the question");
  });

  test("another setting typed while the question is open, then an approval: both land", () => {
    const proj = project();
    askFor(proj);
    reply(proj, "/aidlc --guard-policy relaxed");
    const lowered = configSet(proj, ["guard-policy", "relaxed"]);
    expect(lowered.code, lowered.out).toBe(0);
    expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Guard Policy")).toBe("relaxed (set by you)");
    const stillAsking = next(proj);
    expect(stillAsking.ask_type, JSON.stringify(stillAsking)).toBe("plan-approval");
    reply(proj, "approve");
    const recorded = answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    theBuildStarts(proj, "a setting typed at the question, then an approval");
  });
});
