// covers: cli:aidlc-log(answer), function:unattendedHumanPresenceHint, function:humanTurnState
//
// From a live Kiro CLI run: the agent put two questions in one questions file,
// the person answered both in one reply ("done"), and the agent recorded the
// first answer, then logged the second question, then tried to record its
// answer. The guard refused (one reply answers only the questions logged before
// it), and the refusal told the agent to tell the person "Your answer didn't
// reach AI-DLC", though the reply had arrived and been used. The person had to
// answer again, told their answer was lost.
//
// The refusal stays: the record cannot tie that reply to a question logged
// after it. What changes is what it says when the person's message is on
// record: the agent is pointed at that message, and the steps for a reply the
// hooks missed (a lost answer when the prompt hook's beat is old, "end your
// turn" when it is fresh) are said only if no message of theirs answers it, so
// the person is neither told their answer was lost nor asked again.
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  resetAidlcEnv,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const KIRO_CLI_LOG = join(REPO_ROOT, "dist", "kiro", ".kiro", "tools", "aidlc-log.ts");
const NO_MESSAGE_ANSWERS = "If no message of theirs answers it:";
// What the person must not hear, or be asked again for, after a reply that arrived.
const LOST = ["didn't reach", "not recorded", "has not answered yet"];

function run(tool: string, proj: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1" };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  delete env.VSCODE_IPC_HOOK;
  delete env.VSCODE_PID;
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The prompt hook's heartbeat, as it leaves it on every prompt it handles.
function promptHookBeat(proj: string, at: number): void {
  const health = join(seededRecordDir(proj), ".aidlc-engine", "hooks-health");
  mkdirSync(health, { recursive: true });
  writeFileSync(join(health, "record-human-turn.last"), `${new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z")}\n`);
}

function slugOf(proj: string): string {
  return /- \*\*Current Stage\*\*: (\S+)/.exec(readFileSync(seededStateFile(proj), "utf-8"))![1];
}

function answers(proj: string): number {
  return readAuditShardEvents(proj).filter((row) => row.event === "QUESTION_ANSWERED").length;
}

// The run's order: the first question logged, the person's one reply, its
// answer recorded, then the second question logged after the reply. With
// `words`, the reply is kept as the hook keeps a typed message; without, the
// turn row names no message. Returns the message id, if any.
function secondQuestionLoggedAfterTheReply(tool: string, proj: string, words?: string): string | null {
  const slug = slugOf(proj);
  expect(run(tool, proj, ["decision", "--stage", slug, "--decision", "Learnings: anything to add?", "--options", "Nothing to add,Add a rule"]).rc).toBe(0);
  let id: string | null = null;
  if (words === undefined) {
    appendAuditEntry("HUMAN_TURN", {}, proj);
  } else {
    const stored = saveMessage(proj, {
      session: null, at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), source: "prompt", text: words, picker: null,
      words, settings: [], route: { scope: null, newIntent: false, skip: [], add: [], projectType: null },
    });
    appendAuditEntry("HUMAN_TURN", { "Message Id": stored.id }, proj);
    id = stored.id;
  }
  const first = run(tool, proj, ["answer", "--stage", slug, "--details", "Nothing to add"]);
  expect(first.rc, first.out).toBe(0);
  expect(run(tool, proj, ["decision", "--stage", slug, "--decision", "Build and Test failed. Proceed how?", "--options", "Accept failure,Abort"]).rc).toBe(0);
  return id;
}

// The part of a refusal said before `marker`: what holds whatever order the agent showed things in.
function before(out: string, marker: string): string {
  const at = out.indexOf(marker);
  expect(at, out).toBeGreaterThan(-1);
  return out.slice(0, at);
}

let proj: string;

describe("t-question-logged-after-reply: a question logged after the reply is said so, not called a lost answer", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
  });
  afterEach(() => cleanupTestProject(proj));

  for (const label of ["stale", "fresh"] as const) {
    test(`with the reply on record (Kiro CLI, ${label} heartbeat), the agent is pointed at that message and the missed-reply steps hold only if it does not answer`, () => {
      promptHookBeat(proj, label === "fresh" ? Date.now() : Date.now() - 10 * 60 * 1000);
      const id = secondQuestionLoggedAfterTheReply(KIRO_CLI_LOG, proj, "done")!;
      const refused = run(KIRO_CLI_LOG, proj, ["answer", "--stage", slugOf(proj), "--details", "Accept failure"]);
      expect(refused.rc).not.toBe(0);
      expect(refused.out).toContain("the question was logged after the person's reply");
      expect(refused.out).toContain(`--message ${id}; do not ask them again.`);
      const unconditional = before(refused.out, NO_MESSAGE_ANSWERS);
      for (const words of LOST) expect(unconditional).not.toContain(words);
      // Named, the reply records the answer: the person is not asked again.
      const named = run(KIRO_CLI_LOG, proj, ["answer", "--stage", slugOf(proj), "--details", "Accept failure", "--message", id]);
      expect(named.rc, named.out).toBe(0);
      expect(answers(proj)).toBe(2);
    });
  }

  // A reply the person gave after the question was logged is its answer, as before.
  test("a reply after the late question still records its answer", () => {
    secondQuestionLoggedAfterTheReply(LOG, proj);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const r = run(LOG, proj, ["answer", "--stage", slugOf(proj), "--details", "Accept failure"]);
    expect(r.rc, r.out).toBe(0);
    expect(answers(proj)).toBe(2);
  });

  // An approval used the reply, not answers: the plain refusal, as before.
  test("a reply an approval used keeps the plain refusal", () => {
    const slug = slugOf(proj);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    appendAuditEntry("GATE_APPROVED", { Stage: slug, "User Input": "Approve" }, proj);
    expect(run(LOG, proj, ["decision", "--stage", slug, "--decision", "Next?", "--options", "A,B"]).rc).toBe(0);
    const r = run(LOG, proj, ["answer", "--stage", slug, "--details", "A"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("no new human reply has arrived for the question");
  });
});
