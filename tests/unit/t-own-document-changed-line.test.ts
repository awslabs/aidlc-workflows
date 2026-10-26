// covers: function:staleStageNote, function:ownDocumentChangedLine, function:inspectStageValidity, subcommand:aidlc-orchestrate:next, subcommand:aidlc-utility:status
//
// Under Guard Policy strict, the person edited Requirements Analysis' approved
// requirements.md during a later stage. The line they heard said
// "Requirements Analysis finished before something it used changed", and the
// agent went on to call their own line stray (a live Kiro IDE run). Now the
// line names the document that changed, says the work carries on with it, and
// asks in plain words whether to redo the stage. A document that is gone, or an input that changed, keeps the line it
// had.
//
// Under strict, the person typed "/aidlc yes, but add FR-2 for the empty title" at the gate; the agent recorded the
// approval and made the change, and every later step asked them about the change they had just asked for. A change
// to the stage's own documents made before their next message after the approving one is approved with it: the
// step records the stage's receipt for the files as they are, and nothing is said. An edit after their next
// message, an approval that names no message, or another decision in between keeps the question.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { auditBlockField, readAuditShardEvents, setGuardPolicyLine } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import {
  inspectStageValidity, stageValidationAuditFields, staleStageNote,
} from "../../dist/claude/.claude/tools/aidlc-validity.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, recordArtifactWriteViaHook, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import { env, exec, next, projectAt, say, templateProjects } from "../harness/aidlc-answers-corpus.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop()!);
});
afterAll(() => {
  for (const proj of templateProjects()) cleanupTestProject(proj);
});

const STAGE = "requirements-analysis";
const LINE = "requirements.md changed after Requirements Analysis finished. I'm carrying on with it as it is. " +
  "Do you want me to redo Requirements Analysis with your change instead?";

// With `approval`, the person's turn and the approval it backs come before the completion, as `report approved`
// writes them; `message` is the Message Id the approval names, or none.
function project(policy: "off" | "strict", approval?: { message: string | null }): { proj: string; requirements: string } {
  const proj = createTestProject();
  created.push(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const statePath = seededStateFile(proj);
  writeFileSync(statePath, readFileSync(statePath, "utf-8")
    .replace("- **Change Control**: strict (from scope bugfix)",
      policy === "off" ? "- **Guard Policy**: off (from scope bugfix)" : "- **Guard Policy**: strict (set by you)")
    .replace(/^- \[.\] requirements-analysis/m, "- [x] requirements-analysis"));
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const requirements = join(dir, "requirements.md");
  writeFileSync(requirements, "# Requirements\n\n- FR-1: a blank title is refused.\n");
  const stage = loadGraph().find((node) => node.slug === STAGE);
  if (!stage) throw new Error(`graph has no ${STAGE}`);
  if (approval) {
    appendAuditEntry("HUMAN_TURN", { Origin: "person", "Message Id": approval.message ?? "0b5e7a11" }, proj);
    appendAuditEntry("GATE_APPROVED", {
      Stage: STAGE, "User Input": "Approve", ...(approval.message ? { "Message Id": approval.message } : {}),
    }, proj);
  }
  appendAuditEntry("STAGE_COMPLETED", {
    Stage: STAGE, ...stageValidationAuditFields(proj, stage, readFileSync(statePath, "utf-8")),
  }, proj);
  return { proj, requirements };
}

function status(proj: string): string {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "status", "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
  });
  return `${result.stdout}${result.stderr}`;
}

