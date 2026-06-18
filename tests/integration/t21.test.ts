// covers: subcommand:aidlc-utility:intent-birth
//
// t21.test.ts — SDK-harness port of tests/integration/t21-integration-init.sh
// (plan 10). Drives a REAL workflow birth through the Claude Agent SDK and
// asserts ONLY on deterministic surfaces: the verbatim birth-CLI stdout in the
// Bash tool_result, the on-disk per-intent record, the state-file fields, and
// the audit events. NEVER on assistantText.
//
// P4 MIGRATION. The user-facing `/aidlc --init` is RETIRED. A workflow STARTS by
// naming a scope (or describing what to build); the engine NAMES the deterministic
// `intent-birth` move and the conductor runs
// `bun .claude/tools/aidlc-utility.ts intent-birth --scope <scope> ...`. Birth no
// longer scaffolds a flat aidlc-docs/ tree — it writes PER-INTENT: state at
// aidlc/spaces/<space>/intents/<slug>-<id8>/aidlc-state.md, audit as per-clone
// shards under <record>/audit/, and the per-phase artifact dirs under that
// record. (Domain knowledge is SPACE-level — aidlc/spaces/<space>/knowledge/, a
// sibling of intents — not a record subdir.) The State-Version-7 template + the
// birth audit events are
// unchanged (birth still writes them) — only the LOCATION moved (per-intent) and
// the dispatch verb (intent-birth, not init). This test resolves the born record
// via recordDirOf() (the proven pattern) and re-expresses every .sh assertion on
// the per-intent surfaces.
//
// WHY THIS PORT EXISTS. The .sh asserted by stat-ing files / grepping the
// state file on disk — those checks were ALREADY deterministic (no prose grep,
// unlike t20/t22). The port preserves that deterministic discipline and
// strengthens it: every .sh file/grep assertion is re-expressed on disk after
// a real driveAidlc birth run, and we ADD audit-event assertions the .sh never
// made (the birth handler's events), reaching equal-or-stronger parity. The
// birth path is gate-free: naming a scope on a fresh workspace births and STOPs.
// (t21b — the second-birth target — is a SEPARATE port.)
//
// THE DETERMINISTIC SURFACE. The conductor runs
//   `bun .claude/tools/aidlc-utility.ts intent-birth --scope <scope> ...`
// via Bash and prints its stdout VERBATIM. handleIntentBirth (aidlc-utility.ts:1986)
// does the scan + state-init in one deterministic tool call, then writes the
// per-intent aidlc-state.md (the State-Version-7 template) and appends a fixed
// audit event sequence (per-clone shard). The Bash tool_result carries the birth
// stdout bytes; the files land in the born intent's record. We assert on both.
//
// ASSERTION MAP (.sh test -> SDK surface; literal cited from the SHIPPED handler):
//   1 aidlc-state.md exists            -> existsSync(recordDirOf(proj)/aidlc-state.md) on disk
//   2 audit shard exists               -> the born record's audit/ shard dir holds a *.md shard
//   3 state has "State Version.*: 7$"  -> assertStateField(r,"State Version","7")  (birth template)
//   3 state has Worktree Path field    -> readStateField(...,"Worktree Path") !== undefined
//   3 state has Bolt Refs field        -> readStateField(...,"Bolt Refs") !== undefined
//   3 state has Practices Affirmed ...  -> readStateField(...,"Practices Affirmed Timestamp") !== undefined
//   4 "[x] workspace-scaffold"          -> state file contains "[x] workspace-scaffold" (init marker)
//   5 "[x] workspace-detection"         -> state file contains "[x] workspace-detection"  (init phase always [x])
//   6 "[x] state-init"                  -> state file contains "[x] state-init"
//   7 knowledge/ directory exists       -> statSync(aidlc/spaces/default/knowledge).isDirectory()
//                                          (SPACE-level domain-knowledge dir, ensureWorkspaceDirs → knowledgeDir)
//
// STRENGTHENINGS over the .sh (equal-or-stronger, never weaker):
//   - The birth CLI actually RAN: assertToolResultContains(r,"Bash",<verbatim summary>)
//     proves the deterministic tool fired and its fixed stdout reached us
//     ("Intent born:" / "State initialized:" / "Project type:", utility.ts:2374-2382) —
//     the .sh only checked the *side effects*, never that the dispatch went via
//     the tool. assertToolResultContains refuses to pass vacuously if Bash never
//     fired (assert.ts:44), so this also guards against a prose-only run.
//   - Birth audit events: the birth handler emits WORKFLOW_STARTED (utility.ts:2065),
//     WORKSPACE_SCAFFOLDED (:2110), WORKSPACE_INITIALISED (:2331) and per-init-stage
//     STAGE_COMPLETED. The .sh asserted audit EXISTS but never its content; we
//     assert the named events — a stronger statement of WHY the audit grew.
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - birth dispatch:         engine NAMES `intent-birth --scope <scope>` (aidlc-orchestrate.ts:302), conductor runs it
//   - birth stdout anchors:   "Intent born:" / "State initialized:" / "Project type:" (utility.ts:2374-2382)
//   - State Version value:    "7"  (birth template)
//   - 3 new state fields:     Worktree Path / Bolt Refs / Practices Affirmed Timestamp
//   - init-stage [x] markers: "[x] <slug>" for the 3 initialization stages, always EXECUTE/[x]
//   - birth audit events:     WORKFLOW_STARTED / WORKSPACE_SCAFFOLDED / WORKSPACE_INITIALISED (utility.ts:2065/2110/2331)
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.

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

