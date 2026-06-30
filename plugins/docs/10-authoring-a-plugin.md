# Authoring a Plugin

> Part of the [Harness Engineer Guide](../../docs/harness-engineering/00-overview.md). Prerequisite:
> [Anatomy of a Stage](../../docs/harness-engineering/01-anatomy-of-a-stage.md). Design reference:
> [Plugin Mechanism](18-plugin-mechanism.md). For *why* the
> system composes the way it does, see
> [Composition: Build-Time vs Install-Time](19-plugin-composition-timing.md);
> for the end-to-end picture, [Extension System Vision](20-plugin-system-vision.md).

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

- **A stage/agent/rule** ([chapters 2–6](../../docs/harness-engineering/00-overview.md)) is a permanent part of
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
[Anatomy of a Stage](../../docs/harness-engineering/01-anatomy-of-a-stage.md)) with two extra rules:

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
optionally with a `when:` predicate. `test-pro-full-suite` only runs when its
upstream producer is on the plan:

```yaml
scopes:
  - enterprise
when:
  producer-in-plan: test-pro-regression-suite
```

See [Scopes](../../docs/harness-engineering/04-scopes.md) for scope membership and the `when:` predicate.

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

What you can add (all additive — **no override or removal**, by design):

- `adds.produces` / `adds.consumes` / `adds.sensors` / `adds.requires_stage` —
  set-unioned into the target stage's compiled node.
- `adds.required_sections` — named `##` H2 sections the required-sections sensor
  will **machine-enforce** in that stage's output.
- `adds.scopes` — union a scope name into the target stage's membership (this is
  how a plugin puts an *existing core stage* under a plugin-defined scope without
  editing it — see §4, Scopes).
- `fragments` — prose blocks appended into the stage body. Each fragment's prose
  is the `## fragment: <anchor>` block in the contribution file.

### Fragment anchors

| Anchor             | Inserts the fragment…                                              |
| ------------------ | ------------------------------------------------------------------ |
| `after-step:<n>`   | right after `### Step <n>` (before the next `###`/`##`)            |
| `before-step:<n>`  | immediately before `### Step <n>`                                  |
| `after-questions`  | after the questions-generating step                                |
| `end-of-steps`     | at the end of the `## Steps` block                                 |
| `in:<Compartment>` | at the end of the named `## <Compartment>` block (e.g. `in:Sensors`) |

Fragments are ordered deterministically by `(order, plugin, anchor)`. Two
fragments with the same `(anchor, order, plugin)` is a build error. When two
*different* plugins contribute to the same stage, their structural additions
set-union and their fragments interleave by this same ordering — they are
genuinely merged, never last-writer-wins.

## 4. Packaging the other primitives

`test-pro` ships stages, contributions, and sensors. A richer plugin adds agents,
scopes, method/rules, or knowledge — one rule each:

- **Agents.** Drop `agents/<slug>-agent.md` with `plugin:` set. It is discovered
  automatically and your plugin's stages may name it as `lead_agent`/
  `support_agents`. An agent slug that collides with core or another plugin is a
  compose error (no silent shadowing). See [Adding an Agent](../../docs/harness-engineering/03-adding-an-agent.md).
- **Sensors.** Ship the manifest `sensors/aidlc-<id>.md` **and** its script under
  `tools/` (both — a manifest alone is discoverable but its script must live in
  `tools/` to run). Bind it to your own stages via `sensors:`, or to a core stage
  via a contribution's `adds.sensors`. See [Sensors](../../docs/harness-engineering/06-sensors.md).
- **Method/rules.** Ship a `memory/` subtree — `memory/phases/<phase>.md` (or
  `memory/{org,team,project}.md`) — via `contributes.memory`. It **merges into
  the default-space method seed** (`aidlc/spaces/default/memory/`), and a phase
  file's guardrails load strict-additively for every stage in that phase. Do
  **not** ship a `rules/` dir — that path is no longer read (the rule layer moved
  into per-space memory). See [Rules and the Loop](../../docs/harness-engineering/05-rules-and-the-loop.md).
