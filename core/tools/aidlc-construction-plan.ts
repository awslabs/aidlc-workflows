import {
  auditBlockField,
  constructionCheckpointsApply,
  constructionSkeletonOn,
  getField,
  isTeamUnitOwnership,
  parseBoltDag,
  readAuditShardEvents,
  readRegularFileNoFollowOrThrow,
  resolveBoltDag,
  setField,
  unitDependencyPath,
  validateUnitName,
  type BoltDagResolution,
  type UnitDependencyEdge,
} from "./aidlc-lib.ts";

export interface ConstructionPlan {
  version: 1;
  units: string[];
  proof_unit: string;
}

export const CONSTRUCTION_PLAN_FIELD = "Construction Plan";
export const CONSTRUCTION_PLAN_RECOVERY =
  "Revise the Construction plan, or retire it with `aidlc engine state set-construction-plan --retire` when the person asks to return to dependency order. Recorded work and approvals are retained.";

export function parseConstructionPlan(value: string | null): ConstructionPlan | null {
  if (value === null || value === "retired") return null;
  let plan: unknown;
  try { plan = JSON.parse(value); } catch { throw new Error("Construction Plan must be valid JSON. " + CONSTRUCTION_PLAN_RECOVERY); }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("Invalid Construction Plan.");
  const p = plan as Record<string, unknown>;
  if (p.version !== 1 || typeof p.proof_unit !== "string" ||
    !Array.isArray(p.units) || p.units.length === 0 || p.units.length > 1000 ||
    p.units.some((unit) => typeof unit !== "string" || validateUnitName(unit) !== null) ||
    validateUnitName(p.proof_unit) !== null ||
    Object.keys(p).some((key) => !["version", "units", "proof_unit"].includes(key))) {
    throw new Error("Construction Plan requires version 1, a proof_unit and a nonempty list of Unit names.");
  }
  return { version: 1, units: p.units as string[], proof_unit: p.proof_unit };
}

export function validateConstructionPlan(plan: ConstructionPlan, dependencies: readonly UnitDependencyEdge[]): ConstructionPlan {
  const positions = new Map(plan.units.map((unit, index) => [unit, index]));
  if (positions.size !== plan.units.length || plan.units.length !== dependencies.length ||
    dependencies.some((unit) => !positions.has(unit.name)) || !positions.has(plan.proof_unit)) {
    throw new Error("Construction Plan must name every DAG Unit exactly once and select one of them as the proof.");
  }
  for (const unit of dependencies) {
    if (unit.depends_on.some((dependency) => !positions.has(dependency) || positions.get(dependency)! >= positions.get(unit.name)!)) {
      throw new Error(`Construction Plan places "${unit.name}" before a prerequisite.`);
    }
  }
  return plan;
}

export interface ResolvedConstructionPlan {
  custom: boolean;
  units: string[];
  proofUnit: string | null;
  dependencies: readonly UnitDependencyEdge[];
}

export function constructionPlanPolicyCompatible(state: string): boolean {
  return getField(state, "Construction Iteration") === "unit-major" &&
    getField(state, "Construction Execution") === "serial" &&
    !isTeamUnitOwnership(state) && constructionCheckpointsApply(state) && constructionSkeletonOn(state);
}

/** Called by the owning, authorized policy mutation before its audit-first write. */
export function reconcileConstructionPlanPolicy(before: string, candidate: string): {
  content: string;
  audit: Array<{ eventType: "CONSTRUCTION_POLICY_SET"; fields: Record<string, string> }>;
  lines: string[];
} {
  const prior = getField(before, CONSTRUCTION_PLAN_FIELD);
  if (parseConstructionPlan(prior) === null || constructionPlanPolicyCompatible(candidate)) {
    return { content: candidate, audit: [], lines: [] };
  }
  return {
    content: setField(candidate, CONSTRUCTION_PLAN_FIELD, "retired"),
    audit: [{ eventType: "CONSTRUCTION_POLICY_SET", fields: {
      Field: CONSTRUCTION_PLAN_FIELD, Value: "retired", "Previous Value": prior!,
      "Construction Iteration": getField(candidate, "Construction Iteration") ?? "unset",
      "Construction Checkpoints": getField(candidate, "Construction Checkpoints") ?? "unset",
      Reason: "The requested execution or scope policy is incompatible with the explicit serial plan",
    } }],
    lines: ["Your policy change retires the explicit build order and named proof. Recorded work and approvals remain; no proof or autonomy was granted."],
  };
}

/** One resolver serves routing, direct checkpoint calls and policy changes. */
export function resolveConstructionPlan(projectDir: string, state: string, dag?: BoltDagResolution): ResolvedConstructionPlan {
  const plan = parseConstructionPlan(getField(state, CONSTRUCTION_PLAN_FIELD));
  const resolved = dag ?? resolveBoltDag(projectDir);
  if (plan === null) {
    const units = resolved.state === "ok" ? resolved.batches.flat() : [];
    return { custom: false, units, proofUnit: constructionSkeletonOn(state) ? units[0] ?? null : null, dependencies: [] };
  }
  if (!constructionPlanPolicyCompatible(state)) {
    throw new Error("The explicit Construction plan needs serial, solo, unit-major work with checkpoints and the integrated proof on. " + CONSTRUCTION_PLAN_RECOVERY);
  }
  if (resolved.state !== "ok") throw new Error("The explicit Construction plan needs its authoritative Unit dependencies. " + CONSTRUCTION_PLAN_RECOVERY);
  const parsed = parseBoltDag(readRegularFileNoFollowOrThrow(unitDependencyPath(projectDir), "Unit dependencies").toString("utf8"));
  if (!parsed.ok) throw new Error("The explicit Construction plan has invalid Unit dependencies. " + CONSTRUCTION_PLAN_RECOVERY);
  validateConstructionPlan(plan, parsed.units);
  return { custom: true, units: [...plan.units], proofUnit: plan.proof_unit, dependencies: parsed.units };
}

export function constructionProofUnit(state: string, defaultUnits: readonly string[]): string | null {
  const plan = parseConstructionPlan(getField(state, CONSTRUCTION_PLAN_FIELD));
  return plan?.proof_unit ?? (constructionSkeletonOn(state) ? defaultUnits[0] ?? null : null);
}

/** Only untouched suffixes can move without migrating historical approvals. */
export function validateConstructionPlanRevision(projectDir: string, before: string, after: string): void {
  const prior = parseConstructionPlan(getField(before, CONSTRUCTION_PLAN_FIELD));
  const next = parseConstructionPlan(getField(after, CONSTRUCTION_PLAN_FIELD));
  if (next === null) return;
  resolveConstructionPlan(projectDir, after);
  const touched = new Set<string>();
  for (const row of readAuditShardEvents(projectDir)) {
    if (!/^(UNIT_|REVIEW_|PLAN_|GATE_|CONSTRUCTION_CHECKPOINT_)/.test(row.event)) continue;
    const unit = auditBlockField(row.block, "Unit");
    if (unit) touched.add(unit);
  }
  if (touched.size === 0) return;
  if (prior === null || prior.proof_unit !== next.proof_unit) {
    throw new Error("Choose the named proof before Unit work starts; changing it later requires retiring and replanning this build. " + CONSTRUCTION_PLAN_RECOVERY);
  }
  const lastTouched = Math.max(...prior.units.map((unit, index) => touched.has(unit) ? index : -1));
  if (prior.units.slice(0, lastTouched + 1).some((unit, index) => next.units[index] !== unit)) {
    throw new Error("Only the untouched suffix of a Construction plan can be reordered. " + CONSTRUCTION_PLAN_RECOVERY);
  }
}
