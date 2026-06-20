// t-tui-workshop.serial.tui.test.ts — drive a mini AI-DLC workshop through a
// REAL claude TUI and prove answering its AskUserQuestion gates advances state
// ON DISK (§5.1). A REWRITE (not a port) of the shipped spike
// tests/spike/t-tui-workshop.sh, which was BROKEN and never passed live: its
// MAX_ANSWERS=3 bare-Enter loop stopped BEFORE the Submit screen, so the
// affirmation never committed, yet it asserted "Way of Working populated" —
// unreachable. This rewrite uses the `answer-gate` subcommand (§3) instead: it
// answers every tab/gate and TERMINATES on the post-approval `Last Completed
// Stage` field (written atomically with GATE_APPROVED — see the spawn below for
// why the affirmation timestamp is the WRONG terminator: the t73/t74 race).
//
// What it proves:
//   - a workshop workflow starts from a freeform prompt (statusline leaves `ready`),
//   - the answer-gate clears the multi-tab practices gate + the Code Style and
//     Approval gates by taking the Recommended default per menu,
//   - answering advances REAL state on disk (the SDK and tui paths share this
//     exact disk assertion):
//       * aidlc-state.md `Practices Affirmed Timestamp` non-empty,
//       * audit.md has GATE_APPROVED >= 1,
//       * team.md `## Way of Working` populated (trunk|merge|branch),
//   - RENDER (the tui-only value-add): the captured grid showed the multi-tab
//     `Submit` strip and the `Enter to select` footer at least once — the thing
//     the SDK path cannot see.
//
// COST: spends real Bedrock tokens (minutes-long LLM turns). Gated behind
// AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs it; tmux/claude/
// distributable absence also SKIPs with a reason.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts (node on
// Windows so node-pty never loads under bun, #748; bun elsewhere). The
// answer-gate loop lives in the driver — one implementation, both backends.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { stateFilePathFor } from "../harness/sdk-drive.ts";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const IS_WIN = os.platform() === "win32";
// node on Windows (#748), resolved because the box's node is off PATH; the .ts
// entrypoint needs --experimental-strip-types under node < 22.18. bun elsewhere
// (runs .ts natively, no flag — byte-identical to the spike).
const WIN_NODE = IS_WIN ? resolveWinNode() : null;
// Driver spawn prefix: on win32 the resolved node + strip-types flag + driver;
// elsewhere bun + driver. The answer-gate child spawn (below) reuses this so the
// long-lived subprocess hits the same runtime.
const DRIVE_BIN = IS_WIN ? (WIN_NODE as string) : process.execPath;
const DRIVE_PREFIX = IS_WIN ? ["--experimental-strip-types", DRIVER] : [DRIVER];

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the integration
// tier sets 600). A full practices-discovery run-through is several minutes of
// real LLM turns, so the bun:test cap is generous.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(args: string[]): Run {
  const res = spawnSync(DRIVE_BIN, [...DRIVE_PREFIX, ...args], { encoding: "utf-8" });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
function waitFor(session: string, pattern: string, timeoutMs: number, stableMs: number): boolean {
  return (
    drive([
      "wait",
      "--session",
      session,
      "--pattern",
      pattern,
      "--timeout-ms",
      String(timeoutMs),
      "--stable-ms",
      String(stableMs),
    ]).rc === 0
  );
}

