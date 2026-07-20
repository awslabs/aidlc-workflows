// covers: stage:ideation/approval-handoff
//
// t-tui-t101-memory-lifecycle.serial.test.ts — drive the per-stage memory.md
// START→APPROVAL lifecycle through a REAL Claude TUI. The shared answer-gate
// loop answers any preparatory menus, then stops at the first numbered
// Approve / Request Changes menu without answering it. This leaves the workflow
// paused on approval-handoff while proving the real approval gate rendered.
//
// WHAT IT PROVES (the memory.md lifecycle the SKILL.md ## Routing block drives):
//   - init-from-template fires at stage START — the orchestrator copies
//     knowledge/aidlc-shared/memory-template.md into the stage's
//     <record>/ideation/approval-handoff/memory.md (file exists, non-empty).
//   - the created file carries all FOUR canonical `## ` H2 headings
//     (## Interpretations / ## Deviations / ## Tradeoffs / ## Open questions)
//     — the .sh's assertion 2.
//   - the ownership header is the VERBATIM template blockquote — the .sh's
//     assertion 3 (here asserted UNCONDITIONALLY: stronger than the .sh, which
//     skipped when the orchestrator approximated the copy. A malformed/missing
//     header is a real defect, not LLM variance, so we hold the bar).
//   - the jump landed on disk: aidlc-state.md `Current Stage` == approval-handoff.
//   - parseMemoryHeadings(file).total == the visible `- ` entry count on disk —
//     the .sh's assertion 7 (parser ↔ disk agreement), ported by importing the
//     exported helper from the distributable (aidlc-lib.ts:982; import-safe under
//     bun, never loads node-pty).
//   - RENDER (the tui-only value-add the SDK path is blind to): the captured
//     grid contains both numbered approval choices, not merely a generic menu
//     footer that a preparatory Guide / Edit / Chat menu can also paint.
//
// WHY STOP, NOT APPROVE: approval would advance Current Stage and destroy the
// landed-state assertion. `--stop-at-approval-gate` handles earlier menus but
// returns before sending a keystroke to the real gate. The fixture also carries
// a production-shaped runtime graph so the stage's learnings ritual does not
// fail and improvise audit repair during the live journey.
//
// COST: spends real Bedrock tokens (minutes-long LLM turns to reach the gate).
// Gated behind AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs it; tmux/
// claude/distributable absence (and the Windows node + node-pty checks) also SKIP
// with a reason — never a hollow pass.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts as a
// subprocess (node on Windows so node-pty never loads under bun, #748; bun
// elsewhere). The answer-gate loop lives in the driver — one implementation, both
// backends. The `tui-drive.ts` spawn is what DERIVES the `tui` mechanism (Phase 0);
// no filename mechanism segment is needed or added. Platform-invariant plain-text
// grid asserts — the Windows node-pty leg (via SSM) captures the same grid.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
// parseMemoryHeadings is the SAME parser the runtime-graph populator uses
// (aidlc-lib.ts:982). Importing it here ports the .sh's parser↔disk assertion 7.
// aidlc-lib.ts is import-safe (no node-pty); safe under bun on every platform.
import { parseMemoryHeadings } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const IS_WIN = os.platform() === "win32";
// node on Windows (#748), resolved because the box's node is off PATH; the .ts
// entrypoint needs --experimental-strip-types under node < 22.18. bun elsewhere
// (runs .ts natively, no flag).
const WIN_NODE = IS_WIN ? resolveWinNode() : null;
// Driver spawn prefix: on win32 the resolved node + strip-types flag + driver;
// elsewhere bun + driver. The answer-gate child spawn (below) reuses this so the
// long-lived subprocess hits the same runtime.
const DRIVE_BIN = IS_WIN ? (WIN_NODE as string) : process.execPath;
const DRIVE_PREFIX = IS_WIN ? ["--experimental-strip-types", DRIVER] : [DRIVER];

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the integration tier
// sets 600). Reaching a gated stage is several minutes of real LLM turns, so the
// bun:test cap is generous.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;

// The terminal artifact the journey terminates on (relative to the active intent
// RECORD dir — P9 per-intent layout). Created at stage start; its existence +
// content is the lifecycle contract.
const MEM_RELPATH = join("ideation", "approval-handoff", "memory.md");

// The verbatim template ownership blockquote (knowledge/aidlc-shared/
// memory-template.md). The init is an LLM-driven copy of that template; a faithful
// copy reproduces this byte-for-byte.
const OWNERSHIP_LINE =
  "> This file is maintained by the orchestrator during stage execution. " +
  "Add observations at the gate ritual, not by editing here directly.";

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
    return "set AIDLC_TUI_LIVE=1 to run the live memory-lifecycle journey (uses Bedrock tokens)";
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

