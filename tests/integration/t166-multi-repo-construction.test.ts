// covers: subcommand:aidlc-worktree:create, subcommand:aidlc-worktree:merge, subcommand:aidlc-swarm:prepare, function:resolveConstructionRepo, function:repoDir, function:intentRepos
// covers: function:redactProjectDirPrefix
// covers: function:resolveAuditProjectPath
// covers: function:resolveAuditWorktreePath
// covers: function:workspaceSourceExclusionPathspecs
// covers: function:workspaceSourcePathIsExcluded
//
// Mechanism: cli (spawned dist tools) + real git. P7 — multi-repo construction:
// `aidlc-worktree create/merge` thread `--repo <name>` so `git worktree add` and
// the sibling-worktree guard anchor to the TARGET sibling repo, not the (non-git)
// workspace root. Decouples "the repo to operate on" from "the single projectDir".
//
// WHY cli + real git: the subject IS where `git worktree add` runs. The only way
// to prove the worktree forked inside repo-a (and not repo-b, and not the
// non-git workspace root) is to run the real tool against real sibling git repos
// and inspect which repo's ref namespace gained the `bolt-<slug>` branch. An
// in-process twin would re-stage the cwd choice that is the whole point.
//
// FIXTURE: each scenario gets a FRESH workspace (createTestProject). The workspace
// root is NOT a git repo (the multi-repo model — there is no privileged repo to
// host the framework). Sibling code repos (`repo-a/`, `repo-b/`) are immediate
// children, each its own git on `main`. The intent's repo set is captured by
// spawning the real `intent-create --repos ...` handler, which sets the
// active-intent cursor + writes intents.json.repos — exactly what the
// construction-path repo resolution reads. All temp dirs cleaned in afterAll.
//
// TIMEOUT DISCIPLINE (mirrors t78): the heavy tool spawns (intent-create runs the
// full scope→stage state build; git init/commit per repo) run at the DESCRIBE-body
// level, NOT inside test() — so the 5s per-test default only ever wraps the cheap
// assertions, never the multi-second setup chain.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AIDLC_SRC, cleanupTestProject, createTestProject } from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  latestMainWorkflowStageRunFloorForProject,
  readAllAuditShards,
  readUnitSourceManifest,
  workspaceSourceFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const WT_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const SWARM_TOOL = join(AIDLC_SRC, "tools", "aidlc-swarm.ts");
const LOG_TOOL = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const STATE_TOOL = join(AIDLC_SRC, "tools", "aidlc-state.ts");

const tempDirs: string[] = [];
const aliasDirs: string[] = [];
afterAll(() => {
  for (const d of aliasDirs) rmSync(d, { force: true });
  for (const d of tempDirs) cleanupTestProject(d);
});

interface RunResult {
  status: number;
  out: string;
  stdout: string;
}

function runUtil(proj: string, ...args: string[]): RunResult {
  const env = { ...process.env };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  const r = spawnSync(BUN, [UTIL, ...args, "--project-dir", proj], { encoding: "utf-8", env });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

/** Spawn aidlc-worktree from the WORKSPACE root (the conductor's cwd — NOT a git repo). */
function runWorktree(proj: string, ...args: string[]): RunResult {
  const r = spawnSync(BUN, [WT_TOOL, ...args, "--project-dir", proj], { encoding: "utf-8", cwd: proj });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

/** Spawn aidlc-swarm `prepare` from the WORKSPACE root (the conductor's cwd). */
function runSwarm(proj: string, ...args: string[]): RunResult {
  const r = spawnSync(BUN, [SWARM_TOOL, ...args, "--project-dir", proj], { encoding: "utf-8", cwd: proj });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}

function runStateWithEnv(
  proj: string,
  extraEnv: NodeJS.ProcessEnv,
  ...args: string[]
): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    ...extraEnv,
  };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  delete env.AIDLC_SKIP_SOURCE_FRESHNESS;
  const r = spawnSync(
    BUN,
    [STATE_TOOL, ...args, "--project-dir", proj],
    { encoding: "utf-8", cwd: proj, env },
  );
  return {
    status: r.status ?? -1,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    stdout: r.stdout ?? "",
  };
}

function runState(proj: string, ...args: string[]): RunResult {
  return runStateWithEnv(proj, {}, ...args);
}

function emittedError(result: RunResult): string {
  const line = result.out
    .split(/\r?\n/)
    .find((candidate) => candidate.trim().startsWith('{"error":'));
  if (line === undefined) return result.out;
  try {
    const parsed = JSON.parse(line) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : result.out;
  } catch {
    return result.out;
  }
}

