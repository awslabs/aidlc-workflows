# Stage Definition

This chapter documents the **file format** for AI-DLC stage definitions — the
YAML frontmatter contract, the three-compartment body model, and the compile
pipeline that turns those sources into `stage-graph.json`. It complements
[Stage Protocol](04-stage-protocol.md), which covers the runtime behavioural
contract (approval gates, question flow, state tracking). This chapter is
about what a stage file *contains*; the Stage Protocol chapter is about what
a stage *does*.

Contributors read this to understand the format. When writing or editing a
stage file, refer to the authoritative contract at
`dist/claude/.claude/aidlc-common/protocols/stage-definition.md`. That file is
the canonical spec — this chapter adds narrative and "when to use" guidance.

---

## Two audiences, one file

Every stage `.md` file serves two readers:

- **The parser** (`parseStageFrontmatter` in `lib.ts`, ships in milestone 7). Reads
  the YAML frontmatter, produces a structured `StageEntry`. Doesn't touch the
  body.
- **The LLM agent** executing the stage. Reads the body, follows the prose
  instructions, produces artifacts. Doesn't touch the frontmatter.

Keeping both in one file means contributors see the graph edges and the
execution steps side by side. Splitting them across separate files (one YAML
for the graph, one prose for the agent) would break the inline visibility
that makes stages reviewable.

---

## Why Variant A3

The format is called "Variant A3" — the third of three authorship variants
weighed during v0.3.0 planning:

- **One file beats split files.** Frontmatter plus prose in one `.md` keeps
  graph structure and execution steps together. A reviewer reading a stage
  sees both.
- **Grep-friendly.** Plain text. No binary format, no YAML-vs-JSON
  translation at author time.
- **Diff-friendly.** Field additions, renames, and body edits all show up
  cleanly in a code review.

The rejected alternative was a central graph file (`stage-graph.json`
hand-edited) with prose-only stages. Loses the inline visibility of knowing
which artifacts a stage produces while editing its prose.

---

## Authoring flow

```
┌─────────┐         ┌──────────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ Edit    │  ───→   │ Pre-commit hook  │  ───→   │ stage-graph.json │  ───→   │ loadStageGraph() │
│ stage   │         │ aidlc-graph      │         │ (build artifact, │         │ (runtime,        │
│ .md YAML│         │ compile          │         │  checked in)     │         │  unchanged)      │
└─────────┘         └──────────────────┘         └──────────────────┘         └──────────────────┘
     │                                                                                 ▲
     │                              ┌──────────────────┐                               │
     └────────────────────────────→ │ CI drift check   │ ──── blocks merge on drift ───┘
                                    │ compile --check  │
                                    └──────────────────┘
```

The YAML is authoritative. The JSON is a build artifact. CI enforces the
relationship.

`aidlc-graph compile` and `compile --check` ship as CLI subcommands (milestone 9);
run compile manually after editing stage YAML, and CI enforces `compile
--check` to catch drift. A pre-commit hook that automates this is deferred
to a later PR. `stage-graph.json` is a compiled artifact — do not edit it
by hand; edit the YAML and recompile.

---

## Field reference — when to use

The authoritative spec has a complete field table with types and constraints.
This section adds narrative on the fields that need judgment calls.

### `requires_stage`

Encodes dependency edges. Two roles:

1. **Semantic data dependency.** "I consume artifact X, which stage Y
   produces" → add `Y` to `requires_stage`.
2. **Presentation-order edge.** Two stages in the same phase with no
   semantic dependency but a fixed ordering (e.g., `market-research` before
   `feasibility` in Ideation). Add the weak edge so the computed
   `display_order` lands stably.

The compile step's slug-alphabetical tiebreak is a safety net. For stages
that must land in a specific order, author the edge explicitly rather than
relying on alphabetical accident.

### `for_each`

Names an artifact whose instances drive iteration. The stage runs once per
instance.

Today's use case: five Construction stages (`functional-design`,
`nfr-requirements`, `nfr-design`, `infrastructure-design`, `code-generation`)
run once per Unit — they each declare `for_each: unit-of-work` (the artifact
`units-generation` produces).

Tomorrow's use cases: a stage that runs per environment, per tenant, per
region, per compliance jurisdiction. The primitive is workflow-engine
generic; Construction happens to exercise it first.

