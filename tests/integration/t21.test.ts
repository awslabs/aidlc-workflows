// covers: subcommand:aidlc-utility:intent-create
//
// t21.test.ts - drives a REAL workflow creation through the Claude Agent SDK
// and asserts ONLY on deterministic surfaces: the verbatim creation CLI stdout
// in the Bash tool_result, the on-disk per-intent record, the state-file
// fields, and the audit events. NEVER on assistantText.
//
// A workflow STARTS by naming a scope (or describing what to build); the engine
// NAMES the deterministic `intent-create` move and the conductor runs
// `bun .claude/tools/aidlc.ts engine intent create --scope <scope> ...`.
// Creation writes PER-INTENT: state at
// aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/aidlc-state.md, audit as per-clone
// shards under <record>/audit/, and the per-phase artifact dirs under that
// record. (Domain knowledge is SPACE-level — aidlc/spaces/<space>/knowledge/, a
// sibling of intents - not a record subdir.) This test resolves the created
// record via recordDirOf(). The creation path is gate-free: naming a scope on a
// fresh workspace creates and STOPs; the driver stops on the creation stdout.
//
// THE DETERMINISTIC SURFACE. The conductor runs
//   `bun .claude/tools/aidlc.ts engine intent create --scope <scope> ...`
// via Bash and prints its stdout VERBATIM. handleIntentCreate (aidlc-utility.ts)
// does the scan + state-init in one deterministic tool call, then writes the
// per-intent aidlc-state.md (the State-Version-8 template) and appends a fixed
// audit event sequence (per-clone shard). The Bash tool_result carries the creation
// stdout bytes; the files land in the created intent's record. We assert on both.
//
// ASSERTION MAP (literal cited from the SHIPPED handler):
//   1 aidlc-state.md exists            -> existsSync(recordDirOf(proj)/aidlc-state.md) on disk
//   2 audit shard exists               -> the created record's audit/ shard dir holds a *.md shard
//   3 State Version                    -> assertStateField(r,"State Version","8") (creation template)
//   3 state has Worktree Path field    -> readStateField(...,"Worktree Path") !== undefined
//   3 state has Bolt Refs field        -> readStateField(...,"Bolt Refs") !== undefined
//   3 state has Practices Affirmed ...  -> readStateField(...,"Practices Affirmed Timestamp") !== undefined
//   4 "[x] workspace-scaffold"          -> state file contains "[x] workspace-scaffold" (init marker)
//   5 "[x] workspace-detection"         -> state file contains "[x] workspace-detection"  (init phase always [x])
//   6 "[x] state-init"                  -> state file contains "[x] state-init"
//   7 knowledge/ directory exists       -> statSync(aidlc/spaces/default/knowledge).isDirectory()
//                                          (SPACE-level domain-knowledge dir, ensureWorkspaceDirs → knowledgeDir)
//
//   - The creation CLI actually RAN: assertToolResultContains(r,"Bash",<verbatim summary>)
//     proves the deterministic tool fired and its fixed stdout reached us
//     ("Intent created:" / "State initialized:" / "Project type:", utility.ts) -
//     written by handleIntentCreateStateBuild; the test pins the first two.
//     assertToolResultContains refuses to pass vacuously if Bash never
//     fired (assert.ts), so this also guards against a prose-only run.
//   - Creation audit events: the creation handler emits WORKFLOW_STARTED (utility.ts),
//     WORKSPACE_SCAFFOLDED, WORKSPACE_INITIALISED and per-init-stage
//     STAGE_COMPLETED. We assert the named events - a statement of WHY the
//     audit grew.
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - creation dispatch:         engine NAMES `intent create --scope <scope>` (aidlc-orchestrate.ts), conductor runs it
//   - creation stdout anchors:   "Intent created:" / "State initialized:" / "Project type:" (utility.ts)
//   - State Version value:    "8" (creation template)
//   - 3 state fields:         Worktree Path / Bolt Refs / Practices Affirmed Timestamp
//   - init-stage [x] markers: "[x] <slug>" for the 3 initialization stages, always EXECUTE/[x]
//   - creation audit events:     WORKFLOW_STARTED / WORKSPACE_SCAFFOLDED / WORKSPACE_INITIALISED (utility.ts)
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.

import {
  liveCaseTimeoutMs,
  LIVE_LONG_OPERATION_TIMEOUT_MS,
  remainingOperationTimeoutMs,
  fileCleanupReserveMs,
} from "../harness/test-budget.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  assertAuditEvent,
  assertStateField,
  assertToolResultContains,
} from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateField } from "../harness/sdk-drive.ts";

