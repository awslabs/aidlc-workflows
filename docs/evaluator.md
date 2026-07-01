# Evaluator

The evaluator runs the entire AI-DLC workflow end-to-end without human involvement. It replaces you (the human stakeholder) with an LLM-powered simulator agent, allowing you to validate that rule changes produce correct outputs — from requirements through to deployment.

You give it a project description (vision + technical environment), it runs all three phases (Inception → Construction → Operations), and produces a complete set of artifacts: documentation, application code, infrastructure-as-code, and an operations report.

A single run typically takes 1–4 hours and costs approximately $15–50 in Bedrock API calls depending on the scenario and models used.

---

## How It Works

Two LLM agents take turns in a loop:

1. **Executor** (Claude Sonnet) — drives the workflow. Loads rule files, generates documentation, writes application code, deploys to AWS, and hands off to the simulator when it needs human input.

2. **Simulator** (Claude Opus) — plays you. Has the project vision embedded in its prompt. When the executor asks questions or requests approval, the simulator reads the file, responds based on the vision, and hands back.

They pass control back and forth (called "handoffs") until the workflow completes. A typical run has 10–25 handoffs.

The executor writes code into a Docker sandbox for security — shell commands can't escape the run folder. After the workflow completes, the evaluator runs the generated project's test suite inside the sandbox and reports pass/fail counts.

---

## Prerequisites

### Software

| Requirement | Version | How to check | Why |
|-------------|---------|--------------|-----|
| Python | ≥ 3.13 | `python3 --version` | Runs the evaluator framework |
| uv | latest | `uv --version` | Manages Python dependencies and virtual environments |
| Docker | running | `docker info` | Sandbox for executing generated code safely |
| Git | any | `git --version` | Cloning the repo and managing test branches |
| AWS CLI | v2 | `aws --version` | Resolving credentials for Bedrock API calls |

Install these using your organisation's approved method. For macOS:

```bash
# Python and uv (via Homebrew)
brew install python@3.13 uv

# Git (via Homebrew)
brew install git

# AWS CLI (standalone installer — see https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
curl "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o "AWSCLIV2.pkg"
sudo installer -pkg AWSCLIV2.pkg -target /

# Docker Desktop (download from https://www.docker.com/products/docker-desktop/)
```

**Note**: Docker Desktop must be running (not just installed) before you start a run.

### AWS Access

You need an **AWS CLI profile** configured for the target account. This profile is used for two things:

1. **Calling Bedrock** (always required) — the executor and simulator agents call Claude via Bedrock.
2. **Deploying to AWS** (optional) — if you want the evaluator to run `cdk deploy` and validate the live environment.

#### Setting up the profile

Configure a named profile in `~/.aws/config` that resolves to the target account. This can be SSO, IAM user credentials, or an assumed role — whatever works for your organisation:

```bash
# Verify the profile resolves to the target account
aws sts get-caller-identity --profile <your-profile>
```

#### Bedrock model access

The models you use must be available in your account. Enable access via the Bedrock console (Model access → Enable specific models). By default the evaluator uses:

- **Executor**: `global.anthropic.claude-sonnet-4-6`
- **Simulator/Scorer**: `global.anthropic.claude-opus-4-6-v1`

