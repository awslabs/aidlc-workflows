// The answers corpus (tests/fixtures/aidlc-answers/corpus.json): every question AI-DLC asks the person, and replies
// labelled with what the person means. The fixture mechanics its two checks share: one project state per question
// (the question open, exactly as a run leaves it), the person's reply through each host's own human-turn hook (typed,
// after /aidlc, or picked in the question box), what the engine's tools recorded from it, and the agent's answer
// command that puts the person's words on the record beside the choice it read. The unit check
// (tests/unit/t-aidlc-answers-corpus.test.ts) runs every item; the live check drives a sample through real agents.
// Shared mechanics (exec, env, next, say, the message record, six of the states) come from aidlc-input-corpus.ts.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import corpus from "../fixtures/aidlc-answers/corpus.json";
import { AIDLC_SRC, FIXTURES_DIR, REPO_ROOT, createOrchestrationTestProject, recordArtifactWriteViaHook, seedBoltDag, seededRecordDir, seededStateFile } from "./fixtures.ts";
import {
  LOG, ORCHESTRATE, SESSION, UTILITY, buildState, env, exec, messageRecord, next, say,
  type Directive, type Exec, type Harness, type StoredRecord,
} from "./aidlc-input-corpus.ts";
import { appendAuditEntry } from "../../dist/claude/.claude/tools/aidlc-audit.ts";
import {
  artifactFilename, auditBlockField, findStageBySlug, latestMainWorkflowStageRunFloorForProject, latestPersonTurn,
  personsGateWords, personsLatestGatePick, readActiveDirectiveMarker, readAuditShardEvents, readProtectedResponse,
  reviewArtifactFingerprint, stateDigest, writeActiveDirectiveMarker, writeSessionPidEntry,
} from "../../dist/claude/.claude/tools/aidlc-lib.ts";
import { openPlanApprovalQuestion } from "../../dist/claude/.claude/tools/aidlc-plan-approval-ask.ts";

export type Question =
  | "stage-gate" | "stage-gate-accept-as-is" | "stage-gate-sensor-failure" | "code-plan" | "code-plan-grouped"
  | "unit-checkpoint" | "batch-checkpoint" | "verification-command" | "construction-policy" | "summary-confirmation"
  | "stage-question" | "answer-mode" | "routing" | "plan-offer" | "scope-confirm" | "intent-pick" | "project-type"
  | "unit-paused" | "guard-recovery" | "resume-reentry" | "reopened-stage" | "learnings" | "jump-target";
export type Shown = "picker" | "numbered" | "lettered" | "prose";
export type Via = "chat" | "aidlc" | "codex" | "picker";

export interface EngineExpectation {
  /** The choice a tool may record from this reply alone (`none` when the agent must read it). */
  recorded: string;
  /** The typed text that must be kept verbatim (null for a non-answer, which keeps nothing as a reply). */
  words: string | null;
  /** `recorded`: an exact pick on record; `reading-step`: the question's own print carrying the words (an /aidlc
   * line); `none`: plain chat, nothing to run; `command`: the ask's own command. */
  step: "recorded" | "reading-step" | "none" | "command";
  no_ask: boolean;
  never?: string[];
}
export interface EndExpectation {
  recorded: string;
  words: boolean;
  set?: Array<[string, string]>;
  parked?: boolean;
  change?: string;
  work?: "new" | "same";
  asks: number;
  asks_up_to?: true;
  says: string[];
}
export interface AnswersItem {
  id: string;
  question: Question;
  shown: Shown;
  via: Via;
  input: string;
  picker?: { question: string; options: string[]; answer: string | null };
  argv?: Record<string, string[]>;
  meaning: string;
  reader: "tool" | "agent";
  ambiguous?: true;
  after?: string;
  unsure?: true;
  expected: { engine: EngineExpectation; end: EndExpectation };
}

export const ANSWERS = corpus as AnswersItem[];
export const QUESTIONS = [...new Set(ANSWERS.map((item) => item.question))];
/** Questions with no fixture yet: their items are reported as skipped with this reason. */
export const NO_FIXTURE: Partial<Record<Question, string>> = {
  "code-plan-grouped": "needs a swarm fixture (t340's publish + two plans); not built yet",
  "batch-checkpoint": "needs a swarm fixture with a converged batch (t343's prepare + converge); not built yet",
};

