// covers: function:previewPolicyProblem, subcommand:aidlc-log:review
//
// The Refined Mockups preview is an optional output, opened in a browser: when
// it is written, the review request, where the engine first binds the stage's
// outputs, refuses one whose head does not open with the policy tag, laid out
// however a formatter leaves it. Work with no preview is reviewed as before.
//
// Mechanism: function - the shipped hooks and `log decision|answer|review` on a
// seeded project, as a run calls them; no agent runs.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PREVIEW_POLICY_TAG } from "../../dist/claude/.claude/tools/aidlc-artifact-resolution.ts";
import { auditBlockField, readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, seededRecordDir, seededStateFile, setupIntegrationProject } from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const STAGE = "refined-mockups";
const REVIEWER = "aidlc-product-lead-agent";
const SESSION = "t-mockups-preview-policy-at-review";

const projects: string[] = [];
afterEach(() => {
  for (const proj of projects.splice(0)) cleanupTestProject(proj);
});

// The tools as a person's run calls them: the guards this path meets are on.
function env(proj: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_REVIEWER_GATE_GUARD: "0", AIDLC_SKIP_ARTIFACT_GUARD: "0",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "0", AIDLC_SESSION_OVERRIDE: SESSION, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
  for (const key of ["AIDLC_SKIP_HUMAN_PRESENCE_GUARD", "AIDLC_UNATTENDED", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_PID",
    "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "AIDLC_STAGE_GRAPH"]) delete e[key];
  return e;
}

// Refined Mockups in progress on a feature run, its answers confirmed and its
// Markdown outputs written, ready for its review request.
async function readyForReview() {
  const proj = setupIntegrationProject({ withState: "state-brownfield-feature.md", stripEnvScope: true });
  projects.push(proj);
  const state = seededStateFile(proj);
  writeFileSync(state, readFileSync(state, "utf-8")
    .replace("- [-] requirements-analysis", "- [x] requirements-analysis")
    .replace("- [ ] user-stories", "- [x] user-stories")
    .replace("- [ ] refined-mockups", "- [-] refined-mockups")
    .replace("**Current Stage**: requirements-analysis", "**Current Stage**: refined-mockups")
    .replace("**In Progress**: requirements-analysis", "**In Progress**: refined-mockups"));
  const engine = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [join(proj, ".claude", "tools", "aidlc.ts"), ...args], {
      cwd: proj, input, encoding: "utf-8", env: env(proj),
    });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const ok = (args: string[]) => {
    const r = engine(args);
    expect(r.status, r.out).toBe(0);
  };
  const say = async (prompt: string) => {
    const r = engine(["engine", "hook", "record-human-turn"],
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }));
    expect(r.status, r.out).toBe(0);
    await Bun.sleep(1100);
    expect(readAuditShardEvents(proj).filter((row) => row.event === "HUMAN_TURN").length).toBeGreaterThan(0);
  };
  // The agent's file tool, with the write hook a host fires after it.
  const put = (abs: string, content: string) => {
    const existed = existsSync(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    const r = engine(["engine", "hook", "write-audit-log"], JSON.stringify({
      session_id: SESSION, cwd: proj, hook_event_name: "PostToolUse", tool_name: "Write",
      tool_input: { file_path: abs, content }, tool_response: { type: existed ? "update" : "create", filePath: abs },
    }));
    expect(r.status, r.out).toBe(0);
  };

  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, "refined-mockups-questions.md");
  const questionText = (answer: string, summary?: string) =>
    `# refined-mockups questions\n\n## Question 1\n\nWhich layout fits?\n\nA. One page\nB. A wizard\nX. Other (please specify)\n\n[Answer]: ${answer}\n` +
    (summary === undefined ? "" : "\n## Consolidated Summary Confirmation\n\nDoes this all look correct before I generate the artifact?\n\n" +
      `- Looks correct\n- Request changes\n\n[Answer]: ${summary}\n`);
  writeFileSync(questions, questionText(""));
  ok(["engine", "log", "decision", "--stage", STAGE, "--decision", "Question 1", "--options", "A,B,X"]);
  await say("A");
  writeFileSync(questions, questionText("A"));
  ok(["engine", "log", "answer", "--stage", STAGE, "--details", "A"]);
  writeFileSync(questions, questionText("A", ""));
  const summary = "Does this all look correct before I generate the artifact?";
  ok(["engine", "log", "decision", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", questions,
    "--decision", summary, "--options", "Looks correct,Request changes"]);
  await say("Looks correct");
  writeFileSync(questions, questionText("A", "Looks correct"));
  ok(["engine", "log", "answer", "--stage", STAGE, "--checkpoint", "summary-confirmation", "--questions-file", questions,
    "--details", "Looks correct"]);
  for (const name of ["mockups.md", "interaction-spec.md", "design-system-mapping.md", "accessibility-checklist.md"]) {
    put(join(dir, name), `# ${name}\n\n- UX1.1.1 Sign in on one page [Q1]\n`);
  }
  const requestReview = () =>
    engine(["engine", "log", "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"]);
  const requests = () => readAuditShardEvents(proj).filter((row) =>
    row.event === "REVIEW_REQUESTED" && auditBlockField(row.block, "Stage") === STAGE).length;
  return { dir, put, requestReview, requests };
}

// The tag as Prettier's defaults leave it: the charset closed with `/>`, the
// policy tag over four lines.
const FORMATTED = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    />
    <title>Sign in</title>
  </head>
  <body>UX1.1.1</body>
</html>
`;

describe("t-mockups-preview-policy-at-review", () => {
  test("a preview with no policy tag, a script first in its head, is refused at the review request", async () => {
    const { dir, put, requestReview, requests } = await readyForReview();
    put(join(dir, "mockups-preview.html"),
      `<!doctype html><html><head><title>Sign in</title><script src="https://example.com/x.js"></script></head><body>UX1.1.1</body></html>\n`);
    const refused = requestReview();
    expect(refused.status, refused.out).not.toBe(0);
    const said = String((JSON.parse(refused.out.trim().split("\n").at(-1) ?? "{}") as { error?: string }).error);
    expect(said).toContain("mockups-preview.html must open its <head> with");
    expect(said).toContain(PREVIEW_POLICY_TAG);
    expect(said, "the refusal names the review to run again").toMatch(/run `[^`]*review --stage refined-mockups[^`]*`/);
    expect(requests(), "nothing is bound for review").toBe(0);

    put(join(dir, "mockups-preview.html"), FORMATTED);
    const accepted = requestReview();
    expect(accepted.status, accepted.out).toBe(0);
    expect(requests()).toBe(1);
  });

  test("work with no preview (API-only) is reviewed as before", async () => {
    const { requestReview, requests } = await readyForReview();
    const accepted = requestReview();
    expect(accepted.status, accepted.out).toBe(0);
    expect(requests()).toBe(1);
  });
});
