// covers: subcommand:aidlc-utility:init
//
// t21.test.ts — SDK-harness port of tests/integration/t21-integration-init.sh
// (plan 10). Drives the real `/aidlc --init` through the Claude Agent SDK and
// asserts ONLY on deterministic surfaces: the verbatim init-CLI stdout in the
// Bash tool_result, the on-disk aidlc-docs/ tree, the state-file fields, and
// the audit events. NEVER on assistantText.
//
// WHY THIS PORT EXISTS. The .sh asserted by stat-ing files / grepping the
// state file on disk — those checks were ALREADY deterministic (no prose grep,
// unlike t20/t22). The port preserves that deterministic discipline and
// strengthens it: every .sh file/grep assertion is re-expressed on disk after
// a real driveAidlc("/aidlc --init") run, and we ADD audit-event assertions the
// .sh never made (the init handler's birth events), reaching equal-or-stronger
// parity. The dispatch is gate-free: SKILL.md:531 resolves scope deterministically
// (no --scope given -> the init handler defaults to `poc`, aidlc-utility.ts:1720),
// so no AskUserQuestion fires for a bare `--init` — the default answerScript is
// never exercised. (t21b — the --force / idempotency target — is a SEPARATE port.)
//
// THE DETERMINISTIC SURFACE. `/aidlc --init` runs
//   `bun .claude/tools/aidlc-utility.ts init --scope <scope> ...`
// via Bash and prints its stdout VERBATIM (SKILL.md:531). handleInit
// (aidlc-utility.ts:1716) does the scaffold + scan + state-init in one
// deterministic tool call, then writes aidlc-state.md (the State Version 7
// template, utility.ts:2044-2097) and appends a fixed audit event sequence.
// The Bash tool_result carries the init stdout bytes; the files land on disk
// in <proj>/aidlc-docs/. We assert on both.
//
// ASSERTION MAP (.sh test -> SDK surface; literal cited from the SHIPPED handler):
//   1 aidlc-state.md exists            -> existsSync(<proj>/aidlc-docs/aidlc-state.md) on disk
//                                         (writeStateFile, utility.ts:2099; path aidlc-lib.ts:137)
//   2 audit.md exists                  -> existsSync(<proj>/aidlc-docs/audit.md) on disk
//                                         (header bootstrap utility.ts:1773; path aidlc-lib.ts:141)
//   3 state has "State Version.*: 7$"  -> assertStateField(r,"State Version","7")  (template utility.ts:2051)
//   3 state has Worktree Path field    -> readStateField(...,"Worktree Path") !== undefined (utility.ts:2053)
//   3 state has Bolt Refs field        -> readStateField(...,"Bolt Refs") !== undefined (utility.ts:2054)
//   3 state has Practices Affirmed ...  -> readStateField(...,"Practices Affirmed Timestamp") !== undefined (utility.ts:2055)
//   4 "[x] workspace-scaffold"          -> state file contains "[x] workspace-scaffold" (init marker, utility.ts:1995-1998)
//   5 "[x] workspace-detection"         -> state file contains "[x] workspace-detection"  (same line, init phase always [x])
//   6 "[x] state-init"                  -> state file contains "[x] state-init"
//   7 knowledge/ directory exists       -> statSync(<proj>/aidlc-docs/knowledge).isDirectory() (mkdir utility.ts:1842)
//
// STRENGTHENINGS over the .sh (equal-or-stronger, never weaker):
//   - The init CLI actually RAN: assertToolResultContains(r,"Bash",<verbatim summary>)
//     proves the deterministic tool fired and its fixed stdout reached us
//     ("State initialized:" / the scaffold tree block, utility.ts:2142-2150) —
//     the .sh only checked the *side effects*, never that the dispatch went via
//     the tool. assertToolResultContains refuses to pass vacuously if Bash never
//     fired (assert.ts:44), so this also guards against a prose-only run.
//   - Birth audit events: the init handler emits WORKFLOW_STARTED (utility.ts:1780),
//     WORKSPACE_SCAFFOLDED (:1896), WORKSPACE_INITIALISED (:2101) and per-init-stage
//     STAGE_COMPLETED. The .sh asserted audit.md EXISTS but never its content; we
//     assert the named events — a stronger statement of WHY the file grew.
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - --init dispatch:        SKILL.md:531  -> `bun .claude/tools/aidlc-utility.ts init ...` via Bash, stdout verbatim
//   - scaffold-tree line:     "aidlc-docs/knowledge/" + "(team knowledge — 11 agent dirs + aidlc-shared)" (utility.ts:2143)
//   - state-init summary:     "State initialized:" (utility.ts:2150)
//   - State Version value:    "7"  (utility.ts:2051)
//   - 3 new state fields:     Worktree Path / Bolt Refs / Practices Affirmed Timestamp (utility.ts:2053-2055)
//   - init-stage [x] markers: "[x] <slug>" for the 3 initialization stages, always EXECUTE/[x] (utility.ts:1995-1998)
//   - birth audit events:     WORKFLOW_STARTED / WORKSPACE_SCAFFOLDED / WORKSPACE_INITIALISED (utility.ts:1780/1896/2101)
//
// It SPENDS TOKENS — each driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.

