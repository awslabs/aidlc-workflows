// covers: scope:bugfix
//
// t-tui-t139-revision-loop-idempotency.serial.tui.test.ts — METAMORPHIC INVARIANT
// (§5-D, Phase 4): revision-loop idempotency, as a TUI JOURNEY. Drive the REAL
// claude TUI by keystroke through TWO bugfix run-throughs and assert that a
// reject->revise->approve cycle leaves the SAME terminal on-disk state as a clean
// approve, MODULO Revision Count.
//
// ⚠️ WHY TUI, NOT sdk (the §5-D doc says {sdk} — this is the documented exception,
// user-decided 2026-06-07). The {sdk} routing is INFEASIBLE and the doc label is a
// bug, proven by live diagnostic (tmp/phase4-runs/diag-t128.log, 2026-06-07): a
// single driveAidlc() run STOPS at the first gated stage — it emits SESSION_ENDED
// with Status=Running, Current Stage=requirements-analysis, and the ONLY
// AskUserQuestion it ever presents is the scope-confirmation menu, NEVER an
// {Approve, Request changes} approval gate. So an sdk run cannot drive reject->
// approve in one continuous query: there is no approval AUQ for canUseTool to
// answer. This is exactly what the DRIVER-SPLIT INVARIANT predicts (memory
// project_v0harness_driver_split_invariant, user-locked): a journey that must
// CONTINUE PAST a user-stop (answer a gate, then keep going) is TUI, not sdk -
// using sdk multi-turn to fake it rebuilds the auto-approve fake the mission
// kills. The revision loop is the canonical continue-past-a-stop journey,
// so it is driven through the real TUI like a human: the gate PAINTS, a keystroke
// answers it (Enter = Approve, or Down+Enter = Request changes), and the workflow
// continues. Auto-approving every gate skips the revision loop entirely (no
// Request changes path, stage-protocol.md:24), so it could never exercise this.
//
// THE METAMORPHIC RELATION (asserted as on-disk DATA, never on prose):
//   CLEAN   = terminal aidlc-state.md after a run that APPROVES every gate.
//   REVISED = terminal aidlc-state.md after an identical run whose FIRST approval
//             gate is REJECTED once (Down+Enter = "Request changes") then, on the
//             re-presented gate, approved — every later gate approved too.
//   INVARIANT: CLEAN and REVISED agree on Scope, Lifecycle Phase, and the set of
//   completed stages (the `- [x]` grid), differing ONLY in Revision Count
//   (REVISED > 0, CLEAN == 0). The revision loop is a no-op on the destination.
//
// Both runs terminate on the SAME on-disk milestone (the answer-gate's
// --until-state-field "Completed=([5-9]|...)" — the post-init Completed counter,
// the t50 terminator). Timers are WEDGE-BACKSTOPS, never budgets: each run passes
// the instant its disk milestone lands; the overall deadline only trips a genuine
// wedge. A reject that does not take (Revision Count stays 0) is a real FINDING and
// reds the vacuous-pass guard — NEVER softened (IRON RULE).
//
// SOURCE-PINNED FACTS (verify-never-guess):
//   - gate options exactly {Approve(1), Request changes(2)} (stage-protocol.md:41-42,
//     165-167); option 1 is the highlighted Recommended default.
//   - selecting "Request changes" -> aidlc-state.ts handleReject (:769): emits
//     GATE_REJECTED + STAGE_REVISING, marks [?]->[R], Revision Count++ (:786).
//     The orchestrator then re-runs the stage and re-presents the SAME gate.
//   - bugfix scope: Ideation entirely SKIP; on a brownfield workspace the first
//     post-init approval gate is reverse-engineering's (it runs first and holds
//     its own Request-Changes gate), then requirements-analysis
//     (scope-mapping.json "bugfix" + aidlc-utility.ts greenfield downgrade).
//     RE is a codekb stage: its revision at the gate is counted via the
//     approve-time backstop's codekb arm (aidlc-state.ts producesArtifactFile;
//     the 2026-07-13 live run proved the pre-fix gap - reject honored
//     conversationally, Revision Count stuck at 0).
//   - Completed counter == `- [x]` grid count (aidlc-state.ts:256-258 sync); the
//     terminator + the cross-run comparison both read this field.
//   - the AUQ gate footer + exact `❯` caret signal is gridHasMenu
//     (tui-drive.ts; identical on tmux and Windows ConPTY).
//
// SERIAL (.serial. in the filename): one paired journey owns this file's resources.
// Its two independent projects/sessions/profiles run concurrently. SPENDS REAL TOKENS (two bugfix
// workflows on Opus/Bedrock — the heaviest journey in the §5-D set). Gated behind
// AIDLC_TUI_LIVE=1; selected TUI substrate/claude/distributable absence SKIP with a
// reason — never a hollow pass.
//
// Spawn tui-drive.ts using the shared runtime selector: Bun for native and
// tmux backends, Node with type stripping for explicit legacy node-pty. The
// driver subprocess remains the source of the `tui` mechanism evidence.

