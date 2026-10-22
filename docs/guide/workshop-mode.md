# Multi-Team Construction and Workshop Mode

Several teams can build the Units of one approved piece of work. The work's
home is where Inception ran. Each team builds its Unit as a piece of work of
its own, in its own workspace and under its own rules, from a copy of what the
home approved, and merges it into each repo the way that repo always merges.
The home sees a Unit done when every repo it changed has merged, and runs Build
and Test once every Unit is in. Workshop mode is one use of this; it works the
same for any scope whose plan splits the work into Units.

What it needs:

- a Unit plan with two or more Units, built one Unit at a time
  (`Construction Iteration: unit-major`), which choosing teams sets;
- the workspace in git: its `origin` is where the Units are given out
  (`Home Location`);
- each team able to reach the home's repository with its own login, or a
  hand-off file when it cannot.

For the Workshop scope's stage grid and Minimal test floor, see
[Scopes and Depth](05-scopes-and-depth.md#workshop).

---

## The three layouts

- **One workspace for everyone.** Each team member clones the home's
  workspace. The Units are offered there, and each team's build lives in its
  own space (`aidlc/spaces/<team>/`) of the same repository.
- **A workspace per team.** A team makes its own workspace repository from the
  home's. The home's record comes along, read only, and is never offered to
  carry on; its Units are reached at the home's address.
- **A personal copy.** One person clones their own copy; it works as one of
  the two above, by where its `origin` points.

A team that cannot reach the home at all works from files instead
([A team that cannot reach the home](#a-team-that-cannot-reach-the-home)). The
code repos can live anywhere on disk: `repos.json` gives each one's path, and
one person's `repos.local.json` their own
([Declaring the repo set](03-spaces-and-intents.md#declaring-the-repo-set-optional-manifest)). In
a workspace that is not a git repository, work with a recorded repo set is
built by one session: when Construction starts, AI-DLC says in one line that
the workspace needs to be in git for teams, and `set-unit-ownership team`
refuses with the same line before changing state.

Team work that started before `Home Location` existed keeps the claim,
publish, pin, gate and land flow, described in
[Team work started before Home Location](#team-work-started-before-home-location).

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
the first team step offers it.

When the workspace is a Git repository, choosing **Several teams** also records
where the home of the work is: `Home Location` in the state, the address the
workspace's own remote points to (read, never changed; a user or token in the
address is left out), or `local` when it has no remote. The next step asks once
who builds which Unit (after you speak without naming teams, it offers the same
choice and builds nothing meanwhile), naming each Unit with its
likely repos and the Units it waits on. Answer in your own words, for example
"refunds: payments, checkout-ui: web, leave reporting open": each Unit you name
is held for that team, a Unit you leave out stays open for
any team, and a Unit a team already holds stays with that team. **Leave them all
open** holds none. Your checkout stays the home's, never scoped to one Unit. The
home then builds only the Units no team holds, skipping a Unit that waits on one
a team still builds, and shows the board while a team still builds a Unit. Team
work started before `Home Location` existed keeps the claim, publish, pin, gate
and land flow below.

When the scope records `skeleton: on`, the first DAG Unit is the walking
skeleton. It runs on unscoped main before claims open and needs no merge-back
gate; claims open once its Unit Progress row on the pushed main is complete.
With `skeleton: off`, or `Skeleton Stance: off` recorded in the work's state,
dependency-ready Units open immediately.

Publish the approved Inception state and artifacts before teams claim:

```bash
git push origin main
```

Claims open by dependency batch. "Delivery planning is complete" does not mean
every Unit is claimable; a Unit remains blocked until every `depends_on` row is
merged.

---

## Take a Unit as your team's own work

When the home records `Home Location`, each team builds its Unit as a piece of
work of its own, in its own workspace and under its own rules. A team member
runs `/aidlc` in their workspace with no work of their own selected there, and
AI-DLC offers the Units their team can take, from what the workspace already
has (the home's plan and the claims git last brought in):

- **A clone of the home's own workspace**: the home's work is here too, and its
  Units are offered beside **Carry on <work> here, as its home**, for the lead
  on another machine; with nothing ready to take, carrying it on is still
  offered, once in a chat, to whoever wrote the home's work last (a teammate
  hears where things stand).
- **A team's own workspace made from the home's** (its `origin` is the team's
  repository): the home's work that git copied in stays the home's, read only,
  and is never offered to carry on. Its Units are, and taking one reaches the
  home by the address `Home Location` records, with your own login and hooks.
  No remote is added.
- **A personal copy** works as one of the two, by where its `origin` points.

Your team is your active space (`/aidlc space switch <team>`). In the default
space every Unit nobody has taken is offered, with the team it is held for; an
open one is offered for each team the lead named, or for another team you name.
A Unit that waits on another is listed as waiting until that Unit is done at the
home, and a Unit already being built (by a teammate, or at the home) or held for
another team is listed with where it is. AI-DLC reads the home's claims as the
home has them now, once per chat and at each look while nothing is ready, so
nobody has to fetch.

Picking one runs `aidlc unit take <unit> --home <record>`. It holds the Unit at
the home for your team: one held for your team becomes yours, and an open one
is held for the team you named. Then it starts the Unit's build: a new piece of work in your team's
space, named after the Unit, running the Unit's planned Construction stages
from a copy of what the home approved. The copy is the home's Inception outputs
at the paths those stages read them, listed with their fingerprints in
`approved-inputs.md`. The build records the home's repos, cloned here or not
yet. The home's Inception shows as done there and does not run again, and its
approvals stay the home's. Your team approves its Unit the way the home's
work does: after every stage, or once at its end.

- A Unit another team holds, or that a teammate already took, is not taken
  again; the line names who holds it.
- Taking a Unit you took before, from any clone of your workspace, carries its
  build on (**Carry on <unit>**).
- A home you can read but not push to: a Unit held for your team is still
  yours, and its result goes back as a file, said once; once the home takes
  your pushes, the push sends it by git instead. An open Unit there cannot be
  held from your side: the lead holds it for your team at the home.
- A repo the home's work records that your workspace has no checkout of is
  said once, with where to clone it or how to give its path in
  `repos.local.json`.

Each build keeps its entry in its own record folder (`aidlc-intent.json`), not in
the space's `intents.json`, so two people who take two Units in one space share
no file and their pulls never conflict.

## Push your Unit, and merge it your way

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
pushed yet. A repo the Unit changed that the home's plan did not list is added
to the build's repos and goes with the push, said once. When the code went but
the home did not take the result, the next step offers to send it again.

Open a pull request in each repo your usual way and merge it the way that repo
merges: a merge commit, a squash or a rebase. The push also sends the result
home on the Unit's claim: in each repo the branch, every head pushed and each
changed file's blob, and the Unit outputs the home's later stages read (Code
Generation's summary and test instructions). A review fix pushed later goes
home the same way.

At the home, while teams build, AI-DLC fetches the work's claims from the
home's remote once per chat and at each step that shows or acts on them, and
checks every pushed Unit's repos against their integration branch, with the
lead's own login and never a password prompt, then shows the board (when a
remote cannot be reached, one line says the board may be behind):

```text
Units of checkout-revamp:
- refunds, payments: checkout-api merged, billing not merged yet (1 of 2 merged)
- checkout-ui, web: building, taken by sam
- reporting, here: waits on refunds
```

A Unit is done when every repo it changed has merged, however it merged (when a
repo merged it in a way the board cannot see, tell the lead's chat at the home and
AI-DLC runs `aidlc unit merged <unit> --repo <repo>` with your words): the
home records `UNIT_MERGED`, writes the Unit's outputs into its record where
Build and Test reads them, and marks the claim done, so the Units waiting on it
open for the home and for every team. A merge the home sees is the one thing it
writes for the teams, and the board says it once: "I've told the teams refunds
is merged." Another clone or machine of the home reads a Unit done on its claim
as done too. A repo the home has no checkout of stays
"not merged yet" there. To send a repo back, the lead says so at the home and
AI-DLC runs `aidlc unit turned-down <unit> --repo <repo>` with their words; the
team hears them once at its next step, and its build, finished until then, is
open again: AI-DLC asks once whether to take the Unit back to Code Generation so
the team can change it and push it again, which it recommends, and runs the way
back when they say yes. Once the redo's Code Generation is approved, the end of
the build offers the push again. What already merged stays merged.

## Start early, and change a shared input

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
changed, its build asks once whether to send the change to the home for its
owner to approve; AI-DLC runs `aidlc unit propose --input <file>` and the team
carries on while the home decides. At the home the owner of the shared plan is
asked once, with the path of the team's version to read: **Approve it**,
**Not now** or **Turn it down**, answered in their own words; after **Not now**
the board keeps the same choice.
An approved change is written into the home's record, and the stages there
that used it stay current, so nothing at the home is asked again. Every team
whose Unit's stages read it gets the new version on its claim (a Unit's build
fetches its claim from the home once per chat, and when it takes or pushes) and
hears it once, on every Guard Policy; a team that pushed already hears it as a
fact, and the others hear the offer to redo a stage that used it:
"Something Functional Design used changed after it finished. I'm carrying on
with it as it is. Do you want me to redo Functional Design with the change?"
A team by file gets a newer hand-off file to take in. A team whose Unit was
already done and merged hears once that the input changed after it was done,
with an offer to start follow-up work; the done Unit is never reopened. A
change turned down reaches the team that proposed it once, with the owner's
words.

## A second person on solo work, and the lead's sign-off

Solo work built one Unit at a time on one machine can still take a teammate.
When they open it in their own clone, AI-DLC says it is being built from
another machine, on which Unit and stage, and offers three things: **Carry on**
the whole work here (for when the other person has stopped; today's pickup),
**Take** an open Unit as their own (never the one the other machine is on), or
**Follow along** (where it stands, read only). The same person opening their
own work on a second machine (the same git `user.email`, else `user.name`, as
the one who committed the other machine's audit) is not asked: the work carries
on there as before. Taking one holds it on its
claim at the workspace's `origin` and starts its build in the same space, in a
folder of its own; the teammate's clone never writes the work's own state. At
its next step, the home's session switches to teams by itself: the workspace's
`origin` becomes the home, the approvals stay as they were (once per Unit at
its checkpoint, or after every stage), and the teammate's build approves the
same way; the Units it already built stay done there, and it says in one line
who took which Unit. Nothing is asked again. The home looks for a teammate's
take once its Units are being built: once per chat, again after each of the
lead's messages, and before it starts its next Unit, so the lead never fetches
for it and never starts a Unit a teammate took. Each look takes a few seconds at
most, and nothing is said when the remote cannot be reached. The board names each
teammate by their own git name.

The lead's sign-off is off by default. With `aidlc unit lead-sign-off on` at
the home, a team's result waits for the lead's own word: the home asks once
as the result arrives ("refunds came back from payments: ... Sign it off?"),
and the Unit counts as done only once it is signed off and every repo it
changed has merged; the board says "waiting for your sign-off" meanwhile, and
keeps **Sign it off** there after a **Not now**.

Team work that started before `Home Location` existed keeps the claim,
publish, pin, gate and land flow described above, unchanged.

## A team that cannot reach the home

A partner team in another company, or behind a locked network, works from
files instead of git. While a Unit is held for a team and not taken yet, the
board offers once to hand it to that team as a file, in case they cannot reach
this workspace; the lead answers in their own words.
The lead says to hand the Unit off ("hand off reporting to the data team");
AI-DLC runs `aidlc unit hand-off reporting --team data`,
holds the Unit for that team, and writes one readable Markdown file,
`aidlc/handoff/<work>-<unit>.md`: the work's id, the Unit, the attempt, the
fingerprints of what it holds at the top, then each document the Unit was
approved with in its own block. It is not signed; send it the way your teams
send files, and anyone can read it before taking it in. The board says
"handed off by file".

The partner takes it in from their own workspace (AI-DLC installed there
first), however they point at it: "take the Unit in this file", `/aidlc
<path>`, or `aidlc unit take --file <path>`; the agent hands AI-DLC the file's
exact path. AI-DLC offers to start it, then creates the Unit's build exactly as
for a Unit taken by git, under the partner's own rules; Ideation and Inception
do not run again. A file changed after the lead wrote it is taken in as it is,
and the line says so; an editor that only reformatted it changes nothing.

While they build, the partner may send a progress file whenever they like
(`aidlc unit progress`); nobody has to. When they push, the result goes into a
result file instead of the claim: "The result file is
aidlc/handoff/<work>-<unit>-result.md; send it to the lead." For each repo the
lead cannot fetch, the file carries the partner's own check of whether it
merged; push again after merging to send an updated one. The lead takes either
file in by giving its path to `/aidlc` (`/aidlc <path>`, or
`aidlc unit take-in <file>`): a result is checked like a pushed
one and brings home only the Unit outputs the home's later stages read (anything
else in it is left out, with a line), a repo the home cannot fetch counts as merged on the partner's word,
recorded as theirs, until the home can check it itself. A file from an earlier
attempt is taken in with a line saying so; a file for other work changes
nothing, and the line says which work it is for. Files are written with LF and
read with CRLF too.

---

## Team work started before Home Location

Work whose teams were chosen before AI-DLC recorded `Home Location` keeps the
flow it started on. The integration lead works from unscoped main; each
delivery team works from a checkout stamped to one claimed Unit and runs that
Unit's exact Construction chain, stages 3.1 through 3.5, in graph order; main
pins, gates and lands each candidate. Main never reruns those stages after
merge because the team's keyed receipts arrive with its audit shard.

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
access is confined to explicit claim, publish, status, pin, and merge-ref
verification operations.

### Claim, build, and publish

#### 1. Claim

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


### Pin, gate, and land

All merge commands run from unscoped main.

#### 1. Pin the candidate

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

#### 2. Present the merge gate

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

#### 3. Land

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
`aidlc unit land` recovery command. A participant with no currently claimable
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

## Two-day workshop walkthrough

### Day 1

1. The facilitator runs Inception with the group in the home's workspace,
   chooses teams, says who builds which Unit ("billing: payments,
   notifications: messaging"), and pushes the home.
2. If enabled, the facilitator builds the walking skeleton at the home first.
3. Each team member clones the workspace (or the team's own), runs `/aidlc`,
   and takes their team's Unit. Each team approves its own stages.

### Day 2

1. Each team finishes its Unit, says push, and opens a pull request in each
   repo; reviewers merge them the way each repo merges.
2. At the home, `/aidlc` shows the board: how far each Unit merged, which are
   building, which wait. A Unit that waits on another opens when that one is
   done, or starts early on its pushed branches.
3. When every Unit is done, `/aidlc` at the home runs Build and Test, then CI
   Pipeline.
4. The group reads `UNIT_TAKEN_IN`, `UNIT_PUSHED` and `UNIT_MERGED` in the
   audit trail: who took, built and merged what.

---

## Related reading

- [Facilitator Guide](facilitator-guide.md) - readiness check, scopes for side tasks, recovery playbook, and how strongly each harness enforces the workflow
- [CLI Commands](12-cli-commands.md) - assign, take, push, hand-off, take-in, propose, amend, sign-off, and the earlier flow's claim, publish, pin, gate, and land
- [State and Audit](10-state-and-audit.md) - per-clone shards and merged receipt floors
- [Construction](../reference/04-stages/construction.md) - Unit-major routing and gate rhythm
- [Runtime Graph](../reference/13-runtime-graph.md) - the separate solo/swarm Bolt merge path
- [Branching Strategies](../../core/knowledge/aidlc-pipeline-deploy-agent/branching-strategies.md) - merge-dispatch strategy selection
