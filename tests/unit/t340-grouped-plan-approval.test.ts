// covers: function:validateCodeGenerationForkApproval, function:evaluateCodeGenerationApproval,
// function:beginCodeGeneration, hook:aidlc-plan-approval-guard, subcommand:aidlc-orchestrate:next

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents, readPlanApprovalReceipt, readUnitSourceManifest, reviewArtifactFingerprint,
  serializeSourceListing, sourceListingSha256, stateDigest, unitSourceFingerprint,
  workspaceSourceFingerprint, workspaceSourceListing, writeActiveDirectiveMarker, writeBaselineSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  approvalFingerprint, beginCodeGeneration, codeGenerationRecordDir, evaluateCodeGenerationApproval,
  renderTestingContract, resolveCodeGenerationAuthority, resolveTestingPosture, validateCodeGenerationForkApproval,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  approveSwarmCheckpoint, resolveSwarmCheckpoint,
} from "../../dist/claude/.claude/tools/aidlc-swarm-checkpoints.ts";
import {
  AIDLC_SRC, cleanupTestProject, resetAidlcEnv, runOrchestrateNext, seedBoltDagBatches,
  seededRecordDir, seededStateFile, setupIntegrationProject,
} from "../harness/fixtures.ts";

resetAidlcEnv();
const projects: string[] = [];
const STAGE = "code-generation";
const UNITS = ["alpha", "beta"];
const SESSION = "grouped-successor";
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
}, 30_000);

