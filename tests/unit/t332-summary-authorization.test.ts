// covers: function:checkSummaryConfirmationEvidence, function:summaryAuthorizationId,
// function:summaryAttemptFloors, function:summaryAttemptIdentity,
// function:summaryScopeForRecordPath, function:activeSummaryAuthorizationForRecordPath,
// function:readSummaryAuthorization, function:writeSummaryAuthorization,
// function:clearSummaryAuthorization, function:isSummaryAuthorizationId,
// subcommand:aidlc-log:answer, hook:aidlc-write-audit-log
//
// t332 - a summary confirmation authorizes the outputs generated from it, and
// completion asks whether each output DESCENDS from the current authorization
// (the write's stamp equals the receipt's id), not whether the write landed
// AFTER the receipt. The order predicate produced a family of deadlocks: a
// same-answers re-confirmation demanded a fresh write that the review freeze
// forbade, and a receipt and a write in the same second could not be ordered.
// Every shape below is exercised through the shipped tools and the shipped
// write-audit hook, never by hand-writing the rows the model reads.

import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  activeSummaryAuthorizationForRecordPath,
  auditBlockField,
  checkSummaryConfirmationEvidence,
  clearSummaryAuthorization,
  isSummaryAuthorizationId,
  loadStageGraphAll,
  readAllAuditShards,
  readAuditShardEvents,
  readSummaryAuthorization,
  SUMMARY_AUTHORIZATION_FIELD,
  SUMMARY_CONFIRMATION_HASH_SCOPE,
  summaryAttemptFloors,
  summaryAttemptIdentity,
  summaryAuthorizationId,
  summaryAuthorizationRecordPath,
  summaryConfirmationContentHash,
  summaryScopeForRecordPath,
  writeSummaryAuthorization,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  recordArtifactWriteViaHook,
  seedAidlcMemory,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STAGE = "requirements-analysis";
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) cleanupTestProject(tempDirs.pop()!);
});

function project(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  return proj;
}

