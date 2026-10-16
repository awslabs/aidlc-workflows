// covers: function:parseNextFlags, subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:intent-create
//
// One rule for a flag-shaped token `next` does not take, wherever it sits on
// the line. Before this, each such token was read as something the person
// said: an answer argument the agent misplaced became the routing question's
// "You said: --details Approve Plan" about words they never typed, or ended the
// turn with `I could not read "--result". Was that a setting you wanted?`; only
// `--choice` (#2258) and `--session` (#2165) were caught, flag by flag. A name
// the person misspelt (`--plan-aprroval off add the export`) named the work
// after the whole line. Now `next` says in one print, to the agent alone, that
// it cannot take the token and the value it took, and nothing of it reaches the
// person, becomes the work's name, or is recorded. A flag inside one quoted
// argument or after `--` is still their text (#847).
//
// The second half: the lowering flag the person typed rides the answer commands
// to the work they pick, and creation takes it once they have asked in this
// chat, recording it as theirs.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  followProposal,
  removeWorkspaceRecord,
  REPO_ROOT,
  runOrchestrateNext,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";
import {
  auditBlockField,
  getField,
  hooksHealthDir,
  readAuditShardEvents,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { parseNextFlags } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c001";
const UNREAD = "I could not read";
const ANSWER_COMMAND = "answer --stage code-generation --checkpoint plan-approval";
// Every answer-carrying flag of a sibling verb, plus the three an agent guesses.
const ANSWER_FLAGS: Array<[string, string[]]> = [
  ["--choice", ["--choice", "Approve Plan"]],
  ["--details", ["--details", "Approve Plan"]],
  ["--decision", ["--decision", "Approve Plan"]],
  ["--answer", ["--answer", "Approve Plan"]],
  ["--user-input", ["--user-input", "Approve Plan"]],
  ["--feedback", ["--feedback", "Approve Plan"]],
  ["--result", ["--result", "approved"]],
  ["--verdict", ["--verdict", "approve"]],
  ["--mode", ["--mode", "gated"]],
  ["--approve", ["--approve"]],
  ["--session", ["--session", SESSION]],
];

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function env(proj: string): NodeJS.ProcessEnv {
  return {
    ...testGuardEnvironment(process.env, "production"),
    CLAUDE_PROJECT_DIR: proj,
    AIDLC_PROJECT_DIR: proj,
    AIDLC_UNATTENDED: "0",
    // The chat this command belongs to, as a real run resolves it (SessionStart
    // records it before any work exists). Without it no message of theirs can be
    // attributed to this chat, and a lowering the command carries stays refused.
    AIDLC_SESSION_OVERRIDE: SESSION,
  };
}

interface Emitted {
  kind?: string;
  ask_type?: string;
  message?: string;
  narration?: string;
  question?: string;
  confirm_command?: string;
  compose_command?: string;
  new_intent_command?: string;
  scope_commands?: Array<{ scope: string; command: string }>;
  plan_approval?: { status?: string };
}

function next(proj: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}): { d: Emitted; out: string } {
  // The agent's proposal step follows the plan proposal print, as it does live.
  const options = { env: { ...env(proj), ...extra } };
  const result = followProposal(runOrchestrateNext(ORCHESTRATE, proj, args, options), ORCHESTRATE, proj, options);
  expect(result.directive, result.out).not.toBeNull();
  return { d: result.directive as unknown as Emitted, out: result.out };
}

function hook(proj: string, args: string[], input: string, extra: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(BUN, args, {
    cwd: proj,
    input,
    env: { ...env(proj), ...extra },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

/** The person types `prompt`, through the host's own human-turn hook. */
function say(proj: string, prompt: string, harness: "claude" | "codex" = "claude"): void {
  if (harness === "claude") {
    hook(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: proj, prompt }));
    return;
  }
  if (!existsSync(join(proj, ".codex"))) {
    cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), join(proj, ".codex"), { recursive: true });
  }
  writeSessionPidEntry(proj, process.pid, SESSION);
  hook(proj, [join(proj, ".codex", "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"],
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, turn_id: "t1", cwd: proj, prompt }),
    { CLAUDE_PROJECT_DIR: undefined, AIDLC_UNATTENDED: undefined, USER_PROMPT: undefined, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined });
}

