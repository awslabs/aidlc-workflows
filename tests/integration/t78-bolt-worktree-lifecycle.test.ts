// covers: subcommand:aidlc-bolt:start, subcommand:aidlc-bolt:complete, subcommand:aidlc-bolt:abort, subcommand:aidlc-worktree:restore, subcommand:aidlc-worktree:purge
// covers: function:recoveryRepoCandidates
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
//   dist/claude/.claude/tools/aidlc-lib.ts worktreePath -> intent-scoped Bolt dir.
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
//     worktree's mirrored intent record (worktreePath contract).
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
  cpSync,
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
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { type EngineInvocation, renderEngineInvocation } from "../../core/tools/aidlc-guard-operation.ts";
import { boltName, createIntent, parkedRefPrefix, reviewedSourceRefPrefix, worktreePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  fixtureIntentId8,
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
}, 30_000);

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

/** Execute the typed engine route and argv without interpreting its display command. */
function runRecoveryOperation(proj: string, operation: EngineInvocation, env?: NodeJS.ProcessEnv): RunResult {
  const res = spawnSync(BUN, [join(AIDLC_SRC, "tools", `aidlc-${operation.route}.ts`),
    ...operation.args, "--project-dir", proj], { encoding: "utf-8", cwd: proj, env: { ...process.env, ...env } });
  return { status: res.status ?? -1, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function doctorAttempts(proj: string): {
  repo: string | null;
  restore_operation?: EngineInvocation;
  purge_operation: EngineInvocation;
  restore_command?: string;
  purge_command?: string;
}[] {
  const res = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "doctor", "--json", "--project-dir", proj], {
    encoding: "utf-8", cwd: proj,
  });
  return JSON.parse(res.stdout).data.parked_attempts;
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

/** Capture the linked sibling through real AUTO discovery, not a hand-authored repo row. */
function setupRecordedSymlinkProject(): { proj: string; external: string } {
  const proj = createTestProject();
  const external = createTestProject();
  tempDirs.push(proj, external);
  writeFileSync(join(external, "saved.txt"), "linked repository base\n");
  gitInitMain(external);
  symlinkSync(external, join(proj, "api"), "junction");
  // Omitting --repos is AUTO discovery; an explicit list would bypass the regression.
  const created = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc-utility.ts"),
    "intent-create", "--scope", "feature", "--arguments", "Recover linked repository work",
    "--project-dir", proj], { encoding: "utf-8", cwd: proj });
  expect(created.status, `${created.stdout}${created.stderr}`).toBe(0);
  const intents = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents");
  const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
  const roster = JSON.parse(readFileSync(join(intents, "intents.json"), "utf-8"));
  expect(roster.find((entry: { dirName: string }) => entry.dirName === record).repos).toEqual(["api"]);
  cpSync(join(FIXTURES_DIR, "state-construction.md"), join(intents, record, "aidlc-state.md"));
  return { proj, external };
}

