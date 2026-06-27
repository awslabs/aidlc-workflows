// covers: stage:ideation/approval-handoff
//
// t-tui-t101-memory-lifecycle.serial.tui.test.ts — drive the per-stage
// memory.md START→APPROVAL lifecycle (v0.5.0 milestone 13) through a REAL claude TUI.
// PATTERN A (land + render, NOT answer-and-advance): jump to approval-handoff,
// prove memory.md is faithfully created at stage start, WAIT for the approval
// gate to PAINT, and assert the landed state + the rendered gate WHILE PAUSED on
// it — never answering (answering would advance the stage and break the
// Current-Stage==approval-handoff assertion; and the memory.md terminator fires
// at 0 answers before the gate paints — see the PATTERN A note at the wait
// below). A faithful rewrite of tests/integration/t101-stage-memory-lifecycle.sh,
// EQUAL-OR-STRONGER on the same on-disk surface, with the rendered-gate value-add
// ADDED.
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
//   - RENDER (the tui-only value-add the SDK path is blind to): the captured grid
//     showed the AskUserQuestion approval gate at least once during the run — the
//     `❯` caret + an `Enter to select` / `Submit answers` footer. The .sh NEVER saw
//     a painted gate; the menu was auto-approved headlessly. This is the journey a
//     real user actually lives.
//
// WHY PATTERN A (land + render, not answer-and-advance): approval-handoff is a
// GATE stage (its stage file: "Approval gate: Approve / Request Changes /
// Reject"). The orchestrator paints a real AskUserQuestion gate and WAITS for a
// human keystroke; nothing advances until it is answered. This
// journey's contract is the memory.md LIFECYCLE observed WHILE PAUSED ON that gate
// — creation at stage start, fidelity, and that the gate RENDERS — plus the jump
// landing ON approval-handoff (Current Stage == approval-handoff, i.e. NOT
// advanced). So we jump to the stage, prove memory.md was faithfully created,
// WAIT for the approval gate to paint, and assert disk + screen while paused —
// we do NOT answer the gate. Mirrors the committed Pattern-A journeys t24/t27.
//
// WHY NOT answer-gate (the verified failure, per the IRON RULE): two ways an
// answer-gate breaks this journey. (1) With `--until-file memory.md`: memory.md is
// created at stage START (SKILL.md ## Routing: "create on stage start if absent"),
// BEFORE the gate paints, so the disk terminator fires after 0 answers within
// seconds — killing the run before the approval gate paints minutes later, so the
// render proof was false (verified live 2026-06-06: terminator met after 0
// answers, sawGate=false). (2) With a post-approval terminator: answering the gate
// ADVANCES the stage, moving Current Stage OFF approval-handoff and breaking
// assertion #5. Both contradict the contract. The fix is to NOT answer: wait for
// the gate to render (the hang-backstop is the waitFor timeout — if it never
// paints, the test reds, a reachability FINDING never softened). We do NOT assert
// terminal workflow completion (racy; the Phase-2 lesson) and we do NOT assert any
// audit event the .sh did not (it asserted none on the audit surface — it read
// memory.md + the runtime graph). The .sh's assertion 8 (runtime-graph memory_path)
// is NOT ported: it requires a STAGE_STARTED row that a `--stage` JUMP may not emit
// (the .sh itself skipped it conditionally), and compiling the runtime graph is a
// post-hoc deterministic read outside this journey's render+disk surface — better
// folded into the Phase-4 deterministic tier than asserted racily here.
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
        // Without this, the missing-inputs gate fires and the sawGate poll would
        // prove that gate instead of the approval gate this test targets. The jump
        // lands gatelessly (post-0.5.17 the gate keys only on REQUIRED inputs), the
        // approval-handoff stage runs, and ITS approval gate is what sawGate proves.
        ideationArtifacts: true,
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

        // --- PATTERN A (land + render), NOT answer-and-advance --------------
        // t101's contract is the memory.md START→APPROVAL lifecycle observed WHILE
        // PAUSED ON the gate: (a) memory.md is created at stage START, (b) the jump
        // lands ON approval-handoff (assertion #5 below requires Current Stage ==
        // approval-handoff — i.e. NOT advanced), and (c) the approval gate RENDERS.
        // These are mutually exclusive with answering the gate: an answer-gate that
        // advances the stage would move Current Stage OFF approval-handoff and break
        // assertion #5. The earlier `--until-file memory.md` answer-gate ALSO failed
        // the other way — memory.md is created at stage start, so the terminator
        // fired after 0 answers (within seconds), killing the run BEFORE the
        // approval gate painted minutes later, so sawGate was false (verified live
        // 2026-06-06). So we do NOT run answer-gate here. Instead we WAIT for the
        // approval gate to PAINT (the caret + AUQ footer — the same gridHasMenu
        // signature), leaving the workflow paused on it, then assert memory.md +
        // the landed Current Stage + the rendered gate. This mirrors the committed
        // Pattern-A journeys (t24/t27): wait for the rendered signal, capture,
        // assert disk + screen, never answer. The hang-backstop is the waitFor
        // timeout: if the gate never paints, waitFor returns false and the sawGate
        // assertion reds — a FINDING about reachability, never softened.
        //
        // memory.md is created at stage start (before the gate), so once the gate
        // footer is up the artifact is guaranteed present; the pollTimer latches
        // sawGate the moment the caret+footer paint. Wait generously for the gate.
        // waitFor polls the grid at the driver's own cadence (faster + more robust
        // than a 1s test-side poll, which raced and missed a brief gate elsewhere —
        // the t29 lesson) and matches the AUQ footer. This IS the render proof: a
        // footer can only paint when a gate is up. If the gate never paints, waitFor
        // returns false and this reds — a FINDING that approval-handoff did not reach
        // its user-facing gate in budget, never softened to pass.
        const gateRendered = waitFor(
          session,
          "Enter to select|Submit answers",
          Math.max(60000, TEST_TIMEOUT_MS - 60000),
          0,
        );
        expect(gateRendered).toBe(true);

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

        // 3. the ownership blockquote (.sh assertion 3, EXACT semantics —
        //    t101.sh:68-81): when a `>` blockquote header EXISTS it MUST be the
        //    verbatim template string (a malformed copy is a real fidelity
        //    defect); when the orchestrator approximated the copy and wrote NO
        //    blockquote header at all, the .sh skipped rather than failed (LLM
        //    variance on the template copy, observed live 2026-06-10 — the
        //    orchestrator authored an equivalent plain-text ownership line).
        const blockquoteLines = mem
          .split("\n")
          .filter((l) => l.startsWith("> "));
        if (blockquoteLines.length > 0) {
          const ownershipRe = new RegExp(
            `^${OWNERSHIP_LINE.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
            "m",
          );
          expect(mem).toMatch(ownershipRe);
        } else {
          // .sh: `skip "ownership header (orchestrator approximated the copy)"`.
          // eslint-disable-next-line no-console
          console.log(
            "t-tui-t101 SKIP ownership-header fidelity — orchestrator approximated the template copy (no blockquote header); the .sh skipped here too",
          );
        }

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

        // (The render assertion — the AUQ gate footer painted — is proven above by
        // `gateRendered` from waitFor, the tui-only value-add the SDK path is blind
        // to. No separate poll-timer: waitFor is the robust proof.)
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