const coreTool = (name: string) => readFileSync(join(AIDLC_SRC, "tools", name), "utf-8");
/** Whether the change an `after` item waits for is in this source. */
export const LANDED: Record<string, () => boolean> = {
  "#2276": () => !coreTool("aidlc-orchestrate.ts").includes("numericChoices"),
  WO2b: () => false,
  WO3: () => !coreTool("aidlc-lib.ts").includes("parseTypedGuardSwitchRequest"),
  pending: () => false,
};
const landed = new Map<string, boolean>();
export function waitsFor(item: AnswersItem): string | null {
  if (item.after === undefined) return null;
  const check = LANDED[item.after];
  if (check === undefined) throw new Error(`${item.id}: unknown after "${item.after}" (add it to LANDED)`);
  if (!landed.has(item.after)) landed.set(item.after, check());
  return landed.get(item.after) ? null : item.after;
}

export const STAGE = "requirements-analysis";
const DASH = "\u2014";
const CMD_SESSION = "01995000-7a11-7000-8000-00000000d0c1";
const STATE = join(AIDLC_SRC, "tools", "aidlc-state.ts");
const BOLT = join(AIDLC_SRC, "tools", "aidlc-bolt.ts");
const midInception = () => readFileSync(join(FIXTURES_DIR, "state-mid-inception.md"), "utf-8");
const stageDir = (proj: string) => join(seededRecordDir(proj), "inception", STAGE);
const questionsFile = (proj: string) => join(stageDir(proj), `${STAGE}-questions.md`);

function writeStageFiles(proj: string, summary: boolean): void {
  const dir = stageDir(proj);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "requirements.md"), "# Requirements\n\n## Overview\n\nA to-do app whose titles are never blank.\n\n## Functional Requirements\n\n- FR-1: a blank title is refused.\n", "utf-8");
  writeFileSync(questionsFile(proj),
    "# Questions\n\n## Q1\n\nShould a blank title be refused?\n\n[Answer]: Yes\n" +
      (summary ? "\n## Consolidated Summary Confirmation\n\nDoes this all look correct before I generate the artifact?\n\n- Looks correct\n- Request changes\n\n[Answer]: \n" : ""),
    "utf-8");
}

async function tool(proj: string, path: string, args: string[], extra: Record<string, string | undefined> = {}): Promise<Exec> {
  const result = await exec([process.execPath, path, ...args, "--project-dir", proj], { cwd: proj, env: { ...env(proj), ...extra } });
  if (result.status !== 0) throw new Error(`${args.slice(0, 3).join(" ")} failed: ${result.stdout}${result.stderr}`);
  return result;
}
/** The agent logs a question before showing it (`log decision`), as the stage protocol says. */
async function askInChat(proj: string, decision: string, options: string, extra: string[] = []): Promise<void> {
  await tool(proj, LOG, ["decision", "--stage", STAGE, "--decision", decision, "--options", options, ...extra]);
}
function workOpen(proj: string): void {
  writeFileSync(seededStateFile(proj), midInception(), "utf-8");
  appendAuditEntry("STAGE_STARTED", { Stage: STAGE }, proj);
}

