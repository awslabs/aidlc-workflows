// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-state:set-construction-checkpoints, subcommand:aidlc-state:set-construction-execution, function:isAutonomousConstructionGate, function:isConstructionSwarmEnabled
// covers: function:constructionCheckpointGaps
// covers: subcommand:aidlc-state:set, subcommand:aidlc-state:set-construction-iteration
// covers: audit:CONSTRUCTION_POLICY_RECORDED, function:authorizedConstructionPolicyChange, function:recordProtectedHumanResponse
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  reviewArtifactFingerprint, authorizedConstructionPolicyChange, auditBlockField, readAuditShardEvents, setField,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});
const stages = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
type Options = {
  iteration?: "unit-major" | "stage-major";
  stance?: "on" | "off";
  execution?: "serial" | "swarm";
  autonomy?: "unset" | "gated" | "autonomous";
  legacy?: boolean;
  current?: string;
};

function fixture(options: Options = {}) {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  const current = options.current ?? "functional-design";
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Construction checkpoint routing
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: ${options.stance ?? "off"}
- **Construction Iteration**: ${options.iteration ?? "unit-major"}
${options.legacy ? "" : `- **Construction Checkpoints**: enabled
- **Construction Execution**: ${options.execution ?? "serial"}`}
- **Construction Autonomy Mode**: ${options.autonomy ?? "gated"}
- **Review Override**: none
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${stages.map((stage) => `- [${stage === current ? "-" : " "}] ${stage} — EXECUTE`).join("\n")}
- [ ] build-and-test — EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) {
    writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  }
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  if (options.autonomy === "autonomous") {
    appendAuditEntry("AUTONOMY_MODE_SET", { Mode: "autonomous" }, p);
  }
  return p;
}

function cover(p: string, unit: string, selected = stages, receipts = true) {
  for (const slug of selected) {
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
    if (receipts) {
      const fingerprint = reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true });
      expect(fingerprint).not.toBeNull();
      appendAuditEntry("UNIT_COMPLETED", {
        Stage: slug, Unit: unit, Mode: "wave",
        "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
        "Artifact Fingerprint": fingerprint!,
      }, p);
    }
  }
}

function next(p: string) {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p);
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as {
    kind: string; stage: string; unit?: string; gate?: boolean; batch?: number;
    construction_checkpoint?: { kind: string; unit: string; human_required: boolean; verification_command: string | null; command_authorized: boolean };
    construction_policy?: { offer_autonomy: boolean; completion_only: boolean; human_completion_required: boolean };
  };
}

function recordCommand(p: string): string {
  const script = join(seededRecordDir(p), "check.cjs");
  if (readFileSync(seededStateFile(p), "utf-8").includes("- **Construction Verification Command**:")) {
    return readFileSync(seededStateFile(p), "utf-8").match(/^- \*\*Construction Verification Command\*\*: (.+)$/m)![1];
  }
  writeFileSync(script, "const fs=require('node:fs'); for(const unit of ['alpha','beta']) if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit))process.exit(1);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "t342-command"];
  for (const [tool, args] of [
    ["log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]],
    ["log", ["answer", ...identity, "--details", "Approve"]],
    ["state", ["set-construction-verification-command", command]],
  ] as const) {
    const result = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${tool}.ts`), ...args, "--project-dir", p], {
      encoding: "utf-8", env: { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" },
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    if (args[0] === "decision") {
      const human = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
        encoding: "utf-8", cwd: p,
        env: { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p },
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "t342-command", prompt: "Approve" }),
      });
      expect(human.status, `${human.stdout}${human.stderr}`).toBe(0);
    }
  }
  return command;
}

function approve(p: string, unit: string, kind: "unit" | "skeleton" = "unit") {
  recordCommand(p);
  const invoke = (args: string[]) => {
    const result = spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-bolt.ts"), "checkpoint", "--unit", unit,
      "--kind", kind, ...args, "--project-dir", p,
    ], { encoding: "utf-8" });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout);
  };
  const checked = invoke(["--action", "verify"]);
  expect(checked.errors).toEqual([]);
  expect(checked.verified).toBe(true);
  invoke(["--action", "ask", "--session", "t342-checkpoint"]);
  policyHuman(p, "Approve", "t342-checkpoint");
  expect(invoke(["--action", "approve", "--session", "t342-checkpoint", "--user-input", "Approve"]).approved).toBe(true);
}

function policyCli(p: string, tool: string, args: string[]) {
  const env = { ...process.env };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  return spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${tool}.ts`), ...args, "--project-dir", p], {
    encoding: "utf-8", env,
  });
}

