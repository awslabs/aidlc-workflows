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

**Tier 2 — team knowledge** is yours. It lives under `aidlc-docs/knowledge/` in
your project, alongside the artifacts a workflow produces. It holds your
company-specific standards, policies, and conventions. The framework never
overwrites it, and it persists across every workflow. This is the directory you
populate.

The two-tier split is the same data-versus-code line the rest of this guide
rests on, applied to knowledge: the framework owns its methodology, you own
your context, and an upgrade can replace one without touching the other. The
full directory shapes for both tiers are in
[Knowledge System → Two-Tier Architecture](../reference/10-knowledge-system.md#two-tier-architecture).

---

## Team-wide versus agent-specific placement

Tier 2 mirrors the agent layout: a `aidlc-shared/` directory plus one directory
per agent. Where you drop a file decides which agents load it.

| Placement | Loaded by | Use it for |
|-----------|-----------|------------|
| `aidlc-docs/knowledge/aidlc-shared/` | **every** agent, on every stage | cross-cutting standards — naming conventions, commit format, the project's domain glossary |
| `aidlc-docs/knowledge/<agent>-agent/` | **only** that agent, only when it's the active lead | domain context for one role — architecture patterns for the architect, security policy for devsecops |

The directory name must match the agent slug exactly — `aidlc-architect-agent/`,
not `architect/`. A typo in the directory name is the most common reason a
file is silently ignored: the framework walks the agent's own directory by
name, finds nothing, and moves on without an error. (This is why scaffolding
with `--init`, below, is worth the one command — it creates every directory with
the right name.)

Reach for `aidlc-shared/` only when a standard genuinely applies across all 11
agents. A pattern that matters to the architect and no one else belongs in
`aidlc-architect-agent/`, where it adds context to architecture stages without
diluting every other agent's window. The
[Adding Company Standards worked example](../guide/07-knowledge.md) in the User
Guide carries a full end-to-end walk-through — scaffold, write, verify — that's
worth reading once before you author your first file.

For the per-agent table of what each directory is for, see
[Knowledge System → Adding Team Knowledge](../reference/10-knowledge-system.md#adding-team-knowledge).

---

## How an agent loads knowledge

You don't register a knowledge file or wire it anywhere. Its presence in the
right directory is the registration. When a stage begins, the conductor
loads context in a fixed six-step order, and your Tier 2 files come in at steps
4 and 5:

1. Rules — the resolved `.claude/rules/` chain (loaded first)
2. Tier 1 shared methodology — `.claude/knowledge/aidlc-shared/`
3. Tier 1 agent methodology — `.claude/knowledge/<agent>-agent/`
4. **Tier 2 team shared** — `aidlc-docs/knowledge/aidlc-shared/`
5. **Tier 2 team agent-specific** — `aidlc-docs/knowledge/<agent>-agent/`
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
`aidlc-docs/knowledge/aidlc-architect-agent/`. A non-negotiable like "every
architecture decision must record at least two alternatives" is a rule: it
belongs in `.claude/rules/`, where the framework will hold the agent to it. For
authoring rules across the layer chain and letting the learning loop promote
corrections into them, see
[Rules and the Learning Loop](05-rules-and-the-loop.md). The User Guide's
[Knowledge vs Rules table](../guide/07-knowledge.md) covers the same call with
more examples.

---

## Scaffolding with `/aidlc --init`

Before hand-creating any `aidlc-docs/knowledge/` directories, run:

```
/aidlc --init
```

This builds the full Tier 2 tree — `aidlc-shared/` plus one directory per agent —
and seeds each with a README that explains what to add and gives
agent-specific examples. The READMEs are generated from a template that ships in
Tier 1; you never write them by hand. Scaffolding first prevents the typo'd
directory name that causes files to be silently skipped, because every
directory is created with the slug the loader expects.

The READMEs also restate the no-naming-convention rule: any `.md` file in a
directory is loaded. Descriptive, one-topic-per-file names
(`api-gateway-standards.md`, not `architecture.md`) aren't required by the
loader, but they make the quarterly prune far easier. The template system that
generates these READMEs is documented in
[Knowledge System → Template System](../reference/10-knowledge-system.md#template-system).

A note on the boundary with the rest of this guide: the agent directories you
populate here are the same ones an agent declares in its persona file. When you
[add an agent](03-adding-an-agent.md), its Tier 2 knowledge directory is
`aidlc-docs/knowledge/<new-agent-slug>/` — scaffolded the same way, loaded at
the same steps 4 and 5. The mental model from the
[overview](00-overview.md) holds: the stage names the agent and the agent
reads the knowledge, and you shape all of it by editing data rather than
writing code.

## Next

- Back to [the Harness Engineer Guide overview](00-overview.md) for the full
  map of what you can change without code.
- [Developer Reference](../reference/00-overview.md) for code-level changes —
  the orchestrator, hooks, and the compile pipeline that read this data.