function run(args: string[], proj: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const result = Bun.spawnSync({
    cmd: [BUN, LOG, ...args, "--project-dir", proj],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function paths(proj: string) {
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    artifact: join(dir, "requirements.md"),
    questions: join(dir, `${STAGE}-questions.md`),
  };
}

function questionsBody(answer: string, requirement = "Keep the login flow."): string {
  return [
    "# Requirements Questions",
    "",
    "## Q1",
    "",
    `- ${requirement}`,
    "",
    "## Consolidated Summary Confirmation",
    "",
    "- Looks correct",
    "- Request changes",
    "",
    `[Answer]: ${answer}`,
    "",
  ].join("\n");
}

/** Present the summary and record the human's turn; the answer is the caller's. */
function present(proj: string, questions: string, requirement?: string): void {
  writeFileSync(questions, questionsBody("", requirement));
  const decision = run(
    [
      "decision",
      "--stage",
      STAGE,
      "--checkpoint",
      "summary-confirmation",
      "--questions-file",
      questions,
      "--decision",
      "Does this all look correct?",
    ],
    proj,
  );
  expect(decision.status, decision.stderr).toBe(0);
  appendAuditEntry("HUMAN_TURN", {}, proj);
}

function answer(proj: string, questions: string, choice: "Looks correct" | "Request changes") {
  return run(
    [
      "answer",
      "--stage",
      STAGE,
      "--checkpoint",
      "summary-confirmation",
      "--questions-file",
      questions,
      "--details",
      choice,
    ],
    proj,
  );
}

/** Present the summary, record a human turn, then record `choice`. Returns the receipt's id, if any. */
function confirm(
  proj: string,
  questions: string,
  choice: "Looks correct" | "Request changes" = "Looks correct",
  requirement?: string,
): string | null {
  writeFileSync(questions, questionsBody("", requirement));
  const decision = run(
    [
      "decision",
      "--stage",
      STAGE,
      "--checkpoint",
      "summary-confirmation",
      "--questions-file",
      questions,
      "--decision",
      "Does this all look correct?",
    ],
    proj,
  );
  expect(decision.status, decision.stderr).toBe(0);
  appendAuditEntry("HUMAN_TURN", {}, proj);
  writeFileSync(questions, questionsBody(choice, requirement));
  const answer = run(
    [
      "answer",
      "--stage",
      STAGE,
      "--checkpoint",
      "summary-confirmation",
      "--questions-file",
      questions,
      "--details",
      choice,
    ],
    proj,
  );
  expect(answer.status, answer.stderr).toBe(0);
  const parsed = JSON.parse(answer.stdout) as { summary_authorization_id?: string };
  return parsed.summary_authorization_id ?? null;
}

function writeArtifact(proj: string, artifact: string, content = "# Requirements\n"): void {
  const tool = existsSync(artifact) ? "Edit" : "Write";
  writeFileSync(artifact, content);
  recordArtifactWriteViaHook(proj, artifact, tool);
}

function evidence(proj: string) {
  const prior = process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  try {
    const stage = loadStageGraphAll().find((entry) => entry.slug === STAGE)!;
    return checkSummaryConfirmationEvidence(proj, stage, {
      stateContent: readFileSync(seededStateFile(proj), "utf-8"),
    });
  } finally {
    if (prior !== undefined) process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = prior;
  }
}

function receipts(proj: string) {
  return readAuditShardEvents(proj).filter(
    (entry) => entry.event === "SUMMARY_CONFIRMATION_RECORDED",
  );
}

function artifactWrites(proj: string) {
  return readAuditShardEvents(proj).filter(
    (entry) => entry.event === "ARTIFACT_CREATED" || entry.event === "ARTIFACT_UPDATED",
  );
}

describe("t332 summary authorization id", () => {
  test("Looks correct mints an id, records it on the receipt, and makes it the active authorization", () => {
    const proj = project();
    const { questions } = paths(proj);
    const id = confirm(proj, questions);
    expect(isSummaryAuthorizationId(id)).toBe(true);
    const [receipt] = receipts(proj);
    expect(auditBlockField(receipt.block, SUMMARY_AUTHORIZATION_FIELD)).toBe(id as string);
    const active = readSummaryAuthorization(proj, STAGE, null);
    expect(active?.id).toBe(id as string);
    expect(active?.choice).toBe("Looks correct");
    expect(active?.questions_sha256).toBe(
      summaryConfirmationContentHash(readFileSync(questions, "utf-8")),
    );
    expect(auditBlockField(receipt.block, "Hash Scope")).toBe(SUMMARY_CONFIRMATION_HASH_SCOPE);
  });

  test("the id is a function of attempt, scope, questions, content, and choice", () => {
    const base = {
      attempt: "WORKFLOW_STARTED:2026-09-02T10:00:00Z:host-a:3",
      stage: STAGE,
      unit: null,
      workflow: null,
      questionsFile: "aidlc/spaces/default/intents/x/inception/requirements-analysis/requirements-analysis-questions.md",
      questionsSha256: "a".repeat(64),
      choice: "Looks correct",
    };
    const id = summaryAuthorizationId(base);
    expect(isSummaryAuthorizationId(id)).toBe(true);
    expect(summaryAuthorizationId({ ...base })).toBe(id);
    for (const variant of [
      { attempt: "STAGE_JUMPED:2026-09-02T10:00:01Z:host-a:4" },
      { stage: "functional-design" },
      { unit: "api" },
      { workflow: "single-stage:requirements-analysis" },
      { questionsFile: `${base.questionsFile}.other` },
      { questionsSha256: "b".repeat(64) },
      { choice: "Request changes" },
    ]) {
      expect(summaryAuthorizationId({ ...base, ...variant }), JSON.stringify(variant)).not.toBe(id);
    }
    expect(isSummaryAuthorizationId(null)).toBe(false);
    expect(isSummaryAuthorizationId("A".repeat(64))).toBe(false);
    expect(isSummaryAuthorizationId("a".repeat(63))).toBe(false);
  });

  test("the write-audit hook stamps stage outputs with the active authorization and nothing else", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    // Before any confirmation: a write carries no id.
    writeArtifact(proj, artifact, "# draft\n");
    expect(auditBlockField(artifactWrites(proj)[0].block, SUMMARY_AUTHORIZATION_FIELD)).toBeNull();
    const id = confirm(proj, questions);
    writeArtifact(proj, artifact);
    const writes = artifactWrites(proj);
    expect(writes).toHaveLength(2);
    expect(auditBlockField(writes[1].block, SUMMARY_AUTHORIZATION_FIELD)).toBe(id as string);
    // An output of another stage is not this stage's descendant.
    const other = join(seededRecordDir(proj), "inception", "user-stories", "stories.md");
    mkdirSync(join(seededRecordDir(proj), "inception", "user-stories"), { recursive: true });
    writeArtifact(proj, other, "# stories\n");
    expect(auditBlockField(artifactWrites(proj)[2].block, SUMMARY_AUTHORIZATION_FIELD)).toBeNull();
  });

  test("an output written under the current authorization completes; one written before it does not", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    writeArtifact(proj, artifact, "# before\n");
    confirm(proj, questions);
    const before = evidence(proj);
    expect(before.ok).toBe(false);
    if (before.ok) throw new Error("expected refusal");
    expect(before.refusal?.code).toBe("SUMMARY_ARTIFACT_UNAUTHORIZED");
    expect(before.message).toContain("was last saved before the confirmed answers");
    writeArtifact(proj, artifact, "# generated from the confirmation\n");
    expect(evidence(proj).ok).toBe(true);
  });

  test("a same-answers re-confirmation mints the same id and demands no new write", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    const first = confirm(proj, questions);
    writeArtifact(proj, artifact);
    expect(evidence(proj).ok).toBe(true);
    // The human is asked again and gives the same answer (a re-presented
    // summary after a compaction, a status sync, a prompt repair). Under the
    // order predicate this receipt postdated every write and demanded another
    // write, which a terminal review freeze forbade: the deadlock. Under
    // descent the id is unchanged, so the existing write still descends.
    const second = confirm(proj, questions);
    expect(second).toBe(first);
    expect(receipts(proj)).toHaveLength(2);
    expect(artifactWrites(proj)).toHaveLength(1);
    expect(evidence(proj).ok).toBe(true);
  });

  test("the receipt and the write in the same second are decided by descent, not order", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    const id = confirm(proj, questions);
    writeArtifact(proj, artifact);
    const [receipt] = receipts(proj);
    const [write] = artifactWrites(proj);
    // The audit clock is one second; the two rows share it in the common case.
    // A predicate that needs "write strictly after receipt" has no answer here.
    expect(write.timestamp >= receipt.timestamp).toBe(true);
    expect(auditBlockField(write.block, SUMMARY_AUTHORIZATION_FIELD)).toBe(id as string);
    expect(evidence(proj).ok).toBe(true);
  });

  test("changed answers mint a new id, the old outputs no longer descend, and re-saving repairs it", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    const first = confirm(proj, questions);
    writeArtifact(proj, artifact);
    expect(evidence(proj).ok).toBe(true);
    const second = confirm(proj, questions, "Looks correct", "Drop the login flow.");
    expect(second).not.toBe(first);
    const stale = evidence(proj);
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected refusal");
    expect(stale.refusal?.code).toBe("SUMMARY_ARTIFACT_UNAUTHORIZED");
    expect(stale.message).toContain("was last saved under a different summary confirmation");
    writeArtifact(proj, artifact, "# regenerated\n");
    expect(auditBlockField(artifactWrites(proj)[1].block, SUMMARY_AUTHORIZATION_FIELD)).toBe(second as string);
    expect(evidence(proj).ok).toBe(true);
  });

  test("a gate rejection, recovered or human, retires neither the confirmation nor the outputs' descent", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, proj);
    appendAuditEntry("STAGE_STARTED", { Stage: STAGE, Agent: "orchestrator" }, proj);
    const id = confirm(proj, questions);
    writeArtifact(proj, artifact);
    expect(evidence(proj).ok).toBe(true);
    // The approve-time backstop records a synthetic rejection pair for a
    // revision nobody recorded. For the summary confirmation that is
    // bookkeeping, not a new attempt of this stage: the floor does not move,
    // the receipt still stands, and the outputs still descend from it. (The
    // review receipts' own boundary rules are pinned elsewhere and unchanged.)
    appendAuditEntry("GATE_REJECTED", { Stage: STAGE, Feedback: "revision backfilled", Recovered: "true" }, proj);
    appendAuditEntry("STAGE_REVISING", { Stage: STAGE, Recovered: "true" }, proj);
    expect(evidence(proj).ok).toBe(true);
    expect(readSummaryAuthorization(proj, STAGE, null)?.id).toBe(id as string);
    // A human rejection is the same for the summary: the confirmation binds to
    // the attempt, and only a jump or a restart opens one.
    appendAuditEntry("GATE_REJECTED", { Stage: STAGE, Feedback: "tighten the scope" }, proj);
    appendAuditEntry("STAGE_REVISING", { Stage: STAGE }, proj);
    expect(evidence(proj).ok).toBe(true);
    writeArtifact(proj, artifact, "# revised after feedback\n");
    expect(auditBlockField(artifactWrites(proj)[1].block, SUMMARY_AUTHORIZATION_FIELD)).toBe(id as string);
    expect(evidence(proj).ok).toBe(true);
  });

  test("Request changes withdraws the active authorization; the next Looks correct re-arms it", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    const first = confirm(proj, questions);
    writeArtifact(proj, artifact);
    expect(confirm(proj, questions, "Request changes")).toBeNull();
    expect(readSummaryAuthorization(proj, STAGE, null)).toBeNull();
    // A write made while the human is asking for changes descends from nothing.
    writeArtifact(proj, artifact, "# revising\n");
    expect(auditBlockField(artifactWrites(proj)[1].block, SUMMARY_AUTHORIZATION_FIELD)).toBeNull();
    const withdrawn = evidence(proj);
    expect(withdrawn.ok).toBe(false);
    if (withdrawn.ok) throw new Error("expected refusal");
    // The questions file itself says "Request changes": that is the refusal.
    expect(withdrawn.refusal?.code).toBe("SUMMARY_ANSWER_INVALID");
    const second = confirm(proj, questions, "Looks correct", "Keep the login flow, add MFA.");
    expect(second).not.toBe(first);
    const unrepaired = evidence(proj);
    expect(unrepaired.ok).toBe(false);
    if (unrepaired.ok) throw new Error("expected refusal");
    expect(unrepaired.message).toContain("was last saved before the confirmed answers");
    writeArtifact(proj, artifact, "# revised with MFA\n");
    expect(evidence(proj).ok).toBe(true);
  });

  test("a legacy receipt without an id still decides by order", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    writeFileSync(questions, questionsBody("Looks correct"));
    writeArtifact(proj, artifact);
    appendAuditEntry(
      "SUMMARY_CONFIRMATION_RECORDED",
      {
        Stage: STAGE,
        Details: "Looks correct",
        Checkpoint: "Consolidated Summary Confirmation",
        "Questions File": relative(proj, questions).replaceAll("\\", "/"),
        "Questions SHA-256": summaryConfirmationContentHash(readFileSync(questions, "utf-8")),
        "Hash Scope": SUMMARY_CONFIRMATION_HASH_SCOPE,
      },
      proj,
    );
    const stale = evidence(proj);
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected refusal");
    expect(stale.refusal?.code).toBe("SUMMARY_ARTIFACT_ORDER_INVALID");
    expect(stale.message).toContain("was not saved after the confirmed answers");
  });

  test("the attempt identity names the newest floor row, and a new attempt mints a new id", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    expect(summaryAttemptFloors(readAuditShardEvents(proj), STAGE, undefined, false)).toEqual([]);
    expect(summaryAttemptIdentity([])).toBe("unstarted");
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, proj);
    const started = summaryAttemptFloors(readAuditShardEvents(proj), STAGE, undefined, false);
    expect(started).toHaveLength(1);
    expect(started[0].event).toBe("WORKFLOW_STARTED");
    const identity = summaryAttemptIdentity(started);
    expect(identity).toMatch(/^WORKFLOW_STARTED:/);
    expect(identity).toBe(
      summaryAttemptIdentity(summaryAttemptFloors(readAuditShardEvents(proj), STAGE, undefined, false)),
    );
    // An isolated run floors on its own STAGE_COMPLETED rows only.
    expect(summaryAttemptFloors(readAuditShardEvents(proj), STAGE, "single-stage:requirements-analysis", false)).toEqual([]);

    const first = confirm(proj, questions);
    writeArtifact(proj, artifact);
    expect(evidence(proj).ok).toBe(true);
    expect(readSummaryAuthorization(proj, STAGE, null)?.attempt).toBe(identity);
    // A backward jump opens a new attempt: the same answers re-confirmed there
    // are a new authorization, and the earlier attempt's outputs do not
    // descend from it until they are saved again.
    appendAuditEntry("STAGE_JUMPED", { From: "user-stories", To: STAGE, Stage: STAGE }, proj);
    const jumped = summaryAttemptFloors(readAuditShardEvents(proj), STAGE, undefined, false);
    expect(jumped.map((floor) => floor.event)).toEqual(["STAGE_JUMPED"]);
    const second = confirm(proj, questions);
    expect(second).not.toBe(first);
    expect(readSummaryAuthorization(proj, STAGE, null)?.attempt).toBe(summaryAttemptIdentity(jumped));
    const stale = evidence(proj);
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected refusal");
    expect(stale.refusal?.code).toBe("SUMMARY_ARTIFACT_UNAUTHORIZED");
    writeArtifact(proj, artifact, "# regenerated in the new attempt\n");
    expect(evidence(proj).ok).toBe(true);
  });
});

