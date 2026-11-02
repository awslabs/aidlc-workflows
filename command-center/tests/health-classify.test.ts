// The "Needs fixing" classifiers: pure rules over AIDLC's own records (drops, ERROR_LOGGED, sensors, checkpoints, heartbeats).
import { describe, expect, test } from "bun:test";
import {
  checkpointState, classifyDrop, classifyError, guardRefusalState, heartbeatStates, parseDrops, parseGuardAsk,
  recoveryInvalid, sensorNotRun, stopCounterStalled,
} from "../../core/command-center/server/health-classify";

describe("hook drop categories", () => {
  const cases: [string, ReturnType<typeof classifyDrop>][] = [
    ["audit lock contended; REVIEW_FREEZE_BLOCKED row dropped (block still enforced)", "audit-write-lost"],
    ["SENSOR_FAILED row not recorded", "audit-write-lost"],
    ["Audit emission failed: disk full", "audit-write-lost"],
    ["active-directive lock contended while reading Copilot Stop evidence; allowing stop", "lock-contention"],
    ["reviewer dispatch record is malformed; enforcement skipped", "enforcement-skipped"],
    ["subagent touched construction/ paths with no reviewer dispatch record; enforcement skipped (write the dispatch record)", "enforcement-skipped"],
    ["state file unreadable", "unreadable"],
    ["ENOENT: no such file or directory, open '/x/y'", "unreadable"],
    ["background-subagent in-flight ledger is malformed; refusing the pending-subagent carve-out", "unreadable"],
    ["ignoring an orphaned reviewer dispatch record (older than the freshness window); cleaned it up", "orphan-cleaned"],
    ["pruned 2 orphaned background-subagent in-flight entries before evaluating the pending-subagent carve-out", "orphan-cleaned"],
    ["type-check: dispatcher exit 2: boom", "subprocess"],
    ["linter: subprocess killed by SIGTERM (timeout)", "subprocess"],
    ["traceability sensor timed out after 30s", "subprocess"],
    ["sensor linter could not start", "subprocess"],
    ["compile exit 1: syntax", "subprocess"],
    ["recursion guard released the stop (no-progress block cap 8 reached; stop_hook_active=true)", "stop-released"],
    ["engine next returned no parseable directive; allowing stop", "engine-probe"],
    ["unknown engine directive kind 'zap'", "engine-probe"],
    ["active stage x has an unanswered question; allowing the stop (pending-question carve-out)", "by-design"],
    ["allowing stop at the exact post-create fresh-session handoff boundary", "by-design"],
    ["TypeError: Cannot read properties of undefined (reading 'stage')", "internal-error"],
    ["something nobody anticipated", "other"],
  ];
  for (const [reason, cat] of cases) test(`${cat} ← ${reason.slice(0, 48)}`, () => expect(classifyDrop(reason)).toBe(cat));

  test("parseDrops keeps the timestamp, the verbatim reason and the 1-based line", () => {
    const d = parseDrops("2026-10-01T10:00:00Z\tfirst reason\n\nnot-a-date second\n2026-10-01T11:00:00Z\tthird\twith tab\n");
    expect(d).toEqual([
      { at: "2026-10-01T10:00:00Z", reason: "first reason", line: 1 },
      { at: null, reason: "not-a-date second", line: 3 },
      { at: "2026-10-01T11:00:00Z", reason: "third\twith tab", line: 4 },
    ]);
  });
});

