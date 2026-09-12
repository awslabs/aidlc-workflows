// covers: audit:GATE_APPROVED, audit:GATE_REJECTED, function:currentSwarmSourceMergeChain,
// function:approvedConstructionUnits, function:unitSourceFingerprint, subcommand:aidlc-bolt:swarm-checkpoint

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  approveSwarmCheckpoint,
  rejectSwarmCheckpoint,
  resolveSwarmCheckpoint,
} from "../../dist/claude/.claude/tools/aidlc-swarm-checkpoints.ts";
import {
  approveConstructionCheckpoint,
  verifyConstructionCheckpoint,
} from "../../dist/claude/.claude/tools/aidlc-construction-checkpoints.ts";
import {
  approvedConstructionUnits,
  artifactFilename,
  auditBlockField,
  currentSwarmSourceMergeChain,
  findStageBySlug,
  gitCommitSourceListing,
  latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents,
  readUnitSourceManifest,
  reviewArtifactFingerprint,
  serializeSourceListing,
  setField,
  sourceListingSha256,
  unitMajorConstructionStageSlugs,
  unitSourceFingerprint,
  workspaceSourceFingerprint,
  workspaceSourceListing,
  writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seedBoltDagBatches,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();
const projects: string[] = [];
const STAGE = "code-generation";
const BATCH = ["alpha", "beta"];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

function git(pd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: pd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function state(autonomous = false): string {
  return `# AI-DLC State Tracking

## Project Information
- **Scope**: feature
- **Project Type**: Greenfield
- **State Version**: 8
- **Skeleton Stance**: off

## Runtime State
- **Construction Checkpoints**: enabled
- **Construction Iteration**: stage-major
- **Construction Execution**: swarm
- **Construction Autonomy Mode**: ${autonomous ? "autonomous" : "gated"}
- **Unit Ownership**: solo
- **Review Override**: none
- **Change Control**: strict

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Test Strategy**: Standard

## Stage Progress
### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [x] nfr-requirements — EXECUTE
- [x] nfr-design — EXECUTE
- [x] infrastructure-design — EXECUTE
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`;
}

function artifacts(pd: string, unit: string, stage = STAGE): void {
  const definition = findStageBySlug(stage)!;
  const dir = join(seededRecordDir(pd), "construction", unit, stage);
  mkdirSync(dir, { recursive: true });
  for (const name of definition.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${stage} ${unit} ${name}\n`);
  }
  if (definition.workspace_requires) {
    writeFileSync(join(dir, "source-manifest.json"), JSON.stringify({
      stage, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
    }));
  }
}

function fixture(autonomous = false): string {
  const pd = createTestProject();
  projects.push(pd);
  seedAidlcMemory(pd);
  writeFileSync(seededStateFile(pd), state(autonomous));
  seedBoltDagBatches(pd, [BATCH, ["gamma"]]);
  mkdirSync(join(pd, "src"), { recursive: true });
  for (const unit of [...BATCH, "gamma"]) {
    writeFileSync(join(pd, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
    artifacts(pd, unit);
  }
  for (const args of [
    ["init", "-q"], ["config", "user.name", "AI-DLC Tests"],
    ["config", "user.email", "tests@example.com"], ["add", "-A"], ["commit", "-qm", "baseline"],
  ]) git(pd, args);
  const listing = workspaceSourceListing(pd)!;
  const baseline = writeBaselineSourceSnapshot(pd, STAGE, listing);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
  if (autonomous) appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, pd);
  return pd;
}

// Protected append factory stands in for the existing review/finalize/merge
// emitters. All content bindings use real files and immutable Git source.
function converge(pd: string, batch = 1, units = BATCH, kind = "bound"): void {
  const floor = latestMainWorkflowStageRunFloorForProject(pd, STAGE);
  const listing = workspaceSourceListing(pd)!;
  const fingerprint = workspaceSourceFingerprint(pd)!;
  const commit = git(pd, ["rev-parse", "HEAD"]);
  const committed = gitCommitSourceListing(pd, commit, true);
  expect(committed).not.toBeNull();
  expect(serializeSourceListing(committed!)).toBe(serializeSourceListing(listing));
  const chain = currentSwarmSourceMergeChain(pd, STAGE);
  let previous = chain.state === "ready" ? chain.fingerprint
    : sourceListingSha256(serializeSourceListing(listing));
  appendAuditEntry("SWARM_STARTED", {
    Stage: STAGE, "Run floor": floor, "Batch number": String(batch), "Unit obligations": "alpha, beta, gamma",
  }, pd);
  for (const unit of units) {
    const manifest = readUnitSourceManifest(pd, STAGE, unit);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) throw new Error(manifest.reason);
    appendAuditEntry("REVIEW_COMPLETED", {
      Stage: STAGE, Unit: unit, Verdict: "approved",
      "Artifact Fingerprint": reviewArtifactFingerprint(pd, findStageBySlug(STAGE)!, unit, { requireRequiredArtifacts: true })!,
      "Source Fingerprint": fingerprint,
      "Unit Source Fingerprint": unitSourceFingerprint(listing, manifest, manifest.rawBytesSha256),
    }, pd);
    appendAuditEntry("SWARM_UNIT_CONVERGED", {
      Stage: STAGE, "Run floor": kind === "stale" ? "unstarted#0" : floor,
      "Batch number": String(batch), "Unit name": unit,
      ...(kind === "legacy" ? {} : kind === "bypass" ? { "Source Freshness Bypass": "true" } : {
        "Source Commit": commit, "Source Fingerprint": fingerprint,
      }),
    }, pd);
    if (kind !== "unmerged") {
      appendAuditEntry("SWARM_SOURCE_MERGED", {
        Stage: STAGE, "Run floor": floor, "Batch number": String(batch), "Unit name": unit,
        "Source Commit": commit, "Merge commit": commit, Repo: "-",
        "Previous Source Fingerprint": previous, "Source Fingerprint": fingerprint,
      }, pd);
    }
    previous = fingerprint;
  }
}

function human(pd: string): void {
  appendAuditEntry("HUMAN_TURN", { Source: "t343 prompt-submit fixture" }, pd);
}

function gates(pd: string, event = "GATE_APPROVED") {
  return readAuditShardEvents(pd).filter((row) => row.event === event && auditBlockField(row.block, "Checkpoint") === "swarm-batch");
}

describe("t343 completed swarm batch checkpoints", () => {
  test("re-recording unchanged native evidence preserves the completed batch approval", () => {
    const pd = fixture();
    converge(pd);
    human(pd);
    const first = approveSwarmCheckpoint(pd, 1, BATCH, "Approve");
    // Refresh verification receipts for the existing immutable merge; a second
    // source-merge receipt would correctly be rejected as duplicate authority.
    converge(pd, 1, BATCH, "unmerged");
    const refreshed = resolveSwarmCheckpoint(pd, 1, BATCH);
    expect(refreshed.ready, refreshed.errors.join("\n")).toBe(true);
    expect(refreshed.fingerprint).toBe(first.fingerprint);
    expect(refreshed.approved).toBe(true);
  }, 30_000);

  test("the checkpoint CLI exposes the current named batch and refuses a different set", () => {
    const pd = fixture();
    converge(pd);
    const run = (units: string) => spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-bolt.ts"), "swarm-checkpoint",
      "--action", "status", "--batch", "1", "--units", units, "--project-dir", pd,
    ], { encoding: "utf-8" });
    const valid = run(BATCH.join(","));
    expect(valid.status, `${valid.stdout}${valid.stderr}`).toBe(0);
    expect(JSON.parse(valid.stdout).ready).toBe(true);
    expect(JSON.parse(valid.stdout).units).toEqual(BATCH);
    expect(run("alpha").status).not.toBe(0);
  }, 30_000);

  test("the exact completed batch uses native evidence and one human approval row", () => {
    const pd = fixture();
    converge(pd);
    const before = resolveSwarmCheckpoint(pd, 1, [...BATCH].reverse());
    expect(before.units).toEqual(BATCH);
    expect(before.errors).toEqual([]);
    expect(before.ready).toBe(true);
    expect(before.approved).toBe(false);
    expect(before.human_required).toBe(true);
    human(pd);
    const approved = approveSwarmCheckpoint(pd, 1, BATCH, "Approve");
    expect(approved.approved).toBe(true);
    expect(approved.fingerprint).toBe(before.fingerprint);
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).approved).toBe(true);
    const rows = gates(pd);
    expect(rows).toHaveLength(1);
    for (const [field, value] of Object.entries({
      Stage: STAGE, "Batch number": "1", Units: "alpha, beta",
      Fingerprint: before.fingerprint, "User Input": "Approve",
      "Run floor": latestMainWorkflowStageRunFloorForProject(pd, STAGE),
    })) expect(auditBlockField(rows[0].block, field)).toBe(value);
  }, 30_000);

  test.each(["missing", "stale", "legacy", "bypass", "unmerged"])("%s native authority is not ready", (kind) => {
    const pd = fixture();
    if (kind !== "missing") converge(pd, 1, BATCH, kind);
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).ready).toBe(false);
    human(pd);
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH, "Approve")).toThrow("not ready");
    expect(gates(pd)).toHaveLength(0);
  }, 30_000);

  test("duplicates, subsets, foreign units, empty sets and invalid batch numbers refuse", () => {
    const pd = fixture();
    converge(pd);
    for (const units of [[], ["alpha"], ["alpha", "alpha"], ["alpha", "gamma"], ["Alpha", "beta"]]) {
      expect(() => resolveSwarmCheckpoint(pd, 1, units)).toThrow();
    }
    for (const batch of [0, -1, 1.5, 3, Number.NaN]) {
      expect(() => resolveSwarmCheckpoint(pd, batch, BATCH)).toThrow();
    }
    expect(gates(pd)).toHaveLength(0);
  }, 30_000);

  test("gated mode requires the exact choice and a fresh actual human turn", () => {
    const pd = fixture();
    converge(pd);
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH)).toThrow("exact");
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH, "Approve")).toThrow("human turn");
    human(pd);
    for (const choice of ["approve", "Approve (Recommended)", "yes", ""]) {
      expect(() => approveSwarmCheckpoint(pd, 1, BATCH, choice)).toThrow("exact");
    }
    expect(approveSwarmCheckpoint(pd, 1, BATCH, "Approve").approved).toBe(true);
    expect(approveSwarmCheckpoint(pd, 1, BATCH, "Approve").approved).toBe(true);
    expect(gates(pd)).toHaveLength(1);
  }, 30_000);

  test("autonomy needs the protected grant; explicit answers still need a human", () => {
    const pd = fixture();
    writeFileSync(seededStateFile(pd), state(true));
    converge(pd);
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).human_required).toBe(true);
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH)).toThrow("exact");
    appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, pd);
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).human_required).toBe(false);
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH, "Approve")).toThrow("human turn");
    expect(approveSwarmCheckpoint(pd, 1, BATCH).approved).toBe(true);
    expect(auditBlockField(gates(pd)[0].block, "Autonomous")).toBe("true");
    appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "gated" }, pd);
    writeFileSync(seededStateFile(pd), state(false));
    const revoked = resolveSwarmCheckpoint(pd, 1, BATCH);
    expect(revoked.approved).toBe(true);
    expect(revoked.human_required).toBe(true);
    converge(pd, 2, ["gamma"]);
    expect(resolveSwarmCheckpoint(pd, 2, ["gamma"]).approved).toBe(false);
    expect(() => approveSwarmCheckpoint(pd, 2, ["gamma"])).toThrow("exact");
  }, 30_000);

  test("rejection always needs human choice and reason, then retires each unit's evidence", () => {
    const pd = fixture(true);
    converge(pd);
    approveSwarmCheckpoint(pd, 1, BATCH);
    expect(() => rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", "Please fix the API")).toThrow("human turn");
    human(pd);
    expect(() => rejectSwarmCheckpoint(pd, 1, BATCH, "Reject", "Please fix the API")).toThrow("exact");
    for (const reason of ["", " ", "DISMISSED", "first\nsecond"]) {
      expect(() => rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", reason)).toThrow("reason");
    }
    const rejected = rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", "Please fix the API");
    expect(rejected.approved).toBe(false);
    expect(rejected.ready).toBe(false);
    const rows = gates(pd, "GATE_REJECTED");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => auditBlockField(row.block, "Unit"))).toEqual(BATCH);
    for (const row of rows) {
      expect(auditBlockField(row.block, "Reason")).toBe("Please fix the API");
      expect(auditBlockField(row.block, "Gate Stages")).toBe(STAGE);
    }
    for (const unit of BATCH) {
      expect(latestMainWorkflowStageRunFloorForProject(pd, STAGE, false, unit)).toStartWith("GATE_REJECTED:");
    }
  }, 30_000);

  test.each(["attempt", "source", "artifact", "manifest", "set"])("%s change invalidates approval", (kind) => {
    const pd = fixture(true);
    converge(pd);
    approveSwarmCheckpoint(pd, 1, BATCH);
    if (kind === "attempt") appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, pd);
    if (kind === "source") writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2;\n");
    if (kind === "artifact") {
      writeFileSync(join(seededRecordDir(pd), "construction", "alpha", STAGE, artifactFilename(findStageBySlug(STAGE)!.produces![0])), "Changed output\n");
    }
    if (kind === "manifest") {
      const file = join(seededRecordDir(pd), "construction", "alpha", STAGE, "source-manifest.json");
      writeFileSync(file, `${readFileSync(file, "utf-8")}\n`);
    }
    if (kind === "set") {
      seedBoltDagBatches(pd, [["alpha"], ["beta", "gamma"]]);
      expect(() => resolveSwarmCheckpoint(pd, 1, BATCH)).toThrow("exactly");
    } else expect(resolveSwarmCheckpoint(pd, 1, BATCH).approved).toBe(false);
  }, 30_000);

  test("source edits before approval cannot be certified by an older native receipt", () => {
    const pd = fixture(true);
    converge(pd);
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2;\n");
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).errors.join(" ")).toContain("claimed source differs");
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH)).toThrow("not ready");
    human(pd);
    expect(rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", "Please rework the changed source").approved).toBe(false);
  }, 30_000);

  test("later unrelated source and native batches do not reopen an approved batch", () => {
    const pd = fixture(true);
    converge(pd);
    const approved = approveSwarmCheckpoint(pd, 1, BATCH);
    writeFileSync(join(pd, "src", "gamma.ts"), "export const gamma = 2;\n");
    git(pd, ["add", "src/gamma.ts"]);
    git(pd, ["commit", "-qm", "later unit"]);
    converge(pd, 2, ["gamma"]);
    const later = resolveSwarmCheckpoint(pd, 1, BATCH);
    expect(later.errors).toEqual([]);
    expect(later.approved).toBe(true);
    expect(later.fingerprint).toBe(approved.fingerprint);
    expect(approveSwarmCheckpoint(pd, 2, ["gamma"]).approved).toBe(true);
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).approved).toBe(true);
  }, 30_000);

  test("disabled policy, serial execution, and unit-major iteration are not swarm checkpoints", () => {
    const pd = fixture(true);
    converge(pd);
    for (const [field, value] of [
      ["Construction Checkpoints", "disabled"], ["Construction Execution", "serial"],
      ["Construction Iteration", "unit-major"],
    ]) {
      const configured = setField(state(true), field, value);
      expect(resolveSwarmCheckpoint(pd, 1, BATCH, configured).ready).toBe(false);
    }
  }, 30_000);

  test("approved inline units are excluded, and cannot substitute for native batch members", () => {
    const pd = fixture();
    const content = readFileSync(seededStateFile(pd), "utf-8");
    for (const stage of unitMajorConstructionStageSlugs("feature", content, true)) {
      artifacts(pd, "alpha", stage);
      appendAuditEntry("UNIT_COMPLETED", {
        Stage: stage, Unit: "alpha", Mode: "wave",
        "Run floor": latestMainWorkflowStageRunFloorForProject(pd, stage, true, "alpha"),
        "Artifact Fingerprint": reviewArtifactFingerprint(pd, findStageBySlug(stage)!, "alpha", { requireRequiredArtifacts: true })!,
      }, pd);
    }
    // This is the existing inline checkpoint's real command, not a new swarm checker.
    const executable = process.platform === "win32"
      ? `"${process.execPath.replaceAll('"', '""')}"`
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
    const check = `${executable} -e "if (!require('fs').readFileSync('src/alpha.ts','utf8').includes('alpha = 1')) process.exit(1)"`;
    expect(verifyConstructionCheckpoint(pd, "alpha", "unit", check).verified).toBe(true);
    human(pd);
    expect(approveConstructionCheckpoint(pd, "alpha", "unit", "Approve").approved).toBe(true);
    expect([...approvedConstructionUnits(pd, content)]).toEqual(["alpha"]);
    expect(() => resolveSwarmCheckpoint(pd, 1, BATCH)).toThrow("exactly");
    expect(resolveSwarmCheckpoint(pd, 1, ["beta"]).ready).toBe(false);
    converge(pd, 1, ["beta"]);
    expect(resolveSwarmCheckpoint(pd, 1, ["beta"]).ready).toBe(true);
  }, 30_000);

  test("missing required output or immutable Source Commit refuses", () => {
    const pd = fixture(true);
    converge(pd);
    rmSync(join(seededRecordDir(pd), "construction", "beta", STAGE, artifactFilename(findStageBySlug(STAGE)!.produces![0])));
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).errors.join(" ")).toContain("required Code Generation outputs");
    const other = fixture(true);
    converge(other);
    rmSync(join(other, ".git"), { recursive: true, force: true });
    expect(resolveSwarmCheckpoint(other, 1, BATCH).ready).toBe(false);
    expect(() => approveSwarmCheckpoint(other, 1, BATCH)).toThrow("not ready");
  }, 30_000);
});
