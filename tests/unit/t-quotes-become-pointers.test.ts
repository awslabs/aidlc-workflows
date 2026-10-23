// covers: cli:aidlc-log(answer), function:handleAnswer, function:proveMessage, function:applyIntentSettings, function:settingTheirs, subcommand:aidlc-utility:config-change, audit:QUESTION_ANSWERED, audit:CEREMONY_SET
//
// The agent names the person's message; the engine proves the pointer and never
// compares words. A choice the person left to the agent (`log answer
// --on-instruction`) and a setting they asked for (`config set ... --message`)
// name the message, which the engine proves is theirs, unspent and this work's,
// and the record keeps their whole words by id, so a misread shows in the record
// instead of being hunted by a matcher. The old value forms (`--on-instruction
// '<words>'`, `--person-words '<words>'`) are still taken for one release, as
// the agent's own text with no claim that the person said it. Each case runs
// under Guard Policy off, relaxed and strict: none of these is a guard the
// policy lowers.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";
import { join } from "node:path";
import {
  auditBlockField, formatGuardPolicy, getField, readAuditShardEvents, setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, seedAidlcMemory, seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STAGE = "feasibility";
const CHAT = "01995000-7a11-7000-8000-000000000061";
const OTHER = "01995000-7a11-7000-8000-000000000062";
const POLICIES: Array<"off" | "relaxed" | "strict"> = ["off", "relaxed", "strict"];
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

function run(proj: string, args: string[], chat = CHAT, input?: string): { status: number; out: string } {
  const r = spawnSync(BUN, args, {
    cwd: proj,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...process.env, ...CLEAR, AIDLC_SESSION_OVERRIDE: chat, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The person types `prompt` in this chat; the shipped human-turn hook keeps it.
// Returns the id of the message it kept.
function said(proj: string, prompt: string, chat = CHAT): string {
  const r = run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"], chat,
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: chat, prompt }));
  expect(r.status, r.out).toBe(0);
  const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1);
  const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
  expect(id).not.toBeNull();
  return id as string;
}

// A message another chat kept while it was not on this piece of work: no turn
// row of the work names it.
function keptOffThisWork(proj: string, words: string, chat: string): string {
  return saveMessage(proj, {
    session: chat, at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), source: "prompt", text: words, picker: null,
    words, settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
  }).id;
}

function rows(proj: string, event: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === event);
}

const field = (row: { block: string } | undefined, name: string): string | null =>
  row === undefined ? null : auditBlockField(row.block, name);

function setPolicy(policy: (typeof POLICIES)[number], statePath: string): void {
  writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), formatGuardPolicy(policy, "you")));
}