// ABSENT / opt-in gating. The token guard AIDLC_TUI_LIVE=1 is checked FIRST so a
// bare --e2e (no live opt-in) reports a clear skip reason, not a substrate miss.
function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live workshop (uses Bedrock tokens)";
  }
  if (!IS_WIN && spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status !== 0) {
    return "tmux not found";
  }
  if (IS_WIN) {
    // node may be off PATH (proven on the EC2 box) — resolve a concrete binary
    // and test node-pty resolvability with IT, not a bare `node`. Both absent ->
    // clean SKIP (capability absent).
    if (!WIN_NODE) return "node not found (required to run tui-drive on Windows — #748)";
    if (spawnSync(WIN_NODE, ["-e", "require('node-pty')"], { encoding: "utf-8" }).status !== 0) {
      return "node-pty not node-resolvable (npm install node-pty so node can require it)";
    }
  }
  if (spawnSync("claude", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

describe("t-tui-workshop (answering AUQ gates advances disk state)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `workshop run-through commits affirmation on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_workshop_${process.pid}`;
      // setupTuiProject copies the distributable AND the sibling aidlc/ memory
      // shell (the rule layers live there post-P5) and seeds the per-intent
      // workspace shell; noAidlcDocs strips the seeded record so the live
      // `/aidlc --scope workshop` auto-births its own intent (the `ready`
      // baseline below holds because no intent resolves until birth).
      const sandbox = setupTuiProject({ noAidlcDocs: true });
      // The render value-add: we tail the grid during the run to prove the
      // multi-tab strip + footer painted at least once (the SDK path can't see it).
      let sawSubmitStrip = false;
      let sawSelectFooter = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      try {
        // --- launch (distributable already copied by setupTuiProject) ----------
        expect(drive([
          "start",
          "--session",
          session,
          "--cwd",
          sandbox,
          "--width",
          "120",
          "--height",
          "45",
          "--",
          "claude",
          "--dangerously-skip-permissions",
        ]).rc).toBe(0);

        // clear the two startup modals (idempotent — only act if present)
        if (waitFor(session, "trust this folder", 60000, 600)) {
          drive(["send", "--session", session, "--keys", "1"]);
        }
        if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
          drive(["send", "--session", session, "--keys", "2"]);
        }
        expect(waitFor(session, "\\[AIDLC\\].*ready", 45000, 800)).toBe(true);

        // --- submit the workshop prompt ---------------------------------------
        // Use EXPLICIT `--scope workshop`, not bare freeform `workshop`, so this
        // journey always proves the workshop lifecycle rather than env/default
        // routing. Slash command has spaces -> send literally with no auto-Enter,
        // then Enter as a named key.
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --scope workshop Build a simple React todo app",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Confirm the workflow started (statusline shows a live phase, not
        // `ready`). --stable-ms 0: the screen is streaming (live token counter /
        // spinner), so match the instant the phase text appears.
        expect(
          waitFor(session, "\\[AIDLC\\].*(INITIALIZATION|IDEATION|INCEPTION)", 120000, 0),
        ).toBe(true);

        // Begin tailing the grid for the render assertion BEFORE answer-gate runs,
        // so we catch the multi-tab strip + footer while the gates are up.
        pollTimer = setInterval(() => {
          const grid = drive(["capture", "--session", session]).stdout;
          if (grid.includes("Submit")) sawSubmitStrip = true;
          if (grid.includes("Enter to select")) sawSelectFooter = true;
        }, 1000);

        // --- answer the gates via the shared answer-gate primitive (§3) -------
        // It answers all tabs/gates by taking the Recommended default and
        // terminates on the POST-APPROVAL state signal — NOT the bare-Enter loop
        // the broken spike used. Run it as a long-lived subprocess; its own
        // backstops error loud, so a hang surfaces as a nonzero exit.
        //
        // Terminate on `Last Completed Stage=^practices-discovery$`, NOT the
        // default `Practices Affirmed Timestamp`. This is the t73/t74
        // terminator-race (t-tui-t74:271-283), confirmed live for this journey
        // on macOS 2026-06-13: practices-discovery runs its affirmation gate as
        // Step 5 gate-start → Step 6 promote (PRACTICES_AFFIRMED) → Step 7
        // timestamp `set` → the deferred Step 5 `report --result approved`
        // (GATE_APPROVED + STAGE_COMPLETED). The conductor writes the substantive
        // promote+timestamp BEFORE closing the gate, so the timestamp lands ~1s
        // ahead of GATE_APPROVED (captured order: PRACTICES_AFFIRMED 11:03:36 →
        // timestamp 11:03:44 → GATE_APPROVED 11:03:45). The default timestamp
        // terminator therefore stopped the loop in that gap, and the immediate
        // `audit.md` read below saw GATE_APPROVED=0 — a real 0-count, not a
        // missing gate. Within the same handleApprove invocation the GATE_APPROVED
        // row is appended to audit.md (aidlc-state.ts :799) BEFORE `Last Completed
        // Stage` is flushed to aidlc-state.md by writeStateFile (:809; the :789
        // setField is in-memory only). So the moment the terminator can observe
        // `Last Completed Stage=^practices-discovery$` on disk, GATE_APPROVED is
        // already there — the GATE_APPROVED>=1 assertion below stays honest.
        const gateRc = await new Promise<number>((resolve) => {
          const child = spawn(
            DRIVE_BIN,
            [
              ...DRIVE_PREFIX,
              "answer-gate",
              "--session",
              session,
              "--project-dir",
              sandbox,
              // Post-approval terminator (see above): the affirmation gate's
              // GATE_APPROVED is guaranteed downstream of this field.
              "--until-state-field",
              "Last Completed Stage=^practices-discovery$",
              // No fixed per-gate timeout; the overall timeout is the wedge backstop.
              "--overall-timeout-ms",
              String(Math.max(60000, TEST_TIMEOUT_MS - 30000)),
            ],
            { stdio: "inherit" },
          );
          child.on("exit", (code) => resolve(code ?? -1));
          child.on("error", () => resolve(-1));
        });
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        expect(gateRc).toBe(0);

        // --- assert ON DISK (shared with the SDK path) ------------------------
        const stateMd = readFileSync(stateFilePathFor(sandbox), "utf8");
        // Digit-anchored: a real ISO timestamp, not an empty field (§3).
        expect(stateMd).toMatch(/Affirmed Timestamp\*\*:[ \t]*\d[^\r\n]*/);

        const auditMd = readAllAuditShards(sandbox);
        const gateApproved = auditMd
          .split("\n")
          .filter((l) => l.startsWith("**Event**: GATE_APPROVED")).length;
        expect(gateApproved).toBeGreaterThanOrEqual(1);

        // The method relocated (P5/fe7f470) from .claude/rules/aidlc-team.md to
        // the harness-neutral workspace-root aidlc/spaces/default/memory/team.md
        // (neutral basename, no aidlc- prefix). Affirmation writes the section
        // there via memoryDirFor (aidlc-state.ts:1346-1352).
        const teamRules = readFileSync(
          join(sandbox, "aidlc", "spaces", "default", "memory", "team.md"),
          "utf8",
        );
        // The shipped template ships `## Way of Working` EMPTY; affirmation
        // promotes org defaults into it (trunk|merge|branch).
        const wowIdx = teamRules.indexOf("## Way of Working");
        expect(wowIdx).toBeGreaterThanOrEqual(0);
        const wowSection = teamRules.slice(wowIdx, wowIdx + 400);
        expect(wowSection).toMatch(/trunk|merge|branch/i);

        // --- render assertion (the tui-only value-add) ------------------------
        // The captured grid showed the multi-tab strip + the select footer at
        // least once during the run — what the SDK path is blind to.
        expect(sawSubmitStrip).toBe(true);
        expect(sawSelectFooter).toBe(true);
      } finally {
        if (pollTimer) clearInterval(pollTimer);
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
