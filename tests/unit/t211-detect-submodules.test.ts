// covers: subcommand:aidlc-utility:intent-birth
//
// The workspace scanner's SIXTH brownfield signal: a parseable .gitmodules at
// the workspace root with >= 1 valid submodule path entry classifies the
// workspace Brownfield, even when the submodule dirs are empty/uninitialized.
// Before this, a submodule-only workspace scanned Greenfield -> reverse-
// engineering auto-skipped -> every design stage ran blind.
//
// Two mechanisms, one covers id (intent-birth, mechanism cli):
//  - CLI-boundary cases spawn `bun aidlc-utility.ts intent-birth --scope poc
//    --project-dir <p>` (t20's pattern) and read the state file / audit shard /
//    stdout — the observable contract of the birth pipeline (scan -> state +
//    audit + stdout warning).
//  - parseGitmodules unit cases import the pure exported parser in-process from
//    the dist tool (t37's idiom) — STRONGER than a stringified grep.
//
// poc's scope grid has reverse-engineering = EXECUTE, so a Brownfield birth
// keeps RE in scope and the greenfield->SKIP flip must NOT fire; a Greenfield
// birth (no .gitmodules) flips RE to SKIP with the "greenfield" annotation.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTestProject, createTestProject } from "../harness/fixtures.ts";
import { parseGitmodules } from "../../dist/claude/.claude/tools/aidlc-utility.ts";

