// covers: function:fencesOffCreationGranted, function:applyTypedGuardSwitchPrompt, function:applyIntentSettings, function:switchOffLine
//
// Where a switch the person set came from, and where it lands:
//   - a check typed off with a request reaches the work that request became,
//     even when the engine asked a second question on the way, and the person
//     hears that it is off for the new work;
//   - typed before any work exists, the person hears it on the step that
//     follows, in every tool, not only where the host shows hook output;
//   - a setter the person runs in their own terminal is their own act: it
//     quotes no chat message, and a switch with no words of theirs on record
//     claims nothing about the chat.

import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  removeWorkspaceRecord,
  runOrchestrateNext,
  seededStateFile,
} from "../harness/fixtures.ts";
import {
  auditBlockField,
  getField,
  hooksHealthDir,
  pendingPersonLines,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { switchOffLine } from "../../dist/claude/.claude/tools/aidlc-recorded-switches.ts";

setDefaultTimeout(120_000);

const BUN = process.execPath;
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const SESSION = "01995000-7a11-7000-8000-000000000042";
// The runner's fixture profile carries a presence bypass that would authorize a
// command to lower a check; clear it so only the person's own act can.
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_SESSION_OVERRIDE: SESSION,
  AIDLC_UNATTENDED: "0",
};
const TYPED = "/aidlc --guard.review-freeze off fix the parser";
const FOR_THE_REQUEST = "The review freeze check is off for the work you are asking for (set by you).";
const FOR_NEW_WORK = "The review freeze check is off for the new work (set by you).";
const FOR_WORK_STARTING_NOW = "The review freeze check is off for the piece of work you start now (set by you).";
const STARTS_ON = "not off as you typed with the request";

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

/** Open work under a strict Guard Policy, set by the person. */
function openWork(): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope feature)", "- **Guard Policy**: strict (set by you)");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  // The person's chat is the one this project last saw, as a live project has
  // it: a command run outside that chat must not read it as its own.
  const sessions = join(proj, "aidlc", ".aidlc-sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, ".current-session"), `${SESSION}\n`, "utf-8");
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

/** One piece of work started from the terminal, whose session runs the hooks. */
function oneOpenRecord(): { proj: string; open: string } {
  const proj = emptyProject();
  expect(utility(proj, ["intent-create", "--scope", "enterprise"]).status).toBe(0);
  const health = hooksHealthDir(proj);
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "write-audit-log.last"), new Date().toISOString());
  return { proj, open: readFileSync(join(intents(proj), "active-intent"), "utf-8").trim() };
}

function intents(proj: string): string {
  return join(proj, "aidlc", "spaces", "default", "intents");
}

function activeState(proj: string): string {
  const record = readFileSync(join(intents(proj), "active-intent"), "utf-8").trim();
  return readFileSync(join(intents(proj), record, "aidlc-state.md"), "utf-8");
}

function guardsOff(state: string): string {
  return getField(state, "Guards Off") ?? "";
}

