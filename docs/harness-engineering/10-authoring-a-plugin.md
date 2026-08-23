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
  tools/test-pro-doctor.ts                             # optional /aidlc --doctor checks
  scopes/test-pro-validation.md                       # NEW plugin scope
  agents/test-pro-metrics-agent.md                    # NEW support persona
  knowledge/test-pro-metrics-agent/methodology.md     # plugin methodology knowledge
  tests/plugin.test.ts                                # plugin content and compose tests
```

`.aidlc-plugin/plugin.json` is a **declarative** manifest. Its top level mirrors
the common plugin-manifest shape (so a marketplace or host tooling can
list/version/trust it); AIDLC-specific configuration lives in a nested `aidlc`
block:

```jsonc
{
  "name": "test-pro",                 // == dir name; "core", "aidlc", and "aidlc-*" are reserved
  "version": "0.1.0",                 // semver; checked by dependents
  "description": "Full-featured testing plugin — unit/branch coverage, functional, integration, regression, edge, and API positive+negative.",
  "author": { "name": "AWS AIDLC" },
  "dependencies": ["core"],           // other plugins, e.g. ["compliance@^1.2.0"]
  "aidlc": {
    "contributes": {                  // which subtrees this plugin ships
      "stages": "stages/",            // NEW stage files
      "overlays": "contributions/",   // CONTRIBUTION files (§3 — modify existing)
      "agents": "agents/",            // NEW personas
      "scopes": "scopes/",            // NEW scope identities
      "knowledge": "knowledge/",      // methodology knowledge for agents
      "sensors": "sensors/",          // sensor manifests
      "tools": "tools/"               // runnable sensor + doctor scripts
    }
  }
}
```

`contributes` keys map to core subtrees (`stages`, `agents`, `scopes`, `memory`,
`sensors`, `knowledge`, `tools`) — those are merged alongside core at compose.
`tools` lands CLI scripts in the harness `tools/` dir so a plugin can ship a
**runnable sensor** (its manifest in `sensors/` + its script in `tools/`) and an
optional doctor check.
`memory` merges into the default-space method seed, **not** a `rules/` dir (that
directory is no longer read — see §4). `overlays` is special: it is **not**
copied; it holds the per-stage contributions consumed by the merge (§3).

Ship only the keys your plugin uses. `test-pro` ships a support agent, a plugin
scope, and per-agent methodology knowledge; it still reuses
`aidlc-quality-agent` as the lead.

> **No number ranges.** Stage numbers are display-only, so a plugin does **not**
> claim a number range in its manifest. See §2.

## 2. Add a new stage

A plugin stage is an ordinary stage file (see
[Anatomy of a Stage](01-anatomy-of-a-stage.md)) with two extra rules:

- Its `plugin:` field names your plugin.
- Any artifact it `produces:` must be prefixed `<plugin>-` (e.g.
  `test-pro-integration-test-results`).

The same logical plugin name must appear in every owned stage, scope, agent,
and contribution. Compose derives that identity from the emitted host manifest
(`aidlc-<name>` at the host layer, `<name>` in AIDLC frontmatter); content cannot
rename or impersonate its package. A mismatch is skipped and recorded for
`/aidlc --doctor`.

`bundle:` was the pre-rename ownership key and is rejected with an error naming the fix - write `plugin:`. The word is reserved for a possible future collection-of-plugins concept.

Stage **identity is the slug**, everywhere that matters (edges, jumps,
resolution). The `number:` is a **display hint** only — a stage's graph
position comes from its slug-based `requires_stage` edges, and the compiled
number values are assigned by the ENGINE, never by you: on first compile,
your plugin's new stages are ordered by their own `requires_stage` edges,
using your authored `number:` values only to break ties among independent
stages, and given the next free indices in their phase. So author numbers
that read sensibly and agree with your edges (`test-pro-integration` is
`3.85`, after `build-and-test` at `3.6`) — the RELATIVE order is what
carries — but the absolute values never land in the graph, inserting a stage
never renumbers core, and you claim no range (which is why two uncoordinated
plugins can never collide on numbers).

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
- `adds.scopes` — ✅ set-unioned into the target stage's `scopes:` list, with
  two guard rails (each violation dropped-with-log, never merged): the scope's
  identity file must be installed (`scopes/<name>.md` ships in the same
  plugin), and that file's `plugin:` frontmatter must name YOUR plugin exactly
  — you cannot put a core stage under a core or foreign-plugin scope, and
  ownership is read from the installed file's declared owner, not inferred
  from a name prefix. Use it to route existing core stages under your
  plugin's scope — e.g. a methodology plugin whose scope carries its own
  discovery stages plus core Inception onward.
- `adds.requires_stage` — ⏳ **deferred**: a contribution may declare it, but
  compose records it to the drops log rather than merging (it is not yet a
  DAG edge). Don't rely on it to gate behavior yet.
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

Fragments are ordered deterministically by `(order, plugin)`. A same
`(plugin, anchor, order)` collision — within one file or across two contribution
files this run — is **dropped-with-log** (not last-writer-wins). When two
*different* plugins contribute to the same stage, their structural additions
set-union and their fragments interleave by this same ordering — genuinely merged.

Each spliced fragment is wrapped in a sentinel comment carrying a content hash
(`<!-- plugin:<plugin>:<anchor>:<order>:<hash> --> … <!-- /plugin:… -->`), which
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

`test-pro` ships stages, contributions, sensors, a support agent, a scope, and
methodology knowledge. A richer plugin may also add method/rules later; memory
projection remains deferred (doc 18 §8 Status).

- **Agents.** Drop `agents/<plugin>-<role>-agent.md` with `plugin:` set. The
  plugin prefix replaces core's `aidlc-` filename prefix, and the filename stem
  must equal frontmatter `name` (for example,
  `agents/test-pro-metrics-agent.md` has `name: test-pro-metrics-agent`). It is
  discovered automatically after compose, and your plugin's stages may name it
  as `lead_agent`/`support_agents`. A same-path collision with different content
  is not overwritten; compose records a drop log. OpenCode composition also
  creates the native `.opencode/agents/` subagent twin and denies nested
  `task` delegation. See
  [Adding an Agent](03-adding-an-agent.md).
- **Sensors.** Ship the manifest `sensors/aidlc-<id>.md` **and** its script under
  `tools/` (both — a manifest alone is discoverable but its script must live in
  `tools/` to run). The `aidlc-<id>.md` name at the top of `sensors/` is a hard
  requirement, not a convention: sensor discovery flatly scans `sensors/` and
  indexes only basenames matching `aidlc-<id>.md`, so a manifest under any other
  name (or one nested in a subdirectory) would compose but never fire. Compose
  now rejects such a manifest with a degraded drop (surfaced by `--doctor`) that
  names the file and the required shape, rather than letting it land dead. Bind
  the sensor to your own stages via `sensors:`, or to a core stage via a
  contribution's `adds.sensors`. See [Sensors](06-sensors.md).
- **Method/rules.** *(⏳ deferred.)* Ship a `memory/` subtree — `memory/phases/<phase>.md` (or
  `memory/{org,team,project}.md`) — via `contributes.memory`. It **merges into
  the default-space method seed** (`aidlc/spaces/default/memory/`) in the design,
  but the packager/compose hook does not project or merge `memory/` yet. Do
  **not** ship a `rules/` dir — that path is no longer read (the rule layer moved
  into per-space memory). See [Rules and the Loop](05-rules-and-the-loop.md).
- **Knowledge.** Ship per-agent **methodology** knowledge under
  `knowledge/<agent-slug>/`, projected into the framework-shipped
  `<harness>/knowledge/` tree and loaded when that agent leads or supports a
  stage. Note: **domain/team knowledge** (`aidlc/spaces/<space>/knowledge/`) is
  empty-at-bootstrap user runtime state — a plugin does not ship it. See
  [Team Knowledge](07-team-knowledge.md).
- **Scopes.** A scope's **identity** is one file you ship under
  `scopes/<plugin>-<name>.md`. The plugin prefix replaces core's `aidlc-`
  filename prefix, and the filename stem must equal frontmatter `name` (for
  example, `scopes/test-pro-validation.md` has `name: test-pro-validation`).
  Set `freeform_default: true` to nominate a plugin scope as the fallback when
  the core `classic` default is disabled; at most one enabled scope across
  the selected core/plugin set may claim it, and graph compilation rejects an
  ambiguous set. Membership for plugin-authored stages is their `scopes:`
  frontmatter list; a contribution's `adds.scopes` (§3) adds YOUR scope to an
  existing core stage. See [Scopes](04-scopes.md).

### Ship a doctor check

Add `tools/<plugin>-doctor.ts` when your plugin has install prerequisites or
composed files that `/aidlc --doctor` should verify. The script is optional and
runs only while the plugin is enabled. It receives `AIDLC_PROJECT_DIR`,
`AIDLC_HARNESS_DIR`, and `AIDLC_PLUGIN_NAME`, and must print the JSON contract
without other stdout:

Doctor discovery derives installed plugin identities from owned stage and scope
metadata. A plugin must therefore own at least one stage or scope for its doctor
script to be discoverable; a tools-, sensors-, or knowledge-only plugin is not
enough on its own.

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(
  process.env.AIDLC_PROJECT_DIR ?? process.cwd(),
  process.env.AIDLC_HARNESS_DIR ?? ".claude",
);

console.log(JSON.stringify({
  checks: [{
    pass: existsSync(join(root, "tools", "my-plugin-helper.ts")),
    label: "my-plugin helper installed",
    fix: "Run `bun <harness-dir>/tools/aidlc-utility.ts plugin-sync` or re-run hooks/compose.ts.",
    severity: "error",
  }],
}));
```

