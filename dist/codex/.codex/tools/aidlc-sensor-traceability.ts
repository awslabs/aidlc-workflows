import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  errorMessage,
  recordDir,
  resolveBoltDag,
  resolveProjectDir,
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

function markdownCells(line: string): string[] {
  if (!line.trimStart().startsWith("|") || /^\s*\|?[\s:|-]+\|?\s*$/.test(line)) return [];
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
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
    const unit = units.find((candidate) => cells.some((cell) => cell === candidate || cell === `\`${candidate}\``));
    if (unit) map.set(unit, id);
  }
  return map;
}

function tokenPresent(cell: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s,;/])${escaped}(?:$|[\\s,;/])`, "i").test(cell);
}

function storyAssignments(storyMapPath: string, units: string[], ids: Map<string, string>): { assignments: Map<string, Set<string>>; reason?: string } {
  const read = readText(storyMapPath);
  if (read.content === null) return { assignments: new Map(), reason: read.reason };
  const assignments = new Map<string, Set<string>>();
  for (const line of read.content.split(/\r?\n/)) {
    const cells = markdownCells(line);
    if (cells.length === 0) continue;
    const stories = extractIds(line, [ID_PATTERNS.US]);
    if (stories.size === 0) continue;
    for (const unit of units) {
      const aliases = [unit, ids.get(unit)].filter((value): value is string => value !== undefined);
      if (!cells.some((cell) => aliases.some((alias) => tokenPresent(cell, alias)))) continue;
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

function resolveUnitContext(projectDir: string, outputPath: string, docsDir: string): { context?: UnitContext; reason?: string } {
  const unitName = extractUnitName(outputPath);
  if (!unitName) return { reason: `cannot derive the construction unit from output path: ${outputPath}` };
  const dag = resolveBoltDag(projectDir);
  if (dag.state === "malformed") {
    return { reason: `unit-of-work-dependency.md is ${dag.reason}: ${dag.detail}` };
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
    const source = existsSync(stories)
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
    const mapped = storyAssignments(storyMap, context.units, context.unitIds);
    if (mapped.reason) result.reasons.push(mapped.reason);
    result.storyAssignments = mapped.assignments;
    for (const id of sourceIds) {
      if (!mapped.assignments.has(id)) result.extraGaps.push(id);
    }
    return result;
  }

  const resolvedUnit = resolveUnitContext(projectDir, outputPath, docsDir);
  if (!resolvedUnit.context) {
    result.reasons.push(resolvedUnit.reason ?? "cannot resolve construction unit");
    return result;
  }
  result.unitContext = resolvedUnit.context;
  const unit = resolvedUnit.context.unitName;

  if (stage === "functional-design") {
    if (existsSync(stories) && existsSync(storyMap)) {
      const mapped = storyAssignments(storyMap, resolvedUnit.context.units, resolvedUnit.context.unitIds);
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
      for (const ac of extractIds(storyRead.content, [ID_PATTERNS.AC])) {
        const [group, story] = ac.slice(2).split(".");
        if (unitStories.has(`US${group}.${story}`)) result.ids.add(ac);
      }
      if (result.ids.size === 0) result.reasons.push(`stories mapped to unit "${unit}" contain no acceptance-criterion IDs`);
    } else {
      addSource(result, idsFromFile(requirements, [ID_PATTERNS.FR], "requirements.md"));
    }
    return result;
  }
  if (stage === "nfr-requirements") {
    addSource(result, idsFromFile(requirements, [ID_PATTERNS.NFR], "requirements.md"));
    return result;
  }
  if (stage === "nfr-design") {
    const dir = join(docsDir, "construction", unit, "nfr-requirements");
    let sawFile = false;
    for (const name of ["performance-requirements.md", "security-requirements.md", "scalability-requirements.md", "reliability-requirements.md"]) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      sawFile = true;
      const read = readText(path);
      if (read.content !== null) {
        for (const id of extractIds(read.content, [ID_PATTERNS.NFR_DETAIL])) result.ids.add(id);
      }
    }
    if (!sawFile) result.reasons.push(`required upstream NFR requirement artifacts are missing under ${dir}`);
    else if (result.ids.size === 0) result.reasons.push(`NFR requirement artifacts for unit "${unit}" contain no NFRx.y IDs`);
    return result;
  }
  if (stage === "infrastructure-design") {
    const dir = join(docsDir, "construction", unit, "nfr-design");
    let sawFile = false;
    for (const name of ["performance-design.md", "security-design.md", "scalability-design.md", "reliability-design.md", "logical-components.md"]) {
      const path = join(dir, name);
      if (!existsSync(path)) continue;
      sawFile = true;
      const source = idsFromFile(path, [ID_PATTERNS.NFR_DETAIL], name);
      for (const id of source.ids) result.ids.add(id);
    }
    if (!sawFile) result.reasons.push(`required upstream NFR design artifacts are missing under ${dir}`);
    else if (result.ids.size === 0) result.reasons.push(`NFR design artifacts for unit "${unit}" contain no NFRx.y IDs`);
    return result;
  }
  if (stage === "code-generation") {
    if (existsSync(stories)) {
      if (existsSync(storyMap)) {
        const mapped = storyAssignments(storyMap, resolvedUnit.context.units, resolvedUnit.context.unitIds);
        if (mapped.reason) result.reasons.push(mapped.reason);
        result.storyAssignments = mapped.assignments;
        const unitStories = new Set(
          [...mapped.assignments.entries()]
            .filter(([, units]) => units.has(unit))
            .map(([story]) => story),
        );
        const storyRead = readText(stories);
        if (storyRead.content !== null) {
          for (const ac of extractIds(storyRead.content, [ID_PATTERNS.AC])) {
            const [group, story] = ac.slice(2).split(".");
            if (unitStories.has(`US${group}.${story}`)) result.ids.add(ac);
          }
        }
      } else {
        addSource(result, idsFromFile(stories, [ID_PATTERNS.AC], "stories.md"));
      }
    } else {
      addSource(result, idsFromFile(requirements, [ID_PATTERNS.FR, ID_PATTERNS.NFR], "requirements.md"));
    }
    const nfrDir = join(docsDir, "construction", unit, "nfr-requirements");
    for (const name of ["performance-requirements.md", "security-requirements.md", "scalability-requirements.md", "reliability-requirements.md"]) {
      const path = join(nfrDir, name);
      if (existsSync(path)) {
        const read = readText(path);
        if (read.content !== null) {
          for (const id of extractIds(read.content, [ID_PATTERNS.NFR_DETAIL])) result.ids.add(id);
        }
      }
    }
    const brPath = join(docsDir, "construction", unit, "functional-design", "rules.md");
    if (existsSync(brPath)) {
      const read = readText(brPath);
      if (read.content !== null) {
        for (const id of extractIds(read.content, [ID_PATTERNS.BR])) result.ids.add(id);
      }
    }
    if (result.ids.size === 0) result.reasons.push(`upstream ID set is empty for unit "${unit}"`);
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
      const unit = upstream.unitContext.units.includes(rawTarget)
        ? rawTarget
        : reverseUnitIds.get(rawTarget.toUpperCase());
      if (!unit) {
        invalidTargets.push(`${entry.id}: target "${rawTarget}" is not a declared unit`);
      } else if (!upstream.storyAssignments.get(entry.id)?.has(unit)) {
        invalidTargets.push(`${entry.id}: target "${rawTarget}" is not mapped in unit-of-work-story-map.md`);
      }
    }
  }

  if (stage === "functional-design" && docsDir) {
    const unit = upstream.unitContext?.unitName ?? extractUnitName(outputPath);
    if (unit) {
      const brPath = join(docsDir, "construction", unit, "functional-design", "rules.md");
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
      const target = normalizePath(entry.target?.trim() ?? "");
      const driveAbsolute = /^[A-Za-z]:\//.test(target);
      if (target === "" || isAbsolute(target) || driveAbsolute) {
        invalidTargets.push(`${entry.id}: target must be a workspace-relative file path`);
        continue;
      }
      const absolute = resolve(projectRoot, target);
      const rel = relative(projectRoot, absolute);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        invalidTargets.push(`${entry.id}: target escapes the project directory`);
        continue;
      }
      try {
        if (!existsSync(absolute) || !statSync(absolute).isFile()) {
          invalidTargets.push(`${entry.id}: target file does not exist: ${target}`);
        }
      } catch {
        invalidTargets.push(`${entry.id}: target file is unreadable: ${target}`);
      }
    }
  }

  return { invalidTargets, derivedOrphans, reasons };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
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

  for (const [field, entries] of [["coverage", data.coverage], ["reverse", data.reverse]] as const) {
    for (const entry of entries) {
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

  const declared = new Set(data.upstream_ids);
  const covered = new Set(data.coverage.map((entry) => entry.id));
  const missingFromTable = [...declared].filter((id) => !covered.has(id));
  for (const entry of data.coverage) {
    if (!declared.has(entry.id)) invalidEntries.push(`coverage:${entry.id}: id is absent from upstream_ids`);
  }

  const upstream = resolveUpstream(stage, projectDir, outputPath);
  reasons.push(...upstream.reasons);
  gaps.push(...upstream.extraGaps);
  const missingFromUpstreamIds = [...upstream.ids].filter((id) => !declared.has(id));
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

try {
  main();
} catch (error) {
  emit(failedResult(`traceability sensor failed safely: ${errorMessage(error)}`));
}
