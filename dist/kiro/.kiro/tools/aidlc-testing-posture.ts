// Deterministic Testing Posture contract for Code Generation.
//
// Practices remain human-authored prose, but code generation needs one stable
// execution contract. This module resolves methodology independently from
// coverage/tooling notes, builds a methodology-specific plan profile, binds the
// result to the active scope/test strategy/project type, and fingerprints the
// approved plan + unit test instructions. Both the dispatch guard and autonomous
// swarm referee consume the same contract.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  auditBlockField,
  collectStalePlanApprovalReceipts,
  contentBeforeTerminalReviewAppendix,
  docsRoot,
  getField,
  latestMainWorkflowStageRunFloorForProject,
  LEGACY_PLAN_APPROVAL_RECOVERY_CHOICE,
  clearPlanApprovalChallenge,
  clearPlanApprovalLegacyOffer,
  clearPlanApprovalReceipt,
  readActiveDirectiveMarker,
  readAuditShardEvents,
  readPlanApprovalChallenge,
  readPlanApprovalLegacyOffer,
  readPlanApprovalLegacyRecoveryChallenge,
  readPlanApprovalReceipt,
  readPlanApprovalResponse,
  readPlanApprovalViolation,
  resolveBoltDag,
  resolveProjectDir,
  stalePlanApprovalReceiptsForTarget,
  resolveWorkflowSelection,
  stateFilePath,
  toPosix,
  UNBINDABLE_FINGERPRINT,
  validateUnitName,
  visibleMarkdownLines,
  withActiveDirectiveLock,
  withAuditLock,
  workspaceSourceFingerprint,
  writePlanApprovalChallenge,
  writePlanApprovalLegacyRecoveryResponse,
  writePlanApprovalReceipt,
  writePlanApprovalResponse,
  type PlanApprovalReceiptKey,
  type PlanApprovalRuntimeChallenge,
  type PlanApprovalRuntimeIdentity,
  type PlanApprovalRuntimeProvenance,
  type PlanApprovalRuntimeReceipt,
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
// The recorded fingerprint tag. `sha256:v2:<hex>` is the content-bound format;
// the bare `sha256:<hex>` shape is still matched so a questions file written
// before this change is READ and reported as "approve again" rather than looking
// like a line the parser does not understand.
const FINGERPRINT_TAG_RE =
  /^\[Approval Fingerprint\]:[ \t]*(sha256:(?:v2:)?[0-9a-f]{64})?[ \t]*$/;
// The workspace source the plan was written against, recorded by the fingerprint
// command so drift between planning and approval is caught with a remedy the
// conductor can always execute.
const PLANNED_SOURCE_TAG_RE =
  /^\[Planned Source\]:[ \t]*([0-9a-f]{40}|[0-9a-f]{64}|unbindable)?[ \t]*$/;
export const APPROVAL_FINGERPRINT_PREFIX = "sha256:v2:";

