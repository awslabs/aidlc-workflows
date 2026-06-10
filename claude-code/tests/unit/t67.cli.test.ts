// covers: subcommand:aidlc-utility:scope-table, subcommand:aidlc-utility:detect-scope
//
// CLI-contract port of tests/unit/t67-scope-table.sh (TAP plan 28),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-utility.ts scope-table ...` / `detect-scope ...`
// (and the `assert_infer` helper's `bun -e` import of inferScopeFromText) is
// preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status / res.stdout / res.stderr
// and on the audit.md the tool writes — the PROCESS boundary, not in-process
// renderScopeTable()/inferScopeFromText() calls.
//
// INFER-VIA-CLI (STRONGER): the .sh tested inferScopeFromText() in isolation
// through `bun -e`. Here every keyword / word-boundary / fallback / empty-input
// case is exercised through the REAL `detect-scope --from-text --input <t>`
// subcommand, which routes through inferScopeFromText internally (utility.ts:2734)
// and surfaces the resolved scope BOTH as the JSON ack `"scope":"<s>"` on stdout
// AND as the `**Detected scope**: <s>` audit row. We assert both — the same
// observable the .sh asserted (resolved scope), expressed at the full process
// boundary plus the audit side effect, never less. Empty `--input ""` is a
// first-class CLI path under --from-text (utility.ts:2718-2727), so the
// empty-input fallback migrates faithfully.
//
// SUBCOMMAND UNITS: this .cli file credits BOTH subcommand units the .sh
// exercises — `scope-table` (emission shape, determinism, ordering, row count,
// --check clean/drift/missing-markers) and `detect-scope` (--from-text keyword
// inference + audit, --scope backward-compat, flag-collision rejection). Both
// are fired here.
//
// DIE / ERROR STREAM: the tool's die() path emits JSON `{"error":"..."}` to
// STDERR and exits 1 (verified live). The .sh redirected `2>/tmp/...` and
// grepped that capture, so the error text lives on stderr. handleScopeTable's
// --check failures (missing markers / out of date) also write to stderr via
// console.error + process.exit(1). The `out` helper field concatenates
// stdout+stderr (mirroring the .sh's 2>&1 where it used it) so message asserts
// hold regardless of stream; JSON-ack asserts stay scoped to stdout.
//
// PARITY NOTES (every .sh `ok` line maps to an expect() below; STRONGER adds noted):
//   §1 scope-table emission shape (5 asserts) -> Tests 1-5:
//     - BEGIN marker / END marker / "| Scope" header / "| bugfix" row /
//       "| workshop" row — all preserved as stdout .toContain() + STRONGER
//       res.status===0 pin (the .sh discarded $? on the bare emission call).
//   §2 deterministic + alphabetical (2 asserts) -> Tests 6-7:
//     - two emissions byte-equal (Test 6); row names == alphabetical EXPECTED
//       "bugfix enterprise feature infra mvp poc refactor security-patch
//       workshop" (Test 7), parsed by the same `^| <name>` regex the .sh awk'd.
//   §3 row count == scopes/*.md count (1 assert) -> Test 8: the .sh pinned
//       rows matching `^| <name>` === `ls scopes/aidlc-*.md | wc -l`. v0.6.0
//       deleted scope-mapping.json; loadScopeMapping() now derives the scope
//       SET from the .claude/scopes/aidlc-*.md files present (aidlc-lib.ts:836)
//       + scope-grid.json `.stages`, so that filesystem count is STILL the live
//       source — the .sh assertion is restored faithfully against it (NOT
//       obsolete). STRONGER: also pins gridCount === mdCount === rendered rows
//       === 9 (triangulate the rendered table against BOTH shipped surfaces).
//   §4 --check clean exit 0 on real SKILL.md (1 assert) -> Test 9: res.status===0
//       (no AIDLC_SKILL_MD_PATH override -> the shipped SKILL.md).
//   §5 --check exit 1 on drifted SKILL.md (2 asserts) -> Tests 10-11: copy the
//       real SKILL.md to a temp file, sed the bugfix row to bogus, point
//       AIDLC_SKILL_MD_PATH at it; res.status===1 (Test 10) + stderr contains
//       "out of date" (Test 11). Never mutates the real SKILL.md (env seam).
//   §6 --check exit 1 on missing markers (1 assert) -> Test 12: marker-less temp
//       file -> res.status===1 AND stderr "missing scope-table markers"
//       (the .sh AND'd rc==1 with the grep; both asserted here).
//   §7 keyword matching (7 asserts) -> Tests 13-19: fix->bugfix, refactor,
//       CVE->security-patch, workshop, spike->poc, mvp, infra — each asserts
//       JSON-ack "scope" AND audit **Detected scope** (STRONGER: the .sh only
//       compared inferScopeFromText().scope; we also pin the audit side effect).
//   §8 word-boundary guards (2 asserts) -> Tests 20-21: "debug this issue" and
//       "fixture scope testing" both resolve to feature (substring "bug"/"fix"
//       must NOT trigger via \b regex) — asserted via the CLI resolved scope.
//   §8b multi-word whitespace variance (1 assert) -> Test 22: "minimum  viable"
//       (double-space) -> mvp.
//   §9 >5-word fallback (1 assert) -> Test 23: "I want to fix the broken auth
//       flow quickly today" -> feature.
//   §10 empty input (1 assert) -> Test 24: --input "" -> feature.
//   §11 detect-scope --from-text emits SCOPE_DETECTED keyword + Matched keywords
//       (2 asserts) -> Tests 25-26: scope=bugfix + Source=keyword (Test 25,
//       STRONGER: exact block-scoped field values + event count===1) and
//       "Matched keywords" row present (Test 26).
//   §12 backward-compat --scope path (1 assert) -> Test 27: detect-scope --scope
//       feature --source freeform still emits SCOPE_DETECTED with
//       Detected scope=feature + Source=freeform (STRONGER: exact fields).
//   §13 flag-collision (1 assert) -> Test 28: --scope + --from-text -> res.status
//       ===1 AND error "Cannot combine --from-text and --scope" (the .sh AND'd
//       rc==1 with the grep; both asserted).
//
// 28 .sh asserts -> 28 expect()-bearing test() cases (one observable cluster
// per case; the 2-assert sections split into two cases each to keep parity 1:1
// where the .sh emitted two `ok` lines).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + cleanup_test_project
// per audit case, and mktemp for the drift/nomark SKILL.md sandboxes): each
// audit-emitting case uses a FRESH temp project dir (createTestProject, which
// toPortablePath-converts on Windows so audit.md — written by the tool via the
// forward-slash audit helper — round-trips when read back). The drift/nomark
// SKILL.md fixtures are mkdtemp'd temp FILES driven through AIDLC_SKILL_MD_PATH
// so the shipped SKILL.md is never touched. All temp dirs/files cleaned in
// afterAll. NOTHING is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
const SKILL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "skills",
  "aidlc",
  "SKILL.md",
);
const SCOPE_GRID = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "data",
  "scope-grid.json",
);
// CURRENT canonical scope-set surface (v0.6.0): scope-mapping.json was DELETED;
// loadScopeMapping() now derives the scope SET from the .claude/scopes/*.md
// files present (aidlc-lib.ts:836 — `for (const name of Object.keys(metadata))`,
// metadata sourced from loadScopeMetadata over scopes/aidlc-*.md) and merges in
// scope-grid.json's per-scope `.stages`. So scopes/aidlc-*.md is the live source
// the .sh's §3 `ls scopes/aidlc-*.md | wc -l` count targeted — NOT obsolete.
const SCOPES_DIR = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "scopes",
);

