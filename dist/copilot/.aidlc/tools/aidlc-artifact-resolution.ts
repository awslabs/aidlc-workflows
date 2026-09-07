import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  artifactFilename,
  KNOWN_CODEKB_STAGES,
} from "./aidlc-artifact-vocabulary.ts";
import {
  codekbDir,
  codekbRepoName,
  effectivePlanAction,
  filterProducesByKind,
  getField,
  intentRepos,
  isPerUnitStage,
  recordDir,
  assertNoSymlinkInChainOrThrow,
  readRegularFileNoFollowOrThrow,
  resolveBoltDag,
  toPosix,
  usesStageLevelPerUnitArtifacts,
} from "./aidlc-lib.js";

export interface ArtifactOwnerNode {
  slug: string;
  phase: string;
  for_each?: string;
  produces?: readonly string[];
  produces_kinds?: Readonly<Record<string, readonly string[]>>;
}

export interface ArtifactRuntimeUnit {
  name: string;
  kind: string | null;
}

export interface ArtifactInstance {
  artifact: string;
  producer: string;
  absolutePath: string;
  relativePath: string;
  unit: string | null;
  unitKind: string | null;
}

export interface ArtifactResolutionOptions {
  /** Explicit intent record for targeted read-only queries such as --status. */
  recordPath?: string;
  /** Deterministic test/embedding seam. Production callers use resolveBoltDag. */
  runtimeUnits?: readonly ArtifactRuntimeUnit[];
  /** Deterministic test/embedding seam for multi-repo codekb placement. */
  codekbRepos?: readonly string[];
  /** Workflow state used to mirror the engine's stage-level decision. */
  stateContent?: string;
}

export interface RequiredArtifactFailure {
  artifact: string;
  path: string;
  reason: string;
}

export interface RequiredArtifactInspection {
  ok: boolean;
  failures: RequiredArtifactFailure[];
}

export function isCodekbArtifactOwner(owner: { slug: string }): boolean {
  return KNOWN_CODEKB_STAGES.has(owner.slug);
}

