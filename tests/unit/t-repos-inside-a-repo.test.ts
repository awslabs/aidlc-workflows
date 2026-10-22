// covers: function:walkWorkspaceSource
//
// Repos inside a workspace that is a repo of its own (#2410, item 1): the
// workspace repo records its packages under src/ as gitlinks, with no
// .gitmodules, and repos.json maps the workspace as "." and each package by its
// path. Each file is listed once, under its own repo, so two Units that each
// claim their own package's write complete Code Generation under every Guard
// Policy, nobody is told a claimed file changed outside the Units, and an edit
// after a review names the file once; the workspace keeps its own files. With
// only the packages mapped, the folder over them keeps the multi-repo rule,
// whether it is a repo or not.

import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAllAuditShards, workspaceSourceListing, writeBaselineSourceSnapshot } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { AIDLC_SRC, FIXTURES_DIR, resetAidlcEnv } from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
resetAidlcEnv();

const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const REVIEWER = "aidlc-architecture-reviewer-agent";
const D = String.fromCharCode(0x2014);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, args: string[]): void {
  const result = spawnSync("git", ["-C", dir, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

function repoAt(dir: string, name: string): void {
  mkdirSync(join(dir, "lib"), { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@test"]);
  git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  writeFileSync(join(dir, "lib", "index.ts"), `export const name = "${name}";\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "init"]);
}

// The workspace at Code Generation, its two Units (alpha, beta) planned, the
// stage's start recorded. `"."`: repos.json maps the workspace too.
function workspace(
  options: { mapsRoot: boolean; rootIsRepo?: boolean; policy?: "strict" | "relaxed" | "off" },
): { project: string; record: string } {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "aidlc-t-repos-inside-")));
  dirs.push(project);
  const intents = join(project, "aidlc", "spaces", "default", "intents");
  const record = join(intents, "fixture-intent");
  mkdirSync(record, { recursive: true });
  const repos = options.mapsRoot ? ["pkg-a", "pkg-b", "shop"] : ["pkg-a", "pkg-b"];
  writeFileSync(join(intents, "intents.json"), `${JSON.stringify([{ uuid: "80000000-0000-4000-8000-000000000001", slug: "fixture", dirName: "fixture-intent", status: "active", repos }])}\n`);
  writeFileSync(join(intents, ".active-intent"), "fixture-intent\n");
  writeFileSync(join(project, "README.md"), "# shop\n");
  mkdirSync(join(project, "docs"), { recursive: true });
  writeFileSync(join(project, "docs", "guide.md"), "The shop's own guide.\n");
  for (const pkg of ["pkg-a", "pkg-b"]) repoAt(join(project, "src", pkg), pkg);
  const entries = [{ name: "pkg-a", url: "", path: "src/pkg-a" }, { name: "pkg-b", url: "", path: "src/pkg-b" }];
  if (options.mapsRoot) entries.unshift({ name: "shop", url: "", path: "." });
  writeFileSync(join(project, "repos.json"), `${JSON.stringify({ repos: entries }, null, 2)}\n`);
  if (options.rootIsRepo ?? true) {
    git(project, ["init", "-q", "-b", "main"]);
    git(project, ["config", "user.email", "t@test"]);
    git(project, ["config", "user.name", "t"]);
    // Each package is a gitlink in the workspace's own repo; no .gitmodules.
    git(project, ["add", "README.md", "docs", "repos.json", "src/pkg-a", "src/pkg-b"]);
    git(project, ["commit", "-qm", "the shop with its packages"]);
  }
  const state = readFileSync(join(FIXTURES_DIR, "state-mid-ideation.md"), "utf-8")
    .replace("- **Current Stage**: feasibility", "- **Current Stage**: code-generation\n- **Construction Iteration**: stage-major")
    .replace(`- [ ] code-generation ${D} EXECUTE`, `- [?] code-generation ${D} EXECUTE`)
    .replace(/^- \*\*Change Control\*\*: .*$/m, `- **Guard Policy**: ${options.policy ?? "strict"} (set by you)`);
  writeFileSync(join(record, "aidlc-state.md"), state);
  const dag = join(record, "inception", "units-generation");
  mkdirSync(dag, { recursive: true });
  writeFileSync(join(dag, "unit-of-work-dependency.md"), "```yaml\nunits:\n  - name: alpha\n    depends_on: []\n  - name: beta\n    depends_on: []\n```\n");
  const listing = workspaceSourceListing(project);
  if (listing === null) throw new Error("the fixture's source listing is missing");
  const baseline = writeBaselineSourceSnapshot(project, "code-generation", listing);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, project);
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", Agent: "aidlc-developer-agent", "Source Baseline": baseline }, project);
  // Audit timestamps are second-precision; the CLI rows below land after the start.
  const second = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === second) {}
  return { project, record };
}

function cli(tool: string, args: string[], project: string): { rc: number; out: string } {
  const env = { ...process.env, AIDLC_SKIP_ARTIFACT_GUARD: "1", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1", AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_REVISION_BACKSTOP: "1" };
  const r = spawnSync(process.execPath, [tool, ...args, "--project-dir", project], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// A Unit's manifest and its review, recorded READY.
function review(project: string, record: string, unit: string, writes: Array<{ repo: string; path: string }>): void {
  const dir = join(record, "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  for (const name of ["unit-test-instructions.md", "code-summary.md"]) writeFileSync(join(dir, name), `# ${name}\n`);
  writeFileSync(join(dir, "traceability.json"), "{}\n");
  writeFileSync(join(dir, "code-generation-plan.md"), "# Plan\n");
  writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({ stage: "code-generation", unit, version: 1, writes })}\n`);
  const args = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", unit, "--iteration", "1"];
  const request = cli(LOG, args, project);
  expect(request.rc, request.out).toBe(0);
  writeFileSync(join(dir, "code-generation-plan.md"), `# Plan\n\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
  const verdict = cli(LOG, [...args, "--verdict", "READY"], project);
  expect(verdict.rc, verdict.out).toBe(0);
}

// Each Unit writes in its own package and claims it.
function bothUnitsBuilt(project: string, record: string): void {
  writeFileSync(join(project, "src", "pkg-a", "lib", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(project, "src", "pkg-b", "lib", "b.ts"), "export const b = 1;\n");
  review(project, record, "alpha", [{ repo: "pkg-a", path: "lib/a.ts" }]);
  review(project, record, "beta", [{ repo: "pkg-b", path: "lib/b.ts" }]);
}

function approve(project: string): { rc: number; out: string; notices: string[] } {
  const result = cli(STATE, ["approve", "code-generation", "--user-input", "ship"], project);
  const notices = result.out.split("\n").flatMap((line) => {
    try {
      return ((JSON.parse(line) as { change_notices?: string[] }).change_notices ?? []);
    } catch {
      return [];
    }
  });
  return { ...result, notices };
}

// The listing's keys, `<repo>|<path>`.
function listed(project: string): string[] {
  return [...(workspaceSourceListing(project)?.keys() ?? [])].map((key) => key.replace("\0", "|")).sort();
}

describe("the workspace repo mapped as \".\" with its packages under src/", () => {
  test("each package's files are listed once, under the package, and the workspace keeps its own", () => {
    const { project } = workspace({ mapsRoot: true });
    expect(listed(project)).toEqual([
      "pkg-a|README.md",
      "pkg-a|lib/index.ts",
      "pkg-b|README.md",
      "pkg-b|lib/index.ts",
      "shop|README.md",
      "shop|docs/guide.md",
      "shop|repos.json",
    ]);
  });

  test("Guard Policy strict: two Units, each claiming its own package's write, complete Code Generation", () => {
    const { project, record } = workspace({ mapsRoot: true });
    bothUnitsBuilt(project, record);
    const approved = approve(project);
    expect(approved.out).not.toContain("no Unit's review covers");
    expect(approved.rc, approved.out).toBe(0);
  });

  for (const policy of ["relaxed", "off"] as const) {
    test(`Guard Policy ${policy}: nobody is told a claimed file changed outside the Units, and none is recorded as kept`, () => {
      const { project, record } = workspace({ mapsRoot: true, policy });
      bothUnitsBuilt(project, record);
      const approved = approve(project);
      expect(approved.rc, approved.out).toBe(0);
      expect(approved.notices).toEqual([]);
      expect(readAllAuditShards(project)).not.toContain("**Event**: CHANGE_ACCEPTED");
    });
  }

  test("an edit after the review names the file once", () => {
    const { project, record } = workspace({ mapsRoot: true, policy: "relaxed" });
    bothUnitsBuilt(project, record);
    writeFileSync(join(project, "src", "pkg-a", "lib", "a.ts"), "export const a = 2;\n");
    const approved = approve(project);
    expect(approved.rc, approved.out).toBe(0);
    expect(approved.notices).toEqual(["pkg-a/lib/a.ts changed after the alpha Unit was reviewed; carrying on."]);
  });
});

describe("only the packages mapped", () => {
  for (const rootIsRepo of [true, false]) {
    test(`the folder over them, ${rootIsRepo ? "a repo of its own" : "not a repo"}, lists its top-level files and leaves its folders out`, () => {
      const { project } = workspace({ mapsRoot: false, rootIsRepo });
      expect(listed(project)).toEqual([
        "pkg-a|README.md",
        "pkg-a|lib/index.ts",
        "pkg-b|README.md",
        "pkg-b|lib/index.ts",
        "|README.md",
        "|repos.json",
      ].sort());
    });
  }
});
