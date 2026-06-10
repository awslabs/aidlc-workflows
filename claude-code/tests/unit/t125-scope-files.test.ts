// covers: function:validScopes, function:loadScopeMetadata, function:loadScopeMapping, function:scalarField, cli:aidlc-utility(detect-scope)
//
// t125 — scope files: validScopes() + scope metadata derive from
// .claude/scopes/aidlc-<name>.md presence (milestone 12). Migrated from
// tests/unit/t125-scope-files.sh (TAP plan 10, 13 bun spawns).
//
// A scope is authored as one .claude/scopes/aidlc-<name>.md file
// (frontmatter name/depth/keywords/description[/testStrategy], prose body).
// Dropping a file makes the scope valid with no code change; removing one
// drops it. depth/keywords/description come from the .md frontmatter; the
// EXECUTE/SKIP grid comes from the compiled scope-grid.json (the transpose).
//
// Mechanism: MIXED.
//   * tests 1-8, 10 import the real loader functions from aidlc-lib.ts and
//     assert in-process (mechanism none) — these are pure structural reads of
//     the shipped .claude/scopes/*.md frontmatter + scope-grid.json. The
//     dropped-file dynamics (7, 8) drive the AIDLC_SCOPES_DIR env-seam in
//     process: the loader reads it at CALL time (aidlc-lib.ts:713-715), so a
//     set-env + _resetScopeMappingForTests() reload exercises the exact
//     fixture seam the .sh drove through child `bun -e` invocations — without
//     the spawn overhead. This is STRONGER than the .sh: it asserts the
//     derived ScopeDefinition shape (stages map present) too, not just the name.
//   * test 9 SPAWNS the real `aidlc-utility.ts detect-scope --from-text` CLI
//     (mechanism cli) — the SCOPE_DETECTED audit-emit + the keyword resolution
//     of a dropped scope's .md is a process-boundary contract (appendAuditEvent
//     -> appendAuditEntry writes audit.md; aidlc-utility.ts:2767). The dropped
//     scope is resolved end-to-end through validScopes()/inferScopeFromText in
//     a real process with AIDLC_SCOPES_DIR pointed at the sandbox scopes dir.
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-lib.ts
//     :713 scopesDir()           — AIDLC_SCOPES_DIR ?? <pkg>/../scopes (call-time)
//     :760 loadScopeMetadata()   — reads name/depth/keywords/description/
//                                   testStrategy from each aidlc-*.md frontmatter
//     :802 loadScopeMapping()    — merges scope-grid.json (.stages) + .md metadata
//     :854 _resetScopeMappingForTests() — clears the metadata/mapping/validScopes caches
//     :872 validScopes()         — Object.keys(loadScopeMapping()).sort()
//     :932 scalarField(fm, key)  — zero-dep frontmatter scalar parser
//   dist/claude/.claude/tools/aidlc-graph.ts
//     :209 loadScopeGrid()       — the compiled EXECUTE/SKIP grid (grid columns)
//   dist/claude/.claude/tools/aidlc-utility.ts
//     :2703 handleDetectScope()  — --from-text resolves via inferScopeFromText,
//                                   emits SCOPE_DETECTED with **Detected scope**: <s>
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh test 1  (9 shipped scope files)                     -> "exactly 9 shipped aidlc-*.md scope files exist"
//   .sh test 2  (frontmatter name == filename stem)          -> "every shipped scope file's frontmatter name == its slug"
//   .sh test 3  (validScopes() == 9 names, alphabetical)     -> "validScopes() == the 9 .md-derived names, alphabetical"
//   .sh test 4  (loadScopeMetadata bugfix depth/kw/desc)     -> "loadScopeMetadata reads bugfix depth/keywords/description from .md"
//   .sh test 5  (workshop testStrategy override)             -> "loadScopeMetadata reads workshop's testStrategy override from .md"
//   .sh test 6  (loadScopeMapping poc derived fields)        -> "loadScopeMapping poc depth/keywords/description derive from .md"
//   .sh test 7  (dropping a new .md makes it valid)          -> "dropping aidlc-dropscope.md makes 'dropscope' a valid scope (no code change)"
//   .sh test 8  (isolated dir with one file -> one scope)    -> "isolated AIDLC_SCOPES_DIR with one file yields exactly that scope"
//   .sh test 9  (detect-scope --from-text resolves keyword)  -> "detect-scope --from-text resolves a dropped scope's keyword from its .md (CLI audit)"
//   .sh test 10 (grid columns subset of authored .md names)  -> "every scope-grid column has a matching .claude/scopes/*.md file"

