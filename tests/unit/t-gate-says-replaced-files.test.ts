// covers: subcommand:aidlc-orchestrate:report, subcommand:aidlc-orchestrate:next, subcommand:aidlc-bolt:checkpoint
// covers: function:broughtFilesChanged, function:broughtFilesLine, function:unheardBroughtFilesLine, function:workStartSourceBaseline
//
// The build replaced the README the person brought and nothing on screen said
// so (t51, P182). The gate that approves Code Generation now says once which
// files the person had before the work started the build changed or deleted,
// with the command that puts each back when git holds the old copy, and plainly
// that there is no committed copy when it does not. A brownfield build's own
// code changes are not named; a file the work or a teammate added after the
// work started is not theirs; nothing is said when the engine cannot know. The
// gate itself is unchanged: no refusal, no question, no step.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { createCodeGenerationProject, reply, reviewText, runNamed, stageDir, writePlan } from "../harness/code-generation-states.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject, reviewArtifactFingerprint, sourceBaselineAuditFields,
  workspaceBaselineStageSlugs,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

// The stage's checks run once before its review or gate, and again at the gate
// (completionChecksStep, t-checks-before-review); this file's fixture documents
// are not written for them and its subject is not them, so they stay off here.
process.env.AIDLC_DISABLE_SENSORS = "1";

setDefaultTimeout(600_000);
const created: string[] = [];
afterEach(() => {
  while (created.length > 0) cleanupTestProject(created.pop());
});

const REVIEWER = "aidlc-architecture-reviewer-agent";
const CHAT_A = "01995000-7a11-7000-8000-0000000b0001";
const CHAT_B = "01995000-7a11-7000-8000-0000000b0002";
const README = "# React Todo App\n\nA simple todo application.\n";

function chat(session: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { AIDLC_SESSION_OVERRIDE: session, AIDLC_SESSION_OVERRIDE_SOURCE: "payload", ...extra };
}

function git(proj: string, args: string[]): string {
  const run = spawnSync("git", args, {
    cwd: proj, encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    env: { ...process.env, GIT_AUTHOR_NAME: "Person", GIT_AUTHOR_EMAIL: "person@example.com", GIT_COMMITTER_NAME: "Person", GIT_COMMITTER_EMAIL: "person@example.com" },
  });
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
  return run.stdout;
}

function next(proj: string, env: NodeJS.ProcessEnv = chat(CHAT_A)): Record<string, unknown> {
  const result = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), proj, [], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_UNATTENDED: "0", ...env },
  });
  expect(result.directive, result.out).not.toBeNull();
  return result.directive as Record<string, unknown>;
}

interface Setup {
  type?: "Greenfield" | "Brownfield";
  // The person's files, there when the work starts.
  brought: Record<string, string>;
  git?: boolean;
  // Brought files the person never committed.
  uncommitted?: string[];
  // Added after the work started and before the build (a teammate's, an earlier attempt's).
  later?: Record<string, string>;
}

// A poc project at Code Generation with plan approval off (t51's path), its
// work started over the person's files and the build begun.
function atBuild(setup: Setup): string {
  const proj = createCodeGenerationProject("off", "off");
  created.push(proj);
  const stateFile = seededStateFile(proj);
  writeFileSync(stateFile, readFileSync(stateFile, "utf-8")
    .replace("- **Project Type**: Brownfield", `- **Project Type**: ${setup.type ?? "Greenfield"}`)
    .replace("- [ ] code-generation", "- [-] code-generation")
    .replace(/^(- \[.\] units-generation) \u2014 EXECUTE$/m, "$1 \u2014 SKIP"), "utf-8");
  for (const [path, text] of Object.entries(setup.brought)) {
    mkdirSync(dirname(join(proj, path)), { recursive: true });
    writeFileSync(join(proj, path), text, "utf-8");
  }
  if (setup.git) {
    git(proj, ["init", "-q"]);
    git(proj, ["add", "-A", "--", ...Object.keys(setup.brought).filter((path) => !setup.uncommitted?.includes(path))]);
    git(proj, ["commit", "-qm", "the person's files"]);
  }
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "poc", ...sourceBaselineAuditFields(proj, workspaceBaselineStageSlugs()) }, proj);
  for (const [path, text] of Object.entries(setup.later ?? {})) {
    mkdirSync(dirname(join(proj, path)), { recursive: true });
    writeFileSync(join(proj, path), text, "utf-8");
  }
  appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", ...sourceBaselineAuditFields(proj, "code-generation") }, proj);
  next(proj);
  writePlan(proj);
  const step = next(proj);
  expect(step.kind, JSON.stringify(step).slice(0, 600)).toBe("run-stage");
  return proj;
}

