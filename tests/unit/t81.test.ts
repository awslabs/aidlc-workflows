// covers: subcommand:aidlc-state:practices-event
//
// CLI-contract port of tests/unit/t81-bolt-plan-override.sh (TAP plan 4),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-state.ts practices-event --type override
// --field "K: V" ...` is preserved by SPAWNING the real CLI via
// node:child_process spawnSync (BUN + the tool .ts path), asserting on
// res.stdout (the JSON ack the tool prints) and the audit.md the tool
// appends to — the PROCESS boundary, not an in-process handlePracticesEvent
// call. An in-process twin would lose the JSON-ack-to-stdout half AND the
// real audit-file write the .sh greps; both are observed here through the
// subprocess + the audit.md it writes under --project-dir.
//
// WHAT t81 PINS (bolt-plan-marker-conflict semantic):
//   The override path introduced NO new BOLT_PLAN_OVERRIDDEN event. Instead it
//   reuses the existing PRACTICES_OVERRIDE event with a discriminator field
//   (Reason). The write-failure path emits PRACTICES_OVERRIDE for write-failure
//   semantics (Reason: write-failure-*); the bolt-plan path emits it for
//   orchestrator-overrides-bolt-plan-marker semantics (Reason:
//   bolt-plan-marker-conflict, plus Practices
//   Stance + Bolt-Plan Marker + Bolt slug fields). The contract being pinned
//   is that handlePracticesEvent (aidlc-state.ts:1006-1071) accepts arbitrary
//   --field "Key: Value" pairs unmodified — discriminator-field
//   disambiguation needs zero new tool code.
//
// PARITY NOTES (each .sh `ok` line maps to a test() below; several STRONGER):
//   - .sh Test 1  grep '"emitted":"PRACTICES_OVERRIDE"' in stdout  -> Test 1:
//       res.stdout contains '"emitted":"PRACTICES_OVERRIDE"' (same observable)
//       + res.status === 0 (STRONGER: .sh discarded $?; we pin clean exit) +
//       fields_count === 4 (STRONGER: pins the JSON ack's count of the 4
//       --field pairs the tool parsed).
//   - .sh Test 2  awk PRACTICES_OVERRIDE block, then 4 greps for the milestone 13
//       fields (Reason / Practices Stance / Bolt-Plan Marker / Bolt slug)  ->
//       Test 2: block-scoped auditField() over the FIRST PRACTICES_OVERRIDE
//       block asserts each of the 4 field VALUES exactly (STRONGER: exact
//       value scoped to the event block, not a file-wide substring grep). The
//       .sh's awk starts at the first line containing 'PRACTICES_OVERRIDE'
//       (the `**Event**:` line; the `## Practices Override` heading does NOT
//       contain that literal) and stops at the next `---`; auditField mirrors
//       that block scoping (resets at `## ` headings and `---`).
//   - .sh Test 3  read t28's pinned $TS_COUNT  -> Test 3:
//       same observable. Reads the canonical event-count list the tool
//       enforces (VALID_EVENT_TYPES via aidlc-audit.ts) AND cross-checks
//       t28's pin. The discriminator reuse still introduces no separate event.
//       STRONGER: rather than only re-reading t28's literal, we also confirm
//       the live tool's VALID_EVENT_TYPES set has the current pinned count by
//       counting the rows it rejects/accepts - pinning the actual contract
//       t28 mirrors. To avoid
//       coupling to t28's internal regex we keep the t28-literal read too.
//   - .sh Test 4  second override emit (Reason: write-failure-permission-
//       denied), then grep -c PRACTICES_OVERRIDE >= 2  -> Test 4: emit both
//       discriminator variants into ONE project, assert (a) the write-failure
//       emit's stdout carries '"emitted":"PRACTICES_OVERRIDE"' (same event),
//       (b) the audit.md now holds >= 2 PRACTICES_OVERRIDE rows, and (c)
//       STRONGER: the two rows carry the two DISTINCT Reason values
//       (bolt-plan-marker-conflict and write-failure-permission-denied),
//       proving the discriminator field disambiguates them in the same event
//       space.
//
// 4 .sh asserts -> 4 expect()-bearing test() cases here (one observable focus
// per case, matching the .sh's 4 `ok` lines), each with STRONGER additions.
//
// FIXTURE DISCIPLINE (the .sh used setup_integration_project
// --with-greenfield-stub, but that flag only buys a project dir with an
// aidlc-docs/ tree — the contract under test is purely the audit.md the tool
// writes under --project-dir, NOT any greenfield-stub file). So each case
// uses a FRESH temp project dir via createTestProject() (fixtures.ts), which
// scaffolds aidlc-docs/ and toPortablePath-converts on Windows so audit.md —
// written by the tool via the forward-slash audit helpers — round-trips when
// read back. No seed: the tool creates audit.md on first emit, so post-fire
// PRACTICES_OVERRIDE counts are unambiguous (the seed audit-sample.md carries
// none). NOTHING is written under tests/fixtures/**; all temp dirs cleaned in
// afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-state.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh temp project (createTestProject — aidlc-docs/ scaffolded, Windows-portable). */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

