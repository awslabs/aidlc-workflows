# The Plugin Mechanism

> Audience: Tier 2/3 (team adopter, framework contributor).

> **Path convention.** `<harness-dir>/` is the runtime dir (`.claude`, `.codex`, `.kiro`, `.cursor`, or `.aidlc`); `plugins/<name>/` is authored source; `dist/plugins/<name>/<harness>/` is its generated projection; `<project>/<harness-dir>/plugins/<name>/` is a managed installed projection.

This chapter is the canonical reference for **AIDLC plugins**: optional, owned,
versioned contributions of stages, agents, scopes, method/rules, sensors,
doctor checks, and additive modifications to existing core stages. Authors
write one harness-neutral tree and emit real host projections. Native stores
install on Claude/Codex; the managed path serves the other five harnesses. A
plugin never edits `core/`, and disabling all plugins leaves bare core. See
[Stage Definition](15-stage-definition.md), [Engine and Skill System](17-skill-system.md),
[Artifact Vocabulary](16-artifact-vocabulary.md), and
[Authoring a Plugin](../harness-engineering/10-authoring-a-plugin.md).

---

## 1. What a plugin is

A plugin is a directory (and a git repository) with a declarative manifest and core-shaped subtrees. It can:

- **add** new stages (numbered by the engine on first compile — a plugin claims no display-number range), agents, scopes, method/rules (into the space memory seed), and sensors; and
- **modify** existing core stages **additively** via the contribution seam (§6) — enriching what a stage produces, consumes, checks, and instructs, without editing it.

First-party plugins (shipped by the AIDLC team) and third-party plugins (anyone
else) are **mechanically identical**: same structure, seams, composer, and
per-harness installation policy. The difference is provenance: whose
repository publishes the plugin and who reviewed it. `plugins/test-pro/` is
the reference fixture.

The **design principles** the mechanism holds to:

- **Strict-additive, never override.** Contributions only *add*. Set-union over structural surfaces is commutative, which is what makes independent authors safe; a genuine conflict is a compose error with plugin attribution, never a silent last-writer-wins.
- **Core immutability.** No plugin edits a `core/` file; everything a plugin ships lives in the plugin's own tree.
- **Reversible & inert when off.** Disabling a plugin recomposes to exactly the install without it.
- **Slug is identity.** Stages are identified by slug everywhere that matters (edges, jumps, resolution). `number` is display/ordering only, so an inserted plugin stage never renumbers or destabilizes core.

## 2. Why install-time, delivered as a host plugin

A recurring design question was whether a plugin is a *build-time* artifact (pre-composed centrally, copied in) or an *install-time* one (composed on the consumer's machine over their chosen set). The mechanism is **install-time**, for two structural reasons the wider ecosystem (npm, Cargo, Helm, VS Code, Nix) has already converged on:

- **Combinatorial explosion.** N plugins yield up to 2ⁿ enabled subsets; a central build cannot pre-compose every combination. The only artifact worth pre-building is **bare core** (the empty set), identical for everyone.
- **Late resolution.** The correct plugin set — and how two plugins' contributions to the same stage merge — is only knowable on the install that chose them.

The delivery model is **hybrid**: real host-plugin projections for all seven
harnesses, installed through the host's own store on Claude and Codex, and
through AIDLC's managed path on Kiro CLI, Kiro IDE, opencode, Cursor, and
GitHub Copilot. A host-shaped manifest alone does not establish a host store
that installs AIDLC stage bundles.

- **We run no distribution infrastructure.** Marketplaces are git repositories
  containing emitted projections, an `aidlc-marketplace.json` descriptor, and
  host aggregate catalogs. Customers can publish the same tree privately.
- **Trust follows the installation path.** Claude/Codex retain their native
  marketplace policy and hook-approval prompts. The managed path fetches a
  tagged archive, verifies the projection's SHA-256 against the catalog, then
  asks for confirmation naming every hook file and tool script introduced.
  `--yes` is explicit consent in automation; non-TTY installs otherwise refuse.
- **Machine policy restricts sources.** `plugins.allowedMarketplaces` in
  `<install-root>/aidlc.settings.json` restricts registration and use. Project
  and local settings cannot override it; administrators manage it directly or
  through MDM. No CLI command writes this allowlist.
- **The composer runs locally.** Host SessionStart hooks or the managed
  install's pinned `engine plugin sync` compose the chosen set, never a
  centrally pre-built per-combination tree.

> **Security boundary.** A matching checksum proves agreement with the selected
> catalog, not that a publisher is benign. Only register sources whose code you
> trust. Hooks and plugin tools run with the user's privileges. A manual folder
> drop bypasses the managed fetch and confirmation, so the person copying the
> bytes owns that trust decision; it is not equivalent to a verified install.

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
  tools/<plugin>-doctor.ts               # ✅ optional /aidlc --doctor checks
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
  "dependencies": ["core", "compliance@^1.2.0"],  // declared contract; resolution is deferred
  "aidlc": {
    "contributes": {                  // which subtrees this plugin ships
      "stages": "stages/", "agents": "agents/", "scopes": "scopes/",
      "sensors": "sensors/", "knowledge": "knowledge/",
      "tools": "tools/", "overlays": "contributions/"
    }
  }
}
```

Create a deterministic minimal authored plugin repository:

```bash
bun <tools-dir>/aidlc-plugin-create.ts <name> [targetDir]
```

CREATE refuses non-empty targets and emits a manifest plus one namespaced
example stage, scope, agent, and tests README. The result is immediately valid;
`hooks/compose.ts` is absent by design because BUILD injects the bundled hook.

Validate an authored plugin repository before building it:

```bash
bun <tools-dir>/aidlc-plugin-validate.ts <plugin-root>
```

The shipped validator runs offline without an AIDLC project or framework
checkout. It checks the manifest, stage schema, scope and agent identity,
plugin-local artifact collisions, accidental test/fixture payloads under
`tools/`, and any vendored `hooks/compose.ts` against the template bundled with
the tool. Top-level `aidlc plugin validate|build` delegate to these same
implementations; `aidlc plugin catalog` assembles their output for publishing.
Create/test remain standalone authoring tools, not public dispatcher verbs.

Build one host projection from the same external repository:

```bash
bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> <harness> [outDir]
```

The builder validates before writing and defaults to
`<plugin-root>/dist/<harness>/`. The checkout packager and shipped builder call
the same emitter. Harness manifests remain the source of truth: packaging emits
their projection records to `tools/data/plugin-targets.json`, which the
standalone builder consumes offline.

Test composition without mutating the selected install:

```bash
bun <tools-dir>/aidlc-plugin-test.ts <plugin-root> \
  --install <project-root> [--harness <name>]
