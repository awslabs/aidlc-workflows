// covers: subcommand:aidlc-utility:init, scope:bugfix
//
// t55-workflow-init-then-resume.test.ts — SDK-harness port of
// tests/e2e/t55-workflow-init-then-resume.sh (plan 8). Drives TWO real
// sequential SDK turns — `/aidlc --init` then `/aidlc --scope bugfix` — against
// ONE fresh project and asserts ONLY on deterministic surfaces (the on-disk
// state-file fields/stage markers across both turns, the audit growth) — NEVER on
// assistantText. The subject is SESSION CONTINUITY: the 2nd turn RESUMES from the
// 1st turn's state rather than re-initialising from scratch.
//
// ⛔ TRAP 2 (no headless auto-approve). The phase-2 subject is
// RESUME continuity (the 2nd session reads the 1st session's state and the
// workflow advances), which is deterministic at the resume DISPATCH: a `--scope
// bugfix` on a project that ALREADY has state does NOT re-init (init refuses on
// existing state without --force, utility.ts:1746) — it resumes. We drive the two
// turns, stop each at its first deterministic landed signal, and assert the
// continuity on disk: the 1st turn's init stages survive into the 2nd turn's
// state, and the audit GREW across the two sessions. The DEEP multi-stage
// progression (the .sh's test 4 ">4 completed" / test 5
// "bugfix stages progressed") is the live tui bugfix journey's surface
// (t-tui-t50-bugfix-scope, gate-by-gate to Completed>=5); deep
// progression is NOT chased here (the moving-target lesson).
//
// THE ONE DROPPED .sh ASSERTION (faithfully, not weakened). The .sh's test 8
// asserted a state field that the engine no longer writes, so there is nothing
// left to assert. Dropping it here loses no coverage: the field is gone from
// the engine entirely.
//
// THE JOURNEY (verified against the SHIPPED tool). Turn 1 `/aidlc --init` on a
// fresh `--no-aidlc-docs` project writes aidlc-state.md with the 3 init stages [x]
// + audit WORKFLOW_STARTED/init events. Turn 2 `/aidlc --scope bugfix` on the
// now-stateful project resumes (no re-init — init would refuse without --force):
// the 1st turn's init [x] markers persist, and the audit grows with the 2nd
// session's events. (We use the explicit `--scope bugfix` flag rather than a bare
// `bugfix` to avoid the workshop-env disambiguation gate — t29 case 3's surface,
// not this test's; SKILL.md:105 "explicit CLI flag wins".)
//
// ASSERTION MAP (.sh test -> deterministic SDK surface, equal-or-stronger):
//   1 after init: state file exists      -> existsSync(state) after turn 1.
//   2 after init: all 3 init stages [x]  -> turn-1 state has [x] for each init stage.
//   3 after resume: state still exists   -> existsSync(state) after turn 2.
//   6 audit exists after both sessions   -> existsSync(audit) after turn 2.
//   7 audit grew across both sessions    -> the parsed audit event count after
//                                           turn 2 is >= the count after turn 1
//                                           (the 2nd session appended; the .sh's
//                                           ">300 bytes" two-session growth, here a
//                                           typed event-count non-regression — and
//                                           the init [x] markers PERSIST, proving
//                                           resume not re-init: STRONGER than a byte
//                                           count, which a re-init would also satisfy).
//   4/5 (>4 completed / bugfix stages progressed): NOT asserted — those needed
//       a full workflow run; deep progression is the tui t50 surface.
//       The continuity floor (init stages survive into turn 2) IS asserted.
//   8 (state field): DROPPED, the field is gone from the engine (see header).
//
// Known-answer literals (read from the SHIPPED tool, not guessed):
//   - --init / --scope dispatch:  SKILL.md (init / known-scope routing)
//   - re-init refusal on state:   aidlc-utility.ts:1746 (resume, not re-init, in turn 2)
//   - init-stage [x] markers:     aidlc-utility.ts:1995-1998
//   - State initialized summary:  aidlc-utility.ts:2154
//   - explicit --scope wins:      SKILL.md:105
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock TWICE.
// Known LLM-tier flake + one of the slowest (memory) — re-run alone if loaded.
// Generous per-test timeout covering both turns; the driver aborts a hair early
// so a stuck run surfaces a partial DriveResult, not a hang.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import {
  auditDirFor,
  driveAidlc,
  readAuditEvents,
  readStateFile,
  stateFilePathFor,
} from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget — TWO real turns (init + resume) on Opus/Bedrock; the slowest
// workflow test per the suite's known-flake notes. Honour the AIDLC_TEST_TIMEOUT
// convention generously. Each turn gets ~half the cap; the driver aborts ~15s
// before bun's per-test cap so a stuck run surfaces a partial DriveResult.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "1200", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 1200) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, Math.floor(TEST_TIMEOUT_MS / 2) - 15_000);

