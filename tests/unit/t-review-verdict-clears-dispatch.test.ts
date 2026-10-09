// covers: function:handleReview, function:reviewerDispatchPath
//
// The per-unit reviewer dispatch record (`<record>/.aidlc-engine/reviewer-dispatch.json`)
// opens the reviewer-scope enforcement window. The window closes with the review,
// so the engine removes the record when it records the verdict; the protocol has
// no delete step, and no `rm` (a permission card on Claude Code and Kiro CLI) is
// ever asked of the agent. An attempt with no verdict leaves the record for the
// retry; the scope hook's 6 h TTL covers a crashed review as before.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const TOOLS = join(import.meta.dir, "..", "..", "dist", "claude", ".claude", "tools");
const UTIL = join(TOOLS, "aidlc-utility.ts");
const STATE = join(TOOLS, "aidlc-state.ts");
const LOG = join(TOOLS, "aidlc-log.ts");
const REVIEWER = "aidlc-product-lead-agent";

const projects: string[] = [];
afterAll(() => {
  for (const p of projects) cleanupTestProject(p);
});

function run(tool: string, args: string[], p: string, env: Record<string, string> = {}): { status: number; out: string } {
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
  delete childEnv.AWS_AIDLC_DEFAULT_SCOPE;
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: { ...childEnv, AIDLC_UNATTENDED: "1", ...env },
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** A bugfix workflow at Requirements Analysis with both required documents written and a review requested. */
function projectWithRequestedReview(): { p: string; stage: string; record: string; artifact: string; dispatch: string } {
  const p = createTestProject();
  projects.push(p);
  expect(run(UTIL, ["intent-create", "--scope", "bugfix"], p).status).toBe(0);
  for (const s of ["workspace-scaffold", "workspace-detection", "state-init"]) {
    expect(run(STATE, ["advance", s], p, { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" }).status).toBe(0);
  }
  const stage = run(STATE, ["get", "Current Stage"], p, { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" }).out.trim();
  expect(stage).toBe("requirements-analysis");
  const intents = join(p, "aidlc", "spaces", "default", "intents");
  const record = join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
  const dir = join(record, "inception", stage);
  mkdirSync(dir, { recursive: true });
  const artifact = join(dir, "requirements.md");
  writeFileSync(artifact, "# Requirements\n");
  writeFileSync(join(dir, "requirements-analysis-questions.md"), "# Questions\n");
  const request = run(LOG, ["review", "--stage", stage, "--reviewer", REVIEWER, "--iteration", "1"], p);
  expect(request.out, request.out).toContain('"emitted":"REVIEW_REQUESTED"');
  // The conductor writes the dispatch record before invoking the reviewer (protocol step 1).
  const dispatch = join(record, ".aidlc-engine", "reviewer-dispatch.json");
  mkdirSync(join(record, ".aidlc-engine"), { recursive: true });
  writeFileSync(dispatch, JSON.stringify({ reviewer: REVIEWER, stage, unit: "u1", exempt: [] }));
  return { p, stage, record, artifact, dispatch };
}

describe("the review verdict closes the reviewer-scope window itself", () => {
  test("recording the verdict removes reviewer-dispatch.json", () => {
    const { p, stage, artifact, dispatch } = projectWithRequestedReview();
    appendFileSync(
      artifact,
      `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`,
    );
    const verdict = run(LOG, ["review", "--stage", stage, "--reviewer", REVIEWER, "--iteration", "1", "--verdict", "READY"], p);
    expect(verdict.out, verdict.out).toContain('"emitted":"REVIEW_COMPLETED"');
    expect(existsSync(dispatch)).toBe(false);
  });

  test("an attempt with no verdict keeps the record for the retry", () => {
    const { p, stage, dispatch } = projectWithRequestedReview();
    // No review section was written: the verdict is refused and nothing is recorded.
    const verdict = run(LOG, ["review", "--stage", stage, "--reviewer", REVIEWER, "--iteration", "1", "--verdict", "READY"], p);
    expect(verdict.out).not.toContain('"emitted":"REVIEW_COMPLETED"');
    expect(existsSync(dispatch)).toBe(true);
  });

  test("the protocol no longer tells the agent to delete the record", () => {
    const protocol = readFileSync(
      join(import.meta.dir, "..", "..", "core", "aidlc-common", "protocols", "stage-protocol-reviewer.md"),
      "utf-8",
    );
    expect(protocol).not.toMatch(/delete `<record>\/\.aidlc-engine\/reviewer-dispatch\.json`/);
  });
});
