// covers: subcommand:aidlc-log:answer, subcommand:aidlc-log:decision, subcommand:aidlc-orchestrate:next
// covers: subcommand:aidlc-orchestrate:report, audit:QUESTION_SHOWN
//
// Live on Kiro CLI the first chat waited for the person's answer to Scope
// Definition's summary; a second chat in the same folder carried on there,
// wrote the stage's documents and showed its gate. Back in the first chat the
// person answered the summary with "1": the late answer was refused as "no
// matching unanswered summary question", the agent logged the summary question
// again, the engine took it at the open gate, and the first chat wrote both
// documents again and showed its own gate over files the second chat never
// described.
//
// A chat that reaches a stage whose documents are written and whose gate is
// waiting, opened in another chat, shows that gate with the files as they are,
// said in one line ("This was finished in your other chat; here it is to
// approve."), and writes nothing: the late answer and a summary question asked
// again both name that step. Approving in either chat approves the same bytes;
// asking for changes at the gate still redoes the stage; one chat alone meets
// what it meets today. Runs the shipped tools and hooks with production guards.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject, seedBoltDag, seededRecordDir, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { hostNamesThisChat } from "../../dist/kiro-ide/.kiro/tools/aidlc-record-core.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const BUN = process.execPath;
const FIRST = "01995000-0995-7000-8000-000000003601";
const SECOND = "01995000-0995-7000-8000-000000003602";
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const SUMMARY_QUESTION = "Does this all look correct before I generate the artifact?";
const FINISHED_ELSEWHERE = "This was finished in your other chat; here it is to approve.";
const PRE_GUARDS = ["state-transition-guard", "reviewer-scope", "review-freeze", "plan-approval-guard"] as const;
const HOST_ENV = [
  "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "AIDLC_STOP_HOOK_PROBE", "AWS_AIDLC_DEFAULT_SCOPE",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CONFIG_DIR",
];
const FIRST_DOCUMENT = "# Requirements\n\n## Functional Requirements\n\n- B1: Only the owner can read a saved search.\n";
const SECOND_DOCUMENT = "# Requirements\n\n## Functional Requirements\n\n- M1: Saved searches.\n- M2: Owners only.\n";

// Construction built stage by stage, solo, at its first per-Unit stage.
const UNIT_STAGE = "functional-design";
const CONSTRUCTION_STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
  "code-generation", "build-and-test"];
const STAGE_MAJOR_STATE = [
  "# AI-DLC State Tracking", "",
  "## Project Information",
  "- **Project**: Add saved searches", "- **Project Type**: Greenfield", "- **Scope**: feature", "- **State Version**: 8", "",
  "## Runtime State",
  "- **Revision Count**: 0", "- **Skeleton Stance**: off", "- **Construction Iteration**: stage-major",
  "- **Unit Ownership**: solo", "- **Construction Checkpoints**: enabled", "- **Construction Execution**: serial",
  "- **Construction Autonomy Mode**: gated", "",
  "## Scope Configuration",
  "- **Stages to Execute**: all", "- **Stages to Skip**: none", "- **Depth**: Standard", "- **Test Strategy**: Standard", "",
  "## Stage Progress", "",
  "### CONSTRUCTION PHASE",
  ...CONSTRUCTION_STAGES.map((stage) => `- [ ] ${stage} \u2014 EXECUTE`), "",
  "## Current Status",
  "- **Lifecycle Phase**: CONSTRUCTION", `- **Current Stage**: ${UNIT_STAGE}`, "- **Status**: Running", "",
].join("\n");

type Json = Record<string, unknown>;
type Run = { code: number; stdout: string; stderr: string };

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function lastJson(text: string): Json | null {
  const line = text.trim().split("\n").at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line) as Json;
  } catch {
    return null;
  }
}

function questionsBody(summaryAnswer: string): string {
  return [
    "# Requirements Analysis Questions", "",
    "## Question 1", "Who can read a saved search?", "",
    "A) Only the owner", "B) The team", "X) Other (please specify)", "",
    "[Answer]: A", "",
    "## Consolidated Summary Confirmation", "",
    "- Only the owner can read a saved search.", "",
    "- Looks correct", "- Request changes", "",
    `[Answer]: ${summaryAnswer}`.trimEnd(), "",
  ].join("\n");
}

