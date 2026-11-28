// covers: subcommand:aidlc-utility:codekb-source, file:core/aidlc-common/stages/inception/reverse-engineering.md, file:core/knowledge/aidlc-developer-agent/re-artifacts.md, file:core/knowledge/aidlc-developer-agent/code-knowledge-sources.md
//
// A team may already keep a code graph of a repository that a tool outside
// AI-DLC built. Reverse Engineering reads it before it opens the code when it
// is registered for the repo: `codekb-source` lists the space's registered
// sources for a repo with a freshness verdict each (CURRENT when the commit
// the source records is the repo's HEAD, STALE for another commit, UNKNOWN
// when none can be read, MISSING when the folder is not here); `add` and
// `remove` keep `aidlc/spaces/<space>/codekb-sources.json` under the codekb
// lock, audit first (CODEKB_SOURCE_CHANGED), and say one line with the way
// back. Spawned as the real CLI surface, through the utility and through the
// `engine workspace codekb-source` route. The prose halves are pinned too: the
// stage names the command and the verdict rules, and the developer's template
// carries the Sources read line, else the tool's output is never read.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  AIDLC_SRC,
  REPO_ROOT,
  cleanupTestProject,
  createTestProject,
  DEFAULT_SPACE,
  resetAidlcEnv,
} from "../harness/fixtures.ts";
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { readAllAuditShards } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const UTILITY = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const DISPATCHER = join(AIDLC_SRC, "tools", "aidlc.ts");

const created: string[] = [];
afterAll(() => {
  while (created.length) {
    const dir = created.pop() as string;
    if (dir.includes("aidlc-test-")) cleanupTestProject(dir);
    else rmSync(dir, { recursive: true, force: true });
  }
});

const childEnv = (): NodeJS.ProcessEnv => {
  const e = { ...process.env };
  delete e.AWS_AIDLC_DEFAULT_SCOPE;
  return e;
};

function run(tool: string, args: string[], proj: string) {
  return spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: childEnv(),
  });
}

const utility = (proj: string, ...args: string[]) => run(UTILITY, ["codekb-source", ...args], proj);

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

// A project that is a Git checkout with one commit, so HEAD exists.
function committedProject(): { proj: string; head: string } {
  const proj = createTestProject();
  created.push(proj);
  git(proj, "init", "-q");
  writeFileSync(join(proj, "app.py"), "print(1)\n");
  git(proj, "add", "app.py");
  git(proj, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "a");
  return { proj, head: git(proj, "rev-parse", "HEAD") };
}

// A graph folder as an extractor writes it: nodes.jsonl opening with the
// provenance line that names the commit it was built from. Hundreds of record
// lines follow in a real graph; two stand in for them here.
function writeGraph(dir: string, commit: string | null): void {
  mkdirSync(dir, { recursive: true });
  const provenance = { _provenance: { schemaVersion: "1.7.0", stream: "nodes", repo: "web", commit, branch: "main", extractor: "tree-sitter", extractorVersion: "0.3.0", extractedAt: "2026-10-29T14:02:11Z" } };
  writeFileSync(join(dir, "nodes.jsonl"), [JSON.stringify(provenance), '{"id":"file:app.py","type":"File","name":"app.py","language":"python","filePath":"app.py"}', ""].join("\n"));
  writeFileSync(join(dir, "edges.jsonl"), `${JSON.stringify({ ...provenance, _provenance: { ...provenance._provenance, stream: "edges" } })}\n`);
}

const registryPath = (proj: string) => join(proj, "aidlc", "spaces", DEFAULT_SPACE, "codekb-sources.json");

