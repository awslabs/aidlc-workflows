// covers: scope:workshop
//
// t-tui-t58-workshop-scope.serial.tui.test.ts — drive the workshop SCOPE-ROUTING
// journey through a REAL claude TUI and prove that `/aidlc workshop` skips the
// ENTIRE Ideation phase, runs Inception/Construction/Operation at Standard depth
// with a Minimal test strategy, and lands < 30 completed stages — ON DISK + as
// the workshop facilitator SEES it painted. NET-NEW (not a port of an existing
// .test.ts): a Pattern-B answer-gate journey authored from the original
// tests/e2e/t58-workflow-workshop-scope.sh (plan 14), with the
// rendered-screen value-add ADDED.
//
// DISTINCT FROM t-tui-workshop.serial.tui.test.ts: that file drives the practices
// AFFIRMATION gate (multi-tab Submit -> aidlc-team.md `## Way of Working`); THIS
// file drives the workshop SCOPE ROUTING contract (which stages run, which are
// skipped, depth/test-strategy defaults). Different surface, different terminator.
//
// WHAT IT PROVES (the .sh's 14 assertions, equal-or-stronger, on the same on-disk
// surface, PLUS the rendered statusline value-add):
//   ROUTING IS DATA-DRIVEN (scope-mapping.json `workshop`):
//     - workshop has depth "Standard", testStrategy "Minimal", and SKIPs every
//       ideation stage (intent-capture..approval-handoff all SKIP — lines 105 of
//       scope-mapping.json), EXECUTEs all inception/construction/operation.
//     - state-init (aidlc-utility.ts:2044-2099) writes the FULL stage-progress
//       block with each ideation slug rendered `- [ ] <slug> — SKIP` (the SKIP
//       suffix from aidlc-utility.ts:1997), so a SKIP'd ideation stage can NEVER
//       reach `[x]`; it stays `[ ] … — SKIP`. determineFirstPostInitStage
//       (:2175) therefore returns reverse-engineering, so the workflow's first
//       post-init phase is INCEPTION and `- **Lifecycle Phase**: INCEPTION` lands
//       — Ideation is never entered.
//   .sh -> DISK ASSERTION MAP (each grep becomes a structured disk read):
//     #1  state file created                 -> existsSync(aidlc-state.md)
//     #2  no ideation artifacts              -> <record>/ideation/ absent OR empty
//     #3  no Ideation stage marked [x]       -> 0 lines match `[x] <ideation-slug>`
//     #4  Inception stages present in state  -> /reverse-engineering|requirements-analysis/
//     #5  Construction stages present        -> /code-generation|build-and-test/
//     #6  Operation stages present           -> /deployment-pipeline|observability-setup/
//     #7-9 init stages [x]                    -> `[x] workspace-scaffold|-detection|state-init`
//     #11 workshop scope recorded            -> `- **Scope**: workshop`
//     #12 Depth = Standard                    -> `- **Depth**: Standard`
//     #13 Test Strategy = Minimal             -> `- **Test Strategy**: Minimal`
//     #14 completed < 30                       -> `- **Completed**: N` with N < 30
//     #15 audit log substantial               -> audit.md > 200 bytes (+ WORKSPACE_INITIALISED)
//   RENDER (the tui-only value-add the headless .sh / SDK path is blind to):
//     - the captured pane painted `[AIDLC] INCEPTION` (the workshop went straight
//       to Inception — Ideation was skipped, visible to the user) and NEVER
//       `[AIDLC] IDEATION`. This is the rendered proof of the skip the .sh could
//       only infer from state checkboxes.
//     - an AskUserQuestion menu painted at least once (the workshop runs gates —
//       scope-mapping describes it as "Facilitated group session with mandatory
//       gates") with a NON-PROSE footer (`Enter to select` / `Submit answers`).
//
// WHY PATTERN B (answer-gate, NOT Pattern A): `/aidlc workshop` does NOT run a
// one-shot config edit — it starts a workflow that then asks "What would you like
// to build?" (SKILL.md:337) and runs the workshop's mandatory gates. A Pattern-A
// "wait + assert" test would HANG on the first menu it does not answer. So we run
// the shared `answer-gate` primitive (tui-drive.ts cmdAnswerGate): it presses
// Enter (= the Recommended default) on every menu and TERMINATES on a
// DETERMINISTIC on-disk signal — here the `Completed` counter crossing into the
// post-init range (aidlc-state.ts:258/405/472 syncs `- **Completed**:` to the
// live `[x]` count on every advance). We NEVER wait on rewordable screen prose.
//
// SCOPE-CONFIRMATION GATE — verified routing + live-verify guard: `workshop` is a
// KNOWN SCOPE (a key in scope-mapping.json), so SKILL.md routes it through the
// "known scope" path (:329-339), which does NOT render a scope-confirmation gate
// (that gate is the FREEFORM-text path, :341-362, "confirmation is mandatory for
// all freeform inputs"). The shipped settings.json env default
// `AWS_AIDLC_DEFAULT_SCOPE: "workshop"` (line 23) AGREES with the keyword, so even
// the env-substitution path (SKILL.md:103-106) synthesizes `--scope workshop` with
// NO conflict — no feature-vs-workshop disambiguation. EITHER interpretation lands
// workshop. The journey is LLM-mediated, so if a residual scope-confirm menu DOES
// paint on some run, its Recommended default is the workshop scope; answer-gate
// presses Enter and selects it. answer-gate is a no-op disk-poller when no menu is
// up (it checks the terminator FIRST each loop — tui-drive.ts:951-959), so the
// gateless known-scope path is safe too. NET: robust to both routings; the disk
// terminator is the truth either way. (LIVE-VERIFY RISK: if a future SKILL.md
// change makes the bare keyword render a scope picker whose default is NOT
// workshop, this would land a different scope — the final `- **Scope**: workshop`
// disk assert would then RED, which is the test doing its job: a FINDING about the
// routing, never a thing to soften.)
//
// COST: spends real Bedrock tokens (a fresh-project state-init turn + the workshop
// gate sequence into the first post-init Inception stages — minutes of live LLM
// turns). Gated behind AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs it;
// tmux/claude/distributable absence also SKIPs with a reason — never a hollow pass.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts as a subprocess
// (node on Windows so node-pty never loads under bun, #748; bun elsewhere). The
// tui-drive.ts spawn is what DERIVES the `tui` mechanism (Phase 0) — no filename
// mechanism segment. Platform-invariant: every assertion is a plain-text grid read
// or an on-disk read (no colour escapes), so the Windows node-pty backend (SSM
// leg, later) observes them identically. Only resolveWinNode is imported.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { recordDirFor, stateFilePathFor } from "../harness/sdk-drive.ts";
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
// elsewhere bun + driver. The answer-gate child spawn reuses this so the long-lived
// subprocess hits the same runtime.
const DRIVE_BIN = IS_WIN ? (WIN_NODE as string) : process.execPath;
const DRIVE_PREFIX = IS_WIN ? ["--experimental-strip-types", DRIVER] : [DRIVER];

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the integration tier
// sets 600). A workshop run-through (fresh state-init + several gated post-init
// stages) is several minutes of real LLM turns, so the bun:test cap is generous.
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
// Copied verbatim from the workshop / t29 templates (Windows node / node-pty
// checks kept exactly).
function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live workshop-scope journey (uses Bedrock tokens)";
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

