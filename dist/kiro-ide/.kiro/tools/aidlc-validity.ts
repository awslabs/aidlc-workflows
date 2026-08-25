import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  auditBlockField,
  getField,
  parseCheckboxes,
  readAllAuditShards,
} from "./aidlc-lib.js";
import { loadGraph } from "./aidlc-graph.ts";
import {
  resolveArtifactInstances,
  type ArtifactResolutionOptions,
  type ArtifactInstance,
} from "./aidlc-artifact-resolution.ts";

/**
 * Optional immutable receipt written on main-workflow STAGE_COMPLETED rows.
 *
 * Execution state remains in aidlc-state.md. Current validity is projected from
 * this receipt and the current artifact tree, so the implementation does not
 * add a second mutable stale-state file that can drift independently.
 */
export const VALIDATION_BASIS_FIELD = "Validation Basis";
export const VALIDATION_WARNING_FIELD = "Validation Warning";
const VALIDATION_BASIS_SCHEMA = 3 as const;

export type StageValidityStatus = "stale" | "needs-revalidation";

/**
 * Stage-level summary of the concrete artifact instances resolved at
 * completion time. Runtime resolution remains instance-aware, but the audit
 * receipt stores only deterministic aggregate fingerprints because validity is
 * currently projected at stage granularity rather than per Unit.
 */
export interface ArtifactBasis {
  artifact: string;
  producer: string;
  required: boolean;
  instanceCount: number;
  presentCount: number;
  structureHash: string;
  contentHash: string;
}

export interface StageValidationBasis {
  schema: typeof VALIDATION_BASIS_SCHEMA;
  graphContract: string;
  projectType: "brownfield" | "greenfield" | null;
  inputs: ArtifactBasis[];
  outputs: ArtifactBasis[];
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
   * Completed stages whose current attempt has no schema-3 receipt. Existing
   * workflows and earlier receipt schemas fail open until re-completion.
   */
  untracked: string[];
  /** Non-blocking diagnostics for receipts that could not be re-inspected. */
  warnings: string[];
}

/** Structural subset shared by StageEntry, GraphStage, and focused fixtures. */
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

interface CompletionReceipts {
  /** Receipt for the current attempt only; used to track completed checkboxes. */
  current: Map<string, StageValidationBasis>;
  /** Last schema-3 receipt, retained across STAGE_STARTED for propagation. */
  latestKnown: Map<string, StageValidationBasis>;
}

interface ObservedDependency {
  to: string;
  artifact: string;
}

