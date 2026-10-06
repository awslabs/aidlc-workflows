// covers: subcommand:aidlc-bolt:checkpoint, subcommand:aidlc-log:review
//
// A Unit approved at its checkpoint, then looked at again where something its
// review recorded cannot be checked: the written review is not on this machine
// (a fresh clone, another machine, a clean), the reviewed source snapshot is not
// here and the code was edited since, the Unit's list of files changed after
// its review, or the project source cannot be read. Under Guard Policy relaxed
// and off the review scan already keeps each of these verdicts and says so
// once; the checkpoint keeps the person's approval the same way. Under strict
// nothing changes: the Unit is not approved until it is checked again.
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";
import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AIDLC_SRC, cleanupTestProject, createTestProject, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

resetAidlcEnv();
const projects: string[] = [];
// Programs holding a project file open with no sharing (the Windows case at the end).
const holders: ChildProcess[] = [];
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
afterEach(() => {
  if (holders.length) {
    while (holders.length) holders.pop()!.kill();
    pause(1500);
  }
  while (projects.length) cleanupTestProject(projects.pop());
});
const stages = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const REVIEWER = findStageBySlug("code-generation")!.reviewer!;
// The state file's separator between a stage slug and its action.
const SEPARATOR = "\u2014";
const STRICT = "strict (set by you)";
const ACCEPTING = ["relaxed (set by you)", "off (from scope classic)"];

// Classic, two Units, advisory reviews (one pass per stage), checkpoints on,
// Unit by Unit.
function fixture(policy: string) {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: Construction checkpoints off this machine
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
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", "t-off-machine-command"];
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  const decision = tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], env);
  expect(decision.status, decision.out).toBe(0);
  human(p, "Approve", "t-off-machine-command");
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
  const session = `t-off-machine-${unit}`;
  checkpoint(["--action", "ask", "--session", session]);
  human(p, "Approve", session);
  expect(checkpoint(["--action", "approve", "--session", session, "--user-input", "Approve"]).approved).toBe(true);
}

type Status = {
  approved: boolean;
  errors: string[];
  rereview?: { stage: string; reviewer: string; iteration: number; command: string } | null;
};

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
  const recorded = tool(p, "log", [...args.filter((arg) => arg !== "--retry-pending"), "--verdict", "READY"]);
  expect(recorded.status, recorded.out).toBe(0);
  return join(p, request.reviewFile);
}

// A Unit built as a run records it: each stage's outputs, its review through
// the logger, then its completion. Returns the written review files.
function build(p: string, unit: string): string[] {
  const reviews: string[] = [];
  for (const slug of stages) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) {
      writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
    }
    if (stage.workspace_requires) writeManifest(p, unit, [`src/${unit}.ts`]);
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

// What each case does to the approved Unit alpha.
const cases: Record<string, { what: string; act: (p: string, reviews: string[]) => void }> = {
  "manifest-changed": {
    what: "a file added to alpha's list of files after its review",
    act: (p) => {
      writeFileSync(join(p, "src", "alpha-extra.ts"), "export const extra = 1;\n");
      writeManifest(p, "alpha", ["src/alpha.ts", "src/alpha-extra.ts"]);
    },
  },
  "review-record-absent": {
    what: "the written reviews not on this machine",
    act: (p) => {
      const records = readAuditShardEvents(p)
        .filter((row) => row.event === "REVIEW_COMPLETED" && auditBlockField(row.block, "Unit") === "alpha")
        .map((row) => auditBlockField(row.block, "Review Record"));
      expect(records.length).toBe(stages.length);
      for (const record of records) unlinkSync(join(seededRecordDir(p), record!));
    },
  },
  "snapshot-absent-then-edit": {
    what: "the reviewed source snapshot not on this machine, then alpha's code edited",
    act: (p) => {
      const dir = join(seededRecordDir(p), ".aidlc-engine", "source-review", "code-generation");
      const snapshots = existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith("unit-alpha-")) : [];
      expect(snapshots.length, `no snapshot under ${dir}`).toBeGreaterThan(0);
      for (const name of snapshots) unlinkSync(join(dir, name));
      writeFileSync(join(p, "src", "alpha.ts"), "export const alpha = 2;\n");
    },
  },
  "source-unreadable": {
    what: "the project source not readable here",
    act: (p) => {
      writeFileSync(join(p, ".aidlc-source-paths.json"), `${JSON.stringify({ version: 1, paths: ["../outside"] })}\n`);
    },
  },
};
// A file nobody may read (a locked file) is the same unreadable source, on a
// host where permissions hold for this user.
const LOCKABLE = process.platform !== "win32" && process.getuid?.() !== 0;
if (LOCKABLE) {
  cases["file-locked"] = {
    what: "one of alpha's files not readable here",
    act: (p) => chmodSync(join(p, "src", "alpha.ts"), 0o000),
  };
}

