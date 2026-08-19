// covers: stage:ideation/intent-capture
//
// t-tui-kiro-unified-intent-capture.serial.test.ts — drive the IDEATION
// intent-capture stage through a REAL keystroke-driven `kiro-cli --v3` TUI against
// the SHIPPED dist/kiro-unified tree. The unified-agent-harness sibling of
// t-tui-kiro-intent-capture.serial.test.ts: same seeded fixture, same numbered-prose
// gate loop, same disk terminator — a different shell underneath.
//
// WHY A SEPARATE JOURNEY. The Kiro CLI twin drives dist/kiro, where the conductor is
// an agent-v1 JSON whose embedded `hooks` object carries the wiring. This tree has no
// agent JSON at all: the conductor is agents/aidlc.md and all twelve registrations are
// standalone hooks/aidlc-*.json manifests. Nothing else in the suite exercises that
// combination against a live agent runtime, so nothing else can tell a shipped
// manifest that fires from one that is merely present. The last block below is the
// part no other test covers.
//
// MEASURED LAUNCH SURFACE (kiro-cli 2.18.1, 2026-08-16, against this tree):
//   - `chat --agent-engine <v1|v2|v3>` selects the runtime and **v2 is the default**;
//     `--v3` is the shorthand this test uses. Without it the 2.x engine runs, which
//     reads neither this tree's `permissions:` blocks nor its hook manifests.
//   - `--agent aidlc` is required: the shipped .kiro/settings/cli.json names the
//     conductor as the workspace default, but Kiro reads CLI settings from the global
//     scope only, so a workspace copy does not select it.
//   - The trust-all confirmation renders a three-option picker ("No, exit" /
//     "Yes, I accept" / "Yes, and don't ask again"); "Yes, I accept" is one Down.
//   - The idle input footer is "ask a question or describe a task" — the same string
//     the Kiro CLI twin waits on — and the statusbar shows the selected agent.
//
// Disk is the terminator, never the screen: `Last Completed Stage == intent-capture`
// in aidlc-state.md, the field the approve tool writes atomically with
// GATE_APPROVED + STAGE_COMPLETED.
//
// COST: spends real Kiro credits (minutes of LLM turns). Gated behind
// AIDLC_KIRO_UNIFIED_TUI_LIVE=1; tmux / kiro-cli / kiro auth / dist tree absence each
// SKIP with a reason — never a hollow pass. macOS/Linux only (tmux backend).

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededRecordDir, seededStateFile } from "../harness/fixtures.ts";
import {
  cleanupTuiProject,
  createKiroNumberedProseAnswerState,
  KIRO_UNIFIED_SRC,
  markdownH2Section,
  nextKiroNumberedProseAnswer,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";

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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Kiro CLI 2.12.1 keeps animating its Thinking glyph and Tasks/status footer
// after the conductor has finished rendering a question and the idle input is
// available. The shared drive's whole-screen stability contract is correct for
// the other TUI suites, so this journey compares only its question surface.
function stableKiroQuestionSurface(screen: string): string {
  const lines = screen.split(/\r?\n/);
  const tasksFooter = lines.findIndex((line) => /\bTasks · \d+ remaining\b/.test(line));
  const content = tasksFooter >= 0 ? lines.slice(0, tasksFooter) : lines;
  return content
    .filter((line) => !/Thinking\.\.\. \(esc to cancel\)/.test(line))
    .filter((line) => !/^\s*╰ \.\.\.\s*$/.test(line))
    .filter((line) => !/\bCredits:.*\bTime:/.test(line))
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

function waitForKiroQuestion(
  session: string,
  previousSurface: string,
  timeoutMs: number,
  stableMs: number,
): string | null {
  const deadline = Date.now() + timeoutMs;
  let candidate = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    const captured = drive(["capture", "--session", session]);
    const screen = captured.stdout;
    if (captured.rc === 0 && screen.includes(IDLE_PATTERN)) {
      const surface = stableKiroQuestionSurface(screen);
      if (surface !== "" && surface !== previousSurface) {
        if (surface !== candidate) {
          candidate = surface;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= stableMs) {
          return screen;
        }
      } else {
        candidate = "";
        stableSince = 0;
      }
    } else {
      candidate = "";
      stableSince = 0;
    }
    sleepSync(500);
  }
  return null;
}

function send(session: string, keys: string, literal: boolean): void {
  const args = ["send", "--session", session, "--keys", keys, "--no-enter"];
  if (literal) args.push("--literal");
  drive(args);
  drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
}

const IDLE_PATTERN = "ask a question or describe a task";

// ABSENT / opt-in gating, token guard first (mirrors the Kiro CLI twin).
function skipReason(): string | null {
  if (process.env.AIDLC_KIRO_UNIFIED_TUI_LIVE !== "1") {
    return "set AIDLC_KIRO_UNIFIED_TUI_LIVE=1 to run the live kiro-cli --v3 journey (uses Kiro credits)";
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
  if (!existsSync(KIRO_UNIFIED_SRC)) return `distributable missing: ${KIRO_UNIFIED_SRC}`;
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

describe("t-tui-kiro-unified-intent-capture (kiro-cli --v3 on the shipped dist/kiro-unified tree)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `kiro-unified: intent-capture journey commits its artifacts and its hook manifests fire${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_kiro_unified_ic_${process.pid}`;
      let keepSandbox = false;
      const sandbox = setupTuiProject({
        harness: "kiro-unified",
        withState: "state-initialization-done.md",
        greenfieldStub: true,
        withAudit: true,
        runtimeGraph: true,
      });
      try {
        // --- launch kiro-cli --v3 on the conductor -----------------------------
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
            "--agent",
            "aidlc",
            "--trust-all-tools",
            "--v3",
          ]).rc,
        ).toBe(0);

        // Clear the trust-all confirmation picker ("Yes, I accept" is one Down
        // from the default "No, exit").
        if (waitFor(session, "Yes, I accept", 30000, 400)) {
          drive(["send", "--session", session, "--keys", "Down", "--no-enter"]);
          drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
        }
        // The statusbar carries the selected agent: this is the assertion that
        // agents/aidlc.md — a Markdown conductor with no agent-v1 JSON beside it —
        // is loadable by name on this runtime.
        expect(waitFor(session, "aidlc", 60000, 400)).toBe(true);
        expect(waitFor(session, IDLE_PATTERN, 60000, 600)).toBe(true);

        // --- submit the stage-jump with the build description -----------------
        // The description lands in $ARGUMENTS so the stage skips its free-text
        // "what would you like to build?" ask.
        send(session, "/aidlc --stage intent-capture Build a simple React todo app", true);

        // --- the numbered-prose gate loop, terminating on disk ----------------
        // Per iteration: wait for the idle footer (a long LLM turn), then check
        // disk BEFORE answering so we stop the instant the approve lands and never
        // answer the auto-advanced next stage's gate.
        const deadline = Date.now() + Math.max(120000, TEST_TIMEOUT_MS - 60000);
        let terminated = false;
        const answerState = createKiroNumberedProseAnswerState();
        let previousQuestionSurface = "";
        while (Date.now() < deadline) {
          if (lastCompletedIsIntentCapture(sandbox)) {
            terminated = true;
            break;
          }
          const screen = waitForKiroQuestion(
            session,
            previousQuestionSurface,
            240000,
            1500,
          );
          if (screen === null) continue;
          if (lastCompletedIsIntentCapture(sandbox)) {
            terminated = true;
            break;
          }
          const answer = nextKiroNumberedProseAnswer(screen, answerState);
          if (answer === null) {
            // The WHOLE capture, not its tail: the prompt sits above the input
            // box, so a tail slice shows only the footer and statusbar. A run
            // here costs ~18 minutes of live turns — the failure has to be
            // diagnosable from one run.
            throw new Error(
              `kiro-cli --v3 stopped at an unrecognized intent-capture prompt:\n${screen}`,
            );
          }
          previousQuestionSurface = stableKiroQuestionSurface(screen);
          send(session, answer, true);
        }
        if (!terminated) terminated = lastCompletedIsIntentCapture(sandbox);
        expect(terminated).toBe(true);
        expect(answerState.guideModeChosen).toBe(true);
        expect(answerState.answeredQuestions.size).toBeGreaterThan(0);
        expect(answerState.approvalsAnswered).toBeGreaterThanOrEqual(1);

        // --- assert ON DISK (the same surface as the Kiro CLI twin) ------------
        // Same core, so the artifacts must be the same. A difference here would
        // mean the shell changed the methodology, which is the thing every
        // distribution promises not to do.
        const icDir = join(seededRecordDir(sandbox), "ideation", "intent-capture");
        expect(existsSync(icDir)).toBe(true);

        const questionsFile = findArtifact(icDir, ["questions"]);
        expect(questionsFile).not.toBeNull();
        const questionsBody = readFileSync(questionsFile as string, "utf8");
        expect((questionsBody.match(/\[Answer\]:/g) ?? []).length).toBeGreaterThan(0);
        const confirmation = markdownH2Section(questionsBody, "Consolidated Summary Confirmation");
        expect(confirmation).toMatch(/^\[Answer\]: Looks correct\s*$/m);
        expect(questionsBody).toContain("## Sources");

        const intentFile = findArtifact(icDir, ["intent", "statement"]);
        expect(intentFile).not.toBeNull();
        const intentBody = readFileSync(intentFile as string, "utf8");
        expect(Buffer.byteLength(intentBody, "utf8")).toBeGreaterThan(100);
        expect(intentBody).toContain("## Assumptions & Open Questions");

        const stakeholderFile = findArtifact(icDir, ["stakeholder"]);
        expect(stakeholderFile).not.toBeNull();
        expect(readFileSync(stakeholderFile as string, "utf8")).toContain(
          "## Assumptions & Open Questions",
        );

        const stateMd = readFileSync(seededStateFile(sandbox), "utf8");
        const xCount = (stateMd.match(/^- \[x\]/gm) ?? []).length;
        const completedMatch = /\*\*Completed\*\*:[ \t]*(\d+)/.exec(stateMd);
        expect(completedMatch).not.toBeNull();
        expect(Number.parseInt((completedMatch as RegExpExecArray)[1], 10)).toBe(xCount);
        expect(xCount).toBeGreaterThan(3);
        expect(stateMd).toContain("IDEATION");
        expect(stateMd).toMatch(/- \[x\] intent-capture/);

        const auditMd = readAllAuditShards(sandbox);
        expect(auditMd).toMatch(/STAGE_COMPLETED/);
        expect(auditMd.toLowerCase()).toContain("intent-capture");

        // --- what only this journey can prove: the manifests FIRED ------------
        // Everything above would also pass on a tree whose hooks were merely
        // present. These four assertions read the side effects that only a fired
        // hook leaves, and they come last so a firing gap reports as itself
        // rather than masking the journey result.
        //
        // 1. PostToolUse (aidlc-write-audit-log.json): the audit trail exists at
        //    all, which the asserts above already used — kept explicit here as the
        //    baseline of the firing evidence.
        expect(auditMd.length).toBeGreaterThan(0);
        // 2. Every hook that runs writes a heartbeat under the record dir. A
        //    non-empty dir is the tree-wide "at least the spine fired" signal.
        const healthDir = join(seededRecordDir(sandbox), ".aidlc-hooks-health");
        expect(existsSync(healthDir)).toBe(true);
        expect(readdirSync(healthDir).length).toBeGreaterThan(0);
        // 3. UserPromptSubmit (aidlc-verb-intercept.json): the seam bumps the
        //    turn clock on every human turn, before any classification. The file
        //    existing is the proof that a UserPromptSubmit manifest executed.
        expect(existsSync(join(sandbox, "aidlc", ".aidlc-turn-counter"))).toBe(true);
        // 4. The human-presence mint (aidlc-record-human-turn.json): the gate
        //    refuses an approval unless a HUMAN_TURN was recorded since the last
        //    gate resolution, so an approved stage above implies it fired — assert
        //    the event directly rather than inferring it.
        expect(auditMd).toContain("HUMAN_TURN");
      } catch (err) {
        // Keep the evidence. A live journey costs real credits and ~18 minutes,
        // so a failed run must leave the sandbox and the final frame behind
        // instead of deleting the only copy of what went wrong.
        keepSandbox = true;
        try {
          writeFileSync(
            join(sandbox, "final-screen.txt"),
            drive(["capture", "--session", session]).stdout,
            "utf8",
          );
        } catch {
          /* best-effort dump */
        }
        console.error(`[t-tui-kiro-unified] sandbox retained for post-mortem: ${sandbox}`);
        throw err;
      } finally {
        drive(["kill", "--session", session]);
        if (!keepSandbox) cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
