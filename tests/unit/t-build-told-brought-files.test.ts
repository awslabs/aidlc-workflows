// covers: function:broughtFileNames, function:broughtFilesNote, function:withAgentNotes, subcommand:aidlc-orchestrate:next
//
// The build wrote the app's README over the one the person brought (t51, run
// 40419252454): the lead planned "Write a short README.md" as if
// there were none, and briefed the developer with a list of files to leave that
// it made up. Every Code Generation step whose work runs here now names the
// files the project held when the work started, from the listing the gate's
// compare reads, and a dispatched build's brief carries the same sentence word
// for word. The code itself on existing code, AI-DLC's own files and files
// added after the work started are not named; a clone that does not hold the
// listing takes its own (t-run-alone-and-clone-told-brought-files). Nothing
// changes on screen.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { createCodeGenerationProject, reviewText, runNamed, stageDir, writePlan } from "../harness/code-generation-states.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { sha256Bytes } from "../../dist/claude/.claude/tools/aidlc-distribution.ts";
import { broughtFilesNote } from "../../dist/claude/.claude/tools/aidlc-brought-files.ts";
import { otherWorkNote, validateDirective, withAgentNotes } from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import { sourceBaselineAuditFields, workspaceBaselineStageSlugs } from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The stage's checks are not this file's subject, and its fixture documents
// are not written for them.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(600_000);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const CHAT = "01995000-7a11-7000-8000-0000000c0001";
const REVIEWER = "aidlc-architecture-reviewer-agent";
const README = "# React Todo App\n\nA simple todo application.\n";
const LEAVE = "Leave them as they are unless this work's plan changes one of them.";

function next(proj: string, args: string[] = []): Record<string, unknown> {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), proj, args, {
    env: {
      ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0",
      AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
    },
  });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Record<string, unknown>;
}

