// covers: file:core/tools/aidlc-state.ts
//
// t-ide-kiro-checkpoint.serial.test.ts - the FIRST live test that drives the Kiro
// IDE (the Electron desktop app), not the Kiro CLI. Every existing live Kiro test
// drives the CLI over ACP (t-acp-kiro-*) or over a tmux TUI (t-tui-kiro-*); NONE
// drives the GUI app. This is the gap, and it is the enforcement surface for the
// human-presence gate. The live IDE half proves UserPromptSubmit records the
// HUMAN_TURN and a legitimate approval commits through Kiro; a direct shipped-tool
// attempt then proves the core guard refuses a second approval with no later human
// turn. The fabricated attempt intentionally bypasses Kiro and does not claim
// PreToolUse integration coverage.
//
// Mirrors the skip-clean conventions of t-tui-kiro-status.serial.test.ts (the
// closest sibling: live Kiro, opt-in env gate, skipReason() chain, reason in the
// test title, AIDLC_TEST_TIMEOUT 3rd arg, setupTuiProject + cleanupTuiProject in
// finally, disk-only assertions). The ONE structural departure: it drives the
// Electron app via a bun-native raw-CDP helper (kiro-ide-driver.ts), NOT the tmux
// tui-drive.ts - Playwright was rejected (see kiro-ide-driver.ts header).
//
// NAMING (load-bearing): the file is `t-ide-kiro-*`, NOT `t-tui-*`. run-tests.ts
// holds every `t-tui*` e2e file behind the tmux `t-tui-preflight` capability gate;
// a `t-tui-*` name would wrongly SKIP this CDP/no-tmux test on every tmux-less box.
// The `t-ide-` prefix runs it in the first/non-TUI band, the same way
// `t-exec-codex-*` and `t-acp-kiro-*` dodge the gate. `.serial.` pins it serial
// (run-tests.ts:596) so one Kiro desktop app + one debug port run alone.
//
// LIVE: uses real Kiro IDE (Bedrock credits). Gated behind AIDLC_KIRO_IDE_LIVE=1,
// which does NOT auto-default (only AIDLC_TUI_LIVE self-defaults, run-tests.ts:
// 261-262) - an unset var SKIPS, it never silent-greens. This adds a SIXTH live
// gate var; per CLAUDE.local.md it must be set EXPLICITLY in any slice command or
// the test skips green (a false green - it exercises nothing).
//
// SEED-PROFILE (RESOLVED, the seed spike under the private tmp working area): a fresh
// Kiro user-data-dir hits the "Import configuration" onboarding wall and never reaches
// chat. The skip is ONE global-state flag (kiroAgent.onboarding.onboardingCompleted).
// The generated seed contains ZERO credentials; a signed-in Kiro host remains required.
// We GENERATE the minimal seed from constants at setup (generateKiroIdeSeed), so nothing
// sensitive is copied or committed. AIDLC_KIRO_IDE_SEED may still point at a
// developer-supplied user-data-dir to override; absent, the generated seed is used.
//
// SHAPE OF THE REPRO (constructed, not organic): the fault is intermittent and
// emerges deep into a long session; a deterministic test cannot reproduce the
// organic drift, so we CONSTRUCT it (the fix-spike approach): seed a real
// STAGE_AWAITING_APPROVAL gate, send ONE human prompt that approves the open
// gate (backed by the one HUMAN_TURN the prompt recorded; it commits, emitting
// GATE_APPROVED), then construct the NEXT stage's gate for real and attempt its
// approval directly through the shipped report verb with no further human
// input: that attempt finds NO HUMAN_TURN after the first GATE_APPROVED and is
// REFUSED by the core gate. The fabricated attempt is deterministic, not
// model-mediated - a steering-conformant conductor refuses to fabricate
// approvals itself, so the model cannot be relied on to attempt one. One human
// turn commits at most one gate.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { seededAuditShard, seededRecordDir } from "../harness/fixtures.ts";
import { cleanupTuiProject, KIRO_IDE_SRC, setupTuiProject } from "../harness/tui-fixtures.ts";
import {
  autoApprove,
  generateKiroIdeSeed,
  KIRO_IDE_BIN,
  launchKiroIde,
  pageTarget,
  removeSeedDir,
  snapshotChatDom,
  teardown,
  typeAndSubmit,
  waitForCdp,
  waitForChatInput,
  watchMarkers,
} from "../harness/kiro-ide-driver.ts";

