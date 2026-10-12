// covers: subcommand:aidlc-swarm:prepare, subcommand:aidlc-swarm:check, subcommand:aidlc-swarm:finalize,
// subcommand:aidlc-bolt:release-merge, audit:SWARM_UNIT_CONVERGED
//
// A parallel Unit is built and reviewed, then its landing fails for a real reason:
// the person's pre-commit hook refuses it, or a peer landed first and this one
// conflicts. The person picks Retry. Every stop on the retry routes the swarm
// module prescribes must then let the same approved plan continue: `prepare` for
// a Unit already prepared in this attempt keeps its worktree instead of refusing
// against the parent's moved source, the worktree's own approval check still
// passes after finalize (release-merge must not stale its directive marker), and a
// second finalize reports the merged-back Unit converged instead of looping on
// "already merged". Nothing is asked twice; a changed plan still asks as today.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { auditBlockField, boltSlugForUnit, readAuditShardEvents, recordDir } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  approvePlan, cleanupCheckpointFixtures, fixture, git, nextDirective, prepare, publish, recordCommand, reviewRevisedSource,
  runCheckpointTool, swarm, wt, writeUnitSource,
} from "../harness/swarm-checkpoint.ts";
import { NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS } from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS);
afterEach(cleanupCheckpointFixtures);

type Prepared = { units: Array<{ unit: string; ok: boolean; worktree_path?: string; retained?: boolean; approval_transferred?: boolean; error?: string }> };
type Finalized = { converged: number; failed: number; merge_failures: Array<{ unit: string; detail: string }> };

function hook(project: string, body: string[]): void {
  const dir = join(project, ".git", "hooks");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "pre-commit");
  writeFileSync(path, ["#!/bin/sh", ...body, ""].join("\n"));
  chmodSync(path, 0o755);
}

function land(pd: string, unit: string) {
  return runCheckpointTool(pd, "tools/aidlc-worktree.ts", [
    "merge", "--slug", boltSlugForUnit(unit), "--target", "main", "--strategy", "squash", "--project-dir", pd,
  ]);
}

function rows(pd: string, event: string, unit?: string) {
  return readAuditShardEvents(pd).filter((row) => row.event === event &&
    (unit === undefined || auditBlockField(row.block, "Unit name") === unit || auditBlockField(row.block, "Bolt slug") === boltSlugForUnit(unit)));
}

