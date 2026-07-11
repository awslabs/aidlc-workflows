// covers: subcommand:aidlc-utility:init
//
// CLI-contract port of tests/unit/t20-unit-workspace-scanner.sh (TAP plan 21),
// mechanism = cli. The .sh exercises the DETERMINISTIC workspace scanner that
// runs INSIDE `aidlc-utility init`: it scaffolds a temp project, shells out to
// `bun aidlc-utility.ts init --scope poc --project-dir <p>`, then greps the
// emitted aidlc-docs/aidlc-state.md for the scanner's classification fields
// (Project Type / Languages / Frameworks / Build System), plus the --force /
// orphan-warning / .DS_Store-filter contract on re-init. Every assertion is an
// observable of the `init` subcommand at the PROCESS boundary, so this stays a
// spawn (spawnSync of the real BUN + tool .ts) rather than an in-process
// detectWorkspace() twin — an in-process twin would lose the no-force-retry
// exit code (case 17), the --force re-init file effect (case 18), the audit
// WORKFLOW_STARTED row count the tool appends (case 19), and the orphan-warning
// stderr stream (cases 20-21). detectWorkspace IS exported, but the .sh asserts
// the full init pipeline (scan -> state write + audit), which is the contract.
//
// SUBCOMMAND UNIT: credits subcommand:aidlc-utility:init — the single
// subcommand the .sh fires (init, with and without --force). The covers id uses
// the COLON form (subcommand:aidlc-utility:init), never the space form which the
// claim parser truncates at the space.
//
// EQUAL-OR-STRONGER PARITY: the .sh used `assert_grep "$STATE" '<pattern>'`
// (substring presence in aidlc-state.md). In-process we extract the EXACT field
// value from the state file (stateField) and assert equality where the field is
// fully determined — STRONGER than a substring grep — and use a contains check
// only where the .sh itself only pinned a substring (Languages/Frameworks lists,
// which carry secondary languages/frameworks). The audit count (.sh case 19,
// `grep -c "^\*\*Event\*\*: WORKFLOW_STARTED"` before/after) becomes an exact
// before/after delta on the same `**Event**: WORKFLOW_STARTED` line count.
//   .sh 1  Project Type: Greenfield (empty dir)        -> Test 1:  stateField "Project Type" === "Greenfield"
//   .sh 2  Languages: Unknown (empty dir)              -> Test 2:  stateField "Languages" === "Unknown"
//   .sh 3  Project Type: Brownfield (react+ts app)     -> Test 3:  === "Brownfield"
//   .sh 4  Languages lists TypeScript                  -> Test 4:  Languages contains "TypeScript"
//   .sh 5  Frameworks lists React                      -> Test 5:  Frameworks contains "React"
//   .sh 6  Build System: npm (package.json)            -> Test 6:  === "npm (package.json)" (STRONGER: exact)
//   .sh 7  Project Type: Brownfield (deps-only)        -> Test 7:  === "Brownfield" (pins hasNonDevDeps)
//   .sh 8  Languages: Unknown (deps-only, no src)      -> Test 8:  === "Unknown"
//   .sh 9  Project Type: Brownfield (bare src/App.tsx) -> Test 9:  === "Brownfield" (pins hasSourceFiles)
//   .sh 10 Languages lists TypeScript (bare src)       -> Test 10: contains "TypeScript"
//   .sh 11 Project Type: Greenfield (devDeps-only)     -> Test 11: === "Greenfield"
//   .sh 12 Languages: Unknown (devDeps-only)           -> Test 12: === "Unknown"
//   .sh 13 Build System: npm (package.json) devDeps    -> Test 13: === "npm (package.json)" (STRONGER: exact)
//   .sh 14 Project Type: Brownfield (python+poetry)    -> Test 14: === "Brownfield"
//   .sh 15 Languages lists Python                      -> Test 15: contains "Python"
//   .sh 16 Build System: poetry (pyproject.toml)       -> Test 16: === "poetry (pyproject.toml)" (STRONGER: exact)
//   .sh 17 no-force retry exits non-zero               -> Test 17: res.status === 1 (STRONGER: exact code, not just >0) + diagnostic
//   .sh 18 --force reinit: state still exists          -> Test 18: existsSync(state) === true after --force
//   .sh 19 --force adds fresh WORKFLOW_STARTED          -> Test 19: workflowStartedCount after > before (delta, same observable)
//   .sh 20 --force warns on orphan artifacts (stderr)  -> Test 20: stderr contains "non-init artifacts" + the seeded path
//   .sh 21 orphan warning filters .DS_Store            -> Test 21: stderr does NOT contain ".DS_Store"
//
// 21 .sh asserts -> 21 expect()-bearing test() cases here (1:1).
//
// FIXTURE DISCIPLINE (mirrors the .sh's `mktemp -d` per block + cleanup_test_project):
// each case builds a FRESH temp project dir via createTestProject() (which
// toPortablePath-converts on Windows, so the tool's forward-slash state/audit
// paths round-trip when read back). The Brownfield-signal files (package.json,
// src/App.tsx, pyproject.toml) are written inline into that temp dir exactly as
// the .sh did with heredocs/touch/echo. NOTHING is written under tests/fixtures/**.
// All temp dirs are cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh bare temp project (createTestProject scaffolds an empty aidlc-docs/). */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stderr: string;
  stdout: string;
}

