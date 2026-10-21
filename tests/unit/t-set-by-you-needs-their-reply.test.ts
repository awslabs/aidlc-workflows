// covers: function:applyIntentSettings, function:settingTheirs, function:saidInChat, function:replyOfTheirs, subcommand:aidlc-utility:config-change, audit:CEREMONY_SET, audit:GUARD_POLICY_SET, audit:GUARD_DISABLED
//
// A setting the agent runs the setter for is the person's ("set by you", their
// words on the row) only when a reply of theirs that asked for it is on record:
// the agent, which read the chat, passes their words with --person-words, and
// the tool finds a reply of theirs in this chat, since the last decision, whose
// words are exactly those (spacing aside). It never reads what the words mean.
// Words that are not a whole reply of theirs earn nothing: the setting is still
// applied as asked and recorded as the command's. Who may lower a check is not
// changed here: an unasked lowering is refused where it was, and a team's
// strict Guard Policy still refuses an explicit relaxed.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, followProposal, REPO_ROOT, removeWorkspaceRecord, runOrchestrateNext,
  seedAidlcMemory,
} from "../harness/fixtures.ts";
import {
  auditBlockField, getField, hooksHealthDir, lowerFenceRemedy, lowerFenceSentence, readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { guardOperationMatchesCommand } from "../../dist/claude/.claude/tools/aidlc-guard-operation.ts";
import { SWITCHABLE_GUARD_FENCES } from "../../dist/claude/.claude/tools/aidlc-guard-fences.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SESSION = "01995000-7a11-7000-8000-000000000053";
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

function said(proj: string, prompt: string, session = SESSION): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
    env: env(proj, session),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

/** Work in progress on the enterprise plan (strict, sensors on), in this chat. */
function project(): { proj: string; state: () => string } {
  const proj = createTestProject();
  created.push(proj);
  seedAidlcMemory(proj);
  const made = utility(proj, ["intent-create", "--scope", "enterprise", "--arguments", "set by you fixture", "--label", "set-by-you"]);
  expect(made.status, made.out).toBe(0);
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  const path = join(intents, active, "aidlc-state.md");
  return { proj, state: () => readFileSync(path, "utf-8") };
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
    said(proj, "relax the guards");
    expect(configSet(proj, ["guard-policy", "relaxed", "--person-words", "relax the guards"]).status).toBe(0);
    said(proj, "looks good, carry on");
    const set = configSet(proj, ["guard-policy", "strict"]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Guard Policy")).toBe("strict (set by a command)");
    expect(auditBlockField(rows(proj, "GUARD_POLICY_SET").at(-1)!.block, "Source")).toBe("command");
  });

  test("a check off: the setter's own line, never their unrelated reply as the reason", () => {
    const { proj, state } = project();
    said(proj, "show me the status");
    const set = configSet(proj, ["guard.state-transition", "off"]);
    expect(set.status, set.out).toBe(0);
    expect(set.out).not.toContain("show me the status");
    expect(set.out).not.toContain("as you asked in the chat");
    expect(set.out).toContain("is off for this piece of work (logged; back on for the next one)");
    expect(getField(state(), "Guards Off")).toBe("state-transition (set by a command)");
    const row = rows(proj, "GUARD_DISABLED").at(-1)!;
    expect(auditBlockField(row.block, "Source")).toBe("command");
    expect(auditBlockField(row.block, "Person Reply")).toBeNull();
    expect(utility(proj, ["status"]).out).not.toMatch(/state.transition[^\n]*set by you/i);
  });
});

