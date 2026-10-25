// covers: function:applyIntentSettings, function:settingTheirs, function:saidInChat, function:proveMessage, subcommand:aidlc-utility:config-change, audit:CEREMONY_SET, audit:GUARD_POLICY_SET, audit:GUARD_DISABLED
//
// A setting the agent runs the setter for is the person's ("set by you", their
// whole words and the message's id on the row) only when the agent, which read
// the chat, names the message they asked in with --message, and the engine
// proves that message is a reply of theirs, in this chat, not spent by a later
// decision. It never compares or reads words. Words the agent passes itself
// (--person-words, --person-words-file) are its own text and earn nothing: the
// setting is still applied as asked and recorded as the command's, and a
// lowering on them alone is refused with the retry that names their message.
// A team's strict Guard Policy still refuses an explicit relaxed.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, followProposal, REPO_ROOT, removeWorkspaceRecord, runOrchestrateNext,
  seedAidlcMemory,
} from "../harness/fixtures.ts";
import {
  auditBlockField, getField, hooksHealthDir, lowerFenceRemedy, lowerFenceSentence, MESSAGE_FILL, MESSAGE_SLOT,
  readAuditShardEvents, setGuardsOffLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { guardOperationMatchesCommand } from "../../dist/claude/.claude/tools/aidlc-guard-operation.ts";
import { SWITCHABLE_GUARD_FENCES } from "../../dist/claude/.claude/tools/aidlc-guard-fences.ts";
import { listMessages } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SESSION = "01995000-7a11-7000-8000-000000000053";
// The slot a printed step leaves for the id of the message that asked.
const SLOT = `--message '${MESSAGE_SLOT}'`;
const OTHER = "01995000-7a11-7000-8000-000000000054";
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_UNATTENDED: "0",
  AIDLC_DISABLE_COLLABORATORS: "0",
  AIDLC_DISABLE_SENSORS: "0",
  AIDLC_DISABLE_REVIEW_FREEZE_HOOK: "0",
  AIDLC_DISABLE_STATE_TRANSITION_GUARD: "0",
};

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

