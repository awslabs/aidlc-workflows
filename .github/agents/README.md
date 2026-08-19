# Adversarial AI pull-request review

The repository's AI review workflow uses ChatGPT Sol through Amazon Bedrock to
review pull requests targeting `v2`. It supplements deterministic CI and human
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

P0 and P1 findings submit `REQUEST_CHANGES` and fail the workflow. P2 and P3
findings are advisory `COMMENT` reviews. A clean result is also a `COMMENT`. The
workflow never emits `APPROVE`.

## Trust boundary

The workflow runs on `pull_request_target` so its definition and prompts come
from the trusted default branch. It never checks out the PR head. An
uncredentialed context job fetches the immutable head object and records the
bounded diff, metadata, exact changed-line ranges, and complete changed-file
snapshots without executing them. Model jobs check out the exact base SHA, run
Codex in its read-only sandbox, and receive no GitHub token.

The model jobs authenticate to a dedicated Bedrock role through GitHub OIDC and
the `ai-pr-review-v2` GitHub environment. Agent-spawned shell commands inherit no
`AWS_*`, Actions, or GitHub variables. The agents cannot publish. A separate
deterministic job has `pull-requests: write`, no AWS credentials, revalidates the
current head and structured review, dismisses stale blocking reviews, suppresses
duplicate context IDs, and calls fixed review/check endpoints.

The publisher creates an explicit check run on the reviewed head SHA so the
verdict is attached to the proposed commit rather than the default-branch commit
that owns the `pull_request_target` run.

Because GitHub only loads `pull_request_target` workflow definitions from the
repository's default branch, `.github/workflows/ai-pr-review.yml` must be
installed on the default branch even though it filters for PRs targeting `v2`.
The jobs then check out the exact trusted `v2` base SHA for prompts, validator,
and repository rules. Keep the default-branch workflow copy synchronized when
its orchestration changes; prompt and validator changes remain on `v2`.

## OIDC setup

Set the repository variable `AWS_AI_PR_REVIEW_ROLE_ARN` to the dedicated role
ARN. No long-lived AWS key is stored in GitHub.

Create the `ai-pr-review-v2` GitHub environment and restrict its deployment
branches to the trusted default branch. The role trust policy should require the
following exact OIDC audience and subject:

```json
{
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:awslabs/aidlc-workflows:environment:ai-pr-review-v2"
  }
}
```

The permissions policy should grant only the Bedrock/Mantle model invocation
actions required for `openai.gpt-5.6-sol`; it should not grant repository,
artifact, deployment, storage, or general AWS administration APIs. Organizations
that customize GitHub OIDC subject claims should additionally bind the trusted
`job_workflow_ref` for this workflow.

The workflow installs the pinned Codex CLI before assuming the role, reducing
the time that short-lived credentials exist in the job environment.

## Machine contract

The synthesizer returns strict JSON. Each finding carries a P0-P3 priority,
title, changed-line evidence, problem chain, impact, and required correction.
The deterministic validator in `.github/scripts/ai-pr-review.ts` renders the public
Markdown and rejects stale SHAs, malformed JSON, inverted priorities, fabricated
or unchanged-line evidence, reserved output markers, oversized output, and
unsupported verdicts before publication.

The model processes have no merge credential or GitHub token. GitHub's
`pull-requests: write` permission used by the deterministic publisher is not
review-only at the API level, so repository rules must exclude
`github-actions[bot]` from identities allowed to update or merge `v2`.