const BUN = process.execPath; // the bun running this test
const REPO_ROOT = join(import.meta.dir, "..", "..");
const TOOL = join(REPO_ROOT, "dist", "claude", ".claude", "tools", "aidlc-utility.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

/** Fresh bare temp project (createTestProject scaffolds the workspace shell). */
function proj(): string {
  const p = createTestProject();
  tempDirs.push(p);
  return p;
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Spawn `bun aidlc-utility.ts intent-birth --scope poc --project-dir <p>`. */
function birth(p: string): CliResult {
  const res = spawnSync(
    BUN,
    [TOOL, "intent-birth", "--scope", "poc", "--project-dir", p],
    { encoding: "utf-8" },
  );
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

// Resolve the born intent's record dir from the active-space + active-intent
// cursors (mirrors t20's recordDirOf).
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

function stateContent(p: string): string {
  const f = join(recordDirOf(p), "aidlc-state.md");
  return existsSync(f) ? readFileSync(f, "utf-8") : "";
}

function stateField(p: string, key: string): string {
  const re = new RegExp(`^- \\*\\*${key}\\*\\*: (.*)$`, "m");
  const m = stateContent(p).match(re);
  return m ? m[1] : "";
}

function readAudit(p: string): string {
  const auditDir = join(recordDirOf(p), "audit");
  if (!existsSync(auditDir)) return "";
  return readdirSync(auditDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => readFileSync(join(auditDir, f), "utf-8"))
    .join("\n");
}

const GITMODULES_TWO = `[submodule "services/api"]
\tpath = services/api
\turl = https://example.com/api.git
[submodule "services/web"]
\tpath = services/web
\turl = https://example.com/web.git
`;

describe("t211 aidlc-utility intent-birth — git submodules as a brownfield signal", () => {
  // --- Case 1: .gitmodules + empty dirs -> Brownfield, RE stays EXECUTE, warned ---
  test("1: uninitialized submodules classify Brownfield with warning + RE EXECUTE", () => {
    const p = proj();
    writeFileSync(join(p, ".gitmodules"), GITMODULES_TWO, "utf-8");
    const r = birth(p);
    expect(r.status).toBe(0);

    // Brownfield classification, languages truthfully Unknown (dirs empty).
    expect(stateField(p, "Project Type")).toBe("Brownfield");
    expect(stateField(p, "Languages")).toBe("Unknown");

    // RE stays EXECUTE — the greenfield->SKIP flip must NOT have fired.
    expect(stateContent(p)).toContain("- [ ] reverse-engineering — EXECUTE");
    expect(stateField(p, "Stages to Skip")).not.toContain(
      "reverse-engineering — greenfield",
    );

    // Audit WORKSPACE_SCANNED carries the Submodules field + the remedy.
    const audit = readAudit(p);
    expect(audit).toContain("**Event**: WORKSPACE_SCANNED");
    expect(audit).toContain("**Submodules**: 2 declared, 2 uninitialized");
    expect(audit).toContain(
      "git submodule update --init --recursive",
    );

    // Birth stdout carries the warning line naming the remedy + paths.
    expect(r.stdout).toContain(
      "Warning: 2 uninitialized git submodule path(s) (services/api, services/web)",
    );
    expect(r.stdout).toContain("git submodule update --init --recursive");
  });

  // --- Case 2: no .gitmodules -> Greenfield unchanged, RE flips to SKIP ---
  test("2: no .gitmodules keeps Greenfield + RE SKIP (byte-stable no-submodule path)", () => {
    const p = proj();
    const r = birth(p);
    expect(r.status).toBe(0);

    expect(stateField(p, "Project Type")).toBe("Greenfield");
    // Greenfield flip fires: RE annotated greenfield in Stages-to-Skip.
    expect(stateField(p, "Stages to Skip")).toContain(
      "reverse-engineering — greenfield",
    );

    // No submodule surfaces: audit event has no Submodules field, no remedy,
    // and stdout carries no warning line.
    const audit = readAudit(p);
    expect(audit).toContain("**Event**: WORKSPACE_SCANNED");
    expect(audit).not.toContain("**Submodules**:");
    expect(audit).not.toContain("git submodule update");
    expect(r.stdout).not.toContain("Warning:");
    // The no-submodule Details stays byte-identical to the original event.
    expect(audit).toContain("**Details**: Deterministic rule-based scan\n");
  });

  // --- Case 3: malformed .gitmodules -> degrade to no-signal, never crash ---
  test("3: malformed .gitmodules degrades to Greenfield, exit 0, no warning", () => {
    const p = proj();
    writeFileSync(
      join(p, ".gitmodules"),
      "this is not valid ini @#$%\n=headerless\n[core]\nfoo=bar\n",
      "utf-8",
    );
    const r = birth(p);
    expect(r.status).toBe(0);
    expect(stateField(p, "Project Type")).toBe("Greenfield");
    expect(readAudit(p)).not.toContain("**Submodules**:");
    expect(r.stdout).not.toContain("Warning:");
  });

  // --- Case 4: .gitmodules + INITIALIZED dirs -> Brownfield, no warning ---
  test("4: initialized submodules classify Brownfield with no uninitialized warning", () => {
    const p = proj();
    writeFileSync(join(p, ".gitmodules"), GITMODULES_TWO, "utf-8");
    // The submodule shape: a dir holding a `.git` entry (file for a submodule).
    for (const sub of ["services/api", "services/web"]) {
      mkdirSync(join(p, sub), { recursive: true });
      writeFileSync(join(p, sub, ".git"), "gitdir: ../../.git/modules/x\n", "utf-8");
    }
    const r = birth(p);
    expect(r.status).toBe(0);
    expect(stateField(p, "Project Type")).toBe("Brownfield");

    const audit = readAudit(p);
    expect(audit).toContain("**Submodules**: 2 declared, 0 uninitialized");
    // No remedy in Details, no stdout warning when all are initialized.
    expect(audit).toContain("**Details**: Deterministic rule-based scan\n");
    expect(audit).not.toContain("git submodule update");
    expect(r.stdout).not.toContain("Warning:");
  });

  // --- Case 5: parseGitmodules unit cases (pure, in-process) ---
  describe("5: parseGitmodules parser", () => {
    test("multi-entry parse keeps name/path/url", () => {
      const out = parseGitmodules(GITMODULES_TWO);
      expect(out).toEqual([
        { name: "services/api", path: "services/api", url: "https://example.com/api.git" },
        { name: "services/web", path: "services/web", url: "https://example.com/web.git" },
      ]);
    });

    test("comments and unknown keys tolerated; url optional", () => {
      const out = parseGitmodules(
        `# a comment
; another comment
[submodule "lib"]
\tpath = lib/foo
\tbranch = main
`,
      );
      expect(out).toEqual([{ name: "lib", path: "lib/foo", url: "" }]);
    });

    test("entry without a path is dropped", () => {
      const out = parseGitmodules(
        `[submodule "nopath"]
\turl = https://example.com/x.git
`,
      );
      expect(out).toEqual([]);
    });

    test("absolute and ..-traversal paths are dropped", () => {
      const out = parseGitmodules(
        `[submodule "abs"]
\tpath = /etc/passwd
[submodule "up"]
\tpath = ../../escape
[submodule "ok"]
\tpath = pkg/ok
`,
      );
      expect(out).toEqual([{ name: "ok", path: "pkg/ok", url: "" }]);
    });

    test("non-submodule sections are ignored", () => {
      const out = parseGitmodules(
        `[core]
\tbare = false
[submodule "real"]
\tpath = real
`,
      );
      expect(out).toEqual([{ name: "real", path: "real", url: "" }]);
    });

    test("total garbage yields []", () => {
      expect(parseGitmodules("!!! not ini at all\n\n???")).toEqual([]);
      expect(parseGitmodules("")).toEqual([]);
    });
  });
});
