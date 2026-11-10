# Multi-Team Construction and Workshop Mode

Several teams can build the Units of one approved piece of work. The
lead's project is where its Inception ran. How the teams build follows where the code lives:

- **The code is the workspace's own repository** (the work records no code
  repos of its own; a `repos.json` that names only the workspace itself, as
  `"."`, counts as that): teams claim, publish, pin, gate and land. The
  integration lead works from unscoped main, each team from a checkout stamped
  to one claimed Unit, and main lands each Unit
  ([Teams on the workspace's own repo](#teams-on-the-workspaces-own-repo)).
- **The code is in repos of its own** (beside the workspace, anywhere on disk,
  or under `src/`, as `repos.json` or the work's repo set records them): each
  team builds its Unit as a piece of work of its own, in its own workspace and
  under its own rules, from a copy of what the lead approved, and merges it into
  each repo the way that repo always merges. The lead's project sees a Unit done when
  every repo it changed has merged, and runs Build and Test once every Unit is
  in ([Teams across repos](#teams-across-repos)).

Which one a piece of work takes is settled when **Several teams** is chosen:
work that records code repos records where the lead's project is (`Home Location`), and
work on the workspace's own repo, or team work started before AI-DLC recorded
`Home Location`, keeps the claim flow. A teammate who takes a Unit of solo work
builds it as work of their own in either layout
([A second person on solo work](#a-second-person-on-solo-work-and-the-leads-sign-off)).
Workshop mode is one use of this; it works the same for any scope whose plan
splits the work into Units.

What both need:

- a Unit plan with two or more Units, built one Unit at a time
  (`Construction Iteration: unit-major`), which choosing teams sets;
- the workspace in git, so every clone sees the same Units and claims.

In a workspace that is not a git repository, work with a recorded repo set is
built by one session: when Construction starts, AI-DLC says in one line that
the workspace needs to be in git for teams, and `set-unit-ownership team`
refuses with the same line before changing state.

For the Workshop scope's stage grid and Minimal test floor, see
[Scopes and Depth](05-scopes-and-depth.md#workshop).

---

## Prepare Construction

The integration lead completes Inception, including:

1. the authoritative Unit DAG;
2. `Construction Iteration: unit-major`;
3. `Unit Ownership: team`;
4. the team gate rhythm, `per-stage` or `unit-end`;
5. the affirmed branching strategy.

When Inception ends with two or more Units, the first step into Construction
asks who builds them, once, in every scope and in a composed workflow: **Just
me** records `Unit Ownership: solo` and this session builds the Units;
**Several teams** records `Unit Ownership: team`, switching a stage-by-stage
plan to one Unit at a time on the way (the choice says so, and says that each
team approves its Unit after every stage unless the lead asks for one approval
at the end of each Unit). A plan with one Unit, no Unit plan, or
Construction already under way is never asked. A reply that picks neither
leaves this session building, and the first step says to ask for teams before
the first Unit is built. Team approvals come after every stage (`per-stage`)
unless the lead asks for one approval at the end of each Unit
(`set-unit-gate-rhythm unit-end`) before the first team approval question;
the first team step offers it. On the workspace's own repo, while no team has
taken a Unit, that step also says once that this session builds the Units
here, starting with the first DAG Unit (the walking skeleton, when the scope
runs one). With a shared remote, the step that would start a Unit here asks
first whether to share the plan with the teams (see below); without one, the
line says to share the work through git, and each team then runs `/aidlc` in
its own clone to take a Unit.

When the work records code repos of its own and the workspace is a Git
repository, choosing **Several teams** also records where the lead's project
is: `Home Location` in the state, the address the workspace's own remote points
to (read, never changed; a user or token in the address is left out), or
`local` when it has no remote. Every Unit is then open: nothing names a team, and
anyone takes a Unit that is ready from the space they work in. Your checkout
stays the lead's project, never scoped to one Unit. The lead's project builds the
walking skeleton, when the scope runs one, and a Unit only when you say so
("build reporting here", `aidlc unit assign --here reporting`), which is a take
like any other: its claim is written at the lead's project, so no teammate takes
it meanwhile, and a Unit a teammate took first stays theirs. Otherwise it shows
the board while a Unit waits for someone to take it or a team builds one, and
builds nothing meanwhile ([Teams across repos](#teams-across-repos)). Work on the workspace's own repo
records no Home Location and keeps the claim, publish, pin, gate and land flow
([Teams on the workspace's own repo](#teams-on-the-workspaces-own-repo)).

When the scope records `skeleton: on`, the first DAG Unit is the walking
skeleton. It runs on unscoped main before claims open and needs no merge-back
gate; claims open once its Unit Progress row on the pushed main is complete.
With `skeleton: off`, or `Skeleton Stance: off` recorded in the work's state,
dependency-ready Units open immediately. When the team's practices answer
whether to build a thin end-to-end slice first, that answer is read at the
first step after several teams are chosen, before the plan is shared. While your answer is recorded but the plan the teams
have still holds every Unit behind the first, the board says so once, with the
share that fixes it.

On the workspace's own repo, teams take Units from the plan on the shared
remote. Once claims are open (at once with the skeleton off, once the walking
skeleton is approved with it on) and the repository has a remote, the step that
would start a Unit on main asks once whether to share the plan with the teams,
before each Unit this session would build:

- **Share them with the teams** runs `aidlc unit share`: it commits what git
  shows changed here (the question names how many files and, by name, up to
  ten new files outside `aidlc/`, past ten those nearest the project's top, with
  how many more; `git status` shows the rest before you share; ignored files
  and AI-DLC's own part of `.gitignore`, `AGENTS.md` and `opencode.json` stay
  out)
  and pushes the integration branch with a plain push, never forced. This
  checkout then shows the board instead of building Units. A push the remote
  refuses (it has commits this clone lacks, or the branch is protected) keeps
  the commit, says why, and the question comes back: pull main, then share.
- **Build them here for now** builds that Unit in this session; the question
  comes back before the next Unit.

Typed, the same step is `/aidlc unit share`, or your own commit and
`git push origin main`.

Where the work records code repos of its own, the step after choosing teams asks
once whether to share the plan with them: **Share them with the
teams** runs `aidlc unit share --plan`, which commits AI-DLC's record here
(`aidlc/`, none of your other files) and pushes main with a plain push; **Not
now** leaves it, and a team's clone sees the plan once main is pushed (or push
it yourself with `git push origin main`). When the remote does not answer, Share says so and keeps the
commit, and the question is not put again; run `aidlc unit share --plan` once
it can be reached. A Unit you add to the plan after sharing it is not on the
remote until you share again, so the question comes back once, naming it. Until
you answer it, the board asks whether each team approves its Unit after every
stage, as it does by default, or once at the end of each Unit.

Claims open by dependency batch. "Delivery planning is complete" does not mean
every Unit is claimable; a Unit remains blocked until every `depends_on` row is
merged.

---

## Teams on the workspace's own repo

Where the code is the workspace's own repository, and for team work that
started before AI-DLC recorded `Home Location`, the integration lead works from
unscoped main and each delivery team works from a checkout stamped to one
claimed Unit. A claimed checkout runs that Unit's exact Construction chain,
stages 3.1 through 3.5, in graph order, and main pins, gates and lands each
candidate. Main never reruns those stages after merge because the team's keyed
receipts arrive with its audit shard. The teams share one git namespace, or
sibling worktrees share one local ref database.

### Roles and topologies

| Role | Responsibility |
|------|----------------|
| **Integration lead** | Drives Inception and any required walking skeleton on main, monitors claims, pins completed candidates, presents merge gates, and lands approved Units |
| **Unit team** | Claims one dependency-ready Unit, runs its scoped 3.1-3.5 chain, commits the artifacts/receipts/source, and publishes the candidate |
| **Review group** | Answers the Unit's selected team gates and the main-side pinned merge gate |

Two topologies use the same commands and evidence:

Command examples use the harness-neutral public grammar. Run them through the
installed harness's `/aidlc` command surface or its packaged `aidlc`
dispatcher; no example assumes a `.claude/`, `.kiro/`, or `.codex/` tool path.

#### Clone per team

Each team clones the shared remote. Claim coordination and candidate publication
use `refs/heads/claim/<intent-id8>/<unit>`.

```bash
git clone <shared-remote> payments-team
cd payments-team
git fetch --all
aidlc unit claim payments --team "Payments team"
```

#### Sibling worktrees

One repository creates sibling worktrees. Claims use the shared local branch
namespace through atomic `git update-ref` only when no remote is configured. If
`origin` exists, sibling worktrees use the same remote-backed claims as separate
clones. This topology is useful for one machine and deterministic tests; remove
the remote only when the whole exercise is intentionally local/offline.

Bolt directories and branches use `bolt-<id8>_<slug>`, where `<id8>` is the
selected intent's registry UUID suffix, also used by Unit claims at
`refs/heads/claim/<id8>/<unit>`. Parallel intents can therefore use the same Unit
slug in one checkout or across worktrees of one clone without colliding
([#1252](https://github.com/awslabs/aidlc-workflows/issues/1252)). See
[Bolt identity](../../core/knowledge/aidlc-shared/worktree-info-schema.md#bolt-identity)
for naming and legacy compatibility. Use the path returned by `create`; this
example assumes intent identity `7c31e9a0`.

```bash
# From unscoped main:
# Optional local-only mode: git remote remove origin
aidlc engine worktree create --slug payments --base main
cd .aidlc/worktrees/bolt-7c31e9a0_payments
aidlc unit claim payments --team "Payments team"
```

Run the same scoped build and `publish` commands below from that worktree. After
main lands and pushes the candidate, return to main and discard the completed
local worktree with `aidlc engine worktree discard --slug payments`. On a Bun-based
copy install, run `bun .claude/tools/aidlc-worktree.ts create` and `discard` with
the same flags instead, substituting your harness directory for `.claude`.
Discard sets aside tracked files, non-ignored untracked files, and reviewed
source refs before removing the checkout and branch. To inspect that work later,
run `aidlc engine worktree restore --slug payments`; it creates an isolated
checkout under `.aidlc/restored/` without touching a new live `bolt-7c31e9a0_payments`.
Add `--parked <stamp>` for one saved attempt or bare `--raw` to bypass checkout
conversions. Ignored untracked files are not saved, and `eol/text=auto`
normalization during saving cannot be reversed by restore.

To remove the recovery refs, use `aidlc engine worktree purge --slug payments`,
optionally with `--parked <stamp>` for one attempt or `--older-than <days>` for
attempts strictly older than a nonnegative finite number of days. Age uses the
stamp's UTC timestamp, ignoring its `-N` collision suffix; the two selectors are
mutually exclusive. Purge refuses while a matching restored checkout exists,
including one moved elsewhere. Doctor lists saved attempts informationally with
typed `restore_operation` and `purge_operation` values for the exact slug, stamp,
and repository, followed by `--intent <record-dir-name> --space <space>` to keep
the operation bound to its owning intent even after the active intent changes.
Conductors invoke their `worktree` engine route with each listed
arg exactly as argv, never joined into a shell command. Optional
`restore_command` and `purge_command` are safe human display text; rendering
failures omit the corresponding command and supply `restore_command_error` or
`purge_command_error` while keeping the operation. If only reviewed source refs
remained to save, the attempt is `evidence-only` with `parked_commit: "-"`: no
files can be restored, abort omits `restore_operation`, `restore_hint`,
`restore_hint_error`, and `parked_excludes`, and doctor offers only the purge
operation and its command-or-error fields. See [getting the files back](15-troubleshooting.md#a-bolt-attempt-was-set-aside-getting-the-files-back)
for the recovery walkthrough and [CLI Commands](12-cli-commands.md#aidlc-engine-worktree-purge-remove-recovery-refs)
for the flags.

Creation refuses an intent without a registry UUID; adopt or re-create that
intent before Construction. Cleanup also refuses when the Bolt branch is
checked out at another worktree path and names that owner instead of deleting
its branch or retained/parked refs. Pre-upgrade legacy `bolt-<slug>` Bolts can
merge, discard, and purge to completion only with matching intent provenance;
new Bolts never use that shape. `doctor` reports both shapes.

Normal scoped `next`, lifecycle, review, and gate work is offline-first. Network
access is confined to explicit claim, share, publish, status, pin, and merge-ref
verification operations, and to the board on a checkout that holds no Unit
claim: each `/aidlc` there in team mode fetches the teams' claim refs, and only
those, from the shared remote (best effort, a few seconds at most, no prompt;
when the remote does not answer, the board says once that it shows what this
clone last saw).

### Claim, build, and publish

#### 1. Claim

In a team's own clone of the shared remote, `/aidlc` offers the Units open to
take, once for each set of open Units: "2 Units are open for a team to take:
payments and refunds; billing is with Billing team. Take one for your team? I'd
label your team "Alice"; say another name to use it instead." Each
choice says what waits on that Unit ("invoicing waits on it"). Picking one
claims it for your team under that label, your git user name, or under the name
you give with your pick; **Not now** shows the board. A clone
that ran the work itself (the lead's own checkout) is not asked. The
participant marker still marks a clone for the picker by hand
(`aidlc unit participate`), and a claim can be typed directly:

```bash
aidlc unit claim payments --team "Payments team"
```

Exactly one concurrent claimant wins. The command stamps the checkout with
space, intent, Unit, generation, nonce, and gate rhythm. A checkout whose own
audit shard is already on main (the lead's own checkout, or a copy of it) keeps
the Unit's evidence in a new shard of the claim's own, so it publishes and pins
like a fresh clone.

To hand the same attempt to a teammate on another machine, push the claim ref.
The teammate fetches and checks out the exact local `claim/<intent-id8>/<unit>`
branch, then runs:

```bash
aidlc unit adopt payments
```

Adoption verifies the checked-out payload against the live ref and keeps the
claim's bound audit shard, so the teammate can resume and publish without
creating a successor attempt.

#### 2. Build

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

When the Unit is complete and approved, `/aidlc` asks once whether to commit it
and publish it for review on main. **Commit and publish** runs
`aidlc unit publish payments --commit`, which commits the Unit's own work (every
tracked change, the record under `aidlc/` and the new files its source manifest
lists; the question names how many files and up to ten new ones, as the share
question does) and then publishes. Other new files, such as AI-DLC's own install
or an unignored `node_modules`, stay on disk uncommitted, and the publish says
once how many it left out; say which you want in and it publishes again with
them (`--include <path>`). **Not now** leaves it, and the step then says it is
not published yet, so asking for it later publishes it. Publication requires a clean tracked checkout;
AI-DLC's own part of `.gitignore`, `AGENTS.md` and `opencode.json`, which it
writes when a session starts in a fresh clone, does not count. By hand:

```bash
git add -A
git commit -m "Complete payments Unit"
aidlc unit publish payments
```

`publish` creates a candidate commit whose tree is the team's committed work and
whose parents bind both the claim history and the implementation history. It
CAS-updates the claim ref. Publication is not integration. The candidate carries
the claim's audit shard with the rows pin accepts and the review records its
receipts name (AI-DLC keeps those out of commits), and every other audit shard
and the stages' shared diaries as main has them; what is left out stays in the
checkout's own history, and publish says how many rows. A change to any other
record outside the Unit's `construction/<unit>/` folder (an Inception artifact
such as `contract-summary.md`) is published too, but pin will refuse it, so
publish names the file: take it out of the branch, make the change on main,
and publish again. Pin and land refuse it too, and say to do that in the
checkout where the Unit is claimed.

### Pin, gate, and land

All merge commands run from unscoped main, or from any checkout of the project
that holds no Unit claim.

#### 1. Pin the candidate

On such a checkout `/aidlc` reads the teams' claims from the shared remote
(above), so when a team has published its Unit the next `/aidlc` asks, once for
each published commit: "payments is ready from Payments team: review and merge
it?" **Review and merge payments** runs `aidlc unit pin payments`, which fetches
what it needs itself; the merge gate below follows in the same turn. **Not
now** leaves a line on the board. Typed:

```bash
aidlc unit pin payments
```

Pinning records one exact candidate OID and attempt generation. Evidence is read
with git object plumbing, not by merging or creating a worktree:

- required Unit artifacts;
- `UNIT_COMPLETED` receipts for active stages;
- team gate approvals at the claim rhythm;
- each required review's `READY` verdict, or the team's approval of the stage
  after a review that stayed `NOT-READY`, accepting its open findings (an
  approval that asked for a finding to be fixed waits for the next review). The
  evidence's `reviewers_ready` holds only stages approved with nothing open;
  `reviewers_approved_over_concerns` names every stage approved with a finding
  open, under either verdict, with each finding's id, severity and what the
  approval recorded for it;
- Plan Approval fingerprint and explicit approval;
- the candidate state row;
- the transportable team audit shard.

**Trust model.** The claim-bound team shard may carry that team's own
attempt-keyed `UNIT_COMPLETED`, team-gate, and reviewer receipts. Those rows are
team assertions: pin re-verifies required artifacts and fingerprints, and the
human reviews the remaining trust at the pinned merge gate. A team shard may
never carry `HUMAN_TURN`, `MERGE_DISPATCH_*`, `UNIT_MERGED`, a unit-merge gate,
another Unit's receipt, or another/new audit shard. A claimed checkout writes
only the rows pin accepts to the claim's shard; everything else it records
(sessions, turns, answers) stays in its local record under the intent record's
`.aidlc-engine/audit/`, out of every commit, so the claimant's pull after the
landing keeps every row. Pin and land also refuse
workflow-record changes outside the claimed Unit subtree. Product-source paths
outside the Unit's record tree remain visible in the gate evidence for human
overlap judgment, and so does a rule the team kept while working the Unit (the
space's `memory/project.md` or `memory/team.md`), which lands on main with the
Unit. Like any shared file, a rules file main changed since the claim (another
Unit's kept rule landed first) stops the land: rebase onto main, publish again,
and pin again.

If the claim is released/re-claimed, or the ref moves after pinning, the gate
and landing commands refuse. Run `pin` again and review the new OID explicitly.
If the registry cannot be reached, gate and land fail closed because they
cannot prove the pin was not tombstoned.

#### 2. Present the merge gate

Pin's output carries the merge gate (`merge_gate`): the question, its strategy
and target, and the command that records each answer. The agent asks it in the
pin's own turn, once. A pinned Unit lands with a regular merge (strategy
`merge`) into the integration branch pin fetched, so the reviewed OID is a
direct parent; that is not put to the person as a choice, and the team's merge
default (squash in the shipped `org.md`) holds for every other merge. The
person's reply after the pin is the answer the gate records.

The integration lead presents the evidence summary and pinned OID to the human,
then records their answer: their reply goes in the file pin's gate commands name,
written with the agent's file tool so no shell reads it, and the gate reads it
from there:

```bash
aidlc unit gate payments \
  --decision approve \
  --request-file aidlc/.aidlc-engine/request-text/gate-payments.txt
```

An approval's output names the land command, run in the same turn with no
further question. A rejection keeps the candidate unmerged. A candidate carrying
`Merge-Held: true` is refused until the team resolves the HOLD-MERGE sequence,
publishes again, and main re-pins.

#### 3. Land

```bash
aidlc unit land payments --target main
```

Landing is ordered and resumable:

1. **Git content first.** Re-fetch the integration branch and verify that the
   approved Unit's entry in the Unit DAG, its kind, the active stage columns,
   and the evidence are still current, then merge the pinned OID. Contract
   drift refuses before mutation and requires rebase, republish, re-pin, and a
   new merge gate. Main's
   `aidlc-state.md`, runtime graph, cursors, and engine markers are retained; the team's new
   audit shard and per-Unit artifacts/source land. Real source conflicts abort
   back to a clean checkout and list the files. A clean automatic merge of a
   shared file is also refused when its result differs from the pinned candidate;
   rebase and republish. No Unit row has been folded. A Unit lands only after
   every Unit it depends on has landed.
2. **State fold.** Under the per-intent lock, derive the candidate's transported
   receipts, write the merged Unit row while preserving main's singletons and
   other rows, then emit `UNIT_MERGED`.
3. **Audit/finalize.** Commit the main state and merge lifecycle rows, then mark
   the local transaction complete.

Once the checkout that claimed the Unit pulls the landed main, it is no longer
held to that Unit: its record shows the Unit merged and its history holds the
merged claim, so `/aidlc`, pin and a next claim work there as on main.

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

Other teams and future claim checks observe the new integration state once the
landed target branch is pushed. When the remote does not have the landed commit
yet, the land's output names the next step, and that step asks once: "Push main
to origin now so the other teams see payments landed?" **Push main** runs
`aidlc unit share` (a plain push); **Not now** leaves a line on the board. By
hand:

```bash
git push origin main
```

Dependents become claimable from the merged row. After the last row merges,
the per-Unit block settles and main routes Build and Test (3.6), then CI
Pipeline (3.7), exactly as solo Construction does.

### Dispatcher, status, and health checks

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
`aidlc unit land` recovery command, each Unit a team published that waits for
review there, and a landing the remote does not have yet. A participant with no currently claimable
Unit receives this terminal board instead of falling into main's solo walk.
Released claim history alone does not keep fan-out active: when no live claim
and no incomplete merge transaction remains, main resumes the normal
Construction walk.

When a fresh clone has several intents and no active-intent cursor, the picker
annotates a mixed team workspace with statuses such as `team construction, 2
units claimable` and `parked at code-generation`. Finished intents are left out
of the picker in every workspace, because they have nothing left to carry on;
`/aidlc intent list` still shows them. Every other piece of work is listed with
where it stands (`at Requirements Analysis`). A bare `/aidlc` or `/aidlc --resume` there always asks; it
never answers that there is no work.

`/aidlc --doctor` adds local-only claim reconciliation:

- a released/superseded attempt whose checkout stamp still lingers is a
  fix-required stale-stamp finding;
- a live claim with a known observation timestamp but no observed ref movement
  for 24 hours is an anomaly; release remains an explicit human decision;
- a pre-upgrade cache with no observation timestamp receives a baseline
  advisory rather than a false inactivity finding;
- claim refs whose intent id no longer exists locally are orphan findings.

Doctor never fetches or releases a claim.

### Release, salvage, and resume

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

## Teams across repos

Where the work records code repos of its own, choosing **Several teams**
records `Home Location`, and each team builds its Unit as a piece of work of
its own. Each team needs to reach the lead's project's repository with its own login.

### The three layouts

- **One workspace for everyone.** Each team member clones the lead's
  workspace. The Units are offered there, and each team's build lives in its
  own space (`aidlc/spaces/<team>/`) of the same repository.
- **A workspace per team.** A team makes its own workspace repository, from the
  lead's (the lead's record comes along, read only, and is never offered to
  carry on) or with nothing of the lead's in it, where a team member says once
  where the lead's project is
  ([Take a Unit by the lead's address](#take-a-unit-by-the-leads-address)). Its
  Units are reached at the lead's project's address.
- **A personal copy.** One person clones their own copy; it works as one of
  the two above, by where its `origin` points.

The
code repos can live anywhere on disk: `repos.json` gives each one's path, and
one person's `repos.local.json` their own
([Declaring the repo set](03-spaces-and-intents.md#declaring-the-repo-set-optional-manifest)).

### Take a Unit as your team's own work

When the lead's project records `Home Location`, each team builds its Unit as a piece of
work of its own, in its own workspace and under its own rules. A team member
runs `/aidlc` in their workspace with no work of their own selected there, and
AI-DLC offers the Units their team can take, from what the workspace already
has (the lead's plan and the claims git last brought in). Where the lead has
practices they agreed (their `team.md`) or project rules of their own (their
`project.md`) beyond the template's notes, the same question says so once: each
**Start <unit>** follows the lead's practices too (or project rules, or
both, named by their headings in its detail), the recommended way, which loads
each of those files where it is, read only, just before the team's own file of
the same name, so the team's are on top. One more choice takes a Unit under the
team's own rules only: **Start <unit> under your team's own rules only** when
one Unit is offered, else **Start one under your team's own rules only**, which
asks which Unit. In a clone where the team's own build is finished or pushed, its
`/aidlc` or words about the team's other Units put the Units it can start first,
once in a chat, never "everything is done" or a new piece of work. At the lead's
project, the learnings question's first choice
reads **Yes, for this project, and offered to any team that takes a Unit**.

- **A clone of the lead's own workspace**: the lead's work is here too, and its
  Units are offered to take. **Carry on <work> here, as the lead** is offered
  only in the checkout that made the plan (or a copy of that folder), once in a
  chat when nothing is ready to take; a teammate's clone never offers it,
  whatever its git name, and hears where things stand. Even with the lead's
  work picked there, the lead's own questions (a sign-off, a team's proposed
  change) are not put in such a clone. The lead in a fresh clone
  on another machine says so in their own words, and AI-DLC records it there
  (`unit lead-here`); from then on that checkout gets the lead's questions.
- **A team's own workspace made from the lead's** (its `origin` is the team's
  repository): the lead's work that git copied in stays the lead's, read only,
  and is never offered to carry on. Its Units are, and taking one reaches the
  home by the address `Home Location` records, with your own login and hooks.
  No remote is added.
- **A personal copy** works as one of the two, by where its `origin` points.

A take builds the Unit in the space you are working in: your team's space
(made once with `/aidlc space-create <team>`, then `/aidlc space <team>`), or the
default space; a space you ask for by name at the take is made then. Every Unit nobody has
taken is offered, once each. A Unit that waits on another is listed as waiting
until that Unit is done at the lead's project, and a Unit already being built is
listed with who took it and where (a build in a default space by who took it
alone), or as being built at the lead's project. AI-DLC reads the lead's project's claims as the
lead's project has them now, once per chat and at each look while nothing is ready, so
nobody has to fetch.

Picking one runs `aidlc unit take <unit> --home <record>`. Its claim at the
lead's project is the take: the first take wins, and anyone after it is told who
has it ("refunds is already taken: bea builds it in the pay space."). Then it
starts the Unit's build: a new piece of work in the space you are in, named after the Unit, running the Unit's planned Construction stages
from a copy of what the lead approved. The copy is what the lead's Ideation
and Inception stages wrote (the mockups and the Unit plan among them), at the
paths the lead's project holds them, listed with their fingerprints in
`approved-inputs.md`; the lead's Reverse Engineering and Practices Discovery
notes stay theirs. The build records the lead's repos, cloned here or not
yet. The lead's Inception shows as done there and does not run again, and its
approvals stay the lead's. Your team approves its Unit the way the lead's
work does: after every stage, or once at its end.

- Taking a Unit you took before, from any clone of your workspace and on any
  computer (by your git `user.name`, or the email of the commit that made your
  take), carries its build on (**Carry on <unit>**), with whether it was last
  worked on this computer or another. Someone else's build is listed as being
  built, by whom and where, and never offered; when you ask for it in your own
  words it is carried on, and the take says once whose build it is. A pushed
  build is listed as waiting for its merge, and as merged once every one of its
  repos has it (the lead's project records the merge at its next look). One the
  lead turns down or sends back from the lead's Build and Test is offered again,
  with those words, to the one who took it.
- A lead's project you can read but not push to: the take goes on and the build
  starts, and one line, said once, gives git's reason and says the lead and the
  other teams cannot see your take until a push goes through; AI-DLC records it
  there then, with nothing more said. A take someone else's claim beat there is
  said once, and your build stays for you to agree who carries it on. An early
  start waits for that: it says git's reason and the way on, ask the lead for
  push access to it, then take the Unit again.
- The lead's project out of reach at its recorded address, before any Unit is
  taken, while your clone's own remote holds the lead's plan (the same repo by
  another spelling, ssh beside the lead's https): the first take is recorded at
  your clone's remote, and says so once.
- A repo the lead's work records that your workspace has no checkout of is
  said once, with where to clone it or how to give its path in
  `aidlc/repos.local.json`. When `repos.json` has its address, the build's first step
  asks instead, once: "billing is not at ../billing yet, where repos.json puts
  it. Do you want me to clone it there?" On your yes it is cloned there with your own git, and its
  files are nobody's change at the Unit's gates. While your own
  `repos.local.json` cannot be read, the take says what is wrong with it and
  offers no clone, since your copy may be where that file puts it.

Each build keeps its entry in its own record folder (`aidlc-intent.json`), not in
the space's `intents.json`, so two people who take two Units in one space share
no file and their pulls never conflict.

### Take a Unit by the lead's address

A team can keep a workspace repository of its own that holds nothing of the
lead's. A team member says where the lead's project is, once, in their own
words ("the lead's plan is in the shop workspace at
git@example.com:shop/shop-ws.git, take our Unit"), and AI-DLC offers the Units
their team can take there, as a clone of the lead's workspace offers them.
AI-DLC reads the lead's branch with your own login into a git ref of its own:
no folder of the lead's and no remote are added.

- Taking one writes its claim at the lead's project and starts its build in your
  active space (the default space, unless you switched).
- Nobody says the address again: each later step reads the lead's project from
  the build, and once your Unit is pushed or done, `/aidlc` or "what's ours to
  build?" offers your team's next Unit there. A teammate's clone of your
  workspace carries the build on the same way.
- A repo the Unit needs that your workspace does not list yet is offered from
  the lead's repo list, with its address: "billing is not here yet; the lead's
  list has it at <address>. Do you want me to clone it here?" On your yes it is
  cloned and added to your workspace's own list.
- Following the lead's rules too reads the lead's practices and project
  rules where they are, in the lead's project, before your team's own; nothing
  is copied, and a change the lead pushes applies once AI-DLC next looks at the
  lead's project (in a new chat, or at your build's next stage). When they
  cannot be read (the lead's project cannot be reached on a first look), the
  step goes on under your team's own rules and says so once.
- In a clone of the lead's own workspace, saying the address changes nothing:
  the Units are read from what is here.

### Push your Unit, and merge it your way

When your Unit's last stage is approved, AI-DLC offers the push: "Refunds is
built and you approved it. It changed checkout-api and billing. Commit its
changes on branch refunds in each and push them?" **Push** runs
`aidlc unit push`. In each repo it puts you on a branch named after the Unit,
as your own hands would: started from the shared integration branch, fetched,
when your working tree allows, else from where you are (and the line names any
of your unpushed commits that come along). Then it commits exactly the files the
Unit's Code Generation recorded writing (its `source-manifest.json`) with your
own git, so your hooks, signing and identity run as usual; in a file you had
changed yourself, only the Unit's change is committed. Your other uncommitted
work comes along uncommitted and is never committed. Every repo is committed
before the first push, so a hook that stops one pushes nothing. Each repo's push
goes to the remote git would push it to; with several remotes and none set, the
offer names each. The line says where you are and the way back ("You're on
refunds now in checkout-api and billing. Switch back to main any time."). A
later push from the branch you went back to takes the Unit's files Code
Generation changed there onto its branch as they are; when changes of your own
are in the way, it stops with git's words, nothing moves, and the push is
offered again once they are committed or put aside. A push the host refuses is
said once, in its own words, and nothing retries.
**Not now** pushes nothing; the end of the build says once that the Unit is not
pushed yet. A repo the Unit changed that the lead's plan did not list is added
to the build's repos and goes with the push, said once. When the code went but
the lead's project did not take the result, the next step offers to send it again.

Open a pull request in each repo your usual way and merge it the way that repo
merges: a merge commit, a squash or a rebase. The push also sends the result
back on the Unit's claim: in each repo the branch, every head pushed and each
changed file's blob, and the Unit outputs the lead's project's later stages read (Code
Generation's summary and test instructions). A review fix pushed later goes
back the same way.

At the lead's project, while teams build, AI-DLC fetches the work's claims from the
lead's project's remote once per chat, after your messages while a team is building
or a Unit waits for someone to take it,
and at each step that shows or acts on them, and
checks every pushed Unit's repos against their integration branch, with the
lead's own login and never a password prompt, then shows the board (when a
remote cannot be reached, one line says the board may be behind):

```text
Units of checkout-revamp:
- refunds, payments space: built by bea, checkout-api merged, billing not merged yet (1 of 2 merged)
- checkout-ui, web space: building, taken by sam
- reporting, here: waits on refunds
```

Each take's row names the space its build is in (a take in a default space has
no space named), and a pushed or done one says who built it.

A Unit the lead's project builds itself reads where its Unit Progress has it:
done once it is through its gate, the stage it is at, waiting for your
approval while its gate is open, or not started yet. A look at the board on its
own (`/aidlc team-board`) records nothing: a Unit whose repos it sees merged reads
"not recorded yet", and the next step at the lead's project records it and opens
the Units waiting on it; with no Unit of its own to build, that step starts
nothing. While the lead's project builds nothing, `/aidlc --status` says so: its
Current Stage reads "none here: the Units left are taken or open to take
(below)", its Status "Waiting on the Units below", and it names no agent or next
stage.

A Unit is done when every repo it changed has merged, however it merged (when a
repo merged it in a way the board cannot see, tell the lead's chat and
AI-DLC runs `aidlc unit merged <unit> --repo <repo>` with your words): the
lead's project records `UNIT_MERGED`, writes the Unit's outputs into its record where
Build and Test reads them, and marks the claim done, so the Units waiting on it
open for the lead's project and for every team. A merge the lead's project sees is the one thing it
writes for the teams, and the board says it once, naming who took it: "I've told
bea refunds is merged." Another clone or machine of the lead's project reads a Unit done on its claim
as done too. A repo the lead's project has no checkout of stays
"not merged yet" there. To send a repo back, the lead says so at the lead's project and
AI-DLC runs `aidlc unit turned-down <unit> --repo <repo>` with their words; the
team hears them once at its next step, and its build, finished until then, is
open again: AI-DLC asks once whether to take the Unit back to Code Generation so
the team can change it and push it again, which it recommends, and runs the way
back when they say yes. Once the redo's Code Generation is approved, the end of
the build offers the push again. What already merged stays merged. A team whose
chat is on another of its builds hears it there too, once, with how to go back
to that build. When the lead's Build and Test finds a Unit a team built
wanting, its retry sends the Unit back to the team in the failure's own words
(`aidlc unit send-back <unit>`): it is never rebuilt at the lead's project, the
board shows it back with the team, and its next merge is recorded again.

### Check in your team's record

What AI-DLC records about the work (the plan, each team's build, the approvals
and the audit trail) lives in `aidlc/`, and the people on the workspace get it
the way they get any change: each person commits and pushes it. Commit
`aidlc/` (the repo list, `aidlc/repos.json`, is in it) and, when the team keeps
one, `aidlc.settings.json` at the workspace root. Tool folders (`.claude/`,
`.codex/`, `.kiro/` and the other tools' folders) are not committed: each person
runs `aidlc config` in their own clone for the tool they use.

AI-DLC says so once at each stopping point of teams' work: when you stop for
now, when your Unit is pushed, when you say **Not now** to its push, and at the
lead's project when Build and Test is approved: "Your teammates see where this
work stands once aidlc/ is committed and pushed." It
never goes by what git shows changed, since AI-DLC's own record changes at every
step. Asked where things stand (`/aidlc --status`), a clone also says what its
last `git pull` that brought changes brought from the other teams, for example
"From others: checkout-ui in web (at your last pull that brought changes)".

### Start early, and change a shared input

A Unit opens once the Units it waits on are done. When a Unit it waits on has
pushed its branches, the offer also has **Start reporting early**: the build
starts on that pushed branch in each repo it changed (checked out where you
have no uncommitted work there; otherwise the branch is made and the line says
to switch when you are ready), and the line says it may still change before it
merges. Once that Unit is merged, AI-DLC asks once whether to move your build
onto the branch it merged into (only your build's own commits move, with your
own git; a build you already pushed then needs a force push of your own, which
AI-DLC never does). The line says where you are afterwards and the way back to
your branch; a conflict stops with git's words and the way back, and a move your
own changes kept git from making is offered again once they are out of the way. You
hear once when that Unit is turned down, and nothing else changes.

A team that needs a change to something its Unit was approved with (a contract
summary, the requirements) edits its copy or writes the new text. When its copy
changed, its build asks once whether to send the change to the lead's project for its
owner to approve; AI-DLC runs `aidlc unit propose --input <file>` and the team
carries on while the lead decides. At the lead's project the owner of the shared plan is
asked once, with the path of the team's version to read: **Approve it**,
**Not now** or **Turn it down**, answered in their own words; after **Not now**
the board keeps the same choice.
An approved change is written into the lead's record, and the stages there
that used it stay current, so nothing at the lead's project is asked again. Every team
whose Unit's stages read it gets the new version on its claim (a Unit's build
fetches its claim from the lead's project once per chat, and when it takes or pushes) and
hears it once, on every Guard Policy; a team that pushed already hears it as a
fact, and the others hear the offer to redo a stage that used it:
"Something Functional Design used changed after it finished. I'm carrying on
with it as it is. Do you want me to redo Functional Design with the change?"
A team that edited its own copy and never sent that edit to the lead keeps its copy as
it left it: the new version is put beside it (`<file>.from-lead.md`), said once,
and when its result comes to the lead's project the lead hears once that the team's copy has its
own edit, made on the version before the change.
A team whose Unit was
already done and merged hears once that the input changed and the Unit is done,
with an offer to start follow-up work; the done Unit is never reopened. A
change turned down reaches the team that proposed it once, with the owner's
words.

---

## A second person on solo work, and the lead's sign-off

Solo work built one Unit at a time on one machine can still take a teammate,
whichever layout its code is in: a Unit they take is built as work of their
own, as [across repos](#teams-across-repos).
When they open it in their own clone (a bare `/aidlc` or their own words,
once in a chat, also after their words picked the work), AI-DLC says it is
being built from another machine, on which Unit and stage while one is under
way, and offers three things: **Carry on**
the whole work here (for when the other person has stopped; today's pickup),
**Take** an open Unit as their own (never the one the other machine is on), or
**Follow along** (where it stands, read only). The same person opening their
own work on a second machine (the same git `user.email`, else `user.name`, as
the one who committed the other machine's audit) is not asked: the work carries
on there as before. Taking one writes its
claim at the workspace's `origin` and starts its build in the same space, in a
folder of its own; the teammate's clone never writes the work's own state. At
its next step, the lead's session switches to teams by itself: the workspace's
`origin` becomes the lead's project, the approvals stay as they were (once per Unit at
its checkpoint, or after every stage), and the teammate's build approves the
same way; the Units it already built and approved stay done there, one whose
approval was still open is put to the lead there once, for the whole Unit, and
it says in one line who took which Unit. Nothing is asked again. The lead's project looks for a teammate's
take once its Units are being built: once when a chat starts, and once at each
boundary between Units, however many steps that takes, so the lead never fetches
for it and never starts a Unit a teammate took; once every Unit is built there,
it no longer looks. Each look takes a few seconds at
most, and nothing is said when the remote cannot be reached. The board names each
teammate by their own git name.

The lead's sign-off is off by default. With `aidlc unit lead-sign-off on` at
the lead's project, a team's result waits for the lead's own word: the lead's project asks once
as the result arrives ("refunds came back from bea: ... Sign it off?"),
and the Unit counts as done only once it is signed off and every repo it
changed has merged; the board says "waiting for your sign-off" meanwhile, and
keeps **Sign it off** there after a **Not now**. When solo work switches to
teams because a teammate took a Unit, the one line the lead hears says they can
ask for this; asked in their own words ("I want to sign off Bob's part myself"),
AI-DLC switches it on, and the record keeps their words whole
(`LEAD_SIGN_OFF_SET`).

---

## Two-day workshop walkthrough

### On the workspace's own repo

#### Day 1

1. The facilitator runs Inception with the group.
2. If enabled, the facilitator builds and gates the walking skeleton on main,
   then shares the plan with the teams when asked.
3. Alice takes `billing`; Bob takes `notifications`, each from the question in
   their own clone.
4. Each team runs its scoped 3.1-3.5 chain and team gates.
5. Each team publishes its Unit when asked.

#### Day 2

1. The facilitator's board offers Alice's Unit for review; the facilitator
   reviews its evidence, records the merge gate, and lands it.
2. Main is pushed when asked; any Unit depending on `billing` becomes claimable.
3. The facilitator repeats pin/gate/land for Bob's pinned candidate.
4. When the final row is merged, `/aidlc` on main routes Build and Test, then
   CI Pipeline.
5. The group reviews `UNIT_MERGED`, gate, and reviewer rows in the combined
   audit shards.

The teams never race to push main. Candidate refs can move only through
claim-bound CAS publication; main serializes the reviewed pinned OIDs.

### Across repos

#### Day 1

1. The facilitator runs Inception with the group in the lead's workspace,
   chooses teams, and shares the plan.
2. If enabled, the facilitator builds the walking skeleton at the lead's project first.
3. Each team member clones the workspace (or the team's own), runs
   `aidlc config` there for their own tool, makes their team's space and
   switches to it (`/aidlc space-create <team>`, then `/aidlc space <team>`),
   then `/aidlc`, and takes a Unit that is ready. Each team approves its own
   stages, and checks in `aidlc/` when AI-DLC says so.

#### Day 2

1. Each team finishes its Unit, says push, and opens a pull request in each
   repo; reviewers merge them the way each repo merges.
2. At the lead's project, `/aidlc` shows the board: how far each Unit merged, which are
   building, which wait. A Unit that waits on another opens when that one is
   done, or starts early on its pushed branches.
3. When every Unit is done, `/aidlc` at the lead's project runs Build and Test, then CI
   Pipeline.
4. The group reads `UNIT_TAKEN_IN`, `UNIT_PUSHED` and `UNIT_MERGED` in the
   audit trail: who took, built and merged what.

---

## Related reading

- [Facilitator Guide](facilitator-guide.md) - readiness check, scopes for side tasks, recovery playbook, and how strongly each harness enforces the workflow
- [CLI Commands](12-cli-commands.md) - assign, take, push, propose, amend and sign-off across repos; claim, publish, pin, gate, and land on the workspace's own repo
- [State and Audit](10-state-and-audit.md) - per-clone shards and merged receipt floors
- [Construction](../reference/04-stages/construction.md) - Unit-major routing and gate rhythm
- [Runtime Graph](../reference/13-runtime-graph.md) - the separate solo/swarm Bolt merge path
- [Branching Strategies](../../core/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md) - merge-dispatch strategy selection
