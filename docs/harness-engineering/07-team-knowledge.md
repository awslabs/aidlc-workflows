# Team Knowledge

Knowledge is the domain context an agent reads before it works: your coding
standards, your architecture preferences, your domain glossary, the patterns
your team has settled on. It is the one part of the harness you shape by adding
files an agent reads, rather than constraints the framework enforces. This
chapter walks the workflow for giving agents that context — where the files go,
which agents see them, and the judgment call between knowledge and a rule.

If you've read [Rules and the Learning Loop](05-rules-and-the-loop.md), keep
the distinction in mind throughout: rules are standing decisions the framework
enforces; knowledge is reference material an agent weighs while it works. Both
shape agent behavior, but they sit on different planes and load differently.

---

## Two tiers: framework knowledge and yours

AI-DLC's knowledge is split into two tiers, and only one of them is yours to
edit.

**Tier 1 — methodology knowledge** ships with this implementation under
`.claude/knowledge/`. It holds the methodology references each agent uses to
run a stage — `aidlc-architect-agent/architecture-guide.md`,
`aidlc-developer-agent/code-generation-guide.md`, and the cross-agent material
in `aidlc-shared/`. **Leave it alone.** These files are overwritten on every
framework upgrade. Anything you add there disappears the next time the team
pulls a new version.

**Tier 2 — team knowledge** is yours. It lives at the space level under
`aidlc/knowledge/` (shorthand for `aidlc/spaces/<space>/knowledge/`), a sibling
of the space's `memory/`, `codekb/`, and `intents/` — so it accumulates across
every intent in the space rather than being trapped in one intent's record. It
holds your company-specific standards, policies, and conventions. The framework
never overwrites it; the engine just creates the empty `aidlc/knowledge/`
directory on the first `/aidlc` and leaves the contents to you. This is the
directory you populate. (Standing practices the framework should *enforce* —
rather than reference material an agent weighs — live in the space's memory
layer at `aidlc/spaces/<active-space>/memory/` instead.)

