import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  errorMessage,
  getField,
  parseCheckboxes,
  parseStateStageSuffixes,
  readStateFile,
  recordDir,
  resolveBoltDag,
  resolveProjectDir,
  usesStageLevelPerUnitArtifacts,
} from "./aidlc-lib.ts";

const VALID_STATUSES = new Set(["OK", "GAP", "ORPHAN", "Deferred", "N/A"]);

interface CoverageEntry {
  id: string;
  status: string;
  target?: string;
}

interface TraceabilityData {
  stage?: string;
  unit?: string;
  upstream_ids: string[];
  coverage: CoverageEntry[];
  reverse: CoverageEntry[];
}

interface Result {
  pass: boolean;
  gaps: string[];
  orphans: string[];
  missing_from_table: string[];
  missing_from_upstream_ids: string[];
  invalid_entries: string[];
  invalid_targets: string[];
  findings_count: number;
  reason?: string;
}

interface Flags {
  outputPath?: string;
  stage?: string;
}

interface UnitContext {
  unitName: string;
  units: string[];
  unitIds: Map<string, string>;
}

interface UpstreamResolution {
  ids: Set<string>;
  reasons: string[];
  extraGaps: string[];
  unitContext?: UnitContext;
  storyAssignments?: Map<string, Set<string>>;
}

const ID_PATTERNS = {
  FR: /\bFR\d+(?:\.\d+)?\b/g,
  NFR: /\bNFR\d+\b(?!\.\d)/g,
  NFR_DETAIL: /\bNFR\d+\.\d+\b/g,
  US: /\bUS\d+\.\d+\b/g,
  AC: /\bAC\d+\.\d+\.\d+\b/g,
  BR: /\bBR\d+\.\d+\b/g,
};

function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--stage") out.stage = argv[++i];
    else if (arg === "--output-path") out.outputPath = argv[++i];
  }
  return out;
}

function fail(message: string): never {
  process.stderr.write(`aidlc-sensor-traceability: ${message}\n`);
  process.exit(1);
}

