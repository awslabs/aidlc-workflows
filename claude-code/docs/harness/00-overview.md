# Harness Engineer Guide

AI-DLC is a methodology, and this Claude Code implementation ships it working
out of the box: 11 agents, 32 stages, 9 scopes, a set of rules and sensors. This
guide is for the person who wants to **reshape** that methodology — change which stages run, add an agent for a
domain the framework doesn't cover, tighten a scope, teach the framework a
standing rule, or wire a deterministic check into a stage.

You do all of that **without writing code**.

---

## Three readers, three guides

AI-DLC's documentation is split by what you're trying to do, not by topic:

| Guide | You are… | You change… |
|-------|----------|-------------|
| [User Guide](../guide/00-introduction.md) | building software *with* AI-DLC | nothing in `.claude/` — you run `/aidlc`, answer at gates, review artifacts |
| **Harness Engineer Guide** (this one) | shaping *how* AI-DLC behaves for your team | the **data** the framework reads: stages, agents, scopes, rules, sensors, knowledge |
| [Developer Reference](../reference/00-overview.md) | changing AI-DLC *itself* | the **code** that reads that data: the orchestrator, hooks, CLI tools, the compile pipeline, the test suite |

The line between this guide and the Developer Reference is **data versus code**.
Everything a harness engineer touches is a Markdown file with YAML frontmatter
or a JSON config — declarative data the framework loads at runtime. Adding a
stage, adding an agent, defining a scope: the framework's own design principle
is that these require *no TypeScript edits*. The moment a change means editing
`.ts` — the orchestrator, a hook, a tool — you've crossed into the Developer
Reference.

---

## The mental model: stages are *what*, agents are *who*

Two primitives carry most of the framework, and keeping them straight is the
whole job:

- A **stage** is a unit of work — *what* happens. It declares the artifacts it
  consumes and produces, the agent that leads it, and how it executes. Stages
  are the nodes of the workflow graph.
- An **agent** is a persona — *who* does the work. It carries a domain
  expertise, a tool allowlist, and a model. Agents are loaded *into* stages.

A stage names its lead agent; an agent never names its stages. This asymmetry
is deliberate: it lets you reassign work (edit the stage) without rewriting the
worker, and add a worker (drop an agent file) without disturbing the workflow
until a stage opts to use it.

Two pieces of machinery move work through these stages, and as a harness
engineer you shape the **data** both of them read. The deterministic **engine**
(`.claude/tools/aidlc-orchestrate.ts`, with its `next` and `report`
subcommands) reads `aidlc-state.md` and the compiled `stage-graph.json`,
decides what runs next, and emits one typed directive. The **conductor**
(`skills/aidlc/SKILL.md`) is a thin forwarding loop that carries each directive
out. Routing lives in the engine; your stage files, scopes, and rules are the
inputs that steer it.

Everything else a harness engineer configures hangs off these two:

- **Scopes** decide *which* stages run for a given kind of work (a bugfix runs
  7 of 32 stages; an enterprise feature runs all of them).
- **Rules** are standing decisions that travel into every workflow — your
  team's "always do it this way."
- **Sensors** are deterministic checks bound to stages — an advisory second
  opinion that fires on every file write.
- **Knowledge** is the domain context agents load before they work.

---

## What you can change without code

| Change | Where | Chapter |
|--------|-------|---------|
| Edit what a stage does | `.claude/aidlc-common/stages/<phase>/<slug>.md` | [Anatomy of a Stage](01-anatomy-of-a-stage.md) |
| Add a brand-new stage | a new file in the right phase directory + graph wiring | [Adding a Stage](02-adding-a-stage.md) |
| Add or modify an agent | `.claude/agents/<name>-agent.md` | [Adding an Agent](03-adding-an-agent.md) |
| Define a scope | `.claude/scopes/aidlc-<name>.md` + per-stage `scopes:` tags | [Scopes](04-scopes.md) |
| Teach a standing rule | `.claude/rules/aidlc-{team,project}.md` | [Rules and the Learning Loop](05-rules-and-the-loop.md) |
| Wire a deterministic check | a sensor manifest + a stage's `sensors:` import | [Sensors](06-sensors.md) |
| Add team domain knowledge | `aidlc-docs/knowledge/<agent>-agent/` | [Team Knowledge](07-team-knowledge.md) |
| Shape Construction and swarm posture | `.claude/rules/` + the `units-generation` stage | [Construction and the Swarm](08-construction-and-swarm.md) |

Each chapter narrates the *how* and links down to the
[Developer Reference](../reference/00-overview.md) for the exhaustive schema —
the reference is the normative contract; this guide is the working narrative.

---

## When you cross into the Developer Reference

Reach for the [Developer Reference](../reference/00-overview.md) when your
change is to the framework's code rather than its data:

- The orchestrator's routing or state machine
  ([Orchestrator](../reference/03-orchestrator.md),
  [State Machine](../reference/12-state-machine.md)) — for the normative
  engine/conductor/directive/runner/scope-shape/swarm contract, see
  [The Skill System](../reference/17-skill-system.md)
- A hook or a CLI tool ([Hooks and Tools](../reference/06-hooks-and-tools.md))
- The stage-graph compile pipeline or the audit event taxonomy
- The test suite ([Testing](../reference/09-testing.md))

Adding a stage or an agent *touches* the workflow graph but does not change the
code that reads it — that's why it lives here. Changing how the graph is
compiled, or adding a new audit event, is a code change — that lives there.

---

## How this guide is organized

Read it in order the first time:

1. **[Anatomy of a Stage](01-anatomy-of-a-stage.md)** — the stage file format:
   frontmatter contract, the three-compartment body, how the graph compiles.
   The single most important thing to understand before changing anything.
2. **[Adding a Stage](02-adding-a-stage.md)** — end-to-end: author the file,
   wire the dependency edges, compile, watch it appear in a scope.
3. **[Adding an Agent](03-adding-an-agent.md)** — author a persona and bind it
   to the stages it leads or supports.
4. **[Scopes](04-scopes.md)** — define and tune the scope-to-stage mapping.
5. **[Rules and the Learning Loop](05-rules-and-the-loop.md)** — author rules
   across the layer chain, and let the loop promote corrections into rules.
6. **[Sensors](06-sensors.md)** — author a deterministic check and bind it to
   stages.
7. **[Team Knowledge](07-team-knowledge.md)** — give agents your domain
   context.
8. **[Construction and the Swarm](08-construction-and-swarm.md)** — set the
   team's Construction autonomy posture in the rule layer, and shape what the
   per-Unit Bolt swarm can run in parallel through `units-generation`.

## Next

Start with [Anatomy of a Stage](01-anatomy-of-a-stage.md) — the format every
other change builds on.
