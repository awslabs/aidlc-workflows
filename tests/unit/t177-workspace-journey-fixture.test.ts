// covers: file:tests/harness/fixtures.ts
//
// t177-workspace-journey-fixture.test.ts — the DETERMINISTIC self-test for the
// P10 / Stage E workspace-journey fixture (setupWorkspaceJourney). The live
// journey legs (t-journey-workspace.sdk / t-acp-kiro-journey-workspace /
// t-exec-codex-journey-workspace) burn real tokens and are flaky-by-nature; this
// test proves the SHARED fixture is correct WITHOUT any LLM, so the fixture is
// unit-verifiable on its own (the card's "deterministic, unit-testable on its
// own: seeds two repos + the shell correctly" deliverable).
//
// It asserts, purely on disk, for each harness:
//   - the shipped dist/<harness>/ shell landed (engine dir + the aidlc/ memory
//     shell with the default space),
//   - repo-a/.git and repo-b/.git exist as IMMEDIATE children of the root,
//   - discoverSiblingRepos(root) === ["repo-a","repo-b"] (sorted, deduped — the
//     exact set birth's repo discovery would capture),
//   - NO intent is pre-born (listIntents(root) is empty — the journey births live),
//   - the workspace root is a fresh os.tmpdir() path, NOT nested under
//     .claude/worktrees/ (so the construction-worktree guard, a structural git
//     check, passes when the journey forks worktrees in the siblings),
//   - cleanupWorkspaceJourney removes the tmp root.
//
// The lib readers are pure projectDir-keyed path scans, identical across
// harnesses (the packager substitutes only the harness-dir token), so importing
// them from the claude dist exercises every harness's seeded root correctly.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Generous per-case budget: setupWorkspaceJourney does a full dist-shell cpSync
// (the codex tree is the largest) plus eight git invocations across two repos,
// which can exceed bun's 5s default on a loaded CI box. This is pure fs/git work
// — no LLM — so a wide cap never masks a real hang.
const CASE_TIMEOUT_MS = 60_000;
import {
  cleanupWorkspaceJourney,
  setupWorkspaceJourney,
} from "../harness/fixtures.ts";
import { HARNESS_MATRIX } from "../harness/harness-matrix.ts";
import { discoverSiblingRepos, listIntents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

describe("t177 workspace-journey fixture (deterministic, no LLM)", () => {
  for (const harness of HARNESS_MATRIX) {
    test(`${harness.name}: seeds the shell + two sibling repos, no pre-born intent`, () => {
      const journey = setupWorkspaceJourney(harness.name);
      try {
        // The root is a fresh tmpdir, NOT nested under .claude/worktrees/ (the
        // construction-worktree guard's requirement — see the fixture comment).
        expect(journey.root.includes(`${join(".claude", "worktrees")}`)).toBe(false);

        // The shipped harness engine dir landed.
        const engineDir = join(journey.root, harness.manifest.harnessDir);
        expect(existsSync(engineDir)).toBe(true);
        for (const rootFile of harness.capabilities.rootFiles) {
          expect(existsSync(join(journey.root, rootFile)), `${harness.name}: ${rootFile}`).toBe(
            true,
          );
        }

        // The sibling aidlc/ memory shell landed (the default space's memory),
        // so the rule-layer resolver finds the method.
        expect(existsSync(join(journey.root, "aidlc", "spaces", "default", "memory"))).toBe(true);
        // The pinned per-clone audit-shard token is in place.
        expect(existsSync(join(journey.root, "aidlc", ".aidlc-clone-id"))).toBe(true);

        // repo-a / repo-b are immediate children, each a real git checkout.
        expect(journey.repoA).toBe(join(journey.root, "repo-a"));
        expect(journey.repoB).toBe(join(journey.root, "repo-b"));
        expect(existsSync(join(journey.repoA, ".git"))).toBe(true);
        expect(existsSync(join(journey.repoB, ".git"))).toBe(true);
        // The seed source file each repo carries (so a reverse-engineering scan
        // has real content and construction sees a checkout).
        expect(existsSync(join(journey.repoA, "main.py"))).toBe(true);
        expect(existsSync(join(journey.repoB, "main.py"))).toBe(true);

        // The exact set birth's discovery would capture: sorted, deduped, with
        // the engine dir + the aidlc roof excluded.
        expect(discoverSiblingRepos(journey.root)).toEqual(["repo-a", "repo-b"]);

        // No intent is pre-born — the journey's step 1 auto-births it live.
        expect(listIntents(journey.root)).toEqual([]);
      } finally {
        cleanupWorkspaceJourney(journey);
      }
      // Cleanup removed the tmp root (cleanup ran in the finally above).
      expect(existsSync(journey.root)).toBe(false);
    }, CASE_TIMEOUT_MS);
  }
});
