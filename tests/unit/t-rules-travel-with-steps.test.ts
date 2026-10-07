// covers: function:withAgentNotes, function:validateDirective, subcommand:aidlc-orchestrate:next, subcommand:aidlc-orchestrate:report
//
// A live Kiro IDE journey ran from start to Construction with the agent never
// loading the aidlc skill or a stage protocol, so every rule that lives only
// there was missing. The person's own edit to requirements.md was called "a
// stray bullet", the agent answered the redo question for them, and at
// Construction's first step it never settled the walking-skeleton stance and
// ended up asking the person whether to debug the workflow. A rule that rides
// inside the step itself was followed (the Stop hook's own "say that line").
// So each person-facing field now carries one agent sentence beside it, the
// steps the agent got stuck on name their own next move, and both Kiro agent
// prompts carry a short must-follow list.
import { NATIVE_FIXTURE_SETUP_TIMEOUT_MS, NATIVE_STARTUP_TIMEOUT_MS, remainingOperationTimeoutMs } from "../harness/test-budget.ts";
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as directiveModule from "../../dist/claude/.claude/tools/aidlc-directive.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import { artifactFilename } from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { loadGraph } from "../../dist/claude/.claude/tools/aidlc-graph.ts";
import { stageValidationAuditFields } from "../../dist/claude/.claude/tools/aidlc-validity.ts";
import {
  AIDLC_SRC, cleanupTestProject, createOrchestrationTestProject, createTestProject, runOrchestrateNext,
  seedAidlcMemory, seedBoltDag, seededStateFile,
} from "../harness/fixtures.ts";

setDefaultTimeout(NATIVE_FIXTURE_SETUP_TIMEOUT_MS);

const REPO = join(import.meta.dir, "..", "..");
const ORCH = join(AIDLC_SRC, "tools", "aidlc-orchestrate.ts");
const UTIL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const SEP = "\u2014";
const projects: string[] = [];
afterEach(() => {
  while (projects.length) cleanupTestProject(projects.pop());
});

const STAGE_VALIDITY_SAY =
  "Say stage_validity.warning to the person word for word, as your own sentence with nothing in front of it, if " +
  "you have not said it in this chat yet, then carry on with this step; it is about their own change, so never say " +
  "who made it or call it stray or a mistake.";
const CHANGE_NOTICES_NOTE =
  "Say each change_notices line to the person once, word for word, as your own sentence with nothing in front of " +
  "it, and add nothing about why.";
const QUESTION_NOTE =
  "This question is for the person, not for you: show it to them with its choices as given, end your turn, and " +
  "act only on their reply.";

type Json = Record<string, unknown>;
type WithAgentNotes = (directive: Json, invocation: string) => Json;
const withAgentNotes = (directiveModule as unknown as { withAgentNotes?: WithAgentNotes }).withAgentNotes;
const validateDirective = directiveModule.validateDirective as (o: unknown) => { valid: boolean; errors?: string[] };

function recordDir(proj: string): string {
  const intents = join(proj, "aidlc", "spaces", "default", "intents");
  return join(intents, readFileSync(join(intents, "active-intent"), "utf-8").trim());
}