```

The tool builds a projection, copies only the manifest-derived install roots
into a disposable candidate, runs the real compose hook twice, and requires a
drop-free first pass, a clean post-compose graph containing the plugin stages
and scopes, and a byte-stable second pass. Shared harness leaves require
`--harness`. `--dist` remains reserved until RFC #722 milestone 2 provides a
released runtime-bundle channel.

Contribution paths are plugin-relative and may not escape the plugin root.
Unknown top-level and `aidlc` metadata keys are tolerated for additive evolution;
the `aidlc.contributes` block validates supported keys and their exact canonical
directories. Projection discovers `stages/`, `sensors/`, `tools/`,
`contributions/`, `scopes/`, `agents/`, and `knowledge/` by convention;
configurable routing and `memory/` projection remain deferred. `overlays`
names canonical `contributions/`, consumed by the merge rather than copied.
Optional `aidlc.supersededBy` has a validated core-version/note shape (§9).
Stage numbers remain display-only; no plugin claims a number range.

## 4. Composition model

The composer runs once over `bare core + {chosen plugins}` and writes the effective install. The **same composer** runs regardless of how it is triggered:

| Host | Trigger | Trust |
|------|---------|-------|
| **Claude** | SessionStart hook (fires eagerly on session spawn) | managed allowlist (`strictKnownMarketplaces`) |
| **Codex** | SessionStart hook (fires lazily on first interaction) | one-time trust prompt, content-hash-pinned |
| **Kiro CLI / Kiro IDE / opencode / Cursor / Copilot** | Managed install invokes pinned `aidlc engine plugin sync`; later sync uses the managed inventory | tagged archive + SHA-256 verification, machine allowlist, explicit hook/tool confirmation |

The steps (identical regardless of trigger):

1. **Discover and validate** the host-provided installed roots, manifest
   identities/versions, and project selection. Dependency closure is not
   resolved yet; the manifest field remains deferred (§8).
2. **Copy new primitives** — each plugin's `stages`/`agents`/`scopes`/`knowledge`/`sensors`/`tools` subtrees into the corresponding harness roots, substituting the `{{HARNESS_DIR}}` token to the harness's actual dir; `memory` remains deferred (§7).
3. **Merge contributions** — every active contribution to a stage is folded into the target stage's source (§6): structural surfaces set-unioned, prose fragments spliced at their anchors.
4. **Compile** — `aidlc-graph compile` regenerates `stage-graph.json` + `scope-grid.json`; the orchestrator routes entirely off those, so a plugin stage runs the moment it is composed — no prose or skill edit needed.

Because composition is one N-way merge (not a sequence of independent overlays), **two plugins that both contribute to the same stage are genuinely merged** — structural additions set-union, prose fragments order deterministically — rather than one silently overwriting the other. The runtime stays **read-only** with respect to composition: all merging happens at compose time, never per session. The merge edits **stage source** (not the compiled JSON), so it is **durable** across any later `aidlc-graph compile` (e.g. the rebuild-stage-graph hook) and **idempotent** — re-running on every SessionStart composes nothing new.

An engine reinstall is different from a graph compile: copying a fresh
`dist/<harness>/` overwrites the compiled graph and core stage sources, so
plugin-owned files and sidecars may remain while graph entries and contribution
merges disappear. Re-run `/aidlc plugin sync` after every engine upgrade; hosts
with a compose hook also repair the surface on the next session start. The
doctor's **Composed plugin surface** check detects both missing plugin graph
entries and stale structural or prose contributions. Unreadable or malformed
enabled-plugin sidecars and records that target a missing stage also fail the
check rather than being skipped. Because an already-composed structural value
cannot be attributed safely after its provenance is corrupted, recover an
invalid sidecar by refreshing the stock engine, removing that sidecar, and then
running `plugin sync`.

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
aidlc engine plugin select
aidlc engine plugin select test-pro
aidlc engine plugin select aidlc,test-pro
```

`select-plugins` validates names against the known set (`aidlc` plus plugin
names found on compiled nodes and scope files) while holding the workspace
mutation lock. It copies the project surfaces to staging, strips disabled
contributions there, writes `harness.json`, recompiles the graph/grid,
regenerates stage/scope runners, and refreshes the generated SKILL.md tables.
Only then does it diff staging against the live project and submit the complete
set of changed files to `aidlc-transaction.ts`. The audit append is the
transaction's committed validator: if it fails, the engine restores every
selection, graph, runner, table, contribution, and sidecar byte. This replaces
the older three-file snapshot convention. `/aidlc --doctor` reports the enabled
plugins, per-plugin enabled-stage counts, and hard-fails if the graph's
`enabled:false` flags disagree with `harness.json`.