- **Knowledge.** Ship per-agent **methodology** knowledge under
  `knowledge/<agent-slug>/`, projected into the framework-shipped
  `<harness>/knowledge/` tree and loaded when that agent leads a stage. Note:
  **domain/team knowledge** (`aidlc/spaces/<space>/knowledge/`) is empty-at-
  bootstrap user runtime state — a plugin does not ship it. See
  [Team Knowledge](../../docs/harness-engineering/07-team-knowledge.md).
- **Scopes.** A scope has two parts. Its **identity** is one file you ship under
  `scopes/aidlc-<name>.md`. Its **membership** — which stages run under it — is
  additive, declared two ways:
  - *scope-side (coarse):* the scope file lists the phases/stages it includes
    (`includes_phases`, `includes_stages`), so a plugin scope can pull in existing
    core stages without touching them;
  - *stage-side (fine):* a contribution's `adds.scopes` (§3) unions the scope name
    into one specific core stage's membership.

  Membership is additive-only — a stage can gain a scope from a plugin but never
  lose one. See [Scopes](../../docs/harness-engineering/04-scopes.md).

## 5. Compose + install

A plugin is composed into an install over the user's *chosen set* — `bare core +
{the plugins they enabled}` — by one composer. Composition merges all chosen
plugins' subtrees and contributions, validates the merged set, compiles the
stage graph + scope grid, and projects the result for the target harness. The
orchestrator routes entirely off that compiled graph, so a plugin stage runs the
moment it is composed in — no prose or skill file to edit.

The consumer side (from [the vision](20-plugin-system-vision.md)
§5):

```bash
aidlc plugin add test-pro --harness claude --into ./my-service   # resolve, fetch, compose, lock
cd my-service && claude                                          # then the normal /aidlc flow
```

Composition records an `aidlc.lock` pinning each plugin's source + version, the
bare-core version, the composer version, and a result hash — so
`aidlc plugin sync` reproduces a byte-identical install on another machine.

> **Status.** The `aidlc plugin` installer, marketplace resolution, and lockfile
> are the install-time work in [doc 21](21-plugin-implementation-plan.md)
> (§B.6/B.7). Concrete example config files — `plugin.json`, `marketplace.json`,
> `managed-settings.json` (the org trust allowlist), `aidlc.lock.json` — are in
> [`reference/examples/test-pro/`](examples/test-pro/).

## Rules of the road

- **Number is display-only.** Author a sensible `number:`; claim no range;
  inserting a stage never renumbers core.
- **Artifact namespacing.** Every artifact you produce is `<plugin>-` prefixed;
  it may not collide with a core artifact or another plugin's.
- **Primitive names are unique.** Your scopes/agents/sensors may not
  collide with core or another plugin — a collision is a compose error with
  attribution. (Method files merge into the memory seed by file, additively.)
- **Dependencies.** `dependencies` entries must resolve; a `name@^x.y.z`
  constraint is checked against the dependency's `version`; cycles are rejected.
- **Additive only.** Contributions add — they cannot override or remove a core
  stage's fields, agent, or prose. (A genuine need to _change_ upstream behavior
  is a framework design decision, not a plugin concern.)

## See also

- [Plugin Mechanism](18-plugin-mechanism.md) — the normative
  design (the manifest, composition model, the contribution seam, invariants).
- [Composition: Build-Time vs Install-Time](19-plugin-composition-timing.md)
  — why composition is install-time.
- [Extension System Vision](20-plugin-system-vision.md) — the
  end-to-end picture + worked Claude/Kiro example.
- [Implementation Plan](21-plugin-implementation-plan.md) — the
  sequenced work to build it.
- [Anatomy of a Stage](../../docs/harness-engineering/01-anatomy-of-a-stage.md), [Scopes](../../docs/harness-engineering/04-scopes.md),
  [Sensors](../../docs/harness-engineering/06-sensors.md) — the building blocks a plugin composes.
