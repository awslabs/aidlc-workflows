# AIDLC Plugin System — Implementation Plan

> **Status:** Plan / proposal. Turns the vision in
> [20-plugin-system-vision.md](20-plugin-system-vision.md) and the decision
> in [19-plugin-composition-timing.md](19-plugin-composition-timing.md)
> into sequenced, file-and-seam-level work, building on the as-built mechanism in
> [18-plugin-mechanism.md](18-plugin-mechanism.md). Not all of this is
> needed before GA; the point is to show the whole shape so we can judge what
> fits. Every claim about current behavior is cited to code; "net-new" vs
> "change-on-branch" is called out per item.
>
> **Reading order:** Part A is the foundation (manifest + plugin layout + how
> each primitive is packaged, including the two that don't fall out cleanly).
> Part B works through the open items, each as *decision → call → changes →
> size*. Part C sequences everything and states the v1 cut.

---

## Part A — The manifest and plugin layout (start here)

### A.0 Where we are today

> **Stale coordinates.** This section (and its `file:line` cites) describes the
> #432 stack as branched **before #429**. Post-rebase the line numbers move and
> `contributes.rules`/`knowledge` no longer point at live readers (A.5). Treat A.0
> as the *shape* of what exists, not exact coordinates.

A plugin is `plugins/<name>/` with an **`plugin.json`** default-exporting an
`PluginManifest` (`scripts/plugin-types.ts:53-68`):

```ts
type PluginManifest = {
  name: string;                                  // == dir name, != "core"
  version: string;                               // semver
  requiresBundle: string[];                      // ["core"], ["compliance@^1"]
  numberRanges: Record<string, NumberRange[]>;   // phase → claimed ranges
  contributes: PluginContributes;             // which subtrees ship
};
```

`contributes` keys already cover **every primitive**
(`plugin-types.ts:28-47`): `stages`, `agents`, `scopes`, `rules`, `sensors`,
`knowledge`, `tools`, plus the special `overlays` (the §4 contribution dir). At
build, `pluginDirs()` (`scripts/package.ts:554-568`) maps each key to a core
root via `CONTRIBUTES_DST` (`package.ts:521-531`) and merges the subtree into the
core roots in `buildTree` step 1b (`package.ts:369-380`); `overlays` is skipped
there and consumed by `mergeContributions` (`package.ts:256-351`). Discovery is
`discoverPlugins()` scanning for `plugin.json` (`package.ts:533-538`).

So the *layout* is already right. Two things are wrong for an open ecosystem:
the manifest is **executable TypeScript** (needs `bun` to even read, and is a
foreign shape to the Claude/Codex plugin world), and two primitives can't
actually be wired without editing core (A.3).

### A.1 Decision: a declarative `plugin.json`, Claude/Codex-shaped

**Decision it forces.** Keep the `plugin.json` TS module as the manifest, or
move to a declarative JSON file? The TS module is convenient for first-party
authors (types, imports) but is hostile to third-party distribution and tooling:
you must execute it to learn what a plugin is, and it shares no shape with the
two precedents we want compatibility with (Claude Code `.claude-plugin/plugin.json`,
Codex's plugin manifest).

**My call.** Introduce a declarative **`.aidlc-plugin/plugin.json`** as the
canonical manifest, mirroring Claude Code's `plugin.json` field names where they
overlap, and treat `plugin.json` as an *optional* typed authoring sugar that
compiles to `plugin.json` (or drop it). Rationale: declarative manifests are
what every scaled ecosystem ships (doc 19 §6.3), they're readable without a
runtime, and matching `plugin.json` field names buys us familiarity + a path to
reusing Claude's `/plugin` marketplace plumbing for distribution (Part B,
Trust).

```jsonc
// .aidlc-plugin/plugin.json
{
  "name": "ops-pro",                 // == dir name; reserved: "core"   (plugin.json field name)
  "version": "1.4.0",                // semver                          (shared field name)
  "description": "Operation phase…", // shared field name
  "author": { "name": "AWS AIDLC" }, // shared field name
  "license": "MIT",                  // optional metadata
  "keywords": ["operation"],         // optional; discovery
  "dependencies": ["core", "compliance@^1.2.0"],   // was requiresBundle (shared field name: deps)
  "aidlc": {                         // AIDLC-specific block, ignored by other tools
    "contributes": {
      "stages": "stages/", "agents": "agents/", "scopes": "scopes/",
      "memory": "memory/", "sensors": "sensors/", "knowledge": "knowledge/",
      "tools": "tools/", "overlays": "contributions/"
    }
    // "memory" → default-space method seed, NOT a dead "rules/" dir (A.5)
    // "knowledge" → per-agent methodology only (A.5)
    // no "numberRanges" — stage numbers are display-only (B.2)
  }
}
```

The nested `aidlc` block keeps the top level a valid plugin manifest (so a
host's marketplace tooling can list/version/trust it) while isolating the parts
only AIDLC understands.

> **Compatibility scope (confirmed — both precedents).** Research now confirms
> **both** Claude Code (`.claude-plugin/plugin.json`) and Codex
> (`.codex-plugin/plugin.json`) as manifest-first, git-distributed, only-`name`-
> required systems. We align with the stricter, more inspectable conventions:
> Codex's **explicit component pointers** (`"skills": "./skills/"`) are exactly
> our `aidlc.contributes` model (Claude auto-discovers by directory presence
> instead). Three concrete adoptions: optional metadata fields
> (`license`/`homepage`/`repository`/`keywords`), Codex's path rules (`./`-prefix,
> no `..`), and a **split validation stance** — lenient (preserve unknowns) at the
> top level for forward-compat + cross-tool tolerance, strict (reject unknowns)
> inside `aidlc` for authoring-typo safety. The nested-block design lets a second
> host read the shared top level and ignore `aidlc`.

**Changes (net-new + change-on-branch).**
- *Net-new:* a `plugin.json` parser/validator (`scripts/plugin-manifest.ts`) with
  the split lenient/strict stance + path rules, the `.aidlc-plugin/` convention,
  a one-shot `plugin.json → plugin.json` migration for the two fixtures.
- *Change-on-branch:* `discoverPlugins` (`package.ts:533-538`) to find
  `plugin.json`; `loadPlugin` (`package.ts:540-552`) to parse JSON;
  `PluginManifest` type to carry the new shape (`requiresBundle` →
  `dependencies`, drop `numberRanges`, nest `contributes` under `aidlc`).

**Size:** M (mechanical but touches discovery + both fixtures + types).

### A.1.1 Worked example — `test-pro` as a `plugin.json`

The `test-pro` fixture is the richest plugin we have: 2 new stages, 4 §4
contributions, 2 advisory sensors with their tool scripts, no new agent (it
reuses `aidlc-quality-agent`). Its manifest in the new declarative form is
**created on disk** at `plugins/test-pro/.aidlc-plugin/plugin.json` — every
value taken from the real fixture:

```jsonc
// plugins/test-pro/.aidlc-plugin/plugin.json  (created — this is the real file)
{
  "name": "test-pro",
  "version": "0.1.0",
  "description": "Full-featured testing plugin — comprehensive, traceable test coverage: unit (branch + line coverage), functional, integration, regression, edge (boundary/±min·max), and API positive+negative. Reuses aidlc-quality-agent as the test lead.",
  "author": { "name": "AWS AIDLC" },
  "dependencies": ["core"],
  "aidlc": {
    "contributes": {
      "stages": "stages/",            // test-pro-integration, test-pro-full-suite
      "overlays": "contributions/",   // nfr-requirements, nfr-design, build-and-test, performance-validation
      "sensors": "sensors/",          // aidlc-coverage-threshold, aidlc-requirement-coverage
      "tools": "tools/"               // the two sensor scripts (must ship for the sensors to run)
    }
    // no "agents"/"scopes"/"memory"/"knowledge" — test-pro reuses aidlc-quality-agent
    // and ships none of those primitives.
  }
}
```

Note there is **no `numberRanges`** — under the new design stage numbers are
display-only (doc 18 §2, §4), so a plugin claims no range. The fixture stages
keep their authored `number:` (`3.85`, `4.45`) purely as display hints; their
graph position comes from their slug-based `requires_stage` edges
(`build-and-test`, `deployment-execution`).

What maps from the old `plugin.json` shape to the new file:

| Old `plugin.json` | New `plugin.json` | Note |
|---|---|---|
| `name: "test-pro"` | `"name"` (top level) | shared plugin-manifest field name |
| `version: "0.1.0"` | `"version"` (top level) | shared field name |
| *(file header comment)* | `"description"` (top level) | promoted from comment to real field |
| `requiresBundle: ["core"]` | `"dependencies": ["core"]` | renamed to the shared field name |
| `numberRanges: {…}` | *(removed)* | numbers are display-only — no range to claim |
| `contributes: {rules,…}` | `"aidlc"."contributes": {memory,…}` | nested; `rules`→`memory` (A.5), else key names unchanged |

The plugin's content tree is unchanged — only the manifest moves to
`.aidlc-plugin/plugin.json`:

```text
plugins/test-pro/
  .aidlc-plugin/plugin.json                          # the manifest (created)
  stages/construction/test-pro-integration.md        # slug test-pro-integration, number 3.85
  stages/operation/test-pro-full-suite.md            # slug test-pro-full-suite,  number 4.45
  contributions/construction/nfr-requirements.md      # §6 — target: nfr-requirements
  contributions/construction/nfr-design.md            # §6 — target: nfr-design
  contributions/construction/build-and-test.md        # §6 — target: build-and-test
  contributions/operation/performance-validation.md   # §6 — target: performance-validation
  sensors/aidlc-coverage-threshold.md                 # advisory sensor manifest
  sensors/aidlc-requirement-coverage.md               # advisory sensor manifest
  tools/aidlc-sensor-coverage-threshold.ts            # sensor script
  tools/aidlc-sensor-requirement-coverage.ts          # sensor script
```

This is a good migration fixture precisely because it exercises four of the
eight `contributes` keys and the §6 seam at once — if the parser round-trips
`test-pro` and the build stays byte-identical, the manifest change (A.1) is
proven.

### A.1.2 The full config surface — every JSON a plugin touches

A plugin's manifest is one of four config documents across its lifecycle. All
four are made concrete for `test-pro` under
[`examples/test-pro/`](examples/test-pro/) (see that dir's README):

| File | Role | Authored by | Status |
|---|---|---|---|
| `.aidlc-plugin/plugin.json` | **Manifest** — what the plugin is + ships | plugin author | real file (created) |
| `marketplace.json` | **Catalogue** — discovery + versioning | marketplace maintainer | example |
| `managed-settings.json` | **Trust** — which sources an org permits (managed-only, unoverridable) | org admin | example |
| `aidlc.lock.json` | **Install lock** — pins the composed result | the `aidlc plugin` installer | example |

The trust file is the home for the dropped marketplace (B.4): it mirrors Claude
Code's `strictKnownMarketplaces` as `aidlc.strictKnownBundleSources`, managed-only
and highest-precedence so a developer can't override "only our GitHub org." The lock
file is what makes "same lockfile → same result" real (B.7): it pins the plugin
source SHA + version, the **bare-core version + hash**, the **composer version**,
and a **result hash**. Hashes in the example are placeholders — the installer
that computes them is B.6/B.7.

### A.2 Per-primitive packaging — the map

How each primitive is packaged, and whether it wires additively today
(confirmed in code; 🚩 = needs a core edit, i.e. **forbidden** for a plugin):

| Primitive | Ships as | How it wires | Core edit needed? |
|---|---|---|---|
| **Stage** (new) | `stages/<phase>/<slug>.md`, `plugin:` set, artifacts `<plugin>-`prefixed (no number range — B.2) | merged into `aidlc-common/stages`, compiled into graph | ✅ none |
| **Stage** (modify existing) | `contributions/<phase>/<slug>.md` (§4) | `mergeContributions` set-unions `produces/consumes/sensors/requires_stage/required_sections` + splices prose fragments | ✅ none |
| **Agent** | `agents/<slug>-agent.md`, `plugin:` set | discovered by `loadAgents`; Rule 9 cross-checks `lead_agent`/`support_agents` | ✅ none **to add**; 🚩 to attach to a *core* stage (lead/support is core frontmatter); ⚠️ **no shadow check** |
| **Method/rules** | `memory/{org,team,project}.md`, `memory/phases/<p>.md` → merged into the default-space **memory seed** (post-#429) | per-phase method files load for every stage in that phase, strict-additive | ✅ none — **but NOT a `rules/` dir** (dead post-#429); ships into `memory/` (A.5) |
| **Sensor** | `sensors/aidlc-<id>.md` + script in `tools/` | `loadSensors`; bound via stage `sensors:` or `adds.sensors` in a §4 contribution | ✅ none (attach to core stage via §4 `adds.sensors`) |
| **Knowledge** (methodology) | `knowledge/<agent-slug>/*` → framework-shipped `<harness>/knowledge/` | path-convention load when that agent leads | ✅ none — methodology only; **domain/space knowledge is user runtime, not shippable** (A.5) |
| **Scope** (new file) | `scopes/aidlc-<name>.md`, `plugin:` set | discovered by `loadScopeMetadata` | ✅ none **to define** |
| **Scope membership** (put a stage under the scope) | a stage's `scopes:` frontmatter, transposed at compile | — | 🚩 **core stages can't be tagged** — see A.3 |

> Line numbers dropped from this table — they were pre-#429 and are stale (see
> the B.2 callout). Re-derive after the rebase.

Sensors and methodology-knowledge wire cleanly with zero core edits. Stages (new
and modify) work via the §4 seam. **Three don't fall out cleanly:**
scope-membership (A.3), agent-shadowing (A.4), and **method/rules + knowledge,
which #429 relocated** (A.5).

### A.3 The scope-membership problem (the one that needs a real answer)

**The problem (confirmed).** A scope's *identity* is one file — fine, a plugin
ships it. But a scope's *membership* — which stages run under it — lives as a
`scopes:` tag on **every stage**, transposed into `scope-grid.json` at compile
(`aidlc-graph.ts:119-121`, `996-1010`). A plugin cannot edit core stage
frontmatter, and the §4 contribution seam does **not** allow `adds.scopes`. So a
plugin can define scope `enterprise-plus` but cannot make any *core* stage run
under it — only its own stages. A scope you can't populate is useless.

**Decision it forces.** Pick the mechanism by which a plugin adds *existing core
stages* to a *new* scope, additively, without touching core.

**My call — two complementary additions, both pure set-union (safe, additive):**

1. **Scope-side membership (primary, coarse).** Let a scope file declare the
   phases (and/or stage slugs) it includes:
   ```yaml
   # plugins/ops-pro/scopes/aidlc-enterprise-plus.md
   includes_phases: [inception, construction, operation]
   includes_stages: [nfr-requirements, nfr-design]   # explicit adds
   ```
   At compile, `transposeScopeGrid` unions these into the grid alongside the
   per-stage `scopes:` tags. This answers "enterprise-plus = all of construction
   + these two" without a contribution per stage. A scope shipping in a plugin
   becomes genuinely self-contained.

2. **`adds.scopes` on a §4 contribution (secondary, fine-grained).** Extend the
   contribution schema so a contribution targeting a core stage can set-union a
   scope name into that stage's `scopes:` list — identical merge to the existing
   `adds.sensors`. Use when you want one specific core stage under a scope.

Both are strictly additive (a stage can only gain scope memberships, never lose
one), so bare core stays byte-identical when no plugin is active, and the
multi-plugin merge stays commutative.

**Changes.**
- *Net-new:* `includes_phases`/`includes_stages` fields in the scope schema
  (`aidlc-lib.ts` scope metadata) + a union pass in `transposeScopeGrid`
  (`aidlc-graph.ts:996-1010`); `adds.scopes` in the contribution schema
  (`scripts/contribution-schema.ts`) + a union branch in `mergeContributions`
  (`package.ts` ~313-325, beside the existing `adds.*` unions).
- *Change-on-branch:* the contribution validator and the additive-only doc
  boundary (doc 18 §6) — scope membership joins the list of additive surfaces.

**Size:** M. This is the single most important gap to close before any plugin
that ships a scope is real.

### A.4 Agent shadowing

`loadAgents` has **no duplicate-slug guard**, and `validatePluginSet` doesn't
check agent names (it checks artifacts, ranges, deps only). Two plugins, or a
plugin and core, can define `aidlc-architect-agent` and silently shadow. Covered
as a validation item in Part B (Collisions); the fix is cheap and shared with
scope/sensor names.

### A.5 Method/rules + knowledge moved into the per-space layer (#429)

**The problem (confirmed against current `v2`).** The plan's original
`contributes.rules -> rules/` and `contributes.knowledge -> knowledge/aidlc-shared/`
seams were written against the pre-#429 layout. #429 (per-intent spaces) moved
both:

- **Rules → memory.** `loadRules` now reads `aidlc/spaces/<space>/memory/`
  (files `org.md`/`team.md`/`project.md`, `phases/<phase>.md`; the `-learnings`
  slots are gone). The old `<harness>/rules/` directory **no longer exists and
  nothing reads it** — so a plugin shipping `contributes.rules -> rules/` drops
  files into the void. Core ships the rule layer as a **default-space seed**:
  `core/memory/` → `<install>/aidlc/spaces/default/memory/` (the packager's
  `MEMORY_SRC`/`MEMORY_DST`).
- **Knowledge split.** Per-agent **methodology** knowledge stays framework-shipped
  at `<harness>/knowledge/<agent>/` (from `core/knowledge/`) — that seam still
  works. **Domain/space** knowledge moved to `aidlc/spaces/<space>/knowledge/`,
  which is empty-at-bootstrap **user runtime state** — a plugin can't and
  shouldn't ship it.

**Call.**
- Rename the manifest key `contributes.rules` → **`contributes.memory`**, pointing
  at the plugin's `memory/` subtree, and have the composer **merge it into the
  default-space memory seed** (set-union of `phases/<p>.md` etc. with core's), not
  a `rules/` dir. This restores the strict-additive phase-rule story in the right
  place.
- Keep `contributes.knowledge` but **scope it to methodology** (the
  `<harness>/knowledge/<agent>/` tree). Drop any notion of a plugin shipping
  shared/domain knowledge — that is runtime workspace state.

**Changes.**
- *Change-on-branch:* `CONTRIBUTES_DST` gains `memory → aidlc/spaces/default/memory`
  (replacing `rules → rules`); the composer's subtree merge becomes a *seed merge*
  for memory (set-union into the existing default-space tree, not a fresh copy);
  the `knowledge` mapping stays but the docs/validator constrain it to
  `<agent-slug>/` dirs.
- *Net-new:* validation that a plugin's `memory/` only adds (never overwrites a
  core `org.md`/etc. wholesale) and that `knowledge/` carries only agent dirs.

**Size:** M. Mostly a key rename + a copy→merge change for the memory seed; the
knowledge side is a docs/validation tightening.

> This is the gap the reviewer flagged: the seams existed but pointed at the
> pre-#429 layout. It cannot be designed precisely until the rebase lands (the
> exact resolver paths/segment names come from current `v2` — `MEMORY_SEGMENTS`,
> `memoryDirFor`, `knowledgeDir`), but the *shape* (memory-seed merge for rules;
> methodology-only knowledge) is settled.

---

## Part B — The open items, worked through

Each item: **the decision it forces → my call → file/seam changes (net-new vs
branch) → size & sequencing.**

### B.1 The N-way composer (the foundational engine)

**Decision.** Compose `base + 1` (today) or `bare core + {chosen set}`? The whole
install-time vision (doc 20) and the "two plugins can change the same stage"
guarantee depend on N-way.

**Call.** N-way. It is the prerequisite for everything else; the merge engine is
*already* N-way-capable (`mergeContributions` loops `exts` and unions per target,
`package.ts:273,289,313`) — it's only ever *called* with one plugin.

**Changes (change-on-branch, mostly).**
- The variant loop `writeHarness` (`package.ts:695-704`): instead of one delta
  per plugin against `baseFiles`, compose one tree over the active set —
  `buildTree(m, tmp, ⋃ pluginDirs(exts), exts)`.
- `buildBundleDelta` / `validateBundleGraph` (`package.ts:587-655`): take a
  *set*, validate each stage against its own plugin's manifest (`s.plugin`
  filter generalizes).
