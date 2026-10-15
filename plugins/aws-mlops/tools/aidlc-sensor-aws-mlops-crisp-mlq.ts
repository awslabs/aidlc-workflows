import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { crispMlqPhases, crispMlqReference, phaseForStage } from "./aws-mlops-crisp-mlq.ts";
import type { EvidenceVerdict } from "./aidlc-sensor-aws-mlops-evidence.ts";

type Value = Record<string, unknown>;
const isRecord = (value: unknown): value is Value =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const hasTexts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every(hasText);
const verdict = (findings: string[]): EvidenceVerdict =>
  ({ pass: findings.length === 0, findings_count: findings.length, findings });

export function checkMethodCoverage(stage: string, value: unknown): EvidenceVerdict {
  const phase = phaseForStage(stage);
  if (!phase) return verdict(["Stage has no CRISP-ML(Q) model-phase contract."]);
  if (!isRecord(value)) return verdict(["Method coverage must be a JSON object."]);
  const findings: string[] = [];
  if (value.schema_version !== 1) findings.push("schema_version must be 1.");
  if (value.methodology !== crispMlqReference.methodology) findings.push("Methodology must be crisp-mlq.");
  if (value.reference_revision !== crispMlqReference.revision) findings.push("Read and record the current local reference revision.");
  if (value.stage !== stage) findings.push("Coverage stage disagrees with the output's phase.");
  if (value.profile === "platform" &&
    (phase.id === "deployment" || phase.id === "monitoring-maintenance")) {
    if (value.applicability !== "platform-commissioning" || !hasText(value.rationale)) {
      findings.push("Platform non-applicability needs platform-commissioning and a rationale.");
    }
    return verdict(findings);
  }
  if (value.profile !== "model") findings.push("Phase coverage belongs to the model profile.");

  const expected = new Map(phase.requirements.map((requirement) => [requirement.id, requirement]));
  const seen = new Set<string>();
  if (!Array.isArray(value.requirements)) {
    findings.push("requirements must be an array.");
  } else {
    for (const entry of value.requirements) {
      if (!isRecord(entry) || !hasText(entry.id)) {
        findings.push("Each requirement needs an ID.");
        continue;
      }
      const requirement = expected.get(entry.id);
      if (!requirement) findings.push(`Unknown requirement for this phase: ${entry.id}.`);
      if (seen.has(entry.id)) findings.push(`Duplicate requirement: ${entry.id}.`);
      seen.add(entry.id);
      if (!["met", "pending", "failed", "not-applicable"].includes(String(entry.status))) {
        findings.push(`${entry.id}: invalid requirement status.`);
      }
      if (entry.status === "pending" || entry.status === "failed") findings.push(`${entry.id}: ${entry.status}.`);
      if (entry.status === "not-applicable" && !requirement?.allows_not_applicable) {
        findings.push(`${entry.id}: this requirement cannot be omitted as not applicable.`);
      }
      if (!hasText(entry.rationale)) findings.push(`${entry.id}: explain the evidence or missing work.`);
      if (!Array.isArray(entry.evidence)) {
        findings.push(`${entry.id}: evidence must be an array.`);
      } else {
        if (entry.status === "met" && entry.evidence.length === 0) findings.push(`${entry.id}: met requires evidence.`);
        if (entry.status === "met" && entry.evidence.length > 0 &&
          entry.evidence.every((evidence) => isRecord(evidence) && evidence.kind === "proposed")) {
          findings.push(`${entry.id}: a proposal alone is not completed phase evidence.`);
        }
        for (const evidence of entry.evidence) {
          if (!isRecord(evidence) || !hasText(evidence.reference) ||
            !["proposed", "local", "aws", "human"].includes(String(evidence.kind))) {
            findings.push(`${entry.id}: invalid evidence reference or kind.`);
          }
        }
      }
    }
  }
  for (const id of expected.keys()) {
    if (!seen.has(id)) findings.push(`Missing phase requirement: ${id}.`);
  }

  const qa = value.quality_assurance;
  if (!isRecord(qa)) return verdict([...findings, "Record quality_assurance for this phase."]);
  if (!hasText(qa.criteria_reference)) findings.push("Quality assurance needs the accepted criteria reference.");
  if (!hasTexts(qa.constraints)) findings.push("List the assessed constraints.");
  if (!hasTexts(qa.tasks)) findings.push("List the actual phase tasks.");
  if (!Array.isArray(qa.risks)) return verdict([...findings, "risks must be an array."]);
  if (qa.risks.length === 0 && !hasText(qa.no_risks_rationale)) findings.push("Explain a risk assessment that identified no risks.");
  const riskIds = new Set<string>();
  for (const risk of qa.risks) {
    if (!isRecord(risk)) {
      findings.push("Each risk must be an object.");
      continue;
    }
    for (const field of ["id", "description", "likelihood", "impact", "mitigation", "owner", "residual_risk"]) {
      if (!hasText(risk[field])) findings.push(`Risk record needs ${field}.`);
    }
    if (hasText(risk.id)) {
      if (riskIds.has(risk.id)) findings.push(`Duplicate risk: ${risk.id}.`);
      riskIds.add(risk.id);
    }
    if (!["open", "mitigated", "accepted"].includes(String(risk.status))) findings.push("Risk status must be open, mitigated or accepted.");
    if (risk.status === "open") findings.push(`Open risk: ${String(risk.id)}.`);
    if (risk.status === "mitigated" && !hasText(risk.verification_reference)) findings.push("A mitigated risk needs its verification reference.");
    if (risk.status === "accepted" && !hasText(risk.decision_reference)) findings.push("An accepted risk needs its recorded decision reference.");
  }
  return verdict(findings);
}

export function inspectMethodOutput(outputPath: string): EvidenceVerdict {
  const phase = crispMlqPhases.find((entry) => entry.output === basename(outputPath));
  if (!phase) return verdict([]);
  const sidecar = join(dirname(outputPath), phase.output.replace(/\.md$/, ".crisp-mlq.json"));
  try {
    return checkMethodCoverage(phase.stage, JSON.parse(readFileSync(sidecar, "utf-8")));
  } catch {
    return verdict([`Missing or malformed methodology coverage: ${basename(sidecar)}.`]);
  }
}

if (import.meta.main) {
  const index = process.argv.indexOf("--output-path");
  const path = index < 0 ? undefined : process.argv[index + 1];
  console.log(JSON.stringify(path ? inspectMethodOutput(path) : verdict(["--output-path is required."])));
}
