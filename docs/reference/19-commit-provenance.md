# Commit Provenance

> Audience: Tier 2/3 (team adopter, framework contributor).

This chapter is the canonical reference for the **commit provenance** subsystem: the durable reverse lookup from an arbitrary git commit or diff range to the reviewed units of work that own its changed paths. It has three parts — **committed reviewed-source evidence** (a snapshot of what a reviewer approved, written into the intent record so it travels with every clone), the read-only resolver **`aidlc attest resolve`** (attribution + drift classification, built to run in CI), and the **`SOURCE_COMMITTED`** audit anchor (**enrichment only** — the resolver never reads it). Cross-link to [State Machine](12-state-machine.md) (the event taxonomy `SOURCE_COMMITTED` joins), [Hooks and Tools](06-hooks-and-tools.md) (the `aidlc-attest.ts` tool entry), the audit format registry (`knowledge/aidlc-shared/audit-format.md`), and the user-facing command walkthrough in [Guide: CLI Commands](../guide/12-cli-commands.md).

---

## 1. The problem

Code Generation already binds each reviewed unit to the exact source it reviewed: the per-unit `REVIEW_COMPLETED` receipt carries a `Unit Source Fingerprint` over the unit's claimed paths and manifest bytes (see [Guide: State and Audit — source-bound review receipts](../guide/10-state-and-audit.md#source-bound-review-receipts)). What was missing is the *other direction*: given a commit that lands later — often squashed, rebased, or bundled with unrelated changes — which reviewed unit (and intent) owns each changed path, and does the committed content still match what was reviewed? Without that lookup, a CI pipeline cannot gate on "every source change in this merge request traces to a reviewed unit."

## 2. Design constraints

Three constraints shape the whole design; each rules out a familiar mechanism:

1. **Most commits are manual.** Users commit with plain `git commit`, from any machine, at any time — often long after the session that produced the change. Hooks and session-time capture therefore cannot be the *foundation*; anything session-observed is at best enrichment.
2. **A fingerprint alone does not name the unit.** The receipt's `Unit Source Fingerprint` proves *what* was reviewed, but a CI job starting from a bare clone and a commit range has no way to go from changed paths to that receipt without an explicit, committed attribution structure.
3. **Commit messages are not a channel.** Teams own their commit formats; trailers, ticket prefixes, and message conventions cannot be relied on and are never parsed.

## 3. The attribution model

Attribution is a **pure function of committed content**: the commit's tree plus the intent record that same repository already carries (audit shards, unit `source-manifest.json`, and the committed evidence below). Nothing depends on local state, refs beyond the commits being resolved, hooks having fired, environment variables, or message text. Two consequences:

- **Any clone can resolve.** A bare CI checkout with only the commits under test produces the identical report as the authoring machine.
- **Determinism.** The same `(base, head)` pair always yields the same attribution; resolution can be re-run years later against the same commits.

Ownership follows the same receipt semantics the engine uses at completion: for each unit, the **newest READY `REVIEW_COMPLETED`** receipt (one carrying `Verdict: READY`, `Unit`, `Stage`, and `Unit Source Fingerprint`) is authoritative. Receipts are ordered by timestamp, then position within a shard, then shard index; two READY receipts for the same unit with the same timestamp in *different* shards cannot be ordered and fail closed (`indeterminate`, §5). A path claimed by several units belongs to the newest claimant — the same "a newer reviewed claim can own an intentional shared-file integration" rule completion applies.

Per owning receipt, path claims come from the strongest available source, in order:

| `claimsSource` | Meaning |
|----------------|---------|
| `manifest` | The unit's `source-manifest.json` hashes to the manifest digest recorded in the evidence header — full claim fidelity, including directory-prefix claims (`src/generated/`) |
| `evidence-only` | No verifiable manifest; claims fall back to the exact path keys in the evidence listing (prefix claims are lost — a new file under a claimed directory shows as `unattested`) |
| `manifest-unverified` | A manifest exists but cannot be verified against evidence (e.g. the evidence is missing); paths still attribute, but content cannot be checked |

## 4. Committed reviewed-source evidence

At review time, the engine dual-writes the unit's reviewed-source snapshot:

