// aidlc-attest.ts — Commit-level provenance: content-derived attribution from
// git commits/diffs back to reviewed units of work, plus enrichment anchors.
//
// Two verbs:
//   resolve — READ-ONLY reverse lookup: which reviewed unit owns each changed
//     path of a diff/commit, and does the committed content match what the
//     reviewer approved? Attribution is a pure function of repository content:
//     committed REVIEW_COMPLETED receipts (audit shards) carry a Unit Source
//     Fingerprint that is the sha256 of the committed evidence file
//     construction/<unit>/<stage>/reviewed-source-<hash12>.tsv (manifest
//     header + claim-restricted path→OID listing). No commit hooks, no
//     commit-message trailers, no pushed refs are consulted, so a bare CI
//     clone resolves manual commits exactly as well as tool-made ones.
//   anchor — append SOURCE_COMMITTED audit events recording that a commit was
//     observed to land reviewed claims. Enrichment ONLY: resolve never reads
//     anchors, so a commit that was never anchored still resolves.
//
// Path statuses:
//   verified      reviewed state equals head state for the path (same entry,
//                 or absent on both sides) under the owning unit's newest
//                 READY receipt
//   drifted       covered by a reviewed claim but head differs from reviewed
//   unattested    no unit's claims cover the path
//   unverifiable  covered, but the receipt or its evidence cannot bind content
//                 (unbindable fingerprint, missing or hash-mismatched bytes, or
//                 evidence that exists only in the gitignored local snapshot)
//   indeterminate covered, but two same-timestamp READY receipts make "newest"
//                 causally unordered — in different shards, or in different
//                 records claiming the same path (fail closed both ways)
//   excluded      framework shell/record path (aidlc/, .aidlc/, sensor dirs, and
//                 the harness shell dirs of a workspace-shell-carrying repo)
//
// Report `warnings` name conditions that can distort a report without changing
// any single path's classification — repository byte-form conversion, and an
// intent record whose working-tree state differs from the queried commit (the
// record is read from the working tree, not from head's tree).

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
  intentsDir,
  isGitRepoDir,
  listIntents,
  listSpaces,
  normalizeManifestSourcePath,
  parseUnitSourceListing,
  readAuditShardEvents,
  recordDir,
  repoDir,
  resolveProjectDir,
  reviewedSourceEvidencePath,
  type SourceClaimModel,
  sourceClaimCovers,
  sourceListingEntriesEqual,
  sourcePathIsExcluded,
  sourcePathKey,
  UNBINDABLE_FINGERPRINT,
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
  evidence: string | null;
  evidenceSource: "committed" | "local" | null;
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
  /** Where receipts, manifests, and evidence were read from. Today always the
   *  working tree — see `warnings` when that differs from the queried commit. */
  recordSource: "worktree";
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