/** Count of shipped scope definition files: .claude/scopes/aidlc-*.md. */
function scopesMdCount(): number {
  return readdirSync(SCOPES_DIR).filter(
    (f) => f.startsWith("aidlc-") && f.endsWith(".md"),
  ).length;
}

const tempDirs: string[] = [];
const tempFiles: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
  for (const f of tempFiles) rmSync(f, { force: true });
});

/** Fresh empty project dir (mirrors create_test_project). */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

const auditPath = (p: string): string => join(p, "aidlc-docs", "audit.md");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** Spawn `bun aidlc-utility.ts <args...>`. Optional AIDLC_SKILL_MD_PATH env seam. */
function util(args: string[], skillMdPath?: string): CliResult {
  const env = { ...process.env };
  if (skillMdPath !== undefined) env.AIDLC_SKILL_MD_PATH = skillMdPath;
  const res = spawnSync(BUN, [TOOL, ...args], { encoding: "utf-8", env });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return {
    status: res.status ?? -1,
    stdout,
    stderr,
    out: `${stdout}${stderr}`,
  };
}

/** Run `scope-table` (no --check); returns combined stdout+stderr like the .sh's 2>&1. */
function scopeTable(...args: string[]): CliResult {
  return util(["scope-table", ...args]);
}

/** Run `detect-scope --from-text --input <text> --project-dir <p>`. */
function detectFromText(input: string, p: string): CliResult {
  return util(["detect-scope", "--from-text", "--input", input, "--project-dir", p]);
}

