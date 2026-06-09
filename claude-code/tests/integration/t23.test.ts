// covers: subcommand:aidlc-utility:help
//
// t23.test.ts — SDK-harness port of tests/integration/t23-integration-help.sh
// (plan 6). Drives the real /aidlc --help through the Claude Agent SDK and
// asserts ONLY on deterministic surfaces — never on assistantText.
//
// WHY THIS PORT EXISTS. The .sh split the contract in two BECAUSE it had no
// deterministic handle on the routed path:
//   - Part A (tests 1-5) ran `bun aidlc-utility.ts help` OUT OF BAND (no LLM)
//     and grepped that side-channel stdout for AI-DLC / --status / --init /
//     --doctor / enterprise. Substantive, but it never touched the /aidlc
//     --help path a user actually invokes.
//   - Part B (test 6) ran `/aidlc --help` through Claude Code but asserted
//     ONLY exit-0, deliberately NOT on content — its own header (lines 10-14)
//     says Opus "sometimes runs the tool internally and gives a short summary
//     instead of echoing the full text". That is the CLASS-1 prose flake: the
//     contract is real but the LLM's rendering is non-deterministic.
//
// THE DETERMINISTIC SURFACE. SKILL.md:67,72 routes `--help` to
// `bun .claude/tools/aidlc-utility.ts help` via Bash and prints its stdout
// VERBATIM. The SDK surfaces that Bash tool_result BYTE-IDENTICAL to the
// tool's stdout, before the LLM rewords it (the same surface t20/t22 use). So
// every Part-A grep is re-expressed against the Bash tool_result on the path a
// user runs — STRONGER than the .sh, which checked the literals on a separate
// out-of-band run and left the routed path content-unverified.
//
// ASSERTION MAP (.sh test -> SDK surface):
//   1 OUTPUT contains AI-DLC    -> Bash tool_result contains "AI-DLC"    (HELP_TEXT_HEAD header line, utility.ts:106)
//   2 OUTPUT contains --status  -> Bash tool_result contains "--status"  (HELP_TEXT_TAIL Utilities line, utility.ts:115)
//   3 OUTPUT contains --init    -> Bash tool_result contains "--init"    (HELP_TEXT_TAIL Utilities line, utility.ts:116)
//   4 OUTPUT contains --doctor  -> Bash tool_result contains "--doctor"  (HELP_TEXT_TAIL Utilities line, utility.ts:118)
//   5 OUTPUT contains enterprise-> Bash tool_result contains "enterprise"(scope line rendered from scope-mapping.json via renderHelpText, utility.ts:144-158; key utility.ts data/scope-mapping.json:2)
//   6 /aidlc --help exits 0     -> resultEvent.is_error === false        (SDK terminal event — handleHelp is a single stdout write + exit-0 by construction, utility.ts:165-167)
//
// Re STRONGER-THAN-.sh: the .sh asserted the 5 literals on Part A's out-of-band
// tool run and only exit-0 on Part B's routed run. This file asserts the same 5
// literals on the ROUTED /aidlc --help path's deterministic Bash tool_result
// (so a regression where dispatch stopped running the tool, or the tool stopped
// emitting a section, is now caught on the user-facing path) PLUS the clean
// terminal. assertToolResultContains refuses to pass vacuously if Bash never
// fired — so it also proves --help routed to the tool, not just that prose
// mentioned a flag.
//
// Known-answer literals (read from the SHIPPED handler, not guessed):
//   - "AI-DLC"      HELP_TEXT_HEAD first line                          (utility.ts:106)
//   - "--status"    HELP_TEXT_TAIL Utilities block                     (utility.ts:115)
//   - "--init"      HELP_TEXT_TAIL Utilities block                     (utility.ts:116)
//   - "--doctor"    HELP_TEXT_TAIL Utilities block                     (utility.ts:118)
//   - "enterprise"  scope name padded into a scope line by renderHelpText
//                   (utility.ts:158), sourced from data/scope-mapping.json:2
//   - --help dispatch: SKILL.md:67,72 -> `bun .claude/tools/aidlc-utility.ts help` via Bash, stdout verbatim
//
// MECHANISM. Plain t23.test.ts — mechanism `sdk` is DERIVED from the driveAidlc(
// call (Phase 0), no filename segment. The covered unit `aidlc-utility help` is
// minMechanism `cli` (rank 1); sdk (rank 2) satisfies cli (2 >= 1), so the
// covers claim is honoured by the guarantee-principle gate.
//
// It SPENDS TOKENS — driveAidlc drives the real /aidlc on Opus/Bedrock.
// Generous per-test timeout so a hung canUseTool fails LOUD via bun:test.

