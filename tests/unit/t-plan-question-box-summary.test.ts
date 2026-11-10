// covers: function:planQuestionBoxInput, function:planQuestionBoxAsAsked, function:runGroupMembers
//
// On Claude Code the code plan question's own box shows each plan's summary
// lines and its path, so the person reads what they approve in the box itself
// and not only when the agent repeats it. These cases drive the shipped Claude
// hooks (the guard-tool-call row before the box, the human-turn hook after it)
// over one poc workflow at Code Generation with plan approval on:
//
//   - the agent's box for the open plan question gets the engine's lines under
//     the agent's own question; header, choices and their descriptions stay;
//   - every other box, and every failure, prints nothing and exits 0: no plan
//     question open, the stage gate's box, the plan question beside another
//     question, a multi-select, another harness, a box that already shows the
//     lines, an answered question, a payload or record that cannot be read;
//   - past Claude Code's 2,000 characters of question text only the plan's
//     path is added, and past that nothing;
//   - the answer to the filled box records as on main: the pick, the person's
//     own words, the question the agent asked and its id; Approve builds and
//     is not asked again, Request Changes and "I'll edit the files" go as on
//     main; the one miss (the plan's Summary saved while the box is open) still
//     records the pick.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { planApprovalRuntimeFile } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-000000000002";
const LINES = ["- Builds: slugify for titles", "- Touches: src/slugify.ts", "- Tests: 3 unit tests"];

interface Directive {
  kind: string;
  ask_type?: string;
  question?: string;
  plan_approval?: { status?: string; editing?: boolean };
}

interface Box {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function project(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)",
      "- **Guard Policy**: relaxed (from scope poc)\n- **Plan Approval**: on (set by you)")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  return proj;
}

function planDir(proj: string): string {
  return join(seededRecordDir(proj), "construction", "code-generation");
}

function planPath(proj: string): string {
  return relative(proj, join(planDir(proj), "code-generation-plan.md")).replaceAll("\\", "/");
}

function writePlan(proj: string, builds = "slugify for titles"): void {
  mkdirSync(planDir(proj), { recursive: true });
  writeFileSync(join(planDir(proj), "code-generation-plan.md"),
    `# Code Generation Plan\n\n## Summary\n\n- Builds: ${builds}\n- Touches: src/slugify.ts\n` +
      "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
    "utf-8");
  writeFileSync(join(planDir(proj), "unit-test-instructions.md"),
    "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
}

function next(proj: string): Directive {
  const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: { ...process.env, AIDLC_UNATTENDED: "0" } });
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as unknown as Directive;
}

// The plan written and asked: the engine's question, as `next` hands it over.
function asked(proj: string): string {
  writePlan(proj);
  const ask = next(proj);
  expect(ask.kind, JSON.stringify(ask)).toBe("ask");
  expect(ask.ask_type).toBe("plan-approval");
  return ask.question ?? "";
}

function env(proj: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", ...extra };
}

function planBox(question: string, extra: Partial<Box> = {}): Box {
  return {
    question,
    header: "Code plan",
    multiSelect: false,
    options: [
      { label: "Approve Plan", description: "Build it as planned" },
      { label: "Request Changes", description: "Tell me what to change first" },
      { label: "I'll edit the files", description: "Edit the plan yourself, then tell me" },
    ],
    ...extra,
  };
}

// The guard-tool-call row before Claude Code opens the box.
function beforeBox(proj: string, input: string, extra: Record<string, string | undefined> = {}) {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "guard-tool-call"], {
    cwd: proj, input, env: env(proj, extra), encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function boxPayload(questions: unknown[]): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse", session_id: SESSION, cwd: "", tool_name: "AskUserQuestion",
    tool_input: { questions },
  });
}

// What the row hands Claude Code for the box, or null when it prints nothing.
function filled(proj: string, questions: unknown[]): Box[] | null {
  const result = beforeBox(proj, boxPayload(questions));
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  if (result.stdout.trim() === "") return null;
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: { hookEventName: string; updatedInput: { questions: Box[] }; permissionDecision?: string };
  };
  expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
  return output.hookSpecificOutput.updatedInput.questions;
}

