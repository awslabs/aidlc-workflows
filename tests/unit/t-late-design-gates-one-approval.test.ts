// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report, audit:GATE_APPROVED, audit:STAGE_AWAITING_APPROVAL, function:approvesTogetherStages, function:approvedTogetherCover, function:planChangeDirective, function:openGateApprovesTogether
//
// CLI-contract test: when Construction runs one Unit at a time (unit-major) and
// Unit checkpoints are off, the per-Unit stages' approvals that come due after
// the last Unit is built are ONE question, not one per stage. mechanism = cli.
//
// What the person sees: after alpha and beta are built, one question names every
// stage still waiting ("Functional Design, NFR Requirements, NFR Design,
// Infrastructure Design and Code Generation are complete for alpha and beta. How
// would you like to proceed?"), and one Approve approves each of them with their
// words. A change request approves nothing. A stage that cannot be approved yet
// stops the run there, and once it is fixed the approval already given covers it.
//
// Pinned here:
//   1. the first late gate carries the engine-computed list and its question;
//   2. opening that gate names the stage after the last listed one;
//   3. one person turn and one approval approve every listed stage;
//   4. a change request approves nothing;
//   5. a stage that cannot be approved yet stops there; fixed, it needs no new ask;
//  5b. on Kiro IDE that stage opens its gate as the step says, its approval report runs, and the approval covers it;
//   6. checkpoints on, stage-major, and a lone remaining stage keep today's flow;
//   7. no shipped prose still describes the late per-stage cascade;
//   8. a reply another question used, or a question put since, approves nothing;
//   9. autonomous Construction and team-owned Units keep one turn, one gate;
//  10. the learnings question surfaces each listed stage; any other stage is still refused;
//  11. "skip Functional Design and approve the rest": the skip step names the approval of the
//      rest, which approves them together; a skip alone leaves them to their question.
//
// SOURCE UNDER TEST (dist/claude/.claude/tools/): aidlc-orchestrate.ts next and
// report, aidlc-state.ts gate-start and approve, through the spawned engine.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  REPO_ROOT,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  approvesTogetherStages,
  artifactFilename,
  auditBlockField,
  latestMainWorkflowStageRunFloorForProject,
  readAuditShardEvents,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  renderTestingContract,
  resolveTestingPosture,
} from "../../dist/claude/.claude/tools/aidlc-testing-posture.ts";
import {
  NATIVE_FIXTURE_SETUP_TIMEOUT_MS,
  NATIVE_STARTUP_TIMEOUT_MS,
  remainingOperationTimeoutMs,
} from "../harness/test-budget.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const KIRO_IDE_TREE = join(REPO_ROOT, "dist", "kiro-ide", ".kiro");
const LOG = join(AIDLC_SRC, "tools", "aidlc-log.ts");
const LEARNINGS = join(AIDLC_SRC, "tools", "aidlc-learnings.ts");
const RUNTIME = join(AIDLC_SRC, "tools", "aidlc-runtime.ts");

const UNITS = ["alpha", "beta"];
const BLOCK = [
  "functional-design",
  "nfr-requirements",
  "nfr-design",
  "infrastructure-design",
  "code-generation",
];
const NAMES = [
  "Functional Design",
  "NFR Requirements",
  "NFR Design",
  "Infrastructure Design",
  "Code Generation",
];
const ONE_QUESTION =
  "Functional Design, NFR Requirements, NFR Design, Infrastructure Design and Code Generation " +
  "are complete for alpha and beta. How would you like to proceed?";