- The committed-delta layout (`dist/<harness>/plugins/<plugin>/`) is the
  deepest assumption — it presumes orthogonal, independently-overlaid plugins.
  N-way produces *one composed tree for a chosen set*, not per-plugin deltas.
  This is where build-time-for-plugins goes away (doc 19 §7): CI keeps composing
  per-plugin deltas as a **test/review aid**, but the installed artifact is the
  chosen-set compose.

**What "compose" regenerates (so the orchestrator picks up plugin stages).** The
orchestrator has no hardcoded stage list — it routes off the compiled
`stage-graph.json` + `scope-grid.json` at runtime. So compose = merge the chosen
set → run `aidlc-graph compile` (regenerates both data files, resolving the
`when:` fixpoint) → regenerate the `scope-table` **and** `stage-table` SKILL.md
regions (B.8). Those data files are the entire wiring; no prose/skill edit is
needed for a plugin stage to run.

**Size:** L. The merge is done; the orchestration + packaging-model change is the
work.

### B.2 Stage numbers → display-only; drop range refereeing

**Decision.** Number ranges (`numberRanges`) require someone to referee who
claims `4.50–4.99` — which fights the no-coordination goal. Keep them, or make
numbers display-only?

**Call.** Make `number` **display-only** and drop range *claiming* as a
correctness requirement. Confirmed safe: slug is identity everywhere —
`resolveStage` tries slug first (`aidlc-lib.ts:1733-1735`), `requires_stage`
edges are slugs (`aidlc-graph.ts:651-653,1207-1214`), jumps key on slug
(`aidlc-jump.ts:105,112,206`). The **only** thing that reads `number` for
correctness is the edge-local backward-pointing invariant
(`aidlc-graph.ts:1202-1226`).