describe("codekb-source lists the registered sources for a repo with a verdict each", () => {
  test("nothing registered: an empty list, and one plain line", () => {
    const { proj, head } = committedProject();
    const json = utility(proj, "--json");
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({ repo: basename(proj), head_commit: head, sources: [] });
    const human = utility(proj);
    expect(human.stdout.trim()).toBe(`No code-knowledge source is registered for ${basename(proj)}.`);
  });

  test("add records the source, audits it first, and the list reads CURRENT when its commit is HEAD", () => {
    const { proj, head } = committedProject();
    const repo = basename(proj);
    // The graph sits outside the project, as an assessment tool leaves it.
    const outside = mkdtempSync(join(tmpdir(), "aidlc-codekb-source-"));
    created.push(outside);
    const graph = join(outside, "graph-out", "graph", repo);
    writeGraph(graph, head.slice(0, 12));
    const guide = join(".claude", "knowledge", "aidlc-developer-agent", "example-source.md");
    mkdirSync(join(proj, ".claude", "knowledge", "aidlc-developer-agent"), { recursive: true });
    writeFileSync(join(proj, guide), "# Reading the example source\n");

    const added = utility(proj, "add", "--kind", "example-graph", "--path", graph, "--commit-file", "nodes.jsonl", "--commit-field", "_provenance.commit", "--guide", guide);
    expect(added.status, added.stderr).toBe(0);
    expect(added.stdout).toContain(`Recorded example-graph at ${graph} as a code-knowledge source for ${repo}.`);
    expect(added.stdout).toContain("built from the commit checked out");
    expect(added.stdout).toContain(`codekb-source remove --repo ${repo} --kind example-graph`);

    const registry = JSON.parse(readFileSync(registryPath(proj), "utf-8"));
    expect(registry).toEqual({
      version: 1,
      sources: [{ repo, kind: "example-graph", path: graph, commit: { file: "nodes.jsonl", field: "_provenance.commit" }, guide }],
    });
    const audit = readAllAuditShards(proj);
    expect(audit).toContain("CODEKB_SOURCE_CHANGED");
    expect(audit).toContain("**Added**: example-graph");
    expect(audit).toContain(`**Repo**: ${repo}`);

    const listed = JSON.parse(utility(proj, "--json").stdout);
    expect(listed.head_commit).toBe(head);
    expect(listed.sources).toHaveLength(1);
    expect(listed.sources[0]).toMatchObject({
      kind: "example-graph",
      path: graph,
      dir: graph,
      present: true,
      commit: head.slice(0, 12),
      verdict: "CURRENT",
      guide,
      guide_present: true,
    });
    const human = utility(proj);
    expect(human.stdout.trim()).toBe(`example-graph: ${graph} (commit ${head.slice(0, 12)}, CURRENT; guide ${guide})`);

    // The engine route reaches the same verb.
    const routed = run(DISPATCHER, ["engine", "workspace", "codekb-source", "--json"], proj);
    expect(routed.status, routed.stderr).toBe(0);
    expect(JSON.parse(routed.stdout)).toEqual(listed);
  });

  test("another commit reads STALE, no readable commit reads UNKNOWN, a folder that is not here reads MISSING", () => {
    const { proj, head } = committedProject();
    writeGraph(join(proj, "graphs", "stale"), "0123456789abcdef0123456789abcdef01234567");
    writeGraph(join(proj, "graphs", "no-commit"), null);
    writeGraph(join(proj, "graphs", "no-locator"), head);
    for (const [kind, path, locator] of [
      ["stale-graph", "graphs/stale", true],
      ["unknown-graph", "graphs/no-commit", true],
      ["bare-graph", "graphs/no-locator", false],
      ["missing-graph", "graphs/not-here", true],
    ] as const) {
      const args = ["add", "--kind", kind, "--path", path, ...(locator ? ["--commit-file", "nodes.jsonl", "--commit-field", "_provenance.commit"] : [])];
      const r = utility(proj, ...args);
      expect(r.status, r.stderr).toBe(0);
    }
    const verdicts = Object.fromEntries(
      (JSON.parse(utility(proj, "--json").stdout).sources as Array<{ kind: string; verdict: string; commit: string | null; present: boolean }>)
        .map((s) => [s.kind, s]),
    );
    expect(verdicts["stale-graph"]).toMatchObject({ verdict: "STALE", present: true, commit: "0123456789abcdef0123456789abcdef01234567" });
    expect(verdicts["unknown-graph"]).toMatchObject({ verdict: "UNKNOWN", present: true, commit: null });
    expect(verdicts["bare-graph"]).toMatchObject({ verdict: "UNKNOWN", present: true, commit: null });
    expect(verdicts["missing-graph"]).toMatchObject({ verdict: "MISSING", present: false, commit: null, dir: join(proj, "graphs", "not-here") });
    const human = utility(proj).stdout;
    expect(human).toContain("stale-graph: graphs/stale (commit 0123456789ab, STALE)");
    expect(human).toContain("unknown-graph: graphs/no-commit (no commit recorded, UNKNOWN)");
    expect(human).toContain("missing-graph: graphs/not-here (no commit recorded, MISSING)");
    // The add line says what the verdict means for the scan.
    const missing = utility(proj, "add", "--kind", "missing-graph", "--path", "graphs/not-here");
    expect(missing.stdout).toContain("The folder is not on this machine yet");
    const stale = utility(proj, "add", "--kind", "stale-graph", "--path", "graphs/stale", "--commit-file", "nodes.jsonl", "--commit-field", "_provenance.commit");
    expect(stale.stdout).toContain("is not the one checked out");
    // The repo's own repeat of a kind replaces the earlier entry, never a second one.
    expect(JSON.parse(utility(proj, "--json").stdout).sources).toHaveLength(4);
    expect(verdicts["missing-graph"]).toBeDefined();
  });

  test("remove takes the source out, audited, and says how to add it back; a second remove changes nothing", () => {
    const { proj } = committedProject();
    const repo = basename(proj);
    writeGraph(join(proj, "graphs", "g"), null);
    expect(utility(proj, "add", "--kind", "example-graph", "--path", "graphs/g").status).toBe(0);
    const removed = utility(proj, "remove", "--kind", "example-graph");
    expect(removed.status, removed.stderr).toBe(0);
    expect(removed.stdout).toContain(`Removed the example-graph source at graphs/g for ${repo}`);
    expect(removed.stdout).toContain(`codekb-source add --repo ${repo} --kind example-graph --path graphs/g`);
    expect(JSON.parse(readFileSync(registryPath(proj), "utf-8")).sources).toEqual([]);
    expect(readAllAuditShards(proj)).toContain("**Removed**: example-graph");
    const again = utility(proj, "remove", "--kind", "example-graph");
    expect(again.status).toBe(0);
    expect(again.stdout.trim()).toBe(`No example-graph source is registered for ${repo}; nothing changed.`);
  });

  test("add refuses a bad kind, a missing path, and a commit file without its field, before writing anything", () => {
    const { proj } = committedProject();
    for (const args of [
      ["add", "--kind", "Bad Kind", "--path", "graphs/g"],
      ["add", "--kind", "example-graph"],
      ["add", "--kind", "example-graph", "--path", "graphs/g", "--commit-file", "nodes.jsonl"],
    ]) {
      const r = utility(proj, ...args);
      expect(r.status, r.stdout).not.toBe(0);
      expect(r.stderr).toContain("codekb-source add");
    }
    expect(existsSync(registryPath(proj))).toBe(false);
    expect(readAllAuditShards(proj)).not.toContain("CODEKB_SOURCE_CHANGED");
  });

  test("a source registered for another repo is not listed for this one", () => {
    const { proj } = committedProject();
    writeGraph(join(proj, "graphs", "g"), null);
    expect(utility(proj, "add", "--repo", "other-repo", "--kind", "example-graph", "--path", "graphs/g").status).toBe(0);
    expect(JSON.parse(utility(proj, "--json").stdout).sources).toEqual([]);
    expect(JSON.parse(utility(proj, "--repo", "other-repo", "--json").stdout).sources).toHaveLength(1);
  });
});