function utility(proj: string, args: string[], extra: NodeJS.ProcessEnv = {}): { status: number; out: string } {
  const result = spawnSync(BUN, [UTILITY, ...args, "--project-dir", proj], {
    cwd: proj,
    env: { ...env(proj), ...extra },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const stageDir = (proj: string) => join(seededRecordDir(proj), "construction", "code-generation");

/** A one-step bug fix at Code Generation, its plan written and not yet approved. */
function planQuestionProject(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope bugfix)", "- **Guard Policy**: strict (set by you)")
    .replace("- **Summary Confirmation**: on (from scope bugfix)", "- **Summary Confirmation**: off (from scope bugfix)")
    .replace("- **Learnings**: on (from scope bugfix)", "- **Learnings**: off (from scope bugfix)")
    .replace("- [-] requirements-analysis ", "- [x] requirements-analysis ")
    .replace("- [ ] code-generation ", "- [-] code-generation ")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
    .replace(/^- \*\*Lifecycle Phase\*\*:.*$/m, "- **Lifecycle Phase**: CONSTRUCTION")
    .replace("- **Inception**: Active", "- **Inception**: Verified")
    .replace("- **Construction**: Pending", "- **Construction**: Active");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "todo.ts"), "export const todo = (title: string) => title;\n", "utf-8");
  const requirements = join(seededRecordDir(proj), "inception", "requirements-analysis");
  mkdirSync(requirements, { recursive: true });
  writeFileSync(join(requirements, "requirements.md"), "# Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
  const dir = stageDir(proj);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: the blank-title fix\n- Touches: src/todo.ts\n" +
      "- Tests: 1 regression test\n\n## Steps\n\n- [ ] Step 1: add a failing test for a blank title in `src/todo.test.ts`\n" +
      "- [ ] Step 2: refuse a blank title in `src/todo.ts`\n\n" + renderTestingContract(resolveTestingPosture(proj)), "utf-8");
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/todo.test.ts`.\n", "utf-8");
  return proj;
}

/** No work yet; the person's chat runs AI-DLC's hooks. */
function emptyProject(): string {
  const proj = createTestProject();
  created.push(proj);
  removeWorkspaceRecord(proj);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return proj;
}

/** Open work, in this chat, under a strict Guard Policy the person set. */
function openWork(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj),
    readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
      .replace("- **Change Control**: strict (from scope feature)", "- **Guard Policy**: strict (set by you)"), "utf-8");
  const sessions = join(proj, "aidlc", ".aidlc-sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, ".current-session"), `${SESSION}\n`, "utf-8");
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
  return proj;
}

function questionCopies(proj: string): string[] {
  const dir = join(proj, "aidlc", ".aidlc-sessions", "questions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => String((JSON.parse(readFileSync(join(dir, name), "utf-8")) as { text?: unknown }).text ?? ""));
}

function events(proj: string): string[] {
  return readAuditShardEvents(proj).map((row) =>
    `${row.event}${auditBlockField(row.block, "Details") ? `=${auditBlockField(row.block, "Details")}` : ""}`);
}

function intents(proj: string): string {
  return join(proj, "aidlc", "spaces", "default", "intents");
}

function createdField(proj: string, field: string): string | null {
  const record = readFileSync(join(intents(proj), "active-intent"), "utf-8").trim();
  return getField(readFileSync(join(intents(proj), record, "aidlc-state.md"), "utf-8"), field);
}

/**
 * What a refused engine command said, as text. It arrives as JSON (`error: {"error":
 * "..."}`), so on Windows the backslashes of a path inside it are escaped and the
 * raw path never matches the raw output. Parse it, and fall back to the output as
 * printed when it is not JSON.
 */
function errorText(out: string): string {
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(out.slice(start, end + 1)) as { error?: unknown };
      if (typeof parsed.error === "string") return parsed.error;
    } catch {
      // Not JSON: what was printed is what was said.
    }
  }
  return out;
}

function lockMemory(proj: string): string {
  const dir = join(proj, "aidlc", "spaces", "default", "memory");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "project.md");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Project\n";
  writeFileSync(path, `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`, "utf-8");
  return path;
}

// ---------------------------------------------------------------------------
// The parser: one rule, no per-flag branch
// ---------------------------------------------------------------------------

// The refusal checks below compare a path against the parsed error, because the
// command prints JSON: on Windows a path's backslashes are escaped inside it, so
// the raw output never contains the raw path. This pins the reading itself.
describe("a refused command's text is read from the JSON it prints", () => {
  test("a Windows path inside the error survives the escaping", () => {
    const windowsPath = "C:\\Users\\dev\\aidlc\\spaces\\default\\memory\\project.md";
    const printed = `error: ${JSON.stringify({ error: `Your team set Guard Policy to strict in ${windowsPath}.` })}\n`;
    // The raw output cannot be matched against the raw path, which is the Windows red.
    expect(printed).not.toContain(windowsPath);
    expect(errorText(printed)).toContain(windowsPath);
  });

  test("output that is not JSON is returned as printed", () => {
    expect(errorText("plain words, no JSON here")).toBe("plain words, no JSON here");
  });
});

describe("the parser reads a flag it does not take, before the person's words, as untaken", () => {
  test.each(ANSWER_FLAGS)("%s is untaken and is never the work's description", (flag, args) => {
    const parsed = parseNextFlags(args);
    expect(parsed.untakenFlag).toBe(flag);
    expect(parsed.intent).toBeUndefined();
    expect(parsed.parseError).toBeUndefined();
  });

  test("the value it took comes back with it, so the print can name both", () => {
    expect(parseNextFlags(["--details", "Approve Plan"]).untakenFlagValue).toBe("Approve Plan");
    expect(parseNextFlags(["--approve"]).untakenFlagValue).toBeUndefined();
    // A misspelt boolean: the word after it is named, never eaten in silence.
    const boolish = parseNextFlags(["--new-intnet", "add", "the", "export"]);
    expect(boolish.untakenFlag).toBe("--new-intnet");
    expect(boolish.untakenFlagValue).toBe("add");
  });

  test("a misspelt setting is untaken too, and never names the work", () => {
    const parsed = parseNextFlags(["--plan-aprroval", "off", "add", "the", "export"]);
    expect(parsed.untakenFlag).toBe("--plan-aprroval");
    expect(parsed.untakenFlagValue).toBe("off");
    expect(parsed.intent ?? "").not.toContain("--plan-aprroval");
  });

  // Where the token sits says nothing about what the person meant by it: a
  // setting at the end of their sentence means a setting, a flag they want
  // built means their words, and only the agent can tell. So the token is
  // untaken wherever it sits, and the two ways they can mark it as theirs keep
  // it whole (#847): after the `--` delimiter, or inside one quoted argument.
  test("a flag among their words is untaken too; the delimiter and a quoted sentence keep it", () => {
    expect(parseNextFlags(["add", "a", "--session", "timeout", "option"]).untakenFlag).toBe("--session");
    expect(parseNextFlags(["add", "a", "--choice", "flag"]).untakenFlag).toBe("--choice");
    const delimited = parseNextFlags(["--", "--choice", "Approve Plan"]);
    expect(delimited.intent).toBe("--choice Approve Plan");
    expect(delimited.untakenFlag).toBeUndefined();
    const sentence = parseNextFlags(["add a --verbose flag to the CLI"]);
    expect(sentence.intent).toBe("add a --verbose flag to the CLI");
    expect(sentence.untakenFlag).toBeUndefined();
  });

  test("a flag it does take is unaffected", () => {
    expect(parseNextFlags(["--scope", "bugfix", "fix the login"]).untakenFlag).toBeUndefined();
    expect(parseNextFlags(["--plan-approval", "off", "add the export"]).untakenFlag).toBeUndefined();
    expect(parseNextFlags(["--guard.review-freeze", "off"]).untakenFlag).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// What the person gets: nothing. What the agent gets: one print.
// ---------------------------------------------------------------------------

describe("an answer flag misplaced on next never reaches the person", () => {
  const states: Array<{ id: string; reply: string | null }> = [
    { id: "no reply yet", reply: null },
    { id: "the person picked exactly", reply: "Approve Plan" },
    { id: "the person replied in their own words", reply: "looks good, build it" },
  ];
  for (const state of states) {
    test.each(ANSWER_FLAGS)(`${state.id}: %s gets one agent-facing print, no question, no record`, (flag, args) => {
      const proj = planQuestionProject();
      expect(next(proj).d.ask_type).toBe("plan-approval");
      if (state.reply !== null) say(proj, state.reply);
      const before = events(proj);
      const { d, out } = next(proj, args);
      expect(d.kind, out).toBe("print");
      expect(d.narration, out).toBeUndefined();
      expect(d.ask_type, out).toBeUndefined();
      expect(out).not.toContain(UNREAD);
      expect(String(d.message)).toContain(flag);
      expect(String(d.message)).toContain(ANSWER_COMMAND);
      expect(String(d.message)).not.toContain("--request");
      expect(questionCopies(proj).join(" ")).not.toContain(flag);
      expect(events(proj)).toEqual(before);
      cleanupTestProject(created.pop());
    });
  }

  test.each([["--details", ["--details", "Approve Plan"]], ["--result", ["--result", "approved"]]] as Array<[string, string[]]>)(
    "through the Codex hook too: %s", (flag, args) => {
      const proj = planQuestionProject();
      expect(next(proj).d.ask_type).toBe("plan-approval");
      say(proj, "Approve Plan", "codex");
      const before = events(proj);
      const { d, out } = next(proj, args);
      expect(d.kind, out).toBe("print");
      expect(d.narration, out).toBeUndefined();
      expect(String(d.message)).toContain(flag);
      expect(String(d.message)).toContain(ANSWER_COMMAND);
      expect(events(proj)).toEqual(before);
      expect(questionCopies(proj).join(" ")).not.toContain(flag);
      cleanupTestProject(created.pop());
    },
  );

  test("the person's own reply still answers the plan question after the correction", () => {
    const proj = planQuestionProject();
    expect(next(proj).d.ask_type).toBe("plan-approval");
    say(proj, "Approve Plan");
    next(proj, ["--details", "Approve Plan"]);
    const answered = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation",
      "--checkpoint", "plan-approval", "--details", "Approve Plan", "--project-dir", proj,
    ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(answered.status, `${answered.stdout}${answered.stderr}`).toBe(0);
    expect(next(proj).d.plan_approval?.status).toBe("approved");
  });

  // A setting read from their words beside their reply to the plan question
  // names those words, so it lands as theirs.
  test("a setting asked for in plain words beside the plan answer: the setter names their words", () => {
    const proj = planQuestionProject();
    expect(next(proj).d.ask_type).toBe("plan-approval");
    say(proj, "approve it, and turn the sensors off");
    const { d, out } = next(proj, ["--sensors", "off", "approve", "it"]);
    expect(d.kind, out).toBe("print");
    expect(String(d.message)).toContain(
      "config set sensors off --person-words '<their words>'`, with <their words> the person's reply that asked for it, " +
        "word for word, first",
    );
  });

  test("a setting typed beside the plan answer: the setter names no words", () => {
    const proj = planQuestionProject();
    expect(next(proj).d.ask_type).toBe("plan-approval");
    say(proj, "/aidlc --sensors off approve it");
    const { d, out } = next(proj, ["--sensors", "off", "approve", "it"]);
    expect(d.kind, out).toBe("print");
    expect(String(d.message)).toContain("config set sensors off` first");
  });

  test("with no plan question open, the print says what to do with the token instead", () => {
    const proj = openWork();
    const { d, out } = next(proj, ["--details", "Approve Plan"]);
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    expect(String(d.message)).toContain("--details Approve Plan");
    expect(String(d.message)).toContain("only the person's words");
    expect(out).not.toContain(UNREAD);
  });
});

