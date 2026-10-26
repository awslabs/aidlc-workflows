// covers: function:lifecycleResetRemedies, function:requestChangesReportCommand, subcommand:aidlc-log:answer, hook:aidlc-review-freeze
//
// Units built one at a time under Guard Policy strict: alpha has finished its
// Functional Design and it was reviewed; beta has its design and is building.
// The person asks to change alpha's design, the review freeze stops the edit,
// and the question offers Request Changes or turning the check off. Request
// Changes about alpha sends back alpha's Functional Design only, with the
// person's words as the change: beta keeps its reviewed, finished design. The
// two choices and their labels stay. The Unit still working on the step, a
// stage-by-stage walk and a refusal that names no Unit keep their remedies.
//
// Driven through the shipped tools and the shipped review-freeze hook with a
// real write payload; the review and completion rows are written the way
// t342's helpers write them.

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
  AIDLC_SRC, cleanupTestProject, createTestProject, recordArtifactWriteViaHook, resetAidlcEnv,
  runOrchestrateNext, seedAidlcMemory, seedBoltDag, seededRecordDir, seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, evaluateGuardRefusal, findStageBySlug, freshReviewReceipts, getField,
  GUARD_RECOVERY_ASK_TYPE, latestMainWorkflowStageRunFloorForProject, readAuditShardEvents, reviewArtifactFingerprint,
  stateDigest, unitCompletedReceipts, writeActiveDirectiveMarker,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
const WORDS = "the alpha entities need a status field";
const QUESTION = "Functional Design for alpha can't go ahead as things stand: which way would you like to go on?";
const PLAIN = "Tell me what should change in Functional Design for alpha, and I'll revise it.";
const EVERY_UNIT = "This also throws away every Unit's finished Functional Design work";
const UNIT_CHANGE = "next --stage functional-design --unit alpha --change";
const STAGE_REJECT = "report --stage functional-design --result rejected";
// The person's chat: their turns are recorded, and human presence holds.
const PERSON = {
  AIDLC_SESSION_OVERRIDE: "01995000-7a11-7000-8000-000000001156",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "0",
  AIDLC_UNATTENDED: "0",
};

const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

type Remedy = {
  op: string; label?: string; description?: string; action: string; interaction?: string;
  command?: string; operation?: unknown;
};
type Directive = Record<string, unknown> & { kind: string; stage?: string; unit?: string; remedies?: Remedy[] };