// Each per-unit construction stage's produces[] (stage frontmatter).
const PRODUCES: Record<string, string[]> = {
  "functional-design": ["entities", "rules", "functional-spec", "frontend-components", "traceability"],
  "nfr-requirements": [
    "performance-requirements",
    "security-requirements",
    "scalability-requirements",
    "reliability-requirements",
    "observability-requirements",
    "tech-stack-decisions",
    "traceability",
  ],
  "nfr-design": [
    "performance-design",
    "security-design",
    "scalability-design",
    "reliability-design",
    "observability-design",
    "logical-components",
    "traceability",
  ],
  "infrastructure-design": ["infrastructure-specification", "monitoring-design", "cicd-pipeline", "traceability"],
  "code-generation": ["code-generation-plan", "unit-test-instructions", "code-summary", "traceability"],
};
const REVIEW_ARTIFACTS: Record<string, string> = {
  "functional-design": "functional-spec",
  "nfr-requirements": "security-requirements",
  "nfr-design": "security-design",
  "infrastructure-design": "cicd-pipeline",
  "code-generation": "code-generation-plan",
};

// The state file's checkbox separator (an em dash), spelled as an escape here.
const SEP = "\u2014";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

interface Directive {
  kind?: string;
  stage?: string;
  unit?: string;
  gate?: unknown;
  next_stage?: string | null;
  approve_together?: {
    stages?: { slug?: string; name?: string }[];
    units?: string[];
    prompt?: string;
  };
  [k: string]: unknown;
}

// A Construction-phase state after every Unit is built, with Current Stage at
// the first per-Unit stage. `checkpoints` adds the checkpoint field; with
// `stageMajor` the iteration field is left out (stage-major).
function constructionState(opts: {
  checkpoints?: "enabled" | "disabled";
  stageMajor?: boolean;
  autonomous?: boolean;
  team?: boolean;
  current?: string;
  checkboxes?: string;
}): string {
  const checkboxes = opts.checkboxes ??
    `- [-] functional-design ${SEP} EXECUTE
- [ ] nfr-requirements ${SEP} EXECUTE
- [ ] nfr-design ${SEP} EXECUTE
- [ ] infrastructure-design ${SEP} EXECUTE
- [ ] code-generation ${SEP} EXECUTE
- [ ] build-and-test ${SEP} EXECUTE`;
  const iteration = opts.stageMajor ? "" : "- **Construction Iteration**: unit-major\n";
  const checkpoints = opts.checkpoints ? `- **Construction Checkpoints**: ${opts.checkpoints}\n` : "";
  const autonomy = opts.autonomous ? "- **Construction Autonomy Mode**: autonomous\n" : "";
  const team = opts.team ? "- **Unit Ownership**: team\n" : "";
  return `# AI-DLC State Tracking

## Project Information
- **Project**: late design gates test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on

## Runtime State
- **Revision Count**: 0
${iteration}${checkpoints}${autonomy}${team}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
${checkboxes}

### INCEPTION PHASE
- [-] domain-design ${SEP} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${opts.current ?? "functional-design"}
- **Status**: Running
`;
}

function coverUnit(proj: string, unit: string, slug: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of PRODUCES[slug]) {
    writeFileSync(join(dir, artifactFilename(name)), `# ${name} for ${unit}\n`);
  }
}

