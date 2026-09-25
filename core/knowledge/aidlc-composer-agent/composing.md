# Composing a Workflow Plan

The composer's job is to fit the CEREMONY to the TASK: propose the minimum
viable workflow - the least sufficient EXECUTE set that still produces every
artifact the task's outcome depends on. Both directions of error are real:
skipping a load-bearing stage has a cost someone pays later, and including
overlapping ceremony "just in case" collapses a composed grid back toward the
stock `feature` scope and defeats the point of composing. Every EXECUTE and
every SKIP must be justified against the entropy profile; neither default
caution nor default economy is acceptable.

## How to read a task

- **Score before you select.** Estimate the five entropy components (intent
  ambiguity, structural uncertainty, verification entropy, risk, unresolved
  assumptions) from the task and the structural evidence BEFORE looking at
  any stock scope. The component bands - not keyword vibes - drive which
  stages carry positive expected value.
- **Incremental vs net-new.** A bug fix, a refactor, a security patch, and a
  hardening pass work WITHIN an existing system: they need to understand what
  exists (reverse-engineering on brownfield, or CodeKB evidence where indexed),
  state what "done" means, and change-plus-verify (code-generation,
  build-and-test). They do not need market-research, user-stories, or
  domain-design - those discover and shape a product that already exists.
- **Net-new surface.** A new feature, product, or service needs the discovery
  arc: intent-capture, scope-definition, then the inception design stages in
  proportion to how much NEW structure it introduces.
- **Operational outcome.** Deployment, observability, incident-response, and
  performance stages belong on the plan when the task's DONE lives in an
  environment, not in the repo. A plan that builds but never ships closes no
  operational task.
- **Brownfield vs greenfield changes the WHOLE grid**, not one stage: a
  brownfield feature leans on existing structure and can compress discovery;
  a greenfield feature has nothing to reverse-engineer and everything to
  scope.

## Grid discipline

- Every required consume must have its producer on the EXECUTE set (the
  validator enforces it; in-flight strict mode rejects). Never balance a
  starved input by silently adding the producer - name the addition in the
  rationale so the human sees the plan grow and why.
- Stages are data-coupled, not just ordered: check `consumes`/`produces` in
  the stage graph before cutting anything mid-arc.
- Fold overlapping stages: when two stages both reduce the same component,
  one is a justified stage and the other is a fold candidate. Keep the spine
  (core, verification, and the single load-bearing discovery/design stage for
  a high component); fold framing/discovery stages whose output another
  EXECUTE stage already delivers, and name the un-SKIP trigger.
- For front/report composition, prefer a stock scope when the final proposal's
  validator-computed `nearest_stock` distance is within 2 flips (adopt and
  revalidate the stock grid, then rebuild the summary and decision table from
  that final grid; note the dropped flips at the gate). The earlier mechanical
  screen's distance is advisory and never overrides evidence-driven folds. A
  custom scope is maintenance surface the user owns forever. A human edit to an
  adopted stock grid converts it to custom so the edit has a persistence path.
  When no stock scope fits the final proposal, synthesize - do not force a bad
  match.
- In-flight recomposition never adopts a stock scope. Preserve the running
  workflow's scope, depth, and frozen actions, then return only the strict-
  validated pending delta as exact `changes.skip` / `changes.add` arrays for
  the conductor's `recompose` command.

## Guard Policy

Every proposal names ONE Guard Policy value with a 1-2 sentence rationale
naming the fences it lowers and why an input change after approval should
reopen it, or be recorded and continue. The value decides two things: what
happens when an input changes after the human approved or confirmed something,
and how far the automatic checks stand aside for the agents. `strict` lowers
no fences and reopens that approval; `relaxed`
records the change once, tells the human in one line, continues, and stands the
plan-approval and review-freeze checks aside; `off` does that and stands the
state-transition and reviewer-scope checks aside as well. No value removes a
gate and none of them touches human presence. The conductor still asks every
approval question; the value also decides which fences stop undirected work,
and each pass through a lowered fence records a `GUARD_STOOD_ASIDE` row.

- A matched stock scope carries its own default (`guard_policy:` in the
  scope file; the core defaults are strict on enterprise, security-patch,
  and infra, off on express, and relaxed on the other seven; a plugin scope
  uses its own `guard_policy:`, strict when the line is absent). Adopt it and
  say so.
  No scope file is written for a matched proposal.
- For a custom grid, read the entropy profile the same way the grid was read:
  high risk or verification entropy, regulated work, or several people sharing
  the approvals point to strict; a spike, a fix, or a solo run where every
  changed file would otherwise mean another approval points to relaxed.
  Store the approved custom scope's value as `guard_policy: <value>` in its
  frontmatter.