function write(proj: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(proj, path)), { recursive: true });
    writeFileSync(join(proj, path), text, "utf-8");
  }
}

// The stage's review, asked for and recorded READY.
function reviewed(proj: string, iteration: number, env: NodeJS.ProcessEnv): void {
  const review = `bun .claude/tools/aidlc.ts engine log review --stage code-generation --reviewer ${REVIEWER} --iteration ${iteration}`;
  const requested = runNamed(proj, review, env);
  const reviewFile = (JSON.parse(requested.stdout || "{}") as { reviewFile?: string }).reviewFile;
  expect(reviewFile, requested.stdout + requested.stderr).toBeTruthy();
  mkdirSync(dirname(join(proj, reviewFile!)), { recursive: true });
  writeFileSync(join(proj, reviewFile!), reviewText(REVIEWER).replace("**Iteration:** 1", `**Iteration:** ${iteration}`), "utf-8");
  expect(runNamed(proj, `${review} --verdict READY`, env).status).toBe(0);
}

// The build's own outputs, the review READY, and the gate opened as the agent opens it.
function openGate(proj: string, env: NodeJS.ProcessEnv = chat(CHAT_A)): Record<string, unknown> {
  write(proj, { "src/slugify.ts": "export const slugify = (s: string) => s;\n" });
  writeFileSync(join(stageDir(proj), "traceability.json"), "{}\n", "utf-8");
  writeFileSync(join(stageDir(proj), "code-summary.md"), "# Code Summary\n", "utf-8");
  reviewed(proj, 1, env);
  return report(proj, "awaiting-approval", env);
}

function report(proj: string, result: string, env: NodeJS.ProcessEnv = chat(CHAT_A), extra = ""): Record<string, unknown> {
  const ran = runNamed(proj, `bun .claude/tools/aidlc.ts engine orchestrate report --stage code-generation --result ${result}${extra}`, env);
  const step = JSON.parse(ran.stdout.trim().split("\n").at(-1) || "{}") as Record<string, unknown>;
  expect(step.kind, ran.stdout + ran.stderr).toBe("print");
  return step;
}

const said = (step: Record<string, unknown>): string => String(step.narration ?? "");