function git(pd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: pd, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

function tool(pd: string, path: string, args: string[], input?: unknown) {
  const result = Bun.spawnSync([process.execPath, join(AIDLC_SRC, path), ...args], {
    cwd: pd, env: { ...process.env, CLAUDE_PROJECT_DIR: pd, AIDLC_PROJECT_DIR: pd },
    stdout: "pipe", stderr: "pipe",
    ...(input === undefined ? {} : { stdin: Buffer.from(JSON.stringify(input)) }),
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
}

function publish(pd: string, kind: "invoke-swarm" | "run-stage", units = UNITS): void {
  writeActiveDirectiveMarker(pd, {
    kind, stage: STAGE, units, ...(kind === "run-stage" ? { unit: units.at(-1) } : {}),
    state_sha256: stateDigest(readFileSync(seededStateFile(pd), "utf-8")),
  });
}

function plan(pd: string, unit: string): string {
  const dir = codeGenerationRecordDir(pd, unit);
  mkdirSync(dir, { recursive: true });
  for (const name of findStageBySlug(STAGE)!.produces ?? []) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${unit}: ${name}\n`);
  }
  writeFileSync(join(dir, "source-manifest.json"), JSON.stringify({
    version: 1, stage: STAGE, unit, writes: [{ path: `src/${unit}.ts` }],
  }));
  const contract = resolveTestingPosture(pd);
  const body = `# ${unit} plan\n\n${renderTestingContract(contract)}\n## Steps\n- [ ] Implement\n`;
  const instructions = "# Unit Test Instructions\n\nRun unit tests.\n";
  writeFileSync(join(dir, "code-generation-plan.md"), body);
  writeFileSync(join(dir, "unit-test-instructions.md"), instructions);
  const questions = join(dir, "code-generation-questions.md");
  writeFileSync(questions, [
    "## Plan Approval",
    `[Approval Fingerprint]: ${approvalFingerprint(body, instructions, contract.contract_sha256, resolveCodeGenerationAuthority(pd, { unit }))}`,
    `[Planned Source]: ${workspaceSourceFingerprint(pd)}`,
    "A. Approve Plan", "B. Request Changes", "[Answer]:", "",
  ].join("\n"));
  return relative(pd, questions);
}

function approve(pd: string, grouped = true): void {
  const units = UNITS.map((unit) => ({ unit, questionsFile: plan(pd, unit) }));
  const file = join(seededRecordDir(pd), "approval-batch.json");
  writeFileSync(file, JSON.stringify({ batch: "services", units }));
  const selections = grouped ? [["--batch-file", file]] : units.map((entry) =>
    ["--unit", entry.unit, "--questions-file", entry.questionsFile]);
  for (const selection of selections) {
    const route = ["--stage", STAGE, "--checkpoint", "plan-approval", "--session", SESSION, ...selection];
    const choice = grouped ? "Approve Plans" : "Approve Plan";
    const decision = tool(pd, "tools/aidlc-log.ts", [
      "decision", ...route, "--decision", "Approve reviewed plans?", "--options", `${choice},Request Changes`,
    ]);
    expect(decision.code, decision.err).toBe(0);
    expect(tool(pd, "hooks/aidlc-record-human-turn.ts", [], {
      hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: choice,
    }).code).toBe(0);
    for (const entry of units.filter((entry) => grouped || selection.includes(entry.unit))) {
      const path = join(pd, entry.questionsFile);
      writeFileSync(path, readFileSync(path, "utf-8").replace(/^\[Answer\]:.*$/m, "[Answer]: Approve Plan"));
    }
    const answer = tool(pd, "tools/aidlc-log.ts", ["answer", ...route, "--details", choice]);
    expect(answer.code, answer.err).toBe(0);
  }
}

function fixture(options: { dirty?: boolean; legacy?: boolean } = {}): string {
  const pd = setupIntegrationProject();
  projects.push(pd);
  writeFileSync(seededStateFile(pd), `# State
## Project Information
- **Project**: Grouped Plan Approval
- **Scope**: feature
- **Project Type**: Greenfield
- **State Version**: 8
- **Skeleton Stance**: off
## Runtime State
${options.legacy ? "" : "- **Construction Checkpoints**: enabled\n- **Construction Execution**: swarm"}
- **Construction Iteration**: stage-major
- **Construction Autonomy Mode**: ${options.legacy ? "autonomous" : "gated"}
- **Unit Ownership**: solo
- **Review Override**: none
- **Change Control**: ${options.legacy ? "relaxed" : "strict"}
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
`);
  seedBoltDagBatches(pd, [UNITS]);
  mkdirSync(join(pd, "src"));
  for (const unit of UNITS) writeFileSync(join(pd, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  for (const args of [
    ["init", "-q"], ["config", "user.name", "AI-DLC Tests"], ["config", "user.email", "tests@example.com"],
    ["add", "-A"], ["commit", "-qm", "baseline"],
  ]) git(pd, args);
  if (options.dirty) writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2;\n");
  const baseline = writeBaselineSourceSnapshot(pd, STAGE, workspaceSourceListing(pd)!);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", "Source Baseline": baseline }, pd);
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE, "Source Baseline": baseline }, pd);
  if (options.legacy) appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, pd);
  appendAuditEntry("SESSION_STARTED", { Session: SESSION, Source: "t340 fixture" }, pd);
  publish(pd, "invoke-swarm");
  approve(pd, !options.legacy);
  return pd;
}

function converge(pd: string, options: {
  units?: string[]; batch?: string; legacy?: boolean; startedUnits?: string[]; splitStarts?: boolean;
} = {}): void {
  const floor = latestMainWorkflowStageRunFloorForProject(pd, STAGE);
  const listing = workspaceSourceListing(pd)!;
  const fingerprint = workspaceSourceFingerprint(pd)!;
  const commit = git(pd, ["rev-parse", "HEAD"]);
  let previous = sourceListingSha256(serializeSourceListing(listing));
  const start = (units: string[]) => appendAuditEntry("SWARM_STARTED", {
    Stage: STAGE, "Run floor": floor, "Batch number": "1",
    "Unit names": units.join(","), "Unit obligations": UNITS.join(","),
  }, pd);
  if (!options.splitStarts) start(options.startedUnits ?? UNITS);
  // These protected fixture appends stand in for native review/finalize/merge.
  // The real checkpoint validates their immutable source and artifact bindings.
  for (const unit of options.units ?? UNITS) {
    if (options.splitStarts) start([unit]);
    // Match the progress marks and reviewed plan bytes native finalize lands.
    // The review fingerprint below binds these bytes; Plan Approval binds the
    // executable body and must survive both permitted post-approval changes.
    const planPath = join(codeGenerationRecordDir(pd, unit), "code-generation-plan.md");
    writeFileSync(planPath, `${readFileSync(planPath, "utf-8").replace("- [ ] Implement", "- [x] Implement")}\n## Review\n\n**Verdict:** READY\n**Reviewer:** aidlc-architecture-reviewer-agent\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
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
      Stage: STAGE, "Run floor": floor, "Batch number": options.batch ?? "1", "Unit name": unit,
      ...(options.legacy ? {} : { "Source Commit": commit, "Source Fingerprint": fingerprint }),
    }, pd);
    if (!options.legacy) appendAuditEntry("SWARM_SOURCE_MERGED", {
      Stage: STAGE, "Run floor": floor, "Batch number": options.batch ?? "1", "Unit name": unit,
      "Source Commit": commit, "Merge commit": commit, Repo: "-",
      "Previous Source Fingerprint": previous, "Source Fingerprint": fingerprint,
    }, pd);
    previous = fingerprint;
  }
}

function next(pd: string) {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), pd);
  expect(result.status, result.out).toBe(0);
  expect(result.directive, result.out).not.toBeNull();
  return result.directive!;
}

function guard(pd: string, command: string) {
  return tool(pd, "hooks/aidlc-plan-approval-guard.ts", [], {
    hook_event_name: "PreToolUse", session_id: SESSION, cwd: pd,
    tool_name: "Bash", tool_input: { command },
  });
}

function gates(pd: string): number {
  return readAuditShardEvents(pd).filter((row) => row.event === "GATE_APPROVED" &&
    auditBlockField(row.block, "Checkpoint") === "swarm-batch").length;
}

describe("t340 grouped Plan Approval lifecycle and guard composition", () => {
  test("real checkpoint next and completion next preserve every grouped receipt and keep the review routes reachable", () => {
    const pd = fixture();
    for (const unit of UNITS) beginCodeGeneration(pd, { unit });
    converge(pd);
    const checkpoint = next(pd);
    expect(checkpoint.kind).toBe("run-stage");
    expect(checkpoint.swarm_checkpoint).toMatchObject({ batch: 1, units: UNITS, ready: true, approved: false });
    for (const unit of UNITS) {
      const approval = evaluateCodeGenerationApproval(pd, { unit });
      expect(approval.ok, approval.reason).toBe(true);
    }
    for (const entry of ["aidlc", "bun .claude/tools/aidlc.ts"]) {
      for (const action of ["status", "approve", "reject"]) {
        const result = guard(pd, `${entry} engine bolt swarm-checkpoint --action ${action} --batch 1 --units alpha,beta`);
        expect(result.code, result.err).toBe(0);
      }
    }
    expect(gates(pd)).toBe(0); // PreToolUse never grants checkpoint authority.
    expect(() => approveSwarmCheckpoint(pd, 1, UNITS)).toThrow("exact");
    appendAuditEntry("HUMAN_TURN", { Source: "t340 checkpoint choice" }, pd);
    expect(approveSwarmCheckpoint(pd, 1, UNITS, "Approve").approved).toBe(true);
    const completion = next(pd);
    expect(completion.kind).toBe("run-stage");
    expect(completion.construction_policy).toMatchObject({ completion_only: true });
    for (const unit of UNITS) {
      const approval = evaluateCodeGenerationApproval(pd, { unit });
      expect(approval.ok, approval.reason).toBe(true);
    }
    expect(guard(pd, "aidlc engine orchestrate report --stage code-generation --result completed --approved").code).toBe(0);
  }, 30_000);

  test("split successful starts of the same approved group preserve its checkpoint successor", () => {
    const pd = fixture();
    for (const unit of UNITS) beginCodeGeneration(pd, { unit });
    converge(pd, { splitStarts: true });
    const checkpoint = next(pd);
    expect(checkpoint.kind).toBe("run-stage");
    expect(checkpoint.swarm_checkpoint).toMatchObject({ batch: 1, units: UNITS, ready: true });
    for (const unit of UNITS) {
      const approval = evaluateCodeGenerationApproval(pd, { unit });
      expect(approval.ok, approval.reason).toBe(true);
    }
    // A later start for one member cannot reuse that member's earlier completion.
    appendAuditEntry("SWARM_STARTED", {
      Stage: STAGE, "Run floor": latestMainWorkflowStageRunFloorForProject(pd, STAGE),
      "Batch number": "1", "Unit names": "alpha", "Unit obligations": UNITS.join(","),
    }, pd);
    for (const unit of UNITS) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(false);
  }, 30_000);

  test.each(["missing", "partial", "wrong-batch", "wrong-start-set", "foreign-start-member"] as const)(
    "%s convergence cannot turn a run-stage marker into grouped authority", (kind) => {
      const pd = fixture();
      for (const unit of UNITS) beginCodeGeneration(pd, { unit });
      if (kind !== "missing") converge(pd, {
        ...(kind === "partial" ? { units: ["beta"] } : {}),
        ...(kind === "wrong-batch" ? { batch: "2" } : {}),
        ...(kind === "wrong-start-set" ? { startedUnits: ["beta"] } : {}),
        ...(kind === "foreign-start-member" ? { startedUnits: [...UNITS, "foreign"] } : {}),
      });
      publish(pd, "run-stage");
      for (const unit of UNITS) expect(evaluateCodeGenerationApproval(pd, { unit }).ok).toBe(false);
      expect(guard(pd, "aidlc engine orchestrate report --stage code-generation --result completed --approved").code).toBe(2);
      expect(guard(pd, "aidlc engine bolt swarm-checkpoint --action status --batch 1 --units alpha,beta").code).toBe(0);
      expect(gates(pd)).toBe(0);
    }, 30_000,
  );

  test.each(["plan", "source", "attempt", "workflow", "dag", "set"] as const)(
    "%s changes still invalidate the protected group", (kind) => {
      const pd = fixture();
      if (kind === "plan") {
        const file = join(codeGenerationRecordDir(pd, "alpha"), "code-generation-plan.md");
        writeFileSync(file, readFileSync(file, "utf-8").replace("- [ ] Implement", "- [ ] Implement additional behavior"));
      }
      if (kind === "source") writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 9;\n");
      if (kind === "attempt") appendAuditEntry("STAGE_STARTED", { Stage: STAGE, Unit: "alpha" }, pd);
      if (kind === "workflow") appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", Reason: "new workflow" }, pd);
      if (kind === "dag") seedBoltDagBatches(pd, [["alpha"], ["beta"]]);
      if (kind === "set") publish(pd, "invoke-swarm", ["beta"]);
      expect(evaluateCodeGenerationApproval(pd, { unit: "beta" }).ok).toBe(false);
    }, 30_000,
  );

  test("legacy convergence rows cannot grant a native checkpoint approval", () => {
    const pd = fixture();
    for (const unit of UNITS) beginCodeGeneration(pd, { unit });
    converge(pd, { legacy: true });
    publish(pd, "run-stage");
    const before = gates(pd);
    expect(guard(pd, 'aidlc engine bolt swarm-checkpoint --action approve --batch 1 --units alpha,beta --user-input Approve').code).toBe(0);
    expect(resolveSwarmCheckpoint(pd, 1, UNITS).ready).toBe(false);
    expect(() => approveSwarmCheckpoint(pd, 1, UNITS, "Approve")).toThrow("not ready");
    expect(gates(pd)).toBe(before);
  }, 30_000);
});

describe("t340 initial worktree approval preflight", () => {
  test("same source and ancestor bases pass without changing receipts, source, audit, HEAD or worktrees", () => {
    const pd = fixture();
    const base = git(pd, ["rev-parse", "HEAD"]);
    validateCodeGenerationForkApproval(pd, "alpha", pd, null, base);
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2;\n");
    git(pd, ["add", "src/alpha.ts"]);
    git(pd, ["commit", "-qm", "approved source"]);
    approve(pd);
    const snapshot = () => JSON.stringify({
      head: git(pd, ["rev-parse", "HEAD"]), status: git(pd, ["status", "--porcelain"]),
      worktrees: git(pd, ["worktree", "list", "--porcelain"]), audit: readAuditShardEvents(pd),
      source: workspaceSourceFingerprint(pd),
      receipt: readPlanApprovalReceipt(pd, {
        targetId: "unit:alpha", runFloor: resolveCodeGenerationAuthority(pd, { unit: "alpha" }).runFloor,
        fingerprint: evaluateCodeGenerationApproval(pd, { unit: "alpha" }).approvalFingerprint!,
      }),
    });
    const before = snapshot();
    validateCodeGenerationForkApproval(pd, "alpha", pd, null, base);
    expect(snapshot()).toBe(before);
    const divergent = git(pd, ["commit-tree", `${base}^{tree}`, "-p", base, "-m", "different base history"]);
    expect(() => validateCodeGenerationForkApproval(pd, "alpha", pd, null, divergent)).toThrow("ancestor");
    expect(() => validateCodeGenerationForkApproval(pd, "alpha", join(pd, "src"), null, base)).toThrow("repository");
    expect(snapshot()).toBe(before);
  }, 30_000);

  test.each([false, true])("dirty approved source refuses before a child exists (legacy autonomous: %s)", (legacy) => {
    const pd = fixture({ dirty: true, legacy });
    const before = git(pd, ["worktree", "list", "--porcelain"]);
    const head = git(pd, ["rev-parse", "HEAD"]);
    expect(() => validateCodeGenerationForkApproval(pd, "alpha", pd, null, head)).toThrow("Commit the already-approved parent source before prepare");
    expect(git(pd, ["worktree", "list", "--porcelain"])).toBe(before);
    expect(git(pd, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(pd, "src", "alpha.ts"), "utf-8")).toContain("= 2");
    git(pd, ["add", "src/alpha.ts"]);
    git(pd, ["commit", "-qm", "approved parent source"]);
    expect(() => validateCodeGenerationForkApproval(pd, "alpha", pd, null, head)).not.toThrow();
  }, 30_000);
});
