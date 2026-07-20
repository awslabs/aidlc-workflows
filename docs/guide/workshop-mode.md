# Workshop Mode

The `workshop` scope is the only AI-DLC scope designed for *facilitated group sessions* — typically a workshop or training lab where one person (the facilitator) has decided what the group will build, and N participants drive separate Construction Bolts in parallel against a shared remote.

This chapter is a **manual recipe**: it documents the workshop flow using primitives that already ship today (`aidlc-worktree`, `aidlc-bolt`, plus ordinary git). There is no dedicated `--claim-bolt` CLI yet — claim semantics ride on `git push` to the shared remote, and the recipe makes that contract explicit. A future release may automate the moves this chapter describes; for now, the recipe is the contract.

For the scope's depth/test-strategy/skip-list, see [Scopes and Depth § workshop](05-scopes-and-depth.md#workshop). For the per-Bolt worktree mechanics this chapter assumes, see [State and Audit](10-state-and-audit.md) and the orchestrator's [Construction flow](../reference/03-orchestrator.md). New facilitator? Run through [Getting Started](01-getting-started.md) first — bun and your harness's framework copy must already be in place before any workshop step below.

> **Harness note.** This recipe is harness-neutral: it drives the `aidlc-worktree`
> and `aidlc-bolt` tools (shared across every harness) plus ordinary git. The
> command examples invoke the orchestrator as `/aidlc` (Claude Code / Kiro); on
> Codex use `$aidlc`. The claim-and-merge git contract is identical everywhere.

---

## When to use workshop mode

Workshop mode fits when **all** of the following are true:

