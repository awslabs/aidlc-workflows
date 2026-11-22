// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-state:unit
//
// A per-Unit design stage that runs as a wave hands each Unit to a builder,
// and a builder cannot talk to the person. So before the wave, each Unit it
// would build gets its questions asked in the chat, one step per Unit
// (`questions_only`, the stage file's QUESTION-ONLY mode); the wave follows
// once every such Unit's answers are in, and each entry names the answered
// questions file its builder writes from. The evidence is the Unit's current
// summary confirmation, not its outputs: one saved before it does not hold
// the Unit on its question step. A serial Unit receipt on the question step is
// refused, since it would drop the wave.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const SESSION = "01995000-7a11-7000-8000-00000000c0de";
const STAGE = "functional-design";
const DASH = "\u2014";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  unit?: string;
  gate?: unknown;
  questions_only?: boolean;
  gate_note?: string;
  ceremony_note?: string;
  answer_mode_note?: string;
  wave?: { entries: Array<{ unit: string; build_required: boolean; questions_file?: string }> };
  [k: string]: unknown;
}

function project(scope = "feature"): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: questions before the wave
- **Project Type**: Greenfield
- **Scope**: ${scope}
- **State Version**: 8
- **Unit Ownership**: solo
- **Skeleton Stance**: on

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design ${DASH} EXECUTE
- [ ] nfr-requirements ${DASH} EXECUTE
- [ ] nfr-design ${DASH} EXECUTE
- [ ] infrastructure-design ${DASH} EXECUTE
- [ ] code-generation ${DASH} EXECUTE
- [ ] build-and-test ${DASH} EXECUTE

### INCEPTION PHASE
- [-] domain-design ${DASH} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(proj, ["alpha", "beta"]);
  return proj;
}

// The summary guard stays on: the confirmation is the evidence the questions were asked.
function env(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e.AWS_AIDLC_DEFAULT_SCOPE;
  delete e.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  delete e.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  e.AIDLC_SESSION_OVERRIDE = SESSION;
  delete e.AIDLC_SESSION_OVERRIDE_SOURCE;
  return e;
}

// What the person types, through the human-turn hook every harness runs.
function says(proj: string, prompt: string): void {
  const r = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...env(), CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, r.stderr).toBe(0);
}

function next(proj: string): Directive {
  const r = runOrchestrateNext(ORCH, proj, [], { env: env() });
  if (r.directive === null) throw new Error(`next emitted no JSON: ${r.out}`);
  return r.directive as Directive;
}

