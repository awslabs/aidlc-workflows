// covers: subcommand:aidlc-orchestrate:next, subcommand:aidlc-state:set-unit-ownership, audit:UNIT_OWNERSHIP_SET, audit:CONSTRUCTION_POLICY_SET, function:teamsAcrossReposLine
//
// Who builds the Units is asked once, by the engine, as Inception ends (#1395).
// A plan of two or more Units reached Construction with nobody asked: the
// question was one paragraph of Delivery Planning prose keyed to a step that
// no longer runs, and a workflow without Delivery Planning never carried it.
// Here the first step into a per-Unit Construction stage, while nothing is
// built, asks "Just me" or "Several teams" once; a pick records the answer
// (a resume, a second chat and a clone read it), a turn with no pick leaves
// this session building with one line saying how to change it, and work that
// spans several repos gets one true line instead of a choice that would be
// refused. One Unit, or no Unit plan, is never asked.

import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { readAuditShardEvents } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import {
  AIDLC_SRC,
  cleanupTestProject,
  createTestProject,
  resetAidlcEnv,
  runOrchestrateNext,
  seedAidlcMemory,
  seedBoltDag,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";
import { testGuardEnvironment } from "../harness/runner-profile.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);
resetAidlcEnv();

const BUN = process.execPath;
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const JUMP = join(AIDLC_SRC, "tools", "aidlc-jump.ts");
const STAGE_FILE = join(import.meta.dir, "..", "..", "core", "aidlc-common", "stages", "inception", "delivery-planning.md");

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AIDLC_SKIP_ARTIFACT_GUARD: "1",
  AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1",
  AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD: "1",
};
delete ENV.AWS_AIDLC_DEFAULT_SCOPE;
const chat = (session: string): NodeJS.ProcessEnv => ({
  ...ENV,
  AIDLC_SESSION_OVERRIDE: session,
  AIDLC_SESSION_OVERRIDE_SOURCE: "payload",
});
const CHAT = chat("01995000-7a11-7000-8000-000000001395");

const QUESTION = "Inception is done, and the plan has 2 Units. Who builds them?";
const DEFAULT_LINE = "This session builds the 2 Units one after another. To have several teams each own a Unit " +
  "instead, say so before the first Unit is built.";
const APPROVALS_LINE = "Each team will approve its Unit after every stage. Do you want them to approve once at the " +
  "end of each Unit instead? I'd keep after every stage, so a wrong turn is caught at the stage where it happens.";
const REPOS_LINE = "This work spans 2 repos, so this session builds its 2 Units: teams each owning a Unit is " +
  "not available yet for work across repos.";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) cleanupTestProject(tempDirs.pop());
});

type Directive = Record<string, unknown> & {
  kind?: string;
  ask_type?: string;
  stage?: string;
  unit?: string;
  question?: string;
  choices?: Array<{ label: string; detail?: string; command?: string }>;
  change_notices?: string[];
  numbered_prose_question?: string;
  message?: string;
};

interface Shape {
  /** Where the cursor stands: just entered Functional Design, or Units Generation finished with Code Generation next. */
  at?: "functional-design" | "after-units";
  iteration?: "unit-major" | "stage-major";
  execution?: "serial" | "swarm";
  ownership?: "solo" | "team";
  /** The walking skeleton's stance, or null when the first step still has to settle it. */
  stance?: string | null;
}

// The Stage Progress separator the state file uses.
const D = String.fromCharCode(0x2014);

// A feature plan that has just entered Construction (the approval moved the
// cursor onto Functional Design and nothing is built), or a composed-shape plan
// whose Units Generation is finished with Code Generation next.
function stateFile(shape: Shape): string {
  const runtime = [
    "- **Revision Count**: 0",
    ...(shape.stance === null ? [] : [`- **Skeleton Stance**: ${shape.stance ?? "off"}`]),
    "- **Construction Checkpoints**: enabled",
    `- **Construction Iteration**: ${shape.iteration ?? "unit-major"}`,
    `- **Construction Execution**: ${shape.execution ?? "serial"}`,
    ...(shape.ownership ? [`- **Unit Ownership**: ${shape.ownership}`] : []),
  ].join("\n");
  if (shape.at === "after-units") {
    return `# AI-DLC State Tracking

## Project Information
- **Project**: staffing question test
- **Project Type**: Greenfield
- **Scope**: classic
- **State Version**: 8

## Runtime State
${runtime}

## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] requirements-analysis ${D} EXECUTE
- [x] units-generation ${D} EXECUTE
- [S] contract-design ${D} SKIP
- [S] delivery-planning ${D} SKIP

### CONSTRUCTION PHASE
- [ ] functional-design ${D} SKIP
- [ ] nfr-requirements ${D} SKIP
- [ ] nfr-design ${D} SKIP
- [ ] infrastructure-design ${D} SKIP
- [ ] code-generation ${D} EXECUTE
- [ ] build-and-test ${D} EXECUTE

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: units-generation
- **Status**: Running
`;
  }
  return `# AI-DLC State Tracking

## Project Information
- **Project**: staffing question test
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8

## Runtime State
${runtime}

## Scope Configuration
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### INCEPTION PHASE
- [x] units-generation ${D} EXECUTE
- [x] delivery-planning ${D} EXECUTE

### CONSTRUCTION PHASE
- [-] functional-design ${D} EXECUTE
- [ ] nfr-requirements ${D} EXECUTE
- [ ] nfr-design ${D} EXECUTE
- [ ] infrastructure-design ${D} EXECUTE
- [ ] code-generation ${D} EXECUTE
- [ ] build-and-test ${D} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`;
}

