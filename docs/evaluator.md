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

The `aidlc-ops-bundle` branch is the pinned release containing the full rule set, evaluator code, and test scenarios. You must create your own test branch from it — do not run directly from the bundle.

### 1. Clone the repo

```bash
git clone <repo-url> ~/repos/ai-dlc-ops
cd ~/repos/ai-dlc-ops
```

Replace `<repo-url>` with the AI-DLC Ops repository URL for your organisation.

### 2. Create your test branch

```bash
git checkout aidlc-ops-bundle
git checkout -b test/<your-name>-<what-youre-testing>
```

This pins you to a known-good state and keeps your work isolated from other testers.

### 3. Merge your rule changes on top (if testing a feature)

If you're validating changes from a feature branch:

```bash
git merge feature/my-rule-change
```

If you're just running the evaluator against the existing rules, skip this step.

### 4. Add your scenario (or use the built-in ones)

The bundle includes two scenarios (`minimal` and `advanced`). If these test what you need, skip to step 5.

To create your own:

```bash
mkdir -p test-scenarios/my-scenario/evaluator
```

A scenario needs these files:

| File | Purpose |
|------|---------|
| `vision.md` | What to build — business context, features, data model, NFRs |
| `tech-env.md` | How to build it — platform, languages, extension preferences, recovery objectives |
| `scenario.yaml` | Metadata (name, description, file references) |
| `openapi.yaml` | (Optional) API spec for contract-testing the generated code |

Example `scenario.yaml`:

```yaml
name: my-scenario
description: "Brief description"
status: draft
vision: vision.md
tech_env: tech-env.md
openapi: openapi.yaml
golden_baseline: golden.yaml
golden_aidlc_docs: golden-aidlc-docs/
tags: [aws, operations]
```

Commit:

```bash
git add test-scenarios/my-scenario/
git commit -m "Add scenario for testing X"
```

### 5. Verify your setup

Before committing to a multi-hour run, check everything is wired up:

```bash
cd ~/repos/ai-dlc-ops
docker info > /dev/null 2>&1 && echo "✓ Docker running" || echo "✗ Start Docker Desktop"
python3 -c "import sys; assert sys.version_info >= (3,13)" && echo "✓ Python ≥ 3.13"
uv --version > /dev/null 2>&1 && echo "✓ uv installed"
aws sts get-caller-identity --profile <your-profile> > /dev/null 2>&1 && echo "✓ AWS credentials valid"
```

The Docker sandbox image and Python dependencies are installed automatically on first run.

### Cleaning up

Delete your test branch when you're done. If the scenario proves generally useful, propose moving it to the shared `test-cases` branch.

---

## Running

### Without deployment (rules validation only)

```bash
cd ~/repos/ai-dlc-ops
AWS_PROFILE=<your-profile> ./scripts/run-evaluator.sh advanced
```

This runs the full workflow through Rules Validation. Deployment and Post-Deployment Testing will be skipped (no credentials injected into the sandbox).

### What you'll see

The evaluator streams progress to the terminal — you'll see which agent is active, tool calls being made, and handoff events. Output is also written to `eval-runs/.evaluator-output.log`. The run is unattended — once started, it runs to completion or failure without needing input.

### With deployment to AWS

```bash
cd ~/repos/ai-dlc-ops
INJECT_AWS_CREDENTIALS=true AIDLC_AWS_PROFILE=<your-profile> AWS_PROFILE=<your-profile> ./scripts/run-evaluator.sh advanced
```

This injects your AWS credentials into the sandbox so the executor can run `cdk deploy`, `aws` CLI commands, etc.

### Choosing a scenario

```bash
./scripts/run-evaluator.sh minimal    # simpler scenario, faster runs (~1h)
./scripts/run-evaluator.sh advanced   # multi-region, all operational domains (~3h)
./scripts/run-evaluator.sh my-scenario  # your own custom scenario
```

**minimal** — Single-region electricity account management. Good for testing rule changes quickly.

**advanced** — Multi-region resilient system (Spark Grid). Tests all 4 operational domains, rework loops, deployment, and post-deployment testing.

### Keeping the machine awake

Runs take hours. Prevent macOS sleep:

```bash
caffeinate -ims ./scripts/run-evaluator.sh advanced
```

### How can I keep making changes while a run is in progress?

Use a git worktree — a second checkout of the same repo in a separate directory:

```bash
git worktree add ~/repos/ai-dlc-ops-my-test test/<your-name>-<what-youre-testing>
cd ~/repos/ai-dlc-ops-my-test
AWS_PROFILE=<profile> ./scripts/run-evaluator.sh my-scenario
```

Now the evaluator runs from `~/repos/ai-dlc-ops-my-test` while you continue editing in `~/repos/ai-dlc-ops` on your feature branch. Remove the worktree when done:

```bash
git worktree remove ~/repos/ai-dlc-ops-my-test
```

---

## Command-Line Parameters

The `run-evaluator.sh` script passes any extra arguments through to the underlying runner. You can override models, disable features, and control where output goes.

```bash
./scripts/run-evaluator.sh <scenario> [options...]
```

### Model selection

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `--executor-model <id>` | Change the model that drives the workflow | `--executor-model us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| `--simulator-model <id>` | Change the model that plays the human | `--simulator-model us.anthropic.claude-sonnet-4-6` |

Model IDs use Bedrock format. The `global.` prefix enables cross-region inference (routes to whichever region has capacity). Region-prefixed IDs (e.g. `us.`) pin to a specific region.

### Execution control

| Parameter | Purpose | When to use |
|-----------|---------|-------------|
| `--no-exec` | Disables the `run_command` tool | When you only want to test rule compliance without running builds or deploys |
| `--no-post-tests` | Skips the post-run test evaluation | When you don't care about test pass rates, just artifact quality |

### AWS overrides

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `--aws-profile <name>` | Override the AWS profile for Bedrock calls | `--aws-profile my-test-profile` |
| `--aws-region <region>` | Override the AWS region for Bedrock calls | `--aws-region us-west-2` |

### Rules source

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `--rules-path <path>` | Use rules from a local directory instead of the bundled copy | `--rules-path /tmp/my-experimental-rules` |
| `--rules-ref <ref>` | Git ref when cloning rules from a repo | `--rules-ref feature/my-branch` |

### Output

| Parameter | Purpose | Example |
|-----------|---------|---------|
| `--output-dir <path>` | Override where run folders are created | `--output-dir /tmp/eval-output` |

### Examples

```bash
# Run with a cheaper/faster executor model
./scripts/run-evaluator.sh advanced --executor-model us.anthropic.claude-sonnet-4-5-20250929-v1:0

# Run without command execution or post-run tests (fastest — just tests rule artifacts)
./scripts/run-evaluator.sh advanced --no-exec --no-post-tests

# Run with both agents using the same model (cost comparison)
./scripts/run-evaluator.sh minimal \
  --executor-model global.anthropic.claude-sonnet-4-6 \
  --simulator-model global.anthropic.claude-sonnet-4-6
```

---

## Output

Each run produces a timestamped folder in `eval-runs/runs/`:

```
eval-runs/runs/20260603T162246-local_ai-dlc-ops-evaluator/
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
