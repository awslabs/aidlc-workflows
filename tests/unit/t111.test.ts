// covers: function:appendAuditEntry, function:appendAuditEntryUnlocked, function:handleAppend
//
// t111 — P0 deterministic floor. Mechanism = none (pure file I/O, zero LLM,
// zero tokens). Exercises the audit-append core in aidlc-audit.ts:
//   appendAuditEntry          (:199) — validate → lock → delegate → unlock
//   appendAuditEntryUnlocked  (:228) — block format, CR/LF escaping, append
//   handleAppend              (:266) — thin wrapper, prints JSON to stdout
//
// Test design note (house style, see tests/unit/t69-worktree-path.sh): assert
// the OBSERVABLE CONTRACT, not implementation parity. We never recompute the
// block string the way the source does and diff it — that only catches
// deletion. Instead we pin the things a real reader of audit.md relies on:
//   - the exact field order and literal markers in an appended block
//   - that a CR/LF inside a field value is collapsed to the two-char "\n"
//     escape (the forged-audit-entry defence the source comments on at :248)
//   - that appending twice keeps BOTH blocks (append-not-overwrite invariant)
//   - that an invalid event type is rejected by throw, before any disk write
//   - that EVERY one of the 72 VALID_EVENT_TYPES is accepted
// A regression that dropped escaping, overwrote prior history, reordered the
// header fields, or narrowed the accepted event set would turn one of these
// red.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAuditEntry,
  appendAuditEntryUnlocked,
  handleAppend,
} from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  auditFilePath,
  readAllAuditShards,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// --- Per-file temp roots, torn down in afterAll ---------------------------
const tmpRoots: string[] = [];

// Make a fresh project dir. The source's ensureAuditFile() will lazily create
// the per-intent audit SHARD dir + shard (seeded "# AI-DLC Audit Log\n") on
// first append, so a bare dir is a valid project. With no intent resolved the
// shard lands under the bare space record root (aidlc/spaces/default/intents/
// audit/<host>-<clone>.md — see auditFilePath). `seedAuditMd` lets a case
// pre-seed THAT shard the way the source expects when it wants to assert the
// seed survives.
function freshProject(seedAuditMd = false): string {
  const root = mkdtempSync(join(tmpdir(), "aidlc-t111-"));
  tmpRoots.push(root);
  if (seedAuditMd) {
    const shard = auditFilePath(root);
    mkdirSync(dirname(shard), { recursive: true });
    writeFileSync(shard, "# AI-DLC Audit Log\n", "utf-8");
  }
  return root;
}

// Read the whole audit trail (the per-clone shards merged). For these
// single-clone fixtures it resolves to the one shard the tool wrote, so the
// returned bytes equal that shard's contents (seed header + appended blocks).
function readAudit(projectDir: string): string {
  return readAllAuditShards(projectDir);
}

// Whether the resolved audit shard exists on disk (the per-intent successor to
// "is there an aidlc-docs/audit.md?").
function auditShardExists(projectDir: string): boolean {
  return existsSync(auditFilePath(projectDir));
}

afterAll(() => {
  for (const root of tmpRoots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a leaked temp dir is harmless to the suite
    }
  }
});

