# AIDLC Plugin System — Vision

> **Status:** Vision / target-state. Describes the completed plugin system.
> Written in the present tense as if finished — it is the destination, not a
> record of what ships today. Where it departs from current behavior, that gap is
> the implementation work ([doc 21](21-plugin-implementation-plan.md)).
>
> Companions: [18 — Plugin Mechanism](18-plugin-mechanism.md) (normative spec),
> [19 — Composition Timing](19-plugin-composition-timing.md) (why install-time),
> [21 — Implementation Plan](21-plugin-implementation-plan.md), and the author
> guide [10 — Authoring a Plugin](10-authoring-a-plugin.md).

## 1. One sentence

AIDLC is a small immutable **core** plus an open ecosystem of **AIDLC plugins**
— optional, owned, versioned sets of stages, agents, scopes, method/rules,
sensors, and additive contributions to existing core stages — **emitted as real
host plugins** by the packager and installed through each host's native commands.
A SessionStart hook composes on install (Claude/Codex); a thin `aidlc plugin
compose` does the same for Kiro. We run no distribution infrastructure.

## 2. The model in one picture

```
              author once (harness-neutral)
<plugin>/  ───────────────────────────────────────┐
  .aidlc-plugin/plugin.json (source manifest)     │
  stages/ agents/ scopes/ memory/ sensors/        │
  contributions/<phase>/<slug>.md  (the seam)     │
                                                  ▼
                                    ┌──────────────────────┐
                                    │    THE PACKAGER       │
                                    │  (one more projection │
                                    │   target per harness) │
                                    └──────┬───────────────┘
           ┌───────────────────────────────┼────────────────────────────┐
           ▼                               ▼                            ▼
  .claude-plugin/plugin.json    .codex-plugin/plugin.json      .kiro/ tree
  + SessionStart compose hook   + SessionStart compose hook    (folder-drop)
           │                               │                            │
           ▼                               ▼                            ▼
  /plugin install ──────────▶   codex plugin add ──────────▶  aidlc plugin compose
  (host store, auto-compose)    (host store, auto-compose)    (thin CLI, manual)
           │                               │                            │
           └───────────────────────────────┼────────────────────────────┘
                                           ▼
                      effective install: core + chosen plugins
             (stages set-unioned, prose fragments ordered, predicates resolved)
```

The plugin **IS** a host plugin. The packager already cross-compiles per harness;
emitting a real `.claude-plugin/` or `.codex-plugin/` is one more projection
target. Customers host their own plugins (git repo + semver tags +
`marketplace.json`); we run nothing.

## 3. What a plugin is (unchanged from doc 18)

A plugin is a self-contained, harness-neutral tree authored once and projected
into every harness. It can:

- **add** new stages (numbers are display-only, no range to claim), agents,
  scopes, method/rules (into the memory seed), and sensors;
- **modify** existing core stages **additively** via the contribution seam —
  set-unioning `produces`/`consumes`/`sensors`/`requires_stage`/`required_sections`/`scopes`
  into the stage node and splicing ordered prose `fragments` at named anchors;
- never edit `core/`, and never override or remove — additive-only is a hard
  boundary (doc 18 §6).

The contribution seam is the system's differentiator: it is structurally VS
Code `contributes` + Cargo feature-union — the best-composing model in the field
(doc 19 §6.3) — and it is available to **every** plugin, first- and third-party
alike. No gatekeeping.

## 4. Distribution: the hybrid

An AIDLC plugin is distributed differently depending on the host — because the
hosts are genuinely different shapes (confirmed by real probes,
`spikes/dist-probe/RESULTS.md`):

| Host | Distribution | Compose trigger | Agents | Trust |
|---|---|---|---|---|
| **Claude** | real plugin, host store | SessionStart hook (eager) | ✅ | managed allowlist |
| **Codex** | real plugin, host store | SessionStart hook (lazy, first turn) | ❌ no agent surface | one-time trust, hash-pinned |
| **Kiro** (CLI/IDE) | folder-drop (no store) | `aidlc plugin compose` / `.kiro.hook` (lazy, promptSubmit) | ✅ full | n/a |

**The user story (platform team):** You're shipping AIDLC plugins to product
teams, some on Claude, some on Codex, some on Kiro. You publish once:

1. Author against `core/`, run the packager — it spits out per-harness plugins.
2. Push them to a git repo you own with semver tags.
3. Drop a `marketplace.json` in (one repo can list everything — one entry works
   on any harness).

