# Extension Composition: Build-Time vs. Install-Time

> **Status:** Decision note, evidence-backed. Companion to
> [18-plugin-mechanism.md](18-plugin-mechanism.md). Resolves a recurring
> criticism: *AIDLC plugins are build-time, not install-time, artifacts.*
> §§1–4 make the two models precise and isolate the part of the criticism that
> bites; §5 states the direction; §6 records the investigation that backs it
> (our composer traced in code, Claude Code's plugin model, and a landscape
> survey); §7 is the decision + next steps.
>
> **Decision:** one mechanism, no gatekeeping. A *single composer* runs over each
> install's chosen plugin set, wherever convenient (user machine / team CI /
> hosted service), pinned by a lockfile. The only centrally pre-built artifact is
> **bare core** — the core team ships many plugins and each install enables a
> few, so no "all first-party" tree is canonical and pre-building subsets is the
> `2^N` trap. First-party vs third-party is provenance/trust only, not a pipeline
> difference. Both get the full contribution seam (the best-composing model in
> the field). Reproducibility via lockfile + content hash, not pre-built
> combinations. See §7 for the full decision and the target-state vision in
> [20-plugin-system-vision.md](20-plugin-system-vision.md).

## 1. What "build-time" means in the current design

Composition happens in **AIDLC's packager**, not on the consumer's machine:

- The §4 contribution merge (`mergeContributions`) splices fragments and
  set-unions `produces` / `consumes` / `sensors` / `required_sections` into the
  core stage node **before compile**.
- The `when: {producer-in-plan}` predicate is evaluated at compile via the
  per-scope fixpoint and **baked into `scope-grid.json`**.
- The result is committed as a byte-pinned **delta** at
  `dist/<harness>/plugins/<plugin>/`, computed as
  `diff(base+plugin build, base build)`.

The consumer just **copies files**. The runtime stays read-only — no merge
logic, no compiler runs at install.

Crucially, the packager builds **base** and **base + each plugin
independently** (linear, not `base + A + B + …`). That single fact is the root
of the criticism.

## 2. What "install-time" would mean

Bundles ship as their **authored source** (their own `plugins/<name>/`
tree). A compiler runs **on the consumer's machine** over
`base + {whatever plugins the user enabled}` to produce the effective stages
locally — the §4 merge and §5 cross-plugin validation running against the
user's actual set.

## 3. Tradeoffs

| Dimension | Build-time (current) | Install-time |
|---|---|---|
| **Determinism / reproducibility** | Composed once, reviewed, byte-pinned. What ships = what runs. | Output depends on the user's plugin set + versions + local compile. "Works on my machine" risk. |
| **Consumer toolchain** | None — copy files. Runtime stays pure read-only. | Needs `bun` + the graph compiler + validators locally; heavier, larger trust surface. |
| **Auditability** | The merged stages are a committed artifact you can diff in a PR; drift guard byte-pins it. | You verify *inputs* (plugin source hashes) + the compiler, not a stable output. Drift guard as-is doesn't apply. |
| **Where errors surface** | In the authoring repo's CI, before distribution. | On the end user's machine, at install. |
| **N-way / third-party composition** | **Weak** — see §4. | **Natural home** — merges the user's actual A+B+C in one pass; semver / `requiresBundle` resolved against what's installed (issue #430 gaps #3/#4). |
| **Versioning** | Delta is pinned to a base snapshot; a core release means re-building every delta. | Bundles published independently like packages; install-time negotiates against installed base. |
| **Combinatorics** | Truly supporting arbitrary co-installation = `2^N` pre-built variants. The design dodges this by only building linear deltas — which is *why* true multi-plugin merge isn't there. | Computes only the one combination the user has. No explosion. |

## 4. The part of the criticism that actually bites

It is narrower and sharper than "build-time bad." Split a plugin's payload in
two:

1. **Purely additive new files** — new stages in their own number range, new
   agents, scopes, rules in their own subtree. These live under
   `plugins/<plugin>/` and **overlay cleanly** onto a user's install with no
   merge. Build-time is totally fine here; a third party really can drop these
   in.

2. **Contributions (the §4 "modify an existing core stage" seam)** — these
   merge *into a shared core stage node before compile* and land in the
   plugin's delta. This is where build-time breaks for an open ecosystem:
   - Each delta is composed against **base only**. If plugin A and plugin B both
     contribute to `nfr-requirements`, each delta carries its *own* composed
     copy of that stage/graph. Overlaying both is a file-level collision /
     last-writer-wins — the two contributions are **never actually merged
     together**.
   - A third party who ships *only source* and drops it into an existing install
     gets their **new stages**, but their **contributions silently do nothing** —
     nothing re-runs `mergeContributions` against the installed base + other
     plugins.

So the precise statement is: **the contribution seam is a build-time,
single-plugin-against-base operation.** It is exactly the feature that makes
plugins interesting (modify existing stages) that *cannot* be composed at
install in the current model — and it maps directly onto issue #430's gap #1
(no cross-plugin merged-graph validation) and gap #4 (no real activation
signal).

