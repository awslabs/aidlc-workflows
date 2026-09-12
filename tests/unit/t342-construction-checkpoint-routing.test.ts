// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-state:set-construction-checkpoints, subcommand:aidlc-state:set-construction-execution, function:isAutonomousConstructionGate, function:isConstructionSwarmEnabled
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  reviewArtifactFingerprint,
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
    construction_checkpoint?: { kind: string; unit: string; human_required: boolean };
    construction_policy?: { offer_autonomy: boolean; completion_only: boolean; human_completion_required: boolean };
  };
}

function approve(p: string, unit: string, kind: "unit" | "skeleton" = "unit") {
  const script = join(seededRecordDir(p), `check-${unit}.cjs`);
  writeFileSync(script, `const fs=require('node:fs'); if(!fs.readFileSync('src/${unit}.ts','utf8').includes('${unit}'))process.exit(1);`);
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const invoke = (args: string[]) => {
    const result = spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-bolt.ts"), "checkpoint", "--unit", unit,
      "--kind", kind, ...args, "--project-dir", p,
    ], { encoding: "utf-8" });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    return JSON.parse(result.stdout);
  };
  const checked = invoke([
    "--action", "verify", "--check-cmd", `${quote(process.execPath)} ${quote(script)}`,
  ]);
  expect(checked.errors).toEqual([]);
  expect(checked.verified).toBe(true);
  appendAuditEntry("HUMAN_TURN", {}, p);
  expect(invoke(["--action", "approve", "--user-input", "Approve"]).approved).toBe(true);
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

  test("an unattended run cannot disable its checkpoints to clear a refusal", () => {
    const p = fixture({ autonomy: "autonomous" });
    const env = { ...process.env };
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const set = () => spawnSync(process.execPath, [
      join(AIDLC_SRC, "tools/aidlc-state.ts"), "set-construction-checkpoints",
      "disabled", "--project-dir", p,
    ], { encoding: "utf-8", env });
    const refused = set();
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("fresh human request");
    appendAuditEntry("HUMAN_TURN", {}, p);
    expect(set().status).toBe(0);
  }, 30_000);
});