describe("t-checkpoint-off-machine: an approved Unit whose reviewed evidence cannot be checked here", () => {
  for (const [name, { what, act }] of Object.entries(cases)) {
    for (const policy of ACCEPTING) {
      test(`Guard Policy ${policy.split(" ")[0]}, ${what}: alpha stays approved`, () => {
        const p = fixture(policy);
        const reviews = build(p, "alpha");
        approve(p, "alpha");
        act(p, reviews);
        const status = checkpointStatus(p, "alpha");
        expect(status, `${name}: ${JSON.stringify(status)}`).toMatchObject({ approved: true, errors: [] });
        expect(readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED")).toEqual([]);
      }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
    }

    test(`Guard Policy strict, ${what}: alpha is not approved until it is checked again`, () => {
      const p = fixture(STRICT);
      const reviews = build(p, "alpha");
      approve(p, "alpha");
      act(p, reviews);
      const status = checkpointStatus(p, "alpha");
      expect(status.approved, `${name}: ${JSON.stringify(status)}`).toBe(false);
      // What the person and the agent are given next.
      const next = runOrchestrateNext(join(AIDLC_SRC, "tools/aidlc-orchestrate.ts"), p, [], { env: process.env });
      console.log(`t-checkpoint-off-machine strict ${name}: status ${JSON.stringify({ errors: status.errors, rereview: status.rereview })} next ${JSON.stringify(next.directive ?? next.stderr).slice(0, 1500)}`);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  // Strict with the written reviews not on this machine (a teammate's clone):
  // nothing here can check them, so each stage gets the one re-check, a fresh
  // review, and then the person approves the Unit once. Never a refusal that
  // nothing the person or the agent can do clears.
  test("Guard Policy strict, the written reviews not on this machine: a fresh review of each stage, then alpha is approved again", () => {
    const p = fixture(STRICT);
    const reviews = build(p, "alpha");
    approve(p, "alpha");
    cases["review-record-absent"].act(p, reviews);
    const rechecked: string[] = [];
    for (let round = 0; round <= stages.length; round++) {
      const status = checkpointStatus(p, "alpha");
      if (!status.rereview) break;
      rechecked.push(status.rereview.stage);
      reviewThroughLog(p, [
        "review", "--stage", status.rereview.stage, "--reviewer", status.rereview.reviewer,
        "--unit", "alpha", "--iteration", String(status.rereview.iteration),
        ...(status.rereview.command.includes("--retry-pending") ? ["--retry-pending"] : []),
      ]);
    }
    expect(rechecked.length, "no re-check was offered").toBeGreaterThan(0);
    const status = checkpointStatus(p, "alpha");
    expect(status, JSON.stringify(status)).toMatchObject({ errors: [] });
    approve(p, "alpha");
    expect(checkpointStatus(p, "alpha").approved).toBe(true);
    expect(readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED")).toEqual([]);
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

  // Strict holds a Unit whose code no longer matches what its review saw: the
  // code is re-checked once, then the person approves the Unit once, never
  // stuck at a checkpoint nothing can clear.
  for (const name of ["manifest-changed", "snapshot-absent-then-edit"]) {
    const { what, act } = cases[name];
    test(`Guard Policy strict, ${what}: the code is re-checked once, then alpha is approved again`, () => {
      const p = fixture(STRICT);
      const reviews = build(p, "alpha");
      approve(p, "alpha");
      act(p, reviews);
      const status = checkpointStatus(p, "alpha");
      expect(status.rereview?.stage, JSON.stringify(status)).toBe("code-generation");
      reviewThroughLog(p, ["review", "--stage", "code-generation", "--reviewer", REVIEWER, "--unit", "alpha", "--iteration", "2"]);
      approve(p, "alpha");
      expect(checkpointStatus(p, "alpha").approved).toBe(true);
      expect(readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED")).toEqual([]);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});

// A review recorded while the project source could not be read (its binding is
// "unbindable"), with the source readable again when the checkpoint is looked
// at. Relaxed and off keep the review's verdict, so the Unit is approved, or
// stays approved; strict holds it and re-checks the code once.
describe("t-checkpoint-off-machine: a review recorded while the source could not be read", () => {
  const sourcePaths = (p: string) => join(p, ".aidlc-source-paths.json");
  const unreadable = (p: string) =>
    writeFileSync(sourcePaths(p), `${JSON.stringify({ version: 1, paths: ["../outside"] })}\n`);
  const readable = (p: string) => unlinkSync(sourcePaths(p));
  const reviewedUnbindable = (p: string) => {
    const units = readAuditShardEvents(p)
      .filter((row) => row.event === "REVIEW_COMPLETED" && auditBlockField(row.block, "Stage") === "code-generation")
      .map((row) => auditBlockField(row.block, "Unit Source Fingerprint"));
    expect(units).toEqual(["unbindable"]);
  };

  for (const policy of ACCEPTING) {
    test(`Guard Policy ${policy.split(" ")[0]}, source readable again before the first approval: alpha is approved`, () => {
      const p = fixture(policy);
      unreadable(p);
      build(p, "alpha");
      reviewedUnbindable(p);
      readable(p);
      approve(p, "alpha");
      const status = checkpointStatus(p, "alpha");
      expect(status, JSON.stringify(status)).toMatchObject({ approved: true, errors: [] });
      expect(readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED")).toEqual([]);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

    test(`Guard Policy ${policy.split(" ")[0]}, source readable again after the approval: alpha stays approved`, () => {
      const p = fixture(policy);
      unreadable(p);
      build(p, "alpha");
      reviewedUnbindable(p);
      approve(p, "alpha");
      readable(p);
      const status = checkpointStatus(p, "alpha");
      expect(status, JSON.stringify(status)).toMatchObject({ approved: true, errors: [] });
      expect(readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED")).toEqual([]);
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }

  test("Guard Policy strict, source readable again: alpha is not approved and its code is re-checked once", () => {
    const p = fixture(STRICT);
    unreadable(p);
    build(p, "alpha");
    reviewedUnbindable(p);
    readable(p);
    const status = checkpointStatus(p, "alpha");
    expect(status.approved, JSON.stringify(status)).toBe(false);
    expect(status.rereview?.stage, JSON.stringify(status)).toBe("code-generation");
  }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
});

// On Windows another program (an editor, an indexer, a virus scanner) often
// holds a file open with no sharing. AI-DLC still reads it there, so an
// approved Unit stays approved under every Guard Policy. If a runtime upgrade
// stops reading such a file, this fails before a person loses an approval.
describe("t-checkpoint-off-machine: a file another program holds open on Windows", () => {
  for (const policy of [STRICT, ...ACCEPTING]) {
    test.skipIf(process.platform !== "win32")(`Guard Policy ${policy.split(" ")[0]}: alpha stays approved`, () => {
      const p = fixture(policy);
      build(p, "alpha");
      approve(p, "alpha");
      const target = join(p, "src", "alpha.ts");
      // The helper's notes go outside the project, so they never join its source.
      const notes = mkdtempSync(join(tmpdir(), "t-held-"));
      const marker = join(notes, "taken.txt");
      const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const script = `try { $f=[System.IO.File]::Open(${q(target)},'Open','Read','None'); ` +
        `Set-Content -LiteralPath ${q(marker)} -Value 'held'; Start-Sleep -Seconds 300; $f.Close() } ` +
        `catch { Set-Content -LiteralPath ${q(marker)} -Value ('error: ' + $_.Exception.Message) }`;
      const out = openSync(join(notes, "out.txt"), "w");
      holders.push(spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: ["ignore", out, out] }));
      const until = Date.now() + 60_000;
      while (!existsSync(marker)) {
        if (Date.now() > until) {
          throw new Error(`the helper never opened ${target}: ${readFileSync(join(notes, "out.txt"), "utf8").slice(0, 800)}`);
        }
        pause(200);
      }
      pause(300);
      expect(readFileSync(marker, "utf8").trim()).toBe("held");
      const status = checkpointStatus(p, "alpha");
      expect(status, JSON.stringify(status)).toMatchObject({ approved: true, errors: [] });
    }, NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
  }
});
