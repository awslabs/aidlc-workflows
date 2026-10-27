// covers: subcommand:aidlc-state:reuse-artifact, function:checkSummaryConfirmationEvidence, audit:ARTIFACT_REUSED
//
// After going back to a stage, the person is asked its summary first and then
// picks Keep for the documents it already has. Keep itself records the kept
// documents under that confirmation, so the review starts with no save the
// host may not record and no "can't go ahead" question: on Kiro IDE, where an
// unchanged save leaves no record, as on Claude Code and Codex. A kept
// document changed after Keep, or a Keep picked before the summary was
// confirmed, goes back under today's checks. Under relaxed no "saved before
// you confirmed" line follows Keep. With summary confirmation off, or its
// check switched off, Keep records what it did before. On a stage that runs
// for each Unit, Keep for one Unit binds that Unit's documents only. In a run of
// the stage on its own, Keep binds that run's confirmation, which the main run
// does not take as its own. Runs the shipped tools and each host's own write
// path with production guards.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupTestProject, REPO_ROOT, seedBoltDag, seededRecordDir, seededStateFile, setupIntegrationProject,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  auditBlockField,
  guardRecoveryAskFromRefusalText,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const SESSION = "01995000-0995-7000-8000-000000000955";
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const UNIT_STAGE = "functional-design";
const UNIT_REVIEWER = "aidlc-architecture-reviewer-agent";
const UNIT_DOCUMENTS = ["entities.md", "rules.md", "functional-spec.md", "traceability.json"];
const SUMMARY_QUESTION = "Does this all look correct before I generate the artifact?";
const REUSE_QUESTION = "This stage already has documents. What should I do with them?";
const SAVED_UNDER_ANOTHER = "was last saved under a different summary confirmation";
const SAVED_BEFORE_NOTICE = "was saved before you confirmed the current summary";
const PRE_GUARDS = ["state-transition-guard", "reviewer-scope", "review-freeze", "plan-approval-guard"] as const;
// The host's own session and probe markers would point the tools at another chat.
const HOST_ENV = [
  "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "AIDLC_STOP_HOOK_PROBE", "AWS_AIDLC_DEFAULT_SCOPE",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CONFIG_DIR", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "USER_PROMPT",
];

type Host = "claude" | "kiro-ide" | "codex";
type Json = Record<string, unknown>;
type Run = { code: number; stdout: string; stderr: string };

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function questionsBody(answer: string): string {
  return [
    "# Questions", "",
    "## Question 1", "Who can read a saved search?", "",
    "A) Only the owner", "B) The team", "X) Other (please specify)", "",
    "[Answer]: A", "",
    "## Consolidated Summary Confirmation", "",
    "- Only the owner can read a saved search.", "",
    "- Looks correct", "- Request changes", "",
    `[Answer]: ${answer}`.trimEnd(), "",
  ].join("\n");
}

const REQUIREMENTS = "# Requirements\n\n## Functional Requirements\n\n- FR-1: Only the owner can read a saved search.\n";

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

function summaryAnswer(text: string): string | null {
  const at = text.indexOf("## Consolidated Summary Confirmation");
  if (at < 0) return null;
  return /^\[Answer\]:([^\r\n]*)$/m.exec(text.slice(at))?.[1].trim() ?? null;
}

