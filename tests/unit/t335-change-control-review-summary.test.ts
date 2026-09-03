// covers: function:freshReviewReceipts, function:checkSummaryConfirmationEvidence,
// function:recordAcceptedChanges, function:acceptedReviewChanges, function:renderReviewBrief,
// subcommand:aidlc-state:approve, subcommand:aidlc-state:gate-start,
// subcommand:aidlc-log:review, subcommand:aidlc-orchestrate:report,
// hook:aidlc-review-freeze, hook:aidlc-plan-approval-guard, audit:CHANGE_ACCEPTED
//
// t335 - Change Control at the review-receipt and summary-confirmation
// checkpoints, and the five places it never reaches. Under `relaxed` a terminal
// review receipt whose reviewed content changed afterwards stays valid for the
// gate: the gate presentation says the reviewed content differs and names the
// diff, one CHANGE_ACCEPTED row is written, and the reviewer's verdict is never
// altered. An output saved without the current summary confirmation is recorded
// and the stage continues. The review-freeze hook keeps refusing the write in
// its window under both values, and no relaxed setting ever skips a human gate,
// Plan Approval itself, the autonomous-mode plan stop, or the observer barrier.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  CHANGE_CONTROL_FIELD,
  checkSummaryConfirmationEvidence,
  freshReviewReceipts,
  loadStageGraphAll,
  readAuditShardEvents,
  readAllAuditShards,
  setField,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  recordArtifactWriteViaHook,
  seedAidlcMemory,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOLS = join(AIDLC_SRC, "tools");
const HOOKS = join(AIDLC_SRC, "hooks");
const STATE_TOOL = join(TOOLS, "aidlc-state.ts");
const LOG_TOOL = join(TOOLS, "aidlc-log.ts");
const BRIEF_TOOL = join(TOOLS, "aidlc-review-brief.ts");
const ORCHESTRATE_TOOL = join(TOOLS, "aidlc-orchestrate.ts");
const FREEZE_HOOK = join(HOOKS, "aidlc-review-freeze.ts");
const GUARD_HOOK = join(HOOKS, "aidlc-plan-approval-guard.ts");
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const TEST_ENV = {
  AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
  AIDLC_SKIP_REVIEWER_GATE_GUARD: "0",
};

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) cleanupTestProject(dir);
});

function run(tool: string, args: string[], project: string, env: Record<string, string> = TEST_ENV) {
  const result = spawnSync(BUN, [tool, ...args, "--project-dir", project], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...env },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runHook(hook: string, project: string, payload: Record<string, unknown>) {
  const result = spawnSync(BUN, [hook], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, ...TEST_ENV },
    encoding: "utf-8",
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A mid-inception project (requirements-analysis in progress) on `mode`. */
function project(mode: "strict" | "relaxed"): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, join(FIXTURES_DIR, "state-mid-inception.md"));
  const statePath = seededStateFile(proj);
  writeFileSync(
    statePath,
    setField(readFileSync(statePath, "utf-8"), CHANGE_CONTROL_FIELD, `${mode} (set by you)`),
  );
  return proj;
}

