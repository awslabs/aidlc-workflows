// Deterministic Testing Posture contract for Code Generation.
//
// Practices remain human-authored prose, but code generation needs one stable
// execution contract. This module resolves methodology independently from
// coverage/tooling notes, builds a methodology-specific plan profile, binds the
// result to the active scope/test strategy/project type, and fingerprints the
// approved plan + unit test instructions. Both the dispatch guard and autonomous
// swarm referee consume the same contract.

import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type AcceptedChange,
  authorityFor,
  activeIntentUuid,
  delegatedWorktreeIntent,
  decideFence,
  attemptEventDefinitelyBefore,
  assertNoSymlinkInChainOrThrow,
  auditBlockField,
  boltSlugForUnit,
  collectStalePlanApprovalReceipts,
  commitPlanApprovalBatch,
  planApprovalBatchCommitted,
  contentBeforeTerminalReviewAppendix,
  currentSwarmSourceMergeChain,
  docsRoot,
  errorMessage,
  getField,
  guardPolicyAcceptsChanges,
  guardStandAsideSpeaks,
  guardStoodAsideLine,
  gitCommitSourceListing,
  isoTimestamp,
  latestLedgerSession,
  latestMainWorkflowStageRunFloorForProject,
  legacyBoltName,
  legacyWorktreePath,
  maximalAttemptEvents,
  LEGACY_PLAN_APPROVAL_RECOVERY_CHOICE,
  clearPlanApprovalChallenge,
  clearPlanApprovalLegacyOffer,
  clearPlanApprovalOverrideRequest,
  clearPlanApprovalReceipt,
  readActiveDirectiveMarker,
  readAuditShardEvents,
  readBaselineSourceSnapshot,
  readPlanApprovalChallenge,
  resolveInvokingSessionId,
  readPlanApprovalLegacyOffer,
  readPlanApprovalLegacyWindow,
  readPlanApprovalLegacyRecoveryChallenge,
  readPlanApprovalOverrideRequest,
  readApprovedPlanCopy,
  readPlanApprovalReceipt,
  readPlanApprovalResponse,
  readPlanApprovalViolation,
  readProtectedQuestion,
  protectedQuestionsElsewhere,
  moveProtectedQuestion,
  DECISION_PAIRING_EVENTS,
  decisionAnsweredBy,
  sortAttemptEvents,
  planApprovalChallengeRelativePath,
  readRegularFileNoFollowOrThrow,
  recordDir,
  recordFileTargetOrThrow,
  relativeRecordDir,
  recordAcceptedChanges,
  recordGuardStoodAside,
  recordHookDrop,
  renderChangedPaths,
  renderSourcePathKeys,
  governedChangeControl,
  intentRepos,
  resolveBoltDag,
  resolveBoltIdentity,
  resolveAuditWorktreePath,
  resolveConstructionRepo,
  resolveChangeControl,
  resolveProjectDir,
  stalePlanApprovalReceiptsForTarget,
  resolveWorkflowSelection,
  stateFilePath,
  stateDigest,
  swarmConvergedUnits,
  serializeSourceListing,
  sourceListingSha256,
  parseSourceListing,
  structuredField,
  structuredFieldSpan,
  toPosix,
  stripRecommendedDecorator,
  sameWorkspaceSource,
  UNBINDABLE_FINGERPRINT,
  PLAN_APPROVAL_ASK_TYPE,
  validateUnitName,
  visibleMarkdownLines,
  withActiveDirectiveLock,
  withAuditLock,
  workspaceSourceChangedPaths,
  workspaceSourceFailureSuffix,
  workspaceSourceFingerprint,
  workspaceSourceState,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
  writeBufferAtomic,
  writeRecordFileNoFollow,
  writePlanApprovalChallenge,
  writePlanApprovalLegacyRecoveryResponse,
  writePlanApprovalOverrideRequest,
  writeApprovedPlanCopy,
  writePlanApprovalReceipt,
  runtimeSessionHint,
  writePlanApprovalResponse,
  writeProtectedResponse,
  markProtectedQuestionReplied,
  readProtectedResponse,
  PROTECTED_RESPONSE_WORDS_MAX_CHARS,
  writeWorkspaceSourceSnapshot,
  type GuardRemedyOp,
  type ActiveDirectiveMarker,
  type AuditShardEvent,
  type PlanApprovalOverrideRequest,
  type PlanApprovalReceiptKey,
  type PlanApprovalBatchMember,
  type PlanApprovalRuntimeBatch,
  type PlanApprovalRuntimeChallenge,
  type PlanApprovalRuntimeResponse,
  type PlanApprovalRuntimeIdentity,
  type PlanApprovalRuntimeProvenance,
  type ApprovedPlanCopy,
  type PlanApprovalRuntimeReceipt,
  type WorkspaceSourceState,
  type WorkspaceSourceListing,
  type ProtectedQuestion,
  PLAN_APPROVAL_ASKED_BY_ENGINE,
  planApprovalAskIsOpen,
  TESTING_POSTURE_SUBCOMMANDS,
} from "./aidlc-lib.ts";
import { CHECK_GLOSS } from "./aidlc-guard-fences.ts";
import { aidlcToolInvocation, entrySkillInvocation } from "./aidlc-runtime-paths.ts";
import { APPROVAL_GATE_CHOICES, exactOptionPick, isNonAnswer, isOneOfChoices, pickerOffersChoices } from "./aidlc-reply-reader.ts";

export type TestingMethodology = "tdd" | "bdd" | "atdd" | "test-after" | "custom";
export type TestStrategy = "minimal" | "standard" | "comprehensive";
export type ProjectType = "greenfield" | "brownfield";
export type MemoryLayer = "org" | "team" | "project";

export interface TestingPostureSections {
  org?: string;
  team?: string;
  project?: string;
}

export interface PlanProfile {
  methodology: TestingMethodology;
  runner_step: string;
  runner_ready_before_first_test: true;
  testable_layers: string[];
  steps: string[];
}

export interface TestObligations {
  strategy: TestStrategy;
  strategy_volume: string[];
  scope_floor: string[];
  combination_rule: string;
}

export interface TestingPostureContractBody {
  version: 1;
  methodology: TestingMethodology;
  source: MemoryLayer | "fallback";
  ordering: string;
  scope: string;
  test_strategy: TestStrategy;
  project_type: ProjectType;
  applicable_notes: Array<{ layer: MemoryLayer; text: string }>;
  obligations: TestObligations;
  plan_profile: PlanProfile;
  input_sha256: string;
}

export interface TestingPostureContract extends TestingPostureContractBody {
  contract_sha256: string;
}

export interface CodeGenerationApproval {
  ok: boolean;
  unit: string | null;
  reason: string;
  planExists: boolean;
  instructionsExist: boolean;
  approved: boolean;
  contractValid: boolean;
  fingerprintValid: boolean;
  receiptValid: boolean;
  contractHash: string | null;
  approvalFingerprint: string | null;
  directiveEpoch: string | null;
  /** Operational provenance failure, independent of the plan-approval fence. */
  executionFailure?: string;
  /** The current receipt is a human break-glass override (content and attempt only). */
  override?: true;
  /**
   * The receipt recorded for this plan question was written by plan approval
   * off (built without asking), not by a person's answer.
   */
  skipped?: true;
}

export interface CodeGenerationTarget {
  unit: string | null;
}

/**
 * The Code Generation directive `next` is about to issue: a run-stage for one
 * Unit (or none), or an invoke-swarm for a group. While `next` routes it, this
 * directive, not the one it replaces, names the plan(s) being asked about.
 */
export type CodeGenerationIssuance =
  | { kind: "run-stage"; unit?: string }
  | { kind: "invoke-swarm"; units: string[] };

export interface CodeGenerationAuthority extends CodeGenerationTarget {
  targetId: string;
  intentId: string;
  directiveEpoch: string;
  runFloor: string;
  stageDir: string;
  sourceFloor: string;
  markerRevision: number;
}

export interface PlanApprovalQuestionEvidence {
  authority: CodeGenerationAuthority;
  fingerprint: string;
  questionsPath: string;
  questionsRelativePath: string;
  questionsSha256: string;
  promptSha256: string;
  plannedSourceSha256: string;
  /**
   * The human lines for source drift this evidence accepted and recorded under
   * Change Control `relaxed` (the CHANGE_ACCEPTED row is written before any
   * re-baseline). Empty under `strict` (drift throws) and when nothing moved.
   */
  changeNotices: string[];
}

// --- Source drift at the Plan Approval checkpoint --------------------------
//
// The plan binds to a workspace source fingerprint. When live source no longer
// matches it, Change Control decides the consequence: `strict` refuses with the
// human sentence below (the conductor's remedy travels separately), `relaxed`
// accepts, records the change once, tells the human once, and re-baselines the
// recorded source so the same change is not reported at every later check.

const CODE_GENERATION_STAGE = "code-generation";

/** Conductor-only: the command path that reopens approval. Never the human sentence. */
export const PLAN_SOURCE_DRIFT_REMEDY =
  "Re-run the fingerprint command and re-present the plan.";

// The break-glass exit. It is always the LAST remedy listed, it is never
// proposed or initiated by the conductor, and it is opened only by the human
// typing the phrase below as a prompt (the human-turn hook records that typed
// prompt; a picked option never counts).
export const PLAN_APPROVAL_OVERRIDE_PHRASE = "Override Plan Approval: <reason>";
export const PLAN_APPROVAL_OVERRIDE_PHRASE_RE = /^override plan approval:\s*(\S.*)$/i;
export const PLAN_APPROVAL_BREAK_GLASS_REMEDY =
  "Break glass (human only): type exactly `Override Plan Approval: <reason>` in chat; " +
  "the conductor then records it with the break-glass steps in Step 3 of code-generation.md.";
export const PLAN_APPROVAL_OVERRIDE_HUMAN_ONLY =
  "Plan Approval override is human-only: the human must type exactly " +
  "`Override Plan Approval: <reason>` in chat; then re-run this command with that reason.";

export class PlanApprovalSourceDriftError extends Error {
  readonly remedy = PLAN_SOURCE_DRIFT_REMEDY;
  constructor(message: string) {
    super(message);
    this.name = "PlanApprovalSourceDriftError";
  }
}

// A source boundary that cannot be bound is not drift: nothing moved, the walk
// failed. The refusal names that, and its remedies are ordered: repair the
// boundary first (an ordinary re-fingerprint then works), break glass last.
export const PLAN_APPROVAL_SOURCE_UNBINDABLE_CODE = "PLAN_APPROVAL_SOURCE_UNBINDABLE";
export const BREAK_GLASS_REMEDY_OP = "break-glass-override";

export interface PlanApprovalRemedy {
  op: GuardRemedyOp | typeof BREAK_GLASS_REMEDY_OP;
  action: string;
  requiresHuman: boolean;
  executableNow: boolean;
}

export const PLAN_APPROVAL_REPAIR_SOURCE_BOUNDARY_REMEDY =
  "Repair the source boundary: shrink or exclude the offending path, declare real " +
  "source under an excluded directory in .aidlc-source-paths.json, or remove the " +
  "broken symlink; then run next.";

export function planApprovalUnbindableRemedies(): PlanApprovalRemedy[] {
  return [
    {
      op: "repair-source-boundary",
      action: PLAN_APPROVAL_REPAIR_SOURCE_BOUNDARY_REMEDY,
      requiresHuman: false,
      executableNow: true,
    },
    {
      op: BREAK_GLASS_REMEDY_OP,
      action: PLAN_APPROVAL_BREAK_GLASS_REMEDY,
      requiresHuman: true,
      executableNow: false,
    },
  ];
}

export class PlanApprovalUnbindableError extends Error {
  readonly code = PLAN_APPROVAL_SOURCE_UNBINDABLE_CODE;
  readonly remedies: PlanApprovalRemedy[];
  constructor(blocked: "presented" | "recorded") {
    const remedies = planApprovalUnbindableRemedies();
    super(
      `Plan Approval cannot be ${blocked}: the workspace source cannot be bound${workspaceSourceFailureSuffix()}, so ` +
        `${blocked === "presented" ? "no challenge was minted" : "no receipt was written"}. ` +
        "Remedies, in order: " +
        remedies.map((remedy, index) => `(${index + 1}) ${remedy.action}`).join(" "),
    );
    this.name = "PlanApprovalUnbindableError";
    this.remedies = remedies;
  }
}

// `unbound` is the walk failing now, which is not a change: the reason it
// failed is named instead of a file list, and the sentence asks for the
// boundary repair rather than a re-approval that could not certify either.
function describeSourceDrift(paths: string[] | null, unbound = false): string {
  if (unbound) {
    return `The workspace source cannot be bound${workspaceSourceFailureSuffix()}, so the source this plan was approved against cannot be checked.`;
  }
  if (paths === null || paths.length === 0) {
    return "Source files changed since this plan was approved.";
  }
  const count = paths.length === 1 ? "1 file" : `${paths.length} files`;
  return `${count} changed since this plan was approved: ${renderChangedPaths(paths)}.`;
}

/** The strict human sentence for source drift after the plan was approved. */
export function planSourceDriftStrictMessage(paths: string[] | null, unbound = false): string {
  return unbound
    ? `${describeSourceDrift(paths, true)} ${PLAN_APPROVAL_REPAIR_SOURCE_BOUNDARY_REMEDY} ${PLAN_APPROVAL_BREAK_GLASS_REMEDY}`
    : `${describeSourceDrift(paths)} Look them over and approve the plan again to continue.`;
}

/** The relaxed human sentence for source drift after the plan was approved. */
export function planSourceDriftRelaxedNotice(paths: string[] | null, unbound = false): string {
  return (
    `${describeSourceDrift(paths, unbound)} Carrying on. ` +
    "Do you want to look at the plan again and approve it first?"
  );
}

/**
 * Other code moved after the human approved the plan. On every Guard Policy the
 * build continues: approval is about the plan, and the person hears once what
 * moved. The line comes as the build starts, so it offers nothing to do first.
 */
export function planSourceMovedNotice(paths: string[] | null, unit: string | null): string {
  return `${describeSourceDrift(paths)} Building ${unit ?? "the code"} now.`;
}

/**
 * The Change Control consequence of the workspace source moving from
 * `recorded` to `current`: under strict, the refusal to throw; under relaxed,
 * the change to record. The listed paths come from the snapshot kept for the
 * recorded fingerprint when one exists; otherwise only the digests speak.
 * This is the checkpoint's one read of the setting, so it is also where a
 * memory edit that moved the value is traced: a mutating caller (the decision
 * and answer records, generation start) passes `trace`, the read-only judge
 * behind the dispatch guard and `next` does not. An invalid memory value is
 * the resolver's validation error under both. After a real approval, a verified
 * lowered plan-approval fence also permits drift under a strict policy; this
 * changes execution provenance, never the recorded human approval.
 */
function judgePlanSourceDrift(
  projectDir: string,
  unit: string | null,
  recorded: string,
  current: WorkspaceSourceState | null,
  trace: boolean,
  loweredFence = false,
  afterApproval = false,
): { accepted: AcceptedChange } | { refusal: PlanApprovalSourceDriftError } {
  const paths = workspaceSourceChangedPaths(projectDir, CODE_GENERATION_STAGE, recorded, current);
  const unbound = current === null;
  const resolution = trace ? governedChangeControl(projectDir) : resolveChangeControl(projectDir);
  // Once the human approved the plan, source that moved elsewhere is never a
  // reason to ask again: the approval is about the plan and its test
  // instructions, so the build continues with one line naming what moved. Only
  // a source that cannot be read at all stays a strict refusal, because then
  // nothing can say what the build starts from. Before approval (the recorded
  // decision and answer of the legacy picker path) a strict policy still
  // refuses, so nothing written during the approval window rides on it.
  const moved = afterApproval && !unbound;
  if (resolution.value === "strict" && !loweredFence && !moved) {
    return { refusal: new PlanApprovalSourceDriftError(planSourceDriftStrictMessage(paths, unbound)) };
  }
  return {
    accepted: {
      checkpoint: "plan-approval",
      stage: CODE_GENERATION_STAGE,
      unit,
      changed: paths,
      recorded,
      current: current?.fingerprint ?? UNBINDABLE_FINGERPRINT,
      notice: moved
        ? planSourceMovedNotice(paths, unit)
        : loweredFence && resolution.value === "strict"
          ? `${describeSourceDrift(paths, unbound)} Carrying on, since the plan approval check (${CHECK_GLOSS["plan-approval"]}) ` +
            "is off for this work. Do you want to look at the plan again and approve it first?"
          : planSourceDriftRelaxedNotice(paths, unbound),
    },
  };
}

/** Keep the listing behind the current fingerprint so a later drift can name paths. */
function keepWorkspaceSourceSnapshot(
  projectDir: string,
  state: WorkspaceSourceState | null,
): void {
  if (state !== null) writeWorkspaceSourceSnapshot(projectDir, CODE_GENERATION_STAGE, state);
}

function generationSourceUnavailableMessage(): string {
  return `Code Generation cannot start because the workspace source cannot be bound${workspaceSourceFailureSuffix()}. ` +
    "Repair the source boundary and retry generation; the earlier approval and plan-approval setting are unchanged. " +
    PLAN_APPROVAL_BREAK_GLASS_REMEDY;
}

/**
 * With the plan-approval check standing aside (Guard Policy relaxed or off),
 * or plan approval off for this plan, a project whose files cannot all be read
 * is built without a record of where the build started, instead of stopping:
 * that record only serves a comparison those settings do not make. The
 * approval stays the person's own.
 */
export function codeGenerationBuildsWithoutSource(
  projectDir: string,
  target: CodeGenerationTarget,
  planApprovalSkipped = false,
): boolean {
  if (planApprovalSkipped) return true;
  try {
    return codeGenerationPlanApprovalFence(projectDir, target).decision === "stand-aside";
  } catch {
    return false;
  }
}

export function buildWithoutSourceNotice(): string {
  return `Building without a check of the project's files: they could not all be read${workspaceSourceFailureSuffix()}.`;
}

// Re-baseline the `[Planned Source]` tag in a questions file to `fingerprint`.
// Used only before the challenge is minted: after that the prompt hash binds
// the file bytes and the receipt's certified source is the baseline instead.
function upsertPlannedSourceTag(questions: string, fingerprint: string): string {
  const eol = questions.includes("\r\n") ? "\r\n" : "\n";
  const raw = questions.split(/\r?\n/);
  const visible = visibleMarkdownLines(questions);
  for (let index = visible.length - 1; index >= 0; index--) {
    if (PLANNED_SOURCE_TAG_RE.test(visible[index])) {
      raw[index] = `[Planned Source]: ${fingerprint}`;
      return raw.join(eol);
    }
  }
  throw new Error("Plan Approval questions file has no [Planned Source]: tag to re-baseline");
}

interface ClassifiedPosture {
  methodology: TestingMethodology;
  ordering: string;
  components: TestingMethodology[];
}

const TESTING_HEADING = "## Testing Posture";
const TESTABLE_LAYERS = [
  "Data model / database behavior",
  "Repository / data access",
  "Business logic",
  "API / endpoint",
  "Frontend behavior",
];
const CONTRACT_HEADING = "## Testing Contract";
export const PLAN_APPROVAL_CHECKPOINT = "Code Generation Plan Approval";
const CONTRACT_MARKER_RE =
  /^[ \t]*AIDLC-TESTING-CONTRACT[ \t]*:[ \t]*(sha256:[0-9a-f]{64})[ \t]*$/;
const MARKDOWN_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const ANSWER_TAG_RE = /^\[Answer\]:[ \t]*(.*)$/;
// The recorded fingerprint tag. `sha256:v3:<hex>` is the current content-bound
// format (plan projection plus byte-exact instructions). The `sha256:v2:<hex>`
// shape (instructions projected like the plan) and the bare `sha256:<hex>` shape
// (issuance-bound) are still matched so a questions file written under either
// is READ and reported as "approve again" rather than looking like a line the
// parser does not understand.
const FINGERPRINT_TAG_RE =
  /^\[Approval Fingerprint\]:[ \t]*(sha256:(?:v[23]:)?[0-9a-f]{64})?[ \t]*$/;
// The workspace source the plan was written against, recorded by the fingerprint
// command so drift between planning and approval is caught with a remedy the
// conductor can always execute.
const PLANNED_SOURCE_TAG_RE =
  /^\[Planned Source\]:[ \t]*([0-9a-f]{40}|[0-9a-f]{64}|unbindable)?[ \t]*$/;
export const APPROVAL_FINGERPRINT_PREFIX = "sha256:v3:";

export function approvalFingerprintIsCurrentFormat(tag: string | null): boolean {
  return tag?.startsWith(APPROVAL_FINGERPRINT_PREFIX) === true;
}

/**
 * The `[Approval Fingerprint]` tag recorded in a questions file, in any format
 * this tool has ever written (bare, v2, v3), or null when the file carries no
 * well-formed tag. The one grammar every consumer of the tag reads through, so
 * a format bump never strands a reader that copied the regex.
 */
export function recordedApprovalFingerprint(questions: string): string | null {
  for (const line of questions.split(/\r?\n/)) {
    const match = FINGERPRINT_TAG_RE.exec(line);
    if (match) return match[1] ?? null;
  }
  return null;
}
// "Plan approval off" is the engine's own record for a plan built without
// asking. It grants nothing alone: every reader also needs the engine's receipt.
const APPROVE_PLAN_RE = /^(?:(?:[A-Z][.)][ \t]*)?["']?Approve Plan["']?|Plan approval off)$/i;
const QUESTION_PREFIX_RE =
  /^(?:(?:q(?:uestion)?[ \t]*)?\d+[ \t]*[:.)-][ \t]*)/i;
const NUMBERED_QUESTION_HEADING_RE =
  /^(?:q(?:uestion)?[ \t]*)?\d+[ \t]*[.:)-]?[ \t]*$/i;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf-8").digest("hex")}`;
}

