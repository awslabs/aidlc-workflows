// covers: function:broughtFileNames, function:broughtFilesChanged, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// The build is told which files the person had before the work started
// (t-build-told-brought-files), from the listing the work kept when it started.
// Two paths had none (AIDA review 5661667060 F1 on #3192): a Code Generation run
// on its own (`--single`), whose start keeps no listing and which read the other
// work's start when there was one, and a teammate's clone, which does not hold
// the work's listing (AI-DLC's ignored copy). Each now takes one on this machine
// when its run first runs here: the files there then are the person's, less the
// code itself, since an earlier build's code may be among them. The plan step and
// the build are told them, and on the clone the gate's compare reads the same
// listing, so a README the build replaced is named there. Nothing new on screen.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, createTestProject, runOrchestrateNext, seedAidlcMemory, seedBoltDag,
  seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { createCodeGenerationProject, reviewText, runNamed, stageDir, writePlan } from "../harness/code-generation-states.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { sourceBaselineAuditFields, workspaceBaselineStageSlugs } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The stage's checks are not this file's subject, and its fixture documents
// are not written for them.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(600_000);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const CHAT = "01995000-7a11-7000-8000-0000000d0001";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const README = "# React Todo App\n\nA simple todo application.\n";
const LEAVE = "Leave them as they are unless this work's plan changes one of them.";
const SINGLE = ["--stage", "code-generation", "--single", "--scope", "poc"];
const ENV = { AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };

const note = (...names: string[]): string =>
  `These files were in this project before this work started and are the person's: ${names.map((name) => `\`${name}\``).join(", ")}. ${LEAVE}`;

function next(proj: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}): Record<string, unknown> {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), proj, args, {
    env: {
      ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
      AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload", ...extra,
    },
  });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Record<string, unknown>;
}

// `next`, with the setup questions Code Generation asks first answered as the
// fixture's person would: a new project, built by one session.
function step(proj: string, args: string[] = []): Record<string, unknown> {
  for (let hop = 0; hop < 5; hop++) {
    const directive = next(proj, args);
    const command = directive.kind !== "ask" ? undefined
      : directive.ask_type === "project-type"
      ? directive.new_project_command
      : directive.ask_type === "construction-staffing"
      ? (directive.choices as Array<{ label: string; command?: string }>).find((choice) => choice.label === "Just me")?.command
      : undefined;
    if (typeof command !== "string") return directive;
    const ran = runNamed(proj, command, { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
  }
  throw new Error("the setup questions did not end in 5 answers");
}

function write(proj: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(proj, path)), { recursive: true });
    writeFileSync(join(proj, path), text, "utf-8");
  }
}

function planStep(step: Record<string, unknown>): Record<string, unknown> {
  expect(step.kind, JSON.stringify(step).slice(0, 600)).toBe("run-stage");
  expect((step.plan_approval as { status?: string } | undefined)?.status).toBe("plan");
  return step;
}

function buildStep(step: Record<string, unknown>): Record<string, unknown> {
  expect(step.kind, JSON.stringify(step).slice(0, 600)).toBe("run-stage");
  expect(step.mode).toBe("subagent");
  return step;
}

// The listings this machine took, in AI-DLC's ignored engine folder of `record`.
function taken(record: string): string[] {
  const dir = join(record, ".aidlc-engine", "brought-files");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

// A poc project at Code Generation with plan approval off (t51's path), its
// work started over the person's files.
function workAt(brought: Record<string, string>): string {
  const proj = createCodeGenerationProject("off", "off");
  created.push(proj);
  const stateFile = seededStateFile(proj);
  writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
    .replace("- **Project Type**: Brownfield", "- **Project Type**: Greenfield")
    .replace("- [ ] code-generation", "- [-] code-generation")
    .replace(/^(- \[.\] units-generation) \u2014 EXECUTE$/m, "$1 \u2014 SKIP"), "utf-8");
  write(proj, brought);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "poc", ...sourceBaselineAuditFields(proj, workspaceBaselineStageSlugs()) }, proj);
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", ...sourceBaselineAuditFields(proj, "code-generation") }, proj);
  return proj;
}

// What a teammate's clone lacks: every listing the engine kept on the machine
// the work started on (AI-DLC's ignored copy), deleted file by file.
function asClone(proj: string): void {
  const root = join(seededRecordDir(proj), ".aidlc-engine", "source-review");
  for (const stage of readdirSync(root)) {
    for (const file of readdirSync(join(root, stage))) {
      if (file.startsWith("baseline-")) unlinkSync(join(root, stage, file));
    }
  }
}

// The build's own outputs, the review READY, and the gate opened as the agent opens it.
function openGate(proj: string): Record<string, unknown> {
  write(proj, { "src/slugify.ts": "export const slugify = (s: string) => s;\n" });
  writeFileSync(join(stageDir(proj), "traceability.json"), "{}\n", "utf-8");
  writeFileSync(join(stageDir(proj), "code-summary.md"), "# Code Summary\n", "utf-8");
  const review = `bun .claude/tools/aidlc.ts engine log review --stage code-generation --reviewer ${REVIEWER} --iteration 1`;
  const requested = runNamed(proj, review, ENV);
  const reviewFile = (JSON.parse(requested.stdout || "{}") as { reviewFile?: string }).reviewFile;
  expect(reviewFile, requested.stdout + requested.stderr).toBeTruthy();
  write(proj, { [reviewFile!]: reviewText(REVIEWER) });
  expect(runNamed(proj, `${review} --verdict READY`, ENV).status).toBe(0);
  const ran = runNamed(proj, "bun .claude/tools/aidlc.ts engine orchestrate report --stage code-generation --result awaiting-approval", ENV);
  const gate = JSON.parse(ran.stdout.trim().split("\n").at(-1) || "{}") as Record<string, unknown>;
  expect(gate.kind, ran.stdout + ran.stderr).toBe("print");
  return gate;
}

describe("a Code Generation run on its own", () => {
  test("in a folder with no other work: the plan step names the person's README, not their code, and the README stays as it was", () => {
    const proj = createOrchestrationTestProject();
    created.push(proj);
    cpSync(AIDLC_SRC, join(proj, ".claude"), { recursive: true });
    write(proj, { "README.md": README, "src/app.ts": "export const app = 1;\n" });
    const plan = planStep(step(proj, SINGLE));
    expect(plan.single).toBe(true);
    expect(plan.brought_files_note).toBe(note("README.md"));
    expect(readFileSync(join(proj, "README.md"), "utf-8")).toBe(README);
  });

  test("beside a piece of work: the files there when the run started, not when the work did; its build is told the same", () => {
    const proj = workAt({ "README.md": README });
    write(proj, { "LATER.md": "after the work started, before this run\n" });
    const plan = planStep(step(proj, SINGLE));
    expect(plan.brought_files_note).toBe(note("LATER.md", "README.md"));
    write(proj, { "NOTES.md": "after this run started\n" });
    writePlan(proj);
    const build = buildStep(step(proj, SINGLE));
    expect(build.brought_files_note).toBe(plan.brought_files_note);
    expect(String(build.brief_note)).toEndWith(` ${String(plan.brought_files_note)}`);
    expect(taken(seededRecordDir(proj))).toHaveLength(1);
  });

  test("started over with another setting, it is the same run: the first listing stands, and no second one is taken", () => {
    const proj = workAt({ "README.md": README });
    const plan = planStep(step(proj, SINGLE));
    write(proj, { "NOTES.md": "after this run started\n" });
    const again = step(proj, [...SINGLE, "--test-strategy", "comprehensive"]);
    expect(again.kind, JSON.stringify(again).slice(0, 600)).toBe("run-stage");
    expect(again.brought_files_note).toBe(plan.brought_files_note);
    expect(taken(seededRecordDir(proj))).toHaveLength(1);
  });
});

describe("a teammate's clone that picks up the build", () => {
  test("the plan step and the build name the person's README from the listing taken here; the gate names the README the build replaced", () => {
    const proj = workAt({ "README.md": README });
    asClone(proj);
    const plan = planStep(step(proj));
    expect(plan.brought_files_note).toBe(note("README.md"));
    write(proj, { "CONTRIBUTING.md": "after the pick-up\n" });
    writePlan(proj);
    const build = buildStep(step(proj));
    expect(build.brought_files_note).toBe(plan.brought_files_note);
    expect(String(build.brief_note)).toEndWith(` ${String(plan.brought_files_note)}`);
    expect(readFileSync(join(proj, "README.md"), "utf-8")).toBe(README);
    expect(taken(seededRecordDir(proj))).toHaveLength(1);
    // The build replaces the README, and rewrites the code an earlier build may have written.
    write(proj, { "README.md": "# React Todo App\n\nRun npm install, then npm run dev.\n", "src/base.ts": "export const base = false;\n" });
    const gate = openGate(proj);
    expect(String(gate.narration)).toContain(
      "The build changed README.md, a file you had before this work started. There is no committed copy to put back.",
    );
    expect(String(gate.narration)).not.toContain("src/base.ts");
  });

  test("a read-only check of the step takes nothing; the agent's own step then takes it", () => {
    const proj = workAt({ "README.md": README });
    asClone(proj);
    // The setup questions answered; the listing that step took is set aside.
    step(proj);
    const record = seededRecordDir(proj);
    for (const file of taken(record)) unlinkSync(join(record, ".aidlc-engine", "brought-files", file));
    const probe = next(proj, [], { AIDLC_STOP_HOOK_PROBE: "1" });
    expect(probe.brought_files_note).toBeUndefined();
    expect(taken(seededRecordDir(proj))).toEqual([]);
    expect(planStep(step(proj)).brought_files_note).toBe(note("README.md"));
  });

  test("what the work's Units built before the pick-up (their source manifests) is the work's, not the person's", () => {
    const p = createTestProject();
    created.push(p);
    seedAidlcMemory(p);
    writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Picked up
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
- **Construction Autonomy Mode**: gated
- **Review Override**: advisory
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
- [S] functional-design \u2014 SKIP
- [S] nfr-requirements \u2014 SKIP
- [S] nfr-design \u2014 SKIP
- [S] infrastructure-design \u2014 SKIP
- [-] code-generation \u2014 EXECUTE
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`);
    seedBoltDag(p, ["alpha", "beta"]);
    cpSync(AIDLC_SRC, join(p, ".claude"), { recursive: true });
    write(p, { "README.md": README });
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", ...sourceBaselineAuditFields(p, workspaceBaselineStageSlugs()) }, p);
    // Unit alpha's build ran on the machine the work started on.
    write(p, { "docs/alpha.md": "# Alpha\n" });
    const manifest = join(seededRecordDir(p), "construction", "alpha", "code-generation", "source-manifest.json");
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, JSON.stringify({ stage: "code-generation", unit: "alpha", version: 1, writes: [{ path: "docs/alpha.md" }] }));
    asClone(p);
    const plan = planStep(step(p));
    expect(plan.unit).toBe("alpha");
    expect(plan.brought_files_note).toBe(note("README.md"));
  });
});
