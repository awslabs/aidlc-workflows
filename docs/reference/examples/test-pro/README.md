# `test-pro` — concrete config/JSON examples

These are the **configuration documents** in the plugin design, made concrete for
the shipped `test-pro` fixture. They illustrate [doc 18](../../18-plugin-mechanism.md),
the single plugin-mechanism chapter. **Most of what they depict is deferred**, not
shipped — see doc 18 §8 "Status" for exactly what is wired today (the plugin
manifest + the compose seam) versus designed-but-future (marketplace resolution,
managed-settings trust, the lockfile, and the `aidlc plugin add`/`sync` installer).
They show the intended lifecycle, not current behavior.

| File | Role | Authored by | Where it lives |
|---|---|---|---|
| [`../../../../plugins/test-pro/.aidlc-plugin/plugin.json`](../../../../plugins/test-pro/.aidlc-plugin/plugin.json) | **Plugin manifest** — what the plugin is + what it ships | the plugin author | in the plugin repo (real file, created) |
| [`marketplace.json`](marketplace.json) | **Catalogue entry** — how a plugin is discovered/versioned | a marketplace maintainer | a marketplace repo |
| [`managed-settings.json`](managed-settings.json) | **Trust allowlist** — which sources an org permits | an org admin (managed scope) | the machine's managed-settings path |
| [`aidlc.lock.json`](aidlc.lock.json) | **Install lock** — pins the composed result for reproducibility | the `aidlc plugin` installer | the consumer's project |

## Status of these files

- `plugin.json` is a **real, created file** in the repo — the manifest for the
  shipped `test-pro` fixture. (Note: the packager discovers plugin content by
  directory convention today and does not yet read the manifest's
  `aidlc.contributes` block — see doc 18 §3.)
- `marketplace.json`, `managed-settings.json`, and `aidlc.lock.json` are
  **illustrative examples** for design review only. The installer, marketplace
  resolution, and lockfile writer that would *produce* and *consume* them are
  **future work** (doc 18 §8 "Status"). All `sha256:…` and `commit` values in
  the lockfile are **placeholders**, not computed hashes.

## The lifecycle these files trace

1. **Author** writes `plugin.json` and the plugin's subtrees, publishes a git tag.
2. **Marketplace** (optional) lists the plugin in `marketplace.json` for discovery.
3. **Org admin** sets `managed-settings.json` so only approved sources may be
   installed — devs cannot override it (managed scope, highest precedence).
4. **Developer** runs `aidlc plugin add test-pro`: resolves the version, checks
   it against the allowlist, fetches + verifies, composes `bare core + test-pro`,
   and writes `aidlc.lock.json`.
5. **Teammate** runs `aidlc plugin sync` against the committed `aidlc.lock.json`
   and gets a byte-identical install.
