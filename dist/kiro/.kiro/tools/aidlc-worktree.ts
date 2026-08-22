// aidlc-worktree.ts — Construction-phase worktree primitive.
//
// Five subcommands: create, merge, discard, list, verify. Audit-first
// (audit-of-intent semantics — see docs/reference/12-state-machine.md
// § Audit-first atomicity). The orchestrator dispatches aidlc-pipeline-deploy-agent
// to read team practices, the agent invokes this tool with resolved flags,
// then the orchestrator calls `verify` as a deterministic post-dispatch
// backstop confirming the audit event landed.
//
// Sibling-worktree rejection: rejects calls from inside a non-main worktree
// to avoid the dev-worktree-vs-bolt-worktree clash. Run from the main repo
// checkout.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  auditBlockField,
  boltSlugForUnit,
  currentSwarmSourceOpeningFingerprint,
  currentSwarmSourceMergeChain,
  emitError,
  errorMessage,
  findAllEvents,
  getField,
  gitCommitSourceListing,
  latestMainWorkflowStageRunFloorForProject,
  parseSourceListing,
  readAllAuditShards,
  readAuditShardEvents,
  readStateFile,
  relativeRecordDir,
  reviewedSourceRefPrefix,
  resolveBoltDag,
  resolveConstructionRepo,
  resolveProjectDir,
  serializeSourceListing,
  sourceListingEntriesEqual,
  sourceListingSha256,
  type WorkspaceSourceListing,
  type WorkspaceSourceState,
  UNBINDABLE_FINGERPRINT,
  validateUnitName,
  workspaceSourceFingerprint,
  workspaceSourceState,
  worktreePath,
  worktreeStateFilePath,
  writeFileAtomic,
} from "./aidlc-lib.js";

// kebab-case slug shape: lowercase letter, then lowercase letters / digits /
// hyphens. Mirrors stage-schema.ts:95+:101 — the codebase already duplicates
// this regex across conceptual domains; a one-line constant beats a cross-
// module import for a tool-local check.
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

const VALID_STRATEGIES = new Set(["squash", "merge", "rebase"]);
const WORKTREE_META_FILENAME = "worktree-meta.json";
const WORKTREE_BASE_LISTING_FILENAME = "base-source-listing.tsv";
const VALID_VERIFY_EVENTS = new Set([
  "WORKTREE_CREATED",
  "WORKTREE_MERGED",
  "WORKTREE_DISCARDED",
]);

// --- Flag parsing (mirrors aidlc-bolt.ts:30-46) ---

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    if (i + 1 >= args.length) {
      error(`${a} expects a value, got end of arguments.`);
    }
    const val = args[i + 1];
    if (val.startsWith("--")) {
      error(`${a} expects a value, got another flag: "${val}". Did you forget the value?`);
    }
    flags[a.slice(2)] = val;
    i++;
  }
  return flags;
}

// --- Audit emit shorthand ---

function emitAudit(
  pd: string,
  eventType: string,
  fields: Record<string, string>,
  intent?: string,
  space?: string
): string {
  const result = appendAuditEntry(eventType, fields, pd, intent, space);
  return result.timestamp;
}

// --- Git invocation ---

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

function runGit(args: string[], cwd?: string): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, EDITOR: process.env.EDITOR ?? "false" },
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
    code: r.status ?? 1,
  };
}

interface RetainedSourceRef {
  ref: string;
  oid: string;
}

function retainedSourceRefs(repoCwd: string, slug: string): RetainedSourceRef[] | null {
  const prefix = reviewedSourceRefPrefix(slug);
  const listed = runGit(
    ["for-each-ref", "--format=%(refname)%09%(objectname)", prefix],
    repoCwd,
  );
  if (!listed.ok) return null;
  const refs: RetainedSourceRef[] = [];
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) return null;
    const ref = line.slice(0, tab);
    const oid = line.slice(tab + 1);
    if (!ref.startsWith(prefix) || !/^[0-9a-f]{40,64}$/.test(oid)) return null;
    refs.push({ ref, oid });
  }
  return refs;
}

function recordedWorktreeSelector(
  pd: string,
  slug: string,
): { intent: string; space: string } | null {
  const path = join(worktreePath(pd, slug), ".aidlc", WORKTREE_META_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      intentRecord?: unknown;
    };
    if (typeof parsed.intentRecord !== "string") return null;
    const matched = /^aidlc\/spaces\/([^/]+)\/intents\/([^/]+)$/.exec(
      parsed.intentRecord,
    );
    return matched === null ? null : { space: matched[1], intent: matched[2] };
  } catch {
    return null;
  }
}

// Compare-and-delete each ref: if another process moved one after enumeration,
// preserve it and report a cleanup failure instead of deleting newer evidence.
function deleteRetainedSourceRefs(repoCwd: string, refs: RetainedSourceRef[]): string | null {
  for (const retained of refs) {
    const deleted = runGit(["update-ref", "-d", retained.ref, retained.oid], repoCwd);
    if (!deleted.ok) {
      return deleted.stderr.trim() || deleted.stdout.trim() || `cannot delete ${retained.ref}`;
    }
  }
  return null;
}

// --- Sibling-worktree detection ---
//
// `aidlc-worktree` must run from the main repo checkout, not from a sibling
// worktree (e.g. `.claude/worktrees/<dev>/`). The main checkout is the
// directory whose `.git` is the same as `git rev-parse --git-common-dir`'s
// parent. macOS symlinks `/var → /private/var`, so canonicalise both sides
// via `realpathSync` before comparing.
//
// P7 (multi-repo): the guard is RE-ANCHORED to the TARGET repo's checkout. When
// `--repo <name>` selects a sibling repo, `repoCwd` is that repo dir and every
// git probe runs there — so "must run from the main checkout" is evaluated against
// the sibling repo, not the (non-git) workspace root. Absent `--repo` (legacy
// single-repo), `repoCwd` is the projectDir and the behaviour is unchanged.
function assertNotSiblingWorktree(repoCwd?: string): void {
  const top = runGit(["rev-parse", "--show-toplevel"], repoCwd);
  if (!top.ok) {
    error("Not a git repository (or any of the parent directories).");
  }
  const cwdTop = canonicalise(top.stdout.trim());

  const common = runGit(["rev-parse", "--git-common-dir"], repoCwd);
  if (!common.ok) {
    error("Cannot resolve git common dir.");
  }
  const commonRaw = common.stdout.trim();
  const commonAbs = resolve(cwdTop, commonRaw);
  const mainCheckout = canonicalise(dirname(commonAbs));

  if (cwdTop !== mainCheckout) {
    error(
      `aidlc-worktree must run from the main repo checkout, not from a sibling worktree at ${cwdTop}. Bolt worktrees are siblings of the main checkout, not nested.`
    );
  }
}