function hashObject(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function normalizeMethodology(value: string): TestingMethodology | null {
  const normalized = value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .trim();
  if (/\b(custom|mixed)\b/.test(normalized)) return "custom";
  if (
    /\batdd\b|acceptance[- ]test[- ]driven|acceptance tests? (?:first|before)/.test(
      normalized,
    )
  ) {
    return "atdd";
  }
  if (
    /\bbdd\b|behaviou?r[- ]driven|(?:behaviou?r )?scenarios? (?:first|before)/.test(
      normalized,
    )
  ) {
    return "bdd";
  }
  if (
    /\btdd\b|test[- ]driven|(?:unit )?tests? (?:first|before implementation)/.test(
      normalized,
    )
  ) {
    return "tdd";
  }
  if (
    /\btest[- ]after\b|tests? after implementation|implementation[- ]first|classic/.test(
      normalized,
    )
  ) {
    return "test-after";
  }
  return null;
}

function structuredMethodology(value: string): TestingMethodology {
  const normalized = value
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .trim();
  if (
    normalized === "tdd" ||
    normalized === "bdd" ||
    normalized === "atdd" ||
    normalized === "test-after" ||
    normalized === "custom"
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid Testing Posture Methodology "${value}". Expected one of: tdd, bdd, atdd, test-after, custom.`,
  );
}

// A Methodology value that leads with one of the five and then explains it:
// "test-after (evidence and org default agree - ...)".
const METHODOLOGY_WITH_REASONS =
  /^[`*_]*(tdd|bdd|atdd|test-after|custom)[`*_]*(?=$|[\s(:;,])[\s:;,]*(.*)$/i;
// Reasons that name a second methodology describe a mix ("tdd for the domain,
// test-after for adapters"), which is `custom`, so they are never split.
const METHODOLOGY_NAME = /(?<![\w-])(tdd|bdd|atdd|test[- ]after|custom)(?![\w-])/gi;

// A practices draft's Testing Posture section made readable by the renderer
// before practices-promote writes it to team.md: the Methodology field must be
// one bare value. A value that leads with one and then gives its reasons
// becomes that value, and the reasons move to a `Methodology evidence` line,
// which the renderer does not read. `problem` says what to fix when the field
// cannot be read even so; nothing is rewritten then.
export function promotableTestingPosture(
  section: string,
): { section: string; problem: string | null } {
  const value = structuredField(classifiablePostureText(section), "Methodology");
  if (value === null) return { section, problem: null };
  try {
    structuredMethodology(value);
    return { section, problem: null };
  } catch {
    // Not one bare value: try to split off the reasons below.
  }
  const unreadable = {
    section,
    problem:
      `The Testing Posture Methodology "${value}" is not one of tdd, bdd, atdd, test-after, custom. ` +
      "Write the Methodology line as one of those values and nothing else (custom for a mix of them, " +
      'with the order in the Ordering line), and put the reasons in a separate "Methodology evidence" line.',
  };
  const lead = value.trim().match(METHODOLOGY_WITH_REASONS);
  const span = structuredFieldSpan(section, "Methodology");
  if (!lead || !span || span.value !== value) return unreadable;
  const named = lead[1].toLowerCase();
  for (const other of lead[2].matchAll(METHODOLOGY_NAME)) {
    if (other[1].toLowerCase().replace(" ", "-") !== named) return unreadable;
  }
  const lines = section.split(/\r?\n/);
  const head = lines[span.start].match(/^(.*?Methodology(?:\*\*)?[ \t]*:)/i);
  if (!head) return unreadable;
  let reasons = lead[2].trim();
  const wrapped = reasons.match(/^\((.*)\)\.?$/s);
  if (wrapped) reasons = wrapped[1].trim();
  const field = [`${head[1]} ${named}`];
  if (reasons) {
    field.push(`${head[1].replace(/Methodology/i, (word) => `${word} evidence`)} ${reasons}`);
  }
  lines.splice(span.start, span.end - span.start, ...field);
  const reduced = lines.join("\n");
  try {
    classifyPosture(reduced);
  } catch {
    return unreadable;
  }
  return { section: reduced, problem: null };
}

function defaultOrdering(methodology: TestingMethodology): string {
  switch (methodology) {
    case "tdd":
      return "For each testable layer: Red, then Green, then Refactor.";
    case "bdd":
      return "Define executable behavior scenarios before implementing each observable feature slice.";
    case "atdd":
      return "Write executable acceptance tests before implementing the complete feature across its required layers.";
    case "test-after":
      return "Implement each testable layer, then write and run that layer's tests.";
    case "custom":
      return "Preserve the explicitly affirmed custom ordering without converting it to another methodology.";
  }
}

type MarkdownFence = { marker: "`" | "~"; length: number };

function isEscaped(line: string, offset: number): boolean {
  let backslashes = 0;
  for (let index = offset - 1; index >= 0 && line[index] === "\\"; index--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function hasMatchingTickRun(
  line: string,
  from: number,
  ticks: number,
): boolean {
  for (let cursor = from; cursor < line.length; cursor++) {
    if (line[cursor] !== "`" || isEscaped(line, cursor)) continue;
    let end = cursor + 1;
    while (line[end] === "`") end++;
    if (end - cursor === ticks) return true;
    cursor = end - 1;
  }
  return false;
}

function stripHtmlCommentsFromLine(
  rawLine: string,
  state: { inComment: boolean; inlineCodeTicks: number },
): string {
  let line = "";
  let cursor = 0;
  while (cursor < rawLine.length) {
    if (state.inComment) {
      const end = rawLine.indexOf("-->", cursor);
      if (end < 0) break;
      state.inComment = false;
      cursor = end + 3;
      continue;
    }
    if (
      rawLine[cursor] === "`" &&
      (state.inlineCodeTicks > 0 || !isEscaped(rawLine, cursor))
    ) {
      let end = cursor + 1;
      while (rawLine[end] === "`") end++;
      const ticks = end - cursor;
      if (
        state.inlineCodeTicks === 0 &&
        hasMatchingTickRun(rawLine, end, ticks)
      ) {
        state.inlineCodeTicks = ticks;
      } else if (state.inlineCodeTicks === ticks) state.inlineCodeTicks = 0;
      line += rawLine.slice(cursor, end);
      cursor = end;
      continue;
    }
    if (
      state.inlineCodeTicks === 0 &&
      !isEscaped(rawLine, cursor) &&
      rawLine.startsWith("<!--", cursor)
    ) {
      state.inComment = true;
      cursor += 4;
      continue;
    }
    line += rawLine[cursor];
    cursor++;
  }
  return line;
}

function fenceOpening(line: string): MarkdownFence | null {
  const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (opening?.[1][0] === "`" && opening[2].includes("`")) return null;
  return opening
    ? {
        marker: opening[1][0] as "`" | "~",
        length: opening[1].length,
      }
    : null;
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(line);
  return Boolean(
    closing &&
      closing[1][0] === fence.marker &&
      Array.from(closing[1]).every((marker) => marker === fence.marker) &&
      closing[1].length >= fence.length,
  );
}

// Remove only rendered HTML comments. Fenced Markdown remains visible content,
// including literal <!-- tokens inside a fence.
function markdownWithoutHtmlComments(body: string): string {
  const lines = body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const state = { inComment: false, inlineCodeTicks: 0 };
  let fence: MarkdownFence | null = null;
  return lines
    .map((rawLine) => {
      if (fence) {
        if (closesFence(rawLine, fence)) fence = null;
        return rawLine;
      }
      const startedInComment = state.inComment;
      const line = stripHtmlCommentsFromLine(rawLine, state);
      const commentStart = rawLine.indexOf("<!--");
      const structuralPrefix =
        startedInComment || (line !== rawLine && commentStart < 0)
          ? ""
          : commentStart < 0
            ? rawLine
            : rawLine.slice(0, commentStart);
      const opening = fenceOpening(structuralPrefix);
      if (opening) {
        state.inComment = false;
        state.inlineCodeTicks = 0;
      }
      fence = opening;
      return opening ? rawLine : line;
    })
    .join("\n");
}

function structuralMarkdownLines(body: string): string[] {
  const rawLines = body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const visibleLines = markdownWithoutHtmlComments(body).split("\n");
  return visibleLines.map((line, index) => {
    const rawLine = rawLines[index];
    if (line === rawLine) return line;
    const opening = rawLine.indexOf("<!--");
    const closing = rawLine.indexOf("-->");
    return opening >= 0 && (closing < 0 || opening < closing)
      ? rawLine.slice(0, opening)
      : "";
  });
}

function visiblePostureText(section: string): string {
  return markdownWithoutHtmlComments(section).trim();
}

function classifiablePostureText(section: string): string {
  const lines = markdownWithoutHtmlComments(section).split("\n");
  const structuralLines = structuralMarkdownLines(section);
  let fence: MarkdownFence | null = null;
  return lines
    .map((line, index) => {
      const structuralLine = structuralLines[index];
      if (fence) {
        if (closesFence(structuralLine, fence)) fence = null;
        return "";
      }
      const opening = fenceOpening(structuralLine);
      if (opening) {
        fence = opening;
        return "";
      }
      return line;
    })
    .join("\n")
    .trim();
}

// Find the real Testing Posture section while ignoring headings hidden inside
// HTML comments or fenced examples. Return the original raw lines so comments
// and fences remain part of input_sha256 even though classification uses the
// visible projection above.
function extractTestingPostureSection(content: string): string {
  const rawLines = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const visibleLines = structuralMarkdownLines(content);
  let fence: MarkdownFence | null = null;
  let bodyStart = -1;
  let bodyEnd = rawLines.length;

  for (let index = 0; index < visibleLines.length; index++) {
    const line = visibleLines[index];
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opening = fenceOpening(line);
    if (opening) {
      fence = opening;
      continue;
    }
    if (bodyStart < 0) {
      if (line.trimEnd() === TESTING_HEADING) bodyStart = index + 1;
      continue;
    }
    if (/^## [^\n]*$/.test(line)) {
      bodyEnd = index;
      break;
    }
  }

  return bodyStart < 0 ? "" : rawLines.slice(bodyStart, bodyEnd).join("\n");
}

function classifyPosture(section: string): ClassifiedPosture | null {
  const body = classifiablePostureText(section);
  if (!body) return null;

  const structuredMethod = structuredField(body, "Methodology");
  const structuredOrdering = structuredField(body, "Ordering");
  const structured = structuredMethod
    ? structuredMethodology(structuredMethod)
    : null;
  const scan = `${structuredMethod ?? ""}\n${structuredOrdering ?? body}`.toLowerCase();
  const components = new Set<TestingMethodology>();
  for (const methodology of ["tdd", "bdd", "atdd", "test-after"] as const) {
    const detected = normalizeMethodology(
      methodology === "test-after"
        ? scan.match(
            /test[- ]after|tests? after implementation|implementation[- ]first|classic/,
          )?.[0] ?? ""
        : scan.match(
            methodology === "tdd"
              ? /\btdd\b|test[- ]driven/
              : methodology === "bdd"
                ? /\bbdd\b|behaviou?r[- ]driven/
                : /\batdd\b|acceptance[- ]test[- ]driven/,
          )?.[0] ?? "",
    );
    if (detected) components.add(detected);
  }

  const ordering = structuredOrdering ?? body;
  const mixedOrdering =
    (/\b(?:tests?|scenarios?)\b[^.\n]{0,80}\bfirst(?!-)\b/i.test(ordering) ||
      /\b(?:tests?|scenarios?)\b[^.\n]{0,80}\bbefore\b[^.\n]{0,40}\bimplement(?:ation|ing)?\b/i.test(
        ordering,
      )) &&
    (/\btests?\b[^.\n]{0,80}\bafter\b[^.\n]{0,40}\bimplement(?:ation|ing)?\b/i.test(
      ordering,
    ) ||
      /\brefactor(?:ing)?\b[^.\n]{0,80}\bafter\b[^.\n]{0,40}\bgreen\b/i.test(
        ordering,
      ) ||
      /\btests?\b[^.\n]{0,80}\bfollow\b[^.\n]{0,40}\bimplement(?:ation|ing)?\b/i.test(
        ordering,
      ));
  const customSignal =
    /\b(?:custom|mixed)[ -](?:ordering|cadence|posture|methodology)\b|\b(?:ordering|cadence|posture|methodology)[ -](?:custom|mixed)\b/i.test(
      body,
    );
  if (
    structured === null &&
    components.size > 1 &&
    !customSignal &&
    !mixedOrdering
  ) {
    return null;
  }
  const methodology =
    structured ??
    (customSignal || mixedOrdering
      ? "custom"
      : Array.from(components)[0] ?? null);
  if (methodology === null) return null;

  if (methodology !== "custom") components.add(methodology);
  return {
    methodology,
    ordering:
      structuredOrdering ??
      (methodology === "custom" ? body.replace(/\s+/g, " ").trim() : defaultOrdering(methodology)),
    components: Array.from(components),
  };
}

function compatibleSpecialization(
  broader: ClassifiedPosture,
  narrower: ClassifiedPosture,
): boolean {
  if (broader.methodology === narrower.methodology) return true;
  return (
    narrower.methodology === "custom" &&
    narrower.components.includes(broader.methodology)
  );
}

function normalizeStrategy(value: string): TestStrategy {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "minimal" ||
    normalized === "standard" ||
    normalized === "comprehensive"
  ) {
    return normalized;
  }
  return "standard";
}

function normalizeProjectType(value: string): ProjectType {
  return value.trim().toLowerCase() === "brownfield"
    ? "brownfield"
    : "greenfield";
}

export function combineTestObligations(
  scope: string,
  strategy: TestStrategy,
): TestObligations {
  const strategyVolume: Record<TestStrategy, string[]> = {
    minimal: [
      "One verifiable test per requirement at the narrowest effective level.",
      "At least one happy-path unit test per component.",
      "Unit tests are the default; a bugfix/security scope floor may require an integration or E2E regression when that is the narrowest level that reproduces the defect.",
    ],
    standard: [
      "Five to eight tests per component.",
      "Unit tests plus integration tests for key boundaries.",
      "Add E2E, performance, or security tests when requirements demand them.",
    ],
    comprehensive: [
      "Ten to fifteen tests per component.",
      "Unit, integration, and E2E tests.",
      "Add performance and security tests when NFRs demand them.",
    ],
  };
  const normalizedScope = scope.trim().toLowerCase();
  let scopeFloor: string[];
  if (["mvp", "enterprise", "feature", "infra"].includes(normalizedScope)) {
    scopeFloor = [
      "Meet an 80% line-coverage floor.",
      "Run the selected tests in CI before merge.",
    ];
  } else if (["bugfix", "security-patch"].includes(normalizedScope)) {
    scopeFloor = [
      "Include a targeted regression for the bug or vulnerability.",
      "Keep the existing test suite green.",
    ];
  } else {
    scopeFloor = [
      "Keep the existing test suite green.",
      "This scope adds no extra new-test floor beyond the selected test strategy.",
    ];
  }
  return {
    strategy,
    strategy_volume: strategyVolume[strategy],
    scope_floor: scopeFloor,
    combination_rule:
      "Apply every selected-strategy obligation and every scope-floor obligation; neither replaces the other, and a targeted scope regression may add the narrowest necessary test type beyond the strategy default.",
  };
}

export function buildPlanProfile(
  methodology: TestingMethodology,
  ordering: string,
  projectType: ProjectType,
): PlanProfile {
  const runnerStep =
    projectType === "greenfield"
      ? "Bootstrap the minimal test runner/configuration and record the exact unit-scoped command."
      : "Verify the existing test runner/configuration and record the exact unit-scoped command.";
  const steps = [
    "Project structure and production configuration skeleton.",
    runnerStep,
  ];

  if (methodology === "tdd") {
    for (const layer of TESTABLE_LAYERS) {
      steps.push(
        `${layer} - Red: write the failing tests and record the failing command output.`,
        `${layer} - Green: implement only enough behavior to pass.`,
        `${layer} - Refactor: improve the implementation while tests stay green.`,
      );
    }
  } else if (methodology === "bdd") {
    steps.push(
      "Behavior scenarios - define executable examples for the observable feature slice before implementation.",
      "Feature slice - implement the required data, repository, business, API, and frontend layers.",
      "Behavior scenarios - run the scenarios until they pass.",
      "Feature slice - refactor while the scenarios stay green.",
    );
  } else if (methodology === "atdd") {
    steps.push(
      "Acceptance Red - write executable acceptance tests for the complete feature before implementation.",
      "Feature implementation - implement the required layers against the acceptance contract.",
      "Acceptance Green - run the acceptance tests until they pass.",
      "Feature Refactor - improve the cross-layer implementation while acceptance stays green.",
    );
  } else if (methodology === "custom") {
    steps.push(
      `Custom ordering - ${ordering}`,
      "Implementation and tests - preserve that exact ordering; do not convert it to layer-local TDD.",
    );
  } else {
    for (const layer of TESTABLE_LAYERS) {
      steps.push(
        `${layer} - implement.`,
        `${layer} - write and run its tests after implementation.`,
      );
    }
  }

  steps.push(
    "Environment/build configuration.",
    "Documentation and traceability.",
  );
  return {
    methodology,
    runner_step: runnerStep,
    runner_ready_before_first_test: true,
    testable_layers: TESTABLE_LAYERS.slice(),
    steps,
  };
}

export function resolveTestingPostureFromSections(
  sections: TestingPostureSections,
  options: {
    scope: string;
    testStrategy: TestStrategy;
    projectType: ProjectType;
  },
): TestingPostureContract {
  const classified = {
    org: classifyPosture(sections.org ?? ""),
    team: classifyPosture(sections.team ?? ""),
    project: classifyPosture(sections.project ?? ""),
  };

  if (
    classified.team &&
    classified.project &&
    !compatibleSpecialization(classified.team, classified.project)
  ) {
    throw new Error(
      `Testing Posture conflict: project methodology "${classified.project.methodology}" ` +
        `contradicts team methodology "${classified.team.methodology}". Revise the narrower rule; ` +
        "strict-additive memory does not permit runtime override.",
    );
  }

  const selected =
    classified.project
      ? { layer: "project" as const, value: classified.project }
      : classified.team
        ? { layer: "team" as const, value: classified.team }
        : classified.org
          ? { layer: "org" as const, value: classified.org }
          : {
              layer: "fallback" as const,
              value: {
                methodology: "test-after" as const,
                ordering: defaultOrdering("test-after"),
                components: ["test-after" as const],
              },
            };
  const applicableNotes = (["org", "team", "project"] as const)
    .map((layer) => ({
      layer,
      text: visiblePostureText(sections[layer] ?? ""),
    }))
    .filter((entry) => entry.text.length > 0);
  const input = {
    sections: {
      org: sections.org ?? "",
      team: sections.team ?? "",
      project: sections.project ?? "",
    },
    scope: options.scope,
    test_strategy: options.testStrategy,
    project_type: options.projectType,
  };
  const body: TestingPostureContractBody = {
    version: 1,
    methodology: selected.value.methodology,
    source: selected.layer,
    ordering: selected.value.ordering,
    scope: options.scope,
    test_strategy: options.testStrategy,
    project_type: options.projectType,
    applicable_notes: applicableNotes,
    obligations: combineTestObligations(options.scope, options.testStrategy),
    plan_profile: buildPlanProfile(
      selected.value.methodology,
      selected.value.ordering,
      options.projectType,
    ),
    input_sha256: hashObject(input),
  };
  return { ...body, contract_sha256: hashObject(body) };
}

export function resolveTestingPosture(
  projectDir: string,
): TestingPostureContract {
  const space = resolveWorkflowSelection(projectDir).space;
  const memoryDir = join(projectDir, "aidlc", "spaces", space, "memory");
  const sections: TestingPostureSections = {};
  for (const layer of ["org", "team", "project"] as const) {
    const file = join(memoryDir, `${layer}.md`);
    if (!existsSync(file)) continue;
    sections[layer] = extractTestingPostureSection(readFileSync(file, "utf-8"));
  }
  let state = "";
  try {
    state = readFileSync(stateFilePath(projectDir), "utf-8");
  } catch {
    // Pre-creation and focused tests use deterministic defaults.
  }
  return resolveTestingPostureFromSections(sections, {
    scope: (getField(state, "Scope") ?? "feature").trim().toLowerCase(),
    testStrategy: normalizeStrategy(getField(state, "Test Strategy") ?? "standard"),
    projectType: normalizeProjectType(getField(state, "Project Type") ?? "greenfield"),
  });
}

export function renderTestingContract(contract: TestingPostureContract): string {
  return `${CONTRACT_HEADING}\n\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\`\n`;
}

function rawMarkdownSection(content: string, heading: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const body: string[] = [];
  let found = false;
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (found) body.push(line);
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.trimEnd() === heading) {
      found = true;
      continue;
    }
    if (found && !inFence && /^## [^\n]*$/.test(line)) break;
    if (found) body.push(line);
  }
  return found ? body.join("\n") : "";
}

export type TestingContractDefect = "missing" | "invalid-json" | "mismatch";

/**
 * The embedded contract, or which of the three failures stopped it. Each needs
 * a different repair, so a refusal names the one that applies instead of one
 * "no valid block" for all of them.
 */
export function readTestingContract(
  plan: string,
): { contract: TestingPostureContract } | { defect: TestingContractDefect; detail?: string } {
  const section = rawMarkdownSection(plan, CONTRACT_HEADING);
  const match = section.match(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/i);
  if (!match) return { defect: "missing" };
  let parsed: TestingPostureContract;
  try {
    parsed = JSON.parse(match[1]) as TestingPostureContract;
  } catch (error) {
    return { defect: "invalid-json", detail: errorMessage(error) };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    parsed.version !== 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(parsed.contract_sha256 ?? "")
  ) {
    return { defect: "mismatch" };
  }
  const { contract_sha256: recorded, ...body } = parsed;
  return hashObject(body) === recorded ? { contract: parsed } : { defect: "mismatch" };
}

export function parseTestingContract(plan: string): TestingPostureContract | null {
  const read = readTestingContract(plan);
  return "contract" in read ? read.contract : null;
}

/**
 * The repair for a contract readTestingContract refused. The block is engine
 * output: re-rendering is the only fix, and a mismatch usually means the file
 * was rewritten after rendering, so the message says how to avoid that too.
 */
export function testingContractDefectMessage(
  defect: TestingContractDefect,
  then = "re-run the fingerprint command",
): string {
  const render = `\`${aidlcToolInvocation("testing-posture")} render\``;
  const heading = `\`${CONTRACT_HEADING}\``;
  const replace =
    `Run ${render}, replace the whole ${heading} section with its output, then ${then}. ` +
    "Edit AIDLC artifacts with your file-editing tool, not a shell command that rewrites the file " +
    "(for example PowerShell Set-Content or Out-File), which can re-encode its characters.";
  switch (defect) {
    case "missing":
      return `code-generation-plan.md has no \`\`\`json block under a ${heading} heading. ` +
        `Run ${render}, paste its complete output into the plan unchanged, then ${then}.`;
    case "invalid-json":
      // The parser's own message can quote the plan's text, so it stays out:
      // the repair is the same whatever the parser saw.
      return `the ${heading} block in code-generation-plan.md is not valid JSON. ${replace}`;
    case "mismatch":
      return `the ${heading} block in code-generation-plan.md changed after it was rendered, ` +
        "so its contract_sha256 no longer matches its content. Do not edit the contract or recompute the hash by hand. " +
        replace;
  }
}

// The embedded contract's problem in words, or null when it reads cleanly.
function testingContractDefectReason(plan: string): string | null {
  const read = readTestingContract(plan);
  return "defect" in read ? testingContractDefectMessage(read.defect) : null;
}

/** Hash validity alone does not make a contract executable. */
export function usableTestingContract(contract: TestingPostureContract | null): boolean {
  if (!contract) return false;
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");
  const nonblank = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const profile = contract.plan_profile;
  const obligations = contract.obligations;
  return ["tdd", "bdd", "atdd", "test-after", "custom"].includes(contract.methodology) &&
    ["org", "team", "project", "fallback"].includes(contract.source) &&
    nonblank(contract.ordering) && nonblank(contract.scope) &&
    ["minimal", "standard", "comprehensive"].includes(contract.test_strategy) &&
    ["greenfield", "brownfield"].includes(contract.project_type) &&
    /^sha256:[0-9a-f]{64}$/.test(contract.input_sha256 ?? "") &&
    Array.isArray(contract.applicable_notes) &&
    contract.applicable_notes.every((note) => typeof note === "object" && note !== null &&
      ["org", "team", "project"].includes(note.layer) && typeof note.text === "string") &&
    obligations !== undefined && obligations !== null &&
    obligations.strategy === contract.test_strategy &&
    strings(obligations.strategy_volume) && obligations.strategy_volume.length > 0 &&
    obligations.strategy_volume.every(nonblank) &&
    strings(obligations.scope_floor) && obligations.scope_floor.length > 0 &&
    obligations.scope_floor.every(nonblank) &&
    nonblank(obligations.combination_rule) &&
    profile !== undefined && profile !== null && profile.methodology === contract.methodology &&
    profile.runner_ready_before_first_test === true && nonblank(profile.runner_step) &&
    strings(profile.testable_layers) && profile.testable_layers.length > 0 && profile.testable_layers.every(nonblank) &&
    strings(profile.steps) && profile.steps.length > 0 && profile.steps.every(nonblank);
}

// --- The Plan Approval content projection -------------------------------------
//
// The approval must survive the edit the stage itself ORDERS after approval, and
// must not survive an edit to the plan. Byte-exact hashing cannot do both: Step 4
// tells the developer agent to tick the plan's checkboxes as it works, so hashing
// raw bytes invalidated every approval as soon as the approved work started.
//
// So the fingerprint is taken over a projection that erases exactly these
// mutations and nothing else:
//
//   1. A TERMINAL `## Review` appendix is removed, using the engine's own
//      appendix locator (a `## Review` inside a fence or an HTML comment, a
//      lower-case or unspaced variant, and a mid-plan section are all NOT an
//      appendix and stay material). This is a legacy-compatibility step: the
//      reviewer used to append its verdict to the plan because the plan is the
//      stage's review artifact. Reviews live in review records now and nothing
//      appends to the plan, but a plan reviewed under the earlier protocol may
//      still carry that section, and its approval must not depend on it.
//   2. List task markers are reset: `[x]`, `[X]` and `[-]` become `[ ]`, outside
//      fenced blocks and HTML comments. A tick is a claim about execution, not a
//      change to the plan.
//   3. Line endings become LF, trailing whitespace per line is dropped OUTSIDE
//      fences, runs of blank lines outside fences and comments collapse to one, and
//      trailing blank lines are dropped. These are editor artifacts, not content.
//      Inside a fence every byte is kept, because there a whitespace-only line can
//      be the difference between two patches.
//
// Everything else is byte-exact, INCLUDING the fenced `## Testing Contract` JSON
// and any text inside code fences. Reordering, rewording, adding or deleting a
// step, changing a number, a path, or the contract hash all change the
// projection.
//
// The one thing the projection cannot see is an edit made INSIDE a terminal
// review appendix. That is closed elsewhere: the worker brief carries the plan
// BODY (this projection's input), produced by the `brief` command and checked by
// the dispatch guard, so a step smuggled into the appendix is never delivered as
// work.
//
// This projection is for the PLAN only. The unit-test instructions are not a
// review artifact and have no mandated post-approval mutation, so they bind
// byte-exactly (line endings aside): see `projectInstructionsContent`.
const PLAN_TASK_MARKER_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[xX-]\](?=[ \t]|$)/;

export function projectPlanApprovalContent(text: string): string {
  const retained = contentBeforeTerminalReviewAppendix(text.replace(/^\uFEFF/, ""));
  const projected: string[] = [];
  let fence: MarkdownFence | null = null;
  let inComment = false;
  let previousBlank = false;
  for (const rawLine of retained.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/[ \t]+$/, "");
    if (fence) {
      // Verbatim inside a fence: a whitespace-only line in a diff or a Python block
      // is content, not an editor artifact, and two fences differing only there
      // apply different patches.
      projected.push(rawLine);
      previousBlank = false;
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (inComment) {
      projected.push(line);
      previousBlank = false;
      if (line.includes("-->")) inComment = false;
      continue;
    }
    const opening = fenceOpening(line);
    if (opening) {
      fence = opening;
      projected.push(line);
      previousBlank = false;
      continue;
    }
    if (/^ {0,3}<!--/.test(line) && !line.includes("-->")) {
      inComment = true;
      projected.push(line);
      previousBlank = false;
      continue;
    }
    const blank = line.length === 0;
    if (blank && previousBlank) continue;
    previousBlank = blank;
    projected.push(line.replace(PLAN_TASK_MARKER_RE, "$1[ ]"));
  }
  while (projected.length > 0 && projected[projected.length - 1] === "") {
    projected.pop();
  }
  return projected.join("\n");
}

// The unit-test instructions as the fingerprint binds them and as the worker
// brief hands them over: every byte, with only the line endings normalized. No
// review strip, no task-marker reset, no whitespace folding, not even a BOM
// dropped: a change retires the content binding. A lowered plan-approval fence
// can permit execution of the changed content without claiming it was approved.
export function projectInstructionsContent(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// The value recorded as `[Approval Fingerprint]:`. It binds CONTENT (the
// projected plan, the byte-exact unit-test instructions, and the Testing Contract
// hash) to PLACE (target, intent) and to ATTEMPT (the run floor). The tag carries
// a format version so a value recorded under a previous scheme (issuance-bound,
// or instructions projected like the plan) is recognised and answered with
// "approve again" instead of an unexplained mismatch.
export function approvalFingerprint(
  plan: string,
  instructions: string,
  contractHash: string,
  authority: Pick<CodeGenerationAuthority, "targetId" | "intentId" | "runFloor">,
): string {
  const digest = hashObject({
    plan: projectPlanApprovalContent(plan),
    instructions: projectInstructionsContent(instructions),
    testing_contract: contractHash,
    target: authority.targetId,
    intent: authority.intentId,
    run_floor: authority.runFloor,
  });
  return `${APPROVAL_FINGERPRINT_PREFIX}${digest.slice("sha256:".length)}`;
}

// --- The worker brief ------------------------------------------------------------
//
// What a code-generation worker is handed is the plan as the approval projection sees it (a terminal
// `## Review` appendix removed, task markers reset to `[ ]`, spacing
// normalized) and the unit-test instructions exactly as they were hashed. No
// changed byte reaches the worker with an "approved" label. A lowered fence
// permits the current content, labelled as current and recorded as a stand-aside.
// The brief is produced here, so no conductor reads the plan
// file into a prompt itself. The worker's own progress marks live in the plan
// file it ticks as it works, not in the approved plan the brief carries; a
// build picked up after an interruption gets them in a separate progress
// section (see "Picking up an interrupted build" below).

export interface WorkerBrief {
  unit: string | null;
  contractHash: string;
  /** The exact text to hand the worker: marker lines, projected plan, instructions. */
  brief: string;
  /** True when the plan carried a terminal review appendix, which the brief omits. */
  appendixStripped: boolean;
  /** A lowered fence permitted current content without a new human approval. */
  changeNotices?: string[];
}

/** The terminal `## Review` appendix of a plan, or "" when it carries none. */
export function planReviewAppendix(plan: string): string {
  const body = contentBeforeTerminalReviewAppendix(plan);
  return plan.slice(body.length);
}

export function workerBrief(
  projectDir: string,
  target: CodeGenerationTarget,
): WorkerBrief {
  refuseWhileRulesArrive(projectDir);
  const approval = evaluateCodeGenerationApproval(projectDir, target);
  const continuation = approval.ok ? null : codeGenerationContinuation(projectDir, target);
  if ((!approval.ok && !continuation) ||
    (!continuation && (approval.contractHash === null || approval.approvalFingerprint === null))) {
    throw new Error(
      `Cannot assemble a worker brief for ${
        target.unit ? `unit "${target.unit}"` : "the stage-level target"
      }: ${approval.reason || "Plan Approval is not current"}`,
    );
  }
  // Read the two files once, then prove THESE bytes are the approved ones by
  // recomputing the fingerprint over them and matching the validated tag. A
  // file that changed between the evaluation and this read cannot pass, so the
  // brief is never assembled from bytes the approval did not cover.
  const stageDir = codeGenerationRecordDir(projectDir, target.unit);
  const plan = continuation?.artifacts.plan ?? readFileSync(join(stageDir, "code-generation-plan.md"), "utf-8");
  const instructions = continuation?.artifacts.instructions ??
    readFileSync(join(stageDir, "unit-test-instructions.md"), "utf-8");
  const authority = continuation?.authority ?? resolveCodeGenerationAuthority(projectDir, target);
  const contractHash = continuation?.artifacts.contractHash ?? approval.contractHash!;
  const snapshotFingerprint = approvalFingerprint(
    plan,
    instructions,
    contractHash,
    authority,
  );
  if (!continuation && snapshotFingerprint !== approval.approvalFingerprint) {
    throw new Error(
      "Cannot assemble a worker brief: the plan or instructions changed while the brief " +
        "was being assembled. Re-run the fingerprint command, re-present the plan, and approve again.",
    );
  }
  const projectedPlan = projectPlanApprovalContent(plan);
  const marker = target.unit
    ? `AIDLC-UNIT: ${target.unit}`
    : "AIDLC-STAGE: code-generation";
  const resume = codeGenerationResume(projectDir, target, { plan, content: snapshotFingerprint });
  // The worker's ticks are what a pick-up reads, so it is told where the plan
  // file is and that ticking is its one change to it.
  const planFile = toPosix(relative(projectDir, join(stageDir, "code-generation-plan.md")));
  const brief =
    `${marker}\n` +
    `AIDLC-TESTING-CONTRACT: ${contractHash}\n` +
    (resume ? progressSection(resume) : "") +
    `\n## Files and commands\n\n${FILE_TOOLS_RULE}\n` +
    `\n## The plan file\n\nTick each step's box in \`${planFile}\` as you finish the step. ` +
    "That is the only change you make to that file.\n" +
    (continuation ? "\n## Current plan (plan-approval fence off)\n\n" : "\n## Approved plan\n\n") +
    `${projectedPlan}\n` +
    (continuation ? "\n## Current unit-test instructions\n\n" : "\n## Approved unit-test instructions\n\n") +
    projectInstructionsContent(instructions);
  return {
    unit: approval.unit,
    contractHash,
    brief,
    appendixStripped: planReviewAppendix(plan.replace(/^\uFEFF/, "")).length > 0,
    ...(continuation ? {
      changeNotices: recordCodeGenerationContinuation(projectDir, continuation, "brief"),
    } : {}),
  };
}

// --- An approved plan that changed before the build ---------------------------------
//
// The files the person approved are kept beside the approval (writeApprovedPlanCopy).
// When the plan or its test instructions on disk no longer match them and the
// build has not started, the person hears one line naming what changed and how
// to go back; `restore` writes the approved files back, so the approval matches
// again. Ticks are not a change: the comparison is over the approval content.

/** Keep the approved files for this target and attempt; only bytes that hash to the approval are kept. */
export function keepApprovedPlanCopy(
  projectDir: string,
  authority: CodeGenerationAuthority,
  fingerprint: string,
  questions: string,
): void {
  // The copy only serves the change line and the way back: a copy that cannot
  // be kept never stands between the person and their approval.
  try {
    const plan = readFileSync(join(authority.stageDir, "code-generation-plan.md"), "utf-8");
    const instructions = readFileSync(join(authority.stageDir, "unit-test-instructions.md"), "utf-8");
    const read = readTestingContract(plan);
    if (!("contract" in read)) return;
    if (approvalFingerprint(plan, instructions, read.contract.contract_sha256, authority) !== fingerprint) return;
    writeApprovedPlanCopy(projectDir, authority, { version: 1, fingerprint, plan, instructions, questions });
  } catch {
    // Nothing to name later; the approval stands.
  }
}

const APPROVED_PLAN_UNDO_WORDS = "go back to the approved plan";
const APPROVED_PLAN_UNDO = `Say "${APPROVED_PLAN_UNDO_WORDS}" to undo.`;

/**
 * True when the text is the words the change line gives the person, and
 * nothing more: case, spacing, quotes around them, "please" before or after,
 * and a closing "." or "!" do not matter.
 */
export function isApprovedPlanUndoRequest(text: string): boolean {
  const words = text.toLowerCase().replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "").replace(/[.!]+$/, "")
    .replace(/^["']|["']$/g, "").trim();
  return words.replace(/^please,? /, "").replace(/,? please$/, "") === APPROVED_PLAN_UNDO_WORDS;
}

function quotedStep(text: string): string {
  return `"${text.length > 80 ? `${text.slice(0, 77).trimEnd()}...` : text}"`;
}

/** What changed between the approved plan's steps and the plan's steps now, in the person's words. */
function changedSteps(before: string[], after: string[]): string {
  const at = Array.from({ length: Math.max(before.length, after.length) }, (_, index) => index)
    .find((index) => before[index] !== after[index]);
  if (at === undefined) return "the plan's text changed";
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((text, index) => text === b[index]);
  if (after.length === before.length + 1 && same(after.slice(at + 1), before.slice(at))) {
    return `step ${at + 1} ${quotedStep(after[at])} was added`;
  }
  if (before.length === after.length + 1 && same(before.slice(at + 1), after.slice(at))) {
    return `step ${at + 1} ${quotedStep(before[at])} was removed`;
  }
  const what = at < after.length && at < before.length
    ? `step ${at + 1} now says ${quotedStep(after[at])} instead of ${quotedStep(before[at])}`
    : at < after.length
      ? `step ${at + 1} ${quotedStep(after[at])} was added`
      : `step ${at + 1} ${quotedStep(before[at])} was removed`;
  const others = Array.from({ length: Math.max(before.length, after.length) }, (_, index) => index)
    .filter((index) => index > at && before[index] !== after[index]).length;
  return others > 0 ? `${what}, and ${others} more ${others === 1 ? "step" : "steps"} changed` : what;
}

export function approvedPlanChangeText(copy: ApprovedPlanCopy, plan: string, instructions: string): string | null {
  const planChanged = projectPlanApprovalContent(plan) !== projectPlanApprovalContent(copy.plan);
  const lf = (text: string) => text.replace(/\r\n/g, "\n");
  const instructionsChanged = lf(instructions) !== lf(copy.instructions);
  if (!planChanged && !instructionsChanged) return null;
  if (!planChanged) return `Your approved test instructions changed before the build. ${APPROVED_PLAN_UNDO}`;
  const what = changedSteps(planSteps(copy.plan).map((step) => step.text), planSteps(plan).map((step) => step.text));
  return `Your approved plan changed before the build: ${what}${instructionsChanged ? ", and the test instructions changed too" : ""}. ` +
    APPROVED_PLAN_UNDO;
}

/** The approved files for this target and attempt, when the person approved them and the build has not started. */
function unbuiltApprovedCopy(
  projectDir: string,
  authority: CodeGenerationAuthority,
): ApprovedPlanCopy | null {
  const copy = readApprovedPlanCopy(projectDir, authority);
  if (copy === null) return null;
  const receipt = readPlanApprovalReceipt(projectDir, {
    targetId: authority.targetId, runFloor: authority.runFloor, fingerprint: copy.fingerprint,
  });
  return receipt?.choice === "Approve Plan" && receipt.status === "approved" ? copy : null;
}

/**
 * The one line the person hears when the plan they approved changed before the
 * build, or null when it did not (or nothing was approved in this attempt).
 */
export function approvedPlanChangeLine(
  projectDir: string,
  target: CodeGenerationTarget,
  issued?: CodeGenerationIssuance,
): string | null {
  try {
    const authority = resolveCodeGenerationAuthority(projectDir, target, issued);
    const copy = unbuiltApprovedCopy(projectDir, authority);
    if (copy === null) return null;
    return approvedPlanChangeText(
      copy,
      readFileSync(join(authority.stageDir, "code-generation-plan.md"), "utf-8"),
      readFileSync(join(authority.stageDir, "unit-test-instructions.md"), "utf-8"),
    );
  } catch {
    return null;
  }
}

/** Write the approved plan, test instructions and answer back: the person said to go back to the plan they approved. */
export function restoreApprovedPlan(projectDir: string, target: CodeGenerationTarget): string {
  const authority = resolveCodeGenerationAuthority(projectDir, target);
  const copy = readApprovedPlanCopy(projectDir, authority);
  const receipt = copy === null ? null : readPlanApprovalReceipt(projectDir, {
    targetId: authority.targetId, runFloor: authority.runFloor, fingerprint: copy.fingerprint,
  });
  if (copy === null || receipt?.choice !== "Approve Plan") {
    throw new Error(
      `There is no approved plan to go back to for ${authority.unit === null ? "this code" : authority.unit}. ` +
        "Show the person the plan as it is now.",
    );
  }
  withActiveDirectiveLock(projectDir, () => {
    for (const [name, content] of [
      ["code-generation-plan.md", copy.plan],
      ["unit-test-instructions.md", copy.instructions],
      ["code-generation-questions.md", copy.questions],
    ] as const) {
      writeRecordFileNoFollow(projectDir, relative(projectDir, join(authority.stageDir, name)), content);
    }
  });
  return "Back to the plan you approved.";
}

// --- Picking up an interrupted build ----------------------------------------------
//
// The worker ticks the plan file as it finishes each step, but the brief hands
// it the approved plan, where every step reads unticked. So a build cut off part
// way (a provider error, the editor closed, a crash before the report) was run
// again from step 1 by the next worker. When the brief is for a build that
// already started on the plan as it is now, the plan file's ticks are that
// build's progress, and the brief says so: which steps are ticked,
// which files they name are not in the project, and the step to continue at.
// Whether a named file that is not there means the step must be redone is the
// worker's call: a step can name a file it says not to add. The person hears
// one line saying only what is certain: what is done and where it picks up.
//
// A worker that built steps without ticking them leaves no ticks. Then the
// files the steps name are the record: the furthest step whose named files all
// changed since the build started is where the build got to.
//
// "Started on the plan as it is now" is the receipt the questions file names,
// at status `generation`, when the plan and instructions on disk are the
// content the build started on. Its key binds the target, the stage attempt
// (the run floor, which a Redo or a rejected gate moves) and the fingerprint of
// the approved content, and every new approval writes a fresh receipt at status
// `approved`. The content a build starts on is the approved content, or, when a
// lowered fence builds a plan edited after its approval, the edited content,
// which generation start keeps on the receipt (`startedFingerprint`). So a new
// attempt, a re-approval, and a plan edited after the build started all start
// the steps fresh, and a build started on an edited plan picks up like any
// other. And when a build starts fresh (generation
// start moves a receipt from `approved` to `generation`), the engine clears the
// plan file's ticks, so ticks left from before a Redo, a rejected gate, or a
// re-approval never count as this build's progress. A resume finds the receipt
// already at `generation` and clears nothing. A swarm keeps its own
// continuation rule: its batches run under an invoke-swarm directive and its
// worktrees hold delegated receipts, and neither is read or cleared here.
//
// This is a hint for the worker and a line for the person, never evidence: no
// gate, review, or receipt reads it, and ticks stay outside the fingerprint.
//
// The engine checks only the files a step names in code spans that read as
// paths (`src/auth/login.ts`, `src/generated/`, `package.json`). An identifier,
// a command, a route, or a glob is not a file it can check, so the brief also
// asks the worker to check the files of every ticked step it skips.

export interface PlanStep {
  /** The step's own line, without its list marker and task box. */
  text: string;
  ticked: boolean;
  /** Paths the step (its line and the lines indented under it) names in code spans. */
  paths: string[];
  /** The "Step N" heading the step sits under, when the plan groups its steps under such headings. */
  heading?: string;
}

export interface CodeGenerationResume {
  steps: PlanStep[];
  /** 1-based numbers of the steps done: ticked, or (with none ticked) whose named files were written. */
  ticked: number[];
  /** How the done steps are known: the plan file's ticks, or the files the steps name. */
  from: "ticks" | "files";
  /** Done steps naming files that are not in the project: a fact for the worker to judge. */
  missing: Array<{ step: number; paths: string[] }>;
  /** The first step not done, or null when every step is done. */
  next: number | null;
}

const PLAN_TASK_LINE_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX-])\](?=[ \t]|$)/;
const PLAN_HEADING_RE = /^ {0,3}#{1,6}[ \t]+(.*)$/;
const PLAN_STEP_HEADING_RE = /^[*_]{0,2}step[ \t]+(\d+)\b/i;
// A bare file name the engine treats as a path: a common source or configuration
// extension. With a directory in it, any extension (or a trailing slash) will do.
const NAMED_FILE_RE =
  /^[\w.-]+\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|py|java|kts?|go|rs|rb|cs|php|swift|sql|sh|ps1|html|css|scss|vue|svelte|tf|xml|gradle|lock)$/i;