/**
 * Resolved scope from the JSON ack the tool prints on stdout
 * (`{"emitted":"SCOPE_DETECTED","scope":"<s>",...}`). Mirrors the .sh's
 * `inferScopeFromText(...).scope` observable, read at the process boundary.
 */
function ackScope(r: CliResult): string {
  const m = r.stdout.match(/"scope":"([a-z-]+)"/);
  return m ? m[1] : "";
}

/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Resets at `## ` headings / `---`; splits `**label**: value` on `**: `.
 * Mirrors audit_field in the proven t31/t90 ports. Returns "" when absent.
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

/** Count audit blocks with `**Event**: <ev>`. */
function auditEventCount(file: string, ev: string): number {
  if (!existsSync(file)) return 0;
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return readFileSync(file, "utf-8")
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/** Whole-file presence (mirrors a bare grep). */
function fileContains(file: string, needle: string): boolean {
  if (!existsSync(file)) return false;
  return readFileSync(file, "utf-8").includes(needle);
}

/**
 * Row names from the scope-table output: every line `^| <name>` where <name>
 * matches [a-z-]+. Mirrors the .sh's
 * `grep -oE '^\| [a-z-]+' | awk '{print $2}'`.
 */
function rowNames(tableOut: string): string[] {
  const names: string[] = [];
  for (const line of tableOut.split("\n")) {
    const m = line.match(/^\| ([a-z-]+)/);
    if (m) names.push(m[1]);
  }
  return names;
}

const EXPECTED_ROW_ORDER =
  "bugfix enterprise feature infra mvp poc refactor security-patch workshop";

// ============================================================
// scope-table — emission shape (.sh §1)
// (covers: subcommand:aidlc-utility:scope-table)
// ============================================================

describe("t67 scope-table emission (migrated from t67-scope-table.sh §1-3)", () => {
  test("1: scope-table output has BEGIN marker", () => {
    const r = scopeTable();
    expect(r.status).toBe(0); // STRONGER: .sh discarded $?; pin clean exit
    expect(r.out).toContain("BEGIN: compiled");
  });

  test("2: scope-table output has END marker", () => {
    expect(scopeTable().out).toContain("END: compiled");
  });

  test("3: scope-table output has table header", () => {
    expect(scopeTable().out).toContain("| Scope");
  });

  test("4: scope-table output includes bugfix row", () => {
    expect(scopeTable().out).toContain("| bugfix");
  });

  test("5: scope-table output includes workshop row", () => {
    expect(scopeTable().out).toContain("| workshop");
  });

  // --- §2: deterministic + alphabetical ---
  test("6: scope-table output is deterministic across calls", () => {
    const a = scopeTable().out;
    const b = scopeTable().out;
    expect(b).toBe(a);
  });

  test("7: scope-table rows sorted alphabetically", () => {
    const names = rowNames(scopeTable().out);
    expect(names.join(" ")).toBe(EXPECTED_ROW_ORDER);
  });

  // --- §3: row count matches the CURRENT shipped scope-set surface ---
  // The .sh pinned `rowCount === ls scopes/aidlc-*.md | wc -l`. v0.6.0 deleted
  // scope-mapping.json; loadScopeMapping() now derives the scope SET from the
  // .claude/scopes/aidlc-*.md files present (aidlc-lib.ts:836) and the per-scope
  // grid from scope-grid.json. The .sh's filesystem count is therefore STILL the
  // live source — not obsolete — so we restore it AND triangulate against the
  // grid (every scopes/*.md scope must carry a grid `.stages` entry) and the
  // rendered table rows. All three must agree; that is strictly stronger than
  // the .sh (rows == scopes/*.md only) and than the prior twin (rows == grid).
  test("8: scope-table row count matches scopes/*.md AND scope-grid.json", () => {
    const rowCount = rowNames(scopeTable().out).length;
    const mdCount = scopesMdCount();
    const gridCount = Object.keys(
      JSON.parse(readFileSync(SCOPE_GRID, "utf-8")),
    ).length;
    // .sh §3 assertion (restored against the current shipped source surface):
    expect(rowCount).toBe(mdCount);
    // STRONGER: the compiled grid covers exactly the scopes/*.md set …
    expect(gridCount).toBe(mdCount);
    expect(rowCount).toBe(gridCount);
    // … and the concrete count is pinned.
    expect(rowCount).toBe(9);
  });
});

// ============================================================
// scope-table --check (.sh §4-6)
// (covers: subcommand:aidlc-utility:scope-table)
// ============================================================

describe("t67 scope-table --check drift guard (migrated from t67 §4-6)", () => {
  test("9: --check on clean SKILL.md exits 0", () => {
    // No AIDLC_SKILL_MD_PATH override -> the shipped SKILL.md.
    const r = util(["scope-table", "--check"]);
    expect(r.status).toBe(0);
  });

  test("10: --check exits 1 on drifted SKILL.md", () => {
    // Sandbox via AIDLC_SKILL_MD_PATH — never mutate the real SKILL.md.
    const drift = join(mkdtempSync(join(tmpdir(), "t67-drift-")), "skill.md");
    tempFiles.push(drift);
    let raw = readFileSync(SKILL, "utf-8");
    raw = raw.replace(
      "| bugfix         | Minimal",
      "| bogus          | Minimal",
    );
    writeFileSync(drift, raw, "utf-8");
    const r = util(["scope-table", "--check"], drift);
    expect(r.status).toBe(1);
  });

  test("11: drift error mentions 'out of date'", () => {
    const drift = join(mkdtempSync(join(tmpdir(), "t67-drift-")), "skill.md");
    tempFiles.push(drift);
    let raw = readFileSync(SKILL, "utf-8");
    raw = raw.replace(
      "| bugfix         | Minimal",
      "| bogus          | Minimal",
    );
    writeFileSync(drift, raw, "utf-8");
    const r = util(["scope-table", "--check"], drift);
    expect(r.out).toContain("out of date");
  });

  test("12: --check exits 1 with 'missing scope-table markers' on marker-less SKILL.md", () => {
    const nomark = join(mkdtempSync(join(tmpdir(), "t67-nomark-")), "skill.md");
    tempFiles.push(nomark);
    writeFileSync(nomark, "no markers in this file\n", "utf-8");
    const r = util(["scope-table", "--check"], nomark);
    // The .sh AND'd rc==1 with the grep; both asserted here.
    expect(r.status).toBe(1);
    expect(r.out).toContain("missing scope-table markers");
  });
});

// ============================================================
// detect-scope --from-text keyword inference (.sh §7-10)
// (covers: subcommand:aidlc-utility:detect-scope)
// Exercises inferScopeFromText through the real CLI process boundary.
// ============================================================

describe("t67 detect-scope --from-text keyword inference (migrated from t67 §7)", () => {
  // Each case asserts BOTH the JSON-ack resolved scope AND the audit
  // **Detected scope** row (STRONGER than the .sh's bare scope compare).
  const keywordCase = (input: string, expected: string) => () => {
    const p = proj();
    const r = detectFromText(input, p);
    expect(r.status).toBe(0);
    expect(ackScope(r)).toBe(expected);
    expect(auditField(auditPath(p), "SCOPE_DETECTED", "Detected scope")).toBe(
      expected,
    );
  };

  test('13: "fix the login bug" -> bugfix', keywordCase("fix the login bug", "bugfix"));
  test('14: "refactor this code" -> refactor', keywordCase("refactor this code", "refactor"));
  test('15: "CVE patch" -> security-patch', keywordCase("CVE patch", "security-patch"));
  test('16: "run workshop today" -> workshop', keywordCase("run workshop today", "workshop"));
  test('17: "spike prototype" -> poc', keywordCase("spike prototype", "poc"));
  test('18: "mvp" -> mvp', keywordCase("mvp", "mvp"));
  test('19: "infra deploy" -> infra', keywordCase("infra deploy", "infra"));
});

describe("t67 detect-scope --from-text boundary + fallback (migrated from t67 §8-10)", () => {
  // §8 word-boundary false-positive guards: "debug" contains "bug",
  // "fixture" contains "fix" — \b regex must NOT match -> feature default.
  const fallbackCase = (input: string, expected: string) => () => {
    const p = proj();
    const r = detectFromText(input, p);
    expect(r.status).toBe(0);
    expect(ackScope(r)).toBe(expected);
    expect(auditField(auditPath(p), "SCOPE_DETECTED", "Detected scope")).toBe(
      expected,
    );
  };

  test('20: "debug this issue" -> feature (word-boundary, no bugfix)', fallbackCase("debug this issue", "feature"));
  test('21: "fixture scope testing" -> feature (word-boundary, no bugfix)', fallbackCase("fixture scope testing", "feature"));

  // §8b multi-word keyword matches despite extra whitespace.
  test('22: "minimum  viable" (double-space) -> mvp', () => {
    const p = proj();
    const r = detectFromText("minimum  viable", p);
    expect(r.status).toBe(0);
    expect(ackScope(r)).toBe("mvp");
    expect(auditField(auditPath(p), "SCOPE_DETECTED", "Detected scope")).toBe(
      "mvp",
    );
  });

  // §9 >5-word input with keywords -> feature default.
  test('23: ">5-word input with keywords -> feature default"', fallbackCase("I want to fix the broken auth flow quickly today", "feature"));

  // §10 empty input -> feature default (valid CLI path under --from-text).
  test("24: empty input -> feature default", () => {
    const p = proj();
    const r = detectFromText("", p);
    expect(r.status).toBe(0);
    expect(ackScope(r)).toBe("feature");
    expect(auditField(auditPath(p), "SCOPE_DETECTED", "Detected scope")).toBe(
      "feature",
    );
    // STRONGER: a keyword-less match also marks Source=freeform.
    expect(auditField(auditPath(p), "SCOPE_DETECTED", "Source")).toBe("freeform");
  });
});

// ============================================================
// detect-scope audit-row shape + backward-compat + collision (.sh §11-13)
// (covers: subcommand:aidlc-utility:detect-scope)
// ============================================================

describe("t67 detect-scope audit + backward-compat + collision (migrated from t67 §11-13)", () => {
  // §11: --from-text keyword match emits SCOPE_DETECTED with scope=bugfix,
  // Source=keyword, and a Matched keywords row.
  test("25: --from-text emits SCOPE_DETECTED scope=bugfix + Source=keyword", () => {
    const p = proj();
    const r = detectFromText("fix the login bug", p);
    expect(r.status).toBe(0);
    const f = auditPath(p);
    expect(auditEventCount(f, "SCOPE_DETECTED")).toBe(1); // STRONGER: exact count
    expect(auditField(f, "SCOPE_DETECTED", "Detected scope")).toBe("bugfix");
    expect(auditField(f, "SCOPE_DETECTED", "Source")).toBe("keyword");
  });

  test("26: keyword-match SCOPE_DETECTED includes Matched keywords field", () => {
    const p = proj();
    detectFromText("fix the login bug", p);
    const f = auditPath(p);
    // Whole-file presence (.sh used unanchored grep "Matched keywords").
    expect(fileContains(f, "Matched keywords")).toBe(true);
    // STRONGER: exact matched-keyword value.
    expect(auditField(f, "SCOPE_DETECTED", "Matched keywords")).toBe("fix");
  });

  // §12: backward-compat — pre-milestone-10 --scope path still emits SCOPE_DETECTED.
  test("27: --scope (pre-milestone-10 path) still emits SCOPE_DETECTED", () => {
    const p = proj();
    const r = util([
      "detect-scope",
      "--scope",
      "feature",
      "--input",
      "build a todo app",
      "--source",
      "freeform",
      "--project-dir",
      p,
    ]);
    expect(r.status).toBe(0);
    const f = auditPath(p);
    expect(auditEventCount(f, "SCOPE_DETECTED")).toBe(1); // STRONGER
    expect(auditField(f, "SCOPE_DETECTED", "Detected scope")).toBe("feature");
    expect(auditField(f, "SCOPE_DETECTED", "Source")).toBe("freeform");
  });

  // §13: flag collision — --scope + --from-text rejected.
  test("28: --scope + --from-text rejected with flag-collision error", () => {
    const p = proj();
    const r = util([
      "detect-scope",
      "--scope",
      "feature",
      "--from-text",
      "--input",
      "fix bug",
      "--project-dir",
      p,
    ]);
    // The .sh AND'd rc==1 with the grep; both asserted here.
    expect(r.status).toBe(1);
    expect(r.out).toContain("Cannot combine --from-text and --scope");
    // STRONGER: the rejected call emits NO SCOPE_DETECTED row.
    expect(auditEventCount(auditPath(p), "SCOPE_DETECTED")).toBe(0);
  });
});
