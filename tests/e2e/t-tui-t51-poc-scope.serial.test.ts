// covers: scope:poc
//
// t-tui-t51-poc-scope.serial.tui.test.ts — drive the POC-scope workflow through a
// REAL claude TUI and prove that answering its rendered AskUserQuestion gates by
// keystroke advances POC's Ideation phase to a real on-disk artifact (§5.1). A
// REWRITE (not a port) of tests/e2e/t51-workflow-poc-scope.sh, which ran the
// whole journey headlessly so every gate AUTO-APPROVED, so the interactive
// poc journey a user actually lives was never tested. This drives the painted TUI
// like a human, answers each gate by Enter (the Recommended default), and
// TERMINATES on the on-disk `Completed>=7` milestone.
//
// What it proves (PATTERN B — multi-gate journey, answer-gate --until-state-field):
//   - a POC workflow starts from `/aidlc poc` on a fresh greenfield workspace
//     (statusline leaves `ready` for a live phase),
//   - the answer-gate clears the Initialization + early-Ideation gates by taking
//     the Recommended default per menu, with NO auto-approve,
//   - answering advances REAL state on disk — the milestone the .sh asserted
//     (POC, unlike bugfix, includes Ideation, so intent-capture runs):
//       * the intent-capture intent-statement artifact exists & is non-empty,
//       * the born intent's aidlc-state.md records the `poc` scope and a greenfield
//         classification,
//       * <record>/ideation/ exists with a questions file carrying filled
//         [Answer]: lines and at least one structured (heading-bearing) artifact,
//       * MORE than 6 stages are marked complete `- [x]` (POC > bugfix; the .sh's
//         test 10 — 3 init + Ideation stages),
//       * audit.md has substantial content,
//   - RENDER (the tui-only value-add): the captured grid showed a gate menu
//     (`❯` caret + the `Enter to select` / `Submit answers` footer) at least once —
//     the thing the SDK path cannot see.
//
// WHY PATTERN B (not A): poc is a MULTI-STEP journey (full Ideation run-through
// gate-by-gate), not a single landed jump. Per the driver-split invariant, every
// multi-step journey is TUI-driven; a one-shot SDK check would have to rebuild the
// headless auto-approve fake the mission kills.
//
// WHY a MILESTONE terminator (not full poc completion): the .sh itself never
// asserted full poc completion — its strongest stage assertion was "> 6 completed"
// (test 10) plus the intent artifact (test 15). We terminate the answer-gate on the
// `Completed>=7` state milestone, then assert the same `> 6 completed` invariant on
// disk. We do NOT crank the budget to chase full poc completion — that would be
// racy/over-reach (the Phase-2 lesson). If a reviewer needs full poc completion
// proven, that is a SEPARATE, longer journey and the unreachable-in-budget gap is a
// FINDING, not a thing to weaken to.
//
// REMOVED vs the .sh (faithfully): the .sh's test 12 asserted a state field that
// no longer exists (an artifact of a headless auto-approve mode the engine no
// longer has), so it is dropped (not weakened). The
// intent-artifact "mentions Todo/task" check (.sh test 16) was a `skip`-on-miss
// LLM-output check, so it is NOT hard-asserted here either (LLM output varies); the
// greenfield-todo stub is a React Todo README, so the domain is present, but the
// faithful equal-or-stronger assertion is on STRUCTURE (headings + size + answers),
// not on a specific domain word.
//
// COST: spends real Bedrock tokens (minutes-long LLM turns across Initialization +
// Ideation). Gated behind AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs it;
// tmux/claude/distributable absence (and Windows node/node-pty resolvability) also
// SKIP with a reason — never a hollow pass.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts (node on Windows
// so node-pty never loads under bun, #748; bun elsewhere). The answer-gate loop
// lives in the driver — one implementation, both backends. Platform-invariant
// plain-text grid asserts (no colour escapes), so the Windows node-pty backend
// captures identically; the SSM leg runs the same file.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { auditFilePathFor, recordDirFor, stateFilePathFor } from "../harness/sdk-drive.ts";
import { gridHasMenu, resolveWinNode } from "../harness/tui-drive.ts";
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

// Hang-backstop, NOT a budget. The poc `Completed>6` milestone requires driving
// the FULL poc lifecycle for real — intent-capture, requirements-analysis, then
// the heavy code-generation (writes the actual app) + build-and-test stages. The
// journey TERMINATES on the on-disk `Completed` signal (never a timer); this cap
// only ever fires as a loud hang-backstop. The default is the suite-wide UNIFORM
// wedge-ceiling (2400s/40min) shared by every token-spending tui test, set
// generously ABOVE the slowest measured journey (poc ~1038s, same on macOS and the
// Windows box) so LLM-turn variance never clips a legitimately-working run. A tight
// per-journey budget is exactly what we DON'T want — it false-fires on a slow
// platform (the t101 900s clip). If this backstop fires, that is a real hang
// FINDING, not a knob to turn. AIDLC_TEST_TIMEOUT (seconds) overrides per run.
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
    return "set AIDLC_TUI_LIVE=1 to run the live poc journey (uses Bedrock tokens)";
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