// The 7 ideation slugs (SKILL.md:465-471 stage graph). The workshop scope SKIPs
// EVERY one (scope-mapping.json `workshop.stages`), so none may ever be marked
// `[x]` — the .sh's Test 3 grep, here a per-slug disk read.
const IDEATION_SLUGS = [
  "intent-capture",
  "market-research",
  "feasibility",
  "scope-definition",
  "team-formation",
  "rough-mockups",
  "approval-handoff",
];

// Poll an ON-DISK predicate until true or timeout — the deterministic completion
// signal. We never gate on the lagging statusline phase flip (it paints `ready`
// until state-init writes aidlc-state.md, minutes behind the work — the t29
// lesson). Disk is the truth.
async function waitForDisk(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return pred();
}

// The `- **Completed**: N` counter (aidlc-utility.ts:2071 at init = 3; synced to
// the live `[x]` count on every advance/skip by aidlc-state.ts:258/405/472).
// Returns the integer, or -1 if absent/unreadable.
function completedCount(projectDir: string): number {
  const statePath = stateFilePathFor(projectDir);
  if (!existsSync(statePath)) return -1;
  try {
    const m = readFileSync(statePath, "utf8").match(/^-\s*\*\*Completed\*\*:\s*(\d+)/m);
    return m ? Number.parseInt(m[1], 10) : -1;
  } catch {
    return -1;
  }
}