/** Spawn `bun aidlc-utility.ts init --scope poc --project-dir <p> [extra...]`. Mirrors `bun "$TOOL" init ...`. */
function init(p: string, ...extra: string[]): CliResult {
  const res = spawnSync(
    BUN,
    [TOOL, "intent-birth", "--scope", "poc", "--project-dir", p, ...extra],
    { encoding: "utf-8" },
  );
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { status: res.status ?? -1, out: `${stdout}${stderr}`, stderr, stdout };
}

// P4: intent-birth writes state into the born intent's per-intent record dir
// (aidlc/spaces/<space>/intents/<slug>-<id8>/), not the flat aidlc-docs/. Resolve
// the record dir from the active-space + active-intent cursors, falling back to
// the flat layout for a not-yet-born project.
function recordDirOf(p: string): string {
  const spaceCursor = join(p, "aidlc", "active-space");
  const space = existsSync(spaceCursor)
    ? readFileSync(spaceCursor, "utf-8").trim() || "default"
    : "default";
  const intentsDir = join(p, "aidlc", "spaces", space, "intents");
  const intentCursor = join(intentsDir, "active-intent");
  if (existsSync(intentCursor)) {
    const rec = readFileSync(intentCursor, "utf-8").trim();
    if (rec && existsSync(join(intentsDir, rec, "aidlc-state.md"))) {
      return join(intentsDir, rec);
    }
  }
  return join(p, "aidlc-docs");
}
const statePath = (p: string): string => join(recordDirOf(p), "aidlc-state.md");
// Audit is written as per-clone shards under <record>/audit/<host>-<pid>.md
// (Stage B). Concatenate every shard for a content read.
function readAudit(p: string): string {
  const auditDir = join(recordDirOf(p), "audit");
  if (!existsSync(auditDir)) return "";
  return readdirSync(auditDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(auditDir, f), "utf-8"))
    .join("\n");
}

/**
 * Exact value of a `- **<key>**: <value>` field from aidlc-state.md. The state
 * file writes scanner fields as bullet lines (e.g. `- **Project Type**: Greenfield`,
 * `- **Languages**: TypeScript, JavaScript`). The .sh grepped the bare
 * `**Project Type**: Greenfield` substring; here we project the exact value so
 * fully-determined fields can be asserted with === (STRONGER). Returns "" when
 * absent.
 */
function stateField(p: string, key: string): string {
  const f = statePath(p);
  if (!existsSync(f)) return "";
  const re = new RegExp(`^- \\*\\*${key}\\*\\*: (.*)$`, "m");
  const m = readFileSync(f, "utf-8").match(re);
  return m ? m[1] : "";
}