describe("the stage and the developer's template read the tool", () => {
  const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf-8").replace(/\s+/g, " ");

  test("the stage asks the engine for the repo's sources after the snapshot and briefs the developer by verdict", () => {
    const stage = read(join("core", "aidlc-common", "stages", "inception", "reverse-engineering.md"));
    expect(stage).toContain("{{INVOKE}} engine workspace codekb-source --repo <repo> --json");
    expect(stage).toContain("An empty `sources` list means nothing is registered: the scan runs as it does today, and nothing is said.");
    expect(stage).toContain("**CURRENT** - the source was built from the commit checked out.");
    expect(stage).toContain("**STALE / UNKNOWN** - the source names another commit, or none the engine can read.");
    expect(stage).toContain("**MISSING** - the registered folder is not on this machine.");
    expect(stage).toContain("`{{HARNESS_DIR}}/knowledge/aidlc-developer-agent/code-knowledge-sources.md`");
    expect(stage).toContain("The developer lists every source it read under **Sources read** in Scan Coverage");
  });

  test("the template records the sources read, and the method file ships with the developer's knowledge", () => {
    const template = read(join("core", "knowledge", "aidlc-developer-agent", "re-artifacts.md"));
    expect(template).toContain("- **Sources read**:");
    expect(template).toContain("- Code knowledge source:");
    const method = read(join("core", "knowledge", "aidlc-developer-agent", "code-knowledge-sources.md"));
    expect(method).toContain("## What the verdict means for your scan");
    expect(method).toContain("under **Sources read**");
    expect(existsSync(join(AIDLC_SRC, "knowledge", "aidlc-developer-agent", "code-knowledge-sources.md"))).toBe(true);
  });
});