function safeStageUnitDirectories(
  projectDir: string,
  stageSlug: string,
): ArtifactRuntimeUnit[] {
  const record = recordDir(projectDir);
  if (record === null) return [];
  const construction = join(record, "construction");
  if (!existsSync(construction)) return [];

  const units: ArtifactRuntimeUnit[] = [];
  try {
    for (const entry of readdirSync(construction, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const stageDir = join(construction, entry.name, stageSlug);
      try {
        if (existsSync(stageDir) && statSync(stageDir).isDirectory()) {
          units.push({ name: entry.name, kind: null });
        }
      } catch {
        // An unreadable candidate is not reliable runtime evidence.
      }
    }
  } catch {
    return [];
  }
  return units.sort((left, right) => left.name.localeCompare(right.name));
}

function uniqueRuntimeUnits(
  units: readonly ArtifactRuntimeUnit[],
): ArtifactRuntimeUnit[] {
  const byName = new Map<string, ArtifactRuntimeUnit>();
  for (const unit of units) {
    if (unit.name.length === 0) continue;
    const previous = byName.get(unit.name);
    if (previous && previous.kind !== unit.kind) {
      throw new Error(
        `Conflicting runtime kinds for unit "${unit.name}": ` +
          `"${previous.kind ?? ""}" and "${unit.kind ?? ""}".`,
      );
    }
    byName.set(unit.name, { name: unit.name, kind: unit.kind });
  }
  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/**
 * Resolve the active stage-instance set. The authored/runtime Bolt DAG is the
 * source of truth when available. A directory scan is only a compatibility
 * fallback for legacy/single-stage runs that have no DAG at all. A malformed
 * DAG fails closed because the expected per-unit artifact set is unknowable.
 */
export function resolveArtifactRuntimeUnits(
  projectDir: string,
  stageSlug: string,
  override?: readonly ArtifactRuntimeUnit[],
): ArtifactRuntimeUnit[] {
  if (override) return uniqueRuntimeUnits(override);

  const resolution = resolveBoltDag(projectDir);
  if (resolution.state === "malformed") {
    throw new Error(
      `Cannot resolve per-unit artifacts for "${stageSlug}": ` +
        `unit DAG is ${resolution.reason} (${resolution.detail}).`,
    );
  }
  if (resolution.state === "ok") {
    return uniqueRuntimeUnits(
      resolution.units.map((name) => ({
        name,
        kind: resolution.unitKinds?.get(name) ?? null,
      })),
    );
  }
  return safeStageUnitDirectories(projectDir, stageSlug);
}

function artifactAppliesToUnit(
  owner: ArtifactOwnerNode,
  artifact: string,
  unitKind: string | null,
): boolean {
  const map = owner.produces_kinds
    ? Object.fromEntries(
        Object.entries(owner.produces_kinds).map(([name, kinds]) => [
          name,
          [...kinds],
        ]),
      )
    : undefined;
  return filterProducesByKind(map, [artifact], unitKind).length === 1;
}

function relativeToProject(projectDir: string, path: string): string {
  return toPosix(relative(projectDir, path));
}

function codekbReposFor(
  projectDir: string,
  override?: readonly string[],
): string[] {
  const selected = override ? [...override] : intentRepos(projectDir);
  const repos = selected.length > 0 ? selected : [codekbRepoName(projectDir)];
  return [...new Set(repos.filter((repo) => repo.length > 0))].sort();
}

/**
 * Resolve a canonical artifact into the concrete files represented by the
 * current stage-instance graph. This is the validity counterpart of the
 * orchestrator's producer-owned path resolution:
 *
 * - codekb artifacts are per repository at space scope;
 * - per-unit artifacts are expanded from the Bolt DAG and filtered through
 *   `produces_kinds`;
 * - ordinary artifacts are stored under the active intent record.
 */
export function resolveArtifactInstances(
  projectDir: string,
  artifact: string,
  owner: ArtifactOwnerNode,
  options: ArtifactResolutionOptions = {},
): ArtifactInstance[] {
  const filename = artifactFilename(artifact);

  if (isCodekbArtifactOwner(owner)) {
    return codekbReposFor(projectDir, options.codekbRepos).map((repo) => {
      const absolutePath = join(codekbDir(projectDir, repo), filename);
      return {
        artifact,
        producer: owner.slug,
        absolutePath,
        relativePath: relativeToProject(projectDir, absolutePath),
        unit: null,
        unitKind: null,
      };
    });
  }

  const record = options.recordPath ?? recordDir(projectDir);
  if (record === null) {
    throw new Error(
      `Cannot resolve artifact "${artifact}" for stage "${owner.slug}": ` +
        "no active intent record is available.",
    );
  }

  if (isPerUnitStage(owner)) {
    if (options.stateContent !== undefined) {
      const scope = getField(options.stateContent, "Scope")?.trim();
      if (!scope) {
        throw new Error(
          `Cannot resolve artifacts for per-unit stage "${owner.slug}": ` +
            "workflow Scope is missing.",
        );
      }
      const unitProducerAction = effectivePlanAction(
        "units-generation",
        scope,
        options.stateContent,
      );
      if (unitProducerAction === undefined) {
        throw new Error(
          `Cannot resolve artifacts for per-unit stage "${owner.slug}": ` +
            `Units Generation has no effective action for scope "${scope}".`,
        );
      }
      if (usesStageLevelPerUnitArtifacts(scope, options.stateContent)) {
        const absolutePath = join(record, owner.phase, owner.slug, filename);
        return [
          {
            artifact,
            producer: owner.slug,
            absolutePath,
            relativePath: relativeToProject(projectDir, absolutePath),
            unit: null,
            unitKind: null,
          },
        ];
      }
    }
    const units = resolveArtifactRuntimeUnits(
      projectDir,
      owner.slug,
      options.runtimeUnits,
    );
    const instances: ArtifactInstance[] = [];
    for (const unit of units) {
      if (!artifactAppliesToUnit(owner, artifact, unit.kind)) continue;
      const absolutePath = join(
        record,
        "construction",
        unit.name,
        owner.slug,
        filename,
      );
      instances.push({
        artifact,
        producer: owner.slug,
        absolutePath,
        relativePath: relativeToProject(projectDir, absolutePath),
        unit: unit.name,
        unitKind: unit.kind,
      });
    }
    return instances.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
  }

  const absolutePath = join(record, owner.phase, owner.slug, filename);
  return [
    {
      artifact,
      producer: owner.slug,
      absolutePath,
      relativePath: relativeToProject(projectDir, absolutePath),
      unit: null,
      unitKind: null,
    },
  ];
}

/**
 * Inspect every concrete instance of every required `produces[]` artifact.
 * Resolution stays graph-owned; file authority uses the shared no-follow,
 * single-link regular-file reader and rejects redirected parent components.
 */
export function inspectRequiredArtifactInstances(
  projectDir: string,
  owner: ArtifactOwnerNode,
  options: ArtifactResolutionOptions = {},
): RequiredArtifactInspection {
  const failures: RequiredArtifactFailure[] = [];
  const anchor = realpathSync(projectDir);
  for (const artifact of owner.produces ?? []) {
    const instances = resolveArtifactInstances(
      projectDir,
      artifact,
      owner,
      options,
    );
    if (instances.length === 0) {
      failures.push({
        artifact,
        path: artifact,
        reason: "no canonical runtime instance resolved",
      });
      continue;
    }
    for (const instance of instances) {
      try {
        const relativePath = relative(projectDir, instance.absolutePath);
        assertNoSymlinkInChainOrThrow(anchor, relativePath);
        readRegularFileNoFollowOrThrow(
          instance.absolutePath,
          `required artifact "${instance.relativePath}"`,
        );
      } catch (error) {
        failures.push({
          artifact,
          path: instance.relativePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}