function git(cwd: string, ...args: string[]): { status: number; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** A fresh workspace root (NOT a git repo). */
function freshWorkspace(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  return proj;
}

/** Create a sibling code repo `<proj>/<name>/` with its own git on `main` + one commit. */
function makeSiblingRepo(proj: string, name: string): string {
  const dir = join(proj, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

function activeRecord(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  const pointer = join(intents, "active-intent");
  if (existsSync(pointer)) return join(intents, readFileSync(pointer, "utf-8").trim());
  const candidates = readdirSync(intents).filter((name) => existsSync(join(intents, name, "aidlc-state.md")));
  if (candidates.length !== 1) throw new Error(`cannot resolve active record in ${intents}`);
  return join(intents, candidates[0]);
}

function seedOneUnitDag(proj: string, unit: string, kind?: string): void {
  const record = activeRecord(proj);
  const dag = join(record, "inception", "units-generation");
  mkdirSync(dag, { recursive: true });
  writeFileSync(
    join(dag, "unit-of-work-dependency.md"),
    `\`\`\`yaml\nunits:\n  - name: ${unit}\n${kind === undefined ? "" : `    kind: ${kind}\n`}    depends_on: []\n\`\`\`\n`,
  );
  writeFileSync(
    join(record, "runtime-graph.json"),
    `${JSON.stringify({ bolt_dag: { units: [{ name: unit, depends_on: [] }], batches: [[unit]] } })}\n`,
  );
  const state = join(record, "aidlc-state.md");
  writeFileSync(
    state,
    readFileSync(state, "utf-8")
      .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation")
      .replace(/^- \*\*Construction Autonomy Mode\*\*:.*$/m, "- **Construction Autonomy Mode**: autonomous")
      .replace(/^- \[[^\]]\] code-generation.*$/m, "- [?] code-generation — EXECUTE"),
  );
}

function recordMainReview(
  proj: string,
  unit: string,
  repo: string,
  sourcePath: string,
): RunResult {
  const record = activeRecord(proj);
  const dir = join(record, "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  for (const name of ["code-generation-plan.md", "unit-test-instructions.md", "code-summary.md"]) {
    writeFileSync(join(dir, name), `# ${name}\n`);
  }
  writeFileSync(join(dir, "traceability.json"), "{}\n");
  writeFileSync(
    join(dir, "source-manifest.json"),
    `${JSON.stringify({
      stage: "code-generation",
      unit,
      version: 1,
      writes: [{ repo, path: sourcePath }],
    }, null, 2)}\n`,
  );
  const manifest = readUnitSourceManifest(proj, "code-generation", unit);
  if (!manifest.ok) {
    return { status: -1, out: manifest.reason, stdout: "" };
  }
  const args = [
    "review", "--stage", "code-generation", "--reviewer",
    "aidlc-architecture-reviewer-agent", "--unit", unit, "--iteration", "1",
    "--project-dir", proj,
  ];
  const requested = spawnSync(BUN, [LOG_TOOL, ...args], { encoding: "utf-8", cwd: proj });
  if ((requested.status ?? -1) !== 0) {
    return { status: requested.status ?? -1, out: `${requested.stdout ?? ""}${requested.stderr ?? ""}`, stdout: requested.stdout ?? "" };
  }
  const completed = spawnSync(BUN, [LOG_TOOL, ...args, "--verdict", "READY"], { encoding: "utf-8", cwd: proj });
  return { status: completed.status ?? -1, out: `${completed.stdout ?? ""}${completed.stderr ?? ""}`, stdout: completed.stdout ?? "" };
}

function recordWorktreeReview(
  wt: string,
  unit: string,
  sourcePath: string,
): RunResult {
  const record = activeRecord(wt);
  const dir = join(record, "construction", unit, "code-generation");
  mkdirSync(dir, { recursive: true });
  for (const name of ["code-generation-plan.md", "unit-test-instructions.md", "code-summary.md"]) {
    writeFileSync(join(dir, name), `# ${name}\n`);
  }
  writeFileSync(join(dir, "traceability.json"), "{}\n");
  writeFileSync(
    join(dir, "source-manifest.json"),
    `${JSON.stringify({
      stage: "code-generation",
      unit,
      version: 1,
      writes: [{ path: sourcePath }],
    }, null, 2)}\n`,
  );
  const args = [
    "review", "--stage", "code-generation", "--reviewer",
    "aidlc-architecture-reviewer-agent", "--unit", unit, "--iteration", "1",
    "--project-dir", wt,
  ];
  const requested = spawnSync(BUN, [LOG_TOOL, ...args], {
    encoding: "utf-8",
    cwd: wt,
  });
  if ((requested.status ?? -1) !== 0) {
    return {
      status: requested.status ?? -1,
      out: `${requested.stdout ?? ""}${requested.stderr ?? ""}`,
      stdout: requested.stdout ?? "",
    };
  }
  const completed = spawnSync(
    BUN,
    [LOG_TOOL, ...args, "--verdict", "READY"],
    { encoding: "utf-8", cwd: wt },
  );
  return {
    status: completed.status ?? -1,
    out: `${completed.stdout ?? ""}${completed.stderr ?? ""}`,
    stdout: completed.stdout ?? "",
  };
}

function uncommittedSiblingRootSourceScenario(
  rootName: "aidlc" | ".aidlc",
): {
  finalized: RunResult;
  merged: RunResult;
  mainBytes: string;
  sourceCommitBytes: string;
} {
  const proj = freshWorkspace();
  const repo = makeSiblingRepo(proj, "repo-a");
  const sourcePath = `${rootName}/application.ts`;
  mkdirSync(join(repo, rootName), { recursive: true });
  writeFileSync(join(repo, sourcePath), "export const reviewed = 1;\n");
  git(repo, "add", "--", sourcePath);
  git(repo, "commit", "-q", "-m", `seed sibling ${rootName} source`);
  const unit = rootName === "aidlc" ? "root-aidlc" : "root-dot-aidlc";
  const created = runUtil(
    proj,
    "intent-create",
    "--scope",
    "feature",
    "--repos",
    "repo-a",
  );
  if (created.status !== 0) throw new Error(created.out);
  seedOneUnitDag(proj, unit);
  const prepared = runSwarm(
    proj,
    "prepare",
    "--batch",
    "1",
    "--units",
    unit,
    "--base",
    "main",
    "--repo",
    "repo-a",
  );
  if (prepared.status !== 0) throw new Error(prepared.out);
  const wt = worktreeDir(proj, unit);
  writeFileSync(join(wt, sourcePath), "export const reviewed = 2;\n");
  const reviewed = recordWorktreeReview(wt, unit, sourcePath);
  if (reviewed.status !== 0) throw new Error(reviewed.out);
  const finalized = runSwarm(
    proj,
    "finalize",
    "--batch",
    "1",
    "--units",
    unit,
    "--claimed",
    unit,
    "--check-cmd",
    "true",
  );
  const audit = readAllAuditShards(proj);
  const convergence = audit
    .split("\n---\n")
    .find(
      (block) =>
        block.includes("**Event**: SWARM_UNIT_CONVERGED") &&
        block.includes(`**Unit name**: ${unit}`),
    );
  const sourceCommit =
    convergence?.match(/^\*\*Source Commit\*\*: ([0-9a-f]{40,64})$/m)?.[1] ??
    "";
  const sourceCommitBytes =
    sourceCommit === ""
      ? ""
      : git(repo, "show", `${sourceCommit}:${sourcePath}`).out;
  const merged =
    finalized.status === 0
      ? runWorktree(
          proj,
          "merge",
          "--slug",
          unit,
          "--target",
          "main",
          "--strategy",
          "squash",
          "--repo",
          "repo-a",
        )
      : { status: -1, out: finalized.out, stdout: "" };
  return {
    finalized,
    merged,
    mainBytes:
      merged.status === 0 ? readFileSync(join(repo, sourcePath), "utf-8") : "",
    sourceCommitBytes,
  };
}

function compositionScenario(
  suffix: string,
  validityCaptureFails: boolean,
  mutateAfterReview: boolean,
): { proj: string; approved: RunResult; audit: string } {
  const proj = freshWorkspace();
  const repoA = makeSiblingRepo(proj, "repo-a");
  mkdirSync(join(repoA, "aidlc"), { recursive: true });
  writeFileSync(
    join(repoA, "aidlc", "application.ts"),
    "export const reviewed = 1;\n",
  );
  git(repoA, "add", "--", "aidlc/application.ts");
  git(repoA, "commit", "-q", "-m", "seed composition source");
  const created = runUtil(
    proj,
    "intent-create",
    "--scope",
    "feature",
    "--repos",
    "repo-a",
  );
  if (created.status !== 0) throw new Error(created.out);
  const unit = `composition-${suffix}`;
  seedOneUnitDag(proj, unit, "service");
  const prepared = runSwarm(
    proj,
    "prepare",
    "--batch",
    "1",
    "--units",
    unit,
    "--base",
    "main",
    "--repo",
    "repo-a",
  );
  if (prepared.status !== 0) throw new Error(prepared.out);
  const wt = worktreeDir(proj, unit);
  writeFileSync(
    join(wt, "aidlc", "application.ts"),
    "export const reviewed = 2;\n",
  );
  git(wt, "add", "--", "aidlc/application.ts");
  git(wt, "commit", "-q", "-m", "review composition source");
  const sourceFingerprint = workspaceSourceFingerprint(wt);
  if (sourceFingerprint === null) {
    throw new Error("composition source fingerprint unavailable");
  }
  appendAuditEntry(
    "SWARM_UNIT_CONVERGED",
    {
      "Batch number": "1",
      "Unit name": unit,
      Stage: "code-generation",
      "Run floor": latestMainWorkflowStageRunFloorForProject(
        proj,
        "code-generation",
      ),
      "Source Fingerprint": sourceFingerprint,
      "Source Commit": git(wt, "rev-parse", "HEAD").out.trim(),
    },
    proj,
  );
  const merged = runWorktree(
    proj,
    "merge",
    "--slug",
    unit,
    "--target",
    "main",
    "--strategy",
    "squash",
    "--repo",
    "repo-a",
  );
  if (merged.status !== 0) throw new Error(merged.out);
  const reviewed = recordMainReview(
    proj,
    unit,
    "repo-a",
    "aidlc/application.ts",
  );
  if (reviewed.status !== 0) throw new Error(reviewed.out);
  if (mutateAfterReview) {
    writeFileSync(
      join(repoA, "aidlc", "application.ts"),
      "export const reviewed = 3;\n",
    );
  }
  const stateEnv: NodeJS.ProcessEnv = {};
  if (validityCaptureFails) {
    const graph = JSON.parse(
      readFileSync(
        join(AIDLC_SRC, "tools", "data", "stage-graph.json"),
        "utf-8",
      ),
    ) as Array<{
      slug?: string;
      consumes?: Array<{ artifact: string; required: boolean }>;
    }>;
    const codeGeneration = graph.find(
      (candidate) => candidate.slug === "code-generation",
    );
    if (codeGeneration === undefined) {
      throw new Error("composition graph missing code-generation");
    }
    codeGeneration.consumes = [
      ...(codeGeneration.consumes ?? []),
      { artifact: "composition-missing-producer", required: true },
    ];
    const graphPath = join(proj, "composition-stage-graph.json");
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
    stateEnv.AIDLC_STAGE_GRAPH = graphPath;
  }
  const approved = runStateWithEnv(
    proj,
    stateEnv,
    "approve",
    "code-generation",
    "--user-input",
    "ship",
  );
  return { proj, approved, audit: readAllAuditShards(proj) };
}

const worktreeDir = (proj: string, slug: string): string =>
  join(proj, ".aidlc", "worktrees", `bolt-${slug}`);

/** True iff branch `bolt-<slug>` exists in the repo at `<proj>/<name>`. */
function hasBoltBranch(proj: string, repoName: string, slug: string): boolean {
  return git(join(proj, repoName), "rev-parse", "--verify", `refs/heads/bolt-${slug}`).status === 0;
}

describe("t166 P7 multi-repo construction — --repo anchors the worktree to the sibling repo", () => {
  // ===========================================================================
  // Multi-repo intent: create --repo repo-a forks inside repo-a (and only it).
  // ===========================================================================
  describe("multi-repo: create --repo targets the named sibling repo", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    const birth = runUtil(proj, "intent-create", "--scope", "feature", "--repos", "repo-a,repo-b");
    const created = runWorktree(proj, "create", "--slug", "alpha", "--base", "main", "--repo", "repo-a");

    test("birth records the two-repo set", () => {
      expect(birth.status).toBe(0);
    });
    test("create --repo repo-a exits 0 and produces the worktree dir", () => {
      expect(created.status).toBe(0);
      expect(existsSync(worktreeDir(proj, "alpha"))).toBe(true);
      const meta = JSON.parse(
        readFileSync(
          join(worktreeDir(proj, "alpha"), ".aidlc", "worktree-meta.json"),
          "utf-8",
        ),
      ) as {
        repoSelector?: unknown;
        gitCommonDir?: unknown;
        gitCommonDirHash?: unknown;
      };
      expect(meta.repoSelector).toBe("repo-a");
      expect(meta.gitCommonDir).toBeUndefined();
      expect(meta.gitCommonDirHash).toMatch(/^[0-9a-f]{64}$/);
      expect(readAllAuditShards(proj)).toContain("**Repo**: repo-a");
    });
    test("the bolt branch lives in repo-a's ref namespace, NOT repo-b's", () => {
      // Only true if `git worktree add` ran with cwd = repo-a (the P7 re-anchor),
      // not the workspace root or repo-b.
      expect(hasBoltBranch(proj, "repo-a", "alpha")).toBe(true);
      expect(hasBoltBranch(proj, "repo-b", "alpha")).toBe(false);
    });
  });

  describe("legacy plaintext common-dir metadata remains merge-compatible", () => {
    const proj = freshWorkspace();
    const repoA = makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(
      proj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    runWorktree(
      proj,
      "create",
      "--slug",
      "legacy-common-dir",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    const wt = worktreeDir(proj, "legacy-common-dir");
    const metadataPath = join(wt, ".aidlc", "worktree-meta.json");
    const metadata = JSON.parse(
      readFileSync(metadataPath, "utf-8"),
    ) as Record<string, unknown>;
    delete metadata.gitCommonDirHash;
    metadata.gitCommonDir = realpathSync(join(repoA, ".git"));
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    writeFileSync(join(wt, "legacy-common-dir.txt"), "legacy metadata\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "legacy metadata source");
    const merged = runWorktree(
      proj,
      "merge",
      "--slug",
      "legacy-common-dir",
      "--target",
      "main",
      "--strategy",
      "squash",
      "--repo",
      "repo-a",
    );

    test("old gitCommonDir metadata is hashed for comparison and still merges", () => {
      expect(merged.status, merged.out).toBe(0);
      expect(
        readFileSync(
          join(repoA, "legacy-common-dir.txt"),
          "utf-8",
        ),
      ).toContain("legacy metadata");
    });
  });

  describe("merge binding refusals name the failed authority check", () => {
    const setup = (slug: string) => {
      const proj = freshWorkspace();
      const repoA = makeSiblingRepo(proj, "repo-a");
      const repoB = makeSiblingRepo(proj, "repo-b");
      runUtil(
        proj,
        "intent-create",
        "--scope",
        "feature",
        "--repos",
        "repo-a,repo-b",
      );
      const created = runWorktree(
        proj,
        "create",
        "--slug",
        slug,
        "--base",
        "main",
        "--repo",
        "repo-a",
      );
      if (created.status !== 0) throw new Error(created.out);
      return {
        proj,
        repoA,
        repoB,
        wt: worktreeDir(proj, slug),
      };
    };

    const provenance = setup("binding-provenance");
    const provenanceMetaPath = join(
      provenance.wt,
      ".aidlc",
      "worktree-meta.json",
    );
    const provenanceMeta = JSON.parse(
      readFileSync(provenanceMetaPath, "utf-8"),
    ) as Record<string, unknown>;
    delete provenanceMeta.gitCommonDirHash;
    provenanceMeta.gitCommonDir = realpathSync(
      join(provenance.repoB, ".git"),
    );
    writeFileSync(
      provenanceMetaPath,
      `${JSON.stringify(provenanceMeta, null, 2)}\n`,
    );
    const provenanceMerge = runWorktree(
      provenance.proj,
      "merge",
      "--slug",
      "binding-provenance",
      "--target",
      "main",
      "--strategy",
      "squash",
      "--repo",
      "repo-a",
    );

    const unresolved = setup("binding-unresolved");
    rmSync(join(unresolved.wt, ".git"), { recursive: true, force: true });
    const unresolvedMerge = runWorktree(
      unresolved.proj,
      "merge",
      "--slug",
      "binding-unresolved",
      "--target",
      "main",
      "--strategy",
      "squash",
      "--repo",
      "repo-a",
    );

    const selector = setup("binding-selector");
    const selectorMerge = runWorktree(
      selector.proj,
      "merge",
      "--slug",
      "binding-selector",
      "--target",
      "main",
      "--strategy",
      "squash",
      "--repo",
      "repo-b",
    );

    test("provenance mismatch, partial cleanup, and selector mismatch stay distinct", () => {
      const provenanceError = emittedError(provenanceMerge);
      const unresolvedError = emittedError(unresolvedMerge);
      const selectorError = emittedError(selectorMerge);
      expect(provenanceMerge.status).not.toBe(0);
      expect(provenanceError).toContain(
        "recorded creating-repository provenance does not match the selected repository or Bolt worktree",
      );
      expect(provenanceError).not.toContain(
        'selected repository "repo-a" does not match creating repository "repo-a"',
      );

      expect(unresolvedMerge.status).not.toBe(0);
      expect(unresolvedError).toContain(
        "could not resolve the Bolt worktree git directory after partial cleanup",
      );
      expect(unresolvedError).toContain(
        "restore the worktree registration or discard and restart the Bolt attempt",
      );
      expect(unresolvedError).not.toContain(
        'selected repository "repo-a" does not match creating repository "repo-a"',
      );

      expect(selectorMerge.status).not.toBe(0);
      expect(selectorError).toContain(
        'selected repository "repo-b" does not match creating repository "repo-a"',
      );
      expect(selectorError).toContain(
        "retry with the creating --repo selector",
      );
      expect(selectorError).not.toContain(
        "recorded creating-repository provenance",
      );
    });
  });

  describe("#716 validity capture composes with per-unit source binding", () => {
    const sourceRefusal = compositionScenario(
      "source-refusal",
      true,
      true,
    );
    const validityWarning = compositionScenario(
      "validity-warning",
      true,
      false,
    );
    const green = compositionScenario("green", false, false);
    const completedBlock = (audit: string): string | undefined =>
      audit
        .split(/\n---\n/)
        .find((block) =>
          block.includes("**Event**: STAGE_COMPLETED") &&
          block.includes("**Stage**: code-generation")
        );

    test("source refusal wins, validity failure stays advisory, and green completion emits both receipts", () => {
      expect(sourceRefusal.approved.status).not.toBe(0);
      expect(sourceRefusal.approved.out).toContain(
        "source-fingerprint mismatch",
      );
      expect(completedBlock(sourceRefusal.audit)).toBeUndefined();
      expect(sourceRefusal.audit).not.toContain("**Validation Basis**:");
      expect(sourceRefusal.audit).not.toContain("**Validation Warning**:");

      expect(
        validityWarning.approved.status,
        validityWarning.approved.out,
      ).toBe(0);
      expect(validityWarning.approved.out).toContain(
        "Validity receipt omitted",
      );
      const warningBlock = completedBlock(validityWarning.audit);
      expect(warningBlock).toContain("**Validation Warning**:");
      expect(warningBlock).not.toContain("**Validation Basis**:");
      expect(validityWarning.audit).toContain(
        "**Unit Source Fingerprint**:",
      );

      expect(green.approved.status, green.approved.out).toBe(0);
      const greenBlock = completedBlock(green.audit);
      expect(greenBlock).toBeDefined();
      const basisLine = greenBlock
        ?.split(/\r?\n/)
        .find((line) => line.startsWith("**Validation Basis**: "));
      expect(basisLine).toBeDefined();
      const basis = JSON.parse(
        basisLine?.slice("**Validation Basis**: ".length) ?? "{}",
      ) as { schema?: number };
      expect(basis.schema).toBe(2);
      const reviewBlock = green.audit
        .split(/\n---\n/)
        .find((block) =>
          block.includes("**Event**: REVIEW_COMPLETED") &&
          block.includes("**Unit Source Fingerprint**:")
        );
      expect(reviewBlock).toContain("**Source Fingerprint**:");
      expect(reviewBlock).toContain("**Unit Source Fingerprint**:");
      expect(green.audit).not.toContain(green.proj);
      expect(green.audit).not.toContain(realpathSync(green.proj));
    });
  });

  describe("multi-repo: create WITHOUT --repo is refused (disambiguation required)", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-create", "--scope", "feature", "--repos", "repo-a,repo-b");
    const created = runWorktree(proj, "create", "--slug", "beta", "--base", "main");

    test("exits non-zero with a 'spans N repos' message", () => {
      expect(created.status).not.toBe(0);
      expect(created.out).toContain("spans 2 repos");
    });
    test("no branch leaked into either repo", () => {
      expect(hasBoltBranch(proj, "repo-a", "beta")).toBe(false);
      expect(hasBoltBranch(proj, "repo-b", "beta")).toBe(false);
    });
  });

  describe("multi-repo: --repo outside the intent's set is refused", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-create", "--scope", "feature", "--repos", "repo-a,repo-b");
    const created = runWorktree(proj, "create", "--slug", "gamma", "--base", "main", "--repo", "repo-c");

    test("exits non-zero with a 'not in this intent's repo set' message", () => {
      expect(created.status).not.toBe(0);
      expect(created.out).toContain("not in this intent's repo set");
    });
  });

  describe("multi-repo: merge --repo lands the squash commit in the right repo", () => {
    const proj = freshWorkspace();
    const repoA = makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-create", "--scope", "feature", "--repos", "repo-a,repo-b");
    runWorktree(proj, "create", "--slug", "delta", "--base", "main", "--repo", "repo-a");
    // Make a commit on the bolt branch IN THE WORKTREE so the squash has content.
    const wt = worktreeDir(proj, "delta");
    writeFileSync(join(wt, "feature.txt"), "unit work\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "unit work");
    const before = git(repoA, "rev-parse", "main").out.trim();
    const merged = runWorktree(
      proj, "merge", "--slug", "delta", "--target", "main", "--strategy", "squash", "--repo", "repo-a",
    );
    const after = git(repoA, "rev-parse", "main").out.trim();

    test("merge --repo repo-a exits 0", () => {
      expect(merged.status).toBe(0);
    });
    test("repo-a's main advanced (the squash commit landed there)", () => {
      expect(after).not.toBe(before);
      expect(git(repoA, "cat-file", "-e", `${after}:feature.txt`).status).toBe(0);
    });
    test("the worktree + bolt branch are cleaned up in repo-a", () => {
      expect(existsSync(wt)).toBe(false);
      expect(hasBoltBranch(proj, "repo-a", "delta")).toBe(false);
    });
  });

  describe("multi-repo: merge refuses a reachable Bolt branch in the wrong repo", () => {
    const proj = freshWorkspace();
    const repoA = makeSiblingRepo(proj, "repo-a");
    const repoB = makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-create", "--scope", "feature", "--repos", "repo-a,repo-b");
    runWorktree(
      proj,
      "create",
      "--slug",
      "wrong-repo",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    const wt = worktreeDir(proj, "wrong-repo");
    writeFileSync(join(wt, "wrong-repo.txt"), "reviewed\n");
    git(wt, "add", "--", "wrong-repo.txt");
    git(wt, "commit", "-q", "-m", "reviewed wrong-repo source");
    git(
      repoB,
      "fetch",
      repoA,
      "bolt-wrong-repo:refs/heads/bolt-wrong-repo",
    );
    const beforeA = git(repoA, "rev-parse", "main").out.trim();
    const beforeB = git(repoB, "rev-parse", "main").out.trim();
    const merged = runWorktree(
      proj,
      "merge",
      "--slug",
      "wrong-repo",
      "--target",
      "main",
      "--strategy",
      "squash",
      "--repo",
      "repo-b",
    );

    test("refuses before mutation with creating-repository values", () => {
      expect(merged.status).not.toBe(0);
      expect(merged.out).toContain("does not match creating repository");
      expect(merged.out).toContain("repo-a");
      expect(merged.out).toContain("repo-b");
      expect(git(repoA, "rev-parse", "main").out.trim()).toBe(beforeA);
      expect(git(repoB, "rev-parse", "main").out.trim()).toBe(beforeB);
      expect(existsSync(wt)).toBe(true);
      const audit = readAllAuditShards(proj);
      expect(audit).not.toContain(
        "**Event**: WORKTREE_MERGED",
      );
      const errorBlock = audit.slice(audit.lastIndexOf("## Error Logged"));
      expect(errorBlock).toContain("--project-dir <project-dir>");
      expect(errorBlock).not.toContain(proj);
      expect(errorBlock).not.toContain(repoA);
      expect(errorBlock).not.toContain(repoB);
    });
  });

  describe("multi-repo: discard is bound to the creating repository", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-create", "--scope", "feature", "--repos", "repo-a,repo-b");
    runWorktree(
      proj,
      "create",
      "--slug",
      "discard-repo",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    const wrong = runWorktree(
      proj,
      "discard",
      "--slug",
      "discard-repo",
      "--repo",
      "repo-b",
    );
    const recovered = runWorktree(
      proj,
      "discard",
      "--slug",
      "discard-repo",
    );

    test("wrong selector refuses and selector-free retry uses the creating repo", () => {
      expect(wrong.status).not.toBe(0);
      expect(wrong.out).toContain("does not match creating repository");
      expect(recovered.status, recovered.out).toBe(0);
      expect(existsSync(worktreeDir(proj, "discard-repo"))).toBe(false);
      expect(hasBoltBranch(proj, "repo-a", "discard-repo")).toBe(false);
    });
  });

  describe("multi-repo: discard falls back to WORKTREE_CREATED repository authority", () => {
    const strippedProj = freshWorkspace();
    makeSiblingRepo(strippedProj, "repo-a");
    makeSiblingRepo(strippedProj, "repo-b");
    runUtil(
      strippedProj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    runWorktree(
      strippedProj,
      "create",
      "--slug",
      "audit-stripped",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    const strippedMetaPath = join(
      worktreeDir(strippedProj, "audit-stripped"),
      ".aidlc",
      "worktree-meta.json",
    );
    const strippedMeta = JSON.parse(
      readFileSync(strippedMetaPath, "utf-8"),
    ) as Record<string, unknown>;
    delete strippedMeta.repoSelector;
    writeFileSync(
      strippedMetaPath,
      `${JSON.stringify(strippedMeta, null, 2)}\n`,
    );
    const strippedWrong = runWorktree(
      strippedProj,
      "discard",
      "--slug",
      "audit-stripped",
      "--repo",
      "repo-b",
    );

    const removedProj = freshWorkspace();
    makeSiblingRepo(removedProj, "repo-a");
    const removedRepoB = makeSiblingRepo(removedProj, "repo-b");
    runUtil(
      removedProj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    runWorktree(
      removedProj,
      "create",
      "--slug",
      "audit-removed",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    git(removedRepoB, "branch", "bolt-audit-removed");
    rmSync(worktreeDir(removedProj, "audit-removed"), {
      recursive: true,
      force: true,
    });
    const removedWrong = runWorktree(
      removedProj,
      "discard",
      "--slug",
      "audit-removed",
      "--repo",
      "repo-b",
    );

    test("stripped metadata cannot redirect discard away from the creating repo", () => {
      expect(strippedWrong.status).not.toBe(0);
      expect(strippedWrong.out).toContain("does not match creating repository");
      expect(hasBoltBranch(strippedProj, "repo-a", "audit-stripped")).toBe(
        true,
      );
    });

    test("a removed worktree directory cannot erase the creating-repo binding", () => {
      expect(removedWrong.status).not.toBe(0);
      expect(removedWrong.out).toContain("does not match creating repository");
      expect(hasBoltBranch(removedProj, "repo-b", "audit-removed")).toBe(true);
    });
  });

  describe("multi-repo: discard corroborates authority across every intent", () => {
    function phantomWorkspace(slug: string, plantRepoB: boolean) {
      const proj = freshWorkspace();
      makeSiblingRepo(proj, "repo-a");
      const repoB = makeSiblingRepo(proj, "repo-b");
      runUtil(
        proj,
        "intent-create",
        "--scope",
        "feature",
        "--repos",
        "repo-a,repo-b",
      );
      const created = runWorktree(
        proj,
        "create",
        "--slug",
        slug,
        "--base",
        "main",
        "--repo",
        "repo-a",
      );
      rmSync(worktreeDir(proj, slug), { recursive: true, force: true });
      const parent = join(proj, ".aidlc", "worktrees");
      chmodSync(parent, 0o500);
      const phantom = runWorktree(
        proj,
        "create",
        "--slug",
        slug,
        "--base",
        "main",
        "--repo",
        "repo-b",
      );
      chmodSync(parent, 0o700);
      if (plantRepoB) git(repoB, "branch", `bolt-${slug}`);
      return { created, phantom, proj };
    }

    const trueRepo = phantomWorkspace("phantom-true", false);
    const trueDiscard = runWorktree(
      trueRepo.proj,
      "discard",
      "--slug",
      "phantom-true",
      "--repo",
      "repo-a",
    );

    const phantomBranch = phantomWorkspace("phantom-branch", true);
    const phantomBranchDiscard = runWorktree(
      phantomBranch.proj,
      "discard",
      "--slug",
      "phantom-branch",
    );

    const movedProj = freshWorkspace();
    makeSiblingRepo(movedProj, "repo-a");
    const movedRepoB = makeSiblingRepo(movedProj, "repo-b");
    runUtil(
      movedProj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    const firstIntent = basename(activeRecord(movedProj));
    runWorktree(
      movedProj,
      "create",
      "--slug",
      "moved-cursor",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    rmSync(worktreeDir(movedProj, "moved-cursor"), {
      recursive: true,
      force: true,
    });
    runUtil(
      movedProj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    const secondIntent = basename(activeRecord(movedProj));
    git(movedRepoB, "branch", "bolt-moved-cursor");
    const movedWrong = runWorktree(
      movedProj,
      "discard",
      "--slug",
      "moved-cursor",
      "--repo",
      "repo-b",
    );
    const foreignIntent = runWorktree(
      movedProj,
      "discard",
      "--slug",
      "moved-cursor",
      "--repo",
      "repo-a",
      "--space",
      "default",
      "--intent",
      secondIntent,
    );

    const metadataProj = freshWorkspace();
    makeSiblingRepo(metadataProj, "repo-a");
    makeSiblingRepo(metadataProj, "repo-b");
    makeSiblingRepo(metadataProj, "repo-c");
    runUtil(
      metadataProj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b,repo-c",
    );
    runWorktree(
      metadataProj,
      "create",
      "--slug",
      "metadata-conflict",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    const metadataPath = join(
      worktreeDir(metadataProj, "metadata-conflict"),
      ".aidlc",
      "worktree-meta.json",
    );
    const metadata = JSON.parse(
      readFileSync(metadataPath, "utf-8"),
    ) as Record<string, unknown>;
    metadata.repoSelector = "repo-c";
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const metadataConflict = runWorktree(
      metadataProj,
      "discard",
      "--slug",
      "metadata-conflict",
      "--repo",
      "repo-b",
    );

    function stripCreationRepoField(proj: string): void {
      const auditDir = join(activeRecord(proj), "audit");
      for (const file of readdirSync(auditDir)) {
        const path = join(auditDir, file);
        writeFileSync(
          path,
          readFileSync(path, "utf-8").replace(
            /^\*\*Repo\*\*:.*\n/gm,
            "",
          ),
        );
      }
    }

    const migrationProj = freshWorkspace();
    makeSiblingRepo(migrationProj, "repo-a");
    makeSiblingRepo(migrationProj, "repo-b");
    runUtil(
      migrationProj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    runWorktree(
      migrationProj,
      "create",
      "--slug",
      "migration-single",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    rmSync(worktreeDir(migrationProj, "migration-single"), {
      recursive: true,
      force: true,
    });
    stripCreationRepoField(migrationProj);
    const migrationSingle = runWorktree(
      migrationProj,
      "discard",
      "--slug",
      "migration-single",
      "--repo",
      "repo-a",
    );

    const migrationAmbiguousProj = freshWorkspace();
    makeSiblingRepo(migrationAmbiguousProj, "repo-a");
    const migrationRepoB = makeSiblingRepo(
      migrationAmbiguousProj,
      "repo-b",
    );
    runUtil(
      migrationAmbiguousProj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    runWorktree(
      migrationAmbiguousProj,
      "create",
      "--slug",
      "migration-ambiguous",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    rmSync(worktreeDir(migrationAmbiguousProj, "migration-ambiguous"), {
      recursive: true,
      force: true,
    });
    git(migrationRepoB, "branch", "bolt-migration-ambiguous");
    stripCreationRepoField(migrationAmbiguousProj);
    const migrationWrongRepo = runWorktree(
      migrationAmbiguousProj,
      "discard",
      "--slug",
      "migration-ambiguous",
      "--repo",
      "repo-b",
    );
    const migrationSelectorFree = runWorktree(
      migrationAmbiguousProj,
      "discard",
      "--slug",
      "migration-ambiguous",
    );
    const migrationCreatingRepo = runWorktree(
      migrationAmbiguousProj,
      "discard",
      "--slug",
      "migration-ambiguous",
      "--repo",
      "repo-a",
    );

    const lostCorroborationProj = freshWorkspace();
    makeSiblingRepo(lostCorroborationProj, "repo-a");
    const lostRepoB = makeSiblingRepo(lostCorroborationProj, "repo-b");
    runUtil(
      lostCorroborationProj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    runWorktree(
      lostCorroborationProj,
      "create",
      "--slug",
      "lost-corroboration",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    rmSync(worktreeDir(lostCorroborationProj, "lost-corroboration"), {
      recursive: true,
      force: true,
    });
    git(lostRepoB, "branch", "bolt-lost-corroboration");
    const legitimateDiscard = runWorktree(
      lostCorroborationProj,
      "discard",
      "--slug",
      "lost-corroboration",
    );
    const lostCorroboration = runWorktree(
      lostCorroborationProj,
      "discard",
      "--slug",
      "lost-corroboration",
      "--repo",
      "repo-b",
    );

    const unreadableProj = freshWorkspace();
    makeSiblingRepo(unreadableProj, "repo-a");
    const unreadableRepoB = makeSiblingRepo(unreadableProj, "repo-b");
    runUtil(
      unreadableProj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    runWorktree(
      unreadableProj,
      "create",
      "--slug",
      "unreadable-authority",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    rmSync(worktreeDir(unreadableProj, "unreadable-authority"), {
      recursive: true,
      force: true,
    });
    git(unreadableRepoB, "branch", "bolt-unreadable-authority");
    const unreadableAuditDir = join(activeRecord(unreadableProj), "audit");
    const unreadableShards = readdirSync(unreadableAuditDir).map((file) =>
      join(unreadableAuditDir, file),
    );
    for (const shard of unreadableShards) chmodSync(shard, 0o000);
    const unreadableAuthority = runWorktree(
      unreadableProj,
      "discard",
      "--slug",
      "unreadable-authority",
      "--repo",
      "repo-b",
    );
    for (const shard of unreadableShards) chmodSync(shard, 0o600);

    test("an uncorroborated phantom row cannot override the real creating repo", () => {
      expect(trueRepo.created.status).toBe(0);
      expect(trueRepo.phantom.status).not.toBe(0);
      expect(trueDiscard.status, trueDiscard.out).toBe(0);
      expect(
        hasBoltBranch(trueRepo.proj, "repo-a", "phantom-true"),
      ).toBe(false);
    });

    test("a deliberately planted second branch makes repository authority ambiguous", () => {
      expect(phantomBranch.phantom.status).not.toBe(0);
      expect(phantomBranchDiscard.status).not.toBe(0);
      expect(phantomBranchDiscard.out).toContain(
        "corroborated WORKTREE_CREATED rows disagree",
      );
      expect(
        hasBoltBranch(
          phantomBranch.proj,
          "repo-a",
          "phantom-branch",
        ),
      ).toBe(true);
      expect(
        hasBoltBranch(
          phantomBranch.proj,
          "repo-b",
          "phantom-branch",
        ),
      ).toBe(true);
    });

    test("a moved cursor and foreign intent cannot hide creating authority", () => {
      expect(firstIntent).not.toBe(secondIntent);
      expect(movedWrong.status).not.toBe(0);
      expect(movedWrong.out).toContain("does not match creating repository");
      expect(foreignIntent.status).not.toBe(0);
      expect(foreignIntent.out).toContain(
        "does not match creating intent",
      );
      expect(
        hasBoltBranch(movedProj, "repo-a", "moved-cursor"),
      ).toBe(true);
      expect(
        hasBoltBranch(movedProj, "repo-b", "moved-cursor"),
      ).toBe(true);
    });

    test("metadata and corroborated audit authority must agree", () => {
      expect(metadataConflict.status).not.toBe(0);
      expect(metadataConflict.out).toContain(
        "worktree metadata repository",
      );
      expect(metadataConflict.out).toContain(
        "corroborated WORKTREE_CREATED repository",
      );
      expect(
        hasBoltBranch(metadataProj, "repo-a", "metadata-conflict"),
      ).toBe(true);
    });

    test("pre-upgrade fallback stays open only when durable repo evidence is unambiguous", () => {
      expect(migrationSingle.status, migrationSingle.out).toBe(0);
      expect(
        hasBoltBranch(migrationProj, "repo-a", "migration-single"),
      ).toBe(false);
      for (const refusal of [
        migrationWrongRepo,
        migrationSelectorFree,
      ]) {
        expect(refusal.status).not.toBe(0);
        expect(refusal.out).toContain("repo-a");
        expect(refusal.out).toContain("repo-b");
        expect(refusal.out).toContain(
          "Delete the stray bolt-migration-ambiguous branch",
        );
        expect(refusal.out).toContain(
          "retry with --repo <creating-repo>",
        );
      }
      expect(
        migrationCreatingRepo.status,
        migrationCreatingRepo.out,
      ).toBe(0);
      expect(
        hasBoltBranch(
          migrationAmbiguousProj,
          "repo-a",
          "migration-ambiguous",
        ),
      ).toBe(false);
      expect(
        hasBoltBranch(
          migrationAmbiguousProj,
          "repo-b",
          "migration-ambiguous",
        ),
      ).toBe(true);
    });

    test("lost corroboration and unreadable authority have distinct remedies", () => {
      expect(legitimateDiscard.status, legitimateDiscard.out).toBe(0);
      expect(lostCorroboration.status).not.toBe(0);
      expect(lostCorroboration.out).toContain(
        "a readable WORKTREE_CREATED record names",
      );
      expect(lostCorroboration.out).toContain("repo-a");
      expect(lostCorroboration.out).toContain(
        "If this Bolt was already discarded, this is expected",
      );
      expect(lostCorroboration.out).toContain(
        "otherwise inspect",
      );
      expect(lostCorroboration.out).toContain(
        "bolt-lost-corroboration branch",
      );
      expect(lostCorroboration.out).not.toContain("unreadable");

      expect(unreadableAuthority.status).not.toBe(0);
      expect(unreadableAuthority.out).toContain(
        "WORKTREE_CREATED Repo authority is unreadable",
      );
      expect(unreadableAuthority.out).toContain(
        "restore readable audit shards and retry",
      );
      expect(
        hasBoltBranch(
          unreadableProj,
          "repo-a",
          "unreadable-authority",
        ),
      ).toBe(true);
      expect(
        hasBoltBranch(
          unreadableProj,
          "repo-b",
          "unreadable-authority",
        ),
      ).toBe(true);
    });
  });

  describe("ERROR_LOGGED redacts the resolved project prefix centrally", () => {
    function errorBlock(proj: string): string {
      const audit = readAllAuditShards(proj);
      return audit.slice(audit.lastIndexOf("## Error Logged"));
    }

    const envProj = freshWorkspace();
    git(envProj, "init", "-q", "-b", "main");
    git(envProj, "config", "user.email", "t@t");
    git(envProj, "config", "user.name", "t");
    git(envProj, "commit", "-q", "-m", "init", "--allow-empty");
    runUtil(envProj, "intent-create", "--scope", "feature");
    mkdirSync(worktreeDir(envProj, "env-path"), { recursive: true });
    const envError = spawnSync(
      BUN,
      [WT_TOOL, "create", "--slug", "env-path", "--base", "main"],
      {
        cwd: envProj,
        encoding: "utf-8",
        env: { ...process.env, AIDLC_PROJECT_DIR: envProj },
      },
    );

    const equalsProj = freshWorkspace();
    git(equalsProj, "init", "-q", "-b", "main");
    git(equalsProj, "config", "user.email", "t@t");
    git(equalsProj, "config", "user.name", "t");
    git(equalsProj, "commit", "-q", "-m", "init", "--allow-empty");
    runUtil(equalsProj, "intent-create", "--scope", "feature");
    const equalsError = spawnSync(
      BUN,
      [
        WT_TOOL,
        "create",
        "--slug",
        "equals-path",
        "--base",
        "main",
        `--project-dir=${equalsProj}`,
      ],
      {
        cwd: equalsProj,
        encoding: "utf-8",
        env: { ...process.env, AIDLC_PROJECT_DIR: equalsProj },
      },
    );
    const alternateProjectSpelling =
      process.platform === "win32"
        ? equalsProj.replaceAll("\\", "/")
        : equalsProj.replaceAll("/", "\\");
    const alternateError = spawnSync(
      BUN,
      [
        WT_TOOL,
        "create",
        "--slug",
        "alternate-path",
        "--base",
        "main",
        `--project-dir=${alternateProjectSpelling}`,
      ],
      {
        cwd: equalsProj,
        encoding: "utf-8",
        env: { ...process.env, AIDLC_PROJECT_DIR: equalsProj },
      },
    );

    test("env-supplied project paths are redacted from Error fields", () => {
      expect(envError.status).not.toBe(0);
      expect(errorBlock(envProj)).toContain("<project-dir>/.aidlc/worktrees");
      expect(errorBlock(envProj)).not.toContain(envProj);
    });

    test("equals-form project paths are redacted from Command and Error fields", () => {
      expect(equalsError.status).not.toBe(0);
      expect(errorBlock(equalsProj)).toContain(
        "--project-dir=<project-dir>",
      );
      expect(errorBlock(equalsProj)).not.toContain(equalsProj);
      expect(alternateError.status).not.toBe(0);
      expect(readAllAuditShards(equalsProj)).not.toContain(
        alternateProjectSpelling,
      );
    });
  });

  describe("merge with explicit intent selectors still recovers the creating repo", () => {
    const proj = freshWorkspace();
    const repoA = makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(
      proj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    const record = activeRecord(proj);
    runWorktree(
      proj,
      "create",
      "--slug",
      "explicit-intent",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    const wt = worktreeDir(proj, "explicit-intent");
    writeFileSync(join(wt, "explicit-intent.txt"), "bound repo\n");
    git(wt, "add", "--", "explicit-intent.txt");
    git(wt, "commit", "-q", "-m", "explicit intent source");
    const merged = runWorktree(
      proj,
      "merge",
      "--slug",
      "explicit-intent",
      "--target",
      "main",
      "--strategy",
      "squash",
      "--space",
      "default",
      "--intent",
      basename(record),
    );

    test("the recorded repository is used even when intent and space are explicit", () => {
      expect(merged.status, merged.out).toBe(0);
      expect(existsSync(join(repoA, "explicit-intent.txt"))).toBe(true);
    });
  });

  describe("merge recovery hints require a complete recorded intent selector", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(
      proj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a,repo-b",
    );
    const intent = basename(activeRecord(proj));
    runWorktree(
      proj,
      "create",
      "--slug",
      "invalid-intent-hint",
      "--base",
      "main",
      "--repo",
      "repo-a",
    );
    const metadataPath = join(
      worktreeDir(proj, "invalid-intent-hint"),
      ".aidlc",
      "worktree-meta.json",
    );
    const metadata = JSON.parse(
      readFileSync(metadataPath, "utf-8"),
    ) as Record<string, unknown>;
    metadata.intentRecord = "garbage-not-a-record-path";
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
    const merged = runWorktree(
      proj,
      "merge",
      "--slug",
      "invalid-intent-hint",
      "--target",
      "main",
      "--strategy",
      "squash",
      "--space",
      "default",
      "--intent",
      intent,
    );

    test("an incomplete recovery selector never renders undefined flags", () => {
      expect(merged.status).not.toBe(0);
      expect(merged.out).toContain("does not match worktree provenance");
      expect(merged.out).not.toContain("undefined");
      expect(merged.out).not.toContain("Retry with --space");
    });
  });

  describe("merge without selectors recovers the worktree's creating intent after the active cursor moves", () => {
    const proj = freshWorkspace();
    const repoA = makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    const first = runUtil(
      proj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-a",
      "--label",
      "original-intent",
    );
    const created = runWorktree(
      proj,
      "create",
      "--slug",
      "cursor-stable",
      "--base",
      "main",
    );
    const wt = worktreeDir(proj, "cursor-stable");
    writeFileSync(join(wt, "cursor-stable.txt"), "original intent\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "cursor stable work");
    const second = runUtil(
      proj,
      "intent-create",
      "--scope",
      "feature",
      "--repos",
      "repo-b",
      "--label",
      "second-intent",
    );
    const merged = runWorktree(
      proj,
      "merge",
      "--slug",
      "cursor-stable",
      "--target",
      "main",
      "--strategy",
      "squash",
    );

    test("both intents and the original worktree are created", () => {
      expect(first.status).toBe(0);
      expect(created.status).toBe(0);
      expect(second.status).toBe(0);
    });
    test("selector-free merge lands in the original intent's repo", () => {
      expect(merged.status, merged.out).toBe(0);
      expect(existsSync(join(repoA, "cursor-stable.txt"))).toBe(true);
    });
  });

  describe("legacy absolute Worktree path rows remain readable", () => {
    const proj = freshWorkspace();
    runUtil(proj, "intent-create", "--scope", "feature");
    const legacyPath = join(
      proj,
      ".aidlc",
      "worktrees",
      "bolt-legacy-audit-path",
    );
    appendAuditEntry(
      "WORKTREE_CREATED",
      {
        "Bolt slug": "legacy-audit-path",
        "Worktree path": legacyPath,
        "Branch name": "bolt-legacy-audit-path",
        "Base branch": "main",
      },
      proj,
    );
    const auditDir = join(activeRecord(proj), "audit");
    for (const file of readdirSync(auditDir)) {
      const path = join(auditDir, file);
      writeFileSync(
        path,
        readFileSync(path, "utf-8").replace(
          "<project-dir>/.aidlc/worktrees/bolt-legacy-audit-path",
          legacyPath,
        ),
      );
    }
    const info = runWorktree(
      proj,
      "info",
      "--slug",
      "legacy-audit-path",
    );

    test("info resolves a legacy absolute audit path without rewriting it", () => {
      expect(info.status, info.out).toBe(0);
      expect(
        (JSON.parse(info.stdout.trim()) as { path: string }).path,
      ).toBe(legacyPath);
    });
  });

  // ===========================================================================
  // Single-repo intent: the lone repo is inferred — no --repo needed.
  // ===========================================================================
  describe("single-repo intent infers the lone repo", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "solo");
    runUtil(proj, "intent-create", "--scope", "feature", "--repos", "solo");
    const inferred = runWorktree(proj, "create", "--slug", "epsilon", "--base", "main");
    const explicit = runWorktree(proj, "create", "--slug", "zeta", "--base", "main", "--repo", "solo");

    test("create WITHOUT --repo forks inside the one recorded repo", () => {
      expect(inferred.status).toBe(0);
      expect(hasBoltBranch(proj, "solo", "epsilon")).toBe(true);
    });
    test("create --repo matching the lone repo is also accepted", () => {
      expect(explicit.status).toBe(0);
      expect(hasBoltBranch(proj, "solo", "zeta")).toBe(true);
    });
  });

  // ===========================================================================
  // Legacy single-repo: the workspace root IS the git repo, no repos recorded.
  // --repo is unnecessary; git runs in the projectDir cwd (today's behaviour).
  // ===========================================================================
  describe("legacy single-repo (projectDir is the git repo)", () => {
    const proj = freshWorkspace();
    // The workspace root itself is the git repo (the pre-multi-repo layout).
    git(proj, "init", "-q", "-b", "main");
    git(proj, "config", "user.email", "t@t");
    git(proj, "config", "user.name", "t");
    git(proj, "commit", "-q", "-m", "init", "--allow-empty");
    // Birth with NO --repos and no sibling repos → no repos row recorded.
    const birth = runUtil(proj, "intent-create", "--scope", "poc");
    const created = runWorktree(proj, "create", "--slug", "legacy", "--base", "main");

    test("birth records no repos row", () => {
      expect(birth.status).toBe(0);
    });
    test("create WITHOUT --repo works (cwd = projectDir, back-compat)", () => {
      expect(created.status).toBe(0);
      // The bolt branch lives in the workspace-root repo.
      expect(git(proj, "rev-parse", "--verify", "refs/heads/bolt-legacy").status).toBe(0);
      expect(existsSync(worktreeDir(proj, "legacy"))).toBe(true);
    });
  });

  describe("legacy single-repo authority canonicalizes project path aliases", () => {
    const proj = freshWorkspace();
    git(proj, "init", "-q", "-b", "main");
    git(proj, "config", "user.email", "t@t");
    git(proj, "config", "user.name", "t");
    git(proj, "commit", "-q", "-m", "init", "--allow-empty");
    runUtil(proj, "intent-create", "--scope", "poc");
    const created = runWorktree(
      proj,
      "create",
      "--slug",
      "path-alias",
      "--base",
      "main",
    );
    const wt = worktreeDir(proj, "path-alias");
    writeFileSync(join(wt, "path-alias.txt"), "canonical authority\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "path alias work");
    const alias = join(dirname(proj), `${basename(proj)}-alias`);
    rmSync(alias, { recursive: true, force: true });
    symlinkSync(
      proj,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    aliasDirs.push(alias);
    const merged = runWorktree(
      alias,
      "merge",
      "--slug",
      "path-alias",
      "--target",
      "main",
      "--strategy",
      "squash",
    );

    test("create succeeds through the canonical project path", () => {
      expect(created.status).toBe(0);
    });
    test("merge through the symlink alias finds the same creation authority", () => {
      expect(merged.status, merged.out).toBe(0);
      expect(existsSync(join(proj, "path-alias.txt"))).toBe(true);
    });
  });

  describe("sibling-repo root source survives real review, finalize, and merge", () => {
    const aidlcRoot = uncommittedSiblingRootSourceScenario("aidlc");
    const dotAidlcRoot = uncommittedSiblingRootSourceScenario(".aidlc");

    test("uncommitted aidlc/ source is bound into Source Commit and merged", () => {
      expect(aidlcRoot.finalized.status, aidlcRoot.finalized.out).toBe(0);
      expect(aidlcRoot.merged.status, aidlcRoot.merged.out).toBe(0);
      expect(aidlcRoot.sourceCommitBytes).toBe("export const reviewed = 2;\n");
      expect(aidlcRoot.mainBytes).toBe("export const reviewed = 2;\n");
    });

    test("uncommitted .aidlc/ source is bound without retaining injected metadata", () => {
      expect(dotAidlcRoot.finalized.status, dotAidlcRoot.finalized.out).toBe(0);
      expect(dotAidlcRoot.merged.status, dotAidlcRoot.merged.out).toBe(0);
      expect(dotAidlcRoot.sourceCommitBytes).toBe("export const reviewed = 2;\n");
      expect(dotAidlcRoot.mainBytes).toBe("export const reviewed = 2;\n");
    });
  });

  // ===========================================================================
  // M1 — the SWARM PREPARE path resolves the target sibling repo. `prepare` is
  // the conductor-facing seam the engine's invoke-swarm directive feeds: it forks
  // a worktree per unit via `aidlc-worktree create`, so the per-unit bolt branch
  // is `bolt-<unit>` (verified: aidlc-swarm.ts:387 forwards `--slug <unit>` +
  // `--repo <resolved>` to create). On a multi-repo intent, prepare WITHOUT --repo
  // dead-ends (resolveConstructionRepo throws "spans 2 repos") — proving --repo is
  // what resolves the dead-end M1 fixes the engine side of.
  // ===========================================================================
  describe("M1 multi-repo: swarm prepare --repo forks the batch inside the target sibling repo", () => {
    const proj = freshWorkspace();
    const repoA = makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    mkdirSync(join(repoA, "aidlc"), { recursive: true });
    writeFileSync(
      join(repoA, "aidlc", "application.ts"),
      "export const reviewed = 1;\n",
    );
    git(repoA, "add", "--", "aidlc/application.ts");
    git(repoA, "commit", "-q", "-m", "seed sibling aidlc application source");
    runUtil(proj, "intent-create", "--scope", "feature", "--repos", "repo-a,repo-b");
    seedOneUnitDag(proj, "swarmunit");
    const prepared = runSwarm(
      proj, "prepare", "--batch", "1", "--units", "swarmunit", "--base", "main", "--repo", "repo-a",
    );
    const wt = worktreeDir(proj, "swarmunit");
    writeFileSync(
      join(wt, "aidlc", "application.ts"),
      "export const reviewed = 2;\n",
    );
    git(wt, "add", "--", "aidlc/application.ts");
    git(wt, "commit", "-q", "-m", "reviewed sibling aidlc application source");
    const sourceCommit = git(wt, "rev-parse", "HEAD").out.trim();
    const sourceFingerprint = workspaceSourceFingerprint(wt);
    if (sourceFingerprint !== null) {
      appendAuditEntry(
        "SWARM_UNIT_CONVERGED",
        {
          "Batch number": "1",
          "Unit name": "swarmunit",
          Stage: "code-generation",
          "Run floor": latestMainWorkflowStageRunFloorForProject(
            proj,
            "code-generation",
          ),
          "Source Fingerprint": sourceFingerprint,
          "Source Commit": sourceCommit,
        },
        proj,
      );
    }
    const merged = sourceFingerprint !== null
      ? runWorktree(proj, "merge", "--slug", "swarmunit", "--target", "main", "--strategy", "squash", "--repo", "repo-a")
      : { status: -1, out: "source fingerprint unavailable", stdout: "" };
    const reviewed = merged.status === 0
      ? recordMainReview(
          proj,
          "swarmunit",
          "repo-a",
          "aidlc/application.ts",
        )
      : { status: -1, out: merged.out, stdout: "" };
    const approved = reviewed.status === 0
      ? runState(proj, "approve", "code-generation", "--user-input", "ship")
      : { status: -1, out: reviewed.out, stdout: "" };
    const discardCreated = approved.status === 0
      ? runWorktree(
          proj,
          "create",
          "--slug",
          "audit-discard",
          "--base",
          "main",
          "--repo",
          "repo-a",
        )
      : { status: -1, out: approved.out, stdout: "" };
    const discarded = discardCreated.status === 0
      ? runWorktree(
          proj,
          "discard",
          "--slug",
          "audit-discard",
          "--repo",
          "repo-a",
        )
      : { status: -1, out: discardCreated.out, stdout: "" };

    test("prepare --repo repo-a exits 0", () => {
      expect(prepared.status).toBe(0);
    });
    test("reviewed sibling aidlc/ source merges with authority and completes", () => {
      expect(merged.status, merged.out).toBe(0);
      expect(
        readFileSync(join(repoA, "aidlc", "application.ts"), "utf-8"),
      ).toContain("reviewed = 2");
      const audit = readAllAuditShards(proj);
      expect(audit).toContain("**Event**: SWARM_SOURCE_MERGED");
      expect(reviewed.status, reviewed.out).toBe(0);
      expect(approved.status, approved.out).toBe(0);
      expect(readAllAuditShards(proj)).toContain("**Event**: STAGE_COMPLETED");
    });
    test("the complete create/merge/discard audit ledger carries no absolute project path", () => {
      expect(discardCreated.status, discardCreated.out).toBe(0);
      expect(discarded.status, discarded.out).toBe(0);
      const audit = readAllAuditShards(proj);
      expect(audit).not.toContain(proj);
      const worktreePaths = audit
        .split(/\r?\n/)
        .filter((line) => line.startsWith("**Worktree path**:"));
      expect(worktreePaths.length).toBeGreaterThan(0);
      expect(
        worktreePaths.every((line) =>
          line.includes("**Worktree path**: .aidlc/worktrees/bolt-")
        ),
      ).toBe(true);
    });
  });

  describe("M1 multi-repo: swarm prepare WITHOUT --repo dead-ends (the bug --repo fixes)", () => {
    const proj = freshWorkspace();
    makeSiblingRepo(proj, "repo-a");
    makeSiblingRepo(proj, "repo-b");
    runUtil(proj, "intent-create", "--scope", "feature", "--repos", "repo-a,repo-b");
    seedOneUnitDag(proj, "orphanunit");
    const prepared = runSwarm(proj, "prepare", "--batch", "1", "--units", "orphanunit", "--base", "main");

    test("exits non-zero with a 'spans 2 repos' message", () => {
      expect(prepared.status).not.toBe(0);
      expect(prepared.out).toContain("spans 2 repos");
    });
    test("no worktree or branch leaked into either repo", () => {
      expect(existsSync(worktreeDir(proj, "orphanunit"))).toBe(false);
      expect(hasBoltBranch(proj, "repo-a", "orphanunit")).toBe(false);
      expect(hasBoltBranch(proj, "repo-b", "orphanunit")).toBe(false);
    });
  });
});
