// covers: function:unattendedHumanPresenceHint, function:promptHookRanRecently, cli:aidlc-state(approve), cli:aidlc-log(answer)
//
// A refusal for want of the person's reply once told the agent "if the person
// already replied, that reply was not recorded" (and, on Kiro, the trust and
// reload steps) even when the hooks were running and the person simply had not
// answered the gate the agent had just opened. The prompt hook's own heartbeat
// (record-human-turn.last) is the hard signal: fresh for this workflow, the
// person has not answered yet, and the agent is told to end its turn; the
// person hears nothing. No heartbeat keeps the hooks-off step; a heartbeat the
// workflow left far behind keeps the missed-reply line.
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  resetAidlcEnv,
  seededAuditDir,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const KIRO_IDE_STATE = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "tools", "aidlc-state.ts");
const NOT_ANSWERED = "The person has not answered yet: end your turn; their next reply answers it.";
// What a person must never hear for a gate they have not answered yet.
const MISSED = ["not recorded", "didn't reach", "Reload Window", "trust this folder"];

function env(host: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
  delete e.VSCODE_IPC_HOOK;
  delete e.VSCODE_PID;
  delete e.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete e.AIDLC_UNATTENDED;
  return { ...e, ...host };
}

function run(tool: string, proj: string, args: string[], host: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: env(host),
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The prompt hook's heartbeat, as the hook leaves it on every prompt it handles.
function promptHookBeat(proj: string, at: number): void {
  const health = join(seededRecordDir(proj), ".aidlc-engine", "hooks-health");
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), `${new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z")}\n`);
}

function slugOf(proj: string): string {
  return /- \*\*Current Stage\*\*: (\S+)/.exec(readFileSync(seededStateFile(proj), "utf-8"))![1];
}

function approvals(proj: string): number {
  return readAuditShardEvents(proj).filter((row) => row.event === "GATE_APPROVED").length;
}

// The k2-f1 shape: the first gate was shown and the person answered it; the
// agent approved it, opened the next stage's gate in the same turn, and went
// straight on.
function nextGateJustOpened(proj: string): string {
  const first = slugOf(proj);
  run(STATE, proj, ["checkbox", `${first}=in-progress`]);
  expect(run(STATE, proj, ["gate-start", first]).rc).toBe(0);
  appendAuditEntry("HUMAN_TURN", {}, proj);
  expect(run(STATE, proj, ["approve", first, "--user-input", "Approve"]).rc).toBe(0);
  const slug = slugOf(proj);
  run(STATE, proj, ["checkbox", `${slug}=in-progress`]);
  expect(run(STATE, proj, ["gate-start", slug]).rc).toBe(0);
  return slug;
}

function expectNotAnsweredYet(out: string) {
  expect(out).toContain(NOT_ANSWERED);
  for (const words of MISSED) expect(out).not.toContain(words);
  expect(out).not.toMatch(/hook/i);
}

let proj: string;

describe("t-not-answered-yet: a gate the person has not answered yet is not a missed reply", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
  });
  afterEach(() => cleanupTestProject(proj));

  test("with the prompt hook's heartbeat fresh, the approval refusal says to end the turn and nothing about a missed reply", () => {
    promptHookBeat(proj, Date.now());
    const slug = nextGateJustOpened(proj);
    const refused = run(STATE, proj, ["approve", slug, "--user-input", "Approve"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("no new human reply has been received for this approval question");
    expectNotAnsweredYet(refused.out);
    expect(approvals(proj)).toBe(1);
  });

  test("inside Kiro IDE the same refusal names no trust or reload step", () => {
    promptHookBeat(proj, Date.now());
    const slug = nextGateJustOpened(proj);
    const refused = run(KIRO_IDE_STATE, proj, ["approve", slug, "--user-input", "Approve"], { VSCODE_PID: "218" });
    expect(refused.rc).not.toBe(0);
    expectNotAnsweredYet(refused.out);
    expect(approvals(proj)).toBe(1);
  });

  test("a question logged and not yet answered gets the same step from log answer", () => {
    promptHookBeat(proj, Date.now());
    const slug = slugOf(proj);
    run(STATE, proj, ["checkbox", `${slug}=in-progress`]);
    expect(run(LOG, proj, ["decision", "--stage", slug, "--decision", "Which runtime?", "--options", "Python,Node"]).rc).toBe(0);
    const refused = run(LOG, proj, ["answer", "--stage", slug, "--details", "Python"]);
    expect(refused.rc).not.toBe(0);
    expectNotAnsweredYet(refused.out);
    expect(readAuditShardEvents(proj).filter((row) => row.event === "QUESTION_ANSWERED")).toEqual([]);
  });

  // No prompt hook ever ran here: the agent's own step for hooks that are off
  // stays, since a reply the person did send had nowhere to land.
  test("with no heartbeat at all, the hooks-off step stays", () => {
    const slug = nextGateJustOpened(proj);
    const refused = run(STATE, proj, ["approve", slug, "--user-input", "Approve"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("AI-DLC's hooks are not running here");
    expect(refused.out).not.toContain(NOT_ANSWERED);
  });

  // The prompt hook stopped after the gate opened (a launch whose hook command
  // fails, a Kiro IDE window back in Restricted Mode): the heartbeat and the gate
  // row are both old and close together, and no refusal writes a stage or gate
  // event, so only the clock can tell. The missed-reply line comes back within
  // minutes instead of "not answered yet" turn after turn.
  test("a heartbeat that is old by the clock keeps the missed-reply line, though the gate row followed it closely", () => {
    const slug = nextGateJustOpened(proj);
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    promptHookBeat(proj, Date.now() - 40 * 60 * 1000);
    // Every row of the record, the gate row included, was written two minutes after that heartbeat.
    const auditDir = seededAuditDir(proj);
    for (const name of readdirSync(auditDir).filter((n) => n.endsWith(".md"))) {
      const shard = join(auditDir, name);
      writeFileSync(shard, readFileSync(shard, "utf-8").replace(/\*\*Timestamp\*\*: \S+/g, `**Timestamp**: ${minutesAgo(38)}`));
    }
    const refused = run(STATE, proj, ["approve", slug, "--user-input", "Approve"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("If the person already replied, that reply was not recorded for this question.");
    expect(refused.out).not.toContain(NOT_ANSWERED);
  });

  // The workflow moved on long after the prompt hook last ran: the hooks may
  // have stopped, so the missed-reply line stays.
  test("with a heartbeat the workflow left far behind, the missed-reply line stays", () => {
    promptHookBeat(proj, Date.now() - 10 * 60 * 1000);
    const slug = nextGateJustOpened(proj);
    const refused = run(STATE, proj, ["approve", slug, "--user-input", "Approve"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("If the person already replied, that reply was not recorded for this question.");
    expect(refused.out).not.toContain(NOT_ANSWERED);
  });
});