/** The person's message as their host delivers it to the prompt hook. */
function reply(proj: string, prompt: string, session = SESSION): string {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
    env: { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: session, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  const out = result.stdout ?? "";
  try {
    const parsed = JSON.parse(out) as { additionalContext?: unknown; hookSpecificOutput?: { additionalContext?: unknown } };
    const text = parsed.additionalContext ?? parsed.hookSpecificOutput?.additionalContext;
    if (typeof text === "string") return text;
  } catch {
    // Plain text output.
  }
  return out;
}

function utility(proj: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(BUN, [UTILITY, ...args, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj },
    encoding: "utf-8",
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** `engine config set` as the person runs it, with or without a chat session. */
function configSet(proj: string, args: string[], session: string | null): { status: number; out: string } {
  const env: Record<string, string | undefined> = {
    ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj,
  };
  delete env.AIDLC_SESSION_OVERRIDE;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  if (session !== null) env.AIDLC_SESSION_OVERRIDE = session;
  const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", ...args, "--project-dir", proj], {
    cwd: proj,
    env,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function next(proj: string, args: string[]): { directive: Record<string, unknown> | null; out: string } {
  const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: { ...process.env, ...CLEAR } });
  return { directive: result.directive as Record<string, unknown> | null, out: result.out };
}

/** The `next` arguments of an answer command the engine handed out. */
function answerArgs(command: unknown): string[] {
  const text = String(command);
  return text.slice(text.indexOf(" next ") + 6).split(" ");
}

function requestIn(message: unknown, out: string): string {
  const id = /--request ([0-9a-f]{8})/.exec(String(message))?.[1];
  if (id === undefined) throw new Error(`no request in ${out}`);
  return id;
}

/** Creation as the agent runs it: the plan and request the engine's print names. */
function createFromPrint(proj: string, step: { directive: Record<string, unknown> | null; out: string }): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const message = String(step.directive?.message);
  const scope = /--scope ([a-z][a-z-]*)/.exec(message)?.[1];
  return utility(proj, [
    "intent-create",
    "--request",
    requestIn(message, step.out),
    ...(scope === undefined ? [] : ["--scope", scope]),
  ]);
}

// A terminal the person types at: both ends a terminal, no chat identity on the
// command, and no mark of a tool that runs terminals of its own. Ancestry cannot
// tell it from the agent's, because a chat records the whole ancestor chain that
// a terminal beside it shares, which is how an unrelated chat message ended up
// quoted as the reason for a command the person ran themselves.
function atATerminal(proj: string, args: string[]): { status: number; out: string } {
  const command = [
    BUN, DISPATCHER, "engine", "config", "set", ...args, "--project-dir", proj,
  ].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
  const env: Record<string, string | undefined> = {
    ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj,
  };
  delete env.AIDLC_SESSION_OVERRIDE;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  // A person's own shell carries no mark of a tool that starts its own
  // terminals. This suite runs inside one, so its marks are cleared here.
  delete env.TERM_PROGRAM;
  for (const key of Object.keys(env)) {
    if (/^(?:CLAUDECODE|CLAUDE_CODE_|CODEX_|CURSOR_|KIRO_|OPENCODE|COPILOT_|VSCODE_)/i.test(key)) delete env[key];
  }
  const result = spawnSync("script", ["-qec", command, "/dev/null"], {
    cwd: proj,
    env: env as NodeJS.ProcessEnv,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

const hasPty = spawnSync("script", ["-qec", "true", "/dev/null"], { encoding: "utf-8" }).status === 0;

/** Everything the person hears from this step: its own line and the kept ones. */
function heard(proj: string, step: { directive: Record<string, unknown> | null }): string {
  return `${String(step.directive?.narration ?? "")} ${pendingPersonLines(proj, SESSION).lines.join(" ")}`;
}

/** Hold the open work at its approval gate, as a person reading its output is. */
function holdAtGate(proj: string): void {
  const stage = getField(activeState(proj), "Current Stage")!.trim();
  const result = spawnSync(BUN, [STATE, "checkbox", `${stage}=awaiting-approval`, "--project-dir", proj], {
    cwd: proj,
    env: { ...process.env, ...CLEAR, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", CLAUDE_PROJECT_DIR: proj },
    encoding: "utf-8",
  });
  expect(result.status, result.stderr).toBe(0);
}

describe("a check typed off with a request, routed through a second question", () => {
  test("reaches the work that request became, and the person hears it", () => {
    const { proj, open } = oneOpenRecord();
    holdAtGate(proj);
    const openBefore = readFileSync(join(intents(proj), open, "aidlc-state.md"), "utf-8");
    // The person types the switch with the request while the open work waits at
    // its gate, so the engine keeps their words as that gate's possible answer.
    expect(reply(proj, TYPED)).toContain(FOR_THE_REQUEST);
    const first = next(proj, ["--guard.review-freeze", "off", "--", "fix the parser"]);
    const q1 = requestIn(first.directive?.message, first.out);
    // The engine asks where the request belongs: a second question.
    const routing = next(proj, ["--request", q1]);
    const ask = routing.directive as { ask_type?: string; new_intent_command?: string } | null;
    expect(ask?.ask_type, routing.out).toBe("new-work-routing");
    const routed = next(proj, answerArgs(ask?.new_intent_command));
    expect(heard(proj, routed), routed.out).toContain(FOR_NEW_WORK);
    expect(heard(proj, routed), routed.out).not.toContain(STARTS_ON);
    const made = createFromPrint(proj, routed);
    expect(made.status, made.stderr).toBe(0);
    expect(guardsOff(activeState(proj))).toContain("review-freeze");
    // Creation selects the new work, and the line still reaches the person: its
    // first step says it, as the live run showed it must.
    const onNewWork = next(proj, []);
    expect(heard(proj, onNewWork), onNewWork.out).toContain(FOR_NEW_WORK);
    // The work the person did not ask about keeps its checks.
    expect(readFileSync(join(intents(proj), open, "aidlc-state.md"), "utf-8")).toBe(openBefore);
  });

  test("under a scope whose plan keeps the check on, the new work still starts with it off", () => {
    const { proj } = oneOpenRecord();
    holdAtGate(proj);
    reply(proj, TYPED);
    const first = next(proj, ["--guard.review-freeze", "off", "--", "fix the parser"]);
    const routing = next(proj, ["--request", requestIn(first.directive?.message, first.out)]);
    const ask = routing.directive as { scope_commands?: Array<{ scope: string; command: string }> } | null;
    // The person names a plan of their own instead of the proposed one: its
    // Guard Policy is strict, so only their typed off can lower the check.
    const strict = ask?.scope_commands?.find((row) => row.scope === "enterprise");
    const routed = next(proj, answerArgs(strict?.command));
    expect(heard(proj, routed), routed.out).toContain(FOR_NEW_WORK);
    const made = createFromPrint(proj, routed);
    expect(made.status, made.stderr).toBe(0);
    const state = activeState(proj);
    expect(getField(state, "Guard Policy") ?? "").toContain("strict");
    expect(guardsOff(state)).toContain("review-freeze");
    const disabled = readAuditShardEvents(proj).filter((row) => row.event === "GUARD_DISABLED");
    expect(disabled.length).toBeGreaterThan(0);
  });

  // The Kiro CLI live run: the agent asked its own question before running the
  // engine's, the person answered it, and that turn dropped the line they had
  // not heard yet. A line still waiting follows them into their next turn.
  test("the line survives a question the agent asked in between, and the engine's own question says it", () => {
    const { proj } = oneOpenRecord();
    holdAtGate(proj);
    expect(reply(proj, TYPED)).toContain(FOR_THE_REQUEST);
    // The engine hands the words on, with no line of its own to speak yet.
    const handedOn = next(proj, ["--guard.review-freeze", "off", "--", "fix the parser"]);
    const request = requestIn(handedOn.directive?.message, handedOn.out);
    // The agent asks its own question first; the person answers it. That turn is
    // what used to drop the line before any step could say it.
    reply(proj, "it's a separate new piece of work");
    const routing = next(proj, ["--request", request]);
    expect((routing.directive as { ask_type?: string } | null)?.ask_type, routing.out).toBe("new-work-routing");
    expect(heard(proj, routing), routing.out).toContain(FOR_THE_REQUEST);
  });

  test("the note tells the agent to say the line, never that it need not", () => {
    const { proj } = oneOpenRecord();
    const note = reply(proj, TYPED);
    expect(note).toContain(FOR_THE_REQUEST);
    expect(note).toContain("Say that line to the person in your reply");
    expect(note).toContain("never run a setter for it");
    expect(note).not.toContain("need not repeat");
  });

  test("the person hears the line with the question the engine asks about it", () => {
    const { proj } = oneOpenRecord();
    reply(proj, TYPED);
    const routing = next(proj, ["--guard.review-freeze", "off", "--", "fix the parser"]);
    expect(heard(proj, routing), routing.out).toContain(FOR_THE_REQUEST);
  });
});

describe("a check typed off before any work exists", () => {
  test("the person hears it on the step that follows, in every tool", () => {
    const proj = emptyProject();
    expect(reply(proj, "/aidlc --guard.review-freeze off")).toContain(FOR_WORK_STARTING_NOW);
    // The agent runs `next`, as its skill says; the line must reach the person
    // from the engine, not only from a host that shows hook output.
    const step = next(proj, ["--guard.review-freeze", "off"]);
    expect(heard(proj, step), step.out).toContain(FOR_WORK_STARTING_NOW);
  });

  // The live symptom was a switch "spent at creation without applying": the work
  // was created under a plan that already lowers the check, so nothing recorded
  // that the person had turned it off, and raising the policy later would have
  // quietly turned it back on.
  test("the work it creates records it as theirs even when that plan already lowers the check", () => {
    const proj = emptyProject();
    expect(reply(proj, "/aidlc --guard.review-freeze off")).toContain(FOR_WORK_STARTING_NOW);
    const printed = next(proj, ["--scope", "poc", "--", "build the export"]);
    const made = createFromPrint(proj, printed);
    expect(made.status, made.stderr).toBe(0);
    const state = activeState(proj);
    expect(getField(state, "Guard Policy") ?? "").toContain("off");
    expect(guardsOff(state)).toContain("review-freeze");
    expect(readAuditShardEvents(proj).filter((row) => row.event === "GUARD_DISABLED").length).toBeGreaterThan(0);
  });
});

describe("a setter the person runs in their own terminal", () => {
  const ASKED = "show me the status";
  test.skipIf(!hasPty)("is their own act, and quotes no chat message", () => {
    const proj = openWork();
    reply(proj, ASKED);
    // The person typed this command at their own terminal.
    const off = atATerminal(proj, ["guard.state-transition", "off"]);
    expect(off.status, off.out).toBe(0);
    expect(off.out).not.toContain(ASKED);
    expect(off.out).not.toContain("as you asked in the chat");
    expect(off.out).toContain("The state transition check is off for this piece of work, set by you.");
    expect(guardsOff(readFileSync(seededStateFile(proj), "utf-8"))).toContain("state-transition");
    const disabled = readAuditShardEvents(proj).filter((row) => row.event === "GUARD_DISABLED");
    expect(disabled).toHaveLength(1);
    expect(auditBlockField(disabled[0].block, "Person Reply")).toBeNull();
  });

  test("run by the agent for what they asked in the chat, their words stand behind it", () => {
    const proj = openWork();
    reply(proj, ASKED);
    // The agent's own tool call: pipes, no terminal of theirs behind it.
    const off = configSet(proj, ["guard.state-transition", "off"], null);
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain(`because you said: "${ASKED}"`);
    const disabled = readAuditShardEvents(proj).filter((row) => row.event === "GUARD_DISABLED");
    expect(auditBlockField(disabled[0].block, "Person Reply")).toBe(ASKED);
  });
});

// Copilot in VS Code, Kiro IDE and Cursor run their agent's commands in real
// integrated terminals, so a terminal alone says nothing about who typed the
// command. Every one of those marks reads as the agent, never as the person.
describe("a terminal that the person's own tool runs", () => {
  const ASKED = "turn the state transition check off";
  /** `engine config set` as the agent runs it in a host's own terminal. */
  const inHostTerminal = (proj: string, mark: Record<string, string | undefined>): { status: number; out: string } => {
    const env: Record<string, string | undefined> = {
      ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj,
      // Both ends a terminal, as an integrated terminal is.
      AIDLC_TEST_CONFIG_TTY: "1",
      ...mark,
    };
    delete env.AIDLC_SESSION_OVERRIDE;
    delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
    delete env.CODEX_THREAD_ID;
    const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", "guard.state-transition", "off", "--project-dir", proj], {
      cwd: proj,
      env: env as NodeJS.ProcessEnv,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };

  test.each([
    { host: "VS Code", mark: { TERM_PROGRAM: "vscode" } },
    { host: "Kiro", mark: { TERM_PROGRAM: "kiro" } },
    { host: "Cursor", mark: { TERM_PROGRAM: "cursor" } },
    { host: "Copilot", mark: { COPILOT_AGENT_ID: "a1" } },
    { host: "Claude Code", mark: { CLAUDECODE: "1" } },
  ])("$host: the switch is the agent's, so their own words stand behind it, never 'set by you'", ({ mark }) => {
    const proj = openWork();
    reply(proj, ASKED);
    const off = inHostTerminal(proj, mark);
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain(`because you said: "${ASKED}"`);
    expect(off.out).not.toContain("set by you.");
  });

  test.each([
    { host: "VS Code", mark: { TERM_PROGRAM: "vscode" } },
    { host: "Kiro", mark: { TERM_PROGRAM: "kiro" } },
    { host: "Cursor", mark: { TERM_PROGRAM: "cursor" } },
  ])("$host: with nobody on record it is refused, and the line says where to ask", ({ host, mark }) => {
    const proj = openWork();
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const refused = inHostTerminal(proj, mark);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain(`To turn the state-transition check off, ask for it in your ${host} chat.`);
    // No environment variable and no third person in what the person reads.
    expect(refused.out).not.toContain("AIDLC_");
    expect(refused.out).not.toContain("the person");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
  });
});

// Finding 1 from the live runs: the authority rule that stops an agent lowering
// one of the person's checks was also applied to the person themselves.
describe("a command the person typed, with no turn of theirs on record", () => {
  test.skipIf(!hasPty)("is carried out, not refused, and reads as theirs", () => {
    const proj = openWork();
    // Nobody has typed in the chat at all: no turn, no words, no bypass.
    const off = atATerminal(proj, ["guard.state-transition", "off"]);
    expect(off.status, off.out).toBe(0);
    expect(off.out).toContain("The state transition check is off for this piece of work, set by you.");
    expect(off.out).not.toContain("No reply from the person has arrived");
    expect(guardsOff(readFileSync(seededStateFile(proj), "utf-8"))).toContain("state-transition");
    const disabled = readAuditShardEvents(proj).filter((row) => row.event === "GUARD_DISABLED");
    expect(disabled).toHaveLength(1);
    expect(auditBlockField(disabled[0].block, "Source")).toBe("you");
    expect(auditBlockField(disabled[0].block, "Person Reply")).toBeNull();
  });

  test.skipIf(!hasPty)("a ceremony they set at their terminal is theirs, not a command's", () => {
    const proj = openWork();
    const off = atATerminal(proj, ["summary-confirmation", "off"]);
    expect(off.status, off.out).toBe(0);
    expect(getField(readFileSync(seededStateFile(proj), "utf-8"), "Summary Confirmation") ?? "")
      .toBe("off (set by you)");
  });

  // The rule itself stands where it belongs: an agent's own tool call arrives
  // with pipes on both ends and no chat identity, and is still refused.
  test("the same command from an agent, with nobody on record, is still refused", () => {
    const proj = openWork();
    const before = readFileSync(seededStateFile(proj), "utf-8");
    const refused = configSet(proj, ["guard.state-transition", "off"], null);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain("No reply from the person has arrived");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(before);
  });
});

// Finding 2 from the live runs: a flag-shaped word in the request threw the
// whole prompt away, so the switch was lost and nothing was said.
describe("a flag-shaped word inside the request", () => {
  test("is part of what they described, and the switch they typed still applies", () => {
    const proj = emptyProject();
    const note = reply(proj, "/aidlc --guard.review-freeze off add a --help flag to the reverser");
    expect(note).toContain(FOR_THE_REQUEST);
    const printed = next(proj, ["--scope", "poc", "--", "add a --help flag to the reverser"]);
    const made = createFromPrint(proj, printed);
    expect(made.status, made.stderr).toBe(0);
    expect(guardsOff(activeState(proj))).toContain("review-freeze");
  });

  // Their switch is readable, so it is carried out: only the part that was not
  // read is named back, and they are never told to retype what worked.
  test("before any words, what was read is still carried out and only the rest is named", () => {
    const proj = emptyProject();
    const note = reply(proj, "/aidlc --guard.review-freeze off --nonsense 1");
    expect(note).toContain(FOR_WORK_STARTING_NOW);
    expect(note).toContain('I could not read "--nonsense"; if that was a setting, type it again on its own.');
    expect(note).not.toContain("Nothing changed");
    // And it really did apply: the work they start next has the check off.
    const printed = next(proj, ["--scope", "poc", "--", "build the export"]);
    const made = createFromPrint(proj, printed);
    expect(made.status, made.stderr).toBe(0);
    expect(guardsOff(activeState(proj))).toContain("review-freeze");
  });

  test("the same setting typed twice with two values is put back to them once", () => {
    const proj = emptyProject();
    const note = reply(proj, "/aidlc --guard-policy relaxed --change-control off");
    expect(note).toContain("Nothing changed: you typed Guard Policy twice in that command, as relaxed and off.");
    expect(note).toContain("Which did you mean?");
  });

  test("a setting with no value after it says which flag is missing one", () => {
    const proj = emptyProject();
    const note = reply(proj, "/aidlc --guard.review-freeze off --depth");
    expect(note).toContain('Nothing changed: "--depth" came with no value.');
    // The way out echoes the switch they typed readably.
    expect(note).toContain("--guard.review-freeze off");
  });
});

describe("a project switch with no words of theirs on record", () => {
  test("says only that the check is off, since when, and how to turn it back on", () => {
    const line = switchOffLine({
      name: "AIDLC_DISABLE_REVIEW_FREEZE_HOOK",
      target: "local",
      settingsPath: "/nonexistent",
      entry: {
        name: "AIDLC_DISABLE_REVIEW_FREEZE_HOOK",
        target: "local",
        since: new Date(2026, 9, 7, 10, 7, 0).toISOString(),
        how: "chat",
      },
    }, new Date(2026, 9, 7, 12, 0, 0));
    expect(line).toContain("The review freeze check is off for this project since 10:07.");
    expect(line).not.toContain("your last message");
  });
});
