// covers: function:checkpointPolicyEnabled, function:resolveConstructionCheckpoint,
// function:verifyConstructionCheckpoint, function:approveConstructionCheckpoint,
// function:rejectConstructionCheckpoint, audit:GATE_APPROVED, audit:GATE_REJECTED

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  approveConstructionCheckpoint,
  checkpointPolicyEnabled,
  rejectConstructionCheckpoint,
  resolveConstructionCheckpoint,
  verifyConstructionCheckpoint,
} from "../../dist/claude/.claude/tools/aidlc-construction-checkpoints.ts";
import {
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

function pass(project: string, kind: "unit" | "skeleton" = "unit", unit = "alpha") {
  const command = writeCheck(project,
    "const fs = require('node:fs');\n" +
    "if (!fs.readFileSync('src/alpha.ts', 'utf8').includes('alpha')) process.exit(3);\n" +
    "console.log('integrated check passed');\n");
  const result = verifyConstructionCheckpoint(project, unit, kind, command);
  expect(result.errors).toEqual([]);
  expect(result.verified).toBe(true);
  return result;
}

function approvals(project: string) {
  return readAuditShardEvents(project).filter((row) => row.event === "GATE_APPROVED");
}

describe("t341 Construction checkpoint verification and evidence", () => {
  test("refreshing unchanged completion evidence or rerunning the same check preserves approval", () => {
    const dir = project();
    const checked = pass(dir);
    human(dir);
    const approved = approveConstructionCheckpoint(dir, "alpha", "unit", "Approve");
    complete(dir, "alpha");
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").approved).toBe(true);
    const repeated = verifyConstructionCheckpoint(dir, "alpha", "unit", checked.verification!.command);
    expect(repeated.fingerprint).toBe(approved.fingerprint);
    expect(repeated.approved).toBe(true);
    const differentCheck = verifyConstructionCheckpoint(dir, "alpha", "unit", "exit 0");
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
      expect(() => verifyConstructionCheckpoint(dir, unit, "unit", "exit 0")).toThrow();
    }
    writeFileSync(seededStateFile(dir), state().replace("- **Construction Checkpoints**: enabled\n", ""));
    expect(resolveConstructionCheckpoint(dir, "alpha", "unit").enabled).toBe(false);
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit", "exit 0")).toThrow("not ready");
  });

  test("runs the explicit command in the project and persists pass/failure output", () => {
    const dir = project();
    const verified = pass(dir);
    const proof = JSON.parse(readFileSync(verified.proof_path, "utf-8"));
    expect(proof.command).toBe(verified.verification!.command);
    expect(proof.exit_code).toBe(0);
    expect(proof.stdout).toContain("integrated check passed");
    expect(verified.proof_path).toStartWith(join(seededRecordDir(dir), ".aidlc-construction-checkpoints"));
    human(dir);
    expect(approveConstructionCheckpoint(dir, "alpha", "unit", "Approve").approved).toBe(true);
    const failed = verifyConstructionCheckpoint(dir, "alpha", "unit",
      writeCheck(dir, "console.error('project check failed'); process.exit(7);\n"));
    expect(failed.verified).toBe(false);
    expect(failed.approved).toBe(false);
    expect(failed.verification!.exit_code).toBe(7);
    expect(failed.verification!.stderr).toContain("project check failed");
    expect(() => approveConstructionCheckpoint(dir, "alpha", "unit", "Approve")).toThrow("Verify");
    for (const cmd of ["", " \n\t", "a".repeat(8193), "echo\0bad"]) {
      expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit", cmd)).toThrow("explicit");
    }
  }, 60_000);

  test("an edit during an otherwise passing check cannot mint a verification", () => {
    const dir = project();
    const command = writeCheck(dir,
      "require('node:fs').appendFileSync('src/alpha.ts', '// changed during verification\\n');\n");
    const result = verifyConstructionCheckpoint(dir, "alpha", "unit", command);
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
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit", "exit 0")).toThrow("completion");
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
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit", "exit 0")).toThrow("not ready");
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
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit", "exit 0")).toThrow();
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
    expect(() => verifyConstructionCheckpoint(dir, "alpha", "unit", "exit 0")).toThrow("review");
  }, 60_000);
});
