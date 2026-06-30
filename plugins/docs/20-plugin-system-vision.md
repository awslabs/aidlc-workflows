# AIDLC Extension System — Vision

> **Status:** Vision / target-state. Describes the completed plugin system as
> decided in [19-plugin-composition-timing.md](19-plugin-composition-timing.md),
> building on the as-built mechanism in
> [18-plugin-mechanism.md](18-plugin-mechanism.md) and the author guide
> [10-authoring-a-plugin.md](10-authoring-a-plugin.md).
> This document is written in the present tense as if the system is finished; it
> is the destination, not a record of what ships today. Where it departs from
> current behavior, that gap is the implementation work (doc 19 §7).

## 1. One sentence

AIDLC is a small immutable **core** plus an open ecosystem of **plugins** —
optional, owned, versioned sets of stages, agents, scopes, method/rules (the
memory layer), sensors, and *additive contributions to existing core stages* —
composed by a **single composer** that runs over each install's *chosen* set of
plugins,
deterministically and reproducibly. The only pre-built artifact is **bare core**
(zero plugins); every plugin, first- or third-party, is composed at install.

## 2. The model in one picture

```
              author once (harness-neutral)
<plugin>/  ───────────────────────────────────────┐
  .aidlc-plugin/plugin.json (manifest: ver, deps) │
  stages/ agents/ scopes/ memory/ sensors/        │
  contributions/<phase>/<slug>.md  (the seam)     │
                                                 │
   plugins published as git repos/tags ──────────┤
   (first- AND third-party, identical)           │
                                                 ▼
                                          ┌───────────────┐
   bare core (committed) ────────────────▶│ THE COMPOSER  │  one implementation,
                                          │  over the     │  run wherever you
   chosen plugin set ─────────────────────▶│  chosen set  │  choose (see below)
                                          └──────┬────────┘
                                                 ▼
                effective install: core + chosen plugins  +  aidlc.lock
        (stages set-unioned, prose fragments ordered, predicates resolved)
```

