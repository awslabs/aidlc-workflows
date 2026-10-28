// covers: function:askedQuestionFields, function:noteQuestionRow, function:turnQuestionFields, function:boxQuestionId
// covers: function:questionEntryDigests, function:recordQuestionStep, function:planApprovalQuestionId
// covers: audit:QUESTION_ASKED, audit:QUESTION_SHOWN, audit:STAGE_AWAITING_APPROVAL, audit:DECISION_RECORDED, audit:HUMAN_TURN
// covers: hook:aidlc-record-human-turn, subcommand:aidlc-orchestrate:report, subcommand:aidlc-log:decision
// covers: subcommand:aidlc-bolt:checkpoint
//
// Every question AI-DLC asks is recorded with its own id, so a later record of
// the person's answer can name the question it answers (Move 1, S1; Arden's D1
// and D2). Nothing decides on any of it yet, and nothing new reaches the
// person's screen. Each kind of ask writes exactly one id, with its type, the
// chat it was asked in and what it shows, and the step that asks hands the
// agent that id: the gate, every question the agent logs, the verification
// command and a Unit checkpoint, an engine question (QUESTION_ASKED) and the
// code plan question. Shown again in a chat that had not seen it, the same
// question writes one QUESTION_SHOWN, and a clone finds it under the same id.
// Each turn of the person's carries the ids open in their chat (a turn in
// another chat does not, an answered gate leaves), and the digest of each
// entry of the stage's questions file, which an answer written in and Windows
// line endings leave unchanged. A question box's answer names the question it
// answered by its id.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  activeDirectiveStorageDir,
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents,
  reviewArtifactFingerprint,
  sessionsDir,
  setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const A = "01995000-7a11-7000-8000-00000000a001";
const B = "01995000-7a11-7000-8000-00000000b002";
const C = "01995000-7a11-7000-8000-00000000c003";
const D = "01995000-7a11-7000-8000-00000000d004";
const ID = /^[0-9a-f]{8}$/;
const SHOWS = /^sha256:[0-9a-f]{64}$/;
// The state file's separator between a stage slug and its action.
const DASH = "\u2014";

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

// The engine as the agent runs it in `chat`, through the project's own install.
function base(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    AIDLC_UNATTENDED: "0",
  };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_STOP_HOOK_PROBE;
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

function engine(proj: string, chat: string | null, args: string[], input?: string) {
  const env = { ...base(), CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
  if (chat !== null) Object.assign(env, { AIDLC_SESSION_OVERRIDE: chat, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" });
  const result = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc.ts"), ...args], {
    cwd: proj, input, encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  expect(result.status, out).toBe(0);
  return JSON.parse((result.stdout ?? "").trim().split("\n").at(-1) || "{}") as Record<string, unknown>;
}

const step = (proj: string, chat: string | null, args: string[]) => engine(proj, chat, ["engine", "orchestrate", ...args]);

// A tool run with --project-dir, as the agent runs it.
function tool(proj: string, chat: string | null, name: string, args: string[]) {
  return engine(proj, chat, ["engine", name, ...args, "--project-dir", proj]);
}

// The person's message, as the human-turn hook records it.
function say(proj: string, chat: string, prompt: string): void {
  engine(proj, null, ["engine", "hook", "record-human-turn"], JSON.stringify({
    hook_event_name: "UserPromptSubmit", session_id: chat, prompt,
  }));
}

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const field = (row: { block: string } | undefined, name: string) => (row ? auditBlockField(row.block, name) : null);
const lastTurn = (proj: string) => rows(proj, "HUMAN_TURN").at(-1);
const openIn = (proj: string): string[] => (field(lastTurn(proj), "Open Questions") ?? "").split(", ").filter(Boolean);

// --- The gate ---

const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";

function inception(): string {
  const proj = setupIntegrationProject({ withState: "state-mid-inception.md", stripEnvScope: true });
  projects.push(proj);
  const statePath = seededStateFile(proj);
  writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), "relaxed (set by you)"));
  return proj;
}

// The stage's outputs and one READY review, as a real run records them.
function reviewedStage(proj: string): void {
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  for (const name of ["requirements.md", `${STAGE}-questions.md`]) {
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), `# ${name}\n`);
  }
  const review = ["log", "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"];
  engine(proj, A, ["engine", ...review]);
  appendFileSync(join(dir, "requirements.md"),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
  engine(proj, A, ["engine", ...review, "--verdict", "READY"]);
}