function tool(path: string, args: string[], proj: string) {
  return spawnSync(BUN, [path, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env: env(),
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
}

function questionsFile(proj: string, unit: string): string {
  return join(seededRecordDir(proj), "construction", unit, STAGE, `${STAGE}-questions.md`);
}

function writeAnswers(proj: string, unit: string, withSummary: boolean): string {
  const path = questionsFile(proj, unit);
  mkdirSync(join(path, ".."), { recursive: true });
  const lines = ["# Functional Design Questions", "", "## Q1. Who can see a saved item?", "", "A) Its owner", "B) Everyone", "", "[Answer]: A", ""];
  if (withSummary) {
    lines.push("## Consolidated Summary Confirmation", "", "- A saved item is private to its owner.", "", "- Looks correct", "- Request changes", "", "[Answer]:", "");
  }
  writeFileSync(path, lines.join("\n"));
  return path;
}

// The person confirms the Unit's summary the way the agent records it.
function confirmSummary(proj: string, unit: string): void {
  const path = writeAnswers(proj, unit, true);
  const head = ["--checkpoint", "summary-confirmation", "--stage", STAGE, "--unit", unit, "--questions-file", path];
  const decision = tool(LOG, ["decision", ...head, "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"], proj);
  expect(decision.status, `${decision.stdout}${decision.stderr}`).toBe(0);
  appendAuditEntry("HUMAN_TURN", {}, proj);
  writeFileSync(path, readFileSync(path, "utf-8").replace(/\[Answer\]:\s*$/, "[Answer]: Looks correct\n"));
  const answer = tool(LOG, ["answer", ...head, "--details", "Looks correct"], proj);
  expect(answer.status, `${answer.stdout}${answer.stderr}`).toBe(0);
}

describe("t-wave-questions-first: a wave's Units are asked their questions in the chat first", () => {
  test("each Unit's questions come first, one Unit at a time, then the wave names the answered files", () => {
    const proj = project();
    const first = next(proj);
    expect(first.kind).toBe("run-stage");
    expect(first.unit).toBe("alpha");
    expect(first.questions_only).toBe(true);
    expect(first.wave).toBeUndefined();
    expect(first.gate).toBe(false);
    // The question flow's own notes ride the step, as on a Unit's serial step.
    expect(first.ceremony_note).toContain("confirm the summary");
    expect(first.answer_mode_note).toContain("How would you like to answer them?");
    expect(first.gate_note).toContain("write none of the stage's documents");

    // Answers without the confirmation are not yet the Unit's answers.
    writeAnswers(proj, "alpha", true);
    expect(next(proj)).toMatchObject({ unit: "alpha", questions_only: true });

    confirmSummary(proj, "alpha");
    expect(next(proj)).toMatchObject({ unit: "beta", questions_only: true });

    confirmSummary(proj, "beta");
    const wave = next(proj);
    expect(wave.questions_only).toBeUndefined();
    const rel = (unit: string) => relative(proj, questionsFile(proj, unit)).replaceAll("\\", "/");
    expect(wave.wave?.entries.map((entry) => [entry.unit, entry.build_required, entry.questions_file])).toEqual([
      ["alpha", true, rel("alpha")],
      ["beta", true, rel("beta")],
    ]);
  });

  test("with no summary owed, a questions file with every answer in is enough, and one with none to ask", () => {
    const proj = project("classic");
    const first = next(proj);
    expect(first).toMatchObject({ unit: "alpha", questions_only: true });
    // The step writes nothing, so it is not told to write the outputs once answered.
    expect(first.ceremony_note).not.toContain("write the stage's outputs");
    expect(first.gate_note).toContain("with nothing to ask, write the file");
    const blank = writeAnswers(proj, "alpha", false);
    writeFileSync(blank, readFileSync(blank, "utf-8").replace("[Answer]: A", "[Answer]:"));
    expect(next(proj)).toMatchObject({ unit: "alpha", questions_only: true });
    writeAnswers(proj, "alpha", false);
    expect(next(proj)).toMatchObject({ unit: "beta", questions_only: true });
    const none = questionsFile(proj, "beta");
    mkdirSync(join(none, ".."), { recursive: true });
    writeFileSync(none, "# Functional Design Questions\n\nNo questions: the requirements settle this Unit.\n");
    const wave = next(proj);
    expect(wave.wave?.entries.map((entry) => entry.unit)).toEqual(["alpha", "beta"]);
  });

  test("a serial Unit receipt on the question step is refused and keeps the wave", () => {
    const proj = project();
    expect(next(proj)).toMatchObject({ unit: "alpha", questions_only: true });
    const before = readAuditShardEvents(proj).length;
    const start = tool(STATE, ["unit", "start", "--stage", STAGE, "--unit", "alpha"], proj);
    expect(start.status).not.toBe(0);
    expect(`${start.stdout}${start.stderr}`).toContain("this step asks alpha's questions before the stage's wave builds it");
    expect(readAuditShardEvents(proj).length).toBe(before);
    confirmSummary(proj, "alpha");
    confirmSummary(proj, "beta");
    expect(next(proj).wave?.entries.map((entry) => entry.unit)).toEqual(["alpha", "beta"]);
  });

  test("an output saved before the Unit's confirmation does not hold it on its question step", () => {
    const proj = project();
    confirmSummary(proj, "alpha");
    // A builder from before the change wrote one of alpha's documents with no
    // answers behind it: the wave checks it, the question step does not.
    const dir = join(seededRecordDir(proj), "construction", "alpha", STAGE);
    writeFileSync(join(dir, "entities.md"), "# Entities\n");
    expect(next(proj)).toMatchObject({ unit: "beta", questions_only: true });
    confirmSummary(proj, "beta");
    expect(next(proj).wave?.entries.map((entry) => [entry.unit, entry.build_required])).toEqual([
      ["alpha", true],
      ["beta", true],
    ]);
  });

  test("answers changed after the confirmation are the summary guard's to say, not the same step again", () => {
    const proj = project();
    confirmSummary(proj, "alpha");
    const path = questionsFile(proj, "alpha");
    writeFileSync(path, readFileSync(path, "utf-8").replace("[Answer]: A", "[Answer]: B"));
    const step = next(proj);
    expect(step.questions_only).toBeUndefined();
    expect(step.wave).toBeUndefined();
    expect(JSON.stringify(step)).toContain("SUMMARY_CONTENT_STALE");
    // The way on names the Unit's questions file, not a placeholder.
    expect(JSON.stringify(step)).toContain(relative(proj, path).replaceAll("\\", "/"));
    expect(JSON.stringify(step)).not.toContain("<path to");
  });

  test("a chat that ended mid-questions hands the person's replies back on the Unit's question step", () => {
    const proj = project();
    expect(next(proj)).toMatchObject({ unit: "alpha", questions_only: true });
    const path = writeAnswers(proj, "alpha", true);
    writeFileSync(path, readFileSync(path, "utf-8").replace("[Answer]: A", "[Answer]:"));
    says(proj, "A, only its owner");
    const resumed = next(proj);
    expect(resumed).toMatchObject({ unit: "alpha", questions_only: true });
    expect((resumed.kept_replies as { replies: string[] } | undefined)?.replies).toEqual(["A, only its owner"]);
  });
});
