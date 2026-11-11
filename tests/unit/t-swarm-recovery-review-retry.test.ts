// covers: subcommand:aidlc-log:review, function:evaluateGuardRefusal, function:guardRefusalStreakView
//
// A side-by-side Unit's documents change after their review, so its next
// review is the one recovery review. The request is recorded, but its answer
// never reaches the agent, which asks for the same review again. That review
// is still waiting for its verdict and nothing changed since: the refusal says
// so, names --retry-pending, and leaves retrying it to the agent before anyone
// is asked to restart the Unit. The retry then reissues the same request.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import {
  cleanupCheckpointFixtures, fixture, prepare, reviewRevisedSource, runCheckpointTool, STAGE, wt, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const REVIEWER = "aidlc-architecture-reviewer-agent";

function requestReview(child: string, iteration: number, extra: string[] = []) {
  return runCheckpointTool(child, "tools/aidlc-log.ts", [
    "review", "--stage", STAGE, "--unit", "alpha", "--reviewer", REVIEWER,
    "--iteration", String(iteration), ...extra, "--project-dir", child,
  ]);
}

// The guard-recovery question a refusal carries on its last line.
function askOf(output: string): { agent_work?: boolean; reason_codes: string[]; remedies: Array<{ op: string }> } {
  const error = JSON.parse(output.trim().split("\n").at(-1)!) as { error: string };
  return JSON.parse(error.error.trim().split("\n").at(-1)!);
}

describe("a side-by-side Unit's recovery review whose answer was lost", () => {
  test("is retried by the agent, not called spent", () => {
    const pd = fixture(["alpha"]);
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const child = wt(pd);
    writeUnitSource(pd, "alpha", 2);
    reviewRevisedSource(pd, "alpha");
    // The fixes after the review change one of the stage's documents.
    appendFileSync(join(codeGenerationRecordDir(child, "alpha"), "code-summary.md"), "\nFixed after the review.\n");

    const recovery = requestReview(child, 2);
    expect(recovery.code, `${recovery.out}\n${recovery.err}`).toBe(0);
    expect(recovery.out).toContain('"recovery":"stale-receipt"');

    const again = requestReview(child, 2);
    const said = `${again.out}${again.err}`;
    expect(again.code, said).not.toBe(0);
    expect(said).toContain("is still waiting for a verdict");
    expect(said).toContain("--retry-pending");
    expect(said).not.toContain("changed again afterward");
    const ask = askOf(said);
    expect(ask.reason_codes).toEqual(["REVIEW_VERDICT_PENDING"]);
    expect(ask.agent_work, JSON.stringify(ask)).toBe(true);
    expect(ask.remedies.map((remedy) => remedy.op)).toContain("retry-pending");
    expect(ask.remedies.map((remedy) => remedy.op)).not.toContain("abort-bolt");

    const retried = requestReview(child, 2, ["--retry-pending"]);
    expect(retried.code, `${retried.out}\n${retried.err}`).toBe(0);
    expect(retried.out).toContain('"emitted":"REVIEW_REQUESTED"');
  });
});