// `next`, with the setup questions Code Generation asks first answered as the
// fixture's person would: the folder stays the kind of project the state says,
// and one session builds the Units.
function step(proj: string): Record<string, unknown> {
  for (let hop = 0; hop < 5; hop++) {
    const directive = next(proj);
    const command = directive.kind !== "ask" ? undefined
      : directive.ask_type === "project-type"
      ? readFileSync(seededStateFile(proj), "utf-8").includes("- **Project Type**: Brownfield")
        ? directive.existing_code_command
        : directive.new_project_command
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

interface Setup {
  type?: "Greenfield" | "Brownfield";
  // The person's files, there when the work starts.
  brought: Record<string, string>;
  // Added after the work started and before the build (a teammate's, an earlier attempt's).
  later?: Record<string, string>;
}

// `atPlanIn` over a new project.
function atPlan(setup: Setup): { proj: string; plan: Record<string, unknown> } {
  const proj = createCodeGenerationProject("off", "off");
  created.push(proj);
  return atPlanIn(proj, setup);
}

// The step after the plan is written: the build, dispatched to the developer.
function atBuild(proj: string): Record<string, unknown> {
  writePlan(proj);
  const build = step(proj);
  expect(build.kind, JSON.stringify(build).slice(0, 600)).toBe("run-stage");
  expect(build.mode).toBe("subagent");
  return build;
}

describe("the steps that plan and build Code Generation", () => {
  test("the plan step names the files the person had when the work started, top-level first", () => {
    const { plan } = atPlan({ brought: { "README.md": README, "docs/notes.md": "notes\n" } });
    expect(plan.brought_files_note).toBe(
      "These files were in this project before this work started and are the person's: `README.md`, " +
        `\`docs/notes.md\`, \`src/base.ts\`. ${LEAVE}`,
    );
  });

  test("the dispatched build carries it, and its brief carries the same sentence word for word", () => {
    const { proj, plan } = atPlan({ brought: { "README.md": README } });
    const build = atBuild(proj);
    expect(build.brought_files_note).toBe(plan.brought_files_note);
    expect(String(build.brief_note)).toEndWith(` ${String(plan.brought_files_note)}`);
  });

  test("a file added after the work started is not named", () => {
    const { plan } = atPlan({ brought: { "README.md": README }, later: { "CONTRIBUTING.md": "a teammate's\n" } });
    expect(String(plan.brought_files_note)).toContain("`README.md`");
    expect(String(plan.brought_files_note)).not.toContain("CONTRIBUTING.md");
  });

  test("existing code: the code the work changes is not named; the README is", () => {
    const { plan } = atPlan({ type: "Brownfield", brought: { "README.md": README, "src/app.ts": "export const app = 1;\n" } });
    expect(plan.brought_files_note).toBe(
      `These files were in this project before this work started and are the person's: \`README.md\`. ${LEAVE}`,
    );
  });

  test("AI-DLC's own whole file is not named while it holds what AI-DLC wrote; edited, it is", () => {
    const mcp = "{\"mcpServers\":{}}\n";
    const record = (hash: string) => JSON.stringify({ files: {}, rootContributions: { ".mcp.json": { policy: "whole-file", hash } } });
    const kept = createCodeGenerationProject("off", "off");
    created.push(kept);
    write(kept, { ".claude/tools/data/aidlc-manifest.json": record(sha256Bytes(mcp)) });
    const { plan } = atPlanIn(kept, { brought: { "README.md": README, ".mcp.json": mcp, ".gitignore": "node_modules\n" } });
    expect(String(plan.brought_files_note)).toContain("`.gitignore`, `README.md`");
    expect(String(plan.brought_files_note)).not.toContain(".mcp.json");
    const edited = createCodeGenerationProject("off", "off");
    created.push(edited);
    write(edited, { ".claude/tools/data/aidlc-manifest.json": record(sha256Bytes(mcp)) });
    const changed = atPlanIn(edited, { brought: { "README.md": README, ".mcp.json": "{\"mcpServers\":{\"mine\":{}}}\n" } });
    expect(String(changed.plan.brought_files_note)).toContain("`.mcp.json`");
  });

  test("ten long names and the rest counted: the dispatched build still goes out whole", () => {
    const long = Object.fromEntries(Array.from({ length: 12 }, (_, i) =>
      [`docs/architecture/decisions/${String(i).padStart(4, "0")}-a-decision-record-with-a-long-title.md`, "decided\n"]));
    const { proj } = atPlan({ brought: { "README.md": README, ...long } });
    const build = atBuild(proj);
    // README.md, the twelve records and the fixture's src/base.ts: ten named, four counted.
    expect(String(build.brief_note)).toContain("and 4 more that were here before this work started.");
  });

  test("no listing of the work's start on this machine (a teammate's clone): the files here when its plan step runs, less the code", () => {
    // A file added before the build, so the work's start and the build's own listings differ and only the first goes.
    const { proj } = atPlan({ brought: { "README.md": README }, later: { "CONTRIBUTING.md": "a teammate's\n" } });
    const audit = readdirSync(join(seededRecordDir(proj), "audit"))
      .map((name) => readFileSync(join(seededRecordDir(proj), "audit", name), "utf-8")).join("\n");
    const started = /WORKFLOW_STARTED[\s\S]*?\*\*Source Baseline\*\*: (\S+)/.exec(audit)?.[1] ?? "";
    const hash = /([0-9a-f]{64})$/.exec(started)?.[1] ?? "";
    expect(hash, started).not.toBe("");
    unlinkSync(join(seededRecordDir(proj), ".aidlc-engine", "source-review", "code-generation", `baseline-${hash.slice(0, 12)}.tsv`));
    const plan = next(proj);
    expect(plan.kind, JSON.stringify(plan).slice(0, 600)).toBe("run-stage");
    expect((plan.plan_approval as { status?: string } | undefined)?.status).toBe("plan");
    expect(plan.brought_files_note).toBe(
      `These files were in this project before this work started and are the person's: \`CONTRIBUTING.md\`, \`README.md\`. ${LEAVE}`,
    );
  });

  test("the gate shown again, whose work does not run, carries no note; the build redone after Request Changes does", () => {
    const { proj } = atPlan({ brought: { "README.md": README } });
    atBuild(proj);
    const env = { ...process.env, AIDLC_SESSION_OVERRIDE: CHAT, AIDLC_SESSION_OVERRIDE_SOURCE: "payload", AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
    openGate(proj, env);
    const again = next(proj);
    expect(again.gate_only, JSON.stringify(again).slice(0, 600)).toBe(true);
    expect(again.brought_files_note).toBeUndefined();
    report(proj, "rejected", env, " --user-input 'Request Changes' --reason 'rename the handler'");
    const redo = next(proj);
    expect(redo.kind, JSON.stringify(redo).slice(0, 600)).toBe("run-stage");
    expect(redo.gate_only).toBeUndefined();
    expect(String(redo.brought_files_note)).toContain("`README.md`");
  });
});

// A poc project at Code Generation with plan approval off (t51's path), its work
// started over the person's files: the step that writes the plan. `proj` is made
// first, so a test can write its install record before the work starts.
function atPlanIn(proj: string, setup: Setup): { proj: string; plan: Record<string, unknown> } {
  const stateFile = seededStateFile(proj);
  writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
    .replace("- **Project Type**: Brownfield", `- **Project Type**: ${setup.type ?? "Greenfield"}`)
    .replace("- [ ] code-generation", "- [-] code-generation")
    .replace(/^(- \[.\] units-generation) — EXECUTE$/m, "$1 — SKIP"), "utf-8");
  write(proj, setup.brought);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "poc", ...sourceBaselineAuditFields(proj, workspaceBaselineStageSlugs()) }, proj);
  write(proj, setup.later ?? {});
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", ...sourceBaselineAuditFields(proj, "code-generation") }, proj);
  const plan = step(proj);
  expect(plan.kind, JSON.stringify(plan).slice(0, 600)).toBe("run-stage");
  expect((plan.plan_approval as { status?: string } | undefined)?.status).toBe("plan");
  return { proj, plan };
}

