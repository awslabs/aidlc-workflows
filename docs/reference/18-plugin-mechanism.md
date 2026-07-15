# The Plugin Mechanism

> Audience: Tier 2/3 (team adopter, framework contributor).

> **Path convention.** `<harness-dir>/` below = the harness's runtime dir (`.claude` / `.codex` / `.kiro`); `plugins/<name>/` = the authored plugin source; `dist/plugins/<name>/<harness>/` = the emitted, installable host plugin.

This chapter is the canonical reference for the **AIDLC plugin** system: an optional, owned, versioned set of contributions — new stages, agents, scopes, method/rules, sensors, and *additive modifications to existing core stages* — authored once as a harness-neutral tree and **emitted as a real host plugin** for each harness. A plugin never edits `core/`; with every plugin disabled an install is byte-identical to bare core. The system generalizes the one proven edit-free seam (phase rules composed additively) to every surface, and delivers it through each host's own plugin machinery rather than a bespoke installer. Cross-link to [Stage Definition](15-stage-definition.md) (the stage frontmatter a plugin authors, including `plugin`/`number`/`when`), [Engine and Skill System](17-skill-system.md) (the graph the composer feeds and the orchestrator routes off), [Artifact Vocabulary](16-artifact-vocabulary.md) (the namespacing rule), and the authoring walkthrough [Authoring a Plugin](../harness-engineering/10-authoring-a-plugin.md).

---

## 1. What a plugin is

A plugin is a directory (and a git repository) with a declarative manifest and core-shaped subtrees. It can:

- **add** new stages (in their own display-number range), agents, scopes, method/rules (into the space memory seed), and sensors; and
- **modify** existing core stages **additively** via the contribution seam (§6) — enriching what a stage produces, consumes, checks, and instructs, without editing it.

First-party plugins (shipped by the AIDLC team) and third-party plugins (anyone else) are **mechanically identical** — same structure, same seams, same composer, same host-install path. The only difference is provenance: whose repository the plugin lives in and who reviewed it. `plugins/test-pro/` is the reference fixture.

The **design principles** the mechanism holds to:

- **Strict-additive, never override.** Contributions only *add*. Set-union over structural surfaces is commutative, which is what makes independent authors safe; a genuine conflict is a compose error with plugin attribution, never a silent last-writer-wins.
- **Core immutability.** No plugin edits a `core/` file; everything a plugin ships lives in the plugin's own tree.
- **Reversible & inert when off.** Disabling a plugin recomposes to exactly the install without it.
- **Slug is identity.** Stages are identified by slug everywhere that matters (edges, jumps, resolution). `number` is display/ordering only, so an inserted plugin stage never renumbers or destabilizes core.

## 2. Why install-time, delivered as a host plugin