// Build, check, review and finalize the Units of one batch; the batch converges.
function converge(pd: string, units: string[], extraWrites: string[] = []): void {
  const prepared = prepare(pd, units);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  units.forEach((unit, index) => {
    writeUnitSource(pd, unit, index + 2);
    for (const path of extraWrites) writeFileSync(join(wt(pd, unit), path), `export const shared = ${index + 2};\n`);
    const checked = swarm(pd, ["check", unit]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    reviewRevisedSource(pd, unit, [`src/${unit}.ts`, ...extraWrites]);
  });
  const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", units.join(","), "--claimed", units.join(",")]);
  expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
}

describe("Retry after a failed landing keeps the approved plan", () => {
  test("the person's pre-commit hook refuses the landing: prepare keeps the prepared Unit, the worktree still checks, finalize reports it converged, and the fixed landing goes through", () => {
    const pd = fixture(["alpha"]);
    converge(pd, ["alpha"]);
    const startsBefore = rows(pd, "SWARM_STARTED").length;
    hook(pd, ["echo 'lint: refused by the person' >&2", "exit 1"]);
    const refused = JSON.parse(land(pd, "alpha").out) as { status: string };
    expect(refused.status).toBe("commit-refused");

    // `next` keeps the approved plan; the swarm step's prepare must keep the Unit too.
    const directive = nextDirective(pd) as { kind: string; plan_approval?: { status: string } };
    expect(directive.kind).toBe("invoke-swarm");
    expect(directive.plan_approval?.status).toBe("approved");
    const again = prepare(pd);
    expect(again.code, `${again.out}\n${again.err}`).toBe(0);
    expect(again.out).not.toContain("Re-present and approve the plan");
    const row = (JSON.parse(again.out) as Prepared).units.find((entry) => entry.unit === "alpha");
    expect(row).toMatchObject({ ok: true, retained: true, worktree_path: wt(pd) });
    expect(rows(pd, "SWARM_STARTED")).toHaveLength(startsBefore);

    // The protocol's continuation check in the recorded worktree, and the referee's own check.
    const verified = runCheckpointTool(pd, "tools/aidlc-testing-posture.ts", ["verify", "--unit", "alpha", "--project-dir", wt(pd)]);
    expect(verified.code, `${verified.out}\n${verified.err}`).toBe(0);
    const checked = swarm(pd, ["check", "alpha"]);
    expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
    expect(JSON.parse(checked.out)).toMatchObject({ unit: "alpha", converged: true });

    // A second finalize is the pure re-invocation the swarm module promises.
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(JSON.parse(finalized.out) as Finalized).toMatchObject({ converged: 1, failed: 0, merge_failures: [] });
    expect(rows(pd, "SWARM_UNIT_CONVERGED", "alpha")).toHaveLength(1);
    expect(rows(pd, "STATE_MERGED", "alpha")).toHaveLength(1);

    // What the hook named is fixed; the same landing finishes and the stage settles.
    rmSync(join(pd, ".git", "hooks", "pre-commit"));
    const landed = land(pd, "alpha");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect(rows(pd, "SWARM_SOURCE_MERGED")).toHaveLength(1);
    expect((nextDirective(pd) as { kind: string }).kind).toBe("run-stage");
  });

  test("two Units wrote one file and the second landing conflicts: prepare keeps the second Unit after the first landed", () => {
    const pd = fixture(["alpha", "beta"]);
    converge(pd, ["alpha", "beta"], ["src/shared.ts"]);
    const first = land(pd, "alpha");
    expect(first.code, `${first.out}\n${first.err}`).toBe(0);
    const second = JSON.parse(land(pd, "beta").out) as { status: string; conflict_files?: string[] };
    expect(second).toMatchObject({ status: "conflict", conflict_files: ["src/shared.ts"] });

    const directive = nextDirective(pd) as { kind: string; units?: string[]; plan_approval?: { status: string } };
    expect(directive).toMatchObject({ kind: "invoke-swarm", units: ["beta"], plan_approval: { status: "approved" } });
    const again = prepare(pd, ["beta"]);
    expect(again.code, `${again.out}\n${again.err}`).toBe(0);
    expect(again.out).not.toContain("Re-present and approve the plan");
    const row = (JSON.parse(again.out) as Prepared).units.find((entry) => entry.unit === "beta");
    expect(row).toMatchObject({ ok: true, retained: true, worktree_path: wt(pd, "beta") });
    expect(existsSync(wt(pd, "beta"))).toBe(true);
  });

  test("a changed plan still asks: prepare refuses as before when the approved plan was edited", () => {
    const pd = fixture(["alpha"]);
    converge(pd, ["alpha"]);
    hook(pd, ["exit 1"]);
    expect((JSON.parse(land(pd, "alpha").out) as { status: string }).status).toBe("commit-refused");
    const plan = join(pd, "aidlc", "spaces", "default", "intents");
    const planPath = Bun.spawnSync(["git", "-C", pd, "ls-files", "--", "*/alpha/code-generation/code-generation-plan.md"], { stdout: "pipe" })
      .stdout.toString().trim();
    expect(planPath.length, plan).toBeGreaterThan(0);
    writeFileSync(join(pd, planPath), `${readFileSync(join(pd, planPath), "utf-8")}\n## Scope change\n\nA paragraph the person did not approve.\n`);
    const again = prepare(pd);
    expect(again.code).not.toBe(0);
    expect(again.out + again.err).toContain("prepare requires a current, explicitly approved Code Generation plan");
  });
});

// A fresh review of the worktree's current source, the way the reviewer records
// it (its review file is the one the request names).
function reviewAgain(pd: string, unit: string, iteration: number): void {
  const child = wt(pd, unit);
  const args = ["review", "--stage", "code-generation", "--unit", unit, "--reviewer", "aidlc-architecture-reviewer-agent",
    "--iteration", String(iteration), "--project-dir", child];
  const requested = runCheckpointTool(child, "tools/aidlc-log.ts", args);
  expect(requested.code, `${requested.out}\n${requested.err}`).toBe(0);
  const request = readAuditShardEvents(child).filter((row) => row.event === "REVIEW_REQUESTED").at(-1)!;
  const reviewFile = join(recordDir(child)!, auditBlockField(request.block, "Review File")!);
  mkdirSync(join(reviewFile, ".."), { recursive: true });
  writeFileSync(reviewFile, `## Review\n\n**Verdict:** READY\n**Reviewer:** aidlc-architecture-reviewer-agent\n**Iteration:** ${iteration}\n\n### Findings\n\nNo blocking findings.\n`);
  const recorded = runCheckpointTool(child, "tools/aidlc-log.ts", [...args, "--verdict", "READY"]);
  expect(recorded.code, `${recorded.out}\n${recorded.err}`).toBe(0);
}

function verify(pd: string, unit: string, projectDir = pd) {
  const r = runCheckpointTool(pd, "tools/aidlc-testing-posture.ts", ["verify", "--unit", unit, "--project-dir", projectDir]);
  expect(r.code, `${r.out}\n${r.err}`).toBe(0);
  return JSON.parse(r.out) as { ok: boolean; approvalFingerprint: string | null };
}

describe("a Retry that changed what was verified or approved", () => {
  test("the worker moved the source after the refused landing: a fresh review, finalize again, and the landing lands the new source", () => {
    const pd = fixture(["alpha"]);
    converge(pd, ["alpha"]);
    hook(pd, ["exit 1"]);
    expect((JSON.parse(land(pd, "alpha").out) as { status: string }).status).toBe("commit-refused");
    // Retry: the worker re-runs inside the existing worktree and changes the source.
    writeUnitSource(pd, "alpha", 3);
    expect(swarm(pd, ["check", "alpha"]).code).toBe(0);
    reviewAgain(pd, "alpha", 2);
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    expect(JSON.parse(finalized.out) as Finalized).toMatchObject({ converged: 1, failed: 0, merge_failures: [] });
    const converged = rows(pd, "SWARM_UNIT_CONVERGED", "alpha");
    expect(converged).toHaveLength(2);
    expect(auditBlockField(converged[1].block, "Source Commit")).not.toBe(auditBlockField(converged[0].block, "Source Commit"));
    expect(rows(pd, "STATE_MERGED", "alpha")).toHaveLength(1);
    rmSync(join(pd, ".git", "hooks", "pre-commit"));
    // The first attempt's landing is still staged in the main checkout; the refusal
    // named `git reset --merge` as the way to drop it.
    git(pd, ["reset", "--merge"]);
    const landed = land(pd, "alpha");
    expect(landed.code, `${landed.out}\n${landed.err}`).toBe(0);
    expect(readFileSync(join(pd, "src", "alpha.ts"), "utf-8")).toBe("export const alpha = 3;\n");
    expect(rows(pd, "SWARM_SOURCE_MERGED")).toHaveLength(1);
  });

  test("the person authorized another verification command before the retry: finalize again records it", () => {
    const pd = fixture(["alpha"]);
    converge(pd, ["alpha"]);
    hook(pd, ["exit 1"]);
    expect((JSON.parse(land(pd, "alpha").out) as { status: string }).status).toBe("commit-refused");
    recordCommand(pd, "git status --short");
    // The swarm directive is bound to the state it was published for; a live run re-issues it with the next `next`.
    publish(pd, ["alpha"]);
    expect(swarm(pd, ["check", "alpha"]).code).toBe(0);
    const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
    expect(finalized.code, `${finalized.out}\n${finalized.err}`).toBe(0);
    const converged = rows(pd, "SWARM_UNIT_CONVERGED", "alpha");
    expect(converged).toHaveLength(2);
    expect(auditBlockField(converged[1].block, "Command SHA-256")).not.toBe(auditBlockField(converged[0].block, "Command SHA-256"));
    expect(auditBlockField(converged[1].block, "Source Fingerprint")).toBe(auditBlockField(converged[0].block, "Source Fingerprint"));
    // The same command and source a third time: nothing new is written.
    expect(swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]).code).toBe(0);
    expect(rows(pd, "SWARM_UNIT_CONVERGED", "alpha")).toHaveLength(2);
  });

  test("the plan was revised and approved again after the refused landing: prepare keeps the worktree and hands it the new approval", () => {
    const pd = fixture(["alpha"]);
    converge(pd, ["alpha"]);
    hook(pd, ["exit 1"]);
    expect((JSON.parse(land(pd, "alpha").out) as { status: string }).status).toBe("commit-refused");
    approvePlan(pd, "alpha", "revised");
    const again = prepare(pd);
    expect(again.code, `${again.out}\n${again.err}`).toBe(0);
    const row = (JSON.parse(again.out) as Prepared).units.find((entry) => entry.unit === "alpha");
    expect(row).toMatchObject({ ok: true, retained: true, approval_transferred: true, worktree_path: wt(pd) });
    const childPlan = readFileSync(join(codeGenerationRecordDir(wt(pd), "alpha"), "code-generation-plan.md"), "utf-8");
    expect(childPlan).toContain("# revised plan for alpha");
    const parent = verify(pd, "alpha");
    const child = verify(pd, "alpha", wt(pd));
    expect(child.ok).toBe(true);
    expect(child.approvalFingerprint).toBe(parent.approvalFingerprint);
    // Unchanged since: the next prepare transfers nothing and keeps the worktree as it is.
    const third = prepare(pd);
    expect(third.code, `${third.out}\n${third.err}`).toBe(0);
    expect((JSON.parse(third.out) as Prepared).units[0]).toMatchObject({ ok: true, retained: true });
    expect((JSON.parse(third.out) as Prepared).units[0].approval_transferred).toBeUndefined();
  });
});

