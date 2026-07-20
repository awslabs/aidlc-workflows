// covers: stage:ideation/intent-capture
//
// t-tui-t73-intent-capture.serial.tui.test.ts — drive the IDEATION intent-capture
// stage through a REAL keystroke-driven claude TUI and prove it produces its
// on-disk artifacts (§5.1, Phase-3 journey tier). A REWRITE — not a port — of the
// shipped tests/integration/t73-stage-intent-capture.sh.
//
// WHAT THE .sh DID (and why it was a fake journey): it ran the intent-capture
// stage jump headlessly, AUTO-APPROVING the stage's AskUserQuestion gate. The user
// never answered the gate the real intent-capture stage raises; the interactive
// journey a human actually lives was NEVER exercised. This rewrite drives the
// painted gate by keystroke via the shared `answer-gate` primitive (tui-drive.ts
// §3), terminating on the on-disk intent-statement.
//
// WHY PATTERN B (multi-gate journey, answer-gate --until-file):
//   intent-capture is a GATED stage — it asks the user questions (a questions file
//   gets [Answer]: lines filled) and surfaces an AskUserQuestion menu before it
//   commits its artifacts. The journey runs multiple LLM turns and at least one
//   rendered gate, so it is NOT a single landed-and-rendered jump (Pattern A).
//   We answer every gate by taking the Recommended default and TERMINATE on the
//   on-disk intent-statement artifact — never on a screen string (§1.1: the
//   transcript is not a leading event bus; disk is the terminator).
//
// THE SEEDED REDO-JUMP (matches the .sh fixture exactly):
//   state-initialization-done.md sets Current Stage == intent-capture (the redo
//   target) with Completed=3 / 3 [x]. Because Current Stage already equals the
//   --stage target, aidlc-jump does NOT terminate the workflow on the jump; the
//   stage runs, its gate approves, and approve auto-advances to the next in-scope
//   stage (market-research). So after the journey: intent-capture flips to [x],
//   Completed climbs past 3, and Current Stage moves off intent-capture. The .sh
//   asserted exactly this (its tests 9-12). We assert equal-or-stronger.
//
// What it proves:
//   - the intent-capture stage starts from a --stage jump
//     (statusline leaves nothing-to-do and shows a live IDEATION phase),
//   - the answer-gate clears the stage's rendered AUQ menu(s) by taking the
//     Recommended default and TERMINATES on the on-disk intent-statement artifact,
//   - ON DISK (the surface the .sh greps, equal-or-stronger):
//       * <record>/ideation/intent-capture/ exists,
//       * a *questions* file exists AND carries >=1 `[Answer]:` line (the gate's
//         answers were written back, the thing the headless auto-approve faked),
//       * a *intent*statement* artifact exists, is > 100 bytes, and has at least
//         one markdown heading,
//       * a *stakeholder* map artifact exists,
//       * aidlc-state.md Completed counter == the number of `- [x]` lines
//         (internal consistency invariant), Completed >= 4 (monotonic from the
//         fixture's 3 + this stage), and Lifecycle Phase == IDEATION,
//       * audit.md recorded a STAGE_COMPLETED for intent-capture (stronger than
//         the .sh, which never checked audit for this stage),
//   - RENDER (the tui-only value-add the SDK/claude-p path is blind to): the
//     captured grid showed the AUQ select footer (`Enter to select`) and/or the
//     multi-tab `Submit` strip at least once while the gate was up.
//
// REACHABILITY NOTE / potential FINDING: intent-capture is a normal IDEATION stage
// (not the heavy reverse-engineering stage), so a few-minute live run is expected
// to reach the intent-statement well inside the 900s budget. If the artifact never
// lands inside the overall-timeout, answer-gate exits nonzero (HANG BACKSTOP) and
// this test RED — that red is a finding about stage reachability, NOT a thing to
// soften. We assert what the stage SHOULD produce; we do not weaken to force green.
//
// COST: spends real Bedrock tokens (minutes-long LLM turns). Gated behind
// AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs it; tmux/claude/
// distributable absence also SKIPs with a reason — never a hollow pass.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts (node on
// Windows so node-pty never loads under bun, #748; bun elsewhere). The
// answer-gate loop lives in the driver — one implementation, both backends. The
// tui-drive.ts spawn is what DERIVES the `tui` mechanism (Phase 0) — no filename
// mechanism segment. We import ONLY resolveWinNode from the driver.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
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
// tier sets 600). A full intent-capture run-through is a few minutes of real LLM
// turns, so the bun:test cap is generous. The .sh pinned AIDLC_TEST_TIMEOUT=900.
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
    return "set AIDLC_TUI_LIVE=1 to run the live intent-capture journey (uses Bedrock tokens)";
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

