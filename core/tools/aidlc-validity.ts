import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  auditBlockField,
  codekbDir,
  codekbRepoName,
  getField,
  intentRepos,
  parseCheckboxes,
  readAllAuditShards,
  recordDir,
} from "./aidlc-lib.js";
import { loadGraph } from "./aidlc-graph.ts";

/**
 * Optional field written on main-workflow STAGE_COMPLETED audit rows.
 *
 * The audit ledger is the immutable completion history. Current validity is a
 * read-only projection over the latest completion basis, the current artifact
 * tree, and the compiled stage graph. No second mutable stale-state file is
 * introduced.
 */
export const VALIDATION_BASIS_FIELD = "Validation Basis";
const VALIDATION_BASIS_SCHEMA = 1 as const;
const KNOWN_CODEKB_STAGES: ReadonlySet<string> = new Set([
  "reverse-engineering",
]);

export type StageValidityStatus = "stale" | "needs-revalidation";

export interface ArtifactFingerprintMap {
  [artifact: string]: string;
}

export interface StageValidationBasis {
  schema: typeof VALIDATION_BASIS_SCHEMA;
  definition: string;
  projectType: "brownfield" | "greenfield" | null;
  inputs: ArtifactFingerprintMap;
  outputs: ArtifactFingerprintMap;
}

export interface StageValidityIssue {
  stage: string;
  status: StageValidityStatus;
  direct: boolean;
  reasons: string[];
  roots: string[];
}

export interface StageValidityInspection {
  issues: StageValidityIssue[];
  /**
   * Completed stages whose current attempt predates validation-basis support.
   * Migration is deliberately fail-open: these are observable but do not block
   * routing until the stage completes again and records a basis.
   */
  untracked: string[];
}

/**
 * Structural subset shared by StageEntry and GraphStage. Keeping this local
 * avoids widening either public graph API solely for validity projection.
 */
export interface StageValidityNode {
  slug: string;
  phase: string;
  execution?: string;
  condition?: string;
  for_each?: string;
  workspace_requires?: boolean;
  produces?: readonly string[];
  optional_produces?: readonly string[];
  produces_kinds?: Readonly<Record<string, readonly string[]>>;
  consumes?: ReadonlyArray<{
    artifact: string;
    required?: boolean;
    conditional_on?: string;
  }>;
  requires_stage?: readonly string[];
}

interface OrderedAuditEvent {
  event: string;
  block: string;
  timestamp: string;
  position: number;
}

interface PropagationEdge {
  to: string;
  artifact: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const candidate = (value as Record<string, unknown>)[key];
      if (candidate !== undefined) result[key] = canonicalValue(candidate);
    }
    return result;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/**
 * Fingerprint only the part of a graph node that defines its validity contract.
 * Display names, agents, and generated harness paths are intentionally excluded
 * so a non-semantic packaging change does not invalidate every completed stage.
 */
