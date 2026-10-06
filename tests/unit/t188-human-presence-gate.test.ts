// covers: function:ANSWER_SOURCE_ON_INSTRUCTION, cli:aidlc-state(approve,gate-start), cli:aidlc-orchestrate(report), cli:aidlc-log(answer), audit:SUMMARY_CONFIRMATION_RECORDED, function:handleApprove, function:handleGateStart, function:handleAnswer, function:pendingSummaryDecision, function:humanActedSinceGate, function:humanTurnState, function:humanActedSinceLastAnswer, function:hasOpenGate, function:isAutonomousMode, function:humanPresenceGuardDisabled, audit:GUARD_STOOD_ASIDE, function:humanTurnMintAllowed, function:unattendedHumanPresenceHint, function:checkSummaryConfirmationEvidence, function:readAuditShardEvents, function:SUMMARY_CONFIRMATION_HASH_SCOPE, function:summaryConfirmationGuardDisabled, file:hooks/aidlc-record-human-turn.ts
//
// t188 - human-presence approval gate (ledger-event design).
//
// Mechanism: cli. The subject is the deterministic human-presence guard the
// state tool runs on the approve path (and the log tool on the interview-answer
// path) AFTER the artifact guard and BEFORE any state mutation. It refuses to
// commit a gate unless a real human acted at THIS gate since the last gate
// resolution, where "a human acted" is proven by a HUMAN_TURN event in the audit
// shard (the state machine's own append-only ledger). The guard reads the
// per-clone audit shard the resolved pd points at, so this is a PROCESS boundary
// exercised by spawning the real dist tools (spawnSync(BUN, [STATE|LOG, ...])).
//
// The ledger contract (no marker file, no turn counter, no consumed flag):
//   - a real human prompt appends a HUMAN_TURN event (the per-harness mint hook).
//   - the gate allows iff a HUMAN_TURN appears AFTER the last gate resolution
//     (GATE_APPROVED / GATE_REJECTED / QUESTION_ANSWERED) IN LEDGER APPEND ORDER.
//   - cascade-safety + freshness both fall out of order: a second gate
//     auto-cascaded in the same human turn opens AFTER the GATE_APPROVED that just
//     committed (so no HUMAN_TURN follows it -> refused); a stale human turn
//     precedes the last resolution (-> refused).
//   - `aidlc-log answer` for a stage already at [?] is a successful no-op WHEN
//     a human acted and no unresolved DECISION_RECORDED follows the gate-open:
//     approval choices are report-owned and must not emit QUESTION_ANSWERED,
//     which would consume the HUMAN_TURN before the following approve. With NO
//     human turn the same call REFUSES (so a fabricated `answer && report
//     rejected` chain breaks at the answer). A pending non-gate decision makes
//     the answer record normally, regardless of its wording.
//   - fail-open when the ledger has NO events at all (presence not tracked yet).
//
// CRITICAL test-harness note: run-tests.ts sets AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1
// for the whole suite (so the ~81 approve/advance tests keep passing). This test
// re-enables enforcement by DELETING that var from the spawned tool's env -
// otherwise it would be testing the bypass, not the guard. It KEEPS
// AIDLC_SKIP_ARTIFACT_GUARD=1 set, because the artifact guard is a separate
// chokepoint these bare fixtures do not satisfy; this test isolates the presence
// guard.
//
// Source under test (dist/claude/.claude/tools/):
//   aidlc-state.ts handleApprove (presence check, then GATE_APPROVED is the next
//     gate's freshness boundary - no separate consume step),
//   aidlc-log.ts handleAnswer (the interview-path twin),
//   aidlc-audit.ts append (records the HUMAN_TURN event the mint hook emits).