**Aggregation is inferred, not declared.** A stage that consumes an artifact
produced by a `for_each` stage, without declaring its own `for_each`, is an
aggregation step by definition. `build-and-test` is the canonical example —
it runs once after all five Construction `for_each` stages have iterated
across Units, consuming their aggregated outputs. No explicit `fan_in` or
aggregation field — graph traversal figures it out.

### `workspace_requires`

Boolean, default `false`. Set `true` on stages that must write **source code to
the workspace root**, not just planning documents under the per-intent record dir.

Why it exists: a stage's `produces[]` artifacts always resolve to markdown under
the record dir (the only place the path resolver writes them). So a "do the
produces exist?" check is satisfied by a `code-generation` stage that wrote its
`code-generation-plan.md` and `code-summary.md` but never emitted a line of
actual code (issue #366). `workspace_requires: true` closes that gap: the
stage-completion artifact guard (`aidlc-state.ts` approve/advance/finalize/
complete-workflow) additionally requires evidence of real source work outside
the `aidlc/` workspace tree and the harness directory before the stage may
complete.

How "source work" is detected depends on the workspace:
- **Git workspace** - the guard asks git, so it can tell this session's code
  from a brownfield repo's pre-existing `src/`. It passes when there is an
  uncommitted or untracked non-doc change (`git status --porcelain`) or the last
  commit touched a non-doc path (`git diff --name-only HEAD~1 HEAD`). The second
  clause means commit-then-approve (a clean working tree, code in the last
  commit) still passes, closing the clean-tree false-block from #366 Update 3.
- **Non-git workspace** (or any git error) - the guard falls back to a shell-free
  filesystem-existence check: at least one file must exist outside the `aidlc/`
  workspace tree and the harness dirs.

Today only `code-generation` declares it (it is the one stage whose body writes
application code to the workspace root). A team that adds its own code- or
config-emitting stage (a contract generator, an IaC executor) should set
`workspace_requires: true` on it so the same guard applies. Bypass it for CI
with `AIDLC_SKIP_ARTIFACT_GUARD=1`.

### `produces_kinds`

Optional map on a `for_each: unit-of-work` stage: each key is one of the stage's
`produces` or `optional_produces` artifact names, each value the list of Unit
**kinds** that artifact applies to. Kinds are declared per Unit in
units-generation's edge block (see [Runtime graph](13-runtime-graph.md)
`bolt_dag.units[].kind`) and are one of
`service | spec | ui | packaging | library`.

```yaml
produces:
  - performance-requirements
  - security-requirements
  - scalability-requirements
produces_kinds:
  performance-requirements: [service, ui]
  scalability-requirements: [service]
```

Why it exists: the four construction design stages ran with a fixed produces
list applied identically to every Unit, so a spec Unit owed a scalability doc
and a packaging Unit a business-logic model - N/A stubs the human had to write.
`produces_kinds` lets the engine prune the matrix per Unit: when a Unit carries
a `kind`, the engine keeps only the produces entries whose kind list includes
that kind. An artifact **not** listed in the map applies to all kinds (annotate
only the kind-specific ones). A Unit with **no** kind, or a stage with no
`produces_kinds` map at all, keeps the full matrix - so this is inert for every
existing workflow.

The pruning is symmetric: it filters both the run-stage directive's `produces`
paths (what the conductor writes) and the per-unit coverage check (what the
approve-path guard requires). It composes with `optional_produces`: the
directive's paths are the kind-filtered union of both lists, while coverage
stays keyed off the required `produces` only (an optional artifact is pruned
from the directive for kinds it does not apply to, and remains coverage-exempt
either way). A Unit whose required set prunes to **empty** is
covered by definition - the stage does not apply to it - and a per-unit stage
where *every* Unit prunes to empty approves as a no-op rather than deadlocking
at the artifact guard. The default kind matrix for the four stages is stage
frontmatter data, reviewable and revertible per entry; removing a wrong entry
restores the full matrix for that artifact.

One trust note: the `kind:` value is enum-checked at the units-generation gate
(the `required-sections` sensor fails loud on a typo), but the compiled
runtime graph is trusted afterwards - the engine only shape-checks the kind
when reading `bolt_dag.units[].kind` (matching how it trusts the compiled
batches). A unit hand-edited in the compiled graph to a valid-but-wrong kind
prunes to that wrong kind's set silently.

### `consumes[].required`

Boolean per consume entry. Semantically **scoped to the active plan**,
not a global assertion that the artifact always exists somewhere:

> `required: true` means *"if the producing stage runs in the active
> plan, this consume must be satisfied."* It does **not** mean "the
> producer always runs." When a scope excludes the producer
> (e.g., `bugfix` skips `units-generation`), every `required: true`
> consume of that producer's artifacts becomes moot — there is
> nothing to require.

**Why the scoped reading.** Every scope except the `all`-execute ones
(`enterprise`, `feature`, `workshop`) deliberately skips upstream
stages. A flat global `required: true` would make those scopes
structurally invalid, which is wrong — they're legitimate operating
modes. The real contract is conditional: "if upstream runs, feed me
downstream." The stage body already handles the absence case
gracefully (prose instructions like "if available" or fallbacks from
context).

**What this means for the doctor lint.** The lint walks each
active scope and reports "stage X's `required: true` consume for
artifact Y is moot because Y's producer is SKIP in this scope." That's
advisory, not blocking — the user has already opted into the
truncation by picking the scope.

**What v0.10.0 adds.** The reserved `when:` primitive (see "Reserved"
section below) will let authors express richer predicates —
`when: producer-in-plan`, `when: mode == brownfield`,
`when: scope != poc`. Today's `required: true` + `conditional_on:
brownfield|greenfield` pair covers the two dimensions v0.3.0 needs;
`when:` generalises it.

### `consumes[].conditional_on`

Captures the brownfield/greenfield split. Example:
`reverse-engineering` produces artifacts only in brownfield mode; stages
that consume those artifacts mark the consume
`conditional_on: brownfield` to tell the scope resolver "this consume is
only required when we're in brownfield".

For unconditional consumes, **omit the field entirely**. There is no
`always` value — an unconditional consume simply has no `conditional_on`
key.

### `optional_produces`

A plain kebab-case string list, parallel to `produces:`. It names artifacts
the stage **may** write per unit but is **not required** to. Absent means
none; only the two stages that need it declare it, so the compiled
`stage-graph.json` stays minimal.

Why it exists: a per-unit Construction stage (`for_each: unit-of-work`) is
COVERED for a unit only when every `produces[]` artifact exists on disk under
that unit's record dir (the per-unit coverage check in
`aidlc-orchestrate.ts`). Some artifacts are genuinely conditional on the unit
- `functional-design` writes `frontend-components` only when the unit has a
UI; `infrastructure-design` writes `shared-infrastructure` only when units
share infrastructure. Listing those under `produces:` forced a backend-only
unit to write an N/A stub just to satisfy coverage, and left the stage gate
unreachable until it did. Moving them to `optional_produces:` exempts them:

- **Coverage exemption.** `optional_produces` entries are ignored by the
  per-unit coverage loop. A unit is covered once its **required** `produces[]`
  artifacts exist; the optional ones never block `next` from advancing or
  `approve` from committing.
- **Still resolved for the conductor.** The run-stage directive's `produces`
  paths union `produces` + `optional_produces`, so when the unit DOES write
  the conditional artifact the conductor still knows where it lands. When the
  stage also declares `produces_kinds`, that union is kind-filtered before it
  resolves (see `produces_kinds` above), so a kind an optional artifact does
  not apply to never sees its path.
- **Still in the vocabulary.** `artifactsRegistry()` and `producersOf()` union
  both lists, so the artifact name and its producer stage stay registered.

**Pairing convention.** Every `optional_produces` entry MUST have a
`(CONDITIONAL - ...)` marker in the stage body prose (and the `outputs:`
string) that tells the agent when to write it. The frontmatter key is the
engine's coverage view; the prose is the agent's instruction. Keep them in
sync.

**Warning.** An artifact marked `optional_produces` is invisible to the
per-unit coverage ledger - the engine cannot prove the unit produced it. Use
it only for artifacts that are legitimately conditional on the unit, never to
quietly relax coverage for an artifact a stage should always write per unit.

### `mode`

Dispatch mechanism, three values:

- `inline` — the conductor runs the stage in its own context. Short stages,
  fast to execute, no context pressure.
- `subagent` — delegates via the Task tool to a fresh subagent context.
  Long stages (Construction code generation) that would blow out the main
  conductor context.
- `agent-team` — **reserved**. For when Anthropic's experimental
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` primitive stabilises and we need
  direct agent-to-agent messaging. Likely first consumer is v0.8.0's Ralph
  loop driver. No stage declares `agent-team` in v0.3.0.

