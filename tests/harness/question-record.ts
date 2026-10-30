// Fixtures for the question-record tests (t-question-record-every-ask,
// t-question-record-older-reader): the engine run as the agent runs it in a
// named chat, the person's turns through the human-turn hook, and the projects
// each kind of ask is asked in. Each project builder pushes its folder on the
// caller's list, which cleans it up.
import { NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "./test-budget.ts";
import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename,
  auditBlockField,
  findStageBySlug,
  latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents,
  reviewArtifactFingerprint,
  setGuardPolicyLine,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { renderTestingContract, resolveTestingPosture } from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  AIDLC_SRC,
  createOrchestrationTestProject,
  createTestProject,
  FIXTURES_DIR,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
  setupIntegrationProject,
} from "./fixtures.ts";

export const BUN = process.execPath;
export const A = "01995000-7a11-7000-8000-00000000a001";
export const B = "01995000-7a11-7000-8000-00000000b002";
export const C = "01995000-7a11-7000-8000-00000000c003";
export const D = "01995000-7a11-7000-8000-00000000d004";
// The state file's separator between a stage slug and its action.
const DASH = "\u2014";

// The engine as the agent runs it in `chat`, through the project's own install.
function base(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIDLC_ALLOW_DIRECT_STATE_TRANSITIONS: "1",
    AIDLC_SKIP_ARTIFACT_GUARD: "1",
    AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
    AIDLC_UNATTENDED: "0",
  };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_STOP_HOOK_PROBE;
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  return env;
}

// Any exit: what a refusal prints is part of the outcome.
export function run(proj: string, chat: string | null, args: string[], input?: string) {
  const env = { ...base(), CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj };
  if (chat !== null) Object.assign(env, { AIDLC_SESSION_OVERRIDE: chat, AIDLC_SESSION_OVERRIDE_SOURCE: "payload" });
  const result = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc.ts"), ...args], {
    cwd: proj, input, encoding: "utf-8", env, timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return { status: result.status, stdout: result.stdout ?? "", out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** The step's JSON line, for a command that must succeed. */
export function engine(proj: string, chat: string | null, args: string[], input?: string) {
  const result = run(proj, chat, args, input);
  expect(result.status, result.out).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}") as Record<string, unknown>;
}

export const step = (proj: string, chat: string | null, args: string[]) => engine(proj, chat, ["engine", "orchestrate", ...args]);

// A tool run with --project-dir, as the agent runs it.
export function tool(proj: string, chat: string | null, name: string, args: string[]) {
  return engine(proj, chat, ["engine", name, ...args, "--project-dir", proj]);
}

// The person's message, as the human-turn hook records it.
export function say(proj: string, chat: string, prompt: string): void {
  engine(proj, null, ["engine", "hook", "record-human-turn"], JSON.stringify({
    hook_event_name: "UserPromptSubmit", session_id: chat, prompt,
  }));
}

export const rows = (proj: string, event: string) => readAuditShardEvents(proj).filter((row) => row.event === event);
export const field = (row: { block: string } | undefined, name: string) => (row ? auditBlockField(row.block, name) : null);
export const lastTurn = (proj: string) => rows(proj, "HUMAN_TURN").at(-1);
export const openIn = (proj: string): string[] => (field(lastTurn(proj), "Open Questions") ?? "").split(", ").filter(Boolean);

export const STAGE = "requirements-analysis";
export const REVIEWER = "aidlc-product-lead-agent";

export function inception(projects: string[]): string {
  const proj = setupIntegrationProject({ withState: "state-mid-inception.md", stripEnvScope: true });
  projects.push(proj);
  const statePath = seededStateFile(proj);
  writeFileSync(statePath, setGuardPolicyLine(readFileSync(statePath, "utf-8"), "relaxed (set by you)"));
  return proj;
}

// The stage's outputs and one READY review, as a real run records them.
export function reviewedStage(proj: string): void {
  const dir = join(seededRecordDir(proj), "inception", STAGE);
  mkdirSync(dir, { recursive: true });
  for (const name of ["requirements.md", `${STAGE}-questions.md`]) {
    if (!existsSync(join(dir, name))) writeFileSync(join(dir, name), `# ${name}\n`);
  }
  const review = ["log", "review", "--stage", STAGE, "--reviewer", REVIEWER, "--iteration", "1"];
  engine(proj, A, ["engine", ...review]);
  appendFileSync(join(dir, "requirements.md"),
    `\n## Review\n\n**Verdict:** READY\n**Reviewer:** ${REVIEWER}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`);
  engine(proj, A, ["engine", ...review, "--verdict", "READY"]);
}

export const CONSTRUCTION = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];

// Two Units built one at a time, checkpoints on, alpha built.
export function built(projects: string[]): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: question record
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: unit-major
- **Unit Ownership**: solo
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
${CONSTRUCTION.map((stage) => `- [${stage === "functional-design" ? "-" : " "}] ${stage} ${DASH} EXECUTE`).join("\n")}
- [ ] build-and-test ${DASH} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  for (const slug of CONSTRUCTION) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(p), "construction", "alpha", slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# alpha ${name}\n`);
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({
        stage: slug, unit: "alpha", version: 1, writes: [{ path: "src/alpha.ts" }],
      }));
    }
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: "alpha", Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, "alpha"),
      "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, "alpha", { requireRequiredArtifacts: true })!,
    }, p);
  }
  return p;
}

export function shellQuote(value: string): string {
  return process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
}

// A feature plan that has just entered Construction with two Units and nobody
// asked who builds them: the first step is the engine's own question.
export function staffing(projects: string[]): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: question record
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8

## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Checkpoints**: enabled
- **Construction Iteration**: unit-major
- **Construction Execution**: serial

## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] units-generation ${DASH} EXECUTE
- [x] delivery-planning ${DASH} EXECUTE

### CONSTRUCTION PHASE
- [-] functional-design ${DASH} EXECUTE
- [ ] nfr-requirements ${DASH} EXECUTE
- [ ] nfr-design ${DASH} EXECUTE
- [ ] infrastructure-design ${DASH} EXECUTE
- [ ] code-generation ${DASH} EXECUTE
- [ ] build-and-test ${DASH} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(proj, ["alpha", "beta"]);
  return proj;
}

export function codeGeneration(projects: string[]): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  const state = readFileSync(join(FIXTURES_DIR, "state-brownfield-feature.md"), "utf-8")
    .replace("- **Scope**: feature", "- **Scope**: poc")
    .replace("- **Change Control**: strict (from scope feature)",
      "- **Guard Policy**: relaxed (from scope poc)\n- **Plan Approval**: on (set by you)")
    .replace(/^- \*\*Current Stage\*\*:.*$/m, "- **Current Stage**: code-generation");
  writeFileSync(seededStateFile(proj), state, "utf-8");
  mkdirSync(join(proj, "src"), { recursive: true });
  writeFileSync(join(proj, "src", "base.ts"), "export const base = true;\n", "utf-8");
  const dir = join(seededRecordDir(proj), "construction", "code-generation");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Summary\n\n- Builds: slugify for titles\n- Touches: src/slugify.ts\n" +
      `- Tests: 3 unit tests\n\n## Steps\n\n- [ ] Step 1: write slugify\n\n${renderTestingContract(resolveTestingPosture(proj))}`);
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun `bun test src/slugify.test.ts`.\n");
  return proj;
}
