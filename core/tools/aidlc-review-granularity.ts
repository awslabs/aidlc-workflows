// Review granularity (stage-protocol-reviewer §12a, phase review).
//
// WHERE the agent review passes run; resolveReviewClass stays WHETHER and HOW.
// "stage" is the default behavior: every reviewer-bearing stage reviews before
// its own gate. "phase" defers each ideation/inception review to one grouped
// pass per reviewer, at that reviewer's last in-plan stage of the phase (the
// anchor), covering the deferred stages' artifacts together. Receipts stay per
// stage, so freshness, freeze, and recovery are unchanged; only the moment the
// review runs moves. Construction and per-unit stages are never grouped, and
// human approval gates are untouched.
//
// One owner: the directive emit (aidlc-orchestrate.ts), the gate precondition
// (aidlc-state.ts verifyReviewerPrecondition), and the settings surfaces all
// read phaseReviewRole / resolveReviewGranularity here, so they cannot
// disagree about where a review is owed. Isolated `--single` runs are carved
// out at directive emission only: an isolated attempt reviews as declared, its
// receipts are tagged `single-stage:` and excluded from main-workflow receipt
// scans, and no main-workflow gate runs for it, so the precondition never
// reads a role for an isolated attempt.

import { getField, parseCheckboxes } from "./aidlc-record-core.ts";
import {
  loadScopeMapping,
  loadScopeMetadata,
  loadStageGraph,
  parseStateStageSuffixes,
  resolveReviewClass,
} from "./aidlc-lib.ts";

export const REVIEW_GRANULARITIES = ["stage", "phase"] as const;
export type ReviewGranularity = (typeof REVIEW_GRANULARITIES)[number];

export function asReviewGranularity(v: string | null | undefined): ReviewGranularity | null {
  return v === "stage" || v === "phase" ? v : null;
}

/** The per-work granularity: the state's `Review Granularity` field when set
 *  (config set review-granularity), else the scope's own
 *  `review_granularity:`, else "stage". */
export function resolveReviewGranularity(
  scope: string | null | undefined,
  stateContent?: string | null,
): ReviewGranularity {
  const override = asReviewGranularity(
    stateContent ? getField(stateContent, "Review Granularity") : null
  );
  if (override !== null) return override;
  const scopeName = scope?.trim().toLowerCase();
  try {
    return (scopeName ? loadScopeMetadata()[scopeName]?.reviewGranularity : undefined) ?? "stage";
  } catch {
    return "stage";
  }
}

/** The phases whose reviews the "phase" granularity groups. Construction
 *  reviews are per-Unit and entangled with convergence checkpoints, loop-back,
 *  and swarm merging, so they always run per stage. */
export const PHASE_REVIEW_PHASES: ReadonlySet<string> = new Set(["ideation", "inception"]);

export interface PhaseReviewStage {
  slug: string;
  name: string;
  phase: string;
  for_each?: string;
  reviewer?: string;
  review_class?: string;
}

export type PhaseReviewRole =
  | { role: "stage" }
  | { role: "deferred"; anchor: string }
  | { role: "anchor"; covers: PhaseReviewStage[] };

/** One stage's place in the phase-review grouping, resolved from the same
 *  inputs every boundary reads (scope grid, state EXECUTE/SKIP overrides and
 *  checkboxes, the class resolution in aidlc-lib.ts), so the directive emit
 *  and the gate precondition can never disagree. "stage" = review runs here as
 *  declared (also the answer whenever granularity is "stage", the phase is not
 *  grouped, or the stage is the only in-plan member of its reviewer's group). */
export function phaseReviewRole(
  stage: PhaseReviewStage,
  scope: string,
  stateContent?: string | null,
): PhaseReviewRole {
  if (resolveReviewGranularity(scope, stateContent) !== "phase") return { role: "stage" };
  if (!PHASE_REVIEW_PHASES.has(stage.phase) || !stage.reviewer) return { role: "stage" };
  if (stage.for_each === "unit-of-work") return { role: "stage" };
  if (resolveReviewClass(stage.review_class, scope, stateContent) === "none") return { role: "stage" };
  const mapping = loadScopeMapping()[scope];
  if (!mapping) return { role: "stage" };
  const overrides = stateContent ? parseStateStageSuffixes(stateContent) : null;
  const checkboxes = stateContent ? parseCheckboxes(stateContent) : [];
  const inPlan = (slug: string): boolean => {
    const cb = checkboxes.find((c) => c.slug === slug);
    if (cb?.state === "skipped") return false;
    if (cb?.state === "completed") return true;
    return (overrides?.get(slug) ?? mapping.stages[slug]) === "EXECUTE";
  };
  const group = loadStageGraph().filter((node) =>
    node.phase === stage.phase &&
    node.reviewer === stage.reviewer &&
    node.for_each !== "unit-of-work" &&
    resolveReviewClass(node.review_class, scope, stateContent) !== "none" &&
    inPlan(node.slug)
  );
  if (group.length <= 1) return { role: "stage" };
  const anchor = group[group.length - 1];
  if (stage.slug !== anchor.slug) {
    return group.some((node) => node.slug === stage.slug)
      ? { role: "deferred", anchor: anchor.slug }
      : { role: "stage" };
  }
  // The anchor covers the earlier group members that have run: a stage still
  // pending has nothing on disk to review, and a skipped one left the plan.
  const completed = new Set(
    checkboxes.filter((c) => c.state === "completed").map((c) => c.slug)
  );
  const covers = group
    .slice(0, -1)
    .filter((node) => completed.has(node.slug))
    .map((node) => ({
      slug: node.slug,
      name: node.name,
      phase: node.phase,
      ...(node.for_each ? { for_each: node.for_each } : {}),
      ...(node.reviewer ? { reviewer: node.reviewer } : {}),
      ...(node.review_class ? { review_class: node.review_class } : {}),
    }));
  return { role: "anchor", covers };
}
