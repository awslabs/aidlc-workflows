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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { appendAuditEntryUnlocked } from "./aidlc-audit.ts";
import {
  activeIntentUuid,
  auditBlockField,
  auditMark,
  type AuditMark,
  changeControlSourceLabel,
  claimAttemptFields,
  collectStalePlanApprovalReceipts,
  errorMessage,
  fenceSwitchSentence,
  getField,
  GUARD_RECOVERY_ASK_TYPE,
  isoTimestamp,
  isReplyTurn,
  personAtOwnTerminal,
  personRepliedAfter,
  latestMainWorkflowStageRunFloorForProject,
  memoryStrictHoldsGuardPolicy,
  PLAN_APPROVAL_ASK_TYPE,
  planApprovalRuntimeFile,
  readActiveDirectiveMarker,
  readAuditShardEvents,
  readPlanApprovalRuntimeRecord,
  removePlanApprovalRuntimeRecord,
  stalePlanApprovalReceiptsForTarget,
  stateFilePath,
  steeringPayloadAuthenticAt,
  steeringTokenKeyPathFor,
  toPosix,
  UNBINDABLE_FINGERPRINT,
  visibleMarkdownLines,
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
import { CHECK_GLOSS } from "./aidlc-guard-fences.ts";
import {
  approvalFingerprint,
  approvedPlanChangeLine,
  codeGenerationBuildsWithoutSource,
  codeGenerationExecutionAllowed,
  codeGenerationRecordDir,
  codeGenerationTargetId,
  evaluateCodeGenerationApproval,
  keepApprovedPlanCopy,
  PlanApprovalUnbindableError,
  readTestingContract,
  resolveCodeGenerationAuthority,
  resolveTestingPosture,
  testingContractDefectMessage,
  usableTestingContract,
  type CodeGenerationIssuance,
  type PlanApprovalPickerQuestion,
} from "./aidlc-testing-posture.ts";
import { exactOptionPick, isNonAnswer, pickerOffersChoices } from "./aidlc-reply-reader.ts";
import { aidlcDispatcherInvocation, aidlcToolInvocation } from "./aidlc-runtime-paths.ts";
import { type PlanApprovalSetting, resolvePlanApprovalSetting } from "./aidlc-guard-switch.ts";
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
// question to the conductor; the hook keeps the reply on THIS record. One
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
  /** Recorded from the conductor's reading of the reply, not an exact pick. */
  read?: true;
  /** How many human turns were on record when it was recorded; a newer turn lets it change. */
  turns?: number;
}

export interface PlanApprovalAskReply {
  session: string;
  text: string;
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
  /** What the engine has to tell the conductor about the last answer (a repair, say). */
  lastNotice?: string;
  /**
   * The person's messages since the question was shown, kept verbatim by the
   * human-turn hook from whichever chat they arrive in. The conductor reads
   * them and records the choice the person made.
   */
  replies?: PlanApprovalAskReply[];
  /** Where the audit trail stood when the question was shown: an answer needs a reply after it. */
  repliesFrom?: AuditMark;
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

/**
 * Where the person stands on the recorded Plan Approval question: not answered
 * yet, editing the files themselves, or answered (a choice is recorded and the
 * next `next` carries it out). Null when no question is recorded.
 */
export function planApprovalAskState(projectDir: string): "unanswered" | "editing" | "answered" | null {
  const record = readPlanApprovalAsk(projectDir, intentIdFor(projectDir));
  if (record === null) return null;
  if (record.mode === "editing") return "editing";
  return (record.results?.length ?? 0) > 0 ? "answered" : "unanswered";
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
// Said while the current directive names no plan (the work is paused, or a
// question with no Unit is open), it is for the plan the next `next` routes,
// in this piece of work: asking about that plan turns it into a request for
// each plan asked about.
function nextPlanReviewId(intentId: string): string {
  return `next:code-generation:${intentId}`;
}

// One file per piece of work and plan: every intent in the checkout shares this
// directory, so the same plan target in two intents keeps two requests.
function reviewRequestPath(projectDir: string, targetId: string, intentId: string): string {
  const key = createHash("sha256").update(`${intentId}\n${targetId}`, "utf-8").digest("hex").slice(0, 24);
  return planApprovalRuntimeFile(projectDir, `review-request-${key}.json`);
}

// Where a request written by an earlier release (keyed by the plan alone) is.
function legacyReviewRequestPath(projectDir: string, targetId: string): string {
  const key = createHash("sha256").update(targetId, "utf-8").digest("hex").slice(0, 24);
  return planApprovalRuntimeFile(projectDir, `review-request-${key}.json`);
}

function reviewRequestAt(path: string, targetId: string, intentId: string): boolean {
  const value = readPlanApprovalRuntimeRecord<{ version: number; targetId: string; intentId: string }>(
    path,
    "Plan Approval review request",
  );
  return value?.version === 1 && value.targetId === targetId && value.intentId === intentId;
}

function requestPlanApprovalReview(
  projectDir: string,
  targetId: string,
  intentId: string,
  feedback?: string,
): void {
  writePlanApprovalRuntimeRecord(
    projectDir,
    reviewRequestPath(projectDir, targetId, intentId),
    `${JSON.stringify({
      version: 1, targetId, intentId, requestedAt: new Date().toISOString(),
      ...(feedback !== undefined ? { feedback } : {}),
    })}\n`,
  );
}

// Several plans' requests are one request: every one is written, or none is.
function requestPlanApprovalReviews(projectDir: string, targetIds: string[], intentId: string): void {
  const written: Array<{ path: string; previous: string | null }> = [];
  try {
    for (const targetId of targetIds) {
      const path = reviewRequestPath(projectDir, targetId, intentId);
      const previous = existsSync(path) ? readFileSync(path, "utf-8") : null;
      requestPlanApprovalReview(projectDir, targetId, intentId);
      written.push({ path, previous });
    }
  } catch (error) {
    for (const { path, previous } of written.reverse()) {
      try {
        if (previous === null) removePlanApprovalRuntimeRecord(path);
        else writePlanApprovalRuntimeRecord(projectDir, path, previous);
      } catch {
        // The original error says what failed; this request is reported unrecorded.
      }
    }
    throw error;
  }
}

interface PendingPlanReview {
  unit: string | null;
  targetId: string;
  /** The person's words when they already asked for changes to a plan that was built. */
  feedback?: string;
}

/** Review requests for plans built without asking, for this intent. */
function pendingBuiltPlanReviews(projectDir: string, intentId: string): PendingPlanReview[] {
  const dir = dirname(planApprovalRuntimeFile(projectDir, "probe"));
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => /^review-request-[0-9a-f]{24}\.json$/.test(name)).sort();
  } catch {
    return [];
  }
  const pending: PendingPlanReview[] = [];
  for (const name of names) {
    const value = readPlanApprovalRuntimeRecord<{ version: number; targetId: string; intentId: string; feedback?: string }>(
      join(dir, name), "Plan Approval review request",
    );
    if (value?.version !== 1 || value.intentId !== intentId || typeof value.targetId !== "string") continue;
    if (value.targetId.startsWith("next:")) continue;
    const unit = value.targetId.startsWith("unit:") ? value.targetId.slice("unit:".length) : null;
    const questions = readText(join(codeGenerationRecordDir(projectDir, unit), QUESTIONS_FILE));
    // Only a plan the engine built without asking is "already built" here; any
    // other review request is the plan's own beat, handled by the router.
    if (!/^\[Answer\]:[ \t]*Plan approval off[ \t]*$/m.test(questions) && value.feedback === undefined) continue;
    // One plan is one review, even when an earlier release's request for it
    // sits beside this release's: the person's words win wherever they are.
    const same = pending.find((review) => review.targetId === value.targetId);
    if (same) {
      if (!same.feedback && value.feedback) same.feedback = value.feedback;
      continue;
    }
    pending.push({ unit, targetId: value.targetId, ...(value.feedback ? { feedback: value.feedback } : {}) });
  }
  return pending;
}

