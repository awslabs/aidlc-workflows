// covers: scope:workshop, function:validScopes, function:loadScopeMetadata, function:loadScopeMapping, function:scalarField, cli:aidlc-utility(detect-scope)
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
//     process: the loader reads it at CALL time (aidlc-lib.ts), so a
//     set-env + _resetScopeMappingForTests() reload exercises the exact
//     fixture seam the .sh drove through child `bun -e` invocations — without
//     the spawn overhead. This is STRONGER than the .sh: it asserts the
//     derived ScopeDefinition shape (stages map present) too, not just the name.
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-lib.ts
//     scopesDir()                  - AIDLC_SCOPES_DIR ?? <pkg>/../scopes (call-time)
//     loadScopeMetadata()          - reads name/depth/keywords/description/
//                                    testStrategy from each aidlc-*.md frontmatter
//     loadScopeMapping()           - merges scope-grid.json (.stages) + .md metadata
//     _resetScopeMappingForTests() - clears the metadata/mapping/validScopes caches
//     validScopes()                - Object.keys(loadScopeMapping()).sort()
//     scalarField(fm, key)         - zero-dep frontmatter scalar parser
//   dist/claude/.claude/tools/aidlc-graph.ts
//     loadScopeGrid()              - the compiled EXECUTE/SKIP grid (grid columns)
//

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS } from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
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
import {
  loadScopeMapping,
  loadScopeMetadata,
  scalarField,
  validScopes,
  _resetScopeMappingForTests,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { loadScopeGrid } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { cleanupTestProject, setupIntegrationProject } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO_ROOT = join(import.meta.dir, "..", "..");
const AIDLC_SRC = join(REPO_ROOT, "dist", "claude", ".claude");
const SCOPES_DIR = join(AIDLC_SRC, "scopes");

// The 11 scopes the framework ships, alphabetical. Each is a literal
// independent of source iteration.
const SHIPPED_SCOPES = [
  "bugfix",
  "classic",
  "enterprise",
  "express",
  "feature",
  "infra",
  "mvp",
  "poc",
  "refactor",
  "security-patch",
  "workshop",
];

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
  test("exactly 11 shipped aidlc-*.md scope files exist [.sh test 1]", () => {
    const files = readdirSync(SCOPES_DIR).filter(
      (f) => f.startsWith("aidlc-") && f.endsWith(".md"),
    );
    expect(files.length).toBe(11);
  });

  test("every shipped scope file's frontmatter name == its slug [.sh test 2]", () => {
    // Assert each file individually so a mismatch names the offending slug.
    const files = readdirSync(SCOPES_DIR)
      .filter((f) => f.startsWith("aidlc-") && f.endsWith(".md"))
      .sort();
    for (const f of files) {
      const slug = basename(f, ".md").replace(/^aidlc-/, "");
      const raw = readFileSync(join(SCOPES_DIR, f), "utf-8");
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      expect(m).not.toBeNull();
      expect(scalarField(m![1], "name")).toBe(slug);
    }
  });

  test("validScopes() == the 11 .md-derived names, alphabetical [.sh test 3]", () => {
    expect([...validScopes()]).toEqual(SHIPPED_SCOPES);
  });

  test("loadScopeMetadata reads bugfix depth/keywords/description from .md [.sh test 4]", () => {
    const m = loadScopeMetadata();
    expect(m.bugfix.depth).toBe("Minimal");
    expect(m.bugfix.keywords).toEqual(["fix", "bug", "broken", "bugfix"]);
    expect(m.bugfix.description).toBe("Fix a specific bug");
  });

  test("loadScopeMetadata reads classic without a testStrategy override [.sh test 5]", () => {
    expect(loadScopeMetadata().classic.testStrategy).toBeUndefined();
  });

  test("loadScopeMetadata preserves the Workshop Minimal test override", () => {
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
    // The derived ScopeDefinition also carries the EXECUTE/SKIP `.stages` half
    // from the compiled grid (the transpose).
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
    expect(orphanCols).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Dropped-file dynamics - the AIDLC_SCOPES_DIR seam (in-process). The seam is
// read at call time (aidlc-lib.ts scopesDir), so set-env +
// _resetScopeMappingForTests() reloads the scope set from a fixture dir within
// this same process.
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
    expect(scopes).toContain("dropscope");
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
});
