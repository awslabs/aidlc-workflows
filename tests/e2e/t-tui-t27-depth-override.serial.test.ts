// covers: subcommand:aidlc-utility:config-change
//
// t-tui-t27-depth-override.serial.tui.test.ts — drive the `/aidlc --depth <level>`
// config-override journey through a REAL claude TUI and prove the depth change
// LANDS on disk + RENDERS. A faithful port of
// tests/integration/t27-integration-depth-override.sh (plan 7). The depth override
// is a pure one-shot config edit that never needs gate auto-approval, so the
// landed surface is unaffected by how the run is driven. Pattern A (landed +
// rendered, NO answer-gate).
//
// WHAT IT PROVES (equal-or-stronger than the .sh, on the same on-disk surface):
//   Case A — depth override on an EXISTING workflow:
//     setup state-mid-ideation (Depth=Standard, scope=feature) + audit, type
//     `/aidlc --depth minimal`. SKILL.md step 8 (SKILL.md:124-125) sees `--depth`
//     WITHOUT --scope/--stage/--phase + state present, so it shells
//     `aidlc-utility.ts config-change --depth minimal`, prints output, STOPS — no
//     workflow run-on, a pure one-shot config edit. handleConfigChange
//     (aidlc-utility.ts:2356) normalises minimal -> "Minimal", setField("Depth",
//     ...) (:2386), writes state, and emits DEPTH_CHANGED with Old Depth=Standard
//     / New Depth=Minimal (:2400). Assert ON DISK: aidlc-state.md `- **Depth**:
//     Minimal` (the .sh's `Depth.*Minimal` grep) + audit.md has a DEPTH_CHANGED
//     event (the .sh's `DEPTH_CHANGED` grep). Assert RENDERED: the pane shows the
//     printed confirmation `Depth changed: Standard → Minimal` (:2415) AND the
//     workflow statusline `[AIDLC] IDEATION` is still painted (the override does
//     not start/stop a workflow). Stronger than the .sh: the .sh greps a loose
//     `Depth.*Minimal`; we additionally pin the OLD->NEW transition (Standard ->
//     Minimal) in both the rendered confirmation and the implicit audit delta.
//
//   Case C — a depth word the engine does not take:
//     setup the same fixture, type `/aidlc --depth extreme`. `next` refuses the
//     word itself (it never names a config command for a value outside
//     minimal, standard, and comprehensive): an error directive, or the print
//     naming the words `--depth` does take and handing the line to the agent to
//     read (since #2293). The agent may carry the value on its own `next
//     --resume` (the resume line tells it to); `next` reads the refused value
//     first either way. Two designed shapes follow (conductor 2026-10-11, per
//     Arden's 10-10 calls: the agent reads the line and next is its helper;
//     infer, ask only when ambiguous): the agent asks the person once, in
//     prose (the turn settles) or as one picker (open until they answer), with
//     nothing changed, not even Last Updated; or it reads the word as one of
//     the levels, the engine records that level
//     and says it back in the setter's own line, and the work carries on in
//     the same turn (#2318). Either way nothing else is decided for the
//     person: every other line of the state file is as seeded, and no gate or
//     question is answered in their place. Refusal semantics are checked in
//     the retained live trace, not a prose regex.
//
// CASE B OMITTED (deliberately, not a weakening): the .sh's Test B
// (`/aidlc bugfix --depth comprehensive`) creates a NEW workflow from a
// brownfield stub and overrides the scope default depth. That is a SCOPE-START
// journey, not a depth-OVERRIDE journey — `--depth` arriving WITH `--scope`
// routes through the init/start path (SKILL.md:531 `init ... --depth`), a
// different surface that runs the 3 init stages and lands a workflow. Per the
// driver-split invariant + Pattern A's "lands deterministically, does NOT run to
// completion" framing, the depth-DEFAULT-override-at-scope-start belongs with the
// scope-start journeys. Case B's exact surface — `bugfix --depth comprehensive`
// overriding the bugfix Minimal default at workflow start, asserted on the Depth
// state field — is owned by tests/e2e/t59-workflow-depth-override.test.ts
// (sdk), which drives that literal journey. Folding it here would mix two
// journeys in one file and pull in answer-gate territory. The config-change
// one-shot (Cases A + C) is the journey t27 names.
//
// PATTERN-A RENDER FINDING (surfaced, not chased): depth is NOT a statusline
// field — aidlc-statusline.ts paints phase + progress bar + counter + stage name,
// never the depth value. So the tui-only render value-add for a depth override is
// thin: the pane proves (a) the printed `Depth changed: ...` confirmation line and
// (b) that the workflow statusline row survives the override (the workflow was not
// torn down or started). Both the confirmation text and the disk landing are also
// visible to the SDK path's stdout — the genuinely-unique tui observation is only
// the persisting `[AIDLC] IDEATION` row. This is the honest render surface for a
// config-only command; we assert it rather than pretend depth paints somewhere.
//
// COST: spends real Bedrock tokens (the orchestrator LLM reads SKILL.md and shells
// the config-change/error path — short turns, but live). Gated behind
// AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs; selected TUI substrate/claude/distributable
// absence also SKIPs with a reason. NEVER asserts racy terminal completion
// (Pattern A): there is no completion here — the override lands and the
// orchestrator STOPs, so we wait on the landed surface (the rendered confirmation
// + the on-disk field), never on a result event.
//
// Spawn tui-drive.ts using the shared runtime selector for the native Bun and
// POSIX tmux backends. The driver subprocess remains the source of the `tui`
// mechanism evidence.

