// covers: subcommand:aidlc-swarm:prepare, subcommand:aidlc-swarm:check, subcommand:aidlc-swarm:finalize, audit:SWARM_STARTED, audit:SWARM_DEGRADED, audit:SWARM_UNIT_CONVERGED, audit:SWARM_UNIT_FAILED, audit:SWARM_BATON_RETURNED, audit:SWARM_COMPLETED
//
// CLI-contract port of tests/e2e/t134-swarm-referee.sh (TAP plan 13),
// mechanism = cli. The .sh exercises aidlc-swarm.ts — the STATELESS convergence
// REFEREE the conductor consults — over REAL git worktrees, with the test (like
// the .sh) playing the conductor: it drives prepare/check/finalize directly and
// stages each worktree's on-disk state the way a worker would (or wouldn't)
// have. Determinism comes from the staged state + the real check command's exit
// code — never a worker's self-claim.
//
// MECHANISM = cli (NOT none): every observable the .sh asserts is at the PROCESS
// boundary — process.exit codes, the JSON envelope on stdout, and audit.md bytes
// — and the tool itself spawns child processes (git worktree add, aidlc-bolt,
// the bash check command). An in-process twin would lose the real
// git-worktree side effect, the audit emit, the genuine `git diff --quiet HEAD`
// anti-tamper baseline, and the exit-2-baton-returns shell the .sh keys on. So
// we SPAWN the real tool via spawnSync(BUN, [SWARM_TOOL, ...]) and assert on
// res.status / res.stdout and the on-disk audit, exactly as the .sh did with
// run_ref. spawnCount = all 13 cases.
//
// Source under test (dist/claude/.claude/tools/aidlc-swarm.ts):
//   - handlePrepare (:296): forks a worktree per unit via aidlc-worktree create
//     + aidlc-bolt start --worktree; emits SWARM_STARTED once (:328) and
//     SWARM_DEGRADED first when --degraded-from is given (:325). Exits 2 if any
//     fork failed (:386), else 0.
//   - handleCheck (:391): stateless single-unit verdict via verdictFor (:162) —
//     checkConverged (:129, exit 0 of the bash --check-cmd) AND the anti-tamper
//     fileTampered (:143, `git diff --quiet HEAD -- <test-file>` status===1).
//     Prints compact {unit,converged,tampered,reason}; exits 0 IFF genuinely
//     converged (green AND untampered), 1 otherwise (:431). A --test-file that
//     escapes the worktree is a typed confine error (:181, "resolves outside
//     the unit worktree"), reason "error", exit 1 (:417). Emits no audit.
//   - handleFinalize (:436): the AUTHORITATIVE gate. RE-RUNS the check on every
//     --claimed unit before any merge (the lying-conductor guard, :503-515): a
//     claimed-but-red / tampered unit is refused the merge and lands "failed"
//     with reason "error". A DECLINED (unclaimed) unit carries the conductor's
//     --reasons attribution (:463-477,:523), defaulting to "cap-exhausted".
//     Merges the genuine passes (serialised, :541), then emits one
//     SWARM_UNIT_CONVERGED / SWARM_UNIT_FAILED row per unit (except a
//     converged unit whose merge-back failed, which gets NEITHER row: its
//     converged row lands only when a finalize retry merges it), a
//     SWARM_BATON_RETURNED per failed unit, and a closing SWARM_COMPLETED
//     (:555-570); prints the pretty-printed envelope and exits 2 if any unit or
//     merge failed, else 0 (:582).
//
// FIXTURE (mirrors make_swarm_fixture, t134.sh:80-95): a real git repo on
// `main` (setupWorktreeFixture, ported from tests/lib/worktree-helpers.sh)
// seeded into Construction phase — aidlc-docs/aidlc-state.md from
// state-construction.md + a fresh audit.md — with the framework .gitignore so
// `git worktree add` does not byte-copy audit.md / runtime-graph.json into the
// child, then `commit --amend` so the worktree fork carries the gitignore at
// HEAD. The per-unit worktree path is the tool's deterministic
// worktreePath(proj, slug) = <proj>/.aidlc/worktrees/bolt-<slug>. Nothing is
// written under tests/fixtures/**; cleanupWorktreeFixture prunes children then
// rm -rf's each parent in afterAll.
//
// Old TAP -> new test parity (1:1, every .sh `ok` line maps to a named test()):
//   .sh 1  prepare forks a worktree + SWARM_STARTED          -> "1 prepare: forks a worktree per unit + emits SWARM_STARTED"
//   .sh 2  check genuine converged -> exit 0, converged:true -> "2 check: genuinely converged unit -> exit 0, converged:true"
//   .sh 3  check stateless (same verdict on repeat)          -> "3 check is stateless: repeat call same verdict (no counter)"
//   .sh 4  check not-converged -> exit !=0, converged:false  -> "4 check: not-yet-converged unit -> exit non-zero, converged:false"
//   .sh 5  anti-tamper on check (edited --test-file)         -> "5 anti-tamper: edited protected --test-file -> tampered:true, refused"
//   .sh 6  finalize genuine claimed merges + UNIT_CONVERGED  -> "6 finalize: genuine claimed unit merges + SWARM_UNIT_CONVERGED, exit 0"
//   .sh 7  lying-conductor guard (falsely-claimed re-verified)-> "7 lying-conductor: falsely-claimed-converged unit re-verify-refused"
//   .sh 8  finalize anti-tamper (claimed tampered rejected)  -> "8 finalize anti-tamper: tampered claimed unit re-verify-rejected"
//   .sh 9  mixed batch tally 1+1, SWARM_COMPLETED, exit 2    -> "9 finalize mixed batch: 1 converged + 1 failed; SWARM_COMPLETED; exit 2"
//   .sh 10 loud-degrade prepare --degraded-from -> DEGRADED  -> "10 loud-degrade: prepare --degraded-from ultracode emits SWARM_DEGRADED"
//   .sh 11 path-confinement (../ --test-file typed error)    -> "11 path-confinement: a ../ --test-file is a typed error, not a disabled guard"
//   .sh 12 conductor attribution (--reasons unsatisfiable)   -> "12 conductor attribution: --reasons unsatisfiable lands the typed reason"
//   .sh 13 --reasons cannot override the lying-conductor guard-> "13 --reasons cannot launder a claimed-but-red unit (stays error)"
//
// 13 .sh asserts -> 13 expect()-bearing test() cases (same count, same
// observables). STRONGER than the .sh in several places: the .sh grepped loose
// substrings (`grep -q '"converged":true'`); here the stdout is JSON.parse'd and
// asserted field-by-field (e.g. the lying unit's status === "failed" + reason
// === "error" on the parsed envelope row), and audit-event presence is an exact
// `**Event**: <type>` row count rather than a `grep -q`.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  DEFAULT_RECORD_DIR,
  FIXTURES_DIR,
  cleanupWorktreeFixture,
  seededAuditDir,
  seededStateFile,
  setupWorktreeFixture,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const SWARM_TOOL = join(AIDLC_SRC, "tools", "aidlc-swarm.ts");

