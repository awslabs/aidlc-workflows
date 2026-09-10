# Plugin Graduation

An external plugin, a first-party marketplace plugin, and core content use the
same underlying stage and contribution model. Graduation is a maintenance and
product decision, not a special installation privilege. This chapter defines
how a proven plugin becomes a core capability without leaving users guessing
which copy to run. See [Authoring a Plugin](10-authoring-a-plugin.md) for
publishing and [Plugin Mechanism](../reference/18-plugin-mechanism.md) for the
manifest, catalog, and status contracts.

## 1. Establish that core is the right home

Bring a proposal with evidence, not just a working projection:

- **Adoption signal:** real users and workflows benefiting from the capability,
  recurring demand across teams, and evidence that the concern belongs in core
  rather than remaining an optional domain-specific extension.
- **Maintenance commitment:** named maintainers, a review and support path,
  ownership of behavior across every supported harness, and a plan for defects
  discovered after graduation.
- **License hygiene:** compatible licensing and attributable provenance for all
  prose, code, templates, and bundled assets; no unreviewed copied payloads or
  private customer material.
- **Security pass:** review every hook and executable tool that ships, its
  privileges, network/file access, dependencies, inputs, and subprocess use.
  A catalog checksum verifies bytes, not safety. Host trust prompts and the
  managed confirmation do not replace this review.
- **Behavioral evidence:** representative workflows, isolated composition
  checks, failure/rollback coverage where relevant, and no dependence on a
  single host's accidental filesystem layout.

Core maintainers decide whether the capability fits the methodology and its
long-term support cost. Marketplace popularity is useful evidence, not an
automatic promotion rule. An external plugin can first move under named
first-party marketplace ownership without moving into core.

## 2. Make the core migration explicit

Open a core PR that links the proposal and its evidence. Move the capability
into the appropriate existing `core/` shapes: stages under `aidlc-common/`,
scopes, agents, sensors, tools, knowledge, or the rule layer as appropriate.
A contribution that becomes core belongs in its target's authored source, not
in a permanent plugin overlay disguised as core.

The PR must explain:

1. Which plugin-owned stage, scope, artifact, and agent identities change, and
   how existing workflow records and active users are affected.
2. Which content remains optional, which core scopes activate it, and how to
   avoid duplicate execution while old plugin installs still exist.
3. The first core release containing the replacement and the supported upgrade
   order. Do not tell users to remove a plugin before its replacement is in
   their installed core.
4. How packaged projections, affected callers, documentation, and behavioral
   checks converge on one supported implementation. Do not retain an obsolete
   compatibility copy solely to hide an incomplete migration.

Follow the repository's normal review and release process. The marketplace
publisher should not announce a completed graduation until that core release
is available to users.

## 3. Publish a tombstone release

After the replacement core release is available, publish a new plugin version
with `aidlc.supersededBy` in its authored `.aidlc-plugin/plugin.json`. Retain
its other manifest fields and contributions as needed for the documented
transition; add this metadata to the existing `aidlc` object:

```json
{
  "supersededBy": {
    "core": "2.8.3",
    "note": "Upgrade core first, then remove this plugin; see the migration notes."
  }
}
```

`2.8.3` above illustrates strict semver; use the actual first core release that
contains your capability. `note` is optional but must be non-empty when present.
Increment the plugin's own version, rebuild every harness projection, run
`aidlc plugin catalog`, and publish the resulting commit with
`<plugin>--v<new-plugin-version>`. Do not move an existing tag or delete old
archives that consumers may still need.

The emitter copies `supersededBy` into each projection marker, and catalog
assembly copies it into the published entry:

- `aidlc plugin search` annotates the published plugin as superseded.
- `aidlc plugin list --check` can report the catalog tombstone even when an
  older installed projection has no tombstone metadata.
- After a tombstone projection is installed, plain offline `aidlc plugin list`
  and `aidlc doctor` report attention: `superseded by core v<version>; remove
  the plugin after upgrading to aidlc <version>`. JSON uses state `superseded`.

No command silently removes or disables the plugin. The migration note must
name the host-native removal procedure for Claude/Codex or the reviewed managed
projection removal procedure for other harnesses, plus any required selection
and ownership-safe sync steps. Marketplace `remove` unregisters a source; it
is not a plugin uninstall command. Never manually delete composed core files
as a substitute for the ownership-aware composer.

## 4. Keep marketplace review ownership visible

Each marketplace repository must name its maintainers and carry its own
`CODEOWNERS` covering catalogs, generated projections, publishing workflows,
and executable hook/tool payloads. Those owners review additions, updates,
source changes, graduation notices, and the commit/tag pairing before
publication. This source repository does not grant review approval to a
separately maintained marketplace.

The dedicated first-party destination is `awslabs/aidlc-plugins`; creating it
and installing its publishing CI and CODEOWNERS are operational work outside
this source tree. A private marketplace uses the same generated tree and must
establish its own owners. Retain review evidence and immutable release tags,
and document how users report a security issue or request a plugin update.