describe("the gate", () => {
  test("its row carries its id, type, chat and what it shows, and the reply hands the agent the same id", () => {
    const proj = inception();
    reviewedStage(proj);
    const reply = step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    const [gate] = rows(proj, "STAGE_AWAITING_APPROVAL");
    expect(field(gate, "Question Id")).toMatch(ID);
    expect(field(gate, "Question Type")).toBe("gate");
    expect(field(gate, "Question Chat")).toBe(A);
    expect(field(gate, "Question Shows")).toMatch(SHOWS);
    expect(reply.kind).toBe("print");
    expect(reply.question_id).toBe(field(gate, "Question Id"));
    expect(rows(proj, "QUESTION_SHOWN")).toEqual([]);
  });

  test("shown again in a chat that had not seen it, it writes one QUESTION_SHOWN, and none in a chat that had", () => {
    const proj = inception();
    reviewedStage(proj);
    step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    const id = field(rows(proj, "STAGE_AWAITING_APPROVAL")[0], "Question Id");
    expect(step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]).question_id).toBe(id);
    expect(rows(proj, "QUESTION_SHOWN")).toEqual([]);
    expect(step(proj, B, ["report", "--stage", STAGE, "--result", "awaiting-approval"]).question_id).toBe(id);
    step(proj, B, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => [field(row, "Question Id"), field(row, "Question Chat")]))
      .toEqual([[id, B]]);
    // A new chat's `next` shows the open gate again under the same id.
    say(proj, C, "/aidlc");
    const again = step(proj, C, ["next"]);
    expect(again.gate_only, JSON.stringify(again)).toBe(true);
    expect(again.question_id).toBe(id);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => field(row, "Question Chat"))).toEqual([B, C]);
    expect(rows(proj, "STAGE_AWAITING_APPROVAL")).toHaveLength(1);
  });

  test("a turn in a chat it was shown in carries its id, a turn elsewhere does not, and once answered it leaves", () => {
    const proj = inception();
    reviewedStage(proj);
    step(proj, A, ["report", "--stage", STAGE, "--result", "awaiting-approval"]);
    const id = field(rows(proj, "STAGE_AWAITING_APPROVAL")[0], "Question Id")!;
    say(proj, A, "looks good");
    expect(openIn(proj)).toContain(id);
    say(proj, D, "what is this?");
    expect(openIn(proj)).not.toContain(id);
    appendAuditEntry("GATE_APPROVED", { Stage: STAGE, "User Input": "Approve" }, proj);
    say(proj, A, "thanks");
    expect(openIn(proj)).not.toContain(id);
  });
});

// --- The questions the agent logs ---

describe("a question the agent logs", () => {
  test("each kind writes one id with its type and chat, and the command prints it", () => {
    const proj = inception();
    const kinds: Array<[string[], string]> = [
      [[], "stage-question"],
      [["--question-kind", "answer-mode"], "answer-mode"],
      [["--question-kind", "learnings-note"], "learnings-note"],
    ];
    for (const [extra, type] of kinds) {
      const printed = tool(proj, A, "log", ["decision", "--stage", STAGE, "--decision", `Which ${type}?`,
        "--options", "One,Two", ...extra]);
      const row = rows(proj, "DECISION_RECORDED").at(-1);
      expect(field(row, "Question Id")).toMatch(ID);
      expect(printed.question_id).toBe(field(row, "Question Id"));
      expect(field(row, "Question Type")).toBe(type);
      expect(field(row, "Question Chat")).toBe(A);
      expect(field(row, "Question Shows")).toMatch(SHOWS);
    }
    const ids = rows(proj, "DECISION_RECORDED").map((row) => field(row, "Question Id"));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a question box's answer names the question it answered by its id", () => {
    const proj = inception();
    tool(proj, A, "log", ["decision", "--stage", STAGE, "--decision", "Which database?", "--options", "Postgres,SQLite"]);
    const id = field(rows(proj, "DECISION_RECORDED").at(-1), "Question Id");
    expect(id).toMatch(ID);
    engine(proj, null, ["engine", "hook", "record-human-turn"], JSON.stringify({
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: A,
      tool_input: { questions: [
        { question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
        { question: "Anything else?", options: [{ label: "No" }, { label: "Yes" }] },
      ] },
      tool_response: { answers: { "Which database?": "Postgres", "Anything else?": "No" } },
    }));
    const replied = rows(proj, "QUESTION_REPLIED");
    expect(replied.map((row) => [field(row, "Question"), field(row, "Question Id")])).toEqual([
      ["Which database?", id], ["Anything else?", null],
    ]);
  });
});

// --- The verification command and a Unit checkpoint ---

const CONSTRUCTION = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

// Two Units built one at a time, checkpoints on, alpha built.
function built(): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: question record
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Unit Ownership**: solo
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Review Override**: none
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${CONSTRUCTION.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} ${DASH} EXECUTE`).join("\n")}
- [ ] build-and-test ${DASH} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  for (const slug of CONSTRUCTION) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", "alpha", slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# alpha ${name}\n`);
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
        stage: slug, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }],
      }));
    }
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: "alpha", Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, "alpha"),
      "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, "alpha", { requireRequiredArtifacts: true })!,
    }, p);
  }
  return p;
}

