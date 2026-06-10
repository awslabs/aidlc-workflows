// covers: cli:aidlc-bolt(complete-merge,abort-discard), cli:aidlc-runtime(compile), cli:aidlc-worktree(create), cli:aidlc-audit(append), function:auditLockDir
//
// t49 — Integration: Bolt fork/merge for runtime-graph + parallel instances[]
// + failure-mode coverage (v0.5.0 milestone 11). Migrated from
// tests/integration/t49-bolt-sensor-failures.sh (TAP plan 8). The .sh declared
// NO `# covers:` header; the covers ids above were derived from the units its
// body exercises end-to-end.
//
// Mechanism: cli. This is a full real-tool flow — it drives `git worktree`,
// `aidlc-worktree create`, `aidlc-bolt start --worktree`, `aidlc-bolt complete
// --merge`, `aidlc-bolt abort --discard`, and `aidlc-runtime compile` as real
// subprocesses, then asserts on the file side-effects (aidlc-docs/audit.md,
// aidlc-docs/runtime-graph.json) and process boundaries (exit codes, stderr
// envelopes). An in-process twin would lose the spawn chain
// handleComplete -> spawnSibling(state-merge) -> spawnSibling(audit-merge) ->
// spawnSibling(fragment-merge) that every failure-ordering assertion depends
// on, and the AIDLC_AUDIT_LOCK_RETRIES env-seam (case 6). So everything stays
// spawned, exactly as the .sh ran it. spawnCount = all.
//
// IMPORTANT cwd contract (same as the .sh, t49:99-126): aidlc-worktree.ts's
// assertNotSiblingWorktree (aidlc-worktree.ts:101-121) checks
// `git rev-parse --show-toplevel` against `git rev-parse --git-common-dir`'s
// parent — i.e. against CWD, not --project-dir. Running from this test's cwd
// would trip the sibling-worktree refusal. So every worktree/bolt spawn runs
// with `cwd: proj` (the .sh did `(cd "$1" && bun ... )`).
//
// Source under test:
//   - dist/claude/.claude/tools/aidlc-bolt.ts handleComplete (:307) — the
//     merge chain ordering: BOLT_COMPLETED emit (:354) → state-merge (:371) →
//     audit-merge (:390) → fragment-merge (:412). Each step's failure calls
//     failBolt (BOLT_FAILED recovery row) + failJson (envelope + exit 1).
//   - aidlc-bolt.ts handleAbort (:498) — abort --discard tears down the
//     worktree then emits BOLT_FAILED (Reason: aborted).
//   - aidlc-runtime.ts compile populator (:401-551) — instances[] detection
//     (≥2 distinct Bolt slug STATE_FORKED rows in window), alphabetical sort
//     (:486), per-instance outcome (STATE_MERGED→approved, else BOLT_FAILED→
//     failed, else pending, :504-508), parent rollup (anyFailed→failed,
//     :527), per-instance sensor_firings:[] forward-noted gap (:518).
//   - aidlc-lib.ts auditLockDir (:512) — md5(projectDir).slice(0,8) prefixed
//     `.aidlc-audit-` + `.lock` under tmpdir; the directory whose presence
//     case 6 plants to force a lock-acquire failure.
//
// Old TAP -> new test parity (1:1, every .sh `ok` -> a named test()):
//   .sh (1) instances[].length=3 alphabetical        -> "1: 3-Bolt parallel batch — instances[] = [auth,cart,pay] (alphabetical)"
//   .sh (2) sensors advisory: SENSOR_FAILED in main   -> "2: sensors advisory — SENSOR_FAILED in main audit yet all 3 instances approved"
//   .sh (3) instances[].sensor_firings:[] per milestone 11   -> "3: milestone 11 contract — instances[].sensor_firings:[] despite SENSOR_FAILED in main"
//   .sh (4) Bolt failure rollup pay:failed parent:failed -> "4: Bolt failure rollup — pay abort --discard => instance pay:failed + parent:failed"
//   .sh (5) idempotent re-merge errors at state-merge -> "5: idempotent re-merge — second complete --merge errors 'already merged' at state-merge"
//   .sh (6) lock-acquire failure before fragment-merge -> "6: lock-acquire failure — complete --merge errors before fragment-merge; fragment file survives"
//   .sh (7) fragment-merge fails after audit-merge     -> "7: soft-gap — fragment-merge fails after audit-merge => AUDIT_MERGED + BOLT_FAILED(fragment-merge-failed)"
//   .sh (8) determinism: re-compile byte-equivalent    -> "8: determinism (L11) — re-compile after BOLT_FAILED + recovery is byte-equivalent"

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";
import { auditLockDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath; // the bun running this test
const WORKTREE_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const BOLT_TOOL = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const RUNTIME_TOOL = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
const AUDIT_TOOL = join(AIDLC_SRC, "tools", "aidlc-audit.ts");

const tempProjects: string[] = [];

afterAll(() => {
  for (const p of tempProjects) {
    // Each project hosts real `git worktree` children under .aidlc/worktrees/;
    // their git metadata blocks a plain rm -rf, so prune them first (mirrors
    // the harness's cleanupWorktreeFixture). Then drop the per-project audit
    // lock dir (TMPDIR-level, outside the project) and rm -rf the tree. This is
    // stronger than the .sh's chmod+rm EXIT trap, which leaked git-worktree
    // dirs across runs.
    const list = spawnSync("git", ["-C", p, "worktree", "list", "--porcelain"], {
      encoding: "utf-8",
    });
    if (list.status === 0) {
      let mainSeen = false;
      for (const line of (list.stdout || "").split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const wt = line.slice("worktree ".length);
        if (!mainSeen) {
          mainSeen = true;
          continue;
        }
        spawnSync("git", ["-C", p, "worktree", "remove", "--force", wt], {
          encoding: "utf-8",
        });
      }
    }
    try {
      spawnSync("chmod", ["-R", "u+w", p]);
    } catch {
      /* best effort */
    }
    rmSync(auditLockDir(p), { recursive: true, force: true });
    rmSync(p, { recursive: true, force: true });
  }
});

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  out: string; // combined, mirrors the .sh's 2>&1
}

