# Anatomy of a Stage

A stage is the atom of the AI-DLC workflow — *what* happens at one step. Every other change a harness engineer makes builds on the stage file, so this is the chapter to read first. By the end you should be able to open any stage `.md` file, know who reads each part of it, and understand which fields you can change by editing the file versus which behavior is fixed by the framework's code.

A stage file is a single Markdown file with YAML frontmatter. The frontmatter declares the graph node — the artifacts the stage consumes and produces, its lead agent, how it executes. The body is the prose the agent follows. Both live in one file on purpose, and the rest of this chapter unpacks why.

---

## Two readers, one file

A stage file has two readers, and they never overlap:

- **The parser** reads only the YAML frontmatter. It produces a structured graph entry — the edges, the lead agent, the execution mode — and ignores the body entirely.
- **The agent** executing the stage reads only the body. It follows the prose steps, produces the artifacts, and never touches the frontmatter.

Keeping both in one file means you see the graph edges and the execution steps side by side when you open the file. A reviewer reading a stage sees both at once: which artifacts it produces *and* the instructions that produce them. Splitting them — one YAML file for the graph, one prose file for the agent — would break that inline visibility, which is the property that makes stages reviewable.

This split is the key to knowing what you're editing. Change a frontmatter field and you've changed the *graph* (a dependency edge, the agent that leads, the execution mode). Change the body and you've changed the *work* (what the agent actually does). The two are independent.

A real stage is authored at `core/aidlc-common/stages/<phase>/<slug>.md` — for example `stages/inception/application-design.md`. Open one alongside this chapter; the shape will be familiar by the end.

---

## The frontmatter at a glance

The frontmatter is a flat block of YAML keys. Some are mechanical — `slug`, `phase` — and you copy them from a neighbouring stage. A handful carry real judgment, and those are the ones worth understanding before you author or edit a stage:

