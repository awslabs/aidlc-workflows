// covers: cli:aidlc-audit(append-protected,append-batch-protected,append-raw-event-line,reserved-field-keys), function:findAllEvents, subcommand:aidlc-bolt:set-autonomy, function:proveMessage, function:humanActedSinceGate, function:hasUnsafeSingleLineCharacter, function:isNonAnswer, function:formatReceivedReply, function:isAutonomousConstructionDecision
//
// t261 — the authority floor on the audit surface (issue 681, claims 3/4/7/8).
// Five related guarantees, each with a REFUSE case and an ALLOW case so the
// floor neither leaks nor over-blocks:
//
//   1. The public audit CLI cannot forge authority-bearing receipts: `append`
//      / `append-batch` refuse HUMAN_TURN / GATE_* / QUESTION_ANSWERED /
//      REVIEW_* / SWARM_STARTED / SWARM_UNIT_CONVERGED / AUTONOMY_MODE_SET; `append-raw`
//      refuses a body carrying a taxonomy `**Event**:` line; caller-supplied
//      field keys use a strict one-line grammar and Event is reserved (a second
//      `**Event**:` line would spoof the multiline event queries). Diagnostic
//      events and free-form notes stay CLI-appendable; fixtures mint receipts
//      through the same library API used by their owning emitters.
//   2. `aidlc-bolt set-autonomy --mode autonomous` requires the person's
//      message that chose it (the ladder answer), named with --message and
//      proved, and the grant CONSUMES that message (a second escalation on it
//      refuses); de-escalation to gated never needs presence.
//   3. humanActedSinceGate fails CLOSED when a candidate human turn shares one
//      second-precision timestamp with any latest resolution in a DIFFERENT
//      shard (filename order carries no execution order), while same-shard
//      same-second sequences keep append order.
//   4. An answer with no words in it is not a decision: `aidlc-log answer`
//      refuses it. A cancellation word ("Cancelled", "Timed out") is what the
//      person typed (no host writes one into a reply), so it is recorded as
//      their answer, and `approve --user-input` and `reject --feedback` take it.
//   5. What a decision's text says about who decided is not read (issue 742's
//      "AGENT-INITIATED, NOT A HUMAN REJECTION" and "CONDUCTOR DEFAULT,
//      session unattended"): approve, reject and answer record the text as the
//      agent passed it when the person replied since the question, and refuse
//      it on presence alone when they did not.
//
// CRITICAL test-harness note: run-tests.ts sets AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1
// and AIDLC_ALLOW_DIRECT_AUDIT_EVENTS=1 for the whole suite. This test DELETES
// both from the spawned tool's env (per helper) — otherwise it would test the
// bypasses, not the guards. AIDLC_SKIP_ARTIFACT_GUARD stays set (separate
// chokepoint these bare fixtures do not satisfy).
//
// Source under test (dist/claude/.claude/tools/):
//   aidlc-audit.ts  CLI_PROTECTED_EVENT_TYPES + RESERVED_FIELD_KEYS floors,
//   aidlc-bolt.ts   handleSetAutonomy message proof,
//   aidlc-lib.ts    humanActedSinceGate (per-shard, cross-shard fail-closed),
//   aidlc-log.ts    handleAnswer non-answer floor,
//   aidlc-state.ts  handleApprove / handleReject non-answer floors.

import {
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededAuditDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry, CLI_PROTECTED_EVENT_TYPES } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditBlockField,
  findAllEvents,
  humanActedSinceGate,
  isAutonomousConstructionDecision,
  readAllAuditShards,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

const BUN = process.execPath;
const AUDIT = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");
const FIXTURES = join(import.meta.dir, "..", "fixtures");

// Spawn a tool with the two authority bypasses CLEARED (the artifact-guard
// bypass stays: it is a separate chokepoint). extraEnv wins over the clears so
// individual cases can re-enable one bypass deliberately.
function guarded(
  tool: string,
  args: string[],
  proj: string,
  extraEnv: Record<string, string> = {},
): { rc: number; out: string } {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_ALLOW_DIRECT_AUDIT_EVENTS;
  Object.assign(env, extraEnv);
  const r = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function guardedAsync(
  tool: string,
  args: string[],
  proj: string,
  extraEnv: Record<string, string> = {},
): Promise<{ rc: number; out: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    delete env.AIDLC_ALLOW_DIRECT_AUDIT_EVENTS;
    Object.assign(env, extraEnv);
    const child = spawn(BUN, [tool, ...args, "--project-dir", proj], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    child.on("close", (code) => resolve({ rc: code ?? -1, out }));
  });
}

// The owning-emitter route for a HUMAN_TURN, matching the mint hook's library
// call. The public CLI remains unavailable even when the suite enables its
// broader direct-audit fixture escape.
function mintHumanTurn(proj: string): void {
  appendAuditEntry("HUMAN_TURN", {}, proj);
}