function shellQuote(value: string): string {
  return process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

describe("a checkpoint question", () => {
  test("the verification command and a Unit checkpoint each write one id in the chat that asked, and print it", () => {
    const p = built();
    const script = join(seededRecordDir(p), "check.cjs");
    writeFileSync(script, "process.exit(0);");
    const command = `${shellQuote(BUN)} ${shellQuote(script)}`;
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", B];
    const asked = tool(p, null, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?",
      "--options", "Approve,Request Changes"]);
    const verification = rows(p, "DECISION_RECORDED").at(-1);
    expect(field(verification, "Question Type")).toBe("verification-command");
    expect(field(verification, "Question Chat")).toBe(B);
    expect(asked.question_id).toBe(field(verification, "Question Id"));
    say(p, B, "Approve");
    tool(p, null, "log", ["answer", ...identity, "--details", "Approve"]);
    tool(p, null, "state", ["set-construction-verification-command", command]);
    tool(p, null, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "verify"]);
    const checkpoint = tool(p, null, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "ask", "--session", A]);
    const row = rows(p, "DECISION_RECORDED").at(-1);
    expect(field(row, "Checkpoint")).toBe("Construction Unit Approval");
    expect(field(row, "Question Type")).toBe("unit-checkpoint");
    expect(field(row, "Question Chat")).toBe(A);
    expect(field(row, "Question Shows")).toMatch(SHOWS);
    expect(checkpoint.question_id).toBe(field(row, "Question Id"));
    say(p, A, "let me look");
    expect(openIn(p)).toContain(field(row, "Question Id"));
  });
});

// --- An engine question ---

// A feature plan that has just entered Construction with two Units and nobody
// asked who builds them: the first step is the engine's own question.
function staffing(): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: question record
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8

## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Checkpoints**: enabled
- **Construction Iteration**: unit-major
- **Construction Execution**: serial

## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] units-generation ${DASH} EXECUTE
- [x] delivery-planning ${DASH} EXECUTE

### CONSTRUCTION PHASE
- [-] functional-design ${DASH} EXECUTE
- [ ] nfr-requirements ${DASH} EXECUTE
- [ ] nfr-design ${DASH} EXECUTE
- [ ] infrastructure-design ${DASH} EXECUTE
- [ ] code-generation ${DASH} EXECUTE
- [ ] build-and-test ${DASH} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(proj, ["alpha", "beta"]);
  return proj;
}

describe("an engine question", () => {
  test("is recorded once when it is handed out, shown again in a new chat, and found again in a clone", () => {
    const proj = staffing();
    const ask = step(proj, A, ["next"]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("construction-staffing");
    const [asked] = rows(proj, "QUESTION_ASKED");
    expect(field(asked, "Question Id")).toMatch(ID);
    expect(ask.question_id).toBe(field(asked, "Question Id"));
    expect(field(asked, "Question Type")).toBe("construction-staffing");
    expect(field(asked, "Question Chat")).toBe(A);
    expect(field(asked, "Question Shows")).toMatch(SHOWS);
    expect(field(asked, "Stage")).toBe("functional-design");
    expect(step(proj, A, ["next"]).question_id).toBe(ask.question_id);
    expect(rows(proj, "QUESTION_ASKED")).toHaveLength(1);
    expect(rows(proj, "QUESTION_SHOWN")).toEqual([]);
    expect(step(proj, B, ["next"]).question_id).toBe(ask.question_id);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => field(row, "Question Chat"))).toEqual([B]);
    say(proj, B, "just me I think");
    expect(openIn(proj)).toEqual([ask.question_id as string]);
    // A teammate's clone keeps no runtime record of its own: the committed
    // record names the question, and it is shown there under the same id.
    for (const runtime of [join(sessionsDir(proj), "plan-approval"), activeDirectiveStorageDir(proj)]) {
      rmSync(runtime, { recursive: true, force: true });
    }
    expect(step(proj, C, ["next"]).question_id).toBe(ask.question_id);
    expect(rows(proj, "QUESTION_ASKED")).toHaveLength(1);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => field(row, "Question Chat"))).toEqual([B, C]);
  });
});