- A facilitator has pre-decided the project scope (the workshop has a topic — participants don't choose what to build)
- Multiple developers will work on different parts of Construction simultaneously, each on their own clone of a shared repository
- Mandatory gates at every stage are acceptable (workshop mode keeps the gate ceremony — the point is to teach the methodology, not skip it)
- Pace matters more than test depth — workshop ships at Standard depth with **Minimal** test strategy specifically to keep the session moving

It does **not** fit single-developer work, ad-hoc parallel collaboration, or any situation where a participant might claim a Bolt and then walk away without explicit hand-off. For solo work choose `feature`, `mvp`, or one of the smaller scopes.

---

## The shape of a workshop run

A workshop run has three parties:

| Role | What they do |
|------|--------------|
| **Facilitator** | Pre-decides the project, runs Inception solo on the shared remote (so all participants start from the same approved Inception artifacts), then opens Construction for parallel claiming |
| **Participant** | Clones the shared remote, claims a Bolt by pushing its branch first, runs that Bolt's Construction stages locally in their own worktree, pushes back when the gate approves |
| **Group** | Reviews each gate together — the LLM does the work; humans drive the gates |

Inception runs serially with the facilitator at the keyboard. Construction is where parallelism kicks in — once `bolt-plan.md` is approved, every Bolt becomes claimable.

---

## Facilitator setup

### Before the session

Launch Claude Code in the project (`cd workshop-project && claude`), then birth the first intent with the workshop scope:

```
/aidlc --scope workshop
```

Naming the scope on a fresh workspace births the first intent and stamps `Scope: workshop` and `Default Test Strategy: Minimal` into that intent's `aidlc-state.md`. Push the born intent's state to the shared remote so participants clone a project that already knows it's a workshop.

Per-project default scopes can be set via `AWS_AIDLC_DEFAULT_SCOPE=workshop` in `.claude/settings.json`. With this set, every participant who runs `/aidlc` in a clone gets the workshop routing automatically without remembering the flag — see [Customization § Per-Project Default Scope](13-customization.md#per-project-default-scope).

### Run Inception solo

The facilitator drives Inception stages 2.1 through 2.8 in sequence, hitting every gate. The workshop scope skips Ideation entirely (1.1–1.7) — the project is pre-decided, so there's nothing to ideate.

**Stage 2.2 (practices-discovery) is load-bearing for workshop mode.** This is where the team affirms branching strategy, walking-skeleton stance, testing posture, and deployment cadence — and Construction reads those affirmations on every per-Bolt decision. Run the affirmation gate with the group, not solo: the answers govern what happens on every participant's machine for the rest of the workshop.

When `delivery-planning` (2.8) emits `bolt-plan.md`, **review it with the group before proceeding to Construction.** The Bolt list determines who claims what — participants need to see it.

Push the approved Inception artifacts to the shared remote. From this point forward, participants pull and claim.

---

## Claim semantics: git push is the claim

The recipe uses ordinary git to enforce slug uniqueness across clones. There is no AI-DLC-specific claim registry — the **shared remote's branch namespace** is the registry, and `git push` is the atomic primitive that prevents two participants from racing on the same Bolt.

The contract:

1. **Always `git fetch --all` immediately before claiming.** Stale local refs hide concurrent claims.
2. **Claiming a Bolt named `foo` means pushing `bolt-foo` to the shared remote first.** First push wins.
3. **Late claimants see a non-fast-forward push rejection** when the remote already has `bolt-foo`. That's the signal to pick a different Bolt.
4. **Practices govern the branching shape — read them, don't guess.** The resolved `## Way of Working` statement in `aidlc/spaces/<active-space>/memory/{project,team,org}.md` is what `aidlc-pipeline-deploy-agent` reads at merge dispatch to pick the merge target and strategy. The base branch you create the worktree from must match that affirmed shape: trunk-based teams base off `main`, gitflow teams base off `develop`, release-branch teams base off the active release branch. Participants don't pick this — the facilitator's affirmed practices already chose it. See [the branching-strategies knowledge file](../../core/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md) for the contract aidlc-pipeline-deploy-agent honours (it ships into your harness's `knowledge/` dir).

> **Why the participant supplies `--base` manually here.** In the standard (single-engineer) Construction flow, the conductor dispatches `aidlc-pipeline-deploy-agent` to read the active space's `## Way of Working` and resolve `--base` for you. The workshop recipe is a *manual* multi-clone variant — there is no conductor-driven workshop dispatcher today, so each participant copies the same `--base` value from the active-space memory files they all pulled. This is why the facilitator's affirmation at stage 2.2 is load-bearing: it is the single source of truth every participant reads.

The actual `aidlc-worktree create` subcommand creates the local worktree and the local branch but does **not** push. Pushing is what publishes the claim. This separation is intentional: a participant on a poor connection can do all their local work first and push the claim atomically when ready.

---

## Participant flow

### 1. Clone

```bash
git clone <shared-remote> participant-clone
cd participant-clone
```

The clone arrives with the intent's `aidlc-state.md` already pinned to `Scope: workshop` and the approved Inception artifacts already in the intent's record dir.

### 2. Pick and claim a Bolt

```bash
# MANDATORY before claiming — refresh local refs
git fetch --all

# Inspect what's already claimed
git ls-remote --heads origin "bolt-*"

# Pick an unclaimed Bolt from bolt-plan.md (e.g. user-profile-api)
# and create the worktree + branch locally. The --base value MUST match
# the team's affirmed branching strategy (read from the active-space memory files):
#   trunk-based  → --base main
#   gitflow      → --base develop
#   release-branch → --base release/<version>
bun .claude/tools/aidlc-worktree.ts create --slug user-profile-api --base main

# Publish the claim atomically. If another participant raced you,
# this push is rejected — pick a different Bolt.
git push origin bolt-user-profile-api
```

The push has three possible outcomes:

| Outcome | What it means | What to do |
|---------|--------------|------------|
| `* [new branch]      bolt-user-profile-api -> bolt-user-profile-api` | Claim succeeded. The branch is now reserved on origin. | Continue to step 3. |
| `! [rejected]        bolt-user-profile-api -> bolt-user-profile-api (non-fast-forward)` or `(fetch first)` | Another participant claimed first while you were preparing. | Discard the local worktree (`aidlc-worktree discard --slug user-profile-api`) and pick a different Bolt. |
| Network error / auth timeout | Push didn't reach origin. | Retry after `git fetch --all` — your local worktree is still safe. |

### 3. Run the Bolt locally

Once the claim is published, run the Bolt the normal way — in the Claude Code session:

```
/aidlc
```

The orchestrator picks up at the per-Bolt loop. Because the worktree already exists and the branch is already on origin, the participant works exactly as in any single-developer scope — state and audit fork into the worktree (see [State and Audit § Construction worktrees](10-state-and-audit.md)), Construction stages run inside the worktree, and the mandatory gate at the end of the Bolt opens for group review.

### 4. Merge and push

When the gate approves, the standard `aidlc-bolt complete --merge --slug user-profile-api` flow merges the worktree state and audit back into the participant's local main. **Push the updated state file to origin** (`git push origin main`) — the participant's local merge updates `aidlc-state.md` (e.g., setting `Construction Autonomy Mode: autonomous` after the ladder prompt fires for the first claimant), and other participants must pull that file before they resume to inherit the workflow's mode. The conductor dispatches `aidlc-pipeline-deploy-agent` to read `## Way of Working` from `aidlc/spaces/<active-space>/memory/{project,team,org}.md` and pick the merge target + strategy. The audit log brackets each dispatch with `MERGE_DISPATCH_INVOKED` → `MERGE_DISPATCH_RETURNED` (or `MERGE_DISPATCH_FALLBACK` if the agent timed out and the conductor fell back to `org.md` defaults). Inspecting these rows after the workshop is the quickest way to confirm the team's affirmed branching was actually honoured.

```bash
# After aidlc-bolt complete --merge succeeds — push the merged target branch
git push origin main    # or develop / release-* per the team's affirmed branching
```

### 5. Hand off (if not completing)

If a participant claims a Bolt but can't finish, the manual hand-off is:

```bash
# On the original claimant's clone
bun .claude/tools/aidlc-worktree.ts discard --slug user-profile-api
git push origin :bolt-user-profile-api    # delete the remote branch

# On the new claimant's clone, after fetch
git fetch --all
bun .claude/tools/aidlc-worktree.ts create --slug user-profile-api --base main
git push origin bolt-user-profile-api
```

The audit trail in each clone records the local lifecycle (`WORKTREE_CREATED` / `WORKTREE_DISCARDED` / a fresh `WORKTREE_CREATED` on the new clone). There is no resume across machines — the new claimant starts the Bolt fresh.

---

## Worked example: 2 developers, 3 Bolts

The shared remote holds `bolt-plan.md` with three Bolts: `user-profile-api`, `billing-service`, `notifications-worker`.

Alice and Bob have each cloned the workshop repo. During Inception's stage 2.2 the team affirmed an always-skeleton stance under `## Walking Skeleton` in `aidlc/spaces/<active-space>/memory/team.md`, so the orchestrator picks the walking-skeleton-marked Bolt (`user-profile-api`) and runs it solo before opening parallel claiming. **The skeleton-merges-first rule is orchestrator-enforced** — Bob doesn't have to remember to wait, the orchestrator simply doesn't dispatch the parallel batch until the skeleton lands on the shared remote.

### Walking-skeleton Bolt — Alice solo

```bash
# Alice's clone
# (Worked example assumes a trunk-based team — substitute --base develop for
# gitflow teams or --base release/<version> for release-branch teams, per
# aidlc/spaces/<active-space>/memory/team.md.)
git fetch --all
bun .claude/tools/aidlc-worktree.ts create --slug user-profile-api --base main
git push origin bolt-user-profile-api    # claim succeeds — first claimant
# In Claude Code (`claude`), run: /aidlc
#   — runs Construction stages 3.1–3.5 in the worktree
# Group reviews and approves the always-gate (workshop keeps every gate)
bun .claude/tools/aidlc-bolt.ts complete --merge --slug user-profile-api
git push origin main                      # publishes the merged result
```

After the skeleton merges, the conductor fires the **ladder prompt** once: "How should the remaining Bolts run? Continue autonomously / Gate every Bolt." The group's choice persists in `aidlc-state.md` as `Construction Autonomy Mode`. Bob picks up that choice on his next `git fetch --all` — Alice and Bob don't need to coordinate it verbally.

> **What if `bolt-plan.md` marked a Bolt as walking-skeleton but practices says skeleton-off?** Practices wins. The orchestrator emits a `PRACTICES_OVERRIDE` audit row recording the conflict (`Reason: bolt-plan-marker-conflict`, plus the practices stance and the bolt-plan marker) and the marked Bolt runs as a regular Bolt — no always-gate, no ladder prompt. Practices is the team's standing voice; bolt-plan is one workflow's interpretation.

### Parallel Bolts — Alice + Bob

Both run `git fetch --all` to pick up Alice's merged main. (Both blocks below assume trunk-based — substitute `--base develop` for gitflow teams or `--base release/<version>` for release-branch teams, same as Alice's solo skeleton block above.)