const C_STAGES = ["functional-design", "nfr-requirements", "nfr-design", "infrastructure-design", "code-generation"];
/** A feature at Construction with two Units and checkpoints on, as t342 builds it. */
function constructionFixture(proj: string, current = "functional-design"): void {
  writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking
## Project Information
- **Project**: Answers corpus
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
- **Review Override**: none
- **Change Control**: strict
## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard
## Stage Progress
### CONSTRUCTION PHASE
${C_STAGES.map((stage) => `- [${stage === current ? "-" : " "}] ${stage} ${DASH} EXECUTE`).join("\n")}
- [ ] build-and-test ${DASH} EXECUTE
## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: ${current}
- **Status**: Running
`, "utf-8");
  seedBoltDag(proj, ["alpha", "beta"]);
  mkdirSync(join(proj, "src"), { recursive: true });
  for (const unit of ["alpha", "beta"]) writeFileSync(join(proj, "src", `${unit}.ts`), `export const ${unit} = 1;\n`, "utf-8");
  appendAuditEntry("WORKFLOW_STARTED", { Scope: "feature" }, proj);
}
/** Every Construction stage done for `unit`, with its artifacts and receipts (t342's cover). */
function cover(proj: string, unit: string): void {
  for (const slug of C_STAGES) {
    const stage = findStageBySlug(slug)!;
    const output = join(seededRecordDir(proj), "construction", unit, slug);
    mkdirSync(output, { recursive: true });
    for (const name of stage.produces ?? []) writeFileSync(join(output, artifactFilename(name)), `# ${unit} ${name}\n`, "utf-8");
    if (stage.workspace_requires) {
      writeFileSync(join(output, "source-manifest.json"), JSON.stringify({ stage: slug, unit, version: 1, writes: [{ path: `src/${unit}.ts` }] }), "utf-8");
    }
    const fingerprint = reviewArtifactFingerprint(proj, stage, unit, { requireRequiredArtifacts: true });
    if (fingerprint === null) throw new Error(`no artifact fingerprint for ${unit} ${slug}`);
    appendAuditEntry("UNIT_COMPLETED", {
      Stage: slug, Unit: unit, Mode: "wave",
      "Run floor": latestMainWorkflowStageRunFloorForProject(proj, slug, true, unit),
      "Artifact Fingerprint": fingerprint,
    }, proj);
  }
}
/** The verification command approved and set, by another chat, as t342 records it. */
async function recordVerificationCommand(proj: string): Promise<string> {
  const script = join(seededRecordDir(proj), "check.cjs");
  writeFileSync(script, "const fs=require('node:fs'); for(const unit of ['alpha','beta']) if(!fs.readFileSync('src/'+unit+'.ts','utf8').includes(unit))process.exit(1);", "utf-8");
  const quote = (value: string) => process.platform === "win32" ? `"${value.replaceAll('"', '""')}"` : `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const identity = ["--stage", "code-generation", "--checkpoint", "verification-command", "--command", command, "--session", CMD_SESSION];
  const skip = { AIDLC_SKIP_HUMAN_PRESENCE_GUARD: "1" };
  await tool(proj, LOG, ["decision", ...identity, "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"], skip);
  await say(proj, "Approve", "claude", { session: CMD_SESSION });
  await tool(proj, LOG, ["answer", ...identity, "--details", "Approve"], skip);
  await tool(proj, STATE, ["set-construction-verification-command", command], skip);
  return command;
}

/** A project at the state where `question` is open, exactly as a run leaves it. `proj` holds the engine already. */
export async function buildQuestion(proj: string, question: Question): Promise<void> {
  switch (question) {
    case "stage-gate":
      return buildState(proj, "gate-open");
    case "stage-gate-accept-as-is": {
      await buildState(proj, "gate-open");
      const file = seededStateFile(proj);
      writeFileSync(file, readFileSync(file, "utf-8").replace("- **Revision Count**: 0", "- **Revision Count**: 3"), "utf-8");
      return;
    }
    case "stage-gate-sensor-failure":
      // The report refused on a blocking sensor, so the gate is NOT open (stage-protocol.md:385): the stage still runs
      // and the agent asks the two-option question.
      workOpen(proj);
      writeStageFiles(proj, false);
      return askInChat(proj, "Blocking gate sensor failure", "Fix findings,Override blocking sensors");
    case "code-plan":
      return buildState(proj, "plan-question-open");
    case "unit-checkpoint": {
      constructionFixture(proj);
      cover(proj, "alpha");
      cover(proj, "beta");
      await recordVerificationCommand(proj);
      const verify = ["checkpoint", "--unit", "alpha", "--kind", "unit"];
      const checked = await tool(proj, BOLT, [...verify, "--action", "verify"]);
      if (!JSON.parse(checked.stdout).verified) throw new Error(`checkpoint not verified: ${checked.stdout}`);
      await tool(proj, BOLT, [...verify, "--action", "ask", "--session", SESSION]);
      return;
    }
    case "verification-command":
      constructionFixture(proj);
      await tool(proj, LOG, ["decision", "--stage", "code-generation", "--checkpoint", "verification-command", "--command", "npm test", "--session", SESSION,
        "--decision", "Use this command to verify each completed Unit?", "--options", "Approve,Request Changes"]);
      return;
    case "construction-policy":
      constructionFixture(proj);
      await tool(proj, LOG, ["decision", "--stage", "functional-design", "--checkpoint", "construction-policy", "--field", "Construction Execution", "--value", "swarm",
        "--session", SESSION, "--decision", "Switch Construction to build the Units in parallel (swarm)?", "--options", "Approve,Request Changes"]);
      return;
    case "summary-confirmation":
      workOpen(proj);
      writeStageFiles(proj, true);
      recordArtifactWriteViaHook(proj, questionsFile(proj));
      await tool(proj, LOG, ["decision", "--checkpoint", "summary-confirmation", "--stage", STAGE, "--questions-file", questionsFile(proj),
        "--decision", "Does this all look correct?", "--options", "Looks correct,Request changes"]);
      return;
    case "stage-question":
      workOpen(proj);
      writeStageFiles(proj, false);
      return askInChat(proj, "Which database should the to-do app use?", "PostgreSQL,SQLite,Other");
    case "answer-mode":
      workOpen(proj);
      return askInChat(proj, "How would you like to answer the questions?", "Guide me,I'll edit the file,Chat");
    case "routing":
      return buildState(proj, "routing-question-open");
    case "plan-offer":
      return buildState(proj, "plan-offer-open");
    case "scope-confirm": {
      await say(proj, "/aidlc fix the login timeout", "claude");
      const offer = await next(proj, ["fix", "the", "login", "timeout"]);
      if (offer.directive?.ask_type !== "scope-confirm") throw new Error(`scope confirmation did not open: ${offer.out}`);
      return;
    }
    case "intent-pick":
      return buildState(proj, "kiro-pick");
    case "project-type": {
      await tool(proj, UTILITY, ["intent-create", "--scope", "classic", "--arguments", "show the asset description on hover"]);
      const repo = join(proj, "ui-repo");
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "ui-repo", dependencies: { react: "18.0.0" } }), "utf-8");
      writeFileSync(join(repo, "src", "App.tsx"), "export const App = () => null;\n", "utf-8");
      const init = await exec(["git", "init", "-q", repo], { cwd: proj, env: process.env });
      if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
      // The person comes back to the work (a turn of theirs, so the engine runs) and the engine asks.
      await say(proj, "/aidlc", "claude");
      const asked = await next(proj, []);
      if (asked.directive?.ask_type !== "project-type") throw new Error(`project type question did not open: ${asked.out}`);
      return;
    }
    case "unit-paused": {
      writeFileSync(seededStateFile(proj), `# AI-DLC State Tracking

## Project Information
- **Project**: Answers corpus
- **Project Type**: Greenfield
- **Scope**: feature
- **State Version**: 8
- **Skeleton Stance**: on
- **Construction Iteration**: unit-major

## Runtime State
- **Revision Count**: 0

## Scope Configuration
- **Stages to Execute**: all
- **Stages to Skip**: none
- **Depth**: Standard
- **Test Strategy**: Standard

## Stage Progress

### CONSTRUCTION PHASE
- [-] functional-design ${DASH} EXECUTE
- [S] nfr-requirements ${DASH} EXECUTE
- [S] nfr-design ${DASH} EXECUTE
- [S] infrastructure-design ${DASH} EXECUTE
- [S] code-generation ${DASH} EXECUTE

## Current Status
- **Lifecycle Phase**: CONSTRUCTION
- **Current Stage**: functional-design
- **Status**: Running
- **Last Updated**: 2026-07-30T00:00:00Z
`, "utf-8");
      seedBoltDag(proj, ["unit-a", "unit-b"]);
      const unit = ["unit", "--stage", "functional-design", "--unit", "unit-a"];
      await tool(proj, STATE, [unit[0], "start", ...unit.slice(1)]);
      await tool(proj, STATE, [unit[0], "pause", ...unit.slice(1), "--reason", "blocked on auth contract", "--next-action", "confirm token flow"]);
      const asked = await next(proj, []);
      if (asked.directive?.ask_type !== "unit-paused") throw new Error(`paused Unit question did not open: ${asked.out}`);
      return;
    }
    case "guard-recovery": {
      workOpen(proj);
      const state = readFileSync(seededStateFile(proj), "utf-8");
      writeActiveDirectiveMarker(proj, {
        kind: "ask", stage: STAGE, ask_type: "guard-recovery", state_sha256: stateDigest(state),
        remedies: [
          { op: "finish-revision", label: "Finish the revision and show the gate again", action: "Finish the revision and show the gate again.", interaction: "external-work" },
          { op: "request-changes", label: "Request Changes", action: "Ask what should change.", interaction: "human-input" },
        ],
      });
      return;
    }
    case "resume-reentry":
    case "jump-target":
      workOpen(proj);
      return;
    case "reopened-stage":
      workOpen(proj);
      writeStageFiles(proj, false);
      return askInChat(proj, "Requirements Analysis already has requirements.md. Keep it, modify it, or redo it from scratch?", "Keep,Modify,Redo from scratch");
    case "learnings":
      workOpen(proj);
      return askInChat(proj, "Anything to add for next time?", "Nothing to add,Add a note");
    case "code-plan-grouped":
    case "batch-checkpoint":
      throw new Error(NO_FIXTURE[question]);
  }
}
/** One built fixture per question, copied for each item: the states are heavier than the input corpus's, and a copy
 * is byte-identical to a build (the engine keys everything on the project folder). */
const templates = new Map<Question, Promise<string>>();
export async function projectAt(question: Question): Promise<string> {
  if (!templates.has(question)) {
    templates.set(question, (async () => {
      const proj = createOrchestrationTestProject();
      await buildQuestion(proj, question);
      return proj;
    })());
  }
  const template = await templates.get(question)!;
  const proj = createOrchestrationTestProject();
  rmSync(proj, { recursive: true, force: true });
  cpSync(template, proj, { recursive: true });
  return proj;
}
/** The templates, for the caller's cleanup. */
export function templateProjects(): string[] {
  return [...templates.values()].map((promise) => {
    let value = "";
    promise.then((proj) => { value = proj; }).catch(() => undefined);
    return value;
  }).filter(Boolean);
}

/** What the person typed, as the host hands it to the hook (the entry word for an /aidlc or $aidlc line). */
export function typedPrompt(item: AnswersItem): string {
  if (item.via === "aidlc") return `/aidlc ${item.input}`.trim();
  if (item.via === "codex") return `$aidlc ${item.input}`.trim();
  return item.input;
}
/** The argv `next` gets for an /aidlc line, per way a host splits it. */
export function argvVariants(item: AnswersItem): Array<[string, string[]]> {
  const variants: Array<[string, string[]]> = [["posix", item.input.split(/\s+/).filter(Boolean)]];
  for (const [name, argv] of Object.entries(item.argv ?? {})) variants.push([name, argv]);
  return variants;
}
export const PICKER_HARNESSES: Harness[] = ["claude", "codex"];

/** The person picks in the question box: the host's tool envelope reaches the hook (Claude AskUserQuestion PostToolUse,
 * Codex request_user_input through its adapter). */
export async function pick(proj: string, item: AnswersItem, harness: Harness): Promise<Exec> {
  const picker = item.picker!;
  const answered = picker.answer !== null && picker.answer !== "";
  if (harness === "claude") {
    const input = {
      hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", session_id: SESSION, cwd: proj,
      tool_input: { questions: [{ question: picker.question, header: "Question", multiSelect: false, options: picker.options.map((label) => ({ label, description: "" })) }] },
      tool_response: { answers: answered ? { [picker.question]: picker.answer } : {} },
    };
    return exec([process.execPath, join(AIDLC_SRC, "tools", "aidlc.ts"), "engine", "hook", "record-human-turn"], { cwd: proj, env: env(proj), input: JSON.stringify(input) });
  }
  const codexTree = join(proj, ".codex");
  if (!existsSync(codexTree)) cpSync(join(REPO_ROOT, "dist", "codex", ".codex"), codexTree, { recursive: true });
  writeSessionPidEntry(proj, process.pid, SESSION);
  const input = {
    hook_event_name: "PostToolUse", tool_name: "request_user_input", session_id: SESSION, turn_id: "t1", cwd: proj,
    tool_input: { questions: [{ id: "q1", header: "Question", question: picker.question, options: picker.options.map((label) => ({ label, description: "" })) }] },
    tool_response: JSON.stringify({ answers: answered ? { q1: { answers: [picker.answer] } } : {} }),
  };
  const unset = { ...env(proj), CLAUDE_PROJECT_DIR: undefined, USER_PROMPT: undefined, CODEX_THREAD_ID: undefined, CODEX_SESSION_ID: undefined };
  return exec([process.execPath, join(codexTree, "hooks", "aidlc-codex-adapter.ts"), "record-human-turn"], { cwd: proj, env: unset, input: JSON.stringify(input) });
}

// --- what the tools recorded -------------------------------------------------------------------------------------------

export interface Recorded { choice: string; words: string | null }
/** The choice a tool recorded from the reply alone (`none` when nothing is recorded) and the words it kept. */
export function recorded(proj: string, item: AnswersItem): Recorded {
  // The person's words as the record keeps them: the latest turn's words, else the message record's text (a picker
  // reply and a reply to an engine question are kept there, marked as a command turn).
  const turn = latestPersonTurn(proj)?.words ?? messageRecord(proj, typedPrompt(item))?.text ?? null;
  switch (item.question) {
    case "stage-gate":
    case "stage-gate-accept-as-is": {
      const gate = { stage: STAGE };
      const pickLabel = personsLatestGatePick(proj, SESSION, gate, item.question === "stage-gate-accept-as-is");
      return { choice: pickLabel ?? "none", words: personsGateWords(proj, SESSION, gate) };
    }
    case "code-plan": {
      const open = openPlanApprovalQuestion(proj, item.input);
      if (open === null) return { choice: "unknown", words: turn };
      if (open.editing) return { choice: "I'll edit the files", words: turn };
      if (!open.answered) return { choice: "none", words: turn };
      return { choice: open.picked === "approve" ? "Approve Plan" : open.picked === "request-changes" ? "Request Changes" : open.picked === "edit" ? "I'll edit the files" : "answered", words: turn };
    }
    case "unit-checkpoint":
    case "verification-command":
    case "construction-policy": {
      const response = readProtectedResponse(proj, SESSION);
      return { choice: response?.choice ?? "none", words: response?.words ?? null };
    }
    case "guard-recovery": {
      const marker = readActiveDirectiveMarker(proj, readFileSync(seededStateFile(proj), "utf-8"));
      const selected = marker?.guard_recovery_response?.selected_op ?? null;
      const label = selected === null ? null : (marker?.remedies ?? []).find((remedy) => remedy.op === selected)?.label ?? selected;
      return { choice: label ?? "none", words: turn };
    }
    default:
      return { choice: "none", words: turn };
  }
}

/** Audit rows of `event` in order. */
export function rows(proj: string, event: string): Array<Record<string, string | null>> {
  return readAuditShardEvents(proj).filter((row) => row.event === event).map((row) => ({
    event: row.event,
    "User Input": auditBlockField(row.block, "User Input"),
    "Person Reply": auditBlockField(row.block, "Person Reply"),
    Details: auditBlockField(row.block, "Details"),
    Feedback: auditBlockField(row.block, "Feedback"),
    Reply: auditBlockField(row.block, "Reply"),
    Decision: auditBlockField(row.block, "Decision"),
    Choice: auditBlockField(row.block, "Choice"),
  }));
}
/** The events that would mean a choice was recorded for the person. */
export const CHOICE_EVENTS = ["GATE_APPROVED", "GATE_REJECTED", "QUESTION_ANSWERED", "PLAN_APPROVAL_RECORDED", "REQUEST_ROUTED", "ARTIFACT_REUSED"];
export function choiceRowCount(proj: string): number {
  return readAuditShardEvents(proj).filter((row) => CHOICE_EVENTS.includes(row.event)).length;
}

// --- the agent records the choice it read ------------------------------------------------------------------------------

/** The agent's answer command for `choice` at this question, as the skills and the engine's prints name it. The
 * person's words are already on record (the hook kept them); the command carries only the exact choice (and what to
 * change, when the person did not say it in their own words). Returns the audit event the record lands on, or null
 * when this question has no recording command of its own. */
export async function recordByAgent(proj: string, item: AnswersItem, choice: string): Promise<{ event: string; exec: Exec } | null> {
  const log = (args: string[]) => exec([process.execPath, LOG, "answer", "--project-dir", proj, ...args], { cwd: proj, env: env(proj) });
  // The answer command names the row it wrote (`emitted`); the row differs by choice (an Approve of a verification
  // command is VERIFICATION_COMMAND_RECORDED, a change request QUESTION_ANSWERED).
  const emitted = (result: Exec, fallback: string): { event: string; exec: Exec } => {
    const line = result.stdout.trim().split("\n").findLast((l) => l.startsWith("{"));
    try {
      const parsed = line ? JSON.parse(line) as { emitted?: string } : {};
      return { event: parsed.emitted ?? fallback, exec: result };
    } catch {
      return { event: fallback, exec: result };
    }
  };
  switch (item.question) {
    case "stage-gate":
    case "stage-gate-accept-as-is": {
      const approved = choice === "Approve" || choice === "Accept as-is";
      const args = ["report", "--stage", STAGE, "--result", approved ? "approved" : "rejected", "--user-input", choice,
        ...(item.expected.end.parked ? ["--park"] : []), "--project-dir", proj];
      const result = await exec([process.execPath, ORCHESTRATE, ...args], { cwd: proj, env: env(proj) });
      return { event: approved ? "GATE_APPROVED" : "GATE_REJECTED", exec: result };
    }
    case "code-plan":
      // Approve Plan writes PLAN_APPROVAL_RECORDED; Request Changes and the edit choice land on the ask record only.
      return { event: choice === "Approve Plan" ? "PLAN_APPROVAL_RECORDED" : "", exec: await log(["--stage", "code-generation", "--checkpoint", "plan-approval", "--details", choice]) };
    case "unit-checkpoint": {
      const approved = choice === "Approve";
      const args = ["checkpoint", "--unit", "alpha", "--kind", "unit", "--action", approved ? "approve" : "reject", "--session", SESSION, "--user-input", item.input, "--project-dir", proj];
      const result = await exec([process.execPath, BOLT, ...args], { cwd: proj, env: env(proj) });
      return { event: approved ? "GATE_APPROVED" : "GATE_REJECTED", exec: result };
    }
    case "verification-command":
      return emitted(await log(["--stage", "code-generation", "--checkpoint", "verification-command", "--command", "npm test", "--session", SESSION, "--details", choice]), "QUESTION_ANSWERED");
    case "construction-policy":
      return emitted(await log(["--stage", "functional-design", "--checkpoint", "construction-policy", "--field", "Construction Execution", "--value", "swarm", "--session", SESSION, "--details", choice]), "QUESTION_ANSWERED");
    case "summary-confirmation": {
      const file = questionsFile(proj);
      writeFileSync(file, readFileSync(file, "utf-8").replace(/\[Answer\]: \n$/, `[Answer]: ${choice}\n`), "utf-8");
      recordArtifactWriteViaHook(proj, file, "Edit");
      const details = choice === "Request changes" ? `Request changes: ${item.input}` : choice;
      return emitted(await log(["--checkpoint", "summary-confirmation", "--stage", STAGE, "--questions-file", file, "--details", details]), "QUESTION_ANSWERED");
    }
    case "stage-gate-sensor-failure":
    case "stage-question":
    case "answer-mode":
    case "learnings":
      return emitted(await log(["--stage", STAGE, "--details", choice]), "QUESTION_ANSWERED");
    case "reopened-stage": {
      const decision = choice === "Redo from scratch" || choice === "redo" ? "redo" : choice.toLowerCase();
      const result = await exec([process.execPath, STATE, "reuse-artifact", STAGE, "--decision", decision, "--artifacts", "requirements.md", "--project-dir", proj], { cwd: proj, env: env(proj) });
      return { event: "ARTIFACT_REUSED", exec: result };
    }
    case "guard-recovery": {
      // The recovery choice lands on the ask's marker, not on an audit row (no event to look for).
      const op = choice === "Request Changes" ? "request-changes" : "finish-revision";
      return { event: "", exec: await log(["--stage", STAGE, "--checkpoint", "guard-recovery", "--details", op]) };
    }
    default:
      return null;
  }
}

export { messageRecord, next, say, exec, env, SESSION, type Directive, type Exec, type Harness, type StoredRecord };
