// covers: subcommand:aidlc-bolt:start, subcommand:aidlc-bolt:complete, subcommand:aidlc-bolt:abort, subcommand:aidlc-bolt:fail
//
// t77 — aidlc-bolt.ts v0.4.0 milestone 11 worktree-flag lifecycle. Migrated from
// tests/unit/t77-bolt-worktree-flags.sh (TAP plan 28; no `# covers:` header —
// covers ids derived from the four subcommands the .sh exercises through the
// --worktree / --merge / --discard / --slug flags).
//
// Mechanism: CLI (spawnSync of the real aidlc-bolt.ts via BUN). Every .sh
// assertion lives on a process-boundary seam that an in-process import cannot
// reach faithfully:
//   - exit codes from `error()` (emitError) and `failJson()` (process.exit(1)),
//   - the JSON envelopes printed to STDOUT (success {forked|merged|discarded}
//     tokens AND the failure shape {ok,slug,stage,reason,detail}),
//   - the audit.md bytes written by the spawned state-fork / audit-fork
//     sibling subprocesses (STATE_FORKED / AUDIT_FORKED emitted *inside* those
//     children, not in this process), and
//   - the forked worktree state file the state-fork child writes.
// The --worktree / --merge paths fan out to real sibling subprocesses
// (aidlc-state.ts fork/merge, aidlc-audit.ts audit-fork/audit-merge,
// aidlc-runtime.ts fragment-fork/merge) via spawnSibling (aidlc-bolt.ts:89),
// so the contract is only observable end-to-end through the spawned binary.
//
// Source under test (dist/claude/.claude/tools/aidlc-bolt.ts):
//   :149 handleStart  — --worktree requires --slug (:163), rejects csv --name
//                       (:166); validates state shape before BOLT_STARTED
//                       (:176); emits BOLT_STARTED (:197) THEN delegates to
//                       state-fork (:222) → audit-fork (:240) → fragment-fork
//                       (:261). Success stdout carries forked:[STATE_FORKED,
//                       AUDIT_FORKED,RUNTIME_GRAPH_FORKED] (:293). On a sibling
//                       failure: failBolt() BOLT_FAILED recovery row (:230,847)
//                       + failJson("start-worktree",...) (:231).
//   :307 handleComplete — --merge requires --slug (:320), rejects csv --name
//                       (:323); emits BOLT_COMPLETED then state-merge (:371) →
//                       audit-merge (:390) → fragment-merge (:412); success
//                       stdout merged:[STATE_MERGED,AUDIT_MERGED,
//                       RUNTIME_GRAPH_MERGED] (:443). state-merge removes the
//                       slug from main's Bolt Refs.
//   :457 handleFail   — --name + --error required; --slug optional, recorded as
//                       the **Bolt slug** audit field (:467) for halt-and-ask
//                       correlation.
//   :498 handleAbort  — --name + --slug + --reason all required; emits
//                       BOLT_FAILED with **Reason**: aborted (:539-544) — no
//                       new event type; default (no --discard) preserves the
//                       worktree, stdout discarded:false (:555).
//   :868 failJson     — prints {ok:false,slug,stage,reason,detail} JSON and
//                       process.exit(1). The five-field halt-and-ask envelope.
//   aidlc-lib.ts:148 worktreePath(pd,slug) = <pd>/.aidlc/worktrees/bolt-<slug>.
//
// Old TAP -> new test parity (28 .sh assertions; 1:1, several STRONGER):
//   .sh T1  (start --worktree no --slug exits 1)        -> "start --worktree without --slug exits 1"
//   .sh T2  (start --worktree rejects csv --name)       -> "start --worktree rejects csv --name"
//   .sh T3  (start --worktree happy exits 0)            -> "start --worktree happy path exits 0 + reports slug"
//   .sh T4  (stdout forked sequence)                    -> "stdout reports forked:[STATE_FORKED,AUDIT_FORKED,RUNTIME_GRAPH_FORKED]"
//   .sh T5  (BOLT_STARTED in audit)                     -> "BOLT_STARTED emitted to audit"
//   .sh T6  (STATE_FORKED in audit)                     -> "STATE_FORKED emitted by the milestone 9 fork primitive"
//   .sh T7  (AUDIT_FORKED in audit)                     -> "AUDIT_FORKED emitted by the milestone 10 audit-fork primitive"
//   .sh T8  (BOLT_STARTED precedes STATE_FORKED)        -> "atomicity ordering: BOLT_STARTED precedes STATE_FORKED"
//   .sh T9  (main Bolt Refs contains slug post-fork)    -> "main Bolt Refs contains the slug after fork"
//   .sh T10 (worktree state file forked)                -> "forked worktree state file exists"
//   .sh T11 (readonly start --worktree exits 1)         -> "start --worktree fails on readonly state (exit 1)"
//   .sh T12 (envelope ok:false on failure)              -> "failure envelope ok:false"
//   .sh T13 (envelope stage=start-worktree)             -> "failure envelope stage=start-worktree"
//   .sh T14 (complete --merge no --slug exits 1)        -> "complete --merge without --slug exits 1"
//   .sh T15 (complete --merge round-trip exits 0)       -> "complete --merge round-trip exits 0"
//   .sh T16 (stdout merged sequence)                    -> "stdout reports merged:[STATE_MERGED,AUDIT_MERGED,RUNTIME_GRAPH_MERGED]"
//   .sh T17 (merge removes slug from Bolt Refs)         -> "merge removes the slug from main Bolt Refs"
//   .sh T18 (abort no --slug exits 1)                   -> "abort without --slug exits 1"
//   .sh T19 (abort no --reason exits 1)                 -> "abort without --reason exits 1"
//   .sh T20 (abort emits BOLT_FAILED)                   -> "abort emits BOLT_FAILED (no new event type)"
//   .sh T21 (abort records Reason=aborted)              -> "abort BOLT_FAILED carries Reason: aborted"
//   .sh T22 (abort default reports discarded:false)     -> "abort default stdout reports discarded:false"
//   .sh T23 (fail --slug records Bolt slug)             -> "fail --slug records the Bolt slug audit field"
//   .sh T24 (regression: plain start leaves Bolt Refs)  -> "regression: start without --worktree leaves Bolt Refs unchanged"
//   .sh T25 (envelope contains slug field)              -> "failure envelope contains slug field"
//   .sh T26 (envelope reason field non-empty)           -> "failure envelope reason field is non-empty"
//   .sh T27 (envelope detail field non-empty prose)     -> "failure envelope detail field is non-empty user-facing prose"
//   .sh T28 (default abort preserves worktree dir)      -> "default abort (no --discard) preserves the worktree directory"

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAuditFile,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");

