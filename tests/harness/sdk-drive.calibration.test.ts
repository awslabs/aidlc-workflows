// sdk-drive.calibration.test.ts — KNOWN-ANSWER calibration of the SDK harness.
//
// This file calibrates the just-built measuring instrument (tests/harness/
// sdk-drive.ts + assert.ts + fixtures.ts) against planted truths the driver
// MUST report exactly. It is the trust anchor for every sdk-mechanism test
// above it: if a calibration here cannot confirm the planted truth, the whole
// SDK E2E tier is untrustworthy.
//
// It SPENDS TOKENS — it drives the real /aidlc through the Claude Agent SDK
// (SDK 0.3.158, Opus on Bedrock; env inherited from the sandbox). Each test
// carries a generous per-test timeout so a hung canUseTool fails LOUD (the
// bun:test timeout fires) rather than hanging the runner forever.
//
// The four calibrations (assignment IDs in comments):
//   1. canUseTool fires for AskUserQuestion          (sdk-drive-canusetool)
//   2. tool_result is BYTE-IDENTICAL to tool stdout   (sdk-drive-toolresult-byte-identity)
//   3. a SCRIPTED non-default answer reaches the model(sdk-drive-scripted-answer)
//   4. assertToolResultContains FAILS when the tool was absent (guard, no vacuous pass)
//
// Calibrations 1-3 assert ONLY on deterministic surfaces: the structured
// AskUserQuestion the driver captured (askedQuestions), the verbatim Bash
// tool_result bytes (toolResults), and the on-disk state file the chosen
// branch wrote (stateFile). Never on assistantText.

import { describe, expect, test } from "bun:test";
import {
  assertAskedQuestion,
  assertToolResultContains,
} from "./assert.ts";
import {
  cleanupTestProject,
  setupIntegrationProject,
} from "./fixtures.ts";
import {
  type CapturedToolResult,
  type DriveResult,
  driveAidlc,
} from "./sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget. A multi-tool /aidlc turn on Opus/Bedrock can take minutes.
// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; see the t2x
// integration tests, which set it to 600 for doctor/jump). The bun:test
// per-test cap is that value; the driver's own abort fires a hair earlier so a
// stuck canUseTool surfaces as a clear harness failure (no result event) and
// not as a 0-byte hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;
// Drive aborts ~15s before bun kills the test, so we still capture a partial
// DriveResult to assert against / diagnose, rather than an opaque test-timeout.
const DRIVE_TIMEOUT_MS = Math.max(60_000, TEST_TIMEOUT_MS - 15_000);

// ---------------------------------------------------------------------------
// CALIBRATION 2 known-answer strings — read from the SHIPPED doctor handler so
// they are REAL, not guessed. Source: dist/claude/.claude/tools/
// aidlc-utility.ts handleDoctor():
//   - header literal:           "AI-DLC Health Check\n"            (utility.ts:1355)
//   - separator rule:           "─".repeat(37)                (utility.ts:1356)
//   - check #1 label:           "bun installed (required ...)"     (utility.ts:336)
//   - hook label shape:         "<hook>.ts present"                (utility.ts:356, hooks :343-351)
//   - settings label:           "settings.json present"           (utility.ts:365)
//   - aidlc-docs label:         "aidlc-docs/ directory exists"     (utility.ts:396)
// The spike's aidlc-sdk-toolout-probe.ts proved these exact strings appear in
// the tool_result (and unreliably in prose) — we re-prove it through the driver.
// ---------------------------------------------------------------------------
const DOCTOR_HEADER = "AI-DLC Health Check";
const DOCTOR_RULE = "─".repeat(37); // 37 box-drawing horizontals
const DOCTOR_BUN_LABEL = "bun installed (required for CLI tools and hooks)";
const DOCTOR_HOOK_LABEL = "aidlc-audit-logger.ts present";
const DOCTOR_SETTINGS_LABEL = "settings.json present";
const DOCTOR_DOCS_LABEL = "aidlc-docs/ directory exists";

// ---------------------------------------------------------------------------