function autonomousConstructionProject(): string {
  const p = createTestProject();
  seedStateFile(p, join(FIXTURES, "state-construction-with-worktree.md"));
  const statePath = seededStateFile(p);
  const state = readFileSync(statePath, "utf-8")
    .replace("- [-] code-generation — EXECUTE", "- [-] build-and-test — EXECUTE")
    .replace("- **Current Stage**: code-generation", "- **Current Stage**: build-and-test")
    .replace("- **Next Stage**: build-and-test", "- **Next Stage**: ci-pipeline")
    .replace(
      "- **Construction Autonomy Mode**: gated",
      "- **Construction Autonomy Mode**: autonomous",
    );
  writeFileSync(statePath, state, "utf-8");
  return p;
}

let proj = "";
afterEach(() => {
  if (proj) cleanupTestProject(proj);
  proj = "";
});

describe("t261 public audit CLI refuses authority-bearing receipts", () => {
  const PROTECTED = [
    "STAGE_COMPLETED",
    "HUMAN_TURN",
    // Spends a person's turn: an agent appending it would force a re-ask.
    "QUESTION_UNANSWERED",
    "GATE_APPROVED",
    "GATE_REJECTED",
    "QUESTION_ANSWERED",
    "PLAN_APPROVAL_RECORDED",
    "REVIEW_REQUESTED",
    "REVIEW_COMPLETED",
    "PIPELINE_LINK_COMPLETED",
    "ARTIFACT_REUSED",
    "SWARM_STARTED",
    "SWARM_UNIT_CONVERGED",
    "SWARM_SOURCE_MERGED",
    "AUTONOMY_MODE_SET",
    "UNIT_OWNERSHIP_SET",
    "UNIT_GATE_RHYTHM_SET",
    "UNIT_STARTED",
    "UNIT_PAUSED",
    "UNIT_RESUMED",
    "UNIT_COMPLETED",
    "UNIT_SKIPPED",
    "BOLT_STARTED",
    "BOLT_COMPLETED",
    "BOLT_FAILED",
    "AUDIT_FORKED",
    "AUDIT_MERGED",
    "STATE_FORKED",
    "STATE_MERGED",
    "WORKTREE_CREATED",
    "WORKTREE_MERGED",
    "WORKTREE_DISCARDED",
  ];

  test("append refuses every protected event type", () => {
    proj = createTestProject();
    for (const event of PROTECTED) {
      const r = guarded(AUDIT, ["append", event], proj);
      expect(r.rc).not.toBe(0);
      expect(r.out).toMatch(/authority-bearing receipt|reserved for its owning hook\/tool/);
      expect(r.out).toContain(event);
    }
    expect(readAllAuditShards(proj)).not.toContain("STAGE_COMPLETED");
    expect(readAllAuditShards(proj)).not.toContain("HUMAN_TURN");
    expect(readAllAuditShards(proj)).not.toContain("QUESTION_UNANSWERED");
  });

  test("the audit format guide names exactly the events the CLI refuses", () => {
    // A harness engineer reads this paragraph to learn what the public append refuses.
    const guide = readFileSync(join(AIDLC_SRC, "knowledge", "aidlc-shared", "audit-format.md"), "utf-8");
    const paragraph = guide.split("\n").find((line) => line.startsWith("The public `aidlc-audit.ts append` CLI is a diagnostic escape hatch"));
    expect(paragraph, "the escape-hatch paragraph is gone").toBeDefined();
    const named = [...(paragraph ?? "").matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1]).filter((name) => name !== "CLI_PROTECTED_EVENT_TYPES");
    expect([...named].sort()).toEqual([...CLI_PROTECTED_EVENT_TYPES].sort());
  });

  test("append-batch refuses a protected event smuggled among diagnostics", () => {
    proj = createTestProject();
    const entries = JSON.stringify([
      { eventType: "ERROR_LOGGED", fields: { Details: "x" } },
      { eventType: "STAGE_COMPLETED", fields: { Stage: "feasibility", Details: "y" } },
    ]);
    const r = guarded(AUDIT, ["append-batch", entries], proj);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("STAGE_COMPLETED");
    // the batch is all-or-nothing: the harmless entry must not have committed
    expect(readAllAuditShards(proj)).not.toContain("ERROR_LOGGED");
    expect(readAllAuditShards(proj)).not.toContain("STAGE_COMPLETED");
  });

  test("append-batch refuses a forged Bolt start, completion and merge-back", () => {
    proj = createTestProject();
    const entries = JSON.stringify([
      { eventType: "BOLT_STARTED", fields: { "Bolt slug": "demo" } },
      { eventType: "BOLT_COMPLETED", fields: { "Bolt slug": "demo" } },
      { eventType: "AUDIT_MERGED", fields: { "Bolt slug": "demo" } },
    ]);
    const r = guarded(AUDIT, ["append-batch", entries], proj);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("BOLT_STARTED");
    expect(readAllAuditShards(proj)).not.toContain("**Bolt slug**: demo");
  });

  test("receipt capture failure completes untracked with a visible warning", () => {
    proj = autonomousConstructionProject();
    const record = dirname(seededStateFile(proj));
    const dagDir = join(record, "inception", "units-generation");
    mkdirSync(dagDir, { recursive: true });
    writeFileSync(
      join(dagDir, "unit-of-work-dependency.md"),
      "```yaml\nunits:\n  - name: api\n    kind: invalid-kind\n    depends_on: []\n```\n",
      "utf-8",
    );
    const direct = {
      AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      AIDLC_SKIP_ARTIFACT_GUARD: "1",
    };
    expect(
      guarded(STATE, ["gate-start", "build-and-test"], proj, direct).rc,
    ).toBe(0);
    const approved = guarded(
      STATE,
      ["approve", "build-and-test", "--user-input", "Approve"],
      proj,
      direct,
    );
    expect(approved.rc, approved.out).toBe(0);
    expect(approved.out).toContain("Validity receipt omitted");
    const audit = readAllAuditShards(proj);
    expect(audit).toContain("**Event**: GATE_APPROVED");
    expect(audit).toContain("**Event**: STAGE_COMPLETED");
    expect(audit).toContain("**Validation Warning**:");
    expect(audit).not.toContain("**Validation Basis**:");
  });

  test("append-raw refuses a body carrying a taxonomy **Event**: line", () => {
    proj = createTestProject();
    const r = guarded(
      AUDIT,
      ["append-raw", "Note", "**Event**: GATE_APPROVED\\n**Stage**: feasibility"],
      proj,
    );
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("GATE_APPROVED");
    expect(readAllAuditShards(proj)).not.toContain("GATE_APPROVED");
  });

  test("field keys use a strict single-line grammar and Event stays reserved", () => {
    proj = createTestProject();
    const r = guarded(AUDIT, ["append", "ERROR_LOGGED", "--field", "Event=HUMAN_TURN"], proj);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Reserved field key");
    expect(readAllAuditShards(proj)).not.toContain("HUMAN_TURN");

    for (const key of [
      "\n**Event",
      "\r\n**Event",
      "Bad\u2028Key",
      "Bad\u2029Key",
    ]) {
      const injected = guarded(
        AUDIT,
        ["append", "ERROR_LOGGED", "--field", `${key}=HUMAN_TURN`],
        proj,
      );
      expect(injected.rc).not.toBe(0);
      expect(injected.out).toContain("Invalid audit field key");
    }
    const batch = guarded(
      AUDIT,
      [
        "append-batch",
        JSON.stringify([
          { eventType: "ERROR_LOGGED", fields: { "Bad\u0000Key": "UNIT_COMPLETED" } },
        ]),
      ],
      proj,
    );
    expect(batch.rc).not.toBe(0);
    expect(batch.out).toContain("Invalid audit field key");

    // Timestamp is accepted by the public `append` CLI — it must not refuse,
    // and it cannot spoof: renderAuditBlock drops it, so the emitter's own
    // **Timestamp**: line is the only one in the block (issue #715).
    const ts = guarded(
      AUDIT,
      ["append", "ERROR_LOGGED", "--field", "Timestamp=2020-01-01T00:00:00Z"],
      proj,
    );
    expect(ts.rc).toBe(0);
    expect(
      guarded(
        AUDIT,
        ["append", "ERROR_LOGGED", "--field", "Worker (retry)/path.v2=ok"],
        proj,
      ).rc,
    ).toBe(0);
    expect(readAllAuditShards(proj)).not.toContain("UNIT_COMPLETED");
  });

  test("append-raw rejects event injection through CR line breaks or its heading", () => {
    proj = createTestProject();
    for (const args of [
      ["append-raw", "Note", "safe\r**Event**: HUMAN_TURN"],
      ["append-raw", "Note\n**Event**: HUMAN_TURN", "safe"],
      // A bare label with its value on the next line, and the bullet forms
      // the field readers accept.
      ["append-raw", "Note", "**Event**:\nAUDIT_MERGED\n**Bolt slug**: demo"],
      ["append-raw", "Note", "-**Event**: AUDIT_MERGED"],
      ["append-raw", "Note", "-\t**Event**: AUDIT_MERGED"],
    ]) {
      const result = guarded(AUDIT, args, proj);
      expect(result.rc).not.toBe(0);
    }
    expect(readAllAuditShards(proj)).not.toContain("HUMAN_TURN");
    expect(readAllAuditShards(proj)).not.toContain("AUDIT_MERGED");
  });

  test("an event's value is read from its own line only", () => {
    const split = "\n## Note\n**Timestamp**: 2026-01-01T00:00:00Z\n**Event**:\nAUDIT_MERGED\n**Bolt slug**:\ndemo\n";
    expect(findAllEvents(split, "AUDIT_MERGED")).toEqual([]);
    expect(findAllEvents(split.replace("**Event**:\n", "**Event**: "), "AUDIT_MERGED", "demo")).toEqual([]);
    const whole = "\n## Audit Merged\n**Timestamp**: 2026-01-01T00:00:00Z\n**Event**: AUDIT_MERGED\n**Bolt slug**: demo\n";
    expect(findAllEvents(whole, "AUDIT_MERGED", "demo")).toHaveLength(1);
  });

  test("diagnostic events, free-form notes, and owning emitters still work", () => {
    proj = createTestProject();
    expect(guarded(AUDIT, ["append", "ERROR_LOGGED", "--field", "Details=x"], proj).rc).toBe(0);
    expect(guarded(AUDIT, ["append-raw", "Note", "just a diagnostic note"], proj).rc).toBe(0);
    mintHumanTurn(proj);
    expect(readAllAuditShards(proj)).toContain("HUMAN_TURN");
  });
});

