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
//   - a question about several Units always gets each Unit's name and path,
//     and the changed-source line once, never the summaries, so a short window
//     never shows several plans as one; nothing once one plan is answered;
//   - two pieces of work open in two chats, each at its plan question: each
//     chat's box shows its own work's plan or nothing, never the other's, with
//     or without Claude Code's own chat variables;
//   - the answer to the filled box records as on main: the pick, the person's
//     own words, the question the agent asked and its id; Approve builds and
//     is not asked again, Request Changes and "I'll edit the files" go as on
//     main; the one miss (the plan's Summary saved while the box is open) still
//     records the pick.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  cleanupWorktreeFixture,
  createOrchestrationTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  FIXTURES_DIR,
  intentsDirOf,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDagBatches,
  seededRecordDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";
import {
  codeGenerationRecordDir,
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  planApprovalRuntimeFile,
  setActiveIntentCursor,
  stateDigest,
  workspaceSourceListing,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
  writeSessionBinding,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  publishPlanApprovalAsk,
  routeCodeGenerationPlanApproval,
} from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";

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
const worktrees: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  while (worktrees.length > 0) cleanupWorktreeFixture(worktrees.pop());
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

// Claude Code's own chat variables are left out unless a case sets them, so the
// runner's own chat never stands in for the box's.
const HOST_CHAT_VARS = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
  "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE"];

