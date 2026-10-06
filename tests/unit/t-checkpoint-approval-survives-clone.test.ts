// covers: subcommand:aidlc-bolt:checkpoint
//
// A Unit approved at its checkpoint, then looked at on a checkout that has no
// checkpoint proof file (a fresh clone or another machine: the proof folder is
// not committed). The committed approval and verification rows stand in for
// the proof when the Unit's evidence is unchanged, under every Guard Policy, so
// the person is not asked to approve the Unit again and nothing is run again.
// A Unit whose evidence changed since, or a proof file that is there but does
// not read, is handled as it is today.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});
const stages = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const REVIEWER = findStageBySlug("code-generation")!.reviewer!;
// The state file's separator between a stage slug and its action.
const SEPARATOR = "\u2014";
const POLICIES = ["strict (set by you)", "relaxed (set by you)", "off (from scope classic)"];

// Classic, two Units, advisory reviews (one pass per stage), checkpoints on,
// Unit by Unit.
function fixture(policy: string) {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Construction checkpoint approval on a fresh clone
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: classic
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Review Override**: advisory
- **Guard Policy**: ${policy}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${stages.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} ${SEPARATOR} EXECUTE`).join("\n")}
- [ ] build-and-test ${SEPARATOR} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) {
    writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  }
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "classic" }, p);
  return p;
}

function tool(p: string, name: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [
    join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p,
  ], { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env });
  return { status: result.status, stdout: result.stdout, out: `${result.stdout}${result.stderr}` };
}

function human(p: string, prompt: string, session: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function recordCommand(p: string) {
  if (readFileSync(seededStateFile(p), "utf-8").includes("- **Construction Verification Command**:")) return;
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "process.exit(0);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "t-clone-command"];
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  const decision = tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], env);
  expect(decision.status, decision.out).toBe(0);
  human(p, "Approve", "t-clone-command");
  for (const [name, args] of [["log", ["answer", ...identity, "--details", "Approve"]], ["state", ["set-construction-verification-command", command]]] as const) {
    const result = tool(p, name, [...args], env);
    expect(result.status, result.out).toBe(0);
  }
}

// Verify, ask and approve a Unit at its checkpoint.
function approve(p: string, unit: string): void {
  recordCommand(p);
  const checkpoint = (args: string[]) => {
    const result = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", ...args]);
    expect(result.status, result.out).toBe(0);
    return JSON.parse(result.stdout);
  };
  const verified = checkpoint(["--action", "verify"]);
  expect(verified.errors).toEqual([]);
  expect(verified.verified).toBe(true);
  const session = `t-clone-${unit}`;
  checkpoint(["--action", "ask", "--session", session]);
  human(p, "Approve", session);
  expect(checkpoint(["--action", "approve", "--session", session, "--user-input", "Approve"]).approved).toBe(true);
}

type Status = { approved: boolean; errors: string[]; rereview?: { stage: string; command: string } | null };

function checkpointStatus(p: string, unit: string): Status {
  const status = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", "status"]);
  expect(status.status, status.out).toBe(0);
  return JSON.parse(status.stdout) as Status;
}

// One review through the logger, as a real run records it: the request, the
// reviewer's file in the slot it names, then the verdict. Returns the file.
function reviewThroughLog(p: string, args: string[]): string {
  const requested = tool(p, "log", args);
  expect(requested.status, requested.out).toBe(0);
  const request = JSON.parse(requested.stdout.trim().split(/\r?\n/).at(-1)!) as { reviewFile: string };
  const iteration = args[args.indexOf("--iteration") + 1];
  mkdirSync(dirname(join(p, request.reviewFile)), { recursive: true });
  writeFileSync(join(p, request.reviewFile), `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n` +
    `**Iteration:** ${iteration}\n\n### Findings\n\nNo blocking findings.\n`);
  const recorded = tool(p, "log", [...args, "--verdict", "READY"]);
  expect(recorded.status, recorded.out).toBe(0);
  return join(p, request.reviewFile);
}

// A Unit built as a run records it: each stage's outputs, its review through
// the logger, then its completion. Returns the written review files.
function build(p: string, unit: string): string[] {
  const reviews: string[] = [];
  for (const slug of stages) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) {
      writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
    }
    if (stage.workspace_requires) writeManifest(p, unit, [`src/${unit}.ts`]);
    reviews.push(reviewThroughLog(p, [
      "review", "--stage", slug, "--reviewer", stage.reviewer!, "--unit", unit, "--iteration", "1",
    ]));
    const floor = latestMainWorkflowStageRunFloorForProject(p, slug, true, unit);
    appendAuditEntry("UNIT_COMPLETED", stage.workspace_requires ? { Stage: slug, Unit: unit, "Run floor": floor } : {
      Stage: slug, Unit: unit, Mode: "wave", "Run floor": floor,
      "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true })!,
    }, p);
  }
  return reviews;
}

function writeManifest(p: string, unit: string, paths: string[]): void {
  writeFileSync(join(seededRecordDir(p), "construction", unit, "code-generation", "source-manifest.json"), JSON.stringify({
    stage: "code-generation", unit, version: 1, writes: paths.map((path) => ({ path })),
  }));
}

const DOCUMENT_STAGE = "nfr-requirements";

function proofDir(p: string): string {
  return join(seededRecordDir(p), ".aidlc-construction-checkpoints");
}

function verificationRuns(p: string): number {
  return readAuditShardEvents(p).filter((row) => row.event === "CHECKPOINT_VERIFICATION_RECORDED").length;
}

describe("t-checkpoint-approval-survives-clone: no checkpoint proof file on this checkout", () => {
  for (const policy of POLICIES) {
    test(`Guard Policy ${policy.split(" ")[0]}: an approved Unit with unchanged evidence stays approved`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      approve(p, "alpha");
      const runs = verificationRuns(p);
      rmSync(proofDir(p), { recursive: true, force: true });
      const status = checkpointStatus(p, "alpha");
      expect(status, JSON.stringify(status)).toMatchObject({ approved: true, errors: [] });
      // Nothing was run again, and no approval was asked for or recorded again.
      expect(verificationRuns(p)).toBe(runs);
      expect(readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED")).toEqual([]);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("Guard Policy strict: evidence changed after the clone does not stand in for the proof", () => {
    const p = fixture("strict (set by you)");
    build(p, "alpha");
    approve(p, "alpha");
    rmSync(proofDir(p), { recursive: true, force: true });
    const document = join(seededRecordDir(p), "construction", "alpha", DOCUMENT_STAGE,
      artifactFilename(findStageBySlug(DOCUMENT_STAGE)!.produces![0]));
    writeFileSync(document, `${readFileSync(document, "utf-8")}\nTests use a temporary notes file.\n`);
    const status = checkpointStatus(p, "alpha");
    expect(status.approved, JSON.stringify(status)).toBe(false);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  for (const policy of ["strict (set by you)", "off (from scope classic)"]) {
    test(`Guard Policy ${policy.split(" ")[0]}: a proof file that is there but does not read still fails`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      approve(p, "alpha");
      const proof = join(proofDir(p), "alpha", "unit.json");
      mkdirSync(join(proofDir(p), "alpha"), { recursive: true });
      writeFileSync(proof, "{}\n");
      const status = checkpointStatus(p, "alpha");
      expect(status.approved, JSON.stringify(status)).toBe(false);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