/** Spawn a tool against `proj` FROM `proj` (cwd contract above). */
function runIn(proj: string, tool: string, args: string[], env?: Record<string, string>): Run {
  const res = spawnSync(BUN, [tool, "--project-dir", proj, ...args], {
    cwd: proj,
    encoding: "utf-8",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { status: res.status ?? -1, stdout, stderr, out: `${stdout}${stderr}` };
}

const wtCreate = (proj: string, slug: string): Run =>
  runIn(proj, WORKTREE_TOOL, ["create", "--slug", slug, "--base", "main"]);
const boltStart = (proj: string, slug: string): Run =>
  runIn(proj, BOLT_TOOL, [
    "start", "--name", slug, "--batch", "1",
    "--walking-skeleton", "false", "--worktree", "--slug", slug,
  ]);
const boltComplete = (proj: string, slug: string, env?: Record<string, string>): Run =>
  runIn(proj, BOLT_TOOL, ["complete", "--name", slug, "--batch", "1", "--merge", "--slug", slug], env);
const boltAbortDiscard = (proj: string, slug: string): Run =>
  runIn(proj, BOLT_TOOL, ["abort", "--name", slug, "--reason", "test", "--slug", slug, "--discard"]);
const runtimeCompile = (proj: string): Run => runIn(proj, RUNTIME_TOOL, ["compile"]);

/** Append an audit row to a (worktree or main) project dir via the real CLI. */
function auditAppend(dir: string, event: string, fields: [string, string][]): void {
  const flagArgs: string[] = [];
  for (const [k, v] of fields) flagArgs.push("--field", `${k}=${v}`);
  spawnSync(BUN, [AUDIT_TOOL, "--project-dir", dir, "append", event, ...flagArgs], {
    cwd: dir,
    encoding: "utf-8",
  });
}

const fragPath = (proj: string, slug: string): string =>
  join(proj, ".aidlc", "worktrees", `bolt-${slug}`, "aidlc-docs", "runtime-graph.json");

/**
 * Build a clean git-init'd project with seeded construction state + empty
 * audit + the framework gitignore, then seed WORKFLOW_STARTED + STAGE_STARTED
 * for code-generation so the compile populator has a window. Mirrors the .sh's
 * make_proj (t49:68-97). Returns the canonical project root.
 */
function makeProj(): string {
  let proj = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-t49-"));
  try {
    proj = realpathSync(proj);
  } catch {
    /* keep raw */
  }
  tempProjects.push(proj);
  const git = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
  };
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(proj, "README.md"), "seed\n");
  mkdirSync(join(proj, "aidlc-docs"), { recursive: true });
  writeFileSync(
    join(proj, "aidlc-docs", "aidlc-state.md"),
    readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8"),
  );
  writeFileSync(join(proj, "aidlc-docs", "audit.md"), "");
  writeFileSync(
    join(proj, ".gitignore"),
    "aidlc-docs/audit.md\naidlc-docs/runtime-graph.json\naidlc-docs/.aidlc-recovery.md\naidlc-docs/.aidlc-hooks-health/\n",
  );
  git(["add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  // Window for the parallel-Bolt populator to detect instances in.
  auditAppend(proj, "WORKFLOW_STARTED", [
    ["Workflow ID", `t49-${Math.floor(Math.random() * 1e9)}`],
    ["Scope", "feature"],
    ["Intent", "t49"],
  ]);
  auditAppend(proj, "STAGE_STARTED", [["Stage", "code-generation"]]);
  return proj;
}

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary compiled-graph JSON shape
type Graph = any;
// biome-ignore lint/suspicious/noExplicitAny: a stage row / instance is arbitrary compiled JSON
type StageRow = any;

/** Load the compiled main runtime-graph.json, or null if absent. */
function loadGraph(proj: string): Graph | null {
  const p = join(proj, "aidlc-docs", "runtime-graph.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

/** The code-generation stage row from a compiled graph. */
function codegenStage(graph: Graph): StageRow | undefined {
  return graph?.stages?.find((s: StageRow) => s.stage_slug === "code-generation");
}

/** Count `**Event**: <EVENT>` occurrences in main audit.md (the .sh's grep -c). */
function countEvent(proj: string, event: string): number {
  const p = join(proj, "aidlc-docs", "audit.md");
  if (!existsSync(p)) return 0;
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.includes(`**Event**: ${event}`)).length;
}

const TEST_TIMEOUT = 120_000; // real git + multiple bun spawns per case

describe("t49 Bolt fork/merge runtime-graph + failure modes (migrated from t49-bolt-sensor-failures.sh, plan 8)", () => {
  // ===========================================================================
  // Cases 1-3 — End-to-end 3-Bolt batch with a sensor failure on `pay`.
  // Shared project so the single expensive flow drives all three assertions
  // (same as the .sh, which ran the batch once then asserted 1/2/3).
  // ===========================================================================
  let batchProj: string;
  let batchGraph: Graph;

  function buildBatch(): void {
    if (batchProj) return;
    batchProj = makeProj();
    for (const slug of ["pay", "auth", "cart"]) {
      const c = wtCreate(batchProj, slug);
      expect(c.status).toBe(0); // worktree create succeeded (sibling-refusal not tripped)
      const s = boltStart(batchProj, slug);
      expect(s.status).toBe(0);
    }

    // Simulate the milestone 10 hook + milestone 9 dispatcher: a SENSOR_FIRED + SENSOR_FAILED
    // pair written to pay's WORKTREE audit. Direct-append (deterministic) so we
    // verify the audit-merge + compile propagation, not any sensor predicate.
    const payWt = join(batchProj, ".aidlc", "worktrees", "bolt-pay");
    mkdirSync(join(payWt, "aidlc-docs"), { recursive: true });
    auditAppend(payWt, "SENSOR_FIRED", [
      ["Sensor", "required-sections"],
      ["Stage", "code-generation"],
      ["Output path", "aidlc-docs/some-output.md"],
      ["Bolt slug", "pay"],
    ]);
    auditAppend(payWt, "SENSOR_FAILED", [
      ["Sensor", "required-sections"],
      ["Stage", "code-generation"],
      ["Output path", "aidlc-docs/some-output.md"],
      ["Detail path", "aidlc-docs/.aidlc-sensors/required-sections-fail.txt"],
      ["Bolt slug", "pay"],
    ]);

    // Complete all 3 in arbitrary order, then compile.
    expect(boltComplete(batchProj, "cart").status).toBe(0);
    expect(boltComplete(batchProj, "pay").status).toBe(0);
    expect(boltComplete(batchProj, "auth").status).toBe(0);
    runtimeCompile(batchProj);
    batchGraph = loadGraph(batchProj);
  }

  test("1: 3-Bolt parallel batch — instances[] = [auth,cart,pay] (alphabetical)", () => {
    buildBatch();
    const stage = codegenStage(batchGraph);
    expect(stage).toBeDefined();
    const slugs = (stage.instances ?? []).map((i: StageRow) => i.bolt);
    expect(slugs).toEqual(["auth", "cart", "pay"]); // length 3, alphabetical-by-slug
  }, TEST_TIMEOUT);

  test("2: sensors advisory — SENSOR_FAILED in main audit yet all 3 instances approved", () => {
    buildBatch();
    const stage = codegenStage(batchGraph);
    const instances = stage.instances ?? [];
    expect(instances.length).toBe(3);
    // SENSOR_FAILED ≠ Bolt failure: every instance still outcome:approved.
    expect(instances.every((i: StageRow) => i.outcome === "approved")).toBe(true);
    // The merged worktree audit carries ≥1 SENSOR_FAILED row into main.
    expect(countEvent(batchProj, "SENSOR_FAILED")).toBeGreaterThanOrEqual(1);
  }, TEST_TIMEOUT);

  test("3: milestone 11 contract — instances[].sensor_firings:[] despite SENSOR_FAILED in main", () => {
    buildBatch();
    const stage = codegenStage(batchGraph);
    const instances = stage.instances ?? [];
    expect(instances.length).toBe(3);
    // Per-instance attribution lands later; every instance has an empty array.
    expect(
      instances.every((i: StageRow) => Array.isArray(i.sensor_firings) && i.sensor_firings.length === 0),
    ).toBe(true);
  }, TEST_TIMEOUT);

  // ===========================================================================
  // Case 4 — Bolt failure rollup: pay aborts mid-Bolt (abort --discard).
  // ===========================================================================
  test("4: Bolt failure rollup — pay abort --discard => instance pay:failed + parent:failed", () => {
    const proj = makeProj();
    for (const slug of ["auth", "cart", "pay"]) {
      expect(wtCreate(proj, slug).status).toBe(0);
      expect(boltStart(proj, slug).status).toBe(0);
    }
    expect(boltComplete(proj, "auth").status).toBe(0);
    expect(boltComplete(proj, "cart").status).toBe(0);
    expect(boltAbortDiscard(proj, "pay").status).toBe(0);
    runtimeCompile(proj);

    const stage = codegenStage(loadGraph(proj));
    expect(stage).toBeDefined();
    const slugs = (stage.instances ?? []).map((i: StageRow) => i.bolt);
    // pay has STATE_FORKED + BOLT_FAILED but no STATE_MERGED → instance failed.
    expect(slugs).toEqual(["auth", "cart", "pay"]);
    const pay = (stage.instances ?? []).find((i: StageRow) => i.bolt === "pay");
    expect(pay?.outcome).toBe("failed");
    // Any failed instance rolls the parent up to failed.
    expect(stage.outcome).toBe("failed");
  }, TEST_TIMEOUT);

  // ===========================================================================
  // Case 5 — Idempotent re-merge: second complete --merge errors at state-merge.
  // ===========================================================================
  test("5: idempotent re-merge — second complete --merge errors 'already merged' at state-merge", () => {
    const proj = makeProj();
    expect(wtCreate(proj, "solo").status).toBe(0);
    expect(boltStart(proj, "solo").status).toBe(0);
    expect(boltComplete(proj, "solo").status).toBe(0); // first merge succeeds

    const second = boltComplete(proj, "solo"); // second errors
    // STRONGER than the .sh's two independent greps: both the "already merged"
    // cause AND the state-merge-failed reason ride on the SAME failJson
    // envelope (fragment-merge never reached because state-merge is first in
    // the chain). Exit is non-zero (failJson → process.exit(1)).
    expect(second.out).toContain("already merged");
    expect(second.out).toContain("state-merge-failed");
    expect(second.status).not.toBe(0);
  }, TEST_TIMEOUT);

  // ===========================================================================
  // Case 6 — Audit-merge fails before fragment-merge (lock-acquire failure).
  // Plants the lock DIRECTORY whose path auditLockDir() computes, with retry
  // budget 1, so the first lock-needing tool (state-merge) fails. fragment-merge
  // sits after audit-merge, so it never runs and the fragment file survives.
  // ===========================================================================
  test("6: lock-acquire failure — complete --merge errors before fragment-merge; fragment file survives", () => {
    const proj = makeProj();
    expect(wtCreate(proj, "solo").status).toBe(0);
    expect(boltStart(proj, "solo").status).toBe(0);

    // Plant the exact lock-dir path aidlc-lib.ts auditLockDir() computes
    // (:512-515: md5(projectDir).slice(0,8) → `.aidlc-audit-<hash>.lock` under
    // TMPDIR). STRONGER than the .sh, which re-derived the hash with an inline
    // bun -e crypto snippet; here we call the real function so the test breaks
    // if the lock-path contract ever changes. The lock is a DIRECTORY
    // (mkdirSync atomicity).
    const lockDir = auditLockDir(proj);
    mkdirSync(lockDir, { recursive: true });

    let comp: Run;
    try {
      comp = boltComplete(proj, "solo", { AIDLC_AUDIT_LOCK_RETRIES: "1" });
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }

    // Failure surfaced before fragment-merge AND the worktree fragment is still
    // present (no fragment-merge ran — recovery is a simple retry).
    expect(comp.out).toMatch(
      /(state-merge-failed|audit-merge-failed|audit-emit-failed|Failed to acquire audit lock)/,
    );
    expect(existsSync(fragPath(proj, "solo"))).toBe(true);
  }, TEST_TIMEOUT);

  // ===========================================================================
  // Case 7 — Fragment-merge fails after audit-merge succeeds (soft-gap closure).
  // Replace the fragment path with a directory so fragment-merge's unlinkSync
  // fails (EISDIR) AFTER audit-merge has already landed AUDIT_MERGED.
  // Re-used by case 8 (the project is left in a known state).
  // ===========================================================================
  let softGapProj: string;
  let softGapFrag: string;

  test("7: soft-gap — fragment-merge fails after audit-merge => AUDIT_MERGED + BOLT_FAILED(fragment-merge-failed)", () => {
    softGapProj = makeProj();
    expect(wtCreate(softGapProj, "solo").status).toBe(0);
    expect(boltStart(softGapProj, "solo").status).toBe(0);

    softGapFrag = fragPath(softGapProj, "solo");
    // Save fragment content, then replace the path with a directory so
    // unlinkSync fails (chmod alone doesn't reliably block unlink on APFS).
    renameSync(softGapFrag, `${softGapFrag}.bak`);
    mkdirSync(softGapFrag);

    const comp = boltComplete(softGapProj, "solo");

    // Expected main-audit row sequence:
    //   BOLT_COMPLETED → STATE_MERGED → AUDIT_MERGED → BOLT_FAILED(fragment-merge-failed)
    expect(comp.out).toContain("fragment-merge-failed");
    expect(countEvent(softGapProj, "AUDIT_MERGED")).toBeGreaterThanOrEqual(1);
    // STRONGER than the .sh's grep -B5: assert the BOLT_FAILED block that
    // carries the fragment-merge-failed reason actually exists. Split into
    // per-block units and find the one mentioning the reason; confirm it is a
    // BOLT_FAILED row.
    const auditBody = readFileSync(join(softGapProj, "aidlc-docs", "audit.md"), "utf-8");
    const blocks = auditBody.split(/\n---\n/);
    const failBlock = blocks.find((b) => b.includes("fragment-merge-failed"));
    expect(failBlock).toBeDefined();
    expect(failBlock).toContain("**Event**: BOLT_FAILED");

    // Restore the fragment so case 8's compile + teardown work.
    rmSync(softGapFrag, { recursive: true, force: true });
    if (existsSync(`${softGapFrag}.bak`)) renameSync(`${softGapFrag}.bak`, softGapFrag);
  }, TEST_TIMEOUT);

  // ===========================================================================
  // Case 8 — Determinism: re-compile after the chaos is byte-equivalent.
  // ===========================================================================
  test("8: determinism (L11) — re-compile after BOLT_FAILED + recovery is byte-equivalent", () => {
    expect(softGapProj).toBeDefined(); // case 7 ran first within this describe
    // Simulate the defense-in-depth fragment cleanup (git worktree remove).
    if (softGapFrag && existsSync(softGapFrag)) rmSync(softGapFrag, { force: true });

    runtimeCompile(softGapProj);
    const graphPath = join(softGapProj, "aidlc-docs", "runtime-graph.json");
    const sha1 = createHash("sha256").update(readFileSync(graphPath)).digest("hex");
    runtimeCompile(softGapProj);
    const sha2 = createHash("sha256").update(readFileSync(graphPath)).digest("hex");
    expect(sha1.length).toBeGreaterThan(0);
    expect(sha1).toBe(sha2);
  }, TEST_TIMEOUT);
});