// Classic work with Practices Discovery finished and its completion record
// taken over its documents, under the given Guard Policy, now in Requirements
// Analysis.
function finishedPractices(policy: string): string {
  const proj = createOrchestrationTestProject();
  projects.push(proj);
  const made = spawnSync(process.execPath, [UTIL, "intent-create", "--scope", "classic", "--arguments", "show the asset description on hover", "--project-dir", proj], {
    encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  expect(made.status, `${made.stdout}${made.stderr}`).toBe(0);
  const stage = loadGraph().find((entry) => entry.slug === "practices-discovery")!;
  const dir = join(recordDir(proj), "inception", "practices-discovery");
  mkdirSync(dir, { recursive: true });
  for (const name of stage.produces ?? []) writeFileSync(join(dir, artifactFilename(name)), `# ${name}\n`);
  const statePath = join(recordDir(proj), "aidlc-state.md");
  const state = readFileSync(statePath, "utf-8")
    .replace(new RegExp(`^- \\[.\\] practices-discovery ${SEP}`, "m"), `- [x] practices-discovery ${SEP}`)
    .replace(new RegExp(`^- \\[.\\] requirements-analysis ${SEP}`, "m"), `- [-] requirements-analysis ${SEP}`)
    .replace(/^- \*\*Current Stage\*\*: .*$/m, "- **Current Stage**: requirements-analysis")
    .replace(/^- \*\*Guard Policy\*\*: .*$/m, `- **Guard Policy**: ${policy}`);
  writeFileSync(statePath, state);
  appendAuditEntry("STAGE_COMPLETED", { Stage: "practices-discovery", ...stageValidationAuditFields(proj, stage, state) }, proj);
  return proj;
}

function editTeamPractices(proj: string): void {
  const path = join(recordDir(proj), "inception", "practices-discovery", artifactFilename("team-practices"));
  writeFileSync(path, `${readFileSync(path, "utf-8")}\nOne line the person added.\n`);
}

function next(proj: string, args: string[] = []): Json {
  const result = runOrchestrateNext(ORCH, proj, args);
  expect(result.directive, result.stderr).not.toBeNull();
  return result.directive as Json;
}

// A solo feature walk at Construction's first stage, Units alpha and beta,
// built one Unit at a time with checkpoints (the live journey's settings).
function constructionProject(skeletonStance?: string): string {
  const proj = createTestProject();
  projects.push(proj);
  seedAidlcMemory(proj);
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: rules travel with the steps
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
${skeletonStance ? `- **Skeleton Stance**: ${skeletonStance}\n` : ""}
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Runtime State
- **Construction Checkpoints**: enabled
- **Construction Iteration**: unit-major
- **Construction Execution**: serial

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design ${SEP} EXECUTE
- [ ] nfr-requirements ${SEP} EXECUTE
- [ ] nfr-design ${SEP} EXECUTE
- [ ] infrastructure-design ${SEP} EXECUTE
- [ ] code-generation ${SEP} EXECUTE
- [ ] build-and-test ${SEP} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
`);
  seedBoltDag(proj, ["alpha", "beta"]);
  return proj;
}

function report(proj: string, args: string[]): Json {
  const result = spawnSync(process.execPath, [ORCH, "report", ...args, "--project-dir", proj], {
    encoding: "utf-8", timeout: remainingOperationTimeoutMs(NATIVE_STARTUP_TIMEOUT_MS),
  });
  return JSON.parse((result.stdout ?? "").trim()) as Json;
}

describe("t-rules-travel-with-steps: a person-facing field says what to do with it", () => {
  test("a stage whose document the person changed carries the warning's sentence", () => {
    const proj = finishedPractices("strict (set by you)");
    editTeamPractices(proj);
    const directive = next(proj);
    expect(directive.stage_validity, JSON.stringify(directive).slice(0, 400)).toBeDefined();
    const note = String(directive.stage_validity_note);
    expect(note.startsWith(STAGE_VALIDITY_SAY)).toBe(true);
    // A yes to the redo question reopens the stage the warning names.
    expect(note).toMatch(/ If their next reply says yes to it, run `[^`]*aidlc-orchestrate\.ts next --stage practices-discovery` and follow the step it returns\.$/);
  });

  test("with nothing changed there is no warning and no sentence for it", () => {
    const directive = next(finishedPractices("strict (set by you)"));
    expect(directive.stage_validity).toBeUndefined();
    expect(directive.stage_validity_note).toBeUndefined();
  });

  test("an engine question says it is the person's to answer", () => {
    const proj = finishedPractices("strict (set by you)");
    // New work with no plan named: the plan question.
    const directive = next(proj, ["--new-intent", "fix the login redirect"]);
    expect(directive.kind, JSON.stringify(directive).slice(0, 300)).toBe("ask");
    expect(directive.question_note).toBe(QUESTION_NOTE);
  });

  test("Construction's first step, before the walking-skeleton stance, names the stance step", () => {
    const directive = next(constructionProject());
    expect(directive.gate).toBe("unresolved");
    const note = String(directive.gate_note);
    expect(note).toContain("## Walking Skeleton");
    expect(note).toContain("report --skeleton-stance <on|off|scope-dependent>");
    expect(note).toContain("then run `");
    expect(note).toMatch(/aidlc-orchestrate\.ts next`/);
  });

  test("a Unit's step with no gate says to run next, not to report or ask for approval", () => {
    const directive = next(constructionProject("on"));
    expect(directive.unit).toBe("alpha");
    expect(directive.gate).toBe(false);
    const note = String(directive.gate_note);
    expect(note).toContain("do not report it or ask the person to approve it");
    expect(note).toMatch(/run `[^`]*aidlc-orchestrate\.ts next`/);
    // Live: with no skill the step looped on the Unit's review and the autonomy
    // question; the step names the protocol files it runs by.
    const protocols = String(directive.protocol_note);
    const dir = String(directive.stage_file).split("/aidlc-common/")[0] + "/aidlc-common/protocols";
    expect(protocols.startsWith(`Unless this chat already holds them, read ${dir}/stage-protocol.md, `)).toBe(true);
    for (const module of directive.protocol_modules as string[]) {
      expect(protocols).toContain(`${dir}/stage-protocol-${module}.md`);
    }
  });

  test("a Unit reported on its own in a solo walk gets its next step, not an error to show", () => {
    const proj = constructionProject("on");
    next(proj);
    const directive = report(proj, ["--stage", "functional-design", "--unit", "alpha", "--result", "approved", "--user-input", "approve"]);
    expect(directive.kind).toBe("print");
    expect(String(directive.message)).not.toContain("requires Unit Ownership");
    expect(String(directive.message)).toMatch(/run `[^`]*aidlc-orchestrate\.ts next`/);
  });
});

describe("t-rules-travel-with-steps: the notes and their checks", () => {
  test("each note goes only beside its field", () => {
    expect(typeof withAgentNotes).toBe("function");
    const add = withAgentNotes!;
    const stageValidity = {
      state: "drifted", directly_stale: ["requirements-analysis"], needs_revalidation: [], untracked: [],
      earliest_affected_stage: "requirements-analysis", warning: "requirements.md changed after Requirements Analysis finished.",
    };
    const print = add({ kind: "print", message: "x", stage_validity: stageValidity, change_notices: ["A line."] }, "bun x.ts");
    expect(print.stage_validity_note).toBe(
      `${STAGE_VALIDITY_SAY} If their next reply says yes to it, run \`bun x.ts next --stage requirements-analysis\` and follow the step it returns.`,
    );
    // An advisory that names no stage has nothing to redo.
    const unnamed = add({ kind: "print", message: "x", stage_validity: { ...stageValidity, earliest_affected_stage: null } }, "bun x.ts");
    expect(unnamed.stage_validity_note).toBe(STAGE_VALIDITY_SAY);
    expect(print.change_notices_note).toBe(CHANGE_NOTICES_NOTE);
    expect(print.question_note).toBeUndefined();
    expect(add({ kind: "print", message: "x" }, "bun x.ts")).toEqual({ kind: "print", message: "x" });
    // A rules part repeats its run-stage's advisory: it is said from the run-stage, so the part has no note.
    const part = add({ kind: "load-steering", stage: "s", stage_validity: stageValidity, change_notices: ["A line."] }, "bun x.ts");
    expect(part.stage_validity_note).toBeUndefined();
    expect(part.change_notices_note).toBeUndefined();
    // The agent's own recovery work is not a question for the person.
    const own = add({ kind: "ask", ask_type: "guard-recovery", question: "q", agent_work: true }, "bun x.ts");
    expect(own.question_note).toBeUndefined();
    expect(add({ kind: "ask", ask_type: "scope-confirm", question: "q" }, "bun x.ts").question_note).toBe(QUESTION_NOTE);
  });

  test("the validator refuses a note without its field", () => {
    expect(validateDirective({ kind: "print", message: "x", stage_validity_note: STAGE_VALIDITY_SAY }).valid).toBe(false);
    expect(validateDirective({ kind: "print", message: "x", change_notices_note: CHANGE_NOTICES_NOTE }).valid).toBe(false);
    expect(validateDirective({ kind: "print", message: "x", question_note: QUESTION_NOTE }).valid).toBe(false);
    expect(validateDirective({ kind: "print", message: "x", change_notices: ["A line."], change_notices_note: CHANGE_NOTICES_NOTE }).valid).toBe(true);
  });
});

describe("t-rules-travel-with-steps: the Kiro agent prompts", () => {
  const ide = readFileSync(join(REPO, "dist", "kiro-ide", ".kiro", "agents", "aidlc.md"), "utf-8");
  const cli = (JSON.parse(readFileSync(join(REPO, "dist", "kiro", ".kiro", "agents", "aidlc.json"), "utf-8")) as { prompt: string }).prompt;
  for (const [tool, prompt] of [["Kiro IDE", ide], ["Kiro CLI", cli]] as const) {
    test(`${tool}: the must-follow list holds without the skill`, () => {
      expect(prompt).toContain("read .kiro/skills/aidlc/SKILL.md unless the aidlc skill is already in this chat");
      expect(prompt).toContain("say the lines AI-DLC gives you for the person (its warnings, notices and questions) to them word for word");
      expect(prompt).toContain("a question AI-DLC puts to the person is theirs to answer, never yours");
      // Live: "never answer one yourself" alone made the agent ask the person for the work's folder label.
      expect(prompt).toContain("a step AI-DLC hands you (a command to run, a label to choose) is yours to do without asking them");
      expect(prompt).toContain("never guess who changed a file, and never call a person's change stray or a mistake");
    });
  }
});
