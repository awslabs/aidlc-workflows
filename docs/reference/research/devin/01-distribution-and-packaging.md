# Distribution, installation, and packaging

**Finding:** DEVIN-01. **Status:** Implemented; live native/plugin acceptance remains separate. **Source baseline:** `6e208f7b`; plugin inventory section at `3cf198e2`. **Fact-checked:** 2026-09-12; plugin inventory section 2026-10-09.

## Why this was needed

The port needed to become a supported projection of the existing engine, not a fork of AI-DLC's workflow rules. Adding a skill alone would leave runtime discovery, installation, plugins, and binary release checks unaware of Devin.

## Current implementation

`harness/devin/manifest.ts` declares `name: devin`, `harnessDir: .devin`, `tierFlavor: devin`, and the authored file mappings. It uses the shared declarative packager with `emit: null`. Core tools, hooks, agents, protocols, knowledge, sensors, scopes, and standalone skills are projected alongside the adapter, native configuration, rules pointer, and orchestrator.

The mutable workspace is `aidlc/`, a sibling of `.devin/`. Root `AGENTS.md` and `.gitignore` have managed-block integration policies; the engine adopts an unmarked copy-channel `AGENTS.md`/`.gitignore` into its managed block on the first run (shared `mergeBlock` in `core/tools/aidlc-distribution.ts`, ~679-683) — cross-harness behavior, since no harness ships markers in `dist/`. Method seeds live under `aidlc/spaces/default/memory/`; active-space memory is not an additional private copy inside `.devin/`. Since the `b8d9bdc3` merge the personas and the rules pointer read `aidlc/active-memory/` — the engine's git-ignored copy of the active space's memory, beside `aidlc/` (not inside `.devin/`), refreshed at session start, on a space switch, and with each step whose rules it sends; only `aidlc/spaces/<active-space>/memory/` is edited. Upstream replaced rewriting tracked includes on a space switch with this copy. The `.gitignore` managed block was reduced to upstream's minimal `# AI-DLC: local working files` block — adding `aidlc.settings.local.json` and `aidlc/active-memory/` — while keeping the Devin-local ignores (`.devin/config.local.json`, `.devin/mcp_config.local.json`, `.devin/.aidlc-session-start.local.json`); the previous shipped variant's hash stays in the manifest so existing installs remain recognized (2026-10-09).

`bun scripts/package.ts` materializes local copy and native release projections. `dist/` and `dist-release/` are generated, ignored outputs; they are not hand-authored or committed. Native projections rewrite commands and permissions to the installed `aidlc` runtime; the adapter uses `AIDLC_COMPILED_EXECUTABLE` when supplied and otherwise respawns with `process.execPath`. Source-copy tools/hooks need Bun; a native installation does not require a separate Bun executable.

Runtime discovery includes `.devin`, and the metadata-unavailable fallback resolves it to `devin` rather than `claude`. Binary checks include `runtime-devin` and `harness-probe-devin`.

Omitting a custom plugin projection selects the shared store-style `.devin-plugin` format. Optional AI-DLC plugins use the shared packaging/composition mechanism; the native plugin namespace and loader remain host concerns. A generated plugin tree is not proof that its host installation or hooks were exercised.

### Plugin inventory and root discovery

`dist/plugins/<name>/devin/` ships only `.devin-plugin/plugin.json` — the manifest dir the packager derives when `harness/devin/manifest.ts` omits `plugin` (`kind:"store"`). `discoverPluginInventory()` (`core/tools/aidlc-plugin.ts`) resolves the harness through `harnessKind()` — `AIDLC_HARNESS_NAME` first, then the `.devin` harness-dir leaf — and reads the host-native manifest under `hostManifestDirectory("devin")` = `.devin-plugin/`. Devin exposes no plugin registry to AIDLC, so the capability is `current-root-only`: roots come from the environment — `CLAUDE_PLUGIN_ROOT`, `PLUGIN_ROOT`, `AIDLC_PLUGIN_ROOT`, then `DEVIN_PLUGIN_ROOT` last — each `resolve()`-normalized before dedupe so aliased spellings of one root (`/p` vs `/p/`) count once instead of surfacing as a same-key "ambiguous" duplicate that sync refuses.

