// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-log:answer, subcommand:aidlc-orchestrate:report
// covers: function:shownHere, function:shownAgainFields, function:gateQuestion, audit:QUESTION_SHOWN
// covers: function:openPlanQuestionReplyDirective, function:openGateReplyDirective
//
// Live on Codex the code plan question was put in one chat and left open; in a
// new chat the person typed "carry on with the work", and the agent recorded
// "Approve Plan" on those words and built the code with no question on that
// screen. The same at a stage approval. The engine's print had handed it the
// record command for a reply from a chat the record says never showed the
// question.
//
// In a chat that has not shown the open question as it stands, the person's
// words get the question first: the print names a bare `next`, not the record
// step, the words are taken back from the plan question's kept replies, and the
// bare `next` puts the question there and records that it did, so the pick made
// with it on screen records and nothing is put a third time. The showing chat,
// a resume included, gets today's print; a question the record cannot place
// gets today's print too. Runs the shipped tools and hooks with production guards.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { cleanupTestProject, FIXTURES_DIR, seededRecordDir, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS * 2);

const BUN = process.execPath;
const A = "01995000-3791-7000-8000-00000000a001";
const B = "01995000-3791-7000-8000-00000000b002";
const GATE_STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const SUMMARY_QUESTION = "Does this all look correct before I generate the artifact?";
const FINISHED_ELSEWHERE = "This was finished in your other chat; here it is to approve.";
const HOST_ENV = [
  "AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "AIDLC_STOP_HOOK_PROBE", "AWS_AIDLC_DEFAULT_SCOPE",
  "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID", "CLAUDE_CONFIG_DIR",
];
const PRE_GUARDS = ["state-transition-guard", "reviewer-scope", "review-freeze", "plan-approval-guard"] as const;
const RECORD_STEP = "--checkpoint plan-approval";
const TODAY_PLAN = "The code plan question is open, and the person's reply may answer it.";
const TODAY_GATE = `Stage "${GATE_STAGE}" is waiting for the person's approval, and their reply may answer it.`;

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

