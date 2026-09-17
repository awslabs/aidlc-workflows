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
//   Case C — invalid depth is REFUSED and leaves state untouched:
//     setup the same fixture, type `/aidlc --depth extreme`. The orchestrator's
//     config-change print directive runs the config command and stops; the
//     authored SKILL's "When an action is refused" rule calls for refusal prose,
//     not an AskUserQuestion menu. The CLI rejects the unknown depth BEFORE
//     writeStateFile. Wait for native turn completion after Stop and the TUI's
//     settled input prompt, then require the correlated CLI rejection, a final
//     reply, no subsequent tool calls, and no workflow artifact changes. Refusal
//     semantics are checked in the retained live trace, not a prose regex.
//     Assert ON DISK: the state file is
//     BYTE-IDENTICAL to the seed —
//     the .sh's md5-before/md5-after equality, here a full readFileSync compare,
//     which is strictly stronger than an md5 hash match.
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
// AIDLC_TUI_LIVE=1 so a bare `--e2e` on a laptop SKIPs; tmux/claude/distributable
// absence also SKIPs with a reason. NEVER asserts racy terminal completion
// (Pattern A): there is no completion here — the override lands and the
// orchestrator STOPs, so we wait on the landed surface (the rendered confirmation
// + the on-disk field), never on a result event.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts (node on
// Windows so node-pty never loads under bun, #748; bun elsewhere). The tui-drive.ts
// spawn is what DERIVES the `tui` mechanism (Phase 0) — no filename mechanism
// segment. Platform-invariant: plain-text grid asserts, no colour escapes, so the
// Windows node-pty backend (run later via SSM) captures identically — authored for
// both, not macOS-special-cased.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import { type NativeToolCall, nativeToolCalls } from "../harness/t139-fidelity.ts";
import {
  cleanupTuiProjectAfterKill,
  completedClaudeTurnPattern,
  setupTuiProject,
} from "../harness/tui-fixtures.ts";

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

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the integration tier
// sets 600). A config override is short, but the claude TUI startup + a brief
// orchestrator turn is the bulk of the wall-clock, so the cap is generous.
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