export function approvalFingerprintIsCurrentFormat(tag: string | null): boolean {
  return tag?.startsWith(APPROVAL_FINGERPRINT_PREFIX) === true;
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

function structuredField(section: string, field: string): string | null {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = section.match(
    new RegExp(
      `^[ \\t]*(?:[-*][ \\t]*)?(?:\\*\\*)?${escaped}(?:\\*\\*)?[ \\t]*:[ \\t]*(.+?)[ \\t]*$`,
      "im",
    ),
  );
  return match?.[1].trim() || null;
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
// The approval must survive the edits the stage itself ORDERS after approval, and
// must not survive an edit to the plan. Byte-exact hashing cannot do both: Step 4
// tells the developer agent to tick the plan's checkboxes as it works, and the
// reviewer appends `## Review` to that same file because the plan IS the stage's
// review artifact. Hashing raw bytes therefore invalidated every approval as soon
// as the approved work started.
//
// So the fingerprint is taken over a projection that erases exactly those two
// mandated mutations and nothing else:
//
//   1. A TERMINAL `## Review` appendix is removed, using the engine's own
//      appendix locator (a `## Review` inside a fence or an HTML comment, a
//      lower-case or unspaced variant, and a mid-plan section are all NOT an
//      appendix and stay material).
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
// review appendix. That is closed elsewhere: the stage hands the developer agent
// the plan BODY (this projection's input), so a step smuggled into the appendix is
// never delivered as work.
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

// The value recorded as `[Approval Fingerprint]:`. It binds CONTENT (the
// projected plan and unit-test instructions plus the Testing Contract hash) to
// PLACE (target, intent) and to ATTEMPT (the run floor). The tag carries a format
// version so a value recorded under the previous, issuance-bound scheme is
// recognised and answered with "approve again" instead of an unexplained
// mismatch.
export function approvalFingerprint(
  plan: string,
  instructions: string,
  contractHash: string,
  authority: Pick<CodeGenerationAuthority, "targetId" | "intentId" | "runFloor">,
): string {
  const digest = hashObject({
    plan: projectPlanApprovalContent(plan),
    instructions: projectPlanApprovalContent(instructions),
    testing_contract: contractHash,
    target: authority.targetId,
    intent: authority.intentId,
    run_floor: authority.runFloor,
  });
  return `${APPROVAL_FINGERPRINT_PREFIX}${digest.slice("sha256:".length)}`;
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
    if (marker.unit !== target.unit) {
      throw new Error(
        `Code Generation approval target unit "${target.unit}" does not match active directive unit "${marker.unit ?? "(none)"}"`,
      );
    }
  } else {
    const dag = resolveBoltDag(projectDir);
    if (
      dag.state !== "ok" ||
      !dag.units.includes(target.unit) ||
      !marker.units?.includes(target.unit)
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
    getField(state, "Construction Iteration")?.trim() === "unit-major",
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
  const current = planExists ? resolveTestingPosture(projectDir) : null;
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
 * hard-stops while that prompt awaits a human, and the decision/answer commands
 * separately require workspace source to match the directive-issued floor.
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
    const currentSource = workspaceSourceFingerprint(projectDir);
    const sourceFloorValid =
      authority.sourceFloor !== UNBINDABLE_FINGERPRINT &&
      currentSource !== null &&
      currentSource === authority.sourceFloor;
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

    const artifacts = codeGenerationApprovalArtifacts(projectDir, authority);
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
  const response = responseText.trim();
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

export function recordPlanApprovalReceipt(
  projectDir: string,
  evidence: PlanApprovalQuestionEvidence,
  session: string,
  choice: "Approve Plan" | "Request Changes",
): PlanApprovalRuntimeReceipt | null {
  return withActiveDirectiveLock(projectDir, () => {
  const identity = runtimeIdentity(evidence);
  const provenance = runtimeProvenance(evidence);
  const challenge = readPlanApprovalChallenge(projectDir, session);
  const response = readPlanApprovalResponse(projectDir, session);
  if (
    !challenge ||
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
    // because nothing else about the identity had moved.
    clearPlanApprovalChallenge(projectDir, session);
    clearPlanApprovalReceipt(projectDir, identity);
    return null;
  }
  const sourceBefore = workspaceSourceFingerprint(projectDir);
  if (
    sourceBefore === null ||
    sourceBefore !== evidence.plannedSourceSha256
  ) {
    throw new Error(
      "Plan Approval requires workspace source to match the source recorded when this plan was fingerprinted. " +
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
  const sourceAfter = workspaceSourceFingerprint(projectDir);
  if (sourceAfter === null || sourceAfter !== sourceBefore) {
    clearPlanApprovalReceipt(projectDir, identity);
    throw new Error(
      "Plan Approval source changed during receipt certification; present the current plan again",
    );
  }
  clearPlanApprovalChallenge(projectDir, session);
  // Sweep this target's receipts from attempts that have ended. Nothing deletes a
  // receipt to invalidate it any more, so the store is tidied here instead.
  collectStalePlanApprovalReceipts(
    projectDir,
    identity.intentId,
    identity.targetId,
    identity.runFloor,
  );
  return receipt;
  });
}

export function codeGenerationPlanApprovalQuestionEvidence(
  projectDir: string,
  target: CodeGenerationTarget,
  suppliedQuestionsFile: string,
  expectedAnswer: "" | "Approve Plan" | "Request Changes",
): PlanApprovalQuestionEvidence {
  const authority = resolveCodeGenerationAuthority(projectDir, target);
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
        ? "The recorded Plan Approval fingerprint predates the content-bound format. " +
            "Re-run the fingerprint command, re-present the plan, and approve again."
        : "Plan Approval fingerprint does not match the active intent, target, stage attempt, plan, instructions, and Testing Contract",
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
  const plannedSource = latest.plannedSource;
  if (plannedSource === null) {
    throw new Error(
      "Plan Approval requires a [Planned Source]: tag in the Plan Approval section. " +
        "Re-run the fingerprint command, record both tags it prints, and re-present the plan.",
    );
  }
  const currentSource = workspaceSourceFingerprint(projectDir);
  if (
    plannedSource !== UNBINDABLE_FINGERPRINT &&
    (currentSource === null || currentSource !== plannedSource)
  ) {
    throw new Error(
      "Workspace source changed after this plan was fingerprinted. " +
        "Re-run the fingerprint command and re-present the plan.",
    );
  }
  return {
    authority,
    fingerprint: artifacts.expectedFingerprint,
    questionsPath: suppliedPath,
    questionsRelativePath: toPosix(relative(projectDir, suppliedPath)),
    questionsSha256: createHash("sha256")
      .update(artifacts.questions, "utf-8")
      .digest("hex"),
    promptSha256: createHash("sha256")
      .update(
        `${artifacts.questions
          .replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:")
          .trimEnd()}\n`,
        "utf-8",
      )
      .digest("hex"),
    plannedSourceSha256: plannedSource,
  };
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
    const artifacts = codeGenerationApprovalArtifacts(projectDir, authority);
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
          ? "the recorded Plan Approval fingerprint predates the content-bound format; re-run the fingerprint command, re-present the plan, and approve again"
          : "the Plan Approval fingerprint does not match the active intent, target, stage attempt, plan, test instructions, and Testing Contract";
      return empty;
    }
    const questionsSha256 = createHash("sha256")
      .update(artifacts.questions, "utf-8")
      .digest("hex");
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
    const sourceCurrent =
      receipt !== null &&
      (
        receipt.status === "generation" ||
        workspaceSourceFingerprint(projectDir) === receipt.certifiedSourceSha256
      );
    empty.receiptValid =
      receipt !== null &&
      runtimeIdentityMatches(receipt, identity) &&
      receipt.choice === "Approve Plan" &&
      receipt.questionsSha256 === questionsSha256 &&
      sourceCurrent;
    if (!empty.receiptValid) {
      if (receipt !== null && !sourceCurrent) {
        empty.reason =
          "workspace source changed after this plan was approved and before generation began; approve again (that re-baselines the source this plan is bound to)";
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
    return { ...empty, ok: true, reason: "approved" };
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
): void {
  withAuditLock(projectDir, () => {
    withActiveDirectiveLock(projectDir, () => {
      const approval = evaluateCodeGenerationApproval(projectDir, target);
      if (!approval.ok || !approval.approvalFingerprint) {
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
      if (receipt.status === "generation") return;
      const sourceBefore = workspaceSourceFingerprint(projectDir);
      if (
        sourceBefore === null ||
        sourceBefore !== receipt.certifiedSourceSha256
      ) {
        // Refuse and KEEP the receipt. Deleting the human's recorded decision
        // because the workspace moved turned a recoverable drift into a state with
        // no way back: the remedy is a fresh approval, which re-baselines the
        // source this plan is bound to.
        throw new Error(
          "Workspace source changed after Plan Approval and before generation began. " +
            "Re-run the fingerprint command to refresh `[Planned Source]`, then approve " +
            "again (that re-baselines the source this plan is bound to).",
        );
      }
      // Publication is the generation boundary. It sits between two source
      // fingerprints while both authority locks are held: neither another
      // guard nor directive publication can retire this receipt mid-start.
      writePlanApprovalReceipt(projectDir, {
        ...receipt,
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
        // human's decision is still a fact, only the start is not.
        writePlanApprovalReceipt(projectDir, { ...receipt, status: "approved" });
        throw new Error(
          "Workspace source changed while Code Generation authority was starting. " +
            "Re-run the fingerprint command to refresh `[Planned Source]`, then approve " +
            "again (that re-baselines the source this plan is bound to).",
        );
      }
      collectStalePlanApprovalReceipts(
        projectDir,
        authority.intentId,
        authority.targetId,
        authority.runFloor,
      );
    });
  });
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function targetFromArgs(
  args: string[],
  subcommand: "fingerprint" | "verify" | "begin",
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
    ["resolve", "render", "fingerprint", "verify", "begin"].includes(arg)
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
        const plannedSource =
          workspaceSourceFingerprint(projectDir) ?? UNBINDABLE_FINGERPRINT;
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
        beginCodeGeneration(projectDir, target);
        console.log(JSON.stringify({ status: "generation", target }));
        return;
      }
      default:
        throw new Error(
          `Unknown subcommand: ${subcommand ?? "(none)"}. Valid: resolve, render, fingerprint, verify, begin`,
        );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