`aidlc engine plugin list` is a separate installed-versus-composed status command; it
does not print or change the project selection.

## 5a. Installed inventory, composition stamps, and sync

`aidlc plugin list` and `aidlc engine plugin list` compare installed state with
project-local composition state offline. The public `list --check` command is
the opt-in published-versus-installed check (§5b):

- Claude reads schema-v2 `~/.claude/plugins/installed_plugins.json` and
  `enabledPlugins` from `~/.claude/settings.json`.
- Codex reads only plugin IDs declared in `~/.codex/config.toml`, then inspects
  their exact cache paths under
  `~/.codex/plugins/cache/<marketplace>/<plugin>/<version-or-local>/`.
- Kiro CLI, Kiro IDE, opencode, Cursor, and Copilot read full managed inventory
  from `<project>/<harness-dir>/plugins/<name>/`. Each child is a complete
  emitted projection, not a copy of the composed project. Missing or malformed
  manifests are invalid entries, not silently absent plugins.
- Without a managed inventory directory, these harnesses retain the current
  injected-plugin-root fallback. Claude and Codex use that fallback when their
  registry source disappears; unavailable inventory is never proof for pruning.

Each adapter reads its host-native manifest (`.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`, `.kiro-plugin/plugin.json`,
`.opencode-plugin/plugin.json`, `.cursor-plugin/plugin.json`, or Copilot's
`.plugin/plugin.json`). Owned manifests
must use `name: aidlc-<key>`, a safe key, and a semver version. Duplicate
identities are rejected with every source path; no adapter recursively scans a
home or cache directory.

Managed installs also write
`<harness-dir>/tools/data/plugin-install-<name>.json`:
`{schemaVersion:1, plugin, version, harness, marketplace:{name,url}, tag, sha256}`.
`update` and `list --check` use this provenance record to identify the source
marketplace. It is distinct from the composition stamp and ownership record;
the illustrative `aidlc.lock.json` is not read or written.

After composition, AIDLC writes
`<harness-dir>/tools/data/plugin-compose-<key>.json` with the plugin name,
version, and a deterministic source hash. The hash covers sorted compose input
paths plus LF-normalized bytes before `{{HARNESS_DIR}}` substitution. Host
wrappers and generated project output are excluded, so same-version vendored
edits and path-only renames are visible.

`aidlc engine plugin list [--verbose|--json]` compares the host inventory with those
stamps. Default output deliberately has only three actions: `current`,
`run: aidlc engine plugin sync`, or `needs attention: <remediation>`. Verbose and JSON
output retain the internal reason: version differs, source changed, not
composed, legacy unstamped, disabled, missing, invalid/ambiguous, inventory
unavailable, or superseded by core (§9).

`aidlc engine plugin sync` composes every enabled installed plugin in a staged project,
regenerates graph and runner surfaces, writes composition and ownership records,
diffs the staged project, and submits one project transaction. Expected-state
checks reject concurrent live edits; a commit failure rolls back all bytes,
modes, stamps, and ownership records. A supported host hook with an injected
current root uses the same implementation for only that plugin. Plain sync never
deletes content for a missing installed source. Explicit
`aidlc engine plugin sync --prune-missing` requires a proved full inventory,
confirmation (`--yes` when non-interactive), and hash-proven ownership; it
refuses locally modified or unowned paths.

Only `aidlc plugin list --check` opts the installed-state listing into a remote
plugin registry check. Plain list, doctor, and sync never fetch catalogs. The
engine namespace forbids network access, including `engine plugin list --check`.

For source-tree installs, the `plugin-sync` utility verb (the compose hooks'
fallback front) runs discovered plugin roots' `hooks/compose.ts` files and
exits cleanly with
`no installed plugins; nothing to sync` when no plugin roots are configured. If
roots are configured but none carries `hooks/compose.ts`, it exits 1 and names
each root and reason; with a mixed set it warns for each skipped root, composes
the valid roots, and exits 0.

### Plugin doctor checks

An enabled plugin may ship `tools/<plugin>-doctor.ts`. `/aidlc --doctor`
discovers that script in the composed harness tools directory and runs it
directly with Bun, no shell, with `AIDLC_PROJECT_DIR`, `AIDLC_HARNESS_DIR`, and
`AIDLC_PLUGIN_NAME` set. A disabled plugin's script remains inert. When
`harness.json` has no `plugins` selection, every installed plugin known from the
full stage/scope metadata is eligible. Discovery requires that the plugin own at
least one stage or scope; a plugin that ships only tools, sensors, or knowledge
does not contribute an identity that doctor can discover.

The script writes one JSON object to stdout:

```json
{
  "checks": [
    {
      "pass": false,
      "label": "required connector is installed",
      "fix": "install the connector and re-run doctor",
      "severity": "error"
    }
  ]
}
```

`severity` defaults to `error`; a failing error check fails doctor, while a
failing `advisory` check is displayed and exported without changing the exit
code. Passing checks render normally. Doctor treats the installed plugin as the
code trust boundary, but contains failures: a spawn error, timeout (10 seconds
by default, with `AIDLC_PLUGIN_DOCTOR_TIMEOUT_MS` as a positive-integer
override), non-zero exit, invalid JSON/shape, or malformed entries becomes a
bounded finding instead of crashing doctor. Output is capped at 50 check rows
per plugin, stdout at 256 KiB, and labels/fixes at 300 characters.

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
preferred `classic` fallback is unavailable, the orchestrator errors and
asks for an explicit `--scope`.