function buildOwnershipIndex(
  projectDir: string,
  spaceFilter: string | undefined,
  intentFilter: string | undefined,
): OwnershipIndex {
  const ownerships: UnitOwnership[] = [];
  const intents: IntentAnchors[] = [];
  const spaces = spaceFilter !== undefined
    ? [spaceFilter]
    : listSpaces(projectDir).map((space) => space.name);
  for (const space of spaces) {
    for (const info of listIntents(projectDir, space)) {
      if (info.dirName === null) continue;
      if (intentFilter !== undefined && info.dirName !== intentFilter) continue;
      const record = recordDir(projectDir, info.dirName, space);
      if (record === null) continue;
      const events = readAuditShardEvents(projectDir, info.dirName, space);

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
        if (fingerprint === UNBINDABLE_FINGERPRINT) {
          problem = "review receipt carries no source binding (unbindable fingerprint)";
        } else {
          const hex = /^sha256:([0-9a-f]{64})$/.exec(fingerprint)?.[1];
          if (hex === undefined) {
            problem = "review receipt carries a malformed Unit Source Fingerprint";
          } else {
            const hash12 = hex.slice(0, 12);
            const candidates: Array<{ path: string; source: "committed" | "local" }> = [
              {
                path: reviewedSourceEvidencePath(record, unit, stage, hash12),
                source: "committed",
              },
              {
                // Pre-dual-write records only wrote the gitignored per-machine copy.
                path: join(record, ".aidlc-source-review", stage, `unit-${unit}-${hash12}.tsv`),
                source: "local",
              },
            ];
            for (const candidate of candidates) {
              let bytes: Buffer;
              try {
                bytes = readFileSync(candidate.path);
              } catch {
                continue;
              }
              if (createHash("sha256").update(bytes).digest("hex") !== hex) {
                problem = `evidence at ${posixRelative(projectDir, candidate.path)} does not hash to the receipt fingerprint`;
                continue;
              }
              const parsed = parseUnitSourceListing(bytes.toString("utf-8"));
              if (parsed === null) {
                problem = `evidence at ${posixRelative(projectDir, candidate.path)} is not a parseable unit source listing`;
                continue;
              }
              if (candidate.source === "local") {
                // The local snapshot is gitignored, so honouring it would make the
                // verdict depend on the machine: the authoring checkout would say
                // `verified` where every clone (and CI) says `unverifiable`. Keep it
                // as a diagnostic pointer only — never as verification bytes, and
                // never at the cost of a committed-evidence problem already found.
                evidencePath = candidate.path;
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
              evidencePath = candidate.path;
              evidenceSource = candidate.source;
              problem = null;
              break;
            }
            if (evidenceListing === null && problem === null) {
              problem = "reviewed-source evidence not found (record may predate committed evidence)";
            }
          }
        }

        const recordedRepos = info.repos ?? [];
        let manifestBytes: Buffer | null = null;
        try {
          manifestBytes = readFileSync(join(record, "construction", unit, stage, "source-manifest.json"));
        } catch {
          manifestBytes = null;
        }
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
): PathReport {
  if (sourcePathIsExcluded(path, query.carriesShell, query.carriesShell ? query.dir : undefined)) {
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

/** Receipts and evidence come from the working tree, not from head's tree, so a
 *  checkout whose record differs from the queried commit resolves against
 *  different receipts than a clone of that commit would. */
function recordDriftWarning(
  query: RepoQuery,
  projectDir: string,
  space: string | undefined,
  head: string,
): string | null {
  if (!query.carriesShell) return null; // record lives outside the queried repo
  const rel = posixRelative(projectDir, intentsDir(projectDir, space)).split("/")[0];
  if (rel.length === 0 || rel === ".." || rel.startsWith("../")) return null;
  const changed = git(query.dir, ["diff", "--quiet", head, "--", rel]).status !== 0;
  const untracked =
    git(query.dir, ["ls-files", "--others", "--exclude-standard", "--", rel]).stdout.trim()
      .length > 0;
  if (!changed && !untracked) return null;
  return (
    `the intent record under ${rel}/ differs between the working tree and ${head}; ` +
    `receipts, manifests, and evidence were read from the working tree, so a clone ` +
    `of ${head} may classify these paths differently`
  );
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

  const { ownerships } = buildOwnershipIndex(projectDir, options.space, options.intent);
  const pathReports = paths.sort().map((path) => classifyPath(path, query, ownerships, headListing));

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
      evidence: owner.evidencePath === null ? null : posixRelative(projectDir, owner.evidencePath),
      evidenceSource: owner.evidenceSource,
      claimsSource: owner.claimsSource,
      bypasses: owner.bypasses,
      ...(owner.problem === null ? {} : { problem: owner.problem }),
      pathsResolved,
      fullyLanded: unitFullyLanded(owner, query, headListing),
    }));

  const warnings = [
    byteFormWarning(query, head),
    recordDriftWarning(query, projectDir, options.space, head),
  ].filter((warning): warning is string => warning !== null);

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
    recordSource: "worktree",
    warnings,
  };
  const failSet = new Set(failOn);
  return { report, failed: pathReports.some((path) => failSet.has(path.status)) };
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

  const { ownerships, intents } = buildOwnershipIndex(projectDir, options.space, options.intent);
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
    for (const path of paths) {
      if (sourcePathIsExcluded(path, query.carriesShell, query.carriesShell ? query.dir : undefined)) {
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
                       [--fail-on <statuses>]
  aidlc attest anchor [--commit <rev>] [--reconcile] [--max-commits <n>]
                      [--repo <name>] [--space <name>] [--intent <dir>]

resolve  Read-only: attribute a diff/commit's changed paths to reviewed units
         and classify each against committed reviewed-source evidence
         (verified | drifted | unattested | unverifiable | indeterminate |
         excluded). --fail-on drifted,unattested exits 3 when matched.
resolve <commit> (or --commit <rev>) resolves that commit's first-parent delta
         (default HEAD).
anchor   Append SOURCE_COMMITTED enrichment events for commits that landed
         reviewed claims (deduplicated; --reconcile walks first-parent
         history, bounded by --max-commits, default 100).`;

/** Each verb accepts only its own flags: a flag the other verb owns is a usage
 *  error, never a silently ignored argument (`resolve --commit X` used to report
 *  HEAD while looking like it honoured X). */
const RESOLVE_FLAGS = new Set(["diff", "commit", "repo", "space", "intent", "fail-on"]);
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
  const VALUE_FLAGS = new Set(["diff", "repo", "space", "intent", "fail-on", "commit", "max-commits"]);
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