A recurring design question was whether a plugin is a *build-time* artifact (pre-composed centrally, copied in) or an *install-time* one (composed on the consumer's machine over their chosen set). The mechanism is **install-time**, for two structural reasons the wider ecosystem (npm, Cargo, Helm, VS Code, Nix) has already converged on:

- **Combinatorial explosion.** N plugins yield up to 2ⁿ enabled subsets; a central build cannot pre-compose every combination. The only artifact worth pre-building is **bare core** (the empty set), identical for everyone.
- **Late resolution.** The correct plugin set — and how two plugins' contributions to the same stage merge — is only knowable on the install that chose them.

The delivery vehicle is the **host's own plugin system**, not a bespoke AIDLC installer. Every harness the framework targets already ships a manifest-first, git-distributed plugin model (Claude Code `.claude-plugin/`, Codex `.codex-plugin/`); an AIDLC plugin *is* one of those. This is the **hybrid**: real host plugins where a store exists (Claude, Codex), a folder-drop for the one that has none (Kiro). The consequences:

- **We run no distribution infrastructure.** Customers host their own plugin repos (git + semver tags + a `marketplace.json`). One marketplace entry lists a plugin for a mixed fleet.
- **Trust is host-native.** Org restrictions use the host's managed allowlist (Claude `strictKnownMarketplaces`, unoverridable by users; Codex hash-pinned trust). AIDLC builds no trust layer.
- **The composer runs on install, triggered by a host hook.** No pre-built per-combination tree; the SessionStart hook composes the chosen set locally.

> **Security note — Kiro's folder-drop has no install-time trust gate.** Claude and Codex mediate a plugin through their own trust prompts (managed marketplace / hash-pinned approval) *before* its hooks can run. Kiro has no plugin store, so the folder-drop path copies the plugin's files — including the `.kiro.hook` that runs `compose.ts` on the next prompt — with **no equivalent gate**: dropping the tree *is* the trust decision. Treat a Kiro plugin drop like `git clone && run`: only install plugins from a source you would run code from, review the diff the drop introduces, and pin the plugin repo to a reviewed tag rather than tracking a moving branch. The composer itself is additive and never edits `core/`, but the hook it installs executes with your shell's privileges.

The contribution seam (§6) is why this matters: it is structurally VS Code's `contributes` + Cargo's additive feature-union — the best-composing model in the field — and it is available to *every* plugin, first- and third-party alike, with no gatekeeping.

## 3. Plugin structure and manifest

A plugin's tree mirrors `core/`'s shape, so the packager can project it into every harness — authored once, harness-neutral:

The tree mirrors `core/`'s full shape as the *designed* surface; ✅ marks the subtrees the packager projects today, ⏳ marks designed-but-not-yet-projected ones (§7):

```text
plugins/<name>/
  .aidlc-plugin/plugin.json              # the manifest
  stages/<phase>/<slug>.md               # ✅ NEW stages (slug identity; number is display-only)
  sensors/aidlc-<id>.md                  # ✅ NEW sensor manifests
  tools/<id>.ts                          # ✅ sensor scripts (so a sensor can run)
  contributions/<phase>/<slug>.md        # ✅ ADDITIVE modifications to core stages (§6)
  agents/<plugin>-<role>-agent.md        # ✅ NEW agents (stem == frontmatter name)
  scopes/<plugin>-<name>.md              # ✅ NEW scopes (stem == frontmatter name)
  knowledge/<agent-slug>/…               # ✅ per-agent METHODOLOGY knowledge
  tests/                                 # the plugin's own content validation (integration tier)
  memory/{org,team,project}.md           # ⏳ method/rule additions → default-space seed (§7)
  memory/phases/<phase>.md               # ⏳
```

Core scope files use the `aidlc-` filename prefix; plugin scope files replace it
with the plugin prefix (`<plugin>-<name>.md`), and the filename stem equals the
frontmatter `name`. Plugin agent files follow the same rule:
`<plugin>-<role>-agent.md`, with frontmatter `name` equal to the stem.

`.aidlc-plugin/plugin.json` is a **declarative** manifest. Its top level mirrors the common host plugin-manifest shape (so a marketplace or host tooling can list/version/trust it); AIDLC-specific config is isolated in a nested `aidlc` block:

```jsonc
{
  "name": "test-pro",                 // == dir name; "core", "aidlc", and "aidlc-*" are reserved; kebab-case
  "version": "0.1.0",                 // semver; checked against dependents' constraints
  "description": "…",
  "author": { "name": "AWS AIDLC" },
  "dependencies": ["core", "compliance@^1.2.0"],  // resolved vs git tags (<plugin>--v<version>)
  "aidlc": {
    "contributes": {                  // which subtrees this plugin ships
      "stages": "stages/", "agents": "agents/", "scopes": "scopes/",
      "memory": "memory/", "sensors": "sensors/", "knowledge": "knowledge/",
      "tools": "tools/", "overlays": "contributions/"
    }
  }
}
```

Contribution paths are plugin-relative and may not escape the plugin root. The top level is **lenient** (unknown keys preserved, for forward-compat and cross-tool tolerance); the `aidlc` block is *designed* to be **strict** (unknown keys rejected, to catch authoring typos) — but note that today the packager discovers content by directory convention (`stages/`, `sensors/`, `tools/`, `contributions/`, `scopes/`, `agents/`, `knowledge/`), and does **not** yet read the `aidlc.contributes` block or enforce its strictness. Stage numbers are display-only, so a plugin claims no number range in the manifest. `overlays` is the intended name for the contribution directory (§6), consumed by the merge rather than copied.

## 4. Composition model

The composer runs once over `bare core + {chosen plugins}` and writes the effective install. The **same composer** runs regardless of how it is triggered:

| Host | Trigger | Trust |
|------|---------|-------|
| **Claude** | SessionStart hook (fires eagerly on session spawn) | managed allowlist (`strictKnownMarketplaces`) |
| **Codex** | SessionStart hook (fires lazily on first interaction) | one-time trust prompt, content-hash-pinned |
| **Kiro** (CLI/IDE) | `aidlc plugin sync` when the binary is on PATH, or manual `bun <plugin>/hooks/compose.ts` after the folder-drop | n/a - folder-drop distribution |

The steps (identical regardless of trigger):

1. **Resolve** the chosen plugins plus their transitive `dependencies` closure against published versions.
2. **Copy new primitives** — each plugin's `stages`/`agents`/`scopes`/`knowledge`/`sensors`/`tools` subtrees into the corresponding harness roots, substituting the `{{HARNESS_DIR}}` token to the harness's actual dir; `memory` remains deferred (§7).
3. **Merge contributions** — every active contribution to a stage is folded into the target stage's source (§6): structural surfaces set-unioned, prose fragments spliced at their anchors.
4. **Compile** — `aidlc-graph compile` regenerates `stage-graph.json` + `scope-grid.json`; the orchestrator routes entirely off those, so a plugin stage runs the moment it is composed — no prose or skill edit needed.

Because composition is one N-way merge (not a sequence of independent overlays), **two plugins that both contribute to the same stage are genuinely merged** — structural additions set-union, prose fragments order deterministically — rather than one silently overwriting the other. The runtime stays **read-only** with respect to composition: all merging happens at compose time, never per session. The merge edits **stage source** (not the compiled JSON), so it is **durable** across any later `aidlc-graph compile` (e.g. the runtime-compile hook) and **idempotent** — re-running on every SessionStart composes nothing new.

## 5. Selection

Plugins add; the install selects. Composing a plugin copies its files into the
install and merges its additive contributions, but the users of that install see
only the plugins named by `<harness-dir>/tools/data/harness.json`:

```json
{
  "harnessDir": ".claude",
  "rulesSubdir": "rules",
  "plugins": ["aidlc", "test-pro"]
}
```

The `plugins` key is optional. If it is absent, every installed plugin is
enabled, preserving existing installs and keeping shipped core byte-identical.
When it is present, the list is the enabled set. `aidlc` is the implicit core
plugin; omitting it disables core stages/scopes/runners while leaving the files
installed and re-enableable. The three Initialization stages are the exception:
bootstrap has no plugin identity, so those stages are always enabled for every
enabled scope.

Use the deterministic utility command to inspect or change the selection:

```bash
aidlc plugin list
aidlc plugin select test-pro
aidlc plugin select aidlc,test-pro
bun <harness-dir>/tools/aidlc-utility.ts select-plugins
bun <harness-dir>/tools/aidlc-utility.ts select-plugins test-pro
bun <harness-dir>/tools/aidlc-utility.ts select-plugins aidlc,test-pro
```

`select-plugins` validates names against the known set (`aidlc` plus plugin
names found on compiled nodes and scope files), writes `harness.json`, recompiles
the graph, regenerates stage/scope runners, and refreshes the generated
SKILL.md scope/stage tables in one transaction. It snapshots `harness.json`,
`stage-graph.json`, and `scope-grid.json`; if a late regeneration step fails it
restores all three and re-runs the regeneration chain against the restored
selection so the install is not left torn. `/aidlc --doctor` reports the enabled
plugins, per-plugin enabled-stage counts, and hard-fails if the graph's
`enabled:false` flags disagree with `harness.json`.

`aidlc plugin sync` is the command-line front for installed plugin composition.
It runs discovered plugin roots' `hooks/compose.ts` files and exits cleanly with
`no installed plugins; nothing to sync` when no plugin roots are available.

The compiled `stage-graph.json` persists the full installed stage set. Disabled
nodes carry `"enabled": false`; enabled nodes omit the key. Runtime loaders
filter disabled nodes, so runners, state rows, scope tables, and orchestration
see only the selected graph. `loadStageGraphAll()` is reserved for doctor and
selection tooling. Stage numbers are assigned from the full graph, so disabling
and later re-enabling a plugin preserves the exact numbers. The selection
filter covers stages, scopes, and runners; a disabled plugin's `agents/` and
`knowledge/` files stay on disk AND stay loadable (the agent roster and
knowledge lookups are not selection-filtered) - inert unless something
references them, since the stages that would dispatch those agents are
filtered out.

The compiled scope grid contains only enabled scope identities. Scope files for
disabled plugins remain on disk, but they are not valid runtime scopes until the
plugin is selected again. If core is disabled and exactly one plugin scope owner
is enabled, freeform/default scope fallback uses that plugin's first scope
alphabetically. If multiple plugin scope owners are enabled and core's
`feature` fallback is unavailable, the orchestrator errors and asks for an
explicit `--scope`.

Disabling a plugin also removes what it merged into core stages, not just its
own files. Compose records the structural adds it actually applied (produces /
sensors / consumes / required_sections, per target stage) in a per-plugin
sidecar at `tools/data/plugin-contrib-<key>.json`; spliced prose fragments carry
their own sentinel markers. On disable, `select-plugins` strips both from the
installed stage source inside the same rollback transaction, so a disabled
plugin's contributions stop steering enabled stages. Re-enabling restores them
on the next session start: the plugin's compose hook re-merges, byte-identical.

Selection is closure-checked at compile time: an enabled stage may not require
an artifact whose only producer stages are disabled. The error names the
consuming stage, the artifact, the disabled producer stage(s), and the plugin(s)
that provide them, then tells you to enable those plugins or disable the
consumer. This catches plugin-only selections that would otherwise route a stage
with a starved required input. A `requires_stage` edge pointing at a disabled
stage is NOT an error (the ordering edge is vacuous when the dependency never
runs - a plugin-only install legitimately orders plugin stages after core
ones), but doctor lists such dropped edges as an advisory.

`select-plugins` also refuses a change that would strand an active workflow:
disabling the plugin that owns a running workflow's scope, or one that owns a
pending EXECUTE stage in its plan, is rejected naming each dependency (complete
or park the workflow first, or keep the plugin enabled). Doctor hard-fails on a
selection that already strands one.

Composing a plugin does not auto-enable it when a selection already exists. The
compose hook still copies the plugin's own files (stages, scopes, agents,
knowledge, sensors, tools - all runtime-filtered) and records an advisory drop
naming the `select-plugins` command to expose that plugin, but it does NOT
merge contributions into core stage source while disabled - merged
contributions bypass the selection filter, and merging them would undo the
disable-time strip on every session start. With no selection key, composed
plugins are active immediately, preserving the original status quo.