These are configurable (see [Command-Line Parameters](#command-line-parameters)).

**Guidance on model choice:**

- **Executor** — use an instruction-following model (e.g. Claude Sonnet). Reasoning-heavy models (e.g. Claude Opus) are more likely to exercise judgement and skip steps they deem unnecessary, resulting in lower rule compliance.
- **Simulator** — can use a cheaper model since its job is simpler (answer questions, approve documents). Using Opus gives higher-quality stakeholder simulation but Sonnet works fine.
- **Context window** — the full rule set is large. Models with smaller context windows may degrade in quality during later stages when accumulated context competes with rule instructions.

Verify your chosen models are accessible:

```bash
aws bedrock list-foundation-models --profile <your-profile> --region us-east-1 \
  --query 'modelSummaries[?contains(modelId, `claude`)].[modelId]' --output text
```

#### Permissions for deployment (optional)

If you want the evaluator to deploy the generated application, the profile needs permissions for the AWS services the generated IaC uses — typically CloudFormation, S3, Lambda, DynamoDB, IAM, CloudWatch, and CDK bootstrap. An admin-level role in a test account is simplest.

---

## Setting Up Your Test Environment

Follow the setup instructions in `scripts/aidlc-evaluator/README.md` — clone the repo, install dependencies (`uv sync`), build the Docker sandbox, and verify Bedrock access.

The Operations phase adds one additional prerequisite for deployment testing:

### AWS permissions for deployment (optional)

If you want the evaluator to deploy the generated application (not just validate rules), the AWS profile needs permissions for the services the generated IaC uses — typically CloudFormation, S3, Lambda, DynamoDB, IAM, CloudWatch, and CDK bootstrap. An admin-level role in a test account is simplest.

---

## Running

The evaluator is run the same way as upstream — see `scripts/aidlc-evaluator/README.md` for the full command reference.

### Enabling deployment in the sandbox

By default, the executor cannot deploy to AWS because the Docker sandbox has no credentials. To enable Deployment and Post-Deployment Testing stages, set `INJECT_AWS_CREDENTIALS=true` before starting the run:

```bash
INJECT_AWS_CREDENTIALS=true AWS_PROFILE=<your-profile> uv run python run.py full \
    --vision <test-case>/vision.md \
    --tech-env <test-case>/tech-env.md
```

When this variable is set, `run_command.py` resolves credentials from your environment and propagates them into the sandbox as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, and `AWS_DEFAULT_REGION`.

Without it, the workflow completes after Rules Validation — Deployment and Post-Deployment Testing are skipped.

**Important**: Ensure your credentials won't expire mid-run (runs take 2–5 hours). If you use SSO or temporary credentials, refresh them before starting.

### Keeping the machine awake

Runs take hours. Prevent macOS sleep:

```bash
caffeinate -ims uv run python run.py full ...
```

### Parallel runs with worktrees

Use a git worktree to run the evaluator while continuing to edit:

```bash
git worktree add ~/repos/aidlc-evaluator test/<your-branch>
cd ~/repos/aidlc-evaluator/scripts/aidlc-evaluator
AWS_PROFILE=<profile> uv run python run.py full ...
```

Remove when done: `git worktree remove ~/repos/aidlc-evaluator`

---

## Output

Each run produces a timestamped folder in `eval-runs/runs/`:

```
eval-runs/runs/20260603T162246/
├── vision.md                    # Copy of the input vision
├── tech-env.md                  # Copy of the input tech-env
├── aidlc-rules/                 # Snapshot of rules used
├── aidlc-docs/                  # All workflow artifacts
│   ├── inception/               #   Requirements, designs, plans
│   ├── construction/            #   NFR docs, infrastructure design
│   ├── operations/              #   Validation reports, deployment logs
│   ├── aidlc-state.md           #   Stage progress tracker
│   ├── audit.md                 #   Decision log
│   └── step-decision-log.md     #   Per-stage step execution record
├── workspace/                   # Generated application code
├── run-meta.yaml                # Run metadata (models, timing, status, handoff count)
├── run-metrics.yaml             # Detailed metrics (tokens, tool calls, LOC)
├── test-results.yaml            # Post-run test results (pass/fail counts)
├── report.html                  # Human-readable evaluation report
└── evaluator.log                # Full stdout/stderr
```

### What to check first after a run

1. **`run-meta.yaml`** — did it complete? (`status: Status.COMPLETED`). How many handoffs? How long?
2. **`test-results.yaml`** — did the generated tests pass? Look at `parsed_results.passed` / `parsed_results.failed`.
3. **`aidlc-docs/aidlc-state.md`** — which stages completed? Did it reach Operations?
4. **`aidlc-docs/step-decision-log.md`** — were steps actually executed or skipped?
5. **`eval-runs/.evaluator-output.log`** — real-time log of the run (timestamps are UTC)

---

## What Can Go Wrong

### The run fails with `RecursionError`

Long executor turns (especially Deployment) accumulate Python call depth. The recursion limit is set to 3000 but complex deployments can still exceed it. There's no workaround — this is a framework limitation.

### The run fails with `ConnectionResetError` or `ReadTimeoutError`

- **Device went to sleep** — use `caffeinate -ims` (macOS) or equivalent to prevent sleep during runs
- **Network disconnection** — the evaluator makes continuous API calls to Bedrock for hours. Any network interruption (VPN disconnect, Wi-Fi drop, corporate network timeout) will kill the run. Use a stable wired connection where possible.
- **Bedrock transient error** — the evaluator retries up to 10 times with adaptive backoff, but sustained Bedrock outages or throttling will still cause failures

### Docker sandbox build fails

The script builds the sandbox image automatically on first run. If the build fails, try manually:

```bash
./scripts/aidlc-evaluator/docker/sandbox/build.sh
```

### The executor stops after Rules Validation

A known compliance issue — the model sometimes declares the workflow complete without entering Deployment. The system prompt enforcement mitigates this but doesn't eliminate it. Check `aidlc-state.md` to confirm.

### Stacks left behind after a failed run

If a run deployed stacks and then crashed, those stacks remain in your AWS account. Delete them before the next run:

```bash
aws cloudformation list-stacks --profile <profile> --region eu-west-1 --query 'StackSummaries[?StackStatus!=`DELETE_COMPLETE`].[StackName,StackStatus]' --output table
```

---

## Evaluator vs Real IDE Usage

The evaluator has a structural limitation: conversation history resets on every handoff between agents. The executor loses all loaded rules and context each time it hands off to the simulator and back. In a real IDE session (e.g. Kiro), the conversation is continuous — no context loss occurs.

This means some failures you observe in evaluator runs (rules not reloaded, procedures not followed after many handoffs) are evaluator-specific and may not occur in real usage.
