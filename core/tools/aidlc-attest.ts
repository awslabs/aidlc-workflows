// aidlc-attest.ts — Commit-level provenance: content-derived attribution from
// git commits/diffs back to reviewed units of work, plus enrichment anchors.
//
// Two verbs:
//   resolve — READ-ONLY reverse lookup: which reviewed unit owns each changed
//     path of a diff/commit, and does the committed content match what the
//     reviewer approved? Attribution is a pure function of repository content:
//     REVIEW_COMPLETED receipts (audit shards) carry a Unit Source Fingerprint
//     that is the sha256 of the evidence file
//     construction/<unit>/<stage>/reviewed-source-<hash12>.tsv (manifest header
//     + claim-restricted path→OID listing). No commit hooks, no commit-message
//     trailers, no pushed refs are consulted, so a bare clone resolves manual
//     commits exactly as well as tool-made ones.
//   anchor — append SOURCE_COMMITTED audit events recording that a commit was
//     observed to land reviewed claims. Enrichment ONLY: resolve never reads
//     anchors, so a commit that was never anchored still resolves.
//
// WHAT THIS PROVES, AND WHAT IT DOES NOT. resolve answers an INTEGRITY question:
// do the bytes that landed equal the bytes some receipt in the record approved?
// It does NOT answer an AUTHENTICITY question: was that receipt produced by a
// review that actually happened? Receipts, manifests, and evidence are ordinary
// files in the repository, so anyone who can write to the repository can write a
// receipt — including in the same change set as the source it approves. A report
// is therefore informational unless the caller supplies a trust anchor that the
// author of the change cannot forge. Two are available here:
//   --record-ref <ref>       read the record from a ref the verifier controls
//                            (a protected branch, a records-only ref) instead of
//                            from the commit under test
//   --require-trust signed   demand that every input the verdict rests on — each
//                            relied-upon receipt shard AND the evidence file it
//                            selects — arrived in a signed commit
// `trust` in the report always states which anchor was actually in force, so a
// report can never look stronger than the evidence behind it. The full threat
// model — assets, adversaries, and the guarantee boundary — is
// docs/reference/20-commit-provenance.md §2.
//
// DETERMINISM. The record is read from a git tree, not from the checkout: by
// default the queried head's tree, or `--record-ref`'s. So the same (base, head)
// pair resolves identically in every clone and at every later date, which is the
// property that makes a stored report meaningful. The working tree is read only
// when the record provably cannot live in the queried repository (a multi-root
// workspace whose roof is not the repo), and `trust.recordSource` says so.
//
// Path statuses:
//   verified      reviewed state equals head state for the path (same entry,
//                 or absent on both sides) under the owning unit's newest
//                 READY receipt
//   drifted       covered by a reviewed claim but head differs from reviewed
//   unattested    no unit's claims cover the path
//   unverifiable  covered, but the receipt or its evidence cannot bind content
//                 (unbindable fingerprint, or missing/hash-mismatched bytes in
//                 the record source being read)
//   indeterminate covered, but two same-timestamp READY receipts make "newest"
//                 causally unordered — in different shards, or in different
//                 records claiming the same path (fail closed both ways)
//   excluded      framework shell/record path (aidlc/, .aidlc/, sensor dirs, and
//                 the harness shell dirs established by the range's BASE tree —
//                 read from the commit, so the same SHA excludes the same paths
//                 everywhere without letting a change declare its own exclusion)
//
// Report `warnings` name conditions that can distort a report without changing
// any single path's classification — today repository byte-form conversion, and
// a fallback to working-tree records.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  type AuditShardEvent,
  auditBlockField,
  errorMessage,
  gitCommitSourceListing,
  HARNESS_SHELL_MANIFEST_REL,
  type IntentRegistryEntry,
  isGitRepoDir,
  isHarnessDirName,
  isHarnessShellManifest,
  listIntents,
  listSpaces,
  normalizeManifestSourcePath,
  parseAuditShardEvents,
  parseUnitSourceListing,
  readAuditShardEvents,
  recordDir,
  recordDirMatches,
  repoDir,
  resolveProjectDir,
  reviewedSourceEvidenceRelPath,
  type SourceClaimModel,
  sourceClaimCovers,
  sourceListingEntriesEqual,
  type SourceExclusionContext,
  sourcePathIsExcluded,
  sourcePathKey,
  spacesRoot,
  UNBINDABLE_FINGERPRINT,
  unitStageRecordRelPath,
  type WorkspaceSourceListing,
} from "./aidlc-lib.ts";

// --- Report vocabulary ---

export type PathStatus =
  | "verified"
  | "drifted"
  | "unattested"
  | "unverifiable"
  | "indeterminate"
  | "excluded";

/** `--fail-on` may name any non-passing classification; verified/excluded never fail. */
export const FAILABLE_STATUSES = [
  "drifted",
  "unattested",
  "unverifiable",
  "indeterminate",
] as const;

/** How strong the report's basis is, weakest first. Each level implies the one
 *  before it, so `--require-trust <level>` is a single comparison.
 *
 *  informational  the record was read from the working tree: the report cannot
 *                 be reproduced by anyone else, so it is a local diagnostic
 *  reproducible   the record was read from a git tree, so any clone of that tree
 *                 computes this exact report — but the tree may be the commit
 *                 under test, which means the change may have authored the very
 *                 receipts it is judged against (`trust.selfAttested`)
 *  independent    reproducible, and the queried range does not touch the record:
 *                 the receipts existed before the change under test
 *  signed         independent, and every authority-bearing input the verdict
 *                 rests on — each relied-upon unit's receipt shard AND the
 *                 evidence file that receipt's fingerprint selects — arrived in a
 *                 commit git reports a good signature for (at least one such
 *                 input must exist)
 *
 *  `signed` covers the receipt as well as the evidence because the receipt is
 *  what chooses the evidence: it names the unit, the stage, the timestamp that
 *  decides which receipt wins, and the fingerprint. A gate that checked only the
 *  evidence would accept an unsigned receipt pointing at an unrelated signed
 *  evidence file and still report `signed`.
 *
 *  Note what the ladder deliberately does NOT claim: no level proves a human
 *  reviewed anything. `signed` proves a key held by someone authorised to push
 *  vouched for the commits that carried those inputs; who that key belongs to is
 *  the verifier's keyring's business, not this tool's. */
export const TRUST_LEVELS = [
  "informational",
  "reproducible",
  "independent",
  "signed",
] as const;

export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** Git's `%G?` codes accepted as a good signature. `U` is a valid signature from
 *  a key the local keyring does not trust — accepted because a verifier that has
 *  not imported the reviewers' keys would otherwise be unable to reach `signed`
 *  at all, and key trust is a policy the keyring owns. Configure the keyring to
 *  make the distinction meaningful; `trust.signatures` reports the raw codes. */
const GOOD_SIGNATURE_CODES = new Set(["G", "U"]);

export interface TrustReport {
  /** Achieved level — the strongest one this report actually satisfies. */
  level: TrustLevel;
  /** `--require-trust`, or null when the caller demanded nothing. */
  required: TrustLevel | null;
  /** False only when `required` outranks `level`; drives exit 3 alongside `--fail-on`. */
  satisfied: boolean;
  /** Where receipts, manifests, and evidence were read from. */
  recordSource: "commit" | "worktree";
  /** The tree-ish they were read from, and its resolved commit; null for worktree. */
  recordRef: string | null;
  recordCommit: string | null;
  /** True when `--record-ref` named the record source, i.e. the verifier chose it
   *  rather than inheriting the commit under test. */
  recordPinned: boolean;
  /** Record paths the queried range itself adds or modifies. Non-empty means the
   *  change under test carries its own receipts — the normal shape of an AI-DLC
   *  change, and precisely why `independent` needs a separate record source. */
  recordPathsChangedInRange: string[];
  /** True when the receipts this report relies on could have been written by the
   *  change it is judging — the honest reason a self-contained report can never
   *  rise above `reproducible`. */
  selfAttested: boolean;
  /** `%G?` per authority-bearing input, keyed by the commit that last wrote it.
   *  Every relied-upon unit contributes BOTH of its inputs: the `receipt` (the
   *  audit shard whose REVIEW_COMPLETED block decided ownership and named the
   *  fingerprint) and the `evidence` file that fingerprint selects. `signed`
   *  requires all of them, because an unsigned receipt can point at signed
   *  evidence it has no right to. */
  signatures: Array<{
    unit: string;
    role: "receipt" | "evidence";
    path: string | null;
    commit: string | null;
    code: string;
  }>;
}