function quiet(proj: string, input: string, extra: Record<string, string | undefined> = {}): void {
  const result = beforeBox(proj, input, extra);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("");
}

// Claude Code's PostToolUse for the box as it was shown: the question, the
// answers key and any annotations key are the shown text.
function answered(proj: string, shown: Box, answer: string, annotations?: Record<string, unknown>): void {
  const questions = [shown];
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({
      hook_event_name: "PostToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
      tool_input: { questions },
      tool_response: { questions, answers: { [shown.question]: answer }, ...(annotations ? { annotations } : {}) },
    }),
    env: env(proj), encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

function typed(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

function logAnswer(proj: string, details: string): { code: number; out: string } {
  const result = spawnSync(BUN, [
    join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
    "--details", details, "--project-dir", proj,
  ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function auditText(proj: string): string {
  const dir = join(seededRecordDir(proj), "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir).filter((name) => name.endsWith(".md"))
    .map((name) => readFileSync(join(dir, name), "utf-8")).join("\n");
}

function rows(proj: string, event: string): string[] {
  return auditText(proj).split(/\n(?=## )/).filter((block) => block.includes(`**Event**: ${event}\n`));
}

function field(block: string, name: string): string | null {
  return new RegExp(`^\\*\\*${name}\\*\\*: (.*)$`, "m").exec(block)?.[1] ?? null;
}

function expectedBox(proj: string, question: string): string {
  return [question, "", ...LINES, "", `Full plan: ${planPath(proj)}`].join("\n");
}

describe("the code plan question's box shows the plan's lines", () => {
  test("the agent's box gets the summary lines and the path under its own question; nothing else changes", () => {
    const proj = project();
    const question = asked(proj);
    const box = planBox(question);
    const shown = filled(proj, [box]);
    expect(shown).not.toBeNull();
    expect(shown?.length).toBe(1);
    expect(shown?.[0].question).toBe(expectedBox(proj, question));
    expect({ ...shown?.[0], question: "" }).toEqual({ ...box, question: "" });
    // The agent's own wording of the question stays first.
    const own = "Do you approve this code plan?";
    expect(filled(proj, [planBox(own)])?.[0].question).toBe(expectedBox(proj, own));
  });

  test("every other box, and every failure, prints nothing and exits 0", () => {
    const proj = project();
    // No plan question open yet.
    writePlan(proj);
    quiet(proj, boxPayload([planBox("Approve the code plan?")]));
    const question = asked(proj);
    // The stage gate's box, the plan question beside another one, a multi-select.
    quiet(proj, boxPayload([{ ...planBox("Code Generation complete. How would you like to proceed?"),
      options: [{ label: "Approve", description: "" }, { label: "Request Changes", description: "" }] }]));
    quiet(proj, boxPayload([planBox(question), {
      question: "Use this command to verify each Unit?", header: "Verify", multiSelect: false,
      options: [{ label: "Approve", description: "" }, { label: "Request Changes", description: "" }],
    }]));
    quiet(proj, boxPayload([planBox(question, { multiSelect: true })]));
    // A box that already shows the lines gets them once.
    quiet(proj, boxPayload([planBox(expectedBox(proj, question))]));
    // Another harness.
    quiet(proj, boxPayload([planBox(question)]), { AIDLC_HARNESS_NAME: "codex" });
    // Payloads the row cannot read.
    quiet(proj, "not json");
    quiet(proj, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }));
    quiet(proj, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [null] } }));
    quiet(proj, JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: question, options: "Approve Plan" }] } }));
    // A question record that cannot be read.
    const dir = dirname(planApprovalRuntimeFile(proj, "probe"));
    for (const name of readdirSync(dir).filter((entry) => entry.startsWith("ask-"))) {
      writeFileSync(join(dir, name), "{ not json", "utf-8");
    }
    quiet(proj, boxPayload([planBox(question)]));
  });

  // Step 3 asks the agent to show the lines, and an agent may put them in its
  // question itself: the box then gets only what it does not show yet.
  test("lines the agent's question already shows are not added again", () => {
    const proj = project();
    const question = asked(proj);
    const own = [question, ...LINES].join("\n");
    expect(filled(proj, [planBox(own)])?.[0].question).toBe(`${own}\n\nFull plan: ${planPath(proj)}`);
    const bare = `${question}\n\n${LINES.slice(0, 2).map((line) => line.slice(2)).join("\n")}`;
    expect(filled(proj, [planBox(bare)])?.[0].question)
      .toBe(`${bare}\n\n${LINES[2]}\n\nFull plan: ${planPath(proj)}`);
    quiet(proj, boxPayload([planBox(`${own}\nFull plan: ${planPath(proj)}`)]));
    // The path shown anywhere in the question, as an agent wrote it after an update.
    const withPath = `${question} (${planPath(proj)})`;
    expect(filled(proj, [planBox(withPath)])?.[0].question).toBe([withPath, "", ...LINES].join("\n"));
    quiet(proj, boxPayload([planBox([withPath, ...LINES].join("\n"))]));
  });

  test("past 2,000 characters only the plan's path is added, and past that nothing", () => {
    const proj = project();
    asked(proj);
    const long = `${"Please read the whole plan before you answer. ".repeat(40)}Approve the code plan?`;
    expect(long.length).toBeGreaterThan(1800);
    expect(filled(proj, [planBox(long)])?.[0].question).toBe(`${long}\n\nFull plan: ${planPath(proj)}`);
    quiet(proj, boxPayload([planBox(`${"x".repeat(1990)} Approve?`)]));
  });

  test("an answered question's box gets nothing", () => {
    const proj = project();
    const question = asked(proj);
    const shown = filled(proj, [planBox(question)]);
    answered(proj, shown![0], "Approve Plan");
    quiet(proj, boxPayload([planBox(question)]));
  });
});

