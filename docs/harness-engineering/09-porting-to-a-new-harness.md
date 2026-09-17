# Porting AI-DLC to a New Harness

AI-DLC ships from **one core, many harnesses** — today Claude Code, Kiro CLI, Kiro IDE,
Codex CLI, Cursor, opencode, and GitHub Copilot, and the set is open. The hand-authored source is a
harness-neutral `core/` plus a thin `harness/<name>/` surface per CLI; the
packager (`scripts/package.ts`) materializes each ignored local Bun copy tree
under `dist/<harness>/` and its native counterpart under
`dist-release/<harness>/`. Adding another harness is **one directory and one
manifest row** — the engine, methodology, projection ownership, and
harness-dir/rules resolution take no `core/` edits at all; the lone optional
exception is a per-harness `--doctor` arm (see Step 2). This page walks the
contract.

> Three senses of "harness" in this repo: **`harness/`** (top-level — the
> per-CLI distribution surfaces this page is about), **`docs/harness-engineering/`**
> (this guide), and **`tests/harness/`** (the test-suite helper library).
> Unrelated; only the first is a distribution.

## The shape

```
core/                      # harness-neutral source — not edited to add a harness (save the optional --doctor arm)
harness/
  claude/  manifest.ts · skills/aidlc/ · CLAUDE.md · settings.json
  kiro/    manifest.ts · skills/aidlc/ · agents/*.json · hooks/aidlc-kiro-adapter.ts · settings/cli.json · AGENTS.md
  codex/   manifest.ts · emit.ts · skills/aidlc/ · hooks/aidlc-codex-adapter.ts
  opencode/ manifest.ts · emit.ts · skills/aidlc/ · command/ · plugin/
  copilot/ manifest.ts · emit.ts · skills/aidlc/ · hooks/aidlc-copilot-adapter.ts
scripts/
  package.ts               # bun scripts/package.ts [<name>] [--check]
  manifest-types.ts        # the HarnessManifest contract every manifest implements
dist/<name>/               # GENERATED Bun-invocation channel
dist-release/<name>/       # GENERATED native-aidlc channel
```

`core/` prose names the harness directory with `{{HARNESS_DIR}}`, calls the
framework through `{{INVOKE}}`, and uses `{{TOOL_PREFIX}}` where a generated
prefix is required. The packager substitutes the declared directory plus one of
two invocation policies:

| Channel | `{{INVOKE}}` | `{{TOOL_PREFIX}}` |
|---------|--------------|-------------------|
| `dist/` | `bun <harness-dir>/tools/aidlc.ts` | `bun <harness-dir>/tools/` |
| `dist-release/` | `aidlc` | `aidlc ` |