function stageDir(proj: string): string {
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function artifact(proj: string): string {
  return join(stageDir(proj), "requirements.md");
}

/** The output as the human line names it: relative to the project. */
function artifactRelative(proj: string): string {
  return relative(proj, artifact(proj));
}

/** Request and record one READY review through the shipped review command. */
function recordReadyReview(proj: string): void {
  const dir = stageDir(proj);
  for (const name of ["requirements.md", `${STAGE}-questions.md`]) {
    const path = join(dir, name);
    if (!existsSync(path)) writeFileSync(path, `# ${name}\n`);
  }
  const base = ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"];
  const requested = run(LOG_TOOL, base, proj);
  expect(requested.status, requested.stderr).toBe(0);
  appendFileSync(
    join(dir, "requirements.md"),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`,
    "utf-8",
  );
  const completed = run(LOG_TOOL, [...base, "--verdict", "READY"], proj);
  expect(completed.status, completed.stderr).toBe(0);
}

/** Change the reviewed bytes after the receipt and record the write in the ledger. */
function editReviewedArtifact(proj: string): void {
  appendFileSync(artifact(proj), "\nA requirement added after the review.\n", "utf-8");
  appendAuditEntry(
    "ARTIFACT_UPDATED",
    {
      File: artifact(proj),
      Tool: "Edit",
      Context: `inception > ${STAGE} > requirements.md`,
    },
    proj,
  );
}

function stage() {
  return loadStageGraphAll().find((entry) => entry.slug === STAGE)!;
}

function acceptedRows(proj: string) {
  return readAuditShardEvents(proj).filter((entry) => entry.event === "CHANGE_ACCEPTED");
}

function reviewCompletedRows(proj: string) {
  return readAuditShardEvents(proj).filter((entry) => entry.event === "REVIEW_COMPLETED");
}

/** The change_notices lines the state tool printed. */
function printedNotices(stdout: string): string[] {
  const notices: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object" || !("change_notices" in parsed)) continue;
    const carried = parsed.change_notices;
    if (!Array.isArray(carried)) continue;
    for (const notice of carried) if (typeof notice === "string") notices.push(notice);
  }
  return notices;
}

describe("t335 (1) review receipt: relaxed keeps the verdict and carries the change to the gate", () => {
  test("the scan keeps the READY verdict, names the changed artifact, and the row is written once at the gate", () => {
    const proj = project("relaxed");
    recordReadyReview(proj);
    const gate = run(STATE_TOOL, ["gate-start", STAGE], proj);
    expect(gate.status, gate.stderr).toBe(0);
    expect(printedNotices(gate.stdout)).toEqual([]);
    editReviewedArtifact(proj);

    const state = readFileSync(seededStateFile(proj), "utf-8");
    const receipts = freshReviewReceipts(proj, state, stage());
    expect(receipts.stageVerdict).toBe("READY");
    expect(receipts.stageStale).toBe(false);
    expect(receipts.acceptedChanges).toHaveLength(1);
    expect(receipts.acceptedChanges[0].checkpoint).toBe("review-receipt");
    expect(receipts.acceptedChanges[0].changed).toEqual([artifactRelative(proj)]);
    expect(receipts.acceptedChanges[0].notice).toBe(
      `${artifactRelative(proj)} changed after it was reviewed. Continuing to the gate with the diff (Change Control: relaxed).`,
    );
    // Reading is not recording: nothing is written until a transition runs.
    expect(acceptedRows(proj)).toHaveLength(0);

    // The gate re-presents (revalidates) and the approval both continue; the
    // ledger carries the change exactly once and the human hears it once.
    const revalidated = run(STATE_TOOL, ["gate-start", STAGE], proj);
    expect(revalidated.status, revalidated.stderr).toBe(0);
    const notices = printedNotices(revalidated.stdout);
    expect(notices).toEqual([
      `${artifactRelative(proj)} changed after it was reviewed. Continuing to the gate with the diff (Change Control: relaxed).`,
    ]);
    let rows = acceptedRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Stage")).toBe(STAGE);
    expect(auditBlockField(rows[0].block, "Checkpoint")).toBe("review-receipt");
    expect(auditBlockField(rows[0].block, "Changed")).toBe(artifactRelative(proj));
    expect(auditBlockField(rows[0].block, "Recorded")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(auditBlockField(rows[0].block, "Current")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(auditBlockField(rows[0].block, "Recorded")).not.toBe(
      auditBlockField(rows[0].block, "Current"),
    );

    const approved = run(STATE_TOOL, ["approve", STAGE], proj);
    expect(approved.status, approved.stderr).toBe(0);
    expect(printedNotices(approved.stdout)).toEqual([]);
    rows = acceptedRows(proj);
    expect(rows).toHaveLength(1);
    // The reviewer's verdict is exactly what was recorded.
    const completed = reviewCompletedRows(proj);
    expect(completed).toHaveLength(1);
    expect(auditBlockField(completed[0].block, "Verdict")).toBe("READY");
    expect(readAllAuditShards(proj)).not.toContain("Recovery: stale-receipt");
  });

  test("the gate presentation says the reviewed content differs and lists the diff", () => {
    const proj = project("relaxed");
    recordReadyReview(proj);
    expect(run(STATE_TOOL, ["gate-start", STAGE], proj).status).toBe(0);
    editReviewedArtifact(proj);
    expect(run(STATE_TOOL, ["gate-start", STAGE], proj).status).toBe(0);
    const brief = run(BRIEF_TOOL, ["review", "--stage", STAGE, "--why", "first"], proj);
    expect(brief.status, brief.stderr).toBe(0);
    expect(brief.stdout).toContain(
      `**Reviewed content differs:** ${artifactRelative(proj)} changed after it was reviewed. Continuing to the gate with the diff (Change Control: relaxed).`,
    );
    expect(brief.stdout).toContain(`**Changed after review:** \`${artifactRelative(proj)}\``);
    expect(brief.stdout).toContain("**Decision options:**");
  });

  test("the engine's report carries the change line onto its directive", () => {
    const proj = project("relaxed");
    recordReadyReview(proj);
    editReviewedArtifact(proj);
    const reported = run(
      ORCHESTRATE_TOOL,
      ["report", "--stage", STAGE, "--result", "awaiting-approval"],
      proj,
    );
    expect(reported.status, reported.stderr).toBe(0);
    const directive: unknown = JSON.parse(reported.stdout.trim().split("\n").pop() ?? "{}");
    expect(directive).toMatchObject({
      kind: "print",
      change_notices: [
        `${artifactRelative(proj)} changed after it was reviewed. Continuing to the gate with the diff (Change Control: relaxed).`,
      ],
    });
    expect(acceptedRows(proj)).toHaveLength(1);
  });

  test("strict is today's refusal: the receipt is stale and the recovery review is owed", () => {
    const proj = project("strict");
    recordReadyReview(proj);
    expect(run(STATE_TOOL, ["gate-start", STAGE], proj).status).toBe(0);
    editReviewedArtifact(proj);
    const state = readFileSync(seededStateFile(proj), "utf-8");
    const receipts = freshReviewReceipts(proj, state, stage());
    expect(receipts.stageVerdict).toBeNull();
    expect(receipts.stageStale).toBe(true);
    expect(receipts.acceptedChanges).toEqual([]);
    const refused = run(STATE_TOOL, ["approve", STAGE], proj);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(`output document changed after ${REVIEWER} reviewed it`);
    expect(acceptedRows(proj)).toHaveLength(0);
  });

  test("the review-freeze hook still refuses the write in its window under relaxed", () => {
    const proj = project("relaxed");
    recordReadyReview(proj);
    expect(run(STATE_TOOL, ["gate-start", STAGE], proj).status).toBe(0);
    const blocked = runHook(FREEZE_HOOK, proj, {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: artifact(proj) },
    });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("review-freeze");
    // A write that got past the hook is accepted; the freeze stays on afterwards too.
    editReviewedArtifact(proj);
    expect(
      runHook(FREEZE_HOOK, proj, {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: artifact(proj) },
      }).code,
    ).toBe(2);
    const strictProject = project("strict");
    recordReadyReview(strictProject);
    expect(run(STATE_TOOL, ["gate-start", STAGE], strictProject).status).toBe(0);
    const strictBlocked = runHook(FREEZE_HOOK, strictProject, {
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: artifact(strictProject) },
    });
    expect(strictBlocked.code).toBe(2);
    expect(strictBlocked.stderr.replaceAll(strictProject, proj)).toBe(blocked.stderr);
  });
});