describe("ERROR_LOGGED markers", () => {
  const guardJson = (o: object) => `Refused.\n${JSON.stringify({ kind: "ask", ask_type: "guard-recovery", response_route: "execute-remedy", question: "How to proceed?", stage: "code-generation", reason_codes: ["REVIEW_BUDGET_SPENT"], ...o })}`;
  test("typed guard refusal: remedies parsed, recoverable, AIDLC remedy text", () => {
    const c = classifyError({ Error: guardJson({ remedies: [{ op: "rerun-review", action: "Run the review again", command: "aidlc review run", requiresHuman: false, executableNow: true }] }) });
    expect(c.kind).toBe("Guard refusal");
    expect(c.group).toBe("refused");
    expect(c.recoverable).toBe("yes");
    expect(c.terminal).toBe(false);
    expect(c.fix).toEqual({ text: "Run the review again (aidlc review run)", source: "aidlc" });
    expect(c.detail).toContain("REVIEW_BUDGET_SPENT");
  });
  test("typed guard refusal with state_signature and no remedies is terminal and needs a person", () => {
    const c = classifyError({ Error: guardJson({ remedies: [], state_signature: "abc" }) });
    expect(c.terminal).toBe(true);
    expect(c.recoverable).toBe("needs-you");
    expect(c.fix?.source).toBe("hint");
  });
  test("a remedy that requires a human needs you", () => {
    const c = classifyError({ Error: guardJson({ remedies: [{ op: "x", action: "Approve the plan", requiresHuman: true, executableNow: false }] }) });
    expect(c.recoverable).toBe("needs-you");
  });
  test("parseGuardAsk ignores malformed or foreign JSON lines", () => {
    expect(parseGuardAsk("Refused.\n{not json")).toBeNull();
    expect(parseGuardAsk('{"kind":"ask","ask_type":"other"}')).toBeNull();
  });
  test("error-directive → engine refusal at a turn end", () => {
    const c = classifyError({ Error: "Stage is not active", Source: "error-directive", "Observed By": "aidlc-continue-workflow" });
    expect(c.kind).toBe("Engine refusal"); expect(c.group).toBe("refused"); expect(c.recoverable).toBe("needs-you");
  });
  test("merge-succeeded / Do not retry → needs a person", () => {
    for (const e of ["post-merge step failed [merge-succeeded:abc123]", "Recording failed. Do not retry."]) {
      const c = classifyError({ Error: e }); expect(c.group).toBe("failure"); expect(c.recoverable).toBe("needs-you");
    }
  });
  test("errno and JS error text, audit emission failure and timeouts → internal error", () => {
    for (const e of ["ENOENT: no such file or directory, open '/a'", "EACCES: permission denied", "EPERM: x", "EEXIST: y", "EBUSY: z",
      "TypeError: x is not a function", "Cannot read properties of undefined (reading 'a')", "JSON Parse error: Unexpected EOF", "Unexpected token } in JSON",
      "Audit emission failed: lock", "command timed out after 60s"]) {
      const c = classifyError({ Error: e }); expect(c.kind).toBe("Internal error"); expect(c.group).toBe("failure");
    }
    expect(classifyError({ Error: "command timed out after 60s" }).recoverable).toBe("yes");
    expect(classifyError({ Error: "ENOENT: no such file" }).recoverable).toBe("needs-you");
  });
  test("an errno prefix wins over a refusal sentence", () => {
    expect(classifyError({ Error: "Cannot open plan. ENOENT: no such file" }).kind).toBe("Internal error");
  });
  test("usage errors → command misuse, refused correctly", () => {
    for (const e of ["Usage: aidlc state set <k> <v>", "Missing --stage", "Invalid --unit value", "Unknown subcommand zap", "report requires --stage"]) {
      const c = classifyError({ Error: e }); expect(c.kind).toBe("Command misuse"); expect(c.group).toBe("refused"); expect(c.recoverable).toBe("yes");
    }
  });
  test("full-sentence refusals → refused correctly", () => {
    for (const e of ["Refusing to advance: the gate is open.", "Cannot report a stage that has not started.", "Writing state directly is refused."]) {
      const c = classifyError({ Error: e }); expect(c.kind).toBe("Refused"); expect(c.group).toBe("refused");
    }
  });
  test("anything else is an unclassified error, never a guess at a fix", () => {
    const c = classifyError({ Error: "the thing happened" });
    expect(c.kind).toBe("Error (unclassified)"); expect(c.group).toBe("failure"); expect(c.fix).toBeNull();
  });
});