function definitionFingerprint(stage: StageValidityNode): string {
  const contract = {
    slug: stage.slug,
    phase: stage.phase,
    execution: stage.execution,
    condition: stage.condition,
    for_each: stage.for_each,
    workspace_requires: stage.workspace_requires,
    consumes: stage.consumes ?? [],
    produces: stage.produces ?? [],
    optional_produces: stage.optional_produces ?? [],
    produces_kinds: stage.produces_kinds ?? {},
  };
  return `sha256:${sha256(canonicalJson(contract))}`;
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function safeSubdirectories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve every concrete Markdown file represented by one artifact vocabulary
 * name. This mirrors the three placement classes used by the v2 artifact guard:
 * codekb, per-unit Construction, and ordinary per-intent stage artifacts.
 */
export function artifactFilesFor(
  projectDir: string,
  artifact: string,
  owner: StageValidityNode,
): string[] {
  if (KNOWN_CODEKB_STAGES.has(owner.slug)) {
    const root = dirname(codekbDir(projectDir, "_"));
    const recorded = intentRepos(projectDir);
    const discovered = safeSubdirectories(root);
    const repos =
      recorded.length > 0
        ? [...recorded].sort()
        : discovered.length > 0
          ? discovered
          : [codekbRepoName(projectDir)];
    return repos.map((repo) => join(root, repo, `${artifact}.md`));
  }

  const record = recordDir(projectDir);
  if (record === null) return [];

  if (owner.for_each === "unit-of-work") {
    const construction = join(record, "construction");
    return safeSubdirectories(construction)
      .filter((unit) => existsSync(join(construction, unit, owner.slug)))
      .map((unit) =>
        join(construction, unit, owner.slug, `${artifact}.md`),
      );
  }

  return [join(record, owner.phase, owner.slug, `${artifact}.md`)];
}

/**
 * Hash path and content together. Missing candidate paths are part of the hash,
 * so deleting a required artifact or creating a formerly absent optional output
 * is visible as drift.
 */
export function fingerprintArtifactFiles(
  projectDir: string,
  paths: readonly string[],
): string {
  if (paths.length === 0) return "missing";

  const rows = [...new Set(paths)]
    .sort()
    .map((path) => {
      const rel = toPosix(relative(projectDir, path));
      if (!existsSync(path)) return `${rel}\u0000missing`;
      try {
        if (!statSync(path).isFile()) return `${rel}\u0000not-a-file`;
        return `${rel}\u0000sha256:${sha256(readFileSync(path))}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `${rel}\u0000unreadable:${sha256(message)}`;
      }
    });

  return `sha256:${sha256(rows.join("\n"))}`;
}

function producersByArtifact(
  stages: readonly StageValidityNode[],
): Map<string, StageValidityNode[]> {
  const result = new Map<string, StageValidityNode[]>();
  for (const stage of stages) {
    for (const artifact of [
      ...(stage.produces ?? []),
      ...(stage.optional_produces ?? []),
    ]) {
      const producers = result.get(artifact) ?? [];
      producers.push(stage);
      result.set(artifact, producers);
    }
  }
  return result;
}

function projectTypeFrom(
  stateContent: string,
): "brownfield" | "greenfield" | null {
  const raw = getField(stateContent, "Project Type")?.toLowerCase();
  return raw === "brownfield" || raw === "greenfield" ? raw : null;
}

function fingerprintArtifact(
  projectDir: string,
  artifact: string,
  owners: readonly StageValidityNode[],
): string {
  const paths = owners.flatMap((owner) =>
    artifactFilesFor(projectDir, artifact, owner),
  );
  return fingerprintArtifactFiles(projectDir, paths);
}

/** Capture the artifact basis against which one stage is completed. */
export function captureStageValidationBasis(
  projectDir: string,
  stage: StageValidityNode,
  stateContent: string,
  stages: readonly StageValidityNode[] = loadGraph(),
): StageValidationBasis {
  const producers = producersByArtifact(stages);
  const projectType = projectTypeFrom(stateContent);
  const inputs: ArtifactFingerprintMap = {};
  const outputs: ArtifactFingerprintMap = {};

  for (const consume of stage.consumes ?? []) {
    if (
      consume.conditional_on &&
      projectType &&
      consume.conditional_on !== projectType
    ) {
      continue;
    }
    inputs[consume.artifact] = fingerprintArtifact(
      projectDir,
      consume.artifact,
      producers.get(consume.artifact) ?? [],
    );
  }

  for (const artifact of [
    ...(stage.produces ?? []),
    ...(stage.optional_produces ?? []),
  ]) {
    outputs[artifact] = fingerprintArtifact(projectDir, artifact, [stage]);
  }

  return {
    schema: VALIDATION_BASIS_SCHEMA,
    definition: definitionFingerprint(stage),
    projectType,
    inputs,
    outputs,
  };
}

/** Fields to spread into an existing main-workflow STAGE_COMPLETED row. */
export function stageValidationAuditFields(
  projectDir: string,
  stage: StageValidityNode,
  stateContent: string,
  stages: readonly StageValidityNode[] = loadGraph(),
): Record<string, string> {
  return {
    [VALIDATION_BASIS_FIELD]: canonicalJson(
      captureStageValidationBasis(projectDir, stage, stateContent, stages),
    ),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.values(value as Record<string, unknown>).every(
    (entry) => typeof entry === "string",
  );
}

export function parseStageValidationBasis(
  raw: string | null,
): StageValidationBasis | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.schema !== VALIDATION_BASIS_SCHEMA) return null;
    if (typeof candidate.definition !== "string") return null;
    if (
      candidate.projectType !== null &&
      candidate.projectType !== "brownfield" &&
      candidate.projectType !== "greenfield"
    ) {
      return null;
    }
    if (!isStringRecord(candidate.inputs) || !isStringRecord(candidate.outputs)) {
      return null;
    }
    return {
      schema: VALIDATION_BASIS_SCHEMA,
      definition: candidate.definition,
      projectType: candidate.projectType,
      inputs: candidate.inputs,
      outputs: candidate.outputs,
    };
  } catch {
    return null;
  }
}

function orderedMainWorkflowEvents(audit: string): OrderedAuditEvent[] {
  if (audit.length === 0) return [];
  const events = audit
    .replaceAll("\r\n", "\n")
    .split(/\n---\n/)
    .map((block, position): OrderedAuditEvent | null => {
      const event = auditBlockField(block, "Event");
      if (!event) return null;
      if (auditBlockField(block, "Workflow")?.startsWith("single-stage:")) {
        return null;
      }
      return {
        event,
        block,
        timestamp: auditBlockField(block, "Timestamp") ?? "",
        position,
      };
    })
    .filter((event): event is OrderedAuditEvent => event !== null)
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp < right.timestamp ? -1 : 1;
      }
      return left.position - right.position;
    });

  const workflowStart = events.findLastIndex(
    (event) => event.event === "WORKFLOW_STARTED",
  );
  return workflowStart === -1 ? events : events.slice(workflowStart);
}

/**
 * Return the latest completion basis in each stage's current attempt.
 *
 * STAGE_STARTED starts a new attempt and clears the previous basis. A completion
 * with no basis also clears it, so a legacy completion cannot accidentally
 * inherit evidence from an older tracked attempt.
 */
export function latestCompletionBasesFromAudit(
  audit: string,
): Map<string, StageValidationBasis> {
  const bases = new Map<string, StageValidationBasis>();
  for (const event of orderedMainWorkflowEvents(audit)) {
    const stage = auditBlockField(event.block, "Stage");
    if (!stage) continue;
    if (event.event === "STAGE_STARTED") {
      bases.delete(stage);
      continue;
    }
    if (event.event !== "STAGE_COMPLETED") continue;
    const basis = parseStageValidationBasis(
      auditBlockField(event.block, VALIDATION_BASIS_FIELD),
    );
    if (basis) bases.set(stage, basis);
    else bases.delete(stage);
  }
  return bases;
}

function mapChanges(
  label: "input" | "output",
  before: ArtifactFingerprintMap,
  after: ArtifactFingerprintMap,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: string[] = [];
  for (const key of [...keys].sort()) {
    if (before[key] !== after[key]) changes.push(`${label}:${key}`);
  }
  return changes;
}

export function diffStageValidationBasis(
  before: StageValidationBasis,
  after: StageValidationBasis,
): string[] {
  const changes: string[] = [];
  if (before.definition !== after.definition) changes.push("stage-definition");
  if (before.projectType !== after.projectType) changes.push("project-type");
  changes.push(...mapChanges("input", before.inputs, after.inputs));
  changes.push(...mapChanges("output", before.outputs, after.outputs));
  return changes;
}

function propagationEdges(
  stages: readonly StageValidityNode[],
  projectType: "brownfield" | "greenfield" | null,
): Map<string, PropagationEdge[]> {
  const consumers = new Map<string, string[]>();
  for (const stage of stages) {
    for (const consume of stage.consumes ?? []) {
      if (
        consume.conditional_on &&
        projectType &&
        consume.conditional_on !== projectType
      ) {
        continue;
      }
      const list = consumers.get(consume.artifact) ?? [];
      list.push(stage.slug);
      consumers.set(consume.artifact, list);
    }
  }

  const edges = new Map<string, PropagationEdge[]>();
  for (const stage of stages) {
    const outgoing: PropagationEdge[] = [];
    for (const artifact of [
      ...(stage.produces ?? []),
      ...(stage.optional_produces ?? []),
    ]) {
      for (const consumer of consumers.get(artifact) ?? []) {
        outgoing.push({ to: consumer, artifact });
      }
    }
    edges.set(stage.slug, outgoing);
  }
  return edges;
}

/**
 * Propagate stale roots through explicit artifact data dependencies.
 *
 * requires_stage is intentionally excluded: it is an execution-order edge and
 * does not prove that the downstream result semantically consumed the upstream
 * result. If ordering-only stages must invalidate one another, the graph should
 * grow an explicit invalidation contract rather than overloading ordering.
 */
export function propagateStageInvalidation(
  stages: readonly StageValidityNode[],
  completedSlugs: ReadonlySet<string>,
  directReasons: ReadonlyMap<string, readonly string[]>,
  projectType: "brownfield" | "greenfield" | null = null,
): StageValidityIssue[] {
  const known = new Set(stages.map((stage) => stage.slug));
  const edges = propagationEdges(stages, projectType);
  const issues = new Map<
    string,
    {
      direct: boolean;
      reasons: Set<string>;
      roots: Set<string>;
    }
  >();
  const queue: Array<{ slug: string; root: string }> = [];
  const visited = new Set<string>();

  for (const stage of stages) {
    const reasons = directReasons.get(stage.slug);
    if (!reasons || !completedSlugs.has(stage.slug)) continue;
    issues.set(stage.slug, {
      direct: true,
      reasons: new Set(reasons),
      roots: new Set([stage.slug]),
    });
    queue.push({ slug: stage.slug, root: stage.slug });
  }

  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    const visitKey = `${current.slug}\u0000${current.root}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    for (const edge of edges.get(current.slug) ?? []) {
      if (!known.has(edge.to)) continue;
      const reason =
        `depends on stale stage "${current.slug}" via artifact:${edge.artifact}`;
      if (completedSlugs.has(edge.to)) {
        const existing = issues.get(edge.to);
        if (existing) {
          existing.roots.add(current.root);
          if (!existing.direct) existing.reasons.add(reason);
        } else {
          issues.set(edge.to, {
            direct: false,
            reasons: new Set([reason]),
            roots: new Set([current.root]),
          });
        }
      }
      // Traverse through pending/in-progress nodes as well. A completed stage
      // farther downstream can depend on a stale root through an intermediate
      // stage that has already been reopened by a prior jump.
      queue.push({ slug: edge.to, root: current.root });
    }
  }

  return stages
    .filter((stage) => issues.has(stage.slug))
    .map((stage) => {
      const issue = issues.get(stage.slug);
      if (!issue) throw new Error(`Missing validity issue for ${stage.slug}`);
      return {
        stage: stage.slug,
        status: issue.direct ? "stale" : "needs-revalidation",
        direct: issue.direct,
        reasons: [...issue.reasons].sort(),
        roots: [...issue.roots].sort(),
      };
    });
}

/**
 * Compare completed-stage audit receipts with the current artifact tree, then
 * propagate drift through produces-to-consumes edges. This function is pure
 * with respect to workflow state so aidlc-orchestrate.ts keeps its read-only
 * `next` invariant.
 */
export function inspectStageValidity(
  projectDir: string,
  stateContent: string,
  options: {
    stages?: readonly StageValidityNode[];
    audit?: string;
    currentBasis?: (
      stage: StageValidityNode,
      stages: readonly StageValidityNode[],
    ) => StageValidationBasis;
  } = {},
): StageValidityInspection {
  const stages = options.stages ?? loadGraph();
  const audit = options.audit ?? readAllAuditShards(projectDir);
  const bases = latestCompletionBasesFromAudit(audit);
  const checkboxRows = parseCheckboxes(stateContent);
  const completed = new Set(
    checkboxRows
      .filter((row) => row.state === "completed")
      .map((row) => row.slug),
  );
  // A SKIP row means the stage did not derive an output in this workflow. Do
  // not use it as an invisible bridge between a stale producer and a later
  // completed consumer. Pending/in-progress rows remain traversable because a
  // backward jump may have reopened an intermediate while later completed rows
  // still exist in state created by an older framework version.
  const nonSkipped = new Set(
    checkboxRows
      .filter((row) => row.state !== "skipped")
      .map((row) => row.slug),
  );
  const validityGraph = stages.filter((stage) => nonSkipped.has(stage.slug));
  const direct = new Map<string, string[]>();
  const untracked: string[] = [];

  for (const stage of stages) {
    if (!completed.has(stage.slug)) continue;
    const baseline = bases.get(stage.slug);
    if (!baseline) {
      untracked.push(stage.slug);
      continue;
    }
    const current = options.currentBasis
      ? options.currentBasis(stage, stages)
      : captureStageValidationBasis(projectDir, stage, stateContent, stages);
    const changes = diffStageValidationBasis(baseline, current);
    if (changes.length > 0) direct.set(stage.slug, changes);
  }

  return {
    issues: propagateStageInvalidation(
      validityGraph,
      completed,
      direct,
      projectTypeFrom(stateContent),
    ),
    untracked,
  };
}
