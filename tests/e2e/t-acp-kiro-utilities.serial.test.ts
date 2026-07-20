// covers: subcommand:aidlc-utility:status, subcommand:aidlc-utility:doctor, subcommand:aidlc-utility:help, subcommand:aidlc-utility:config-change, audit:TEST_STRATEGY_CHANGED
//
// t-acp-kiro-utilities.serial.test.ts — the Kiro ACP ports of the single-turn
// SDK contract tests (t20 status / t22 doctor / t23 help / t28 config-change),
// asserting the deterministic surfaces that survive the userPromptSubmit seam
// through `kiro-cli acp`.
//
// SEAM CHANGE (why the read-only cases no longer assert tool output). A Kiro
// userPromptSubmit seam (agents/aidlc.json → aidlc-kiro-adapter.ts) now
// classifies the read-only flags (`--status`/`--doctor`/`--help`/`--version`)
// as TERMINAL and runs them OFF-BAND inside the hook, handing the conductor the
// verbatim output with a do-NOT-advance instruction; a turn-scoped engine
// `done`-guard + a preToolUse backstop neutralize any trailing bare `next`.
// CONSEQUENCE: a read-only flag no longer surfaces as an `aidlc-utility.ts <sub>`
// ACP tool_call — the seam ran it off-band, so stopAfterToolTitle would never
// fire and the tool output would never reach an ACP surface. The robust surfaces for these
// seam-dispatched read-only commands are stopReason === "end_turn" and the
// on-disk read-only NO-OP (seeded state byte-unchanged). This mirrors the staged
// t-acp-kiro-journey-workspace leg, which drives terminal verbs to end_turn and
// asserts on disk rather than on stopAfterToolTitle.
//
// The byte-verbatim status/doctor/help output ("AI-DLC Health Check", the nine
// scopes, "No active AI-DLC workflow found.", …) has NO home on the ACP surface
// anymore; it is covered deterministically by the SDK twins (t20 status / t22
// doctor / t23 help — drive the real /aidlc flag and assert the Bash
// tool_result bytes) AND the CLI twins (t27 status+doctor+help / t31 help —
// spawn aidlc-utility.ts <sub> directly and assert stdout). So dropping the ACP
// byte asserts loses no coverage.
//
// config-change (`--test-strategy`) is a MUTATION — classifyTerminalCommand
// returns null for it, so the seam exits 0 and the conductor runs it NORMALLY,
// so its `aidlc-utility.ts config-change` tool_call STILL surfaces; that case is
// UNCHANGED and keeps its stopAfterToolTitle + on-disk mutation asserts.
//
// Trust anchor: kiro-acp-drive.calibration.test.ts (byte-faithfulness,
// known-answer state fields, negative guard, gate loop).
//
// SPENDS Kiro credits — gated AIDLC_KIRO_ACP_LIVE=1, skip-with-reason
// otherwise. Serial: one live session at a time.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import { driveKiroAcp } from "../harness/kiro-acp-drive.ts";
import { cleanupTuiProject, KIRO_SRC, setupTuiProject } from "../harness/tui-fixtures.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "900", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 900) * 1000;
const DRIVE_TIMEOUT_MS = Math.max(60_000, TEST_TIMEOUT_MS - 15_000);

