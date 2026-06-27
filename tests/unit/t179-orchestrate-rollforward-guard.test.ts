// covers: subcommand:aidlc-orchestrate:next, file:harness/kiro/hooks/aidlc-kiro-adapter.ts
//
// SUBJECT: Branch 0 of aidlc-orchestrate.ts handleNext (~:887-929) — the
// turn-scoped no-op-next guard (the Kiro roll-forward defense). On Kiro the
// userPromptSubmit seam (harness/kiro/hooks/aidlc-kiro-adapter.ts) runs a
// read-only/navigation command off-band, bumps aidlc/.aidlc-turn-counter, and
// stamps aidlc/.aidlc-readonly-latch ({turn,flag,source,ts}) with the CURRENT
// turn. The seam cannot block the turn, so the conductor relays the output and
// may STILL fire a bare advancing `next`, rolling the active workflow forward.
// Branch 0 catches that: BEFORE any state inspection, a TRULY BARE advancing
// `next` (none of its own flags set) checks the latch and emits {kind:"done"}
// when counter>=0 AND latch.turn===counter (the SAME turn). Turn-scoped — a
// stale latch (an earlier turn) never swallows a legitimate later `next`. Inert
// on Claude/Codex: no seam writes the files, so the guard falls through.
//
// This is the DETERMINISTIC regression guard for that branch: reverting Branch 0
// leaves the live-gated e2e green but FAILS test 1 here (a fresh-latch bare
// `next` would route to run-stage instead of done). Unit tier — no LLM, no
// network. Spawns the engine exactly like t114 (bun aidlc-orchestrate.ts next
// ... --project-dir <proj>), seeds the per-intent fixture, parses the directive
// JSON off stdout.
//
// CASES:
//   1  counter=N, latch{turn:N}  bare next        -> {kind:"done"}   (fresh latch fires)
//   2  counter=N, latch{turn:N-1} bare next       -> NOT done        (stale latch -> run-stage)
//   3  counter=N, latch{turn:N}  next --status    -> {kind:"print"}  (readOnly exempts Branch 0)
//   4  counter=N, latch{turn:N}  next --single ...  -> NOT done       (single exempts Branch 0 — the Phase-1 parity fix)
//   5  NO counter/latch files     bare next        -> NOT done        (guard inert on the Claude/Codex path)
//
// Source cites (core/tools/aidlc-orchestrate.ts):
//   :900 the exemption gate — Branch 0 runs ONLY when none of readOnly/
//        workspaceVerb/stage/phase/scope/intent/resume/depth/testStrategy/
//        single is set (so --status and --single both skip it).
//   :910 reads aidlc/.aidlc-turn-counter (integer); absent -> counter stays -1.
//   :914 reads aidlc/.aidlc-readonly-latch (JSON {turn,flag,source}).
//   :922 fires {kind:"done"} only when counter>=0 AND latchTurn===counter.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  FIXTURES_DIR,
  resetAidlcEnv,
  seedStateFile,
} from "../harness/fixtures.ts";

const BUN = process.execPath; // the bun running this test
const TOOL = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");

const MID_IDEATION = join(FIXTURES_DIR, "state-mid-ideation.md");

interface RunResult {
  rc: number;
  out: string; // combined stdout+stderr (mirrors t114's 2>&1)
}

// Run `bun aidlc-orchestrate.ts next <args> --project-dir <proj>` — identical
// spawn convention to t114's runNext.
function runNext(proj: string, args: string[]): RunResult {
  const res = spawnSync(BUN, [TOOL, "next", ...args, "--project-dir", proj], {
    encoding: "utf-8",
    cwd: proj,
  });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  return { rc: res.status ?? -1, out: `${stdout}${stderr}` };
}

// Stamp the per-turn counter + the read-only latch the Kiro seam writes, at the
// SAME paths the engine reads (resolveProjectDir(--project-dir)/aidlc/...). The
// latch JSON shape matches aidlc-kiro-adapter.ts:137 ({turn,flag,source,ts}).
function seedLatch(proj: string, counter: number, latchTurn: number): void {
  const aidlc = join(proj, "aidlc");
  mkdirSync(aidlc, { recursive: true }); // already created by the fixture; idempotent
  writeFileSync(join(aidlc, ".aidlc-turn-counter"), `${counter}\n`, "utf-8");
  writeFileSync(
    join(aidlc, ".aidlc-readonly-latch"),
    `${JSON.stringify({ turn: latchTurn, flag: "status", source: "read-only-flag", ts: Date.now() })}\n`,
    "utf-8",
  );
}