Disabling a plugin also removes what it merged into core stages, not just its
own files. Compose records the structural adds it actually applied (produces /
sensors / full consume entries including `required` and optional
`conditional_on` / scopes / required_sections, per target stage) and each
successfully applied fragment's anchor/order/hash in a per-plugin sidecar at
`tools/data/plugin-contrib-<key>.json`; spliced prose fragments also carry their
own sentinel markers. On disable, `select-plugins` strips both from the installed
stage source inside the same rollback transaction, so a disabled plugin's
contributions stop steering enabled stages. Re-enabling restores them on the
next session start: the plugin's compose hook re-merges, byte-identical.

Compose hooks and `select-plugins` serialize planning on the same realpath-keyed
workspace lock; live project changes then commit through the transaction
engine's root lock and expected-state checks. The protected span covers
installed stage edits, per-plugin sidecars, selection writes, graph/grid
compilation, runner/table generation, audit validation, and rollback, so
concurrent plugin hooks cannot lose one another's set-union updates and a
disable cannot race with compose to leave an untracked contribution active.

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

## 5b. Marketplaces

A marketplace is explicitly registered, never inferred from plugin content.
Its root `aidlc-marketplace.json` uses schema version 1:

```json
{
  "schemaVersion": 1,
  "name": "aidlc-plugins",
  "owner": { "name": "AWS AIDLC" },
  "description": "AIDLC plugin catalogue.",
  "plugins": [{
    "name": "test-pro",
    "version": "0.1.0",
    "description": "Testing stages and additive contributions.",
    "tag": "test-pro--v0.1.0",
    "harnesses": {
      "claude": {
        "path": "test-pro/claude",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
      }
    }
  }]
}
```

The all-zero digest above illustrates the field shape; generate real values
with `aidlc plugin catalog`, never copy it into a published catalog. Harness keys
are `claude`, `codex`, `kiro`, `kiro-ide`, `opencode`, `cursor`, and `copilot`.
Each projection has a safe repository-relative path and a lowercase hex
SHA-256 over every regular file in sorted relative-path order, each file
contributing a length-framed record (`u64be(len(path)) path u64be(len(bytes))
bytes`, raw bytes) so file boundaries cannot be forged by splicing one file's
bytes into another. Symlinks are refused. This digest covers the entire
projection, unlike the composition stamp's normalized compose-input hash.
Optional `archive` supplies a same-source-host tagged archive URL for direct
catalog hosting; optional `supersededBy: {core, note?}` advertises graduation
(§9).

### Register, discover, and check

```bash
aidlc plugin marketplaces add your-org/your-marketplace --name team --project
aidlc plugin marketplaces list --json
aidlc plugin search testing --marketplace team
aidlc plugin list
aidlc plugin list --check --json
aidlc plugin marketplaces remove team --project
```

Sources accept `owner/repo`, `https://github.com/owner/repo[.git]`,
`git@github.com:owner/repo.git`, or an HTTPS URL ending in
`aidlc-marketplace.json`. Plain HTTP is allowed only for loopback mirrors/tests;
embedded credentials are refused. GitHub sources normalize to a repository URL
and use the contents API for the catalog and the tag tarball API for archives.
Private GitHub repositories use `GITHUB_TOKEN` or `GH_TOKEN`; tokens are sent
only to `api.github.com`, never placed in the registered URL.

Registration defaults to project `aidlc.settings.json`; `--local` uses the
project-local layer and `--global` the per-user machine layer. Marketplace keys
merge across layers; a higher layer overrides the same key. `list` shows the
effective URL and source layer, plus machine-policy blocks. `remove` removes
only the named layer's entry, so a lower-layer registration may become visible.
`add` schema-validates the fetched catalog before writing; `add --offline`
records the normalized source without fetching, for later online use.

`search` queries allowed registered catalogs, filters names/descriptions, and
sorts by plugin then marketplace. One failed source warns without discarding
successful results; all sources failing exits 3. No sources registered exits 1
and points to `marketplaces add`. `list --check` adds a `PUBLISHED` column and
an update command when a newer version exists, preferring the install record's
marketplace; otherwise it selects the highest published semver. JSON rows add
`published: {version, marketplace, supersededBy?} | null`.

### Install and update

```bash
aidlc plugin install test-pro --marketplace team --harness kiro
aidlc plugin update test-pro --marketplace team --harness kiro --yes
```

With exactly one installed project harness, `--harness` is optional; ambiguous
projects must name it. Multiple marketplaces publishing the same name require
`--marketplace`. An unsupported harness is refused with the available targets.
The client downloads the catalog's tagged archive, checks the projection marker's
plugin/harness identity, and verifies the complete projection digest before
installing or handing off. Updating an already-current version is a no-op.

- **Claude/Codex:** after verification, the CLI prints host marketplace and
  install/update commands and exits **5 (action needed)**. The `@` suffix is
  the catalog's published `name` (the identity the host reads from the
  repository's aggregate `marketplace.json`), never your local registration
  alias. Claude uses `/plugin marketplace add <owner>/<repo>` and
  `/plugin install aidlc-<name>@<catalog name>` (or `/plugin update ...`); Codex
  uses `codex plugin marketplace add <repository url>` and
  `codex plugin add aidlc-<name>@<catalog name>`. Run those commands in the
  host; its trust prompt gates hooks. The CLI does not write a competing host
  store. Store hosts clone a git repository, so a marketplace registered by
  direct catalog URL cannot be handed off: the CLI refuses (exit 1) before
  fetching and names the repository form to register instead.