Omit `severity` for the default `error` behavior. Use `advisory` for a visible
finding that must not fail doctor. Keep the script read-only and dependency-free;
doctor bounds its runtime/output and turns script failures into diagnostic rows.

## 5. Distribution + install

The packager emits your plugin as **a real host plugin** (one projection target
per harness, including `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
Copilot's `.plugin/plugin.json`, and Kiro's folder projection). You publish the
output to a git repo with semver tags and a `marketplace.json`, and teams install
through the host's native commands.

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
# preferred when aidlc is on PATH:
AIDLC_PLUGIN_ROOT="<plugin-root>" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro aidlc plugin sync

# fallback: run the composer explicitly:
AIDLC_PLUGIN_ROOT="<plugin-root>" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro bun "<plugin-root>/hooks/compose.ts"
# open in Kiro IDE or kiro-cli chat → /aidlc
```

> **Kiro note.** Use the `kiro-ide` projection for Kiro IDE >= 1.0; its folder-drop
> includes a v2 `.kiro/hooks/aidlc-<plugin>-compose.json` SessionStart registration
> that runs the cross-platform `hooks/aidlc-plugin-compose.ts` Bun launcher from
> the workspace root. The `kiro` projection for Kiro CLI emits no hook registration,
> so run one of the explicit composer commands above. Neither projection emits the
> retired `.kiro.hook` plugin registration.

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

## Testing your plugin

Use three tiers, from cheapest to most realistic:

1. **Content validation** is the always-on baseline. Call
   `validatePluginContent()` against the authored plugin root. It runs pure,
   deterministic checks for manifest identity, stage schema and ownership,
   artifact namespacing, contribution targets, scope and agent filenames, and
   non-empty stage bodies. It is fast and gives precise authoring findings, but
   it does not prove that packaging or composition succeeds.
2. **Compose integration** is the default CI check. Call
   `composePluginFixture()` to build the real harness projection, copy a shipped
   install into scratch space, run the emitted compose hook, and inspect the
   compiled graph and installed surfaces. It is deterministic and exercises the
   actual packager and composer, but it does not launch a model-backed harness.
3. **Live harness e2e** is opt-in compatibility evidence. Call
   `invokeHarness()` only behind the gate returned by `liveGateFor()`. The live
   gates are `AIDLC_CLAUDE_SDK_LIVE`, `AIDLC_KIRO_ACP_LIVE`,
   `AIDLC_CODEX_EXEC_LIVE`, `AIDLC_COPILOT_EXEC_LIVE`,
   `AIDLC_OPENCODE_RUN_LIVE`, and `AIDLC_CURSOR_RUN_LIVE`. Live runs prove the
   host can discover and invoke the composed plugin, but they need installed
   CLIs, credentials, and more time. An unset gate returns a skipped result, so
   a green test run can mean the live check did not run.

Plugin tests under `plugins/<name>/tests/*.test.ts` are discovered
automatically and join the integration tier. Run one plugin's tests with:

```bash
bash tests/run-tests.sh --integration --filter "plugin-<name>"
```

This content test is the minimum copyable shape:

```ts
import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePluginContent } from "../../../tests/harness/plugin-kit.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("plugin content is valid", () => {
  expect(validatePluginContent(pluginRoot)).toEqual([]);
});
```

Add a deterministic compose test when the plugin ships stages, contributions,
agents, scopes, sensors, or tools:

```ts
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composePluginFixture } from "../../../tests/harness/plugin-kit.ts";

test("plugin composes into a Claude install", () => {
  const fixture = composePluginFixture({
    plugin: "your-plugin",
    harness: "claude",
  });
  const graph = JSON.parse(
    readFileSync(
      join(fixture.projectDir, ".claude", "tools", "data", "stage-graph.json"),
      "utf-8",
    ),
  ) as Array<{ slug?: string }>;
  expect(graph.some((stage) => stage.slug === "your-plugin-stage")).toBe(true);
});
```

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
