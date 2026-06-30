# Plugin Mechanism — Design Specification

> **Status:** Normative design spec. Defines what an AIDLC **plugin**
> is, how plugins compose, the seams a plugin may use, and the invariants the
> system guarantees. This is the authoritative "what it is."
>
> Companions: [19 — Plugin Composition Timing](19-plugin-composition-timing.md)
> (why install-time, with evidence), [20 — Plugin System
> Vision](20-plugin-system-vision.md) (narrative target state + worked
> example), [21 — Implementation Plan](21-plugin-implementation-plan.md)
> (sequenced, file/seam-level work), and the author guide
> [10 — Authoring a Plugin](10-authoring-a-plugin.md).

## 1. What a plugin is

AIDLC is a small immutable **core** plus an open ecosystem of **plugins**. A
plugin is an optional, owned, versioned set of AIDLC contributions:

- **new primitives** — stages, agents, scopes, method/rules (the memory layer),
  sensors, methodology knowledge; and
- **additive contributions to existing core stages** — making a core stage do
  more without editing it.

A plugin is authored once as a harness-neutral tree, published from its own
repository, and **composed** into a user's install over their chosen set of
plugins. A plugin never edits `core/`; with every plugin disabled, the install
is byte-identical to bare core.

First-party plugins (shipped by the AIDLC team) and third-party plugins (anyone
else) are **mechanically identical** — same structure, same seams, same
composer, same guarantees. The only difference is provenance: whose repository
the plugin lives in and who reviewed it.

## 2. Design principles

- **One composer, multiple invocation sites.** A single composer merges
  `bare core + {chosen plugins}` into the effective install. Where stores exist
  (Claude, Codex) the host's **SessionStart hook** invokes it automatically on
  install; where no store exists (Kiro) a thin **`aidlc plugin compose`** command
  does the same. The composer itself is identical in both paths — the host just
  decides *when* it runs. See [doc 19](19-plugin-composition-timing.md).
- **Strict-additive, never override.** Contributions only *add*. Conflicts are
  rejected at compose time with plugin attribution, never silently resolved by
  order. Additive set-union over structural surfaces is commutative — which is
  what makes independent authors safe.
- **Core immutability.** No plugin edits a core file. Everything a plugin ships
  lives in the plugin's own tree.
- **Reversible & inert when off.** Disabling a plugin removes its contributions;
  the result recomposes to exactly what it would be without that plugin.
- **Deterministic & reproducible.** The same chosen set + the same bare core +
  the same composer produces a byte-identical install, pinned by a lockfile.
- **Slug is identity.** Stages are identified by slug everywhere that matters
  (edges, jumps, resolution). Stage numbers are display/ordering only, so an
  inserted plugin stage never renumbers or destabilizes core.

## 3. Plugin structure

A plugin is a directory (and a git repository) with a declarative manifest and a
set of core-shaped subtrees:

```text
<plugin>/
  .aidlc-plugin/plugin.json              # the manifest (§4)
  stages/<phase>/<slug>.md               # NEW stages (slug identity; number is display-only)
  agents/<slug>-agent.md                 # NEW agents
  scopes/aidlc-<name>.md                 # NEW scopes
  memory/phases/<phase>.md               # method/rule additions to the default-space seed (§8.1)
  memory/{org,team,project}.md
  sensors/aidlc-<id>.md                  # NEW sensor manifests
  tools/<id>.ts                          # sensor scripts (so a sensor can run)
  knowledge/<agent-slug>/…               # per-agent METHODOLOGY knowledge (framework-shipped)
  contributions/<phase>/<slug>.md        # ADDITIVE modifications to core stages (§6)
```

The subtree shape mirrors `core/`'s, so the composer projects a plugin into
**every** harness (Claude, Kiro, Codex) — authored once, harness-neutral. A
plugin MUST NOT be authored per-harness.

> **Method/rules live in `memory/`, not `rules/`, and knowledge is methodology
> only.** The framework's rule layer is the per-space **memory** tree
> (`aidlc/spaces/<space>/memory/{org,team,project}.md`, `phases/<phase>.md`),
> shipped as a default-space seed from `core/memory/`. A plugin contributes to
> *that seed* (§8.1), not a dead `rules/` dir. Likewise `knowledge/` carries only
> per-agent **methodology** knowledge (the framework-shipped
> `<harness>/knowledge/<agent>/` tree); **domain/space knowledge**
> (`aidlc/spaces/<space>/knowledge/`) is empty-at-bootstrap user runtime state a
> plugin neither ships nor seeds.

## 4. The manifest (`plugin.json`)

