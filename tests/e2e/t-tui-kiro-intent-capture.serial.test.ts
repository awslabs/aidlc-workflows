// covers: stage:ideation/intent-capture
//
// t-tui-kiro-intent-capture.serial.test.ts — drive the IDEATION intent-capture
// stage through a REAL keystroke-driven `kiro-cli chat` TUI against the SHIPPED
// dist/kiro tree, and prove it produces its on-disk artifacts. The Kiro twin of
// t-tui-t73-intent-capture.serial.test.ts (same seeded fixture, same disk
// asserts) with the gate loop adapted to the Kiro question protocol.
//
// WHY THE GATE LOOP DIFFERS FROM THE CLAUDE TWIN: on Kiro there is no
// AskUserQuestion widget — the Kiro question-rendering annex
// (dist/kiro/.kiro/skills/aidlc/question-rendering.md) renders every structured
// question as NUMBERED PROSE OPTIONS with the recommended option FIRST, answered
// by typing a number. So instead of tui-drive's answer-gate primitive (which
// arrow-navigates menus), this test runs a simple driver-side loop:
//   while terminator-not-on-disk:
//     wait for the TUI to go idle at the input prompt (the "ask a question or
//     describe a task" / "type to queue" footer), then send "1" + Enter
//     (= the recommended option / Approve, per the annex's recommended-first
//     rule and the protocol's Approve-first approval template).
// Disk is the terminator, never the screen (§1.1) — identical discipline to the
// Claude twin: `Last Completed Stage == intent-capture` in aidlc-state.md, the
// field the approve tool writes atomically with GATE_APPROVED+STAGE_COMPLETED.
//
// "1" IS ALWAYS A SAFE ANSWER: every rendering this loop can meet is either the
// tri-mode question (1 = Guide me), a stage question batch (1 = option A), the
// consolidated-summary confirm (1 = looks correct / proceed), or the approval
// gate (1 = Approve — the protocol's templates put Approve first, and the annex
// mandates recommended-first ordering). Free-text asks accept "1" poorly BUT the
// stage receives its build description via $ARGUMENTS up front (same trailing-
// freeform trick the Claude twin uses), which was verified live (Wave 4 smoke)
// to skip the "what would you like to build?" free-text ask entirely.
//
// WHAT IT PROVES (equal to the Claude twin's disk surface):
//   - the shipped dist/kiro tree drives a real workflow from a seeded
//     init-done state through intent-capture,
//   - the numbered-prose gate protocol is answerable by keystroke,
//   - ON DISK: questions file with >=1 [Answer]: line; intent-statement
//     (>100 bytes, has a heading); stakeholder map; state Completed == [x]
//     count, > 3, IDEATION phase; intent-capture [x] with Current Stage moved
//     off it; audit has STAGE_COMPLETED for intent-capture.
//
// COST: spends real Kiro credits (minutes of LLM turns on the `auto` model).
// Gated behind AIDLC_KIRO_TUI_LIVE=1; tmux / kiro-cli / kiro auth / dist-kiro
// absence each SKIP with a reason — never a hollow pass. macOS/Linux only
// (tmux backend); there is no Windows kiro-cli path in this suite today.
//
// TRUST POSTURE: launched with --trust-all-tools so the bun tool calls and
// artifact writes run unprompted (the shipped agent's allowedCommands would
// cover the bun calls, but stage bodies also write artifacts via fs_write
// paths outside the agent's allowedPaths fixture-set — trust-all keeps the
// journey about the WORKFLOW, not the permission dialogs). The trust-all
// confirmation picker that 2.6.1 shows on launch is cleared by the prep step.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import { cleanupTuiProject, KIRO_SRC, setupTuiProject } from "../harness/tui-fixtures.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const IS_WIN = os.platform() === "win32";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(args: string[]): Run {
  const res = spawnSync(process.execPath, [DRIVER, ...args], { encoding: "utf-8" });
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
function send(session: string, keys: string, literal: boolean): void {
  const args = ["send", "--session", session, "--keys", keys, "--no-enter"];
  if (literal) args.push("--literal");
  drive(args);
  drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
}

// Kiro TUI idle detection: the input footer reads "ask a question or describe
// a task" when fully idle. While Kiro streams, the footer says "Kiro is
// working". We treat the idle footer held stable as "the model finished a turn
// and is waiting on the human".
const IDLE_PATTERN = "ask a question or describe a task";