let proj = "";
beforeAll(() => {
  resetAidlcEnv();
});
afterEach(() => {
  resetAidlcEnv();
  cleanupTestProject(proj);
  proj = "";
});

// ===========================================================================
// Branch 0 — fresh latch (latch.turn === counter) swallows a bare advancing
// next into {kind:"done"}. With MID_IDEATION seeded, a guard-LESS engine would
// route this to run-stage:feasibility (t114 test 1) — so a done here proves
// Branch 0 intercepted BEFORE state inspection. This is the assertion that
// FAILS if Branch 0 is reverted.
// ===========================================================================
describe("t179 Branch 0: fresh latch -> done", () => {
  test("1: counter=N, latch{turn:N}, bare next -> {kind:\"done\"} (guard fires)", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedLatch(proj, 3, 3);
    const out = runNext(proj, []).out;
    expect(out).toContain('"kind":"done"');
    // The done is the guard's, not some other terminal: its reason names the
    // read-only/navigation nothing-to-advance contract.
    expect(out).toContain("nothing to advance");
    // It MUST NOT have routed into the active stage.
    expect(out).not.toContain('"kind":"run-stage"');
  });
});

// ===========================================================================
// Branch 0 — a STALE latch (an earlier turn) never swallows the next. The guard
// is turn-scoped: latchTurn (N-1) !== counter (N), so it falls through and the
// normal happy path emits run-stage for the in-flight current stage.
// ===========================================================================
describe("t179 Branch 0: stale latch -> not done", () => {
  test("2: counter=N, latch{turn:N-1} (stale), bare next -> run-stage, NOT done", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedLatch(proj, 3, 2);
    const out = runNext(proj, []).out;
    expect(out).not.toContain('"kind":"done"');
    expect(out).not.toContain("nothing to advance");
    // Falls through to the happy path for the in-flight stage.
    expect(out).toContain('"kind":"run-stage"');
  });
});

// ===========================================================================
// Branch 0 exemption — a read-only flag (--status) sets flags.readOnly, so the
// :900 gate is false and Branch 0 is skipped entirely; the next branch (Branch
// 1, read-only dispatch) emits a print. A fresh latch present does NOT swallow
// it into done.
// ===========================================================================
describe("t179 Branch 0 exemption: --status -> print", () => {
  test("3: counter=N, latch{turn:N}, next --status -> {kind:\"print\"} (readOnly exempts Branch 0)", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedLatch(proj, 3, 3);
    const out = runNext(proj, ["--status"]).out;
    expect(out).toContain('"kind":"print"');
    expect(out).not.toContain('"kind":"done"');
  });
});

// ===========================================================================
// Branch 0 exemption — --single sets flags.single, so the :900 gate is false
// (the Phase-1 parity fix added !flags.single to the exclusion list). Even with
// a fresh latch, a single-stage run is NOT swallowed into done; it routes to the
// single run-stage path (Branch at :1067). Seeded MID_IDEATION is feature scope
// with feasibility in scope, so --stage feasibility resolves to a run-stage.
// ===========================================================================
describe("t179 Branch 0 exemption: --single -> not done", () => {
  test("4: counter=N, latch{turn:N}, next --single --stage feasibility -> NOT done (single exempts Branch 0)", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    seedLatch(proj, 3, 3);
    const out = runNext(proj, ["--single", "--stage", "feasibility"]).out;
    expect(out).not.toContain('"kind":"done"');
    expect(out).not.toContain("nothing to advance");
    // Routes to the single run-stage path, not the guard.
    expect(out).toContain('"kind":"run-stage"');
  });
});

// ===========================================================================
// Branch 0 inert on the Claude/Codex path — with NO counter/latch files written
// (no seam exists there), counter stays -1 (:907/:910 never set it), so the
// :922 condition (counter>=0) is false and the guard falls through. A bare next
// routes to the normal happy path (run-stage), never done.
// ===========================================================================
describe("t179 Branch 0 inert: no latch files -> not done", () => {
  test("5: NO counter/latch files, bare next -> NOT done (guard inert)", () => {
    proj = createTestProject();
    seedStateFile(proj, MID_IDEATION);
    // Deliberately seed NO latch/counter — the Claude/Codex (no-seam) shape.
    const out = runNext(proj, []).out;
    expect(out).not.toContain('"kind":"done"');
    expect(out).not.toContain("nothing to advance");
    expect(out).toContain('"kind":"run-stage"');
  });
});