import { liveCaseTimeoutMs, LIVE_LONG_OPERATION_TIMEOUT_MS, remainingOperationTimeoutMs, remainingCleanupTimeoutMs, fileCleanupReserveMs, NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { nextFlagShape, parseLiteralShellInvocation, readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import { type NativeToolCall, nativeToolCalls } from "../harness/t139-fidelity.ts";
import {
  cleanupTuiProjectAfterKill,
  completedClaudeTurnPattern,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";
import { TurnWatch } from "../harness/tui-drive.ts";
import { resolveTuiRuntime, tuiUnavailableReason } from "../harness/tui-runtime.ts";

function completedStartupProbe<T extends { error?: Error }>(result: T): T {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") throw result.error;
  return result;
}

const DRIVER = join(import.meta.dir, "..", "harness", "tui-drive.ts");
const AIDLC_SRC = join(import.meta.dir, "..", "..", "dist", "claude", ".claude");
const { bin: DRIVE_BIN, prefix: DRIVE_PREFIX } = resolveTuiRuntime(DRIVER);

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the integration tier
// sets 600). A config override is short, but the claude TUI startup + a brief
// orchestrator turn is the bulk of the wall-clock, so the cap is generous.
const TIMEOUT_S = Number(process.env.AIDLC_TEST_TIMEOUT);
const TEST_TIMEOUT_MS = Number.isSafeInteger(TIMEOUT_S) && TIMEOUT_S > 0
  ? TIMEOUT_S * 1000
  : liveCaseTimeoutMs(LIVE_LONG_OPERATION_TIMEOUT_MS);
let caseDeadlineMs: number;
beforeEach(() => { caseDeadlineMs = Date.now() + TEST_TIMEOUT_MS; });
function remainingWorkMs(): number {
  return remainingOperationTimeoutMs(TEST_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    reserveMs: fileCleanupReserveMs(TEST_TIMEOUT_MS),
    phase: "E2E live work",
  })!;
}
function remainingCleanupMs(): number {
  return remainingCleanupTimeoutMs(NATIVE_TERMINAL_CLEANUP_TIMEOUT_MS, {
    deadlineMs: caseDeadlineMs,
    phase: "E2E terminal cleanup",
  });
}



interface Run {
  rc: number;
  stdout: string;
  stderr: string;
}
function drive(args: string[]): Run {
  const res = spawnSync(DRIVE_BIN, [...DRIVE_PREFIX, ...args], { timeout: args[0] === "kill" ? remainingCleanupMs() : remainingWorkMs(), encoding: "utf-8" });
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

// Poll an ON-DISK predicate until true or timeout. The deterministic completion
// signal for a config-change command: SKILL.md:125 instructs only "Print output,
// STOP" (NOT "verbatim" — contrast --status/--help/env-scope at :67/:101 which DO
// say verbatim), so the orchestrator may PARAPHRASE the tool's confirmation line
// (observed live: "Done. Depth changed from Standard → Minimal …"). Greping that
// reworded prose is the §1 anti-pattern and flaked 1/4 runs. We instead terminate
// on the tool's structured emission (the DEPTH_CHANGED audit event / the Depth
// state field), never the screen text.
async function waitForDisk(pred: () => boolean, timeoutMs: number, session?: string): Promise<boolean> {
  const deadline = Date.now() + Math.min(timeoutMs, remainingWorkMs());
  // With a session, a turn that ends without the signal ends the wait too.
  const turn = session ? new TurnWatch() : null;
  while (Date.now() < deadline) {
    if (pred()) return true;
    if (turn && session && turn.observe(drive(["capture", "--session", session]).stdout)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return pred();
}

interface NativeRow {
  type: string;
  subtype?: string;
  hookErrors?: string[];
  message?: {
    content?: Array<{
      type: string;
      text?: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
}

// Bind completion evidence to this fresh CLI session, as t139 does. A rendered
// error can precede Stop; turn_duration is emitted after the Stop cycle finishes.
function nativeTurn(sessionId: string): { raw: string; rows: NativeRow[] } | undefined {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), ".claude"), "projects");
  if (!existsSync(projects)) return undefined;
  const path = readdirSync(projects, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projects, entry.name, `${sessionId}.jsonl`))
    .find((candidate) => existsSync(candidate));
  if (!path) return undefined;
  const text = readFileSync(path, "utf8");
  const raw = text.slice(0, text.lastIndexOf("\n") + 1);
  const rows = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as NativeRow);
  return { raw, rows };
}

// The native tool result prefixes CLI JSON with e.g. "Exit code 1". Parse the
// refusal only from the directive belonging to the canonical call: the error
// directive, or the reading step `next` prints for a value it does not take.
function refusedDirective(row: NativeRow, callId: string): { kind: string; message: string } | undefined {
  if (row.type !== "user" || !Array.isArray(row.message?.content)) return undefined;
  const result = row.message.content.find((block) =>
    block.type === "tool_result" && block.tool_use_id === callId,
  );
  if (typeof result?.content !== "string") return undefined;
  for (const line of result.content.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as { kind?: unknown; message?: unknown } | null;
      if (parsed && (parsed.kind === "error" || parsed.kind === "print") && typeof parsed.message === "string") {
        return { kind: parsed.kind, message: parsed.message };
      }
    } catch {
      // Human-readable tool wrapper lines are not the engine's directive.
    }
  }
  return undefined;
}

// The engine's own two refusals of the typed value: the error directive, and
// (since the reading step) the print naming the words `--depth` does take.
const DEPTH_REFUSALS: Record<string, RegExp> = {
  error: /^--depth requires <minimal\|standard\|comprehensive>; received "extreme"\.$/,
  print: /^`next` takes `--depth` with minimal\|standard\|comprehensive, and does not take "extreme"\./,
};

// The call that carried the person's `--depth extreme` to `next`. The agent may
// add a flag of its own that takes no value (`--resume`, as the resume line
// tells it to); `next` reads the refused value first and takes nothing else
// from the line, so that call is the same refusal (Full Suite 38087105892).
const CANONICAL_NEXT = ["bun", ".claude/tools/aidlc.ts", "engine", "orchestrate", "next"];
const ENGINE = ["bun", ".claude/tools/aidlc.ts", "engine"];
const DEPTH_LEVELS = ["minimal", "standard", "comprehensive"] as const;
type DepthLevel = (typeof DEPTH_LEVELS)[number];

// A literal engine call made in this project: no directory prelude, or one
// that is this project directory.
function literalEngineCall(call: NativeToolCall, projectDir: string): string[] | null {
  if (call.name !== "Bash") return null;
  const parsed = parseLiteralShellInvocation(String(call.input.command));
  if (!parsed) return null;
  if (parsed.directory === null) return parsed.argv;
  try {
    const selected = statSync(parsed.directory, { bigint: true });
    const expected = statSync(projectDir, { bigint: true });
    return selected.isDirectory() && expected.isDirectory() &&
      selected.ino !== 0n && selected.dev === expected.dev && selected.ino === expected.ino
      ? parsed.argv
      : null;
  } catch {
    return null;
  }
}

function startsWithWords(argv: readonly string[], words: readonly string[]): boolean {
  return JSON.stringify(argv.slice(0, words.length)) === JSON.stringify(words);
}

function isCanonicalDepthRefusalCall(call: NativeToolCall, projectDir: string): boolean {
  const argv = literalEngineCall(call, projectDir);
  if (argv === null || !startsWithWords(argv, CANONICAL_NEXT)) return false;
  const modifier = argv.slice(CANONICAL_NEXT.length).filter((token) => nextFlagShape(token)?.value !== "none");
  return JSON.stringify(modifier) === JSON.stringify(["--depth", "extreme"]);
}

// The engine's own setter for the depth the agent read the word as, and the
// level it set; null for any other call.
function depthSetterLevel(call: NativeToolCall, projectDir: string): DepthLevel | null {
  const argv = literalEngineCall(call, projectDir);
  const setter = [...ENGINE, "config", "set", "depth"];
  if (argv === null || argv.length !== setter.length + 1 || !startsWithWords(argv, setter)) return null;
  const level = argv[setter.length].toLowerCase();
  return (DEPTH_LEVELS as readonly string[]).includes(level) ? level as DepthLevel : null;
}

// The work carrying on after a setting: the agent back at `next`, or on the
// step `next` handed it (`continue <receipt>`).
function isEngineNextOrContinue(call: NativeToolCall, projectDir: string): boolean {
  const argv = literalEngineCall(call, projectDir);
  return argv !== null && startsWithWords(argv, [...ENGINE, "orchestrate"]) &&
    (argv[ENGINE.length + 1] === "next" || argv[ENGINE.length + 1] === "continue");
}

function resultRowFor(row: NativeRow, callId: string): boolean {
  return row.type === "user" && Array.isArray(row.message?.content) &&
    row.message.content.some((block) => block.type === "tool_result" && block.tool_use_id === callId);
}

// The text a tool result carried for one call (the engine's own line).
function toolResultText(rows: NativeRow[], callId: string): string | undefined {
  const row = rows.find((candidate) => resultRowFor(candidate, callId));
  const block = row?.message?.content?.find((candidate) => candidate.type === "tool_result" && candidate.tool_use_id === callId);
  return typeof block?.content === "string" ? block.content : undefined;
}

// The audit rows, counted by event name (the canonical `**Event**: <name>` line).
function auditEventCounts(projectDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of readAllAuditShards(projectDir).split("\n")) {
    const match = /^\*\*Event\*\*: (\S+)$/.exec(line.trim());
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  return counts;
}

// Rows that record an answer or a decision in the person's place. None may be
// added by a depth word of theirs, whichever shape the agent takes.
const ANSWER_ROWS = [
  "QUESTION_ANSWERED",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "STAGE_AWAITING_APPROVAL",
  "STAGE_COMPLETED",
  "STAGE_SKIPPED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "PLAN_APPROVAL_RECORDED",
];

// The state file without the one setting a depth word may change, and the
// timestamp its setter writes: everything else must read as seeded.
function withoutDepthSetting(state: string): string {
  return state.split(/\r?\n/).filter((line) => !/^- \*\*(Depth|Last Updated)\*\*:/.test(line)).join("\n");
}

function capitalized(level: DepthLevel): string {
  return level[0].toUpperCase() + level.slice(1);
}

function workflowArtifacts(statePath: string): Record<string, string> {
  const record = dirname(statePath);
  return Object.fromEntries(
    readdirSync(record, { recursive: true, encoding: "utf8" })
      .filter((path) => /^(ideation|inception|construction|operation)[/\\]/.test(path))
      .filter((path) => statSync(join(record, path)).isFile())
      .map((path) => [path, readFileSync(join(record, path)).toString("base64")]),
  );
}

// Does the per-intent audit shard dir carry a canonical `**Event**: <name>` line?
// (line-anchored so a stray token in a field value cannot satisfy it — the
// aidlc-audit.ts:259 format.) Reads every `.md` shard under <record>/audit/ and
// concatenates, since P9 shards the audit per clone.
function auditHasEvent(auditDir: string, event: string): boolean {
  try {
    return readdirSync(auditDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(auditDir, f), "utf8"))
      .join("\n")
      .split("\n")
      .some((l) => l.startsWith(`**Event**: ${event}`));
  } catch {
    return false;
  }
}