function fixture(options: { iteration?: "unit-major" | "stage-major" } = {}): string {
  const p = createTestProject();
  projects.push(p);
  seedAidlcMemory(p);
  writeFileSync(seededStateFile(p), `# AI-DLC State Tracking
## Project Information
- **Project**: One Unit's Request Changes
- **Project Type**: Greenfield
- **Project Type Source**: you
- **Scope**: feature
- **State Version**: 8
- **Unit Ownership**: solo
## Runtime State
- **Revision Count**: 0
- **Skeleton Stance**: off
- **Construction Iteration**: ${options.iteration ?? "unit-major"}
- **Construction Autonomy Mode**: gated
- **Guard Policy**: strict (set by you)
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
  seedBoltDag(p, ["alpha", "beta"]);
  mkdirSync(join(p, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(p, "src", `${unit}.ts`), `export const ${unit} = 1;\n`);
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, p);
  return p;
}

function tool(p: string, name: string, args: string[]) {
  const r = spawnSync(BUN, [join(AIDLC_SRC, "tools", `aidlc-${name}.ts`), ...args, "--project-dir", p], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: { ...process.env, ...PERSON },
  });
  return { status: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
}

// A message of the person's, as the prompt hook records it.
function personSays(p: string, prompt: string): void {
  const r = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), cwd: p, encoding: "utf-8",
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: PERSON.AIDLC_SESSION_OVERRIDE, prompt }),
    env: { ...process.env, ...PERSON, CLAUDE_PROJECT_DIR: p, AIDLC_PROJECT_DIR: p },
  });
  expect(r.status, r.stderr).toBe(0);
}

function next(p: string, args: string[] = []): Directive {
  const r = runOrchestrateNext(join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts"), p, args, {
    env: { ...process.env, ...PERSON },
  });
  expect(r.directive, r.out).not.toBeNull();
  return r.directive as Directive;
}

// The step's summary, confirmed by the person through its checkpoint.
function confirm(p: string, unit: string, slug: string): void {
  const dir = join(seededRecordDir(p), "construction", unit, slug);
  mkdirSync(dir, { recursive: true });
  const questions = join(dir, `${slug}-questions.md`);
  writeFileSync(questions, [
    "# Questions", "", "## Q1", "", "- Keep it simple.", "",
    "## Consolidated Summary Confirmation", "", "- Looks correct", "- Request changes", "", "[Answer]:", "",
  ].join("\n"));
  const identity = ["--stage", slug, "--unit", unit, "--checkpoint", "summary-confirmation", "--questions-file", questions];
  const asked = tool(p, "log", [
    "decision", ...identity, "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes",
  ]);
  expect(asked.status, asked.out).toBe(0);
  personSays(p, "Looks correct");
  writeFileSync(questions, readFileSync(questions, "utf-8").replace("[Answer]:\n", "[Answer]: Looks correct\n"));
  const answered = tool(p, "log", ["answer", ...identity, "--details", "Looks correct"]);
  expect(answered.status, answered.out).toBe(0);
}

// A READY review receipt for one Unit's step, bound to its current files.
function reviewReady(p: string, slug: string, unit: string): void {
  const stage = findStageBySlug(slug)!;
  const fields = {
    Stage: slug, Reviewer: stage.reviewer!, Unit: unit, Iteration: "1",
    "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, unit)!,
    "Review Appendix Artifact": `construction/${unit}/${slug}/${artifactFilename(stage.review_artifact!)}`,
    "Review Appendix Offset": "0",
  };
  appendAuditEntry("REVIEW_REQUESTED", fields, p);
  appendAuditEntry("REVIEW_COMPLETED", { ...fields, Verdict: "READY" }, p);
}

// One Unit's steps: summary confirmed, documents written through the write
// hook, reviewed READY and, unless `finish` is false, finished.
function cover(p: string, unit: string, selected = STAGES, finish = true): void {
  for (const slug of selected) {
    const stage = findStageBySlug(slug)!;
    if (stage.summary_confirmation === "required") confirm(p, unit, slug);
    const out = join(seededRecordDir(p), "construction", unit, slug);
    mkdirSync(out, { recursive: true });
    for (const name of stage.produces ?? []) {
      const file = join(out, artifactFilename(name));
      writeFileSync(file, `# ${unit} ${name}\n`);
      recordArtifactWriteViaHook(p, file, "Write", PERSON);
    }
    if (stage.workspace_requires) {
      writeFileSync(join(out, "source-manifest.json"), JSON.stringify({
        stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }],
      }));
    }
    reviewReady(p, slug, unit);
    if (!finish) continue;
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(p, slug, true, unit),
      "Artifact Fingerprint": reviewArtifactFingerprint(p, stage, unit, { requireRequiredArtifacts: true })!,
    }, p);
  }
}

// alpha built; beta has its design and is on Code Generation.
function betaBuilding(options: { started?: boolean } = {}): string {
  const p = fixture();
  cover(p, "alpha");
  cover(p, "beta", STAGES.slice(0, 4));
  expect(next(p)).toMatchObject({ kind: "run-stage", stage: "code-generation", unit: "beta" });
  if (options.started) {
    const started = tool(p, "state", ["unit", "start", "--stage", "code-generation", "--unit", "beta"]);
    expect(started.status, started.out).toBe(0);
  }
  return p;
}

function designFile(p: string, unit: string): string {
  const stage = findStageBySlug("functional-design")!;
  return join(seededRecordDir(p), "construction", unit, "functional-design", artifactFilename(stage.produces![0]));
}

// The agent's write, as the host hands it to the review-freeze hook.
function write(p: string, file: string): { code: number | null; stderr: string } {
  const r = spawnSync(BUN, [join(AIDLC_SRC, "hooks", "aidlc-review-freeze.ts")], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8",
    input: JSON.stringify({
      hook_event_name: "PreToolUse", session_id: PERSON.AIDLC_SESSION_OVERRIDE,
      tool_name: "Write", tool_input: { file_path: file },
    }),
    env: { ...process.env, ...PERSON, CLAUDE_PROJECT_DIR: p },
  });
  return { code: r.status, stderr: r.stderr };
}

