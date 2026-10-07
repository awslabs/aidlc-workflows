// covers: function:reviewArtifactFingerprint, function:inspectStageValidity, subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-utility:status, subcommand:aidlc-log:review, subcommand:aidlc-swarm:finalize
//
// A Windows teammate clones work begun on Linux or macOS, and Git checks its
// text files out with CRLF line endings (Git for Windows' default). Under Guard
// Policy strict every finished stage then read as changed ("... changed after
// Practices Discovery finished. Do you want me to redo ...?"), and a Unit
// approved before was asked about again; under off `/aidlc --status` named
// every finished stage, and a swarm Unit whose files the agent wrote with CRLF
// could not finalize. A line ending is no change: committed text is hashed
// with CRLF read as LF, so the fingerprints match the ones recorded before,
// under every Guard Policy. Only text Git itself converts is read so: a lone
// CR, or a file Git takes as binary, is still a change. An approval or a
// review recorded over CRLF text before this change (the raw bytes) still
// counts.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { codeGenerationRecordDir } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import { inspectStageValidity, stageValidationAuditFields } from "../../dist/claude/.claude/tools/aidlc-validity.ts";
import {
  cleanupCheckpointFixtures, fixture as swarmFixture, git, ISOLATED_GIT_ENV, prepare, publish, runCheckpointTool,
  STAGE, swarm, writeUnitSource, wt,
} from "../harness/swarm-checkpoint.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
  cleanupCheckpointFixtures();
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
  ISOLATED_GIT_ENV.AIDLC_TEST_RAW_LINE_ENDINGS = "1";
  try {
    return run();
  } finally {
    delete process.env.AIDLC_TEST_RAW_LINE_ENDINGS;
    delete ISOLATED_GIT_ENV.AIDLC_TEST_RAW_LINE_ENDINGS;
  }
}

// The source is read 64 KiB at a time: this file's first line ending falls
// across the first two reads once it is CRLF.
const LONG_SOURCE = `//${"x".repeat(64 * 1024 - 3)}\nexport const alpha = 1;\n`;

// A swarm Unit checked, then its files written with CRLF line endings (as an
// agent on Windows writes them) in a worktree of a CRLF checkout, reviewed
// there, and finalized.
function swarmReviewedOverCrlf(policy: string, raw: boolean) {
  const pd = swarmFixture(["alpha"]);
  if (policy !== "strict") {
    const path = seededStateFile(pd);
    writeFileSync(path, readFileSync(path, "utf-8").replace(/^- \*\*Change Control\*\*: .*$/m, `- **Guard Policy**: ${policy}`));
    publish(pd, ["alpha"]);
  }
  const prepared = prepare(pd);
  expect(prepared.code, `${prepared.out}\n${prepared.err}`).toBe(0);
  writeUnitSource(pd, "alpha", 2);
  const checked = swarm(pd, ["check", "alpha"]);
  expect(checked.code, `${checked.out}\n${checked.err}`).toBe(0);
  const child = wt(pd);
  const dir = codeGenerationRecordDir(child, "alpha");
  writeFileSync(join(dir, "source-manifest.json"), `${JSON.stringify({
    stage: STAGE, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }],
  }, null, 2)}\n`);
  const planPath = join(dir, "code-generation-plan.md");
  writeFileSync(planPath, readFileSync(planPath, "utf-8").replace("- [ ] Implement", "- [x] Implement"));
  for (const path of [join(dir, "source-manifest.json"), planPath, join(child, "src", "alpha.ts")]) {
    writeFileSync(path, readFileSync(path, "utf-8").replace(/\r?\n/g, "\r\n"));
  }
  git(child, ["config", "core.autocrlf", "true"]);
  const args = [
    "review", "--stage", STAGE, "--unit", "alpha", "--reviewer", "aidlc-architecture-reviewer-agent",
    "--iteration", "1", "--project-dir", child,
  ];
  const review = () => {
    const request = runCheckpointTool(child, "tools/aidlc-log.ts", args);
    expect(request.code, `${request.out}\n${request.err}`).toBe(0);
    appendFileSync(planPath, "\r\n## Review\r\n\r\n**Verdict:** READY\r\n**Reviewer:** aidlc-architecture-reviewer-agent\r\n" +
      "**Iteration:** 1\r\n\r\n### Findings\r\n\r\nNo blocking findings.\r\n");
    const receipt = runCheckpointTool(child, "tools/aidlc-log.ts", [...args, "--verdict", "READY"]);
    expect(receipt.code, `${receipt.out}\n${receipt.err}`).toBe(0);
  };
  if (raw) withRawLineEndings(review);
  else review();
  const finalized = swarm(pd, ["finalize", "--batch", "1", "--units", "alpha", "--claimed", "alpha"]);
  const row = (JSON.parse(finalized.out) as { units: Array<{ unit: string; detail?: string; change_notices?: string[] }> })
    .units.find((unit) => unit.unit === "alpha");
  return { finalized, row };
}

