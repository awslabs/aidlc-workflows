// covers: invariant:audit-first-atomicity
//   sub-ids (one per state-mutating + audit-emitting handler):
//     invariant:audit-first-atomicity:approve            (handleApprove   :675)
//     invariant:audit-first-atomicity:reject             (handleReject    :769)
//     invariant:audit-first-atomicity:skip               (handleSkip      :839)
//     invariant:audit-first-atomicity:advance            (handleAdvance   :275)
//     invariant:audit-first-atomicity:gate-start         (handleGateStart :635)
//     invariant:audit-first-atomicity:complete-workflow  (handleCompleteWorkflow :520)
//     invariant:audit-first-atomicity:reuse-artifact     (handleReuseArtifact    :1307, audit-only)
//   plus a FINDING-pinning block:
//     finding:finalize-is-not-audit-first  (handleFinalize :456 emits NO audit)
//
// t125 — audit-first atomicity invariant sweep.
// (Renumbered from t114 at the v0.5.12 reconcile to clear main's v0.6.0 unit
// t114-orchestrate-next.sh; same-tier ID collision.)
// Mechanism: none (Bun.spawnSync of aidlc-state.ts against a temp project on
// disk; zero LLM, zero tokens). Technique: invariant sweep + EISDIR fault
// injection.
//
// THE INVARIANT. Every state-mutating handler that also emits audit must be
// "audit-first": it emits the audit row(s) BEFORE writing the state file, and
// if the audit append throws, it surfaces the error and exits non-zero WITHOUT
// writing state. Audit-first is the single guarantee that the audit log never
// disagrees with the state file — a state mutation that left no audit row
// would be an undetectable phantom transition.
//
// Two existing tests pin this for exactly two handlers:
//   - t76 (fork)            — STATE_FORKED audit-first inside withAuditLock
//   - t17 Test 65 (approve) — the just-committed repair this file generalises
// This file extends the same proof to the FULL set of audit-emitting handlers
// so a future edit that reorders writeStateFile() ahead of emitAudit() in ANY
// handler is caught, not just in fork/approve.
//
// FAULT INJECTION (reused verbatim from t17 Test 65, ~line 620). The seeded
// audit.md FILE is replaced by a DIRECTORY at the same path. aidlc-audit.ts
// appends via appendFileSync(path, block) (aidlc-audit.ts:257); ensureAuditFile
// (:174) sees existsSync(path) === true for the directory and returns it
// unchanged, so appendFileSync throws EISDIR. This is uid-independent — "append
// to a directory" is a kernel-enforced type error, not a permission check, so
// it fails identically for root and non-root (the old chmod 0444 approach was
// ignored by root, skipping the proof exactly where CI often runs as root).
// The thrown EISDIR is caught in each handler's try/catch and surfaced via
// error() BEFORE writeStateFile() runs.
//
// SELF-VERIFY CONTRACT (per handler):
//   (a) the process exits NON-ZERO (the audit failure aborted the command), and
//   (b) the state file is BYTE-IDENTICAL to its pre-call snapshot (the mutation
//       did not happen).
// (a)+(b) together are the audit-first guarantee: emit failed ⇒ no state write.
//
// FINDING — handleFinalize is NOT audit-first because it emits NO audit at all.
// handleFinalize (:456) calls writeStateFile(:508) with zero emitAudit() calls
// in its body (grep-verified). It is therefore outside the audit-first contract:
// under the same EISDIR injection it exits ZERO and MUTATES state. That is the
// CORRECT behaviour for a handler that emits nothing — there is no audit row to
// keep consistent — but it is a real asymmetry worth pinning so a future change
// that adds an emitAudit() to finalize without ordering it audit-first is caught.
// The block below asserts finalize's ACTUAL behaviour (rc=0, state changed) and
// the test stays green; see this file's notes for the flag.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { auditFilePath } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  createTestProject,
  seededStateFile,
  seedStateFile,
} from "../harness/fixtures.ts";

// --- Paths resolved relative to THIS test file (tests/unit/) ---
const HERE = import.meta.dir;
const REPO_ROOT = resolve(HERE, "..", "..");
const TOOL = join(
  REPO_ROOT,
  "dist", "claude",
  ".claude",
  "tools",
  "aidlc-state.ts"
);
const FIXTURES = join(REPO_ROOT, "tests", "fixtures");
const BUN = process.execPath; // the bun binary running this test

// --- Helpers ---------------------------------------------------------------

