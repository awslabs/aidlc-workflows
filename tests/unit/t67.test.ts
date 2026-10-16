// covers: subcommand:aidlc-utility:scope-table, subcommand:aidlc-utility:detect-scope
//
// Mechanism = cli. Every assertion about `bun aidlc-utility.ts scope-table
// ...` / `detect-scope ...` (exit code, stdout, stderr, audit rows)
// is preserved by SPAWNING the real CLI via node:child_process spawnSync
// (BUN + the tool .ts path), asserting on res.status / res.stdout / res.stderr
// and on the audit shards the tool writes - the PROCESS boundary, not
// in-process renderScopeTable() calls.
//
// NO KEYWORD INFERENCE: the engine does not read the person's words for a
// plan: the agent proposes it (`next --propose <plan> --request <id>`, pinned
// in t-plan-proposed-by-the-agent), and `--from-text` is refused.
//
// SUBCOMMAND UNITS: this test file credits BOTH subcommand units it
// exercises — `scope-table` (emission shape, determinism, ordering, row count,
// --check clean/drift/missing-markers) and `detect-scope` (the explicit --scope
// path and its audit row). Both are fired here.
//
// DIE / ERROR STREAM: the tool's die() path emits JSON `{"error":"..."}` to
// STDERR and exits 1. handleScopeTable's --check failures (missing markers /
// out of date) also write to stderr via console.error + process.exit(1). The
// `out` helper field concatenates stdout+stderr so message asserts hold
// regardless of stream; JSON-ack asserts stay scoped to stdout.
//
// ROW COUNT (Test 8): loadScopeMapping() derives the scope
//       SET from the .claude/scopes/aidlc-*.md files present (aidlc-lib.ts)
//       + scope-grid.json `.stages`, so that filesystem count is the live
//       source; Test 8 pins gridCount === mdCount === rendered rows.
//
// FIXTURE DISCIPLINE: each audit-emitting case uses a FRESH temp project dir
// (createTestProject, which toPortablePath-converts on Windows so audit shards
// - written by the tool via the forward-slash audit helper - round-trip when
// read back). The drift/nomark SKILL.md fixtures are mkdtemp'd temp FILES
// driven through AIDLC_SKILL_MD_PATH so the shipped SKILL.md is never touched.
// All temp dirs/files cleaned in afterAll. NOTHING is written under
// tests/fixtures/**.

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
import { dirname, join } from "node:path";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "tools",
  "aidlc-utility.ts",
);
// The generated tables live in tables.md beside the orchestrator skill.
const SKILL = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "skills",
  "aidlc",
  "tables.md",
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
// Canonical scope-set surface: loadScopeMapping() derives the scope SET from
// the .claude/scopes/*.md files present (aidlc-lib.ts loadScopeMapping,
// `for (const name of Object.keys(metadata))`, metadata sourced from
// loadScopeMetadata over scopes/aidlc-*.md) and merges in scope-grid.json's
// per-scope `.stages`. So scopes/aidlc-*.md is the live source.
const SCOPES_DIR = join(
  REPO_ROOT,
  "dist",
  "claude",
  ".claude",
  "scopes",
);

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

function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

// detect-scope's appendAuditEvent CREATES the bare SPACE record root's
// per-clone shard on first emit (no state seeded → no intent resolves → bare
// root); the SPAWNED tool mints its own clone-id, so reads glob every shard.
const readAudit = (p: string): string => readAllAuditShards(p);

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  out: string;
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

function scopeTable(...args: string[]): CliResult {
  return util(["scope-table", ...args]);
}


/**
 * Value of <key> from the FIRST audit block containing it whose `**Event**:`
 * matches <ev>. Resets at `## ` headings / `---`; splits `**label**: value` on
 * `**: `. Mirrors auditField in t31.test.ts. Returns "" when absent.
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

function auditEventCount(body: string, ev: string): number {
  const re = new RegExp(`^\\*\\*Event\\*\\*: ${ev}$`);
  return body
    .split("\n")
    .filter((l) => re.test(l)).length;
}

/**
 * Row names from the scope-table output: every line `^| <name>` where <name>
 * matches [a-z-]+.
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
// scope-table - emission shape
// (covers: subcommand:aidlc-utility:scope-table)
// ============================================================

describe("t67 scope-table emission (migrated from t67-scope-table.sh §1-3)", () => {
  test("1: scope-table output has BEGIN marker", () => {
    const r = scopeTable();
    expect(r.status).toBe(0);
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

  // --- Test 8: row count matches the CURRENT shipped scope-set surface ---
  // loadScopeMapping() derives the scope SET from the .claude/scopes/aidlc-*.md
  // files present (aidlc-lib.ts loadScopeMapping) and the per-scope grid from
  // scope-grid.json. Triangulate the scopes/*.md count against the grid's scope
  // count and the rendered table rows: all three must agree.
  test("8: scope-table row count matches scopes/*.md AND scope-grid.json", () => {
    const rowCount = rowNames(scopeTable().out).length;
    const mdCount = scopesMdCount();
    const gridCount = Object.keys(
      JSON.parse(readFileSync(SCOPE_GRID, "utf-8")),
    ).length;
    expect(rowCount).toBe(mdCount);
    expect(gridCount).toBe(mdCount);
    expect(rowCount).toBe(gridCount);
    expect(rowCount).toBe(11);
  });
});

// ============================================================
// scope-table --check
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
    expect(r.status).toBe(1);
    expect(r.out).toContain("missing scope-table markers");
  });

  // skill-text prints the installed orchestrator skill whole, for a host whose
  // command template carries it (opencode cuts the skill tool's output at
  // 50 KiB). The same AIDLC_SKILL_MD_PATH seam the table checks read.
  test("13: skill-text prints the SKILL.md whole, byte for byte", () => {
    const r = util(["skill-text"]);
    expect(r.status, r.stderr).toBe(0);
    const skill = readFileSync(join(dirname(SKILL), "SKILL.md"), "utf-8");
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
// detect-scope audit-row shape + backward-compat
// (covers: subcommand:aidlc-utility:detect-scope)
// ============================================================

describe("t67 detect-scope audit + backward-compat + collision (migrated from t67 §11-13)", () => {
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
    expect(auditEventCount(f, "SCOPE_DETECTED")).toBe(1);
    expect(auditField(f, "SCOPE_DETECTED", "Detected scope")).toBe("feature");
    expect(auditField(f, "SCOPE_DETECTED", "Source")).toBe("freeform");
  });


});