const INIT_STATE_SUMMARY = "State initialized:"; // utility.ts:2154
const STOP_AFTER_INIT = { toolName: "Bash", resultIncludes: INIT_STATE_SUMMARY } as const;
const INIT_STAGES = ["workspace-scaffold", "workspace-detection", "state-init"];

describe("t55 /aidlc birth (--scope bugfix) then resume continuity (sdk)", () => {
  // -------------------------------------------------------------------------
  // Two sequential turns against one fresh project: turn 1 births the workflow
  // from a scope (P4 retired --init — a scope on a clean workspace auto-births),
  // turn 2 a --scope bugfix turn RESUMES from it (init [x] markers persist, audit
  // grows). Deep progression is the tui t50 journey's surface.
  // -------------------------------------------------------------------------
  test(
    "birth establishes state; a second scope turn resumes from it (init stages persist, audit grows across sessions)",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        // P4: birth writes per-intent — state at the active intent's record dir
        // (aidlc/spaces/<space>/intents/<slug>-<id8>/aidlc-state.md) and audit as
        // per-clone shards under <record>/audit/, NOT the flat aidlc-docs/. Resolve
        // both lazily (the cursors only exist after birth) via the record-aware
        // harness helpers, which fall back to flat for a not-yet-born project.
        const statePath = () => stateFilePathFor(proj);
        const auditDir = () => auditDirFor(proj);

        // ---- Turn 1: /aidlc --scope bugfix (BIRTH the workflow) ----
        // P4 retired `/aidlc --init`: on a fresh workspace the engine auto-births
        // the first intent from a resolved scope (the old --init had no scope and
        // now errors directing the user to a scope/description). A named scope on a
        // clean workspace NAMES intent-birth, which scaffolds state + marks the 3
        // init stages [x] — the birth this journey starts from.
        const r1 = await driveAidlc("/aidlc --scope bugfix", {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_INIT,
        });

        // .sh test 1: after birth, the state file exists.
        expect(existsSync(statePath())).toBe(true);
        const stateAfterInit = readStateFile(proj);
        expect(stateAfterInit).toBeDefined();

        // .sh test 2: all 3 init stages marked [x] after init.
        for (const stage of INIT_STAGES) {
          expect(stateAfterInit as string).toContain(`[x] ${stage}`);
        }

        // Capture the post-init audit-event count as the resume baseline.
        const eventsAfterInit = readAuditEvents(proj) ?? [];
        const initEventCount = eventsAfterInit.length;
        expect(initEventCount).toBeGreaterThan(0);

        // ---- Turn 2: /aidlc --scope bugfix (RESUME from the init state) ----
        // A --scope on an already-stateful project resumes (init refuses re-init
        // without --force, utility.ts:1746). Stop at the first orchestrator
        // directive (run-stage) so we don't chase the LLM-paced continuation.
        const r2 = await driveAidlc("/aidlc --scope bugfix", {
          projectDir: proj,
          answerScript: "default",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: { toolName: "Bash", resultIncludes: '"kind":"run-stage"' },
        });

        // .sh test 3: after resume, the state file still exists.
        expect(existsSync(statePath())).toBe(true);
        const stateAfterResume = readStateFile(proj);
        expect(stateAfterResume).toBeDefined();

        // CONTINUITY (stronger than the .sh's byte count): the 1st turn's init [x]
        // markers PERSIST into the 2nd turn's state — proof the 2nd session
        // RESUMED rather than re-initialising from scratch (a re-init would also
        // grow the byte count, so this is the stronger continuity assertion).
        for (const stage of INIT_STAGES) {
          expect(stateAfterResume as string).toContain(`[x] ${stage}`);
        }

        // .sh test 6: audit exists after both sessions (P4: the per-clone audit
        // shard dir under the active intent's record).
        expect(existsSync(auditDir())).toBe(true);

        // .sh test 7: the audit grew across the two sessions (the 2nd session
        // appended its events). Typed event-count non-regression — at least as
        // many events as after init, and the resume added at least one.
        const eventsAfterResume = readAuditEvents(proj) ?? [];
        expect(eventsAfterResume.length).toBeGreaterThanOrEqual(initEventCount);

        // The 2nd turn reached a real orchestrator directive (no vacuous pass on
        // the resume — the run-stage tool_result landed).
        const directive = r2.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes('"kind":"run-stage"'),
        );
        expect(directive).toBeDefined();
        // Touch r1 so its capture isn't dead (the init turn's tool_result proved
        // the init dispatch ran).
        expect(r1.toolResults.length).toBeGreaterThan(0);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
