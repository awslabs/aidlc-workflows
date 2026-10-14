// covers: subcommand:aidlc-utility:init
//
// CLI-contract test of the DETERMINISTIC workspace scanner that runs INSIDE
// `aidlc-utility intent-create`, mechanism = cli. Each case scaffolds a temp
// project, spawns `bun aidlc-utility.ts intent-create --scope poc --project-dir
// <p>`, then reads the created intent's aidlc-state.md for the scanner's
// classification fields (Project Type / Languages / Frameworks / Build System).
// Every assertion is an observable of the subcommand at the PROCESS boundary
// (scan -> state write + audit), so this stays a spawn (spawnSync of the real
// BUN + tool .ts) rather than an in-process detectWorkspace() twin.
//
// SUBCOMMAND UNIT: credits subcommand:aidlc-utility:init — the single
// subcommand the .sh fires (init, with and without --force). The covers id uses
// the COLON form (subcommand:aidlc-utility:init), never the space form which the
// claim parser truncates at the space.
//
// FIXTURE DISCIPLINE: each case builds a FRESH temp project dir via
// createTestProject() (which toPortablePath-converts on Windows, so the tool's
// forward-slash state/audit paths round-trip when read back). The
// Brownfield-signal files (package.json, src/App.tsx, pyproject.toml) are written
// inline into that temp dir. NOTHING is written under tests/fixtures/**. All temp
// dirs are cleaned in afterAll.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterAll, describe, expect, test, setDefaultTimeout } from "bun:test";
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

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr
  stderr: string;
  stdout: string;
}

function init(p: string, ...extra: string[]): CliResult {
  const res = spawnSync(
    BUN,
    [TOOL, "intent-create", "--scope", "poc", "--project-dir", p, ...extra],
    { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" },
  );
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { status: res.status ?? -1, out: `${stdout}${stderr}`, stderr, stdout };
}

// intent-create writes state into the created intent's per-intent record dir
// (aidlc/spaces/<space>/intents/<YYMMDD>-<label>/), not the flat aidlc-docs/.
// Resolve the record dir from the active-space + active-intent cursors, falling
// back to the flat layout for a not-yet-created project.
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
// Audit is written as per-clone shards under <record>/audit/<host>-<clone-id>.md.
// Concatenate every shard for a content read.
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
 * `- **Languages**: TypeScript, JavaScript`). We project the exact value so
 * fully-determined fields can be asserted with ===. Returns "" when
 * absent.
 */
function stateField(p: string, key: string): string {
  const f = statePath(p);
  if (!existsSync(f)) return "";
  const re = new RegExp(`^- \\*\\*${key}\\*\\*: (.*)$`, "m");
  const m = readFileSync(f, "utf-8").match(re);
  return m ? m[1] : "";
}

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
  // --- Empty directory -> Greenfield, Unknown languages ---
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

  // --- Realistic React+TS app -> Brownfield, TS+React+npm ---
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
    // The list may carry secondary langs; contains.
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
    expect(stateField(p, "Build System")).toBe("npm (package.json)");
  });

  // --- Bare `dependencies` only (no src/, no lockfile) pins hasNonDevDeps ---
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

  // --- Bare src/App.tsx (no package.json) pins hasSourceFiles ---
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

  // --- package.json with only devDependencies -> Greenfield ---
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

  // --- pyproject.toml with poetry -> Brownfield Python ---
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

  // --- Creation semantics ---
  // Each intent-create creates a NEW intent (the workspace can hold many), so a
  // second creation succeeds and adds a second intent + a second
  // WORKFLOW_STARTED: no guard, no --force, no orphan-warning path.
  test("17-19: a second creation succeeds (new intent), adds a fresh WORKFLOW_STARTED - no re-init guard", () => {
    const p = proj();

    const first = init(p);
    expect(first.status).toBe(0);
    expect(existsSync(statePath(p))).toBe(true);
    const before = workflowStartedCount(p);

    const second = init(p);
    expect(second.status).toBe(0);
    expect(second.out).not.toContain("already exists");
    expect(second.out).not.toContain("--force");

    const intentsDir = join(p, "aidlc", "spaces", "default", "intents");
    const records = readdirSync(intentsDir).filter((d) =>
      existsSync(join(intentsDir, d, "aidlc-state.md")),
    );
    expect(records.length).toBe(2);

    // The second creation adds a fresh WORKFLOW_STARTED in the new active intent's
    // audit; `before` and `after` read different active records, so each is >= 1
    // rather than a delta.
    const after = workflowStartedCount(p);
    expect(after).toBeGreaterThanOrEqual(1);
    expect(before).toBeGreaterThanOrEqual(1);
  });
});