**The live `parseFloat` bug (must fix even if ranges stay).** `validateBundleGraph`
parses a stage `number` with `parseFloat(s.number)`, so `"4.50"` becomes `4.5` —
which (a) collapses `"4.50"` and `"4.5"` to the same value and (b) mis-orders
index `50` against index `9`. This is **live in `ops-min`** (which claims
`4.50–4.99`), not hypothetical. The canonical ordering helper does it right:
`numericStageOrder` splits on `.` and `parseInt(...,10)`s each part into an
`[prefix, index]` integer tuple. The number is a **`<prefix>.<index>` pair, not a
decimal** — any code comparing or range-checking it must use the integer-tuple
parse, never `parseFloat`. Dropping ranges (below) removes the buggy call site,
but if any number comparison remains, it must follow the tuple rule.

**Changes.**
- *Change-on-branch:* relax/rewrite the edge-local backward-pointing invariant so
  it no longer assumes globally-comparable numbers (use topo order, which is
  already slug-based); make `number` optional frontmatter (derive a display
  number from topo position when absent); remove `numberRanges` and the
  cross-plugin range-overlap check; **delete the `parseFloat(s.number)` call in
  `validateBundleGraph`** (it disappears with range-checking). Any surviving
  number comparison uses the `numericStageOrder` integer-tuple parse.
