// covers: stage:initialization/workspace-detection
//
// t203: nested-project workspace detection + the greenfield advisory for
// incremental scopes. Mechanism: none for the detectWorkspace cases (pure
// in-process over hand-built temp trees), cli for the advisory cases (they
// spawn the real intent-birth tool to observe its stderr). Technique:
// known-answer.
//
// TWO fixes are pinned here.
//
//   1. detectWorkspace NESTED-PROJECT FALLBACK (#462). The scanner classified a
//      project Greenfield whenever its source lived one level down in an
//      arbitrarily-named container (e.g. wordbook/), because every signal was
//      root-relative and the recursion allowlist was a fixed six-name set. When
//      no top-level signal fires, the scanner now re-applies the same signal set
//      one level into each depth-1 subdirectory (skipping dot-dirs,
//      NESTED_SCAN_EXCLUDE, the SCAN_SOURCE_DIRS entries already scanned at the
//      root, symlinks, and non-dirs), aggregates every hit, and records the hit
//      dir(s) in ScanResult.nestedRoot. Root behavior is byte-identical for a
//      normal top-level layout, so the fallback never runs then.
//
//   2. The GREENFIELD ADVISORY (#438). An incremental scope (bugfix/refactor/
//      security-patch) presumes existing code. We do NOT override routing (an
//      empty workspace genuinely has nothing to reverse-engineer, and forcing
//      Brownfield would break the greenfield RE-skip pins). Instead intent-birth
//      writes a one-line stderr advisory when such a scope scans Greenfield,
//      pointing the user at fixing Project Type or the layout. Routing is
//      unchanged: reverse-engineering still greenfield-SKIPs.
//
// detectWorkspace is a pure function of the directory tree, so each detection
// case builds a FRESH mkdtemp dir, writes the signal files inline, and reads the
// classified ScanResult back in-process. The advisory cases spawn the shipped
// intent-birth tool against a scaffolded temp project and read its stderr. All
// temp dirs are removed in afterAll. NOTHING is written under tests/fixtures/**.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestProject } from "../harness/fixtures.ts";
import { detectWorkspace } from "../../dist/claude/.claude/tools/aidlc-utility.ts";

const BUN = process.execPath;
const REPO_ROOT = join(import.meta.dir, "..", "..");
const UTIL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

/** A fresh empty temp dir (no scaffold; detectWorkspace scans the bare tree). */
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aidlc-t203-"));
  tempDirs.push(d);
  return d;
}