interface Run {
  status: number;
  out: string; // combined stdout+stderr (mirrors the .sh's 2>&1)
}

/** spawnSync the real aidlc-bolt.ts, capturing combined stdout+stderr. */
function runBolt(args: string[]): Run {
  const res = spawnSync(BUN, [TOOL, ...args], { encoding: "utf-8" });
  return {
    status: res.status ?? -1,
    out: `${res.stdout ?? ""}${res.stderr ?? ""}`,
  };
}

/**
 * Mirror the .sh setup_v7_project helper: a v7 state fixture + the audit
 * sample, optionally pre-creating the worktree dir so the milestone 9 fork primitive
 * does not reject (setup_v7_project's `with_worktree` arg, t77.sh:42-44).
 */
function setupV7Project(withWorktree?: string): string {
  const proj = createTestProject();
  seedStateFile(proj, "state-construction.md");
  seedAuditFile(proj);
  if (withWorktree) {
    mkdirSync(join(proj, ".aidlc", "worktrees", `bolt-${withWorktree}`), {
      recursive: true,
    });
  }
  return proj;
}

function statePath(proj: string): string {
  return join(proj, "aidlc-docs", "aidlc-state.md");
}
function auditPath(proj: string): string {
  return join(proj, "aidlc-docs", "audit.md");
}

let projects: string[] = [];
function track(proj: string): string {
  projects.push(proj);
  return proj;
}

beforeEach(() => resetAidlcEnv());
afterEach(() => {
  for (const p of projects) cleanupTestProject(p);
  projects = [];
});