function namedPaths(text: string): string[] {
  const paths: string[] = [];
  for (const [, span] of text.matchAll(/`([^`\n]+)`/g)) {
    const path = span.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!/^[\w.@/-]+$/.test(path) || path.startsWith("/") || path.split("/").includes("..")) continue;
    const named = path.includes("/")
      ? path.endsWith("/") || /\.[A-Za-z]\w*$/.test(path.slice(path.lastIndexOf("/") + 1))
      : NAMED_FILE_RE.test(path);
    if (named) paths.push(path);
  }
  return paths;
}

/**
 * The plan's steps in order: each task line outside fences and comments that is
 * not indented under another step. A nested task, and any other line indented
 * under a step, belongs to that step.
 */
export function planSteps(plan: string): PlanStep[] {
  const body = contentBeforeTerminalReviewAppendix(plan.replace(/^\uFEFF/, ""));
  const steps: PlanStep[] = [];
  let open = -1;
  let heading: string | undefined;
  for (const line of visibleMarkdownLines(body, { preserveIndentedCode: true })) {
    if (line.trim().length === 0) continue;
    const indent = (/^[ \t]*/.exec(line)?.[0] ?? "").replace(/\t/g, "    ").length;
    if (open >= 0 && indent > open) {
      steps[steps.length - 1].paths.push(...namedPaths(line));
      continue;
    }
    const title = PLAN_HEADING_RE.exec(line);
    if (title) {
      // A "## Step 3: Tests" heading groups the tasks under it; any other
      // heading ends the group.
      const number = PLAN_STEP_HEADING_RE.exec(title[1])?.[1];
      heading = number === undefined ? undefined : `Step ${number}`;
      open = -1;
      continue;
    }
    const task = PLAN_TASK_LINE_RE.exec(line);
    open = task ? indent : -1;
    if (!task) continue;
    const text = line.slice(task[0].length).trim();
    steps.push({
      text,
      ticked: task[1] === "x" || task[1] === "X",
      paths: namedPaths(text),
      ...(heading !== undefined ? { heading } : {}),
    });
  }
  return steps;
}

/**
 * The "Step N" headings of a plan whose every task sits under one and that
 * has fewer headings than tasks, in order; null otherwise. The person reads
 * those headings as the plan's steps, so the lines name tasks within them.
 */
function stepHeadings(steps: PlanStep[]): string[] | null {
  if (steps.length === 0 || steps.some((step) => step.heading === undefined)) return null;
  const headings = [...new Set(steps.map((step) => step.heading as string))];
  return headings.length < steps.length ? headings : null;
}

/**
 * Where an interrupted build of this target stands, or null when there is
 * nothing to pick up: the build has not started on the plan and instructions as
 * they are now, the active directive is a swarm batch, or nothing is ticked.
 * `content` is their fingerprint when the caller has already taken it.
 */
export function codeGenerationResume(
  projectDir: string,
  target: CodeGenerationTarget,
  known: { plan?: string; content?: string; issued?: CodeGenerationIssuance } = {},
): CodeGenerationResume | null {
  try {
    const state = readFileSync(stateFilePath(projectDir), "utf-8");
    // While `next` issues a run-stage, that directive, not the one on disk
    // (a pause, an error, a question), says which build this is.
    const kind = known.issued?.kind ?? readActiveDirectiveMarker(projectDir, state)?.kind;
    if (kind === "invoke-swarm") return null;
    const authority = resolveCodeGenerationAuthority(projectDir, target, known.issued);
    const questionsPath = join(authority.stageDir, "code-generation-questions.md");
    const fingerprint = existsSync(questionsPath)
      ? questionsFileApprovalFingerprint(readFileSync(questionsPath, "utf-8")) : null;
    const receipt = fingerprint
      ? readPlanApprovalReceipt(projectDir, { targetId: authority.targetId, runFloor: authority.runFloor, fingerprint })
      : null;
    if (receipt?.status !== "generation" || receipt.delegation !== undefined) return null;
    const plan = known.plan ?? readFileSync(join(authority.stageDir, "code-generation-plan.md"), "utf-8");
    const content = known.content ?? buildContentFingerprint(
      plan, readFileSync(join(authority.stageDir, "unit-test-instructions.md"), "utf-8"), authority,
    );
    if (content !== (receipt.startedFingerprint ?? fingerprint)) return null;
    const steps = planSteps(plan);
    let ticked = steps.flatMap((step, index) => step.ticked ? [index + 1] : []);
    let next: number | null = steps.findIndex((step) => !step.ticked) + 1 || null;
    let from: CodeGenerationResume["from"] = "ticks";
    if (ticked.length === 0) {
      const written = stepsWithWrittenFiles(projectDir, receipt.certifiedSourceSha256, steps);
      if (written === 0) return null;
      ticked = Array.from({ length: written }, (_, index) => index + 1);
      next = written < steps.length ? written + 1 : null;
      from = "files";
    }
    // A multi-repo intent's plan may name paths inside a repository, and a step
    // may name one of this stage's own record files. A bare file name (no
    // folder) is in the project when a file of that name is anywhere in it.
    const roots = [projectDir, ...intentRepos(projectDir).map((repo) => join(projectDir, repo)), authority.stageDir];
    let names: Set<string> | null = null;
    const anywhere = (name: string): boolean => {
      names ??= new Set(renderSourcePathKeys(workspaceSourceState(projectDir)?.listing.keys() ?? []).map((path) => basename(path)));
      return names.has(name);
    };
    const present = (path: string): boolean =>
      roots.some((root) => existsSync(join(root, path))) || (!path.includes("/") && anywhere(path));
    const missing = ticked.flatMap((step) => {
      const paths = steps[step - 1].paths.filter((path) => !present(path));
      return paths.length > 0 ? [{ step, paths }] : [];
    });
    return { steps, ticked, from, missing, next };
  } catch {
    return null;
  }
}

/**
 * The fingerprint of a plan and its test instructions over the testing contract
 * the plan embeds: the content a build is on, approved or not. Null when either
 * is empty or the plan embeds no contract.
 */
function buildContentFingerprint(plan: string, instructions: string, authority: CodeGenerationAuthority): string | null {
  const contract = plan.trim().length > 0 ? parseTestingContract(plan)?.contract_sha256 : undefined;
  return contract && instructions.trim().length > 0 ? approvalFingerprint(plan, instructions, contract, authority) : null;
}

/**
 * With no step ticked: the furthest step whose named files all changed since
 * the build started (the source its receipt certified at generation start), or
 * 0 when none did or the start's file listing was not kept. A bare file name
 * matches a changed file of that name in any folder.
 */
function stepsWithWrittenFiles(projectDir: string, startedSource: string, steps: PlanStep[]): number {
  const current = workspaceSourceState(projectDir);
  const changed = workspaceSourceChangedPaths(projectDir, CODE_GENERATION_STAGE, startedSource, current);
  if (changed === null || changed.length === 0) return 0;
  const names = new Set(changed.map((path) => basename(path)));
  const wrote = (path: string): boolean => path.endsWith("/")
    ? changed.some((file) => file.startsWith(path) || file.includes(`/${path}`))
    : path.includes("/")
      ? changed.some((file) => file === path || file.endsWith(`/${path}`))
      : names.has(path);
  let furthest = 0;
  steps.forEach((step, index) => {
    if (step.paths.length > 0 && step.paths.every(wrote)) furthest = index + 1;
  });
  return furthest;
}

/**
 * The plan with every task marker the approval projection resets (`[x]`, `[X]`,
 * `[-]` on a step outside fences and comments, before a terminal review
 * appendix) set back to `[ ]`, and every other byte as it was. Returns the plan
 * unchanged unless its approval projection is provably the same afterwards, so
 * clearing ticks can never change what was approved.
 */
export function resetPlanTaskMarkers(plan: string): string {
  const bom = plan.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = plan.slice(bom.length);
  const body = contentBeforeTerminalReviewAppendix(text);
  const visible = visibleMarkdownLines(body, { preserveIndentedCode: true });
  // Lines at even indices, their own line endings between them.
  const parts = body.split(/(\r\n|\r|\n)/);
  visible.forEach((line, index) => {
    if (PLAN_TASK_MARKER_RE.test(line) && PLAN_TASK_MARKER_RE.test(parts[index * 2] ?? "")) {
      parts[index * 2] = parts[index * 2].replace(PLAN_TASK_MARKER_RE, "$1[ ]");
    }
  });
  const reset = `${bom}${parts.join("")}${text.slice(body.length)}`;
  return projectPlanApprovalContent(reset) === projectPlanApprovalContent(plan) ? reset : plan;
}

function underSwarmDirective(projectDir: string): boolean {
  try {
    const state = readFileSync(stateFilePath(projectDir), "utf-8");
    return readActiveDirectiveMarker(projectDir, state)?.kind === "invoke-swarm";
  } catch {
    return false;
  }
}

/**
 * Clear a plan file's old ticks before a fresh build is marked started, so a
 * crash at any point leaves either no start or no stale ticks. Throws when the
 * plan has ticks and they cannot be cleared: the start then fails and is
 * retried, instead of resuming steps the person asked to redo. The write goes
 * through no symlinked folder under the project. A plan with no ticks is left
 * alone and never fails the start.
 */
export function clearPlanFileTicks(projectDir: string, stageDir: string): void {
  const path = join(stageDir, "code-generation-plan.md");
  if (!existsSync(path)) return;
  const raw = readRegularFileNoFollowOrThrow(path, "code-generation-plan.md");
  const plan = raw.toString("utf-8");
  const roundTrips = Buffer.from(plan, "utf-8").equals(raw);
  const reset = roundTrips ? resetPlanTaskMarkers(plan) : plan;
  if (reset !== plan) {
    writeRecordFileNoFollow(projectDir, relative(projectDir, path), reset);
    return;
  }
  if (planSteps(plan).some((step) => step.ticked)) {
    throw new Error(
      "The old step ticks in code-generation-plan.md could not be cleared for this fresh build. " +
        "Untick its steps, or retry the step.",
    );
  }
}

/** Step numbers as the person reads them: "1-4", "1-2, 4". */
function stepRanges(numbers: number[]): string {
  const ranges: string[] = [];
  for (let start = 0; start < numbers.length;) {
    let end = start;
    while (end + 1 < numbers.length && numbers[end + 1] === numbers[end] + 1) end++;
    ranges.push(end > start ? `${numbers[start]}-${numbers[end]}` : `${numbers[start]}`);
    start = end + 1;
  }
  return ranges.join(", ");
}

// Before the approved plan, so the worker reads where it stands first. The
// approved plan below it is unchanged.
function progressSection(resume: CodeGenerationResume): string {
  const total = resume.steps.length;
  const lines = ["", "## Progress before the interruption", ""];
  const unticked = "the approved plan below shows none ticked, because ticks are not part of the approval";
  if (resume.from === "files") {
    lines.push(
      `This plan's build stopped part way. The plan file ticks none of its ${total} steps, but the files ` +
        `${resume.next === null ? "every step names" : `steps ${stepRanges(resume.ticked)} name`} changed since the build started:`,
      "",
      ...resume.ticked.map((step) => `${step}. ${resume.steps[step - 1].text}`),
      "",
      "Check each of those steps and tick the box of each one that is done.",
    );
  } else if (resume.next === null) {
    lines.push(`This plan's build stopped part way. All ${total} steps are ticked in the plan file (${unticked}).`, "");
  } else {
    lines.push(
      `This plan's build stopped part way. The plan file ticks ${resume.ticked.length} of its ${total} steps (${unticked}):`,
      "",
      ...resume.ticked.map((step) => `${step}. ${resume.steps[step - 1].text}`),
      "",
    );
  }
  // The plan runs in order: a done step before the resume point is looked at
  // first, one after it when the worker reaches it. A named file that is not in
  // the project is a fact; the worker reads the step and decides.
  const names = (paths: string[]): string =>
    `names ${paths.map((path) => `\`${path}\``).join(", ")}, which ${paths.length === 1 ? "is" : "are"} not in the project`;
  const it = (paths: string[]): string => paths.length === 1 ? "that file" : "those files";
  const before = resume.missing.filter(({ step }) => resume.next === null || step < resume.next);
  const after = resume.missing.filter(({ step }) => resume.next !== null && step > resume.next);
  for (const { step, paths } of before) {
    lines.push(`Step ${step} ${names(paths)}: redo step ${step} first if it should have made ${it(paths)}.`);
  }
  if (resume.next !== null) {
    lines.push(
      `${before.length > 0 ? "Then continue" : "Continue"} at step ${resume.next} of ${total}: ` +
        `"${resume.steps[resume.next - 1].text}".`,
    );
  }
  for (const { step, paths } of after) {
    lines.push(`Step ${step} is ticked and ${names(paths)}: when you reach it, redo it if it should have made ${it(paths)}.`);
  }
  lines.push(
    "Before you skip any other ticked step, check that the files it names exist; redo any ticked step whose files are missing." +
      (resume.next === null ? " Nothing else in the plan is left to build." : ""),
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The one line the person hears when an interrupted build is picked up, or null
 * when there is nothing to pick up. Says only what is certain: where it picks
 * up and what is done. Whether a step is redone is the worker's call, said by
 * the agent when it redoes one.
 */
export function codeGenerationResumeNarration(
  projectDir: string,
  unit: string | null,
  issued?: CodeGenerationIssuance,
): string | null {
  const resume = codeGenerationResume(projectDir, { unit }, issued ? { issued } : {});
  if (resume === null) return null;
  const whose = unit === null ? "the code" : `${unit}'s code`;
  const total = resume.steps.length;
  const written = resume.from === "files";
  // A plan grouped under "Step N" headings counts its tasks, and names the
  // heading the next one sits under, so every number matches the plan file.
  const grouped = stepHeadings(resume.steps) !== null;
  const item = grouped ? "task" : "step";
  if (resume.next === null) {
    return `Picking up ${whose}: all ${total} ${item}s ${written ? "wrote their files, checking them" : "are done, checking their files"}.`;
  }
  const where = grouped ? `, in ${resume.steps[resume.next - 1].heading}` : "";
  const done = `${grouped ? "tasks " : ""}${stepRanges(resume.ticked)} ${written ? "wrote their files" : "done"}`;
  return `Picking up ${whose} at ${item} ${resume.next} of ${total}${where} (${done}).`;
}

/**
 * The line the person hears as an approved build starts, counted from the plan
 * file the way the pick-up line counts it, or null when the plan has no steps.
 */
export function codeGenerationStartNarration(projectDir: string, unit: string | null): string | null {
  try {
    const steps = planSteps(readFileSync(join(codeGenerationRecordDir(projectDir, unit), "code-generation-plan.md"), "utf-8"));
    if (steps.length === 0) return null;
    const headings = stepHeadings(steps);
    const count = headings !== null
      ? `the ${steps.length} tasks in ${headings.length} plan steps`
      : `${steps.length} plan ${steps.length === 1 ? "step" : "steps"}`;
    return `Generating ${unit === null ? "code" : `${unit}'s code`} for ${count}. ` +
      "This may take several minutes depending on project complexity. I'll show a summary when complete.";
  } catch {
    return null;
  }
}

function isPlanApprovalLabel(value: string): boolean {
  let normalized = value.trim().replace(/[?:][ \t]*$/, "").trim();
  for (const marker of ["**", "__", "*", "_"]) {
    if (
      normalized.startsWith(marker) &&
      normalized.endsWith(marker) &&
      normalized.length > marker.length * 2
    ) {
      normalized = normalized.slice(marker.length, -marker.length).trim();
      break;
    }
  }
  return normalized.toLowerCase() === "plan approval";
}