describe("t335 (2) summary confirmation: relaxed continues with a row", () => {
  function questionsBody(answer: string): string {
    return [
      "# Requirements Questions",
      "",
      "## Q1",
      "",
      "- Keep the login flow.",
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

  const SUMMARY_ENV = {
    ...TEST_ENV,
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "0",
    AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
  };

  /** Present and confirm the summary through the shipped log command. */
  function confirm(proj: string, questions: string): void {
    writeFileSync(questions, questionsBody(""));
    const decision = run(
      LOG_TOOL,
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
      {},
    );
    expect(decision.status, decision.stderr).toBe(0);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    writeFileSync(questions, questionsBody("Looks correct"));
    const answered = run(
      LOG_TOOL,
      [
        "answer",
        "--stage",
        STAGE,
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--details",
        "Looks correct",
      ],
      proj,
      {},
    );
    expect(answered.status, answered.stderr).toBe(0);
  }

  function evidence(proj: string) {
    const prior = process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
    delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
    try {
      return checkSummaryConfirmationEvidence(proj, stage(), {
        stateContent: readFileSync(seededStateFile(proj), "utf-8"),
      });
    } finally {
      if (prior !== undefined) process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = prior;
    }
  }

  test("an output saved before the confirmation is accepted once and the gate opens", () => {
    const proj = project("relaxed");
    const questions = join(stageDir(proj), `${STAGE}-questions.md`);
    writeFileSync(artifact(proj), "# Requirements\n");
    recordArtifactWriteViaHook(proj, artifact(proj), "Write");
    confirm(proj, questions);

    const checked = evidence(proj);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.acceptedChanges).toHaveLength(1);
    expect(checked.acceptedChanges?.[0]).toMatchObject({
      checkpoint: "summary-confirmation",
      stage: STAGE,
      unit: null,
      changed: [artifactRelative(proj)],
      notice: `${artifactRelative(proj)} was saved without the current summary confirmation. Continuing (Change Control: relaxed).`,
    });
    expect(acceptedRows(proj)).toHaveLength(0);

    const gate = run(STATE_TOOL, ["gate-start", STAGE], proj, SUMMARY_ENV);
    expect(gate.status, gate.stderr).toBe(0);
    expect(printedNotices(gate.stdout)).toEqual([
      `${artifactRelative(proj)} was saved without the current summary confirmation. Continuing (Change Control: relaxed).`,
    ]);
    const rows = acceptedRows(proj);
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Checkpoint")).toBe("summary-confirmation");
    expect(auditBlockField(rows[0].block, "Changed")).toBe(artifactRelative(proj));
    expect(auditBlockField(rows[0].block, "Recorded")).toMatch(/^[0-9a-f]{64}$/);
    expect(auditBlockField(rows[0].block, "Current")).toBe("unstamped");
    // Told once: revalidating the open gate writes nothing more.
    const again = run(STATE_TOOL, ["gate-start", STAGE], proj, SUMMARY_ENV);
    expect(again.status, again.stderr).toBe(0);
    expect(printedNotices(again.stdout)).toEqual([]);
    expect(acceptedRows(proj)).toHaveLength(1);
    // The confirmation and its receipt stand untouched.
    expect(
      readAuditShardEvents(proj).filter((entry) => entry.event === "SUMMARY_CONFIRMATION_RECORDED"),
    ).toHaveLength(1);
  });

  test("strict is today's refusal", () => {
    const proj = project("strict");
    const questions = join(stageDir(proj), `${STAGE}-questions.md`);
    writeFileSync(artifact(proj), "# Requirements\n");
    recordArtifactWriteViaHook(proj, artifact(proj), "Write");
    confirm(proj, questions);
    const checked = evidence(proj);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.refusal?.code).toBe("SUMMARY_ARTIFACT_UNAUTHORIZED");
    expect(checked.message).toContain("was last saved before the confirmed answers");
    const refused = run(STATE_TOOL, ["gate-start", STAGE], proj, SUMMARY_ENV);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("was last saved before the confirmed answers");
    expect(acceptedRows(proj)).toHaveLength(0);
  });
});

