# `test-pro` — marketplace and policy examples

These examples accompany [Plugin Mechanism §5b](../../18-plugin-mechanism.md#5b-marketplaces)
and the shipped `test-pro` fixture. Catalog generation, remote discovery,
projection verification, managed installation, and the machine allowlist are
implemented; the historical lockfile example is not a runtime contract.

| File | Role | Authored by | Runtime location |
|---|---|---|---|
| [Plugin manifest](../../../../plugins/test-pro/.aidlc-plugin/plugin.json) | Plugin identity and contributed subtrees | Plugin author | `.aidlc-plugin/plugin.json` in the source repository |
| [`aidlc-marketplace.json`](aidlc-marketplace.json) | Schema-v1 catalog with per-harness paths and digests | `aidlc plugin catalog` / marketplace maintainer | Marketplace repository root |
| [`managed-settings.json`](managed-settings.json) | Real `plugins.allowedMarketplaces` machine setting | Administrator or MDM | `<install-root>/aidlc.settings.json` (merge this section, not the filename) |
| [`aidlc.lock.json`](aidlc.lock.json) | Historical design illustration, superseded by install records | Not generated or consumed | No runtime location |

## What is real, and what is illustrative

The catalog example follows the live schema. Its digest describes the emitted
fixture when this example was generated; rebuild the projections and run
`aidlc plugin catalog` before publishing your own marketplace. Do not treat the
example as a live marketplace or copy its checksum onto different bytes.

The machine-setting example permits an organization URL prefix and one exact
first-party repository URL. A trailing `/` denotes a prefix; a source without
it is exact. An absent/empty allowlist does not restrict sources. Only the
machine layer may set `allowedMarketplaces`; project and local settings cannot
widen it. There is no CLI allowlist writer. This is an AIDLC setting, not a
Claude `managed-settings.json` document; host-native policies still apply.

The old `aidlc.lock.json` contains illustrative hashes and is retained only as
historical design context. Managed installs instead write
`<harness-dir>/tools/data/plugin-install-<name>.json` with
`{schemaVersion:1, plugin, version, harness, marketplace:{name,url}, tag, sha256}`.
That provenance record identifies the source for update/check operations; the
separate composition stamp records the composed source state.

## Current lifecycle

1. The author validates and builds `<root>/<plugin>/<harness>/`, tests
   composition, and runs `aidlc plugin catalog <root> --name team --owner "Team"`.
2. The maintainer publishes that generated tree and its
   `<plugin>--v<version>` tag in a reviewed marketplace repository.
3. An administrator optionally restricts sources with the machine setting.
4. The developer runs `aidlc plugin marketplaces add your-org/your-marketplace
   --name team`, then `aidlc plugin search test-pro` and
   `aidlc plugin install test-pro --marketplace team --harness kiro`.
5. The CLI verifies the tagged projection. Claude/Codex installations hand off
   to the native host store (exit 5); other harnesses confirm the named hooks
   and tools, transactionally install the projection plus record, and compose
   through the project's pinned engine. Non-TTY managed installs need `--yes`.
6. `aidlc plugin list` compares installed/composed state offline;
   `aidlc plugin list --check` opts into remote version/tombstone checks, and
   `aidlc plugin update test-pro` applies the same verification and trust flow.
