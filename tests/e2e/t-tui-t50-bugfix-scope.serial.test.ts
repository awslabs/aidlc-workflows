// covers: scope:bugfix
//
// t-tui-t50-bugfix-scope.serial.tui.test.ts — drive the BUGFIX-scope workflow
// through a REAL claude TUI and prove that answering its rendered AskUserQuestion
// gates by keystroke advances the bugfix lifecycle to a real on-disk milestone
// (§5.1). A REWRITE (not a port) of tests/e2e/t50-workflow-bugfix-scope.sh,
// which ran the whole journey headlessly so every gate AUTO-APPROVED, so the
// interactive bugfix journey a user actually lives was never tested. This drives the
// painted TUI like a human, answers each gate by Enter (the Recommended default),
// and TERMINATES on the on-disk Completed counter crossing the post-init milestone.
//
// What it proves (PATTERN B — multi-gate journey, answer-gate --until-state-field):
//   - a bugfix workflow starts from `/aidlc bugfix` on a fresh BROWNFIELD workspace
//     (statusline leaves `ready` for a live phase),
//   - the answer-gate clears the Initialization + Inception gates (bugfix SKIPS all
//     of Ideation per scope-mapping.json) by taking the Recommended default per
//     menu, with NO auto-approve,
//   - answering advances REAL state on disk — the SAME milestone the .sh asserted
//     (the .sh never claimed full completion; its strongest stage assertion was
//     "more than 4 stages completed" = init 3 + >= 2 post-init, plus "at least one
//     Inception stage progressed"):
//       * the Completed counter crosses 5 (init=3 + >= 2 Inception); this is the
//         answer-gate terminator (--until-state-field "Completed=([5-9]|[1-9][0-9])"),
//       * the born intent's aidlc-state.md records the `bugfix` scope + a brownfield
//         classification (.sh tests 3 + 16),
//       * State Version is 7 (.sh test 12),
//       * MORE than 4 stages are marked complete `- [x]` (.sh test 13),
//       * the Completed counter EQUALS the `- [x]` grid count — the invariant the
//         framework maintains (aidlc-state.ts:256-258 syncs Completed to
//         countCheckboxes(...,"completed")); the .sh implied this by greping both,
//       * all 3 Initialization stages are `[x]` (.sh tests 4-6),
//       * at least one Inception stage progressed — reverse-engineering or
//         requirements-analysis `[x]` (.sh test 8),
//       * Current Stage is PAST the Initialization phase (the workflow advanced),
//       * the reverse-engineering directory exists with >= 4 structured `.md`
//         artifacts, at least one > 200 bytes, carrying markdown headings (.sh
//         tests 18-19, 22-23),
//       * the space-level knowledge directory was created (.sh test 11),
//       * audit.md has substantial content (> 200 bytes) (.sh test 14),
//   - RENDER (the tui-only value-add): the captured grid showed a gate menu
//     (`❯` caret + the `Enter to select` / `Submit answers` footer) at least once —
//     the thing the SDK path cannot see.
//
// WHY PATTERN B (not A): bugfix is a MULTI-STEP journey (Initialization +
// Inception run-through, gate-by-gate), not a single landed jump. Per the
// driver-split invariant, every multi-step journey is TUI-driven; a one-shot SDK
// check would have to rebuild the headless auto-approve fake the mission kills.
//
// WHY a MILESTONE terminator (not full bugfix completion): the .sh ITSELF never
// asserted full bugfix completion — its strongest stage assertion (test 13) was
// "more than 4 stages completed" and (test 8) "at least one Inception stage
// progressed". We terminate the answer-gate on the Completed counter reaching 5
// (init 3 + the 2 Inception stages bugfix executes: reverse-engineering +
// requirements-analysis), then assert the same equal-or-stronger invariants on
// disk. We do NOT crank the budget to chase Construction (code-generation /
// build-and-test) — that would be racy/over-reach (the Phase-2 lesson). The .sh's
// tests 9, 24, 25 (Construction progress + requirements-analysis dir + Todo-domain)
// were `assert_gt`/`skip`-on-miss soft probes; FINDING: full bugfix completion
// through Construction is a SEPARATE, longer journey and the unreachable-in-budget
// gap is a finding to surface, not a thing to weaken the milestone to.
//
// REMOVED vs the .sh (faithfully): the .sh's test 10 and test 15 asserted a
// state field and a canonical-audit field that no longer exist (artifacts of a
// headless auto-approve mode the engine no longer has), so they are dropped (not
// weakened). The RE-artifact "mentions React" /
// "mentions Todo" checks (.sh tests 17, 20, 21) were domain-word probes that the
// .sh tied to the brownfield-todo stub; the faithful equal-or-stronger assertion is
// on STRUCTURE (>= 4 artifacts, headings, size) — LLM-authored RE output varies in
// exact wording, so hard-asserting a domain word would be brittle, not stronger. The
// brownfield-todo stub IS a React/Vite Todo app, so the domain is present in the
// scanned source; we assert the artifact SCAFFOLD the framework guarantees.
//
// COST: spends real Bedrock tokens (minutes-long LLM turns across Initialization +
// the reverse-engineering + requirements-analysis Inception stages). RE is a HEAVY
// stage (the Phase-2 note measured it > 9 min; on the slow Windows
// box it ran ~7min+ before its gate painted). The overall answer-gate deadline is
// the suite-wide UNIFORM wedge-ceiling AIDLC_TEST_TIMEOUT (default 2400s) minus a
// 30s teardown margin — a generous hang-backstop, NOT a per-stage budget (per-gate
// defaults to this same deadline now; see tui-drive cmdAnswerGate). REACHABILITY:
// the journey terminates on the on-disk Completed>=5 signal long before this; if the
// backstop ever fires that is a genuine hang FINDING (the workflow wedged), never a
// knob to turn down or a thing to soften. Gated
// behind AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs it; tmux/claude/
// distributable absence (and Windows node/node-pty resolvability) also SKIP with a
// reason — never a hollow pass.
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
import { basename, join } from "node:path";
import {
  auditFilePathFor,
  spaceKnowledgeDirFor,
  stateFilePathFor,
} from "../harness/sdk-drive.ts";
import { gridHasMenu, resolveWinNode } from "../harness/tui-drive.ts";
import { cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";
import { activeSpace } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The space-level per-repo codekb dir the RE stage writes into
// (aidlc/spaces/<space>/codekb/<repo>/ — the codekb-determinism placement fix).
// This single-repo brownfield sandbox records NO repos row, so the engine keys
// the store by basename(sandbox) (codekbRepoName's 0-repo case). Tolerant of the
// bare workspace-root form too, mirroring the journey / t-acp-kiro helpers.
function codekbReDir(sandbox: string): string {
  const spaceScoped = join(sandbox, "aidlc", "spaces", activeSpace(sandbox), "codekb", basename(sandbox));
  const bare = join(sandbox, "aidlc", "codekb", basename(sandbox));
  return existsSync(spaceScoped) ? spaceScoped : bare;
}

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

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the integration tier
// sets 600). A bugfix run-through (Initialization + the heavy reverse-engineering
// stage + requirements-analysis, real LLM turns) is several minutes, so the
// bun:test cap is generous.
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
    return "set AIDLC_TUI_LIVE=1 to run the live bugfix journey (uses Bedrock tokens)";
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

describe("t-tui-t50-bugfix-scope (answering gates advances bugfix lifecycle on disk)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `bugfix run-through reaches the post-init milestone (Completed>=5) on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_t50_bugfix_${process.pid}`;
      // brownfieldStub + noAidlcDocs: a brand-new brownfield workspace (a React/Vite
      // Todo app) the bugfix workflow scaffolds itself, driving workspace-detection
      // to Brownfield + reverse-engineering (mirrors the .sh's
      // setup_integration_project --no-aidlc-docs --with-brownfield-stub).
      const sandbox = setupTuiProject({ brownfieldStub: true, noAidlcDocs: true });
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

        // --- submit the bugfix workflow command --------------------------------
        // Use the EXPLICIT `--scope bugfix` flag, not the bare freeform `bugfix`
        // keyword. The shipped distributable settings.json pins
        // AWS_AIDLC_DEFAULT_SCOPE=workshop, so a bare freeform `/aidlc bugfix ...`
        // is a freeform-vs-env CONFLICT: SKILL.md step 0 (:105) only skips env
        // substitution when `$ARGUMENTS` already contains the literal `--scope`
        // token, so the bare keyword triggers a 3-way scope disambiguation gate at
        // workflow START (bugfix vs the workshop env-default vs keyword-autodetect's
        // feature) — verified live 2026-06-06: the run stalled on that gate before
        // any phase, failing the phase-wait below. (That conflict is t29 case 3's
        // job, not t50's.) The explicit `--scope bugfix` flag WINS silently and
        // gatelessly (SKILL.md:105 "explicit CLI flag wins" + :170a auto-confirm;
        // proven live by t29's override case), so t50 cleanly tests the bugfix
        // LIFECYCLE without the env-default derail. The trailing description still
        // flows to the known-scope handler (SKILL.md:122: `--scope bugfix` with no
        // state "behaves like /aidlc bugfix") so the step-6 free-text "what to
        // build?" prompt is satisfied up front (answer-gate can't type free text).
        // Send literally (spaces) with no auto-Enter, then Enter as a named key.
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --scope bugfix the todo checkbox state is not persisted after page reload",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Begin tailing the grid for the render assertion BEFORE answer-gate runs,
        // so we catch the statusline phase transition and a gate menu while the
        // gates are up. Do not require the phase to paint before answer-gate starts:
        // current live runs can spend >120s bootstrapping init while the statusline
        // still shows `[AIDLC] ready`; the on-disk Completed terminator below is the
        // deterministic start/progress proof. Use the shared gridHasMenu() so the
        // caret is matched platform-invariantly (`❯` on tmux, ASCII `>` on Windows
        // ConPTY — the same detector the answer-gate uses).
        pollTimer = setInterval(() => {
          const grid = drive(["capture", "--session", session]).stdout;
          if (gridHasMenu(grid)) {
            sawMenu = true;
          }
        }, 1000);

        // --- answer the gates via the shared answer-gate primitive (§3) --------
        // It answers all tabs/gates by taking the Recommended default and
        // TERMINATES when aidlc-state.md's Completed counter reaches the post-init
        // milestone — `Completed=([5-9]|[1-9][0-9])` means >= 5 (init 3 + the 2
        // Inception stages bugfix executes: reverse-engineering +
        // requirements-analysis). This is the .sh's "more than 4 completed" (test
        // 13) expressed as a disk terminator; the Completed field is synced to the
        // `[x]` grid by the framework (aidlc-state.ts:256-258), so the counter IS
        // the grid count. Run it as a long-lived subprocess; its own backstops
        // error loud, so a hang surfaces as a nonzero exit (never a manufactured
        // pass — IRON RULE).
        //
        // NO per-gate timeout. The pass condition is the on-disk terminator
        // (Completed>=5); the gate loop returns the instant that lands. We do NOT
        // assert "a menu must appear within N seconds" — that is a budget masquerading
        // as a backstop, and it false-fired here: bugfix's first Inception stage is
        // reverse-engineering (a `mode: pipeline` stage) that legitimately runs
        // minutes with no menu, and runs SLOWER on the Windows box, so a fixed
        // per-gate value (200s, then 360s) killed a WORKING run mid-RE (`answered 0`).
        // Omitting it lets per-gate default to the overall deadline (one hang-backstop
        // that only a genuine wedge can trip); the overall timeout (TEST_TIMEOUT_MS -
        // 30s) bounds the journey and bun's test cap is the hard ceiling above that.
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
              "Completed=([5-9]|[1-9][0-9])",
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
        // .sh tests 1 + 2: state + audit files created (readFileSync throws if not).
        const stateMd = readFileSync(stateFilePathFor(sandbox), "utf8");

        // .sh test 3: bugfix scope recorded ([Bb]ugfix).
        expect(stateMd).toMatch(/bugfix/i);
        // .sh test 16: state classifies the project as brownfield.
        expect(stateMd).toMatch(/brownfield/i);
        // .sh test 12: State Version is 7.
        expect(stateMd).toMatch(/State Version\*\*:[ \t]*7\b/);

        // .sh tests 4-6: all 3 Initialization stages marked completed `[x]`.
        for (const stage of ["workspace-scaffold", "workspace-detection", "state-init"]) {
          expect(
            new RegExp(`- \\[x\\] ${stage}\\b`, "i").test(stateMd),
          ).toBe(true);
        }

        // .sh test 13: MORE than 4 stages completed (init 3 + >= 2 post-init). Count
        // `- [x]` lines in the grid.
        const completedGrid = stateMd.split("\n").filter((l) => /^- \[x\]/.test(l)).length;
        expect(completedGrid).toBeGreaterThan(4);

        // The framework invariant the .sh implied by greping both surfaces: the
        // Completed counter EQUALS the `- [x]` grid count (aidlc-state.ts syncs it).
        // Assert counter==grid so a desynced state file is a finding, not silent.
        const counterMatch = /Completed\*\*:[ \t]*(\d+)/.exec(stateMd);
        expect(counterMatch).not.toBeNull();
        const completedCounter = Number((counterMatch as RegExpExecArray)[1]);
        expect(completedCounter).toBe(completedGrid);
        // And the terminator's own contract: the counter is at the milestone.
        expect(completedCounter).toBeGreaterThanOrEqual(5);

        // .sh test 8: at least one Inception stage progressed — reverse-engineering
        // or requirements-analysis marked `[x]`.
        const inceptionProgressed =
          /- \[x\] reverse-engineering\b/i.test(stateMd) ||
          /- \[x\] requirements-analysis\b/i.test(stateMd);
        expect(inceptionProgressed).toBe(true);

        // The workflow advanced PAST Initialization: Current Stage is not an init
        // stage. (At the Completed>=5 milestone the orchestrator is on an Inception
        // or Construction stage; the exact stage varies, so assert it is NOT one of
        // the three init stages rather than pinning a single value.)
        const curStageMatch = /Current Stage\*\*:[ \t]*([^\r\n]+)/.exec(stateMd);
        expect(curStageMatch).not.toBeNull();
        const currentStage = (curStageMatch as RegExpExecArray)[1].trim();
        expect(
          ["workspace-scaffold", "workspace-detection", "state-init"].includes(currentStage),
        ).toBe(false);

        // .sh test 11: knowledge directory created. The knowledge relocation
        // (b29ced6) moved this from the per-intent record to the SPACE level
        // (aidlc/spaces/<space>/knowledge — a sibling of intents/), ensured at
        // birth by ensureWorkspaceDirs (aidlc-utility.ts:1975, which runs in the
        // workspace-scaffold init stage for every scope, bugfix included).
        const knowledgeDir = spaceKnowledgeDirFor(sandbox);
        expect(existsSync(knowledgeDir) && statSync(knowledgeDir).isDirectory()).toBe(true);

        // .sh tests 18-19, 22-23: the reverse-engineering directory exists with
        // >= 4 `.md` artifacts, carries markdown headings, and at least one is
        // > 200 bytes. bugfix on a brownfield workspace ALWAYS runs RE, so this is
        // a hard scaffold assertion, not a soft probe. RE now writes to the
        // SPACE-LEVEL per-repo codekb store, NOT the per-intent record dir (the
        // codekb-determinism placement fix).
        const reDir = codekbReDir(sandbox);
        expect(existsSync(reDir) && statSync(reDir).isDirectory()).toBe(true);
        const reFiles = readdirSync(reDir).filter((f) => f.endsWith(".md"));
        // .sh test 19: >= 4 RE .md artifacts (assert_gt 3).
        expect(reFiles.length).toBeGreaterThan(3);
        // .sh test 22: at least one RE artifact has a markdown heading.
        const reWithHeading = reFiles.filter((f) =>
          /^#/m.test(readFileSync(join(reDir, f), "utf8")),
        ).length;
        expect(reWithHeading).toBeGreaterThan(0);
        // .sh test 23: at least one RE artifact > 200 bytes.
        const reBig = reFiles.filter((f) => statSync(join(reDir, f)).size > 200).length;
        expect(reBig).toBeGreaterThan(0);

        // .sh test 14: audit log exists with substantial content (> 200 bytes).
        // P9 shards audit per clone; a single live process writes one shard.
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
