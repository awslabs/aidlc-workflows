# Spaces and Intents

[Your First Workflow](02-your-first-workflow.md) walked through one run from start
to finish. But real work is rarely one thing at a time: you have a feature in
flight, an urgent bug lands, a second team shares the repo. This chapter explains
how AI-DLC organizes **many** pieces of work in **one** place — the *workspace* —
and the two concepts you use to navigate it: **spaces** and **intents**.

The short version: an **intent** is one piece of work (one run of the lifecycle);
a **space** is one team's world of intents, knowledge, and practices. Most people
work in a single space (called `default`) and never think about spaces at all —
they just start intents and switch between them. The rest of this chapter shows
how that works and where everything lives.

---

## One workspace, organized by what you're working on

When you install AI-DLC you copy its engine into your project — a single
harness-specific directory (`.claude/` on Claude Code, `.kiro/` on Kiro,
`.codex/` on Codex). That directory is the *only* part of the layout that
differs by harness. From then on, everything AI-DLC produces lives under one
neutral `aidlc/` directory at your project root — organized by *what you're
working on*, not by which harness you happen to run. You browse `aidlc/`; you
never need to open the engine directory.

Here is a complete workspace with two teams and a few intents in flight (the
engine directory is shown as `.claude/` — read it as `.kiro/` or `.codex/` on
those harnesses). Read it top to bottom — it is the mental model the rest of
this chapter builds on:

```
my-project/
│
├── .claude/                      THE ENGINE — tools, hooks, skills, agents.
│                                 (or .kiro/ / .codex/ — the one harness-specific dir)
│                                 You never browse this; it just runs /aidlc.
│
├── aidlc/                        EVERYTHING AI-DLC — neutral, browsable, committed to git
│   ├── active-space              ← cursor: which space you're in (gitignored, per-user)
│   └── spaces/
│       ├── default/              ★ the only space most people ever see
│       │   ├── memory/           THE METHOD — how this team works (committed)
│       │   │   ├── org.md          framework defaults
│       │   │   ├── team.md         your team's practices  (overrides org)
│       │   │   ├── project.md      project-specific practices (overrides team)
│       │   │   ├── phases/         phase-scoped rules
│       │   │   └── templates/      your output-format overrides, one per artifact
│       │   │
│       │   ├── knowledge/        DOMAIN KNOWLEDGE — standards an agent reads (committed)
│       │   │                       free-form; empty until you add files
│       │   ├── codekb/           CODE KNOWLEDGE — what each repo is (committed, per-repo)
│       │   │   └── <repo>/          architecture, component inventory, freshness marker
│       │   │
│       │   └── intents/          THE RECORD — one subdir per piece of work
│       │       ├── active-intent   ← cursor: which intent is current (gitignored)
│       │       ├── intents.json    the registry: every intent + its scope/repos/status
│       │       ├── 260620-inventory-api/        ✓ a completed intent
│       │       └── 260624-export-bug/           ◷ an in-flight intent
│       │           ├── aidlc-state.md             where this intent is in the lifecycle
│       │           ├── audit/                     the decision trail
│       │           └── inception/requirements-analysis/requirements.md   …artifacts
│       │
│       └── payments-team/        another SPACE (another team) — identical shape
│           └── memory/  knowledge/  codekb/  intents/
│
├── repo-a/                       YOUR CODE REPOS live as siblings (each its own git)
└── repo-b/                       an intent can span more than one
```

Three things are worth pulling out of that tree, because they are the whole idea:

- **`aidlc/spaces/<space>/`** is one team's self-contained world: its method
  (`memory/`), its knowledge, its code knowledge, and its record of every intent.
  You get `spaces/default/` for free and, as a solo developer or single team,
  never look past it.
- **`intents/<YYMMDD>-<label>/`** is one piece of work — the per-run record that
  [Your First Workflow](02-your-first-workflow.md) filled in. The `<YYMMDD>` is a
  compact UTC date so records sort chronologically; the `<label>` is a short,
  human-readable name. Identity itself is carried by a UUIDv7 in the registry, not
  the dir name, so two same-day same-label intents stay distinct.
- **Two cursors** — `active-space` and `active-intent` — record *where you are
  right now*. They are per-user (gitignored), so two teammates can sit in
  different intents at the same time without fighting over a shared file.

> **Upgrading from an older version?** Earlier releases kept a single workflow in
> one flat directory at the project root, which a new run would overwrite. The
> workspace model replaces that with the per-intent record dirs above, so you can
> keep many pieces of work side by side without one clobbering another.

---

## Intents — one per piece of work

An **intent** is a single run of the AI-DLC lifecycle, scoped to one task. Every
intent owns a row in the space's `intents.json` registry — `{uuid, slug, dirName,
scope, repos, status}` — and a **record dir** holding that run's state, audit
trail, and artifacts. The `uuid` (a UUIDv7) is the canonical, collision-proof
identity; `dirName` records the human-readable record-dir name verbatim.

You never create an intent with a special command. The first time you describe
work, the engine **auto-births** an intent for you:

```
/aidlc Build a REST API for inventory management
```

On a fresh workspace this mints the intent, creates its record dir at
`aidlc/spaces/default/intents/260624-inventory-api/`, makes it the active intent,
and starts the first stage — exactly the run you saw in the previous chapter.

### Starting a second piece of work

Here is where the workspace earns its keep. Say you're mid-feature and an
unrelated bug needs attention. You don't archive anything or run an init command —
you just describe the new work:

```
/aidlc Fix the timeout on the export endpoint
```

When an intent is already active, AI-DLC recognizes that this is *new, unrelated*
work rather than a continuation of the current feature, and **offers** to start a
second intent alongside the first:

```
▸ This looks like new work, separate from "inventory-api". Start a second intent?
  (1) Yes — start a second intent (scope: bugfix)
  (2) No — this continues the inventory-api work