Then teams **install themselves:**
- **Claude:** `/plugin marketplace add` on your repo + `/plugin install` — a
  SessionStart hook composes, done.
- **Codex:** same two commands; approve the hook trust prompt once (it's
  content-hash-pinned, won't re-prompt until the hook changes); compose fires on
  first interaction.
- **Kiro:** no store — `git pull` your repo + `aidlc plugin compose` (or the IDE
  discovers the `.kiro/` tree from the folder-drop and the `.kiro.hook` composes
  on first prompt).

Rolling out a new version = bump a tag. Trust controls are the host's own
managed mechanism (Claude: `strictKnownMarketplaces`, unoverridable; Codex:
policy controls + hash-pinned trust). For teams not on a host store at all, you
keep a plain git repo and point them at it — same shape as the marketplace.

> **Codex caveat:** no agent surface (confirmed gap). Plugins run on Codex but
> without persona-specialized agents — accepted tradeoff (doc 19 probes).

## 5. The install path, end to end

### 5.1 Claude (zero-touch install)

```bash
# in a Claude Code session:
/plugin marketplace add <your-org>/<your-plugin-repo>
/plugin install <plugin-name>@<marketplace>
# done — SessionStart hook composes on next session
```

The hook fires **eagerly** (on session spawn), writes the composed tree into the
project, and the workflow runs against it immediately. `CLAUDE_PROJECT_DIR`,
`CLAUDE_PLUGIN_ROOT`, and `CLAUDE_PLUGIN_DATA` are all available to the hook.

### 5.2 Codex (one-time trust, then zero-touch)

```bash
# in Codex CLI:
codex plugin marketplace add <your-org>/<your-plugin-repo>
codex plugin add <plugin-name>@<marketplace>
# approve the trust prompt (one-time, content-hash-pinned)
# compose fires lazily on first interaction
```

`PLUGIN_ROOT` / `PLUGIN_DATA` available; `CLAUDE_PROJECT_DIR` is unset on Codex
(the hook uses `$PWD` as the project root).

### 5.3 Kiro (folder-drop + compose)

No plugin store exists on Kiro. The distribution path is:

```bash
# git pull the plugin repo (or copy the packager's kiro projection)
cp -r <plugin-repo>/.kiro/ <project>/.kiro/
# compose
aidlc plugin compose --project <project>
```

On **Kiro IDE**, the shipped `.kiro.hook` files (trigger: `promptSubmit`) run the
composer automatically on first interaction — so the manual `compose` command is
needed only for Kiro CLI or pre-caching.

Agents are auto-discovered from `<project>/.kiro/agents/` (confirmed: `kiro-cli
agent list` shows workspace agents with no registration).

### 5.4 Worked example — platform team rolling out `test-pro` + `acme-compliance`

Meet a platform team shipping AIDLC plugins to product teams on Claude, Codex,
and Kiro. They want `test-pro` (first-party, testing) and `acme-compliance`
(third-party, their org's compliance gates).

**Author + publish (once):**
```bash
bun scripts/package.ts                   # emits per-harness plugin projections
cd <plugin-repo> && git tag test-pro--v0.1.0 && git push --tags
# marketplace.json already in the repo, listing both plugins
```

**Claude team installs:**
```bash
/plugin marketplace add acme-corp/aidlc-plugins
/plugin install test-pro@acme-corp-aidlc-plugins
/plugin install acme-compliance@acme-corp-aidlc-plugins
# next session: hook composes both → 32 core + 6 plugin stages
```

**Codex team installs:**
```bash
codex plugin marketplace add acme-corp/aidlc-plugins
codex plugin add test-pro@acme-corp-aidlc-plugins
codex plugin add acme-compliance@acme-corp-aidlc-plugins
# approve hook trust once per plugin; compose fires on first turn
```

**Kiro team installs:**
```bash
git clone acme-corp/aidlc-plugins && cd aidlc-plugins
cp -r kiro-projection/.kiro/ /path/to/project/.kiro/
aidlc plugin compose --project /path/to/project
# open project in Kiro IDE → /aidlc
```

In all three cases, the operation-phase stages from `test-pro` and the
compliance gates from `acme-compliance` are now part of the resolved plan
wherever their scopes and `when:` predicates put them on-path. The composer
genuinely merges both plugins' contributions to shared stages (set-union, not
last-writer-wins).

## 6. How plugins compose (the rules of the road)

Composition is **additive + namespaced + deterministically ordered** — the
best-composing quadrant (doc 19 §6.3). Concretely:

- **Structural surfaces** (`produces`, `consumes`, `requires_stage`, `sensors`,
  `required_sections`, `scopes`) — **set-union**, commutative, order-independent.
- **Prose fragments** — the one sequential surface — ordered by
  `(order, plugin, anchor)`, never by load order.
- **Namespacing** — every contributed artifact is `<plugin>-` prefixed; `core-*`
  is reserved; cross-plugin collisions (artifacts and scope/agent/sensor slugs)
  are rejected. Stage numbers are display-only, so there is no range to claim or
  collide on — a stage's place comes from its slug-based edges.
- **Activation** — a plugin's stages exist only when the plugin is in the active
  set; `when:` predicates (e.g. `producer-in-plan`) resolve over the **merged**
  graph at compose time and bake into `scope-grid.json`. The runtime stays
  read-only.

### 6.1 Conflicts fail loud, never silent

When two plugins genuinely collide on a non-commutative surface — the same
stage's same fragment anchor at the same order, an unsatisfiable cross-plugin
edge, a duplicate artifact name — the composer **errors with plugin attribution**
rather than resolving by overlay order. AIDLC never enters the "patch-ordering
hell" of silent ordered last-wins (doc 19 §6.3). Set-union surfaces simply merge;
sequential surfaces order deterministically; true conflicts stop the compose.

## 7. Authoring is identical for everyone

There is one authoring workflow regardless of where the plugin will be consumed
(doc 10):

```bash
bun scripts/package.ts --validate-plugin <plugin>  # fast loop: manifest, deps,
                                                    # artifact namespacing,
                                                    # contribution targets/anchors
bun scripts/package.ts                              # emit per-harness plugins
```

A third-party author runs the same validator against their own tree, then pushes
a git tag. A first-party author additionally lands in `plugins/` and lets CI
emit and test. Same seam, same tools, same guarantees — the only difference is
*whose repo the plugin lives in* (doc 18 §3).

## 8. Invariants the finished system holds

- **Core is immutable.** No plugin, ever, edits `core/`.
- **Additive-only.** Contributions add; they never override or remove. A genuine
  need to *change* upstream behavior is a framework-level design decision, not a
  plugin concern (doc 18 §6).
- **Inert when off.** Disabling every plugin yields bare core, byte-identical.
- **A plugin IS a host plugin.** The packager emits real `.claude-plugin/` and
  `.codex-plugin/` manifests. They install through the host's native commands. We
  run no distribution infrastructure.
- **One composer, host-triggered.** The same composer code runs wherever it's
  invoked — by the host's SessionStart hook (Claude/Codex) or by `aidlc plugin
  compose` (Kiro).
- **Deterministic & reproducible.** Same inputs → same composed output.
- **Slug identity, display-only numbers.** Inserting a plugin stage never
  renumbers core.
- **No gatekeeping.** First- and third-party plugins are mechanically equal.
- **Trust is host-native.** Org restrictions use the host's managed allowlist;
  we build no trust layer.

## 9. What this is not

- **Not a monkeypatch layer.** Plugins cannot rewrite arbitrary core behavior;
  the additive boundary is the point (doc 19 §6.3).
- **Not a per-harness fork.** A plugin is authored harness-neutral and projected
  into every harness; authoring per-harness is forbidden (doc 18 §3).
- **Not centrally pre-built for anyone past bare core.** The `2^N` combinatorial
  trap is avoided by composing the actual chosen set at install, not enumerating
  subsets.
- **Not a heavyweight runtime.** The AIDLC runtime stays read-only; all
  composition happens at compose time (hook or CLI invocation), never per-session.
- **Not our own distribution service.** Customers host their own plugin repos;
  we ship only the packager that emits host-native plugins and the composer that
  merges them.

## See also

- [18 — Plugin Mechanism](18-plugin-mechanism.md) — normative design spec.
- [19 — Plugin Composition Timing](19-plugin-composition-timing.md) — why
  install-time, with evidence.
- [21 — Plugin Implementation Plan](21-plugin-implementation-plan.md) — the work.
- [10 — Authoring a Plugin](10-authoring-a-plugin.md) — the author-facing guide.
- `spikes/dist-probe/RESULTS.md` — the real-host probe evidence backing §4.