// The person says yes to changing alpha's design; the freeze refuses the edit
// and `next` asks them how to go on.
function refusedAsk(p: string, unit = "alpha"): Directive {
  personSays(p, `yes, update ${unit}'s functional design to match`);
  expect(write(p, designFile(p, unit)).code).toBe(2);
  const ask = next(p);
  expect(ask).toMatchObject({ kind: "ask", ask_type: "guard-recovery", stage: "functional-design", unit });
  return ask;
}

const ops = (directive: Directive) => (directive.remedies ?? []).map((remedy) => remedy.op);
const requestChanges = (remedies: Remedy[] | undefined): Remedy => {
  const found = (remedies ?? []).find((remedy) => remedy.op === "request-changes");
  expect(found, JSON.stringify(remedies)).toBeDefined();
  return found!;
};

function expectUnitScoped(remedy: Remedy): void {
  expect(remedy.label).toBe("Request Changes");
  expect(remedy.description).toBe(PLAIN);
  expect(remedy.interaction).toBe("human-input");
  expect(remedy.command).toBeUndefined();
  expect(remedy.operation).toBeUndefined();
  expect(remedy.action).toContain(UNIT_CHANGE);
  expect(remedy.action).not.toContain(STAGE_REJECT);
  expect(remedy.action).not.toContain("throws away");
}

function expectStageWide(remedy: Remedy, everyUnit: boolean): void {
  expect(remedy.label).toBe("Request Changes");
  if (everyUnit) expect(remedy.description).toContain(EVERY_UNIT);
  else expect(remedy.description).toBe(PLAIN);
  expect(remedy.action).toContain(STAGE_REJECT);
  expect(remedy.action).not.toContain("--change");
}

function logAnswer(p: string, details: string): { recorded: string | null; message: string } {
  const r = tool(p, "log", ["answer", "--stage", "functional-design", "--checkpoint", "guard-recovery", "--details", details]);
  expect(r.status, r.out).toBe(0);
  const parsed = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as { recorded?: string | null; message?: string };
  return { recorded: parsed.recorded ?? null, message: parsed.message ?? "" };
}

// The same question published as the engine publishes a recovery question it
// raises itself (a hook refusal's question is not published), so the pick is
// recorded on it.
function publish(p: string, ask: Directive): void {
  writeActiveDirectiveMarker(p, {
    kind: "ask", ask_type: GUARD_RECOVERY_ASK_TYPE, stage: "functional-design", unit: "alpha",
    state_sha256: stateDigest(readFileSync(seededStateFile(p), "utf-8")),
    remedies: (ask.remedies ?? []).map(({ op, label, action, operation, interaction }) => ({
      op, ...(label ? { label } : {}), action, ...(operation ? { operation } : {}), ...(interaction ? { interaction } : {}),
    })),
  } as Parameters<typeof writeActiveDirectiveMarker>[1]);
}