function canonicalise(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function pathKey(p: string): string {
  const normalised = canonicalise(resolve(p)).replace(/\\/g, "/");
  return process.platform === "win32" ? normalised.toLowerCase() : normalised;
}

// --- Validation helpers ---

function validateSlug(slug: string | undefined): string {
  if (!slug) error("Missing --slug <slug>");
  if (!SLUG_RE.test(slug)) {
    error(
      `Invalid --slug: "${slug}". Must be kebab-case (lowercase letter then [a-z0-9-]).`
    );
  }
  return slug;
}

function validateStrategy(strategy: string | undefined): string {
  if (!strategy) error("Missing --strategy <squash|merge|rebase>");
  if (!VALID_STRATEGIES.has(strategy)) {
    error(
      `Invalid --strategy: "${strategy}". Must be one of: squash, merge, rebase.`
    );
  }
  return strategy;
}

// Resolve the cwd every git op in a construction handler must run in (P7). With
// `--repo <name>` it is the sibling repo dir; absent it the lone recorded repo is
// inferred (or the projectDir for a legacy single-repo intent). A disambiguation
// failure (multi-repo intent without --repo, or an out-of-set name) errors before
// any audit emit. `flags.intent`/`flags.space` select the intent whose repo set is
// consulted (same selector the audit emit threads).
function resolveRepoCwd(
  pd: string,
  flags: Record<string, string>,
  slug: string,
): string {
  return resolveRepoTarget(pd, flags, slug).cwd;
}

function resolveRepoTarget(
  pd: string,
  flags: Record<string, string>,
  slug: string,
): { cwd: string; repo: string | null } {
  try {
    return resolveConstructionRepo(pd, flags.repo, flags.intent, flags.space);
  } catch (e) {
    errorWithSlug(slug, errorMessage(e));
  }
}

// --- Subcommand: create ---
//
// Usage: aidlc-worktree create --slug <slug> --base <branch> [--repo <name>]
//                              [--intent <dir>] [--space <name>]
//
// --repo (P7): the sibling repo to fork the worktree inside (a multi-repo intent
// requires it; a single-repo intent infers the lone repo; a legacy intent with no
// recorded repos runs in the projectDir, today's behaviour).
function rawBaseSourceListing(
  repoCwd: string,
  baseCommit: string,
): { serialized: string; hash: string } | null {
  const listing = gitCommitSourceListing(repoCwd, baseCommit);
  if (listing === null) return null;
  const serialized = serializeSourceListing(listing);
  if (parseSourceListing(serialized) === null) return null;
  return { serialized, hash: `sha256:${sourceListingSha256(serialized)}` };
}

function handleCreate(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  if (!flags.base) errorWithSlug(slug, "Missing --base <branch>");
  const swarmValues = [
    flags["swarm-unit"],
    flags["swarm-batch"],
    flags["swarm-stage"],
    flags["swarm-floor"],
  ];
  const hasSwarmValue = swarmValues.some((value) => value !== undefined);
  if (hasSwarmValue && swarmValues.some((value) => value === undefined)) {
    errorWithSlug(
      slug,
      "Swarm worktree creation requires --swarm-unit, --swarm-batch, --swarm-stage, and --swarm-floor together",
    );
  }
  const swarm =
    hasSwarmValue
      ? {
          unit: flags["swarm-unit"],
          batch: flags["swarm-batch"],
          stage: flags["swarm-stage"],
          floor: flags["swarm-floor"],
        }
      : null;
  if (swarm !== null) {
    const unitError = validateUnitName(swarm.unit);
    if (unitError !== null) errorWithSlug(slug, unitError);
    if (boltSlugForUnit(swarm.unit) !== slug) {
      errorWithSlug(
        slug,
        `Swarm unit ${JSON.stringify(swarm.unit)} does not map to Bolt slug ${JSON.stringify(slug)}`,
      );
    }
    if (!/^[1-9][0-9]*$/.test(swarm.batch)) {
      errorWithSlug(slug, "Swarm batch must be a positive integer");
    }
    if (!swarm.stage || !swarm.floor) {
      errorWithSlug(slug, "Swarm stage and run floor must be non-empty");
    }
  }

  const pd = resolveProjectDir(projectDir);
  const intentRecord = relativeRecordDir(pd, flags.intent, flags.space);
  // P7: anchor every git op to the target sibling repo (or the projectDir for a
  // legacy single-repo intent). The guard is evaluated against that same checkout.
  const repoCwd = resolveRepoCwd(pd, flags, slug);
  assertNotSiblingWorktree(repoCwd);

  // Pre-audit checks: every failure here exits without emitting.
  const baseExists = runGit(["rev-parse", "--verify", flags.base], repoCwd);
  if (!baseExists.ok) {
    errorWithSlug(slug, `Base branch does not exist locally: ${flags.base}`);
  }
  // Resolve the exact commit object before emitting or creating anything. The
  // durable per-worktree metadata lets swarm finalize read the fork point even
  // if the human-readable base branch moves later.
  const baseCommitResult = runGit(
    ["rev-parse", "--verify", `${flags.base}^{commit}`],
    repoCwd,
  );
  if (!baseCommitResult.ok) {
    errorWithSlug(slug, `Base branch does not resolve to a commit: ${flags.base}`);
  }
  const baseCommit = baseCommitResult.stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) {
    errorWithSlug(slug, `Base branch resolved to an invalid commit id: ${flags.base}`);
  }
  const rawBase = rawBaseSourceListing(repoCwd, baseCommit);
  if (rawBase === null) {
    errorWithSlug(slug, `Base source listing could not be computed for: ${flags.base}`);
  }

  const wtPath = worktreePath(pd, slug);
  if (existsSync(wtPath)) {
    errorWithSlug(slug, `Worktree directory already exists: ${wtPath}`);
  }

  const branchName = `bolt-${slug}`;
  const branchExists = runGit(["rev-parse", "--verify", `refs/heads/${branchName}`], repoCwd);
  if (branchExists.ok) {
    errorWithSlug(slug, `Branch already exists: ${branchName}`);
  }

  // Audit-first: emit BEFORE git so a kill-9 between emit and git surfaces
  // as "phantom WORKTREE_CREATED" reconciled by doctor (audit-of-intent
  // semantics — see docs/reference/12-state-machine.md).
  let auditTs: string;
  try {
    auditTs = emitAudit(pd, "WORKTREE_CREATED", {
      "Bolt slug": slug,
      "Worktree path": wtPath,
      "Branch name": branchName,
      "Base branch": flags.base,
      "Base commit": baseCommit,
      "Base Source Listing": rawBase.hash,
      ...(intentRecord ? { "Intent record": intentRecord } : {}),
      ...(swarm
        ? {
            "Swarm Unit": swarm.unit,
            "Swarm Batch": swarm.batch,
            "Swarm Stage": swarm.stage,
            "Swarm Run floor": swarm.floor,
          }
        : {}),
    }, flags.intent, flags.space);
  } catch (e) {
    errorWithSlug(slug, `Audit emission failed: ${errorMessage(e)}`);
  }

  // Create from the immutable object just attested above. Keeping flags.base
  // here would allow a concurrently-moved branch to fork a different tree than
  // WORKTREE_CREATED/worktree-meta.json record.
  const add = runGit(["worktree", "add", wtPath, "-b", branchName, baseCommit], repoCwd);
  if (!add.ok) {
    errorWithSlug(
      slug,
      `git worktree add failed: ${add.stderr.trim() || add.stdout.trim() || `exit ${add.code}`}`
    );
  }

  const metaPath = join(wtPath, ".aidlc", WORKTREE_META_FILENAME);
  const listingPath = join(wtPath, ".aidlc", WORKTREE_BASE_LISTING_FILENAME);
  try {
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileAtomic(listingPath, rawBase.serialized);
    writeFileAtomic(
      metaPath,
      `${JSON.stringify(
        {
          version: 1,
          boltSlug: slug,
          baseBranch: flags.base,
          baseCommit,
          baseSourceListing: rawBase.hash,
          ...(intentRecord ? { intentRecord } : {}),
          ...(swarm
            ? {
                swarmUnit: swarm.unit,
                swarmBatch: swarm.batch,
                swarmStage: swarm.stage,
                swarmFloor: swarm.floor,
              }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
  } catch (e) {
    errorWithSlug(slug, `Worktree metadata write failed: ${errorMessage(e)}`);
  }

  console.log(
    JSON.stringify({
      emitted: "WORKTREE_CREATED",
      slug,
      worktree_path: wtPath,
      branch: branchName,
      base: flags.base,
      base_commit: baseCommit,
      base_source_listing: rawBase.hash,
      audit_timestamp: auditTs,
    })
  );
}

// --- Subcommand: merge ---
//
// Usage:
//   aidlc-worktree merge --slug <slug> --target <branch> --strategy <squash|merge|rebase>
//                        [--message <msg>] [--repo <name>] [--intent <dir>] [--space <name>]
//
// --repo (P7): the sibling repo the merge lands in — same resolution as `create`.
// Refuse a source merge whose worktree no longer holds the bytes that
// converged. Reads the newest SWARM_UNIT_CONVERGED for this unit; a Bolt that
// never went through the swarm has none and passes straight through, and a
// convergence row from before this field existed carries no fingerprint and
// keeps the pre-existing behaviour. Off-switch: AIDLC_SKIP_SOURCE_FRESHNESS=1.
interface BoundConvergedSourceRecord {
  kind: "bound";
  fingerprint: string;
  commit: string;
  unit: string;
  batch: string;
  stage: string;
  floor: string;
}

interface BypassedConvergedSourceRecord {
  kind: "bypass";
  unit: string;
  batch: string;
  stage: string;
  floor: string;
}

type ConvergedSourceRecord =
  | BoundConvergedSourceRecord
  | BypassedConvergedSourceRecord;

function convergedUnitName(
  pd: string,
  slug: string,
  intent?: string,
  space?: string,
): string {
  const resolution = resolveBoltDag(pd, intent, space);
  if (resolution.state !== "ok") return slug;
  const match = resolution.units.find((unit) => boltSlugForUnit(unit) === slug);
  return match ?? slug;
}

type WorktreeAuditRow = ReturnType<typeof readAuditShardEvents>[number];

function sortWorktreeAuditRows(rows: WorktreeAuditRow[]): WorktreeAuditRow[] {
  return rows.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
}

function latestUnambiguousRow(
  slug: string,
  label: string,
  rows: WorktreeAuditRow[],
  identity: (row: WorktreeAuditRow) => string,
): WorktreeAuditRow | null {
  if (rows.length === 0) return null;
  sortWorktreeAuditRows(rows);
  const latestTimestamp = rows.at(-1)?.timestamp as string;
  const latest = rows.filter((row) => row.timestamp === latestTimestamp);
  if (
    new Set(latest.map((row) => row.shard)).size > 1 &&
    new Set(latest.map(identity)).size !== 1
  ) {
    errorWithSlug(
      slug,
      `refusing to merge: same-second cross-shard ${label} authority is ambiguous`,
    );
  }
  return latest.at(-1) ?? null;
}

function rowAfter(candidate: WorktreeAuditRow, boundary: WorktreeAuditRow): boolean {
  if (candidate.timestamp !== boundary.timestamp) {
    return candidate.timestamp > boundary.timestamp;
  }
  return candidate.shard === boundary.shard && candidate.pos > boundary.pos;
}

function convergedSourceRecord(
  pd: string,
  slug: string,
  repoCwd: string,
  intent?: string,
  space?: string,
): ConvergedSourceRecord | null {
  const wtPath = worktreePath(pd, slug);
  let worktreeMeta: {
    boltSlug: string;
    baseCommit: string;
    baseSourceListing: string;
    intentRecord?: string;
    swarmUnit?: string;
    swarmBatch?: string;
    swarmStage?: string;
    swarmFloor?: string;
  } | null = null;
  const metaPath = join(wtPath, ".aidlc", WORKTREE_META_FILENAME);
  if (existsSync(metaPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(metaPath, "utf-8"));
    } catch {
      errorWithSlug(
        slug,
        "refusing to merge: current worktree metadata is malformed",
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as Record<string, unknown>).boltSlug !== slug ||
      typeof (parsed as Record<string, unknown>).baseCommit !== "string" ||
      typeof (parsed as Record<string, unknown>).baseSourceListing !== "string"
    ) {
      errorWithSlug(
        slug,
        "refusing to merge: current worktree metadata is incomplete",
      );
    }
    worktreeMeta = {
      boltSlug: slug,
      baseCommit: (parsed as Record<string, string>).baseCommit,
      baseSourceListing: (parsed as Record<string, string>).baseSourceListing,
      ...(typeof (parsed as Record<string, unknown>).intentRecord === "string"
        ? { intentRecord: (parsed as Record<string, string>).intentRecord }
        : {}),
      ...(typeof (parsed as Record<string, unknown>).swarmUnit === "string"
        ? {
            swarmUnit: (parsed as Record<string, string>).swarmUnit,
            swarmBatch: (parsed as Record<string, string>).swarmBatch,
            swarmStage: (parsed as Record<string, string>).swarmStage,
            swarmFloor: (parsed as Record<string, string>).swarmFloor,
          }
        : {}),
    };
    const swarmMetaFields = [
      worktreeMeta.swarmUnit,
      worktreeMeta.swarmBatch,
      worktreeMeta.swarmStage,
      worktreeMeta.swarmFloor,
    ];
    const swarmMetaCount = swarmMetaFields.filter(
      (value) => value !== undefined,
    ).length;
    if (
      "intentRecord" in worktreeMeta &&
      (!worktreeMeta.intentRecord ||
        worktreeMeta.intentRecord !== relativeRecordDir(pd, intent, space))
    ) {
      const expected = recordedWorktreeSelector(pd, slug);
      const recovery = expected
        ? ` Retry with --space ${expected.space} --intent ${expected.intent}.`
        : "";
      errorWithSlug(
        slug,
        `refusing to merge: selected intent ${JSON.stringify(relativeRecordDir(pd, intent, space))} does not match worktree provenance ${JSON.stringify(worktreeMeta.intentRecord)}.${recovery}`,
      );
    }
    if (
      (swarmMetaCount !== 0 && swarmMetaCount !== swarmMetaFields.length) ||
      (worktreeMeta.swarmUnit !== undefined &&
        (validateUnitName(worktreeMeta.swarmUnit) !== null ||
          boltSlugForUnit(worktreeMeta.swarmUnit) !== slug ||
          !/^[1-9][0-9]*$/.test(worktreeMeta.swarmBatch ?? "") ||
          !worktreeMeta.swarmStage ||
          !worktreeMeta.swarmFloor))
    ) {
      errorWithSlug(
        slug,
        "refusing to merge: current worktree metadata selector/swarm provenance is invalid",
      );
    }
  }
  const retained = retainedSourceRefs(repoCwd, slug);
  if (retained === null) {
    errorWithSlug(slug, "refusing to merge: reviewed-source ref enumeration failed");
  }
  let requiresSwarmAuthority =
    retained.length > 0 || worktreeMeta?.swarmUnit !== undefined;
  let rows: WorktreeAuditRow[];
  try {
    rows = readAuditShardEvents(pd, intent, space);
  } catch {
    if (requiresSwarmAuthority) {
      errorWithSlug(
        slug,
        "refusing to merge: current modern worktree audit authority is unreadable",
      );
    }
    return null;
  }

  const creation = latestUnambiguousRow(
    slug,
    "WORKTREE_CREATED",
    rows.filter(
      (row) =>
        row.event === "WORKTREE_CREATED" &&
        auditBlockField(row.block, "Bolt slug") === slug &&
        (() => {
          const recordedPath = auditBlockField(row.block, "Worktree path");
          return recordedPath !== null && pathKey(recordedPath) === pathKey(wtPath);
        })(),
    ),
    (row) =>
      [
        auditBlockField(row.block, "Base commit") ?? "",
        auditBlockField(row.block, "Base Source Listing") ?? "",
        auditBlockField(row.block, "Branch name") ?? "",
      ].join("\0"),
  );
  if (creation === null) {
    if (requiresSwarmAuthority) {
      errorWithSlug(
        slug,
        "refusing to merge: current modern worktree has no WORKTREE_CREATED authority",
      );
    }
    return null;
  }
  const creationSwarmFields = [
    auditBlockField(creation.block, "Swarm Unit"),
    auditBlockField(creation.block, "Swarm Batch"),
    auditBlockField(creation.block, "Swarm Stage"),
    auditBlockField(creation.block, "Swarm Run floor"),
  ];
  const creationSwarmCount = creationSwarmFields.filter(
    (value) => value !== null,
  ).length;
  if (creationSwarmCount !== 0 && creationSwarmCount !== creationSwarmFields.length) {
    errorWithSlug(
      slug,
      "refusing to merge: WORKTREE_CREATED carries incomplete swarm provenance",
    );
  }
  const creationSwarmUnit = creationSwarmFields[0] ?? undefined;
  const creationSwarmBatch = creationSwarmFields[1] ?? undefined;
  const creationSwarmStage = creationSwarmFields[2] ?? undefined;
  const creationSwarmFloor = creationSwarmFields[3] ?? undefined;
  if (
    creationSwarmUnit !== undefined &&
    (validateUnitName(creationSwarmUnit) !== null ||
      boltSlugForUnit(creationSwarmUnit) !== slug ||
      !/^[1-9][0-9]*$/.test(creationSwarmBatch ?? "") ||
      !creationSwarmStage ||
      !creationSwarmFloor)
  ) {
    errorWithSlug(
      slug,
      "refusing to merge: WORKTREE_CREATED swarm provenance is invalid",
    );
  }
  requiresSwarmAuthority ||= creationSwarmUnit !== undefined;

  const mappedUnits = new Set<string>();
  for (const row of rows) {
    if (!rowAfter(row, creation)) continue;
    if (row.event === "SWARM_STARTED") {
      for (const unit of (auditBlockField(row.block, "Unit names") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)) {
        if (boltSlugForUnit(unit) === slug) mappedUnits.add(unit);
      }
    } else if (row.event === "SWARM_UNIT_CONVERGED") {
      const unit = auditBlockField(row.block, "Unit name");
      if (unit && boltSlugForUnit(unit) === slug) mappedUnits.add(unit);
    }
  }
  if (mappedUnits.size > 1) {
    errorWithSlug(
      slug,
      `refusing to merge: multiple swarm Units map to Bolt slug "${slug}"`,
    );
  }
  requiresSwarmAuthority ||= mappedUnits.size > 0;
  const creationBaseCommit = auditBlockField(creation.block, "Base commit");
  const creationBaseListing = auditBlockField(
    creation.block,
    "Base Source Listing",
  );
  const creationModern =
    creationBaseCommit !== null || creationBaseListing !== null;
  const durableModernWorktree = worktreeMeta !== null || retained.length > 0;
  const modernWorktree = durableModernWorktree || creationModern;
  if (modernWorktree && (!creationBaseCommit || !creationBaseListing)) {
    errorWithSlug(
      slug,
      "refusing to merge: durable modern worktree evidence is inconsistent with the current WORKTREE_CREATED source attestation",
    );
  }

  if (modernWorktree) {
    if (worktreeMeta === null) {
      errorWithSlug(
        slug,
        "refusing to merge: current worktree metadata is missing",
      );
    }
    if (
      worktreeMeta.baseCommit !== creationBaseCommit ||
      worktreeMeta.baseSourceListing !== creationBaseListing ||
      (worktreeMeta.intentRecord !== undefined &&
        auditBlockField(creation.block, "Intent record") !==
          worktreeMeta.intentRecord) ||
      (worktreeMeta.swarmUnit !== creationSwarmUnit ||
        worktreeMeta.swarmBatch !== creationSwarmBatch ||
        worktreeMeta.swarmStage !== creationSwarmStage ||
        worktreeMeta.swarmFloor !== creationSwarmFloor)
    ) {
      errorWithSlug(
        slug,
        "refusing to merge: current worktree metadata does not match WORKTREE_CREATED",
      );
    }
  }
  const unitName =
    worktreeMeta?.swarmUnit ??
    creationSwarmUnit ??
    mappedUnits.values().next().value ??
    convergedUnitName(pd, slug, intent, space);

  const boltStart = latestUnambiguousRow(
    slug,
    "BOLT_STARTED",
    rows.filter(
      (row) =>
        row.event === "BOLT_STARTED" &&
        auditBlockField(row.block, "Bolt slug") === slug &&
        rowAfter(row, creation),
    ),
    (row) =>
      [
        auditBlockField(row.block, "Batch number") ?? "",
        auditBlockField(row.block, "Base commit") ?? "",
        auditBlockField(row.block, "Base Source Listing") ?? "",
      ].join("\0"),
  );
  if (boltStart === null) {
    if (requiresSwarmAuthority) {
      errorWithSlug(
        slug,
        "refusing to merge: current modern worktree has no BOLT_STARTED authority",
      );
    }
    return null;
  }
  const batch = auditBlockField(boltStart.block, "Batch number");
  const boltUnit = auditBlockField(boltStart.block, "Bolt names");
  if (!batch || !/^[1-9][0-9]*$/.test(batch)) {
    errorWithSlug(
      slug,
      "refusing to merge: current BOLT_STARTED has no valid batch number",
    );
  }
  if (
    requiresSwarmAuthority &&
    (!boltUnit ||
      boltUnit.includes(",") ||
      boltSlugForUnit(boltUnit) !== slug ||
      boltUnit !== unitName ||
      (worktreeMeta?.swarmBatch !== undefined &&
        worktreeMeta.swarmBatch !== batch))
  ) {
    errorWithSlug(
      slug,
      "refusing to merge: current BOLT_STARTED does not match swarm worktree provenance",
    );
  }
  if (
    modernWorktree &&
    (auditBlockField(boltStart.block, "Base commit") !== creationBaseCommit ||
      auditBlockField(boltStart.block, "Base Source Listing") !==
        creationBaseListing)
  ) {
    errorWithSlug(
      slug,
      "refusing to merge: current BOLT_STARTED does not match WORKTREE_CREATED",
    );
  }

  const swarmStart = latestUnambiguousRow(
    slug,
    "SWARM_STARTED",
    rows.filter(
      (row) =>
        row.event === "SWARM_STARTED" &&
        auditBlockField(row.block, "Batch number") === batch &&
        (auditBlockField(row.block, "Unit names") ?? "")
          .split(",")
          .map((unit) => unit.trim())
          .includes(unitName) &&
        rowAfter(row, creation) &&
        rowAfter(row, boltStart),
    ),
    (row) =>
      [
        auditBlockField(row.block, "Stage") ?? "",
        auditBlockField(row.block, "Run floor") ?? "",
        auditBlockField(row.block, "Unit names") ?? "",
      ].join("\0"),
  );
  if (swarmStart === null) {
    if (requiresSwarmAuthority) {
      errorWithSlug(
        slug,
        "refusing to merge: current autonomous worktree has no SWARM_STARTED authority",
      );
    }
    return null; // ordinary non-swarm Bolt
  }
  const stage = auditBlockField(swarmStart.block, "Stage");
  const floor = auditBlockField(swarmStart.block, "Run floor");
  if (!stage || !floor) {
    if (!modernWorktree) return null; // pre-binding swarm migration
    errorWithSlug(
      slug,
      "refusing to merge: current modern SWARM_STARTED lacks Stage/Run floor authority",
    );
  }
  if (
    worktreeMeta?.swarmStage !== undefined &&
    (worktreeMeta.swarmStage !== stage ||
      worktreeMeta.swarmFloor !== floor ||
      worktreeMeta.swarmBatch !== batch)
  ) {
    errorWithSlug(
      slug,
      "refusing to merge: current SWARM_STARTED does not match worktree provenance",
    );
  }
  let selectedState: string;
  try {
    selectedState = readStateFile(pd, intent, space);
  } catch {
    errorWithSlug(
      slug,
      "refusing to merge: current swarm state is unavailable",
    );
  }
  const currentStage = getField(selectedState, "Current Stage")?.trim();
  const currentFloor = latestMainWorkflowStageRunFloorForProject(
    pd,
    stage,
    false,
    intent,
    space,
  );
  if (currentStage !== stage || currentFloor !== floor) {
    errorWithSlug(
      slug,
      "refusing to merge: this convergence belongs to a stale stage attempt",
    );
  }

  const latest = latestUnambiguousRow(
    slug,
    "SWARM_UNIT_CONVERGED",
    rows.filter(
      (row) =>
        row.event === "SWARM_UNIT_CONVERGED" &&
        auditBlockField(row.block, "Unit name") === unitName &&
        auditBlockField(row.block, "Batch number") === batch &&
        auditBlockField(row.block, "Stage") === stage &&
        auditBlockField(row.block, "Run floor") === floor &&
        rowAfter(row, swarmStart),
    ),
    (row) =>
      [
        auditBlockField(row.block, "Source Fingerprint") ?? "",
        auditBlockField(row.block, "Source Commit") ?? "",
        auditBlockField(row.block, "Source Freshness Bypass") ?? "",
      ].join("\0"),
  );
  if (latest === null) {
    errorWithSlug(
      slug,
      "refusing to merge: the current swarm worktree has no correlated convergence authority; rerun finalize",
    );
  }

  const bypass =
    auditBlockField(latest.block, "Source Freshness Bypass") ?? undefined;
  const fingerprint =
    auditBlockField(latest.block, "Source Fingerprint") ?? undefined;
  const commit = auditBlockField(latest.block, "Source Commit") ?? undefined;
  if (bypass !== undefined) {
    if (bypass !== "true") {
      errorWithSlug(slug, `refusing to merge: invalid Source Freshness Bypass marker "${bypass}"`);
    }
    if (fingerprint || commit) {
      errorWithSlug(
        slug,
        "refusing to merge: convergence mixes bypass and bound source authority",
      );
    }
    if (process.env.AIDLC_SKIP_SOURCE_FRESHNESS === "1") {
      return { kind: "bypass", unit: unitName, batch, stage, floor };
    }
    errorWithSlug(
      slug,
      `refusing to merge: this convergence was finalized with source freshness bypassed; ` +
        `retry this merge with AIDLC_SKIP_SOURCE_FRESHNESS=1, or run ` +
        `'aidlc-worktree discard --slug ${slug}' and redo the unit from prepare through review/finalize`,
    );
  }
  if (process.env.AIDLC_SKIP_SOURCE_FRESHNESS === "1") return null;
  if (!fingerprint || !commit) {
    if (!modernWorktree && !fingerprint && !commit) return null;
    errorWithSlug(
      slug,
      "refusing to merge: the current modern convergence row lacks complete immutable source authority; rerun finalize",
    );
  }
  if (fingerprint === UNBINDABLE_FINGERPRINT) {
    errorWithSlug(slug, "refusing to merge: this convergence receipt is unbindable; re-run review and finalize with Git available");
  }
  if (!/^[0-9a-f]{40,64}$/.test(fingerprint) || !/^[0-9a-f]{40,64}$/.test(commit)) {
    errorWithSlug(
      slug,
      "refusing to merge: the current convergence source authority is malformed",
    );
  }
  return {
    kind: "bound",
    fingerprint,
    commit,
    unit: unitName,
    batch,
    stage,
    floor,
  };
}

function assertConvergedSourceUnchanged(
  slug: string,
  wtPath: string,
  record: ConvergedSourceRecord | null,
): string | null {
  if (!record || record.kind === "bypass") return null;
  const current = workspaceSourceFingerprint(wtPath);
  if (current === null || current !== record.fingerprint) {
    errorWithSlug(
      slug,
      `refusing to merge: the worktree source no longer matches the state this unit ` +
        `converged with (source-fingerprint mismatch). Re-run the swarm's convergence ` +
        `check for "${slug}" against the current worktree, or discard the worktree.`,
    );
  }
  const object = runGit(["cat-file", "-e", `${record.commit}^{commit}`], wtPath);
  if (!object.ok) {
    errorWithSlug(slug, `refusing to merge: reviewed Source Commit ${record.commit} is unavailable`);
  }
  return record.commit;
}

