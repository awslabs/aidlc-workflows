// covers: subcommand:aidlc-utility:intent-birth
//
// t21b.test.ts — SDK-harness port of tests/integration/t21b-integration-init-idempotent.sh
// (plan 6), REWRITTEN for the P4 contract. Drives a SECOND workflow birth on a
// project that already has one, through the Claude Agent SDK, and asserts ONLY on
// deterministic surfaces — the on-disk per-intent records, the parsed audit
// events, and the verbatim birth-CLI stdout in the Bash tool_result — NEVER on
// assistantText.
//
// P4 MIGRATION — the re-init GUARD IS RETIRED. The .sh proved an `--init` /
// `--force` idempotency contract: a second bare `--init` was REJECTED with
// "aidlc-state.md already exists ... Use --force to reinitialize", and only
// `--init --force` could re-init (wiping + re-writing the single flat state).
// That whole guard is GONE. The user-facing --init/--force are retired; a
// workspace now holds MANY intents, so a SECOND birth (naming a scope again)
// SUCCEEDS and mints a SECOND intent record under
// aidlc/spaces/default/intents/ — there is no "already exists" rejection and no
// --force. This file is rewritten to the NEW contract: drive a scope twice and
// prove the second birth adds a distinct, second intent record + a fresh
// WORKFLOW_STARTED, without clobbering the first. (Mirrors tests/unit/t20.test.ts
// "17-19" and tests/integration/t165-intent-birth-p4.test.ts new-work-while-active.)
//
// The birth path is gate-free (it prints state and STOPs), so
// there is no auto-approve to drop.
//
// THE TWO-BIRTH JOURNEY (verified against the SHIPPED handler):
//   birth 1: `/aidlc --scope poc "first thing"` on a fresh workspace -> the engine
//            NAMES intent-birth, the conductor runs it; handleIntentBirth mints
//            the first per-intent record + writes its state + emits WORKFLOW_STARTED
//            (utility.ts:2065) into that record's audit shard. Baseline captured.
//   birth 2: `/aidlc --scope feature "second thing"` -> a SECOND birth. There is NO
//            re-init guard (handleIntentBirth has no "already exists" die() — a
//            second birth just mints another intent). It adds a SECOND record dir
//            and points the active-intent cursor at it, with its own
//            WORKFLOW_STARTED. The FIRST record survives untouched.
//
// ASSERTION MAP (.sh test -> NEW deterministic SDK surface):
//   1 state structure unchanged after rejected re-init
//       -> RETIRED contract. The replacement: after birth 2 there are TWO distinct
//          intent record dirs under spaces/default/intents/ (the first is NOT
//          clobbered). The second birth's stdout carries no "already exists" /
//          "--force" rejection (a regression guard on the retired guard).
//   2 workflow state events unchanged after rejected re-init
//       -> RETIRED. The replacement: the SECOND birth emits its OWN fresh
//          WORKFLOW_STARTED in its own audit shard (a new workflow began).
//   3 third --init --force exits zero
//       -> the SECOND birth's Bash tool_result is non-error (is_error === false).
//   4 state file still exists after --force reinit
//       -> both record dirs hold an aidlc-state.md after birth 2.
//   5 --force reinit produces [x] workspace-scaffold
//       -> the active (second) record's state contains "[x] workspace-scaffold"
//          (init phase marker always [x]).
//   6 audit gained a 2nd WORKFLOW_STARTED on --force (not wiped)
//       -> the second birth's audit shard carries WORKFLOW_STARTED (its own
//          workflow start), proving a second workflow truly began.
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - birth dispatch:            engine NAMES `intent-birth --scope <scope>` (aidlc-orchestrate.ts:302)
//   - NO re-init guard:          handleIntentBirth (aidlc-utility.ts:1986) — no "already exists" die()
//   - second birth mints a 2nd intent:  birthIntent appends a 2nd registry row + record dir + cursor flip
//   - WORKFLOW_STARTED on every birth:  aidlc-utility.ts:2065
//   - State initialized summary: "State initialized:" (aidlc-utility.ts:2376)
//   - init-stage [x] markers:    "[x] workspace-scaffold" (init phase marker always [x])
//
// It SPENDS TOKENS — birth 1 drives the real /aidlc on Opus/Bedrock (×1); birth 2
// invokes the deterministic intent-birth tool directly (the no-re-init-guard
// contract is a tool contract, not a live-conductor journey — see the birth-2
// note below). Generous per-test timeout so a hung canUseTool fails LOUD.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateFile } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget — two real birth turns on Opus/Bedrock. Honour the
// AIDLC_TEST_TIMEOUT convention. The driver aborts ~15s before bun's per-test cap
// so a stuck canUseTool surfaces a partial DriveResult to diagnose rather than an
// opaque hang. The cap covers both runs (they share the test).
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "900", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 900) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, Math.floor(TEST_TIMEOUT_MS / 2) - 15_000);

// Known-answer literals from the SHIPPED birth handler (see header for file:line).
const INIT_STATE_SUMMARY = "State initialized:"; // utility.ts:2376
const STOP_AFTER_BIRTH = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
const WORKFLOW_STARTED = "WORKFLOW_STARTED";

const intentsDir = (proj: string, space = "default"): string =>
  join(proj, "aidlc", "spaces", space, "intents");