- **Committed evidence** (new, authoritative for CI): `<record>/construction/<unit>/<stage>/reviewed-source-<hash12>.tsv` inside the intent record, where `<hash12>` is the first 12 hex digits of the fingerprint. Because the record is committed, the evidence travels with every clone.
- **Local snapshot** (pre-existing): `<record>/.aidlc-source-review/<stage>/unit-<unit>-<hash12>.tsv`, machine-local (ignored), retained for the completion-time freshness checks and as a resolution fallback (§5).

Both files hold **byte-identical content**, and the receipt's `Unit Source Fingerprint` is the SHA-256 of exactly those bytes — there is no second fingerprint scheme; committing the evidence introduced **zero new fingerprint semantics**. Writes are content-addressed: rewriting the same fingerprint is an idempotent no-op, and a write that finds different bytes at the same address refuses (`address collision or corruption`).

The file format (`parseUnitSourceListing` / `serializeSourceListing` in `aidlc-lib.ts`) is a strict TSV grammar:

```
manifest\t<sha256-of-manifest-bytes>\t-\n
<repo>\t<path>\t<mode>\t<oid>\n        # zero or more rows, sorted by key
```

The header binds the manifest bytes; each row records a claimed path's repo selector (empty for the workspace root), path, git file mode (`/^\d{6}$/`), and blob OID (40–64 hex). `\t`, `\n`, `\r`, and `\\` in fields are backslash-escaped; duplicate keys, missing trailing newline, or any malformed field reject the whole file (parser returns null → the evidence is treated as absent). An empty listing after a valid header is valid (a unit whose review claimed no surviving paths).

## 5. Resolution — `aidlc attest resolve`

```
aidlc attest resolve [<commit>] [--diff <base>..<head>] [--repo <name>]
                     [--space <name>] [--intent <dir>] [--fail-on <statuses>]
```

Read-only — resolve never writes, never emits audit events, and never reads `SOURCE_COMMITTED` anchors. Modes: a single `<commit>` positional resolves that commit's first-parent delta (default `HEAD`); `--diff <base>..<head>` resolves the range endpoints directly, and the three-dot form `<base>...<head>` uses the merge base. Every changed path in the delta is classified:

| Status | Meaning | Failable |
|--------|---------|:--------:|
| `verified` | Owned by a reviewed unit and the committed blob OID matches the reviewed evidence | — |
| `drifted` | Owned by a reviewed unit but the committed content differs from what was reviewed | ✓ |
| `unattested` | No reviewed unit claims the path | ✓ |
| `unverifiable` | A receipt claims the path but its evidence is missing or does not hash to the receipt fingerprint — **fail closed**, never silently verified | ✓ |
| `indeterminate` | Receipt ordering is ambiguous (same-timestamp READY receipts in different shards) — **fail closed** | ✓ |
| `excluded` | Framework shell (`aidlc/` / `.aidlc/` when the repo carries it) and nested `.aidlc-sensors/` dirs under intent records — never attributed, never failable | — |

`--fail-on` takes a comma-separated subset of the four failable statuses; a match exits **3** (0 = resolved clean or nothing matched, 1 = usage/environment error). The report is JSON on stdout: `paths[]` (per-path status/unit/intent/reason), `units[]` (owning receipt detail — stage, iteration, `evidenceSource`, `claimsSource`, recorded bypasses, and `fullyLanded`: whether every claimed path landed at its reviewed OID in `head`), a `summary` count per status, and the echoed `failOn`.

Evidence per unit is sought committed-first, then the legacy local snapshot (`evidenceSource: "committed" | "local"`). A tampered committed file with an intact local copy still verifies (via `local`); with both gone or wrong the unit's paths are `unverifiable`. Multi-root workspaces resolve one repo per invocation: the workspace root by default, or a recorded repo by `--repo <name>` (required when the project dir itself is not a git repository).

## 6. Anchors — `SOURCE_COMMITTED` (enrichment only)

```
aidlc attest anchor [--commit <rev>] [--reconcile] [--max-commits <n>]
                    [--repo <name>] [--space <name>] [--intent <dir>]
```