describe("t261 set-autonomy escalation requires and consumes the person's message", () => {
  // Every command runs from the one chat the person types in.
  const CHAT = "01995000-7a11-7000-8000-000000000261";
  const inChat = { AIDLC_SESSION_OVERRIDE: CHAT };
  const bolt = (args: string[]) => guarded(BOLT, args, proj, inChat);
  const grant = (message?: string) =>
    bolt(["set-autonomy", "--mode", "autonomous", ...(message === undefined ? [] : ["--message", message])]);
  // The engine's times are to the second, and a grant in the same second as
  // the message is no decision after it: a grant that uses it up comes later.
  const tick = () => Bun.sleepSync(1100);

  // The person types `prompt` in the chat; the shipped human-turn hook keeps
  // it. Returns the id of the message it kept.
  function said(p: string, prompt: string): string {
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: p, AIDLC_PROJECT_DIR: p, ...inChat };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const r = spawnSync(BUN, [DISPATCHER, "engine", "hook", "record-human-turn"], {
      cwd: p,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: CHAT, prompt }),
      env,
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    const turn = readAuditShardEvents(p).filter((row) => row.event === "HUMAN_TURN").at(-1);
    const id = turn === undefined ? null : auditBlockField(turn.block, "Message Id");
    expect(id).not.toBeNull();
    return id as string;
  }

  function constructionProject(): string {
    const p = createTestProject();
    // Deliberately NOT seeding `Construction Autonomy Mode`. The fixture omits
    // it exactly as the generated state file does, so these tests exercise the
    // real production shape: set-autonomy has to CREATE the line. Appending
    // `- **Construction Autonomy Mode**: gated` here would manufacture the one
    // precondition the production path lacks and make every assertion below
    // incapable of catching issue #1045 (the grant threw `Field not found in
    // state file` before reaching the audit emission).
    seedStateFile(p, join(FIXTURES, "state-construction.md"));
    // Seed one row so the empty-ledger fail-open path does not apply.
    const seed = guarded(AUDIT, ["append", "ERROR_LOGGED", "--field", "Details=seed"], p);
    if (seed.rc !== 0) throw new Error(seed.out);
    return p;
  }

  test("escalation naming no message refuses; their message named commits it", () => {
    proj = constructionProject();
    const refused = grant();
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("Refusing to switch Construction to autonomous");
    // Run when the person chooses it; never a scripted re-ask.
    expect(refused.out).toContain("Run it with --message <id> after they choose it.");
    expect(refused.out).not.toContain("Ask the human to confirm");

    const id = said(proj, "Run it on its own from here.");
    // With their message on record, the refusal leads with the retry naming it.
    const unnamed = grant();
    expect(unnamed.rc).not.toBe(0);
    expect(unnamed.out).toContain(`If their message ${id} (sent `);
    expect(unnamed.out).toContain("run the same command with --message <id>");
    expect(unnamed.out).not.toContain("Run it on its own from here.");

    const granted = grant(id);
    expect(granted.rc, granted.out).toBe(0);
    expect(granted.out).toContain('"state_updated":true');
    const row = readAuditShardEvents(proj).filter((r) => r.event === "AUTONOMY_MODE_SET").at(-1);
    expect(row === undefined ? null : auditBlockField(row.block, "Mode")).toBe("autonomous");
    expect(row === undefined ? null : auditBlockField(row.block, "Message Id")).toBe(id);
  });

  // The grant answers the ladder prompt: a message that was only a command to
  // AIDLC is no answer to it.
  test("a command to AIDLC named as the message refuses; the person's reply commits it", () => {
    proj = constructionProject();
    const command = said(proj, "/aidlc --status");
    const refused = grant(command);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain(`message ${command} carried no words of the person's own (a command to AIDLC`);
    // Nothing of theirs a grant can stand on, so the refusal names no message.
    const unnamed = grant();
    expect(unnamed.rc).not.toBe(0);
    expect(unnamed.out).toContain("Run it with --message <id> after they choose it.");
    expect(unnamed.out).not.toContain("If their message");
    const reply = said(proj, "Yes, run it on its own.");
    const granted = grant(reply);
    expect(granted.rc, granted.out).toBe(0);
  });

  test("the grant consumes the message: re-escalation on it refuses", () => {
    proj = constructionProject();
    const id = said(proj, "Run it on its own from here.");
    tick();
    expect(grant(id).rc).toBe(0);
    // flip back to gated so a second escalation is a real transition
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace(
        /Construction Autonomy Mode\*\*: autonomous/,
        "Construction Autonomy Mode**: gated",
      ),
      "utf-8",
    );
    const again = grant(id);
    expect(again.rc).not.toBe(0);
    expect(again.out).toContain(`message ${id} arrived before the last approval or decision`);
  });

  test("de-escalation to gated never needs presence", () => {
    proj = constructionProject();
    expect(bolt(["set-autonomy", "--mode", "gated"]).rc).toBe(0);
  });

  test("concurrent grants on one message consume it exactly once", async () => {
    proj = constructionProject();
    const id = said(proj, "Run it on its own from here.");
    tick();
    const results = await Promise.all([
      guardedAsync(BOLT, ["set-autonomy", "--mode", "autonomous", "--message", id], proj, inChat),
      guardedAsync(BOLT, ["set-autonomy", "--mode", "autonomous", "--message", id], proj, inChat),
    ]);
    expect(results.filter((result) => result.rc === 0).length).toBe(1);
    expect(results.filter((result) => result.rc !== 0).length).toBe(1);
    expect(
      readAllAuditShards(proj).match(/\*\*Event\*\*: AUTONOMY_MODE_SET/g)?.length,
    ).toBe(1);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
      "Construction Autonomy Mode**: autonomous",
    );
  });

  // Issue #1045. The field is runtime metadata the generator does not emit,
  // though the shipped state template declares it under `## Current Status`.
  // The write must therefore CREATE it, in that section, exactly once.
  test("the grant creates the field under ## Current Status when absent", () => {
    proj = constructionProject();
    const before = readFileSync(seededStateFile(proj), "utf-8");
    expect(before).not.toContain("Construction Autonomy Mode");

    const id = said(proj, "Run it on its own from here.");
    expect(grant(id).rc).toBe(0);

    const after = readFileSync(seededStateFile(proj), "utf-8");
    // Section membership, not line ordering: the insert lands at the end of the
    // section rather than at the template's exact offset, and nothing reads it
    // positionally.
    const currentStatus = after.slice(
      after.indexOf("## Current Status"),
      after.indexOf("## Session Resume Point"),
    );
    expect(currentStatus).toContain("- **Construction Autonomy Mode**: autonomous");
    expect(after.match(/Construction Autonomy Mode/g)?.length).toBe(1);
  });

  test("a second grant updates the field in place instead of duplicating it", () => {
    proj = constructionProject();
    const id = said(proj, "Run it on its own from here.");
    expect(grant(id).rc).toBe(0);
    expect(bolt(["set-autonomy", "--mode", "gated"]).rc).toBe(0);

    const after = readFileSync(seededStateFile(proj), "utf-8");
    expect(after.match(/Construction Autonomy Mode/g)?.length).toBe(1);
    expect(after).toContain("- **Construction Autonomy Mode**: gated");
    expect(after).not.toContain("Construction Autonomy Mode**: autonomous");
  });

  test("a state file without the ## Current Status heading still fails closed", () => {
    proj = constructionProject();
    const statePath = seededStateFile(proj);
    writeFileSync(
      statePath,
      readFileSync(statePath, "utf-8").replace("## Current Status", "## Current Status Renamed"),
      "utf-8",
    );
    const refused = bolt(["set-autonomy", "--mode", "gated"]);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("State update failed");
    expect(readFileSync(statePath, "utf-8")).not.toContain(
      "- **Construction Autonomy Mode**:",
    );
  });
});

