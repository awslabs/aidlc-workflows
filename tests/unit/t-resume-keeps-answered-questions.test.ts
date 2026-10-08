// covers: subcommand:aidlc-orchestrate:next
//
// #1873: "/aidlc --resume" in a new session sent a stage whose questions were
// already answered (and their summary confirmed) the same step as a fresh
// start, so the agent created the questions file again over the person's
// answers and asked them again. The step now names the answered file, so the
// agent keeps it and carries on from where the answers stop, under every
// Guard Policy, for `next --resume` and a bare `next` alike. A file whose
// questions are all still open is kept the same way: a live run resumed a stage
// with two unanswered questions in a new chat and got five different ones,
// because the step read as a fresh start. Only no file at all is a fresh start.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, FIXTURES_DIR, REPO_ROOT, runOrchestrateNext,
  seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const QUESTIONS = "requirements-analysis-questions.md";

// A bugfix at Requirements Analysis, its questions file as the case needs.
function project(policy: "off" | "strict", questions: string | null): string {
  const proj = createOrchestrationTestProject();
  created.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8")
    .replace("- **Change Control**: strict (from scope bugfix)",
      policy === "off" ? "- **Guard Policy**: off (from scope bugfix)" : "- **Guard Policy**: strict (set by you)");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  if (questions !== null) {
    const dir = join(seededRecordDir(proj), "inception", "requirements-analysis");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, QUESTIONS), questions, "utf-8");
  }
  return proj;
}

const answered = [
  "# Requirements Analysis Questions",
  "",
  "## Question 1",
  "Where does the blank title come from?",
  "",
  "A) The form",
  "B) The API",
  "X) Other (please specify)",
  "",
  "[Answer]: A",
  "",
  "## Question 2",
  "Should a title of only spaces count as blank?",
  "",
  "A) Yes",
  "B) No",
  "X) Other (please specify)",
  "",
  "[Answer]: A",
  "",
  "## Consolidated Summary Confirmation",
  "",
  "Blank and space-only titles from the form are refused.",
  "",
  "[Answer]: Looks correct",
  "",
].join("\n");

const blank = answered.replace(/^\[Answer\]:.*$/gm, "[Answer]:");

function step(proj: string, args: string[]) {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), proj, args);
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as { kind: string; stage?: string; questions_answered?: { path: string } };
}

describe("t-resume-keeps-answered-questions: a stage whose questions are answered is not started again", () => {
  for (const policy of ["off", "strict"] as const) {
    for (const args of [["--resume"], []]) {
      test(`next ${args.join(" ") || "(bare)"} names the answered questions file (Guard Policy ${policy})`, () => {
        const proj = project(policy, answered);
        const directive = step(proj, args);
        expect(directive.kind, JSON.stringify(directive)).toBe("run-stage");
        expect(directive.stage).toBe("requirements-analysis");
        expect(directive.questions_answered?.path)
          .toEndWith(`inception/requirements-analysis/${QUESTIONS}`);
        // The file is left exactly as the person answered it.
        expect(readFileSync(join(seededRecordDir(proj), "inception", "requirements-analysis", QUESTIONS), "utf-8"))
          .toBe(answered);
      });
    }

    test(`a questions file with no answers yet is kept too, so its open questions are asked as written (Guard Policy ${policy})`, () => {
      for (const args of [["--resume"], []]) {
        const proj = project(policy, blank);
        const directive = step(proj, args);
        expect(directive.kind, JSON.stringify(directive)).toBe("run-stage");
        expect(directive.questions_answered?.path)
          .toEndWith(`inception/requirements-analysis/${QUESTIONS}`);
        expect(readFileSync(join(seededRecordDir(proj), "inception", "requirements-analysis", QUESTIONS), "utf-8"))
          .toBe(blank);
      }
    });

    test(`no questions file at all is a fresh start (Guard Policy ${policy})`, () => {
      const directive = step(project(policy, null), ["--resume"]);
      expect(directive.kind, JSON.stringify(directive)).toBe("run-stage");
      expect(directive.questions_answered).toBeUndefined();
    });
  }

  // The step the agent reads says what the file holds: the stage's questions,
  // answered or not. It never says the person's answers alone, which read as
  // "nothing kept" for a file whose questions are all still open.
  test("the protocol tells the agent the file holds the questions, with any answers so far", () => {
    const protocol = readFileSync(
      join(REPO_ROOT, "core", "aidlc-common", "protocols", "stage-protocol.md"), "utf-8",
    );
    expect(protocol).toContain(
      "`questions_answered`, the file it names already holds the stage's questions,\nwith any answers the person gave so far:",
    );
    expect(protocol).not.toContain("already holds the person's answers");
    const reference = readFileSync(join(REPO_ROOT, "docs", "reference", "04-stage-protocol.md"), "utf-8");
    expect(reference).toContain("already exists with its questions");
    expect(reference).not.toContain("already holds an answer of the person's");
  });
});