describe.each(POLICIES)("Guard Policy %s: a choice left to the agent names the message that left it", (policy) => {
  function project(): string {
    const proj = createTestProject();
    created.push(proj);
    seedStateFile(proj, "state-mid-ideation.md");
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    setPolicy(policy, join(intents, active, "aidlc-state.md"));
    return proj;
  }
  const log = (proj: string, args: string[], chat = CHAT) => run(proj, [LOG, ...args, "--project-dir", proj], chat);
  const ask = (proj: string) =>
    expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Q5-Q7", "--options", "A,B,C"]).status).toBe(0);
  const answers = (proj: string) => rows(proj, "QUESTION_ANSWERED");

  // The fixture the quote matcher was tuned on: "up to you" sits inside
  // "scale it up to your expected load". No words are compared now: the record
  // names the message, and its whole words show what the person said.
  test("the agent's reading of a message is recorded with the message named, its words whole", () => {
    const proj = project();
    const words = "Scale it up to your expected load, and let me look at it first.";
    const id = said(proj, words);
    ask(proj);
    const r = log(proj, ["answer", "--stage", STAGE, "--details", "Q5: A; Q6: A; Q7: A", "--on-instruction", "--message", id]);
    expect(r.status, r.out).toBe(0);
    const row = answers(proj).at(-1);
    expect(field(row, "Answer Source")).toBe("chosen by the agent as the person asked");
    expect(field(row, "Message Id")).toBe(id);
    expect(field(row, "Person Reply")).toBe(words);
    expect(field(row, "Instruction")).toBeNull();
  });

  // `--on-instruction` last on the line, with nothing after it to take as a value.
  test("with no message named, the answer is the agent's own: no claim, no message, no refusal", () => {
    const proj = project();
    said(proj, "up to you, choose the recommended answers");
    ask(proj);
    const r = log(proj, ["answer", "--stage", STAGE, "--details", "Q5: A; Q6: A; Q7: A", "--on-instruction"]);
    expect(r.status, r.out).toBe(0);
    const row = answers(proj).at(-1);
    expect(field(row, "Answer Source")).toBeNull();
    expect(field(row, "Message Id")).toBeNull();
    expect(field(row, "Person Reply")).toBeNull();
  });

  test("a question logged naming their message: that message is the pointer", () => {
    const proj = project();
    const id = said(proj, "pick the defaults for these, I trust you");
    expect(log(proj, ["decision", "--stage", STAGE, "--decision", "Q5-Q7", "--options", "A,B,C", "--message", id]).status)
      .toBe(0);
    const r = log(proj, ["answer", "--stage", STAGE, "--details", "Q5: A; Q6: A; Q7: A", "--on-instruction"]);
    expect(r.status, r.out).toBe(0);
    const row = answers(proj).at(-1);
    expect(field(row, "Answer Source")).toBe("chosen by the agent as the person asked");
    expect(field(row, "Message Id")).toBe(id);
  });

  test("words with the flag and a message named: the pointer claims, the words are the agent's own", () => {
    const proj = project();
    const id = said(proj, "whatever you think is best");
    ask(proj);
    const r = log(proj, ["answer", "--stage", STAGE, "--details", "Q5: A", "--on-instruction", "they said go ahead", "--message", id]);
    expect(r.status, r.out).toBe(0);
    const row = answers(proj).at(-1);
    expect(field(row, "Answer Source")).toBe("chosen by the agent as the person asked");
    expect(field(row, "Message Id")).toBe(id);
    expect(field(row, "Person Reply")).toBe("whatever you think is best");
    expect(field(row, "Conductor Summary")).toBe("they said go ahead");
  });

  test("another chat's message from off this work is refused with the message proof's own words, and nothing is recorded", () => {
    const proj = project();
    const theirs = keptOffThisWork(proj, "you pick", OTHER);
    said(proj, "looks fine so far");
    ask(proj);
    const r = log(proj, ["answer", "--stage", STAGE, "--details", "Q5: A", "--on-instruction", "--message", theirs]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(`message ${theirs} was not sent on this piece of work`);
    expect(r.out).not.toContain("you pick");
    expect(answers(proj)).toHaveLength(0);
  });

  test("the old value form is the agent's own text: recorded, no claim, no refusal", () => {
    const proj = project();
    said(proj, "Scale it up to your expected load, and let me look at it first.");
    ask(proj);
    const r = log(proj, ["answer", "--stage", STAGE, "--details", "Q5: A", "--on-instruction", "up to you"]);
    expect(r.status, r.out).toBe(0);
    const row = answers(proj).at(-1);
    expect(field(row, "Answer Source")).toBeNull();
    expect(field(row, "Instruction")).toBeNull();
    expect(field(row, "Conductor Summary")).toBe("up to you");
  });

  test("the flag's own state checks stay: never a checkpoint, never unattended, never with nothing said", () => {
    const proj = project();
    ask(proj);
    const nothing = log(proj, ["answer", "--stage", STAGE, "--details", "Q5: A", "--on-instruction"]);
    expect(nothing.status).not.toBe(0);
    expect(nothing.out).toContain("Nothing the person said in this piece of work is on record");
    said(proj, "you choose");
    const checkpoint = log(proj, [
      "answer", "--stage", STAGE, "--details", "Looks correct", "--checkpoint", "summary-confirmation", "--on-instruction",
    ]);
    expect(checkpoint.status).not.toBe(0);
    expect(checkpoint.out).toContain("is theirs to answer");
    const unattended = spawnSync(BUN, [LOG, "answer", "--stage", STAGE, "--details", "Q5: A", "--on-instruction", "--project-dir", proj], {
      cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      env: { ...process.env, ...CLEAR, AIDLC_UNATTENDED: "1", AIDLC_SESSION_OVERRIDE: CHAT, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    });
    expect(unattended.status).not.toBe(0);
    expect(`${unattended.stdout}${unattended.stderr}`).toContain("AIDLC_UNATTENDED=1 is set");
    expect(answers(proj)).toHaveLength(0);
  });
});

describe.each(POLICIES)("Guard Policy %s: a setting is theirs by the message the agent names", (policy) => {
  function project(): { proj: string; state: () => string } {
    const proj = createTestProject();
    created.push(proj);
    seedAidlcMemory(proj);
    const made = run(proj, [UTILITY, "intent-create", "--scope", "enterprise", "--arguments", "pointer fixture", "--label",
      "pointers", "--project-dir", proj]);
    expect(made.status, made.out).toBe(0);
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    const active = readFileSync(join(intents, "active-intent"), "utf-8").trim();
    const path = join(intents, active, "aidlc-state.md");
    setPolicy(policy, path);
    return { proj, state: () => readFileSync(path, "utf-8") };
  }
  const configSet = (proj: string, args: string[], chat = CHAT) =>
    run(proj, [DISPATCHER, "engine", "config", "set", ...args, "--project-dir", proj], chat);

  test("no message named after a reply: the setting runs, as the command's", () => {
    const { proj, state } = project();
    said(proj, "please turn the sensors off");
    const set = configSet(proj, ["sensors", "off"]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by a command)");
    expect(field(rows(proj, "CEREMONY_SET").at(-1), "Person Reply")).toBeNull();
  });

  test("their message named: set by you, with the id and their whole words", () => {
    const { proj, state } = project();
    const words = "please   turn the sensors off for now";
    const id = said(proj, words);
    const set = configSet(proj, ["sensors", "off", "--message", id]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by you)");
    const row = rows(proj, "CEREMONY_SET").at(-1);
    expect(field(row, "Source")).toBe("you");
    expect(field(row, "Message Id")).toBe(id);
    expect(field(row, "Person Reply")).toBe(words);
  });

  test("another chat's message from off this work is refused with the message proof's own words, and nothing changes", () => {
    const { proj, state } = project();
    const theirs = keptOffThisWork(proj, "turn the sensors off", OTHER);
    said(proj, "looks good");
    const before = getField(state(), "Sensors");
    const set = configSet(proj, ["sensors", "off", "--message", theirs]);
    expect(set.status).not.toBe(0);
    expect(set.out).toContain(`message ${theirs} was not sent on this piece of work`);
    expect(getField(state(), "Sensors")).toBe(before);
  });

  test("a message that is not on record is refused, and nothing changes", () => {
    const { proj, state } = project();
    said(proj, "turn the sensors off");
    const before = getField(state(), "Sensors");
    const set = configSet(proj, ["sensors", "off", "--message", "0badc0de"]);
    expect(set.status).not.toBe(0);
    expect(set.out).toContain("no message record");
    expect(getField(state(), "Sensors")).toBe(before);
  });

  test("the old --person-words form is the agent's own text: applied, set by a command, no refusal", () => {
    const { proj, state } = project();
    said(proj, "please turn the sensors off");
    const set = configSet(proj, ["sensors", "off", "--person-words", "please turn the sensors off"]);
    expect(set.status, set.out).toBe(0);
    expect(getField(state(), "Sensors")).toBe("off (set by a command)");
    const row = rows(proj, "CEREMONY_SET").at(-1);
    expect(field(row, "Person Reply")).toBeNull();
    expect(field(row, "Conductor Summary")).toBe("please turn the sensors off");
  });
});

describe.each(POLICIES)("Guard Policy %s: a message stands for what it asks beside the one decision it gave", (policy) => {
  const STATE_TOOL = join(AIDLC_SRC, "tools", "aidlc-state.ts");
  const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
  let statePath = "";
  function project(): string {
    const proj = createTestProject();
    created.push(proj);
    seedStateFile(proj, "state-mid-ideation.md");
    const intents = join(proj, "aidlc", "spaces", "default", "intents");
    statePath = join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim(), "aidlc-state.md");
    setPolicy(policy, statePath);
    return proj;
  }
  const setter = (proj: string, args: string[]) => run(proj, [UTILITY, "config-change", ...args, "--project-dir", proj]);
  const planApproval = () => getField(readFileSync(statePath, "utf-8"), "Plan Approval");
  const openGate = (proj: string): string => {
    const slug = getField(readFileSync(statePath, "utf-8"), "Current Stage") as string;
    const env = { ...GATE_ENV };
    for (const args of [["checkbox", `${slug}=in-progress`], ["gate-start", slug]]) {
      const r = spawnSync(BUN, [STATE_TOOL, ...args, "--project-dir", proj], {
        cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        env: { ...process.env, ...CLEAR, ...env, AIDLC_SESSION_OVERRIDE: CHAT, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
      });
      expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    }
    return slug;
  };
  const approve = (proj: string, slug: string) => {
    const r = spawnSync(BUN, [STATE_TOOL, "approve", slug, "--user-input", "Approve", "--project-dir", proj], {
      cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      env: {
        ...process.env, ...CLEAR, ...GATE_ENV, AIDLC_SESSION_OVERRIDE: CHAT, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj,
      },
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  };
  const append = (proj: string, event: string, fields: Record<string, string>) =>
    appendAuditEntry(event, fields, proj);
  // The engine's times are to the second, and a row in the same second as a
  // message is no decision after it: the next row waits for the next second.
  const tick = () => Bun.sleepSync(1100);
  // A stage gate's own checks that this file does not test (its documents,
  // its summary) stand aside, as in t188.
  const GATE_ENV = {
    AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  };

  // ans-ga-13: "approve, and turn plan approval off for the rest of this work".
  test("approve first, then the setter naming that message: set by you, with no refusal", () => {
    const proj = project();
    const slug = openGate(proj);
    const id = said(proj, "approve, and turn plan approval off for the rest of this work");
    tick();
    approve(proj, slug);
    const off = setter(proj, ["--plan-approval", "off", "--message", id]);
    expect(off.status, off.out).toBe(0);
    expect(planApproval()).toBe("off (set by you)");
    expect(field(rows(proj, "CEREMONY_SET").at(-1), "Message Id")).toBe(id);
  });

  test("the setter first, then the approval on the same message: both are recorded", () => {
    const proj = project();
    const slug = openGate(proj);
    const id = said(proj, "approve, and turn plan approval off for the rest of this work");
    const off = setter(proj, ["--plan-approval", "off", "--message", id]);
    expect(off.status, off.out).toBe(0);
    approve(proj, slug);
    expect(planApproval()).toBe("off (set by you)");
    expect(rows(proj, "GATE_APPROVED")).toHaveLength(1);
  });

  test("stages approved together are one approval, so the message still stands", () => {
    const proj = project();
    const id = said(proj, "approve both, and turn plan approval off");
    tick();
    append(proj, "GATE_APPROVED", { Stage: "feasibility", "User Input": "Approve", "Message Id": id });
    append(proj, "GATE_APPROVED", {
      Stage: "approval-handoff", "User Input": "Approve", "Approved Together With": "feasibility", "Message Id": id,
    });
    const off = setter(proj, ["--plan-approval", "off", "--message", id]);
    expect(off.status, off.out).toBe(0);
    expect(planApproval()).toBe("off (set by you)");
  });

  test("one plan answer for several Units is one decision, so the message still stands", () => {
    const proj = project();
    const id = said(proj, "approve the plans, and turn plan approval off from here");
    tick();
    for (const unit of ["core", "extra"]) {
      append(proj, "PLAN_APPROVAL_RECORDED", { Stage: "code-generation", Details: "Approve Plan", "Asked By": "engine", Unit: unit });
    }
    const off = setter(proj, ["--plan-approval", "off", "--message", id]);
    expect(off.status, off.out).toBe(0);
    expect(planApproval()).toBe("off (set by you)");
  });

  // A jump over several Units writes one row per Unit: one decision, like the plan answers above. Two jumps are two.
  test("one jump over several Units is one decision, so the message still stands", () => {
    const proj = project();
    const id = said(proj, "redo units a and b, and turn plan approval off from here");
    tick();
    const reopen = (stage: string, unit: string) => append(proj, "GATE_REJECTED", {
      Stage: stage, "Gate Stages": stage, "Gate Scope": "unit-end", Unit: unit, Reopen: "jump", Feedback: `Reopened for unit ${unit}.`,
    });
    for (const unit of ["a", "b"]) reopen("functional-design", unit);
    const off = setter(proj, ["--plan-approval", "off", "--message", id]);
    expect(off.status, off.out).toBe(0);
    expect(planApproval()).toBe("off (set by you)");

    const second = project();
    const twice = said(second, "redo units a and b, and turn plan approval off from here");
    tick();
    const reopenThere = (stage: string, unit: string) => append(second, "GATE_REJECTED", {
      Stage: stage, "Gate Stages": stage, "Gate Scope": "unit-end", Unit: unit, Reopen: "jump", Feedback: `Reopened for unit ${unit}.`,
    });
    reopenThere("functional-design", "a");
    reopenThere("code-generation", "a");
    const before = planApproval();
    const refused = setter(second, ["--plan-approval", "off", "--message", twice]);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain(`message ${twice} arrived before the last approval or decision`);
    expect(planApproval()).toBe(before);
  });

  test("the run's own approvals use none of it up", () => {
    const proj = project();
    const id = said(proj, "turn plan approval off while it runs");
    tick();
    for (const stage of ["feasibility", "approval-handoff"]) append(proj, "GATE_APPROVED", { Stage: stage, Autonomous: "true" });
    const off = setter(proj, ["--plan-approval", "off", "--message", id]);
    expect(off.status, off.out).toBe(0);
  });

  test("a second decision after it uses it up: the proof's own words, and nothing changes", () => {
    const proj = project();
    const id = said(proj, "approve, and turn plan approval off");
    tick();
    append(proj, "GATE_APPROVED", { Stage: "feasibility", "User Input": "Approve", "Message Id": id });
    tick();
    const later = said(proj, "approve this one too");
    tick();
    append(proj, "GATE_APPROVED", { Stage: "approval-handoff", "User Input": "Approve", "Message Id": later });
    const before = planApproval();
    const off = setter(proj, ["--plan-approval", "off", "--message", id]);
    expect(off.status).not.toBe(0);
    expect(off.out).toContain(`message ${id} arrived before the last approval or decision`);
    expect(planApproval()).toBe(before);
  });

  // I9: a refusal names ids and times, never the person's words.
  test("a lowering naming no message is the agent's to retry: the refusal names their message by id and time only", () => {
    const proj = project();
    const words = "please turn plan approval off for this work";
    const id = said(proj, words);
    const before = planApproval();
    for (const args of [["--plan-approval", "off"], ["--plan-approval", "off", "--person-words", words]]) {
      const off = setter(proj, args);
      expect(off.status).not.toBe(0);
      expect(off.out).toContain(`If their message ${id} (sent `);
      expect(off.out).toContain("run the same command with --message <id>");
      expect(off.out).not.toContain(words);
      expect(planApproval()).toBe(before);
    }
    // The retry it names goes through: no loop.
    const retried = setter(proj, ["--plan-approval", "off", "--message", id]);
    expect(retried.status, retried.out).toBe(0);
  });

  // A live Codex run named the chat's session id, then the person's words, where the message id goes: each refusal
  // leads with the messages that can stand behind the request, so the retry names the right one.
  test("a pointer that is not one of theirs is refused with the ids that can stand behind the request", () => {
    const proj = project();
    const id = said(proj, "approve, and turn plan approval off for the rest of this work");
    const before = planApproval();
    for (const wrong of [CHAT, "approve, and turn plan approval off for the rest of this work"]) {
      const off = setter(proj, ["--plan-approval", "off", "--message", wrong]);
      expect(off.status).not.toBe(0);
      expect(off.out).toContain(`If their message ${id} (sent `);
      expect(off.out).toContain("run the same command with --message <id>");
      expect(planApproval()).toBe(before);
    }
    const retried = setter(proj, ["--plan-approval", "off", "--message", id]);
    expect(retried.status, retried.out).toBe(0);
  });

  test("autonomy granted on a message uses it up: a second grant waits for a new one", () => {
    const proj = project();
    const id = said(proj, "run construction on its own from here");
    const bolt = (mode: string, message?: string) =>
      run(proj, [BOLT, "set-autonomy", "--mode", mode, ...(message ? ["--message", message] : []), "--project-dir", proj]);
    const refused = bolt("autonomous");
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain(`If their message ${id} (sent `);
    tick();
    expect(bolt("autonomous", id).status).toBe(0);
    expect(field(rows(proj, "AUTONOMY_MODE_SET").at(-1), "Message Id")).toBe(id);
    expect(bolt("gated").status).toBe(0);
    tick();
    const again = bolt("autonomous", id);
    expect(again.status).not.toBe(0);
    expect(again.out).toContain(`message ${id} arrived before the last approval or decision`);
  });
});