/** Write a file, creating parent dirs. Path segments are joined under `root`. */
function put(root: string, rel: string[], body: string): void {
  const full = join(root, ...rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf-8");
}

const PKG_REACT = JSON.stringify({ name: "x", dependencies: { react: "^18.0.0" } });

describe("t203 nested-project detection (the depth-1 fallback)", () => {
  test("nested wordbook/package.json + src -> Brownfield with nestedRoot", () => {
    const d = tmp();
    put(d, ["wordbook", "package.json"], PKG_REACT);
    put(d, ["wordbook", "src", "app.ts"], "export const app = 1;\n");
    const scan = detectWorkspace(d);
    expect(scan.projectType).toBe("Brownfield");
    expect(scan.nestedRoot).toBe("wordbook");
    // The nested subdir's findings merge into the result.
    expect(scan.languages).toContain("TypeScript");
    expect(scan.frameworks).toContain("React");
  });

  test("deep backend/server/main.go -> Brownfield with nestedRoot", () => {
    const d = tmp();
    put(d, ["backend", "server", "main.go"], "package main\n");
    const scan = detectWorkspace(d);
    expect(scan.projectType).toBe("Brownfield");
    expect(scan.nestedRoot).toBe("backend");
    expect(scan.languages).toContain("Go");
  });

  test("manifest-only svc/go.mod -> Brownfield (manifest signal, no source files)", () => {
    const d = tmp();
    put(d, ["svc", "go.mod"], "module x\n");
    const scan = detectWorkspace(d);
    expect(scan.projectType).toBe("Brownfield");
    expect(scan.nestedRoot).toBe("svc");
  });

  test("empty dir -> Greenfield, no nestedRoot", () => {
    const d = tmp();
    const scan = detectWorkspace(d);
    expect(scan.projectType).toBe("Greenfield");
    expect(scan.nestedRoot).toBeUndefined();
    expect(scan.languages).toBe("Unknown");
  });

  test("top-level project (root src/) unchanged: Brownfield, no nestedRoot (fallback does not fire)", () => {
    const d = tmp();
    put(d, ["src", "app.ts"], "export const app = 1;\n");
    const scan = detectWorkspace(d);
    expect(scan.projectType).toBe("Brownfield");
    expect(scan.nestedRoot).toBeUndefined();
    expect(scan.languages).toContain("TypeScript");
  });

  test("excluded-dirs-only (docs, examples, scripts, .github) -> Greenfield (no false positive)", () => {
    const d = tmp();
    for (const dir of ["docs", "examples", "scripts", ".github"]) {
      put(d, [dir, "sample.py"], "print(1)\n");
    }
    const scan = detectWorkspace(d);
    expect(scan.projectType).toBe("Greenfield");
    expect(scan.nestedRoot).toBeUndefined();
  });

  test("two nested repos -> Brownfield, both recorded in nestedRoot (sorted)", () => {
    const d = tmp();
    for (const repo of ["web", "api"]) {
      put(d, [repo, "src", "m.ts"], "export const z = 1;\n");
    }
    const scan = detectWorkspace(d);
    expect(scan.projectType).toBe("Brownfield");
    expect(scan.nestedRoot).toBe("api, web");
  });

  test("a symlinked subdirectory is skipped by the fallback", () => {
    const d = tmp();
    const real = tmp();
    put(real, ["src", "a.ts"], "export const q = 1;\n");
    symlinkSync(real, join(d, "linked"));
    expect(detectWorkspace(d).projectType).toBe("Greenfield");
  });
});

// P4: intent-birth writes state into the born intent's per-intent record dir.
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

/** Birth a scope on a bare (empty, Greenfield) scaffolded project. */
function birth(scope: string): { stderr: string; stateFile: string } {
  const p = createTestProject();
  tempDirs.push(p);
  const r = spawnSync(
    BUN,
    [UTIL, "intent-birth", "--scope", scope, "--project-dir", p],
    { encoding: "utf-8" },
  );
  expect(r.status).toBe(0);
  const sp = join(recordDirOf(p), "aidlc-state.md");
  return { stderr: r.stderr ?? "", stateFile: existsSync(sp) ? readFileSync(sp, "utf-8") : "" };
}

describe("t203 greenfield advisory (incremental scopes, no routing override)", () => {
  test("bugfix on an empty workspace stays Greenfield, RE SKIP, and emits the stderr advisory", () => {
    const { stderr, stateFile } = birth("bugfix");
    // Routing is UNCHANGED: still Greenfield, reverse-engineering still SKIPs.
    expect(stateFile).toContain("- **Project Type**: Greenfield");
    // The greenfield RE-skip annotation in the Stages-to-Skip row. The shipped
    // annotation joins slug and reason with an em dash, so match the two ends
    // rather than transcribing the punctuation.
    expect(stateFile).toMatch(/\(reverse-engineering .* greenfield\)/);
    expect(stateFile).toMatch(/- \[ \] reverse-engineering .* SKIP/);
    // The advisory fired on stderr (not stdout).
    expect(stderr).toContain('scope "bugfix"');
    expect(stderr.toLowerCase()).toContain("greenfield");
    expect(stderr).toContain("Project Type");
  });

  test("poc on an empty workspace stays Greenfield and emits NO advisory (not an incremental scope)", () => {
    const { stderr, stateFile } = birth("poc");
    expect(stateFile).toContain("- **Project Type**: Greenfield");
    expect(stderr).not.toContain("usually targets existing code");
  });
});