describe("t-gate-says-replaced-files", () => {
  test("no git: the build replaced the README the person brought; the gate says so and that there is no committed copy", () => {
    const proj = atBuild({ brought: { "README.md": README } });
    write(proj, { "README.md": "# React Todo App\n\nRun npm install, then npm run dev.\n" });
    const gate = openGate(proj);
    expect(said(gate)).toContain(
      "The build changed README.md, a file you had before this work started. There is no committed copy to put back.",
    );
    // The gate is the same gate: its question and Approve target are untouched.
    expect(gate.next_stage, JSON.stringify(gate)).toBe("Build and Test");
  });

  test("git: one command puts back the changed README and the deleted LICENSE, and it works", () => {
    const proj = atBuild({ git: true, brought: { "README.md": README, LICENSE: "MIT\n", "src/base.ts": "export const base = true;\n" } });
    write(proj, { "README.md": "# Replaced\n" });
    unlinkSync(join(proj, "LICENSE"));
    const line = said(openGate(proj));
    const expected = "The build changed README.md and deleted LICENSE, files you had before this work started. " +
      "To put them back, run `git checkout HEAD -- LICENSE README.md`.";
    expect(line).toContain(expected);
    git(proj, ["checkout", "HEAD", "--", "LICENSE", "README.md"]);
    expect(readFileSync(join(proj, "README.md"), "utf-8")).toBe(README);
    expect(readFileSync(join(proj, "LICENSE"), "utf-8")).toBe("MIT\n");
  });

  test("git: the build committed its own README; the command names the commit that holds the person's", () => {
    const proj = atBuild({ git: true, brought: { "README.md": README } });
    const theirs = git(proj, ["rev-parse", "--short", "HEAD"]).trim();
    write(proj, { "README.md": "# The app's own\n" });
    git(proj, ["commit", "-qam", "the build"]);
    expect(said(openGate(proj))).toContain(`To put it back, run \`git checkout ${theirs} -- README.md\`.`);
  });

  test("git: a file the person never committed has no committed copy, said beside the one that has", () => {
    const proj = atBuild({ git: true, brought: { "README.md": README, "NOTES.md": "my notes\n" }, uncommitted: ["NOTES.md"] });
    write(proj, { "README.md": "# Replaced\n", "NOTES.md": "the build's notes\n" });
    expect(said(openGate(proj))).toContain(
      "The build changed NOTES.md and README.md, files you had before this work started. " +
        "To put README.md back, run `git checkout HEAD -- README.md`; NOTES.md has no committed copy to put back.",
    );
  });

  test("brownfield: the code the work changes is not named; the README it replaced is", () => {
    const proj = atBuild({
      type: "Brownfield",
      git: true,
      brought: { "README.md": README, "src/app.ts": "export const app = 1;\n", "package.json": "{}\n", ".env": "KEY=1\n" },
    });
    write(proj, { "README.md": "# Replaced\n", "src/app.ts": "export const app = 2;\n", "package.json": "{\"x\":1}\n" });
    const line = said(openGate(proj));
    expect(line).toContain("The build changed README.md, a file you had before this work started. " +
      "To put it back, run `git checkout HEAD -- README.md`.");
    expect(line).not.toContain("src/app.ts");
    expect(line).not.toContain("package.json");
  });

  test("brownfield: a Dockerfile and a YAML config are read as code by name and not named, as the guide says", () => {
    const proj = atBuild({
      type: "Brownfield",
      git: true,
      brought: { "README.md": README, Dockerfile: "FROM node:20\n", "config.yaml": "port: 3000\n" },
    });
    write(proj, { "README.md": "# Replaced\n", Dockerfile: "FROM node:22\n", "config.yaml": "port: 8080\n" });
    const line = said(openGate(proj));
    expect(line).toContain("The build changed README.md, a file you had before this work started.");
    expect(line).not.toContain("Dockerfile");
    expect(line).not.toContain("config.yaml");
  });

  test("the person's AGENTS.md rewritten by the build is named", () => {
    const proj = atBuild({ brought: { "AGENTS.md": "# Our team's rules\n" } });
    write(proj, { "AGENTS.md": "# Generated\n" });
    expect(said(openGate(proj))).toContain("The build changed AGENTS.md, a file you had before this work started.");
  });

  test("control: files the work or a teammate added after the work started, then changed, and new files: nothing", () => {
    const proj = atBuild({ brought: { "README.md": README }, later: { "CONTRIBUTING.md": "a teammate's\n", "docs/notes.md": "an earlier attempt's\n" } });
    write(proj, { "CONTRIBUTING.md": "changed\n", "docs/notes.md": "changed\n", "docs/new.md": "new\n" });
    expect(said(openGate(proj))).not.toContain("you had before this work started");
  });

  test("control: a build that leaves the person's files alone says nothing about them", () => {
    const proj = atBuild({ brought: { "README.md": README, LICENSE: "MIT\n" } });
    expect(said(openGate(proj))).not.toContain("you had before this work started");
  });

  test("control: no listing of the work's start on this machine (a teammate's clone): nothing", () => {
    const proj = atBuild({ brought: { "README.md": README }, later: { "CONTRIBUTING.md": "a teammate's\n" } });
    const dir = join(seededRecordDir(proj), ".aidlc-engine", "source-review", "code-generation");
    const audit = readdirSync(join(seededRecordDir(proj), "audit")).map((name) => readFileSync(join(seededRecordDir(proj), "audit", name), "utf-8")).join("\n");
    const started = /WORKFLOW_STARTED[\s\S]*?\*\*Source Baseline\*\*: (\S+)/.exec(audit)?.[1] ?? "";
    const hash = /([0-9a-f]{64})$/.exec(started)?.[1] ?? "";
    expect(hash, started).not.toBe("");
    unlinkSync(join(dir, `baseline-${hash.slice(0, 12)}.tsv`));
    write(proj, { "README.md": "# Replaced\n" });
    expect(said(openGate(proj))).not.toContain("you had before this work started");
  });

  test("once: the gate shown again in the same chat, or after a revision, does not repeat it; a new chat hears it once", () => {
    const proj = atBuild({ brought: { "README.md": README } });
    write(proj, { "README.md": "# Replaced\n" });
    const line = "The build changed README.md, a file you had before this work started.";
    expect(said(openGate(proj))).toContain(line);
    // The Stop hook's own read of the next step is not the person hearing it.
    // A second chat opens on the work: the person types there.
    expect(reply(proj, "/aidlc", CHAT_B).status).toBe(0);
    next(proj, chat(CHAT_B, { AIDLC_STOP_HOOK_PROBE: "1" }));
    expect(said(next(proj))).not.toContain(line);
    expect(said(next(proj, chat(CHAT_B)))).toContain(line);
    expect(said(next(proj, chat(CHAT_B)))).not.toContain(line);
    const env = chat(CHAT_A, { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" });
    report(proj, "rejected", env, " --user-input 'Request Changes' --reason 'rename the handler'");
    write(proj, { "src/slugify.ts": "export const slugify = (title: string) => title;\n" });
    reviewed(proj, 1, env);
    expect(said(report(proj, "revised", env))).not.toContain(line);
  });

  test("a redo of Code Generation that replaces the README again says it again, once", () => {
    const proj = atBuild({ brought: { "README.md": README } });
    write(proj, { "README.md": "# Replaced\n" });
    const line = "The build changed README.md, a file you had before this work started.";
    expect(said(openGate(proj))).toContain(line);
    // The person had it put back, and the build starts again over their files.
    write(proj, { "README.md": README });
    appendAuditEntry("STAGE_JUMPED", {
      "From stage": "code-generation", "To stage": "code-generation", Direction: "BACKWARD",
      ...sourceBaselineAuditFields(proj, "code-generation"),
    }, proj);
    appendAuditEntry("STAGE_STARTED", { Stage: "code-generation", ...sourceBaselineAuditFields(proj, "code-generation") }, proj);
    write(proj, { "README.md": "# Replaced\n" });
    expect(said(openGate(proj))).toContain(line);
  });

  test("more than ten: deleted and top-level files first, ten by name, and the command covers every one git holds", () => {
    const brought: Record<string, string> = { "README.md": README, LICENSE: "MIT\n" };
    for (let i = 1; i <= 11; i++) brought[`docs/page-${String(i).padStart(2, "0")}.md`] = `page ${i}\n`;
    const proj = atBuild({ git: true, brought });
    unlinkSync(join(proj, "LICENSE"));
    write(proj, Object.fromEntries(Object.keys(brought).filter((path) => path !== "LICENSE").map((path) => [path, "# Replaced\n"])));
    const line = said(openGate(proj));
    expect(line).toContain(
      "The build changed or deleted 13 files you had before this work started: LICENSE, README.md, docs/page-01.md, " +
        "docs/page-02.md, docs/page-03.md, docs/page-04.md, docs/page-05.md, docs/page-06.md, docs/page-07.md, " +
        "docs/page-08.md and 3 more. To put them back, run `git checkout HEAD -- LICENSE README.md docs/page-01.md",
    );
    expect(line).toContain("docs/page-11.md`.");
  });

  test("git: a committed file over a megabyte is put back by the command too", () => {
    const big = `${"a line of the person's notes\n".repeat(60_000)}`;
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const proj = atBuild({ git: true, brought: { "docs/notes.md": big } });
    write(proj, { "docs/notes.md": "# Replaced\n" });
    expect(said(openGate(proj))).toContain("To put it back, run `git checkout HEAD -- docs/notes.md`.");
  });

  test("git: a path no shell quoting passes to git as that one file is named as held by git, with no command", () => {
    const proj = atBuild({ git: true, brought: { "docs/[draft] plan.md": "draft\n" } });
    write(proj, { "docs/[draft] plan.md": "# Replaced\n" });
    const line = said(openGate(proj));
    expect(line).toContain("The build changed docs/[draft] plan.md, a file you had before this work started. Git holds docs/[draft] plan.md.");
    expect(line).not.toContain("git checkout");
  });

  test("git: a listing taken over CRLF bytes still finds the committed copy", () => {
    const crlf = "# React Todo App\r\n\r\nA simple todo application.\r\n";
    const before = process.env.AIDLC_TEST_RAW_LINE_ENDINGS;
    process.env.AIDLC_TEST_RAW_LINE_ENDINGS = "1";
    let proj: string;
    try {
      proj = atBuild({ git: true, brought: { "README.md": crlf } });
    } finally {
      if (before === undefined) delete process.env.AIDLC_TEST_RAW_LINE_ENDINGS;
      else process.env.AIDLC_TEST_RAW_LINE_ENDINGS = before;
    }
    write(proj, { "README.md": "# Replaced\n" });
    expect(said(openGate(proj))).toContain("To put it back, run `git checkout HEAD -- README.md`.");
  });

  test("more than ten, the build committed its own: the line names only what it looked up", () => {
    const brought: Record<string, string> = { "NOTES.md": "my notes\n" };
    for (let i = 1; i <= 12; i++) brought[`docs/page-${String(i).padStart(2, "0")}.md`] = `page ${i}\n`;
    const proj = atBuild({ git: true, brought, uncommitted: ["NOTES.md"] });
    const theirs = git(proj, ["rev-parse", "--short", "HEAD"]).trim();
    write(proj, Object.fromEntries(Object.keys(brought).map((path) => [path, "# Replaced\n"])));
    git(proj, ["add", "-A", "--", "docs"]);
    git(proj, ["commit", "-qm", "the build"]);
    const line = said(openGate(proj));
    expect(line).toContain("The build changed or deleted 13 files you had before this work started: NOTES.md, docs/page-01.md,");
    expect(line).toContain(`To put back the ones found in git, run \`git checkout ${theirs} -- docs/page-01.md`);
    expect(line).toContain("; NOTES.md has no committed copy to put back.");
    expect(line).not.toContain("the others");
  });

  test("a path with a space is quoted the way every shell reads it", () => {
    const proj = atBuild({ git: true, brought: { "docs/how to run.md": "steps\n" } });
    write(proj, { "docs/how to run.md": "# Replaced\n" });
    expect(said(openGate(proj))).toContain('To put it back, run `git checkout HEAD -- "docs/how to run.md"`.');
  });
});

// Construction Checkpoints (feature and the other scopes with Units Generation):
// each Unit's checkpoint approves its build, and the stage gate the engine
// settles after them is bookkeeping. The t-approval-says-what-was-left-out
// fixture: one solo intent in Construction, Units alpha and beta.
const UNIT_STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

function checkpointProject(review: "none" | "advisory" = "none"): string {
  const p = createTestProject();
  created.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Changed files
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
- **Review Override**: ${review}
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${UNIT_STAGES.map((stage) => review === "advisory"
    ? stage === "code-generation" ? `- [-] ${stage} \u2014 EXECUTE` : `- [S] ${stage} \u2014 SKIP`
    : stage === "functional-design" ? `- [-] ${stage} \u2014 EXECUTE` : `- [ ] ${stage} \u2014 EXECUTE`).join("\n")}
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${review === "advisory" ? "code-generation" : "functional-design"}
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  write(p, { "README.md": README, "src/alpha.ts": "export const alpha = 1;\n", "src/beta.ts": "export const beta = 1;\n" });
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature", ...sourceBaselineAuditFields(p, workspaceBaselineStageSlugs()) }, p);
  return p;
}

// Each stage's outputs for a Unit, with its completion receipt.
function cover(p: string, unit: string, stages: readonly string[] = UNIT_STAGES) {
  for (const slug of stages) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) {
      const body = slug === "code-generation" && name === "traceability"
        ? JSON.stringify({ stage: slug, unit, upstream_ids: ["AC1.1.1"], coverage: [{ id: "AC1.1.1", status: "OK", target: `src/${unit}.ts` }] }, null, 2)
        : `# ${unit} ${name}\n`;
      writeFileSync(join(output, artifactFilename(name)), body);
    }
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({ stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }] }));
    }
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
      "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true })!,
    }, p);
  }
}