/** Resolve the selected fixture intent's canonical worktree directory. */
function worktreeDir(proj: string, slug: string): string {
  return worktreePath(proj, fixtureIntentId8(proj), slug);
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

/** Persist recovery ownership alongside synthetic refs, just as discard does for real attempts. */
function recordParkedAttempt(
  proj: string,
  slug: string,
  parkedRef: string,
  repo: string | null = null,
  intent = DEFAULT_RECORD_DIR,
  space = DEFAULT_SPACE,
): void {
  appendAuditEntry("WORKTREE_DISCARDED", {
    "Bolt slug": slug,
    "Worktree path": relative(proj, worktreePath(proj, fixtureIntentId8(proj, intent, space), slug)).replaceAll("\\", "/"),
    "Parked ref": parkedRef,
    Repo: repo ?? "-",
  }, proj, intent, space);
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
      expect(value).toBe(relative(proj, worktreeDir(proj, slug)).replace(/\\/g, "/"));
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
      // R4(d): namespaced snapshot recovery keeps every parked ref scoped to its recorded intent.
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
      const reviewedRef = `${reviewedSourceRefPrefix(fixtureIntentId8(proj), slug)}${unmergedCommit}`;
      expect(git(proj, "update-ref", reviewedRef, unmergedCommit).status).toBe(0);

      const aborted = runBolt(
        proj, "abort", "--name", "Recoverable Bolt", "--slug", slug,
        "--reason", "restart after review", "--discard",
      );
      expect(aborted.status).toBe(0);
      const result = JSON.parse(aborted.out);
      expect(result.reason).toBe("aborted");
      expect(result.abort_reason).toBe("restart after review");
      expect(result.parked_excludes).toEqual(["ignored files", "eol/text=auto normalization"]);
      const { parked_ref: parkedRef } = JSON.parse(aborted.out) as { parked_ref: string };
      expect(parkedRef.startsWith(parkedRefPrefix(fixtureIntentId8(proj), slug))).toBe(true);
      expect(parkedRef.slice(parkedRefPrefix(fixtureIntentId8(proj), slug).length)).toMatch(/^\d{8}T\d{6}Z(?:-[1-9]\d*)?$/);
      const stamp = parkedRef.split("/").at(-1)!;
      const parkedHead = git(proj, "rev-parse", "--verify", `${parkedRef}/head`);
      expect(parkedHead.status).toBe(0);
      const parkedCommit = parkedHead.stdout.trim();
      const parkedReviewedRef = `${parkedRef}/reviewed-source/${unmergedCommit}`;
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toContain(`**Parked ref**: ${parkedRef}`);
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toContain(`**Parked commit**: ${parkedCommit}`);
      expect(git(proj, "rev-parse", "--verify", parkedReviewedRef).stdout.trim()).toBe(unmergedCommit);
      expect(git(proj, "show-ref", "--verify", "--quiet", reviewedRef).status).toBe(1);
      expect(git(proj, "show-ref", "--verify", "--quiet", `refs/heads/${boltName(fixtureIntentId8(proj), slug)}`).status).toBe(1);
      expect(existsSync(wt)).toBe(false);

      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      writeFileSync(join(wt, "tracked.bin"), "new live attempt\n");
      writeFileSync(join(wt, "live-only.txt"), "leave this live checkout alone\n");
      const liveHead = git(wt, "rev-parse", "HEAD").stdout.trim();
      const liveStatus = git(wt, "status", "--porcelain").stdout;
      const auditBeforeRecovery = auditEvents(proj);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status).toBe(0);
      const restoredPath = join(proj, ".aidlc", "restored", `${boltName(fixtureIntentId8(proj), slug)}-${stamp}`);
      const restoredBranch = `restore/${boltName(fixtureIntentId8(proj), slug)}-${stamp}`;
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
        { slug, worktree_path: wt.replaceAll("\\", "/"), branch: boltName(fixtureIntentId8(proj), slug), intent_id8: fixtureIntentId8(proj), legacy: false },
      ]);
      const repeatedRestore = runWorktree(proj, "restore", "--slug", slug, "--parked", stamp);
      expect(repeatedRestore.status).not.toBe(0);
      expect(JSON.parse(repeatedRestore.out).error).toContain(`already restored at ${restoredPath}`);
      expect(readFileSync(join(restoredPath, "untracked.bin"))).toEqual(untrackedBytes);
      const refusedPurge = runWorktree(proj, "purge", "--slug", slug);
      expect(refusedPurge.status).not.toBe(0);
      expect(JSON.parse(refusedPurge.out).error.replaceAll("\\", "/"))
        .toContain(`restore checkout still present at ${restoredPath.replaceAll("\\", "/")}`);
      expect(git(proj, "rev-parse", "--verify", `${parkedRef}/head`).stdout.trim()).toBe(parkedCommit);
      expect(git(proj, "rev-parse", "--verify", parkedReviewedRef).stdout.trim()).toBe(unmergedCommit);
      expect(existsSync(restoredPath)).toBe(true);

      expect(git(proj, "worktree", "remove", "--force", restoredPath).status).toBe(0);
      const purged = runWorktree(proj, "purge", "--slug", slug);
      expect(purged.status).toBe(0);
      expect(JSON.parse(purged.out)).toEqual({ purged: 4, slug, stamps: [stamp], skipped_unparseable: [] });
      expect(git(proj, "for-each-ref", "--format=%(refname)", parkedRefPrefix(fixtureIntentId8(proj), slug)).stdout).toBe("");
      const noAttempt = runWorktree(proj, "restore", "--slug", slug);
      expect(noAttempt.status).not.toBe(0);
      expect(noAttempt.out).toContain("no parked attempt");
      expect(auditEvents(proj).filter((event) => event !== "ERROR_LOGGED")).toEqual(auditBeforeRecovery);
      expect(git(wt, "rev-parse", "HEAD").stdout.trim()).toBe(liveHead);
      expect(git(wt, "symbolic-ref", "--short", "HEAD").stdout.trim()).toBe(boltName(fixtureIntentId8(proj), slug));
      expect(git(wt, "status", "--porcelain").stdout).toBe(liveStatus);
      expect(readFileSync(join(wt, "tracked.bin"), "utf-8")).toBe("new live attempt\n");
      expect(readFileSync(join(wt, "live-only.txt"), "utf-8")).toBe("leave this live checkout alone\n");
      expect(existsSync(join(wt, "committed.txt"))).toBe(false);
      expect(existsSync(join(wt, "untracked.bin"))).toBe(false);
    }, 30_000);

    test("namespaced purge under another intent refuses the owner's exact parked stamp", () => {
      // R4(d): an explicit stamp cannot authorize recovery or purge outside its recording intent.
      const proj = setupLifecycleProject();
      const slug = "intent-park";
      writeFileSync(join(proj, "saved.txt"), "base source\n");
      gitInitMain(proj);
      const idA = fixtureIntentId8(proj);
      const createdA = runWorktree(proj, "create", "--slug", slug, "--base", "main");
      expect(createdA.status, createdA.out).toBe(0);
      writeFileSync(join(worktreePath(proj, idA, slug), "saved.txt"), "intent A parked source\n");
      const discarded = runWorktree(proj, "discard", "--slug", slug);
      expect(discarded.status, discarded.out).toBe(0);
      const parked = JSON.parse(discarded.out);
      const stamp = parked.parked_ref.split("/").at(-1);
      expect(parked.parked_ref.startsWith(parkedRefPrefix(idA, slug))).toBe(true);
      const refsA = git(proj, "for-each-ref", "--format=%(refname)%09%(objectname)", `${parked.parked_ref}/`).stdout;
      expect(git(proj, "show", `${parked.parked_ref}/head:saved.txt`).stdout).toBe("intent A parked source\n");

      const intentB = createIntent(proj, "other-intent", DEFAULT_SPACE);
      const idB = fixtureIntentId8(proj, intentB.dirName, DEFAULT_SPACE);
      const selectionB = ["--intent", intentB.dirName, "--space", DEFAULT_SPACE];
      const createdB = runWorktree(proj, "create", "--slug", slug, "--base", "main", ...selectionB);
      expect(createdB.status, createdB.out).toBe(0);
      const wtB = worktreePath(proj, idB, slug);
      writeFileSync(join(wtB, "saved.txt"), "intent B live source\n");
      const headB = git(wtB, "rev-parse", "HEAD").stdout.trim();
      const purgedByB = runWorktree(proj, "purge", "--slug", slug, "--parked", stamp, ...selectionB);
      expect(purgedByB.status, purgedByB.out).not.toBe(0);
      expect(purgedByB.out).toContain(`parked attempt ${stamp} is not recorded by intent aidlc/spaces/${DEFAULT_SPACE}/intents/${intentB.dirName}`);
      expect(git(proj, "for-each-ref", "--format=%(refname)%09%(objectname)", `${parked.parked_ref}/`).stdout).toBe(refsA);
      expect(git(wtB, "rev-parse", "HEAD").stdout.trim()).toBe(headB);
      expect(readFileSync(join(wtB, "saved.txt"), "utf-8")).toBe("intent B live source\n");

      const selectionA = ["--intent", DEFAULT_RECORD_DIR, "--space", DEFAULT_SPACE];
      const restored = runWorktree(proj, "restore", "--slug", slug, "--parked", stamp, ...selectionA);
      expect(restored.status, restored.out).toBe(0);
      const restoredPath = JSON.parse(restored.out).worktree_path;
      expect(readFileSync(join(restoredPath, "saved.txt"), "utf-8")).toBe("intent A parked source\n");
      expect(git(proj, "worktree", "remove", "--force", restoredPath).status).toBe(0);
      const purgedByA = runWorktree(proj, "purge", "--slug", slug, "--parked", stamp, ...selectionA);
      expect(purgedByA.status, purgedByA.out).toBe(0);
      expect(JSON.parse(purgedByA.out)).toMatchObject({ stamps: [stamp], skipped_unparseable: [] });
      expect(git(proj, "for-each-ref", "--format=%(refname)", `${parked.parked_ref}/`).stdout).toBe("");
      expect(git(wtB, "rev-parse", "HEAD").stdout.trim()).toBe(headB);
      expect(readFileSync(join(wtB, "saved.txt"), "utf-8")).toBe("intent B live source\n");
    }, 30_000);

    test("abort recovery hint selects its exact snapshot after another same-slug park", () => {
      const proj = setupLifecycleProject();
      const slug = "exact-hint";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, "saved.txt"), "base bytes\n");
      gitInitMain(proj);

      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      writeFileSync(join(wt, "saved.txt"), "first parked attempt\n");
      const first = runWorktree(proj, "discard", "--slug", slug);
      expect(first.status, first.out).toBe(0);
      const firstPark = JSON.parse(first.out);

      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const savedBytes = "second parked attempt, named by the abort hint\n";
      writeFileSync(join(wt, "saved.txt"), savedBytes);
      const aborted = runBolt(
        proj, "abort", "--name", "Exact Hint", "--slug", slug,
        "--reason", "retain this attempt", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const parked = JSON.parse(aborted.out);
      const stamp = parked.parked_ref.split("/").at(-1);
      const commit = git(proj, "rev-parse", `${parked.parked_ref}/head`).stdout.trim();
      expect(parked.parked_ref).not.toBe(firstPark.parked_ref);

      // A saved hint must not drift to a newer attempt when it is executed later.
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      writeFileSync(join(wt, "saved.txt"), "third parked attempt, not the requested recovery\n");
      const later = runWorktree(proj, "discard", "--slug", slug);
      expect(later.status, later.out).toBe(0);
      const laterPark = JSON.parse(later.out);
      expect(laterPark.parked_ref).not.toBe(parked.parked_ref);

      expect(parked.restore_hint).toBe(renderEngineInvocation(parked.restore_operation));
      const restored = runRecoveryOperation(proj, parked.restore_operation);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out);
      expect(recovery.parked_ref).toBe(parked.parked_ref);
      expect(readFileSync(join(recovery.worktree_path, "saved.txt"), "utf-8")).toBe(savedBytes);
      expect(git(recovery.worktree_path, "rev-parse", "HEAD").stdout.trim()).toBe(commit);
      expect(parked).toMatchObject({
        parked_stamp: stamp,
        parked_mode: "snapshot",
        parked_repo: null,
        parked_excludes: ["ignored files", "eol/text=auto normalization"],
      });
      expect(laterPark).toMatchObject({
        parked_stamp: laterPark.parked_ref.split("/").at(-1),
        parked_commit: git(proj, "rev-parse", `${laterPark.parked_ref}/head`).stdout.trim(),
        parked_mode: "snapshot",
        parked_repo: null,
      });
    }, 30_000);

    test("abort keeps executable recovery argv when harness metacharacters prevent a display hint", () => {
      const proj = setupLifecycleProject();
      const slug = "unsafe-harness";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, "saved.bin"), "base bytes\n");
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const savedBytes = Buffer.from([0, 255, 13, 10, 128]);
      writeFileSync(join(wt, "saved.bin"), savedBytes);
      const env = { AIDLC_HARNESS_DIR: ".claude space;not-a-command" };
      const aborted = spawnSync(BUN, [BOLT, "abort", "--name", "Unsafe Harness", "--slug", slug,
        "--reason", "recover without executing display text", "--discard", "--project-dir", proj], {
        encoding: "utf-8", cwd: proj, env: { ...process.env, ...env },
      });
      expect(aborted.status, `${aborted.stdout}${aborted.stderr}`).toBe(0);
      const parked = JSON.parse(aborted.stdout);
      expect(parked).not.toHaveProperty("restore_hint");
      expect(parked.restore_hint_error).toMatch(/invalid.*harness directory/i);
      expect(parked.restore_operation).toEqual({
        route: "worktree",
        args: ["restore", "--slug", slug, "--parked", parked.parked_stamp, "--repo", ".", "--intent", DEFAULT_RECORD_DIR, "--space", DEFAULT_SPACE],
      });
      const restored = runRecoveryOperation(proj, parked.restore_operation, env);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out);
      expect(recovery.parked_ref).toBe(parked.parked_ref);
      expect(readFileSync(join(recovery.worktree_path, "saved.bin"))).toEqual(savedBytes);
    }, 10_000); // Real git create/park/restore sequence exceeded 5s on Windows CI.

    test("saved root and sibling abort hints still recover their repository after a collision", () => {
      const proj = setupLifecycleProject();
      const slug = "sibling-hint";
      const wt = worktreeDir(proj, slug);
      writeFileSync(join(proj, "saved.txt"), "root base\n");
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      writeFileSync(join(wt, "saved.txt"), "root parked attempt\n");
      const rootDiscard = runBolt(proj, "abort", "--name", "Root Hint", "--slug", slug,
        "--reason", "save the root attempt before a sibling exists", "--discard");
      expect(rootDiscard.status, rootDiscard.out).toBe(0);
      const rootPark = JSON.parse(rootDiscard.out);

      const sibling = join(proj, "api");
      mkdirSync(sibling);
      writeFileSync(join(sibling, "saved.txt"), "sibling base\n");
      gitInitMain(sibling);
      const created = runWorktree(proj, "create", "--slug", slug, "--base", "main", "--repo", "api");
      expect(created.status, created.out).toBe(0);
      const savedBytes = "sibling parked attempt\n";
      writeFileSync(join(wt, "saved.txt"), savedBytes);
      // Abort resolves the creating repository without requiring a new argv flag.
      const aborted = runBolt(
        proj, "abort", "--name", "Sibling Hint", "--slug", slug,
        "--reason", "recover from the creating repository", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const parked = JSON.parse(aborted.out);
      const stamp = parked.parked_ref.split("/").at(-1);
      const commit = git(sibling, "rev-parse", `${parked.parked_ref}/head`).stdout.trim();
      // Force a same-stamp collision even when the two aborts crossed a second.
      const siblingCollision = rootPark.parked_ref !== parked.parked_ref;
      if (siblingCollision) {
        expect(git(sibling, "update-ref", `${rootPark.parked_ref}/head`, commit).status).toBe(0);
      }

      expect(rootPark.restore_hint).toBe(renderEngineInvocation(rootPark.restore_operation));
      const restoredRoot = runRecoveryOperation(proj, rootPark.restore_operation);
      expect(restoredRoot.status, restoredRoot.out).toBe(0);
      const rootRecovery = JSON.parse(restoredRoot.out);
      expect(readFileSync(join(rootRecovery.worktree_path, "saved.txt"), "utf-8")).toBe("root parked attempt\n");
      expect(git(proj, "worktree", "remove", "--force", rootRecovery.worktree_path).status).toBe(0);
      expect(git(proj, "branch", "-D", rootRecovery.branch).status).toBe(0);
      if (siblingCollision) expect(git(sibling, "update-ref", "-d", `${rootPark.parked_ref}/head`).status).toBe(0);

      expect(parked.restore_hint).toBe(renderEngineInvocation(parked.restore_operation));
      const restored = runRecoveryOperation(proj, parked.restore_operation);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out);
      expect(readFileSync(join(recovery.worktree_path, "saved.txt"), "utf-8")).toBe(savedBytes);
      expect(git(recovery.worktree_path, "rev-parse", "HEAD").stdout.trim()).toBe(commit);
      expect(parked).toMatchObject({
        parked_stamp: stamp,
        parked_mode: "snapshot",
        parked_repo: "api",
        parked_excludes: ["ignored files", "eol/text=auto normalization"],
      });
      expect(git(proj, "show", `${rootPark.parked_ref}/head:saved.txt`).stdout).toBe("root parked attempt\n");
      expect(git(sibling, "worktree", "remove", "--force", recovery.worktree_path).status).toBe(0);
      expect(git(sibling, "branch", "-D", recovery.branch).status).toBe(0);
      const attempts = doctorAttempts(proj);
      expect(attempts.map((attempt) => attempt.repo).sort()).toEqual([null, "api"].sort());
      for (const attempt of attempts) {
        const cwd = attempt.repo === null ? proj : sibling;
        expect(attempt.restore_command).toBe(renderEngineInvocation(attempt.restore_operation!));
        const restoredByDoctor = runRecoveryOperation(proj, attempt.restore_operation!);
        expect(restoredByDoctor.status, restoredByDoctor.out).toBe(0);
        const restoredPath = JSON.parse(restoredByDoctor.out).worktree_path;
        expect(readFileSync(join(restoredPath, "saved.txt"), "utf-8")).toBe(
          attempt.repo === null ? "root parked attempt\n" : savedBytes);
        expect(git(cwd, "worktree", "remove", "--force", restoredPath).status).toBe(0);
        expect(attempt.purge_command).toBe(renderEngineInvocation(attempt.purge_operation));
        const purgedByDoctor = runRecoveryOperation(proj, attempt.purge_operation);
        expect(purgedByDoctor.status, purgedByDoctor.out).toBe(0);
        expect(git(cwd, "for-each-ref", "--format=%(refname)", parkedRefPrefix(fixtureIntentId8(proj), slug)).stdout).toBe("");
      }
    }, 30_000);

    test("AUTO-recorded symlink abort hints and doctor commands restore saved bytes and purge refs", () => {
      const { proj, external } = setupRecordedSymlinkProject();
      const slug = "recorded-link";
      const wt = worktreeDir(proj, slug);
      const created = runWorktree(proj, "create", "--slug", slug, "--base", "main");
      expect(created.status, created.out).toBe(0);
      const savedBytes = "dirty source in the linked repository\n";
      const scratchBytes = Buffer.from([0, 255, 13, 10, 128]);
      writeFileSync(join(wt, "saved.txt"), savedBytes);
      writeFileSync(join(wt, "scratch.bin"), scratchBytes);
      const aborted = runBolt(proj, "abort", "--name", "Recorded Link", "--slug", slug,
        "--reason", "recover the recorded linked repository", "--discard");
      expect(aborted.status, aborted.out).toBe(0);
      const parked = JSON.parse(aborted.out);
      expect(parked).toMatchObject({ parked_repo: "api", parked_mode: "snapshot" });
      expect(existsSync(wt)).toBe(false);
      expect(git(external, "show-ref", "--verify", "--quiet", `refs/heads/${boltName(fixtureIntentId8(proj), slug)}`).status).toBe(1);

      expect(parked.restore_hint).toBe(renderEngineInvocation(parked.restore_operation));
      const restored = runRecoveryOperation(proj, parked.restore_operation);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out);
      expect(readFileSync(join(recovery.worktree_path, "saved.txt"), "utf-8")).toBe(savedBytes);
      expect(readFileSync(join(recovery.worktree_path, "scratch.bin"))).toEqual(scratchBytes);
      const attempts = doctorAttempts(proj);
      expect(attempts).toEqual([expect.objectContaining({
        slug, repo: "api", stamp: parked.parked_stamp, mode: "snapshot", restored_exists: true,
      })]);
      expect(git(external, "worktree", "remove", "--force", recovery.worktree_path).status).toBe(0);
      expect(git(external, "branch", "-D", recovery.branch).status).toBe(0);

      expect(attempts[0].restore_command).toBe(renderEngineInvocation(attempts[0].restore_operation!));
      const restoredByDoctor = runRecoveryOperation(proj, attempts[0].restore_operation!);
      expect(restoredByDoctor.status, restoredByDoctor.out).toBe(0);
      const doctorRecovery = JSON.parse(restoredByDoctor.out);
      expect(readFileSync(join(doctorRecovery.worktree_path, "saved.txt"), "utf-8")).toBe(savedBytes);
      expect(readFileSync(join(doctorRecovery.worktree_path, "scratch.bin"))).toEqual(scratchBytes);
      expect(git(external, "worktree", "remove", "--force", doctorRecovery.worktree_path).status).toBe(0);
      expect(attempts[0].purge_command).toBe(renderEngineInvocation(attempts[0].purge_operation));
      const purgedByDoctor = runRecoveryOperation(proj, attempts[0].purge_operation);
      expect(purgedByDoctor.status, purgedByDoctor.out).toBe(0);
      expect(git(external, "for-each-ref", "--format=%(refname)", `${parked.parked_ref}/`).stdout).toBe("");
      expect(doctorAttempts(proj)).toEqual([]);
      expect(readFileSync(join(external, "saved.txt"), "utf-8")).toBe("linked repository base\n");
    }, 30_000);

    test("partial cleanup in an AUTO-recorded symlink repo discards and recovers the branch without --repo", () => {
      const { proj, external } = setupRecordedSymlinkProject();
      const slug = "linked-branch-only";
      const wt = worktreeDir(proj, slug);
      const created = runWorktree(proj, "create", "--slug", slug, "--base", "main");
      expect(created.status, created.out).toBe(0);
      const savedBytes = "committed linked source survives partial cleanup\n";
      writeFileSync(join(wt, "saved.txt"), savedBytes);
      expect(git(wt, "add", "saved.txt").status).toBe(0);
      expect(git(wt, "commit", "-q", "-m", "linked branch-only work").status).toBe(0);
      const head = git(wt, "rev-parse", "HEAD").stdout.trim();
      // Lose both the checkout metadata and Git registration: only the branch remains.
      rmSync(wt, { recursive: true, force: true });
      expect(git(external, "worktree", "prune").status).toBe(0);
      const discarded = runWorktree(proj, "discard", "--slug", slug);
      expect(discarded.status, discarded.out).toBe(0);
      const parked = JSON.parse(discarded.out);
      expect(parked).toMatchObject({ parked_repo: "api", parked_mode: "branch-tip" });
      expect(git(external, "rev-parse", "--verify", `${parked.parked_ref}/head`).stdout.trim()).toBe(head);
      expect(git(external, "rev-parse", "--verify", `${parked.parked_ref}/branch-tip`).stdout.trim()).toBe(head);
      expect(git(external, "show-ref", "--verify", "--quiet", `refs/heads/${boltName(fixtureIntentId8(proj), slug)}`).status).toBe(1);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out);
      expect(readFileSync(join(recovery.worktree_path, "saved.txt"), "utf-8")).toBe(savedBytes);
      expect(git(recovery.worktree_path, "rev-parse", "HEAD").stdout.trim()).toBe(head);
      expect(git(external, "worktree", "remove", "--force", recovery.worktree_path).status).toBe(0);
      const purged = runWorktree(proj, "purge", "--slug", slug);
      expect(purged.status, purged.out).toBe(0);
      expect(git(external, "for-each-ref", "--format=%(refname)", `${parked.parked_ref}/`).stdout).toBe("");
    }, 30_000);

    for (const matchingSlug of [true, false]) test(`discard-record-only linked recovery ${matchingSlug ? "admits the emitted slug" : "refuses a different recorded slug"}`, () => {
      const { proj, external } = setupRecordedSymlinkProject();
      const slug = "discard-record-only";
      const created = runWorktree(proj, "create", "--slug", slug, "--base", "main");
      expect(created.status, created.out).toBe(0);
      const savedBytes = Buffer.from([0, 255, 13, 10, 128]);
      writeFileSync(join(worktreeDir(proj, slug), "saved.txt"), savedBytes);
      const discarded = runWorktree(proj, "discard", "--slug", slug);
      expect(discarded.status, discarded.out).toBe(0);
      const parked = JSON.parse(discarded.out);
      expect(existsSync(worktreeDir(proj, slug))).toBe(false);

      // Keep the real discard row, but remove creation provenance as can happen
      // in partial cleanup or mixed-version audit history. Never synthesize Repo.
      const intents = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents");
      const record = readFileSync(join(intents, "active-intent"), "utf-8").trim();
      const auditDir = join(intents, record, "audit");
      for (const name of readdirSync(auditDir).filter((name) => name.endsWith(".md"))) {
        const path = join(auditDir, name);
        const blocks = readFileSync(path, "utf-8").split("\n---\n")
          .filter((block) => !block.includes("**Event**: WORKTREE_CREATED"))
          .map((block) => !matchingSlug && block.includes("**Event**: WORKTREE_DISCARDED")
            ? block.replace(`**Bolt slug**: ${slug}`, "**Bolt slug**: another-slug") : block);
        writeFileSync(path, blocks.join("\n---\n"));
      }

      const attempts = doctorAttempts(proj);
      if (!matchingSlug) {
        expect(attempts).toEqual([]);
        const before = git(external, "for-each-ref", "--format=%(refname)%09%(objectname)", `${parked.parked_ref}/`).stdout;
        for (const operation of ["restore", "purge"]) {
          const automatic = runWorktree(proj, operation, "--slug", slug);
          expect(automatic.status, automatic.out).toBe(1);
          expect(automatic.out).toContain(`no parked attempt for slug ${slug}`);
          const explicit = runWorktree(proj, operation, "--slug", slug, "--repo", "api");
          expect(explicit.status, explicit.out).toBe(1);
          expect(JSON.parse(explicit.out).error).toContain('"api" is a symlink, not a workspace repository');
        }
        expect(git(external, "for-each-ref", "--format=%(refname)%09%(objectname)", `${parked.parked_ref}/`).stdout).toBe(before);
        expect(git(external, "rev-parse", "--verify", `${parked.parked_ref}/head`).stdout.trim()).toBe(parked.parked_commit);
        expect(existsSync(join(proj, ".aidlc", "restored"))).toBe(false);
        return;
      }

      expect(attempts).toEqual([expect.objectContaining({
        slug, repo: "api", stamp: parked.parked_stamp, mode: "snapshot",
      })]);
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out);
      expect(readFileSync(join(recovery.worktree_path, "saved.txt"))).toEqual(savedBytes);
      expect(git(recovery.worktree_path, "rev-parse", "HEAD").stdout.trim()).toBe(parked.parked_commit);
      expect(git(external, "worktree", "remove", "--force", recovery.worktree_path).status).toBe(0);
      const purged = runRecoveryOperation(proj, attempts[0].purge_operation);
      expect(purged.status, purged.out).toBe(0);
      expect(git(external, "for-each-ref", "--format=%(refname)", `${parked.parked_ref}/`).stdout).toBe("");
      expect(doctorAttempts(proj)).toEqual([]);
      expect(readFileSync(join(external, "saved.txt"), "utf-8")).toBe("linked repository base\n");
    }, 30_000);

    test("purge --older-than preserves February 31 refs and reports skipped_unparseable", () => {
      const proj = setupLifecycleProject();
      const slug = "impossible-date";
      const stamp = "20260231T000000Z";
      const ref = `${parkedRefPrefix(fixtureIntentId8(proj), slug)}${stamp}/head`;
      gitInitMain(proj);
      const head = git(proj, "rev-parse", "HEAD").stdout.trim();
      expect(git(proj, "update-ref", ref, head).status).toBe(0);
      // R4(d): calendar validation applies only after this intent's discard provenance admits the stamp.
      recordParkedAttempt(proj, slug, ref.slice(0, -"/head".length));

      const purged = runWorktree(proj, "purge", "--slug", slug, "--older-than", "0");
      expect(purged.status, purged.out).toBe(0);
      expect(git(proj, "show-ref", "--verify", "--quiet", ref).status, purged.out).toBe(0);
      expect(git(proj, "rev-parse", "--verify", ref).stdout.trim()).toBe(head);
      expect(JSON.parse(purged.out)).toEqual({
        purged: 0, slug, stamps: [], skipped_unparseable: [stamp],
      });
    });

    test("purge --older-than deletes only old stamps, ignoring their collision suffix", () => {
      const proj = setupLifecycleProject();
      const slug = "aged-parks";
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const discarded = runWorktree(proj, "discard", "--slug", slug);
      expect(discarded.status, discarded.out).toBe(0);
      const { parked_ref: freshRef } = JSON.parse(discarded.out) as { parked_ref: string };
      const oldStamp = `${new Date(Date.now() - 40 * 86_400_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-2`;
      const oldRef = `${parkedRefPrefix(fixtureIntentId8(proj), slug)}${oldStamp}`;
      for (const marker of ["head", "snapshot"]) {
        expect(git(proj, "update-ref", `${oldRef}/${marker}`, `${freshRef}/${marker}`).status).toBe(0);
      }
      // R4(d): copied historical refs also need their own recorded discard attempt.
      recordParkedAttempt(proj, slug, oldRef);

      const purged = runWorktree(proj, "purge", "--slug", slug, "--older-than", "30");
      expect(purged.status, purged.out).toBe(0);
      expect(JSON.parse(purged.out)).toEqual({ purged: 2, slug, stamps: [oldStamp], skipped_unparseable: [] });
      expect(git(proj, "for-each-ref", "--format=%(refname)", `${oldRef}/`).stdout).toBe("");
      expect(git(proj, "for-each-ref", "--format=%(refname)", `${freshRef}/`).stdout.trim().split("\n")).toEqual([
        `${freshRef}/branch-tip`, `${freshRef}/head`, `${freshRef}/snapshot`,
      ]);
      const noOldParks = runWorktree(proj, "purge", "--slug", slug, "--older-than", "30");
      expect(noOldParks.status, noOldParks.out).toBe(0);
      expect(JSON.parse(noOldParks.out)).toEqual({ purged: 0, slug, stamps: [], skipped_unparseable: [] });
    });

    test("purge rejects conflicting selectors and invalid ages before deleting refs", () => {
      const proj = setupLifecycleProject();
      const slug = "invalid-age";
      gitInitMain(proj);
      const stamp = "20000101T000000Z";
      const ref = `${parkedRefPrefix(fixtureIntentId8(proj), slug)}${stamp}/head`;
      expect(git(proj, "update-ref", ref, "HEAD").status).toBe(0);
      for (const args of [
        ["--parked", stamp, "--older-than", "30"],
        ["--older-than", "-1"],
        ["--older-than", "NaN"],
        ["--older-than", "Infinity"],
        ["--older-than", ""],
      ]) {
        const refused = runWorktree(proj, "purge", "--slug", slug, ...args);
        expect(refused.status, refused.out).toBe(1);
        expect(refused.out).toContain("--older-than");
        expect(git(proj, "show-ref", "--verify", "--quiet", ref).status).toBe(0);
      }
    });

    test("purge refuses misspelled and duplicate flags without deleting any refs", () => {
      const proj = setupLifecycleProject();
      const slug = "invalid-flags";
      gitInitMain(proj);
      for (const stamp of ["20000101T000000Z", "20990101T000000Z"]) {
        for (const mode of ["head", "snapshot"]) {
          expect(git(proj, "update-ref", `${parkedRefPrefix(fixtureIntentId8(proj), slug)}${stamp}/${mode}`, "HEAD").status).toBe(0);
        }
      }
      const before = git(proj, "for-each-ref", "--format=%(refname)%09%(objectname)", parkedRefPrefix(fixtureIntentId8(proj), slug)).stdout;
      for (const [args, message] of [
        [["--older-thn", "30"], "Unknown flag --older-thn. Valid flags: --slug, --parked, --older-than"],
        [["--older-than", "30", "--older-than", "0"], "Duplicate flag --older-than"],
        [["--project-dir", proj], "Duplicate flag --project-dir"],
      ] as const) {
        const refused = runWorktree(proj, "purge", "--slug", slug, ...args);
        expect(git(proj, "for-each-ref", "--format=%(refname)%09%(objectname)", parkedRefPrefix(fixtureIntentId8(proj), slug)).stdout, refused.out).toBe(before);
        expect(refused.status, refused.out).toBe(1);
        expect(refused.out).toContain(message);
      }
    });

    test("restore rejects unknown and repeated boolean flags before resolving a park", () => {
      const proj = setupLifecycleProject();
      gitInitMain(proj);
      for (const [args, message] of [
        [["--raww"], "Unknown flag --raww"],
        [["--raw", "--raw"], "Duplicate flag --raw"],
      ] as const) {
        const refused = runWorktree(proj, "restore", "--slug", "absent", ...args);
        expect(refused.status, refused.out).toBe(1);
        expect(refused.out).toContain(message);
      }
      expect(existsSync(join(proj, ".aidlc", "restored"))).toBe(false);
    });

    test("an exact parked stamp selects its repository before slug ambiguity", () => {
      const proj = setupLifecycleProject();
      gitInitMain(proj);
      const sibling = join(proj, "api");
      mkdirSync(sibling);
      gitInitMain(sibling);
      const slug = "exact-repository";
      for (const [cwd, stamp] of [[proj, "20260101T000000Z"], [sibling, "20260201T000000Z"]]) {
        expect(git(cwd, "update-ref", `${parkedRefPrefix(fixtureIntentId8(proj), slug)}${stamp}/head`, "HEAD").status).toBe(0);
        // R4(d): stamp ownership and repository selection are independent checks.
        recordParkedAttempt(proj, slug, `${parkedRefPrefix(fixtureIntentId8(proj), slug)}${stamp}`, cwd === proj ? null : "api");
      }
      const restored = runWorktree(proj, "restore", "--slug", slug, "--parked", "20260101T000000Z");
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out);
      expect(git(recovery.worktree_path, "rev-parse", "HEAD").stdout).toBe(git(proj, "rev-parse", "HEAD").stdout);
      const purged = runWorktree(proj, "purge", "--slug", slug, "--parked", "20260201T000000Z");
      expect(purged.status, purged.out).toBe(0);
      expect(git(sibling, "for-each-ref", "--format=%(refname)", parkedRefPrefix(fixtureIntentId8(proj), slug)).stdout).toBe("");
      expect(git(proj, "show-ref", "--verify", "--quiet", `${recovery.parked_ref}/head`).status).toBe(0);
    });

    test("recovery ignores and refuses unrecorded symlinked sibling repositories", () => {
      const proj = setupLifecycleProject();
      const external = setupLifecycleProject();
      gitInitMain(proj);
      gitInitMain(external);
      symlinkSync(external, join(proj, "outside"), "junction");
      const slug = "external-park";
      const ref = `${parkedRefPrefix(fixtureIntentId8(proj), slug)}20260101T000000Z/head`;
      expect(git(external, "update-ref", ref, "HEAD").status).toBe(0);
      expect(doctorAttempts(proj)).toEqual([]);
      for (const operation of ["restore", "purge"]) {
        const explicit = runWorktree(proj, operation, "--slug", slug, "--repo", "outside");
        expect(explicit.status, explicit.out).toBe(1);
        expect(JSON.parse(explicit.out).error).toContain('"outside" is a symlink, not a workspace repository');
        const automatic = runWorktree(proj, operation, "--slug", slug);
        expect(automatic.status, automatic.out).toBe(1);
        expect(automatic.out).toContain(`no parked attempt for slug ${slug}`);
      }
      expect(git(external, "show-ref", "--verify", "--quiet", ref).status).toBe(0);
      expect(existsSync(join(proj, ".aidlc", "restored"))).toBe(false);
    });

    test("restore and purge select historical root or sibling parks independently of the active intent", () => {
      const proj = setupLifecycleProject();
      const slug = "shared-history";
      const stamp = "20260101T120000Z";
      const historicalRecord = "historical-00000002";
      const historicalIntents = join(proj, "aidlc", "spaces", "history", "intents");
      mkdirSync(join(historicalIntents, historicalRecord), { recursive: true });
      writeFileSync(join(historicalIntents, "intents.json"), JSON.stringify([
        { uuid: "00000000-0000-7000-8000-000000000002", slug: "historical", dirName: historicalRecord, status: "archived" },
      ]));
      cpSync(join(FIXTURES_DIR, "state-construction.md"), join(historicalIntents, historicalRecord, "aidlc-state.md"));
      const selection = ["--intent", historicalRecord, "--space", "history"];
      const ref = `${parkedRefPrefix(fixtureIntentId8(proj, historicalRecord, "history"), slug)}${stamp}/head`;
      writeFileSync(join(proj, "saved.txt"), "root attempt\n");
      gitInitMain(proj);
      const sibling = join(proj, "historical");
      mkdirSync(sibling);
      writeFileSync(join(sibling, "saved.txt"), "sibling attempt\n");
      gitInitMain(sibling);
      for (const cwd of [proj, sibling]) expect(git(cwd, "update-ref", ref, "HEAD").status).toBe(0);
      // R4(d): selecting a historical intent admits only the stamps its own discard audit records.
      for (const repo of [null, "historical"]) {
        recordParkedAttempt(proj, slug, ref.slice(0, -"/head".length), repo, historicalRecord, "history");
      }
      const rosterPath = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents", "intents.json");
      const roster = JSON.parse(readFileSync(rosterPath, "utf-8"));
      roster[0].repos = ["current"];
      writeFileSync(rosterPath, JSON.stringify(roster));

      for (const operation of ["restore", "purge"]) {
        const unselected = runWorktree(proj, operation, "--slug", slug);
        expect(unselected.status, unselected.out).toBe(1);
        expect(unselected.out).toContain(`no parked attempt for slug ${slug}`);
        const ambiguous = runWorktree(proj, operation, "--slug", slug, ...selection);
        expect(ambiguous.status, ambiguous.out).toBe(1);
        expect(ambiguous.out).toContain("several repositories");
      }
      for (const [selector, cwd, bytes] of [
        [".", proj, "root attempt\n"], ["historical", sibling, "sibling attempt\n"],
      ]) {
        const restored = runWorktree(proj, "restore", "--slug", slug, "--parked", stamp, "--repo", selector, ...selection);
        expect(restored.status, restored.out).toBe(0);
        const { worktree_path: path } = JSON.parse(restored.out) as { worktree_path: string };
        expect(readFileSync(join(path, "saved.txt"), "utf-8")).toBe(bytes);
        expect(git(cwd, "worktree", "remove", "--force", path).status).toBe(0);
        const purged = runWorktree(proj, "purge", "--slug", slug, "--parked", stamp, "--repo", selector, ...selection);
        expect(purged.status, purged.out).toBe(0);
        expect(JSON.parse(purged.out)).toEqual({ purged: 1, slug, stamps: [stamp], skipped_unparseable: [] });
        expect(git(cwd, "show-ref", "--verify", "--quiet", ref).status).toBe(1);
      }
    }, 30_000);

    for (const event of ["WORKTREE_CREATED", "WORKTREE_DISCARDED"]) test(`intent-only linked repos require a same-slug ${event} Repo audit row`, () => {
      const proj = setupLifecycleProject();
      const external = createTestProject();
      tempDirs.push(external);
      const savedBytes = "historical linked source\n";
      writeFileSync(join(external, "saved.txt"), savedBytes);
      gitInitMain(external);
      symlinkSync(external, join(proj, "historical"), "junction");
      const slug = "intent-record-only";
      const stamp = "20240101T000000Z";
      const historicalRecord = "historical-00000002";
      const historicalIntents = join(proj, "aidlc", "spaces", "history", "intents");
      const historicalAudit = join(historicalIntents, historicalRecord, "audit");
      mkdirSync(historicalAudit, { recursive: true });
      writeFileSync(join(historicalIntents, "intents.json"), JSON.stringify([
        { uuid: "00000000-0000-7000-8000-000000000002", slug: "historical", dirName: historicalRecord, status: "archived", repos: ["historical"] },
      ]));
      cpSync(join(FIXTURES_DIR, "state-construction.md"), join(historicalIntents, historicalRecord, "aidlc-state.md"));
      const historicalId8 = fixtureIntentId8(proj, historicalRecord, "history");
      const selection = ["--intent", historicalRecord, "--space", "history"];
      const prefix = `${parkedRefPrefix(historicalId8, slug)}${stamp}`;
      const unrelatedSlug = "unrecorded-linked-attempt";
      const unrelatedRef = `${parkedRefPrefix(historicalId8, unrelatedSlug)}${stamp}/head`;
      expect(git(external, "update-ref", unrelatedRef, "HEAD").status).toBe(0);
      for (const leaf of ["head", "snapshot"]) {
        expect(git(external, "update-ref", `${prefix}/${leaf}`, "HEAD").status).toBe(0);
      }
      const currentRoster = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents", "intents.json");
      const roster = JSON.parse(readFileSync(currentRoster, "utf-8"));
      // The shard locates the historical intent; only its registry records the repo.
      writeFileSync(join(historicalAudit, "history.md"), [
        "## Worktree Discarded", "**Timestamp**: 2024-01-01T00:00:00Z", "**Event**: WORKTREE_DISCARDED",
        `**Bolt slug**: ${slug}`, `**Parked ref**: ${prefix}`, "\n---\n",
      ].join("\n"));
      roster[0].repos = ["current"];
      writeFileSync(currentRoster, JSON.stringify(roster));

      // A registry's intent-level repo set is not per-attempt authority for a symlink.
      expect(doctorAttempts(proj)).toEqual([]);
      for (const operation of ["restore", "purge"]) {
        const explicit = runWorktree(proj, operation, "--slug", slug, "--repo", "historical", ...selection);
        expect(explicit.status, explicit.out).toBe(1);
        expect(JSON.parse(explicit.out).error).toContain('"historical" is a symlink, not a workspace repository');
        const automatic = runWorktree(proj, operation, "--slug", slug, ...selection);
        expect(automatic.status, automatic.out).toBe(1);
        expect(automatic.out).toContain(`no parked attempt for slug ${slug}`);
      }
      expect(git(external, "show-ref", "--verify", "--quiet", `${prefix}/head`).status).toBe(0);
      expect(existsSync(join(proj, ".aidlc", "restored"))).toBe(false);

      writeFileSync(join(historicalAudit, "history.md"), [
        // R4(d): creation may locate a repo, but only discard provenance authorizes its parked stamp.
        ...(event === "WORKTREE_CREATED" ? [
          "## Worktree Discarded", "**Timestamp**: 2024-01-01T00:00:00Z", "**Event**: WORKTREE_DISCARDED",
          `**Bolt slug**: ${slug}`, `**Parked ref**: ${prefix}`, "\n---\n",
        ] : []),
        "## Recorded Worktree", "**Timestamp**: 2024-01-01T00:00:00Z", `**Event**: ${event}`,
        `**Bolt slug**: ${slug}`, "**Repo**: historical", `**Parked ref**: ${prefix}`, "\n---\n",
      ].join("\n"));
      const attempts = doctorAttempts(proj);
      expect(attempts).toEqual([expect.objectContaining({ slug, stamp, repo: "historical" })]);
      // The admitted slug must not authorize every parked attempt in the linked repo.
      for (const operation of ["restore", "purge"]) {
        const explicit = runWorktree(proj, operation, "--slug", unrelatedSlug, "--repo", "historical", ...selection);
        expect(explicit.status, explicit.out).toBe(1);
        expect(JSON.parse(explicit.out).error).toContain('"historical" is a symlink, not a workspace repository');
        const automatic = runWorktree(proj, operation, "--slug", unrelatedSlug, ...selection);
        expect(automatic.status, automatic.out).toBe(1);
        expect(automatic.out).toContain(`no parked attempt for slug ${unrelatedSlug}`);
      }
      expect(git(external, "show-ref", "--verify", "--quiet", unrelatedRef).status).toBe(0);
      expect(attempts[0].restore_operation).toEqual({
        route: "worktree", args: ["restore", "--slug", slug, "--parked", stamp, "--repo", "historical", ...selection],
      });
      expect(attempts[0].purge_operation).toEqual({
        route: "worktree", args: ["purge", "--slug", slug, "--parked", stamp, "--repo", "historical", ...selection],
      });
      expect(attempts[0].restore_command).toBe(renderEngineInvocation(attempts[0].restore_operation!));
      const restored = runRecoveryOperation(proj, attempts[0].restore_operation!);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out);
      expect(readFileSync(join(recovery.worktree_path, "saved.txt"), "utf-8")).toBe(savedBytes);
      expect(git(external, "worktree", "remove", "--force", recovery.worktree_path).status).toBe(0);
      expect(attempts[0].purge_command).toBe(renderEngineInvocation(attempts[0].purge_operation));
      const purged = runRecoveryOperation(proj, attempts[0].purge_operation);
      expect(purged.status, purged.out).toBe(0);
      expect(git(external, "for-each-ref", "--format=%(refname)", `${prefix}/`).stdout).toBe("");
      expect(doctorAttempts(proj)).toEqual([]);
      expect(git(external, "show-ref", "--verify", "--quiet", unrelatedRef).status).toBe(0);
    }, 30_000);

    test("recovery refuses missing or non-repository sibling selectors and live operations reject the root selector", () => {
      const proj = setupLifecycleProject();
      gitInitMain(proj);
      mkdirSync(join(proj, "ordinary"));
      const ref = `${parkedRefPrefix(fixtureIntentId8(proj), "missing")}20000101T000000Z/head`;
      expect(git(proj, "update-ref", ref, "HEAD").status).toBe(0);
      for (const operation of ["restore", "purge"]) {
        for (const repo of ["missing", "ordinary", "../outside"]) {
          const refused = runWorktree(proj, operation, "--slug", "missing", "--repo", repo);
          expect(refused.status, refused.out).toBe(1);
          expect(git(proj, "show-ref", "--verify", "--quiet", ref).status).toBe(0);
        }
      }
      for (const operation of ["create", "discard"]) {
        const refused = runWorktree(proj, operation, "--slug", "missing", "--base", "main", "--repo", ".");
        expect(refused.status, refused.out).toBe(1);
        expect(git(proj, "show-ref", "--verify", "--quiet", ref).status).toBe(0);
      }
    });

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
        // R4(d): remove both modern discriminator refs to model a pre-upgrade snapshot.
        expect(git(proj, "update-ref", "-d", `${parkedRef}/branch-tip`).status).toBe(0);
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

    // These raw 0xff filename fixtures are Linux-only: macOS CI rejects
    // filename creation with EILSEQ before discard or restore can run.
    test.skipIf(process.platform !== "linux")("discard refuses a filtered non-UTF-8 filename before removing the live attempt", () => {
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
      expect(aborted.out).toContain("content-transforming attribute (filter=lossy)");
      expect(aborted.out).toContain("rename the file or unset its filter attribute");
      expect(existsSync(wt)).toBe(true);
      expect(git(proj, "rev-parse", "--verify", `refs/heads/${boltName(fixtureIntentId8(proj), slug)}`).stdout.trim()).toBe(head);
      expect(readFileSync(path)).toEqual(dirtyBytes);
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toBe("");
      expect(eventBlock(proj, "BOLT_FAILED")).toBe("");
    });

    test.skipIf(process.platform !== "linux")("discard refuses an ident-only non-UTF-8 filename before removing the live attempt", () => {
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
      expect(aborted.out).toContain("content-transforming attribute (ident=set)");
      expect(aborted.out).toContain("rename the file or unset its ident attribute");
      expect(existsSync(wt)).toBe(true);
      expect(git(proj, "rev-parse", "--verify", `refs/heads/${boltName(fixtureIntentId8(proj), slug)}`).stdout.trim()).toBe(head);
      expect(readFileSync(path)).toEqual(dirtyBytes);
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toBe("");
      expect(eventBlock(proj, "BOLT_FAILED")).toBe("");
    });

    for (const [attribute, value] of [["text", "auto"], ["eol", "lf"]] as const) {
      test.skipIf(process.platform !== "linux")(`discard identifies ${attribute} on a non-UTF-8 filename without removing the live attempt`, () => {
        const proj = setupLifecycleProject();
        const slug = `non-utf8-${attribute}`;
        const wt = worktreeDir(proj, slug);
        const name = Buffer.concat([Buffer.from("notes-"), Buffer.from([0xff]), Buffer.from(".txt")]);
        writeFileSync(join(proj, ".gitattributes"), `*.txt ${attribute}=${value}\n`);
        gitInitMain(proj);
        const created = runWorktree(proj, "create", "--slug", slug, "--base", "main");
        expect(created.status, created.out).toBe(0);
        const head = git(wt, "rev-parse", "HEAD").stdout.trim();
        const path = Buffer.concat([Buffer.from(`${wt}/`), name]);
        const dirtyBytes = Buffer.from("line endings must survive\r\n");
        writeFileSync(path, dirtyBytes);

        const aborted = runBolt(
          proj, "abort", "--name", "Non-UTF-8 Line Endings Bolt", "--slug", slug,
          "--reason", "refuse to normalize the saved bytes", "--discard",
        );
        expect(aborted.status, aborted.out).toBe(1);
        expect(aborted.out).toContain(`content-transforming attribute (${attribute}=${value})`);
        expect(aborted.out).toContain(`rename the file or unset its ${attribute} attribute`);
        expect(existsSync(wt)).toBe(true);
        expect(git(proj, "rev-parse", "--verify", `refs/heads/${boltName(fixtureIntentId8(proj), slug)}`).stdout.trim()).toBe(head);
        expect(readFileSync(path)).toEqual(dirtyBytes);
        expect(eventBlock(proj, "WORKTREE_DISCARDED")).toBe("");
        expect(eventBlock(proj, "BOLT_FAILED")).toBe("");
      });
    }

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

    // Requires Linux byte-oriented filenames, like the discard fixtures above.
    test.skipIf(process.platform !== "linux")("restore preserves a dirty tracked non-UTF-8 filename byte-exactly", () => {
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
      // UTF-8 names keep the listing above one MiB with fewer files: each name
      // is 222 bytes, but only 78 UTF-16 code units on Windows (and <255 bytes).
      const fileCount = 4_000;
      const nameFor = (i: number): string => `${String(i).padStart(5, "0")}-${"界".repeat(72)}`;
      const bytes = Buffer.from([0, 0xff, 10, 0x80]);
      if (process.platform === "win32") {
        expect(join(wt, nameFor(fileCount - 1)).length).toBeLessThan(260);
      }
      // Build all entries from one blob, then let Git materialize the fixture
      // in one checkout. The real abort/discard and raw restore still run below.
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: wt, input: bytes, encoding: "utf-8",
      });
      expect(blob.status, blob.stderr).toBe(0);
      const oid = blob.stdout.trim();
      const entries = Array.from({ length: fileCount }, (_, i) =>
        `100644 ${oid}\t${nameFor(i)}\0`).join("");
      const indexed = spawnSync("git", ["update-index", "-z", "--index-info"], {
        cwd: wt, input: entries, encoding: "utf-8",
      });
      expect(indexed.status, indexed.stderr).toBe(0);
      expect(git(wt, "checkout-index", "--all", "--force").status).toBe(0);
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
      if (process.platform === "win32") {
        const stamp = (JSON.parse(aborted.out).parked_ref as string).split("/").at(-1)!;
        const restoredRoot = join(proj, ".aidlc", "restored", `${boltName(fixtureIntentId8(proj), slug)}-${stamp}`);
        expect(join(restoredRoot, nameFor(fileCount - 1)).length).toBeLessThan(260);
      }
      const restored = runWorktree(proj, "restore", "--slug", slug);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out) as { worktree_path: string; materialized: number };
      expect(JSON.parse(restored.out).raw_bytes).toBe(true);
      expect(recovery.materialized).toBe(parkedFileCount);
      expect(readFileSync(join(recovery.worktree_path, nameFor(fileCount - 1)))).toEqual(bytes);
    }, 180_000);

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
      expect(git(proj, "rev-parse", "--verify", `refs/heads/${boltName(fixtureIntentId8(proj), slug)}`).stdout.trim()).toBe(head);
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
      const reviewedRef = `${reviewedSourceRefPrefix(fixtureIntentId8(proj), slug)}${head}`;
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
        expect(git(proj, "rev-parse", "--verify", `refs/heads/${boltName(fixtureIntentId8(proj), slug)}`).stdout.trim()).toBe(head);
        expect(git(proj, "rev-parse", "--verify", reviewedRef).stdout.trim()).toBe(head);
        expect(git(wt, "rev-parse", "HEAD").stdout.trim()).toBe(head);
        expect(readFileSync(join(wt, "untracked.bin"))).toEqual(Buffer.from([0, 255, 10]));
      } finally {
        expect(git(proj, "update-ref", "-d", "refs/aidlc/parked").status).toBe(0);
      }
    });

    test("abort branch-tip recovery hint restores an unmerged tip after worktree removal", () => {
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
      expect(existsSync(wt)).toBe(false);
      const aborted = runBolt(
        proj, "abort", "--name", "Branch Tip Hint", "--slug", slug,
        "--reason", "recover the remaining branch", "--discard",
      );
      expect(aborted.status, aborted.out).toBe(0);
      const parked = JSON.parse(aborted.out);
      const stamp = parked.parked_ref.split("/").at(-1);
      expect(git(proj, "rev-parse", "--verify", `${parked.parked_ref}/head`).stdout.trim()).toBe(head);
      expect(git(proj, "rev-parse", "--verify", `${parked.parked_ref}/branch-tip`).stdout.trim()).toBe(head);
      expect(git(proj, "show-ref", "--verify", "--quiet", `refs/heads/${boltName(fixtureIntentId8(proj), slug)}`).status).toBe(1);
      expect(parked.restore_hint).toBe(renderEngineInvocation(parked.restore_operation));
      const restored = runRecoveryOperation(proj, parked.restore_operation);
      expect(restored.status, restored.out).toBe(0);
      const recovery = JSON.parse(restored.out) as { worktree_path: string; reviewed_source_refs: number };
      expect(JSON.parse(restored.out).raw_bytes).toBe(false);
      expect(JSON.parse(restored.out).restore_mode).toBe("branch-tip");
      expect(recovery.reviewed_source_refs).toBe(0);
      expect(git(recovery.worktree_path, "rev-parse", "HEAD").stdout.trim()).toBe(head);
      expect(readFileSync(join(recovery.worktree_path, "committed.txt"), "utf-8")).toBe("survives checkout removal\n");
      expect(parked.parked_excludes).toEqual(["uncommitted files (no working tree existed)"]);
      expect(parked).toMatchObject({
        parked_stamp: stamp,
        parked_mode: "branch-tip",
        parked_repo: null,
      });
      expect(git(proj, "worktree", "remove", "--force", recovery.worktree_path).status).toBe(0);
      const purged = runWorktree(proj, "purge", "--slug", slug);
      expect(purged.status, purged.out).toBe(0);
      expect(JSON.parse(purged.out)).toEqual({ purged: 2, slug, stamps: [parked.parked_ref.split("/").at(-1)!], skipped_unparseable: [] });
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
      const restoredPath = join(proj, ".aidlc", "restored", `${boltName(fixtureIntentId8(proj), slug)}-${stamp}`);
      git(proj, "worktree", "remove", "--force", restoredPath);
      rmSync(restoredPath, { recursive: true, force: true });
      expect(git(proj, "worktree", "prune").status).toBe(0);
      expect(git(proj, "branch", "-D", `restore/${boltName(fixtureIntentId8(proj), slug)}-${stamp}`).status).toBe(0);
      const rawRestore = runWorktree(proj, "restore", "--slug", slug, "--raw");
      expect(rawRestore.status, rawRestore.out).toBe(0);
      const recovery = JSON.parse(rawRestore.out) as { worktree_path: string; raw_bytes: boolean };
      expect(readFileSync(join(recovery.worktree_path, "notes.broken"), "utf-8")).toBe(committedBytes);
      expect(recovery.raw_bytes).toBe(true);
    });

    for (const operation of ["discard", "abort"]) test(`reviewed-only ${operation} keeps evidence without advertising restorable files`, () => {
      const proj = setupLifecycleProject();
      const slug = "reviewed-only";
      gitInitMain(proj);
      expect(runWorktree(proj, "create", "--slug", slug, "--base", "main").status).toBe(0);
      const head = git(proj, "rev-parse", "HEAD").stdout.trim();
      const reviewedRef = `${reviewedSourceRefPrefix(fixtureIntentId8(proj), slug)}${head}`;
      expect(git(proj, "update-ref", reviewedRef, head).status).toBe(0);
      expect(git(proj, "worktree", "remove", "--force", worktreeDir(proj, slug)).status).toBe(0);
      expect(git(proj, "branch", "-D", boltName(fixtureIntentId8(proj), slug)).status).toBe(0);
      const discarded = operation === "abort"
        ? runBolt(proj, "abort", "--name", "Reviewed Only", "--slug", slug, "--reason", "set aside review evidence", "--discard")
        : runWorktree(proj, "discard", "--slug", slug);
      expect(discarded.status, discarded.out).toBe(0);
      const parked = JSON.parse(discarded.out);
      expect(parked).not.toHaveProperty("restore_hint");
      expect(parked).not.toHaveProperty("restore_operation");
      expect(parked).not.toHaveProperty("parked_excludes");
      expect(parked).toMatchObject({ parked_mode: "evidence-only", parked_repo: null,
        parked_stamp: parked.parked_ref.split("/").at(-1) });
      if (operation === "discard") expect(parked.parked_commit).toBe("-");
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toContain(`**Parked ref**: ${parked.parked_ref}`);
      expect(eventBlock(proj, "WORKTREE_DISCARDED")).toContain("**Parked commit**: -");
      expect(git(proj, "rev-parse", "--verify", `${parked.parked_ref}/reviewed-source/${head}`).stdout.trim()).toBe(head);
      expect(git(proj, "show-ref", "--verify", "--quiet", reviewedRef).status).toBe(1);
      expect(git(proj, "show-ref", "--verify", "--quiet", `${parked.parked_ref}/head`).status).toBe(1);
      for (const selector of [[], ["--parked", parked.parked_stamp]]) {
        const restored = runWorktree(proj, "restore", "--slug", slug, ...selector);
        expect(restored.status, restored.out).toBe(1);
        expect(restored.out).toContain(`no restorable files were parked for ${slug} ${parked.parked_stamp}; only review evidence was kept`);
      }
      const purged = runWorktree(proj, "purge", "--slug", slug);
      expect(purged.status).toBe(0);
      expect(JSON.parse(purged.out)).toEqual({
        purged: 1,
        slug,
        stamps: [parked.parked_ref.split("/").at(-1)],
        skipped_unparseable: [],
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
      const olderRef = `${parkedRefPrefix(fixtureIntentId8(proj), slug)}${olderStamp}`;
      const newerRef = `${parkedRefPrefix(fixtureIntentId8(proj), slug)}${newerStamp}`;
      expect(git(proj, "update-ref", `${olderRef}/head`, olderCommit).status).toBe(0);
      expect(git(proj, "update-ref", `${newerRef}/head`, newerCommit).status).toBe(0);
      // R4(d): both synthetic attempts belong to the selected intent before numeric ordering is considered.
      recordParkedAttempt(proj, slug, olderRef);
      recordParkedAttempt(proj, slug, newerRef);

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
      expect(JSON.parse(purged.out)).toEqual({ purged: 1, slug, stamps: [olderStamp], skipped_unparseable: [] });
      expect(git(proj, "show-ref", "--verify", "--quiet", `${olderRef}/head`).status).toBe(1);
      expect(git(proj, "rev-parse", "--verify", `${newerRef}/head`).stdout.trim()).toBe(newerCommit);
      expect(readFileSync(join(latestRecovery.worktree_path, "latest.txt"), "utf-8")).toBe("numeric suffix ten\n");
    });

    test("cleanup-only discard and purge refuse foreign ownership without touching another intent's same-slug Bolt", () => {
      const proj = setupLifecycleProject();
      const external = setupLifecycleProject();
      const checkoutB = join(external, "checkout-b");
      const ownerA = join(external, "relocated-a");
      const slug = "api";
      gitInitMain(proj);
      expect(git(proj, "worktree", "add", "-b", "intent-b-checkout", checkoutB, "main").status).toBe(0);
      const createdB = spawnSync(process.execPath, [
        join(AIDLC_SRC, "tools", "aidlc-utility.ts"), "intent-create",
        "--scope", "feature", "--label", "second-intent", "--project-dir", checkoutB,
      ], { cwd: checkoutB, encoding: "utf-8" });
      expect(createdB.status, `${createdB.stdout ?? ""}${createdB.stderr ?? ""}`).toBe(0);
      const idA = fixtureIntentId8(proj);
      const idB = fixtureIntentId8(checkoutB);
      expect(idB).not.toBe(idA);
      const branchA = boltName(idA, slug);
      const branchB = boltName(idB, slug);
      const wtA = worktreePath(proj, idA, slug);
      const wtB = worktreePath(checkoutB, idB, slug);
      for (const checkout of [proj, checkoutB]) {
        const result = runWorktree(checkout, "create", "--slug", slug, "--base", "main");
        expect(result.status, result.out).toBe(0);
      }
      const headA = git(wtA, "rev-parse", "HEAD").stdout.trim();
      const headB = git(wtB, "rev-parse", "HEAD").stdout.trim();
      const retainedA = `${reviewedSourceRefPrefix(idA, slug)}${headA}`;
      const retainedB = `${reviewedSourceRefPrefix(idB, slug)}${headB}`;
      const parkedA = `${parkedRefPrefix(idA, slug)}20260101T120000Z/head`;
      const parkedB = `${parkedRefPrefix(idB, slug)}20260101T120000Z/head`;
      for (const [ref, head] of [[retainedA, headA], [retainedB, headB], [parkedA, headA], [parkedB, headB]]) {
        expect(git(proj, "update-ref", ref!, head!).status).toBe(0);
      }
      // R4(d): admitted parks must still enforce the live Bolt's foreign-checkout protection.
      recordParkedAttempt(proj, slug, parkedA.slice(0, -"/head".length));
      writeFileSync(join(wtA, "owner.txt"), "A must survive\n");
      writeFileSync(join(wtB, "owner.txt"), "B must survive\n");
      expect(git(proj, "worktree", "move", wtA, ownerA).status).toBe(0);
      expect(existsSync(wtA)).toBe(false);
      const refsBefore = git(proj, "for-each-ref", "--format=%(refname) %(objectname)", "refs/aidlc/", `refs/heads/${branchA}`, `refs/heads/${branchB}`).stdout;
      const statusA = git(ownerA, "status", "--porcelain").stdout;
      const statusB = git(wtB, "status", "--porcelain").stdout;
      const discardBefore = eventBlock(proj, "WORKTREE_DISCARDED");
      for (const verb of ["discard", "purge"]) {
        const refused = spawnSync(process.execPath, [WT_TOOL, verb, "--slug", slug, "--project-dir", proj], {
          cwd: proj, encoding: "utf-8",
        });
        expect(refused.status).not.toBe(0);
        expect(JSON.parse(refused.stderr).error.replaceAll("\\", "/")).toContain(ownerA.replaceAll("\\", "/"));
        expect(readMainAudit(proj)).toContain("(checked out in another worktree of this repository)");
        expect(eventBlock(proj, "WORKTREE_DISCARDED")).toBe(discardBefore);
        expect(git(proj, "for-each-ref", "--format=%(refname) %(objectname)", "refs/aidlc/", `refs/heads/${branchA}`, `refs/heads/${branchB}`).stdout).toBe(refsBefore);
        expect(git(ownerA, "status", "--porcelain").stdout).toBe(statusA);
        expect(git(wtB, "status", "--porcelain").stdout).toBe(statusB);
        expect(git(ownerA, "symbolic-ref", "--short", "HEAD").stdout.trim()).toBe(branchA);
        expect(git(wtB, "symbolic-ref", "--short", "HEAD").stdout.trim()).toBe(branchB);
        expect(readFileSync(join(ownerA, "owner.txt"), "utf-8")).toBe("A must survive\n");
        expect(readFileSync(join(wtB, "owner.txt"), "utf-8")).toBe("B must survive\n");
      }
    }, 60000);
  });
});
