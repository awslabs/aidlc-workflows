// covers: subcommand:aidlc-worktree:merge, audit:CHANGE_ACCEPTED
//
// The record of what Code Generation started from cannot be read on this
// machine when the swarm lands an attempt's first reviewed Unit. The landing
// follows the rule stage completion keeps for that record: a copy that is not
// here (a fresh clone, a teammate's machine) is said once and the work carries
// on, under every Guard Policy; one that is here and does not match, or that
// could not be taken, carries on under relaxed or off, and under strict stops
// naming the two steps that work there. It is never said as a change of the
// person's, the next Unit's landing, the batch checkpoint and the stage's
// completion do not say it again, and the stage completes.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditBlockField, boltSlugForUnit, currentStageSourceBaseline, currentSwarmSourceMergeChain, getField,
  readAuditShardEvents, recordDir,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { seedBoltDagBatches, seededStateFile } from "../harness/fixtures.ts";
import {
  CHECK, cleanupCheckpointFixtures, fixture, humanChoice, nextDirective, prepare, reviewRevisedSource, runCheckpointTool,
  STAGE, swarm, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);

type Run = { code: number | null; out: string; err: string };
const LINE = "I could not check Code Generation for files changed outside the units on this machine; carrying on.";
const UNITS = ["alpha", "beta"];

function ok(run: Run): Run {
  expect(run.code, `${run.out}\n${run.err}`).toBe(0);
  return run;
}

// Both Units built, checked, reviewed and finalized side by side, as one batch.
function converged(policy: string): string {
  const pd = fixture(UNITS, CHECK, false, null, policy);
  seedBoltDagBatches(pd, [UNITS]);
  ok(prepare(pd, UNITS));
  for (const unit of UNITS) {
    writeUnitSource(pd, unit, 2);
    ok(swarm(pd, ["check", unit]));
    reviewRevisedSource(pd, unit);
  }
  ok(swarm(pd, ["finalize", "--batch", "1", "--units", UNITS.join(","), "--claimed", UNITS.join(",")]));
  return pd;
}

function baselines(pd: string): string[] {
  const dir = join(recordDir(pd)!, ".aidlc-engine", "source-review", STAGE);
  return readdirSync(dir).filter((name) => name.startsWith("baseline-")).map((name) => join(dir, name));
}

// What a fresh clone or a teammate's machine has: the audit names the record,
// and AI-DLC's own ignored copy of it is not here.
function lose(pd: string): void {
  for (const path of baselines(pd)) rmSync(path);
}

function change(pd: string): void {
  for (const path of baselines(pd)) writeFileSync(path, "workspace\nnot the listing it was\n");
}

// The record could not be taken when the work started (the walk failed then).
function unbindable(pd: string): void {
  const dir = join(recordDir(pd)!, "audit");
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/(\*\*Source Baseline\*\*: )sha256:[0-9a-f]+/g, "$1unbindable"));
  }
}

function land(pd: string, unit: string): Run {
  return runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
    "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
  ]);
}

// How many times the line reaches the person: the merge's notices and the
// steps' change notices (the merge's stderr note repeats its own notices).
function said(runs: Run[]): number {
  return runs.reduce((count, run) => count + run.out.split(LINE).length - 1, 0);
}

function unchecked(pd: string) {
  return readAuditShardEvents(pd).filter((row) =>
    row.event === "CHANGE_ACCEPTED" && auditBlockField(row.block, "Checkpoint") === "swarm-batch" &&
    auditBlockField(row.block, "Recorded") === "(stage start unavailable)");
}

function report(pd: string, result: string, extra: string[] = []): Run & { kind: string; message?: string } {
  const run = runCheckpointTool(pd, "tools/aidlc-orchestrate.ts", [
    "report", "--stage", STAGE, "--result", result, ...extra, "--project-dir", pd,
  ]);
  const parsed = JSON.parse(run.out.trim().split(/\r?\n/).at(-1)!) as { kind: string; message?: string };
  return { ...run, ...parsed };
}

function checkpoint(pd: string, action: string, extra: string[] = []): Run {
  return ok(runCheckpointTool(pd, "tools/aidlc-bolt.ts", [
    "swarm-checkpoint", "--action", action, "--batch", "1", "--units", UNITS.join(","), "--session", "batch",
    ...extra, "--project-dir", pd,
  ]));
}

// Both Units land, then the person approves the batch and Code Generation;
// every step's output, for the count.
function landsAndCompletes(pd: string): Run[] {
  const runs = UNITS.map((unit) => ok(land(pd, unit)));
  for (const run of runs) expect(run.err).not.toContain("during the build");
  expect(nextDirective(pd)).toMatchObject({
    kind: "run-stage", swarm_checkpoint: { batch: 1, units: UNITS, ready: true, approved: false },
  });
  runs.push(checkpoint(pd, "ask"));
  humanChoice(pd, "Approve", "batch");
  const approved = checkpoint(pd, "approve", ["--user-input", "Approve"]);
  expect(JSON.parse(approved.out).approved).toBe(true);
  const shown = report(pd, "awaiting-approval");
  expect(shown.kind, shown.message).not.toBe("error");
  humanChoice(pd, "Approve", "stage");
  const done = report(pd, "approved", ["--user-input", "Approve"]);
  expect(done.kind, done.message).not.toBe("error");
  expect(readFileSync(seededStateFile(pd), "utf-8")).toContain("- [x] code-generation");
  return [...runs, approved, shown, done];
}