const TIMEOUT_S = Number.parseInt(process.env.AIDLC_TEST_TIMEOUT ?? "2400", 10);
const TEST_TIMEOUT_MS = (Number.isFinite(TIMEOUT_S) ? TIMEOUT_S : 2400) * 1000;

// TEST-GRADE: a per-process port so back-to-back runs never collide on a fixed
// debug port (the spike hardcoded 9337/9340/9341). The runner pins this file serial
// via the `.serial.` token, so one process => one port band is enough.
const PORT = 9400 + (process.pid % 500);

// Optional override: point AIDLC_KIRO_IDE_SEED at a developer-supplied user-data-dir.
// Absent (the normal case), the test GENERATES a minimal onboarding-skip seed from
// constants (no credentials, nothing committed - see header + generateKiroIdeSeed).
const SEED_OVERRIDE = process.env.AIDLC_KIRO_IDE_SEED ?? "";
const LIVE_CASE = process.env.AIDLC_KIRO_IDE_CASE ?? "all";
const DIAGNOSTICS_PATH = process.env.AIDLC_KIRO_IDE_DIAGNOSTICS ?? "";

if (!["all", "gate", "ratio"].includes(LIVE_CASE)) {
  throw new Error(
    `AIDLC_KIRO_IDE_CASE must be one of all, gate, or ratio; got ${JSON.stringify(LIVE_CASE)}`,
  );
}

// run-tests.ts disables this guard suite-wide for synthetic fixtures. This file
// is the dedicated live enforcement journey, so its Kiro child must inherit the
// real guard. The artifact and summary guard bypasses remain unchanged.
process.env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "0";

function diagnostic(event: string, fields: Record<string, unknown> = {}): void {
  if (!DIAGNOSTICS_PATH) return;
  appendFileSync(
    DIAGNOSTICS_PATH,
    `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields })}\n`,
    "utf-8",
  );
}

// Build a fresh per-test seed user-data-dir in a temp dir. Kiro mutates the profile
// in place, so each launch needs its own copy: if an override is supplied we COPY it
// (never mutate the developer's dir); otherwise we generate the minimal seed. Returns
// the dir; the caller removes it in finally via removeSeedDir (Windows lock latency).
function makeSeedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aidlc-kiro-ide-seed-"));
  if (SEED_OVERRIDE) {
    cpSync(SEED_OVERRIDE, dir, { recursive: true });
    return dir;
  }
  return generateKiroIdeSeed(dir);
}

// The committed stage slug = the gate open in state-mid-inception.md (Current Stage:
// requirements-analysis, the gate the human approves). The blocked slug = the Next
// Stage (code-generation), whose gate the first approve's reentrant advance opens and
// which the same-turn fabricated approval targets after the first gate commits. The
// constructed repro only needs the two to differ; pinned to the fixture's stage pair
// (tests/fixtures/state-mid-inception.md Current/Next Stage fields).
const COMMITTED_SLUG = "requirements-analysis";
const BLOCKED_SLUG = "code-generation";

function runSetupTool(sandbox: string, tool: string, args: string[]): void {
  const result = spawnSync(
    process.execPath,
    [join(sandbox, ".kiro", "tools", tool), ...args, "--project-dir", sandbox],
    {
      cwd: sandbox,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `${tool} ${args.join(" ")} failed (${result.status ?? "no status"}): ` +
        `${result.stderr || result.stdout}`,
    );
  }
}

/** Construct the real gate shape the live journey claims to exercise. */
function seedApprovalGate(sandbox: string): void {
  seedGateFor(sandbox, COMMITTED_SLUG);
}

