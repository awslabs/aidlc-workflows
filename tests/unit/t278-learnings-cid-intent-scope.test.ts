// covers: cli:aidlc-learnings(persist)
//
// t278 - aidlc-learnings.ts persist's cid marker is scoped to the intent, not
// just the stage. Regression test for the defect reported in #735.
//
// Mechanism: cli. cidMarker/handlePersist are internal (not exported), so the
// contract is exercised behaviourally through the process boundary exactly as
// t112/t199 do.
//
// THE DEFECT: cidMarker(slug, candidateId) keyed the write-idempotency marker
// on (stage slug, candidate id) only. Candidate ids restart at c1 on every
// stage run, and the destination files (project.md/team.md) are
// workspace-level - they accumulate learnings from every intent that has ever
// run that stage in the workspace, by design (stage-protocol.md SS13: no
// per-intent partition). So an unrelated intent's own c1 for a
// previously-run stage collided with an earlier intent's marker already in
// the file; handlePersist's hasLine check then silently skipped the write
// while still emitting RULE_LEARNED and reporting rule_learned: 1 - audit and
// file state diverged with no error surfaced anywhere.
//
// THE FIX: cidMarker now takes the active intent's record-dir name (resolved
// via aidlc-lib.ts's activeIntent()) as a third key component, so two
// intents' identically-numbered candidates for the same stage can never
// collide.
//
// Source under test (dist/claude/.claude/tools/aidlc-learnings.ts):
//   cidMarker(intentSlug, slug, candidateId) => `<!-- cid:${intentSlug}:${slug}:${candidateId} -->`
//   handlePersist resolves intentSlug once via activeIntent(projectDir).

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  createTestProject,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  intentsDirOf,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const LEARNINGS_TS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");
const STAGE_SLUG = "user-stories";
const CANDIDATE_ID = "c1";
const SECOND_RECORD_DIR = "fixture-b2222222";

const projects: string[] = [];
afterEach(() => {
  for (const p of projects) rmSync(p, { recursive: true, force: true });
  projects.length = 0;
});

// createTestProject() seeds the record DIRECTORY but deliberately leaves
// aidlc-state.md absent (other tests rely on that "no active intent yet"
// shape) - activeIntent() requires the file to exist before it will resolve
// the cursor's named record, so this test writes it explicitly.
function mkProject(): string {
  const pd = createTestProject();
  projects.push(pd);
  writeFileSync(
    seededStateFile(pd),
    "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n",
    "utf-8",
  );
  return pd;
}

/** Write a `type: "learning"` selections file for one candidate. */
function selectionsFile(pd: string, name: string, text: string): string {
  const p = join(pd, `${name}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      stage_slug: STAGE_SLUG,
      selections: [
        {
          candidate_id: CANDIDATE_ID,
          type: "learning",
          scope: "project",
          heading: "Corrections",
          text,
        },
      ],
    }),
    "utf-8",
  );
  return p;
}

function runPersist(pd: string, selJson: string): { status: number; out: string } {
  const r = spawnSync(
    BUN,
    [LEARNINGS_TS, "persist", "--slug", STAGE_SLUG, "--selections-json", selJson, "--project-dir", pd],
    { encoding: "utf-8" },
  );
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function projectMd(pd: string): string {
  return readFileSync(join(pd, "aidlc", "spaces", DEFAULT_SPACE, "memory", "project.md"), "utf-8");
}

/** Seed a second, unrelated intent record dir and switch the active-intent
 *  cursor to it - mirrors "switch to (or create) an unrelated Intent B in the
 *  same workspace" from the issue's own repro steps. */
function switchToSecondIntent(pd: string): void {
  const intentsDir = intentsDirOf(pd, DEFAULT_SPACE);
  mkdirSync(join(intentsDir, SECOND_RECORD_DIR), { recursive: true });
  writeFileSync(
    join(intentsDir, SECOND_RECORD_DIR, "aidlc-state.md"),
    "# AI-DLC State Tracking\n- **Current Stage**: user-stories\n- **Scope**: feature\n",
    "utf-8",
  );
  writeFileSync(join(intentsDir, "active-intent"), `${SECOND_RECORD_DIR}\n`, "utf-8");
}

function switchToFirstIntent(pd: string): void {
  const intentsDir = intentsDirOf(pd, DEFAULT_SPACE);
  writeFileSync(join(intentsDir, "active-intent"), `${DEFAULT_RECORD_DIR}\n`, "utf-8");
}

describe("t278 aidlc-learnings persist — cid marker scoped to the intent (#735)", () => {
  test("two intents' identically-numbered candidates for the same stage both persist, not collide", () => {
    const pd = mkProject();

    // Intent A (the seeded default record dir is already active) persists c1.
    const selA = selectionsFile(pd, "sel-a", "Learning from intent A");
    const resA = runPersist(pd, selA);
    expect(resA.status).toBe(0);
    expect(JSON.parse(resA.out).rule_learned).toBe(1);

    const afterA = projectMd(pd);
    expect(afterA).toContain("Learning from intent A");
    expect(afterA).toContain(`cid:${DEFAULT_RECORD_DIR}:${STAGE_SLUG}:${CANDIDATE_ID}`);

    // Switch to an unrelated Intent B in the SAME workspace (same project.md)
    // and persist its own, differently-worded c1 for the SAME stage.
    switchToSecondIntent(pd);
    const selB = selectionsFile(pd, "sel-b", "Learning from intent B");
    const resB = runPersist(pd, selB);
    expect(resB.status).toBe(0);
    // Pre-fix, this would have been silently dropped: hasLine would have
    // matched Intent A's unscoped marker, so the write is skipped while
    // RULE_LEARNED still fires and rule_learned still reports 1 - the exact
    // audit/file divergence #735 reports. Asserting the FILE state (not just
    // the reported count) is the point of this test.
    expect(JSON.parse(resB.out).rule_learned).toBe(1);

    const afterB = projectMd(pd);
    // Both intents' lines survive side by side.
    expect(afterB).toContain("Learning from intent A");
    expect(afterB).toContain("Learning from intent B");
    // Two DISTINCT markers - the intent slug is genuinely part of the key.
    expect(afterB).toContain(`cid:${DEFAULT_RECORD_DIR}:${STAGE_SLUG}:${CANDIDATE_ID}`);
    expect(afterB).toContain(`cid:${SECOND_RECORD_DIR}:${STAGE_SLUG}:${CANDIDATE_ID}`);
  }, 30000);

  test("a same-intent, same-day re-run of the identical selection remains a no-op (crash-recovery idempotency preserved)", () => {
    const pd = mkProject();
    const selA = selectionsFile(pd, "sel-a", "Learning from intent A");

    const first = runPersist(pd, selA);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.out).rule_learned).toBe(1);

    // Re-run under the SAME active intent with the identical selection.
    switchToFirstIntent(pd); // no-op here (already active) - documents intent
    const second = runPersist(pd, selA);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.out).rule_learned).toBe(0);

    // Exactly one occurrence of the line, not two.
    const content = projectMd(pd);
    const occurrences = content.split("Learning from intent A").length - 1;
    expect(occurrences).toBe(1);
  }, 30000);
});
