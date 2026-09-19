// covers: subcommand:aidlc-bolt:start, subcommand:aidlc-bolt:complete, subcommand:aidlc-bolt:abort, subcommand:aidlc-worktree:restore, subcommand:aidlc-worktree:purge
//
// bun:test port of tests/integration/t78-bolt-worktree-lifecycle.sh (TAP plan 13),
// mechanism = cli. End-to-end per-Bolt worktree lifecycle: every .sh assertion
// is preserved at equal-or-stronger fidelity by SPAWNING the real CLI via
// node:child_process spawnSync(BUN, [BOLT, sub, ...args]) and asserting on the
// PROCESS boundary — exit code (res.status), the canonical multi-event audit.md
// sequence the chained tools write, the Bolt Refs field on main's aidlc-state.md,
// and worktree-directory teardown on disk.
//
// WHY cli (not none): the subject IS the cross-process lifecycle. aidlc-bolt
// start --worktree / complete --merge / abort --discard each fan out to sibling
// CLIs via spawnSync (aidlc-bolt.ts:89-116 spawnSibling): start delegates to
// aidlc-state.ts fork + aidlc-audit.ts audit-fork + aidlc-runtime.ts
// fragment-fork (aidlc-bolt.ts:222-284); complete delegates to state merge +
// audit-merge + fragment-merge (:371-435); abort --discard delegates to
// aidlc-worktree.ts discard BEFORE the audit emit (:516-547, the post-review
// discard-first ordering). The observables — Bolt Refs append/clear, the
// STATE_FORKED/AUDIT_FORKED/STATE_MERGED/AUDIT_MERGED rows emitted inside each
// sibling's withAuditLock, the WORKTREE_DISCARDED teardown — only exist after
// the real subprocess chain runs. An in-process twin would have to re-stage
// every sibling's side effects and would lose the spawnSibling seam + the
// process.exit failJson shell entirely. So all 13 assertions stay spawns.
//
// Source under test:
//   dist/claude/.claude/tools/aidlc-bolt.ts
//     :149 handleStart   — --worktree path: BOLT_STARTED, then state-fork
//                          (STATE_FORKED + Bolt Refs append on main),
//                          audit-fork (AUDIT_FORKED + worktree audit.md),
//                          fragment-fork (no audit event)
//     :307 handleComplete — --merge path: BOLT_COMPLETED, then state-merge
//                          (STATE_MERGED + Bolt Refs slug removal),
//                          audit-merge (AUDIT_MERGED), fragment-merge
//     :498 handleAbort    — BOLT_FAILED with Reason=aborted; --discard tears
//                          down the worktree via aidlc-worktree discard FIRST
//                          (so BOLT_FAILED only lands when discard succeeded)
//   dist/claude/.claude/tools/aidlc-worktree.ts :156 create / :455 discard
//   dist/claude/.claude/tools/aidlc-lib.ts :148 worktreePath ->
//                          <projectDir>/.aidlc/worktrees/bolt-<slug>
//
// Old TAP -> new test parity (1:1, every .sh assertion -> a named test()):
//   .sh T1  start --worktree exits 0                  -> "L1: start --worktree exits 0"
//   .sh T2  forked worktree state file exists         -> "L1: forked worktree state file exists"
//   .sh T3  forked worktree audit file exists         -> "L1: forked worktree audit file exists"
//   .sh T4  complete --merge exits 0                  -> "L1: complete --merge exits 0"
//   .sh T5  post-merge Bolt Refs no longer has foo    -> "L1: post-merge Bolt Refs cleared of slug"
//   .sh T6  canonical 6-event audit sequence in order -> "L1: canonical 6-event audit sequence in order"
//   .sh T7  abort --discard emits BOLT_FAILED         -> "L2: abort --discard emits BOLT_FAILED on successful discard"
//   .sh T8  abort sub-classifies Reason=aborted       -> "L2: abort BOLT_FAILED carries Reason=aborted"
//   .sh T9  abort w/o --discard preserves worktree dir -> "L3: abort without --discard preserves worktree directory"
//   .sh T10 worktree contents preserved               -> "L3: worktree contents preserved for inspection"
//   .sh T11 both slugs in Bolt Refs after parallel    -> "L4: both alpha+beta in Bolt Refs after parallel start"
//   .sh T12 post-merge Bolt Refs cleared of both      -> "L4: post-merge Bolt Refs cleared of both slugs"
//   .sh T13 abort --discard tears down worktree dir   -> "L5: abort --discard tears down worktree directory"
//
// STRONGER than the .sh where it costs nothing:
//   - T6 asserts the EXACT ordered 6-tuple (join("\n")) AND that BOLT_STARTED
//     precedes every fork row and BOLT_COMPLETED precedes every merge row,
//     not just an equality on the tail window.
//   - T2/T3 also assert the forked files live under the canonical
//     .aidlc/worktrees/bolt-<slug>/aidlc-docs/ path (worktreePath contract).
//   - T8 asserts Reason=aborted is block-scoped to the BOLT_FAILED row.
//
// FIXTURE DISCIPLINE (mirrors the .sh's setup_lifecycle_project per lifecycle:
// create_test_project + seed state-construction.md + seed audit-sample.md, then
// cleanup_test_project): each lifecycle gets a FRESH temp project. Lifecycles 2
// and 5 init a REAL git repo on `main` + one commit so aidlc-worktree create can
// `git worktree add` (assertNotSiblingWorktree + real git, aidlc-worktree.ts).
// NOTHING is written under tests/fixtures/**; all temp dirs cleaned in afterAll.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  DEFAULT_RECORD_DIR,
  DEFAULT_SPACE,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAuditFile,
  seedStateFile,
  seededAuditDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const WT_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");

const tempDirs: string[] = [];

afterAll(() => {
  for (const d of tempDirs) cleanupTestProject(d);
});

interface RunResult {
  status: number;
  out: string; // stdout+stderr combined, mirroring the .sh's `2>&1`
}

