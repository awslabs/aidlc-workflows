// covers: function:parkWorkflow, function:parkedWords, function:withParkedReply, function:wordsAtPark
// covers: audit:WORKFLOW_PARKED
//
// Live on Kiro CLI (twice) and Kiro IDE: at the Build and Test gate the person
// typed "approve, and stop here, there is nothing to deploy"; the agent approved
// and parked. In the next chat a bare /aidlc resumed Deployment Pipeline and
// asked them three to five deployment questions. The approval row kept their
// words; the park row did not, and the step that resumed there carried nothing
// of what they said when they stopped, so each agent decided the stage with the
// words absent (Claude Code's skipped on the project alone, Codex's went and
// read the audit, both Kiro agents asked). Now the park row keeps the words
// that stopped the work, and the step that resumes there carries them with one
// note. The engine reads no meaning into them.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createOrchestrationTestProject,
  FIXTURES_DIR,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import {
  auditBlockField,
  humanTurnState,
  personSpokeSinceGate,
  readAuditShardEvents,
  SUMMARY_CONFIRMATION_CHECKPOINT,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { validateDirective } from "../../dist/claude/.claude/tools/aidlc-directive.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const LATER = "01995000-7a11-7000-8000-00000000beef";
// The fixture's stage in progress, and the one the approval moves on to.
const STAGE = "feasibility";
const NEXT = "scope-definition";
const WORDS = "approve, and stop here, there is nothing to deploy";
const NOTE =
  "The person said this when they stopped the work here, in an earlier chat. Read it for what it means for this " +
  "stage and the ones after it before doing anything else, and never ask them again what they already said.";

type ParkedReply = { words: string; note: string } | undefined;

function env(session: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const e: Record<string, string | undefined> = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_UNATTENDED: "0",
    AIDLC_SESSION_OVERRIDE: session,
    ...extra,
  };
  delete e.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete e.AIDLC_SESSION_OVERRIDE_SOURCE;
  return e;
}

