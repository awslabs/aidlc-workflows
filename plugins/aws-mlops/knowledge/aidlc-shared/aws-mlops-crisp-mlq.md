# CRISP-ML(Q): local operating reference

Reference revision: **1.0.0**. Methodology ID: `crisp-mlq`.
Source: Studer et al. (2021), DOI `10.3390/make3020020`,
[original publication](https://www.mdpi.com/2504-4990/3/2/20).
Source reviewed: 2026-10-15.
Reviewed edition: publisher PDF `make-03-00020-v2.pdf`,
SHA-256 `5683f005de743cde3a60653f32592c64c645084f75301211807b503f910931ad`.
Title: *Towards CRISP-ML(Q): A Machine Learning Process Model with Quality
Assurance Methodology*. The reviewed source is not bundled in the plugin.

## Source baseline and attribution

The publication describes an iterative process with six phases, combining
business and data understanding and continuing through preparation, modeling,
evaluation, deployment, and monitoring/maintenance. Its quality approach
connects requirements and constraints, instantiated tasks, task risks, and
technical measures that address those risks. Its scope is independent of
infrastructure. Sections 3 and 4 describe limitations for safety-critical use.

This document is an original, versioned AWS-plugin operating adaptation,
not the article's full text or an official conformance standard. The source is
published under CC BY 4.0; attribution above identifies the authors' contribution.
Our IDs, artifact formats, automation controls and AWS implementation decisions
are plugin conventions. Source-section links establish rationale, not a claim
that the authors prescribed SageMaker, these exact tests, or approval settings.

## Application and delivery

Use this reference when the person selected `aws-mlops-crisp-mlq`. Read it at
the beginning of each model stage, including a resumed stage, together with
the applicable persona, rules and prior artifacts. AI-DLC's shared-knowledge
roster supplies this file; the stage names it explicitly as well. If unavailable,
state the missing context and restore/read the shipped file before making
methodology claims. Do not reconstruct the method from its name or silently
use another methodology.

For `aws-mlops-platform`, use the reference to design reusable lifecycle support;
commissioning a fixture does not establish a business model's methodological
or predictive quality. Other scopes keep their own methodology. The person's
recorded choices and the engine's revision, skip and approval mechanisms remain
authoritative. An advisory finding reports missing work; an explicit request to
skip is recorded honestly without labeling the skipped work complete.

## Quality loop at every model phase

Apply the following plugin procedure to each task, not only final evaluation:

1. Identify the accepted requirements and constraints relevant to this phase.
   Cite their version and distinguish business, predictive and economic targets.
2. Describe the work performed, its inputs and the bounded execution conditions.
3. Identify task-specific failure modes. Record likelihood and impact with
   their rationale; numeric scores are optional and must not be invented.
4. Select a mitigation and an owner. Define what evidence would demonstrate
   the mitigation worked; cite the actual check and remaining risk afterward.
5. Compare evidence with the accepted criteria. State met, failed, pending or
   justified inapplicability. Return to the appropriate earlier task when a
   correction is needed. A criteria change is a separate human decision.

Keep open risks visible. A person can accept a remaining risk using the
existing decision flow; record that reference without inventing approval.
If no task-specific risk was identified, explain the assessment rather than
supplying a decorative empty list. Link the narrative's `Quality Assurance`
section to the adjacent coverage record described below.

## Business and data understanding — source section 3.1

**BD-01:** Establish who uses the prediction, the decision it supports, the
observation unit and prediction horizon. Write three connected acceptance
views: business effect, ML behavior and economic outcome. For a churn example,
these could concern retained customers, recall at an intervention capacity,
and intervention cost versus retained value. The person supplies the acceptable
tradeoff; these examples supply no thresholds.

**BD-02:** Inventory real data and label sources, owner, access, collection
period, refresh, units and versions. Profile bounded authorized data and
document missingness, coverage, plausibility and label delay. Specify input
requirements. Record unavailable measurements as pending; schema inspection
alone provides no statistical verification.

**BD-03:** Review whether the available evidence can support the target within
the known constraints. Separate demonstrated feasibility from a proposed PoC.
Review the quality contract and record open questions with owner, consequence
and closure evidence. Outputs are the business/data report and quality contract.
Return to collection or revise the objective when required evidence is absent.

## Data preparation — source section 3.2

**DP-01:** Record included populations, features and samples, exclusions and
class balance. Explain each selection using the agreed use case and retain
counts before/after. A feature available only after the decision is unsuitable
for that prediction time even when correlated with the target.

**DP-02:** Version cleaning, imputations, constructed features, augmentation
when used, units and schema transformations. Fit learned transformations on
training data only. Test validation, missing/invalid inputs and parity of
training/serving preprocessing. Compare consequential transformations against
the baseline rather than assuming their benefit.

**DP-03:** Freeze dataset and split manifests before model selection. Choose
time/entity separation appropriate to the prediction setting and test overlap
and leakage. Protect the final holdout from tuning and feature selection.
Write the preparation report with actual processing/check references. If a
leakage defect is discovered later, correct preparation and invalidate affected
downstream claims through ordinary revision.

## Modeling — source section 3.3

**MO-01:** Establish a simple reference and justify candidate families using
data, assumptions and accepted constraints. Compare under the same protocol;
document which changed component explains each experiment.

**MO-02:** Tune using validation data. Address performance, robustness,
explainability, scalability, complexity and resource demand in the model
selection record, with problem-specific measures and explicit applicability.
One favorable aggregate metric cannot stand in for all accepted criteria.

**MO-03:** Make the method reproducible with data/split versions, code revision,
image/dependency versions, parameters, seeds and execution references. Distinguish
that record from evidence that results reproduce. Assess variability when
relevant, or keep result reproducibility pending with the reason and next check.
Never report only a chosen best run as evidence of stable behavior.

**MO-04:** If using transfer/pretraining, compression or ensembles, describe
the assumptions, changed artifact and validation evidence. Otherwise record
this optional requirement as not applicable with a concrete rationale.
The modeling report must distinguish planned experiments from executed runs.

## Evaluation — source section 3.4

**EV-01:** Evaluate the actual candidate using the protected test manifest and
the previously accepted criteria. List every criterion and outcome; cite
executed measurements with sample counts. Tuning on this holdout invalidates
its role as untouched evidence.

**EV-02:** Compare the baseline, relevant slices, uncertainty and failure cases.
Address robustness and explanation tests appropriate to the use case. Keep
unmeasured criteria pending. For example, improved overall accuracy does not
demonstrate an accepted minority-class recall requirement.

**EV-03:** Relate results to business, ML and economic acceptance, showing which
effects remain projections rather than measured outcomes. Give a release,
revision or pending recommendation with limitations and updated risks.
Changing a failed threshold to manufacture a pass is not evaluation.
Registry registration, this recommendation and production approval are
separate records.

## Deployment — source section 3.5

**DE-01:** Check the actual target modality, capacity and serving interface.
Verify preprocessing parity, representative input/output behavior and the
applicable runtime constraints. A provisioned endpoint or successful batch-job
creation is not an inference test.

**DE-02:** Verify that intended users can use the prediction in their decision
process. Provide operating instructions and limitations. An API consumer may
need integration/contract acceptance rather than a graphical interface.
Record a scheduled user test as pending until evidence exists.

**DE-03:** Use the recorded promotion policy; release incrementally where the
modality supports it. Test the relevant recovery route: previous endpoint/model,
baseline/fallback or versioned batch rerun. Record exact versions, authority,
smoke results and operational ownership. Revisit data/model/evaluation work if
production conditions expose a material mismatch.

## Monitoring and maintenance — source section 3.6

**MM-01:** Validate incoming/outgoing schemas and monitor drift and service
health separately. Stable distributions and low latency cannot establish
predictive correctness.

**MM-02:** Measure business, ML and economic outcomes using explicit sources,
windows and owners. Predictive quality needs ground truth, join keys, label
delay and coverage. With absent labels, report predictive quality unmeasured
and identify collection/join work instead of declaring the model healthy.

**MM-03:** Treat every update as a candidate. Revalidate new data, evaluate
against the incumbent under the accepted protocol and apply the recorded
promotion policy. A schedule authorizing retraining does not authorize a
different promotion policy.

**MM-04:** Record trigger thresholds, update cost and false-alert handling.
Test deduplication, cooldown, concurrency/spend limits and recovery. Identify
feedback effects where predictions influence future collected data or actions.
The AWS pipeline performs recurring execution independently of the chat.

## Traceability and coverage format

`tools/aws-mlops-crisp-mlq.ts` is the single machine-readable owner of phase,
stage, primary output, source-section and requirement-ID mappings. Read its
phase entry when executing a phase; do not maintain a different ID list.
The local revision covers our operating reference, not a new edition of the paper.

For each of the six model phases, write the primary Markdown output normally,
including `## Quality Assurance`, and place an adjacent
`<primary-output-without-.md>.crisp-mlq.json` beside it. Preserve existing
selection/evaluation JSON side inputs. The additional record has this shape:

```json
{
  "schema_version": 1,
  "methodology": "crisp-mlq",
  "reference_revision": "1.0.0",
  "profile": "model",
  "stage": "aws-mlops-data-preparation",
  "requirements": [
    {
      "id": "DP-01",
      "status": "met",
      "evidence": [{"reference": "actual artifact or check", "kind": "local"}],
      "rationale": "What the evidence demonstrates and its limits"
    }
  ],
  "quality_assurance": {
    "criteria_reference": "accepted quality-contract revision",
    "constraints": ["actual applicable constraint"],
    "tasks": ["actual phase task"],
    "risks": [
      {
        "id": "actual risk ID",
        "description": "Failure mode",
        "likelihood": "assessment with rationale",
        "impact": "assessment with rationale",
        "mitigation": "action and check",
        "owner": "responsible role",
        "status": "mitigated",
        "verification_reference": "actual check",
        "residual_risk": "remaining risk after the check"
      }
    ]
  }
}
```

The example shows one entry; include every requirement for the phase.
Evidence kinds are `proposed`, `local`, `aws`, or `human`. Pending/failed entries
retain their rationale and available evidence; pending work may have an empty
evidence array. Only requirements explicitly marked optional by the mapping
allow `not-applicable`, with rationale. A mitigated risk needs a verification
reference; an accepted risk needs a `decision_reference`. An empty risk list
needs `no_risks_rationale`. Lists of constraints/tasks must describe the actual
work, including a justified absence of additional constraints if appropriate.

The `aws-mlops-crisp-mlq` sensor detects missing/unknown/duplicate coverage,
stale local revisions, pending/failed requirements and incomplete risk records.
It is advisory and validates records, not semantic correctness, authenticity,
measurement truth, AWS existence, or approval. The numeric evaluation sensor
continues owning numeric threshold checks. Neither sensor substitutes for review.