const fixtures: string[] = [];
afterAll(() => {
  for (const f of fixtures) cleanupWorktreeFixture(f);
});

/**
 * make_swarm_fixture (t134.sh:80-95): a real git repo on `main` in Construction
 * phase with the framework gitignore set, committed at HEAD so the worktree fork
 * carries it (and so `git worktree add` does NOT byte-copy audit.md /
 * runtime-graph.json into the child).
 */
function makeSwarmFixture(): string {
  const proj = setupWorktreeFixture();
  fixtures.push(proj);
  // Seed Construction-phase state into the per-intent record + a fresh audit log
  // shard (.sh: cp state + `printf "# AI-DLC Audit Log\n"`). The record state +
  // intents.json commit (so the worktree fork carries them); cursors + audit
  // shards stay machine-local.
  writeFileSync(
    seededStateFile(proj),
    readFileSync(join(FIXTURES_DIR, "state-construction.md"), "utf-8"),
  );
  mkdirSync(seededAuditDir(proj), { recursive: true });
  writeFileSync(join(seededAuditDir(proj), "fixture.md"), "# AI-DLC Audit Log\n");
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
  // Stage everything and amend the seed commit so HEAD carries the gitignore +
  // state, mirroring the .sh's `git add -A && commit --amend --no-edit`.
  const git = (args: string[]): void => {
    spawnSync("git", args, { cwd: proj, encoding: "utf-8" });
  };
  git(["add", "-A"]);
  git([
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--amend",
    "--no-edit",
  ]);
  return proj;
}