function run(tool: string, args: string[], extra: Record<string, string> = {}): { rc: number; out: string } {
  const r = spawnSync(BUN, [tool, ...args], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: env(SESSION, extra),
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const state = (proj: string, args: string[]) =>
  run(STATE, [...args, "--project-dir", proj], { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" });
const events = (proj: string, name: string) => readAuditShardEvents(proj).filter((row) => row.event === name);

// `report` as the agent runs it in this chat.
function report(proj: string, args: string[]): { kind: string; message?: string } {
  const r = run(ORCHESTRATE, ["report", ...args, "--project-dir", proj]);
  const line = r.out.split("\n").find((entry) => entry.startsWith("{"));
  expect(line, r.out).toBeDefined();
  return JSON.parse(line as string) as { kind: string; message?: string };
}

// What the person types, through the real UserPromptSubmit route every harness uses.
function says(proj: string, prompt: string): void {
  const result = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...env(SESSION), CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(result.status, result.stderr).toBe(0);
}

// The one park row, and the words it kept.
function parkedWords(proj: string): string | null {
  const rows = events(proj, "WORKFLOW_PARKED");
  expect(rows).toHaveLength(1);
  return auditBlockField(rows[0].block, "Person Reply");
}

// Every row in order, with its second and its place in its shard: what a
// failure needs to say about the order the engine read.
function rowOrder(proj: string): string {
  const rows = readAuditShardEvents(proj)
    .map((row) => `${row.event} ${row.timestamp} ${row.shard.split("/").pop()}:${row.pos}` +
      (row.event === "HUMAN_TURN" ? ` Reply=${auditBlockField(row.block, "Reply") ?? "-"}` : ""));
  const read = `humanTurnState=${humanTurnState(proj, { replies: true })} ` +
    `personSpokeSinceGate=${personSpokeSinceGate(proj, { replies: true, outlivesApproval: true })}`;
  return [read, ...rows].join("\n");
}

// The first step of the next chat, where the work was parked.
function resumed(proj: string, args: string[] = ["--resume"]): Record<string, unknown> {
  const r = runOrchestrateNext(ORCHESTRATE, proj, args, { cwd: proj, env: env(LATER) });
  expect(r.directive?.kind, r.out).toBe("run-stage");
  return r.directive as Record<string, unknown>;
}

function unpark(proj: string): void {
  const r = state(proj, ["unpark"]);
  expect(r.rc, r.out).toBe(0);
}

const keptWordsFile = (proj: string) => join(seededRecordDir(proj), ".aidlc-engine", "gate-words", `${SESSION}.json`);

// The fixture scope confirms summaries; this stage asked none, so the gate
// would otherwise be held for the summary it never had.
function seedStage(proj: string): void {
  seedStateFile(proj, join(FIXTURES_DIR, "state-mid-ideation.md"));
  const file = seededStateFile(proj);
  writeFileSync(file, readFileSync(file, "utf-8").replace(
    "- **Change Control**: strict (from scope feature)",
    "- **Change Control**: strict (from scope feature)\n- **Summary Confirmation**: off (set by you)",
  ));
  state(proj, ["checkbox", `${STAGE}=in-progress`]);
}

describe("the park row keeps the words that stopped the work", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createOrchestrationTestProject();
    seedStage(proj);
  });
  afterEach(() => cleanupTestProject(proj));

  // The live path: the approval and the stop in one message, one call.
  test("approve and stop in one call: the approval row and the park row both carry their words", () => {
    state(proj, ["gate-start", STAGE]);
    says(proj, WORDS);
    const parked = report(proj, ["--stage", STAGE, "--result", "approved", "--user-input", "Approve", "--park"]);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    const approved = events(proj, "GATE_APPROVED");
    expect(approved).toHaveLength(1);
    expect(auditBlockField(approved[0].block, "Person Reply")).toBe(WORDS);
    expect(auditBlockField(events(proj, "WORKFLOW_PARKED")[0]?.block ?? "", "Stage")).toBe(NEXT);
    expect(parkedWords(proj)).toBe(WORDS);
  });

  // The same stop in two calls: the approval spends the chat's kept words, so
  // the park finds them on the approval row.
  test("approve, then park in a second call: the words come from the approval, after the kept words were spent", () => {
    state(proj, ["gate-start", STAGE]);
    says(proj, WORDS);
    expect(existsSync(keptWordsFile(proj))).toBe(true);
    const done = report(proj, ["--stage", STAGE, "--result", "approved", "--user-input", "Approve"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    expect(existsSync(keptWordsFile(proj))).toBe(false);
    // A store a day old has been pruned too: nothing of the turn is left but the rows.
    rmSync(join(seededRecordDir(proj), ".aidlc-engine", "sessions"), { recursive: true, force: true });
    const r = state(proj, ["park"]);
    expect(r.rc, r.out).toBe(0);
    expect(parkedWords(proj)).toBe(WORDS);
  });

  test("a stop said with no gate open: the park row carries the words the hook kept", () => {
    says(proj, "let's stop for today");
    const r = state(proj, ["park"]);
    expect(r.rc, r.out).toBe(0);
    expect(parkedWords(proj)).toBe("let's stop for today");
  });

  test("a turn that kept no words (a picker, a no-text line) leaves the row as it was", () => {
    appendAuditEntry("HUMAN_TURN", {}, proj);
    const r = state(proj, ["park"]);
    expect(r.rc, r.out).toBe(0);
    expect(parkedWords(proj)).toBeNull();
  });

  test("a non-answer the host typed for them is not their words", () => {
    says(proj, "Cancelled");
    const r = state(proj, ["park"]);
    expect(r.rc, r.out).toBe(0);
    expect(parkedWords(proj)).toBeNull();
  });

  // Stale words: a reply one of the engine's own questions already used up
  // (here the summary confirmation) stands behind nothing later.
  test("an older reply the summary checkpoint used, then a park: the row carries no words", () => {
    state(proj, ["gate-start", STAGE]);
    says(proj, "looks correct, and rename the handler");
    appendAuditEntry("QUESTION_ANSWERED", {
      Stage: STAGE, Checkpoint: SUMMARY_CONFIRMATION_CHECKPOINT, Details: "Looks correct",
    }, proj);
    const r = state(proj, ["park"]);
    expect(r.rc, r.out).toBe(0);
    expect(parkedWords(proj), rowOrder(proj)).toBeNull();
  });

  // The answer they gave the agent's own question in that same message leaves
  // the rest of it standing: "B, and stop here for today" is the answer and the
  // stop, and the park row keeps the words.
  test("a reply that answered the agent's question and asked to stop keeps its words", () => {
    says(proj, "B, and let's stop here for today");
    appendAuditEntry("QUESTION_ANSWERED", { Stage: STAGE, Details: "B" }, proj);
    const r = state(proj, ["park"]);
    expect(r.rc, r.out).toBe(0);
    expect(parkedWords(proj), rowOrder(proj)).toBe("B, and let's stop here for today");
  });
});

describe("the step that resumes where the work was parked carries them", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createOrchestrationTestProject();
    seedStage(proj);
  });
  afterEach(() => cleanupTestProject(proj));

  function approveAndStop(): void {
    state(proj, ["gate-start", STAGE]);
    says(proj, WORDS);
    const parked = report(proj, ["--stage", STAGE, "--result", "approved", "--user-input", "Approve", "--park"]);
    expect(parked.kind, JSON.stringify(parked)).toBe("parked");
    unpark(proj);
  }

  test("the next chat's first step at the parked stage carries the words and the note", () => {
    approveAndStop();
    const directive = resumed(proj);
    expect(directive.stage).toBe(NEXT);
    const reply = directive.parked_reply as ParkedReply;
    expect(reply?.words).toBe(WORDS);
    expect(reply?.note).toBe(NOTE);
    // The step is a valid directive with the field on it.
    expect(validateDirective(directive).valid).toBe(true);
  });

  test("a bare next after the unpark carries them too, and again until the stage records a step", () => {
    approveAndStop();
    expect((resumed(proj, []).parked_reply as ParkedReply)?.words).toBe(WORDS);
    expect((resumed(proj, []).parked_reply as ParkedReply)?.words).toBe(WORDS);
  });

  // The field ends at the first row of that stage after the park.
  test.each(["DECISION_RECORDED", "QUESTION_ANSWERED", "STAGE_STARTED", "GATE_REJECTED"])(
    "a %s row for the stage after the park ends it",
    (event) => {
      approveAndStop();
      appendAuditEntry(event, { Stage: NEXT, Details: "x", Decision: "q", Options: "a,b" }, proj);
      expect(resumed(proj, []).parked_reply).toBeUndefined();
    },
  );

  test("a row of another stage leaves them in place", () => {
    approveAndStop();
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, Agent: "aidlc-architect-agent" }, proj);
    expect((resumed(proj, []).parked_reply as ParkedReply)?.words).toBe(WORDS);
  });

  test("once that stage is approved, the stage after it never had them", () => {
    approveAndStop();
    expect((resumed(proj, []).parked_reply as ParkedReply)?.words).toBe(WORDS);
    state(proj, ["gate-start", NEXT]);
    says(proj, "approve");
    const done = report(proj, ["--stage", NEXT, "--result", "approved", "--user-input", "Approve"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    const directive = resumed(proj, []);
    expect(directive.stage).not.toBe(NEXT);
    expect(directive.parked_reply).toBeUndefined();
  });

  test("a park whose row kept no words hands nothing", () => {
    appendAuditEntry("HUMAN_TURN", {}, proj);
    expect(state(proj, ["park"]).rc).toBe(0);
    unpark(proj);
    const directive = resumed(proj, []);
    expect(directive.stage).toBe(STAGE);
    expect(directive.parked_reply).toBeUndefined();
  });

  test("the field's shape is checked like the others", () => {
    approveAndStop();
    const directive = resumed(proj);
    const broken = { ...directive, parked_reply: { words: WORDS, note: NOTE, extra: 1 } };
    const result = validateDirective(broken);
    expect(result.valid).toBe(false);
    expect(result.valid ? "" : result.errors.join("\n")).toContain("parked_reply unknown key: extra");
    const wrong = { ...directive, parked_reply: { words: 7, note: NOTE } };
    expect(validateDirective(wrong).valid).toBe(false);
  });
});