describe("t-crlf-clone-keeps-approvals: committed text checked out with CRLF", () => {
  for (const policy of ["strict (set by you)", "off (from scope classic)"]) {
    test(`Guard Policy ${policy.split(" ")[0]}: an approved Unit stays approved, with the same fingerprint`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      approve(p, "alpha");
      const before = checkpointStatus(p, "alpha") as Status & { fingerprint: string };
      expect(before.approved).toBe(true);
      expect(checkOutWithCrlf(p)).toBeGreaterThan(10);
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

    test(`Guard Policy ${policy.split(" ")[0]}: a CRLF across two reads of a source file is one line ending${policy.startsWith("strict") ? "; a lone CR is a change" : ""}`, () => {
      const p = fixture(policy);
      writeFileSync(join(p, "src", "alpha.ts"), LONG_SOURCE);
      build(p, "alpha");
      approve(p, "alpha");
      const before = checkpointStatus(p, "alpha") as Status & { fingerprint: string };
      writeFileSync(join(p, "src", "alpha.ts"), LONG_SOURCE.replaceAll("\n", "\r\n"));
      expect(readFileSync(join(p, "src", "alpha.ts"))[64 * 1024 - 1]).toBe(13);
      const crlf = checkpointStatus(p, "alpha") as Status & { fingerprint: string };
      expect(crlf, JSON.stringify(crlf)).toMatchObject({ approved: true, errors: [], fingerprint: before.fingerprint });
      // Under off a change to approved code keeps the approval and its
      // fingerprint, so a lone CR shows as the change it is under strict.
      if (!policy.startsWith("strict")) return;
      writeFileSync(join(p, "src", "alpha.ts"), LONG_SOURCE.replace("\nexport", "\rexport"));
      const loneCr = checkpointStatus(p, "alpha") as Status & { fingerprint: string };
      expect(loneCr.fingerprint).not.toBe(before.fingerprint);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`Guard Policy ${policy.split(" ")[0]}: a swarm Unit whose files have CRLF line endings finalizes, reviewed before this change or after it`, () => {
      for (const raw of [false, true]) {
        const { finalized, row } = swarmReviewedOverCrlf(policy === "strict (set by you)" ? "strict" : "off (set by you)", raw);
        expect(finalized.code, `${raw ? "raw: " : ""}${row?.detail ?? ""}\n${finalized.out}\n${finalized.err}`).toBe(0);
        expect(row?.change_notices ?? []).toEqual([]);
      }
    }, NATIVE_MULTI_WORKTREE_CASE_TIMEOUT_MS * 2);
  }

  test("a document Git takes as binary, or with a lone CR, keeps its line endings", () => {
    const p = fixture("strict (set by you)");
    const stage = findStageBySlug("functional-design")!;
    const dir = join(seededRecordDir(p), "construction", "alpha", "functional-design");
    mkdirSync(dir, { recursive: true });
    const files = (stage.produces ?? []).map((name) => join(dir, artifactFilename(name)));
    const fingerprint = (body: string) => {
      for (const file of files) writeFileSync(file, body);
      return reviewArtifactFingerprint(p, stage, "alpha", { requireRequiredArtifacts: true });
    };
    // Mostly control bytes: Git leaves such a file as it is at checkout.
    const binary = "\u0001\u0002\u0003\u0004\u0005\u0006\r\n\u0007\u0011\u0012\u0013\r\n";
    expect(fingerprint(binary)).not.toBe(fingerprint(binary.replaceAll("\r\n", "\n")));
    expect(fingerprint("# Design\r\nA lone CR\rhere.\r\n")).not.toBe(fingerprint("# Design\nA lone CR\nhere.\n"));
    expect(fingerprint("# Design\r\nText.\r\n")).toBe(fingerprint("# Design\nText.\n"));
  });
});