describe("a name the person misspelt costs them neither their words nor the turn", () => {
  test("with work open, the print names the token and the work is never named after it", () => {
    const proj = openWork();
    say(proj, "/aidlc --plan-aprroval off add the export");
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const { d, out } = next(proj, ["--plan-aprroval", "off", "add", "the", "export"]);
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    expect(String(d.message)).toContain("--plan-aprroval off");
    expect(out).not.toContain(UNREAD);
    expect(d.ask_type, out).toBeUndefined();
    expect(questionCopies(proj).join(" ")).not.toContain("--plan-aprroval");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
  });

  test("before any work exists, the same print, and no plan offer named after the flag", () => {
    const proj = emptyProject();
    say(proj, "/aidlc --plan-aprroval off add the export");
    const { d, out } = next(proj, ["--plan-aprroval", "off", "add", "the", "export"]);
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    expect(String(d.message)).toContain("--plan-aprroval off");
    expect(questionCopies(proj).join(" ")).not.toContain("--plan-aprroval");
    expect(out).not.toContain(UNREAD);
  });

  test("the agent's second next, with the flag the engine takes, starts the work with it", () => {
    const proj = emptyProject();
    say(proj, "/aidlc --plan-aprroval off add the export");
    next(proj, ["--plan-aprroval", "off", "add", "the", "export"]);
    const ask = next(proj, ["--plan-approval", "off", "add the export"]);
    expect(ask.d.kind, ask.out).toBe("ask");
    expect(String(ask.d.question)).toContain("add the export");
    // No ready-made plan fits those words, so the offer is the compose one: the
    // flag rides every answer it names.
    expect(ask.d.ask_type, ask.out).toBe("compose-offer");
    expect(String(ask.d.compose_command)).toContain("--plan-approval off");
    for (const row of ask.d.scope_commands ?? []) {
      expect(row.command, row.scope).toContain("--plan-approval off");
    }
  });
});

