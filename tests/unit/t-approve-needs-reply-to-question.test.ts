// covers: function:verifyApprovalDecision, function:handleApprove, function:gatePresentationStart, cli:aidlc-orchestrate(report), cli:aidlc-state(approve)
//
// A gate approval is the person's reply to that gate: once the stage's approval
// question is put to them, only a reply sent after it records one. A turn they
// sent before the question (an answer to the stage's own questions, a remark
// while the stage ran) does not: the agent records nothing and shows the gate,
// and the person's next reply approves. The same rule reject has had since the
// question was first bound to its reply. A gate the engine backfills for the
// person's reported approval (report --stage on a running stage) keeps the
// older rule: its row is written after their reply by design.
import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCH = join(AIDLC_SRC, "tools", "aidlc.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const SESSION = "t-approve-needs-reply-to-question";
const WAITS = "no new human reply has been received for this approval question";
const SHOW_IT = "Show the gate and end your turn; their next reply answers it.";
// The checkbox separator the state file uses.
const SEP = "\u2014";

// The tools as a person's run calls them: the presence guard on (the suite's
// bypass removed), the artifact guard off for these bare fixtures.
function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SESSION_OVERRIDE: SESSION, ...extra };
  delete e.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete e.AIDLC_UNATTENDED;
  return e;
}