describe("sdk-drive calibration (known-answer)", () => {
  // -------------------------------------------------------------------------
  // CALIBRATION 1 — canUseTool fires for AskUserQuestion.
  //   harness-instrument:sdk-drive-canusetool
  //
  // Planted truth: a seeded in-progress workflow + /aidlc --resume MUST pose
  // the resume gate (an AskUserQuestion), and the driver's canUseTool MUST
  // answer it (capturing it in askedQuestions) — NOT let it be auto-denied the
  // way headless `claude -p` does. This is a boundary smoke, not a workflow
  // drive: stopAfterAskUserQuestion returns immediately after the first gate is
  // captured/answered so a fixture mismatch cannot turn the calibration into a
  // long live stage run.
  // -------------------------------------------------------------------------
  test(
    "1. canUseTool answers the AskUserQuestion gate (not auto-denied)",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const r = await driveAidlc("/aidlc --resume", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterAskUserQuestion: true,
        });

        // The resume gate must have been captured. If canUseTool never fired
        // (or the gate was denied), askedQuestions would be empty here.
        expect(r.askedQuestions.length).toBeGreaterThanOrEqual(1);

        // Prove WHICH gate fired without scraping the TUI: the first menu is
        // the resume gate. assertAskedQuestion fails loudly if absent.
        assertAskedQuestion(r, "proceed");

        // The driver records the answer it handed back to the SDK. For a
        // captured-and-answered gate this is a real option label, not empty —
        // that is the positive proof the question was ANSWERED, not denied.
        const firstMenu = r.askedQuestions[0];
        const handedBack = Object.values(firstMenu.answers);
        expect(handedBack.length).toBeGreaterThanOrEqual(1);
        for (const a of handedBack) {
          const asStr = Array.isArray(a) ? a.join("") : a;
          expect(asStr.length).toBeGreaterThan(0);
        }
        const askToolResult = r.toolResults.find(
          (t) => t.toolName === "AskUserQuestion",
        );
        expect(askToolResult).toBeDefined();
        // This is the headless `-p` auto-deny contrast: an answered gate
        // returns a non-error tool_result from AskUserQuestion.
        expect(askToolResult?.isError).toBe(false);

        // The default script takes option 1; the option the driver chose must
        // be one the menu actually offered (structure-resolved, never invented).
        const offered = firstMenu.questions[0].options.map((o) => o.label);
        const chosen = Object.values(firstMenu.answers)[0] as string;
        expect(offered).toContain(chosen);

      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // CALIBRATION 2 — tool_result is BYTE-IDENTICAL to the tool's stdout.
  //   harness-instrument:sdk-drive-toolresult-byte-identity
  //
  // Planted truth: /aidlc --doctor runs a deterministic bun tool whose stdout
  // is fixed bytes (the spike saw md5 553308ac... x3). The driver MUST surface
  // those exact bytes in toolResults — the tool's stdout, NOT the assistant's
  // prose rendering. We assert the literal strings (read from the shipped
  // doctor handler) AND verify the doctor block repeats byte-for-byte across
  // two runs (stability), the property that makes this assertable at all.
  // -------------------------------------------------------------------------
  test(
    "2. doctor tool_result carries the verbatim deterministic stdout (byte-identical, stable x2)",
    async () => {
      // Doctor is a read-only utility calibration. Keep the project minimal:
      // seeding an in-progress workflow invites the model to report completion
      // after printing doctor output, which correctly rejects because no gate is
      // awaiting approval. The planted truth here is the tool_result bytes.
      const projA = setupIntegrationProject();
      const projB = setupIntegrationProject();
      try {
        const rA = await driveAidlc("/aidlc --doctor", {
          projectDir: projA,
          timeoutMs: DRIVE_TIMEOUT_MS,
        });

        // The Bash tool must have actually been called AND its result must
        // contain the exact doctor strings. assertToolResultContains fails
        // loudly if Bash never fired (no vacuous pass) — see calibration 4.
        assertToolResultContains(rA, "Bash", DOCTOR_HEADER);
        assertToolResultContains(rA, "Bash", DOCTOR_RULE);
        assertToolResultContains(rA, "Bash", DOCTOR_BUN_LABEL);
        assertToolResultContains(rA, "Bash", DOCTOR_HOOK_LABEL);
        assertToolResultContains(rA, "Bash", DOCTOR_SETTINGS_LABEL);
        assertToolResultContains(rA, "Bash", DOCTOR_DOCS_LABEL);

        // Prove the content is the TOOL's bytes, not the assistant's prose
        // rendering: isolate the verbatim doctor block out of the Bash
        // tool_result and re-assert the structural shape on THOSE bytes.
        const blockA = extractDoctorBlock(rA);
        expect(blockA).not.toBeNull();
        // The block carries the box-rule and the "N passed, M failed" footer
        // verbatim — shape the LLM prose does not reliably reproduce.
        expect(blockA!).toContain(DOCTOR_RULE);
        expect(blockA!).toMatch(/\d+ passed, \d+ failed/);
        // The verbatim block uses the tool's ✓ check glyph + two spaces,
        // exactly as handleDoctor writes it (utility.ts:1361).
        expect(blockA!).toContain(`✓  ${DOCTOR_BUN_LABEL}`);

        // Stability: a second independent run must yield a byte-identical
        // doctor block (deterministic stdout). We compare from the header to
        // the footer so an LLM preamble/postamble around the tool_result does
        // not perturb the comparison; the tool bytes themselves must match.
        //
        // ONE line in the doctor stdout is intrinsically non-deterministic:
        // "Hooks last fired: session-start <ISO timestamp>" (utility.ts:430) —
        // the SessionStart hook re-stamps wall-clock time on every run, so the
        // timestamp legitimately differs run-to-run. That is a property of the
        // TOOL, not a defect of the instrument. We normalise that single line
        // out before comparing; every other byte (header, rule, all fixed
        // labels, counts, footer) must be identical. The structural asserts
        // above already prove the instrument carries the tool's verbatim bytes;
        // this proves it does so STABLY for the deterministic portion.
        const rB = await driveAidlc("/aidlc --doctor", {
          projectDir: projB,
          timeoutMs: DRIVE_TIMEOUT_MS,
        });
        const blockB = extractDoctorBlock(rB);
        expect(blockB).not.toBeNull();
        expect(normalizeHeartbeat(blockB!)).toBe(normalizeHeartbeat(blockA!));
      } finally {
        cleanupTestProject(projA);
        cleanupTestProject(projB);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // CALIBRATION 3 — a SCRIPTED non-default answer reaches the model.
  //   harness-instrument:sdk-drive-scripted-answer
  //
  // Planted truth: on a seeded in-progress workflow, /aidlc --resume poses the
  // resume gate. Its DEFAULT (option 1) is "Resume from last checkpoint". We
  // script the NON-default "Start fresh" option and stop immediately after the
  // AskUserQuestion tool_result arrives. That tool_result is the synthetic user
  // message handed back to the model, so its bytes prove the scripted answer
  // crossed the SDK boundary without letting the calibration continue into a
  // full live restart workflow.
  //
  // Why the resume gate and not the freeform scope-confirmation gate: the
  // resume menu's option SET is framework-fixed ("Resume / Redo / Jump / Start
  // fresh", SKILL.md:311-314) and appears stably run-to-run, whereas the
  // freeform scope-confirmation gate's ALTERNATIVE scopes are LLM-authored and
  // vary (a "security-patch" alternative is offered some runs, absent others —
  // observed empirically). A non-default calibration must target a guaranteed
  // option; otherwise `labelContains` correctly falls back to option 1 and the
  // calibration measures the LLM's menu-authoring whim, not the instrument.
  //
  // We use `sequence` (keyed on menu ORDER, fully deterministic) + the robust
  // `labelContains` spec, since the exact label wording is LLM-authored.
  // -------------------------------------------------------------------------
  test(
    "3. scripted non-default answer reaches the model via AskUserQuestion tool_result bytes",
    async () => {
      const proj = setupIntegrationProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const r = await driveAidlc("/aidlc --resume", {
          projectDir: proj,
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterAskUserQuestion: true,
          answerScript: {
            kind: "sequence",
            // Menu 1 (resume) -> "Start fresh" (non-default).
            specs: [{ labelContains: "Start fresh" }],
          },
        });

        // The resume gate must have fired and been answered (canUseTool path).
        expect(r.askedQuestions.length).toBe(1);

        // Menu 1: the non-default "Start fresh" option must be what was handed
        // to the model — proving the scripted answer reached it, NOT a silent
        // fallback to option 1 ("Resume from last checkpoint").
        const resumeMenu = r.askedQuestions[0];
        const resumeOffered = resumeMenu.questions[0].options.map(
          (o) => o.label,
        );
        const startFreshOpt = resumeOffered.find((l) =>
          l.includes("Start fresh"),
        );
        expect(startFreshOpt).toBeDefined();
        const resumeHanded = Object.values(resumeMenu.answers)[0] as string;
        expect(resumeHanded).toBe(startFreshOpt!);
        // It is NOT the default first option — the non-default truly drove.
        expect(resumeHanded).not.toBe(resumeOffered[0]);
        assertToolResultContains(r, "AskUserQuestion", startFreshOpt!);
      } finally {
        cleanupTestProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // CALIBRATION 4 — the guard: assertToolResultContains must FAIL when the
  // expected tool was never called. Proves the helper does not pass vacuously
  // against an empty/absent tool call — the failure mode that would let a
  // deleted behaviour slip through every test above it.
  //
  // This calibration spends NO tokens: it constructs a DriveResult with no
  // Bash call and asserts the helper throws. The expensive calibrations (1-3)
  // already proved the real-drive path; this isolates the guard logic.
  // -------------------------------------------------------------------------
  test("4. assertToolResultContains FAILS loudly when the tool was absent (no vacuous pass)", () => {
    // A run that called Skill but never Bash.
    const noBash: DriveResult = {
      toolResults: [
        {
          toolName: "Skill",
          input: {},
          toolUseId: "tu_1",
          resultText: "Launching skill: aidlc",
          isError: false,
        } satisfies CapturedToolResult,
      ],
      assistantText: "",
      resultEvent: undefined,
      askedQuestions: [],
      timedOut: false,
      stoppedAfterAskUserQuestion: false,
      stoppedAfterToolResult: false,
    };

    // Asserting on a tool that never fired MUST throw — not silently pass.
    expect(() =>
      assertToolResultContains(noBash, "Bash", DOCTOR_HEADER),
    ).toThrow(/expected tool "Bash" to be called/);

    // The fully-empty case must also throw (zero tool calls at all).
    const empty: DriveResult = {
      toolResults: [],
      assistantText: "",
      resultEvent: undefined,
      askedQuestions: [],
      timedOut: false,
      stoppedAfterAskUserQuestion: false,
      stoppedAfterToolResult: false,
    };
    expect(() =>
      assertToolResultContains(empty, "Bash", DOCTOR_HEADER),
    ).toThrow(/Refusing to pass vacuously/);

    // Positive control: when the tool DID fire with matching content, the
    // helper must NOT throw — proving the failure above is about absence, not a
    // helper that always throws.
    const withBash: DriveResult = {
      toolResults: [
        {
          toolName: "Bash",
          input: { command: "doctor" },
          toolUseId: "tu_2",
          resultText: `${DOCTOR_HEADER}\n${DOCTOR_RULE}\n`,
          isError: false,
        } satisfies CapturedToolResult,
      ],
      assistantText: "",
      resultEvent: undefined,
      askedQuestions: [],
      timedOut: false,
      stoppedAfterAskUserQuestion: false,
      stoppedAfterToolResult: false,
    };
    expect(() =>
      assertToolResultContains(withBash, "Bash", DOCTOR_HEADER),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helper: isolate the verbatim doctor stdout block out of the Bash
// tool_result(s). Slices from the "AI-DLC Health Check" header through the
// "N passed, M failed" footer so an LLM preamble/postamble around the
// tool_result cannot perturb the byte-stability comparison. Returns null if no
// Bash tool_result carries the header.
// ---------------------------------------------------------------------------
function extractDoctorBlock(result: DriveResult): string | null {
  for (const t of result.toolResults) {
    if (t.toolName !== "Bash") continue;
    const start = t.resultText.indexOf(DOCTOR_HEADER);
    if (start === -1) continue;
    const footer = t.resultText.match(/\d+ passed, \d+ failed/);
    if (!footer || footer.index === undefined) continue;
    const end = footer.index + footer[0].length;
    return t.resultText.slice(start, end);
  }
  return null;
}

// Replace the wall-clock timestamp on the "Hooks last fired" line with a fixed
// token so byte-stability can be asserted on the deterministic remainder. Only
// this line carries a per-run timestamp (utility.ts:430).
function normalizeHeartbeat(block: string): string {
  return block.replace(
    /(Hooks last fired:.*?)\d{4}-\d{2}-\d{2}T[\d:]+Z/g,
    "$1<TS>",
  );
}
