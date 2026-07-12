# Harness Engineer Guide

> Part of the [AI-DLC documentation](../README.md) · [User Guide](../guide/00-introduction.md) · **Harness Engineer Guide** · [Developer Reference](../reference/00-overview.md)

AI-DLC is a methodology, and this implementation ships it working out of the box
on the harness you use — Claude Code, Kiro CLI, Kiro IDE, Codex CLI, or opencode: 14 agents
(11 domain experts, 2 reviewers, and the composer), 32 stages, 9 scopes, a set
of rules and sensors. This guide is for the person who
wants to **reshape** that methodology — change which stages run, add an agent for
a domain the framework doesn't cover, tighten a scope, teach the framework a
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
(`core/tools/aidlc-orchestrate.ts`, with exactly three subcommands: `next`,
`report`, and `park`) reads `aidlc-state.md` and the compiled `stage-graph.json`,
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

You author all of these in `core/` — the hand-authored, harness-neutral source
— then regenerate the per-harness trees (see [The build model](#the-build-model-author-in-core-regenerate-the-harnesses) below).

| Change | Where you author it | Chapter |
|--------|-------|---------|
| Edit what a stage does | `core/aidlc-common/stages/<phase>/<slug>.md` | [Anatomy of a Stage](01-anatomy-of-a-stage.md) |
| Add a brand-new stage | a new file in the right phase directory + graph wiring | [Adding a Stage](02-adding-a-stage.md) |
| Add or modify an agent | `core/agents/<name>-agent.md` | [Adding an Agent](03-adding-an-agent.md) |
| Define a scope | `core/scopes/aidlc-<name>.md` + per-stage `scopes:` tags | [Scopes](04-scopes.md) |
| Teach a standing rule | `core/memory/{team,project}.md` | [Rules and the Learning Loop](05-rules-and-the-loop.md) |
| Wire a deterministic check | a sensor manifest under `core/sensors/` + a stage's `sensors:` import | [Sensors](06-sensors.md) |
| Add team domain knowledge | `aidlc/knowledge/<agent>-agent/` (the space-level knowledge dir, at runtime) | [Team Knowledge](07-team-knowledge.md) |
| Shape Construction and swarm posture | `core/memory/` + the `units-generation` stage | [Construction and the Swarm](08-construction-and-swarm.md) |

Each chapter narrates the *how* and links down to the
[Developer Reference](../reference/00-overview.md) for the exhaustive schema —
the reference is the normative contract; this guide is the working narrative.

One row is the exception: **team domain knowledge** is the context *you* add in
your own project at the space level (`aidlc/knowledge/`, a sibling of the space's
`memory/`, `codekb/`, and `intents/`), at runtime — it is not part of `core/` and
the framework never overwrites it. Everything else above is framework source you
author in `core/`.

## Naming rules and where they are enforced

Stage filename stems must equal frontmatter `slug`; `aidlc-graph compile` rejects
stem mismatches and duplicate stage slugs as hard errors. Sensor filename/id
checks are compile-time hard errors. Scope and agent duplicate declared names are
loader errors that name both files; scope/agent filename-to-name drift is reported
by `/aidlc --doctor` as an advisory so authors can rename the file or fix `name`.

---

## The build model: author in `core/`, regenerate the harnesses

Everything a harness engineer authors lives in **`core/`** — the hand-authored,
harness-neutral source of truth (stages under `core/aidlc-common/stages/`,
agents under `core/agents/`, scopes, rules, sensors, knowledge, tools, hooks).
The per-harness `dist/<harness>/` trees you actually run (`dist/claude/.claude/`,
`dist/kiro/.kiro/`, `dist/kiro-ide/.kiro/`, `dist/codex/`, and
`dist/opencode/`) are **generated**
from `core/` plus a thin `harness/<name>/` surface, and they are
**drift-guarded** — a hand-edit there is rejected by CI. The loop is always:

```bash
# 1. edit the source in core/ (never dist/)
$EDITOR core/aidlc-common/stages/inception/my-stage.md

# 2. regenerate every harness tree from core/ + harness/
bun scripts/package.ts

# 3. confirm no drift (the CI guard; run before committing)
bun scripts/package.ts --check
```

Commit the `core/` edit and the regenerated `dist/` together. When a recipe in
the chapters below says to run `bun .claude/tools/aidlc-graph.ts compile` (or
another tool), that command runs against an *installed* tree — your project's
`.claude/` (or `.kiro/` / `.codex/`) — to recompile the graph at runtime; it is
not where you author. **You author in `core/`; the tools run in the harness
directory.** That split — authored source vs. generated runtime — is the one to
keep straight throughout this guide. For the full build contract see
[Porting to a New Harness](09-porting-to-a-new-harness.md) and the Developer
Reference's [Architecture § Source vs distribution](../reference/01-architecture.md#source-vs-distribution-one-core-many-harnesses).

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
9. **[Porting to a New Harness](09-porting-to-a-new-harness.md)** — add another
   CLI harness with one `harness/<name>/` directory and a manifest row, no
   `core/` edits: the manifest contract, the hook adapter, and `emit.ts`.
10. **[Authoring a Plugin](10-authoring-a-plugin.md)** — package a reusable,
    optional **AIDLC plugin** in `plugins/<name>/`: new stages/agents/scopes/
    sensors + additive contributions to existing core stages, emitted as a real
    host plugin per harness. Design in the Developer Reference's single chapter
    ([18 mechanism](../reference/18-plugin-mechanism.md)).

## Next

Start with [Anatomy of a Stage](01-anatomy-of-a-stage.md) — the format every
other change builds on.
