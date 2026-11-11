// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-state:unit, subcommand:aidlc-log:answer
//
// Units built one at a time with the walking skeleton on: a Unit set aside for
// another that is now in progress is not put ahead of it while the skeleton's
// approval is not current. The Unit in progress gets its own step, its plan
// question and its recorded answer; the set-aside Unit is offered again once
// the one it waits for is done, as when the skeleton is approved.
//
// Driven through the shipped tools; the stage documents and completion rows
// are written the way t342's helpers write them.

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
import { codeGenerationRecordDir, renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  artifactFilename, findStageBySlug, latestMainWorkflowStageRunFloorForProject, reviewArtifactFingerprint,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

process.env.AIDLC_DISABLE_SENSORS = "1";
setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const SESSION = "t-set-aside";

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

type Directive = Record<string, unknown> & {
  kind: string; stage?: string; unit?: string; ask_type?: string; message?: string;
  construction_checkpoint?: { kind: string; unit: string };
  plan_approval?: { status?: string };
};

function fixture(units: readonly string[] = ["alpha", "beta"]): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: A Unit set aside for another
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
- **Unit Ownership**: solo
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: on
- **Construction Iteration**: unit-major
- **Construction Checkpoints**: enabled
- **Construction Execution**: serial
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
${STAGES.map((slug) => `- [${slug === "functional-design" ? "-" : " "}] ${slug} \u2014 EXECUTE`).join("\n")}
- [ ] build-and-test \u2014 EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(p, [...units]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of units) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  return p;
}

function tool(p: string, name: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync(BUN, [join(AIDLC_SRC, "tools", `aidlc-${name}.ts`), ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env,
  });
  return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
}

function personSays(p: string, prompt: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: p, CLAUDE_PROJECT_DIR: p, AIDLC_UNATTENDED: "0" };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const r = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: p, encoding: "utf-8", env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: p, prompt }),
  });
  expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
}

function next(p: string, args: string[] = []): Directive {
  const r = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), p, args, { env: process.env });
  expect(r.directive, r.stderr).not.toBeNull();
  return r.directive as Directive;
}

// The Unit's stage documents, and its completion rows when `receipts`, as the
// stage writes them.
function cover(p: string, unit: string, slugs = STAGES, receipts = true): void {
  for (const slug of slugs) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`);
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
        stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
      }));
    }
    if (!receipts) continue;
    const fingerprint = reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true });
    expect(fingerprint).not.toBeNull();
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
      "Artifact Fingerprint": fingerprint!,
    }, p);
  }
}

// The verification command, approved by the person once.
function recordCommand(p: string): void {
  if (readFileSync(seededStateFile(p), "utf-8").includes("- **Construction Verification Command**:")) return;
  const script = join(seededRecordDir(p), "check.cjs");
  writeFileSync(script, "process.exit(0);");
  const quote = (value: string) => process.platform === "win32"
    ? `"${value.replaceAll('"', '""')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(BUN)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", SESSION];
  const env = { ...process.env, AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  const asked = tool(p, "log", ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], env);
  expect(asked.status, asked.out).toBe(0);
  personSays(p, "Approve");
  for (const [name, args] of [["log", ["answer", ...identity, "--details", "Approve"]], ["state", ["set-construction-verification-command", command]]] as const) {
    const ran = tool(p, name, [...args], env);
    expect(ran.status, ran.out).toBe(0);
  }
}

// The Unit's checkpoint, verified and approved by the person.
function approve(p: string, unit: string, kind: "unit" | "skeleton"): void {
  recordCommand(p);
  const checkpoint = (args: string[]) => {
    const r = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", kind, ...args]);
    expect(r.status, r.out).toBe(0);
    return JSON.parse(r.stdout);
  };
  expect(checkpoint(["--action", "verify"]).verified).toBe(true);
  checkpoint(["--action", "ask", "--session", SESSION]);
  personSays(p, "Approve");
  expect(checkpoint(["--action", "approve", "--session", SESSION, "--user-input", "Approve"]).approved).toBe(true);
}

function approved(p: string, unit: string, kind: "unit" | "skeleton"): boolean {
  const r = tool(p, "bolt", ["checkpoint", "--unit", unit, "--kind", kind, "--action", "status"]);
  expect(r.status, r.out).toBe(0);
  return JSON.parse(r.stdout).approved;
}

function started(p: string, unit: string): void {
  const r = tool(p, "state", ["unit", "start", "--stage", "code-generation", "--unit", unit]);
  expect(r.status, r.out).toBe(0);
}