describe("t77 aidlc-bolt worktree flags — start --worktree (migrated from t77-bolt-worktree-flags.sh, plan 28)", () => {
  test("start --worktree without --slug exits 1 [.sh T1]", () => {
    const proj = track(setupV7Project());
    const r = runBolt([
      "start", "--name", "Foo", "--batch", "1", "--worktree",
      "--project-dir", proj,
    ]);
    expect(r.status).toBe(1);
    // STRONGER: the .sh only checked exit 1; pin the diagnostic so a future
    // refactor can't make an unrelated error pass this row.
    expect(r.out).toContain("--worktree requires --slug");
  });

  test("start --worktree rejects csv --name [.sh T2]", () => {
    const proj = track(setupV7Project());
    const r = runBolt([
      "start", "--name", "Foo,Bar", "--batch", "1", "--worktree",
      "--slug", "foo", "--project-dir", proj,
    ]);
    expect(r.status).toBe(1);
    // STRONGER: pin the single-bolt-only diagnostic (aidlc-bolt.ts:166).
    expect(r.out).toContain("requires a single bolt name");
  });

  test("start --worktree happy path exits 0 + reports slug [.sh T3]", () => {
    const proj = track(setupV7Project("happy"));
    const r = runBolt([
      "start", "--name", "Happy", "--batch", "1", "--worktree",
      "--slug", "happy", "--project-dir", proj,
    ]);
    expect(r.status).toBe(0);
    // STRONGER: also assert the success envelope carries slug:"happy".
    const parsed = JSON.parse(r.out.trim());
    expect(parsed.slug).toBe("happy");
  });

  test("stdout reports forked:[STATE_FORKED,AUDIT_FORKED,RUNTIME_GRAPH_FORKED] [.sh T4]", () => {
    const proj = track(setupV7Project("happy"));
    const r = runBolt([
      "start", "--name", "Happy", "--batch", "1", "--worktree",
      "--slug", "happy", "--project-dir", proj,
    ]);
    expect(r.out).toContain(
      '"forked":["STATE_FORKED","AUDIT_FORKED","RUNTIME_GRAPH_FORKED"]',
    );
    // STRONGER: structurally pin the array, not just the substring.
    const parsed = JSON.parse(r.out.trim());
    expect(parsed.forked).toEqual([
      "STATE_FORKED", "AUDIT_FORKED", "RUNTIME_GRAPH_FORKED",
    ]);
  });

  test("BOLT_STARTED emitted to audit [.sh T5]", () => {
    const proj = track(setupV7Project("happy"));
    runBolt([
      "start", "--name", "Happy", "--batch", "1", "--worktree",
      "--slug", "happy", "--project-dir", proj,
    ]);
    const audit = readFileSync(auditPath(proj), "utf-8");
    // Mirrors `grep "^\*\*Event\*\*: BOLT_STARTED"`.
    expect(
      audit.split("\n").some((l) => l === "**Event**: BOLT_STARTED"),
    ).toBe(true);
  });

  test("STATE_FORKED emitted by the milestone 9 fork primitive [.sh T6]", () => {
    const proj = track(setupV7Project("happy"));
    runBolt([
      "start", "--name", "Happy", "--batch", "1", "--worktree",
      "--slug", "happy", "--project-dir", proj,
    ]);
    const audit = readFileSync(auditPath(proj), "utf-8");
    expect(
      audit.split("\n").some((l) => l === "**Event**: STATE_FORKED"),
    ).toBe(true);
  });

  test("AUDIT_FORKED emitted by the milestone 10 audit-fork primitive [.sh T7]", () => {
    const proj = track(setupV7Project("happy"));
    runBolt([
      "start", "--name", "Happy", "--batch", "1", "--worktree",
      "--slug", "happy", "--project-dir", proj,
    ]);
    const audit = readFileSync(auditPath(proj), "utf-8");
    expect(
      audit.split("\n").some((l) => l === "**Event**: AUDIT_FORKED"),
    ).toBe(true);
  });

  test("atomicity ordering: BOLT_STARTED precedes STATE_FORKED [.sh T8]", () => {
    const proj = track(setupV7Project("happy"));
    runBolt([
      "start", "--name", "Happy", "--batch", "1", "--worktree",
      "--slug", "happy", "--project-dir", proj,
    ]);
    const lines = readFileSync(auditPath(proj), "utf-8").split("\n");
    // Mirror the .sh's `tail -1` of each match: the LAST occurrence index.
    let bs = -1;
    let sf = -1;
    lines.forEach((l, i) => {
      if (l === "**Event**: BOLT_STARTED") bs = i;
      if (l === "**Event**: STATE_FORKED") sf = i;
    });
    expect(bs).toBeGreaterThanOrEqual(0);
    expect(sf).toBeGreaterThanOrEqual(0);
    expect(bs).toBeLessThan(sf);
  });

  test("main Bolt Refs contains the slug after fork [.sh T9]", () => {
    const proj = track(setupV7Project("happy"));
    runBolt([
      "start", "--name", "Happy", "--batch", "1", "--worktree",
      "--slug", "happy", "--project-dir", proj,
    ]);
    const refsLine =
      readFileSync(statePath(proj), "utf-8")
        .split("\n")
        .find((l) => l.includes("Bolt Refs")) ?? "";
    expect(refsLine).toContain("happy");
  });

  test("forked worktree state file exists [.sh T10]", () => {
    const proj = track(setupV7Project("happy"));
    runBolt([
      "start", "--name", "Happy", "--batch", "1", "--worktree",
      "--slug", "happy", "--project-dir", proj,
    ]);
    expect(
      existsSync(
        join(proj, ".aidlc", "worktrees", "bolt-happy", "aidlc-docs", "aidlc-state.md"),
      ),
    ).toBe(true);
  });
});

