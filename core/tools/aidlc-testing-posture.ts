// Deterministic Testing Posture contract for Code Generation.
//
// Practices remain human-authored prose, but code generation needs one stable
// execution contract. This module resolves methodology independently from
// coverage/tooling notes, builds a methodology-specific plan profile, binds the
// result to the active scope/test strategy/project type, and fingerprints the
// approved plan + unit test instructions. Both the dispatch guard and autonomous
// swarm referee consume the same contract.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  type AcceptedChange,
  activeIntentUuid,
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
  getField,
  gitCommitSourceListing,
  isoTimestamp,
  latestMainWorkflowStageRunFloorForProject,
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
  readPlanApprovalLegacyOffer,
  readPlanApprovalLegacyWindow,
  readPlanApprovalLegacyRecoveryChallenge,
  readPlanApprovalOverrideRequest,
  readPlanApprovalReceipt,
  readPlanApprovalResponse,
  readPlanApprovalViolation,
  readRegularFileNoFollowOrThrow,
  recordDir,
  relativeRecordDir,
  recordAcceptedChanges,
  renderChangedPaths,
  governedChangeControl,
  resolveBoltDag,
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
  toPosix,
  stripRecommendedDecorator,
  UNBINDABLE_FINGERPRINT,
  validateUnitName,
  visibleMarkdownLines,
  withActiveDirectiveLock,
  withAuditLock,
  workspaceSourceChangedPaths,
  workspaceSourceFailureSuffix,
  workspaceSourceFingerprint,
  workspaceSourceState,
  worktreePath,
  writeActiveDirectiveMarker,
  writeBaselineSourceSnapshot,
  writeBufferAtomic,
  writePlanApprovalChallenge,
  writePlanApprovalLegacyRecoveryResponse,
  writePlanApprovalOverrideRequest,
  writePlanApprovalReceipt,
  writePlanApprovalResponse,
  writeWorkspaceSourceSnapshot,
  type GuardRemedyOp,
  type ActiveDirectiveMarker,
  type AuditShardEvent,
  type PlanApprovalOverrideRequest,
  type PlanApprovalReceiptKey,
  type PlanApprovalBatchMember,
  type PlanApprovalRuntimeBatch,
  type PlanApprovalRuntimeChallenge,
  type PlanApprovalRuntimeIdentity,
  type PlanApprovalRuntimeProvenance,
  type PlanApprovalRuntimeReceipt,
  type WorkspaceSourceState,
  type WorkspaceSourceListing,
} from "./aidlc-lib.ts";

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
  /** The reason is the strict source-drift refusal; its remedy is PLAN_SOURCE_DRIFT_REMEDY. */
  sourceDrift?: true;
  /** The current receipt is a human break-glass override (content and attempt only). */
  override?: true;
}

export interface CodeGenerationTarget {
  unit: string | null;
}

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
  "the conductor then runs answer --override with that reason.";
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
  "broken symlink; then re-run the fingerprint command and re-present the plan.";

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
    `${describeSourceDrift(paths, unbound)} Continuing (Change Control: relaxed). ` +
    "Say 'review the plan again' to reopen approval."
  );
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
 * the resolver's validation error under both.
 */