export interface PathReport {
  path: string;
  status: PathStatus;
  unit?: string;
  space?: string;
  intent?: string;
  reason?: string;
}

export interface UnitReport {
  unit: string;
  space: string;
  intent: string;
  stage: string;
  iteration: number | null;
  receiptTimestamp: string;
  reviewer: string | null;
  fingerprint: string;
  /** Where the evidence was read: repository-relative in commit-tree mode,
   *  project-relative in working-tree mode (`trust.recordSource` disambiguates). */
  evidence: string | null;
  evidenceSource: "committed" | "local" | null;
  /** Commit that last wrote this unit's evidence file at or before the record
   *  source, and git's `%G?` verdict for it. Both null in working-tree mode (no
   *  commit to name) or when the unit binds no committed evidence. */
  evidenceCommit: string | null;
  evidenceSignature: string | null;
  /** The audit shard holding the receipt that won this unit, plus the commit that
   *  last wrote that shard and its `%G?`. Same path forms as `evidence`;
   *  commit/signature null in working-tree mode. This is the input that decided
   *  which evidence to trust, so a reader auditing a `signed` verdict needs it. */
  receipt: string | null;
  receiptCommit: string | null;
  receiptSignature: string | null;
  claimsSource: "manifest" | "evidence-only" | "manifest-unverified" | null;
  bypasses: string[];
  problem?: string;
  pathsResolved: number;
  fullyLanded: boolean | null;
}

export interface ResolveReport {
  contract: 1;
  repo: string | null;
  repoNote?: string;
  mode: "diff" | "commit";
  base: string | null;
  head: string;
  paths: PathReport[];
  units: UnitReport[];
  summary: Record<PathStatus, number>;
  failOn: string[];
  /** What the report's basis actually was — read this before believing it. */
  trust: TrustReport;
  /** Conditions that can distort the whole report; never fail the gate by themselves. */
  warnings: string[];
}

export interface AnchorReport {
  contract: 1;
  repo: string | null;
  repoNote?: string;
  observed: "session" | "reconciled";
  scanned: number;
  anchored: Array<{
    commit: string;
    space: string;
    intent: string;
    units: string[];
    paths: number;
  }>;
  skipped: Array<{ commit: string; space: string; intent: string; reason: string }>;
  unattributed: string[];
  /** Shallow-clone boundary commits: their delta is unknowable, so they are
   *  neither anchored nor reported unattributed. */
  boundaries: string[];
}

export interface ResolveOptions {
  repo?: string;
  space?: string;
  intent?: string;
  diff?: string;
  commit?: string;
  failOn?: string[];
  /** Tree-ish to read the intent record from. Default: the queried head. */
  recordRef?: string;
  requireTrust?: string;
}

export interface AnchorOptions {
  repo?: string;
  space?: string;
  intent?: string;
  commit?: string;
  reconcile?: boolean;
  maxCommits?: number;
}

// --- Git helpers ---

