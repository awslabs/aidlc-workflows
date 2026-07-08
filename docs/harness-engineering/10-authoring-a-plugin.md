# Authoring a Plugin

> Part of the [Harness Engineer Guide](00-overview.md). Prerequisite:
> [Anatomy of a Stage](01-anatomy-of-a-stage.md). Design reference (the mechanism,
> the install-time rationale, the hybrid distribution model, and as-built status):
> [Plugin Mechanism](../reference/18-plugin-mechanism.md).

An **AIDLC plugin** (a **plugin**) is a reusable, optional set of AIDLC
contributions — new stages, agents, scopes, method/rules (the memory layer),
sensors, methodology knowledge, and additive modifications to existing core
stages — packaged in its own directory,
published from its own repository, and **composed** into a user's install over
their chosen set of plugins. A plugin never edits `core/`; with every plugin
disabled, the install is byte-identical to bare core.

First-party plugins (shipped by the AIDLC team) and third-party plugins (anyone
else) are **mechanically identical** — same structure, same seams, same
composer, same guarantees. The only difference is provenance: whose repository
the plugin lives in and who reviewed it.

This chapter walks the `test-pro` plugin end to end. Copy its shape for your own.

## When to write a plugin vs. a plain stage/rule

- **A stage/agent/rule** ([chapters 2–6](00-overview.md)) is a permanent part of
  the framework everyone gets.
- **A plugin** is _optional and owned_ — it ships in its own repo, activates
  only under an opt-in scope (and/or a `when:` predicate), and a consumer chooses
  to compose it into their install. Use it for a domain pack (a full operation
  phase, a compliance plugin, a testing plugin) that not every project wants.

## 1. The directory + manifest

A plugin is a directory (and a git repository) with a declarative manifest and
core-shaped subtrees:

```text
test-pro/
  .aidlc-plugin/plugin.json                          # the manifest
  stages/construction/test-pro-integration.md        # NEW stages
  stages/operation/test-pro-full-suite.md
  contributions/construction/nfr-requirements.md      # MODIFY existing core stages (§3)
  contributions/construction/nfr-design.md
  contributions/construction/build-and-test.md
  contributions/operation/performance-validation.md
  sensors/aidlc-coverage-threshold.md                 # NEW sensor manifests
  sensors/aidlc-requirement-coverage.md
  tools/aidlc-sensor-coverage-threshold.ts            # the sensor scripts
  tools/aidlc-sensor-requirement-coverage.ts
```

`.aidlc-plugin/plugin.json` is a **declarative** manifest. Its top level mirrors
the common plugin-manifest shape (so a marketplace or host tooling can
list/version/trust it); AIDLC-specific configuration lives in a nested `aidlc`
block:

```jsonc
{
  "name": "test-pro",                 // == dir name; "core" is reserved
  "version": "0.1.0",                 // semver; checked by dependents
  "description": "Full-featured testing plugin — unit/branch coverage, functional, integration, regression, edge, and API positive+negative.",
  "author": { "name": "AWS AIDLC" },
  "dependencies": ["core"],           // other plugins, e.g. ["compliance@^1.2.0"]
  "aidlc": {
    "contributes": {                  // which subtrees this plugin ships
      "stages": "stages/",            // NEW stage files
      "overlays": "contributions/",   // CONTRIBUTION files (§3 — modify existing)
      "sensors": "sensors/",          // sensor manifests
      "tools": "tools/"               // sensor scripts (so a sensor can run)
    }
  }
}
```

`contributes` keys map to core subtrees (`stages`, `agents`, `scopes`, `memory`,
`sensors`, `knowledge`, `tools`) — those are merged alongside core at compose.
`tools` lands CLI scripts in the harness `tools/` dir so a plugin can ship a
**runnable sensor** (its manifest in `sensors/` + its script in `tools/`).
`memory` merges into the default-space method seed, **not** a `rules/` dir (that
directory is no longer read — see §4). `overlays` is special: it is **not**
copied; it holds the per-stage contributions consumed by the merge (§3).