describe("t335 (3) never relaxed: five refusals byte-identical under both values", () => {
  function pair(build: (mode: "strict" | "relaxed") => { proj: string; out: string }) {
    const strict = build("strict");
    const relaxed = build("relaxed");
    return {
      strict: strict.out,
      relaxed: relaxed.out.replaceAll(relaxed.proj, strict.proj),
    };
  }

  test("a human gate: approving without a human turn refuses identically", () => {
    const outcome = pair((mode) => {
      const proj = project(mode);
      recordReadyReview(proj);
      expect(run(STATE_TOOL, ["gate-start", STAGE], proj).status).toBe(0);
      const refused = run(STATE_TOOL, ["approve", STAGE, "--user-input", "Approve"], proj, {
        ...TEST_ENV,
        AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
      });
      expect(refused.status).not.toBe(0);
      return { proj, out: refused.stderr };
    });
    expect(outcome.relaxed).toBe(outcome.strict);
    expect(outcome.strict).toContain("no new human reply has been received");
  });

  test("Plan Approval itself: a developer dispatch without an approval refuses identically", () => {
    const outcome = pair((mode) => {
      const proj = project(mode);
      const statePath = seededStateFile(proj);
      writeFileSync(
        statePath,
        readFileSync(statePath, "utf-8").replace(
          /^- \*\*Current Stage\*\*:.*$/m,
          "- **Current Stage**: code-generation",
        ),
      );
      const blocked = runHook(GUARD_HOOK, proj, {
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: {
          subagent_type: "aidlc-developer-agent",
          prompt: "AIDLC-STAGE: code-generation",
        },
        cwd: proj,
      });
      expect(blocked.code).toBe(2);
      return { proj, out: blocked.stderr };
    });
    expect(outcome.relaxed).toBe(outcome.strict);
    expect(outcome.strict.length).toBeGreaterThan(0);
  });

  test("the autonomous-mode plan stop: an autonomous swarm prepare without approved plans refuses identically", () => {
    const outcome = pair((mode) => {
      const proj = project(mode);
      const statePath = seededStateFile(proj);
      let state = readFileSync(statePath, "utf-8").replace(
        /^- \*\*Current Stage\*\*:.*$/m,
        "- **Current Stage**: code-generation",
      );
      state = setField(state, "Construction Autonomy Mode", "autonomous");
      if (!state.includes("**Construction Autonomy Mode**")) {
        state = state.replace(
          /^(- \*\*Revision Count\*\*:.*)$/m,
          "$1\n- **Construction Autonomy Mode**: autonomous",
        );
      }
      writeFileSync(statePath, state);
      const refused = run(
        join(TOOLS, "aidlc-swarm.ts"),
        ["prepare", "--batch", "1", "--units", "alpha"],
        proj,
      );
      expect(refused.status).not.toBe(0);
      return { proj, out: `${refused.stdout}${refused.stderr}` };
    });
    expect(outcome.relaxed).toBe(outcome.strict);
    expect(outcome.strict.length).toBeGreaterThan(0);
  });

  test("the observer barrier: a framework record write during the human's answer refuses identically", () => {
    const outcome = pair((mode) => {
      const proj = project(mode);
      recordReadyReview(proj);
      expect(run(STATE_TOOL, ["gate-start", STAGE], proj).status).toBe(0);
      const blocked = runHook(FREEZE_HOOK, proj, {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(stageDir(proj), ".aidlc-reviews", "forged.json") },
      });
      const write = runHook(FREEZE_HOOK, proj, {
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: artifact(proj) },
      });
      expect(write.code).toBe(2);
      return { proj, out: `${blocked.code}\n${blocked.stderr}\n${write.code}\n${write.stderr}` };
    });
    expect(outcome.relaxed).toBe(outcome.strict);
  });

  test("the review-freeze refusal during a review in progress refuses identically", () => {
    const outcome = pair((mode) => {
      const proj = project(mode);
      const dir = stageDir(proj);
      for (const name of ["requirements.md", `${STAGE}-questions.md`]) {
        writeFileSync(join(dir, name), `# ${name}\n`);
      }
      const requested = run(
        LOG_TOOL,
        ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"],
        proj,
      );
      expect(requested.status, requested.stderr).toBe(0);
      const inProgress = runHook(FREEZE_HOOK, proj, {
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: artifact(proj) },
      });
      return { proj, out: `${inProgress.code}\n${inProgress.stderr}` };
    });
    expect(outcome.relaxed).toBe(outcome.strict);
  });
});
