// covers: function:checkpointPolicyEnabled, function:resolveConstructionCheckpoint,
// function:verifyConstructionCheckpoint, function:approveConstructionCheckpoint,
// function:rejectConstructionCheckpoint, audit:GATE_APPROVED, audit:GATE_REJECTED
// covers: function:authorizedVerificationCommand, function:verificationCommandDetails, audit:VERIFICATION_COMMAND_RECORDED, subcommand:aidlc-state:set-construction-verification-command
// covers: function:recordProtectedHumanResponse, hook:aidlc-record-human-turn
// covers: audit:CHECKPOINT_VERIFICATION_RECORDED
// covers: function:readVerificationCommandFile
// covers: function:askConstructionCheckpoint, function:mintProtectedQuestion
// covers: function:withdrawProtectedQuestions, function:protectedTargetDigest, function:requireProtectedResponse

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  approveConstructionCheckpoint,
  checkpointPolicyEnabled,
  loadConstructionEvidence,
  rejectConstructionCheckpoint,
  resolveConstructionCheckpoint,
  verifyConstructionCheckpoint,
} from "../../dist/claude/.claude/tools/aidlc-construction-checkpoints.ts";
import {
  approvedConstructionUnits,
  authorizedVerificationCommand,
  verificationCommandDetails,
  artifactFilename,
  auditBlockField,
  humanActedSinceGate,
  readProtectedQuestion,
  readProtectedResponse,
  writeProtectedResponse,
  mintProtectedQuestion,
  protectedQuestionRelativePath,
  protectedTargetDigest,
  requireProtectedResponse,
  readPlanApprovalChallenge,
  readPlanApprovalResponse,
  writePlanApprovalChallenge,
  writePlanApprovalResponse,
  planApprovalChallengeRelativePath,
  resolveSessionIdFromAncestry,
  type PlanApprovalRuntimeChallenge,
  findStageBySlug,
  latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents,
  readUnitSourceManifest,
  reviewArtifactFingerprint,
  setField,
  unitMajorConstructionStageSlugs,
  workspaceSourceFingerprint,
  workspaceSourceListing,
  writeUnitSourceSnapshot,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  cleanupTestProject,
  AIDLC_SRC,
  createTestProject,
  resetAidlcEnv,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededAuditShard,
  seededStateFile,
} from "../harness/fixtures.ts";

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const STAGES = [
  "functional-design", "nfr-requirements", "nfr-design",
  "infrastructure-design", "code-generation",
];

function state(autonomous = false, iteration = "unit-major"): string {
  return `# AI-DLC State Tracking

## Project Information
- **Scope**: feature
- **Project Type**: Greenfield
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Construction Checkpoints**: enabled
- **Construction Iteration**: ${iteration}
- **Construction Autonomy Mode**: ${autonomous ? "autonomous" : "gated"}
- **Review Override**: none
- **Change Control**: strict
- **Unit Ownership**: solo

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none

## Stage Progress
### CONSTRUCTION PHASE
- [x] functional-design — EXECUTE
- [-] nfr-requirements — EXECUTE
- [ ] nfr-design — EXECUTE
- [ ] infrastructure-design — EXECUTE
- [ ] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: nfr-requirements
- **Status**: Running
`;
}

function artifact(project: string, unit: string, slug: string, name?: string): string {
  return join(seededRecordDir(project), "construction", unit, slug,
    artifactFilename(name ?? findStageBySlug(slug)!.produces![0]));
}

function complete(project: string, unit: string): void {
  for (const slug of STAGES) {
    const definition = findStageBySlug(slug)!;
    const fingerprint = reviewArtifactFingerprint(project, definition, unit, { requireRequiredArtifacts: true });
    expect(fingerprint).not.toBeNull();
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(project, slug, true, unit),
      "Artifact Fingerprint": fingerprint!,
    }, project);
  }
}

function project(autonomous = false, iteration = "unit-major"): string {
  const dir = createTestProject();
  projects.push(dir);
  seedAidlcMemory(dir);
  writeFileSync(seededStateFile(dir), state(autonomous, iteration));
  seedBoltDag(dir, ["alpha", "beta"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) {
    writeFileSync(join(dir, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
    for (const slug of STAGES) {
      const definition = findStageBySlug(slug)!;
      const output = join(seededRecordDir(dir), "construction", unit, slug);
      mkdirSync(output, { recursive: true });
      for (const name of definition.produces ?? []) {
        writeFileSync(join(output, artifactFilename(name)), `# ${slug}: ${unit}: ${name}\n`);
      }
      if (definition.workspace_requires) {
        writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
          stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
        }));
      }
    }
  }
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, dir);
  if (autonomous) appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, dir);
  complete(dir, "alpha");
  complete(dir, "beta");
  return dir;
}

function human(project: string, kind: "unit" | "skeleton" = "unit", prompt = "Approve"): void {
  const asked = cli(project, "bolt", ["checkpoint", "--action", "ask", "--unit", "alpha", "--kind", kind, "--session", "t341-checkpoint"]);
  expect(asked.code, asked.out).toBe(0);
  submitCommandChoice(project, "t341-checkpoint", prompt);
}

function writeCheck(project: string, body: string): string {
  // An actual project command, invoked through the platform's native shell.
  // The script lives in the framework record so changing test behavior does
  // not itself change the Unit's claimed application source.
  writeFileSync(join(seededRecordDir(project), "checkpoint-check.cjs"), body);
  const script = join(seededRecordDir(project), "checkpoint-check.cjs");
  const quote = (value: string): string => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  return `${quote(process.execPath)} ${quote(script)}`;
}