function git(
  dir: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function resolveCommitish(dir: string, ref: string): string | null {
  const parsed = git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = parsed.stdout.trim();
  return parsed.status === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** Parents as traversal reports them, plus whether `sha` is a shallow-clone
 *  boundary. A grafted commit still names its parents inside the commit object,
 *  so an empty traversal result there means "truncated clone", not "root
 *  commit" — the two must not share the root-tree diff path. */
function commitParentage(
  dir: string,
  sha: string,
): { parents: string[]; shallow: boolean } | null {
  const listed = git(dir, ["rev-list", "--parents", "-n", "1", sha]);
  if (listed.status !== 0) return null;
  const parents = listed.stdout
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter((parent) => parent.length > 0);
  if (parents.length > 0) return { parents, shallow: false };
  const object = git(dir, ["cat-file", "commit", sha]);
  if (object.status !== 0) return null;
  const header = object.stdout.split("\n\n", 1)[0] ?? "";
  const named = header.split("\n").filter((line) => line.startsWith("parent ")).length;
  return { parents: [], shallow: named > 0 };
}

function shallowBoundaryError(sha: string): Error {
  return new Error(
    `${sha} is a shallow-clone boundary: its parent commit is absent, so its ` +
      `delta cannot be computed (a root-tree diff would classify every file in ` +
      `the tree). Deepen the clone first — git fetch --deepen 1, or check out ` +
      `with fetch-depth: 0.`,
  );
}

/** Changed paths of base..head (both sides of renames; null base = full root tree). */
function changedPaths(dir: string, base: string | null, head: string): string[] | null {
  const args =
    base === null
      ? ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-z", "-r", "--root", head]
      : ["diff", "--name-only", "--no-renames", "-z", base, head];
  const diffed = git(dir, args);
  if (diffed.status !== 0) return null;
  return [...new Set(diffed.stdout.split("\0").filter((path) => path.length > 0))];
}

/** The commit that last wrote `path` at or before `ref`, with git's `%G?` code
 *  for it. `code` is `"-"` when no commit touches the path at all. */
function lastWriterSignature(
  dir: string,
  ref: string,
  path: string,
): { commit: string | null; code: string } {
  const logged = git(dir, ["log", "-1", "--format=%H%x00%G?", ref, "--", path]);
  const row = logged.stdout.trim();
  if (logged.status !== 0 || row.length === 0) return { commit: null, code: "-" };
  const [commit, code] = row.split("\0");
  return {
    commit: /^[0-9a-f]{40,64}$/.test(commit ?? "") ? commit : null,
    code: code === undefined || code.length === 0 ? "-" : code,
  };
}

// --- Reading the intent record: from a git tree, or from the working tree ------
//
// Attribution must be a function of committed content alone, so the record has to
// be read the same way the source side is: out of a tree object. `RecordView` is
// the seam — one interface, two backings — so buildOwnershipIndex cannot
// accidentally reach the filesystem when it was asked for a commit.

interface RecordIntent {
  dirName: string;
  repos: string[];
}

interface RecordView {
  kind: "commit" | "worktree";
  /** The tree-ish read, and its commit; both null for the working tree. */
  ref: string | null;
  commit: string | null;
  spaces(): string[];
  intents(space: string): RecordIntent[];
  /** One intent's audit events across all shards. Both backings share
   *  parseAuditShardEvents, so `pos`/`shardIndex` — which decide which receipt is
   *  newest on a timestamp tie — carry the same meaning either way. */
  auditEvents(space: string, dirName: string): AuditShardEvent[];
  /** Bytes at a record-relative path, or null when the record has no such file. */
  readRecordFile(space: string, dirName: string, relPath: string): Buffer | null;
  /** The commit that last wrote a record file at this view's ref, with git's
   *  `%G?` code for it. Null when the view has no commit history to consult
   *  (the working tree), which caps trust at `informational`. */
  lastWriter(
    space: string,
    dirName: string,
    relPath: string,
  ): { commit: string | null; code: string } | null;
  /** The audit shard an event came from: a reportable label, plus the commit
   *  that last wrote that file and git's `%G?` for it. Takes the event's own
   *  `shard` token because its meaning is backing-specific (a repository path in
   *  commit mode, an absolute file path in the working tree), and returns
   *  commit/code null wherever no commit can be named. */
  shardOrigin(
    shard: string,
  ): { label: string; commit: string | null; code: string | null };
  /** Human label for the report's `evidence` field and problem strings. */
  label(space: string, dirName: string, relPath: string): string;
}

/** Read many blobs in one `git cat-file --batch` pass rather than one spawn per
 *  file: a record with a dozen intents has hundreds of candidate blobs, and on
 *  Windows the spawn cost dominates everything else this tool does. */
function readBlobs(dir: string, oids: readonly string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const unique = [...new Set(oids)];
  if (unique.length === 0) return out;
  const batch = spawnSync("git", ["-C", dir, "cat-file", "--batch"], {
    input: `${unique.join("\n")}\n`,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (batch.status !== 0 || !Buffer.isBuffer(batch.stdout)) return out;
  const stdout: Buffer = batch.stdout;
  let at = 0;
  while (at < stdout.length) {
    const eol = stdout.indexOf(0x0a, at);
    if (eol === -1) break;
    const header = stdout.subarray(at, eol).toString("utf-8");
    at = eol + 1;
    const parts = header.split(" ");
    // `<oid> missing` / `<oid> ambiguous` carry no payload to skip past.
    if (parts.length < 3) continue;
    const size = Number(parts[2]);
    if (!Number.isSafeInteger(size) || size < 0) break;
    out.set(parts[0], stdout.subarray(at, at + size));
    at += size + 1; // git writes a trailing newline after the payload
  }
  return out;
}

// --- Which dot-dirs are harness shells, according to the commit -------------
//
// `excluded` has to be a property of the commit, not of the machine reading it.
// The review-time walk discovers shells by opening the project root, which is
// right when the thing being described IS the checkout; for a report about a
// commit it is a bug: delete `.claude` from a working tree and the same SHA
// would flip its `.claude/**` paths from `excluded` to `unattested`. So we ask
// the tree instead, applying the same manifest rule (isHarnessShellManifest).

const treeShellCache = new Map<string, ReadonlySet<string>>();

/** Harness shell dirs at the root of `commit`'s tree. */
function commitHarnessShellDirs(dir: string, commit: string): ReadonlySet<string> {
  const cacheKey = `${dir}\0${commit}`;
  const cached = treeShellCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const shells = new Set<string>();
  // Root level only, non-recursive: a shell dir is a child of the repo root.
  const roots = git(dir, ["ls-tree", "-z", "--full-tree", commit]);
  const candidates: string[] = [];
  if (roots.status === 0) {
    for (const entry of roots.stdout.split("\0")) {
      const tab = entry.indexOf("\t");
      if (tab === -1) continue;
      const type = entry.slice(0, tab).split(" ")[1];
      const name = entry.slice(tab + 1);
      if (type === "tree" && isHarnessDirName(name)) candidates.push(name);
    }
  }
  if (candidates.length > 0) {
    const manifests = git(dir, [
      "ls-tree",
      "-z",
      "--full-tree",
      commit,
      "--",
      ...candidates.map((name) => `${name}/${HARNESS_SHELL_MANIFEST_REL}`),
    ]);
    const oids = new Map<string, string>();
    if (manifests.status === 0) {
      for (const entry of manifests.stdout.split("\0")) {
        const tab = entry.indexOf("\t");
        if (tab === -1) continue;
        const [, type, oid] = entry.slice(0, tab).split(" ");
        if (type !== "blob" || oid === undefined) continue;
        oids.set(entry.slice(tab + 1), oid);
      }
    }
    const contents = readBlobs(dir, [...oids.values()]);
    for (const [path, oid] of oids) {
      const bytes = contents.get(oid);
      const name = path.slice(0, path.length - HARNESS_SHELL_MANIFEST_REL.length - 1);
      if (bytes !== undefined && isHarnessShellManifest(bytes)) shells.add(name);
    }
  }
  treeShellCache.set(cacheKey, shells);
  return shells;
}

/** Exclusion context for a range. Only the base may establish a harness shell:
 *  trusting a manifest introduced by the head would let the change under test
 *  self-declare an arbitrary dot-directory (for example `.github`) as excluded.
 *  Existing shell modifications and removals remain excluded; a new installation
 *  is intentionally unattested until it becomes part of the trusted baseline. */
function rangeExclusionContext(
  query: RepoQuery,
  base: string | null,
): SourceExclusionContext {
  const shells = new Set<string>();
  if (query.carriesShell && base !== null) {
    for (const name of commitHarnessShellDirs(query.dir, base)) shells.add(name);
  }
  return { harnessShellDirs: shells };
}

/** The record as `sha` carries it. Every path/oid comes from one `ls-tree`, so
 *  the view is a snapshot: nothing it returns can change under a concurrent
 *  checkout, and two clones of `sha` build identical ownership indexes. */
function treeRecordView(
  repoQueryDir: string,
  spacesPrefix: string,
  ref: string,
  sha: string,
): RecordView {
  const listed = git(repoQueryDir, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    sha,
    "--",
    `${spacesPrefix}/`,
  ]);
  if (listed.status !== 0) {
    throw new Error(`cannot list the intent record under ${spacesPrefix}/ at ${ref} (${sha})`);
  }
  // `<mode> SP <type> SP <oid> TAB <path>` per NUL-terminated record. Only blobs
  // can be record files; a gitlink or a nested tree entry is not readable here.
  const blobs = new Map<string, string>();
  for (const entry of listed.stdout.split("\0")) {
    if (entry.length === 0) continue;
    const tab = entry.indexOf("\t");
    if (tab === -1) continue;
    const [, type, oid] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || oid === undefined) continue;
    blobs.set(entry.slice(tab + 1), oid);
  }
  const contents = readBlobs(repoQueryDir, [...blobs.values()]);
  const read = (repoPath: string): Buffer | null => {
    const oid = blobs.get(repoPath);
    return oid === undefined ? null : contents.get(oid) ?? null;
  };
  const intentsPrefix = (space: string) => `${spacesPrefix}/${space}/intents`;
  const recordPath = (space: string, dirName: string, relPath: string) =>
    `${intentsPrefix(space)}/${dirName}/${relPath}`;

  return {
    kind: "commit",
    ref,
    commit: sha,
    spaces() {
      const names = new Set<string>();
      for (const path of blobs.keys()) {
        const tail = path.slice(spacesPrefix.length + 1);
        const slash = tail.indexOf("/");
        if (slash > 0) names.add(tail.slice(0, slash));
      }
      return [...names].sort();
    },
    intents(space) {
      const prefix = `${intentsPrefix(space)}/`;
      const dirs = new Set<string>();
      for (const path of blobs.keys()) {
        if (!path.startsWith(prefix)) continue;
        const tail = path.slice(prefix.length);
        const slash = tail.indexOf("/");
        // A file directly under intents/ (intents.json) is not a record dir.
        if (slash > 0) dirs.add(tail.slice(0, slash));
      }
      // Same registry→dir join rule the working-tree reader uses (listIntents),
      // so `repos` resolves identically on both backings; a dir with no registry
      // row is an orphan and carries no recorded repos.
      const registryBytes = read(`${intentsPrefix(space)}/intents.json`);
      let registry: IntentRegistryEntry[] = [];
      if (registryBytes !== null) {
        try {
          const parsed: unknown = JSON.parse(registryBytes.toString("utf-8"));
          if (Array.isArray(parsed)) registry = parsed as IntentRegistryEntry[];
        } catch {
          registry = [];
        }
      }
      return [...dirs].sort().map((dirName) => ({
        dirName,
        repos: registry.find((entry) => recordDirMatches(entry, dirName))?.repos ?? [],
      }));
    },
    auditEvents(space, dirName) {
      const prefix = `${recordPath(space, dirName, "audit")}/`;
      const names: string[] = [];
      for (const path of blobs.keys()) {
        if (!path.startsWith(prefix)) continue;
        const name = path.slice(prefix.length);
        if (!name.includes("/") && name.endsWith(".md")) names.push(name);
      }
      // Basename ascending, matching auditShards() — shardIndex must mean the
      // same thing here as it does for the filesystem reader.
      names.sort();
      const rows: AuditShardEvent[] = [];
      for (let shardIndex = 0; shardIndex < names.length; shardIndex++) {
        const content = read(`${prefix}${names[shardIndex]}`)?.toString("utf-8") ?? "";
        rows.push(...parseAuditShardEvents(content, `${prefix}${names[shardIndex]}`, shardIndex));
      }
      return rows;
    },
    readRecordFile(space, dirName, relPath) {
      return read(recordPath(space, dirName, relPath));
    },
    lastWriter(space, dirName, relPath) {
      return lastWriterSignature(repoQueryDir, sha, recordPath(space, dirName, relPath));
    },
    shardOrigin(shard) {
      // `shard` is already this backing's repository path for the file.
      return { label: shard, ...lastWriterSignature(repoQueryDir, sha, shard) };
    },
    label(space, dirName, relPath) {
      return recordPath(space, dirName, relPath);
    },
  };
}

/** The record as this checkout holds it. Used only when the record provably
 *  cannot be read from the queried repo's tree, and by `anchor`, which appends to
 *  this very record and so has nothing to gain from a frozen snapshot. */
function worktreeRecordView(projectDir: string): RecordView {
  return {
    kind: "worktree",
    ref: null,
    commit: null,
    spaces() {
      return listSpaces(projectDir).map((space) => space.name);
    },
    intents(space) {
      const out: RecordIntent[] = [];
      for (const info of listIntents(projectDir, space)) {
        if (info.dirName === null) continue;
        out.push({ dirName: info.dirName, repos: info.repos ?? [] });
      }
      return out;
    },
    auditEvents(space, dirName) {
      // Delegate to the shared reader so shard ordering, symlink refusal, and
      // append-only read semantics stay in exactly one place.
      return readAuditShardEvents(projectDir, dirName, space);
    },
    readRecordFile(space, dirName, relPath) {
      const record = recordDir(projectDir, dirName, space);
      if (record === null) return null;
      try {
        return readFileSync(join(record, ...relPath.split("/")));
      } catch {
        return null;
      }
    },
    lastWriter() {
      // A working-tree file has no commit that "wrote" it — the bytes on disk may
      // never have been committed at all. Refusing to guess is what keeps a
      // worktree-backed report pinned to `informational`.
      return null;
    },
    shardOrigin(shard) {
      return {
        label: posixRelative(projectDir, shard),
        commit: null,
        code: null,
      };
    },
    label(space, dirName, relPath) {
      const record = recordDir(projectDir, dirName, space);
      return record === null
        ? relPath
        : posixRelative(projectDir, join(record, ...relPath.split("/")));
    },
  };
}

// --- Repo query resolution ---

interface RepoQuery {
  name: string | null; // recorded repo name, or null when the roof is the repo
  dir: string;
  keyRepo: string; // repo component of canonical source-path keys
  carriesShell: boolean;
  note?: string;
}

function resolveRepoQuery(
  projectDir: string,
  requested: string | undefined,
  recordedRepos: ReadonlySet<string>,
): RepoQuery {
  if (requested !== undefined) {
    if (
      requested.length === 0 ||
      requested === "." ||
      requested === ".." ||
      requested.includes("/") ||
      requested.includes("\\")
    ) {
      throw new Error(`--repo must be a plain recorded-repo directory name, got ${JSON.stringify(requested)}`);
    }
    const dir = repoDir(projectDir, requested);
    if (!isGitRepoDir(dir)) {
      throw new Error(`--repo ${requested}: ${dir} is not a git repository`);
    }
    return { name: requested, dir, keyRepo: requested, carriesShell: false };
  }
  if (isGitRepoDir(projectDir)) {
    return { name: null, dir: projectDir, keyRepo: "", carriesShell: true };
  }
  // Roof is not a repository: a sole recorded sibling repo is unambiguous.
  const candidates = [...recordedRepos].sort().filter((name) => isGitRepoDir(repoDir(projectDir, name)));
  if (candidates.length === 1) {
    return {
      name: candidates[0],
      dir: repoDir(projectDir, candidates[0]),
      keyRepo: candidates[0],
      carriesShell: false,
      note: `project dir is not a git repository; auto-selected the sole recorded repo ${JSON.stringify(candidates[0])}`,
    };
  }
  throw new Error(
    candidates.length === 0
      ? "project dir is not a git repository and no recorded repo resolves; pass --repo <name>"
      : `project dir is not a git repository; pass --repo <name> (recorded: ${candidates.join(", ")})`,
  );
}

// --- Ownership index: newest READY receipt per unit, with committed evidence ---

interface UnitOwnership {
  unit: string;
  space: string;
  intent: string; // record dir name
  stage: string;
  iteration: number | null;
  timestamp: string;
  reviewer: string | null;
  fingerprint: string;
  bypasses: string[];
  tie: boolean;
  claims: SourceClaimModel | null;
  claimsSource: "manifest" | "evidence-only" | "manifest-unverified" | null;
  evidenceListing: WorkspaceSourceListing | null;
  evidencePath: string | null;
  evidenceSource: "committed" | "local" | null;
  /** Commit that introduced the relied-upon evidence file, and git's `%G?` code
   *  for it. Both null when the view cannot attribute a commit (worktree) or the
   *  unit binds no committed evidence — either way the unit cannot reach `signed`. */
  evidenceCommit: string | null;
  evidenceSignature: string | null;
  /** The audit shard carrying the receipt that won ownership, and who last wrote
   *  it. The receipt is the ROOT of the authority chain — it names the unit, the
   *  stage, the timestamp that decides which receipt wins, and the fingerprint
   *  that selects the evidence file — so a trust level derived from the evidence
   *  alone would be blind to a forged receipt pointing at somebody else's
   *  legitimate, signed evidence. Git guarantees nothing about append-only-ness:
   *  whoever last wrote this file could have written anything in it. */
  receiptShard: string | null;
  receiptCommit: string | null;
  receiptSignature: string | null;
  problem: string | null;
}

interface IntentAnchors {
  space: string;
  intent: string;
  /** `${commit}\0${repoField}` keys of existing SOURCE_COMMITTED rows. */
  anchoredKeys: Set<string>;
  /** `${commit}\0${repoField}` keys already bound by SWARM_SOURCE_MERGED. */
  swarmMergedKeys: Set<string>;
}

interface OwnershipIndex {
  ownerships: UnitOwnership[];
  intents: IntentAnchors[];
}

function compareShardEvents(a: AuditShardEvent, b: AuditShardEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  // Same-shard ties have real append order; cross-shard ties stay causally
  // unordered and are surfaced per unit as `tie` (classified indeterminate).
  if (a.shard === b.shard) return a.pos - b.pos;
  return a.shardIndex - b.shardIndex;
}

/** Strict claim extraction from source-manifest bytes. A hash-verified manifest
 *  already passed review-time validation, so any parse failure here returns
 *  null and the caller falls back to evidence-listing-only semantics. */
function parseManifestClaims(
  bytes: Buffer,
  recordedRepos: string[],
): SourceClaimModel | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const writes = (value as { writes?: unknown }).writes;
  if (!Array.isArray(writes)) return null;
  const claims = new Set<string>();
  const prefixes: string[] = [];
  for (const write of writes) {
    if (typeof write !== "object" || write === null) return null;
    const path = (write as { path?: unknown }).path;
    const repo = (write as { repo?: unknown }).repo;
    if (typeof path !== "string") return null;
    if (repo !== undefined && typeof repo !== "string") return null;
    let canonicalRepo: string;
    if (typeof repo === "string") {
      if (!recordedRepos.includes(repo)) return null;
      canonicalRepo = repo;
    } else if (recordedRepos.length === 1) {
      canonicalRepo = recordedRepos[0];
    } else if (recordedRepos.length === 0) {
      canonicalRepo = "";
    } else {
      // Multi-repo intents require a per-write repo. Review-time validation
      // (readUnitSourceManifest) already rejects a manifest that omits it, so a
      // manifest behind a READY receipt cannot land here — this is the strict
      // reader refusing to guess, not a live case.
      return null;
    }
    const normalized = normalizeManifestSourcePath(path);
    if ("reason" in normalized) return null;
    const key = sourcePathKey(canonicalRepo, normalized.path);
    if (normalized.prefix) prefixes.push(key);
    else claims.add(key);
  }
  prefixes.sort();
  return { claims, prefixes };
}

/** All attribution comes from `view`, never from the filesystem directly: that is
 *  what makes a report on (base, head) reproducible from the commit alone. */
function buildOwnershipIndex(
  view: RecordView,
  spaceFilter: string | undefined,
  intentFilter: string | undefined,
): OwnershipIndex {
  const ownerships: UnitOwnership[] = [];
  const intents: IntentAnchors[] = [];
  const spaces = spaceFilter !== undefined ? [spaceFilter] : view.spaces();
  for (const space of spaces) {
    for (const info of view.intents(space)) {
      if (intentFilter !== undefined && info.dirName !== intentFilter) continue;
      const events = view.auditEvents(space, info.dirName);

      const anchors: IntentAnchors = {
        space,
        intent: info.dirName,
        anchoredKeys: new Set(),
        swarmMergedKeys: new Set(),
      };
      for (const event of events) {
        if (event.event === "SOURCE_COMMITTED") {
          const commit = auditBlockField(event.block, "Commit");
          if (commit !== null) {
            anchors.anchoredKeys.add(`${commit}\0${auditBlockField(event.block, "Repo") ?? "-"}`);
          }
        } else if (event.event === "SWARM_SOURCE_MERGED") {
          const commit = auditBlockField(event.block, "Merge commit");
          if (commit !== null) {
            anchors.swarmMergedKeys.add(`${commit}\0${auditBlockField(event.block, "Repo") ?? "-"}`);
          }
        }
      }
      intents.push(anchors);

      const receipts = events
        .filter(
          (event) =>
            event.event === "REVIEW_COMPLETED" &&
            auditBlockField(event.block, "Verdict") === "READY" &&
            auditBlockField(event.block, "Unit") !== null &&
            auditBlockField(event.block, "Stage") !== null &&
            auditBlockField(event.block, "Unit Source Fingerprint") !== null,
        )
        .sort(compareShardEvents);
      const newestPerUnit = new Map<string, AuditShardEvent>();
      for (const receipt of receipts) {
        newestPerUnit.set(auditBlockField(receipt.block, "Unit") as string, receipt);
      }

      for (const [unit, chosen] of newestPerUnit) {
        const stage = auditBlockField(chosen.block, "Stage") as string;
        const fingerprint = auditBlockField(chosen.block, "Unit Source Fingerprint") as string;
        const iterationRaw = auditBlockField(chosen.block, "Iteration");
        const iteration =
          iterationRaw !== null && /^[1-9][0-9]*$/.test(iterationRaw)
            ? Number(iterationRaw)
            : null;
        const bypasses: string[] = [];
        if (auditBlockField(chosen.block, "Source Freshness Bypass") !== null) {
          bypasses.push("source-freshness-bypass");
        }
        if (auditBlockField(chosen.block, "Unit Source Binding Bypass") !== null) {
          bypasses.push("unit-source-binding-bypass");
        }
        if (auditBlockField(chosen.block, "Recovery") !== null) {
          bypasses.push("stale-receipt-recovery");
        }
        const tie = receipts.some(
          (other) =>
            other !== chosen &&
            auditBlockField(other.block, "Unit") === unit &&
            other.timestamp === chosen.timestamp &&
            other.shard !== chosen.shard,
        );

        let problem: string | null = null;
        let evidenceListing: WorkspaceSourceListing | null = null;
        let evidencePath: string | null = null;
        let evidenceSource: "committed" | "local" | null = null;
        let manifestSha: string | null = null;
        let evidenceRel: string | null = null;
        if (fingerprint === UNBINDABLE_FINGERPRINT) {
          problem = "review receipt carries no source binding (unbindable fingerprint)";
        } else {
          const hex = /^sha256:([0-9a-f]{64})$/.exec(fingerprint)?.[1];
          if (hex === undefined) {
            problem = "review receipt carries a malformed Unit Source Fingerprint";
          } else {
            const hash12 = hex.slice(0, 12);
            const candidates: Array<{ rel: string; source: "committed" | "local" }> = [
              { rel: reviewedSourceEvidenceRelPath(unit, stage, hash12), source: "committed" },
            ];
            if (view.kind === "worktree") {
              // Pre-dual-write records only wrote the gitignored per-machine copy,
              // which by definition is not in any tree — only a working-tree view
              // can even see it, and then only as a diagnostic (below).
              candidates.push({
                rel: `.aidlc-source-review/${stage}/unit-${unit}-${hash12}.tsv`,
                source: "local",
              });
            }
            for (const candidate of candidates) {
              const label = view.label(space, info.dirName, candidate.rel);
              const bytes = view.readRecordFile(space, info.dirName, candidate.rel);
              if (bytes === null) continue;
              if (createHash("sha256").update(bytes).digest("hex") !== hex) {
                problem = `evidence at ${label} does not hash to the receipt fingerprint`;
                continue;
              }
              const parsed = parseUnitSourceListing(bytes.toString("utf-8"));
              if (parsed === null) {
                problem = `evidence at ${label} is not a parseable unit source listing`;
                continue;
              }
              if (candidate.source === "local") {
                // The local snapshot is gitignored, so honouring it would make the
                // verdict depend on the machine: the authoring checkout would say
                // `verified` where every clone (and CI) says `unverifiable`. Keep it
                // as a diagnostic pointer only — never as verification bytes, and
                // never at the cost of a committed-evidence problem already found.
                evidencePath = label;
                evidenceSource = "local";
                problem =
                  problem === null
                    ? "reviewed-source evidence exists only in the gitignored machine-local " +
                      "snapshot, which no clone can read; re-review the unit to dual-write " +
                      "committed evidence"
                    : `${problem}; the gitignored machine-local snapshot does hash to the fingerprint, but no clone can read it`;
                break;
              }
              evidenceListing = parsed.listing;
              manifestSha = parsed.manifestSha256;
              evidencePath = label;
              evidenceRel = candidate.rel;
              evidenceSource = candidate.source;
              problem = null;
              break;
            }
            if (evidenceListing === null && problem === null) {
              problem =
                `reviewed-source evidence not found at ` +
                `${view.label(space, info.dirName, candidates[0].rel)}; the record may predate ` +
                `committed evidence, or the evidence may not be committed at the record source — ` +
                `re-review the unit to write it into the record`;
            }
          }
        }

        const recordedRepos = info.repos;
        const manifestBytes = view.readRecordFile(
          space,
          info.dirName,
          unitStageRecordRelPath(unit, stage, "source-manifest.json"),
        );
        let claims: SourceClaimModel | null = null;
        let claimsSource: UnitOwnership["claimsSource"] = null;
        if (
          manifestBytes !== null &&
          manifestSha !== null &&
          createHash("sha256").update(manifestBytes).digest("hex") === manifestSha
        ) {
          claims = parseManifestClaims(manifestBytes, recordedRepos);
          if (claims !== null) claimsSource = "manifest";
        }
        if (claims === null && evidenceListing !== null) {
          // Evidence-only semantics: exact reviewed paths stay attributable,
          // but prefix claims (and thus new files under them) are unknowable.
          claims = { claims: new Set(evidenceListing.keys()), prefixes: [] };
          claimsSource = "evidence-only";
        }
        if (claims === null && manifestBytes !== null) {
          claims = parseManifestClaims(manifestBytes, recordedRepos);
          if (claims !== null) claimsSource = "manifest-unverified";
        }

        // Who vouched for the evidence this unit is judged against. Only the
        // committed file matters: a local snapshot is never verification bytes.
        const writer =
          evidenceRel !== null && evidenceSource === "committed"
            ? view.lastWriter(space, info.dirName, evidenceRel)
            : null;
        // Who vouched for the receipt that chose that evidence in the first place.
        const receipt = view.shardOrigin(chosen.shard);

        ownerships.push({
          unit,
          space,
          intent: info.dirName,
          stage,
          iteration,
          timestamp: chosen.timestamp,
          reviewer: auditBlockField(chosen.block, "Reviewer"),
          fingerprint,
          bypasses,
          tie,
          claims,
          claimsSource,
          evidenceListing,
          evidencePath,
          evidenceSource,
          evidenceCommit: writer?.commit ?? null,
          evidenceSignature: writer?.code ?? null,
          receiptShard: receipt.label,
          receiptCommit: receipt.commit,
          receiptSignature: receipt.code,
          problem,
        });
      }
    }
  }
  return { ownerships, intents };
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join("/");
}

/** Total order for stable *listing* of owners: newest receipt last, ties broken
 *  by (space, intent, unit). The lexicographic tail keeps report output
 *  deterministic — it is deliberately NOT an ownership decision, which is why
 *  `owningUnit` reports same-timestamp ties instead of silently taking the tail. */
function compareOwners(a: UnitOwnership, b: UnitOwnership): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  const aKey = `${a.space}\0${a.intent}\0${a.unit}`;
  const bKey = `${b.space}\0${b.intent}\0${b.unit}`;
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

interface OwnerResolution {
  /** Newest covering owner under `compareOwners`. */
  owner: UnitOwnership;
  /** Another covering owner shares that newest timestamp, so "newest wins"
   *  cannot name a single owner: fail closed rather than pick lexicographically. */
  ambiguous: boolean;
}

function owningUnit(
  ownerships: UnitOwnership[],
  key: string,
): OwnerResolution | null {
  const owners = ownerships.filter(
    (owner) => owner.claims !== null && sourceClaimCovers(key, owner.claims),
  );
  if (owners.length === 0) return null;
  owners.sort(compareOwners);
  const owner = owners[owners.length - 1];
  return {
    owner,
    ambiguous: owners.some(
      (other) => other !== owner && other.timestamp === owner.timestamp,
    ),
  };
}

// --- resolve ---

function recordedRepoNames(
  projectDir: string,
  spaceFilter: string | undefined,
): Set<string> {
  const names = new Set<string>();
  const spaces = spaceFilter !== undefined
    ? [spaceFilter]
    : listSpaces(projectDir).map((space) => space.name);
  for (const space of spaces) {
    for (const info of listIntents(projectDir, space)) {
      for (const repo of info.repos ?? []) names.add(repo);
    }
  }
  return names;
}

function classifyPath(
  path: string,
  query: RepoQuery,
  ownerships: UnitOwnership[],
  headListing: WorkspaceSourceListing,
  exclusion: SourceExclusionContext,
): PathReport {
  // Exclusion reads the commit's own shell dirs, never the checkout's, so a
  // path's `excluded` verdict is fixed by the SHA.
  if (sourcePathIsExcluded(path, query.carriesShell, undefined, exclusion)) {
    return { path, status: "excluded" };
  }
  const key = sourcePathKey(query.keyRepo, path);
  const resolved = owningUnit(ownerships, key);
  if (resolved === null) return { path, status: "unattested" };
  const owner = resolved.owner;
  const attributed = {
    path,
    unit: owner.unit,
    space: owner.space,
    intent: owner.intent,
  };
  if (owner.tie || resolved.ambiguous) {
    return {
      ...attributed,
      status: "indeterminate",
      reason: owner.tie
        ? "two READY receipts with the same timestamp in different audit shards"
        : "two same-timestamp READY receipts in different records claim this path",
    };
  }
  if (owner.evidenceListing === null) {
    return {
      ...attributed,
      status: "unverifiable",
      reason: owner.problem ?? "no reviewed-source evidence",
    };
  }
  const equal = sourceListingEntriesEqual(
    owner.evidenceListing.get(key),
    headListing.get(`\0${path}`),
  );
  return { ...attributed, status: equal ? "verified" : "drifted" };
}

/** True when every reviewed entry for the queried repo matches head AND no
 *  covered head path is missing from the reviewed listing. Null without evidence. */
function unitFullyLanded(
  owner: UnitOwnership,
  query: RepoQuery,
  headListing: WorkspaceSourceListing,
): boolean | null {
  if (owner.evidenceListing === null || owner.tie) return null;
  const keyPrefix = `${query.keyRepo}\0`;
  for (const [key, entry] of owner.evidenceListing) {
    if (!key.startsWith(keyPrefix)) continue;
    const path = key.slice(keyPrefix.length);
    if (!sourceListingEntriesEqual(entry, headListing.get(`\0${path}`))) return false;
  }
  if (owner.claims !== null) {
    for (const headKey of headListing.keys()) {
      const key = sourcePathKey(query.keyRepo, headKey.slice(1));
      if (sourceClaimCovers(key, owner.claims) && !owner.evidenceListing.has(key)) {
        return false;
      }
    }
  }
  return true;
}

/** Review evidence hashes working-tree bytes; commit listings hash repository
 *  bytes with checkout filters deliberately off. Where the repo converts between
 *  the two forms, unchanged content can report `drifted`, so say so up front. */
function byteFormWarning(query: RepoQuery, head: string): string | null {
  const autocrlf = git(query.dir, ["config", "--get", "core.autocrlf"])
    .stdout.trim()
    .toLowerCase();
  const converts = autocrlf === "true" || autocrlf === "input";
  const attributes = git(query.dir, ["cat-file", "-e", `${head}:.gitattributes`]).status === 0;
  if (!converts && !attributes) return null;
  const cause = converts
    ? `core.autocrlf=${autocrlf}${attributes ? " and .gitattributes" : ""}`
    : ".gitattributes";
  return (
    `${cause} may convert bytes between the working tree and the repository; ` +
    `reviewed evidence records working-tree bytes while this report reads repository ` +
    `bytes, so converted paths (CRLF, LFS pointers, encodings) can report drifted`
  );
}

/** Repo-relative posix location of the spaces root inside the queried repo, or
 *  null when the record lies outside it (a multi-root workspace queried with
 *  `--repo`: the roof holds `aidlc/`, the repo is a child of the roof). */
function spacesPrefixInRepo(projectDir: string, query: RepoQuery): string | null {
  const rel = posixRelative(query.dir, spacesRoot(projectDir));
  if (rel.length === 0 || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    return null;
  }
  return rel;
}

/** Pick the record backing for a resolve, preferring the git tree so the report
 *  is a function of committed content. Falls back to the working tree only when
 *  the record cannot be in the queried repository at all, and always says which. */
function resolveRecordView(
  projectDir: string,
  query: RepoQuery,
  recordRef: string | undefined,
  head: string,
): { view: RecordView; warnings: string[] } {
  const prefix = spacesPrefixInRepo(projectDir, query);
  if (prefix === null) {
    if (recordRef !== undefined) {
      throw new Error(
        `--record-ref cannot be honoured: the intent record lives at ${spacesRoot(projectDir)}, ` +
          `outside the queried repository ${query.dir}, so no tree of that repository contains it`,
      );
    }
    return {
      view: worktreeRecordView(projectDir),
      warnings: [
        `the intent record lives outside the queried repository, so receipts, manifests, and ` +
          `evidence were read from the working tree; this report is a local diagnostic and cannot ` +
          `be reproduced from ${head} alone (trust.level is informational)`,
      ],
    };
  }
  const ref = recordRef ?? head;
  const sha = resolveCommitish(query.dir, ref);
  if (sha === null) {
    throw new Error(`cannot resolve ${recordRef === undefined ? "head" : "--record-ref"} ${JSON.stringify(ref)} in ${query.dir}`);
  }
  const view = treeRecordView(query.dir, prefix, ref, sha);
  const warnings: string[] = [];
  if (view.spaces().length === 0) {
    // Silence here would read as "nothing is attested" when the truth is "the
    // record was never committed" — the same output for opposite causes.
    warnings.push(
      `no intent record is committed under ${prefix}/ at ${ref} (${sha.slice(0, 12)}), so no path ` +
        `can be attributed; if this repository keeps records elsewhere, name that ref with --record-ref`,
    );
  }
  return { view, warnings };
}

/** Derive how strong the report's basis is, and whether it clears the bar the
 *  caller demanded. Never upgrades on assumption: every level above
 *  `informational` corresponds to something checked against git. */
function computeTrust(
  view: RecordView,
  query: RepoQuery,
  projectDir: string,
  head: string,
  paths: readonly string[],
  reliedUpon: readonly UnitOwnership[],
  required: TrustLevel | null,
  recordPinned: boolean,
): TrustReport {
  const prefix = spacesPrefixInRepo(projectDir, query);
  const recordPathsChangedInRange =
    prefix === null ? [] : paths.filter((path) => path.startsWith(`${prefix}/`)).sort();

  // Does the record we read already contain this change's own record edits? If
  // the pinned ref does not descend from head, the receipts predate the change.
  const recordIncludesChange =
    view.commit === null ||
    view.commit === head ||
    git(query.dir, ["merge-base", "--is-ancestor", head, view.commit]).status === 0;
  const selfAttested =
    view.kind === "worktree" ||
    (recordIncludesChange && recordPathsChangedInRange.length > 0);

  // Both ends of every relied-upon unit's authority chain. The receipt comes
  // first because it is the one that chose the evidence: gating on the evidence
  // alone would accept a forged, unsigned receipt whose fingerprint happens to
  // name a signed evidence file — exactly the "signed" claim nobody could honour.
  const signatures = reliedUpon.flatMap((owner) => {
    const unit = `${owner.space}/${owner.intent}/${owner.unit}`;
    return [
      {
        unit,
        role: "receipt" as const,
        path: owner.receiptShard,
        commit: owner.receiptCommit,
        code: owner.receiptSignature ?? "-",
      },
      {
        unit,
        role: "evidence" as const,
        path: owner.evidencePath,
        commit: owner.evidenceCommit,
        code: owner.evidenceSignature ?? "-",
      },
    ];
  });

  let level: TrustLevel;
  if (view.kind !== "commit") level = "informational";
  else if (selfAttested) level = "reproducible";
  else if (
    // At least one relied-upon input, every one of them signed — receipts and
    // evidence alike. The length check is what stops a change that attests
    // NOTHING from reporting `signed` on a vacuous "every": no input is no basis,
    // however good the record source is.
    signatures.length > 0 &&
    signatures.every((entry) => GOOD_SIGNATURE_CODES.has(entry.code))
  ) {
    level = "signed";
  } else level = "independent";

  return {
    level,
    required,
    satisfied:
      required === null || TRUST_LEVELS.indexOf(level) >= TRUST_LEVELS.indexOf(required),
    recordSource: view.kind,
    recordRef: view.ref,
    recordCommit: view.commit,
    recordPinned,
    recordPathsChangedInRange,
    selfAttested,
    signatures,
  };
}

export function runResolve(
  projectDirArg: string | undefined,
  options: ResolveOptions,
): { report: ResolveReport; failed: boolean } {
  const projectDir = resolveProjectDir(projectDirArg);
  const failOn = options.failOn ?? [];
  for (const status of failOn) {
    if (!(FAILABLE_STATUSES as readonly string[]).includes(status)) {
      throw new Error(
        `--fail-on accepts a comma-separated subset of ${FAILABLE_STATUSES.join(",")}, got ${JSON.stringify(status)}`,
      );
    }
  }
  if (options.diff !== undefined && options.commit !== undefined) {
    throw new Error("pass either --diff <base>..<head> or a single <commit>, not both");
  }
  let requireTrust: TrustLevel | null = null;
  if (options.requireTrust !== undefined) {
    if (!(TRUST_LEVELS as readonly string[]).includes(options.requireTrust)) {
      throw new Error(
        `--require-trust accepts one of ${TRUST_LEVELS.join(",")}, got ${JSON.stringify(options.requireTrust)}`,
      );
    }
    requireTrust = options.requireTrust as TrustLevel;
  }
  const query = resolveRepoQuery(
    projectDir,
    options.repo,
    recordedRepoNames(projectDir, options.space),
  );

  let mode: "diff" | "commit";
  let base: string | null;
  let head: string;
  if (options.diff !== undefined) {
    mode = "diff";
    const three = options.diff.includes("...");
    const parts = options.diff.split(three ? "..." : "..");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      throw new Error(`--diff expects <base>..<head> or <base>...<head>, got ${JSON.stringify(options.diff)}`);
    }
    const baseSha = resolveCommitish(query.dir, parts[0]);
    const headSha = resolveCommitish(query.dir, parts[1]);
    if (baseSha === null) throw new Error(`cannot resolve base ${JSON.stringify(parts[0])} in ${query.dir}`);
    if (headSha === null) throw new Error(`cannot resolve head ${JSON.stringify(parts[1])} in ${query.dir}`);
    if (three) {
      const merged = git(query.dir, ["merge-base", baseSha, headSha]);
      const mergeBase = merged.stdout.trim();
      if (merged.status !== 0 || !/^[0-9a-f]{40,64}$/.test(mergeBase)) {
        throw new Error(`cannot resolve merge-base of ${parts[0]} and ${parts[1]}`);
      }
      base = mergeBase;
    } else {
      base = baseSha;
    }
    head = headSha;
  } else {
    mode = "commit";
    const sha = resolveCommitish(query.dir, options.commit ?? "HEAD");
    if (sha === null) {
      throw new Error(`cannot resolve commit ${JSON.stringify(options.commit ?? "HEAD")} in ${query.dir}`);
    }
    const parentage = commitParentage(query.dir, sha);
    if (parentage === null) throw new Error(`cannot read parents of ${sha}`);
    if (parentage.shallow) throw shallowBoundaryError(sha);
    base = parentage.parents[0] ?? null; // merge commits resolve their first-parent delta
    head = sha;
  }

  const paths = changedPaths(query.dir, base, head);
  if (paths === null) throw new Error(`git diff failed for ${base ?? "(root)"}..${head} in ${query.dir}`);
  const headListing = gitCommitSourceListing(query.dir, head, query.carriesShell);
  if (headListing === null) {
    throw new Error(`cannot reconstruct the source listing of ${head} in ${query.dir}`);
  }

  const record = resolveRecordView(projectDir, query, options.recordRef, head);
  const { ownerships } = buildOwnershipIndex(record.view, options.space, options.intent);
  const exclusion = rangeExclusionContext(query, base);
  const pathReports = paths
    .sort()
    .map((path) => classifyPath(path, query, ownerships, headListing, exclusion));

  const summary: Record<PathStatus, number> = {
    verified: 0,
    drifted: 0,
    unattested: 0,
    unverifiable: 0,
    indeterminate: 0,
    excluded: 0,
  };
  const involved = new Map<string, { owner: UnitOwnership; pathsResolved: number }>();
  for (const report of pathReports) {
    summary[report.status]++;
    if (report.unit === undefined) continue;
    const ownerKey = `${report.space}\0${report.intent}\0${report.unit}`;
    const entry = involved.get(ownerKey);
    if (entry !== undefined) {
      entry.pathsResolved++;
      continue;
    }
    const owner = ownerships.find(
      (candidate) =>
        candidate.space === report.space &&
        candidate.intent === report.intent &&
        candidate.unit === report.unit,
    );
    if (owner !== undefined) involved.set(ownerKey, { owner, pathsResolved: 1 });
  }

  const reliedUpon = [...involved.values()]
    .map(({ owner }) => owner)
    .sort(compareOwners);
  const units: UnitReport[] = [...involved.values()]
    .sort((a, b) => compareOwners(a.owner, b.owner))
    .map(({ owner, pathsResolved }) => ({
      unit: owner.unit,
      space: owner.space,
      intent: owner.intent,
      stage: owner.stage,
      iteration: owner.iteration,
      receiptTimestamp: owner.timestamp,
      reviewer: owner.reviewer,
      fingerprint: owner.fingerprint,
      evidence: owner.evidencePath,
      evidenceSource: owner.evidenceSource,
      evidenceCommit: owner.evidenceCommit,
      evidenceSignature: owner.evidenceSignature,
      receipt: owner.receiptShard,
      receiptCommit: owner.receiptCommit,
      receiptSignature: owner.receiptSignature,
      claimsSource: owner.claimsSource,
      bypasses: owner.bypasses,
      ...(owner.problem === null ? {} : { problem: owner.problem }),
      pathsResolved,
      fullyLanded: unitFullyLanded(owner, query, headListing),
    }));

  const trust = computeTrust(
    record.view,
    query,
    projectDir,
    head,
    paths,
    reliedUpon,
    requireTrust,
    options.recordRef !== undefined,
  );

  const warnings = [byteFormWarning(query, head), ...record.warnings].filter(
    (warning): warning is string => warning !== null,
  );

  const report: ResolveReport = {
    contract: 1,
    repo: query.name,
    ...(query.note === undefined ? {} : { repoNote: query.note }),
    mode,
    base,
    head,
    paths: pathReports,
    units,
    summary,
    failOn,
    trust,
    warnings,
  };
  const failSet = new Set(failOn);
  // An unmet trust bar fails the same way a failing path does: the caller asked
  // for a guarantee this report cannot make, so reporting success would lie.
  return {
    report,
    failed: pathReports.some((path) => failSet.has(path.status)) || !trust.satisfied,
  };
}