`.aidlc-plugin/plugin.json` is a declarative manifest. Its top level mirrors the
common plugin-manifest shape (name, version, description, author, dependencies);
AIDLC-specific configuration is isolated in a nested `aidlc` block so other
tooling can list/version/trust a plugin without understanding AIDLC internals.

```jsonc
{
  "name": "ops-pro",                 // == dir name; "core" is reserved; kebab-case
  "version": "1.4.0",                // semver
  "description": "Operation phase …",
  "author": { "name": "AWS AIDLC" },
  "license": "MIT",                  // optional, plugin-shape metadata
  "homepage": "https://…",           // optional
  "repository": "https://github.com/…",  // optional
  "keywords": ["operation", "runbook"],   // optional; discovery
  "dependencies": ["core", "compliance@^1.2.0"],  // plugin deps; semver vs git tags
  "aidlc": {
    "contributes": {                 // which subtrees this plugin ships
      "stages": "stages/", "agents": "agents/", "scopes": "scopes/",
      "memory": "memory/", "sensors": "sensors/", "knowledge": "knowledge/",
      "tools": "tools/", "overlays": "contributions/"
    }
  }
}
```

- **`name`** — the plugin's identity and namespace prefix; equals the directory
  name, kebab-case, and may not be `core`.
- **`version`** — semver; checked against dependents' constraints.
- **`description` / `author` / `license` / `homepage` / `repository` /
  `keywords`** — optional, standard plugin-manifest metadata (the same field
  *names* Claude Code and Codex `plugin.json` use), for discovery and marketplace
  listing.
- **`dependencies`** — other plugins this one requires, as `name` or
  `name@<range>`; resolved against the dependency's git tags
  (`<plugin>--v<version>`). Constraints from multiple dependents are intersected
  to the highest satisfying version.
- **`aidlc.contributes`** — maps each shipped subtree to its core role. All keys
  optional; ship only what the plugin provides. `overlays` is special — it is
  the contribution directory (§6), consumed by the merge rather than copied.
  Every path is plugin-relative, must start `./` or be a bare subdir, and may not
  escape the plugin root with `..` (Codex's path rule — keeps a plugin
  self-contained and portable).

> Stage numbers are display-only (§2), so a plugin does **not** claim a number
> range. A stage's authored `number` is a display hint; its position in the graph
> is determined by its slug-based edges.

### Validation stance — lenient outside, strict inside

AIDLC's *own* validator (the composer) splits forward-compatibility from
typo-safety:

- **Top level is lenient.** Unknown top-level keys are *preserved, not rejected*,
  so a newer `plugin.json` does not break an older composer. This follows Codex's
  `extra`-map model, **not** Claude Code's — Claude's manifest validator *rejects*
  unknown keys.
- **The `aidlc` block is strict.** Unknown keys inside `aidlc` are *rejected*, so
  an author's typo (`contribues`, `stage` vs `stages`) fails loudly at validate
  rather than silently doing nothing.

> **Cross-tool reality (not parity).** A `plugin.json` is shaped *like* a plugin
> manifest and shares field names, but it is **not** drop-in valid for another
> host. Claude Code's strict validator would **reject** the top-level `aidlc`
> block outright; only Codex (which preserves unknown keys) would tolerate it.
> So the value of the shared shape is *familiarity and tooling reuse* (a
> marketplace can list it, an admin can trust it by the same fields), not
> literal cross-tool installability. The `aidlc`-namespacing keeps AIDLC's strict
> surface separate from the shared metadata surface, but does not make the file
> portable into a strict host.

## 5. Composition model

The composer runs once over `bare core + {all chosen plugins}` and writes the
effective install. The **same composer** runs regardless of how it's triggered:

| Host | Trigger | Trust |
|---|---|---|
| **Claude** | SessionStart hook (fires eagerly on session spawn) | host managed allowlist (`strictKnownMarketplaces`) |
| **Codex** | SessionStart hook (fires lazily on first interaction) | one-time trust prompt, content-hash-pinned |
| **Kiro** (CLI/IDE) | `aidlc plugin compose` (thin wrapper) | n/a — folder-drop distribution |

Steps (identical regardless of trigger):

1. **Resolve** the chosen plugins plus their transitive `dependencies` closure
   against published versions.
2. **Merge new primitives.** Each plugin's `stages`/`agents`/`scopes`/`memory`/
   `sensors`/`knowledge`/`tools` subtrees are added to the corresponding core
   roots (the `memory` subtree merges into the default-space memory seed — §8.1).
3. **Merge contributions.** Every active contribution to a stage is folded into
   that stage's compiled node (§6), set-unioning structural surfaces across all
   plugins and splicing prose fragments in deterministic order.
