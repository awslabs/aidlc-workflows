// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-bolt:checkpoint
// covers: function:leftOutNotice, function:leftOutLine
//
// The person asks to leave planned work out of a build ("skip the remaining
// stories") and the approval read like any finished build (#1342). The agent
// lists each item left out as `Deferred` in the Unit's traceability.json, with
// the person's words as the reason; the approval then says once what was left
// out. The approval stays theirs: nothing is refused and nothing is asked again.

import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});
const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const LEFT_OUT = "Left out of this build: AC2.1.1, AC2.1.2 and AC2.2.1.";

// The t342 fixture: one solo intent in Construction, Units alpha and beta.
function fixture(options: { checkpoints?: boolean; current?: string; team?: boolean; sensorsOff?: boolean } = {}) {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const current = options.current ?? "functional-design";
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Left-out work
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
${options.sensorsOff ? "- **Sensors**: off (set by you)\n" : ""}- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
${options.team ? "- **Unit Ownership**: team\n- **Unit Gate Rhythm**: per-stage\n" : ""}${options.checkpoints === false ? "" : `- **Construction Checkpoints**: enabled
- **Construction Execution**: serial`}
- **Construction Autonomy Mode**: gated
- **Review Override**: none
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${STAGES.map((stage) => stage === current ? `- [-] ${stage} \u2014 EXECUTE`
    : options.team ? `- [S] ${stage} \u2014 SKIP` : `- [ ] ${stage} \u2014 EXECUTE`).join("\n")}
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  return p;
}

type Coverage = { id: string; status: string; target?: string }[];
const BUILT: Coverage = [{ id: "AC1.1.1", status: "OK", target: "src/alpha.ts" }];
const SKIPPED: Coverage = [
  ...BUILT,
  { id: "AC2.1.1", status: "Deferred", target: "the person: skip the remaining stories" },
  { id: "AC2.1.2", status: "Deferred", target: "the person: skip the remaining stories" },
  { id: "AC2.2.1", status: "Deferred", target: "the person: skip the remaining stories" },
];

// Each stage's outputs for a Unit, with its completion receipt; Code
// Generation's traceability.json holds `coverage`.
function cover(p: string, unit: string, coverage: Coverage) {
  for (const slug of STAGES) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) {
      const body = slug === "code-generation" && name === "traceability"
        ? JSON.stringify({ stage: slug, unit, upstream_ids: coverage.map((entry) => entry.id), coverage }, null, 2)
        : `# ${unit} ${name}\n`;
      writeFileSync(join(output, artifactFilename(name)), body);
    }
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
        stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
      }));
    }
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
      "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true })!,
    }, p);
  }
}

function tool(p: string, name: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

function next(p: string) {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, []);
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as { construction_checkpoint?: { unit: string; ready?: boolean }; narration?: string };
}

function humanTurn(p: string, session: string, prompt: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

// The person's recorded check for every Unit, as the checkpoint asks for it.
function recordCommand(p: string) {
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "process.exit(0);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "left-out"];
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], env);
  humanTurn(p, "left-out", "Approve");
  tool(p, "log", ["answer", ...identity, "--details", "Approve"], env);
  tool(p, "state", ["set-construction-verification-command", command], env);
}

// The Unit checkpoint as the person meets it: verified, then the question
// asked. What `ask` returns is the last thing before the question.
function checkpointQuestion(p: string) {
  recordCommand(p);
  expect(next(p).construction_checkpoint?.unit).toBe("alpha");
  const verified = tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "verify"]);
  expect(verified.verified, JSON.stringify(verified)).toBe(true);
  const asked = tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "ask", "--session", "left-out"]);
  return { verified, asked };
}

