import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { methodologies } from "./aws-mlops-methodologies.ts";

type RecordValue = Record<string, unknown>;
export interface EvidenceVerdict {
  pass: boolean;
  findings_count: number;
  findings: string[];
}

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function checkEvidence(
  kind: "selection" | "evaluation",
  value: unknown,
): EvidenceVerdict {
  const findings: string[] = [];
  if (!record(value)) return verdict(["Evidence must be a JSON object."]);
  if (kind === "selection") {
    const method = methodologies.find((entry) => entry.id === value.methodology);
    if (!method) findings.push("Methodology is absent from the catalog.");
    else if (value.availability !== method.status) {
      findings.push("Availability disagrees with the methodology catalog.");
    }
    if (!text(value.user_request)) findings.push("Record the person's request.");
    if (value.selection_source !== "human") {
      findings.push("An agent recommendation is not a human selection.");
    }
    if (value.profile !== "platform" && value.profile !== "model") {
      findings.push("Profile must be platform or model.");
    }
    if (value.stack !== "aws-sagemaker") findings.push("Record the AWS SageMaker stack.");
  } else {
    for (const field of [
      "dataset_version", "split_version", "code_revision", "image_digest",
      "training_run", "model_artifact", "criteria_reference",
    ]) {
      if (!text(value[field])) findings.push(`Missing lineage field: ${field}.`);
    }
    if (value.evaluation_set !== "held-out-test") {
      findings.push("Evaluation must identify the held-out test set.");
    }
    if (!Number.isInteger(value.sample_count) || (value.sample_count as number) <= 0) {
      findings.push("sample_count must be a positive integer.");
    }
    let meetsAll = true;
    const ids = new Set<string>();
    if (!Array.isArray(value.metrics) || value.metrics.length === 0) {
      findings.push("At least one acceptance metric is required.");
    } else {
      for (const metric of value.metrics) {
        if (!record(metric) || !text(metric.name)) {
          findings.push("Each metric requires a name and numeric evidence.");
          continue;
        }
        if (ids.has(metric.name)) findings.push(`Duplicate metric: ${metric.name}.`);
        ids.add(metric.name);
        if (!finite(metric.observed) || !finite(metric.threshold)) {
          findings.push(`${metric.name}: observed and threshold must be finite numbers.`);
          continue;
        }
        if (metric.direction !== "min" && metric.direction !== "max") {
          findings.push(`${metric.name}: direction must be min or max.`);
          continue;
        }
        if (!text(metric.evidence_reference)) {
          findings.push(`${metric.name}: missing measurement reference.`);
        }
        const meets = metric.direction === "min"
          ? metric.observed >= metric.threshold
          : metric.observed <= metric.threshold;
        meetsAll = meetsAll && meets;
        if (!meets) findings.push(`${metric.name}: acceptance threshold was not met.`);
      }
    }
    const expected = meetsAll && findings.length === 0 ? "passed" : "failed";
    if (value.status !== expected) findings.push(`Reported status must be ${expected}.`);
  }
  return verdict(findings);
}

function verdict(findings: string[]): EvidenceVerdict {
  return { pass: findings.length === 0, findings_count: findings.length, findings };
}

export function inspectOutput(outputPath: string): EvidenceVerdict {
  const owned: Record<string, "selection" | "evaluation"> = {
    "aws-mlops-methodology-selection.md": "selection",
    "aws-mlops-evaluation.md": "evaluation",
  };
  const kind = owned[basename(outputPath)];
  if (!kind) return verdict([]);
  const evidencePath = join(dirname(outputPath), basename(outputPath).replace(/\.md$/, ".json"));
  try {
    return checkEvidence(kind, JSON.parse(readFileSync(evidencePath, "utf-8")));
  } catch {
    return verdict([`Missing or malformed evidence: ${basename(evidencePath)}.`]);
  }
}

if (import.meta.main) {
  const index = process.argv.indexOf("--output-path");
  const outputPath = index < 0 ? undefined : process.argv[index + 1];
  console.log(JSON.stringify(outputPath
    ? inspectOutput(outputPath)
    : verdict(["--output-path is required."])));
}