/** The per-unit worktree path the tool derives (aidlc-lib worktreePath). */
function wtPath(proj: string, slug: string): string {
  return join(proj, ".aidlc", "worktrees", `bolt-${slug}`);
}

interface RefResult {
  rc: number;
  out: string; // stdout (the envelope / verdict JSON)
}

/**
 * run_ref (t134.sh:103-112): drive a referee subcommand against a real project,
 * capturing stdout + the exit code without letting a non-zero exit abort. The
 * tool's intended non-zero exits (check red = 1, finalize baton = 2) are part of
 * the contract, so we keep the status.
 */
function runRef(proj: string, args: string[]): RefResult {
  const res = spawnSync(BUN, [SWARM_TOOL, "--project-dir", proj, ...args], {
    cwd: proj,
    encoding: "utf-8",
  });
  return { rc: res.status ?? -1, out: res.stdout ?? "" };
}

/** Concatenate every audit shard (audit/*.md) for the seeded record — the swarm
 *  tool writes SWARM_* rows to its own per-clone shard alongside fixture.md. */
const auditBody = (p: string): string => {
  const dir = seededAuditDir(p);
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  return names.map((n) => readFileSync(join(dir, n), "utf-8")).join("\n");
};

/** Exact `**Event**: <type>` row count across the audit shards (STRONGER than grep -q). */
function eventCount(p: string, event: string): number {
  return auditBody(p)
    .split("\n")
    .filter((l) => l === `**Event**: ${event}`).length;
}

