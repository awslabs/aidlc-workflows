// covers: function:checkSummaryConfirmationEvidence, function:hookLiveness, function:hooksOffAgentStep, function:hooksNeverRanHere, subcommand:aidlc-log:review

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hooksHealthDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  REPO_ROOT,
  cleanupTestProject,
  createTestProject,
  seedAidlcMemory,
  seedStateFile,
  seededRecordDir,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const KIRO_LOG = join(REPO_ROOT, "dist", "kiro", ".kiro", "tools", "aidlc-log.ts");
const STAGE = "requirements-analysis";
const REVIEWER = "aidlc-product-lead-agent";
const ENV: NodeJS.ProcessEnv = {
  ...testGuardEnvironment(process.env, "production"),
  AIDLC_UNATTENDED: "0",
};
const SAVE_AGAIN = "Save each of them again, so each write descends from the current confirmation, then continue.";
const SAVE_ONE_AGAIN = "Save the document again, so its write descends from the current confirmation, then continue.";
// The hooks-off step Kiro CLI ships (harness/kiro/manifest.ts, hookActivation.agentStep), as the presence refusal gives it.
const HOOKS_OFF_RULES = "Do not run AI-DLC's hook scripts yourself";
const KIRO_STEP = "Kiro is not running this project's aidlc agent in this session.";
const KIRO_WAY = "Type /agent and pick aidlc, then carry on.";

const dirs: string[] = [];
afterAll(() => {
  while (dirs.length > 0) cleanupTestProject(dirs.pop()!);
});

interface Work {
  proj: string;
  questions: string;
  requirements: string;
  record: string;
}

function project(): Work {
  const proj = createTestProject();
  dirs.push(proj);
  seedAidlcMemory(proj);
  seedStateFile(proj, "state-mid-inception.md");
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  return {
    proj,
    questions: join(dir, `${STAGE}-questions.md`),
    requirements: join(dir, "requirements.md"),
    record: join(dir, "traceability.json"),
  };
}

function run(path: string, args: string[], proj: string) {
  const result = spawnSync(BUN, [path, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...ENV, CLAUDE_PROJECT_DIR: proj },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const questionsBody = (answer: string) => [
  "# Requirements Questions", "", "## Q1", "", "- Keep the login flow.", "",
  "## Consolidated Summary Confirmation", "", "- Looks correct", "- Request changes", "",
  `[Answer]: ${answer}`, "",
].join("\n");

function relayedSummary(w: Work): void {
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, w.proj);
  writeFileSync(w.questions, questionsBody(""));
  const shown = run(KIRO_LOG, [
    "decision", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", w.questions,
    "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes",
  ], w.proj);
  expect(shown.status, shown.stderr).toBe(0);
  appendAuditEntry("HUMAN_TURN", { Reply: "Looks correct", "Message Id": "relay-1", Session: "relay" }, w.proj);
  writeFileSync(w.questions, questionsBody("Looks correct"));
  const answered = run(KIRO_LOG, [
    "answer", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", w.questions,
    "--details", "Looks correct",
  ], w.proj);
  expect(answered.status, answered.stderr).toBe(0);
}

function savedWithoutAWrite(w: Work): void {
  writeFileSync(w.requirements, "# Requirements\n\n- FR1 Keep the login flow.\n");
  writeFileSync(w.record, `${JSON.stringify({ stage: STAGE, ids: [{ id: "FR1", kind: "functional" }] }, null, 2)}\n`);
}

function requestReview(w: Work) {
  const result = run(KIRO_LOG, ["review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"], w.proj);
  expect(result.status, result.stderr).not.toBe(0);
  const parsed: unknown = JSON.parse(result.stderr.trim().split("\n").at(-1) ?? "{}");
  if (parsed === null || typeof parsed !== "object" || !("error" in parsed) || typeof parsed.error !== "string") {
    throw new Error(`no refusal in: ${result.stderr}`);
  }
  return parsed.error;
}

function hooksStopped(w: Work, minutesAgo: number): void {
  rmSync(hooksHealthDir(w.proj), { recursive: true, force: true });
  mkdirSync(hooksHealthDir(w.proj), { recursive: true });
  const at = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(join(hooksHealthDir(w.proj), "record-human-turn.last"), `${at}\n`);
  writeFileSync(join(hooksHealthDir(w.proj), "audit-and-sensors.last"), `${at}\n`);
}

describe("t-relayed-session-names-no-hook-write: where no hook runs, a save the hooks cannot record gives the way back", () => {
  test("a Kiro CLI session no hook ran in names the missing write and the files, and the way back in place of a save", () => {
    const w = project();
    relayedSummary(w);
    savedWithoutAWrite(w);
    const error = requestReview(w);
    expect(error).toContain("have no recorded write");
    expect(error).toContain("requirements.md");
    expect(error).toContain("traceability.json");
    expect(error).not.toContain(SAVE_AGAIN);
    expect(error).toContain(HOOKS_OFF_RULES);
    expect(error).toContain(KIRO_STEP);
    expect(error).toContain(KIRO_WAY);
  });

  test("one output with no recorded write gets the same way back, in place of the save", () => {
    const w = project();
    relayedSummary(w);
    writeFileSync(w.requirements, "# Requirements\n\n- FR1 Keep the login flow.\n");
    const error = requestReview(w);
    expect(error).toContain("requirements.md has no recorded write");
    expect(error).not.toContain(SAVE_ONE_AGAIN);
    expect(error).toContain(KIRO_STEP);
  });

  test("while the hooks run, the refusal is the agent's save, word for word", () => {
    const w = project();
    relayedSummary(w);
    savedWithoutAWrite(w);
    mkdirSync(hooksHealthDir(w.proj), { recursive: true });
    writeFileSync(join(hooksHealthDir(w.proj), "audit-and-sensors.last"), `${new Date().toISOString()}\n`);
    const error = requestReview(w);
    expect(error).toContain(`have no recorded write. ${SAVE_AGAIN}`);
    expect(error.split("\n")[0].endsWith(SAVE_AGAIN)).toBe(true);
    expect(error).not.toContain(KIRO_STEP);
  });

  test("hooks that ran here once and stopped keep the save step, word for word", () => {
    const w = project();
    relayedSummary(w);
    savedWithoutAWrite(w);
    hooksStopped(w, 40);
    appendAuditEntry("STAGE_STARTED", { Stage: "feasibility" }, w.proj);
    const error = requestReview(w);
    expect(error).toContain(`have no recorded write. ${SAVE_AGAIN}`);
    expect(error.split("\n")[0].endsWith(SAVE_AGAIN)).toBe(true);
    expect(error).not.toContain(KIRO_STEP);
  });
});