The documented host contract (devin 3000.11.3 bundled docs): hook commands receive `CLAUDE_PROJECT_DIR` and `CLAUDE_PLUGIN_ROOT` (`changelog/stable.mdx:195`, v3000.5.20), plugin-contributed hooks additionally get `DEVIN_PLUGIN_ROOT` (`stable.mdx:209`), `PLUGIN_ROOT` is documented only for `stdio` MCP server processes (`extensibility/plugins/overview.mdx:111`), and hooks get `DEVIN_PROJECT_DIR` (`extensibility/hooks/overview.mdx:130`). Whether `CLAUDE_PLUGIN_ROOT` is set for native `.devin-plugin` plugins — versus only Claude-format ones — is undocumented and was not observed live; AIDLC therefore honors `CLAUDE_PLUGIN_ROOT` first and reads `DEVIN_PLUGIN_ROOT` as the last fallback.

**Defect history (unreleased).** `harnessKind()` never learned `devin` when the harness landed: the function dates to `12b8d6e0` and `e0d5e454` (the initial Devin harness) added neither the enum member nor the `.devin` leaf, so discovery ignored `AIDLC_HARNESS_NAME=devin`, fell through to `claude`, and probed `.claude-plugin/plugin.json`. `plugin sync` refused with `…/devin/.claude-plugin/plugin.json: installed plugin manifest is missing` (exit 1) and `plugin list` reported `harness: "claude"`, `installed: []`, one invalid entry (`step4-before-e2e.txt` A1–A3). `3cf198e2` (2026-10-09) added `devin` to the `PluginInventory` union, `harnessKind`, `hostManifestDirectory`, and compose's `pluginNameFromRoot`, plus the `DEVIN_PLUGIN_ROOT` fallback and the dedupe normalization above. The defect lived only on `feat/devin-harness` / `origin/feat/acp-control-plane` — no tag or `upstream/main` contains it. Reproduction and fix captures: `evidence/devin-e2e-run/plugin-inventory-run/`.

## Evidence and limits

t331 checks Devin copy-tree engine TypeScript parity and shell shape. Markdown receives substitutions and frontmatter additions; native projections intentionally differ. Shared code is not a guarantee of identical host behavior.

`package.ts --check` compares two independent builds. It does not compare a checked-in distribution, prove before/after equivalence, or exercise Devin itself. PR #996 being present locally does not prove that a selected published release asset includes it.

Devin's plugin documentation describes local plugin hooks as best-effort/fail-open. Do not treat plugin load success or project hook registration as an authorization guarantee.

