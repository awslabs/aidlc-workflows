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

Start a new repository with `aidlc-plugin-create.ts`; this chapter then walks
the richer `test-pro` reference plugin end to end.

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

`contributes` declares the conventional plugin subtrees. Configurable routing is
not implemented yet, so each present value must use the exact canonical path
shown above; VALIDATE, BUILD, and TEST reject alternatives such as
`"stages": "custom-stages/"` instead of silently omitting that content.
`tools` lands CLI scripts in the harness `tools/` dir so a plugin can ship a
**runnable sensor** (its manifest in `sensors/` + its script in `tools/`) and an
optional doctor check.
Keep tests and fixtures in the plugin's top-level `tests/` directory, never
inside `tools/`. Compose drops files under `tools/tests/`, `tools/__tests__/`,
or `tools/fixtures/`, plus co-located `*.test.ts` and `*.spec.ts` files, and
records an advisory drop surfaced by `/aidlc --doctor`. It also scans the
installed tools tree for payloads left by older compose versions; because those
legacy files carry no provenance, that migration advisory names the installed
path without attributing it to the plugin currently composing.
`overlays` is special: its canonical directory is
`contributions/`, whose files are consumed by the merge rather than copied as a
primitive subtree.

`memory` projection remains deferred. Do not declare `contributes.memory` yet:
the authoring tools reject it until the default-space method-seed merge ships.

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
block. Compose also records each successfully applied fragment's anchor, order,
and hash in the plugin contribution sidecar. That provenance exists even for a
prose-only plugin, allowing doctor to detect a missing marker or changed fragment
body after an engine reinstall. Two authoring rules follow from that:

- **Don't write a sentinel-lookalike line in fragment prose.** A line matching
  `<!-- /plugin:… -->` inside your prose will be mistaken for a block terminator
  and corrupt the splice on upgrade.
- **Upgrading from a pre-release build:** installs composed from a *review build*
  of this branch (before the hash was added to the sentinel) carry the old
  hashless marker; an upgrade won't recognize it and will splice a second copy.
  Only PR-branch installs are affected — recompose from a clean base, or delete
  the old block by hand, once.

### Engine upgrade lifecycle

An engine reinstall copies the stock `dist/<harness>/` graph and core stage
sources over the effective install. Plugin-namespaced files and contribution
sidecars can survive that overlay while their graph entries and structural or
prose contribution merges disappear. Authors should make re-composition part of
their upgrade instructions: run `/aidlc plugin sync` after every engine
reinstall or upgrade (or start a new session on a host with the plugin compose
hook). Composition is idempotent, so this restores the same effective surface
without duplicating unchanged contributions. `/aidlc --doctor` reports the
broken state as **Composed plugin surface**. The check fails closed when an
enabled plugin's sidecar is unreadable or malformed, a recorded target stage no
longer exists, or a recorded structural or prose contribution is absent or
changed. Consume records preserve and verify `artifact`, `required`, and optional
`conditional_on`; artifact-only records from older sidecars remain compatible. An
invalid sidecar cannot be reconstructed safely from an already-composed stage:
refresh the stock engine, remove that sidecar, then run `plugin sync`.

## 4. Packaging the other primitives

`test-pro` ships stages, contributions, sensors, a support agent, a scope, and
methodology knowledge. A richer plugin may also add method/rules later; memory
projection remains deferred (doc 18 §9 Status).

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
- **Method/rules.** *(⏳ deferred.)* A future `contributes.memory` surface will
  merge `memory/phases/<phase>.md` and `memory/{org,team,project}.md` into the
  default-space method seed (`aidlc/spaces/default/memory/`). The packager and
  compose hook do not project that subtree yet, and the authoring tools reject
  the declaration so a build cannot report success while omitting it. Do
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

Build a complete host-plugin projection for every harness you support, placing
them under `<marketplace-root>/<plugin>/<harness>/`. The shared emitter keeps
external builds equivalent to first-party `dist/plugins/` output:

```bash
aidlc plugin validate ./test-pro
aidlc plugin build claude ./marketplace/test-pro/claude --plugin-root ./test-pro
aidlc plugin build kiro ./marketplace/test-pro/kiro --plugin-root ./test-pro
aidlc plugin catalog ./marketplace --name team-plugins --owner "Your team"
```

