// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next
//
// A stage approval used to arrive with nothing above it ("Reverse Engineering
// complete. How would you like to proceed?"), and "What did you find?" typed at
// the gate got the same bare question back. The engine's gate line now names
// what the stage produced, from the files on disk (a questions file with how
// many questions and how many answered), so the person sees it even when the
// agent skipped its summary; and the step for words typed at the gate tells the
// agent to answer a question about the output first, then ask again.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, runOrchestrateNext, seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STAGE = "requirements-analysis";
const QUESTIONS = `${STAGE}-questions.md`;

function question(n: number, answer: string): string {
  return `## Q${n}: Question ${n}?\n\nA) One\nB) Two\nX) Other (please specify)\n\n[Answer]: ${answer}\n\n`;
}

// A bugfix at Requirements Analysis with the stage's own files written.
function project(files: Record<string, string>): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  writeFileSync(seededStateFile(proj), readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8"), "utf-8");
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf-8");
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
  return proj;
}

function report(proj: string, args: string[]) {
  const result = spawnSync(process.execPath, [ORCH, "report", "--stage", STAGE, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
    env: { ...process.env, AIDLC_SKIP_REVIEWER_GATE_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" },
  });
  const line = (result.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? "";
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(line) as { kind: string; narration?: string; message?: string };
}

function next(proj: string, args: string[] = []) {
  const result = runOrchestrateNext(ORCH, proj, args, {
    env: { ...process.env, AIDLC_SKIP_REVIEWER_GATE_GUARD: "1", AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1" },
  });
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as { kind: string; gate_only?: boolean; narration?: string; message?: string };
}

const FOLDER = /, in aidlc\/spaces\/default\/intents\/[^/]+\/inception\/requirements-analysis\/\.$/;

describe("t-gate-names-what-it-produced: the gate line names what the stage produced", () => {
  test("the awaiting-approval reply lists the files, with the questions file's count", () => {
    const proj = project({
      "requirements.md": "# Requirements\n\n## FR-1\nList notes.\n",
      [QUESTIONS]: `# Questions\n\n${question(1, "A")}${question(2, "B")}${question(3, "")}`,
    });
    const reply = report(proj, ["--result", "awaiting-approval"]);
    expect(reply.kind).toBe("print");
    expect(reply.narration).toStartWith(
      "Requirements Analysis is ready for your review. It produced requirements.md and " +
        "requirements-analysis-questions.md (3 questions, 2 answered), in ",
    );
    expect(reply.narration).toMatch(FOLDER);
  });

  test("every question answered reads as all answered, and a file the stage did not write is left out", () => {
    const proj = project({ [QUESTIONS]: `# Questions\n\n${question(1, "A")}${question(2, "B")}` });
    const reply = report(proj, ["--result", "awaiting-approval"]);
    expect(reply.narration).toStartWith(
      "Requirements Analysis is ready for your review. It produced requirements-analysis-questions.md " +
        "(2 questions, all answered), in ",
    );
  });

  test("with none of its files on disk the line still says where they would be", () => {
    const proj = project({});
    const reply = report(proj, ["--result", "awaiting-approval"]);
    expect(reply.narration).toStartWith("Requirements Analysis is ready for your review. Its output goes in ");
    expect(reply.narration).toMatch(/inception\/requirements-analysis\/\.$/);
  });

  test("a second next at the open gate says the same line, and words at the gate get an answer-first step", () => {
    const proj = project({
      "requirements.md": "# Requirements\n",
      [QUESTIONS]: `# Questions\n\n${question(1, "A")}`,
    });
    report(proj, ["--result", "awaiting-approval"]);
    const again = next(proj);
    expect(again.kind, JSON.stringify(again)).toBe("run-stage");
    expect(again.gate_only).toBe(true);
    expect(again.narration).toStartWith(
      "Requirements Analysis is ready for your review. It produced requirements.md and " +
        "requirements-analysis-questions.md (1 question, all answered), in ",
    );
    const words = next(proj, ["What did you find? I haven't seen a summary yet."]);
    expect(words.kind).toBe("print");
    expect(words.message).toContain(
      "If it asks about what the stage found or produced, answer it from the files in ",
    );
    expect(words.message).toContain("then ask the approval question again");
    // The answer-first branch comes before the new-work branch, which is the
    // one the agent used to take for a question about the output.
    expect(words.message!.indexOf("answer it from the files")).toBeLessThan(words.message!.indexOf("something else"));
  });
});