describe("t261 humanActedSinceGate cross-shard same-second ambiguity", () => {
  const TS = "2026-07-30T10:00:00Z";
  function block(event: string, ts = TS, fields = ""): string {
    return `\n## ${event}\n**Timestamp**: ${ts}\n**Event**: ${event}\n${fields}\n---\n`;
  }

  test("same-second tie across DIFFERENT shards fails closed", () => {
    proj = createTestProject();
    seedStateFile(proj, join(FIXTURES, "state-construction.md"));
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    // resolution in the lexically-FIRST shard, human turn at the SAME second in
    // the lexically-LATER shard: filename order would rank the turn "after" the
    // resolution, but execution order is unknowable -> refuse.
    writeFileSync(join(auditDir, "aaaa.md"), `# Audit\n${block("GATE_APPROVED", TS, "**Stage**: x\n")}`, "utf-8");
    writeFileSync(join(auditDir, "bbbb.md"), `# Audit\n${block("HUMAN_TURN")}`, "utf-8");
    expect(humanActedSinceGate(proj)).toBe(false);
  });

  test.each([
    ["aaaa-approval.md", "zzzz-rejection-turn.md"],
    ["zzzz-approval.md", "aaaa-rejection-turn.md"],
  ])(
    "every same-second cross-shard resolution must precede the human turn (%s, %s)",
    (approvalShard, rejectionTurnShard) => {
      proj = createTestProject();
      seedStateFile(proj, join(FIXTURES, "state-construction.md"));
      const auditDir = seededAuditDir(proj);
      mkdirSync(auditDir, { recursive: true });
      // The same-shard human turn follows the rejection, but the approval
      // remains unordered relative to that turn in either filename order.
      writeFileSync(
        join(auditDir, approvalShard),
        `# Audit\n${block("GATE_APPROVED", TS, "**Stage**: x\n")}`,
        "utf-8",
      );
      writeFileSync(
        join(auditDir, rejectionTurnShard),
        `# Audit\n${block("GATE_REJECTED", TS, "**Stage**: x\n")}${block("HUMAN_TURN")}`,
        "utf-8",
      );
      expect(humanActedSinceGate(proj)).toBe(false);
    },
  );

  test("same-shard same-second keeps append order (allow)", () => {
    proj = createTestProject();
    seedStateFile(proj, join(FIXTURES, "state-construction.md"));
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, "aaaa.md"), `# Audit\n${block("GATE_APPROVED", TS, "**Stage**: x\n")}`, "utf-8");
    appendFileSync(join(auditDir, "aaaa.md"), block("HUMAN_TURN"), "utf-8");
    expect(humanActedSinceGate(proj)).toBe(true);
  });

  test("same-shard same-second keeps append order (refuse)", () => {
    proj = createTestProject();
    seedStateFile(proj, join(FIXTURES, "state-construction.md"));
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, "aaaa.md"), `# Audit\n${block("HUMAN_TURN")}`, "utf-8");
    appendFileSync(
      join(auditDir, "aaaa.md"),
      block("GATE_APPROVED", TS, "**Stage**: x\n"),
      "utf-8",
    );
    expect(humanActedSinceGate(proj)).toBe(false);
  });

  test("a strictly-later cross-shard human turn allows", () => {
    proj = createTestProject();
    seedStateFile(proj, join(FIXTURES, "state-construction.md"));
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, "aaaa.md"), `# Audit\n${block("GATE_APPROVED", TS, "**Stage**: x\n")}`, "utf-8");
    writeFileSync(join(auditDir, "bbbb.md"), `# Audit\n${block("HUMAN_TURN", "2026-07-30T10:00:01Z")}`, "utf-8");
    expect(humanActedSinceGate(proj)).toBe(true);
  });

  test("autonomous AUTONOMY_MODE_SET counts as a resolution (consumes the turn)", () => {
    proj = createTestProject();
    seedStateFile(proj, join(FIXTURES, "state-construction.md"));
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(
      join(auditDir, "aaaa.md"),
      `# Audit\n${block("HUMAN_TURN", "2026-07-30T10:00:00Z")}${block("AUTONOMY_MODE_SET", "2026-07-30T10:00:01Z", "**Mode**: autonomous\n")}`,
      "utf-8",
    );
    expect(humanActedSinceGate(proj)).toBe(false);
    // a gated de-escalation row is NOT a resolution
    writeFileSync(
      join(auditDir, "aaaa.md"),
      `# Audit\n${block("HUMAN_TURN", "2026-07-30T10:00:00Z")}${block("AUTONOMY_MODE_SET", "2026-07-30T10:00:01Z", "**Mode**: gated\n")}`,
      "utf-8",
    );
    expect(humanActedSinceGate(proj)).toBe(true);
  });
});

