// covers: subcommand:aidlc-bolt:dispatch-event
//
// CLI-contract port of tests/unit/t79-dispatch-event-validation.sh (TAP plan
// 12), mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-bolt.ts dispatch-event ...` is preserved by
// SPAWNING the real CLI via node:child_process spawnSync (BUN + the tool .ts
// path), asserting on res.status / res.stdout / res.stderr exactly as the .sh
// asserted on the captured `OUT` (2>&1), plus on the audit.md the tool writes
// — the PROCESS boundary, not in-process handleDispatchEvent calls. An
// in-process twin would lose the exit-code half the .sh's invalid-arg cases
// rely on: the tool's error() path is process.exit(1) via emitError
// (aidlc-bolt.ts:838-842 -> aidlc-lib.ts:1504-1546), and the JSON-ack-to-stdout
// half (console.log of `{"emitted":"..."}`).
//
// SUBCOMMAND UNIT: this .cli file credits the single subcommand unit the .sh
// exercises — `aidlc-bolt dispatch-event` (covers KEY
// subcommand:aidlc-bolt:dispatch-event, COLON form). All 12 .sh cases fire that
// one subcommand across its three --event variants (INVOKED / RETURNED /
// FALLBACK) plus the dispatch error arm.
//
// CONTRACT (aidlc-bolt.ts:660-734, handleDispatchEvent):
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
//   and writes one audit block via appendAuditEntry (aidlc-audit.ts:240-272:
//   `**Event**: <type>` then `**<key>**: <value>` lines, blocks separated by
//   `\n---\n`).
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; several are
// STRONGER than the original grep):
//   - .sh Test 1  INVOKED stdout `"emitted":"MERGE_DISPATCH_INVOKED"`    -> Test 1:
//       r.status===0 (S: .sh discarded the exit code; we pin clean exit) +
//       stdout contains the same envelope substring.
//   - .sh Test 2  grep "MERGE_DISPATCH_INVOKED" in audit.md (bare presence) -> Test 2:
//       auditEventCount(...,"MERGE_DISPATCH_INVOKED")===1 (STRONGER: exact
//       count against a fresh project, not a file-wide substring grep) +
//       block-scoped Bolt slug + Practices section excerpt field values
//       (STRONGER: the .sh never checked INVOKED's payload fields).
//   - .sh Test 3  RETURNED stdout `"emitted":"MERGE_DISPATCH_RETURNED"`  -> Test 3:
//       r.status===0 (S) + stdout envelope substring.
//   - .sh Test 4  RETURNED audit block carries Strategy/Target/Confidence/Notes
//       (awk-scoped grep, 4 fields)                                      -> Test 4:
//       auditField exact for all 4 + Bolt slug (STRONGER: 5th field, exact
//       block-scoped values vs the .sh's 4 substring greps).
//   - .sh Test 5  FALLBACK stdout `"emitted":"MERGE_DISPATCH_FALLBACK"`  -> Test 5:
//       r.status===0 (S) + stdout envelope substring.
//   - .sh Test 6  FALLBACK audit block carries Fallback reason + Defaults applied
//       (awk-scoped grep, 2 fields)                                      -> Test 6:
//       auditField exact for both + Bolt slug (STRONGER: 3rd field, exact).
//   - .sh Test 7  unknown --event -> "Invalid --event"   ($? swallowed)  -> Test 7:
//       r.status===1 (STRONGER: .sh `|| true`-swallowed the code) +
//       out contains "Invalid --event".
//   - .sh Test 8  missing --slug -> "Missing --slug"                     -> Test 8:
//       r.status===1 (STRONGER) + out contains "Missing --slug".
//   - .sh Test 9  INVOKED missing --practices-excerpt -> "requires --practices-excerpt"
//       -> Test 9: r.status===1 (STRONGER) + out contains the message.
//   - .sh Test 10 RETURNED bad --strategy -> "Invalid --strategy"        -> Test 10:
//       r.status===1 (STRONGER) + out contains "Invalid --strategy".
//   - .sh Test 11 RETURNED --confidence 1.5 -> "Invalid --confidence"    -> Test 11:
//       r.status===1 (STRONGER) + out contains "Invalid --confidence".
//   - .sh Test 12 FALLBACK missing --reason -> "requires --reason"       -> Test 12:
//       r.status===1 (STRONGER) + out contains "requires --reason".
//
// 12 .sh asserts -> 12 expect()-bearing test() cases here (1:1). STRONGER
// additions (exact event counts, exact block-scoped field values incl. the
// Bolt slug the .sh never checked, and pinned exit codes on every error arm)
// are layered on top of the .sh observables — never fewer.
//
// FIXTURE DISCIPLINE (mirrors the .sh's single setup_integration_project
// --with-greenfield-stub + cleanup_test_project): the .sh reused ONE project
// across all 12 cases, so its audit.md accumulated rows and its Test 2/4/6
// greps were whole-file (an earlier INVOKED row would still satisfy Test 2's
// bare presence grep). Because this port asserts EXACT per-event counts and
// reads back specific block fields, each audit-emitting case takes a FRESH
// temp project (setupIntegrationProject({ withGreenfieldStub: true }), which
// scaffolds .claude/ + the greenfield stub and toPortablePath-converts on
// Windows so audit.md — written by the tool via the project-dir resolver —
// round-trips when read back). Error-only cases reuse a single fresh project
// (no audit row lands on the rejected path). All temp dirs cleaned in afterAll.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-bolt.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh integration project with the greenfield stub (mirrors the .sh PROJ). */
function proj(): string {
  const p = setupIntegrationProject({ withGreenfieldStub: true });
  tempDirs.push(p);
  return p;
}

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun aidlc-bolt.ts dispatch-event <args...> --project-dir <p>`. Mirrors `bun "$BOLT" dispatch-event ...`. */
function dispatch(args: string[], p: string): CliResult {
  const res = spawnSync(BUN, [TOOL, "dispatch-event", ...args, "--project-dir", p], {
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return {
    status: res.status ?? -1,
    out: `${stdout}${res.stderr ?? ""}`,
    stdout,
  };
}

/** Count audit blocks with `**Event**: <ev>`. Mirrors the .sh's grep, but as an exact count. */
function auditEventCount(file: string, ev: string): number {
  if (!existsSync(file)) return 0;
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Walks the file; resets at `## ` headings and `---` separators; splits
 * `**label**: value` on the literal `**: ` separator. Mirrors the awk-scoped
 * block grep the .sh used (awk '/<EVENT>/{flag=1} flag && /^---$/{exit} flag').
 * Returns "" when absent.
 */
