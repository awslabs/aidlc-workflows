// The engine-held Plan Approval question.
//
// Plan Approval used to be a ritual the conductor carried by hand: run a
// fingerprint command, paste its tags under an exact heading, record a
// session-keyed decision, wait, copy the recorded choice back, record a
// session-keyed answer. Every link could break, and the guard that protects
// code generation then blocked the commands needed to repair it.
//
// Now the engine asks. `next` notices that a Code Generation plan is ready and
// not yet approved and emits a `plan-approval` ask instead of the build
// run-stage. The human-turn hook reads the person's reply in their own words,
// takes the fingerprint of the files as they are at that moment, writes the
// questions file, the receipt, and the PLAN_APPROVAL_RECORDED row, and the next
// `next` builds. The conductor only shows the question and runs `next`.
//
// The receipt, its key, the questions-file tags, and the audit row keep the
// exact shape the old ritual produced, so everything that reads an approval
// (generation start, the worker brief, the swarm, team merge, worktree
// delegation) reads this one unchanged. What changed is who writes them.

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  activeIntentUuid,
  auditBlockField,
  claimAttemptFields,
  collectStalePlanApprovalReceipts,
  getField,
  latestMainWorkflowStageRunFloorForProject,
  PLAN_APPROVAL_ASK_TYPE,
  planApprovalRuntimeFile,
  readActiveDirectiveMarker,
  readAuditShardEvents,
  readPlanApprovalRuntimeRecord,
  removePlanApprovalRuntimeRecord,
  stalePlanApprovalReceiptsForTarget,
  stateFilePath,
  toPosix,
  withActiveDirectiveLock,
  withAuditLock,
  workspaceSourceFailureSuffix,
  workspaceSourceState,
  writeFileAtomic,
  writePlanApprovalReceipt,
  writePlanApprovalRuntimeRecord,
  writeWorkspaceSourceSnapshot,
  type ActiveDirectiveMarker,
  type PlanApprovalRuntimeReceipt,
} from "./aidlc-lib.ts";
import {
  approvalFingerprint,
  codeGenerationExecutionAllowed,
  codeGenerationRecordDir,
  codeGenerationTargetId,
  evaluateCodeGenerationApproval,
  interpretPlanApprovalReply,
  PlanApprovalUnbindableError,
  readTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
  testingContractDefectMessage,
  usableTestingContract,
  type PlanApprovalPickerQuestion,
} from "./aidlc-testing-posture.ts";
import { aidlcToolInvocation } from "./aidlc-runtime-paths.ts";
import type {
  CodeGenerationPlanApprovalState,
  CodeGenerationPlanUnitState,
  Directive,
  InvokeSwarmDirective,
  PlanApprovalAskDirective,
  PlanApprovalAskTargetView,
  RunStageDirective,
} from "./aidlc-directive.ts";

// --- The protected record ------------------------------------------------------
//
// The question lives in the same protected runtime directory as the receipts,
// so no model tool can write it. The active-directive marker only carries the
// question to the conductor; the hook reads the reply against THIS record. One
// open question per intent: a new one replaces the old.

export interface PlanApprovalAskTarget {
  unit: string | null;
  targetId: string;
  /** The fingerprint of the plan, instructions, and contract when asked. */
  fingerprint: string;
}

export interface PlanApprovalAskResult {
  unit: string | null;
  choice: "approve" | "request-changes" | "repair";
  /** The fingerprint the answer was given for. */
  fingerprint: string;
  /** The person's own words for a change request, kept verbatim. */
  feedback?: string;
  /** What the conductor must repair before asking again. */
  note?: string;
}

export interface PlanApprovalAskRecord {
  version: 1;
  askId: string;
  intentId: string;
  targets: PlanApprovalAskTarget[];
  /** The picker question; a picker reply answers only this question. */
  question: string;
  choices: string[];
  /** "editing": the person said they would edit the files and has not said done. */
  mode: "ask" | "editing";
  /** True until the first reply after the question is shown: only then does a bare yes answer it. */
  bound: boolean;
  issuedAt: string;
  /** What the hook made of the latest reply that recorded nothing. */
  lastNotice?: string;
  /** A grouped change request that named no Unit, waiting for "which one". */
  pendingChange?: string;
  results?: PlanApprovalAskResult[];
}

function askPath(projectDir: string, intentId: string): string {
  const key = createHash("sha256").update(intentId, "utf-8").digest("hex").slice(0, 24);
  return planApprovalRuntimeFile(projectDir, `ask-${key}.json`);
}

export function readPlanApprovalAsk(projectDir: string, intentId: string): PlanApprovalAskRecord | null {
  const value = readPlanApprovalRuntimeRecord<PlanApprovalAskRecord>(
    askPath(projectDir, intentId),
    "Plan Approval question",
  );
  return value?.version === 1 && value.intentId === intentId &&
    typeof value.askId === "string" && /^[a-f0-9]{32}$/.test(value.askId) &&
    Array.isArray(value.targets) && value.targets.length > 0 &&
    typeof value.question === "string" && Array.isArray(value.choices) &&
    (value.mode === "ask" || value.mode === "editing")
    ? value : null;
}

