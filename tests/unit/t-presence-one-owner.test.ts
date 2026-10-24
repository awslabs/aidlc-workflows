// covers: function:personTurnStands, function:handlePark, function:parkedWords, function:recordSwitchChange, function:handleScopeChange, function:projectTypeTurnOnRecord, function:personAskedSinceGate, function:personCheckSwitchAllowed
// covers: cli:aidlc-state(park), subcommand:aidlc-utility:scope-change, subcommand:aidlc-utility:reclassify, audit:WORKFLOW_PARKED
//
// What a message of the person's asks for (a stop, a scope change, what the
// folder is, a check switched off) stands by one spend rule: the message
// proof's request form. It stands while at most one decision of theirs is
// recorded after it, the run's own approvals and every answer leaving it
// standing, so "use bun test, and stop for today" both answers the engine's
// question and stops the work. Presence is a fact about the person's turn: it
// reads the turn on the record, in this chat, never their words. A switch
// record says "because you said" only from the message the command named.
// Each case runs under Guard Policy off, relaxed and strict: none of these is a
// guard the policy lowers.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  formatGuardPolicy,
  getField,
  personCheckSwitchAllowed,
  readAuditShardEvents,
  setGuardPolicyLine,
  VERIFICATION_COMMAND_CHECKPOINT,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { invalidateSettingsCache } from "../../dist/claude/.claude/tools/aidlc-settings.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, REPO_ROOT, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const STAGE = "feasibility";
const NEXT = "scope-definition";
const CHAT = "01995000-7a11-7000-8000-0000000065b1";
const OTHER = "01995000-7a11-7000-8000-0000000065b2";
const POLICIES: Array<"off" | "relaxed" | "strict"> = ["off", "relaxed", "strict"];
const CLEAR = {
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_UNATTENDED: "0",
  AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
};
const SWITCH = "AIDLC_DISABLE_REVIEW_FREEZE_HOOK";

// The machine layer is a scratch install root, so no real install is read or written.
let machine = "";
beforeAll(() => {
  machine = mkdtempSync(join(tmpdir(), "aidlc-presence-machine-"));
});
afterAll(() => {
  rmSync(machine, { recursive: true, force: true });
});

const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
  invalidateSettingsCache();
});

