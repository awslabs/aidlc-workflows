import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMethodCoverage, inspectMethodOutput } from "../tools/aidlc-sensor-aws-mlops-crisp-mlq.ts";
import { crispMlqPhases, crispMlqReference, type MethodPhase } from "../tools/aws-mlops-crisp-mlq.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "aidlc-crisp-mlq-evidence-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function report(phase: MethodPhase) {
  return {
    schema_version: 1,
    methodology: crispMlqReference.methodology,
    reference_revision: crispMlqReference.revision,
    profile: "model",
    stage: phase.stage,
    requirements: phase.requirements.map((requirement) => ({
      id: requirement.id,
      status: requirement.allows_not_applicable ? "not-applicable" : "met",
      evidence: requirement.allows_not_applicable ? [] : [{ reference: `fixture:${requirement.id}:check`, kind: "local" }],
      rationale: requirement.allows_not_applicable ? "Fixture uses no optional technique." : "Fixture check covers this requirement.",
    })),
    quality_assurance: {
      criteria_reference: "fixture:accepted-contract:revision-1",
      constraints: ["Fixture task uses synthetic inputs only."],
      tasks: ["Execute this phase's fixture checks."],
      risks: [{
        id: "fixture-risk", description: "Fixture coverage could be incomplete.",
        likelihood: "Possible because criteria have multiple dimensions.",
        impact: "An omitted requirement could be reported as complete.",
        mitigation: "Compare IDs with the phase contract.",
        owner: "fixture-reviewer", status: "mitigated",
        verification_reference: "fixture:coverage-check",
        residual_risk: "Semantic truth still requires review.",
      }],
    },
  };
}

