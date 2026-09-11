# Commit Provenance

> Audience: Tier 2/3 (team adopter, framework contributor).

This chapter is the canonical reference for the **commit provenance** subsystem: the durable reverse lookup from an arbitrary git commit or diff range to the reviewed units of work that own its changed paths. It has three parts — **committed reviewed-source evidence** (a snapshot of what a reviewer approved, written into the intent record so it travels with every clone), the read-only resolver **`aidlc attest resolve`** (attribution, drift classification, and a stated trust basis), and the **`SOURCE_COMMITTED`** audit anchor (**enrichment only** — the resolver never reads it; written by `aidlc attest anchor`, or by an opt-in session-start sweep). Cross-link to [State Machine](12-state-machine.md) (the event taxonomy `SOURCE_COMMITTED` joins), [Hooks and Tools](06-hooks-and-tools.md) (the `aidlc-attest.ts` tool entry), the audit format registry (`knowledge/aidlc-shared/audit-format.md`), and the user-facing command walkthrough in [Guide: CLI Commands](../guide/12-cli-commands.md).

---

## 1. The problem

Code Generation already binds each reviewed unit to the exact source it reviewed: the per-unit `REVIEW_COMPLETED` receipt carries a `Unit Source Fingerprint` over the unit's claimed paths and manifest bytes (see [Guide: State and Audit — source-bound review receipts](../guide/10-state-and-audit.md#source-bound-review-receipts)). What was missing is the *other direction*: given a commit that lands later — often squashed, rebased, or bundled with unrelated changes — which reviewed unit (and intent) owns each changed path, and does the committed content still match what was reviewed? Without that lookup, nothing downstream of the commit — a pipeline, an auditor, a release note, a person reading history a year later — can answer "does every source change here trace to a reviewed unit?"

## 2. Threat model

Resolution answers two questions that are routinely conflated, and the distinction is the whole design:

- **Integrity** — *do the bytes that landed equal the bytes some receipt approved?* Answered unconditionally, from content alone. Verification requires bytes hashing to the receipt's `Unit Source Fingerprint`, so tampering can only move a path to `drifted`/`unverifiable`; it can never falsely verify one.
- **Authenticity** — *was that receipt produced by a review that actually happened?* **Not** answered by the record layout. Receipts, manifests, and evidence are ordinary files in the repository, so anyone who can write to the repository can write a receipt — including in the same change set as the source it approves. Nothing on disk distinguishes that from a genuine review.

So the report never asserts more than it checked. Every report carries a `trust{}` object naming the actual basis of its own attribution, on a four-rung ladder:

| `trust.level` | What it means | What it rules out |
|---------------|---------------|-------------------|
| `informational` | The record was read from the **working tree** — a local diagnostic that a clone of the same commit may not reproduce. Only reachable when the record provably cannot live inside the queried repository (§10). | Nothing. |
| `reproducible` | The record was read from a **git tree**, so the same `(base, head)` resolves identically in any clone, forever — but the queried range itself writes record paths (`trust.selfAttested`), so the change may have authored the receipts judging it. | Non-determinism. Post-hoc edits to the record cannot change a past report. |
| `independent` | Reproducible, **and** the receipts relied on did not come from the change under test — either the range touches no record path, or `--record-ref` pinned a record source the change cannot write. | Self-approval. A change cannot manufacture its own verdict. |
| `signed` | Independent, **and** every authority-bearing input the verdict rests on arrived in a **signed** commit — for each relied-upon unit, both the audit shard carrying its receipt **and** the evidence file that receipt's fingerprint selects (git `%G?` in `G`/`U`; the raw codes are reported per input in `trust.signatures`, at least one of which must exist). | Anonymous record writes. Each approval names a key. |

Two anchors — both supplied by the **verifier**, not by the change — move a report up the ladder:

- **`--record-ref <ref>`** reads receipts, manifests, and evidence from `<ref>`'s tree instead of the queried commit's. Point it at something the change under test cannot move: a protected branch, a records-only ref, a mirror maintained by the review system. This is what makes `independent` meaningful, and it is what strips a self-written approval — with the record pinned, the fabricated receipt simply is not in the record source, and its paths report `drifted` or `unattested`.
- **`--require-trust <level>`** turns the level into a gate: exit **3** unless the achieved level reaches it (shared with `--fail-on`).

**In scope.** Content drift after review (`drifted`); missing, mismatched, or gitignored-only evidence (`unverifiable`, fail closed); receipt ordering that names no single owner (`indeterminate`, fail closed); an unsigned receipt selecting evidence that *is* signed (`signed` covers the receipt too, so the level falls back to `independent`); a change that writes its own approving receipt (capped at `reproducible`, and eliminated by `--record-ref`); a checkout whose record differs from the queried commit (impossible to influence a report — the record is read from a tree, §4); post-hoc rewriting of the record to change an old verdict (impossible for the same reason).

**Out of scope.** Anyone who can write to the pinned record ref, or forge the signatures on record commits, can produce receipts the resolver will honour — establishing *who may write approvals* is the hosting platform's job (branch protection, required signatures, review gates), not this tool's. A review that happened but was careless is still a review. And resolution says nothing about whether the reviewed unit was the *right* unit.

**Default posture.** Without either anchor, a report is **informational metadata**: accurate about integrity, silent about authority. It becomes an **enforcement mechanism** only when the verifier names a trust root and demands a level. That choice belongs to whoever runs the check, which is why it is a flag and not a built-in policy — and why `trust{}` is always in the output, so a stored report can never be read as stronger than the anchor that produced it.

## 3. Design constraints

Three constraints shape the rest of the design; each rules out a familiar mechanism:

1. **Most commits are manual.** Users commit with plain `git commit`, from any machine, at any time — often long after the session that produced the change. Hooks and session-time capture therefore cannot be the *foundation*; anything session-observed is at best enrichment.
2. **A fingerprint alone does not name the unit.** The receipt's `Unit Source Fingerprint` proves *what* was reviewed, but a verifier starting from a bare clone and a commit range has no way to go from changed paths to that receipt without an explicit, committed attribution structure.
3. **Commit messages are not a channel.** Teams own their commit formats; trailers, ticket prefixes, and message conventions cannot be relied on and are never parsed.

## 4. The attribution model

Attribution is a **pure function of committed content**: the commit's tree plus a *git tree* of the intent record (audit shards, unit `source-manifest.json`, and the committed evidence below). Nothing depends on the working tree, on local state, on refs beyond the ones being resolved, on hooks having fired, on environment variables, or on message text. Two consequences:

- **Any clone can resolve.** A bare checkout with only the commits under test produces the identical report as the authoring machine.
- **Determinism.** The same `(base, head)` pair always yields the same attribution, and continues to years later. Reviewing more units, amending the record, or editing evidence in the checkout cannot retroactively change what an earlier commit resolves to. The same applies to *exclusion*: harness shells are established by a committed `<dir>/tools/data/harness.json` in the range's base tree, so installing or uninstalling a harness in a checkout cannot flip a past commit's `.claude/**` paths between `excluded` and `unattested`, and a change cannot declare its own exclusions.

The record source defaults to the queried head's own tree and is overridden by `--record-ref` (§2). Reading it from a tree is what makes the two properties above true; the working tree is consulted only in the one layout where the record cannot be in the queried repository at all (a multi-root workspace whose record root sits outside the repo under test), and that report is `informational` and carries a `warnings[]` entry saying so.

Ownership follows the same receipt semantics the engine uses at completion: for each unit, the **newest READY `REVIEW_COMPLETED`** receipt (one carrying `Verdict: READY`, `Unit`, `Stage`, and `Unit Source Fingerprint`) is authoritative. Receipts are ordered by timestamp, then position within a shard, then shard index; two READY receipts for the same unit with the same timestamp in *different* shards cannot be ordered and fail closed (`indeterminate`, §6). A path claimed by several units belongs to the newest claimant — the same "a newer reviewed claim can own an intentional shared-file integration" rule completion applies — and when two claimants share the newest timestamp, "newest" names no single owner, so that path also fails closed as `indeterminate` rather than resolving by name order.

