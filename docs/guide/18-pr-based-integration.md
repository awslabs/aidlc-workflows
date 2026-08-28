# PR-Based Integration

PR-based integration lets Construction keep moving while protected-branch
review happens on GitHub. AI-DLC opens evidence-rich PRs, observes review and
merge state, and settles Units only after GitHub confirms the merge. It never
merges a PR or enables auto-merge.

## What You Experience

During Practices Discovery, AI-DLC reads the repository's target branch,
protection, visible approval and check requirements, merge methods, PR
template, CODEOWNERS, and branch naming. When detection succeeds, you answer
one confirmation question describing the proposed integration process.

For example:

> `develop` is protected, requires two approvals and CI, uses merge commits,
> has a PR template and CODEOWNERS, and branches follow
> `feature/{ticket}-{slug}`. Integrate through PRs with that policy?

The answer is stored in Way of Working. Scope supplies the default stance:
most delivery scopes prefer `pr`, while `express` and `poc` prefer `direct`.
Repository reality wins: a protected target cannot be configured to accept a
direct integration path.

## One Unit Through Review

After Code Generation, PR Integration:

1. Builds `pr-record.md` from the team's PR template and every artifact in the
   stage's live `consumes` list.
2. Persists the fully rendered PR body and shows its digest plus the exact
   branch push and PR commands before any outward write.
3. Pushes and opens the PR only after the applicable publication gate.
4. Publishes those exact persisted body bytes, then reads the branch, PR body,
   base/head, coordination marker, and human review
   requests back before recording success.
5. Marks the Unit integrating and routes the next eligible Unit.

The evidence dossier is a collapsed appendix. Core evidence stays first;
plugin-added consumes appear automatically without changing the tool.

The PR's own CI is the per-Unit test gate. Build and Test still runs once after
all Units as the whole-stage backstop.

## Waiting Without Parking

An integrating Unit remains unsettled, so the stage gate cannot fire early,
but it is not an active checkpoint. Other Units can start while its PR is in
review.

When every remaining Unit is waiting, the workflow ends the turn with an
`awaiting-integration` status showing PR URLs, last-known states, and ages.
This is not Park: there is no resume command or polling loop. A later refresh
and verified receipt clear the wait automatically.

Run:

```text
/aidlc --status --refresh
```

to refresh PR state and see integrating Units. On Codex, use
`$aidlc --status --refresh`.

## Review Feedback

Only a formal `CHANGES_REQUESTED` review opens a revision round. Review
comments, COMMENTED reviews, and conversation comments are displayed as
findings but never treated as instructions.

For a revision:

1. Evaluate each finding in the Unit worktree.
2. Make the justified changes and run focused checks.
3. Present a fresh gate before the fix push, even under autonomous
   Construction.
4. Push and re-request only human reviewers.
5. Read the review request back; a successful HTTP response alone is not proof.

After three unresolved rounds, escalate or park the Bolt. Branch protection is
never bypassed by an "accept as-is" choice.

## Merge and Finalization

AI-DLC verifies GitHub's terminal merged state before it:

- records `PR_MERGED`;
- completes the Unit receipt;
- consolidates existing Bolt metadata;
- retires the worktree with reason `integrated-via-pr`.

The stage invokes finalization with `--execute` so an existing worktree is
retired. A manual finalize without `--execute` still records verified merge
and Unit completion locally, but preserves the worktree and reports
`cleanup_pending`.

A closed unmerged PR halts for a decision: reopen it, create a replacement, or
abandon the Bolt explicitly.

## Stacked and Multi-Repository PRs

Stacked PRs are allowed only for merge or rebase strategies and only when the
repository does not delete branches automatically on merge. Children are
retargeted before parent-branch deletion. Recovery for a closed child is:
restore the parent ref at its old SHA, reopen the child, retarget it, then
remove the restored ref.
The detected delete-on-merge value must be supplied explicitly for a stacked
open; unknown is refused.

A Unit spanning repositories gets one coordinated PR per repository. The
`AIDLC-Coordinated:` marker is authoritative. The Unit completes only when all
PRs merge. If one sibling has merged and another closes or requests changes,
AI-DLC halts and names the already-merged siblings rather than pretending it
can roll them back.

## Offline Behavior

Every GitHub call has a ten-second bound. A sweep starts with one connectivity
probe; if GitHub is unreachable, it stops immediately and shows the last-known
audit state with its age. Hooks and ordinary `next` routing never use the
network.

Do not set `Integration Mode` back to absent while Units are integrating. The
state tool refuses that transition until those Units are finalized or
explicitly abandoned.

## Related

- [Phases and Stages](04-phases-and-stages.md)
- [State and Audit](10-state-and-audit.md)
- [CLI Commands](12-cli-commands.md)
- [Plugins](../reference/18-plugin-mechanism.md)
