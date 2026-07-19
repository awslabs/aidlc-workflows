// covers: stage:inception/requirements-analysis
//
// t-tui-t74-requirements-analysis.serial.tui.test.ts — drive the
// requirements-analysis Inception stage through a REAL claude TUI and prove the
// stage commits its artefacts + advances workflow state ON DISK, answering every
// rendered AskUserQuestion gate by keystroke. A faithful PATTERN-B port of the
// bash journey tests/integration/t74-stage-requirements-analysis.sh, which
// AUTO-APPROVED the requirements gate headlessly, so the interactive review
// a real user lives (answering the questions menu, then the approval gate) was
// NEVER exercised. This rewrite answers the painted gates with the shared
// `answer-gate` primitive, terminating on the on-disk requirements artefact.
//
// WHAT IT PROVES (equal-or-stronger than the .sh on the same on-disk surface):
//   The .sh seeds a brownfield Todo app, mid-inception state (Current Stage ==
//   requirements-analysis — a redo jump, so aidlc-jump does NOT terminate; the
//   stage's own gate runs, approve auto-advances to the next in-scope stage), and
//   4 pre-seeded reverse-engineering artefacts. After the stage runs it asserts:
//     1  requirements-analysis directory created          -> covered by terminator + dir read
//     2  a requirements artefact exists (not the questions file)
//     3  requirements artefact > 200 bytes
//     4  requirements artefact has markdown (^#) headings
//     5/6 Todo / React|TypeScript mentions               -> SKIP in .sh (LLM varies); NOT ported
//                                                            as a hard assert (would weaken to chase
//                                                            green) — left to the LLM-content tier.
//     7  a questions file exists
//     8  the questions file has >0 [Answer]: tags filled  (the interactive answers landed)
//     9  state marks `[x] requirements-analysis`
//     10 Current Stage advanced PAST requirements-analysis
//     11 completed count > 4 (3 init + RE + requirements)
//     12 the 4 RE artefacts are still intact (not overwritten)
//   This port asserts 1-4 + 7-12 ON DISK with node:fs after the gates are answered
//   (it deliberately does NOT port the two LLM-content SKIPs as hard asserts — per
//   the IRON RULE, asserting LLM phrasing would force a soften-to-green).
//   It ADDS the tui-only value-add the SDK/`claude -p` path is blind to: the
//   captured grid showed a waiting AskUserQuestion menu (the `❯` caret + the
//   `Enter to select` / `Submit answers` footer) at least once during the run.
//
// WHY PATTERN B (multi-gate journey, not landed+rendered): requirements-analysis
// is a full gated stage (it authors a questions file, then in the interactive
// path presents an answer menu and an approval gate) before
// writing requirements.md. There is no single deterministic "landed" statusline
// to await; the journey only completes when the artefact lands after the gates
// clear. So we drive the gates with `answer-gate` and terminate on the artefact
// (§3, D-TUI-3: the disk signal terminates, never the screen).
//
// FINDING (terminator glob — surfaced, handled faithfully, NOT softened):
//   The stage writes TWO files under the stage dir (stage frontmatter
//   `outputs:`, requirements-analysis.md:35):
//       requirements.md                          (the final artefact)
//       requirements-analysis-questions.md       (the questions file, authored FIRST)
//   The spec's table reads `--until-file "...*requirements*" (exclude *questions*)`,
//   but tui-drive `--until-file` globs ONE path segment and CANNOT express an
//   exclusion — a `*requirements*` glob matches the questions file too, and the
//   questions file lands BEFORE requirements.md (stage step order: questions at
//   :92, requirements at :116). A loose `*requirements*` glob would therefore
//   terminate on the questions file, stopping the journey BEFORE the requirements
//   artefact is written — a false-early stop that would red the requirements
//   asserts for the WRONG reason. To honour the spec's "exclude *questions*"
//   intent deterministically, the terminator pins the EXACT final-artefact name
//   `requirements.md` (no wildcard — the questions file does not match it). This
//   is the .sh's `-name "*requirements*" -not -name "*questions*"` expressed in a
//   glob the driver can evaluate, and it is STRONGER (it waits for the real
//   terminal artefact, not whichever requirements-named file appears first).
//   If a future stage renames its requirements artefact, this terminator stops
//   matching and the test reds — that red is the test surfacing the rename, the
//   correct behaviour.
//
// REACHABILITY: a full requirements-analysis run is several minutes of real LLM
// turns plus two gate round-trips; the per-gate/overall timeouts are HANG
// BACKSTOPS (answer-gate errors loud, never "concludes done"). The .sh ran with
// AIDLC_TEST_TIMEOUT=900; this honours the same convention.
//
// COST: spends real Bedrock tokens (minutes-long LLM turns). Gated behind
// AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs it; tmux/claude/
// distributable absence also SKIPs with a reason — never a hollow pass.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts (node on
// Windows so node-pty never loads under bun, #748; bun elsewhere). The
// answer-gate loop lives in the driver — one implementation, both backends. The
// `tui-drive.ts` spawn is what DERIVES the `tui` mechanism (Phase 0); no filename
// mechanism segment is needed. Platform-invariant: the asserts are plain-text grid
// + on-disk reads, so the Windows node-pty backend (validated via SSM later)
// captures them identically. Only `resolveWinNode` is imported.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  seededCodekbDir,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
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

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the .sh set 900 and
// the integration tier sets 600). A full requirements-analysis run-through is
// several minutes of real LLM turns plus two gates, so the bun:test cap is
// generous.
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
    return "set AIDLC_TUI_LIVE=1 to run the live requirements-analysis journey (uses Bedrock tokens)";
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

