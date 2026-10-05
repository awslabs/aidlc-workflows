// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-log:review
//
// Re-checks an approved Unit's checkpoint routes when its reviewed work
// changed, under Guard Policy strict. A re-check of a document stage
// dispatches that stage's own reviewer inputs. Two changed stages are
// re-checked one at a time, in stage order, and the checkpoint then opens.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});
const stages = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const REVIEWER = findStageBySlug("code-generation")!.reviewer!;
const DOCUMENT_STAGE = "nfr-requirements";
// The state file's separator between a stage slug and its action.
const SEPARATOR = "\u2014";

// Classic, two Units, advisory reviews (one pass per stage), checkpoints on.
function fixture(policy: string) {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Construction checkpoint re-checks
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

type Beat = {
  stage: string; unit?: string; gate?: boolean; reviewer?: string; review_artifact?: string;
  stage_file?: string; consumes?: string[]; produces?: string[]; protocol_modules?: string[];
  construction_checkpoint?: {
    unit: string; ready?: boolean;
    rereview?: { stage: string; iteration: number; command: string };
    rechecked?: { verdict: string; approved_before: boolean; changed: string };
  };
};

function next(p: string): Beat {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p);
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as Beat;
}

function recordCommand(p: string) {
  if (readFileSync(seededStateFile(p), "utf-8").includes("- **Construction Verification Command**:")) return;
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "const fs=require('node:fs'); for(const unit of ['alpha','beta']) if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit))process.exit(1);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "t-recheck-command"];
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  const decision = tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], env);
  expect(decision.status, decision.out).toBe(0);
  human(p, "Approve", "t-recheck-command");
  for (const [name, args] of [["log", ["answer", ...identity, "--details", "Approve"]], ["state", ["set-construction-verification-command", command]]] as const) {
    const result = tool(p, name, [...args], env);
    expect(result.status, result.out).toBe(0);
  }
}

function approve(p: string, unit: string) {
  recordCommand(p);
  const checkpoint = (args: string[]) => {
    const result = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", ...args]);
    expect(result.status, result.out).toBe(0);
    return JSON.parse(result.stdout);
  };
  const verified = checkpoint(["--action", "verify"]);
  expect(verified.errors).toEqual([]);
  expect(verified.verified).toBe(true);
  const session = `t-recheck-${unit}`;
  checkpoint(["--action", "ask", "--session", session]);
  human(p, "Approve", session);
  expect(checkpoint(["--action", "approve", "--session", session, "--user-input", "Approve"]).approved).toBe(true);
}

// One review through the logger, as a real run records it: the request, the
// reviewer's file in the slot it names, then the verdict.
function reviewThroughLog(p: string, args: string[]) {
  const requested = tool(p, "log", args);
  expect(requested.status, requested.out).toBe(0);
  const request = JSON.parse(requested.stdout.trim().split(/\r?\n/).at(-1)!) as { recovery?: string; reviewFile: string };
  const iteration = args[args.indexOf("--iteration") + 1];
  mkdirSync(dirname(join(p, request.reviewFile)), { recursive: true });
  writeFileSync(join(p, request.reviewFile), `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n` +
    `**Iteration:** ${iteration}\n\n### Findings\n\nNo blocking findings.\n`);
  const recorded = tool(p, "log", [...args, "--verdict", "READY"]);
  expect(recorded.status, recorded.out).toBe(0);
  return request;
}

function review(stage: string, unit: string, iteration: number): string[] {
  return ["review", "--stage", stage, "--reviewer", findStageBySlug(stage)!.reviewer!, "--unit", unit, "--iteration", String(iteration)];
}

// A Unit built as a run records it: each stage's outputs, its review through
// the logger, then its completion, as a solo run records it.
function buildReviewed(p: string, unit: string) {
  for (const slug of stages) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) {
      writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
    }
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
        stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
      }));
    }
    reviewThroughLog(p, review(slug, unit, 1));
    const floor = latestMainWorkflowStageRunFloorForProject(p, slug, true, unit);
    appendAuditEntry("UNIT_COMPLETED", { Stage: slug, Unit: unit, "Run floor": floor }, p);
  }
}

// An edit to alpha's first NFR Requirements document, as the write hook records it.
function editAlphaDocument(p: string) {
  const document = join(seededRecordDir(p), "construction", "alpha", DOCUMENT_STAGE,
    artifactFilename(findStageBySlug(DOCUMENT_STAGE)!.produces![0]));
  writeFileSync(document, `${readFileSync(document, "utf-8")}\nTests use a temporary notes file.\n`);
  appendAuditEntry("ARTIFACT_UPDATED", {
    File: relative(p, document).replaceAll("\\", "/"), Stage: DOCUMENT_STAGE, Unit: "alpha",
  }, p);
}

function rejected(p: string) {
  return readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED");
}

describe("t-checkpoint-recheck-routing: re-checks of an approved Unit's changed work", () => {
  test("a document re-check dispatches that stage's own file, inputs, outputs and review artifact", () => {
    const p = fixture("strict (set by you)");
    buildReviewed(p, "alpha");
    approve(p, "alpha");
    editAlphaDocument(p);
    const beat = next(p);
    expect(beat.construction_checkpoint?.rereview?.stage, JSON.stringify(beat)).toBe(DOCUMENT_STAGE);
    // The checkpoint keeps its identity.
    expect(beat).toMatchObject({ stage: "code-generation", unit: "alpha", gate: true });
    expect(beat.construction_checkpoint?.unit).toBe("alpha");
    // The reviewer gets the document stage's own work.
    const own = findStageBySlug(DOCUMENT_STAGE)!;
    expect(beat.reviewer).toBe(own.reviewer);
    expect(beat.review_artifact).toBe(own.review_artifact);
    expect(beat.stage_file).toContain(`${DOCUMENT_STAGE}.md`);
    expect(beat.produces?.length).toBeGreaterThan(0);
    for (const path of beat.produces ?? []) expect(path).toContain(`/alpha/${DOCUMENT_STAGE}/`);
    for (const path of beat.consumes ?? []) expect(path).not.toContain("/alpha/nfr-design/");
    expect(beat.protocol_modules).toEqual(["reviewer", "construction"]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  test("Guard Policy strict: code and a document both changed are re-checked one at a time, then asked about once", () => {
    const p = fixture("strict (set by you)");
    buildReviewed(p, "alpha");
    approve(p, "alpha");
    writeFileSync(join(p, "src", "alpha.ts"), "export const alpha = 2;\n");
    editAlphaDocument(p);
    for (const stage of [DOCUMENT_STAGE, "code-generation"]) {
      const beat = next(p);
      expect(beat.construction_checkpoint?.unit, JSON.stringify(beat)).toBe("alpha");
      expect(beat.construction_checkpoint?.rereview?.stage, JSON.stringify(beat)).toBe(stage);
      expect(reviewThroughLog(p, review(stage, "alpha", 2)).recovery).toBe("stale-receipt");
    }
    const asked = next(p);
    expect(asked.construction_checkpoint, JSON.stringify(asked)).toMatchObject({
      unit: "alpha", ready: true, rechecked: { verdict: "READY", approved_before: true },
    });
    approve(p, "alpha");
    expect(next(p)).toMatchObject({ stage: "functional-design", unit: "beta" });
    expect(rejected(p)).toEqual([]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});
