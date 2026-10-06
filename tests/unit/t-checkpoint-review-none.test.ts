// covers: function:approvedUnitChanges, function:approveConstructionCheckpoint, function:verifyConstructionCheckpoint
// covers: subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, audit:CHANGE_ACCEPTED
//
// With reviews off (Review Override none), an approved Unit's work changed
// later (another Unit's build, claimed or not, a hand edit, a revert) keeps
// the approval under Guard Policy relaxed or off: the run goes on to the next
// Unit and the change is recorded once and said in one line at the next step
// that records changes. Strict, and a team memory layer that locks strict,
// still ask again. An approval row written before the change keeps today's
// behaviour.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { acceptedReviewChanges } from "../../dist/claude/.claude/tools/aidlc-review-brief.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});
const stages = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const ALPHA_LINE = "src/alpha.ts changed after you approved Unit alpha; carrying on.";
const ALPHA_NO_PATHS_LINE = "Unit alpha's files changed after you approved it; carrying on.";
// The state file's separator between a stage slug and its action.
const SEPARATOR = "\u2014";

// Classic, two Units, reviews off, checkpoints on, the given Guard Policy line.
function fixture(policy: string) {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Construction checkpoints with reviews off
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
- **Review Override**: none
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

function manifest(p: string, unit: string, paths: string[]) {
  const output = join(seededRecordDir(p), "construction", unit, "code-generation");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
    stage: "code-generation", unit, version: 1, writes: paths.map((path) => ({ path })),
  }));
}

function complete(p: string, unit: string, slug: string) {
  appendAuditEntry("UNIT_COMPLETED", {
    Stage: slug, Unit: unit, Mode: "wave",
    "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
    "Artifact Fingerprint": reviewArtifactFingerprint(p, findStageBySlug(slug)!, unit, { requireRequiredArtifacts: true })!,
  }, p);
}

// A Unit's stage outputs; `during` runs before Code Generation completes, as
// the Unit's own build would.
function build(p: string, unit: string, during?: () => void, claims = [`src/${unit}.ts`]) {
  for (const slug of stages) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) {
      writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
    }
    if (stage.workspace_requires) manifest(p, unit, claims);
    if (slug === "code-generation") during?.();
    complete(p, unit, slug);
  }
}

function next(p: string) {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p);
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as { stage: string; unit?: string; construction_checkpoint?: { unit: string } };
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
  writeFileSync(script, "const fs=require('node:fs'); for(const unit of ['alpha','beta']) if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit))process.exit(1);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "t-review-none-command"];
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  const decision = tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], env);
  expect(decision.status, decision.out).toBe(0);
  human(p, "Approve", "t-review-none-command");
  for (const [name, args] of [["log", ["answer", ...identity, "--details", "Approve"]], ["state", ["set-construction-verification-command", command]]] as const) {
    const result = tool(p, name, [...args], env);
    expect(result.status, result.out).toBe(0);
  }
}

function verify(p: string, unit: string) {
  recordCommand(p);
  const verified = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", "verify"]);
  expect(verified.status, verified.out).toBe(0);
  const result = JSON.parse(verified.stdout);
  expect(result.errors).toEqual([]);
  expect(result.verified).toBe(true);
  return result as { change_notices?: string[] };
}

function approve(p: string, unit: string) {
  verify(p, unit);
  const session = `t-review-none-${unit}`;
  const asked = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", "ask", "--session", session]);
  expect(asked.status, asked.out).toBe(0);
  human(p, "Approve", session);
  const answered = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", "approve", "--session", session, "--user-input", "Approve"]);
  expect(answered.status, answered.out).toBe(0);
  expect(JSON.parse(answered.stdout).approved).toBe(true);
}

function approved(p: string, unit: string): boolean {
  const status = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", "status"]);
  expect(status.status, status.out).toBe(0);
  return JSON.parse(status.stdout).approved;
}

function acceptedFor(p: string, unit: string) {
  return readAuditShardEvents(p).filter((row) =>
    row.event === "CHANGE_ACCEPTED" && auditBlockField(row.block, "Unit") === unit);
}

// What alpha's approval recorded for its Code Generation stage.
function approvedEvidence(p: string, unit = "alpha") {
  const gate = readAuditShardEvents(p).filter((row) =>
    row.event === "GATE_APPROVED" && auditBlockField(row.block, "Unit") === unit).at(-1);
  expect(gate).toBeDefined();
  const field = auditBlockField(gate!.block, "Approved Evidence");
  expect(field, "the approval records what it saw").not.toBeNull();
  return JSON.parse(field!) as Record<string, [string, string | null, Record<string, string>?]>;
}

