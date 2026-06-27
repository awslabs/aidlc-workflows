// covers: harness-instrument:preflight-health
//
// t19.test.ts — SDK-harness port of tests/integration/t19-preflight-health.sh
// (plan 4). The preflight gate: before the LLM-driven integration tiers run,
// prove the live substrate is healthy — claude on PATH, AWS creds valid, and a
// real driven turn completes with non-empty output. Driven through the Claude
// Agent SDK (the SAME live path the integration tier uses), asserting ONLY on
// deterministic surfaces (the resolved binaries, the AWS STS exit, the SDK
// terminal result event + its captured tool/text bytes) — NEVER on assistantText
// CONTENT (we assert the turn produced SOME output + completed, not WHAT it said).
//
// WHY THIS PORT EXISTS / mechanism. The .sh was a pure substrate probe: `command
// -v claude`, `aws sts get-caller-identity`, then `run_claude "echo ok"` and a
// non-empty-output check. It is NOT a framework-unit test — it instruments the
// HARNESS's own liveness, so it claims the non-enumerated namespace
// `harness-instrument:preflight-health` (the convention t55 /
// gen-coverage-registry.test.ts use: parseCoversHeader records a claim only when
// it matches an enumerated unit, so this benign namespace counts toward nothing
// and breaks no coverage ratchet). The `.sh`'s only stem-twin on the base,
// unit/t19.cli.test.ts, is a spawnSync arg-parse test on a DIFFERENT subject
// (TRAP 1) — it does NOT exercise the live preflight, so retiring t19.sh behind
// it would silently drop the live-substrate gate. This port drives the REAL SDK
// (driveAidlc) so the preflight checks the same substrate the sdk tier depends on.
//
// ASSERTION MAP (.sh test -> deterministic SDK surface):
//   1 claude CLI on PATH        -> the SDK query resolves + the run produces a
//                                  terminal result event (the SDK cannot drive a
//                                  turn at all without the claude substrate the
//                                  .sh's `command -v claude` gated on). We assert
//                                  resultEvent is defined AND not an error.
//   2 AWS credentials valid     -> `aws sts get-caller-identity` exits 0 (the
//                                  exact .sh check; Bedrock needs IAM auth). SKIP
//                                  (ok) when the aws CLI is absent, mirroring the
//                                  .sh's `aws CLI not found` SKIP.
//   3 claude responds (exit 0)  -> driveAidlc("echo ok") returns a terminal
//                                  result event with is_error === false (the
//                                  deterministic equivalent of the .sh's
//                                  CLAUDE_RC==0; a 124/137 hang leaves resultEvent
//                                  undefined / the driver aborts -> this reds).
//   4 response is non-empty     -> the run produced SOME captured output — a
//                                  tool_result OR assistant text was emitted
//                                  (the .sh's `-n "$CLAUDE_OUTPUT"`). We check the
//                                  PRESENCE of output, never its CONTENT.
//
// It is a substrate probe, not a workflow.
// This is the trust-anchor's sibling: where sdk-drive.calibration proves the
// driver reports planted truths, t19 proves the LIVE substrate the driver needs
// is healthy. A red here is a real environment FINDING (claude/creds), never a
// flake to soften (IRON RULE) — exactly the .sh's "bail downstream LLM tests".
//
// It SPENDS TOKENS — driveAidlc drives a real (tiny) /echo turn on Opus/Bedrock.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { driveAidlc } from "../harness/sdk-drive.ts";

// ---------------------------------------------------------------------------
// Timeout budget — the .sh OVERRODE the default to 180s ("preflight must fail
// fast"). Honour that: a hung claude must surface quickly, not wedge the tier.
// The driver aborts ~15s before bun's per-test cap so a stuck turn surfaces a
// partial DriveResult (resultEvent undefined) rather than an opaque hang.
// ---------------------------------------------------------------------------
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "180", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 180) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(60_000, TEST_TIMEOUT_MS - 15_000);
const AWS_STS_TIMEOUT_MS = 30_000;

describe("t19 preflight health (sdk live substrate)", () => {
  // .sh test 2: AWS credentials valid. The exact .sh check — `aws sts
  // get-caller-identity` exits 0 (Bedrock requires IAM auth). When the aws CLI
  // is absent we PASS-by-skip, mirroring the .sh's `aws CLI not found` SKIP.
  test(
    "AWS credentials valid (aws sts get-caller-identity exits 0)",
    () => {
      const awsPresent = spawnSync("aws", ["--version"], { encoding: "utf8" }).status === 0;
      if (!awsPresent) {
        // .sh: `ok "AWS credentials valid # SKIP aws CLI not found"`.
        expect(awsPresent).toBe(false); // record the skip path explicitly
        return;
      }
      const sts = spawnSync(
        "aws",
        ["sts", "get-caller-identity", "--query", "Account", "--output", "text"],
        { encoding: "utf8", timeout: AWS_STS_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (sts.status !== 0) {
        throw new Error(
          `AWS credentials invalid/expired (aws sts get-caller-identity exit ${sts.status}). ` +
            `Bedrock requires valid IAM auth — refresh AWS credentials.\n${sts.stderr ?? ""}`,
        );
      }
      expect(sts.status).toBe(0);
    },
    AWS_STS_TIMEOUT_MS + 5_000,
  );

  // .sh tests 1+3+4: a real driven turn completes cleanly with non-empty output.
  // This is the live-substrate proof: the SDK cannot drive /echo at all without
  // the claude binary (.sh test 1) the integration tier needs; the terminal
  // result event being non-error is the .sh's CLAUDE_RC==0 (test 3); and SOME
  // captured output (tool_result or assistant text) is the .sh's non-empty
  // CLAUDE_OUTPUT (test 4 — presence, never content).
  test(
    "a real driven turn completes (exit 0) and produces non-empty output",
    async () => {
      const r = await driveAidlc("echo ok", {
        // No projectDir / no AIDLC: this is a bare substrate probe (the .sh ran
        // `echo ok` in a throwaway project). The driver runs in cwd by default.
        timeoutMs: DRIVE_TIMEOUT_MS,
      });

      // .sh test 1+3: the turn reached a terminal result event and it is NOT an
      // error. A 124/137-class hang leaves resultEvent undefined (the driver
      // aborted) -> this reds, exactly the .sh's timeout-bail.
      expect(r.resultEvent).toBeDefined();
      expect(r.resultEvent?.is_error).toBe(false);

      // .sh test 4: the response is non-empty. We assert PRESENCE of output — a
      // tool_result OR assistant prose was emitted — never the CONTENT (which is
      // the LLM's to reword; asserting on it would be the §1 anti-pattern).
      const producedOutput =
        r.toolResults.length > 0 || r.assistantText.trim().length > 0;
      expect(producedOutput).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