```bash
# Alice picks billing-service
git fetch --all
bun .claude/tools/aidlc-worktree.ts create --slug billing-service --base main
git push origin bolt-billing-service      # succeeds
```

```bash
# Bob picks notifications-worker concurrently
git fetch --all
bun .claude/tools/aidlc-worktree.ts create --slug notifications-worker --base main
git push origin bolt-notifications-worker # succeeds — different slug, no race
```

Both run `/aidlc` in their respective clones. State and audit fork into the per-Bolt worktrees independently. Each participant's Construction work is local until they merge.

### What happens if Alice and Bob both pick the same slug

Suppose both decided to claim `billing-service`:

```bash
# Alice
git push origin bolt-billing-service
# * [new branch]      bolt-billing-service -> bolt-billing-service     (Alice wins)
```

```bash
# Bob (races a few seconds later)
git push origin bolt-billing-service
# ! [rejected]        bolt-billing-service -> bolt-billing-service (fetch first)
# error: failed to push some refs to '<remote>'
# hint: Updates were rejected because the remote contains work that you do
# hint: not have locally.
```

Bob's local worktree still exists at `.aidlc/worktrees/bolt-billing-service/` — it's a wasted local copy, not corruption. Bob discards it and picks `notifications-worker` instead:

```bash
bun .claude/tools/aidlc-worktree.ts discard --slug billing-service
git fetch --all
bun .claude/tools/aidlc-worktree.ts create --slug notifications-worker --base main
git push origin bolt-notifications-worker
```