// --- The code plan question ---

function codeGeneration(): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)",
      "- **Guard Policy**: relaxed (from scope poc)\n- **Plan Approval**: on (set by you)")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  const dir = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n${renderTestingContract(resolveTestingPosture(proj))}`);
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n");
  return proj;
}

describe("the code plan question", () => {
  test("goes on the record with its id beside the ask's own, and is shown again in a new chat under it", () => {
    const proj = codeGeneration();
    const ask = step(proj, A, ["next"]);
    expect(ask.ask_type, JSON.stringify(ask)).toBe("plan-approval");
    const [asked] = rows(proj, "QUESTION_ASKED");
    expect(field(asked, "Question Type")).toBe("plan-approval");
    expect(field(asked, "Question Id")).toMatch(ID);
    expect(ask.question_id).toBe(field(asked, "Question Id"));
    expect(field(asked, "Ask Id")).toMatch(/^[0-9a-f]{32}$/);
    expect(field(asked, "Question Chat")).toBe(A);
    expect(step(proj, A, ["next"]).question_id).toBe(ask.question_id);
    expect(step(proj, B, ["next"]).question_id).toBe(ask.question_id);
    expect(rows(proj, "QUESTION_ASKED")).toHaveLength(1);
    expect(rows(proj, "QUESTION_SHOWN").map((row) => field(row, "Question Chat"))).toEqual([B]);
  });
});

// --- The questions file, as each turn sees it ---

const QUESTIONS = [
  "# Requirements Analysis Questions", "",
  "## Q1. [Product] Who uses it?", "", "A. Staff", "B. Customers", "X. Other (please specify)", "", "[Answer]:", "",
  "## Q2. [Product] How often?", "", "A. Daily", "B. Weekly", "X. Other (please specify)", "", "[Answer]:", "",
].join("\n");

describe("the questions file", () => {
  // Read where it is used, so a build without it fails here alone.
  const digests = async (): Promise<(content: string) => Record<string, string>> =>
    (await import("../../dist/claude/.claude/tools/aidlc-questions.ts")).questionEntryDigests;

  test("each entry's digest ignores an answer written in and Windows line endings; an edit changes only its own", async () => {
    const questionEntryDigests = await digests();
    const before = questionEntryDigests(QUESTIONS);
    expect(Object.keys(before)).toEqual(["Q1", "Q2"]);
    expect(questionEntryDigests(QUESTIONS.replace("[Answer]:\n\n## Q2", "[Answer]: A\n\n## Q2"))).toEqual(before);
    expect(questionEntryDigests(QUESTIONS.replaceAll("\n", "\r\n"))).toEqual(before);
    const edited = questionEntryDigests(QUESTIONS.replace("How often?", "How often, and when?"));
    expect(edited.Q1).toBe(before.Q1);
    expect(edited.Q2).not.toBe(before.Q2);
  });

  test("a turn carries the digest of each question in the stage's file the engine handed out", async () => {
    const questionEntryDigests = await digests();
    const proj = inception();
    const run = step(proj, A, ["next"]);
    expect(run.kind, JSON.stringify(run)).toBe("run-stage");
    const file = join(seededRecordDir(proj), "inception", STAGE, `${STAGE}-questions.md`);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, QUESTIONS);
    say(proj, A, "staff, daily");
    const stamped = JSON.parse(field(lastTurn(proj), "Questions Digest") ?? "{}") as {
      file?: string; entries?: Record<string, string>;
    };
    expect(stamped.file).toBe(`${seededRecordDir(proj).slice(proj.length + 1).replaceAll("\\", "/")}/inception/${STAGE}/${STAGE}-questions.md`);
    expect(stamped.entries).toEqual(questionEntryDigests(QUESTIONS));
    writeFileSync(file, QUESTIONS.replace("[Answer]:\n\n## Q2", "[Answer]: A\n\n## Q2").replaceAll("\n", "\r\n"));
    say(proj, A, "and weekly");
    expect(JSON.parse(field(lastTurn(proj), "Questions Digest") ?? "{}").entries).toEqual(stamped.entries);
  });
});
