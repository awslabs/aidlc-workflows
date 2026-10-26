// covers: subcommand:aidlc-orchestrate:next
//
// Going back to a stage whose summary the person confirmed earlier (a jump
// back, a restart of the stage, a resume after either) asks them to confirm
// the summary once more, and only that: the step clears the Consolidated
// Summary Confirmation answer in the stage's questions file, every other byte
// kept, so the agent asks it before saving the documents again, and the review
// and the approval gate follow with no "can't go ahead" question. A reply they
// already gave since going back, summary confirmation turned off, the Stop
// hook's read-only probe and a jump that does not reach the stage leave the
// file as it is. Keeping the documents records them under the new
// confirmation, so the review runs with no save. In a walk of one Unit at a time, a jump back reopens
// the Unit, whose confirmed summary still holds: its file is left as it is and
// its step ends with no question. Runs the shipped tools and hooks with
// production guards; every record comes from the engine's own commands and the
// write-audit hook.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupTestProject, seedBoltDag, seededRecordDir, seededStateFile, setupIntegrationProject,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  auditBlockField, guardRecoveryAskFromRefusalText, readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const SESSION = "01995000-0995-7000-8000-000000000952";
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const UNIT_STAGE = "functional-design";
const UNIT_REVIEWER = "aidlc-architecture-reviewer-agent";
const UNIT = "alpha";
const UNIT_DOCUMENTS = ["entities.md", "rules.md", "functional-spec.md", "traceability.json"];
const SUMMARY_QUESTION = "Does this all look correct before I generate the artifact?";
const PRE_GUARDS = ["state-transition-guard", "reviewer-scope", "review-freeze", "plan-approval-guard"] as const;
// The host's own session and probe markers would point the tools at another chat.
const HOST_ENV = [
  "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "AIDLC_STOP_HOOK_PROBE", "AWS_AIDLC_DEFAULT_SCOPE",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CONFIG_DIR",
];

type Json = Record<string, unknown>;
type Run = { code: number; stdout: string; stderr: string };

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function questionsBody(answer: string, eol = "\n"): string {
  return [
    "# Requirements Analysis Questions", "",
    "## Question 1", "Who can read a saved search?", "",
    "A) Only the owner", "B) The team", "X) Other (please specify)", "",
    "[Answer]: A", "",
    "## Consolidated Summary Confirmation", "",
    "- Only the owner can read a saved search.", "",
    "- Looks correct", "- Request changes", "",
    `[Answer]: ${answer}`.trimEnd(), "",
  ].join(eol);
}

// Construction with Units built one at a time, solo, its first per-Unit stage next.
const CONSTRUCTION_STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design",
  "code-generation", "build-and-test"];
const UNIT_WALK_STATE = [
  "# AI-DLC State Tracking", "",
  "## Project Information",
  "- **Project**: Add saved searches", "- **Project Type**: Greenfield", "- **Scope**: feature", "- **State Version**: 8", "",
  "## Runtime State",
  "- **Revision Count**: 0", "- **Skeleton Stance**: off", "- **Construction Iteration**: unit-major",
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

const REQUIREMENTS = "# Requirements\n\n## Functional Requirements\n\n- FR-1: Only the owner can read a saved search.\n";
const REVISED = `${REQUIREMENTS}- FR-2: The owner can delete a saved search.\n`;

// The file's lines with their endings, and which one is the summary's answer.
function lines(text: string): string[] {
  return text.split(/(?<=\n)/);
}
function summaryAnswerIndex(all: string[]): number {
  const heading = all.findIndex((line) => /^## Consolidated Summary Confirmation\r?\n?$/.test(line));
  if (heading < 0) return -1;
  return all.findIndex((line, index) => index > heading && /^\[Answer\]:/.test(line));
}
function summaryAnswer(text: string): string | null {
  const all = lines(text);
  const index = summaryAnswerIndex(all);
  return index < 0 ? null : all[index].replace(/^\[Answer\]:/, "").trim();
}
function withSummaryAnswer(text: string, answer: string): string {
  const all = lines(text);
  const index = summaryAnswerIndex(all);
  const ending = /\r?\n$/.exec(all[index])?.[0] ?? "";
  all[index] = `${`[Answer]: ${answer}`.trimEnd()}${ending}`;
  return all.join("");
}

// The questions file after the step: the summary's answer is blank, its line
// ending kept, and every other line exactly as it was.
function expectOnlySummaryCleared(before: string, after: string): void {
  const was = lines(before);
  const now = lines(after);
  const index = summaryAnswerIndex(was);
  expect(index, before).toBeGreaterThan(0);
  expect(now.length, after).toBe(was.length);
  for (let i = 0; i < was.length; i++) {
    if (i === index) continue;
    expect(now[i], `line ${i + 1} of the questions file changed`).toBe(was[i]);
  }
  expect(now[index], after).toMatch(/^\[Answer\]:[ \t]*(\r?\n)?$/);
  expect(/\r?\n$/.exec(now[index])?.[0] ?? "").toBe(/\r?\n$/.exec(was[index])?.[0] ?? "");
}

function lastJson(text: string): Json | null {
  const line = text.trim().split("\n").at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line) as Json;
  } catch {
    return null;
  }
}