`anchor` runs resolution for a commit (default `HEAD`) and, when reviewed claims landed, appends a `SOURCE_COMMITTED` audit event per involved intent — a human-readable forward pointer in the audit trail ("this commit carried these units"). It is strictly **enrichment**: resolve never reads anchors, so a repository whose users only ever commit manually and never run `anchor` loses nothing but audit-trail readability.

Fields: `Commit`, `Repo` (recorded selector or `-` for the workspace root), `Units` (comma-separated, sorted), `Attributed Paths` (count), `Observed` (`session` for a direct invocation, `reconciled` for a history sweep). Semantics:

- **Deduplicated** per intent on `(commit, repo)` — re-anchoring an already-anchored commit is reported as skipped, not duplicated.
- **Swarm-aware** — a commit already bound by a `SWARM_SOURCE_MERGED` event's `Merge commit` is skipped (the swarm referee already anchored it with richer context).
- **Bounded reconciliation** — `--reconcile` walks first-parent history until it hits already-anchored territory, capped by `--max-commits` (default 100), reporting each commit as anchored, skipped, or unattributed.
- **CLI-protected** — `SOURCE_COMMITTED` is in `CLI_PROTECTED_EVENT_TYPES` (`aidlc-audit.ts`): only the owning tool appends it through the library path; agents cannot fabricate one via the audit CLI. It is *not* merge-protected — shard merges carry it like any other event.

Anchoring on the orchestrate tick (automatically anchoring fresh commits during a session) is deliberately **deferred**: v1 keeps `anchor` an explicit verb so the enrichment/foundation boundary stays observable before any automation is layered on.

## 7. Guarantees and edge cases

- **Squash/rebase stability.** Attribution keys on blob content (OIDs), not commit ancestry — a reviewed change that lands squashed with others still verifies, and re-landing a reverted file back to its reviewed bytes returns it to `verified`.
- **Pre-upgrade records.** Records reviewed before evidence dual-write have no committed evidence; resolution falls back to the local snapshot on the authoring machine, and is honestly `unverifiable` in a bare CI clone — fail closed, with the reason stating what is missing.
- **LFS/clean-filter fidelity.** Listings for arbitrary commits come from `gitCommitSourceListing` (exported from `aidlc-lib.ts`), which applies the same exclusion and clean-filter semantics as the review-time snapshot — a raw `git ls-tree` would report smudged LFS blobs as drift.
- **Tamper asymmetry.** Committed evidence is redundant with the local snapshot wherever both exist; corruption of either alone never flips a `verified` path, and corruption of both can only *fail* (never falsely verify), because verification requires bytes that hash to the receipt fingerprint.

## 8. Limits

- Resolution classifies *landed content* against *reviewed content*. It cannot show a reviewed-vs-actual **diff** for drifted paths without the reviewed blobs being reachable (the evidence records OIDs, not file bodies); teams wanting the diff must push refs that keep reviewed blobs alive or store them out of band.
- One repo per invocation; a workspace-spanning report is a loop over `--repo` selectors.
- `--fail-on` gates on path status only; policy such as "unattested is fine under `docs/`" belongs in the pipeline around the exit code, not in the tool.

## 9. File and test map

| Surface | Location |
|---------|----------|
| Resolver + anchor CLI | `tools/aidlc-attest.ts` (dispatcher route: `aidlc attest …`) |
| Evidence write/parse/exclusion library | `aidlc-lib.ts` — `writeUnitSourceSnapshot`, `reviewedSourceEvidencePath`, `parseUnitSourceListing`, `serializeSourceListing`, `normalizeManifestSourcePath`, `sourcePathIsExcluded`, `gitCommitSourceListing` |
| Event registration | `aidlc-audit.ts` (`SOURCE_COMMITTED` in `VALID_EVENT_TYPES` + `CLI_PROTECTED_EVENT_TYPES`), registry in `knowledge/aidlc-shared/audit-format.md` |
| Tests | `tests/unit/t311-committed-reviewed-source-evidence.test.ts` (evidence grammar, dual-write, exclusion), `tests/unit/t312-attest-resolve-anchor.test.ts` (resolve flows, fallback, indeterminate, anchor) |