describe("the record of what the stage started from is not on this machine", () => {
  for (const policy of ["strict", "off"]) {
    test(`${policy}: the first Unit lands with one line, the next with none, and the stage completes`, () => {
      const pd = converged(policy);
      lose(pd);
      const runs = landsAndCompletes(pd);
      expect(runs[0].err).toContain(`note: ${LINE}`);
      expect(said([runs[1]])).toBe(0);
      expect(said(runs)).toBe(1);
      expect(unchecked(pd)).toHaveLength(1);
    });
  }

  // The person's own pre-commit hook refuses the first landing; they fix it and
  // run the same merge again, which finishes the landing it staged.
  test("off: a first landing the person's hook refused finishes with the one line, recorded once", () => {
    const pd = converged("off");
    lose(pd);
    const hook = join(pd, ".git", "hooks", "pre-commit");
    mkdirSync(join(hook, ".."), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho 'lint: refused by the person' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const refused = land(pd, "alpha");
    expect(JSON.parse(refused.out).status, refused.err).toBe("commit-refused");
    expect(said([refused])).toBe(0);
    rmSync(hook);
    const runs = landsAndCompletes(pd);
    expect(said([runs[0]])).toBe(1);
    expect(said([refused, ...runs])).toBe(1);
    expect(unchecked(pd)).toHaveLength(1);
  });

  // A teammate's machine that has the record reads the same chain.
  test("the landed chain stands on a machine that reads the record, or another where it changed", () => {
    const pd = converged("strict");
    const kept = new Map(baselines(pd).map((path) => [path, readFileSync(path)]));
    lose(pd);
    ok(land(pd, "alpha"));
    for (const [path, bytes] of kept) writeFileSync(path, bytes);
    expect(currentStageSourceBaseline(pd, STAGE, true).state).toBe("ready");
    expect(currentSwarmSourceMergeChain(pd, STAGE).state).toBe("ready");
    change(pd);
    expect(currentSwarmSourceMergeChain(pd, STAGE).state).toBe("ready");
  });
});

describe("the record is here but does not match, or could not be taken", () => {
  test("off: a changed record lands with the one line, and the stage completes", () => {
    const pd = converged("off");
    change(pd);
    const runs = landsAndCompletes(pd);
    expect(runs[0].err).toContain(`note: ${LINE}`);
    expect(said(runs)).toBe(1);
  });

  test("strict: a changed record stops naming it and both steps, and Guard Policy relaxed then lands it", () => {
    const pd = converged("strict");
    change(pd);
    const refused = land(pd, "alpha");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("AI-DLC has no usable record of what Code Generation started from");
    expect(refused.err).toContain("--stage code-generation` to check again from here");
    expect(refused.err).toContain("with the person's go-ahead, set Guard Policy relaxed for this piece of work and run the merge again");
    expect(refused.err).not.toContain("no verifiable predecessor");
    expect(unchecked(pd)).toHaveLength(0);
    humanChoice(pd, "set guard policy relaxed for this work", "relax");
    const asked = auditBlockField(readAuditShardEvents(pd).filter((row) => row.event === "HUMAN_TURN").at(-1)!.block, "Message Id")!;
    ok(runCheckpointTool(pd, "tools/aidlc-utility.ts", [
      "config-change", "--guard-policy", "relaxed", "--message", asked, "--project-dir", pd,
    ]));
    expect(getField(readFileSync(seededStateFile(pd), "utf-8"), "Guard Policy")).toBe("relaxed (set by you)");
    const runs = landsAndCompletes(pd);
    expect(runs[0].err).toContain(`note: ${LINE}`);
    expect(said([refused, ...runs])).toBe(1);
  });

  test("off: a record that could not be taken lands with the one line, and the stage completes", () => {
    const pd = converged("off");
    unbindable(pd);
    const runs = landsAndCompletes(pd);
    expect(runs[0].err).toContain(`note: ${LINE}`);
    expect(said(runs)).toBe(1);
  });

  // The restart is the stage's own redo: a new record of where it starts, and
  // the new attempt asks for its plans again.
  test("strict: a record that could not be taken stops naming it, and the restart it names is accepted", () => {
    const pd = converged("strict");
    unbindable(pd);
    const refused = land(pd, "alpha");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("AI-DLC could not record what Code Generation started from");
    expect(refused.err).toContain("--stage code-generation` to check again from here");
    const restart = ok(runCheckpointTool(pd, "tools/aidlc-orchestrate.ts", ["next", "--stage", STAGE, "--project-dir", pd]));
    // The jump it names, whatever runtime flags come before the tool's path.
    const jump = /aidlc-jump\.ts (execute [^`]+)`/.exec(restart.out);
    expect(jump, restart.out).not.toBeNull();
    ok(runCheckpointTool(pd, "tools/aidlc-jump.ts", [...jump![1].split(" "), "--project-dir", pd]));
    expect(currentStageSourceBaseline(pd, STAGE, true).state).toBe("ready");
    expect(nextDirective(pd)).toMatchObject({ kind: "ask", ask_type: "plan-approval", stage: STAGE });
  });
});
