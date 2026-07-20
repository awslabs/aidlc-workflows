// covers: cli:aidlc-state(approve,advance,finalize,complete-workflow), function:handleApprove, function:handleAdvance, function:handleFinalize, function:handleCompleteWorkflow, function:verifyStageArtifacts, function:producesArtifactsExist, function:workspaceHasSourceFile
//
// t185 - stage-completion artifact guard (issue #366).
//
// Mechanism: cli. The subject is the deterministic filesystem guard the state
// tool runs BEFORE marking a stage complete on the four forward-completion
// paths - `approve` ([?] -> [x] + auto-advance), a direct `advance` (the
// gate-skip attack path), `finalize`, and `complete-workflow`. Each terminates
// with process.exit on a guard failure, and the guard reads the project's
// per-intent record dir + workspace tree, so this is a PROCESS boundary
// exercised by spawning the real dist tool (spawnSync(BUN, [STATE, ...])).
//
// V2 PATH NOTE: the workspace refactor (#429) removed the flat aidlc-docs/
// layout. A stage's produces[] artifacts now live under the ACTIVE intent's
// per-intent record dir (aidlc/spaces/<space>/intents/<slug>-<id8>/<phase>/
// <stage>/), per-unit Construction artifacts under that record's
// construction/<unit>/<stage>/, and codekb stages (reverse-engineering) under
// the space-level aidlc/spaces/<space>/codekb/<repo>/. This test seeds those
// live seams via seededRecordDir, NOT a flat aidlc-docs/ tree.
//
// Source under test (dist/claude/.claude/tools/aidlc-state.ts):
//   verifyStageArtifacts(pd, stage) - two layers:
//     1. producesArtifactsExist - a stage that declares produces[] must have at
//        least one declared .md on disk under <record>/<phase>/<slug>/ (or
//        <record>/construction/<unit>/<slug>/ for per-unit stages, or
//        <space>/codekb/<repo>/ for codekb stages). Empty-produces stages
//        vacuously pass.
//     2. workspace_requires - a code-producing stage (frontmatter flag, set on
//        code-generation) must ALSO have a file outside the aidlc/ workspace
//        tree + harness dirs (issue #366 Update 2: docs-only code-generation
//        must not pass).
//   Bypass: AIDLC_SKIP_ARTIFACT_GUARD=1 (env).
//
// CRITICAL test-harness note: run-tests.ts sets AIDLC_SKIP_ARTIFACT_GUARD=1 for
// the whole suite (most state tests rubber-stamp bare fixtures by design). This
// test re-enables enforcement by DELETING that var from the spawned tool's env
// - otherwise it would be testing the bypass, not the guard.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seededAuditShard,
  seededRecordDir,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const MID_IDEATION = "state-mid-ideation.md"; // Current Stage: feasibility

function reviewCodeGen(proj: string, unit: string): void {
  spawnSync(BUN, [
    LOG,
    "review",
    "--stage",
    "code-generation",
    "--unit",
    unit,
    "--reviewer",
    "aidlc-architecture-reviewer-agent",
    "--iteration",
    "1",
    "--verdict",
    "READY",
    "--project-dir",
    proj,
  ], { encoding: "utf-8" });
}