// ---------------------------------------------------------------------------
// The lowering flag the person typed rides to the work they pick
// ---------------------------------------------------------------------------

describe("plan approval off typed with new work rides the answer commands", () => {
  test("on a fresh workspace, every answer the plan offer names carries it", () => {
    const proj = emptyProject();
    say(proj, "/aidlc --plan-approval off Fix the login crash when the session expires");
    const { d, out } = next(proj, ["--plan-approval", "off", "Fix the login crash when the session expires"]);
    expect(d.ask_type, out).toBe("scope-confirm");
    expect(String(d.confirm_command)).toContain("--plan-approval off");
    expect(String(d.compose_command)).toContain("--plan-approval off");
    for (const row of d.scope_commands ?? []) {
      expect(row.command, row.scope).toContain("--plan-approval off");
    }
  });

  test("beside open work, it rides the new-work answer into the creation command", () => {
    const proj = openWork();
    say(proj, "/aidlc --plan-approval off fix the export");
    const routing = next(proj, ["--plan-approval", "off", "fix", "the", "export"]);
    expect(routing.d.ask_type, routing.out).toBe("new-work-routing");
    const command = String(routing.d.new_intent_command);
    expect(command).toContain("--plan-approval off");
    // No plan was named with the words, so the separate-work answer reaches the
    // plan question (the agent's proposal, through the test's stand-in reading);
    // the switch rides that hop onto the question's commands and the creation.
    const offer = next(proj, command.slice(command.indexOf(" next ") + 6).split(" "));
    expect(offer.d.ask_type, offer.out).toBe("scope-confirm");
    const confirm = String(offer.d.confirm_command);
    expect(confirm).toContain("--plan-approval off");
    // The person goes ahead with the plan.
    say(proj, "1");
    const created = next(proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" "));
    expect(String(created.d.message), created.out).toContain("--plan-approval off");
  });
});

