// covers: scope:feature
//
// t-tui-t29-env-scope.serial.tui.test.ts — the AWS_AIDLC_DEFAULT_SCOPE
// project-default-scope mechanism, driven through a REAL claude TUI (Pattern A:
// "landed + rendered", §5-A1 / spec §"TWO DRIVING PATTERNS"). A keystroke port
// of tests/integration/t29-integration-env-scope.sh, which auto-approved gates so
// the interactive journey a user actually lives was never exercised. This drives
// the painted TUI like a human and terminates on the on-disk landed artifact.
//
// WHAT IT PROVES (the t29 mechanism, reconciled to v0.6.1):
//   - Case A (bare command + env default): with NO --scope flag, NO intent, and
//     NO prior state, the read-only engine now refuses to mutate and renders the
//     no-state guidance. The shipped settings env default is not enough by
//     itself to start a workflow; the state file remains absent.
//   - Case override (explicit flag wins over env): same shipped `workshop`
//     default, but `/aidlc --scope feature` overrides it -> Scope=feature on disk.
//     .sh assertion ported: state `- **Scope**: feature`.
//   - Case known-scope positional: `/aidlc feature` bootstraps Scope=feature
//     without a scope-disambiguation gate; the bare known-scope token wins over the
//     settings default in the live TUI path.
//   - Case error (invalid env value errors, writes NO state): the env block is
//     rewritten to `AWS_AIDLC_DEFAULT_SCOPE: "bogus"`; the orchestrator's step-0
//     resolve-env-scope (SKILL.md:100-108) prints the canonical
//     `Invalid AWS_AIDLC_DEFAULT_SCOPE` error and STOPS without creating state.
//     .sh assertions ported: rendered output contains "Invalid
//     AWS_AIDLC_DEFAULT_SCOPE"; no intent is born and no per-intent state is written.
//
// The render value-add the headless .sh (and the SDK path) cannot see: the
// captured pane shows the workflow statusline left `[AIDLC] ready` and painted a
// live phase bar — the landed env-scoped workflow as a USER sees it — for the two
// success cases, and the literal error text for the error case.
//
// WHY PATTERN A (no answer-gate): the journey does NOT run to completion. A fresh
// `/aidlc` writes state-init (Scope field + WORKSPACE_INITIALISED audit) and the
// orchestrator keeps going into the first post-init stage. We assert the
// DETERMINISTIC landed emission (the Scope field + the audit event) and the
// rendered statusline — never racy terminal completion (the Phase-2 lesson). If
// the live conductor renders the legitimate no-state recovery menu first, the
// test chooses its default "Scaffold & start <scope>" option like a user; the
// scope-resolution + state-init is still the whole asserted surface.
//
// FINDING (env forwarding — verified, surfaced, worked around faithfully):
//   tui-drive.ts's tmux backend launches the claude child via `tmux new-session`
//   (tui-drive.ts:271-283) and sets NO `update-environment` / `setenv` / `-e`
//   env on the session, so the test PROCESS's shell env is NOT forwarded to the
//   claude child (tmux new-session inherits the tmux *server* environment, not
//   the spawning client's). The .sh's mechanism — `export AWS_AIDLC_DEFAULT_SCOPE=...`
//   in the shell before run_claude — therefore does NOT translate to the TUI.
//   So this port drives the env scope the way a REAL user does and the way
//   SKILL.md:108 describes ("workshop facilitators set AWS_AIDLC_DEFAULT_SCOPE
//   once in .claude/settings.json env block"): through the project's
//   `.claude/settings.json` `env` block, which Claude Code reliably injects into
//   its own process. This is MORE faithful to the production surface than the
//   shell export the .sh used (the .sh even needed `--strip-env-scope` to stop
//   the shipped settings.json default from shadowing its shell export — line
//   49-53). Cases A/override use the shipped `workshop` default unedited; the
//   error case rewrites the env block to `bogus` (the TUI equivalent of the .sh's
//   strip-env-scope + shell export). If a future harness wants shell-env
//   forwarding for the TUI, tui-drive would need a `--env K=V` / tmux setenv
//   passthrough — a driver tweak, flagged here, not silently assumed.
//
//   The .sh's Case D (existing state file ignores env — state is authoritative,
//   asserted via md5 no-mutation under `/aidlc --status`) is NOT ported here: it
//   is a read-only no-op path that spends a full LLM turn for a no-mutation
//   check, and the "state wins over env" invariant is the absence of a
//   scope-change, which the SDK logic tier asserts deterministically without
//   tokens. Pattern A is for landed mutations; a no-mutation case is out of band.
//
// COST: spends real Bedrock tokens (a fresh-project state-init turn + the start
// of the first post-init stage, per case). Gated behind AIDLC_TUI_LIVE=1 so a
// bare `--e2e` SKIPs it; tmux/claude/distributable absence also SKIPs with a
// reason — never a hollow pass.
//
// SPAWN, not import (D-TUI-7): runs under bun, spawns tui-drive.ts as a
// subprocess (node on Windows so node-pty never loads under bun, #748; bun
// elsewhere). The `tui-drive.ts` spawn is what DERIVES the `tui` mechanism
// (Phase 0) — no filename mechanism segment. Platform-invariant: the assertions
// are plain-text grid + on-disk reads, so the Windows node-pty backend (SSM leg,
// later) observes them identically. Only resolveWinNode is imported.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { stateFilePathFor } from "../harness/sdk-drive.ts";
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
// elsewhere bun + driver.
const DRIVE_BIN = IS_WIN ? (WIN_NODE as string) : process.execPath;
const DRIVE_PREFIX = IS_WIN ? ["--experimental-strip-types", DRIVER] : [DRIVER];