function run(proj: string, args: string[], chat: string | null = CHAT, input?: string): { status: number; out: string } {
  const env: Record<string, string | undefined> = {
    ...process.env, ...CLEAR, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj,
    AIDLC_INSTALL_ROOT: join(machine, "share", "aidlc"), AIDLC_BIN_DIR: join(machine, "bin"),
    TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  // Nothing in the environment decides the switch: the settings files do.
  delete env[SWITCH];
  if (chat === null) delete env.AIDLC_SESSION_OVERRIDE;
  else env.AIDLC_SESSION_OVERRIDE = chat;
  delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  const r = spawnSync(BUN, args, {
    cwd: proj,
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env,
    ...(input === undefined ? {} : { input }),
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The person types `prompt` in `chat`; the shipped human-turn hook keeps it.
// The message is dated a few seconds back, as a real turn is before the
// agent's commands, so the rows written after it are after it by the clock.
function said(proj: string, prompt: string, chat = CHAT): string {
  const r = run(proj, [DISPATCHER, "engine", "hook", "record-human-turn"], chat,
    JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: chat, prompt }));
  expect(r.status, r.out).toBe(0);
  const turn = readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").at(-1);
  const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
  expect(id).not.toBeNull();
  const path = join(proj, "aidlc", ".aidlc-sessions", "messages", `${id}.json`);
  const record = JSON.parse(readFileSync(path, "utf-8")) as { at: string };
  record.at = new Date(Date.parse(record.at) - 5000).toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(path, `${JSON.stringify(record)}\n`);
  return id as string;
}

// The engine's own question answered on that message, and its receipt: the
// verification command the person gave in it.
function answeredTheEngine(proj: string, id: string): void {
  appendAuditEntry("QUESTION_ANSWERED", {
    Stage: STAGE, Checkpoint: VERIFICATION_COMMAND_CHECKPOINT, Details: "bun test", "Message Id": id,
  }, proj);
  appendAuditEntry("VERIFICATION_COMMAND_RECORDED", { Stage: STAGE, Command: "bun test", "Message Id": id }, proj);
}

// The agent's own question answered on that message.
function answeredTheAgent(proj: string, id: string): void {
  appendAuditEntry("QUESTION_ANSWERED", { Stage: STAGE, Details: "Q1: A", "Message Id": id }, proj);
}

const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const stateText = (proj: string) => readFileSync(seededStateFile(proj), "utf-8");

function project(policy: (typeof POLICIES)[number], source = "you"): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  seedStateFile(proj, "state-mid-ideation.md");
  const path = seededStateFile(proj);
  writeFileSync(path, setGuardPolicyLine(readFileSync(path, "utf-8"), formatGuardPolicy(policy, source)));
  return proj;
}

function autonomous(proj: string): void {
  const path = seededStateFile(proj);
  writeFileSync(path, readFileSync(path, "utf-8").replace(
    "## Runtime State\n",
    "## Runtime State\n- **Construction Autonomy Mode**: autonomous\n",
  ));
  expect(getField(stateText(proj), "Construction Autonomy Mode")).toBe("autonomous");
}

const park = (proj: string, chat: string | null = CHAT) =>
  run(proj, [STATE, "park", "--person-asked", "--project-dir", proj], chat);

describe.each(POLICIES)("Guard Policy %s: a stop the person asked for", (policy) => {
  // The run approves its own gates after their message, twice: none of those
  // is a decision of theirs, so their stop still stands.
  test("asked in the message that answered the engine's question, it parks as theirs under Continue automatically", () => {
    const proj = project(policy);
    autonomous(proj);
    const words = "use bun test, and stop for today";
    const id = said(proj, words);
    answeredTheEngine(proj, id);
    appendAuditEntry("GATE_APPROVED", { Stage: STAGE, "User Input": "Approve", Autonomous: "true" }, proj);
    appendAuditEntry("GATE_APPROVED", { Stage: NEXT, Autonomous: "true" }, proj);
    const r = park(proj);
    expect(r.status, r.out).toBe(0);
    expect(getField(stateText(proj), "Parked By")).toBe("person");
    expect(auditBlockField(rows(proj, "WORKFLOW_PARKED")[0]?.block ?? "", "Person Reply")).toBe(words);
  });

  test("two decisions of theirs after it use it up: under Continue automatically the run keeps moving, as before", () => {
    const proj = project(policy);
    autonomous(proj);
    const id = said(proj, "approve, and stop for today");
    appendAuditEntry("GATE_APPROVED", { Stage: STAGE, "User Input": "Approve", "Message Id": id }, proj);
    appendAuditEntry("GATE_APPROVED", { Stage: NEXT, "User Input": "Approve" }, proj);
    const r = park(proj);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("Refusing to park");
    expect(rows(proj, "WORKFLOW_PARKED")).toHaveLength(0);
  });

  // This chat's messages reach the record (its grant was the last of them); a
  // chat none of whose messages ever did is t188's hooks-off case.
  test("a turn in another chat does not stand for this chat's stop; this chat's own turn does", () => {
    const proj = project(policy);
    autonomous(proj);
    said(proj, "continue automatically");
    appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, proj);
    said(proj, "stop for today", OTHER);
    expect(park(proj).out).toContain("Refusing to park");
    said(proj, "stop for today");
    expect(park(proj).status).toBe(0);
    expect(getField(stateText(proj), "Parked By")).toBe("person");
  });

  test("a turn whose message record is gone still stands: presence is the turn, not its words", () => {
    const proj = project(policy);
    autonomous(proj);
    said(proj, "stop for today");
    rmSync(join(proj, "aidlc", ".aidlc-sessions", "messages"), { recursive: true, force: true });
    const r = park(proj);
    expect(r.status, r.out).toBe(0);
    expect(getField(stateText(proj), "Parked By")).toBe("person");
  });
});

describe.each(POLICIES)("Guard Policy %s: a scope change the person asked for", (policy) => {
  const scopeChange = (proj: string, extra: string[] = []) =>
    run(proj, [UTILITY, "scope-change", "--scope", "mvp", ...extra, "--project-dir", proj]);

  test("under Continue automatically, the message it names goes through though it also answered the engine's question", () => {
    const proj = project(policy);
    autonomous(proj);
    const id = said(proj, "use bun test, and make this an mvp");
    answeredTheEngine(proj, id);
    const r = scopeChange(proj, ["--message", id]);
    expect(r.status, r.out).toBe(0);
    expect(getField(stateText(proj), "Scope")).toBe("mvp");
    expect(getField(stateText(proj), "Construction Autonomy Mode")).toBe("autonomous");
  });

  test("under Continue automatically, with no message named their turn is the presence", () => {
    const proj = project(policy);
    autonomous(proj);
    const id = said(proj, "use bun test, and make this an mvp");
    answeredTheEngine(proj, id);
    const r = scopeChange(proj);
    expect(r.status, r.out).toBe(0);
    expect(getField(stateText(proj), "Scope")).toBe("mvp");
  });
});