import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { basename, dirname, join } from "node:path";
import { stateFilePathFor } from "../harness/sdk-drive.ts";
import { gridHasMenu, preseedClaudeOnboarding } from "../harness/tui-drive.ts";
import {
  comparableTerminal, guardBypassCommands, monitorNativeAnswerGate,
  nativeRootProviderFailure, nativeToolCalls,
} from "../harness/t139-fidelity.ts";
import {
  cleanupTuiProjectAfterKill,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { resolveTuiRuntime, tuiUnavailableReason } from "../harness/tui-runtime.ts";
import { remainingTuiDriverMs, runTuiDriverWithinBudget, TUI_CLEANUP_RESERVE_MS } from "../harness/tui-time-budget.ts";

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const IS_WIN = os.platform() === "win32";
const { bin: DRIVE_BIN, prefix: DRIVE_PREFIX } = resolveTuiRuntime(DRIVER);
const LIVE_CHILD_ENV = { ...process.env };
delete LIVE_CHILD_ENV.AIDLC_SKIP_REVISION_BACKSTOP;

// Both workflows share the existing 40-minute file ceiling. Their pass condition
// is still the on-disk milestone; parallel execution removes the clean run's
// wall time from the revised run's critical path without shortening its work.
const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = Math.min(Number.isFinite(TIMEOUT_S) && TIMEOUT_S > 0 ? TIMEOUT_S : 2400, 2400) * 1000;

// The post-init Completed milestone both runs terminate on (the t50 terminator):
// init 3 + >= 2 Inception (reverse-engineering + requirements-analysis) >= 5.
const UNTIL_COMPLETED = "Completed=([5-9]|[1-9][0-9])";

interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(args: string[], env = LIVE_CHILD_ENV): Run {
  const res = spawnSync(DRIVE_BIN, [...DRIVE_PREFIX, ...args], {
    encoding: "utf-8",
    env,
  });
  return { rc: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function captureTeardownFailure(failures: unknown[], operation: () => void): void {
  try { operation(); } catch (error) { failures.push(error); }
}

function waitFor(session: string, pattern: string, timeoutMs: number, stableMs: number, env: NodeJS.ProcessEnv): boolean {
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
    ], env).rc === 0
  );
}

