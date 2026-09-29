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
  human edit to an adopted stock grid converts it to custom so the edit is
  carried to creation. When no stock scope fits the final proposal, synthesize
  - do not force a bad match.
- Neither route writes a scope file. A custom plan runs on the stock scope the
  validator names (`base_scope`) with its stage changes (`plan_changes`) and,
  when that scope runs another depth, the plan's own (`creation_depth`, from
  the `depth` the proposal names), for this piece of work only, so nothing
  piles up in the scope library. The
  person can keep a plan they like: "Approve and save as scope" at the gate, or
  "save this plan as <name>" later, and the engine writes the scope then.
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
  uses its own value, read in the order the scope loader reads it:
  `guard_policy:`, then the retired `change_control:`, then strict when
  neither line is present). Adopt it and say so.
- For a custom grid, read the entropy profile the same way the grid was read:
  high risk or verification entropy, regulated work, or several people sharing
  the approvals point to strict; a spike, a fix, or a solo run where every
  changed file would otherwise mean another approval points to relaxed.
  `validate-grid --custom` picks a `base_scope` whose default is that value
  (any stock scope serves strict), so creation carries it.
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
- Intent creation reads Guard Policy from the scope the plan runs on; the
  conductor passes `--guard-policy` only for `strict`. A flip to `relaxed` or
  `off` on a matched proposal is an edit: convert it to custom and revalidate,
  and the base the validator picks carries the value at creation; no setter
  runs afterwards.

## Scope settings

The grid decides which stages run; five scope settings decide how much
ceremony runs inside them. Every front/report proposal names all five in its
`scopeSettings` member, in the scope file's own words, with a 1-2 sentence
`scopeSettingsRationale`:

| Setting | Values | What turning it down removes |
|---------|--------|------------------------------|
| `sensors` | `on`, `off` | Automatic sensor runs (claim sources, required sections, upstream coverage, traceability, lint, type check) and their gate checks |
| `learnings` | `on`, `off` | The stage learnings read/write ritual |
| `summary_confirmation` | `on`, `off` | The separate "Looks correct" checkpoint before a stage writes its artifacts |
| `plan_approval` | `on`, `off` | The person's approval of each code plan before it is built; off builds the plan as written with one line naming it |
| `review_cap` | `adversarial`, `advisory`, `none` | `advisory`: each stage review becomes one pass whose findings the human reads at the gate; `none`: no stage reviewer is dispatched in the gated flow |

- A matched proposal starts from its stock scope's values (from its `.md`; a
  missing ceremony line means `on`, a missing `review_cap` means
  `adversarial`). A value you or the human change applies to this piece of
  work only, since no scope file is written: the final validate-grid run
  echoes the values that differ from the stock scope the plan runs on as
  `creation_settings`, typed values the conductor turns into creation flags.
  Any value can change, reviews included: a review level set for the piece of
  work replaces its scope's ceiling.
- Validate the final grid with the chosen values and its route (`--matched
  <scope>` or `--custom`); either flag makes the five settings and the Guard
  Policy required, and the validator checks each against the words the scope
  loader accepts.
- For a custom grid, start from the validator's nearest stock scope. Either
  way, move a setting only when the entropy profile gives a reason, the same
  way a SKIP needs one:
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
  - `plan_approval`: keep the value of the scope the plan runs on (the
    matched stock scope, or a custom plan's base scope). Never propose turning
    it off: the validator rejects off where that scope asks, because only the
    person turns plan approval off.
  - `review_cap`: `adversarial` when risk or verification entropy is HIGH or
    the work is regulated; `advisory` when both are MED or lower and the human
    will read the findings at the gate; `none` only when both are LOW and the
    change is small enough for the human to review directly.
- No value removes a gate, a required question, human-turn authority, or the
  audit trail; `plan_approval: off` removes only the plan stop, and a
  memory-held strict Guard Policy keeps it on. A global kill switch
  (`AIDLC_DISABLE_SENSORS=1`, `AIDLC_DISABLE_LEARNINGS=1`,
  `AIDLC_DISABLE_SUMMARY_CONFIRMATION=1`, `AIDLC_DISABLE_PLAN_APPROVAL_GUARD=1`) still forces its ceremony off
  whatever the scope says. The validator names one that forces an `on` value
  off on this machine; mark that value in the gate row, since the scope stores
  `on` but the ceremony will not run until the switch is cleared.
- The human sees the five values as one gate row, and whatever they ask for
  there is done. A change keeps the route and applies to this piece of work;
  only lowering a matched proposal's Guard Policy makes it custom. Plan
  approval keeps the value of the scope the plan runs on: only the person
  turns it off, in their own words once the work has started or by typing
  `/aidlc --plan-approval off`. A plan the person saves as a scope stores the
  values in its frontmatter as `sensors:`, `learnings:`,
  `summary_confirmation:`, `plan_approval:`, and `review_cap:`.
- In-flight, the settings are not part of the recompose. Leave a settings
  request out of the stage delta and return `settingsChanges`, typed values
  the conductor shows on the gate and applies only on the human's approval;
  return only what the request asks for. The keys are `sensors`, `learnings`, and
  `summary_confirmation` (`on`/`off`), `plan_approval` (`on` only: the person
  turns it off in their own words), and `review` (`adversarial`/`advisory`/
  `none`). Full reviews on a capped scope is `"review": "adversarial"`; no
  stage changes. When `engine config get <key>` reports `from env
  AIDLC_DISABLE_<NAME>`, a kill switch on this machine overrides every
  setting: return no change and say in one line that it has to be removed
  outside the agent. Never look for where it is set; shell startup files,
  environment listings, and harness settings files can hold credentials.
  Never put command text in `settingsChanges` or `creationSettings`.

## Rationale quality

The gate is only as good as the rationale. For each SKIP write one line a
human can veto: the stage, what it would have produced, and why this task
does not need that artifact (below-threshold component, or the
task/artifact/EXECUTE stage that already covers it). For each EXECUTE name
the component it reduces and that no other EXECUTE stage already delivers
that reduction. "Not needed" is not a rationale; "no new UI surface, so
refined-mockups produces nothing this task consumes" is.