describe("t-approval-says-what-was-left-out", () => {
  test("a Unit's approval says which items the person left out of its build, once, just before the question", () => {
    const p = fixture();
    cover(p, "alpha", SKIPPED);
    const { verified, asked } = checkpointQuestion(p);
    expect(asked.left_out, JSON.stringify(asked)).toBe(LEFT_OUT);
    expect(JSON.stringify(verified)).not.toContain("Left out");
    humanTurn(p, "left-out", "Approve");
    const approved = tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "approve", "--session", "left-out", "--user-input", "Approve"]);
    expect(approved.approved, JSON.stringify(approved)).toBe(true);
  });

  test("control: a Unit built in full says nothing about left-out work", () => {
    const p = fixture();
    cover(p, "alpha", BUILT);
    expect(JSON.stringify(checkpointQuestion(p))).not.toContain("Left out");
  });

  test("the stage's approval says what was left out of every Unit's build", () => {
    const p = fixture({ checkpoints: false, current: "code-generation" });
    cover(p, "alpha", SKIPPED);
    cover(p, "beta", BUILT);
    const env = { ...process.env };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const gate = tool(p, "orchestrate", ["report", "--stage", "code-generation", "--result", "awaiting-approval"], env);
    expect(String(gate.narration ?? ""), JSON.stringify(gate)).toContain(LEFT_OUT);
  });

  test("control: the stage's approval with every item built says nothing about left-out work", () => {
    const p = fixture({ checkpoints: false, current: "code-generation" });
    cover(p, "alpha", BUILT);
    cover(p, "beta", BUILT);
    const env = { ...process.env };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const gate = tool(p, "orchestrate", ["report", "--stage", "code-generation", "--result", "awaiting-approval"], env);
    expect(String(gate.narration ?? ""), JSON.stringify(gate)).not.toContain("Left out");
    expect(readFileSync(seededStateFile(p), "utf-8")).toContain("code-generation");
  });

  test("more than ten items left out: the first ten, then how many more", () => {
    const p = fixture({ checkpoints: false, current: "code-generation" });
    const many = Array.from({ length: 13 }, (_, i) => ({ id: `AC3.1.${i + 1}`, status: "Deferred", target: "skip story 3" }));
    cover(p, "alpha", [...BUILT, ...many]);
    cover(p, "beta", BUILT);
    const env = { ...process.env };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const gate = tool(p, "orchestrate", ["report", "--stage", "code-generation", "--result", "awaiting-approval"], env);
    expect(String(gate.narration ?? ""), JSON.stringify(gate)).toContain(
      `Left out of this build: ${many.slice(0, 10).map((entry) => entry.id).join(", ")} and 3 more.`,
    );
  });

  test("with Sensors off, the approval still says what was left out: it is the record, not a check", () => {
    const p = fixture({ checkpoints: false, current: "code-generation", sensorsOff: true });
    cover(p, "alpha", SKIPPED);
    cover(p, "beta", BUILT);
    const env = { ...process.env };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const gate = tool(p, "orchestrate", ["report", "--stage", "code-generation", "--result", "awaiting-approval"], env);
    const narration = String(gate.narration ?? "");
    expect(narration, JSON.stringify(gate)).toContain(LEFT_OUT);
    expect(narration).not.toContain("check reports");
  });

  // A team approves Unit by Unit; once every Unit is approved the stage
  // settles without another question, and nothing says alpha's items again.
  test("a team's Unit gate names that Unit's left-out items only, and the stage after it does not repeat them", () => {
    const p = fixture({ checkpoints: false, current: "code-generation", team: true });
    cover(p, "alpha", SKIPPED);
    cover(p, "beta", BUILT);
    const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
    const report = (unit: string, result: string, extra: string[] = []) =>
      tool(p, "orchestrate", ["report", "--stage", "code-generation", "--unit", unit, "--result", result, ...extra], env);
    const alpha = report("alpha", "awaiting-approval");
    expect(String(alpha.narration ?? ""), JSON.stringify(alpha)).toContain(LEFT_OUT);
    const beta = report("beta", "awaiting-approval");
    expect(String(beta.narration ?? ""), JSON.stringify(beta)).not.toContain("Left out");
    const after = [report("alpha", "approved", ["--user-input", "Approve"]), report("beta", "approved", ["--user-input", "Approve"])];
    const following = next(p) as Record<string, unknown>;
    expect(following.stage, JSON.stringify(following).slice(0, 400)).toBe("build-and-test");
    for (const step of [...after, following]) expect(JSON.stringify(step)).not.toContain("Left out");
  });

  test("control: a design stage's Deferred item (handled by a later stage) is not said as left out", () => {
    const p = fixture({ checkpoints: false, current: "code-generation" });
    cover(p, "alpha", BUILT);
    cover(p, "beta", BUILT);
    const design = join(seededRecordDir(p), "construction", "alpha", "functional-design", "traceability.json");
    writeFileSync(design, JSON.stringify({
      stage: "functional-design", unit: "alpha", upstream_ids: ["AC1.1.1"],
      coverage: [{ id: "AC1.1.1", status: "Deferred", target: "nfr-design" }],
    }));
    const env = { ...process.env };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const gate = tool(p, "orchestrate", ["report", "--stage", "code-generation", "--result", "awaiting-approval"], env);
    expect(String(gate.narration ?? ""), JSON.stringify(gate)).not.toContain("Left out");
  });
});
