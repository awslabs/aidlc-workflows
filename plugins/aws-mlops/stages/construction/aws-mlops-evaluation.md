---
slug: aws-mlops-evaluation
number: 3.82
name: ML Evaluation and Release Evidence
plugin: aws-mlops
phase: construction
execution: ALWAYS
condition: Evaluate the candidate against the approved quality contract
lead_agent: aws-mlops-data-scientist-agent
support_agents: [aidlc-quality-agent, aws-mlops-ml-engineer-agent]
mode: inline
produces: [aws-mlops-evaluation]
consumes:
  - artifact: aws-mlops-modeling
    required: true
  - artifact: aws-mlops-data-preparation
    required: true
  - artifact: aws-mlops-quality-contract
    required: true
requires_stage: [aws-mlops-modeling]
sensors: [required-sections, upstream-coverage, aws-mlops-evidence]
scopes: [aws-mlops-crisp-mlq]
ars:
  targets: [ve, r]
  cost: 4
inputs: Candidate, untouched test data, baseline and accepted model criteria
outputs: aws-mlops-evaluation.md
---

# Evaluation and release evidence

Follow the active stage protocol. Preserve the accepted evaluation contract.

## Steps

### Step 1: Evaluate the actual candidate

Run the accepted computations on the held-out test set. Report every acceptance
criterion, baseline comparison, sample counts, uncertainty, slices, robustness,
inference performance and justified bias/explanation checks. Keep unmeasured
items pending. Use problem-appropriate in-account evaluation; verify current
Clarify availability before considering it.

### Step 2: Record reproducible results

Write `aws-mlops-evaluation.md` with `## Acceptance Results`,
`## Baseline and Slices`, `## Risks`, `## Lineage`, `## Release Recommendation`
and `## Sources`. An unexecuted or incomplete evaluation is not a passing result.
Record a failed candidate faithfully and return through normal revision
mechanisms; changing acceptance criteria is a separate human decision.

Write adjacent `aws-mlops-evaluation.json` for the advisory sensor. Use real
values and references for all numeric criteria in the quality contract:

```json
{
  "dataset_version": "<immutable manifest or object version>",
  "split_version": "<split manifest>",
  "code_revision": "<revision>",
  "image_digest": "<digest>",
  "training_run": "<actual run reference>",
  "model_artifact": "<actual artifact version>",
  "criteria_reference": "<approved quality contract reference>",
  "evaluation_set": "held-out-test",
  "sample_count": 100,
  "status": "passed",
  "metrics": [
    {
      "name": "<metric>",
      "direction": "min",
      "threshold": 0.8,
      "observed": 0.85,
      "evidence_reference": "<measurement output>"
    }
  ]
}
```

Numbers above illustrate structure only. `min` means observed ≥ threshold;
`max` means observed ≤ threshold. Failure/pending evidence produces advisory
findings; no sample JSON values are acceptable as project measurements.

### Step 3: Prepare registry metadata

Describe the candidate, lineage, evaluation report, limitations and proposed
registry status. Registration and production approval occur under the deployment
policy; this evaluation does not fabricate either approval.

### Step 4: Hand completion to the engine

Use `{{INVOKE}} engine orchestrate report --stage aws-mlops-evaluation --result <outcome>`.

## Sensors

`aws-mlops-evidence` verifies reported numeric thresholds and lineage fields.
It cannot prove measurement truth, criterion completeness or cloud existence.
`required-sections` and `upstream-coverage` check document/input coverage.

## Learn

When supplied, follow the learnings protocol using `directive.memory_path`.