// ---------------------------------------------------------------------------
// Creation takes the flag the command passes once the person has asked
// ---------------------------------------------------------------------------

describe("creation takes a lowering flag the command passes when the person asked in this chat", () => {
  const CREATE = ["intent-create", "--scope", "enterprise", "--arguments", "build the export", "--label", "export"];

  test("before any work exists, their message in this chat is the proof", () => {
    const proj = emptyProject();
    say(proj, "I trust these plans, let it build them without me");
    const made = utility(proj, [
      ...CREATE, "--plan-approval", "off", "--person-words", "I trust these plans, let it build them without me",
    ]);
    expect(made.status, made.out).toBe(0);
    expect(createdField(proj, "Plan Approval")).toBe("off (set by you)");
  });

  test("with no message of theirs on record, the refusal stands and names the wait", () => {
    const proj = emptyProject();
    const made = utility(proj, [...CREATE, "--plan-approval", "off"]);
    expect(made.status).toBe(1);
    expect(errorText(made.out)).toContain("No reply from the person has arrived since the last decision");
    expect(errorText(made.out)).not.toContain("Create the piece of work without it");
  });

  test("a message from another chat is not this chat's proof", () => {
    const proj = emptyProject();
    hook(proj, [DISPATCHER, "engine", "hook", "record-human-turn"],
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "01995000-7a11-7000-8000-00000000c009",
        cwd: proj,
        prompt: "build it without asking me",
      }),
      { AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-00000000c009" });
    const made = utility(proj, [...CREATE, "--plan-approval", "off"]);
    expect(made.status, made.out).toBe(1);
  });

  test("an unattended driver is refused even with their message on record", () => {
    const proj = emptyProject();
    say(proj, "I trust these plans, let it build them without me");
    const made = utility(proj, [...CREATE, "--plan-approval", "off"], { AIDLC_UNATTENDED: "1" });
    expect(made.status).toBe(1);
  });

  test("a team's strict Guard Policy refuses it first, naming the file", () => {
    const proj = emptyProject();
    const path = lockMemory(proj);
    say(proj, "I trust these plans, let it build them without me");
    const made = utility(proj, [...CREATE, "--plan-approval", "off"]);
    expect(made.status).toBe(1);
    // The path is compared against the parsed error: a Windows path's backslashes
    // are escaped inside the JSON the command prints.
    expect(errorText(made.out)).toContain(path);
  });

  test("with work open, a Guard Policy the command lowers is theirs once they have spoken", () => {
    const proj = emptyProject();
    expect(utility(proj, ["intent-create", "--scope", "poc", "--arguments", "first", "--label", "first"]).status).toBe(0);
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "write-audit-log.last"), new Date().toISOString());
    say(proj, "please go on without stopping for the plan");
    const made = utility(proj, [
      "intent-create", "--scope", "enterprise", "--arguments", "second", "--label", "second",
      "--guard-policy", "relaxed", "--person-words", "please go on without stopping for the plan",
    ]);
    expect(made.status, made.out).toBe(0);
    expect(createdField(proj, "Guard Policy")).toBe("relaxed (set by you)");
  });

  test("a command the person runs at their own terminal carries itself", () => {
    const proj = emptyProject();
    // Their own shell: no host of an agent marks it, and no chat is bound to it.
    // The runner's own environment carries its host's marks, so they are cleared
    // here the way the person's terminal has none (agentHostMark in aidlc-lib.ts).
    const ownTerminal: NodeJS.ProcessEnv = { AIDLC_TEST_CONFIG_TTY: "1", TERM_PROGRAM: undefined };
    for (const key of Object.keys(process.env)) {
      if (/^(?:CLAUDECODE|CLAUDE_CODE_|CODEX_|CURSOR_|KIRO_|OPENCODE|COPILOT_|VSCODE_)/i.test(key)) {
        ownTerminal[key] = undefined;
      }
    }
    ownTerminal.AIDLC_SESSION_OVERRIDE = undefined;
    ownTerminal.AIDLC_SESSION_OVERRIDE_SOURCE = undefined;
    const made = utility(proj, [...CREATE, "--plan-approval", "off"], ownTerminal);
    expect(made.status, made.out).toBe(0);
    expect(createdField(proj, "Plan Approval")).toBe("off (set by you)");
  });
});