Ship only the keys your plugin uses — `test-pro` ships no `agents`/`scopes`/
`memory`/`knowledge` because it reuses `aidlc-quality-agent` and adds none of
those. A plugin that does ship them gets one section each below (§4).

> **No number ranges.** Stage numbers are display-only, so a plugin does **not**
> claim a number range in its manifest. See §2.

## 2. Add a new stage

A plugin stage is an ordinary stage file (see
[Anatomy of a Stage](01-anatomy-of-a-stage.md)) with two extra rules:

- Its `plugin:` field names your plugin.
- Any artifact it `produces:` must be prefixed `<plugin>-` (e.g.
  `test-pro-integration-test-results`).

Stage **identity is the slug**, everywhere that matters (edges, jumps,
resolution). The `number:` is a **display hint** only — it orders the stage in
status output and the SKILL.md stage table, but a stage's graph position comes
from its slug-based `requires_stage` edges. So you author a `number:` that reads
sensibly (`test-pro-integration` is `3.85`, after `build-and-test` at `3.6`), but
inserting it never renumbers core and you claim no range.

Gate a stage onto a scope with `scopes:` (it is SKIP everywhere else), and
optionally declare a `when:` predicate. `test-pro-full-suite` is *intended* to run
only when its upstream producer is on the plan:

```yaml
scopes:
  - enterprise
when:
  producer-in-plan: test-pro-regression-suite
```

> **`when:` is parsed but not yet evaluated.** The schema validates the predicate
> and the parser reads it, but no engine consumer acts on it today — a stage
> carrying `when:` is EXECUTE under its declared `scopes:` unconditionally. Author
> it for forward-compatibility, but gate real behavior on `scopes:` for now.

See [Scopes](04-scopes.md) for scope membership and the `when:` predicate.

## 3. Modify an existing core stage (a contribution)

This is the contribution seam — additively change a core stage **without editing
it**. A contribution lives at
`<plugin>/contributions/<phase>/<slug>.md`. Here is `test-pro`'s contribution to
`nfr-requirements`:

```markdown
---
target: nfr-requirements      # the existing core stage you're enriching
plugin: test-pro
adds:                         # STRUCTURAL — set-unioned into the stage node
  produces:
    - test-pro-testability-requirements   # <plugin>- prefixed
  required_sections:
    - "Testability Requirements"          # machine-enforced
    - "Coverage Targets"
fragments:                    # PROSE — spliced into the stage body
  - anchor: after-step:6
    order: 100
---

## fragment: after-step:6

### Step 6b (test-pro): Capture testability NFRs

…prose the agent will see, appended after the target stage's Step 6…
```

What you can add (all additive — **no override or removal**, by design). "Status"
marks what the compose hook merges today vs. designed-but-deferred (mirrors doc 18
§5/§8 — implement or demote, never a silent no-op):

- `adds.produces` / `adds.consumes` / `adds.sensors` — ✅ set-unioned into the
  target stage's source frontmatter.
- `adds.required_sections` — ✅ merged into the stage's `required_sections`. Note
  it is **not machine-enforced today**: the field is written and validates, but it
  does not reach the compiled graph node, and the shipped `required-sections`
  sensor derives its expectations from templates, so nothing yet fails a stage for
  a missing section. Treat it as declarative intent for now.
- `adds.requires_stage` / `adds.scopes` — ⏳ **deferred**: a contribution may
  declare them, but compose records them to the drops log rather than merging
  (they are not yet DAG/scope edges). Don't rely on them to gate behavior yet.
- `fragments` — ✅ prose blocks spliced into the stage body. Each fragment's prose
  is the `## fragment: <anchor>` block in the contribution file.

### Fragment anchors

| Anchor             | Inserts the fragment…                                              | Status |
| ------------------ | ------------------------------------------------------------------ | ------ |
| `after-step:<n>`   | right after `### Step <n>` (before the next `###`/`##`)            | ✅ |
| `before-step:<n>`  | immediately before `### Step <n>`                                  | ✅ |
| `end-of-steps`     | at the end of the `## Steps` block                                 | ✅ |
| `in:<Compartment>` | at the end of the named `## <Compartment>` block (e.g. `in:Sensors`) | ✅ |
| `after-questions`  | after the questions-generating step                                | ⏳ not implemented — `locateAnchor` has no case; drops "unknown anchor". Use `after-step:<n>`. |