function sourceListingsEqual(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!sourceListingEntriesEqual(right.get(key), value)) return false;
  }
  return true;
}

function changedSourceListingKeys(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): Set<string> {
  const changed = new Set<string>();
  for (const [key, value] of left) {
    if (!sourceListingEntriesEqual(right.get(key), value)) changed.add(key);
  }
  for (const key of right.keys()) {
    if (!left.has(key)) changed.add(key);
  }
  return changed;
}

function changedSourceListingPaths(
  left: ReadonlyMap<string, string>,
  right: ReadonlyMap<string, string>,
): string[] {
  return [...changedSourceListingKeys(left, right)]
    .sort()
    .slice(0, 10)
    .map((key) => {
      const separator = key.indexOf("\0");
      const repo = separator === -1 ? "" : key.slice(0, separator);
      const path = separator === -1 ? key : key.slice(separator + 1);
      return repo ? `${repo}/${path}` : path;
    });
}

function assertAggregateSourceBeforeMerge(
  pd: string,
  slug: string,
  record: ConvergedSourceRecord | null,
  intent?: string,
  space?: string,
): WorkspaceSourceState | null {
  if (!record || record.kind === "bypass") return null;
  const current = workspaceSourceState(pd, intent, space);
  if (current === null) {
    errorWithSlug(
      slug,
      "refusing to merge: the main checkout source aggregate is unbindable",
    );
  }
  const chain = currentSwarmSourceMergeChain(
    pd,
    record.stage,
    intent,
    space,
  );
  if (chain.state === "invalid") {
    errorWithSlug(
      slug,
      `refusing to merge: the current swarm source-merge chain is invalid (${chain.reason})`,
    );
  }
  if (chain.state === "ready") {
    if (chain.units.has(record.unit)) {
      errorWithSlug(
        slug,
        `refusing to merge: unit "${record.unit}" already has current-attempt source-merge authority`,
      );
    }
    if (current.fingerprint !== chain.fingerprint) {
      errorWithSlug(
        slug,
        "refusing to merge: the main checkout source changed after the previous reviewed-source merge",
      );
    }
    return current;
  }

  const opening = currentSwarmSourceOpeningFingerprint(
    pd,
    record.stage,
    intent,
    space,
  );
  if (opening.state === "invalid") {
    errorWithSlug(
      slug,
      `refusing to merge: the current stage has no verifiable predecessor for the first aggregate link (${opening.reason})`,
    );
  }
  if (
    opening.source === "stage-baseline" &&
    opening.listing !== undefined &&
    !sourceListingsEqual(current.listing, opening.listing)
  ) {
    const changed = changedSourceListingPaths(
      current.listing,
      opening.listing,
    );
    errorWithSlug(
      slug,
      `refusing to merge: the main checkout source changed since the stage-entry baseline (${changed.join(", ") || "unknown paths"})`,
    );
  }
  if (
    opening.source === "prior-accepted" &&
    current.fingerprint !== opening.fingerprint
  ) {
    errorWithSlug(
      slug,
      "refusing to merge: the main checkout source does not match the prior attempt's final reviewed aggregate",
    );
  }
  return current;
}

