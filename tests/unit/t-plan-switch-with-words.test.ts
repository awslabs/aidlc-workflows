// covers: function:notePlanApprovalAskReply, hook:aidlc-record-human-turn
//
// A Guard Policy switch typed with the person's reply while the engine's code
// plan question is open ("/aidlc --guard-policy off approve the plan"): both
// halves are done. The switch lands on this work, and the words are their
// reply to the question, whether or not they are one of its exact choices, so
// the agent records the choice they made and nothing is asked twice. Words
// after an explicit `--` still describe new work.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, cleanupWorktreeFixture, createOrchestrationTestProject, FIXTURES_DIR,
  runOrchestrateNext, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-000000000001";

/** The directive fields these cases read. */
interface Emitted {
  kind: string;
  ask_type?: string;
  stage?: string;
  question?: string;
  message?: string;
  response_route?: string;
  plan_approval: {
    status?: string;
    feedback?: string;
    note?: string;
    editing?: boolean;
    choices?: string[];
    targets?: Array<{ unit: string | null; plan_path: string; summary: string[] }>;
    units?: Array<{ unit: string; status: string; feedback?: string; note?: string }>;
  };
}

const created: string[] = [];
const worktreeFixtures: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  while (worktreeFixtures.length > 0) cleanupWorktreeFixture(worktreeFixtures.pop()!);
});

function project(policy: "strict" | "relaxed" | "off" = "relaxed", planApproval: "on" | "off" = "on"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  // poc ships with plan approval off; these cases are about the question, so
  // the person turned it on unless a case says otherwise.
  const planApprovalLine = planApproval === "on"
    ? "\n- **Plan Approval**: on (set by you)"
    : "\n- **Plan Approval**: off (from scope poc)";
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)", `- **Guard Policy**: ${policy} (from scope poc)${planApprovalLine}`)
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

function stageDir(proj: string, unit: string | null = null): string {
  return join(seededRecordDir(proj), "construction", ...(unit ? [unit] : []), "code-generation");
}

function writePlan(proj: string, extra = "", unit: string | null = null): void {
  mkdirSync(stageDir(proj, unit), { recursive: true });
  writeFileSync(
    join(stageDir(proj, unit), "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n${extra}\n` +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8",
  );
  writeFileSync(
    join(stageDir(proj, unit), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n",
    "utf-8",
  );
}

function next(proj: string, args: string[] = []): Emitted {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, {
    env: { ...process.env, AIDLC_UNATTENDED: "0" },
  });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Emitted;
}

function reply(proj: string, prompt: string, session = SESSION): string {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ?? "";
}

// What the agent runs after reading the person's reply: the choice they made.
function answer(
  proj: string,
  details: string,
  extra: string[] = [],
): { code: number; recorded?: string; message: string } {
  const result = spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--details", details, ...extra, "--project-dir", proj,
  ], {
    cwd: proj,
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const line = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split("\n").find((entry) => entry.startsWith("{"));
  const parsed = line ? JSON.parse(line) as { recorded?: string; message?: string; error?: string } : {};
  return {
    code: result.status ?? -1,
    ...(parsed.recorded ? { recorded: parsed.recorded } : {}),
    message: parsed.message ?? parsed.error ?? `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

function askFor(proj: string): Emitted {
  writePlan(proj);
  const directive = next(proj);
  expect(directive.kind, JSON.stringify(directive)).toBe("ask");
  expect(directive.ask_type).toBe("plan-approval");
  return directive;
}


function lastTurn(proj: string): string {
  return auditText(proj).split(/\n---\n|\n## /).filter((block) => block.includes("**Event**: HUMAN_TURN")).at(-1) ?? "";
}

function policy(proj: string): string | undefined {
  return readFileSync(seededStateFile(proj), "utf-8").match(/^- \*\*Guard Policy\*\*: (.*)$/m)?.[1];
}

describe("t-plan-switch-with-words: a switch typed with the person's reply to the code plan question", () => {
  for (const [typed, value] of [
    ["/aidlc --guard-policy off approve the plan", "off"],
    ["/aidlc --guard-policy off Approve", "off"],
    ["/aidlc --guard-policy relaxed yes, go ahead", "relaxed"],
    ["$aidlc --guard-policy off looks good, build it", "off"],
  ] as const) {
    test(`"${typed}": the switch lands on this work and the agent records the choice`, () => {
      const proj = project("strict");
      askFor(proj);
      const said = reply(proj, typed);
      expect(policy(proj)).toBe(`${value} (set by you)`);
      expect(said).not.toContain("for the work you are asking for");
      expect(lastTurn(proj)).not.toContain("**Reply**: command");
      // Their words are a reply, so the choice they made is recorded at once.
      const recorded = answer(proj, "Approve Plan");
      expect(recorded.code, recorded.message).toBe(0);
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
    });
  }

  test("a change the person asks for with the switch is their reply too", () => {
    const proj = project("strict");
    askFor(proj);
    reply(proj, "/aidlc --guard-policy relaxed rename slugify to toSlug first");
    expect(policy(proj)).toBe("relaxed (set by you)");
    expect(answer(proj, "Request Changes").message).toContain('Recorded "Request Changes"');
    expect(next(proj).plan_approval).toEqual({ status: "revise", feedback: "rename slugify to toSlug first" });
  });

  // Raising a setting, or turning one on, with the answer: both are done too.
  for (const [start, typed, value] of [
    ["relaxed", "/aidlc --guard-policy strict Approve Plan", "strict (set by you)"],
    ["off", "/aidlc --guard-policy strict approve it", "strict (set by you)"],
  ] as const) {
    test(`"${typed}" on ${start} work: the setting lands on this work and the choice is recorded`, () => {
      const proj = project(start);
      askFor(proj);
      reply(proj, typed);
      expect(policy(proj)).toBe(value);
      expect(lastTurn(proj)).not.toContain("**Reply**: command");
      const recorded = auditText(proj).includes("**Event**: PLAN_APPROVAL_RECORDED") ? { code: 0, message: "" } : answer(proj, "Approve Plan");
      expect(recorded.code, recorded.message).toBe(0);
      expect(next(proj).plan_approval).toEqual({ status: "approved" });
    });
  }

  test("plan approval on, typed with the answer, records the answer", () => {
    const proj = project("relaxed");
    askFor(proj);
    reply(proj, "/aidlc --plan-approval on Approve Plan");
    expect(lastTurn(proj)).not.toContain("**Reply**: command");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("- **Plan Approval**: on (set by you)");
    const recorded = auditText(proj).includes("**Event**: PLAN_APPROVAL_RECORDED") ? { code: 0, message: "" } : answer(proj, "Approve Plan");
    expect(recorded.code, recorded.message).toBe(0);
    expect(next(proj).plan_approval).toEqual({ status: "approved" });
  });

  // With no plan question open, a setting typed with words changes nothing
  // at prompt time, as before: the words go to the work they describe.
  test("with no plan question open, a raise typed with words leaves this work as it is", () => {
    const proj = project("relaxed");
    writePlan(proj);
    expect(reply(proj, "/aidlc --guard-policy strict fix the parser")).not.toContain("Guard Policy changed");
    expect(policy(proj)).toBe("relaxed (from scope poc)");
  });

  test("words after an explicit -- still describe new work, and this work keeps its Guard Policy", () => {
    const proj = project("strict");
    askFor(proj);
    expect(reply(proj, "/aidlc --guard-policy off -- add a CSV export")).toContain(
      "Guard Policy off for the work you are asking for (set by you).",
    );
    expect(policy(proj)).toBe("strict (from scope poc)");
  });
});
