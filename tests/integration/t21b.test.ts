// covers: subcommand:aidlc-utility:intent-create
//
// t21b.test.ts - establishes a first workflow creation through the Claude Agent
// SDK, then drives a SECOND creation on that project, and asserts ONLY on
// deterministic surfaces — the on-disk per-intent records, the parsed audit
// events, and the verbatim creation CLI stdout - NEVER on assistantText.
//
// A workspace holds MANY intents, so a SECOND creation (naming a scope again)
// SUCCEEDS and mints a SECOND intent record under
// aidlc/spaces/default/intents/ — there is no "already exists" rejection and no
// --force. This file proves the second creation adds a distinct, second intent
// record + a fresh WORKFLOW_STARTED, without clobbering the first. (Mirrors
// tests/unit/t20.test.ts "17-19" and
// tests/integration/t165-intent-create-p4.test.ts new-work-while-active.)
//
// THE TWO-CREATION JOURNEY (verified against the SHIPPED handler):
//   creation 1: `/aidlc --scope poc "first thing"` on a fresh workspace -> the engine
//            NAMES intent-create, the conductor runs it; handleIntentCreate mints
//            the first per-intent record + writes its state + emits WORKFLOW_STARTED
//            (utility.ts) into that record's audit shard. Baseline captured.
//   creation 2: a direct `intent-create` invocation -> a SECOND creation. There is
//            NO re-init guard (handleIntentCreate has no "already exists" die() -
//            a second creation just mints another intent). It adds a SECOND record
//            dir and points the active-intent cursor at it, with its own
//            WORKFLOW_STARTED. The FIRST record survives untouched.
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - creation dispatch:            engine NAMES `intent create --scope <scope>` (aidlc-orchestrate.ts)
//   - NO re-init guard:          handleIntentCreate (aidlc-utility.ts) - no "already exists" die()
//   - second creation mints a 2nd intent:  createIntent appends a 2nd registry row + record dir + cursor flip
//   - WORKFLOW_STARTED on every creation:  aidlc-utility.ts
//   - State initialized summary: "State initialized:" (aidlc-utility.ts)
//   - init-stage [x] markers:    "[x] workspace-scaffold" (init phase marker always [x])
//
// It SPENDS TOKENS - creation 1 drives the real /aidlc on Opus/Bedrock (x1);
// creation 2 invokes the deterministic intent-create tool directly (the
// no-re-init-guard contract is a tool contract, not a live-conductor journey -
// see the creation-2 note below). Generous per-test timeout so a hung
// canUseTool fails LOUD.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
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

// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Known-answer literals from the SHIPPED creation handler (see header for file:line).
const INIT_STATE_SUMMARY = "State initialized:"; // aidlc-utility.ts handleIntentCreateStateBuild
const STOP_AFTER_CREATION = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
const WORKFLOW_STARTED = "WORKFLOW_STARTED";

const intentsDir = (proj: string, space = "default"): string =>
  join(proj, "aidlc", "spaces", space, "intents");

function recordDirs(proj: string): string[] {
  const root = intentsDir(proj);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) =>
    existsSync(join(root, d, "aidlc-state.md")),
  );
}

function activeRecord(proj: string): string | undefined {
  const cursor = join(intentsDir(proj), "active-intent");
  if (!existsSync(cursor)) return undefined;
  const rec = readFileSync(cursor, "utf8").trim();
  return rec.length > 0 ? rec : undefined;
}

function auditTextOf(proj: string, recordName: string): string {
  const dir = join(intentsDir(proj), recordName, "audit");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

describe("t21b /aidlc second creation (no re-init guard) (sdk)", () => {
  // -------------------------------------------------------------------------
  // Two sequential creates against ONE fresh project: creation -> second creation
  // (SUCCEEDS, mints a distinct second intent without clobbering the first).
  // -------------------------------------------------------------------------
  test(
    "a second creation succeeds (no re-init guard), mints a distinct second intent record, and starts a fresh workflow",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        expect(recordDirs(proj).length).toBe(0);

        // ---- creation 1: establish the first intent ----
        const r1 = await driveAidlc('/aidlc --scope poc "first thing"', {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_CREATION,
        });
        // The creation CLI fired (no vacuous pass) and the first record landed.
        assertToolResultContains(r1, "Bash", INIT_STATE_SUMMARY);
        const recordsAfter1 = recordDirs(proj);
        expect(recordsAfter1.length).toBe(1);
        const firstRecord = activeRecord(proj);
        expect(firstRecord).toBeDefined();
        expect(auditTextOf(proj, firstRecord as string)).toContain(
          `**Event**: ${WORKFLOW_STARTED}`,
        );

        // ---- second creation while an intent is ALREADY active ----
        // New work alongside an active intent is a conductor-mediated decision,
        // but the deterministic CONTRACT under test is that the creation HANDLER
        // itself has NO re-init guard: invoke it directly, exactly as the conductor
        // would when the human chose "start a new intent". A second `intent-create`
        // SUCCEEDS (exit 0), never an "already exists" / "--force" rejection. (The
        // live conductor's new-work Y/n offer is exercised by the orchestration
        // journey; here we pin the tool's no-guard creation.)
        const r2 = spawnSync(
          "bun",
          [
            join(proj, ".claude", "tools", "aidlc-utility.ts"),
            "intent-create",
            "--scope",
            "feature",
            "--arguments",
            "second thing",
            "--project-dir",
            proj,
          ],
          { encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: proj } },
        );
        const creationResultText = `${r2.stdout ?? ""}${r2.stderr ?? ""}`;

        expect(r2.status).toBe(0);
        expect(creationResultText).toContain(INIT_STATE_SUMMARY);
        // NO "already exists" / "--force" rejection.
        expect(creationResultText).not.toContain("already exists");
        expect(creationResultText).not.toContain("--force");

        const recordsAfter2 = recordDirs(proj);
        expect(recordsAfter2.length).toBe(2);
        expect(new Set(recordsAfter2).size).toBe(2);
        expect(recordsAfter2).toContain(firstRecord as string);

        // Both records hold an aidlc-state.md (every record in recordDirs() does, by
        // construction of the filter - assert it explicitly for both).
        for (const rec of recordsAfter2) {
          expect(existsSync(join(intentsDir(proj), rec, "aidlc-state.md"))).toBe(true);
        }

        const secondRecord = activeRecord(proj);
        expect(secondRecord).toBeDefined();
        expect(secondRecord).not.toBe(firstRecord);

        // The active (second) record's state carries [x] workspace-scaffold (the init
        // phase marker is always [x]). Read off the per-intent state via sdk-drive's
        // resolver (active-intent -> record).
        const activeState = readStateFile(proj);
        expect(activeState).toBeDefined();
        expect(activeState as string).toContain("[x] workspace-scaffold");

        // The SECOND creation started a fresh workflow - its audit shard carries
        // WORKFLOW_STARTED (a new workflow began, not a wipe of the first). The first
        // record's WORKFLOW_STARTED still stands.
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