describe("the agent names their reply with --person-words, and the tool proves it", () => {
  test("a ceremony asked for in plain words: set by you, the record's words on the row", () => {
    const { proj, state } = project();
    said(proj, "please   turn the sensors off");
    const set = configSet(proj, ["sensors", "off", "--person-words", "please turn the sensors off"]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
    const row = rows(proj, "CEREMONY_SET").at(-1)!;
    expect(auditBlockField(row.block, "Source")).toBe("you");
    expect(auditBlockField(row.block, "Person Reply")).toBe("please   turn the sensors off");
  });

  test("a check asked off in plain words: said with their words, and the line is theirs", () => {
    const { proj, state } = project();
    said(proj, "turn the state transition check off");
    const set = configSet(proj, ["guard.state-transition", "off", "--person-words", "turn the state transition check off"]);
    expect(set.status, set.out).toBe(0);
    expect(set.out).toContain('because you said: "turn the state transition check off"');
    expect(getField(state(), "Guards Off")).toBe("state-transition (set by you)");
    expect(auditBlockField(rows(proj, "GUARD_DISABLED").at(-1)!.block, "Person Reply")).toBe("turn the state transition check off");
  });

  test("Guard Policy strict asked for: set by you", () => {
    const { proj, state } = project();
    said(proj, "relax the guards");
    expect(configSet(proj, ["guard-policy", "relaxed", "--person-words", "relax the guards"]).status).toBe(0);
    said(proj, "make it strict again");
    expect(configSet(proj, ["guard-policy", "strict", "--person-words", "make it strict again"]).status).toBe(0);
    expect(getField(state(), "Guard Policy")).toBe("strict (set by you)");
  });

  test("their words in another case are still theirs", () => {
    const { proj, state } = project();
    said(proj, "Please Turn The Sensors Off");
    expect(configSet(proj, ["sensors", "off", "--person-words", "please turn the sensors off"]).status).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  // A reply with a quote or a $ goes in a file the agent writes, as an answer's
  // does (--details-file), so no shell reads it on the way.
  test("their words in a file: set by you, the file read and removed", () => {
    const { proj, state } = project();
    const words = "I don't need the $SENSORS today, turn them off";
    said(proj, words);
    const record = dirname(join(proj, "aidlc", "spaces", "default", "intents",
      readFileSync(join(proj, "aidlc", "spaces", "default", "intents", "active-intent"), "utf-8").trim(), "aidlc-state.md"));
    const file = ".aidlc-engine/answer-text/answer.txt";
    mkdirSync(join(record, ".aidlc-engine", "answer-text"), { recursive: true });
    writeFileSync(join(record, file), `${words}\n`, "utf-8");
    const set = configSet(proj, ["sensors", "off", "--person-words-file", file]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
    expect(auditBlockField(rows(proj, "CEREMONY_SET").at(-1)!.block, "Person Reply")).toBe(words);
    expect(existsSync(join(record, file))).toBe(false);
  });

  // The words in a file sit in the record the chat is on; the new work and the
  // recompose read and remove them the same way.
  const wordsFile = (proj: string, words: string): string => {
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const record = join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
    const file = ".aidlc-engine/answer-text/answer.txt";
    mkdirSync(join(record, ".aidlc-engine", "answer-text"), { recursive: true });
    writeFileSync(join(record, file), `${words}\n`, "utf-8");
    return join(record, file);
  };

  test("their words in a file at creation: the new work's setting is theirs, the file read and removed", () => {
    const { proj } = project();
    const words = "Build the export, and don't stop for the code plan";
    said(proj, words);
    const written = wordsFile(proj, words);
    const made = utility(proj, [
      "intent-create", "--scope", "bugfix", "--arguments", "build the export", "--label", "export",
      "--plan-approval", "off", "--person-words-file", ".aidlc-engine/answer-text/answer.txt",
    ]);
    expect(made.status, made.out).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    expect(getField(readFileSync(join(intents, active, "aidlc-state.md"), "utf-8"), "Plan Approval")).toBe("off (set by you)");
    expect(existsSync(written)).toBe(false);
  });

  test("their words in a file for recompose: the settings they approved land as theirs, the file read and removed", () => {
    const { proj, state } = project();
    const words = "Approve, and don't run the sensors";
    said(proj, words);
    const written = wordsFile(proj, words);
    const reshaped = utility(proj, [
      "recompose", "--skip", "market-research", "--sensors", "off", "--person-words-file", ".aidlc-engine/answer-text/answer.txt",
    ]);
    expect(reshaped.status, reshaped.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
    expect(existsSync(written)).toBe(false);
  });

  test("words that are only part of a reply earn nothing: applied, set by a command", () => {
    const { proj, state } = project();
    said(proj, "ok, show me the status");
    const set = configSet(proj, ["sensors", "off", "--person-words", "ok"]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by a command)");
  });

  test("words they never sent, or sent in another chat, earn nothing", () => {
    const { proj, state } = project();
    said(proj, "please turn the sensors off", OTHER);
    said(proj, "looks good");
    expect(configSet(proj, ["sensors", "off", "--person-words", "please turn the sensors off"]).status).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by a command)");
    expect(configSet(proj, ["collaborators", "off", "--person-words", "lead agent only from here"]).status).toBe(0);
    expect(getField(state(), "Collaborators")).toBe("off (set by a command)");
  });

  test("a line of checks says set by you only while every check on it is theirs", () => {
    const { proj, state } = project();
    said(proj, "turn the review freeze off");
    expect(configSet(proj, ["guard.review-freeze", "off", "--person-words", "turn the review freeze off"]).status).toBe(0);
    expect(getField(state(), "Guards Off")).toBe("review-freeze (set by you)");
    expect(configSet(proj, ["guard.state-transition", "off"]).status).toBe(0);
    expect(getField(state(), "Guards Off")).toBe("review-freeze, state-transition (set by a command)");
  });
});

describe("a setting the agent sends through next names their words", () => {
  const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
  const step = (proj: string, args: string[]): string => {
    const result = runOrchestrateNext(ORCHESTRATE, proj, args, { env: env(proj, SESSION) });
    expect(result.status, result.out).toBe(0);
    return String((result.directive as { message?: unknown } | null)?.message);
  };
  const runNamed = (proj: string, message: string, words: string): { status: number; out: string } => {
    const named = /Run `[^`]*? engine config set ([^`]+)` to update the configuration/.exec(message)?.[1];
    expect(named, message).toBeDefined();
    const args = named!.replace(" --person-words '<their words>'", "").split(" ");
    return configSet(proj, [...args, "--person-words", words]);
  };

  test("please turn the sensors off, sent as next --sensors off: the step names their words, and it is theirs", () => {
    const { proj, state } = project();
    said(proj, "please turn the sensors off");
    const message = step(proj, ["--sensors", "off"]);
    expect(message).toContain("config set sensors off --person-words '<their words>'` to update the configuration");
    const set = runNamed(proj, message, "please turn the sensors off");
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
    expect(auditBlockField(rows(proj, "CEREMONY_SET").at(-1)!.block, "Person Reply")).toBe("please turn the sensors off");
  });

  test("typed on their line, the step names the setter alone, as before", () => {
    const { proj, state } = project();
    said(proj, "/aidlc --sensors off");
    const message = step(proj, ["--sensors", "off"]);
    expect(message).toContain("config set sensors off` to update the configuration");
    expect(message).not.toContain("--person-words");
    expect(configSet(proj, ["sensors", "off"]).status).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  test("a depth says no one's name, so its step carries no words", () => {
    const { proj } = project();
    said(proj, "go deeper on this one");
    expect(step(proj, ["--depth", "comprehensive"])).not.toContain("--person-words");
  });

  test("a stage skipped beside the setting in one reply: the step still names their words, and it is theirs", () => {
    const { proj, state } = project();
    const asked = "skip market research and turn the sensors off";
    said(proj, asked);
    const message = step(proj, ["--skip", "market-research", "--sensors", "off"]);
    expect(message).toContain(
      "config set sensors off --person-words '<their words>'`, with <their words> the person's reply that asked for it, " +
        "word for word, and print its output verbatim",
    );
    expect(message).toContain("recompose --skip market-research");
    const named = /`[^`]*? engine config set ([^`]+)`/.exec(message)![1];
    const set = configSet(proj, [...named.replace(" --person-words '<their words>'", "").split(" "), "--person-words", asked]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  test("a plan switch with a setting in one reply: the scope change names their words, and the setting is theirs", () => {
    const { proj, state } = project();
    const asked = "switch this to the feature plan and turn the sensors off";
    said(proj, asked);
    const message = step(proj, ["--scope", "feature", "--sensors", "off"]);
    expect(message).toContain(
      "scope change --scope feature --sensors off --person-words '<their words>'` to change scope, with <their words> " +
        "the person's reply that asked for it, word for word, then print its output verbatim",
    );
    const named = /`[^`]*? engine scope change ([^`]+)`/.exec(message)![1];
    const args = [...named.replace(" --person-words '<their words>'", "").split(" "), "--person-words", asked];
    const result = spawnSync(BUN, [DISPATCHER, "engine", "scope", "change", ...args, "--project-dir", proj], {
      cwd: proj, env: env(proj, SESSION), encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(getField(state(), "Scope")).toBe("feature");
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  // New work from their words: the plan offer, their pick, then the engine's
  // own creation command.
  const startWork = (prompt: string, args: string[]): { proj: string; message: string } => {
    const proj = createTestProject();
    created.push(proj);
    seedAidlcMemory(proj);
    removeWorkspaceRecord(proj);
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    said(proj, prompt);
    const options = { env: env(proj, SESSION) };
    const offer = followProposal(runOrchestrateNext(ORCHESTRATE, proj, args, options), ORCHESTRATE, proj, options);
    const confirm = String((offer.directive as { confirm_command?: unknown } | null)?.confirm_command);
    expect(confirm, offer.out).toContain(" next --scope ");
    said(proj, "yes, that plan");
    const made = runOrchestrateNext(ORCHESTRATE, proj, confirm.slice(confirm.indexOf(" next ") + 6).split(" "), options);
    return { proj, message: String((made.directive as { message?: unknown } | null)?.message) };
  };
  const createdField = (proj: string, field: string): string | null => {
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    return getField(readFileSync(join(intents, active, "aidlc-state.md"), "utf-8"), field);
  };
  const DESCRIPTION = "Fix the login crash when the session expires";

  test("new work asked for in plain words with a setting: the creation names their words, and it is theirs", () => {
    const asked = `${DESCRIPTION}, and do not stop to ask me about the code plan`;
    const { proj, message } = startWork(asked, ["--plan-approval", "off", DESCRIPTION]);
    expect(message).toContain(
      "--plan-approval off --person-words '<their words>'` to start the workflow",
    );
    expect(message).toContain(", with <their words> the person's reply that asked for it, word for word, then re-run `next`");
    const command = /`[^`]*? engine intent create ([^`]+)`/.exec(message)![1]
      .replace('--label "<2-3 word kebab essence>"', "--label login-crash")
      .replace(" --person-words '<their words>'", "")
      .split(" ");
    const made = utility(proj, ["intent-create", ...command, "--person-words", asked]);
    expect(made.status, made.out).toBe(0);
    expect(createdField(proj, "Plan Approval")).toBe("off (set by you)");
  });

  test("new work typed with a setting: the creation names no words, and it is theirs", () => {
    const { proj, message } = startWork(`/aidlc --plan-approval off ${DESCRIPTION}`, ["--plan-approval", "off", DESCRIPTION]);
    expect(message).toContain("--plan-approval off` to start the workflow");
    expect(message).not.toContain("--person-words");
    const command = /`[^`]*? engine intent create ([^`]+)`/.exec(message)![1]
      .replace('--label "<2-3 word kebab essence>"', "--label login-crash")
      .split(" ");
    const made = utility(proj, ["intent-create", ...command]);
    expect(made.status, made.out).toBe(0);
    expect(createdField(proj, "Plan Approval")).toBe("off (set by you)");
  });

  test("a plan switch alone names no words", () => {
    const { proj } = project();
    said(proj, "switch this to the feature plan");
    expect(step(proj, ["--scope", "feature"])).not.toContain("--person-words");
  });
});

describe("every step that names the setter for the person's yes names their words", () => {
  const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
  const SLOT = "--person-words '<their words>'";
  const FILL = ", with <their words> the person's reply that asked for it, word for word";
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

  test("before any work, a setting sent through next names their words, and the kept line is theirs", () => {
    const proj = createTestProject();
    created.push(proj);
    seedAidlcMemory(proj);
    removeWorkspaceRecord(proj);
    const health = hooksHealthDir(proj);
    mkdirSync(health, { recursive: true });
    writeFileSync(join(health, "record-human-turn.last"), new Date().toISOString());
    const asked = "turn the sensors off for the next piece of work";
    said(proj, asked);
    const step = message(proj, ["--sensors", "off"]);
    expect(step).toContain(`config set sensors off ${SLOT}\` to keep these settings for the piece of work the person starts next${FILL}`);
    const kept = configSet(proj, ["sensors", "off", "--person-words", asked]);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.out).toContain("(set by you)");
  });

  test("the in-flight composer's approve step names their words for recompose and summary confirmation", () => {
    const { proj } = project();
    said(proj, "turn sensors off");
    const step = message(proj, ["compose", "turn sensors off"]);
    expect(step).toContain(`[approved setting flags ${SLOT}]\``);
    expect(step).toContain(`config set summary-confirmation off ${SLOT}\``);
    expect(step).toContain(FILL);
  });

  test("recompose takes their words: the settings they approved land as theirs", () => {
    const { proj, state } = project();
    said(proj, "Approve all");
    const reshaped = utility(proj, ["recompose", "--skip", "market-research", "--sensors", "off", "--person-words", "Approve all"]);
    expect(reshaped.status, reshaped.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });

  test("code generation's turn-it-back-on row names their words", () => {
    const stage = readFileSync(join(REPO_ROOT, "core", "aidlc-common", "stages", "construction", "code-generation.md"), "utf-8");
    expect(stage).toContain(`config set plan-approval on ${SLOT}\``);
  });

  // Said when the words kept since the plan question hold no reply to it: their
  // yes to plan approval off is the ask, with their words.
  test("the plan question's 'if they want plan approval off' line names their words", () => {
    const tool = readFileSync(join(AIDLC_SRC, "tools", "aidlc-plan-approval-ask.ts"), "utf-8");
    const at = tool.indexOf("If they want plan approval");
    expect(at).toBeGreaterThan(-1);
    const line = tool.slice(at, at + 400);
    expect(line).toContain('config set guard.plan-approval off")} --person-words');
    expect(line).toContain("PERSON_WORDS_SLOT");
    expect(line).toContain("PERSON_WORDS_FILL");
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

  test("a team's strict Guard Policy still refuses an explicit relaxed, words or not", () => {
    const { proj, state } = project();
    const memory = join(proj, "aidlc", "spaces", "default", "memory");
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "project.md"), "# Project\n\n## Guard Policy\n\nMode: strict\n");
    said(proj, "relax the guards");
    const refused = configSet(proj, ["guard-policy", "relaxed", "--person-words", "relax the guards"]);
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

  test("a setting typed on their line: set by you without --person-words", () => {
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
      // A number answers the question itself; other words are the agent's to map to the continue route.
      const route = answer === "1" ? ["1"] : String(routing.continue_command).split(" ").slice(3);
      const step = runOrchestrateNext(ORCHESTRATE, proj, route, { env: env(proj, SESSION) });
      const message = String((step.directive as { message?: unknown } | null)?.message);
      expect(message).toContain("config set learnings off` to update the configuration");
      expect(message).not.toContain("--person-words");
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
    expect((asked.directive as { ask_type?: string }).ask_type, asked.out).toBe("new-work-routing");
    said(proj, "3");
    const step = runOrchestrateNext(ORCHESTRATE, proj, ["3"], { env: env(proj, SESSION) });
    const message = String((step.directive as { message?: unknown } | null)?.message);
    expect(message).toContain("config set sensors off` to apply the settings typed with this request to the work being reshaped");
    expect(configSet(proj, ["sensors", "off"]).status).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
  });
});
