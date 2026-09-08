# Commit Provenance

> Audience: Tier 2/3 (team adopter, framework contributor).

This chapter is the canonical reference for the **commit provenance** subsystem: the durable reverse lookup from an arbitrary git commit or diff range to the reviewed units of work that own its changed paths. It has three parts — **committed reviewed-source evidence** (a snapshot of what a reviewer approved, written into the intent record so it travels with every clone), the read-only resolver **`aidlc attest resolve`** (attribution + drift classification, built to run in CI), and the **`SOURCE_COMMITTED`** audit anchor (**enrichment only** — the resolver never reads it; written automatically by the session-start hook's bounded sweep, or explicitly via `aidlc attest anchor`). Cross-link to [State Machine](12-state-machine.md) (the event taxonomy `SOURCE_COMMITTED` joins), [Hooks and Tools](06-hooks-and-tools.md) (the `aidlc-attest.ts` tool entry), the audit format registry (`knowledge/aidlc-shared/audit-format.md`), and the user-facing command walkthrough in [Guide: CLI Commands](../guide/12-cli-commands.md).

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

Ownership follows the same receipt semantics the engine uses at completion: for each unit, the **newest READY `REVIEW_COMPLETED`** receipt (one carrying `Verdict: READY`, `Unit`, `Stage`, and `Unit Source Fingerprint`) is authoritative. Receipts are ordered by timestamp, then position within a shard, then shard index; two READY receipts for the same unit with the same timestamp in *different* shards cannot be ordered and fail closed (`indeterminate`, §5). A path claimed by several units belongs to the newest claimant — the same "a newer reviewed claim can own an intentional shared-file integration" rule completion applies — and when two claimants share the newest timestamp, "newest" names no single owner, so that path also fails closed as `indeterminate` rather than resolving by name order.

Per owning receipt, path claims come from the strongest available source, in order:

| `claimsSource` | Meaning |
|----------------|---------|
| `manifest` | The unit's `source-manifest.json` hashes to the manifest digest recorded in the evidence header — full claim fidelity, including directory-prefix claims (`src/generated/`) |
| `evidence-only` | No verifiable manifest; claims fall back to the exact path keys in the evidence listing (prefix claims are lost — a new file under a claimed directory shows as `unattested`) |
| `manifest-unverified` | A manifest exists but cannot be verified against evidence (e.g. the evidence is missing); paths still attribute, but content cannot be checked |

## 4. Committed reviewed-source evidence

At review time, the engine dual-writes the unit's reviewed-source snapshot:

- **Committed evidence** (new, authoritative for CI): `<record>/construction/<unit>/<stage>/reviewed-source-<hash12>.tsv` inside the intent record, where `<hash12>` is the first 12 hex digits of the fingerprint. Because the record is committed, the evidence travels with every clone.
- **Local snapshot** (pre-existing): `<record>/.aidlc-source-review/<stage>/unit-<unit>-<hash12>.tsv`, machine-local (ignored), retained for the completion-time freshness checks. It is **not** a verification source for resolution (§5) — honouring gitignored bytes would make a verdict depend on which machine ran it.

Units reviewed inside a swarm worktree carry both files out of it: the reviewed-record snapshot that finalization transfers into the main record (`captureReviewedRecordSnapshot` / `mergeReviewedRecordSnapshot` in `aidlc-swarm.ts`) includes the unit's `source-manifest.json` **and** its `reviewed-source-<hash12>.tsv`, hash-checked against the receipt fingerprint before transfer and written in the same all-or-nothing transaction as the record artifacts. A swarm-built unit therefore resolves exactly like an inline one; if the evidence is absent or altered in the worktree, finalization fails closed rather than landing a claim nothing can verify.

Both files hold **byte-identical content**, and the receipt's `Unit Source Fingerprint` is the SHA-256 of exactly those bytes — there is no second fingerprint scheme; committing the evidence introduced **zero new fingerprint semantics**. Writes are content-addressed: rewriting the same fingerprint is an idempotent no-op, and a write that finds different bytes at the same address refuses (`address collision or corruption`).

The file format (`parseUnitSourceListing` / `serializeSourceListing` in `aidlc-lib.ts`) is a strict TSV grammar:

```
manifest\t<sha256-of-manifest-bytes>\t-\n
<repo>\t<path>\t<mode>\t<oid>\n        # zero or more rows, sorted by key
```

The header binds the manifest bytes; each row records a claimed path's repo selector (empty for the workspace root), path, git file mode (`/^\d{6}$/`), and blob OID (40–64 hex). `\t`, `\n`, `\r`, and `\\` in fields are backslash-escaped; duplicate keys, missing trailing newline, or any malformed field reject the whole file (parser returns null → the evidence is treated as absent). An empty listing after a valid header is valid (a unit whose review claimed no surviving paths).

## 5. Resolution — `aidlc attest resolve`

```
aidlc attest resolve [<commit>|--commit <rev>] [--diff <base>..<head>]
                     [--repo <name>] [--space <name>] [--intent <dir>]
                     [--fail-on <statuses>]
```

Read-only — resolve never writes, never emits audit events, and never reads `SOURCE_COMMITTED` anchors. Modes: a single `<commit>` (positional or `--commit <rev>`, not both) resolves that commit's first-parent delta (default `HEAD`); `--diff <base>..<head>` resolves the range endpoints directly, and the three-dot form `<base>...<head>` uses the merge base. Each verb accepts only its own flags — `resolve --reconcile` and `anchor --diff` are usage errors (exit 1), never silently ignored. A commit whose parent is missing because the clone is shallow is an error, not a whole-tree diff (§8). Every changed path in the delta is classified:

| Status | Meaning | Failable |
|--------|---------|:--------:|
| `verified` | Owned by a reviewed unit and the committed blob OID matches the reviewed evidence | — |
| `drifted` | Owned by a reviewed unit but the committed content differs from what was reviewed | ✓ |
| `unattested` | No reviewed unit claims the path | ✓ |
| `unverifiable` | A receipt claims the path but no committed bytes bind its content: evidence missing, not hashing to the receipt fingerprint, or present only in the gitignored local snapshot — **fail closed**, never silently verified | ✓ |
| `indeterminate` | Receipt ordering is ambiguous — same-timestamp READY receipts in different shards, or in different records both claiming the path — **fail closed** | ✓ |
| `excluded` | Framework shell (`aidlc/` / `.aidlc/` when the repo carries it), nested `.aidlc-sensors/` dirs under intent records, and — in a repo that carries the workspace shell — that harness's shell directories (`.claude/`, `.kiro/`, …) — never attributed, never failable | — |

`--fail-on` takes a comma-separated subset of the four failable statuses; a match exits **3** (0 = resolved clean or nothing matched, 1 = usage/environment error). A gate that omits `unverifiable` passes paths whose reviewed content nothing could check, so the CI form names all four. The report is JSON on stdout: `paths[]` (per-path status/unit/intent/reason), `units[]` (owning receipt detail — stage, iteration, `evidenceSource`, `claimsSource`, recorded bypasses, and `fullyLanded`: whether every claimed path landed at its reviewed OID in `head`), a `summary` count per status, the echoed `failOn`, `recordSource` (where receipts were read from — today always `worktree`), and `warnings[]`.

`warnings[]` names conditions that can distort the whole report without changing any single path's classification, so they never fail the gate on their own: repository byte-form conversion (`core.autocrlf`, `.gitattributes` — see §8), and an intent record whose working-tree state differs from the queried commit (receipts are read from the working tree, so that checkout can resolve differently than a clone of `head` would).

Evidence per unit must be **committed** to verify (`evidenceSource: "committed"`). The legacy local snapshot is still located and reported (`evidenceSource: "local"`) as a diagnostic — it tells you the review happened on this machine before dual-write existed — but its bytes never verify a path: those units are `unverifiable` with a reason pointing at the re-review that would commit evidence. This keeps one verdict per commit regardless of which machine asks. Multi-root workspaces resolve one repo per invocation: the workspace root by default, or a recorded repo by `--repo <name>` (required when the project dir itself is not a git repository).

## 6. Anchors — `SOURCE_COMMITTED` (enrichment only)

```
aidlc attest anchor [--commit <rev>] [--reconcile] [--max-commits <n>]
                    [--repo <name>] [--space <name>] [--intent <dir>]
```

`anchor` runs resolution for a commit (default `HEAD`) and, when reviewed claims landed, appends a `SOURCE_COMMITTED` audit event per involved intent — a human-readable forward pointer in the audit trail ("this commit carried these units"). It is strictly **enrichment**: resolve never reads anchors, so a repository whose users only ever commit manually and never run `anchor` loses nothing but audit-trail readability.

Fields: `Commit`, `Repo` (recorded selector or `-` for the workspace root), `Units` (comma-separated, sorted), `Attributed Paths` (count), `Observed` (`session` for a direct invocation, `reconciled` for a history sweep). Semantics:

- **Deduplicated** per intent on `(commit, repo)` — re-anchoring an already-anchored commit is reported as skipped, not duplicated.
- **Swarm-aware** — a commit already bound by a `SWARM_SOURCE_MERGED` event's `Merge commit` is skipped (the swarm referee already anchored it with richer context).
- **Bounded reconciliation** — `--reconcile` walks the last `--max-commits` first-parent commits (default 100) regardless of prior anchors — dedupe is per commit, so an unanchored gap behind already-anchored territory still backfills — reporting each commit as anchored, skipped, unattributed, or a shallow `boundary`.
- **Shallow-safe** — a boundary commit of a shallow clone has no reachable parent, so its delta is unknowable. A single-commit `anchor` on one errors out; `--reconcile` lists it under `boundaries[]` and moves on, rather than attributing the whole tree to every unit that ever claimed a path in it.
- **Ambiguity-quiet** — paths whose ownership is ambiguous (§5 `indeterminate`) are not anchored; reporting the ambiguity is resolve's job.
- **CLI-protected** — `SOURCE_COMMITTED` is in `CLI_PROTECTED_EVENT_TYPES` (`aidlc-audit.ts`): only the owning tool appends it through the library path; agents cannot fabricate one via the audit CLI. It is *not* merge-protected — shard merges carry it like any other event.

Anchoring is automatic in the workflow: the session-start hook (`hooks/aidlc-session-start.ts`) runs a best-effort `runAnchor` reconcile sweep (bound: 25 commits) on every real session start — humans commit mostly *between* sessions, so the next session start is the natural observation point, and per-intent dedupe makes the every-session re-run idempotent. The sweep never blocks startup (failures such as a non-git workspace are swallowed; a missed sweep self-heals next session because anchors are enrichment, not foundation) and is skipped on compact resumes and rebind probes; `AIDLC_SKIP_SESSION_ANCHOR=1` disables it. The explicit `anchor` verb remains for CI checkouts, harnesses with hooks disabled, and history backfills deeper than the session bound (`--max-commits`, default 100).

## 7. Guarantees and edge cases

- **Squash/rebase stability.** Attribution keys on blob content (OIDs), not commit ancestry — a reviewed change that lands squashed with others still verifies, and re-landing a reverted file back to its reviewed bytes returns it to `verified`.
- **Pre-upgrade records.** Records reviewed before evidence dual-write have no committed evidence; they are `unverifiable` everywhere — on the authoring machine exactly as in a bare CI clone — until their next per-unit review dual-writes evidence. Fail closed, with the reason stating what is missing.
- **One exclusion implementation.** Listings for arbitrary commits come from `gitCommitSourceListing` (exported from `aidlc-lib.ts`), so the commit side and the review side share a single exclusion implementation rather than two copies that drift. They do **not** share byte-form semantics — see §8.
- **Tamper asymmetry.** Verification requires bytes that hash to the receipt's `Unit Source Fingerprint`, so corrupting evidence can only *fail* a path (`unverifiable`), never falsely verify one. Corrupting the committed evidence is not masked by the intact local copy, because local bytes do not verify.

## 8. Limits

- Resolution classifies *landed content* against *reviewed content*. It cannot show a reviewed-vs-actual **diff** for drifted paths without the reviewed blobs being reachable (the evidence records OIDs, not file bodies); teams wanting the diff must push refs that keep reviewed blobs alive or store them out of band.
- One repo per invocation; a workspace-spanning report is a loop over `--repo` selectors.
- `--fail-on` gates on path status only; policy such as "unattested is fine under `docs/`" belongs in the pipeline around the exit code, not in the tool.
- **Working-tree vs. repository byte form.** Review evidence hashes working-tree bytes (`stableFileSha256`); commit-side listings read raw repository blobs with checkout filters deliberately disabled. Where a clean/smudge filter, `core.autocrlf`, or a working-tree encoding is active — Git LFS, or a Windows checkout with the default `autocrlf=true` — the two sides hash the same content differently and unchanged paths report `drifted`. Submodule gitlinks (mode `160000`) have no listing entry at all. `resolve` flags the detectable causes in `warnings[]`; repositories that use those features need the byte forms reconciled before the gate is usable. Unifying them changes fingerprint inputs, so it is a separate change (see `docs/roadmap.md`).
- **Shallow clones.** `resolve <commit>` and single-commit `anchor` refuse a shallow boundary commit with an actionable error (deepen the clone; `fetch-depth: 0` in CI) rather than diffing against the root tree and classifying the whole checkout; `anchor --reconcile` records such commits in `boundaries[]`. Ranges resolved with `--diff` need both endpoints and their merge base present.
- **The record is read from the working tree, not from `head`.** Receipts, manifests, and evidence come from the checkout on disk, so a checkout whose record differs from the queried commit resolves against different receipts than a clone of that commit would. CI resolves at the checked-out commit and is unaffected; a local `resolve <old-commit>` with newer record state is not, and gets a `warnings[]` entry. Reading the record out of `head`'s tree is the durable fix, and is blocked for layouts where the record is not inside the queried repo (see `docs/roadmap.md`).

## 9. File and test map

| Surface | Location |
|---------|----------|
| Resolver + anchor CLI | `tools/aidlc-attest.ts` (dispatcher route: `aidlc attest …`) |
| Automatic anchoring | `hooks/aidlc-session-start.ts` (bounded best-effort reconcile sweep on session start; `AIDLC_SKIP_SESSION_ANCHOR=1` disables) |
| Evidence write/parse/exclusion library | `aidlc-lib.ts` — `writeUnitSourceSnapshot`, `reviewedSourceEvidencePath`, `parseUnitSourceListing`, `serializeSourceListing`, `normalizeManifestSourcePath`, `sourcePathIsExcluded`, `gitCommitSourceListing` |
| Swarm evidence transport | `aidlc-swarm.ts` — `captureReviewedRecordSnapshot` (hash-checks the worktree's manifest + evidence) / `mergeReviewedRecordSnapshot` (transactional write into the main record) |
| Event registration | `aidlc-audit.ts` (`SOURCE_COMMITTED` in `VALID_EVENT_TYPES` + `CLI_PROTECTED_EVENT_TYPES`), registry in `knowledge/aidlc-shared/audit-format.md` |
| Tests | `tests/unit/t311-committed-reviewed-source-evidence.test.ts` (evidence grammar, dual-write, exclusion), `tests/unit/t312-attest-resolve-anchor.test.ts` (resolve flows, fallback, indeterminate, anchor, the session-start hook sweep) |
