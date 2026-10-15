// covers: subcommand:aidlc-bolt:dispatch-event
//
// Mechanism = cli. Every assertion SPAWNS the real CLI via node:child_process
// spawnSync (BUN + the tool .ts path), asserting on res.status / res.stdout /
// res.stderr, plus on the audit shards the tool writes - the PROCESS boundary,
// not in-process handleDispatchEvent calls. An in-process twin would lose the
// exit-code half the invalid-arg cases rely on: the tool's error() path is
// process.exit(1) via emitError (aidlc-bolt.ts ->
// aidlc-lib.ts), and the JSON-ack-to-stdout half (console.log of
// `{"emitted":"..."}`).
//
// SUBCOMMAND UNIT: this file credits the single subcommand unit it
// exercises — `aidlc-bolt dispatch-event` (covers KEY
// subcommand:aidlc-bolt:dispatch-event, COLON form). All 12 cases fire that
// one subcommand across its three --event variants (INVOKED / RETURNED /
// FALLBACK) plus the dispatch error arm.
//
// CONTRACT (aidlc-bolt.ts, handleDispatchEvent):
//   - --event + --slug always required (Missing --event / Missing --slug).
//   - MERGE_DISPATCH_INVOKED: requires --practices-excerpt; emits fields
//     {Bolt slug, Practices section excerpt}.
//   - MERGE_DISPATCH_RETURNED: requires --strategy in {squash,merge,rebase},
//     --target, --confidence in [0,1], --notes; emits 5 fields
//     {Bolt slug, Strategy, Target branch, Confidence, Notes}.
//   - MERGE_DISPATCH_FALLBACK: requires --reason, --defaults; emits fields
//     {Bolt slug, Fallback reason, Defaults applied}.
//   - Unknown --event -> "Invalid --event: ...".
//   Every variant prints `{"emitted":"<EVENT>","slug":"<slug>"}` on stdout
//   and writes one audit block via appendAuditEntry (aidlc-audit.ts:
//   `**Event**: <type>` then `**<key>**: <value>` lines, blocks separated by
//   `\n---\n`).
//
// FIXTURE DISCIPLINE: because this test asserts EXACT per-event counts and
// reads back specific block fields, each audit-emitting case takes a FRESH
// temp project (setupIntegrationProject({ withGreenfieldStub: true }), which
// scaffolds .claude/ + the greenfield stub and toPortablePath-converts on
// Windows so the audit shards - written by the tool via the project-dir
// resolver - round-trip when read back). Error-only cases reuse a single fresh
// project (no audit row lands on the rejected path). All temp dirs cleaned in
// afterAll.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, beforeAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-bolt.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function proj(): string {
  const p = setupIntegrationProject({ withGreenfieldStub: true });
  tempDirs.push(p);
  return p;
}

// Bolt dispatch-event's appendAuditEntry CREATES the bare SPACE record
// root's per-clone shard on first emit (the integration project seeds no state,
// so no intent resolves → bare root); the SPAWNED tool mints its own clone-id,
// so reads glob every shard via readAllAuditShards.
const readAudit = (p: string): string => readAllAuditShards(p);

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr
  stdout: string;
}