function latestPlanApproval(body: string): {
  found: boolean;
  answer: string | null;
  answerLine: number | null;
  fingerprint: string | null;
  plannedSource: string | null;
} {
  let inPlanApproval = false;
  let awaitingNumberedQuestionText = false;
  let foundPlanApproval = false;
  let latestAnswer: string | null = null;
  let latestAnswerLine: number | null = null;
  let latestFingerprint: string | null = null;
  let latestPlannedSource: string | null = null;
  // The heading depth that opened the section. A section runs until a heading
  // at the same depth or shallower, which is how a Markdown section ends;
  // a deeper heading is a subsection of it. Closing on ANY heading let a
  // sub-heading written inside the section hide the [Answer] and
  // [Approval Fingerprint] below it, and the resulting null fingerprint was
  // then reported as a fingerprint mismatch.
  let planApprovalDepth = 0;
  // True once a deeper heading has opened a subsection of the section. Tags
  // read from there FILL an empty slot but never replace a value the section
  // already carried: a heading nested under the section could also be a
  // malformed next question, and letting its answer overwrite a pending
  // Plan Approval would turn an unanswered gate into an approval.
  let inSubsection = false;

  const openPlanApproval = (depth: number): void => {
    inPlanApproval = true;
    planApprovalDepth = depth;
    inSubsection = false;
    awaitingNumberedQuestionText = false;
    foundPlanApproval = true;
    latestAnswer = null;
    latestAnswerLine = null;
    latestFingerprint = null;
    latestPlannedSource = null;
  };

  const visible = visibleMarkdownLines(body);
  for (let index = 0; index < visible.length; index++) {
    const line = visible[index];
    const heading = line.match(MARKDOWN_HEADING_RE);
    if (heading) {
      const depth = heading[1].length;
      const headingText = heading[2].trim();
      if (isPlanApprovalLabel(headingText.replace(QUESTION_PREFIX_RE, ""))) {
        openPlanApproval(depth);
        continue;
      }
      if (
        inPlanApproval &&
        depth > planApprovalDepth &&
        // A numbered heading is the next question, however deeply it was
        // nested, so it ends the section rather than opening a subsection.
        !QUESTION_PREFIX_RE.test(headingText) &&
        !NUMBERED_QUESTION_HEADING_RE.test(headingText)
      ) {
        // A prose subsection of the open Plan Approval section: its body still
        // belongs to that section, but only to fill tags the section lacks.
        inSubsection = true;
        awaitingNumberedQuestionText = false;
        continue;
      }
      inPlanApproval = false;
      awaitingNumberedQuestionText = NUMBERED_QUESTION_HEADING_RE.test(headingText);
      if (awaitingNumberedQuestionText) planApprovalDepth = depth;
      continue;
    }
    if (awaitingNumberedQuestionText && line.trim().length > 0) {
      awaitingNumberedQuestionText = false;
      // The numbered form puts the label on the line after the heading, so the
      // section it opens has that heading's depth.
      if (isPlanApprovalLabel(line)) openPlanApproval(planApprovalDepth);
    }
    if (!inPlanApproval) continue;
    const answer = line.match(ANSWER_TAG_RE);
    if (answer && !(inSubsection && latestAnswer !== null)) {
      latestAnswer = answer[1].trim();
      latestAnswerLine = index;
    }
    const fingerprint = line.match(FINGERPRINT_TAG_RE);
    if (fingerprint && !(inSubsection && latestFingerprint !== null)) {
      latestFingerprint = fingerprint[1] ?? null;
    }
    const plannedSource = line.match(PLANNED_SOURCE_TAG_RE);
    if (plannedSource && !(inSubsection && latestPlannedSource !== null)) {
      latestPlannedSource = plannedSource[1] ?? null;
    }
  }
  return {
    found: foundPlanApproval,
    answer: latestAnswer,
    answerLine: latestAnswerLine,
    fingerprint: latestFingerprint,
    plannedSource: latestPlannedSource,
  };
}

export function questionsFileApproved(body: string): boolean {
  const latest = latestPlanApproval(body);
  return (
    latest.found &&
    latest.answer !== null &&
    APPROVE_PLAN_RE.test(latest.answer)
  );
}

export function questionsFileHasPendingPlanApproval(body: string): boolean {
  const latest = latestPlanApproval(body);
  return (
    latest.found &&
    latest.answer !== null &&
    /^_*$/.test(latest.answer)
  );
}

export function questionsFileApprovalFingerprint(body: string): string | null {
  return latestPlanApproval(body).fingerprint;
}

export function questionsFilePlannedSource(body: string): string | null {
  return latestPlanApproval(body).plannedSource;
}

/**
 * The questions-file section the fingerprint tags must sit in, ready to paste.
 * The heading is the label `Plan Approval`, never the question: the decision's
 * `--decision` text is what the human is asked, and a heading carrying it is
 * not read as Plan Approval at all.
 */
export function planApprovalSectionSkeleton(
  fingerprint = "sha256:v3:<hex>",
  plannedSource = "<hex or the word unbindable>",
): string {
  return [
    "## Plan Approval",
    "",
    `[Approval Fingerprint]: ${fingerprint}`,
    `[Planned Source]: ${plannedSource}`,
    "",
    "- \"Approve Plan\": proceed to code generation",
    "- \"Request Changes\": revise the plan",
    "",
    "[Answer]:",
    "",
  ].join("\n");
}

/**
 * Why no fingerprint was read from the questions file. A tag counts only under
 * a heading whose text is exactly "Plan Approval", so a section titled with the
 * question reads as no fingerprint at all; name the heading rather than report
 * a mismatch against a value that was never read.
 */
function missingPlanApprovalFingerprintReason(questions: string): string {
  if (!latestPlanApproval(questions).found) {
    return "code-generation-questions.md has no Plan Approval section, so no [Approval Fingerprint]: tag is read from it. " +
      "The tags count only under a heading whose text is exactly `Plan Approval` (`## Plan Approval`; " +
      "`## Q1: Plan Approval` also works). The --decision text is the question asked, not the heading. " +
      "Retitle the section `## Plan Approval`, keep both tag lines the fingerprint command printed directly under it, " +
      "then re-run the decision command and re-present the plan.";
  }
  return "the Plan Approval section in code-generation-questions.md has no well-formed [Approval Fingerprint]: line " +
    "before the next heading at the same or a higher level. Re-run the fingerprint command, write both lines it prints directly under the " +
    "`## Plan Approval` heading, then re-run the decision command and re-present the plan.";
}

export function promptTestingContractMarkers(text: string): string[] {
  const hashes = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(CONTRACT_MARKER_RE);
    if (marker) hashes.add(marker[1]);
  }
  return Array.from(hashes);
}

function normalizeCodeGenerationTarget(target: CodeGenerationTarget): CodeGenerationTarget {
  if (target.unit === null) return { unit: null };
  const unit = target.unit.trim();
  const error = validateUnitName(unit);
  if (error) throw new Error(error);
  return { unit };
}

export function codeGenerationTargetId(target: CodeGenerationTarget): string {
  const normalized = normalizeCodeGenerationTarget(target);
  return normalized.unit === null ? "stage:code-generation" : `unit:${normalized.unit}`;
}

export function resolveCodeGenerationAuthority(
  projectDir: string,
  requestedTarget: CodeGenerationTarget,
  issued?: CodeGenerationIssuance,
): CodeGenerationAuthority {
  return codeGenerationAuthority(projectDir, requestedTarget, undefined, issued);
}

// The Code Generation directive the active one is, or stands in for.
function activeCodeGenerationDirective(marker: ActiveDirectiveMarker): CodeGenerationIssuance {
  if (marker.stage !== "code-generation") {
    throw new Error(
      `Code Generation approval authority does not match active directive stage "${marker.stage}"`,
    );
  }
  // While the engine is asking for Plan Approval, the question is the active
  // directive. It names the same targets the run-stage (one Unit, or none) or
  // invoke-swarm (a group) it stands in for, so it carries the same authority.
  const planApprovalAsk = marker.kind === "ask" && marker.ask_type === PLAN_APPROVAL_ASK_TYPE;
  // A run-stage whose rules do not fit one message is issued as load-steering
  // parts first, on a marker naming the same stage and Unit. Each part is that
  // run-stage on its way, so an approval never depends on how many parts the
  // rules needed.
  const runStage = marker.kind === "run-stage" || marker.kind === "load-steering";
  if (!runStage && marker.kind !== "invoke-swarm" && !planApprovalAsk) {
    throw new Error(
      `Code Generation approval authority requires a run-stage or invoke-swarm directive, got "${marker.kind}"`,
    );
  }
  return runStage || (planApprovalAsk && (marker.unit !== undefined || !marker.units?.length))
    ? { kind: "run-stage", ...(marker.unit !== undefined ? { unit: marker.unit } : {}) }
    : { kind: "invoke-swarm", units: marker.units ?? [] };
}

/**
 * The Code Generation directive this marker is, or stands in for; null when it
 * names no target an approval binds to. With `setAside`, a marker that no
 * longer names one (a step set aside since it was issued keeps its stage and
 * the Unit or Units it named) is read the same way a Plan Approval question
 * is: its Unit, else its group, else the zero-Unit stage-level work.
 */
export function codeGenerationIssuance(
  marker: ActiveDirectiveMarker,
  setAside = false,
): CodeGenerationIssuance | null {
  try {
    return activeCodeGenerationDirective(marker);
  } catch {
    if (!setAside || marker.stage !== CODE_GENERATION_STAGE) return null;
    if (marker.unit !== undefined) return { kind: "run-stage", unit: marker.unit };
    return marker.units?.length ? { kind: "invoke-swarm", units: marker.units } : { kind: "run-stage" };
  }
}

/**
 * How every command AI-DLC names is to be run: as printed and alone. A `cd`, a
 * pipe, or a second command around an admitted command makes the whole line a
 * shell the plan-approval guard cannot read.
 */
export const AS_ITS_OWN_COMMAND =
  "exactly as written, as a command of its own (no `cd` before it, no pipe or second command after it)";

/**
 * How every AI-DLC agent does file work and runs AI-DLC's commands. The one
 * owner of the wording: the worker brief renders it, and the conductor
 * persona, the subagent dispatch protocol, and the reviewer protocol carry it
 * verbatim (t-agent-conduct). Inside the project the file tools run without a
 * prompt on every harness; a shell write, or a compound shell line, can stop
 * and ask the person. The rule is about the agent writing a file itself: a
 * project command the plan calls for that writes files on its own still runs.
 * Reads go through the shell only where that is the harness's one way to read
 * (Codex), as one plain command.
 */
export const FILE_TOOLS_RULE =
  "Write and edit files yourself with your file tools, never through the shell (no heredoc, no `echo`, " +
  "`printf`, or `python3` writing a file, no `sed -i`, no `mkdir`; the file-write tool creates any " +
  "missing folder). A command the person asks for, or one the plan names (a package install, a build, " +
  "a scaffolder, a migration, a formatter, a code generator, even a `mkdir`), still runs as written. " +
  "Read, list, and search (your own knowledge files included) with your file tools where you have them; where the shell " +
  "is your only way to read, use one plain read command (no `cd` before it, no pipe or second command " +
  `after it). Run every AI-DLC command ${AS_ITS_OWN_COMMAND}, keeping its path as written (never a full path): ` +
  "a shell line can stop and ask the person to approve it.";

// A rules part's receipt as the engine mints it: 8 base64url characters
// (`steeringReceipt` in aidlc-orchestrate.ts).
const PART_RECEIPT_RE = /^[A-Za-z0-9_-]{8}$/;

/**
 * Why nothing is built yet while Code Generation's rules are still arriving.
 * A rules part carries the approval of the run-stage it delivers, but that
 * run-stage, which says how to build, has not reached the agent: the worker
 * brief, generation start, and a worker dispatch wait for it. Names the exact
 * command that fetches the next part, and the fresh `next` that starts the
 * parts over for a caller (another chat, a worker) that never held the earlier
 * ones. The run-stage may plan, build, or close a gate, so the line names the
 * step only as the stage's own. Null when no rules part is in flight.
 */
export function codeGenerationRulesArrivingReason(marker: ActiveDirectiveMarker | null): string | null {
  if (marker?.version !== 2 || marker.stage !== CODE_GENERATION_STAGE || marker.kind !== "load-steering") {
    return null;
  }
  const engine = aidlcToolInvocation("orchestrate");
  const loaded = `The Code Generation rules are still arriving (part ${marker.part} of ${marker.parts} has been loaded). ` +
    `Run each command named here ${AS_ITS_OWN_COMMAND}.`;
  const after = "follow each part until the Code Generation step itself arrives; nothing is built or handed to a worker before then.";
  // Only a receipt in the engine's own shape is put in a command; anything
  // else on the marker gets the fresh `next`, which is always safe to run.
  const receipt = marker.continue_token;
  return receipt !== undefined && PART_RECEIPT_RE.test(receipt)
    ? `${loaded} Run \`${engine} continue ${receipt}\` and ${after} ` +
      `If you do not have the earlier parts, run \`${engine} next\` instead.`
    : `${loaded} Run \`${engine} next\` and ${after}`;
}

function refuseWhileRulesArrive(projectDir: string): void {
  let marker: ActiveDirectiveMarker | null;
  try {
    marker = readActiveDirectiveMarker(projectDir, readFileSync(stateFilePath(projectDir), "utf-8"));
  } catch {
    return;
  }
  const reason = codeGenerationRulesArrivingReason(marker);
  if (reason !== null) throw new Error(reason);
}

function codeGenerationAuthority(
  projectDir: string,
  requestedTarget: CodeGenerationTarget,
  batchPeers?: { units: string[]; markerSha256: string },
  issued?: CodeGenerationIssuance,
): CodeGenerationAuthority {
  const target = normalizeCodeGenerationTarget(requestedTarget);
  const statePath = stateFilePath(projectDir);
  if (!existsSync(statePath)) {
    throw new Error("Code Generation approval authority requires an active workflow state");
  }
  const state = readFileSync(statePath, "utf-8");
  const marker = readActiveDirectiveMarker(projectDir, state);
  if (marker?.version !== 2) {
    throw new Error(
      "Code Generation approval authority is unavailable because the active directive is missing, stale, or legacy; run a fresh `next`",
    );
  }
  // Only batch validation supplies this proof, after validating the original
  // group against the live lifecycle. It permits reading completed peers that
  // a pending-only directive no longer dispatches, without widening dispatch.
  if (batchPeers && (hashObject(marker) !== batchPeers.markerSha256 ||
    target.unit === null || !batchPeers.units.includes(target.unit))) {
    throw new Error("Plan Approval batch directive changed while checking its members");
  }
  // `next` asks whether a plan is approved while it routes the directive it is
  // about to issue, before publishing it. The active directive is then whatever
  // the engine said last (the question itself, a pause, a guard-recovery
  // question, or one a compacted chat must re-read), and none of those decides
  // which plan is current: the directive being issued does.
  const scope = issued ?? activeCodeGenerationDirective(marker);

  if (target.unit === null) {
    if (scope.kind !== "run-stage" || scope.unit !== undefined) {
      throw new Error(
        "Stage-level Code Generation approval requires a zero-Unit run-stage directive",
      );
    }
  } else if (scope.kind === "run-stage") {
    if (scope.unit !== target.unit && !batchPeers) {
      // A settled swarm emits one run-stage target for the whole batch. Its
      // other members still need their parent authority during delegation and
      // checkpoint review; only a committed, current group can select them.
      const questions = join(codeGenerationRecordDir(projectDir, target.unit), "code-generation-questions.md");
      const fingerprint = existsSync(questions)
        ? questionsFileApprovalFingerprint(readFileSync(questions, "utf-8")) : null;
      const runFloor = latestMainWorkflowStageRunFloorForProject(
        projectDir, CODE_GENERATION_STAGE,
        getField(state, "Construction Iteration")?.trim() === "unit-major" ||
          getField(state, "Construction Checkpoints") === "enabled",
        target.unit,
      );
      const receipt = fingerprint ? readPlanApprovalReceipt(projectDir, {
        targetId: codeGenerationTargetId(target), runFloor, fingerprint,
      }) : null;
      if (!receipt?.batch?.members.some((member) => member.unit === target.unit)) {
        throw new Error(
          `Code Generation approval target unit "${target.unit}" does not match active directive unit "${scope.unit ?? "(none)"}"`,
        );
      }
      assertPlanApprovalBatchLifecycle(projectDir, receipt);
    }
  } else {
    const dag = resolveBoltDag(projectDir);
    if (
      dag.state !== "ok" ||
      !dag.units.includes(target.unit) ||
      (!scope.units.includes(target.unit) && !batchPeers)
    ) {
      throw new Error(
        `Code Generation approval target unit "${target.unit}" is not in the active swarm directive and authoritative Unit DAG`,
      );
    }
  }

  const issuanceRevision =
    marker.code_generation_authority_revision ??
    marker.active_attempt?.result_revision ??
    marker.revision;
  if (!Number.isInteger(issuanceRevision)) {
    throw new Error("Code Generation active directive has no stable issuance revision");
  }
  const markerRevision = Number(issuanceRevision);
  const targetId = codeGenerationTargetId(target);
  const delegated = delegatedWorktreeIntent(projectDir);
  if (delegated && marker.intent_uuid !== delegated.intentUuid) {
    throw new Error("Code Generation directive does not match the delegated parent intent");
  }
  const intentId = marker.intent_uuid ?? "bare-space";
  const sourceFloor =
    marker.code_generation_source_sha256 ?? UNBINDABLE_FINGERPRINT;
  // Pass the target Unit: a GATE_REJECTED row for one Unit carries that Unit, and
  // without it a rejected per-Unit gate moved no Unit's approval floor in team
  // mode while moving it in solo.
  const runFloor = latestMainWorkflowStageRunFloorForProject(
    projectDir,
    "code-generation",
    getField(state, "Construction Iteration")?.trim() === "unit-major" ||
      getField(state, "Construction Checkpoints") === "enabled",
    target.unit ?? undefined,
  );
  const directiveEpoch = hashObject({
    version: marker.version,
    project: marker.project_sha256,
    intent: marker.intent_uuid,
    state: marker.state_sha256,
    stage: marker.stage,
    directive_unit: marker.unit ?? null,
    kind: marker.kind,
    issuance_revision: issuanceRevision,
    owner_epoch: marker.owner_epoch,
    context_epoch: marker.context_epoch,
    continue_token: marker.continue_token_sha256 ?? null,
    target: targetId,
    source_floor: sourceFloor,
  });
  return {
    unit: target.unit,
    targetId,
    intentId,
    directiveEpoch,
    runFloor,
    stageDir: codeGenerationRecordDir(projectDir, target.unit),
    sourceFloor,
    markerRevision,
  };
}

export function codeGenerationRecordDir(
  projectDir: string,
  unit: string | null,
): string {
  const root = join(docsRoot(projectDir), "construction");
  const normalizedUnit = unit?.trim() ?? "";
  return normalizedUnit.length > 0
    ? join(root, normalizedUnit, "code-generation")
    : join(root, "code-generation");
}

function codeGenerationApprovalArtifacts(
  projectDir: string,
  authority: CodeGenerationAuthority,
  contractProjectDir = projectDir,
): {
  plan: string;
  instructions: string;
  questions: string;
  planExists: boolean;
  instructionsExist: boolean;
  approvedAnswer: boolean;
  contractValid: boolean;
  contractHash: string | null;
  expectedFingerprint: string | null;
  recordedFingerprint: string | null;
  questionsPath: string;
} {
  const planPath = join(authority.stageDir, "code-generation-plan.md");
  const instructionsPath = join(authority.stageDir, "unit-test-instructions.md");
  const questionsPath = join(authority.stageDir, "code-generation-questions.md");
  const plan = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
  const instructions = existsSync(instructionsPath)
    ? readFileSync(instructionsPath, "utf-8")
    : "";
  const questions = existsSync(questionsPath)
    ? readFileSync(questionsPath, "utf-8")
    : "";
  const planExists = plan.trim().length > 0;
  const instructionsExist = instructions.trim().length > 0;
  const approvedAnswer = questionsFileApproved(questions);
  const embedded = planExists ? parseTestingContract(plan) : null;
  const current = planExists ? resolveTestingPosture(contractProjectDir) : null;
  const contractHash = embedded?.contract_sha256 ?? null;
  const contractValid =
    embedded !== null &&
    current !== null &&
    embedded.contract_sha256 === current.contract_sha256;
  const expectedFingerprint =
    planExists && instructionsExist && contractValid && current
      ? approvalFingerprint(
          plan,
          instructions,
          current.contract_sha256,
          authority,
        )
      : null;
  return {
    plan,
    instructions,
    questions,
    planExists,
    instructionsExist,
    approvedAnswer,
    contractValid,
    contractHash,
    expectedFingerprint,
    recordedFingerprint: questionsFileApprovalFingerprint(questions),
    questionsPath,
  };
}

interface CodeGenerationContinuation {
  authority: CodeGenerationAuthority;
  artifacts: ReturnType<typeof codeGenerationApprovalArtifacts>;
  receipt: PlanApprovalRuntimeReceipt;
  fence: ReturnType<typeof decideFence>;
  /** Read-only drift preview; generation start records it under the authority locks. */
  sourceChange?: AcceptedChange;
}

/**
 * Permission to continue is distinct from evidence that the current content was
 * approved. Keep the original receipt and question identity: lowering a fence
 * does not manufacture a human answer, cross a target, or revive an old attempt.
 */
// The human's earlier "Approve Plan" for this target and attempt, proven by its
// receipt, whatever has changed in the plan or source since. A lowered fence
// can only continue from this; it never stands in for it.
function earlierPlanApproval(
  projectDir: string,
  target: CodeGenerationTarget,
  issued?: CodeGenerationIssuance,
): { authority: CodeGenerationAuthority; receipt: PlanApprovalRuntimeReceipt } | null {
  const authority = resolveCodeGenerationAuthority(projectDir, target, issued);
  const questionsPath = join(authority.stageDir, "code-generation-questions.md");
  // A checkout that changed its line endings has not changed the answer.
  const questions = readFileSync(questionsPath, "utf-8").replace(/\r\n/g, "\n");
  const fingerprint = questionsFileApprovalFingerprint(questions);
  if (!fingerprint || !approvalFingerprintIsCurrentFormat(fingerprint) || !questionsFileApproved(questions)) return null;
  const promptSha256 = createHash("sha256")
    .update(`${questions.replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:").trimEnd()}\n`, "utf-8")
    .digest("hex");
  const identity: PlanApprovalRuntimeIdentity = {
    targetId: authority.targetId,
    intentId: authority.intentId,
    runFloor: authority.runFloor,
    fingerprint,
    questionsFile: toPosix(relative(projectDir, questionsPath)),
    promptSha256,
  };
  const receipt = readPlanApprovalReceipt(projectDir, identity);
  // A lowered fence continues past a changed questions file too (a note, a
  // reformat): the approval is of the plan content and attempt the receipt
  // names, and only this machine's own receipt counts.
  if (
    receipt?.choice !== "Approve Plan" ||
    !runtimeIdentityMatches(receipt, { ...identity, promptSha256: receipt.promptSha256 })
  ) return null;
  const violation = readPlanApprovalViolation(projectDir);
  if (violation?.version === 1 && violation.markerRevision === authority.markerRevision) return null;
  return { authority, receipt };
}

// What an earlier approval needs to be executed under a lowered fence: the
// material to build from, not renewed approval. A changed but well-formed
// contract is usable, and drift is accepted because the fence is lowered.
function continuationMaterial(
  projectDir: string,
  earlier: NonNullable<ReturnType<typeof earlierPlanApproval>>,
  contractProject: string,
): { artifacts: ReturnType<typeof codeGenerationApprovalArtifacts>; sourceChange?: AcceptedChange } | null {
  const { authority, receipt } = earlier;
  if (receipt.batch) assertPlanApprovalBatchLifecycle(contractProject, receipt);
  const artifacts = codeGenerationApprovalArtifacts(projectDir, authority, contractProject);
  if (!artifacts.planExists || !artifacts.instructionsExist ||
    !usableTestingContract(parseTestingContract(artifacts.plan))) return null;
  let sourceChange: AcceptedChange | undefined;
  if (receipt.status !== "generation" && receipt.override === undefined) {
    // The fence is lowered here, so a project whose files cannot all be read
    // builds without the comparison (generation start says so in one line).
    const current = workspaceSourceState(projectDir);
    if (current === null) return { artifacts };
    if (!sameWorkspaceSource(receipt.certifiedSourceSha256, current.fingerprint)) {
      const judged = judgePlanSourceDrift(
        projectDir, authority.unit, receipt.certifiedSourceSha256, current, false, true, true,
      );
      if ("refusal" in judged) return null;
      sourceChange = judged.accepted;
    }
  }
  return { artifacts, ...(sourceChange ? { sourceChange } : {}) };
}

function continuationContractProject(
  projectDir: string,
  earlier: NonNullable<ReturnType<typeof earlierPlanApproval>>,
): string {
  return earlier.receipt.delegation
    ? worktreeDelegationParent(projectDir, earlier.authority, earlier.receipt) : projectDir;
}

function codeGenerationContinuation(
  projectDir: string,
  target: CodeGenerationTarget,
  issued?: CodeGenerationIssuance,
): CodeGenerationContinuation | null {
  try {
    const earlier = earlierPlanApproval(projectDir, target, issued);
    if (earlier === null) return null;
    const { authority, receipt } = earlier;
    const contractProject = continuationContractProject(projectDir, earlier);
    const fence = {
      ...decideFence(contractProject, "plan-approval"),
      authority: authorityFor(projectDir),
    };
    if (fence.decision !== "stand-aside") return null;
    const material = continuationMaterial(projectDir, earlier, contractProject);
    if (material === null) return null;
    return { authority, receipt, fence, ...material };
  } catch {
    return null;
  }
}

/** A delegated worker follows the live setting of its verified parent intent. */
export function codeGenerationPlanApprovalFence(
  projectDir: string,
  target: CodeGenerationTarget,
  options: Parameters<typeof decideFence>[2] = {},
): ReturnType<typeof decideFence> {
  if (!existsSync(join(projectDir, ".aidlc", "worktree-meta.json"))) {
    return decideFence(projectDir, "plan-approval", options);
  }
  const authority = resolveCodeGenerationAuthority(projectDir, target);
  const path = join(authority.stageDir, "code-generation-questions.md");
  const fingerprint = existsSync(path)
    ? questionsFileApprovalFingerprint(readFileSync(path, "utf-8")) : null;
  const receipt = fingerprint ? readPlanApprovalReceipt(projectDir, {
    targetId: authority.targetId, runFloor: authority.runFloor, fingerprint,
  }) : null;
  const policyProject = receipt?.delegation
    ? worktreeDelegationParent(projectDir, authority, receipt) : projectDir;
  return {
    ...decideFence(policyProject, "plan-approval", options),
    authority: authorityFor(projectDir, options),
  };
}

export function codeGenerationExecutionAllowed(
  projectDir: string,
  target: CodeGenerationTarget,
  approval?: CodeGenerationApproval,
  issued?: CodeGenerationIssuance,
): boolean {
  const current = approval ?? evaluateCodeGenerationApproval(projectDir, target, issued);
  return !current.executionFailure &&
    (current.ok || codeGenerationContinuation(projectDir, target, issued) !== null);
}

function recordCodeGenerationContinuation(
  projectDir: string,
  continuation: CodeGenerationContinuation,
  operation: string,
): string[] {
  const detail = `${operation} for ${continuation.authority.targetId} using current content; the earlier approval is unchanged`;
  // An approved plan that changed before the build is named for the person.
  const changed = approvedPlanChangeLine(projectDir, { unit: continuation.authority.unit });
  const recorded = recordGuardStoodAside(projectDir, {
    fence: "plan-approval",
    authority: continuation.fence.authority,
    stage: CODE_GENERATION_STAGE,
    tool: `testing-posture ${operation}`,
    details: detail,
  });
  // The row is the lowered fence's account of what it let through, not
  // approval evidence: a ledger that cannot take it never stops the person's
  // build. The line says it was not recorded, and the doctor lists the miss.
  if (!recorded) {
    recordHookDrop(projectDir, "testing-posture", `GUARD_STOOD_ASIDE row not recorded (audit ledger busy or not writable): ${detail}`);
  }
  const line = guardStoodAsideLine("plan-approval", continuation.fence.source, detail, recorded);
  // Under Guard Policy off the row is the whole account: the stand-aside line
  // is not said.
  const speaks = guardStandAsideSpeaks(continuation.fence);
  if (changed === null) return speaks ? [line] : [];
  // An approved plan that changed is named in place of the stand-aside line.
  // A row the ledger could not take is still said beside it, so the doctor's
  // list matches.
  return recorded || !speaks ? [changed] : [changed, line];
}

export interface LegacyPlanApprovalGuardState {
  active: boolean;
  approved: boolean;
  pending: boolean;
  humanAfterDecision: boolean;
  sourceFloorValid: boolean;
  violated?: boolean;
  target: CodeGenerationTarget | null;
}