describe("t-tui-t101 (memory.md start→approval lifecycle through a driven gate)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `approval-handoff stage creates a faithful memory.md and renders its gate${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_t101_${process.pid}`;
      // Mirror the .sh setup: mid-ideation state + seeded audit, target the
      // approval-handoff gate stage (a lightweight gate, ideation phase — the
      // t24 timeout-avoidance choice).
      const sandbox = setupTuiProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
        // Seed the 3 required upstream ideation artifacts so the forward `--stage
        // approval-handoff` jump finds its required `consumes` present and does NOT
        // render the Missing-inputs gate (SKILL.md jump step 10; same fix as t24).
        // Without this, the missing-inputs gate fires and the driver would
        // prove that gate instead of the approval gate this test targets. The jump
        // lands gatelessly (post-0.5.17 the gate keys only on REQUIRED inputs), the
        // approval-handoff stage runs, and its approval gate is what the detector proves.
        ideationArtifacts: true,
        runtimeGraph: true,
      });
      // The render value-add: tail the grid during the run to prove the approval
      // gate painted at least once (the SDK path can't see it).
      try {
        // --- launch the claude TUI -------------------------------------------
        expect(
          drive([
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
          ]).rc,
        ).toBe(0);

        // clear the two startup modals (idempotent — only act if present)
        if (waitFor(session, "trust this folder", 60000, 600)) {
          drive(["send", "--session", session, "--keys", "1"]);
        }
        if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
          drive(["send", "--session", session, "--keys", "2"]);
        }
        // Seeded mid-ideation state -> the statusline paints the WORKFLOW line
        // ([AIDLC] IDEATION), not the no-workflow "ready" line.
        expect(waitFor(session, "\\[AIDLC\\].*IDEATION", 45000, 800)).toBe(true);

        // --- jump to the approval-handoff gate stage -------------------------
        // Slash command has spaces -> send literally with no auto-Enter, then
        // Enter as a named key (the template's exact two-step). The gate paints
        // and waits for a human.
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --stage approval-handoff",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Confirm the jump kicked off a live turn (statusline still IDEATION;
        // the stage name moves toward Approval & Handoff as the orchestrator
        // works). --stable-ms 0: the screen is streaming, so match the instant
        // the marker appears.
        expect(waitFor(session, "\\[AIDLC\\].*IDEATION", 120000, 0)).toBe(true);

        // Answer preparatory menus, then stop with the actual approval menu
        // painted and unanswered. A generic footer is insufficient evidence:
        // the captured grid must carry both canonical numbered choices.
        const stopped = drive([
          "answer-gate",
          "--session",
          session,
          "--project-dir",
          sandbox,
          "--overall-timeout-ms",
          String(Math.max(60000, TEST_TIMEOUT_MS - 60000)),
          "--stop-at-approval-gate",
        ]);
        expect(stopped.rc).toBe(0);
        expect(stopped.stdout).toContain("stopped at approval gate");
        const approvalGrid = drive([
          "capture",
          "--session",
          session,
        ]).stdout;
        expect(approvalGrid).toMatch(/\d+\.\s+Approve\b/i);
        expect(approvalGrid).toMatch(/\d+\.\s+Request Changes\b/i);

        // --- assert ON DISK (equal-or-stronger than the .sh) ------------------
        const memPath = join(seededRecordDir(sandbox), MEM_RELPATH);
        // 1. memory.md exists & non-empty (.sh assertion 1). The terminator
        //    guarantees this on green; we read it for the content asserts.
        expect(existsSync(memPath)).toBe(true);
        const mem = readFileSync(memPath, "utf8");
        expect(mem.length).toBeGreaterThan(0);

        // 2. all four canonical `## ` H2 headings (.sh assertion 2). Anchored to
        //    line starts so a heading mentioned in prose can't satisfy it.
        expect(mem).toMatch(/^## Interpretations$/m);
        expect(mem).toMatch(/^## Deviations$/m);
        expect(mem).toMatch(/^## Tradeoffs$/m);
        expect(mem).toMatch(/^## Open questions$/m);

        // 3. the ownership blockquote must be copied verbatim from the template.
        // Missing, plain-text, or approximated ownership text is a fidelity
        // defect, not an optional LLM-variance branch.
        const ownershipRe = new RegExp(
          `^${OWNERSHIP_LINE.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "m",
        );
        expect(mem).toMatch(ownershipRe);

        // 4. parseMemoryHeadings(file).total == visible `- ` entry count on disk
        //    (.sh assertion 7 — parser ↔ disk agreement). The parser counts real
        //    dated entries under canonical headings; the disk count is the `- `
        //    bullet lines. A fresh template (examples are single-line HTML
        //    comments) parses to total=0 with 0 bullets — they agree at 0 too.
        const parsedTotal = parseMemoryHeadings(mem).total;
        const visible = mem.split("\n").filter((l) => l.startsWith("- ")).length;
        expect(parsedTotal).toBe(visible);

        // 5. the jump landed: aidlc-state.md Current Stage == approval-handoff
        //    (the on-disk proof the orchestrator entered the target stage — the
        //    precondition for the memory.md init to have fired here at all).
        const stateMd = readFileSync(seededStateFile(sandbox), "utf8");
        expect(stateMd).toMatch(/\*\*Current Stage\*\*:[ \t]*approval-handoff\b/);

        // The captured numbered choices above prove the real approval gate
        // rendered and remained unanswered.
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