- In-flight, the running intent's value stays as it is; the human flips it
  from chat, never the composer.
- The human sees the value as its own gate row and can flip it before
  approving a front composition. In-flight, the row is read-only: a
  recompose lands only stage skips and adds, so the proposal names the routes
  (raise or lower by typing `/aidlc --guard-policy <value>`, with `$aidlc` on
  Codex). Changing scope alone never lowers the running policy.
  A memory layer that declares strict wins over any proposal; the
  validator and the intent-create command both refuse a relaxed or off value
  under it.
- Intent creation reads Guard Policy from the scope file; the conductor
  passes `--guard-policy` only for `strict`. A flip to `relaxed` or `off` on
  a matched proposal is an edit: convert it to a custom scope that declares
  `guard_policy: <value>` and create the intent from that scope. The custom
  scope carries the value at creation; no setter runs afterwards.

## Scope settings

The grid decides which stages run; four scope settings decide how much
ceremony runs inside them. Every front/report proposal names all four in its
`scopeSettings` member, in the scope file's own words, with a 1-2 sentence
`scopeSettingsRationale`:

| Setting | Values | What turning it down removes |
|---------|--------|------------------------------|
| `sensors` | `on`, `off` | Automatic sensor runs (claim sources, required sections, upstream coverage, traceability, lint, type check) and their gate checks |
| `learnings` | `on`, `off` | The stage learnings read/write ritual |
| `summary_confirmation` | `on`, `off` | The separate "Looks correct" checkpoint before a stage writes its artifacts |
| `review_cap` | `adversarial`, `advisory`, `none` | `advisory`: each stage review becomes one pass whose findings the human reads at the gate; `none`: no stage reviewer is dispatched in the gated flow |

- A matched stock scope carries its own values. Copy them from its `.md` and
  say so; a missing ceremony line means `on`, a missing `review_cap` means
  `adversarial`. The validator advises when a grid identical to a stock
  scope's carries values that match none of them, so a copying slip surfaces
  before the gate.
- Validate the final grid with the chosen values. The approved scope file
  takes the validator's `scope_settings` echo, so a value the loader would
  reject never reaches it.
- For a custom grid, start from the validator's nearest stock scope and move
  a setting only when the entropy profile gives a reason, the same way a SKIP
  needs one:
  - `sensors`: keep on when verification entropy is MED or higher, the work
    is regulated, or later stages trace back to these artifacts. Off fits a
    throwaway spike or the lightest run, where nobody will check the artifacts
    against their sources.
  - `learnings`: keep on for work in a codebase the team will keep changing.
    Off fits a one-off change where the ritual costs more than it returns.
  - `summary_confirmation`: keep on when intent ambiguity or unresolved
    assumptions are MED or higher; reading the consolidated answers back is
    how a misunderstanding gets caught before generation. Off fits work whose
    answers are already unambiguous.
  - `review_cap`: `adversarial` when risk or verification entropy is HIGH or
    the work is regulated; `advisory` when both are MED or lower and the human
    will read the findings at the gate; `none` only when both are LOW and the
    change is small enough for the human to review directly.
- No value removes a gate, Plan Approval, a required question, human-turn
  authority, or the audit trail. A global kill switch
  (`AIDLC_DISABLE_SENSORS=1`, `AIDLC_DISABLE_LEARNINGS=1`,
  `AIDLC_DISABLE_SUMMARY_CONFIRMATION=1`) still forces its ceremony off
  whatever the scope says.
- The human sees the four values as one gate row and can flip any of them
  before approving. A flip on a matched proposal is an edit: convert it to a
  custom scope that declares the values, the same path a Guard Policy flip
  takes. The approved custom scope stores them in its frontmatter as
  `sensors:`, `learnings:`, `summary_confirmation:`, and `review_cap:`.
- In-flight, the settings are not part of the recompose. When the request is
  to turn one on or off, leave it out of the stage delta and name the
  per-intent switch the human types: `/aidlc --sensors on|off`,
  `--learnings on|off`, `--summary-confirmation on|off`, or
  `--review adversarial|advisory|none` (`$aidlc` on Codex).

## Rationale quality

The gate is only as good as the rationale. For each SKIP write one line a
human can veto: the stage, what it would have produced, and why this task
does not need that artifact (below-threshold component, or the
task/artifact/EXECUTE stage that already covers it). For each EXECUTE name
the component it reduces and that no other EXECUTE stage already delivers
that reduction. "Not needed" is not a rationale; "no new UI surface, so
refined-mockups produces nothing this task consumes" is.
