import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkEvidence,
  inspectOutput,
} from "../tools/aidlc-sensor-aws-mlops-evidence.ts";
import { methodologies } from "../tools/aws-mlops-methodologies.ts";

const scratch = mkdtempSync(join(tmpdir(), "aidlc-mlops-evidence-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const selection = {
  methodology: "crisp-mlq",
  availability: "available",
  selection_source: "human",
  user_request: "Quiero usar CRISP-ML(Q).",
  profile: "model",
  stack: "aws-sagemaker",
};

function evaluation() {
  return {
    dataset_version: "s3://fixture/data?versionId=dataset-1",
    split_version: "split-1",
    code_revision: "fixture-revision",
    image_digest: "sha256:fixture",
    training_run: "fixture:training/run-1",
    model_artifact: "s3://fixture/model?versionId=model-1",
    criteria_reference: "fixture:approved-quality-contract",
    evaluation_set: "held-out-test",
    sample_count: 100,
    status: "passed",
    metrics: [
      {
        name: "recall",
        direction: "min",
        threshold: 0.8,
        observed: 0.8,
        evidence_reference: "fixture:recall-result",
      },
      {
        name: "error",
        direction: "max",
        threshold: 0.1,
        observed: 0.1,
        evidence_reference: "fixture:error-result",
      },
    ],
  };
}

describe("explicit methodology choice", () => {
  test("only the implemented method exposes an executable scope", () => {
    expect(methodologies.filter((entry) => entry.status === "available").map((entry) => entry.id))
      .toEqual(["crisp-mlq"]);
    for (const entry of methodologies) {
      if (entry.status === "planned") expect(entry.scope).toBeNull();
    }
  });

  test("accepts an explicit existing choice without imposing a new question", () => {
    expect(checkEvidence("selection", selection).pass).toBe(true);
  });

  test("an agent default and an empty human request remain findings", () => {
    expect(checkEvidence("selection", { ...selection, selection_source: "agent" }).pass).toBe(false);
    expect(checkEvidence("selection", { ...selection, user_request: " " }).pass).toBe(false);
  });

  test("a planned choice can be recorded without pretending it is executable", () => {
    expect(checkEvidence("selection", {
      ...selection, methodology: "semma", availability: "planned",
    }).pass).toBe(true);
    expect(checkEvidence("selection", {
      ...selection, methodology: "semma", availability: "available",
    }).pass).toBe(false);
    expect(checkEvidence("selection", { ...selection, methodology: "unknown" }).pass).toBe(false);
  });
});

describe("reported evaluation evidence", () => {
  test("accepts inclusive minimum and maximum thresholds", () => {
    expect(checkEvidence("evaluation", evaluation()).pass).toBe(true);
  });

  test("reports both directions failing and a contradictory success claim", () => {
    const value = evaluation();
    value.metrics[0].observed = 0.79;
    value.metrics[1].observed = 0.11;
    const result = checkEvidence("evaluation", value);
    expect(result.pass).toBe(false);
    expect(result.findings).toContain("recall: acceptance threshold was not met.");
    expect(result.findings).toContain("error: acceptance threshold was not met.");
    expect(result.findings).toContain("Reported status must be failed.");
    value.status = "failed";
    expect(checkEvidence("evaluation", value).findings).not.toContain("Reported status must be failed.");
    expect(checkEvidence("evaluation", value).pass).toBe(false);
  });

  test("rejects incomplete lineage, non-test evaluation and missing measurements", () => {
    const value = evaluation();
    value.dataset_version = "";
    value.evaluation_set = "validation";
    value.sample_count = 0;
    value.metrics[0].evidence_reference = "";
    const result = checkEvidence("evaluation", value);
    expect(result.findings_count).toBeGreaterThanOrEqual(4);
    expect(result.pass).toBe(false);
  });

  test("rejects duplicate metrics, invalid directions and non-finite/string numbers", () => {
    const value = evaluation();
    value.metrics[1].name = value.metrics[0].name;
    value.metrics[0].observed = Number.NaN;
    value.metrics[1].direction = "maximize";
    expect(checkEvidence("evaluation", value).pass).toBe(false);
    expect(checkEvidence("evaluation", {
      ...evaluation(), metrics: [{ ...evaluation().metrics[0], observed: "0.9" }],
    }).pass).toBe(false);
    expect(checkEvidence("evaluation", {
      ...evaluation(), metrics: [{ ...evaluation().metrics[0], threshold: Number.POSITIVE_INFINITY }],
    }).pass).toBe(false);
  });

  test("empty, missing and malformed evidence cannot establish a passing result", () => {
    for (const value of [null, [], "result", {}, { ...evaluation(), metrics: [] }]) {
      expect(checkEvidence("evaluation", value).pass).toBe(false);
    }
    const path = join(scratch, "aws-mlops-evaluation.md");
    expect(inspectOutput(path).pass).toBe(false);
    writeFileSync(join(scratch, "aws-mlops-evaluation.json"), "{malformed");
    expect(inspectOutput(path).pass).toBe(false);
    writeFileSync(join(scratch, "aws-mlops-evaluation.json"), JSON.stringify(evaluation()));
    expect(inspectOutput(path).pass).toBe(true);
  });

  test("unrelated deliverables are clean no-ops", () => {
    expect(inspectOutput(join(scratch, "memory.md"))).toEqual({
      pass: true, findings_count: 0, findings: [],
    });
  });
});
