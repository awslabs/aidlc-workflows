import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
  seededAuditDir,
  seededRecordDir,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..", "..");
const ORCHESTRATE = join(ROOT, "core", "tools", "aidlc-orchestrate.ts");
const projects: string[] = [];
const homes: string[] = [];

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function fixture(enabled = true): { project: string; home: string; env: NodeJS.ProcessEnv; stageDir: string } {
  const project = createTestProject();
  const home = mkdtempSync(join(tmpdir(), "aidlc-t334-"));
  projects.push(project);
  homes.push(home);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
  const stageDir = join(seededRecordDir(project), "ideation", "feasibility");
  mkdirSync(stageDir, { recursive: true });
  for (const name of ["feasibility-assessment.md", "constraint-register.md", "raid-log.md", "feasibility-questions.md"]) {
    writeFileSync(join(stageDir, name), `# ${name}\n`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_REVIEW_HOME: home,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  };
  if (enabled) env.AIDLC_REVIEW_UI = "1";
  else delete env.AIDLC_REVIEW_UI;
  return { project, home, env, stageDir };
}

function run(project: string, env: NodeJS.ProcessEnv, args: string[]): Record<string, unknown> {
  const result = Bun.spawnSync({
    cmd: [BUN, ORCHESTRATE, "report", ...args, "--project-dir", project],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout).trim());
}

function audit(project: string): string {
  if (!existsSync(seededAuditDir(project))) return "";
  return Array.from(new Bun.Glob("*.md").scanSync(seededAuditDir(project)))
    .map((file) => readFileSync(join(seededAuditDir(project), file), "utf-8"))
    .join("\n");
}

function feedback(stageDir: string, file: string, body: string): void {
  const dir = join(stageDir, ".review-ui");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), [
    "---",
    "aidlc_review_feedback: 1",
    "stage: feasibility",
    "unit: null",
    "revision: 0",
    "created: 2026-09-03T10:00:00Z",
    "decision_hint: request-changes",
    "---",
    body,
  ].join("\n"));
}

describe("review UI report feedback ingestion", () => {
  test("rejected feedback extends the gate reason, audits after rejection, and is consumed once", () => {
    const { project, env, stageDir } = fixture();
    run(project, env, ["--stage", "feasibility", "--result", "awaiting-approval"]);
    feedback(stageDir, "feedback-001.md", "first browser body\n");
    feedback(stageDir, "feedback-002.md", "second browser body\n");

    run(project, env, ["--result", "rejected", "--reason", "typed"]);
    const log = audit(project);
    const rejected = log.indexOf("**Event**: GATE_REJECTED");
    const review = log.indexOf("**Event**: REVIEW_UI_FEEDBACK");
    expect(rejected).toBeGreaterThanOrEqual(0);
    expect(review).toBeGreaterThan(rejected);
    expect(log).toContain("typed");
    expect(log).toContain("## Browser review feedback");
    expect(log).toContain("first browser body");
    expect(log).toContain("second browser body");
    expect(log).toContain("**Files**: feedback-001.md, feedback-002.md");
    const consumed = JSON.parse(readFileSync(join(stageDir, ".review-ui", "consumed.json"), "utf-8"));
    expect(consumed.entries).toHaveLength(2);

    run(project, env, ["--result", "revised"]);
    expect(audit(project).match(/\*\*Event\*\*: REVIEW_UI_FEEDBACK/g)).toHaveLength(1);
  }, 30_000);

  test("approved feedback is audited, consumed, and returned as approval_notes", () => {
    const { project, env, stageDir } = fixture();
    run(project, env, ["--stage", "feasibility", "--result", "awaiting-approval"]);
    feedback(stageDir, "feedback-001.md", "approved browser note\n");
    const output = run(project, env, ["--result", "approved", "--user-input", "Approve"]);
    expect(output.approval_notes).toContain("approved browser note");
    expect(audit(project)).toContain("**Result**: approved");
    const consumed = JSON.parse(readFileSync(join(stageDir, ".review-ui", "consumed.json"), "utf-8"));
    expect(consumed.entries).toHaveLength(1);
  }, 30_000);

  test("disabled flag ignores pending files and writes no review UI state", () => {
    const { project, env, stageDir } = fixture(false);
    feedback(stageDir, "feedback-001.md", "ignored browser body\n");
    run(project, env, ["--stage", "feasibility", "--result", "awaiting-approval"]);
    run(project, env, ["--result", "rejected", "--reason", "typed"]);
    expect(audit(project)).not.toContain("REVIEW_UI_FEEDBACK");
    expect(existsSync(join(stageDir, ".review-ui", "manifest.json"))).toBe(false);
    expect(existsSync(join(stageDir, ".review-ui", "consumed.json"))).toBe(false);
  }, 30_000);
});