class Folder {
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(state: "code-generation" | "inception") {
    this.dir = setupIntegrationProject({ withState: "state-brownfield-feature.md" });
    created.push(this.dir);
    if (state === "code-generation") this.planWaits();
    this.cloneIs("clone0001", "zzzz");
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
    ]) this.ok(this.run(["git", ...args], null), `git ${args[0]}`);
  }

  // Code Generation's plan written, waiting for the code plan question.
  private planWaits(): void {
    const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
      .replace("- **Scope**: feature", "- **Scope**: poc")
      .replace("- **Change Control**: strict (from scope feature)",
        "- **Guard Policy**: relaxed (from scope poc)\n- **Plan Approval**: on (set by you)")
      .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
    writeFileSync(seededStateFile(this.dir), state, "utf-8");
    mkdirSync(join(this.dir, "src"), { recursive: true });
    writeFileSync(join(this.dir, "src", "base.ts"), "export const base = true;\n", "utf-8");
    const dir = this.planDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "code-generation-plan.md"), this.planText("- Tests: 3 unit tests"));
    writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n");
  }

  // This checkout's clone id: its rows go to the shard `<host>-<token>.md`, read in name order.
  cloneIs(token: string, host: string): void {
    writeFileSync(join(this.dir, "aidlc", ".aidlc-clone-id"), `${token}\n${host}\n`);
  }

  planDir(): string {
    return join(seededRecordDir(this.dir), "construction", "code-generation");
  }

  planText(tests: string): string {
    return "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `${tests}\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n${renderTestingContract(resolveTestingPosture(this.dir))}`;
  }

  // A command in `chat` (null: a command whose host names no chat).
  run(argv: string[], chat: string | null, input?: Json): Run {
    const named = chat === null ? {} : { AIDLC_SESSION_OVERRIDE: chat, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" };
    const child = Bun.spawnSync(argv, {
      cwd: this.dir,
      env: { ...this.env, ...named },
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

  rows(event: string) {
    return readAuditShardEvents(this.dir).filter((row) => row.event === event);
  }

  shownIn(chat: string | null): number {
    return this.rows("QUESTION_SHOWN").filter((row) => auditBlockField(row.block, "Question Chat") === chat).length;
  }
}

class Chat {
  constructor(readonly folder: Folder, readonly id: string | null) {}

  // An engine command as the agent runs it; `next` reads the project from its folder, as words may follow it.
  tool(name: string, args: string[]): Run {
    const dir = name === "orchestrate" ? [] : ["--project-dir", this.folder.dir];
    return this.folder.run([BUN, join(this.folder.dir, ".claude", "tools", `aidlc-${name}.ts`), ...args, ...dir], this.id);
  }

  // The chat opens: the host's session-start hook, with its payload naming the chat.
  start(): Chat {
    if (this.id === null) return this;
    const transcripts = mkdtempSync(join(tmpdir(), "aidlc-chat-"));
    created.push(transcripts);
    const transcript = join(transcripts, `${this.id}.jsonl`);
    writeFileSync(transcript, "");
    this.folder.ok(this.folder.run([BUN, join(this.folder.dir, ".claude", "hooks", "aidlc-session-start.ts")], this.id, {
      cwd: this.folder.dir, session_id: this.id, hook_event_name: "SessionStart", source: "startup", transcript_path: transcript,
    }), "session start");
    return this;
  }

  // `next` as the agent runs it, through the rule parts a new chat gets first.
  next(args: string[] = []): Json {
    let step = this.folder.json(this.tool("orchestrate", ["next", ...args]), `next ${args.join(" ")}`);
    for (let i = 0; step.kind === "load-steering" && i < 40; i++) {
      const [, tool, ...rest] = String(step.next).trim().split(/\s+/);
      step = this.folder.json(this.folder.run([BUN, join(this.folder.dir, tool), ...rest], this.id), "rule part");
    }
    return step;
  }

  // A host hook, its payload naming the chat.
  hook(name: string, payload: Json): Run {
    return this.folder.run([BUN, join(this.folder.dir, ".claude", "hooks", `aidlc-${name}.ts`)], this.id, {
      cwd: this.folder.dir, ...(this.id ? { session_id: this.id } : {}), ...payload,
    });
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

  // The person's message, as the human-turn hook records it (its payload names the chat).
  said(prompt: string): void {
    const argv = [BUN, join(this.folder.dir, ".claude", "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"];
    this.folder.ok(this.folder.run(argv, this.id, {
      cwd: this.folder.dir, hook_event_name: "UserPromptSubmit", prompt, ...(this.id ? { session_id: this.id } : {}),
    }), `the person's message: ${prompt}`);
  }

  // The person types `/aidlc <words>` and the agent runs `next` with them.
  reply(words: string): string {
    this.said(`/aidlc ${words}`);
    const step = this.next([words]);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    return String(step.message);
  }

  approvePlan(): Run {
    return this.tool("log", ["answer", "--stage", "code-generation", "--checkpoint", "plan-approval", "--details", "Approve Plan"]);
  }
}

// The code plan question put by `next` in chat A. Unstarted, no session-start
// hook maps this process tree to a chat, so a command naming none names none.
function planAskedIn(id: string | null, started = true): { folder: Folder; first: Chat } {
  const folder = new Folder("code-generation");
  const first = started ? new Chat(folder, id).start() : new Chat(folder, id);
  const ask = first.next();
  expect(ask.ask_type, JSON.stringify(ask)).toBe("plan-approval");
  return { folder, first };
}

function recordsNothing(folder: Folder, run: Run): void {
  expect(run.code, `${run.stdout}\n${run.stderr}`).not.toBe(0);
  expect(folder.rows("PLAN_APPROVAL_RECORDED")).toEqual([]);
}

describe("t-plan-question-new-chat: the code plan question, words in a chat that has not shown it", () => {
  test("the print names a bare next and no record step, and the record step then records nothing", () => {
    const { folder } = planAskedIn(A);
    const second = new Chat(folder, B).start();
    const printed = second.reply("carry on with the work");
    expect(printed).toContain("orchestrate.ts next`");
    expect(printed).not.toContain(RECORD_STEP);
    expect(printed).not.toContain("--message");
    expect(printed).not.toContain(TODAY_PLAN);
    recordsNothing(folder, second.approvePlan());
  });

  test("the bare next puts the question there once, and the pick made with it on screen records", () => {
    const { folder } = planAskedIn(A);
    const second = new Chat(folder, B).start();
    second.reply("carry on with the work");
    const ask = second.next();
    expect(ask.kind, JSON.stringify(ask)).toBe("ask");
    expect(ask.ask_type).toBe("plan-approval");
    expect(String(ask.question).length).toBeGreaterThan(0);
    expect((ask.plan_approval as { choices: string[] }).choices).toEqual(["Approve Plan", "Request Changes", "I'll edit the files"]);
    expect(folder.shownIn(B)).toBe(1);
    const printed = second.reply("1");
    expect(printed).toContain(TODAY_PLAN);
    expect(printed).toContain(RECORD_STEP);
    folder.json(second.approvePlan(), "the approval from the chat that now shows it");
    const [recorded] = folder.rows("PLAN_APPROVAL_RECORDED");
    expect(auditBlockField(recorded.block, "Person Reply")).toBe("1");
    expect(folder.shownIn(B)).toBe(1);
  });

  test("an explicit approval typed there is put once more, then the pick records", () => {
    const { folder } = planAskedIn(A);
    const second = new Chat(folder, B).start();
    expect(second.reply("approve the code plan")).not.toContain(RECORD_STEP);
    recordsNothing(folder, second.approvePlan());
    expect(second.next().ask_type).toBe("plan-approval");
    second.said("Approve Plan");
    folder.json(second.approvePlan(), "the pick with the question on screen");
    expect(folder.rows("PLAN_APPROVAL_RECORDED")).toHaveLength(1);
  });

  test("their words still reach the request, skip and status readings", () => {
    const { folder } = planAskedIn(A);
    const second = new Chat(folder, B).start();
    const printed = second.reply("also add a CSV export of the tasks");
    const request = /`([^`]*next --request (\S+))`/.exec(printed);
    expect(request, printed).not.toBeNull();
    expect(printed).toContain("next --skip code-generation");
    expect(printed).toContain("status");
    // The request the print names still holds their words, and asks where they belong.
    const routed = second.next(["--request", request![2]]);
    expect(routed.kind, JSON.stringify(routed)).toBe("ask");
    expect(String(routed.question)).toContain("also add a CSV export of the tasks");
  });

  test("a setting typed with the words is run first, then the bare next", () => {
    const { folder } = planAskedIn(A);
    const second = new Chat(folder, B).start();
    second.said("/aidlc --plan-approval off carry on with the work");
    const step = second.next(["--plan-approval", "off", "carry on with the work"]);
    const printed = String(step.message);
    expect(printed).toContain("config set");
    expect(printed).toContain("orchestrate.ts next`");
    expect(printed).not.toContain(RECORD_STEP);
  });

  // Asked where their words belong, the person says the work in progress.
  function routedAsTheWorkInProgress(folder: Folder, chat: Chat): Json {
    const printed = chat.reply("make the slugs lower case");
    const request = /next --request (\S+)`/.exec(printed)?.[1];
    expect(request, printed).toBeDefined();
    const routing = chat.next(["--request", request!]);
    expect(routing.kind, JSON.stringify(routing)).toBe("ask");
    const answer = String((routing as { continue_command?: string }).continue_command ?? "");
    expect(answer, JSON.stringify(routing)).toContain("next");
    chat.said("1");
    const [bun, file, ...rest] = answer.trim().split(/\s+/).map((word) => word.replace(/^'|'$/g, ""));
    expect(bun).toBe("bun");
    let step = folder.json(folder.run([BUN, join(folder.dir, file), ...rest], chat.id), "the routing answer");
    for (let i = 0; step.kind === "load-steering" && i < 40; i++) {
      const [, tool, ...more] = String(step.next).trim().split(/\s+/);
      step = folder.json(folder.run([BUN, join(folder.dir, tool), ...more], chat.id), "rule part");
    }
    return step;
  }

  test("the second door: answered as the work in progress, the question is shown, not read as answered", () => {
    const { folder } = planAskedIn(A);
    const step = routedAsTheWorkInProgress(folder, new Chat(folder, B).start());
    expect(step.kind, JSON.stringify(step)).toBe("ask");
    expect(step.ask_type).toBe("plan-approval");
  });

  test("the second door in the chat that showed it: their words are its answer, as today", () => {
    const { folder, first } = planAskedIn(A);
    const step = routedAsTheWorkInProgress(folder, first);
    expect(step.kind, JSON.stringify(step)).toBe("print");
    expect(String(step.message)).toContain("so their words are that answer");
  });
});

describe("t-plan-question-new-chat: the chat that showed it, and what the record cannot place", () => {
  test("words in the chat that showed it get today's print", () => {
    const { first } = planAskedIn(A);
    const printed = first.reply("carry on with the work");
    expect(printed).toContain(TODAY_PLAN);
    expect(printed).toContain(RECORD_STEP);
  });

  test("its plans edited while it waits and shown again in another chat: the first chat is shown it again once", () => {
    const { folder, first } = planAskedIn(A);
    const second = new Chat(folder, B).start();
    writeFileSync(join(folder.planDir(), "code-generation-plan.md"), folder.planText("- Tests: 4 unit tests"));
    expect(second.next().ask_type).toBe("plan-approval");
    expect(first.reply("carry on with the work")).not.toContain(RECORD_STEP);
    expect(first.next().ask_type).toBe("plan-approval");
    expect(first.reply("carry on with the work")).toContain(RECORD_STEP);
  });

  test("a question asked by a command that named no chat: words in a named chat get it put first", () => {
    const { folder } = planAskedIn(null);
    expect(new Chat(folder, B).start().reply("carry on with the work")).not.toContain(RECORD_STEP);
  });

  test("a command that names no chat after a showing in a named chat: one showing with no chat, then today's print", () => {
    const { folder } = planAskedIn(A, false);
    const nowhere = new Chat(folder, null);
    expect(nowhere.reply("carry on with the work")).not.toContain(RECORD_STEP);
    expect(nowhere.next().ask_type).toBe("plan-approval");
    expect(folder.shownIn(null)).toBe(1);
    expect(nowhere.reply("carry on with the work")).toContain(RECORD_STEP);
    expect(folder.shownIn(null)).toBe(1);
  });
});

// Solo work shared by git: the question was asked in one clone and is put in
// another, whose shard sorts first, so its rows are read before the asking row.
describe("t-plan-question-new-chat: a second clone of the same work", () => {
  test("the plan question put in the second clone is shown there once, and the pick there records", () => {
    const { folder } = planAskedIn(A);
    folder.cloneIs("clone0002", "aaaa");
    const second = new Chat(folder, B).start();
    expect(second.reply("carry on with the work")).not.toContain(RECORD_STEP);
    expect(second.next().ask_type).toBe("plan-approval");
    const printed = second.reply("1");
    expect(printed).toContain(TODAY_PLAN);
    folder.json(second.approvePlan(), "the pick in the second clone");
    expect(folder.rows("PLAN_APPROVAL_RECORDED")).toHaveLength(1);
    expect(folder.shownIn(B)).toBe(1);
  });

  test("the gate shown in the second clone is shown there once, then read as its possible answer", () => {
    const { folder } = gateOpenIn(A);
    folder.cloneIs("clone0002", "aaaa");
    const second = new Chat(folder, B).start();
    expect(second.reply("carry on with the work")).not.toContain("--result approved");
    expect(second.next()).toMatchObject({ kind: "run-stage", stage: GATE_STAGE, gate_only: true });
    expect(second.reply("approve")).toContain(TODAY_GATE);
    expect(folder.shownIn(B)).toBe(1);
  });
});

// --- The stage approval gate ---

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

// The Requirements gate opened in chat A, the stage's documents written and reviewed READY.
function gateOpenIn(id: string): { folder: Folder; first: Chat } {
  const folder = new Folder("inception");
  const first = new Chat(folder, id).start();
  const stageDir = join(seededRecordDir(folder.dir), "inception", GATE_STAGE);
  const questions = join(stageDir, `${GATE_STAGE}-questions.md`);
  folder.ok(first.tool("jump", ["execute", "--target", GATE_STAGE, "--direction", "redo"]), "start the stage");
  expect(first.next()).toMatchObject({ kind: "run-stage", stage: GATE_STAGE });
  first.said("Q1: A");
  first.write(questions, questionsBody(""));
  const summary = ["--stage", GATE_STAGE, "--checkpoint", "summary-confirmation", "--questions-file", questions];
  folder.json(first.tool("log", ["decision", ...summary, "--decision", SUMMARY_QUESTION, "--options",
    "Looks correct,Request changes"]), "ask the summary");
  first.said("Looks correct");
  first.write(questions, questionsBody("Looks correct"));
  folder.json(first.tool("log", ["answer", ...summary, "--details", "Looks correct"]), "record the summary answer");
  first.write(join(stageDir, "requirements.md"), "# Requirements\n\n## Functional Requirements\n\n- B1: Owners only.\n");
  const base = ["review", "--stage", GATE_STAGE, "--reviewer", REVIEWER, "--iteration", "1"];
  const requested = folder.json(first.tool("log", base), "request the review");
  first.write(join(folder.dir, String(requested.reviewFile)), [
    "## Review", "", "**Verdict:** READY", `**Reviewer:** ${REVIEWER}`, "**Iteration:** 1", "",
    "### Findings", "", "No outstanding findings.", "",
  ].join("\n"));
  folder.json(first.tool("log", [...base, "--verdict", "READY"]), "record the verdict");
  expect(folder.json(first.tool("orchestrate", ["report", "--stage", GATE_STAGE, "--result", "awaiting-approval"]),
    "open the gate").kind).toBe("print");
  return { folder, first };
}

function approveGate(chat: Chat, message?: string): Run {
  return chat.tool("orchestrate", ["report", "--stage", GATE_STAGE, "--result", "approved", "--user-input", "Approve",
    ...(message ? ["--message", message] : [])]);
}

function latestMessageId(folder: Folder, chat: string): string {
  const turn = folder.rows("HUMAN_TURN").findLast((row) => auditBlockField(row.block, "Session") === chat);
  return auditBlockField(turn!.block, "Message Id")!;
}

describe("t-plan-question-new-chat: a stage approval, words in a chat that has not shown it", () => {
  test("the print names a bare next in place of the approval step, keeping Request Changes", () => {
    const { folder } = gateOpenIn(A);
    const printed = new Chat(folder, B).start().reply("carry on with the work");
    expect(printed).not.toContain("--result approved");
    expect(printed).not.toContain("--message");
    expect(printed).not.toContain(TODAY_GATE);
    expect(printed).toContain("--result rejected");
    expect(printed).toContain("orchestrate.ts next`");
  });

  test("the bare next shows the gate there once, with its line, and the answer then records", () => {
    const { folder } = gateOpenIn(A);
    const second = new Chat(folder, B).start();
    second.reply("carry on with the work");
    const gate = second.next();
    expect(gate, JSON.stringify(gate)).toMatchObject({ kind: "run-stage", stage: GATE_STAGE, gate_only: true });
    expect(String(gate.narration).split("\n")[0]).toBe(FINISHED_ELSEWHERE);
    expect(folder.shownIn(B)).toBe(1);
    const printed = second.reply("1");
    expect(printed).toContain(TODAY_GATE);
    expect(printed).toContain("--message");
    folder.json(approveGate(second, latestMessageId(folder, B)), "approve with the answer named");
    const [approved] = folder.rows("GATE_APPROVED");
    expect(auditBlockField(approved.block, "Person Reply")).toBe("1");
    expect(folder.shownIn(B)).toBe(1);
  });

  test("approved there without naming the answer, the approval records with their answer in it", () => {
    const { folder } = gateOpenIn(A);
    const second = new Chat(folder, B).start();
    second.reply("carry on with the work");
    second.next();
    second.said("Approve");
    folder.json(approveGate(second), "approve without --message");
    expect(auditBlockField(folder.rows("GATE_APPROVED")[0].block, "Person Reply") ?? "").toContain("Approve");
  });

  test("words in the chat that opened it get today's print", () => {
    const { first } = gateOpenIn(A);
    const printed = first.reply("carry on with the work");
    expect(printed).toContain(TODAY_GATE);
    expect(printed).toContain("--result approved");
  });
});
