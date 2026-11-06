// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-swarm:prepare, subcommand:aidlc-swarm:take-over
// covers: audit:SWARM_STARTED, audit:SWARM_TAKEN_OVER
//
// Live on Kiro CLI the first chat started building two Units side by side.
// While it built, the person typed /aidlc in a second chat on the same
// project: that chat ran the batch's prepare again on the worktrees the first
// chat was using, asked for a check command and tried a command the person
// declined, until they said "stop, my other window is already building these
// two Units" (#3633).
//
// A batch another chat of this clone started and has not landed is that
// chat's: `next` in a second chat says so in one line and hands out nothing to
// run for it, and leaves the first chat's step as it is. When the person asks
// in the second chat to build the Units there, the take-over records their
// words and that chat builds from then on. One chat alone, a teammate's clone,
// a first chat that ended, and a host that cannot name its chats meet what they
// meet today.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField, readActiveDirectiveMarker, readAuditShardEvents, stateFilePath,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, runOrchestrateNext } from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { cleanupCheckpointFixtures, fixture, ISOLATED_GIT_ENV, reject } from "../harness/swarm-checkpoint.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS * 2);
afterEach(cleanupCheckpointFixtures);

const UNITS = ["alpha", "beta"];
const FIRST = "01995000-0995-7000-8000-000000003633";
const SECOND = "01995000-0995-7000-8000-000000003634";
const BUILDING_ELSEWHERE = "Your other chat started building these Units.";
const TAKEN_OVER_ELSEWHERE = "Your other chat took over building these Units.";

type Json = Record<string, unknown>;

// The chat as Claude Code names it in the agent's shell: its id beside the
// live pid of the process running it. `null`: a host that names no chat.
function chatEnv(pd: string, chat: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...ISOLATED_GIT_ENV, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd };
  for (const key of ["AIDLC_SESSION_OVERRIDE", "AIDLC_SESSION_OVERRIDE_SOURCE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID"]) {
    delete env[key];
  }
  if (chat !== null) Object.assign(env, { CLAUDE_CODE_SESSION_ID: chat, CLAUDE_PID: String(process.pid) });
  return env;
}