// ---------------------------------------------------------------------------
// Every harness: the person's message is on record, so the flag the command
// carries is backed by their words wherever they drive AI-DLC from
// ---------------------------------------------------------------------------

/** The entry each harness gives the person's typed prompt, as its install ships it. */
// Each harness's own adapter where its install has one; otherwise the engine
// command its install ships, which is how its host reaches the same hook. The
// per-adapter payload contracts have their own files (t147, t218, t241, t249).
const HARNESS_ENTRIES: Array<{ harness: string; dir: string; script: string; target: string[]; event: string }> = [
  { harness: "claude", dir: ".claude", script: "tools/aidlc.ts", target: ["engine", "hook", "record-human-turn"], event: "UserPromptSubmit" },
  { harness: "codex", dir: ".codex", script: "hooks/aidlc-codex-adapter.ts", target: ["record-human-turn"], event: "UserPromptSubmit" },
  { harness: "copilot", dir: ".aidlc", script: "hooks/aidlc-copilot-adapter.ts", target: ["record-human-turn"], event: "UserPromptSubmit" },
  { harness: "cursor", dir: ".cursor", script: "tools/aidlc.ts", target: ["engine", "hook", "record-human-turn"], event: "UserPromptSubmit" },
  { harness: "kiro", dir: ".kiro", script: "hooks/aidlc-kiro-adapter.ts", target: ["verb-intercept"], event: "userPromptSubmit" },
  { harness: "kiro-ide", dir: ".kiro", script: "hooks/aidlc-kiro-adapter.ts", target: ["record-human-turn"], event: "UserPromptSubmit" },
  { harness: "opencode", dir: ".aidlc", script: "tools/aidlc.ts", target: ["engine", "hook", "record-human-turn"], event: "UserPromptSubmit" },
];

describe("the person's own words reach the record from every harness they drive", () => {
  test.each(HARNESS_ENTRIES)(
    "$harness: a typed line is recorded, and creation then takes the flag as theirs",
    ({ harness, dir, script, target, event }) => {
      const proj = createTestProject();
      created.push(proj);
      removeWorkspaceRecord(proj);
      cpSync(join(REPO_ROOT, "dist", harness, dir), join(proj, dir), { recursive: true });
      const health = hooksHealthDir(proj);
      mkdirSync(health, { recursive: true });
      writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
      const prompt = "/aidlc --plan-approval off add the export";
      const payload: Record<string, unknown> = {
        hook_event_name: event,
        session_id: SESSION,
        cwd: proj,
        prompt,
        ...(harness === "codex" ? { turn_id: "t1" } : {}),
      };
      if (harness === "codex") writeSessionPidEntry(proj, process.pid, SESSION);
      const fired = spawnSync(BUN, [join(proj, dir, script), ...target], {
        cwd: proj,
        input: JSON.stringify(payload),
        env: {
          ...env(proj),
          CLAUDE_PROJECT_DIR: harness === "claude" ? proj : undefined,
          USER_PROMPT: undefined,
          CODEX_THREAD_ID: undefined,
          CODEX_SESSION_ID: undefined,
        },
        encoding: "utf-8",
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      });
      expect(fired.status, `${harness}: ${fired.stdout}${fired.stderr}`).toBe(0);
      const records = listMessages(proj);
      expect(records.length, `${harness}: ${JSON.stringify(records)}`).toBe(1);
      expect(records[0].words, harness).toBe("add the export");
      expect(records[0].settings, harness).toEqual([{ key: "plan-approval", value: "off" }]);
      // So the creation the agent runs for them, naming their reply, carries the flag as theirs.
      const made = utility(proj, [
        "intent-create", "--scope", "enterprise", "--arguments", "add the export",
        "--label", "export", "--plan-approval", "off", "--person-words", prompt,
      ]);
      expect(made.status, `${harness}: ${made.out}`).toBe(0);
      expect(createdField(proj, "Plan Approval"), harness).toBe("off (set by you)");
      cleanupTestProject(created.pop());
    },
  );
});