`bundle` is deliberately unused today. The word is reserved for a possible
future collection-of-plugins concept; plugin ownership is always expressed with
`plugin:`.

## 6. The contribution seam

A **contribution** is a file a plugin ships to additively modify a named existing stage, at `contributions/<phase>/<slug>.md`. It never edits the target:

```yaml
---
target: build-and-test        # the existing core stage being enriched
plugin: test-pro
adds:                         # STRUCTURAL — set-unioned into the stage node
  produces:
    - test-pro-regression-suite            # plugin-namespaced (§8)
  consumes:
    - artifact: test-pro-testability-requirements
      required: false
  sensors:
    - coverage-threshold
  required_sections:
    - "Branch Coverage"        # declared H2 (merged into the stage; not machine-enforced yet — see §9)
fragments:                    # PROSE — spliced into the stage body
  - anchor: after-step:9
    order: 100
---

## fragment: after-step:9

### Step 9a (test-pro): Branch + coverage enrichment
…prose the agent reads, inserted after the target stage's Step 9…
```

`bundle:` is reserved and unused; write `plugin:` for plugin ownership.

**Merge semantics:**

- **Structural surfaces** — **set union** into the target stage's source frontmatter. Commutative, order-independent, safe across uncoordinated authors. *Implemented today:* `produces`, `consumes` (artifact + `required` + `conditional_on`, each preserved), `sensors`, `required_sections`. *Not yet merged (deferred):* `adds.scopes` and `adds.requires_stage` — a contribution may declare them, but the compose hook records them to the drops log (`--doctor` surfaces it) rather than merging, so their absence is visible, never silent. When these graduate they set-union like the others.
- **Prose fragments** (`fragments` of step/question prose) — spliced into the stage body at the declared anchor, ordered deterministically by `(order, plugin)`. Each spliced block is wrapped in a content-hashed sentinel, so re-composing is idempotent, an upgraded fragment replaces its prior block, and blocks from separate plugins interleave by `(order, plugin)` regardless of hook-firing order. The agent reads base body + ordered fragments at runtime.
- **No override, ever.** A contribution can only add. It cannot change a stage's `lead_agent`, relax a `consumes[].required`, remove a field, or replace existing step prose. A genuine need to *change* upstream behavior is a framework-level decision, never a quiet patch inside a plugin.