// P4: birth writes the workflow record PER-INTENT under
// aidlc/spaces/<space>/intents/<slug>-<id8>/ (state, audit/ shards, per-phase
// dirs), NOT the flat aidlc-docs/. (Domain knowledge is SPACE-level — a sibling
// of intents at aidlc/spaces/<space>/knowledge/, not in the record.) Resolve the
// born record from the
// active-space + active-intent cursors (flat fallback for a not-yet-born project).
// Mirrors sdk-drive's recordDirFor and tests/integration/t-custom-harness-compile.ts.
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

// ---------------------------------------------------------------------------
// Timeout budget — honour the suite's AIDLC_TEST_TIMEOUT convention (seconds).
// A full birth turn (scan + state-init + audit) on Opus/Bedrock
// takes minutes; the .sh ran under the suite default. The driver's own abort
// fires ~15s before bun's per-test cap so a stuck canUseTool surfaces a partial
// DriveResult to diagnose rather than an opaque hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer literals from the SHIPPED birth handler (see header for file:line).
// The verbatim birth-CLI stdout block (Bash stdout, printed verbatim by the
// conductor). Two anchors from the fixed stdout (utility.ts:2374-2382) — proving
// the deterministic tool fired, not the LLM's prose. (The old "(team knowledge —
// 11 agent dirs + aidlc-shared)" scaffold-tree line was a --init artifact and is
// GONE; birth prints the intent-born + state-init block instead.)
const BIRTH_INTENT_LINE = "Intent born:"; // utility.ts:2375
const INIT_STATE_SUMMARY = "State initialized:"; // utility.ts:2376
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
// The 3 initialization-phase stages — always [x] in the freshly written state
// file (init phase marker is unconditionally "[x]").
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

