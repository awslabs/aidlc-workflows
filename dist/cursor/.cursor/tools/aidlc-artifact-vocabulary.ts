/**
 * Dependency-free artifact vocabulary shared by library and runtime resolvers.
 * Keep wire-name classification and filename exceptions here so artifact guards,
 * directives, sensors, and validity receipts always agree on the physical file.
 */

export type ArtifactKind = "document" | "visual" | "machine";
export type ArtifactFormat = "md" | "html";

/** Every artifact produced by the core stage set. Unknown/plugin names fail safe. */
export const ARTIFACT_KIND: Readonly<Record<string, ArtifactKind>> = {
  "accessibility-checklist": "document",
  alarms: "machine",
  "anomaly-config": "machine",
  "api-documentation": "machine",
  "approval-handoff-questions": "machine",
  architecture: "machine",
  "bolt-plan": "document",
  "build-and-test-summary": "document",
  "build-instructions": "document",
  "build-test-results": "machine",
  "build-vs-buy": "document",
  "business-overview": "machine",
  "cd-config": "machine",
  "ci-config": "machine",
  "ci-pipeline-questions": "machine",
  "cicd-pipeline": "document",
  "code-generation-plan": "document",
  "code-quality-assessment": "machine",
  "code-structure": "machine",
  "code-summary": "document",
  "competitive-analysis": "document",
  "component-inventory": "machine",
  components: "visual",
  "constraint-register": "document",
  "contract-summary": "document",
  "cost-analysis": "document",
  "cross-unit-traceability": "machine",
  dashboards: "machine",
  "decision-log": "document",
  decisions: "document",
  "delivery-planning-questions": "machine",
  dependencies: "machine",
  "deployment-execution-questions": "machine",
  "deployment-log": "machine",
  "deployment-pipeline-questions": "machine",
  "deployment-strategy": "document",
  "design-system-mapping": "visual",
  "discovered-rules": "machine",
  "drift-report": "document",
  entities: "machine",
  "environment-inventory": "machine",
  "environment-provisioning-questions": "machine",
  "escalation-matrix": "document",
  evidence: "machine",
  "external-dependency-map": "document",
  "feasibility-assessment": "document",
  "feasibility-questions": "machine",
  "feedback-loop": "document",
  "feedback-optimization-questions": "machine",
  "frontend-components": "document",
  "functional-spec": "document",
  "health-check-report": "document",
  "incident-plan": "document",
  "incident-response-questions": "machine",
  "infrastructure-specification": "document",
  "initiative-brief": "document",
  "integration-test-instructions": "document",
  "intent-backlog": "document",
  "intent-capture-questions": "machine",
  "intent-statement": "document",
  "interaction-spec": "visual",
  "load-test-plan": "document",
  "load-test-results": "machine",
  "log-queries": "machine",
  "logical-components": "document",
  "market-research-questions": "machine",
  "market-trends": "document",
  "mob-composition": "document",
  mockups: "visual",
  "monitoring-design": "document",
  "nfr-validation-matrix": "document",
  "observability-design": "document",
  "observability-requirements": "document",
  "observability-setup-questions": "machine",
  "performance-design": "document",
  "performance-requirements": "document",
  "performance-test-instructions": "document",
  "performance-validation-questions": "machine",
  personas: "document",
  "practices-discovery-timestamp": "machine",
  "quality-gates": "machine",
  "raid-log": "document",
  "refined-mockups-questions": "machine",
  "reliability-design": "document",
  "reliability-requirements": "document",
  requirements: "document",
  "requirements-analysis-questions": "machine",
  "reverse-engineering-timestamp": "machine",
  "risk-and-sequencing-rationale": "document",
  "rollback-runbook": "document",
  "rough-mockups-questions": "machine",
  rules: "machine",
  runbooks: "document",
  "scalability-design": "document",
  "scalability-requirements": "document",
  "scope-definition-questions": "machine",
  "scope-document": "document",
  "security-design": "document",
  "security-requirements": "document",
  "security-test-instructions": "document",
  "skill-matrix": "document",
  "slo-config": "machine",
  "slo-report": "document",
  "smoke-test-results": "machine",
  "stakeholder-map": "document",
  stories: "document",
  "team-allocation": "document",
  "team-assessment": "document",
  "team-formation-questions": "machine",
  "team-practices": "machine",
  "tech-stack-decisions": "document",
  "technology-stack": "machine",
  traceability: "machine",
  "tracing-config": "machine",
  "unit-of-work": "machine",
  "unit-of-work-dependency": "machine",
  "unit-of-work-story-map": "visual",
  "unit-test-instructions": "document",
  "user-flow": "visual",
  "user-stories-assessment": "document",
  "validation-report": "document",
  wireframes: "visual",
};

export const HTML_ELIGIBLE_PHASES: ReadonlySet<string> = new Set([
  "ideation",
  "inception",
]);

export function artifactKind(name: string): ArtifactKind | null {
  return ARTIFACT_KIND[name] ?? null;
}

let htmlNames: ReadonlySet<string> = new Set();

export function setHtmlArtifactNames(names: ReadonlySet<string>): void {
  htmlNames = new Set(names);
}

export function htmlArtifactNames(): ReadonlySet<string> {
  return htmlNames;
}

export function artifactFormat(name: string): ArtifactFormat {
  return htmlNames.has(name) ? "html" : "md";
}

const ARTIFACT_FILENAMES: Readonly<Record<string, string>> = {
  "build-test-results": "test-results.md",
  "load-test-results": "test-results.md",
  traceability: "traceability.json",
};

export function artifactFilename(name: string): string {
  return ARTIFACT_FILENAMES[name] ?? `${name}.${artifactFormat(name)}`;
}

/** True when an artifact has a fixed non-canonical filename. */
export function hasArtifactFilenameException(name: string): boolean {
  return Object.hasOwn(ARTIFACT_FILENAMES, name);
}

/** Stages whose produced artifacts live in the space-level code knowledge base. */
export const KNOWN_CODEKB_STAGES: ReadonlySet<string> = new Set([
  "reverse-engineering",
]);
