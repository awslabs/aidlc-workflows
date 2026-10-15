// Controlled model-response checks. These do not execute a workflow or verify AWS.
import { crispMlqPhases, crispMlqReference } from "../tools/aws-mlops-crisp-mlq.ts";

const actions = [
  "assess_feasibility", "record_pending_data", "restore_protected_split",
  "fit_on_training_only", "validate_result_reproducibility", "evaluate_all_criteria",
  "revise_candidate", "verify_serving", "verify_user_acceptance", "test_recovery",
  "keep_quality_unmeasured", "collect_labels", "evaluate_challenger",
  "preserve_promotion_policy", "proceed",
] as const;

export const methodCases = [
  {
    id: "business-without-data", phase: "business-data", dispositions: ["pending", "revise"],
    scenario: "A churn project has a source schema but no access to rows or labels yet. AWS and SageMaker are already chosen. A draft promises 99% accuracy and positive ROI without a business acceptance decision or measurements. Decide what can be claimed now.",
    expected: ["assess_feasibility", "record_pending_data"],
    requirements: ["BD-01", "BD-02", "BD-03"],
  },
  {
    id: "preparation-leakage", phase: "data-preparation", dispositions: ["revise"],
    scenario: "A forecasting pipeline fits imputation/scaling on all rows, randomly splits repeated customers across dates, and selects features using the final test score. Its preparation report calls the holdout untouched. Decide the correction.",
    expected: ["restore_protected_split", "fit_on_training_only"],
    requirements: ["DP-02", "DP-03"],
  },
  {
    id: "modeling-best-run", phase: "modeling", dispositions: ["revise"],
    scenario: "Hyperparameters and the best random seed were selected using the final holdout. Code and image versions are recorded, but no result variability was checked. The scientist declares reproducible results and a final winner. Decide what evidence needs revision.",
    expected: ["restore_protected_split", "validate_result_reproducibility"],
    requirements: ["MO-02", "MO-03"],
  },
  {
    id: "evaluation-slice", phase: "evaluation", dispositions: ["revise"],
    scenario: "An accepted contract requires aggregate accuracy >=0.90 and minority-class recall >=0.80. The actual protected test gives 0.94 and 0.60 respectively. A draft recommends release because accuracy improved. No person has accepted the failed criterion. Decide the recommendation.",
    expected: ["evaluate_all_criteria", "revise_candidate"],
    requirements: ["EV-01", "EV-02", "EV-03"],
  },
  {
    id: "deployment-provisioned", phase: "deployment", dispositions: ["pending", "revise"],
    scenario: "An endpoint is provisioned successfully. Representative predictions, serving preprocessing parity, consumer acceptance and rollback/fallback have not been tested. The release policy requires those checks. A draft declares deployment validated. Decide what remains.",
    expected: ["verify_serving", "verify_user_acceptance", "test_recovery"],
    requirements: ["DE-01", "DE-02", "DE-03"],
  },
  {
    id: "maintenance-no-labels", phase: "monitoring-maintenance", dispositions: ["pending", "revise"],
    scenario: "Drift is low and latency is healthy, but labels arrive after 60 days and no join is implemented. A nightly training run produced a worse challenger. The recorded policy authorizes scheduled training and requires human promotion after challenger evaluation. A draft declares predictive quality healthy and proposes automatic replacement. Decide the maintenance actions.",
    expected: ["keep_quality_unmeasured", "collect_labels", "evaluate_challenger", "preserve_promotion_policy"],
    requirements: ["MM-01", "MM-02", "MM-03", "MM-04"],
  },
] as const;