Test each projection against a disposable install before publishing (§ below).
`catalog` writes the schema-v1 `aidlc-marketplace.json` plus the applicable
`.claude-plugin/marketplace.json` and `.codex-plugin/marketplace.json` aggregates.
It reads version/description from projection markers, computes their full-tree
SHA-256 digests, and rejects inconsistent versions across harnesses. It needs
neither a project install nor network access.

### Publish a private marketplace

Use the generated `dist/plugins/` shape as the template; do not copy authored
`plugins/` source in place of projections. Copy the generated contents into
your marketplace repository root, regenerate with your own catalog name and
owner, commit all projections and catalogs together, then tag that commit
`<plugin>--v<version>` (for example `test-pro--v0.1.0`) and push the commit and
tag. Do not move published tags. For direct HTTPS catalog hosting,
`--archive-base https://plugins.example.com/releases/` generates tagged archive
URLs; publish those archives with the same tree paths as the catalog.

```text
your-marketplace/
  aidlc-marketplace.json
  .claude-plugin/marketplace.json
  .codex-plugin/marketplace.json
  test-pro/claude/...
  test-pro/kiro/...
```

The first-party `awslabs/aidlc-plugins` destination uses this same tree, with
publishing CI and repository creation managed separately. Private publishers
do not depend on that repository existing.

### Install on a mixed fleet

Teams explicitly register your marketplace and discover its plugin names:

```bash
aidlc plugin marketplaces add your-org/your-marketplace --name team --project
aidlc plugin search test-pro --marketplace team
aidlc plugin install test-pro --marketplace team --harness claude
aidlc plugin install test-pro --marketplace team --harness kiro
aidlc plugin list --check
aidlc plugin update test-pro --marketplace team --harness kiro --yes
```

Use one install command for the actual project harness, not both examples.
Omit `--harness` only when the project has exactly one installed harness.
Registration can instead use `--local` or `--global`; `marketplaces remove`
removes the chosen layer's entry, not the plugin itself.