class Folder {
  readonly dir: string;
  readonly stageDir: string;
  readonly questions: string;
  readonly artifact: string;
  readonly env: NodeJS.ProcessEnv;
  readonly outputs: string[] = [];

  constructor(options: { stageMajorUnits?: string[] } = {}) {
    this.dir = setupIntegrationProject(options.stageMajorUnits ? {} : { withState: "state-brownfield-feature.md" });
    created.push(this.dir);
    if (options.stageMajorUnits) {
      writeFileSync(seededStateFile(this.dir), STAGE_MAJOR_STATE);
      seedBoltDag(this.dir, options.stageMajorUnits);
    }
    this.stageDir = join(seededRecordDir(this.dir), "inception", STAGE);
    this.questions = join(this.stageDir, `${STAGE}-questions.md`);
    this.artifact = join(this.stageDir, "requirements.md");
    this.env = {
      ...testGuardEnvironment(process.env, "production"),
      CLAUDE_PROJECT_DIR: this.dir,
      AIDLC_PROJECT_DIR: this.dir,
      AIDLC_UNATTENDED: "0",
      AIDLC_DISABLE_SENSORS: "1",
    };
    for (const key of HOST_ENV) delete this.env[key];
    for (const args of [
      ["init", "-q"], ["config", "user.name", "AI-DLC Fixture"], ["config", "user.email", "fixture@example.invalid"],
      ["add", "-A"], ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture baseline"],
    ]) this.ok(this.run(["git", ...args], FIRST), `git ${args[0]}`);
  }

