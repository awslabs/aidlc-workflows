// covers: subcommand:aidlc-utility:status, subcommand:aidlc-utility:doctor, subcommand:aidlc-utility:help, subcommand:aidlc-utility:config-change, audit:TEST_STRATEGY_CHANGED
//
// t-acp-kiro-utilities.serial.test.ts — the Kiro ACP ports of the single-turn
// SDK contract tests (t20 status / t22 doctor / t23 help / t28 config-change),
// asserting the SAME deterministic surfaces through `kiro-cli acp`: the tools'
// byte-verbatim output (tool_call_update text), the on-disk state file, and
// parsed audit events. NEVER the assistant prose.
//
// Each case uses stopAfterToolTitle where the contract completes at one tool
// result — the ACP analogue of sdk-drive's stopAfterToolResult, managing the
// turn-boundary edge (the conductor may otherwise roll from a status answer
// into live workflow execution inside the same turn; spike-proven).
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

function toolOutput(r: Awaited<ReturnType<typeof driveKiroAcp>>, titleFrag: string): string {
  return r.toolCalls
    .filter((t) => t.title.includes(titleFrag))
    .map((t) => t.output.join(""))
    .join("");
}

describe("t-acp-kiro-utilities (single-turn utility contracts over ACP)", () => {
  // --- t20 port: status with state — read-only + verbatim fields ----------
  test.skipIf(SKIP_REASON !== null)(
    `status (with state): verbatim fields, state byte-untouched${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({
        harness: "kiro",
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      const statePath = seededStateFile(proj);
      const stateBefore = readFileSync(statePath, "utf-8");
      try {
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --status",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolTitle: /aidlc-utility\.ts status/,
        });
        const out = toolOutput(r, "aidlc-utility.ts status");
        // state-mid-ideation.md plants IDEATION / feature / feasibility; the
        // status tool renders display names (calibration 2's lesson).
        expect(out).toContain("AI-DLC Workflow Status");
        expect(out).toContain("IDEATION");
        expect(out).toContain("Scope:          feature");
        expect(out).toContain("Feasibility");
        // Read-only contract, byte-compared.
        expect(readFileSync(statePath, "utf-8")).toBe(stateBefore);
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- t22 port: doctor — per-check labels verbatim ------------------------
  test.skipIf(SKIP_REASON !== null)(
    `doctor: per-check labels arrive verbatim (incl. the Kiro-specific checks)${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({
        harness: "kiro",
        withState: "state-mid-ideation.md",
        withAudit: true,
      });
      try {
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --doctor",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolTitle: /aidlc-utility\.ts doctor/,
        });
        const out = toolOutput(r, "aidlc-utility.ts doctor");
        expect(out).toContain("AI-DLC Health Check");
        expect(out).toContain("bun installed (required for CLI tools and hooks)");
        expect(out).toContain("aidlc-audit-logger.ts present");
        // The harness-aware checks (parity closeout): Kiro wiring, not
        // settings.json.
        expect(out).toContain("aidlc-kiro-adapter.ts present");
        expect(out).toContain("agents/aidlc.json present");
        expect(out).toContain("settings/cli.json present");
        expect(out).not.toContain("settings.json present — copy from `dist/claude");
        // P9: the flat `aidlc-docs/ directory exists` check is retired. The doctor
        // now verifies the SHIPPED workspace shell (the harness engine dir + the
        // default space's memory dir). On the Kiro tree harnessDir() === ".kiro".
        expect(out).toContain("workspace shell ready (.kiro/ + aidlc/spaces/default/memory/)");
      } finally {
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- t23 port: help — sections + scope rows verbatim ----------------------
  test.skipIf(SKIP_REASON !== null)(
    `help: usage sections and the nine scopes arrive verbatim${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const proj = setupTuiProject({ harness: "kiro", noAidlcDocs: true });
      try {
        const r = await driveKiroAcp({
          projectDir: proj,
          prompt: "/aidlc --help",
          timeoutMs: DRIVE_TIMEOUT_MS,
          stopAfterToolTitle: /aidlc-utility\.ts help/,
        });
        const out = toolOutput(r, "aidlc-utility.ts help");
        expect(out).toContain("Usage");
        for (const scope of [
          "enterprise",
          "feature",
          "mvp",
          "poc",
          "bugfix",
          "refactor",
          "infra",
          "security-patch",
          "workshop",
        ]) {
          expect(out).toContain(scope);
        }
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
