# pdlc — AIDLC product-discovery plugin (AI-PLC)

> A first-party **AIDLC plugin**: Working Backwards product discovery for product
> managers, layered onto the AI-DLC workflow as a self-contained scope that hands
> off to core Inception through one artifact.
> Design: [`docs/reference/18-plugin-mechanism.md`](../../docs/reference/18-plugin-mechanism.md).
> Methodology source: [`awslabs/aidlc-workflows#652`](https://github.com/awslabs/aidlc-workflows/issues/652)
> and the AI-PLC rules in `aws-samples/sample-ai-plc`.

> **Status: all ten stages authored — not yet released.** The full discovery
> arc ships: intake, envision/PR-FAQ, solution analysis, prioritization scoring,
> the prototype chain (spec / build / validation), product strategy,
> go-to-market, and the handoff pack. What is deliberately still outstanding is
> release mechanics (no version bump, no CHANGELOG entry, no marketplace
> listing) and the two conversations §6 names. Every stage is `CONDITIONAL`
> except intake and the pack, so a run executes the stages it needs and the pack
> reports the rest as absent by design — see §5.

## 1. What it does

`pdlc` adds the product-manager half of the lifecycle: deciding **which product
to build, and why that one** — a question with no code in it. It ships as a
distinct scope (`pdlc-discovery`) that runs discovery and stops at a handoff
boundary, rather than flowing into implementation in the same workspace.

- **adds a new scope** — `pdlc-discovery`, discovery stages only, no inception /
  construction / operation ceremony;
- **adds ten new ideation stages** — from `pdlc-use-case-intake` (capture the
  candidate set, classify each Agentic vs Application) through to
  `pdlc-context-pack` (assemble the developer handoff), with the Working
  Backwards, prioritization, and prototype work between them (§3);
- **adds one sensor** — `pdlc-evidence`, which checks that the PR/FAQ and the
  prioritization scoring carry source tags that resolve to real filled answers
  (§3.1);
- **enriches core `requirements-analysis`** with a `required: false` consume of
  `pdlc-context-pack` plus the prose for reading it, so an engineering team
  picks discovery up automatically when a pack exists and is unaffected when
  one does not.

It ships **no agents of its own.** Every stage is led by a core persona —
`aidlc-product-agent` for the PM work, `aidlc-design-agent` for the prototype
spec (brand, device, screens, look-and-feel), `aidlc-developer-agent` for the
build — and every reviewer is core `aidlc-product-lead-agent`. That is not a
convenience: a plugin-owned persona cannot lead a *dispatched* stage on Kiro,
Codex, opencode, or Copilot (the dispatch guard in `compose.ts` requires a
harness-native agent surface, and Kiro's `trustedAgents` roster is not
extensible by compose), and `reviewer:` triggers that guard even on
`mode: inline` stages. Core agents everywhere is what makes the plugin portable
across all six harnesses.

## 2. How to use it

`pdlc` is emitted by the packager as a real host plugin per harness.

**Author / build** (from the repo):
```bash
bun scripts/package.ts    # emits dist/plugins/pdlc/{claude,codex,kiro,kiro-ide,opencode,copilot}/
bun test plugins/pdlc/tests/plugin.test.ts
```

**Claude Code** (host store):
```
/plugin marketplace add <your-repo-or-path>/dist/plugins/pdlc/claude
/plugin install aidlc-pdlc@aidlc-plugins
# start a fresh session → the SessionStart hook composes pdlc in
```

**Codex CLI** (host store, in a git repo):
```
codex plugin marketplace add <…>/dist/plugins/pdlc/codex
codex plugin add aidlc-pdlc@aidlc-plugins   # approve the one-time hook trust
```

**Kiro / opencode / Copilot** (no store — folder-drop + compose):
```bash
cp -r dist/plugins/pdlc/kiro/. <project>/
AIDLC_PLUGIN_ROOT=<…>/kiro AIDLC_PROJECT_DIR=<project> AIDLC_HARNESS_DIR=.kiro \
  bun <…>/kiro/hooks/compose.ts
```

Then run it:
```
/aidlc --doctor
/aidlc pdlc-discovery
```

> **No keyword triggers.** `pdlc-discovery` must be named explicitly. Keyword
> inference takes the first alphabetical match across every installed scope, so
> a keyword this plugin claimed that another scope also claimed would
> permanently shadow one of them — with no error, on every cold start. Claiming
> none makes the whole class of collision impossible. §4 covers the rest of the
> co-existence posture.

## 3. The stages and their artifacts

Ten stages, in flow order. Every one is `mode: inline`, led by a **core** agent,
scoped to `pdlc-discovery`, and gated (there is no opt-out from a stage gate, so
ten stages means ten human approval points — that is the methodology, not an
accident). Every stage except the pack also writes a `pdlc-<slug>-questions.md`
beside its outputs; those stay put and are consumed by no stage — they are what
the source tags resolve against.

| # | Stage | Execution | Lead / reviewer | Produces |
|---|---|---|---|---|
| 1 | `pdlc-use-case-intake` | ALWAYS | product / — | `pdlc-use-cases` |
| 2 | `pdlc-envision` | CONDITIONAL (Path A: pain first) | product / product-lead | `pdlc-pain-point-analysis`, `pdlc-prfaq` |
| 3 | `pdlc-solution-analysis` | CONDITIONAL (a PR/FAQ exists) | product / — | `pdlc-identified-solutions` |
| 4 | `pdlc-prioritization` | CONDITIONAL (>1 candidate) | product / product-lead | `pdlc-prioritization-scoring`, `pdlc-prioritization-ranking` |
| 5 | `pdlc-prototype-spec` | CONDITIONAL | **design** / — | `pdlc-prototype-spec`, `pdlc-design-context`, one portable `PROTOTYPE-<slug>.md` per candidate |
| 6 | `pdlc-prototype-build` | CONDITIONAL | **developer** / — | `pdlc-prototype-build-log`, `pdlc-iteration-log` + runnable code at the workspace root |
| 7 | `pdlc-prototype-validation` | CONDITIONAL | product / — | `pdlc-validation-results`, `pdlc-build-decision` |
| 8 | `pdlc-product-strategy` | CONDITIONAL | product / product-lead | `pdlc-product-strategy` |
| 9 | `pdlc-go-to-market` | CONDITIONAL | product / product-lead | `pdlc-gtm-plan` |
| 10 | `pdlc-context-pack` | ALWAYS | product / product-lead | `pdlc-context-pack` |

Two properties hold across the set and are worth stating plainly: **exactly one
artifact leaves the plugin** (`pdlc-context-pack`, consumed by core
`requirements-analysis` at `required: false`), and **no core artifact is ever
produced by a plugin stage**. That is what makes co-existence a set-union rather
than a conflict (§4).

The Agentic/Application split established at intake is the discriminator stage 4
keys off to choose its scoring framework. It turns on **control flow**, not model
usage: "calls an LLM" is Application, "chooses what to do next" is Agentic.

Stage 5's `PROTOTYPE-<slug>.md` is deliberately **portable**: it can be handed to
a developer, a contractor, or a fresh AI-DLC run with no discovery context at
all. That is also the flow's Entry Point 1 — arrive with one of these and stage 6
runs on its own, stages 1–5 skipped.

### 3.1 The evidence sensor

`sensors/aidlc-pdlc-evidence.md` (+ `tools/aidlc-sensor-pdlc-evidence.ts`) fires
on exactly two files — `pdlc-prfaq.md` and `pdlc-prioritization-scoring.md` — and
checks that every substantive paragraph, list item, and table row carries an
inline source tag that RESOLVES: `[Q<n>]` to a visibly filled answer in the
sibling questions file, and `[desc]` / `[scope]` / `[memory:<id>]` /
`[artifact:pdlc-<name>]` to a registered entry in that file's `## Sources` block.
On the scoring artifact it additionally requires a rationale column with no empty
cells, because a weighted score with no stated reason cannot be disagreed with.
It is `advisory`, first-party, needs no network and no external CLI.

Those two artifacts were chosen because both are confident by construction: a
press release is written in the past tense about a launch that has not happened,
and a 0–10 score reads identically whether it was measured or invented. Every
other stage carries the same grounding contract in prose; only these two have a
machine to check it.

> **The sensor filename keeps the `aidlc-` prefix.** Sensors are the one
> primitive that does. Sensor discovery flat-scans for `sensors/aidlc-<id>.md`
> only, so a `pdlc-`-prefixed sensor composes and then never fires. The test file
> pins it.

## 4. Co-existence with core product discovery

Core may ship its own product-discovery path
([PR #526](https://github.com/awslabs/aidlc-workflows/pull/526)). This plugin is
designed so both can be installed at once, without a negotiation and without
either owner changing anything:

1. **A distinct scope name.** `pdlc-discovery`, not `discovery`. Duplicate scope
   *names* are a hard throw at scope-metadata load — that one really would break
   every command for anyone holding both.
2. **A prefixed handoff artifact.** `pdlc-context-pack`, not a bare
   `context-pack`. An un-prefixed artifact recreates the two-producers,
   one-artifact-name failure the moment both are installed.
3. **Independent downstream wiring.** Both efforts add their own
   `required: false` consume to core Inception. `adds.*` is set-union, and
   set-union is commutative — install order does not matter, and neither
   contribution can see or clobber the other.
4. **No keywords, no `freeform_default`.** See §2. Core holds the one permitted
   `freeform_default` claimant; a second is a throw.

`plugins/pdlc/tests/plugin.test.ts` pins all four as assertions, plus the
initialization-spine invariant below. Each guards a failure that produces **no
error message** — which is exactly why they are tests and not review notes.

> **The initialization spine.** Core's initialization stages enumerate the core
> scopes explicitly, so a plugin-shipped scope has no workspace detection, no
> state file, and no record dir until its contributions set-union it into all
> three. That is what the three `contributions/initialization/*.md` files are
> for. Omit them and the scope still compiles — it just resolves to a plan that
> runs discovery stages with nowhere to write.

## 5. What ships, and what a run legitimately skips

The plugin was authored in four slices, all of which have landed:

- **slice 1** — the walking skeleton: `pdlc-use-case-intake`,
  `pdlc-context-pack`, the scope, the four contributions, the tests. A runnable
  vertical slice that proved the methodology-plugin shape;
- **slice 2** — the PM-judgment core: `pdlc-envision` (pain points → PR/FAQ),
  `pdlc-solution-analysis`, `pdlc-prioritization` (the Agentic and Application
  scoring frameworks), the four `knowledge/aidlc-product-agent/pdlc-*.md`
  methodology files, and the `pdlc-evidence` sensor;
- **slice 3** — `pdlc-product-strategy` and `pdlc-go-to-market`, the deepest
  question banks in the plugin;
- **slice 4** — the prototype chain: `pdlc-prototype-spec` (design-led, and the
  author of the portable spec), `pdlc-prototype-build`, and
  `pdlc-prototype-validation`, plus the `pdlc-prototype-spec-format.md`
  knowledge file.

**A run skipping stages is the design, not a gap.** Eight of the ten stages are
`CONDITIONAL`, and `pdlc-context-pack`'s `## Handoff Readiness` section
enumerates all nine discovery stages under "ran" or "did not run", each absence
with its reason and what it costs the reader. A PM who arrives with a candidate
list skips the pain-point work; a run that hands specs to a development team
builds no prototype; a run validating one use case inside an approved strategy
skips stages 8 and 9. The pack never overstates its own completeness, which is
what makes any subset of this flow safe to hand over.

### 5.1 The prototype chain, specifically

Stage 6 is the only stage in the plugin that writes and runs code
(`workspace_requires: true`) and the only one that can be given a credential.
Two things follow, and both are load-bearing:

- **The mock provider is the DEFAULT.** It fakes the model's responses, installs
  nothing, and needs no account, no key, and no network — and the demo still
  shows the flow, the screens, and the copy, which is what viewers judge.
  Choosing a real provider is an explicit opt-in that adds an SDK install and
  credential handling. So installing this plugin obliges nobody to install a
  package or produce a key.
- **The security posture is carried in prose, verbatim from the source flow**,
  because `memory/` is not projected and a plugin therefore cannot ship a phase
  guardrail. The never-log list (redact anything credential-shaped to
  `[CREDENTIAL REDACTED]`; log only `credentials configured: yes/no`),
  existence-only credential checks, subprocess isolation to the selected
  provider's variables, `python -m venv` always with pinned PyPI-only packages,
  localhost only with no exposed ports and no deploys, no root or sudo, fetched
  URLs as untrusted input capped at 50,000 characters, and slug sanitisation are
  all stated in the stage body. `tests/plugin.test.ts` pins each of them,
  because prose with no test erodes silently and no sensor anywhere inspects a
  log for a leaked key.

Package versions are pinned **at install time, agreed with the user, and recorded
in the build log** — not pinned inside the stage file. A version pinned in a
tag-pinned plugin cannot be hot-fixed when it rots, and a stale pin fails as a
resolver error nobody traces back to a methodology file. The same reasoning keeps
model ids out: the stage asks.

## 6. Still outstanding

Not authoring gaps — decisions and mechanics that sit outside the plugin files:

- **Release mechanics.** No `aidlc-version.ts` bump, no README badge, no
  `CHANGELOG.md` entry, no marketplace listing. Those fire when this becomes a
  PR, not per slice.
- **Two conversations.** Core may ship its own product-discovery path
  ([#526](https://github.com/awslabs/aidlc-workflows/pull/526)); §4 makes
  co-existence work without a negotiation, but the conversation is still worth
  having. And stage 6 makes this the first AI-DLC stage to touch third-party
  credentials — arriving, on Kiro, via a folder drop with no install-time trust
  gate. That combination deserves an explicit maintainer decision.
- **Provider configuration as knowledge.** The source flow's LLM-provider
  reference is carried as stage prose (env-var shape per provider family, and
  no hardcoded model ids) rather than as a `knowledge/` file. If it wants to be
  knowledge, that is a small additive change.