> **Caveat — verify before building on this.** The two-plugins-one-stage
> collision claim is inferred from the design text (independent
> `diff(base+plugin, base)` deltas). Confirm directly in `scripts/package.ts`
> (`mergeContributions` / the variant-delta packaging) before making a decision
> hinge on it.

## 5. Direction: one composer, two invocation sites, no gatekeeping

Build-time and install-time are not two mechanisms. They are **two invocation
sites for one composer** — the composer being `mergeContributions` + §5
cross-plugin validation + the `applyPredicates` fixpoint + compile. Today that
code only ever runs in CI against `base + one plugin`. Nothing about it requires
that site.

Define it once, run it in two places:

- **In CI, over the first-party set** → commit the composed output, byte-pinned,
  exactly as today. Users who only use first-party plugins still **just copy
  files** — zero toolchain. The committed `dist/` is simply a *cached, memoized
  invocation of the composer.*
- **On the consumer's machine, over `{first-party + enabled third-party}`** →
  the same code path, run when a user actually adds a plugin.

Build-time stops being a separate mechanism and becomes "the composer, memoized
in CI for the curated set." One mechanism. This dissolves the criticism in §4
rather than working around it, and it folds in issue #430's gaps #1
(cross-plugin merged-graph validation) and #3/#4 (semver resolution + a real
activation signal against the *installed* set) — they become the natural job of
the on-machine composer.

### Why not gatekeep third-party plugins

The discarded option — "third-party = additive-only; contributions reserved for
first-party" — fails on principle:

- **The §4 contribution seam is the entire value proposition.** "Modify existing
  stages" is what makes a plugin more than a folder of new files.
  Restricting third parties to additive-only removes the feature that made them
  want a plugin mechanism at all.
- **The asymmetry is unprincipled.** No technical property makes a first-party
  contribution to `nfr-requirements` safe and a third-party one dangerous — they
  run the identical merge. The only difference is *who reviewed it*, which is a
  trust / distribution concern, not a mechanism concern.

### What this costs (and why it is acceptable here)

1. **Consumer toolchain when combining plugins.** Adding a third-party plugin
   means running the composer locally (a `bun` runtime, or a shipped binary).
   Mitigated by the cached-`dist` path: you pay this *only* the moment you opt
   into multi-plugin composition. First-party-only stays copy-files.
2. **Reproducibility shifts from output-pinning to input-pinning.** You cannot
   byte-pin every possible user combination — that is the `2^N` problem, and it
   is *inherent* to not gatekeeping. Replace it with a **lockfile**: pin plugin
   source hashes + versions + composer version, and guarantee deterministic
   compose. First-party keeps its byte-pinned drift guard (CI recomposes the
   curated set and asserts byte-identical to committed). Third-party combos get
   "deterministic compose + lockfile" instead of "blessed artifact" — the
   correct trade once users may combine arbitrary plugins.

## 6. Evidence (investigation, not gut)

Three investigations were run before committing: a deep dive on Claude Code's
plugin model, a file:line trace of our own composer, and a landscape survey of
how comparable ecosystems compose independent plugins. They converge.

### 6.1 Our composer is `base + 1`, confirmed in code

- The variant loop composes **one plugin against base-only**:
  `writeHarness` runs `for (const ext of exts) buildBundleDelta(m, ext, baseFiles)`
  (`scripts/package.ts:695-704`), each delta `diff(base+plugin, base)`.
- **Two plugins, same stage → silent last-writer-wins.** If plugin A and B both
  contribute to `nfr-requirements`, each delta re-emits that stage file and
  `stage-graph.json` carrying only *its own* additions; overlaying both means B
  overwrites A. No overlay-time merge exists in the runtime (confirmed at
  `package.ts:606`). The runtime is read-only w.r.t. composition.
- **But the engine is already N-way-capable.** `mergeContributions`
  (`package.ts:256-351`) loops `exts` and set-unions per `target`; it is simply
  only ever *called* with a one-element list. And `validatePluginSet`
  (`scripts/plugin-validate.ts:139-213`) **already reasons over the full
  N-plugin set** (cross-plugin ranges, artifact-namespace collisions, semver
  deps). So validation is N-way while packaging is `base + 1` — an asymmetry,
  not a missing engine. The work is the **orchestration loop + the
  packaging/overlay model + an installer**, not a rewrite of the merge.

### 6.2 Claude Code's plugin model is purely install-time — and has no shared-base seam