describe("t332 authorization scope resolution", () => {
  const stageSlugs = new Set(["functional-design", "build-and-test", "requirements-analysis"]);

  test("record paths map to stage-level or per-Unit scopes", () => {
    expect(summaryScopeForRecordPath("inception/requirements-analysis/requirements.md", stageSlugs)).toEqual({
      stage: "requirements-analysis",
      unit: null,
    });
    expect(summaryScopeForRecordPath("construction/api/functional-design/entities.md", stageSlugs)).toEqual({
      stage: "functional-design",
      unit: "api",
    });
    expect(summaryScopeForRecordPath("construction/build-and-test/report.md", stageSlugs)).toEqual({
      stage: "build-and-test",
      unit: null,
    });
    // A stage-level Construction output nested one level deeper is still stage-level.
    expect(summaryScopeForRecordPath("construction/build-and-test/logs/run.md", stageSlugs)).toEqual({
      stage: "build-and-test",
      unit: null,
    });
    expect(summaryScopeForRecordPath("audit/host-clone.md", stageSlugs)).toBeNull();
    expect(summaryScopeForRecordPath("aidlc-state.md", stageSlugs)).toBeNull();
  });

  test("a per-Unit write prefers its Unit's authorization and falls back only to an isolated run's stage-level one", () => {
    const proj = project();
    const record = seededRecordDir(proj);
    const stageLevel = {
      version: 1 as const,
      id: "1".repeat(64),
      stage: "functional-design",
      unit: null,
      workflow: "single-stage:functional-design",
      attempt: "STAGE_COMPLETED:2026-09-02T10:00:00Z:host:1",
      questions_file: "construction/api/functional-design/functional-design-questions.md",
      questions_sha256: "c".repeat(64),
      choice: "Looks correct",
      recorded_at: "2026-09-02T10:00:01Z",
    };
    writeSummaryAuthorization(proj, stageLevel);
    expect(existsSync(summaryAuthorizationRecordPath(record, "functional-design", null))).toBe(true);
    const path = "construction/api/functional-design/entities.md";
    expect(activeSummaryAuthorizationForRecordPath(proj, path, stageSlugs)?.id).toBe(stageLevel.id);
    writeSummaryAuthorization(proj, { ...stageLevel, id: "2".repeat(64), unit: "api", workflow: null });
    expect(activeSummaryAuthorizationForRecordPath(proj, path, stageSlugs)?.id).toBe("2".repeat(64));
    // A main-workflow stage-level confirmation (no isolated workflow) never
    // authorizes a Unit's outputs: the Unit owes its own confirmation.
    writeSummaryAuthorization(proj, { ...stageLevel, id: "3".repeat(64), workflow: null });
    expect(
      activeSummaryAuthorizationForRecordPath(proj, "construction/web/functional-design/entities.md", stageSlugs),
    ).toBeNull();
    expect(activeSummaryAuthorizationForRecordPath(proj, path, stageSlugs)?.id).toBe("2".repeat(64));
    // Nor does another stage's isolated run.
    writeSummaryAuthorization(proj, { ...stageLevel, id: "4".repeat(64), workflow: "single-stage:build-and-test" });
    expect(
      activeSummaryAuthorizationForRecordPath(proj, "construction/web/functional-design/entities.md", stageSlugs),
    ).toBeNull();
    // A stage-level path reads the stage-level record whatever its workflow.
    expect(
      activeSummaryAuthorizationForRecordPath(proj, "construction/functional-design/overview.md", stageSlugs)?.id,
    ).toBe("4".repeat(64));
    clearSummaryAuthorization(proj, "functional-design", null);
    clearSummaryAuthorization(proj, "functional-design", "api");
    expect(activeSummaryAuthorizationForRecordPath(proj, path, stageSlugs)).toBeNull();
    expect(activeSummaryAuthorizationForRecordPath(proj, "audit/x.md", stageSlugs)).toBeNull();
  });

  test("a symlinked registry directory is refused: nothing is written, read, or removed through it", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    const record = seededRecordDir(proj);
    const outsideRoot = createTestProject();
    tempDirs.push(outsideRoot);
    const outside = join(outsideRoot, "elsewhere");
    mkdirSync(outside, { recursive: true });
    // The registry directory is pre-created as a link out of the record.
    symlinkSync(outside, join(record, ".aidlc-summary-authorization"));

    // The answer is refused before the receipt exists: no row, no id, no file.
    present(proj, questions);
    writeFileSync(questions, questionsBody("Looks correct"));
    const refused = answer(proj, questions, "Looks correct");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("is a symlink");
    expect(refused.stderr).toContain("Nothing was recorded");
    expect(receipts(proj)).toHaveLength(0);
    expect(readdirSync(outside)).toEqual([]);

    // A record planted at the redirected target is not an authorization, and
    // a write of a stage output picks up no stamp from it.
    mkdirSync(join(outside, STAGE), { recursive: true });
    const planted = JSON.stringify({
      version: 1,
      id: "5".repeat(64),
      stage: STAGE,
      unit: null,
      workflow: null,
      attempt: "x",
      questions_file: "q",
      questions_sha256: "6".repeat(64),
      choice: "Looks correct",
      recorded_at: "2026-09-02T10:00:00Z",
    });
    writeFileSync(join(outside, STAGE, "stage-level.json"), planted);
    expect(readSummaryAuthorization(proj, STAGE, null)).toBeNull();
    writeArtifact(proj, artifact);
    expect(auditBlockField(artifactWrites(proj)[0].block, SUMMARY_AUTHORIZATION_FIELD)).toBeNull();

    // Neither the library writer nor the remover reaches through the link.
    expect(() =>
      writeSummaryAuthorization(proj, {
        version: 1,
        id: "7".repeat(64),
        stage: STAGE,
        unit: null,
        workflow: null,
        attempt: "x",
        questions_file: "q",
        questions_sha256: "8".repeat(64),
        choice: "Looks correct",
        recorded_at: "2026-09-02T10:00:00Z",
      }),
    ).toThrow(/is a symlink/);
    expect(() => clearSummaryAuthorization(proj, STAGE, null)).toThrow(/is a symlink/);
    expect(readFileSync(join(outside, STAGE, "stage-level.json"), "utf-8")).toBe(planted);
    expect(readdirSync(join(outside, STAGE))).toEqual(["stage-level.json"]);
  });

  test("a registry write failure refuses before the receipt, and the same decision recovers without a new human turn", () => {
    const proj = project();
    const { artifact, questions } = paths(proj);
    const record = seededRecordDir(proj);
    // A regular file where the stage's registry directory belongs: the
    // authorization cannot be saved there.
    mkdirSync(join(record, ".aidlc-summary-authorization"), { recursive: true });
    const blocker = join(record, ".aidlc-summary-authorization", STAGE);
    writeFileSync(blocker, "not a directory\n", "utf-8");

    present(proj, questions);
    writeFileSync(questions, questionsBody("Looks correct"));
    const refused = answer(proj, questions, "Looks correct");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("its authorization record could not be saved");
    expect(refused.stderr).toContain("Nothing was recorded");
    // No receipt consumed the human's turn, and no authorization exists.
    expect(receipts(proj)).toHaveLength(0);
    expect(readSummaryAuthorization(proj, STAGE, null)).toBeNull();
    expect(readFileSync(blocker, "utf-8")).toBe("not a directory\n");

    // Repair the cause and run the SAME command: the pending question and the
    // human turn already recorded are enough.
    rmSync(blocker);
    const recovered = answer(proj, questions, "Looks correct");
    expect(recovered.status, recovered.stderr).toBe(0);
    const id = (JSON.parse(recovered.stdout) as { summary_authorization_id?: string }).summary_authorization_id;
    expect(isSummaryAuthorizationId(id ?? null)).toBe(true);
    expect(receipts(proj)).toHaveLength(1);
    expect(readSummaryAuthorization(proj, STAGE, null)?.id).toBe(id as string);
    // And the decision is spent exactly once: a second identical answer with no
    // new human turn is refused as it always was.
    expect(answer(proj, questions, "Looks correct").status).not.toBe(0);
    writeArtifact(proj, artifact);
    expect(evidence(proj).ok).toBe(true);
  });

  // The ledger tolerates hard links and skips symlinked shards on read as well
  // as on append, so the one injection that breaks the APPEND while every read
  // still works is a read-only shard. That does not deny root or Windows: gate
  // it the way t47-failure-injection gates its chmod cases.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const runIfChmod = process.platform !== "win32" && !isRoot ? test : test.skip;
  for (const prior of ["valid", "malformed"] as const) {
    runIfChmod(`a receipt that fails to append rolls the registry back to its exact prior bytes (${prior} prior record)`, () => {
      const proj = project();
      const { artifact, questions } = paths(proj);
      const first = confirm(proj, questions);
      writeArtifact(proj, artifact);
      const registry = summaryAuthorizationRecordPath(seededRecordDir(proj), STAGE, null);
      if (prior === "malformed") writeFileSync(registry, "{ not json\n", "utf-8");
      const priorBytes = readFileSync(registry);
      if (prior === "valid") expect(priorBytes.toString("utf-8")).toContain(first as string);

      // Changed answers are presented; then the shard becomes read-only, so
      // the receipt cannot be appended while every read still works.
      present(proj, questions, "Drop the login flow.");
      writeFileSync(questions, questionsBody("Looks correct", "Drop the login flow."));
      const shard = seededAuditShard(proj);
      chmodSync(shard, 0o444);
      let failed: ReturnType<typeof answer>;
      try {
        failed = answer(proj, questions, "Looks correct");
      } finally {
        chmodSync(shard, 0o644);
      }
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain("Audit emission failed");
      expect(failed.stderr).not.toContain("could not be restored");
      // No receipt for the new answers, and the registry is byte-identical to
      // what it was before the failed answer, whatever those bytes were.
      expect(receipts(proj)).toHaveLength(1);
      expect(readFileSync(registry).equals(priorBytes)).toBe(true);
      if (prior === "valid") {
        expect(readSummaryAuthorization(proj, STAGE, null)?.id).toBe(first as string);
      } else {
        expect(readSummaryAuthorization(proj, STAGE, null)).toBeNull();
      }

      // The same decision recovers once the shard is writable again.
      const recovered = answer(proj, questions, "Looks correct");
      expect(recovered.status, recovered.stderr).toBe(0);
      const second = (JSON.parse(recovered.stdout) as { summary_authorization_id?: string }).summary_authorization_id;
      expect(second).not.toBe(first as string);
      expect(readSummaryAuthorization(proj, STAGE, null)?.id).toBe(second as string);
      expect(receipts(proj)).toHaveLength(2);
    });
  }

  test("a malformed or mis-scoped authorization record is not an authorization", () => {
    const proj = project();
    const record = seededRecordDir(proj);
    const path = summaryAuthorizationRecordPath(record, STAGE, null);
    mkdirSync(join(record, ".aidlc-summary-authorization", STAGE), { recursive: true });
    for (const body of [
      "not json",
      JSON.stringify({ version: 2, id: "a".repeat(64), stage: STAGE, unit: null }),
      JSON.stringify({ version: 1, id: "not-an-id", stage: STAGE, unit: null }),
      JSON.stringify({ version: 1, id: "a".repeat(64), stage: "functional-design", unit: null }),
      JSON.stringify({ version: 1, id: "a".repeat(64), stage: STAGE, unit: "api" }),
    ]) {
      writeFileSync(path, body, "utf-8");
      expect(readSummaryAuthorization(proj, STAGE, null), body).toBeNull();
    }
    expect(readAllAuditShards(proj)).not.toContain(SUMMARY_AUTHORIZATION_FIELD);
  });
});