// Runs, in order, every engine command the print names before it says what
// to tell the person, and returns the message.
function runPrinted(p: string, args: string[]): string {
  const printed = JSON.parse(tool(p, "orchestrate", ["next", ...args]).stdout) as Directive;
  expect(printed.kind, JSON.stringify(printed)).toBe("print");
  const steps = String(printed.message).split("then tell the person")[0];
  for (const [, name, rest] of steps.matchAll(/`[^`]*aidlc-(\w+)\.ts ([^`]+)`/g)) {
    const argv = [...rest.matchAll(/'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2]);
    const ran = tool(p, name, argv);
    expect(ran.status, ran.out).toBe(0);
  }
  return String(printed.message);
}

// The Unit's code plan, written and asked; the person approves it in their
// own words and the agent records that.
function planApproved(p: string, unit: string): void {
  const dir = codeGenerationRecordDir(p, unit);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: one part\n- Touches: src/\n- Tests: 1 unit test\n\n" +
    `## Steps\n\n- [ ] Step 1: build \`src/${unit}.ts\`\n\n${renderTestingContract(resolveTestingPosture(p))}`);
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test`.\n");
  const asked = next(p);
  expect(asked, JSON.stringify(asked)).toMatchObject({ kind: "ask", ask_type: "plan-approval", unit });
  personSays(p, "approve");
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_UNATTENDED: "0" };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  const recorded = tool(p, "log", [
    "answer", "--stage", "code-generation", "--unit", unit, "--checkpoint", "plan-approval",
    "--details", "Approve Plan", "--session", SESSION,
  ], env);
  expect(recorded.status, recorded.out).toBe(0);
  expect(next(p).plan_approval).toEqual({ status: "approved" });
}

// alpha, the walking skeleton, is built and approved; beta has its design and
// is building its code. The person asks to redo alpha's code, then goes back
// to beta: alpha is set aside for beta, and its skeleton approval is retired.
function backToBetaDuringSkeletonRedo(): string {
  const p = fixture();
  cover(p, "alpha");
  approve(p, "alpha", "skeleton");
  cover(p, "beta", STAGES.slice(0, 4));
  expect(next(p)).toMatchObject({ stage: "code-generation", unit: "beta" });
  started(p, "beta");
  expect(runPrinted(p, ["--stage", "code-generation", "--unit", "alpha"])).toContain("aidlc-jump.ts reopen ");
  expect(next(p)).toMatchObject({ stage: "code-generation", unit: "alpha" });
  started(p, "alpha");
  expect(runPrinted(p, ["--stage", "code-generation", "--unit", "beta"]))
    .toContain("Paused unit alpha at Code Generation and picked unit beta up at Code Generation.");
  expect(approved(p, "alpha", "skeleton")).toBe(false);
  return p;
}

// The issue's shape: alpha, the skeleton, and beta are built and approved;
// gamma is building its code. The person reopens beta's code, so gamma is set
// aside for beta, and then a file alpha's approval covers changes, so the
// skeleton's approval is no longer current.
function betaReopenedThenSkeletonChanged(): string {
  const p = fixture(["alpha", "beta", "gamma"]);
  cover(p, "alpha");
  approve(p, "alpha", "skeleton");
  cover(p, "beta");
  approve(p, "beta", "unit");
  cover(p, "gamma", STAGES.slice(0, 4));
  expect(next(p)).toMatchObject({ stage: "code-generation", unit: "gamma" });
  started(p, "gamma");
  expect(runPrinted(p, ["--stage", "code-generation", "--unit", "beta"])).toContain("Paused unit gamma at Code Generation");
  expect(next(p)).toMatchObject({ stage: "code-generation", unit: "beta" });
  started(p, "beta");
  writeFileSync(join(p, "src", "alpha.ts"), "export const alpha = 2;\n");
  expect(approved(p, "alpha", "skeleton")).toBe(false);
  return p;
}

describe("a Unit set aside for the one in progress, while the skeleton is not approved", () => {
  for (const [name, setUp, inProgress, setAside] of [
    ["the person redoes the skeleton's code, then goes back to beta", backToBetaDuringSkeletonRedo, "beta", "alpha"],
    ["gamma is set aside for beta, then the skeleton's approved files change", betaReopenedThenSkeletonChanged, "beta", "gamma"],
  ] as const) {
    test(`${name}: ${inProgress} is next, by itself and by name, and its plan approval records`, () => {
      const p = setUp();
      const step = next(p);
      expect(step, JSON.stringify(step)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: inProgress });
      const named = next(p, ["--stage", "code-generation", "--unit", inProgress]);
      expect(named, JSON.stringify(named)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: inProgress });
      planApproved(p, inProgress);
      expect(next(p)).not.toMatchObject({ ask_type: "unit-paused", unit: setAside });
    });
  }

  test("going back and forth twice lands on the Unit named each time, and beta's plan approval records", () => {
    const p = backToBetaDuringSkeletonRedo();
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "beta" });
    for (const [to, from] of [["alpha", "beta"], ["beta", "alpha"], ["alpha", "beta"], ["beta", "alpha"]]) {
      expect(runPrinted(p, ["--stage", "code-generation", "--unit", to]))
        .toContain(`Paused unit ${from} at Code Generation and picked unit ${to} up at Code Generation.`);
      const step = next(p);
      expect(step, `${from} to ${to}: ${JSON.stringify(step)}`).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: to });
    }
    planApproved(p, "beta");
  });

  test("beta parked: its own pause is asked, as with the skeleton approved, and alpha is picked up by name", () => {
    const p = backToBetaDuringSkeletonRedo();
    const paused = tool(p, "state", [
      "unit", "pause", "--stage", "code-generation", "--unit", "beta",
      "--reason", "waiting for the API key", "--next-action", "Continue Code Generation for unit beta.",
    ]);
    expect(paused.status, paused.out).toBe(0);
    expect(next(p)).toMatchObject({ kind: "ask", ask_type: "unit-paused", unit: "beta", stage: "code-generation" });
    expect(runPrinted(p, ["--stage", "code-generation", "--unit", "alpha"])).toContain("picked unit alpha up at Code Generation.");
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
  });

  test("the work parked and picked up again comes back to beta's step", () => {
    const p = backToBetaDuringSkeletonRedo();
    const parked = tool(p, "orchestrate", ["park"]);
    expect(parked.status, parked.out).toBe(0);
    expect(next(p).kind).toBe("parked");
    const unparked = tool(p, "state", ["unpark"]);
    expect(unparked.status, unparked.out).toBe(0);
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "beta" });
  });

  test("once beta's step is done and approved, alpha is offered again and picks up where it stopped", () => {
    const p = backToBetaDuringSkeletonRedo();
    cover(p, "beta", ["code-generation"], false);
    planApproved(p, "beta");
    const completed = tool(p, "state", ["unit", "complete", "--stage", "code-generation", "--unit", "beta"]);
    expect(completed.status, completed.out).toBe(0);
    expect(next(p).construction_checkpoint).toMatchObject({ kind: "unit", unit: "beta" });
    approve(p, "beta", "unit");
    const ask = next(p);
    expect(ask, JSON.stringify(ask)).toMatchObject({ kind: "ask", ask_type: "unit-paused", unit: "alpha", stage: "code-generation" });
    const resumed = tool(p, "state", ["unit", "resume", "--stage", "code-generation", "--unit", "alpha"]);
    expect(resumed.status, resumed.out).toBe(0);
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "alpha" });
  });

  test("once beta's code is done, the skeleton's changed work is checked again before gamma is offered", () => {
    const p = betaReopenedThenSkeletonChanged();
    cover(p, "beta", ["code-generation"], false);
    planApproved(p, "beta");
    const completed = tool(p, "state", ["unit", "complete", "--stage", "code-generation", "--unit", "beta"]);
    expect(completed.status, completed.out).toBe(0);
    const step = next(p);
    expect(step.construction_checkpoint, JSON.stringify(step)).toMatchObject({ kind: "skeleton", unit: "alpha" });
  });

  test("the skeleton paused with nothing else in progress is still offered", () => {
    const p = fixture();
    cover(p, "alpha", STAGES.slice(0, 4));
    expect(next(p)).toMatchObject({ stage: "code-generation", unit: "alpha" });
    started(p, "alpha");
    const paused = tool(p, "state", [
      "unit", "pause", "--stage", "code-generation", "--unit", "alpha",
      "--reason", "waiting for the API key", "--next-action", "Continue Code Generation for unit alpha.",
    ]);
    expect(paused.status, paused.out).toBe(0);
    expect(next(p)).toMatchObject({ kind: "ask", ask_type: "unit-paused", unit: "alpha", stage: "code-generation" });
  });
});