describe("t-tui-t51-poc-scope (answering gates advances poc Ideation on disk)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `poc run-through produces the intent-capture artifact + > 6 completed stages on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_t51_poc_${process.pid}`;
      // greenfieldStub + noAidlcDocs: a brand-new greenfield workspace the poc
      // workflow scaffolds itself (mirrors the .sh's
      // setup_integration_project --no-aidlc-docs --with-greenfield-stub).
      const sandbox = setupTuiProject({ greenfieldStub: true, noAidlcDocs: true });
      // The render value-add: we tail the grid during the run to prove a gate
      // menu painted at least once (the SDK path can't see it).
      let sawMenu = false;
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
        // Fresh project (no seeded state) -> the no-workflow "ready" line.
        expect(waitFor(session, "\\[AIDLC\\].*ready", 45000, 800)).toBe(true);

        // --- submit the poc workflow command -----------------------------------
        // `/aidlc poc` is a single token-stream with no embedded spaces beyond the
        // scope word; send literally with no auto-Enter, then Enter as a named key
        // (the template's exact two-step, robust for slash commands).
        // Use EXPLICIT `--scope poc`, not bare freeform `poc`. The shipped
        // settings.json pins AWS_AIDLC_DEFAULT_SCOPE=workshop, so bare `/aidlc poc`
        // is a freeform-vs-env CONFLICT (poc vs workshop) → a scope disambiguation
        // gate at workflow START that stalls the phase-wait below (the t50 finding,
        // 2026-06-06). `--scope poc` wins silently+gatelessly (SKILL.md:105 explicit
        // flag wins + :170a auto-confirm; proven live by t29's override case), so
        // t51 tests the poc LIFECYCLE without the env-default derail (disambiguation
        // is t29's job). The trailing description still flows to the known-scope
        // handler (SKILL.md:122 `--scope poc` with no state behaves like /aidlc poc)
        // satisfying the step-6 free-text "what to build?" prompt up front (the
        // answer-gate cannot type free text).
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --scope poc Build a simple React todo app",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Confirm the workflow started (statusline shows a live phase, not
        // `ready`). poc begins in INITIALIZATION and advances into IDEATION.
        // --stable-ms 0: the screen is streaming (live token counter / spinner),
        // so match the instant the phase text appears.
        expect(
          waitFor(session, "\\[AIDLC\\].*(INITIALIZATION|IDEATION|INCEPTION)", 120000, 0),
        ).toBe(true);

        // Begin tailing the grid for the render assertion BEFORE answer-gate runs,
        // so we catch a gate menu (caret + footer) while the gates are up. Use the
        // shared gridHasMenu() so the caret is matched platform-invariantly (`❯` on
        // tmux, ASCII `>` on Windows ConPTY — the same detector the answer-gate uses).
        pollTimer = setInterval(() => {
          const grid = drive(["capture", "--session", session]).stdout;
          if (gridHasMenu(grid)) {
            sawMenu = true;
          }
        }, 1000);

        // --- answer the gates via the shared answer-gate primitive (§3) --------
        // It answers all tabs/gates by taking the Recommended default and
        // TERMINATES on the on-disk STATE PROGRESSION the assertions below check:
        // `Completed` reaching > 6 (the .sh's test 10, asserted at line ~269). The
        // intent-statement *file* lands mid-intent-capture (poc's 4th EXECUTE stage)
        // — terminating on it stops the gate loop at Completed≈3-4, BEFORE the >6
        // milestone, so the assertion would fail (the t73 terminator-race lesson;
        // mirrors t50's `Completed=...` state-field terminator). poc's EXECUTE chain
        // is workspace-scaffold/detection/state-init → intent-capture →
        // reverse-engineering → requirements-analysis → code-generation/build-test
        // (8 total), so `Completed` passes 6 once requirements-analysis approves —
        // exactly the milestone the assertions require. Anchored to a real ≥7 value.
        // Run it as a long-lived subprocess; its own backstops error loud, so a
        // hang surfaces as a nonzero exit (never a manufactured pass; an unreachable
        // milestone in budget is a FINDING, not a thing to soften).
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
              "--until-state-field",
              "Completed=^([7-9]|[1-9][0-9])$",
              // NO per-gate timeout. The pass condition is the on-disk terminator
              // (Completed>=7); the loop returns the instant it lands. poc's EXECUTE
              // chain includes the reverse-engineering `mode: pipeline` stage, which
              // legitimately runs minutes with no menu and runs slower on the Windows
              // box — a fixed per-gate value is a budget masquerading as a backstop and
              // false-fires on a working run. Omitting it defaults per-gate to the
              // overall deadline (one wedge-only backstop); the overall timeout bounds
              // the journey and bun's test cap is the hard ceiling above it.
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

        // --- assert ON DISK (equal-or-stronger than the .sh's greps) -----------
        const stateMd = readFileSync(stateFilePathFor(sandbox), "utf8");

        // .sh test 1: state file created (implied — readFileSync would throw).
        // .sh test 2: POC scope recorded ([Pp][Oo][Cc]).
        expect(stateMd).toMatch(/poc/i);
        // .sh test 13: state classifies greenfield.
        expect(stateMd).toMatch(/greenfield/i);
        // .sh test 10: MORE than 6 completed stages (POC includes Ideation, so it
        // produces strictly more than bugfix). Count `- [x]` lines.
        const completed = stateMd.split("\n").filter((l) => /^- \[x\]/.test(l)).length;
        expect(completed).toBeGreaterThan(6);

        // .sh test 3: ideation directory created (POC includes ideation).
        const ideationDir = join(recordDirFor(sandbox), "ideation");
        expect(existsSync(ideationDir) && statSync(ideationDir).isDirectory()).toBe(true);

        // .sh test 14: intent-capture directory exists.
        const icDir = join(ideationDir, "intent-capture");
        expect(existsSync(icDir) && statSync(icDir).isDirectory()).toBe(true);

        // .sh test 15: intent statement artifact exists & non-empty (the
        // answer-gate terminator already proved existence+non-empty; re-assert
        // here so the disk-truth lives in the test body, not only in the driver).
        const intentFile = readdirSync(icDir).find(
          (f) => /intent.*statement|intent-statement/i.test(f),
        );
        expect(intentFile).toBeDefined();
        expect(
          readFileSync(join(icDir, intentFile as string), "utf8").trim().length,
        ).toBeGreaterThan(0);

        // .sh tests 4 + 5 + 17: an intent-capture questions file exists and carries
        // filled [Answer]: lines (proves the gate answers were captured to disk,
        // not auto-stubbed). Look across the ideation tree like the .sh's find.
        const questionsFile = findFirst(ideationDir, (name) => /questions/i.test(name));
        expect(questionsFile).not.toBeNull();
        const questionsMd = readFileSync(questionsFile as string, "utf8");
        // .sh test 17: filled answers (an [Answer]: line with at least one letter).
        const filledAnswers = questionsMd
          .split("\n")
          .filter((l) => /\[Answer\]:.*[A-Za-z]/.test(l)).length;
        expect(filledAnswers).toBeGreaterThan(0);

        // .sh test 18: ideation artifacts have structure (at least one markdown
        // heading somewhere under ideation/).
        const headingFile = findFirst(
          ideationDir,
          () => true,
          (md) => /^#/m.test(md),
        );
        expect(headingFile).not.toBeNull();

        // .sh test 19: at least one ideation artifact > 100 bytes.
        const bigArtifact = findFirst(
          ideationDir,
          (name) => name.endsWith(".md"),
          (_md, size) => size > 100,
        );
        expect(bigArtifact).not.toBeNull();

        // .sh test 11: audit log exists with substantial content (> 200 bytes).
        // P9 shards audit per clone; a single live process writes exactly one
        // shard, so auditFilePathFor resolves it.
        const auditPath = auditFilePathFor(sandbox);
        expect(existsSync(auditPath)).toBe(true);
        expect(statSync(auditPath).size).toBeGreaterThan(200);

        // --- render assertion (the tui-only value-add) ------------------------
        // The captured grid showed a gate menu (caret + footer) at least once
        // during the run — what the SDK path is blind to. NOT a racy completion
        // assertion: it only records that a menu painted while gates were up.
        expect(sawMenu).toBe(true);
      } finally {
        if (pollTimer) clearInterval(pollTimer);
        drive(["kill", "--session", session]);
        cleanupTuiProject(sandbox);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// Walk a directory tree and return the absolute path of the first file matching
// nameMatch (on the basename) AND, optionally, contentMatch (on the file text +
// byte size). Mirrors the .sh's `find ... -name <glob>` greps without shelling
// out — recursive, depth-first, deterministic order (readdirSync). Returns null
// if nothing matches (so the caller's expect(...).not.toBeNull() FAILS loud
// rather than silently passing — IRON RULE: a miss is a finding).
function findFirst(
  root: string,
  nameMatch: (basename: string) => boolean,
  contentMatch?: (text: string, size: number) => boolean,
): string | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const hit = findFirst(p, nameMatch, contentMatch);
      if (hit) return hit;
    } else if (st.isFile() && nameMatch(entry)) {
      if (!contentMatch) return p;
      try {
        if (contentMatch(readFileSync(p, "utf8"), st.size)) return p;
      } catch {
        // unreadable — skip
      }
    }
  }
  return null;
}