function logReviewReady(proj: string, stage: string, unit: string): void {
  const reviewer = "aidlc-architecture-reviewer-agent";
  const artifact = join(
    seededRecordDir(proj),
    "construction",
    unit,
    stage,
    artifactFilename(REVIEW_ARTIFACTS[stage]),
  );
  if (stage === "code-generation") {
    writeFileSync(
      join(seededRecordDir(proj), "construction", unit, stage, "source-manifest.json"),
      `${JSON.stringify({ stage, unit, version: 1, writes: [] }, null, 2)}\n`,
    );
  }
  const args = [
    LOG, "review", "--stage", stage, "--reviewer", reviewer, "--unit", unit,
    "--iteration", "1", "--project-dir", proj,
  ];
  const env = { ...process.env, AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1" };
  const opts = { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" as const, env };
  const request = spawnSync(BUN, args, opts);
  if ((request.status ?? -1) !== 0) {
    throw new Error(`review request failed: ${request.stdout ?? ""}${request.stderr ?? ""}`);
  }
  appendFileSync(
    artifact,
    "\n## Review\n\n**Verdict:** READY\n" +
      `**Reviewer:** ${reviewer}\n**Iteration:** 1\n\n### Findings\n\nNo blocking findings.\n`,
    "utf-8",
  );
  const verdict = spawnSync(BUN, [...args, "--verdict", "READY"], opts);
  if ((verdict.status ?? -1) !== 0) {
    throw new Error(`review verdict failed: ${verdict.stdout ?? ""}${verdict.stderr ?? ""}`);
  }
}

// A Unit's built Code Generation step: a ready plan beside its instructions,
// and the start and completion receipts the build records in this attempt.
function buildUnit(proj: string, unit: string): void {
  const dir = join(seededRecordDir(proj), "construction", unit, "code-generation");
  writeFileSync(
    join(dir, "code-generation-plan.md"),
    "# Code Generation Plan\n\n## Steps\n\n- [x] Step 1: build `src/" + unit + ".ts`\n\n" +
      renderTestingContract(resolveTestingPosture(proj)),
  );
  writeFileSync(join(dir, "unit-test-instructions.md"), "# Unit Test Instructions\n\nRun the tests.\n");
  const floor = latestMainWorkflowStageRunFloorForProject(proj, "code-generation", true, unit);
  for (const event of ["UNIT_STARTED", "UNIT_COMPLETED"]) {
    appendAuditEntry(event, { Stage: "code-generation", Unit: unit, "Run floor": floor }, proj);
  }
}

// Every Unit built and reviewed, except the (stage, unit) pairs in `unreviewed`.
function seedBuiltProject(
  opts: Parameters<typeof constructionState>[0] = {},
  unreviewed: [string, string][] = [],
): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), constructionState(opts));
  seedBoltDag(proj, UNITS);
  for (const unit of UNITS) {
    for (const stage of BLOCK) coverUnit(proj, unit, stage);
  }
  for (const unit of UNITS) {
    // Built first, so each review is of the files as they stand.
    buildUnit(proj, unit);
    for (const stage of BLOCK) {
      if (!unreviewed.some(([s, u]) => s === stage && u === unit)) logReviewReady(proj, stage, unit);
    }
  }
  return proj;
}

function engineEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Not a Git checkout; source freshness is exercised end to end elsewhere.
    AIDLC_SKIP_SOURCE_FRESHNESS: "1",
  };
  delete env.AWS_AIDLC_DEFAULT_SCOPE;
  // The person's turn is what one approval stands on: keep the presence check on.
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  return env;
}

function runNext(proj: string): Directive {
  const r = runOrchestrateNext(ORCH, proj, [], { env: engineEnv() });
  if (r.directive === null) {
    throw new Error(`next did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`);
  }
  return r.directive as Directive;
}

function runReport(proj: string, args: string[]): Directive {
  const r = spawnSync(BUN, [ORCH, "report", ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env: engineEnv(),
  });
  try {
    return JSON.parse((r.stdout ?? "").trim()) as Directive;
  } catch {
    throw new Error(`report did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`);
  }
}