function env(proj: string, session: string): NodeJS.ProcessEnv {
  return { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: session, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
}

function configSet(proj: string, args: string[], session = SESSION): { status: number; out: string } {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "config", "set", ...args, "--project-dir", proj], {
    cwd: proj,
    env: env(proj, session),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function utility(proj: string, args: string[], session = SESSION): { status: number; out: string } {
  const result = spawnSync(BUN, [UTILITY, ...args, "--project-dir", proj], {
    cwd: proj,
    env: env(proj, session),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// The person types `prompt` in this chat; the shipped human-turn hook keeps it.
// Returns the id of the message it kept: the one record new in the store, which
// holds it before any work exists too.
function said(proj: string, prompt: string, session = SESSION): string {
  const before = new Set(listMessages(proj).map((message) => message.id));
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
    env: env(proj, session),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
  const kept = listMessages(proj).filter((message) => !before.has(message.id));
  expect(kept).toHaveLength(1);
  return kept[0].id;
}

/** Work in progress on the enterprise plan (strict, sensors on), in this chat. */
function project(): { proj: string; path: string; state: () => string } {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  const made = utility(proj, ["intent-create", "--scope", "enterprise", "--arguments", "set by you fixture", "--label", "set-by-you"]);
  expect(made.status, made.out).toBe(0);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  const path = join(intents, active, "aidlc-state.md");
  return { proj, path, state: () => readFileSync(path, "utf-8") };
}

function rows(proj: string, event: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === event);
}

describe("an agent's setter after a reply that never asked for it is the command's", () => {
  test("a ceremony: off, set by a command, no words on the row", () => {
    const { proj, state } = project();
    said(proj, "looks good, carry on");
    const set = configSet(proj, ["sensors", "off"]);
    expect(set.status, set.out).toBe(0);
    expect(set.out).toContain("off (set by a command)");
    expect(getField(state(), "Sensors")).toBe("off (set by a command)");
    const row = rows(proj, "CEREMONY_SET").at(-1)!;
    expect(auditBlockField(row.block, "Source")).toBe("command");
    expect(auditBlockField(row.block, "Person Reply")).toBeNull();
  });

  test("Guard Policy strict: set by a command", () => {
    const { proj, state } = project();
    const relax = said(proj, "relax the guards");
    expect(configSet(proj, ["guard-policy", "relaxed", "--message", relax]).status).toBe(0);
    said(proj, "looks good, carry on");
    const set = configSet(proj, ["guard-policy", "strict"]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Guard Policy")).toBe("strict (set by a command)");
    expect(auditBlockField(rows(proj, "GUARD_POLICY_SET").at(-1)!.block, "Source")).toBe("command");
  });

  // A lowering with no message named is the agent's to retry: the refusal names
  // their message by id and time, never its words, and nothing changes.
  test("a check off: refused naming their message by id, never their unrelated reply as the reason", () => {
    const { proj, state } = project();
    const id = said(proj, "show me the status");
    const before = getField(state(), "Guards Off");
    const set = configSet(proj, ["guard.state-transition", "off"]);
    expect(set.status, set.out).not.toBe(0);
    expect(set.out).toContain("Turning the state-transition check off is the person's call.");
    expect(set.out).toContain(`If their message ${id} (sent `);
    expect(set.out).toContain("run the same command with --message <id>");
    expect(set.out).not.toContain("show me the status");
    expect(set.out).not.toContain("as you asked in the chat");
    expect(getField(state(), "Guards Off")).toBe(before);
    expect(rows(proj, "GUARD_DISABLED")).toHaveLength(0);
    expect(utility(proj, ["status"]).out).not.toMatch(/state.transition[^\n]*set by you/i);
  });
});

describe("the agent names their message with --message, and the tool proves it", () => {
  test("a ceremony asked for in plain words: set by you, the record's words and the id on the row", () => {
    const { proj, state } = project();
    const id = said(proj, "please   turn the sensors off");
    const set = configSet(proj, ["sensors", "off", "--message", id]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
    const row = rows(proj, "CEREMONY_SET").at(-1)!;
    expect(auditBlockField(row.block, "Source")).toBe("you");
    expect(auditBlockField(row.block, "Person Reply")).toBe("please   turn the sensors off");
    expect(auditBlockField(row.block, "Message Id")).toBe(id);
  });

  test("a check asked off in plain words: said with their words, and the line is theirs", () => {
    const { proj, state } = project();
    const id = said(proj, "turn the state transition check off");
    const set = configSet(proj, ["guard.state-transition", "off", "--message", id]);
    expect(set.status, set.out).toBe(0);
    expect(set.out).toContain('because you said: "turn the state transition check off"');
    expect(getField(state(), "Guards Off")).toBe("state-transition (set by you)");
    expect(auditBlockField(rows(proj, "GUARD_DISABLED").at(-1)!.block, "Person Reply")).toBe("turn the state transition check off");
  });

  test("Guard Policy strict asked for: set by you", () => {
    const { proj, state } = project();
    const relax = said(proj, "relax the guards");
    expect(configSet(proj, ["guard-policy", "relaxed", "--message", relax]).status).toBe(0);
    const strict = said(proj, "make it strict again");
    expect(configSet(proj, ["guard-policy", "strict", "--message", strict]).status).toBe(0);
    expect(getField(state(), "Guard Policy")).toBe("strict (set by you)");
  });

  // Only the id passes through the shell, so a reply with a quote or a $ is
  // kept whole from the message record.
  test("a reply with a quote and a $ is kept whole by its id: set by you", () => {
    const { proj, state } = project();
    const words = "I don't need the $SENSORS today, turn them off";
    const id = said(proj, words);
    const set = configSet(proj, ["sensors", "off", "--message", id]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
    expect(auditBlockField(rows(proj, "CEREMONY_SET").at(-1)!.block, "Person Reply")).toBe(words);
  });

  // The words file from before --message is still read and removed, and what
  // it holds is the agent's own text: it sits in the record the chat is on,
  // and the setter, the new work and the recompose read it the same way.
  const wordsFile = (proj: string, words: string): string => {
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
    const file = ".aidlc-engine/answer-text/answer.txt";
    mkdirSync(join(record, ".aidlc-engine", "answer-text"), { recursive: true });
    writeFileSync(join(record, file), `${words}\n`, "utf-8");
    return join(record, file);
  };

  test("their words in a file: the agent's own text, set by a command, the file read and removed", () => {
    const { proj, state } = project();
    const words = "I don't need the $SENSORS today, turn them off";
    said(proj, words);
    const written = wordsFile(proj, words);
    const set = configSet(proj, ["sensors", "off", "--person-words-file", ".aidlc-engine/answer-text/answer.txt"]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by a command)");
    const row = rows(proj, "CEREMONY_SET").at(-1)!;
    expect(auditBlockField(row.block, "Person Reply")).toBeNull();
    expect(auditBlockField(row.block, "Conductor Summary")).toBe(words);
    expect(existsSync(written)).toBe(false);
  });

  test("their words in a file at creation: the new work's setting is the command's, the file read and removed", () => {
    const { proj } = project();
    const words = "Build the export, and don't run the sensors";
    said(proj, words);
    const written = wordsFile(proj, words);
    const made = utility(proj, [
      "intent-create", "--scope", "bugfix", "--arguments", "build the export", "--label", "export",
      "--sensors", "off", "--person-words-file", ".aidlc-engine/answer-text/answer.txt",
    ]);
    expect(made.status, made.out).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    expect(getField(readFileSync(join(intents, active, "aidlc-state.md"), "utf-8"), "Sensors")).toBe("off (set by a command)");
    expect(existsSync(written)).toBe(false);
  });

  test("their words in a file for recompose: the settings land as the command's, the file read and removed", () => {
    const { proj, state } = project();
    const words = "Approve, and don't run the sensors";
    said(proj, words);
    const written = wordsFile(proj, words);
    const reshaped = utility(proj, [
      "recompose", "--skip", "market-research", "--sensors", "off", "--person-words-file", ".aidlc-engine/answer-text/answer.txt",
    ]);
    expect(reshaped.status, reshaped.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by a command)");
    expect(existsSync(written)).toBe(false);
  });

  test("their whole reply passed as words earns nothing: applied, set by a command, kept as the agent's text", () => {
    const { proj, state } = project();
    said(proj, "please turn the sensors off");
    const set = configSet(proj, ["sensors", "off", "--person-words", "please turn the sensors off"]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by a command)");
    const row = rows(proj, "CEREMONY_SET").at(-1)!;
    expect(auditBlockField(row.block, "Person Reply")).toBeNull();
    expect(auditBlockField(row.block, "Message Id")).toBeNull();
    expect(auditBlockField(row.block, "Conductor Summary")).toBe("please turn the sensors off");
  });

  // A message any chat of this piece of work sent stands, as for an answer.
  test("a message sent in another chat of this work is theirs, named by the setter", () => {
    const { proj, state } = project();
    const theirs = said(proj, "please turn the sensors off", OTHER);
    said(proj, "looks good");
    const set = configSet(proj, ["sensors", "off", "--message", theirs]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  // A check the agent turns off from the chat always has their message behind
  // it, so the command's check is written on the line as a run under a test
  // bypass leaves it.
  test("a line of checks says set by you only while every check on it is theirs", () => {
    const { proj, state } = project();
    const id = said(proj, "turn the review freeze off");
    expect(configSet(proj, ["guard.review-freeze", "off", "--message", id]).status).toBe(0);
    expect(getField(state(), "Guards Off")).toBe("review-freeze (set by you)");
    const other = project();
    writeFileSync(other.path, setGuardsOffLine(other.state(), ["state-transition"], "command"));
    const later = said(other.proj, "turn the review freeze off");
    const set = configSet(other.proj, ["guard.review-freeze", "off", "--message", later]);
    expect(set.status, set.out).toBe(0);
    expect(getField(other.state(), "Guards Off")).toBe("review-freeze, state-transition (set by a command)");
  });
});

describe("a setting the agent sends through next names their message", () => {
  const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
  const step = (proj: string, args: string[]): string => {
    const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: env(proj, SESSION) });
    expect(result.status, result.out).toBe(0);
    return String((result.directive as { message?: unknown } | null)?.message);
  };
  // The command the step names, with the agent's id in the slot.
  const filled = (named: string, id: string): string[] => named.replace(SLOT, `--message ${id}`).split(" ");
  const runNamed = (proj: string, message: string, id: string): { status: number; out: string } => {
    const named = /Run `[^`]*? engine config set ([^`]+)` to update the configuration/.exec(message)?.[1];
    expect(named, message).toBeDefined();
    return configSet(proj, filled(named!, id));
  };

  test("please turn the sensors off, sent as next --sensors off: the step names their message, and it is theirs", () => {
    const { proj, state } = project();
    const id = said(proj, "please turn the sensors off");
    const message = step(proj, ["--sensors", "off"]);
    expect(message).toContain(`config set sensors off ${SLOT}\` to update the configuration${MESSAGE_FILL} (${id}, sent `);
    const set = runNamed(proj, message, id);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
    const row = rows(proj, "CEREMONY_SET").at(-1)!;
    expect(auditBlockField(row.block, "Person Reply")).toBe("please turn the sensors off");
    expect(auditBlockField(row.block, "Message Id")).toBe(id);
  });

  test("typed on their line, the step names the setter alone, as before", () => {
    const { proj, state } = project();
    said(proj, "/aidlc --sensors off");
    const message = step(proj, ["--sensors", "off"]);
    expect(message).toContain("config set sensors off` to update the configuration");
    expect(message).not.toContain("--message");
    expect(configSet(proj, ["sensors", "off"]).status).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  test("a depth says no one's name, so its step names no message", () => {
    const { proj } = project();
    said(proj, "go deeper on this one");
    expect(step(proj, ["--depth", "comprehensive"])).not.toContain("--message");
  });

  test("a stage skipped beside the setting in one reply: the step still names their message, and it is theirs", () => {
    const { proj, state } = project();
    const id = said(proj, "skip market research and turn the sensors off");
    const message = step(proj, ["--skip", "market-research", "--sensors", "off"]);
    expect(message).toContain(`config set sensors off ${SLOT}\`${MESSAGE_FILL} (${id}, sent `);
    expect(message).toContain("recompose --skip market-research");
    const named = /`[^`]*? engine config set ([^`]+)`/.exec(message)![1];
    const set = configSet(proj, filled(named, id));
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  test("a plan switch with a setting in one reply: the scope change names their message, and the setting is theirs", () => {
    const { proj, state } = project();
    const id = said(proj, "switch this to the feature plan and turn the sensors off");
    const message = step(proj, ["--scope", "feature", "--sensors", "off"]);
    expect(message).toContain(`scope change --scope feature --sensors off ${SLOT}\` to change scope${MESSAGE_FILL} (${id}, sent `);
    const named = /`[^`]*? engine scope change ([^`]+)`/.exec(message)![1];
    const args = filled(named, id);
    const result = spawnSync(BUN, [DISPATCHER, "engine", "scope", "change", ...args, "--project-dir", proj], {
      cwd: proj, env: env(proj, SESSION), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(getField(state(), "Scope")).toBe("feature");
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  // New work from their words: the plan offer, their pick, then the engine's
  // own creation command. The first message is the one that asked.
  const startWork = (prompt: string, args: string[]): { proj: string; message: string; asked: string } => {
    const proj = createTestProject();
    created.push(proj);
    seedAidlcMemory(proj);
    removeWorkspaceRecord(proj);
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    const asked = said(proj, prompt);
    const options = { env: env(proj, SESSION) };
    const offer = followProposal(runOrchestrateNext(ORCHESTRATE, proj, args, options), ORCHESTRATE, proj, options);
    const confirm = String((offer.directive as { confirm_command?: unknown } | null)?.confirm_command);
    expect(confirm, offer.out).toContain(" next --scope ");
    said(proj, "yes, that plan");
    const made = runOrchestrateNext(ORCHESTRATE, proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" "), options);
    return { proj, asked, message: String((made.directive as { message?: unknown } | null)?.message) };
  };
  const createdField = (proj: string, field: string): string | null => {
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    return getField(readFileSync(join(intents, active, "aidlc-state.md"), "utf-8"), field);
  };
  const DESCRIPTION = "Fix the login crash when the session expires";

  test("new work asked for in plain words with a setting: the creation names their message, and it is theirs", () => {
    const { proj, message, asked } = startWork(
      `${DESCRIPTION}, and do not stop to ask me about the code plan`, ["--plan-approval", "off", DESCRIPTION],
    );
    expect(message).toContain(`--plan-approval off ${SLOT}\` to start the workflow`);
    expect(message).toContain(MESSAGE_FILL);
    expect(message).toContain(`${asked}, sent `);
    const command = /`[^`]*? engine intent create ([^`]+)`/.exec(message)![1]
      .replace('--label "<2-3 word kebab essence>"', "--label login-crash")
      .replace(SLOT, `--message ${asked}`)
      .split(" ");
    const made = utility(proj, ["intent-create", ...command]);
    expect(made.status, made.out).toBe(0);
    expect(createdField(proj, "Plan Approval")).toBe("off (set by you)");
  });

  test("new work typed with a setting: the creation names no message, and it is theirs", () => {
    const { proj, message } = startWork(`/aidlc --plan-approval off ${DESCRIPTION}`, ["--plan-approval", "off", DESCRIPTION]);
    expect(message).toContain("--plan-approval off` to start the workflow");
    expect(message).not.toContain("--message");
    const command = /`[^`]*? engine intent create ([^`]+)`/.exec(message)![1]
      .replace('--label "<2-3 word kebab essence>"', "--label login-crash")
      .split(" ");
    const made = utility(proj, ["intent-create", ...command]);
    expect(made.status, made.out).toBe(0);
    expect(createdField(proj, "Plan Approval")).toBe("off (set by you)");
  });

  test("a plan switch alone names no message", () => {
    const { proj } = project();
    said(proj, "switch this to the feature plan");
    expect(step(proj, ["--scope", "feature"])).not.toContain("--message");
  });
});

describe("every step that names the setter for the person's yes names their message", () => {
  const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
  const FILL = MESSAGE_FILL;
  const message = (proj: string, args: string[]): string => {
    const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: env(proj, SESSION) });
    expect(result.status, result.out).toBe(0);
    return String((result.directive as { message?: unknown } | null)?.message);
  };

  test("a guard's prose offer and its turn-it-off choice", () => {
    for (const fence of SWITCHABLE_GUARD_FENCES) {
      const sentence = lowerFenceSentence(fence);
      expect(sentence, fence).toMatch(new RegExp(`guard\\.${fence} off ${SLOT}\` yourself`));
      expect(sentence, fence).toContain(FILL);
      const remedy = lowerFenceRemedy(fence);
      expect(remedy.action, fence).toContain(SLOT);
      expect(remedy.action, fence).toContain(FILL);
      expect(guardOperationMatchesCommand(remedy.operation!, remedy.command!), fence).toBe(true);
    }
  });

  test("before any work, a setting sent through next names their message, and the kept line is theirs", () => {
    const proj = createTestProject();
    created.push(proj);
    seedAidlcMemory(proj);
    removeWorkspaceRecord(proj);
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    const asked = said(proj, "turn the sensors off for the next piece of work");
    const step = message(proj, ["--sensors", "off"]);
    expect(step).toContain(`config set sensors off ${SLOT}\` to keep these settings for the piece of work the person starts next${FILL}`);
    const kept = configSet(proj, ["sensors", "off", "--message", asked]);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.out).toContain("(set by you)");
  });

  test("the in-flight composer's approve step names their message for recompose and summary confirmation", () => {
    const { proj } = project();
    said(proj, "turn sensors off");
    const step = message(proj, ["compose", "turn sensors off"]);
    expect(step).toContain(`[approved setting flags ${SLOT}]\``);
    expect(step).toContain(`config set summary-confirmation off ${SLOT}\``);
    expect(step).toContain(FILL);
  });

  test("recompose takes their message: the settings they approved land as theirs", () => {
    const { proj, state } = project();
    const id = said(proj, "Approve all");
    const reshaped = utility(proj, ["recompose", "--skip", "market-research", "--sensors", "off", "--message", id]);
    expect(reshaped.status, reshaped.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  test("code generation's turn-it-back-on row names their message", () => {
    const stage = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "stages", "construction", "code-generation.md"), "utf-8");
    expect(stage).toContain(`config set plan-approval on --message ${MESSAGE_SLOT}\``);
  });

  // Said when the words kept since the plan question hold no reply to it: their
  // yes to plan approval off is the ask, by the message it came in.
  test("the plan question's 'if they want plan approval off' line names their message", () => {
    const tool = readFileSync(join(AIDLC_SRC, "tools", "aidlc-plan-approval-ask.ts"), "utf-8");
    const at = tool.indexOf("If they want plan approval");
    expect(at).toBeGreaterThan(-1);
    const line = tool.slice(at, at + 400);
    expect(line).toContain('config set guard.plan-approval off")} --message');
    expect(line).toContain("MESSAGE_SLOT");
    expect(line).toContain("messageFill(projectDir)");
  });
});

describe("who may lower a check is unchanged", () => {
  test("an unasked Guard Policy relaxed is still a lowering, refused with no turn of theirs", () => {
    const { proj, state } = project();
    const refused = configSet(proj, ["guard-policy", "relaxed"]);
    // The project fixture has no turn of theirs since the work began.
    expect(refused.status, refused.out).not.toBe(0);
    expect(getField(state(), "Guard Policy")).not.toContain("relaxed");
  });

  test("a team's strict Guard Policy still refuses an explicit relaxed, their message named or not", () => {
    const { proj, state } = project();
    const memory = join(proj, "aidlc", "spaces", "default", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "project.md"), "# Project\n\n## Guard Policy\n\nMode: strict\n");
    const id = said(proj, "relax the guards");
    const refused = configSet(proj, ["guard-policy", "relaxed", "--message", id]);
    expect(refused.status, refused.out).not.toBe(0);
    expect(refused.out).toContain("strict");
    expect(getField(state(), "Guard Policy")).not.toContain("relaxed");
  });
});

describe("a typed line and their own terminal stay theirs", () => {
  test("their own terminal makes a setting theirs; the chat half of the rule (saidInChat) reads only the chat", () => {
    const { proj } = project();
    const env: NodeJS.ProcessEnv = { AIDLC_TEST_CONFIG_TTY: "1", AIDLC_PROJECT_DIR: proj };
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^(CLAUDE|CODEX_|CURSOR_|KIRO_|OPENCODE|COPILOT_|VSCODE_|TERM_PROGRAM|AIDLC_SESSION_OVERRIDE)/i.test(key)) {
        env[key] ??= value;
      }
    }
    const tool = JSON.stringify(join(AIDLC_SRC, "tools", "aidlc-guard-switch.ts"));
    const at = JSON.stringify(proj);
    const result = spawnSync(BUN, [
      "-e",
      `const gs = await import(${tool}); console.log(JSON.stringify(` +
        `[gs.settingTheirs(${at}, null, "sensors", "off"), gs.saidInChat(${at}, null, "sensors", "off")]));`,
    ], { cwd: proj, env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([{ words: null }, null]);
  });

  test("a setting typed on their line: set by you with no message named", () => {
    const { proj, state } = project();
    said(proj, "/aidlc --sensors off");
    expect(configSet(proj, ["sensors", "off"]).status).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  test("typed with a request, then their answer to the routing question: still theirs, and no words asked for", () => {
    const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
    const task = "Fix the login crash when the session expires";
    for (const answer of ["1", "carry on with this work"]) {
      const { proj, state } = project();
      said(proj, `/aidlc --learnings off ${task}`);
      const asked = runOrchestrateNext(ORCHESTRATE, proj, ["--learnings", "off", task], { env: env(proj, SESSION) });
      const routing = asked.directive as { ask_type?: string; continue_command?: string };
      expect(routing.ask_type, asked.out).toBe("new-work-routing");
      said(proj, answer);
      // A number or other words: the agent maps the reply to the continue route.
      const route = String(routing.continue_command).split(" ").slice(3);
      const step = runOrchestrateNext(ORCHESTRATE, proj, route, { env: env(proj, SESSION) });
      const message = String((step.directive as { message?: unknown } | null)?.message);
      expect(message).toContain("config set learnings off` to update the configuration");
      expect(message).not.toContain("--message");
      expect(configSet(proj, ["learnings", "off"]).status).toBe(0);
      expect(getField(state(), "Learnings")).toBe("off (set by you)");
    }
  });

  test("typed with a request, then the routing question's reshape answer: the settings land as theirs", () => {
    const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
    const { proj, state } = project();
    const task = "skip the market research for this work";
    said(proj, `/aidlc --sensors off ${task}`);
    const asked = runOrchestrateNext(ORCHESTRATE, proj, ["--sensors", "off", task], { env: env(proj, SESSION) });
    const routing = asked.directive as { ask_type?: string; compose_command?: string };
    expect(routing.ask_type, asked.out).toBe("new-work-routing");
    said(proj, "3");
    // The agent reads "3" and runs the reshape answer's own command.
    const step = runOrchestrateNext(ORCHESTRATE, proj, String(routing.compose_command).split(" ").slice(3), { env: env(proj, SESSION) });
    const message = String((step.directive as { message?: unknown } | null)?.message);
    expect(message).toContain("config set sensors off` to apply the settings typed with this request to the work being reshaped");
    expect(configSet(proj, ["sensors", "off"]).status).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });
});
