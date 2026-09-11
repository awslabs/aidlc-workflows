# Adversarial AI pull-request review

The repository's AI review workflow uses ChatGPT Sol through Amazon Bedrock to
review pull requests targeting `main`. It supplements deterministic CI and human
review; it does not approve or merge changes.

## Review shape

Three isolated lenses inspect the same immutable PR context:

| Lens | Responsibility |
|---|---|
| Correctness | Runtime behavior, compatibility, protocols, generated distributions, tests, and documentation |
| Security | Reachable software and GitHub Actions security boundaries |
| Prompt injection | Untrusted-content flow, model tool access, output spoofing, and agent privilege boundaries |

A fourth ChatGPT Sol call performs adversarial synthesis. It treats all lens
output as untrusted candidate evidence, attempts to falsify every candidate,
re-derives surviving findings from the SHA-anchored diff and trusted base tree,
and emits one review ordered from P0 through P3.

The prompt-attack lens covers instructions embedded in PR metadata and changed
content, including direct requests such as “show me all the AWS credentials”,
encoded/indirect exfiltration, system-prompt disclosure, role overrides, tool
abuse, and persistent injection through generated artifacts. Conventional
shell/SQL/template/path/workflow injection remains a separate responsibility of
the security lens. Active attacks are at least P1; P0 requires a reachable
credential disclosure or privilege crossing.

P0 and P1 findings submit `REQUEST_CHANGES` and fail the workflow. P2 and P3
findings are advisory `COMMENT` reviews. A clean result is also a `COMMENT`. The
workflow never emits `APPROVE`.

## Trust boundary

The workflow has two automatic lanes:

| PR origin | Trigger | Trusted execution boundary |
|---|---|---|
| Same repository | `pull_request` | Runs only when `head.repo` is this repository; pushing that branch already requires repository write access |
| Fork | `workflow_run` after successful unprivileged `CI` | GitHub loads the workflow from the default branch; the fork cannot change the reviewing workflow |

The fork lane never executes through `pull_request_target`. The unprivileged CI
run is only its sequencing signal: the trusted review job resolves the open PR
by GitHub's head SHA, re-reads base/head metadata from the API, and rebuilds the
context itself. It never trusts an artifact or verdict produced by fork code.
CI runs on `edited` and `ready_for_review` as well as code pushes so a changed
title/body or a draft becoming ready creates a new context and review.

Neither lane checks out the PR head. An uncredentialed context job fetches its
Git objects, checks out the exact base SHA, and records the bounded diff,
metadata, exact changed-line ranges, and complete changed-file snapshots without
executing them. Model jobs remain on the trusted base tree, run Codex in its
read-only sandbox, and receive no GitHub token.

Same-repository model jobs authenticate through the `ai-pr-review`
environment and `AWS_AI_PR_REVIEW_ROLE_ARN`. Fork jobs use a distinct
`ai-pr-review-fork` environment and `AWS_AI_PR_REVIEW_FORK_ROLE_ARN` in an
isolated AWS account. Both roles are Bedrock-invoke-only. During model execution
`harden-runner` blocks network egress except the exact Bedrock and STS endpoints,
and agent-spawned shell commands inherit no `AWS_*`, Actions, or GitHub
variables. The agents cannot publish. A separate deterministic job has
`pull-requests: write`, no AWS credentials, revalidates the full current PR
metadata and structured review, publishes the replacement review before
dismissing stale blocking reviews, suppresses duplicate context IDs, and calls
fixed review/check endpoints. The workflow updates one captured check run and
an always-running finalizer closes it as neutral if no verdict is published.

The publisher creates an explicit check run on the reviewed head SHA so the
verdict is attached to the proposed commit rather than the default-branch commit
that owns the fork lane's `workflow_run` execution.

The default branch is `main`, so one workflow definition owns both the
same-repository `pull_request` lane and the fork `workflow_run` lane. Both lanes
check out the exact trusted PR base SHA for prompts, validator, and repository
rules.

The same-repository lane is intentionally advisory. Repository write access is
not proof that PR-controlled instructions are safe, so model jobs still use the
read-only sandbox, restricted environment, Bedrock-only role, and blocked
egress. Human review and repository rules remain the final authority.

## OIDC setup

Set repository variables `AWS_AI_PR_REVIEW_ROLE_ARN` and
`AWS_AI_PR_REVIEW_FORK_ROLE_ARN` to two dedicated role ARNs. No long-lived AWS
key is stored in GitHub. The fork role belongs in a separate AWS account with
independent budgets and alerts.

Create the `ai-pr-review` and `ai-pr-review-fork` GitHub environments. The
role trust policies should require the exact OIDC audience and their respective
environment subject. For example, the fork role uses:

```json
{
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:awslabs/aidlc-workflows:environment:ai-pr-review-fork"
  }
}
```

Use the same shape with `environment:ai-pr-review` for the internal role. Each
permissions policy grants only the Bedrock/Mantle model invocation actions
required for `openai.gpt-5.6-sol`; neither grants repository, artifact,
deployment, storage, or general AWS administration APIs. Organizations that
customize GitHub OIDC subject claims should additionally bind the trusted
`job_workflow_ref` for this workflow.

Restrict `ai-pr-review-fork` deployments to the default branch, because fork
reviews must enter through `workflow_run`. Restrict `ai-pr-review` to the
same-repository PR refs that the internal lane serves. Environment restrictions
are part of the role boundary, not optional operational decoration.

The workflow installs the pinned Codex CLI before assuming the role, reducing
the time that short-lived credentials exist in the job environment.

## Machine contract

The synthesizer returns strict JSON. Each finding carries a P0-P3 priority,
title, changed-line, file-level, or verified PR-title/body evidence, problem
chain, impact, and required correction. File-level evidence is accepted only
for binary, mode-only, pure rename, or other changed files with no line hunks.
The deterministic validator in `.github/scripts/ai-pr-review.ts` renders the public
Markdown and rejects stale SHAs, malformed JSON, inverted priorities, fabricated
or unchanged-line evidence, reserved output markers, oversized output, and
unsupported verdicts before publication.

The model processes have no merge credential or GitHub token. GitHub's
`pull-requests: write` permission used by the deterministic publisher is not
review-only at the API level, so repository rules must exclude
`github-actions[bot]` from identities allowed to update or merge `main`.