```

- Choose **Yes** and AI-DLC births a second intent (here, a `bugfix`), switches to
  it, and begins its first stage. Your inventory-api intent is untouched — its
  record dir, state, and progress are all preserved exactly where you left them.
- Choose **No** and AI-DLC treats your message as part of the active intent.

AI-DLC never births a second intent without asking. If a prompt is genuinely a
follow-up to the current work — answering a gate, correcting a requirement — it
stays in the active intent; the offer only appears when the work is clearly
distinct.

### Switching between intents

List the intents in your space, then switch to one by name (its slug):

```
/aidlc intent                     List all intents in the active space
/aidlc intent export-bug          Switch the active intent to "export-bug"
```

Switching moves the `active-intent` cursor. The next `/aidlc` resumes that intent
right where it stopped — same stage, same state, same audit trail. You can carry
any number of intents at once and move between them freely; each is an independent
run.

> Bare `/aidlc intent` is read-only — it just lists. Add `--json` for
> machine-readable output. See [CLI Commands](12-cli-commands.md) for the full
> flag reference.

---

## Spaces — one per team

A **space** is one team's complete world: its own `memory/` (method), `knowledge/`,
`codekb/`, and `intents/`. Everything in this chapter so far happened inside a
single space named `default`, which is created for you automatically. **If you're a
solo developer or a single team, that's the end of the story — you never name a
space and everything just works.**

Spaces exist for the case where **more than one team shares one project** and each
wants its own method, knowledge, and record without colliding. Adding a team is
purely additive: a new `spaces/<name>/` of the identical shape appears beside
`default/` — nothing moves, nothing migrates.

Create, list, and switch spaces with verbs that mirror the intent verbs exactly:

```
/aidlc space                      List all spaces
/aidlc space create payments-team Create a new space, seeded from the framework baseline
/aidlc space switch payments-team Switch the active space to "payments-team"
```

The older `/aidlc space-create <name>` and bare `/aidlc space <name>` forms are
still accepted.

A newly created space starts with the framework's default method (`org.md`) and
fresh, empty `team.md` / `project.md` practice files — a new team earns its own
practices rather than inheriting another team's. Its `knowledge/` and `codekb/`
start empty too.

When you switch spaces, two things follow the cursor automatically:

1. **AI-DLC's own resolvers** — the next intent you start, and the practices and
   knowledge agents load, all come from the space you switched into.
2. **The rules your harness loads into context** — switching re-points your
   harness's native rule include (Claude's `@`-import, Kiro's resources glob,
   Codex's rules dir) at the new space's `memory/`, so the next turn works under
   that team's method.

At `default` this re-pointing is a no-op, which is why a single-team workspace
never churns its committed files.

### Knowing which space you're in

When more than one space exists, the status line shows the active `space · intent`
as a persistent "you are here" — the same way a shell prompt shows your current
directory — so work never lands in the wrong space. A single-team user, having
only `default`, sees no space token at all.

---

## Multiple repos in one intent

An intent isn't limited to a single repository. Because your code repos are
siblings of the workspace (not nested inside any one of them), an intent can span
as many as it needs.

The repo set is captured **when the intent is born** — you don't type anything
extra. By default AI-DLC auto-discovers every sibling repo (each immediate child
of the workspace root that has its own `.git`) and records the set in the intent's
`intents.json` row. During Construction, each git operation is then anchored to
the right repo automatically.

```
my-project/
├── aidlc/          # the workspace
├── checkout-api/   # repo-a   ┐ both auto-discovered as siblings;
└── checkout-web/   # repo-b   ┘ an intent here can touch either or both
```

An intent that records no repos is the ordinary single-repo case. See
[Artifacts Reference](14-artifacts-reference.md) for the record-dir details and
[Multi-repo intent](glossary.md) in the glossary.

---

## What's committed and what's not

`aidlc/` is checked into git so a team **shares** its work — the method, the intent
registry, each intent's state, audit trail, and artifacts all travel with the
repo. Two kinds of file are deliberately **gitignored** instead:

| Gitignored (per-user, machine-local) | Why |
|---|---|
| `aidlc/active-space`, `…/intents/active-intent` | Cursors — "where am I right now." Committing them would dirty the tree on every `/aidlc` and have teammates fight over the cursor on each switch. |
| `…/intents/<id>/runtime-graph.json`, `.aidlc-*`, `aidlc/.aidlc-sessions/` | Derived, machine-local runtime state. |

Everything else under a space — `memory/**`, `knowledge/**`, `codekb/**`,
`intents.json`, each record's `aidlc-state.md`, `audit/` shards, and artifacts — is
committed. The rule of thumb: **cursors and runtime scratch are local; the shared
work is committed.**

---

## Next Steps

- [Phases and Stages](04-phases-and-stages.md) — what happens inside one intent's run
- [Knowledge](08-knowledge.md) — adding your team's standards to a space's `knowledge/`
- [Rules and the Learning Loop](09-rules-and-the-learning-loop.md) — how a space's `memory/` method is authored and learned
- [Artifacts Reference](14-artifacts-reference.md) — the per-intent record dir in detail
- [CLI Commands](12-cli-commands.md) — the full `space` / `intent` verb reference
- [Glossary](glossary.md) — Space, Intent, Record dir, and Multi-repo intent defined
```
