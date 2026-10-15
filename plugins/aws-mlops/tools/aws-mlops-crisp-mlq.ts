// The plugin owns these operational requirements, not the paper or the engine.
// Source sections identify the rationale; AWS artifacts and IDs are our adaptation.
export const crispMlqReference = {
  methodology: "crisp-mlq",
  revision: "1.0.0",
  source: "doi:10.3390/make3020020",
  source_year: 2021,
  source_pdf_sha256: "5683f005de743cde3a60653f32592c64c645084f75301211807b503f910931ad",
  knowledge_file: "knowledge/aidlc-shared/aws-mlops-crisp-mlq.md",
} as const;

export interface MethodRequirement {
  id: string;
  source_sections: string[];
  evidence: string;
  allows_not_applicable?: boolean;
}

export interface MethodPhase {
  id: string;
  source_section: string;
  stage: string;
  output: string;
  requirements: MethodRequirement[];
}

export const crispMlqPhases: readonly MethodPhase[] = [
  {
    id: "business-data", source_section: "3.1",
    stage: "aws-mlops-business-data", output: "aws-mlops-business-data.md",
    requirements: [
      { id: "BD-01", source_sections: ["3.1.1", "3.1.2"], evidence: "Aligned business, ML and economic criteria; decision, observation unit, horizon and owners." },
      { id: "BD-02", source_sections: ["3.1.4", "3.1.5"], evidence: "Versioned data inventory, measured quality, labels/timing and data requirements." },
      { id: "BD-03", source_sections: ["3.1.3", "3.1.6"], evidence: "Feasibility review against constraints; actual decisions and unresolved questions." },
    ],
  },
  {
    id: "data-preparation", source_section: "3.2",
    stage: "aws-mlops-data-preparation", output: "aws-mlops-data-preparation.md",
    requirements: [
      { id: "DP-01", source_sections: ["3.2.1"], evidence: "Feature/sample selection, exclusions and class balance rationale." },
      { id: "DP-02", source_sections: ["3.2.2", "3.2.3", "3.2.4"], evidence: "Tested cleaning, transformations, units/schema and train-only fitted preprocessing." },
      { id: "DP-03", source_sections: ["3.2", "3.3", "3.4"], evidence: "Immutable train/validation/test manifests; time/entity and leakage checks." },
    ],
  },
  {
    id: "modeling", source_section: "3.3",
    stage: "aws-mlops-modeling", output: "aws-mlops-modeling.md",
    requirements: [
      { id: "MO-01", source_sections: ["3.3"], evidence: "Baseline and justified candidates; assumptions compared under one protocol." },
      { id: "MO-02", source_sections: ["3.3"], evidence: "Validation-only tuning and justified quality dimensions, including resource demand." },
      { id: "MO-03", source_sections: ["3.3"], evidence: "Reproducible method, real run lineage, parameters/environment and result variability." },
      { id: "MO-04", source_sections: ["3.3"], evidence: "Applicability and evidence for pretraining, compression or ensembles when chosen.", allows_not_applicable: true },
    ],
  },
  {
    id: "evaluation", source_section: "3.4",
    stage: "aws-mlops-evaluation", output: "aws-mlops-evaluation.md",
    requirements: [
      { id: "EV-01", source_sections: ["3.4"], evidence: "Protected held-out results against every previously accepted criterion." },
      { id: "EV-02", source_sections: ["3.4"], evidence: "Baseline, population slices, uncertainty, robustness and explanation applicability." },
      { id: "EV-03", source_sections: ["3.1.2", "3.4"], evidence: "Business/ML/economic comparison, limitations and release or revision recommendation." },
    ],
  },
  {
    id: "deployment", source_section: "3.5",
    stage: "aws-mlops-deployment", output: "aws-mlops-deployment.md",
    requirements: [
      { id: "DE-01", source_sections: ["3.5"], evidence: "Target hardware/modality, serving parity and actual inference under representative conditions." },
      { id: "DE-02", source_sections: ["3.5"], evidence: "User acceptance/usability evidence and instructions describing limitations." },
      { id: "DE-03", source_sections: ["3.5"], evidence: "Incremental release, fallback/recovery tests and recorded promotion authority." },
    ],
  },
  {
    id: "monitoring-maintenance", source_section: "3.6",
    stage: "aws-mlops-monitoring", output: "aws-mlops-monitoring.md",
    requirements: [
      { id: "MM-01", source_sections: ["3.1.5", "3.6"], evidence: "Input/output validation, drift and service health separated from labeled predictive quality." },
      { id: "MM-02", source_sections: ["3.1.2", "3.6"], evidence: "Business/ML/economic monitoring with label joins, delays, coverage and measurement windows." },
      { id: "MM-03", source_sections: ["3.4", "3.6"], evidence: "Every updated candidate evaluated and compared with the incumbent before policy-governed release." },
      { id: "MM-04", source_sections: ["3.6"], evidence: "Trigger/update costs, feedback-loop risks, bounded automation and tested fallback." },
    ],
  },
];

export function phaseForStage(stage: string): MethodPhase | undefined {
  return crispMlqPhases.find((phase) => phase.stage === stage);
}

if (import.meta.main) {
  console.log(JSON.stringify({ reference: crispMlqReference, phases: crispMlqPhases }, null, 2));
}