function project(shape: Shape = {}, units = ["alpha", "beta"]): string {
  const proj = createTestProject();
  tempDirs.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), stateFile(shape));
  seedBoltDag(proj, units);
  return proj;
}

function next(proj: string, args: string[] = [], env: NodeJS.ProcessEnv = ENV): Directive {
  const result = runOrchestrateNext(ORCH, proj, args, { env });
  if (!result.directive) throw new Error(`next failed: ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.directive as Directive;
}

function runState(proj: string, args: string[], env: NodeJS.ProcessEnv = ENV): { rc: number; out: string; json: Record<string, unknown> | null } {
  const result = spawnSync(BUN, [STATE, ...args, "--project-dir", proj], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    env,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse((result.stdout ?? "").trim()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { rc: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, json };
}

// The command a choice carries, run as the agent runs it: this install's state
// tool with the same arguments.
function pick(proj: string, ask: Directive, label: string, env: NodeJS.ProcessEnv = ENV) {
  const choice = ask.choices?.find((c) => c.label === label);
  expect(choice?.command, JSON.stringify(ask)).toBeDefined();
  const m = /aidlc-state\.ts (.+)$/.exec(String(choice?.command));
  expect(m, String(choice?.command)).not.toBeNull();
  return runState(proj, m![1].split(" "), env);
}

const state = (proj: string) => readFileSync(seededStateFile(proj), "utf-8");
const field = (content: string, name: string) => new RegExp(`^- \\*\\*${name}\\*\\*: ?(.*)$`, "m").exec(content)?.[1]?.trim();
const events = (proj: string, name: string) => readAuditShardEvents(proj).filter((row) => row.event === name);
const isStaffingAsk = (d: Directive) => d.kind === "ask" && d.ask_type === "construction-staffing";

function personSays(proj: string, prompt: string, session: string): void {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_PROJECT_DIR: proj, CLAUDE_PROJECT_DIR: proj };
  delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
  delete env.AIDLC_UNATTENDED;
  const result = spawnSync(BUN, [join(AIDLC_SRC, "tools/aidlc.ts"), "engine", "hook", "record-human-turn"], {
    timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
    encoding: "utf-8",
    cwd: proj,
    env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: session, prompt }),
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
}

describe("who builds the Units is asked once as Inception ends", () => {
  test("the first step into Construction with two Units and nobody asked is the question", () => {
    const proj = project();
    const ask = next(proj);
    expect(isStaffingAsk(ask), JSON.stringify(ask)).toBe(true);
    expect(ask.response_route).toBe("command");
    expect(ask.question).toBe(QUESTION);
    expect(ask.choices?.map((c) => c.label)).toEqual(["Just me", "Several teams"]);
    expect(String(ask.choices?.[0].command)).toEndWith("aidlc-state.ts set-unit-ownership solo");
    expect(String(ask.choices?.[1].command)).toEndWith("aidlc-state.ts set-unit-ownership team");
    expect(String(ask.choices?.[1].detail)).toContain("approves it after every stage, or once at the end of the Unit");
    expect(ask.numbered_prose_question).toContain("1. **Just me**");
    expect(ask.numbered_prose_question).toContain("2. **Several teams**");
    expect(field(state(proj), "Unit Ownership")).toBeUndefined();
    expect(events(proj, "UNIT_OWNERSHIP_SET")).toEqual([]);
  });

  test("a plan without Delivery Planning asks at the same place: Units Generation done, Code Generation next", () => {
    const proj = project({ at: "after-units" });
    const ask = next(proj);
    expect(isStaffingAsk(ask), JSON.stringify(ask)).toBe(true);
    expect(ask.question).toBe(QUESTION);
  });

  test("a jump into Construction with nobody asked meets the same one question", () => {
    const proj = project({ at: "after-units" });
    const jump = next(proj, ["--stage", "code-generation"]);
    const command = /`(bun \S*aidlc-jump\.ts execute [^`]+)`/.exec(String(jump.message))?.[1];
    expect(command, JSON.stringify(jump)).toBeDefined();
    const args = command!.replace(/^bun \S*aidlc-jump\.ts /, "").split(" ");
    const ran = spawnSync(BUN, [JUMP, ...args, "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: ENV,
    });
    expect(ran.status, `${ran.stdout}${ran.stderr}`).toBe(0);
    expect(isStaffingAsk(next(proj))).toBe(true);
  });

  test("one Unit is never asked", () => {
    const proj = project({}, ["alpha"]);
    const d = next(proj);
    expect(d.kind).toBe("run-stage");
    expect(d.stage).toBe("functional-design");
  });

  test("Construction already under way is never asked (work in flight on an upgrade)", () => {
    const proj = project();
    const dir = join(seededRecordDir(proj), "construction", "alpha", "functional-design");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "entities.md"), "# entities for alpha\n");
    expect(next(proj).kind).toBe("run-stage");
  });

  test("Just me records solo and nothing else; a resume and a clone are not asked again", () => {
    const proj = project();
    const before = state(proj);
    const ran = pick(proj, next(proj), "Just me");
    expect(ran.rc, ran.out).toBe(0);
    const after = state(proj);
    expect(field(after, "Unit Ownership")).toBe("solo");
    const lines = (content: string) =>
      content.split("\n").filter((line) => line.trim() !== "" && !/^- \*\*(Last Updated|Unit Ownership)\*\*:/.test(line));
    expect(lines(after)).toEqual(lines(before));
    expect(events(proj, "UNIT_OWNERSHIP_SET").length).toBe(1);
    const first = next(proj);
    expect(first.kind, JSON.stringify(first)).toBe("run-stage");
    expect(first.stage).toBe("functional-design");
    expect(next(proj).kind).toBe("run-stage");
    const clone = createTestProject();
    tempDirs.push(clone);
    cpSync(join(proj, "aidlc"), join(clone, "aidlc"), { recursive: true });
    expect(next(clone).kind).toBe("run-stage");
  });

  test("Several teams records team on a one-Unit-at-a-time plan and says how approvals go", () => {
    const proj = project();
    const ran = pick(proj, next(proj, [], CHAT), "Several teams", CHAT);
    expect(ran.rc, ran.out).toBe(0);
    expect(field(state(proj), "Unit Ownership")).toBe("team");
    expect(field(state(proj), "Unit Gate Rhythm")).toBeUndefined();
    expect(ran.out).toContain("set-unit-gate-rhythm unit-end");
    const step = next(proj, [], CHAT);
    expect(isStaffingAsk(step)).toBe(false);
    expect(step.kind, JSON.stringify(step)).not.toBe("ask");
    expect(step.change_notices ?? [], JSON.stringify(step)).toContain(APPROVALS_LINE);
    expect(next(proj, [], CHAT).change_notices ?? []).not.toContain(APPROVALS_LINE);
  });

  // Seen live on Claude Code: the line rode the step that settles the walking
  // skeleton's stance, which the agent passes through without speaking.
  test("a line waits past the skeleton step the agent passes through", () => {
    const proj = project({ stance: null });
    const ran = pick(proj, next(proj, [], CHAT), "Several teams", CHAT);
    expect(ran.rc, ran.out).toBe(0);
    const settle = next(proj, [], CHAT);
    expect(settle.gate, JSON.stringify(settle)).toBe("unresolved");
    expect(settle.change_notices ?? []).not.toContain(APPROVALS_LINE);
    // With learnings on, that step's diary is already written: nothing of a
    // Unit is built yet, so the line still waits for the next step.
    const diary = join(seededRecordDir(proj), "construction", "functional-design");
    mkdirSync(diary, { recursive: true });
    writeFileSync(join(diary, "memory.md"), "# Functional Design diary\n");
    const report = spawnSync(BUN, [ORCH, "report", "--skeleton-stance", "off", "--project-dir", proj], {
      timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS), encoding: "utf-8", env: CHAT,
    });
    expect(report.status, `${report.stdout}${report.stderr}`).toBe(0);
    const work = next(proj, [], CHAT);
    expect(work.change_notices ?? [], JSON.stringify(work)).toContain(APPROVALS_LINE);
  });

  test("Several teams on a stage-by-stage plan with parallel builds is one pick: the order switches with it", () => {
    const proj = project({ iteration: "stage-major", execution: "swarm" });
    const ask = next(proj);
    expect(isStaffingAsk(ask)).toBe(true);
    expect(String(ask.choices?.[1].detail)).toContain("one at a time");
    const ran = pick(proj, ask, "Several teams");
    expect(ran.rc, ran.out).toBe(0);
    const after = state(proj);
    expect(field(after, "Construction Execution")).toBe("serial");
    expect(field(after, "Construction Iteration")).toBe("unit-major");
    expect(field(after, "Unit Ownership")).toBe("team");
    expect(events(proj, "CONSTRUCTION_POLICY_SET").length).toBe(2);
    expect(ran.out).toContain("Construction now builds the Units one after another");
    expect(ran.out).toContain("Construction now builds one Unit at a time");
  });

  test("the switch with no person turn on record is refused before anything is written", () => {
    const proj = project({ iteration: "stage-major", execution: "swarm" });
    const before = state(proj);
    const env = testGuardEnvironment({ ...ENV }, "production");
    delete env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD;
    const ran = runState(proj, ["set-unit-ownership", "team"], env);
    expect(ran.rc).not.toBe(0);
    expect(ran.out).toContain("No message from the person since the last decision");
    expect(state(proj)).toBe(before);
    expect(events(proj, "CONSTRUCTION_POLICY_SET")).toEqual([]);
    expect(events(proj, "UNIT_OWNERSHIP_SET")).toEqual([]);
  });

  test("shown, then the person speaks without picking: this session builds, said once, nothing recorded as theirs", () => {
    const proj = project();
    expect(isStaffingAsk(next(proj, [], CHAT))).toBe(true);
    personSays(proj, "what is a Unit again?", String(CHAT.AIDLC_SESSION_OVERRIDE));
    const step = next(proj, [], CHAT);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.change_notices ?? []).toContain(DEFAULT_LINE);
    expect(field(state(proj), "Unit Ownership")).toBeUndefined();
    expect(events(proj, "UNIT_OWNERSHIP_SET")).toEqual([]);
    const again = next(proj, [], CHAT);
    expect(again.kind).toBe("run-stage");
    expect(again.change_notices ?? []).not.toContain(DEFAULT_LINE);
    appendAuditEntry("UNIT_STARTED", { Stage: "functional-design", Unit: "alpha", "Run floor": "unstarted#0" }, proj);
    expect(next(proj, [], chat("01995000-7a11-7000-8000-000000001396")).change_notices ?? []).not.toContain(DEFAULT_LINE);
  });

  test("shown, and the person has not spoken yet: it is still the open question", () => {
    const proj = project();
    expect(isStaffingAsk(next(proj))).toBe(true);
    expect(isStaffingAsk(next(proj))).toBe(true);
  });

  test("a read-only look at the next step does not count as showing it", () => {
    const proj = project();
    const probe = next(proj, [], { ...ENV, AIDLC_STOP_HOOK_PROBE: "1" });
    expect(isStaffingAsk(probe), JSON.stringify(probe)).toBe(true);
    appendAuditEntry("HUMAN_TURN", {}, proj);
    expect(isStaffingAsk(next(proj))).toBe(true);
  });

  test("work that spans several repos is not asked: one true line, once", () => {
    const proj = project();
    const registryPath = join(proj, "aidlc", "spaces", "default", "intents", "intents.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf-8")) as Array<Record<string, unknown>>;
    registry[0].repos = ["api", "web"];
    writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    const step = next(proj, [], CHAT);
    expect(step.kind, JSON.stringify(step)).toBe("run-stage");
    expect(step.change_notices ?? []).toContain(REPOS_LINE);
    expect(next(proj, [], CHAT).change_notices ?? []).not.toContain(REPOS_LINE);
    const before = state(proj);
    const teams = runState(proj, ["set-unit-ownership", "team"]);
    expect(teams.rc).not.toBe(0);
    expect(teams.out).toContain("This work spans 2 repos, so this session builds its Units: teams each owning " +
      "a Unit is not available yet for work across repos. Carry on with `/aidlc`.");
    expect(state(proj)).toBe(before);
  });

  test("Delivery Planning no longer carries the question in prose", () => {
    const text = readFileSync(STAGE_FILE, "utf-8");
    expect(text).not.toContain("Construction staffing");
    expect(text).not.toContain("Team check-in rhythm");
  });
});
