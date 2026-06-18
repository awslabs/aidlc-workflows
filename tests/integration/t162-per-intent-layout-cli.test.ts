// covers: cli:aidlc-bolt(start-worktree,complete-merge), cli:aidlc-state(fork), cli:aidlc-audit(audit-fork,audit-merge), function:auditShardName, function:recordDir, function:relativeRecordDir
//
// t162 — Integration: drive REAL tools against a PER-INTENT (new-layout) project
// and prove the threaded space+intent selector actually re-roots writes/reads to
// aidlc/spaces/<sp>/intents/<slug>-<id8>/ — NOT the flat aidlc-docs/ fallback.
//
// WHY THIS TEST EXISTS (the test-integrity coverage gap, itself a review MAJOR):
// when first written, NO CLI-driven test seeded a per-intent layout — the
// per-intent threading (commit 8306892) was exercised by resolver UNIT tests only
// (t160/t161 call the resolvers directly, never spawning a tool). A threading
// regression — a caller dropping the intent arg, or auditFilePath resolving the
// wrong record when an intent is active — would pass the whole suite. This test
// puts a real tool in front of a per-intent layout so such a regression FAILS
// here. (P9 has since migrated the whole fixture corpus to the per-intent layout
// and retired the transitional flat fallback entirely.)
//
// It is also the regression test for the Stage-B BLOCKER: audit-fork (PID A) and
// audit-merge (PID B) ran as SEPARATE processes whose per-PID shard name
// (<host>-<pid>.md) diverged → merge re-resolved a different shard → existsSync
// fail → "main audit not found ... run --init first" → every Bolt merge failed on
// a new-layout project. The fix makes the shard identity PER-CLONE (a stable
// gitignored aidlc/.aidlc-clone-id token), so both PIDs resolve ONE shard. Case
// "bolt fork+merge round-trips" drives that real two-process fork→merge and
// asserts it succeeds. Against the pre-fix code it FAILS at complete --merge.
//
// Mechanism: cli. Full real-tool flow (git worktree + aidlc-worktree + aidlc-bolt
// + aidlc-state + aidlc-audit as spawned subprocesses), asserting on the on-disk
// per-intent record paths and process exit codes. cwd contract mirrors t49: every
// worktree/bolt spawn runs with `cwd: proj` (assertNotSiblingWorktree checks CWD).

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIDLC_SRC, FIXTURES_DIR } from "../harness/fixtures.ts";
import { auditLockDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

const BUN = process.execPath;
const WORKTREE_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const BOLT_TOOL = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const STATE_TOOL = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const AUDIT_TOOL = join(AIDLC_SRC, "tools", "aidlc-audit.ts");

const tempProjects: string[] = [];

afterAll(() => {
  for (const p of tempProjects) {
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
        spawnSync("git", ["-C", p, "worktree", "remove", "--force", wt], { encoding: "utf-8" });
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
  out: string;
}

/** Spawn a tool against `proj` FROM `proj` (cwd contract — see header). */
function runIn(proj: string, tool: string, args: string[]): Run {
  const res = spawnSync(BUN, [tool, "--project-dir", proj, ...args], {
    cwd: proj,
    encoding: "utf-8",
    env: process.env,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { status: res.status ?? -1, stdout, stderr, out: `${stdout}${stderr}` };
}

const DEFAULT_SPACE = "default";

/** Absolute per-intent record dir for a seeded intent. */
function recordPath(proj: string, recordDir: string): string {
  return join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents", recordDir);
}

/** The audit/ shard dir for an intent; [] when absent. */
function shardNames(proj: string, recordDir: string): string[] {
  const dir = join(recordPath(proj, recordDir), "audit");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
}

/** Concatenate every audit shard of an intent (mirrors readAllAuditShards). */
function readShards(proj: string, recordDir: string): string {
  const dir = join(recordPath(proj, recordDir), "audit");
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
}

/**
 * Build a git-init'd project seeded with the NEW (per-intent) layout — NOT flat
 * aidlc-docs/. Seeds: aidlc/active-space cursor, two intent records under
 * spaces/default/intents/<record>/aidlc-state.md (construction-stage state), an
 * intents.json registry, and the active-intent cursor pointing at recordA. The
 * record state + intents.json are COMMITTED so the git worktree (branched from
 * main) carries them; the active-intent + audit shards stay gitignored (so the
 * worktree intentionally lacks the cursor — exactly the divergence the threaded
 * selector must survive; we always drive with explicit --intent).
 */
function makeNewLayoutProj(recordA: string, recordB: string): string {
  let proj = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "aidlc-t162-"));
  try {
    proj = realpathSync(proj);
  } catch {
    /* keep raw */
  }
  tempProjects.push(proj);
  const git = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  };
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  writeFileSync(join(proj, "README.md"), "seed\n");

  const stateBody = readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8");
  const intentsDir = join(proj, "aidlc", "spaces", DEFAULT_SPACE, "intents");
  for (const rec of [recordA, recordB]) {
    mkdirSync(join(intentsDir, rec), { recursive: true });
    writeFileSync(join(intentsDir, rec, "aidlc-state.md"), stateBody);
  }
  mkdirSync(join(proj, "aidlc", "spaces", DEFAULT_SPACE, "memory"), { recursive: true });
  // intents.json registry (canonical human list — committed).
  writeFileSync(
    join(intentsDir, "intents.json"),
    `${JSON.stringify(
      [recordA, recordB].map((rec) => ({
        uuid: `0000000000007000000000000000${rec.slice(-4)}`,
        slug: rec.replace(/-[0-9a-f]+$/, ""),
        status: "in-flight",
      })),
      null,
      2,
    )}\n`,
  );
  // Cursors — gitignored (per-user), so they live on disk but never commit.
  writeFileSync(join(proj, "aidlc", "active-space"), `${DEFAULT_SPACE}\n`);
  writeFileSync(join(intentsDir, "active-intent"), `${recordA}\n`);
  // Ship the framework split: gitignore cursors + machine-local audit/runtime.
  writeFileSync(
    join(proj, ".gitignore"),
    [
      "aidlc/active-space",
      "aidlc/.aidlc-clone-id",
      "aidlc/spaces/*/intents/active-intent",
      "aidlc/spaces/*/intents/*/runtime-graph.json",
      "aidlc/spaces/*/intents/*/.aidlc-*",
      "aidlc/spaces/*/intents/*/audit/",
      "",
    ].join("\n"),
  );
  git(["add", "-A"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  // Seed a workflow window in recordA's shard via the real CLI (active-intent
  // cursor → recordA, so the bare `append` lands in recordA's per-clone shard).
  const seed = (event: string, fields: [string, string][]): void => {
    const flagArgs: string[] = [];
    for (const [k, v] of fields) flagArgs.push("--field", `${k}=${v}`);
    runIn(proj, AUDIT_TOOL, ["append", event, ...flagArgs]);
  };
  seed("WORKFLOW_STARTED", [["Workflow ID", `t162-${recordA}`], ["Scope", "feature"], ["Intent", recordA]]);
  seed("STAGE_STARTED", [["Stage", "code-generation"]]);
  return proj;
}

const TEST_TIMEOUT = 120_000;

describe("t162 — real tools against a per-intent (new-layout) project", () => {
  const RECORD_A = "auth-aaaaaaaa";
  const RECORD_B = "export-bbbbbbbb";

  // ===========================================================================
  // (a) The seeded `append` and the audit-fork land under the per-intent record,
  //     NOT the flat aidlc-docs/ fallback. Proves auditFilePath re-roots when an
  //     intent is active.
  // ===========================================================================
  test(
    "writes land under the per-intent record, never the flat fallback",
    () => {
      const proj = makeNewLayoutProj(RECORD_A, RECORD_B);

      // The seeded WORKFLOW_STARTED/STAGE_STARTED wrote into recordA's shard.
      const aShards = shardNames(proj, RECORD_A);
      expect(aShards.length).toBe(1); // ONE per-clone shard (clone-id, not per-PID)
      expect(readShards(proj, RECORD_A)).toContain("WORKFLOW_STARTED");
      // The flat fallback was NEVER created (no aidlc-docs/ tree at all).
      expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);
      expect(existsSync(join(proj, "aidlc-docs", "audit.md"))).toBe(false);
    },
    TEST_TIMEOUT,
  );

  // ===========================================================================
  // (b) BLOCKER regression: a real two-process Bolt fork → merge round-trips on
  //     the new layout. audit-fork (one process) and audit-merge (another) must
  //     resolve the SAME main shard via the per-clone token. Pre-fix this FAILED
  //     at complete --merge with "main audit not found ... run --init first".
  // ===========================================================================
  test(
    "bolt fork+merge round-trips on the per-intent layout (blocker regression)",
    () => {
      const proj = makeNewLayoutProj(RECORD_A, RECORD_B);
      const slug = "feat-x";

      const created = runIn(proj, WORKTREE_TOOL, [
        "create", "--slug", slug, "--base", "main", "--intent", RECORD_A,
      ]);
      expect(created.status).toBe(0);

      const started = runIn(proj, BOLT_TOOL, [
        "start", "--name", slug, "--batch", "1", "--walking-skeleton", "false",
        "--worktree", "--slug", slug, "--intent", RECORD_A,
      ]);
      expect(started.status).toBe(0);
      // The fork wrote STATE_FORKED + AUDIT_FORKED into recordA's main shard,
      // and copied that shard into the worktree mirror.
      expect(readShards(proj, RECORD_A)).toContain("AUDIT_FORKED");

      const completed = runIn(proj, BOLT_TOOL, [
        "complete", "--name", slug, "--batch", "1", "--merge", "--slug", slug,
        "--intent", RECORD_A,
      ]);
      // The regression: pre-fix this exits non-zero because audit-merge resolved
      // a different PID shard than audit-fork wrote.
      expect(completed.status).toBe(0);
      expect(readShards(proj, RECORD_A)).toContain("AUDIT_MERGED");
      // Still exactly one main shard (the clone-id is stable across every PID in
      // this clone — fork, merge, and the seeding append all wrote the same one).
      expect(shardNames(proj, RECORD_A).length).toBe(1);
    },
    TEST_TIMEOUT,
  );

  // ===========================================================================
  // (c) Two-intent isolation: a state-fork driven with --intent recordA leaves
  //     recordB's state + audit shard untouched. Proves the selector pins the
  //     write to ONE record rather than a shared/active path.
  // ===========================================================================
  test(
    "driving --intent recordA never touches recordB's record",
    () => {
      const proj = makeNewLayoutProj(RECORD_A, RECORD_B);
      const slug = "iso-y";

      // recordB starts with no audit shard.
      expect(shardNames(proj, RECORD_B).length).toBe(0);
      const bStateBefore = readFileSync(
        join(recordPath(proj, RECORD_B), "aidlc-state.md"), "utf-8",
      );

      // Create a worktree + state-fork pinned to recordA.
      const created = runIn(proj, WORKTREE_TOOL, [
        "create", "--slug", slug, "--base", "main", "--intent", RECORD_A,
      ]);
      expect(created.status).toBe(0);
      const forked = runIn(proj, STATE_TOOL, ["fork", "--slug", slug, "--intent", RECORD_A]);
      expect(forked.status).toBe(0);

      // recordA got STATE_FORKED + an updated state (Bolt Refs gained the slug).
      expect(readShards(proj, RECORD_A)).toContain("STATE_FORKED");
      expect(
        readFileSync(join(recordPath(proj, RECORD_A), "aidlc-state.md"), "utf-8"),
      ).toContain(slug);

      // recordB is byte-for-byte untouched: no shard, identical state file.
      expect(shardNames(proj, RECORD_B).length).toBe(0);
      expect(
        readFileSync(join(recordPath(proj, RECORD_B), "aidlc-state.md"), "utf-8"),
      ).toBe(bStateBefore);
      // And the flat fallback still does not exist.
      expect(existsSync(join(proj, "aidlc-docs"))).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