describe("t77 — start --worktree failure envelope (readonly state)", () => {
  // The .sh chmods main state 444 so the state-fork child can read it but
  // fails to WRITE the updated Bolt Refs back — state-fork exits 1, so
  // handleStart routes through failJson("start-worktree",...). One run drives
  // T11-T13 + T25-T27 (six assertions on the same envelope).
  function readonlyEnvelope(slug: string): { run: Run; env: Record<string, unknown> } {
    const proj = track(setupV7Project(slug));
    chmodSync(statePath(proj), 0o444);
    try {
      const run = runBolt([
        "start", "--name", "Env", "--batch", "1", "--worktree",
        "--slug", slug, "--project-dir", proj,
      ]);
      // Recover the LAST JSON object printed (failBolt may log before failJson;
      // the failure envelope is the last full line of stdout).
      const line =
        run.out
          .trim()
          .split("\n")
          .reverse()
          .find((l) => l.trim().startsWith("{")) ?? "{}";
      return { run, env: JSON.parse(line) };
    } finally {
      chmodSync(statePath(proj), 0o644);
    }
  }

  test("start --worktree fails on readonly state (exit 1) [.sh T11]", () => {
    const { run } = readonlyEnvelope("blocked");
    expect(run.status).toBe(1);
  });

  test("failure envelope ok:false [.sh T12]", () => {
    const { run } = readonlyEnvelope("blocked");
    expect(run.out).toContain('"ok":false');
  });

  test("failure envelope stage=start-worktree [.sh T13]", () => {
    const { run } = readonlyEnvelope("blocked");
    expect(run.out).toContain('"stage":"start-worktree"');
  });

  test("failure envelope contains slug field [.sh T25]", () => {
    const { run, env } = readonlyEnvelope("envtest");
    expect(run.out).toContain('"slug":"envtest"');
    expect(env.slug).toBe("envtest");
  });

  test("failure envelope reason field is non-empty [.sh T26]", () => {
    const { env } = readonlyEnvelope("envtest");
    expect(typeof env.reason).toBe("string");
    expect((env.reason as string).length).toBeGreaterThan(0);
  });

  test("failure envelope detail field is non-empty user-facing prose [.sh T27]", () => {
    const { env } = readonlyEnvelope("envtest");
    expect(typeof env.detail).toBe("string");
    // Mirror the .sh's `${#DETAIL} -gt 5` length floor.
    expect((env.detail as string).length).toBeGreaterThan(5);
  });
});

describe("t77 — complete --merge", () => {
  test("complete --merge without --slug exits 1 [.sh T14]", () => {
    const proj = track(setupV7Project());
    const r = runBolt([
      "complete", "--name", "Foo", "--batch", "1", "--merge",
      "--project-dir", proj,
    ]);
    expect(r.status).toBe(1);
    // STRONGER: pin the merge-requires-slug diagnostic (aidlc-bolt.ts:320).
    expect(r.out).toContain("--merge requires --slug");
  });

  test("complete --merge round-trip exits 0 [.sh T15]", () => {
    const proj = track(setupV7Project("round"));
    const start = runBolt([
      "start", "--name", "Round", "--batch", "1", "--worktree",
      "--slug", "round", "--project-dir", proj,
    ]);
    expect(start.status).toBe(0); // precondition: fork must succeed
    const r = runBolt([
      "complete", "--name", "Round", "--batch", "1", "--merge",
      "--slug", "round", "--project-dir", proj,
    ]);
    expect(r.status).toBe(0);
  });

  test("stdout reports merged:[STATE_MERGED,AUDIT_MERGED,RUNTIME_GRAPH_MERGED] [.sh T16]", () => {
    const proj = track(setupV7Project("round"));
    runBolt([
      "start", "--name", "Round", "--batch", "1", "--worktree",
      "--slug", "round", "--project-dir", proj,
    ]);
    const r = runBolt([
      "complete", "--name", "Round", "--batch", "1", "--merge",
      "--slug", "round", "--project-dir", proj,
    ]);
    expect(r.out).toContain(
      '"merged":["STATE_MERGED","AUDIT_MERGED","RUNTIME_GRAPH_MERGED"]',
    );
    const parsed = JSON.parse(r.out.trim());
    expect(parsed.merged).toEqual([
      "STATE_MERGED", "AUDIT_MERGED", "RUNTIME_GRAPH_MERGED",
    ]);
  });

  test("merge removes the slug from main Bolt Refs [.sh T17]", () => {
    const proj = track(setupV7Project("round"));
    runBolt([
      "start", "--name", "Round", "--batch", "1", "--worktree",
      "--slug", "round", "--project-dir", proj,
    ]);
    runBolt([
      "complete", "--name", "Round", "--batch", "1", "--merge",
      "--slug", "round", "--project-dir", proj,
    ]);
    // Mirror the .sh: the FIRST Bolt Refs line must no longer carry the slug.
    const refsLine =
      readFileSync(statePath(proj), "utf-8")
        .split("\n")
        .find((l) => l.includes("Bolt Refs")) ?? "";
    expect(refsLine).not.toContain("round");
  });
});