function env(proj: string, extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const own = { ...process.env };
  for (const name of HOST_CHAT_VARS) delete own[name];
  return { ...own, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", ...extra };
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

function boxPayload(questions: unknown[], session = SESSION): string {
  return JSON.stringify({
    hook_event_name: "PreToolUse", session_id: session, cwd: "", tool_name: "AskUserQuestion",
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

  test("a question that ends in a line break records as on main", () => {
    const { filledRecord, plainRecord } = twins((proj, box) => {
      answered(proj, box(`${asked(proj)}\n`), "Approve Plan");
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

  // The ceiling the reverse names: the shortest question that rebuilds the box wins.
  test("an agent question that holds the lines after a blank line is recorded as the text before them", () => {
    const proj = project();
    const question = asked(proj);
    const own = [question, "", ...LINES].join("\n");
    const shown = filled(proj, [planBox(own)])![0];
    expect(shown.question).toBe(`${own}\n\nFull plan: ${planPath(proj)}`);
    answered(proj, shown, "Approve Plan");
    expect(rows(proj, "PLAN_APPROVAL_RECORDED").length).toBe(1);
    expect(field(rows(proj, "QUESTION_REPLIED")[0], "Question")).toBe(question);
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

// Two Units asked about in one question (the swarm set-up of
// t-plan-approval-ask's groupedProject), with the person's source change since
// the stage started when `changed` is set.
const GROUP = ["alpha", "beta"];

function groupedProject(changed: boolean): { pd: string; question: string; choices: string[]; paths: string[] } {
  const pd = setupWorktreeFixture();
  worktrees.push(pd);
  seedAidlcMemory(pd);
  writeFileSync(seededStateFile(pd), [
    "# State", "## Project Information", "- **Project**: Grouped plan approval", "- **Scope**: feature",
    "- **Project Type**: Greenfield", "- **State Version**: 8", "## Runtime State",
    "- **Construction Checkpoints**: enabled", "- **Construction Iteration**: stage-major",
    "- **Construction Execution**: swarm", "- **Construction Autonomy Mode**: gated", "- **Skeleton Stance**: off",
    "- **Unit Ownership**: solo", "- **Guard Policy**: strict (set by you)", "## Stage Progress",
    "### CONSTRUCTION PHASE", "- [-] code-generation \u2014 EXECUTE", "- [ ] build-and-test \u2014 EXECUTE",
    "## Current Status", "- **Current Stage**: code-generation", "- **Lifecycle Phase**: CONSTRUCTION",
    "- **Status**: Running", "",
  ].join("\n"), "utf-8");
  seedBoltDagBatches(pd, [GROUP]);
  mkdirSync(join(pd, "src"), { recursive: true });
  const baseline = writeBaselineSourceSnapshot(pd, "code-generation", workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", "Source Baseline": baseline }, pd);
  if (changed) writeFileSync(join(pd, "src", "theirs.ts"), "export const theirs = 1;\n", "utf-8");
  const contract = renderTestingContract(resolveTestingPosture(pd));
  for (const unit of GROUP) {
    const dir = codeGenerationRecordDir(pd, unit);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "code-generation-plan.md"),
      `# Plan for ${unit}\n\n## Summary\n\n- Builds: ${unit}\n- Touches: src/${unit}.ts\n- Tests: 2 unit tests\n\n` +
        `## Steps\n- [ ] Implement ${unit}\n\n${contract}`, "utf-8");
    writeFileSync(join(dir, "unit-test-instructions.md"), `# Tests\n\nRun ${unit} tests.\n`, "utf-8");
  }
  const state = () => stateDigest(readFileSync(seededStateFile(pd), "utf-8"));
  writeActiveDirectiveMarker(pd, { kind: "invoke-swarm", stage: "code-generation", units: GROUP, state_sha256: state() });
  const routed = routeCodeGenerationPlanApproval(pd, { kind: "invoke-swarm", stage: "code-generation", units: GROUP }) as
    unknown as { question: string; plan_approval: { choices: string[]; targets: Array<{ plan_path: string }> } };
  writeActiveDirectiveMarker(pd, {
    kind: "ask", stage: "code-generation", ask_type: "plan-approval", units: GROUP, state_sha256: state(),
  });
  publishPlanApprovalAsk(pd, routed as unknown as Parameters<typeof publishPlanApprovalAsk>[1]);
  return {
    pd, question: routed.question, choices: routed.plan_approval.choices,
    paths: routed.plan_approval.targets.map((target) => target.plan_path),
  };
}

function groupBox(question: string, choices: string[]): Box {
  return { question, header: "Code plans", multiSelect: false, options: choices.map((label) => ({ label, description: "" })) };
}

describe("a question about several Units", () => {
  test("the box gets each Unit's name and path, never the summaries", () => {
    const { pd, question, choices, paths } = groupedProject(false);
    expect(question).toBe("Approve these 2 code plans?");
    expect(filled(pd, [groupBox(question, choices)])?.[0].question).toBe([
      question, "", "alpha", `Full plan: ${paths[0]}`, "", "beta", `Full plan: ${paths[1]}`,
    ].join("\n"));
  });

  test("the source that already changed is said once, last", () => {
    const { pd, question, choices, paths } = groupedProject(true);
    const shown = filled(pd, [groupBox(question, choices)])?.[0].question ?? "";
    expect(shown.startsWith([question, "", "alpha", `Full plan: ${paths[0]}`, "", "beta", `Full plan: ${paths[1]}`, "",
      "Already changed before you approved: "].join("\n"))).toBe(true);
    expect(shown.split("Already changed").length).toBe(2);
    expect(shown).not.toContain("- Builds:");
  });

  test("the answer reads the box as the agent asked it, and once one plan is answered nothing is added", () => {
    const { pd, question, choices } = groupedProject(false);
    const shown = filled(pd, [groupBox(question, choices)])![0];
    answered(pd, shown, "Request Changes");
    const replied = rows(pd, "QUESTION_REPLIED");
    expect(field(replied[0], "Question")).toBe(question);
    expect(field(replied[0], "Reply")).toBe("Request Changes");
    const approved = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation", "--checkpoint", "plan-approval",
      "--details", "Approve Plan", "--units", "alpha", "--project-dir", pd,
    ], { cwd: pd, env: env(pd), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(approved.status, `${approved.stdout}${approved.stderr}`).toBe(0);
    quiet(pd, boxPayload([groupBox(question, choices)]));
  });
});

// Two pieces of work in one project, each bound to its own chat, each at its
// code plan question (the second record beside the fixture's, as
// t-every-chat-enters-by-one-door sets it up); the shared cursor names the first.
const WORKS = [
  { record: DEFAULT_RECORD_DIR, chat: "01995000-7a11-7000-8000-00000000000a", builds: "ALPHA slugify for titles" },
  { record: "second-work-00000002", chat: "01995000-7a11-7000-8000-00000000000b", builds: "BETA csv export" },
];

function twoWorks(): string {
  const proj = project();
  const intents = intentsDirOf(proj, DEFAULT_SPACE);
  mkdirSync(join(intents, WORKS[1].record), { recursive: true });
  writeFileSync(join(intents, WORKS[1].record, "aidlc-state.md"), readFileSync(seededStateFile(proj), "utf-8"));
  const registry = JSON.parse(readFileSync(join(intents, "intents.json"), "utf-8")) as Array<Record<string, unknown>>;
  registry.push({ uuid: "00000000-0000-7000-8000-000000000002", slug: "second-work", dirName: WORKS[1].record, status: "in-flight" });
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify(registry, null, 2)}\n`);
  setActiveIntentCursor(proj, WORKS[0].record);
  for (const work of WORKS) {
    writeSessionBinding(proj, work.chat, DEFAULT_SPACE, work.record, "switch");
    const dir = join(intents, work.record, "construction", "code-generation");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "code-generation-plan.md"),
      `# Code Generation Plan\n\n## Summary\n\n- Builds: ${work.builds}\n- Touches: src/slugify.ts\n- Tests: 3 unit tests\n\n` +
        `## Steps\n\n- [ ] Step 1\n\n${renderTestingContract(resolveTestingPosture(proj))}`, "utf-8");
    writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun the tests.\n", "utf-8");
    const result = runOrchestrateNext(ORCHESTRATE, proj, [], { env: env(proj, { AIDLC_SESSION_OVERRIDE: work.chat }) });
    expect(result.status, result.out).toBe(0);
    const ask = result.directive as unknown as Directive & { plan_approval?: { targets?: Array<{ summary: string[] }> } };
    expect(ask.ask_type, JSON.stringify(ask)).toBe("plan-approval");
    expect(ask.plan_approval?.targets?.[0].summary[0]).toBe(`Builds: ${work.builds}`);
  }
  return proj;
}

function boxIn(proj: string, chat: string, hostVariables: boolean): string | null {
  const host = hostVariables ? { CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: chat } : {};
  const result = beforeBox(proj, boxPayload([planBox("Approve the code plan?")], chat), host);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim() === ""
    ? null
    : (JSON.parse(result.stdout) as { hookSpecificOutput: { updatedInput: { questions: Box[] } } })
      .hookSpecificOutput.updatedInput.questions[0].question;
}

describe("two pieces of work open in two chats", () => {
  test("each chat's box shows its own work's plan, never the other's, with or without Claude Code's chat variables", () => {
    const proj = twoWorks();
    for (const hostVariables of [false, true]) {
      const [alpha, beta] = WORKS.map((work) => boxIn(proj, work.chat, hostVariables));
      expect(alpha, `host variables ${hostVariables}`).toContain("ALPHA");
      expect(alpha).not.toContain("BETA");
      expect(beta, `host variables ${hostVariables}`).toContain("BETA");
      expect(beta).not.toContain("ALPHA");
    }
  });

  test("the answer in the second chat records against its own question", () => {
    const proj = twoWorks();
    const shown = boxIn(proj, WORKS[1].chat, false);
    expect(shown).toContain("BETA");
    const questions = [planBox(shown ?? "")];
    const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
      cwd: proj,
      input: JSON.stringify({
        hook_event_name: "PostToolUse", session_id: WORKS[1].chat, tool_name: "AskUserQuestion",
        tool_input: { questions }, tool_response: { questions, answers: { [shown ?? ""]: "Approve Plan" } },
      }),
      env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, result.stderr).toBe(0);
    const audit = readdirSync(join(intentsDirOf(proj, DEFAULT_SPACE), WORKS[1].record, "audit"))
      .map((name) => readFileSync(join(intentsDirOf(proj, DEFAULT_SPACE), WORKS[1].record, "audit", name), "utf-8")).join("\n");
    const replied = audit.split(/\n(?=## )/).filter((block) => block.includes("**Event**: QUESTION_REPLIED\n"));
    expect(field(replied[0] ?? "", "Question")).toBe("Approve the code plan?");
    expect(audit).toContain("**Event**: PLAN_APPROVAL_RECORDED");
  });
});

// An isolated Code Generation run in a project with no work (as
// t-plan-approval-ask's "project with no work" sets it up): its plan question is
// the open step of the space's own record, and its box gets the lines too.
describe("an isolated Code Generation run in a project with no work", () => {
  const SINGLE = ["--stage", "code-generation", "--single", "--scope", "enterprise"];
  const SPACE_RECORD = ["aidlc", "spaces", "default", "intents"];
  const ownPlanDir = (proj: string) => join(proj, ...SPACE_RECORD, "construction", "code-generation");

  test("the box gets the plan's lines and path, and the answer records against its question", () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    removeWorkspaceRecord(proj);
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
    typed(proj, "/aidlc --stage code-generation --single");
    const planning = runOrchestrateNext(ORCHESTRATE, proj, SINGLE, { env: env(proj) });
    expect(planning.status, planning.out).toBe(0);
    mkdirSync(ownPlanDir(proj), { recursive: true });
    writeFileSync(join(ownPlanDir(proj), "code-generation-plan.md"),
      "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
        "- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n" +
        renderTestingContract(resolveTestingPosture(proj)), "utf-8");
    writeFileSync(join(ownPlanDir(proj), "unit-test-instructions.md"),
      "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n", "utf-8");
    const ask = runOrchestrateNext(ORCHESTRATE, proj, SINGLE, { env: env(proj) });
    expect(ask.status, ask.out).toBe(0);
    const question = (ask.directive as unknown as Directive).question ?? "";
    expect((ask.directive as unknown as Directive).ask_type).toBe("plan-approval");
    const path = relative(proj, join(ownPlanDir(proj), "code-generation-plan.md")).replaceAll("\\", "/");
    const shown = filled(proj, [planBox(question)]);
    expect(shown?.[0].question).toBe([question, "", ...LINES, "", `Full plan: ${path}`].join("\n"));
    answered(proj, shown![0], "Approve Plan");
    const auditDir = join(proj, ...SPACE_RECORD, "audit");
    const audit = existsSync(auditDir)
      ? readdirSync(auditDir).map((name) => readFileSync(join(auditDir, name), "utf-8")).join("\n") : "";
    const replied = audit.split(/\n(?=## )/).filter((block) => block.includes("**Event**: QUESTION_REPLIED\n"));
    expect(field(replied.at(-1) ?? "", "Question")).toBe(question);
    expect(audit).toContain("**Event**: PLAN_APPROVAL_RECORDED");
  });
});