  run(argv: string[], chat: string, input?: Json, extraEnv: NodeJS.ProcessEnv = {}): Run {
    const child = Bun.spawnSync(argv, {
      cwd: this.dir,
      // The chat as Claude Code names it in the agent's shell: its id beside the live pid of the process running it.
      env: { ...this.env, CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid), ...extraEnv },
      stdin: input === undefined ? "ignore" : Buffer.from(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  }

  ok(run: Run, context: string): Run {
    expect(run.code, `${context}\n${run.stdout}\n${run.stderr}`).toBe(0);
    return run;
  }

  json(run: Run, context: string): Json {
    this.ok(run, context);
    const parsed = lastJson(run.stdout);
    expect(parsed, `${context}\n${run.stdout}`).not.toBeNull();
    return parsed!;
  }

  text(): string {
    return readFileSync(this.artifact, "utf-8");
  }

  stageMark(): string {
    const state = readFileSync(join(seededRecordDir(this.dir), "aidlc-state.md"), "utf-8");
    return new RegExp(`^- \\[(.)\\] ${STAGE} `, "m").exec(state)?.[1] ?? "(none)";
  }

  rows(event: string) {
    return readAuditShardEvents(this.dir).filter((row) => row.event === event);
  }
}

class Chat {
  constructor(readonly folder: Folder, readonly id: string) {}

  hook(name: string, payload: Json): Run {
    const argv = name === "record-human-turn"
      ? [BUN, join(this.folder.dir, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"]
      : [BUN, join(this.folder.dir, ".claude", "hooks", `aidlc-${name}.ts`)];
    return this.folder.run(argv, this.id, { cwd: this.folder.dir, session_id: this.id, ...payload });
  }

  start(): void {
    const transcripts = mkdtempSync(join(tmpdir(), "aidlc-chat-"));
    created.push(transcripts);
    const transcript = join(transcripts, `${this.id}.jsonl`);
    writeFileSync(transcript, "");
    this.folder.ok(this.hook("session-start", {
      hook_event_name: "SessionStart", source: "startup", transcript_path: transcript,
    }), "session start");
  }

  tool(name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Run {
    const result = this.folder.run(
      [BUN, join(this.folder.dir, ".claude", "tools", `aidlc-${name}.ts`), ...args, "--project-dir", this.folder.dir],
      this.id, undefined, extraEnv,
    );
    this.folder.outputs.push(`${this.id} ${name} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  }

  next(args: string[] = []): Json {
    let step = this.folder.json(this.tool("orchestrate", ["next", ...args]), `next ${args.join(" ")}`);
    for (let i = 0; step.kind === "load-steering" && i < 40; i++) {
      const [, tool, ...rest] = String(step.next).trim().split(/\s+/);
      step = this.folder.json(this.folder.run([BUN, join(this.folder.dir, tool), ...rest], this.id), "rule part");
    }
    return step;
  }

  // The agent's file write: the PreToolUse guards admit it, then the write-audit hook records it.
  write(path: string, content: string): void {
    const toolName = existsSync(path) && readFileSync(path, "utf-8") !== content ? "Edit" : "Write";
    const toolInput = toolName === "Edit"
      ? { file_path: path, old_string: readFileSync(path, "utf-8"), new_string: content }
      : { file_path: path, content };
    for (const guard of PRE_GUARDS) {
      this.folder.ok(this.hook(guard, { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }),
        `${guard} admits the write of ${path}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    this.folder.ok(this.hook("write-audit-log", {
      hook_event_name: "PostToolUse", tool_name: toolName, tool_input: toolInput, tool_response: { success: true },
    }), `record the write of ${path}`);
  }

  said(prompt: string): void {
    this.folder.ok(this.hook("record-human-turn", { hook_event_name: "UserPromptSubmit", prompt }), "the person's message");
  }

  // An engine command as a step prints it: `bun .claude/tools/<tool>.ts ...`.
  printed(command: string): Run {
    const [bun, file, ...args] = command.trim().split(/\s+/).map((word) => word.replace(/^'|'$/g, ""));
    expect(bun, command).toBe("bun");
    return this.folder.run([BUN, join(this.folder.dir, file), ...args, "--project-dir", this.folder.dir], this.id);
  }

  // The person types a setting; the agent runs the setter the step names.
  typedSetting(prompt: string, flags: string[]): void {
    this.said(prompt);
    const step = this.folder.json(this.tool("orchestrate", ["next", ...flags]), prompt);
    const setter = /Run `(bun [^`]+)` to update the configuration/.exec(String(step.message))?.[1];
    expect(setter, JSON.stringify(step)).toBeDefined();
    this.folder.ok(this.printed(setter!), `the setter for ${prompt}`);
  }

  summaryArgs(): string[] {
    return ["--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", this.folder.questions];
  }

  askSummary(): Run {
    return this.tool("log", ["decision", ...this.summaryArgs(), "--decision", SUMMARY_QUESTION,
      "--options", "Looks correct,Request changes"]);
  }

  answerSummary(): Run {
    return this.tool("log", ["answer", ...this.summaryArgs(), "--details", "Looks correct"]);
  }

  // The stage's document written, reviewed READY, and its gate opened.
  finishStage(document: string): Json {
    this.write(this.folder.artifact, document);
    const base = ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"];
    const requested = this.folder.json(this.tool("log", base), "request the review");
    this.write(resolve(this.folder.dir, String(requested.reviewFile)), [
      "## Review", "", "**Verdict:** READY", `**Reviewer:** ${REVIEWER}`, "**Iteration:** 1", "",
      "### Findings", "", "No outstanding findings.", "",
    ].join("\n"));
    this.folder.json(this.tool("log", [...base, "--verdict", "READY"]), "record the verdict");
    return this.folder.json(this.tool("orchestrate", ["report", "--stage", STAGE, "--result", "awaiting-approval"]),
      "open the approval gate");
  }
}

// The first chat starts the stage and asks the summary; the second chat
// carries on there, confirms it, writes the stage's document and opens its gate.
function secondChatFinishedTheStage(): { folder: Folder; first: Chat; second: Chat } {
  const folder = new Folder();
  const first = new Chat(folder, FIRST);
  first.start();
  first.folder.ok(first.tool("jump", ["execute", "--target", STAGE, "--direction", "redo"]), "start the stage");
  expect(first.next()).toMatchObject({ kind: "run-stage", stage: STAGE });
  first.said("Q1: A");
  first.write(folder.questions, questionsBody(""));
  folder.json(first.askSummary(), "the first chat asks the summary");

  const second = new Chat(folder, SECOND);
  second.start();
  second.said("yes, the summary looks correct, carry on");
  second.next();
  second.write(folder.questions, questionsBody("Looks correct"));
  folder.json(second.answerSummary(), "the second chat records the summary answer");
  expect(second.next()).toMatchObject({ kind: "run-stage", stage: STAGE });
  expect(second.finishStage(FIRST_DOCUMENT).kind).toBe("print");
  expect(folder.stageMark()).toBe("?");
  return { folder, first, second };
}

// What a redirected record command prints: nothing recorded, the step to take.
function redirected(run: Run): string {
  expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
  const printed = lastJson(run.stdout);
  expect(printed, run.stdout).not.toBeNull();
  expect(printed!.recorded).toBeNull();
  return String(printed!.message);
}

describe("t-second-chat-finished-step: a stage finished in another chat is shown, not written again", () => {
  test("the first chat's late summary answer names the waiting gate, and the gate is shown with the files as they are", () => {
    const { folder, first } = secondChatFinishedTheStage();
    const written = folder.text();
    const decisions = folder.rows("DECISION_RECORDED").length;
    const confirmations = folder.rows("SUMMARY_CONFIRMATION_RECORDED").length;
    const errors = folder.rows("ERROR_LOGGED").length;
    first.said("1");
    const step = redirected(first.answerSummary());
    expect(step).toContain("opened in another chat");
    expect(step).toContain("orchestrate next`");
    expect(step).not.toContain("Record the question before presenting it");
    // The summary question asked again names the same step, and the gate's
    // Request Changes for a reply that asked for a change, and is not recorded.
    const again = redirected(first.askSummary());
    expect(again).toContain("orchestrate next`");
    expect(again).toContain(`report --stage ${STAGE} --result rejected`);
    expect(folder.rows("DECISION_RECORDED").length).toBe(decisions);
    expect(folder.rows("SUMMARY_CONFIRMATION_RECORDED").length).toBe(confirmations);
    expect(folder.rows("ERROR_LOGGED").length).toBe(errors);
    // `next` shows the gate opened in the other chat, said in one line, first.
    const gate = first.next();
    expect(gate, JSON.stringify(gate)).toMatchObject({ kind: "run-stage", stage: STAGE, gate_only: true });
    expect(String(gate.narration).split("\n")[0]).toBe(FINISHED_ELSEWHERE);
    expect(folder.text()).toBe(written);
    const shown = folder.rows("QUESTION_SHOWN").filter((row) => auditBlockField(row.block, "Question Chat") === FIRST);
    expect(shown.length).toBe(1);
    // No loop: the late answer now meets the gate this chat has shown, and the
    // gate shown again does not say the line twice.
    const twice = first.next();
    expect(twice).toMatchObject({ kind: "run-stage", stage: STAGE, gate_only: true });
    expect(String(twice.narration ?? "")).not.toContain(FINISHED_ELSEWHERE);
  });

  // Live on Kiro CLI the first chat wrote the late "1" on the summary's answer
  // line first, as the stage protocol has it ("Looks correct Looks correct"),
  // and the gate shown next was a "can't go ahead" question. In the run this
  // work order came from, it blanked the line and asked the summary again.
  for (const [how, line] of [["wrote over", "Looks correct Looks correct"], ["blanked", ""]] as const) {
    test(`the summary answer line the first chat ${how} is put back, and the gate is shown`, () => {
      const { folder, first } = secondChatFinishedTheStage();
      const questions = readFileSync(folder.questions, "utf-8");
      const written = folder.text();
      first.said("1");
      first.write(folder.questions, questionsBody(line));
      expect(redirected(line === "" ? first.askSummary() : first.answerSummary())).toContain("orchestrate next`");
      expect(readFileSync(folder.questions, "utf-8")).toBe(questions);
      const gate = first.next();
      expect(gate, JSON.stringify(gate)).toMatchObject({ kind: "run-stage", stage: STAGE, gate_only: true });
      expect(String(gate.narration).split("\n")[0]).toBe(FINISHED_ELSEWHERE);
      expect(folder.text()).toBe(written);
      first.said("Approve");
      folder.json(first.tool("orchestrate", ["report", "--stage", STAGE, "--result", "approved", "--user-input",
        "Approve"]), "approve the gate shown in the first chat");
      expect(folder.stageMark()).toBe("x");
    });
  }

  // AIDA review 5797127665 F2: a summary the person asked to change, with
  // summary confirmation off since, has no confirmation on record to put back.
  test("a summary they asked to change, with confirmation off since, is left as it is", () => {
    const folder = new Folder();
    const first = new Chat(folder, FIRST);
    first.start();
    folder.ok(first.tool("jump", ["execute", "--target", STAGE, "--direction", "redo"]), "start the stage");
    first.next();
    first.said("Q1: A");
    first.write(folder.questions, questionsBody(""));
    folder.json(first.askSummary(), "the first chat asks the summary");
    const second = new Chat(folder, SECOND);
    second.start();
    second.said("Request changes: the team can read saved searches too");
    second.next();
    second.write(folder.questions, questionsBody("Request changes"));
    folder.json(second.tool("log", ["answer", ...second.summaryArgs(), "--details",
      "Request changes: the team can read saved searches too"]), "the second chat records the change request");
    second.typedSetting("/aidlc --summary-confirmation off", ["--summary-confirmation", "off"]);
    expect(second.next()).toMatchObject({ kind: "run-stage", stage: STAGE });
    expect(second.finishStage(SECOND_DOCUMENT).kind).toBe("print");
    expect(folder.stageMark()).toBe("?");
    const questions = readFileSync(folder.questions, "utf-8");
    first.said("1");
    first.write(folder.questions, questionsBody("Looks correct Looks correct"));
    const written = readFileSync(folder.questions, "utf-8");
    expect(redirected(first.answerSummary())).toContain("orchestrate next`");
    expect(readFileSync(folder.questions, "utf-8")).toBe(written);
    expect(written).not.toBe(questions);
  });

  // AIDA review 5797127665 F1: Construction stage by stage, the last Unit's
  // summary left showing in one chat while the other confirms it, builds the
  // Units and opens the stage's gate. The record is set up as the stage's own
  // commands leave it; the Units' build in between is not this file's subject.
  test("a Unit's late summary answer names the stage's waiting gate, built stage by stage", () => {
    const folder = new Folder({ stageMajorUnits: ["alpha", "beta"] });
    const state = seededStateFile(folder.dir);
    writeFileSync(state, readFileSync(state, "utf-8").replace(`- [ ] ${UNIT_STAGE} `, `- [-] ${UNIT_STAGE} `));
    appendAuditEntry("STAGE_STARTED", { Stage: UNIT_STAGE }, folder.dir);
    const unitDir = join(seededRecordDir(folder.dir), "construction", "beta", UNIT_STAGE);
    const questions = join(unitDir, `${UNIT_STAGE}-questions.md`);
    const summary = ["--stage", UNIT_STAGE, "--unit", "beta", "--checkpoint", "summary-confirmation",
      "--questions-file", questions];
    const first = new Chat(folder, FIRST);
    const second = new Chat(folder, SECOND);
    first.start();
    second.start();
    first.said("carry on");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(questions, questionsBody(""));
    folder.json(first.tool("log", ["decision", ...summary, "--decision", SUMMARY_QUESTION,
      "--options", "Looks correct,Request changes"]), "the first chat asks beta's summary");
    second.said("the summary for beta looks correct, carry on");
    writeFileSync(questions, questionsBody("Looks correct"));
    folder.json(second.tool("log", ["answer", ...summary, "--details", "Looks correct"]), "the second chat confirms it");
    const confirmed = readFileSync(questions, "utf-8");
    // The second chat built the Units and opened the stage's gate.
    writeFileSync(state, readFileSync(state, "utf-8").replace(`- [-] ${UNIT_STAGE} `, `- [?] ${UNIT_STAGE} `));
    appendAuditEntry("STAGE_AWAITING_APPROVAL", {
      Stage: UNIT_STAGE, "Question Id": "f1a1da00", "Question Type": "gate", "Question Chat": SECOND,
    }, folder.dir);
    first.said("1");
    first.write(questions, questionsBody("Looks correct Looks correct"));
    const step = redirected(first.tool("log", ["answer", ...summary, "--details", "Looks correct"]));
    expect(step).toContain("orchestrate next`");
    // Stage by stage the gate is the stage's own, so its Request Changes is too.
    expect(step).toContain(`report --stage ${UNIT_STAGE} --result rejected`);
    expect(readFileSync(questions, "utf-8")).toBe(confirmed);
  });

  // A Unit redone at the stage's open gate, Unit by Unit (the person asked to
  // change it there): its summary is asked again and recorded, never redirected.
  test("built Unit by Unit, a Unit redone at the stage's gate asks its summary as today", () => {
    const folder = new Folder({ stageMajorUnits: ["alpha", "beta"] });
    const state = seededStateFile(folder.dir);
    writeFileSync(state, readFileSync(state, "utf-8")
      .replace("- **Construction Iteration**: stage-major", "- **Construction Iteration**: unit-major")
      .replace(`- [ ] ${UNIT_STAGE} `, `- [?] ${UNIT_STAGE} `));
    appendAuditEntry("STAGE_STARTED", { Stage: UNIT_STAGE }, folder.dir);
    appendAuditEntry("STAGE_AWAITING_APPROVAL", {
      Stage: UNIT_STAGE, "Question Id": "f1a1da01", "Question Type": "gate", "Question Chat": FIRST,
    }, folder.dir);
    const unitDir = join(seededRecordDir(folder.dir), "construction", "alpha", UNIT_STAGE);
    const questions = join(unitDir, `${UNIT_STAGE}-questions.md`);
    const only = new Chat(folder, FIRST);
    only.start();
    only.said("change alpha's design: owners only");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(questions, questionsBody(""));
    const asked = folder.json(only.tool("log", ["decision", "--stage", UNIT_STAGE, "--unit", "alpha", "--checkpoint",
      "summary-confirmation", "--questions-file", questions, "--decision", SUMMARY_QUESTION,
      "--options", "Looks correct,Request changes"]), "alpha's summary asked again");
    expect(asked.recorded).toBeUndefined();
    expect(asked.emitted).toBe("DECISION_RECORDED");
    expect(readFileSync(questions, "utf-8")).toBe(questionsBody(""));
  });

  test("a late answer to one of the stage's own questions names the waiting gate too", () => {
    const { folder, first } = secondChatFinishedTheStage();
    const answers = folder.rows("QUESTION_ANSWERED").length;
    first.said("B, the team");
    const step = redirected(first.tool("log", ["answer", "--stage", STAGE, "--details", "Q1: B"]));
    expect(step).toContain("opened in another chat");
    expect(step).toContain("orchestrate next`");
    expect(folder.rows("QUESTION_ANSWERED").length).toBe(answers);
  });

  test("a late change request goes to the gate's Request Changes, with the person's words, and redoes the stage", () => {
    const { folder, first } = secondChatFinishedTheStage();
    first.said("Request changes: the team can read saved searches too");
    const step = redirected(first.answerSummary());
    const reject = /run `([^`]*--result rejected[^`]*)`/.exec(step)?.[1];
    expect(reject, step).toBeDefined();
    expect(reject).toContain(`report --stage ${STAGE} --result rejected`);
    folder.json(first.tool("orchestrate", ["report", "--stage", STAGE, "--result", "rejected", "--user-input",
      "Request Changes"]), "the gate's Request Changes from the first chat");
    expect(folder.stageMark()).not.toBe("?");
    const rejected = folder.rows("GATE_REJECTED").at(-1);
    expect(rejected).toBeDefined();
    expect(rejected!.block).toContain("the team can read saved searches too");
    const redo = first.next();
    expect(redo, JSON.stringify(redo)).toMatchObject({ kind: "run-stage", stage: STAGE });
    expect(redo.gate_only).toBeUndefined();
  });

  test("approving in the first chat approves the bytes the second chat wrote", () => {
    const { folder, first } = secondChatFinishedTheStage();
    const written = folder.text();
    first.said("1");
    first.answerSummary();
    first.next();
    first.said("Approve");
    folder.json(first.tool("orchestrate", ["report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve"]),
      "approve in the first chat");
    expect(folder.stageMark()).toBe("x");
    expect(folder.text()).toBe(written);
  });

  test("approving in the second chat approves the same bytes", () => {
    const { folder, first, second } = secondChatFinishedTheStage();
    const written = folder.text();
    first.said("1");
    first.answerSummary();
    first.next();
    second.said("Approve");
    folder.json(second.tool("orchestrate", ["report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve"]),
      "approve in the second chat");
    expect(folder.stageMark()).toBe("x");
    expect(folder.text()).toBe(written);
  });

  test("asking for changes at the gate in the first chat still redoes the stage", () => {
    const { folder, first } = secondChatFinishedTheStage();
    first.said("1");
    first.answerSummary();
    first.next();
    first.said("redo it: the team can read saved searches too");
    folder.json(first.tool("orchestrate", ["report", "--stage", STAGE, "--result", "rejected", "--user-input",
      "Request Changes"]), "request changes in the first chat");
    expect(folder.stageMark()).not.toBe("?");
    const redo = first.next();
    expect(redo, JSON.stringify(redo)).toMatchObject({ kind: "run-stage", stage: STAGE });
    expect(redo.gate_only).toBeUndefined();
    // The summary is asked again in the revision, as one chat's revision does,
    // and the revised document is written.
    first.write(folder.questions, questionsBody(""));
    folder.json(first.askSummary(), "the summary asked again while the stage is revised");
    first.write(folder.artifact, SECOND_DOCUMENT);
    expect(folder.text()).toBe(SECOND_DOCUMENT);
  });

  // Live on Claude Code the second chat met the gate after its rules came in
  // parts, and that showing was not on record: every later `next` there said the
  // line again, and a question it asked at the gate it had shown would have
  // been read as one from a chat that never saw it.
  test("a new chat that reaches a gate the first chat opened shows it once, after its rules parts", () => {
    const folder = new Folder();
    const first = new Chat(folder, FIRST);
    first.start();
    folder.ok(first.tool("jump", ["execute", "--target", STAGE, "--direction", "redo"]), "start the stage");
    first.next();
    first.said("Q1: A");
    first.write(folder.questions, questionsBody(""));
    folder.json(first.askSummary(), "ask the summary");
    first.said("Looks correct");
    first.write(folder.questions, questionsBody("Looks correct"));
    folder.json(first.answerSummary(), "record the summary answer");
    expect(first.finishStage(FIRST_DOCUMENT).kind).toBe("print");
    const written = folder.text();
    const second = new Chat(folder, SECOND);
    second.start();
    second.said("/aidlc");
    const parts = folder.json(second.tool("orchestrate", ["next"]), "the second chat's first next");
    expect(parts.kind, JSON.stringify(parts)).toBe("load-steering");
    const gate = second.next();
    expect(gate, JSON.stringify(gate)).toMatchObject({ kind: "run-stage", stage: STAGE, gate_only: true });
    expect(String(gate.narration).split("\n")[0]).toBe(FINISHED_ELSEWHERE);
    const shown = folder.rows("QUESTION_SHOWN").filter((row) => auditBlockField(row.block, "Question Chat") === SECOND);
    expect(shown.length).toBe(1);
    expect(String(second.next().narration ?? "")).not.toContain(FINISHED_ELSEWHERE);
    // A question it asks at the gate it has shown is its own, recorded as today.
    second.said("does the owner see a count?");
    const asked = folder.json(second.tool("log", ["decision", "--stage", STAGE, "--decision", "Should the owner see a count?",
      "--options", "Yes,No"]), "a question at the gate this chat showed");
    expect(asked.emitted).toBe("DECISION_RECORDED");
    expect(folder.text()).toBe(written);
  });

  test("a gate a teammate's clone opened is not called your other chat", () => {
    const { folder, first } = secondChatFinishedTheStage();
    // This checkout now writes a shard of its own: every row so far is another clone's.
    writeFileSync(join(folder.dir, "aidlc", ".aidlc-clone-id"), "teammate0001\nhost\n");
    first.said("B, the team");
    // The stage's own question meets what it meets today, never the other-chat redirect.
    const plain = first.tool("log", ["answer", "--stage", STAGE, "--details", "Q1: B"]);
    expect(lastJson(plain.stdout)?.recorded).toBeUndefined();
    expect(plain.stdout + plain.stderr).not.toContain("another chat");
    const gate = first.next();
    expect(gate).toMatchObject({ kind: "run-stage", stage: STAGE, gate_only: true });
    expect(String(gate.narration ?? "")).not.toContain(FINISHED_ELSEWHERE);
  });

  test("one chat alone: the gate shown again says nothing about another chat", () => {
    const folder = new Folder();
    const only = new Chat(folder, FIRST);
    only.start();
    folder.ok(only.tool("jump", ["execute", "--target", STAGE, "--direction", "redo"]), "start the stage");
    only.next();
    only.said("Q1: A");
    only.write(folder.questions, questionsBody(""));
    folder.json(only.askSummary(), "ask the summary");
    only.said("Looks correct");
    only.write(folder.questions, questionsBody("Looks correct"));
    folder.json(only.answerSummary(), "record the summary answer");
    expect(only.finishStage(FIRST_DOCUMENT).kind).toBe("print");
    const gate = only.next();
    expect(gate).toMatchObject({ kind: "run-stage", stage: STAGE, gate_only: true });
    expect(String(gate.narration ?? "")).not.toContain(FINISHED_ELSEWHERE);
    // The summary answered again at its own gate names the gate, with no other chat in it.
    only.said("1");
    const step = redirected(only.answerSummary());
    expect(step).toContain("orchestrate next`");
    expect(step).not.toContain("another chat");
    // A question of the stage asked at its own gate is the chat's own: recorded as today.
    only.said("what does the owner see?");
    const asked = folder.json(only.tool("log", ["decision", "--stage", STAGE, "--decision", "Should the owner see a count?",
      "--options", "Yes,No"]), "a question at its own gate");
    expect(asked.recorded).toBeUndefined();
    expect(asked.emitted).toBe("DECISION_RECORDED");
  });

  // Live on Kiro CLI V3, which runs Kiro IDE's tree, the gate came with no line:
  // the split by host name left out the one Kiro that names its chats.
  test("a Kiro command names its chat when Kiro CLI gives it one, and not from the process tree", () => {
    const saved = { kiro: process.env.KIRO_SESSION_ID, override: process.env.AIDLC_SESSION_OVERRIDE,
      source: process.env.AIDLC_SESSION_OVERRIDE_SOURCE };
    try {
      delete process.env.AIDLC_SESSION_OVERRIDE;
      delete process.env.AIDLC_SESSION_OVERRIDE_SOURCE;
      process.env.KIRO_SESSION_ID = "sess_a3337cb2-93ec-4fe6-80e4-81c74d73ad7f";
      expect(hostNamesThisChat(tmpdir())).toBe(true);
      delete process.env.KIRO_SESSION_ID;
      expect(hostNamesThisChat(tmpdir())).toBe(false);
      process.env.AIDLC_SESSION_OVERRIDE = SECOND;
      expect(hostNamesThisChat(tmpdir())).toBe(false);
      process.env.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
      expect(hostNamesThisChat(tmpdir())).toBe(true);
    } finally {
      for (const [key, value] of [["KIRO_SESSION_ID", saved.kiro], ["AIDLC_SESSION_OVERRIDE", saved.override],
        ["AIDLC_SESSION_OVERRIDE_SOURCE", saved.source]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