function withSummaryAnswer(text: string, answer: string): string {
  const at = text.indexOf("## Consolidated Summary Confirmation");
  return text.slice(0, at) + text.slice(at).replace(/^\[Answer\]:[^\r\n]*/m, `[Answer]: ${answer}`.trimEnd());
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
  readonly host: Host;
  readonly stage: string;
  readonly reviewer: string;
  readonly stageDir: string;
  readonly questions: string;
  readonly artifact: string;
  readonly env: NodeJS.ProcessEnv;
  readonly outputs: string[] = [];
  readonly unit: string | null;
  summaryAsks = 0;
  authorization: string | null = null;

  // Requirements Analysis of a feature in Inception, or with `unitWalk` Unit
  // alpha's Functional Design in a walk of one Unit at a time. Each write goes
  // through `host`'s own write path.
  constructor(options: { policy?: "strict" | "relaxed"; host?: Host; unitWalk?: boolean } = {}) {
    const { policy = "strict", host = "claude", unitWalk = false } = options;
    this.host = host;
    this.dir = setupIntegrationProject(unitWalk ? {} : { withState: "state-brownfield-feature.md" });
    created.push(this.dir);
    if (host === "kiro-ide") cpSync(join(REPO_ROOT, "dist", "kiro-ide", ".kiro"), join(this.dir, ".kiro"), { recursive: true });
    if (host === "codex") cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(this.dir, ".codex"), { recursive: true });
    if (unitWalk) {
      writeFileSync(seededStateFile(this.dir), UNIT_WALK_STATE);
      seedBoltDag(this.dir, ["alpha", "beta"]);
    }
    this.stage = unitWalk ? UNIT_STAGE : STAGE;
    this.unit = unitWalk ? "alpha" : null;
    this.reviewer = unitWalk ? UNIT_REVIEWER : REVIEWER;
    this.stageDir = unitWalk
      ? join(seededRecordDir(this.dir), "construction", "alpha", UNIT_STAGE)
      : join(seededRecordDir(this.dir), "inception", STAGE);
    this.questions = join(this.stageDir, `${this.stage}-questions.md`);
    this.artifact = join(this.stageDir, unitWalk ? "functional-spec.md" : "requirements.md");
    this.env = {
      ...testGuardEnvironment(process.env, "production"),
      CLAUDE_PROJECT_DIR: this.dir,
      AIDLC_PROJECT_DIR: this.dir,
      AIDLC_UNATTENDED: "0",
      AIDLC_COMPILED_EXECUTABLE: "",
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

  // The agent's file write, recorded the way its host records one. Claude
  // Code: the PreToolUse guards, then the write-audit hook. Kiro IDE: the guard
  // card notes the write, and the next card records it when the file changed.
  // Codex: the guard and then the after-call hook, both with an apply_patch.
  write(path: string, content: string): void {
    const before = existsSync(path) ? readFileSync(path, "utf-8") : null;
    if (this.host === "kiro-ide") {
      const card = (target: string, payload: Json) =>
        this.run([BUN, join(this.dir, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), target], { cwd: this.dir, session_id: SESSION, ...payload });
      this.ok(card("guard-tool-call", { hook_event_name: "PreToolUse", tool_name: "fs_write", tool_input: { path, text: content } }),
        `the guard card admits the write of ${path}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      this.ok(card("guard-tool-call", { hook_event_name: "PreToolUse", tool_name: "execute_pwsh", tool_input: { command: "node --version", cwd: this.dir } }),
        "the next card");
      return;
    }
    if (this.host === "codex") {
      const rel = relative(this.dir, path).replaceAll("\\", "/");
      const added = content.split("\n").map((line) => `+${line}`);
      const command = [
        "*** Begin Patch",
        ...(before === null
          ? [`*** Add File: ${rel}`, ...added]
          : [`*** Update File: ${rel}`, "@@", ...before.split("\n").map((line) => `-${line}`), ...added]),
        "*** End Patch",
      ].join("\n");
      const ids = { turn_id: randomUUID(), tool_use_id: randomUUID() };
      const adapter = (target: string, payload: Json) =>
        this.run([BUN, join(this.dir, ".codex", "hooks", "aidlc-codex-adapter.ts"), target], { cwd: this.dir, session_id: SESSION, ...ids, ...payload });
      this.ok(adapter("guard-tool-call", { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command } }),
        `the guard admits the patch of ${path}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      this.ok(adapter("audit-and-sensors", {
        hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command }, tool_response: { success: true },
      }), `record the patch of ${path}`);
      return;
    }
    const toolName = before !== null && before !== content ? "Edit" : "Write";
    const toolInput = toolName === "Edit"
      ? { file_path: path, old_string: before, new_string: content }
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
  next(args: string[] = []): Json {
    let step = this.json(this.tool("orchestrate", ["next", ...args]), `next ${args.join(" ")}`);
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

  // The summary question put to the person and their "Looks correct"
  // recorded, in the main run or with `single` in an isolated run.
  confirmSummary(single = false): void {
    this.summaryAsks++;
    const isolated = single ? ["--single"] : [];
    const current = existsSync(this.questions) ? readFileSync(this.questions, "utf-8") : questionsBody("");
    if (!existsSync(this.questions) || summaryAnswer(current) !== "") this.write(this.questions, withSummaryAnswer(current, ""));
    this.json(this.tool("log", ["decision", ...this.summaryArgs(), ...isolated, "--decision", SUMMARY_QUESTION,
      "--options", "Looks correct,Request changes"]), "record the summary question");
    this.picked(SUMMARY_QUESTION, ["Looks correct", "Request changes"], "Looks correct");
    this.write(this.questions, withSummaryAnswer(readFileSync(this.questions, "utf-8"), "Looks correct"));
    const receipt = this.json(this.tool("log", ["answer", ...this.summaryArgs(), ...isolated, "--details", "Looks correct"]),
      "record the summary answer");
    this.authorization = String(receipt.summary_authorization_id);
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

  // Requirements Analysis confirmed, written, reviewed and approved, then the
  // person goes back to it, and the agent takes the step that follows.
  approvedThenBack(): Json {
    this.confirmSummary();
    this.write(this.artifact, REQUIREMENTS);
    this.finishReview(this.requestReview());
    this.openGate();
    this.picked("Approve the requirements?", ["Approve", "Request Changes"], "Approve");
    this.json(this.tool("orchestrate", ["report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve"]),
      "approve");
    this.next();
    return this.back();
  }

  // The person goes back to the stage: the step makes the jump and starts the
  // stage, or names the jump or reopen for the agent to run.
  back(): Json {
    this.said(`/aidlc --stage ${this.stage}`);
    const step = this.next(["--stage", this.stage]);
    const command = /Run `(bun [^`]+aidlc-jump\.ts (?:execute|reopen) [^`]+)`/.exec(String(step.message ?? ""))?.[1];
    if (command === undefined) {
      expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage: this.stage });
    } else {
      this.ok(this.printed(command), `the jump back to ${this.stage}`);
    }
    return this.next();
  }

  // The person picks Keep for the documents the stage already has.
  keep(extra: string[] = [], extraEnv: NodeJS.ProcessEnv = {}): Run {
    this.picked(REUSE_QUESTION, ["Keep", "Modify", "Redo from scratch"], "Keep");
    const artifacts = this.stage === STAGE ? "requirements.md,requirements-analysis-questions.md" : UNIT_DOCUMENTS.join(",");
    return this.ok(this.tool("state", ["reuse-artifact", this.stage, "--decision", "keep", "--artifacts", artifacts, ...extra],
      extraEnv), "record Keep");
  }

  keepRow(): { block: string } {
    const rows = readAuditShardEvents(this.dir).filter((row) =>
      row.event === "ARTIFACT_REUSED" && auditBlockField(row.block, "Stage") === this.stage);
    expect(rows.length).toBeGreaterThan(0);
    return rows.at(-1)!;
  }

  writeRows(path = this.artifact): number {
    const suffix = relative(this.dir, path).replaceAll("\\", "/");
    return readAuditShardEvents(this.dir).filter((row) =>
      (row.event === "ARTIFACT_CREATED" || row.event === "ARTIFACT_UPDATED") &&
      (auditBlockField(row.block, "File") ?? "").replaceAll("\\", "/").endsWith(suffix)).length;
  }

  stageMark(): string {
    const state = readFileSync(join(seededRecordDir(this.dir), "aidlc-state.md"), "utf-8");
    return new RegExp(`^- \\[(.)\\] ${this.stage} `, "m").exec(state)?.[1] ?? "(none)";
  }

  expectNoPersonQuestion(since: number): void {
    expect(this.outputs.slice(since).flatMap(personQuestions)).toEqual([]);
  }

  // The review request's refusal: its words and the ask it carries.
  refusal(run: Run): { error: string; ask: Json | null } {
    expect(run.code, run.stdout).not.toBe(0);
    const error = String(lastJson(run.stderr)?.error ?? run.stderr);
    return { error, ask: guardRecoveryAskFromRefusalText(error) as unknown as Json | null };
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// After going back, the summary asked once and confirmed, then Keep, and the
// review runs on the kept documents with nothing saved again.
function keptReviewStarts(work: Work): void {
  const since = work.outputs.length;
  const step = work.approvedThenBack();
  expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage: STAGE });
  expect(summaryAnswer(readFileSync(work.questions, "utf-8"))).toBe("");
  work.confirmSummary();
  const writes = work.writeRows();
  work.keep();
  expect(work.writeRows()).toBe(writes);
  const request = work.requestReview();
  expect(request.code, `${request.stdout}\n${request.stderr}`).toBe(0);
  work.finishReview(request);
  expect(work.openGate().kind).toBe("print");
  expect(work.writeRows()).toBe(writes);
  work.expectNoPersonQuestion(since);
  expect(work.summaryAsks).toBe(2);
  expect(work.stageMark()).toBe("?");
}

describe("t-keep-records-kept-documents: Keep after going back records the kept documents under the new confirmation", () => {
  for (const host of ["kiro-ide", "claude", "codex"] as const) {
    test(`${host}: after the summary and Keep the review starts with no save and no question`, () => {
      keptReviewStarts(new Work({ host }));
    });
  }

  test("the Keep row names the current confirmation and each kept document's sha256, and writes no write row", () => {
    const work = new Work();
    work.approvedThenBack();
    work.confirmSummary();
    const writes = work.writeRows();
    work.keep();
    expect(work.writeRows()).toBe(writes);
    const row = work.keepRow();
    expect(auditBlockField(row.block, "Summary Authorization Id")).toBe(work.authorization);
    const kept = auditBlockField(row.block, "Kept Outputs") ?? "";
    expect(kept).toContain("inception/requirements-analysis/requirements.md");
    expect(kept).toMatch(/\b[0-9a-f]{64}\b/);
    expect(kept).toContain(sha256(readFileSync(work.artifact, "utf-8").replace(/\r\n/g, "\n")));
  });

  test("a kept document changed after Keep, with no write recorded, goes back under today's check", () => {
    const work = new Work();
    work.approvedThenBack();
    work.confirmSummary();
    work.keep();
    writeFileSync(work.artifact, `${REQUIREMENTS}- FR-2: Saved searches can be shared.\n`);
    const { error } = work.refusal(work.requestReview());
    expect(error).toContain(SAVED_UNDER_ANOTHER);
  });

  test("a Keep picked before the summary was confirmed counts for nothing", () => {
    const work = new Work();
    work.approvedThenBack();
    work.keep();
    work.confirmSummary();
    const { error } = work.refusal(work.requestReview());
    expect(error).toContain(SAVED_UNDER_ANOTHER);
  });

  test("relaxed: after the summary and Keep the review carries no saved-before line", () => {
    const work = new Work({ policy: "relaxed" });
    work.approvedThenBack();
    work.confirmSummary();
    work.keep();
    const request = work.requestReview();
    expect(request.code, request.stderr).toBe(0);
    expect(`${request.stdout}\n${request.stderr}`).not.toContain(SAVED_BEFORE_NOTICE);
  });

  test("with summary confirmation off, Keep records what it did before", () => {
    const work = new Work();
    work.confirmSummary();
    work.write(work.artifact, REQUIREMENTS);
    work.finishReview(work.requestReview());
    work.openGate();
    work.picked("Approve the requirements?", ["Approve", "Request Changes"], "Approve");
    work.json(work.tool("orchestrate", ["report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve"]),
      "approve");
    work.next();
    work.typedSetting("/aidlc --summary-confirmation off", ["--summary-confirmation", "off"]);
    work.back();
    work.keep();
    expect(auditBlockField(work.keepRow().block, "Summary Authorization Id")).toBeNull();
  });

  test("with the summary confirmation check switched off, Keep records what it did before", () => {
    const work = new Work();
    work.approvedThenBack();
    work.confirmSummary();
    work.keep([], { AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" });
    expect(auditBlockField(work.keepRow().block, "Summary Authorization Id")).toBeNull();
  });

  test("a kept document whose line ends turn to CRLF after Keep (a teammate's clone) still counts", () => {
    const work = new Work();
    work.approvedThenBack();
    work.confirmSummary();
    work.keep();
    writeFileSync(work.artifact, readFileSync(work.artifact, "utf-8").replace(/\n/g, "\r\n"));
    const request = work.requestReview();
    expect(request.code, `${request.stdout}\n${request.stderr}`).toBe(0);
  });

  test("on a stage that runs for each Unit, Keep for one Unit binds that Unit's documents only", () => {
    const work = new Work({ unitWalk: true });
    work.ok(work.tool("state", ["unit", "start", "--stage", UNIT_STAGE, "--unit", "alpha"]), "start alpha's step");
    work.confirmSummary();
    for (const name of UNIT_DOCUMENTS) work.write(join(work.stageDir, name), `# ${name}\n\nalpha\n`);
    work.finishReview(work.requestReview());
    work.ok(work.tool("state", ["unit", "complete", "--stage", UNIT_STAGE, "--unit", "alpha"]), "complete alpha's step");
    work.next();
    work.back();
    // beta's documents for the same stage are on disk too.
    const betaDir = join(seededRecordDir(work.dir), "construction", "beta", UNIT_STAGE);
    mkdirSync(betaDir, { recursive: true });
    writeFileSync(join(betaDir, `${UNIT_STAGE}-questions.md`), questionsBody("Looks correct"));
    for (const name of UNIT_DOCUMENTS) writeFileSync(join(betaDir, name), `# ${name}\n\nbeta\n`);
    work.keep(["--unit", "alpha"]);
    const kept = auditBlockField(work.keepRow().block, "Kept Outputs") ?? "";
    expect(kept).toContain(`construction/alpha/${UNIT_STAGE}/functional-spec.md`);
    expect(kept).not.toContain("construction/beta/");
    work.keep();
    const bare = work.keepRow().block;
    expect(auditBlockField(bare, "Kept Outputs")).toBeNull();
    expect(auditBlockField(bare, "Summary Authorization Id")).toBeNull();
  });

  test("in an isolated run, Keep binds the isolated confirmation, which the main run does not take as its own", () => {
    const work = new Work();
    work.approvedThenBack();
    // The person runs Requirements Analysis on its own, confirms its summary
    // there and keeps the documents.
    work.said(`/aidlc --stage ${STAGE} --single`);
    const isolated = work.next(["--stage", STAGE, "--single"]);
    expect(isolated, JSON.stringify(isolated)).toMatchObject({ kind: "run-stage", stage: STAGE });
    work.confirmSummary(true);
    const isolatedId = work.authorization;
    work.keep(["--single"]);
    const row = work.keepRow().block;
    expect(auditBlockField(row, "Workflow")).toBe(`single-stage:${STAGE}`);
    expect(auditBlockField(row, "Summary Authorization Id")).toBe(isolatedId);
    expect(auditBlockField(row, "Kept Outputs") ?? "").toContain("inception/requirements-analysis/requirements.md");
    // Back in the main run, its own confirmation mints another id, and the
    // isolated Keep does not stand in for one.
    work.confirmSummary();
    expect(work.authorization).not.toBe(isolatedId);
    const { error } = work.refusal(work.requestReview());
    expect(error).toContain(SAVED_UNDER_ANOTHER);
  });

  // Unit alpha's Functional Design is done in the walk; the person then runs
  // that stage on its own, confirms its summary there and keeps alpha's
  // documents. The isolated step names no Unit (or only {unit-name}), so the
  // Keep names none, the placeholder, or the Unit itself; each binds the
  // isolated confirmation, never the one the walk left for alpha. The last
  // case first turns summary confirmation off for the main run, which the
  // isolated run, asking its summary from its own scope, does not read.
  for (const [named, unitFlag, mainOff] of [["no Unit", [], false],
    ["the {unit-name} placeholder", ["--unit", "{unit-name}"], false], ["the Unit itself", ["--unit", "alpha"], false],
    ["no Unit, summary confirmation off for the main run", [], true]] as const) {
    test(`kiro-ide: in an isolated run of a stage that runs for each Unit, Keep with ${named} binds that Unit's documents and the review starts`, () => {
      const work = new Work({ unitWalk: true, host: "kiro-ide" });
      work.ok(work.tool("state", ["unit", "start", "--stage", UNIT_STAGE, "--unit", "alpha"]), "start alpha's step");
      work.confirmSummary();
      const walkId = work.authorization;
      for (const name of UNIT_DOCUMENTS) work.write(join(work.stageDir, name), `# ${name}\n\nalpha\n`);
      work.finishReview(work.requestReview());
      work.ok(work.tool("state", ["unit", "complete", "--stage", UNIT_STAGE, "--unit", "alpha"]), "complete alpha's step");
      work.next();
      if (mainOff) work.typedSetting("/aidlc --summary-confirmation off", ["--summary-confirmation", "off"]);
      work.said(`/aidlc --stage ${UNIT_STAGE} --single`);
      const isolated = work.next(["--stage", UNIT_STAGE, "--single"]);
      expect(isolated, JSON.stringify(isolated)).toMatchObject({ kind: "run-stage", stage: UNIT_STAGE, single: true });
      expect(isolated.unit ?? "{unit-name}").toBe("{unit-name}");
      // The isolated summary is recorded for its questions file with no Unit.
      const single = ["--stage", UNIT_STAGE, "--checkpoint", "summary-confirmation", "--questions-file", work.questions, "--single"];
      work.write(work.questions, withSummaryAnswer(readFileSync(work.questions, "utf-8"), ""));
      work.json(work.tool("log", ["decision", ...single, "--decision", SUMMARY_QUESTION, "--options", "Looks correct,Request changes"]),
        "record the isolated summary question");
      work.picked(SUMMARY_QUESTION, ["Looks correct", "Request changes"], "Looks correct");
      work.write(work.questions, withSummaryAnswer(readFileSync(work.questions, "utf-8"), "Looks correct"));
      const receipt = work.json(work.tool("log", ["answer", ...single, "--details", "Looks correct"]), "record the isolated answer");
      const isolatedId = String(receipt.summary_authorization_id);
      const writes = work.writeRows();
      work.keep(["--single", ...unitFlag]);
      const row = work.keepRow().block;
      expect(auditBlockField(row, "Summary Authorization Id")).toBe(isolatedId);
      expect(isolatedId).not.toBe(walkId);
      const kept = auditBlockField(row, "Kept Outputs") ?? "";
      expect(kept).toContain(`construction/alpha/${UNIT_STAGE}/functional-spec.md`);
      expect(kept).not.toContain("construction/beta/");
      const request = work.tool("log", ["review", "--stage", UNIT_STAGE, "--reviewer", UNIT_REVIEWER, "--single", "--iteration", "1"]);
      expect(request.code, `${request.stdout}\n${request.stderr}`).toBe(0);
      expect(work.writeRows()).toBe(writes);
    });
  }
});