// ABSENT / opt-in gating. The token guard AIDLC_TUI_LIVE=1 is checked FIRST so a
// bare --e2e (no live opt-in) reports a clear skip reason, not a substrate miss.
function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live depth-override journey (uses Bedrock tokens)";
  }
  const runtimeReason = tuiUnavailableReason();
  if (runtimeReason) return runtimeReason;
  if (completedStartupProbe(spawnSync("claude", ["--version"], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" })).status !== 0) {
    return "claude CLI not found";
  }
  if (!existsSync(AIDLC_SRC)) return `distributable missing: ${AIDLC_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

// Shared launch: set up a project (seeded mid-ideation + audit), boot the claude
// TUI, clear the two startup modals, and wait for the WORKFLOW statusline (not
// `ready`) so we KNOW the override lands against a live workflow row. Returns the
// session name + project path; the caller drives the slash command and cleans up.
function bootSeededWorkflow(tag: string, sessionId?: string): { session: string; proj: string } {
  const session = `aidlc_tui_t27_${tag}_${process.pid}`;
  const proj = setupTuiProject({ withState: "state-mid-ideation.md", withAudit: true });
  // launch
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
      "40",
      "--",
      "claude",
      "--dangerously-skip-permissions",
      ...(sessionId ? ["--session-id", sessionId] : []),
    ]).rc,
  ).toBe(0);
  // clear the two startup modals (idempotent — only act if present)
  // One generous startup backstop, shared by modal handling and readiness.

  const startup = drive([
    "startup", "--session", session,
    "--ready-pattern", "\\[AIDLC\\].*IDEATION", "--timeout-ms", String(remainingWorkMs()),
  ]);
  expect(startup.rc).toBe(0);
  // The seeded mid-ideation state paints the WORKFLOW line (IDEATION), not the
  // no-workflow "ready" line. Anchor the override against the live workflow row.
  expect(waitFor(session, "\\[AIDLC\\].*IDEATION", remainingWorkMs(), 1000)).toBe(true);
  return { session, proj };
}

// Send a slash command that contains spaces: literal, no auto-Enter, then a named
// Enter (the spike's exact two-step). Mirrors the workshop template.
function sendSlash(session: string, command: string): void {
  drive(["send", "--session", session, "--keys", command, "--literal", "--no-enter"]);
  drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
}

describe("t-tui-t27 depth override (config-change lands + renders)", () => {
  // --- Case A: --depth minimal lands Depth=Minimal + DEPTH_CHANGED on disk ----
  test.skipIf(SKIP_REASON !== null)(
    `--depth minimal lands Depth=Minimal + DEPTH_CHANGED and renders the change${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const { session, proj } = bootSeededWorkflow("min");
      try {
        const statePath = seededStateFile(proj);
        const auditDir = seededAuditDir(proj);
        // Sanity: the seed really is Standard (so Minimal is a genuine change and
        // the DEPTH_CHANGED delta is Standard -> Minimal, not a no-op).
        expect(readFileSync(statePath, "utf8")).toMatch(/-\s*\*\*Depth\*\*:\s*Standard/);

        // type the override
        sendSlash(session, "/aidlc --depth minimal");

        // --- TERMINATE on the DETERMINISTIC on-disk signal, NOT screen prose -----
        // The landed-signal for this config-change is the DEPTH_CHANGED audit event
        // (aidlc-utility.ts:2400) + the Depth state field — both written by the
        // tool, deterministic. We do NOT wait on the confirmation TEXT: SKILL.md:125
        // says only "Print output, STOP" (NOT verbatim), so the orchestrator may
        // paraphrase it ("Done. Depth changed from Standard → Minimal …" was
        // observed live, defeating a `Depth changed:` grep — the §1 prose-grep
        // anti-pattern, which flaked 1/4 runs). Disk is the truth; the screen prose
        // is the LLM's to reword.
        const landed = await waitForDisk(
          () => auditHasEvent(auditDir, "DEPTH_CHANGED"),
          remainingWorkMs(),
          session,
        );
        const pane = drive(["capture", "--session", session]).stdout;
        if (!landed) {
          throw new Error(
            `DEPTH_CHANGED never landed in audit.md within budget.\n` +
              `---- last pane ----\n${pane}\n-------------------`,
          );
        }

        // --- ON DISK (the .sh's two greps, equal-or-stronger) ------------------
        const stateAfter = readFileSync(statePath, "utf8");
        // .sh: assert_grep "$STATE_A" 'Depth.*Minimal' — pin the exact field.
        expect(stateAfter).toMatch(/-\s*\*\*Depth\*\*:\s*Minimal/);
        const auditAfter = readAllAuditShards(proj);
        // .sh: assert_grep "$AUDIT_A" 'DEPTH_CHANGED' — anchor on the canonical
        // audit-line format (**Event**: <name>) so a stray DEPTH_CHANGED token in
        // a field value can't satisfy it.
        const depthChanged = auditAfter
          .split("\n")
          .filter((l) => l.startsWith("**Event**: DEPTH_CHANGED")).length;
        expect(depthChanged).toBeGreaterThanOrEqual(1);

        // --- RENDER value-add (NON-PROSE, the tui-only signal) -----------------
        // The workflow statusline row SURVIVES the override (a config-only command
        // does not tear down / start a workflow). Depth is not a statusline field,
        // and the confirmation prose is LLM-reworded, so the persisting `[AIDLC]
        // IDEATION` row is the honest, deterministic tui-only observation here —
        // what the headless SDK path could not see, asserted without grepping prose.
        expect(pane).toContain("· IDEATION");
      } finally {
        cleanupTuiProjectAfterKill(
          proj,
          session,
          drive(["kill", "--session", session]),
        );
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- Case C: a depth word the engine does not take --------------------------
  test.skipIf(SKIP_REASON !== null)(
    `--depth extreme: next refuses the word, the agent asks once (prose or one picker) or reads it as a level the engine records and says back, and nothing else is decided for the person${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const sessionId = randomUUID();
      const { session, proj } = bootSeededWorkflow("err", sessionId);
      let settledToolCount: number | undefined;
      try {
        const statePath = seededStateFile(proj);
        const auditDir = seededAuditDir(proj);
        // Snapshot the exact bytes BEFORE the word (the .sh's md5-before). A
        // full-content compare is strictly stronger than md5.
        const before = readFileSync(statePath, "utf8");
        const artifactsBefore = workflowArtifacts(statePath);
        const rowsBefore = auditEventCounts(proj);

        // type the word the engine does not take
        sendSlash(session, "/aidlc --depth extreme");

        // The wait ends on each shape's own deterministic signal: the native
        // turn ended (the agent asked in prose), a picker is open after the
        // refusal (the agent asked with one, which holds the turn until the
        // person answers), or the engine recorded a level (the agent read the
        // word as one). Never inspect state early.
        const turnEnded = (): boolean =>
          nativeTurn(sessionId)?.rows.some((row) => row.type === "system" && row.subtype === "turn_duration") ?? false;
        const recorded = (): boolean => auditHasEvent(auditDir, "DEPTH_CHANGED");
        const pickerAfterRefusal = (): boolean => {
          const turn = nativeTurn(sessionId);
          if (!turn) return false;
          const seen = nativeToolCalls(turn.raw);
          const at = seen.findIndex((call) => isCanonicalDepthRefusalCall(call, proj));
          return at >= 0 && seen.slice(at + 1).some((call) => call.name === "AskUserQuestion");
        };
        expect(await waitForDisk(() => turnEnded() || recorded() || pickerAfterRefusal(), remainingWorkMs())).toBe(true);
        const inferred = recorded();
        const picker = !inferred && pickerAfterRefusal();
        if (!inferred && !picker) {
          // The existing TUI completion pattern with a stable screen.
          expect(waitFor(session, completedClaudeTurnPattern("extreme"), remainingWorkMs(), 1_000)).toBe(true);
        }

        const native = nativeTurn(sessionId);
        expect(native).toBeDefined();
        const rows = native!.rows;
        const stops = rows.filter((row) => row.type === "system" && row.subtype === "stop_hook_summary");
        expect(stops.flatMap((row) => row.hookErrors ?? [])).toEqual([]);
        const calls = nativeToolCalls(native!.raw);
        const refused = calls.findIndex((call) => isCanonicalDepthRefusalCall(call, proj));
        expect(refused).toBeGreaterThanOrEqual(0);
        const callId = (calls[refused] as NativeToolCall & { id: string }).id;
        expect(callId).toBeString();
        const rejectedResult = rows.findIndex((row) => resultRowFor(row, callId));
        expect(rejectedResult).toBeGreaterThanOrEqual(0);
        // next refuses the value before naming any command, so nothing mutates
        // there. Pin its directive and the tool identity, never the model's wording.
        const directive = refusedDirective(rows[rejectedResult], callId);
        expect(directive).toBeDefined();
        expect(directive!.message, directive!.kind).toMatch(DEPTH_REFUSALS[directive!.kind]);

        if (!inferred) {
          // The agent asked once: as one open picker (the only call after the
          // refusal, one question, nobody answers it for the person), or in
          // prose (no call after the refusal, a reply, the turn ended). Either
          // way nothing on disk changed, not even Last Updated (the refusal
          // short-circuits before writeStateFile).
          const afterRefusal = calls.slice(refused + 1);
          if (picker) {
            expect(afterRefusal.map((call) => call.name)).toEqual(["AskUserQuestion"]);
            const questions = (afterRefusal[0].input as { questions?: unknown[] }).questions ?? [];
            expect(questions.length, "one question, asked once").toBe(1);
          } else {
            expect(stops.length).toBeGreaterThan(0);
            expect(afterRefusal).toEqual([]);
            settledToolCount = calls.length;
            const finalReply = rows.slice(rejectedResult + 1)
              .filter((row) => row.type === "assistant" &&
                row.message?.content?.some((block) => block.type === "text"))
              .at(-1);
            expect(finalReply).toBeDefined();
            const refusal = (finalReply!.message?.content ?? [])
              .filter((block) => block.type === "text").map((block) => block.text ?? "")
              .join("\n");
            expect(refusal.trim().length).toBeGreaterThan(0);
          }
          expect(readFileSync(statePath, "utf8")).toBe(before);
          expect(readAllAuditShards(proj)).not.toMatch(/^\*\*Event\*\*: DEPTH_CHANGED$/m);
          expect(workflowArtifacts(statePath)).toEqual(artifactsBefore);
          return;
        }

        // The agent read the word as a level: the engine's own setter recorded it
        // and said it back in its line, and the work carried on through next in
        // the same turn (#2318). The record lands before the transcript does, so
        // wait for the setter's result and the carry-on to reach it.
        const setterAndCarryOn = (): { calls: NativeToolCall[]; rows: NativeRow[]; setter: number } | null => {
          const turn = nativeTurn(sessionId);
          if (!turn) return null;
          const seen = nativeToolCalls(turn.raw);
          const setter = seen.findIndex((call) => depthSetterLevel(call, proj) !== null);
          if (setter <= refused) return null;
          const setterId = (seen[setter] as NativeToolCall & { id?: string }).id;
          if (typeof setterId !== "string" || !turn.rows.some((row) => resultRowFor(row, setterId))) return null;
          if (!seen.slice(setter + 1).some((call) => isEngineNextOrContinue(call, proj))) return null;
          return { calls: seen, rows: turn.rows, setter };
        };
        expect(await waitForDisk(() => setterAndCarryOn() !== null, remainingWorkMs())).toBe(true);
        const carried = setterAndCarryOn()!;
        const level = depthSetterLevel(carried.calls[carried.setter], proj)!;
        const setterId = (carried.calls[carried.setter] as NativeToolCall & { id: string }).id;
        // The setter's own line names the level it set and the one it replaced.
        expect(toolResultText(carried.rows, setterId), `the setter's line for ${level}`)
          .toMatch(new RegExp(`^Depth changed: Standard -> ${capitalized(level)}$`, "m"));

        // --- ON DISK: that one setting, and nothing else of the person's. -------
        const after = readFileSync(statePath, "utf8");
        expect(after).toMatch(new RegExp(`-\\s*\\*\\*Depth\\*\\*:\\s*${capitalized(level)}`));
        expect(withoutDepthSetting(after)).toBe(withoutDepthSetting(before));
        const rowsAfter = auditEventCounts(proj);
        expect(rowsAfter.get("DEPTH_CHANGED") ?? 0).toBe((rowsBefore.get("DEPTH_CHANGED") ?? 0) + 1);
        const answered = ANSWER_ROWS.filter((row) => (rowsAfter.get(row) ?? 0) > (rowsBefore.get(row) ?? 0));
        expect(answered, "rows answered or decided in the person's place").toEqual([]);
      } finally {
        const killed = drive(["kill", "--session", session]);
        const native = nativeTurn(sessionId);
        if (native && process.env.AIDLC_TEST_LOG_DIR) {
          writeFileSync(join(process.env.AIDLC_TEST_LOG_DIR, `t27-native-${sessionId}.jsonl`), native.raw);
        }
        cleanupTuiProjectAfterKill(
          proj,
          session,
          killed,
        );
        // In the asked-once shape every call settled before teardown; include
        // every call through teardown, not just the earlier settled read.
        if (settledToolCount !== undefined) {
          expect(native ? nativeToolCalls(native.raw).length : -1).toBe(settledToolCount);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
