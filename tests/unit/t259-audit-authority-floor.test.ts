// covers: cli:aidlc-audit(append-protected,append-batch-protected,append-raw-event-line,reserved-field-keys), subcommand:aidlc-bolt:set-autonomy, function:humanActedSinceGate, function:isNonAnswer
//
// t259 — the authority floor on the audit surface (issue 681, claims 3/4/7/8).
// Four related guarantees, each with a REFUSE case and an ALLOW case so the
// floor neither leaks nor over-blocks:
//
//   1. The public audit CLI cannot forge authority-bearing receipts: `append`
//      / `append-batch` refuse HUMAN_TURN / GATE_* / QUESTION_ANSWERED /
//      REVIEW_* / SWARM_UNIT_CONVERGED / AUTONOMY_MODE_SET; `append-raw`
//      refuses a body carrying a taxonomy `**Event**:` line; caller-supplied
//      Event/Timestamp field keys are refused everywhere (a second `**Event**:`
//      line would spoof the multiline event queries). Diagnostic events and
//      free-form notes stay CLI-appendable; AIDLC_ALLOW_DIRECT_AUDIT_EVENTS=1
//      is the fixture escape (the suite sets it globally; this file clears it
//      per spawn to exercise the refusal).
//   2. `aidlc-bolt set-autonomy --mode autonomous` requires a fresh HUMAN_TURN
//      (the ladder answer) and the grant CONSUMES the turn (a second
//      escalation without a new turn refuses); de-escalation to gated never
//      needs presence.
//   3. humanActedSinceGate fails CLOSED when the deciding human-turn /
//      resolution pair shares one second-precision timestamp across DIFFERENT
//      shards (filename order carries no execution order), while same-shard
//      same-second sequences keep append order.
//   4. Cancellation boilerplate is not a decision: `aidlc-log answer` refuses
//      it as an interview answer (including the issue's named repro:
//      status=completed with answer "Cancelled"), `approve --user-input` and
//      `reject --feedback` refuse it at the gate. Substantive answers that
//      merely CONTAIN a cancellation word pass.
//
// CRITICAL test-harness note: run-tests.ts sets AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1
// and AIDLC_ALLOW_DIRECT_AUDIT_EVENTS=1 for the whole suite. This test DELETES
// both from the spawned tool's env (per helper) — otherwise it would test the
// bypasses, not the guards. AIDLC_SKIP_ARTIFACT_GUARD stays set (separate
// chokepoint these bare fixtures do not satisfy).
//
// Source under test (dist/claude/.claude/tools/):
//   aidlc-audit.ts  CLI_PROTECTED_EVENT_TYPES + RESERVED_FIELD_KEYS floors,
//   aidlc-bolt.ts   handleSetAutonomy presence gate,
//   aidlc-lib.ts    humanActedSinceGate (per-shard, cross-shard fail-closed),
//   aidlc-log.ts    handleAnswer non-answer floor,
//   aidlc-state.ts  handleApprove / handleReject non-answer floors.

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  seededAuditDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";
import { humanActedSinceGate, readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const AUDIT = join(AIDLC_SRC, "tools", "aidlc-audit.ts");
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
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
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// The owning-emitter route for a HUMAN_TURN (what the mint hook does through
// the library import) — simulated via the documented fixture escape.
function mintHumanTurn(proj: string): void {
  const r = guarded(AUDIT, ["append", "HUMAN_TURN"], proj, {
    AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1",
  });
  if (r.rc !== 0) throw new Error(`mint failed: ${r.out}`);
}

let proj = "";
afterEach(() => {
  if (proj) cleanupTestProject(proj);
  proj = "";
});

describe("t259 public audit CLI refuses authority-bearing receipts", () => {
  const PROTECTED = [
    "HUMAN_TURN",
    "GATE_APPROVED",
    "GATE_REJECTED",
    "QUESTION_ANSWERED",
    "REVIEW_REQUESTED",
    "REVIEW_COMPLETED",
    "SWARM_UNIT_CONVERGED",
    "AUTONOMY_MODE_SET",
  ];

  test("append refuses every protected event type", () => {
    proj = createTestProject();
    for (const event of PROTECTED) {
      const r = guarded(AUDIT, ["append", event], proj);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("authority-bearing receipt");
      expect(r.out).toContain(event);
    }
    // nothing landed on disk
    expect(readAllAuditShards(proj)).not.toContain("HUMAN_TURN");
  });

  test("append-batch refuses a protected event smuggled among diagnostics", () => {
    proj = createTestProject();
    const entries = JSON.stringify([
      { eventType: "ERROR_LOGGED", fields: { Details: "x" } },
      { eventType: "QUESTION_ANSWERED", fields: { Stage: "feasibility", Details: "y" } },
    ]);
    const r = guarded(AUDIT, ["append-batch", entries], proj);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("QUESTION_ANSWERED");
    // the batch is all-or-nothing: the harmless entry must not have committed
    expect(readAllAuditShards(proj)).not.toContain("ERROR_LOGGED");
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

  test("the Event field key is reserved on every emit path (Timestamp stays legal)", () => {
    proj = createTestProject();
    const r = guarded(AUDIT, ["append", "ERROR_LOGGED", "--field", "Event=HUMAN_TURN"], proj);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Reserved field key");
    expect(readAllAuditShards(proj)).not.toContain("HUMAN_TURN");
    // Timestamp is a documented field on park/unpark rows — it must not refuse,
    // and it cannot spoof (the emitter's own **Timestamp**: line is first).
    const ts = guarded(
      AUDIT,
      ["append", "ERROR_LOGGED", "--field", "Timestamp=2020-01-01T00:00:00Z"],
      proj,
    );
    expect(ts.rc).toBe(0);
  });

  test("diagnostic events, free-form notes, and the fixture escape still work", () => {
    proj = createTestProject();
    expect(guarded(AUDIT, ["append", "ERROR_LOGGED", "--field", "Details=x"], proj).rc).toBe(0);
    expect(guarded(AUDIT, ["append-raw", "Note", "just a diagnostic note"], proj).rc).toBe(0);
    expect(
      guarded(AUDIT, ["append", "HUMAN_TURN"], proj, { AIDLC_ALLOW_DIRECT_AUDIT_EVENTS: "1" }).rc,
    ).toBe(0);
  });
});

describe("t259 set-autonomy escalation requires and consumes a human turn", () => {
  function constructionProject(): string {
    const p = createTestProject();
    seedStateFile(p, join(FIXTURES, "state-construction.md"));
    const statePath = seededStateFile(p);
    writeFileSync(
      statePath,
      `${readFileSync(statePath, "utf-8")}\n- **Construction Autonomy Mode**: gated\n`,
      "utf-8",
    );
    // Seed one row so the empty-ledger fail-open path does not apply.
    const seed = guarded(AUDIT, ["append", "ERROR_LOGGED", "--field", "Details=seed"], p);
    if (seed.rc !== 0) throw new Error(seed.out);
    return p;
  }

  test("escalation without a human turn refuses; after a turn it commits", () => {
    proj = constructionProject();
    const refused = guarded(BOLT, ["set-autonomy", "--mode", "autonomous"], proj);
    expect(refused.rc).not.toBe(0);
    expect(refused.out).toContain("Refusing to switch Construction to autonomous");

    mintHumanTurn(proj);
    const granted = guarded(BOLT, ["set-autonomy", "--mode", "autonomous"], proj);
    expect(granted.rc).toBe(0);
    expect(granted.out).toContain('"state_updated":true');
  });

  test("the grant consumes the turn: re-escalation refuses without a fresh turn", () => {
    proj = constructionProject();
    mintHumanTurn(proj);
    expect(guarded(BOLT, ["set-autonomy", "--mode", "autonomous"], proj).rc).toBe(0);
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
    const again = guarded(BOLT, ["set-autonomy", "--mode", "autonomous"], proj);
    expect(again.rc).not.toBe(0);
  });

  test("de-escalation to gated never needs presence", () => {
    proj = constructionProject();
    expect(guarded(BOLT, ["set-autonomy", "--mode", "gated"], proj).rc).toBe(0);
  });
});

describe("t259 humanActedSinceGate cross-shard same-second ambiguity", () => {
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

  test("same-shard same-second keeps append order (allow)", () => {
    proj = createTestProject();
    seedStateFile(proj, join(FIXTURES, "state-construction.md"));
    const auditDir = seededAuditDir(proj);
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, "aaaa.md"), `# Audit\n${block("GATE_APPROVED", TS, "**Stage**: x\n")}`, "utf-8");
    appendFileSync(join(auditDir, "aaaa.md"), block("HUMAN_TURN"), "utf-8");
    expect(humanActedSinceGate(proj)).toBe(true);
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

describe("t259 cancellation boilerplate is not a decision", () => {
  function ideationProject(): string {
    const p = createTestProject();
    seedStateFile(p, join(FIXTURES, "state-mid-ideation.md"));
    return p;
  }

  test("answer 'Cancelled' (the completed-widget repro) refuses; empty refuses", () => {
    proj = ideationProject();
    mintHumanTurn(proj);
    for (const details of ["Cancelled", "cancelled", "user dismissed", "Timed out", "   "]) {
      const r = guarded(LOG, ["answer", "--stage", "feasibility", "--details", details], proj);
      expect(r.rc).not.toBe(0);
    }
    expect(readAllAuditShards(proj)).not.toContain("QUESTION_ANSWERED");
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

  test("approve --user-input and reject --feedback refuse cancellation boilerplate", () => {
    proj = ideationProject();
    const direct = { AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_ARTIFACT_GUARD: "1" };
    expect(guarded(STATE, ["gate-start", "feasibility"], proj, direct).rc).toBe(0);
    mintHumanTurn(proj);

    const ap = guarded(STATE, ["approve", "feasibility", "--user-input", "cancelled"], proj, direct);
    expect(ap.rc).not.toBe(0);
    expect(ap.out).toContain("cancellation boilerplate");

    const rj = guarded(STATE, ["reject", "feasibility", "--feedback", "Timed out"], proj, direct);
    expect(rj.rc).not.toBe(0);
    expect(rj.out).toContain("cancellation boilerplate");

    // the real choice still commits (same turn: neither refusal consumed it)
    const ok = guarded(STATE, ["approve", "feasibility", "--user-input", "Approve"], proj, direct);
    expect(ok.rc).toBe(0);
    expect(readAllAuditShards(proj)).toContain("GATE_APPROVED");
  });
});