Note: multi-agent execution today is expressed via `support_agents`. The
conductor invokes the lead agent first, then each supporter in turn with
the lead's output as context (see
`dist/claude/.claude/aidlc-common/protocols/stage-protocol.md:611`). Agents do
not invoke each other — only the conductor delegates. `agent-team` is
specifically for the future case where direct inter-agent messaging is
needed, not the general "multiple agents touch the stage" case.

**Consumer contract.** Orchestrator code reading the `mode` field must
handle `agent-team` explicitly — at minimum throw "mode agent-team not yet
implemented". Do not fall through to a default execution path. Silent
fallthrough on enum extension is a known foot-gun.

### `lead_agent` and `support_agents`

The lead agent owns the stage. The lead's persona (skills, knowledge, tool
allowlist) is loaded at stage start. Support agents add perspective — a
stage might lead with `aidlc-product-agent` for requirements work but load
`aidlc-delivery-agent` as support for capacity reality-checking.

Both fields validate dynamically against `.claude/agents/*.md` via
`loadAgents()` (introduced in milestone 3) — `aidlc-graph.ts compile` passes the
discovered agent slugs into `validateStageFrontmatter`, so a `lead_agent` or
`support_agents` value naming an agent with no matching file fails the
compile loudly (`lead_agent "<name>" has no matching .claude/agents/*.md`)
rather than surfacing at run time as an unregistered-subagent `Task` error.
The one exemption is the reserved `orchestrator` pseudo-agent (the conductor
itself, named as `lead_agent` on the bootstrap initialization stages); it has
no agent file by design. No hardcoded enum in the schema — adding an agent
means dropping its `.md` file in `.claude/agents/` with the required
frontmatter. See
[Contributing: Adding an Agent](11-contributing.md#adding-an-agent).

### `reviewer` and `reviewer_max_iterations`

Optional. `reviewer` names a quality-gate agent invoked after the stage body
produces its artifacts and before the approval gate (see [Stage
Protocol](04-stage-protocol.md)). Two reviewers ship today —
`aidlc-product-lead-agent` and `aidlc-architecture-reviewer-agent` — and the
compile validates the value against the discovered agent roster the same way
`lead_agent` is validated.

`reviewer_max_iterations` caps the review/revise loop before the workflow proceeds
to the gate with unresolved findings. It **defaults to 2** when `reviewer` is
declared but no cap is given; the compiler coerces a missing or non-positive value
to 2. Omit the field on a stage that declares no `reviewer`: the compiler rejects
a `reviewer_max_iterations` declared without a `reviewer` (the schema error
`reviewer_max_iterations requires a reviewer` fails the graph compile), so it is
never silently ignored.

---

## Relationship to agent frontmatter

Stages and agents follow the same YAML-first discipline. Agent frontmatter
(see [Agent System](05-agent-system.md#frontmatter-contract)) declares
*who* — the agent's name, allowed tools, tier. Stage frontmatter
declares *what* — which artifacts the stage produces and consumes, which
agents it delegates to, how it executes.

Both formats:

- Are authoritative sources for their domain (no parallel hardcoded maps).
- Ship with a `loadX()` helper that returns typed structures.
- Validate dynamically against the filesystem rather than against a
  hardcoded enum.

Adding a new stage is the same shape as adding a new agent: drop an `.md`
file, add the required frontmatter, and the helpers pick it up at runtime.

---

## Worked example

The canonical example is `scope-definition`. The normative YAML block lives
in `dist/claude/.claude/aidlc-common/protocols/stage-definition.md` — refer
there rather than duplicating here.

The example encodes, in structured form, what today's prose describes:

- `requires_stage: [intent-capture]` encodes the prose instruction "Read
  intent statement from the intent's `ideation/intent-capture/` (under its record dir)". The parser
  does not care about the prose — it just sees the graph edge — but human
  readers should keep them in sync.
- `consumes: [{artifact: intent-statement, required: true}]` says this
  stage is blocked until `intent-statement` exists. If the scope's resolver
  can't find a producer for `intent-statement`, the doctor's
  missing-producer check fails.
- `produces: [scope-document, intent-backlog, scope-definition-questions]`
  is the forward edge — other stages looking for "who produces
  `scope-document`?" find this one via `aidlc-graph.ts producersOf()`.
- No `for_each` field — `scope-definition` runs once per workflow.

---

## Three-compartment body model

The body of a stage file has three compartments, declared in this order.
Only `## Steps` is populated in v0.3.0.

| Compartment | v0.3.0 | v0.5.0 | What goes here |
|-------------|--------|--------|----------------|
| `## Steps` | Required, populated | Unchanged | Imperative prose the agent follows |
| `## Sensors` | Reserved, absent | Populated | Deterministic sensor bindings (IDs from the flat `.claude/sensors/` registry) |
| `## Learn` | Reserved, absent | Populated | Loop-driver bindings and observer rules |

Pre-declaring the three compartments in v0.3.0 meant v0.5.0's additions
were slot-in changes, not body restructures. See [Sensor
System](07-sensor-system.md) for the `## Sensors` binding semantics and
the pull-import model.

**milestone 8 migration rule:** wrap the existing body under `## Steps`, nothing
else. Most stage files already use `## Steps` as their first body heading.

---

## YAML migration — shipped

milestone 7 shipped `parseStageFrontmatter` and `emitStageFrontmatter` in
`lib.ts` — YAML-only, no prose back-compat path. milestone 8 migrated all 31
stage files to YAML frontmatter in a single atomic change. milestone 9 expanded
`aidlc-graph.ts` to compile the YAML into `stage-graph.json` and added
`compile --check` as the CI drift guard. Running `bun aidlc-graph.ts
compile --check` on a clean tree exits 0; editing any stage YAML without
recompiling the JSON exits 1 with a clear message.

---

## Known limits in v0.3.0

- **`for_each` is new.** The 5 Construction stages with `**Per-Unit**: Yes`
  migrate to `for_each: unit-of-work`; the other 26 stages omit the field
  entirely.
- **Sensors / Learn compartments declared but empty.** The parser
  tolerates their absence; v0.5.0 populated them (see [Sensor
  System](07-sensor-system.md)).
- **No runtime validation beyond drift check.** The parser accepts any
  YAML that produces a valid `StageEntry`; doctor's later extensions add
  advisory rule/sensor checks on top.

---

## Future extensions — reserved namespace

The spec reserves names for primitives AI-DLC will likely add in later
releases. The schema rejects unknown keys — reserving the names here
prevents future contributions from colliding with ad-hoc additions.

| Key | Likely release | What it will do |
|-----|----------------|-----------------|
| `when` | v0.10.0 fitness compiler | Structured condition. Compiles `condition` prose into machine-enforceable logic. Supersedes `consumes[].conditional_on` and generalises today's scope-aware `consumes[].required` with richer predicates (`producer-in-plan`, `mode == brownfield`, `scope != poc`) |
| `on_failure` | v0.8.0 Ralph loop | Declarative error recovery — "if this stage fails, jump back to X" or "retry with adjusted inputs". Moves revision semantics out of `stage-protocol-recovery.md` prose |
| `blocks_on` | v0.4.0 Construction (if surfaced) | Completion dependency without data read — splits today's overloaded `requires_stage` (which conflates "I consume your output" with "I run after you") |
| `timeout` | v0.5.0 sensor binding | Execution budget (deadline). Homed in sensor bindings, not stage frontmatter |
| `retry` | v0.8.0 Ralph loop | Retry policy on failure. Homed in loop config, not stage frontmatter |

Design rationale: Claude Code's own task primitives (TaskCreate family plus
`/loop` and cron) omit dependency, blocks, retry, and timeout — all
multi-step orchestration is pushed to client-side code. This implementation mirrors that
choice by homing execution behaviour (retries, timeouts, failure handling)
in the loop and sensor subsystems rather than the stage spec. The fields
above would be modest structural extensions if consumers emerge, not new
paradigms.

The reserved-namespace pattern has precedent in the audit taxonomy
([State Machine](12-state-machine.md)), which pre-registers event names with an
Emitter cell of `Reserved (v0.x PR N)` — the name exists in the registry but no
code emits it until the consumer PR ships, at which point the same commit
replaces the `Reserved` marker with the real emitter path.

---

## Cross-references

- `dist/claude/.claude/aidlc-common/protocols/stage-definition.md` — the
  authoritative spec this chapter narrates.
- [Stage Protocol](04-stage-protocol.md) — runtime execution behaviour.
- [Agent System](05-agent-system.md) — parallel YAML-first contract for
  agent files.
- [State Machine](12-state-machine.md) — where stage execution emits audit
  events.