4. **Validate the merged graph** — once, over the whole set (§7).
5. **Compile** — produce the stage graph and scope grid, resolving activation
   predicates over the merged graph.
6. **Project** — write the effective install for the target harness.

Because composition is one N-way merge (not a sequence of independent overlays),
**two plugins that both contribute to the same stage are genuinely merged** —
their structural additions set-union and their prose fragments order
deterministically — rather than one silently overwriting the other.

The runtime is **read-only** with respect to composition: all merging happens at
compose time, never per session.

### Distribution: the hybrid model

An AIDLC plugin is **emitted as a real host plugin** by the packager (one
projection target per harness: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`).
The plugin IS a host plugin — it installs through the host's native commands,
and its SessionStart hook runs the composer. Where no host store exists (Kiro),
the same plugin is distributed as a git repo and composed via the thin `aidlc
plugin compose` command. Same plugin, same composer — two delivery paths.

- **Versioning** = semver tags on the plugin's git repo.
- **Trust** = the host's own managed mechanism (Claude: `strictKnownMarketplaces`;
  Codex: `trust_level` + hook content-hash). We run no distribution infra.
- **Marketplace** = a `marketplace.json` in the plugin repo — one entry works
  across hosts. See [doc 20](20-plugin-system-vision.md) for the worked example.

## 6. The contribution seam (modifying an existing core stage)

A **contribution** is a file a plugin ships to additively modify a named existing
stage, at `contributions/<phase>/<slug>.md`. It never edits the target.

```yaml
---
target: nfr-requirements      # the existing stage being enriched
plugin: ops-pro
adds:                         # STRUCTURAL — set-unioned into the stage node
  produces:
    - ops-pro-operational-nfr-requirements   # plugin-namespaced (§7)
  consumes:
    - artifact: core-business-logic-model
      required: false
  sensors:
    - ops-pro-operational-nfr-sections
  required_sections:
    - "Operational NFRs"      # machine-enforced
  scopes:
    - enterprise-plus         # adds this stage to a (plugin-defined) scope
fragments:                    # PROSE — spliced into the stage body
  - anchor: after-step:3
    order: 100
---

## fragment: after-step:3

### Step 3b (ops-pro): Capture operational NFRs
…prose the agent reads, inserted after the target stage's Step 3…
```

### Merge semantics

- **Structural surfaces** (`produces`, `consumes`, `requires_stage`, `sensors`,
  `required_sections`, `scopes`) — **set union**. Commutative and
  order-independent; safe across uncoordinated authors.
- **Prose surfaces** (`fragments` of step/question prose) — appended at the
  declared `anchor`, ordered deterministically by `(order, plugin, anchor)`. The
  agent reads base body + ordered fragments at runtime.
- **No override, ever.** A contribution can only add. It cannot change a stage's
  `lead_agent`, relax a `consumes[].required`, remove a field, or replace
  existing step prose.

### Fragment anchors

| Anchor | Inserts the fragment… |
|---|---|
| `after-step:<n>` | right after `### Step <n>` |
| `before-step:<n>` | immediately before `### Step <n>` |
| `after-questions` | after the questions-generating step |
| `end-of-steps` | at the end of the `## Steps` block |
| `in:<Compartment>` | at the end of the named `## <Compartment>` block |

### Surface-by-surface map

| Upstream change a plugin needs | Mechanism |
|---|---|
| Inject phase policy / guardrails | ship `memory/phases/<p>.md` into the default-space seed (§8.1) — loaded for every stage in that phase |
| Stage asks new questions | `fragments` of question prose |
| Stage produces an extra artifact | `adds.produces` + a `fragments` step that emits it |
| Stage requires new sections | `adds.required_sections` (machine-enforced) |
| Add a verification to a stage | `adds.sensors` (+ ship the manifest and `tools/` script) |
| Add DAG edges | `adds.consumes` / `adds.requires_stage` |
| Put an existing stage under a plugin scope | `adds.scopes` (or the scope's own `includes_*` — §8) |

## 7. Multi-tenant guards

Independent authors who never coordinate are kept safe by:

- **Namespacing.** Contributed artifact logical names are `<plugin>-`prefixed;
  `core-*` is reserved. A plugin's stages, agents, scopes, and sensors are
  validated for slug-uniqueness across the chosen set and against core — a
  collision is a hard compose error with attribution (no silent shadowing).
- **Dependency resolution.** `dependencies` are resolved by semver against git
  tags; cycles are rejected; an unsatisfiable dependency is a compose error
  naming the requiring plugin.
- **Deterministic ordering.** The one non-commutative surface (prose fragments)
  is ordered by explicit `(order, plugin, anchor)`, never by load order.
- **Conflicts fail loud.** A genuinely non-commutative collision — the same
  stage's same fragment anchor at the same order, an unsatisfiable cross-plugin
  edge, a duplicate primitive slug — errors at compose with plugin attribution,
  rather than resolving by overlay order.

## 8. Scopes and membership

A scope has two parts. Its **identity** (name, depth, keywords, description) is a
single file a plugin ships under `scopes/`. Its **membership** — which stages run
under it — is additive and may be declared two ways, both set-union:

- **Scope-side (coarse).** The scope file declares the phases and/or stage slugs
  it includes (`includes_phases`, `includes_stages`), so a plugin scope can pull
  in existing core stages without touching them.
- **Stage-side (fine).** A contribution's `adds.scopes` (§6) unions a scope name
  into a specific core stage's membership.

Membership is additive-only: a stage can gain scope memberships from a plugin but
never lose one, so bare core stays byte-identical when no plugin is active.

### 8.1 Method/rules and knowledge — what a plugin may ship

The framework's rule layer is the per-space **memory** tree. Core ships it as a
default-space seed (`core/memory/` → `<install>/aidlc/spaces/default/memory/`):
`org.md`, `team.md`, `project.md`, and `phases/<phase>.md`. At runtime the loader
reads `aidlc/spaces/<space>/memory/`, and per-phase method files are loaded for
every stage in that phase (the strict-additive rule layer).

- **A plugin contributes method/rules via `contributes.memory` → `memory/`**,
  which the composer **merges into the default-space seed**. A plugin's
  `memory/phases/construction.md` is set-unioned with core's, so its guardrails
  load for every construction stage — the same additive layering, now in the
  right place. (`contributes.rules` targeting a `rules/` dir is **removed** — that
  directory is no longer read.)
- **Per-space memory is otherwise user runtime state.** A plugin seeds the
  *default-space* tree at compose; it never writes a user's live
  `aidlc/spaces/<space>/memory/` (that is the user's accumulated practice).

Knowledge splits the same way:

- **`contributes.knowledge` ships per-agent METHODOLOGY knowledge only**, into the
  framework-shipped `<harness>/knowledge/<agent-slug>/` tree (overwritten on
  upgrade). This is the knowledge an agent loads when it leads a stage.
- **Domain/space knowledge** (`aidlc/spaces/<space>/knowledge/`) is empty-at-
  bootstrap user runtime state. A plugin does **not** ship or seed it — there is
  no `knowledge/aidlc-shared/`-style plugin surface for it.

Both surfaces are additive and harness-neutral; the composer projects them into
every harness like any other subtree.

## 9. Activation predicates (`when:`)

A stage may carry a structured `when:` predicate, evaluated at compose over the
**merged** graph and baked into the scope grid (the runtime stays read-only):

- **`{producer-in-plan: X}`** — the stage is EXECUTE under a scope only if some
  stage producing artifact `X` is itself EXECUTE on that scope's resolved plan;
  otherwise SKIP. Evaluated as a per-scope greatest-fixpoint, so transitive
  chains cascade.

A plugin's own stages exist only when the plugin is in the chosen set, so "is
this plugin active" is a compose-time fact, not a runtime signal.

## 10. Invariants

- **Core is immutable.** No plugin ever edits `core/`.
- **Additive-only.** Contributions add; they never override or remove. A genuine
  need to *change* upstream behavior is a framework-level design decision — a
  separate, auditable mechanism — never a quiet patch inside a plugin.
- **Inert when off.** Disabling every plugin yields bare core, byte-identical.
- **One composer, host-triggered.** The same code composes wherever it runs —
  triggered by the host's SessionStart hook (Claude/Codex) or by `aidlc plugin
  compose` (Kiro). The only centrally pre-built artifact is bare core.
- **A plugin IS a host plugin.** The packager emits real `.claude-plugin/` and
  `.codex-plugin/` manifests; they install through the host's native commands. We
  run no distribution infrastructure.
- **Deterministic & reproducible.** Same inputs → same composed output.
- **Slug identity, display-only numbers.** Inserting a plugin stage never
  renumbers core.
- **No gatekeeping.** First- and third-party plugins are mechanically equal.
- **Trust is host-native.** Org restrictions use the host's managed allowlist
  (Claude: `strictKnownMarketplaces`; Codex: policy controls + hash-pinned trust).
  We build no trust layer.

## See also

- [19 — Plugin Composition Timing](19-plugin-composition-timing.md)
- [20 — Plugin System Vision](20-plugin-system-vision.md)
- [21 — Plugin Implementation Plan](21-plugin-implementation-plan.md)
- [10 — Authoring a Plugin](10-authoring-a-plugin.md)
