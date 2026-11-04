# Adding a Stage

A stage is a node in the workflow graph: a unit of work that declares the
artifacts it consumes and produces, the agent that leads it, and how it runs.
Adding one is the most structural change a harness engineer makes — you are
introducing a new step into the methodology itself. This chapter walks the
end-to-end recipe: pick a phase, author the file, wire the dependency edges,
compile the graph, and confirm the new stage lands where you expect.

Read [Anatomy of a Stage](01-anatomy-of-a-stage.md) first. That chapter covers
the file format — frontmatter contract and three-compartment body — that this
recipe assumes you already understand. Here we focus on the *workflow*: the
judgment calls and the verification steps, not the field-by-field schema. For
the exhaustive contract, this chapter links down to
[Stage Definition](../reference/15-stage-definition.md) at each step.

The discipline mirrors the
[Adding a Scope](../reference/11-contributing.md#adding-a-scope) and
[Adding an Agent](../reference/11-contributing.md#adding-an-agent) recipes in
the Developer Reference: a numbered list of steps, then a clear split between
*what validates automatically* and *what you must check yourself*.

---

## Before you start: is a new stage the right move?

A new stage earns its place when it produces an artifact no existing stage
produces, or consumes one in a way no existing stage covers. If you only want
to change *what an existing stage does* — reword its steps, retarget its lead
agent, attach a sensor — edit that stage file in place; you do not need a new
node. See [Anatomy of a Stage](01-anatomy-of-a-stage.md) for in-place edits.

Adding a stage is **data work**: you author a Markdown file with YAML
frontmatter and recompile a JSON artifact. No TypeScript changes. The one
boundary to keep in mind — if the graph *compiler itself* needs new behavior
(a new frontmatter key it doesn't yet understand, a new traversal rule), that
is a Developer Reference concern, not harness work. The reserved keys the spec
already knows about (`on_failure`, `blocks_on`, `timeout`, `retry`) are listed
in [Stage Definition](../reference/15-stage-definition.md) and rejected today;
reaching for one means you've crossed the line into code. `when:` is different:
the schema accepts and checks it, but nothing acts on it yet, so a stage with
`when:` runs under its `scopes:` as if it were not there.

---

## Steps

### 1. Decide which phase the stage belongs to

Stage files live under
`core/aidlc-common/stages/<phase>/<slug>.md`. The phase is the directory.
There are five:

```
core/aidlc-common/stages/
├── initialization/
├── ideation/
├── inception/
├── construction/
└── operation/
```

The phase a stage sits in is not cosmetic. It determines which
`phases/<phase>.md` rule layer attaches to the stage at compile time — a
construction-phase stage inherits the construction phase rule, an inception
stage inherits the inception rule. (Initialization has no phase rule file.) Put
the stage where its work actually happens in the lifecycle, not where it's
convenient to file it.

### 2. Create the stage file with required frontmatter

Drop a new `<slug>.md` in the chosen phase directory. The slug is the
filename stem and the stage's identity everywhere else — in `requires_stage`
edges, in scope mappings, in the audit log. Pick it carefully; renaming later
ripples.

The frontmatter declares the graph edges and the execution contract. The
fields that carry the structural weight:

| Field | What it does |
|-------|--------------|
| `requires_stage` | The dependency edges — which stages must precede this one |
| `consumes` | The artifacts this stage reads, each with a `required` boolean |
| `produces` | The artifacts this stage writes (its forward edges) |
| `lead_agent` | The persona that owns the stage |
| `support_agents` | Optional perspectives the conductor loads after the lead; pipeline chains require unique agents |
| `mode` | `inline`, `subagent`, `pipeline`, `mob`, or the reserved `agent-team` |
| `for_each` | Optional — names an artifact whose instances drive iteration |
| `summary_confirmation` | Optional — `required` for stages that always collect file-backed answers, `if-present` for conditional question flows |
| `reviewer` / `review_artifact` | Optional pair — the review agent and the required Markdown `produces` entry the review is about (its review record is keyed to that artifact) |

A complete small stage, a glossary step after Requirements Analysis that runs
only under `feature`, looks like this (it compiles as it stands):

```markdown
---
slug: glossary-capture
phase: inception
execution: CONDITIONAL
condition: Execute when the requirements use domain terms the team must agree on. Skip when every term is already defined.
lead_agent: aidlc-product-agent
support_agents: []
mode: inline
produces:
  - glossary
consumes:
  - artifact: requirements
    required: true
requires_stage:
  - requirements-analysis
sensors:
  - required-sections
scopes:
  - feature
inputs: <record>/inception/requirements-analysis/requirements.md
outputs: glossary.md (under this stage's record dir, engine-resolved)
---

# Glossary Capture

Collect the domain terms the requirements use and agree one meaning for each.

## Steps

1. Read `<record>/inception/requirements-analysis/requirements.md` and list every domain term it uses.
2. For each term, write one plain definition and the requirement IDs that use it.
3. Write `glossary.md` with `## Terms` and `## Open Terms` sections.
4. Follow stage-protocol.md for the approval gate.

## Sensors

This stage's output is a markdown artefact under `<record>/inception/glossary-capture/`.

Imports: `required-sections`.

## Learn

When `directive.protocol_modules` lists `learnings`, follow
`stage-protocol-learnings.md`: keep the diary at `directive.memory_path` while
working, and take the learnings step before the approval gate; that module says
when it asks the person anything. When the module is absent, skip both the diary
and the step.
```

The body opens with `## Steps` — the imperative prose the lead agent follows.
The `## Sensors` compartment then summarizes output location, exact frontmatter
imports, and upstream targets; preserve any stage-specific sensor exception.
The final `## Learn` compartment points to `stage-protocol-learnings.md` §13
only when `directive.protocol_modules` lists `learnings`; otherwise skip the diary and step. The module owns when the step asks, and the bootstrap, isolated-run and per-unit exemptions. For the complete field table,
types, and constraints, see
[Field reference — when to use](../reference/15-stage-definition.md#field-reference-when-to-use).

### 3. Wire the dependency edges so the graph places it

This is where a new stage actually slots into the workflow. Three fields do the
wiring, and they must agree with each other:

- **`requires_stage`** encodes the edges. It carries two kinds of edge: a
  *semantic data dependency* ("I consume artifact X, which stage Y produces" →
  add `Y`) and a *presentation-order edge* (two stages in one phase with no
  data dependency but a fixed running order). Author the order edge explicitly
  rather than relying on the compiler's alphabetical tiebreak, which serves
  only as a safety net beneath your explicit placement.
- **`consumes`** lists the artifacts the stage reads. Each entry carries a
  `required` boolean, scoped *to the active plan*: `required: true` means "if
  the producing stage runs in this scope, the consume must be satisfied" — not
  "the producer always runs." A consume that's only needed in brownfield mode
  takes `conditional_on: brownfield`; an unconditional consume omits the field
  entirely (there is no `always` value).
- **`produces`** lists the forward edges. When a downstream stage asks "who
  produces artifact Z?", the graph answers via `producersOf()` — so the stage
  that declares `produces: [Z]` is the one that gets wired in upstream of it.
  Every consumed artifact must resolve to exactly one producer across
  `produces` and `optional_produces`; `aidlc-graph compile` rejects duplicates
  and names both producer files. Reusing an artifact name is valid only when no
  stage consumes it.

Get these three consistent and the compiler places the stage automatically;
you never edit `stage-graph.json` by hand to position it. The nuances of
`requires_stage`, `consumes[].required`, `consumes[].conditional_on`, and
`for_each` (including how aggregation is *inferred* rather than declared) are
covered in
[Field reference — when to use](../reference/15-stage-definition.md#field-reference-when-to-use).

### 4. Regenerate the harnesses, so `stage-graph.json` recompiles

The YAML you just authored under `core/` is the authoritative source. Run the
packager to materialize the ignored local `dist/<harness>/` (Bun copy) and
`dist-release/<harness>/` (native) from `core/` — this copies your new stage
file into both channels and recompiles each graph:

```bash
bun scripts/package.ts            # materialize both channels for every harness
bun scripts/package.ts --check    # build twice and byte-compare
```

The runtime reads a compiled artifact, `<harness-dir>/tools/data/stage-graph.json`
(e.g. `.claude/tools/data/stage-graph.json` in an installed Claude tree),
produced from the YAML by the graph compiler that the packager invokes. If you
are iterating on an already-installed tree, you can recompile that tree's graph
directly:

```bash
aidlc engine graph compile
```

Either way the authoring flow is a one-way pipeline — edit YAML in `core/`, run
the packager (or `compile` against an installed tree), the JSON updates, and the
runtime loader (`loadStageGraph()`) picks up the new node unchanged. Never edit
`stage-graph.json` by hand; it is a build artifact, and a hand-edit will be
overwritten on the next compile. The full pipeline diagram and the CI drift
guard are in
[Authoring flow](../reference/15-stage-definition.md#authoring-flow).

### 5. Verify it appears — and in which scopes

Confirm the new node compiled in and see where it runs:

```bash
# Topological order of the full graph — your slug should appear
aidlc engine graph topo

# Who produces / consumes your stage's artifacts
aidlc engine graph producers <artifact>
aidlc engine graph consumers <artifact>

# The stages on a given scope's path — does your stage run for this scope?
aidlc engine graph scope <scope-name>

# Dependency sanity for a scope
aidlc engine graph validate-scope <scope-name>
```

For the glossary stage above, dropped into an installed Claude Code tree as
`.claude/aidlc-common/stages/inception/glossary-capture.md` and compiled with
`aidlc engine graph compile`, the feature path now includes it (shortened):

```text
$ aidlc engine graph scope feature
...
requirements-analysis
user-stories
refined-mockups
domain-design
units-generation
contract-design
delivery-planning
glossary-capture
functional-design
...
$ aidlc engine graph producers glossary
glossary-capture
```

It lands at the end of Inception, not right after Requirements Analysis: a new
stage takes the next free number in its phase, after the stages already there,
and no existing stage is renumbered. A new stage that runs once per Unit
(`for_each: unit-of-work`) still runs with the other per-Unit stages of its
phase, whatever its number
([Stage Definition](../reference/15-stage-definition.md#for_each)). An edge from an earlier stage to the new
one is refused at compile; with `glossary-capture` added to User Stories'
`requires_stage`, the same tree prints (its long dash shown as `-`):

```text
$ aidlc engine graph compile
aidlc-graph compile: Compile invariant violated: stage "user-stories" (2.4) requires "glossary-capture" (2.10) - dependency must be lower-numbered. Fix: either renumber in stage-graph.json to match the dependency direction, or remove the offending requires_stage edge.
```

A brand-new stage does **not** automatically run in any scope. Scope
membership now lives on the stage itself: its frontmatter `scopes:` list names
every scope it runs under. A stage that names no scope is `SKIP` everywhere.
So after adding a stage, decide which scopes should run it and add each scope
name to the stage's `scopes:` list — then recompile so the transpose updates
`scope-grid.json` — see [Scopes](04-scopes.md). This is the deliberate seam:
authoring the stage body makes it *exist*; the `scopes:` tag makes it *run*.

---

## To add a stage, write a stage file — the runner is opt-in sugar

The headline of this chapter is also its extensibility contract: **to add a
stage, you write a stage file.** Nothing else is structurally required. Once the
stage compiles into the graph (steps 2–4 above), it is immediately runnable on its
own, with no skill or registration required:

```bash
aidlc engine orchestrate next --stage <your-slug> --single
```

The engine's `--single` mode runs that one stage in isolation. It emits a single
`run-stage` directive for the stage (with its lead agent, resolved
consumes/produces paths, rules, and sensors), the conductor runs it, and a
synthetic-id lifecycle is committed to the audit log: `next --single` records
`STAGE_STARTED` before dispatch, and `report --single` requires that boundary
before recording `STAGE_COMPLETED`.
The directive carries `single: true`, so the conductor runs the configured body,
topology, reviewer, and completion checks, reports once with
`report --single --stage <slug> --result completed`, and stops on `done`. It does
not run workflow learnings or open a workflow approval gate.
A `--single` run is deliberately isolated: it **never touches the main workflow's
`Current Stage`** — the tool refuses to advance the main workflow from a single
run. It writes the stage's documents where the work keeps them, after keeping a
copy of the files already there under the record's `archive/` folder.

### The runner skill is optional packaging

Every shipped runnable stage also gets a thin runner skill at `skills/aidlc-<slug>/SKILL.md`
so it is typeable as `/aidlc-<slug>` (e.g. `/aidlc-domain-design`). These are
**opt-in sugar over the `--single` flag** — a ~6-line shell that drives
`next --stage <slug> --single`. They are not hand-written: a generator emits one
per runnable compiled stage slug, so the set of runners can never drift from the
set of stages by hand. (The three bootstrap initialization stages get no per-stage
runner — they have no standalone `--single` meaning; the whole init phase is the
`/aidlc-init` command instead: with `--scope` and a description it packages the engine's intent-create move, with `--scope` and nothing else it first asks what the work is for, and with only a description it asks the engine for new work, which shows the plan offer first.) After adding (or removing)
a stage, regenerate the runners:

```bash
# Regenerate every runner dir from the compiled stage list
aidlc engine gen runners

# CI drift guard: exits 1 if the runner set != the compiled stage set
aidlc engine gen runners --check
```

A runner carries **no `hooks:` block** — the deterministic spine (audit, sensors,
runtime-graph compile, state validation) is project-wide in `settings.json`, so
every runner inherits it for free; there is nothing per-runner to replicate. And a
runner does **not** load the conductor persona by hand: the engine delivers it,
baked into the `run-stage` directive it hands the chat. The runner body just states what it
does and the one command it drives.

If you delete all the runner skills, every stage still runs via
`/aidlc --stage <slug> --single` — the runners package an already-runnable stage; the stage file is the definition. The
authoring path is, and stays, "write a stage file."

For the normative contract behind these runners — how the engine, conductor, and
`run-stage` directive turn a compiled stage into a typeable `/aidlc-<slug>` skill
— see [Skill System §4 (skills and runners)](../reference/17-skill-system.md) in
the Developer Reference.

---

## What validates automatically vs. what you must check yourself

### What validates automatically

- **Graph placement.** Once you `compile`, the stage's edges (`requires_stage`,
  `consumes`, `produces`) are resolved into the graph. Topological order,
  producer/consumer lookups, and cycle detection all account for the new node
  with no further edits.
- **Compile-time field validation.** The compiler validates frontmatter as it
  builds the graph — authoring errors fail loud at `compile`, not silently at
  run time. A `lead_agent` or `support_agents` value is checked against the
  actual `.claude/agents/*.md` files via `loadAgents()`; there is no hardcoded
  agent enum to update. A stage naming an agent with no matching file fails the
  compile (`lead_agent "<name>" has no matching .claude/agents/*.md`), so a
  typo can't ship a graph that 404s at run time. The reserved `orchestrator`
  slug (the conductor itself, used on the bootstrap initialization stages) is
  exempt — it has no agent file. Pipeline stages also reject duplicate chain
  identities across `lead_agent` and `support_agents`.
- **Drift checks.** In the source checkout, CI builds every tree from `core/`
  and `bun scripts/package.ts --check` builds twice and byte-compares, so no
  generated file is an input and there is nothing to forget to commit. In an
  installed tree, `aidlc engine graph compile --check` exits `0` when the graph
  matches the stage files, and `1` when a stage was edited without
  recompiling, printing ``stage-graph.json is out of date. Run `aidlc engine
  graph compile` to regenerate.``
- **Phase rule attachment.** Because the stage declares its phase by directory,
  the matching `phases/<phase>.md` rule layer attaches at compile time —
  you don't wire that edge yourself.

### What you must check yourself

- **Scope participation.** The compiler places the stage in the graph; it does
  **not** decide which scopes run it. Until you add each scope name to the
  stage's own `scopes:` frontmatter list (and recompile so the transpose
  updates `scope-grid.json`), the new stage exists in the graph but runs
  nowhere. Confirm with `aidlc engine graph scope <scope-name>` for each scope you
  care about.
- **Body prose.** Only the frontmatter is parsed. The `## Steps` body is read by
  the lead agent when the stage activates — write it to match the other stage
  files' structure. The parser will not catch vague or missing instructions.
- **Prose-to-edge consistency.** `requires_stage` and the `## Steps` prose can
  drift apart — the parser only sees the edges, not the prose. If your steps say
  "read the intent statement," the matching producer stage must actually be in
  `requires_stage`. Keep them in sync by hand.
- **`required` semantics under your scopes.** A `required: true` consume becomes
  moot in any scope that skips the producer — that's legitimate, not a bug, but
  it's on you to confirm the stage body handles the producer's absence
  gracefully (the "if available" fallback pattern).
- **Documentation.** If the new stage changes a count or a table that the docs
  enumerate by hand (stage counts, phase listings), update those in the same
  change, per the documentation policy.

---

## The boundary case: data work vs. code work

Authoring the stage file and recompiling the graph is entirely
harness-engineer data work — Markdown, YAML, JSON, no `.ts`. The line you must
not cross silently: if making your stage work requires the graph *compiler* to
behave differently — a frontmatter key it doesn't recognize, a new edge type, a
new traversal rule — that is a change to the code that reads the data, and it
belongs in the [Developer Reference](../reference/15-stage-definition.md), not
here. The reserved-key namespace in the spec exists precisely so that future
structural extensions land predictably rather than as ad-hoc additions; until a
consumer ships for one of those keys, the schema rejects it. If you find
yourself wanting a key the compiler doesn't yet implement, stop — that's a
framework change, and it follows the contributing recipe under
[Adding an Agent](../reference/11-contributing.md#adding-an-agent) and its
siblings for the validation discipline, but the implementation lives in code.

---

## Next

[Adding an Agent](03-adding-an-agent.md) — author the persona your new stage
names as its `lead_agent`, and bind it to the stages it leads or supports.