// --- anchor ---

export function runAnchor(
  projectDirArg: string | undefined,
  options: AnchorOptions,
): AnchorReport {
  const projectDir = resolveProjectDir(projectDirArg);
  const query = resolveRepoQuery(
    projectDir,
    options.repo,
    recordedRepoNames(projectDir, options.space),
  );
  const repoField = query.name ?? "-";
  const observed = options.reconcile === true ? "reconciled" : "session";
  const maxCommits = options.maxCommits ?? 100;
  if (!Number.isInteger(maxCommits) || maxCommits < 1) {
    throw new Error("--max-commits must be a positive integer");
  }
  const start = resolveCommitish(query.dir, options.commit ?? "HEAD");
  if (start === null) {
    throw new Error(`cannot resolve commit ${JSON.stringify(options.commit ?? "HEAD")} in ${query.dir}`);
  }

  // Each row: `<sha> <parent>...` — first-parent walk, newest first.
  let rows: string[][];
  if (options.reconcile === true) {
    const listed = git(query.dir, [
      "rev-list",
      "--first-parent",
      "--parents",
      "-n",
      String(maxCommits),
      start,
    ]);
    if (listed.status !== 0) throw new Error(`git rev-list failed from ${start} in ${query.dir}`);
    rows = listed.stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.split(/\s+/));
  } else {
    const parentage = commitParentage(query.dir, start);
    if (parentage === null) throw new Error(`cannot read parents of ${start}`);
    if (parentage.shallow) throw shallowBoundaryError(start);
    rows = [[start, ...parentage.parents]];
  }

  // anchor writes into THIS checkout's record and dedupes against rows it may
  // itself have appended moments ago, so the working tree is the correct — and
  // only coherent — backing here. Anchors are enrichment, never attribution.
  const { ownerships, intents } = buildOwnershipIndex(
    worktreeRecordView(projectDir),
    options.space,
    options.intent,
  );
  const anchorsByIntent = new Map(
    intents.map((entry) => [`${entry.space}\0${entry.intent}`, entry]),
  );

  const report: AnchorReport = {
    contract: 1,
    repo: query.name,
    ...(query.note === undefined ? {} : { repoNote: query.note }),
    observed,
    scanned: rows.length,
    anchored: [],
    skipped: [],
    unattributed: [],
    boundaries: [],
  };

  for (const [commit, ...parents] of rows) {
    if (parents.length === 0) {
      // Parentless: either a true root commit (diff against the root tree) or a
      // shallow boundary whose parent is simply absent. Attributing a boundary's
      // whole tree would anchor every reviewed unit to it, so skip and report.
      const parentage = commitParentage(query.dir, commit);
      if (parentage?.shallow) {
        report.boundaries.push(commit);
        continue;
      }
    }
    const paths = changedPaths(query.dir, parents[0] ?? null, commit);
    if (paths === null) throw new Error(`git diff failed for commit ${commit} in ${query.dir}`);
    const attributed = new Map<string, { space: string; intent: string; units: Set<string>; paths: number }>();
    const exclusion = rangeExclusionContext(query, parents[0] ?? null);
    for (const path of paths) {
      if (sourcePathIsExcluded(path, query.carriesShell, undefined, exclusion)) {
        continue;
      }
      const resolved = owningUnit(ownerships, sourcePathKey(query.keyRepo, path));
      if (resolved === null || resolved.ambiguous) continue; // ambiguity is resolve's to report
      const owner = resolved.owner;
      const intentKey = `${owner.space}\0${owner.intent}`;
      const entry = attributed.get(intentKey) ?? {
        space: owner.space,
        intent: owner.intent,
        units: new Set<string>(),
        paths: 0,
      };
      entry.units.add(owner.unit);
      entry.paths++;
      attributed.set(intentKey, entry);
    }
    if (attributed.size === 0) {
      report.unattributed.push(commit);
      continue;
    }
    for (const [intentKey, entry] of attributed) {
      const dedupeKey = `${commit}\0${repoField}`;
      const anchors = anchorsByIntent.get(intentKey);
      if (anchors?.swarmMergedKeys.has(dedupeKey)) {
        report.skipped.push({
          commit,
          space: entry.space,
          intent: entry.intent,
          reason: "already bound by SWARM_SOURCE_MERGED",
        });
        continue;
      }
      if (anchors?.anchoredKeys.has(dedupeKey)) {
        report.skipped.push({
          commit,
          space: entry.space,
          intent: entry.intent,
          reason: "already anchored",
        });
        continue;
      }
      const units = [...entry.units].sort();
      appendAuditEntry(
        "SOURCE_COMMITTED",
        {
          Commit: commit,
          Repo: repoField,
          Units: units.join(", "),
          "Attributed Paths": String(entry.paths),
          Observed: observed,
        },
        projectDir,
        entry.intent,
        entry.space,
      );
      anchors?.anchoredKeys.add(dedupeKey);
      report.anchored.push({
        commit,
        space: entry.space,
        intent: entry.intent,
        units,
        paths: entry.paths,
      });
    }
  }
  return report;
}