Per owning receipt, path claims come from the strongest available source, in order:

| `claimsSource` | Meaning |
|----------------|---------|
| `manifest` | The unit's `source-manifest.json` hashes to the manifest digest recorded in the evidence header — full claim fidelity, including directory-prefix claims (`src/generated/`) |
| `evidence-only` | No verifiable manifest; claims fall back to the exact path keys in the evidence listing (prefix claims are lost — a new file under a claimed directory shows as `unattested`) |
| `manifest-unverified` | A manifest exists but cannot be verified against evidence (e.g. the evidence is missing); paths still attribute, but content cannot be checked |

## 5. Committed reviewed-source evidence

At review time, the engine dual-writes the unit's reviewed-source snapshot:

- **Committed evidence** (authoritative for resolution): `<record>/construction/<unit>/<stage>/reviewed-source-<hash12>.tsv` inside the intent record, where `<hash12>` is the first 12 hex digits of the fingerprint. Because the record is committed, the evidence travels with every clone.
- **Local snapshot** (pre-existing): `<record>/.aidlc-source-review/<stage>/unit-<unit>-<hash12>.tsv`, machine-local (ignored), retained for the completion-time freshness checks. It is **not** a verification source for resolution (§6) — honouring gitignored bytes would make a verdict depend on which machine ran it.

Units reviewed inside a swarm worktree carry both files out of it: the reviewed-record snapshot that finalization transfers into the main record (`captureReviewedRecordSnapshot` / `mergeReviewedRecordSnapshot` in `aidlc-swarm.ts`) includes the unit's `source-manifest.json` **and** its `reviewed-source-<hash12>.tsv`, hash-checked against the receipt fingerprint before transfer and written in the same all-or-nothing transaction as the record artifacts. A swarm-built unit therefore resolves exactly like an inline one; if the evidence is absent or altered in the worktree, finalization fails closed rather than landing a claim nothing can verify.

Both files hold **byte-identical content**, and the receipt's `Unit Source Fingerprint` is the SHA-256 of exactly those bytes — there is no second fingerprint scheme; committing the evidence introduced **zero new fingerprint semantics**. Writes are content-addressed: rewriting the same fingerprint is an idempotent no-op, and a write that finds different bytes at the same address refuses (`address collision or corruption`).

The file format (`parseUnitSourceListing` / `serializeSourceListing` in `aidlc-lib.ts`) is a strict TSV grammar:

```
manifest\t<sha256-of-manifest-bytes>\t-\n
<repo>\t<path>\t<mode>\t<oid>\n        # zero or more rows, sorted by key
```

The header binds the manifest bytes; each row records a claimed path's repo selector (empty for the workspace root), path, git file mode (`/^\d{6}$/`), and blob OID (40–64 hex). `\t`, `\n`, `\r`, and `\\` in fields are backslash-escaped; duplicate keys, missing trailing newline, or any malformed field reject the whole file (parser returns null → the evidence is treated as absent). An empty listing after a valid header is valid (a unit whose review claimed no surviving paths).

## 6. Resolution — `aidlc attest resolve`

```
aidlc attest resolve [<commit>|--commit <rev>] [--diff <base>..<head>]
                     [--repo <name>] [--space <name>] [--intent <dir>]
                     [--record-ref <ref>] [--require-trust <level>]
                     [--fail-on <statuses>]
```

Read-only — resolve never writes, never emits audit events, and never reads `SOURCE_COMMITTED` anchors. Modes: a single `<commit>` (positional or `--commit <rev>`, not both) resolves that commit's first-parent delta (default `HEAD`); `--diff <base>..<head>` resolves the range endpoints directly, and the three-dot form `<base>...<head>` uses the merge base. Each verb accepts only its own flags — `resolve --reconcile` and `anchor --record-ref` are usage errors (exit 1), never silently ignored. A commit whose parent is missing because the clone is shallow is an error, not a whole-tree diff (§10). Every changed path in the delta is classified:

| Status | Meaning | Failable |
|--------|---------|:--------:|
| `verified` | Owned by a reviewed unit and the committed blob OID matches the reviewed evidence | — |
| `drifted` | Owned by a reviewed unit but the committed content differs from what was reviewed | ✓ |
| `unattested` | No reviewed unit claims the path | ✓ |
| `unverifiable` | A receipt claims the path but no committed bytes bind its content: evidence missing from the record source, not hashing to the receipt fingerprint, or present only in the gitignored local snapshot — **fail closed**, never silently verified | ✓ |
| `indeterminate` | Receipt ordering is ambiguous — same-timestamp READY receipts in different shards, or in different records both claiming the path — **fail closed** | ✓ |
| `excluded` | Framework shell (`aidlc/` / `.aidlc/` when the repo carries it), nested `.aidlc-sensors/` dirs under intent records, and — in a repo that carries the workspace shell — harness shell directories already established in the range's base tree (`.claude/`, `.kiro/`, …, identified by a committed `<dir>/tools/data/harness.json`). A manifest introduced by the head cannot exclude itself or its siblings — never attributed, never failable | — |

`--fail-on` takes a comma-separated subset of the four failable statuses; a match exits **3** (0 = resolved clean or nothing matched, 1 = usage/environment error). A gate that omits `unverifiable` passes paths whose reviewed content nothing could check, so a strict gate names all four. `--require-trust <level>` also exits 3 when the achieved `trust.level` falls short (§2); the two flags are orthogonal — `--fail-on` bounds *how much of the change is attested*, `--require-trust` bounds *how much the report can be trusted*.

The report is JSON on stdout: `paths[]` (per-path status/unit/intent/reason), `units[]` (owning receipt detail — stage, iteration, `evidenceSource`, `claimsSource`, recorded bypasses, `evidenceCommit`/`evidenceSignature` for the commit that last wrote the evidence, `receipt`/`receiptCommit`/`receiptSignature` for the audit shard that carried the winning receipt and the commit that last wrote *it*, and `fullyLanded`: whether every claimed path landed at its reviewed OID in `head`), a `summary` count per status, the echoed `failOn`, `trust{}` (§2 — `level`, `required`, `satisfied`, `recordSource`, `recordRef`, `recordCommit`, `recordPinned`, `recordPathsChangedInRange`, `selfAttested`, `signatures[]`), and `warnings[]`.

`warnings[]` names conditions that can distort the whole report without changing any single path's classification, so they never fail the gate on their own: repository byte-form conversion (`core.autocrlf`, `.gitattributes` — see §10), a record source that carries no committed intent record at all (so nothing can attribute, which otherwise reads identically to "nothing is attested"), and a fallback to working-tree records (§4).

Evidence per unit must be **committed** to verify (`evidenceSource: "committed"`). The legacy local snapshot is still located and reported (`evidenceSource: "local"`) as a diagnostic — it tells you the review happened on this machine before dual-write existed — but its bytes never verify a path: those units are `unverifiable` with a reason pointing at the re-review that would commit evidence. This keeps one verdict per commit regardless of which machine asks. Multi-root workspaces resolve one repo per invocation: the workspace root by default, or a recorded repo by `--repo <name>` (required when the project dir itself is not a git repository).

## 7. Anchors — `SOURCE_COMMITTED` (enrichment only)

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
- **Ambiguity-quiet** — paths whose ownership is ambiguous (§6 `indeterminate`) are not anchored; reporting the ambiguity is resolve's job.
- **CLI-protected** — `SOURCE_COMMITTED` is in `CLI_PROTECTED_EVENT_TYPES` (`aidlc-audit.ts`): only the owning tool appends it through the library path; agents cannot fabricate one via the audit CLI. It is *not* merge-protected — shard merges carry it like any other event.
- **Working-tree records** — `anchor` reads the record from the working tree by design: it observes the local repository as it is now, and its output is enrichment that no verdict depends on. Only `resolve` needs the tree-read determinism of §4.

