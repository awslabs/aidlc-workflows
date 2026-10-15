# AWS MLOps methodology and platform

Apply these workflow decisions under `aws-mlops-platform` and
`aws-mlops-crisp-mlq`. Other workflows retain their own stack and methodology.
Use the project's conversation/artifact language for narrative content. Section
names in these instructions describe content and may be translated; catalog IDs,
scope/stage names and JSON keys remain exact.

## Choice and availability

The person selects the methodology. The read-only catalog tool
`tools/aws-mlops-methodologies.ts` owns the executable/planned catalog.
CRISP-ML(Q) is implemented initially. CRISP-DM, TDSP, SEMMA and KDD are planned
profiles, not executable choices yet. Explicit human selection of
`aws-mlops-crisp-mlq` already supplies the methodology; a recommendation or
default supplied only by an agent does not.

Honor an existing answer. If a person chooses a planned method, explain its
current status once and let them choose implementing that profile or another
available one. Record their choice and use the engine's ordinary revision,
stop or scope-change mechanisms; never silently substitute CRISP-ML(Q).

## CRISP-ML(Q) mapping

Read `aidlc-shared/aws-mlops-crisp-mlq.md`, the versioned local operating
reference, before applying this method. Its task instructions and quality loop
are the context to use even when the model has never encountered CRISP-ML(Q).
The authoritative requirement/stage/evidence mapping is
`tools/aws-mlops-crisp-mlq.ts`; the table below is only a navigation overview.

| Method phase | Initial plugin implementation |
| --- | --- |
| Business and data understanding | `aws-mlops-business-data` and core requirements |
| Data preparation | Lifecycle design, code implementation, `aws-mlops-data-preparation` |
| Modeling | Lifecycle design, code implementation, `aws-mlops-modeling` |
| Evaluation | Acceptance design, tests, `aws-mlops-evaluation` |
| Deployment | CD, environment validation, `aws-mlops-deployment` |
| Monitoring and maintenance | `aws-mlops-monitoring` |

These are iterative work products, not a one-way waterfall. Quality and risk
assessment accompany every phase. Platform construction supplies reusable
infrastructure; it does not itself establish the predictive quality of a model.

## Shared AWS runtime

Use S3 for governed/versioned data and artifacts; ECR for container images;
SageMaker Processing, Training and Pipelines for reproducible ML; Model Registry
for candidates and release metadata; managed MLflow where appropriate;
CodeBuild/CodePipeline for code and infrastructure delivery; CloudWatch for
service health/custom metrics; EventBridge for scheduled/event-based work.
Glue, Athena, Feature Store and other AWS services are requirement-dependent,
not compulsory platform dependencies.

Discover accounts, region, existing networking, identity, data sources and IaC
preferences. Prefer CDK/CloudFormation within this full-AWS stack while honoring
the person's existing tools. Design least-privilege roles, KMS key grants,
encrypted/versioned storage, private access where required, environment
separation, auditability, retention and budget controls. Verify regional
capabilities and quotas before finalizing a service choice.

## Monitoring for a new platform

As checked on 2026-10-14, AWS documentation says SageMaker Model Monitor and
Clarify are closed to new customers; existing customers can continue.
Do not make either a mandatory dependency for a greenfield account.
Evaluate AWS-published open-source monitoring solutions running inside the
AWS account, or owned Processing jobs with S3, CloudWatch and EventBridge.
Open-source libraries running in AWS do not require an external SaaS runtime.

Keep drift, predictive quality with ground truth, subgroup behavior and
infrastructure health separate. Use SHAP and tested problem-specific group
metrics when justified. Bedrock evaluation is specific to suitable generative
AI workloads; it is not a replacement for evaluating every predictive model.

## Evidence and human decisions

State what is proposed, locally checked, executed in AWS, and pending. References
to runs, artifacts and measurements must be real. The plugin's advisory evidence
sensor validates reported structure and numeric consistency, not cloud existence
or the truth of an agent's account. The engine owns human approvals.
The separate methodology sensor checks per-phase coverage and risk records;
neither a source link nor passing either sensor establishes full conformance.

The person decides business success, architecture/budget tradeoffs, and
deployment/retraining authority. Record existing answers and policy once; use
them on later steps. Production promotion uses that policy. Training approval,
registry approval and the engine's stage approval are separate facts.

## Primary references

- CRISP-ML(Q): https://www.mdpi.com/2504-4990/3/2/20
- SageMaker Pipelines: https://docs.aws.amazon.com/sagemaker/latest/dg/pipelines.html
- Model Registry: https://docs.aws.amazon.com/sagemaker/latest/dg/model-registry.html
- Managed MLflow: https://docs.aws.amazon.com/sagemaker/latest/dg/mlflow.html
- Model Monitor availability: https://docs.aws.amazon.com/sagemaker/latest/dg/model-monitor-availability-change.html
- Clarify availability: https://docs.aws.amazon.com/sagemaker/latest/dg/clarify-availability-change.html
- Pipeline triggers: https://docs.aws.amazon.com/sagemaker/latest/dg/pipeline-eventbridge.html
- ML Lens: https://docs.aws.amazon.com/wellarchitected/latest/machine-learning-lens/welcome.html

Recheck service availability, API versions, quotas and pricing at implementation
time. CRISP-ML(Q) is a published process proposal, not a universal certification.