// The Kiro CLI latch binds the FIRST `next` of a turn to the argv the person
// typed, so a dropped or rewritten argument is refused. A misspelt flag has the
// agent run `next` twice: the verbatim first call, then the corrected one. The
// latch must hold the first and leave the second alone, or the person is stuck
// with no way to spend their own words.
describe("the Kiro CLI forwarding latch lets the agent correct the line", () => {
  test("the verbatim first next passes the latch, and the corrected second call is not refused", () => {
    const proj = createTestProject();
    created.push(proj);
    removeWorkspaceRecord(proj);
    cpSync(join(REPO_ROOT, "dist", "kiro", ".kiro"), join(proj, ".kiro"), { recursive: true });
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    const typed = "/aidlc --plan-aprroval off add the export";
    const intercept = spawnSync(BUN, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "verb-intercept"], {
      cwd: proj,
      input: JSON.stringify({ hook_event_name: "userPromptSubmit", session_id: SESSION, cwd: proj, prompt: typed }),
      env: { ...env(proj), CLAUDE_PROJECT_DIR: undefined, USER_PROMPT: undefined },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(intercept.status, `${intercept.stdout}${intercept.stderr}`).toBe(0);
    const records = listMessages(proj);
    expect(records.length, JSON.stringify(records)).toBe(1);
    expect(records[0].text).toBe(typed);
    const first = next(proj, ["--plan-aprroval", "off", "add", "the", "export"]);
    expect(first.d.kind, first.out).toBe("print");
    expect(String(first.d.message)).toContain("--plan-aprroval off");
    expect(first.out).not.toContain("dropped or changed the user's arguments");
    const second = next(proj, ["--plan-approval", "off", "add the export"]);
    expect(second.out).not.toContain("dropped or changed the user's arguments");
    expect(second.d.kind, second.out).toBe("ask");
    expect(String(second.d.compose_command)).toContain("--plan-approval off");
  });
});

// A flag-shaped word inside their reply is still their reply. "approve, but add
// a --verbose flag" is the person approving the plan and asking for a change in
// the same breath: a token this engine does not take is no command of its own,
// so the turn stays a reply, their words are kept for the question they
// answered, and the approval they gave records. Read as a command instead, the
// reply would not count and they would be asked to approve again.
describe("a reply carrying a flag-shaped word of their own stays their reply", () => {
  test("approve, but add a --verbose flag: the words are kept and the approval records", () => {
    const proj = planQuestionProject();
    expect(next(proj).d.ask_type).toBe("plan-approval");
    say(proj, "/aidlc approve, but add a --verbose flag");
    // The turn is a reply: no `Reply` mark filing it as a command to AI-DLC.
    const turns = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN");
    expect(turns.length).toBeGreaterThan(0);
    expect(auditBlockField(turns[turns.length - 1].block, "Reply")).toBeNull();
    const answered = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-log.ts"), "answer", "--stage", "code-generation",
      "--checkpoint", "plan-approval", "--details", "Approve Plan", "--project-dir", proj,
    ], { cwd: proj, env: env(proj), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(answered.status, `${answered.stdout}${answered.stderr}`).toBe(0);
    expect(next(proj).d.plan_approval?.status).toBe("approved");
    expect(listMessages(proj).map((message) => message.text))
      .toContain("/aidlc approve, but add a --verbose flag");
  });

  test("the same words sent to next name the token to the agent and nothing to them", () => {
    const proj = planQuestionProject();
    expect(next(proj).d.ask_type).toBe("plan-approval");
    say(proj, "/aidlc approve, but add a --verbose flag");
    const { d, out } = next(proj, ["approve,", "but", "add", "a", "--verbose", "flag"]);
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    expect(String(d.message)).toContain("--verbose");
    expect(String(d.message)).toContain(ANSWER_COMMAND);
  });
});

// A setting they typed at the end of their own sentence means a setting, and a
// name they misspelt there used to become part of the work's name in silence
// while the check they asked to drop stayed on.
describe("a misspelt setting after the person's words is not swallowed by the work's name", () => {
  test("add the export --plan-aprroval off: the agent is told, and no work is named after it", () => {
    const proj = emptyProject();
    say(proj, "/aidlc add the export --plan-aprroval off");
    const { d, out } = next(proj, ["add", "the", "export", "--plan-aprroval", "off"]);
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    expect(String(d.message)).toContain("--plan-aprroval off");
    expect(questionCopies(proj).join(" ")).not.toContain("--plan-aprroval");
    const ask = next(proj, ["--plan-approval", "off", "--", "add the export"]);
    expect(ask.d.kind, ask.out).toBe("ask");
    expect(String(ask.d.question)).toContain("add the export");
    expect(String(ask.d.compose_command)).toContain("--plan-approval off");
  });

  // The open Plan Approval question is one reading of the token, not the only
  // one. A misspelt setting typed at that gate is plainly not a plan answer, and
  // before this the print named only the answer command, which then refused for
  // want of a reply: the person's own request had no route.
  test("with the plan question open, a misspelt setting still gets every reading", () => {
    const proj = planQuestionProject();
    expect(next(proj).d.ask_type).toBe("plan-approval");
    say(proj, "/aidlc --plan-aprroval off");
    const { d, out } = next(proj, ["--plan-aprroval", "off"]);
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    expect(String(d.message)).toContain("--plan-aprroval off");
    expect(String(d.message)).toContain(ANSWER_COMMAND);
    expect(String(d.message)).toContain("only the person's words");
    expect(String(d.message)).toContain("`--` before their words");
    expect(String(d.message)).toContain("the flag `next` takes");
  });

  // Their words behind the delimiter are still their words on the record: the
  // field the ledger's `Person Reply` takes when the agent names the message
  // must hold the whole of what they asked for.
  test("a typo with the documented delimiter keeps every word of theirs", () => {
    const parsed = parseNextFlags(["--plan-aprroval", "off", "--", "add the export"]);
    expect(parsed.untakenFlag).toBe("--plan-aprroval");
    expect(parsed.intent).toBe("add the export");
    expect(parsed.personWords).toBe("--plan-aprroval off add the export");
    expect(parseNextFlags(["add", "a", "--verbose", "flag", "--", "in the CLI"]).personWords)
      .toBe("add a --verbose flag in the CLI");
  });

  test("and the record the hook keeps holds their whole request", () => {
    const proj = emptyProject();
    say(proj, "/aidlc --plan-aprroval off -- add the export");
    const [record] = listMessages(proj);
    expect(record.words, JSON.stringify(record)).toBe("--plan-aprroval off add the export");
    expect(record.text).toBe("/aidlc --plan-aprroval off -- add the export");
  });

  test("a flag they are asking to have built stays their words, through the delimiter", () => {
    const proj = emptyProject();
    const { d, out } = next(proj, ["add", "a", "--verbose", "flag", "to", "the", "CLI"]);
    expect(d.kind, out).toBe("print");
    expect(d.narration, out).toBeUndefined();
    expect(String(d.message)).toContain("--");
    const ask = next(proj, ["--", "add a --verbose flag to the CLI"]);
    expect(ask.d.kind, ask.out).toBe("ask");
    expect(String(ask.d.question)).toContain("add a --verbose flag to the CLI");
  });
});

// #2401: on Kiro IDE an agent put a flag of its own invention at the front of
// the one quoted argument holding the request, and `--description Northwind
// Mini Bank: ...` became the work's name. The tool cannot tell that from a
// person whose request opens with the same word ("--description should be
// added to the CLI"), so one quoted argument stays their words whatever its
// first word; only a flag the agent passes as its own argument is refused.
describe("a quoted request is the person's words, whatever its first word", () => {
  const REQUEST = "Northwind Mini Bank: a small demo of a bank's core money handling";

  test("the parser keeps a quoted request that opens with a flag-shaped word whole", () => {
    for (const args of [[`--description ${REQUEST}`], ["--scope", "classic", `--description ${REQUEST}`], ["--description should be added to the CLI"]]) {
      const parsed = parseNextFlags(args);
      expect(parsed.untakenFlag, args.join(" | ")).toBeUndefined();
      expect(parsed.intent, args.join(" | ")).toBe(args[args.length - 1]);
    }
  });

  test("the same flag as its own argument is still refused, and creates nothing", () => {
    const proj = emptyProject();
    const { d, out } = next(proj, ["--scope", "classic", "--description", REQUEST]);
    expect(d.kind, out).toBe("print");
    expect(String(d.message)).toContain("`next` does not take `--description");
    expect(existsSync(join(intents(proj), "active-intent"))).toBe(false);
    expect(events(proj).join(" ")).not.toContain("WORKFLOW_STARTED");
  });

  test("next starts the work with a quoted request that opens with a flag-shaped word, whole", () => {
    const proj = emptyProject();
    const words = "--description should be added to the CLI";
    say(proj, `/aidlc classic "${words}"`);
    const { d, out } = next(proj, ["--scope", "classic", words]);
    expect(String(d.message), out).not.toContain("does not take");
    const request = /--request ([0-9a-f]{8})/.exec(String(d.message))?.[1];
    expect(request, out).toBeDefined();
    const made = utility(proj, ["intent-create", "--scope", "classic", "--request", String(request), "--label", "cli-description"]);
    expect(made.status, made.out).toBe(0);
    expect(createdField(proj, "Project"), made.out).toBe(words);
  });

  test("a flag-shaped word later in the quoted request stays their words", () => {
    const parsed = parseNextFlags(["build the reverser, and add a --description flag to it"]);
    expect(parsed.untakenFlag).toBeUndefined();
    expect(parsed.intent).toBe("build the reverser, and add a --description flag to it");
  });

  test("a request opening with front matter or a dash rule stays their words", () => {
    for (const words of ["---\ntitle: Northwind\n---\nBuild the bank", "----- notes below", "---> build the bank"]) {
      const parsed = parseNextFlags([words]);
      expect(parsed.untakenFlag, words).toBeUndefined();
      expect(parsed.intent, words).toBe(words);
    }
  });
});