function state(proj: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
    env: { ...env(extra), AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" },
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

function rows(proj: string, event: string) {
  return readAuditShardEvents(proj).filter((row) => row.event === event);
}

function slugOf(proj: string): string {
  return /- \*\*Current Stage\*\*: (\S+)/.exec(readFileSync(seededStateFile(proj), "utf-8"))![1];
}

// A team-owned Unit at Functional Design, built and reviewed READY: its
// artifacts, its step's receipts, and its review with the findings given (a
// table row each, status New), as the Unit gate requires before it opens.
function teamProject(findings: string[] = []): string {
  const team = createTestProject();
  seedAidlcMemory(team);
  writeFileSync(seededStateFile(team), `# AI-DLC State Tracking

## Project Information
- **Project**: approval needs a reply test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
- **Construction Iteration**: unit-major
- **Unit Ownership**: team

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design ${SEP} EXECUTE
- [ ] nfr-requirements ${SEP} EXECUTE
- [ ] nfr-design ${SEP} EXECUTE
- [ ] infrastructure-design ${SEP} EXECUTE
- [ ] code-generation ${SEP} EXECUTE
- [ ] build-and-test ${SEP} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(team, ["alpha", "beta"]);
  // The Unit's Functional Design artifacts, as the stage frontmatter lists them.
  const dir = join(seededRecordDir(team), "construction", "alpha", "functional-design");
  mkdirSync(dir, { recursive: true });
  for (const name of ["entities", "rules", "functional-spec", "frontend-components", "traceability"]) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${name} for alpha\n`);
  }
  // The Unit's step on this stage, started and completed in this attempt.
  const floor = latestMainWorkflowStageRunFloorForProject(team, "functional-design", true, "alpha");
  for (const event of ["UNIT_STARTED", "UNIT_COMPLETED"]) {
    appendAuditEntry(event, { Stage: "functional-design", Unit: "alpha", "Run floor": floor }, team);
  }
  // Its review, requested and returned READY, as the Unit gate requires.
  const reviewer = "aidlc-architecture-reviewer-agent";
  const review = [LOG, "review", "--stage", "functional-design", "--reviewer", reviewer, "--unit", "alpha",
    "--iteration", "1", "--project-dir", team];
  const opts = { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" as const,
    env: { ...process.env, AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" } };
  const requested = spawnSync(BUN, review, opts);
  expect(requested.status, `${requested.stdout}${requested.stderr}`).toBe(0);
  const table = findings.length === 0 ? "No blocking findings.\n" : [
    "| ID | Severity | Location | Finding | Required action | Status |",
    "|---|---|---|---|---|---|",
    ...findings.map((id) => `| ${id} | Major | functional-spec.md > section | Unit concern | Fix the Unit | New |`),
    "",
  ].join("\n");
  appendFileSync(join(dir, artifactFilename("functional-spec")),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${reviewer}\n**Iteration:** 1\n\n### Findings\n\n${table}`);
  const verdict = spawnSync(BUN, [...review, "--verdict", "READY"], opts);
  expect(verdict.status, `${verdict.stdout}${verdict.stderr}`).toBe(0);
  return team;
}

// The guard switches a team Unit gate still needs off in a bare fixture.
const TEAM_FIXTURE = { AIDLC_SKIP_REVIEWER_GATE_GUARD: "1", AIDLC_SKIP_SOURCE_FRESHNESS: "1" };

let proj: string;

describe("t-approve-needs-reply-to-question: only the person's reply to the approval question records an approval", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, "state-mid-ideation.md");
  });
  afterEach(() => cleanupTestProject(proj));

  // What the agent is told: record nothing, show the question, wait. The
  // stage stays at its gate.
  function expectWaits(out: string, slug: string) {
    expect(out).toContain('"kind":"print"');
    expect(out).toContain(WAITS);
    expect(out).toContain(SHOW_IT);
    expect(rows(proj, "GATE_APPROVED")).toEqual([]);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(`- [?] ${slug}`);
  }

  test("a reply to the stage's own questions, sent before the gate was shown, does not approve it", () => {
    const slug = slugOf(proj);
    state(proj, ["checkbox", `${slug}=in-progress`]);
    person(proj, "two export stories, and keep both groups");
    expect(state(proj, ["gate-start", slug]).rc).toBe(0);
    expectWaits(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]).out, slug);
  });

  test("the person's reply after the gate is shown approves it, in their words", () => {
    const slug = slugOf(proj);
    state(proj, ["checkbox", `${slug}=in-progress`]);
    expect(state(proj, ["gate-start", slug]).rc).toBe(0);
    person(proj, "Approve, the stories read well");
    const approved = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]);
    const recorded = rows(proj, "GATE_APPROVED");
    expect(recorded.length, approved.out).toBe(1);
    expect(recorded[0].block).toContain("the stories read well");
    expect(readFileSync(seededStateFile(proj), "utf-8")).not.toContain(`- [?] ${slug}`);
  });

  // What the person sees: the gate, once; their one word then approves it.
  test("after the wait, the person's next reply approves the gate", () => {
    const slug = slugOf(proj);
    state(proj, ["checkbox", `${slug}=in-progress`]);
    person(proj, "looks fine so far");
    expect(state(proj, ["gate-start", slug]).rc).toBe(0);
    expectWaits(report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]).out, slug);
    person(proj, "Approve");
    const approved = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]);
    expect(rows(proj, "GATE_APPROVED").length, approved.out).toBe(1);
  });

  // The agent reported the person's approval of a stage whose gate it never
  // opened: the engine backfills the gate row (Recovered) after their reply,
  // so that row is no presentation, and the reply since the last decision
  // still approves.
  test("a gate the engine backfills for the person's reported approval keeps the older rule", () => {
    const slug = slugOf(proj);
    state(proj, ["checkbox", `${slug}=in-progress`]);
    person(proj, "Approve");
    const approved = report(proj, ["--stage", slug, "--result", "approved", "--user-input", "Approve"]);
    expect(rows(proj, "GATE_APPROVED").length, approved.out).toBe(1);
    const opened = rows(proj, "STAGE_AWAITING_APPROVAL");
    expect(opened.length).toBe(1);
    expect(opened[0].block).toContain("**Recovered**: true");
  });

  test("a team Unit gate is bound at its own Unit's row", () => {
    const team = teamProject();
    try {
      person(team, "alpha is fine by me");
      const opened = state(team, ["gate-start", "functional-design", "--unit", "alpha"], TEAM_FIXTURE);
      expect(opened.rc, opened.out).toBe(0);
      const early = state(team, ["approve", "functional-design", "--unit", "alpha", "--user-input", "Approve"], TEAM_FIXTURE);
      expect(early.rc).not.toBe(0);
      expect(early.out).toContain(WAITS);
      expect(early.out).toContain(SHOW_IT);
      expect(rows(team, "GATE_APPROVED")).toEqual([]);
      person(team, "Approve");
      const approved = state(team, ["approve", "functional-design", "--unit", "alpha", "--user-input", "Approve"], TEAM_FIXTURE);
      expect(approved.rc, approved.out).toBe(0);
      const recorded = rows(team, "GATE_APPROVED");
      expect(recorded.length).toBe(1);
      expect(recorded[0].block).toContain("**Unit**: alpha");
    } finally {
      cleanupTestProject(team);
    }
  });

  // A live run (Kiro IDE): the person's opening line was passed as the choice
  // and the gate approved one second after it opened, the review's findings
  // marked Accepted risk, the review never shown. Findings are accepted only
  // on the approval row, so the words from before the gate accept nothing.
  test("the person's words from before the gate, passed as the choice, approve nothing and accept no finding; their reply after it does both", () => {
    const team = teamProject(["R-01"]);
    try {
      person(team, "please finish functional design");
      const opened = state(team, ["gate-start", "functional-design", "--unit", "alpha"], TEAM_FIXTURE);
      expect(opened.rc, opened.out).toBe(0);
      const early = state(team, ["approve", "functional-design", "--unit", "alpha", "--user-input", "please finish functional design"], TEAM_FIXTURE);
      expect(early.rc).not.toBe(0);
      expect(early.out).toContain(SHOW_IT);
      expect(rows(team, "GATE_APPROVED")).toEqual([]);
      expect(readAuditShardEvents(team).some((row) => row.block.includes("Accepted risk"))).toBe(false);
      person(team, "Approve");
      const approved = state(team, ["approve", "functional-design", "--unit", "alpha", "--user-input", "Approve"], TEAM_FIXTURE);
      expect(approved.rc, approved.out).toBe(0);
      const recorded = rows(team, "GATE_APPROVED");
      expect(recorded.length).toBe(1);
      expect(recorded[0].block).toContain("**Review Finding Dispositions**");
      expect(recorded[0].block).toContain("Accepted risk");
      expect(recorded[0].block).toContain("R-01");
    } finally {
      cleanupTestProject(team);
    }
  });
});