describe("t21 /aidlc workflow birth (sdk)", () => {
  // -------------------------------------------------------------------------
  // First-run birth from a project with NO aidlc-docs/ (--no-aidlc-docs, as the
  // .sh seeded). Naming a scope on the empty workspace births the first intent.
  // Re-expresses .sh tests 1-7 on the per-intent deterministic surfaces and adds
  // the birth CLI-ran proof + birth audit events.
  // -------------------------------------------------------------------------
  test(
    "birth writes the per-intent record + the State-Version-7 state file, and records its birth events",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        // Precondition: aidlc-docs/ truly absent and no intent record yet — a
        // clean birth on an empty workspace (NOT a migration; needsFlatMigration
        // is false with no flat state).
        expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);
        expect(existsSync(join(proj, "aidlc", "spaces", "default", "intents"))).toBe(false);

        const r = await driveAidlc('/aidlc --scope poc "build a todo app"', {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // STRENGTHENING: the deterministic birth CLI actually fired via Bash and
        // its verbatim stdout reached us. assertToolResultContains refuses to
        // pass vacuously if Bash never fired (assert.ts:44) — so this proves the
        // birth path RAN through the tool, not that prose merely mentioned it.
        assertToolResultContains(r, "Bash", BIRTH_INTENT_LINE);
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        // The born intent's record dir (resolved from the active cursors).
        const record = recordDirOf(proj);

        // .sh test 1: aidlc-state.md created (on disk, per-intent record).
        const statePath = join(record, "aidlc-state.md");
        expect(existsSync(statePath)).toBe(true);

        // .sh test 2: an audit shard was written under the born record's audit/.
        const auditDir = join(record, "audit");
        expect(existsSync(auditDir)).toBe(true);
        expect(readdirSync(auditDir).some((f) => f.endsWith(".md"))).toBe(true);

        // .sh test 3 (State Version.*: 7$): the state file's State Version field
        // equals exactly "7". Stronger than the .sh's anchored grep — an exact
        // field-value equality, read off disk via sdk-drive's per-intent state read.
        expect(r.stateFile).toBeDefined();
        assertStateField(r, "State Version", "7");

        // .sh test 3 (the 3 new fields present): the State-Version-7 template
        // adds Worktree Path / Bolt Refs / Practices Affirmed Timestamp. The .sh
        // grepped for the field LABELS (they are empty-valued at init), so we
        // assert the fields PARSE (present) rather than asserting an empty value.
        for (const field of [
          "Worktree Path",
          "Bolt Refs",
          "Practices Affirmed Timestamp",
        ]) {
          const present = readStateField(r.stateFile as string, field);
          expect(present).toBeDefined();
        }

        // .sh tests 4-6: the 3 initialization stages are marked complete in the
        // state file. The shipped marker line is `- [x] <slug> — EXECUTE`
        // (init phase marker is unconditionally [x]), so "[x] <slug>" is a
        // substring. Assert each independently — the substring presence of one
        // does not prove the others.
        for (const stage of INIT_STAGES) {
          expect(r.stateFile as string).toContain(`[x] ${stage}`);
        }

        // .sh test 7: knowledge/ directory created. statSync proves it is a
        // DIRECTORY, not merely a present path. Birth ensures the SPACE-level
        // domain-knowledge dir aidlc/spaces/<space>/knowledge/ (ensureWorkspaceDirs
        // → knowledgeDir, utility.ts) — a sibling of intents that accumulates
        // across every intent in the space, NOT a per-intent record subdir and
        // NOT the old flat aidlc-docs/knowledge/.
        const knowledgeDir = join(proj, "aidlc", "spaces", "default", "knowledge");
        expect(existsSync(knowledgeDir)).toBe(true);
        expect(statSync(knowledgeDir).isDirectory()).toBe(true);

        // STRENGTHENING: the birth handler's audit events. The .sh checked the
        // audit EXISTS (test 2) but never its content; assert the named events
        // the handler emits (WORKFLOW_STARTED utility.ts:2065, WORKSPACE_SCAFFOLDED
        // :2110, WORKSPACE_INITIALISED :2331) — a stronger statement of WHY the
        // audit shard exists and grew. (assertAuditEvent reads the born record's
        // per-clone shards via sdk-drive's readAuditEvents.)
        assertAuditEvent(r, "WORKFLOW_STARTED");
        assertAuditEvent(r, "WORKSPACE_SCAFFOLDED");
        assertAuditEvent(r, "WORKSPACE_INITIALISED");

        // The birth tool exited 0. The SDK driver intentionally aborts as soon
        // as the deterministic birth stdout lands, so the model cannot continue
        // into unrelated workflow execution after the birth contract is proven.
        const birthCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(INIT_STATE_SUMMARY),
        );
        expect(birthCall?.isError).toBe(false);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