| Field | What it decides | The judgment call |
|-------|-----------------|-------------------|
| `requires_stage` | Dependency and ordering edges | Does this stage genuinely consume another's output, or just need to run after it? |
| `consumes` | The artifacts this stage reads | Per artifact: is it `required`, and is it `conditional_on` brownfield/greenfield? |
| `produces` | The artifacts this stage writes | These are the forward edges other stages discover. |
| `lead_agent` / `support_agents` | Who runs the stage | One persona owns it; supporters add perspective. |
| `mode` | Communication topology | `inline` (voices in the conductor's context), `subagent` (hub-and-spoke dispatch), `pipeline` (chain), or `mob` (mesh in bounded rounds). |
| `for_each` | Whether it iterates | Names an artifact whose instances drive a once-per-instance run. |

A few notes on the calls that bite hardest:

- **`consumes[].required` is scoped to the active plan, not global.** `required: true` means "if the producing stage runs in *this* workflow, this consume must be satisfied" — not "the producer always runs." Scopes deliberately skip upstream stages, and a flat global requirement would make those scopes structurally invalid. The stage body handles the absent-input case gracefully (prose like "if produced").
- **`consumes[].conditional_on` captures the brownfield/greenfield split.** A consume marked `conditional_on: brownfield` is only required when the workflow is brownfield. For an unconditional consume, omit the field entirely — there is no `always` value.
- **`mode` is the communication topology** — who talks to whom while the body runs. `inline` runs short stages in the conductor's own context with supporters as adopted voices; `subagent` delegates the lead to a fresh context (long stages like Construction code generation) and, when supporters are declared, dispatches each as a mutually-blind spoke; `pipeline` chains supporters in declared order, each seeing all upstream work; `mob` runs all supporters in parallel against the lead's draft with one bounded objection round. WHO participates is `support_agents`; HOW they participate is `mode`. `pipeline` and `mob` require non-empty `support_agents`.
- **`for_each` names the iteration artifact.** The five Construction stages that run once per Unit declare `for_each: unit-of-work`; the other stages omit the field and run once. Aggregation is inferred from the graph, not declared.
- **`lead_agent` and `support_agents` validate against `core/agents/*.md`.** There's no hardcoded list — adding an agent means dropping its file in that directory (see [Adding an Agent](03-adding-an-agent.md)).

This is the orientation, not the contract. For the complete field table with types, constraints, and the reserved-namespace fields AI-DLC will add later, read [Field reference — when to use](../reference/15-stage-definition.md#field-reference--when-to-use) in the Developer Reference.

---

## The three-compartment body

Below the frontmatter, the body has three compartments, always in this order: `## Steps`, `## Sensors`, `## Learn`. Looking at `application-design.md` shows all three populated.

- **`## Steps`** is the imperative prose the agent follows — load personas, read prior context, create the questions file, generate the artifacts, present the approval gate. This is where the stage's domain work lives, and it's the compartment you'll edit most when you change *what a stage does* without touching the graph.
- **`## Sensors`** documents the deterministic checks bound to the stage's outputs. In `application-design.md` it explains that `required-sections` and `upstream-coverage` fire on the stage's markdown artifacts and what each one verifies. The binding itself is the `sensors:` list up in the frontmatter; this compartment is the human-readable description of what those bindings do. Sensors are covered in full in [Sensors](06-sensors.md).
- **`## Learn`** documents the learning-loop ritual — the `memory.md` diary the agent keeps while the stage runs, and how kept observations route into practices and sensors at the approval gate. Crucially, this ritual writes into the *space memory layer* (`aidlc/spaces/<active-space>/memory/`) and the harness's sensor config (`.claude/sensors/`), never back into the stage file itself.

These three compartments were pre-declared so that v0.5.0's additions — the populated Sensors and Learn bindings — slotted in cleanly rather than forcing a body restructure. The full body model and what each compartment may contain is in [Three-compartment body model](../reference/15-stage-definition.md#three-compartment-body-model).

One boundary worth internalizing: a stage file is a framework artifact, immutable in shape. The body's `## Steps` / `## Sensors` / `## Learn` structure is never rewritten by a workflow. The single sanctioned in-workflow edit is the learning loop appending a new sensor id to the frontmatter `sensors:` import list. Everything else you change in a stage file, you change deliberately as a harness engineer.

---

## consumes and produces from the graph

The dependency graph isn't written anywhere directly — it emerges from the `consumes` and `produces` declarations across every stage. A stage's `produces` list is its forward edges: when another stage asks "who produces `scope-document`?", the answer is whichever stage declares it. A stage's `consumes` list is its backward edges: it can't run until those artifacts exist.

`requires_stage` makes the dependency explicit and also encodes pure ordering. It carries two roles:

1. **A semantic data dependency** — "I consume artifact X, which stage Y produces," so Y goes in `requires_stage`.
2. **A presentation-order edge** — two stages in the same phase with no data dependency but a fixed order. Author the weak edge so the computed display order lands stably rather than relying on an alphabetical tiebreak.

When you author or move a stage, these three lists are what wire it into the workflow. Get them right and the stage appears in the correct scopes, in the correct order, with its inputs satisfied. The mechanics of wiring a brand-new stage in are covered step by step in [Adding a Stage](02-adding-a-stage.md).

---

## stage-graph.json is compiled — never hand-edit it

This implementation runs the graph from a JSON file at `dist/claude/.claude/tools/data/stage-graph.json`. That file is a **build artifact**, not a source file. The YAML frontmatter across the stage files is authoritative; the JSON is what you get when you compile it.

The flow is:

```
edit stage .md YAML  →  compile  →  stage-graph.json  →  runtime reads it
```

After editing any stage's frontmatter, run the compile to regenerate `stage-graph.json`, then commit both together. CI runs a drift check that fails the merge if the JSON doesn't match what the YAML would compile to — so a forgotten recompile is caught, not shipped.

The rule that follows: **do not hand-edit `stage-graph.json`.** Edit the YAML, recompile. A hand-edit either gets clobbered by the next compile or trips the drift check. The compile command and the drift guard are documented in [Authoring flow](../reference/15-stage-definition.md#authoring-flow).

---

## What a stage *contains* versus what it *does*

This chapter is about what a stage file *contains* — its format. There's a companion contract about what a stage *does* at runtime: the approval gate, the question flow, the state checkboxes, the completion message. That behavioral contract is the same for every stage regardless of its domain, and it lives in [Stage Protocol](../reference/04-stage-protocol.md). When a stage body says "Follow stage-protocol.md for approval gates," that's the contract it's pointing at.

Keep the two separate in your head: the stage *definition* (this chapter, [reference 15](../reference/15-stage-definition.md)) is the file format; the stage *protocol* ([reference 04](../reference/04-stage-protocol.md)) is the runtime behavior that wraps around every stage's work. You edit the definition. The protocol you mostly leave alone.

For a complete annotated example tying the frontmatter and body together, see [Worked example](../reference/15-stage-definition.md#worked-example).

---

## Next

- [Adding a Stage](02-adding-a-stage.md) — author a new stage file end to end, wire its `consumes`/`produces` edges, compile the graph, and watch it appear in a scope.