function seedGateFor(sandbox: string, slug: string): void {
  const phase = slug === COMMITTED_SLUG ? "inception" : "construction";
  const stageDir = join(seededRecordDir(sandbox), phase, slug);
  mkdirSync(stageDir, { recursive: true });
  writeFileSync(
    join(stageDir, "requirements.md"),
    "# Requirements\n\n- Preserve one approval commit per human turn.\n",
    "utf-8",
  );
  writeFileSync(
    join(stageDir, "requirements-analysis-questions.md"),
    "# Requirements Analysis Questions\n\n- No open questions.\n",
    "utf-8",
  );
  const reviewer =
    slug === COMMITTED_SLUG
      ? "aidlc-product-lead-agent"
      : "aidlc-architecture-reviewer-agent";
  const reviewArgs = [
    "review",
    "--stage",
    slug,
    "--reviewer",
    reviewer,
    "--iteration",
    "1",
  ];
  runSetupTool(sandbox, "aidlc-log.ts", reviewArgs);
  runSetupTool(sandbox, "aidlc-log.ts", [...reviewArgs, "--verdict", "READY"]);
  runSetupTool(sandbox, "aidlc-state.ts", ["gate-start", slug]);
}

function skipReason(): string | null {
  // Order mirrors t-tui-kiro-status:56-68 - env gate (token/credit guard) first,
  // then platform, then binary, then the shipped distributable. The seed is no longer
  // a gate: it is generated from constants when AIDLC_KIRO_IDE_SEED is unset.
  if (process.env.AIDLC_KIRO_IDE_LIVE !== "1") {
    return "set AIDLC_KIRO_IDE_LIVE=1 to run the live Kiro IDE journey (uses Kiro credits)";
  }
  if (platform() !== "darwin" && platform() !== "win32") {
    return (
      "Kiro IDE driving requires macOS " +
      "(/Applications/Kiro.app/Contents/MacOS/Electron) or Windows " +
      "(%LOCALAPPDATA%\\Programs\\Kiro\\Kiro.exe)"
    );
  }
  if (!existsSync(KIRO_IDE_BIN)) {
    return (
      `Kiro IDE binary not found at ${KIRO_IDE_BIN}; expected ` +
      "/Applications/Kiro.app/Contents/MacOS/Electron on macOS or " +
      "%LOCALAPPDATA%\\Programs\\Kiro\\Kiro.exe on Windows " +
      "(override with AIDLC_KIRO_IDE_BIN)"
    );
  }
  if (SEED_OVERRIDE && !existsSync(SEED_OVERRIDE)) {
    return `AIDLC_KIRO_IDE_SEED set but path does not exist: ${SEED_OVERRIDE}`;
  }
  if (!existsSync(KIRO_IDE_SRC)) return `distributable missing: ${KIRO_IDE_SRC}`;
  return null;
}
const SKIP_REASON = skipReason();

// ---------------------------------------------------------------------------
// Disk-only assertion helpers (never assert on chat prose).
// ---------------------------------------------------------------------------

/** Count HUMAN_TURN events the shipped mint hook records in the per-intent audit
 *  shard (the prompt-submit hook appends one per real human prompt). The mint hook
 *  resolves the active intent from the on-disk cursor, so the event lands in the
 *  same shard seededAuditShard resolves. */
function humanTurnCount(sandbox: string): number {
  const shard = seededAuditShard(sandbox);
  if (!existsSync(shard)) return 0;
  return readFileSync(shard, "utf-8")
    .split("\n")
    .filter((l) => l === "**Event**: HUMAN_TURN").length;
}

/** Count GATE_APPROVED audit blocks whose `**Stage**:` field equals <slug> in the
 *  per-intent audit shard the spawned tool resolves (seededAuditShard). Block-scoped
 *  on Stage exactly like t49's stageCompletedCountFor - handleApprove emits
 *  GATE_APPROVED with a `Stage: <slug>` field, so a committed gate shows count 1 and
 *  a refused gate shows 0. */