function reviewedSourceChangedPathKeys(
  repoCwd: string,
  sourceCommit: string,
  repo: string | null,
): Set<string> | null {
  const changed = runGit(
    [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      "--no-renames",
      `${sourceCommit}^`,
      sourceCommit,
    ],
    repoCwd,
  );
  if (!changed.ok) return null;
  return new Set(
    changed.stdout
      .split("\0")
      .filter(Boolean)
      .map((path) => `${repo ?? ""}\0${path}`),
  );
}

function renderSourcePathKeys(keys: Iterable<string>): string {
  return [...keys]
    .sort()
    .slice(0, 10)
    .map((key) => {
      const separator = key.indexOf("\0");
      const repo = separator === -1 ? "" : key.slice(0, separator);
      const path = separator === -1 ? key : key.slice(separator + 1);
      return repo ? `${repo}/${path}` : path;
    })
    .join(", ");
}

function handleMerge(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  if (!flags.target) errorWithSlug(slug, "Missing --target <branch>");
  const strategy = validateStrategy(flags.strategy);
  const message = flags.message ?? `Bolt ${slug}`;

  const pd = resolveProjectDir(projectDir);
  if (flags.intent === undefined && flags.space === undefined) {
    const recorded = recordedWorktreeSelector(pd, slug);
    if (recorded !== null) {
      flags.intent = recorded.intent;
      flags.space = recorded.space;
    }
  }
  // P7: anchor every git op to the target sibling repo. The merge runs IN that
  // repo's main checkout (squash/merge/ff/commit/worktree-remove/branch-D); the
  // rebase still runs in the worktree (wtPath). Legacy single-repo → repoCwd=pd.
  const repoTarget = resolveRepoTarget(pd, flags, slug);
  const repoCwd = repoTarget.cwd;
  assertNotSiblingWorktree(repoCwd);

  // Defensive HEAD check: the caller must have <target> checked out at the repo cwd.
  const head = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoCwd);
  if (!head.ok) {
    errorWithSlug(slug, "Cannot resolve HEAD.");
  }
  const actual = head.stdout.trim();
  if (actual === "HEAD") {
    errorWithSlug(
      slug,
      `expected branch ${flags.target}, found detached HEAD`
    );
  }
  if (actual !== flags.target) {
    errorWithSlug(
      slug,
      `expected branch ${flags.target}, found ${actual}`
    );
  }

  const wtPath = worktreePath(pd, slug);
  const branchName = `bolt-${slug}`;
  const sourceRecord = convergedSourceRecord(
    pd,
    slug,
    repoCwd,
    flags.intent,
    flags.space,
  );
  const aggregateBefore = assertAggregateSourceBeforeMerge(
    pd,
    slug,
    sourceRecord,
    flags.intent,
    flags.space,
  );
  if (sourceRecord?.kind === "bound" && strategy === "rebase") {
    errorWithSlug(
      slug,
      "refusing to rebase a source-bound convergence: rebase before review/finalize, then merge the immutable reviewed commit",
    );
  }
  if (sourceRecord?.kind === "bypass") {
    const applicationStatus = runGit([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
    ], wtPath);
    if (!applicationStatus.ok) {
      errorWithSlug(
        slug,
        `cannot inspect bypassed application source: ${applicationStatus.stderr.trim() || `exit ${applicationStatus.code}`}`,
      );
    }
    const applicationLines = applicationStatus.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        const path = line.slice(3);
        if (path.startsWith("aidlc/")) return false;
        if (path.startsWith(".aidlc/")) return false;
        return !/(?:^|\/)aidlc\/spaces\/[^/]+\/intents\/.*\/\.aidlc-sensors(?:\/|$)/.test(
          path,
        );
      });
    if (applicationLines.length > 0) {
      const detail = applicationLines.join(", ");
      errorWithSlug(
        slug,
        `refusing to merge: the bypassed Bolt has uncommitted or ignored application paths not represented by its branch (${detail}); commit, remove, or discard those paths before retrying`,
      );
    }
  }

  // Rebase requires a remote for <target>. The remote-existence check is
  // a pre-audit guard (no state change). The actual `git fetch` is post-
  // audit because fetch mutates remote-tracking refs — running it before
  // the audit emit would leave a kill-9 window where refs moved without
  // a corresponding audit row.
  let rebaseRemote = "";
  if (strategy === "rebase") {
    const remote = runGit(["config", `branch.${flags.target}.remote`], repoCwd);
    if (!remote.ok || !remote.stdout.trim()) {
      errorWithSlug(
        slug,
        `rebase strategy requires a remote for ${flags.target}; got none`
      );
    }
    rebaseRemote = remote.stdout.trim();
  }

  // Audit-first: emit BEFORE any state-mutating git command (including the
  // rebase pre-fetch).
  let auditTs: string;
  try {
    auditTs = emitAudit(pd, "WORKTREE_MERGED", {
      "Bolt slug": slug,
      "Worktree path": wtPath,
      "Target branch": flags.target,
      Strategy: strategy,
    }, flags.intent, flags.space);
  } catch (e) {
    errorWithSlug(slug, `Audit emission failed: ${errorMessage(e)}`);
  }

  if (strategy === "rebase") {
    const fetch = runGit(["fetch", rebaseRemote], wtPath);
    if (!fetch.ok) {
      errorWithSlug(
        slug,
        `git fetch failed: ${fetch.stderr.trim() || fetch.stdout.trim() || `exit ${fetch.code}`}`
      );
    }
  }

  // This is the last guard before source mutation. The convergence selector is
  // the requested intent/space, and the returned target is an immutable commit
  // object rather than the movable bolt-<slug> branch.
  let mergeTarget = assertConvergedSourceUnchanged(slug, wtPath, sourceRecord) ?? branchName;
  let bypassBranchOid = "";
  if (sourceRecord?.kind === "bypass" && strategy !== "rebase") {
    const branchOid = runGit(["rev-parse", `${branchName}^{commit}`], repoCwd);
    if (!branchOid.ok || !branchOid.stdout.trim()) {
      errorWithSlug(slug, "cannot resolve the bypassed Bolt branch commit");
    }
    bypassBranchOid = branchOid.stdout.trim();
    mergeTarget = bypassBranchOid;
  }

  let commitSha = "";
  // conflictCwd records which checkout the conflicting state lives in:
  // squash/merge run in the target repo's main checkout (cwd = repoCwd), rebase
  // runs in the worktree (cwd = wtPath). For conflict-file enumeration, we query
  // `git diff --name-only --diff-filter=U` in the SAME cwd so the index reflects
  // the real conflict. (P7: repoCwd is the sibling repo, or the projectDir for a
  // legacy single-repo intent — squash/merge default to it now, not the caller's cwd.)
  let conflictCwd: string | undefined = repoCwd;
  let conflictHit = false;
  switch (strategy) {
    case "squash": {
      const m = runGit(["merge", "--squash", mergeTarget], repoCwd);
      if (!m.ok) {
        if (isConflict(m)) {
          conflictHit = true;
          break;
        }
        errorWithSlug(
          slug,
          `git merge --squash failed: ${m.stderr.trim() || `exit ${m.code}`}`
        );
      }
      const c = runGit(["commit", "--no-edit", "-m", message], repoCwd);
      if (!c.ok) {
        errorWithSlug(
          slug,
          `git commit failed: ${c.stderr.trim() || `exit ${c.code}`}`
        );
      }
      commitSha = currentSha(repoCwd);
      break;
    }
    case "merge": {
      const m = runGit([
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `Merge bolt ${slug}`,
        mergeTarget,
      ], repoCwd);
      if (!m.ok) {
        if (isConflict(m)) {
          conflictHit = true;
          break;
        }
        errorWithSlug(
          slug,
          `git merge --no-ff failed: ${m.stderr.trim() || `exit ${m.code}`}`
        );
      }
      commitSha = currentSha(repoCwd);
      break;
    }
    case "rebase": {
      const r = runGit(["rebase", flags.target], wtPath);
      if (!r.ok) {
        if (isConflict(r)) {
          conflictHit = true;
          conflictCwd = wtPath;
          break;
        }
        errorWithSlug(
          slug,
          `git rebase failed: ${r.stderr.trim() || `exit ${r.code}`}`
        );
      }
      const ffTarget =
        sourceRecord?.kind === "bypass"
          ? currentSha(wtPath)
          : mergeTarget;
      if (sourceRecord?.kind === "bypass") bypassBranchOid = ffTarget;
      const ff = runGit(["merge", "--ff-only", ffTarget], repoCwd);
      if (!ff.ok) {
        errorWithSlug(
          slug,
          `git merge --ff-only failed: ${ff.stderr.trim() || `exit ${ff.code}`}`
        );
      }
      commitSha = currentSha(repoCwd);
      break;
    }
  }

  if (conflictHit) {
    const files = listConflictFiles(conflictCwd);
    process.stdout.write(
      `${JSON.stringify({
        status: "conflict",
        slug,
        worktree_path: wtPath,
        conflict_files: files,
        detail: `Merge produced conflicts in worktree at ${wtPath}. Worktree preserved for inspection.`,
      })}\n`
    );
    process.exit(1);
  }

  // Cleanup: remove worktree + delete branch. The merge commit at
  // <commitSha> is now permanent on <target> — failures here leave an
  // orphan worktree directory and/or branch but DO NOT roll back the
  // merge. Tag the error message with [merge-succeeded:<sha>] so the
  // ERROR_LOGGED row carries enough state for doctor to tell
  // "merge failed entirely" from "merge landed, cleanup orphan remains"
  // — these need different recovery actions.
  const cleanupTag = `[merge-succeeded:${commitSha}]`;
  if (sourceRecord?.kind === "bound") {
    const aggregateAfter = workspaceSourceState(pd, flags.intent, flags.space);
    if (aggregateBefore === null || aggregateAfter === null) {
      errorWithSlug(
        slug,
        `${cleanupTag} cannot bind the post-merge main-checkout source aggregate; worktree and retained source commit preserved`,
      );
    }
    const reviewedChanges = reviewedSourceChangedPathKeys(
      repoCwd,
      sourceRecord.commit,
      repoTarget.repo,
    );
    if (reviewedChanges === null) {
      errorWithSlug(
        slug,
        `${cleanupTag} cannot verify the immutable reviewed commit's source footprint; no SWARM_SOURCE_MERGED authority was emitted. Do not retry this merge. Preserve the worktree and restart the stage attempt.`,
      );
    }
    const extraChanges = [...changedSourceListingKeys(
      aggregateBefore.listing,
      aggregateAfter.listing,
    )].filter((path) => !reviewedChanges.has(path));
    if (extraChanges.length > 0) {
      errorWithSlug(
        slug,
        `${cleanupTag} post-merge source contains path changes outside immutable reviewed commit ${sourceRecord.commit} (${renderSourcePathKeys(extraChanges) || "unknown paths"}); no SWARM_SOURCE_MERGED authority was emitted. Do not retry this merge. Preserve the worktree and restart the stage attempt.`,
      );
    }
    try {
      emitAudit(
        pd,
        "SWARM_SOURCE_MERGED",
        {
          "Batch number": sourceRecord.batch,
          "Unit name": sourceRecord.unit,
          Stage: sourceRecord.stage,
          "Run floor": sourceRecord.floor,
          "Previous Source Fingerprint": aggregateBefore.fingerprint,
          "Source Fingerprint": aggregateAfter.fingerprint,
          "Source Commit": sourceRecord.commit,
          "Merge commit": commitSha,
        },
        flags.intent,
        flags.space,
      );
    } catch (e) {
      errorWithSlug(
        slug,
        `${cleanupTag} post-merge source authority emission failed (${errorMessage(e)}); the source merge landed but no aggregate receipt exists. Do not retry this merge. Preserve the worktree and restart the stage attempt, or use AIDLC_SKIP_SOURCE_FRESHNESS=1 only with explicit human approval.`,
      );
    }
  }
  if (sourceRecord?.kind === "bypass") {
    const currentBranchOid = runGit(["rev-parse", `${branchName}^{commit}`], repoCwd);
    if (
      !bypassBranchOid ||
      !currentBranchOid.ok ||
      currentBranchOid.stdout.trim() !== bypassBranchOid
    ) {
      errorWithSlug(
        slug,
        `${cleanupTag} bypassed Bolt branch changed during the merge; worktree and branch preserved`,
      );
    }
  }
  // A swarm snapshot does not move the Bolt branch, so reviewed application
  // files may still be modified/untracked in this disposable checkout. Once
  // that immutable source has landed, align the checkout to it before forced
  // removal.
  if (sourceRecord?.kind === "bound") {
    const align = runGit(["reset", "--hard", mergeTarget], wtPath);
    if (!align.ok) {
      errorWithSlug(
        slug,
        `${cleanupTag} reviewed-source cleanup reset failed: ${align.stderr.trim() || `exit ${align.code}`}`,
      );
    }
  } else if (sourceRecord?.kind === "bypass") {
    // Finalization writes framework metadata into the Bolt even when source
    // freshness is bypassed. Remove only that known residue so ordinary
    // worktree removal can still protect uncommitted application source.
    const frameworkPaths = [
      ":(top)aidlc/",
      ":(top).aidlc/",
      ":(glob)**/aidlc/spaces/*/intents/**/.aidlc-sensors/**",
    ];
    for (const frameworkPath of frameworkPaths) {
      const tracked = runGit(["ls-files", "-z", "--", frameworkPath], wtPath);
      if (!tracked.ok) {
        errorWithSlug(
          slug,
          `${cleanupTag} bypass cleanup path enumeration failed: ${tracked.stderr.trim() || `exit ${tracked.code}`}`,
        );
      }
      if (tracked.stdout.length === 0) continue;
      const restore = runGit(
        ["checkout", "--force", "HEAD", "--", frameworkPath],
        wtPath,
      );
      if (!restore.ok) {
        errorWithSlug(
          slug,
          `${cleanupTag} bypass cleanup reset failed: ${restore.stderr.trim() || `exit ${restore.code}`}`,
        );
      }
    }
    const clean = runGit(["clean", "-ffdx", "--", ...frameworkPaths], wtPath);
    if (!clean.ok) {
      errorWithSlug(
        slug,
        `${cleanupTag} bypass cleanup failed: ${clean.stderr.trim() || `exit ${clean.code}`}`,
      );
    }
    const remainingApplicationStatus = runGit([
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
    ], wtPath);
    if (!remainingApplicationStatus.ok) {
      errorWithSlug(
        slug,
        `${cleanupTag} cannot recheck bypassed application source: ${remainingApplicationStatus.stderr.trim() || `exit ${remainingApplicationStatus.code}`}`,
      );
    }
    const remainingApplicationLines = remainingApplicationStatus.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        const path = line.slice(3);
        if (path.startsWith("aidlc/")) return false;
        if (path.startsWith(".aidlc/")) return false;
        return !/(?:^|\/)aidlc\/spaces\/[^/]+\/intents\/.*\/\.aidlc-sensors(?:\/|$)/.test(
          path,
        );
      });
    if (remainingApplicationLines.length > 0) {
      errorWithSlug(
        slug,
        `${cleanupTag} application source changed during the bypassed merge; worktree preserved`,
      );
    }
  }
  // A raw-byte snapshot can remain permanently "modified" under its own lossy
  // clean filter even after reset (Git re-cleans the raw index blob for status).
  // The successful hard reset to the immutable source above authorizes forced
  // removal of that bound checkout. Bypassed and ordinary Bolt cleanup remains
  // non-forced so application source cannot be discarded silently.
  const rm = runGit(
    sourceRecord?.kind === "bound"
      ? ["worktree", "remove", "--force", wtPath]
      : ["worktree", "remove", wtPath],
    repoCwd,
  );
  if (!rm.ok) {
    errorWithSlug(
      slug,
      `${cleanupTag} worktree remove failed: ${rm.stderr.trim() || `exit ${rm.code}`}`
    );
  }
  const del =
    sourceRecord?.kind === "bypass"
      ? runGit(
          ["update-ref", "-d", `refs/heads/${branchName}`, bypassBranchOid],
          repoCwd,
        )
      : runGit(["branch", "-D", branchName], repoCwd);
  if (!del.ok) {
    errorWithSlug(
      slug,
      `${cleanupTag} branch -D ${branchName} failed: ${del.stderr.trim() || `exit ${del.code}`}`
    );
  }
  const retained = retainedSourceRefs(repoCwd, slug);
  if (retained === null) {
    errorWithSlug(slug, `${cleanupTag} reviewed-source ref enumeration failed`);
  }
  const refCleanupError = deleteRetainedSourceRefs(repoCwd, retained);
  if (refCleanupError) {
    errorWithSlug(slug, `${cleanupTag} reviewed-source ref cleanup failed: ${refCleanupError}`);
  }

  console.log(
    JSON.stringify({
      emitted: "WORKTREE_MERGED",
      slug,
      worktree_path: wtPath,
      target: flags.target,
      strategy,
      commit_sha: commitSha,
      audit_timestamp: auditTs,
    })
  );
}

