// covers: subcommand:aidlc-state:practices-event
//
// Mechanism = cli. The tests spawn `bun aidlc-state.ts practices-event --type
// override --field "K: V" ...`, the real CLI, via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.stdout (the JSON ack the tool
// prints) and the audit shards the tool appends to - the PROCESS boundary,
// not an in-process handlePracticesEvent call. An in-process twin would lose
// the JSON-ack-to-stdout half AND the real audit-file write; both are
// observed here through the subprocess + the audit shards it writes under
// --project-dir.
//
// WHAT t81 PINS (bolt-plan-marker-conflict semantic):
//   The override path uses no separate BOLT_PLAN_OVERRIDDEN event. Instead it
//   reuses the PRACTICES_OVERRIDE event with a discriminator field
//   (Reason). The write-failure path emits PRACTICES_OVERRIDE for write-failure
//   semantics (Reason: write-failure-*); the bolt-plan path emits it for
//   orchestrator-overrides-bolt-plan-marker semantics (Reason:
//   bolt-plan-marker-conflict, plus Practices
//   Stance + Bolt-Plan Marker + Bolt slug fields). The contract being pinned
//   is that handlePracticesEvent (aidlc-state.ts) accepts arbitrary
//   --field "Key: Value" pairs (key and value trimmed) - discriminator-field
//   disambiguation needs zero new tool code.
//
// FIXTURE DISCIPLINE: the contract under test is purely the audit shards the
// tool writes under --project-dir, NOT any greenfield-stub file. Each case
// uses a FRESH temp project dir via createTestProject() (fixtures.ts), which
// scaffolds the workspace and toPortablePath-converts on Windows so the audit
// shards - written by the tool via the forward-slash audit helpers -
// round-trip when read back. No seed: the tool creates its audit shard on
// first emit, so post-fire PRACTICES_OVERRIDE counts are unambiguous (the
// seed audit-sample.md carries none). NOTHING is written under
// tests/fixtures/**; all temp dirs cleaned in afterAll.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-state.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh temp project (createTestProject - workspace scaffolded, Windows-portable). */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

// practices-event's emitAudit CREATES the bare SPACE record root's
// per-clone shard on first emit (no state seeded → no intent resolves → bare
// root); the SPAWNED tool mints its own clone-id, so reads glob every shard.
const readAudit = (p: string): string => readAllAuditShards(p);

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr
  stdout: string;
}

function practicesEvent(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [TOOL, "practices-event", ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Count audit blocks with `**Event**: <ev>`. */
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
 * t31.test.ts. Returns "" when absent.
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

  test("1: practices-event --type override accepts milestone 13 field set (emits PRACTICES_OVERRIDE)", () => {
    const p = proj();
    const r = practicesEvent(MILESTONE13_FIELDS, p);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"emitted":"PRACTICES_OVERRIDE"');
    expect(r.stdout).toContain('"fields_count":4');
  });

  test("2: PRACTICES_OVERRIDE audit row carries discriminator Reason + milestone 13 fields", () => {
    const p = proj();
    practicesEvent(MILESTONE13_FIELDS, p);
    const f = readAudit(p);
    expect(auditField(f, "PRACTICES_OVERRIDE", "Reason")).toBe("bolt-plan-marker-conflict");
    expect(auditField(f, "PRACTICES_OVERRIDE", "Practices Stance")).toBe("never-skeleton");
    expect(auditField(f, "PRACTICES_OVERRIDE", "Bolt-Plan Marker")).toBe("walking-skeleton");
    expect(auditField(f, "PRACTICES_OVERRIDE", "Bolt slug")).toBe("t81-bolt-1");
  });

  test("3: framework event count pinned at 119", () => {
    // Pin the count against the SOURCE OF TRUTH - VALID_EVENT_TYPES in
    // aidlc-audit.ts (the real count, not a sibling test's transcription of it).
    // bolt-plan-marker-conflict reuses PRACTICES_OVERRIDE (discriminator-field
    // disambiguation) and registers no new event. The framework total is 119;
    // REVIEW_VERDICT_DICTATED is kept registered so earlier audits read.
    const auditSrc = readFileSync(
      join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-audit.ts"),
      "utf-8",
    );
    const block = auditSrc.match(/const VALID_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/);
    expect(block).not.toBeNull();
    const count = (block ? block[1].match(/"[A-Z0-9_]+"/g) : null)?.length ?? -1;
    expect(count).toBe(119);
  });

  test("4: PRACTICES_OVERRIDE coexists across both Reason discriminators", () => {
    const p = proj();
    practicesEvent(MILESTONE13_FIELDS, p);
    const writeFail = practicesEvent(
      ["--type", "override", "--field", "Reason: write-failure-permission-denied"],
      p,
    );
    expect(writeFail.stdout).toContain('"emitted":"PRACTICES_OVERRIDE"');
    const f = readAudit(p);
    expect(auditEventCount(f, "PRACTICES_OVERRIDE")).toBeGreaterThanOrEqual(2);
    // The discriminator field disambiguates the two rows - both
    // distinct Reason values are present in the PRACTICES_OVERRIDE event space.
    const reasons = auditFieldAll(f, "PRACTICES_OVERRIDE", "Reason");
    expect(reasons).toContain("bolt-plan-marker-conflict");
    expect(reasons).toContain("write-failure-permission-denied");
  });
});