**Fragment anchors:**

| Anchor | Inserts the fragment… |
|--------|------------------------|
| `after-step:<n>` | right after `### Step <n>`'s content (before the next heading) |
| `before-step:<n>` | immediately before `### Step <n>` |
| `after-questions` | after the questions-generating step |
| `end-of-steps` | at the end of the `## Steps` block |
| `in:<Compartment>` | at the end of the named `## <Compartment>` block |

**Surface-by-surface** — what a plugin uses for each kind of upstream change. "Status" marks what the compose hook merges today vs. what is designed-but-deferred:

| Change | Mechanism | Status |
|--------|-----------|--------|
| Stage asks new questions | `fragments` of question prose | ✅ implemented |
| Stage produces an extra artifact | `adds.produces` + a `fragments` step that emits it | ✅ implemented |
| Stage requires new sections | `adds.required_sections` | ✅ merged (⚠️ declarative — not machine-enforced yet, §9) |
| Add a verification to a stage | `adds.sensors` (+ ship the manifest and `tools/` script) | ✅ implemented |
| Add a consume edge | `adds.consumes` | ✅ implemented |
| Add a `requires_stage` edge | `adds.requires_stage` | ⏳ deferred (declared → logged, not merged) |
| Put an existing stage under a plugin scope | `adds.scopes` (or the scope's own `includes_*` — §7) | ⏳ deferred (declared → logged, not merged) |
| Inject phase policy / guardrails | ship `memory/phases/<p>.md` into the default-space seed (§7) | ⏳ deferred (not yet projected) |

## 7. Method/rules, agents, knowledge, scopes, and activation

This section describes the surfaces beyond new stages + the contribution seam,
with status called out so an author is not misled:

**Method/rules → the memory seed** *(⏳ deferred).* The framework's rule layer is the per-space **memory** tree (`aidlc/spaces/<space>/memory/{org,team,project}.md`, `phases/<phase>.md`), seeded from `core/memory/`. The design is that a plugin contributes a `memory/phases/<p>.md` that set-unions into that seed. The packager does not yet project a plugin's `memory/` tree, so this has no effect today.

**Agents** *(✅ projected + composed).* A plugin ships new personas under
`agents/<plugin>-<role>-agent.md`, with frontmatter `name` equal to the filename
stem and `plugin: <plugin>`. Compose copies them into `<harness>/agents/`
without clobbering core or another plugin; an identical file is an idempotent
skip, and different content at the same destination is drop-logged. On
OpenCode, compose also emits a native `.opencode/agents/` twin with
`mode: subagent`, `permission.task: deny`, and OpenCode-valid model/memory
frontmatter.

**Knowledge = methodology only** *(✅ projected + composed).* A plugin ships
per-agent methodology knowledge into `knowledge/<agent-slug>/`, composed into
`<harness>/knowledge/<agent-slug>/`. Domain/space knowledge
(`aidlc/spaces/<space>/knowledge/`) is empty-at-bootstrap user runtime state a
plugin neither ships nor seeds.

**Scopes** *(✅ projected + composed).* A plugin scope's identity is one file
under `scopes/<plugin>-<name>.md`, with frontmatter `name` equal to the filename
stem and `plugin: <plugin>`. Compose copies it into `<harness>/scopes/` without
clobbering. Membership on plugin-authored stages works through those stages'
`scopes:` frontmatter. Adding a plugin scope to an existing core stage via
`adds.scopes` remains deferred and is logged-not-merged (§6).

**Activation (`when:`)** *(⚠️ parsed, not evaluated).* A stage may carry a structured `when:` predicate; `{producer-in-plan: X}` is schema-validated and parsed, but **no engine consumer evaluates it yet** — `aidlc-graph` names itself the future home. So a stage carrying `when:` is today EXECUTE under its declared scopes unconditionally. A plugin's own stages exist only when the plugin is in the chosen set, so "is this plugin active" is already a compose-time fact.

**`plugin.json` `aidlc.contributes`** *(⏳ deferred).* The manifest may carry an `aidlc.contributes` block, but the packager currently discovers content by directory convention (`stages/`, `sensors/`, `tools/`, `contributions/`, `scopes/`, `agents/`, `knowledge/`), not from that block — it is not yet read. There is no `aidlc.lock.json` read either; the composer resolves nothing from a lockfile today.

## 8. Multi-tenant guards

Independent authors who never coordinate are kept safe by:

- **Namespacing.** Contributed artifact logical names are `<plugin>-`prefixed; `core-*` is reserved. A plugin's stages, agents, scopes, and sensors should be unique across the chosen set and against core. Primitive file collisions are no-clobber and drop-logged with attribution (no silent shadowing).
- **Dependency resolution.** `dependencies` resolve by semver against git tags; cycles are rejected; an unsatisfiable dependency is a compose error naming the requiring plugin.
- **Deterministic ordering.** The one non-commutative surface (prose fragments) is ordered by explicit `(order, plugin)`, never by load order.
- **Conflicts are visible.** A genuinely non-commutative collision — the same stage's same fragment anchor at the same order, an unsatisfiable cross-plugin edge, or a duplicate primitive path — is dropped or rejected with attribution, rather than resolving by overlay order.

## 9. As-built: emission, install, and the worked example

`bun scripts/package.ts` discovers `plugins/<name>/` (any dir with `.aidlc-plugin/plugin.json`) and emits a per-harness host plugin at `dist/plugins/<name>/<harness>/` — one more projection target alongside the four harness trees. Each projection carries the host-native manifest (`.claude-plugin/` / `.codex-plugin/` / `.kiro-plugin/`), a `marketplace.json`, the compose hook, and the plugin's content (stages with full `number`/`plugin`/`when` frontmatter — the schema accepts them natively). The compose hook is a single portable `compose.ts` (bun — no GNU-specific shell) that is **harness-agnostic**: plugin root resolves from `CLAUDE_PLUGIN_ROOT | PLUGIN_ROOT | AIDLC_PLUGIN_ROOT`, project dir from `CLAUDE_PROJECT_DIR | AIDLC_PROJECT_DIR | PWD` (Codex leaves the project-dir var unset — PWD is the fallback), and the harness leaf from `AIDLC_HARNESS_DIR`, which each host's hook command exports. It copies new stages/scopes/agents/knowledge/sensors/tools without clobbering, merges the seam idempotently (content-hashed sentinel splices, compare-before-write), and records any contribution it has to drop (missing target, malformed anchor, a key the installed engine won't accept) to per-plugin `<hooksHealthDir>/plugin-compose-<key>.drops` files — the same per-space health dir core hooks write to and `/aidlc --doctor` scans — rather than failing the session.

The emitted SessionStart command probes for `aidlc` on `PATH` first and runs
`aidlc plugin sync` when it is available. If no `aidlc` binary is found, it falls
back to the direct bun `hooks/compose.ts` invocation and still exits 0 when
neither executable is available.

**Install, per host:**

```bash
# Claude Code
/plugin marketplace add <repo-or-path>/dist/plugins/<name>/claude
/plugin install aidlc-<name>@aidlc-plugins        # SessionStart hook composes on next session

# Codex CLI (in a git repo)
codex plugin marketplace add <…>/dist/plugins/<name>/codex
codex plugin add aidlc-<name>@aidlc-plugins       # approve the one-time hook trust

# Kiro (no store — folder-drop, then run the composer explicitly).
# PLUGIN_ROOT is the emitted projection dir (it carries hooks/compose.ts + the
# plugin content); PROJECT_DIR is the install you dropped .kiro into.
PLUGIN_ROOT="$(pwd)/dist/plugins/<name>/kiro"
cp -r "$PLUGIN_ROOT"/. <project>/
AIDLC_PLUGIN_ROOT="$PLUGIN_ROOT" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro aidlc plugin sync
# fallback when aidlc is not installed:
AIDLC_PLUGIN_ROOT="$PLUGIN_ROOT" AIDLC_PROJECT_DIR="<project>" \
  AIDLC_HARNESS_DIR=.kiro bun "$PLUGIN_ROOT/hooks/compose.ts"
```

Then `/aidlc plugin list` and `/aidlc --doctor` reflect the enabled set (e.g. a 34-stage graph for `core + test-pro`, or a filtered graph when `select-plugins` narrows it), and a scoped run (`/aidlc --scope enterprise`) routes the plugin's stages wherever their scopes put them on-path.

**Worked example — test-pro across a mixed fleet.** A platform team publishes `test-pro` once (author against `core/`, `bun scripts/package.ts`, push a `<plugin>--v<version>` tag, drop a `marketplace.json`). Claude teams `/plugin install`; Codex teams `codex plugin add` (approve trust once); Kiro teams `git pull` + run the composer explicitly (above). In every case the composer merges test-pro's two new stages **and** its contributions to `build-and-test`/`nfr-requirements`/`nfr-design`/`performance-validation` — the same enriched, 34-stage, doctor-clean install. Validated across all four harness projections (Claude, Codex, Kiro CLI, Kiro IDE).

**Status.** Implemented and validated: schema support for `number`/`name`/`plugin`/`when` (`aidlc-stage-schema.ts`); compile-side carry-through of authored `plugin` ownership into compiled stage nodes (core omits the field); install-time selection through `harness.json` + `select-plugins`, including full-graph persistence, filtered runtime loading, closure checks, runner pruning, doctor rows, and compose advisory drops; `aidlc plugin list` and `aidlc plugin sync`; plugin-namespaced stage/scope runner generation; the packager emitter (every discovered harness projection); projection and no-clobber compose for plugin `stages/`, `scopes/`, `agents/`, `knowledge/`, `sensors/`, and `tools/`; the harness-agnostic compose hook (`scripts/plugin-hooks-template/compose.ts`); the contribution seam for `produces` / `consumes` / `sensors` / `required_sections` + prose fragments (content-hashed, idempotent, order-deterministic). Guarded by `tests/integration/t188-plugin-compose.test.ts` (the compose mechanism), `tests/integration/t224-plugin-selection.test.ts` (selection), and each plugin's own `tests/` (content; wired into the integration tier). **Deferred / not yet wired:** projection/merge of a plugin's `memory/` subtree; `adds.scopes` / `adds.requires_stage` merge (declared → logged); `when:` predicate evaluation (parsed, no engine consumer); machine-enforcement of merged `required_sections` (the field merges + validates but does not reach the compiled node, and the shipped required-sections sensor derives its expectations from templates — nothing fails a stage for a missing declared section yet); the `after-questions` fragment anchor (`locateAnchor` has no case — it drop-logs "unknown anchor"; use `after-step:<n>`); reading `aidlc.contributes` / any lockfile / `dependencies`; and compile-side carry-through of authored `number` into the compiled node (stages still use re-seeded/pinned numbers today).

## 9. Invariants

- **Core is immutable.** No plugin ever edits `core/`.
- **Additive-only.** Contributions add; they never override or remove.
- **Inert when off.** Disabling every plugin yields bare core, byte-identical.
- **One composer, host-triggered.** The same code composes wherever it runs; the only centrally pre-built artifact is bare core.
- **A plugin IS a host plugin.** The packager emits real `.claude-plugin/` / `.codex-plugin/` / `.kiro-plugin/` manifests, installed through the host's native commands. AIDLC runs no distribution infrastructure.
- **Slug identity, display-only numbers.** Inserting a plugin stage never renumbers core.
- **Trust is host-native.** Org restrictions use the host's managed allowlist; AIDLC builds no trust layer.
- **No gatekeeping.** First- and third-party plugins are mechanically equal; provenance is the only difference.

## Cross-references

- [Authoring a Plugin](../harness-engineering/10-authoring-a-plugin.md) — the author-facing walkthrough (build the fixture end to end).
- [Stage Definition](15-stage-definition.md) — the stage frontmatter contract, including `plugin`/`number`/`when`.
- [Artifact Vocabulary](16-artifact-vocabulary.md) — logical-name namespacing.
- [Engine and Skill System](17-skill-system.md) — the compiled graph the composer feeds and the orchestrator routes off.
- Example config docs (`marketplace.json`, `managed-settings.json`, `aidlc.lock.json`) under [`examples/test-pro/`](examples/test-pro/); the composition-timing evidence and the sequenced build history are preserved in this repo's git log.