- *Net-new:* a display-number derivation for status/SKILL.md.

**Size:** M. Net simplification — deletes a coordination requirement, a
validation pass, and a latent ordering bug.

> **Line numbers in this plan are stale — rebase first.** The `file:line`
> citations throughout were taken before #429 (per-intent spaces) landed; they no
> longer point at the right code, and the #432 plugin stack now conflicts with
> #429. The plan's *decisions* hold, but any implementation must (1) rebase the
> plugin stack onto current `v2`, then (2) re-derive line numbers. See the
> "Rebase + relocation" note in Part C.

### B.3 Collision detection (scope / agent / sensor names)

**Decision.** Artifacts are namespaced (`<plugin>-`), but scope/agent/sensor
slug *names* are not checked across plugins or against core
(`plugin-validate.ts` gap, confirmed). Namespace them, or reject collisions?
(Method/rules are not slug-named primitives — they merge into the memory seed by
file, A.5 — so they're handled by the memory-merge additivity check, not here.)

**Call.** **Reject** collisions at validate time for v1 (cheap, safe), rather
than namespace (namespacing agents would rewrite every `lead_agent` reference —
heavy, defer). A plugin defining a scope/agent/sensor whose slug exists in
core or another plugin is a hard error with attribution — the OPA-roots /
npm-strict-peer "fail loud" model (doc 19 §6.3). This also kills agent shadowing
(A.4).

**Changes (change-on-branch).** Extend `validatePluginSet` with a cross-set +
vs-core slug-uniqueness pass over scopes/agents/sensors (it already has the plugin
set and the core registry in hand for the artifact check). Optionally a
same-`target`-stage advisory so two plugins enriching one stage is visible (it's
*allowed* and merges cleanly, but worth surfacing).

**Size:** S. One validation pass, reuses existing plumbing.

### B.4 Trust — host-native (NO AIDLC-BUILT TRUST LAYER)

**Decision.** Under the hybrid, trust is **delegated to the host**. We build
nothing.

**Confirmed by probes** (`spikes/dist-probe/RESULTS.md`):
- **Claude:** `strictKnownMarketplaces` in managed-settings — enforced pre-fetch,
  unoverridable by user scope, true allowlist. Blocks non-listed sources outright.
- **Codex:** one-time `trust_level: "trusted"` + hook content-hash in
  `config.toml`. Re-prompts only when a hook file changes (security feature).
- **Kiro:** n/a — folder-drop distribution, no host gate.

**Changes: NONE.** This item is deleted from the build. Documentation
(how an org admin configures the host allowlist for AIDLC plugins) is all that's
needed — no code.

**Size:** ~~M~~ → **0** (documentation only; `examples/test-pro/managed-settings.json`
already shows the shape).

### B.5 A second axis over scope (plugin sub-features)

**Decision.** Bundles are all-in/all-out. "MVP build **and** the a11y add-on on
top" has no clean expression. Add a feature axis, or model add-ons as separate
plugins?

**Call.** For v1, **model add-ons as separate plugins** (a11y is its own plugin
with `dependencies: ["mvp-pack"]`) — no new concept, leans on deps we already
have. *Design* a Cargo-style **feature axis** as the post-v1 answer when a real
case needs sub-plugin granularity: a plugin's `plugin.json` declares named
`features`, the user enables a subset, and features map to additive
contributions/stages gated like a mini-scope. Sequenced late because it's the
most speculative item and separate-plugins covers most needs.

**Changes (net-new, deferred).** `features` block in `plugin.json`; a
feature-selection flag on `aidlc plugin add`; feature-gating in the composer
(another additive predicate, like `when:`). Until then: zero — separate plugins
work today.

**Size:** L (deferred).

### B.6 Distribution — packager projection + compose hook (hybrid)

**Decision.** Under the hybrid, distribution splits by host capability:
- **Claude/Codex:** the packager emits a real host plugin (a new projection
  target: `.claude-plugin/` / `.codex-plugin/` with `plugin.json` + a
  `hooks/hooks.json` wiring the SessionStart compose hook). Teams install via the
  host's own `/plugin install` / `codex plugin add`. No AIDLC CLI needed.
- **Kiro:** no store — the thin `aidlc plugin compose` CLI does
  resolve + fetch + compose + project for Kiro. Only this path needs our CLI.

**Changes (net-new).**
- *Packager projection targets:* emit `.claude-plugin/plugin.json`,
  `.codex-plugin/plugin.json`, and the SessionStart hooks.json that invokes the
  composer — one new emitter per host, mirroring how `harness/claude/manifest.ts`
  etc. already drive per-harness emission.
- *Kiro thin CLI:* `aidlc plugin compose` (resolve deps from git tags, fetch,
  N-way compose, project the `.kiro/` tree). The resolver + fetch are shared with
  the compose hook (same code, different invocation).
- *marketplace.json template:* emitted alongside the plugin projections so the
  publisher drops it in and tags.

**Size:** M (down from L — the full install CLI, trust layer, and lockfile
reader/writer from the old B.6 are gone; only the projection target + Kiro
thin-CLI remain). Composes on top of the N-way composer (B.1) and the manifest
(A.1).

### B.7 Lockfile + version stamps (pin bare core and composer)

**Decision.** "Same lockfile → same result" assumes the same bare core and the
same composer, and the lock pins **neither** today. The lockfile work needs a
version stamp first.

**Call.** Land **version stamps before the lockfile**: stamp the composer version
and a bare-core content hash/version into the build, so the lockfile can pin
`{plugin source SHA + version, bare-core version, composer version, result
hash}` (doc 20 §5.2) and `sync` can *detect* a mismatch instead of silently
producing a different tree.

**Changes (net-new, small precursor).** A composer-version constant + bare-core
hash emitted at build; `--check` asserts them. Then the lockfile (B.6) consumes
them.

**Size:** S precursor (do early, cheap); the lockfile itself is part of B.6.

### B.8 Stage-table generator (`aidlc-utility stage-table`)

**Decision.** The orchestrator routes entirely off the compiled
`stage-graph.json` + `scope-grid.json`, so a plugin stage runs as soon as compose
regenerates those (confirmed: there is **no** hardcoded stage list — the engine
reads `loadGraph()` / `subgraphForScope()` at runtime). But `SKILL.md` carries a
human-readable **"Stage Graph" table** (`harness/claude/skills/aidlc/SKILL.md`,
the `| Slug | # | Stage | Phase | … |` block) that is **hand-maintained — no tool
regenerates it**. After an install adds plugin stages, that table is stale: it
still lists only bare core's 32 stages, never `test-pro-integration` etc. Leave
it stale (it's documentation-only; the engine ignores it), or generate it?

**Call.** Generate it, mirroring the existing `scope-table` generator exactly, so
compose refreshes it alongside the scope-grid table. A stale table that silently
disagrees with what the workflow actually runs is a foot-gun for anyone reading
SKILL.md to understand their install; the cost is one generator that already has
a proven template next to it.

**Design (mirror `scope-table`, `aidlc-utility.ts:2740-2854`).**
- **Marker pair** around the table region, like the scope-grid's:
  `<!-- BEGIN: compiled stage graph via \`bun aidlc-utility.ts stage-table\` — do NOT hand-edit -->`
  / `<!-- END: compiled stage graph -->`. (The current table has no markers — a
  one-time edit adds them.)
- **`renderStageTable()`** reads `loadGraph()` (already imported in
  `aidlc-utility.ts`), sorts by `numericStageOrder(a.number, b.number)` (the same
  ordering the graph compile uses), and renders one row per stage. Column
  derivations, taken from how the existing hand-authored table reads vs. the
  compiled node shape:
  - **#** ← `number` (display-only hint).
  - **Phase** ← `phase` capitalized (`initialization` → `Initialization`); the
    phase set is the existing `PHASES` constant.
  - **Lead Agent** ← `lead_agent`, except the reserved `orchestrator` slug renders
    as `(orchestrator)` (reuse `RESERVED_AGENT_SLUG`).
  - **Support Agents** ← `support_agents.join(", ")`, or `—` when empty.
  - **Mode** ← `mode` when `inline`; when `subagent`, reconstruct
    `subagent (<lead>[ → <support, …>])` to match today's rows
    (`subagent (aidlc-developer-agent → aidlc-architect-agent)`,
    `subagent (aidlc-developer-agent)`).
- **`canonicalStageTableRegion()`** = `BEGIN\n\n<table>\n\nEND` (identical shape
  to `canonicalScopeTableRegion`).
- **`handleStageTable(--check)`** byte-compares the SKILL.md region (CRLF
  normalized, single-marker-pair guard, ordering guard) and exits 1 on drift —
  copy `handleScopeTable` verbatim, swapping the markers/renderer. Reuse the
  `AIDLC_SKILL_MD_PATH` env-seam for sandboxed drift tests.
- **CLI:** add a `case "stage-table"` beside `case "scope-table"`
  (`aidlc-utility.ts:3029`) and to the usage string.
- **Wiring into compose + CI:** compose runs `stage-table` (write mode) after
  `aidlc-graph compile`, exactly where it already runs `scope-table`; CI adds a
  `stage-table --check` beside the existing `scope-table --check`.

**Validation that it's correct.** Because the table is currently hand-authored,
the acceptance test is a **round-trip**: `renderStageTable()` over bare core must
reproduce the existing 32-row table byte-for-byte (after adding the markers). If
it does, the generator is faithful and `--check` can be trusted; if not, the
column-derivation rules above are off and get fixed before wiring.

**Changes.**
- *Net-new:* `renderStageTable` / `canonicalStageTableRegion` / `handleStageTable`
  in `aidlc-utility.ts`; the `stage-table` CLI case; a drift test mirroring the
  scope-table test (t67).
- *Change-on-branch:* a one-time edit to `SKILL.md` to wrap the existing table in
  BEGIN/END markers; add the `stage-table` write + `--check` to the build/CI
  scripts.

**Size:** S. One generator from a proven template + a marker edit + a test.

### B.9 Bundled MCP servers (future feature)

**Decision.** Both Codex and Claude Code let a plugin plugin a `.mcp.json`, and
the cross-tool research thesis is "MCP is the universal interop layer" — the one
surface that is portable write-once across every host. AIDLC declares MCP servers
at the *project* root (`.mcp.json` beside `.claude/`), inherited by every agent,
so a plugin that needs its own tool server has **no way to ship one** today.
Should a plugin be able to contribute MCP servers?

**Call — yes, but deferred (post-v2).** It is the right capability (it makes a
plugin genuinely self-contained and matches the rest of the ecosystem), but
nothing in the v1/v2 plan needs it: the shipped plugins (`test-pro`, `ops-min`)
add stages, contributions, sensors, and tools — none require an MCP server. Build
it when a plugin actually does. Parking it keeps the v1/v2 surface small and lets
the seam be designed against a real consumer rather than speculatively.

**Design sketch (when built).**
- A `contributes.mcp` key pointing at the plugin's `.mcp.json` (mirrors Codex's
  `"mcpServers": "./.mcp.json"` pointer and Claude's root `.mcp.json`).
- At compose, the plugin's MCP server entries are **merged** into the install's
  effective MCP set, under the same multi-tenant discipline as other primitives:
  server names are namespaced/uniqueness-checked across the chosen set and against
  the project root, and a collision is a compose error with plugin attribution
  (doc 18 §7) — never a silent last-writer-wins.
- Disabling the plugin removes its servers (inert-when-off holds).
- Because MCP is the portable layer, a plugin's `.mcp.json` is the **one
  sub-artifact that is already cross-tool** — the same file a Codex or Claude
  plugin would ship — so this seam is where AIDLC plugins and host-native plugins
  overlap most cleanly.

**Changes (net-new, deferred).** A `contributes.mcp` manifest key; an MCP-merge
pass in the composer with namespacing/collision checks; lockfile coverage of the
merged MCP set. Until then: zero — plugins use project-root MCP as today.

**Size:** M (deferred to a future release; not v1/v2).

---

## Part C — Sequencing and the v1 cut

### Step 0 — Rebase + relocation (must happen before any of A/B)

The #432 plugin stack (11 commits) was branched **before #429** (per-intent
spaces) landed, so it now conflicts with `v2` and its `file:line` citations are
stale. Before implementing anything:

1. **Rebase** the plugin stack onto current `upstream/v2`. ~25 conflicted
   files; the four committed `dist/` trees should be **regenerated** (`bun
   scripts/package.ts`) after the source conflicts resolve, not hand-merged. The
   real semantic conflicts are in `aidlc-graph.ts` / `package.ts` /
   `aidlc-stage-schema.ts` at the plugins×spaces intersection. Validate with a
   full `bun scripts/package.ts --check` + test run.
2. **Re-point the rules/knowledge seams** onto the post-#429 layout (A.5): rules
   → memory seed, knowledge → methodology-only.
3. **Re-derive all line numbers** in this plan from the rebased code.

Until Step 0 is done, the plan's decisions are sound but its code coordinates are
not. Everything below assumes the rebase has landed.

### Dependency order

```
Step 0  rebase onto v2 + A.5 relocation ── PREREQUISITE for everything
        │
A.1 manifest (plugin.json)  ─┐
B.2 numbers display-only     ├─ independent, do early (each stands alone)
B.7 version stamps          ─┘
        │
A.3 scope membership  ───────── needs nothing; unblocks real scope-shipping plugins
A.5 memory/knowledge seams ──── folded into the rebase; key rename + seed-merge
B.3 collision detection ─────── needs the plugin set (have it); cheap
        │
B.1 N-way composer  ─────────── the engine; everything install-time depends on it
        ├─ B.8 stage-table generator ── part of compose; independent, can land any time
        │
B.6 packager projection + Kiro CLI ── needs B.1 + A.1 (emits host plugins + compose hook)
        │
B.4 trust ── DELETED (host-native; documentation only)
B.5 feature axis  ───────────── deferred; separate-plugins covers it until then
B.9 plugind MCP servers  ────── deferred; project-root MCP covers it until a plugin needs its own
```

> **B.8 is decoupled.** The stage-table generator needs nothing but `loadGraph()`
> (already available) and can land independently — it's cheap and useful even
> pre-N-way (it'd keep the table fresh for first-party multi-plugin builds). It's
> drawn under B.1 only because regenerating the table is logically part of
> "compose."

### What ships first — a usable v1 (no install-time CLI required)

The cheapest genuinely-useful increment is **"plugins that can ship a scope and
modify core stages correctly, validated, still build-time-delivered"** — i.e.
close the *expressiveness* and *safety* gaps before the *distribution* gap:

0. **Step 0 (rebase + A.5 relocation)** — prerequisite; without it the rules
   seam is broken and line numbers are wrong.
1. **A.3 scope membership** — without this, a plugin can't ship a usable scope.
2. **B.3 collision detection** — makes multi-plugin safe (no silent shadowing).
3. **B.2 numbers display-only** — removes the coordination requirement, and the
   live `parseFloat` ordering bug; net simplification.
4. **A.1 `plugin.json`** — declarative, distribution-ready manifest.

That v1 is **all change-on-branch + small net-new**, no new runtime, no CLI — it
hardens what exists and makes first-party multi-plugin real, which is the
forcing function (issue #430) anyway. It also keeps today's build-time delivery,
so nothing about the user's install flow changes yet.

**v2 (the hybrid delivery):** B.1 N-way composer → B.7 stamps → B.6 packager
projection targets + Kiro thin-CLI + SessionStart compose hooks, with B.8
stage-table generator folded into compose (it can also land in v1). B.4 (trust) is
deleted — host-native, documentation only. This is a moderate block (not L — the
full CLI/trust/lockfile layer is gone); doing v1 first lets us validate the
contribution/scope/collision model with real
plugins before we move the composer onto users' machines.

**v3+ (deferred features, build when a plugin needs them):** B.5 feature axis
(sub-plugin granularity over scope) and B.9 plugind MCP servers
(`contributes.mcp`). Both have a clean seam designed but no current consumer.

### Rough totals

| Item | Size | Net-new vs branch | v-tier |
|---|---|---|---|
| Step 0 rebase onto v2 | L | conflict-resolve + regenerate dist + tests | **prereq** |
| A.5 memory/knowledge seams | M | branch (key rename, seed-merge) | v1 (in rebase) |
| A.1 `plugin.json` | M | mostly net-new (parser) + branch (discovery) | v1 |
| A.3 scope membership | M | net-new fields + branch (merge/transpose) | v1 |
| B.2 numbers display-only | M | branch (invariant, schema) + del `parseFloat` | v1 |
| B.3 collisions | S | branch (validate) | v1 |
| B.7 version stamps | S | net-new | v1/v2 boundary |
| B.1 N-way composer | L | branch (loop, packaging model) | v2 |
| B.8 stage-table generator | S | net-new (+ marker edit) | v1 or v2 (independent) |
| B.6 packager projection + Kiro CLI | M | net-new (emitters + thin compose CLI) | v2 |
| B.4 trust | **0** | DELETED — host-native; docs only | — |
| B.5 feature axis | L | net-new | v3 (deferred) |
| B.9 plugind MCP servers | M | net-new (`contributes.mcp` + merge) | v3 (deferred) |

### Open questions to resolve before building

- **Manifest cross-tool compat:** *resolved* — **both** precedents are now
  confirmed and we are aligned with the stricter, more inspectable one. Codex
  (`.codex-plugin/plugin.json`) and Claude Code (`.claude-plugin/plugin.json`)
  are both manifest-first, git-distributed, `name`-only-required, with
  `enabledPlugins` settings and an offline cache. Codex uses **explicit component
  pointers** (`"skills": "./skills/"`) — exactly our `aidlc.contributes` model —
  while Claude auto-discovers by directory presence; explicit is the better
  choice (inspectable, no implicit magic). Adopted from this: standard optional
  metadata fields (`license`/`homepage`/`repository`/`keywords`), Codex's path
  rules (`./`-prefix, no `..`), and a split validation stance (lenient top level,
  strict `aidlc` block — doc 18 §4).
- **Trust key names + precedence:** *resolved* — mirror Claude Code's managed-only
  `strictKnownMarketplaces`/`blockedMarketplaces` (highest precedence, no
  cross-scope merge) as `aidlc.strictKnownBundleSources` (B.4). Codex has the same
  concept (`policy.installation: AVAILABLE/PREINSTALLED/HIDDEN`); `PREINSTALLED`
  validates our "team composes its set in CI and ships it" path (doc 20 §5.1).
- **Bundled MCP servers:** *promoted to a deferred feature* — see B.9. A plugin
  can't ship its own MCP server today (MCP is project-root only); the
  `contributes.mcp` seam is the right answer but is parked post-v2 until a plugin
  needs it.
- **Additive-only boundary update:** A.3 adds scope-membership to the additive
  surfaces — confirm that's acceptable under the doc 18 §6 guarantee (it is
  set-union, so it should be).
- **Does v1 stay build-time-delivered, or do we ship the installer with v1?**
  The plan assumes v1 is build-time (cheaper, lower-risk); revisit if a
  third-party plugin is needed before v2.

## See also

- [20 — Plugin System Vision](20-plugin-system-vision.md) — target state.
- [19 — Composition: Build-Time vs Install-Time](19-plugin-composition-timing.md)
  — the decision + evidence.
- [18 — Plugin Mechanism](18-plugin-mechanism.md) — as-built.
- [10 — Authoring a Plugin](10-authoring-a-plugin.md).