/** Spawn `bun aidlc-bolt.ts <args...> --project-dir <proj>`. Mirrors `bun "$TOOL" ... --project-dir "$PROJ"`. */
function runBolt(proj: string, ...args: string[]): RunResult {
  const res = spawnSync(BUN, [BOLT, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Spawn `bun aidlc-worktree.ts <args...> --project-dir <proj>` (the .sh's WT_TOOL). */
function runWorktree(proj: string, ...args: string[]): RunResult {
  const res = spawnSync(BUN, [WT_TOOL, ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

/** Run a git command in proj; ignore failure (the .sh wraps init in `|| true`). */
function git(proj: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", proj, ...args], { encoding: "utf-8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** setup_lifecycle_project (.sh:35-41): create + seed Construction state + seed audit. */
function setupLifecycleProject(): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
  seedAuditFile(proj);
  return proj;
}

/** Init a real git repo on `main` with one (empty) commit (the .sh's git init prelude). */
function gitInitMain(proj: string): void {
  git(proj, "init", "-q", "-b", "main");
  git(proj, "config", "user.email", "t@t");
  git(proj, "config", "user.name", "t");
  git(proj, "add", "-A");
  git(proj, "commit", "-q", "-m", "init", "--allow-empty");
}

/** worktreePath contract: <proj>/.aidlc/worktrees/bolt-<slug>. */
function worktreeDir(proj: string, slug: string): string {
  return join(proj, ".aidlc", "worktrees", `bolt-${slug}`);
}

/** The worktree mirror's per-intent record dir — carries the SAME relative
 *  record dir as the main checkout (aidlc/spaces/default/intents/<record>/). */
function wtRecordDir(proj: string, slug: string): string {
  return join(
    worktreeDir(proj, slug),
    "aidlc",
    "spaces",
    DEFAULT_SPACE,
    "intents",
    DEFAULT_RECORD_DIR,
  );
}

/** Merge every main audit shard (audit/*.md) by **Timestamp** into one ordered
 *  buffer — the tools write their own per-clone shard alongside seedAuditFile's
 *  fixture.md, and production readers sort the parsed blocks by timestamp (not by
 *  filename), so this mirrors that to keep the canonical-sequence assertions
 *  host-independent (the tool shard's filename can sort before OR after fixture.md). */
function readMainAudit(proj: string): string {
  const dir = seededAuditDir(proj);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return "";
  }
  // Split each shard into `\n---\n`-separated blocks, tag each with its
  // **Timestamp**, then stable-sort across all shards by timestamp.
  const blocks: { ts: string; text: string }[] = [];
  for (const n of names) {
    const body = readFileSync(join(dir, n), "utf-8");
    for (const raw of body.split("\n---\n")) {
      if (!raw.includes("**Event**:")) continue;
      const tsLine = raw.split("\n").find((l) => l.startsWith("**Timestamp**:")) ?? "";
      const ts = tsLine.replace("**Timestamp**:", "").trim();
      blocks.push({ ts, text: raw });
    }
  }
  blocks.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return blocks.map((b) => b.text).join("\n---\n");
}

/** The single `Bolt Refs` line from main's state (the .sh's `grep "Bolt Refs" | head -1`). */
function boltRefsLine(proj: string): string {
  const state = readFileSync(seededStateFile(proj), "utf-8");
  return state.split("\n").find((l) => l.includes("Bolt Refs")) ?? "";
}

/** The ordered list of `**Event**: <TYPE>` event types in main's audit shards. */
function auditEvents(proj: string): string[] {
  return readMainAudit(proj)
    .split("\n")
    .filter((l) => l.startsWith("**Event**:"))
    .map((l) => l.replace("**Event**:", "").trim());
}

/** The lines of the LAST `**Event**: <type>` block in main audit (for block-scoped field checks). */
function lastEventBlock(proj: string): string[] {
  const audit = readMainAudit(proj);
  const lines = audit.split("\n");
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("**Event**:")) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && lines[i].startsWith("**Event**:")) break;
    out.push(lines[i]);
  }
  return out;
}

function eventBlock(proj: string, type: string): string {
  return readMainAudit(proj)
    .split("\n---\n")
    .filter((block) => block.includes(`**Event**: ${type}`))
    .at(-1) ?? "";
}

describe("t78 aidlc-bolt per-Bolt worktree lifecycle (migrated from t78-bolt-worktree-lifecycle.sh, plan 13)", () => {
  describe("Base-commit attestation", () => {
    const proj = setupLifecycleProject();
    gitInitMain(proj);
    const beforeWorktrees = git(proj, "worktree", "list", "--porcelain").stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree ")).length;
    const created = runWorktree(proj, "create", "--slug", "attested", "--base", "main");
    const afterWorktrees = git(proj, "worktree", "list", "--porcelain").stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree ")).length;
    if (created.status !== 0) {
      throw new Error(`worktree create failed: ${created.out}`);
    }
    const baseCommit = (JSON.parse(created.out.trim()) as { base_commit: string }).base_commit;
    const started = runBolt(
      proj,
      "start",
      "--name",
      "Attested Bolt",
      "--batch",
      "1",
      "--worktree",
      "--slug",
      "attested",
    );

    test("WORKTREE_CREATED and BOLT_STARTED carry the same immutable Base commit and raw listing", () => {
      expect(created.status).toBe(0);
      expect(afterWorktrees).toBe(beforeWorktrees + 1);
      expect(started.status).toBe(0);
      expect(eventBlock(proj, "WORKTREE_CREATED")).toContain(`**Base commit**: ${baseCommit}`);
      expect(eventBlock(proj, "BOLT_STARTED")).toContain(`**Base commit**: ${baseCommit}`);
      const meta = readFileSync(join(worktreeDir(proj, "attested"), ".aidlc", "worktree-meta.json"), "utf-8");
      expect(meta).toContain(`"baseCommit": "${baseCommit}"`);
      const baseListing = /"baseSourceListing": "(sha256:[0-9a-f]{64})"/.exec(meta)?.[1];
      expect(baseListing).toBeDefined();
      expect(eventBlock(proj, "WORKTREE_CREATED")).toContain(`**Base Source Listing**: ${baseListing}`);
      expect(eventBlock(proj, "BOLT_STARTED")).toContain(`**Base Source Listing**: ${baseListing}`);
      expect(existsSync(join(worktreeDir(proj, "attested"), ".aidlc", "base-source-listing.tsv"))).toBe(true);
    });

    test("missing metadata after a modern create fails closed before BOLT_STARTED", () => {
      const missingProj = setupLifecycleProject();
      gitInitMain(missingProj);
      expect(runWorktree(missingProj, "create", "--slug", "missing", "--base", "main").status).toBe(0);
      rmSync(join(worktreeDir(missingProj, "missing"), ".aidlc", "worktree-meta.json"));
      const missingStart = runBolt(
        missingProj, "start", "--name", "Missing", "--batch", "1", "--worktree", "--slug", "missing",
      );
      expect(missingStart.status).not.toBe(0);
      expect(missingStart.out).toContain("modern WORKTREE_CREATED");
      expect(eventBlock(missingProj, "BOLT_STARTED")).toBe("");
    });

    test("malformed present metadata fails closed before BOLT_STARTED", () => {
      const corruptProj = setupLifecycleProject();
      gitInitMain(corruptProj);
      const corruptCreated = runWorktree(
        corruptProj,
        "create",
        "--slug",
        "corrupt",
        "--base",
        "main",
      );
      expect(corruptCreated.status).toBe(0);
      writeFileSync(
        join(worktreeDir(corruptProj, "corrupt"), ".aidlc", "worktree-meta.json"),
        '{"version":1,"boltSlug":"wrong","baseBranch":"main","baseCommit":"bad","baseSourceListing":"bad"}\n',
      );
      const corruptStart = runBolt(
        corruptProj,
        "start",
        "--name",
        "Corrupt Bolt",
        "--batch",
        "1",
        "--worktree",
        "--slug",
        "corrupt",
      );
      expect(corruptStart.status).not.toBe(0);
      expect(corruptStart.out).toContain("invalid worktree metadata");
      expect(eventBlock(corruptProj, "BOLT_STARTED")).toBe("");
    });
  });

  // ===========================================================================
  // Lifecycle 1 — complete-merge happy path. Drives T1-T6.
  // Pre-create the worktree dir (in production aidlc-worktree create does this;
  // here we satisfy the audit-fork "directory exists" check, .sh:45-50).
  // ===========================================================================
  describe("Lifecycle 1: start --worktree -> complete --merge round-trip", () => {
    const proj = setupLifecycleProject();
    const slug = "foo";
    const wt = worktreeDir(proj, slug);
    mkdirSync(wt, { recursive: true });

    const startRes = runBolt(
      proj, "start", "--name", "Foo Bolt", "--batch", "1", "--worktree", "--slug", slug,
    );

    test("L1: start --worktree exits 0 [.sh T1]", () => {
      expect(startRes.status).toBe(0);
    });

    test("L1: forked worktree state file exists [.sh T2]", () => {
      // STRONGER: the forked state file lands under the canonical worktree mirror
      // record (aidlc/spaces/default/intents/<record>/) — the worktreePath contract.
      expect(existsSync(join(wtRecordDir(proj, slug), "aidlc-state.md"))).toBe(true);
    });

    test("L1: forked Worktree Path is written project-relative, never an absolute machine path [#937]", () => {
      // Regression for #937: aidlc-state.ts:6616 writes `Worktree Path` as
      // relative(projectDir, worktreePath) (forward-slashed) so a committed state
      // file carries no host-specific absolute path. The .sh + T2 only proved the
      // forked file EXISTS; this pins its VALUE.
      const wtState = readFileSync(join(wtRecordDir(proj, slug), "aidlc-state.md"), "utf-8");
      const line = wtState.split("\n").find((l) => l.startsWith("- **Worktree Path**:")) ?? "";
      const value = line.replace("- **Worktree Path**:", "").trim();
      expect(value).toBe(`.aidlc/worktrees/bolt-${slug}`);
      // the absolute project path must never leak into committed state
      expect(value.startsWith("/")).toBe(false);
      expect(value.includes(proj)).toBe(false);
    });

    test("L1: forked worktree audit file exists [.sh T3]", () => {
      // Audit is now a per-clone shard DIR; audit-fork copies the main shard into
      // <wt>/<record>/audit/, so at least one *.md shard exists there.
      const wtAuditDir = join(wtRecordDir(proj, slug), "audit");
      const shards = existsSync(wtAuditDir)
        ? readdirSync(wtAuditDir).filter((f) => f.endsWith(".md"))
        : [];
      expect(shards.length).toBeGreaterThan(0);
    });

    // Simulate per-Unit work in the worktree by marking a Construction stage
    // [ ] -> [x] in the worktree state (the .sh's sed_i). Per-field merge then
    // propagates back on complete --merge.
    test("L1: simulate per-Unit work in the worktree (checkbox flip)", () => {
      const wtState = join(wtRecordDir(proj, slug), "aidlc-state.md");
      const body = readFileSync(wtState, "utf-8");
      const flipped = body.replace(
        "- [ ] code-generation — EXECUTE",
        "- [x] code-generation — EXECUTE",
      );
      writeFileSync(wtState, flipped);
      expect(flipped).toContain("- [x] code-generation — EXECUTE");
    });

    const completeRes = runBolt(
      proj, "complete", "--name", "Foo Bolt", "--batch", "1", "--merge", "--slug", slug,
    );

    test("L1: complete --merge exits 0 [.sh T4]", () => {
      expect(completeRes.status).toBe(0);
    });

    test("L1: post-merge Bolt Refs cleared of slug [.sh T5]", () => {
      expect(boltRefsLine(proj)).not.toContain(slug);
    });

    test("L1: canonical 6-event audit sequence in order [.sh T6]", () => {
      const last6 = auditEvents(proj).slice(-6);
      expect(last6).toEqual([
        "BOLT_STARTED",
        "STATE_FORKED",
        "AUDIT_FORKED",
        "BOLT_COMPLETED",
        "STATE_MERGED",
        "AUDIT_MERGED",
      ]);
      // STRONGER: ordering invariants — start precedes every fork row,
      // complete precedes every merge row.
      const idx = (e: string): number => last6.indexOf(e);
      expect(idx("BOLT_STARTED")).toBeLessThan(idx("STATE_FORKED"));
      expect(idx("BOLT_STARTED")).toBeLessThan(idx("AUDIT_FORKED"));
      expect(idx("BOLT_COMPLETED")).toBeLessThan(idx("STATE_MERGED"));
      expect(idx("BOLT_COMPLETED")).toBeLessThan(idx("AUDIT_MERGED"));
    });
  });

  // ===========================================================================
  // Lifecycle 2 — abort --discard with a successful discard emits BOLT_FAILED.
  // Post-fix ordering: discard FIRST, audit AFTER. So BOLT_FAILED only lands
  // when discard succeeded. Set up a real git worktree so discard can run.
  // Drives T7-T8 (the failure event must ACTUALLY fire — §6-E).
  // ===========================================================================
  describe("Lifecycle 2: abort --discard fires BOLT_FAILED on successful discard", () => {
    const proj = setupLifecycleProject();
    gitInitMain(proj);
    runWorktree(proj, "create", "--slug", "bar", "--base", "main");

    const abortRes = runBolt(
      proj, "abort", "--name", "Bar Bolt", "--slug", "bar", "--reason", "test abort", "--discard",
    );

    test("L2: abort --discard exits 0 (discard succeeded)", () => {
      // Not a .sh assertion (the .sh wrapped abort in set +e), but proves the
      // discard-first path actually ran rather than failJson-ing — without
      // this the BOLT_FAILED below would be a happy-path-only pass.
      expect(abortRes.status).toBe(0);
    });

    test("L2: abort --discard emits BOLT_FAILED on successful discard [.sh T7]", () => {
      // The failure event must ACTUALLY fire (§6-E): BOLT_FAILED only appears
      // because the aidlc-worktree discard subprocess returned 0 first.
      expect(auditEvents(proj)).toContain("BOLT_FAILED");
    });

    test("L2: abort BOLT_FAILED carries Reason=aborted [.sh T8]", () => {
      // STRONGER: Reason=aborted is block-scoped to the BOLT_FAILED row, not a
      // file-wide grep — sub-classifier vs the plain `fail` verb.
      const block = lastEventBlock(proj);
      expect(block[0]).toContain("BOLT_FAILED");
      expect(block.some((l) => l.trim() === "**Reason**: aborted")).toBe(true);
    });
  });

  // ===========================================================================
  // Lifecycle 3 — abort WITHOUT --discard preserves the worktree (US-1 AC :51).
  // Drives T9-T10.
  // ===========================================================================
  describe("Lifecycle 3: abort without --discard preserves the worktree", () => {
    const proj = setupLifecycleProject();
    const slug = "baz";
    const wt = worktreeDir(proj, slug);
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, "marker.txt"), "synthetic worktree content");

    const abortRes = runBolt(
      proj, "abort", "--name", "Baz Bolt", "--slug", slug, "--reason", "preserve check",
    );

    test("L3: abort without --discard preserves worktree directory [.sh T9]", () => {
      expect(abortRes.status).toBe(0);
      expect(JSON.parse(abortRes.out).parked_ref).toBeNull();
      expect(existsSync(wt)).toBe(true);
    });

    test("L3: worktree contents preserved for inspection [.sh T10]", () => {
      // The marker file survives — worktree contents are not touched.
      expect(existsSync(join(wt, "marker.txt"))).toBe(true);
      expect(readFileSync(join(wt, "marker.txt"), "utf-8")).toBe(
        "synthetic worktree content",
      );
    });
  });

  // ===========================================================================
  // Lifecycle 4 — two parallel-batch Bolts (separate slugs) round-trip cleanly
  // without interfering with each other's state. Drives T11-T12.
  // ===========================================================================
  describe("Lifecycle 4: two parallel Bolts round-trip without interference", () => {
    const proj = setupLifecycleProject();
    mkdirSync(worktreeDir(proj, "alpha"), { recursive: true });
    mkdirSync(worktreeDir(proj, "beta"), { recursive: true });

    runBolt(proj, "start", "--name", "Alpha", "--batch", "1", "--worktree", "--slug", "alpha");
    runBolt(proj, "start", "--name", "Beta", "--batch", "1", "--worktree", "--slug", "beta");

    test("L4: both alpha+beta in Bolt Refs after parallel start --worktree [.sh T11]", () => {
      const line = boltRefsLine(proj);
      expect(line).toContain("alpha");
      expect(line).toContain("beta");
    });

    test("L4: post-merge Bolt Refs cleared of both slugs [.sh T12]", () => {
      runBolt(proj, "complete", "--name", "Alpha", "--batch", "1", "--merge", "--slug", "alpha");
      runBolt(proj, "complete", "--name", "Beta", "--batch", "1", "--merge", "--slug", "beta");
      const line = boltRefsLine(proj);
      expect(line).not.toContain("alpha");
      expect(line).not.toContain("beta");
    });
  });

  // ===========================================================================
  // Lifecycle 5 — abort --discard VERIFICATION (review fold-in): when discard
  // succeeds, the worktree directory is actually torn down. Real git so
  // aidlc-worktree create can fork; do NOT pre-create the dir (create handles
  // mkdir + git worktree add atomically). Drives T13.
  // ===========================================================================
  describe("Lifecycle 5: abort --discard tears down the worktree directory", () => {
    const proj = setupLifecycleProject();
    gitInitMain(proj);
    runWorktree(proj, "create", "--slug", "tearcheck", "--base", "main");
    const wt = worktreeDir(proj, "tearcheck");

    test("L5 setup: aidlc-worktree create produced the worktree dir", () => {
      expect(existsSync(wt)).toBe(true);
    });

    test("L5: abort --discard tears down worktree directory [.sh T13]", () => {
      runBolt(
        proj, "abort", "--name", "Tearcheck", "--slug", "tearcheck",
        "--reason", "discard test", "--discard",
      );
      expect(existsSync(wt)).toBe(false);
    });
  });

  describe("Recoverable discard", () => {
    test("abort parks source and review evidence; restore and purge never touch a recreated live Bolt", () => {
      const proj = setupLifecycleProject();
      const slug = "recoverable";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, ".gitignore"), "ignored.bin\n");
      writeFileSync(join(proj, "tracked.bin"), Buffer.from([0, 1, 2]));
      writeFileSync(join(proj, "deleted.txt"), "remove during the Bolt\n");
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      writeFileSync(join(wt, "committed.txt"), "unmerged Bolt commit\n");
      expect(git(wt, "add", "committed.txt").status).toBe(0);
      expect(git(wt, "commit", "-q", "-m", "unmerged Bolt work").status).toBe(0);
      const unmergedCommit = git(wt, "rev-parse", "HEAD").stdout.trim();
      expect(git(proj, "merge-base", "--is-ancestor", unmergedCommit, "main").status).toBe(1);
      writeFileSync(join(wt, "tracked.bin"), Buffer.from([0, 3, 4]));
      expect(git(wt, "add", "tracked.bin").status).toBe(0);
      const dirtyBytes = Buffer.from([0, 255, 2, 13, 10, 128]);
      const untrackedBytes = Buffer.from([255, 0, 10, 13, 127, 128]);
      writeFileSync(join(wt, "tracked.bin"), dirtyBytes);
      writeFileSync(join(wt, "untracked.bin"), untrackedBytes);
      writeFileSync(join(wt, "ignored.bin"), "not part of the recovery snapshot");
      rmSync(join(wt, "deleted.txt"));
      const reviewedRef = `refs/aidlc/reviewed-source/${slug}/${unmergedCommit}`;
      expect(git(proj, "update-ref", reviewedRef, unmergedCommit).status).toBe(0);

      const aborted = runBolt(
        proj, "abort", "--name", "Recoverable Bolt", "--slug", slug,
        "--reason", "restart after review", "--discard",
      );
      expect(aborted.status).toBe(0);
      const { parked_ref: parkedRef } = JSON.parse(aborted.out) as { parked_ref: string };
      expect(parkedRef).toMatch(/^refs\/aidlc\/parked\/recoverable\/\d{8}T\d{6}Z(?:-[1-9]\d*)?$/);
      const stamp = parkedRef.split("/").at(-1)!;
      const parkedHead = git(proj, "rev-parse", "--verify", `${parkedRef}/head`);
      expect(parkedHead.status).toBe(0);
      const parkedCommit = parkedHead.stdout.trim();
      const parkedReviewedRef = `${parkedRef}/reviewed-source/${unmergedCommit}`;
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toContain(`**Parked ref**: ${parkedRef}`);
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toContain(`**Parked commit**: ${parkedCommit}`);
      expect(git(proj, "rev-parse", "--verify", parkedReviewedRef).stdout.trim()).toBe(unmergedCommit);
      expect(git(proj, "show-ref", "--verify", "--quiet", reviewedRef).status).toBe(1);
      expect(git(proj, "show-ref", "--verify", "--quiet", `refs/heads/bolt-${slug}`).status).toBe(1);
      expect(existsSync(wt)).toBe(false);

      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      writeFileSync(join(wt, "tracked.bin"), "new live attempt\n");
      writeFileSync(join(wt, "live-only.txt"), "leave this live checkout alone\n");
      const liveHead = git(wt, "rev-parse", "HEAD").stdout.trim();
      const liveStatus = git(wt, "status", "--porcelain").stdout;
      const auditBeforeRecovery = auditEvents(proj);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status).toBe(0);
      const restoredPath = join(proj, ".aidlc", "restored", `bolt-${slug}-${stamp}`);
      const restoredBranch = `restore/bolt-${slug}-${stamp}`;
      expect(JSON.parse(restored.out)).toEqual({
        restored: true,
        slug,
        parked_ref: parkedRef,
        worktree_path: restoredPath,
        branch: restoredBranch,
        reviewed_source_refs: 1,
        materialized: expect.any(Number),
        raw_bytes: true,
        restore_mode: "snapshot",
      });
      expect(auditEvents(proj)).toEqual(auditBeforeRecovery);
      expect(readFileSync(join(restoredPath, "committed.txt"), "utf-8")).toBe("unmerged Bolt commit\n");
      expect(readFileSync(join(restoredPath, "tracked.bin"))).toEqual(dirtyBytes);
      expect(readFileSync(join(restoredPath, "untracked.bin"))).toEqual(untrackedBytes);
      expect(existsSync(join(restoredPath, "deleted.txt"))).toBe(false);
      expect(existsSync(join(restoredPath, "ignored.bin"))).toBe(false);
      expect(git(restoredPath, "rev-parse", "HEAD").stdout.trim()).toBe(parkedCommit);
      expect(git(restoredPath, "merge-base", "--is-ancestor", unmergedCommit, "HEAD").status).toBe(0);
      expect(git(restoredPath, "symbolic-ref", "--short", "HEAD").stdout.trim()).toBe(restoredBranch);
      expect(git(proj, "show-ref", "--verify", "--quiet", reviewedRef).status).toBe(1);

      const listed = runWorktree(proj, "list");
      expect(listed.status).toBe(0);
      expect(JSON.parse(listed.out).worktrees).toEqual([
        { slug, worktree_path: wt, branch: `bolt-${slug}` },
      ]);
      const repeatedRestore = runWorktree(proj, "restore", "--slug", slug, "--parked", stamp);
      expect(repeatedRestore.status).not.toBe(0);
      expect(repeatedRestore.out).toContain(`already restored at ${restoredPath}`);
      expect(readFileSync(join(restoredPath, "untracked.bin"))).toEqual(untrackedBytes);
      const refusedPurge = runWorktree(proj, "purge", "--slug", slug);
      expect(refusedPurge.status).not.toBe(0);
      expect(refusedPurge.out).toContain(`restore checkout still present at ${restoredPath}`);
      expect(git(proj, "rev-parse", "--verify", `${parkedRef}/head`).stdout.trim()).toBe(parkedCommit);
      expect(git(proj, "rev-parse", "--verify", parkedReviewedRef).stdout.trim()).toBe(unmergedCommit);
      expect(existsSync(restoredPath)).toBe(true);

      expect(git(proj, "worktree", "remove", "--force", restoredPath).status).toBe(0);
      const purged = runWorktree(proj, "purge", "--slug", slug);
      expect(purged.status).toBe(0);
      expect(JSON.parse(purged.out)).toEqual({ purged: 3, slug, stamps: [stamp] });
      expect(git(proj, "for-each-ref", "--format=%(refname)", `refs/aidlc/parked/${slug}/`).stdout).toBe("");
      const noAttempt = runWorktree(proj, "restore", "--slug", slug);
      expect(noAttempt.status).not.toBe(0);
      expect(noAttempt.out).toContain("no parked attempt");
      expect(auditEvents(proj).filter((event) => event !== "ERROR_LOGGED")).toEqual(auditBeforeRecovery);
      expect(git(wt, "rev-parse", "HEAD").stdout.trim()).toBe(liveHead);
      expect(git(wt, "symbolic-ref", "--short", "HEAD").stdout.trim()).toBe(`bolt-${slug}`);
      expect(git(wt, "status", "--porcelain").stdout).toBe(liveStatus);
      expect(readFileSync(join(wt, "tracked.bin"), "utf-8")).toBe("new live attempt\n");
      expect(readFileSync(join(wt, "live-only.txt"), "utf-8")).toBe("leave this live checkout alone\n");
      expect(existsSync(join(wt, "committed.txt"))).toBe(false);
      expect(existsSync(join(wt, "untracked.bin"))).toBe(false);
    }, 30_000);

    test.skipIf(process.platform === "win32")("discard parks and restores raw filtered bytes without changing ordinary dirty files", () => {
      const proj = setupLifecycleProject();
      const slug = "raw-filtered";
      const wt = worktreeDir(proj, slug);
      gitInitMain(proj);
      expect(git(proj, "config", "filter.lossy.clean", "tr a-z A-Z").status).toBe(0);
      writeFileSync(join(proj, ".gitattributes"), "*.lossy filter=lossy\n");
      writeFileSync(join(proj, "notes.lossy"), "original filtered notes\n");
      writeFileSync(join(proj, "plain.txt"), "original ordinary notes\n");
      expect(git(proj, "add", ".gitattributes", "notes.lossy", "plain.txt").status).toBe(0);
      expect(git(proj, "commit", "-q", "-m", "seed clean-filtered source").status).toBe(0);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const trackedBytes = "dirty lowercase tracked notes\n";
      const untrackedBytes = "untracked lowercase scratch\n";
      const plainBytes = "ordinary dirty lowercase bytes\n";
      writeFileSync(join(wt, "notes.lossy"), trackedBytes);
      writeFileSync(join(wt, "scratch.lossy"), untrackedBytes);
      writeFileSync(join(wt, "plain.txt"), plainBytes);

      const aborted = runBolt(
        proj, "abort", "--name", "Raw Filtered Bolt", "--slug", slug,
        "--reason", "keep the exact dirty bytes", "--discard",
      );
      expect(aborted.status).toBe(0);
      const { parked_ref: parkedRef } = JSON.parse(aborted.out) as { parked_ref: string };
      expect(existsSync(wt)).toBe(false);
      expect(git(proj, "cat-file", "-p", `${parkedRef}/head:notes.lossy`).stdout).toBe(trackedBytes);
      expect(git(proj, "cat-file", "-p", `${parkedRef}/head:scratch.lossy`).stdout).toBe(untrackedBytes);
      expect(git(proj, "cat-file", "-p", `${parkedRef}/head:plain.txt`).stdout).toBe(plainBytes);

      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status).toBe(0);
      const { worktree_path: restoredPath } = JSON.parse(restored.out) as { worktree_path: string };
      expect(JSON.parse(restored.out).raw_bytes).toBe(true);
      expect(JSON.parse(restored.out).restore_mode).toBe("snapshot");
      expect(readFileSync(join(restoredPath, "notes.lossy"), "utf-8")).toBe(trackedBytes);
      expect(readFileSync(join(restoredPath, "scratch.lossy"), "utf-8")).toBe(untrackedBytes);
      expect(readFileSync(join(restoredPath, "plain.txt"), "utf-8")).toBe(plainBytes);
    });

    test.skipIf(process.platform === "win32")("restore bypasses transforming smudge filters for lowercase and binary blobs", async () => {
      const proj = setupLifecycleProject();
      const slug = "transforming-smudge";
      const wt = worktreeDir(proj, slug);
      gitInitMain(proj);
      expect(git(proj, "config", "filter.lossy.clean", "cat").status).toBe(0);
      expect(git(proj, "config", "filter.lossy.smudge", "tr a-z A-Z").status).toBe(0);
      writeFileSync(join(proj, ".gitattributes"), "*.lossy filter=lossy\n");
      writeFileSync(join(proj, "notes.lossy"), "original lowercase notes\n");
      expect(git(proj, "add", ".gitattributes", "notes.lossy").status).toBe(0);
      expect(git(proj, "commit", "-q", "-m", "seed smudge-filtered source").status).toBe(0);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const trackedBytes = "dirty lowercase tracked notes\n";
      const untrackedBytes = "untracked lowercase scratch\n";
      const binaryBytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      writeFileSync(join(wt, "notes.lossy"), trackedBytes);
      writeFileSync(join(wt, "scratch.lossy"), untrackedBytes);
      writeFileSync(join(wt, "binary.lossy"), binaryBytes);
      const largeFile = "large.bin";
      const chunk = Buffer.alloc(1024 * 1024);
      let seed = 0x12345678;
      const fd = openSync(join(wt, largeFile), "wx");
      try {
        for (let block = 0; block < 24; block++) {
          for (let i = 0; i < chunk.length; i++) {
            seed ^= seed << 13;
            seed ^= seed >>> 17;
            seed ^= seed << 5;
            chunk[i] = seed & 0xff;
          }
          writeFileSync(fd, chunk);
        }
      } finally {
        closeSync(fd);
      }
      const sha256 = async (path: string): Promise<string> => {
        const hash = createHash("sha256");
        for await (const bytes of createReadStream(path)) hash.update(bytes);
        return hash.digest("hex");
      };
      const largeSha256 = await sha256(join(wt, largeFile));

      const aborted = runBolt(
        proj, "abort", "--name", "Transforming Smudge Bolt", "--slug", slug,
        "--reason", "restore without reapplying smudge", "--discard",
      );
      expect(aborted.status).toBe(0);
      const { parked_ref: parkedRef } = JSON.parse(aborted.out) as { parked_ref: string };
      const parkedFiles = git(proj, "ls-tree", "-r", "--name-only", "-z", `${parkedRef}/head`);
      expect(parkedFiles.status).toBe(0);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out) as {
        worktree_path: string; materialized: number; raw_bytes: boolean;
      };
      expect(readFileSync(join(recovery.worktree_path, "notes.lossy"), "utf-8")).toBe(trackedBytes);
      expect(readFileSync(join(recovery.worktree_path, "scratch.lossy"), "utf-8")).toBe(untrackedBytes);
      expect(readFileSync(join(recovery.worktree_path, "binary.lossy"))).toEqual(binaryBytes);
      expect(await sha256(join(recovery.worktree_path, largeFile))).toBe(largeSha256);
      expect(recovery.materialized).toBe(parkedFiles.stdout.split("\0").filter(Boolean).length);
      expect(recovery.raw_bytes).toBe(true);
    }, 30_000);

    test("restore succeeds despite a required failing smudge filter", () => {
      const proj = setupLifecycleProject();
      const slug = "required-smudge";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, ".gitattributes"), "*.broken filter=broken\n");
      writeFileSync(join(proj, "notes.broken"), "original notes\n");
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const dirtyBytes = "dirty bytes survive a required smudge failure\n";
      writeFileSync(join(wt, "notes.broken"), dirtyBytes);
      expect(git(proj, "config", "filter.broken.clean", "cat").status).toBe(0);
      expect(git(proj, "config", "filter.broken.smudge", "false").status).toBe(0);
      expect(git(proj, "config", "filter.broken.required", "true").status).toBe(0);

      const aborted = runBolt(
        proj, "abort", "--name", "Required Smudge Bolt", "--slug", slug,
        "--reason", "recover without invoking the broken filter", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const { parked_ref: parkedRef } = JSON.parse(aborted.out) as { parked_ref: string };
      const ordinaryPath = join(proj, ".aidlc", "ordinary-restore");
      try {
        const ordinary = git(proj, "worktree", "add", "--detach", ordinaryPath, `${parkedRef}/head`);
        expect(ordinary.status).not.toBe(0);
        expect(ordinary.stderr).toContain("smudge filter broken failed");
      } finally {
        git(proj, "worktree", "remove", "--force", ordinaryPath);
      }
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const { worktree_path: restoredPath } = JSON.parse(restored.out) as { worktree_path: string };
      expect(JSON.parse(restored.out).raw_bytes).toBe(true);
      expect(readFileSync(join(restoredPath, "notes.broken"), "utf-8")).toBe(dirtyBytes);
    });

    for (const [name, smudge] of [["transforming", "tr a-z A-Z"], ["required failing", "false"]] as const) {
      test.skipIf(process.platform === "win32")(`legacy unmarked snapshot restore bypasses ${name} smudge filters by default`, () => {
        const proj = setupLifecycleProject();
        const slug = "legacy-smudge";
        const wt = worktreeDir(proj, slug);
        writeFileSync(join(proj, ".gitattributes"), "*.lossy filter=lossy\n");
        writeFileSync(join(proj, "notes.lossy"), "original lowercase notes\n");
        gitInitMain(proj);
        expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
        const dirtyBytes = "legacy dirty lowercase notes\n";
        writeFileSync(join(wt, "notes.lossy"), dirtyBytes);
        expect(git(proj, "config", "filter.lossy.clean", "cat").status).toBe(0);
        expect(git(proj, "config", "filter.lossy.smudge", smudge).status).toBe(0);
        expect(git(proj, "config", "filter.lossy.required", "true").status).toBe(0);
        const discarded = runWorktree(proj, "discard", "--slug", slug);
        expect(discarded.status, discarded.out).toBe(0);
        const { parked_ref: parkedRef } = JSON.parse(discarded.out) as { parked_ref: string };
        // Legacy parks predate discriminator refs; retain only the raw snapshot head.
        expect(git(proj, "update-ref", "-d", `${parkedRef}/snapshot`).status).toBe(0);
        expect(git(proj, "for-each-ref", "--format=%(refname)", `${parkedRef}/`).stdout.trim()).toBe(`${parkedRef}/head`);

        const restored = runWorktree(proj, "restore", "--slug", slug);
        expect(restored.status, restored.out).toBe(0);
        const recovery = JSON.parse(restored.out) as { worktree_path: string; raw_bytes: boolean; restore_mode: string };
        expect(readFileSync(join(recovery.worktree_path, "notes.lossy"), "utf-8")).toBe(dirtyBytes);
        expect(recovery.raw_bytes).toBe(true);
        expect(recovery.restore_mode).toBe("legacy-snapshot");
      });
    }

    test.skipIf(process.platform === "win32")("discard and restore preserve working-tree-encoding bytes for tracked and untracked files", () => {
      const proj = setupLifecycleProject();
      const slug = "working-tree-encoding";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, ".gitattributes"), "*.ps1 working-tree-encoding=UTF-16LE\n");
      writeFileSync(join(proj, "script.ps1"), Buffer.from("Write-Output 'original'\n", "utf16le"));
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const trackedBytes = Buffer.from("Write-Output 'modified café'\n", "utf16le");
      const untrackedBytes = Buffer.from("Write-Output 'new résumé'\n", "utf16le");
      writeFileSync(join(wt, "script.ps1"), trackedBytes);
      writeFileSync(join(wt, "new.ps1"), untrackedBytes);

      const aborted = runBolt(
        proj, "abort", "--name", "Working Tree Encoding Bolt", "--slug", slug,
        "--reason", "retain UTF-16LE bytes", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const { parked_ref: parkedRef } = JSON.parse(aborted.out) as { parked_ref: string };
      const parked = spawnSync("git", ["cat-file", "blob", `${parkedRef}/head:script.ps1`], { cwd: proj });
      expect(parked.status).toBe(0);
      expect(parked.stdout).toEqual(trackedBytes);

      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out) as { worktree_path: string; raw_bytes: boolean };
      expect(recovery.raw_bytes).toBe(true);
      expect(readFileSync(join(recovery.worktree_path, "script.ps1"))).toEqual(trackedBytes);
      expect(readFileSync(join(recovery.worktree_path, "new.ps1"))).toEqual(untrackedBytes);
    });

    test.skipIf(process.platform === "win32")("discard refuses a filtered non-UTF-8 filename before removing the live attempt", () => {
      const proj = setupLifecycleProject();
      const slug = "non-utf8-filtered";
      const wt = worktreeDir(proj, slug);
      const name = Buffer.concat([Buffer.from("notes-"), Buffer.from([0xff]), Buffer.from(".lossy")]);
      gitInitMain(proj);
      const created = runWorktree(proj, "create", "--slug", slug, "--base", "main");
      expect(created.status, created.out).toBe(0);
      expect(git(proj, "config", "filter.lossy.clean", "tr a-z A-Z").status).toBe(0);
      writeFileSync(join(wt, ".gitattributes"), Buffer.concat([name, Buffer.from(" filter=lossy\n")]));
      const path = Buffer.concat([Buffer.from(`${wt}/`), name]);
      writeFileSync(path, "original lowercase notes\n");
      expect(git(wt, "add", "-A").status).toBe(0);
      expect(git(wt, "commit", "-q", "-m", "track a byte-exact filtered filename").status).toBe(0);
      const head = git(wt, "rev-parse", "HEAD").stdout.trim();
      const dirtyBytes = Buffer.from("dirty lowercase notes\n");
      writeFileSync(path, dirtyBytes);

      const aborted = runBolt(
        proj, "abort", "--name", "Non-UTF-8 Filtered Bolt", "--slug", slug,
        "--reason", "refuse to park transformed bytes", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(1);
      expect(aborted.out).toContain("non-UTF-8 name");
      expect(existsSync(wt)).toBe(true);
      expect(git(proj, "rev-parse", "--verify", `refs/heads/bolt-${slug}`).stdout.trim()).toBe(head);
      expect(readFileSync(path)).toEqual(dirtyBytes);
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toBe("");
      expect(eventBlock(proj, "BOLT_FAILED")).toBe("");
    });

    test.skipIf(process.platform === "win32")("discard refuses an ident-only non-UTF-8 filename before removing the live attempt", () => {
      const proj = setupLifecycleProject();
      const slug = "non-utf8-ident";
      const wt = worktreeDir(proj, slug);
      const name = Buffer.from([0x6e, 0xff, 0x2e, 0x69, 0x64]); // n\xFF.id
      writeFileSync(join(proj, ".gitattributes"), "*.id ident\n");
      gitInitMain(proj);
      const created = runWorktree(proj, "create", "--slug", slug, "--base", "main");
      expect(created.status, created.out).toBe(0);
      const path = Buffer.concat([Buffer.from(`${wt}/`), name]);
      writeFileSync(path, "$Id$\n");
      expect(git(wt, "add", "-A").status).toBe(0);
      expect(git(wt, "commit", "-q", "-m", "track an ident-only byte-exact filename").status).toBe(0);
      const head = git(wt, "rev-parse", "HEAD").stdout.trim();
      const dirtyBytes = Buffer.from("$Id: deadbeef $\n");
      writeFileSync(path, dirtyBytes);

      const aborted = runBolt(
        proj, "abort", "--name", "Non-UTF-8 Ident Bolt", "--slug", slug,
        "--reason", "refuse to collapse the expanded ident", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(1);
      expect(aborted.out).toContain("non-UTF-8 name");
      expect(existsSync(wt)).toBe(true);
      expect(git(proj, "rev-parse", "--verify", `refs/heads/bolt-${slug}`).stdout.trim()).toBe(head);
      expect(readFileSync(path)).toEqual(dirtyBytes);
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toBe("");
      expect(eventBlock(proj, "BOLT_FAILED")).toBe("");
    });

    test("raw restore ignores replacement refs for parked blobs", () => {
      const proj = setupLifecycleProject();
      const slug = "replaced-blob";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, "notes.txt"), "original notes\n");
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const dirtyBytes = "parked lowercase notes\n";
      writeFileSync(join(wt, "notes.txt"), dirtyBytes);
      const aborted = runBolt(
        proj, "abort", "--name", "Replaced Blob Bolt", "--slug", slug,
        "--reason", "recover original objects", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const { parked_ref: parkedRef } = JSON.parse(aborted.out) as { parked_ref: string };
      const original = git(proj, "rev-parse", `${parkedRef}/head:notes.txt`);
      expect(original.status).toBe(0);
      const replacement = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: proj, input: "replacement bytes must not be restored\n", encoding: "utf-8",
      });
      expect(replacement.status).toBe(0);
      const originalSha = original.stdout.trim();
      expect(git(proj, "replace", originalSha, replacement.stdout.trim()).status).toBe(0);
      try {
        const restored = runWorktree(proj, "restore", "--slug", slug);
        expect(restored.status, restored.out).toBe(0);
        const { worktree_path: restoredPath } = JSON.parse(restored.out) as { worktree_path: string };
        expect(readFileSync(join(restoredPath, "notes.txt"), "utf-8")).toBe(dirtyBytes);
      } finally {
        expect(git(proj, "replace", "-d", originalSha).status).toBe(0);
      }
    });

    test.skipIf(process.platform === "win32")("restore preserves a dirty tracked non-UTF-8 filename byte-exactly", () => {
      const proj = setupLifecycleProject();
      const slug = "non-utf8-path";
      const wt = worktreeDir(proj, slug);
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const name = Buffer.concat([Buffer.from("notes-"), Buffer.from([0xff]), Buffer.from(".bin")]);
      const path = Buffer.concat([Buffer.from(`${wt}/`), name]);
      writeFileSync(path, "original bytes\n");
      expect(git(wt, "add", "-A").status).toBe(0);
      expect(git(wt, "commit", "-q", "-m", "track a non-UTF-8 filename").status).toBe(0);
      const dirtyBytes = Buffer.from([0, 0xff, 13, 10, 0x80]);
      writeFileSync(path, dirtyBytes);

      const aborted = runBolt(
        proj, "abort", "--name", "Non-UTF-8 Filename Bolt", "--slug", slug,
        "--reason", "retain filename bytes", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const { worktree_path: restoredPath } = JSON.parse(restored.out) as { worktree_path: string };
      expect(JSON.parse(restored.out).raw_bytes).toBe(true);
      const restoredName = readdirSync(restoredPath, { encoding: "buffer" })
        .map((entry) => Buffer.from(entry)).find((entry) => entry.equals(name));
      expect(restoredName).toEqual(name);
      expect(readFileSync(Buffer.concat([Buffer.from(`${restoredPath}/`), name]))).toEqual(dirtyBytes);
    });

    test("restore materializes a large index exceeding one MiB", () => {
      const proj = setupLifecycleProject();
      const slug = "large-index";
      const wt = worktreeDir(proj, slug);
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const fileCount = 12_000;
      const nameFor = (i: number): string => `${String(i).padStart(5, "0")}-${"x".repeat(84)}`;
      const bytes = Buffer.from([0, 0xff, 10, 0x80]);
      for (let i = 0; i < fileCount; i++) writeFileSync(join(wt, nameFor(i)), bytes);
      expect(git(wt, "add", "-A").status).toBe(0);
      expect(git(wt, "commit", "-q", "-m", "track a large source tree").status).toBe(0);
      const listing = Bun.spawnSync(["git", "ls-files", "-s", "-z"], { cwd: wt, stdout: "pipe" });
      expect(listing.exitCode).toBe(0);
      expect(listing.stdout.length).toBeGreaterThan(1024 * 1024);
      const parkedFileCount = listing.stdout.reduce((count, byte) => count + Number(byte === 0), 0);

      const aborted = runBolt(
        proj, "abort", "--name", "Large Index Bolt", "--slug", slug,
        "--reason", "recover every indexed file", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out) as { worktree_path: string; materialized: number };
      expect(JSON.parse(restored.out).raw_bytes).toBe(true);
      expect(recovery.materialized).toBe(parkedFileCount);
      expect(readFileSync(join(recovery.worktree_path, nameFor(fileCount - 1)))).toEqual(bytes);
    }, 60_000);

    test.skipIf(process.platform === "win32")("restore writes symlink target bytes as a regular file with core.symlinks=false", () => {
      const proj = setupLifecycleProject();
      const slug = "disabled-symlinks";
      writeFileSync(join(proj, "target.txt"), "target contents\n");
      symlinkSync("target.txt", join(proj, "runner"));
      gitInitMain(proj);
      expect(git(proj, "config", "core.symlinks", "false").status).toBe(0);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const aborted = runBolt(
        proj, "abort", "--name", "Disabled Symlinks Bolt", "--slug", slug,
        "--reason", "honor the repository symlink policy", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const { worktree_path: restoredPath } = JSON.parse(restored.out) as { worktree_path: string };
      expect(JSON.parse(restored.out).raw_bytes).toBe(true);
      const restoredLink = join(restoredPath, "runner");
      expect(lstatSync(restoredLink).isSymbolicLink()).toBe(false);
      expect(lstatSync(restoredLink).isFile()).toBe(true);
      expect(readFileSync(restoredLink)).toEqual(Buffer.from("target.txt"));
    });

    test.skipIf(process.platform === "win32")("restore preserves executable files and symbolic links", () => {
      const proj = setupLifecycleProject();
      const slug = "file-modes";
      const wt = worktreeDir(proj, slug);
      mkdirSync(join(proj, "bin"));
      writeFileSync(join(proj, "bin", "run.sh"), "#!/bin/sh\nprintf 'original\\n'\n");
      chmodSync(join(proj, "bin", "run.sh"), 0o755);
      symlinkSync("bin/run.sh", join(proj, "runner"));
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const scriptBytes = "#!/bin/sh\nprintf 'recovered\\n'\n";
      writeFileSync(join(wt, "bin", "run.sh"), scriptBytes);
      const aborted = runBolt(
        proj, "abort", "--name", "File Modes Bolt", "--slug", slug,
        "--reason", "retain executable and symlink modes", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const { worktree_path: restoredPath } = JSON.parse(restored.out) as { worktree_path: string };
      expect(JSON.parse(restored.out).raw_bytes).toBe(true);
      expect(readFileSync(join(restoredPath, "bin", "run.sh"), "utf-8")).toBe(scriptBytes);
      expect(lstatSync(join(restoredPath, "bin", "run.sh")).mode & 0o777).toBe(0o777 & ~process.umask());
      expect(lstatSync(join(restoredPath, "runner")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(restoredPath, "runner"))).toBe("bin/run.sh");
      expect(readFileSync(join(restoredPath, "runner"), "utf-8")).toBe(scriptBytes);
    });

    test("a broken optional clean filter still parks and restores the raw bytes", () => {
      const proj = setupLifecycleProject();
      const slug = "optional-filter";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, ".gitattributes"), "notes.broken filter=broken\n");
      writeFileSync(join(proj, "notes.broken"), "original notes\n");
      gitInitMain(proj);
      expect(git(proj, "config", "filter.broken.clean", "false").status).toBe(0);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const dirtyBytes = "dirty bytes survive an optional filter failure\n";
      writeFileSync(join(wt, "notes.broken"), dirtyBytes);

      const aborted = runBolt(
        proj, "abort", "--name", "Optional Filter Bolt", "--slug", slug,
        "--reason", "git falls back to raw bytes", "--discard",
      );
      expect(aborted.status).toBe(0);
      const { parked_ref: parkedRef } = JSON.parse(aborted.out) as { parked_ref: string };
      expect(existsSync(wt)).toBe(false);
      expect(git(proj, "cat-file", "-p", `${parkedRef}/head:notes.broken`).stdout).toBe(dirtyBytes);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status).toBe(0);
      const { worktree_path: restoredPath } = JSON.parse(restored.out) as { worktree_path: string };
      expect(JSON.parse(restored.out).raw_bytes).toBe(true);
      expect(readFileSync(join(restoredPath, "notes.broken"), "utf-8")).toBe(dirtyBytes);
    });

    test("a broken required clean filter refuses discard without destroying the live attempt", () => {
      const proj = setupLifecycleProject();
      const slug = "required-filter";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, ".gitattributes"), "notes.broken filter=broken\n");
      writeFileSync(join(proj, "notes.broken"), "original notes\n");
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const head = git(wt, "rev-parse", "HEAD").stdout.trim();
      const dirtyBytes = "dirty bytes survive a required filter failure\n";
      writeFileSync(join(wt, "notes.broken"), dirtyBytes);
      expect(git(proj, "config", "filter.broken.clean", "false").status).toBe(0);
      expect(git(proj, "config", "filter.broken.required", "true").status).toBe(0);

      const aborted = runBolt(
        proj, "abort", "--name", "Required Filter Bolt", "--slug", slug,
        "--reason", "snapshot must succeed first", "--discard",
      );
      expect(aborted.status).toBe(1);
      expect(existsSync(wt)).toBe(true);
      expect(git(proj, "rev-parse", "--verify", `refs/heads/bolt-${slug}`).stdout.trim()).toBe(head);
      expect(git(wt, "rev-parse", "HEAD").stdout.trim()).toBe(head);
      expect(readFileSync(join(wt, "notes.broken"), "utf-8")).toBe(dirtyBytes);
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toBe("");
      expect(eventBlock(proj, "BOLT_FAILED")).toBe("");
    });

    test("a conflicting parked ref refuses abort before audit or destructive cleanup", () => {
      const proj = setupLifecycleProject();
      const slug = "blocked-parking";
      const wt = worktreeDir(proj, slug);
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const head = git(wt, "rev-parse", "HEAD").stdout.trim();
      const reviewedRef = `refs/aidlc/reviewed-source/${slug}/${head}`;
      expect(git(proj, "update-ref", reviewedRef, head).status).toBe(0);
      writeFileSync(join(wt, "untracked.bin"), Buffer.from([0, 255, 10]));
      // A file/directory ref conflict fails even when the test runs as root.
      expect(git(proj, "update-ref", "refs/aidlc/parked", "HEAD").status).toBe(0);
      try {
        const discarded = runWorktree(proj, "discard", "--slug", slug);
        expect(discarded.status).toBe(1);
        expect(discarded.out).toContain("refusing to discard: parking the attempt failed");
        const aborted = runBolt(
          proj, "abort", "--name", "Blocked Bolt", "--slug", slug,
          "--reason", "parking must succeed first", "--discard",
        );
        expect(aborted.status).toBe(1);
        expect(aborted.out).toContain("refusing to discard: parking the attempt failed");
        expect(eventBlock(proj, "WORKTREE_DISCARDED")).toBe("");
        expect(eventBlock(proj, "BOLT_FAILED")).toBe("");
        expect(git(proj, "rev-parse", "--verify", `refs/heads/bolt-${slug}`).stdout.trim()).toBe(head);
        expect(git(proj, "rev-parse", "--verify", reviewedRef).stdout.trim()).toBe(head);
        expect(git(wt, "rev-parse", "HEAD").stdout.trim()).toBe(head);
        expect(readFileSync(join(wt, "untracked.bin"))).toEqual(Buffer.from([0, 255, 10]));
      } finally {
        expect(git(proj, "update-ref", "-d", "refs/aidlc/parked").status).toBe(0);
      }
    });

    test("branch-only partial cleanup still parks and restores the unmerged tip", () => {
      const proj = setupLifecycleProject();
      const slug = "branch-only";
      const wt = worktreeDir(proj, slug);
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      writeFileSync(join(wt, "committed.txt"), "survives checkout removal\n");
      expect(git(wt, "add", "committed.txt").status).toBe(0);
      expect(git(wt, "commit", "-q", "-m", "branch-only work").status).toBe(0);
      const head = git(wt, "rev-parse", "HEAD").stdout.trim();
      expect(git(proj, "worktree", "remove", "--force", wt).status).toBe(0);
      const discarded = runWorktree(proj, "discard", "--slug", slug);
      expect(discarded.status).toBe(0);
      const parked = JSON.parse(discarded.out) as { parked_ref: string; parked_commit: string };
      expect(parked.parked_commit).toBe(head);
      expect(git(proj, "rev-parse", "--verify", `${parked.parked_ref}/head`).stdout.trim()).toBe(head);
      expect(git(proj, "rev-parse", "--verify", `${parked.parked_ref}/branch-tip`).stdout.trim()).toBe(head);
      expect(git(proj, "show-ref", "--verify", "--quiet", `refs/heads/bolt-${slug}`).status).toBe(1);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status).toBe(0);
      const recovery = JSON.parse(restored.out) as { worktree_path: string; reviewed_source_refs: number };
      expect(JSON.parse(restored.out).raw_bytes).toBe(false);
      expect(JSON.parse(restored.out).restore_mode).toBe("branch-tip");
      expect(recovery.reviewed_source_refs).toBe(0);
      expect(git(recovery.worktree_path, "rev-parse", "HEAD").stdout.trim()).toBe(head);
      expect(readFileSync(join(recovery.worktree_path, "committed.txt"), "utf-8")).toBe("survives checkout removal\n");
      expect(git(proj, "worktree", "remove", "--force", recovery.worktree_path).status).toBe(0);
      const purged = runWorktree(proj, "purge", "--slug", slug);
      expect(purged.status, purged.out).toBe(0);
      expect(JSON.parse(purged.out)).toEqual({ purged: 2, slug, stamps: [parked.parked_ref.split("/").at(-1)!] });
      expect(git(proj, "for-each-ref", "--format=%(refname)", `${parked.parked_ref}/`).stdout).toBe("");
    });

    for (const legacy of [false, true]) {
      test.skipIf(process.platform === "win32")(`${legacy ? "legacy unmarked" : "marked"} branch-only restore applies checkout filters and encoding unless --raw is supplied`, () => {
        const proj = setupLifecycleProject();
        const slug = "branch-only-smudge";
        const wt = worktreeDir(proj, slug);
        gitInitMain(proj);
        expect(git(proj, "config", "filter.lossy.clean", "cat").status).toBe(0);
        expect(git(proj, "config", "filter.lossy.smudge", "tr a-z A-Z").status).toBe(0);
        writeFileSync(join(proj, ".gitattributes"), "*.lossy filter=lossy\n*.ps1 working-tree-encoding=UTF-16LE\n");
        writeFileSync(join(proj, "notes.lossy"), "original lowercase notes\n");
        const script = "Write-Output 'café'\n";
        const scriptBytes = Buffer.from(script, "utf16le");
        writeFileSync(join(proj, "script.ps1"), scriptBytes);
        expect(git(proj, "add", ".gitattributes", "notes.lossy", "script.ps1").status).toBe(0);
        expect(git(proj, "commit", "-q", "-m", "seed checkout filter and encoding").status).toBe(0);
        expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
        const committedBytes = "committed lowercase branch notes\n";
        writeFileSync(join(wt, "notes.lossy"), committedBytes);
        expect(git(wt, "add", "notes.lossy").status).toBe(0);
        expect(git(wt, "commit", "-q", "-m", "branch-only filtered work").status).toBe(0);
        rmSync(wt, { recursive: true, force: true });
        expect(git(proj, "worktree", "prune").status).toBe(0);
        const discarded = runWorktree(proj, "discard", "--slug", slug);
        expect(discarded.status, discarded.out).toBe(0);
        const { parked_ref: parkedRef } = JSON.parse(discarded.out) as { parked_ref: string };
        const stamp = parkedRef.split("/").at(-1)!;
        if (legacy) {
          expect(git(proj, "update-ref", "-d", `${parkedRef}/branch-tip`).status).toBe(0);
          expect(git(proj, "for-each-ref", "--format=%(refname)", `${parkedRef}/`).stdout.trim()).toBe(`${parkedRef}/head`);
        }

        const restored = runWorktree(proj, "restore", "--slug", slug, "--parked", stamp);
        expect(restored.status, restored.out).toBe(0);
        const recovery = JSON.parse(restored.out) as { worktree_path: string; branch: string; raw_bytes: boolean; restore_mode: string };
        expect({
          notes: readFileSync(join(recovery.worktree_path, "notes.lossy"), "utf-8"),
          script: readFileSync(join(recovery.worktree_path, "script.ps1")),
          raw_bytes: recovery.raw_bytes,
          restore_mode: recovery.restore_mode,
        }).toEqual({
          notes: committedBytes.toUpperCase(),
          script: scriptBytes,
          raw_bytes: false,
          restore_mode: legacy ? "legacy-branch-tip" : "branch-tip",
        });
        expect(recovery).not.toHaveProperty("materialized");
        expect(git(proj, "worktree", "remove", "--force", recovery.worktree_path).status).toBe(0);
        expect(git(proj, "branch", "-D", recovery.branch).status).toBe(0);

        const rawRestore = runWorktree(proj, "restore", "--raw", "--slug", slug, "--parked", stamp);
        expect(rawRestore.status, rawRestore.out).toBe(0);
        const rawRecovery = JSON.parse(rawRestore.out) as { worktree_path: string; raw_bytes: boolean; restore_mode: string };
        expect(readFileSync(join(rawRecovery.worktree_path, "notes.lossy"), "utf-8")).toBe(committedBytes);
        expect(readFileSync(join(rawRecovery.worktree_path, "script.ps1"))).toEqual(Buffer.from(script));
        expect(rawRecovery.raw_bytes).toBe(true);
        expect(rawRecovery.restore_mode).toBe("raw-requested");
      });
    }

    test.skipIf(process.platform === "win32")("branch-only restore reports required filter failures and --raw bypasses them", () => {
      const proj = setupLifecycleProject();
      const slug = "branch-only-required-smudge";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, ".gitattributes"), "*.broken filter=broken\n");
      const committedBytes = "committed bytes survive a broken checkout filter\n";
      writeFileSync(join(proj, "notes.broken"), committedBytes);
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      rmSync(wt, { recursive: true, force: true });
      expect(git(proj, "worktree", "prune").status).toBe(0);
      const discarded = runWorktree(proj, "discard", "--slug", slug);
      expect(discarded.status, discarded.out).toBe(0);
      const { parked_ref: parkedRef } = JSON.parse(discarded.out) as { parked_ref: string };
      const stamp = parkedRef.split("/").at(-1)!;
      expect(git(proj, "config", "filter.broken.clean", "cat").status).toBe(0);
      expect(git(proj, "config", "filter.broken.smudge", "false").status).toBe(0);
      expect(git(proj, "config", "filter.broken.required", "true").status).toBe(0);

      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).not.toBe(0);
      expect(restored.out).toContain("smudge filter broken failed");
      expect(restored.out).toContain("--raw");
      // Git may retain the failed checkout and its branch; remove both before retrying.
      const restoredPath = join(proj, ".aidlc", "restored", `bolt-${slug}-${stamp}`);
      git(proj, "worktree", "remove", "--force", restoredPath);
      rmSync(restoredPath, { recursive: true, force: true });
      expect(git(proj, "worktree", "prune").status).toBe(0);
      expect(git(proj, "branch", "-D", `restore/bolt-${slug}-${stamp}`).status).toBe(0);
      const rawRestore = runWorktree(proj, "restore", "--slug", slug, "--raw");
      expect(rawRestore.status, rawRestore.out).toBe(0);
      const recovery = JSON.parse(rawRestore.out) as { worktree_path: string; raw_bytes: boolean };
      expect(readFileSync(join(recovery.worktree_path, "notes.broken"), "utf-8")).toBe(committedBytes);
      expect(recovery.raw_bytes).toBe(true);
    });

    test("reviewed-only partial cleanup parks evidence without inventing a restorable head", () => {
      const proj = setupLifecycleProject();
      const slug = "reviewed-only";
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const head = git(proj, "rev-parse", "HEAD").stdout.trim();
      const reviewedRef = `refs/aidlc/reviewed-source/${slug}/${head}`;
      expect(git(proj, "update-ref", reviewedRef, head).status).toBe(0);
      expect(git(proj, "worktree", "remove", "--force", worktreeDir(proj, slug)).status).toBe(0);
      expect(git(proj, "branch", "-D", `bolt-${slug}`).status).toBe(0);
      const discarded = runWorktree(proj, "discard", "--slug", slug);
      expect(discarded.status).toBe(0);
      const parked = JSON.parse(discarded.out) as { parked_ref: string; parked_commit: string };
      expect(parked.parked_commit).toBe("-");
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toContain(`**Parked ref**: ${parked.parked_ref}`);
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toContain("**Parked commit**: -");
      expect(git(proj, "rev-parse", "--verify", `${parked.parked_ref}/reviewed-source/${head}`).stdout.trim()).toBe(head);
      expect(git(proj, "show-ref", "--verify", "--quiet", reviewedRef).status).toBe(1);
      expect(git(proj, "show-ref", "--verify", "--quiet", `${parked.parked_ref}/head`).status).toBe(1);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status).not.toBe(0);
      expect(restored.out).toContain("no parked attempt");
      const purged = runWorktree(proj, "purge", "--slug", slug);
      expect(purged.status).toBe(0);
      expect(JSON.parse(purged.out)).toEqual({
        purged: 1,
        slug,
        stamps: [parked.parked_ref.split("/").at(-1)],
      });
      expect(git(proj, "for-each-ref", "--format=%(refname)", `${parked.parked_ref}/`).stdout).toBe("");
    });

    test("latest restore compares same-second suffixes numerically and explicit purge isolates its stamp", () => {
      const proj = setupLifecycleProject();
      const slug = "numbered";
      gitInitMain(proj);
      const olderCommit = git(proj, "rev-parse", "HEAD").stdout.trim();
      writeFileSync(join(proj, "latest.txt"), "numeric suffix ten\n");
      expect(git(proj, "add", "latest.txt").status).toBe(0);
      expect(git(proj, "commit", "-q", "-m", "later parked work").status).toBe(0);
      const newerCommit = git(proj, "rev-parse", "HEAD").stdout.trim();
      // Seed persisted attempts directly; no wall-clock race or subprocess clock mock.
      const olderStamp = "20260101T120000Z-2";
      const newerStamp = "20260101T120000Z-10";
      const olderRef = `refs/aidlc/parked/${slug}/${olderStamp}`;
      const newerRef = `refs/aidlc/parked/${slug}/${newerStamp}`;
      expect(git(proj, "update-ref", `${olderRef}/head`, olderCommit).status).toBe(0);
      expect(git(proj, "update-ref", `${newerRef}/head`, newerCommit).status).toBe(0);

      const latest = runWorktree(proj, "restore", "--slug", slug);
      expect(latest.status).toBe(0);
      const latestRecovery = JSON.parse(latest.out) as { parked_ref: string; worktree_path: string };
      expect(latestRecovery.parked_ref).toBe(newerRef);
      expect(git(latestRecovery.worktree_path, "rev-parse", "HEAD").stdout.trim()).toBe(newerCommit);
      expect(readFileSync(join(latestRecovery.worktree_path, "latest.txt"), "utf-8")).toBe("numeric suffix ten\n");

      const older = runWorktree(proj, "restore", "--slug", slug, "--parked", olderStamp);
      expect(older.status).toBe(0);
      const olderRecovery = JSON.parse(older.out) as { parked_ref: string; worktree_path: string };
      expect(olderRecovery.parked_ref).toBe(olderRef);
      expect(git(olderRecovery.worktree_path, "rev-parse", "HEAD").stdout.trim()).toBe(olderCommit);
      expect(existsSync(join(olderRecovery.worktree_path, "latest.txt"))).toBe(false);
      expect(git(proj, "worktree", "remove", "--force", olderRecovery.worktree_path).status).toBe(0);
      const purged = runWorktree(proj, "purge", "--slug", slug, "--parked", olderStamp);
      expect(purged.status).toBe(0);
      expect(JSON.parse(purged.out)).toEqual({ purged: 1, slug, stamps: [olderStamp] });
      expect(git(proj, "show-ref", "--verify", "--quiet", `${olderRef}/head`).status).toBe(1);
      expect(git(proj, "rev-parse", "--verify", `${newerRef}/head`).stdout.trim()).toBe(newerCommit);
      expect(readFileSync(join(latestRecovery.worktree_path, "latest.txt"), "utf-8")).toBe("numeric suffix ten\n");
    });
  });
});