// The scope's own lower Guard Policy is a lowering: it follows the new scope on
// the message that asked, and without one the work keeps its value and the
// line says so, with no refusal.
describe("a lower Guard Policy follows the new scope on the message that asked for it", () => {
  const scopeChange = (proj: string, extra: string[] = []) =>
    run(proj, [UTILITY, "scope-change", "--scope", "mvp", ...extra, "--project-dir", proj]);
  const policyLine = (proj: string) => getField(stateText(proj), "Change Control") ?? getField(stateText(proj), "Guard Policy");

  test("named: the policy follows the scope", () => {
    const proj = project("strict", "scope feature");
    const id = said(proj, "make this an mvp");
    const r = scopeChange(proj, ["--message", id]);
    expect(r.status, r.out).toBe(0);
    expect(policyLine(proj)).toStartWith("off");
    expect(r.out).not.toContain("Guard Policy stays");
  });

  test("typed on their own /aidlc --scope line: the policy follows the scope", () => {
    const proj = project("strict", "scope feature");
    said(proj, "/aidlc --scope mvp");
    const r = scopeChange(proj);
    expect(r.status, r.out).toBe(0);
    expect(policyLine(proj)).toBe("off (from scope mvp)");
    expect(r.out).not.toContain("Guard Policy stays");
  });

  test("not named: the work keeps strict and the line says so", () => {
    const proj = project("strict", "scope feature");
    said(proj, "make this an mvp");
    const r = scopeChange(proj);
    expect(r.status, r.out).toBe(0);
    expect(getField(stateText(proj), "Scope")).toBe("mvp");
    expect(policyLine(proj)).toStartWith("strict");
    expect(r.out).toContain("Guard Policy stays strict");
  });
});

describe.each(POLICIES)("Guard Policy %s: what the folder is", (policy) => {
  const reclassify = (proj: string, extra: string[] = []) =>
    run(proj, [UTILITY, "reclassify", "--project-type", "brownfield", ...extra, "--project-dir", proj]);

  test("said in the message that answered the agent's question, it is their word with no message named", () => {
    const proj = project(policy);
    const id = said(proj, "A, and this folder is existing code");
    answeredTheAgent(proj, id);
    const r = reclassify(proj);
    expect(r.status, r.out).toBe(0);
    expect(getField(stateText(proj), "Project Type")).toBe("Brownfield");
  });

  // The approval a message gave is no word on what the folder is: with a
  // decision after it the agent names the message that said it.
  test("after a decision on their message, it takes the message named, as before", () => {
    const proj = project(policy);
    const id = said(proj, "approve, and this folder is existing code");
    appendAuditEntry("GATE_APPROVED", { Stage: STAGE, "User Input": "Approve", "Message Id": id }, proj);
    const refused = reclassify(proj);
    expect(refused.status).not.toBe(0);
    expect(refused.out).toContain(`If their message ${id}`);
    expect(getField(stateText(proj), "Project Type")).toBe("Greenfield");
    const r = reclassify(proj, ["--message", id]);
    expect(r.status, r.out).toBe(0);
    expect(getField(stateText(proj), "Project Type")).toBe("Brownfield");
  });
});

describe.each(POLICIES)("Guard Policy %s: a check switched off for the project", (policy) => {
  const ASKED = "B, and turn the review freeze check off for this project";
  function installed(): string {
    const proj = project(policy);
    cpSync(join(REPO_ROOT, "dist", "claude", ".claude"), join(proj, ".claude"), { recursive: true });
    return proj;
  }
  const flags = (proj: string, chat: string | null, ...args: string[]) => {
    const r = run(proj, [DISPATCHER, "config", "flags", "--project-dir", proj, "--bypass", SWITCH, "--local", "--yes", ...args], chat);
    invalidateSettingsCache();
    return r;
  };

  test("named, the line quotes the message the command named, though it also answered the agent's question", () => {
    const proj = installed();
    const id = said(proj, ASKED);
    answeredTheAgent(proj, id);
    const r = flags(proj, CHAT, "--message", id);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`because you said: "${ASKED}"`);
  });

  test("with no message named, the line claims nothing of theirs", () => {
    const proj = installed();
    said(proj, ASKED);
    const r = flags(proj, null);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("is off for this project since");
    expect(r.out).not.toContain("because you said");
  });
});

// The hosts that let the agent's setter run without their own confirmation,
// and the plan-approval guard's admissions, read the same presence.
describe.each(POLICIES)("Guard Policy %s: the hosts' and the guard's presence", (policy) => {
  test("a check off asked for in the message that answered the engine's question runs without a second confirmation", () => {
    const proj = project(policy);
    const id = said(proj, "use bun test, and turn the review freeze check off");
    answeredTheEngine(proj, id);
    const prior = { session: process.env.AIDLC_SESSION_OVERRIDE, unattended: process.env.AIDLC_UNATTENDED };
    process.env.AIDLC_SESSION_OVERRIDE = CHAT;
    process.env.AIDLC_UNATTENDED = "0";
    try {
      expect(personCheckSwitchAllowed(proj, "guard.review-freeze", "off")).toBe(true);
      process.env.AIDLC_SESSION_OVERRIDE = OTHER;
      expect(personCheckSwitchAllowed(proj, "guard.review-freeze", "off")).toBe(false);
    } finally {
      if (prior.session === undefined) delete process.env.AIDLC_SESSION_OVERRIDE;
      else process.env.AIDLC_SESSION_OVERRIDE = prior.session;
      if (prior.unattended === undefined) delete process.env.AIDLC_UNATTENDED;
      else process.env.AIDLC_UNATTENDED = prior.unattended;
    }
  });
});