function emit(result: Result): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function failedResult(reason: string): Result {
  return {
    pass: false,
    gaps: [],
    orphans: [],
    missing_from_table: [],
    missing_from_upstream_ids: [],
    invalid_entries: [],
    invalid_targets: [],
    findings_count: 1,
    reason,
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function validateEntry(value: unknown, field: string, index: number): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${field}[${index}] must be an object`;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.trim() === "") {
    return `${field}[${index}].id must be a non-empty string`;
  }
  if (typeof entry.status !== "string" || entry.status.trim() === "") {
    return `${field}[${index}].status must be a non-empty string`;
  }
  if ("target" in entry && entry.target !== undefined && typeof entry.target !== "string") {
    return `${field}[${index}].target must be a string when present`;
  }
  return null;
}

function validateTraceability(value: unknown): { ok: true; data: TraceabilityData } | { ok: false; reason: string } {
  if (value === undefined) return { ok: false, reason: "invalid JSON in traceability file" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "traceability.json must contain a JSON object" };
  }
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.upstream_ids) || !obj.upstream_ids.every((id) => typeof id === "string" && id.trim() !== "")) {
    return { ok: false, reason: "upstream_ids must be an array of non-empty strings" };
  }
  if (!Array.isArray(obj.coverage)) {
    return { ok: false, reason: "coverage must be an array" };
  }
  if ("reverse" in obj && !Array.isArray(obj.reverse)) {
    return { ok: false, reason: "reverse must be an array when present" };
  }
  const reverse = (obj.reverse ?? []) as unknown[];
  for (const [field, entries] of [["coverage", obj.coverage], ["reverse", reverse]] as const) {
    for (let i = 0; i < entries.length; i++) {
      const error = validateEntry(entries[i], field, i);
      if (error) return { ok: false, reason: error };
    }
  }
  if ("stage" in obj && obj.stage !== undefined && typeof obj.stage !== "string") {
    return { ok: false, reason: "stage must be a string when present" };
  }
  if ("unit" in obj && obj.unit !== undefined && typeof obj.unit !== "string") {
    return { ok: false, reason: "unit must be a string when present" };
  }
  return {
    ok: true,
    data: {
      stage: obj.stage as string | undefined,
      unit: obj.unit as string | undefined,
      upstream_ids: obj.upstream_ids as string[],
      coverage: obj.coverage as CoverageEntry[],
      reverse: reverse as CoverageEntry[],
    },
  };
}

function readText(path: string): { content: string | null; reason?: string } {
  try {
    if (!existsSync(path)) return { content: null, reason: `required upstream artifact is missing: ${path}` };
    if (!statSync(path).isFile()) return { content: null, reason: `required upstream artifact is not a file: ${path}` };
    return { content: readFileSync(path, "utf-8") };
  } catch (error) {
    return { content: null, reason: `cannot read upstream artifact ${path}: ${errorMessage(error)}` };
  }
}

function extractIds(content: string, patterns: RegExp[]): Set<string> {
  const ids = new Set<string>();
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, "g");
    for (const match of content.matchAll(regex)) ids.add(match[0]);
  }
  return ids;
}

function tracedParent(id: string): string | undefined {
  return /^((?:FR|NFR)\d+)\.\d+$/.exec(id)?.[1];
}

// A requirement whose sub-requirements are traced too (FR1 beside FR1.1, or at
// Code Generation NFR1 beside the Unit's NFR1.1) is traced through them, so it
// needs no row of its own; a sub-requirement left out is still reported.
function withoutTracedParents(ids: Set<string>): Set<string> {
  const parents = new Set<string>();
  for (const id of ids) {
    const parent = tracedParent(id);
    if (parent) parents.add(parent);
  }
  return new Set([...ids].filter((id) => !parents.has(id)));
}

// A criterion `AC{g}.{s}.{c}` belongs to the story `US{g}.{s}`.
function criteriaOfStories(storiesContent: string, stories: Set<string>): Set<string> {
  const criteria = new Set<string>();
  for (const ac of extractIds(storiesContent, [ID_PATTERNS.AC])) {
    const [group, story] = ac.slice(2).split(".");
    if (stories.has(`US${group}.${story}`)) criteria.add(ac);
  }
  return criteria;
}

function idsFromFile(path: string, patterns: RegExp[], label: string): { ids: Set<string>; reason?: string } {
  const read = readText(path);
  if (read.content === null) return { ids: new Set(), reason: read.reason };
  const ids = extractIds(read.content, patterns);
  if (ids.size === 0) return { ids, reason: `${label} contains no traceable IDs: ${path}` };
  return { ids };
}

function extractUnitName(outputPath: string): string | null {
  const normalized = normalizePath(outputPath);
  const match = normalized.match(/\/construction\/([^/]+)\/[^/]+\/traceability\.json$/);
  return match?.[1] ?? null;
}

// When the plan has no Units, the engine writes every per-Unit stage's
// artifacts directly under construction/<stage>/, with no Unit segment. A path
// that names the stage's own folder is that location, so any per-Unit stage
// with a resolver below is covered without a second stage list.
function isZeroUnitOutput(stage: string, outputPath: string): boolean {
  return stage !== "" &&
    normalizePath(outputPath).endsWith(`/construction/${stage}/traceability.json`);
}

// Per-Unit artifacts live under construction/<unit>/<stage>/; a zero-Unit run
// keeps the stage-level construction/<stage>/ location.
function constructionDir(docsDir: string, unit: string, stage: string): string {
  return unit ? join(docsDir, "construction", unit, stage) : join(docsDir, "construction", stage);
}

function unitLabel(unit: string): string {
  return unit ? `unit "${unit}"` : "the zero-Unit run";
}

function readPlanState(projectDir: string): string | null {
  try {
    return readStateFile(projectDir);
  } catch {
    return null;
  }
}

// The engine places per-Unit artifacts at stage level whenever the approved
// plan skips Units Generation, and then ignores any Unit DAG left on disk (for
// example after a scope change). Follow the plan when the state records it.
function planSkipsUnits(stateContent: string | null): boolean {
  if (stateContent === null || !parseStateStageSuffixes(stateContent).has("units-generation")) return false;
  return usesStageLevelPerUnitArtifacts(getField(stateContent, "Scope"), stateContent);
}

// True when the approved plan (a SKIP suffix) or the run (a skipped [S]
// checkbox) left the stage out. No readable state, or no Stage Progress line,
// counts as having run, so that stage's missing files still fail closed.
function stageDidNotRun(stateContent: string | null, slug: string): boolean {
  if (stateContent === null) return false;
  if (parseStateStageSuffixes(stateContent).get(slug) === "SKIP") return true;
  return parseCheckboxes(stateContent).some((entry) => entry.slug === slug && entry.state === "skipped");
}

const NFR_REQUIREMENT_FILES = ["performance-requirements.md", "security-requirements.md", "scalability-requirements.md", "reliability-requirements.md"];
const NFR_DESIGN_FILES = ["performance-design.md", "security-design.md", "scalability-design.md", "reliability-design.md", "logical-components.md"];

// NFRx.y IDs from one NFR stage's artifacts, or null when none of them exists.
function detailedNfrIds(dir: string, names: string[]): Set<string> | null {
  let sawFile = false;
  const ids = new Set<string>();
  for (const name of names) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    sawFile = true;
    const read = readText(path);
    if (read.content !== null) {
      for (const id of extractIds(read.content, [ID_PATTERNS.NFR_DETAIL])) ids.add(id);
    }
  }
  return sawFile ? ids : null;
}

// Inline code is formatting, not part of a name: a cell such as
// `` `U1` / `u1-ledger`; `U2` / `u2-api` `` names U1 and U2 (#2488).
function markdownCells(line: string): string[] {
  if (!line.trimStart().startsWith("|") || /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return [];
  return line.split("|").slice(1, -1).map((cell) => cell.replaceAll("`", "").trim());
}

// The stage guidance names a Unit's directory `u{n}-{description}` while the
// edge block may name the Unit without that prefix (the engine names
// construction/<unit>/ after the edge block), so a cell names a Unit when it is
// the name, the backticked name, or the name behind a `u{n}-` prefix.
function namesUnit(cell: string, unit: string): boolean {
  const bare = cell.trim().replace(/^`(.*)`$/, "$1");
  return bare === unit || bare.replace(/^u\d+-/i, "") === unit;
}

function unitIdMap(unitFile: string, units: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const read = readText(unitFile);
  if (read.content === null) return map;
  for (const line of read.content.split(/\r?\n/)) {
    const cells = markdownCells(line);
    if (cells.length === 0) continue;
    const id = cells.flatMap((cell) => cell.match(/\bU\d+\b/gi) ?? [])[0]?.toUpperCase();
    if (!id) continue;
    const unit = units.find((candidate) => cells.some((cell) => namesUnit(cell, candidate)));
    if (unit) map.set(unit, id);
  }
  return map;
}

function tokenPresent(cell: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s,;/])${escaped}(?:$|[\\s,;/])`, "i").test(cell);
}

// `idPatterns` follow the stage's source fallback: US rows when stories.md
// exists; otherwise FR rows plus any NFR rows the map also carries.
function storyAssignments(storyMapPath: string, units: string[], ids: Map<string, string>, idPatterns: RegExp[]): { assignments: Map<string, Set<string>>; reason?: string } {
  const read = readText(storyMapPath);
  if (read.content === null) return { assignments: new Map(), reason: read.reason };
  const assignments = new Map<string, Set<string>>();
  for (const line of read.content.split(/\r?\n/)) {
    const cells = markdownCells(line);
    if (cells.length === 0) continue;
    const stories = extractIds(line, idPatterns);
    if (stories.size === 0) continue;
    for (const unit of units) {
      const aliases = [unit, ids.get(unit)].filter((value): value is string => value !== undefined);
      if (!cells.some((cell) => aliases.some((alias) => tokenPresent(cell, alias)) || namesUnit(cell, unit))) continue;
      for (const story of stories) {
        const mapped = assignments.get(story) ?? new Set<string>();
        mapped.add(unit);
        assignments.set(story, mapped);
      }
    }
  }
  return assignments.size === 0
    ? { assignments, reason: `unit-of-work-story-map.md contains no story-to-unit mappings: ${storyMapPath}` }
    : { assignments };
}

function resolveUnitContext(
  projectDir: string,
  outputPath: string,
  docsDir: string,
  stage: string,
  stateContent: string | null,
): { context?: UnitContext; reason?: string } {
  const unitName = extractUnitName(outputPath);
  if (!unitName && !isZeroUnitOutput(stage, outputPath)) {
    return { reason: `cannot derive the construction unit from output path: ${outputPath}` };
  }
  if (!unitName && planSkipsUnits(stateContent)) {
    return { context: { unitName: "", units: [], unitIds: new Map() } };
  }
  const dag = resolveBoltDag(projectDir);
  if (dag.state === "malformed") {
    return { reason: `unit-of-work-dependency.md is ${dag.reason}: ${dag.detail}` };
  }
  if (!unitName) {
    if (dag.state === "ok") {
      return { reason: `cannot derive the construction unit from output path while unit-of-work-dependency.md declares Units: ${outputPath}` };
    }
    return { context: { unitName: "", units: [], unitIds: new Map() } };
  }
  const units = dag.state === "ok" ? dag.units : [unitName];
  if (dag.state === "ok" && !units.includes(unitName)) {
    return { reason: `unit "${unitName}" is not declared in unit-of-work-dependency.md` };
  }
  return {
    context: {
      unitName,
      units,
      unitIds: unitIdMap(join(docsDir, "inception", "units-generation", "unit-of-work.md"), units),
    },
  };
}

function addSource(result: UpstreamResolution, source: { ids: Set<string>; reason?: string }): Set<string> {
  if (source.reason) result.reasons.push(source.reason);
  for (const id of source.ids) result.ids.add(id);
  return source.ids;
}

// Without stories the story map carries FR rows (and optional NFR rows) keyed to
// a Unit, the join Units Generation verifies; a Unit's own stage traces exactly
// its rows, so another Unit's requirements are never asked of it (#2282). The
// requirements-wide set stays for a run with no Unit or no story map.
function addUnitRows(result: UpstreamResolution, storyMap: string, context: UnitContext, patterns: RegExp[]): void {
  const mapped = storyAssignments(storyMap, context.units, context.unitIds, patterns);
  if (mapped.reason) result.reasons.push(mapped.reason);
  for (const [id, units] of mapped.assignments) {
    if (units.has(context.unitName)) result.ids.add(id);
  }
}

// NFR Design traces NFR Requirements' NFRx.y IDs; Infrastructure Design traces
// NFR Design's, or NFR Requirements' when NFR Design did not run. Without NFR
// Requirements no NFRx.y IDs exist, so both trace the NFRn IDs in
// requirements.md, as nfr-requirements itself does. A source stage that ran
// but left no artifacts still fails closed.
function resolveNfrUpstream(
  result: UpstreamResolution,
  stage: "nfr-design" | "infrastructure-design",
  docsDir: string,
  unit: string,
  requirements: string,
  stateContent: string | null,
): void {
  const requirementsDir = constructionDir(docsDir, unit, "nfr-requirements");
  const requirementIds = detailedNfrIds(requirementsDir, NFR_REQUIREMENT_FILES);
  const requirementsRan = requirementIds !== null || !stageDidNotRun(stateContent, "nfr-requirements");
  let source = { label: "NFR requirement", dir: requirementsDir, ids: requirementIds, ran: requirementsRan };
  if (stage === "infrastructure-design") {
    const designDir = constructionDir(docsDir, unit, "nfr-design");
    const designIds = detailedNfrIds(designDir, NFR_DESIGN_FILES);
    if (designIds !== null || !stageDidNotRun(stateContent, "nfr-design")) {
      source = { label: "NFR design", dir: designDir, ids: designIds, ran: true };
    }
  }
  if (source.ids === null) {
    if (source.ran) {
      result.reasons.push(`required upstream ${source.label} artifacts are missing under ${source.dir}`);
    } else {
      addSource(result, idsFromFile(requirements, [ID_PATTERNS.NFR], "requirements.md"));
    }
    return;
  }
  if (!requirementsRan) {
    addSource(result, idsFromFile(requirements, [ID_PATTERNS.NFR], "requirements.md"));
    return;
  }
  for (const id of source.ids) result.ids.add(id);
  if (source.ids.size === 0) {
    result.reasons.push(`${source.label} artifacts for ${unitLabel(unit)} contain no NFRx.y IDs`);
  }
}

function resolveUpstream(stage: string, projectDir: string, outputPath: string): UpstreamResolution {
  const result: UpstreamResolution = { ids: new Set(), reasons: [], extraGaps: [] };
  const docsDir = recordDir(projectDir);
  if (!docsDir) {
    result.reasons.push("cannot resolve the active intent record directory");
    return result;
  }
  const requirements = join(docsDir, "inception", "requirements-analysis", "requirements.md");
  const stories = join(docsDir, "inception", "user-stories", "stories.md");
  const storyMap = join(docsDir, "inception", "units-generation", "unit-of-work-story-map.md");

  if (stage === "user-stories") {
    addSource(result, idsFromFile(requirements, [ID_PATTERNS.FR, ID_PATTERNS.NFR], "requirements.md"));
    return result;
  }
  if (stage === "domain-design") {
    addSource(
      result,
      existsSync(stories)
        ? idsFromFile(stories, [ID_PATTERNS.US], "stories.md")
        : idsFromFile(requirements, [ID_PATTERNS.FR], "requirements.md"),
    );
    return result;
  }
  if (stage === "units-generation") {
    const hasStories = existsSync(stories);
    const source = hasStories
      ? idsFromFile(stories, [ID_PATTERNS.US], "stories.md")
      : idsFromFile(requirements, [ID_PATTERNS.FR], "requirements.md");
    const sourceIds = addSource(result, source);
    const dag = resolveBoltDag(projectDir);
    if (dag.state === "malformed") {
      result.reasons.push(`unit-of-work-dependency.md is ${dag.reason}: ${dag.detail}`);
      return result;
    }
    if (dag.state === "none") {
      result.reasons.push("unit-of-work-dependency.md is missing; cannot verify traceability targets");
      return result;
    }
    const context: UnitContext = {
      unitName: "",
      units: dag.units,
      unitIds: unitIdMap(join(docsDir, "inception", "units-generation", "unit-of-work.md"), dag.units),
    };
    result.unitContext = context;
    // Without stories the required set is FR-only ("otherwise enumerate every
    // FR"), but a scope that also traces NFRs must not have its correctly
    // mapped NFR rows reported as unmapped targets, so the join accepts both.
    const joinPatterns = hasStories ? [ID_PATTERNS.US] : [ID_PATTERNS.FR, ID_PATTERNS.NFR];
    const mapped = storyAssignments(storyMap, context.units, context.unitIds, joinPatterns);
    if (mapped.reason) result.reasons.push(mapped.reason);
    result.storyAssignments = mapped.assignments;
    for (const id of withoutTracedParents(sourceIds)) {
      if (!mapped.assignments.has(id)) result.extraGaps.push(id);
    }
    return result;
  }

  const stateContent = readPlanState(projectDir);
  const resolvedUnit = resolveUnitContext(projectDir, outputPath, docsDir, stage, stateContent);
  if (!resolvedUnit.context) {
    result.reasons.push(resolvedUnit.reason ?? "cannot resolve construction unit");
    return result;
  }
  result.unitContext = resolvedUnit.context;
  const unit = resolvedUnit.context.unitName;

  if (stage === "functional-design") {
    if (existsSync(stories) && existsSync(storyMap)) {
      const mapped = storyAssignments(storyMap, resolvedUnit.context.units, resolvedUnit.context.unitIds, [ID_PATTERNS.US]);
      if (mapped.reason) result.reasons.push(mapped.reason);
      result.storyAssignments = mapped.assignments;
      const unitStories = new Set(
        [...mapped.assignments.entries()]
          .filter(([, units]) => units.has(unit))
          .map(([story]) => story),
      );
      if (unitStories.size === 0) {
        result.reasons.push(`no stories in unit-of-work-story-map.md map to unit "${unit}"`);
        return result;
      }
      const storyRead = readText(stories);
      if (storyRead.content === null) {
        result.reasons.push(storyRead.reason ?? `cannot read ${stories}`);
        return result;
      }
      for (const ac of criteriaOfStories(storyRead.content, unitStories)) result.ids.add(ac);
      if (result.ids.size === 0) result.reasons.push(`stories mapped to unit "${unit}" contain no acceptance-criterion IDs`);
    } else if (unit && existsSync(storyMap)) {
      addUnitRows(result, storyMap, resolvedUnit.context, [ID_PATTERNS.FR]);
    } else {
      addSource(result, idsFromFile(requirements, [ID_PATTERNS.FR], "requirements.md"));
    }
    return result;
  }
  if (stage === "nfr-requirements") {
    // Without stories the story map may give a Unit its NFR rows, the join Code
    // Generation reads. A Unit no NFR row names owes every NFR in requirements.md,
    // and marks one that does not apply N/A with its reason.
    if (unit && !existsSync(stories) && existsSync(storyMap)) {
      const mapped = storyAssignments(storyMap, resolvedUnit.context.units, resolvedUnit.context.unitIds, [ID_PATTERNS.NFR]);
      for (const [id, units] of mapped.assignments) {
        if (units.has(unit)) result.ids.add(id);
      }
      if (result.ids.size > 0) return result;
    }
    addSource(result, idsFromFile(requirements, [ID_PATTERNS.NFR], "requirements.md"));
    return result;
  }
  if (stage === "nfr-design" || stage === "infrastructure-design") {
    resolveNfrUpstream(result, stage, docsDir, unit, requirements, stateContent);
    return result;
  }
  if (stage === "code-generation") {
    if (existsSync(stories)) {
      if (unit && existsSync(storyMap)) {
        const mapped = storyAssignments(storyMap, resolvedUnit.context.units, resolvedUnit.context.unitIds, [ID_PATTERNS.US]);
        if (mapped.reason) result.reasons.push(mapped.reason);
        result.storyAssignments = mapped.assignments;
        const unitStories = new Set(
          [...mapped.assignments.entries()]
            .filter(([, units]) => units.has(unit))
            .map(([story]) => story),
        );
        const storyRead = readText(stories);
        if (storyRead.content !== null) {
          for (const ac of criteriaOfStories(storyRead.content, unitStories)) result.ids.add(ac);
        }
      } else {
        addSource(result, idsFromFile(stories, [ID_PATTERNS.AC], "stories.md"));
      }
    } else if (unit && existsSync(storyMap)) {
      addUnitRows(result, storyMap, resolvedUnit.context, [ID_PATTERNS.FR, ID_PATTERNS.NFR]);
    } else {
      addSource(result, idsFromFile(requirements, [ID_PATTERNS.FR, ID_PATTERNS.NFR], "requirements.md"));
    }
    for (const id of detailedNfrIds(constructionDir(docsDir, unit, "nfr-requirements"), NFR_REQUIREMENT_FILES) ?? []) {
      result.ids.add(id);
    }
    const brPath = join(constructionDir(docsDir, unit, "functional-design"), "rules.md");
    if (existsSync(brPath)) {
      const read = readText(brPath);
      if (read.content !== null) {
        for (const id of extractIds(read.content, [ID_PATTERNS.BR])) result.ids.add(id);
      }
    }
    if (result.ids.size === 0) {
      result.reasons.push(unit ? `upstream ID set is empty for unit "${unit}"` : "upstream ID set is empty for the zero-Unit code-generation run");
    }
    return result;
  }

  result.reasons.push(`stage "${stage}" has no traceability upstream resolver`);
  return result;
}

function verifyTargets(
  stage: string,
  data: TraceabilityData,
  projectDir: string,
  outputPath: string,
  upstream: UpstreamResolution,
): { invalidTargets: string[]; derivedOrphans: string[]; reasons: string[] } {
  const invalidTargets: string[] = [];
  const derivedOrphans: string[] = [];
  const reasons: string[] = [];
  const docsDir = recordDir(projectDir);
  const okEntries = data.coverage.filter((entry) => entry.status === "OK");

  if (stage === "user-stories" && docsDir) {
    const storiesPath = join(docsDir, "inception", "user-stories", "stories.md");
    const stories = idsFromFile(storiesPath, [ID_PATTERNS.US], "stories.md");
    if (stories.reason) reasons.push(stories.reason);
    for (const entry of okEntries) {
      const targets = extractIds(entry.target ?? "", [ID_PATTERNS.US]);
      if (targets.size === 0) invalidTargets.push(`${entry.id}: target must name at least one USx.y ID`);
      for (const target of targets) {
        if (!stories.ids.has(target)) invalidTargets.push(`${entry.id}: target ${target} is absent from stories.md`);
      }
    }
  }

  if (stage === "units-generation" && upstream.unitContext && upstream.storyAssignments) {
    const reverseUnitIds = new Map([...upstream.unitContext.unitIds.entries()].map(([unit, id]) => [id, unit]));
    for (const entry of okEntries) {
      const rawTarget = entry.target?.trim() ?? "";
      const unit = upstream.unitContext.units.find((candidate) => namesUnit(rawTarget, candidate))
        ?? reverseUnitIds.get(rawTarget.toUpperCase());
      if (!unit) {
        invalidTargets.push(`${entry.id}: target "${rawTarget}" is not a declared unit`);
      } else if (!upstream.storyAssignments.get(entry.id)?.has(unit)) {
        invalidTargets.push(`${entry.id}: target "${rawTarget}" is not mapped in unit-of-work-story-map.md`);
      }
    }
  }

  if (stage === "functional-design" && docsDir) {
    const unit = upstream.unitContext?.unitName ?? extractUnitName(outputPath);
    if (unit !== null) {
      const brPath = join(constructionDir(docsDir, unit, "functional-design"), "rules.md");
      const rules = idsFromFile(brPath, [ID_PATTERNS.BR], "rules.md");
      if (rules.reason) reasons.push(rules.reason);
      const targeted = new Set<string>();
      for (const entry of okEntries) {
        const targets = extractIds(entry.target ?? "", [ID_PATTERNS.BR]);
        if (targets.size === 0) invalidTargets.push(`${entry.id}: target must name at least one BRx.y ID`);
        for (const target of targets) {
          targeted.add(target);
          if (!rules.ids.has(target)) invalidTargets.push(`${entry.id}: target ${target} is absent from rules.md`);
        }
      }
      const explained = new Set(data.reverse.map((entry) => entry.id));
      for (const rule of rules.ids) {
        if (!targeted.has(rule) && !explained.has(rule)) derivedOrphans.push(rule);
      }
    }
  }

  if (stage === "code-generation") {
    const projectRoot = resolve(projectDir);
    for (const entry of okEntries) {
      const problem = codeTargetProblem(projectRoot, entry.target);
      if (problem) invalidTargets.push(`${entry.id}: ${problem}`);
    }
  }

  return { invalidTargets, derivedOrphans, reasons };
}

// Why a Code Generation `OK` target is not one existing workspace-relative file.
function codeTargetProblem(projectRoot: string, rawTarget: string | undefined): string | null {
  const target = normalizePath(rawTarget?.trim() ?? "");
  if (target === "" || isAbsolute(target) || /^[A-Za-z]:\//.test(target)) {
    return "target must be a workspace-relative file path";
  }
  const absolute = resolve(projectRoot, target);
  const rel = relative(projectRoot, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return "target escapes the project directory";
  try {
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return `target file does not exist: ${target}`;
  } catch {
    return `target file is unreadable: ${target}`;
  }
  return null;
}

interface FinalRow {
  id: string;
  covered: boolean;
  built_in?: string[];
  through?: string[];
  not_built?: string[];
}

interface FinalCoverage {
  pass: boolean;
  uncovered: string[];
  reason?: string;
  coverage: FinalRow[];
}

function readTable(path: string, label: string): { data?: TraceabilityData; reason?: string } {
  const read = readText(path);
  if (read.content === null) return { reason: read.reason };
  const validated = validateTraceability(parseJson(read.content));
  return validated.ok ? { data: validated.data } : { reason: `${label}: ${validated.reason}` };
}

// Build and Test's cross-Unit coverage: every requirement in requirements.md and,
// when User Stories ran, every criterion in stories.md, each built by an `OK`
// row whose file exists in some Code Generation table. A requirement with
// sub-requirements (NFR1 over a Unit's NFR1.1) is built when each Unit has built
// its own, and a row for the parent alone does not cover them; else it is built
// by its own row; else, with stories, through every criterion of the stories
// User Stories traced it to, because Code Generation then traces criteria.
// `uncovered` comes before the per-ID rows so a host that cuts long output keeps it.
function finalCoverage(projectDir: string): FinalCoverage {
  const docsDir = recordDir(projectDir);
  if (!docsDir) {
    return { pass: false, uncovered: [], reason: "cannot resolve the active intent record directory", coverage: [] };
  }
  const reasons: string[] = [];
  const requirements = idsFromFile(
    join(docsDir, "inception", "requirements-analysis", "requirements.md"),
    [ID_PATTERNS.FR, ID_PATTERNS.NFR],
    "requirements.md",
  );
  if (requirements.reason) reasons.push(requirements.reason);
  const reported = [...withoutTracedParents(requirements.ids)];

  const storyTargets = new Map<string, Set<string>>();
  let storyContent: string | null = null;
  const storiesPath = join(docsDir, "inception", "user-stories", "stories.md");
  if (existsSync(storiesPath)) {
    const read = readText(storiesPath);
    if (read.reason) reasons.push(read.reason);
    storyContent = read.content;
    if (storyContent !== null) reported.push(...extractIds(storyContent, [ID_PATTERNS.AC]));
    const table = readTable(join(docsDir, "inception", "user-stories", "traceability.json"), "User Stories traceability.json");
    if (table.reason) reasons.push(table.reason);
    for (const entry of table.data?.coverage ?? []) {
      if (entry.status !== "OK") continue;
      const stories = storyTargets.get(entry.id) ?? new Set<string>();
      for (const story of extractIds(entry.target ?? "", [ID_PATTERNS.US])) stories.add(story);
      storyTargets.set(entry.id, stories);
    }
  }

  // The stage-level table (no Units) and every Unit's, named by their folder.
  const construction = join(docsDir, "construction");
  const folders = existsSync(construction)
    ? readdirSync(construction, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    : [];
  const owners = [
    { owner: "code-generation", dir: construction },
    ...folders.filter((folder) => folder !== "code-generation").map((owner) => ({ owner, dir: join(construction, owner) })),
  ];

  const projectRoot = resolve(projectDir);
  const add = (map: Map<string, string[]>, key: string, value: string) => map.set(key, [...(map.get(key) ?? []), value]);
  const builtIn = new Map<string, string[]>();
  const badTargets = new Map<string, string[]>();
  // Each owner's own built IDs and the sub-requirements it owes: the NFRx.y its
  // NFR Requirements wrote (what Code Generation's own check asks of it) and any
  // its table lists. The same NFRx.y in two Units is two requirements.
  const builtBy = new Map<string, Set<string>>();
  const owed = new Map<string, Set<string>>();
  let tables = 0;
  for (const { owner, dir } of owners) {
    const children = new Set(detailedNfrIds(join(dir, "nfr-requirements"), NFR_REQUIREMENT_FILES) ?? []);
    const built = new Set<string>();
    owed.set(owner, children);
    builtBy.set(owner, built);
    const path = join(dir, "code-generation", "traceability.json");
    if (!existsSync(path)) continue;
    tables++;
    const read = readTable(path, `${owner} Code Generation traceability.json`);
    if (!read.data) {
      if (read.reason) reasons.push(read.reason);
      continue;
    }
    for (const id of [...read.data.upstream_ids, ...read.data.coverage.map((entry) => entry.id)]) {
      if (tracedParent(id)) children.add(id);
    }
    for (const entry of read.data.coverage) {
      if (entry.status !== "OK") continue;
      const problem = codeTargetProblem(projectRoot, entry.target);
      if (problem) {
        add(badTargets, entry.id, `${owner}: ${entry.id}: ${problem}`);
        add(badTargets, `${owner}: ${entry.id}`, `${owner}: ${entry.id}: ${problem}`);
      } else {
        built.add(entry.id);
        add(builtIn, entry.id, `${owner}: ${normalizePath(entry.target?.trim() ?? "")}`);
      }
    }
  }
  if (tables === 0) reasons.push(`no Code Generation traceability.json under ${construction}`);

  // A story with no criteria cannot show it is built, so it stands for itself.
  const criteriaOrStory = (story: string): string[] => {
    const criteria = storyContent === null ? [] : [...criteriaOfStories(storyContent, new Set([story]))];
    return criteria.length > 0 ? criteria : [story];
  };
  const coverage: FinalRow[] = [];
  for (const id of reported) {
    const parts: string[] = [];
    const partsNotBuilt: string[] = [];
    for (const [owner, children] of owed) {
      for (const child of children) {
        if (tracedParent(child) !== id) continue;
        parts.push(`${owner}: ${child}`);
        if (!builtBy.get(owner)?.has(child)) partsNotBuilt.push(`${owner}: ${child}`);
      }
    }
    if (parts.length > 0) {
      coverage.push(partsNotBuilt.length === 0
        ? { id, covered: true, through: parts }
        : { id, covered: false, through: parts, not_built: partsNotBuilt });
      continue;
    }
    const built = builtIn.get(id);
    if (built) {
      coverage.push({ id, covered: true, built_in: built });
      continue;
    }
    const through = [...(storyTargets.get(id) ?? [])].flatMap(criteriaOrStory);
    if (through.length === 0) {
      coverage.push({ id, covered: false });
      continue;
    }
    const notBuilt = through.filter((part) => !builtIn.has(part));
    coverage.push(notBuilt.length === 0 ? { id, covered: true, through } : { id, covered: false, through, not_built: notBuilt });
  }

  const uncovered = coverage.filter((row) => !row.covered);
  for (const row of uncovered) {
    for (const part of [row.id, ...(row.not_built ?? [])]) reasons.push(...(badTargets.get(part) ?? []));
  }
  const reason = uniqueSorted(reasons).join("; ");
  return {
    pass: uncovered.length === 0 && reasons.length === 0,
    uncovered: uncovered.map((row) => row.id),
    ...(reason ? { reason } : {}),
    coverage,
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function main(argv: string[]): void {
  const flags = parseFlags(argv);
  if (flags.stage === "build-and-test" && !flags.outputPath) {
    process.stdout.write(`${JSON.stringify(finalCoverage(resolveProjectDir()))}\n`);
    return;
  }
  if (!flags.outputPath) fail("--output-path is required");
  const outputPath = normalizePath(flags.outputPath);
  if (!existsSync(outputPath)) fail(`--output-path not found: ${flags.outputPath}`);

  let body: string;
  try {
    body = readFileSync(outputPath, "utf-8");
  } catch (error) {
    fail(`failed to read --output-path ${flags.outputPath}: ${errorMessage(error)}`);
  }

  const validated = validateTraceability(parseJson(body));
  if (!validated.ok) {
    emit(failedResult(validated.reason));
    return;
  }
  const data = validated.data;
  if (data.coverage.length === 0) {
    emit(failedResult("no coverage entries found in traceability.json"));
    return;
  }

  const stage = flags.stage ?? data.stage ?? "";
  const projectDir = resolveProjectDir();
  const gaps: string[] = [];
  const orphans: string[] = [];
  const invalidEntries: string[] = [];
  const reasons: string[] = [];
  const declared = new Set(data.upstream_ids);
  const upstream = resolveUpstream(stage, projectDir, outputPath);
  const required = withoutTracedParents(upstream.ids);

  for (const [field, entries] of [["coverage", data.coverage], ["reverse", data.reverse]] as const) {
    for (const entry of entries) {
      // `reverse` holds what this stage produced that traces to nothing upstream.
      if (field === "reverse" && required.has(entry.id) && !declared.has(entry.id)) {
        invalidEntries.push(`reverse:${entry.id}: ${entry.id} is an upstream ID; list it in upstream_ids with a coverage row (N/A takes its reason as the target)`);
        continue;
      }
      if (!VALID_STATUSES.has(entry.status)) {
        invalidEntries.push(`${field}:${entry.id}: unknown status "${entry.status}"`);
        continue;
      }
      if (entry.status === "GAP") gaps.push(entry.id);
      if (entry.status === "ORPHAN") orphans.push(entry.id);
      if (["OK", "Deferred", "N/A"].includes(entry.status) && !entry.target?.trim()) {
        invalidEntries.push(`${field}:${entry.id}: status ${entry.status} requires a non-empty target`);
      }
    }
  }

  const covered = new Set(data.coverage.map((entry) => entry.id));
  const missingFromTable = [...withoutTracedParents(declared)].filter((id) => !covered.has(id));
  for (const entry of data.coverage) {
    if (!declared.has(entry.id)) invalidEntries.push(`coverage:${entry.id}: id is absent from upstream_ids`);
  }

  reasons.push(...upstream.reasons);
  gaps.push(...upstream.extraGaps);
  const missingFromUpstreamIds = [...required].filter((id) => !declared.has(id));
  if (upstream.ids.size === 0 && upstream.reasons.length === 0) {
    reasons.push(`upstream ID set is empty for stage "${stage}"`);
  }

  const targetChecks = verifyTargets(stage, data, projectDir, outputPath, upstream);
  reasons.push(...targetChecks.reasons);
  orphans.push(...targetChecks.derivedOrphans);

  const result: Result = {
    pass: false,
    gaps: uniqueSorted(gaps),
    orphans: uniqueSorted(orphans),
    missing_from_table: uniqueSorted(missingFromTable),
    missing_from_upstream_ids: uniqueSorted(missingFromUpstreamIds),
    invalid_entries: uniqueSorted(invalidEntries),
    invalid_targets: uniqueSorted(targetChecks.invalidTargets),
    findings_count: 0,
  };
  result.findings_count =
    result.gaps.length +
    result.orphans.length +
    result.missing_from_table.length +
    result.missing_from_upstream_ids.length +
    result.invalid_entries.length +
    result.invalid_targets.length +
    reasons.length;
  result.pass = result.findings_count === 0;
  if (reasons.length > 0) result.reason = uniqueSorted(reasons).join("; ");
  emit(result);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    emit(failedResult(`traceability sensor failed safely: ${errorMessage(error)}`));
  }
}
