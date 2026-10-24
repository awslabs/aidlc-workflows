// covers: cli:aidlc-log(answer), function:unattendedHumanPresenceHint, function:humanTurnState
//
// From a live Kiro CLI run: the agent put two questions in one questions file,
// the person answered both in one reply ("done"), and the agent recorded the
// first answer, then logged the second question, then tried to record its
// answer. The guard refused (one reply answered only the questions logged
// before it), and the refusal told the agent to tell the person "Your answer
// didn't reach AI-DLC", though the reply had arrived. The person had to answer
// again, told their answer was lost.
//
// Which question a reply answers is the agent's reading, and an answer spends
// no reply, so the second answer records first time: no refusal, nothing said
// about a lost answer. Its row names no message: the reply is the first
// answer's, and a question logged after it takes it only when the agent names
// it (--message), since a live opencode run had a question the agent logged
// itself recorded on the person's reply to another one. A reply an approval
// used is spent, and the plain refusal stays.
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
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { saveMessage } from "../../dist/claude/.claude/tools/aidlc-message-store.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const KIRO_CLI_LOG = join(REPO_ROOT, "dist", "kiro", ".kiro", "tools", "aidlc-log.ts");
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

let proj: string;

describe("t-question-logged-after-reply: a question logged after the reply is said so, not called a lost answer", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
  });
  afterEach(() => cleanupTestProject(proj));

  for (const label of ["stale", "fresh"] as const) {
    test(`with the reply on record (Kiro CLI, ${label} heartbeat), the second answer records on it first time`, () => {
      promptHookBeat(proj, label === "fresh" ? Date.now() : Date.now() - 10 * 60 * 1000);
      const id = secondQuestionLoggedAfterTheReply(KIRO_CLI_LOG, proj, "done")!;
      const recorded = run(KIRO_CLI_LOG, proj, ["answer", "--stage", slugOf(proj), "--details", "Accept failure"]);
      expect(recorded.rc, recorded.out).toBe(0);
      for (const words of LOST) expect(recorded.out).not.toContain(words);
      expect(answers(proj)).toBe(2);
      const [first, second] = readAuditShardEvents(proj).filter((entry) => entry.event === "QUESTION_ANSWERED");
      expect(auditBlockField(first.block, "Message Id")).toBe(id);
      expect(auditBlockField(second.block, "Message Id")).toBeNull();
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