Doctor's `Plugins: 1 need attention` row (fix text `host inventory unavailable; run sync through the host SessionStart adapter`) does not mean a plugin is missing: `comparePluginState()` (`core/tools/aidlc-plugin.ts` ~660) emits a single `inventory-unavailable`/`attention` row for every inventory whose capability is not `full-inventory`. Devin's inventory is `current-root-only`, so the row appears even after a successful sync composes the plugin (step4-after A2/A4) — expected behavior, identical on every current-root-only harness.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Build and determinism | All selected projections build; independent builds match byte-for-byte | t331-devin-packaging; package.ts --check |
| Metadata missing or unreadable | A .devin install resolves the Devin distribution, not Claude | aidlc-runtime-paths; native harness probe in t238-build-binaries |
| Copy/native child execution | Copy adapter reuses its executable; native dispatch uses the compiled hook route | t332-devin-adapter; t238-build-binaries |
| Root installation and refresh | Workspace remains beside .devin; managed project content and local customizations are preserved | Shared t243-install-mechanism; inspect the Devin manifest when installation contracts change |
| Devin plugin inventory | `.devin` / `AIDLC_HARNESS_NAME=devin` resolve to the devin harness and read `.devin-plugin/plugin.json`; sync composes the plugin and writes the compose stamp | t242 `Devin reads its native .devin-plugin manifest as current-root-only` and `Devin discovers its plugin from DEVIN_PLUGIN_ROOT alone`; step4 before/after e2e in `evidence/devin-e2e-run/plugin-inventory-run/` |
| Plugin-root aliases | Spellings of one root across `CLAUDE_PLUGIN_ROOT` / `PLUGIN_ROOT` / `AIDLC_PLUGIN_ROOT` / `DEVIN_PLUGIN_ROOT` dedupe to a single entry | t242 `…aliases for one root count once` — fails if `currentRoots()` drops the `resolve()` normalization (`step6-t242-alias-without-normalization.txt`) |
| `${PLUGIN_ROOT}` last-resort compose step | `composeCommand()` (`core/tools/aidlc-plugin-emit.ts` ~329–363) emits `"$BUN" "${PLUGIN_ROOT}/hooks/compose.ts"` for every non-Claude harness, reached only when neither `aidlc` on PATH nor `<project>/.devin/tools/aidlc-plugin.ts` exists | Open residual: Devin documents `PLUGIN_ROOT` only for stdio MCP servers, so on a Devin plugin hook that step resolves to `/hooks/compose.ts`. Needs a live plugin-hook capture deciding `DEVIN_PLUGIN_ROOT` vs `CLAUDE_PLUGIN_ROOT` |
| Optional plugin on actual host | Namespaced skills/profiles and intended hooks load without bypassing workflow authority | Fresh host/plugin acceptance NOT RUN by this rewrite |

## Superseded approaches and history

Initial port: `172cfd55`. Runtime fallback and binary coverage: `ad45d5de`; the missing probe-gate assertion was added in `24aa87c1`. Generated outputs stopped being tracked in `5b970612`. Plugin inventory learned `devin` in `3cf198e2` — `e0d5e454` shipped `.devin-plugin` projections and `12b8d6e0` introduced `harnessKind()`, but neither wired the two together until then.

Retired guidance: checking out `v2`, assuming dist exists in a fresh clone, committing regenerated distributions, requiring external Bun for native installations, and treating determinism as an existing-tree drift check. Use a build containing Devin and the current installation documentation, not old release numbers from development plans.

## Sources

- `harness/devin/manifest.ts`
- `scripts/manifest-types.ts`
- `scripts/package.ts` — expandDevinToolAllows, rewriteDevinNativePermissions, native projection
- `scripts/harness-bindings.ts` — BINDING_HEADINGS own-subsection projection
- `scripts/build-binaries.ts` — harnessRuntimeGate, harnessProbeGate
- `core/tools/aidlc-runtime-paths.ts` — HARNESS_PRECEDENCE, runtimeHarnessName
- `harness/devin/hooks/aidlc-devin-adapter.ts` — runCore, runCoreWithStderr
- `core/tools/aidlc-plugin.ts` — harnessKind, hostManifestDirectory, currentRoots, comparePluginState
- `core/tools/aidlc-utility.ts` — pluginRootCandidatesFromEnv
- `scripts/plugin-hooks-template/compose.ts` — PLUGIN_ROOT resolution chain
- `core/tools/aidlc-plugin-emit.ts` — composeCommand
- `tests/unit/t242-plugin-state.test.ts`
- `tests/unit/t331-devin-packaging.test.ts`
- `tests/unit/t238-build-binaries.test.ts`
- `tests/unit/t243-install-mechanism.test.ts`
- `tests/unit/t315-plugin-build.test.ts`
- `tests/integration/t188-plugin-compose.serial.test.ts`
- https://docs.devin.ai/cli/extensibility/plugins/overview
- Devin 3000.11.3 bundled docs (via the `devin-cli` skill): `changelog/stable.mdx:195,209` (v3000.5.20 — `CLAUDE_PLUGIN_ROOT` on hook commands, `DEVIN_PLUGIN_ROOT` on plugin-contributed hooks), `extensibility/plugins/overview.mdx:111` (`PLUGIN_ROOT` for stdio MCP servers only), `extensibility/hooks/overview.mdx:130` (`DEVIN_PROJECT_DIR`)

[Back to findings index](index.md)