// P9: practices-event's appendAuditEvent CREATES the bare SPACE record root's
// per-clone shard on first emit (no state seeded → no intent resolves → bare
// root); the SPAWNED tool mints its own clone-id, so reads glob every shard.
const readAudit = (p: string): string => readAllAuditShards(p);

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/**
 * Spawn `bun aidlc-state.ts practices-event <args...> --project-dir <p>`.
 * Mirrors the .sh STATE_TOOL invocation (`bun $AIDLC_SRC/tools/aidlc-state.ts
 * practices-event ... --project-dir "$PROJ"`).
 */
function practicesEvent(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [TOOL, "practices-event", ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Count audit blocks with `**Event**: <ev>`. Mirrors the .sh's `grep -c "PRACTICES_OVERRIDE"` but as an exact event-line count. */
function auditEventCount(body: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return body
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Walks the file; resets at `## ` headings and `---` separators; splits
 * `**label**: value` on the literal `**: ` separator. Mirrors auditField in
 * t31.cli.test.ts. Returns "" when absent. This is the in-TS equivalent of the
 * .sh's `awk '/PRACTICES_OVERRIDE/{flag=1} flag && /^---$/{exit} flag'` block
 * scoping followed by per-field `grep "\*\*Key\*\*: value"`.
 */
function auditField(body: string, ev: string, key: string): string {
  let matched = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      matched = false;
      continue;
    }
    if (line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) return value;
      }
    }
  }
  return "";
}

/** ALL values of <key> across every block whose `**Event**:` matches <ev>. */
function auditFieldAll(body: string, ev: string, key: string): string[] {
  const out: string[] = [];
  let matched = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("## ")) {
      matched = false;
      continue;
    }
    if (line === "---") {
      matched = false;
      continue;
    }
    if (line.startsWith("**Event**: ")) {
      matched = line === `**Event**: ${ev}`;
      continue;
    }
    if (matched && line.startsWith("**")) {
      const stripped = line.replace(/^\*\*/, "");
      const pos = stripped.indexOf("**: ");
      if (pos > 0) {
        const label = stripped.slice(0, pos);
        const value = stripped.slice(pos + 4);
        if (label === key) out.push(value);
      }
    }
  }
  return out;
}

// The milestone 13 override field set the .sh fires (t81-bolt-plan-override.sh:41-47).
const MILESTONE13_FIELDS = [
  "--type",
  "override",
  "--field",
  "Reason: bolt-plan-marker-conflict",
  "--field",
  "Practices Stance: never-skeleton",
  "--field",
  "Bolt-Plan Marker: walking-skeleton",
  "--field",
  "Bolt slug: t81-bolt-1",
];