describe("t261 an answer with no words is not a decision; a cancellation word is one", () => {
  function ideationProject(): string {
    const p = createTestProject();
    seedStateFile(p, join(FIXTURES, "state-mid-ideation.md"));
    return p;
  }

  test("an answer with no words in it refuses; a cancellation word is the person's answer like any other", () => {
    proj = ideationProject();
    mintHumanTurn(proj);
    for (const details of ["   ", "\t"]) {
      const r = guarded(LOG, ["answer", "--stage", "feasibility", "--details", details], proj);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("Cannot record reply");
    }
    expect(readAllAuditShards(proj)).not.toContain("QUESTION_ANSWERED");
    // No host hands the hook dismissal text (measured on Claude Code and Codex,
    // 2026-10-12), so these are words a person typed, and the agent's reading of
    // them is recorded as any other answer.
    for (const details of ["Cancelled", "cancelled", "user dismissed", "Timed out"]) {
      mintHumanTurn(proj);
      const r = guarded(LOG, ["answer", "--stage", "feasibility", "--details", details], proj);
      expect(r.rc, r.out).toBe(0);
      expect(r.out).toContain("QUESTION_ANSWERED");
    }
  });

  test("summary confirmation refusal quotes and truncates the reply and names both valid choices", () => {
    proj = ideationProject();
    const invalid = `Maybe the defaults ${"x".repeat(180)}`;
    const r = guarded(
      LOG,
      [
        "answer",
        "--stage",
        "feasibility",
        "--checkpoint",
        "summary-confirmation",
        "--questions-file",
        "unused.md",
        "--details",
        invalid,
      ],
      proj,
    );
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain('--details \\"Maybe the defaults ');
    expect(r.out).toContain('...\\"');
    expect(r.out).not.toContain(invalid);
    expect(r.out).toContain('\\"Looks correct\\" or \\"Request changes\\"');
    expect(readAllAuditShards(proj)).not.toContain("SUMMARY_CONFIRMATION_RECORDED");
  });

  test("a substantive answer containing a cancellation word passes", () => {
    proj = ideationProject();
    mintHumanTurn(proj);
    const r = guarded(
      LOG,
      ["answer", "--stage", "feasibility", "--details", "cancel the standing order via cron"],
      proj,
    );
    expect(r.rc).toBe(0);
    expect(r.out).toContain("QUESTION_ANSWERED");
  });

  // The person's words at a gate are theirs whatever they are: "cancelled" and
  // "Timed out" are what they typed, and the agent's reading of them is recorded.
  test("reject --feedback that is a cancellation word records it as the person's feedback", () => {
    proj = ideationProject();
    const direct = { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_ARTIFACT_GUARD: "1" };
    expect(guarded(STATE, ["gate-start", "feasibility"], proj, direct).rc).toBe(0);
    mintHumanTurn(proj);
    const rj = guarded(
      STATE,
      ["reject", "feasibility", "--user-input", "Request Changes", "--feedback", "Timed out"],
      proj,
      direct,
    );
    expect(rj.rc, rj.out).toBe(0);
    const audit = readAllAuditShards(proj);
    expect(audit).toContain("GATE_REJECTED");
    expect(audit).toContain("Timed out");
  });

  test("approve --user-input that is a cancellation word is the agent's reading of their words, and commits", () => {
    proj = ideationProject();
    const direct = { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_ARTIFACT_GUARD: "1" };
    expect(guarded(STATE, ["gate-start", "feasibility"], proj, direct).rc).toBe(0);
    mintHumanTurn(proj);
    const ap = guarded(STATE, ["approve", "feasibility", "--user-input", "cancelled"], proj, direct);
    expect(ap.rc, ap.out).toBe(0);
    expect(readAllAuditShards(proj)).toContain("GATE_APPROVED");
  });
});