Fragments are ordered deterministically by `(order, bundle)`. A same
`(bundle, anchor, order)` collision — within one file or across two contribution
files this run — is **dropped-with-log** (not last-writer-wins). When two
*different* plugins contribute to the same stage, their structural additions
set-union and their fragments interleave by this same ordering — genuinely merged.

Each spliced fragment is wrapped in a sentinel comment carrying a content hash
(`<!-- plugin:<bundle>:<anchor>:<order>:<hash> --> … <!-- /plugin:… -->`), which
is how re-composing stays idempotent and an upgraded fragment replaces its prior
block. Two authoring rules follow from that:

- **Don't write a sentinel-lookalike line in fragment prose.** A line matching
  `<!-- /plugin:… -->` inside your prose will be mistaken for a block terminator
  and corrupt the splice on upgrade.
- **Upgrading from a pre-release build:** installs composed from a *review build*
  of this branch (before the hash was added to the sentinel) carry the old
  hashless marker; an upgrade won't recognize it and will splice a second copy.
  Only PR-branch installs are affected — recompose from a clean base, or delete
  the old block by hand, once.

## 4. Packaging the other primitives

> **⏳ Status: designed, not yet wired.** Today the packager projects only a
> plugin's `stages/`, `sensors/`, `tools/`, and `contributions/`. The `agents/`,
> `scopes/`, `memory/`, and `knowledge/` subtrees below are the *intended* shape
> but are **not yet emitted** into an install — authoring them has no effect until
> the projection lands (doc 18 §8 Status). `test-pro` therefore ships only the
> wired primitives.

`test-pro` ships stages, contributions, and sensors. A richer plugin adds agents,
scopes, method/rules, or knowledge — one rule each (all deferred per the note above):

- **Agents.** Drop `agents/<slug>-agent.md` with `plugin:` set. It is discovered
  automatically and your plugin's stages may name it as `lead_agent`/
  `support_agents`. An agent slug that collides with core or another plugin is a
  compose error (no silent shadowing). See [Adding an Agent](03-adding-an-agent.md).
- **Sensors.** Ship the manifest `sensors/aidlc-<id>.md` **and** its script under
  `tools/` (both — a manifest alone is discoverable but its script must live in
  `tools/` to run). Bind it to your own stages via `sensors:`, or to a core stage
  via a contribution's `adds.sensors`. See [Sensors](06-sensors.md).
- **Method/rules.** Ship a `memory/` subtree — `memory/phases/<phase>.md` (or
  `memory/{org,team,project}.md`) — via `contributes.memory`. It **merges into
  the default-space method seed** (`aidlc/spaces/default/memory/`), and a phase
  file's guardrails load strict-additively for every stage in that phase. Do
  **not** ship a `rules/` dir — that path is no longer read (the rule layer moved
  into per-space memory). See [Rules and the Loop](05-rules-and-the-loop.md).
- **Knowledge.** Ship per-agent **methodology** knowledge under
  `knowledge/<agent-slug>/`, projected into the framework-shipped
  `<harness>/knowledge/` tree and loaded when that agent leads a stage. Note:
  **domain/team knowledge** (`aidlc/spaces/<space>/knowledge/`) is empty-at-
  bootstrap user runtime state — a plugin does not ship it. See
  [Team Knowledge](07-team-knowledge.md).
- **Scopes.** A scope has two parts. Its **identity** is one file you ship under
  `scopes/aidlc-<name>.md`. Its **membership** — which stages run under it — is
  additive, declared two ways:
  - *scope-side (coarse):* the scope file lists the phases/stages it includes
    (`includes_phases`, `includes_stages`), so a plugin scope can pull in existing
    core stages without touching them;
  - *stage-side (fine):* a contribution's `adds.scopes` (§3) unions the scope name
    into one specific core stage's membership.

  Membership is additive-only — a stage can gain a scope from a plugin but never
  lose one. See [Scopes](04-scopes.md).