function auditField(file: string, ev: string, key: string): string {
  if (!existsSync(file)) return "";
  let matched = false;
  for (const line of readFileSync(file, "utf-8").split("\n")) {
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
// audit row, so cases can safely share one fresh project (mirrors the .sh,
// which reused PROJ for the `|| true` error cases too).
let errProj: string;
beforeAll(() => {
  errProj = proj();
});

// ============================================================
// Happy-path emission: the three --event variants
// (.sh Tests 1-6)
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
    expect(r.status).toBe(0); // S: .sh discarded the exit code
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
    const f = auditPath(p);
    expect(auditEventCount(f, "MERGE_DISPATCH_INVOKED")).toBe(1);
    // STRONGER than the .sh (bare presence grep): exact block-scoped fields.
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
    expect(r.status).toBe(0); // S
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
    const f = auditPath(p);
    expect(auditEventCount(f, "MERGE_DISPATCH_RETURNED")).toBe(1);
    expect(auditField(f, "MERGE_DISPATCH_RETURNED", "Strategy")).toBe("squash");
    expect(auditField(f, "MERGE_DISPATCH_RETURNED", "Target branch")).toBe("main");
    expect(auditField(f, "MERGE_DISPATCH_RETURNED", "Confidence")).toBe("0.92");
    expect(auditField(f, "MERGE_DISPATCH_RETURNED", "Notes")).toBe("trunk-based per team.md");
    // STRONGER: the .sh checked 4 fields; the 5th (Bolt slug) is asserted too.
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
    expect(r.status).toBe(0); // S
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
    const f = auditPath(p);
    expect(auditEventCount(f, "MERGE_DISPATCH_FALLBACK")).toBe(1);
    expect(auditField(f, "MERGE_DISPATCH_FALLBACK", "Fallback reason")).toBe("timeout");
    expect(auditField(f, "MERGE_DISPATCH_FALLBACK", "Defaults applied")).toBe("squash + main");
    // STRONGER: 3rd field (Bolt slug) the .sh never checked.
    expect(auditField(f, "MERGE_DISPATCH_FALLBACK", "Bolt slug")).toBe("t79-bolt-1");
  });
});

// ============================================================
// Validation rejections (exit 1 + diagnostic)
// (.sh Tests 7-12)
// ============================================================

describe("t79 aidlc-bolt dispatch-event — validation", () => {
  test("7: unknown --event rejected with error (exit 1)", () => {
    const r = dispatch(
      ["--event", "MERGE_DISPATCH_INVALID", "--slug", "t79-bolt-x"],
      errProj,
    );
    expect(r.status).toBe(1); // STRONGER: .sh swallowed $? with `|| true`
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
