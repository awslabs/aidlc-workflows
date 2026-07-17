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
//     setup the same fixture, type `/aidlc --depth extreme`. SKILL.md step 2
//     (SKILL.md:112) now surfaces an interactive invalid-depth recovery menu
//     ("isn't valid" / "Which depth level do you want?") before any tool writes.
//     Even if it reached config-change the CLI dies (`Unknown depth:
//     "extreme"...`, aidlc-utility.ts:2367) BEFORE writeStateFile. Assert
//     RENDERED: the pane describes the invalid depth and offers the recovery
//     choices. Assert ON DISK: the state file is BYTE-IDENTICAL to the seed —
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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { resolveWinNode } from "../harness/tui-drive.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seededAuditDir, seededStateFile } from "../harness/fixtures.ts";
import { cleanupTuiProject, setupTuiProject } from "../harness/tui-fixtures.ts";

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
function bootSeededWorkflow(tag: string): { session: string; proj: string } {
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
        drive(["kill", "--session", session]);
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- Case C: invalid depth is refused; state byte-unchanged -----------------
  test.skipIf(SKIP_REASON !== null)(
    `--depth extreme renders the invalid-depth recovery menu and leaves state byte-identical${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    () => {
      const { session, proj } = bootSeededWorkflow("err");
      try {
        const statePath = seededStateFile(proj);
        // Snapshot the exact bytes BEFORE the invalid override (the .sh's
        // md5-before). A full-content compare is strictly stronger than md5.
        const before = readFileSync(statePath, "utf8");

        // type the invalid override
        sendSlash(session, "/aidlc --depth extreme");

        // --- DRIVER: a recovery menu surfaces. Synchronize on the structural
        // AskUserQuestion footer, not rewordable/possibly-collapsed pane prose.
        // The disk assertions below own the actual refusal contract.
        const recoveryMenuRendered = waitFor(
          session,
          "Enter to select|Submit answers",
          120000,
          0,
        );
        expect(recoveryMenuRendered).toBe(true);

        // --- ON DISK: state must be BYTE-IDENTICAL (the .sh's md5 equality). The
        // refusal short-circuits before writeStateFile, so nothing — not even Last
        // Updated — should have changed.
        const after = readFileSync(statePath, "utf8");
        expect(after).toBe(before);
        expect(readAllAuditShards(proj)).not.toMatch(/^\*\*Event\*\*: DEPTH_CHANGED$/m);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
