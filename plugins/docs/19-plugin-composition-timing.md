# Plugin Composition: Build-Time vs. Install-Time

> **Status:** Decision note, evidence-backed. Companion to
> [18-plugin-mechanism.md](18-plugin-mechanism.md). Resolves a recurring
> criticism: *AIDLC plugins are build-time, not install-time, artifacts.*
> §§1–4 make the two models precise and isolate the part of the criticism that
> bites; §5 states the direction; §6 records the investigation that backs it
> (our composer traced in code, Claude Code's plugin model, and a landscape
> survey); §7 is the decision.
>
> **Decision: the hybrid.** Emit real host plugins for Claude/Codex (SessionStart
> hook composes); thin `aidlc plugin compose` for Kiro (no store). One composer,
> host-triggered. Trust = host-native (managed allowlist / hash-pinned). We run
> no distribution infra. See §7 for full detail and
> [20-plugin-system-vision.md](20-plugin-system-vision.md) for the target state.

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

## 7. Decision — the hybrid

The evidence in §6 resolved the gating unknown (hooks genuinely compose) and
confirmed the per-host asymmetry. The decision, validated by real probes
(`spikes/dist-probe/RESULTS.md`) and approved by the team (2026-06-30):

**Emit real host plugins for Claude and Codex; ship a thin `aidlc plugin compose`
path for Kiro.** Not pure A, not pure B — because the hosts are genuinely
different shapes and one mechanism can't fit all three well.

1. **The packager emits real host plugins** (`.claude-plugin/plugin.json`,
   `.codex-plugin/plugin.json`) — one more projection target alongside the
   existing harness projections. An AIDLC plugin IS a host plugin.
2. **A SessionStart hook composes** on Claude (eager) and Codex (lazy, first
   turn). The composer is the same; the host decides when it runs.
3. **Kiro has no store** — the plugin is distributed as a git repo/folder-drop
   and composed via `aidlc plugin compose` (thin CLI) or the IDE's `.kiro.hook`
   (lazy, `promptSubmit` trigger).
4. **Trust is host-native** — Claude's `strictKnownMarketplaces` (managed,
   unoverridable), Codex's one-time hash-pinned trust. We build no trust layer.
5. **Keep the additive-only contribution seam** — it is the right conflict model
   per §6.3. Do not add override/removal/monkeypatch semantics.
6. **Conflicts fail loud** — two plugins → same stage is a clean set-union;
   non-commutative collisions error with plugin attribution.
7. **Codex loses agents** (confirmed gap, accepted) — runs degraded.
8. **We run no distribution infrastructure** — customers host their own plugin
   repos (git + semver tags + `marketplace.json`). One entry works across hosts.

### Why the hybrid dominates

- Pure A (our own CLI + trust + marketplace) pays to rebuild what Claude/Codex
  already ship for free, and would *still* need the folder-drop path for Kiro.
- Pure B (host plugin everywhere) can't apply to Kiro (no store to emit into)
  and half-fails Codex (no agents).
- The hybrid takes each host's native strength: real plugins where stores exist
  (cheapest, native UX), thin CLI where they don't (Kiro — which we must build
  anyway).

### Next: implementation

See [doc 21](21-plugin-implementation-plan.md) for the sequenced work. The key
items that changed from the original plan:
- **B.4 (trust) is deleted** — host-native trust replaces our own layer.
- **B.6 (distribution + installer) shrinks** — becomes "emit the host plugin
  projection target + write the SessionStart compose hook" for store hosts, and
  the thin `aidlc plugin compose` for Kiro. No `aidlc plugin add` CLI for
  Claude/Codex.
- **A new item: packager projection target** — emitting `.claude-plugin/` and
  `.codex-plugin/` from the authored plugin tree.