function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live revision-loop journey (uses Bedrock tokens — two run-throughs)";
  }
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (spawnSync("claude", ["--version"], { encoding: "utf-8" }).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

/** The explicit session UUID binds native evidence to this fresh fixture. */
class NativeFidelity {
  readonly sessionId = randomUUID();
  private transcriptPath: string | undefined;

  constructor(private readonly configDir: string) {}

  inspect(final = false, completedCounter: () => number = () => 0): void {
    if (!this.transcriptPath) {
      const projects = join(this.configDir, "projects");
      if (existsSync(projects)) {
        this.transcriptPath = readdirSync(projects, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(projects, entry.name, `${this.sessionId}.jsonl`))
          .find((path) => existsSync(path));
      }
    }
    if (!this.transcriptPath) {
      if (final) throw new Error(`Missing native transcript for t139 session ${this.sessionId}`);
      return;
    }
    const subagents = join(dirname(this.transcriptPath), this.sessionId, "subagents");
    const paths = [
      this.transcriptPath,
      ...(existsSync(subagents)
        ? readdirSync(subagents).filter((name) => name.endsWith(".jsonl")).map((name) => join(subagents, name))
        : []),
    ];
    const transcripts = paths.map((path) => {
      const raw = readFileSync(path, "utf8");
      // Claude can be appending its last JSONL row during a polling read.
      const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
      return { path, raw, complete };
    });
    // Failure-fast observation ends with the answer-gate wait. The final fidelity
    // audit after its Completed milestone keeps the original goal boundary.
    const calls = transcripts.flatMap(({ complete }) => nativeToolCalls(complete));
    const bypasses = guardBypassCommands(calls);
    const providerFailure = final ? null
      : nativeRootProviderFailure(transcripts[0].raw, this.sessionId, completedCounter());
    if (final || bypasses.length > 0 || providerFailure) {
      const logDir = process.env.AIDLC_TEST_LOG_DIR;
      if (logDir) {
        for (const { path, complete } of transcripts) {
          writeFileSync(join(logDir, `t139-native-${this.sessionId}-${basename(path)}`), complete);
        }
        if (providerFailure) {
          writeFileSync(join(logDir, `t139-provider-error-${this.sessionId}.json`),
            `${JSON.stringify({ ...providerFailure, transcript: this.transcriptPath }, null, 2)}\n`);
        }
      }
    }
    if (providerFailure) {
      const error = new Error(
        `t139 root terminal provider error HTTP ${providerFailure.status} (${providerFailure.errorType}) ` +
        `in session ${this.sessionId}, event ${providerFailure.eventId}: ${providerFailure.message}`,
      );
      if (bypasses.length > 0) {
        throw new AggregateError([error, new Error(`t139 guard self-bypass:\n${bypasses.join("\n")}`)],
          `${error.message}\nt139 guard self-bypass:\n${bypasses.join("\n")}`, { cause: error });
      }
      throw error;
    }
    if (bypasses.length > 0) {
      throw new Error(`t139 guard self-bypass in native tool calls:\n${bypasses.join("\n")}`);
    }
    if (final) {
      const commands = calls.filter((call) => call.name === "Bash");
      expect(commands.length).toBeGreaterThan(0);
      console.log(`t139 native fidelity: ${commands.length} Bash calls, zero guard opt-outs (${this.sessionId})`);
    }
  }
}

/** Run the answer-gate primitive to the Completed milestone. Approve-only by
 *  default (Enter = Recommended per menu); when rejectFirstGate is true it selects
 *  "Request changes" on the FIRST approval gate once, then approves the rest —
 *  driving one reject→revise→approve cycle (the gate is identified by the canonical
 *  Approve + Request Changes pair, so the Looks correct + Request changes summary
 *  confirmation is NOT mistaken for it). Long-lived
 *  subprocess; its own backstops error loud, so a hang exits nonzero (never a
 *  manufactured pass — IRON RULE). */
function runAnswerGateToMilestone(
  session: string,
  sandbox: string,
  rejectFirstGate: boolean,
  deadlineMs: number,
  fidelity: NativeFidelity,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let monitored: Promise<number> | undefined;
  const bounded = runTuiDriverWithinBudget(deadlineMs, (overallMs) => {
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
        UNTIL_COMPLETED,
        "--overall-timeout-ms",
        String(overallMs),
        ...(rejectFirstGate ? ["--reject-first-gate"] : []),
      ],
      { stdio: "inherit", env },
    );
    // Both monitors own this exact client. Provider/fidelity errors and the
    // common deadline stop it before the finally block retires its terminal.
    monitored = monitorNativeAnswerGate(child, () => fidelity.inspect(false, () => {
      try { return readTerminal(sandbox).completedCounter; } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
        throw error;
      }
    }));
    return child;
  });
  return Promise.all([bounded, monitored!]).then(([code]) => code);
}

interface Terminal {
  scope: string | undefined;
  phase: string | undefined;
  currentStage: string | undefined;
  revisionCount: number;
  completedCounter: number;
  completedGrid: number;
  completedSlugs: string[];
  rawState: string;
}

