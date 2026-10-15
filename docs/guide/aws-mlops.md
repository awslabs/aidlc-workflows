# Machine learning and MLOps on AWS

The optional [AWS MLOps plugin](../../plugins/aws-mlops/README.md) adds a
person-selected ML methodology to AI-DLC. It initially implements CRISP-ML(Q)
and shares one AWS SageMaker platform across future methodology profiles.

## Start with the platform

Install and compose the plugin in the project you want AI-DLC to deliver, using
your [harness's setup](harnesses/README.md) and the
[plugin installation procedure](../harness-engineering/10-authoring-a-plugin.md#5-distribution--install).
This repository's `dist/plugins/aws-mlops/<harness>/` projections are generated
development assets; they are not a published marketplace release.

Select the installed plugin with `aidlc engine plugin select aidlc,aws-mlops`,
preserving any other plugin names you want enabled.

Use `aws-mlops-platform` to design and build a new platform. Bring the accounts,
region, network/identity conventions, IaC preferences, data boundaries and
budget you already know. The workflow asks for missing judgment decisions and
honors those already answered.

The platform deliverables cover parameterized preparation/training/evaluation,
model registry and promotion, inference, monitoring, retraining, recovery,
environment/security/cost controls, and a bounded commissioning fixture.

## Choose the methodology

The person chooses the method at the start of the intent. AI-DLC explains the
available choices and records the answer; it can recommend, but an agent-only
default is not a human choice.

| Method | Initial availability |
| --- | --- |
| CRISP-ML(Q) | Implemented: `aws-mlops-crisp-mlq` |
| CRISP-DM | Planned |
| TDSP | Planned |
| SEMMA | Planned |
| KDD | Planned |

The catalog tool in the plugin owns executable availability. Planned profiles
do not run through a differently named method. The person can request their
implementation, choose an available method, or stop.

For Codex, these are conversation examples:

```text
$aidlc aws-mlops-platform
Construir una plataforma MLOps en AWS SageMaker con CRISP-ML(Q).
```

```text
$aidlc aws-mlops-crisp-mlq
Desarrollar un modelo para <objetivo> usando <plataforma existente>.
```

Use `/aidlc` in harnesses whose guide documents that entry. An explicit human
request for the CRISP-ML(Q) profile is already a methodology choice.

## Develop a model

After the platform is commissioned, supply its artifacts/configuration to a
model intent. CRISP-ML(Q) covers business/data understanding, data preparation,
modeling, evaluation, deployment and monitoring/maintenance, with quality and
risk assessment throughout. The delivered project's AWS services perform
recurring operations; the AI conversation designs, implements and changes them.

Expect immutable data/split versions; code and image revisions; experiment
parameters and run references; baseline comparisons; acceptance metrics agreed
before final evaluation; real inference checks; and an operational runbook.
No algorithm, target metric or deployment modality is imposed before the
business and data support that choice.

## Read the verification evidence

The plugin's ten ML-specific stages reuse core requirements, design, code,
testing, CI and environment delivery. Its two specialist personas supply data
science and ML engineering knowledge. Its evidence sensor reports missing
choice records, incomplete lineage, invalid numeric results and unmet declared
thresholds. It is advisory by default and does not verify that referenced cloud
jobs or human decisions actually occurred.

CRISP-ML(Q) has a
[local operating reference](../../plugins/aws-mlops/knowledge/aidlc-shared/aws-mlops-crisp-mlq.md),
revision `1.0.0`. It supplies phase goals, tasks, evidence and correction paths
along with quality/risk assessment in every phase. The publication's section
references are mapped to 20 plugin requirements in
`plugins/aws-mlops/tools/aws-mlops-crisp-mlq.ts`. This is a documented AWS adaptation,
not a conformance certification or a requirement that the model recall the paper.

The shared knowledge loader supplies the reference to the phase's workers.
Each of the six model phases records requirement coverage and task-specific
risks in an adjacent `.crisp-mlq.json` file. A second advisory sensor reports
missing coverage, stale reference revisions, pending/failed work and incomplete
risk evidence. Platform commissioning is explicitly scoped separately.

The plugin also includes six controlled scenarios for comparing model responses
with the same supplied reference. Live calls are opt-in, spend model tokens and
use existing CLI providers; the
[plugin test instructions](../../plugins/aws-mlops/README.md#controlled-checks-with-different-models)
explain the command and reports. Structural tests, model-response checks and
actual AWS workflow execution are separate evidence.

Distinguish proposed architecture, local tests, AWS executions and pending work.
Running the plugin's repository tests proves workflow composition and sensor
behavior; it does not prove a platform has been deployed.

## Operate and extend

Monitoring separates data/prediction drift, infrastructure health and predictive
quality. The last requires ground-truth labels with matching keys and timing.
Retraining creates a new candidate under the recorded budget/trigger policy;
production promotion follows the person's existing approval policy.

AWS documentation currently closes Model Monitor and Clarify to new customers.
The initial design therefore supports in-account Processing/open-source analysis
with CloudWatch, S3 and EventBridge instead of requiring those services. Verify
current regional/customer availability while implementing a project.

To add a method, author its actual stages/contracts, reuse shared AWS
capabilities, test its route, then enable its catalog entry. For SEMMA and KDD,
identify the extra business/deployment/operations steps used for production.
Changing methods in an active project uses ordinary AI-DLC revision and
scope-change mechanisms so affected approved artifacts are revisited.