// The agent puts a question to the person (log decision, before showing it, as
// the protocol has it); with `answered`, the person then replies and that reply
// answers it (log answer). An answer needs a reply sent after its question.
function logQuestion(proj: string, stage: string, answered: boolean): void {
  const opts = { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" as const, env: engineEnv() };
  const asked = spawnSync(BUN, [
    LOG, "decision", "--stage", stage, "--decision", "Which name should the order entity use?",
    "--options", "Order,Purchase", "--project-dir", proj,
  ], opts);
  if ((asked.status ?? -1) !== 0) throw new Error(`log decision failed: ${asked.stdout ?? ""}${asked.stderr ?? ""}`);
  if (!answered) return;
  personReplies(proj);
  const answer = spawnSync(BUN, [LOG, "answer", "--stage", stage, "--details", "Purchase", "--project-dir", proj], opts);
  if ((answer.status ?? -1) !== 0) throw new Error(`log answer failed: ${answer.stdout ?? ""}${answer.stderr ?? ""}`);
}

// The person replies, as the prompt hook records it.
function personReplies(proj: string): void {
  appendAuditEntry("HUMAN_TURN", {}, proj);
}

function rows(proj: string, event: string): { stage: string | null; block: string }[] {
  return readAuditShardEvents(proj)
    .filter((row) => row.event === event)
    .map((row) => ({ stage: auditBlockField(row.block, "Stage"), block: row.block }));
}

function currentStage(proj: string): string | undefined {
  return /\*\*Current Stage\*\*:\s*(\S+)/.exec(readFileSync(seededStateFile(proj), "utf-8"))?.[1];
}

const SESSION = "01995000-7a11-7000-8000-00000000c0de";

function chatEnv(proj: string): NodeJS.ProcessEnv {
  return { ...engineEnv(), CLAUDE_PROJECT_DIR: proj, AIDLC_PROJECT_DIR: proj, AIDLC_SESSION_OVERRIDE: SESSION };
}

// What the person types at the question, through the human-turn hook every harness uses.
function says(proj: string, prompt: string): void {
  const res = spawnSync(BUN, [join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], {
    cwd: proj,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt }),
    env: { ...chatEnv(proj), AIDLC_UNATTENDED: "0" },
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  if ((res.status ?? -1) !== 0) throw new Error(`human-turn hook failed: ${res.stdout ?? ""}${res.stderr ?? ""}`);
}

// The agent runs a command the engine's step names, as it names it.
function runNamed(proj: string, command: string): Directive {
  const words = [...command.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]);
  expect(words.slice(0, 2)).toEqual(["bun", words[1]]);
  const tool = join(AIDLC_SRC, "tools", String(words[1]).replace(/^\.claude\/tools\//, ""));
  const r = spawnSync(BUN, [tool, ...words.slice(2), "--project-dir", proj], {
    cwd: proj,
    env: chatEnv(proj),
    encoding: "utf-8",
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(r.status, `${command}\n${r.stdout}${r.stderr}`).toBe(0);
  return JSON.parse((r.stdout ?? "").split("\n").find((line) => line.trim().startsWith("{")) ?? "{}") as Directive;
}

function openFirstGate(proj: string): { gate: Directive; opened: Directive } {
  const gate = runNext(proj);
  const opened = runReport(proj, ["--stage", "functional-design", "--result", "awaiting-approval"]);
  return { gate, opened };
}

describe("t-late-design-gates-one-approval: one question for the late stage approvals", () => {
  test("1: the first late gate carries every waiting stage and one question naming them", () => {
    const proj = seedBuiltProject({ checkpoints: "disabled" });
    const gate = runNext(proj);
    expect(gate).toMatchObject({ kind: "run-stage", stage: "functional-design", gate: true, unit: "beta" });
    expect(gate.approve_together?.stages?.map((s) => s.slug)).toEqual(BLOCK);
    expect(gate.approve_together?.stages?.map((s) => s.name)).toEqual(NAMES);
    expect(gate.approve_together?.units).toEqual(UNITS);
    expect(gate.approve_together?.prompt).toBe(ONE_QUESTION);
  });

  test("1b: a workflow without the checkpoint field gets the same one question", () => {
    const proj = seedBuiltProject();
    expect(runNext(proj).approve_together?.prompt).toBe(ONE_QUESTION);
  });

  test("2: the gate's record and its question name the same stages; the next stage follows the last", () => {
    const proj = seedBuiltProject({ checkpoints: "disabled" });
    const { gate, opened } = openFirstGate(proj);
    expect(opened.kind).toBe("print");
    expect(opened.next_stage).toBe("Build and Test");
    const open = rows(proj, "STAGE_AWAITING_APPROVAL").filter((r) => r.stage === "functional-design");
    expect(open.length).toBe(1);
    const recorded = (auditBlockField(open[0].block, "Approves Together") ?? "").split(", ");
    expect(recorded).toEqual(gate.approve_together?.stages?.map((s) => s.slug ?? "") ?? []);
    const names = gate.approve_together?.stages?.map((s) => s.name) ?? [];
    expect(gate.approve_together?.prompt?.startsWith(`${names.slice(0, -1).join(", ")} and ${names.at(-1)} are complete`))
      .toBe(true);
  });

  test("3: one reply and one approval approve every listed stage with the person's words", () => {
    const proj = seedBuiltProject({ checkpoints: "disabled" });
    openFirstGate(proj);
    personReplies(proj);
    const done = runReport(proj, ["--stage", "functional-design", "--result", "approved", "--user-input", "Approve"]);
    expect(done.kind).toBe("done");
    const approved = rows(proj, "GATE_APPROVED");
    expect(approved.map((r) => r.stage)).toEqual(BLOCK);
    for (const row of approved) expect(auditBlockField(row.block, "User Input")).toBe("Approve");
    for (const row of approved.slice(1)) {
      expect(auditBlockField(row.block, "Approved Together With")).toBe("functional-design");
    }
    expect(rows(proj, "GATE_REJECTED").length).toBe(0);
    expect(currentStage(proj)).toBe("build-and-test");
  });

  test("4: a change request approves nothing", () => {
    const proj = seedBuiltProject({ checkpoints: "disabled" });
    openFirstGate(proj);
    personReplies(proj);
    const reply = runReport(proj, [
      "--stage", "functional-design", "--result", "rejected",
      "--user-input", "Request Changes", "--reason", "name the order entity Purchase",
    ]);
    expect(reply.kind).not.toBe("error");
    expect(rows(proj, "GATE_APPROVED").length).toBe(0);
    expect(rows(proj, "GATE_REJECTED").map((r) => r.stage)).toEqual(["functional-design"]);
    expect(currentStage(proj)).toBe("functional-design");
  });

  test("5: a stage that cannot be approved yet stops there; once fixed, the approval given covers it", () => {
    const proj = seedBuiltProject({ checkpoints: "disabled" }, [["nfr-design", "beta"]]);
    openFirstGate(proj);
    personReplies(proj);
    const first = runReport(proj, ["--stage", "functional-design", "--result", "approved", "--user-input", "Approve"]);
    expect(first.kind).not.toBe("done");
    expect(rows(proj, "GATE_APPROVED").map((r) => r.stage)).toEqual(["functional-design", "nfr-requirements"]);
    expect(currentStage(proj)).toBe("nfr-design");

    // The agent finishes the missing review. The person is not asked again.
    logReviewReady(proj, "nfr-design", "beta");
    const fixed = runReport(proj, ["--stage", "nfr-design", "--result", "approved", "--user-input", "Approve"]);
    expect(fixed.kind).toBe("done");
    expect(rows(proj, "GATE_APPROVED").map((r) => r.stage)).toEqual(BLOCK);
    expect(currentStage(proj)).toBe("build-and-test");
  });

  test("5b: on Kiro IDE the stage fixed after the stop opens its gate, and the one approval given covers it", () => {
    const proj = seedBuiltProject({ checkpoints: "disabled" }, [["nfr-design", "beta"]]);
    openFirstGate(proj);
    personReplies(proj);
    runReport(proj, ["--stage", "functional-design", "--result", "approved", "--user-input", "Approve"]);
    expect(currentStage(proj)).toBe("nfr-design");
    // The agent finishes the review and runs the report the not-ready step names.
    logReviewReady(proj, "nfr-design", "beta");
    runReport(proj, ["--stage", "nfr-design", "--result", "awaiting-approval"]);
    expect(readFileSync(seededStateFile(proj), "utf-8")).toMatch(/^- \[\?\] nfr-design /m);
    // Its approval report goes through Kiro IDE's tool-call card first.
    cpSync(KIRO_IDE_TREE, join(proj, ".kiro"), { recursive: true });
    const approval = "bun .kiro/tools/aidlc.ts engine orchestrate report --stage nfr-design --result approved --user-input Approve";
    const card = spawnSync(BUN, [join(proj, ".kiro", "hooks", "aidlc-kiro-adapter.ts"), "guard-tool-call"], {
      cwd: proj,
      input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: proj, tool_name: "execute_pwsh", tool_input: { command: approval } }),
      env: { ...engineEnv(), AIDLC_COMPILED_EXECUTABLE: "", CLAUDE_PROJECT_DIR: proj },
      encoding: "utf-8",
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    });
    expect(card.status, card.stderr).toBe(0);
    expect(card.stderr).toBe("");
    const fixed = runReport(proj, ["--stage", "nfr-design", "--result", "approved", "--user-input", "Approve"]);
    expect(fixed.kind, JSON.stringify(fixed)).toBe("done");
    expect(rows(proj, "GATE_APPROVED").map((r) => r.stage)).toEqual(BLOCK);
  });

  test("8: a reply used by another question, or a question put since, approves nothing from the list", () => {
    // The person's reply answered a different question before the gate opened.
    const before = seedBuiltProject({ checkpoints: "disabled" });
    logQuestion(before, "functional-design", true);
    openFirstGate(before);
    const refused = runReport(before, ["--stage", "functional-design", "--result", "approved", "--user-input", "Approve"]);
    expect(refused.kind).not.toBe("done");
    expect(rows(before, "GATE_APPROVED").length).toBe(0);

    // A question put since the approval ends what the approval covers.
    const since = seedBuiltProject({ checkpoints: "disabled" }, [["nfr-design", "beta"]]);
    openFirstGate(since);
    personReplies(since);
    runReport(since, ["--stage", "functional-design", "--result", "approved", "--user-input", "Approve"]);
    expect(rows(since, "GATE_APPROVED").map((r) => r.stage)).toEqual(["functional-design", "nfr-requirements"]);
    logReviewReady(since, "nfr-design", "beta");
    logQuestion(since, "nfr-design", false);
    const later = runReport(since, ["--stage", "nfr-design", "--result", "approved", "--user-input", "Approve"]);
    expect(later.kind).not.toBe("done");
    expect(rows(since, "GATE_APPROVED").length).toBe(2);
  });

  test("9: autonomous Construction and team-owned Units keep one turn, one gate", () => {
    const autonomous = seedBuiltProject({ checkpoints: "disabled", autonomous: true });
    const gate = runNext(autonomous);
    expect(gate.approve_together).toBeUndefined();
    runReport(autonomous, ["--stage", "functional-design", "--result", "awaiting-approval"]);
    personReplies(autonomous);
    runReport(autonomous, ["--stage", "functional-design", "--result", "approved", "--user-input", "Approve"]);
    expect(rows(autonomous, "GATE_APPROVED").map((r) => r.stage)).toEqual(["functional-design"]);
    expect(currentStage(autonomous)).toBe("nfr-requirements");

    // Team-owned Units answer their own Unit gates; none is ever one question.
    expect(approvesTogetherStages(constructionState({ checkpoints: "disabled", team: true }), "functional-design"))
      .toBeNull();
    expect(approvesTogetherStages(constructionState({ checkpoints: "disabled", autonomous: true }), "functional-design"))
      .toBeNull();
    expect(approvesTogetherStages(constructionState({ checkpoints: "disabled" }), "functional-design")).toEqual(BLOCK);
  });

  test("6: checkpoints on, stage-major and a lone remaining stage keep their own flow", () => {
    const withCheckpoints = seedBuiltProject({ checkpoints: "enabled" });
    expect(runNext(withCheckpoints).approve_together).toBeUndefined();

    const stageMajor = seedBuiltProject({ stageMajor: true });
    expect(runNext(stageMajor).approve_together).toBeUndefined();

    const lone = seedBuiltProject({
      checkpoints: "disabled",
      current: "code-generation",
      checkboxes: `- [x] functional-design ${SEP} EXECUTE
- [x] nfr-requirements ${SEP} EXECUTE
- [x] nfr-design ${SEP} EXECUTE
- [x] infrastructure-design ${SEP} EXECUTE
- [-] code-generation ${SEP} EXECUTE
- [ ] build-and-test ${SEP} EXECUTE`,
    });
    const gate = runNext(lone);
    expect(gate).toMatchObject({ kind: "run-stage", stage: "code-generation", gate: true });
    expect(gate.approve_together).toBeUndefined();
  });

  test("10: the learnings question surfaces every listed stage's notes; other stages are still refused", () => {
    const opts = { timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8" as const, env: engineEnv() };
    const surface = (proj: string, slug: string) =>
      spawnSync(BUN, [LEARNINGS, "surface", "--slug", slug, "--project-dir", proj], opts);
    // The stage graph surface reads its diary paths from, as a real install compiles it.
    const built = (state: Parameters<typeof constructionState>[0]) => {
      const proj = seedBuiltProject(state);
      const compiled = spawnSync(BUN, [RUNTIME, "--project-dir", proj, "compile"], opts);
      if ((compiled.status ?? -1) !== 0) throw new Error(`compile failed: ${compiled.stdout}${compiled.stderr}`);
      return proj;
    };
    const together = built({ checkpoints: "disabled" });
    for (const slug of BLOCK) {
      const r = surface(together, slug);
      expect(r.status, `${slug}: ${r.stdout}${r.stderr}`).toBe(0);
    }
    const later = surface(together, "build-and-test");
    expect(later.status).not.toBe(0);
    expect(later.stderr).toContain("slug mismatch");

    // With checkpoints on, or stage-major, there is no combined question: a
    // later stage is refused.
    for (const state of [{ checkpoints: "enabled" as const }, { stageMajor: true }]) {
      const refused = surface(built(state), "nfr-requirements");
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("slug mismatch");
    }
  });

  // "skip Functional Design and approve the rest" at the one question: the
  // skip was carried out and the approval dropped, so the other stages were
  // asked about again.
  for (const [said, skipped, rest] of [
    ["skip Functional Design and approve the rest", ["functional-design"], BLOCK.slice(1)],
    ["skip Functional Design and NFR Requirements, approve the rest", ["functional-design", "nfr-requirements"], BLOCK.slice(2)],
  ] as const) {
    test(`11: "${said}" skips ${skipped.length === 1 ? "it" : "them"} and approves the rest together`, () => {
      const proj = seedBuiltProject({ checkpoints: "disabled" });
      openFirstGate(proj);
      says(proj, said);
      const step = runOrchestrateNext(ORCH, proj, ["--skip", skipped.join(",")], { env: chatEnv(proj) }).directive as Directive;
      const message = String(step.message);
      const named = [...message.matchAll(/`(bun [^`]+)`/g)].map((m) => m[1]).filter((c) => !c.includes("--single"));
      const approve = named.find((c) => c.includes("--result approved"));
      expect(approve, message).toBe(`bun .claude/tools/aidlc-orchestrate.ts report --stage ${rest[0]} --result approved --user-input Approve`);
      // The agent read their message as also approving the rest: every named command, in order.
      for (const command of named.filter((c) => !c.includes("--add"))) runNamed(proj, command);
      expect(rows(proj, "GATE_APPROVED").map((r) => r.stage)).toEqual([...rest]);
      expect(rows(proj, "STAGE_SKIPPED").map((r) => r.stage)).toContain("functional-design");
      expect(currentStage(proj)).toBe("build-and-test");
    });
  }

  test("11b: \"skip Functional Design\" alone leaves the rest to their question", () => {
    const proj = seedBuiltProject({ checkpoints: "disabled" });
    openFirstGate(proj);
    says(proj, "skip Functional Design");
    const step = runOrchestrateNext(ORCH, proj, ["--skip", "functional-design"], { env: chatEnv(proj) }).directive as Directive;
    const skip = /`(bun [^`]+--result skipped[^`]*)`/.exec(String(step.message))?.[1];
    runNamed(proj, String(skip));
    expect(rows(proj, "GATE_APPROVED").length).toBe(0);
    const again = runOrchestrateNext(ORCH, proj, [], { env: chatEnv(proj) }).directive as Directive;
    expect(again.approve_together?.stages?.map((st) => st.slug)).toEqual(BLOCK.slice(1));
  });

  // A change the person asks for at an open gate under Guard Policy off is made
  // directly; before the gate is shown again, `next` hands the gate's report,
  // which says the change (t-gate-shown-again). Here the gate is a per-Unit
  // stage's.
  function guardPolicyOff(proj: string): void {
    const path = seededStateFile(proj);
    writeFileSync(path, readFileSync(path, "utf-8")
      .replace("- **Revision Count**: 0\n", "- **Revision Count**: 0\n- **Guard Policy**: off (set by you)\n"));
  }
  function askedChange(proj: string, stage: string, unit: string): void {
    const doc = join(seededRecordDir(proj), "construction", unit, stage, artifactFilename(REVIEW_ARTIFACTS[stage]));
    appendFileSync(doc, "\nA change the person asked for.\n");
    appendAuditEntry("ARTIFACT_UPDATED", { File: relative(proj, doc).replaceAll("\\", "/"), Stage: stage, Unit: unit }, proj);
  }
  function nextAfterChange(proj: string): Directive {
    const r = runOrchestrateNext(ORCH, proj, [], { env: { ...engineEnv(), AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" } });
    if (r.directive === null) throw new Error(`next did not emit parseable JSON. status=${r.status}\n${r.stdout}\n${r.stderr}`);
    return r.directive as Directive;
  }

  test("12: an asked change at the joint late gate: the gate is shown again as the same one question", () => {
    const proj = seedBuiltProject({ checkpoints: "disabled" });
    guardPolicyOff(proj);
    runReport(proj, ["--stage", "functional-design", "--result", "awaiting-approval"]);
    askedChange(proj, "functional-design", "alpha");
    const again = nextAfterChange(proj);
    expect(again).toMatchObject({ kind: "run-stage", stage: "functional-design", gate_only: true });
    expect(again.approve_together?.stages?.map((s) => s.slug)).toEqual(BLOCK);
    expect(again.approve_together?.prompt).toBe(ONE_QUESTION);
  });

  test("12b: an asked change at a lone per-Unit gate: the report comes first, with what the stage produced", () => {
    const proj = seedBuiltProject({
      checkpoints: "disabled",
      current: "code-generation",
      checkboxes: `- [x] functional-design ${SEP} EXECUTE
- [x] nfr-requirements ${SEP} EXECUTE
- [x] nfr-design ${SEP} EXECUTE
- [x] infrastructure-design ${SEP} EXECUTE
- [-] code-generation ${SEP} EXECUTE
- [ ] build-and-test ${SEP} EXECUTE`,
    });
    guardPolicyOff(proj);
    runReport(proj, ["--stage", "code-generation", "--result", "awaiting-approval"]);
    askedChange(proj, "code-generation", "alpha");
    const owed = nextAfterChange(proj);
    expect(owed.kind).toBe("print");
    expect(String(owed.message)).toContain("report --stage code-generation --result awaiting-approval`");
    // A Unit is not reported on its own in a solo walk: the report names none.
    expect(String(owed.message)).not.toContain("--unit");
    expect(String(owed.narration)).toMatch(
      /^Code Generation is ready for your review\. It produced .*, in aidlc\/.*\/construction\/beta\/code-generation\/\.$/,
    );
    const reported = runReport(proj, ["--stage", "code-generation", "--result", "awaiting-approval"]);
    expect(reported.message).toBe('Stage "code-generation" is already awaiting approval; gate evidence revalidated.');
    expect(JSON.stringify(reported.change_notices ?? [])).toContain("construction/alpha/code-generation/code-generation-plan.md changed after");
    expect(nextAfterChange(proj)).toMatchObject({ kind: "run-stage", stage: "code-generation", gate_only: true });
  });

  test("7: no shipped prose still describes the late per-stage cascade", () => {
    const files = spawnSync("git", ["ls-files", "core", "harness", "docs", "README.md"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    }).stdout.split("\n").filter((f) => f.endsWith(".md") || f.endsWith(".ts"));
    const stale = /late (human )?per-stage (gate )?cascade|late stage-gate cascade|gates are UNCHANGED in count/;
    const hits = files.filter((f) => stale.test(readFileSync(join(REPO_ROOT, f), "utf-8")));
    expect(hits).toEqual([]);
  });
});