The transform applies to Markdown and structured command surfaces
(`.json`/`.toml`/`.hook`), and to invocation tokens in TypeScript; it is not a
general source rewrite. The runtime `harnessDir()` seam in
`core/tools/aidlc-lib.ts` still derives the directory from the shipped layout
(open-set: the tool's own path, not a hardcoded list), so the same authored tool
sources run in every tree. The acceptance gate is **generator determinism**:
`package.ts --check` builds both channels and every plugin projection twice in
independent temporary roots, then byte-compares the complete outputs. It does
not read local `dist/` or `dist-release/`.

The packager **discovers** harnesses by scanning `harness/` for a `manifest.ts`,
so a new dir is built by the default `bun scripts/package.ts` and `--check` with
no edit to the packager itself — the literal meaning of "one directory and one
manifest row, zero shared-code edits."

## Step 1 — the manifest (the declarative 80%)

Create `harness/<name>/manifest.ts` exporting a `HarnessManifest`
(`scripts/manifest-types.ts`). The fields:

- `name` / `harnessDir` — the dir the token substitutes to (e.g. `.foo`).
- `productName` / `configNextStep` — user-facing projection metadata consumed by
  lifecycle and `aidlc config`; keep host commands exact.
- `rootIntegrations` — every project-root file emitted by the normal projection,
  each with an explicit init merge policy (`managed-block`, `json-map`,
  `json-array`, or `whole-file`). Declare marker/JSON identity, optionality, and
  exact legacy adoption hashes here. The packager rejects an emitted top-level
  entry that is neither a managed directory nor a declared root integration.
- `nativeRootIntegrations` (optional) — release-channel-only root files, such as
  a trust seed, with the same merge contract plus an authored `src`.
- `tierFlavor` — selects the existing Claude/Codex/Kiro/OpenCode agent
  model/effort projection shape. It is manifest data, never inferred from
  `name`.
- `coreDirs: DirMap[]` — which `core/<src>` dirs project into `<harnessDir>/<dst>`.
  Rename or drop dirs here (Kiro `rules → steering`; Codex `rules → aidlc-rules`
  and drops `skills/` — see emit). The 3 session skills are core dirs for
  in-tree harnesses (claude, kiro, kiro-ide); codex emits them instead.
- `harnessFiles: FileMap[]` — authored surfaces copied verbatim from
  `harness/<name>/<src>` into each channel (supported text formats get token
  substitution).
  `projectRoot: true` lands a file beside the harness dir (e.g. `AGENTS.md`).
- `orchestratorSkillPath` (optional) — project-root-relative path to the
  assembled orchestrator `SKILL.md`. It defaults to
  `<harnessDir>/skills/aidlc/SKILL.md`; declare it for emit-owned layouts outside
  that tree, such as `.agents/skills/aidlc/SKILL.md`.
- `frontmatterAdditions` (optional) - per-file YAML lines appended to a
  core-projected `.md`'s frontmatter during projection, for a harness-NATIVE
  field that must not ship to other harnesses (kiro-ide injects
  `tools: ["read", "write", "shell"]` into its delegation-target agent files -
  the IDE reads subagent tool grants from the `.md` frontmatter). Declared as
  manifest data so core stays single-source; the packager errors on a typo'd
  path, a missing frontmatter block, or a key core already declares.
- `rulesRename` — the renamed rules dir (`"steering"` | `"aidlc-rules"` | `null`).
  The packager applies it to the copied dir AND to in-prose `<harnessDir>/rules/`
  references AND to the compiled stage-graph rule paths (it sets
  `AIDLC_RULES_DIR` at compile so `loadRules` finds the renamed dir) AND emits it
  into a generated `tools/data/harness.json` that records both the manifest
  name and rules directory. Runtime path resolution uses the name to
  disambiguate harnesses that share an engine directory, while `rulesSubdir()`
  reads the rename — so a real install resolves both facts without hardcoding.
  This is the seam that makes `rulesRename` purely manifest data: set it here and
  every layer (build prose, compiled paths, runtime) follows, with no `core/` edit.
- `onboarding` — render a host onboarding file from
  `core/templates/onboarding.md`, or `null` when `emit.ts` owns it.
- `skipRunnerGen` — set when the harness ships no `<harnessDir>/skills/` (Codex
  emits its skill tree to `.agents/skills/` via `emit`); the packager then skips
  the standard runner-gen step.
- `emit` — the optional plugin (Step 3), `null` for harnesses that need none.
- `plugin` (optional) — the host plugin manifest directory and delivery kind.
  Omitting it derives `<harnessDir>-plugin` plus store delivery; set `kind:
  "kiro"` only for a folder-drop host.

Claude's manifest is the minimal reference (no rename, no emit); Kiro's adds a
rename + `harnessFiles` (agent JSONs, adapter, the project-root AGENTS.md);
Codex demonstrates native-only root integration and imperative emission.

The packager writes `tools/data/harness.json`, `aidlc-stamp.json`, and
`aidlc-projection.json` from these fields. The first is runtime configuration;
the stamp identifies version/distribution/harness; the projection descriptor is
the install ownership contract. `aidlc config` will reject an inconsistent or
unsafe descriptor, so do not generate parallel metadata in `emit.ts`.

## Step 2 — the hook adapter (the per-harness shim)

Core hooks consume Claude-shaped stdin as the normal form. A new harness ships
**one authored adapter** (`harness/<name>/hooks/aidlc-<name>-adapter.ts`,
listed in `harnessFiles`) that normalizes the harness's hook
payloads into that contract and subprocess-pipes to the shared core hook.
Never split a core hook into logic+adapter — the core bodies stay byte-shared
across all harnesses apart from the explicit invocation-token projection.
`--check` proves both generated forms came from the same source.

Wire the adapter to the harness's events the harness's own way: Kiro registers
targets in `agents/aidlc.json`; Codex emits `hooks.json`. Register only events
with a real core-hook consumer.

Six hooks are flow-altering and need their control channels forwarded, not
just piped. The Stop hook answers with `{"decision":"block"}` on stdout;
dispatch-rules rewrites the delegated prompt; and the PreToolUse
reviewer-scope, review-freeze, plan-approval, and state-transition guards
answer with exit 2 + a reason on stderr (the tool call must be refused when
the adapter relays that exit code). If the new harness cannot hard-block a
tool call from its pre-tool seam, leave the reviewer-scope and review-freeze
registrations out and document the gap rather than wiring dead hooks - the
prose bounds in stage-protocol-reviewer.md §12a still govern there. When the harness's
payloads carry no subagent identity, scope reviewer-scope registration to the
reviewer agents themselves where the harness supports per-agent hooks (the
Kiro CLI pattern: the adapter then asserts `scoped_registration` instead of
matching `agent_type`).

> **The one sanctioned `core/` edit: the doctor arm.** `/aidlc --doctor`
> (`core/tools/aidlc-utility.ts`) health-checks an installed tree, and a new
> harness adds a per-harness arm there for its own install surfaces (adapter +
> wiring files present, any binary-version floor). This is deliberate
> per-harness *logic*, not data — a version check spawns the CLI and compares
> semver, which no manifest row can express (the three-concerns rule: knowledge
> lives in code) — so it is the blessed exception to "zero `core/` edits", not a
> violation (a deliberate design tradeoff). It degrades gracefully: a harness with no arm simply
> gets the generic checks rather than failing. Everything else — dir resolution,
> the rules-dir rename, packaging — stays pure manifest data.

## Step 3 — `emit.ts` (the imperative 20%, only if needed)

Structural divergence a declarative row can't express is `emit.ts` — a plugin
the manifest references that the packager calls with an `EmitContext`
(`repoRoot`, `coreRoot`, `harnessRoot`, `harnessName`, `distRoot`,
`harnessDir`, channel-aware `substituteToken`, `tierCap`). The emitter writes
its outputs beneath `distRoot`. Codex's is the worked example:
`config.toml`, `hooks.json`, the hook-trust pre-seed, the `AGENTS.md` merge, the
agent-TOML transpositions, and the `.agents/skills/` tree (composed from
`core/tools/aidlc-runner-gen.ts`'s exported render functions under
`AIDLC_HARNESS_DIR`, never reimplemented). Harnesses whose surfaces are all
authored files (Claude, Kiro) set `emit: null`.

Under `--check`, the packager supplies two independent temporary `distRoot`
sets, runs the same emitter once per channel in each build, then compares the
two complete generated roots. Emit-owned files outside `<harnessDir>` (for
example `.agents/skills/` and the root `AGENTS.md`) therefore participate in the
same missing, differing, and orphan checks as declarative outputs. Always pass
emitted command text through `ctx.substituteToken`; otherwise an emitter can
silently put a Bun command into the native channel.

## Step 4 — the bounded transform classes

Permitted transforms are the harness/rules projection, the two invocation
tokens, declared tier/frontmatter additions, and the native host-surface
rewrites in `rewriteNativeInvocations`. That native pass updates command
allowlists, hook/adapter/statusline routes, onboarding runtime text, and native
trust entries, then rejects any surviving token or Bun invocation into an AIDLC
tool/hook. No blind `sed`. Truthful harness-specific literals in `core/` (the
`$CLAUDE_PROJECT_DIR` note, the harness-dir enumeration in
workspace-detection) carry no token and pass through unchanged; the core-hygiene
and native-projection tests guard the boundary.

## Step 5 — tests + the gate

- A package-determinism test (`t145`) runs `package.ts --check`; it covers both
  channels for every discovered harness plus every plugin projection without
  requiring generated trees on disk.
- `t243-install-mechanism` asserts copy projections keep Bun invocations,
  release projections contain no AIDLC Bun invocation, metadata is safe and
  exhaustive, and native-only integrations appear only in `dist-release/`.
- `t238-build-binaries` compiles the native dispatcher and exercises every
  generated harness runtime without Bun on `PATH`.
- A `<name>` hook-adapter contract test pipes live-captured payloads through the
  adapter and asserts the observable core-hook effect.
- Live journeys ship as e2e gated on a `skipReason()` (a `AIDLC_<NAME>_*_LIVE=1`
  env + the binary present + authenticated) so they skip cleanly in the
  deterministic tier and run green locally before a port merges.

Run `bun scripts/package.ts <name>` to materialize both local channels,
`--check` to prove deterministic generation, and
the deterministic suite (`bash tests/run-tests.sh --smoke --unit --integration
-P 8`) plus the live journey to gate.

## Next

That closes the arc: you have shaped the data surfaces (chapters 01–08) and now
rendered the core onto a new CLI. From here:

- Back to [the Harness Engineer Guide overview](00-overview.md) for the full map.
- The new harness gets a **user-facing chapter** alongside the others — see how
  the existing ones read in the User Guide's
  [Running on other harnesses](../guide/harnesses/README.md) family.
- The normative build contract (manifest types, the `emit` plugin API, the
  `harnessDir()` seam) lives in the Developer Reference's
  [Architecture § Source vs distribution](../reference/01-architecture.md#source-vs-distribution-one-core-many-harnesses).