There are no two pipelines. There is **one composer**, run over whatever plugins
an install actually chose. "Build-time vs install-time" was never the real axis:
the composer always runs and its output is always pinned (a committed tree *or* a
lockfile) — the only question is **where** it runs (the user's machine, the
team's CI, or a hosted service). The single thing worth pre-building and
committing is **bare core**, because it is the one input with no plugins to
resolve and is therefore identical for everyone.

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

## 4. Why bare core is the only build-time artifact

The core team ships *many* plugins; a given install enables *a few*. That single
fact dictates the pipeline:

- Pre-composing "core + all first-party plugins" yields a tree **nobody
  installs** — it carries stages the customer never enabled.
- Pre-composing every subset a customer might pick is the **`2^N` trap** we
  already rejected for third-party plugins (doc 19 §6.3).
- So a customer with a chosen subset **runs the composer regardless.** Pre-built
  first-party deltas would just sit unused beside the set they actually want.

Therefore the only artifact worth pre-building and committing is **bare core**
(zero plugins): it has no plugin inputs to resolve, it is byte-identical for
every install, and copying it is genuinely toolchain-free. Everything beyond bare
core — *any* plugin — is composed from its chosen set. First-party and
third-party are no longer two pipelines; the distinction is purely **provenance
and trust** (whose repo, who reviewed it), not how the artifact is produced.

> CI still composes-and-diffs first-party plugins — but as a **review and test
> aid** (a reviewer sees exactly what a plugin does to core, and the drift guard
> proves the composer is deterministic), **not** as the artifact customers
> install. We pin bare core; we test plugins.

## 5. Packages, end to end (first- and third-party, one path)

Bundles are published the same way regardless of provenance — first-party
plugins live in this repo's `plugins/`; third-party plugins live in their own
repos with identical internal structure. Both flow through one install path.

- **Distribution.** A plugin is a git repository (or published archive) with a
  `.aidlc-plugin/plugin.json` manifest at its root. No central gatekeeper; a
  registry may *index* plugins for discovery but is not in the trust path.
  (Mirrors Claude Code's git-backed plugin model — doc 19 §6.2 — minus the
  marketplace requirement. First-party plugins are simply the ones this repo
  publishes.)
- **Versioning.** Semver in `plugin.json`; dependencies declared as
  `dependencies: ["compliance@^1.2.0"]`, resolved against the dependency's git
  tags (`<plugin>--v<version>` convention). Constraints from multiple dependents
  are intersected to the highest satisfying version.
- **Install.** `aidlc plugin add <git-url-or-name>`:
  1. **resolve** the version set (the requested plugin + its transitive
     `dependencies` closure) against tags;
  2. **fetch** each source at its resolved SHA and **verify** a content hash;
  3. **compose** over the chosen set — the one composer, run over
     `bare core + {every enabled plugin}`: one set-union merge of all active
     contributions per stage, one cross-plugin validation pass, one predicate
     fixpoint, one compile;
  4. **project + write** the effective install and record an `aidlc.lock`.
- **Enable / disable.** Enablement is recorded per scope (project / user), like
  Claude Code's `enabledPlugins`. Disabling a plugin re-composes without it;
  disabling a plugin another enabled plugin depends on is blocked with a clear
  message.
- **Removal.** `aidlc plugin remove <name>` drops it from the chosen set and
  re-composes. Because composition is additive and bare core is never mutated,
  removal is exact — no residue.

### 5.1 Where the composer runs (it always runs; only the site varies)

The chosen-set compose is one operation that can run at three sites, same code,
same output, pinned by the same lockfile:

- **User's machine** — the default; `aidlc plugin add` composes locally.
- **A team's CI** — for locked-down environments: compose the team's declared set
  once, commit the resulting tree + `aidlc.lock`, and have developers copy it
  (recovering a toolchain-free path for *that team's specific set*, not a
  canonical one).
- **A hosted "compose my set" service** — emits the same pinned tree + lockfile.

This is the residue of the old build-vs-install debate: the question was never
*whether* to pre-build, only *where the one composer runs* for a given chosen
set. Bare core is the lone set (the empty one) worth committing centrally.

### 5.2 The lockfile (`aidlc.lock`)

Reproducibility without pre-building the `2^N` cross-product, the universal
answer of every scaled ecosystem (doc 19 §6.3). The lockfile pins, per plugin:

- **source** — git URL + exact commit SHA;
- **version** — the resolved semver;
- **integrity** — a content hash of the fetched source;
- **result hash** — a content hash of the composed output for the locked set;
- **composer version** — the AIDLC composer that produced it.

A second machine running `aidlc plugin sync` against the same `aidlc.lock`
produces a byte-identical effective install. This is build-time-grade determinism
delivered at install time.

### 5.3 Worked example — picking a 1st- and a 3rd-party plugin, then starting AIDLC

Meet a team building an internal service. They want the standard core, the
first-party **`ops-pro`** operation phase (shipped by the AIDLC team), and a
third-party **`acme-compliance`** plugin from their own platform org's git repo.
The whole flow is the same three moves regardless of harness: **choose a
harness, compose the chosen set, start.** Only the last "start" step differs
between Claude and Kiro.

#### Step 1 — choose plugins and compose (harness-agnostic)

The user names a harness and the plugins they want. The composer resolves the
set (including `acme-compliance`'s declared `dependencies`), fetches and
verifies sources, composes `bare core + {ops-pro, acme-compliance}`, projects it
for the chosen harness, and writes `aidlc.lock`:

```bash
# from anywhere; --harness picks the projection target
aidlc plugin add ops-pro \
                 github:acme-corp/aidlc-acme-compliance@^2 \
  --harness claude \
  --into ./my-service
```

What the composer prints:

```text
resolving …
  core                 (bare core, pinned)
  ops-pro      1.4.0   first-party        github.com/awslabs/aidlc-workflows
  acme-compliance 2.3.1 third-party       github.com/acme-corp/aidlc-acme-compliance
  └─ requires core@^2, ops-pro@^1   ✓ satisfied
composing chosen set (3) → claude …
  set-union: 2 contributions → construction/nfr-requirements   ✓ merged
  fragments ordered by (order, plugin, anchor)                 ✓
  cross-plugin validation (ranges, artifacts, same-target)     ✓ no conflicts
  predicate fixpoint (when:) baked into scope-grid.json        ✓
projected → ./my-service/.claude/   (+ plugins/ops-pro, plugins/acme-compliance)
wrote ./my-service/aidlc.lock   (composer 2.1.0)
```

Note the payoff of the single-composer model: the two plugins **both**
contribute to `construction/nfr-requirements`, and because this is one N-way
compose (not two `base+1` deltas), their additions are genuinely **set-unioned**
into one stage — not last-writer-wins. A teammate later runs `aidlc plugin sync`
against the committed `aidlc.lock` and gets a byte-identical tree.

> **Locked-down team variant:** the platform org runs the exact command above in
> *their* CI, commits the resulting `./my-service/.claude/` + `aidlc.lock`, and
> developers just `git pull`. Same composer, same output — only the *site* moved
> (doc 19 §7, decision #1). Developers need no toolchain.

#### Step 2 — start in **Claude Code**

The compose in Step 1 produced a `.claude/` tree exactly like today's
`dist/claude/.claude/`, plus the two plugin dirs under `plugins/`. From here
it is the unchanged getting-started flow ([guide 01](../../docs/guide/01-getting-started.md)):

```bash
cd my-service
claude                 # launch Claude Code in the project
```

Inside the session:

```text
/aidlc --init          # scaffold aidlc-docs/
/aidlc --doctor        # health check — now reports core + 2 plugins
/aidlc Build the inventory service with an operational runbook
```

`--doctor` reflects the chosen set rather than a fixed roster — e.g.
`✓ Schema validation: 32 core + 6 plugin stages valid`,
`✓ Scope validation: enterprise scope includes ops-pro operation stages`. The
operation-phase stages from `ops-pro` and the compliance gates from
`acme-compliance` are now part of the resolved plan wherever their scopes and
`when:` predicates put them on-path.

#### Step 2′ — start in **Kiro**

Identical first two moves; only the harness flag and launch differ. Either
recompose for Kiro, or (more often) the same `aidlc.lock` projected to a Kiro
tree:

```bash
aidlc plugin add ops-pro \
                 github:acme-corp/aidlc-acme-compliance@^2 \
  --harness kiro \
  --into ./my-service
```

This writes a `.kiro/` tree (steering, agents, skills, tools — like
`dist/kiro/.kiro/`) plus `plugins/`. Then start AIDLC the Kiro way (see
[Running on Kiro IDE](../../docs/guide/harnesses/kiro-ide.md)): open the project in Kiro
(or Kiro CLI), and the AI-DLC steering files drive the same `/aidlc` workflow
over the same composed stage graph. The plugins' stages, agents, and
contributions are identical — *authored once, harness-neutral, projected to
both* (doc 18 §2). The only thing that changed between Claude and Kiro is the
projection target; the chosen plugin set, the merged graph, and `aidlc.lock` are
the same.

> **Why the example matters:** the user never thinks in "build-time vs
> install-time." They pick a harness, pick plugins, and start. First-party
> (`ops-pro`) and third-party (`acme-compliance`) are selected the *same way* on
> the same command line — the only visible difference is the source (a plugin
> name AIDLC publishes vs. a git URL), which is exactly the provenance/trust
> distinction and nothing more.

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
- **Activation** — a plugin's stages exist only when it is in the active set;
  `when:` predicates (e.g. `producer-in-plan`) resolve over the **merged** graph
  at compose time and bake into `scope-grid.json`. The runtime stays read-only.

### 6.1 Conflicts fail loud, never silent

The single behavior change from today's `base + 1` packaging: when two plugins
genuinely collide on a non-commutative surface — the same stage's same fragment
anchor at the same order, an unsatisfiable cross-plugin edge, a duplicate
artifact name — the composer **errors with plugin attribution** rather than
resolving by overlay order. AIDLC never enters the "patch-ordering hell" of
silent ordered last-wins (doc 19 §6.3). Set-union surfaces simply merge;
sequential surfaces order deterministically; true conflicts stop the build.

## 7. Authoring is identical for everyone

There is one authoring workflow regardless of where the plugin will live
(doc 10):

```bash
bun scripts/package.ts --validate-ext <plugin>   # fast loop: manifest, ranges,
                                                  # deps, artifact namespacing,
                                                  # contribution targets/anchors
bun scripts/package.ts                            # compose + project a chosen set
bun scripts/package.ts --check                    # drift guard (bare core + CI test composes)
```

A third-party author runs the same validator against their own tree, then
publishes a git tag. A first-party author additionally lands in `plugins/`
and lets CI compose-and-test the plugin (and pin bare core). Same seam, same
tools, same guarantees — the only difference is *whose repo the plugin lives in*
(doc 18 §2, "First-party vs third-party — same structure, different repo").

## 8. Invariants the finished system holds

- **Core is immutable.** No plugin, ever, edits `core/`.
- **Additive-only.** Contributions add; they never override or remove. A genuine
  need to *change* upstream behavior is a framework-level design decision, not a
  plugin concern (doc 18 §6).
- **Inert when off.** Disabling every plugin yields bare core, byte-identical to
  the committed artifact.
- **One composer, one artifact.** The same code composes wherever it runs (user
  machine, team CI, hosted service). The only thing pre-built and committed is
  **bare core** — there is no separate build-time pipeline for plugins.
- **Deterministic & reproducible.** Bare core via byte-pinned drift guard; every
  composed set via lockfile + content hash. No plugin combination is ever
  pre-built or shipped as a canonical artifact.
- **No gatekeeping.** First- and third-party plugins are mechanically equal;
  provenance is the only difference.

## 9. What this is not

- **Not a monkeypatch layer.** Bundles cannot rewrite arbitrary core behavior;
  the additive boundary is the point (doc 19 §6.3 names runtime monkeypatching
  the anti-pattern).
- **Not a per-harness fork.** A plugin is authored harness-neutral and projected
  into every harness; authoring per-harness is forbidden (doc 18 §2).
- **Not centrally pre-built for anyone past bare core.** First-party plugins are
  *not* shipped pre-composed — the core team ships many plugins and each install
  picks a few, so the only universal artifact is bare core. The `2^N`
  combinatorial trap is avoided by composing the actual chosen set, not
  enumerating subsets.
- **Not a heavyweight runtime.** The AIDLC runtime stays read-only; all
  composition happens at compose time (CI or `aidlc plugin` invocation), never
  per-session.

## See also

- [19 — Extension Composition: Build-Time vs. Install-Time](19-plugin-composition-timing.md)
  — the decision and the evidence behind it.
- [18 — Plugin Mechanism](18-plugin-mechanism.md) — the as-built mechanism
  (layers, delta model, `when:` predicate, §4 merge, §5 guards).
- [10 — Authoring a Plugin](10-authoring-a-plugin.md)
  — the author-facing walkthrough.