function dispatch(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [TOOL, "dispatch-event", ...args, "--project-dir", p], {
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

/** Count audit blocks with `**Event**: <ev>` in a buffer. */
function auditEventCount(body: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return body
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Walks the file; resets at `## ` headings and `---` separators; splits
 * `**label**: value` on the literal `**: ` separator.
 * Returns "" when absent.
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

// Single shared project for the error-only arm: a rejected dispatch writes no
// audit row, so cases can safely share one fresh project.
let errProj: string;
beforeAll(() => {
  errProj = proj();
});

// ============================================================
// Happy-path emission: the three --event variants
// ============================================================

describe("t79 aidlc-bolt dispatch-event — emission (migrated from t79-dispatch-event-validation.sh, plan 12)", () => {
  test("1: INVOKED returns JSON envelope with emitted=MERGE_DISPATCH_INVOKED", () => {
    const p = proj();
    const r = dispatch(
      [
        "--event",
        "MERGE_DISPATCH_INVOKED",
        "--slug",
        "t79-bolt-1",
        "--practices-excerpt",
        "We use trunk-based development",
      ],
      p,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_INVOKED"');
  });

  test("2: INVOKED row lands in audit.md with required fields", () => {
    const p = proj();
    dispatch(
      [
        "--event",
        "MERGE_DISPATCH_INVOKED",
        "--slug",
        "t79-bolt-1",
        "--practices-excerpt",
        "We use trunk-based development",
      ],
      p,
    );
    const f = readAudit(p);
    expect(auditEventCount(f, "MERGE_DISPATCH_INVOKED")).toBe(1);
    expect(auditField(f, "MERGE_DISPATCH_INVOKED", "Bolt slug")).toBe("t79-bolt-1");
    expect(auditField(f, "MERGE_DISPATCH_INVOKED", "Practices section excerpt")).toBe(
      "We use trunk-based development",
    );
  });

  test("3: RETURNED returns JSON envelope", () => {
    const p = proj();
    const r = dispatch(
      [
        "--event",
        "MERGE_DISPATCH_RETURNED",
        "--slug",
        "t79-bolt-1",
        "--strategy",
        "squash",
        "--target",
        "main",
        "--confidence",
        "0.92",
        "--notes",
        "trunk-based per team.md",
      ],
      p,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_RETURNED"');
  });

  test("4: RETURNED audit row carries all 5 schema fields", () => {
    const p = proj();
    dispatch(
      [
        "--event",
        "MERGE_DISPATCH_RETURNED",
        "--slug",
        "t79-bolt-1",
        "--strategy",
        "squash",
        "--target",
        "main",
        "--confidence",
        "0.92",
        "--notes",
        "trunk-based per team.md",
      ],
      p,
    );
    const f = readAudit(p);
    expect(auditEventCount(f, "MERGE_DISPATCH_RETURNED")).toBe(1);
    expect(auditField(f, "MERGE_DISPATCH_RETURNED", "Strategy")).toBe("squash");
    expect(auditField(f, "MERGE_DISPATCH_RETURNED", "Target branch")).toBe("main");
    expect(auditField(f, "MERGE_DISPATCH_RETURNED", "Confidence")).toBe("0.92");
    expect(auditField(f, "MERGE_DISPATCH_RETURNED", "Notes")).toBe("trunk-based per team.md");
    expect(auditField(f, "MERGE_DISPATCH_RETURNED", "Bolt slug")).toBe("t79-bolt-1");
  });

  test("5: FALLBACK returns JSON envelope", () => {
    const p = proj();
    const r = dispatch(
      [
        "--event",
        "MERGE_DISPATCH_FALLBACK",
        "--slug",
        "t79-bolt-1",
        "--reason",
        "timeout",
        "--defaults",
        "squash + main",
      ],
      p,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"emitted":"MERGE_DISPATCH_FALLBACK"');
  });

  test("6: FALLBACK audit row carries Fallback reason and Defaults applied", () => {
    const p = proj();
    dispatch(
      [
        "--event",
        "MERGE_DISPATCH_FALLBACK",
        "--slug",
        "t79-bolt-1",
        "--reason",
        "timeout",
        "--defaults",
        "squash + main",
      ],
      p,
    );
    const f = readAudit(p);
    expect(auditEventCount(f, "MERGE_DISPATCH_FALLBACK")).toBe(1);
    expect(auditField(f, "MERGE_DISPATCH_FALLBACK", "Fallback reason")).toBe("timeout");
    expect(auditField(f, "MERGE_DISPATCH_FALLBACK", "Defaults applied")).toBe("squash + main");
    expect(auditField(f, "MERGE_DISPATCH_FALLBACK", "Bolt slug")).toBe("t79-bolt-1");
  });
});

// ============================================================
// Validation rejections (exit 1 + diagnostic)
// ============================================================

describe("t79 aidlc-bolt dispatch-event — validation", () => {
  test("7: unknown --event rejected with error (exit 1)", () => {
    const r = dispatch(
      ["--event", "MERGE_DISPATCH_INVALID", "--slug", "t79-bolt-x"],
      errProj,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("Invalid --event");
  });

  test("8: missing --slug rejected (exit 1)", () => {
    const r = dispatch(
      ["--event", "MERGE_DISPATCH_INVOKED", "--practices-excerpt", "x"],
      errProj,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --slug");
  });

  test("9: INVOKED requires --practices-excerpt (exit 1)", () => {
    const r = dispatch(
      ["--event", "MERGE_DISPATCH_INVOKED", "--slug", "t79-bolt-x"],
      errProj,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("requires --practices-excerpt");
  });

  test("10: RETURNED rejects invalid --strategy (exit 1)", () => {
    const r = dispatch(
      [
        "--event",
        "MERGE_DISPATCH_RETURNED",
        "--slug",
        "t79-bolt-x",
        "--strategy",
        "badstrat",
        "--target",
        "main",
        "--confidence",
        "0.5",
        "--notes",
        "x",
      ],
      errProj,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("Invalid --strategy");
  });

  test("11: RETURNED rejects --confidence out of [0,1] (exit 1)", () => {
    const r = dispatch(
      [
        "--event",
        "MERGE_DISPATCH_RETURNED",
        "--slug",
        "t79-bolt-x",
        "--strategy",
        "squash",
        "--target",
        "main",
        "--confidence",
        "1.5",
        "--notes",
        "x",
      ],
      errProj,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("Invalid --confidence");
  });

  test("12: FALLBACK requires --reason (exit 1)", () => {
    const r = dispatch(
      ["--event", "MERGE_DISPATCH_FALLBACK", "--slug", "t79-bolt-x", "--defaults", "x"],
      errProj,
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain("requires --reason");
  });
});