// P9 per-intent layout: the flat aidlc-docs/ root is retired. The state file
// lives in the active intent's record (seedStateFile seeds it so the cursor
// resolves for the spawned tool), and the audit trail is a per-clone SHARD under
// the record's audit/ dir. We PIN a deterministic clone-id so the shard path the
// spawned tool resolves is known — the EISDIR sabotage targets exactly that
// shard. No audit-seed is needed (ensureAuditFile creates the shard; the error()
// path only needs the state file to exist).
const PINNED_CLONE_ID = "testcloneid125";
function pinClone(proj: string): void {
  writeFileSync(join(proj, "aidlc", ".aidlc-clone-id"), `${PINNED_CLONE_ID}\n`, "utf-8");
}

// Seed a fresh temp project: aidlc-state.md from a fixture into the default
// record (so the active-intent cursor resolves). Returns the project dir.
function seedProject(stateFixture: string): string {
  const proj = createTestProject();
  seedStateFile(proj, stateFixture);
  pinClone(proj);
  return proj;
}

// Seed a temp project from an explicit state-file STRING (used for the
// complete-workflow precondition, which needs the final stage in-progress).
function seedProjectFromContent(content: string): string {
  const proj = createTestProject();
  mkdirSync(statePathDir(proj), { recursive: true });
  writeFileSync(seededStateFile(proj), content, "utf-8");
  pinClone(proj);
  return proj;
}

// Replace the resolved audit SHARD (a file) with a DIRECTORY at the same path →
// appendFileSync throws EISDIR for ALL uids. This is the t17 Test 65 injection,
// retargeted at the per-clone shard the (clone-id-pinned) tool resolves.
function sabotageAudit(proj: string): void {
  const auditShard = auditFilePath(proj);
  mkdirSync(join(auditShard, ".."), { recursive: true });
  rmSync(auditShard, { force: true, recursive: true });
  mkdirSync(auditShard);
}

function statePath(proj: string): string {
  return seededStateFile(proj);
}
function statePathDir(proj: string): string {
  return join(seededStateFile(proj), "..");
}

function readState(proj: string): string {
  return readFileSync(statePath(proj), "utf-8");
}

// Run aidlc-state.ts with --project-dir injected. Returns the exit status.
function runState(proj: string, args: string[]): number {
  const r = spawnSync(
    BUN,
    [TOOL, ...args, "--project-dir", proj],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
      },
    },
  );
  // spawnSync sets status to null only on signal kill; treat that as failure.
  return r.status === null ? -1 : r.status;
}

function cleanup(proj: string): void {
  // The injected directory must be removed recursively.
  cleanupTestProject(proj);
}

// The core assertion shared by every audit-emitting handler:
//   1. seed at the right precondition (preludeArgs runs BEFORE the snapshot),
//   2. snapshot state bytes,
//   3. inject EISDIR,
//   4. run the handler under test,
//   5. assert NON-ZERO exit AND byte-identical state.
// Returns nothing; throws via expect() on violation.
function assertAuditFirst(
  proj: string,
  handlerArgs: string[],
  preludeArgs: string[] | null
): { rc: number } {
  if (preludeArgs) {
    const prc = runState(proj, preludeArgs);
    expect(prc).toBe(0); // precondition setup must succeed
  }
  const before = readState(proj);
  sabotageAudit(proj);
  const rc = runState(proj, handlerArgs);
  const after = readState(proj);

  // (a) audit failure aborted the command.
  expect(rc).not.toBe(0);
  // (b) the mutation did not happen — state is byte-identical.
  expect(after).toBe(before);
  return { rc };
}

// --- Audit-emitting handlers (the audit-first sweep) -----------------------

