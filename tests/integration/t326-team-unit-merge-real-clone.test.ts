// covers: subcommand:aidlc-unit:publish, subcommand:aidlc-unit:pin

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { deriveTeamUnitProgressModel } from "../../dist/claude/.claude/tools/aidlc-orchestrate.ts";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  UNIT,
  cleanupTempDirs,
  git,
  makeSeed,
  prepareCandidate,
  runMergeTool,
} from "../harness/team-unit-merge.ts";

// A team's own clone holds what a real one holds (the t326 fixture commits
// through AI-DLC's shipped .gitignore): the stages' shared diaries outside the
// Unit's folder, review records under the record's engine folder that no
// commit carries, and a Unit Progress row the engine rewrites on every `next`.
// Publish hands pin exactly what it reads, and nothing the clone keeps.

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

afterEach(cleanupTempDirs);

describe("t326 pinned team Unit merge: a real clone's own files", () => {
  test("the candidate carries the receipts' review records and no diary or other engine file", () => {
    const { seed, remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-team");
    const record = relative(candidate.checkout, seededRecordDir(candidate.checkout)).replaceAll("\\", "/");
    const tree = git(candidate.checkout, ["ls-tree", "-r", "--name-only", candidate.candidateOid]).split("\n");

    expect(tree.filter((path) => path.startsWith(`${record}/.aidlc-engine/reviews/`) && path.endsWith(".json")))
      .toHaveLength(5);
    expect(tree.filter((path) => path.includes("/.aidlc-engine/") && !path.includes("/.aidlc-engine/reviews/")))
      .toEqual([]);
    expect(tree.filter((path) => /\/construction\/[^/]+\/memory\.md$/.test(path))).toEqual([]);
    // The clone keeps its diaries; only the published tree leaves them out.
    expect(existsSync(join(seededRecordDir(candidate.checkout), "construction", "functional-design", "memory.md")))
      .toBe(true);

    const pin = runMergeTool(UNIT, ["pin", "alpha"], seed);
    expect(pin.status, pin.out).toBe(0);
  });

  test("the engine's own Unit Progress table keeps the claim's owner on a complete row", () => {
    const { remote } = makeSeed();
    const candidate = prepareCandidate(remote, "alpha", "alpha-team");
    // Every `next` in the claimed clone writes this derivation back
    // (refreshTeamUnitProgress), and pin compares the published row's owner
    // with the claim's.
    const model = deriveTeamUnitProgressModel(
      candidate.checkout,
      readFileSync(seededStateFile(candidate.checkout), "utf-8"),
    );
    expect(model.section.split("\n").find((line) => line.startsWith("| alpha |")))
      .toStartWith("| alpha | alpha-team |");
  });
});
