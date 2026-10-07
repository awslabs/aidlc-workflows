// covers: function:reviewArtifactFingerprint, function:inspectStageValidity, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-utility:status
//
// A Windows teammate clones work begun on Linux or macOS, and Git checks its
// text files out with CRLF line endings (Git for Windows' default). Under Guard
// Policy strict every finished stage then read as changed ("... changed after
// Practices Discovery finished. Do you want me to redo ...?"), and a Unit
// approved before was asked about again; under off `/aidlc --status` named
// every finished stage. A line ending is no change: committed text is hashed
// with CRLF and lone CR read as LF, so the fingerprints match the ones
// recorded before, under every Guard Policy. An approval recorded over CRLF
// text before this change (the raw bytes) still counts.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile, seedStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { inspectStageValidity, stageValidationAuditFields } from "../../dist/claude/.claude/tools/aidlc-validity.ts";

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

// Classic, two Units, advisory reviews (one pass per stage), checkpoints on,
// Unit by Unit.
function fixture(policy: string): string {
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
function build(p: string, unit: string, afterWrite: (dir: string) => void = () => {}): string[] {
  const reviews: string[] = [];
  for (const slug of stages) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) {
      writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
    }
    if (stage.workspace_requires) writeManifest(p, unit, [`src/${unit}.ts`]);
    afterWrite(output);
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


// What Git for Windows does at checkout: every committed text file gets CRLF.
// The engine's own working folders are not committed, so a clone has none to
// convert; they are left as this checkout wrote them.
const RUNTIME = new Set([".aidlc-engine", ".aidlc-construction-checkpoints", ".aidlc-sessions", ".git"]);
function checkOutWithCrlf(dir: string): number {
  let converted = 0;
  for (const name of readdirSync(dir)) {
    if (RUNTIME.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      converted += checkOutWithCrlf(path);
      continue;
    }
    if (!/\.(md|json|tsv|ts|cjs|js|yaml|yml|txt)$/.test(name)) continue;
    const text = readFileSync(path, "utf-8");
    if (text.includes("\r") || !text.includes("\n")) continue;
    writeFileSync(path, text.replace(/\n/g, "\r\n"));
    converted++;
  }
  return converted;
}

// Work done on a CRLF checkout before line endings were read as LF recorded
// its fingerprints over the raw bytes; AIDLC_TEST_RAW_LINE_ENDINGS has the
// engine hash them that way while the test builds it.
function withRawLineEndings<T>(run: () => T): T {
  process.env.AIDLC_TEST_RAW_LINE_ENDINGS = "1";
  try {
    return run();
  } finally {
    delete process.env.AIDLC_TEST_RAW_LINE_ENDINGS;
  }
}

describe("t-crlf-clone-keeps-approvals: committed text checked out with CRLF", () => {
  for (const policy of ["strict (set by you)", "off (from scope classic)"]) {
    test(`Guard Policy ${policy.split(" ")[0]}: an approved Unit stays approved, with the same fingerprint`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      approve(p, "alpha");
      const before = checkpointStatus(p, "alpha") as Status & { fingerprint: string };
      expect(before.approved).toBe(true);
      // The record folder: source files are read through Git's own copy, which
      // keeps no line endings of the checkout, and this project has no Git.
      expect(checkOutWithCrlf(join(p, "aidlc"))).toBeGreaterThan(10);
      const after = checkpointStatus(p, "alpha") as Status & { fingerprint: string };
      expect(after, JSON.stringify(after)).toMatchObject({ approved: true, errors: [], fingerprint: before.fingerprint });
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`Guard Policy ${policy.split(" ")[0]}: a finished stage's documents are not changed`, () => {
      const p = createTestProject();
      projects.push(p);
      seedStateFile(p, "state-mid-inception.md");
      const statePath = seededStateFile(p);
      writeFileSync(statePath, readFileSync(statePath, "utf-8")
        .replace("- **Change Control**: strict (from scope bugfix)", `- **Guard Policy**: ${policy.replace("classic", "bugfix")}`)
        .replace(/^- \[.\] requirements-analysis/m, "- [x] requirements-analysis"));
      const dir = join(seededRecordDir(p), "inception", "requirements-analysis");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n- FR-1: a blank title is refused.\n");
      const stage = loadGraph().find((node) => node.slug === "requirements-analysis")!;
      appendAuditEntry("STAGE_COMPLETED", {
        Stage: "requirements-analysis", ...stageValidationAuditFields(p, stage, readFileSync(statePath, "utf-8")),
      }, p);
      expect(checkOutWithCrlf(p)).toBeGreaterThan(1);
      const state = readFileSync(statePath, "utf-8");
      expect(inspectStageValidity(p, state).issues).toEqual([]);
      const status = tool(p, "utility", ["status"]);
      expect(status.out).not.toContain("changed after");
      expect(status.out).not.toContain("finished before something it used changed");
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`Guard Policy ${policy.split(" ")[0]}: a Unit approved on a CRLF checkout before this change stays approved`, () => {
      const p = fixture(policy);
      const before = withRawLineEndings(() => {
        checkOutWithCrlf(p);
        build(p, "alpha", (dir) => checkOutWithCrlf(dir));
        approve(p, "alpha");
        return checkpointStatus(p, "alpha");
      });
      expect(before.approved, JSON.stringify(before)).toBe(true);
      const after = checkpointStatus(p, "alpha");
      expect(after, JSON.stringify(after)).toMatchObject({ approved: true, errors: [] });
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
