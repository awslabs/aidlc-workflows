// covers: subcommand:aidlc-bolt:start, subcommand:aidlc-bolt:complete, subcommand:aidlc-bolt:abort, subcommand:aidlc-worktree:discard, subcommand:aidlc-runtime:fragment-fork, subcommand:aidlc-runtime:fragment-merge, subcommand:aidlc-runtime:compile
//
// CLI-contract port of tests/worktree/t12-bolt-runtime-graph-fork.sh (TAP plan
// 9), mechanism = cli. The .sh carried no `# covers:` header; the units credited
// here are the ones its body actually drives end-to-end — the runtime-graph
// fragment fork/merge triad as it rides on the Bolt-worktree lifecycle:
//   - aidlc-bolt start --worktree   (forks state + audit + fragment)
//   - aidlc-bolt complete --merge   (merges state + audit + removes fragment)
//   - aidlc-bolt abort [--discard]  (the abort subcommand — UNCOVERED in the
//                                    registry as of this migration)
//   - aidlc-worktree discard        (transitive fragment cleanup, defense-in-depth)
//   - aidlc-runtime fragment-fork / fragment-merge (the fragment primitives the
//                                    bolt tool delegates to)
//   - aidlc-runtime compile         (the instances[]/L5-threshold detection that
//                                    rebuilds main runtime-graph.json post-merge)
//
// MECHANISM = cli (every observable is a PROCESS-boundary contract):
//   - the success-JSON the bolt tool prints to stdout carries the literal
//     `RUNTIME_GRAPH_FORKED` / `RUNTIME_GRAPH_MERGED` tokens in its
//     `forked: [...]` / `merged: [...]` arrays  [aidlc-bolt.ts:293,:443]
//   - the fragment file on disk at
//     <wt>/aidlc-docs/runtime-graph.json  [aidlc-runtime.ts:1097,:1179]
//   - the worktree directory removed by the real `git worktree remove`
//     dispatched inside aidlc-worktree discard  [aidlc-worktree.ts:455-519]
//   - the compiled main runtime-graph.json's instances[] (presence + alphabetical
//     ordering)  [aidlc-runtime.ts:452-551]
//   `aidlc-bolt start --worktree` itself spawns sibling subprocesses
//   (aidlc-state fork, aidlc-audit audit-fork, aidlc-runtime fragment-fork) via
//   spawnSync (aidlc-bolt.ts:89-116) — an in-process twin would lose the very
//   cross-process fork/merge dance under test. So every scenario SPAWNS the real
//   binaries (BUN + the .ts path) against a genuine git fixture, exactly the
//   .sh's shape. spawnCount = all.
//
// FIXTURE (mirrors make_bolt_fixture, t12:57-76): aidlc-worktree create runs a
// real `git worktree add` and asserts it is invoked from the main checkout
// (assertNotSiblingWorktree, aidlc-worktree.ts:101) — so each scenario needs an
// actual git repo on `main` with one commit, a Construction-phase state file
// (state-construction.md gives the phase/scope that lets Bolt operations run),
// a present-but-empty audit.md, and the framework .gitignore set so worktree
// create doesn't byte-copy audit.md / runtime-graph.json into the worktree via
// git checkout. setupWorktreeFixture + seedStateFile + the gitignore + a
// commit --amend replicate the .sh byte-for-byte. cleanupWorktreeFixture prunes
// child worktrees then rm -rf's the parent. Nothing is written under
// tests/fixtures/**.
//
// Old TAP -> new test parity (9 .sh assertions -> 9 expect()-bearing tests):
//   (a.1) start --worktree: fragment exists + JSON has RUNTIME_GRAPH_FORKED
//          -> "a.1 single-Bolt start" (fragment on disk + token in stdout)
//   (a.2) complete --merge: fragment removed + JSON has RUNTIME_GRAPH_MERGED
//          -> "a.2 single-Bolt complete" (fragment gone + token in stdout)
//   (a.3) single-Bolt compile: no instances[] on the parent (L5 >=2 threshold)
//          -> "a.3 single-Bolt compile: no instances[]"
//   (b.1) 3-Bolt parallel: all three fragments exist
//          -> "b.1 3-Bolt parallel: all fragments exist"
//   (b.2) 3-Bolt complete --merge: all fragments removed
//          -> "b.2 3-Bolt complete --merge: all fragments removed"
//   (b.3) 3-Bolt compile: instances[].bolt = [auth, cart, pay] (alphabetical)
//          -> "b.3 3-Bolt compile: instances[] alphabetical regardless of merge order"
//   (c.1) abort --discard: worktree dir + fragment gone transitively
//          -> "c.1 abort --discard: worktree + fragment gone transitively"
//   (c.2) abort without --discard: worktree + fragment preserved
//          -> "c.2 abort (no --discard): worktree + fragment preserved"
//   (c.3) manual aidlc-worktree discard: fragment removed transitively
//          -> "c.3 manual worktree discard: fragment removed transitively"
//
// STRONGER than the .sh in places: (a.1)/(a.2)/(b.*) assert the bolt tool exited
// 0 (the .sh only grepped stdout); (c.1) asserts the abort subcommand reported
// discarded:true on its stdout envelope on top of the on-disk teardown.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupWorktreeFixture,
  FIXTURES_DIR,
  seedStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const WORKTREE_TOOL = join(AIDLC_SRC, "tools", "aidlc-worktree.ts");