describe("t-own-document-changed-line: an edit to a finished stage's own document", () => {
  for (const policy of ["off", "strict"] as const) {
    test(`the line names the document, carries on with it, and asks about the redo (Guard Policy ${policy})`, () => {
      const { proj, requirements } = project(policy);
      appendFileSync(requirements, "- FR-2: a title is at most 200 characters.\n");
      const state = readFileSync(seededStateFile(proj), "utf-8");
      const issue = inspectStageValidity(proj, state).issues.find((entry) => entry.stage === STAGE);
      expect(issue?.direct, JSON.stringify(issue)).toBe(true);
      expect(staleStageNote("Requirements Analysis", issue!, state)).toBe(LINE);
      expect(status(proj)).toContain(LINE);
      expect(status(proj)).not.toContain("used changed after it finished");
    });

    test(`a document that is gone keeps the line it had (Guard Policy ${policy})`, () => {
      const { proj, requirements } = project(policy);
      rmSync(requirements);
      const state = readFileSync(seededStateFile(proj), "utf-8");
      const issue = inspectStageValidity(proj, state).issues.find((entry) => entry.stage === STAGE);
      expect(issue?.direct, JSON.stringify(issue)).toBe(true);
      expect(staleStageNote("Requirements Analysis", issue!, state)).toBe(
        "Something Requirements Analysis used changed after it finished. I'm carrying on with it as it is. Do you want me to redo Requirements Analysis with the change?",
      );
      expect(status(proj)).not.toContain("requirements.md changed after");
    });
  }

  test("several documents are named together; an input that changed keeps its line", () => {
    expect(staleStageNote("User Stories", { reasons: ["output:personas", "output:stories"], edited: true }, "")).toBe(
      "personas.md and stories.md changed after User Stories finished. I'm carrying on with them as they are. " +
        "Do you want me to redo User Stories with your changes instead?",
    );
    expect(staleStageNote("User Stories", { reasons: ["input:requirements", "output:stories"] }, "")).toBe(
      "Something User Stories used changed after it finished. I'm carrying on with it as it is. Do you want me to redo User Stories with the change?",
    );
  });
});

const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const APPROVING = "/aidlc yes, but add FR-2 for the empty title";
const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
const amendments = (proj: string) => rows(proj, "STAGE_OUTPUT_AMENDED");
const latestTurn = (proj: string): string | null => {
  const turn = rows(proj, "HUMAN_TURN").at(-1);
  return turn === undefined ? null : auditBlockField(turn.block, "Message Id");
};
const validity = (directive: Record<string, unknown> | null) =>
  directive?.stage_validity as { directly_stale?: string[]; warning?: string } | undefined;

// The Requirements Analysis gate open under strict, as a run leaves it.
async function gateUnderStrict(): Promise<{ proj: string; requirements: string }> {
  const proj = await projectAt("stage-gate");
  created.push(proj);
  const file = seededStateFile(proj);
  writeFileSync(file, setGuardPolicyLine(readFileSync(file, "utf-8"), "strict (set by you)"));
  return { proj, requirements: join(seededRecordDir(proj), "inception", STAGE, "requirements.md") };
}

// The person's message through the human-turn hook; the id it is on record as.
async function personSays(proj: string, words: string): Promise<string> {
  expect((await say(proj, words, "claude")).status).toBe(0);
  const id = latestTurn(proj);
  expect(id).not.toBeNull();
  return id!;
}

// The agent records the approval as the protocol says, with no --message.
async function reportApproved(proj: string): Promise<void> {
  const approved = await exec(
    [process.execPath, ORCHESTRATE, "report", "--stage", STAGE, "--result", "approved", "--user-input", "Approve", "--project-dir", proj],
    { cwd: proj, env: env(proj) },
  );
  expect(approved.status, approved.stdout + approved.stderr).toBe(0);
}

// The agent's edit, through the write hook.
function agentEdits(proj: string, requirements: string, line: string): void {
  appendFileSync(requirements, line);
  recordArtifactWriteViaHook(proj, requirements, "Edit");
}

async function step(proj: string, extra: Record<string, string> = {}): Promise<Record<string, unknown> | null> {
  const result = await next(proj, [], { env: extra });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive;
}