describe("a re-approved plan that cannot reach the kept worktree", () => {
  test("a peer landed first and the second Unit's plan was approved again: prepare keeps the work, says so in plain words, and names the two ways on", () => {
    const pd = fixture(["alpha", "beta"]);
    converge(pd, ["alpha", "beta"], ["src/shared.ts"]);
    expect(land(pd, "alpha").code).toBe(0);
    expect((JSON.parse(land(pd, "beta").out) as { status: string }).status).toBe("conflict");
    git(pd, ["reset", "--merge"]);
    const before = readFileSync(join(wt(pd, "beta"), "src", "beta.ts"), "utf-8");
    approvePlan(pd, "beta", "revised");
    const again = prepare(pd, ["beta"]);
    expect(again.code).toBe(2);
    const row = (JSON.parse(again.out) as Prepared).units.find((entry) => entry.unit === "beta")!;
    expect(row).toMatchObject({ ok: false, retained: true, worktree_path: wt(pd, "beta") });
    expect(row.error).toContain("the plan approved again could not be handed to its existing build");
    expect(row.error).toContain("The build and its work are kept");
    expect(row.error).toContain("set this Unit's current work aside (abort and discard it) and run prepare again");
    expect(row.error).toContain("land it as it is");
    expect(again.out).not.toContain("Re-present and approve the plan");
    expect(existsSync(wt(pd, "beta"))).toBe(true);
    expect(readFileSync(join(wt(pd, "beta"), "src", "beta.ts"), "utf-8")).toBe(before);
  });
});