// The build's own outputs, the review READY, and the gate opened as the agent opens it.
function openGate(proj: string, env: NodeJS.ProcessEnv): void {
  write(proj, { "src/slugify.ts": "export const slugify = (s: string) => s;\n" });
  writeFileSync(join(stageDir(proj), "traceability.json"), "{}\n", "utf-8");
  writeFileSync(join(stageDir(proj), "code-summary.md"), "# Code Summary\n", "utf-8");
  const review = `bun .claude/tools/aidlc.ts engine log review --stage code-generation --reviewer ${REVIEWER} --iteration 1`;
  const requested = runNamed(proj, review, env);
  const reviewFile = (JSON.parse(requested.stdout || "{}") as { reviewFile?: string }).reviewFile;
  expect(reviewFile, requested.stdout + requested.stderr).toBeTruthy();
  write(proj, { [reviewFile!]: reviewText(REVIEWER) });
  expect(runNamed(proj, `${review} --verdict READY`, env).status).toBe(0);
  report(proj, "awaiting-approval", env);
}

function report(proj: string, result: string, env: NodeJS.ProcessEnv, extra = ""): void {
  const ran = runNamed(proj, `bun .claude/tools/aidlc.ts engine orchestrate report --stage code-generation --result ${result}${extra}`, env);
  const step = JSON.parse(ran.stdout.trim().split("\n").at(-1) || "{}") as Record<string, unknown>;
  expect(step.kind, ran.stdout + ran.stderr).toBe("print");
}

describe("the note's words", () => {
  const runStage = (fields: Record<string, unknown>): Record<string, unknown> => ({
    kind: "run-stage",
    stage: "code-generation",
    phase: "construction",
    stage_file: ".claude/aidlc-common/stages/construction/code-generation.md",
    ceremony: { summary_confirmation: "off" },
    ...fields,
  });

  test("names at most ten, then counts the rest", () => {
    const note = broughtFilesNote(Array.from({ length: 13 }, (_, i) => `docs/page-${String(i).padStart(2, "0")}.md`));
    expect(note).toContain("`docs/page-09.md`, and 3 more that were here before this work started.");
    expect(note).not.toContain("page-10");
    expect(note.replace(/`[^`]*`/g, " ")).not.toMatch(/[a-z]+_[a-z_]+/);
  });

  test("a dispatched step's brief carries it after the other work's sentence; an inline step has no brief", () => {
    const mine = broughtFilesNote(["README.md"]);
    const theirs = otherWorkNote([{ work: "export-fix", record: "aidlc/spaces/default/intents/other", paths: ["version.ts"] }]);
    const dispatched = withAgentNotes(runStage({ mode: "subagent", other_work_note: theirs, brought_files_note: mine }), "bun x.ts") as
      Record<string, unknown>;
    expect(String(dispatched.brief_note)).toEndWith(` ${theirs} ${mine}`);
    const inline = withAgentNotes(runStage({ mode: "inline", brought_files_note: mine }), "bun x.ts") as Record<string, unknown>;
    expect(inline.brief_note).toBeUndefined();
    expect(inline.brought_files_note).toBe(mine);
  });

  test("rides only a run-stage", () => {
    const note = broughtFilesNote(["README.md"]);
    const errorsNaming = (result: ReturnType<typeof validateDirective>): string[] =>
      result.valid ? [] : result.errors.filter((error) => error.includes("brought_files_note"));
    expect(errorsNaming(validateDirective(runStage({ mode: "inline", brought_files_note: note })))).toEqual([]);
    expect(errorsNaming(validateDirective({ kind: "print", message: "x", brought_files_note: note })).length).toBeGreaterThan(0);
  });
});

// Construction Checkpoints: Units alpha and beta, Code Generation the one
// Construction stage each Unit runs (the t-gate-says-replaced-files fixture).
describe("a Unit's Code Generation", () => {
  test("the Unit's plan step names the files the person had when the work started", () => {
    const p = createTestProject();
    created.push(p);
    seedAidlcMemory(p);
    writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Changed files
- **Project Type**: Brownfield
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
- [S] functional-design — SKIP
- [S] nfr-requirements — SKIP
- [S] nfr-design — SKIP
- [S] infrastructure-design — SKIP
- [-] code-generation — EXECUTE
- [ ] build-and-test — EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: code-generation
- **Status**: Running
`);
    seedBoltDag(p, ["alpha", "beta"]);
    cpSync(AIDLC_SRC, join(p, ".claude"), { recursive: true });
    write(p, { "README.md": README, "src/alpha.ts": "export const alpha = 1;\n" });
    appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", ...sourceBaselineAuditFields(p, workspaceBaselineStageSlugs()) }, p);
    const plan = step(p);
    expect(plan.kind, JSON.stringify(plan).slice(0, 600)).toBe("run-stage");
    expect(plan.unit).toBe("alpha");
    expect(plan.brought_files_note).toBe(
      `These files were in this project before this work started and are the person's: \`README.md\`. ${LEAVE}`,
    );
  });
});