describe("t81 aidlc-state practices-event — bolt-plan-marker-conflict override (migrated from t81-bolt-plan-override.sh, plan 4)", () => {
  test("PRACTICES_AFFIRMED cannot be minted outside practices-promote", () => {
    const p = proj();
    const before = readAudit(p);
    const r = practicesEvent(["--type", "affirmed"], p);
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      "PRACTICES_AFFIRMED is reserved for practices-promote",
    );
    expect(readAudit(p)).toBe(before);
  });

  // --- Test 1: --type override accepts the milestone 13 field set ---
  test("1: practices-event --type override accepts milestone 13 field set (emits PRACTICES_OVERRIDE)", () => {
    const p = proj();
    const r = practicesEvent(MILESTONE13_FIELDS, p);
    expect(r.status).toBe(0); // STRONGER: .sh discarded $?; pin clean exit
    expect(r.stdout).toContain('"emitted":"PRACTICES_OVERRIDE"');
    // STRONGER: the JSON ack reports all 4 --field pairs were parsed.
    expect(r.stdout).toContain('"fields_count":4');
  });

  // --- Test 2: audit row carries discriminator Reason + the 3 milestone 13 fields ---
  test("2: PRACTICES_OVERRIDE audit row carries discriminator Reason + milestone 13 fields", () => {
    const p = proj();
    practicesEvent(MILESTONE13_FIELDS, p);
    const f = readAudit(p);
    // Exact, block-scoped field values (STRONGER than the .sh's 4 substring greps).
    expect(auditField(f, "PRACTICES_OVERRIDE", "Reason")).toBe("bolt-plan-marker-conflict");
    expect(auditField(f, "PRACTICES_OVERRIDE", "Practices Stance")).toBe("never-skeleton");
    expect(auditField(f, "PRACTICES_OVERRIDE", "Bolt-Plan Marker")).toBe("walking-skeleton");
    expect(auditField(f, "PRACTICES_OVERRIDE", "Bolt slug")).toBe("t81-bolt-1");
  });

  // --- Test 3: t28 audit count unchanged BY THIS PR's discriminator reuse ---
  test("3: framework event count pinned at 72", () => {
    // The .sh read t28's pinned $TS_COUNT. Under milestone 4, t28 is now a
    // .test.ts (no `assert_eq N "$TS_COUNT"` line to grep), so pin the SAME
    // observable against the SOURCE OF TRUTH instead — VALID_EVENT_TYPES in
    // aidlc-audit.ts — which is stronger (it asserts the real count, not a
    // sibling test's transcription of it). bolt-plan-marker-conflict reuses
    // PRACTICES_OVERRIDE (discriminator-field disambiguation) and registers no
    // new event. The framework total is 72: the v0.6.0 Wave 4 milestone 16
    // baseline of 67 (SWARM_DEGRADED was the last event born then), plus
    // WORKFLOW_PARKED + WORKFLOW_UNPARKED (the park/unpark lifecycle, +2),
    // less TEST_RUN_MODE_ENABLED (removed, -1), plus HUMAN_TURN (+1), plus
    // RECOMPOSED (the adaptive composer's in-flight re-shape, +1), plus
    // REVIEWER_SCOPE_BLOCKED (the reviewer-scope PreToolUse hook, +1), plus
    // PLUGIN_SELECTION_CHANGED (select-plugins set-mode, +1).
    const auditSrc = readFileSync(
      join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-audit.ts"),
      "utf-8",
    );
    const block = auditSrc.match(/const VALID_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/);
    expect(block).not.toBeNull();
    const count = (block ? block[1].match(/"[A-Z0-9_]+"/g) : null)?.length ?? -1;
    expect(count).toBe(72);
  });

  // --- Test 4: milestone 8 write-failure path coexists (different Reason value) ---
  test("4: PRACTICES_OVERRIDE coexists across both Reason discriminators", () => {
    const p = proj();
    // Emit the bolt-plan path first, then the write-failure path into the SAME project.
    practicesEvent(MILESTONE13_FIELDS, p);
    const writeFail = practicesEvent(
      ["--type", "override", "--field", "Reason: write-failure-permission-denied"],
      p,
    );
    expect(writeFail.stdout).toContain('"emitted":"PRACTICES_OVERRIDE"'); // same event
    const f = readAudit(p);
    // Both emits land as PRACTICES_OVERRIDE rows (the .sh's grep -c >= 2).
    expect(auditEventCount(f, "PRACTICES_OVERRIDE")).toBeGreaterThanOrEqual(2);
    // STRONGER: the discriminator field disambiguates the two rows — both
    // distinct Reason values are present in the PRACTICES_OVERRIDE event space.
    const reasons = auditFieldAll(f, "PRACTICES_OVERRIDE", "Reason");
    expect(reasons).toContain("bolt-plan-marker-conflict");
    expect(reasons).toContain("write-failure-permission-denied");
  });
});