function tool(pd: string, chat: string | null, file: string, args: string[], input?: Json) {
  const r = Bun.spawnSync([process.execPath, join(AIDLC_SRC, file), ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    cwd: pd, env: chatEnv(pd, chat), stdout: "pipe", stderr: "pipe",
    ...(input === undefined ? {} : { stdin: Buffer.from(JSON.stringify(input)) }),
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function next(pd: string, chat: string | null): Json {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), pd, [], {
    cwd: pd, env: chatEnv(pd, chat),
  });
  expect(result.status, result.out).toBe(0);
  return result.directive!;
}

function prepare(pd: string, chat: string | null) {
  const r = tool(pd, chat, "tools/aidlc-swarm.ts",
    ["prepare", "--batch", "1", "--units", UNITS.join(","), "--base", "main", "--project-dir", pd]);
  expect(r.code, `${r.out}\n${r.err}`).toBe(0);
}

// What the person types, through the prompt hook; the id of the message it kept.
function says(pd: string, chat: string, prompt: string): string {
  const r = tool(pd, chat, "tools/aidlc.ts", ["engine", "hook", "record-human-turn"],
    { hook_event_name: "UserPromptSubmit", session_id: chat, cwd: pd, prompt });
  expect(r.code, `${r.out}\n${r.err}`).toBe(0);
  const turn = readAuditShardEvents(pd).filter((row) => row.event === "HUMAN_TURN").at(-1);
  return auditBlockField(turn!.block, "Message Id")!;
}

function marker(pd: string) {
  const found = readActiveDirectiveMarker(pd, readFileSync(stateFilePath(pd), "utf-8"));
  return found === null ? null : { kind: found.kind, units: (found as { units?: unknown }).units };
}

// The first chat starts the side-by-side batch: its step, then prepare.
function firstChatBuilds(): string {
  const pd = fixture(UNITS);
  expect(next(pd, FIRST)).toMatchObject({ kind: "invoke-swarm", units: UNITS });
  prepare(pd, FIRST);
  return pd;
}

function isTheLine(step: Json, line = BUILDING_ELSEWHERE): void {
  expect(step, JSON.stringify(step)).toMatchObject({ kind: "print" });
  expect(String(step.narration)).toBe(line);
  expect(JSON.stringify(step)).not.toContain("swarm prepare --batch 1 --units alpha,beta --base");
}

describe("t-second-chat-batch-in-flight: a batch another chat is building is that chat's", () => {
  test("the second chat's /aidlc says it in one line, runs nothing for it, and leaves the first chat's step", () => {
    const pd = firstChatBuilds();
    const started = readAuditShardEvents(pd).filter((row) => row.event === "SWARM_STARTED");
    expect(started.length).toBe(1);
    expect(auditBlockField(started[0].block, "Session")).toBe(FIRST);
    const before = marker(pd);
    const rows = readAuditShardEvents(pd).length;
    says(pd, SECOND, "/aidlc");
    const step = next(pd, SECOND);
    isTheLine(step);
    // Nothing is offered before the person asks: a bare /aidlc names no take-over.
    expect(String(step.message)).not.toContain("take-over");
    expect(marker(pd)).toEqual(before);
    // Nothing of the build is recorded from the second chat (its own turn is).
    expect(readAuditShardEvents(pd).slice(rows).map((row) => row.event).filter((event) => event !== "HUMAN_TURN"))
      .not.toContain("SWARM_STARTED");
    // The first chat carries on with its own step.
    expect(next(pd, FIRST)).toMatchObject({ kind: "invoke-swarm", units: UNITS });
  });

  test("the person's own request in the second chat takes the build over, with their words on record", () => {
    const pd = firstChatBuilds();
    isTheLine(next(pd, SECOND));
    const message = says(pd, SECOND, "build them here instead, my other window is closed");
    // Once they have said something here, the step names their message for the take-over.
    const named = next(pd, SECOND);
    isTheLine(named);
    expect(String(named.message)).toContain(`If their message ${message}`);
    expect(String(named.message)).toContain("take-over --batch 1`");
    // Live on Kiro CLI the agent had no id to name: the step names their message.
    const unnamed = tool(pd, SECOND, "tools/aidlc-swarm.ts", ["take-over", "--batch", "1", "--project-dir", pd]);
    expect(unnamed.code).not.toBe(0);
    expect(unnamed.err).toContain(`If their message ${message}`);
    expect(unnamed.err).toContain("swarm take-over --batch 1");
    const taken = tool(pd, SECOND, "tools/aidlc-swarm.ts", ["take-over", "--batch", "1", "--message", message, "--project-dir", pd]);
    expect(taken.code, `${taken.out}\n${taken.err}`).toBe(0);
    const row = readAuditShardEvents(pd).filter((r) => r.event === "SWARM_TAKEN_OVER").at(-1);
    expect(row).toBeDefined();
    expect(auditBlockField(row!.block, "Session")).toBe(SECOND);
    expect(auditBlockField(row!.block, "Message Id")).toBe(message);
    expect(auditBlockField(row!.block, "Person Reply")).toContain("build them here instead");
    expect(next(pd, SECOND)).toMatchObject({ kind: "invoke-swarm", units: UNITS });
    // Now the first chat is the other one, and is told who has the build now.
    isTheLine(next(pd, FIRST), TAKEN_OVER_ELSEWHERE);
  });

  // A message that asked to build here before the other chat took the build
  // last does not ask for it now: the step names none from before, and a
  // take-over on one is refused, so the build moves only on what they said since.
  test("a take-over stands only on what the person said since the other chat last took the build", () => {
    const pd = firstChatBuilds();
    const first = says(pd, SECOND, "build them here instead, my other window is closed");
    const takeOver = (chat: string, message: string) =>
      tool(pd, chat, "tools/aidlc-swarm.ts", ["take-over", "--batch", "1", "--message", message, "--project-dir", pd]);
    expect(takeOver(SECOND, first).code).toBe(0);
    // The first chat is told who has it, and no message of its from before is named.
    expect(String(next(pd, FIRST).message)).not.toContain("take-over");
    const back = says(pd, FIRST, "no, build them here in this window");
    const named = next(pd, FIRST);
    expect(String(named.message)).toContain(`If their message ${back}`);
    expect(takeOver(FIRST, back).code).toBe(0);
    const rows = readAuditShardEvents(pd).filter((row) => row.event === "SWARM_TAKEN_OVER").length;
    // Back in the second chat, its message from before the first chat took it back is not named, and does not prove.
    says(pd, SECOND, "/aidlc");
    const step = next(pd, SECOND);
    isTheLine(step, TAKEN_OVER_ELSEWHERE);
    expect(String(step.message)).not.toContain(first);
    expect(String(step.message)).not.toContain("take-over");
    const stale = takeOver(SECOND, first);
    expect(stale.code).not.toBe(0);
    expect(readAuditShardEvents(pd).filter((row) => row.event === "SWARM_TAKEN_OVER").length).toBe(rows);
    expect(next(pd, FIRST)).toMatchObject({ kind: "invoke-swarm", units: UNITS });
    // What they say there now still takes it over.
    const again = says(pd, SECOND, "build them here after all");
    const offered = next(pd, SECOND);
    expect(String(offered.message)).toContain(`If their message ${again}`);
    expect(String(offered.message)).not.toContain(first);
    expect(takeOver(SECOND, again).code).toBe(0);
    expect(next(pd, SECOND)).toMatchObject({ kind: "invoke-swarm", units: UNITS });
  });

  test("one chat alone builds as today", () => {
    const pd = firstChatBuilds();
    expect(next(pd, FIRST)).toMatchObject({ kind: "invoke-swarm", units: UNITS });
  });

  test("a first chat that ended leaves the build to whichever chat asks", () => {
    const pd = firstChatBuilds();
    const ended = tool(pd, FIRST, "hooks/aidlc-session-end.ts", [],
      { hook_event_name: "SessionEnd", session_id: FIRST, cwd: pd, reason: "exit" });
    expect(ended.code, `${ended.out}\n${ended.err}`).toBe(0);
    expect(readAuditShardEvents(pd).some((row) => row.event === "SESSION_ENDED")).toBe(true);
    expect(next(pd, SECOND)).toMatchObject({ kind: "invoke-swarm", units: UNITS });
  });

  // Codex infers the first chat ended the moment the second one starts.
  test("an end a host only inferred when the next chat started does not release the batch", () => {
    const pd = firstChatBuilds();
    appendAuditEntry("SESSION_ENDED", { Reason: "inferred - no SessionEnd event; reconciled at next start", Session: FIRST }, pd);
    isTheLine(next(pd, SECOND));
  });

  test("a batch the person sent back at its checkpoint is held for no chat until it is prepared again", () => {
    const pd = firstChatBuilds();
    reject(pd, "alpha");
    expect(next(pd, SECOND).kind).not.toBe("print");
  });

  test("a batch a teammate's clone started is not called your other chat", () => {
    const pd = firstChatBuilds();
    // This checkout now writes a shard of its own: every row so far is another clone's.
    writeFileSync(join(pd, "aidlc", ".aidlc-clone-id"), "teammate0002\nhost\n");
    expect(next(pd, SECOND)).toMatchObject({ kind: "invoke-swarm", units: UNITS });
  });

  test("where the host names no chat, the build is handed out as today and no take-over is recorded", () => {
    const pd = fixture(UNITS);
    expect(next(pd, null)).toMatchObject({ kind: "invoke-swarm" });
    prepare(pd, null);
    const started = readAuditShardEvents(pd).filter((row) => row.event === "SWARM_STARTED").at(-1);
    expect(auditBlockField(started!.block, "Session")).toBeNull();
    expect(next(pd, null)).toMatchObject({ kind: "invoke-swarm" });
    const taken = tool(pd, null, "tools/aidlc-swarm.ts", ["take-over", "--batch", "1", "--message", "deadbeef", "--project-dir", pd]);
    expect(taken.code).not.toBe(0);
    expect(readAuditShardEvents(pd).some((row) => row.event === "SWARM_TAKEN_OVER")).toBe(false);
  });
});