**Claude / Codex (host stores):** the CLI first verifies the tagged projection,
then exits **5** with the host commands to run. The `@` suffix is the catalog's
published `name` (here `your-marketplace`'s catalog name), not the local `team`
alias, because the host reads that identity from the repository's aggregate
`marketplace.json`. Claude uses `/plugin marketplace add your-org/your-marketplace`
and `/plugin install aidlc-test-pro@<catalog name>`; Codex uses
`codex plugin marketplace add https://github.com/your-org/your-marketplace` and
`codex plugin add aidlc-test-pro@<catalog name>`. Their native trust prompts
still gate hooks. Store hosts clone a repository, so a marketplace registered
by direct catalog URL is refused for these harnesses; register the repository
form instead. A bundled SessionStart hook invokes the same transactional sync
as `aidlc engine plugin sync`, scoped to its injected plugin root.

**Kiro CLI / Kiro IDE / opencode / Cursor / Copilot (managed path):** the CLI
verifies the projection digest, lists every hook file and tool script, and asks
for confirmation. `--yes` is required without interactive stdin. It installs
the full projection at `<harness-dir>/plugins/test-pro/`, writes
`tools/data/plugin-install-test-pro.json` with marketplace/tag/version/digest,
and invokes the project's pinned engine to compose. If composition fails, the
verified projection stays installed and the command reports the failure with
`aidlc engine plugin sync` remediation. The managed inventory remains available
outside a host hook; manual folder drops retain the injected-root fallback.

The composer merges plugin subtrees and contributions, compiles graph/grid and
runners, and writes a version/source-hash composition stamp. The orchestrator
then sees plugin stages without editing its skill prose.

Sync never edits the live project while composing. It copies the relevant
harness, `.agents`, and `aidlc` surfaces to staging, composes and regenerates
there, writes `plugin-compose-<key>.json` and hash-proven
`plugin-owned-<key>.json`, then commits the staged diff through the shared
transaction engine. A fault restores all files, modes, stamps, and ownership
records. `--prune-missing` is intentionally stricter: it requires a proved full
installed inventory, explicit confirmation (`--yes` in automation), and unchanged
owned hashes; local or unowned bytes are refused.

### Project selection

Composition installs a plugin's bytes; selection controls which installed
stages, scopes, runners, and contributions are active:

```bash
aidlc engine plugin select aidlc,test-pro
aidlc plugin list
aidlc engine plugin sync
```

`plugin select` stages disabled-contribution removal, graph/grid compilation,
runners, and generated tables before committing one project transaction;
re-enabled contributions return on the next SessionStart sync. It refuses to
disable a plugin needed by an active workflow. The
`PLUGIN_SELECTION_CHANGED` audit append is part of committed validation, so an
audit failure rolls the whole selection back. `plugin list` is different: it
compares installed inventory with composition/ownership stamps and does not change
selection.

### Trust and transport

The machine-only `plugins.allowedMarketplaces` setting in
`<install-root>/aidlc.settings.json` restricts registration and use. An
administrator manages it directly or through MDM; project/local layers cannot
set it, and marketplace commands never widen it. Native host restrictions
remain in force on Claude/Codex. Managed installs require checksum verification
and explicit hook/tool consent; a checksum is not a security review of the code.

For private GitHub marketplaces, use `GITHUB_TOKEN` or `GH_TOKEN`, not credentials
in URLs. Network verbs refuse offline mode and the engine namespace's forbidden
network policy. Plain `list`, `marketplaces list/remove`, `catalog`, and help
remain offline; `marketplaces add --offline` only records the source.

See the real [catalog and machine-setting examples](../reference/examples/test-pro/)
and [Plugin Mechanism §5b](../reference/18-plugin-mechanism.md#5b-marketplaces)
for source forms, JSON output, exit codes, and install records. The old
`aidlc.lock.json` example is historical, not a consumed install lock.

### When the plugin graduates into core

Publish a final plugin release whose authored `.aidlc-plugin/plugin.json`
contains `aidlc.supersededBy: {"core":"X.Y.Z","note":"Capability now ships in core."}`,
using the actual strict-semver core release. Rebuild every projection and the
catalog, then publish its new plugin-version tag. Installed markers make
offline list/doctor report `superseded by core vX.Y.Z`; `list --check` can show
the catalog notice before that tombstone is installed. Users upgrade core and
remove the plugin according to the migration note; nothing is silently deleted.
Follow [Plugin Graduation](11-plugin-graduation.md) for acceptance and review.

## Authoring and testing your plugin

Start from the shipped scaffold, then use three test tiers from cheapest to
most realistic.

### Creating your plugin

Create a deterministic minimal plugin repository:

```bash
bun <tools-dir>/aidlc-plugin-create.ts <name> [targetDir]
bun <tools-dir>/aidlc-plugin-create.ts <name> [targetDir] --json
```

The name must be lowercase kebab-case, must match the target directory name,
and cannot be `core`, `aidlc`, or use the reserved `aidlc-` prefix. Without
`targetDir`, output lands at `./<name>/`. CREATE refuses a non-empty target and
never overwrites existing files.

The scaffold includes a schema-valid manifest, one namespaced example stage,
scope, and agent, a root README with the full authoring flow, and a `tests/`
README. It intentionally omits `hooks/compose.ts`; validation reports the
documented absence warning and BUILD injects the bundled current hook.

### Validating your plugin

Run the shipped validator against the plugin repository root before building or
composing:

```bash
bun <tools-dir>/aidlc-plugin-validate.ts <plugin-root>
bun <tools-dir>/aidlc-plugin-validate.ts <plugin-root> --json
```

The tool is offline and standalone: `<plugin-root>` is the directory containing
`.aidlc-plugin/plugin.json`; no AIDLC project or framework checkout is required.
Exit `0` means valid, `1` means authoring findings, and `2` means invalid command
usage. JSON output is `{valid, errors, warnings}` with stable file-scoped
findings.

Validation checks:

- the manifest exists and has the documented identity, SemVer, and
  `aidlc.contributes` shape;
- every stage parses and passes the shipped stage schema, with matching slug,
  filename, and plugin ownership;
- scopes use `<plugin>-<name>.md`, match their frontmatter identity, declare a
  supported depth, and parse declared keywords as a non-empty block or flow
  list;
- agents use `<plugin>-<role>-agent.md` and match their frontmatter identity;
- no two plugin stages produce the same artifact across `produces` and
  `optional_produces`, even when no stage consumes it;
- produced artifacts use the plugin-name prefix, stage bodies are non-empty,
  stage agent references resolve against the bundled core plus plugin roster,
  and contribution targets resolve to bundled core stage slugs;
- authored plugin content uses regular files and directories; symlinks under
  stages, scopes, agents, contributions, sensors, knowledge, tools, or hooks
  are rejected instead of being silently omitted or followed;
- `tools/` contains no nested `tests/`, `fixtures/`, or `*.test.ts` payloads
  that composition would copy into an install;
- a vendored `hooks/compose.ts`, when present, is byte-identical to the
  template bundled with the validator. Absence is valid because plugin build
  injects the current template.

The user-facing `aidlc plugin validate` and `aidlc plugin build` verbs delegate
to these same shipped tools; `aidlc plugin catalog` assembles their projections
for marketplace publishing. Create/test remain available through their shipped
Bun tools, not as top-level dispatcher verbs.

The repository test helper's `validatePluginContent()` delegates these shared
rules to the same tool and retains checkout-aware fixture integration.

### Building your plugin

Project one validated plugin into one host-native plugin:

```bash
bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> claude
bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> codex ./release/codex
bun <tools-dir>/aidlc-plugin-build.ts <plugin-root> cursor --json
```

The builder runs validation in-process before it writes anything. Errors refuse
the build with exit `1`; warnings proceed. Invalid command usage and unknown
harness names exit `2`. Without `outDir`, output lands at
`<plugin-root>/dist/<harness>/`. BUILD also rejects a symlink at the output path,
inside an existing output subtree, or between the trusted build boundary and
the output. For the default output that boundary is the plugin root, so a linked
`<plugin-root>/dist` is refused; environmental aliases above the boundary do
not invalidate an otherwise-owned output.

The authoring flow is:

1. **Create** a deterministic scaffold with `aidlc-plugin-create.ts`.
2. **Author** the plugin-owned stages, scopes, agents, and other contributions.
3. **Validate** the authored root offline.
4. **Build** each harness projection you support.
5. **Test** composition against a disposable copy of a real install.
6. **Publish** the generated tree and `aidlc plugin catalog` output together in
   your marketplace repository, tagged `<plugin>--v<version>`.

All four tools run from a copied AIDLC tools bundle and require neither an
AIDLC project nor a framework checkout.

### Testing composition

Answer "does this plugin compose cleanly into my install?" without modifying
that install:

```bash
bun <tools-dir>/aidlc-plugin-test.ts <plugin-root> \
  --install <project-root> [--harness <name>] [--json]
```

The tool validates and builds first, copies the selected install surfaces into
a temporary candidate, runs the real emitted `hooks/compose.ts`, recompiles the
candidate graph, verifies the plugin stages and scopes are present, and runs
compose a second time to prove idempotency. Any compose drop, graph failure,
missing plugin node, or second-pass file change exits `1`. The live install is
hashed before and after and is never a compose target.

Pass `--harness` when the install is ambiguous, including `.kiro` (Kiro CLI vs
Kiro IDE) and `.aidlc` (Copilot vs OpenCode). `--dist <version>` is reserved
until RFC #722 milestone 2 defines a released runtime-bundle channel.

1. **Content validation** is the always-on baseline. Run
   `aidlc-plugin-validate.ts` against the authored plugin root. It is fast and
   gives precise authoring findings, but it does not prove that packaging or
   composition succeeds.
2. **Compose integration** is the default CI check. Run
   `aidlc-plugin-test.ts` against a real install. Inside this repository,
   `composePluginFixture()` delegates the hook subprocess/drop reader to the
   same shipped implementation while retaining its test-only fixture API.
   This tier is deterministic and exercises the actual builder and composer,
   but it does not launch a model-backed harness.
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

Inside this repository, this content test is the minimum copyable shape. The
helper delegates the shared rules to the shipped tool:

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
  today (doc 18 §9 Status).
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
