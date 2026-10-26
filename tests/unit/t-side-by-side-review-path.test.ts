// covers: subcommand:aidlc-log:review, subcommand:aidlc-testing-posture:brief, subcommand:aidlc-swarm:finalize
//
// In a side-by-side build the conductor requests a Unit's review from the
// project's main folder with --project-dir naming the Unit's worktree, and the
// reviewer it dispatches runs in that main folder too. The request hands the
// reviewer the review file's absolute path inside the worktree, so the review
// a reviewer writes from the main folder is the one the verdict reads. The
// worker's brief names its worktree and the Unit's record folder inside it the
// same way, and finalize names the manifest there. A one-at-a-time build keeps
// its project-relative paths.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { stateDigest, toPosix, writeActiveDirectiveMarker } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import {
  CHECK, cleanupCheckpointFixtures, fixture, prepare, reviewRevisedSource, runCheckpointTool, STAGE, swarm, wt,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

const REVIEWER = "aidlc-architecture-reviewer-agent";
const REVIEW =
  `## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Date:** 2026-10-16T00:00:00Z\n**Iteration:** 1\n` +
  "**Verdict Dictated:** no\n\n### Findings\n\n**Prior findings**\n\n| ID | Now | Severity | Note |\n|---|---|---|---|\n\n" +
  "**New findings**\n\n| Severity | Location | Finding | Required action |\n|---|---|---|---|\n";

// The Unit's built source and its list of files, which a Code Generation review request reads.
function built(dir: string): void {
  writeFileSync(join(dir, "src", "alpha.ts"), "export const alpha = 2;\n");
  writeFileSync(join(codeGenerationRecordDir(dir, "alpha"), "source-manifest.json"),
    JSON.stringify({ stage: STAGE, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }] }));
}

function brief(pd: string): string {
  const result = runCheckpointTool(pd, "tools/aidlc-testing-posture.ts", ["brief", "--unit", "alpha"]);
  expect(result.code, `${result.out}\n${result.err}`).toBe(0);
  return result.out;
}

// A request comes back as the agent's step when the stage's checks found
// something in its documents (completionChecksStep); the agent runs it again.
function review(cwd: string, projectDir: string, verdict?: string) {
  const run = () => runCheckpointTool(cwd, "tools/aidlc-log.ts", [
    "review", "--stage", STAGE, "--unit", "alpha", "--reviewer", REVIEWER, "--iteration", "1",
    ...(verdict ? ["--verdict", verdict] : []), "--project-dir", projectDir,
  ]);
  const first = run();
  return verdict === undefined && first.out.includes("Before the review, this stage's checks ran") ? run() : first;
}