describe("methodology source and traceability", () => {
  test("every phase and requirement is documented locally and maps to an executable stage", () => {
    const book = readFileSync(join(pluginRoot, crispMlqReference.knowledge_file), "utf-8");
    expect(book).toContain(crispMlqReference.revision);
    expect(book).toContain(crispMlqReference.source.replace("doi:", ""));
    expect(crispMlqPhases).toHaveLength(6);
    const ids = crispMlqPhases.flatMap((phase) => phase.requirements.map((requirement) => requirement.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const phase of crispMlqPhases) {
      const phaseDir = phase.id === "business-data" ? "ideation"
        : ["deployment", "monitoring-maintenance"].includes(phase.id) ? "operation" : "construction";
      const stage = readFileSync(join(pluginRoot, "stages", phaseDir, `${phase.stage}.md`), "utf-8");
      expect(stage).toContain(phase.output);
      expect(stage).toContain("aws-mlops-crisp-mlq.md");
      expect(stage).toContain("tools/aws-mlops-crisp-mlq.ts");
      expect(stage).toContain("Quality Assurance");
      expect(stage).toContain("aws-mlops-crisp-mlq]");
      for (const requirement of phase.requirements) {
        expect(book).toContain(`**${requirement.id}:**`);
        expect(requirement.source_sections.length).toBeGreaterThan(0);
        expect(requirement.evidence.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

describe("phase coverage and task quality", () => {
  for (const phase of crispMlqPhases) {
    test(`${phase.id}: complete synthetic coverage passes`, () => {
      expect(checkMethodCoverage(phase.stage, report(phase))).toEqual({
        pass: true, findings_count: 0, findings: [],
      });
    });
  }

  test("missing, duplicate and foreign-phase requirements are visible", () => {
    const phase = crispMlqPhases[0];
    const value = report(phase);
    value.requirements.pop();
    value.requirements.push({ ...value.requirements[0] });
    value.requirements.push({ ...value.requirements[0], id: "MM-01" });
    const result = checkMethodCoverage(phase.stage, value);
    expect(result.findings).toContain("Missing phase requirement: BD-03.");
    expect(result.findings).toContain("Duplicate requirement: BD-01.");
    expect(result.findings).toContain("Unknown requirement for this phase: MM-01.");
  });

  test("a stale reference, mismatched phase or malformed report cannot pass", () => {
    const phase = crispMlqPhases[0];
    for (const change of [
      { reference_revision: "old" }, { schema_version: 2 }, { stage: "aws-mlops-modeling" },
      { methodology: "crisp-dm" }, { profile: "platform" }, { requirements: null },
      { quality_assurance: null },
    ]) {
      expect(checkMethodCoverage(phase.stage, { ...report(phase), ...change }).pass).toBe(false);
    }
    expect(checkMethodCoverage("unknown", report(phase)).pass).toBe(false);
    for (const value of [null, [], "complete", {}]) {
      expect(checkMethodCoverage(phase.stage, value).pass).toBe(false);
    }
  });

  test("pending, failed and unjustified inapplicability remain findings", () => {
    const phase = crispMlqPhases[0];
    for (const status of ["pending", "failed", "not-applicable", "complete"]) {
      const value = report(phase);
      value.requirements[0].status = status;
      expect(checkMethodCoverage(phase.stage, value).pass).toBe(false);
    }
    const optional = report(crispMlqPhases[2]);
    optional.requirements[3].rationale = "";
    expect(checkMethodCoverage(crispMlqPhases[2].stage, optional).pass).toBe(false);
  });

  test("claimed completed tasks need evidence and cannot rest on a proposal", () => {
    const phase = crispMlqPhases[0];
    for (const evidence of [[], [{ reference: "fixture:plan", kind: "proposed" }], [{ reference: "", kind: "aws" }]]) {
      const value = report(phase);
      value.requirements[0].evidence = evidence;
      expect(checkMethodCoverage(phase.stage, value).pass).toBe(false);
    }
  });

  test("risk assessment requires requirements, tasks and a check or a recorded risk decision", () => {
    const phase = crispMlqPhases[0];
    for (const change of [
      { criteria_reference: "" }, { constraints: [] }, { tasks: [] },
      { risks: [] }, { risks: [{ status: "mitigated" }] },
    ]) {
      const value = report(phase);
      expect(checkMethodCoverage(phase.stage, {
        ...value, quality_assurance: { ...value.quality_assurance, ...change },
      }).pass).toBe(false);
    }
    const value = report(phase);
    value.quality_assurance.risks[0].status = "open";
    expect(checkMethodCoverage(phase.stage, value).pass).toBe(false);
    value.quality_assurance.risks[0].status = "accepted";
    expect(checkMethodCoverage(phase.stage, value).pass).toBe(false);
    const accepted = {
      ...value, quality_assurance: {
        ...value.quality_assurance,
        risks: [{ ...value.quality_assurance.risks[0], decision_reference: "fixture:human-risk-decision" }],
      },
    };
    expect(checkMethodCoverage(phase.stage, accepted).pass).toBe(true);
    expect(checkMethodCoverage(phase.stage, {
      ...value, quality_assurance: { ...value.quality_assurance, risks: [], no_risks_rationale: "Fixture contains no production inputs; reviewed scope." },
    }).pass).toBe(true);
  });

  test("platform commissioning is explicitly scoped and never a model acceptance claim", () => {
    for (const phase of crispMlqPhases.slice(-2)) {
      const value = {
        schema_version: 1, methodology: "crisp-mlq",
        reference_revision: crispMlqReference.revision, stage: phase.stage,
        profile: "platform", applicability: "platform-commissioning",
        rationale: "Only platform wiring is under test; model acceptance is not asserted.",
      };
      expect(checkMethodCoverage(phase.stage, value).pass).toBe(true);
      expect(checkMethodCoverage(phase.stage, { ...value, rationale: "" }).pass).toBe(false);
      expect(checkMethodCoverage(phase.stage, { ...value, reference_revision: "old" }).pass).toBe(false);
    }
  });

  test("owned side inputs are mandatory, while unrelated outputs remain outside this sensor", () => {
    const phase = crispMlqPhases[1];
    const path = join(scratch, phase.output);
    expect(inspectMethodOutput(path).pass).toBe(false);
    const sidecar = path.replace(/\.md$/, ".crisp-mlq.json");
    writeFileSync(sidecar, "{malformed");
    expect(inspectMethodOutput(path).pass).toBe(false);
    writeFileSync(sidecar, JSON.stringify(report(phase)));
    expect(inspectMethodOutput(path).pass).toBe(true);
    expect(inspectMethodOutput(join(scratch, "unrelated.md")).pass).toBe(true);
  });
});