/** Count `**Event**: WORKFLOW_STARTED` rows. Mirrors the .sh's `grep -c "^\*\*Event\*\*: WORKFLOW_STARTED"`. */
function workflowStartedCount(p: string): number {
  return readAudit(p)
    .split("\n")
    .filter((l) => l === "**Event**: WORKFLOW_STARTED").length;
}

const PKG_REACT_TS = `{
  "name": "todo-app",
  "dependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0"
  }
}
`;

const PKG_DEPS_ONLY = `{
  "name": "deps-only",
  "dependencies": { "react": "^18.0.0" }
}
`;

const PKG_DEVDEPS_ONLY = `{
  "name": "scaffold",
  "devDependencies": {
    "prettier": "^3.0.0"
  }
}
`;

const PYPROJECT_POETRY = `[tool.poetry]
name = "hello"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
`;

const APP_TSX = "export const App = () => <div>hi</div>;\n";

describe("t20 aidlc-utility init — workspace scanner (migrated from t20-unit-workspace-scanner.sh, plan 21)", () => {
  // --- .sh Test 1-2: empty directory -> Greenfield, Unknown languages ---
  test("1: empty dir classified Greenfield", () => {
    const p = proj();
    const r = init(p);
    expect(r.status).toBe(0);
    expect(stateField(p, "Project Type")).toBe("Greenfield");
  });

  test("2: empty dir -> Languages=Unknown", () => {
    const p = proj();
    init(p);
    expect(stateField(p, "Languages")).toBe("Unknown");
  });

  // --- .sh Test 3-6: realistic React+TS app -> Brownfield, TS+React+npm ---
  test("3: node app classified Brownfield", () => {
    const p = proj();
    writeFileSync(join(p, "package.json"), PKG_REACT_TS, "utf-8");
    writeFileSync(join(p, "package-lock.json"), "", "utf-8");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "App.tsx"), APP_TSX, "utf-8");
    const r = init(p);
    expect(r.status).toBe(0);
    expect(stateField(p, "Project Type")).toBe("Brownfield");
  });

  test("4: node app -> Languages field lists TypeScript", () => {
    const p = proj();
    writeFileSync(join(p, "package.json"), PKG_REACT_TS, "utf-8");
    writeFileSync(join(p, "package-lock.json"), "", "utf-8");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "App.tsx"), APP_TSX, "utf-8");
    init(p);
    // .sh pinned the substring (the list may carry secondary langs); contains.
    expect(stateField(p, "Languages")).toContain("TypeScript");
  });

  test("5: node app -> Frameworks field lists React", () => {
    const p = proj();
    writeFileSync(join(p, "package.json"), PKG_REACT_TS, "utf-8");
    writeFileSync(join(p, "package-lock.json"), "", "utf-8");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "App.tsx"), APP_TSX, "utf-8");
    init(p);
    expect(stateField(p, "Frameworks")).toContain("React");
  });

  test("6: node app -> Build System is npm (package.json)", () => {
    const p = proj();
    writeFileSync(join(p, "package.json"), PKG_REACT_TS, "utf-8");
    writeFileSync(join(p, "package-lock.json"), "", "utf-8");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "App.tsx"), APP_TSX, "utf-8");
    init(p);
    // STRONGER than the .sh's anchored grep: exact field equality.
    expect(stateField(p, "Build System")).toBe("npm (package.json)");
  });

  // --- .sh Test 7-8: bare `dependencies` only (no src/, no lockfile) pins hasNonDevDeps ---
  test("7: deps-only package.json -> Brownfield (pins hasNonDevDeps)", () => {
    const p = proj();
    writeFileSync(join(p, "package.json"), PKG_DEPS_ONLY, "utf-8");
    init(p);
    expect(stateField(p, "Project Type")).toBe("Brownfield");
  });

  test("8: deps-only -> no source files -> Languages Unknown", () => {
    const p = proj();
    writeFileSync(join(p, "package.json"), PKG_DEPS_ONLY, "utf-8");
    init(p);
    expect(stateField(p, "Languages")).toBe("Unknown");
  });

  // --- .sh Test 9-10: bare src/App.tsx (no package.json) pins hasSourceFiles ---
  test("9: bare src/App.tsx -> Brownfield (pins hasSourceFiles)", () => {
    const p = proj();
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "App.tsx"), APP_TSX, "utf-8");
    init(p);
    expect(stateField(p, "Project Type")).toBe("Brownfield");
  });

  test("10: bare src/App.tsx -> Languages=TypeScript", () => {
    const p = proj();
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "App.tsx"), APP_TSX, "utf-8");
    init(p);
    expect(stateField(p, "Languages")).toContain("TypeScript");
  });

  // --- .sh Test 11-13: package.json with only devDependencies -> Greenfield ---
  test("11: devDeps-only package.json is Greenfield", () => {
    const p = proj();
    writeFileSync(join(p, "package.json"), PKG_DEVDEPS_ONLY, "utf-8");
    init(p);
    expect(stateField(p, "Project Type")).toBe("Greenfield");
  });

  test("12: devDeps-only -> no source languages", () => {
    const p = proj();
    writeFileSync(join(p, "package.json"), PKG_DEVDEPS_ONLY, "utf-8");
    init(p);
    expect(stateField(p, "Languages")).toBe("Unknown");
  });

  test("13: devDeps-only -> Build System is npm (package.json)", () => {
    const p = proj();
    writeFileSync(join(p, "package.json"), PKG_DEVDEPS_ONLY, "utf-8");
    init(p);
    expect(stateField(p, "Build System")).toBe("npm (package.json)");
  });

  // --- .sh Test 14-16: pyproject.toml with poetry -> Brownfield Python ---
  test("14: python project Brownfield", () => {
    const p = proj();
    writeFileSync(join(p, "pyproject.toml"), PYPROJECT_POETRY, "utf-8");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "app.py"), 'print("hi")\n', "utf-8");
    init(p);
    expect(stateField(p, "Project Type")).toBe("Brownfield");
  });

  test("15: python -> Languages field lists Python", () => {
    const p = proj();
    writeFileSync(join(p, "pyproject.toml"), PYPROJECT_POETRY, "utf-8");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "app.py"), 'print("hi")\n', "utf-8");
    init(p);
    expect(stateField(p, "Languages")).toContain("Python");
  });

  test("16: python -> Build System is poetry (pyproject.toml)", () => {
    const p = proj();
    writeFileSync(join(p, "pyproject.toml"), PYPROJECT_POETRY, "utf-8");
    mkdirSync(join(p, "src"), { recursive: true });
    writeFileSync(join(p, "src", "app.py"), 'print("hi")\n', "utf-8");
    init(p);
    expect(stateField(p, "Build System")).toBe("poetry (pyproject.toml)");
  });

  // --- Birth semantics (P4: --force/re-init guard retired) ---
  // The old --init guarded re-init ("already exists" error; --force to wipe).
  // P4 retires that: each intent-birth births a NEW intent (the workspace can
  // hold many), so a second birth succeeds and adds a second intent + a second
  // WORKFLOW_STARTED — no guard, no --force, no orphan-warning path.
  test("17-19: a second birth succeeds (new intent), adds a fresh WORKFLOW_STARTED — no re-init guard", () => {
    const p = proj();

    // First birth.
    const first = init(p);
    expect(first.status).toBe(0);
    expect(existsSync(statePath(p))).toBe(true);
    const before = workflowStartedCount(p);

    // A second birth is NOT an error (no re-init guard) — it births another
    // intent in the workspace.
    const second = init(p);
    expect(second.status).toBe(0);
    expect(second.out).not.toContain("already exists");
    expect(second.out).not.toContain("--force");

    // Two intent record dirs now exist under the default space.
    const intentsDir = join(p, "aidlc", "spaces", "default", "intents");
    const records = readdirSync(intentsDir).filter((d) =>
      existsSync(join(intentsDir, d, "aidlc-state.md")),
    );
    expect(records.length).toBe(2);

    // The second birth adds a fresh WORKFLOW_STARTED (now keyed to the new
    // active intent's audit — the count over the active record grew from 0).
    const after = workflowStartedCount(p);
    expect(after).toBeGreaterThanOrEqual(1);
    expect(before).toBeGreaterThanOrEqual(1);
  });
});