describe("a side-by-side Unit's reviewer writes the review the verdict reads", () => {
  for (const repo of [null, "app"]) {
    test(`from the main folder, ${repo === null ? "one repository" : "a sibling repository"}`, () => {
      const pd = fixture(["alpha"], CHECK, false, repo);
      const prepared = repo === null
        ? prepare(pd)
        : swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--base", "main", "--repo", repo]);
      expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
      const child = wt(pd);
      // The records stay at the workspace roof: the worker writes the stage's documents in its worktree.
      if (repo !== null) {
        cpSync(codeGenerationRecordDir(pd, "alpha"), codeGenerationRecordDir(child, "alpha"), { recursive: true, force: false });
      }
      built(child);

      const request = review(pd, child);
      expect(request.code, `${request.out}\n${request.err}`).toBe(0);
      const { reviewFile, agent_note } = JSON.parse(request.out) as { reviewFile: string; agent_note: string };

      // The reviewer, in the main folder, writes the path it was handed; its write tool makes any missing folder.
      mkdirSync(dirname(resolve(pd, reviewFile)), { recursive: true });
      writeFileSync(resolve(pd, reviewFile), REVIEW);
      const recorded = review(pd, child, "READY");
      expect(recorded.code, `${recorded.out}\n${recorded.err}`).toBe(0);
      expect(JSON.parse(recorded.out).emitted).toBe("REVIEW_COMPLETED");
      expect(isAbsolute(reviewFile)).toBe(true);
      expect(reviewFile.startsWith(`${toPosix(child)}/aidlc/spaces/`)).toBe(true);
      expect(agent_note).toContain(`have it write ${reviewFile}:`);
    });
  }

  test("a one-at-a-time build's request keeps the project-relative path", () => {
    const pd = fixture(["alpha"], CHECK);
    writeActiveDirectiveMarker(pd, {
      kind: "run-stage", stage: STAGE, unit: "alpha",
      state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
    });
    built(pd);
    const request = review(pd, pd);
    expect(request.code, `${request.out}\n${request.err}`).toBe(0);
    expect(JSON.parse(request.out).reviewFile).toMatch(/^aidlc\/spaces\/[^/]+\/intents\/[^/]+\/\.aidlc-engine\/reviews\//);
  });
});

describe("a side-by-side Unit's worker writes its records where AI-DLC reads them", () => {
  for (const repo of [null, "app"]) {
    test(`after prepare the brief names the worktree and its record folder, ${repo === null ? "one repository" : "a sibling repository"}`, () => {
      const pd = fixture(["alpha"], CHECK, false, repo);
      const prepared = repo === null
        ? prepare(pd)
        : swarm(pd, ["prepare", "--batch", "1", "--units", "alpha", "--base", "main", "--repo", repo]);
      expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
      const child = wt(pd);
      const records = toPosix(codeGenerationRecordDir(child, "alpha"));
      const text = brief(pd);
      expect(text).toContain(
        `Your worktree is \`${toPosix(child)}\`: write this Unit's code there, and its records ` +
          `(code-summary.md, source-manifest.json, traceability.json) in \`${records}\`.`,
      );
      expect(isAbsolute(records)).toBe(true);
      const files = text.slice(text.indexOf("## Files and commands"), text.indexOf("## The plan file"));
      expect(files).toContain(records);
    });
  }

  // The parallel-build protocol takes the brief before prepare, and the worker gets it at fan-out, after prepare.
  test("a batch Unit's brief taken before prepare names the worktree prepare then makes, and its record folder", () => {
    const pd = fixture(["alpha"], CHECK);
    const early = brief(pd);
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const child = wt(pd);
    const line = `Your worktree is \`${toPosix(child)}\`: write this Unit's code there, and its records ` +
      `(code-summary.md, source-manifest.json, traceability.json) in \`${toPosix(codeGenerationRecordDir(child, "alpha"))}\`.`;
    expect(early).toContain(line);
    expect(brief(pd)).toContain(line);
  });

  test("a one-at-a-time build's brief names no worktree and keeps the project-relative plan", () => {
    const pd = fixture(["alpha"], CHECK);
    writeActiveDirectiveMarker(pd, {
      kind: "run-stage", stage: STAGE, unit: "alpha",
      state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
    });
    const text = brief(pd);
    expect(text).not.toContain("Your worktree is");
    expect(text).not.toContain(".aidlc/worktrees");
    const plan = toPosix(relative(pd, join(codeGenerationRecordDir(pd, "alpha"), "code-generation-plan.md")));
    expect(text).toContain(`Tick each step's box in \`${plan}\` as you finish the step.`);
  });

  test("under strict, finalize names the manifest in the worktree's record folder", () => {
    const pd = fixture(["alpha"], CHECK);
    const prepared = prepare(pd);
    expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
    const child = wt(pd);
    writeFileSync(join(child, "src", "alpha.ts"), "export const alpha = 2;\n");
    // A worker that put its manifest at the worktree's root instead of in the record folder.
    const stray = join(child, "construction", "alpha", "code-generation");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "source-manifest.json"),
      JSON.stringify({ stage: STAGE, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }] }));
    const checked = swarm(pd, ["check", "alpha"]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, "alpha");

    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(2);
    const { detail } = (JSON.parse(finalized.out) as { units: { detail: string }[] }).units[0];
    expect(detail).toContain("outside unit \"alpha\"'s source manifest (construction/alpha/code-generation/source-manifest.json)");
    expect(detail).toContain(`update ${toPosix(join(codeGenerationRecordDir(child, "alpha"), "source-manifest.json"))},`);
  });
});