/**
 * Legacy Kiro IDE PreToolUse payloads identify the tool but omit its arguments.
 * The adapter therefore cannot distinguish a planning-record write from a
 * workspace mutation. This state lets it preserve the usable workflow:
 * planning remains available before the exact Plan Approval prompt, every tool
 * hard-stops while that prompt awaits a human, and workspace source is checked
 * against the `[Planned Source]` the questions file records, exactly as the
 * answer path checks it. Before a planned source is recorded there is nothing
 * to compare; the adapter records the live source when it mediates the
 * decision. After one is recorded, drift is refused with a remedy the conductor
 * can always execute (re-present the plan), never with "revert the workspace".
 */
export function legacyPlanApprovalGuardState(
  projectDir: string,
): LegacyPlanApprovalGuardState {
  const inactive: LegacyPlanApprovalGuardState = {
    active: false,
    approved: false,
    pending: false,
    humanAfterDecision: false,
    sourceFloorValid: true,
    violated: false,
    target: null,
  };
  try {
    const statePath = stateFilePath(projectDir);
    if (!existsSync(statePath)) return inactive;
    const state = readFileSync(statePath, "utf-8");
    const marker = readActiveDirectiveMarker(projectDir, state);
    if (
      marker?.version !== 2 ||
      marker.stage !== "code-generation" ||
      (marker.kind !== "run-stage" && marker.kind !== "invoke-swarm")
    ) {
      return inactive;
    }
    let target: CodeGenerationTarget;
    if (marker.kind === "run-stage") {
      target = { unit: marker.unit?.trim() || null };
    } else {
      const units = marker.units ?? [];
      if (units.length === 0) {
        throw new Error("active swarm directive carries no authoritative units");
      }
      const pending = units.find(
        (unit) => !evaluateCodeGenerationApproval(projectDir, { unit }).ok,
      );
      target = { unit: pending ?? units[0] };
    }
    const authority = resolveCodeGenerationAuthority(projectDir, target);
    const violation = readPlanApprovalViolation(projectDir);
    const violated =
      violation?.version === 1 &&
      violation.markerRevision === authority.markerRevision;
    const approval = evaluateCodeGenerationApproval(projectDir, target);
    const artifacts = codeGenerationApprovalArtifacts(projectDir, authority);
    const plannedSource = questionsFilePlannedSource(artifacts.questions);
    const sourceFloorValid =
      plannedSource === null ||
      plannedSource === UNBINDABLE_FINGERPRINT ||
      sameWorkspaceSource(plannedSource, workspaceSourceFingerprint(projectDir));
    if (approval.ok) {
      return {
        active: true,
        approved: true,
        pending: false,
        humanAfterDecision: false,
        sourceFloorValid: true,
        violated,
        target,
      };
    }

    if (artifacts.expectedFingerprint === null) {
      return {
        active: true,
        approved: false,
        pending: false,
        humanAfterDecision: false,
        sourceFloorValid,
        violated,
        target,
      };
    }
    const promptSha256 = createHash("sha256")
      .update(
        `${artifacts.questions
          .replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:")
          .trimEnd()}\n`,
        "utf-8",
      )
      .digest("hex");
    const session = latestLedgerSession(projectDir);
    const challenge =
      session === null ? null : readPlanApprovalChallenge(projectDir, session);
    const response =
      session === null ? null : readPlanApprovalResponse(projectDir, session);
    const challengeMatches =
      challenge !== null &&
      runtimeIdentityMatches(challenge, {
        targetId: authority.targetId,
        intentId: authority.intentId,
        runFloor: authority.runFloor,
        fingerprint: artifacts.expectedFingerprint,
        questionsFile: toPosix(relative(projectDir, artifacts.questionsPath)),
        promptSha256,
      });
    const humanAfterDecision =
      challengeMatches &&
      response !== null &&
      response.challengeId === challenge.challengeId;
    return {
      active: true,
      approved: false,
      pending: challengeMatches && !humanAfterDecision,
      humanAfterDecision,
      sourceFloorValid,
      violated,
      target,
    };
  } catch {
    return {
      active: true,
      approved: false,
      pending: false,
      humanAfterDecision: false,
      sourceFloorValid: false,
      violated: true,
      target: null,
    };
  }
}

function runtimeIdentity(
  evidence: PlanApprovalQuestionEvidence,
): PlanApprovalRuntimeIdentity {
  return {
    targetId: evidence.authority.targetId,
    intentId: evidence.authority.intentId,
    runFloor: evidence.authority.runFloor,
    fingerprint: evidence.fingerprint,
    questionsFile: evidence.questionsRelativePath,
    promptSha256: evidence.promptSha256,
  };
}

// Recorded, never compared. The directive epoch and marker revision describe the
// directive that happened to be issued when the human answered; the legacy Kiro
// IDE window handshake still reads the revision off a challenge, and both help a
// human reading the store understand where a receipt came from.
function runtimeProvenance(
  evidence: PlanApprovalQuestionEvidence,
): PlanApprovalRuntimeProvenance {
  return {
    directiveEpoch: evidence.authority.directiveEpoch,
    sourceFloor: evidence.authority.sourceFloor,
    markerRevision: evidence.authority.markerRevision,
    plannedSourceSha256: evidence.plannedSourceSha256,
  };
}

function runtimeIdentityMatches(
  value: PlanApprovalRuntimeIdentity,
  expected: PlanApprovalRuntimeIdentity,
): boolean {
  return (
    value.targetId === expected.targetId &&
    value.intentId === expected.intentId &&
    value.runFloor === expected.runFloor &&
    value.fingerprint === expected.fingerprint &&
    value.questionsFile === expected.questionsFile &&
    value.promptSha256 === expected.promptSha256
  );
}

export const PLAN_APPROVAL_BATCH_FALLBACK =
  "Use decision/answer --stage code-generation --checkpoint plan-approval " +
  "--unit <unit> --questions-file <path> --session <id> separately for each unit.";

interface PlanApprovalBatchSelection {
  batch: string;
  units: Array<{ unit: string; questionsFile: string }>;
}

interface BoundPlanApprovalBatch extends PlanApprovalRuntimeBatch {
  context: {
    batch: number;
    dagBatches: string[][];
    stageFloor: string;
    workflowSha256: string | null;
    sourceSha256: string;
  };
}