/** Read the comparable terminal fields off the post-run aidlc-state.md. */
function readTerminal(sandbox: string): Terminal {
  const md = readFileSync(stateFilePathFor(sandbox), "utf8");
  const scope = /\*\*Scope\*\*:[ \t]*(\S+)/.exec(md)?.[1];
  const phase = /\*\*Lifecycle Phase\*\*:[ \t]*([^\r\n]+)/.exec(md)?.[1]?.trim();
  const revisionCount = Number.parseInt(
    /\*\*Revision Count\*\*:[ \t]*(\d+)/.exec(md)?.[1] ?? "0",
    10,
  );
  const completedCounter = Number.parseInt(
    /Completed\*\*:[ \t]*(\d+)/.exec(md)?.[1] ?? "-1",
    10,
  );
  // The set of completed stage slugs — the `- [x] <slug>` grid rows. Sorted so the
  // cross-run comparison is order-independent (both runs complete the same SET).
  const completedSlugs = (md.match(/^- \[x\] (\S+)/gm) ?? [])
    .map((l) => l.replace(/^- \[x\] /, "").trim())
    .sort();
  return {
    scope,
    phase,
    currentStage: /\*\*Current Stage\*\*:[ \t]*(\S+)/.exec(md)?.[1],
    revisionCount,
    completedCounter,
    completedGrid: completedSlugs.length,
    completedSlugs,
    rawState: md,
  };
}

/** Launch claude on a fresh brownfield bugfix project, clear modals, submit the
 *  bugfix command. Returns the session name (caller drives gates + reads disk). */
function launchBugfix(session: string, sandbox: string, fidelity: NativeFidelity, env: NodeJS.ProcessEnv): void {
  // run-tests.ts disables the approve-time revision backstop globally because
  // most fixtures intentionally omit revision evidence. This test is the live
  // reject/revise proof, so its Claude child must not inherit that bypass. On
  // POSIX the private tmux server can retain the suite environment from an
  // earlier test, hence the explicit `env -u` wrapper at the actual PTY child.
  // Windows has no `env`; its daemon inherits LIVE_CHILD_ENV directly.
  const claudeCommand = IS_WIN
    ? ["claude", "--dangerously-skip-permissions"]
    : [
        "env",
        "-u",
        "AIDLC_SKIP_REVISION_BACKSTOP",
        "claude",
        "--setting-sources",
        "project",
        "--dangerously-skip-permissions",
      ];
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
      ...claudeCommand,
      "--session-id",
      fidelity.sessionId,
    ], env).rc,
  ).toBe(0);
  // Share the original 60s trust + 15s permission + 45s readiness budget.
  const startupDeadlineMs = Date.now() + 120_000;
  const startup = drive([
    "startup", "--session", session,
    "--ready-pattern", "\\[AIDLC\\].*ready", "--timeout-ms", "120000",
  ], env);
  expect(startup.rc).toBe(0);
  expect(waitFor(session, "\\[AIDLC\\].*ready", Math.max(0, startupDeadlineMs - Date.now()), 800, env)).toBe(true);

  // Explicit `--scope bugfix` (not the bare keyword) so the shipped
  // AWS_AIDLC_DEFAULT_SCOPE=classic env-default does NOT trigger a scope-
  // disambiguation gate at START (the t50 lesson, SKILL.md:105 "explicit CLI flag
  // wins"). The trailing description satisfies the step-6 "what to build?" prompt
  // up front (answer-gate can't type free text).
  drive([
    "send",
    "--session",
    session,
    "--keys",
    "/aidlc --scope bugfix the todo checkbox state is not persisted after page reload",
    "--literal",
    "--no-enter",
  ], env);
  drive(["send", "--session", session, "--keys", "Enter", "--no-enter"], env);
  // Do not require an intermediate phase/statusline paint here. Fresh brownfield
  // bootstraps can spend minutes routing while the statusline still shows ready
  // or an interim phase; the answer-gate's on-disk Completed terminator below is
  // the deterministic progress proof (same lesson as t50).
}