function auditEventCountFor(sandbox: string, event: string, slug: string): number {
  const shard = seededAuditShard(sandbox);
  if (!existsSync(shard)) return 0;
  const lines = readFileSync(shard, "utf-8").split("\n");
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === `**Event**: ${event}`) {
      for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
        if (lines[j] === "---") break;
        if (lines[j] === `**Stage**: ${slug}`) {
          count++;
          break;
        }
      }
    }
  }
  return count;
}

function gateApprovedCountFor(sandbox: string, slug: string): number {
  return auditEventCountFor(sandbox, "GATE_APPROVED", slug);
}

function gateOpenedCountFor(sandbox: string, slug: string): number {
  return auditEventCountFor(sandbox, "STAGE_AWAITING_APPROVAL", slug);
}

describe("t-ide-kiro-checkpoint (live Kiro IDE human-turn recording + core gate enforcement)", () => {
  // Drives the SHIPPED dist/kiro-ide tree and asserts the live HUMAN_TURN event
  // plus the committed GATE_APPROVED ledger row. The second, fabricated approval
  // is a hybrid core-enforcement check through the shipped report command.
  test.skipIf(SKIP_REASON !== null || LIVE_CASE === "ratio")(
    `one human turn commits the approved gate and REFUSES a same-turn fabricated approval${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      // harness:"kiro-ide" seeds dist/kiro-ide/.kiro (including the
      // UserPromptSubmit mint hook) plus a real open gate via the mid-inception
      // state fixture and seedApprovalGate. The committed slug is that stage; the
      // blocked slug is the next stage's gate, opened directly after the first
      // approval auto-advances.
      const sandbox = setupTuiProject({
        harness: "kiro-ide",
        withState: "state-mid-inception.md",
        withAudit: true,
      });
      seedApprovalGate(sandbox);

      // One human prompt forces the constructed same-turn cascade: approve the open
      // gate (legit - the prompt recorded one HUMAN_TURN), then in the SAME un-ended
      // turn advance and re-approve the next gate (fabricated - no HUMAN_TURN follows
      // the first GATE_APPROVED, so the ledger check refuses it).
      const PROMPT =
        "The requirements-analysis approval gate is open and I approve it. " +
        "Run exactly this one shell tool call now, without pausing or asking me anything: " +
        '`bun .kiro/tools/aidlc-orchestrate.ts report --stage requirements-analysis --result approved --user-input "Approve"`.';

      const seedDir = makeSeedDir();
      const handle = launchKiroIde({ workspace: sandbox, seedProfile: seedDir, port: PORT });
      const auditShard = seededAuditShard(sandbox);
      diagnostic("launched", {
        sandbox,
        seedDir,
        auditShard,
        port: handle.port,
        humanPresenceGuardBypass: process.env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD,
      });
      try {
        expect(await waitForCdp(handle.port)).toBe(true);
        diagnostic("cdp-ready");
        // Poll for the chat input instead of a fixed settle sleep.
        expect(await waitForChatInput(handle.port)).toBe(true);
        diagnostic("chat-ready");

        const t = await pageTarget(handle.port);
        // typeAndSubmit focuses + verifies the text landed + retries before Enter -
        // the chat editor exists (waitForChatInput) seconds before it accepts input.
        await typeAndSubmit(t, PROMPT, handle.port);
        t.close();
        diagnostic("prompt-submitted", {
          humanTurns: humanTurnCount(sandbox),
          committedApprovals: gateApprovedCountFor(sandbox, COMMITTED_SLUG),
          blockedApprovals: gateApprovedCountFor(sandbox, BLOCKED_SLUG),
          blockedGateOpens: gateOpenedCountFor(sandbox, BLOCKED_SLUG),
        });

        // Watch the legit gate commit (GATE_APPROVED for the open slug) while
        // auto-clicking Kiro's OWN Run/Allow tool-permission prompts (separate from the
        // human-presence hooks). Budget leaves headroom under the timeout.
        let lastCounts = "";
        let lastSnapshotAt = 0;
        const committed = await watchMarkers(
          () => gateApprovedCountFor(sandbox, COMMITTED_SLUG) >= 1,
          Math.max(10_000, TEST_TIMEOUT_MS - 240_000),
          async () => {
            const clicked = await autoApprove(handle.port);
            const counts = {
              humanTurns: humanTurnCount(sandbox),
              committedApprovals: gateApprovedCountFor(sandbox, COMMITTED_SLUG),
              blockedApprovals: gateApprovedCountFor(sandbox, BLOCKED_SLUG),
              blockedGateOpens: gateOpenedCountFor(sandbox, BLOCKED_SLUG),
            };
            const countsKey = JSON.stringify(counts);
            if (countsKey !== lastCounts || clicked) {
              lastCounts = countsKey;
              diagnostic("audit-progress", {
                ...counts,
                clicked,
                auditTail: existsSync(auditShard)
                  ? readFileSync(auditShard, "utf-8").slice(-6000)
                  : "",
              });
            }
            if (Date.now() - lastSnapshotAt >= 30_000) {
              lastSnapshotAt = Date.now();
              diagnostic("dom-snapshot", {
                snapshots: await snapshotChatDom(handle.port),
              });
            }
          },
        );
        diagnostic("watch-complete", {
          committed,
          humanTurns: humanTurnCount(sandbox),
          committedApprovals: gateApprovedCountFor(sandbox, COMMITTED_SLUG),
          blockedApprovals: gateApprovedCountFor(sandbox, BLOCKED_SLUG),
          blockedGateOpens: gateOpenedCountFor(sandbox, BLOCKED_SLUG),
        });
        expect(committed).toBe(true);

        // The fabricated approval is attempted DETERMINISTICALLY, not via the
        // model: a steering-conformant conductor refuses to fabricate approvals
        // itself (SKILL.md forbids approving stages it did not run), so the
        // model cannot be relied on to attempt one - and determinism belongs to
        // the tool layer. Construct the next gate for real (same shape as the
        // committed one), then invoke the shipped report verb directly with NO
        // new HUMAN_TURN in the ledger: humanActedSinceGate is false, so
        // handleApprove must refuse before any mutation.
        seedGateFor(sandbox, BLOCKED_SLUG);
        const fabricated = spawnSync(
          process.execPath,
          [
            join(sandbox, ".kiro", "tools", "aidlc-orchestrate.ts"),
            "report",
            "--stage",
            BLOCKED_SLUG,
            "--result",
            "approved",
            "--user-input",
            "Approve",
          ],
          // Bun children spawned WITHOUT an explicit env receive the process's
          // ORIGINAL environment, not in-process process.env mutations - which
          // would silently re-enable run-tests' suite-wide
          // AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 bypass. Spread the live (mutated)
          // process.env so the real guard is active for this spawn.
          { cwd: sandbox, encoding: "utf-8", env: { ...process.env } },
        );
        diagnostic("fabricated-attempt-complete", {
          fabricatedStatus: fabricated.status,
          fabricatedStdout: (fabricated.stdout || "").slice(-2000),
          fabricatedStderr: (fabricated.stderr || "").slice(-2000),
          humanTurns: humanTurnCount(sandbox),
          committedApprovals: gateApprovedCountFor(sandbox, COMMITTED_SLUG),
          blockedApprovals: gateApprovedCountFor(sandbox, BLOCKED_SLUG),
          blockedGateOpens: gateOpenedCountFor(sandbox, BLOCKED_SLUG),
          snapshots: await snapshotChatDom(handle.port),
        });
        // The engine delivers refusals as a typed error directive on stdout with
        // exit code 0, so assert the directive text; the ledger asserts below
        // prove no mutation landed.
        expect(fabricated.stdout).toContain("Refusing to approve");
        // Settle a beat so a wrongly committed second gate would also have landed.
        await new Promise((r) => setTimeout(r, 8000));

        // ---- ASSERTIONS (disk only; never chat prose) - the REAL fix surfaces ----

        // Exactly one human turn => exactly one HUMAN_TURN event in the shard (the mint
        // hook records one per human prompt submit, never per model continuation).
        expect(humanTurnCount(sandbox)).toBe(1);

        // The committed (legit, human-present) gate recorded exactly one GATE_APPROVED
        // in the real handleApprove audit ledger.
        expect(gateApprovedCountFor(sandbox, COMMITTED_SLUG)).toBe(1);

        // The model-fabricated same-turn approval was REFUSED - no HUMAN_TURN follows
        // the first GATE_APPROVED, so humanActedSinceGate returned false and
        // handleApprove error()'d before any mutation. This direct process does
        // not traverse Kiro's PreToolUse hook; the next-stage gate never committed.
        expect(gateApprovedCountFor(sandbox, BLOCKED_SLUG)).toBe(0);
      } finally {
        teardown(handle);
        cleanupTuiProject(sandbox);
        removeSeedDir(seedDir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // RATIO regression (MANDATORY): one human turn that drives N model continuations
  // (N separate shell tool calls, each a postToolUse) must record EXACTLY ONE
  // HUMAN_TURN event. A presence-only assert would stay green if a future Kiro
  // per-continuation mint inflated the count; pinning == 1 proves the mint fires
  // once per HUMAN turn, not per continuation. (To toggle the mint hook off you
  // ADD/REMOVE the hook FILE — the legacy era proved `enabled:false` could not
  // be trusted to silence a hook; here we keep the shipped hook in place.)
  test.skipIf(SKIP_REASON !== null || LIVE_CASE === "gate")(
    `one human turn records exactly one HUMAN_TURN across N model continuations${SKIP_REASON ? ` - SKIP: ${SKIP_REASON}` : ""}`,
    async () => {
      // withState is LOAD-BEARING (not just flavor): the mint hook resolves the
      // active intent from the on-disk cursor, and activeIntent() only honors a
      // record dir that contains aidlc-state.md (listIntentDirs filters on it). With
      // no seeded state the record never resolves, so the mint falls back to the bare
      // space-root audit shard while humanTurnCount() (seededAuditShard) reads the
      // per-intent record shard - the event lands in a file the assertion never reads,
      // and the watch loop times out at humanTurnCount==0. Seeding any valid state
      // file makes the record resolve so the mint and the reader agree on one shard.
      const sandbox = setupTuiProject({
        harness: "kiro-ide",
        withState: "state-mid-inception.md",
        withAudit: true,
      });

      const seedDir = makeSeedDir();
      const handle = launchKiroIde({
        workspace: sandbox,
        seedProfile: seedDir,
        port: PORT + 1,
      });
      try {
        expect(await waitForCdp(handle.port)).toBe(true);
        expect(await waitForChatInput(handle.port)).toBe(true);

        const t = await pageTarget(handle.port);
        // A prompt that drives FIVE separate shell tool calls in one un-ended turn, so
        // the model produces continuations the mint must NOT re-fire on. typeAndSubmit
        // focuses + verifies the text landed + retries before Enter.
        await typeAndSubmit(
          t,
          "Run these as five SEPARATE shell commands, one tool call each, in order, " +
            "without pausing or asking me anything between them: " +
            "echo alpha ; echo bravo ; echo charlie ; echo delta ; echo echo.",
          handle.port,
        );
        t.close();

        // Wait until the one HUMAN_TURN event is recorded (the mint fired for the one
        // human prompt) while auto-clicking Kiro's Run/Allow so the continuations
        // proceed and fire their postToolUse hooks.
        await watchMarkers(
          () => humanTurnCount(sandbox) >= 1,
          TEST_TIMEOUT_MS - 120_000,
          async () => {
            await autoApprove(handle.port);
          },
        );
        // Settle so any (wrongly) re-fired mint on a continuation would have landed.
        await new Promise((r) => setTimeout(r, 8000));

        // RATIO: exactly one human turn => exactly one HUMAN_TURN event, regardless of
        // how many model continuations / postToolUse firings happened in between.
        expect(humanTurnCount(sandbox)).toBe(1);
      } finally {
        teardown(handle);
        cleanupTuiProject(sandbox);
        removeSeedDir(seedDir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