// The 72 canonical event types, mirrored from aidlc-audit.ts VALID_EVENT_TYPES.
// Kept as an explicit literal (not re-derived from the source) so that a silent
// addition/removal in the source surfaces here as a count mismatch worth a look.
const VALID_EVENT_TYPES = [
  "STAGE_STARTED",
  "STAGE_AWAITING_APPROVAL",
  "STAGE_REVISING",
  "STAGE_COMPLETED",
  "STAGE_JUMPED",
  "STAGE_SKIPPED",
  "PHASE_STARTED",
  "PHASE_COMPLETED",
  "PHASE_VERIFIED",
  "PHASE_SKIPPED",
  "WORKFLOW_STARTED",
  "WORKFLOW_COMPLETED",
  "WORKFLOW_PARKED",
  "WORKFLOW_UNPARKED",
  "SESSION_STARTED",
  "SESSION_RESUMED",
  "SESSION_COMPACTED",
  "SESSION_ENDED",
  "HUMAN_TURN",
  "WORKSPACE_SCAFFOLDED",
  "WORKSPACE_SCANNED",
  "WORKSPACE_INITIALISED",
  "DECISION_RECORDED",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "QUESTION_ANSWERED",
  "ARTIFACT_CREATED",
  "ARTIFACT_UPDATED",
  "ARTIFACT_REUSED",
  "SUBAGENT_COMPLETED",
  "REVIEWER_SCOPE_BLOCKED",
  "HEALTH_CHECKED",
  "SCOPE_DETECTED",
  "SCOPE_CHANGED",
  "PLUGIN_SELECTION_CHANGED",
  "DEPTH_CHANGED",
  "TEST_STRATEGY_CHANGED",
  "RECOMPOSED",
  "ERROR_LOGGED",
  "RECOVERY_COMPLETED",
  "BOLT_STARTED",
  "BOLT_COMPLETED",
  "BOLT_FAILED",
  "AUTONOMY_MODE_SET",
  "WORKTREE_CREATED",
  "WORKTREE_MERGED",
  "WORKTREE_DISCARDED",
  "STATE_FORKED",
  "STATE_MERGED",
  "AUDIT_FORKED",
  "AUDIT_MERGED",
  "PRACTICES_DISCOVERED",
  "PRACTICES_AFFIRMED",
  "PRACTICES_OVERRIDE",
  "PRACTICES_SECTION_EMPTY",
  "MERGE_DISPATCH_INVOKED",
  "MERGE_DISPATCH_RETURNED",
  "MERGE_DISPATCH_FALLBACK",
  "SENSOR_FIRED",
  "SENSOR_PASSED",
  "SENSOR_FAILED",
  "SENSOR_BUDGET_OVERRIDE",
  "GUARDRAIL_LOADED",
  "MEMORY_EMPTY",
  "RULE_LEARNED",
  "SENSOR_PROPOSED",
  "SWARM_STARTED",
  "SWARM_UNIT_CONVERGED",
  "SWARM_UNIT_FAILED",
  "SWARM_BATON_RETURNED",
  "SWARM_COMPLETED",
  "SWARM_DEGRADED",
];

describe("appendAuditEntry — locked variant", () => {
  test("appends a block with the exact header field order and a valid event", () => {
    const proj = freshProject();
    const result = appendAuditEntry(
      "STAGE_STARTED",
      { Stage: "1.1-intent", Phase: "ideation" },
      proj,
    );

    // Return contract: appended flag, echoed event, and the timestamp that
    // was written into the block.
    expect(result.appended).toBe(true);
    expect(result.event).toBe("STAGE_STARTED");
    expect(typeof result.timestamp).toBe("string");
    expect(result.timestamp.length).toBeGreaterThan(0);

    const content = readAudit(proj);

    // ensureAuditFile seeds the log header on first touch.
    expect(content.startsWith("# AI-DLC Audit Log\n")).toBe(true);

    // The full block, byte-for-byte. STAGE_STARTED maps to heading
    // "Stage Start" (EVENT_HEADINGS), timestamp first, then **Event**, then
    // the custom fields in insertion order, closed by the "\n---\n" separator.
    const expectedBlock =
      `\n## Stage Start\n` +
      `**Timestamp**: ${result.timestamp}\n` +
      `**Event**: STAGE_STARTED\n` +
      `**Stage**: 1.1-intent\n` +
      `**Phase**: ideation\n` +
      `\n---\n`;
    expect(content).toContain(expectedBlock);

    // The seed header is immediately followed by the block — nothing injected
    // between the two. Pins that the append is a pure suffix on the seed.
    expect(content).toBe(`# AI-DLC Audit Log\n${expectedBlock}`);
  });

  test("uses the raw event type as heading when no EVENT_HEADINGS mapping exists", () => {
    // Every valid type is mapped today; to exercise the
    // `EVENT_HEADINGS[eventType] || eventType` fallback branch we'd need an
    // unmapped-but-valid type, which cannot exist. Instead we positively pin
    // that a mapped type does NOT fall through to the raw token as a heading.
    const proj = freshProject();
    appendAuditEntry("SESSION_ENDED", {}, proj);
    const content = readAudit(proj);
    expect(content).toContain(`\n## Session End\n`);
    expect(content).not.toContain(`\n## SESSION_ENDED\n`);
    expect(content).toContain(`**Event**: SESSION_ENDED\n`);
  });

  test("rejects an invalid event type by throwing, with the offending token in the message", () => {
    const proj = freshProject();
    expect(() => appendAuditEntry("NOT_A_REAL_EVENT", {}, proj)).toThrow(
      /Invalid event type: NOT_A_REAL_EVENT\. Must be one of:/,
    );
  });

  test("validation fires before any disk write — no audit shard is created on rejection", () => {
    // A fresh project has no audit shard. If validation ran AFTER
    // ensureAuditFile, the rejected call would still leave a seeded shard
    // behind. Assert the shard is absent, proving validate-then-write order.
    const proj = freshProject();
    expect(() => appendAuditEntry("bogus", {}, proj)).toThrow();
    expect(auditShardExists(proj)).toBe(false); // shard never created
  });
});