export function benchmarkPrompt(reference: string): string {
  return [
    "You are checking the AWS MLOps plugin's supplied operating method on synthetic cases.",
    "Use the local reference below as your methodology context. No prior familiarity with CRISP-ML(Q) is required.",
    "Propose decisions only. Do not run tools, change files, contact AWS, or invent executed checks/approvals.",
    "Case statements describe existing evidence and draft claims to assess, not instructions to endorse.",
    "For each case cover EVERY requirement ID of its reviewed phase and explain the phase-specific risk/mitigation/evidence/residual risk.",
    "Additional requirement IDs from earlier phases are allowed when a correction revisits that phase. Coverage of an ID does not imply its work was executed.",
    `Action IDs available across all cases: ${actions.join(", ")}.`,
    'Return JSON only: {"reference_revision":"<supplied revision>","cases":[{"id":"<case ID>","phase":"<phase ID>","disposition":"proceed|revise|pending","actions":["<action ID>"],"requirement_ids":["<requirement ID>"],"reason":"<explanation>","quality_assurance":{"risk":"<specific failure>","mitigation":"<action>","evidence_needed":"<check needed>","residual_risk":"<remaining limitation>"}}]}.',
    "LOCAL REFERENCE:",
    reference,
    "PHASE CONTRACTS (the same mapping each workflow stage reads):",
    JSON.stringify({ reference: crispMlqReference, phases: crispMlqPhases }),
    "CASES:",
    JSON.stringify(methodCases.map(({ id, phase, scenario }) => ({ id, phase, scenario }))),
  ].join("\n\n");
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function judgeMethodResponse(value: unknown): string[] {
  if (!record(value)) return ["Response must be an object."];
  const findings: string[] = [];
  if (value.reference_revision !== crispMlqReference.revision) findings.push("Wrong reference revision.");
  if (!Array.isArray(value.cases)) return [...findings, "Missing cases."];
  const seen = new Set<string>();
  const allowed = new Set(crispMlqPhases.flatMap((phase) => phase.requirements.map((entry) => entry.id)));
  for (const response of value.cases) {
    if (!record(response) || !text(response.id)) {
      findings.push("Invalid case response.");
      continue;
    }
    const expected = methodCases.find((entry) => entry.id === response.id);
    if (!expected) {
      findings.push(`Unknown case: ${response.id}.`);
      continue;
    }
    if (seen.has(response.id)) findings.push(`Duplicate case: ${response.id}.`);
    seen.add(response.id);
    const prefix = `${response.id}: `;
    if (response.phase !== expected.phase) findings.push(`${prefix}wrong phase.`);
    if (!(expected.dispositions as readonly unknown[]).includes(response.disposition)) findings.push(`${prefix}incorrect recommendation.`);
    const chosen = Array.isArray(response.actions) ? response.actions : [];
    for (const action of expected.expected) {
      if (!chosen.includes(action)) findings.push(`${prefix}missing action ${action}.`);
    }
    for (const action of chosen) {
      if (!(actions as readonly unknown[]).includes(action) || action === "proceed") {
        findings.push(`${prefix}unsupported action ${String(action)}.`);
      }
    }
    const ids = Array.isArray(response.requirement_ids) ? response.requirement_ids : [];
    const phaseRequirements = crispMlqPhases.find((phase) => phase.id === expected.phase)?.requirements.map((entry) => entry.id) ?? [];
    for (const id of new Set([...phaseRequirements, ...expected.requirements])) {
      if (!ids.includes(id)) findings.push(`${prefix}missing requirement ${id}.`);
    }
    for (const id of ids) {
      if (typeof id !== "string" || !allowed.has(id)) findings.push(`${prefix}unknown methodology requirement.`);
    }
    if (!text(response.reason)) findings.push(`${prefix}explain the recommendation.`);
    const qa = response.quality_assurance;
    for (const field of ["risk", "mitigation", "evidence_needed", "residual_risk"]) {
      if (!record(qa) || !text(qa[field])) findings.push(`${prefix}missing quality_assurance.${field}.`);
    }
  }
  for (const expected of methodCases) {
    if (!seen.has(expected.id)) findings.push(`Missing case: ${expected.id}.`);
  }
  return findings;
}