// What the record says from the plan question on, in the fields a person or
// a reader meets, with ids and times left out (only whether a Question Id is
// there): the same steps through the filled box and the plain one must say
// the same.
const RECORD_FIELDS = ["Question", "Reply", "Person Reply", "Details", "Options", "Picked", "Source"];
function recordFrom(proj: string): string[] {
  const blocks = auditText(proj).split(/\n(?=## )/);
  const from = blocks.findIndex((block) => block.includes("**Question Type**: plan-approval"));
  return blocks.slice(Math.max(from, 0)).map((block) => [
    field(block, "Event"),
    ...RECORD_FIELDS.map((name) => `${name}=${field(block, name) ?? ""}`),
    `id=${field(block, "Question Id") === null ? "no" : "yes"}`,
  ].join(" | "));
}

// The same steps on two projects: through the box as the row fills it, and
// through the box as the agent wrote it (what main records).
function twins(steps: (proj: string, box: (question: string) => Box) => void): { filledRecord: string[]; plainRecord: string[] } {
  const filledProj = project();
  steps(filledProj, (question) => filled(filledProj, [planBox(question)])![0]);
  const plainProj = project();
  steps(plainProj, (question) => planBox(question));
  return { filledRecord: recordFrom(filledProj), plainRecord: recordFrom(plainProj) };
}

describe("the answer to the filled box records as on main", () => {
  test("Approve Plan: recorded once, as on main; the build runs and is not asked again", () => {
    const { filledRecord, plainRecord } = twins((proj, box) => {
      const question = asked(proj);
      const shown = box(question);
      answered(proj, shown, "Approve Plan", { [shown.question]: { notes: "looks right" } });
      const approvals = rows(proj, "PLAN_APPROVAL_RECORDED");
      expect(approvals.length).toBe(1);
      expect(field(approvals[0], "Person Reply")).toBe("Approve Plan");
      expect(field(rows(proj, "QUESTION_REPLIED")[0], "Question")).toBe(question);
      expect(auditText(proj)).not.toContain("Full plan:");
      const again = logAnswer(proj, "Approve Plan");
      expect(again.code, again.out).toBe(0);
      expect(again.out).toContain("is already recorded");
      const build = next(proj);
      expect(build.kind, JSON.stringify(build)).toBe("run-stage");
      expect(build.plan_approval).toEqual({ status: "approved" });
      expect(next(proj).ask_type).not.toBe("plan-approval");
      expect(rows(proj, "PLAN_APPROVAL_RECORDED").length).toBe(1);
    });
    expect(filledRecord).toEqual(plainRecord);
  });

  test("their own words typed in the box are kept as on main and carry Request Changes", () => {
    const words = "Leave out the slug cache";
    const { filledRecord, plainRecord } = twins((proj, box) => {
      const question = asked(proj);
      answered(proj, box(question), words);
      expect(rows(proj, "PLAN_APPROVAL_RECORDED").length).toBe(0);
      const replied = rows(proj, "QUESTION_REPLIED");
      expect(field(replied[0], "Question")).toBe(question);
      expect(field(replied[0], "Reply")).toBe(words);
      const recorded = logAnswer(proj, `Request Changes: ${words}`);
      expect(recorded.code, recorded.out).toBe(0);
      expect(auditText(proj)).toContain(words);
      expect(next(proj).plan_approval?.status).toBe("revise");
    });
    expect(filledRecord).toEqual(plainRecord);
  });

  test("a box whose question already shows the lines records as on main", () => {
    const { filledRecord, plainRecord } = twins((proj, box) => {
      const question = [asked(proj), ...LINES].join("\n");
      const shown = box(question);
      answered(proj, shown, "Approve Plan");
      expect(rows(proj, "PLAN_APPROVAL_RECORDED").length).toBe(1);
    });
    expect(filledRecord).toEqual(plainRecord);
  });

  test("I'll edit the files opens edit mode, as on main", () => {
    const { filledRecord, plainRecord } = twins((proj, box) => {
      const question = asked(proj);
      answered(proj, box(question), "I'll edit the files");
      const ask = next(proj);
      expect(ask.kind, JSON.stringify(ask)).toBe("ask");
      expect(ask.plan_approval?.editing).toBe(true);
      typed(proj, "done");
      const recorded = logAnswer(proj, "Approve Plan");
      expect(recorded.code, recorded.out).toBe(0);
      expect(next(proj).kind).toBe("run-stage");
    });
    expect(filledRecord).toEqual(plainRecord);
  });

  test("the plan's Summary saved while the box is open: the pick still records; the record keeps the box's text", () => {
    const proj = project();
    const question = asked(proj);
    const shown = filled(proj, [planBox(question)])![0];
    writePlan(proj, "slugify for titles and headings");
    answered(proj, shown, "Approve Plan");
    expect(rows(proj, "PLAN_APPROVAL_RECORDED").length).toBe(1);
    expect(field(rows(proj, "QUESTION_REPLIED")[0], "Question")).not.toBe(question);
  });
});

describe("planQuestionBoxAsAsked", () => {
  test("a payload it cannot read comes back as it was given", async () => {
    const { planQuestionBoxAsAsked } = await import(join(AIDLC_SRC, "tools", "aidlc-plan-approval-ask.ts"));
    const proj = project();
    asked(proj);
    for (const payload of [
      "not json",
      "null",
      JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions: [null] } }),
      JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", tool_input: { questions: "x" },
        tool_response: "x" }),
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Approve the code plan?\n\n- Builds: x" }),
    ]) {
      expect(planQuestionBoxAsAsked(proj, payload)).toBe(payload);
    }
    expect(planQuestionBoxAsAsked(join(proj, "no-such-folder"), boxPayload([planBox("Approve?")])))
      .toBe(boxPayload([planBox("Approve?")]));
  });
});