export interface CaptureStageValidationOptions {
  resolution?: ArtifactResolutionOptions;
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
 * Fingerprint the compiled graph contract relevant to artifact validity. This
 * is deliberately named graphContract: it does not claim to hash the stage's
 * prose body, model behaviour, source tree, CI, or deployment environment.
 *
 * requires_stage is excluded because v2 currently uses it for both semantic
 * and ordering constraints. Treating every such edge as invalidating would be
 * an unsound over-approximation until the graph carries an explicit kind.
 */
function graphContractFingerprint(stage: StageValidityNode): string {
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

interface InstanceFingerprint {
  instance: ArtifactInstance;
  sha256: string;
  present: boolean;
}

function fingerprintInstance(instance: ArtifactInstance): InstanceFingerprint {
  const path = instance.absolutePath;
  if (!existsSync(path)) {
    return { instance, sha256: "missing", present: false };
  }
  try {
    if (!statSync(path).isFile()) {
      return { instance, sha256: "not-a-file", present: false };
    }
    return {
      instance,
      sha256: `sha256:${sha256(readFileSync(path))}`,
      present: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      instance,
      sha256: `unreadable:${sha256(message)}`,
      present: false,
    };
  }
}

function instanceKey(fingerprint: InstanceFingerprint): string {
  return [
    fingerprint.instance.unit ?? "",
    fingerprint.instance.unitKind ?? "",
    fingerprint.instance.relativePath,
  ].join("\u0000");
}

function artifactBasisKey(basis: ArtifactBasis): string {
  return [basis.artifact, basis.producer].join("\u0000");
}

function sortedArtifactBases(
  bases: readonly ArtifactBasis[],
): ArtifactBasis[] {
  return [...bases].sort((left, right) =>
    artifactBasisKey(left).localeCompare(artifactBasisKey(right)),
  );
}

/**
 * Aggregate instance-aware runtime resolution into a compact stage-level
 * receipt. structureHash changes when the resolved unit/path/kind set changes;
 * contentHash changes when any observed instance appears, disappears, becomes
 * unreadable, or changes content.
 */
function aggregateArtifactBasis(
  artifact: string,
  producer: string,
  required: boolean,
  instances: readonly ArtifactInstance[],
): ArtifactBasis | null {
  const fingerprints = instances
    .map(fingerprintInstance)
    .filter((fingerprint) => required || fingerprint.present)
    .sort((left, right) => instanceKey(left).localeCompare(instanceKey(right)));

  // An absent optional artifact was not an input/output of this completion.
  // If it appears later, the current basis gains a new entry and the stage is
  // directly invalidated.
  if (!required && fingerprints.length === 0) return null;

  const structure = fingerprints.map(({ instance }) => ({
    path: instance.relativePath,
    unit: instance.unit,
    unitKind: instance.unitKind,
  }));
  const content = fingerprints.map(({ instance, sha256: digest, present }) => ({
    path: instance.relativePath,
    sha256: digest,
    present,
  }));

  return {
    artifact,
    producer,
    required,
    instanceCount: fingerprints.length,
    presentCount: fingerprints.filter((item) => item.present).length,
    structureHash: `sha256:${sha256(canonicalJson(structure))}`,
    contentHash: `sha256:${sha256(canonicalJson(content))}`,
  };
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

function uniqueProducer(
  artifact: string,
  producers: ReadonlyMap<string, readonly StageValidityNode[]>,
): StageValidityNode {
  const owners = producers.get(artifact) ?? [];
  if (owners.length !== 1) {
    throw new Error(
      `Cannot capture validity for artifact "${artifact}": expected exactly ` +
        `one producer, found ${owners.length}.`,
    );
  }
  return owners[0];
}

function validationErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

function projectTypeFrom(
  stateContent: string,
): "brownfield" | "greenfield" | null {
  const raw = getField(stateContent, "Project Type")?.toLowerCase();
  return raw === "brownfield" || raw === "greenfield" ? raw : null;
}

function consumeIsApplicable(
  conditionalOn: string | undefined,
  projectType: "brownfield" | "greenfield" | null,
): boolean {
  return !conditionalOn || !projectType || conditionalOn === projectType;
}

function captureInputBasis(
  projectDir: string,
  stage: StageValidityNode,
  stages: readonly StageValidityNode[],
  projectType: "brownfield" | "greenfield" | null,
  options: CaptureStageValidationOptions,
): ArtifactBasis[] {
  const producers = producersByArtifact(stages);
  const inputs: ArtifactBasis[] = [];

  for (const consume of stage.consumes ?? []) {
    if (!consumeIsApplicable(consume.conditional_on, projectType)) continue;
    const required = consume.required !== false;
    const owners = producers.get(consume.artifact) ?? [];
    // Plugin contributions may legally declare an optional consume without a
    // producer. With no producer there is no observed edge to record.
    if (!required && owners.length === 0) continue;
    const owner = uniqueProducer(consume.artifact, producers);
    const instances = resolveArtifactInstances(
      projectDir,
      consume.artifact,
      owner,
      options.resolution,
    );
    const basis = aggregateArtifactBasis(
      consume.artifact,
      owner.slug,
      required,
      instances,
    );
    if (basis) inputs.push(basis);
  }
  return sortedArtifactBases(inputs);
}

function captureOutputBasis(
  projectDir: string,
  stage: StageValidityNode,
  options: CaptureStageValidationOptions,
): ArtifactBasis[] {
  const outputs: ArtifactBasis[] = [];
  const required = new Set(stage.produces ?? []);
  const optional = new Set(stage.optional_produces ?? []);
  for (const artifact of [...required, ...optional]) {
    const isRequired = required.has(artifact);
    const instances = resolveArtifactInstances(
      projectDir,
      artifact,
      stage,
      options.resolution,
    );
    const basis = aggregateArtifactBasis(
      artifact,
      stage.slug,
      isRequired,
      instances,
    );
    if (basis) outputs.push(basis);
  }
  return sortedArtifactBases(outputs);
}

/** Capture a compact stage-level basis from concrete runtime instances. */
export function captureStageValidationBasis(
  projectDir: string,
  stage: StageValidityNode,
  stateContent: string,
  stages: readonly StageValidityNode[] = loadGraph(),
  options: CaptureStageValidationOptions = {},
): StageValidationBasis {
  const projectType = projectTypeFrom(stateContent);
  const captureOptions: CaptureStageValidationOptions = {
    ...options,
    resolution: {
      ...options.resolution,
      stateContent,
    },
  };
  return {
    schema: VALIDATION_BASIS_SCHEMA,
    graphContract: graphContractFingerprint(stage),
    projectType,
    inputs: captureInputBasis(
      projectDir,
      stage,
      stages,
      projectType,
      captureOptions,
    ),
    outputs: captureOutputBasis(projectDir, stage, captureOptions),
  };
}

/** Fields to spread into an existing main-workflow STAGE_COMPLETED row. */
export function stageValidationAuditFields(
  projectDir: string,
  stage: StageValidityNode,
  stateContent: string,
  stages: readonly StageValidityNode[] = loadGraph(),
  options: CaptureStageValidationOptions = {},
): Record<string, string> {
  try {
    return {
      [VALIDATION_BASIS_FIELD]: canonicalJson(
        captureStageValidationBasis(
          projectDir,
          stage,
          stateContent,
          stages,
          options,
        ),
      ),
    };
  } catch (error) {
    return {
      [VALIDATION_WARNING_FIELD]:
        `Validity receipt omitted for stage "${stage.slug}": ` +
        validationErrorMessage(error),
    };
  }
}

function isArtifactBasis(value: unknown): value is ArtifactBasis {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.artifact === "string" &&
    typeof candidate.producer === "string" &&
    typeof candidate.required === "boolean" &&
    Number.isInteger(candidate.instanceCount) &&
    typeof candidate.instanceCount === "number" &&
    candidate.instanceCount >= 0 &&
    Number.isInteger(candidate.presentCount) &&
    typeof candidate.presentCount === "number" &&
    candidate.presentCount >= 0 &&
    candidate.presentCount <= candidate.instanceCount &&
    typeof candidate.structureHash === "string" &&
    typeof candidate.contentHash === "string"
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
    if (typeof candidate.graphContract !== "string") return null;
    if (
      candidate.projectType !== null &&
      candidate.projectType !== "brownfield" &&
      candidate.projectType !== "greenfield"
    ) {
      return null;
    }
    if (
      !Array.isArray(candidate.inputs) ||
      !candidate.inputs.every(isArtifactBasis) ||
      !Array.isArray(candidate.outputs) ||
      !candidate.outputs.every(isArtifactBasis)
    ) {
      return null;
    }
    return {
      schema: VALIDATION_BASIS_SCHEMA,
      graphContract: candidate.graphContract,
      projectType: candidate.projectType,
      inputs: sortedArtifactBases(candidate.inputs),
      outputs: sortedArtifactBases(candidate.outputs),
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

function completionReceiptsFromAudit(audit: string): CompletionReceipts {
  const current = new Map<string, StageValidationBasis>();
  const latestKnown = new Map<string, StageValidationBasis>();

  for (const event of orderedMainWorkflowEvents(audit)) {
    const stage = auditBlockField(event.block, "Stage");
    if (!stage) continue;
    if (event.event === "STAGE_STARTED") {
      // The previous receipt still describes the dependency graph that may have
      // fed later completed stages, but it is no longer current evidence for
      // this stage's execution attempt.
      current.delete(stage);
      continue;
    }
    if (event.event !== "STAGE_COMPLETED") continue;
    const basis = parseStageValidationBasis(
      auditBlockField(event.block, VALIDATION_BASIS_FIELD),
    );
    if (basis) {
      current.set(stage, basis);
      latestKnown.set(stage, basis);
    } else {
      // A legacy/schema-1 completion supersedes any older tracked receipt.
      current.delete(stage);
      latestKnown.delete(stage);
    }
  }
  return { current, latestKnown };
}

/** Return schema-3 receipts for each stage's current attempt. */
export function latestCompletionBasesFromAudit(
  audit: string,
): Map<string, StageValidationBasis> {
  return completionReceiptsFromAudit(audit).current;
}

function artifactBasisChanges(
  label: "input" | "output",
  before: readonly ArtifactBasis[],
  after: readonly ArtifactBasis[],
): string[] {
  const previous = new Map(before.map((item) => [artifactBasisKey(item), item]));
  const current = new Map(after.map((item) => [artifactBasisKey(item), item]));
  const keys = new Set([...previous.keys(), ...current.keys()]);
  const changes: string[] = [];
  for (const key of [...keys].sort()) {
    const left = previous.get(key);
    const right = current.get(key);
    if (canonicalJson(left) === canonicalJson(right)) continue;
    const sample = right ?? left;
    if (!sample) continue;
    changes.push(`${label}:${sample.artifact}`);
  }
  return changes;
}

export function diffStageValidationBasis(
  before: StageValidationBasis,
  after: StageValidationBasis,
): string[] {
  const changes: string[] = [];
  if (before.graphContract !== after.graphContract) {
    changes.push("graph-contract");
  }
  if (before.projectType !== after.projectType) changes.push("project-type");
  changes.push(...artifactBasisChanges("input", before.inputs, after.inputs));
  changes.push(...artifactBasisChanges("output", before.outputs, after.outputs));
  return changes;
}

function observedDependencyEdges(
  bases: ReadonlyMap<string, StageValidationBasis>,
): Map<string, ObservedDependency[]> {
  const edges = new Map<string, ObservedDependency[]>();
  const seen = new Set<string>();
  for (const [consumer, basis] of bases) {
    for (const input of basis.inputs) {
      const key = [input.producer, consumer, input.artifact].join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      const outgoing = edges.get(input.producer) ?? [];
      outgoing.push({
        to: consumer,
        artifact: input.artifact,
      });
      edges.set(input.producer, outgoing);
    }
  }
  for (const outgoing of edges.values()) {
    outgoing.sort((left, right) => {
      const a = `${left.to}\u0000${left.artifact}`;
      const b = `${right.to}\u0000${right.artifact}`;
      return a.localeCompare(b);
    });
  }
  return edges;
}

/**
 * Propagate stale roots through dependencies actually observed in schema-3
 * completion receipts. A declared-but-missing optional consume is not an edge.
 * requires_stage is not used because v2 does not yet distinguish semantic and
 * ordering-only requires edges.
 */
export function propagateStageInvalidation(
  stages: readonly StageValidityNode[],
  completedSlugs: ReadonlySet<string>,
  directReasons: ReadonlyMap<string, readonly string[]>,
  completionBases: ReadonlyMap<string, StageValidationBasis>,
): StageValidityIssue[] {
  const known = new Set(stages.map((stage) => stage.slug));
  const edges = observedDependencyEdges(completionBases);
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
    if (!reasons) continue;
    if (completedSlugs.has(stage.slug)) {
      issues.set(stage.slug, {
        direct: true,
        reasons: new Set(reasons),
        roots: new Set([stage.slug]),
      });
    }
    // Reopened/in-progress roots still invalidate completed consumers that were
    // based on their previous output receipt.
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
        `depends on stale stage "${current.slug}" via ` +
        `artifact:${edge.artifact}`;
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
 * Compare current completed-stage receipts with the current AI-DLC artifact
 * tree, then propagate drift through observed stage-level dependencies.
 * The function is read-only with respect to workflow state.
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
  const stageBySlug = new Map(stages.map((stage) => [stage.slug, stage]));
  const completedSlugs = new Set(
    parseCheckboxes(stateContent)
      .filter((checkbox) => checkbox.state === "completed")
      .map((checkbox) => checkbox.slug),
  );
  const audit = options.audit ?? readAllAuditShards(projectDir);
  const receipts = completionReceiptsFromAudit(audit);
  const directReasons = new Map<string, string[]>();
  const warnings: string[] = [];
  const unavailable = new Set<string>();

  for (const [slug, previous] of receipts.latestKnown) {
    const stage = stageBySlug.get(slug);
    if (!stage) continue;
    let current: StageValidationBasis;
    try {
      current = options.currentBasis
        ? options.currentBasis(stage, stages)
        : captureStageValidationBasis(projectDir, stage, stateContent, stages);
    } catch (error) {
      unavailable.add(slug);
      warnings.push(
        `Validity inspection unavailable for stage "${slug}": ` +
          validationErrorMessage(error),
      );
      continue;
    }
    const changes = diffStageValidationBasis(previous, current);
    if (changes.length > 0) directReasons.set(slug, changes);
  }

  const issues = propagateStageInvalidation(
    stages,
    completedSlugs,
    directReasons,
    receipts.latestKnown,
  );
  const untracked = stages
    .filter(
      (stage) =>
        completedSlugs.has(stage.slug) &&
        (!receipts.current.has(stage.slug) || unavailable.has(stage.slug)),
    )
    .map((stage) => stage.slug);

  return { issues, untracked, warnings };
}