// Run the step a message names: the orchestrate command in it, and when that
// is a `next` that prints steps, each step it prints.
function carryOut(p: string, message: string): void {
  const named = /`[^`]*aidlc-orchestrate\.ts ([^`]+)`/.exec(message)?.[1];
  expect(named, message).toBeDefined();
  const argv = [...named!.matchAll(/'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2]);
  if (argv[0] !== "next") {
    const ran = tool(p, "orchestrate", [...argv, ...(message.includes("--reason") ? ["--reason", WORDS] : [])]);
    expect(ran.status, ran.out).toBe(0);
    return;
  }
  const printed = next(p, argv.slice(1)) as Directive & { message?: string };
  expect(printed.kind, JSON.stringify(printed)).toBe("print");
  const steps = String(printed.message).split("then tell the person")[0];
  for (const [, name, rest] of steps.matchAll(/`[^`]*aidlc-(\w+)\.ts ([^`]+)`/g)) {
    const ran = tool(p, name, [...rest.matchAll(/'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2]));
    expect(ran.status, ran.out).toBe(0);
  }
}

// beta keeps its reviewed, finished design; alpha's comes back with the
// person's words as the change; alpha's edit then goes through.
function expectAlphaOnlySentBack(p: string): void {
  const design = findStageBySlug("functional-design")!;
  const state = readFileSync(seededStateFile(p), "utf-8");
  const verdicts = freshReviewReceipts(p, state, design).unitVerdicts;
  expect(verdicts.get("beta")).toBe("READY");
  expect(verdicts.has("alpha")).toBe(false);
  const finished = unitCompletedReceipts(p, "functional-design");
  expect(finished.has("beta")).toBe(true);
  expect(finished.has("alpha")).toBe(false);
  const rejected = readAuditShardEvents(p).filter((row) => row.event === "GATE_REJECTED");
  expect(rejected.map((row) => auditBlockField(row.block, "Unit"))).toEqual(["alpha"]);
  // Their words reach the record whole; the window joins their turns.
  expect(auditBlockField(rejected[0].block, "Feedback")).toContain(WORDS);
  expect(write(p, designFile(p, "alpha")).code).toBe(0);
  expect(next(p)).toMatchObject({ stage: "functional-design", unit: "alpha" });
}

describe("Request Changes about one Unit sends back that Unit's step only", () => {
  test("the question keeps its two choices; Request Changes names alpha's step, not every Unit's", () => {
    const ask = refusedAsk(betaBuilding());
    expect(ask.question).toBe(QUESTION);
    expect(ops(ask)).toEqual(["request-changes", "lower-fence"]);
    expectUnitScoped(requestChanges(ask.remedies));
  });

  test("the question is the refusal's own: its pick is carried out from the choice shown", () => {
    const p = betaBuilding();
    refusedAsk(p);
    personSays(p, "Request Changes");
    expect(logAnswer(p, "Request Changes")).toEqual({
      recorded: null,
      message: "No recovery question is open, so there is nothing to record. Carry out the choice the person " +
        "picked from the refusal you showed them.",
    });
  });

  test("on a published recovery question, the pick and then the person's words name the same step for alpha", () => {
    const p = betaBuilding();
    publish(p, refusedAsk(p));
    personSays(p, "Request Changes");
    const picked = logAnswer(p, "Request Changes");
    expect(picked.recorded).toBe("request-changes");
    expect(picked.message).toContain('Ask "What should change?" and end the turn');
    expect(picked.message).toContain(UNIT_CHANGE);
    expect(picked.message).not.toContain(STAGE_REJECT);
    personSays(p, WORDS);
    const said = logAnswer(p, `Request Changes: ${WORDS}`);
    expect(said.message).not.toContain("What should change?");
    expect(said.message).toContain(UNIT_CHANGE);
    expect(said.message).not.toContain(STAGE_REJECT);
  });

  test("carrying out the choice keeps beta's reviewed design and sends back alpha's with the person's words", () => {
    // beta's step is open, so the step pauses it before alpha's reopen.
    const p = betaBuilding({ started: true });
    const ask = refusedAsk(p);
    personSays(p, `Request Changes: ${WORDS}`);
    carryOut(p, requestChanges(ask.remedies).action);
    expectAlphaOnlySentBack(p);
  });

  test("at the open Functional Design gate, the same step for alpha", () => {
    const p = fixture();
    cover(p, "alpha");
    cover(p, "beta");
    expect(next(p)).toMatchObject({ kind: "run-stage", stage: "functional-design", gate: true });
    personSays(p, "show me the design for approval");
    const shown = tool(p, "orchestrate", ["report", "--stage", "functional-design", "--result", "awaiting-approval"]);
    expect(shown.status, shown.out).toBe(0);
    expect(readFileSync(seededStateFile(p), "utf-8")).toMatch(/^- \[\?\] functional-design /m);
    personSays(p, `change alpha's design: ${WORDS}`);
    // The gate's own question stays up; the refusal names the step itself.
    const refused = write(p, designFile(p, "alpha"));
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain(UNIT_CHANGE);
    expect(refused.stderr).not.toContain(STAGE_REJECT);
    expect(refused.stderr).not.toContain("throws away");
    carryOut(p, refused.stderr);
    expectAlphaOnlySentBack(p);
  });

  test("with strict locked by the team, the one choice is Request Changes for alpha", () => {
    const p = betaBuilding();
    const memory = join(p, "aidlc", "spaces", "default", "memory", "project.md");
    const existing = readFileSync(memory, "utf-8");
    writeFileSync(memory, existing.includes("## Guard Policy\n")
      ? existing.replace("## Guard Policy\n", "## Guard Policy\n\nMode: strict\n")
      : `${existing.trimEnd()}\n\n## Guard Policy\n\nMode: strict\n`);
    const ask = refusedAsk(p);
    expect(ops(ask)).toEqual(["request-changes"]);
    expectUnitScoped(requestChanges(ask.remedies));
  });
});

describe("what keeps its remedies", () => {
  test("the Unit still working on its Functional Design keeps today's Request Changes", () => {
    // alpha is part way through its step: reviewed, not finished. Sending its
    // step back routes the step it is on again, so it keeps today's remedies.
    const p = fixture();
    const started = tool(p, "state", ["unit", "start", "--stage", "functional-design", "--unit", "alpha"]);
    expect(started.status, started.out).toBe(0);
    cover(p, "alpha", ["functional-design"], false);
    const state = readFileSync(seededStateFile(p), "utf-8");
    expect(getField(state, "Active Unit")).toBe("alpha");
    expect(getField(state, "Unit Stage")).toBe("functional-design");
    expect(getField(state, "Unit State")).toBe("in-progress");
    const ask = refusedAsk(p);
    expect(ops(ask)).toEqual(["request-changes", "lower-fence"]);
    expectStageWide(requestChanges(ask.remedies), true);
  });

  test("a Unit set aside part way through its step keeps today's Request Changes", () => {
    // alpha was reviewed, not finished, then set aside for beta (as reopening
    // beta does): its open step is picked up, not reopened, so Request Changes
    // stays the stage-wide one.
    const p = fixture();
    const started = tool(p, "state", ["unit", "start", "--stage", "functional-design", "--unit", "alpha"]);
    expect(started.status, started.out).toBe(0);
    cover(p, "alpha", ["functional-design"], false);
    const paused = tool(p, "state", [
      "unit", "pause", "--stage", "functional-design", "--unit", "alpha",
      "--reason", "the person reopened beta", "--next-action", "Continue Functional Design for unit alpha.",
      "--set-aside-for", "beta",
    ]);
    expect(paused.status, paused.out).toBe(0);
    const ask = refusedAsk(p);
    const remedy = requestChanges(ask.remedies);
    expect(String(remedy.action)).not.toContain("--change");
    expectStageWide(remedy, true);
  });

  test("a stage-by-stage walk keeps today's Request Changes", () => {
    const p = fixture({ iteration: "stage-major" });
    cover(p, "alpha", ["functional-design"]);
    expect(next(p)).toMatchObject({ stage: "functional-design", unit: "beta" });
    const ask = refusedAsk(p);
    expect(ops(ask)).toEqual(["request-changes", "lower-fence"]);
    expectStageWide(requestChanges(ask.remedies), false);
  });

  test("a refusal that names no Unit keeps today's Request Changes, with what it throws away", () => {
    const stateContent = [
      "# AI-DLC State",
      "- **Scope**: feature",
      "- **Unit Ownership**: solo",
      "- **Current Stage**: functional-design",
      "- **Construction Iteration**: unit-major",
      "- **Guard Policy**: strict (set by you)",
      ...STAGES.map((slug) => `- [${slug === "functional-design" ? "-" : " "}] ${slug} \u2014 EXECUTE`),
      "",
    ].join("\n");
    const refusal = evaluateGuardRefusal({
      code: "REVIEW_FREEZE_ACTIVE",
      blockedAction: "artifact-write:functional-spec.md",
      stage: "functional-design",
      stateContent,
      invariant: "A terminal review continues to cover the bytes it certified.",
      userMessage: "",
      attempt: { recovery: "available", summaryCoverage: "current", reviewCoverage: "current", sourceCoverage: "current" },
      humanAuthority: { freshTurn: true, unattended: false },
      fence: "review-freeze",
      fenceSwitch: "offer",
    });
    const remedy = requestChanges(refusal.remedies as Remedy[]);
    expect(remedy.description).toBe(
      "Tell me what should change in Functional Design, and I'll revise it. This also throws away every Unit's " +
        "finished Functional Design work, and each needs its review and approval again.",
    );
    expect(remedy.action).toContain(STAGE_REJECT);
    expect(remedy.action).toContain('throws away every unit\'s finished "functional-design" work');
    expect(remedy.action).not.toContain("--change");
  });
});