describe("t77 — abort", () => {
  test("abort without --slug exits 1 [.sh T18]", () => {
    const proj = track(setupV7Project());
    const r = runBolt([
      "abort", "--name", "Foo", "--reason", "test", "--project-dir", proj,
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --slug");
  });

  test("abort without --reason exits 1 [.sh T19]", () => {
    const proj = track(setupV7Project());
    const r = runBolt([
      "abort", "--name", "Foo", "--slug", "foo", "--project-dir", proj,
    ]);
    expect(r.status).toBe(1);
    expect(r.out).toContain("Missing --reason");
  });

  test("abort emits BOLT_FAILED (no new event type) [.sh T20]", () => {
    const proj = track(setupV7Project());
    runBolt([
      "abort", "--name", "Foo", "--slug", "foo",
      "--reason", "user changed mind", "--project-dir", proj,
    ]);
    const audit = readFileSync(auditPath(proj), "utf-8");
    expect(
      audit.split("\n").some((l) => l === "**Event**: BOLT_FAILED"),
    ).toBe(true);
  });

  test("abort BOLT_FAILED carries Reason: aborted [.sh T21]", () => {
    const proj = track(setupV7Project());
    runBolt([
      "abort", "--name", "Foo", "--slug", "foo",
      "--reason", "user changed mind", "--project-dir", proj,
    ]);
    const audit = readFileSync(auditPath(proj), "utf-8");
    // Mirror `grep '\*\*Reason\*\*: aborted'`.
    expect(audit.includes("**Reason**: aborted")).toBe(true);
  });

  test("abort default stdout reports discarded:false [.sh T22]", () => {
    const proj = track(setupV7Project("preserved"));
    const r = runBolt([
      "abort", "--name", "Preserved", "--slug", "preserved",
      "--reason", "preserve test", "--project-dir", proj,
    ]);
    expect(r.out).toContain('"discarded":false');
    const parsed = JSON.parse(r.out.trim());
    expect(parsed.discarded).toBe(false);
  });

  test("default abort (no --discard) preserves the worktree directory [.sh T28]", () => {
    const proj = track(setupV7Project("exp-pres"));
    const wtDir = join(proj, ".aidlc", "worktrees", "bolt-exp-pres");
    mkdirSync(wtDir, { recursive: true });
    writeFileSync(join(wtDir, "file.txt"), "marker");
    runBolt([
      "abort", "--name", "Pres", "--slug", "exp-pres",
      "--reason", "default-pres test", "--project-dir", proj,
    ]);
    // Worktree directory survives a default abort (no --discard).
    expect(existsSync(wtDir)).toBe(true);
  });
});

describe("t77 — fail --slug (milestone 12 halt-and-ask correlation)", () => {
  test("fail --slug records the Bolt slug audit field [.sh T23]", () => {
    const proj = track(setupV7Project());
    runBolt([
      "fail", "--name", "Failed", "--slug", "fail-slug",
      "--error", "broke", "--project-dir", proj,
    ]);
    const audit = readFileSync(auditPath(proj), "utf-8");
    // Mirror `grep '\*\*Bolt slug\*\*: fail-slug'`.
    expect(audit.includes("**Bolt slug**: fail-slug")).toBe(true);
  });
});

describe("t77 — regression guard: no-flag paths unchanged", () => {
  test("regression: start without --worktree leaves Bolt Refs unchanged [.sh T24]", () => {
    const proj = track(setupV7Project());
    const refsLine = (s: string): string =>
      readFileSync(statePath(s), "utf-8")
        .split("\n")
        .find((l) => l.includes("Bolt Refs")) ?? "";
    const before = refsLine(proj);
    const r = runBolt([
      "start", "--name", "Plain", "--batch", "1", "--project-dir", proj,
    ]);
    expect(r.status).toBe(0);
    expect(refsLine(proj)).toBe(before);
  });
});