function writePlanApprovalAsk(projectDir: string, record: PlanApprovalAskRecord): void {
  writePlanApprovalRuntimeRecord(
    projectDir,
    askPath(projectDir, record.intentId),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

// "Review the plan" from the person, for a target that would otherwise keep
// building: the next `next` asks for approval again before anything else runs.
function reviewRequestPath(projectDir: string, targetId: string): string {
  const key = createHash("sha256").update(targetId, "utf-8").digest("hex").slice(0, 24);
  return planApprovalRuntimeFile(projectDir, `review-request-${key}.json`);
}

function requestPlanApprovalReview(projectDir: string, targetId: string, intentId: string): void {
  writePlanApprovalRuntimeRecord(
    projectDir,
    reviewRequestPath(projectDir, targetId),
    `${JSON.stringify({ version: 1, targetId, intentId, requestedAt: new Date().toISOString() })}\n`,
  );
}

export function planApprovalReviewRequested(projectDir: string, targetId: string, intentId: string): boolean {
  const value = readPlanApprovalRuntimeRecord<{ version: number; targetId: string; intentId: string }>(
    reviewRequestPath(projectDir, targetId),
    "Plan Approval review request",
  );
  return value?.version === 1 && value.targetId === targetId && value.intentId === intentId;
}

function clearPlanApprovalReviewRequest(projectDir: string, targetId: string): void {
  removePlanApprovalRuntimeRecord(reviewRequestPath(projectDir, targetId));
}

const STAGE = "code-generation";
const PLAN_FILE = "code-generation-plan.md";
const INSTRUCTIONS_FILE = "unit-test-instructions.md";
const QUESTIONS_FILE = "code-generation-questions.md";

export const PLAN_APPROVAL_CHOICES = ["Approve Plan", "Request Changes", "I'll edit the files"] as const;
export const GROUPED_PLAN_APPROVAL_CHOICES = ["Approve all", "Request Changes", "I'll edit the files"] as const;

// The engine's answer marks in the questions file. Team merge reads the
// lettered approval; every other reader accepts it too.
const APPROVED_ANSWER = "A. Approve Plan";
const CHANGES_ANSWER = "B. Request Changes";

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

function targetLabel(unit: string | null): string {
  return unit ?? "this piece of work";
}

function labels(units: Array<string | null>): string {
  const names = units.map(targetLabel);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// --- Is the plan ready to be approved? ---------------------------------------
//
// The engine never asks a question it could not accept: an Approve on a plan
// whose Testing Contract is missing, broken, or out of date would record
// nothing. So those are repairs to finish first, each named in one sentence.

export type PlanReadiness = { ready: true } | { ready: false; note?: string };

export function codeGenerationPlanReadiness(projectDir: string, unit: string | null): PlanReadiness {
  const dir = codeGenerationRecordDir(projectDir, unit);
  const plan = readText(join(dir, PLAN_FILE));
  const instructions = readText(join(dir, INSTRUCTIONS_FILE));
  // Not started yet: plain planning, nothing to say.
  if (!plan.trim() && !instructions.trim()) return { ready: false };
  if (!plan.trim()) return { ready: false, note: `${PLAN_FILE} is missing or empty: write the plan, then run next.` };
  if (!instructions.trim()) {
    return { ready: false, note: `${INSTRUCTIONS_FILE} is missing or empty: write it beside the plan, then run next.` };
  }
  const read = readTestingContract(plan);
  if ("defect" in read) {
    return { ready: false, note: testingContractDefectMessage(read.defect, read.detail, "run next") };
  }
  const current = resolveTestingPosture(projectDir);
  if (read.contract.contract_sha256 !== current.contract_sha256) {
    return {
      ready: false,
      note: "The plan's Testing Contract is out of date: memory, scope, test strategy, project type, or the " +
        `installed AIDLC version changed since it was rendered. Run \`${aidlcToolInvocation("testing-posture")} render\`, ` +
        "replace the whole `## Testing Contract` section with its output, then run next.",
    };
  }
  if (!usableTestingContract(read.contract)) {
    return {
      ready: false,
      note: "The plan's Testing Contract has missing or inconsistent executable fields. Re-render it and replace " +
        "the whole `## Testing Contract` section, then run next.",
    };
  }
  return { ready: true };
}

// --- What the person sees ----------------------------------------------------

const SUMMARY_HEADING_RE = /^(#{1,6})[ \t]+summary[ \t]*#*[ \t]*$/i;
const HEADING_RE = /^(#{1,6})[ \t]+/;
const TASK_LINE_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[[ xX-]\]/;

/**
 * The few lines the question shows for one plan. Step 2 asks for a
 * `## Summary` section with Builds / Touches / Tests lines; without one, the
 * engine counts plan steps instead of refusing.
 */
export function planSummaryLines(plan: string, instructions: string): string[] {
  const lines = plan.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((line) => SUMMARY_HEADING_RE.test(line.trim()));
  const summary: string[] = [];
  if (start >= 0) {
    const depth = (SUMMARY_HEADING_RE.exec(lines[start].trim())?.[1] ?? "##").length;
    for (const line of lines.slice(start + 1)) {
      const heading = HEADING_RE.exec(line);
      if (heading && heading[1].length <= depth) break;
      const text = line.trim().replace(/^(?:[-*+]|\d+[.)])[ \t]+/, "").trim();
      if (text) summary.push(text.length > 200 ? `${text.slice(0, 197)}...` : text);
      if (summary.length === 5) break;
    }
  }
  if (summary.length > 0) return summary;
  const steps = lines.filter((line) => TASK_LINE_RE.test(line)).length;
  const fallback = [steps === 1 ? "1 plan step" : `${steps} plan steps`];
  if (instructions.trim()) fallback.push(`Tests: see ${INSTRUCTIONS_FILE}`);
  return fallback;
}

function targetView(projectDir: string, unit: string | null): PlanApprovalAskTargetView {
  const dir = codeGenerationRecordDir(projectDir, unit);
  const rel = (name: string) => toPosix(relative(projectDir, join(dir, name)));
  return {
    unit,
    plan_path: rel(PLAN_FILE),
    instructions_path: rel(INSTRUCTIONS_FILE),
    questions_path: rel(QUESTIONS_FILE),
    summary: planSummaryLines(readText(join(dir, PLAN_FILE)), readText(join(dir, INSTRUCTIONS_FILE))),
  };
}

function planQuestion(units: Array<string | null>, repaired: boolean): string {
  if (units.length > 1) {
    return repaired
      ? `I repaired the Testing Contract block. Approve these ${units.length} code plans?`
      : `Approve these ${units.length} code plans?`;
  }
  const unit = units[0] ?? null;
  if (repaired) {
    return unit === null
      ? "I repaired the Testing Contract block. Build your edited plan?"
      : `I repaired the Testing Contract block. Build your edited plan for ${unit}?`;
  }
  return unit === null ? "Approve the code plan?" : `Approve the code plan for ${unit}?`;
}

// The questions file is the record of what was asked and answered. The engine
// writes it; the person may write their answer after `[Answer]:` in edit mode.
function questionsFileContent(
  question: string,
  view: PlanApprovalAskTargetView,
  choices: readonly string[],
  fingerprint: string,
  plannedSource: string,
  answer: string,
): string {
  return [
    "# Code Generation Plan Approval",
    "",
    "AI-DLC writes this file when it asks you to approve the plan. To answer here",
    "instead of in chat, write your answer after `[Answer]:` and say done.",
    "",
    "## Plan Approval",
    "",
    question,
    "",
    ...view.summary.map((line) => `- ${line}`),
    "",
    `Full plan: ${view.plan_path}`,
    `Test instructions: ${view.instructions_path}`,
    "",
    `[Approval Fingerprint]: ${fingerprint}`,
    `[Planned Source]: ${plannedSource}`,
    "",
    ...choices.map((choice, index) => `- ${String.fromCharCode(65 + index)}. ${choice}`),
    "",
    `[Answer]:${answer ? ` ${answer}` : ""}`,
    "",
  ].join("\n");
}

function promptSha256(questions: string): string {
  return createHash("sha256")
    .update(`${questions.replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:").trimEnd()}\n`, "utf-8")
    .digest("hex");
}

// What the person wrote after `[Answer]:`. They may type on the line the
// engine left blank, or add their own `[Answer]:` line elsewhere (under a
// subheading, say) and leave the blank one in place: the last line they
// filled in is their answer, never a blank one after it.
function answerLine(questions: string): string | null {
  const written = [...questions.matchAll(/^\[Answer\]:[ \t]*(.*)$/gm)]
    .map((match) => (match[1] ?? "").trim())
    .filter((answer) => answer.length > 0);
  return written.length > 0 ? written[written.length - 1] : null;
}

// --- Routing: plan, ask, or build --------------------------------------------

type TargetState =
  | { unit: string | null; kind: "approved" }
  | { unit: string | null; kind: "ask"; repaired: boolean }
  | { unit: string | null; kind: "plan" | "revise" | "repair"; note?: string; feedback?: string };

function intentIdFor(projectDir: string): string {
  try {
    const state = readFileSync(stateFilePath(projectDir), "utf-8");
    const marker = readActiveDirectiveMarker(projectDir, state);
    if (marker?.version === 2) return marker.intent_uuid ?? "bare-space";
  } catch {
    // Fall through to the registry.
  }
  return activeIntentUuid(projectDir) ?? "bare-space";
}

/** A code-generation beat that plans or builds, as opposed to a gate or checkpoint beat. */
export function isPlanApprovalBeat(directive: Directive): directive is RunStageDirective | InvokeSwarmDirective {
  if (directive.kind === "run-stage") {
    return directive.stage === STAGE &&
      directive.swarm_settled !== true &&
      directive.gate_only !== true &&
      directive.construction_checkpoint === undefined &&
      directive.swarm_checkpoint === undefined &&
      directive.construction_policy?.completion_only !== true &&
      directive.legacy_plan_approval_choices === undefined;
  }
  return directive.kind === "invoke-swarm" &&
    (directive.stage ?? STAGE) === STAGE &&
    directive.legacy_plan_approval_choices === undefined;
}

/**
 * A rejected gate (the Code Generation completion gate, a Unit checkpoint, or a
 * swarm batch checkpoint) starts a new attempt, so the approval before it no
 * longer counts. While the plan is still exactly the one approved before, the
 * person's rejection is the change to make: the plan is revised first, and the
 * engine asks about the revised plan, never about the one they just sent back.
 */
function rejectionRevision(projectDir: string, unit: string | null, intentId: string): { feedback?: string } | null {
  // Read from the audit trail, not the active directive: `next` routes before
  // it publishes, so the marker may still name the checkpoint that was rejected.
  let targetId: string;
  let runFloor: string;
  try {
    const state = readFileSync(stateFilePath(projectDir), "utf-8");
    targetId = codeGenerationTargetId({ unit });
    runFloor = latestMainWorkflowStageRunFloorForProject(
      projectDir, STAGE,
      getField(state, "Construction Iteration")?.trim() === "unit-major" ||
        getField(state, "Construction Checkpoints") === "enabled",
      unit ?? undefined,
    );
  } catch {
    return null;
  }
  const floor = /^GATE_REJECTED:(.+)#\d+$/.exec(runFloor);
  if (floor === null) return null;
  const dir = codeGenerationRecordDir(projectDir, unit);
  const plan = readText(join(dir, PLAN_FILE));
  const instructions = readText(join(dir, INSTRUCTIONS_FILE));
  const read = readTestingContract(plan);
  if ("defect" in read) return null;
  // The fingerprint binds the attempt too, so compare the files as they are
  // against each earlier approval at that approval's own attempt.
  const approvedBefore = stalePlanApprovalReceiptsForTarget(projectDir, intentId, targetId, runFloor).some((receipt) => receipt.fingerprint ===
    approvalFingerprint(plan, instructions, read.contract.contract_sha256, receipt));
  if (!approvedBefore) return null;
  const rejection = readAuditShardEvents(projectDir).find((row) =>
    row.event === "GATE_REJECTED" && row.timestamp === floor[1] &&
    [null, unit].includes(auditBlockField(row.block, "Unit")));
  const feedback = rejection
    ? (auditBlockField(rejection.block, "Feedback") ?? auditBlockField(rejection.block, "Reason"))?.trim()
    : undefined;
  return feedback ? { feedback } : {};
}

function targetState(
  projectDir: string,
  unit: string | null,
  intentId: string,
  record: PlanApprovalAskRecord | null,
): TargetState {
  const approval = evaluateCodeGenerationApproval(projectDir, { unit });
  let targetId: string | null = null;
  try {
    targetId = codeGenerationTargetId({ unit });
  } catch {
    targetId = null;
  }
  const reviewRequested = targetId !== null && planApprovalReviewRequested(projectDir, targetId, intentId);
  if (!reviewRequested && codeGenerationExecutionAllowed(projectDir, { unit }, approval)) {
    return { unit, kind: "approved" };
  }
  const result = record?.results?.find((entry) => entry.unit === unit);
  const readiness = codeGenerationPlanReadiness(projectDir, unit);
  if (result?.choice === "request-changes" && result.fingerprint === approval.approvalFingerprint) {
    return {
      unit,
      kind: "revise",
      ...(result.feedback ? { feedback: result.feedback } : {}),
    };
  }
  if (result?.choice === "repair" && !readiness.ready) {
    return { unit, kind: "repair", ...(result.note ? { note: result.note } : {}) };
  }
  if (!readiness.ready) {
    return { unit, kind: "plan", ...(readiness.note ? { note: readiness.note } : {}) };
  }
  const revision = rejectionRevision(projectDir, unit, intentId);
  if (revision !== null) return { unit, kind: "revise", ...revision };
  return { unit, kind: "ask", repaired: result?.choice === "repair" };
}

// In place: the engine keys a run-stage's rule route and a swarm's publication
// context by the directive object itself.
function withPlanState<T extends RunStageDirective | InvokeSwarmDirective>(
  directive: T,
  state: CodeGenerationPlanApprovalState,
): T {
  directive.plan_approval = state;
  return directive;
}

/**
 * The directive `next` emits in place of a code-generation run-stage or
 * invoke-swarm: the same directive marked plan or build, or the engine's Plan
 * Approval question. Read-only: nothing is written until `publishPlanApprovalAsk`.
 */
export function routeCodeGenerationPlanApproval(projectDir: string, directive: Directive): Directive {
  if (!isPlanApprovalBeat(directive)) return directive;
  const units: Array<string | null> = directive.kind === "run-stage"
    ? [directive.unit ?? null]
    : directive.units;
  if (units.length === 0) return directive;
  const intentId = intentIdFor(projectDir);
  const record = readPlanApprovalAsk(projectDir, intentId);
  // The person is editing the files: show the same question, in edit mode,
  // until they say done. Nothing is recomputed from half-edited files.
  if (
    record?.mode === "editing" &&
    record.results === undefined &&
    record.targets.length === units.length &&
    record.targets.every((target) => units.includes(target.unit))
  ) {
    return planApprovalAskDirective(projectDir, record.targets.map((target) => target.unit), {
      question: record.question,
      editing: true,
      note: record.lastNotice ??
        "The person is editing the files. Wait for them to say done; do not change those files yourself.",
    });
  }
  const states = units.map((unit) => targetState(projectDir, unit, intentId, record));
  if (states.every((state) => state.kind === "approved")) {
    return withPlanState(directive, { status: "approved" });
  }
  const working = states.filter((state): state is Extract<TargetState, { kind: "plan" | "revise" | "repair" }> =>
    state.kind === "plan" || state.kind === "revise" || state.kind === "repair");
  if (working.length > 0) {
    if (directive.kind === "run-stage") {
      const only = working[0];
      return withPlanState(directive, {
        status: only.kind,
        ...(only.note ? { note: only.note } : {}),
        ...(only.feedback ? { feedback: only.feedback } : {}),
      });
    }
    return withPlanState(directive, {
      status: "plan",
      units: working.map((state): CodeGenerationPlanUnitState => ({
        unit: state.unit as string,
        status: state.kind,
        ...(state.note ? { note: state.note } : {}),
        ...(state.feedback ? { feedback: state.feedback } : {}),
      })),
    });
  }
  const asking = states.filter((state): state is Extract<TargetState, { kind: "ask" }> => state.kind === "ask");
  // Approval needs a workspace source that can be read, or generation could
  // never start from it. Say so before asking, never after.
  if (workspaceSourceState(projectDir) === null) {
    return { kind: "error", message: new PlanApprovalUnbindableError("presented").message };
  }
  const askUnits = asking.map((state) => state.unit);
  const repaired = asking.some((state) => state.repaired);
  const question = planQuestion(askUnits, repaired);
  const reShown = record !== null && record.results === undefined && record.question === question &&
    record.targets.length === askUnits.length && record.targets.every((target) => askUnits.includes(target.unit));
  return planApprovalAskDirective(projectDir, askUnits, {
    question,
    editing: false,
    ...(reShown && record?.lastNotice ? { note: record.lastNotice } : {}),
  });
}

function planApprovalAskDirective(
  projectDir: string,
  units: Array<string | null>,
  options: { question: string; editing: boolean; note?: string },
): PlanApprovalAskDirective {
  const grouped = units.length > 1;
  return {
    kind: "ask",
    ask_type: "plan-approval",
    response_route: "next",
    stage: STAGE,
    question: options.question,
    ...(units.length === 1 && units[0] !== null ? { unit: units[0] } : {}),
    plan_approval: {
      targets: units.map((unit) => targetView(projectDir, unit)),
      choices: [...(grouped ? GROUPED_PLAN_APPROVAL_CHOICES : PLAN_APPROVAL_CHOICES)],
      editing: options.editing,
      ...(options.note ? { note: options.note } : {}),
    },
  };
}

// --- Publishing the question ---------------------------------------------------

/**
 * Called after the ask marker is published: record the question in the
 * protected store and write each target's questions file. The same unanswered
 * question for the same files keeps its id, so a restart or a new chat shows
 * the question the person was already asked.
 */
export function publishPlanApprovalAsk(projectDir: string, directive: PlanApprovalAskDirective): void {
  withAuditLock(projectDir, () => {
    const units = directive.plan_approval.targets.map((target) => target.unit);
    const authorities = units.map((unit) => resolveCodeGenerationAuthority(projectDir, { unit }));
    const intentId = authorities[0].intentId;
    const existing = readPlanApprovalAsk(projectDir, intentId);
    if (directive.plan_approval.editing && existing?.mode === "editing") {
      writePlanApprovalAsk(projectDir, { ...existing, bound: true });
      return;
    }
    const source = workspaceSourceState(projectDir);
    const targets = units.map((unit, index) => {
      const authority = authorities[index];
      const dir = codeGenerationRecordDir(projectDir, unit);
      const plan = readText(join(dir, PLAN_FILE));
      const instructions = readText(join(dir, INSTRUCTIONS_FILE));
      const read = readTestingContract(plan);
      if (!("contract" in read)) {
        throw new Error(`Plan Approval for ${targetLabel(unit)} needs a valid Testing Contract before it is asked.`);
      }
      return {
        unit,
        targetId: authority.targetId,
        fingerprint: approvalFingerprint(plan, instructions, read.contract.contract_sha256, authority),
      };
    });
    const same = existing !== null && existing.results === undefined && existing.mode === "ask" &&
      existing.question === directive.question && existing.targets.length === targets.length &&
      existing.targets.every((target) =>
        targets.some((current) => current.unit === target.unit && current.fingerprint === target.fingerprint));
    const record: PlanApprovalAskRecord = same && existing
      ? { ...existing, bound: true }
      : {
          version: 1,
          askId: randomBytes(16).toString("hex"),
          intentId,
          targets,
          question: directive.question,
          choices: directive.plan_approval.choices,
          mode: "ask",
          bound: true,
          issuedAt: new Date().toISOString(),
        };
    writePlanApprovalAsk(projectDir, record);
    directive.plan_approval.targets.forEach((view, index) => {
      const path = join(projectDir, view.questions_path);
      const content = questionsFileContent(
        directive.question,
        view,
        directive.plan_approval.choices,
        targets[index].fingerprint,
        source?.fingerprint ?? "unbindable",
        "",
      );
      if (readText(path) !== content) writeFileAtomic(path, content);
    });
  });
}

// --- Reading the person's reply ------------------------------------------------

type AskReading =
  | { kind: "approve" }
  | { kind: "request-changes"; units: Array<string | null>; feedback?: string }
  | { kind: "which"; feedback: string }
  | { kind: "edit" }
  | { kind: "none"; notice: string };

function normalized(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .replace(/^[`*_"'\s]+|[`*_"'\s]+$/g, "")
    .replace(/[\s.!]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const EDIT_RE = /^(?:(?:option |choice )?(?:3|c|three)|(?:the )?third(?: one| option)?|i'?ll edit(?: (?:it|them|the files?|the plan))?(?: myself)?|i will edit(?: (?:it|them|the files?|the plan))?(?: myself)?|let me edit(?: (?:it|them|the files?|the plan))?(?: myself)?|edit(?: (?:it|them|the files?|the plan))?(?: myself)?)$/;
const DONE_RE = /^(?:done|ready|finished|all done|i'?m done|i am done|ok,? done|done editing|finished editing|i'?ve finished|i have finished|edits? (?:are )?done|go ahead|build it)$/;
const ALL_RE = /^(?:all|all of them|every one|everyone|each|every plan|all plans|all of the plans)$/;
const GROUPED_APPROVE_RE = /^(?:(?:option )?1|a|approve(?: them)? all|approve all(?: plans| of them)?|all approved|approve (?:them|the plans|everything|all three|all plans))$/;
const BARE_CHANGES_RE = /^(?:(?:option )?2|b|two|request changes|changes|change|no|nope)$/;

function namedUnits(text: string, units: Array<string | null>): string[] {
  return units.filter((unit): unit is string => {
    if (unit === null) return false;
    const escaped = unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`, "i").test(text);
  });
}

const CONFIRM_NOTICE =
  "AIDLC Plan Approval: the person said yes, but not right after the plan question, so it could be answering " +
  'something else and nothing was recorded. Ask them to confirm in one reply ("1" to approve the plan, "2" to ' +
  "change something) and end the turn.";
const QUESTION_NOTICE =
  "AIDLC Plan Approval: the person asked a question, so nothing was recorded. Answer it, then run next to show " +
  "the plan question again.";
const UNCLEAR_NOTICE =
  "AIDLC Plan Approval: the reply did not clearly approve the plan or ask for changes, so nothing was recorded. " +
  'Ask one short follow-up, such as "Approve the plan as is (1), or change something (2)?", and end the turn.';

function readAskReply(text: string, record: PlanApprovalAskRecord, bound: boolean): AskReading {
  const units = record.targets.map((target) => target.unit);
  const grouped = units.length > 1;
  const reply = normalized(text);
  if (!reply) return { kind: "none", notice: UNCLEAR_NOTICE };
  if (EDIT_RE.test(reply)) return { kind: "edit" };
  if (record.mode === "editing" && DONE_RE.test(reply)) return { kind: "approve" };
  if (grouped && record.pendingChange !== undefined) {
    const named = namedUnits(text, units);
    if (ALL_RE.test(reply)) {
      return { kind: "request-changes", units, ...(record.pendingChange ? { feedback: record.pendingChange } : {}) };
    }
    if (named.length > 0) {
      return { kind: "request-changes", units: named, ...(record.pendingChange ? { feedback: record.pendingChange } : {}) };
    }
  }
  if (grouped && GROUPED_APPROVE_RE.test(reply)) return { kind: "approve" };
  const reading = interpretPlanApprovalReply(text, [record.choices[0], record.choices[1]], bound);
  switch (reading) {
    case "approve":
      return { kind: "approve" };
    case "request-changes": {
      const bare = BARE_CHANGES_RE.test(reply) || reply === record.choices[1].toLowerCase();
      if (!grouped) {
        return { kind: "request-changes", units, ...(bare ? {} : { feedback: text.trim() }) };
      }
      const named = namedUnits(text, units);
      if (named.length > 0) return { kind: "request-changes", units: named, ...(bare ? {} : { feedback: text.trim() }) };
      return { kind: "which", feedback: bare ? "" : text.trim() };
    }
    case "confirm":
      return { kind: "none", notice: CONFIRM_NOTICE };
    case "question":
      return { kind: "none", notice: QUESTION_NOTICE };
    default:
      return { kind: "none", notice: UNCLEAR_NOTICE };
  }
}

// --- Recording an answer -------------------------------------------------------

function currentPlanApprovalAsk(
  projectDir: string,
): { marker: ActiveDirectiveMarker; record: PlanApprovalAskRecord } | null {
  let state: string;
  try {
    state = readFileSync(stateFilePath(projectDir), "utf-8");
  } catch {
    return null;
  }
  const marker = readActiveDirectiveMarker(projectDir, state);
  if (marker?.version !== 2 || marker.kind !== "ask" || marker.ask_type !== PLAN_APPROVAL_ASK_TYPE) return null;
  const record = readPlanApprovalAsk(projectDir, marker.intent_uuid ?? "bare-space");
  if (record === null || record.results !== undefined) return null;
  const markerUnits: Array<string | null> = marker.unit !== undefined
    ? [marker.unit]
    : marker.units?.length ? marker.units : [null];
  const same = record.targets.length === markerUnits.length &&
    record.targets.every((target) => markerUnits.includes(target.unit));
  return same ? { marker, record } : null;
}

type TargetApproval =
  | { ok: true; result: PlanApprovalAskResult; changed: boolean }
  | { ok: false; result?: PlanApprovalAskResult; notice: string };

// Approve one target with its files exactly as they are now. Caller holds the
// audit lock; the receipt is written under the active-directive lock too, the
// order the old answer command used.
function approveTarget(
  projectDir: string,
  record: PlanApprovalAskRecord,
  unit: string | null,
  session: string,
): TargetApproval {
  const dir = codeGenerationRecordDir(projectDir, unit);
  const planPath = join(dir, PLAN_FILE);
  const plan = readText(planPath);
  const instructions = readText(join(dir, INSTRUCTIONS_FILE));
  const view = targetView(projectDir, unit);
  const repair = (note: string): TargetApproval => ({
    ok: false,
    result: { unit, choice: "repair", fingerprint: "", note },
    notice: `AIDLC Plan Approval: ${note} Nothing was approved for ${targetLabel(unit)}. Run next: repair it, and ` +
      "the engine will ask the person once to build the edited plan.",
  });
  if (!plan.trim()) return repair(`${view.plan_path} is empty.`);
  if (!instructions.trim()) return repair(`${view.instructions_path} is empty.`);
  const read = readTestingContract(plan);
  if (!("contract" in read)) {
    return repair(`the edit broke the Testing Contract block in ${view.plan_path} (${read.defect}).`);
  }
  if (read.contract.contract_sha256 !== resolveTestingPosture(projectDir).contract_sha256) {
    return repair(`the Testing Contract in ${view.plan_path} is out of date and needs to be rendered again.`);
  }
  if (!usableTestingContract(read.contract)) {
    return repair(`the Testing Contract in ${view.plan_path} has missing or inconsistent executable fields.`);
  }
  const source = workspaceSourceState(projectDir);
  if (source === null) {
    return {
      ok: false,
      notice: `AIDLC Plan Approval: nothing was recorded because the workspace source cannot be read right now` +
        `${workspaceSourceFailureSuffix()}. Run next for the repair.`,
    };
  }
  const authority = resolveCodeGenerationAuthority(projectDir, { unit });
  const fingerprint = approvalFingerprint(plan, instructions, read.contract.contract_sha256, authority);
  const asked = record.targets.find((target) => target.unit === unit)?.fingerprint;
  const questionsPath = join(dir, QUESTIONS_FILE);
  const questions = questionsFileContent(
    record.question, view, record.choices, fingerprint, source.fingerprint, APPROVED_ANSWER,
  );
  const questionsFile = toPosix(relative(projectDir, questionsPath));
  const receipt: PlanApprovalRuntimeReceipt = {
    version: 1,
    targetId: authority.targetId,
    intentId: authority.intentId,
    runFloor: authority.runFloor,
    fingerprint,
    questionsFile,
    promptSha256: promptSha256(questions),
    directiveEpoch: authority.directiveEpoch,
    sourceFloor: authority.sourceFloor,
    markerRevision: authority.markerRevision,
    plannedSourceSha256: source.fingerprint,
    session,
    challengeId: record.askId,
    choice: "Approve Plan",
    questionsSha256: createHash("sha256").update(questions, "utf-8").digest("hex"),
    certifiedSourceSha256: source.fingerprint,
    status: "approved",
  };
  withActiveDirectiveLock(projectDir, () => {
    writeFileAtomic(questionsPath, questions);
    writePlanApprovalReceipt(projectDir, receipt);
    writeWorkspaceSourceSnapshot(projectDir, STAGE, source);
  });
  appendAuditEntryUnlocked("PLAN_APPROVAL_RECORDED", {
    Stage: STAGE,
    Details: "Approve Plan",
    Checkpoint: "plan-approval",
    "Plan Target": authority.targetId,
    Intent: authority.intentId,
    "Directive Epoch": authority.directiveEpoch,
    "Run floor": authority.runFloor,
    "Approval Fingerprint": fingerprint,
    "Questions File": questionsFile,
    "Questions SHA-256": receipt.questionsSha256,
    "Prompt SHA-256": receipt.promptSha256,
    Session: session,
    "Asked By": "engine",
    ...(unit !== null ? { Unit: unit, ...claimAttemptFields(projectDir, unit) } : {}),
  }, projectDir);
  clearPlanApprovalReviewRequest(projectDir, authority.targetId);
  collectStalePlanApprovalReceipts(projectDir, authority.intentId, authority.targetId, authority.runFloor);
  return {
    ok: true,
    result: { unit, choice: "approve", fingerprint },
    changed: asked !== undefined && asked !== fingerprint,
  };
}

function requestChangesFor(
  projectDir: string,
  record: PlanApprovalAskRecord,
  unit: string | null,
  session: string,
  feedback: string | undefined,
): PlanApprovalAskResult {
  const approval = evaluateCodeGenerationApproval(projectDir, { unit });
  const dir = codeGenerationRecordDir(projectDir, unit);
  const questionsPath = join(dir, QUESTIONS_FILE);
  const view = targetView(projectDir, unit);
  const asked = record.targets.find((target) => target.unit === unit);
  const existing = readText(questionsPath);
  const fingerprintLine = /^\[Approval Fingerprint\]:[ \t]*(\S+)/m.exec(existing)?.[1] ?? asked?.fingerprint ?? "";
  const sourceLine = /^\[Planned Source\]:[ \t]*(\S+)/m.exec(existing)?.[1] ?? "unbindable";
  writeFileAtomic(
    questionsPath,
    questionsFileContent(record.question, view, record.choices, fingerprintLine, sourceLine, CHANGES_ANSWER),
  );
  let targetId = "";
  try {
    targetId = codeGenerationTargetId({ unit });
  } catch {
    targetId = "";
  }
  appendAuditEntryUnlocked("QUESTION_ANSWERED", {
    Stage: STAGE,
    Details: "Request Changes",
    Checkpoint: "plan-approval",
    ...(targetId ? { "Plan Target": targetId } : {}),
    Session: session,
    "Asked By": "engine",
    ...(feedback ? { "User Input": feedback } : {}),
    ...(unit !== null ? { Unit: unit } : {}),
  }, projectDir);
  return {
    unit,
    choice: "request-changes",
    fingerprint: approval.approvalFingerprint ?? asked?.fingerprint ?? "",
    ...(feedback ? { feedback } : {}),
  };
}

export interface PlanApprovalAskReplyResult {
  notice: string;
  recorded: boolean;
}

/**
 * The human-turn hook's reading of a reply while the engine's Plan Approval
 * question is open. Returns null when no such question is open (or a picker
 * answered some other question), so the caller's other readers run.
 */
export function recordPlanApprovalAskReply(
  projectDir: string,
  session: string,
  text: string,
  picker?: PlanApprovalPickerQuestion,
): PlanApprovalAskReplyResult | null {
  return withAuditLock(projectDir, () => {
    const open = currentPlanApprovalAsk(projectDir);
    if (open === null) return null;
    const { record } = open;
    if (picker && (picker.severalPicks || picker.question?.trim() !== record.question)) {
      // Another question's picker: the plan question is no longer the last thing asked.
      writePlanApprovalAsk(projectDir, { ...record, bound: false });
      return null;
    }
    const bound = picker !== undefined || record.bound;
    const reading = readAskReply(text, record, bound);
    const who = session || "unidentified-session";
    const next: PlanApprovalAskRecord = { ...record, bound: false };
    delete next.lastNotice;
    const units = record.targets.map((target) => target.unit);
    let notice: string;
    let recorded = false;
    switch (reading.kind) {
      case "none":
        next.lastNotice = reading.notice;
        notice = reading.notice;
        break;
      case "edit": {
        next.mode = "editing";
        const files = record.targets.flatMap((target) => {
          const view = targetView(projectDir, target.unit);
          return [view.plan_path, view.instructions_path];
        });
        notice = "AIDLC Plan Approval: the person will edit the files themselves. Run next, tell them they can " +
          `change ${files.join(", ")} and write their answer after [Answer]: in the questions file, then end ` +
          "the turn and wait for them to say done. Do not change those files yourself.";
        break;
      }
      case "which": {
        next.pendingChange = reading.feedback;
        notice = "AIDLC Plan Approval: the person asked for a change without naming a plan, so nothing was " +
          `recorded. Ask once: "Which plan should change: ${units.map(targetLabel).join(", ")}, or all?" and ` +
          "end the turn.";
        next.lastNotice = notice;
        break;
      }
      case "approve":
      case "request-changes": {
        // In edit mode, "done" decides from the files: an answer the person
        // wrote in a questions file is their answer for that plan.
        const changeUnits = new Map<string | null, string | undefined>();
        if (reading.kind === "request-changes") {
          for (const unit of reading.units) changeUnits.set(unit, reading.feedback);
        } else if (record.mode === "editing") {
          for (const unit of units) {
            const written = answerLine(readText(join(codeGenerationRecordDir(projectDir, unit), QUESTIONS_FILE)));
            if (!written) continue;
            const said = interpretPlanApprovalReply(written, [record.choices[0], record.choices[1]], true);
            if (said === "request-changes") {
              changeUnits.set(unit, BARE_CHANGES_RE.test(normalized(written)) ? undefined : written);
            }
          }
        }
        const results: PlanApprovalAskResult[] = [];
        const approved: Array<string | null> = [];
        const changed: Array<string | null> = [];
        const repairs: string[] = [];
        const failures: string[] = [];
        for (const unit of units) {
          if (changeUnits.has(unit)) {
            results.push(requestChangesFor(projectDir, record, unit, who, changeUnits.get(unit)));
            continue;
          }
          const outcome = approveTarget(projectDir, record, unit, who);
          if (outcome.ok) {
            results.push(outcome.result);
            approved.push(unit);
            if (outcome.changed) changed.push(unit);
          } else if (outcome.result) {
            results.push(outcome.result);
            repairs.push(outcome.notice);
          } else {
            failures.push(outcome.notice);
          }
        }
        if (failures.length > 0 && results.length === 0) {
          next.lastNotice = failures[0];
          notice = failures[0];
          break;
        }
        next.results = results;
        delete next.pendingChange;
        next.mode = "ask";
        recorded = true;
        const parts: string[] = [];
        if (approved.length > 0) {
          parts.push(`recorded "Approve Plan" for ${labels(approved)}` +
            (changed.length > 0 ? ` with the files as the person left them (${labels(changed)} changed)` : ""));
        }
        if (changeUnits.size > 0) {
          const withWords = [...changeUnits.entries()].find(([, words]) => words);
          parts.push(`recorded "Request Changes" for ${labels([...changeUnits.keys()])}` +
            (withWords ? `: "${withWords[1]}"` : ""));
        }
        notice = `AIDLC Plan Approval: ${parts.join(", and ")}. Run next.` +
          (changeUnits.size > 0 && ![...changeUnits.values()].some(Boolean)
            ? " Ask them what should change before revising."
            : "") +
          (repairs.length > 0 ? ` ${repairs.join(" ")}` : "");
        break;
      }
    }
    writePlanApprovalAsk(projectDir, next);
    return { notice, recorded };
  });
}

// --- "Review the plan" ---------------------------------------------------------

const REVIEW_REQUEST_RE =
  /\b(?:review|re-?review|re-?approve|look (?:at|over)|see|show me|check|reopen)\b[^.?!]{0,40}\b(?:the |my |this |that )?(?:code )?plan\b/i;

/**
 * The person asked to review the plan while code generation may keep
 * building (an approved plan, or a lowered fence). The next `next` asks for
 * approval again before anything else runs. Returns the notice, or null.
 */
export function recordPlanApprovalReviewRequest(projectDir: string, text: string): string | null {
  const reply = text.trim();
  if (!reply || reply.length > 160 || !REVIEW_REQUEST_RE.test(reply)) return null;
  return withAuditLock(projectDir, () => {
    let state: string;
    try {
      state = readFileSync(stateFilePath(projectDir), "utf-8");
    } catch {
      return null;
    }
    const marker = readActiveDirectiveMarker(projectDir, state);
    if (marker?.version !== 2 || marker.stage !== STAGE) return null;
    if (marker.kind !== "run-stage" && marker.kind !== "invoke-swarm") return null;
    const units: Array<string | null> = marker.kind === "run-stage"
      ? [marker.unit ?? null]
      : marker.units ?? [];
    if (units.length === 0) return null;
    const intentId = marker.intent_uuid ?? "bare-space";
    for (const unit of units) {
      requestPlanApprovalReview(projectDir, codeGenerationTargetId({ unit }), intentId);
    }
    return `AIDLC Plan Approval: the person asked to review the plan for ${labels(units)}. Run next: the plan ` +
      "is shown for approval again before anything else is built.";
  });
}