function shellWords(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end);
      i = end;
      open = true;
    } else if (c === "\"") {
      let k = i + 1;
      for (; k < text.length && text[k] !== "\""; k++) word += text[k] === "\\" ? text[++k] : text[k];
      i = k;
      open = true;
    } else if (/\s/.test(c)) {
      if (open) words.push(word);
      word = "";
      open = false;
    } else {
      word += c;
      open = true;
    }
  }
  if (open) words.push(word);
  return words;
}

// Every guard-recovery ask an output carries, also one embedded in an error.
const GUARD_RECOVERY = /ask_type\\?"\s*:\s*\\?"guard-recovery/;

// The guard-recovery asks in an output that put a question to the person: an
// ask marked agent_work is the agent's own step. An ask the output names but
// that does not parse counts as a question.
function personQuestions(output: string): string[] {
  if (!GUARD_RECOVERY.test(output)) return [];
  const asks: Json[] = [];
  for (const line of output.split("\n")) {
    const parsed = lastJson(line);
    if (parsed === null) continue;
    if (parsed.ask_type === "guard-recovery") asks.push(parsed);
    if (typeof parsed.error === "string") {
      const embedded = guardRecoveryAskFromRefusalText(parsed.error);
      if (embedded !== null) asks.push(embedded as unknown as Json);
    }
  }
  if (asks.length === 0) return [output];
  return asks.filter((ask) => ask.agent_work !== true).map((ask) => JSON.stringify(ask));
}

class Work {
  readonly dir: string;
  readonly stage: string;
  readonly unit: string | null;
  readonly reviewer: string;
  readonly stageDir: string;
  readonly questions: string;
  readonly artifact: string;
  readonly env: NodeJS.ProcessEnv;
  readonly eol: string;
  readonly outputs: string[] = [];
  summaryAsks = 0;

  // Requirements Analysis of a feature in Inception, or with `unitWalk` Unit
  // alpha's Functional Design in a walk of one Unit at a time.
  constructor(options: { policy?: "strict" | "relaxed" | "off"; eol?: string; unitWalk?: boolean } = {}) {
    const { policy = "strict", eol = "\n", unitWalk = false } = options;
    this.eol = eol;
    this.dir = setupIntegrationProject(unitWalk ? {} : { withState: "state-brownfield-feature.md" });
    created.push(this.dir);
    if (unitWalk) {
      writeFileSync(seededStateFile(this.dir), UNIT_WALK_STATE);
      seedBoltDag(this.dir, [UNIT, "beta"]);
    }
    this.stage = unitWalk ? UNIT_STAGE : STAGE;
    this.unit = unitWalk ? UNIT : null;
    this.reviewer = unitWalk ? UNIT_REVIEWER : REVIEWER;
    this.stageDir = unitWalk
      ? join(seededRecordDir(this.dir), "construction", UNIT, UNIT_STAGE)
      : join(seededRecordDir(this.dir), "inception", STAGE);
    this.questions = join(this.stageDir, `${this.stage}-questions.md`);
    this.artifact = join(this.stageDir, unitWalk ? "functional-spec.md" : "requirements.md");
    this.env = {
      ...testGuardEnvironment(process.env, "production"),
      CLAUDE_PROJECT_DIR: this.dir,
      AIDLC_PROJECT_DIR: this.dir,
      AIDLC_UNATTENDED: "0",
      // The stage's checks before its review (completionChecksStep) are not
      // this file's subject, and its documents are not written for them.
      AIDLC_DISABLE_SENSORS: "1",
    };
    for (const key of HOST_ENV) delete this.env[key];
    for (const args of [
      ["init", "-q"], ["config", "user.name", "AI-DLC Fixture"], ["config", "user.email", "fixture@example.invalid"],
      ["add", "-A"], ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture baseline"],
    ]) this.ok(this.run(["git", ...args]), `git ${args[0]}`);
    const chat = mkdtempSync(join(tmpdir(), "aidlc-chat-"));
    created.push(chat);
    const transcript = join(chat, `${SESSION}.jsonl`);
    writeFileSync(transcript, "");
    this.ok(this.hook("session-start", { hook_event_name: "SessionStart", source: "startup", transcript_path: transcript }),
      "session start");
    if (!unitWalk) this.ok(this.tool("jump", ["execute", "--target", STAGE, "--direction", "redo"]), "start the stage");
    this.next();
    if (policy !== "strict") this.typedSetting(`/aidlc --guard-policy ${policy}`, ["--guard-policy", policy]);
  }

