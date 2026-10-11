// covers: subcommand:aidlc-utility:scope-table, subcommand:aidlc-utility:detect-scope
//
// CLI-contract port of tests/unit/t67-scope-table.sh (TAP plan 28),
// mechanism = cli. Equal-or-stronger migration: every .sh assertion that
// shelled out to `bun aidlc-utility.ts scope-table ...` / `detect-scope ...`
// is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status / res.stdout / res.stderr
// and on the audit.md the tool writes — the PROCESS boundary, not in-process
// renderScopeTable() calls.
//
// NO KEYWORD INFERENCE: the .sh's `detect-scope --from-text` cases (keyword,
// word-boundary, fallback, empty input, the keyword audit rows and the
// --scope/--from-text collision; sections 7-11 and 13) went with the
// classifier. The engine no longer reads the person's words for a plan: the
// agent proposes it (`next --propose <plan> --request <id>`, pinned in
// t-plan-proposed-by-the-agent), and `--from-text` is refused as unknown.
//
// SUBCOMMAND UNITS: this .cli file credits BOTH subcommand units the .sh
// exercises — `scope-table` (emission shape, determinism, ordering, row count,
// --check clean/drift/missing-markers) and `detect-scope` (the explicit --scope
// path and its audit row). Both are fired here.
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
//       "| classic" row — all preserved as stdout .toContain() + STRONGER
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
//   §7-§11, §13 keyword inference, word boundaries, fallback, empty input,
//       keyword audit rows and the flag collision -> gone with the classifier
//       (see NO KEYWORD INFERENCE above).
//   §12 backward-compat --scope path (1 assert) -> Test 27: detect-scope --scope
//       feature --source freeform still emits SCOPE_DETECTED with
//       Detected scope=feature + Source=freeform (STRONGER: exact fields).
//
// FIXTURE DISCIPLINE (mirrors the .sh's create_test_project + cleanup_test_project
// per audit case, and mktemp for the drift/nomark SKILL.md sandboxes): each
// audit-emitting case uses a FRESH temp project dir (createTestProject, which
// toPortablePath-converts on Windows so audit.md — written by the tool via the
// forward-slash audit helper — round-trips when read back). The drift/nomark
// SKILL.md fixtures are mkdtemp'd temp FILES driven through AIDLC_SKILL_MD_PATH
// so the shipped SKILL.md is never touched. All temp dirs/files cleaned in
// afterAll. NOTHING is written under tests/fixtures/**.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

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

// P9: detect-scope's appendAuditEvent CREATES the bare SPACE record root's
// per-clone shard on first emit (no state seeded → no intent resolves → bare
// root); the SPAWNED tool mints its own clone-id, so reads glob every shard.
const readAudit = (p: string): string => readAllAuditShards(p);

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
  const res = spawnSync(BUN, [TOOL, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
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


/**
 * Value of <key> from the FIRST audit block whose `**Event**:` matches <ev>.
 * Resets at `## ` headings / `---`; splits `**label**: value` on `**: `.
 * Mirrors audit_field in the proven t31/t90 ports. Returns "" when absent.
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

/** Count audit blocks with `**Event**: <ev>` in a buffer. */
function auditEventCount(body: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return body
    .split("\n")
    .filter((l) => re.test(l)).length;
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
  "bugfix classic enterprise express feature infra mvp poc refactor security-patch workshop";

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

  test("5: scope-table output includes classic, workshop, and express rows", () => {
    expect(scopeTable().out).toContain("| classic");
    expect(scopeTable().out).toContain("| workshop");
    expect(scopeTable().out).toContain("| express");
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
    expect(rowCount).toBe(11);
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

  // skill-text prints the installed orchestrator skill whole, for a host whose
  // command template carries it (opencode cuts the skill tool's output at
  // 50 KiB). The same AIDLC_SKILL_MD_PATH seam the table checks read.
  test("13: skill-text prints the SKILL.md whole, byte for byte", () => {
    const r = util(["skill-text"]);
    expect(r.status, r.stderr).toBe(0);
    const skill = readFileSync(SKILL, "utf-8");
    expect(r.stdout).toBe(skill.endsWith("\n") ? skill : `${skill}\n`);
    const seam = join(mkdtempSync(join(tmpdir(), "t67-skill-text-")), "skill.md");
    tempFiles.push(seam);
    writeFileSync(seam, "# a skill\n\nwith `!NAME!` kept as written\n", "utf-8");
    expect(util(["skill-text"], seam).stdout).toBe("# a skill\n\nwith `!NAME!` kept as written\n");
    // The harness the caller names must be a harness folder name.
    const bad = util(["skill-text", "--harness-dir", "not a folder"]);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain("--harness-dir");
  });
});

// ============================================================
// detect-scope audit-row shape + backward-compat + collision (.sh §11-13)
// (covers: subcommand:aidlc-utility:detect-scope)
// ============================================================

describe("t67 detect-scope audit + backward-compat + collision (migrated from t67 §11-13)", () => {
  // §11: --from-text keyword match emits SCOPE_DETECTED with scope=bugfix,
  // Source=keyword, and a Matched keywords row.
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
    const f = readAudit(p);
    expect(auditEventCount(f, "SCOPE_DETECTED")).toBe(1); // STRONGER
    expect(auditField(f, "SCOPE_DETECTED", "Detected scope")).toBe("feature");
    expect(auditField(f, "SCOPE_DETECTED", "Source")).toBe("freeform");
  });


});