function policyHuman(p: string, prompt: string, session = "t342-policy") {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    encoding: "utf-8", cwd: p, env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

function policyChoice(p: string, action: "decision" | "answer", field: string, value: string, session = "t342-policy", choice = "Approve") {
  return policyCli(p, "log", [
    action, "--stage", "functional-design", "--checkpoint", "construction-policy",
    "--field", field, "--value", value, "--session", session,
    ...(action === "decision" ? ["--decision", `Change ${field} to ${value}?`, "--options", "Approve,Request Changes"] : ["--details", choice]),
  ]);
}

function recordPolicy(p: string, field: string, value: string) {
  const decision = policyChoice(p, "decision", field, value);
  expect(decision.status, `${decision.stdout}${decision.stderr}`).toBe(0);
  policyHuman(p, "Approve");
  const answer = policyChoice(p, "answer", field, value);
  expect(answer.status, `${answer.stdout}${answer.stderr}`).toBe(0);
}

describe("t342 Construction checkpoint routing", () => {
  test("a stage-major skeleton builds the first Unit through the next design stage", () => {
    const p = fixture({ stance: "on", iteration: "stage-major" });
    cover(p, "alpha", ["functional-design"]);
    const directive = next(p);
    expect(directive.kind).toBe("run-stage");
    expect(directive.stage).toBe("nfr-requirements");
    expect(directive.unit).toBe("alpha");
    expect(directive.construction_policy?.human_completion_required).toBe(false);
  });

  test("skeleton-off stage-major keeps the selected stage order", () => {
    const p = fixture({ iteration: "stage-major" });
    cover(p, "alpha", ["functional-design"]);
    const directive = next(p);
    expect(directive.stage).toBe("functional-design");
    expect(directive.unit).toBe("beta");
  });

  test("stage-major resumes its chosen order after the working skeleton is approved", () => {
    const p = fixture({ stance: "on", iteration: "stage-major" });
    // Declaration order can differ from dependency order: alpha is the actual
    // first buildable Unit even though beta was listed first.
    seedBoltDag(p, [{ name: "beta", depends_on: ["alpha"] }, "alpha"], [["alpha"], ["beta"]]);
    cover(p, "alpha");
    expect(next(p).construction_checkpoint?.kind).toBe("skeleton");
    approve(p, "alpha", "skeleton");
    const following = next(p);
    expect(following.stage).toBe("functional-design");
    expect(following.unit).toBe("beta");
    expect(following.construction_checkpoint).toBeUndefined();
  }, 30_000);

  test("unit-major reviews alpha before starting beta", () => {
    const p = fixture();
    cover(p, "alpha");
    const directive = next(p);
    expect(directive.construction_checkpoint?.unit, JSON.stringify(directive)).toBe("alpha");
    expect(directive.construction_checkpoint?.human_required).toBe(true);
    expect(directive.construction_checkpoint?.command_authorized).toBe(false);
    expect(directive.construction_checkpoint?.verification_command).toBeNull();
    const command = recordCommand(p);
    const recorded = next(p).construction_checkpoint;
    expect(recorded?.command_authorized).toBe(true);
    expect(recorded?.verification_command).toBe(command);
    approve(p, "alpha");
    const following = next(p);
    expect(following.unit).toBe("beta");
    expect(following.stage).toBe("functional-design");
  }, 30_000);

  test("reused artifacts get lifecycle receipts before the Unit checkpoint", () => {
    const p = fixture();
    cover(p, "alpha", stages, false);
    const directive = next(p);
    expect(directive.construction_checkpoint).toBeUndefined();
    expect(directive.stage).toBe("functional-design");
    expect(directive.unit).toBe("alpha");
    for (const action of ["start", "complete"]) {
      const recorded = spawnSync(process.execPath, [
        join(AIDLC_SRC, "tools/aidlc-state.ts"), "unit", action,
        "--stage", "functional-design", "--unit", "alpha", "--project-dir", p,
      ], { encoding: "utf-8" });
      expect(recorded.status, `${recorded.stdout}${recorded.stderr}`).toBe(0);
    }
    expect(next(p).stage).toBe("nfr-requirements");
  }, 30_000);

  test("the actual skeleton checkpoint remains human-owned after an early grant", () => {
    const p = fixture({ stance: "on", autonomy: "autonomous" });
    cover(p, "alpha");
    const directive = next(p);
    expect(directive.construction_checkpoint?.kind, JSON.stringify(directive)).toBe("skeleton");
    expect(directive.construction_checkpoint?.human_required).toBe(true);
  }, 30_000);

  test("skeleton-off offers an explicit choice and a recorded choice is not repeated", () => {
    const fresh = fixture({ autonomy: "unset" });
    expect(next(fresh).construction_policy?.offer_autonomy).toBe(true);
    const chosen = fixture({ autonomy: "gated" });
    expect(next(chosen).construction_policy?.offer_autonomy).toBe(false);
  });

  test("stage reports and direct transitions cannot bypass unapproved Unit checkpoints", () => {
    const p = fixture({ current: "code-generation" });
    for (const unit of ["alpha", "beta"]) cover(p, unit);
    const file = seededStateFile(p);
    const initial = readFileSync(file, "utf-8");
    const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    const run = (tool: string, args: string[]) => spawnSync(process.execPath, [
      join(AIDLC_SRC, `tools/aidlc-${tool}.ts`), ...args, "--project-dir", p,
    ], { encoding: "utf-8", env });
    const assertRefused = (tool: string, args: string[], marker: string) => {
      // Already-open and revising gates can survive an upgrade from the old engine.
      const before = initial.replace("[-] code-generation", `[${marker}] code-generation`);
      writeFileSync(file, before);
      const result = run(tool, args);
      const output = `${result.stdout}${result.stderr}`;
      if (tool === "orchestrate") expect(JSON.parse(result.stdout).kind, output).toBe("error");
      else expect(result.status, output).not.toBe(0);
      expect(output).toContain("Construction checkpoints");
      expect(output).toContain("alpha");
      expect(output).toContain("beta");
      expect(readFileSync(file, "utf-8")).toBe(before);
    };
    for (const [result, marker] of [["awaiting-approval", "-"], ["revised", "R"], ["approved", "?"]]) {
      assertRefused("orchestrate", [
        "report", "--stage", "code-generation", "--result", result, "--user-input", "Approve",
      ], marker);
    }
    for (const [action, marker] of [
      ["gate-start", "-"], ["revise", "R"], ["approve", "?"],
      ["advance", "-"], ["finalize", "-"], ["complete-workflow", "-"],
    ]) {
      assertRefused("state", [
        action, "code-generation", ...(action === "approve" ? ["--user-input", "Approve"] : []),
      ], marker);
    }
    writeFileSync(file, initial);
    for (const unit of ["alpha", "beta"]) approve(p, unit);
    for (const result of ["awaiting-approval", "approved"]) {
      const report = run("orchestrate", [
        "report", "--stage", "code-generation", "--result", result, "--user-input", "Approve",
      ]);
      expect(report.status, `${report.stdout}${report.stderr}`).toBe(0);
      expect(JSON.parse(report.stdout).kind).not.toBe("error");
    }
  }, 60_000);

  test("completed Unit approvals make the later stage transition bookkeeping only", () => {
    const p = fixture();
    for (const unit of ["alpha", "beta"]) {
      cover(p, unit);
      approve(p, unit);
    }
    const directive = next(p);
    expect(directive.construction_policy?.completion_only).toBe(true);
    expect(directive.construction_policy?.human_completion_required).toBe(false);
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const refused = spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), "report",
      "--stage", "functional-design", "--result", "rejected",
      "--user-input", "Request Changes", "--reason", "Change the implementation.",
      "--project-dir", p,
    ], { encoding: "utf-8", env });
    expect(`${refused.stdout}${refused.stderr}`).toContain("human");
    expect(JSON.parse(refused.stdout).kind).toBe("error");
    for (const result of ["awaiting-approval", "approved"]) {
      const report = spawnSync(process.execPath, [
        join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), "report",
        "--stage", "functional-design", "--result", result, "--project-dir", p,
      ], { encoding: "utf-8" });
      expect(report.status, `${report.stdout}${report.stderr}`).toBe(0);
      expect(JSON.parse(report.stdout).kind).not.toBe("error");
    }
  }, 30_000);

  test("legacy unit-major does not opt itself into checkpoints", () => {
    const p = fixture({ legacy: true });
    cover(p, "alpha");
    expect(next(p).construction_checkpoint).toBeUndefined();
    expect(next(p).unit).toBe("beta");
  });

  test("legacy stage approval does not require Construction checkpoints", () => {
    const p = fixture({ legacy: true, current: "code-generation" });
    for (const unit of ["alpha", "beta"]) cover(p, unit);
    const env = { ...process.env };
    delete env.AIDLC_SKIP_ARTIFACT_GUARD;
    for (const result of ["awaiting-approval", "approved"]) {
      const report = spawnSync(process.execPath, [
        join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), "report",
        "--stage", "code-generation", "--result", result, "--user-input", "Approve", "--project-dir", p,
      ], { encoding: "utf-8", env });
      expect(report.status, `${report.stdout}${report.stderr}`).toBe(0);
      expect(JSON.parse(report.stdout).kind).not.toBe("error");
    }
  }, 30_000);

  test("autonomy preserves an explicitly selected serial execution", () => {
    const p = fixture({ iteration: "stage-major", autonomy: "autonomous", current: "code-generation" });
    expect(next(p).kind).toBe("run-stage");
  });

  test("explicit stage-major swarm works with guided approval", () => {
    const p = fixture({ iteration: "stage-major", execution: "swarm", current: "code-generation" });
    expect(next(p).kind).toBe("invoke-swarm");
  });

  test("new controls insert into a legacy state and reject incompatible execution", () => {
    const p = fixture({ legacy: true });
    const state = (...args: string[]) => spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-state.ts"), ...args, "--project-dir", p,
    ], { encoding: "utf-8" });
    const enabled = state("set-construction-checkpoints", "enabled");
    expect(enabled.status, `${enabled.stdout}${enabled.stderr}`).toBe(0);
    expect(next(p).construction_policy).toBeDefined();
    const refused = state("set-construction-execution", "swarm");
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("stage-major");
    expect(state("set-construction-execution", "serial").status).toBe(0);
  }, 30_000);

  test("an unrelated human turn cannot disable checkpoints to clear a refusal", () => {
    const p = fixture({ autonomy: "autonomous" });
    const before = readFileSync(seededStateFile(p));
    policyHuman(p, "hello");
    const refused = policyCli(p, "state", ["set-construction-checkpoints", "disabled"]);
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("CONSTRUCTION_POLICY_RECORDED");
    expect(readFileSync(seededStateFile(p))).toEqual(before);
  }, 30_000);

  test("a choice for another pending decision cannot authorize policy", () => {
    const p = fixture();
    const before = readFileSync(seededStateFile(p));
    expect(policyChoice(p, "decision", "Construction Checkpoints", "disabled").status).toBe(0);
    expect(policyCli(p, "log", ["decision", "--stage", "functional-design", "--decision", "Approve the design?", "--options", "Approve,Request Changes"]).status).toBe(0);
    policyHuman(p, "Approve");
    expect(policyChoice(p, "answer", "Construction Checkpoints", "disabled").status).not.toBe(0);
    expect(policyCli(p, "log", ["answer", "--stage", "functional-design", "--details", "Approve"]).status).toBe(0);
    expect(policyCli(p, "state", ["set-construction-checkpoints", "disabled"]).status).not.toBe(0);
    expect(readFileSync(seededStateFile(p))).toEqual(before);
  }, 30_000);

  test("a lifecycle gate answer does not consent to an earlier policy proposal", () => {
    const p = fixture();
    expect(policyChoice(p, "decision", "Construction Checkpoints", "disabled").status).toBe(0);
    const file = seededStateFile(p);
    writeFileSync(file, readFileSync(file, "utf-8").replace("[-] functional-design", "[?] functional-design"));
    appendAuditEntry("STAGE_AWAITING_APPROVAL", { Stage: "functional-design" }, p);
    const before = readFileSync(file);
    policyHuman(p, "Approve");
    const gateAnswer = policyCli(p, "log", ["answer", "--stage", "functional-design", "--details", "Approve"]);
    expect(gateAnswer.status, `${gateAnswer.stdout}${gateAnswer.stderr}`).toBe(0);
    expect(JSON.parse(gateAnswer.stdout).reason).toBe("approval-gate-report-owned");
    expect(policyChoice(p, "answer", "Construction Checkpoints", "disabled").status).not.toBe(0);
    expect(policyCli(p, "state", ["set-construction-checkpoints", "disabled"]).status).not.toBe(0);
    expect(readFileSync(file)).toEqual(before);
  }, 30_000);

  test("a policy receipt binds field and value and authorizes one change only", () => {
    const p = fixture({ iteration: "stage-major" });
    const field = "Construction Checkpoints";
    recordPolicy(p, field, "disabled");
    const before = readFileSync(seededStateFile(p), "utf-8");
    expect(authorizedConstructionPolicyChange(p, before, field, "disabled")).toBe(true);
    expect(policyCli(p, "state", ["set-construction-execution", "swarm"]).status).not.toBe(0);
    expect(policyCli(p, "state", ["set-construction-checkpoints", "disabled"]).status).toBe(0);
    const applied = readFileSync(seededStateFile(p), "utf-8");
    expect(applied).toContain(`- **${field}**: disabled`);
    expect(authorizedConstructionPolicyChange(p, applied, field, "disabled")).toBe(false);
    expect(policyChoice(p, "answer", field, "disabled").status).not.toBe(0);
    expect(policyCli(p, "state", ["set-construction-checkpoints", "enabled"]).status).not.toBe(0);
    expect(readFileSync(seededStateFile(p), "utf-8")).toBe(applied);
    recordPolicy(p, field, "enabled");
    expect(policyCli(p, "state", ["set-construction-checkpoints", "enabled"]).status).toBe(0);
    // The old disabled receipt stays spent even after a later authorized return.
    expect(policyCli(p, "state", ["set-construction-checkpoints", "disabled"]).status).not.toBe(0);
  }, 30_000);

  test("policy answers cannot cross sessions, proposals, or offered choices", () => {
    const p = fixture();
    const field = "Construction Checkpoints";
    const before = readFileSync(seededStateFile(p));
    expect(policyChoice(p, "decision", field, "disabled").status).toBe(0);
    policyHuman(p, "Approve", "other-session");
    expect(policyChoice(p, "answer", field, "disabled").status).not.toBe(0);
    expect(policyChoice(p, "answer", field, "disabled", "other-session").status).not.toBe(0);
    policyHuman(p, "hello");
    expect(policyChoice(p, "answer", field, "disabled").status).not.toBe(0);
    policyHuman(p, "1");
    expect(policyChoice(p, "answer", field, "disabled").status).not.toBe(0);
    policyHuman(p, "Approve");
    expect(policyChoice(p, "answer", field, "enabled").status).not.toBe(0);
    // Re-presenting a proposal invalidates the old hook response.
    expect(policyChoice(p, "decision", field, "disabled").status).toBe(0);
    expect(policyChoice(p, "answer", field, "disabled").status).not.toBe(0);
    policyHuman(p, "Request Changes");
    expect(policyChoice(p, "answer", field, "disabled").status).not.toBe(0);
    expect(policyChoice(p, "answer", field, "disabled", "t342-policy", "Request Changes").status).toBe(0);
    expect(policyCli(p, "state", ["set-construction-checkpoints", "disabled"]).status).not.toBe(0);
    expect(readFileSync(seededStateFile(p))).toEqual(before);
  }, 30_000);

  test("policy authorization rejects restarts, ambiguous frontiers, and superseding proposals", () => {
    const p = fixture();
    const field = "Construction Checkpoints";
    recordPolicy(p, field, "disabled");
    const content = readFileSync(seededStateFile(p), "utf-8");
    const rows = readAuditShardEvents(p);
    const receipt = rows.findLast((row) => row.event === "CONSTRUCTION_POLICY_RECORDED")!;
    expect(auditBlockField(receipt.block, "User Input")).toBe("Approve");
    expect(authorizedConstructionPolicyChange(p, content, field, "disabled", [...rows, { ...receipt, shard: "tied.md" }])).toBe(false);
    const restarted = { ...receipt, event: "WORKFLOW_STARTED", timestamp: "2099-01-01T00:00:00Z", shard: "later.md", block: "**Event**: WORKFLOW_STARTED\n" };
    expect(authorizedConstructionPolicyChange(p, content, field, "disabled", [...rows, restarted])).toBe(false);
    expect(authorizedConstructionPolicyChange(p, content, field, "disabled", [...rows, { ...restarted, block: `${restarted.block}**Workflow**: single-stage:code-generation\n` }])).toBe(true);
    expect(policyChoice(p, "decision", field, "enabled").status).toBe(0);
    expect(policyCli(p, "state", ["set-construction-checkpoints", "disabled"]).status).not.toBe(0);
  }, 30_000);

  test("Inception policy setters keep their receipt-free behavior", () => {
    const p = fixture();
    writeFileSync(seededStateFile(p), setField(readFileSync(seededStateFile(p), "utf-8"), "Lifecycle Phase", "INCEPTION"));
    for (const args of [
      ["set-construction-iteration", "stage-major"],
      ["set-construction-execution", "swarm"],
      ["set-construction-checkpoints", "disabled"],
    ]) expect(policyCli(p, "state", args).status).toBe(0);
    expect(readFileSync(seededStateFile(p), "utf-8")).toContain("**Construction Checkpoints**: disabled");
    expect(readAuditShardEvents(p).some((row) => row.event === "CONSTRUCTION_POLICY_RECORDED")).toBe(false);
  }, 30_000);

  test("iteration consent is required even when checkpoints are disabled", () => {
    const p = fixture();
    writeFileSync(seededStateFile(p), setField(readFileSync(seededStateFile(p), "utf-8"), "Construction Checkpoints", "disabled"));
    const before = readFileSync(seededStateFile(p));
    policyHuman(p, "hello");
    expect(policyCli(p, "state", ["set-construction-iteration", "stage-major"]).status).not.toBe(0);
    expect(readFileSync(seededStateFile(p))).toEqual(before);
    recordPolicy(p, "Construction Iteration", "stage-major");
    expect(policyCli(p, "state", ["set-construction-iteration", "stage-major"]).status).toBe(0);
  }, 30_000);

  test("public audit append cannot mint policy authority", () => {
    const p = fixture();
    const refused = policyCli(p, "audit", ["append", "CONSTRUCTION_POLICY_RECORDED", "--field", "Field=Construction Checkpoints", "--field", "Value=disabled", "--field", "User Input=Approve"]);
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("reserved");
    expect(readAuditShardEvents(p).some((row) => row.event === "CONSTRUCTION_POLICY_RECORDED")).toBe(false);
  });

  test("a policy audit append failure leaves the same human answer retryable", () => {
    const p = fixture();
    const field = "Construction Checkpoints";
    expect(policyChoice(p, "decision", field, "disabled").status).toBe(0);
    policyHuman(p, "Approve");
    const shard = readAuditShardEvents(p)[0].shard;
    const args = ["answer", "--stage", "functional-design", "--checkpoint", "construction-policy",
      "--field", field, "--value", "disabled", "--session", "t342-policy", "--details", "Approve", "--project-dir", p];
    const injected = `
      import * as fs from "node:fs";
      import { spyOn } from "bun:test";
      const original = fs.openSync;
      spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
        if (path === ${JSON.stringify(shard)} && typeof flags === "number" && (flags & fs.constants.O_APPEND) !== 0) {
          throw Object.assign(new Error("Policy audit append unavailable"), { code: "EACCES" });
        }
        return original(path, flags, mode);
      });
      // Load the CLI after installing the fault so its audit imports see the injected append failure.
      const { main } = await import(${JSON.stringify(join(AIDLC_SRC, "tools/aidlc-log.ts"))});
      main(${JSON.stringify(args)});
    `;
    const failed = spawnSync(process.execPath, ["--eval", injected], { cwd: p, encoding: "utf-8", env: process.env });
    expect(failed.status).not.toBe(0);
    expect(`${failed.stdout}${failed.stderr}`).toContain("Policy audit append unavailable");
    expect(readAuditShardEvents(p).some((row) => row.event === "CONSTRUCTION_POLICY_RECORDED")).toBe(false);
    expect(policyChoice(p, "answer", field, "disabled").status).toBe(0);
    expect(policyChoice(p, "answer", field, "disabled").status).not.toBe(0);
    expect(policyCli(p, "state", ["set-construction-checkpoints", "disabled"]).status).toBe(0);
    expect(readFileSync(seededStateFile(p), "utf-8")).toContain("**Construction Checkpoints**: disabled");
  }, 30_000);

  test.each([
    { field: "Construction Checkpoints", value: "disabled", command: "set-construction-checkpoints" },
    { field: "Construction Execution", value: "swarm", command: "set-construction-execution" },
    { field: "Construction Iteration", value: "unit-major", command: "set-construction-iteration" },
  ])("generic set cannot change $field even after a human turn", ({ field, value, command }) => {
    const p = fixture({ iteration: "stage-major", autonomy: "autonomous" });
    const file = seededStateFile(p);
    const before = readFileSync(file);
    const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const assertGenericRefused = () => {
      const refused = spawnSync(process.execPath, [
        join(AIDLC_SRC, "tools/aidlc-state.ts"), "set", `${field}=${value}`, "--project-dir", p,
      ], { encoding: "utf-8", env });
      const output = `${refused.stdout}${refused.stderr}`;
      expect(refused.status, output).not.toBe(0);
      expect(output).toContain(field);
      expect(output).toContain(command);
      expect(readFileSync(file)).toEqual(before);
    };
    assertGenericRefused();
    appendAuditEntry("HUMAN_TURN", {}, p);
    assertGenericRefused();
    const unconsented = policyCli(p, "state", [command, value]);
    expect(unconsented.status, `${unconsented.stdout}${unconsented.stderr}`).not.toBe(0);
    expect(readFileSync(file)).toEqual(before);
    recordPolicy(p, field, value);
    const changed = spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-state.ts"), command, value, "--project-dir", p,
    ], { encoding: "utf-8", env });
    expect(changed.status, `${changed.stdout}${changed.stderr}`).toBe(0);
    expect(readFileSync(file, "utf-8")).toContain(`- **${field}**: ${value}`);
  }, 30_000);

  test("generic set refuses a mixed policy batch without changing any state bytes", () => {
    const p = fixture({ autonomy: "autonomous" });
    const file = seededStateFile(p);
    const before = readFileSync(file);
    const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1" };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const refused = spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-state.ts"), "set", "Lifecycle Phase=inception",
      "Construction Checkpoints=disabled", "--project-dir", p,
    ], { encoding: "utf-8", env });
    const output = `${refused.stdout}${refused.stderr}`;
    expect(refused.status, output).not.toBe(0);
    expect(output).toContain("Construction Checkpoints");
    expect(output).toContain("set-construction-checkpoints");
    expect(readFileSync(file)).toEqual(before);
  }, 30_000);
});