describe("t-tui-t74-requirements-analysis (answering AUQ gates commits the requirements artefact + advances disk state)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `requirements-analysis run-through writes requirements.md + advances state on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_t74_${process.pid}`;
      // Mirror the .sh setup_integration_project: brownfield Todo app, mid-inception
      // state (Current Stage == requirements-analysis, a redo jump), 4 pre-seeded
      // RE artefacts, and a seeded audit.md the workflow appends to.
      const sandbox = setupTuiProject({
        withState: "state-mid-inception.md",
        brownfieldStub: true,
        reArtifacts: true,
        withAudit: true,
        runtimeGraph: true,
      });
      // The render value-add: tail the grid during the run to prove a waiting
      // AskUserQuestion menu (caret + footer) painted at least once — what the
      // SDK / `claude -p` path can't see.
      let sawMenuCaret = false;
      let sawSelectFooter = false;
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
        // Seeded mid-inception -> the statusline paints the workflow phase
        // (INCEPTION), not the fresh "ready" line. Either is a valid pre-prompt
        // resting state, but the seeded fixture is INCEPTION.
        expect(waitFor(session, "\\[AIDLC\\].*(INCEPTION|ready)", 45000, 800)).toBe(true);

        // --- submit the stage jump --------------------------------------------
        // The slash command has spaces -> send literally with no auto-Enter, then
        // Enter as a named key (the template's exact two-step). The fixture's
        // Current Stage already equals the target, so aidlc-jump treats this as a
        // redo and does NOT terminate — the stage's own gate runs interactively.
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --stage requirements-analysis",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Confirm the workflow is live (the stage is running — statusline shows a
        // live phase). --stable-ms 0: the screen is streaming (token counter /
        // spinner), so match the instant the phase text appears.
        expect(
          waitFor(session, "\\[AIDLC\\].*(INCEPTION|IDEATION|CONSTRUCTION)", 120000, 0),
        ).toBe(true);

        // Begin tailing the grid for the render assertion BEFORE answer-gate runs,
        // so we catch the waiting menu caret + footer while the gates are up. The
        // highlighted-option caret is PLATFORM-VARIANT: `❯` (U+276F) under tmux on
        // macOS/Linux, but the real claude DOWNGRADES it to ASCII `>` under Windows
        // ConPTY (proven by reading grid.txt on the EC2 box 2026-06-06). So we match
        // the caret only when it precedes a numbered option (`❯ 1.` / `> 1.`) — the
        // same shape gridHasMenu() uses; a bare `>` input prompt has no `<digit>.` and
        // cannot satisfy it. This keeps the render proof honest on both platforms.
        const caretOnOption = /^\s*(?:❯|>)\s+\d+\.\s/m;
        pollTimer = setInterval(() => {
          const grid = drive(["capture", "--session", session]).stdout;
          if (caretOnOption.test(grid)) sawMenuCaret = true;
          if (grid.includes("Enter to select") || grid.includes("Submit answers")) {
            sawSelectFooter = true;
          }
        }, 1000);

        // --- answer the gates via the shared answer-gate primitive (§3) -------
        // It answers every tab/menu by taking the Recommended default (Enter) and
        // TERMINATES on the on-disk requirements artefact. Terminator pins the
        // exact final-artefact name `requirements.md` (see FINDING above) so the
        // loop does not stop early on the questions file. Run it as a long-lived
        // subprocess; its own backstops error loud, so a hang surfaces as nonzero.
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
              // Terminate on the POST-APPROVAL state signal, not the requirements.md
              // file. The artefact is written at Step 5 (generation), but the stage
              // is only marked `[x]` / Last Completed Stage / Current-Stage-advanced
              // at Step 7 (approval). Terminating on the file stopped the answer-gate
              // BEFORE the approval gate (verified live 2026-06-06: terminator met
              // after 7 answers, requirements.md present, but `[x] requirements-
              // analysis` was false — the t73 terminator-race). The approve tool
              // writes `- **Last Completed Stage**: requirements-analysis` atomically
              // with GATE_APPROVED + STAGE_COMPLETED, so this signal means the stage
              // genuinely completed AND was approved — the post-condition assertions
              // 9/10/11 (the `[x]` mark, Current-Stage-advanced, completed>4) require.
              "--until-state-field",
              "Last Completed Stage=^requirements-analysis$",
              // No per-gate timeout: requirements-analysis may legitimately spend
              // more than 200s before the first menu while reading inputs and
              // writing memory/questions. The live NDJSON trace captured that exact
              // active-progress path, so only the overall wedge ceiling should kill
              // the answer loop.
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

        // --- assert ON DISK (the .sh's surface, equal-or-stronger) ------------
        const reqDir = join(seededRecordDir(sandbox), "inception", "requirements-analysis");

        // .sh test 1: requirements-analysis directory created.
        expect(existsSync(reqDir)).toBe(true);

        // .sh test 2: a requirements artefact exists that is NOT the questions
        // file (the same -name "*requirements*" -not -name "*questions*" filter).
        const entries = readdirSync(reqDir);
        const reqFiles = entries.filter(
          (f) => /requirements/i.test(f) && !/questions/i.test(f) && f.endsWith(".md"),
        );
        expect(reqFiles.length).toBeGreaterThanOrEqual(1);
        const reqPath = join(reqDir, reqFiles[0]);
        const reqBody = readFileSync(reqPath, "utf8");

        // .sh test 3: requirements artefact > 200 bytes (byte length, not char).
        expect(Buffer.byteLength(reqBody, "utf8")).toBeGreaterThan(200);

        // .sh test 4: requirements artefact has at least one markdown (^#) heading.
        expect(/^#/m.test(reqBody)).toBe(true);

        // .sh tests 5/6 (Todo / React|TypeScript mentions) are SKIP in the .sh
        // because LLM output varies — NOT ported as hard asserts (the IRON RULE:
        // asserting LLM phrasing would force a soften-to-green). Left to the
        // LLM-content tier.

        // .sh test 7: a questions file exists.
        const questionsFiles = entries.filter((f) => /questions/i.test(f) && f.endsWith(".md"));
        expect(questionsFiles.length).toBeGreaterThanOrEqual(1);
        const questionsBody = readFileSync(join(reqDir, questionsFiles[0]), "utf8");

        // .sh test 8: the questions file has >0 [Answer]: tags filled — the proof
        // the interactive gate answers actually landed on disk (the whole point of
        // this rewrite: a REAL keystroke-answered gate, not an auto-approve).
        const answerCount = (questionsBody.match(/\[Answer\]:/g) ?? []).length;
        expect(answerCount).toBeGreaterThan(0);

        // .sh tests 9-11: state advanced.
        const stateMd = readFileSync(seededStateFile(sandbox), "utf8");

        // test 9: state marks `[x] requirements-analysis` (case-insensitive, the
        // .sh's grep -qi '\[x\] requirements-analysis').
        expect(/\[x\][ \t]*requirements-analysis/i.test(stateMd)).toBe(true);

        // test 10: Current Stage advanced PAST requirements-analysis. The fixture
        // seeds Current Stage == requirements-analysis; after the gate's approve
        // auto-advances, the Current Stage line must no longer name it.
        const currentLine =
          stateMd.split("\n").find((l) => /Current Stage/i.test(l)) ?? "";
        expect(currentLine).not.toMatch(/requirements-analysis/i);

        // test 11: completed count > 4 (3 init + RE + requirements). The .sh counts
        // lines matching `^- [x]` (`grep -c '^\- \[x\]'`).
        const completedCount = (stateMd.match(/^- \[x\]/gm) ?? []).length;
        expect(completedCount).toBeGreaterThan(4);

        // .sh test 12: the pre-seeded RE artifacts are still intact (not
        // overwritten) in the canonical space-level codekb directory.
        const reDir = seededCodekbDir(sandbox);
        expect(existsSync(reDir)).toBe(true);
        const reCount = readdirSync(reDir).filter((f) => f.endsWith(".md")).length;
        expect(reCount).toBeGreaterThan(3);

        // --- ADDED on-disk strengthening (audit emission the .sh did not check) -
        // The interactive stage commit emits STAGE_COMPLETED (and the gate emits
        // GATE_APPROVED). The .sh asserted only state lines; this also pins the
        // audit emission the interactive path produces, on the same surface
        // the workshop port asserts (`**Event**: <type>` line, aidlc-audit.ts:258).
        const auditMd = readAllAuditShards(sandbox);
        const auditLines = auditMd.split("\n");
        const stageCompleted = auditLines.filter((l) =>
          l.startsWith("**Event**: STAGE_COMPLETED"),
        ).length;
        expect(stageCompleted).toBeGreaterThanOrEqual(1);
        const gateApproved = auditLines.filter((l) =>
          l.startsWith("**Event**: GATE_APPROVED"),
        ).length;
        expect(gateApproved).toBeGreaterThanOrEqual(1);

        // --- learnings-before-gate ordering (guards the §13 turn binding) ------
        // The last QUESTION_ANSWERED (the learnings "anything to add?" answer)
        // must precede the last STAGE_AWAITING_APPROVAL: the ritual is its own
        // logged turn BEFORE the gate opens. Mirrors the kiro bugfix-scope pin;
        // without it a gate-before-learnings regression passes this test.
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

        // --- render assertion (the tui-only value-add) ------------------------
        // The captured grid showed a waiting AskUserQuestion menu (the `❯` caret +
        // the select / submit footer) at least once during the run — exactly what
        // the SDK / `claude -p` path is blind to. This is the proof a REAL gate
        // was painted and answered by keystroke, not auto-approved.
        expect(sawMenuCaret).toBe(true);
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
