// covers: file:skills/aidlc/SKILL.md
//
// t-exec-copilot-status.serial.test.ts — drive `/aidlc --status` through
// Copilot CLI's headless surface (`copilot -p`) against the SHIPPED
// dist/copilot tree, and assert on the engine's real outputs. The copilot
// exec driver is the structured "logic half" for the Copilot harness — the
// analogue of codex's exec driver (no tmux; the model's final message + the
// project's on-disk state are the observables).
//
// LIVE-PROVEN (2026-07-25, @github/copilot 1.0.74 over Bedrock BYOK): the
// compat-spike rig ran skill discovery, hook wiring (PascalCase events →
// snake_case payloads), PreToolUse deny, Stop block, and subagent delegation
// on this exact surface; the private capture path is intentionally not shipped.
// This test pins the cheap status journey so CI can re-verify the shipped
// tree end-to-end without burning a whole workflow.
//
// SCOPE: the no-state case ONLY (status with no workflow = print-directive
// terminal arm — turn-stable), same carve-out as the codex/opencode twins.
//
// What this proves on the SHIPPED tree, structurally:
//   - /aidlc skill discovery from .github/skills/ (slash invocation in the
//     prompt resolves the orchestrator SKILL.md);
//   - the engine at .aidlc/ runs via the shell tool;
//   - the engine's print-directive terminal arm (status names no workflow);
//   - nothing is scaffolded by a read-only utility.
//
// LIVE GATE: requires AIDLC_COPILOT_EXEC_LIVE=1 + a copilot >= 1.0.74 binary
// on PATH (or AIDLC_COPILOT_BIN) + a model provider: either GitHub auth or
// BYOK env vars (COPILOT_PROVIDER_BASE_URL etc. — pass through verbatim).
// Skips cleanly otherwise. NOTE: hooks are deliberately NOT exercised here
// (they need trustedFolders + GITHUB_COPILOT_PROMPT_MODE_REPO_HOOKS=1 and a
// mutation journey); the unit adapter test (t249) covers the hook contract.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  runCopilot,
  setupCopilotProject,
} from "../harness/exec-drive.ts";
import { REPO_ROOT } from "../harness/fixtures.ts";

const COPILOT_DIST = join(REPO_ROOT, "dist", "copilot");
const COPILOT_BIN = process.env.AIDLC_COPILOT_BIN ?? "copilot";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "600", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 600) * 1000;

function copilotVersionOk(): boolean {
  const r = spawnSync(COPILOT_BIN, ["--version"], { encoding: "utf-8" });
  const m = (r.stdout ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (r.status !== 0 || !m) return false;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return maj > 1 || (maj === 1 && (min > 0 || pat >= 74));
}

function skipReason(): string | null {
  if (process.env.AIDLC_COPILOT_EXEC_LIVE !== "1") {
    return "set AIDLC_COPILOT_EXEC_LIVE=1 to run the live copilot exec journey (uses your provider)";
  }
  if (!copilotVersionOk()) {
    return `copilot >= 1.0.74 not found (AIDLC_COPILOT_BIN=${COPILOT_BIN})`;
  }
  if (!existsSync(COPILOT_DIST)) return `distributable missing: ${COPILOT_DIST}`;
  // A provider must be reachable: BYOK env (no GitHub auth needed) or GitHub
  // auth. BYOK and the documented token env vars are detectable; an
  // interactive `copilot login` stores its state opaquely, so accept an
  // explicit opt-through for that case (AIDLC_COPILOT_ASSUME_AUTH=1) instead
  // of failing on copilot's auth error (the opencode twin's credential-probe
  // pattern, adapted to what is knowable here).
  if (
    !process.env.COPILOT_PROVIDER_BASE_URL &&
    !process.env.COPILOT_GITHUB_TOKEN &&
    !process.env.GH_TOKEN &&
    !process.env.GITHUB_TOKEN &&
    process.env.AIDLC_COPILOT_ASSUME_AUTH !== "1"
  ) {
    return "no provider visible: set COPILOT_PROVIDER_BASE_URL (BYOK), a GitHub token env var, or AIDLC_COPILOT_ASSUME_AUTH=1 for an interactively logged-in CLI";
  }
  return null;
}
const SKIP_REASON = skipReason();

describe("t-exec-copilot-status — /aidlc --status on the shipped dist/copilot via copilot -p", () => {
  test.skipIf(SKIP_REASON !== null)(
    `no-state: status renders 'no active workflow' and scaffolds nothing${SKIP_REASON ? ` [SKIP: ${SKIP_REASON}]` : ""}`,
    () => {
      const proj = setupCopilotProject();
      const r = runCopilot(proj, "--status");
      // Surface the CLI's own output on a non-zero exit — the observable
      // that names the failure (provider auth, trust, crash).
      expect({ rc: r.rc, tail: r.rc === 0 ? "" : r.out.slice(-2000) }).toEqual({
        rc: 0,
        tail: "",
      });
      // The engine's no-workflow status text, surfaced verbatim by the
      // print-directive terminal arm.
      expect(r.out.toLowerCase()).toContain("no active");
      // Read-only: the status path must not scaffold a workflow. The shipped
      // aidlc/ workspace shell (spaces/default/memory) is part of the
      // install; the workflow signals are an intent record and the
      // per-intent scaffold.
      expect(
        existsSync(join(proj, "aidlc", "spaces", "default", "intents", "intents.json")),
      ).toBe(false);
      expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