function judgePlanSourceDrift(
  projectDir: string,
  unit: string | null,
  recorded: string,
  current: WorkspaceSourceState | null,
  trace: boolean,
): { accepted: AcceptedChange } | { refusal: PlanApprovalSourceDriftError } {
  const paths = workspaceSourceChangedPaths(projectDir, CODE_GENERATION_STAGE, recorded, current);
  const unbound = current === null;
  const resolution = trace ? governedChangeControl(projectDir) : resolveChangeControl(projectDir);
  if (resolution.value === "strict") {
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
      notice: planSourceDriftRelaxedNotice(paths, unbound),
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
const APPROVE_PLAN_RE = /^(?:[A-Z][.)][ \t]*)?["']?Approve Plan["']?$/i;
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

export function parseTestingContract(plan: string): TestingPostureContract | null {
  const section = rawMarkdownSection(plan, CONTRACT_HEADING);
  const match = section.match(/```json[ \t]*\r?\n([\s\S]*?)\r?\n```/i);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as TestingPostureContract;
    if (
      parsed.version !== 1 ||
      !/^sha256:[0-9a-f]{64}$/.test(parsed.contract_sha256 ?? "")
    ) {
      return null;
    }
    const { contract_sha256: recorded, ...body } = parsed;
    return hashObject(body) === recorded ? parsed : null;
  } catch {
    return null;
  }
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
// dropped: the instructions are sent to the developer in full, so anything that
// can change what the developer reads must reopen approval.
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
// What a code-generation worker is handed is exactly what the fingerprint bound,
// and nothing else: the plan as the approval projection sees it (a terminal
// `## Review` appendix removed, task markers reset to `[ ]`, spacing
// normalized) and the unit-test instructions exactly as they were hashed. No
// byte the fingerprint does not cover reaches the worker, on the interactive
// path or the autonomous one, fresh or replayed. The brief is produced here,
// from bytes proven to be the approved ones, so no conductor reads the plan
// file into a prompt itself. The worker's own progress marks live in the plan
// file it ticks as it works, not in the brief.

export interface WorkerBrief {
  unit: string | null;
  contractHash: string;
  /** The exact text to hand the worker: marker lines, projected plan, instructions. */
  brief: string;
  /** True when the plan carried a terminal review appendix, which the brief omits. */
  appendixStripped: boolean;
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
  const approval = evaluateCodeGenerationApproval(projectDir, target);
  if (!approval.ok || approval.contractHash === null || approval.approvalFingerprint === null) {
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
  const plan = readFileSync(join(stageDir, "code-generation-plan.md"), "utf-8");
  const instructions = readFileSync(join(stageDir, "unit-test-instructions.md"), "utf-8");
  const authority = resolveCodeGenerationAuthority(projectDir, target);
  const snapshotFingerprint = approvalFingerprint(
    plan,
    instructions,
    approval.contractHash,
    authority,
  );
  if (snapshotFingerprint !== approval.approvalFingerprint) {
    throw new Error(
      "Cannot assemble a worker brief: the plan or instructions changed while the brief " +
        "was being assembled. Re-run the fingerprint command, re-present the plan, and approve again.",
    );
  }
  const projectedPlan = projectPlanApprovalContent(plan);
  const marker = target.unit
    ? `AIDLC-UNIT: ${target.unit}`
    : "AIDLC-STAGE: code-generation";
  const brief =
    `${marker}\n` +
    `AIDLC-TESTING-CONTRACT: ${approval.contractHash}\n` +
    "\n## Approved plan\n\n" +
    `${projectedPlan}\n` +
    "\n## Approved unit-test instructions\n\n" +
    projectInstructionsContent(instructions);
  return {
    unit: approval.unit,
    contractHash: approval.contractHash,
    brief,
    appendixStripped: planReviewAppendix(plan.replace(/^\uFEFF/, "")).length > 0,
  };
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
  fingerprint: string | null;
  plannedSource: string | null;
} {
  let inPlanApproval = false;
  let awaitingNumberedQuestionText = false;
  let foundPlanApproval = false;
  let latestAnswer: string | null = null;
  let latestFingerprint: string | null = null;
  let latestPlannedSource: string | null = null;

  for (const line of visibleMarkdownLines(body)) {
    const heading = line.match(MARKDOWN_HEADING_RE);
    if (heading) {
      const headingText = heading[2].trim();
      inPlanApproval = isPlanApprovalLabel(
        headingText.replace(QUESTION_PREFIX_RE, ""),
      );
      awaitingNumberedQuestionText =
        !inPlanApproval && NUMBERED_QUESTION_HEADING_RE.test(headingText);
      if (inPlanApproval) {
        foundPlanApproval = true;
        latestAnswer = null;
        latestFingerprint = null;
        latestPlannedSource = null;
      }
      continue;
    }
    if (awaitingNumberedQuestionText && line.trim().length > 0) {
      awaitingNumberedQuestionText = false;
      inPlanApproval = isPlanApprovalLabel(line);
      if (inPlanApproval) {
        foundPlanApproval = true;
        latestAnswer = null;
        latestFingerprint = null;
        latestPlannedSource = null;
      }
    }
    if (!inPlanApproval) continue;
    const answer = line.match(ANSWER_TAG_RE);
    if (answer) latestAnswer = answer[1].trim();
    const fingerprint = line.match(FINGERPRINT_TAG_RE);
    if (fingerprint) latestFingerprint = fingerprint[1] ?? null;
    const plannedSource = line.match(PLANNED_SOURCE_TAG_RE);
    if (plannedSource) latestPlannedSource = plannedSource[1] ?? null;
  }
  return {
    found: foundPlanApproval,
    answer: latestAnswer,
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
): CodeGenerationAuthority {
  return codeGenerationAuthority(projectDir, requestedTarget);
}

function codeGenerationAuthority(
  projectDir: string,
  requestedTarget: CodeGenerationTarget,
  batchPeers?: { units: string[]; markerSha256: string },
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
  if (marker.stage !== "code-generation") {
    throw new Error(
      `Code Generation approval authority does not match active directive stage "${marker.stage}"`,
    );
  }
  if (marker.kind !== "run-stage" && marker.kind !== "invoke-swarm") {
    throw new Error(
      `Code Generation approval authority requires a run-stage or invoke-swarm directive, got "${marker.kind}"`,
    );
  }

  if (target.unit === null) {
    if (marker.kind !== "run-stage" || marker.unit !== undefined) {
      throw new Error(
        "Stage-level Code Generation approval requires a zero-Unit run-stage directive",
      );
    }
  } else if (marker.kind === "run-stage") {
    if (marker.unit !== target.unit && !batchPeers) {
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
          `Code Generation approval target unit "${target.unit}" does not match active directive unit "${marker.unit ?? "(none)"}"`,
        );
      }
      assertPlanApprovalBatchLifecycle(projectDir, receipt);
    }
  } else {
    const dag = resolveBoltDag(projectDir);
    if (
      dag.state !== "ok" ||
      !dag.units.includes(target.unit) ||
      (!marker.units?.includes(target.unit) && !batchPeers)
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
      workspaceSourceFingerprint(projectDir) === plannedSource;
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
    const allEntries = readAuditShardEvents(projectDir);
    type Entry = (typeof allEntries)[number];
    const latestCausal = (candidates: Entry[]): Entry | null => {
      if (candidates.length === 0) return null;
      let latestTimestamp = candidates[0].timestamp;
      for (const candidate of candidates) {
        if (candidate.timestamp > latestTimestamp) latestTimestamp = candidate.timestamp;
      }
      const atLatestTimestamp = candidates.filter(
        (candidate) => candidate.timestamp === latestTimestamp,
      );
      if (new Set(atLatestTimestamp.map((candidate) => candidate.shard)).size !== 1) {
        return null;
      }
      return atLatestTimestamp.reduce((latest, candidate) =>
        candidate.pos > latest.pos ? candidate : latest
      );
    };
    const latestSession = latestCausal(
      allEntries.filter(
        (entry) =>
          entry.event === "SESSION_STARTED" ||
          entry.event === "SESSION_RESUMED",
      ),
    );
    const session = latestSession === null
      ? null
      : auditBlockField(latestSession.block, "Session");
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
  const value: unknown = JSON.parse(
    readRegularFileNoFollowOrThrow(resolve(projectDir, file), "Plan Approval batch manifest").toString("utf-8"),
  );
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
      !response || response.challengeId !== challenge.challengeId || response.choice !== choice
    ) {
      throw new Error("Plan Approval batch requires the actual offered choice from this prompt and session for exactly these plans");
    }
    const source = workspaceSourceState(projectDir);
    if (source === null) throw new PlanApprovalUnbindableError("recorded");
    if (evidence.some((entry) => entry.plannedSourceSha256 !== source.fingerprint)) {
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

function offeredPlanApprovalChoice(
  challenge: PlanApprovalRuntimeChallenge,
  responseText: string,
): "Approve Plan" | "Request Changes" | null {
  // One trailing "(Recommended)" is the Codex label decoration, not part of the
  // human's choice. Nothing else about the match is loosened.
  const response = stripRecommendedDecorator(responseText);
  const comparison = challenge.hashedOptionLabels
    ? createHash("sha256")
      .update(response.toLowerCase(), "utf-8")
      .digest("hex")
    : response.toLowerCase();
  const matchedIndex = challenge.options.findIndex((option) =>
    challenge.hashedOptionLabels
      ? option === comparison
      : option.toLowerCase() === comparison
  );
  if (matchedIndex >= 0) {
    return matchedIndex === 0 ? "Approve Plan" : "Request Changes";
  }
  if (challenge.requireExactOptionLabels) return null;
  if (response === "1") return "Approve Plan";
  if (response === "2") return "Request Changes";
  if (response.toLowerCase() === "approve plan") return "Approve Plan";
  if (response.toLowerCase() === "request changes") return "Request Changes";
  return null;
}

export interface PlanApprovalHumanResponseResult {
  recorded: boolean;
}

export function recordPlanApprovalHumanResponse(
  projectDir: string,
  session: string,
  responseText: string,
): PlanApprovalHumanResponseResult {
  const challenge = readPlanApprovalChallenge(projectDir, session);
  if (challenge) {
    const choice = offeredPlanApprovalChoice(challenge, responseText);
    if (choice) {
      writePlanApprovalResponse(projectDir, {
        version: 1,
        session,
        challengeId: challenge.challengeId,
        choice,
        responseSha256: createHash("sha256")
          .update(responseText.trim(), "utf-8")
          .digest("hex"),
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
}

export interface PlanApprovalOverrideRequestResult {
  recorded: boolean;
}

/**
 * Half A of the break-glass pairing. Called by the human-turn hook ONLY for a
 * typed prompt (the UserPromptSubmit text), never for a picked option arriving
 * through a tool response. The whole trimmed prompt must be the single line
 * `Override Plan Approval: <reason>`; the reason is kept verbatim (trimmed) and
 * its sha256 is what `answer --override` must match for the same session.
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
    response.choice !== choice ||
    !runtimeIdentityMatches(challenge, identity)
  ) {
    throw new Error(
      "Plan Approval requires the actual offered choice from this prompt and session",
    );
  }
  const receiptBarrier =
    process.env.AIDLC_TEST_PLAN_APPROVAL_RECEIPT_BARRIER?.trim();
  if (receiptBarrier) {
    writeFileSync(`${receiptBarrier}.snapshotted`, "snapshotted\n", "utf-8");
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 30_000;
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
  if (sourceBefore !== evidence.plannedSourceSha256) {
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
 * The typed request that authorizes `answer --override` for this session and
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
    throw new Error("Plan Approval requires the current Testing Contract");
  }
  if (artifacts.recordedFingerprint !== artifacts.expectedFingerprint) {
    throw new Error(
      artifacts.recordedFingerprint !== null &&
        !approvalFingerprintIsCurrentFormat(artifacts.recordedFingerprint)
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
  if (!options.breakGlass && currentSource !== plannedSource) {
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
  const result = spawnSync("git", args, { cwd, encoding: "utf-8", timeout: 10_000 });
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
  if (parent === child || approvalPathKey(worktreePath(parent, slug)) !== approvalPathKey(child)) {
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
    worktreeApprovalGit(child, ["symbolic-ref", "--quiet", "HEAD"]) !== `refs/heads/bolt-${slug}` ||
    common !== childCommon || repo.repo !== meta.repoSelector ||
    (meta.gitCommonDirHash !== commonHash &&
      (typeof meta.gitCommonDir !== "string" || approvalPathKey(meta.gitCommonDir) !== common)) ||
    meta.swarmFloor !== floor ||
    auditBlockField(creation.block, "Branch name") !== `bolt-${slug}` ||
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
  return { parent, child, repo, hash: hashObject(creation.block) };
}

function parentWorktreeApproval(parentDir: string, unit: string) {
  const evidence = codeGenerationPlanApprovalQuestionEvidence(
    parentDir, { unit }, join(codeGenerationRecordDir(parentDir, unit), "code-generation-questions.md"),
    "Approve Plan", { breakGlass: true },
  );
  const receipt = readPlanApprovalReceipt(parentDir, runtimeIdentity(evidence));
  if (!receipt || receipt.delegation || receipt.override) {
    throw new Error("Worktree execution requires an ordinary protected parent Plan Approval; chained delegation and overrides cannot certify its source.");
  }
  const approval = evaluateCodeGenerationApproval(parentDir, { unit });
  if (!approval.ok) throw new Error(`Parent Plan Approval is not current: ${approval.reason}`);
  return { evidence, receipt };
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
    const slot = worktreePath(parent, slug);
    assertNoSymlinkInChainOrThrow(parent, relative(parent, slot));
    // Discard has removed the final path component. Resolve the existing
    // parent and reject symlink chains instead of realpath-ing the absent slot.
    const pathKey = (path: string): string => {
      const key = resolve(path).replaceAll("\\", "/");
      return process.platform === "win32" ? key.toLowerCase() : key;
    };
    const namesSlot = (row: AuditShardEvent): boolean => {
      const recorded = auditBlockField(row.block, "Worktree path");
      if (!recorded) return false;
      const resolved = resolveAuditWorktreePath(parent, recorded);
      assertNoSymlinkInChainOrThrow(parent, relative(parent, resolved));
      return pathKey(resolved) === pathKey(slot);
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
      return namesSlot(row) &&
        auditBlockField(row.block, "Branch name") === `bolt-${slug}` &&
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
  if (!parentSource || parentSource.fingerprint !== approved.receipt.certifiedSourceSha256) {
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
 * the protected approval, even when Change Control is relaxed or autonomous.
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
      activeIntentUuid(current.child) !== current.evidence.authority.intentId) {
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
      copied.expectedFingerprint !== current.receipt.fingerprint || !copied.approvedAnswer ||
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

function validateWorktreeDelegation(
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
  const parent = parentWorktreeApproval(provenance.parent, origin.unit);
  const { delegation: _delegation, ...copiedReceipt } = receipt;
  if (provenance.hash !== origin.provenanceSha256 ||
    hashObject(parent.receipt) !== origin.parentReceiptSha256 ||
    hashObject(copiedReceipt) !== hashObject(parent.receipt) ||
    parent.receipt.status !== "generation" || receipt.status !== "generation" ||
    !readBaselineSourceSnapshot(childDir, CODE_GENERATION_STAGE, origin.baselineSha256)) {
    throw new Error("Protected parent Plan Approval or the delegated worktree baseline is no longer current.");
  }
  return provenance.parent;
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
  if (!approval.ok) throw new Error(`Delegated plan is not current: ${approval.reason}`);
  const authority = resolveCodeGenerationAuthority(childDir, { unit });
  validateWorktreeDelegation(childDir, authority, receipt);
  return readBaselineSourceSnapshot(childDir, CODE_GENERATION_STAGE, receipt.delegation.baselineSha256);
}

export function evaluateCodeGenerationApproval(
  projectDir: string,
  target: CodeGenerationTarget,
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
    const authority = resolveCodeGenerationAuthority(projectDir, normalizedTarget);
    empty.directiveEpoch = authority.directiveEpoch;
    const questionsPath = join(authority.stageDir, "code-generation-questions.md");
    const recordedFingerprint = existsSync(questionsPath)
      ? questionsFileApprovalFingerprint(readFileSync(questionsPath, "utf-8")) : null;
    const candidate = recordedFingerprint
      ? readPlanApprovalReceipt(projectDir, { targetId: authority.targetId, runFloor: authority.runFloor, fingerprint: recordedFingerprint })
      : null;
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
    empty.approvalFingerprint = artifacts.expectedFingerprint;
    if (!empty.planExists) {
      empty.reason = "code-generation-plan.md is missing or empty";
      return empty;
    }
    if (!empty.instructionsExist) {
      empty.reason = "unit-test-instructions.md is missing or empty";
      return empty;
    }
    if (artifacts.contractHash === null) {
      empty.reason = "code-generation-plan.md has no valid ## Testing Contract JSON block";
      return empty;
    }
    if (!empty.contractValid) {
      empty.reason =
        "the approved Testing Contract is stale because memory, scope, test strategy, or project type changed";
      return empty;
    }
    if (!empty.approved) {
      empty.reason = "Plan Approval is not explicitly answered Approve Plan";
      return empty;
    }
    empty.fingerprintValid =
      artifacts.expectedFingerprint !== null &&
      artifacts.recordedFingerprint === artifacts.expectedFingerprint;
    if (!empty.fingerprintValid) {
      empty.reason =
        artifacts.recordedFingerprint !== null &&
          !approvalFingerprintIsCurrentFormat(artifacts.recordedFingerprint)
          ? "the recorded Plan Approval fingerprint was written under an earlier format; re-run the fingerprint command, re-present the plan, and approve again"
          : "the Plan Approval fingerprint does not match the active intent, target, stage attempt, plan, test instructions, and Testing Contract; re-run the fingerprint command, re-present the plan, and approve again";
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
      empty.reason =
        `legacy Plan Approval authority was poisoned by unsupported write target "${violation.target}"`;
      return empty;
    }
    const receipt = readPlanApprovalReceipt(projectDir, identity);
    if (receipt?.delegation) {
      if (hashObject(receipt) !== hashObject(candidate)) throw new Error("Worktree approval changed while reading.");
    } else if (receipt?.batch) assertPlanApprovalBatchCurrent(projectDir, receipt);
    // Source that moved after the receipt certified it is the governed drift:
    // strict retires the approval until the human approves again; relaxed keeps
    // it current (generation start records the change and re-baselines the
    // receipt). This evaluation reads and never writes, so it only judges. A
    // break-glass receipt is bound to content and attempt only, so its source
    // is never compared: the human already accepted that the source could not
    // be certified when they typed the override.
    let sourceDrift: string | null = null;
    if (
      receipt !== null &&
      receipt.status !== "generation" &&
      receipt.override === undefined
    ) {
      const current = workspaceSourceState(projectDir);
      if (current === null || current.fingerprint !== receipt.certifiedSourceSha256) {
        const judged = judgePlanSourceDrift(
          projectDir,
          normalizedUnit,
          receipt.certifiedSourceSha256,
          current,
          false,
        );
        if ("refusal" in judged) sourceDrift = judged.refusal.message;
      }
    }
    const sourceCurrent = receipt !== null && sourceDrift === null;
    empty.receiptValid =
      receipt !== null &&
      runtimeIdentityMatches(receipt, identity) &&
      receipt.choice === "Approve Plan" &&
      sourceCurrent;
    if (!empty.receiptValid) {
      if (receipt !== null && sourceDrift !== null) {
        empty.reason = sourceDrift;
        empty.sourceDrift = true;
        return empty;
      }
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
        ? "the Plan Approval receipt for this target belongs to an earlier stage attempt; present the plan again and approve it for the current attempt"
        : "no current protected Plan Approval receipt matches this prompt, session response, target, stage attempt, and plan content";
      return empty;
    }
    return {
      ...empty,
      ok: true,
      reason: "approved",
      ...(receipt?.override !== undefined ? { override: true as const } : {}),
    };
  } catch (error) {
    return {
      ...empty,
      unit: normalizedUnit,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function beginCodeGeneration(
  projectDir: string,
  target: CodeGenerationTarget,
): string[] {
  return withAuditLock(projectDir, () =>
    withActiveDirectiveLock(projectDir, () => {
      const approval = evaluateCodeGenerationApproval(projectDir, target);
      if (!approval.ok || !approval.approvalFingerprint) {
        if (approval.sourceDrift) throw new PlanApprovalSourceDriftError(approval.reason);
        throw new Error(approval.reason || "Code Generation requires Plan Approval");
      }
      const authority = resolveCodeGenerationAuthority(projectDir, target);
      const receiptKey: PlanApprovalReceiptKey = {
        targetId: authority.targetId,
        runFloor: authority.runFloor,
        fingerprint: approval.approvalFingerprint,
      };
      const receipt = readPlanApprovalReceipt(projectDir, receiptKey);
      if (!receipt) {
        throw new Error("Code Generation has no protected approval receipt");
      }
      if (receipt.status === "generation") return [];
      if (receipt.override !== undefined) {
        // A break-glass receipt is bound to content and attempt only. There is
        // no certified source to compare or re-certify, and no race window to
        // close, so the generation boundary is published as the receipt stands.
        // This is the one place an override could have been downgraded to
        // "approve again": it is not.
        writePlanApprovalReceipt(projectDir, { ...receipt, status: "generation" });
        collectStalePlanApprovalReceipts(
          projectDir,
          authority.intentId,
          authority.targetId,
          authority.runFloor,
        );
        return [];
      }
      const stateBefore = workspaceSourceState(projectDir);
      const sourceBefore = stateBefore?.fingerprint ?? null;
      if (sourceBefore === null) {
        throw new PlanApprovalSourceDriftError(planSourceDriftStrictMessage(null, true));
      }
      const changeNotices: string[] = [];
      if (sourceBefore !== receipt.certifiedSourceSha256) {
        // Strict refuses and KEEPS the receipt: deleting the human's recorded
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
        );
        if ("refusal" in judged) throw judged.refusal;
        changeNotices.push(...recordAcceptedChanges(projectDir, [judged.accepted]));
        keepWorkspaceSourceSnapshot(projectDir, stateBefore);
      }
      // Publication is the generation boundary. It sits between two source
      // fingerprints while both authority locks are held: neither another
      // guard nor directive publication can retire this receipt mid-start.
      writePlanApprovalReceipt(projectDir, {
        ...receipt,
        certifiedSourceSha256: sourceBefore,
        status: "generation",
      });
      const publicationBarrier =
        process.env.AIDLC_TEST_PLAN_APPROVAL_PUBLICATION_BARRIER?.trim();
      if (publicationBarrier) {
        writeFileSync(`${publicationBarrier}.published`, "published\n", "utf-8");
        const waitCell = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 30_000;
        while (!existsSync(`${publicationBarrier}.release`)) {
          if (Date.now() >= deadline) {
            writePlanApprovalReceipt(projectDir, { ...receipt, status: "approved" });
            throw new Error(
              "timed out waiting for the Plan Approval publication test barrier",
            );
          }
          Atomics.wait(waitCell, 0, 0, 5);
        }
      }
      const sourceAfter = workspaceSourceFingerprint(projectDir);
      if (sourceAfter === null || sourceAfter !== sourceBefore) {
        // Revert the generation boundary rather than delete the approval: the
        // human's decision is still a fact, only the start is not. This is the
        // race window, not the governed drift, so both Change Control values
        // ask for the step again.
        writePlanApprovalReceipt(projectDir, { ...receipt, status: "approved" });
        throw new Error(
          "Source files changed while code generation was starting. Retry the step.",
        );
      }
      collectStalePlanApprovalReceipts(
        projectDir,
        authority.intentId,
        authority.targetId,
        authority.runFloor,
      );
      return changeNotices;
    }),
  );
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function targetFromArgs(
  args: string[],
  subcommand: "fingerprint" | "verify" | "begin" | "brief",
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

export function main(argv: string[]): void {
  const subcommand = argv.find((arg) =>
    ["resolve", "render", "fingerprint", "verify", "begin", "brief"].includes(arg)
  );
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
        if (
          existsSync(questionsPath) &&
          questionsFileApproved(readFileSync(questionsPath, "utf-8"))
        ) {
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
        console.log(
          `[Approval Fingerprint]: ${
            approvalFingerprint(
              plan,
              instructions,
              current.contract_sha256,
              authority,
            )
          }`,
        );
        console.log(`[Planned Source]: ${plannedSource}`);
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
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 2);
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
        process.stdout.write(assembled.brief);
        return;
      }
      default:
        throw new Error(
          `Unknown subcommand: ${subcommand ?? "(none)"}. Valid: resolve, render, fingerprint, verify, begin, brief`,
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
