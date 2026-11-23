# plugin-inventory-run — verdict and disposition

Validation of Rubén's patch 0003 (Devin plugin inventory) plus the
`DEVIN_PLUGIN_ROOT` hardening. Environment/commands/artifact index: `README.md`.

**Verdict: real, unreleased bug.** `harness/devin/manifest.ts` omits `plugin`, so
the packager emits the default `.devin-plugin/` manifest dir (since `e0d5e454`),
while `harnessKind()` in `core/tools/aidlc-plugin.ts` (from `12b8d6e0`) never
learned `devin`: it ignored `AIDLC_HARNESS_NAME=devin` and `.devin`, resolved
`claude`, and `hostManifestDirectory` probed `.claude-plugin/plugin.json`.
Observed (step4-before A1): `plugin sync refused: …/devin/.claude-plugin/plugin.json: installed plugin manifest is missing`,
exit 1; list reported `harness: "claude"`, `installed: []`, one invalid. The
defect existed only on `feat/devin-harness` / `origin/feat/acp-control-plane` —
not in any tag or `upstream/main`.

**Fix:** `3cf198e2` — patch 0003 (`devin` in the `PluginInventory` union,
`harnessKind`, `hostManifestDirectory`, compose `pluginNameFromRoot`) plus
`DEVIN_PLUGIN_ROOT` hardening: read last in `currentRoots()` /
`pluginRootCandidatesFromEnv()` / the compose `PLUGIN_ROOT` chain, set alongside
the other aliases by `composeEnvironment` / `handlePluginSync` / the launcher,
covered by the compiled-mode save/restore key lists and the env scrubs, and
`resolve()`-normalized before dedupe (`/p` vs `/p/` otherwise count as two
same-key roots → `deduplicateInventory` "ambiguous" → sync refuses).

**Evidence:** step1 — t242 27 pass / 1 fail without the fix; step3 — all green
with patch 0003 on `dafdaa99`; step4 — e2e sync exit 1→0, `harness` claude→devin,
stamp written; step6 — after hardening: t242+t231+t316 68/0, t188 93/0,
test-pro 3/3, typecheck/lint/package `--check` clean, alias check fails without
normalization.

**Follow-ups:** `DEVIN_PLUGIN_ROOT` read path — implemented in `3cf198e2`;
`composeCommand()`'s last-resort `"$BUN" "${PLUGIN_ROOT}/hooks/compose.ts"` —
open (Devin documents no `PLUGIN_ROOT` for hooks; needs a live plugin-hook
capture); doctor "Plugins: 1 need attention" — expected `current-root-only`
behavior, not a defect.
