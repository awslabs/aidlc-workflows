import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../core/tools/aidlc-audit.ts";
import {
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedStateFile,
  seededRecordDir,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(ROOT, "core", "tools", "aidlc-log.ts");
const projects: string[] = [];

const QUESTIONS = `# Feasibility questions

## Q1. Runtime

Which runtime?

A. Bun
B. Node
X. Other (please specify)

[Answer]:

## Q2. Features (select all that apply)

Choose features.

A. Audit
B. Cache
C. Metrics
X. Other (please specify)

[Answer]:

## Q3. Deployment

Where should this run?

A. Cloud
X. Other (please specify)

[Answer]:

## Consolidated Summary Confirmation

- Looks correct
- Request changes

[Answer]:
`;

afterAll(() => {
  for (const project of projects) cleanupTestProject(project);
});

function fixture(): { project: string; stageDir: string; questions: string; rel: string } {
  const project = createTestProject();
  projects.push(project);
  seedStateFile(project, join(FIXTURES_DIR, "state-mid-ideation.md"));
  const stageDir = join(seededRecordDir(project), "ideation", "feasibility");
  mkdirSync(join(stageDir, ".review-ui"), { recursive: true });
  const questions = join(stageDir, "feasibility-questions.md");
  writeFileSync(questions, QUESTIONS);
  return {
    project,
    stageDir,
    questions,
    rel: relative(project, questions).replaceAll("\\", "/"),
  };
}

function submission(
  stageDir: string,
  file: string,
  questionsFile: string,
  source: string,
  answers: unknown[],
): void {
  writeFileSync(join(stageDir, ".review-ui", file), `${JSON.stringify({
    version: 1,
    questions_file: questionsFile,
    source_sha256: createHash("sha256").update(source).digest("hex"),
    created: "2026-09-03T10:00:00Z",
    answers,
  }, null, 2)}\n`);
}

function run(
  project: string,
  questions: string,
  options: { presenceGuard?: boolean } = {},
): { status: number; stdout: string; output: string } {
  // The suite runner exports AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1; the refusal case
  // must see the real guard, exactly like t188's `guarded()` helper.
  const env = { ...process.env };
  if (options.presenceGuard) delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const result = Bun.spawnSync({
    cmd: [
      BUN,
      TOOL,
      "answers-apply",
      "--stage",
      "feasibility",
      "--questions-file",
      questions,
      "--project-dir",
      project,
    ],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  return {
    status: result.exitCode,
    stdout,
    output: `${stdout}${new TextDecoder().decode(result.stderr)}`,
  };
}

function audit(project: string): string {
  const dir = join(seededRecordDir(project), "audit");
  return Array.from(new Bun.Glob("*.md").scanSync(dir))
    .map((file) => readFileSync(join(dir, file), "utf-8"))
    .join("\n");
}

describe("aidlc-log answers-apply", () => {
  test("applies letters, Other, and notes once under one browser audit receipt", () => {
    const { project, stageDir, questions, rel } = fixture();
    submission(stageDir, "answers-001.json", rel, QUESTIONS, [
      { id: "Q1", labels: ["A"] },
      { id: "Q2", labels: ["A"] },
    ]);
    submission(stageDir, "answers-002.json", rel, QUESTIONS, [
      { id: "Q2", labels: ["A", "C"], note: "Metrics can follow the first release." },
      { id: "Q3", labels: ["X"], other: "On-prem appliance" },
    ]);
    appendAuditEntry("DECISION_RECORDED", { Stage: "feasibility", Decision: "Question mode" }, project);
    appendAuditEntry("HUMAN_TURN", {}, project);

    const result = run(project, questions);
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      applied: 3,
      files: ["answers-001.json", "answers-002.json"],
      questions_file: rel,
    });
    const body = readFileSync(questions, "utf-8");
    expect(body).toContain("[Answer]: A");
    expect(body).toContain("[Answer]: A, C\n[Note]: Metrics can follow the first release.");
    expect(body).toContain("[Answer]: X — On-prem appliance");
    expect(body).toContain("## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]:");

    const log = audit(project);
    expect(log.match(/\*\*Event\*\*: QUESTION_ANSWERED/g)).toHaveLength(1);
    expect(log).toContain("**Mode**: browser");
    expect(log).toContain("**Answers**: 3");
    expect(log).toContain("**Submissions**: answers-001.json, answers-002.json");
    expect(log).toContain(`**Digest**: ${createHash("sha256").update(body).digest("hex")}`);
    const consumed = JSON.parse(readFileSync(join(stageDir, ".review-ui", "consumed.json"), "utf-8"));
    expect(consumed.entries.map((entry: { result: string }) => entry.result)).toEqual([
      "answers-applied",
      "answers-applied",
    ]);

    const second = run(project, questions);
    expect(second.status, second.output).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ applied: 0, files: [], questions_file: rel });
    expect(audit(project).match(/\*\*Event\*\*: QUESTION_ANSWERED/g)).toHaveLength(1);
  });

  test("refuses every pending submission when any source digest is stale", () => {
    const { project, stageDir, questions, rel } = fixture();
    submission(stageDir, "answers-001.json", rel, "older questions", [
      { id: "Q1", labels: ["A"] },
    ]);
    submission(stageDir, "answers-002.json", rel, QUESTIONS, [
      { id: "Q2", labels: ["B"] },
    ]);
    appendAuditEntry("HUMAN_TURN", {}, project);

    const result = run(project, questions);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "answers-apply refused: answers-001.json was recorded against an older questions file; ask the human to reload and save again.",
    );
    expect(readFileSync(questions, "utf-8")).toBe(QUESTIONS);
    expect(() => readFileSync(join(stageDir, ".review-ui", "consumed.json"), "utf-8")).toThrow();
  });

  test("refuses without a fresh HUMAN_TURN and leaves the file untouched", () => {
    const { project, stageDir, questions, rel } = fixture();
    submission(stageDir, "answers-001.json", rel, QUESTIONS, [
      { id: "Q1", labels: ["B"] },
    ]);
    appendAuditEntry("DECISION_RECORDED", { Stage: "feasibility", Decision: "Question mode" }, project);

    const result = run(project, questions, { presenceGuard: true });
    expect(result.status).toBe(1);
    expect(result.output).toContain("no new human reply has arrived");
    expect(readFileSync(questions, "utf-8")).toBe(QUESTIONS);
    expect(() => readFileSync(join(stageDir, ".review-ui", "consumed.json"), "utf-8")).toThrow();
  });
});
