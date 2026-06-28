// covers: hook:aidlc-stop
//
// t187 - park + conversational carve-out (live SDK). The shipped end-to-end
// proof of the #365 / #366 / #367 park umbrella: drive a REAL agent through the
// Claude Agent SDK against the shipped dist and confirm a conductor that is
// asked to PAUSE the workflow for later parks it cleanly and ends its turn,
// instead of rubber-stamping the remaining stages to escape the forwarding-loop
// Stop hook.
//
// WHY a live test in addition to t122's deterministic e2e: t122 case (9) pins
// the REAL engine + REAL hook park transition with NO model in the loop (it
// spawns `aidlc-orchestrate park` by hand, then feeds the real hook). This pins
// the OTHER half: that a real conductor, told "pause this and resume later",
// actually REACHES for park (rather than batch-completing stages) and that the
// Stop hook then lets the turn end. The behavior under test is the conductor's
// CHOICE plus the hook's terminal `parked` allow, observed end to end.
//
// THE FIXTURE: state-final-stage.md seeded into the active intent's record, a
// Running workflow whose single remaining stage feedback-optimization is at [-]
// in-progress. On this exact fixture a plain `next` returns a PENDING run-stage
// (t122 case 4 proves the hook BLOCKS without a carve-out), so the only clean
// way to end the turn is `park`. That makes "the run ended cleanly" a real
// signal: if the conductor had merely quit, the hook would have re-fed the loop.
//
// HARNESS / GUARDED-ASSERTION NOTE (mirrors t122 case 3's GUARDED note and t183):
// the Stop hook firing under the headless SDK is non-deterministic (it may not
// fire on every run), so we do NOT assert on a hook block/allow event directly.
// Instead we assert on the OBSERVABLE on-disk + tool-output outcome of a park,
// which is stable whenever the conductor parks at all:
//   1. the conductor invoked park (a Bash toolResult whose input.command names
//      `aidlc-orchestrate.ts park`, OR a tool_result carrying a `parked`
//      directive / a WORKFLOW_PARKED audit row),
//   2. the state file gained Parked / Parked At Stage runtime markers,
//   3. NO new stage checkbox flipped to [x] (feedback-optimization is still [-]:
//      parking is an inter-stage pause, never a stage completion; the #367
//      rubber-stamp escape would have flipped it), and
//   4. the run ended cleanly (resultEvent is defined and not is_error), i.e. the
//      hook ALLOWED the turn to end rather than trapping it.
// We assert on toolResults (verbatim tool stdout) + resultEvent + on-disk state,
// NEVER on assistantText (the LLM's reworded prose). The driver writes an ndjson
// trace to tests/logs/<stamp>/sdk-drive-<pid>.ndjson when AIDLC_TEST_DEBUG=true.
//
// It SPENDS TOKENS: driveAidlc drives the real conductor on Opus/Bedrock. Gated
// PURELY on the claude CLI (calling driveAidlc marks the file SDK-dependent via
// claude-gate.ts; the runner skips-with-reason when claude is absent, never a
// hard fail). LIVE-SDK tier: runs on the integration tier behind the claude
// gate, NOT the fast deterministic tier.

import { describe, expect, test } from "bun:test";
import {
  cleanupTestProject,
  sedReplaceInFile,
  seededStateFile,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc, readStateField } from "../harness/sdk-drive.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "1200", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 1200) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(120_000, TEST_TIMEOUT_MS - 15_000);

// The single remaining stage in state-final-stage.md (feedback-optimization at
// [-]). The row literal carries a U+2014 em dash COPIED VERBATIM from the
// fixture (state-final-stage.md:86); it is load-bearing, the exact bytes the
// state file holds. We introduce NO other non-keyboard characters in this file.
const PENDING_STAGE = "feedback-optimization";
const PENDING_ROW = `- [-] ${PENDING_STAGE} — EXECUTE`;
const COMPLETED_ROW = `- [x] ${PENDING_STAGE} — EXECUTE`;