function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_ACP_LIVE !== "1") {
    return "set AIDLC_KIRO_ACP_LIVE=1 to run the live Kiro ACP utility contracts (uses Kiro credits)";
  }
  if (spawnSync("kiro-cli", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not found";
  }
  if (spawnSync("kiro-cli", ["whoami"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-acp-kiro-utilities (single-turn utility contracts over ACP)", () => {
  // --- t20 port: status with state — seam-dispatched, read-only no-op -------
  test.skipIf(SKIP_REASON !== null)(
    `status (with state): seam-dispatched read-only, turn ends clean + state byte-untouched${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({
        harness: "kiro",
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      const statePath = seededStateFile(proj);
      const stateBefore = readFileSync(statePath, "utf-8");
      try {
        // `--status` is TERMINAL → the seam runs it OFF-BAND, so no
        // `aidlc-utility.ts status` tool_call surfaces (stopAfterToolTitle
        // would never fire); the conductor only relays prose. Drive to the
        // natural end_turn and assert the deterministic surfaces: clean turn end
        // + the read-only state byte no-op. The verbatim status FIELDS
        // (IDEATION/feature/Feasibility) are covered by the SDK twin t20 + the
        // CLI twin t27 (see header).
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --status",
          timeoutMs: DRIVE_TIMEOUT_MS,
        });
        expect(r.toolCallIssues).toEqual([]);
        expect(r.stopReason).toBe("end_turn");
        // Read-only contract, byte-compared.
        expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- t22 port: doctor — seam-dispatched, read-only no-op -----------------
  test.skipIf(SKIP_REASON !== null)(
    `doctor: seam-dispatched read-only, turn ends clean + state byte-untouched${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({
        harness: "kiro",
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      const statePath = seededStateFile(proj);
      const stateBefore = readFileSync(statePath, "utf-8");
      try {
        // `--doctor` is TERMINAL → the seam runs it OFF-BAND, so no
        // `aidlc-utility.ts doctor` tool_call surfaces (stopAfterToolTitle
        // would never fire); the conductor only relays prose. Drive to the
        // natural end_turn and assert the deterministic surfaces: clean turn end
        // + the read-only state byte no-op. The verbatim per-check labels
        // ("AI-DLC Health Check", the Kiro-specific checks, "workspace shell
        // ready (.kiro/ …)") are covered by the SDK twin t22 + the CLI twin t27
        // (see header). (NB doctor still appends HEALTH_CHECKED to an existing
        // audit shard, so this case asserts only the STATE no-op, not an
        // audit-byte no-op.)
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --doctor",
          timeoutMs: DRIVE_TIMEOUT_MS,
        });
        expect(r.toolCallIssues).toEqual([]);
        expect(r.stopReason).toBe("end_turn");
        // Read-only contract (state), byte-compared.
        expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- t23 port: help — seam-dispatched, read-only no-op --------------------
  test.skipIf(SKIP_REASON !== null)(
    `help: seam-dispatched read-only, turn ends clean + nothing scaffolded${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
      try {
        // `--help` is TERMINAL → the seam runs it OFF-BAND, so no
        // `aidlc-utility.ts help` tool_call surfaces (stopAfterToolTitle would
        // never fire); the conductor only relays prose. Drive to the natural
        // end_turn and assert the deterministic surfaces: clean turn end + the
        // on-disk no-op (no state births from a help run). The verbatim usage
        // sections + the nine scopes are covered by the SDK twin t23 + the CLI
        // twins t27/t31 (see header).
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --help",
          timeoutMs: DRIVE_TIMEOUT_MS,
        });
        expect(r.toolCallIssues).toEqual([]);
        expect(r.stopReason).toBe("end_turn");
        // Read-only: help births nothing, so the per-intent state file never
        // appears (noAidlcDocs stripped the seeded record).
        expect(r.stateFile).toBeUndefined();
        expect(existsSync(seededStateFile(proj))).toBe(false);
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- t28 port: --test-strategy config-change — state field + audit row ----
  test.skipIf(SKIP_REASON !== null)(
    `--test-strategy minimal: Test Strategy=Minimal lands in state + TEST_STRATEGY_CHANGED in audit${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({
        harness: "kiro",
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --test-strategy minimal",
          timeoutMs: DRIVE_TIMEOUT_MS,
          // The mutation lives in the named config-change tool; stop once it
          // completes (run-then-continue would otherwise re-enter the loop).
          stopAfterToolTitle: /aidlc-utility\.ts config-change/,
        });
        expect(r.toolCallIssues).toEqual([]);
        // Disk is the contract: the state field flipped and the audit row
        // landed (tool-owned emission).
        expect(r.stateFile ?? readFileSync(seededStateFile(proj), "utf-8")).toMatch(
          /\*\*Test Strategy\*\*:[ \t]*Minimal/,
        );
        const audit = readAllAuditShards(proj);
        expect(audit).toContain("TEST_STRATEGY_CHANGED");
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