describe("t261 a decision's text is recorded as passed; the person's reply decides", () => {
  const DIRECT = {
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
  };

  function ideationProject(): string {
    const p = createTestProject();
    seedStateFile(p, join(FIXTURES, "state-mid-ideation.md"));
    return p;
  }

  function openGate(p: string): void {
    expect(guarded(STATE, ["gate-start", "feasibility"], p, DIRECT).rc).toBe(0);
    mintHumanTurn(p);
  }

  test("solo approve/reject preserve state-precondition error precedence", () => {
    proj = ideationProject();
    const approve = guarded(
      STATE,
      ["approve", "scope-definition"],
      proj,
      DIRECT,
    );
    expect(approve.rc).not.toBe(0);
    expect(approve.out).toContain(
      "Stage scope-definition is in state 'pending'",
    );
    expect(approve.out).not.toContain("--user-input must contain");

    const reject = guarded(
      STATE,
      ["reject", "scope-definition", "--feedback", "change it"],
      proj,
      DIRECT,
    );
    expect(reject.rc).not.toBe(0);
    expect(reject.out).toContain(
      "Stage scope-definition is in state 'pending'",
    );
    expect(reject.out).not.toContain("a real human has not acted");

    mintHumanTurn(proj);
    const attributed = guarded(
      STATE,
      [
        "reject",
        "scope-definition",
        "--feedback",
        "I, the conductor, am rejecting this.",
      ],
      proj,
      DIRECT,
    );
    expect(attributed.rc).not.toBe(0);
    expect(attributed.out).toContain(
      "Stage scope-definition is in state 'pending'",
    );
    expect(attributed.out).not.toContain("decision self-attribution blocked");
  });

  // The agent's text is recorded as it passed it, whatever it says about who
  // decided: the check behind every decision is that the person replied (issue
  // 742's phrases, now recorded with a reply behind them, refused without one).
  const SELF_ATTRIBUTED_REJECTIONS = [
    "AGENT-INITIATED, NOT A HUMAN REJECTION. The human approved at 08:50; completion is blocked by a circular guard dependency and this reopen exists solely to obtain a review budget.",
    "NOT a human rejection. Recorded by the conductor to reopen the revision cycle honestly: the produces[] artifacts were revised after the reviewer's receipt.",
    "B. Request Changes - CONDUCTOR DEFAULT, session unattended, taking the conductor's own stated recommendation.",
    "This rejection was generated by the AI.",
    "I, the conductor, am rejecting this.",
  ];

  test.each(SELF_ATTRIBUTED_REJECTIONS)("reject records the agent's text with the person's reply behind it (%#)", (feedback) => {
    proj = ideationProject();
    openGate(proj);
    const r = guarded(
      STATE,
      [
        "reject",
        "feasibility",
        "--user-input",
        "Request Changes",
        "--feedback",
        feedback,
      ],
      proj,
      DIRECT,
    );
    expect(r.rc, r.out).toBe(0);
    expect(readAllAuditShards(proj)).toContain("GATE_REJECTED");
  });

  test("an approval and an answer that say the agent chose record with a reply behind them, and refuse without one", () => {
    const approval = ["approve", "feasibility", "--user-input", "Approve - CONDUCTOR DEFAULT, session unattended."];
    const answer = ["answer", "--stage", "feasibility", "--details", "A. Nothing to add - chosen by the assistant."];
    proj = ideationProject();
    expect(guarded(STATE, ["gate-start", "feasibility"], proj, DIRECT).rc).toBe(0);
    const unbacked = guarded(STATE, approval, proj, DIRECT);
    expect(unbacked.rc).not.toBe(0);
    expect(unbacked.out).toContain("no new human reply");
    mintHumanTurn(proj);
    const approved = guarded(STATE, approval, proj, DIRECT);
    expect(approved.rc, approved.out).toBe(0);
    expect(readAllAuditShards(proj)).toContain("GATE_APPROVED");

    cleanupTestProject(proj);
    proj = ideationProject();
    expect(guarded(LOG, ["decision", "--stage", "feasibility", "--decision", "Anything to add?", "--options", "A,B"], proj).rc).toBe(0);
    const unanswered = guarded(LOG, answer, proj);
    expect(unanswered.rc).not.toBe(0);
    expect(unanswered.out).toContain("no new human reply");
    mintHumanTurn(proj);
    const answered = guarded(LOG, answer, proj);
    expect(answered.rc, answered.out).toBe(0);
    expect(readAllAuditShards(proj)).toContain("QUESTION_ANSWERED");
  });

  const SUBSTANTIVE = [
    "revert the agent-initiated retry in scheduler.ts, it double-charges on timeout",
    "The conductor default timeout of 30s is too low - make it configurable",
    "the unattended batch job should retry three times before paging",
    "This is not a human response time issue",
    "This isn't a human rejection-handler issue",
    "never confirmed by the human resources team",
    "the report was written by the conductor service",
    "The session was unattended after the websocket dropped",
    "Mumbai initiated rejection handling after the timeout",
    "Revert the AI-initiated rejection handler; it drops valid requests",
    "Remove the model-authored decision example from the documentation",
    "Delete the AI-generated rejection, because the API returns it twice",
    "Remove the model-authored decision, cited in section 2",
    "Change the assistant default, because it points to prod",
    "Tune conductor default-timeout to twenty minutes",
    'Remove the phrase "NOT A HUMAN REJECTION" from the guide',
    "Remove the phrase 'NOT A HUMAN REJECTION.' from the guide",
    "Document `Approve - CONDUCTOR DEFAULT, session unattended` as a blocked example",
    "Document ``NOT A HUMAN REJECTION`` as prohibited",
    "~~~\nNOT A HUMAN REJECTION\n~~~",
    "```text\nNOT A HUMAN REJECTION.",
    "~~~text\nCONDUCTOR DEFAULT.",
    "> NOT A HUMAN REJECTION",
    "   > NOT A HUMAN REJECTION",
    "> Example:\nNOT A HUMAN REJECTION",
    "Split P-2 into two personas and add the supervising-N-tasks situation",
  ];

  test.each(SUBSTANTIVE)("reject --feedback accepts substantive human prose (%#)", (feedback) => {
    proj = ideationProject();
    openGate(proj);
    const r = guarded(
      STATE,
      [
        "reject",
        "feasibility",
        "--user-input",
        "Request Changes",
        "--feedback",
        feedback,
      ],
      proj,
      DIRECT,
    );
    expect(r.rc).toBe(0);
    expect(readAllAuditShards(proj)).toContain("GATE_REJECTED");
  });

  test("autonomous exemption is phase-scoped to Construction", () => {
    const state = "- **Construction Autonomy Mode**: autonomous\n";
    expect(isAutonomousConstructionDecision(state, "initialization")).toBe(false);
    expect(isAutonomousConstructionDecision(state, "ideation")).toBe(false);
    expect(isAutonomousConstructionDecision(state, "inception")).toBe(false);
    expect(isAutonomousConstructionDecision(state, "construction")).toBe(true);
    expect(isAutonomousConstructionDecision(state, "operation")).toBe(false);
  });

  test("autonomous Construction reject and ordinary answer record the conductor's text", () => {
    proj = autonomousConstructionProject();
    expect(guarded(STATE, ["gate-start", "build-and-test"], proj, DIRECT).rc).toBe(0);
    const rejected = guarded(
      STATE,
      ["reject", "build-and-test", "--feedback", "NOT A HUMAN REJECTION."],
      proj,
      DIRECT,
    );
    expect(rejected.rc, rejected.out).toBe(0);
    expect(readAllAuditShards(proj)).toContain("GATE_REJECTED");

    cleanupTestProject(proj);
    proj = autonomousConstructionProject();
    const answered = guarded(
      LOG,
      ["answer", "--stage", "build-and-test", "--details", "CONDUCTOR DEFAULT."],
      proj,
    );
    expect(answered.rc, answered.out).toBe(0);
    expect(readAllAuditShards(proj)).toContain("QUESTION_ANSWERED");
  });
});