describe("t134 swarm referee — prepare/check/finalize (migrated from t134-swarm-referee.sh, plan 13)", () => {
  // ===========================================================================
  // Cases 1-4 + 6 share ONE fixture: prepare + stateless check + finalize on a
  // converged unit, mirroring the .sh's first PROJ block.
  // ===========================================================================
  test("1 prepare: forks a worktree per unit + emits SWARM_STARTED", () => {
    const proj = makeSwarmFixture();
    const r = runRef(proj, ["prepare", "--batch", "1", "--units", "alpha", "--base", "main"]);
    // .sh grepped `"ok": true` — but handlePrepare's envelope carries no top-level
    // `ok` field; the .sh's grep matched the nested per-unit `"ok": true` row.
    // Assert that real contract: prepare succeeded (exit 0), the batch started,
    // and the unit forked.
    expect(r.rc).toBe(0);
    const env = JSON.parse(r.out);
    expect(env.units.find((u: { unit: string }) => u.unit === "alpha")?.ok).toBe(true);
    // SWARM_STARTED fired exactly once for the batch.
    expect(eventCount(proj, "SWARM_STARTED")).toBe(1);
    // The worktree directory landed on disk via the real `git worktree add`.
    expect(existsSync(wtPath(proj, "alpha"))).toBe(true);

    // --- Case 2: the conductor's worker would have written impl.txt; stage it so
    // the real check command (test -f impl.txt) passes (exit 0 = green).
    writeFileSync(join(wtPath(proj, "alpha"), "impl.txt"), "done\n");
    const c1 = runRef(proj, ["check", "alpha", "--check-cmd", "test -f impl.txt"]);
    expect(c1.rc).toBe(0);
    expect(JSON.parse(c1.out).converged).toBe(true);

    // --- Case 3: STATELESS — an identical second call returns the same verdict
    // (no counter, no drift).
    const c2 = runRef(proj, ["check", "alpha", "--check-cmd", "test -f impl.txt"]);
    expect(c2.rc).toBe(0);
    expect(JSON.parse(c2.out).converged).toBe(true);

    // --- Case 4: a not-yet-converged unit — prepare beta, do NOT write its impl,
    // check -> red (exit non-zero, converged:false).
    runRef(proj, ["prepare", "--batch", "1", "--units", "beta", "--base", "main"]);
    const c3 = runRef(proj, ["check", "beta", "--check-cmd", "test -f impl.txt"]);
    expect(c3.rc).not.toBe(0);
    expect(JSON.parse(c3.out).converged).toBe(false);

    // --- Case 6: finalize the genuinely converged alpha (claimed) — merges back
    // + emits SWARM_UNIT_CONVERGED, envelope converged:1, exit 0.
    const f = runRef(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "alpha",
      "--claimed",
      "alpha",
      "--check-cmd",
      "test -f impl.txt",
    ]);
    expect(f.rc).toBe(0);
    const fEnv = JSON.parse(f.out);
    expect(fEnv.converged).toBe(1);
    expect(fEnv.merge_failures).toEqual([]);
    expect(eventCount(proj, "SWARM_UNIT_CONVERGED")).toBe(1);
    // The row carries the attempt-identity stamp: Stage from the state file's
    // Current Stage, Run floor = the stage's latest main-workflow
    // STAGE_STARTED ("" here - the fixture audit has none).
    const convergedBlock = auditBody(proj)
      .split("\n---\n")
      .find((b) => b.includes("**Event**: SWARM_UNIT_CONVERGED"));
    expect(convergedBlock).toContain("**Stage**: functional-design");
    expect(convergedBlock).toContain("**Run floor**: ");
  }, 120000);

  // Cases 2, 3, 4, 6 are asserted inside test 1's shared-fixture flow above
  // (the .sh ran them sequentially against the same PROJ). Named here for the
  // 1:1 parity map; their expects live in "1 prepare ...".
  test("2 check: genuinely converged unit -> exit 0, converged:true", () => {
    // Covered by the case-2 block in "1 prepare ..." (shared fixture). Re-prove
    // standalone: a fresh fixture, prepared + impl-staged unit checks green.
    const proj = makeSwarmFixture();
    runRef(proj, ["prepare", "--batch", "1", "--units", "g2", "--base", "main"]);
    writeFileSync(join(wtPath(proj, "g2"), "impl.txt"), "done\n");
    const c = runRef(proj, ["check", "g2", "--check-cmd", "test -f impl.txt"]);
    expect(c.rc).toBe(0);
    expect(JSON.parse(c.out).converged).toBe(true);
  }, 120000);

  test("3 check is stateless: repeat call same verdict (no counter)", () => {
    const proj = makeSwarmFixture();
    runRef(proj, ["prepare", "--batch", "1", "--units", "g3", "--base", "main"]);
    writeFileSync(join(wtPath(proj, "g3"), "impl.txt"), "done\n");
    const first = runRef(proj, ["check", "g3", "--check-cmd", "test -f impl.txt"]);
    const second = runRef(proj, ["check", "g3", "--check-cmd", "test -f impl.txt"]);
    // Same exit code AND same parsed verdict — no state drift between calls.
    expect(second.rc).toBe(first.rc);
    expect(second.rc).toBe(0);
    expect(JSON.parse(second.out)).toEqual(JSON.parse(first.out));
    expect(JSON.parse(second.out).converged).toBe(true);
  }, 120000);

  test("4 check: not-yet-converged unit -> exit non-zero, converged:false", () => {
    const proj = makeSwarmFixture();
    runRef(proj, ["prepare", "--batch", "1", "--units", "g4", "--base", "main"]);
    // No impl staged -> the check command fails (exit non-zero).
    const c = runRef(proj, ["check", "g4", "--check-cmd", "test -f impl.txt"]);
    expect(c.rc).not.toBe(0);
    expect(JSON.parse(c.out).converged).toBe(false);
  }, 120000);

  // ===========================================================================
  // Case 5: anti-tamper on check — editing the protected --test-file is refused,
  // baseline re-derived from the worktree's own git fork (no stored hash).
  // ===========================================================================
  test("5 anti-tamper: edited protected --test-file -> tampered:true, refused", () => {
    const proj = makeSwarmFixture();
    // Seed a TRACKED protected file so the worktree fork carries it at HEAD.
    mkdirSync(join(proj, "spec"), { recursive: true });
    writeFileSync(join(proj, "spec", "unit.test"), "EXPECTED\n");
    spawnSync("git", ["add", "-A"], { cwd: proj, encoding: "utf-8" });
    spawnSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed test"],
      { cwd: proj, encoding: "utf-8" },
    );
    runRef(proj, ["prepare", "--batch", "1", "--units", "gamma", "--base", "main"]);
    // The "worker" cheats: it makes the check pass by editing the protected file.
    writeFileSync(join(wtPath(proj, "gamma"), "spec", "unit.test"), "TAMPERED\n");
    const c = runRef(proj, [
      "check",
      "gamma",
      "--check-cmd",
      "grep -q TAMPERED spec/unit.test",
      "--test-file",
      "spec/unit.test",
    ]);
    // The check command itself passes, but the anti-tamper guard fires: tampered
    // true, convergence refused (exit non-zero).
    expect(c.rc).not.toBe(0);
    expect(JSON.parse(c.out).tampered).toBe(true);
  }, 120000);

  // ===========================================================================
  // Cases 7 + 9: the LYING-CONDUCTOR GUARD + mixed batch. The conductor claims
  // two units converged; only one actually is.
  // ===========================================================================
  test("7 lying-conductor: falsely-claimed-converged unit re-verify-refused", () => {
    const proj = makeSwarmFixture();
    runRef(proj, ["prepare", "--batch", "2", "--units", "win,lie", "--base", "main"]);
    // `win` genuinely converges; `lie` does NOT (no impl) but is falsely claimed.
    writeFileSync(join(wtPath(proj, "win"), "win.txt"), "done\n");
    const f = runRef(proj, [
      "finalize",
      "--batch",
      "2",
      "--units",
      "win,lie",
      "--claimed",
      "win,lie",
      "--check-cmd",
      "test -f win.txt",
    ]);
    const env = JSON.parse(f.out);
    // STRONGER than the .sh's `grep -A2`: locate the parsed `lie` row and assert
    // status === "failed" with the tool's own re-verify reason "error".
    const lie = env.units.find((u: { unit: string }) => u.unit === "lie");
    expect(lie).toBeDefined();
    expect(lie.status).toBe("failed");
    expect(lie.reason).toBe("error");
    // The full audit baton trail fired for the failed unit.
    expect(eventCount(proj, "SWARM_UNIT_FAILED")).toBeGreaterThanOrEqual(1);
    expect(eventCount(proj, "SWARM_BATON_RETURNED")).toBeGreaterThanOrEqual(1);

    // --- Case 9: the mixed batch tallies 1 converged + 1 failed, emits
    // SWARM_COMPLETED, and exits 2 (baton returns). (Asserted on the same run.)
    expect(env.converged).toBe(1);
    expect(env.failed).toBe(1);
    expect(eventCount(proj, "SWARM_COMPLETED")).toBe(1);
    expect(f.rc).toBe(2);
  }, 120000);

  test("9 finalize mixed batch: 1 converged + 1 failed; SWARM_COMPLETED; exit 2", () => {
    // The .sh asserted cases 7 + 9 on a single finalize run; re-prove case 9
    // standalone on a fresh fixture so the tally invariant is independently
    // anchored.
    const proj = makeSwarmFixture();
    runRef(proj, ["prepare", "--batch", "2", "--units", "wn,le", "--base", "main"]);
    writeFileSync(join(wtPath(proj, "wn"), "wn.txt"), "done\n");
    const f = runRef(proj, [
      "finalize",
      "--batch",
      "2",
      "--units",
      "wn,le",
      "--claimed",
      "wn,le",
      "--check-cmd",
      "test -f wn.txt",
    ]);
    const env = JSON.parse(f.out);
    expect(env.converged).toBe(1);
    expect(env.failed).toBe(1);
    expect(eventCount(proj, "SWARM_COMPLETED")).toBe(1);
    expect(f.rc).toBe(2);
  }, 120000);

  // ===========================================================================
  // Case 8: finalize anti-tamper — a claimed unit whose protected file was
  // edited is re-verify-rejected even though the check command keys off it.
  // ===========================================================================
  test("8 finalize anti-tamper: tampered claimed unit re-verify-rejected", () => {
    const proj = makeSwarmFixture();
    mkdirSync(join(proj, "spec"), { recursive: true });
    writeFileSync(join(proj, "spec", "unit.test"), "EXPECTED\n");
    spawnSync("git", ["add", "-A"], { cwd: proj, encoding: "utf-8" });
    spawnSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed test"],
      { cwd: proj, encoding: "utf-8" },
    );
    runRef(proj, ["prepare", "--batch", "1", "--units", "delta", "--base", "main"]);
    writeFileSync(join(wtPath(proj, "delta"), "spec", "unit.test"), "TAMPERED\n");
    const f = runRef(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "delta",
      "--claimed",
      "delta",
      "--check-cmd",
      "grep -q TAMPERED spec/unit.test",
      "--test-file",
      "spec/unit.test",
    ]);
    expect(f.rc).toBe(2);
    const env = JSON.parse(f.out);
    // The check command "passes" but the tampered claimed unit is rejected: zero
    // converged, and the unit row carries tampered:true.
    expect(env.converged).toBe(0);
    const delta = env.units.find((u: { unit: string }) => u.unit === "delta");
    expect(delta).toBeDefined();
    expect(delta.tampered).toBe(true);
    expect(delta.status).toBe("failed");
  }, 120000);

  // ===========================================================================
  // Case 10: loud-degrade — prepare --degraded-from ultracode emits SWARM_DEGRADED.
  // ===========================================================================
  test("10 loud-degrade: prepare --degraded-from ultracode emits SWARM_DEGRADED", () => {
    const proj = makeSwarmFixture();
    runRef(proj, [
      "prepare",
      "--batch",
      "1",
      "--units",
      "epsilon",
      "--base",
      "main",
      "--degraded-from",
      "ultracode",
    ]);
    // SWARM_DEGRADED fired, and it records the requested driver (ultracode).
    expect(eventCount(proj, "SWARM_DEGRADED")).toBe(1);
    expect(auditBody(proj)).toContain("**Requested driver**: ultracode");
  }, 120000);

  // ===========================================================================
  // Case 11: path-confinement — a --test-file escaping the worktree (../) is a
  // typed error on check, not a silently-disabled anti-tamper guard.
  // ===========================================================================
  test("11 path-confinement: a ../ --test-file is a typed error, not a disabled guard", () => {
    const proj = makeSwarmFixture();
    runRef(proj, ["prepare", "--batch", "1", "--units", "zeta", "--base", "main"]);
    writeFileSync(join(wtPath(proj, "zeta"), "impl.txt"), "done\n");
    const c = runRef(proj, [
      "check",
      "zeta",
      "--check-cmd",
      "test -f impl.txt",
      "--test-file",
      "../escape.test",
    ]);
    // A ../ escape is rejected as a typed configuration error (reason "error"),
    // not a silently-passed "untampered". Exit non-zero.
    expect(c.rc).not.toBe(0);
    const out = JSON.parse(c.out);
    expect(out.reason).toBe("error");
    expect(out.detail).toContain("resolves outside the unit worktree");
  }, 120000);

  // ===========================================================================
  // Case 12: conductor attribution — a DECLINED (unclaimed) unit for which the
  // conductor judged the unit unsatisfiable. --reasons carries that typed
  // attribution; the tool records it faithfully (knowledge->conductor decides,
  // determinism->tool records) instead of the cap-exhausted default.
  // ===========================================================================
  test("12 conductor attribution: --reasons unsatisfiable lands the typed reason (envelope + audit)", () => {
    const proj = makeSwarmFixture();
    runRef(proj, ["prepare", "--batch", "1", "--units", "stuck", "--base", "main"]);
    // `stuck` gets no impl and is NOT claimed; the conductor attributes unsatisfiable.
    const f = runRef(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "stuck",
      "--claimed",
      "",
      "--check-cmd",
      "test -f impl.txt",
      "--reasons",
      "stuck=unsatisfiable",
    ]);
    expect(f.rc).toBe(2);
    const stuck = JSON.parse(f.out).units.find(
      (u: { unit: string }) => u.unit === "stuck",
    );
    expect(stuck).toBeDefined();
    // The typed attribution lands in the envelope (NOT the cap-exhausted default).
    expect(stuck.reason).toBe("unsatisfiable");
    // ...and in the SWARM_UNIT_FAILED audit row's Reason field.
    expect(auditBody(proj)).toContain("**Reason**: unsatisfiable");
  }, 120000);

  // ===========================================================================
  // Case 13: --reasons cannot override the lying-conductor guard. A unit CLAIMED
  // converged but red on disk must stay reason "error" (the tool's own re-verify
  // verdict) even when --reasons names it unsatisfiable — a conductor attribution
  // applies only to DECLINED units, never to launder a claimed-but-red one.
  // ===========================================================================
  test("13 --reasons cannot override the lying-conductor guard: claimed-but-red stays error", () => {
    const proj = makeSwarmFixture();
    runRef(proj, ["prepare", "--batch", "1", "--units", "sneaky", "--base", "main"]);
    // sneaky is CLAIMED converged but no impl exists; the conductor also tries to
    // dress the failure as unsatisfiable via --reasons. The tool must ignore that
    // and report error (claimed-but-red).
    const f = runRef(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "sneaky",
      "--claimed",
      "sneaky",
      "--check-cmd",
      "test -f impl.txt",
      "--reasons",
      "sneaky=unsatisfiable",
    ]);
    expect(f.rc).toBe(2);
    const sneaky = JSON.parse(f.out).units.find(
      (u: { unit: string }) => u.unit === "sneaky",
    );
    expect(sneaky).toBeDefined();
    // The tool's own re-verify verdict WINS for a claimed unit: reason stays
    // "error", never the laundered "unsatisfiable".
    expect(sneaky.reason).toBe("error");
    expect(sneaky.reason).not.toBe("unsatisfiable");
  }, 120000);

  // ===========================================================================
  // Case 14: a converged unit whose MERGE-BACK failed gets NO SWARM_UNIT_CONVERGED
  // row. That row is the engine's batch-advance signal; emitting it for a unit
  // whose metadata never landed on main would advance the run past an unmerged
  // unit. It gets no SWARM_UNIT_FAILED row either (the unit did converge) — the
  // failure envelope + exit 2 carry the merge outcome, and the row lands when a
  // finalize retry scoped to the unit merges cleanly.
  // ===========================================================================
  test("14 merge failure: converged-but-unmerged unit gets no SWARM_UNIT_CONVERGED row", () => {
    const proj = makeSwarmFixture();
    runRef(proj, ["prepare", "--batch", "1", "--units", "orphan", "--base", "main"]);
    writeFileSync(join(wtPath(proj, "orphan"), "impl.txt"), "done\n");
    // Force a deterministic merge failure: delete the worktree's forked state
    // mirror. Re-verify still passes (impl.txt is on disk), but `aidlc-state
    // merge` refuses ("worktree state file does not exist"), so complete --merge
    // fails and the unit lands in merge_failures.
    rmSync(
      join(
        wtPath(proj, "orphan"),
        "aidlc",
        "spaces",
        "default",
        "intents",
        DEFAULT_RECORD_DIR,
        "aidlc-state.md",
      ),
    );
    const f = runRef(proj, [
      "finalize",
      "--batch",
      "1",
      "--units",
      "orphan",
      "--claimed",
      "orphan",
      "--check-cmd",
      "test -f impl.txt",
    ]);
    // Exit 2: the merge failure demands the baton back.
    expect(f.rc).toBe(2);
    const env = JSON.parse(f.out);
    // The unit genuinely converged (envelope row + tally say so)...
    expect(env.converged).toBe(1);
    expect(env.units.find((u: { unit: string }) => u.unit === "orphan")?.status).toBe(
      "converged",
    );
    // ...and the failure envelope names it as unmerged.
    expect(env.merge_failures.map((m: { unit: string }) => m.unit)).toEqual(["orphan"]);
    // The load-bearing advance signal did NOT fire — and no false FAILED row either.
    expect(eventCount(proj, "SWARM_UNIT_CONVERGED")).toBe(0);
    expect(eventCount(proj, "SWARM_UNIT_FAILED")).toBe(0);
  }, 120000);
});