Plugins resolve through a marketplace (`.claude-plugin/marketplace.json`), fetch
from git/npm/zip into `~/.claude/plugins/cache/`, and are **used as-is — no build
or projection step on the user's machine**. Versioning via `plugin.json` +
git-tag semver (constraint *intersection* across dependents); **no lockfile**.
Composition is **additive + namespaced** (skills/commands namespaced by plugin
name; hooks all fire). Crucially, **plugins have no concept of modifying a shared
base** — they only add. That is exactly why install-time is frictionless for
them, and exactly the capability our contribution seam adds on top.

### 6.3 The landscape: install-time wins, additive+namespaced composes best

Every scaled third-party ecosystem surveyed is **install-time** — npm, Cargo,
Helm, Terraform, VS Code, OPA, Nix. None pre-compiles plugin combinations
centrally, for two structural reasons: **combinatorial explosion** (N plugins
→ up to `2^N` enabled subsets) and **late resolution** (the correct set is only
knowable on the user's machine). Reproducibility is recovered everywhere by
**lockfile + content hash** (npm `integrity`, `Cargo.lock`, `.terraform.lock.hcl`),
never by pre-building.

For composing independent patches over a shared base, the field ranks (best →
worst at composing):

| Strategy | Exemplars | Composes? |
|---|---|---|
| **Additive + namespaced** | VS Code `contributes`, Cargo feature-union, OPA roots, Rego `deny` (OR) | **Best** — collisions impossible or explicit |
| **Explicit conflict error** | OPA overlapping-roots, npm `--strict-peer-deps` ERESOLVE | **Good** — fails loud, not silent |
| **Deep-merge w/ precedence** | Helm values (+ explicit `null`-to-delete) | OK — predictable per-leaf |
| **Ordered last-wins** | Nix overlays, Kustomize patches | **Fragile** — "patch-ordering hell", silent |
| **Monkeypatch** | Ruby/Python runtime patch | **Doesn't compose** — anti-pattern |

The lesson that lands directly on us: **our additive-only contribution seam
(§6 boundary in doc 18) is already the best-composing model in the table** — it
is structurally VS Code `contributes` + Cargo feature-union. We should *keep* it,
not trade it away to imitate the plugin model. Cargo's cautionary tale (resolver
v1 over-unified `std` into `no_std` builds → resolver v2) is the one guardrail to
respect: union/additive composition is only safe while contributions **never
subtract** — which §6's hard additive-only boundary already enforces.

## 7. Decision

1. **One composer over each install's chosen plugin set; pre-build only bare
   core.** There is a single composer, not a build-time and an install-time
   variant. It runs over `bare core + {chosen plugins}` wherever convenient — the
   user's machine, a team's CI, or a hosted service — and its output is pinned by
   a lockfile. The *only* artifact committed centrally is **bare core** (zero
   plugins), because the core team ships many plugins and each install enables a
   few: there is no canonical "all first-party" tree anyone installs, and
   pre-building every subset is the `2^N` trap. First-party vs third-party is
   therefore **provenance/trust only**, not a pipeline difference. (This refines
   the §5 "two invocation sites" framing: same conclusion — one composer — but
   build-time is *not* retained as a first-party distribution cache, only as a CI
   review/test aid plus the bare-core pin.)
2. **Keep the additive-only contribution seam.** It is the right conflict model
   per §6.3 — do not add override/removal/monkeypatch semantics.
3. **Lockfile for reproducibility** — pin each plugin's source git SHA, version,
   composer version, and a content hash of the composed result. This gives
   build-time-grade determinism for *any* chosen set without pre-building the
   `2^N` cross-product. Bare core keeps its byte-pinned drift guard.
4. **Turn the one silent gap into a detected one.** Two plugins → same stage is
   currently silent last-wins (§6.1). N-way merge makes it a clean set-union;
   prose fragments already order deterministically by `(order, plugin, anchor)`
   (doc 18 §5.2). Add explicit cross-plugin same-target validation
   (OPA-roots / npm-strict-peer style) so any genuinely non-commutative case
   errors loudly rather than resolving by overlay order.

### Next: design the implementation (plan step 4)

The build-vs-install and vision questions (plan steps 1–2) are settled above.
Implementation design follows from it, in rough dependency order:

- **N-way composer** — generalize the `base + 1` orchestration: one composed
  tree over the active set (`buildTree(m, tmp, ⋃ pluginDirs, [A,B,…])`),
  `buildBundleDelta`/`validateBundleGraph` to take a set, per-`plugin`
  validation against each manifest.
- **Distribution + installer** — how a plugin is published (git repo, manifest),
  resolved (semver against tags, à la Claude Code), fetched, and projected +
  recompiled locally; enable/disable/remove.
- **Lockfile format** — source SHA + version + composer version + result hash.
- **Cross-plugin same-target validation** — promote the silent case to an error.
- **Bare-core pin + CI test composes** — commit only bare core under the drift
  guard; CI compose-and-diffs first-party plugins as a review/test aid, not a
  shipped artifact.
