# Distribution, installation, and packaging

**Finding:** DEVIN-01. **Status:** Implemented; live native/plugin acceptance remains separate. **Source baseline:** `6e208f7b`. **Fact-checked:** 2026-09-12.

## Why this was needed

The port needed to become a supported projection of the existing engine, not a fork of AI-DLC's workflow rules. Adding a skill alone would leave runtime discovery, installation, plugins, and binary release checks unaware of Devin.

## Current implementation

`harness/devin/manifest.ts` declares `name: devin`, `harnessDir: .devin`, `tierFlavor: devin`, and the authored file mappings. It uses the shared declarative packager with `emit: null`. Core tools, hooks, agents, protocols, knowledge, sensors, scopes, and standalone skills are projected alongside the adapter, native configuration, rules pointer, and orchestrator.

The mutable workspace is `aidlc/`, a sibling of `.devin/`. Root `AGENTS.md` and `.gitignore` have managed-block integration policies. Method seeds live under `aidlc/spaces/default/memory/`; active-space memory is not an additional private copy inside `.devin/`.

`bun scripts/package.ts` materializes local copy and native release projections. `dist/` and `dist-release/` are generated, ignored outputs; they are not hand-authored or committed. Native projections rewrite commands and permissions to the installed `aidlc` runtime; the adapter uses `AIDLC_COMPILED_EXECUTABLE` when supplied and otherwise respawns with `process.execPath`. Source-copy tools/hooks need Bun; a native installation does not require a separate Bun executable.

Runtime discovery includes `.devin`, and the metadata-unavailable fallback resolves it to `devin` rather than `claude`. Binary checks include `runtime-devin` and `harness-probe-devin`.

Omitting a custom plugin projection selects the shared store-style `.devin-plugin` format. Optional AI-DLC plugins use the shared packaging/composition mechanism; the native plugin namespace and loader remain host concerns. A generated plugin tree is not proof that its host installation or hooks were exercised.

## Evidence and limits

t331 checks Devin copy-tree engine TypeScript parity and shell shape. Markdown receives substitutions and frontmatter additions; native projections intentionally differ. Shared code is not a guarantee of identical host behavior.

`package.ts --check` compares two independent builds. It does not compare a checked-in distribution, prove before/after equivalence, or exercise Devin itself. PR #996 being present locally does not prove that a selected published release asset includes it.

Devin's plugin documentation describes local plugin hooks as best-effort/fail-open. Do not treat plugin load success or project hook registration as an authorization guarantee.

## Regression and upgrade checks

| Case | Expected contract | Evidence or gap |
| --- | --- | --- |
| Build and determinism | All selected projections build; independent builds match byte-for-byte | t331-devin-packaging; package.ts --check |
| Metadata missing or unreadable | A .devin install resolves the Devin distribution, not Claude | aidlc-runtime-paths; native harness probe in t238-build-binaries |
| Copy/native child execution | Copy adapter reuses its executable; native dispatch uses the compiled hook route | t332-devin-adapter; t238-build-binaries |
| Root installation and refresh | Workspace remains beside .devin; managed project content and local customizations are preserved | Shared t243-install-mechanism; inspect the Devin manifest when installation contracts change |
| Optional plugin on actual host | Namespaced skills/profiles and intended hooks load without bypassing workflow authority | Fresh host/plugin acceptance NOT RUN by this rewrite |

## Superseded approaches and history

Initial port: `172cfd55`. Runtime fallback and binary coverage: `ad45d5de`; the missing probe-gate assertion was added in `24aa87c1`. Generated outputs stopped being tracked in `5b970612`.

Retired guidance: checking out `v2`, assuming dist exists in a fresh clone, committing regenerated distributions, requiring external Bun for native installations, and treating determinism as an existing-tree drift check. Use a build containing Devin and the current installation documentation, not old release numbers from development plans.

## Sources

- `harness/devin/manifest.ts`
- `scripts/manifest-types.ts`
- `scripts/package.ts` — rewriteDevinNativePermissions, native projection
- `scripts/build-binaries.ts` — harnessRuntimeGate, harnessProbeGate
- `core/tools/aidlc-runtime-paths.ts` — HARNESS_PRECEDENCE, runtimeHarnessName
- `harness/devin/hooks/aidlc-devin-adapter.ts` — runCore, runCoreWithStderr
- `tests/unit/t331-devin-packaging.test.ts`
- `tests/unit/t238-build-binaries.test.ts`
- `tests/unit/t243-install-mechanism.test.ts`
- `tests/unit/t315-plugin-build.test.ts`
- `tests/integration/t188-plugin-compose.serial.test.ts`
- https://docs.devin.ai/cli/extensibility/plugins/overview

[Back to findings index](index.md)