Anchoring is **explicit by default**. Because anchors are enrichment that resolution never reads, writing them is an act the operator asks for: `aidlc attest anchor [--reconcile]`. Teams that would rather the audit trail name landed commits without remembering a command can opt in to a session-start sweep by setting **`AIDLC_SESSION_ANCHOR=1`**: the session-start hook (`hooks/aidlc-session-start.ts`) then runs a best-effort `runAnchor` reconcile bounded to 25 commits on real session starts (humans commit mostly *between* sessions, so the next session start is the natural observation point). Per-intent dedupe makes the every-session re-run idempotent; the sweep never blocks startup (failures such as a non-git workspace are swallowed) and is skipped on compact resumes and rebind probes. With the switch unset — the default — a session start writes no audit rows and does no provenance work at all. The explicit verb remains the way to anchor a fresh checkout, a harness with hooks disabled, or history deeper than the session bound (`--max-commits`, default 100).

## 8. Guarantees and edge cases

- **Squash/rebase stability.** Attribution keys on blob content (OIDs), not commit ancestry — a reviewed change that lands squashed with others still verifies, and re-landing a reverted file back to its reviewed bytes returns it to `verified`.
- **Pre-upgrade records.** Records reviewed before evidence dual-write have no committed evidence; they are `unverifiable` everywhere — on the authoring machine exactly as in a bare clone — until their next per-unit review dual-writes evidence. Fail closed, with the reason stating what is missing.
- **One exclusion implementation.** Listings for arbitrary commits come from `gitCommitSourceListing` (exported from `aidlc-lib.ts`), so the commit side and the review side share a single exclusion implementation rather than two copies that drift; the harness-shell rule (`isHarnessShellManifest`) is likewise one function, applied to a tree blob here and to a file on disk at review time. They do **not** share byte-form semantics — see §10.
- **Tamper asymmetry.** Verification requires bytes that hash to the receipt's `Unit Source Fingerprint`, so corrupting evidence can only *fail* a path (`unverifiable`), never falsely verify one. Corrupting the committed evidence is not masked by the intact local copy, because local bytes do not verify. Corrupting it in the *checkout* is inert: the bytes that count are the blob in the record tree.
- **Record reads are one pair of git calls.** The tree-backed record view lists the record subtree once (`git ls-tree -r -z --full-tree`) and batches every blob it needs through a single `git cat-file --batch`, so reading the record out of history costs about what reading it off disk did.

## 9. Trust setups

Two shapes cover most teams:

- **Records on a protected branch.** The review system pushes record commits to a ref only it can move (`refs/heads/aidlc-records`, or a mirror). Verifiers run `resolve --diff <base>..<head> --record-ref aidlc-records --require-trust independent --fail-on drifted,unattested,unverifiable,indeterminate`. A change that writes its own receipts gains nothing: its receipts are not in the pinned tree.
- **Records alongside the change, signed.** Records live in the same repository and land with the change, but record commits are signed and the branch requires signatures. `--require-trust signed` then holds only when every relied-upon input — receipt shards as well as evidence files — arrived in a signed commit. Note that a change author who can sign can still self-approve — signatures name a key, they do not separate roles — so this shape suits attribution and non-repudiation, and the pinned-ref shape suits separation of duties. Combine them for both.

Running with neither anchor is a legitimate third shape: `resolve` is then a reporting tool that tells you what landed and whether it matches review, with `trust.level` documenting exactly that limit.

## 10. Limits