function planApprovalBatchContext(projectDir: string, units: string[], sourceSha256: string): BoundPlanApprovalBatch["context"] {
  const dag = resolveBoltDag(projectDir);
  const batch = dag.state === "ok"
    ? dag.batches.findIndex((members) => units.every((unit) => members.includes(unit))) + 1 : 0;
  if (!batch || dag.state !== "ok") throw new Error("Plan Approval group must belong to one authoritative DAG batch");
  const unreadable: string[] = [];
  const rows = readAuditShardEvents(projectDir, undefined, undefined, unreadable);
  const workflows = maximalAttemptEvents(rows.filter((row) => row.event === "WORKFLOW_STARTED" &&
    !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:")));
  const stageFloor = latestMainWorkflowStageRunFloorForProject(
    projectDir, CODE_GENERATION_STAGE, false, undefined, rows,
  );
  if (unreadable.length || workflows.length > 1 || stageFloor.startsWith("AMBIGUOUS:")) {
    throw new Error("Plan Approval batch attempt evidence is unreadable or ambiguous");
  }
  return {
    batch, dagBatches: dag.batches, stageFloor,
    workflowSha256: workflows[0] ? hashObject(workflows[0].block) : null,
    sourceSha256,
  };
}

function assertPlanApprovalBatchLifecycle(projectDir: string, receipt: PlanApprovalRuntimeReceipt): ActiveDirectiveMarker {
  const batch = receipt.batch as BoundPlanApprovalBatch;
  if (!batch?.context || !planApprovalBatchCommitted(projectDir, receipt) ||
    hashObject({ name: batch.name, members: batch.members, context: batch.context }) !== batch.bindingSha256) {
    throw new Error("Plan Approval batch receipt transaction or attempt binding is not current; re-present every plan");
  }
  const units = batch.members.map((member) => member.unit);
  if (hashObject(planApprovalBatchContext(projectDir, units, batch.context.sourceSha256)) !== hashObject(batch.context)) {
    throw new Error("Plan Approval batch DAG or attempt changed; re-present every plan");
  }
  const marker = readActiveDirectiveMarker(projectDir, readFileSync(stateFilePath(projectDir), "utf-8"));
  if (marker?.version !== 2 || marker.stage !== CODE_GENERATION_STAGE ||
    !units.length || new Set(units).size !== units.length ||
    !marker.units?.length || new Set(marker.units).size !== marker.units.length ||
    !marker.units.every((unit) => units.includes(unit))) {
    throw new Error("Plan Approval batch no longer matches the emitted unit set; re-present every plan");
  }
  const entireGroup = marker.units.length === units.length;
  if (marker.kind === "invoke-swarm" && entireGroup) return marker;
  // Marker units survive the engine's checkpoint/completion publication. They
  // alone are not authority: prove the same batch actually ran and converged.
  if (marker.kind !== "invoke-swarm" &&
    (marker.kind !== "run-stage" || !marker.unit || !units.includes(marker.unit))) {
    throw new Error("Plan Approval batch has no supported lifecycle successor");
  }
  const unreadable: string[] = [];
  const rows = readAuditShardEvents(projectDir, undefined, undefined, unreadable).filter((row) =>
    auditBlockField(row.block, "Stage") === CODE_GENERATION_STAGE &&
    auditBlockField(row.block, "Run floor") === batch.context.stageFloor &&
    !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:"),
  );
  const starts = rows.filter((row) => row.event === "SWARM_STARTED" &&
    auditBlockField(row.block, "Batch number") === String(batch.context.batch));
  const converged = swarmConvergedUnits(projectDir, CODE_GENERATION_STAGE);
  const completed = new Set(units.filter((unit) => {
    // Prepare stamps only successfully created worktrees. A retry can start
    // another subset of the same approved group, so select each member's
    // latest unambiguous start instead of requiring one whole-group row.
    const memberStarts = maximalAttemptEvents(starts.filter((row) =>
      auditBlockField(row.block, "Unit names")?.split(",").map((name) => name.trim()).includes(unit)));
    const start = memberStarts.length === 1 ? memberStarts[0] : null;
    const startedUnits = start
      ? auditBlockField(start.block, "Unit names")?.split(",").map((name) => name.trim()) : undefined;
    const completions = maximalAttemptEvents(rows.filter((row) => row.event === "SWARM_UNIT_CONVERGED" &&
      auditBlockField(row.block, "Unit name") === unit));
    return start !== null && startedUnits !== undefined && startedUnits.length > 0 &&
      new Set(startedUnits).size === startedUnits.length && startedUnits.every((name) => units.includes(name)) &&
      completions.length === 1 && converged.has(unit) &&
      auditBlockField(completions[0].block, "Batch number") === String(batch.context.batch) &&
      attemptEventDefinitelyBefore(start, completions[0]);
  }));
  if (unreadable.length) {
    throw new Error("Plan Approval batch successor audit evidence is unreadable");
  }
  if (!entireGroup) {
    // An engine resume omits only members whose native source has landed in
    // this attempt. Legacy convergence, inline completion and an arbitrary
    // subset cannot narrow the original protected approval.
    const merged = currentSwarmSourceMergeChain(projectDir, CODE_GENERATION_STAGE);
    const omitted = units.filter((unit) => !marker.units!.includes(unit));
    if (merged.state !== "ready" ||
      !omitted.every((unit) => completed.has(unit) && merged.units.has(unit)) ||
      (marker.kind === "invoke-swarm" && marker.units.some((unit) => converged.has(unit)))) {
      throw new Error("Plan Approval batch pending subset requires current native convergence and source landing for every omitted member");
    }
  }
  if (marker.kind === "run-stage" && completed.size !== units.length) {
    throw new Error("Plan Approval batch successor requires current, unambiguous swarm start and convergence evidence");
  }
  return marker;
}

function planApprovalBatchSelection(projectDir: string, file: string): PlanApprovalBatchSelection {
  const record = recordDir(projectDir);
  if (record === null) throw new Error("Cannot resolve the active intent record.");
  const path = recordFileTargetOrThrow(record, file);
  const contents = readRegularFileNoFollowOrThrow(path, "Plan Approval batch manifest", 64 * 1024).toString("utf-8");
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error("Plan Approval batch manifest is not valid JSON");
  }
  if (
    !value || typeof value !== "object" ||
    !("batch" in value) || typeof value.batch !== "string" ||
    !value.batch.trim() || value.batch !== value.batch.trim() || /[\r\n]/.test(value.batch) ||
    !("units" in value) || !Array.isArray(value.units) || value.units.length === 0
  ) {
    throw new Error('Plan Approval batch manifest requires {"batch":"<name>","units":[{"unit":"<slug>","questionsFile":"<path>"}]}');
  }
  const units = value.units.map((entry: unknown) => {
    if (
      !entry || typeof entry !== "object" ||
      !("unit" in entry) || typeof entry.unit !== "string" ||
      entry.unit !== entry.unit.trim() || validateUnitName(entry.unit) ||
      !("questionsFile" in entry) || typeof entry.questionsFile !== "string" || !entry.questionsFile.trim()
    ) throw new Error("Plan Approval batch members require a valid unit and questionsFile");
    return { unit: entry.unit, questionsFile: entry.questionsFile };
  }).sort((a, b) => a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0);
  if (new Set(units.map((entry) => entry.unit)).size !== units.length) {
    throw new Error("Plan Approval batch contains duplicate units");
  }
  return { batch: value.batch, units };
}

function assertLivePlanApprovalBatch(projectDir: string, units: string[]): void {
  const marker = readActiveDirectiveMarker(projectDir, readFileSync(stateFilePath(projectDir), "utf-8"));
  if (
    marker?.version !== 2 || marker.stage !== "code-generation" ||
    marker.kind !== "invoke-swarm" || !marker.units?.length ||
    new Set(marker.units).size !== marker.units.length ||
    units.length !== marker.units.length || new Set(units).size !== units.length ||
    !units.every((unit) => marker.units!.includes(unit))
  ) {
    throw new Error(`Plan Approval batch must contain exactly the live emitted Code Generation swarm units. ${PLAN_APPROVAL_BATCH_FALLBACK}`);
  }
  // This also proves each emitted unit still belongs to the authoritative DAG.
  for (const unit of units) resolveCodeGenerationAuthority(projectDir, { unit });
}

function planApprovalBatchMember(
  evidence: PlanApprovalQuestionEvidence,
): PlanApprovalBatchMember {
  const digest = (name: string, project: (content: string) => string): string => createHash("sha256")
    .update(project(readRegularFileNoFollowOrThrow(
      join(evidence.authority.stageDir, name), "Plan Approval batch artifact",
    ).toString("utf-8")))
    .digest("hex");
  return {
    ...runtimeIdentity(evidence),
    unit: evidence.authority.unit!,
    // Group and individual approval bind the same executable content. Progress
    // ticks and a terminal review appendix survive native record merge-back;
    // semantic edits still change the group, and instructions retain all text.
    planSha256: digest("code-generation-plan.md", projectPlanApprovalContent),
    instructionsSha256: digest("unit-test-instructions.md", projectInstructionsContent),
  };
}

function planApprovalBatchEvidence(
  projectDir: string,
  selection: PlanApprovalBatchSelection,
  choice: "" | "Approve Plan" | "Request Changes",
): { batch: PlanApprovalRuntimeBatch; evidence: PlanApprovalQuestionEvidence[] } {
  assertLivePlanApprovalBatch(projectDir, selection.units.map((entry) => entry.unit));
  const evidence = selection.units.map((entry) =>
    codeGenerationPlanApprovalQuestionEvidence(
      projectDir, { unit: entry.unit }, entry.questionsFile, choice, { batch: true },
    )
  );
  const members = evidence.map(planApprovalBatchMember);
  const context = planApprovalBatchContext(
    projectDir, selection.units.map((entry) => entry.unit), evidence[0].plannedSourceSha256,
  );
  const batch: BoundPlanApprovalBatch = {
    name: selection.batch, members, context,
    bindingSha256: hashObject({ name: selection.batch, members, context }),
  };
  return {
    batch,
    evidence,
  };
}

function assertBatchSession(projectDir: string, session: string): void {
  if (!session.trim()) throw new Error("Plan Approval batch requires a nonblank session");
  if (
    readPlanApprovalLegacyOffer(projectDir, session) ||
    readPlanApprovalLegacyWindow(projectDir, session) ||
    readPlanApprovalChallenge(projectDir, session)?.hashedOptionLabels
  ) {
    throw new Error(`Grouped Plan Approval does not support legacy protected-choice mediation. ${PLAN_APPROVAL_BATCH_FALLBACK}`);
  }
}

export function recordPlanApprovalBatchChallenge(
  projectDir: string,
  batchFile: string,
  session: string,
  record: (batch: PlanApprovalRuntimeBatch, evidence: PlanApprovalQuestionEvidence[]) => void,
): PlanApprovalRuntimeChallenge {
  return withActiveDirectiveLock(projectDir, () => {
    assertBatchSession(projectDir, session);
    const { batch, evidence } = planApprovalBatchEvidence(
      projectDir, planApprovalBatchSelection(projectDir, batchFile), "",
    );
    const options: [string, string] = ["Approve Plans", "Request Changes"];
    const challenge: PlanApprovalRuntimeChallenge = {
      version: 1,
      ...runtimeIdentity(evidence[0]),
      ...runtimeProvenance(evidence[0]),
      session,
      batch,
      challengeId: hashObject({ batch: batch.bindingSha256, session, options }),
      options,
      requireExactOptionLabels: true,
      hashedOptionLabels: false,
    };
    record(batch, evidence);
    // A repeated presentation of the exact reviewed set keeps the hook's
    // response, like its stable identity. A changed member rotates the id.
    if (readPlanApprovalChallenge(projectDir, session)?.challengeId !== challenge.challengeId) {
      writePlanApprovalChallenge(projectDir, challenge);
    }
    return challenge;
  });
}

export function recordPlanApprovalBatchReceipts(
  projectDir: string,
  batchFile: string,
  session: string,
  choice: "Approve Plan" | "Request Changes",
  record: (batch: PlanApprovalRuntimeBatch, evidence: PlanApprovalQuestionEvidence[]) => void,
): PlanApprovalRuntimeReceipt[] {
  return withActiveDirectiveLock(projectDir, () => {
    assertBatchSession(projectDir, session);
    const selection = planApprovalBatchSelection(projectDir, batchFile);
    const { batch, evidence } = planApprovalBatchEvidence(projectDir, selection, choice);
    const challenge = readPlanApprovalChallenge(projectDir, session);
    const response = readPlanApprovalResponse(projectDir, session);
    if (
      !challenge?.batch || challenge.batch.bindingSha256 !== batch.bindingSha256 ||
      !response || response.challengeId !== challenge.challengeId ||
      (response.choice !== undefined && response.choice !== choice)
    ) {
      throw new Error(
        "Plan Approval batch requires the person's reply to this prompt, in this session, for exactly these plans" +
          offeredChoiceNextStep(challenge, response, choice, {
            batch: true, samePlan: challenge?.batch?.bindingSha256 === batch.bindingSha256,
          }),
      );
    }
    const source = workspaceSourceState(projectDir);
    if (source === null) throw new PlanApprovalUnbindableError("recorded");
    if (evidence.some((entry) => !sameWorkspaceSource(entry.plannedSourceSha256, source.fingerprint))) {
      throw new Error("Plan Approval batch source changed; re-fingerprint and re-present every plan");
    }
    keepWorkspaceSourceSnapshot(projectDir, source);
    // Read every plan and the live set again before minting any authority.
    const verified = planApprovalBatchEvidence(projectDir, selection, choice);
    if (
      verified.batch.bindingSha256 !== batch.bindingSha256 ||
      workspaceSourceFingerprint(projectDir) !== source.fingerprint
    ) throw new Error("Plan Approval batch changed during certification; re-present every plan");
    const receipts: PlanApprovalRuntimeReceipt[] = choice === "Request Changes" ? [] : evidence.map((entry) => ({
      version: 1,
      ...runtimeIdentity(entry),
      ...runtimeProvenance(entry),
      session,
      batch,
      challengeId: challenge.challengeId,
      choice: "Approve Plan",
      questionsSha256: entry.questionsSha256,
      certifiedSourceSha256: source.fingerprint,
      status: "approved",
    }));
    commitPlanApprovalBatch(projectDir, challenge, receipts, () => record(batch, evidence));
    return receipts;
  });
}

function assertPlanApprovalBatchCurrent(projectDir: string, receipt: PlanApprovalRuntimeReceipt): void {
  const batch = receipt.batch as BoundPlanApprovalBatch;
  const marker = assertPlanApprovalBatchLifecycle(projectDir, receipt);
  const batchPeers = { units: batch.members.map((member) => member.unit), markerSha256: hashObject(marker) };
  const members = batch.members.map((member) => {
    const evidence = planApprovalQuestionEvidence(
      projectDir, codeGenerationAuthority(projectDir, { unit: member.unit }, batchPeers),
      member.questionsFile, "Approve Plan", { breakGlass: true },
    );
    const current = planApprovalBatchMember(evidence);
    const peer = readPlanApprovalReceipt(projectDir, current);
    if (
      !peer || !runtimeIdentityMatches(peer, current) ||
      peer.batch?.bindingSha256 !== batch.bindingSha256 ||
      peer.challengeId !== receipt.challengeId || peer.session !== receipt.session ||
      peer.choice !== "Approve Plan" || peer.override || peer.delegation ||
      peer.plannedSourceSha256 !== batch.context.sourceSha256
    ) throw new Error("Plan Approval batch has no complete set of matching protected receipts; re-present every plan");
    return current;
  });
  if (hashObject({ name: batch.name, members, context: batch.context }) !== batch.bindingSha256) {
    throw new Error("A reviewed Plan Approval batch member changed; re-present every plan");
  }
}

export function recordPlanApprovalChallenge(
  projectDir: string,
  evidence: PlanApprovalQuestionEvidence,
  session: string,
  options: [string, string] = ["Approve Plan", "Request Changes"],
  requireExactOptionLabels = false,
  hashOptionLabels = false,
  useLegacyDirectiveOffer = false,
  promptText?: string,
): PlanApprovalRuntimeChallenge {
  if (!session.trim()) {
    throw new Error("Plan Approval challenge requires a nonblank session");
  }
  const identity = runtimeIdentity(evidence);
  const provenance = runtimeProvenance(evidence);
  if (
    (hashOptionLabels || useLegacyDirectiveOffer) &&
    readPlanApprovalChallenge(projectDir, session)
  ) {
    throw new Error(
      "a protected legacy Plan Approval challenge is already pending for this session",
    );
  }
  const createChallenge = (): PlanApprovalRuntimeChallenge => {
    const offer = useLegacyDirectiveOffer
      ? readPlanApprovalLegacyOffer(projectDir, session)
      : null;
    if (
      useLegacyDirectiveOffer &&
      (
        !offer ||
        offer.intentId !== identity.intentId ||
        offer.markerRevision !== provenance.markerRevision ||
        !offer.allowedUnits.some((unit) => unit === evidence.authority.unit)
      )
    ) {
      throw new Error(
        "legacy Plan Approval requires protected choices from the invoking Code Generation directive",
      );
    }
    const effectiveHashedOptions = hashOptionLabels || useLegacyDirectiveOffer;
    const storedOptions: [string, string] = offer
      ? offer.options
      : hashOptionLabels
      ? options.map((option) =>
        createHash("sha256")
          .update(option.trim().toLowerCase(), "utf-8")
          .digest("hex")
      ) as [string, string]
      : options;
    const challenge: PlanApprovalRuntimeChallenge = {
      version: 1,
      ...identity,
      ...provenance,
      session,
      // The challenge id covers the compared identity, the session, and the exact
      // options offered. Provenance is deliberately outside it: a challenge that
      // rotated with every directive re-issue is the churn this change removes.
      challengeId: hashObject({
        ...identity,
        session,
        options: storedOptions,
        requireExactOptionLabels,
        hashedOptionLabels: effectiveHashedOptions,
        legacyDirectiveOffer: useLegacyDirectiveOffer,
      }),
      options: storedOptions,
      requireExactOptionLabels,
      hashedOptionLabels: effectiveHashedOptions,
      ...(promptText
        ? { promptDigest: createHash("sha256").update(promptText.trim(), "utf-8").digest("hex") }
        : {}),
    };
    writePlanApprovalChallenge(projectDir, challenge);
    if (useLegacyDirectiveOffer) {
      clearPlanApprovalLegacyOffer(projectDir, session);
    }
    return challenge;
  };
  return useLegacyDirectiveOffer
    ? withActiveDirectiveLock(projectDir, createChallenge)
    : createChallenge();
}

// The step that follows a refusal to record the conductor's choice.
function offeredChoiceNextStep(
  challenge: PlanApprovalRuntimeChallenge | null,
  response: PlanApprovalRuntimeResponse | null,
  choice: "Approve Plan" | "Request Changes",
  expected: { batch: boolean; samePlan: boolean },
): string {
  if (challenge && Boolean(challenge.batch) !== expected.batch) {
    return expected.batch
      ? ". The pending Plan Approval question is for a single plan, not this batch: present the batch question with `decision --batch-file` first."
      : ". The pending Plan Approval question is for a batch of plans: record it with `answer --batch-file`.";
  }
  if (challenge && !expected.samePlan) {
    return ". The pending question was presented for a different plan or attempt: re-run the fingerprint " +
      "command, record a fresh decision, and ask again.";
  }
  if (challenge && response?.challengeId === challenge.challengeId && response.choice !== undefined &&
    response.choice !== choice) {
    return `. The person picked "${response.choice}" for this question; record that choice instead, or ask them.`;
  }
  return ". The person has not replied to this question yet: end the turn, wait for their reply, then " +
    "record the choice they made.";
}

// The question a picker reply arrived under, as the harness reported it.
export interface PlanApprovalPickerQuestion {
  question: string | null;
  options: string[] | null;
  // A multi-select picker, or a reply carrying several picks.
  severalPicks: boolean;
}

// A picker reply answers the plan only when it was the recorded question,
// asked alone, as a single choice, with exactly the two recorded options in
// their recorded order.
function pickerAsksPlanApproval(
  challenge: PlanApprovalRuntimeChallenge,
  picker: PlanApprovalPickerQuestion,
): boolean {
  if (!picker.question || picker.severalPicks) return false;
  // A challenge recorded before prompt digests existed pairs on labels alone.
  if (
    challenge.promptDigest !== undefined &&
    createHash("sha256").update(picker.question.trim(), "utf-8").digest("hex") !== challenge.promptDigest
  ) return false;
  // In the recorded order: a reply of "1", "A", or "the first one" names the
  // first option shown, which must be Approve Plan.
  const offered = (picker.options ?? []).map((label) => stripRecommendedDecorator(label).toLowerCase());
  const recorded = challenge.options.map((label) => label.toLowerCase());
  return offered.length === 2 && offered[0] === recorded[0] && offered[1] === recorded[1];
}

export interface PlanApprovalHumanResponseResult {
  recorded: boolean;
}

export function recordPlanApprovalHumanResponse(
  projectDir: string,
  session: string,
  responseText: string,
  picker?: PlanApprovalPickerQuestion,
): PlanApprovalHumanResponseResult {
  return withAuditLock(projectDir, () => {
  // The hook keeps that the person replied to this question and their exact
  // words; the conductor reads them and records the choice they made. A picker
  // reply counts only when the picker asked this question.
  const challenge = readPlanApprovalChallenge(projectDir, session);
  const text = responseText.trim();
  if (challenge && text && !isNonAnswer(text) && !(picker && !pickerAsksPlanApproval(challenge, picker))) {
    const previous = readPlanApprovalResponse(projectDir, session);
    const earlier = previous?.challengeId === challenge.challengeId ? previous.words : undefined;
    const words = (earlier ? `${earlier}\n${text}` : text).slice(-PROTECTED_RESPONSE_WORDS_MAX_CHARS);
    // A reply that is exactly one offered option is the person's pick; a
    // record of the other choice is refused. Legacy nonce labels are hashed.
    const pick = challenge.hashedOptionLabels
      ? challenge.options.indexOf(
        createHash("sha256").update(stripRecommendedDecorator(text).toLowerCase(), "utf-8").digest("hex"),
      )
      : exactOptionPick(text, challenge.options);
    // Legacy nonce labels and grouped approval accept only an exact pick: the
    // picker is the only way those windows answer. Any other reply may still
    // be the legacy recovery choice below.
    const exactOnly = challenge.hashedOptionLabels || challenge.requireExactOptionLabels;
    if (!exactOnly || (pick !== null && pick >= 0)) {
      writePlanApprovalResponse(projectDir, {
        version: 1,
        session,
        challengeId: challenge.challengeId,
        ...(pick === 0 ? { choice: "Approve Plan" as const } : pick === 1 ? { choice: "Request Changes" as const } : {}),
        responseSha256: createHash("sha256").update(words, "utf-8").digest("hex"),
        words,
      });
      return { recorded: true };
    }
  }
  const recovery = readPlanApprovalLegacyRecoveryChallenge(
    projectDir,
    session,
  );
  if (
    recovery &&
    responseText.trim() === LEGACY_PLAN_APPROVAL_RECOVERY_CHOICE
  ) {
    writePlanApprovalLegacyRecoveryResponse(projectDir, {
      version: 1,
      session,
      challengeId: recovery.challengeId,
      responseSha256: createHash("sha256")
        .update(LEGACY_PLAN_APPROVAL_RECOVERY_CHOICE, "utf-8")
        .digest("hex"),
    });
    return { recorded: true };
  }
  return { recorded: false };
  });
}

// A picker reply answers the protected question when it is a single pick from
// a picker offering its choices (pickerOffersChoices), and the picker asked
// it: its recorded text, or, however the conductor worded it, a
// pick of one of those choices. Several picks are no one choice, whatever the
// question; a picker offering a different set, even under the recorded text,
// answers some other question.
function pickerAsksProtectedQuestion(
  question: ProtectedQuestion, questionText: string, picker: PlanApprovalPickerQuestion | undefined, picked: string,
): boolean {
  if (picker?.severalPicks) return false;
  if (picker?.options?.length && !pickerOffersChoices(picker.options, APPROVAL_GATE_CHOICES)) return false;
  if (createHash("sha256").update(questionText, "utf-8").digest("hex") === question.promptDigest) return true;
  if (!picker?.options?.length) return false;
  return isOneOfChoices(picked, APPROVAL_GATE_CHOICES);
}

// The person may answer a Unit or batch checkpoint question in any chat. With
// no question of its own in this chat, the checkpoint question another chat
// asked moves here, with any reply already kept for it, so this reply pairs
// with it and its approval needs no second answer. Only the newest question
// asked in any chat moves, while nothing has answered it: a reply never pairs
// with an older question, nor with one when another was asked after it.
function checkpointQuestionFromAnotherChat(projectDir: string, session: string): ProtectedQuestion | null {
  if (existsSync(join(projectDir, planApprovalChallengeRelativePath(projectDir, session)))) return null;
  const elsewhere = protectedQuestionsElsewhere(projectDir, session)
    .filter((question) => question.kind === "checkpoint-approval");
  if (elsewhere.length === 0) return null;
  const rows = sortAttemptEvents(readAuditShardEvents(projectDir).filter((row) => DECISION_PAIRING_EVENTS.has(row.event)));
  const at = rows.findLastIndex((row) => row.event === "DECISION_RECORDED");
  if (at === -1) return null;
  const asked = rows[at].block;
  const field = (name: string): string | null => auditBlockField(asked, name);
  if (rows.slice(at + 1).some((row) =>
    auditBlockField(row.block, "Stage") === field("Stage") && decisionAnsweredBy(asked, row.event, row.block))) {
    return null;
  }
  const askedAbout = (target: Record<string, unknown>): boolean => target.fingerprint === field("Fingerprint") &&
    (field("Checkpoint") === "Construction Unit Approval"
      ? target.kind === "unit" && target.unit === field("Unit") && target.checkpointKind === field("Kind")
      : field("Checkpoint") === "Swarm Batch Approval" && target.kind === "batch" &&
        String(target.batch) === field("Batch number"));
  const matching = elsewhere.filter((question) => askedAbout(question.target));
  const question = matching.find((candidate) =>
    readProtectedResponse(projectDir, candidate.session)?.challengeId === candidate.challengeId) ?? matching[0];
  return question ? moveProtectedQuestion(projectDir, question, session) : null;
}

// The person's reply to a construction policy, verification command, or
// Construction checkpoint question. The hook keeps that a person replied to
// this exact question and their words, verbatim; the conductor reads them and
// records the choice the person made. A picker reply counts only when the
// picker asked this question. Nothing is inferred from the words here.
export function recordProtectedHumanResponse(
  projectDir: string, session: string, responseText: string, questionText: string | null,
  picker?: PlanApprovalPickerQuestion,
): { recorded: boolean } {
  return withAuditLock(projectDir, () => {
    const text = responseText.trim();
    const question = readProtectedQuestion(projectDir, session) ??
      (text && !isNonAnswer(text) ? checkpointQuestionFromAnotherChat(projectDir, session) : null);
    if (!question) return { recorded: false };
    const picked = question.promptDigest !== undefined && questionText !== null;
    if (picked && !pickerAsksProtectedQuestion(question, questionText, picker, responseText)) {
      return { recorded: false };
    }
    if (!text || isNonAnswer(text)) return { recorded: false };
    const previous = readProtectedResponse(projectDir, session);
    const earlier = previous?.challengeId === question.challengeId ? previous.words : undefined;
    const words = (earlier ? `${earlier}\n${text}` : text).slice(-PROTECTED_RESPONSE_WORDS_MAX_CHARS);
    // A reply that is exactly one offered option is the person's pick, kept so
    // a record of the other choice is refused; any other reply is the
    // conductor's to read, and the latest reply decides. Every protected
    // question offers Approve and Request Changes (its stored options are
    // their digests).
    const pick = exactOptionPick(text, APPROVAL_GATE_CHOICES);
    markProtectedQuestionReplied(projectDir, question);
    writeProtectedResponse(projectDir, {
      version: 1, session, challengeId: question.challengeId,
      ...(pick === 0 ? { choice: "Approve" as const } : pick === 1 ? { choice: "Request Changes" as const } : {}),
      responseSha256: createHash("sha256").update(words, "utf-8").digest("hex"),
      words,
    });
    return { recorded: true };
  });
}

export interface PlanApprovalOverrideRequestResult {
  recorded: boolean;
}

/**
 * Half A of the break-glass pairing. Called by the human-turn hook ONLY for a
 * typed prompt (the UserPromptSubmit text), never for a picked option arriving
 * through a tool response. The whole trimmed prompt must be the single line
 * `Override Plan Approval: <reason>`; the reason is kept verbatim (trimmed) and
 * its sha256 is what `answer --override-file` (or `--override`) must match for the same session.
 */
export function recordPlanApprovalOverrideRequest(
  projectDir: string,
  session: string,
  promptText: string,
): PlanApprovalOverrideRequestResult {
  if (!session.trim()) return { recorded: false };
  const match = PLAN_APPROVAL_OVERRIDE_PHRASE_RE.exec(promptText.trim());
  if (!match) return { recorded: false };
  const reason = match[1].trim();
  if (!reason) return { recorded: false };
  const request: PlanApprovalOverrideRequest = {
    version: 1,
    session,
    reason,
    reasonSha256: planApprovalOverrideReasonSha256(reason),
    requestedAt: isoTimestamp(),
    intentId: activeIntentUuid(projectDir) ?? "bare-space",
  };
  writePlanApprovalOverrideRequest(projectDir, request);
  return { recorded: true };
}

export function planApprovalOverrideReasonSha256(reason: string): string {
  return createHash("sha256").update(reason.trim(), "utf-8").digest("hex");
}

export interface PlanApprovalReceiptResult {
  receipt: PlanApprovalRuntimeReceipt | null;
  /** Human lines for source drift accepted under `relaxed` while certifying. */
  changeNotices: string[];
}

// The one recovery for an answer that cannot pair with its prompt. The answer
// binds only in the session it arrives from, so the step is to offer the prompt
// again there; a conversation with no Runtime Session line gets one from a new
// chat. Harness-neutral: every harness starts a session with the entry skill.
export function planApprovalSessionRecovery(): string {
  return "Next: re-run the Plan Approval decision command with that --session value, present the Plan Approval " +
    "question, wait for the human's answer, then run the answer command with the same value. If this conversation " +
    "shows no `AIDLC Runtime Session:` line, ask the human to start a new chat session and run " +
    `${entrySkillInvocation()} to re-offer the Plan Approval question.`;
}

export function recordPlanApprovalReceipt(
  projectDir: string,
  evidence: PlanApprovalQuestionEvidence,
  session: string,
  choice: "Approve Plan" | "Request Changes",
): PlanApprovalReceiptResult {
  return withActiveDirectiveLock(projectDir, () =>
    certifyPlanApprovalReceipt(projectDir, evidence, session, choice),
  );
}

// The receipt path proper. Caller holds the active-directive lock (it is not
// reentrant), so the break-glass path can run this first and its own write
// second inside one transaction.
function certifyPlanApprovalReceipt(
  projectDir: string,
  evidence: PlanApprovalQuestionEvidence,
  session: string,
  choice: "Approve Plan" | "Request Changes",
): PlanApprovalReceiptResult {
  const identity = runtimeIdentity(evidence);
  const provenance = runtimeProvenance(evidence);
  const challenge = readPlanApprovalChallenge(projectDir, session);
  const response = readPlanApprovalResponse(projectDir, session);
  if (
    !challenge ||
    challenge.batch !== undefined ||
    !response ||
    challenge.challengeId !== response.challengeId ||
    (response.choice !== undefined && response.choice !== choice) ||
    !runtimeIdentityMatches(challenge, identity)
  ) {
    const samePlan = challenge !== null && runtimeIdentityMatches(challenge, identity);
    const unanswered = challenge !== null && !challenge.batch && samePlan &&
      response?.challengeId !== challenge.challengeId;
    let refusal = "Plan Approval requires the person's reply to this prompt, in this session" +
      (challenge
        ? offeredChoiceNextStep(challenge, response, choice, { batch: false, samePlan })
        : `; no prompt was recorded for session "${session}".`);
    // The answer binds only in the session it arrives from, so a missing prompt
    // or answer can mean the --session value is not this conversation's (a new
    // chat, a placeholder value). Asking again there would never pair.
    if (!challenge || unanswered) {
      if (unanswered) {
        refusal += " An answer is recorded only in the session it arrives from; if the human already chose " +
          `an option, "${session}" may not be this conversation's session.`;
      }
      refusal += ` ${runtimeSessionHint(projectDir)} ${planApprovalSessionRecovery()}`;
    }
    throw new Error(refusal);
  }
  const receiptBarrier =
    process.env.AIDLC_TEST_PLAN_APPROVAL_RECEIPT_BARRIER?.trim();
  if (receiptBarrier) {
    writeFileSync(`${receiptBarrier}.snapshotted`, "snapshotted\n", "utf-8");
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + DEFAULT_SUBPROCESS_TIMEOUT_MS;
    while (!existsSync(`${receiptBarrier}.release`)) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting at Plan Approval receipt barrier");
      }
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
  if (choice === "Request Changes") {
    // Requesting changes withdraws the decision, so it clears BOTH halves: the
    // challenge AND any receipt for this exact identity. Without the second
    // clear, identical content could be re-approved by rewriting the answer tag,
    // because nothing else about the identity had moved. A typed break-glass
    // request is withdrawn with it.
    clearPlanApprovalChallenge(projectDir, session);
    clearPlanApprovalReceipt(projectDir, identity);
    clearPlanApprovalOverrideRequest(projectDir, session);
    return { receipt: null, changeNotices: [] };
  }
  // Certify the source twice, then write. The answer path never unlinks a
  // receipt it just wrote: a mutation that lands between the two reads is
  // refused before anything exists on disk, and one that lands after the
  // second read is caught by generation start, which keeps the receipt and
  // asks for re-approval. Source that moved since the plan was fingerprinted
  // is the governed drift: strict refuses, relaxed records the change and
  // certifies the source found now, which every later check compares against.
  const stateBefore = workspaceSourceState(projectDir);
  const sourceBefore = stateBefore?.fingerprint ?? null;
  if (sourceBefore === null) {
    throw new PlanApprovalUnbindableError("recorded");
  }
  const changeNotices: string[] = [];
  if (!sameWorkspaceSource(evidence.plannedSourceSha256, sourceBefore)) {
    const judged = judgePlanSourceDrift(
      projectDir,
      evidence.authority.unit,
      evidence.plannedSourceSha256,
      stateBefore,
      true,
    );
    if ("refusal" in judged) throw judged.refusal;
    changeNotices.push(...recordAcceptedChanges(projectDir, [judged.accepted]));
  }
  const sourceAfter = workspaceSourceFingerprint(projectDir);
  if (sourceAfter === null || sourceAfter !== sourceBefore) {
    throw new Error(
      "Plan Approval source changed during receipt certification. " +
        "Re-run the fingerprint command and re-present the plan.",
    );
  }
  const receipt: PlanApprovalRuntimeReceipt = {
    version: 1,
    ...identity,
    ...provenance,
    session,
    challengeId: challenge.challengeId,
    choice: "Approve Plan",
    questionsSha256: evidence.questionsSha256,
    certifiedSourceSha256: sourceBefore,
    status: "approved",
  };
  writePlanApprovalReceipt(projectDir, receipt);
  keepApprovedPlanCopy(projectDir, evidence.authority, evidence.fingerprint, readFileSync(evidence.questionsPath, "utf-8"));
  keepWorkspaceSourceSnapshot(projectDir, stateBefore);
  clearPlanApprovalChallenge(projectDir, session);
  // A normal receipt spends any typed break-glass request too: the phrase
  // authorized at most one run, and that run needed no override.
  clearPlanApprovalOverrideRequest(projectDir, session);
  // Sweep this target's receipts from attempts that have ended. Nothing deletes a
  // receipt to invalidate it any more, so the store is tidied here instead.
  collectStalePlanApprovalReceipts(
    projectDir,
    identity.intentId,
    identity.targetId,
    identity.runFloor,
  );
  return { receipt, changeNotices };
}

export interface PlanApprovalOverrideReceiptResult {
  receipt: PlanApprovalRuntimeReceipt;
  /** False when the normal path succeeded and no override was written. */
  overridden: boolean;
  failedChecks: string[];
  changeNotices: string[];
}

export class PlanApprovalOverrideHumanOnlyError extends Error {
  constructor() {
    super(PLAN_APPROVAL_OVERRIDE_HUMAN_ONLY);
    this.name = "PlanApprovalOverrideHumanOnlyError";
  }
}

/**
 * The typed request that authorizes `answer --override-file` for this session and
 * reason, or null. Half A must have written it (the human typed the phrase),
 * its digest must be the digest of the reason given now, its stored reason must
 * hash to its own stored digest (an edited file is not a request), and, once
 * the evidence names the intent, it must have been typed under that intent.
 */
export function authorizingPlanApprovalOverrideRequest(
  projectDir: string,
  session: string,
  reason: string,
  intentId: string | null,
): PlanApprovalOverrideRequest | null {
  const request = readPlanApprovalOverrideRequest(projectDir, session);
  if (request === null) return null;
  const expected = planApprovalOverrideReasonSha256(reason);
  if (request.reasonSha256 !== expected) return null;
  if (planApprovalOverrideReasonSha256(request.reason) !== expected) return null;
  if (intentId !== null && request.intentId !== intentId) return null;
  return request;
}

/**
 * Half B of the break-glass pairing. The normal receipt path runs first; when
 * it succeeds there was nothing to override and its receipt stands. When it
 * refuses, its refusal (plus the source-boundary state when the workspace
 * cannot be bound) is kept as the failed checks, the typed request is
 * re-validated and consumed inside this same transaction (a request that
 * vanished or changed since the caller's precheck is not a request), then
 * `recordOverride` is called so the ledger row lands FIRST, and only then is a
 * receipt bound to content and attempt only written: no challenge/response
 * pairing and no source certification. A row that cannot be appended leaves no
 * receipt and spends no request, so the human's phrase is still there for the
 * retry. The certified source is whatever binds now, or `unbindable`;
 * downstream checks skip the source comparison for an override receipt.
 */
export function recordPlanApprovalOverrideReceipt(
  projectDir: string,
  evidence: PlanApprovalQuestionEvidence,
  session: string,
  reason: string,
  recordOverride: (failedChecks: readonly string[]) => void,
): PlanApprovalOverrideReceiptResult {
  return withActiveDirectiveLock(projectDir, () => {
    if (
      authorizingPlanApprovalOverrideRequest(
        projectDir,
        session,
        reason,
        evidence.authority.intentId,
      ) === null
    ) {
      throw new PlanApprovalOverrideHumanOnlyError();
    }
    const failedChecks: string[] = [];
    try {
      const normal = certifyPlanApprovalReceipt(projectDir, evidence, session, "Approve Plan");
      if (normal.receipt !== null) {
        return {
          receipt: normal.receipt,
          overridden: false,
          failedChecks,
          changeNotices: normal.changeNotices,
        };
      }
      failedChecks.push("the normal receipt path recorded nothing");
    } catch (error) {
      failedChecks.push(error instanceof Error ? error.message : String(error));
    }
    const current = workspaceSourceState(projectDir);
    if (current === null) {
      failedChecks.push(`workspace source cannot be bound${workspaceSourceFailureSuffix()}`);
    }
    const identity = runtimeIdentity(evidence);
    const challenge = readPlanApprovalChallenge(projectDir, session);
    const receipt: PlanApprovalRuntimeReceipt = {
      version: 1,
      ...identity,
      ...runtimeProvenance(evidence),
      session,
      challengeId: challenge?.challengeId ?? "",
      choice: "Approve Plan",
      questionsSha256: evidence.questionsSha256,
      certifiedSourceSha256: current?.fingerprint ?? UNBINDABLE_FINGERPRINT,
      status: "approved",
      override: { reason, failedChecks: [...failedChecks] },
    };
    recordOverride(failedChecks);
    writePlanApprovalReceipt(projectDir, receipt);
    keepWorkspaceSourceSnapshot(projectDir, current);
    clearPlanApprovalChallenge(projectDir, session);
    clearPlanApprovalOverrideRequest(projectDir, session);
    collectStalePlanApprovalReceipts(
      projectDir,
      identity.intentId,
      identity.targetId,
      identity.runFloor,
    );
    return { receipt, overridden: true, failedChecks, changeNotices: [] };
  });
}

export interface PlanApprovalEvidenceOptions {
  /**
   * Break-glass evidence binds to content and attempt only: the `[Planned
   * Source]` tag is read for provenance but never compared, so an unbindable or
   * moved workspace does not refuse the override. Every content check (plan,
   * instructions, Testing Contract, fingerprint, `[Answer]`) still applies.
   */
  breakGlass?: boolean;
  /** Group validation must not re-baseline one member before validating others. */
  batch?: boolean;
}

export function codeGenerationPlanApprovalQuestionEvidence(
  projectDir: string,
  target: CodeGenerationTarget,
  suppliedQuestionsFile: string,
  expectedAnswer: "" | "Approve Plan" | "Request Changes",
  options: PlanApprovalEvidenceOptions = {},
): PlanApprovalQuestionEvidence {
  const authority = resolveCodeGenerationAuthority(projectDir, target);
  return planApprovalQuestionEvidence(projectDir, authority, suppliedQuestionsFile, expectedAnswer, options);
}

function planApprovalQuestionEvidence(
  projectDir: string,
  authority: CodeGenerationAuthority,
  suppliedQuestionsFile: string,
  expectedAnswer: "" | "Approve Plan" | "Request Changes",
  options: PlanApprovalEvidenceOptions,
): PlanApprovalQuestionEvidence {
  const expectedPath = resolve(
    authority.stageDir,
    "code-generation-questions.md",
  );
  const suppliedPath = isAbsolute(suppliedQuestionsFile)
    ? resolve(suppliedQuestionsFile)
    : resolve(projectDir, suppliedQuestionsFile);
  if (suppliedPath !== expectedPath) {
    throw new Error(
      `Plan Approval questions file must be the active target's canonical file: ${toPosix(relative(projectDir, expectedPath))}`,
    );
  }
  const artifacts = codeGenerationApprovalArtifacts(projectDir, authority);
  if (!artifacts.planExists || !artifacts.instructionsExist) {
    throw new Error("Plan Approval requires non-empty plan and unit-test instructions");
  }
  if (!artifacts.contractValid || artifacts.expectedFingerprint === null) {
    throw new Error(
      `Plan Approval requires the current Testing Contract: ${testingContractDefectReason(artifacts.plan) ??
        "the embedded contract is stale because memory, scope, test strategy, project type, or the installed AIDLC version changed. " +
          `Run \`${aidlcToolInvocation("testing-posture")} render\`, replace the whole \`${CONTRACT_HEADING}\` section ` +
          "with its output, then re-run the fingerprint command."}`,
    );
  }
  if (artifacts.recordedFingerprint !== artifacts.expectedFingerprint) {
    throw new Error(
      artifacts.recordedFingerprint === null
        ? `Plan Approval found no recorded fingerprint: ${missingPlanApprovalFingerprintReason(artifacts.questions)}`
        : !approvalFingerprintIsCurrentFormat(artifacts.recordedFingerprint)
        ? "The recorded Plan Approval fingerprint was written under an earlier format. " +
            "Re-run the fingerprint command, re-present the plan, and approve again."
        : "Plan Approval fingerprint does not match the active intent, target, stage attempt, plan, instructions, and Testing Contract. " +
            "Re-run the fingerprint command, re-present the plan, and approve again.",
    );
  }
  const latest = latestPlanApproval(artifacts.questions);
  if (!latest.found || latest.answer === null || latest.answer !== expectedAnswer) {
    throw new Error(
      `Plan Approval questions file must contain exactly [Answer]: ${expectedAnswer || "(blank)"}`,
    );
  }
  // The source the plan was written against, recorded by the fingerprint command.
  // The approval binds to THIS value rather than to the directive's sticky floor,
  // so drift is always answerable by re-fingerprinting and re-presenting; the
  // sticky floor could only be rotated by a receipt that required the floor to
  // match already, which is the loop that made an out-of-band `git pull` permanent.
  const plannedSource = latest.plannedSource ?? UNBINDABLE_FINGERPRINT;
  if (latest.plannedSource === null && !options.breakGlass) {
    throw new Error(
      "Plan Approval requires a [Planned Source]: tag in the Plan Approval section. " +
        "Re-run the fingerprint command, record both tags it prints, and re-present the plan.",
    );
  }
  // A workspace that cannot be bound now is refused before anything is minted:
  // the challenge such a decision would create can never be accepted by the
  // normal receipt path, so the human would approve into a dead end. A planned
  // source recorded as `unbindable` while the workspace binds now is treated
  // as drift from that recording: strict asks for a re-fingerprint (which now
  // records a real source), relaxed re-baselines the tag before the challenge.
  const currentState = options.breakGlass ? null : workspaceSourceState(projectDir);
  const currentSource = currentState?.fingerprint ?? null;
  if (!options.breakGlass && currentSource === null) {
    throw new PlanApprovalUnbindableError(expectedAnswer === "" ? "presented" : "recorded");
  }
  let questions = artifacts.questions;
  let boundSource = plannedSource;
  const changeNotices: string[] = [];
  if (!options.breakGlass && !sameWorkspaceSource(plannedSource, currentSource)) {
    if (options.batch) {
      throw new Error(`Plan Approval batch source changed; re-fingerprint and re-present every plan. ${PLAN_APPROVAL_BATCH_FALLBACK}`);
    }
    const judged = judgePlanSourceDrift(projectDir, authority.unit, plannedSource, currentState, true);
    if ("refusal" in judged) throw judged.refusal;
    // The row is written BEFORE anything is re-baselined: a ledger that cannot
    // take it refuses here, with the drift still visible to the next attempt.
    changeNotices.push(...recordAcceptedChanges(projectDir, [judged.accepted]));
    // Before the challenge is minted (the decision record) the questions file
    // is still the conductor's draft, so the tag itself is re-baselined and the
    // human sees the plan against the source it will be approved on. At the
    // answer the prompt hash already binds these bytes; the receipt certifies
    // the current source instead, and that certified value is the baseline
    // every later check compares against.
    if (expectedAnswer === "" && currentSource !== null) {
      questions = upsertPlannedSourceTag(questions, currentSource);
      writeFileSync(suppliedPath, questions, "utf-8");
      keepWorkspaceSourceSnapshot(projectDir, currentState);
      boundSource = currentSource;
    }
  }
  return {
    authority,
    fingerprint: artifacts.expectedFingerprint,
    questionsPath: suppliedPath,
    questionsRelativePath: toPosix(relative(projectDir, suppliedPath)),
    questionsSha256: createHash("sha256")
      .update(questions, "utf-8")
      .digest("hex"),
    promptSha256: createHash("sha256")
      .update(
        `${questions
          .replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:")
          .trimEnd()}\n`,
        "utf-8",
      )
      .digest("hex"),
    plannedSourceSha256: boundSource,
    changeNotices,
  };
}

function worktreeApprovalGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: DEFAULT_SUBPROCESS_TIMEOUT_MS });
  if (result.status !== 0) {
    throw new Error(`Worktree approval Git operation refused: ${result.stderr.trim() || args.join(" ")}`);
  }
  return result.stdout.trim();
}

function approvalPathKey(path: string): string {
  const canonical = realpathSync(path).replaceAll("\\", "/");
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function approvalWorktreeProvenance(parentDir: string, childDir: string, unit: string) {
  const parent = realpathSync(parentDir);
  const child = realpathSync(childDir);
  const slug = boltSlugForUnit(unit);
  const selection = resolveWorkflowSelection(parent);
  const identity = resolveBoltIdentity(parent, slug, selection);
  if (parent === child || approvalPathKey(identity.dir) !== approvalPathKey(child)) {
    throw new Error("Approval delegation requires the parent's canonical Unit worktree.");
  }
  assertNoSymlinkInChainOrThrow(parent, relative(parent, childDir));
  const metaPath = join(child, ".aidlc", "worktree-meta.json");
  assertNoSymlinkInChainOrThrow(child, relative(child, metaPath));
  const meta = JSON.parse(readRegularFileNoFollowOrThrow(metaPath, "worktree approval provenance").toString("utf-8"));
  if (!meta || typeof meta !== "object" || meta.version !== 1 ||
    meta.boltSlug !== slug || meta.swarmUnit !== unit || meta.swarmStage !== CODE_GENERATION_STAGE ||
    typeof meta.baseCommit !== "string" || !/^[0-9a-f]{40,64}$/.test(meta.baseCommit) ||
    typeof meta.swarmBatch !== "string" || !/^[1-9][0-9]*$/.test(meta.swarmBatch) ||
    meta.intentRecord !== relativeRecordDir(parent) ||
    (meta.repoSelector !== null && typeof meta.repoSelector !== "string")) {
    throw new Error("Worktree approval provenance does not match the parent intent and Unit.");
  }
  const dag = resolveBoltDag(parent);
  if (dag.state !== "ok" || !dag.batches[Number(meta.swarmBatch) - 1]?.includes(unit)) {
    throw new Error("Worktree approval batch does not match the authoritative Unit DAG.");
  }
  const repo = resolveConstructionRepo(parent, meta.repoSelector ?? undefined);
  const unreadable: string[] = [];
  const creations = maximalAttemptEvents(readAuditShardEvents(parent, undefined, undefined, unreadable).filter(
    (row) => row.event === "WORKTREE_CREATED" && auditBlockField(row.block, "Bolt slug") === slug,
  ));
  const creation = creations.length === 1 ? creations[0] : null;
  if (unreadable.length || !creation) throw new Error("Worktree creation authority is unavailable or ambiguous.");
  const common = approvalPathKey(resolve(repo.cwd, worktreeApprovalGit(repo.cwd, ["rev-parse", "--git-common-dir"])));
  const childCommon = approvalPathKey(resolve(child, worktreeApprovalGit(child, ["rev-parse", "--git-common-dir"])));
  const commonHash = createHash("sha256").update(common).digest("hex");
  const recordedPath = auditBlockField(creation.block, "Worktree path");
  const floor = latestMainWorkflowStageRunFloorForProject(parent, CODE_GENERATION_STAGE);
  if (!recordedPath || approvalPathKey(resolveAuditWorktreePath(parent, recordedPath)) !== approvalPathKey(child) ||
    approvalPathKey(worktreeApprovalGit(child, ["rev-parse", "--show-toplevel"])) !== approvalPathKey(child) ||
    worktreeApprovalGit(child, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/${identity.branch}` ||
    common !== childCommon || repo.repo !== meta.repoSelector ||
    (meta.gitCommonDirHash !== commonHash &&
      (typeof meta.gitCommonDir !== "string" || approvalPathKey(meta.gitCommonDir) !== common)) ||
    meta.swarmFloor !== floor ||
    auditBlockField(creation.block, "Branch name") !== identity.branch ||
    auditBlockField(creation.block, "Intent record") !== meta.intentRecord ||
    auditBlockField(creation.block, "Repo") !== (repo.repo ?? "-") ||
    auditBlockField(creation.block, "Swarm Unit") !== unit ||
    auditBlockField(creation.block, "Swarm Batch") !== meta.swarmBatch ||
    auditBlockField(creation.block, "Swarm Stage") !== meta.swarmStage ||
    auditBlockField(creation.block, "Swarm Run floor") !== meta.swarmFloor ||
    auditBlockField(creation.block, "Base commit") !== meta.baseCommit ||
    auditBlockField(creation.block, "Base Source Listing") !== meta.baseSourceListing) {
    throw new Error("Worktree approval delegation does not match immutable creation authority or the current attempt.");
  }
  const basePath = join(child, ".aidlc", "base-source-listing.tsv");
  assertNoSymlinkInChainOrThrow(child, relative(child, basePath));
  const base = readRegularFileNoFollowOrThrow(basePath, "worktree base source listing").toString("utf-8");
  if (`sha256:${sourceListingSha256(base)}` !== meta.baseSourceListing || parseSourceListing(base) === null) {
    throw new Error("Worktree immutable base source listing is invalid.");
  }
  worktreeApprovalGit(child, ["cat-file", "-e", `${meta.baseCommit}^{commit}`]);
  const delegated = delegatedWorktreeIntent(child);
  if (delegated && approvalPathKey(delegated.parent) !== approvalPathKey(parent)) {
    throw new Error("Worktree intent belongs to a different approval parent");
  }
  const intentUuid = delegated?.intentUuid ?? activeIntentUuid(child);
  return { parent, child, repo, intentUuid, hash: hashObject(creation.block) };
}

function parentWorktreeApproval(parentDir: string, unit: string) {
  const approval = evaluateCodeGenerationApproval(parentDir, { unit });
  const continuation = approval.ok ? null : codeGenerationContinuation(parentDir, { unit });
  if (continuation && !continuation.receipt.delegation && !continuation.receipt.override) {
    const { authority, artifacts, receipt } = continuation;
    const evidence: PlanApprovalQuestionEvidence = {
      authority,
      fingerprint: receipt.fingerprint,
      questionsPath: artifacts.questionsPath,
      questionsRelativePath: receipt.questionsFile,
      questionsSha256: createHash("sha256").update(artifacts.questions, "utf-8").digest("hex"),
      promptSha256: receipt.promptSha256,
      plannedSourceSha256: questionsFilePlannedSource(artifacts.questions) ?? UNBINDABLE_FINGERPRINT,
      changeNotices: [],
    };
    return { evidence, receipt, continuing: true };
  }
  const evidence = codeGenerationPlanApprovalQuestionEvidence(
    parentDir, { unit }, join(codeGenerationRecordDir(parentDir, unit), "code-generation-questions.md"),
    "Approve Plan", { breakGlass: true },
  );
  const receipt = readPlanApprovalReceipt(parentDir, runtimeIdentity(evidence));
  if (!receipt || receipt.delegation || receipt.override) {
    throw new Error("Worktree execution requires an ordinary protected parent Plan Approval; chained delegation and overrides cannot certify its source.");
  }
  if (!approval.ok) throw new Error(`Parent Plan Approval is not current: ${approval.reason}`);
  return { evidence, receipt, continuing: false };
}

/**
 * Capture optional recovery evidence before native discard removes the child.
 * A missing/invalid approval never prevents the human from discarding work.
 */
export function captureCodeGenerationDiscardApproval(
  parentDir: string, childDir: string, unit: string,
): Record<string, string> | null {
  try {
    const authority = resolveCodeGenerationAuthority(childDir, { unit });
    const approval = evaluateCodeGenerationApproval(childDir, { unit });
    if (!approval.ok || !approval.approvalFingerprint) return null;
    const receipt = readPlanApprovalReceipt(childDir, {
      targetId: authority.targetId, runFloor: authority.runFloor, fingerprint: approval.approvalFingerprint,
    });
    const origin = receipt?.delegation;
    if (!receipt || !origin?.baselineCommit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(origin.baselineCommit)) return null;
    const validatedParent = validateWorktreeDelegation(childDir, authority, receipt);
    if (approvalPathKey(validatedParent) !== approvalPathKey(parentDir)) return null;
    const provenance = approvalWorktreeProvenance(parentDir, childDir, unit);
    const baseline = readBaselineSourceSnapshot(childDir, CODE_GENERATION_STAGE, origin.baselineSha256);
    const committed = gitCommitSourceListing(provenance.repo.cwd, origin.baselineCommit, provenance.repo.repo === null);
    if (!baseline || !committed ||
      serializeSourceListing(baseline) !== serializeSourceListing(committed) ||
      `sha256:${sourceListingSha256(serializeSourceListing(committed))}` !== origin.baselineSha256) return null;
    return {
      "Approval Source Commit": origin.baselineCommit,
      "Approval Source Listing": origin.baselineSha256,
      "Approval Parent Receipt": origin.parentReceiptSha256,
      "Approval Creation": origin.provenanceSha256,
    };
  } catch {
    return null;
  }
}

interface DiscardedWorktreeApproval {
  commit: string;
  listingSha256: string;
  expectedBytes: string;
  parentReceiptSha256: string;
  discardSha256: string;
}

function discardedWorktreeApproval(
  parentDir: string, unit: string, repoCwd: string, repoName: string | null, discardSha256: string,
): DiscardedWorktreeApproval | null {
  try {
    if (!/^[0-9a-f]{64}$/.test(discardSha256) || validateUnitName(unit)) return null;
    const parent = realpathSync(parentDir);
    const repo = resolveConstructionRepo(parent, repoName ?? undefined);
    if (repo.repo !== repoName || approvalPathKey(repo.cwd) !== approvalPathKey(repoCwd)) return null;
    const slug = boltSlugForUnit(unit);
    const selection = resolveWorkflowSelection(parent);
    const identity = resolveBoltIdentity(parent, slug, selection);
    const slot = identity.dir;
    assertNoSymlinkInChainOrThrow(parent, relative(parent, slot));
    // Discard has removed the final path component. Resolve the existing
    // parent and reject symlink chains instead of realpath-ing the absent slot.
    const pathKey = (path: string): string => {
      const key = resolve(path).replaceAll("\\", "/");
      return process.platform === "win32" ? key.toLowerCase() : key;
    };
    const slotKey = pathKey(slot);
    const legacySlotKey = pathKey(legacyWorktreePath(parent, slug));
    const namesSlot = (row: AuditShardEvent): boolean => {
      const recorded = auditBlockField(row.block, "Worktree path");
      if (!recorded) return false;
      const resolved = resolveAuditWorktreePath(parent, recorded);
      assertNoSymlinkInChainOrThrow(parent, relative(parent, resolved));
      // A Bolt discarded under its legacy name can be re-created namespaced;
      // only these two slots in this checkout may share that recovery evidence.
      const key = pathKey(resolved);
      return key === slotKey || key === legacySlotKey;
    };
    const unreadable: string[] = [];
    const rows = readAuditShardEvents(parent, undefined, undefined, unreadable);
    if (unreadable.length) return null;
    const discards = rows.filter((row) => row.event === "WORKTREE_DISCARDED" &&
      auditBlockField(row.block, "Bolt slug") === slug);
    const matches = discards.filter((row) =>
      createHash("sha256").update(row.block, "utf-8").digest("hex") === discardSha256);
    const latestDiscards = maximalAttemptEvents(discards);
    if (matches.length !== 1 || latestDiscards.length !== 1 || latestDiscards[0] !== matches[0]) return null;
    const discard = matches[0];
    if (!namesSlot(discard) || auditBlockField(discard.block, "Reason") !== "agent-discard") return null;
    const approved = parentWorktreeApproval(parent, unit);
    if (approved.receipt.status !== "generation") return null;
    const dag = resolveBoltDag(parent);
    const intentRecord = relativeRecordDir(parent);
    const floor = latestMainWorkflowStageRunFloorForProject(parent, CODE_GENERATION_STAGE);
    if (dag.state !== "ok" || !intentRecord || floor.startsWith("AMBIGUOUS:")) return null;
    const matchesCreation = (row: AuditShardEvent): boolean => {
      const batch = auditBlockField(row.block, "Swarm Batch");
      const recordedPath = auditBlockField(row.block, "Worktree path");
      const branch = recordedPath && pathKey(resolveAuditWorktreePath(parent, recordedPath)) === legacySlotKey
        ? legacyBoltName(slug)
        : identity.branch;
      return namesSlot(row) &&
        auditBlockField(row.block, "Branch name") === branch &&
        auditBlockField(row.block, "Intent record") === intentRecord &&
        auditBlockField(row.block, "Repo") === (repoName ?? "-") &&
        auditBlockField(row.block, "Swarm Unit") === unit &&
        auditBlockField(row.block, "Swarm Stage") === CODE_GENERATION_STAGE &&
        auditBlockField(row.block, "Swarm Run floor") === floor &&
        batch !== null && /^[1-9][0-9]*$/.test(batch) && !!dag.batches[Number(batch) - 1]?.includes(unit) &&
        /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(auditBlockField(row.block, "Base commit") ?? "") &&
        /^sha256:[0-9a-f]{64}$/.test(auditBlockField(row.block, "Base Source Listing") ?? "");
    };
    const creations = rows.filter((row) => row.event === "WORKTREE_CREATED" &&
      auditBlockField(row.block, "Bolt slug") === slug);
    const beforeDiscard = maximalAttemptEvents(creations.filter((row) => attemptEventDefinitelyBefore(row, discard)));
    if (beforeDiscard.length !== 1 || !matchesCreation(beforeDiscard[0])) return null;
    const original = beforeDiscard[0];
    // Audit is emitted before teardown. A cleanup retry may follow successful
    // directory removal and therefore have no approval fields to capture. Keep
    // the selected discard as the physical boundary, and obtain its source
    // witness only within this same creation's discard interval.
    const approvalFields = [
      "Approval Source Commit", "Approval Source Listing", "Approval Parent Receipt", "Approval Creation",
    ];
    const witnesses = maximalAttemptEvents(discards.filter((row) =>
      attemptEventDefinitelyBefore(original, row) &&
      (row === discard || attemptEventDefinitelyBefore(row, discard)) &&
      namesSlot(row) && auditBlockField(row.block, "Reason") === "agent-discard" &&
      approvalFields.some((field) => auditBlockField(row.block, field) !== null)));
    if (witnesses.length !== 1) return null;
    const witness = witnesses[0];
    const commit = auditBlockField(witness.block, "Approval Source Commit");
    const listingSha256 = auditBlockField(witness.block, "Approval Source Listing");
    const parentReceiptSha256 = auditBlockField(witness.block, "Approval Parent Receipt");
    if (!commit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit) ||
      !listingSha256 || !/^sha256:[0-9a-f]{64}$/.test(listingSha256) ||
      auditBlockField(witness.block, "Approval Creation") !== hashObject(original.block) ||
      !parentReceiptSha256 || parentReceiptSha256 !== hashObject(approved.receipt)) return null;
    const subsequent = creations.filter((row) => !attemptEventDefinitelyBefore(row, discard));
    const latestCreations = maximalAttemptEvents(creations);
    if (latestCreations.length !== 1) return null;
    if (!existsSync(slot)) {
      // Preflight may use only the creation actually ended by this discard.
      if (subsequent.length !== 0 || latestCreations[0] !== original) return null;
    } else {
      // Bind may see exactly one new native creation. An old discard cannot
      // certify another later recreation, even if its source happens to match.
      if (subsequent.length !== 1 || latestCreations[0] !== subsequent[0] ||
        !attemptEventDefinitelyBefore(discard, subsequent[0]) || !matchesCreation(subsequent[0]) ||
        auditBlockField(subsequent[0].block, "Swarm Batch") !== auditBlockField(original.block, "Swarm Batch") ||
        auditBlockField(subsequent[0].block, "Base commit") !== commit ||
        auditBlockField(subsequent[0].block, "Base Source Listing") !== listingSha256) return null;
      const current = approvalWorktreeProvenance(parent, slot, unit);
      if (current.hash !== hashObject(subsequent[0].block) || current.repo.repo !== repoName ||
        approvalPathKey(current.repo.cwd) !== approvalPathKey(repoCwd)) return null;
    }
    const committed = gitCommitSourceListing(repo.cwd, commit, repo.repo === null);
    if (!committed) return null;
    const expectedBytes = serializeSourceListing(committed);
    if (`sha256:${sourceListingSha256(expectedBytes)}` !== listingSha256) return null;
    return { commit, listingSha256, expectedBytes, parentReceiptSha256, discardSha256 };
  } catch {
    return null;
  }
}

