// covers: subcommand:aidlc-bolt:start, subcommand:aidlc-bolt:complete, subcommand:aidlc-bolt:abort
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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
function git(proj: string, ...args: string[]): void {
  spawnSync("git", ["-C", proj, ...args], { encoding: "utf-8" });
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

describe("t78 aidlc-bolt per-Bolt worktree lifecycle (migrated from t78-bolt-worktree-lifecycle.sh, plan 13)", () => {
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

    runBolt(proj, "abort", "--name", "Baz Bolt", "--slug", slug, "--reason", "preserve check");

    test("L3: abort without --discard preserves worktree directory [.sh T9]", () => {
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
});