const BOLT_TOOL = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const RUNTIME_TOOL = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");
const AUDIT_TOOL = join(AIDLC_SRC, "tools", "aidlc-audit.ts");

const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) cleanupWorktreeFixture(f);
});

interface CliResult {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
  stdout: string;
}

/** Spawn `bun <tool> ... --project-dir <proj>` from inside the project dir. */
function run(tool: string, args: string[], proj: string): CliResult {
  const res = spawnSync(BUN, [tool, ...args, "--project-dir", proj], {
    cwd: proj,
    encoding: "utf-8",
  });
  const stdout = res.stdout ?? "";
  return { status: res.status ?? -1, out: `${stdout}${res.stderr ?? ""}`, stdout };
}

/** Path of a Bolt's runtime-graph fragment (wt_fragment, t12:115-117). */
function wtFragment(proj: string, slug: string): string {
  return join(proj, ".aidlc", "worktrees", `bolt-${slug}`, "aidlc-docs", "runtime-graph.json");
}

/** Worktree directory for a Bolt slug (worktreePath, aidlc-lib.ts:148). */
function wtDir(proj: string, slug: string): string {
  return join(proj, ".aidlc", "worktrees", `bolt-${slug}`);
}

/**
 * make_bolt_fixture (t12:57-76): a git fixture on main + a Construction-phase
 * state file + a present-but-empty audit.md + the framework .gitignore, then a
 * commit --amend so the gitignore is part of the committed tree (worktree
 * create won't byte-copy audit.md / runtime-graph.json into the worktree).
 */
function makeBoltFixture(): string {
  const proj = setupWorktreeFixture();
  fixtures.push(proj);
  // state-construction has the phase/scope that lets Bolt operations run.
  seedStateFile(proj, join(FIXTURES_DIR, "state-construction.md"));
  // Audit must be present (touched, can be empty).
  writeFileSync(join(proj, "aidlc-docs", "audit.md"), "# AI-DLC Audit Log\n", "utf-8");
  // Match the framework gitignore so worktree create doesn't byte-copy
  // audit.md / runtime-graph.json into the worktree via git checkout.
  writeFileSync(
    join(proj, ".gitignore"),
    [
      "aidlc-docs/audit.md",
      "aidlc-docs/runtime-graph.json",
      "aidlc-docs/.aidlc-recovery.md",
      "aidlc-docs/.aidlc-hooks-health/",
      "",
    ].join("\n"),
    "utf-8",
  );
  const add = spawnSync("git", ["add", "-A"], { cwd: proj, encoding: "utf-8" });
  if ((add.status ?? -1) !== 0) {
    throw new Error(`git add -A failed: ${add.stderr ?? add.stdout}`);
  }
  const commit = spawnSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--amend", "--no-edit"],
    { cwd: proj, encoding: "utf-8" },
  );
  if ((commit.status ?? -1) !== 0) {
    throw new Error(`git commit --amend failed: ${commit.stderr ?? commit.stdout}`);
  }
  return proj;
}

/** bolt_start_worktree (t12:78-92): worktree create + bolt start --worktree. */
function boltStartWorktree(proj: string, slug: string): CliResult {
  const create = run(WORKTREE_TOOL, ["create", "--slug", slug, "--base", "main"], proj);
  if (create.status !== 0) {
    throw new Error(`aidlc-worktree create --slug ${slug} failed: ${create.out}`);
  }
  return run(
    BOLT_TOOL,
    [
      "start",
      "--name", slug,
      "--batch", "1",
      "--walking-skeleton", "false",
      "--worktree",
      "--slug", slug,
    ],
    proj,
  );
}

/** bolt_complete_merge (t12:94-102): bolt complete --merge. */
function boltCompleteMerge(proj: string, slug: string): CliResult {
  return run(
    BOLT_TOOL,
    ["complete", "--name", slug, "--batch", "1", "--merge", "--slug", slug],
    proj,
  );
}

/** bolt_abort (t12:104-113): bolt abort with an optional --discard. */
function boltAbort(proj: string, slug: string, discard: boolean): CliResult {
  const args = ["abort", "--name", slug, "--reason", "test", "--slug", slug];
  if (discard) args.push("--discard");
  return run(BOLT_TOOL, args, proj);
}

