// covers: function:checkpointPolicyEnabled, function:resolveConstructionCheckpoint,
// function:verifyConstructionCheckpoint, function:approveConstructionCheckpoint,
// function:rejectConstructionCheckpoint, audit:GATE_APPROVED, audit:GATE_REJECTED
// covers: function:authorizedVerificationCommand, function:verificationCommandDetails, audit:VERIFICATION_COMMAND_RECORDED, subcommand:aidlc-state:set-construction-verification-command

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

function human(project: string): void {
  appendAuditEntry("HUMAN_TURN", { Source: "t341 fixture prompt-submit" }, project);
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

function recordCommand(project: string, command: string): void {
  if (authorizedVerificationCommand(project, readFileSync(seededStateFile(project), "utf-8"))?.command === command) return;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command];
  for (const args of [
    ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"],
    ["answer", ...identity, "--details", "Approve"],
  ]) {
    const result = cli(project, "log", args, { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
    expect(result.code, result.out).toBe(0);
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
    human(dir);
    expect(approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve").approved).toBe(true);
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
    const approved = approveConstructionCheckpoint(dir, "alpha", "unit", "Approve");
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

  test("runs the authorized command and persists its digest and label, not raw command or output", () => {
    const dir = project();
    const verified = pass(dir);
    const rawProof = readFileSync(verified.proof_path, "utf-8");
    const proof = JSON.parse(rawProof);
    const output = "integrated check passed\n";
    expect(proof.version).toBe(3);
    expect(proof).not.toHaveProperty("command");
    expect(proof.command_sha256).toBe(authorizedVerificationCommand(dir, readFileSync(seededStateFile(dir), "utf-8"))!.sha256);
    expect(proof.command_label).toBe(verified.verification_command);
    expect(proof.exit_code).toBe(0);
    expect(verified.verification!.stdout_sha256).toBe(createHash("sha256").update(output).digest("hex"));
    expect(verified.verification!.stdout_bytes).toBe(Buffer.byteLength(output));
    expect(verified.verification!.stderr_bytes).toBe(0);
    expect(verified.verification!.stderr_sha256).toBe(createHash("sha256").update("").digest("hex"));
    expect(rawProof).not.toContain(output.trim());
    expect(JSON.stringify(verified)).not.toContain(output.trim());
    expect(verified.proof_path).toStartWith(join(seededRecordDir(dir), ".aidlc-construction-checkpoints"));
    human(dir);
    expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve").approved).toBe(true);
    const marker = `SECRET_MARKER_${randomUUID()}`;
    recordCommand(dir, writeCheck(dir, `console.log('${marker}'); console.error('${marker}'); process.exit(7);\n`));
    const failed = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(failed.verified).toBe(false);
    expect(failed.approved).toBe(false);
    expect(failed.verification!.exit_code).toBe(7);
    expect(failed.verification!.stderr_bytes).toBeGreaterThan(0);
    expect(failed.verification!.stdout_sha256).toBe(createHash("sha256").update(`${marker}\n`).digest("hex"));
    expect(failed.verification!.stderr_sha256).toBe(failed.verification!.stdout_sha256);
    expect(JSON.stringify(failed)).not.toContain(marker);
    expect(readFileSync(failed.proof_path, "utf-8")).not.toContain(marker);
    expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve")).toThrow("Verify");
    for (const cmd of ["", " \n\t", "a".repeat(8193), "echo\0bad"]) {
      expect(() => verificationCommandDetails(cmd)).toThrow("nonblank");
    }
  }, 60_000);

  test.each([1, 2])("legacy v%i proofs revoke verification and prior approval without throwing", (version) => {
    const dir = project();
    const verified = pass(dir);
    human(dir);
    expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve").approved).toBe(true);
    const proof = {
      ...verified.verification!, version, command: "exit 0",
    };
    writeFileSync(verified.proof_path, JSON.stringify(proof));
    const current = resolveConstructionCheckpoint(dir, "alpha", "unit");
    expect(current.ready).toBe(true);
    expect(current.verified).toBe(false);
    expect(current.approved).toBe(false);
    expect(current.verification).toBeNull();
  }, 30_000);

  test("output summaries bind captured bytes without lossy UTF-8 decoding", () => {
    const dir = project();
    const stdout = Buffer.from([0x61, 0xc3, 0xa9, 0xff, 0x00, 0x0a]);
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
      expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve").approved).toBe(true);
      recordCommand(dir, "set -o pipefail; false | true");
      const failed = verifyConstructionCheckpoint(dir, "alpha", "unit");
      expect(failed.verification!.exit_code).toBe(1);
      expect(failed.verification!.evidence_unchanged).toBe(true);
      expect(failed.verified).toBe(false);
      expect(failed.approved).toBe(false);
      expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve")).toThrow("Verify");
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

describe("t341 verification command consent", () => {
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

  test("answers require the pending command digest and a fresh unused human turn even under autonomy", () => {
    const dir = project(true);
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command"];
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    human(dir);
    const decision = cli(dir, "log", ["decision", ...identity, "--command", "exit 0", "--decision", "Use this command?", "--options", "Approve,Request Changes"], env);
    expect(decision.code, decision.out).toBe(0);
    const mismatch = cli(dir, "log", ["answer", ...identity, "--command", "exit 1", "--details", "Approve"], env);
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.out).toContain("Command SHA-256");
    const absent = cli(dir, "log", ["answer", ...identity, "--command", "exit 0", "--details", "Approve"], env);
    expect(absent.code).not.toBe(0);
    expect(absent.out).toContain("HUMAN_TURN");
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
    const submitted = childProcess.spawnSync(process.execPath, [join(AIDLC_SRC, "hooks/aidlc-record-human-turn.ts")], {
      encoding: "utf-8", cwd: dir,
      env: { ...env, AIDLC_PROJECT_DIR: dir, CLAUDE_PROJECT_DIR: dir },
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "t341-command", prompt: "Approve" }),
    });
    expect(submitted.status, `${submitted.stdout}${submitted.stderr}`).toBe(0);
    const approved = cli(dir, "log", ["answer", ...identity, "--command", "exit 0", "--details", "Approve"], env);
    expect(approved.code, approved.out).toBe(0);
    const replay = cli(dir, "log", ["answer", ...identity, "--command", "exit 0", "--details", "Approve"], env);
    expect(replay.code).not.toBe(0);
    const nextDecision = cli(dir, "log", ["decision", ...identity, "--command", "exit 2", "--decision", "Use another command?", "--options", "Approve,Request Changes"], env);
    expect(nextDecision.code, nextDecision.out).toBe(0);
    expect(cli(dir, "log", ["answer", ...identity, "--command", "exit 2", "--details", "Approve"], env).code).not.toBe(0);
  }, 30_000);

  test("Request Changes consumes the question without authorizing a command; other answers refuse", () => {
    const dir = project();
    const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "exit 0"];
    const decision = cli(dir, "log", ["decision", ...identity, "--decision", "Use this command?", "--options", "Approve,Request Changes"]);
    expect(decision.code, decision.out).toBe(0);
    const invalid = cli(dir, "log", ["answer", ...identity, "--details", "CONDUCTOR DEFAULT Approve"]);
    expect(invalid.code).not.toBe(0);
    const rejected = cli(dir, "log", ["answer", ...identity, "--details", "Request Changes"]);
    expect(rejected.code, rejected.out).toBe(0);
    expect(rejected.out).toContain("QUESTION_ANSWERED");
    expect(readAuditShardEvents(dir).some((row) => row.event === "VERIFICATION_COMMAND_RECORDED")).toBe(false);
    expect(cli(dir, "log", ["answer", ...identity, "--details", "Approve"]).code).not.toBe(0);
  }, 30_000);

  test("canonical command bytes survive dollar substitutions and long labels are bounded", () => {
    const dir = project();
    recordCommand(dir, "exit 0");
    const command = 'printf "%s" \'$& $` $1 $$\'; exit 0 # ' + "x".repeat(150);
    recordCommand(dir, `  ${command}  `);
    const authorization = authorizedVerificationCommand(dir, readFileSync(seededStateFile(dir), "utf-8"))!;
    expect(authorization.command).toBe(command);
    expect(authorization.sha256).toBe(createHash("sha256").update(command).digest("hex"));
    expect(authorization.label).toBe(command.slice(0, 120));
    const verified = verifyConstructionCheckpoint(dir, "alpha", "unit");
    expect(verified.verified).toBe(true);
    expect(verified.verification!.stdout_sha256).toBe(createHash("sha256").update("$& $` $1 $$").digest("hex"));
    for (const invalid of ["echo a\necho b", "echo\rb", "echo\tb", "echo\u001bb"]) {
      const refused = cli(dir, "state", ["set-construction-verification-command", invalid]);
      expect(refused.code).not.toBe(0);
      expect(refused.out).toContain("control characters");
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
    expect(() => approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve")).toThrow("human");
    human(dir);
    expect(() => approveConstructionCheckpoint(dir, "alpha", "skeleton", "approve")).toThrow("exact");
    const approved = approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve");
    expect(approved.approved).toBe(true);
    const gate = approvals(dir).at(-1)!;
    for (const [key, value] of Object.entries({
      Unit: "alpha", Stage: "code-generation", Stages: STAGES.join(", "),
      "Gate Scope": "unit-end", Checkpoint: "walking-skeleton",
      Fingerprint: approved.fingerprint, "Run floor": approved.run_floor,
    })) expect(auditBlockField(gate.block, key)).toBe(value);
    pass(dir, "skeleton");
    expect(approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve").approved).toBe(true);
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
    expect(approveConstructionCheckpoint(gated, "alpha", "unit", "Approve").approved).toBe(true);
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
    human(dir);
    const approved = approveConstructionCheckpoint(dir, "alpha", "skeleton", "Approve");
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
    expect(() => rejectConstructionCheckpoint(dir, "alpha", "unit", "Request Changes", "Fix alpha")).toThrow("human");
    human(dir);
    expect(() => rejectConstructionCheckpoint(dir, "alpha", "unit", "Request changes", "Fix alpha")).toThrow("exact");
    expect(() => rejectConstructionCheckpoint(dir, "alpha", "unit", "Request Changes", " ")).toThrow("reason");
    const priorFloor = latestMainWorkflowStageRunFloorForProject(dir, STAGES[0], true, "beta");
    const rejected = rejectConstructionCheckpoint(dir, "alpha", "unit", "Request Changes", "Fix alpha");
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
    expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve").approved).toBe(true);
    writeFileSync(join(dir, "src", "beta.ts"), "export const beta = 99;\n");
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").approved).toBe(true);
    writeFileSync(seededStateFile(dir), setField(readFileSync(seededStateFile(dir), "utf-8"),
      "Change Control", "relaxed"));
    writeFileSync(join(dir, "src", "alpha.ts"), "export const alpha = 99;\n");
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit")).toThrow("review");
  }, 60_000);
});
