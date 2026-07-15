// covers: file:skills/aidlc/SKILL.md, file:agents/aidlc-composer-agent.md
//
// t-tui-compose-front.serial.test.ts - the P2 front-composer journey through a
// REAL claude TUI (the render half of what t192 proves on the SDK): drive
// `/aidlc compose "<task>"` on a fresh workspace, answer the rendered
// approve/edit/reject gate by keystroke (Enter = the leading option, which the
// SKILL.md composer block pins to Approve), and TERMINATE on the born state
// landing on disk.
//
// What it proves on the SHIPPED tree that the SDK path cannot see: the compose
// gate RENDERS as a real AskUserQuestion menu a human answers, and answering
// it drives the write + same-turn birth - one /aidlc invocation, keystrokes
// only.
//
// Disk assertions (the same P2 contract t192 pins):
//   - a 10th scope .md + a 10th scope-grid.json key exist (the two-file write),
//   - the born aidlc-state.md carries the composed (non-stock) scope.
//
// SPENDS Claude credits - gated behind AIDLC_TUI_LIVE=1 with skip-reasons;
// tmux-backend only (mirrors t-tui-t50's gating).

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { stateFilePathFor } from "../harness/sdk-drive.ts";
import { cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const IS_WIN = os.platform() === "win32";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "1800", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 1800) * 1000;

const TASK =
  "harden the deployment pipeline and add observability for our existing service - no new features, compose a custom plan for exactly this";

const STOCK_SCOPES = new Set([
  "bugfix", "discovery", "enterprise", "feature", "infra", "mvp", "poc",
  "refactor", "security-patch", "workshop",
]);

function drive(args: string[]): { rc: number; stdout: string } {
  const res = spawnSync(process.execPath, [DRIVER, ...args], { encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "" };
}
function waitFor(session: string, pattern: string, timeoutMs: number, stableMs: number): boolean {
  return (
    drive([
      "wait", "--session", session, "--pattern", pattern,
      "--timeout-ms", String(timeoutMs), "--stable-ms", String(stableMs),
    ]).rc === 0
  );
}

function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live compose TUI journey (uses Claude credits)";
  }
  if (IS_WIN) return "compose TUI journey is tmux-backend only";
  if (spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status !== 0) return "tmux not found";
  if (spawnSync("claude", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "claude CLI not found";
  }
  return null;
}
const SKIP_REASON = skipReason();

describe("t-tui compose front journey (live claude TUI)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `/aidlc compose renders the gate; answering births the composed scope${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_compose_${process.pid}`;
      const sandbox = setupTuiProject({ brownfieldStub: true, noAidlcDocs: true });
      try {
        expect(drive([
          "start", "--session", session, "--cwd", sandbox,
          "--width", "120", "--height", "45",
          "--", "claude", "--dangerously-skip-permissions",
        ]).rc).toBe(0);

        if (waitFor(session, "trust this folder", 60000, 600)) {
          drive(["send", "--session", session, "--keys", "1"]);
        }
        if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
          drive(["send", "--session", session, "--keys", "2"]);
        }
        expect(waitFor(session, "\\[AIDLC\\].*ready", 45000, 800)).toBe(true);

        drive([
          "send", "--session", session, "--keys",
          `/aidlc compose "${TASK}"`,
          "--literal", "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Answer every rendered gate with the leading (Recommended/Approve)
        // option; terminate the moment the born state carries ANY Scope field
        // (birth = the journey's last deterministic mutation). No per-gate
        // timeout - the disk terminator is the pass condition.
        const gateRc = await new Promise<number>((resolve) => {
          const child = spawn(
            process.execPath,
            [
              DRIVER, "answer-gate",
              "--session", session,
              "--project-dir", sandbox,
              "--until-state-field", "Scope=\\S+",
              "--overall-timeout-ms", String(Math.max(60000, TEST_TIMEOUT_MS - 30000)),
            ],
            { stdio: "inherit" },
          );
          child.on("exit", (code) => resolve(code ?? -1));
          child.on("error", () => resolve(-1));
        });
        expect(gateRc).toBe(0);

        // The two-file write landed: an 11th scope .md + an 11th grid key.
        const scopesDir = join(sandbox, ".claude", "scopes");
        const scopeFiles = readdirSync(scopesDir).filter(
          (f) => f.startsWith("aidlc-") && f.endsWith(".md"),
        );
        expect(scopeFiles.length).toBe(11);
        const grid = JSON.parse(
          readFileSync(join(sandbox, ".claude", "tools", "data", "scope-grid.json"), "utf-8"),
        ) as Record<string, unknown>;
        expect(Object.keys(grid).length).toBe(11);
        const composed = Object.keys(grid).find((k) => !STOCK_SCOPES.has(k));
        expect(composed).toBeDefined();

        // The born state froze the composed scope.
        const stateMd = readFileSync(stateFilePathFor(sandbox), "utf8");
        expect(stateMd).toContain(`- **Scope**: ${composed}`);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