/** Append an audit event via the real CLI (t12:154-159). */
function appendAudit(proj: string, event: string, fields: string[][]): void {
  const args = ["append", event];
  for (const [k, v] of fields) args.push("--field", `${k}=${v}`);
  const r = run(AUDIT_TOOL, args, proj);
  if (r.status !== 0) {
    throw new Error(`aidlc-audit append ${event} failed: ${r.out}`);
  }
}

/** Read the compiled main runtime-graph.json's code-generation stage row. */
function codeGenStage(proj: string): Record<string, unknown> | null {
  const p = join(proj, "aidlc-docs", "runtime-graph.json");
  if (!existsSync(p)) return null;
  const g = JSON.parse(readFileSync(p, "utf-8")) as {
    stages: Array<Record<string, unknown>>;
  };
  return g.stages.find((s) => s.stage_slug === "code-generation") ?? null;
}

// ===========================================================================
// Scenario (a) — Single-Bolt round-trip (3 assertions)
// ===========================================================================
describe("t12 (a) single-Bolt round-trip (migrated from t12-bolt-runtime-graph-fork.sh, plan 9)", () => {
  test("a.1 single-Bolt start --worktree: fragment exists + success-JSON carries RUNTIME_GRAPH_FORKED", () => {
    const proj = makeBoltFixture();
    const start = boltStartWorktree(proj, "solo");
    // STRONGER than the .sh (grep-only): the bolt tool exited cleanly.
    expect(start.status).toBe(0);
    expect(start.stdout).toContain("RUNTIME_GRAPH_FORKED");
    expect(existsSync(wtFragment(proj, "solo"))).toBe(true);
  }, 60000);

  test("a.2 single-Bolt complete --merge: fragment removed + success-JSON carries RUNTIME_GRAPH_MERGED", () => {
    const proj = makeBoltFixture();
    boltStartWorktree(proj, "solo");
    expect(existsSync(wtFragment(proj, "solo"))).toBe(true);

    const comp = boltCompleteMerge(proj, "solo");
    expect(comp.status).toBe(0);
    expect(comp.stdout).toContain("RUNTIME_GRAPH_MERGED");
    expect(existsSync(wtFragment(proj, "solo"))).toBe(false);
  }, 60000);

  test("a.3 single-Bolt compile: no instances[] on the parent (L5 >=2 slug threshold)", () => {
    const proj = makeBoltFixture();
    boltStartWorktree(proj, "solo");
    boltCompleteMerge(proj, "solo");

    // Seed WORKFLOW_STARTED + STAGE_STARTED + STAGE_COMPLETED so compile has a
    // code-generation stage row to inspect. The single Bolt's STATE_FORKED row
    // pre-dates this STAGE_STARTED window AND slugsInWindow.size < 2 anyway, so
    // the parent stays single-instance (aidlc-runtime.ts:479).
    appendAudit(proj, "WORKFLOW_STARTED", [
      ["Workflow ID", "t12-1bolt"],
      ["Scope", "feature"],
      ["Intent", "t12 fixture"],
    ]);
    appendAudit(proj, "STAGE_STARTED", [["Stage", "code-generation"]]);
    appendAudit(proj, "STAGE_COMPLETED", [["Stage", "code-generation"]]);
    run(RUNTIME_TOOL, ["compile"], proj);

    const cg = codeGenStage(proj);
    // The .sh's assertion: "if there's a code-generation row, it has no
    // instances[]" — single-Bolt L5 path stays single-instance.
    if (cg) {
      expect("instances" in cg).toBe(false);
    } else {
      // No code-generation row at all is also "no instances[]" — the .sh's
      // bun -e printed Boolean(cg && 'instances' in cg) === false in that case.
      expect(cg).toBeNull();
    }
  }, 60000);
});