- **Kiro CLI, Kiro IDE, opencode, Cursor, Copilot:** after listing every hook
  file and tool script, the CLI asks `Install? [y/N]`. A non-interactive caller
  must pass `--yes`. One project transaction replaces the managed projection
  and writes its install record; the pinned engine then composes it. A compose
  failure exits 1, leaves the verified projection installed, and directs you to
  `aidlc engine plugin sync`; it does not claim a composed install.

Exit codes: **0** success/already current, **1** failed operation or policy
refusal, **2** usage/confirmation required, **3** network unavailable or
forbidden, **4** integrity mismatch (nothing installed), **5** host handoff.
`--json` uses `{schemaVersion:1, ok, code, status, message, data?, remediation?}`;
handoff has `status: "handoff"` and `data.commands`. Every verb's `--help`/`-h`
is side-effect-free. Network work is explicit-only and refuses `--offline`,
`AIDLC_OFFLINE=1`, the machine `offline` setting, or
`AIDLC_ROUTE_NETWORK_POLICY=forbidden`; offline registration is the exception
because it performs no network work. Never run network verbs under `aidlc engine`.

### Publish a marketplace

`bun scripts/package.ts` emits the publishable `dist/plugins/` tree:

```text
dist/plugins/
  aidlc-marketplace.json
  .claude-plugin/marketplace.json
  .codex-plugin/marketplace.json
  test-pro/claude/...
  test-pro/codex/...
  test-pro/kiro/...
```

Publish this tree at a dedicated marketplace repository root and tag each
plugin release `<plugin>--v<version>`. The catalog and host aggregates reference
the same per-harness projections. The first-party destination is
`awslabs/aidlc-plugins`; repository creation and its publishing CI are managed
outside this source tree, not a prerequisite for private marketplaces.