export function planApprovalReviewRequested(projectDir: string, targetId: string, intentId: string): boolean {
  return reviewRequestAt(reviewRequestPath(projectDir, targetId, intentId), targetId, intentId) ||
    reviewRequestAt(legacyReviewRequestPath(projectDir, targetId), targetId, intentId);
}

function clearPlanApprovalReviewRequest(projectDir: string, targetId: string, intentId: string): void {
  removePlanApprovalRuntimeRecord(reviewRequestPath(projectDir, targetId, intentId));
  const legacy = legacyReviewRequestPath(projectDir, targetId);
  if (reviewRequestAt(legacy, targetId, intentId)) removePlanApprovalRuntimeRecord(legacy);
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
    return { ready: false, note: testingContractDefectMessage(read.defect, "run next") };
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
  // Only what renders: nothing hidden in a comment or a code block reaches the
  // question.
  const lines = visibleMarkdownLines(plan);
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
// A plan built with plan approval off asked nothing, so its record says so.
const ANSWER_HERE_INTRO = [
  "AI-DLC writes this file when it asks you to approve the plan. To answer here",
  "instead of in chat, write your answer after `[Answer]:` and say done.",
];
const BUILT_WITHOUT_ASKING_INTRO = [
  "AI-DLC built this plan without asking because plan approval is off for this",
  "piece of work. This file is the record and asks nothing; to look at a plan",
  "before it is built, ask in chat.",
];

function questionsFileContent(
  question: string,
  view: PlanApprovalAskTargetView,
  choices: readonly string[],
  fingerprint: string,
  plannedSource: string,
  answer: string,
  intro: readonly string[] = ANSWER_HERE_INTRO,
): string {
  return [
    "# Code Generation Plan Approval",
    "",
    ...intro,
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

// --- Routing: plan, ask, or build --------------------------------------------

type TargetState =
  | { unit: string | null; kind: "approved" }
  | { unit: string | null; kind: "skip" }
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
      directive.build_settled !== true &&
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
  issued: CodeGenerationIssuance,
  planApprovalOff = false,
): TargetState {
  const approval = evaluateCodeGenerationApproval(projectDir, { unit }, issued);
  let targetId: string | null = null;
  try {
    targetId = codeGenerationTargetId({ unit });
  } catch {
    targetId = null;
  }
  const reviewRequested = targetId !== null && (planApprovalReviewRequested(projectDir, targetId, intentId) ||
    planApprovalReviewRequested(projectDir, nextPlanReviewId(intentId), intentId));
  if (!reviewRequested && codeGenerationExecutionAllowed(projectDir, { unit }, approval, issued)) {
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
  // Plan approval is off: build the plan as written, unless the person asked to
  // review it first. That request is for this plan only; later Units still build.
  if (planApprovalOff && !reviewRequested) return { unit, kind: "skip" };
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
  const setting = planApprovalSettingFor(projectDir);
  const planApprovalOff = setting?.value === "off";
  // The plans asked about are the ones this directive builds, whatever the
  // engine said last (the question, a pause, or a directive a compacted chat
  // must re-read).
  const states = units.map((unit) => targetState(projectDir, unit, intentId, record, directive, planApprovalOff));
  if (states.every((state) => state.kind === "approved")) {
    // Under a lowered Guard Policy an approved plan that changed before the
    // build still builds; the person hears what changed and how to go back.
    const approved = withPlanState(directive, { status: "approved" });
    const changed = units.flatMap((unit) => approvedPlanChangeLine(projectDir, { unit }, directive) ?? []);
    if (changed.length > 0) approved.change_notices = [...(approved.change_notices ?? []), ...changed];
    return approved;
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
  // never start from it. Say so before asking, never after. With the
  // plan-approval check standing aside the build starts without that record,
  // so the question is asked (and plan approval off builds) as usual.
  if (
    workspaceSourceState(projectDir) === null &&
    !units.every((unit) => codeGenerationBuildsWithoutSource(projectDir, { unit }, asking.length === 0))
  ) {
    return { kind: "error", message: new PlanApprovalUnbindableError("presented").message };
  }
  if (asking.length === 0 && setting !== null) {
    const skipped = states.filter((state) => state.kind === "skip").map((state) => state.unit);
    return withPlanState(directive, {
      status: "approved",
      skipped: true,
      notice: planApprovalOffNotice(projectDir, skipped, setting),
    });
  }
  const askUnits = asking.map((state) => state.unit);
  const repaired = asking.some((state) => state.repaired);
  const question = planQuestion(askUnits, repaired);
  const reShown = record !== null && record.results === undefined && record.question === question &&
    record.targets.length === askUnits.length && record.targets.every((target) => askUnits.includes(target.unit));
  // Under strict a changed approved plan is asked about again; the question
  // says first what changed since the person approved it.
  const changed = askUnits.flatMap((unit) => approvedPlanChangeLine(projectDir, { unit }, directive) ?? []);
  return planApprovalAskDirective(projectDir, askUnits, {
    question,
    editing: false,
    ...(changed.length > 0
      ? { note: changed.join(" ") }
      : reShown && record?.lastNotice ? { note: record.lastNotice } : {}),
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
    // A review asked for while no plan was named is for these plans now, each
    // until its own answer.
    const pendingReview = nextPlanReviewId(intentId);
    if (planApprovalReviewRequested(projectDir, pendingReview, intentId)) {
      requestPlanApprovalReviews(projectDir, authorities.map((authority) => authority.targetId), intentId);
      clearPlanApprovalReviewRequest(projectDir, pendingReview, intentId);
    }
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
          repliesFrom: auditMark(projectDir),
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

// --- Plan approval off ------------------------------------------------------------
//
// With plan approval off the plan is built as written. The person hears one
// line naming it, and the engine keeps the same record an approval would leave
// (questions file, receipt, audit row), each marked as not asked, so generation
// start, the worker brief, the swarm, and team merge read it unchanged.

export const PLAN_APPROVAL_OFF_ANSWER = "Plan approval off";

function planApprovalSettingFor(projectDir: string): PlanApprovalSetting | null {
  try {
    return resolvePlanApprovalSetting(projectDir, readFileSync(stateFilePath(projectDir), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * A Kiro IDE window that passes hooks no message text keeps its picker, so no
 * plan is built without asking there. With plan approval off, one line says so
 * and what an update enables; null while it is on.
 */
export function legacyPlanApprovalOffNotice(
  projectDir: string,
  directive: RunStageDirective | InvokeSwarmDirective,
): string | null {
  const setting = planApprovalSettingFor(projectDir);
  if (setting?.value !== "off") return null;
  const units: Array<string | null> = directive.kind === "run-stage" ? [directive.unit ?? null] : directive.units;
  const asking = units.some((unit) =>
    !codeGenerationExecutionAllowed(projectDir, { unit }, evaluateCodeGenerationApproval(projectDir, { unit }))
  );
  if (!asking) return null;
  return `Plan approval is off for this piece of work (${changeControlSourceLabel(setting.source)}), ` +
    "but this Kiro IDE build does not pass your messages to AI-DLC, so each plan is still shown here " +
    "for you to approve. Updating Kiro IDE lets plans build without asking.";
}

function planApprovalOffNotice(projectDir: string, units: Array<string | null>, setting: PlanApprovalSetting): string {
  const paths = units.map((unit) => targetView(projectDir, unit).plan_path);
  const written = paths.length === 1 ? `Plan written: ${paths[0]}.` : `Plans written: ${paths.join(", ")}.`;
  return `${written} Plan approval (${CHECK_GLOSS["plan-approval"]}) is off for this piece of work ` +
    `(${changeControlSourceLabel(setting.source)}). Starting code generation now. ` +
    "Do you want to look at the plan and approve it first?";
}

/**
 * Called after a build directive routed with plan approval off is published:
 * record, for each target that has no approval yet, that its plan was built
 * without asking. Idempotent for the same files. True when every target may
 * now build; false when nothing could be recorded for one (plan approval was
 * turned back on, or its plan or the workspace could not be read).
 */
export function publishPlanApprovalSkip(
  projectDir: string,
  directive: RunStageDirective | InvokeSwarmDirective,
): boolean {
  const units: Array<string | null> = directive.kind === "run-stage" ? [directive.unit ?? null] : directive.units;
  const setting = planApprovalSettingFor(projectDir);
  return withAuditLock(projectDir, () => {
    for (const unit of units) {
      if (setting?.value !== "off" || codeGenerationExecutionAllowed(projectDir, { unit })) continue;
      recordPlanApprovalSkipped(projectDir, unit, setting);
    }
    return units.every((unit) => codeGenerationExecutionAllowed(projectDir, { unit }));
  });
}

function recordPlanApprovalSkipped(projectDir: string, unit: string | null, setting: PlanApprovalSetting): void {
  const dir = codeGenerationRecordDir(projectDir, unit);
  const plan = readText(join(dir, PLAN_FILE));
  const instructions = readText(join(dir, INSTRUCTIONS_FILE));
  const read = readTestingContract(plan);
  if (!("contract" in read) || !instructions.trim()) return;
  // Plan approval off asks nothing; a project whose files cannot all be read
  // builds without a record of where it started.
  const source = workspaceSourceState(projectDir);
  const sourceFingerprint = source?.fingerprint ?? UNBINDABLE_FINGERPRINT;
  const authority = resolveCodeGenerationAuthority(projectDir, { unit });
  const fingerprint = approvalFingerprint(plan, instructions, read.contract.contract_sha256, authority);
  const view = targetView(projectDir, unit);
  const reason = `plan approval is off for this piece of work (${changeControlSourceLabel(setting.source)})`;
  const questionsPath = join(dir, QUESTIONS_FILE);
  const questions = questionsFileContent(
    `Built without asking: ${reason}.`,
    view, [], fingerprint, sourceFingerprint, PLAN_APPROVAL_OFF_ANSWER, BUILT_WITHOUT_ASKING_INTRO,
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
    plannedSourceSha256: sourceFingerprint,
    session: "engine",
    challengeId: "plan-approval-off",
    choice: "Approve Plan",
    questionsSha256: createHash("sha256").update(questions, "utf-8").digest("hex"),
    certifiedSourceSha256: sourceFingerprint,
    status: "approved",
    skipped: { source: setting.source },
  };
  withActiveDirectiveLock(projectDir, () => {
    writeFileAtomic(questionsPath, questions);
    writePlanApprovalReceipt(projectDir, receipt);
    if (source !== null) writeWorkspaceSourceSnapshot(projectDir, STAGE, source);
  });
  appendAuditEntryUnlocked("PLAN_APPROVAL_SKIPPED", {
    Stage: STAGE,
    Details: PLAN_APPROVAL_OFF_ANSWER,
    Checkpoint: "plan-approval",
    "Plan Target": authority.targetId,
    Intent: authority.intentId,
    "Directive Epoch": authority.directiveEpoch,
    "Run floor": authority.runFloor,
    "Approval Fingerprint": fingerprint,
    "Questions File": questionsFile,
    "Questions SHA-256": receipt.questionsSha256,
    "Prompt SHA-256": receipt.promptSha256,
    Source: setting.source,
    ...(unit !== null ? { Unit: unit, ...claimAttemptFields(projectDir, unit) } : {}),
  }, projectDir);
  collectStalePlanApprovalReceipts(projectDir, authority.intentId, authority.targetId, authority.runFloor);
}

// --- Recording an answer -------------------------------------------------------

// The engine's open Plan Approval question. `answered`: also while some (or,
// with "all", every) target already has an answer, for keeping replies to a
// grouped question and for the agent's record of a choice already recorded.
function currentPlanApprovalAsk(
  projectDir: string,
  answered: "none" | "some" | "all" = "none",
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
  if (record === null) return null;
  if (record.results !== undefined) {
    const all = record.targets.every((target) => record.results?.some((result) => result.unit === target.unit));
    if (answered === "none" || (all && answered !== "all")) return null;
  }
  const markerUnits: Array<string | null> = marker.unit !== undefined
    ? [marker.unit]
    : marker.units?.length ? marker.units : [null];
  const same = record.targets.length === markerUnits.length &&
    record.targets.every((target) => markerUnits.includes(target.unit));
  return same ? { marker, record } : null;
}

/**
 * The engine's Plan Approval question while it is the open step: whether every
 * plan it asks about has an answer, whether the person is editing the files,
 * whether `words` are exactly one of its choices ("1", "Approve Plan"), the
 * choice they pick, and, when they pick against the recorded answer, that
 * answer ("approve" or "request-changes", or null when they pick what is
 * recorded). Null when it is not the open step.
 */
export function openPlanApprovalQuestion(
  projectDir: string,
  words: string,
): {
  answered: boolean;
  editing: boolean;
  isChoice: boolean;
  picked: PlanApprovalAnswerChoice | null;
  overrules: "approve" | "request-changes" | null;
} | null {
  try {
    const open = currentPlanApprovalAsk(projectDir, "all");
    if (open === null) return null;
    const { record } = open;
    const pick = exactOptionPick(words, record.choices);
    const picked: PlanApprovalAnswerChoice | null =
      pick === 0 ? "approve" : pick === 1 ? "request-changes" : pick === 2 ? "edit" : null;
    const recorded = record.mode === "editing" ? null
      : (record.results ?? []).find((result) => (result.choice === "request-changes" ? "request-changes" : "approve") !== picked);
    return {
      answered: record.targets.every((target) => record.results?.some((result) => result.unit === target.unit)),
      editing: record.mode === "editing",
      isChoice: pick !== null,
      picked,
      overrules: picked === null || recorded === undefined || recorded === null ? null
        : recorded.choice === "request-changes" ? "request-changes" : "approve",
    };
  } catch {
    return null;
  }
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
  words?: string,
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
  if (source === null && !codeGenerationBuildsWithoutSource(projectDir, { unit })) {
    return {
      ok: false,
      notice: `AIDLC Plan Approval: nothing was recorded because the workspace source cannot be read right now` +
        `${workspaceSourceFailureSuffix()}. Run next for the repair.`,
    };
  }
  const sourceFingerprint = source?.fingerprint ?? UNBINDABLE_FINGERPRINT;
  const authority = resolveCodeGenerationAuthority(projectDir, { unit });
  const fingerprint = approvalFingerprint(plan, instructions, read.contract.contract_sha256, authority);
  const asked = record.targets.find((target) => target.unit === unit)?.fingerprint;
  const questionsPath = join(dir, QUESTIONS_FILE);
  const questions = questionsFileContent(
    record.question, view, record.choices, fingerprint, sourceFingerprint, APPROVED_ANSWER,
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
    plannedSourceSha256: sourceFingerprint,
    session,
    challengeId: record.askId,
    choice: "Approve Plan",
    questionsSha256: createHash("sha256").update(questions, "utf-8").digest("hex"),
    certifiedSourceSha256: sourceFingerprint,
    status: "approved",
  };
  withActiveDirectiveLock(projectDir, () => {
    writeFileAtomic(questionsPath, questions);
    writePlanApprovalReceipt(projectDir, receipt);
    keepApprovedPlanCopy(projectDir, authority, fingerprint, questions);
    if (source !== null) writeWorkspaceSourceSnapshot(projectDir, STAGE, source);
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
    ...(words ? { "Person Reply": words } : {}),
    ...(unit !== null ? { Unit: unit, ...claimAttemptFields(projectDir, unit) } : {}),
  }, projectDir);
  clearPlanApprovalReviewRequest(projectDir, authority.targetId, authority.intentId);
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
  words?: string,
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
  // A plan already built without asking keeps the person's words for its gate.
  if (targetId && planApprovalReviewRequested(projectDir, targetId, record.intentId) &&
    /^\[Answer\]:[ \t]*Plan approval off[ \t]*$/m.test(existing)) {
    requestPlanApprovalReview(projectDir, targetId, record.intentId, feedback ?? "");
  }
  appendAuditEntryUnlocked("QUESTION_ANSWERED", {
    Stage: STAGE,
    Details: "Request Changes",
    Checkpoint: "plan-approval",
    ...(targetId ? { "Plan Target": targetId } : {}),
    Session: session,
    "Asked By": "engine",
    ...(feedback ? { "User Input": feedback } : {}),
    ...(words && words !== feedback ? { "Person Reply": words } : {}),
    ...(unit !== null ? { Unit: unit } : {}),
  }, projectDir);
  return {
    unit,
    choice: "request-changes",
    fingerprint: approval.approvalFingerprint ?? asked?.fingerprint ?? "",
    ...(feedback ? { feedback } : {}),
  };
}

// --- The person's reply, and the conductor's record of it -----------------------
//
// While the question is open, the human-turn hook keeps every message the
// person types, verbatim, from whichever chat it arrives in. The conductor reads
// those words and records the choice the person made with `answer --checkpoint
// plan-approval`. The engine requires a reply since the question was shown,
// records the choice, keeps the person's words with it, and never reads meaning
// into them.

const ASK_REPLIES_MAX = 8;
const ASK_REPLY_MAX_CHARS = 8000;

// A picker answers this question when it offers the question's own choices
// (pickerOffersChoices), however the agent worded the question; several
// picks, or a picker offering anything else, answer some other question. A picker that names no options is matched by its question.
function pickerAsksThisQuestion(picker: PlanApprovalPickerQuestion, record: PlanApprovalAskRecord): boolean {
  if (picker.severalPicks) return false;
  if (!picker.options?.length) return picker.question?.trim() === record.question;
  return pickerOffersChoices(picker.options, record.choices);
}

/**
 * The human-turn hook's part while the engine's Plan Approval question is
 * open: keep the person's message. True when the question owns the reply; false
 * when no question is open or a picker answered some other question.
 */
export function notePlanApprovalAskReply(
  projectDir: string,
  session: string,
  text: string,
  picker?: PlanApprovalPickerQuestion,
): boolean {
  return withAuditLock(projectDir, () => {
    const open = currentPlanApprovalAsk(projectDir, "all");
    if (open === null) return false;
    const { record } = open;
    // Once every plan is answered, the question keeps the person's replies
    // only while a Request Changes is on record (until next closes it): a
    // correction they make is recorded with their words.
    const answeredAll = record.mode === "ask" &&
      record.targets.every((target) => record.results?.some((result) => result.unit === target.unit));
    if (answeredAll && !record.results?.some((result) => result.choice === "request-changes")) return false;
    if (picker && !pickerAsksThisQuestion(picker, record)) return false;
    const reply = text.trim();
    if (!reply || isNonAnswer(reply)) return true;
    const replies = [
      ...(record.replies ?? []),
      { session: session || "unidentified-session", text: reply.slice(0, ASK_REPLY_MAX_CHARS) },
    ].slice(-ASK_REPLIES_MAX);
    writePlanApprovalAsk(projectDir, { ...record, replies });
    // An exact pick ("1", "Approve Plan", "3") is syntax: record it now, so
    // the conductor only runs next. A grouped change request still needs to
    // know which plan, so the conductor reads that one.
    const pick = exactOptionPick(reply, record.choices);
    const choice: PlanApprovalAnswerChoice | null = pick === 0 ? "approve"
      : pick === 1 && record.targets.length === 1 ? "request-changes"
      : pick === 2 ? "edit"
      : null;
    if (choice !== null && record.mode !== "editing") {
      try {
        recordPlanApprovalAnswer(projectDir, session, { choice, exactPick: true });
      } catch {
        // The conductor reads the reply and records it.
      }
    }
    return true;
  });
}

export type PlanApprovalAnswerChoice = "approve" | "request-changes" | "edit";

// The person edits the plan files themselves: the question waits in edit mode,
// with no answer recorded, until they say done. Caller holds the audit lock.
function startEditing(projectDir: string, record: PlanApprovalAskRecord): PlanApprovalAnswerResult {
  const next: PlanApprovalAskRecord = { ...record, bound: false, mode: "editing" };
  delete next.lastNotice;
  delete next.replies;
  delete next.results;
  // Their "done" comes in a later reply.
  next.repliesFrom = auditMark(projectDir);
  writePlanApprovalAsk(projectDir, next);
  const files = record.targets.flatMap((target) => {
    const view = targetView(projectDir, target.unit);
    return [view.plan_path, view.instructions_path];
  });
  return {
    complete: false,
    message: `Recorded that the person will edit ${files.join(", ")} themselves. Tell them where the files ` +
      "are, end the turn, and wait for them to say done; then read what they changed and record their choice.",
  };
}

export interface PlanApprovalAnswer {
  choice: PlanApprovalAnswerChoice;
  /** The Units the choice is for; every Unit the question asks about when absent. */
  units?: string[];
  /** What to change, when the conductor states it; the person's words otherwise. */
  feedback?: string;
  /** The person's reply was the option itself, so their words say nothing about what to change. */
  exactPick?: true;
}

const ANSWER_LABELS: Record<PlanApprovalAnswerChoice, string> = {
  approve: "Approve Plan",
  "request-changes": "Request Changes",
  edit: "I'll edit the files",
};

export interface PlanApprovalAnswerResult {
  /** One line for the conductor: what was recorded and what runs next. */
  message: string;
  /** Every Unit the question asked about now has an answer. */
  complete: boolean;
}

/**
 * The conductor records the choice the person made at the engine's open Plan
 * Approval question. Throws when no question is open, when the person has not
 * replied since it was shown, or when a named Unit is not one it asks about.
 */
function humanTurnCount(projectDir: string): number {
  // A turn that was only a command to AIDLC is no reply that could change a pick.
  return readAuditShardEvents(projectDir).filter(isReplyTurn).length;
}

// A Request Changes on record stands until the person replies after it,
// whether they picked it exactly or the conductor read it: their newer reply
// decides, as the conductor reads it. Throws when it still stands. A record
// with no turn count (written before counts were kept) stands.
function assertRequestChangesCanChange(earlier: PlanApprovalAskResult[], turns: number): void {
  const standing = earlier.filter((result) => result.turns === undefined || result.turns >= turns);
  if (standing.some((result) => !result.read)) {
    throw new Error(
      'The person picked "Request Changes" for this plan and has not replied since. Run next to revise it; ' +
        "when they reply that they meant something else, record the choice they made then.",
    );
  }
  if (standing.length > 0) {
    throw new Error(
      "The person has not replied since Request Changes was recorded. End the turn, wait for their reply, then " +
        "record the choice they made.",
    );
  }
}

// The person's newer reply says a recorded Request Changes is not what they
// want now (the conductor's misreading, or a pick they changed): once they have
// replied since it was recorded, their approval is recorded straight away from
// the plan as it stands. Null when there is nothing to correct. Caller holds
// the audit lock.
function correctReadRequestChanges(
  projectDir: string,
  session: string,
  units: Array<string | null> | undefined,
): PlanApprovalAnswerResult | null {
  const record = readPlanApprovalAsk(projectDir, intentIdFor(projectDir));
  if (!record?.results || record.mode === "editing") return null;
  const targets: Array<string | null> = units?.length ? units : record.targets.map((target) => target.unit);
  const earlier = record.results.filter((result) => targets.includes(result.unit) && result.choice === "request-changes");
  if (earlier.length === 0 || earlier.length !== targets.length) return null;
  const turns = humanTurnCount(projectDir);
  assertRequestChangesCanChange(earlier, turns);
  // The replies kept since the Request Changes are the correction's words.
  const words = record.replies?.map((reply) => reply.text).join("\n") || undefined;
  const results = record.results.filter((result) => !targets.includes(result.unit));
  for (const unit of targets) {
    const outcome = approveTarget(projectDir, record, unit, session, words);
    if (!outcome.ok) throw new Error(outcome.notice);
    results.push({ ...outcome.result, read: true, turns });
  }
  const next: PlanApprovalAskRecord = { ...record, results };
  delete next.replies;
  writePlanApprovalAsk(projectDir, next);
  return {
    complete: true,
    message: `Recorded "Approve Plan" for ${labels(targets)}, correcting the Request Changes recorded before, with ` +
      "the plan as it stands now. Run next.",
  };
}

/**
 * The files the conductor may change while the engine's Plan Approval question
 * is open: each plan still waiting for an answer, its plan and its test
 * instructions, and only once the person has replied since the question was
 * shown. An instruction given with an approval ("approve, but add a test")
 * goes into the plan, and the approval then covers the plan as it stands.
 * Never the questions file, another plan's files, or code; empty before a
 * reply, while the person edits the files themselves, and in a question about
 * several plans while their latest reply is only a pick.
 */
export function planApprovalReplyEditableFiles(projectDir: string): string[] {
  try {
    const open = currentPlanApprovalAsk(projectDir, "some");
    const replies = open?.record.replies ?? [];
    if (open === null || open.record.mode !== "ask" || replies.length === 0) return [];
    // Kept words can be a question about the switch ("skip plan approval?"),
    // which is no reply: the files open only after a reply to the question.
    if (open.record.repliesFrom && !personRepliedAfter(projectDir, open.record.repliesFrom)) return [];
    // In a question about several plans a bare pick ("2") does not say which
    // plan: nothing opens until the person says more in their own words.
    if (open.record.targets.length > 1 && exactOptionPick(replies[replies.length - 1].text, open.record.choices) !== null) {
      return [];
    }
    const answered = new Set((open.record.results ?? []).map((result) => result.unit));
    return open.record.targets.filter((target) => !answered.has(target.unit)).flatMap((target) => {
      const dir = codeGenerationRecordDir(projectDir, target.unit);
      return [join(dir, PLAN_FILE), join(dir, INSTRUCTIONS_FILE)];
    });
  } catch {
    return [];
  }
}

// An engine question with no reply machinery of its own (where the work
// belongs, the new-work offers, which record or plan) is the open question
// from when it is asked until `next` names another step, or until the engine
// asks another question after it (a checkpoint or verification question asked
// again, a gate shown again), which then owns the person's reply.
interface OpenEngineQuestion {
  version: 1;
  askType: string;
  stateSha256: string;
  askedAt: string;
}

const LATER_QUESTION_EVENTS = new Set(["DECISION_RECORDED", "STAGE_AWAITING_APPROVAL"]);

function openEngineQuestionPath(projectDir: string): string {
  return planApprovalRuntimeFile(projectDir, "open-engine-question.json");
}

/** Called once such a question's marker is published. */
export function noteOpenEngineQuestion(projectDir: string, marker: { ask_type?: string; state_sha256: string }): void {
  if (!marker.ask_type) return;
  const record: OpenEngineQuestion = {
    version: 1, askType: marker.ask_type, stateSha256: marker.state_sha256, askedAt: isoTimestamp(),
  };
  writePlanApprovalRuntimeRecord(projectDir, openEngineQuestionPath(projectDir), `${JSON.stringify(record)}\n`);
}

/**
 * Whether such an engine question is the open step. The person's reply
 * answers it, so no question it was asked over keeps it.
 */
export function engineQuestionHoldsReplies(projectDir: string): boolean {
  try {
    const marker = readActiveDirectiveMarker(projectDir, readFileSync(stateFilePath(projectDir), "utf-8"));
    if (
      marker?.version !== 2 || marker.kind !== "ask" || typeof marker.ask_type !== "string" ||
      marker.ask_type === PLAN_APPROVAL_ASK_TYPE || marker.ask_type === GUARD_RECOVERY_ASK_TYPE
    ) {
      return false;
    }
    const noted = readPlanApprovalRuntimeRecord<OpenEngineQuestion>(openEngineQuestionPath(projectDir), "Open engine question");
    if (noted?.version !== 1 || noted.askType !== marker.ask_type || noted.stateSha256 !== marker.state_sha256) return true;
    return !readAuditShardEvents(projectDir).some((row) => LATER_QUESTION_EVENTS.has(row.event) && row.timestamp > noted.askedAt);
  } catch {
    return false;
  }
}

/**
 * Whether the open Plan Approval question already holds a reply of the
 * person's, kept since it was shown, that no answer records yet: their words
 * are for the conductor to read as their choice, not a reason to ask again.
 */
export function planApprovalKeptReplyWaits(projectDir: string): boolean {
  try {
    const open = currentPlanApprovalAsk(projectDir);
    return open !== null && open.record.mode === "ask" && (open.record.replies?.length ?? 0) > 0 &&
      (open.record.repliesFrom === undefined || personRepliedAfter(projectDir, open.record.repliesFrom));
  } catch {
    return false;
  }
}

/**
 * Whether a Request Changes is on record for a plan in this piece of work, so an
 * approval the conductor records goes to the engine's question, which corrects
 * a misread or says the person picked it.
 */
export function planApprovalCorrectionPending(projectDir: string): boolean {
  try {
    const record = readPlanApprovalAsk(projectDir, intentIdFor(projectDir));
    return record?.results?.some((result) => result.choice === "request-changes") ?? false;
  } catch {
    return false;
  }
}

export function recordPlanApprovalAnswer(
  projectDir: string,
  session: string,
  answer: PlanApprovalAnswer,
): PlanApprovalAnswerResult {
  return withAuditLock(projectDir, () => {
    const open = currentPlanApprovalAsk(projectDir, "all");
    if (open === null) {
      const corrected = answer.choice === "approve" ? correctReadRequestChanges(projectDir, session, answer.units) : null;
      if (corrected) return corrected;
      throw new Error("No Plan Approval question is open. Run next.");
    }
    const { record } = open;
    const replies = record.replies ?? [];
    const answeredBefore = record.mode === "ask" &&
      record.targets.every((target) => record.results?.some((result) => result.unit === target.unit));
    // Replies kept after every plan was answered are for a correction.
    if (replies.length === 0 || answeredBefore) {
      // Their exact pick may already be recorded: the same choice is done; a
      // different one would overrule what they picked.
      const units = record.targets.map((target) => target.unit);
      const recorded = record.results ?? [];
      const answeredAll = record.mode === "editing" || units.every((unit) => recorded.some((result) => result.unit === unit));
      if (answeredAll && recorded.length + (record.mode === "editing" ? 1 : 0) > 0) {
        // What is recorded for the plans this answer names (every plan when it
        // names none): approving the one plan in Request Changes is a change.
        const picked = recorded.filter((result) => result.unit !== null && answer.units?.includes(result.unit));
        const named = picked.length > 0 ? picked : recorded;
        const recordedAs = (result: PlanApprovalAskResult): PlanApprovalAnswerChoice =>
          result.choice === "request-changes" ? "request-changes" : "approve";
        const differs = named.find((result) => recordedAs(result) !== answer.choice);
        const theirs: PlanApprovalAnswerChoice = record.mode === "editing" ? "edit"
          : differs ? recordedAs(differs) : answer.choice;
        if (theirs === answer.choice) {
          return { complete: true, message: `The person's choice, "${ANSWER_LABELS[theirs]}", is already recorded. Run next.` };
        }
        // Nothing is built while the question is open: "I'll edit the files"
        // after an answer is their latest word, and the editing starts now. It
        // needs a reply of theirs after that answer was recorded.
        if (answer.choice === "edit") {
          const turns = humanTurnCount(projectDir);
          if (recorded.some((result) => result.turns === undefined || result.turns >= turns)) {
            throw new Error(
              `The person's choice, "${ANSWER_LABELS[theirs]}", is recorded and they have not replied since. ` +
                "Record \"I'll edit the files\" when they say so in a reply after it.",
            );
          }
          return startEditing(projectDir, record);
        }
        const corrected = answer.choice === "approve"
          ? correctReadRequestChanges(projectDir, session, named
            .filter((result) => result.choice === "request-changes").map((result) => result.unit))
          : null;
        if (corrected) return corrected;
        throw new Error(
          `The person picked "${ANSWER_LABELS[theirs]}" for this plan question, and that is recorded. Run next; if ` +
            'they meant something else, record "Review the plan" and the question comes back.',
        );
      }
      // From their own terminal no reply can be kept, so name the step that
      // works there: they read the plan and build it without the question.
      // A team's strict Guard Policy keeps plan approval on, so the switch
      // would be refused: name that line, and answering in a chat.
      throw new Error(!personAtOwnTerminal(projectDir)
        ? "The person has not replied to the plan question since it was shown. End the turn, wait for their " +
          "reply, then record the choice they made."
        : memoryStrictHoldsGuardPolicy(projectDir)
        ? "AI-DLC cannot see a chat in this terminal, so it cannot keep your answer to the plan question. " +
          `${fenceSwitchSentence(projectDir, "plan-approval")} To answer the question, open this folder in your ` +
          "AI tool and reply to it there."
        : "AI-DLC cannot see a chat in this terminal, so it cannot keep your answer to the plan question. To build " +
          "the plan from this terminal, read it, then turn plan approval off for this work: run " +
          `\`${aidlcDispatcherInvocation("config set guard.plan-approval off")}\` with AIDLC_SKIP_HUMAN_PRESENCE_GUARD=1 ` +
          "set, then run next.");
    }
    // Words kept since the question can be a question or a command to AIDLC
    // ("skip plan approval?"), which answers nothing: a choice needs a reply.
    if (record.repliesFrom && !personRepliedAfter(projectDir, record.repliesFrom)) {
      throw new Error(
        "The person has not answered the plan question since it was shown: their message since then was a " +
          "question or a command to AIDLC, not an answer. Answer them and end the turn. If they want plan approval " +
          `off for this work, run \`${aidlcDispatcherInvocation("config set guard.plan-approval off")}\` and say ` +
          "so in one line. Then record the choice they make.",
      );
    }
    // A reply that is exactly Request Changes is the person's pick for these
    // plans: it binds until a later reply says otherwise.
    if (answer.choice !== "request-changes" && exactOptionPick(replies[replies.length - 1].text, record.choices) === 1) {
      throw new Error(
        `The person picked "Request Changes" for ${labels(record.targets.map((target) => target.unit))}. Record ` +
          "that for the plan(s) they meant (ask which, when they did not say), or ask them if you read their words " +
          "differently.",
      );
    }
    const words = replies.map((reply) => reply.text).join("\n");
    // What to change: their messages, leaving out a message that is only an option pick.
    const said = replies.filter((reply) => exactOptionPick(reply.text, record.choices) === null)
      .map((reply) => reply.text).join("\n");
    const who = session || replies[replies.length - 1].session;
    const units = record.targets.map((target) => target.unit);
    const answered = new Set((record.results ?? []).map((result) => result.unit));
    let chosen: Array<string | null>;
    if (answer.units && answer.units.length > 0) {
      const unknown = answer.units.filter((unit) => !units.includes(unit));
      if (unknown.length > 0) {
        throw new Error(
          `The plan question asks about ${labels(units)}, not ${unknown.map((unit) => `unit "${unit}"`).join(", ")}.`,
        );
      }
      chosen = answer.units;
    } else {
      chosen = units.filter((unit) => !answered.has(unit));
    }
    if (answer.choice === "approve") {
      const standing = (record.results ?? []).filter((result) =>
        chosen.includes(result.unit) && result.choice === "request-changes");
      if (standing.length > 0) assertRequestChangesCanChange(standing, humanTurnCount(projectDir));
    }
    const next: PlanApprovalAskRecord = { ...record, bound: false };
    delete next.lastNotice;
    if (answer.choice === "edit") return startEditing(projectDir, record);
    const results: PlanApprovalAskResult[] = (record.results ?? []).filter((result) => !chosen.includes(result.unit));
    const approved: Array<string | null> = [];
    const edited: Array<string | null> = [];
    const repairs: string[] = [];
    const failures: string[] = [];
    for (const unit of chosen) {
      if (answer.choice === "request-changes") {
        results.push(requestChangesFor(
          projectDir, record, unit, who, answer.feedback?.trim() || (answer.exactPick ? undefined : said || undefined), words,
        ));
        continue;
      }
      const outcome = approveTarget(projectDir, record, unit, who, words);
      if (outcome.ok) {
        results.push(outcome.result);
        approved.push(unit);
        if (outcome.changed) edited.push(unit);
      } else if (outcome.result) {
        results.push(outcome.result);
        repairs.push(outcome.notice);
      } else {
        failures.push(outcome.notice);
      }
    }
    if (failures.length > 0 && approved.length === 0 && repairs.length === 0) {
      throw new Error(failures[0]);
    }
    // Any answer can change once the person replies again: the turn count says
    // when it was recorded, and `read` marks the conductor's reading.
    const turns = humanTurnCount(projectDir);
    for (const result of results) {
      if (chosen.includes(result.unit)) Object.assign(result, answer.exactPick ? { turns } : { read: true, turns });
    }
    next.results = results;
    next.mode = "ask";
    delete next.pendingChange;
    const complete = units.every((unit) => results.some((result) => result.unit === unit));
    if (complete) delete next.replies;
    writePlanApprovalAsk(projectDir, next);
    const recorded = answer.choice === "approve"
      ? (approved.length > 0
        ? `Recorded "Approve Plan" for ${labels(approved)}` +
          (edited.length > 0 ? `, with the plan as it stands now (${labels(edited)} changed since it was shown)` : "")
        : "Nothing was approved")
      : `Recorded "Request Changes" for ${labels(chosen)}, with the person's words as what to change`;
    const rest = complete ? " Run next." : ` Record the person's choice for ${labels(units.filter((unit) =>
      !results.some((result) => result.unit === unit)))} too, then run next.`;
    return { complete, message: `${recorded}.${rest}${repairs.length > 0 ? ` ${repairs.join(" ")}` : ""}` };
  });
}

// --- "Review the plan first" after the build started -----------------------------
//
// With plan approval off, "review the plan first" can arrive while that plan is
// already being built. The build finishes; then the person sees the plan beside
// what was built, and nothing else starts until they answer. At that target's
// own gate the plan rides on the gate as a notice, and the gate's answer decides
// (Request Changes there sends it back with their words). Anywhere else, the
// engine asks about that plan before any other work starts.

function isGateFor(directive: Directive, unit: string | null): boolean {
  if (directive.kind === "present-gate") return directive.stage === STAGE;
  if (directive.kind === "run-stage" && directive.stage === STAGE) {
    // A swarm batch checkpoint reviews the whole batch the Unit was built in.
    if (directive.swarm_checkpoint !== undefined) return true;
    return (directive.gate_only === true || directive.construction_checkpoint !== undefined) &&
      (directive.unit ?? null) === unit;
  }
  return false;
}

function holdsWork(directive: Directive): boolean {
  return directive.kind === "run-stage" || directive.kind === "invoke-swarm" ||
    directive.kind === "present-gate" || directive.kind === "dispatch-subagent";
}

function builtPlanNotice(projectDir: string, review: PendingPlanReview): string {
  const view = targetView(projectDir, review.unit);
  const summary = view.summary.length > 0 ? ` It says: ${view.summary.join("; ")}.` : "";
  const words = review.feedback ? ` You asked for changes: "${review.feedback}". Choose Request Changes here to send it back with them.` : "";
  return `You asked to review the plan for ${targetLabel(review.unit)} while it was being built. Here it is beside what was built: ` +
    `${view.plan_path}.${summary}${words || " Approving here keeps it; Request Changes sends it back with your words."}`;
}

/**
 * The directive `next` emits, adjusted for a "review the plan first" that came
 * in while that plan was being built. Read-only; clears nothing.
 */
export function withBuiltPlanReviews(projectDir: string, directive: Directive): Directive {
  if (!holdsWork(directive)) return directive;
  const intentId = intentIdFor(projectDir);
  const pending = pendingBuiltPlanReviews(projectDir, intentId);
  if (pending.length === 0) return directive;
  const atGate = pending.filter((review) => isGateFor(directive, review.unit));
  if (atGate.length > 0) {
    directive.change_notices = [
      ...(directive.change_notices ?? []),
      ...atGate.map((review) => builtPlanNotice(projectDir, review)),
    ];
    return directive;
  }
  // Their own plan beat asks through the router; a Unit whose words are
  // already kept waits for its gate.
  const ownBeat = isPlanApprovalBeat(directive)
    ? directive.kind === "run-stage" ? [directive.unit ?? null] : directive.units
    : [];
  const held = pending.filter((review) => review.feedback === undefined && !ownBeat.includes(review.unit));
  if (held.length === 0) return directive;
  const units = held.map((review) => review.unit);
  return planApprovalAskDirective(projectDir, units, {
    question: units.length === 1
      ? `${targetLabel(units[0])} was built from this plan while plan approval was off. Keep it?`
      : `These ${units.length} plans were built while plan approval was off. Keep them?`,
    editing: false,
    note: "The person asked to review this plan while it was being built. Show it beside what was built; nothing else starts until they answer.",
  });
}

/** Called when a gate carrying a built-plan notice is published: the review has been shown. */
export function settleBuiltPlanReviews(projectDir: string, directive: Directive): void {
  if (!holdsWork(directive)) return;
  const intentId = intentIdFor(projectDir);
  // A review that named no plan waits for the next plan beat. Other work handed
  // over means no plan is about to be built, so it is not carried further.
  if (!isPlanApprovalBeat(directive)) clearPlanApprovalReviewRequest(projectDir, nextPlanReviewId(intentId), intentId);
  for (const review of pendingBuiltPlanReviews(projectDir, intentId)) {
    if (isGateFor(directive, review.unit)) clearPlanApprovalReviewRequest(projectDir, review.targetId, intentId);
  }
}

// --- "Review the plan" ---------------------------------------------------------
//
// The person asks to look at a plan before it is built, in their own words; the
// conductor reads that and records it (`answer --checkpoint plan-approval
// --details "Review the plan"`). The engine keeps the request and honors it:
// the next `next` asks for approval before that plan is built.

  /\b(?:review|re-?review|re-?approve|look (?:at|over)|see|show me|check|reopen)\b[^.?!]{0,40}\b(?:the |my |this |that )?(?:code )?plan\b/i;

/**
 * A rules part's route, read only when it is the payload its receipt was
 * minted for: the marker is a file in the workspace. `unit` is the signed Unit
 * (`p` says the step has one; `u` names it); the marker's own top-level Unit is
 * not covered by the receipt, so it never decides the target. `built` names
 * the targets when the part delivers a step after the build (the completion
 * gate, every Unit built, a Unit or swarm checkpoint, the settled swarm), and
 * is null for a plan or build step. Null when the payload is missing or edited.
 */
function signedPartRoute(
  projectDir: string,
  marker: ActiveDirectiveMarker,
): { unit: string | null; built: Array<string | null> | null } | null {
  const payload = marker.steering_payload;
  if (!payload) return null;
  const receipt = marker.steering_payload_receipt;
  const keyPath = steeringTokenKeyPathFor(projectDir, stateFilePath(projectDir));
  if (typeof receipt !== "string" || !steeringPayloadAuthenticAt(keyPath, payload, receipt)) return null;
  const unit = payload.p === true && typeof payload.u === "string" ? payload.u : null;
  const batch = payload.y as { units?: unknown } | undefined;
  if (payload.o !== true && payload.z !== true && payload.t !== true && payload.j === undefined && batch === undefined) {
    return { unit, built: null };
  }
  const units = Array.isArray(batch?.units) ? batch.units : [];
  const named = units.length > 0 && units.every((member) => {
    try {
      return typeof member === "string" && codeGenerationTargetId({ unit: member }).length > 0;
    } catch {
      return false;
    }
  });
  return { unit, built: named ? units as string[] : [unit] };
}

// The rows that say where the stage (or a Unit of it) stands.
const STAGE_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  "STAGE_STARTED", "STAGE_AWAITING_APPROVAL", "STAGE_REVISING", "STAGE_COMPLETED",
  "STAGE_SKIPPED", "GATE_APPROVED", "GATE_REJECTED",
]);

/**
 * Whether Code Generation's completion gate for `unit` (or the stage) is in
 * front of the person: its latest lifecycle row is the presentation. The engine
 * issues that gate as a run-stage, so the directive kind alone cannot say.
 */
function atCompletionGate(projectDir: string, unit: string | null): boolean {
  let latest: string | null = null;
  for (const row of readAuditShardEvents(projectDir)) {
    if (!STAGE_LIFECYCLE_EVENTS.has(row.event) || auditBlockField(row.block, "Stage") !== STAGE) continue;
    if (unit !== null && auditBlockField(row.block, "Unit") !== unit) continue;
    latest = row.event;
  }
  return latest === "STAGE_AWAITING_APPROVAL";
}

/**
 * The person asked to review the plan while code generation may keep
 * building (an approved plan, or plan approval off). The next `next` asks for
 * approval again before anything else runs. Returns what to tell the person,
 * or null when no Code Generation plan step is in play.
 */
export function requestPlanApprovalReviewNow(projectDir: string): string | null {
  return withAuditLock(projectDir, () => {
    let state: string;
    try {
      state = readFileSync(stateFilePath(projectDir), "utf-8");
    } catch {
      return null;
    }
    const marker = readActiveDirectiveMarker(projectDir, state);
    const current = marker?.version === 2 ? marker : null;
    if ((current?.stage ?? getField(state, "Current Stage")?.trim()) !== STAGE) return null;
    // The plan(s) the current directive names, whatever it is: a rules part is
    // the run-stage on its way, and a directive a compacted chat must re-read,
    // or a question about a Unit, keeps its Unit(s). A pause, or a question
    // that names no plan, leaves it to the plan the next `next` routes. A rules
    // part whose route checks out names its own Unit; the marker's top-level
    // Unit is not covered by its receipt.
    const runStage = current?.kind === "run-stage" || current?.kind === "load-steering";
    const signed = current?.kind === "load-steering" ? signedPartRoute(projectDir, current) : null;
    const units: Array<string | null> = signed
      ? [signed.unit]
      : current?.unit !== undefined
        ? [current.unit]
        : current?.units?.length ? current.units : runStage ? [null] : [];
    // A part on its way to a step that follows the build cannot show the plan
    // before anything is built: the code already is. Not every such step has a
    // person reviewing it (an autonomous checkpoint, the settled swarm), so the
    // plan is shown now, while the person is asking.
    // The stage's own completion gate comes after the build too.
    const gate = signed === null && current?.kind === "run-stage" && atCompletionGate(projectDir, current.unit ?? null);
    const built = signed?.built ?? (gate ? [current.unit ?? null] : null);
    if (built !== null) {
      const plans = built.map((unit) =>
        toPosix(relative(projectDir, join(codeGenerationRecordDir(projectDir, unit), PLAN_FILE))));
      return `The code for ${labels(built)} is already built from its plan, so show them the plan now ` +
        `(${plans.join(", ")}), then carry on with ` + (signed?.built ? "the step that is arriving." : "this gate.");
    }
    const intentId = current ? current.intent_uuid ?? "bare-space" : intentIdFor(projectDir);
    try {
      requestPlanApprovalReviews(
        projectDir,
        units.length > 0 ? units.map((unit) => codeGenerationTargetId({ unit })) : [nextPlanReviewId(intentId)],
        intentId,
      );
    } catch (error) {
      return `The request to review the plan could not be recorded (${errorMessage(error)}), so nothing ` +
        "changed. Tell the person, then record it again.";
    }
    // The person looks again: an answer recorded for these plans before (a
    // misread, or one they changed their mind about) no longer decides them,
    // and the question shown again is a fresh one, answered only by a reply
    // after it.
    const asked = readPlanApprovalAsk(projectDir, intentId);
    // A request that names no plan is about the question on record, if any.
    const looked: Array<string | null> = units.length > 0 ? units : (asked?.targets.map((target) => target.unit) ?? []);
    if (asked && (asked.results?.some((result) => looked.includes(result.unit)) ||
      asked.targets.some((target) => looked.includes(target.unit)))) {
      const results = (asked.results ?? []).filter((result) => !looked.includes(result.unit));
      const reopened: PlanApprovalAskRecord = {
        ...asked, askId: randomBytes(16).toString("hex"), repliesFrom: auditMark(projectDir), bound: true,
      };
      delete reopened.replies;
      if (results.length > 0) reopened.results = results; else delete reopened.results;
      writePlanApprovalAsk(projectDir, reopened);
    }
    return `Recorded that the person wants to review the plan${units.length > 0 ? ` for ${labels(units)}` : ""}. ` +
      "Run next: the plan is shown for approval before anything else is built.";
  });
}