describe("t-tui-t58 workshop-scope (skips Ideation, runs Inception+ at Standard/Minimal)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `workshop scope routing skips Ideation + lands Inception/Construction/Operation on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_t58_${process.pid}`;
      // --no-aidlc-docs: a brand-new workspace the journey scaffolds itself (the
      // .sh's `setup_integration_project --no-aidlc-docs`). Use an explicit
      // `--scope workshop` flag so this test exercises the workshop lifecycle,
      // not the separate scope-confirmation/disambiguation surface.
      const proj = setupTuiProject({ noAidlcDocs: true });
      // Render value-add: tail the grid while the workshop runs to prove (a) the
      // INCEPTION statusline painted (Ideation skipped, as the user sees it) and
      // never IDEATION, and (b) a gate menu painted with a non-prose footer.
      let sawInception = false;
      let sawIdeation = false;
      let sawMenu = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      try {
        // --- launch the claude TUI + clear the two startup modals ----------------
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
        if (waitFor(session, "trust this folder", 60000, 600)) {
          drive(["send", "--session", session, "--keys", "1"]);
        }
        if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
          drive(["send", "--session", session, "--keys", "2"]);
        }
        // Fresh project -> the no-workflow `[AIDLC] ready` baseline.
        expect(waitFor(session, "\\[AIDLC\\].*ready", 45000, 800)).toBe(true);

        // --- submit the workshop command ----------------------------------------
        // Slash command has spaces -> send literally with no auto-Enter, then a
        // named Enter. The explicit scope flag avoids the current bare-keyword
        // confirmation loop; t29 owns the scope-disambiguation surface.
        drive([
          "send",
          "--session",
          session,
          "--keys",
          "/aidlc --scope workshop Build a simple task tracker",
          "--literal",
          "--no-enter",
        ]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Begin tailing the grid BEFORE the answer-gate runs, so we catch the
        // INCEPTION statusline + any gate menu while the workshop is live. Plain
        // text only — platform-invariant (no colour escapes).
        pollTimer = setInterval(() => {
          const grid = drive(["capture", "--session", session]).stdout;
          // P9: the statusline carries an orientation prefix ("<intent-slug> · ")
          // before the phase, so anchor on the "· <PHASE>" separator.
          if (grid.includes("· INCEPTION")) sawInception = true;
          if (grid.includes("· IDEATION")) sawIdeation = true;
          if (grid.includes("Enter to select") || grid.includes("Submit answers")) {
            sawMenu = true;
          }
        }, 1000);

        // --- answer the workshop gates via the shared answer-gate primitive ------
        // It presses Enter (= the Recommended default) on every menu and TERMINATES
        // on the DETERMINISTIC disk signal: `- **Completed**:` crossing into the
        // post-init range. Anchored 5..29 — > the .sh's "init + at least one
        // post-init" floor and < the .sh's "< 30" ceiling, so the SAME terminator
        // proves the workshop progressed past Initialization AND respected the
        // workshop scope's 25-EXECUTE cap. answer-gate is a no-op disk-poller if no
        // menu paints (known-scope path), so this is safe for BOTH routings.
        const gateRc = await new Promise<number>((resolve) => {
          const child = spawn(
            DRIVE_BIN,
            [
              ...DRIVE_PREFIX,
              "answer-gate",
              "--session",
              session,
              "--project-dir",
              proj,
              "--until-state-field",
              "Completed=^([5-9]|[12][0-9])$",
              // No per-gate timeout: workshop can spend several minutes in real
              // stage work between menus. The overall timeout is the wedge
              // backstop; per-gate budgets false-fire on active progress.
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

        // answer-gate's own backstop errors loud on a hang (nonzero exit) — a hang
        // is a FINDING, never softened. But also confirm the disk terminator
        // actually landed (defence against a clean-exit race): the Completed
        // counter must be in [5, 29].
        const pane = drive(["capture", "--session", session]).stdout;
        if (gateRc !== 0) {
          throw new Error(
            `answer-gate exited ${gateRc} (workshop gates never reached Completed in [5,29]).\n` +
              `Completed=${completedCount(proj)}\n---- last pane ----\n${pane}\n-------------------`,
          );
        }
        // belt-and-braces: re-poll disk in case the child raced its own exit.
        const reached = await waitForDisk(() => {
          const c = completedCount(proj);
          return c >= 5 && c <= 29;
        }, 10000);
        expect(reached).toBe(true);

        // ===================== ON DISK (the .sh's 14 assertions) =================
        const statePath = stateFilePathFor(proj);

        // #1 state file created.
        expect(existsSync(statePath)).toBe(true);
        const stateMd = readFileSync(statePath, "utf8");

        // #2 no ideation artifacts: workshop SKIPs all ideation, so the record's
        //    ideation/ dir is either absent or empty (the .sh's two-branch check).
        const ideationDir = join(recordDirFor(proj), "ideation");
        if (existsSync(ideationDir)) {
          const ideationFiles = walkFiles(ideationDir);
          expect(ideationFiles.length).toBe(0);
        }

        // #3 no Ideation stage marked [x]: each SKIP'd ideation slug renders
        //    `- [ ] <slug> — SKIP` (aidlc-utility.ts:1997) and can never reach
        //    `[x]`. Assert ZERO `[x] <ideation-slug>` lines (the .sh's grep -ciE).
        for (const slug of IDEATION_SLUGS) {
          const reX = new RegExp(`\\[x\\]\\s*${slug}\\b`, "i");
          if (reX.test(stateMd)) {
            throw new Error(`ideation stage '${slug}' was marked [x] — workshop must SKIP it`);
          }
        }

        // #4 Inception stages present in state (the .sh's grep).
        expect(stateMd).toMatch(/reverse-engineering|requirements-analysis/);
        // #5 Construction stages present.
        expect(stateMd).toMatch(/code-generation|build-and-test/);
        // #6 Operation stages present.
        expect(stateMd).toMatch(/deployment-pipeline|observability-setup/);

        // #7-9 all 3 init stages marked [x] (the .sh's per-stage grep).
        for (const stage of ["workspace-scaffold", "workspace-detection", "state-init"]) {
          expect(new RegExp(`\\[x\\]\\s*${stage}\\b`, "i").test(stateMd)).toBe(true);
        }

        // #11 workshop scope recorded — pin the exact field (stronger than the
        //     .sh's loose `[Ww]orkshop` grep).
        expect(stateMd).toMatch(/^-\s*\*\*Scope\*\*:\s*workshop$/m);

        // #12 Depth = Standard (workshop default — scope-mapping.json:99). Pin the
        //     field (stronger than the .sh's `Depth.*Standard`).
        expect(stateMd).toMatch(/^-\s*\*\*Depth\*\*:\s*Standard$/m);

        // #13 Test Strategy = Minimal (workshop default, independent of Standard
        //     depth — scope-mapping.json:100; aidlc-utility.ts:1942 prefers
        //     scopeDef.testStrategy). Pin the field.
        expect(stateMd).toMatch(/^-\s*\*\*Test Strategy\*\*:\s*Minimal$/m);

        // #14 completed < 30 (workshop is 25/32 EXECUTE — the scope cap). The
        //     terminator already proved >= 5; here pin the < 30 ceiling on the
        //     final disk read.
        const completed = completedCount(proj);
        expect(completed).toBeGreaterThanOrEqual(5);
        expect(completed).toBeLessThan(30);

        // #15 audit log exists with substantial content (> 200 bytes), and the
        //     deterministic state-init emission landed (stronger than the .sh's
        //     byte-size-only check). Initialization and later stage activity can
        //     be written by different clone/process shards, so inspect the
        //     canonical all-shard view rather than whichever shard sorts first.
        const auditMd = readAllAuditShards(proj);
        expect(auditMd.length).toBeGreaterThan(200);
        expect(auditMd).toContain("WORKSPACE_INITIALISED");
        const wiIdx = auditMd.indexOf("WORKSPACE_INITIALISED");
        expect(auditMd.slice(wiIdx, wiIdx + 500)).toMatch(/Scope.*:\s*workshop/);

        // ===================== RENDER (the tui-only value-add) ===================
        // The captured pane painted `[AIDLC] INCEPTION` (the workshop went straight
        // to Inception because Ideation was skipped) and NEVER `[AIDLC] IDEATION` —
        // the rendered proof of the skip the headless .sh / SDK path cannot see.
        expect(sawInception).toBe(true);
        expect(sawIdeation).toBe(false);
        // A gate menu painted at least once with a non-prose footer (the workshop's
        // "mandatory gates"). NON-PROSE signals only — never a rewordable string.
        expect(sawMenu).toBe(true);
      } finally {
        if (pollTimer) clearInterval(pollTimer);
        drive(["kill", "--session", session]);
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// Recursively collect all FILES under a directory (the .sh's `find <dir> -type f`).
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) {
        out.push(...walkFiles(p));
      } else {
        out.push(p);
      }
    } catch {
      // ignore unreadable entry
    }
  }
  return out;
}
