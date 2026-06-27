// covers: stage:ideation/approval-handoff
//
// t-tui-t24-stage-jump.serial.tui.test.ts — the TUI journey port of
// tests/integration/t24-integration-stage-jump.sh (a forward `--stage` jump),
// driven through a REAL claude TUI (§5-A1, Phase 3, Pattern A
// "landed + rendered").
//
// WHAT IT PROVES
//   A user mid-IDEATION (seeded Current Stage=feasibility) types
//   `/aidlc --stage approval-handoff` at the live prompt. The jump must:
//     - land DETERMINISTICALLY on disk: aidlc-jump.ts emits a per-stage
//       STAGE_SKIPPED for each in-flight stage it skips over and one canonical
//       STAGE_JUMPED with Direction: FORWARD (aidlc-jump.ts:349,374-375), and
//       rewrites aidlc-state.md — Current Stage=approval-handoff, Lifecycle
//       Phase=IDEATION, the skipped intermediate stages flipped to [S]
//       (aidlc-jump.ts:243,312-313), the prior [x] stages untouched, the
//       Completed counter == the live [x] count, and a fresh Last Updated stamp.
//     - RE-RENDER the statusline: STAGE_DISPLAY["approval-handoff"] =
//       "Approval & Handoff" (aidlc-statusline.ts:72), painted as
//       "> Approval & Handoff" by the workflow line (aidlc-statusline.ts:243).
//   The rendered statusline is the tui-only value-add the SDK / claude -p path
//   was BLIND to — the old .sh only grepped the state/audit bytes.
//
// WHY PATTERN A (landed + rendered, NO answer-gate) — and the gate we DESIGN OUT
//   A forward `--stage` jump is a single deterministic transition. The jump
//   sets Status=Running (aidlc-jump.ts:309) and the orchestrator keeps going
//   past the jump. So the journey NEVER reaches a
//   terminal state we could wait on; asserting terminal completion would be racy
//   (the Phase-2 lesson). We instead terminate on the LANDED signal — the
//   statusline re-rendering "> Approval & Handoff" — and read the on-disk audit +
//   state the .sh asserted. No answer-gate child, no --until-* terminator.
//
//   BUT a forward jump is only single-transition if its target's REQUIRED inputs
//   are present. SKILL.md step 10 scans the target's `consumes:` frontmatter and
//   renders a Missing-inputs Continue/Cancel AskUserQuestion gate when a
//   *required* (`required: true`) upstream artifact is absent. So this port seeds
//   the 3 required ideation artifacts (ideationArtifacts: true) — the jump then
//   finds its required inputs present and lands with NO prompt. That is the
//   honest Pattern A: a real user jumping forward over stages whose *required*
//   artifacts already exist on disk sees no missing-input gate.
//
//   FRAMEWORK FIX THIS RELIED ON (0.5.17, this session): the gate originally
//   scanned EVERY consume — including `required: false` optionals — so it fired on
//   essentially every forward jump (the skipped stages' optional outputs are
//   always absent). That contradicted the graph's own contract
//   (aidlc-graph.ts:715-716: "consumes[].required: false is silent — a first-class
//   valid state"). Verified live 2026-06-06 by driving this journey TWICE: the gate
//   fired both un-seeded (default ❯ Cancel) and with-required-seeded (default ❯
//   Continue, optionals still flagged) — proving the gate keyed off optionals too.
//   That was an IMPLEMENTATION fault the new harness surfaced. SKILL.md step 10
//   now gates only
//   on missing `required: true` artifacts, matching the graph. With that fix +
//   the required seed, this jump is genuinely gateless = clean Pattern A.
//
// EQUAL-OR-STRONGER THAN THE .sh
//   The .sh (12 asserts) is reproduced on the SAME on-disk surface: [S] present,
//   approval-handoff is Current Stage, IDEATION phase, feasibility [S],
//   team-formation [S], intent-capture still [x], Completed counter == [x] count,
//   Last Updated has a timestamp, audit STAGE_JUMPED + FORWARD + ISO timestamp.
//   This port ADDS the rendered statusline assertion the .sh could not make.
//   The on-disk Status here is "Running": a forward jump lands Running and the
//   orchestrator continues past it.
//
// FINDING (surfaced, not chased — AUTHORING-SPEC product-question #1)
//   SKILL.md:255 step 13c: after a jump the orchestrator AUTO-CONTINUES rather
//   than landing-and-awaiting. The post-jump
//   approval-handoff stage will keep running and may eventually mutate Current
//   Stage / Completed past the landed values. This test deliberately TERMINATES
//   the observation the instant the statusline paints "> Approval & Handoff"
//   (the landed render) and reads disk THEN, before the auto-continue can carry
//   the workflow forward — it asserts the JUMP LANDED, not where the
//   auto-continue eventually parks. If a future build makes the jump
//   land-and-await (no barrel-forward), this test still passes; if the
//   auto-continue races ahead of the landed-statusline wait on a slow box, a red
//   here is a FINDING about that race, not an assertion to soften.
//
// COST: spends real Bedrock tokens (the jump runs through the live orchestrator
// turn). Gated behind AIDLC_TUI_LIVE=1 so a bare `--e2e` SKIPs it; tmux/claude/
// distributable absence also SKIPs with a reason — never a hollow pass.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts as a
// subprocess — node on Windows so node-pty never loads under bun (#748), bun
// elsewhere. The driver auto-selects its backend by os.platform(); this journey
// is platform-invariant (plain-text grid + on-disk byte asserts, no colour). The
// `tui-drive.ts` spawn is what DERIVES the `tui` mechanism (Phase 0) — no
// filename mechanism segment is needed or added.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededStateFile } from "../harness/fixtures.ts";
import { cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const IS_WIN = os.platform() === "win32";
// node on Windows (#748), resolved because the box's node is off PATH; the .ts
// entrypoint needs --experimental-strip-types under node < 22.18. bun elsewhere
// (runs .ts natively, no flag).
const WIN_NODE = IS_WIN ? resolveWinNode() : null;
// Driver spawn prefix: on win32 the resolved node + strip-types flag + driver;
// elsewhere bun + driver.
const DRIVE_BIN = IS_WIN ? (WIN_NODE as string) : process.execPath;
const DRIVE_PREFIX = IS_WIN ? ["--experimental-strip-types", DRIVER] : [DRIVER];

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the integration
// tier sets 600). A single jump turn is short, but the live TUI startup +
// orchestrator boot dominates, so the bun:test cap stays generous.
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
    return "set AIDLC_TUI_LIVE=1 to run the live stage-jump journey (uses Bedrock tokens)";
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

describe("t-tui-t24 stage-jump (forward --stage lands on disk + re-renders statusline)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `forward jump to approval-handoff lands STAGE_JUMPED + re-renders "> Approval & Handoff"${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_t24_${process.pid}`;
      // Mirror setup_integration_project --with-state state-mid-ideation.md
      // --with-audit (t24.sh:17). Seeded mid-IDEATION at Current Stage=feasibility
      // with 5 completed [x] stages; audit.md seeded so the jump appends to it.
      const proj = setupTuiProject({
        withState: "state-mid-ideation.md",
        withAudit: true,
        // Seed the 3 REQUIRED upstream ideation artifacts so the forward jump to
        // approval-handoff finds its `consumes` inputs present and does NOT render
        // the Missing-inputs Continue/Cancel gate (SKILL.md:212-215). Verified
        // live 2026-06-06: without this, the jump gates (state marks stages [x]
        // but ships no artifacts → required inputs absent → gate), and the
        // landed statusline never paints. Seeding keeps the jump the deterministic
        // single-transition Pattern A this test asserts, and does NOT alter the
        // [S] marks (those derive purely from checkbox state — aidlc-jump.ts:242-253).
        ideationArtifacts: true,
      });
      try {
        // --- launch the claude TUI -------------------------------------------
        expect(
          drive([
            "start",
            "--session",
            session,
            "--cwd",
            proj,
            "--width",
            "120",
            "--height",
            "45",
            "--",
            "claude",
            "--dangerously-skip-permissions",
          ]).rc,
        ).toBe(0);

        // --- clear the two startup modals (idempotent — only act if present) --
        if (waitFor(session, "trust this folder", 60000, 600)) {
          drive(["send", "--session", session, "--keys", "1"]);
        }
        if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
          drive(["send", "--session", session, "--keys", "2"]);
        }
        // Seeded state -> the workflow statusline paints IDEATION (not "ready").
        // Before the jump it shows the seeded "> Feasibility" stage.
        expect(waitFor(session, "\\[AIDLC\\].*IDEATION", 45000, 800)).toBe(true);

        // --- send the slash command ------------------------------------------
        // Spaces in the command -> send literally with no auto-Enter, then Enter
        // as a named key (the established two-step from the workshop template).
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

        // --- wait for the LANDED render (the Pattern-A terminator) ------------
        // The jump rewrites Current Stage=approval-handoff and the statusline hook
        // repaints "> Approval & Handoff" (STAGE_DISPLAY["approval-handoff"],
        // aidlc-statusline.ts:72,243). --stable-ms 0: the screen streams (live
        // token counter / spinner during the orchestrator turn), so match the
        // instant the landed stage name appears, NOT byte-stability. We do NOT
        // wait on terminal completion: the jump leaves
        // Status=Running and the orchestrator auto-continues (FINDING in header).
        const sawLanded = waitFor(session, "> Approval & Handoff", 180000, 0);
        const pane = drive(["capture", "--session", session]).stdout;
        if (!sawLanded) {
          throw new Error(
            `statusline never re-rendered "> Approval & Handoff" after the jump.\n` +
              `---- last pane ----\n${pane}\n-------------------`,
          );
        }

        // --- RENDER assertion (the tui-only value-add) ------------------------
        // The captured grid shows the landed stage name in the workflow
        // statusline. Anchored on the full display string so a stray "Approval"
        // elsewhere can't satisfy it.
        expect(pane).toContain("· IDEATION");
        expect(pane).toContain("> Approval & Handoff");

        // --- assert ON DISK: aidlc-state.md (the .sh's state greps) -----------
        const stateMd = readFileSync(seededStateFile(proj), "utf8");

        // Current Stage rewritten to the jump target (t24.sh:28).
        expect(stateMd).toMatch(/^-\s*\*\*Current Stage\*\*:\s*approval-handoff\s*$/m);
        // Lifecycle phase stays IDEATION (t24.sh:29).
        expect(stateMd).toMatch(/^-\s*\*\*Lifecycle Phase\*\*:\s*IDEATION\s*$/m);
        // At least one stage flipped to [S] (t24.sh:27).
        expect(stateMd).toMatch(/\[S\]/);
        // The two in-flight intermediate stages the jump skipped over are [S]
        // (t24.sh:32-42). The checkbox line is "- [S] <slug> — EXECUTE".
        expect(stateMd).toMatch(/^-\s*\[S\]\s*feasibility\b/m);
        expect(stateMd).toMatch(/^-\s*\[S\]\s*team-formation\b/m);
        // A previously-completed stage stays [x] — not reset by a FORWARD jump
        // (t24.sh:45-49).
        expect(stateMd).toMatch(/^-\s*\[x\]\s*intent-capture\b/m);
        // Completed counter == actual [x] count, and must NOT count [S]
        // (t24.sh:52-54). Count the checkbox lines on disk and compare to the
        // declared counter.
        const xCount = (stateMd.match(/^-\s*\[x\]/gm) ?? []).length;
        const completedField = stateMd.match(/^-\s*\*\*Completed\*\*:\s*(\d+)/m);
        expect(completedField).not.toBeNull();
        expect(Number((completedField as RegExpMatchArray)[1])).toBe(xCount);
        // Last Updated carries a fresh timestamp (t24.sh:57).
        expect(stateMd).toMatch(/^-\s*\*\*Last Updated\*\*:.*\d[0-9T:Z-]/m);

        // --- assert ON DISK: the per-intent audit shards (the .sh's audit greps) ------
        const auditMd = readAllAuditShards(proj);
        // The canonical STAGE_JUMPED event (t24.sh:61). One per appended block:
        // "**Event**: STAGE_JUMPED".
        const stageJumped = auditMd
          .split("\n")
          .filter((l) => l.startsWith("**Event**: STAGE_JUMPED")).length;
        expect(stageJumped).toBeGreaterThanOrEqual(1);
        // FORWARD direction recorded (t24.sh:62). aidlc-jump.ts:375 emits the
        // field `Direction: "FORWARD"`, which appendAuditEvent renders as the
        // bold-key audit line `**Direction**: FORWARD` (aidlc-audit.ts:259 wraps
        // every field key in **). Anchor on that real on-disk format (matches the
        // **Timestamp** assertion below), not a bare `Direction:`.
        expect(auditMd).toMatch(/\*\*Direction\*\*:\s*FORWARD/);
        // Per-stage STAGE_SKIPPED for each in-flight stage skipped over
        // (aidlc-jump.ts:349) — the audit twin of the [S] state marks. The .sh
        // asserted the [S] state marks; this is the equal-or-stronger audit-side
        // proof of the same skips.
        const stageSkipped = auditMd
          .split("\n")
          .filter((l) => l.startsWith("**Event**: STAGE_SKIPPED")).length;
        expect(stageSkipped).toBeGreaterThanOrEqual(1);
        // Audit events carry ISO timestamps (t24.sh:63). aidlc-audit.ts:257
        // writes "**Timestamp**: <ts>".
        expect(auditMd).toMatch(/\*\*Timestamp\*\*:.*\d[0-9T:Z-]/);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