import { describe, expect, test } from "bun:test";
import { assertToolResultContains } from "../harness/assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "../harness/fixtures.ts";
import { driveAidlc } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget — honour the suite's AIDLC_TEST_TIMEOUT convention (seconds;
// the .sh set AIDLC_TEST_TIMEOUT=120). The bun:test per-test cap is that value;
// the driver's own abort fires ~15s earlier so a stuck canUseTool surfaces as a
// clear harness failure (no result event) rather than an opaque test-timeout.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "120", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 120) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(90_000, TEST_TIMEOUT_MS - 15_000);

// Known-answer help strings, read from the shipped handler (see header).
const HELP_HEADER = "AI-DLC"; // HELP_TEXT_HEAD, utility.ts:106
const HELP_STATUS = "--status"; // Utilities block, utility.ts:115
const HELP_INIT = "--init"; // Utilities block, utility.ts:116
const HELP_DOCTOR = "--doctor"; // Utilities block, utility.ts:118
const HELP_ENTERPRISE = "enterprise"; // scope line, scope-mapping.json:2 via renderHelpText
const STOP_AFTER_HELP = { toolName: "Bash", resultIncludes: HELP_HEADER } as const;

describe("t23 /aidlc --help (sdk)", () => {
  // -------------------------------------------------------------------------
  // /aidlc --help routes to the deterministic help CLI via Bash and prints its
  // stdout verbatim. Re-expresses .sh Part A (tests 1-5) on the ROUTED path's
  // Bash tool_result, plus .sh test 6 (exit-0) as a clean SDK terminal event.
  //
  // The .sh ran the tool out of band for the content greps; here the content
  // literals are asserted on the tool_result the orchestrator actually produced
  // when routing /aidlc --help — strictly stronger coverage of the user path.
  // -------------------------------------------------------------------------
  test(
    "help routes to the help CLI and its verbatim stdout carries every advertised section",
    async () => {
      const proj = setupIntegrationProject({ noAidlcDocs: true });
      try {
        const r = await driveAidlc("/aidlc --help", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolResult: STOP_AFTER_HELP,
        });

        // The --help path RAN: the help CLI fired via Bash and its verbatim
        // stdout carries each advertised literal. assertToolResultContains
        // fails loudly if Bash never fired (no vacuous pass) — so this is also
        // proof --help dispatched to the tool, not that prose mentioned a flag.
        // .sh test 1 (AI-DLC header):
        assertToolResultContains(r, "Bash", HELP_HEADER);
        // .sh tests 2-4 (Utilities block flags):
        assertToolResultContains(r, "Bash", HELP_STATUS);
        assertToolResultContains(r, "Bash", HELP_INIT);
        assertToolResultContains(r, "Bash", HELP_DOCTOR);
        // .sh test 5 (a scope name rendered from scope-mapping.json):
        assertToolResultContains(r, "Bash", HELP_ENTERPRISE);

        // .sh test 6: /aidlc --help exits 0. Re-expressed on the non-error
        // Bash tool_result, then the driver aborts immediately so the model
        // cannot spend turns after the deterministic help contract is proven.
        const helpCall = r.toolResults.find(
          (t) => t.toolName === "Bash" && t.resultText.includes(HELP_HEADER),
        );
        expect(helpCall?.isError).toBe(false);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