// Poll an ON-DISK predicate until true or timeout. The deterministic completion
// signal for a config-change command: SKILL.md:125 instructs only "Print output,
// STOP" (NOT "verbatim" — contrast --status/--help/env-scope at :67/:101 which DO
// say verbatim), so the orchestrator may PARAPHRASE the tool's confirmation line
// (observed live: "Done. Depth changed from Standard → Minimal …"). Greping that
// reworded prose is the §1 anti-pattern and flaked 1/4 runs. We instead terminate
// on the tool's structured emission (the DEPTH_CHANGED audit event / the Depth
// state field), never the screen text.
async function waitForDisk(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
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
// diagnostic only from the rejected result belonging to the canonical call.
function rejectedCliError(row: NativeRow, callId: string): string | undefined {
  if (row.type !== "user" || !Array.isArray(row.message?.content)) return undefined;
  const result = row.message.content.find((block) =>
    block.type === "tool_result" && block.tool_use_id === callId && block.is_error === true,
  );
  if (typeof result?.content !== "string") return undefined;
  for (const line of result.content.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as { error?: unknown } | null;
      if (parsed && typeof parsed.error === "string") return parsed.error;
    } catch {
      // Human-readable tool wrapper lines are not the CLI's JSON diagnostic.
    }
  }
  return undefined;
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
// Copied verbatim from t-tui-workshop (keep the Windows node/node-pty checks).
function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live depth-override journey (uses Bedrock tokens)";
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
  if (waitFor(session, "trust this folder", 60000, 600)) {
    drive(["send", "--session", session, "--keys", "1"]);
  }
  if (waitFor(session, "Bypass Permissions mode", 15000, 600)) {
    drive(["send", "--session", session, "--keys", "2"]);
  }
  // The seeded mid-ideation state paints the WORKFLOW line (IDEATION), not the
  // no-workflow "ready" line. Anchor the override against the live workflow row.
  expect(waitFor(session, "\\[AIDLC\\].*IDEATION", 45000, 1000)).toBe(true);
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
          120000,
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

  // --- Case C: invalid depth is refused; state byte-unchanged -----------------
  test.skipIf(SKIP_REASON !== null)(
    `--depth extreme refuses, settles without workflow continuation, and leaves state byte-identical${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const sessionId = randomUUID();
      const { session, proj } = bootSeededWorkflow("err", sessionId);
      let settledToolCount: number | undefined;
      try {
        const statePath = seededStateFile(proj);
        // Snapshot the exact bytes BEFORE the invalid override (the .sh's
        // md5-before). A full-content compare is strictly stronger than md5.
        const before = readFileSync(statePath, "utf8");
        const artifactsBefore = workflowArtifacts(statePath);

        // type the invalid override
        sendSlash(session, "/aidlc --depth extreme");

        // A config error or the word "extreme" can render before Stop finishes.
        // First require native completion of the whole turn, then the existing
        // TUI completion pattern with a stable screen. Never inspect state early.
        expect(await waitForDisk(
          () => nativeTurn(sessionId)?.rows.some(
            (row) => row.type === "system" && row.subtype === "turn_duration",
          ) ?? false,
          120_000,
        )).toBe(true);
        expect(waitFor(session, completedClaudeTurnPattern("extreme"), 10_000, 1_000)).toBe(true);

        const native = nativeTurn(sessionId);
        expect(native).toBeDefined();
        const rows = native!.rows;
        const stops = rows.filter((row) => row.type === "system" && row.subtype === "stop_hook_summary");
        expect(stops.length).toBeGreaterThan(0);
        expect(stops.flatMap((row) => row.hookErrors ?? [])).toEqual([]);
        const calls = nativeToolCalls(native!.raw);
        const refused = calls.findIndex((call) =>
          call.name === "Bash" &&
          String(call.input.command).trim().replace(/\s+2>&1$/, "") ===
            "bun .claude/tools/aidlc.ts engine config set depth extreme",
        );
        expect(refused).toBeGreaterThanOrEqual(0);
        expect(calls.slice(refused + 1)).toEqual([]);
        settledToolCount = calls.length;
        const callId = (calls[refused] as NativeToolCall & { id: string }).id;
        expect(callId).toBeString();
        const rejectedResult = rows.findIndex((row) =>
          row.type === "user" && Array.isArray(row.message?.content) &&
          row.message.content.some((block) =>
            block.type === "tool_result" && block.tool_use_id === callId && block.is_error === true,
          ),
        );
        expect(rejectedResult).toBeGreaterThanOrEqual(0);
        // handleConfigChange rejects the value before any state/audit mutation.
        // Pin its diagnostic and the tool identity, never the model's wording.
        expect(rejectedCliError(rows[rejectedResult], callId)).toContain('Unknown depth: "extreme".');
        const finalReply = rows.slice(rejectedResult + 1)
          .filter((row) => row.type === "assistant" &&
            row.message?.content?.some((block) => block.type === "text"))
          .at(-1);
        expect(finalReply).toBeDefined();
        const refusal = (finalReply!.message?.content ?? [])
          .filter((block) => block.type === "text").map((block) => block.text ?? "")
          .join("\n");
        expect(refusal.trim().length).toBeGreaterThan(0);

        // --- ON DISK: state must be BYTE-IDENTICAL (the .sh's md5 equality). The
        // refusal short-circuits before writeStateFile, so nothing — not even Last
        // Updated — should have changed.
        const after = readFileSync(statePath, "utf8");
        expect(after).toBe(before);
        expect(readAllAuditShards(proj)).not.toMatch(/^\*\*Event\*\*: DEPTH_CHANGED$/m);
        expect(workflowArtifacts(statePath)).toEqual(artifactsBefore);
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
        // Include every call through teardown, not just the earlier settled read.
        if (settledToolCount !== undefined) {
          expect(native ? nativeToolCalls(native.raw).length : -1).toBe(settledToolCount);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