// ===========================================================================
// Scenario (b) — 3-Bolt parallel batch (3 assertions)
// ===========================================================================
describe("t12 (b) 3-Bolt parallel batch + deterministic merge ordering", () => {
  // Build the 3-Bolt fixture once: STAGE_STARTED for code-generation is injected
  // FIRST so every subsequent STATE_FORKED row from bolt-start falls WITHIN the
  // stage's [started_at, now) window (t12:181-188). Then start pay/auth/cart in
  // non-alphabetical order, complete --merge in arbitrary order cart/pay/auth.
  function buildThreeBoltFixture(): { proj: string; frags: Record<string, string> } {
    const proj = makeBoltFixture();
    appendAudit(proj, "WORKFLOW_STARTED", [
      ["Workflow ID", "t12-3bolt"],
      ["Scope", "feature"],
      ["Intent", "t12 fixture"],
    ]);
    appendAudit(proj, "STAGE_STARTED", [["Stage", "code-generation"]]);
    for (const slug of ["pay", "auth", "cart"]) {
      const r = boltStartWorktree(proj, slug);
      expect(r.status).toBe(0); // each fork landed cleanly
    }
    return {
      proj,
      frags: {
        pay: wtFragment(proj, "pay"),
        auth: wtFragment(proj, "auth"),
        cart: wtFragment(proj, "cart"),
      },
    };
  }

  test("b.1 3-Bolt parallel: all three fragments exist at <wt>/aidlc-docs/runtime-graph.json", () => {
    const { frags } = buildThreeBoltFixture();
    expect(existsSync(frags.pay)).toBe(true);
    expect(existsSync(frags.auth)).toBe(true);
    expect(existsSync(frags.cart)).toBe(true);
  }, 120000);

  test("b.2 3-Bolt complete --merge (arbitrary order): all three fragments removed", () => {
    const { proj, frags } = buildThreeBoltFixture();
    // Complete in arbitrary user order: cart, pay, auth.
    for (const slug of ["cart", "pay", "auth"]) {
      const c = boltCompleteMerge(proj, slug);
      expect(c.status).toBe(0);
    }
    expect(existsSync(frags.pay)).toBe(false);
    expect(existsSync(frags.auth)).toBe(false);
    expect(existsSync(frags.cart)).toBe(false);
  }, 120000);

  test("b.3 3-Bolt compile: instances[].bolt = [auth, cart, pay] (alphabetical, NOT merge order)", () => {
    const { proj } = buildThreeBoltFixture();
    // Complete in arbitrary order cart/pay/auth, then compile main.
    for (const slug of ["cart", "pay", "auth"]) boltCompleteMerge(proj, slug);
    run(RUNTIME_TOOL, ["compile"], proj);

    const cg = codeGenStage(proj);
    expect(cg).not.toBeNull();
    const instances = (cg?.instances ?? null) as Array<{ bolt: string }> | null;
    expect(instances).not.toBeNull();
    // Alphabetical by Bolt slug regardless of the user's merge order
    // (aidlc-runtime.ts:485-486).
    expect((instances ?? []).map((i) => i.bolt)).toEqual(["auth", "cart", "pay"]);
  }, 120000);
});

// ===========================================================================
// Scenario (c) — Abort-discard leaves no orphans (3 assertions)
// ===========================================================================
describe("t12 (c) abort-discard leaves no orphan fragments", () => {
  test("c.1 abort --discard: worktree dir + fragment gone transitively (no manual fragment-merge)", () => {
    const proj = makeBoltFixture();
    boltStartWorktree(proj, "doomed");
    // Precondition: the fragment must exist before abort (t12:245-247).
    expect(existsSync(wtFragment(proj, "doomed"))).toBe(true);

    const abort = boltAbort(proj, "doomed", true);
    expect(abort.status).toBe(0);
    // STRONGER than the .sh: the abort envelope reports discarded:true.
    expect(abort.stdout).toContain('"discarded":true');
    // abort --discard tears down the worktree dir AND the fragment transitively
    // via git worktree remove — no manual fragment-merge call needed.
    expect(existsSync(wtDir(proj, "doomed"))).toBe(false);
    expect(existsSync(wtFragment(proj, "doomed"))).toBe(false);
  }, 60000);

  test("c.2 abort without --discard: worktree + fragment preserved (halt-and-ask default)", () => {
    const proj = makeBoltFixture();
    boltStartWorktree(proj, "kept");
    const abort = boltAbort(proj, "kept", false);
    expect(abort.status).toBe(0);
    expect(abort.stdout).toContain('"discarded":false');
    // No --discard => worktree dir + fragment both preserved for inspection.
    expect(existsSync(wtDir(proj, "kept"))).toBe(true);
    expect(existsSync(wtFragment(proj, "kept"))).toBe(true);
  }, 60000);

  test("c.3 manual aidlc-worktree discard: fragment removed transitively (defense-in-depth)", () => {
    const proj = makeBoltFixture();
    boltStartWorktree(proj, "kept");
    boltAbort(proj, "kept", false); // preserve first
    expect(existsSync(wtFragment(proj, "kept"))).toBe(true);

    // Manual aidlc-worktree discard cleans up the orphan fragment transitively
    // via git worktree remove (the defense-in-depth fallback when
    // fragment-merge wasn't called).
    const discard = run(WORKTREE_TOOL, ["discard", "--slug", "kept"], proj);
    expect(discard.status).toBe(0);
    expect(existsSync(wtDir(proj, "kept"))).toBe(false);
    expect(existsSync(wtFragment(proj, "kept"))).toBe(false);
  }, 60000);
});