  run(argv: string[], input?: Json, extraEnv: NodeJS.ProcessEnv = {}): Run {
    const child = Bun.spawnSync(argv, {
      cwd: this.dir,
      env: { ...this.env, ...extraEnv },
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

  hook(name: string, payload: Json): Run {
    const argv = name === "record-human-turn"
      ? [BUN, join(this.dir, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"]
      : [BUN, join(this.dir, ".claude", "hooks", `aidlc-${name}.ts`)];
    return this.run(argv, { cwd: this.dir, session_id: SESSION, ...payload });
  }

  tool(name: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Run {
    const result = this.run([BUN, join(this.dir, ".claude", "tools", `aidlc-${name}.ts`), ...args, "--project-dir", this.dir],
      undefined, extraEnv);
    this.outputs.push(`${name} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
    return result;
  }

  // An engine command as a step prints it: `bun .claude/tools/<tool>.ts ...`.
  printed(command: string): Run {
    const [bun, tool, ...args] = shellWords(command.trim());
    expect(bun, command).toBe("bun");
    const argv = [BUN, join(this.dir, tool), ...args];
    if (!args.includes("--project-dir")) argv.push("--project-dir", this.dir);
    const result = this.run(argv);
    this.outputs.push(`${command}\n${result.stdout}\n${result.stderr}`);
    return result;
  }

  // The agent's file write: the PreToolUse guards admit it, then the
  // write-audit hook records it. Saving a file again unchanged is a Write.
  write(path: string, content: string): void {
    const toolName = existsSync(path) && readFileSync(path, "utf-8") !== content ? "Edit" : "Write";
    const toolInput = toolName === "Edit"
      ? { file_path: path, old_string: readFileSync(path, "utf-8"), new_string: content }
      : { file_path: path, content };
    for (const guard of PRE_GUARDS) {
      this.ok(this.hook(guard, { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput }),
        `${guard} admits the write of ${path}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    this.ok(this.hook("write-audit-log", {
      hook_event_name: "PostToolUse", tool_name: toolName, tool_input: toolInput, tool_response: { success: true },
    }), `record the write of ${path}`);
  }

  said(prompt: string): void {
    this.ok(this.hook("record-human-turn", { hook_event_name: "UserPromptSubmit", prompt }), "the person's message");
  }

  picked(question: string, labels: string[], choice: string): void {
    const questions = [{ question, options: labels.map((label) => ({ label })) }];
    this.ok(this.hook("record-human-turn", {
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion",
      tool_input: { questions }, tool_response: { questions, answers: { [question]: choice } },
    }), "the person's pick");
  }

  // `next`, through any rule parts, to the step the agent works from.
  next(args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): Json {
    let step = this.json(this.tool("orchestrate", ["next", ...args], extraEnv), `next ${args.join(" ")}`);
    for (let i = 0; step.kind === "load-steering" && i < 40; i++) {
      step = this.json(this.printed(String(step.next)), "the next rule part");
    }
    return step;
  }

  // The person types a setting; the agent runs the setter the step names.
  typedSetting(prompt: string, flags: string[]): void {
    this.said(prompt);
    const step = this.json(this.tool("orchestrate", ["next", ...flags]), prompt);
    const setter = /Run `(bun [^`]+)` to update the configuration/.exec(String(step.message))?.[1];
    expect(setter, JSON.stringify(step)).toBeDefined();
    this.ok(this.printed(setter!), `the setter for ${prompt}`);
  }

  unitArgs(): string[] {
    return this.unit === null ? [] : ["--unit", this.unit];
  }

  summaryArgs(): string[] {
    return ["--stage", this.stage, ...this.unitArgs(), "--checkpoint", "summary-confirmation",
      "--questions-file", this.questions];
  }

  // The summary question put to the person and their "Looks correct" recorded.
  confirmSummary(): void {
    this.summaryAsks++;
    const current = existsSync(this.questions) ? readFileSync(this.questions, "utf-8") : questionsBody("", this.eol);
    if (!existsSync(this.questions) || summaryAnswer(current) !== "") this.write(this.questions, withSummaryAnswer(current, ""));
    this.json(this.tool("log", ["decision", ...this.summaryArgs(), "--decision", SUMMARY_QUESTION,
      "--options", "Looks correct,Request changes"]), "record the summary question");
    this.picked(SUMMARY_QUESTION, ["Looks correct", "Request changes"], "Looks correct");
    this.write(this.questions, withSummaryAnswer(readFileSync(this.questions, "utf-8"), "Looks correct"));
    this.json(this.tool("log", ["answer", ...this.summaryArgs(), "--details", "Looks correct"]), "record the summary answer");
  }

  reviewArgs(): string[] {
    return ["review", "--stage", this.stage, "--reviewer", this.reviewer, ...this.unitArgs(), "--iteration", "1"];
  }

  requestReview(): Run {
    return this.tool("log", this.reviewArgs());
  }

  // The reviewer writes its file and the verdict is recorded.
  finishReview(request: Run): void {
    const requested = this.json(request, "request the review");
    this.write(resolve(this.dir, String(requested.reviewFile)), [
      "## Review", "", "**Verdict:** READY", `**Reviewer:** ${this.reviewer}`, "**Iteration:** 1", "",
      "### Findings", "", "No outstanding findings.", "",
    ].join("\n"));
    this.json(this.tool("log", [...this.reviewArgs(), "--verdict", "READY"]), "record the verdict");
  }

  openGate(): Json {
    return this.json(this.tool("orchestrate", ["report", "--stage", STAGE, "--result", "awaiting-approval"]),
      "open the approval gate");
  }

  // The first attempt: the summary confirmed, the requirements written, reviewed.
  firstAttempt(): void {
    this.confirmSummary();
    this.write(this.artifact, REQUIREMENTS);
    this.finishReview(this.requestReview());
  }

  approve(): void {
    this.openGate();
    this.picked("Approve the requirements?", ["Approve", "Request Changes"], "Approve");
    this.json(this.tool("orchestrate", ["report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve"]),
      "approve");
    this.next();
  }

  // The person asks for a stage. The step makes the jump and starts the stage,
  // or names the jump for the agent to run.
  jump(target: string, direction: "backward" | "forward" | "redo"): void {
    this.said(`/aidlc --stage ${target}`);
    const jumps = () => readAuditShardEvents(this.dir).filter((row) => row.event === "STAGE_JUMPED");
    const earlier = jumps().length;
    const step = this.next(["--stage", target]);
    const command = /Run `(bun [^`]+aidlc-jump\.ts execute [^`]+)`/.exec(String(step.message ?? ""))?.[1];
    if (command !== undefined) {
      expect(command).toContain(`--direction ${direction}`);
      this.ok(this.printed(command), `the jump to ${target}`);
      return;
    }
    expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage: target });
    const rows = jumps();
    expect(rows.length).toBe(earlier + 1);
    expect(auditBlockField(rows.at(-1)!.block, "Direction")).toBe(direction.toUpperCase());
  }

  questionsText(): string {
    return readFileSync(this.questions, "utf-8");
  }

  stageMark(slug = STAGE): string {
    const state = readFileSync(join(seededRecordDir(this.dir), "aidlc-state.md"), "utf-8");
    return new RegExp(`^- \\[(.)\\] ${slug} `, "m").exec(state)?.[1] ?? "(none)";
  }

  // A well-behaved agent works the step it was given: it asks the summary only
  // when the questions file shows it unanswered, keeps or revises the existing
  // documents as the person picks, has them reviewed, and opens the gate.
  followStep(step: Json, documents: "Keep" | "Modify"): void {
    expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage: STAGE });
    if (summaryAnswer(this.questionsText()) === "") this.confirmSummary();
    this.picked("Requirements Analysis already has documents. What should I do with them?",
      ["Keep", "Modify", "Redo from scratch"], documents);
    this.ok(this.tool("state", ["reuse-artifact", STAGE, "--decision", documents.toLowerCase(),
      "--artifacts", "requirements.md,requirements-analysis-questions.md"]), "record the re-use choice");
    if (documents === "Modify") this.write(this.artifact, REVISED);
    this.finishReview(this.requestReview());
    expect(this.openGate().kind).toBe("print");
  }

  expectNoGuardQuestion(since: number): void {
    expect(this.outputs.slice(since).flatMap(personQuestions)).toEqual([]);
  }

  // Unit alpha's Functional Design: started, summary confirmed (when the file
  // shows it unanswered), documents saved, reviewed, completed.
  unitStep(): void {
    this.ok(this.tool("state", ["unit", "start", "--stage", this.stage, "--unit", UNIT]), "start the Unit's step");
    if (!existsSync(this.questions) || summaryAnswer(this.questionsText()) === "") this.confirmSummary();
    for (const name of UNIT_DOCUMENTS) {
      this.write(join(this.stageDir, name), name.endsWith(".json")
        ? `${JSON.stringify({ version: 1, unit: UNIT, attempt: this.summaryAsks })}\n`
        : `# ${name}\n\nSaved searches for ${UNIT}, pass ${this.summaryAsks}.\n`);
    }
    this.finishReview(this.requestReview());
    this.ok(this.tool("state", ["unit", "complete", "--stage", this.stage, "--unit", UNIT]), "complete the Unit's step");
  }
}

describe("t-jump-back-asks-summary-once: going back to a confirmed stage asks its summary once", () => {
  for (const eol of ["\n", "\r\n"]) {
    test(`after a jump back the step clears only the summary's answer (${eol === "\n" ? "LF" : "CRLF"} file)`, () => {
      const work = new Work({ eol });
      work.firstAttempt();
      work.approve();
      const before = work.questionsText();
      expect(summaryAnswer(before)).toBe("Looks correct");
      work.jump(STAGE, "backward");
      const step = work.next();
      expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage: STAGE });
      expect(String((step.questions_answered as Json | undefined)?.path)).toEndWith(`${STAGE}/${STAGE}-questions.md`);
      expectOnlySummaryCleared(before, work.questionsText());
    });
  }

  for (const policy of ["strict", "relaxed", "off"] as const) {
    test(`following the step after a jump back reaches the gate with no guard question (Guard Policy ${policy})`, () => {
      const work = new Work({ policy });
      work.firstAttempt();
      work.approve();
      const since = work.outputs.length;
      work.jump(STAGE, "backward");
      work.followStep(work.next(), "Modify");
      work.expectNoGuardQuestion(since);
      expect(work.summaryAsks).toBe(2);
      expect(work.stageMark()).toBe("?");
    });
  }

  test("a restart of the stage asks the summary once and reaches the gate", () => {
    const work = new Work();
    work.firstAttempt();
    const before = work.questionsText();
    const since = work.outputs.length;
    work.jump(STAGE, "redo");
    const step = work.next();
    expectOnlySummaryCleared(before, work.questionsText());
    work.followStep(step, "Modify");
    work.expectNoGuardQuestion(since);
    expect(work.summaryAsks).toBe(2);
    expect(work.stageMark()).toBe("?");
  });

  test("resuming after a jump back asks the summary once and reaches the gate", () => {
    const work = new Work();
    work.firstAttempt();
    work.approve();
    const before = work.questionsText();
    const since = work.outputs.length;
    work.jump(STAGE, "backward");
    const step = work.next(["--resume"]);
    expectOnlySummaryCleared(before, work.questionsText());
    work.followStep(step, "Modify");
    work.expectNoGuardQuestion(since);
    expect(work.summaryAsks).toBe(2);
    expect(work.stageMark()).toBe("?");
  });

  test("a reply the person gave since going back is kept", () => {
    const work = new Work();
    work.firstAttempt();
    work.approve();
    work.jump(STAGE, "backward");
    work.next();
    // The summary question is put again and answered, and the chat ends before
    // the answer is recorded.
    const current = work.questionsText();
    if (summaryAnswer(current) !== "") work.write(work.questions, withSummaryAnswer(current, ""));
    work.json(work.tool("log", ["decision", ...work.summaryArgs(), "--decision", SUMMARY_QUESTION,
      "--options", "Looks correct,Request changes"]), "record the summary question");
    work.picked(SUMMARY_QUESTION, ["Looks correct", "Request changes"], "Looks correct");
    work.write(work.questions, withSummaryAnswer(work.questionsText(), "Looks correct"));
    const answered = work.questionsText();
    expect(work.next()).toMatchObject({ kind: "run-stage", stage: STAGE });
    expect(work.questionsText()).toBe(answered);
  });

  test("with summary confirmation turned off the file is left as it is", () => {
    const work = new Work();
    work.firstAttempt();
    work.approve();
    work.typedSetting("/aidlc --summary-confirmation off", ["--summary-confirmation", "off"]);
    const before = work.questionsText();
    work.jump(STAGE, "backward");
    const step = work.next();
    expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage: STAGE });
    expect((step.ceremony as Json).summary_confirmation).toBe("off");
    expect(work.questionsText()).toBe(before);
  });

  test("the Stop hook's read-only probe leaves the file as it is", () => {
    const work = new Work();
    work.firstAttempt();
    work.approve();
    // The jump itself, with no step after it, so the probe is the first to see
    // the earlier answer.
    work.ok(work.tool("jump", ["execute", "--target", STAGE, "--direction", "backward"]), "the jump back");
    const before = work.questionsText();
    expect(summaryAnswer(before)).toBe("Looks correct");
    work.json(work.tool("orchestrate", ["next"], { AIDLC_STOP_HOOK_PROBE: "1" }), "the Stop hook's probe");
    expect(work.questionsText()).toBe(before);
  });

  test("a jump forward, past the confirmed stage, leaves its file as it is", () => {
    const work = new Work();
    work.firstAttempt();
    work.approve();
    const before = work.questionsText();
    work.jump("domain-design", "forward");
    const step = work.next();
    expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage: "domain-design" });
    expect(work.questionsText()).toBe(before);
  });

  // Keeping the documents: the summary is confirmed once in the new attempt,
  // and Keep records the kept requirements.md under that confirmation, so the
  // review runs with no save and no refusal, and the gate opens.
  test("keeping the documents after a jump back: the review runs with no save and the gate opens", () => {
    const work = new Work();
    work.firstAttempt();
    work.approve();
    const since = work.outputs.length;
    work.jump(STAGE, "backward");
    work.next();
    work.confirmSummary();
    work.picked("Requirements Analysis already has documents. What should I do with them?",
      ["Keep", "Modify", "Redo from scratch"], "Keep");
    work.ok(work.tool("state", ["reuse-artifact", STAGE, "--decision", "keep",
      "--artifacts", "requirements.md,requirements-analysis-questions.md"]), "record the re-use choice");
    work.finishReview(work.requestReview());
    expect(work.openGate().kind).toBe("print");
    work.expectNoGuardQuestion(since);
    expect(work.summaryAsks).toBe(2);
    expect(work.stageMark()).toBe("?");
  });

  test("a Unit reopened by a jump back keeps its confirmed summary and finishes its step with no question", () => {
    const work = new Work({ unitWalk: true });
    work.unitStep();
    expect(work.next()).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: UNIT });
    const before = work.questionsText();
    expect(summaryAnswer(before)).toBe("Looks correct");
    // A jump back to a step the Unit finished reopens it for that Unit.
    work.said(`/aidlc --stage ${UNIT_STAGE}`);
    const back = work.json(work.tool("orchestrate", ["next", "--stage", UNIT_STAGE]), "next --stage");
    const reopen = /Run `(bun [^`]+aidlc-jump\.ts reopen [^`]+)`/.exec(String(back.message))?.[1];
    expect(reopen, JSON.stringify(back)).toBeDefined();
    expect(reopen).toContain(`--units ${UNIT}`);
    work.ok(work.printed(reopen!), "reopen the Unit's step");
    const since = work.outputs.length;
    const step = work.next();
    expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage: UNIT_STAGE, unit: UNIT });
    expect(work.questionsText()).toBe(before);
    work.unitStep();
    expect(work.next()).toMatchObject({ kind: "run-stage", stage: "nfr-requirements", unit: UNIT });
    work.expectNoGuardQuestion(since);
    expect(work.summaryAsks).toBe(1);
  });
});