function cli(project: string, tool: string, args: string[], env = process.env) {
  const result = childProcess.spawnSync(process.execPath, [
    join(AIDLC_SRC, `tools/aidlc-${tool}.ts`), ...args, "--project-dir", project,
  ], { encoding: "utf-8", env });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function submitCommandChoice(project: string, session: string, prompt: string, env = process.env): void {
  const submitted = childProcess.spawnSync(process.execPath, [join(AIDLC_SRC, "hooks/aidlc-record-human-turn.ts")], {
    encoding: "utf-8", cwd: project,
    env: { ...env, AIDLC_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(submitted.status, `${submitted.stdout}${submitted.stderr}`).toBe(0);
}

function recordCommand(project: string, command: string): void {
  if (authorizedVerificationCommand(project, readFileSync(seededStateFile(project), "utf-8"))?.command === command) return;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "t341-command"];
  for (const args of [
    ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"],
    ["answer", ...identity, "--details", "Approve"],
  ]) {
    const result = cli(project, "log", args, { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
    expect(result.code, result.out).toBe(0);
    if (args[0] === "decision") submitCommandChoice(project, "t341-command", "Approve");
  }
  const result = cli(project, "state", ["set-construction-verification-command", command]);
  expect(result.code, result.out).toBe(0);
}

function pass(project: string, kind: "unit" | "skeleton" = "unit", unit = "alpha") {
  const command = writeCheck(project,
    "const fs = require('node:fs');\n" +
    "if (!fs.readFileSync('src/alpha.ts', 'utf8').includes('alpha')) process.exit(3);\n" +
    "console.log('integrated check passed');\n");
  recordCommand(project, command);
  const result = verifyConstructionCheckpoint(project, unit, kind);
  expect(result.errors).toEqual([]);
  expect(result.verified).toBe(true);
  return result;
}

function approvals(project: string) {
  return readAuditShardEvents(project).filter((row) => row.event === "GATE_APPROVED");
}

describe("t341 Construction checkpoint verification and evidence", () => {
  test("routing evidence cannot carry approval across a different state or intent record", () => {
    const dir = project();
    pass(dir, "skeleton");
    human(dir, "skeleton");
    expect(approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve", "t341-checkpoint").approved).toBe(true);
    const evidence = loadConstructionEvidence(dir);
    expect(approvedConstructionUnits(dir, evidence.state, evidence).has("alpha")).toBe(true);

    const other = project();
    expect(resolveConstructionCheckpoint(other, "alpha", "skeleton", evidence.state, evidence).approved).toBe(false);
    expect(approvedConstructionUnits(other, evidence.state, evidence).has("alpha")).toBe(false);

    writeFileSync(join(dir, "src", "alpha.ts"), "export const alpha = 2;\n");
    const changedState = setField(evidence.state, "Current Stage", "code-generation");
    writeFileSync(seededStateFile(dir), changedState);
    expect(resolveConstructionCheckpoint(dir, "alpha", "skeleton", undefined, evidence).approved).toBe(false);
    expect(approvedConstructionUnits(dir, changedState, evidence).has("alpha")).toBe(false);
  }, 30_000);

  test("refreshing unchanged completion evidence or rerunning the same check preserves approval", () => {
    const dir = project();
    pass(dir);
    human(dir);
    const approved = approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint");
    complete(dir, "alpha");
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").approved).toBe(true);
    const repeated = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(repeated.fingerprint).toBe(approved.fingerprint);
    expect(repeated.approved).toBe(true);
    recordCommand(dir, "exit 0");
    const stale = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(stale.verified).toBe(false);
    expect(stale.approved).toBe(false);
    const differentCheck = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(differentCheck.verified).toBe(true);
    expect(differentCheck.approved).toBe(false);
  }, 30_000);

  test("revoking autonomy preserves completed approvals and restores future human gates", () => {
    const dir = project(true);
    pass(dir, "unit", "alpha");
    expect(approveConstructionCheckpoint(dir, "alpha", "unit").approved).toBe(true);
    const count = approvals(dir).length;
    expect(approveConstructionCheckpoint(dir, "alpha", "unit").approved).toBe(true);
    expect(approvals(dir)).toHaveLength(count);
    writeFileSync(seededStateFile(dir), setField(readFileSync(seededStateFile(dir), "utf-8"), "Construction Autonomy Mode", "gated"));
    appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "gated" }, dir);
    const previous = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(previous.approved).toBe(true);
    expect(resolveConstructionCheckpoint(dir, "beta", "unit").human_required).toBe(true);
  }, 30_000);

  test("exact policy opt-in, authoritative Unit, and complete in-scope stage set", () => {
    expect(checkpointPolicyEnabled("")).toBe(false);
    expect(checkpointPolicyEnabled("- **Scope**: feature\n- **Construction Checkpoints**: enabled")).toBe(true);
    expect(checkpointPolicyEnabled("- **Scope**: infra\n- **Construction Checkpoints**: enabled")).toBe(false);
    expect(checkpointPolicyEnabled("- **Construction Checkpoints**: enabled-ish")).toBe(false);
    const dir = project();
    const resolved = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(resolved.stages).toEqual(STAGES);
    expect(resolved.stages).toEqual(unitMajorConstructionStageSlugs("feature", state(), true));
    expect(resolved.ready, resolved.errors.join("\n")).toBe(true);
    expect(resolved.verified).toBe(false);
    expect(resolved.approved).toBe(false);
    for (const unit of ["missing", "Alpha", "alpha ", "../alpha"]) {
      expect(() => resolveConstructionCheckpoint(dir, unit, "unit")).toThrow();
      expect(() => verifyConstructionCheckpoint(dir, unit, "unit")).toThrow();
    }
    writeFileSync(seededStateFile(dir), state().replace("- **Construction Checkpoints**: enabled\n", ""));
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").enabled).toBe(false);
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit")).toThrow("not ready");
  });

  test("persists bounded diagnostics and full output digests, and a failed check revokes approval", () => {
    const dir = project();
    const verified = pass(dir);
    const rawProof = readFileSync(verified.proof_path, "utf-8");
    const proof = JSON.parse(rawProof);
    const output = "integrated check passed\n";
    expect(proof.version).toBe(4);
    expect(proof).not.toHaveProperty("command");
    expect(proof.command_sha256).toBe(authorizedVerificationCommand(dir, readFileSync(seededStateFile(dir), "utf-8"))!.sha256);
    expect(proof.command_label).toBe(verified.verification_command);
    expect(proof.exit_code).toBe(0);
    expect(verified.verification!.stdout_sha256).toBe(createHash("sha256").update(output).digest("hex"));
    expect(verified.verification!.stdout_bytes).toBe(Buffer.byteLength(output));
    expect(verified.verification!.stderr_bytes).toBe(0);
    expect(verified.verification!.stderr_sha256).toBe(createHash("sha256").update("").digest("hex"));
    expect(verified.verification!.stdout_tail).toBe(output);
    expect(verified.verification!.stderr_tail).toBe("");
    expect(verified.proof_path).toStartWith(join(seededRecordDir(dir), ".aidlc-construction-checkpoints"));
    human(dir);
    expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint").approved).toBe(true);
    const marker = `FAILURE_MARKER_${randomUUID()}`;
    const diagnostic = "discarded output prefix\n" + "x".repeat(10 * 1024) + `\x1b[31m${marker}\n`;
    recordCommand(dir, writeCheck(dir,
      `process.stdout.write(${JSON.stringify(diagnostic)});\n` +
      `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 7;\n`));
    const failed = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(failed.verified).toBe(false);
    expect(failed.approved).toBe(false);
    expect(failed.verification!.exit_code).toBe(7);
    expect(failed.verification!.stdout_bytes).toBe(Buffer.byteLength(diagnostic));
    expect(failed.verification!.stderr_bytes).toBe(Buffer.byteLength(diagnostic));
    expect(failed.verification!.stdout_sha256).toBe(createHash("sha256").update(diagnostic).digest("hex"));
    expect(failed.verification!.stderr_sha256).toBe(failed.verification!.stdout_sha256);
    for (const tail of [failed.verification!.stdout_tail, failed.verification!.stderr_tail]) {
      expect(tail.length).toBeLessThanOrEqual(2048);
      expect(tail).toBe("x".repeat(2048 - marker.length - 6) + `\ufffd[31m${marker}\n`);
      expect(tail).not.toContain("\x1b");
    }
    expect(failed.verification!.stderr_tail).toContain(marker);
    const status = cli(dir, "bolt", ["checkpoint", "--action", "status", "--unit", "alpha", "--kind", "unit"]);
    expect(status.code, status.out).toBe(0);
    expect(JSON.parse(status.out).verification.stderr_tail).toBe(failed.verification!.stderr_tail);
    expect(readFileSync(failed.proof_path, "utf-8")).not.toContain("discarded output prefix");
    expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint")).toThrow("Verify");
    for (const cmd of ["", " \n\t", "a".repeat(1025), "echo\0bad"]) {
      expect(() => verificationCommandDetails(cmd)).toThrow("nonblank");
    }
  }, 60_000);

  test.each([1, 2, 3])("legacy v%i proofs revoke verification and prior approval without throwing", (version) => {
    const dir = project();
    const verified = pass(dir);
    human(dir);
    expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint").approved).toBe(true);
    const proof = { ...verified.verification!, version, stdout_tail: undefined, stderr_tail: undefined };
    writeFileSync(verified.proof_path, JSON.stringify(proof));
    const current = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(current.ready).toBe(true);
    expect(current.verified).toBe(false);
    expect(current.approved).toBe(false);
    expect(current.verification).toBeNull();
  }, 30_000);

  test("missing, non-string, and oversized proof tails invalidate verification", () => {
    const dir = project();
    const verified = pass(dir);
    for (const field of ["stdout_tail", "stderr_tail"]) {
      for (const value of [undefined, null, "x".repeat(2049)]) {
        writeFileSync(verified.proof_path, JSON.stringify({ ...verified.verification!, [field]: value }));
        const current = resolveConstructionCheckpoint(dir, "alpha", "unit");
        expect(current.verified).toBe(false);
        expect(current.verification).toBeNull();
      }
    }
  }, 30_000);

  test("output summaries bind captured bytes without lossy UTF-8 decoding", () => {
    const dir = project();
    const stdout = Buffer.from([0x61, 0xc3, 0xa9, 0xff, 0x00, 0x09, 0x0d, 0x7f, 0xc2, 0x85, 0x0a]);
    const stderr = Buffer.from([0xfe, 0x0a]);
    recordCommand(dir, writeCheck(dir,
      `process.stdout.write(Buffer.from(${JSON.stringify([...stdout])}));\n` +
      `process.stderr.write(Buffer.from(${JSON.stringify([...stderr])}));\n`));
    const verified = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(verified.verified).toBe(true);
    expect(verified.verification!.stdout_bytes).toBe(stdout.length);
    expect(verified.verification!.stderr_bytes).toBe(stderr.length);
    expect(verified.verification!.stdout_sha256).toBe(createHash("sha256").update(stdout).digest("hex"));
    expect(verified.verification!.stderr_sha256).toBe(createHash("sha256").update(stderr).digest("hex"));
    expect(verified.verification!.stdout_tail).toBe("aé\ufffd\ufffd\t\ufffd\ufffd\ufffd\n");
    expect(verified.verification!.stderr_tail).toBe("\ufffd\n");
  }, 30_000);

  test("tails truncate bytes at UTF-8 boundaries while preserving complete multibyte output", () => {
    const dir = project();
    const stdoutSuffix = "é".repeat(1022) + "\n";
    const stdout = "\u{1f642}" + stdoutSuffix;
    const stderr = "€" + "x".repeat(2045);
    recordCommand(dir, writeCheck(dir,
      `process.stdout.write(${JSON.stringify(stdout)});\n` +
      `process.stderr.write(${JSON.stringify(stderr)});\n`));
    const verified = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(verified.verified).toBe(true);
    expect(verified.verification!.stdout_tail).toBe(stdoutSuffix);
    expect(verified.verification!.stderr_tail).toBe(stderr);
    expect(verified.verification!.stdout_bytes).toBe(Buffer.byteLength(stdout));
    expect(verified.verification!.stdout_sha256).toBe(createHash("sha256").update(stdout).digest("hex"));
  }, 30_000);

  test.skipIf(process.platform === "win32" || !fs.existsSync("/bin/bash"))(
    "Bash project checks verify, while a failed pipeline revokes prior approval",
    () => {
      const dir = project();
      const command = 'set -o pipefail; checks=(src/alpha.ts); ' +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expands the array in the project check.
        '[[ -f "${checks[0]}" ]] && cat <(printf "%s\\n" "bash check passed")';
      recordCommand(dir, command);
      const verified = verifyConstructionCheckpoint(dir, "alpha", "unit");
      expect(verified.verified).toBe(true);
      expect(verified.approved).toBe(false);
      expect(verified.verification!.command_sha256).toBe(createHash("sha256").update(command).digest("hex"));
      expect(verified.verification!.exit_code).toBe(0);
      expect(verified.verification!.stdout_sha256).toBe(createHash("sha256").update("bash check passed\n").digest("hex"));
      expect(verified.verification!.stdout_bytes).toBe(Buffer.byteLength("bash check passed\n"));
      expect(verified.verification!.stderr_bytes).toBe(0);
      expect(verified.verification!.evidence_unchanged).toBe(true);
      human(dir);
      expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint").approved).toBe(true);
      recordCommand(dir, "set -o pipefail; false | true");
      const failed = verifyConstructionCheckpoint(dir, "alpha", "unit");
      expect(failed.verification!.exit_code).toBe(1);
      expect(failed.verification!.evidence_unchanged).toBe(true);
      expect(failed.verified).toBe(false);
      expect(failed.approved).toBe(false);
      expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint")).toThrow("Verify");
      expect(approvals(dir)).toHaveLength(1);
    }, 60_000,
  );

  test.skipIf(process.platform === "win32")("falls back to sh when Bash is absent", () => {
    const dir = project();
    const existsSync = fs.existsSync;
    const bashAbsent = spyOn(fs, "existsSync").mockImplementation((path) =>
      path === "/bin/bash" ? false : existsSync(path));
    const spawn = spyOn(childProcess, "spawnSync");
    try {
      const command = 'test -f src/alpha.ts && printf "%s\\n" "POSIX fallback passed"';
      recordCommand(dir, command);
      const verified = verifyConstructionCheckpoint(dir, "alpha", "unit");
      expect(spawn).toHaveBeenCalledWith("/bin/sh", ["-c", command], expect.objectContaining({ cwd: dir }));
      expect(verified.verified).toBe(true);
      expect(verified.approved).toBe(false);
      expect(verified.verification!.exit_code).toBe(0);
      expect(verified.verification!.stdout_sha256).toBe(createHash("sha256").update("POSIX fallback passed\n").digest("hex"));
      expect(verified.verification!.stdout_bytes).toBe(Buffer.byteLength("POSIX fallback passed\n"));
      expect(verified.verification!.evidence_unchanged).toBe(true);
    } finally {
      spawn.mockRestore();
      bashAbsent.mockRestore();
    }
  }, 30_000);

  test("an edit during an otherwise passing check cannot mint a verification", () => {
    const dir = project();
    const command = writeCheck(dir,
      "require('node:fs').appendFileSync('src/alpha.ts', '// changed during verification\\n');\n");
    recordCommand(dir, command);
    const result = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(result.verification!.exit_code).toBe(0);
    expect(result.verification!.evidence_unchanged).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.approved).toBe(false);
  }, 60_000);

  test("stage artifacts, claimed source, and manifest edits invalidate verification", () => {
    const dir = project();
    pass(dir);
    const path = artifact(dir, "alpha", "functional-design");
    const original = readFileSync(path, "utf-8");
    writeFileSync(path, `${original}\nChanged requirement\n`);
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(false);
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit")).toThrow("completion");
    writeFileSync(path, original);
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(true);
    writeFileSync(join(dir, "src", "alpha.ts"), "export const alpha = 2;\n");
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(false);
    pass(dir);
    const manifest = join(seededRecordDir(dir), "construction", "alpha", "code-generation", "source-manifest.json");
    writeFileSync(manifest, `${readFileSync(manifest, "utf-8")}\n`);
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(false);
  }, 60_000);

  test("missing outputs, missing completion, and unbindable source fail closed", () => {
    const dir = project();
    rmSync(artifact(dir, "alpha", "nfr-design"));
    const missing = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(missing.ready).toBe(false);
    expect(missing.errors.join("\n")).toContain("required outputs");
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit")).toThrow("not ready");
    const other = project();
    appendAuditEntry("UNIT_STARTED", {
      Stage: "functional-design", Unit: "alpha",
      "Run floor": latestMainWorkflowStageRunFloorForProject(other, "functional-design", true, "alpha"),
    }, other);
    expect(resolveConstructionCheckpoint(other, "alpha", "unit").ready).toBe(false);
    const unbound = project();
    rmSync(join(seededRecordDir(unbound), "construction", "alpha", "code-generation", "source-manifest.json"));
    expect(resolveConstructionCheckpoint(unbound, "alpha", "unit").errors.join("\n")).toContain("source manifest");
  });
});

describe("t341 tool-owned checkpoint verification receipts", () => {
  test("a hand-written v4 proof cannot approve a checkpoint without its verifier receipt", () => {
    const dir = project();
    recordCommand(dir, "exit 0");
    const current = resolveConstructionCheckpoint(dir, "alpha", "unit");
    const emptyDigest = createHash("sha256").update("").digest("hex");
    const timestamp = new Date().toISOString();
    mkdirSync(join(seededRecordDir(dir), ".aidlc-construction-checkpoints", "alpha"), { recursive: true });
    writeFileSync(current.proof_path, JSON.stringify({
      version: 4, id: randomUUID(), kind: "unit", unit: "alpha", fingerprint: current.fingerprint,
      command_sha256: verificationCommandDetails("exit 0").sha256, command_label: "exit 0",
      started_at: timestamp, finished_at: timestamp, exit_code: 0, signal: null,
      stdout_bytes: 0, stderr_bytes: 0, stdout_sha256: emptyDigest, stderr_sha256: emptyDigest,
      stdout_tail: "", stderr_tail: "",
      error: null, evidence_unchanged: true, verified: true,
    }));
    const forged = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(forged.ready).toBe(true);
    expect(forged.verification?.verified).toBe(true);
    expect(forged.verified).toBe(false);
    expect(forged.approved).toBe(false);
    expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint"))
      .toThrow("CHECKPOINT_VERIFICATION_RECORDED");
    expect(approvals(dir)).toEqual([]);

    const verified = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(verified.verified).toBe(true);
    const receipt = readAuditShardEvents(dir).find((row) => row.event === "CHECKPOINT_VERIFICATION_RECORDED")!;
    for (const [key, value] of Object.entries({
      Unit: "alpha", Kind: "unit", Stage: "code-generation", Stages: STAGES.join(", "),
      "Verification Id": verified.verification!.id, Fingerprint: verified.fingerprint,
      "Command SHA-256": verificationCommandDetails("exit 0").sha256,
      "Exit Code": "0", Verified: "true", "Run floor": verified.run_floor,
    })) expect(auditBlockField(receipt.block, key)).toBe(value);
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(true);
    human(dir);
    const approved = approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint");
    expect(approved.approved).toBe(true);
    expect(auditBlockField(approvals(dir).at(-1)!.block, "Verification Id")).toBe(verified.verification!.id);
  }, 30_000);

  test("the latest receipt must authorize this proof id, not a previous successful proof", () => {
    const dir = project();
    const verified = pass(dir);
    human(dir);
    expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint").approved).toBe(true);
    appendAuditEntry("CHECKPOINT_VERIFICATION_RECORDED", {
      Unit: "alpha", Kind: "unit", Stage: "code-generation", Stages: STAGES.join(", "),
      "Verification Id": randomUUID(), Fingerprint: verified.fingerprint,
      "Command SHA-256": verified.verification!.command_sha256,
      "Exit Code": "0", Verified: "true", "Run floor": verified.run_floor,
    }, dir);
    const current = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(current.verified).toBe(false);
    expect(current.approved).toBe(false);
    expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint"))
      .toThrow("CHECKPOINT_VERIFICATION_RECORDED");
  }, 30_000);

  test("a failed verifier receipt cannot be upgraded by editing its proof JSON", () => {
    const dir = project();
    recordCommand(dir, "exit 7");
    const failed = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(failed.verified).toBe(false);
    const receipt = readAuditShardEvents(dir).find((row) => row.event === "CHECKPOINT_VERIFICATION_RECORDED")!;
    expect(auditBlockField(receipt.block, "Verification Id")).toBe(failed.verification!.id);
    expect(auditBlockField(receipt.block, "Exit Code")).toBe("7");
    expect(auditBlockField(receipt.block, "Verified")).toBe("false");
    writeFileSync(failed.proof_path, JSON.stringify({ ...failed.verification!, exit_code: 0, verified: true }));
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(false);
    expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint"))
      .toThrow("CHECKPOINT_VERIFICATION_RECORDED");
  }, 30_000);

  test("a proof written before an audit append failure remains unverified", () => {
    const dir = project();
    const previous = pass(dir);
    const shard = readAuditShardEvents(dir)[0].shard;
    const originalOpen = fs.openSync;
    const failedAppend = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (path === shard && typeof flags === "number" && (flags & fs.constants.O_APPEND) !== 0) {
        throw Object.assign(new Error("Audit shard is not writable"), { code: "EACCES" });
      }
      return originalOpen(path, flags, mode);
    });
    try {
      expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit")).toThrow("Audit shard is not writable");
    } finally {
      failedAppend.mockRestore();
    }
    const current = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(current.verification!.id).not.toBe(previous.verification!.id);
    expect(current.verification!.verified).toBe(true);
    expect(current.verified).toBe(false);
    expect(current.approved).toBe(false);
    expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint"))
      .toThrow("CHECKPOINT_VERIFICATION_RECORDED");
    expect(verifyConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(true);
  }, 30_000);

  test("a prior-attempt receipt cannot authorize a proof after a stage jump", () => {
    const dir = project();
    const verified = pass(dir);
    appendAuditEntry("STAGE_JUMPED", { Stage: "code-generation" }, dir);
    complete(dir, "alpha");
    const current = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(current.ready).toBe(true);
    expect(current.run_floor).not.toBe(verified.run_floor);
    expect(current.verified).toBe(false);
    expect(current.approved).toBe(false);
    // Even replacing the proof's fingerprint cannot move its receipt to this attempt.
    writeFileSync(current.proof_path, JSON.stringify({ ...verified.verification!, fingerprint: current.fingerprint }));
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(false);
    expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint"))
      .toThrow("CHECKPOINT_VERIFICATION_RECORDED");
    expect(verifyConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(true);
  }, 30_000);

  test("public audit append cannot mint a verifier receipt", () => {
    const dir = project();
    const refused = cli(dir, "audit", ["append", "CHECKPOINT_VERIFICATION_RECORDED", "--field", "Verified=true"]);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("reserved");
    expect(readAuditShardEvents(dir).some((row) => row.event === "CHECKPOINT_VERIFICATION_RECORDED")).toBe(false);
  });
});

describe("t341 verification command consent", () => {
  test("command files cross the shell boundary without evaluating repo-derived text", () => {
    const dir = project();
    const marker = join(dir, "backtick-marker");
    const marker2 = join(dir, "substitution-marker");
    const command = `echo \`touch ${marker}\` $(touch ${marker2}) 'q' "dq" ; | >`;
    writeFileSync(join(seededRecordDir(dir), "verification-command.txt"), `  ${command}\n`);
    const shellCli = (tool: string, args: string) => {
      const result = childProcess.spawnSync(
        `"${process.execPath}" "${join(AIDLC_SRC, `tools/aidlc-${tool}.ts`)}" ${args} --project-dir "${dir}"`,
        { encoding: "utf-8", shell: true },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    };
    const identity = '--stage code-generation --checkpoint verification-command --command-file verification-command.txt --session t341-command-file';
    shellCli("log", `decision ${identity} --decision "Use this command?" --options "Approve,Request Changes"`);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(marker2)).toBe(false);
    submitCommandChoice(dir, "t341-command-file", "Approve");
    shellCli("log", `answer ${identity} --details Approve`);
    shellCli("state", "set-construction-verification-command --command-file verification-command.txt");
    const authorization = authorizedVerificationCommand(dir, readFileSync(seededStateFile(dir), "utf-8"))!;
    expect(authorization.command).toBe(command);
    expect(authorization.sha256).toBe(createHash("sha256").update(command).digest("hex"));
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(marker2)).toBe(false);
  }, 30_000);

  test("a trailing file newline has the same authorization as a direct command", () => {
    const dir = project();
    writeFileSync(join(seededRecordDir(dir), "verification-command.txt"), "bun test\n");
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--session", "t341-command-file"];
    const decision = cli(dir, "log", ["decision", ...identity, "--command", "bun test", "--decision", "Use this command?", "--options", "Approve,Request Changes"]);
    expect(decision.code, decision.out).toBe(0);
    submitCommandChoice(dir, "t341-command-file", "Approve");
    const answer = cli(dir, "log", ["answer", ...identity, "--command-file", "verification-command.txt", "--details", "Approve"]);
    expect(answer.code, answer.out).toBe(0);
    const setter = cli(dir, "state", ["set-construction-verification-command", "--command-file", "verification-command.txt"]);
    expect(setter.code, setter.out).toBe(0);
    expect(authorizedVerificationCommand(dir, readFileSync(seededStateFile(dir), "utf-8"))).toEqual(verificationCommandDetails("bun test"));
  }, 30_000);

  test("decision and answer require exactly one command transport; the setter rejects mixed or missing input", () => {
    const dir = project();
    writeFileSync(join(seededRecordDir(dir), "verification-command.txt"), "bun test\n");
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--session", "t341-command-file"];
    for (const transport of [[], ["--command", "bun test", "--command-file", "verification-command.txt"]]) {
      for (const action of [["decision", "--decision", "Use this command?", "--options", "Approve,Request Changes"], ["answer", "--details", "Approve"]]) {
        const refused = cli(dir, "log", [...action, ...identity, ...transport]);
        expect(refused.code).not.toBe(0);
        expect(refused.out).toContain("exactly one of --command or --command-file");
      }
    }
    for (const args of [[], ["--command-file"], ["bun test", "--command-file", "verification-command.txt"]]) {
      expect(cli(dir, "state", ["set-construction-verification-command", ...args]).code).not.toBe(0);
    }
    expect(readAuditShardEvents(dir).some((row) => row.event === "DECISION_RECORDED" || row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
  }, 30_000);

  test("command files must stay in the record without symlinks and satisfy byte and command limits", () => {
    const dir = project();
    const root = seededRecordDir(dir);
    writeFileSync(join(root, "command.txt"), "bun test\n");
    // The file byte cap rejects oversized input before command validation.
    writeFileSync(join(root, "oversize.txt"), "界".repeat(6000));
    writeFileSync(join(root, "long-command.txt"), "x".repeat(1025));
    writeFileSync(join(root, "multiline.txt"), "bun test\nbun run build");
    mkdirSync(join(root, "commands"));
    writeFileSync(join(root, "commands", "command.txt"), "bun test\n");
    symlinkSync(join(root, "commands"), join(root, "redirect"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(join(root, "command.txt"), join(root, "command-link.txt"));
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--session", "t341-command-file"];
    for (const file of [
      join(root, "command.txt"),
      "commands/../command.txt",
      "redirect/command.txt",
      "command-link.txt",
      "oversize.txt",
      "long-command.txt",
      "multiline.txt",
    ]) {
      for (const [tool, args] of [
        ["log", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"]],
        ["log", ["answer", ...identity, "--details", "Approve"]],
        ["state", ["set-construction-verification-command"]],
      ] as const) {
        const refused = cli(dir, tool, [...args, "--command-file", file]);
        expect(refused.code).not.toBe(0);
      }
    }
    expect(readAuditShardEvents(dir).some((row) => row.event === "DECISION_RECORDED" || row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
  }, 30_000);

  // Like t137, this injects an append failure using a readable, unwritable shard.
  // Native Windows does not enforce chmod's write denial.
  for (const choice of ["Approve", "Request Changes"] as const) {
    (process.platform === "win32" ? test.skip : test)(`an audit append failure preserves ${choice} for exactly one successful retry`, () => {
      const dir = project();
      const session = "t341-retry";
      const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "bun test", "--session", session];
      const decision = cli(dir, "log", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"]);
      expect(decision.code, decision.out).toBe(0);
      submitCommandChoice(dir, session, choice);
      const challenge = readProtectedQuestion(dir, session);
      const response = readProtectedResponse(dir, session);
      expect(challenge).not.toBeNull();
      expect(response?.choice).toBe(choice);
      const shard = seededAuditShard(dir);
      const before = readFileSync(shard, "utf-8");
      const answer = ["answer", ...identity, "--details", choice];
      fs.chmodSync(shard, 0o444);
      try {
        const failed = cli(dir, "log", answer);
        expect(failed.code, failed.out).not.toBe(0);
        expect(failed.out).toMatch(/EACCES|EPERM|permission denied/i);
      } finally {
        fs.chmodSync(shard, 0o644);
      }
      expect(readFileSync(shard, "utf-8")).toBe(before);
      expect(readProtectedQuestion(dir, session)).toEqual(challenge);
      expect(readProtectedResponse(dir, session)).toEqual(response);
      const retry = cli(dir, "log", answer);
      expect(retry.code, retry.out).toBe(0);
      const event = choice === "Approve" ? "VERIFICATION_COMMAND_RECORDED" : "QUESTION_ANSWERED";
      expect(JSON.parse(retry.out).emitted).toBe(event);
      expect(readProtectedQuestion(dir, session)).toBeNull();
      expect(readProtectedResponse(dir, session)).toBeNull();
      expect(cli(dir, "log", answer).code).not.toBe(0);
      const receipts = readAuditShardEvents(dir).filter((row) => row.event === event);
      expect(receipts).toHaveLength(1);
      expect(auditBlockField(receipts[0].block, "User Input")).toBe(choice);
    }, 30_000);
  }

  test("missing receipt, hand-written field, and mismatched command cannot execute or write proof", () => {
    const dir = project();
    const path = resolveConstructionCheckpoint(dir, "alpha", "unit").proof_path;
    const refused = () => {
      expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit")).toThrow("VERIFICATION_COMMAND_RECORDED");
      expect(resolveConstructionCheckpoint(dir, "alpha", "unit").command_authorized).toBe(false);
      expect(fs.existsSync(path)).toBe(false);
    };
    refused();
    writeFileSync(seededStateFile(dir), readFileSync(seededStateFile(dir), "utf-8").replace(
      "## Runtime State", "## Runtime State\n- **Construction Verification Command**: exit 0",
    ));
    refused();
    recordCommand(dir, "exit 0");
    writeFileSync(seededStateFile(dir), setField(readFileSync(seededStateFile(dir), "utf-8"), "Construction Verification Command", "exit 1"));
    refused();
    const generic = cli(dir, "state", ["set", "Construction Verification Command=exit 0"], {
      ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    });
    expect(generic.code).not.toBe(0);
    expect(generic.out).toContain("set-construction-verification-command");
    const supplied = cli(dir, "bolt", ["checkpoint", "--action", "verify", "--unit", "alpha", "--check-cmd", "exit 0"]);
    expect(supplied.code).not.toBe(0);
    expect(supplied.out).toContain("verification-command");
    const setter = cli(dir, "state", ["set-construction-verification-command", "exit 2"]);
    expect(setter.code).not.toBe(0);
    expect(setter.out).toContain("Command SHA-256");
  }, 30_000);

  test("answers require the pending digest and this session's offered choice even under autonomy", () => {
    const dir = project(true);
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--session", "t341-command"];
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    submitCommandChoice(dir, "t341-command", "hello", env);
    const decision = cli(dir, "log", ["decision", ...identity, "--command", "exit 0", "--decision", "Use this command?", "--options", "Approve,Request Changes"], env);
    expect(decision.code, decision.out).toBe(0);
    const mismatch = cli(dir, "log", ["answer", ...identity, "--command", "exit 1", "--details", "Approve"], env);
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.out).toContain("Command SHA-256");
    const absent = cli(dir, "log", ["answer", ...identity, "--command", "exit 0", "--details", "Approve"], env);
    expect(absent.code).not.toBe(0);
    expect(absent.out).toContain("hook-recorded response");
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
    submitCommandChoice(dir, "t341-command", "Approve", env);
    const approved = cli(dir, "log", ["answer", ...identity, "--command", "exit 0", "--details", "Approve"], env);
    expect(approved.code, approved.out).toBe(0);
    const receipts = readAuditShardEvents(dir).filter((row) => row.event === "VERIFICATION_COMMAND_RECORDED");
    expect(receipts).toHaveLength(1);
    expect(auditBlockField(receipts[0].block, "Session")).toBe("t341-command");
    const replay = cli(dir, "log", ["answer", ...identity, "--command", "exit 0", "--details", "Approve"], env);
    expect(replay.code).not.toBe(0);
    expect(readAuditShardEvents(dir).filter((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toHaveLength(1);
    const nextDecision = cli(dir, "log", ["decision", ...identity, "--command", "exit 2", "--decision", "Use another command?", "--options", "Approve,Request Changes"], env);
    expect(nextDecision.code, nextDecision.out).toBe(0);
    expect(cli(dir, "log", ["answer", ...identity, "--command", "exit 2", "--details", "Approve"], env).code).not.toBe(0);
  }, 30_000);

  test("Request Changes cannot be changed into Approve by the conductor", () => {
    const dir = project();
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "exit 0", "--session", "t341-command"];
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    expect(cli(dir, "log", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"], env).code).toBe(0);
    submitCommandChoice(dir, "t341-command", "Request Changes", env);
    const refused = cli(dir, "log", ["answer", ...identity, "--details", "Approve"], env);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("actual offered choice");
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
  }, 30_000);

  test("unrelated prompts and the presence bypass cannot substitute for the offered response", () => {
    const dir = project();
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "exit 0", "--session", "t341-command"];
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    expect(cli(dir, "log", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"], env).code).toBe(0);
    submitCommandChoice(dir, "t341-command", "What does this command do?", env);
    const answer = ["answer", ...identity, "--details", "Approve"];
    expect(cli(dir, "log", answer, env).code).not.toBe(0);
    expect(cli(dir, "log", answer, { ...env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" }).code).not.toBe(0);
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
  }, 30_000);

  test("one session's answer cannot satisfy another session's pending challenge", () => {
    const dir = project();
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "exit 0"];
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    for (const session of ["t341-session-A", "t341-session-B"]) {
      expect(cli(dir, "log", ["decision", ...identity, "--session", session, "--decision", "Use this command?", "--options", "Approve,Request Changes"], env).code).toBe(0);
    }
    submitCommandChoice(dir, "t341-session-A", "Approve", env);
    const answer = ["answer", ...identity, "--session", "t341-session-B", "--details", "Approve"];
    const refused = cli(dir, "log", answer, env);
    expect(refused.code).not.toBe(0);
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
    submitCommandChoice(dir, "t341-session-B", "Approve", env);
    expect(cli(dir, "log", answer, env).code).toBe(0);
  }, 30_000);

  test("re-minting the same command invalidates an earlier hook response, including replayed bytes", () => {
    const dir = project();
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "exit 0", "--session", "t341-command"];
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const decision = ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"];
    const answer = ["answer", ...identity, "--details", "Approve"];
    expect(cli(dir, "log", decision, env).code).toBe(0);
    submitCommandChoice(dir, "t341-command", "Approve", env);
    const previous = readProtectedResponse(dir, "t341-command")!;
    expect(cli(dir, "log", decision, env).code).toBe(0);
    expect(cli(dir, "log", answer, env).code).not.toBe(0);
    writeProtectedResponse(dir, previous);
    expect(cli(dir, "log", answer, env).code).not.toBe(0);
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
    submitCommandChoice(dir, "t341-command", "Approve", env);
    expect(cli(dir, "log", answer, env).code).toBe(0);
  }, 30_000);

  test("decision and answer require the invoking session even with presence bypassed", () => {
    const dir = project();
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "exit 0"];
    const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
    for (const args of [
      ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"],
      ["answer", ...identity, "--details", "Approve"],
    ]) {
      const refused = cli(dir, "log", args, env);
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain("--session");
    }
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
  }, 30_000);

  test("numbered and Recommended-decorated choices retain the Plan Approval matching rules", () => {
    const dir = project();
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "exit 0", "--session", "t341-command"];
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    for (const [prompt, choice, event] of [
      ["1", "Approve", "VERIFICATION_COMMAND_RECORDED"],
      ["2", "Request Changes", "QUESTION_ANSWERED"],
      ["Approve (Recommended)", "Approve", "VERIFICATION_COMMAND_RECORDED"],
    ]) {
      expect(cli(dir, "log", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"], env).code).toBe(0);
      submitCommandChoice(dir, "t341-command", prompt, env);
      const answered = cli(dir, "log", ["answer", ...identity, "--details", choice], env);
      expect(answered.code, answered.out).toBe(0);
      expect(JSON.parse(answered.out).emitted).toBe(event);
    }
  }, 30_000);

  test("Request Changes consumes the question without authorizing a command; other answers refuse", () => {
    const dir = project();
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "exit 0", "--session", "t341-command"];
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const decision = cli(dir, "log", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"], env);
    expect(decision.code, decision.out).toBe(0);
    submitCommandChoice(dir, "t341-command", "Request Changes", env);
    const invalid = cli(dir, "log", ["answer", ...identity, "--details", "CONDUCTOR DEFAULT Approve"], env);
    expect(invalid.code).not.toBe(0);
    const rejected = cli(dir, "log", ["answer", ...identity, "--details", "Request Changes"], env);
    expect(rejected.code, rejected.out).toBe(0);
    expect(rejected.out).toContain("QUESTION_ANSWERED");
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
    const answered = readAuditShardEvents(dir).filter((row) => row.event === "QUESTION_ANSWERED");
    expect(answered).toHaveLength(1);
    expect(auditBlockField(answered[0].block, "User Input")).toBe("Request Changes");
    const configured = setField(readFileSync(seededStateFile(dir), "utf-8"), "Construction Verification Command", "exit 0");
    expect(authorizedVerificationCommand(dir, configured)).toBeNull();
    expect(cli(dir, "log", ["answer", ...identity, "--details", "Request Changes"], env).code).not.toBe(0);
    expect(cli(dir, "log", ["answer", ...identity, "--details", "Approve"], env).code).not.toBe(0);
  }, 30_000);

  test("canonical command bytes survive dollar substitutions without abbreviating the label", () => {
    const dir = project();
    recordCommand(dir, "exit 0");
    const command = 'printf "%s" \'$& $` $1 $$\'; exit 0 # ' + "x".repeat(150);
    recordCommand(dir, `  ${command}  `);
    const authorization = authorizedVerificationCommand(dir, readFileSync(seededStateFile(dir), "utf-8"))!;
    expect(authorization.command).toBe(command);
    expect(authorization.sha256).toBe(createHash("sha256").update(command).digest("hex"));
    expect(authorization.label).toBe(command);
    const verified = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(verified.verified).toBe(true);
    expect(verified.verification!.stdout_sha256).toBe(createHash("sha256").update("$& $` $1 $$").digest("hex"));
    for (const invalid of ["echo a\necho b", "echo\rb", "echo\tb", "echo\u001bb"]) {
      const refused = cli(dir, "state", ["set-construction-verification-command", invalid]);
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain("control characters");
    }
  }, 30_000);

  test("the full 300-character command is displayed before consent and retained in its receipt and proof", () => {
    const dir = project();
    const command = `echo ${"benign".repeat(20)}${" ".repeat(166)}&& exit 0`;
    const sha256 = createHash("sha256").update(command).digest("hex");
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", `  ${command}  `, "--session", "visible-command"];
    const decision = cli(dir, "log", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"]);
    expect(decision.code, decision.out).toBe(0);
    expect(JSON.parse(decision.out)).toMatchObject({ command, command_sha256: sha256 });
    submitCommandChoice(dir, "visible-command", "Approve");
    const answer = cli(dir, "log", ["answer", ...identity, "--details", "Approve"]);
    expect(answer.code, answer.out).toBe(0);
    expect(JSON.parse(answer.out).command_sha256).toBe(sha256);
    const receipt = readAuditShardEvents(dir).find((row) => row.event === "VERIFICATION_COMMAND_RECORDED")!;
    expect(auditBlockField(receipt.block, "Command Label")).toBe(command);
    expect(cli(dir, "state", ["set-construction-verification-command", command]).code).toBe(0);
    const verified = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(verified.verified).toBe(true);
    expect(verified.verification!.command_label).toBe(command);
    expect(verified.verification_command).toBe(command);
    human(dir);
    expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint").approved).toBe(true);
  }, 30_000);

  test("1024-character commands work end to end; oversized legacy state and proofs fail closed", () => {
    const dir = project();
    const command = `echo ${"x".repeat(1019)}`;
    recordCommand(dir, command);
    const verified = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(verified.verified).toBe(true);
    expect(verified.verification!.command_label).toBe(command);
    const oversized = `${command}x`;
    const refused = cli(dir, "log", ["decision", "--stage", "code-generation", "--checkpoint", "verification-command", "--command", oversized,
      "--session", "too-long", "--decision", "Use this command?", "--options", "Approve,Request Changes"]);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("1024");
    const stateContent = readFileSync(seededStateFile(dir), "utf-8");
    const rows = readAuditShardEvents(dir).map((row) => row.event === "VERIFICATION_COMMAND_RECORDED"
      ? { ...row, block: row.block.replace(verified.verification!.command_sha256, createHash("sha256").update(oversized).digest("hex")) }
      : row);
    expect(authorizedVerificationCommand(dir, setField(stateContent, "Construction Verification Command", oversized), rows)).toBeNull();
    writeFileSync(verified.proof_path, JSON.stringify({ ...verified.verification, command_label: oversized }));
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(false);
  }, 30_000);

  test("display-spoofing characters are rejected by command input and persisted proof readers", () => {
    const dir = project();
    const verified = pass(dir);
    for (const character of ["\u200b", "\u202e", "\u2028", "\u2029", "\u00a0"]) {
      for (const command of [`echo${character}safe`, `${character}echo safe${character}`]) {
        expect(() => verificationCommandDetails(command)).toThrow("display-spoofing characters");
      }
      const command = `echo${character}safe`;
      const refused = cli(dir, "log", ["decision", "--stage", "code-generation", "--checkpoint", "verification-command", "--command", command,
        "--session", "spoofed-command", "--decision", "Use this command?", "--options", "Approve,Request Changes"]);
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain("display-spoofing characters");
      writeFileSync(verified.proof_path, JSON.stringify({ ...verified.verification, command_label: command }));
      expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(false);
    }
  }, 30_000);

  test("authorization rejects workflow restarts and ambiguous or superseding receipts, ignoring isolated rows", () => {
    const dir = project();
    recordCommand(dir, "exit 0");
    const content = readFileSync(seededStateFile(dir), "utf-8");
    const rows = readAuditShardEvents(dir);
    const receipt = rows.findLast((row) => row.event === "VERIFICATION_COMMAND_RECORDED")!;
    const different = {
      ...receipt, shard: "later.md", timestamp: "2099-01-01T00:00:00Z",
      block: receipt.block.replace(verificationCommandDetails("exit 0").sha256, verificationCommandDetails("exit 1").sha256),
    };
    expect(authorizedVerificationCommand(dir, content, rows)?.command).toBe("exit 0");
    expect(authorizedVerificationCommand(dir, state(), rows)).toBeNull();
    expect(authorizedVerificationCommand(dir, content, [...rows, different])).toBeNull();
    expect(authorizedVerificationCommand(dir, content, [...rows, {
      ...different, block: `${different.block}\n**Workflow**: single-stage:code-generation\n`,
    }])?.command).toBe("exit 0");
    expect(authorizedVerificationCommand(dir, content, [...rows, {
      ...receipt, shard: "tied.md",
    }])).toBeNull();
    expect(authorizedVerificationCommand(dir, content, [...rows, {
      ...different, event: "WORKFLOW_STARTED", block: "**Event**: WORKFLOW_STARTED\n",
    }])).toBeNull();
  }, 30_000);

  test("public audit append cannot mint a verification-command receipt", () => {
    const dir = project();
    const refused = cli(dir, "audit", ["append", "VERIFICATION_COMMAND_RECORDED", "--field", "Command SHA-256=forged"]);
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("reserved");
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
  });
});

describe("t341 human authority, attempt boundaries, and scoped approval", () => {
  test("skeleton always needs exact Approve and a fresh human, including under autonomy", () => {
    const dir = project(true);
    expect(pass(dir, "skeleton").human_required).toBe(true);
    expect(() => approveConstructionCheckpoint(dir, "alpha", "skeleton")).toThrow("exact");
    expect(() => approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve", "t341-checkpoint")).toThrow();
    expect(approvals(dir)).toEqual([]);
    human(dir, "skeleton");
    expect(() => approveConstructionCheckpoint(dir, "alpha", "skeleton", "approve", "t341-checkpoint")).toThrow("exact");
    const approved = approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve", "t341-checkpoint");
    expect(approved.approved).toBe(true);
    const gate = approvals(dir).at(-1)!;
    for (const [key, value] of Object.entries({
      Unit: "alpha", Stage: "code-generation", Stages: STAGES.join(", "),
      "Gate Scope": "unit-end", Checkpoint: "walking-skeleton",
      Fingerprint: approved.fingerprint, "Run floor": approved.run_floor,
    })) expect(auditBlockField(gate.block, key)).toBe(value);
    pass(dir, "skeleton");
    expect(() => approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve", "t341-checkpoint")).toThrow("--action ask");
    expect(approvals(dir)).toHaveLength(1);
  }, 60_000);

  test("ordinary checkpoints autoapprove only under a recorded autonomous grant", () => {
    const dir = project(true);
    expect(pass(dir).human_required).toBe(false);
    expect(approveConstructionCheckpoint(dir, "alpha", "unit").approved).toBe(true);
    expect(auditBlockField(approvals(dir).at(-1)!.block, "Autonomous")).toBe("true");
    const gated = project();
    pass(gated);
    writeFileSync(seededStateFile(gated), setField(readFileSync(seededStateFile(gated), "utf-8"),
      "Construction Autonomy Mode", "autonomous"));
    expect(() => approveConstructionCheckpoint(gated, "alpha", "unit")).toThrow("exact");
    human(gated);
    expect(approveConstructionCheckpoint(gated, "alpha", "unit", "Approve", "t341-checkpoint").approved).toBe(true);
  }, 60_000);

  test("later unrelated Unit source/artifact changes preserve prior approval", () => {
    const dir = project(true);
    pass(dir);
    const approved = approveConstructionCheckpoint(dir, "alpha", "unit");
    writeFileSync(join(dir, "src", "beta.ts"), "export const beta = 42;\n");
    writeFileSync(artifact(dir, "beta", "functional-design"), "# Beta changed\n");
    const current = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(current.fingerprint).toBe(approved.fingerprint);
    expect(current.verified).toBe(true);
    expect(current.approved).toBe(true);
    writeFileSync(join(dir, "src", "alpha.ts"), "export const alpha = 42;\n");
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").approved).toBe(false);
  }, 60_000);

  test("stage-major skeleton approval survives later stage starts", () => {
    const dir = project(true, "stage-major");
    pass(dir, "skeleton");
    human(dir, "skeleton");
    const approved = approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve", "t341-checkpoint");
    for (const Stage of STAGES) appendAuditEntry("STAGE_STARTED", { Stage }, dir);
    writeFileSync(join(dir, "src", "beta.ts"), "export const beta = 2;\n");
    const current = resolveConstructionCheckpoint(dir, "alpha", "skeleton");
    expect(current.fingerprint).toBe(approved.fingerprint);
    expect(current.approved).toBe(true);
  }, 60_000);

  test("workflow restarts and jumps revoke proof even with identical artifacts", () => {
    for (const event of ["WORKFLOW_STARTED", "STAGE_JUMPED"]) {
      const dir = project(true);
      pass(dir);
      approveConstructionCheckpoint(dir, "alpha", "unit");
      appendAuditEntry(event, { Stage: "functional-design" }, dir);
      const current = resolveConstructionCheckpoint(dir, "alpha", "unit");
      expect(current.verified).toBe(false);
      expect(current.approved).toBe(false);
      expect(current.ready).toBe(false);
      complete(dir, "alpha");
      expect(resolveConstructionCheckpoint(dir, "alpha", "unit").verified).toBe(false);
    }
  }, 60_000);

  test("rejection needs a human even in autonomy and resets only that Unit's stages", () => {
    const dir = project(true);
    pass(dir);
    approveConstructionCheckpoint(dir, "alpha", "unit");
    pass(dir, "unit", "beta");
    approveConstructionCheckpoint(dir, "beta", "unit");
    expect(() => rejectConstructionCheckpoint(dir, "alpha", "unit", "Request Changes", "Fix alpha", "t341-checkpoint")).toThrow();
    expect(readAuditShardEvents(dir).filter((entry) => entry.event === "GATE_REJECTED")).toEqual([]);
    human(dir, "unit", "Request Changes");
    expect(() => rejectConstructionCheckpoint(dir, "alpha", "unit", "Request changes", "Fix alpha", "t341-checkpoint")).toThrow("exact");
    expect(() => rejectConstructionCheckpoint(dir, "alpha", "unit", "Request Changes", " ", "t341-checkpoint")).toThrow("reason");
    const priorFloor = latestMainWorkflowStageRunFloorForProject(dir, STAGES[0], true, "beta");
    const rejected = rejectConstructionCheckpoint(dir, "alpha", "unit", "Request Changes", "Fix alpha", "t341-checkpoint");
    expect(rejected.approved).toBe(false);
    expect(rejected.verified).toBe(false);
    const row = readAuditShardEvents(dir).filter((entry) => entry.event === "GATE_REJECTED").at(-1)!;
    expect(auditBlockField(row.block, "Gate Stages")).toBe(STAGES.join(", "));
    expect(auditBlockField(row.block, "Unit")).toBe("alpha");
    expect(auditBlockField(row.block, "Feedback")).toBe("Fix alpha");
    for (const slug of STAGES) {
      expect(latestMainWorkflowStageRunFloorForProject(dir, slug, true, "alpha")).toStartWith("GATE_REJECTED:");
      expect(latestMainWorkflowStageRunFloorForProject(dir, slug, true, "beta")).toBe(priorFloor);
    }
    expect(resolveConstructionCheckpoint(dir, "beta", "unit").approved).toBe(true);
  }, 60_000);

  test("proof and source manifest paths refuse symlink redirection", () => {
    const dir = project();
    const root = seededRecordDir(dir);
    const destination = join(root, "redirect");
    mkdirSync(destination);
    symlinkSync(destination, join(root, ".aidlc-construction-checkpoints"), process.platform === "win32" ? "junction" : "dir");
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit")).toThrow();
    rmSync(join(root, ".aidlc-construction-checkpoints"));
    const manifest = join(root, "construction", "alpha", "code-generation", "source-manifest.json");
    writeFileSync(join(destination, "manifest.json"), readFileSync(manifest));
    rmSync(manifest);
    symlinkSync(join(destination, "manifest.json"), manifest);
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").ready).toBe(false);
  });
});

describe("t341 review evidence is independent of project check success", () => {
  test("requires current paired reviews and claimed source even under relaxed Change Control", () => {
    const dir = project();
    writeFileSync(seededStateFile(dir), setField(state(), "Review Override", "advisory"));
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").ready).toBe(false);
    for (const slug of STAGES) {
      const definition = findStageBySlug(slug)!;
      if (!definition.reviewer) continue;
      const fields: Record<string, string> = {
        Stage: slug, Unit: "alpha", Reviewer: definition.reviewer, Iteration: "1",
        "Artifact Fingerprint": reviewArtifactFingerprint(dir, definition, "alpha")!,
      };
      if (definition.workspace_requires) {
        const listing = workspaceSourceListing(dir)!;
        const manifest = readUnitSourceManifest(dir, slug, "alpha");
        expect(manifest.ok).toBe(true);
        if (!manifest.ok) throw new Error(manifest.reason);
        fields["Source Fingerprint"] = workspaceSourceFingerprint(dir)!;
        fields["Unit Source Fingerprint"] = writeUnitSourceSnapshot(dir, slug, "alpha",
          listing, manifest, manifest.rawBytesSha256);
      }
      appendAuditEntry("REVIEW_REQUESTED", fields, dir);
      appendAuditEntry("REVIEW_COMPLETED", {
        ...fields, Verdict: "READY",
        ...(fields["Source Fingerprint"] ? { "Request Source Fingerprint": fields["Source Fingerprint"] } : {}),
      }, dir);
    }
    const verified = pass(dir);
    expect(verified.ready).toBe(true);
    human(dir);
    expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve", "t341-checkpoint").approved).toBe(true);
    writeFileSync(join(dir, "src", "beta.ts"), "export const beta = 99;\n");
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").approved).toBe(true);
    writeFileSync(seededStateFile(dir), setField(readFileSync(seededStateFile(dir), "utf-8"),
      "Change Control", "relaxed"));
    writeFileSync(join(dir, "src", "alpha.ts"), "export const alpha = 99;\n");
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit")).toThrow("review");
  }, 60_000);
});

describe("t341 response-bound checkpoint decisions", () => {
  const session = "checkpoint-consent";
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0" };
  const route = (kind = "unit", id = session) => ["checkpoint", "--unit", "alpha", "--kind", kind, "--session", id];

  test("an unverified checkpoint cannot ask or pre-collect consent for a later verification", () => {
    const pd = project();
    recordCommand(pd, "exit 0");
    expect(resolveConstructionCheckpoint(pd, "alpha", "unit")).toMatchObject({ ready: true, verified: false });
    const asked = cli(pd, "bolt", [...route(), "--action", "ask"], env);
    expect(asked.code).not.toBe(0);
    expect(asked.out).toMatch(/verify.*first/i);
    submitCommandChoice(pd, session, "Approve", env);
    expect(verifyConstructionCheckpoint(pd, "alpha", "unit").verified).toBe(true);
    const approve = () => cli(pd, "bolt", [...route(), "--action", "approve", "--user-input", "Approve"], env);
    expect(approve().code).not.toBe(0);
    expect(approvals(pd)).toEqual([]);
    expect(cli(pd, "bolt", [...route(), "--action", "ask"], env).code).toBe(0);
    submitCommandChoice(pd, session, "Approve", env);
    expect(approve().code).toBe(0);
  }, 30_000);

  test("re-verifying identical evidence withdraws every session's question and binds fresh consent to the new proof", () => {
    const pd = project();
    const first = pass(pd);
    for (const id of [session, "another-checkpoint-session"]) {
      expect(cli(pd, "bolt", [...route("unit", id), "--action", "ask"], env).code).toBe(0);
      submitCommandChoice(pd, id, "Approve", env);
    }
    const previous = readProtectedQuestion(pd, session)!;
    const response = readProtectedResponse(pd, session)!;
    const checked = verifyConstructionCheckpoint(pd, "alpha", "unit");
    expect(checked.verified).toBe(true);
    expect(checked.fingerprint).toBe(first.fingerprint);
    expect(checked.verification!.id).not.toBe(first.verification!.id);
    for (const id of [session, "another-checkpoint-session"]) {
      expect(readProtectedQuestion(pd, id)).toBeNull();
      expect(readProtectedResponse(pd, id)).toBeNull();
      submitCommandChoice(pd, id, "Approve", env);
      expect(readProtectedResponse(pd, id)).toBeNull();
      expect(cli(pd, "bolt", [...route("unit", id), "--action", "approve", "--user-input", "Approve"], env).code).not.toBe(0);
    }
    // Restoring the retired mailbox cannot turn the old proof into current consent.
    writeFileSync(join(pd, protectedQuestionRelativePath(pd, session)), JSON.stringify(previous));
    writeProtectedResponse(pd, response);
    expect(cli(pd, "bolt", [...route(), "--action", "approve", "--user-input", "Approve"], env).code).not.toBe(0);
    expect(approvals(pd)).toEqual([]);
    expect(cli(pd, "bolt", [...route(), "--action", "ask"], env).code).toBe(0);
    submitCommandChoice(pd, session, "Approve", env);
    expect(cli(pd, "bolt", [...route(), "--action", "approve", "--user-input", "Approve"], env).code).toBe(0);
  }, 30_000);

  test("a failed re-verification withdraws an unanswered checkpoint before it executes", () => {
    const pd = project();
    pass(pd);
    expect(cli(pd, "bolt", [...route(), "--action", "ask"], env).code).toBe(0);
    writeCheck(pd, "process.exit(1);\n");
    expect(verifyConstructionCheckpoint(pd, "alpha", "unit").verified).toBe(false);
    expect(readProtectedQuestion(pd, session)).toBeNull();
    submitCommandChoice(pd, session, "Approve", env);
    expect(readProtectedResponse(pd, session)).toBeNull();
    expect(cli(pd, "bolt", [...route(), "--action", "ask"], env).code).not.toBe(0);
  }, 30_000);

  test.each(["unit", "skeleton"])("%s refuses unrelated prompts, cross-session choices, and consumed responses", (kind) => {
    const pd = project();
    pass(pd, kind as "unit" | "skeleton");
    submitCommandChoice(pd, session, "hello", env);
    const decide = (id = session) => cli(pd, "bolt", [...route(kind, id), "--action", "approve", "--user-input", "Approve"], env);
    expect(decide().code).not.toBe(0);
    expect(approvals(pd)).toEqual([]);
    const asked = cli(pd, "bolt", [...route(kind), "--action", "ask"], env);
    expect(asked.code, asked.out).toBe(0);
    submitCommandChoice(pd, session, "hello", env);
    expect(decide().code).not.toBe(0);
    submitCommandChoice(pd, "other-session", "Approve", env);
    expect(decide().code).not.toBe(0);
    submitCommandChoice(pd, session, "Approve", env);
    expect(decide("other-session").code).not.toBe(0);
    expect(approvals(pd)).toEqual([]);
    const approved = decide();
    expect(approved.code, approved.out).toBe(0);
    expect(JSON.parse(approved.out).approved).toBe(true);
    expect(readProtectedQuestion(pd, session)).toBeNull();
    expect(readProtectedResponse(pd, session)).toBeNull();
    submitCommandChoice(pd, session, "hello", env);
    expect(decide().code).not.toBe(0);
    expect(approvals(pd)).toHaveLength(1);
  }, 30_000);

  test("re-presentation rotates consent and changed evidence must be presented again", () => {
    const pd = project();
    pass(pd);
    const ask = () => {
      const result = cli(pd, "bolt", [...route(), "--action", "ask"], env);
      expect(result.code, result.out).toBe(0);
    };
    const approve = () => cli(pd, "bolt", [...route(), "--action", "approve", "--user-input", "Approve"], env);
    ask();
    submitCommandChoice(pd, session, "Approve", env);
    const old = readProtectedResponse(pd, session)!;
    ask();
    writeProtectedResponse(pd, old);
    expect(approve().code).not.toBe(0);
    submitCommandChoice(pd, session, "Approve", env);
    writeFileSync(join(pd, "src", "alpha.ts"), "export const alpha = 2;\n");
    complete(pd, "alpha");
    pass(pd);
    const stale = approve();
    expect(stale.code).not.toBe(0);
    expect(stale.out).toContain("--action ask");
    expect(approvals(pd)).toEqual([]);
    ask();
    submitCommandChoice(pd, session, "Approve", env);
    expect(approve().code).toBe(0);
  }, 30_000);

  test("an audit append failure retains the one-shot response for a safe retry", () => {
    const pd = project();
    pass(pd);
    human(pd);
    const shard = readAuditShardEvents(pd)[0].shard;
    const originalOpen = fs.openSync;
    const failedAppend = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
      if (path === shard && typeof flags === "number" && (flags & fs.constants.O_APPEND) !== 0) {
        throw Object.assign(new Error("Audit shard is not writable"), { code: "EACCES" });
      }
      return originalOpen(path, flags, mode);
    });
    try {
      expect(() => approveConstructionCheckpoint(pd, "alpha", "unit", "Approve", "t341-checkpoint")).toThrow("Audit shard is not writable");
    } finally {
      failedAppend.mockRestore();
    }
    expect(approvals(pd)).toEqual([]);
    expect(approveConstructionCheckpoint(pd, "alpha", "unit", "Approve", "t341-checkpoint").approved).toBe(true);
    expect(readProtectedResponse(pd, "t341-checkpoint")).toBeNull();
  }, 30_000);

  test("presence bypass never replaces a response and rejection requires its own choice", () => {
    const pd = project(true);
    pass(pd);
    const bypass = { ...env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
    const reject = () => cli(pd, "bolt", [...route(), "--action", "reject", "--user-input", "Request Changes", "--reason", "Fix alpha"], bypass);
    expect(reject().code).not.toBe(0);
    expect(cli(pd, "bolt", [...route(), "--action", "approve", "--user-input", "Approve"], bypass).code).not.toBe(0);
    const autonomous = cli(pd, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "approve"], env);
    expect(autonomous.code, autonomous.out).toBe(0);
    expect(cli(pd, "bolt", [...route(), "--action", "ask"], env).code).toBe(0);
    submitCommandChoice(pd, session, "Approve", env);
    expect(reject().code).not.toBe(0);
    submitCommandChoice(pd, session, "Request Changes", env);
    expect(reject().code).toBe(0);
    expect(readProtectedResponse(pd, session)).toBeNull();
    expect(readAuditShardEvents(pd).filter((row) => row.event === "GATE_REJECTED")).toHaveLength(1);
  }, 30_000);

  test.each(["verification-first", "policy-first"])("one reply answers only the active protected question: %s", (order) => {
    const pd = project();
    const verification = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "exit 0", "--session", session];
    const policy = ["--stage", "code-generation", "--checkpoint", "construction-policy", "--field", "Construction Iteration", "--value", "stage-major", "--session", session];
    const [first, second] = order === "verification-first" ? [verification, policy] : [policy, verification];
    for (const identity of [first, second]) {
      const asked = cli(pd, "log", ["decision", ...identity, "--decision", "Approve this proposal?", "--options", "Approve,Request Changes"], env);
      expect(asked.code, asked.out).toBe(0);
      if (identity === first) submitCommandChoice(pd, session, "Approve", env);
    }
    const activePolicy = order === "verification-first";
    expect(readProtectedQuestion(pd, session)?.kind).toBe(activePolicy ? "construction-policy" : "verification-command");
    expect(readProtectedResponse(pd, session)).toBeNull();
    submitCommandChoice(pd, session, "Approve", env);
    expect(readProtectedResponse(pd, session)?.choice).toBe("Approve");
    const answer = (identity: string[]) => cli(pd, "log", ["answer", ...identity, "--details", "Approve"], env);
    // Try the retired question both before and after consuming the active one.
    expect(answer(first).code).not.toBe(0);
    const accepted = answer(second);
    expect(accepted.code, accepted.out).toBe(0);
    expect(answer(first).code).not.toBe(0);
    const receipts = readAuditShardEvents(pd).filter((row) => ["VERIFICATION_COMMAND_RECORDED", "CONSTRUCTION_POLICY_RECORDED"].includes(row.event));
    expect(receipts.map((row) => row.event)).toEqual([activePolicy ? "CONSTRUCTION_POLICY_RECORDED" : "VERIFICATION_COMMAND_RECORDED"]);
    expect(humanActedSinceGate(pd)).toBe(false);
  }, 30_000);
});

describe("t341 protected question interleaving", () => {
  const session = "protected-interleaving";
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0" };
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "bun test", "--session", session];
  const prompt = "Use this exact verification command?";
  const ask = (pd: string) => {
    const result = cli(pd, "log", ["decision", ...identity, "--decision", prompt, "--options", "Approve,Request Changes"], env);
    expect(result.code, result.out).toBe(0);
    return JSON.parse(result.out) as { challengeFile: string; challengeId: string };
  };
  const answer = (pd: string) => cli(pd, "log", ["answer", ...identity, "--details", "Approve"], env);
  const receipts = (pd: string) => readAuditShardEvents(pd).filter((row) => row.event === "VERIFICATION_COMMAND_RECORDED");

  test.each(["same-session", "unknown-session", "lifecycle-gate"])("%s withdraws the pending question before an unrelated Approve", (interleaving) => {
    const pd = project();
    if (interleaving === "lifecycle-gate") {
      writeFileSync(seededStateFile(pd), readFileSync(seededStateFile(pd), "utf-8").replace(
        "## Stage Progress", "## Stage Progress\n### INCEPTION PHASE\n- [-] delivery-planning — EXECUTE",
      ));
    }
    ask(pd);
    // An unrelated session's consent is retained only when the new question has
    // a known owner. A gate or unresolved owner retires every session's mailbox.
    const other = mintProtectedQuestion(pd, { kind: "verification-command", session: "other", target: { commandSha256: "a".repeat(64) } });
    submitCommandChoice(pd, "other", "Approve", env);
    if (interleaving === "lifecycle-gate") {
      const gate = cli(pd, "state", ["gate-start", "delivery-planning"], {
        ...env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1", AIDLC_SKIP_REVIEWER_GATE_GUARD: "1",
      });
      expect(gate.code, gate.out).toBe(0);
      expect(readAuditShardEvents(pd).some((row) => row.event === "STAGE_AWAITING_APPROVAL" && auditBlockField(row.block, "Stage") === "delivery-planning")).toBe(true);
    } else {
      if (interleaving === "unknown-session") expect(resolveSessionIdFromAncestry(pd)).toBeNull();
      const unrelated = cli(pd, "log", ["decision", "--stage", "code-generation", "--decision", "Approve the unrelated naming proposal?",
        ...(interleaving === "same-session" ? ["--session", session] : [])], env);
      expect(unrelated.code, unrelated.out).toBe(0);
    }
    expect(readProtectedQuestion(pd, session)).toBeNull();
    expect(readProtectedQuestion(pd, "other")?.challengeId ?? null).toBe(interleaving === "same-session" ? other.challengeId : null);
    expect(readProtectedResponse(pd, "other")?.choice ?? null).toBe(interleaving === "same-session" ? "Approve" : null);
    submitCommandChoice(pd, session, "Approve", env);
    expect(readProtectedResponse(pd, session)).toBeNull();
    const refused = answer(pd);
    expect(refused.code, refused.out).not.toBe(0);
    expect(refused.out).toContain("verification-command");
    expect(receipts(pd)).toEqual([]);
    ask(pd);
    submitCommandChoice(pd, session, "Approve", env);
    const accepted = answer(pd);
    expect(accepted.code, accepted.out).toBe(0);
    expect(receipts(pd)).toHaveLength(1);
  }, 30_000);

  test("rendered question text binds picker replies; absent text falls back to the exclusive question", () => {
    const pd = project();
    const submit = (toolInput?: unknown) => {
      const result = childProcess.spawnSync(process.execPath, [join(AIDLC_SRC, "hooks/aidlc-record-human-turn.ts")], {
        cwd: pd, encoding: "utf-8", env: { ...env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: session,
          tool_input: toolInput, tool_response: { answers: { choice: "Approve" } } }),
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    };
    const decision = ask(pd);
    expect(decision.challengeFile).toBe(protectedQuestionRelativePath(pd, session));
    expect(decision.challengeId).toMatch(/^[a-f0-9]{32}$/);
    for (const input of [
      { questions: [{ question: "Approve the unrelated proposal?" }] },
      { question: `${prompt} ` },
      { questions: [{ question: "Unrelated?" }, { question: prompt }] },
    ]) {
      submit(input);
      expect(readProtectedResponse(pd, session)).toBeNull();
      expect(answer(pd).code).not.toBe(0);
    }
    expect(receipts(pd)).toEqual([]);
    for (const input of [{ questions: [{ question: prompt }] }, { question: prompt }, undefined]) {
      ask(pd);
      submit(input);
      expect(readProtectedResponse(pd, session)?.choice).toBe("Approve");
      const accepted = answer(pd);
      expect(accepted.code, accepted.out).toBe(0);
    }
    expect(receipts(pd)).toHaveLength(3);
  }, 30_000);

  test("Codex retains rendered question text when forwarding a structured selection", () => {
    const pd = project();
    const adapter = join(AIDLC_SRC, "../../codex/.codex/hooks/aidlc-codex-adapter.ts");
    ask(pd);
    for (const question of ["An unrelated question?", prompt]) {
      const submitted = childProcess.spawnSync(process.execPath, [adapter, "record-human-turn"], {
        cwd: pd, encoding: "utf-8", env: { ...env, AIDLC_PROJECT_DIR: pd, CLAUDE_PROJECT_DIR: pd },
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "request_user_input", session_id: session,
          tool_input: { questions: [{ id: "choice", question, options: [{ label: "Approve" }, { label: "Request Changes" }] }] },
          tool_response: JSON.stringify({ answers: { choice: { answers: ["Approve"] } } }) }),
      });
      expect(submitted.status, `${submitted.stdout}${submitted.stderr}`).toBe(0);
      if (question !== prompt) {
        expect(readProtectedResponse(pd, session)).toBeNull();
        expect(answer(pd).code).not.toBe(0);
        expect(receipts(pd)).toEqual([]);
      }
    }
    const accepted = answer(pd);
    expect(accepted.code, accepted.out).toBe(0);
    expect(receipts(pd)).toHaveLength(1);
  }, 30_000);

  test("Plan Approval and protected questions replace each other's challenge and response; conflicts record neither", () => {
    const pd = project();
    const plan: PlanApprovalRuntimeChallenge = {
      version: 1, session, challengeId: "plan-challenge", targetId: "stage:code-generation", intentId: "intent",
      runFloor: "floor", fingerprint: "sha256:plan", questionsFile: "questions.md", promptSha256: "sha256:prompt",
      directiveEpoch: "epoch", sourceFloor: "source", markerRevision: 1, plannedSourceSha256: "sha256:source",
      options: ["Approve Plan", "Request Changes"], requireExactOptionLabels: true, hashedOptionLabels: false,
    };
    writePlanApprovalChallenge(pd, plan);
    writePlanApprovalResponse(pd, { version: 1, session, challengeId: plan.challengeId, choice: "Approve Plan", responseSha256: "a".repeat(64) });
    ask(pd);
    expect(readPlanApprovalChallenge(pd, session)).toBeNull();
    expect(readPlanApprovalResponse(pd, session)).toBeNull();
    submitCommandChoice(pd, session, "Approve", env);
    expect(readProtectedResponse(pd, session)?.choice).toBe("Approve");
    writePlanApprovalChallenge(pd, plan);
    expect(readProtectedQuestion(pd, session)).toBeNull();
    expect(readProtectedResponse(pd, session)).toBeNull();
    submitCommandChoice(pd, session, "Approve Plan", env);
    expect(readPlanApprovalResponse(pd, session)?.choice).toBe("Approve Plan");
    // Ordinary decisions deliberately do not withdraw mature Plan Approval.
    const ordinary = cli(pd, "log", ["decision", "--stage", "code-generation", "--decision", "Another question?", "--session", session], env);
    expect(ordinary.code, ordinary.out).toBe(0);
    expect(readPlanApprovalChallenge(pd, session)?.challengeId).toBe(plan.challengeId);
    ask(pd);
    writeFileSync(join(pd, planApprovalChallengeRelativePath(pd, session)), JSON.stringify(plan));
    submitCommandChoice(pd, session, "Approve", env);
    expect(readPlanApprovalChallenge(pd, session)).toBeNull();
    expect(readPlanApprovalResponse(pd, session)).toBeNull();
    expect(readProtectedQuestion(pd, session)).toBeNull();
    expect(readProtectedResponse(pd, session)).toBeNull();
    expect(answer(pd).code).not.toBe(0);
    expect(receipts(pd)).toEqual([]);
  }, 30_000);

  test("target digests canonicalize nested keys but bind content and ordered members", () => {
    const pd = project();
    const target = { units: ["alpha", "beta"], commandSha256s: { beta: "b", alpha: "a" } };
    mintProtectedQuestion(pd, { kind: "checkpoint-approval", session, target });
    submitCommandChoice(pd, session, "Approve", env);
    const reordered = { commandSha256s: { alpha: "a", beta: "b" }, units: ["alpha", "beta"] };
    expect(protectedTargetDigest(reordered)).toBe(protectedTargetDigest(target));
    for (const changed of [{ ...target, units: ["beta", "alpha"] }, { ...target, commandSha256s: { alpha: "changed", beta: "b" } }]) {
      expect(() => requireProtectedResponse(pd, session, {
        kind: "checkpoint-approval", targetDigest: protectedTargetDigest(changed), choice: "Approve",
      })).toThrow("--action ask");
    }
  }, 30_000);
});