// Drive a state subcommand with the artifact guard ENABLED (clear the suite's
// bypass var). Returns exit code + combined output.
function guarded(proj: string, args: string[]): { rc: number; out: string } {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_ARTIFACT_GUARD;
  env.AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS = "1";
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// Same but with the bypass var set - proves the escape hatch.
function bypassed(proj: string, args: string[]): { rc: number; out: string } {
  const env = {
    ...process.env,
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
  };
  const r = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    env,
  });
  return { rc: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function field(proj: string, name: string): string {
  return guarded(proj, ["get", name]).out.trim();
}

// Write a stage's produces[] doc under the ACTIVE intent's record dir so the
// produces-existence layer is satisfied. `rel` is relative to the record dir
// (e.g. "ideation/feasibility/feasibility-assessment.md").
function writeRecordDoc(proj: string, rel: string): void {
  const full = join(seededRecordDir(proj), rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "# stub\n\n## A\n\n## B\n");
}

// Write a file at the workspace root (outside the aidlc/ tree + harness dirs).
function writeWorkspaceFile(proj: string, rel: string): void {
  const full = join(proj, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "export const x = 1;\n");
}

let proj: string;

describe("t185: stage-completion artifact guard (#366)", () => {
  beforeEach(() => {
    resetAidlcEnv();
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION); // Current Stage: feasibility
  });

  afterEach(() => cleanupTestProject(proj));

  // --- Layer 1: produces-existence, ideation stage (feasibility) -------------

  test("approve REFUSES when the stage produced no artifacts", () => {
    const slug = field(proj, "Current Stage"); // feasibility
    bypassed(proj, ["checkbox", `${slug}=in-progress`]);
    bypassed(proj, ["gate-start", slug]);
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to complete");
    // State untouched: the stage is NOT marked completed.
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  test("gate-start REFUSES before [?] when the stage produced no artifacts", () => {
    const slug = field(proj, "Current Stage");
    const r = guarded(proj, ["gate-start", slug]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to complete");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
      `- [-] ${slug}`,
    );
  });

  test("revise REFUSES before [?] when revised artifacts are absent", () => {
    const slug = field(proj, "Current Stage");
    bypassed(proj, ["checkbox", `${slug}=revising`]);
    const r = guarded(proj, ["revise", slug]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to complete");
    expect(readFileSync(seededStateFile(proj), "utf-8")).toContain(
      `- [R] ${slug}`,
    );
  });

  test("direct advance (gate-skipping path) REFUSES when no artifacts", () => {
    const slug = field(proj, "Current Stage");
    const r = guarded(proj, ["advance", slug]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to complete");
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  // The other two completing transitions (finalize + complete-workflow) also
  // mark a stage [x], so they must run the same guard - otherwise they are an
  // unguarded rubber-stamp backdoor on the direct-CLI surface.
  test("finalize REFUSES when no artifacts", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    const r = guarded(proj, ["finalize", slug]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to complete");
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  test("complete-workflow REFUSES when no artifacts", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    const r = guarded(proj, ["complete-workflow", slug]);
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("Refusing to complete");
    expect(field(proj, "Current Stage")).toBe(slug);
  });

  test("finalize bypasses the guard under AIDLC_SKIP_ARTIFACT_GUARD (no artifacts)", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    const r = bypassed(proj, ["finalize", slug]);
    expect(r.rc).toBe(0);
  });

  test("approve PASSES once a declared produces[] artifact exists", () => {
    const slug = field(proj, "Current Stage"); // feasibility, phase ideation
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    writeRecordDoc(proj, `ideation/${slug}/feasibility-assessment.md`);
    guarded(proj, ["gate-start", slug]);
    const r = guarded(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).toBe(0);
    // Auto-advanced off feasibility.
    expect(field(proj, "Current Stage")).not.toBe(slug);
  });

  // --- Bypasses --------------------------------------------------------------

  test("approve bypasses the guard under AIDLC_SKIP_ARTIFACT_GUARD (no artifacts)", () => {
    const slug = field(proj, "Current Stage");
    guarded(proj, ["checkbox", `${slug}=in-progress`]);
    bypassed(proj, ["gate-start", slug]);
    const r = bypassed(proj, ["approve", slug, "--user-input", "ok"]);
    expect(r.rc).toBe(0);
  });

  test("AIDLC_SKIP_ARTIFACT_GUARD=1 bypasses the guard (no artifacts)", () => {
    const slug = field(proj, "Current Stage");
    const r = bypassed(proj, ["advance", slug]);
    expect(r.rc).toBe(0);
  });

  // --- Layer 2: workspace_requires (code-generation, per-unit) ---------------

  describe("workspace_requires (code-generation)", () => {
    const UNIT = "user-auth";

    // Move the pointer to code-generation, in-progress, and write its two
    // per-unit produces[] docs under the record's construction/<unit>/ subtree
    // (satisfies layer 1) but NO source code.
    function stageCodeGenDocsOnly(): void {
      guarded(proj, ["set", "Current Stage=code-generation"]);
      guarded(proj, ["checkbox", "code-generation=in-progress"]);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/code-generation-plan.md`);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/code-summary.md`);
    }

    test("REFUSES code-generation with planning docs but no source code", () => {
      stageCodeGenDocsOnly();
      bypassed(proj, ["gate-start", "code-generation"]);
      const r = guarded(proj, ["approve", "code-generation", "--user-input", "ok"]);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("workspace_requires");
    });

    test("PASSES code-generation once real source exists outside aidlc/", () => {
      stageCodeGenDocsOnly();
      writeWorkspaceFile(proj, "src/auth/login.ts"); // outside aidlc/ + harness
      guarded(proj, ["gate-start", "code-generation"]);
      reviewCodeGen(proj, UNIT);
      const r = guarded(proj, ["approve", "code-generation", "--user-input", "ok"]);
      expect(r.rc).toBe(0);
    });
  });

  // --- Layer 1 (codekb placement): reverse-engineering -----------------------
  //
  // V2-specific: codekb stages (reverse-engineering) write their produces[] to
  // the space-level aidlc/spaces/<space>/codekb/<repo>/ dir, NOT a per-intent
  // record dir. The guard must resolve THAT placement, else it false-refuses a
  // real reverse-engineering approval. (The old flat-path design had no codekb
  // concept; this case did not exist in the reference t154.)
  describe("codekb placement (reverse-engineering)", () => {
    function writeCodekbDoc(name: string): void {
      // basename(proj) is codekbRepoName's default when the intent records no
      // repos (the fixture records none) - the same key the tool resolves.
      const repo = proj.split("/").filter(Boolean).pop() ?? "repo";
      const dir = join(proj, "aidlc", "spaces", "default", "codekb", repo);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.md`), "# stub\n");
    }

    test("REFUSES reverse-engineering with no codekb artifacts", () => {
      guarded(proj, ["set", "Current Stage=reverse-engineering"]);
      guarded(proj, ["checkbox", "reverse-engineering=in-progress"]);
      bypassed(proj, ["gate-start", "reverse-engineering"]);
      const r = guarded(proj, ["approve", "reverse-engineering", "--user-input", "ok"]);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("Refusing to complete");
    });

    test("PASSES reverse-engineering once a codekb artifact exists", () => {
      guarded(proj, ["set", "Current Stage=reverse-engineering"]);
      guarded(proj, ["checkbox", "reverse-engineering=in-progress"]);
      writeCodekbDoc("business-overview"); // a declared produces[] of RE
      guarded(proj, ["gate-start", "reverse-engineering"]);
      const r = guarded(proj, ["approve", "reverse-engineering", "--user-input", "ok"]);
      expect(r.rc).toBe(0);
    });
  });

  // --- Layer 2 (git-aware): workspace_requires in a GIT workspace ------------
  //
  // The bare filesystem check (above) passes whenever ANY non-doc file exists -
  // which on a BROWNFIELD repo (pre-existing src/) is always true, even if this
  // session's code-generation produced nothing. In a git workspace the guard
  // instead asks git "was there real source work?" - an uncommitted/untracked
  // non-doc change, OR a non-doc path in the last commit (so commit-then-approve
  // still passes; #366 Update 3's clean-tree false-block is closed). "Non-doc" =
  // first path segment not in the aidlc/ workspace tree + harness dirs.
  describe("workspace_requires git-aware (code-generation in a git repo)", () => {
    const UNIT = "user-auth";

    function git(args: string[]): void {
      const r = spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
    function initGitRepo(): void {
      git(["init", "-q"]);
      git(["config", "user.email", "t185@example.com"]);
      git(["config", "user.name", "t185"]);
      git(["config", "commit.gpgsign", "false"]);
    }
    function stageCodeGenDocsOnly(): void {
      guarded(proj, ["set", "Current Stage=code-generation"]);
      guarded(proj, ["checkbox", "code-generation=in-progress"]);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/code-generation-plan.md`);
      writeRecordDoc(proj, `construction/${UNIT}/code-generation/code-summary.md`);
    }
    function approveCodeGen(): { rc: number; out: string } {
      bypassed(proj, ["gate-start", "code-generation"]);
      reviewCodeGen(proj, UNIT);
      return guarded(proj, ["approve", "code-generation", "--user-input", "ok"]);
    }

    // BROWNFIELD bug closed: a git repo whose src/ was committed in a PRIOR
    // commit, with a clean tree and only doc changes this session, must REFUSE -
    // the bare FS check would have wrongly passed on the pre-existing src/.
    test("REFUSES when src/ is pre-existing (committed earlier) and no new code this session", () => {
      initGitRepo();
      writeWorkspaceFile(proj, "src/legacy/old.ts"); // brownfield baseline
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "baseline brownfield code"]);
      // This session: only the code-gen planning docs (no new code), then commit
      // ONLY the aidlc/ docs so the working tree is clean and the last commit is
      // doc-only.
      stageCodeGenDocsOnly();
      git(["add", "aidlc"]);
      git(["commit", "-q", "-m", "code-gen planning docs only"]);
      const r = approveCodeGen();
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("workspace_requires");
    }, 30000);

    // Uncommitted/untracked new source this session -> PASS.
    test("PASSES with an uncommitted new source file this session", () => {
      initGitRepo();
      git(["commit", "-q", "--allow-empty", "-m", "init"]);
      stageCodeGenDocsOnly();
      writeWorkspaceFile(proj, "src/auth/login.ts"); // untracked, uncommitted
      const r = approveCodeGen();
      expect(r.rc).toBe(0);
    }, 30000);

    // commit-then-approve (clean tree, code in the LAST commit) -> PASS. This is
    // the exact pattern #366 Update 3 reported as a false-block under a naive
    // git-diff-HEAD check; the HEAD~1..HEAD fallback covers it.
    test("PASSES when this session's code is in the last commit (clean tree)", () => {
      initGitRepo();
      git(["commit", "-q", "--allow-empty", "-m", "init"]);
      stageCodeGenDocsOnly();
      writeWorkspaceFile(proj, "src/auth/login.ts");
      git(["add", "-A"]); // stage BOTH the docs and the new code
      git(["commit", "-q", "-m", "code-generation output"]);
      const r = approveCodeGen();
      expect(r.rc).toBe(0);
    }, 30000);

    // SINGLE-commit clean tree, the source IS in the sole commit -> PASS. The
    // greenfield "git init, generate, commit, approve" path: there is no parent,
    // so `git diff HEAD~1 HEAD` errors and gitHasSourceWork cannot inspect the
    // last commit. It must return null (NOT false) so workspaceHasWork falls back
    // to the filesystem probe, which sees the committed src/ - otherwise the
    // code-generation approve is false-refused (gitHasSourceWork header contract;
    // @leandrodamascena's PR #443 review). Distinct from the case above: that one
    // makes a separate `--allow-empty init` commit first (HEAD~1 resolves); this
    // one has exactly ONE commit (HEAD~1 misses).
    test("PASSES on a single-commit clean tree whose only commit contains the source", () => {
      initGitRepo();
      stageCodeGenDocsOnly();
      writeWorkspaceFile(proj, "src/auth/login.ts");
      git(["add", "-A"]); // stage docs + the new code into the FIRST and ONLY commit
      git(["commit", "-q", "-m", "first commit: code-generation output"]);
      const r = approveCodeGen();
      expect(r.rc).toBe(0);
    }, 30000);
  });

  // --- Settled-swarm exemption (code-generation under autonomous swarm) ------
  //
  // A swarm's per-unit artifacts and source live in Bolt WORKTREES; the main
  // checkout has neither, so both guard layers would refuse the settle
  // approval the engine just presented. The referee's per-unit convergence
  // ledger is the evidence instead: with a valid DAG whose EVERY unit has a
  // current-run SWARM_UNIT_CONVERGED row, the guard exempts. Any unconverged
  // unit keeps the guard strict (fails closed).
  describe("settled-swarm exemption (autonomous code-generation)", () => {
    const UNITS = ["user-auth", "billing"];

    function seedSwarm(converged: string[]): void {
      guarded(proj, ["set", "Current Stage=code-generation"]);
      guarded(proj, ["checkbox", "code-generation=in-progress"]);
      // Autonomy grant: append the field beside Scope (fixture ships without it).
      const statePath = seededStateFile(proj);
      writeFileSync(
        statePath,
        readFileSync(statePath, "utf-8").replace(
          /^(- \*\*Scope\*\*: .*)$/m,
          "$1\n- **Construction Autonomy Mode**: autonomous",
        ),
      );
      // A valid two-unit DAG in the compiled runtime graph.
      writeFileSync(
        join(seededRecordDir(proj), "runtime-graph.json"),
        `${JSON.stringify({
          bolt_dag: {
            units: UNITS.map((name) => ({ name, depends_on: [] })),
            batches: [UNITS],
          },
        })}\n`,
      );
      // Referee convergence rows for the converged subset, carrying the
      // attempt-identity stamp (Stage + Run floor) the consumers require; the
      // fixture has no STAGE_STARTED row, so the matching floor is "".
      const shard = seededAuditShard(proj);
      mkdirSync(join(shard, ".."), { recursive: true });
      const rows = converged
        .map((unit, i) =>
          [
            "## Swarm Unit Converged",
            `**Timestamp**: 2026-07-18T00:00:0${i}.000Z`,
            "**Event**: SWARM_UNIT_CONVERGED",
            `**Unit name**: ${unit}`,
            "**Stage**: code-generation",
            "**Run floor**: ",
            "",
            "---",
            "",
          ].join("\n")
        )
        .join("");
      writeFileSync(shard, rows, { flag: "a" });
      for (const unit of converged) reviewCodeGen(proj, unit);
    }

    test("PASSES with zero on-disk artifacts once every DAG unit converged", () => {
      seedSwarm(UNITS); // all converged; nothing written to the record dir
      bypassed(proj, ["gate-start", "code-generation"]);
      const r = guarded(proj, ["approve", "code-generation", "--user-input", "ok"]);
      expect(r.rc).toBe(0);
    });

    test("REFUSES while any DAG unit is unconverged (fails closed)", () => {
      seedSwarm([UNITS[0]]); // one of two converged
      bypassed(proj, ["gate-start", "code-generation"]);
      const r = guarded(proj, ["approve", "code-generation", "--user-input", "ok"]);
      expect(r.rc).not.toBe(0);
      expect(r.out).toContain("Refusing to complete");
    });
  });
});