// --- CLI entry point ---

const USAGE = `Usage:
  aidlc attest resolve [<commit>|--commit <rev>] [--diff <base>..<head>]
                       [--repo <name>] [--space <name>] [--intent <dir>]
                       [--record-ref <ref>] [--require-trust <level>]
                       [--fail-on <statuses>]
  aidlc attest anchor [--commit <rev>] [--reconcile] [--max-commits <n>]
                      [--repo <name>] [--space <name>] [--intent <dir>]

resolve  Read-only: attribute a diff/commit's changed paths to reviewed units
         and classify each against committed reviewed-source evidence
         (verified | drifted | unattested | unverifiable | indeterminate |
         excluded). --fail-on drifted,unattested exits 3 when matched.
resolve <commit> (or --commit <rev>) resolves that commit's first-parent delta
         (default HEAD).
  --record-ref <ref>
         Read receipts, manifests, and evidence from <ref>'s tree instead of the
         queried commit's. Point it at a ref the change under test cannot write
         (a protected branch) so the change cannot supply its own approvals.
  --require-trust <level>
         Exit 3 unless the report's basis reaches <level>:
           informational  record read from the working tree (local diagnostic)
           reproducible   record read from a git tree, but the change may have
                          authored the receipts judging it (trust.selfAttested)
           independent    reproducible, and the range does not touch the record
           signed         independent, and every authority-bearing input (each
                          relied-upon receipt shard and the evidence file its
                          fingerprint selects) arrived in a signed commit
         This bounds how much the report can be trusted, not how much of the
         change is attested — pair it with --fail-on for coverage.
anchor   Append SOURCE_COMMITTED enrichment events for commits that landed
         reviewed claims (deduplicated; --reconcile walks first-parent
         history, bounded by --max-commits, default 100). resolve never reads
         anchors, so anchoring is optional and never gates a report.`;