## 5. Distribution + install

The packager emits your plugin as **a real host plugin** (one projection target
per harness: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, plus a
Kiro folder projection). You publish the output to a git repo with semver tags
and a `marketplace.json`, and teams install through the host's native commands.

### Claude / Codex (host store)

```bash
# teams run these in their host CLI:
/plugin marketplace add <your-org>/<your-plugin-repo>    # Claude
/plugin install test-pro@<marketplace>                   # Claude

codex plugin marketplace add <your-org>/<your-plugin-repo>   # Codex
codex plugin add test-pro@<marketplace>                      # Codex
```

A **SessionStart hook** (bundled in the emitted plugin) composes automatically —
merges all chosen plugins' subtrees and contributions, validates the merged set,
compiles the stage graph + scope grid, and projects the result. The orchestrator
routes entirely off that compiled graph, so a plugin stage runs the moment it is
composed in — no prose or skill file to edit.

### Kiro (no store — folder-drop, then run the composer explicitly)

```bash
# git pull your plugin repo, copy the Kiro projection into the project:
cp -r dist/plugins/<name>/kiro/. <project>/
# run the composer explicitly (the one working invocation today):
AIDLC_PLUGIN_ROOT="<plugin-root>" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro bun "<plugin-root>/hooks/compose.ts"
# open in Kiro IDE or kiro-cli chat → /aidlc
```

> **Not yet wired.** A `.kiro.hook` that auto-fires the composer on first prompt,
> and an `aidlc plugin compose` wrapper CLI, are designed but not implemented —
> the emitted `.kiro.hook` is inert (Kiro CLI does not read `.kiro.hook`, and its
> `${PLUGIN_ROOT}` is set by no Kiro host). Use the explicit `bun compose.ts`
> invocation above until they land. See doc 18 §8 "Status" for the full deferral list.

### Trust

Trust is **host-native** — you don't build anything:
- Claude: org admin sets `strictKnownMarketplaces` (managed, unoverridable).
- Codex: one-time trust prompt per plugin, content-hash-pinned.
- Kiro: n/a (folder-drop, no host gate).

> **Concrete examples** — `plugin.json`, `marketplace.json`,
> `managed-settings.json` (the org trust config), `aidlc.lock.json` — are in
> [`examples/test-pro/`](../reference/examples/test-pro/). See also
> [Plugin Mechanism §8](../reference/18-plugin-mechanism.md) for the full
> platform-team worked example.

## Rules of the road

- **Number is display-only.** Author a sensible `number:`; claim no range;
  inserting a stage never renumbers core.
- **Artifact namespacing.** Every artifact you produce is `<plugin>-` prefixed;
  it may not collide with a core artifact or another plugin's.
- **Primitive names are unique.** Your scopes/agents/sensors may not
  collide with core or another plugin — a collision is a compose error with
  attribution. (Method files merge into the memory seed by file, additively.)
- **Dependencies** *(⏳ deferred).* `dependencies` is designed to resolve a
  `name@^x.y.z` constraint against the dependency's `version` with cycle
  rejection, but **nothing reads the field yet** — declaring it has no effect
  today (doc 18 §8 Status).
- **Additive only.** Contributions add — they cannot override or remove a core
  stage's fields, agent, or prose. (A genuine need to _change_ upstream behavior
  is a framework design decision, not a plugin concern.)

## See also

- [Plugin Mechanism](../reference/18-plugin-mechanism.md) — the normative
  design: manifest, composition model, the contribution seam, the install-time
  rationale, the hybrid distribution model, multi-tenant guards, and as-built
  status (all consolidated in this one chapter).
- [Anatomy of a Stage](01-anatomy-of-a-stage.md), [Scopes](04-scopes.md),
  [Sensors](06-sensors.md) — the building blocks a plugin composes.