/** Each branch owns its project, Claude profile, driver and cleanup result. */
async function runJourney(label: "clean" | "revised", deadlineMs: number): Promise<Terminal> {
  const revised = label === "revised";
  const session = `aidlc_tui_t139_${label}_${process.pid}`;
  const sandbox = setupTuiProject({ brownfieldStub: true, noAidlcDocs: true });
  // Keep this leaf short: Claude appends encoded project paths and UUIDs on Windows.
  const profile = mkdtempSync(join(process.env.AIDLC_TEST_LOG_DIR || dirname(sandbox), revised ? "tr-" : "tc-"));
  const env = { ...LIVE_CHILD_ENV, CLAUDE_CONFIG_DIR: profile };
  const fidelity = new NativeFidelity(profile);
  const failures: unknown[] = [];
  let terminal: Terminal | undefined;
  let sawMenu = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  try {
    preseedClaudeOnboarding(sandbox, env, os.homedir(), false);
    console.log(`t139 ${label}: starting independent session ${fidelity.sessionId}`);
    launchBugfix(session, sandbox, fidelity, env);
    if (revised) {
      pollTimer = setInterval(() => {
        if (gridHasMenu(drive(["capture", "--session", session], env).stdout)) sawMenu = true;
      }, 1000);
    }
    const rc = await runAnswerGateToMilestone(session, sandbox, revised, deadlineMs, fidelity, env);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    expect(rc).toBe(0);
    // Completed is persisted before approve's nested advance. Sample the same
    // post-advance milestone on both branches, within their common deadline.
    terminal = await comparableTerminal(() => readTerminal(sandbox), Date.now() + remainingTuiDriverMs(deadlineMs));
    fidelity.inspect(true);
    if (process.env.AIDLC_TEST_LOG_DIR) {
      writeFileSync(join(process.env.AIDLC_TEST_LOG_DIR, `t139-${label}-terminal.json`), JSON.stringify(terminal, null, 2));
    }
    expect(terminal.scope).toMatch(/bugfix/i);
    expect(terminal.completedCounter).toBeGreaterThanOrEqual(5);
    expect(terminal.completedCounter).toBe(terminal.completedGrid);
    if (revised) {
      // Never turn this into two clean runs: require the persisted rejection
      // and a painted gate, independently of the final cross-run comparison.
      expect(terminal.revisionCount).toBeGreaterThan(0);
      expect(sawMenu).toBe(true);
    } else {
      expect(terminal.revisionCount).toBe(0);
    }
    console.log(`t139 ${label}: reached comparable terminal milestone`);
  } catch (error) {
    failures.push(error);
  } finally {
    if (pollTimer) clearInterval(pollTimer);
    // A failure in one branch must neither stop its sibling nor remove the
    // sibling's files. Failed retirement preserves this branch's fixture.
    captureTeardownFailure(failures, () => {
      const killed = drive(["kill", "--session", session], env);
      if (process.env.AIDLC_TEST_LOG_DIR) {
        captureTeardownFailure(failures, () => {
          writeFileSync(join(process.env.AIDLC_TEST_LOG_DIR!, `t139-${label}-kill.json`), JSON.stringify(killed, null, 2));
        });
      }
      cleanupTuiProjectAfterKill(sandbox, session, killed);
    });
  }
  if (failures.length) {
    throw new AggregateError(failures,
      `t139 ${label} workflow/teardown failures: ${failures.map(String).join("; ")}`, { cause: failures[0] });
  }
  if (!terminal) throw new Error(`t139 ${label} did not produce a terminal state`);
  return terminal;
}

describe("t-tui-t139 revision-loop idempotency (reject->approve == clean approve, modulo Revision Count)", () => {
  test.skipIf(SKIP_REASON !== null)(
    `reject-then-approve reaches the same terminal state as clean approve${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      // The driver helper reserves 30 seconds itself. Leave a second reserve
      // here for the two terminal teardowns and the cross-run comparison.
      const deadlineMs = performance.now() + TEST_TIMEOUT_MS - TUI_CLEANUP_RESERVE_MS;
      const [cleanResult, revisedResult] = await Promise.allSettled([
        runJourney("clean", deadlineMs),
        runJourney("revised", deadlineMs),
      ]);
      const failures = [cleanResult, revisedResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length) {
        throw new AggregateError(failures, `t139 paired journey failed: ${failures.map(String).join("; ")}`, { cause: failures[0] });
      }
      if (cleanResult.status !== "fulfilled" || revisedResult.status !== "fulfilled") {
        throw new Error("t139 requires both terminal states");
      }
      const clean = cleanResult.value;
      const revised = revisedResult.value;
      // Same scope, phase, cursor and completed-stage set; only revision count
      // differs. Both full workflows and both fidelity audits remain required.
      expect(revised.scope).toBe(clean.scope);
      expect(revised.phase).toBe(clean.phase);
      expect(revised.currentStage).toBe(clean.currentStage);
      expect(revised.completedSlugs).toEqual(clean.completedSlugs);
      expect(revised.completedCounter).toBe(clean.completedCounter);
      expect(revised.completedCounter).toBe(revised.completedGrid);
      expect(revised.revisionCount).toBeGreaterThan(clean.revisionCount);
    },
    TEST_TIMEOUT_MS,
  );
});