/** Each verb accepts only its own flags: a flag the other verb owns is a usage
 *  error, never a silently ignored argument (`resolve --commit X` used to report
 *  HEAD while looking like it honoured X). */
const RESOLVE_FLAGS = new Set([
  "diff",
  "commit",
  "repo",
  "space",
  "intent",
  "fail-on",
  "record-ref",
  "require-trust",
]);
const ANCHOR_FLAGS = new Set(["commit", "reconcile", "max-commits", "repo", "space", "intent"]);

function rejectForeignFlags(
  flags: Record<string, string | boolean>,
  allowed: ReadonlySet<string>,
  verb: string,
): void {
  const foreign = Object.keys(flags)
    .filter((name) => !allowed.has(name))
    .sort();
  if (foreign.length > 0) {
    throw new Error(
      `${verb} does not accept ${foreign.map((name) => `--${name}`).join(", ")}\n${USAGE}`,
    );
  }
}

function printError(message: string): void {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
}

export function main(argv: string[]): void {
  let projectDir: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project-dir" && i + 1 < argv.length) {
      projectDir = argv[i + 1];
      i++;
    } else {
      args.push(argv[i]);
    }
  }
  const subcommand = args.shift();

  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const VALUE_FLAGS = new Set([
    "diff",
    "repo",
    "space",
    "intent",
    "fail-on",
    "commit",
    "max-commits",
    "record-ref",
    "require-trust",
  ]);
  const BOOLEAN_FLAGS = new Set(["reconcile"]);
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const name = args[i].slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else if (VALUE_FLAGS.has(name) && i + 1 < args.length) {
        flags[name] = args[i + 1];
        i++;
      } else {
        printError(`unknown or valueless flag --${name}\n${USAGE}`);
        process.exit(1);
      }
    } else {
      positional.push(args[i]);
    }
  }

  try {
    switch (subcommand) {
      case "resolve": {
        rejectForeignFlags(flags, RESOLVE_FLAGS, "resolve");
        if (positional.length > 1) throw new Error(`at most one <commit> positional, got ${positional.length}`);
        if (positional.length === 1 && flags.commit !== undefined) {
          throw new Error("pass either <commit> or --commit <rev>, not both");
        }
        const { report, failed } = runResolve(projectDir, {
          repo: flags.repo as string | undefined,
          space: flags.space as string | undefined,
          intent: flags.intent as string | undefined,
          diff: flags.diff as string | undefined,
          commit: (flags.commit as string | undefined) ?? positional[0],
          recordRef: flags["record-ref"] as string | undefined,
          requireTrust: flags["require-trust"] as string | undefined,
          failOn:
            flags["fail-on"] === undefined
              ? []
              : (flags["fail-on"] as string).split(",").map((status) => status.trim()).filter((status) => status.length > 0),
        });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (failed) process.exit(3);
        break;
      }
      case "anchor": {
        rejectForeignFlags(flags, ANCHOR_FLAGS, "anchor");
        if (positional.length > 0) throw new Error("anchor takes no positionals; use --commit <rev>");
        const report = runAnchor(projectDir, {
          repo: flags.repo as string | undefined,
          space: flags.space as string | undefined,
          intent: flags.intent as string | undefined,
          commit: flags.commit as string | undefined,
          reconcile: flags.reconcile === true,
          maxCommits:
            flags["max-commits"] === undefined ? undefined : Number(flags["max-commits"]),
        });
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        break;
      }
      case "help":
      case undefined:
        process.stdout.write(`${USAGE}\n`);
        break;
      default:
        printError(`Unknown subcommand: ${subcommand}. Valid: resolve, anchor, help`);
        process.exit(1);
    }
  } catch (e) {
    printError(errorMessage(e));
    process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