The two-tier split is the same data-versus-code line the rest of this guide
rests on, applied to knowledge: the framework owns its methodology, you own
your context, and an upgrade can replace one without touching the other. The
full directory shapes for both tiers are in
[Knowledge System → Two-Tier Architecture](../reference/10-knowledge-system.md#two-tier-architecture).

---

## Team-wide versus agent-specific placement

Tier 2 follows the agent layout by convention: a `aidlc-shared/` directory plus
one directory per agent, all under the space-level `aidlc/knowledge/`. Where you
drop a file decides which agents load it.

| Placement | Loaded by | Use it for |
|-----------|-----------|------------|
| `aidlc/knowledge/aidlc-shared/` | **every** agent, on every stage | cross-cutting standards — naming conventions, commit format, the project's domain glossary |
| `aidlc/knowledge/<agent>-agent/` | **only** that agent, only when it's the active lead | domain context for one role — architecture patterns for the architect, security policy for devsecops |

The directory name must match the agent slug exactly — `aidlc-architect-agent/`,
not `architect/`. A typo in the directory name is the most common reason a
file is silently ignored: the framework walks the agent's own directory by
name, finds nothing, and moves on without an error. The engine does not create
these subdirectories for you — `aidlc/knowledge/` is empty at bootstrap (see
below), so you create each directory yourself with the exact slug.

Reach for `aidlc-shared/` only when a standard genuinely applies across all 11
agents. A pattern that matters to the architect and no one else belongs in
`aidlc-architect-agent/`, where it adds context to architecture stages without
diluting every other agent's window. The
[Adding Company Standards worked example](../guide/08-knowledge.md) in the User
Guide carries a full end-to-end walk-through — create the directory, write,
verify — that's worth reading once before you author your first file.

For the per-agent table of what each directory is for, see
[Knowledge System → Adding Team Knowledge](../reference/10-knowledge-system.md#adding-team-knowledge).

---

## How an agent loads knowledge

You don't register a knowledge file or wire it anywhere. Its presence in the
right directory is the registration. When a stage begins, the conductor
loads context in a fixed six-step order, and your Tier 2 files come in at steps
4 and 5:

1. Rules — the resolved `aidlc/spaces/<active-space>/memory/` chain (loaded first)
2. Tier 1 shared methodology — `.claude/knowledge/aidlc-shared/`
3. Tier 1 agent methodology — `.claude/knowledge/<agent>-agent/`
4. **Tier 2 team shared** — `aidlc/knowledge/aidlc-shared/`
5. **Tier 2 team agent-specific** — `aidlc/knowledge/<agent>-agent/`
6. Prior stage artifacts — outputs the current stage declares it consumes

Steps 4 and 5 only fire if the directories exist and contain files, which is
why a project with no team knowledge simply skips them. Because the load
happens at every stage start, editing a file takes effect on the next `/aidlc`
run with no cache to clear and no restart. Removing a file is just as direct —
delete it, and subsequent runs stop seeing it. There is no registry to keep in
sync.

One consequence worth internalizing: agents read knowledge files **literally
and at equal weight**. An outdated or contradictory file actively misleads an
agent — it carries the same authority as a current one. Treat the Tier 2 tree
like code that needs pruning; a short review during retro keeps it honest.

The full step-by-step contract, the priority rules, and the sequence diagram
are in
[Knowledge System → 6-Step Knowledge Loading Order](../reference/10-knowledge-system.md#6-step-knowledge-loading-order).

---

## Knowledge or a rule?

The most common harness-engineer mistake is reaching for knowledge when the
intent is a rule, or the reverse. They are not interchangeable, and the loading
order above shows why: rules resolve first as a strict-additive chain the
framework compiles ahead of the run; knowledge is reference material the agent
weighs during the stage.

A useful test: **if a human reviewer would reject a stage's output when the
instruction is violated, it belongs in a rule.** If they'd use it as background
when reviewing, it's knowledge.

| Reach for knowledge when… | Reach for a rule when… |
|---------------------------|------------------------|
| You're supplying reference material the agent should consult | You're stating a behavioral decision the agent must follow |
| "These are the patterns we use" | "Never do X" / "Always do Y" |
| The content is informative and contextual | The content is prescriptive and non-negotiable |
| It can be long-form prose, tables, or diagrams | It should be short, imperative, one line each |
| Example: API Gateway standards, a domain glossary | Example: "Never log PII", "All data access goes through the repository layer" |

So a document describing how your team designs APIs is knowledge: drop it in
`aidlc/knowledge/aidlc-architect-agent/`. A non-negotiable like "every
architecture decision must record at least two alternatives" is a rule: it
belongs in the space memory layer (`aidlc/spaces/<active-space>/memory/`), where the framework will hold the agent to it. For
authoring rules across the layer chain and letting the learning loop promote
corrections into them, see
[Rules and the Learning Loop](05-rules-and-the-loop.md). The User Guide's
[Knowledge vs Rules table](../guide/08-knowledge.md) covers the same call with
more examples.

---

## Where the Tier 2 tree comes from

The team builds it. On the first `/aidlc` the engine creates a single empty
directory — `aidlc/knowledge/` — and stops there. It does not scaffold a tree,
create per-agent subdirectories, or seed any READMEs. The Tier 2 layout
(`aidlc-shared/` plus one directory per agent) is the convention the personas
look for, not a structure the engine writes; you create the directories you have
content for. Because the loader walks each agent's own directory by name, create
them with the exact slug the loader expects (`aidlc-architect-agent/`, not
`architect/`) — a typo'd name is silently skipped with no error.

There's no naming convention inside a directory: any `.md` file is loaded.
Descriptive, one-topic-per-file names (`api-gateway-standards.md`, not
`architecture.md`) aren't required by the loader, but they make the quarterly
prune far easier. If you want a starting README for a directory, Tier 1 ships an
optional template you can copy in by hand —
[Knowledge System → Template System](../reference/10-knowledge-system.md#template-system).

A note on the boundary with the rest of this guide: the agent directories you
populate here are the same ones an agent declares in its persona file. When you
[add an agent](03-adding-an-agent.md), its Tier 2 knowledge directory is
`aidlc/knowledge/<new-agent-slug>/` — a directory the team creates, loaded at
the same steps 4 and 5. The mental model from the
[overview](00-overview.md) holds: the stage names the agent and the agent
reads the knowledge, and you shape all of it by editing data rather than
writing code.

---

## Spaces: knowledge for more than one team

Everything above assumes one team. When **more than one team shares a project**,
AI-DLC keeps each team's method, knowledge, and record in its own **space** — a
`aidlc/spaces/<name>/` of identical shape (`memory/`, `knowledge/`, `codekb/`,
`intents/`). The `aidlc/knowledge/` shorthand you've been using throughout this
chapter is really `aidlc/spaces/<active-space>/knowledge/`; with a single team
that active space is always `default` and the distinction never surfaces. (The
[User Guide's Spaces and Intents chapter](../guide/03-spaces-and-intents.md) is
the end-user orientation; this section is the harness-engineering angle.)

What this means for the knowledge and rules you author:

- **Team knowledge is per-space.** The `aidlc/knowledge/aidlc-<agent>-agent/`
  files you populate live inside one space. A second team gets its own empty
  `knowledge/` tree to fill — your files do not leak across the boundary, and
  theirs do not dilute your agents' context.
- **The method layer is per-space too.** The rules in `aidlc/spaces/<active-space>/memory/`
  (`org.md` → `team.md` → `project.md`) resolve within the active space. A new
  space is seeded from the framework baseline — `org.md` copied in, fresh empty
  `team.md` / `project.md` — so a new team starts from the framework's defaults
  and earns its own practices rather than inheriting another team's.
- **You don't author spaces in `core/`.** A space is runtime team data, created
  with `/aidlc space create <name>` in an installed project - the same
  data-not-code line that separates team knowledge from framework source. There
  is nothing to add to `core/` or regenerate to support multiple teams; the
  capability ships in the engine.

The mental model from this chapter holds inside each space unchanged: the stage
names the agent, the agent reads the knowledge, and you shape it all by editing
data. A space simply scopes *whose* data — so two teams can run AI-DLC in one
project without their context, practices, or records colliding.

## Next

- Back to [the Harness Engineer Guide overview](00-overview.md) for the full
  map of what you can change without code.
- [Developer Reference](../reference/00-overview.md) for code-level changes —
  the orchestrator, hooks, and the compile pipeline that read this data.