import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
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

// ---------------------------------------------------------------------------
// Timeout budget — honour the suite's AIDLC_TEST_TIMEOUT convention (seconds).
// A full --init turn (scaffold + scan + state-init + audit) on Opus/Bedrock
// takes minutes; the .sh ran under the suite default. The driver's own abort
// fires ~15s before bun's per-test cap so a stuck canUseTool surfaces a partial
// DriveResult to diagnose rather than an opaque hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer literals from the SHIPPED init handler (see header for file:line).
// The verbatim init-CLI summary block (Bash stdout, printed verbatim per
// SKILL.md:531). Two anchors from the fixed stdout — proving the deterministic
// tool fired, not the LLM's prose.
const INIT_SCAFFOLD_LINE = "(team knowledge — 11 agent dirs + aidlc-shared)"; // utility.ts:2143
const INIT_STATE_SUMMARY = "State initialized:"; // utility.ts:2150
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
// The 3 initialization-phase stages — always [x] in the freshly written state
// file (utility.ts:1995-1998: init phase marker is unconditionally "[x]").
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

describe("t21 /aidlc --init (sdk)", () => {
  // -------------------------------------------------------------------------
  // First-run init from a project with NO aidlc-docs/ (--no-aidlc-docs, as the
  // .sh seeded). Re-expresses .sh tests 1-7 on deterministic surfaces and adds
  // the init CLI-ran proof + birth audit events.
  // -------------------------------------------------------------------------
  test(
    "init scaffolds the aidlc-docs/ tree, writes the State-Version-7 state file, and records its birth events",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        // Precondition: aidlc-docs/ truly absent, so the scaffold genuinely
        // builds it (mirrors the .sh's --no-aidlc-docs setup).
        expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);

        const r = await driveAidlc("/aidlc --init", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // STRENGTHENING: the deterministic init CLI actually fired via Bash and
        // its verbatim stdout reached us. assertToolResultContains refuses to
        // pass vacuously if Bash never fired (assert.ts:44) — so this proves the
        // --init path RAN through the tool, not that prose merely mentioned it.
        assertToolResultContains(r, "Bash", INIT_SCAFFOLD_LINE);
        assertToolResultContains(r, "Bash", INIT_STATE_SUMMARY);

        // .sh test 1: aidlc-state.md created (on disk).
        const statePath = join(proj, "aidlc-docs", "aidlc-state.md");
        expect(existsSync(statePath)).toBe(true);

        // .sh test 2: audit.md created (on disk).
        const auditPath = join(proj, "aidlc-docs", "audit.md");
        expect(existsSync(auditPath)).toBe(true);

        // .sh test 3 (State Version.*: 7$): the state file's State Version field
        // equals exactly "7". Stronger than the .sh's anchored grep — an exact
        // field-value equality, read off disk via sdk-drive's state read.
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
        // (utility.ts:1998; init phase marker is unconditionally [x] at :1995),
        // so "[x] <slug>" is a substring. Assert each independently — the
        // substring presence of one does not prove the others.
        for (const stage of INIT_STAGES) {
          expect(r.stateFile as string).toContain(`[x] ${stage}`);
        }

        // .sh test 7: knowledge/ directory created. statSync proves it is a
        // DIRECTORY, not merely a present path (mkdir utility.ts:1842).
        const knowledgeDir = join(proj, "aidlc-docs", "knowledge");
        expect(existsSync(knowledgeDir)).toBe(true);
        expect(statSync(knowledgeDir).isDirectory()).toBe(true);

        // STRENGTHENING: the init handler's birth audit events. The .sh checked
        // audit.md exists (test 2) but never its content; assert the named
        // events the handler emits (WORKFLOW_STARTED utility.ts:1780,
        // WORKSPACE_SCAFFOLDED :1896, WORKSPACE_INITIALISED :2101) — a stronger
        // statement of WHY the audit file exists and grew.
        assertAuditEvent(r, "WORKFLOW_STARTED");
        assertAuditEvent(r, "WORKSPACE_SCAFFOLDED");
        assertAuditEvent(r, "WORKSPACE_INITIALISED");

        // The init tool exited 0. The SDK driver intentionally aborts as soon
        // as the deterministic init stdout lands, so the model cannot continue
        // into unrelated workflow execution after the init contract is proven.
        const initCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(INIT_STATE_SUMMARY),
        );
        expect(initCall?.isError).toBe(false);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