import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import {
  AIDLC_SRC,
  REPO_ROOT,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  checkSummaryConfirmationEvidence,
  findStageBySlug,
  readAllAuditShards,
  readAuditShardEvents,
  writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const KIRO_IDE_STATE = join(REPO_ROOT, "dist", "kiro-ide", ".kiro", "tools", "aidlc-state.ts");
const KIRO_CLI_STATE = join(REPO_ROOT, "dist", "kiro", ".kiro", "tools", "aidlc-state.ts");
const ORCHESTRATE = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const MINT_HOOK = join(AIDLC_SRC, "tools", "aidlc.ts");
const MID_IDEATION = "state-mid-ideation.md"; // Current Stage: feasibility

// Drive a state subcommand with the PRESENCE guard ENABLED (clear the suite's
// presence-bypass var) but the ARTIFACT guard still bypassed (a separate
// chokepoint these bare fixtures don't satisfy). Returns exit code + output.
function guarded(
  proj: string,
  args: string[],
  unattended = false,
  state = STATE,
  host: NodeJS.ProcessEnv = {},
): { rc: number; out: string } {
  const env = { ...process.env };
  // The host the agent's shell is in is the case's own, never the runner's.
  delete env.VSCODE_IPC_HOOK;
  delete env.VSCODE_PID;
  Object.assign(env, host);
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  if (unattended) env.AIDLC_UNATTENDED = "1";
  else delete env.AIDLC_UNATTENDED;
  const r = spawnSync(BUN, [state, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Drive an aidlc-log subcommand with the same guard posture.
function guardedLog(
  proj: string,
  args: string[],
  unattended = false,
): { rc: number; out: string } {
  const env = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  if (unattended) env.AIDLC_UNATTENDED = "1";
  else delete env.AIDLC_UNATTENDED;
  const r = spawnSync(BUN, [LOG, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Drive the public report surface with the same guard posture. NOTE the
// contract difference from `guarded`: when aidlc-state.ts refuses the
// transition, orchestrate relays the refusal as a DIRECTIVE on stdout and exits
// 0 (a decision the person has not made is the agent's next step, a `print`;
// anything else an `error`). Only a malformed directive exits non-zero, so
// refusal assertions must read the directive, not the rc.
function guardedReport(proj: string, args: string[]): { rc: number; out: string } {
  const env = { ...process.env };
  env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const r = spawnSync(BUN, [ORCHESTRATE, "report", ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Record a HUMAN_TURN event via the real audit-append CLI (exactly what the
// per-harness mint hook does on a real human prompt). This appends to the
// active-intent shard the gate later reads, in real ledger order.
function recordHumanTurn(proj: string): void {
  appendAuditEntry("HUMAN_TURN", {}, proj);
}

// Leave a hook heartbeat where hook liveness reads it, as the post-shell hook
// does after every shell command in a workflow.
function writeHeartbeat(proj: string, timestampMs: number): void {
  const health = join(seededRecordDir(proj), ".aidlc-engine", "hooks-health");
  mkdirSync(health, { recursive: true });
  writeFileSync(
    join(health, "rebuild-stage-graph.last"),
    new Date(timestampMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    "utf-8",
  );
}

// Stamp the human-turn marker, as the prompt hook does on each prompt it handles.
function stampPrompt(proj: string, timestampMs: number): void {
  const engine = join(seededRecordDir(proj), ".aidlc-engine");
  mkdirSync(engine, { recursive: true });
  writeFileSync(
    join(engine, "human-turn"),
    `${new Date(timestampMs).toISOString().replace(/\.\d{3}Z$/, "Z")}\n`,
    "utf-8",
  );
}

function field(proj: string, name: string): string {
  return guarded(proj, ["get", name]).out.trim();
}

// Count audit blocks with `**Event**: <ev>` in the merged shard buffer.
function eventCount(proj: string, ev: string): number {
  const body = readAllAuditShards(proj);
  return body
    .split("\n")
    .filter((l) => l === `**Event**: ${ev}`).length;
}

function summaryEvidence(
  project: string,
  stage: NonNullable<ReturnType<typeof findStageBySlug>>,
) {
  const previous = process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
  try {
    return checkSummaryConfirmationEvidence(project, stage, {
      stateContent: readFileSync(seededStateFile(project), "utf-8"),
    });
  } finally {
    if (previous === undefined) {
      delete process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD;
    } else {
      process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD = previous;
    }
  }
}

// Append the autonomy field to the seeded state file (the mid-ideation fixture
// carries no Construction Autonomy Mode field, and setField is a no-op for an
// absent field, so write the field line directly - isAutonomousMode reads
// getField(content, "Construction Autonomy Mode")?.trim() === "autonomous").
function setAutonomous(proj: string): void {
  const sf = seededStateFile(proj);
  const content = readFileSync(sf, "utf-8");
  const next = content.includes("**Construction Autonomy Mode**:")
    ? content.replace(
        /- \*\*Construction Autonomy Mode\*\*:[^\n]*/,
        "- **Construction Autonomy Mode**: autonomous",
      )
    : `${content}\n- **Construction Autonomy Mode**: autonomous\n`;
  writeFileSync(sf, next, "utf-8");
}

function summaryQuestions(proj: string, answer = ""): string {
  const path = join(
    seededRecordDir(proj),
    "ideation",
    "feasibility",
    "feasibility-questions.md",
  );
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    [
      "# Feasibility Questions",
      "",
      "## Consolidated Summary Confirmation",
      "",
      "- Looks correct",
      "- Request changes",
      "",
      `[Answer]: ${answer}`,
      "",
    ].join("\n"),
  );
  return path;
}

let proj: string;

describe("t188: human-presence approval gate (ledger-event design)", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION); // Current Stage: feasibility
  });

  afterEach(() => cleanupTestProject(proj));

  // --- Scenario A: FABRICATION (no human turn) -------------------------------
  //
  // Gate open (slug awaiting-approval, STAGE_AWAITING_APPROVAL recorded), the
  // ledger HAS events (presence tracking active) but NO HUMAN_TURN at all - a
  // model under autopilot fabricating an approval. The gate must REFUSE and emit
  // no GATE_APPROVED.
  test("A: approve REFUSES when the ledger has events but no HUMAN_TURN", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]); // STAGE_AWAITING_APPROVAL recorded (ledger non-empty)
    const r = guarded(proj, ["approve", slug, "--user-input", "Approve"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Cannot approve");
    expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
    // State untouched: the stage is NOT marked completed.
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  // A refusal for a reply that was not recorded never asks the person to answer
  // again. Claude's tools (its shipped hookActivation) give the agent's own
  // step and the one line to show; the Kiro IDE tree's give the words to relay
  // with the step doctor names for the person's own tool: Kiro IDE's alone
  // inside Kiro IDE, Kiro CLI's and an ACP client's elsewhere, and nothing
  // about how AI-DLC works.
  test("A2: Claude's refusal gives its own step, the Kiro IDE tree's gives the person's own tool's step, and neither asks again", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    const claude = guarded(proj, ["approve", slug, "--user-input", "Approve"]);
    expect(claude.rc).not.toBe(0);
    expect(claude.out).toContain("do not ask them to answer again");
    expect(claude.out).toContain(
      "Choose Yes when Claude Code asks to change this project's settings, then answer the question below.",
    );
    expect(claude.out).not.toContain("reply again");
    expect(claude.out).not.toContain("Reload Window");
    const refusalIn = (host: NodeJS.ProcessEnv): string => {
      const r = guarded(proj, ["approve", slug, "--user-input", "Approve"], false, KIRO_IDE_STATE, host);
      expect(r.rc).not.toBe(0);
      const refusal = JSON.parse(r.out).error as string;
      expect(refusal).toContain(
        "If the person already replied, that reply was not recorded. Do not ask them to answer again.",
      );
      expect(refusal).not.toContain("hooks");
      expect(refusal).not.toContain("agent picker");
      expect(refusal).not.toContain("clientCapabilities");
      return refusal;
    };
    const ideStep =
      'Tell them exactly this, with nothing about why: "Your answer was not recorded, so you don\'t need to answer again. In Kiro IDE, trust this folder: choose Trust Folder & Continue when Kiro asks whether you trust it, or select Manage on the Restricted Mode banner, then Trust. Then run Developer: Reload Window from the Command Palette (Ctrl+Shift+P, or Cmd+Shift+P on macOS), and say carry on."';
    for (const host of [{ VSCODE_IPC_HOOK: "/tmp/vscode-ipc.sock" }, { VSCODE_PID: "4242" }]) {
      const inIde = refusalIn(host);
      expect(inIde).toContain(ideStep);
      expect(inIde).not.toContain("Kiro CLI");
      expect(inIde).not.toContain("ACP");
    }
    // Kiro CLI v3 and an ACP client on this tree set neither.
    const elsewhere = refusalIn({});
    expect(elsewhere).toContain(
      'Tell them exactly this, with nothing about why, then only the line below for the tool they are in: "Your answer was not recorded, so you don\'t need to answer again." In Kiro CLI, quit Kiro and start `kiro-cli` again in this folder. If you drive Kiro from an ACP client, the Kiro IDE guide names what that client must send.',
    );
    expect(elsewhere).not.toContain("Reload Window");
    expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  // The kiro tree's hooks run only with its aidlc agent on Kiro CLI's v2
  // engine. The agent tells the two causes apart by Kiro's own line under its
  // replies, and shows the one step for the person.
  test("A3: on Kiro CLI the refusal gives the agent and engine lines, and asks for nothing again", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    const r = guarded(proj, ["approve", slug, "--user-input", "Approve"], false, KIRO_CLI_STATE);
    expect(r.rc).not.toBe(0);
    const refusal = JSON.parse(r.out).error as string;
    expect(refusal).toContain("no new human reply");
    expect(refusal).toContain("do not ask them to answer again");
    expect(refusal).toContain('agent "aidlc" needs upgrading for this agent engine, using "default"');
    expect(refusal).toContain('"Type /agent and pick aidlc, then carry on."');
    expect(refusal).toContain(
      '"Quit Kiro and start it again in this folder with: kiro-cli chat --agent-engine v2 --agent aidlc"',
    );
    expect(refusal).not.toContain("reply again");
    expect(refusal).not.toContain("ACP");
    expect(refusal).not.toContain("Reload Window");
    expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  // With fresh hook activity the hooks run, so the refusal never sends the
  // person after a setting that is already right: an earlier turn was spent,
  // the prompt hook stamped its marker, and another hook left a heartbeat
  // seconds ago. It says what happened to a reply they sent and where to look,
  // and still never asks them to answer again.
  test("A4: with fresh hook activity the refusal gives no hooks-off step", () => {
    const first = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${first}=in-progress`]);
    recordHumanTurn(proj);
    guarded(proj, ["gate-start", first]);
    expect(guarded(proj, ["approve", first, "--user-input", "Approve"]).rc).toBe(0);
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    stampPrompt(proj, Date.now());
    writeHeartbeat(proj, Date.now());
    for (const [state, steps] of [
      [KIRO_CLI_STATE, "If the person already replied, that reply was not recorded for this question."],
      [KIRO_IDE_STATE, "If the person already replied, that reply was not recorded. Do not ask them to answer again."],
    ] as const) {
      const r = guarded(proj, ["approve", slug, "--user-input", "Approve"], false, state);
      expect(r.rc).not.toBe(0);
      const refusal = JSON.parse(r.out).error as string;
      expect(refusal).toContain(steps);
      expect(refusal).not.toContain("Type /agent and pick aidlc");
      expect(refusal).not.toContain("answer again;");
    }
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  // --- Scenario B: LEGIT (human turn after gate-open) ------------------------
  //
  // The realistic flow: the human types (HUMAN_TURN), then the agent opens the
  // gate and approves it. A HUMAN_TURN exists after the last resolution (none
  // yet) -> approve COMMITS, exactly one GATE_APPROVED.
  test("B: approve COMMITS when a HUMAN_TURN was recorded this turn", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    recordHumanTurn(proj); // the human typed a prompt
    guarded(proj, ["gate-start", slug]); // agent opens the gate (same turn)
    const r = guarded(proj, ["approve", slug, "--user-input", "Approve"]);
    expect(r.rc, r.out).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    // Auto-advanced off feasibility.
    expect(field(proj, "Current Stage")).not.toBe(slug);
  });

  // The picker returns the "(Recommended)" decorator added to the choice label.
  // Matching may remove it, but the approval receipt must retain the human's reply.
  test("B2: approve COMMITS when the reply carries the (Recommended) decorator", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    recordHumanTurn(proj);
    guarded(proj, ["gate-start", slug]);
    const r = guarded(proj, [
      "approve",
      slug,
      "--user-input",
      "Approve (Recommended)",
    ]);
    expect(r.rc, r.out).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(
      readAuditShardEvents(proj).find((row) => row.event === "GATE_APPROVED")?.block,
    ).toContain("**User Input**: Approve\n");
    expect(field(proj, "Current Stage")).not.toBe(slug);
  });

  // The agent reports the approval it read from the person's reply; the
  // receipt names Accept as-is only once the gate offers it.
  test.each([2, 3])(
    "decorated Accept as-is respects the revision limit at count %i",
    (revisionCount) => {
      const slug = field(proj, "Current Stage");
      expect(guarded(proj, ["set", `Revision Count=${revisionCount}`]).rc).toBe(0);
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);
      recordHumanTurn(proj);
      const report = guardedReport(proj, ["--stage", slug, "--result", "approved", "--user-input", "Accept as-is (Recommended)"]);
      expect(report.rc, report.out).toBe(0);
      expect(report.out).toContain('"kind":"done"');
      expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
      expect(readAuditShardEvents(proj).find((row) => row.event === "GATE_APPROVED")?.block)
        .toContain(revisionCount >= 3 ? "**User Input**: Accept as-is\n" : "**User Input**: Approve\n");
      expect(field(proj, "Current Stage")).not.toBe(slug);
    },
  );

  test.each(["(Recommended)", "Approve (Recommended) extra"])(
    "the agent's reported approval records as Approve, whatever it passes: %s",
    (reply) => {
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);
      recordHumanTurn(proj);
      const direct = guarded(proj, ["approve", slug, "--user-input", reply]);
      expect(direct.rc, direct.out).toBe(0);
      expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
      expect(readAuditShardEvents(proj).find((row) => row.event === "GATE_APPROVED")?.block)
        .toContain("**User Input**: Approve\n");
    },
  );

  // A conductor that reports a gated stage complete before asking its approval
  // question gets the question opened for the person, not an error; nothing is
  // approved until they answer.
  test.each(["completed", "complete", "done"])(
    "report --result %s with no reply on an in-progress gated stage opens its approval question",
    (result) => {
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      const report = guardedReport(proj, ["--stage", slug, "--result", result]);
      expect(report.rc, report.out).toBe(0);
      const directive = JSON.parse(report.out);
      expect(directive.kind, report.out).toBe("print");
      expect(directive.message).toContain(`"${slug}" has not asked for approval yet`);
      expect(directive.message).not.toContain("Recorded");
      expect(directive.message).toContain("nothing is approved until they answer");
      expect(eventCount(proj, "STAGE_AWAITING_APPROVAL")).toBe(1);
      expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
      expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(`- [?] ${slug}`);
      expect(field(proj, "Current Stage")).toBe(slug);
    },
  );

  // A stop is the person's to make. On a host whose hooks can miss a reply,
  // a park under autonomous Construction is theirs even with no reply on
  // record; on other hosts, and in an unattended run, the run keeps moving.
  test("a park under autonomous Construction with no reply on record parks on a missed-reply host only", () => {
    const sf = seededStateFile(proj);
    writeFileSync(sf, readFileSync(sf, "utf-8").replace(
      "## Runtime State", "## Runtime State\n- **Construction Autonomy Mode**: autonomous",
    ), "utf-8");
    appendAuditEntry("QUESTION_ANSWERED", { Stage: field(proj, "Current Stage"), Details: "an earlier answer" }, proj);
    const claude = guarded(proj, ["park"]);
    expect(claude.rc).not.toBe(0);
    expect(claude.out).toContain("no reply from the person is on record");
    expect(claude.out).not.toContain("unattended autonomous run");
    expect(guarded(proj, ["park"], true, KIRO_CLI_STATE).rc).not.toBe(0);
    expect(readFileSync(sf, "utf-8")).not.toContain("- **Parked**:");
    const kiro = guarded(proj, ["park"], false, KIRO_CLI_STATE);
    expect(kiro.rc, kiro.out).toBe(0);
    expect(kiro.out).toContain("this host can miss one");
    expect(readFileSync(sf, "utf-8")).toContain("- **Parked By**: person");
  });

  // An unattended run never parks itself, whatever the ledger holds, and an
  // empty ledger is no reply from the person.
  test("an autonomous park needs a recorded reply in an attended session", () => {
    const sf = seededStateFile(proj);
    writeFileSync(sf, readFileSync(sf, "utf-8").replace(
      "## Runtime State", "## Runtime State\n- **Construction Autonomy Mode**: autonomous",
    ), "utf-8");
    // Empty ledger: no reply on record, so the run keeps moving.
    const empty = guarded(proj, ["park"]);
    expect(empty.rc, empty.out).not.toBe(0);
    expect(empty.out).toContain("no reply from the person is on record");
    // It names the step that lets a stop through when the person's word is
    // not on record, and that step is accepted.
    expect(empty.out).toContain("set-autonomy --mode gated");
    // A reply on record, but the driver declared the run unattended.
    recordHumanTurn(proj);
    for (const tool of [STATE, KIRO_CLI_STATE]) {
      expect(guarded(proj, ["park"], true, tool).rc).not.toBe(0);
    }
    expect(readFileSync(sf, "utf-8")).not.toContain("- **Parked**:");
    // The same reply in an attended session is the person's stop.
    const attended = guarded(proj, ["park"]);
    expect(attended.rc, attended.out).toBe(0);
    expect(readFileSync(sf, "utf-8")).toContain("- **Parked By**: person");
  });

  test("the step a refused autonomous park names is accepted, and the park then goes through", () => {
    const sf = seededStateFile(proj);
    writeFileSync(sf, readFileSync(sf, "utf-8").replace(
      "## Runtime State", "## Runtime State\n- **Construction Autonomy Mode**: autonomous",
    ), "utf-8");
    expect(guarded(proj, ["park"]).rc).not.toBe(0);
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    delete env.AIDLC_UNATTENDED;
    const gated = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-bolt.ts"), "set-autonomy", "--mode", "gated", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
      encoding: "utf-8",
      env,
    });
    expect(gated.status, `${gated.stdout}${gated.stderr}`).toBe(0);
    const parked = guarded(proj, ["park"]);
    expect(parked.rc, parked.out).toBe(0);
    expect(readFileSync(sf, "utf-8")).toContain("- **Parked**:");
  });

  // One owner for every caller: with AIDLC_UNATTENDED=1 an autonomous run
  // never parks itself, whatever the caller passes, so nobody is left to
  // resume it.
  test("an unattended autonomous run never parks through park, report --park, or the Plan Approval answer's park", () => {
    const sf = seededStateFile(proj);
    writeFileSync(sf, readFileSync(sf, "utf-8").replace(
      "## Runtime State", "## Runtime State\n- **Construction Autonomy Mode**: autonomous",
    ), "utf-8");
    recordHumanTurn(proj);
    // 1. `state park`.
    const park = guarded(proj, ["park"], true);
    expect(park.rc).not.toBe(0);
    expect(park.out).toContain("AIDLC_UNATTENDED=1 is set");
    // 2. `orchestrate report --park` at a gate the person answered.
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    recordHumanTurn(proj);
    const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_UNATTENDED: "1" };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const report = spawnSync(BUN, [
      ORCHESTRATE, "report", "--stage", slug, "--result", "approved", "--user-input", "Approve", "--park",
      "--project-dir", proj,
    ], { env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(`${report.stdout}`).not.toContain('"kind":"parked"');
    expect(readFileSync(sf, "utf-8")).not.toContain("- **Parked**:");
    // 3. The Plan Approval answer's park passes attended: true; the owner still refuses.
    const inProcess = spawnSync(BUN, ["-e", `
      const { parkWorkflow } = await import(${JSON.stringify(STATE)});
      try { parkWorkflow(${JSON.stringify(proj)}, { attended: true }); console.log("parked"); }
      catch (e) { console.log("refused: " + (e instanceof Error ? e.message : String(e))); }
    `], { env, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS) });
    expect(`${inProcess.stdout}${inProcess.stderr}`).not.toContain("parked\n");
    expect(readFileSync(sf, "utf-8")).not.toContain("- **Parked**:");
  });

  test("an approval that names no choice records nothing, even after the person replied", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    recordHumanTurn(proj);
    const direct = guarded(proj, ["approve", slug]);
    expect(direct.rc).not.toBe(0);
    expect(direct.out).toContain("no choice was passed");
    expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
  });

  // --- Scenario H: persisted per-work switches cannot lower the key holder ---
  test("H: a persisted human-presence Guards Off entry is ignored", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    const sf = seededStateFile(proj);
    writeFileSync(
      sf,
      `${readFileSync(sf, "utf-8").trimEnd()}\n- **Guards Off**: human-presence (set by you)\n`,
      "utf-8",
    );
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]); // ledger non-empty, still no HUMAN_TURN
    const rowsBefore = eventCount(proj, "GUARD_STOOD_ASIDE");
    const before = readFileSync(sf, "utf-8");
    const r = guarded(proj, ["approve", slug, "--user-input", "Approve"]);
    expect(r.rc, r.out).not.toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
    expect(r.out).toContain("If the person already replied, that reply was not recorded");
    expect(r.out).toContain("do not ask them to answer again");
    expect(r.out).not.toContain("guard.human-presence");
    expect(r.out).not.toContain("Continuing past the human-presence check");
    expect(eventCount(proj, "GUARD_STOOD_ASIDE")).toBe(rowsBefore);
    expect(readFileSync(sf, "utf-8")).toBe(before);
  });

  test("H: the human-presence config switch refuses without changing state or fences", () => {
    const beforeState = readFileSync(seededStateFile(proj), "utf-8");
    const r = spawnSync(BUN, [
      join(AIDLC_SRC, "tools", "aidlc-utility.ts"),
      "config-change", "--guard.human-presence", "off", "--project-dir", proj,
    ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: process.env });
    expect(r.status, r.stderr).toBe(1);
    expect(JSON.parse(r.stderr)).toEqual({
      error: "Human presence cannot be switched off: it is how AIDLC knows an approval or an answer came from a real person, so reply in the chat yourself. For a supervised session where nobody can reply, launch the CLI with AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 set.",
    });
    expect(readFileSync(seededStateFile(proj), "utf-8")).toBe(beforeState);
    expect(eventCount(proj, "GUARD_DISABLED")).toBe(0);
    expect(eventCount(proj, "GUARD_RESTORED")).toBe(0);
    expect(eventCount(proj, "GUARD_STOOD_ASIDE")).toBe(0);
  });

  // --- Scenario I: the machine-wide variable is the SILENT layer ------------
  //
  // AIDLC_SKIP_HUMAN_PRESENCE_GUARD is set once by whoever runs the machine
  // (this suite sets it globally); no person chose it at this gate, so a row per
  // invocation would record nothing anyone decided. It commits, and says nothing.
  test("I: the environment variable commits without a stand-aside line or row", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    guarded(proj, ["gate-start", slug]);
    const env = { ...process.env };
    env.AIDLC_SKIP_ARTIFACT_GUARD = "1";
    env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
    env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD = "1";
    delete env.AIDLC_UNATTENDED;
    const r = spawnSync(
      BUN,
      [STATE, "approve", slug, "--user-input", "Approve", "--project-dir", proj],
      { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(r.status, out).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(out).not.toContain("Continuing past the human-presence check");
    expect(eventCount(proj, "GUARD_STOOD_ASIDE")).toBe(0);
  });

  // --- Scenario C: CASCADE (load-bearing) ------------------------------------
  //
  // One HUMAN_TURN, two sequential gates in the SAME human turn. The first
  // approve commits (and emits GATE_APPROVED, the freshness boundary). When the
  // reentrant advance opens a SECOND gate this turn and the model tries to
  // approve it with NO new HUMAN_TURN, the gate REFUSES - because the last
  // HUMAN_TURN now precedes the first gate's GATE_APPROVED. Proves cascade-safety
  // falls out of ledger order with no consumed flag.
  test("C: a single HUMAN_TURN approves ONE gate; a second gate this turn REFUSES", () => {
    const slug1 = field(proj, "Current Stage"); // feasibility
    guarded(proj, ["checkbox", `${slug1}=in-progress`]);
    recordHumanTurn(proj);
    guarded(proj, ["gate-start", slug1]);

    // First gate this turn: commits.
    const r1 = guarded(proj, ["approve", slug1, "--user-input", "Approve"]);
    expect(r1.rc).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);

    // Second gate, SAME turn (no new HUMAN_TURN): the auto-advanced stage is now
    // Current Stage. Open its gate and try to approve - the last HUMAN_TURN is
    // now before the first GATE_APPROVED, so this refuses.
    const slug2 = field(proj, "Current Stage");
    expect(slug2).not.toBe(slug1);
    guarded(proj, ["checkbox", `${slug2}=in-progress`]);
    guarded(proj, ["gate-start", slug2]);
    const r2 = guarded(proj, ["approve", slug2, "--user-input", "Approve"]);
    expect(r2.rc).not.toBe(0);
    expect(r2.out).toContain("Cannot approve");
    // Still exactly ONE commit across the whole turn.
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(field(proj, "Current Stage")).toBe(slug2);
  });

  // --- Scenario C2: a NEW human turn authorizes the second gate --------------
  test("C2: a fresh HUMAN_TURN after the first commit approves the second gate", () => {
    const slug1 = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug1}=in-progress`]);
    recordHumanTurn(proj);
    guarded(proj, ["gate-start", slug1]);
    expect(guarded(proj, ["approve", slug1, "--user-input", "Approve"]).rc).toBe(0);

    const slug2 = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug2}=in-progress`]);
    guarded(proj, ["gate-start", slug2]);
    recordHumanTurn(proj); // the human acts again
    const r2 = guarded(proj, ["approve", slug2, "--user-input", "Approve"]);
    expect(r2.rc).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(2);
  });

  // --- Scenario D: AUTONOMY carve-out is Construction-only -------------------
  test("D: a Construction autonomy field does NOT waive an Ideation gate", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    setAutonomous(proj);
    guarded(proj, ["gate-start", slug]); // ledger non-empty, but no HUMAN_TURN
    const r = guarded(proj, ["approve", slug, "--user-input", "Approve"]);
    expect(r.rc).not.toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  test("D2: an actual autonomous Construction stage may approve without a human turn", () => {
    cleanupTestProject(proj);
    proj = createTestProject();
    seedStateFile(proj, "state-construction-with-worktree.md");
    const statePath = seededStateFile(proj);
    const state = readFileSync(statePath, "utf-8")
      .replace("- [-] code-generation — EXECUTE", "- [-] build-and-test — EXECUTE")
      .replace("- **Current Stage**: code-generation", "- **Current Stage**: build-and-test")
      .replace("- **Next Stage**: build-and-test", "- **Next Stage**: ci-pipeline");
    writeFileSync(statePath, state, "utf-8");
    setAutonomous(proj);

    guarded(proj, ["gate-start", "build-and-test"]);
    const r = guarded(proj, ["approve", "build-and-test", "--user-input", "Approve"]);
    expect(r.rc, r.out).toBe(0);
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
  });

  // --- Scenario D2: unattended driving must not mint presence ----------------
  //
  // The mint hook has no evidence about WHO submitted a prompt: UserPromptSubmit
  // carries no such signal and the hook reads no stdin. That is sound while every
  // prompt comes from a person, but an unattended driver (an overnight runner
  // resuming on a schedule, CI, cron) submits prompts too — so before
  // AIDLC_UNATTENDED existed it minted a fresh, spendable HUMAN_TURN every cycle
  // and "walking away" stopped meaning "no new human turn". Measured on a live
  // detached run: 10 runner-submitted prompts, zero humans, humanActedSinceGate()
  // true.
  //
  // Spawned as a PROCESS (not the exported run()) because the env read is the
  // contract under test, and the flag is set by a parent for the whole child.
  describe("unattended prompt submit (AIDLC_UNATTENDED)", () => {
    // Find the human-turn hook's heartbeat anywhere under the project, so the
    // assertion does not couple to the exact record the cursor resolves to.
    function recordHumanTurnHeartbeatExists(p: string): boolean {
      const stack = [p];
      while (stack.length > 0) {
        const dir = stack.pop() as string;
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const full = join(dir, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.name === "record-human-turn.last" && existsSync(full)) return true;
        }
      }
      return false;
    }

    function fireMintHook(p: string, unattended: boolean): number {
      writeSessionPidEntry(p, process.pid, "01995000-0188-7000-8000-000000000001");
      const env = { ...process.env };
      // The hook derives the project from its OWN path (it ships inside the
      // project), so point the dist copy at the fixture explicitly — the same
      // override a dispatcher uses.
      env.AIDLC_PROJECT_DIR = p;
      if (unattended) env.AIDLC_UNATTENDED = "1";
      else delete env.AIDLC_UNATTENDED;
      const r = spawnSync(BUN, [MINT_HOOK, "engine", "hook", "record-human-turn"], {
        timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
        encoding: "utf-8",
        env,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "01995000-0188-7000-8000-000000000001",
        }),
      });
      return r.status ?? -1;
    }

    test("an unattended prompt mints NO HUMAN_TURN; an attended one still does", () => {
      const before = eventCount(proj, "HUMAN_TURN");

      // Unattended: exits clean (a mint decision must never fail a turn) and
      // leaves the ledger's presence count untouched.
      expect(fireMintHook(proj, true)).toBe(0);
      expect(eventCount(proj, "HUMAN_TURN")).toBe(before);
      // ...but the hook still leaves its heartbeat: a hook that ran and
      // withheld its mint is not one that never ran.
      expect(recordHumanTurnHeartbeatExists(proj)).toBe(true);

      // The flag is the ONLY difference — the same hook, same project, still
      // mints for a person. This is what keeps the test from passing for the
      // wrong reason (a hook that never mints at all).
      expect(fireMintHook(proj, false)).toBe(0);
      expect(eventCount(proj, "HUMAN_TURN")).toBe(before + 1);
    });

    test("a gate REFUSES on a turn minted only by an unattended prompt", () => {
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      // The unattended driver submits its prompt...
      expect(fireMintHook(proj, true)).toBe(0);
      guarded(proj, ["gate-start", slug]);
      // ...and the gate still has no human to point at.
      const r = guarded(
        proj,
        ["approve", slug, "--user-input", "Approve"],
        true,
      );
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("Cannot approve");
      expect(r.out).toContain(
        "AIDLC_UNATTENDED=1 is set, so automated prompt submissions cannot count as a human reply",
      );
      expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
      expect(field(proj, "Current Stage")).toBe(slug);
    });
  });

  // --- Scenario E: STALE human turn ------------------------------------------
  //
  // A HUMAN_TURN exists but was already spent on a prior gate (its GATE_APPROVED
  // is AFTER the human turn), then a new gate opens with no fresh turn -> REFUSE.
  test("E: a HUMAN_TURN already spent on a prior gate is STALE -> REFUSE", () => {
    const slug1 = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug1}=in-progress`]);
    recordHumanTurn(proj);
    guarded(proj, ["gate-start", slug1]);
    expect(guarded(proj, ["approve", slug1, "--user-input", "Approve"]).rc).toBe(0); // spends the turn

    // New gate, NO fresh HUMAN_TURN - the prior GATE_APPROVED is after the only turn.
    const slug2 = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug2}=in-progress`]);
    guarded(proj, ["gate-start", slug2]);
    const r = guarded(proj, ["approve", slug2, "--user-input", "Approve"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Cannot approve");
    expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    expect(field(proj, "Current Stage")).toBe(slug2);
  });

  // --- Scenario F: fail-open when the ledger has no events -------------------
  //
  // humanActedSinceGate fails OPEN on an empty ledger (a harness/clone whose shard
  // has no events yet) so the gate never bricks before any event is recorded.
  // Asserted directly on the helper: the approve PATH can't reach this state (it
  // requires a gate-start, which itself writes STAGE_AWAITING_APPROVAL), so the
  // empty-ledger fallback is a guarantee of the predicate, exercised here in-process.
  test("F: humanActedSinceGate fails OPEN on an empty ledger", async () => {
    const { humanActedSinceGate } = await import(
      "../../dist/claude/.claude/tools/aidlc-lib.ts"
    );
    // proj here has a seeded state file but no audit shard (no event emitted yet).
    expect(humanActedSinceGate(proj)).toBe(true);
  });

  // --- Scenario G: multi-shard chronological ordering -------------------------
  //
  // readAllAuditShards concatenates per-clone shards in FILENAME order, which is
  // NOT time order (a second shard appears after a re-clone or on another
  // machine). The predicate must order by Timestamp, not buffer position: an OLD
  // resolution living in a lexically-LATER shard must not outrank a fresh
  // HUMAN_TURN in the current shard.
  test("G: an old resolution in a lexically-later shard does not mask a fresh HUMAN_TURN", async () => {
    const { humanActedSinceGate, auditShardDir } = await import(
      "../../dist/claude/.claude/tools/aidlc-lib.ts"
    );
    // Fresh HUMAN_TURN lands in this clone's shard via the real appender.
    recordHumanTurn(proj);
    // Simulate a prior clone's committed shard whose filename sorts AFTER the
    // current shard (zzz- prefix) but whose events are OLDER.
    const dir = auditShardDir(proj);
    if (dir === null) throw new Error("no audit shard dir resolved");
    writeFileSync(
      join(dir, "zzz-oldclone.md"),
      "# AI-DLC Audit Log\n\n## Gate Approved\n**Timestamp**: 2020-01-01T00:00:00Z\n**Event**: GATE_APPROVED\n**Stage**: feasibility\n\n---\n",
      "utf-8",
    );
    expect(humanActedSinceGate(proj)).toBe(true);
  });

  // --- hasOpenGate (the preToolUse floors' gate-open predicate) ---------------
  //
  // The per-harness preToolUse floors must refuse ONLY while a stage actually
  // sits at [?]: after a legitimate approval the last resolution follows the
  // turn's HUMAN_TURN, and without this predicate the floor would block the
  // mandated same-turn continuation into the next stage.
  describe("hasOpenGate (state-file [?] predicate for the preToolUse floors)", () => {
    test("false with no state / no [?]; true once a stage awaits approval", async () => {
      const { hasOpenGate } = await import(
        "../../dist/claude/.claude/tools/aidlc-lib.ts"
      );
      expect(hasOpenGate(null)).toBe(false);
      const before = readFileSync(seededStateFile(proj), "utf-8");
      expect(hasOpenGate(before)).toBe(false); // fixture has no [?] stage
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);
      const open = readFileSync(seededStateFile(proj), "utf-8");
      expect(hasOpenGate(open)).toBe(true);
      // Approving closes it again: the floor stops firing post-approval.
      recordHumanTurn(proj);
      expect(guarded(proj, ["approve", slug, "--user-input", "Approve"]).rc).toBe(0);
      const after = readFileSync(seededStateFile(proj), "utf-8");
      expect(hasOpenGate(after)).toBe(false);
    });
  });

  // --- handleAnswer twin (interview path) ------------------------------------
  describe("handleAnswer twin (aidlc-log answer)", () => {
    test("summary confirmation requires a matching prompt and a later human turn", () => {
      const slug = field(proj, "Current Stage");
      const questions = summaryQuestions(proj);
      expect(
        guardedLog(proj, [
          "decision",
          "--stage",
          slug,
          "--checkpoint",
          "summary-confirmation",
          "--questions-file",
          questions,
          "--decision",
          "Does this all look correct?",
          "--options",
          "Looks correct,Request changes",
        ]).rc,
      ).toBe(0);

      summaryQuestions(proj, "Looks correct");
      const fabricated = guardedLog(
        proj,
        [
          "answer",
          "--stage",
          slug,
          "--checkpoint",
          "summary-confirmation",
          "--questions-file",
          questions,
          "--details",
          "Looks correct",
        ],
        true,
      );
      expect(fabricated.rc).not.toBe(0);
      expect(fabricated.out).toContain("no human reply has arrived");
      expect(fabricated.out).toContain("Unset AIDLC_UNATTENDED");

      recordHumanTurn(proj);
      const confirmed = guardedLog(proj, [
        "answer",
        "--stage",
        slug,
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--details",
        "Looks correct",
      ]);
      expect(confirmed.rc).toBe(0);
      expect(confirmed.out).toContain(
        '"emitted":"SUMMARY_CONFIRMATION_RECORDED"',
      );
      expect(confirmed.out).toContain('"checkpoint":"summary-confirmation"');
      expect(eventCount(proj, "SUMMARY_CONFIRMATION_RECORDED")).toBe(1);
      const audit = readAllAuditShards(proj);
      expect(audit).toContain(
        "**Checkpoint**: Consolidated Summary Confirmation",
      );
      expect(audit).toContain("**Questions SHA-256**:");
      expect(audit).toContain("**Hash Scope**: confirmed-content-v2");
    });

    test("summary confirmation refuses a same-second cross-shard human turn", () => {
      const slug = field(proj, "Current Stage");
      const questions = summaryQuestions(proj, "Looks correct");
      const questionsFile = relative(proj, questions).replaceAll("\\", "/");
      const dir = dirname(seededAuditShard(proj));
      mkdirSync(dir, { recursive: true });
      const timestamp = "2026-08-19T12:00:00Z";
      writeFileSync(
        join(dir, "aaa-prompt.md"),
        [
          "## Decision Recorded",
          `**Timestamp**: ${timestamp}`,
          "**Event**: DECISION_RECORDED",
          `**Stage**: ${slug}`,
          "**Checkpoint**: Consolidated Summary Confirmation",
          `**Questions File**: ${questionsFile}`,
          "",
          "---",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "zzz-human.md"),
        [
          "## Human Turn",
          `**Timestamp**: ${timestamp}`,
          "**Event**: HUMAN_TURN",
          "",
          "---",
          "",
        ].join("\n"),
      );

      const result = guardedLog(proj, [
        "answer",
        "--stage",
        slug,
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--details",
        "Looks correct",
      ]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("human response after this prompt cannot be proven");
      expect(result.out).toContain("Present a fresh summary prompt");
      expect(eventCount(proj, "SUMMARY_CONFIRMATION_RECORDED")).toBe(0);
    });

    test("summary confirmation refuses a file whose stored answer differs", () => {
      const slug = field(proj, "Current Stage");
      const questions = summaryQuestions(proj);
      expect(
        guardedLog(proj, [
          "decision",
          "--stage",
          slug,
          "--checkpoint",
          "summary-confirmation",
          "--questions-file",
          questions,
          "--decision",
          "Does this all look correct?",
        ]).rc,
      ).toBe(0);
      recordHumanTurn(proj);
      summaryQuestions(proj, "Request changes");
      const result = guardedLog(proj, [
        "answer",
        "--stage",
        slug,
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--details",
        "Looks correct",
      ]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("must contain exactly one");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);
      expect(eventCount(proj, "SUMMARY_CONFIRMATION_RECORDED")).toBe(0);
    });

    test("summary confirmation needs a fresh turn after another answer", () => {
      const slug = field(proj, "Current Stage");
      const questions = summaryQuestions(proj);
      expect(
        guardedLog(proj, [
          "decision",
          "--stage",
          slug,
          "--checkpoint",
          "summary-confirmation",
          "--questions-file",
          questions,
          "--decision",
          "Does this all look correct?",
        ]).rc,
      ).toBe(0);
      recordHumanTurn(proj);
      expect(
        guardedLog(proj, [
          "answer",
          "--stage",
          slug,
          "--details",
          "A follow-up answer",
        ]).rc,
      ).toBe(0);
      summaryQuestions(proj, "Looks correct");

      const result = guardedLog(proj, [
        "answer",
        "--stage",
        slug,
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        questions,
        "--details",
        "Looks correct",
      ]);
      expect(result.rc).not.toBe(0);
      expect(result.out).toContain("that turn was already used by another decision");
      expect(eventCount(proj, "SUMMARY_CONFIRMATION_RECORDED")).toBe(0);
    });

    test("per-unit evidence requires a unit-scoped receipt", () => {
      const stage = findStageBySlug("functional-design");
      expect(stage).toBeDefined();
      const questions = join(
        seededRecordDir(proj),
        "construction",
        "api",
        "functional-design",
        "functional-design-questions.md",
      );
      mkdirSync(join(questions, ".."), { recursive: true });
      writeFileSync(
        questions,
        "# Questions\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: \n",
      );
      expect(
        guardedLog(proj, [
          "decision",
          "--stage",
          "functional-design",
          "--checkpoint",
          "summary-confirmation",
          "--questions-file",
          questions,
          "--decision",
          "Does this all look correct?",
        ]).rc,
      ).toBe(0);
      recordHumanTurn(proj);
      writeFileSync(
        questions,
        "# Questions\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: Looks correct\n",
      );
      expect(
        guardedLog(proj, [
          "answer",
          "--stage",
          "functional-design",
          "--checkpoint",
          "summary-confirmation",
          "--questions-file",
          questions,
          "--details",
          "Looks correct",
        ]).rc,
      ).toBe(0);

      const wrongScope = summaryEvidence(proj, stage!);
      expect(wrongScope.ok).toBe(false);
      if (!wrongScope.ok) expect(wrongScope.message).toContain('unit "api"');

      writeFileSync(
        questions,
        "# Questions\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: \n",
      );
      expect(
        guardedLog(proj, [
          "decision",
          "--stage",
          "functional-design",
          "--unit",
          "api",
          "--checkpoint",
          "summary-confirmation",
          "--questions-file",
          questions,
          "--decision",
          "Does this all look correct?",
        ]).rc,
      ).toBe(0);
      recordHumanTurn(proj);
      writeFileSync(
        questions,
        "# Questions\n\n## Consolidated Summary Confirmation\n\n- Looks correct\n- Request changes\n\n[Answer]: Looks correct\n",
      );
      expect(
        guardedLog(proj, [
          "answer",
          "--stage",
          "functional-design",
          "--unit",
          "api",
          "--checkpoint",
          "summary-confirmation",
          "--questions-file",
          questions,
          "--details",
          "Looks correct",
        ]).rc,
      ).toBe(0);
      expect(
        summaryEvidence(proj, stage!),
      ).toEqual({ ok: true, required: true });
    });

    test("REFUSES to record an answer when the ledger has events but no HUMAN_TURN", () => {
      const slug = field(proj, "Current Stage");
      // A decision row activates presence tracking without opening an approval
      // gate, keeping this an ordinary interview-answer scenario.
      expect(
        guardedLog(proj, [
          "decision",
          "--stage",
          slug,
          "--decision",
          "Choose",
          "--options",
          "A,B",
        ]).rc,
      ).toBe(0);
      const r = guardedLog(
        proj,
        ["answer", "--stage", slug, "--details", "my answer"],
        true,
      );
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("Cannot record this answer");
      expect(r.out).toContain("Unset AIDLC_UNATTENDED");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);
    });

    // From a live Kiro IDE run: the person answered five practice questions in
    // one reply, the first answer recorded, and the rest were refused. One reply
    // answers every question open when it arrived, each as its own answer; a
    // question asked after it waits for the next reply.
    test("one reply answers every question open when it arrived; a question asked after it waits", () => {
      const slug = field(proj, "Current Stage");
      for (const question of ["Way of working?", "Walking skeleton?", "How much testing?"]) {
        expect(guardedLog(proj, ["decision", "--stage", slug, "--decision", question, "--options", "A,B"]).rc).toBe(0);
      }
      recordHumanTurn(proj);
      for (const reply of ["A", "B", "A, with CI"]) {
        const r = guardedLog(proj, ["answer", "--stage", slug, "--details", reply]);
        expect(r.rc, r.out).toBe(0);
      }
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(3);
      expect(guardedLog(proj, ["decision", "--stage", slug, "--decision", "Deploy anywhere?", "--options", "A,B"]).rc).toBe(0);
      const late = guardedLog(proj, ["answer", "--stage", slug, "--details", "A"]);
      expect(late.rc).not.toBe(0);
      expect(late.out).toContain("no new human reply has arrived for the question");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(3);
    });

    test("with no HUMAN_TURN on record, an attended answer still asks for a reply", () => {
      const slug = field(proj, "Current Stage");
      expect(guardedLog(proj, ["decision", "--stage", slug, "--decision", "Choose", "--options", "A,B"]).rc).toBe(0);
      const r = guardedLog(proj, ["answer", "--stage", slug, "--details", "my answer"]);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("no new human reply has arrived for the question");
      expect(r.out).not.toContain("already recorded as an answer");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);
    });

    test("a reply an approval used keeps the no-reply refusal", () => {
      const slug = field(proj, "Current Stage");
      recordHumanTurn(proj);
      // An approval, not an answer, used the reply: "already recorded as an answer" would be false.
      appendAuditEntry("GATE_APPROVED", { Stage: slug, "User Input": "Approve" }, proj);
      const r = guardedLog(proj, ["answer", "--stage", slug, "--details", "my answer"]);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("no new human reply has arrived for the question");
      expect(r.out).not.toContain("already recorded as an answer");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);
    });

    test("a question logged after an answered reply keeps the no-reply refusal", () => {
      const slug = field(proj, "Current Stage");
      recordHumanTurn(proj);
      expect(guardedLog(proj, ["answer", "--stage", slug, "--details", "first answer"]).rc).toBe(0);
      // A new question is shown; its reply never reached the hooks, so no turn follows it.
      expect(guardedLog(proj, ["decision", "--stage", slug, "--decision", "Next question", "--options", "A,B"]).rc).toBe(0);
      const r = guardedLog(proj, ["answer", "--stage", slug, "--details", "second answer"]);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("no new human reply has arrived for the question");
      expect(r.out).not.toContain("already recorded as an answer");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(1);
    });

    // "Choose the recommended answers", said before the questions came: the
    // agent's choice is recorded as the agent's, with the words that handed it
    // over, never as the person's own answer.
    test("an answer the person left to the agent is recorded as the agent's, in their words", () => {
      const slug = field(proj, "Current Stage");
      recordHumanTurn(proj);
      expect(guardedLog(proj, ["answer", "--stage", slug, "--details", "first answer"]).rc).toBe(0);
      expect(guardedLog(proj, ["decision", "--stage", slug, "--decision", "Q1-Q5", "--options", "A,B"]).rc).toBe(0);
      // Without their words it is still theirs to answer.
      expect(guardedLog(proj, ["answer", "--stage", slug, "--details", "Q1: A"]).rc).not.toBe(0);
      const r = guardedLog(proj, [
        "answer", "--stage", slug, "--details", "Q1: A; Q2: B", "--on-instruction", "choose the  recommended answers",
      ]);
      expect(r.rc, r.out).toBe(0);
      const audit = readAllAuditShards(proj);
      expect(audit).toContain("**Answer Source**: chosen by the agent as the person asked");
      expect(audit).toContain("**Instruction**: choose the recommended answers");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(2);
    });

    test("with nothing the person said, blank words, a checkpoint, or an unattended run, it stays theirs", () => {
      const slug = field(proj, "Current Stage");
      const unsaid = guardedLog(proj, ["answer", "--stage", slug, "--details", "A", "--on-instruction", "up to you"]);
      expect(unsaid.rc).not.toBe(0);
      expect(unsaid.out).toContain("Nothing the person said in this piece of work is on record");
      recordHumanTurn(proj);
      const blank = guardedLog(proj, ["answer", "--stage", slug, "--details", "A", "--on-instruction", "  "]);
      expect(blank.out).toContain("--on-instruction needs the person's own words");
      const checkpoint = guardedLog(proj, [
        "answer", "--stage", slug, "--checkpoint", "summary-confirmation", "--details", "Looks correct",
        "--on-instruction", "up to you",
      ]);
      expect(checkpoint.out).toContain("--checkpoint summary-confirmation is theirs to answer");
      const unattended = guardedLog(proj, ["answer", "--stage", slug, "--details", "A", "--on-instruction", "up to you"], true);
      expect(unattended.out).toContain("--on-instruction needs a person in the session");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);
    });

    test("an unattended second answer keeps the AIDLC_UNATTENDED explanation", () => {
      const slug = field(proj, "Current Stage");
      recordHumanTurn(proj);
      expect(guardedLog(proj, ["answer", "--stage", slug, "--details", "my answer"]).rc).toBe(0);
      const r = guardedLog(proj, ["answer", "--stage", slug, "--details", "second answer"], true);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("Unset AIDLC_UNATTENDED");
      expect(r.out).not.toContain("already recorded as an answer");
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(1);
    });

    test("a redundant decorated approval answer is a no-op and report still approves", () => {
      const slug = field(proj, "Current Stage");
      const reply = "Approve (Recommended)";
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);
      recordHumanTurn(proj);

      const answer = guardedLog(proj, [
        "answer",
        "--stage",
        slug,
        "--details",
        reply,
      ]);
      expect(answer.rc).toBe(0);
      expect(answer.out).toContain('"skipped":"QUESTION_ANSWERED"');
      expect(answer.out).toContain('"reason":"approval-gate-report-owned"');
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);

      const approve = guardedReport(proj, [
        "--stage",
        slug,
        "--result",
        "approved",
        "--user-input",
        reply,
      ]);
      expect(approve.rc).toBe(0);
      expect(approve.out).toContain('"kind":"done"');
      expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
      expect(
        readAuditShardEvents(proj).find((row) => row.event === "GATE_APPROVED")?.block,
      ).toContain("**User Input**: Approve\n");
      expect(field(proj, "Current Stage")).not.toBe(slug);
    });

    for (const event of ["GATE_APPROVED", "GATE_REJECTED"]) {
      for (const [label, checkpoint, fingerprint, pending] of [
        ["another kind", "construction-unit", "current", true],
        ["older evidence", "walking-skeleton", "previous", true],
        ["the asked checkpoint", "walking-skeleton", "current", false],
      ] as const) {
        test(`${event} for ${label} preserves the gate-time answer route`, () => {
          const slug = field(proj, "Current Stage");
          guarded(proj, ["checkbox", `${slug}=in-progress`]);
          guarded(proj, ["gate-start", slug]);
          appendAuditEntry("DECISION_RECORDED", {
            Stage: slug, Checkpoint: "Construction Unit Approval",
            Unit: "alpha", Kind: "skeleton", Fingerprint: "current",
          }, proj);
          appendAuditEntry(event, {
            Stage: slug, Checkpoint: checkpoint, Unit: "alpha", Fingerprint: fingerprint,
          }, proj);
          recordHumanTurn(proj);
          const answer = guardedLog(proj, ["answer", "--stage", slug, "--details", "Approve"]);
          expect(answer.rc, answer.out).toBe(0);
          expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(pending ? 1 : 0);
          expect(answer.out.includes('"skipped":"QUESTION_ANSWERED"')).toBe(!pending);
        });
      }
    }

    test("a paraphrased answer is a no-op, and the agent's reported approval records as Approve", () => {
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);
      recordHumanTurn(proj);

      const answer = guardedLog(proj, [
        "answer",
        "--stage",
        slug,
        "--details",
        "The user approved",
      ]);
      expect(answer.rc).toBe(0);
      expect(answer.out).toContain('"skipped":"QUESTION_ANSWERED"');
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);

      const approve = guardedReport(proj, [
        "--stage",
        slug,
        "--result",
        "approved",
        "--user-input",
        "The user approved",
      ]);
      expect(approve.rc).toBe(0);
      expect(approve.out).toContain('"kind":"done"');
      expect(eventCount(proj, "GATE_APPROVED")).toBe(1);
    });

    test("an interview answer still cannot authorize a later same-turn approval", () => {
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      recordHumanTurn(proj);
      expect(
        guardedLog(proj, [
          "answer",
          "--stage",
          slug,
          "--details",
          "Interview response",
        ]).rc,
      ).toBe(0);
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(1);

      guarded(proj, ["gate-start", slug]);
      const approve = guardedReport(proj, [
        "--stage",
        slug,
        "--result",
        "approved",
        "--user-input",
        "fabricated approval",
      ]);
      expect(approve.rc).toBe(0);
      expect(approve.out).toContain('"kind":"print"');
      // The turn was spent on the interview answer: no reply is behind this approval.
      expect(approve.out).toContain("no new human reply");
      expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
    });

    // "can you fix it?" is from a live run where the agent passed the person's
    // question about a setting as their approval; presence alone refuses it.
    test.each(["Approve (Recommended)", "can you fix it?"])(
      "a redundant gate answer with NO human turn refuses (fabricated approve chain breaks at the answer): %s",
      (reply) => {
        const slug = field(proj, "Current Stage");
        guarded(proj, ["checkbox", `${slug}=in-progress`]);
        guarded(proj, ["gate-start", slug]);

        const answer = guardedLog(proj, [
          "answer",
          "--stage",
          slug,
          "--details",
          reply,
        ]);
        expect(answer.rc).not.toBe(0);
        expect(answer.out).toContain("Cannot record this approval choice");
        expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);

        const approve = guardedReport(proj, [
          "--stage",
          slug,
          "--result",
          "approved",
          "--user-input",
          reply,
        ]);
        expect(approve.rc).toBe(0);
        expect(approve.out).toContain('"kind":"print"');
        expect(approve.out).toContain("no new human reply has been received");
        expect(eventCount(proj, "GATE_APPROVED")).toBe(0);
        expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
          `- [?] ${slug}`,
        );
      },
    );

    test("rejection with NO human turn refuses without mutating state", () => {
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);

      const reject = guardedReport(proj, [
        "--stage",
        slug,
        "--result",
        "rejected",
        "--user-input",
        "Request Changes (Recommended)",
        "--reason",
        "tighten the schema",
      ]);
      expect(reject.rc).toBe(0);
      expect(reject.out).toContain('"kind":"print"');
      expect(reject.out).toContain("Cannot request changes");
      expect(eventCount(proj, "GATE_REJECTED")).toBe(0);
      expect(field(proj, "Revision Count")).toBe("0");
      expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
        `- [?] ${slug}`,
      );
    });

    test("a rejection consumes its human turn", () => {
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);
      recordHumanTurn(proj);

      const first = guardedReport(proj, [
        "--stage",
        slug,
        "--result",
        "rejected",
        "--user-input",
        "Request Changes",
        "--reason",
        "tighten the schema",
      ]);
      expect(first.rc).toBe(0);
      expect(first.out).not.toContain('"kind":"error"');
      expect(eventCount(proj, "GATE_REJECTED")).toBe(1);

      guarded(proj, ["revise", slug]);
      const second = guardedReport(proj, [
        "--stage",
        slug,
        "--result",
        "rejected",
        "--user-input",
        "Request Changes",
        "--reason",
        "tighten the schema again",
      ]);
      expect(second.rc).toBe(0);
      expect(second.out).toContain('"kind":"print"');
      expect(second.out).toContain("Cannot request changes");
      expect(eventCount(proj, "GATE_REJECTED")).toBe(1);
    });

    test("a redundant decorated rejection answer with a human turn is a no-op and report still rejects", () => {
      const slug = field(proj, "Current Stage");
      const reply = "Request Changes (Recommended)";
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);
      recordHumanTurn(proj);

      const answer = guardedLog(proj, [
        "answer",
        "--stage",
        slug,
        "--details",
        `${reply}: tighten the schema`,
      ]);
      expect(answer.rc).toBe(0);
      expect(answer.out).toContain('"skipped":"QUESTION_ANSWERED"');
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(0);

      const reject = guardedReport(proj, [
        "--stage",
        slug,
        "--result",
        "rejected",
        "--user-input",
        reply,
        "--reason",
        "tighten the schema",
      ]);
      expect(reject.rc).toBe(0);
      expect(reject.out).not.toContain('"kind":"error"');
      expect(eventCount(proj, "GATE_REJECTED")).toBe(1);
      expect(field(proj, "Revision Count")).toBe("1");
      expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
        `- [R] ${slug}`,
      );
    });

    test("a gate-word-prefixed answer to a pending non-gate question is recorded exactly", () => {
      const slug = field(proj, "Current Stage");
      guarded(proj, ["checkbox", `${slug}=in-progress`]);
      guarded(proj, ["gate-start", slug]);
      expect(
        guardedLog(proj, [
          "decision",
          "--stage",
          slug,
          "--decision",
          "Choose deployment option",
          "--options",
          "A,B",
        ]).rc,
      ).toBe(0);
      recordHumanTurn(proj);

      // The audit structure, not words such as "Reject", identifies this as the
      // pending clarifying question's answer.
      const answer = guardedLog(proj, [
        "answer",
        "--stage",
        slug,
        "--details",
        "Reject option B, use A",
      ]);
      expect(answer.rc).toBe(0);
      expect(answer.out).toContain('"emitted":"QUESTION_ANSWERED"');
      expect(eventCount(proj, "QUESTION_ANSWERED")).toBe(1);
      expect(readAllAuditShards(proj)).toContain(
        "**Details**: Reject option B, use A",
      );
    });
  });
});