import { afterEach, describe, expect, test } from "bun:test";
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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadScopeMapping,
  loadScopeMetadata,
  scalarField,
  validScopes,
  _resetScopeMappingForTests,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { loadScopeGrid } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const SCOPES_DIR = join(AIDLC_SRC, "scopes");
const UTIL = fileURLToPath(
  new URL("../../dist/claude/.claude/tools/aidlc-utility.ts", import.meta.url),
);

// The 9 scopes the framework ships, alphabetical — the .sh's hard-coded
// expectation (t125:62). Each is a literal independent of source iteration.
const SHIPPED_SCOPES = [
  "bugfix",
  "enterprise",
  "feature",
  "infra",
  "mvp",
  "poc",
  "refactor",
  "security-patch",
  "workshop",
];

// The dropscope fixture .md body (byte-for-byte the .sh heredoc, t125:93-105).
const DROPSCOPE_MD = `---
name: dropscope
depth: Minimal
keywords:
  - dropscopetrigger
description: Dropped scope for t125
---

# dropscope

Proves a dropped .md file becomes a valid scope.
`;

// Tests that drive the AIDLC_SCOPES_DIR env-seam must restore the env + reset
// the lib caches afterwards so the in-process shipped-tree tests (and any
// sibling test in the same bun process) see the real scopes dir again.
afterEach(() => {
  delete process.env.AIDLC_SCOPES_DIR;
  _resetScopeMappingForTests();
});