// Find the first file under `dir` whose basename matches every fragment (case-
// insensitive), excluding any in `exclude`. Mirrors the .sh `find -name '*frag*'`
// greps so the disk asserts hit the SAME artifacts the bash journey did.
function findArtifact(dir: string, fragments: string[], exclude: string[] = []): string | null {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const lower = entry.toLowerCase();
    if (exclude.some((x) => lower.includes(x.toLowerCase()))) continue;
    if (fragments.every((f) => lower.includes(f.toLowerCase()))) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

describe("t-tui-t73-intent-capture (answering the stage gate produces artifacts on disk)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `intent-capture jump commits intent-statement + answered questions on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_t73_${process.pid}`;
      // Seed EXACTLY as the .sh: state at init-done (intent-capture next/current),
      // greenfield stub (drives workspace-detection to Greenfield), audit present.
      const sandbox = setupTuiProject({
        withState: "state-initialization-done.md",
        greenfieldStub: true,
        withAudit: true,
        runtimeGraph: true,
      });
      // The render value-add: tail the grid during the run to prove the AUQ menu
      // painted at least once (the SDK path can't see it).
      let sawSelectFooter = false;
      let sawSubmitStrip = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      try {
        // --- launch the claude TUI in the seeded sandbox ----------------------
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
        // Seeded state => the workflow statusline paints the live IDEATION phase
        // (not the no-workflow "ready" line). Wait for it before driving.
        expect(waitFor(session, "\\[AIDLC\\].*IDEATION", 45000, 800)).toBe(true);

        // --- submit the stage-jump WITH a build description -------------------
        // intent-capture.md Step 2 reads the project description from "$ARGUMENTS
        // or audit.md". Jumping with a BARE `/aidlc --stage intent-capture` (no
        // description) makes the stage ask "What would you like to build?" as a
        // free-text prompt that answer-gate (keystroke-only) cannot fill → hang
        // (verified live 2026-06-06). Passing the description as trailing freeform
        // lands it in $ARGUMENTS, so the stage proceeds straight to its clarifying
        // questions (verified live: the description was honoured, no re-ask). Send
        // literally (spaces) with no auto-Enter, then Enter as a named key.
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --stage intent-capture Build a simple React todo app",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Confirm the stage actually started running (the statusline stays in a
        // live IDEATION phase while turns stream). --stable-ms 0: the screen is
        // streaming (token counter / spinner), so match the instant it appears.
        expect(waitFor(session, "\\[AIDLC\\].*IDEATION", 120000, 0)).toBe(true);

        // Begin tailing the grid for the render assertion BEFORE answer-gate runs,
        // so we catch the AUQ select footer + multi-tab Submit strip while the
        // gate is up.
        pollTimer = setInterval(() => {
          const grid = drive(["capture", "--session", session]).stdout;
          if (grid.includes("Enter to select")) sawSelectFooter = true;
          if (grid.includes("Submit")) sawSubmitStrip = true;
        }, 1000);

        // --- answer the gate(s) via the shared answer-gate primitive (§3) ------
        // It answers each menu (single-select Enter / multi-select Space-toggle +
        // arrow-navigate to Submit / the :304 "Looks correct" confirmation / the
        // final Approve gate) by taking the Recommended default, and TERMINATES on
        // an on-disk STATE signal, NOT a screen string. Run it as a long-lived
        // subprocess; its own backstops error loud, so a hang surfaces as a nonzero
        // exit (a FINDING about reachability, not a thing to soften).
        //
        // TERMINATOR = `Last Completed Stage` reaching `intent-capture` (a state
        // field). The earlier intent-statement *file* lands mid-Step-5, BEFORE the
        // stakeholder-map (rest of Step 5), the state update (Step 6), and the Step
        // 7 approval gate — so terminating on it stopped the loop too early and the
        // stage never completed (stakeholder-map absent, no STAGE_COMPLETED — the
        // 2026-06-06 t73 red). The approve tool sets `Last Completed Stage =
        // intent-capture` atomically with GATE_APPROVED + STAGE_COMPLETED, so this
        // signal means "the WHOLE stage committed and the gate was approved" —
        // exactly the post-condition every assertion below depends on. The loop
        // checks disk first each iteration, so it terminates the instant the
        // approval writes the field, before the auto-advanced market-research stage
        // can raise its own gate.
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
              "--per-gate-timeout-ms",
              "200000",
              "--overall-timeout-ms",
              String(Math.max(60000, TEST_TIMEOUT_MS - 30000)),
              // Terminate when the stage has completed + been approved: the approve
              // tool writes `- **Last Completed Stage**: intent-capture` atomically
              // with STAGE_COMPLETED. Anchored so only the literal stage matches.
              "--until-state-field",
              "Last Completed Stage=^intent-capture$",
            ],
            { stdio: "inherit" },
          );
          child.on("exit", (code) => resolve(code ?? -1));
          child.on("error", () => resolve(-1));
        });
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        expect(gateRc).toBe(0);

        // --- assert ON DISK (the .sh's greps, equal-or-stronger) --------------
        const icDir = join(seededRecordDir(sandbox), "ideation", "intent-capture");
        // .sh test 1: intent-capture directory created.
        expect(existsSync(icDir)).toBe(true);

        // .sh tests 2+3: a *questions* file exists AND has >=1 [Answer]: line.
        // This is the heart of the rewrite — the answered-questions file is the
        // artifact the headless auto-approve faked. We assert the answers were
        // really written.
        const questionsFile = findArtifact(icDir, ["questions"]);
        expect(questionsFile).not.toBeNull();
        const questionsBody = readFileSync(questionsFile as string, "utf8");
        const answerCount = (questionsBody.match(/\[Answer\]:/g) ?? []).length;
        expect(answerCount).toBeGreaterThan(0);

        // .sh tests 4+5+6: a *intent*statement* artifact exists, > 100 bytes, with
        // at least one markdown heading. (The terminator already required it to
        // exist & be non-empty; we re-derive it for the size/heading asserts.)
        const intentFile = findArtifact(icDir, ["intent", "statement"]);
        expect(intentFile).not.toBeNull();
        const intentBody = readFileSync(intentFile as string, "utf8");
        expect(Buffer.byteLength(intentBody, "utf8")).toBeGreaterThan(100);
        expect(intentBody).toMatch(/^#/m);

        // .sh test 8: a *stakeholder* map artifact exists.
        const stakeholderFile = findArtifact(icDir, ["stakeholder"]);
        expect(stakeholderFile).not.toBeNull();

        // --- state invariants (the .sh's tests 9, 11, 12) ---------------------
        const stateMd = readFileSync(seededStateFile(sandbox), "utf8");
        // test 9: Completed counter == count of `- [x]` lines (consistency).
        const xCount = (stateMd.match(/^- \[x\]/gm) ?? []).length;
        const completedMatch = /\*\*Completed\*\*:[ \t]*(\d+)/.exec(stateMd);
        expect(completedMatch).not.toBeNull();
        const completed = Number.parseInt((completedMatch as RegExpExecArray)[1], 10);
        expect(completed).toBe(xCount);
        // test 12: Completed >= 4 (monotonic — fixture seeds 3, this stage adds >=1).
        expect(xCount).toBeGreaterThan(3);
        // test 11: lifecycle phase is IDEATION (set by fixture, held by the stage).
        expect(stateMd).toContain("IDEATION");

        // test 10 (the redo-jump advancement): intent-capture is [x] and Current
        // Stage moved off it. The fixture set Current Stage == target, so the jump
        // doesn't terminate; the stage's gate approve auto-advances. STRONGER than
        // the .sh, which SKIPPED this when intent-capture wasn't yet [x] — the
        // live answered journey reaches [x], so we assert (not skip) the advance.
        expect(stateMd).toMatch(/- \[x\] intent-capture/);
        const currentStageLine =
          /\*\*Current Stage\*\*:[ \t]*([^\r\n]*)/.exec(stateMd)?.[1]?.trim() ?? "";
        expect(currentStageLine.length).toBeGreaterThan(0);
        expect(currentStageLine.toLowerCase()).not.toContain("intent-capture");

        // --- audit assertion (STRONGER than the .sh, which never checked audit) -
        // The completed intent-capture stage emits a STAGE_COMPLETED for it.
        const auditMd = readAllAuditShards(sandbox);
        expect(auditMd).toMatch(/STAGE_COMPLETED/);
        expect(auditMd.toLowerCase()).toContain("intent-capture");

        // --- learnings-before-gate ordering (guards the §13 turn binding) ------
        // The learnings ritual is its own logged human interaction BEFORE the
        // gate opens: its QUESTION_ANSWERED row must precede the stage's
        // STAGE_AWAITING_APPROVAL row in the audit ledger. Without this pin a
        // conductor that reopens the gate ahead of the learnings turn (the
        // pre-fix live failure mode on Kiro) would still pass this test.
        const questionAnsweredAt = auditMd.lastIndexOf(
          "**Event**: QUESTION_ANSWERED",
        );
        const gateOpenedAt = auditMd.lastIndexOf(
          "**Event**: STAGE_AWAITING_APPROVAL",
        );
        expect(questionAnsweredAt).toBeGreaterThan(-1);
        expect(gateOpenedAt).toBeGreaterThan(questionAnsweredAt);
        // Interview answers also emit QUESTION_ANSWERED, so the ordering pin
        // alone passes when the ritual is skipped outright. Require a
        // learnings-flavored answer (§13 pins the option labels verbatim)
        // before the last gate open.
        const learningsAnswers = [
          ...auditMd.matchAll(
            /\*\*Event\*\*: QUESTION_ANSWERED\n(?:\*\*[^\n]+\n)*?\*\*Details\*\*: [^\n]*(?:Nothing to add|Add a note)/g,
          ),
        ];
        expect(learningsAnswers.length).toBeGreaterThanOrEqual(1);
        expect(gateOpenedAt).toBeGreaterThan(learningsAnswers.at(-1)!.index);

        // --- render assertion (the tui-only value-add) -----------------------
        // The captured grid showed the AUQ select footer and/or the multi-tab
        // Submit strip at least once during the run — what the SDK path is blind
        // to. (intent-capture raises at least one AskUserQuestion gate.)
        expect(sawSelectFooter || sawSubmitStrip).toBe(true);
      } finally {
        if (pollTimer) clearInterval(pollTimer);
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