describe("invariant: audit-first atomicity (emit-then-write) across state-mutating handlers", () => {
  // gate-start <slug>: [-] → [?]. feasibility is [-] in state-mid-ideation.
  test("gate-start: audit EISDIR ⇒ non-zero exit, state byte-unchanged", () => {
    const proj = seedProject("state-mid-ideation.md");
    try {
      assertAuditFirst(proj, ["gate-start", "feasibility"], null);
    } finally {
      cleanup(proj);
    }
  });

  // approve <slug>: [?] → [x] (+ auto-advance). Prelude gate-starts feasibility.
  test("approve: audit EISDIR ⇒ non-zero exit, state byte-unchanged", () => {
    const proj = seedProject("state-mid-ideation.md");
    try {
      assertAuditFirst(
        proj,
        ["approve", "feasibility"],
        ["gate-start", "feasibility"]
      );
    } finally {
      cleanup(proj);
    }
  });

  // reject <slug>: [?] → [R] (+ Revision Count++). Prelude gate-starts.
  test("reject: audit EISDIR ⇒ non-zero exit, state byte-unchanged", () => {
    const proj = seedProject("state-mid-ideation.md");
    try {
      assertAuditFirst(
        proj,
        ["reject", "feasibility", "--feedback", "needs work"],
        ["gate-start", "feasibility"]
      );
    } finally {
      cleanup(proj);
    }
  });

  // skip <slug>: [ ]/[-]/[R] → [S]. scope-definition is [ ] in mid-ideation.
  test("skip: audit EISDIR ⇒ non-zero exit, state byte-unchanged", () => {
    const proj = seedProject("state-mid-ideation.md");
    try {
      assertAuditFirst(
        proj,
        ["skip", "scope-definition", "--reason", "out of scope"],
        null
      );
    } finally {
      cleanup(proj);
    }
  });

  // advance <slug>: marks slug [x], next [-]. feasibility is [-] AND Current
  // Stage in mid-ideation — the normal post-approve transition shape.
  test("advance: audit EISDIR ⇒ non-zero exit, state byte-unchanged", () => {
    const proj = seedProject("state-mid-ideation.md");
    try {
      assertAuditFirst(proj, ["advance", "feasibility"], null);
    } finally {
      cleanup(proj);
    }
  });

  // complete-workflow <slug>: final stage. Precondition = the last in-scope
  // stage (feedback-optimization) is in-progress [-]. Build it by flipping the
  // all-[x] state-completed fixture's final checkbox back to [-].
  test("complete-workflow: audit EISDIR ⇒ non-zero exit, state byte-unchanged", () => {
    const allDone = readFileSync(
      join(FIXTURES, "state-completed.md"),
      "utf-8"
    );
    const finalInProgress = allDone.replace(
      "- [x] feedback-optimization — EXECUTE",
      "- [-] feedback-optimization — EXECUTE"
    );
    // Guard: the replacement must have actually fired, else the precondition is wrong.
    expect(finalInProgress).not.toBe(allDone);
    expect(finalInProgress.includes("- [-] feedback-optimization — EXECUTE")).toBe(true);

    const proj = seedProjectFromContent(finalInProgress);
    try {
      assertAuditFirst(
        proj,
        ["complete-workflow", "feedback-optimization"],
        null
      );
    } finally {
      cleanup(proj);
    }
  });

  // reuse-artifact <slug>: AUDIT-ONLY — emits ARTIFACT_REUSED and writes NO
  // state. Audit-first is trivially satisfied (there is nothing to write), but
  // we still pin: EISDIR ⇒ non-zero exit AND state byte-unchanged, so a future
  // edit that adds a state write to this handler without ordering it after the
  // audit emit is caught.
  test("reuse-artifact (audit-only): audit EISDIR ⇒ non-zero exit, state byte-unchanged", () => {
    const proj = seedProject("state-mid-ideation.md");
    try {
      assertAuditFirst(
        proj,
        [
          "reuse-artifact",
          "feasibility",
          "--decision",
          "keep",
          "--artifacts",
          "feasibility-report.md",
        ],
        null
      );
    } finally {
      cleanup(proj);
    }
  });
});

// --- Finding: finalize is NOT audit-first (it emits no audit) --------------

describe("finding: handleFinalize emits no audit ⇒ NOT subject to audit-first", () => {
  // handleFinalize (:456) has zero emitAudit() calls — only writeStateFile
  // (:508). Under the SAME EISDIR injection that aborts every audit-emitting
  // handler above, finalize exits 0 and mutates state, because the broken
  // audit.md is never touched. This is correct for an emit-free handler, but
  // pinned here so the asymmetry is visible: if someone later adds an
  // emitAudit() to finalize, this test FLIPS (rc≠0 / state unchanged) and
  // forces the author to (a) decide audit-first ordering and (b) move finalize
  // into the sweep above. The failure becomes the prompt to do that.
  test("finalize: audit EISDIR is IGNORED ⇒ exits 0 and mutates state (emit-free handler)", () => {
    const proj = seedProject("state-mid-ideation.md");
    try {
      const before = readState(proj);
      sabotageAudit(proj);
      const rc = runState(proj, ["finalize", "feasibility"]);
      const after = readState(proj);

      // ACTUAL behaviour: finalize never emits audit, so the broken audit.md
      // does not stop it. It succeeds and mutates state.
      expect(rc).toBe(0);
      expect(after).not.toBe(before);
    } finally {
      cleanup(proj);
    }
  });
});

// --- Meta: tool + fixtures exist (fail loud if the harness drifts) ----------

describe("t125 harness preconditions", () => {
  beforeAll(() => {
    // No-op; placeholder to keep the describe non-empty if asserts move.
  });
  afterAll(() => {
    // No temp dirs persist — each test cleans its own in finally.
  });

  test("aidlc-state.ts and required fixtures are present", () => {
    expect(existsSync(TOOL)).toBe(true);
    expect(existsSync(join(FIXTURES, "state-mid-ideation.md"))).toBe(true);
    expect(existsSync(join(FIXTURES, "state-completed.md"))).toBe(true);
    expect(existsSync(join(FIXTURES, "audit-sample.md"))).toBe(true);
  });
});