/** Read-only, optional immutable base for a verified explicit-discard recovery. */
export function codeGenerationDiscardedBase(
  parentDir: string, unit: string, repoCwd: string, repoName: string | null, discardSha256: string,
): string | null {
  return discardedWorktreeApproval(parentDir, unit, repoCwd, repoName, discardSha256)?.commit ?? null;
}

function approvedWorktreeSource(
  parent: string,
  approved: ReturnType<typeof parentWorktreeApproval>,
  repo: ReturnType<typeof resolveConstructionRepo>,
  discarded: DiscardedWorktreeApproval | null = null,
) {
  const parentSource = workspaceSourceState(parent);
  if (discarded) {
    if (!parentSource || hashObject(approved.receipt) !== discarded.parentReceiptSha256) {
      throw new Error("Discarded worktree Plan Approval changed or current parent source cannot be bound.");
    }
    return { parentSource, expectedBytes: discarded.expectedBytes };
  }
  // Worktrees are made from the parent's files, so they must be readable even
  // when a single-checkout build could go ahead without that record.
  if (!parentSource) throw new Error(generationSourceUnavailableMessage());
  // Under a relaxed or off Guard Policy, parent source that moved after Plan
  // Approval is kept, as on the single-agent path: generation start records it
  // and says it in one line.
  if (
    !approved.continuing &&
    !sameWorkspaceSource(approved.receipt.certifiedSourceSha256, parentSource.fingerprint) &&
    !guardPolicyAcceptsChanges(parent)
  ) {
    throw new Error("Parent source has changed since Plan Approval or cannot be bound. Re-present and approve the plan against the current parent source.");
  }
  const prefix = `${repo.repo ?? ""}\0`;
  const expected = new Map([...parentSource.listing]
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, value]) => [key.slice(prefix.length - 1), value]));
  return { parentSource, expectedBytes: serializeSourceListing(expected) };
}

/**
 * Read-only initial preparation check: no child, audit, receipt, index or parent
 * commit is changed. The selected repository's committed source must reproduce
 * the selected execution source. A lowered fence permits current content after
 * approval; the selected source must still be reproducible in the child.
 */