describe("t187 park + conversational carve-out (sdk): a conductor asked to pause parks cleanly and the turn ends", () => {
  test(
    "asked to pause for later, the conductor parks (Parked markers written, feedback-optimization still [-]) and the run ends cleanly",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-final-stage.md",
        withAudit: true,
      });
      try {
        // Point the seeded state at the real temp project so the engine + hook
        // resolve THIS workspace (mirrors t183's Project Root rewrite). The
        // fixture ships a placeholder absolute path on its Project Root line.
        sedReplaceInFile(
          seededStateFile(proj),
          "- **Project Root**: /home/user/projects/widget-app",
          `- **Project Root**: ${proj}`,
        );

        // Drive a real conductor with an explicit PAUSE instruction. We tell it
        // to pause and resume in a later session and NOT to complete or advance
        // any stage: the supported response is `park`. Default answer policy
        // (option 1) covers any gate the conductor might surface.
        // Lead with `/aidlc` so the conductor loads the orchestrator skill (the
        // SKILL.md that teaches `park`); a bare prose prompt leaves the model
        // outside conductor mode and it never discovers the park verb (it just
        // hand-edits state). This mirrors t183 / t122, which both drive `/aidlc`.
        const r = await driveAidlc(
          "/aidlc I need to step away. PAUSE this workflow so I can resume it in a " +
            "later session. Do NOT complete, advance, or mark any stage as done; " +
            "park it cleanly at the current point and then stop.",
          {
            projectDir: proj,
            timeoutMs: DRIVE_TIMEOUT_MS,
          },
        );

        // ASSERTION 1: the conductor reached for park. Accept any of the three
        // observable park signals (robust to the conductor's exact tool path):
        //   (a) a Bash tool call whose command names `aidlc-orchestrate.ts park`,
        //   (b) any tool_result whose verbatim stdout carries a `parked`
        //       directive (the engine/park output), or
        //   (c) a WORKFLOW_PARKED audit row appended during the run.
        const parkBash = r.toolResults.some(
          (t) =>
            (t.toolName === "Bash" || t.toolName === "Shell") &&
            /aidlc-orchestrate\.ts\b[\s\S]*\bpark\b/.test(
              String((t.input as Record<string, unknown>).command ?? ""),
            ),
        );
        const parkedDirective = r.toolResults.some(
          (t) => /"kind"\s*:\s*"parked"|\bparked\b.*resume/i.test(t.resultText),
        );
        const parkedAudit = (r.auditEvents ?? []).includes("WORKFLOW_PARKED");
        expect(
          parkBash || parkedDirective || parkedAudit,
          `expected a park signal (Bash park call, a parked directive, or a WORKFLOW_PARKED audit event). ` +
            `auditEvents=${JSON.stringify(r.auditEvents)} ` +
            `toolCommands=${JSON.stringify(
              r.toolResults.map((t) => ({
                name: t.toolName,
                cmd: String((t.input as Record<string, unknown>).command ?? "").slice(0, 160),
              })),
            )}`,
        ).toBe(true);

        // ASSERTION 2: park wrote the runtime markers. Read the live state file
        // off disk (deterministic, not paraphrased): park persists Parked +
        // Parked At Stage under Runtime State (aidlc-state.ts handlePark).
        const state = r.stateFile ?? "";
        expect(
          readStateField(state, "Parked"),
          `expected a Parked runtime marker in the state file after park; state head: ${state.slice(0, 400)}`,
        ).toBeDefined();
        expect(readStateField(state, "Parked At Stage")).toBe(PENDING_STAGE);

        // ASSERTION 3: park did NOT advance. The final stage stays [-]
        // in-progress and is NOT marked [x]. This is the #367 anti-rubber-stamp
        // contract: a parked workflow never flips a checkbox to escape the loop.
        expect(
          state,
          `feedback-optimization must remain [-]; the row must not have flipped to [x]`,
        ).toContain(PENDING_ROW);
        expect(state).not.toContain(COMPLETED_ROW);

        // ASSERTION 4: the run ended cleanly. resultEvent is defined and not an
        // error, proof the Stop hook ALLOWED the turn to end (the terminal
        // `parked` allow) rather than trapping it on the pending run-stage. The
        // park signal above plus a clean end together close the #365 loop.
        expect(
          r.resultEvent,
          "expected a terminal result event (the run ended rather than being trapped)",
        ).toBeDefined();
        expect(r.resultEvent?.is_error).toBe(false);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