const ALPHA = (p: string) => join(p, "src", "alpha.ts");
type Change = "claimed" | "unclaimed" | "hand" | "revert";

// alpha built (its file at version 2 for a later revert) and approved; then
// the change, made where a person makes it; then beta built.
function changedAfterApproval(policy: string, change: Change) {
  const p = fixture(policy);
  build(p, "alpha", () => writeFileSync(ALPHA(p), "export const alpha = 2;\n"));
  approve(p, "alpha");
  if (change === "hand") writeFileSync(ALPHA(p), "export const alpha = 2; // tidied by hand\n");
  if (change === "revert") writeFileSync(ALPHA(p), "export const alpha = 1;\n");
  build(p, "beta", () => {
    if (change === "claimed" || change === "unclaimed") writeFileSync(ALPHA(p), "export const alpha = 3;\n");
  }, change === "claimed" ? ["src/beta.ts", "src/alpha.ts"] : ["src/beta.ts"]);
  return p;
}

describe("t-checkpoint-review-none: reviews off, an approved Unit changed later", () => {
  for (const policy of ["off (from scope classic)", "relaxed (set by you)"]) {
    for (const change of ["claimed", "unclaimed", "hand", "revert"] as const) {
      test(`Guard Policy ${policy.split(" ")[0]}, ${change} change: the approval stands and the change is said once`, () => {
        const p = changedAfterApproval(policy, change);
        const beat = next(p);
        expect(beat.construction_checkpoint?.unit, JSON.stringify(beat)).toBe("beta");
        expect(approved(p, "alpha")).toBe(true);
        expect(acceptedFor(p, "alpha")).toHaveLength(0);
        // beta's checkpoint is the next step that records changes: alpha's
        // line is said there, before the person is asked about beta.
        expect(verify(p, "beta").change_notices).toEqual([ALPHA_LINE]);
        approve(p, "beta");
        const rows = acceptedFor(p, "alpha");
        expect(rows).toHaveLength(1);
        expect(auditBlockField(rows[0].block, "Checkpoint")).toBe("construction-unit");
        expect(auditBlockField(rows[0].block, "Stage")).toBe("code-generation");
        expect(auditBlockField(rows[0].block, "Changed")).toBe("src/alpha.ts");
        expect(auditBlockField(rows[0].block, "Details")).toBe(ALPHA_LINE);
        // Not reviewed content: the review brief does not list it.
        expect(acceptedReviewChanges(p, "code-generation")).toEqual([]);
        expect(approved(p, "alpha")).toBe(true);
        expect(readAuditShardEvents(p).filter((row) =>
          row.event === "DECISION_RECORDED" && auditBlockField(row.block, "Unit") === "alpha")).toHaveLength(1);
        // alpha's approval kept its one claimed path and its entry.
        expect(Object.keys(approvedEvidence(p)["code-generation"][2] ?? {})).toEqual(["\u0000src/alpha.ts"]);
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }
  }

  test("a Unit claiming more files than the approval keeps is named, not its files", () => {
    const p = fixture("off (from scope classic)");
    const many = Array.from({ length: 50 }, (_, index) => `src/alpha/part${index}.ts`);
    mkdirSync(join(p, "src", "alpha"), { recursive: true });
    for (const path of many) writeFileSync(join(p, path), "export {};\n");
    build(p, "alpha", undefined, ["src/alpha.ts", ...many]);
    approve(p, "alpha");
    expect(approvedEvidence(p)["code-generation"]).toHaveLength(2);
    writeFileSync(ALPHA(p), "export const alpha = 2;\n");
    build(p, "beta");
    expect(next(p).construction_checkpoint?.unit).toBe("beta");
    expect(verify(p, "beta").change_notices).toEqual([ALPHA_NO_PATHS_LINE]);
    const rows = acceptedFor(p, "alpha");
    expect(rows).toHaveLength(1);
    expect(auditBlockField(rows[0].block, "Changed")).toBe("(paths unavailable)");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a change after the last Unit's checkpoint is said once at the stage's own check", () => {
    const p = fixture("off (from scope classic)");
    build(p, "alpha");
    approve(p, "alpha");
    build(p, "beta");
    approve(p, "beta");
    writeFileSync(ALPHA(p), "export const alpha = 2;\n");
    // The stage's own check runs with the artifact guard on, as in a real run.
    const env = { ...process.env };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    for (const result of ["awaiting-approval", "approved"]) {
      const report = tool(p, "orchestrate", ["report", "--stage", "functional-design", "--result", result], env);
      expect(report.status, report.out).toBe(0);
      if (result === "awaiting-approval") expect(report.out).toContain(ALPHA_LINE);
    }
    expect(acceptedFor(p, "alpha")).toHaveLength(1);
    expect(approved(p, "alpha")).toBe(true);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Guard Policy strict: the changed Unit is asked about again, as before", () => {
    const p = changedAfterApproval("strict (set by you)", "hand");
    const beat = next(p);
    expect(beat.construction_checkpoint?.unit, JSON.stringify(beat)).toBe("alpha");
    expect(approved(p, "alpha")).toBe(false);
    expect(acceptedFor(p, "alpha")).toHaveLength(0);
    // The approval recorded what it saw; strict does not use it.
    expect(approvedEvidence(p)["code-generation"]).toHaveLength(3);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("a team memory layer that locks strict asks again under a state line of off", () => {
    const p = fixture("off (from scope classic)");
    const team = join(p, "aidlc", "spaces", "default", "memory", "team.md");
    const shipped = readFileSync(team, "utf-8");
    const locked = shipped.replace(/^## Guard Policy\r?$/m, "## Guard Policy\n\nMode: strict");
    expect(locked).not.toBe(shipped);
    writeFileSync(team, locked);
    build(p, "alpha");
    approve(p, "alpha");
    expect(approvedEvidence(p)["code-generation"]).toHaveLength(3);
    writeFileSync(ALPHA(p), "export const alpha = 2;\n");
    build(p, "beta");
    expect(next(p).construction_checkpoint?.unit).toBe("alpha");
    expect(approved(p, "alpha")).toBe(false);
    expect(acceptedFor(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("an approval recorded before this change keeps its fingerprint and asks again", () => {
    const p = fixture("off (from scope classic)");
    build(p, "alpha");
    approve(p, "alpha");
    // The row as an earlier release wrote it: no Approved Evidence.
    const audit = join(seededRecordDir(p), "audit");
    let removed = 0;
    for (const name of readdirSync(audit)) {
      const path = join(audit, name);
      const text = readFileSync(path, "utf-8");
      const older = text.replace(/^\*\*Approved Evidence\*\*: .*\n/m, "");
      if (older !== text) removed++;
      writeFileSync(path, older);
    }
    expect(removed).toBe(1);
    const gate = readAuditShardEvents(p).filter((row) => row.event === "GATE_APPROVED").at(-1)!;
    const status = JSON.parse(tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "status"]).stdout);
    expect(status.approved).toBe(true);
    expect(status.fingerprint).toBe(auditBlockField(gate.block, "Fingerprint"));
    writeFileSync(ALPHA(p), "export const alpha = 2;\n");
    build(p, "beta");
    expect(next(p).construction_checkpoint?.unit).toBe("alpha");
    expect(approved(p, "alpha")).toBe(false);
    expect(acceptedFor(p, "alpha")).toHaveLength(0);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Asked "Approve Unit alpha?", the person fixes a typo in its functional
  // design and says "approve". Under relaxed and off their approval lands on
  // the Unit they were shown and the change is said once; under strict they are
  // asked about it as it is now.
  for (const policy of ["off (from scope classic)", "relaxed (set by you)", "strict (set by you)"]) {
    test(`Guard Policy ${policy.split(" ")[0]}: a document edited between the question and the approval`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      verify(p, "alpha");
      const session = "t-review-none-asked";
      const asked = tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "ask", "--session", session]);
      expect(asked.status, asked.out).toBe(0);
      const doc = join(seededRecordDir(p), "construction", "alpha", "functional-design",
        artifactFilename(findStageBySlug("functional-design")!.produces![0]));
      writeFileSync(doc, `${readFileSync(doc, "utf-8")}\nFixed a typo.\n`);
      human(p, "approve", session);
      const answered = tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "approve", "--session", session, "--user-input", "Approve"]);
      if (policy.startsWith("strict")) {
        expect(answered.status).not.toBe(0);
        expect(approved(p, "alpha")).toBe(false);
        return;
      }
      expect(answered.status, answered.out).toBe(0);
      expect(JSON.parse(answered.stdout)).toMatchObject({
        approved: true, change_notices: ["Unit alpha's files changed after you were asked about it; carrying on."],
      });
      expect(next(p)).toMatchObject({ stage: "functional-design", unit: "beta" });
      expect(approved(p, "alpha")).toBe(true);
      // Said once: the next Unit's checkpoint does not say it again.
      build(p, "beta");
      expect(verify(p, "beta").change_notices ?? []).toEqual([]);
      expect(acceptedFor(p, "alpha")).toHaveLength(1);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