Third-party authors build `<root>/<plugin>/<harness>/`, then run
`aidlc plugin catalog <root> --name team-plugins --owner "Your team"`.
`--description` customizes the catalog description; `--archive-base` generates
explicit `<base>/<plugin>--v<version>.tar.gz` URLs for non-GitHub hosting.
Catalog assembly is offline and rejects inconsistent versions across a
plugin's projections. Copy this tree shape, not first-party ownership, as the
private-marketplace template. See [Authoring a Plugin](../harness-engineering/10-authoring-a-plugin.md#5-distribution--install).

### Standards alignment

[Agent Plugins v1](https://agent-plugins.org/specification) defines a package
format, not distribution, installation, or permissions. Every emitted
projection now carries the v1 **root manifest** `plugin.json`: `$schema`
(`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`), `name`
(`aidlc-<plugin>`, checked against the spec's naming rule at validate and
build time), `version`, `description`, `author {name}`, and AIDLC identity under
`extensions["com.amazon.aidlc"]` (`plugin`, `harness`, `producer`,
`supersededBy?`). A conformant client therefore loads the package (it ships no
`skills/` or `mcp.json`, so it sees a valid plugin with no portable components
and ignores the namespace it does not implement), and APM recognizes the tree.
What the projection does **not** yet do is place AIDLC's files under the
`com.amazon.aidlc/` extension directory (§8.2): `stages/`, `contributions/`,
`hooks/`, and the rest stay at the root where the compose hook, the composition
hash, and every host manifest expect them. That layout migration is feasible
(Claude's manifest accepts `hooks`/`agents` path overrides, so namespaced files
can be referenced from the native manifest) but is a mechanism-level change
across the emitter, composer, and fixtures, deferred deliberately.

[APM](https://microsoft.github.io/apm/) is a viable alternative fetch channel
for storeless harnesses, but it does not compose AIDLC stages and
contributions, hand off to native host stores, or avoid an extra `apm`
prerequisite. The in-binary catalog remains for those gaps; source normalization,
content hashes, and allowlists are overlapping minimum safeguards, not a new
package-format claim. A bounded **APM 0.30.0 probe on 2026-09-10**, using a
loopback git server and `apm install --target kiro` against a projection that
predates the root manifest, established:

| Concern | Observed result and boundary |
|---|---|
| Package recognition and composition | The unmodified projection was refused: `Not a valid APM package: no apm.yml, SKILL.md, hooks, or plugin structure found`. Adding a root `plugin.json` made the tree fetch byte-identically into `apm_modules/<owner>/<repo>/test-pro/kiro/`, but only `.kiro/agents/test-pro-metrics-agent.md` deployed. `stages/`, `contributions/`, `sensors/`, and `hooks/compose.ts` were fetched but ignored; nothing composed. |
| Integrity and source policy | `apm.lock.yaml` recorded `resolved_commit` and a SHA-256 `content_hash`; `apm-policy.yml` supports `dependencies.allow/deny` git-source policy. These protections are useful but do not implement AIDLC's composition contract. |
| Execution and host trust | An explicitly authored SessionStart hook descriptor can use `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` rewritten to the installed root, so it could launch our composer; this was not exercised in a live Kiro session. APM deploys directly into harness directories rather than handing off to Claude/Codex stores, and requires the separately installed `apm` binary. |

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
  - anchor: after-step:8
    order: 100
---

## fragment: after-step:8

### Step 8a (test-pro): Branch + coverage enrichment
…prose the agent reads, inserted after the target stage's Step 8…
```

`bundle:` is reserved and unused; write `plugin:` for plugin ownership.

**Merge semantics:**

- **Structural surfaces** — **set union** into the target stage's source frontmatter. Commutative, order-independent, safe across uncoordinated authors. *Implemented today:* `produces`, `consumes` (artifact + `required` + `conditional_on`, each preserved), `sensors`, `scopes`, `required_sections`. `adds.scopes` carries two guard rails: the scope's identity file must already be installed (a name with no `scopes/<name>.md` would resolve as an all-SKIP phantom), and that installed file's `plugin:` frontmatter must name the contributing plugin exactly — putting a core stage under a core or foreign-plugin scope changes selection semantics the other owner never agreed to, and ownership comes from the file's declared owner, not a name-prefix rule (dash prefixes overlap across plugin names; a core scope declares no `plugin:` and never merges); a violating entry is dropped-with-log, never merged. *Not yet merged (deferred):* `adds.requires_stage` — a contribution may declare it, but the compose hook records it to the drops log (`--doctor` surfaces it) rather than merging, so its absence is visible, never silent. When it graduates it set-unions like the others.
- **Prose fragments** (`fragments` of step/question prose) — spliced into the stage body at the declared anchor, ordered deterministically by `(order, plugin)`. Each spliced block is wrapped in a content-hashed sentinel and its anchor/order/hash is persisted in the contribution sidecar, so re-composing is idempotent, an upgraded fragment replaces its prior block, prose-only plugins retain verifiable provenance, and blocks from separate plugins interleave by `(order, plugin)` regardless of hook-firing order. The agent reads base body + ordered fragments at runtime.
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
| Put an existing stage under a plugin scope | `adds.scopes` (own-plugin scopes only; installed identity file required) | ✅ implemented |
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
frontmatter. On Kiro, compose removes the unsupported `disallowedTools: Task`
line from the `.kiro/agents/` persona while Kiro's native agent tool
configuration keeps nested delegation unavailable; a different
`disallowedTools` value is drop-logged and the persona is not copied. Re-compose
also migrates an existing persona only when it is an exact, unchanged,
same-plugin copy from the pre-projection composer; edited or foreign files retain
no-clobber behavior. An already-composed unsupported value is left in place with
a degraded diagnostic that names the file to remove before re-compose.

On Kiro CLI, Codex, and OpenCode, a Markdown persona in the engine roster is
available only for `mode: inline`. Native dispatch also requires a per-harness
dispatch surface — a hand-authored agent-v1 JSON plus registration in the
conductor's `trustedAgents` list on Kiro CLI, an agent config TOML (the shipped
`aidlc-*-agent.toml` shape) on Codex, or a native `.opencode/agents/` subagent
file on OpenCode. Kiro IDE instead dispatches the installed agent Markdown
itself, but only when `tools:` is non-empty and `permissions.rules` contains at
least one well-formed `capability`/`effect`/`match` entry; empty permissions,
missing or empty rules, and malformed entries are rejected. Compose therefore
rejects a plugin stage whose
dispatched topology (`mob`, `pipeline`, or `subagent` for the lead and
supports; a `reviewer:` on any gated stage regardless of mode) names an agent
without the complete installed dispatch surface, and records the stage, agent,
and remediation in the compose drops log. On Kiro CLI, the JSON and
`trustedAgents` registration are checked independently: having only one still
rejects the stage. On Kiro IDE, author the installed `.md` with both required
blocks or change the stage to `mode: inline`; the IDE path never reads
`aidlc.json`. On OpenCode — the one harness whose native surface compose itself emits
— a plugin-shipped persona counts as the surface when it would survive the
native-twin emission (closed frontmatter, no un-projectable
`disallowedTools`); Kiro/Codex surfaces are always hand-authored, so a
plugin's own files never satisfy those checks. Hand-authoring the missing
surface and re-running compose accepts the stage. The Markdown persona remains
composed for any accepted inline stage that also uses it.

`agent-team` is schema-reserved but has no runtime consumer, so compose rejects
plugin stages that select it on every harness instead of silently treating them
as inline. If the installed stage parser is unavailable, Kiro/Codex/OpenCode
compose fails closed: only a stage with an explicit `mode: inline` scalar and no
`reviewer:` is accepted (quoted scalar forms are recognized). A no-clobber
upgrade cannot remove a stage composed by an older hook, so an existing stage
that fails these dispatch checks remains on disk but emits a degraded health row
naming the remediation.

**Knowledge = methodology only** *(✅ projected + composed).* A plugin ships
per-agent methodology knowledge into `knowledge/<agent-slug>/`, composed into
`<harness>/knowledge/<agent-slug>/`. Domain/space knowledge
(`aidlc/spaces/<space>/knowledge/`) is empty-at-bootstrap user runtime state a
plugin neither ships nor seeds.

**Scopes** *(✅ projected + composed).* A plugin scope's identity is one file
under `scopes/<plugin>-<name>.md`, with frontmatter `name` equal to the filename
stem and `plugin: <plugin>`. Compose copies it into `<harness>/scopes/` without
clobbering. Membership on plugin-authored stages works through those stages'
`scopes:` frontmatter. A plugin scope may set `freeform_default: true` to
nominate itself when the preferred core `classic` default is disabled; at most one
enabled scope may claim the nomination, and graph compilation rejects an
ambiguous selected set. Adding a plugin scope to an existing core stage works
through a contribution's `adds.scopes` (§6) — own-plugin scopes only, and the
scope file must be installed before the merge.

**Activation (`when:`)** *(⚠️ parsed, not evaluated).* A stage may carry a structured `when:` predicate; `{producer-in-plan: X}` is schema-validated and parsed, but **no engine consumer evaluates it yet** — `aidlc-graph` names itself the future home. So a stage carrying `when:` is today EXECUTE under its declared scopes unconditionally. A plugin's own stages exist only when the plugin is in the chosen set, so "is this plugin active" is already a compose-time fact.

**`plugin.json` `aidlc.contributes`.** VALIDATE reads the block, rejects unknown keys, and requires exact canonical values for every currently projected subtree. BUILD and TEST stop on the same findings, and direct emission asserts the path contract again before replacing output. The emitter still discovers bytes by directory convention rather than routing through arbitrary manifest paths; configurable routing remains deferred. `memory` is rejected until its projection exists. There is no `aidlc.lock.json` read either; the composer resolves nothing from a lockfile today.

## 8. Multi-tenant guards

Independent authors who never coordinate are kept safe by:

- **Namespacing.** Contributed artifact logical names are `<plugin>-`prefixed; `core-*` is reserved. A plugin's stages, agents, scopes, and sensors should be unique across the chosen set and against core. Primitive file collisions are no-clobber and drop-logged with attribution (no silent shadowing).
- **Dependency resolution is deferred.** `dependencies` records the intended
  semver contract, but the composer does not read it, resolve tags, or reject
  cycles yet. Authors must not rely on it for activation or ordering.
- **Deterministic ordering.** The one non-commutative surface (prose fragments) is ordered by explicit `(order, plugin)`, never by load order.
- **Conflicts are visible.** A genuinely non-commutative collision — the same stage's same fragment anchor at the same order, an unsatisfiable cross-plugin edge, or a duplicate primitive path — is dropped or rejected with attribution, rather than resolving by overlay order.

## 9. As-built: emission, install, and the worked example

The shared plugin emitter projects one authored root into one host plugin. `bun scripts/package.ts` calls it for discovered first-party `plugins/<name>/` roots; `aidlc-plugin-build.ts` calls it from an external plugin repository. Each projection carries `.aidlc-plugin-projection.json`, binding replacement authority to the logical plugin and exact harness, an Agent Plugins v1 root `plugin.json` (§5b, Standards alignment), plus the host-native manifest (`.claude-plugin/` / `.codex-plugin/` / Copilot `.plugin/` / `.kiro-plugin/` / `.opencode-plugin/` / `.cursor-plugin/`), a `marketplace.json`, the compose hook, and the plugin's content (stages with full `number`/`plugin`/`when` frontmatter — the schema accepts them natively). A non-empty output without a valid matching marker is never cleaned; there is no force bypass. Cursor keeps plugin-agent compose inputs under `aidlc/agents/`, outside Cursor's auto-discovered root `agents/`; compose projects the single native copy into the installed `.cursor/agents/` roster with harness tokens resolved and named model pins removed. The compose hook is a single portable `compose.ts` (bun — no GNU-specific shell) that is **harness-agnostic**: plugin root resolves from `CLAUDE_PLUGIN_ROOT | PLUGIN_ROOT | AIDLC_PLUGIN_ROOT` and falls back to the emitted hook location, project dir from `CLAUDE_PROJECT_DIR | AIDLC_PROJECT_DIR | PWD` (Codex leaves the project-dir var unset — PWD is the fallback), and the harness leaf from `AIDLC_HARNESS_DIR`, which each host command or Cursor launcher supplies. Cursor's launcher additionally parses SessionStart `workspace_roots`, chooses the only root carrying an AI-DLC Cursor install, and refuses multiple matching roots unless `AIDLC_PROJECT_DIR` selects one. It copies new stages/scopes/agents/knowledge/sensors/tools without clobbering, merges the seam idempotently (content-hashed sentinel splices, compare-before-write), and records any contribution it has to drop (missing target, malformed anchor, a key the installed engine won't accept) to per-plugin `<hooksHealthDir>/plugin-compose-<key>.drops` files — the same per-space health dir core hooks write to and `/aidlc --doctor` scans — rather than failing the session. Installed test/fixture payloads are audited separately in a per-harness `plugin-compose-installed-tool-payloads-<harness>.drops` record keyed by the composing harness leaf: the scan walks that harness's installed tools tree even when the corrected plugin projection no longer contains the path, so a clean compose on one harness never erases another harness's advisory, and legacy files are reported without attributing them to whichever plugin happens to compose next because older compose versions stored no tool-file provenance. Sensor manifests carry an extra copy-time guard: discovery flatly scans `sensors/` and indexes only basenames matching `aidlc-<id>.md`, so a plugin manifest under any other name (or nested in a subdirectory) would compose but never fire. Compose rejects such a manifest and records a degraded drop naming the file and the required shape, and reports one an older compose hook already landed the same way on the next run, so a mis-named sensor is never silently dead on disk.

Projection markers also carry the emitted version, description, and optional
graduation tombstone. The packager builds a root `aidlc-marketplace.json` and
Claude/Codex aggregate catalogs over these projections; the per-projection
host metadata is not a replacement for that mixed-fleet marketplace descriptor.

The emitted host manifest is authoritative for plugin identity: compose maps
the host package ID `aidlc-<name>` back to logical `<name>` and rejects owned
stage, scope, agent, or contribution content whose `plugin:` field differs.
Incoming scope/agent names are reserved as each file is accepted, so duplicate
identities within one plugin tree are dropped before compilation. Structural
list comparisons canonicalize quoted and unquoted YAML scalars. Compose also
holds the realpath-keyed workspace lock for the full transaction; if graph
compilation fails, newly copied files and contribution writes are restored
before the retry marker is written.

The emitted SessionStart command probes for `aidlc` on `PATH` first and runs
`aidlc engine plugin sync` when it is available. The portable launchers fall back to
the direct bun `hooks/compose.ts` invocation when the CLI is unavailable.

Cursor's emitted hook uses Cursor's flat camelCase schema
(`hooks.sessionStart[].command`) and invokes
`./hooks/aidlc-plugin-compose.ts .cursor`. That Bun launcher uses `Bun.which`
and `process.execPath` to probe `aidlc` and run the sibling `compose.ts`
portably, without a `sh -c` dependency on native Windows. Kiro IDE's v2
SessionStart registration uses the same launcher with `.kiro kiro-ide` after
the projection is folder-dropped into the workspace root.

**Install, per host:** register a published marketplace, discover its plugins,
then choose the target harness. A local source build first runs
`bun scripts/package.ts`; publish its `dist/plugins/` contents as described in §5b.

```bash
aidlc plugin marketplaces add your-org/your-marketplace --name team
aidlc plugin search test-pro
# Claude/Codex: verify, then follow the printed native host commands (exit 5).
aidlc plugin install test-pro --marketplace team --harness claude
# Storeless harnesses: review the hook/tool list, confirm, install, and compose.
aidlc plugin install test-pro --marketplace team --harness kiro
aidlc plugin list --check
```

Then `aidlc plugin list` and `aidlc doctor` compare installed and composed
plugin versions and source hashes. The selection diagnostics remain in doctor,
and a scoped run (`/aidlc --scope enterprise`) routes enabled plugin stages
wherever their scopes put them on-path.

**Worked example — test-pro across a mixed fleet.** A platform team validates
`test-pro`, builds and tests every supported harness projection, runs
`aidlc plugin catalog`, and publishes the generated tree with a
`test-pro--v0.1.0` tag. Teams register that marketplace and run
`aidlc plugin install test-pro`: Claude/Codex follow the printed host commands
and approve native trust; the other five harnesses confirm the named hook/tool
files and receive a verified managed projection plus automatic composition.
The same composer merges test-pro's new stages and contributions across all
seven harnesses; discovery never changes the additive composition contract.

**Status.** Implemented: all seven harness projections; declarative authoring
and validation; additive stages/scopes/agents/knowledge/sensors/tools and the
contribution seam; selection, graph/runner regeneration, and transactional
composition with ownership-safe prune; Claude/Codex host inventories and full
managed inventory elsewhere; explicit marketplace registration/discovery,
verified install/update, opt-in version checks, and graduation tombstones.
The authoring tools include standalone create/validate/build/test and public
`aidlc plugin validate|build|catalog`. Top-level `create|test` remain unexposed;
invoke the standalone tools. Marketplace and catalog behavior are covered by
`t330-plugin-marketplace` and `t338-plugin-catalog`; composition, selection,
status, and authoring retain their dedicated behavioral suites.

**Deferred / not yet wired:** plugin `memory/` projection/merge and configurable
`aidlc.contributes` routing; `adds.requires_stage` merge; `when:` evaluation;
machine-enforcement of merged `required_sections`; the `after-questions`
fragment anchor (use `after-step:<n>`); dependency resolution and reading an
`aidlc.lock.json` file. Install provenance records are implemented (§5a), but
are not a dependency solver. The standalone test tool's `--dist` argument is
reserved for a release-channel follow-up.

New stage slugs receive next-free display indices after edge-aware ordering
(authored number hint then slug break ties); existing compiled rows keep their
values. The engine owns numbers, and authored `name` seeds the display name.

### Graduation tombstones

When a plugin's capability ships in core, its author publishes a final release
with optional manifest metadata:

```json
{ "aidlc": { "supersededBy": { "core": "2.8.2", "note": "This capability now ships in core." } } }
```

The core version must be strict semver and an optional note must be non-empty.
Emission carries it into `.aidlc-plugin-projection.json`, then catalog assembly
carries it into the published entry. An installed, enabled tombstone has
`state: "superseded"` in offline list JSON and renders
`needs attention: superseded by core v2.8.2; remove the plugin after upgrading to aidlc 2.8.2`.
Doctor inherits that attention state. `list --check` can discover a catalog
tombstone before the installed projection carries it; search annotates it too.
Nothing silently removes or disables the plugin. Follow the migration and
review checklist in [Plugin Graduation](../harness-engineering/11-plugin-graduation.md).

## 10. Invariants

- **Core is immutable.** No plugin ever edits `core/`.
- **Additive-only.** Contributions add; they never override or remove.
- **Inert when off.** Disabling every plugin yields bare core, byte-identical.
- **One composer, local selection.** Host hooks and managed installs invoke the same composer; no central build enumerates plugin combinations.
- **A plugin has a real host projection.** Native stores install on Claude/Codex; the managed path installs on the other five harnesses. Marketplaces are git repos, not AIDLC-operated distribution infrastructure.
- **Slug identity, display-only numbers.** Inserting a plugin stage never renumbers core.
- **Trust is explicit.** Claude/Codex retain native trust prompts; managed installs require a pinned, checksum-verified projection and hook/tool-naming confirmation. Machine `plugins.allowedMarketplaces` restricts registration and use.
- **No gatekeeping.** First- and third-party plugins are mechanically equal; provenance is the only difference.

## Cross-references

- [Authoring a Plugin](../harness-engineering/10-authoring-a-plugin.md) — the author-facing walkthrough (build the fixture end to end).
- [Plugin Graduation](../harness-engineering/11-plugin-graduation.md) — promotion criteria, tombstone release, and marketplace review ownership.
- [Stage Definition](15-stage-definition.md) — the stage frontmatter contract, including `plugin`/`number`/`when`.
- [Artifact Vocabulary](16-artifact-vocabulary.md) — logical-name namespacing.
- [Engine and Skill System](17-skill-system.md) — the compiled graph the composer feeds and the orchestrator routes off.
- Config examples (`aidlc-marketplace.json`, machine `managed-settings.json`, and the historical illustrative `aidlc.lock.json`) under [`examples/test-pro/`](examples/test-pro/); composition-timing evidence and build history remain in git.