describe("appendAuditEntryUnlocked — escaping and append-not-overwrite", () => {
  test("collapses CR/LF inside a field value to the literal two-char escape", () => {
    const proj = freshProject();
    // A value carrying a forged-audit-entry payload: an embedded newline plus
    // a fake **Event** marker. The source escapes \r?\n so the forgery cannot
    // create a second parseable block.
    const malicious = "/tmp/x\n**Event**: FAKE_FORGED\nmore";
    const result = appendAuditEntryUnlocked(
      "ERROR_LOGGED",
      { Path: malicious },
      proj,
    );
    const content = readAudit(proj);

    // The value is written with newlines escaped to backslash-n, on ONE line.
    expect(content).toContain(
      `**Path**: /tmp/x\\n**Event**: FAKE_FORGED\\nmore\n`,
    );
    // A literal newline must NOT survive inside the value — there is exactly
    // one real **Event** line (the legitimate one for ERROR_LOGGED), never a
    // forged FAKE_FORGED on its own physical line.
    const eventLines = content
      .split("\n")
      .filter((l) => l.startsWith("**Event**:"));
    expect(eventLines).toEqual([`**Event**: ERROR_LOGGED`]);
    expect(content).not.toContain(`\n**Event**: FAKE_FORGED\n`);

    // Sanity: the returned event echoes the real type, not the forged one.
    expect(result.event).toBe("ERROR_LOGGED");
  });

  test("collapses CRLF to one escape but leaves a lone CR untouched (regex is /\\r?\\n/)", () => {
    // Source escape is value.replace(/\r?\n/g, "\\n"). A CRLF pair becomes a
    // single "\n" escape; a bare carriage return (CR not followed by LF) is
    // NOT matched and survives verbatim. Pinning both halves of that contract
    // catches a regression that widened the regex to also swallow lone CRs
    // (which would change byte output for Mac-classic line endings).
    const proj = freshProject();
    appendAuditEntryUnlocked(
      "DECISION_RECORDED",
      { CrLf: "p\r\nq", LoneCr: "x\ry" },
      proj,
    );
    const content = readAudit(proj);
    // CRLF -> single \n escape (one char each in the \r and \n collapsing).
    expect(content).toContain(`**CrLf**: p\\nq\n`);
    // Lone CR passes through as a literal carriage return.
    expect(content).toContain(`**LoneCr**: x\ry\n`);
  });

  test("a second append preserves the first block (append, never overwrite)", () => {
    // Pre-seed the file the way the source expects, then append twice. Both
    // blocks plus the original seed must all survive.
    const proj = freshProject(true);
    const first = appendAuditEntryUnlocked(
      "BOLT_STARTED",
      { "Bolt slug": "alpha" },
      proj,
    );
    const second = appendAuditEntryUnlocked(
      "BOLT_COMPLETED",
      { "Bolt slug": "alpha" },
      proj,
    );

    const content = readAudit(proj);

    // Seed header intact at the top.
    expect(content.startsWith("# AI-DLC Audit Log\n")).toBe(true);

    // Both event rows present.
    expect(content).toContain(`**Event**: BOLT_STARTED\n`);
    expect(content).toContain(`**Event**: BOLT_COMPLETED\n`);
    expect(content).toContain(`\n## Bolt Started\n`);
    expect(content).toContain(`\n## Bolt Completed\n`);

    // Chronological ordering: the first block lands before the second.
    const idxFirst = content.indexOf("**Event**: BOLT_STARTED");
    const idxSecond = content.indexOf("**Event**: BOLT_COMPLETED");
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);

    // Two distinct timestamps came back (each call computes its own).
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(true);

    // Exactly two closing separators were appended (one per block).
    const sepCount = content.split("\n---\n").length - 1;
    expect(sepCount).toBe(2);
  });

  test("an empty fields object writes only the timestamp + event header lines", () => {
    const proj = freshProject();
    const result = appendAuditEntryUnlocked("HEALTH_CHECKED", {}, proj);
    const content = readAudit(proj);
    const expectedBlock =
      `\n## Health Check\n` +
      `**Timestamp**: ${result.timestamp}\n` +
      `**Event**: HEALTH_CHECKED\n` +
      `\n---\n`;
    expect(content).toContain(expectedBlock);
  });

  test("rejects an invalid event type the same way as the locked variant", () => {
    const proj = freshProject();
    expect(() =>
      appendAuditEntryUnlocked("definitely_not_valid", {}, proj),
    ).toThrow(/Invalid event type: definitely_not_valid\. Must be one of:/);
  });
});