The race cost Bob roughly 30 seconds of local setup. No state corruption, no participant blocked.

### Final convergence

When both Bolts complete:

```bash
# Alice (after gate approval)
bun .claude/tools/aidlc-bolt.ts complete --merge --slug billing-service
git push origin main                      # may need a fetch+rebase if Bob got there first
```

```bash
# Bob (after gate approval)
bun .claude/tools/aidlc-bolt.ts complete --merge --slug notifications-worker
git fetch --all
git rebase origin/main                    # if Alice pushed in the meantime
git push origin main
```

The two final pushes serialise through ordinary git mechanics. The shared remote ends up with all three Bolts merged into main, plus three `bolt-*` branches that can be cleaned up:

```bash
# Anyone can clean up after the workshop
git push origin :bolt-user-profile-api :bolt-billing-service :bolt-notifications-worker
```

### Workshop wrap-up

Once every Bolt has merged and `bolt-*` branches are deleted, the facilitator should:

1. **Verify `Bolt Refs` is empty** — `bun .claude/tools/aidlc-utility.ts status` (or read `aidlc-state.md`) should show `Bolt Refs: [empty list]`. Any leftover slug indicates a Bolt that didn't merge cleanly; investigate before closing the workshop.
2. **Inspect any preserved worktrees** — `bun .claude/tools/aidlc-worktree.ts list` shows every preserved `.aidlc/worktrees/bolt-*/` directory. These survived because a participant chose Skip or Abort during halt-and-ask. Decide whether to discard them (`aidlc-worktree discard --slug <slug>`) or keep them for post-workshop debrief.
3. **Skim the audit log** — the intent's `audit/` shards carry the audit entries from every participant's worktree (each clone's shard merges in cleanly, no conflicts). `MERGE_DISPATCH_FALLBACK` rows are the breadcrumb for "we silently used trunk defaults instead of the team's affirmed branching" — surface these in debrief.
4. **Tag a release if appropriate** — workshop scope completes with all Construction Bolts merged; if the workshop's project is going further, this is a natural tag point. Per the team's affirmed deployment cadence in `aidlc/spaces/<active-space>/memory/team.md`, this may auto-trigger a staging deploy.

The framework handles each participant's per-session resume case — see [Resuming a workshop session](#resuming-a-workshop-session) below — useful when a participant's session was killed mid-batch and they're rejoining the workshop late.

---

## Gates in workshop mode

Workshop mode keeps **mandatory gates at every stage** — that's the whole point. The pattern is:

1. The LLM completes the stage's work in a participant's clone
2. The state file moves to `[?]` (awaiting approval)
3. The group reviews the artifact together (in the room, on a shared screen, in a video call — workshop-dependent)
4. The participant clicks Approve in their Claude Code session, the gate clears, the next stage begins

Group review is what distinguishes workshop mode from `feature` or `mvp` — the same `[?]` checkbox in the state file, but a different review surface. The gate doesn't know whether one person or twenty are looking at the artifact.

### Parallel-batch gates

When the conductor runs a parallel batch of Bolts (e.g. four participants each driving one Bolt of a four-Bolt batch), the gate is **batch-level, not per-Bolt** — one approval covers all Bolts in the batch. The group reviews each worktree's diff in turn and decides Approve all / Inspect / Reject one or more. Rejected Bolts have their worktrees preserved on disk for follow-up.

### Multi-failure halt-and-ask

A **solo Bolt failure** (m=1) uses the standard halt-and-ask single-AUQ path documented in [the orchestrator's Construction flow](../reference/03-orchestrator.md). The walking-skeleton Bolt always runs solo, so its failures take this path.

When **two or more Bolts in the same parallel batch fail** (e.g. both `email-delivery` and `admin-panel` hit a code-generation error), the conductor renders a **sequential AUQ** — one failed Bolt at a time, in slug order, each tagged in the question body as `failure <k> of <m>`. Successful Bolts in the same batch are held back from merging via the **HOLD-MERGE invariant**, which is enforced in tooling, not just prose:

- Before opening the AUQ sequence, the conductor runs `aidlc-bolt hold-merge --slug <slug>` for each successful Bolt. This writes `Merge-Held: true` to that Bolt's per-Bolt forked state file (idempotent — re-holding an already-held Bolt succeeds silently).
- While the marker is set, `aidlc-bolt complete --merge --slug <slug>` refuses with a non-zero exit and a `{ok:false, reason:"merge-held", ...}` envelope. The conductor can't accidentally merge a survivor mid-AUQ-sequence — the tool itself blocks it.
- Once every failed AUQ is resolved (retried-and-succeeded, skipped, or aborted), the conductor runs `aidlc-bolt release-merge --slug <slug>` for each held survivor and dispatches the merges in original batch order.

For each failure the AUQ offers Retry (re-run code-generation in the same worktree — iteration count tracked in state), Skip (mark as `[S]` in state, preserve worktree on disk), or Abort (halt Construction; un-rendered AUQs k+1..m are deferred to the next session resume). The hold markers survive session-kill — see resume rules below.

> **Two distinct cleanup verbs.** `aidlc-bolt abort --name "<name>" --slug <slug> --reason "<text>"` is the canonical Bolt-level abort — emits `BOLT_FAILED` with `Reason: aborted` and (per US-1 AC4) preserves the worktree directory by default. Add `--discard` to also tear the worktree down. `aidlc-worktree discard --slug <slug>` is the lower-level worktree-only cleanup used for race-loss recovery (when a participant lost a claim race and just wants to dispose of the local worktree before picking a different Bolt). They are not interchangeable — use `aidlc-bolt abort` when there's a Bolt to mark failed; use `aidlc-worktree discard` when there isn't.

The error message a participant sees when running `aidlc-bolt complete --merge --slug <slug>` on a held Bolt is verbatim:

```
Merge held by HOLD-MERGE invariant; resolve the failed-sibling halt-and-ask sequence
and run `aidlc-bolt release-merge --slug <slug>` before retrying.
```

If you see this, the orchestrator is mid-AUQ-sequence. Resolve every failed-sibling AUQ first, then `aidlc-bolt release-merge --slug <slug>` will clear the marker.

### Resuming a workshop session

Workshop participants will lose sessions — laptop sleeps, network drops, lunch breaks. The framework handles resume cleanly because every load-bearing decision lives in committed artifacts (`aidlc-state.md`, the `audit/` shards, `aidlc/spaces/<active-space>/memory/team.md`) the resuming session can re-read.

The contract:

1. **Pull before resuming.** `git fetch --all && git pull` in the participant's clone — picks up any merges, autonomy-mode changes, or new claims from other participants.
2. **`/aidlc` re-derives state from disk.** The engine reads `Bolt Refs` from main state, walks the audit log, and reconstructs which Bolts are in which lifecycle phase.
3. **Bolts in `Bolt Refs` with a `STATE_FORKED` row but no `STATE_MERGED`**: orchestrator re-enters Phase 3 (resume code-gen).
4. **Bolts in `Bolt Refs` with `STATE_MERGED` already**: skipped — already merged.
5. **Survivors with `Merge-Held: true` in their forked state**: not merged. The orchestrator detects this deterministically by running `aidlc-worktree info --slug <slug>` and checking the `merge_held: boolean` field in the JSON envelope (set by the post-merge milestone 13 fold-in — orchestrator doesn't have to parse state files manually). It re-renders the unresolved failed-Bolt AUQs first; once cleared via `aidlc-bolt release-merge --slug <slug>`, dispatches the held merges in original batch order.
6. **Walking-skeleton ladder prompt unset**: if the resuming session sees `Construction Autonomy Mode: unset` and the skeleton is already `[x]`, the ladder prompt fires to the resuming engineer. Whoever resumes first sets the mode; subsequent resumers inherit it via `git pull`.

Practices and autonomy mode are explicit committed artifacts in the shared repo — there's no magic state synchronisation between machines. Pull, resume, continue.

---

## What this recipe does NOT cover

- **A dedicated `--claim-bolt` CLI utility.** That utility may ship in a future release once a real workshop dogfood surfaces a concrete requirement (better error messages on race, audit-only offline mode, automated stale-claim detection). Until then, the recipe above using `aidlc-worktree create` + `git push` is the contract.
- **Stale-claim detection.** A participant who claims a Bolt and then drops off without releasing leaves an orphan `bolt-<slug>` branch on origin. The facilitator manually deletes it (`git push origin :bolt-<slug>`). Future `--doctor` extensions in v0.4.0 milestone 15 may flag stale branches automatically.
- **Audit-only / offline mode.** Without a shared remote, claim coordination falls back to verbal agreement among facilitator and participants. Workshop mode is fundamentally a multi-clone pattern; single-laptop runs of the workshop scope are possible but lose the parallel-claim benefit.
- **Practices freshness during a multi-clone workshop.** Practices are read **once at Construction start** — the conductor loads `## Walking Skeleton` and `## Way of Working` from `aidlc/spaces/<active-space>/memory/{project,team,org}.md`, and that single read services the entire Construction phase for that participant's session. If the facilitator re-runs practices-discovery while participants have Bolts in flight, in-flight participants will not re-read live active-space memory until they restart their `/aidlc` session (and `git pull` the new affirmation). **Rule for the facilitator:** do not re-run practices-discovery while any Bolt is in flight. Finish every in-flight Bolt's gate first. **Rule for participants:** always run `git fetch --all && git pull` immediately before resuming a session — this catches any practices change that landed while you were away. The same rule covers the `--base` value in step 2 of the participant flow: the value you copy from active-space memory is only fresh as of your last pull.

---

## Related reading

- [Scopes and Depth § workshop](05-scopes-and-depth.md#workshop) — the scope's stage list, depth, and test strategy
- [State and Audit](10-state-and-audit.md) — how Construction worktrees fork state and audit
- [CLI Commands](12-cli-commands.md) — `aidlc-worktree` and `aidlc-bolt` subcommand reference
- [Orchestrator: Construction flow](../reference/03-orchestrator.md) — what happens inside each Bolt
- [Branching Strategies (knowledge file)](../../core/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md) — aidlc-pipeline-deploy-agent's merge-dispatch contract