- **The trust root is not established here.** `resolve` reports the provenance of the record it read (`trust{}`); making a ref trustworthy is branch protection, signing policy, and access control on the hosting platform (§2, out of scope).
- **Signatures are commit-level.** `%G?` on the commit that last wrote each authority-bearing file — the receipt's audit shard and the evidence file it selects — is the strongest available signal; there is no per-approval signature, and no notion of *which* identities may approve — a valid signature from any key that git accepts (`G`, or `U` for a valid signature from an untrusted key) counts as signed. Configure the keyring, and read `trust.signatures[]` when the distinction matters.
- Resolution classifies *landed content* against *reviewed content*. It cannot show a reviewed-vs-actual **diff** for drifted paths without the reviewed blobs being reachable (the evidence records OIDs, not file bodies); teams wanting the diff must push refs that keep reviewed blobs alive or store them out of band.
- One repo per invocation; a workspace-spanning report is a loop over `--repo` selectors.
- `--fail-on` gates on path status only; policy such as "unattested is fine under `docs/`" belongs in the pipeline around the exit code, not in the tool.
- **Working-tree vs. repository byte form.** Review evidence hashes working-tree bytes (`stableFileSha256`); commit-side listings read raw repository blobs with checkout filters deliberately disabled. Where a clean/smudge filter, `core.autocrlf`, or a working-tree encoding is active — Git LFS, or a Windows checkout with the default `autocrlf=true` — the two sides hash the same content differently and unchanged paths report `drifted`. Submodule gitlinks (mode `160000`) have no listing entry at all. `resolve` flags the detectable causes in `warnings[]`; repositories that use those features need the byte forms reconciled before a gate is usable. Unifying them changes fingerprint inputs, so it is a separate change (see `docs/roadmap.md`).
- **Shallow clones.** `resolve <commit>` and single-commit `anchor` refuse a shallow boundary commit with an actionable error (deepen the clone; `fetch-depth: 0` in a pipeline) rather than diffing against the root tree and classifying the whole checkout; `anchor --reconcile` records such commits in `boundaries[]`. Ranges resolved with `--diff` need both endpoints and their merge base present.
- **Records outside the queried repository.** In a multi-root workspace whose record root is not inside the repo under test, no tree of that repo contains the record, so the working tree is the only available source: the report is `informational`, carries a warning, and `--record-ref` is rejected as unhonourable rather than silently ignored.

## 11. File and test map

| Surface | Location |
|---------|----------|
| Resolver + anchor CLI | `tools/aidlc-attest.ts` (dispatcher route: `aidlc attest …`) |
| Record backings (`RecordView`) | `tools/aidlc-attest.ts` — `treeRecordView` (batched `ls-tree` + `cat-file`, the default) / `worktreeRecordView` (fallback and `anchor`) |
| Opt-in session anchoring | `hooks/aidlc-session-start.ts` (bounded best-effort reconcile sweep, `AIDLC_SESSION_ANCHOR=1`; off by default) |
| Evidence write/parse/exclusion library | `aidlc-lib.ts` — `writeUnitSourceSnapshot`, `reviewedSourceEvidenceRelPath`, `reviewedSourceEvidencePath`, `parseUnitSourceListing`, `serializeSourceListing`, `parseAuditShardEvents`, `normalizeManifestSourcePath`, `sourcePathIsExcluded`, `gitCommitSourceListing` |
| Swarm evidence transport | `aidlc-swarm.ts` — `captureReviewedRecordSnapshot` (hash-checks the worktree's manifest + evidence) / `mergeReviewedRecordSnapshot` (transactional write into the main record) |
| Event registration | `aidlc-audit.ts` (`SOURCE_COMMITTED` in `VALID_EVENT_TYPES` + `CLI_PROTECTED_EVENT_TYPES`), registry in `knowledge/aidlc-shared/audit-format.md` |
| Tests | `tests/unit/t311-committed-reviewed-source-evidence.test.ts` (evidence grammar, dual-write, exclusion), `tests/unit/t312-attest-resolve-anchor.test.ts` (resolve flows, determinism, trust ladder, indeterminate, anchor, the opt-in session sweep) |