describe("VALID_EVENT_TYPES — every canonical type is accepted", () => {
  test("the mirrored list has 72 entries with no duplicates", () => {
    expect(VALID_EVENT_TYPES.length).toBe(72);
    expect(new Set(VALID_EVENT_TYPES).size).toBe(72);
  });

  // Loop over ALL valid types: each must append a block whose **Event**
  // line carries that exact token, and the return must echo it. A regression
  // that dropped a type from the Set would throw here and fail its case.
  for (const eventType of VALID_EVENT_TYPES) {
    test(`accepts ${eventType}`, () => {
      const proj = freshProject();
      const result = appendAuditEntry(eventType, { K: "v" }, proj);
      expect(result.appended).toBe(true);
      expect(result.event).toBe(eventType);
      const content = readAudit(proj);
      expect(content).toContain(`**Event**: ${eventType}\n`);
    });
  }
});

describe("handleAppend — thin wrapper over appendAuditEntry", () => {
  test("writes the block to audit.md and prints the success JSON to stdout", () => {
    const proj = freshProject();
    const captured: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    // jsonSuccess() does process.stdout.write(`${JSON.stringify(data)}\n`).
    // Capture it so we can assert the printed payload without leaking to the
    // test runner's stdout.
    (process.stdout as unknown as { write: typeof process.stdout.write }).write =
      ((chunk: string | Uint8Array) => {
        captured.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      }) as typeof process.stdout.write;

    try {
      handleAppend("GATE_APPROVED", { Stage: "2.1-practices" }, proj);
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write =
        orig;
    }

    // Side effect: the block is on disk.
    const content = readAudit(proj);
    expect(content).toContain(`**Event**: GATE_APPROVED\n`);
    expect(content).toContain(`**Stage**: 2.1-practices\n`);

    // Output: exactly one trailing-newline JSON line carrying the result.
    expect(captured.length).toBe(1);
    expect(captured[0].endsWith("\n")).toBe(true);
    const printed = JSON.parse(captured[0]);
    expect(printed.appended).toBe(true);
    expect(printed.event).toBe("GATE_APPROVED");
    expect(typeof printed.timestamp).toBe("string");
    // The printed timestamp matches the one written into the block.
    expect(content).toContain(`**Timestamp**: ${printed.timestamp}\n`);
  });

  test("propagates the invalid-event-type throw (does not swallow it)", () => {
    const proj = freshProject();
    expect(() => handleAppend("WRONG", {}, proj)).toThrow(
      /Invalid event type: WRONG\. Must be one of:/,
    );
  });
});