// Creation writes the workflow record PER-INTENT under
// aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/ (state, audit/ shards, per-phase
// dirs), NOT the flat aidlc-docs/. (Domain knowledge is SPACE-level — a sibling
// of intents at aidlc/spaces/<space>/knowledge/, not in the record.) Resolve the
// created record from the active-space + active-intent cursors (flat fallback
// for a not-yet-created project). Mirrors sdk-drive's recordDirFor and
// tests/integration/t-custom-harness-compile.test.ts.
function recordDirOf(proj: string): string {
  const spaceCursor = join(proj, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf8").trim() || "default"
    : "default";
  const intentsDir = join(proj, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(proj, "aidlc-docs");
}

// The case and file own the work budget; each SDK call uses what remains.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? String(LIVE_LONG_OPERATION_TIMEOUT_MS / 1000), 10);
const LIVE_WORK_TIMEOUT_MS = Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000 : LIVE_LONG_OPERATION_TIMEOUT_MS;
// Setup and cleanup allowances belong to the case; calls share its remaining work.
const TEST_TIMEOUT_MS = liveCaseTimeoutMs(LIVE_WORK_TIMEOUT_MS);

// Known-answer literals from the SHIPPED creation handler.
// The verbatim creation CLI stdout block (Bash stdout, printed verbatim by the
// conductor). Two anchors from the fixed stdout (aidlc-utility.ts
// handleIntentCreateStateBuild) - proving the deterministic tool fired, not the
// LLM's prose.
const INTENT_CREATED_LINE = "Intent created:"; // aidlc-utility.ts handleIntentCreateStateBuild
const INIT_STATE_SUMMARY = "State initialized:"; // aidlc-utility.ts handleIntentCreateStateBuild
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
// The 3 initialization-phase stages — always [x] in the freshly written state
// file (init phase marker is unconditionally "[x]").
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

describe("t21 /aidlc workflow creation (sdk)", () => {
  // -------------------------------------------------------------------------
  // First-run creation from a project with NO aidlc-docs/ (noAidlcDocs). Naming a
  // scope on the empty workspace creates the first intent.
  // -------------------------------------------------------------------------
  test(
    "creation writes the per-intent record + the State-Version-7 state file, and records its creation events",
    async () => {
      const deadlineMs = Date.now() + TEST_TIMEOUT_MS;
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        // Precondition: aidlc-docs/ truly absent and no intent record yet — a
        // clean creation on an empty workspace (NOT a migration; needsFlatMigration
        // is false with no flat state).
        expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);
        expect(existsSync(join(proj, "aidlc", "spaces", "default", "intents"))).toBe(false);

        const r = await driveAidlc('/aidlc --scope poc "build a todo app"', {
          projectDir: proj,
          timeoutMs: remainingOperationTimeoutMs(LIVE_WORK_TIMEOUT_MS, {
            deadlineMs, reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS), phase: "integration SDK drive",
          }),
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // The deterministic creation CLI actually fired via Bash and its verbatim
        // stdout reached us. assertToolResultContains refuses to pass vacuously if
        // Bash never fired (assert.ts) - so this proves the creation path RAN through
        // the tool, not that prose merely mentioned it.
        assertToolResultContains(r, "Bash", INTENT_CREATED_LINE);
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        const record = recordDirOf(proj);

        const statePath = join(record, "aidlc-state.md");
        expect(existsSync(statePath)).toBe(true);

        const auditDir = join(record, "audit");
        expect(existsSync(auditDir)).toBe(true);
        expect(readdirSync(auditDir).some((f) => f.endsWith(".md"))).toBe(true);

        expect(r.stateFile).toBeDefined();
        assertStateField(r, "State Version", "8");

        // The State-Version-8 template has Worktree Path / Bolt Refs / Practices
        // Affirmed Timestamp. They are empty-valued at init, so we assert the fields
        // PARSE (present) rather than asserting an empty value.
        for (const field of [
          "Worktree Path",
          "Bolt Refs",
          "Practices Affirmed Timestamp",
        ]) {
          const present = readStateField(r.stateFile as string, field);
          expect(present).toBeDefined();
        }

        // The 3 initialization stages are marked complete in the
        // state file. The shipped marker line is `- [x] <slug> — EXECUTE`
        // (init phase marker is unconditionally [x]), so "[x] <slug>" is a
        // substring. Assert each independently — the substring presence of one
        // does not prove the others.
        for (const stage of INIT_STAGES) {
          expect(r.stateFile as string).toContain(`[x] ${stage}`);
        }

        // knowledge/ directory created. statSync proves it is a DIRECTORY, not merely
        // a present path. Creation ensures the SPACE-level domain-knowledge dir
        // aidlc/spaces/<space>/knowledge/ (ensureWorkspaceDirs -> knowledgeDir,
        // aidlc-utility.ts) - a sibling of intents that accumulates across every
        // intent in the space, NOT a per-intent record subdir.
        const knowledgeDir = join(proj, "aidlc", "spaces", "default", "knowledge");
        expect(existsSync(knowledgeDir)).toBe(true);
        expect(statSync(knowledgeDir).isDirectory()).toBe(true);

        // The creation handler's audit events: assert the named events the handler
        // emits (WORKFLOW_STARTED, WORKSPACE_SCAFFOLDED, WORKSPACE_INITIALISED in
        // aidlc-utility.ts handleIntentCreate) - a statement of WHY the audit shard
        // exists and grew. (assertAuditEvent reads the created record's per-clone
        // shards via sdk-drive's readAuditEvents.)
        assertAuditEvent(r, "WORKFLOW_STARTED");
        assertAuditEvent(r, "WORKSPACE_SCAFFOLDED");
        assertAuditEvent(r, "WORKSPACE_INITIALISED");

        // The creation tool exited 0. The SDK driver intentionally aborts as soon
        // as the deterministic creation stdout lands, so the model cannot continue
        // into unrelated workflow execution after the creation contract is proven.
        const creationCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(INIT_STATE_SUMMARY),
        );
        expect(creationCall?.isError).toBe(false);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