describe("t-own-document-changed-line: under strict, a change asked for in the approving message", () => {
  test("a change made before the person's next message after the approving one is not asked about", async () => {
    const { proj, requirements } = await gateUnderStrict();
    const approving = await personSays(proj, APPROVING);
    await reportApproved(proj);
    agentEdits(proj, requirements, "- FR-2: an empty title is refused.\n");
    const first = await step(proj);
    expect(validity(first), JSON.stringify(first?.stage_validity)).toBeUndefined();
    expect(amendments(proj)).toHaveLength(1);
    const row = amendments(proj)[0];
    expect(auditBlockField(row.block, "Stage")).toBe(STAGE);
    expect(auditBlockField(row.block, "Message Id")).toBe(approving);
    expect(auditBlockField(row.block, "Validation Basis")).not.toBeNull();
    expect(auditBlockField(row.block, "Details")).toBe(
      `changed before the person's next message after ${approving}; receipt renewed`,
    );
    expect(validity(await step(proj))).toBeUndefined();
    expect(amendments(proj)).toHaveLength(1);
    // A later edit, after the person's next message, asks as before.
    await personSays(proj, "carry on");
    agentEdits(proj, requirements, "- FR-3: a title is at most 200 characters.\n");
    const later = await step(proj);
    expect(validity(later)?.warning, JSON.stringify(later?.stage_validity)).toBe(LINE);
    expect(amendments(proj)).toHaveLength(1);
  });

  test("an edit after the next human turn still asks", async () => {
    const { proj, requirements } = await gateUnderStrict();
    await personSays(proj, APPROVING);
    await reportApproved(proj);
    await personSays(proj, "looks good, carry on");
    agentEdits(proj, requirements, "- FR-2: an empty title is refused.\n");
    const directive = await step(proj);
    expect(validity(directive)?.warning, JSON.stringify(directive?.stage_validity)).toBe(LINE);
    expect(validity(directive)?.directly_stale).toContain(STAGE);
    expect(amendments(proj)).toHaveLength(0);
  });

  test("an approval with no Message Id keeps today's line", () => {
    const named = project("strict", { message: "1a56208a" });
    appendFileSync(named.requirements, "- FR-2: an empty title is refused.\n");
    const namedState = readFileSync(seededStateFile(named.proj), "utf-8");
    expect(inspectStageValidity(named.proj, namedState).issues).toEqual([]);
    expect(inspectStageValidity(named.proj, namedState).amended.map((entry) => entry.stage)).toEqual([STAGE]);

    const { proj, requirements } = project("strict", { message: null });
    appendFileSync(requirements, "- FR-2: an empty title is refused.\n");
    const state = readFileSync(seededStateFile(proj), "utf-8");
    const inspection = inspectStageValidity(proj, state);
    expect(inspection.amended).toEqual([]);
    const issue = inspection.issues.find((entry) => entry.stage === STAGE);
    expect(staleStageNote("Requirements Analysis", issue!, state)).toBe(LINE);
    expect(status(proj)).toContain(LINE);
  });

  test("status agrees: nothing inside the window, the line after a turn, never that AI-DLC changed the stage", async () => {
    const { proj, requirements } = await gateUnderStrict();
    await personSays(proj, APPROVING);
    await reportApproved(proj);
    agentEdits(proj, requirements, "- FR-2: an empty title is refused.\n");
    const inside = status(proj);
    expect(inside).not.toContain(LINE);
    expect(inside).not.toContain("AI-DLC now does");
    await step(proj);
    const recorded = status(proj);
    expect(recorded).not.toContain(LINE);
    expect(recorded).not.toContain("AI-DLC now does");
    await personSays(proj, "carry on");
    agentEdits(proj, requirements, "- FR-3: a title is at most 200 characters.\n");
    const after = status(proj);
    expect(after).toContain(LINE);
    expect(after).not.toContain("AI-DLC now does");
  });

  test("a read-only probe says nothing and records nothing", async () => {
    const { proj, requirements } = await gateUnderStrict();
    await personSays(proj, APPROVING);
    await reportApproved(proj);
    agentEdits(proj, requirements, "- FR-2: an empty title is refused.\n");
    const probe = await step(proj, { AIDLC_STOP_HOOK_PROBE: "1" });
    expect(validity(probe), JSON.stringify(probe?.stage_validity)).toBeUndefined();
    expect(amendments(proj)).toHaveLength(0);
    expect(validity(await step(proj))).toBeUndefined();
    expect(amendments(proj)).toHaveLength(1);
  });

  test("an autonomous approval after it closes the window", () => {
    const { proj, requirements } = project("strict", { message: "1a56208a" });
    appendFileSync(requirements, "- FR-2: an empty title is refused.\n");
    const state = readFileSync(seededStateFile(proj), "utf-8");
    expect(inspectStageValidity(proj, state).issues).toEqual([]);
    expect(status(proj)).not.toContain(LINE);
    appendAuditEntry("GATE_APPROVED", { Stage: "code-generation", Unit: "alpha", Autonomous: "true" }, proj);
    const issue = inspectStageValidity(proj, state).issues.find((entry) => entry.stage === STAGE);
    expect(issue?.edited, JSON.stringify(issue)).toBe(true);
    expect(staleStageNote("Requirements Analysis", issue!, state)).toBe(LINE);
    expect(status(proj)).toContain(LINE);
  });
});