/** The intent record dirs (dirs holding an aidlc-state.md) under the default space. */
function recordDirs(proj: string): string[] {
  const root = intentsDir(proj);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) =>
    existsSync(join(root, d, "aidlc-state.md")),
  );
}

/** The active intent's record dir name (the active-intent cursor), or undefined. */
function activeRecord(proj: string): string | undefined {
  const cursor = join(intentsDir(proj), "active-intent");
  if (!existsSync(cursor)) return undefined;
  const rec = readFileSync(cursor, "utf8").trim();
  return rec.length > 0 ? rec : undefined;
}

/** Concatenated text of every audit shard under a record's audit/ dir. */
function auditTextOf(proj: string, recordName: string): string {
  const dir = join(intentsDir(proj), recordName, "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

describe("t21b /aidlc second-birth (no re-init guard) (sdk)", () => {
  // -------------------------------------------------------------------------
  // Two sequential births against ONE fresh project: birth -> second birth
  // (SUCCEEDS, mints a distinct second intent without clobbering the first).
  // Every (retired) .sh assertion re-expressed on the post-run per-intent records
  // + audit shards, read off disk.
  // -------------------------------------------------------------------------
  test(
    "a second birth succeeds (no re-init guard), mints a distinct second intent record, and starts a fresh workflow",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        // Precondition: empty workspace — no intent records yet.
        expect(recordDirs(proj).length).toBe(0);

        // ---- birth 1: establish the first intent ----
        const r1 = await driveAidlc('/aidlc --scope poc "first thing"', {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_BIRTH,
        });
        // The birth CLI fired (no vacuous pass) and the first record landed.
        assertToolResultContains(r1, "Bash", INIT_STATE_SUMMARY);
        const recordsAfter1 = recordDirs(proj);
        expect(recordsAfter1.length).toBe(1);
        const firstRecord = activeRecord(proj);
        expect(firstRecord).toBeDefined();
        // Birth 1 emitted its WORKFLOW_STARTED into the first record's audit shard.
        expect(auditTextOf(proj, firstRecord as string)).toContain(
          `**Event**: ${WORKFLOW_STARTED}`,
        );

        // ---- birth 2: a SECOND birth while an intent is ALREADY active ----
        // New work alongside an active intent is a conductor-mediated decision,
        // but the deterministic CONTRACT under test (the retired-guard subject of
        // this port) is that the birth HANDLER itself has NO re-init guard: invoke
        // it directly, exactly as the conductor would when the human chose "start a
        // new intent". A second `intent-birth` SUCCEEDS (exit 0), never the old
        // "Use --force to reinitialize" rejection. (The live conductor's new-work
        // Y/n offer is exercised by the orchestration journey; here we pin the
        // tool's no-guard birth, which is what the .sh's --force case really tested.)
        const r2 = spawnSync(
          "bun",
          [
            join(proj, ".claude", "tools", "aidlc-utility.ts"),
            "intent-birth",
            "--scope",
            "feature",
            "--arguments",
            "second thing",
            "--project-dir",
            proj,
          ],
          { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
        );
        const birthResultText = `${r2.stdout ?? ""}${r2.stderr ?? ""}`;

        // The second birth exited 0 (no re-init guard) and printed its summary.
        expect(r2.status).toBe(0);
        expect(birthResultText).toContain(INIT_STATE_SUMMARY);
        // RETIRED-GUARD REGRESSION: NO "already exists" / "--force" rejection.
        expect(birthResultText).not.toContain("already exists");
        expect(birthResultText).not.toContain("--force");

        // .sh test 1 (re-expressed): there are now TWO distinct intent record
        // dirs — the second birth ADDED one without clobbering the first.
        const recordsAfter2 = recordDirs(proj);
        expect(recordsAfter2.length).toBe(2);
        expect(new Set(recordsAfter2).size).toBe(2);
        // The first record survives among them.
        expect(recordsAfter2).toContain(firstRecord as string);

        // .sh test 4 (re-expressed): both records hold an aidlc-state.md (every
        // record in recordDirs() does, by construction of the filter — assert it
        // explicitly for both).
        for (const rec of recordsAfter2) {
          expect(existsSync(join(intentsDir(proj), rec, "aidlc-state.md"))).toBe(true);
        }

        // The active-intent cursor now points at the SECOND (most recent) birth.
        const secondRecord = activeRecord(proj);
        expect(secondRecord).toBeDefined();
        expect(secondRecord).not.toBe(firstRecord);

        // .sh test 5 (re-expressed): the active (second) record's state carries
        // [x] workspace-scaffold (the init phase marker is always [x]). Read off
        // the per-intent state via sdk-drive's resolver (active-intent → record).
        const activeState = readStateFile(proj);
        expect(activeState).toBeDefined();
        expect(activeState as string).toContain("[x] workspace-scaffold");

        // .sh test 6 (re-expressed): the SECOND birth started a fresh workflow —
        // its audit shard carries WORKFLOW_STARTED (a new workflow began, not a
        // wipe of the first). The first record's WORKFLOW_STARTED still stands.
        expect(auditTextOf(proj, secondRecord as string)).toContain(
          `**Event**: ${WORKFLOW_STARTED}`,
        );
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
