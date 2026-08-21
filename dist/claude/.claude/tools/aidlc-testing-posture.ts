// Deterministic Testing Posture contract for Code Generation.
//
// Practices remain human-authored prose, but code generation needs one stable
// execution contract. This module resolves methodology independently from
// coverage/tooling notes, builds a methodology-specific plan profile, binds the
// result to the active scope/test strategy/project type, and fingerprints the
// approved plan + unit test instructions. Both the dispatch guard and autonomous
// swarm referee consume the same contract.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  activeSpace,
  docsRoot,
  getField,
  resolveProjectDir,
  stateFilePath,
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
  unit: string;
  reason: string;
  planExists: boolean;
  instructionsExist: boolean;
  approved: boolean;
  contractValid: boolean;
  fingerprintValid: boolean;
  contractHash: string | null;
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
const CONTRACT_MARKER_RE =
  /^[ \t]*AIDLC-TESTING-CONTRACT[ \t]*:[ \t]*(sha256:[0-9a-f]{64})[ \t]*$/;
const MARKDOWN_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const ANSWER_TAG_RE = /^\[Answer\]:[ \t]*(.*)$/;
const FINGERPRINT_TAG_RE =
  /^\[Approval Fingerprint\]:[ \t]*(sha256:[0-9a-f]{64})?[ \t]*$/;
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
  const space = activeSpace(projectDir);
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
    // Pre-birth and focused tests use deterministic defaults.
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

export function approvalFingerprint(
  plan: string,
  instructions: string,
  contractHash: string,
): string {
  return hashObject({
    plan,
    instructions,
    testing_contract: contractHash,
  });
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

function visibleMarkdownLines(body: string): string[] {
  const lines = body.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const visible: string[] = [];
  let inComment = false;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const rawLine of lines) {
    if (fence) {
      const closing = /^ {0,3}([`~]+)[ \t]*$/.exec(rawLine);
      if (
        closing &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      visible.push("");
      continue;
    }
    let line = "";
    let cursor = 0;
    while (cursor < rawLine.length) {
      if (inComment) {
        const end = rawLine.indexOf("-->", cursor);
        if (end < 0) {
          cursor = rawLine.length;
          break;
        }
        inComment = false;
        cursor = end + 3;
        continue;
      }
      const start = rawLine.indexOf("<!--", cursor);
      if (start < 0) {
        line += rawLine.slice(cursor);
        break;
      }
      line += rawLine.slice(cursor, start);
      inComment = true;
      cursor = start + 4;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = {
        marker: opening[1][0] as "`" | "~",
        length: opening[1].length,
      };
      visible.push("");
      continue;
    }
    visible.push(line);
  }
  return visible;
}

function latestPlanApproval(body: string): {
  found: boolean;
  answer: string | null;
  fingerprint: string | null;
} {
  let inPlanApproval = false;
  let awaitingNumberedQuestionText = false;
  let foundPlanApproval = false;
  let latestAnswer: string | null = null;
  let latestFingerprint: string | null = null;

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
      }
    }
    if (!inPlanApproval) continue;
    const answer = line.match(ANSWER_TAG_RE);
    if (answer) latestAnswer = answer[1].trim();
    const fingerprint = line.match(FINGERPRINT_TAG_RE);
    if (fingerprint) latestFingerprint = fingerprint[1] ?? null;
  }
  return {
    found: foundPlanApproval,
    answer: latestAnswer,
    fingerprint: latestFingerprint,
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

export function promptTestingContractMarkers(text: string): string[] {
  const hashes = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(CONTRACT_MARKER_RE);
    if (marker) hashes.add(marker[1]);
  }
  return Array.from(hashes);
}

export function evaluateCodeGenerationApproval(
  projectDir: string,
  unit: string,
): CodeGenerationApproval {
  const stageDir = join(
    docsRoot(projectDir),
    "construction",
    unit,
    "code-generation",
  );
  const planPath = join(stageDir, "code-generation-plan.md");
  const instructionsPath = join(stageDir, "unit-test-instructions.md");
  const questionsPath = join(stageDir, "code-generation-questions.md");
  const empty: CodeGenerationApproval = {
    ok: false,
    unit,
    reason: "",
    planExists: false,
    instructionsExist: false,
    approved: false,
    contractValid: false,
    fingerprintValid: false,
    contractHash: null,
  };
  try {
    const plan = existsSync(planPath) ? readFileSync(planPath, "utf-8") : "";
    const instructions = existsSync(instructionsPath)
      ? readFileSync(instructionsPath, "utf-8")
      : "";
    const questions = existsSync(questionsPath)
      ? readFileSync(questionsPath, "utf-8")
      : "";
    empty.planExists = plan.trim().length > 0;
    empty.instructionsExist = instructions.trim().length > 0;
    empty.approved = questionsFileApproved(questions);
    if (!empty.planExists) {
      empty.reason = "code-generation-plan.md is missing or empty";
      return empty;
    }
    if (!empty.instructionsExist) {
      empty.reason = "unit-test-instructions.md is missing or empty";
      return empty;
    }
    const embedded = parseTestingContract(plan);
    if (!embedded) {
      empty.reason = "code-generation-plan.md has no valid ## Testing Contract JSON block";
      return empty;
    }
    const current = resolveTestingPosture(projectDir);
    empty.contractHash = embedded.contract_sha256;
    empty.contractValid =
      embedded.contract_sha256 === current.contract_sha256;
    if (!empty.contractValid) {
      empty.reason =
        "the approved Testing Contract is stale because memory, scope, test strategy, or project type changed";
      return empty;
    }
    if (!empty.approved) {
      empty.reason = "Plan Approval is not explicitly answered Approve Plan";
      return empty;
    }
    const recordedFingerprint =
      questionsFileApprovalFingerprint(questions);
    const expectedFingerprint = approvalFingerprint(
      plan,
      instructions,
      current.contract_sha256,
    );
    empty.fingerprintValid = recordedFingerprint === expectedFingerprint;
    if (!empty.fingerprintValid) {
      empty.reason =
        "the Plan Approval fingerprint does not match the current plan, test instructions, and Testing Contract";
      return empty;
    }
    return { ...empty, ok: true, reason: "approved" };
  } catch (error) {
    return {
      ...empty,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function main(argv: string[]): void {
  let subcommand: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (
        !argv[i].includes("=") &&
        i + 1 < argv.length &&
        !argv[i + 1].startsWith("--")
      ) {
        i++;
      }
      continue;
    }
    subcommand = argv[i];
    break;
  }
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
        const unit = flagValue(argv, "--unit");
        if (!unit) throw new Error("fingerprint requires --unit <unit>");
        const approval = evaluateCodeGenerationApproval(projectDir, unit);
        const stageDir = join(
          docsRoot(projectDir),
          "construction",
          unit,
          "code-generation",
        );
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
        console.log(
          approvalFingerprint(
            plan,
            instructions,
            current.contract_sha256,
          ),
        );
        return;
      }
      case "verify": {
        const unit = flagValue(argv, "--unit");
        if (!unit) throw new Error("verify requires --unit <unit>");
        const result = evaluateCodeGenerationApproval(projectDir, unit);
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.ok ? 0 : 2);
        return;
      }
      default:
        throw new Error(
          `Unknown subcommand: ${subcommand ?? "(none)"}. Valid: resolve, render, fingerprint, verify`,
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