describe("sensors, checkpoints, refusals, recovery, stop counter", () => {
  test("SENSOR_PASSED with a Note did not run; without one it passed", () => {
    expect(sensorNotRun({ Note: "tool-unavailable" })).toBe("tool-unavailable");
    expect(sensorNotRun({ Note: "script-error: boom" })).toBe("script-error: boom");
    expect(sensorNotRun({ Note: "  " })).toBeNull();
    expect(sensorNotRun({})).toBeNull();
  });
  test("checkpoint states", () => {
    expect(checkpointState({ version: 4, finished_at: null, started_at: "x" })).toBe("crashed");
    expect(checkpointState({ version: 4, finished_at: "y", verified: false, exit_code: 1 })).toBe("failed");
    expect(checkpointState({ version: 4, finished_at: "y", verified: false, exit_code: 0, error: "CHECK_KEPT_CHANGING" })).toBe("non-idempotent");
    expect(checkpointState({ version: 4, finished_at: "y", verified: true, exit_code: 0 })).toBe("ok");
    expect(checkpointState({ version: 4, finished_at: "y", verified: false, exit_code: 0 })).toBe("unknown");
    expect(checkpointState("nope")).toBe("unknown");
  });
  test("guard-refusal records: terminal past the cap with no executable remedy; human remedy needs you", () => {
    const rec = (count: number, remedies: object[]) => ({ version: 1, count, codes: ["X"], refusal: { code: "X", blockedAction: "a", stage: "s", userMessage: "m", remedies } });
    expect(guardRefusalState(rec(3, [{ action: "Ask", requiresHuman: true, executableNow: false }]))).toBe("terminal");
    expect(guardRefusalState(rec(3, []))).toBe("terminal");
    expect(guardRefusalState(rec(3, [{ action: "Run", requiresHuman: false, executableNow: true }]))).toBe("recoverable");
    expect(guardRefusalState(rec(1, [{ action: "Ask", requiresHuman: true, executableNow: false }]))).toBe("needs-human");
    expect(guardRefusalState(rec(1, [{ action: "Run", requiresHuman: false, executableNow: true }]))).toBe("recoverable");
    expect(guardRefusalState({ count: "x" })).toBeNull();
  });
  test("recovery.md: only the INVALID line is a failure", () => {
    expect(recoveryInvalid("# AIDLC Recovery\n**State file**: valid (all sections present)\n")).toBeNull();
    expect(recoveryInvalid("# AIDLC Recovery\n**State file**: INVALID — missing sections: Stage Progress, Current Status\n")).toBe("INVALID — missing sections: Stage Progress, Current Status");
  });
  test("stop counter: at or over the autonomous cap is a stalled run; interactive never is", () => {
    expect(stopCounterStalled({ signature: "s", count: 8 }, true)).toEqual({ count: 8, cap: 8 });
    expect(stopCounterStalled({ signature: "s", count: 7 }, true)).toBeNull();
    expect(stopCounterStalled({ signature: "s", count: 2 }, false)).toBeNull();
    expect(stopCounterStalled({ count: "x" }, true)).toBeNull();
  });
});

describe("heartbeats", () => {
  const H = (m: number) => new Date(Date.UTC(2026, 9, 1, 12, m)).toISOString().replace(/\.\d+Z$/, "Z");
  test("ok when the newest heartbeat is within 5 min of the newest STAGE/GATE row", () => {
    const r = heartbeatStates({ "write-audit-log": H(58), "session-start": H(10) }, H(60), true);
    expect(r.record).toBe("ok");
    expect(r.hooks["write-audit-log"]).toBe("ok");
  });
  test("stale when the newest heartbeat is more than 5 min older", () => {
    const r = heartbeatStates({ "write-audit-log": H(50), "session-start": H(10) }, H(60), true);
    expect(r.record).toBe("stale");
    expect(r.hooks["write-audit-log"]).toBe("stale");
    expect(r.newest).toBe(H(50));
  });
  test("never when no heartbeat exists but the workflow has STAGE/GATE rows; fine before any progress", () => {
    expect(heartbeatStates({}, H(60), true).record).toBe("never");
    expect(heartbeatStates({}, null, true).record).toBe("ok");
  });
  test("frozen when a hook's heartbeat is more than 24 h older than the newest STAGE/GATE row", () => {
    const r = heartbeatStates({ "write-audit-log": "2026-10-02T12:00:00Z", "session-end": "2026-09-30T11:00:00Z" }, "2026-10-02T12:01:00Z", true);
    expect(r.record).toBe("ok");
    expect(r.hooks["session-end"]).toBe("frozen");
  });
});