// A Unit's own step is not where the person stopped: in a solo unit-major walk
// the park row names the block's first stage (Current Stage stays there while
// each Unit works through the later ones), so a later Unit reaching that stage
// would be handed words said about another Unit's step. A step that carries a
// Unit gets none; the live beat gets what it got before: nothing.
describe("a Unit's step never carries them", () => {
  const SEP = "\u2014";
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedAidlcMemory(proj);
    writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: a park in a unit-major walk
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
- **Summary Confirmation**: off (set by you)

## Runtime State
- **Construction Checkpoints**: enabled
- **Construction Iteration**: unit-major
- **Construction Execution**: serial

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
    seedBoltDag(proj, ["alpha", "beta"]);
  });
  afterEach(() => cleanupTestProject(proj));

  test("the park row keeps the words, and the resumed Unit step carries none", () => {
    says(proj, "let's stop here for today");
    expect(state(proj, ["park"]).rc).toBe(0);
    expect(parkedWords(proj)).toBe("let's stop here for today");
    unpark(proj);
    const directive = resumed(proj, []);
    expect(directive.stage).toBe("functional-design");
    expect(directive.unit).toBe("alpha");
    expect(directive.parked_reply).toBeUndefined();
  });
});

// The record keeps the whole message; the step carries what fits. A gate's
// recorded reply can run to several long messages, and a step that cannot be
// sent would stop the resume for good (an error writes no row of the stage).
describe("a long reply is carried only as far as the step can take it", () => {
  let proj: string;
  beforeEach(() => {
    resetAidlcEnv();
    proj = createOrchestrationTestProject();
    seedStage(proj);
  });
  afterEach(() => cleanupTestProject(proj));

  test("the step carries the first part and says the whole message is on the record", () => {
    const long = "approve, and stop here. ".repeat(1400); // about 33,000 characters, past any host's step limit
    appendAuditEntry("WORKFLOW_PARKED", { Stage: STAGE, "Person Reply": long }, proj);
    const directive = resumed(proj, []);
    expect(directive.stage).toBe(STAGE);
    const reply = directive.parked_reply as ParkedReply;
    expect(reply?.words.length).toBeLessThanOrEqual(8000);
    expect(long.startsWith(reply?.words ?? "x")).toBe(true);
    expect(reply?.note).toContain(NOTE);
    expect(reply?.note).toContain("whole message");
    expect(validateDirective(directive).valid).toBe(true);
  });

  test("a reply that fits is carried whole, with the plain note", () => {
    const words = "approve, and stop here. ".repeat(100).trim(); // about 2,400 characters
    appendAuditEntry("WORKFLOW_PARKED", { Stage: STAGE, "Person Reply": words }, proj);
    const reply = resumed(proj, []).parked_reply as ParkedReply;
    expect(reply?.words).toBe(words);
    expect(reply?.note).toBe(NOTE);
  });
});