export function validateCodeGenerationForkApproval(
  parentDir: string, unit: string, repoCwd: string, repoName: string | null, baseCommit: string,
  discardedSha256?: string,
): void {
  const parent = realpathSync(parentDir);
  const approved = parentWorktreeApproval(parent, unit);
  const repo = resolveConstructionRepo(parent, repoName ?? undefined);
  if (repo.repo !== repoName || approvalPathKey(repo.cwd) !== approvalPathKey(repoCwd)) {
    throw new Error("Selected worktree repository does not match the parent approval source.");
  }
  const discarded = discardedSha256 === undefined
    ? null : discardedWorktreeApproval(parent, unit, repoCwd, repoName, discardedSha256);
  const { expectedBytes } = approvedWorktreeSource(parent, approved, repo, discarded);
  if (discarded) {
    const base = worktreeApprovalGit(repo.cwd, ["rev-parse", "--verify", "--end-of-options", `${baseCommit}^{commit}`]);
    if (base !== discarded.commit) {
      throw new Error("Discard recovery must fork from the recorded Approval Source Commit.");
    }
    return;
  }
  const parentHead = worktreeApprovalGit(repo.cwd, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const committed = gitCommitSourceListing(repo.cwd, parentHead, repo.repo === null);
  if (!committed || serializeSourceListing(committed) !== expectedBytes) {
    throw new Error("Approved parent source is not committed. Commit the already-approved parent source before prepare, then retry. No child was created and no parent commit was made.");
  }
  const base = worktreeApprovalGit(repo.cwd, ["rev-parse", "--verify", "--end-of-options", `${baseCommit}^{commit}`]);
  const baseSource = gitCommitSourceListing(repo.cwd, base, repo.repo === null);
  if (!baseSource) throw new Error("Selected worktree base source cannot be reproduced. Choose a committed base before prepare.");
  if (serializeSourceListing(baseSource) === expectedBytes) return;
  try {
    worktreeApprovalGit(repo.cwd, ["merge-base", "--is-ancestor", base, parentHead]);
  } catch {
    throw new Error("Selected worktree base cannot fast-forward to the approved parent source. Choose an ancestor of the approved parent commit before prepare.");
  }
}

function worktreeApprovalTransfer(parentDir: string, childDir: string, unit: string, discardedSha256?: string) {
  const provenance = approvalWorktreeProvenance(parentDir, childDir, unit);
  const approved = parentWorktreeApproval(provenance.parent, unit);
  const discarded = discardedSha256 === undefined ? null : discardedWorktreeApproval(
    provenance.parent, unit, provenance.repo.cwd, provenance.repo.repo, discardedSha256,
  );
  const { parentSource, expectedBytes } = approvedWorktreeSource(provenance.parent, approved, provenance.repo, discarded);
  const childSource = workspaceSourceState(provenance.child);
  if (!childSource) throw new Error("Worktree source cannot be bound. Repair its source boundary before retrying.");
  let syncCommit: string | null = null;
  if (serializeSourceListing(childSource.listing) !== expectedBytes) {
    if (discarded) {
      throw new Error("Recreated worktree source differs from the discarded approval's immutable baseline. Nothing was changed.");
    }
    const childHead = worktreeApprovalGit(provenance.child, ["rev-parse", "HEAD"]);
    const base = gitCommitSourceListing(provenance.child, childHead, provenance.repo.repo === null);
    if (!base || serializeSourceListing(base) !== serializeSourceListing(childSource.listing)) {
      throw new Error("Preserved worktree source differs from the approved parent baseline and contains dirty or untracked source. Nothing was changed. Preserve that work, reconcile/review it on the parent, and obtain fresh Plan Approval before retrying.");
    }
    const parentHead = worktreeApprovalGit(provenance.repo.cwd, ["rev-parse", "HEAD"]);
    const committed = gitCommitSourceListing(provenance.repo.cwd, parentHead, provenance.repo.repo === null);
    if (!committed || serializeSourceListing(committed) !== expectedBytes) {
      throw new Error("Clean worktree needs approved parent source that is not committed. Commit the already-approved parent source, then retry; the worktree was preserved.");
    }
    try {
      worktreeApprovalGit(provenance.child, ["merge-base", "--is-ancestor", childHead, parentHead]);
    } catch {
      throw new Error("Preserved worktree history cannot fast-forward to the approved parent source. Reconcile its branch without discarding work, then retry.");
    }
    syncCommit = parentHead;
  }
  const files = ["code-generation-plan.md", "unit-test-instructions.md", "code-generation-questions.md"].map((name) => {
    const from = join(approved.evidence.authority.stageDir, name);
    const to = join(provenance.child, dirname(approved.evidence.questionsRelativePath), name);
    assertNoSymlinkInChainOrThrow(provenance.parent, relative(provenance.parent, from));
    assertNoSymlinkInChainOrThrow(provenance.child, relative(provenance.child, to));
    if (existsSync(to)) readRegularFileNoFollowOrThrow(to, "preserved plan record");
    return { from, to, name, bytes: readRegularFileNoFollowOrThrow(from, "approved parent plan record") };
  });
  return { ...provenance, ...approved, parentSource, childSource, expectedBytes, syncCommit, files, discarded };
}

/** Read-only preflight, including dirty-source refusal before any re-fork. */
export function validateCodeGenerationWorktreeApproval(
  parentDir: string, childDir: string, unit: string, discardedSha256?: string,
): void {
  worktreeApprovalTransfer(parentDir, childDir, unit, discardedSha256);
}

/**
 * Delegate the already-started parent receipt without changing its human,
 * intent, attempt, fingerprint, or group binding. Publication is the last write.
 */
export function bindCodeGenerationWorktreeApproval(
  parentDir: string, childDir: string, unit: string, discardedSha256?: string,
): void {
  const before = worktreeApprovalTransfer(parentDir, childDir, unit, discardedSha256);
  if (before.syncCommit) {
    // Git refuses diverged histories and overlapping local changes. No reset,
    // stash, clean, new commit, or force option is used.
    worktreeApprovalGit(before.child, ["merge", "--ff-only", "--no-edit", "--no-overwrite-ignore", before.syncCommit]);
  }
  withAuditLock(before.parent, () => withAuditLock(before.child, () => {
    const current = worktreeApprovalTransfer(before.parent, before.child, unit, discardedSha256);
    if (current.syncCommit || current.hash !== before.hash ||
      hashObject(current.receipt) !== hashObject(before.receipt) ||
      current.expectedBytes !== before.expectedBytes ||
      hashObject(current.discarded) !== hashObject(before.discarded) ||
      current.receipt.status !== "generation" ||
      current.intentUuid !== current.evidence.authority.intentId) {
      throw new Error("Worktree approval context changed during transfer; no execution receipt was published.");
    }
    const childHead = worktreeApprovalGit(current.child, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const committed = gitCommitSourceListing(current.child, childHead, current.repo.repo === null);
    // Some preserved, approved source is dirty relative to the child's HEAD.
    // Such a delegation remains valid but cannot furnish an immutable discard
    // recovery base; capture will simply return no optional approval fields.
    const baselineCommit = committed && serializeSourceListing(committed) === current.expectedBytes
      ? childHead : undefined;
    const archive = join(recordDir(current.child)!, ".aidlc-plan-transfers", randomUUID());
    mkdirSync(archive, { recursive: true });
    for (const file of current.files) {
      if (existsSync(file.to)) {
        writeBufferAtomic(join(archive, file.name), readRegularFileNoFollowOrThrow(file.to, "preserved plan record"));
      }
      mkdirSync(dirname(file.to), { recursive: true });
      writeBufferAtomic(file.to, file.bytes);
    }
    const baselineSha256 = writeBaselineSourceSnapshot(current.child, CODE_GENERATION_STAGE, current.childSource.listing);
    const state = readFileSync(stateFilePath(current.child), "utf-8");
    writeActiveDirectiveMarker(current.child, {
      kind: "run-stage", stage: CODE_GENERATION_STAGE, unit, state_sha256: stateDigest(state),
    });
    const childAuthority = resolveCodeGenerationAuthority(current.child, { unit });
    const copied = codeGenerationApprovalArtifacts(current.child, childAuthority, current.parent);
    const finalParent = parentWorktreeApproval(current.parent, unit);
    if (childAuthority.intentId !== current.receipt.intentId || childAuthority.runFloor !== current.receipt.runFloor ||
      (copied.expectedFingerprint !== current.receipt.fingerprint &&
        !(current.continuing && decideFence(current.parent, "plan-approval").decision === "stand-aside")) ||
      !copied.approvedAnswer ||
      copied.recordedFingerprint !== current.receipt.fingerprint ||
      hashObject(finalParent.receipt) !== hashObject(current.receipt) ||
      current.files.some((file) => !readRegularFileNoFollowOrThrow(file.from, "approved parent plan record").equals(file.bytes)) ||
      (baselineCommit !== undefined &&
        worktreeApprovalGit(current.child, ["rev-parse", "--verify", "HEAD^{commit}"]) !== baselineCommit) ||
      workspaceSourceFingerprint(current.parent) !== current.parentSource.fingerprint ||
      workspaceSourceFingerprint(current.child) !== current.childSource.fingerprint) {
      throw new Error("Worktree source or attempt changed before approval publication; retry from current Plan Approval.");
    }
    writePlanApprovalReceipt(current.child, {
      ...current.receipt,
      delegation: {
        version: 1, parentProjectDir: current.parent, worktreeDir: current.child, unit,
        provenanceSha256: current.hash, parentReceiptSha256: hashObject(current.receipt), baselineSha256,
        ...(baselineCommit === undefined ? {} : { baselineCommit }),
      },
    });
  }));
}

function worktreeDelegationParent(
  childDir: string, authority: CodeGenerationAuthority, receipt: PlanApprovalRuntimeReceipt,
): string {
  const origin = receipt.delegation!;
  if (origin.version !== 1 || origin.unit !== authority.unit ||
    (origin.baselineCommit !== undefined &&
      (typeof origin.baselineCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(origin.baselineCommit))) ||
    approvalPathKey(origin.worktreeDir) !== approvalPathKey(childDir)) {
    throw new Error("Worktree approval delegation has a different execution target.");
  }
  const provenance = approvalWorktreeProvenance(origin.parentProjectDir, childDir, origin.unit);
  const parentAuthority = resolveCodeGenerationAuthority(provenance.parent, { unit: origin.unit });
  const parentReceipt = readPlanApprovalReceipt(provenance.parent, receipt);
  const parentQuestions = readFileSync(join(parentAuthority.stageDir, "code-generation-questions.md"), "utf-8");
  const parentPrompt = createHash("sha256")
    .update(`${parentQuestions.replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:").trimEnd()}\n`, "utf-8")
    .digest("hex");
  const { delegation: _delegation, ...copiedReceipt } = receipt;
  if (provenance.hash !== origin.provenanceSha256 ||
      provenance.intentUuid !== authority.intentId || provenance.intentUuid !== receipt.intentId ||
    parentAuthority.intentId !== receipt.intentId || parentAuthority.runFloor !== receipt.runFloor ||
    parentAuthority.targetId !== receipt.targetId || parentPrompt !== receipt.promptSha256 ||
    !questionsFileApproved(parentQuestions) ||
    questionsFileApprovalFingerprint(parentQuestions) !== receipt.fingerprint ||
    hashObject(parentReceipt) !== origin.parentReceiptSha256 ||
    hashObject(copiedReceipt) !== hashObject(parentReceipt) ||
    parentReceipt?.status !== "generation" || receipt.status !== "generation" ||
    !readBaselineSourceSnapshot(childDir, CODE_GENERATION_STAGE, origin.baselineSha256)) {
    throw new Error("Protected parent Plan Approval or the delegated worktree baseline is no longer current.");
  }
  return provenance.parent;
}

function validateWorktreeDelegation(
  childDir: string, authority: CodeGenerationAuthority, receipt: PlanApprovalRuntimeReceipt,
): string {
  const parent = worktreeDelegationParent(childDir, authority, receipt);
  if (!codeGenerationExecutionAllowed(parent, { unit: authority.unit })) {
    throw new Error("Parent Plan Approval is no longer current and its fence is raised.");
  }
  return parent;
}

/** Exact source present at delegation; later worker changes are measured against it. */
export function readCodeGenerationWorktreeSourceBaseline(childDir: string, unit: string): WorkspaceSourceListing | null {
  const path = join(codeGenerationRecordDir(childDir, unit), "code-generation-questions.md");
  if (!existsSync(path) || !existsSync(stateFilePath(childDir))) return null;
  const state = readFileSync(stateFilePath(childDir), "utf-8");
  const questions = readFileSync(path, "utf-8");
  const fingerprint = questionsFileApprovalFingerprint(questions);
  if (!fingerprint) return null;
  const runFloor = latestMainWorkflowStageRunFloorForProject(
    childDir, CODE_GENERATION_STAGE,
    getField(state, "Construction Iteration") === "unit-major" || getField(state, "Construction Checkpoints") === "enabled",
    unit,
  );
  const receipt = readPlanApprovalReceipt(childDir, { targetId: codeGenerationTargetId({ unit }), runFloor, fingerprint });
  if (!receipt?.delegation) return null;
  const approval = evaluateCodeGenerationApproval(childDir, { unit });
  if (!codeGenerationExecutionAllowed(childDir, { unit }, approval)) {
    throw new Error(`Delegated plan cannot continue: ${approval.reason}`);
  }
  const authority = resolveCodeGenerationAuthority(childDir, { unit });
  validateWorktreeDelegation(childDir, authority, receipt);
  return readBaselineSourceSnapshot(childDir, CODE_GENERATION_STAGE, receipt.delegation.baselineSha256);
}

export function evaluateCodeGenerationApproval(
  projectDir: string,
  target: CodeGenerationTarget,
  issued?: CodeGenerationIssuance,
): CodeGenerationApproval {
  let normalizedUnit: string | null = null;
  const empty: CodeGenerationApproval = {
    ok: false,
    unit: null,
    reason: "",
    planExists: false,
    instructionsExist: false,
    approved: false,
    contractValid: false,
    fingerprintValid: false,
    receiptValid: false,
    contractHash: null,
    approvalFingerprint: null,
    directiveEpoch: null,
  };
  try {
    const normalizedTarget = normalizeCodeGenerationTarget(target);
    normalizedUnit = normalizedTarget.unit;
    empty.unit = normalizedUnit;
    const authority = resolveCodeGenerationAuthority(projectDir, normalizedTarget, issued);
    empty.directiveEpoch = authority.directiveEpoch;
    const questionsPath = join(authority.stageDir, "code-generation-questions.md");
    const recordedFingerprint = existsSync(questionsPath)
      ? questionsFileApprovalFingerprint(readFileSync(questionsPath, "utf-8")) : null;
    const candidate = recordedFingerprint
      ? readPlanApprovalReceipt(projectDir, { targetId: authority.targetId, runFloor: authority.runFloor, fingerprint: recordedFingerprint })
      : null;
    if (candidate?.skipped !== undefined) empty.skipped = true;
    // A worker executes the parent's approved contract, including for a sibling
    // repository that does not carry the workspace's methodology files.
    const contractProject = candidate?.delegation
      ? validateWorktreeDelegation(projectDir, authority, candidate) : projectDir;
    const artifacts = codeGenerationApprovalArtifacts(projectDir, authority, contractProject);
    empty.planExists = artifacts.planExists;
    empty.instructionsExist = artifacts.instructionsExist;
    empty.approved = artifacts.approvedAnswer;
    empty.contractValid = artifacts.contractValid;
    empty.contractHash = artifacts.contractHash;
    empty.approvalFingerprint = artifacts.expectedFingerprint ??
      (artifacts.planExists && artifacts.instructionsExist && artifacts.contractHash
        ? approvalFingerprint(artifacts.plan, artifacts.instructions, artifacts.contractHash, authority)
        : null);
    // A lowered fence preserves the earlier approval; it cannot make an
    // unavailable execution baseline publishable. Check that prerequisite
    // independently of content currentness, using the original question identity.
    const recordedIdentity: PlanApprovalRuntimeIdentity | null = artifacts.recordedFingerprint
      ? {
        targetId: authority.targetId,
        intentId: authority.intentId,
        runFloor: authority.runFloor,
        fingerprint: artifacts.recordedFingerprint,
        questionsFile: toPosix(relative(projectDir, artifacts.questionsPath)),
        promptSha256: createHash("sha256")
          .update(`${artifacts.questions.replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:").trimEnd()}\n`, "utf-8")
          .digest("hex"),
      } : null;
    const currentSource = candidate && recordedIdentity && artifacts.approvedAnswer &&
      candidate.choice === "Approve Plan" && runtimeIdentityMatches(candidate, recordedIdentity) &&
      candidate.status !== "generation" && candidate.override === undefined
      ? workspaceSourceState(projectDir) : undefined;
    if (currentSource === null && !codeGenerationBuildsWithoutSource(projectDir, target, candidate?.skipped !== undefined)) {
      empty.executionFailure = generationSourceUnavailableMessage();
      empty.reason = empty.executionFailure;
      return empty;
    }
    if (!empty.planExists) {
      empty.reason = "code-generation-plan.md is missing or empty";
      return empty;
    }
    if (!empty.instructionsExist) {
      empty.reason = "unit-test-instructions.md is missing or empty";
      return empty;
    }
    if (artifacts.contractHash === null) {
      empty.reason = testingContractDefectReason(artifacts.plan) ??
        "code-generation-plan.md has no valid ## Testing Contract JSON block";
      return empty;
    }
    if (!usableTestingContract(parseTestingContract(artifacts.plan))) {
      empty.reason = "The Testing Contract has missing or inconsistent executable fields. Repair its methodology, obligations, and plan profile before continuing.";
      return empty;
    }
    if (!empty.contractValid) {
      empty.reason =
        "the approved Testing Contract is stale because memory, scope, test strategy, project type, or the installed AIDLC version changed";
      return empty;
    }
    if (!empty.approved) {
      // An answered section under the wrong heading reads as unanswered; say so.
      empty.reason = artifacts.questions.trim() && !latestPlanApproval(artifacts.questions).found
        ? missingPlanApprovalFingerprintReason(artifacts.questions)
        : "the plan is not approved yet; run next to ask the person to approve it";
      return empty;
    }
    empty.fingerprintValid =
      artifacts.expectedFingerprint !== null &&
      artifacts.recordedFingerprint === artifacts.expectedFingerprint;
    if (!empty.fingerprintValid) {
      empty.reason = artifacts.recordedFingerprint === null
        ? missingPlanApprovalFingerprintReason(artifacts.questions)
        : !approvalFingerprintIsCurrentFormat(artifacts.recordedFingerprint)
          ? "the recorded Plan Approval was written under an earlier format; run next to ask the person to approve the plan again"
          : "the plan, test instructions, or Testing Contract changed since the person approved them (or the approval is for another target or stage attempt); run next to ask the person again";
      return empty;
    }
    // The raw questions-file digest is provenance on the audit row, not part of
    // validity: the prompt hash below binds what the human saw, and a note
    // appended to the file after approval must not retire the decision.
    const promptSha256 = createHash("sha256")
      .update(
        `${artifacts.questions
          .replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:")
          .trimEnd()}\n`,
        "utf-8",
      )
      .digest("hex");
    const identity: PlanApprovalRuntimeIdentity = {
      targetId: authority.targetId,
      intentId: authority.intentId,
      runFloor: authority.runFloor,
      fingerprint: artifacts.expectedFingerprint!,
      questionsFile: toPosix(relative(projectDir, artifacts.questionsPath)),
      promptSha256,
    };
    const violation = readPlanApprovalViolation(projectDir);
    if (
      violation?.version === 1 &&
      violation.markerRevision === authority.markerRevision
    ) {
      // The target is a file name from the workspace, so it stays out of the
      // refusal: the way on is the same whatever the file was.
      empty.reason = "legacy Plan Approval authority was poisoned by an unsupported write target";
      return empty;
    }
    const receipt = readPlanApprovalReceipt(projectDir, identity);
    if (receipt?.delegation) {
      if (hashObject(receipt) !== hashObject(candidate)) throw new Error("Worktree approval changed while reading.");
    } else if (receipt?.batch) assertPlanApprovalBatchCurrent(projectDir, receipt);
    // Source that moved after the receipt certified it never retires the
    // approval: the approval is about the plan, and generation start records
    // the move as one notice line and re-baselines the receipt. Only a source
    // that cannot be read at all stops the build, because then nothing can say
    // what it starts from. A break-glass receipt is bound to content and
    // attempt only, so its source is never read here.
    if (
      receipt !== null &&
      receipt.status !== "generation" &&
      receipt.override === undefined &&
      (currentSource ?? workspaceSourceState(projectDir)) === null &&
      !codeGenerationBuildsWithoutSource(projectDir, target, receipt.skipped !== undefined)
    ) {
      empty.executionFailure = generationSourceUnavailableMessage();
      empty.reason = empty.executionFailure;
      return empty;
    }
    empty.receiptValid =
      receipt !== null &&
      runtimeIdentityMatches(receipt, identity) &&
      receipt.choice === "Approve Plan";
    if (!empty.receiptValid) {
      // Distinguish "never approved" from "approved in an attempt that has since
      // ended". The second is the case a redo jump or a rejected gate produces,
      // and it has a different instruction.
      const stale = stalePlanApprovalReceiptsForTarget(
        projectDir,
        authority.intentId,
        authority.targetId,
        authority.runFloor,
      );
      empty.reason = stale.length > 0
        ? "the Plan Approval receipt for this target belongs to an earlier stage attempt; run next to ask the person to approve the plan for the current attempt"
        : "no current Plan Approval receipt matches this question, target, stage attempt, and plan content; run next to ask the person to approve the plan";
      return empty;
    }
    return {
      ...empty,
      ok: true,
      reason: "approved",
      ...(receipt?.override !== undefined ? { override: true as const } : {}),
      ...(receipt?.skipped !== undefined ? { skipped: true as const } : {}),
    };
  } catch (error) {
    return {
      ...empty,
      unit: normalizedUnit,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Validate a target while the caller holds both generation authority locks. */
function prepareCodeGenerationStart(projectDir: string, target: CodeGenerationTarget) {
  refuseWhileRulesArrive(projectDir);
  const approval = evaluateCodeGenerationApproval(projectDir, target);
  if (approval.executionFailure) throw new Error(approval.executionFailure);
  const continuation = approval.ok ? null : codeGenerationContinuation(projectDir, target);
  if ((!approval.ok || !approval.approvalFingerprint) && !continuation) {
    throw new Error(approval.reason || "Code Generation requires Plan Approval");
  }
  const authority = continuation?.authority ?? resolveCodeGenerationAuthority(projectDir, target);
  const receiptKey: PlanApprovalReceiptKey = {
    targetId: authority.targetId,
    runFloor: authority.runFloor,
    fingerprint: continuation?.receipt.fingerprint ?? approval.approvalFingerprint!,
  };
  const receipt = readPlanApprovalReceipt(projectDir, receiptKey);
  if (!receipt) {
    throw new Error("Code Generation has no protected approval receipt");
  }
  return { authority, receipt, continuation };
}

function publishCodeGenerationStart(
  projectDir: string,
  prepared: ReturnType<typeof prepareCodeGenerationStart>,
  options: { recordContinuation?: boolean },
  originals: PlanApprovalRuntimeReceipt[],
  pickUp: boolean,
): string[] {
  const { authority, receipt, continuation } = prepared;
  const changeNotices: string[] = continuation && options.recordContinuation !== false
    ? recordCodeGenerationContinuation(projectDir, continuation, "begin") : [];
  if (receipt.status === "generation") return changeNotices;
  originals.push(receipt);
  // A lowered fence building a plan edited after its approval: the receipt
  // keeps the content the build started on, so an interrupted build of it picks
  // up (see "Picking up an interrupted build"). A swarm, a worktree delegation
  // and a batch keep their own continuation rule.
  const started = pickUp && continuation && !receipt.batch
    ? buildContentFingerprint(continuation.artifacts.plan, continuation.artifacts.instructions, authority) : null;
  const startedOn = started !== null && started !== receipt.fingerprint ? { startedFingerprint: started } : {};
  if (receipt.override !== undefined) {
    // A break-glass receipt is bound to content and attempt only. There is
    // no certified source to compare or re-certify, and no race window to
    // close, so the generation boundary is published as the receipt stands.
    // This is the one place an override could have been downgraded to
    // "approve again": it is not.
    writePlanApprovalReceipt(projectDir, { ...receipt, ...startedOn, status: "generation" });
    return changeNotices;
  }
  const stateBefore = workspaceSourceState(projectDir);
  const sourceBefore = stateBefore?.fingerprint ?? null;
  if (sourceBefore === null) {
    if (!codeGenerationBuildsWithoutSource(projectDir, { unit: authority.unit }, receipt.skipped !== undefined)) {
      throw new Error(generationSourceUnavailableMessage());
    }
    // Nothing to compare at the start or after it: the build begins from the
    // files as they are, said in one line.
    writePlanApprovalReceipt(projectDir, {
      ...receipt,
      ...startedOn,
      certifiedSourceSha256: UNBINDABLE_FINGERPRINT,
      status: "generation",
    });
    return [...changeNotices, buildWithoutSourceNotice()];
  }
  if (!sameWorkspaceSource(receipt.certifiedSourceSha256, sourceBefore)) {
    // A raised strict fence refuses and KEEPS the receipt: deleting the human's recorded
    // decision because the workspace moved turned a recoverable drift into
    // a state with no way back, and a fresh approval re-baselines the
    // source this plan is bound to. Relaxed records the change and moves
    // that baseline to the source found now, so generation begins and the
    // same change is not reported again.
    const judged = judgePlanSourceDrift(
      projectDir,
      authority.unit,
      receipt.certifiedSourceSha256,
      stateBefore,
      true,
      continuation !== null,
      true,
    );
    if ("refusal" in judged) throw judged.refusal;
    const recordedNotices = recordAcceptedChanges(projectDir, [judged.accepted]);
    // A previous failed publication may have appended the change row
    // without returning its notice. Until the generation boundary is
    // committed, a successful retry still owes that source-change notice.
    changeNotices.push(...(recordedNotices.length > 0 ? recordedNotices : [judged.accepted.notice]));
    keepWorkspaceSourceSnapshot(projectDir, stateBefore);
  }
  // Publication is the generation boundary. It sits between two source
  // fingerprints while both authority locks are held: neither another
  // guard nor directive publication can retire this receipt mid-start.
  writePlanApprovalReceipt(projectDir, {
    ...receipt,
    ...startedOn,
    certifiedSourceSha256: sourceBefore,
    status: "generation",
  });
  const publicationBarrier =
    process.env.AIDLC_TEST_PLAN_APPROVAL_PUBLICATION_BARRIER?.trim();
  const barrierTarget = process.env.AIDLC_TEST_PLAN_APPROVAL_PUBLICATION_TARGET?.trim();
  if (publicationBarrier && (!barrierTarget || barrierTarget === authority.targetId)) {
    writeFileSync(`${publicationBarrier}.published`, "published\n", "utf-8");
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + DEFAULT_SUBPROCESS_TIMEOUT_MS;
    while (!existsSync(`${publicationBarrier}.release`)) {
      if (Date.now() >= deadline) {
        throw new Error(
          "timed out waiting for the Plan Approval publication test barrier",
        );
      }
      Atomics.wait(waitCell, 0, 0, 5);
    }
  }
  const sourceAfter = workspaceSourceFingerprint(projectDir);
  if (
    (sourceAfter === null || sourceAfter !== sourceBefore) &&
    !codeGenerationBuildsWithoutSource(projectDir, { unit: authority.unit }, receipt.skipped !== undefined)
  ) {
    // Revert the generation boundary rather than delete the approval: the
    // human's decision is still a fact, only the start is not. This is the
    // race window, not the governed drift, so strict asks for the step again.
    // With the plan-approval check lowered a file that moves during the start
    // is the same accepted change as one that moved before it.
    throw new Error(
      "Source files changed while code generation was starting. Retry the step.",
    );
  }
  return changeNotices;
}

/** One dispatch either starts every selected target or restores its prior receipts. */
export function beginCodeGenerationBatch(
  projectDir: string,
  targets: CodeGenerationTarget[],
  options: { recordContinuation?: boolean } = {},
): string[] {
  if (targets.length === 0) throw new Error("Code Generation requires an execution target");
  return withAuditLock(projectDir, () =>
    withActiveDirectiveLock(projectDir, () => {
      const selected = [...new Map(targets.map((target) => [codeGenerationTargetId(target), target])).values()];
      const prepared = selected.map((target) => prepareCodeGenerationStart(projectDir, target));
      const needsSource = prepared.some(({ authority, receipt }) =>
        receipt.status !== "generation" && receipt.override === undefined &&
        !codeGenerationBuildsWithoutSource(projectDir, { unit: authority.unit }, receipt.skipped !== undefined));
      const sourceBefore = needsSource ? workspaceSourceFingerprint(projectDir) : null;
      if (needsSource && sourceBefore === null) throw new Error(generationSourceUnavailableMessage());
      const originals: PlanApprovalRuntimeReceipt[] = [];
      const notices: string[] = [];
      const swarm = underSwarmDirective(projectDir);
      try {
        for (const target of selected) {
          // Files can change independently of the engine locks. Recheck the
          // target immediately before its publication as well as at preflight.
          const started = prepareCodeGenerationStart(projectDir, target);
          // A fresh build (receipt approved, not yet generation) starts with its
          // steps unticked, so the ticks a later resume reads are this build's
          // own (see "Picking up an interrupted build"). They are cleared before
          // the start is published. A swarm batch and a worktree delegation keep
          // their own continuation rule.
          const pickUp = started.receipt.delegation === undefined && !swarm;
          if (started.receipt.status !== "generation" && pickUp) {
            clearPlanFileTicks(projectDir, started.authority.stageDir);
          }
          notices.push(...publishCodeGenerationStart(projectDir, started, options, originals, pickUp));
        }
        if (needsSource && workspaceSourceFingerprint(projectDir) !== sourceBefore) {
          throw new Error("Source files changed while code generation was starting. Retry the step.");
        }
        for (const receipt of originals) {
          collectStalePlanApprovalReceipts(projectDir, receipt.intentId, receipt.targetId, receipt.runFloor);
        }
      } catch (error) {
        const failures: string[] = [];
        for (const receipt of originals.toReversed()) {
          try {
            writePlanApprovalReceipt(projectDir, receipt);
          } catch (rollbackError) {
            failures.push(`${receipt.targetId}: ${errorMessage(rollbackError)}`);
          }
        }
        if (failures.length > 0) {
          throw new Error(`${errorMessage(error)} Could not restore generation receipts: ${failures.join("; ")}`);
        }
        throw error;
      }
      return notices;
    }),
  );
}

export function beginCodeGeneration(
  projectDir: string,
  target: CodeGenerationTarget,
  options: { recordContinuation?: boolean } = {},
): string[] {
  return beginCodeGenerationBatch(projectDir, [target], options);
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function targetFromArgs(
  args: string[],
  subcommand: "fingerprint" | "verify" | "begin" | "brief" | "restore",
): CodeGenerationTarget {
  const unitIndex = args.indexOf("--unit");
  const stageLevel = args.includes("--stage-level");
  if (unitIndex >= 0 && stageLevel) {
    throw new Error(`${subcommand} accepts exactly one of --unit <unit> or --stage-level`);
  }
  if (unitIndex >= 0) {
    const unit = args[unitIndex + 1];
    if (!unit || unit.startsWith("--") || unit.trim().length === 0) {
      throw new Error(`${subcommand} requires a non-blank --unit <unit>`);
    }
    return normalizeCodeGenerationTarget({ unit });
  }
  if (stageLevel) return { unit: null };
  throw new Error(`${subcommand} requires exactly one of --unit <unit> or --stage-level`);
}

// What the human-turn hook recorded for the pending Plan Approval question,
// as the same notice line the hook adds. Several harnesses never show the
// conductor that line, so this read gives them the same next step.
function recordedPlanApprovalReply(projectDir: string, session: string): string {
  const challenge = readPlanApprovalChallenge(projectDir, session);
  if (!challenge) {
    return `AIDLC Plan Approval: no Plan Approval question is pending for session "${session}". ` +
      runtimeSessionHint(projectDir);
  }
  const response = readPlanApprovalResponse(projectDir, session);
  if (response?.challengeId === challenge.challengeId) {
    return "AIDLC Plan Approval: the person replied to this question. Read what they said, do what they " +
      "asked, and record the choice they made.";
  }
  return "AIDLC Plan Approval: the person has not replied to this question yet. End the turn and wait for " +
    "their reply.";
}

function replySession(projectDir: string, argv: string[]): string {
  const explicit = flagValue(argv, "--session")?.trim();
  if (explicit) return explicit;
  const resolved = resolveInvokingSessionId(projectDir);
  if (resolved) return resolved;
  throw new Error(
    "reply requires --session <id> from the invoking SessionStart context; it could not be auto-resolved. " +
      runtimeSessionHint(projectDir),
  );
}

export function main(argv: string[]): void {
  const subcommand = argv.find((arg) => (TESTING_POSTURE_SUBCOMMANDS as readonly string[]).includes(arg));
  const projectDir = resolveProjectDir(flagValue(argv, "--project-dir"));
  try {
    switch (subcommand) {
      case "resolve":
        console.log(JSON.stringify(resolveTestingPosture(projectDir), null, 2));
        return;
      case "render":
        process.stdout.write(renderTestingContract(resolveTestingPosture(projectDir)));
        return;
      case "fingerprint": {
        if (planApprovalAskIsOpen(projectDir)) throw new Error(PLAN_APPROVAL_ASKED_BY_ENGINE);
        // Only the retired strict drift question ever emitted --reapprove; an agent
        // repeating it from memory gets the route that works now.
        if (argv.includes("--reapprove")) {
          throw new Error(
            "--reapprove is retired: the engine asks for Plan Approval again when the plan changed. Run next.",
          );
        }
        const target = targetFromArgs(argv, "fingerprint");
        const authority = resolveCodeGenerationAuthority(projectDir, target);
        const approval = evaluateCodeGenerationApproval(projectDir, target);
        const stageDir = authority.stageDir;
        const plan = readFileSync(join(stageDir, "code-generation-plan.md"), "utf-8");
        const instructions = readFileSync(
          join(stageDir, "unit-test-instructions.md"),
          "utf-8",
        );
        const questionsPath = join(stageDir, "code-generation-questions.md");
        const questions = existsSync(questionsPath)
          ? readFileSync(questionsPath, "utf-8")
          : null;
        // The approved questions file, or null when nothing stands approved.
        const standing = questions !== null && questionsFileApproved(questions)
          ? questions
          : null;
        if (standing !== null) {
          throw new Error(
            "reset the Plan Approval [Answer]: to blank before regenerating its fingerprint",
          );
        }
        const embedded = parseTestingContract(plan);
        const current = resolveTestingPosture(projectDir);
        if (
          !embedded ||
          embedded.contract_sha256 !== current.contract_sha256
        ) {
          throw new Error(
            approval.reason ||
              "plan Testing Contract does not match the current effective posture",
          );
        }
        // Print the two tag lines the Plan Approval section must carry, ready to
        // copy: the content fingerprint, and the workspace source this plan was
        // written against. Recording the source here is what makes drift between
        // planning and approval answerable - re-run this command and re-present.
        // The listing behind the source is kept so a later drift can be told to
        // the human as the files that changed.
        const plannedState = workspaceSourceState(projectDir);
        keepWorkspaceSourceSnapshot(projectDir, plannedState);
        const plannedSource = plannedState?.fingerprint ?? UNBINDABLE_FINGERPRINT;
        const fingerprint = approvalFingerprint(
          plan,
          instructions,
          current.contract_sha256,
          authority,
        );
        console.log(`[Approval Fingerprint]: ${fingerprint}`);
        console.log(`[Planned Source]: ${plannedSource}`);
        if (questions === null || !latestPlanApproval(questions).found) {
          // Stdout stays the two tag lines; the section they belong in rides on
          // stderr, because a heading carrying the question text is not read.
          console.error(JSON.stringify({
            note:
              "code-generation-questions.md has no Plan Approval section yet. Write the section below into it; " +
              "keep the heading exactly `## Plan Approval` (the question text is not the heading).",
            section: planApprovalSectionSkeleton(fingerprint, plannedSource),
          }));
        }
        if (plannedState === null) {
          // The tag stays machine-readable; the reason rides on stderr so the
          // conductor can relay which budget or path failed before presenting.
          console.error(
            JSON.stringify({
              note:
                `the workspace source cannot be bound${workspaceSourceFailureSuffix()}; ` +
                "a decision on this plan will be refused until the boundary is repaired. " +
                PLAN_APPROVAL_REPAIR_SOURCE_BOUNDARY_REMEDY,
            }),
          );
        }
        return;
      }
      case "verify": {
        const target = targetFromArgs(argv, "verify");
        const result = evaluateCodeGenerationApproval(projectDir, target);
        const continuation = result.ok ? null : codeGenerationContinuation(projectDir, target);
        const executionAllowed = !result.executionFailure && (result.ok || continuation !== null);
        console.log(JSON.stringify({
          ...result,
          execution_allowed: executionAllowed,
          ...(!result.ok && executionAllowed ? {
            approval_reason: result.reason,
            reason: "The plan-approval check is off; continue with the current plan and test instructions without a new approval.",
          } : {}),
          ...(continuation?.sourceChange ? { change_notices: [continuation.sourceChange.notice] } : {}),
        }, null, 2));
        process.exit(executionAllowed ? 0 : 2);
        return;
      }
      case "begin": {
        const target = targetFromArgs(argv, "begin");
        const changeNotices = beginCodeGeneration(projectDir, target);
        console.log(
          JSON.stringify({
            status: "generation",
            target,
            ...(changeNotices.length > 0 ? { change_notices: changeNotices } : {}),
          }),
        );
        return;
      }
      case "brief": {
        // The worker brief, verbatim on stdout: the two marker lines, the plan
        // BODY, and the byte-exact instructions. Refuses unless approval is
        // current, so the brief can never precede the authority it carries.
        const target = targetFromArgs(argv, "brief");
        const assembled = workerBrief(projectDir, target);
        if (assembled.appendixStripped) {
          console.error(
            JSON.stringify({
              note:
                "the plan carries a terminal review appendix from an earlier protocol; " +
                "it is not part of the approved body and was left out of the brief",
            }),
          );
        }
        for (const notice of assembled.changeNotices ?? []) {
          console.error(JSON.stringify({ note: notice }));
        }
        process.stdout.write(assembled.brief);
        return;
      }
      case "reply":
        console.log(recordedPlanApprovalReply(projectDir, replySession(projectDir, argv)));
        return;
      case "restore":
        console.log(restoreApprovedPlan(projectDir, targetFromArgs(argv, "restore")));
        return;
      default:
        throw new Error(
          `Unknown subcommand: ${subcommand ?? "(none)"}. Valid: resolve, render, fingerprint, verify, begin, brief, reply, restore`,
        );
    }
  } catch (error) {
    // The human sentence is the error; the conductor's remedy (which command
    // reopens approval) rides beside it, never inside it.
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof PlanApprovalSourceDriftError ? { remedy: error.remedy } : {}),
      }),
    );
    process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