function tool(p: string, name: string, args: string[], env: NodeJS.ProcessEnv = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" }) {
  const result = spawnSync(process.execPath, [join(AIDLC_SRC, `tools/aidlc-${name}.ts`), ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
}

// The person's recorded check for every Unit, as the checkpoint asks for it.
function recordCommand(p: string) {
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "process.exit(0);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", CHAT_A];
  tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]);
  expect(reply(p, "Approve", CHAT_A).status).toBe(0);
  tool(p, "log", ["answer", ...identity, "--details", "Approve"]);
  tool(p, "state", ["set-construction-verification-command", command]);
}

function askCheckpoint(p: string, unit: string): Record<string, unknown> {
  const verified = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", "verify"]);
  expect(verified.verified, JSON.stringify(verified)).toBe(true);
  expect(JSON.stringify(verified)).not.toContain("you had before this work started");
  return tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", "unit", "--action", "ask", "--session", CHAT_A]);
}

describe("t-gate-says-replaced-files at a Unit checkpoint", () => {
  test("the Unit's checkpoint says it once, beside the question; the next Unit's and the settled stage gate do not", () => {
    const p = checkpointProject();
    recordCommand(p);
    cover(p, "alpha");
    write(p, { "README.md": "# The app's own\n" });
    expect((next(p) as { construction_checkpoint?: { unit: string } }).construction_checkpoint?.unit).toBe("alpha");
    const alpha = askCheckpoint(p, "alpha");
    expect(alpha.changed_files, JSON.stringify(alpha)).toBe(
      "The build changed README.md, a file you had before this work started. There is no committed copy to put back.",
    );
    expect(reply(p, "Approve", CHAT_A).status).toBe(0);
    const approved = tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "approve", "--session", CHAT_A, "--user-input", "Approve"]);
    expect(approved.approved, JSON.stringify(approved)).toBe(true);
    cover(p, "beta");
    const steps: unknown[] = [next(p)];
    const beta = askCheckpoint(p, "beta");
    expect(beta.changed_files, JSON.stringify(beta)).toBeUndefined();
    expect(reply(p, "Approve", CHAT_A).status).toBe(0);
    steps.push(tool(p, "bolt", ["checkpoint", "--unit", "beta", "--kind", "unit", "--action", "approve", "--session", CHAT_A, "--user-input", "Approve"]));
    // The stage gates the engine settles after the last Unit say nothing of it.
    const after = next(p);
    expect(after.stage, JSON.stringify(after).slice(0, 400)).toBe("build-and-test");
    steps.push(after);
    for (const step of steps) expect(JSON.stringify(step)).not.toContain("you had before this work started");
  });
  test("the person answered while the Unit's review ran: the question is not shown, and the line rides the next step", () => {
    // Code Generation the only Construction step, so alpha's checkpoint is that step's.
    const p = checkpointProject("advisory");
    recordCommand(p);
    cover(p, "alpha", ["code-generation"]);
    write(p, { "README.md": "# The app's own\n" });
    expect((next(p) as { construction_checkpoint?: { unit: string } }).construction_checkpoint?.unit).toBe("alpha");
    const review = ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", "alpha", "--iteration", "1"];
    const requested = tool(p, "log", review);
    expect(reply(p, "approve it as it is", CHAT_A).status).toBe(0);
    const file = join(p, String(requested.reviewFile));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
    tool(p, "log", [...review, "--verdict", "READY"]);
    const asked = askCheckpoint(p, "alpha");
    expect(asked.earlier_reply, JSON.stringify(asked)).toBe("approve it as it is");
    expect(asked.changed_files).toBeUndefined();
    const approved = tool(p, "bolt", ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", "approve", "--session", CHAT_A, "--user-input", "approve it as it is"]);
    expect(approved.approved, JSON.stringify(approved)).toBe(true);
    const following = next(p);
    const told = (step: Record<string, unknown>): string =>
      `${Array.isArray(step.change_notices) ? step.change_notices.join(" ") : ""} ${String(step.narration ?? "")}`;
    expect(following.change_notices, JSON.stringify(following).slice(0, 600)).toContain(
      "The build changed README.md, a file you had before this work started. There is no committed copy to put back.",
    );
    expect(String(following.narration ?? "")).not.toContain("you had before this work started");
    expect(told(next(p))).not.toContain("you had before this work started");
  });
});