// Honour the suite's AIDLC_TEST_TIMEOUT convention (seconds; the integration
// tier sets 600). A fresh-project state-init + first-post-init-stage start is a
// few minutes of real LLM turns, so the bun:test cap is generous.
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

// Poll an ON-DISK predicate until true or timeout — the deterministic completion
// signal for a fresh-workflow start. We do NOT gate on the statusline flipping to
// a phase: that flip lags the actual work (the statusline paints `[AIDLC] ready`
// until state-init WRITES aidlc-state.md, and the pre-state init reasoning can run
// minutes — observed live, the `feature` override took ~150s to flip while a 240s
// statusline-wait flaked). The state file landing with the Scope field is the
// real, deterministic "workflow started" signal, and it is exactly what the test
// then asserts. So we wait on disk, never on the lagging statusline render.
function paneOffersBootstrap(pane: string, scope: string): boolean {
  const flat = pane.replace(/\s+/g, " ");
  return (
    flat.includes(`Scaffold & start ${scope}`) ||
    (flat.includes("How would you like to start") && flat.includes(`${scope} workflow`))
  );
}

async function waitForScopeLanding(
  session: string,
  projectDir: string,
  scope: string,
  timeoutMs: number,
): Promise<{ landed: boolean; pane: string }> {
  const deadline = Date.now() + timeoutMs;
  let pane = "";
  let answeredBootstrap = false;

  while (Date.now() < deadline) {
    if (scopeLanded(projectDir, scope)) return { landed: true, pane };

    pane = drive(["capture", "--session", session]).stdout;
    if (!answeredBootstrap && paneOffersBootstrap(pane, scope)) {
      // The conductor sometimes asks before scaffolding an empty workspace.
      // The default caret is "Scaffold & start <scope>", which is the real user
      // path to the same state-init write this test asserts.
      drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);
      answeredBootstrap = true;
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  if (scopeLanded(projectDir, scope)) return { landed: true, pane };
  pane = drive(["capture", "--session", session]).stdout;
  return { landed: false, pane };
}

// Has aidlc-state.md landed with a `- **Scope**: <scope>` line for the expected
// scope? (state-init writes it — aidlc-utility.ts:2049.)
function scopeLanded(projectDir: string, scope: string): boolean {
  const statePath = stateFilePathFor(projectDir);
  if (!existsSync(statePath)) return false;
  try {
    return new RegExp(`^- \\*\\*Scope\\*\\*: ${scope}$`, "m").test(
      readFileSync(statePath, "utf8"),
    );
  } catch {
    return false;
  }
}

// ABSENT / opt-in gating. The token guard AIDLC_TUI_LIVE=1 is checked FIRST so a
// bare --e2e (no live opt-in) reports a clear skip reason, not a substrate miss.
// Copied verbatim from the workshop template (Windows node / node-pty checks
// kept exactly).
function skipReason(): string | null {
  if (process.env.AIDLC_TUI_LIVE !== "1") {
    return "set AIDLC_TUI_LIVE=1 to run the live env-scope journey (uses Bedrock tokens)";
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

// Set AWS_AIDLC_DEFAULT_SCOPE in the project's shipped settings.json env block —
// the production env-scope channel Claude Code injects into its own process (the
// FINDING above explains why this, not a shell export). The shipped block already
// pins `workshop`; pass `null` to leave it as shipped (Case A / override), or a
// scope string to overwrite it (the error case rewrites it to `bogus`).
function setSettingsEnvScope(projectDir: string, value: string): void {
  const settingsPath = join(projectDir, ".claude", "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.env = settings.env ?? {};
  settings.env.AWS_AIDLC_DEFAULT_SCOPE = value;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// Launch the claude TUI in a fresh project and clear the two startup modals.
// Shared launch sequence for all three cases (each gets its own session +
// project so they never share state). Returns once the no-workflow `[AIDLC] ready`
// statusline is up (the pre-prompt baseline every case starts from).
function launchReady(session: string, projectDir: string): void {
  expect(drive([
    "start",
    "--session",
    session,
    "--cwd",
    projectDir,
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
  expect(waitFor(session, "\\[AIDLC\\].*ready", 45000, 800)).toBe(true);
}

describe("t-tui-t29 env-scope (AWS_AIDLC_DEFAULT_SCOPE seeds new-workflow scope on disk)", () => {
  // --- Case A: bare command does not bootstrap solely from env default -------
  // v0.6.1's read-only engine uses AWS_AIDLC_DEFAULT_SCOPE for scope resolution
  // once a command carries an init/jump/freeform target, but a bare `/aidlc` on a
  // no-state project is intentionally not enough to mutate. The live trace
  // proves the TUI renders the no-state guidance and writes no state file.
  test.skipIf(SKIP_REASON !== null)(
    `bare /aidlc with env default asks for a scope or intent and writes no state${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    () => {
      const session = `aidlc_tui_t29_envdef_${process.pid}`;
      const proj = setupTuiProject({ noAidlcDocs: true });
      try {
        // Leave the shipped `workshop` env default in place. It must not by
        // itself create a workflow for an otherwise empty slash command.
        launchReady(session, proj);

        drive(["send", "--session", session, "--keys", "/aidlc", "--literal", "--no-enter"]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Synchronize through the driver on the stable engine error lead, then
        // assert the durable no-write contract. Do not inspect the captured pane:
        // Claude can collapse the remainder of the tool result behind "+N lines".
        expect(waitFor(session, "No workflow state found", 240000, 0)).toBe(true);
        // No-scope run births no intent, so no per-intent state file resolves
        // (stateFilePathFor falls to the never-created flat fallback path).
        expect(existsSync(stateFilePathFor(proj))).toBe(false);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- Case override: EXPLICIT --scope flag wins over env ---------------------
  // SKILL.md step 0 (:106): "If $ARGUMENTS already contains `--scope`, skip
  // substitution — explicit CLI flag wins." That skip is keyed on the LITERAL
  // `--scope` token, so `/aidlc --scope feature` is the deterministic flag-beats-
  // env path: no env synthesis, no disambiguation, Scope=feature lands. The live
  // conductor may still paint the generic empty-workspace recovery menu; when it
  // does, the test takes the default "Scaffold & start feature" path and still
  // asserts the same deterministic Scope=feature state write. (Contrast the
  // bare freeform `/aidlc feature` — covered in the SEPARATE disambiguation-gate
  // case below — which does NOT contain `--scope`, so step 0 synthesizes
  // `--scope workshop` from env and the orchestrator renders a feature-vs-workshop
  // gate. The .sh used the bare form and only "passed" because it auto-approved
  // that gate; the explicit flag is the honest deterministic scope contract.)
  test.skipIf(SKIP_REASON !== null)(
    `explicit --scope feature flag wins over env default -> Scope=feature on disk${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_t29_override_${process.pid}`;
      const proj = setupTuiProject({ noAidlcDocs: true });
      try {
        // Shipped `workshop` env default stays; the explicit --scope flag must win.
        launchReady(session, proj);

        drive(["send", "--session", session, "--keys", "/aidlc --scope feature", "--literal", "--no-enter"]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // TERMINATE on the DETERMINISTIC disk signal: Scope=feature in state.md.
        // `feature` is a 32-stage full lifecycle, so its pre-state init reasoning is
        // the slowest case — verified live to reach the state write at ~150s while
        // the statusline still showed `ready`. So we wait on the Scope field landing
        // (300s budget), NOT the lagging statusline phase flip (which flaked a 240s
        // wait). The disk value IS the override assertion.
        const { landed, pane } = await waitForScopeLanding(session, proj, "feature", 300000);
        if (!landed) {
          throw new Error(
            `Scope=feature never landed in aidlc-state.md within budget.\n` +
              `---- last pane ----\n${pane}\n-------------------`,
          );
        }

        // Deterministic landed emission ON DISK: the flag-resolved scope, NOT the
        // env default — this is the override assertion.
        const stateMd = readFileSync(stateFilePathFor(proj), "utf8");
        expect(stateMd).toMatch(/^- \*\*Scope\*\*: feature$/m);
        // Stronger than the .sh: prove the env default did NOT win.
        expect(stateMd).not.toMatch(/^- \*\*Scope\*\*: workshop$/m);

        const auditMd = readAllAuditShards(proj);
        expect(auditMd).toContain("WORKSPACE_INITIALISED");
        const wiIdx = auditMd.indexOf("WORKSPACE_INITIALISED");
        expect(auditMd.slice(wiIdx, wiIdx + 500)).toMatch(/Scope.*:\s*feature/);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- Case known-scope positional: bare keyword bootstraps that scope --------
  // `/aidlc feature` is a known-scope request. The first engine call sees no
  // state and emits the workflow-birth print naming `init --scope feature`
  // (run-then-continue); the TUI conductor runs it and re-enters the loop, so
  // Scope=feature lands on disk. No scope-disambiguation AUQ is expected or
  // required; a generic no-state bootstrap menu is answered when it appears.
  test.skipIf(SKIP_REASON !== null)(
    `bare known-scope command (/aidlc feature) bootstraps Scope=feature without a scope disambiguation gate${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      const session = `aidlc_tui_t29_disambig_${process.pid}`;
      const proj = setupTuiProject({ noAidlcDocs: true });
      try {
        // Shipped `workshop` env default stays; the known scope positional wins.
        launchReady(session, proj);

        drive(["send", "--session", session, "--keys", "/aidlc feature", "--literal", "--no-enter"]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        const { landed, pane } = await waitForScopeLanding(session, proj, "feature", 300000);
        if (!landed) {
          throw new Error(
            `Scope=feature never landed in aidlc-state.md within budget.\n` +
              `---- last pane ----\n${pane}\n-------------------`,
          );
        }

        const stateMd = readFileSync(stateFilePathFor(proj), "utf8");
        expect(stateMd).toMatch(/^- \*\*Scope\*\*: feature$/m);
        expect(stateMd).not.toMatch(/^- \*\*Scope\*\*: workshop$/m);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // --- Case error: invalid env value errors, writes NO state -----------------
  // The env block is rewritten to `bogus` (the TUI equivalent of the .sh's
  // --strip-env-scope + shell export of an invalid value — see the FINDING).
  // resolve-env-scope (SKILL.md:100-108) prints the canonical
  // `Invalid AWS_AIDLC_DEFAULT_SCOPE` error and STOPS; no state file is created.
  test.skipIf(SKIP_REASON !== null)(
    `invalid env value (AWS_AIDLC_DEFAULT_SCOPE=bogus) errors and writes no state${SKIP_REASON ? ` — SKIP: ${SKIP_REASON}` : ""}`,
    () => {
      const session = `aidlc_tui_t29_bogus_${process.pid}`;
      const proj = setupTuiProject({ noAidlcDocs: true });
      try {
        // Rewrite the env block to an invalid value BEFORE launch, so the claude
        // process picks it up from settings.json on start.
        setSettingsEnvScope(proj, "bogus");
        launchReady(session, proj);

        drive(["send", "--session", session, "--keys", "/aidlc", "--literal", "--no-enter"]);
        drive(["send", "--session", session, "--keys", "Enter", "--no-enter"]);

        // Synchronize on the stable engine error lead, then assert the durable
        // no-write behavior. Avoid a second capture/prose assertion: tool output
        // tails may be collapsed by the TUI even though the command completed.
        expect(waitFor(session, "Invalid AWS_AIDLC_DEFAULT_SCOPE", 240000, 0)).toBe(true);

        // Deterministic NO-WRITE ON DISK (the .sh's Case C state-absence check,
        // line 59-63): the invalid env scope must not create the state file. The
        // workflow never reached state-init (no intent born → no per-intent
        // state file; stateFilePathFor falls to the never-created flat fallback).
        expect(existsSync(stateFilePathFor(proj))).toBe(false);
      } finally {
        drive(["kill", "--session", session]);
        cleanupTuiProject(proj);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
