// covers: function:handleReject, cli:aidlc-orchestrate(report), cli:aidlc-state(reject)
//
// A gate rejection is the person's: only a reply they sent after the stage's
// approval question was put to them can record one. A turn they sent before
// the question (an answer to an earlier question, a remark while the stage
// ran) does not, and neither does the agent's own reading of the reviewer's
// findings: the agent records nothing and asks.
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCH = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "t-reject-needs-person-reply";
const REVIEWER_WORDS = "Reviewer found broken traceability IDs and implementation details in ACs, fixing all findings";

// The tools as a person's run calls them: the presence guard on (the suite's
// bypass removed), the artifact guard off for these bare fixtures.
function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SESSION_OVERRIDE: SESSION };
  delete e.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete e.AIDLC_UNATTENDED;
  return e;
}

function state(proj: string, args: string[]) {
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
    env: { ...env(), AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function report(proj: string, args: string[]) {
  const r = spawnSync(BUN, [ORCHESTRATE, "report", ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: env(),
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// What the person types, through the real prompt hook.
function person(proj: string, prompt: string) {
  const r = spawnSync(BUN, [DISPATCH, "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: proj,
    env: { ...env(), AIDLC_PROJECT_DIR: proj, CLAUDE_PROJECT_DIR: proj },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

function rejections(proj: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === "GATE_REJECTED");
}

function slugOf(proj: string): string {
  return /- \*\*Current Stage\*\*: (\S+)/.exec(readFileSync(seededStateFile(proj), "utf-8"))![1];
}

let proj: string;

describe("t-reject-needs-person-reply: only the person's reply to the approval question records a rejection", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
  });
  afterEach(() => cleanupTestProject(proj));

  // What the agent is told: record nothing, put the question to them, wait.
  function expectAsked(out: string) {
    expect(out).toContain('"kind":"print"');
    expect(out).toContain("no new human reply has been received for this approval question");
    expect(rejections(proj)).toEqual([]);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain("- **Revision Count**: 0");
  }

  test("a turn sent before the approval question does not let the agent reject with the reviewer's words", () => {
    const slug = slugOf(proj);
    state(proj, ["checkbox", `${slug}=in-progress`]);
    person(proj, "yes, keep both groups");
    expect(state(proj, ["gate-start", slug]).rc).toBe(0);
    expectAsked(report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes", "--reason", REVIEWER_WORDS]).out);
  });

  test("an Approve sent before the approval question is not turned into a rejection", () => {
    const slug = slugOf(proj);
    state(proj, ["checkbox", `${slug}=in-progress`]);
    person(proj, "Approve");
    expect(state(proj, ["gate-start", slug]).rc).toBe(0);
    expectAsked(report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes", "--reason", REVIEWER_WORDS]).out);
  });

  test("a stage never put to the person cannot be rejected on a turn from before", () => {
    const slug = slugOf(proj);
    state(proj, ["checkbox", `${slug}=in-progress`]);
    person(proj, "yes, keep both groups");
    expectAsked(report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes", "--reason", REVIEWER_WORDS]).out);
  });

  test("the person's own change request at the question is recorded in their words", () => {
    const slug = slugOf(proj);
    state(proj, ["checkbox", `${slug}=in-progress`]);
    expect(state(proj, ["gate-start", slug]).rc).toBe(0);
    person(proj, "please fix the traceability IDs first");
    const rejected = report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes", "--reason", REVIEWER_WORDS]);
    const rows = rejections(proj);
    expect(rows.length, rejected.out).toBe(1);
    expect(rows[0].block).toContain("please fix the traceability IDs first");
  });

  test("the person's Request Changes pick at the question, then what to change, is recorded", () => {
    const slug = slugOf(proj);
    state(proj, ["checkbox", `${slug}=in-progress`]);
    person(proj, "yes, keep both groups");
    expect(state(proj, ["gate-start", slug]).rc).toBe(0);
    person(proj, "Request Changes");
    person(proj, "split the export story in two");
    const rejected = report(proj, ["--stage", slug, "--result", "rejected", "--user-input", "Request Changes", "--reason", "split the export story in two"]);
    const rows = rejections(proj);
    expect(rows.length, rejected.out).toBe(1);
    expect(rows[0].block).toContain("split the export story in two");
  });
});