function currentSha(cwd?: string): string {
  const r = runGit(["rev-parse", "HEAD"], cwd);
  return r.ok ? r.stdout.trim() : "";
}

function isConflict(r: GitResult): boolean {
  // Anchor on git's canonical CONFLICT marker prefix. The previous
  // permissive form (`/conflict/i` etc.) false-positived on stdout that
  // happened to contain the substring "conflict" — including unrelated
  // hint text in future git releases.
  const blob = `${r.stdout}\n${r.stderr}`;
  return /^CONFLICT \(/m.test(blob);
}

function listConflictFiles(cwd?: string): string[] {
  // `git diff --name-only --diff-filter=U` enumerates unmerged paths in
  // the index. Deterministic across all conflict shapes (content, rename/
  // rename, modify/delete) — beats parsing git's prose stderr, which has
  // varied across git releases.
  const r = runGit(["diff", "--name-only", "--diff-filter=U"], cwd);
  if (!r.ok) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// --- Subcommand: discard ---
//
// Usage: aidlc-worktree discard --slug <slug> [--repo <name>]
//                               [--intent <dir>] [--space <name>]
//
// --repo (P7): the sibling repo the worktree was forked in — same resolution as
// `create`. Idempotent: if neither directory nor branch exists, succeeds silently
// without re-emitting audit.
function handleDiscard(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  const pd = resolveProjectDir(projectDir);
  // P7: anchor every git op to the target sibling repo (or projectDir for legacy).
  const repoCwd = resolveRepoCwd(pd, flags, slug);
  assertNotSiblingWorktree(repoCwd);

  const wtPath = worktreePath(pd, slug);
  const branchName = `bolt-${slug}`;
  const dirExists = existsSync(wtPath);
  const branchExists = runGit([
    "rev-parse",
    "--verify",
    `refs/heads/${branchName}`,
  ], repoCwd).ok;
  const retained = retainedSourceRefs(repoCwd, slug);
  if (retained === null) {
    errorWithSlug(slug, "reviewed-source ref enumeration failed");
  }

  if (!dirExists && !branchExists && retained.length === 0) {
    console.log(
      JSON.stringify({
        emitted: null,
        slug,
        worktree_path: wtPath,
        reason: "already-discarded",
      })
    );
    return;
  }

  let auditTs: string;
  try {
    auditTs = emitAudit(pd, "WORKTREE_DISCARDED", {
      "Bolt slug": slug,
      "Worktree path": wtPath,
      Reason: "agent-discard",
    }, flags.intent, flags.space);
  } catch (e) {
    errorWithSlug(slug, `Audit emission failed: ${errorMessage(e)}`);
  }

  if (dirExists) {
    const rm = runGit(["worktree", "remove", "--force", wtPath], repoCwd);
    if (!rm.ok) {
      errorWithSlug(
        slug,
        `git worktree remove failed: ${rm.stderr.trim() || `exit ${rm.code}`}`
      );
    }
  }
  if (branchExists) {
    const del = runGit(["branch", "-D", branchName], repoCwd);
    if (!del.ok) {
      errorWithSlug(
        slug,
        `branch -D ${branchName} failed: ${del.stderr.trim() || `exit ${del.code}`}`
      );
    }
  }
  const refCleanupError = deleteRetainedSourceRefs(repoCwd, retained);
  if (refCleanupError) {
    errorWithSlug(slug, `reviewed-source ref cleanup failed: ${refCleanupError}`);
  }

  console.log(
    JSON.stringify({
      emitted: "WORKTREE_DISCARDED",
      slug,
      worktree_path: wtPath,
      reason: "agent-discard",
      audit_timestamp: auditTs,
    })
  );
}

// --- Subcommand: list ---
//
// Usage: aidlc-worktree list
//
// Filters `git worktree list --porcelain` output to entries that are AIDLC
// Bolt worktrees: parent path is `<projectDir>/.aidlc/worktrees/` AND the
// basename starts with `bolt-`. Both conditions are required so an
// unrelated worktree someone happens to name `bolt-other` outside our
// namespace doesn't masquerade as a Bolt. Read-only — no audit emission.
function handleList(_args: string[]): void {
  // No assertNotSiblingWorktree here — list is read-only and useful from
  // anywhere. Run from current cwd's git context.
  const pd = resolveProjectDir(projectDir);
  const boltsDir = pathKey(resolve(pd, ".aidlc", "worktrees"));

  const r = runGit(["worktree", "list", "--porcelain"]);
  if (!r.ok) {
    error(`git worktree list failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  interface WT {
    path: string;
    branch: string;
  }
  // Type guard — a Partial<WT> with .path defined narrows to WT since
  // branch defaults to "" at construction (the "worktree " branch below).
  function isCompleteWT(p: Partial<WT>): p is WT {
    return p.path !== undefined;
  }
  const all: WT[] = [];
  let cur: Partial<WT> = {};
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (isCompleteWT(cur)) all.push({ ...cur, branch: cur.branch ?? "" });
      cur = { path: line.slice("worktree ".length), branch: "" };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "") {
      if (isCompleteWT(cur)) {
        all.push({ ...cur, branch: cur.branch ?? "" });
        cur = {};
      }
    }
  }
  if (isCompleteWT(cur)) all.push({ ...cur, branch: cur.branch ?? "" });

  const bolts = all
    .filter((w) => {
      const base = w.path.split(/[\\/]/).filter(Boolean).pop() ?? "";
      if (!base.startsWith("bolt-")) return false;
      // Require parent to be the framework-owned bolts directory.
      const parent = pathKey(dirname(w.path));
      return parent === boltsDir;
    })
    .map((w) => ({
      slug: (w.path.split(/[\\/]/).filter(Boolean).pop() ?? "").slice("bolt-".length),
      worktree_path: w.path,
      branch: w.branch,
    }));

  console.log(JSON.stringify({ worktrees: bolts }));
}

// --- Subcommand: verify ---
//
// Usage: aidlc-worktree verify --event <WORKTREE_*> --slug <slug>
//                              [--max-age-seconds <n>]
//
// Greps `aidlc-docs/audit.md` for the most recent block matching both
// `**Event**: <event>` and `**Bolt slug**: <slug>`. Read-only — no audit
// emission. The orchestrator's deterministic post-dispatch backstop.
function handleVerify(args: string[]): void {
  const flags = parseFlags(args);
  if (!flags.event) error("Missing --event <WORKTREE_CREATED|WORKTREE_MERGED|WORKTREE_DISCARDED>");
  if (!VALID_VERIFY_EVENTS.has(flags.event)) {
    error(
      `Invalid --event: "${flags.event}". Must be one of: WORKTREE_CREATED, WORKTREE_MERGED, WORKTREE_DISCARDED.`
    );
  }
  const slug = validateSlug(flags.slug);
  const maxAge = flags["max-age-seconds"]
    ? Number(flags["max-age-seconds"])
    : 60;
  if (!Number.isFinite(maxAge) || maxAge < 0) {
    error(`Invalid --max-age-seconds: "${flags["max-age-seconds"]}".`);
  }

  const pd = resolveProjectDir(projectDir);
  // Read across every per-clone audit shard (single shard in the common case).
  const audit = readAllAuditShards(pd, flags.intent, flags.space);
  if (audit.length === 0) {
    process.stdout.write(
      `${JSON.stringify({
        verified: false,
        event: flags.event,
        slug,
        reason: "absent",
      })}\n`
    );
    process.exit(1);
  }

  const match = findLatestEvent(audit, flags.event, slug);
  if (!match) {
    process.stdout.write(
      `${JSON.stringify({
        verified: false,
        event: flags.event,
        slug,
        reason: "absent",
      })}\n`
    );
    process.exit(1);
  }

  const ageMs = Date.now() - new Date(match.timestamp).getTime();
  if (ageMs > maxAge * 1000) {
    process.stdout.write(
      `${JSON.stringify({
        verified: false,
        event: flags.event,
        slug,
        reason: `stale (last seen ${match.timestamp})`,
      })}\n`
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      verified: true,
      event: flags.event,
      slug,
      audit_timestamp: match.timestamp,
    })
  );
}

// --- Subcommand: info ---
//
// Usage: aidlc-worktree info --slug <slug>
//
// Reads the most-recent WORKTREE_CREATED audit block for `slug`, parses the
// `Worktree path` and `Branch name` fields, emits JSON to stdout, exits 0.
// On miss or malformed-block, prints an error to stderr and exits non-zero.
//
// The halt-and-ask flow calls this to interpolate the worktree path and
// branch name into the AskUserQuestion prompt body. Schema pinned in
// `knowledge/aidlc-shared/worktree-info-schema.md`.
function handleInfo(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);

  const pd = resolveProjectDir(projectDir);
  // Read across every per-clone audit shard (single shard in the common case).
  const audit = readAllAuditShards(pd, flags.intent, flags.space);
  if (audit.length === 0) {
    process.stderr.write(
      `error: no WORKTREE_CREATED audit entry for slug ${slug} (audit log absent)\n`
    );
    process.exit(1);
  }

  const match = findLatestEvent(audit, "WORKTREE_CREATED", slug);
  if (!match) {
    process.stderr.write(
      `error: no WORKTREE_CREATED audit entry for slug ${slug}\n`
    );
    process.exit(1);
  }

  const pathMatch = match.block.match(/^\*\*Worktree path\*\*:\s*(.+?)\s*$/m);
  const branchMatch = match.block.match(/^\*\*Branch name\*\*:\s*(.+?)\s*$/m);
  if (!pathMatch || !branchMatch) {
    process.stderr.write(
      `error: malformed WORKTREE_CREATED block at ${match.timestamp} (missing Worktree path or Branch name field)\n`
    );
    process.exit(1);
  }

  // Read the per-Bolt forked state file for the Merge-Held marker if present.
  // Absence of the file or the field both resolve to merge_held=false — the
  // resume-path check is "do not dispatch a merge that's actively held",
  // not "every Bolt has had its hold state explicitly initialised".
  let mergeHeld = false;
  const wtStatePath = worktreeStateFilePath(pathMatch[1]);
  if (existsSync(wtStatePath)) {
    const wtContent = readFileSync(wtStatePath, "utf-8");
    mergeHeld = getField(wtContent, "Merge-Held") === "true";
  }

  console.log(
    JSON.stringify({
      slug,
      path: pathMatch[1],
      branch_name: branchMatch[1],
      audit_timestamp: match.timestamp,
      merge_held: mergeHeld,
    })
  );
}

interface AuditMatch {
  timestamp: string;
  block: string;
}

function findLatestEvent(
  audit: string,
  event: string,
  slug: string
): AuditMatch | null {
  // Select the CHRONOLOGICALLY-newest matching block (max **Timestamp**), NOT
  // the last block by buffer position. The audit string is a readAllAuditShards
  // glob-merge that concatenates per-clone shards in FILENAME (lexical) order,
  // so it is NOT time-ordered across shards — a buffer-position "last match
  // wins" walk could return an OLDER block from a lexically-later shard (e.g.
  // `worktree verify --max-age-seconds` reporting a fresh worktree STALE, or
  // `worktree info` returning a stale path/branch). Delegate to findAllEvents,
  // which CRLF-normalizes before splitting and sorts ascending by ISO-8601
  // timestamp with a buffer-position tiebreak — the SAME ordering fix the other
  // readers (findAllEvents / buildWorkflowHeader / hasStageAuditEvent) already
  // use — then take the last (newest) match. Returns null on no match.
  const matches = findAllEvents(audit, event, slug);
  if (matches.length === 0) return null;
  const newest = matches[matches.length - 1];
  return { timestamp: newest.timestamp, block: newest.block };
}

// --- CLI entry point ---

let projectDir: string | undefined;

export function main(argv: string[]): void {
  const rawArgs = argv;

  const filteredArgs: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--project-dir" && i + 1 < rawArgs.length) {
      projectDir = rawArgs[i + 1];
      i++;
    } else {
      filteredArgs.push(rawArgs[i]);
    }
  }

  const subcommand = filteredArgs[0];

  try {
    switch (subcommand) {
      case "create":
        handleCreate(filteredArgs.slice(1));
        break;
      case "merge":
        handleMerge(filteredArgs.slice(1));
        break;
      case "discard":
        handleDiscard(filteredArgs.slice(1));
        break;
      case "list":
        handleList(filteredArgs.slice(1));
        break;
      case "verify":
        handleVerify(filteredArgs.slice(1));
        break;
      case "info":
        handleInfo(filteredArgs.slice(1));
        break;
      default:
        error(
          `Unknown subcommand: ${subcommand}. Valid: create, merge, discard, list, verify, info`
        );
    }
  } catch (e) {
    error(errorMessage(e));
  }
}

// errorWithSlug — emits ERROR_LOGGED via emitError with `[slug=<slug>]`
// prepended to the message so doctor's regex `\[slug=([a-z0-9-]+)\]` can
// correlate the error with the affected Bolt without re-engineering
// emitError's field set.
function errorWithSlug(slug: string, msg: string): never {
  error(`[slug=${slug}] ${msg}`);
}

function error(msg: string): never {
  const pd = resolveProjectDir(projectDir);
  const command = `aidlc-worktree ${process.argv.slice(2).join(" ")}`.trim();
  emitError(pd, "aidlc-worktree", command, msg);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