describe("shipped scope files — frontmatter + derived metadata (in-process)", () => {
  test("exactly 9 shipped aidlc-*.md scope files exist [.sh test 1]", () => {
    const files = readdirSync(SCOPES_DIR).filter(
      (f) => f.startsWith("aidlc-") && f.endsWith(".md"),
    );
    expect(files.length).toBe(9);
  });

  test("every shipped scope file's frontmatter name == its slug [.sh test 2]", () => {
    // STRONGER than the .sh's accumulate-then-compare: assert each file
    // individually so a mismatch names the offending slug.
    const files = readdirSync(SCOPES_DIR)
      .filter((f) => f.startsWith("aidlc-") && f.endsWith(".md"))
      .sort();
    for (const f of files) {
      const slug = basename(f, ".md").replace(/^aidlc-/, "");
      const raw = readFileSync(join(SCOPES_DIR, f), "utf-8");
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(m).not.toBeNull();
      // Same scalarField primitive the .sh invoked via `bun -e`.
      expect(scalarField(m![1], "name")).toBe(slug);
    }
  });

  test("validScopes() == the 9 .md-derived names, alphabetical [.sh test 3]", () => {
    expect([...validScopes()]).toEqual(SHIPPED_SCOPES);
  });

  test("loadScopeMetadata reads bugfix depth/keywords/description from .md [.sh test 4]", () => {
    const m = loadScopeMetadata();
    expect(m.bugfix.depth).toBe("Minimal");
    expect(m.bugfix.keywords).toEqual(["fix", "bug", "broken"]);
    expect(m.bugfix.description).toBe("Fix a specific bug");
  });

  test("loadScopeMetadata reads workshop's testStrategy override from .md [.sh test 5]", () => {
    // workshop is the only shipped scope carrying a testStrategy override.
    expect(loadScopeMetadata().workshop.testStrategy).toBe("Minimal");
  });

  test("loadScopeMapping poc depth/keywords/description derive from .md [.sh test 6]", () => {
    const m = loadScopeMapping();
    expect(m.poc.depth).toBe("Minimal");
    expect(m.poc.keywords).toEqual([
      "proof of concept",
      "prototype",
      "poc",
      "spike",
    ]);
    expect(m.poc.description).toBe("Prove feasibility fast");
    // STRONGER than the .sh: the derived ScopeDefinition also carries the
    // EXECUTE/SKIP `.stages` half from the compiled grid (the transpose).
    expect(typeof m.poc.stages).toBe("object");
    expect(Object.keys(m.poc.stages).length).toBeGreaterThan(0);
  });

  test("every scope-grid column has a matching .claude/scopes/*.md file [.sh test 10]", () => {
    const gridCols = Object.keys(loadScopeGrid()).sort();
    const fileNames = readdirSync(SCOPES_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/^aidlc-/, "").replace(/\.md$/, ""))
      .sort();
    const orphanCols = gridCols.filter((c) => !fileNames.includes(c));
    // Every authored grid column must be backed by a scope .md file.
    expect(orphanCols).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dropped-file dynamics — the AIDLC_SCOPES_DIR seam (tests 7, 8 in-process;
// test 9 spawns the real CLI). The seam is read at call time
// (aidlc-lib.ts:713), so set-env + _resetScopeMappingForTests() reloads the
// scope set from a fixture dir within this same process.
// ---------------------------------------------------------------------------
describe("dropped-file scope dynamics (AIDLC_SCOPES_DIR seam)", () => {
  const tempDirs: string[] = [];
  const projects: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
    for (const p of projects.splice(0)) cleanupTestProject(p);
  });

  test("dropping aidlc-dropscope.md makes 'dropscope' a valid scope (no code change) [.sh test 7]", () => {
    // Mirror the .sh sandbox: a full integration project, then drop a NEW
    // scope .md into its .claude/scopes/ and point the loader at that dir.
    const proj = setupIntegrationProject({
      noAidlcDocs: true,
      stripEnvScope: true,
    });
    projects.push(proj);
    const projScopes = join(proj, ".claude", "scopes");
    writeFileSync(join(projScopes, "aidlc-dropscope.md"), DROPSCOPE_MD, "utf-8");

    process.env.AIDLC_SCOPES_DIR = projScopes;
    _resetScopeMappingForTests();

    const scopes = [...validScopes()];
    // The drop made it valid with zero code change...
    expect(scopes).toContain("dropscope");
    // ...alongside all 9 shipped scopes that were copied into the sandbox.
    for (const s of SHIPPED_SCOPES) expect(scopes).toContain(s);
  });

  test("isolated AIDLC_SCOPES_DIR with one file yields exactly that scope [.sh test 8]", () => {
    // An isolated dir holding ONLY aidlc-dropscope.md: validScopes() must
    // collapse to exactly that one scope (proves removing files drops scopes).
    const iso = mkdtempSync(join(tmpdir(), "aidlc-t125-iso-"));
    tempDirs.push(iso);
    writeFileSync(join(iso, "aidlc-dropscope.md"), DROPSCOPE_MD, "utf-8");

    process.env.AIDLC_SCOPES_DIR = iso;
    _resetScopeMappingForTests();

    expect([...validScopes()]).toEqual(["dropscope"]);
  });

  test("detect-scope --from-text resolves a dropped scope's keyword from its .md (CLI audit) [.sh test 9]", () => {
    // Process-boundary contract: the dropped scope's keyword resolves through
    // a REAL aidlc-utility detect-scope run with AIDLC_SCOPES_DIR pointed at
    // the sandbox scopes dir, and the SCOPE_DETECTED audit row names it. The
    // sandbox strips aidlc-docs/; appendAuditEntry re-creates audit.md.
    const proj = setupIntegrationProject({
      noAidlcDocs: true,
      stripEnvScope: true,
    });
    projects.push(proj);
    const projScopes = join(proj, ".claude", "scopes");
    writeFileSync(join(projScopes, "aidlc-dropscope.md"), DROPSCOPE_MD, "utf-8");

    const res = spawnSync(
      BUN,
      [
        UTIL,
        "detect-scope",
        "--from-text",
        "--input",
        "dropscopetrigger",
        "--project-dir",
        proj,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, AIDLC_SCOPES_DIR: projScopes },
      },
    );
    expect(res.status).toBe(0);

    const auditPath = join(proj, "aidlc-docs", "audit.md");
    expect(existsSync(auditPath)).toBe(true);
    const audit = readFileSync(auditPath, "utf-8");
    // Same grep the .sh ran: a "Detected scope ... : dropscope" line. The tool
    // writes it as "**Detected scope**: dropscope".
    expect(/Detected scope.*: dropscope/.test(audit)).toBe(true);
    // STRONGER: it landed as a SCOPE_DETECTED event sourced from the keyword,
    // and stdout echoes the resolved scope.
    expect(audit).toContain("**Event**: SCOPE_DETECTED");
    expect(res.stdout).toContain('"scope":"dropscope"');
  });
});
