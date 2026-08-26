# Multi-Team Construction and Workshop Mode

Team-owned Construction lets several human teams build different Units from one
approved intent. Workshop mode is one application of the same mechanism; the
engine contract is scope-agnostic:

- `Construction Iteration: unit-major`
- `Unit Ownership: team`
- a valid Unit dependency DAG
- a shared git namespace, or sibling worktrees sharing one local ref database

Team ownership currently requires the workspace root itself to be the source Git
repository. An intent with a recorded sibling-repo set is rejected before
`Unit Ownership: team` is recorded; use solo ownership for that multi-repo
intent.

The integration lead works from unscoped main. Each delivery team works from a
checkout stamped to one claimed Unit. A claimed checkout runs that Unit's exact
Construction chain, stages 3.1 through 3.5, in graph order. Main never reruns
those stages after merge because the team's keyed receipts arrive with its
audit shard.

For the Workshop scope's stage grid and Minimal test floor, see
[Scopes and Depth](05-scopes-and-depth.md#workshop).

---

## Roles and topologies

| Role | Responsibility |
|------|----------------|
| **Integration lead** | Drives Inception and any required walking skeleton on main, monitors claims, pins completed candidates, presents merge gates, and lands approved Units |
| **Unit team** | Claims one dependency-ready Unit, runs its scoped 3.1-3.5 chain, commits the artifacts/receipts/source, and publishes the candidate |
| **Review group** | Answers the Unit's selected team gates and the main-side pinned merge gate |

Two topologies use the same commands and evidence:

Command examples use the harness-neutral public grammar. Run them through the
installed harness's `/aidlc` command surface or its packaged `aidlc`
dispatcher; no example assumes a `.claude/`, `.kiro/`, or `.codex/` tool path.

### Clone per team

Each team clones the shared remote. Claim coordination and candidate publication
use `refs/heads/claim/<intent-id8>/<unit>`.

```bash
git clone <shared-remote> payments-team
cd payments-team
git fetch --all
aidlc unit claim payments --team "Payments team"
```

### Sibling worktrees

One repository creates sibling worktrees. Claims use the shared local branch
namespace through atomic `git update-ref` only when no remote is configured. If
`origin` exists, sibling worktrees use the same remote-backed claims as separate
clones. This topology is useful for one machine and deterministic tests; remove
the remote only when the whole exercise is intentionally local/offline.

```bash
# From unscoped main:
# Optional local-only mode: git remote remove origin
aidlc worktree create --slug payments --base main
cd .aidlc/worktrees/bolt-payments
aidlc unit claim payments --team "Payments team"
```

Run the same scoped build and `publish` commands below from that worktree. After
main lands and pushes the candidate, return to main and discard the completed
local worktree with `aidlc worktree discard --slug payments`.

Normal scoped `next`, lifecycle, review, and gate work is offline-first. Network
access is confined to explicit claim, publish, status, pin, and merge-ref
verification operations.

---

## Prepare Construction

The integration lead completes Inception, including:

1. the authoritative Unit DAG;
2. `Construction Iteration: unit-major`;
3. `Unit Ownership: team`;
4. the team gate rhythm, `per-stage` or `unit-end`;
5. the affirmed branching strategy.

When the scope records `skeleton: on`, the first DAG Unit is the walking
skeleton. It runs on unscoped main before claims open and needs no merge-back
gate. With `skeleton: off`, dependency-ready Units open immediately.

Publish the approved Inception state and artifacts before teams claim:

```bash
git push origin main
```

Claims open by dependency batch. "Delivery planning is complete" does not mean
every Unit is claimable; a Unit remains blocked until every `depends_on` row is
merged.

---

## Claim, build, and publish

### 1. Claim

In a participant clone:

```bash
git fetch --all
aidlc unit participate
```

Run `/aidlc` for the guided picker, or claim directly:

```bash
aidlc unit claim payments --team "Payments team"
```

Exactly one concurrent claimant wins. The command stamps the checkout with
space, intent, Unit, generation, nonce, and gate rhythm.

To hand the same attempt to a teammate on another machine, push the claim ref.
The teammate fetches and checks out the exact local `claim/<intent-id8>/<unit>`
branch, then runs:

```bash
aidlc unit adopt payments
```

Adoption verifies the checked-out payload against the live ref and keeps the
claim's bound audit shard, so the teammate can resume and publish without
creating a successor attempt.

### 2. Build

Run `/aidlc` in the claimed checkout. The engine routes only the stamped Unit:

1. Functional Design (3.1)
2. NFR Requirements (3.2)
3. NFR Design (3.3)
4. Infrastructure Design (3.4)
5. Code Generation (3.5)

Plan Approval remains mandatory during Code Generation.

Gate rhythm controls the team review points:

- `per-stage`: one gate after each settled `(stage, Unit)`;
- `unit-end`: one team completion gate after 3.5;
- both rhythms still add one pinned merge gate on main.

Commit the completed artifacts, source, state mirror, and audit shard. Publication
requires a clean tracked checkout:

```bash
git add -A
git commit -m "Complete payments Unit"
aidlc unit publish payments
```

`publish` creates a candidate commit whose tree is the team's committed work and
whose parents bind both the claim history and the implementation history. It
CAS-updates the claim ref. Publication is not integration.

---

## Pin, gate, and land

All merge commands run from unscoped main.

### 1. Pin the candidate

```bash
git fetch --all
aidlc unit pin payments
```

Pinning records one exact candidate OID and attempt generation. Evidence is read
with git object plumbing, not by merging or creating a worktree:

- required Unit artifacts;
- `UNIT_COMPLETED` receipts for active stages;
- team gate approvals at the claim rhythm;
- required reviewer `READY` verdicts;
- Plan Approval fingerprint and explicit approval;
- the candidate state row;
- the transportable team audit shard.

**Trust model.** The claim-bound team shard may carry that team's own
attempt-keyed `UNIT_COMPLETED`, team-gate, and reviewer receipts. Those rows are
team assertions: pin re-verifies required artifacts and fingerprints, and the
human reviews the remaining trust at the pinned merge gate. A team shard may
never carry `HUMAN_TURN`, `MERGE_DISPATCH_*`, `UNIT_MERGED`, a unit-merge gate,
another Unit's receipt, or another/new audit shard. Pin and land also refuse
workflow-record changes outside the claimed Unit subtree. Product-source paths
outside the Unit's record tree remain visible in the gate evidence for human
overlap judgment.

If the claim is released/re-claimed, or the ref moves after pinning, the gate
and landing commands refuse. Run `pin` again and review the new OID explicitly.
If the registry cannot be reached, gate and land fail closed because they
cannot prove the pin was not tombstoned.

### 2. Present the merge gate

Before the gate, the harness follows the existing merge-dispatch seam: it emits
`MERGE_DISPATCH_INVOKED`, asks the pipeline-deploy agent to resolve the affirmed
target/strategy from the active practices, then emits
`MERGE_DISPATCH_RETURNED` or `MERGE_DISPATCH_FALLBACK`. The pinned OID and Unit
attempt generation and pin transaction ID are passed to every dispatch-event
call through `--pinned-oid`, `--attempt-generation`, and `--pin-id`; the gate
ignores unbound or older rows, including a bracket from an earlier pin of the
same candidate. The gate is not presented until that bracket is complete. Pinned Unit
landing requires strategy `merge` so the reviewed OID is a direct parent; a
squash/rebase result is refused and must be reconciled before the gate.

The integration lead presents the evidence summary and pinned OID to the human,
then records the exact answer:

```bash
aidlc unit gate payments \
  --decision approve \
  --user-input "Approve pinned candidate"
```

A rejection keeps the candidate unmerged. A candidate carrying
`Merge-Held: true` is refused until the team resolves the HOLD-MERGE sequence,
publishes again, and main re-pins.

### 3. Land

```bash
aidlc unit land payments --target main
```

Landing is ordered and resumable:

1. **Git content first.** Re-fetch the integration branch and verify that the
   approved Unit DAG, Unit kind, active stage columns, and evidence are still
   current, then merge the pinned OID. Contract drift refuses before mutation
   and requires rebase, republish, re-pin, and a new merge gate. Main's
   `aidlc-state.md`, runtime graph, cursors, and engine markers are retained; the team's new
   audit shard and per-Unit artifacts/source land. Real source conflicts abort
   back to a clean checkout and list the files. A clean automatic merge of a
   shared file is also refused when its result differs from the pinned candidate;
   rebase and republish. No Unit row has been folded.
2. **State fold.** Under the per-intent lock, derive the candidate's transported
   receipts, write the merged Unit row while preserving main's singletons and
   other rows, then emit `UNIT_MERGED`.
3. **Audit/finalize.** Commit the main state and merge lifecycle rows, then mark
   the local transaction complete.

The steps can be driven separately for recovery:

```bash
aidlc unit land payments --step git
aidlc unit land payments --step state
aidlc unit land payments --step audit
```

Each step is idempotent. `merge-status` shows the local transaction:

```bash
aidlc unit merge-status payments
```

Push the landed target branch so other teams and future claim checks observe
the new integration state:

```bash
git push origin main
```

Dependents become claimable from the merged row. After the last row merges,
the per-Unit block settles and main routes Build and Test (3.6), then CI
Pipeline (3.7), exactly as solo Construction does.

---

## Dispatcher, status, and health checks

On unscoped main, `/aidlc` is a turn-terminal dispatcher while team fan-out is
active. It renders one deterministic board verbatim:

- Unit Progress, including owner, per-stage/gate cells, and merged state;
- the local claim scan with owner, attempt generation, and **observed ref
  activity** (git refs carry no push timestamps);
- pinned candidates awaiting a merge gate or landing recovery;
- claimable Units and dependency-blocked Units.

Run `/aidlc --status` from main or any scoped checkout for the same board as a
read-only snapshot. It performs no fetch and writes no state, cache, or audit
row. Explicit space/intent selectors keep the status header, Unit DAG, claims,
and merge journals on one identity. The board names the next claim, gate, or
`aidlc unit land` recovery command. A participant with no currently claimable
Unit receives this terminal board instead of falling into main's solo walk.
Released claim history alone does not keep fan-out active: when no live claim
and no incomplete merge transaction remains, main resumes the normal
Construction walk.

When a fresh clone has several intents and no active-intent cursor, the picker
annotates a mixed team workspace with statuses such as `team construction, 2
units claimable`, `parked at code-generation`, and `complete`. Single-intent and
non-team picker text is unchanged.

`/aidlc --doctor` adds local-only claim reconciliation:

- a released/superseded attempt whose checkout stamp still lingers is a
  fix-required stale-stamp finding;
- a live claim with a known observation timestamp but no observed ref movement
  for 24 hours is an anomaly; release remains an explicit human decision;
- a pre-upgrade cache with no observation timestamp receives a baseline
  advisory rather than a false inactivity finding;
- claim refs whose intent id no longer exists locally are orphan findings.

Doctor never fetches or releases a claim.

---

## Release, salvage, and resume

If a team cannot finish, the integration lead releases the claim from unscoped
main:

```bash
aidlc unit release payments
```

Release publishes a generation-bumping tombstone. Old receipts remain history
but cannot authorize a successor or merge. Preserve useful source/artifacts by
cherry-picking or copying them into the successor's newly claimed checkout.

One narrow race has an explicit recovery. If the reviewed merge commit already
landed locally (`land --step git`) and that exact attempt was then released,
inspect the landed commit and record a human acknowledgment before folding:

```bash
aidlc unit land payments --accept-released-attempt \
  --user-input "I inspected the landed commit and accept completing this tombstoned attempt"
```

This is accepted only for the immediate tombstone whose predecessor is the
pinned OID, before state folding, and never for a successor claim. The journal
and main audit record the tombstone and acknowledgment.

After a prior release/re-claim, an intentional second release binds to the
current nonce:

```bash
aidlc unit status
aidlc unit release payments --expect-nonce <nonce>
```

A claimed checkout resumes from its local stamp and disk evidence without
network access. A fresh teammate checkout must use `aidlc unit adopt <unit>`
once on the exact claim branch. Pull/fetch before claiming, adopting,
publishing, or pinning; ordinary scoped `/aidlc` resume does not need the
registry.

---

## Two-day workshop walkthrough

### Day 1

1. The facilitator runs Inception with the group.
2. If enabled, the facilitator builds and gates the walking skeleton on main.
3. Alice claims `billing`; Bob claims `notifications`.
4. Each team runs its scoped 3.1-3.5 chain and team gates.
5. Each team commits and runs `aidlc unit publish`.

### Day 2

1. The facilitator pins Alice's candidate, reviews its evidence, records the
   merge gate, and lands it.
2. Main is pushed; any Unit depending on `billing` becomes claimable.
3. The facilitator repeats pin/gate/land for Bob's pinned candidate.
4. When the final row is merged, `/aidlc` on main routes Build and Test, then
   CI Pipeline.
5. The group reviews `UNIT_MERGED`, gate, reviewer, and merge-dispatch rows in
   the combined audit shards.

The teams never race to push main. Candidate refs can move only through
claim-bound CAS publication; main serializes the reviewed pinned OIDs.

---

## Related reading

- [CLI Commands](12-cli-commands.md) - claim, publish, pin, gate, and land
- [State and Audit](10-state-and-audit.md) - per-clone shards and merged receipt floors
- [Construction](../reference/04-stages/construction.md) - Unit-major routing and gate rhythm
- [Runtime Graph](../reference/13-runtime-graph.md) - the separate solo/swarm Bolt merge path
- [Branching Strategies](../../core/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md) - merge-dispatch strategy selection