// ABSENT / opt-in gating, token guard first (mirrors the Claude twin).
function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_TUI_LIVE !== "1") {
    return "set AIDLC_KIRO_TUI_LIVE=1 to run the live Kiro intent-capture journey (uses Kiro credits)";
  }
  if (IS_WIN) return "kiro TUI journey is tmux-backend only (no Windows kiro-cli path)";
  if (spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status !== 0) {
    return "tmux not found";
  }
  if (spawnSync("kiro-cli", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not found";
  }
  // whoami exits non-zero when logged out — a clean skip, not a red.
  if (spawnSync("kiro-cli", ["whoami"], { encoding: "utf-8" }).status !== 0) {
    return "kiro-cli not authenticated (run `kiro-cli login`)";
  }
  if (!existsSync(KIRO_SRC)) return `distributable missing: ${KIRO_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

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
        /* ignore */
      }
    }
  }
  return null;
}

function lastCompletedIsIntentCapture(sandbox: string): boolean {
  try {
    const s = readFileSync(seededStateFile(sandbox), "utf8");
    const m = /\*\*Last Completed Stage\*\*:[ \t]*([^\r\n]*)/.exec(s);
    return (m?.[1] ?? "").trim() === "intent-capture";
  } catch {
    return false;
  }
}

describe("t-tui-kiro-intent-capture (numbered-prose gates on the shipped dist/kiro tree)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `kiro: intent-capture journey commits intent-statement + answered questions on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_kiro_ic_${process.pid}`;
      const sandbox = setupTuiProject({
        harness: "kiro",
        withState: "state-initialization-done.md",
        greenfieldStub: true,
        withAudit: true,
      });
      try {
        // --- launch kiro-cli chat in the seeded sandbox -----------------------
        // The shipped .kiro/settings/cli.json makes `aidlc` the workspace
        // default agent, so a bare chat lands on the conductor (D-5, verified
        // in the Wave 4 smoke). --trust-all-tools: see TRUST POSTURE above.
        expect(
          drive([
            "start",
            "--session",
            session,
            "--cwd",
            sandbox,
            "--width",
            "200",
            "--height",
            "50",
            "--",
            "kiro-cli",
            "chat",
            "--trust-all-tools",
          ]).rc,
        ).toBe(0);

        // Clear the 2.6.1 trust-all confirmation picker if it renders ("Yes, I
        // accept" is one Down from the default "No, exit").
        if (waitFor(session, "Yes, I accept", 30000, 400)) {
          drive(["send", "--session", session, "--keys", "Down", "--no-enter"]);
          drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
        }
        // Wait for the idle input footer + the aidlc agent in the statusbar —
        // proves the workspace default-agent activation on the shipped tree.
        expect(waitFor(session, "aidlc", 60000, 400)).toBe(true);
        expect(waitFor(session, IDLE_PATTERN, 60000, 600)).toBe(true);

        // --- submit the stage-jump with the build description -----------------
        // Same trailing-freeform trick as the Claude twin: the description lands
        // in $ARGUMENTS so the stage skips its free-text "what to build?" ask.
        send(
          session,
          "/aidlc --stage intent-capture Build a simple React todo app",
          true,
        );

        // --- the Kiro gate loop: idle ⇒ answer "1", terminate on disk ---------
        // Every structured question renders numbered with the recommended
        // option first (the annex contract), so "1" advances tri-mode choice,
        // question batches, the summary confirm, and the Approve gate alike.
        // Per-iteration: wait up to 240s for the idle footer (a long LLM turn),
        // then check disk BEFORE answering so we stop the instant the approve
        // lands (and never answer the auto-advanced next stage's gate).
        const deadline = Date.now() + Math.max(120000, TEST_TIMEOUT_MS - 60000);
        let terminated = false;
        let answers = 0;
        const MAX_ANSWERS = 40; // runaway backstop, mirrors answer-gate's caps
        while (Date.now() < deadline && answers < MAX_ANSWERS) {
          if (lastCompletedIsIntentCapture(sandbox)) {
            terminated = true;
            break;
          }
          // Idle? (stable 1.5s so a mid-stream repaint doesn't false-trigger)
          if (!waitFor(session, IDLE_PATTERN, 240000, 1500)) continue;
          if (lastCompletedIsIntentCapture(sandbox)) {
            terminated = true;
            break;
          }
          send(session, "1", true);
          answers += 1;
        }
        if (!terminated) terminated = lastCompletedIsIntentCapture(sandbox);
        expect(terminated).toBe(true);

        // --- assert ON DISK (the Claude twin's surface, verbatim) -------------
        const icDir = join(seededRecordDir(sandbox), "ideation", "intent-capture");
        expect(existsSync(icDir)).toBe(true);

        const questionsFile = findArtifact(icDir, ["questions"]);
        expect(questionsFile).not.toBeNull();
        const questionsBody = readFileSync(questionsFile as string, "utf8");
        expect((questionsBody.match(/\[Answer\]:/g) ?? []).length).toBeGreaterThan(0);

        const intentFile = findArtifact(icDir, ["intent", "statement"]);
        expect(intentFile).not.toBeNull();
        const intentBody = readFileSync(intentFile as string, "utf8");
        expect(Buffer.byteLength(intentBody, "utf8")).toBeGreaterThan(100);
        expect(intentBody).toMatch(/^#/m);

        const stakeholderFile = findArtifact(icDir, ["stakeholder"]);
        expect(stakeholderFile).not.toBeNull();

        const stateMd = readFileSync(seededStateFile(sandbox), "utf8");
        const xCount = (stateMd.match(/^- \[x\]/gm) ?? []).length;
        const completedMatch = /\*\*Completed\*\*:[ \t]*(\d+)/.exec(stateMd);
        expect(completedMatch).not.toBeNull();
        expect(Number.parseInt((completedMatch as RegExpExecArray)[1], 10)).toBe(xCount);
        expect(xCount).toBeGreaterThan(3);
        expect(stateMd).toContain("IDEATION");
        expect(stateMd).toMatch(/- \[x\] intent-capture/);
        const currentStageLine =
          /\*\*Current Stage\*\*:[ \t]*([^\r\n]*)/.exec(stateMd)?.[1]?.trim() ?? "";
        expect(currentStageLine.length).toBeGreaterThan(0);
        expect(currentStageLine.toLowerCase()).not.toContain("intent-capture");

        const auditMd = readAllAuditShards(sandbox);
        expect(auditMd).toMatch(/STAGE_COMPLETED/);
        expect(auditMd.toLowerCase()).toContain("intent-capture");
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
