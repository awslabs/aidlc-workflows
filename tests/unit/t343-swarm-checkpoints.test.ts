// covers: audit:GATE_APPROVED, audit:GATE_REJECTED, function:currentSwarmSourceMergeChain,
// function:approvedConstructionUnits, function:unitSourceFingerprint, subcommand:aidlc-bolt:swarm-checkpoint,
// function:readCommittedUnitSourceManifest, function:swarmUnitCheckpointRejections
// covers: subcommand:aidlc-swarm:check, subcommand:aidlc-swarm:finalize, audit:SWARM_UNIT_CONVERGED
// covers: function:askSwarmCheckpoint, function:requireProtectedResponse
// covers: function:withdrawProtectedQuestions
// covers: function:gitTreeLeafEntries

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  authorizedVerificationCommand,
  boltSlugForUnit,
  currentSwarmSourceMergeChain,
  currentSwarmSourceOpeningFingerprint,
  findStageBySlug,
  gitCommitSourceListing,
  gitTreeLeafEntries,
  intentRepos,
  latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents,
  readProtectedQuestion,
  readProtectedResponse,
  readCommittedUnitSourceManifest,
  readUnitSourceManifest,
  reviewArtifactFingerprint,
  serializeSourceListing,
  setField,
  stateDigest,
  sourceListingSha256,
  unitMajorConstructionStageSlugs,
  unitSourceFingerprint,
  workspaceSourceFingerprint,
  workspaceSourceListing,
  writeActiveDirectiveMarker,
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
import {
  approvalFingerprint,
  codeGenerationRecordDir,
  renderTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";

resetAidlcEnv();
const projects: string[] = [];
const STAGE = "code-generation";
const BATCH = ["alpha", "beta"];
const CHECK = "git diff --check";
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
- **Construction Verification Command**: ${CHECK}
- **Construction Autonomy Mode**: ${autonomous ? "autonomous" : "gated"}
- **Unit Ownership**: solo
- **Review Override**: none
- **Change Control**: strict
- **Bolt Refs**: [empty list]
- **Worktree Path**: -

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

function fixture(autonomous = false, repos: readonly string[] = [], authorize = true): string {
  const pd = createTestProject();
  projects.push(pd);
  seedAidlcMemory(pd);
  writeFileSync(seededStateFile(pd), state(autonomous));
  seedBoltDagBatches(pd, [BATCH, ["gamma"]]);
  writeFileSync(join(pd, ".gitignore"), [
    ".aidlc/", "aidlc/.aidlc-*", "aidlc/active-space",
    "aidlc/spaces/*/intents/active-intent", "aidlc/spaces/*/intents/*/audit/",
    "aidlc/spaces/*/intents/*/runtime-graph.json", "aidlc/spaces/*/intents/*/.aidlc-*", "",
  ].join("\n"));
  if (repos.length) {
    const registry = join(pd, "aidlc/spaces/default/intents/intents.json");
    const entries = JSON.parse(readFileSync(registry, "utf-8"));
    entries[0].repos = repos;
    writeFileSync(registry, JSON.stringify(entries));
  }
  for (const unit of [...BATCH, "gamma"]) {
    const sourceRoot = repos.length ? join(pd, repos[unit === "gamma" ? repos.length - 1 : 0]) : pd;
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    writeFileSync(join(sourceRoot, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
    artifacts(pd, unit);
  }
  for (const sourceRoot of repos.length ? repos.map((repo) => join(pd, repo)) : [pd]) {
    for (const args of [
      ["init", "-q"], ["config", "user.name", "AI-DLC Tests"],
      ["config", "user.email", "tests@example.com"], ["add", "-A"], ["commit", "-qm", "baseline"],
    ]) git(sourceRoot, args);
  }
  const listing = workspaceSourceListing(pd)!;
  const baseline = writeBaselineSourceSnapshot(pd, STAGE, listing);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
  if (autonomous) appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, pd);
  if (authorize) recordCommand(pd, CHECK);
  return pd;
}

function tool(pd: string, name: string, args: string[]) {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", pd], {
    cwd: pd, encoding: "utf-8",
    env: { ...process.env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}`, stdout: result.stdout };
}

function choice(pd: string, session: string, prompt: string): void {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "hooks/aidlc-record-human-turn.ts")], {
    cwd: pd, encoding: "utf-8", env: { ...process.env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function recordCommand(pd: string, command: string): void {
  const identity = ["--stage", STAGE, "--checkpoint", "verification-command", "--command", command, "--session", "t343-command"];
  const decision = tool(pd, "log", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"]);
  expect(decision.code, decision.out).toBe(0);
  choice(pd, "t343-command", "Approve");
  const answer = tool(pd, "log", ["answer", ...identity, "--details", "Approve"]);
  expect(answer.code, answer.out).toBe(0);
  const applied = tool(pd, "state", ["set-construction-verification-command", command]);
  expect(applied.code, applied.out).toBe(0);
}

function prepareNative(pd: string): void {
  writeActiveDirectiveMarker(pd, {
    kind: "invoke-swarm", stage: STAGE, units: BATCH,
    state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
  });
  const contract = resolveTestingPosture(pd);
  for (const unit of BATCH) {
    const dir = codeGenerationRecordDir(pd, unit);
    const body = `# Plan for ${unit}\n\n${renderTestingContract(contract)}\n## Steps\n- [ ] Implement\n`;
    const instructions = `# Tests for ${unit}\n\nValidate the Unit.\n`;
    writeFileSync(join(dir, "code-generation-plan.md"), body);
    writeFileSync(join(dir, "unit-test-instructions.md"), instructions);
    const questions = join(dir, "code-generation-questions.md");
    writeFileSync(questions, [
      "## Plan Approval",
      `[Approval Fingerprint]: ${approvalFingerprint(body, instructions, contract.contract_sha256, resolveCodeGenerationAuthority(pd, { unit }))}`,
      `[Planned Source]: ${workspaceSourceFingerprint(pd)}`,
      "A. Approve Plan", "B. Request Changes", "[Answer]:", "",
    ].join("\n"));
  }
  git(pd, ["add", "-A"]);
  git(pd, ["commit", "-qm", "native swarm plans"]);
  for (const unit of BATCH) {
    const questions = join(codeGenerationRecordDir(pd, unit), "code-generation-questions.md");
    const identity = ["--stage", STAGE, "--checkpoint", "plan-approval", "--unit", unit,
      "--questions-file", questions, "--session", `t343-${unit}`];
    const decision = tool(pd, "log", ["decision", ...identity, "--decision", "Approve this plan?", "--options", "Approve Plan,Request Changes"]);
    expect(decision.code, decision.out).toBe(0);
    choice(pd, `t343-${unit}`, "Approve Plan");
    writeFileSync(questions, readFileSync(questions, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
    const answer = tool(pd, "log", ["answer", ...identity, "--details", "Approve Plan"]);
    expect(answer.code, answer.out).toBe(0);
  }
  const prepared = tool(pd, "swarm", ["prepare", "--batch", "1", "--units", BATCH.join(","), "--base", git(pd, ["branch", "--show-current"])]);
  expect(prepared.code, prepared.out).toBe(0);
}

// Protected append factory stands in for the existing review/finalize/merge
// emitters. All content bindings use real files and immutable Git source.
function converge(pd: string, batch = 1, units = BATCH, kind = "bound"): void {
  const floor = latestMainWorkflowStageRunFloorForProject(pd, STAGE);
  const listing = workspaceSourceListing(pd)!;
  const fingerprint = workspaceSourceFingerprint(pd)!;
  const repos = intentRepos(pd);
  const chain = currentSwarmSourceMergeChain(pd, STAGE);
  let previous = chain.state === "ready" ? chain.fingerprint
    : sourceListingSha256(serializeSourceListing(listing));
  appendAuditEntry("SWARM_STARTED", {
    Stage: STAGE, "Run floor": floor, "Batch number": String(batch), "Unit obligations": "alpha, beta, gamma",
  }, pd);
  for (const unit of units) {
    const repo = repos.length ? repos[unit === "gamma" ? repos.length - 1 : 0] : null;
    const sourceRoot = repo ? join(pd, repo) : pd;
    const commit = git(sourceRoot, ["rev-parse", "HEAD"]);
    const committed = gitCommitSourceListing(sourceRoot, commit, !repo)!;
    expect(committed).not.toBeNull();
    const nativeFingerprint = workspaceSourceFingerprint(sourceRoot)!;
    const bytes = readFileSync(join(seededRecordDir(pd), "construction", unit, STAGE, "source-manifest.json"));
    // Child receipts deliberately contain repo-relative keys and unchanged,
    // unqualified manifest bytes, even when the parent has multiple repos.
    const manifest = repo ? {
      ok: true as const, claims: new Set([`\0src/${unit}.ts`]), prefixes: [],
      rawBytesSha256: createHash("sha256").update(bytes).digest("hex"),
    } : readUnitSourceManifest(pd, STAGE, unit);
    if (!manifest.ok) throw new Error(manifest.reason);
    appendAuditEntry("REVIEW_COMPLETED", {
      Stage: STAGE, Unit: unit, Verdict: "approved",
      "Artifact Fingerprint": reviewArtifactFingerprint(pd, findStageBySlug(STAGE)!, unit, { requireRequiredArtifacts: true })!,
      "Source Fingerprint": nativeFingerprint,
      "Unit Source Fingerprint": unitSourceFingerprint(committed, manifest, manifest.rawBytesSha256),
    }, pd);
    appendAuditEntry("SWARM_UNIT_CONVERGED", {
      Stage: STAGE, "Run floor": kind === "stale" ? "unstarted#0" : floor,
      "Batch number": String(batch), "Unit name": unit,
      ...(kind === "unchecked" ? {} : { "Command SHA-256": authorizedVerificationCommand(pd, readFileSync(seededStateFile(pd), "utf-8"))!.sha256 }),
      ...(kind === "legacy" ? {} : kind === "bypass" ? { "Source Freshness Bypass": "true" } : {
        "Source Commit": commit, "Source Fingerprint": kind === "source-binding" ? "e".repeat(64) : nativeFingerprint,
      }),
    }, pd);
    if (kind !== "unmerged") {
      appendAuditEntry("SWARM_SOURCE_MERGED", {
        Stage: STAGE, "Run floor": floor, "Batch number": String(batch), "Unit name": unit,
        "Source Commit": commit, "Merge commit": commit,
        Repo: kind === "wrong-repo" ? "foreign" : repo ?? "-",
        "Previous Source Fingerprint": previous, "Source Fingerprint": fingerprint,
      }, pd);
    }
    previous = fingerprint;
  }
}

function human(pd: string, prompt = "Approve"): void {
  const asked = tool(pd, "bolt", ["swarm-checkpoint", "--action", "ask", "--batch", "1", "--units", BATCH.join(","), "--session", "t343-checkpoint"]);
  expect(asked.code, asked.out).toBe(0);
  choice(pd, "t343-checkpoint", prompt);
}

function gates(pd: string, event = "GATE_APPROVED") {
  return readAuditShardEvents(pd).filter((row) => row.event === event && auditBlockField(row.block, "Checkpoint") === "swarm-batch");
}

describe("t343 completed swarm batch checkpoints", () => {
  test("check and finalize refuse a missing or substituted authorized command before execution", () => {
    const pd = fixture(false, [], false);
    const marker = join(pd, "unauthorized-command-ran");
    const supplied = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('${marker}','executed')"`;
    const actions = [["check", "alpha"], ["finalize", "--batch", "1", "--units", BATCH.join(","), "--claimed", BATCH.join(",")]];
    for (const action of actions) {
      const missing = tool(pd, "swarm", [...action, "--check-cmd", supplied]);
      expect(missing.code, missing.out).not.toBe(0);
      expect(missing.out).toContain("set-construction-verification-command");
    }
    recordCommand(pd, CHECK);
    for (const action of actions) {
      const substituted = tool(pd, "swarm", [...action, "--check-cmd", supplied]);
      expect(substituted.code, substituted.out).not.toBe(0);
      expect(substituted.out).toContain("does not match");
      expect(substituted.out).toContain("set-construction-verification-command");
    }
    expect(readdirSync(pd)).not.toContain("unauthorized-command-ran");
    expect(readAuditShardEvents(pd).filter((row) => row.event === "SWARM_UNIT_CONVERGED")).toEqual([]);
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).ready).toBe(false);
  }, 30_000);

  test("older native convergence without its command digest cannot certify a batch", () => {
    const pd = fixture();
    converge(pd, 1, BATCH, "unchecked");
    expect(resolveSwarmCheckpoint(pd, 1, BATCH)).toMatchObject({
      ready: false, approved: false,
      errors: BATCH.map((unit) => `${unit}: batch was not checked with the authorized Construction Verification Command.`),
    });
  }, 30_000);

  test("changing the authorized command retires the batch approval even after re-verification", () => {
    const pd = fixture(true);
    converge(pd);
    const approved = approveSwarmCheckpoint(pd, 1, BATCH);
    expect(approved.approved).toBe(true);
    recordCommand(pd, "git diff --exit-code -- src");
    expect(resolveSwarmCheckpoint(pd, 1, BATCH)).toMatchObject({ ready: false, approved: false });
    converge(pd, 1, BATCH, "unmerged");
    const checked = resolveSwarmCheckpoint(pd, 1, BATCH);
    expect(checked).toMatchObject({ ready: true, approved: false, fingerprint: approved.fingerprint });
    expect(approveSwarmCheckpoint(pd, 1, BATCH).approved).toBe(true);
  }, 30_000);

  test("a passing caller check cannot replace the failing authorized command", () => {
    const pd = fixture();
    prepareNative(pd);
    const passed = tool(pd, "swarm", ["check", "alpha"]);
    expect(passed.code, passed.out).toBe(0);
    recordCommand(pd, "exit 1");
    writeActiveDirectiveMarker(pd, {
      kind: "invoke-swarm", stage: STAGE, units: BATCH,
      state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
    });
    const args = ["finalize", "--batch", "1", "--units", BATCH.join(","), "--claimed", BATCH.join(",")];
    const permissive = tool(pd, "swarm", [...args, "--check-cmd", "true"]);
    expect(permissive.code, permissive.out).toBe(1);
    expect(permissive.out).toContain("does not match");
    const failed = tool(pd, "swarm", args);
    expect(failed.code, failed.out).toBe(2);
    expect(JSON.parse(failed.stdout).units).toEqual(BATCH.map((unit) => ({
      unit, bolt_slug: boltSlugForUnit(unit), status: "failed", reason: "error",
      detail: "claimed converged but the check command did not pass on re-verify",
    })));
    expect(readAuditShardEvents(pd).filter((row) => row.event === "SWARM_UNIT_CONVERGED")).toEqual([]);
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).ready).toBe(false);
  }, 60_000);

  test("stage approval requires each converged batch checkpoint to be approved", () => {
    const pd = fixture(true);
    converge(pd);
    converge(pd, 2, ["gamma"]);
    const report = () => spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), "report",
      "--stage", STAGE, "--result", "awaiting-approval", "--project-dir", pd,
    ], { encoding: "utf-8" });
    const refused = report();
    expect(JSON.parse(refused.stdout).kind, refused.stderr).toBe("error");
    expect(JSON.parse(refused.stdout).message).toContain("batch 1 (alpha, beta)");
    expect(JSON.parse(refused.stdout).message).toContain("batch 2 (gamma)");
    expect(approveSwarmCheckpoint(pd, 1, BATCH).approved).toBe(true);
    const remaining = report();
    expect(JSON.parse(remaining.stdout).kind, remaining.stderr).toBe("error");
    expect(JSON.parse(remaining.stdout).message).not.toContain("batch 1");
    expect(JSON.parse(remaining.stdout).message).toContain("batch 2 (gamma)");
    expect(approveSwarmCheckpoint(pd, 2, ["gamma"]).approved).toBe(true);
    const admitted = report();
    expect(admitted.status, `${admitted.stdout}${admitted.stderr}`).toBe(0);
    expect(JSON.parse(admitted.stdout).kind).not.toBe("error");
  }, 60_000);

  test("re-recording unchanged native evidence preserves the completed batch approval", () => {
    const pd = fixture();
    converge(pd);
    human(pd);
    const first = approveSwarmCheckpoint(pd, 1, BATCH, "Approve", "t343-checkpoint");
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
    const approved = approveSwarmCheckpoint(pd, 1, BATCH, "Approve", "t343-checkpoint");
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
    const asked = tool(pd, "bolt", ["swarm-checkpoint", "--action", "ask", "--batch", "1", "--units", BATCH.join(","), "--session", "t343-checkpoint"]);
    expect(asked.code).not.toBe(0);
    expect(asked.out).toContain("not ready");
    expect(readProtectedQuestion(pd, "t343-checkpoint")).toBeNull();
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH, "Approve", "t343-checkpoint")).toThrow("not ready");
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
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH, "Approve", "t343-checkpoint")).toThrow("--action ask");
    human(pd);
    for (const choice of ["approve", "Approve (Recommended)", "yes", ""]) {
      expect(() => approveSwarmCheckpoint(pd, 1, BATCH, choice, "t343-checkpoint")).toThrow("exact");
    }
    expect(approveSwarmCheckpoint(pd, 1, BATCH, "Approve", "t343-checkpoint").approved).toBe(true);
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH, "Approve", "t343-checkpoint")).toThrow("--action ask");
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
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH, "Approve", "t343-checkpoint")).toThrow("--action ask");
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
    expect(() => rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", "Please fix the API", "t343-checkpoint")).toThrow("--action ask");
    human(pd, "Request Changes");
    expect(() => rejectSwarmCheckpoint(pd, 1, BATCH, "Reject", "Please fix the API", "t343-checkpoint")).toThrow("exact");
    for (const reason of ["", " ", "DISMISSED", "first\nsecond"]) {
      expect(() => rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", reason, "t343-checkpoint")).toThrow("reason");
    }
    const rejected = rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", "Please fix the API", "t343-checkpoint");
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

  test("a rejected batch retries from its landed aggregate without erasing another approved batch", () => {
    const pd = fixture(true);
    converge(pd);
    approveSwarmCheckpoint(pd, 1, BATCH);
    converge(pd, 2, ["gamma"]);
    const later = approveSwarmCheckpoint(pd, 2, ["gamma"]);
    const aggregate = workspaceSourceFingerprint(pd);
    if (aggregate === null) throw new Error("Fixture aggregate source is unbindable");
    human(pd, "Request Changes");
    rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", "Revise the first batch", "t343-checkpoint");
    const rejected = currentSwarmSourceMergeChain(pd, STAGE);
    expect(rejected.state).toBe("ready");
    if (rejected.state !== "ready") throw new Error(JSON.stringify(rejected));
    expect([...rejected.units]).toEqual(["gamma"]);
    expect(rejected.fingerprint).toBe(aggregate);
    expect(resolveSwarmCheckpoint(pd, 2, ["gamma"]).fingerprint).toBe(later.fingerprint);
    expect(resolveSwarmCheckpoint(pd, 2, ["gamma"]).approved).toBe(true);
    writeFileSync(join(pd, "src/alpha.ts"), "export const alpha = 2;\n");
    git(pd, ["add", "src/alpha.ts"]);
    git(pd, ["commit", "-qm", "revised alpha"]);
    converge(pd, 1, ["alpha"]);
    const partial = currentSwarmSourceMergeChain(pd, STAGE);
    expect(partial.state).toBe("ready");
    if (partial.state !== "ready") throw new Error(JSON.stringify(partial));
    expect([...partial.units].sort()).toEqual(["alpha", "gamma"]);
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).ready).toBe(false);
    converge(pd, 1, ["beta"]);
    const ready = resolveSwarmCheckpoint(pd, 1, BATCH);
    expect(ready.ready, ready.errors.join("\n")).toBe(true);
    expect(ready.approved).toBe(false);
    expect(approveSwarmCheckpoint(pd, 1, BATCH).approved).toBe(true);
    expect(resolveSwarmCheckpoint(pd, 2, ["gamma"]).approved).toBe(true);
  }, 30_000);

  test.each(["missing", "old-floor", "wrong-batch", "old-unit-floor"])(
    "%s rejection cannot authorize a duplicate merge",
    (kind) => {
      const pd = fixture(true);
      converge(pd);
      if (kind !== "missing") {
        appendAuditEntry("GATE_REJECTED", {
          Checkpoint: "swarm-batch", Stage: STAGE, "Gate Stages": STAGE,
          Unit: "alpha", Units: "alpha, beta", "Batch number": kind === "wrong-batch" ? "2" : "1",
          "Run floor": kind === "old-floor" ? "unstarted#0" : latestMainWorkflowStageRunFloorForProject(pd, STAGE),
          "Run floors": JSON.stringify({ alpha: kind === "old-unit-floor" ? "unstarted#0" :
            latestMainWorkflowStageRunFloorForProject(pd, STAGE, false, "alpha") }),
        }, pd);
      }
      converge(pd, 1, ["alpha"]);
      const chain = currentSwarmSourceMergeChain(pd, STAGE);
      expect(chain.state).toBe("invalid");
      if (chain.state === "invalid") expect(chain.reason).toContain("duplicate");
    }, 30_000,
  );

  test("a stage rejection after Unit rejections carries the correct accepted aggregate", () => {
    const pd = fixture(true);
    converge(pd);
    const aggregate = workspaceSourceFingerprint(pd)!;
    human(pd, "Request Changes");
    rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", "Revise the first batch", "t343-checkpoint");
    appendAuditEntry("GATE_REJECTED", {
      Stage: STAGE, "Prior Accepted Source Fingerprint": aggregate,
    }, pd);
    expect(currentSwarmSourceOpeningFingerprint(pd, STAGE)).toEqual({
      state: "ready", fingerprint: aggregate, source: "prior-accepted",
    });
  }, 30_000);

  test("immutable Unit binding accepts native reviews containing internal symlinks", () => {
    const pd = fixture(true);
    symlinkSync("alpha.ts", join(pd, "src/alpha-alias.ts"));
    git(pd, ["add", "src/alpha-alias.ts"]);
    git(pd, ["commit", "-qm", "internal source alias"]);
    // Start with this reviewed source as the aggregate's initial baseline.
    const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
    appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, pd);
    recordCommand(pd, CHECK);
    converge(pd);
    const ready = resolveSwarmCheckpoint(pd, 1, BATCH);
    expect(ready.ready, ready.errors.join("\n")).toBe(true);
    expect(approveSwarmCheckpoint(pd, 1, BATCH).approved).toBe(true);
  }, 30_000);

  test.each([{ repos: ["repo-a"] }, { repos: ["repo-a", "repo-b"] }])(
    "transported child manifests retain reviewed bytes with repositories %j",
    ({ repos }) => {
      const pd = fixture(true, repos);
      const path = join(seededRecordDir(pd), "construction/alpha", STAGE, "source-manifest.json");
      const original = readFileSync(path);
      converge(pd);
      const approved = approveSwarmCheckpoint(pd, 1, BATCH);
      expect(approved.approved).toBe(true);
      expect(readFileSync(path)).toEqual(original);
      // Parent ignore changes cannot redefine the immutable child's manifest.
      writeFileSync(join(pd, repos[0], ".gitignore"), "src/\n");
      const unchanged = resolveSwarmCheckpoint(pd, 1, BATCH);
      expect(unchanged.ready, unchanged.errors.join("\n")).toBe(true);
      expect(unchanged.approved).toBe(true);
      writeFileSync(join(pd, repos[0], "src/alpha.ts"), "export const alpha = 2;\n");
      expect(resolveSwarmCheckpoint(pd, 1, BATCH).errors.join(" ")).toContain("claimed source differs");
    }, 30_000,
  );

  test("raw Git trees reject nonportable paths before immutable manifest materialization", () => {
    const pd = fixture();
    const rawGit = (args: string[], input?: string): string => {
      const result = spawnSync("git", ["-C", pd, ...args], { input, encoding: "utf-8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const blob = rawGit(["hash-object", "-w", "--stdin"], "export const alpha = 1;\n");
    const symlink = rawGit(["hash-object", "-w", "--stdin"], "../../outside-target");
    const nested = rawGit(["mktree", "-z"], `100644 blob ${blob}\talpha.ts\0`);
    const src = rawGit(["mktree", "-z"], `040000 tree ${nested}\tnested\0`);
    const safeTree = rawGit(["mktree", "-z"], `040000 tree ${src}\tsrc\0`);
    const safeCommit = rawGit(["commit-tree", safeTree, "-m", "ordinary nested source"]);
    const cases: { commit: string; path: string; ok: boolean }[] = [
      { commit: safeCommit, path: "src/nested/alpha.ts", ok: true },
    ];
    const unsafePaths = [
      "..\\..\\escape.txt", "a\\b.txt", "mixed/..\\x", "nul", "con.txt",
      "nested/PrN.log", "AUX", "COM1", "com9.ext", "LPT1", "lpt9.ext",
      "trail.", "nested/trail ", "file:stream", "C:drive-relative", "C:\\absolute",
      "\\\\server\\share", "\\rooted",
    ];
    for (const path of unsafePaths) {
      for (const mode of ["100644", "120000", "160000"] as const) {
        const parts = path.split("/");
        const leaf = parts.pop()!;
        const type = mode === "160000" ? "commit" : "blob";
        const oid = mode === "160000" ? safeCommit : mode === "120000" ? symlink : blob;
        let entry = `${mode} ${type} ${oid}\t${leaf}\0`;
        while (parts.length) {
          const tree = rawGit(["mktree", "-z"], entry);
          entry = `040000 tree ${tree}\t${parts.pop()}\0`;
        }
        const tree = rawGit(["mktree", "-z"], `040000 tree ${src}\tsrc\0${entry}`);
        const commit = rawGit(["commit-tree", tree, "-m", "unsafe raw tree"]);
        cases.push({ commit, path: `${mode} ${path}`, ok: false });
      }
    }
    const scratch = join(pd, ".aidlc", "manifest-path-safety");
    mkdirSync(scratch, { recursive: true });
    const sentinel = join(scratch, "cat-file.batch");
    writeFileSync(sentinel, "existing temporary sibling\n");
    const before = readdirSync(scratch).sort();
    const driver = join(pd, ".aidlc", "manifest-path-safety.ts");
    writeFileSync(driver, `
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { gitTreeLeafEntries, readCommittedUnitSourceManifest } from ${JSON.stringify(join(AIDLC_SRC, "tools", "aidlc-lib.ts"))};
const cases = ${JSON.stringify(cases)};
const bytes = Buffer.from(JSON.stringify({
  stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "src/nested/alpha.ts" }],
}));
const before = JSON.stringify(readdirSync(tmpdir()).sort());
for (const { commit, path, ok } of cases) {
  const entries = gitTreeLeafEntries(${JSON.stringify(pd)}, commit);
  if ((entries !== null) !== ok) throw new Error("tree path validation: " + path);
  const result = readCommittedUnitSourceManifest(${JSON.stringify(pd)}, commit, false, "code-generation", "alpha", bytes);
  if (result.ok !== ok) throw new Error("manifest validation: " + path + " " + JSON.stringify(result));
  if (result.ok && result.listing.get("\\0src/nested/alpha.ts") !== ${JSON.stringify(`100644 ${createHash("sha256").update("export const alpha = 1;\n").digest("hex")}`)}) {
    throw new Error("nested source bytes did not materialize");
  }
  if (JSON.stringify(readdirSync(tmpdir()).sort()) !== before) throw new Error("escaped or uncleaned path: " + path);
}
`);
    const result = Bun.spawnSync([process.execPath, driver], {
      cwd: pd, env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readdirSync(scratch).sort()).toEqual(before);
    expect(readFileSync(sentinel, "utf-8")).toBe("existing temporary sibling\n");
    expect(gitTreeLeafEntries(pd, safeCommit)).toEqual([
      { mode: "100644", oid: blob, path: "src/nested/alpha.ts" },
    ]);
  }, 30_000);

  test("immutable manifest initialization stays private with ambient GIT_DIR", () => {
    const pd = fixture();
    const commit = git(pd, ["rev-parse", "HEAD"]);
    const manifest = readFileSync(join(seededRecordDir(pd), "construction/alpha", STAGE, "source-manifest.json"));
    const config = readFileSync(join(pd, ".git/config"));
    const head = readFileSync(join(pd, ".git/HEAD"));
    const before = process.env.GIT_DIR;
    try {
      process.env.GIT_DIR = join(pd, ".git");
      const result = readCommittedUnitSourceManifest(pd, commit, true, STAGE, "alpha", manifest);
      expect(result.ok, result.ok ? "" : result.reason).toBe(true);
      expect(readFileSync(join(pd, ".git/config"))).toEqual(config);
      expect(readFileSync(join(pd, ".git/HEAD"))).toEqual(head);
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  }, 30_000);

  test("concurrent immutable manifest reads isolate repositories and clean their private blob streams", async () => {
    const repos = [fixture(), fixture()];
    const cases = repos.map((pd, index) => {
      writeFileSync(join(pd, "src/alpha.ts"), `export const alpha = ${index + 2};\n// ${String(index).repeat(256 * 1024)}\n`);
      git(pd, ["add", "src/alpha.ts"]);
      git(pd, ["commit", "-qm", "distinct concurrent reviewed source"]);
      const manifest = readUnitSourceManifest(pd, STAGE, "alpha");
      if (!manifest.ok) throw new Error(manifest.reason);
      return {
        pd, commit: git(pd, ["rev-parse", "HEAD"]),
        file: join(seededRecordDir(pd), "construction/alpha", STAGE, "source-manifest.json"),
        expected: unitSourceFingerprint(workspaceSourceListing(pd)!, manifest, manifest.rawBytesSha256),
      };
    });
    const scratch = join(repos[0], ".aidlc", "manifest-concurrency");
    mkdirSync(scratch, { recursive: true });
    const sentinel = join(scratch, "cat-file.batch");
    writeFileSync(sentinel, "existing shared temporary entry\n");
    const driver = join(repos[0], ".aidlc", "manifest-concurrency.ts");
    writeFileSync(driver, `
import { readFileSync } from "node:fs";
const { readCommittedUnitSourceManifest, unitSourceFingerprint } =
  await import(${JSON.stringify(join(AIDLC_SRC, "tools", "aidlc-lib.ts"))});
const [pd, commit, file, expected] = process.argv.slice(2);
const bytes = readFileSync(file);
for (let iteration = 0; iteration < 4; iteration++) {
  const result = readCommittedUnitSourceManifest(pd, commit, true, "code-generation", "alpha", bytes);
  if (!result.ok) throw new Error(result.reason);
  if (unitSourceFingerprint(result.listing, result, result.rawBytesSha256) !== expected) {
    throw new Error("immutable source belongs to a different repository");
  }
}
const invalid = readCommittedUnitSourceManifest(pd, commit, true, "code-generation", "alpha", Buffer.from("{"));
if (invalid.ok) throw new Error("invalid manifest unexpectedly accepted");
`);
    const workers = cases.map(({ pd, commit, file, expected }) => Bun.spawn(
      [process.execPath, driver, pd, commit, file, expected],
      {
        cwd: pd, env: { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
        stdout: "pipe", stderr: "pipe",
      },
    ));
    const results = await Promise.all(workers.map(async (worker) => ({
      code: await worker.exited,
      out: await new Response(worker.stdout).text(),
      err: await new Response(worker.stderr).text(),
    })));
    for (const result of results) expect(result.code, `${result.out}\n${result.err}`).toBe(0);
    expect(readFileSync(sentinel, "utf-8")).toBe("existing shared temporary entry\n");
    expect(readdirSync(scratch).filter((entry) => entry.startsWith("aidlc-commit-manifest-"))).toEqual([]);
  }, 30_000);

  test.each(["wrong-repo", "source-binding"])("%s cannot certify transported child source", (kind) => {
    const pd = fixture(true, ["repo-a", "repo-b"]);
    converge(pd, 1, BATCH, kind);
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).ready).toBe(false);
    expect(() => approveSwarmCheckpoint(pd, 1, BATCH)).toThrow("not ready");
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
    const asked = tool(pd, "bolt", ["swarm-checkpoint", "--action", "ask", "--batch", "1", "--units", BATCH.join(","), "--session", "t343-checkpoint"]);
    expect(asked.code).not.toBe(0);
    expect(() => rejectSwarmCheckpoint(pd, 1, BATCH, "Request Changes", "Please rework the changed source", "t343-checkpoint")).toThrow("--action ask");
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
    recordCommand(pd, check);
    expect(verifyConstructionCheckpoint(pd, "alpha", "unit").verified).toBe(true);
    expect(tool(pd, "bolt", ["checkpoint", "--action", "ask", "--unit", "alpha", "--kind", "unit", "--session", "inline-checkpoint"]).code).toBe(0);
    choice(pd, "inline-checkpoint", "Approve");
    expect(approveConstructionCheckpoint(pd, "alpha", "unit", "Approve", "inline-checkpoint").approved).toBe(true);
    expect([...approvedConstructionUnits(pd, readFileSync(seededStateFile(pd), "utf-8"))]).toEqual(["alpha"]);
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

describe("t343 response-bound swarm decisions", () => {
  const session = "swarm-consent";
  const route = (id = session) => ["swarm-checkpoint", "--batch", "1", "--units", BATCH.join(","), "--session", id];

  test("finalize withdraws every outstanding session's batch question and response", () => {
    const pd = fixture();
    converge(pd);
    const before = resolveSwarmCheckpoint(pd, 1, BATCH);
    for (const id of [session, "other-swarm-session"]) {
      expect(tool(pd, "bolt", [...route(id), "--action", "ask"]).code).toBe(0);
      choice(pd, id, "Approve");
      expect(readProtectedResponse(pd, id)?.choice).toBe("Approve");
    }
    // Even a finalize run that declines all Units starts a new verification boundary.
    const finalized = tool(pd, "swarm", ["finalize", "--batch", "1", "--units", BATCH.join(",")]);
    expect(finalized.code, finalized.out).toBe(2);
    const after = resolveSwarmCheckpoint(pd, 1, BATCH);
    expect(after).toMatchObject({ ready: true, fingerprint: before.fingerprint });
    for (const id of [session, "other-swarm-session"]) {
      expect(readProtectedQuestion(pd, id)).toBeNull();
      expect(readProtectedResponse(pd, id)).toBeNull();
      choice(pd, id, "Approve");
      expect(tool(pd, "bolt", [...route(id), "--action", "approve", "--user-input", "Approve"]).code).not.toBe(0);
    }
    expect(gates(pd)).toEqual([]);
    expect(tool(pd, "bolt", [...route(), "--action", "ask"]).code).toBe(0);
    choice(pd, session, "Approve");
    expect(tool(pd, "bolt", [...route(), "--action", "approve", "--user-input", "Approve"]).code).toBe(0);
  }, 30_000);

  test("consent binds per-Unit command digests even when rechecked content has the same fingerprint", () => {
    const pd = fixture();
    converge(pd);
    const before = resolveSwarmCheckpoint(pd, 1, BATCH);
    expect(tool(pd, "bolt", [...route(), "--action", "ask"]).code).toBe(0);
    choice(pd, session, "Approve");
    recordCommand(pd, "git diff --exit-code -- src");
    converge(pd, 1, BATCH, "unmerged");
    expect(resolveSwarmCheckpoint(pd, 1, BATCH)).toMatchObject({ ready: true, fingerprint: before.fingerprint });
    const approve = () => tool(pd, "bolt", [...route(), "--action", "approve", "--user-input", "Approve"]);
    const stale = approve();
    expect(stale.code).not.toBe(0);
    expect(stale.out).toContain("--action ask");
    expect(gates(pd)).toEqual([]);
    expect(tool(pd, "bolt", [...route(), "--action", "ask"]).code).toBe(0);
    choice(pd, session, "Approve");
    expect(approve().code).toBe(0);
  }, 30_000);

  test("unrelated and cross-session prompts cannot approve; a consumed choice cannot replay", () => {
    const pd = fixture();
    converge(pd);
    choice(pd, session, "hello");
    const approve = (id = session) => tool(pd, "bolt", [...route(id), "--action", "approve", "--user-input", "Approve"]);
    expect(approve().code).not.toBe(0);
    expect(gates(pd)).toEqual([]);
    const ask = tool(pd, "bolt", [...route(), "--action", "ask"]);
    expect(ask.code, ask.out).toBe(0);
    choice(pd, session, "hello");
    expect(approve().code).not.toBe(0);
    choice(pd, "other-session", "Approve");
    expect(approve().code).not.toBe(0);
    choice(pd, session, "Approve");
    expect(approve("other-session").code).not.toBe(0);
    expect(gates(pd)).toEqual([]);
    const accepted = approve();
    expect(accepted.code, accepted.out).toBe(0);
    expect(JSON.parse(accepted.stdout).approved).toBe(true);
    expect(readProtectedQuestion(pd, session)).toBeNull();
    expect(readProtectedResponse(pd, session)).toBeNull();
    choice(pd, session, "hello");
    expect(approve().code).not.toBe(0);
    expect(gates(pd)).toHaveLength(1);
  }, 30_000);

  test("changed but freshly reviewed batch evidence needs a new offered choice", () => {
    const pd = fixture();
    converge(pd);
    const ask = () => {
      const result = tool(pd, "bolt", [...route(), "--action", "ask"]);
      expect(result.code, result.out).toBe(0);
    };
    ask();
    choice(pd, session, "Approve");
    writeFileSync(join(seededRecordDir(pd), "construction", "alpha", STAGE, artifactFilename(findStageBySlug(STAGE)!.produces![0])), "# Revised implementation evidence\n");
    converge(pd, 1, BATCH, "unmerged");
    expect(resolveSwarmCheckpoint(pd, 1, BATCH).ready).toBe(true);
    const approve = () => tool(pd, "bolt", [...route(), "--action", "approve", "--user-input", "Approve"]);
    const stale = approve();
    expect(stale.code).not.toBe(0);
    expect(stale.out).toContain("--action ask");
    expect(gates(pd)).toEqual([]);
    ask();
    choice(pd, session, "Approve");
    const accepted = approve();
    expect(accepted.code, accepted.out).toBe(0);
  }, 30_000);

  test("autonomous approval needs no challenge but rejection requires Request Changes", () => {
    const pd = fixture(true);
    converge(pd);
    const reject = () => tool(pd, "bolt", [...route(), "--action", "reject", "--user-input", "Request Changes", "--reason", "Fix the API"]);
    expect(reject().code).not.toBe(0);
    expect(gates(pd, "GATE_REJECTED")).toEqual([]);
    const approved = tool(pd, "bolt", ["swarm-checkpoint", "--batch", "1", "--units", BATCH.join(","), "--action", "approve"]);
    expect(approved.code, approved.out).toBe(0);
    expect(tool(pd, "bolt", [...route(), "--action", "ask"]).code).toBe(0);
    choice(pd, session, "Approve");
    expect(reject().code).not.toBe(0);
    choice(pd, session, "Request Changes");
    const rejected = reject();
    expect(rejected.code, rejected.out).toBe(0);
    expect(readProtectedResponse(pd, session)).toBeNull();
    expect(gates(pd, "GATE_REJECTED").map((row) => auditBlockField(row.block, "Unit"))).toEqual(BATCH);
  }, 30_000);
});

describe("t343 checkpoint question interleaving", () => {
  test.each(["ordinary-question", "lifecycle-gate"])("%s withdraws batch consent before an unrelated Approve", (interleaving) => {
    const pd = fixture();
    if (interleaving === "lifecycle-gate") {
      writeFileSync(seededStateFile(pd), readFileSync(seededStateFile(pd), "utf-8").replace(
        "## Stage Progress", "## Stage Progress\n### INCEPTION PHASE\n- [-] delivery-planning — EXECUTE",
      ));
    }
    converge(pd);
    const session = "swarm-interleaving";
    const route = ["swarm-checkpoint", "--batch", "1", "--units", BATCH.join(","), "--session", session];
    const ask = () => {
      const asked = tool(pd, "bolt", [...route, "--action", "ask"]);
      expect(asked.code, asked.out).toBe(0);
    };
    ask();
    if (interleaving === "ordinary-question") {
      const decision = tool(pd, "log", ["decision", "--stage", STAGE, "--decision", "Approve the unrelated naming proposal?", "--session", session]);
      expect(decision.code, decision.out).toBe(0);
    } else {
      const gate = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc-state.ts"), "gate-start", "delivery-planning", "--project-dir", pd], {
        cwd: pd, encoding: "utf-8", env: { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_REVIEWER_GATE_GUARD: "1" },
      });
      expect(gate.status, `${gate.stdout}${gate.stderr}`).toBe(0);
      expect(readAuditShardEvents(pd).some((row) => row.event === "STAGE_AWAITING_APPROVAL" && auditBlockField(row.block, "Stage") === "delivery-planning")).toBe(true);
    }
    choice(pd, session, "Approve");
    expect(readProtectedQuestion(pd, session)).toBeNull();
    expect(readProtectedResponse(pd, session)).toBeNull();
    const approve = () => tool(pd, "bolt", [...route, "--action", "approve", "--user-input", "Approve"]);
    const refused = approve();
    expect(refused.code, refused.out).not.toBe(0);
    expect(refused.out).toContain("--action ask");
    expect(gates(pd)).toEqual([]);
    ask();
    choice(pd, session, "Approve");
    const accepted = approve();
    expect(accepted.code, accepted.out).toBe(0);
    expect(gates(pd)).toHaveLength(1);
  }, 30_000);
});
