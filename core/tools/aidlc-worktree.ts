// aidlc-worktree.ts — Construction-phase worktree primitive.
//
// Subcommands: create, merge, discard, restore, purge, list, verify, info.
// Discard parks source before audit-first removal (audit-of-intent — see
// docs/reference/12-state-machine.md § Audit-first atomicity).
// The orchestrator dispatches aidlc-pipeline-deploy-agent
// to read team practices, the agent invokes this tool with resolved flags,
// then the orchestrator calls `verify` as a deterministic post-dispatch
// backstop confirming the audit event landed.
//
// Bolt directories, branches, and retained refs are scoped by the selected
// intent's registry identity. Pre-upgrade slug-only Bolts are resolved only
// through matching provenance; new worktrees never use legacy names.
// Nested checkouts are refused; external linked worktrees remain supported.

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  auditBlockField,
  BOLT_INTENT_ID8_REGEX,
  type BoltIdentity,
  BoltIdentityError,
  boltName,
  boltSlugForUnit,
  currentSwarmSourceOpeningFingerprint,
  currentSwarmSourceMergeChain,
  emitError,
  type EmitErrorMessage,
  errorMessage,
  filteredRawIndexEntries,
  findAllEvents,
  getField,
  legacyBoltIdentity,
  gitCommitSourceListing,
  idSuffix,
  intentUuidForSelection,
  isValidRepoName,
  latestMainWorkflowStageRunFloorForProject,
  lastWorkspaceSourceFailure,
  legacyBoltName,
  legacyWorktreePath,
  maximalAttemptEvents,
  newBoltIdentity,
  parseParkedStampInstant,
  parseBoltName,
  parseSourceListing,
  readAllAuditShards,
  readAuditShardEvents,
  readStateFile,
  recoveryRepoCandidates,
  relativeRecordDir,
  relativeRecordDirForSelection,
  repoDir,
  resolveAuditWorktreePath,
  resolveBoltDag,
  resolveBoltIdentity,
  resolveConstructionRepo,
  resolveProjectDir,
  resolveWorkflowSelection,
  serializeSourceListing,
  sourceListingEntriesEqual,
  sourceListingSha256,
  swarmUnitCheckpointRejections,
  type WorkspaceSourceState,
  type WorkflowSelection,
  UNBINDABLE_FINGERPRINT,
  validateUnitName,
  workspaceSourceFailureSuffix,
  workspaceSourceFingerprint,
  workspaceSourceExclusionPathspecs,
  workspaceSourcePathIsExcluded,
  workspaceSourceState,
  worktreePath,
  worktreesDir,
  worktreeStateFilePath,
  writeFileAtomic,
  REPO_NAME_REGEX,
} from "./aidlc-lib.js";
import { captureCodeGenerationDiscardApproval } from "./aidlc-testing-posture.ts";

// kebab-case slug shape: lowercase letter, then lowercase letters / digits /
// hyphens. Mirrors stage-schema.ts:95+:101 — the codebase already duplicates
// this regex across conceptual domains; a one-line constant beats a cross-
// module import for a tool-local check.
const SLUG_RE = /^[a-z][a-z0-9-]*$/;
// The emitter uses isoTimestamp() (YYYY-MM-DDTHH:MM:SSZ); fixtures may carry fractional seconds.
const AUDIT_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

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

const RECOVERY_FLAGS: Record<string, readonly string[]> = {
  restore: ["slug", "parked", "raw", "repo", "intent", "space", "project-dir"],
  purge: ["slug", "parked", "older-than", "repo", "intent", "space", "project-dir"],
  list: ["project-dir"],
  info: ["slug", "intent", "space", "project-dir"],
};

function validateRecoveryFlags(args: string[], valid: readonly string[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    if (!valid.includes(name)) error(`Unknown flag ${arg}. Valid flags: ${valid.map((flag) => `--${flag}`).join(", ")}`);
    if (seen.has(name)) error(`Duplicate flag ${arg}.`);
    seen.add(name);
    if (name === "raw") continue;
    const value = args[++i];
    if (value === undefined) error(`${arg} expects a value, got end of arguments.`);
    if (value.startsWith("--")) error(`${arg} expects a value, got another flag: "${value}". Did you forget the value?`);
  }
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
  status?: number | null;
  signal?: string | null;
  error?: string;
}

function runGit(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): GitResult {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, EDITOR: process.env.EDITOR ?? "false", ...env },
  });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? "").toString(),
    stderr: (r.stderr ?? "").toString(),
    code: r.status ?? 1,
    status: r.status,
    signal: r.signal,
    error: r.error?.message,
  };
}

interface RetainedSourceRef {
  ref: string;
  oid: string;
}

function retainedSourceRefs(repoCwd: string, identity: BoltIdentity): RetainedSourceRef[] | null {
  const prefix = identity.reviewedSourceRefPrefix;
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
    if (!/^[0-9a-f]{40,64}$/.test(ref.slice(prefix.length))) continue;
    refs.push({ ref, oid });
  }
  return refs;
}

function recordedWorktreeSelector(
  identity: BoltIdentity,
): {
  intent?: string;
  space?: string;
  repoSelector?: string | null;
} | null {
  const path = join(identity.dir, ".aidlc", WORKTREE_META_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      intentRecord?: unknown;
      repoSelector?: unknown;
    };
    const matched =
      typeof parsed.intentRecord === "string"
        ? /^aidlc\/spaces\/([^/]+)\/intents\/([^/]+)$/.exec(
            parsed.intentRecord,
          )
        : null;
    if (
      "repoSelector" in parsed &&
      parsed.repoSelector !== null &&
      typeof parsed.repoSelector !== "string"
    ) {
      return matched === null
        ? null
        : { space: matched[1], intent: matched[2] };
    }
    if (matched === null && !("repoSelector" in parsed)) return null;
    return {
      ...(matched === null
        ? {}
        : {
            space: matched[1],
            intent: matched[2],
          }),
      ...("repoSelector" in parsed
        ? { repoSelector: parsed.repoSelector as string | null }
        : {}),
    };
  } catch {
    return null;
  }
}

// Compare-and-delete each ref: if another process moved one after enumeration,
// preserve it and report a cleanup failure instead of deleting newer evidence.
function deleteRetainedSourceRefs(repoCwd: string, identity: BoltIdentity, refs: RetainedSourceRef[], tag: string): string | null {
  assertBoltBranchOwnedHere(repoCwd, identity, tag);
  for (const retained of refs) {
    const deleted = runGit(["update-ref", "-d", retained.ref, retained.oid], repoCwd);
    if (!deleted.ok) {
      return deleted.stderr.trim() || deleted.stdout.trim() || `cannot delete ${retained.ref}`;
    }
  }
  return null;
}

// --- Nested-worktree detection ---
//
// `aidlc-worktree` must not run from a checkout NESTED INSIDE the main repo
// checkout's working tree — `.aidlc/worktrees/bolt-<id8>_<slug>` (or a
// provenance-matched legacy `bolt-<slug>` / `.claude/worktrees/<dev>`). A nested checkout is refused
// because a Bolt worktree created from there would sit inside another worktree's
// tracked tree.
// The main checkout is the directory whose `.git` is `git rev-parse
// --git-common-dir`'s parent. macOS symlinks `/var → /private/var`, so
// canonicalise both sides via `realpathSync` before comparing.
//
// A linked worktree that lives OUTSIDE the main checkout is ALLOWED (#567). The
// one-worktree-per-branch layout is ordinary, and nothing about it breaks the
// invariant above: git registers such a worktree under the same common dir (so
// `gitCommonDirHash` and the creating-repo binding are unchanged), the Bolt
// worktrees it creates hang off ITS root rather than inside anyone else's tree,
// and `--base` / the merge target stay bound to the invoking checkout — which is
// the property that keeps a unit forking from the branch holding approved work
// rather than from whatever the main checkout happens to have checked out.
// Intent-scoped branches avoid collisions between these external checkouts;
// pre-upgrade names are supported for existing Bolts, never for new creation.
//
// P7 (multi-repo): the guard is RE-ANCHORED to the TARGET repo's checkout. When
// `--repo <name>` selects a sibling repo, `repoCwd` is that repo dir and every
// git probe runs there — so the nesting test is evaluated against the sibling
// repo, not the (non-git) workspace root. Absent `--repo` (legacy single-repo),
// `repoCwd` is the projectDir and the behaviour is unchanged.

// True when `child` is strictly inside `parent` (never for equal paths). A leading
// `..` segment on a separator boundary means outside, not a `..foo` directory name.
function isNestedInside(parent: string, child: string): boolean {
  if (child === parent) return false;
  const rel = relative(parent, child);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return true;
}

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

  if (cwdTop !== mainCheckout && isNestedInside(mainCheckout, cwdTop)) {
    error(
      `aidlc-worktree must run from the main repo checkout or a worktree outside it, not from a worktree nested inside it at ${cwdTop}. Bolt worktrees live under the invoking checkout's .aidlc/worktrees/, so creating one from a nested checkout would put a worktree inside another worktree's tracked tree.`
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

function gitCommonDirRealpath(cwd: string, onFailure?: (detail: string) => void): string | null {
  const top = runGit(["rev-parse", "--show-toplevel"], cwd);
  const common = runGit(["rev-parse", "--git-common-dir"], cwd);
  const commandDetail = (args: string[], result: GitResult) => ({
    command: ["git", ...args], ...result,
    stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr),
    stdout: result.stdout.slice(0, 4096), stderr: result.stderr.slice(0, 4096),
  });
  const report = (reason: string, resolvedPath?: string) => onFailure?.(JSON.stringify({
    cwd, reason, resolvedPath,
    top: commandDetail(["rev-parse", "--show-toplevel"], top),
    common: commandDetail(["rev-parse", "--git-common-dir"], common),
  }));
  if (!top.ok || !common.ok) {
    report("Git repository path probe failed");
    return null;
  }
  let resolvedPath: string | undefined;
  try {
    resolvedPath = resolve(top.stdout.trim(), common.stdout.trim());
    return realpathSync(resolvedPath);
  } catch (error) {
    report(`Repository common-dir realpath failed: ${errorMessage(error)}`, resolvedPath);
    return null;
  }
}

function pathKey(p: string): string {
  const normalised = canonicalise(resolve(p)).replace(/\\/g, "/");
  return process.platform === "win32" ? normalised.toLowerCase() : normalised;
}

function gitCommonDirHash(path: string): string {
  return createHash("sha256").update(pathKey(path)).digest("hex");
}

function auditWorktreePath(pd: string, path: string): string {
  return relative(pd, path).replaceAll("\\", "/");
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

function resolveCommandBoltIdentity(
  pd: string,
  slug: string,
  selection: WorkflowSelection,
): BoltIdentity {
  try {
    return resolveBoltIdentity(pd, slug, selection);
  } catch (e) {
    if (e instanceof BoltIdentityError) errorWithSlug(slug, e.message);
    throw e;
  }
}

// Resolve the cwd every git op in a construction handler must run in (P7). With
// `--repo <name>` it is the sibling repo dir; absent it the lone recorded repo is
// inferred (or the projectDir for a legacy single-repo intent). A disambiguation
// failure (multi-repo intent without --repo, or an out-of-set name) errors before
// any audit emit. `flags.intent`/`flags.space` select the intent whose repo set is
// consulted (same selector the audit emit threads).
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
  carriesWorkspaceShell: boolean,
): { ok: true; serialized: string; hash: string } | { ok: false; detail: string } {
  // This is captured once at worktree creation, so bind the live external
  // target bytes that the opening review baseline actually sees.
  try {
    const listing = gitCommitSourceListing(repoCwd, baseCommit, carriesWorkspaceShell, true);
    if (listing === null) {
      return { ok: false, detail: JSON.stringify(lastWorkspaceSourceFailure()) };
    }
    const serialized = serializeSourceListing(listing);
    if (parseSourceListing(serialized) === null) {
      return { ok: false, detail: "Serialized raw source listing failed validation" };
    }
    return { ok: true, serialized, hash: `sha256:${sourceListingSha256(serialized)}` };
  } catch (error) {
    return { ok: false, detail: `${errorMessage(error)}; source failure: ${JSON.stringify(lastWorkspaceSourceFailure())}` };
  }
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
  const selection = resolveWorkflowSelection(pd, { intent: flags.intent, space: flags.space });
  let identity = resolveCommandBoltIdentity(pd, slug, selection);
  if (selection.intent !== null) flags.intent = selection.intent;
  flags.space = selection.space;
  const intentRecord = relativeRecordDirForSelection(selection);
  // P7: anchor every git op to the target sibling repo (or the projectDir for a
  // legacy single-repo intent). The guard is evaluated against that same checkout.
  const repoTarget = resolveRepoTarget(pd, flags, slug);
  const repoCwd = repoTarget.cwd;
  let creatingCommonDirFailure: string | undefined;
  const creatingGitCommonDir = gitCommonDirRealpath(repoCwd, (detail) => {
    creatingCommonDirFailure = detail;
  });
  if (creatingGitCommonDir === null) {
    errorWithSlug(slug, `Cannot resolve the creating repository common dir. ${creatingCommonDirFailure ?? ""}`);
  }
  // A pre-upgrade audit-first create that died between its WORKTREE_CREATED
  // row and `git worktree add` leaves an open legacy creation with no directory,
  // branch, registration or retained ref. That phantom is doctor's to reconcile;
  // it must not make the slug uncreatable, so with no durable git evidence the
  // new Bolt takes the intent-scoped identity instead of "adopting" nothing.
  if (identity.legacy && !existsSync(identity.dir) &&
    !repositoryBoltEvidence(pd, repoTarget.repo, identity).durable) {
    identity = newBoltIdentity(pd, identity.intentId8, slug);
  }
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
  const rawBase = rawBaseSourceListing(
    repoCwd,
    baseCommit,
    repoTarget.repo === null,
  );
  if (!rawBase.ok) {
    errorWithSlug(slug, `Base source listing could not be computed for: ${flags.base} (commit ${baseCommit}); ${rawBase.detail}`);
  }

  const wtPath = identity.dir;
  if (identity.legacy && !existsSync(wtPath)) {
    const retained = retainedSourceRefs(repoCwd, identity);
    if (retained === null) errorWithSlug(slug, "reviewed-source ref enumeration failed");
    errorWithSlug(
      slug,
      `Legacy Bolt ${slug} left branch ${identity.branch}${retained.length > 0 ? ` and ${retained.length} retained refs` : ""} behind; run discard --slug ${slug} under its intent to park and clean them before creating a new Bolt.`,
    );
  }
  if (existsSync(wtPath)) {
    errorWithSlug(
      slug,
      `Worktree directory already exists: ${wtPath}. If BOLT_COMPLETED was recorded ` +
        "without AUDIT_MERGED, finish the existing Bolt complete/merge and audit-merge " +
        "path instead of creating another worktree.",
    );
  }

  const branchName = identity.branch;
  const branchExists = runGit(["rev-parse", "--verify", `refs/heads/${branchName}`], repoCwd);
  if (branchExists.ok) {
    const listed = runGit(["worktree", "list", "--porcelain"], repoCwd);
    const owner = listed.ok
      ? worktreeCheckedOutAt(listed.stdout, `refs/heads/${branchName}`)
      : null;
    const prefix = `Branch already exists: ${branchName}`;
    const guidance = ". Bolt branches are shared by every worktree of this repository; finish or discard the Bolt that owns it, or rename the Unit.";
    // The owner lives outside this project dir, so the audit row must not carry its absolute path.
    errorWithSlug(
      slug,
      owner === null ? `${prefix}${guidance}` : {
        message: `${prefix} (checked out at ${owner})${guidance}`,
        auditMessage: `${prefix} (checked out in another worktree of this repository)${guidance}`,
      },
    );
  }

  // Audit-first: emit BEFORE git so a kill-9 between emit and git surfaces
  // as "phantom WORKTREE_CREATED" reconciled by doctor (audit-of-intent
  // semantics — see docs/reference/12-state-machine.md).
  let auditTs: string;
  try {
    auditTs = emitAudit(pd, "WORKTREE_CREATED", {
      "Bolt slug": slug,
      "Worktree path": auditWorktreePath(pd, wtPath),
      "Branch name": branchName,
      "Base branch": flags.base,
      "Base commit": baseCommit,
      "Base Source Listing": rawBase.hash,
      Repo: repoTarget.repo ?? "-",
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
    assertBoltBranchOwnedHere(repoCwd, identity, "Failed-create cleanup");
    if (
      existsSync(wtPath) ||
      repositoryRegistersBoltWorktree(pd, repoCwd, identity)
    ) {
      runGit(["worktree", "remove", "--force", wtPath], repoCwd);
    }
    const leakedBranch = runGit(
      ["rev-parse", "--verify", `refs/heads/${branchName}`],
      repoCwd,
    );
    if (leakedBranch.ok && leakedBranch.stdout.trim() === baseCommit) {
      assertBoltBranchOwnedHere(repoCwd, identity, "Failed-create cleanup");
      runGit(
        ["update-ref", "-d", `refs/heads/${branchName}`, baseCommit],
        repoCwd,
      );
    }
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
          intentId8: identity.intentId8,
          branch: identity.branch,
          baseBranch: flags.base,
          baseCommit,
          baseSourceListing: rawBase.hash,
          repoSelector: repoTarget.repo,
          gitCommonDirHash: gitCommonDirHash(creatingGitCommonDir),
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

interface ScopedWorktreeAuditRow extends WorktreeAuditRow {
  authorityIntent?: string;
  authoritySpace: string;
}

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

function selectedWorktreeAuditRows(
  pd: string,
  selection: WorkflowSelection,
): { rows: ScopedWorktreeAuditRow[]; unreadableShards: string[] } {
  const unreadableShards: string[] = [];
  const rows = readAuditShardEvents(pd, selection.intent ?? undefined, selection.space, unreadableShards)
    .map((row) => ({
      ...row,
      authoritySpace: selection.space,
      ...(selection.intent === null ? {} : { authorityIntent: selection.intent }),
    }));
  return { rows, unreadableShards };
}

function repoSelectorKey(repo: string | null): string {
  return repo ?? "\0root";
}

function repoSelectorLabel(repo: string | null): string {
  return repo ?? "-";
}

interface RepositoryBoltEvidence {
  branch: boolean;
  durable: boolean;
  registered: boolean;
  retained: boolean;
}

// Path of the registered worktree that has `branchRef` checked out, or null.
function worktreeCheckedOutAt(porcelain: string, branchRef: string): string | null {
  for (const block of porcelain.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (lines.includes(`branch ${branchRef}`)) {
      return lines.find((line) => line.startsWith("worktree "))?.slice(9) ?? null;
    }
  }
  return null;
}

function assertBoltBranchOwnedHere(repoCwd: string, identity: BoltIdentity, tag: string): void {
  const listed = runGit(["worktree", "list", "--porcelain"], repoCwd);
  if (!listed.ok) {
    errorWithSlug(identity.slug, `${tag} cannot verify Bolt branch ownership: ${listed.stderr.trim() || `exit ${listed.code}`}`);
  }
  const owner = worktreeCheckedOutAt(listed.stdout, `refs/heads/${identity.branch}`);
  if (owner !== null && pathKey(owner) !== pathKey(identity.dir)) {
    const prefix = `${tag} branch ${identity.branch}`;
    const refusal = "; refusing to delete another worktree's Bolt";
    errorWithSlug(identity.slug, {
      message: `${prefix} is checked out at ${owner}${refusal}`,
      auditMessage: `${prefix} (checked out in another worktree of this repository)${refusal}`,
    });
  }
}

function repositoryRegistersBoltWorktree(
  _pd: string,
  repoCwd: string,
  identity: BoltIdentity,
): boolean {
  const listed = runGit(["worktree", "list", "--porcelain"], repoCwd);
  if (!listed.ok) return false;
  const expectedPath = pathKey(identity.dir);
  for (const block of listed.stdout.split(/\r?\n\r?\n/)) {
    const path = block.split(/\r?\n/).find((line) => line.startsWith("worktree "))?.slice(9);
    if (path !== undefined && pathKey(path) === expectedPath) return true;
  }
  return false;
}

function repositoryBoltEvidence(
  pd: string,
  repo: string | null,
  identity: BoltIdentity,
): RepositoryBoltEvidence {
  const cwd = repo === null ? pd : repoDir(pd, repo);
  if (!runGit(["rev-parse", "--git-dir"], cwd).ok) {
    return {
      branch: false,
      durable: false,
      registered: false,
      retained: false,
    };
  }
  const branchName = identity.branch;
  const branch = runGit(
    ["rev-parse", "--verify", `refs/heads/${branchName}`],
    cwd,
  ).ok;
  const retained = retainedSourceRefs(cwd, identity);
  const retainedPresent = retained !== null && retained.length > 0;
  const registered = repositoryRegistersBoltWorktree(pd, cwd, identity);
  return {
    branch,
    durable: branch || retainedPresent || registered,
    registered,
    retained: retainedPresent,
  };
}

function worktreeRepoCandidates(
  pd: string,
  rows: readonly WorktreeAuditRow[],
  slug: string,
): Map<string, string | null> {
  const selectors = new Map<string, string | null>();
  for (const [repo, slugs] of recoveryRepoCandidates(pd, rows)) {
    if (slugs === null || slugs.has(slug)) selectors.set(repoSelectorKey(repo), repo);
  }
  return selectors;
}

interface DiscardCreationAuthority {
  evidenceExists: boolean;
  intent?: string;
  repo?: string | null;
  space?: string;
  legacyDiscardRef?: string | null;
  legacyMergeRecorded?: boolean;
}

function discardCreationAuthority(
  pd: string,
  identity: BoltIdentity,
  selection: WorkflowSelection,
  recorded: ReturnType<typeof recordedWorktreeSelector>,
  explicitRepo?: string,
): DiscardCreationAuthority {
  const slug = identity.slug;
  const audit = selectedWorktreeAuditRows(pd, selection);
  const creationRows = audit.rows.filter(
    (row) =>
      row.event === "WORKTREE_CREATED" &&
      row.authoritySpace === selection.space &&
      row.authorityIntent === selection.intent &&
      auditBlockField(row.block, "Bolt slug") === slug,
  );
  const selectors = worktreeRepoCandidates(pd, audit.rows, slug);
  if (recorded?.repoSelector !== undefined) {
    selectors.set(
      repoSelectorKey(recorded.repoSelector),
      recorded.repoSelector,
    );
  }
  if (explicitRepo !== undefined && isValidRepoName(explicitRepo)) {
    selectors.set(repoSelectorKey(explicitRepo), explicitRepo);
  }

  const evidence = new Map<string, RepositoryBoltEvidence>();
  for (const [key, repo] of selectors) {
    evidence.set(key, repositoryBoltEvidence(pd, repo, identity));
  }
  const evidenceExists =
    existsSync(identity.dir) ||
    [...evidence.values()].some((value) => value.durable);
  if (!evidenceExists) return { evidenceExists: false };

  const wellShapedRows = creationRows.filter((row) => {
    const recordedPath = auditBlockField(row.block, "Worktree path");
    const branch = auditBlockField(row.block, "Branch name");
    return (
      recordedPath !== null &&
      pathKey(resolveAuditWorktreePath(pd, recordedPath)) ===
        pathKey(identity.dir) &&
      branch === identity.branch
    );
  });
  const rowsByTimestamp = new Map<string, ScopedWorktreeAuditRow[]>();
  for (const row of wellShapedRows) {
    const current = rowsByTimestamp.get(row.timestamp) ?? [];
    current.push(row);
    rowsByTimestamp.set(row.timestamp, current);
  }
  for (const tied of rowsByTimestamp.values()) {
    const durableRepos = new Set<string>();
    const shards = new Set<string>();
    for (const row of tied) {
      const field = auditBlockField(row.block, "Repo");
      const repo =
        field === "-"
          ? null
          : field !== null && isValidRepoName(field)
            ? field
            : undefined;
      if (
        repo !== undefined &&
        evidence.get(repoSelectorKey(repo))?.durable === true
      ) {
        durableRepos.add(repoSelectorKey(repo));
        shards.add(row.shard);
      }
    }
    if (durableRepos.size > 1 && shards.size > 1) {
      errorWithSlug(
        slug,
        "refusing to discard: same-second cross-shard WORKTREE_CREATED repository authority is ambiguous",
      );
    }
  }
  const corroborated = wellShapedRows.filter((row) => {
    const field = auditBlockField(row.block, "Repo");
    const repo =
      field === "-"
        ? null
        : field !== null && isValidRepoName(field)
          ? field
          : undefined;
    return (
      repo !== undefined &&
      evidence.get(repoSelectorKey(repo))?.durable === true
    );
  });
  // A namespaced Bolt is always created audit-first by this tool, so the
  // selected intent's own WORKTREE_CREATED must corroborate whatever git
  // evidence exists. Without it the branch or ref belongs to someone else —
  // a linked checkout whose registry diverged onto the same id8, or a hand
  // made name — and discard must not park and delete it. Only pre-upgrade
  // (legacy) Bolts may fall back to evidence-only ownership below.
  if (!identity.legacy && wellShapedRows.length === 0 && audit.unreadableShards.length === 0) {
    errorWithSlug(
      slug,
      `refusing to discard: no WORKTREE_CREATED row of intent ${relativeRecordDirForSelection(selection) ?? selection.space} names ${identity.name}; a branch or ref alone is not provenance for an intent-scoped Bolt`,
    );
  }
  const corroboratedRepos = new Map<string, string | null>();
  for (const row of corroborated) {
    const field = auditBlockField(row.block, "Repo") as string;
    const repo = field === "-" ? null : field;
    corroboratedRepos.set(repoSelectorKey(repo), repo);
  }
  if (corroboratedRepos.size > 1) {
    const labels = [...corroboratedRepos.values()]
      .map(repoSelectorLabel)
      .sort()
      .map((value) => JSON.stringify(value))
      .join(", ");
    errorWithSlug(
      slug,
      `refusing to discard: corroborated WORKTREE_CREATED rows disagree on the creating repository (${labels})`,
    );
  }

  let authority: ScopedWorktreeAuditRow | undefined;
  if (corroborated.length > 0) {
    authority = [...corroborated].sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp < b.timestamp ? -1 : 1;
      }
      if (a.shard !== b.shard) return a.shard < b.shard ? -1 : 1;
      return a.pos - b.pos;
    }).at(-1);
  }
  const repoField =
    authority === undefined
      ? null
      : auditBlockField(authority.block, "Repo");
  const auditRepo =
    repoField === "-"
      ? null
      : repoField !== null && isValidRepoName(repoField)
        ? repoField
        : undefined;
  const hasRepoRow = creationRows.some(
    (row) => auditBlockField(row.block, "Repo") !== null,
  );
  const retainedEvidence = [...evidence.values()].some(
    (value) => value.retained,
  );
  const durableRepoEntries = [...evidence.entries()].filter(
    ([, value]) => value.durable,
  );
  const durableRepos = durableRepoEntries.map(([key]) => key);
  const readableCreationRepos = [
    ...new Set(
      creationRows
        .map((row) => auditBlockField(row.block, "Repo"))
        .filter((repo): repo is string => repo !== null)
        .map((repo) => (repo === "-" ? null : repo))
        .filter(
          (repo): repo is string | null =>
            repo === null || isValidRepoName(repo),
        ),
    ),
  ];
  const modernAuthority =
    recorded?.repoSelector !== undefined ||
    hasRepoRow ||
    retainedEvidence ||
    audit.unreadableShards.length > 0;
  if (
    auditRepo === undefined &&
    modernAuthority
  ) {
    if (audit.unreadableShards.length > 0) {
      errorWithSlug(
        slug,
        "refusing to discard: durable Bolt evidence exists, but WORKTREE_CREATED Repo authority is unreadable; restore readable audit shards and retry",
      );
    }
    if (readableCreationRepos.length > 0) {
      const repos = readableCreationRepos
        .map(repoSelectorLabel)
        .sort()
        .map((repo) => JSON.stringify(repo))
        .join(", ");
      errorWithSlug(
        slug,
        `refusing to discard: a readable WORKTREE_CREATED record names ${repos}, but no worktree registration, ${identity.branch} branch, or retained reviewed-source ref remains there to corroborate it. If this Bolt was already discarded, this is expected; otherwise inspect ${repos} for the ${identity.branch} branch`,
      );
    }
    errorWithSlug(
      slug,
      "refusing to discard: durable Bolt evidence exists, but no corroborated WORKTREE_CREATED Repo authority is available",
    );
  }
  if (auditRepo === undefined && !modernAuthority) {
    if (durableRepos.length > 1) {
      const repos = durableRepoEntries
        .map(([key]) => repoSelectorLabel(selectors.get(key) ?? null))
        .sort();
      const selectedKey =
        explicitRepo === undefined
          ? undefined
          : repoSelectorKey(explicitRepo);
      const selectedEvidence =
        selectedKey === undefined
          ? undefined
          : evidence.get(selectedKey);
      const creatingCandidates = durableRepoEntries.filter(
        ([, value]) => value.registered || value.retained,
      );
      if (
        selectedKey === undefined ||
        selectedEvidence === undefined ||
        !selectedEvidence.durable ||
        creatingCandidates.length !== 1 ||
        creatingCandidates[0][0] !== selectedKey
      ) {
        const labels = repos.map((repo) => JSON.stringify(repo)).join(", ");
        errorWithSlug(
          slug,
          `refusing to discard: pre-upgrade Bolt evidence spans repositories ${labels} without WORKTREE_CREATED Repo authority. Delete the stray ${identity.branch} branch in the repository that is not the creating one, then retry with --repo <creating-repo>`,
        );
      }
    }
    if (
      explicitRepo !== undefined &&
      durableRepos.length === 1 &&
      durableRepos[0] !== repoSelectorKey(explicitRepo)
    ) {
      errorWithSlug(
        slug,
        `refusing to discard: selected repository ${JSON.stringify(explicitRepo)} contradicts the only repository carrying pre-upgrade Bolt evidence`,
      );
    }
  }
  if (
    auditRepo !== undefined &&
    recorded?.repoSelector !== undefined &&
    recorded.repoSelector !== auditRepo
  ) {
    errorWithSlug(
      slug,
      `refusing to discard: worktree metadata repository ${JSON.stringify(repoSelectorLabel(recorded.repoSelector))} does not match corroborated WORKTREE_CREATED repository ${JSON.stringify(repoSelectorLabel(auditRepo))}`,
    );
  }
  let legacyDiscardRef: string | null | undefined;
  let legacyMergeRecorded = false;
  if (identity.legacy && !existsSync(identity.dir)) {
    const lifecycle = audit.rows.filter((row) =>
      VALID_VERIFY_EVENTS.has(row.event) && auditBlockField(row.block, "Bolt slug") === slug);
    const frontier = maximalAttemptEvents(lifecycle);
    if (frontier.length === 1 && frontier[0].event !== "WORKTREE_CREATED") {
      const discarded = maximalAttemptEvents(lifecycle.filter((row) => {
        if (row.event !== "WORKTREE_DISCARDED") return false;
        const path = auditBlockField(row.block, "Worktree path");
        return path !== null && pathKey(resolveAuditWorktreePath(pd, path)) === pathKey(identity.dir);
      }));
      if (discarded.length > 0) {
        legacyDiscardRef = discarded.length === 1 ? auditBlockField(discarded[0].block, "Parked ref") : null;
      } else {
        // The frontier is a WORKTREE_MERGED with no discard: this intent's Bolt
        // either merged completely or died mid-cleanup. Either way a leftover
        // legacy branch is not discard's to park — the cleanup-only merge retry
        // owns it and checks the tip against the landed source commit — and it
        // may belong to a later pre-upgrade intent that reused the global name.
        legacyMergeRecorded = true;
      }
    }
  }
  return {
    evidenceExists: true,
    legacyDiscardRef,
    legacyMergeRecorded,
    ...(auditRepo === undefined
      ? {}
      : {
          repo: auditRepo,
          space: authority?.authoritySpace,
          ...(authority?.authorityIntent === undefined
            ? {}
            : { intent: authority.authorityIntent }),
        }),
  };
}

function rowAfter(candidate: WorktreeAuditRow, boundary: WorktreeAuditRow): boolean {
  if (candidate.timestamp !== boundary.timestamp) {
    return candidate.timestamp > boundary.timestamp;
  }
  return candidate.shard === boundary.shard && candidate.pos > boundary.pos;
}

function convergedSourceRecord(
  pd: string,
  identity: BoltIdentity,
  repoCwd: string,
  intent?: string,
  space?: string,
  selectedRepo: string | null = null,
): ConvergedSourceRecord | null {
  const slug = identity.slug;
  const wtPath = identity.dir;
  let worktreeMeta: {
    boltSlug: string;
    baseCommit: string;
    baseSourceListing: string;
    intentRecord?: string;
    swarmUnit?: string;
    swarmBatch?: string;
    swarmStage?: string;
    swarmFloor?: string;
    repoSelector?: string | null;
    gitCommonDir?: string;
    gitCommonDirHash?: string;
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
      ...("repoSelector" in (parsed as Record<string, unknown>)
        ? {
            repoSelector: (parsed as Record<string, unknown>)
              .repoSelector as string | null,
          }
        : {}),
      ...(typeof (parsed as Record<string, unknown>).gitCommonDir === "string"
        ? { gitCommonDir: (parsed as Record<string, string>).gitCommonDir }
        : {}),
      ...(typeof (parsed as Record<string, unknown>).gitCommonDirHash === "string"
        ? {
            gitCommonDirHash: (parsed as Record<string, string>)
              .gitCommonDirHash,
          }
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
      const expected = recordedWorktreeSelector(identity);
      const recovery =
        typeof expected?.space === "string" &&
        typeof expected.intent === "string"
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
  const retained = retainedSourceRefs(repoCwd, identity);
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
          return (
            recordedPath !== null &&
            pathKey(resolveAuditWorktreePath(pd, recordedPath)) ===
              pathKey(wtPath)
          );
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
      !("repoSelector" in worktreeMeta) ||
      (
        typeof worktreeMeta.gitCommonDir !== "string" &&
        typeof worktreeMeta.gitCommonDirHash !== "string"
      )
    ) {
      errorWithSlug(
        slug,
        "refusing to merge: durable modern worktree evidence lacks creating-repository binding; restart the Bolt attempt",
      );
    }
    const selectedCommonDir = gitCommonDirRealpath(repoCwd);
    const worktreeCommonDir = gitCommonDirRealpath(wtPath);
    const metadataCommonDirHash =
      typeof worktreeMeta.gitCommonDirHash === "string" &&
      /^[0-9a-f]{64}$/.test(worktreeMeta.gitCommonDirHash)
        ? worktreeMeta.gitCommonDirHash
        : typeof worktreeMeta.gitCommonDir === "string"
          ? gitCommonDirHash(worktreeMeta.gitCommonDir)
          : null;
    if (worktreeMeta.repoSelector !== selectedRepo) {
      errorWithSlug(
        slug,
        `refusing to merge: selected repository ${JSON.stringify(selectedRepo ?? "-")} does not match creating repository ${JSON.stringify(worktreeMeta.repoSelector ?? "-")}; retry with the creating --repo selector`,
      );
    }
    if (selectedCommonDir === null) {
      errorWithSlug(
        slug,
        `refusing to merge: could not resolve the selected checkout git directory for repository ${JSON.stringify(selectedRepo ?? "-")} after partial cleanup; restore the selected checkout registration, then retry`,
      );
    }
    if (worktreeCommonDir === null) {
      errorWithSlug(
        slug,
        "refusing to merge: could not resolve the Bolt worktree git directory after partial cleanup; restore the worktree registration or discard and restart the Bolt attempt",
      );
    }
    if (
      metadataCommonDirHash === null ||
      metadataCommonDirHash !== gitCommonDirHash(selectedCommonDir) ||
      metadataCommonDirHash !== gitCommonDirHash(worktreeCommonDir)
    ) {
      errorWithSlug(
        slug,
        "refusing to merge: recorded creating-repository provenance does not match the selected repository or Bolt worktree; restore the original repository/worktree binding or discard and restart the Bolt attempt",
      );
    }
    if (
      auditBlockField(creation.block, "Repo") !==
      (worktreeMeta.repoSelector ?? "-")
    ) {
      errorWithSlug(
        slug,
        "refusing to merge: WORKTREE_CREATED repository selector does not match worktree metadata",
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
    undefined,
    undefined,
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
  if (swarmUnitCheckpointRejections(rows, stage, floor, unitName, batch)
    .some((rejection) => !rowAfter(latest, rejection))) {
    errorWithSlug(
      slug,
      "refusing to merge: this Unit convergence predates its checkpoint rejection; prepare and finalize a fresh retry",
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
  if (!creationBaseCommit) {
    errorWithSlug(
      slug,
      "refusing to merge: bound convergence has no immutable worktree base commit authority",
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
): {
  state: WorkspaceSourceState;
  openingFingerprint: string;
} | null {
  if (!record || record.kind === "bypass") return null;
  const current = workspaceSourceState(pd, intent, space);
  if (current === null) {
    errorWithSlug(
      slug,
      `refusing to merge: the main checkout source aggregate is unbindable${workspaceSourceFailureSuffix()}`,
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
    return {
      state: current,
      openingFingerprint: chain.fingerprint,
    };
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
  return {
    state: current,
    openingFingerprint: opening.fingerprint,
  };
}

function expectedAggregateAfterCommit(
  before: ReadonlyMap<string, string>,
  priorCommittedRepo: ReadonlyMap<string, string>,
  landedCommittedRepo: ReadonlyMap<string, string>,
  repo: string | null,
): Map<string, string> {
  const expected = new Map(before);
  for (const key of changedSourceListingKeys(
    priorCommittedRepo,
    landedCommittedRepo,
  )) {
    const aggregateKey = `${repo ?? ""}${key}`;
    const landed = landedCommittedRepo.get(key);
    if (landed === undefined) expected.delete(aggregateKey);
    else expected.set(aggregateKey, landed);
  }
  return expected;
}

function stagedTreeOid(repoCwd: string): string | null {
  const tree = runGit(["write-tree"], repoCwd);
  const oid = tree.ok ? tree.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
}

function assertLandedMergeCommit(
  slug: string,
  repoCwd: string,
  priorHead: string,
  commitSha: string,
  expectedTree: string,
  expectedSecondParent: string | null | undefined,
): void {
  const parent = runGit(["rev-parse", `${commitSha}^1`], repoCwd);
  const tree = runGit(["rev-parse", `${commitSha}^{tree}`], repoCwd);
  const secondParent = runGit(["rev-parse", `${commitSha}^2`], repoCwd);
  const secondParentMatches =
    expectedSecondParent === undefined ||
    (expectedSecondParent === null
      ? !secondParent.ok
      : secondParent.ok &&
        secondParent.stdout.trim() === expectedSecondParent);
  if (
    !parent.ok ||
    parent.stdout.trim() !== priorHead ||
    !tree.ok ||
    tree.stdout.trim() !== expectedTree ||
    !secondParentMatches
  ) {
    errorWithSlug(
      slug,
      `[merge-succeeded:${commitSha}] unexpected commit or tree change landed during the source merge; no SWARM_SOURCE_MERGED authority was emitted. Do not retry this merge. Preserve the worktree and restart the stage attempt.`,
    );
  }
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

interface MergedSwarmAuthority {
  unit: string;
  batch: string;
  stage: string;
  floor: string;
  sourceCommit: string;
  mergeCommit: string;
  repo: string | null;
  space: string;
  intent?: string;
}

interface SwarmWorktreeIdentity {
  unit: string;
  batch: string;
  stage: string;
  floor: string;
  baseCommit: string;
  baseSourceListing: string;
}

function currentSwarmWorktreeIdentity(
  identity: BoltIdentity,
): SwarmWorktreeIdentity | null | undefined {
  const slug = identity.slug;
  const path = join(identity.dir, ".aidlc", WORKTREE_META_FILENAME);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
      string,
      unknown
    >;
    const unit = parsed.swarmUnit;
    const batch = parsed.swarmBatch;
    const stage = parsed.swarmStage;
    const floor = parsed.swarmFloor;
    const baseCommit = parsed.baseCommit;
    const baseSourceListing = parsed.baseSourceListing;
    return (
        parsed.version === 1 &&
        parsed.boltSlug === slug &&
        typeof unit === "string" &&
        boltSlugForUnit(unit) === slug &&
        typeof batch === "string" &&
        /^[1-9][0-9]*$/.test(batch) &&
        typeof stage === "string" &&
        stage.length > 0 &&
        typeof floor === "string" &&
        floor.length > 0 &&
        typeof baseCommit === "string" &&
        /^[0-9a-f]{40,64}$/.test(baseCommit) &&
        typeof baseSourceListing === "string" &&
        /^sha256:[0-9a-f]{64}$/.test(baseSourceListing)
      )
      ? { unit, batch, stage, floor, baseCommit, baseSourceListing }
      : null;
  } catch {
    return null;
  }
}

function mergedSwarmCleanupAuthority(
  pd: string,
  boltIdentity: BoltIdentity,
  selection: WorkflowSelection,
  target: string,
  explicitRepo?: string,
  identity?: SwarmWorktreeIdentity,
): MergedSwarmAuthority | null {
  const slug = boltIdentity.slug;
  const audit = selectedWorktreeAuditRows(pd, selection);
  const candidates = new Map<
    string,
    {
      authority: MergedSwarmAuthority;
      cleanupEvidence: boolean;
      order: number;
    }
  >();
  let matchedSlugAuthority = false;
  for (let order = 0; order < audit.rows.length; order++) {
    const row = audit.rows[order];
    if (row.event !== "SWARM_SOURCE_MERGED") continue;
    const unit = auditBlockField(row.block, "Unit name");
    if (unit === null || boltSlugForUnit(unit) !== slug) continue;
    const repoField = auditBlockField(row.block, "Repo");
    const repo =
      repoField === "-"
        ? null
        : repoField !== null && isValidRepoName(repoField)
          ? repoField
          : undefined;
    if (repo === undefined) continue;
    if (explicitRepo !== undefined && repo !== explicitRepo) continue;
    const batch = auditBlockField(row.block, "Batch number");
    const stage = auditBlockField(row.block, "Stage");
    const floor = auditBlockField(row.block, "Run floor");
    const sourceCommit = auditBlockField(row.block, "Source Commit");
    const mergeCommit = auditBlockField(row.block, "Merge commit");
    if (
      !batch ||
      !/^[1-9][0-9]*$/.test(batch) ||
      !stage ||
      !floor ||
      !sourceCommit ||
      !/^[0-9a-f]{40,64}$/.test(sourceCommit) ||
      !mergeCommit ||
      !/^[0-9a-f]{40,64}$/.test(mergeCommit)
    ) continue;
    if (
      identity !== undefined &&
      (unit !== identity.unit ||
        batch !== identity.batch ||
        stage !== identity.stage ||
        floor !== identity.floor)
    ) continue;
    // A slug and stage floor survive a Unit checkpoint rejection. Cleanup of
    // an old landing must never reset or remove the next child bearing them.
    const creations = maximalAttemptEvents(audit.rows.filter((candidate) =>
      candidate.event === "WORKTREE_CREATED" &&
      candidate.authoritySpace === row.authoritySpace &&
      candidate.authorityIntent === row.authorityIntent &&
      auditBlockField(candidate.block, "Bolt slug") === slug &&
      auditBlockField(candidate.block, "Repo") === repoField &&
      (() => {
        const path = auditBlockField(candidate.block, "Worktree path");
        return path !== null &&
          pathKey(resolveAuditWorktreePath(pd, path)) === pathKey(boltIdentity.dir);
      })()));
    if (creations.length !== 1) continue;
    const creation = creations[0];
    if (!rowAfter(row, creation)) continue;
    if (identity !== undefined && (
      creation.authoritySpace !== row.authoritySpace ||
      creation.authorityIntent !== row.authorityIntent ||
      auditBlockField(creation.block, "Base commit") !== identity.baseCommit ||
      auditBlockField(creation.block, "Base Source Listing") !== identity.baseSourceListing ||
      auditBlockField(creation.block, "Swarm Unit") !== unit ||
      auditBlockField(creation.block, "Swarm Batch") !== batch ||
      auditBlockField(creation.block, "Swarm Stage") !== stage ||
      auditBlockField(creation.block, "Swarm Run floor") !== floor)) continue;
    const scopeRows = audit.rows.filter((candidate) =>
      candidate.authoritySpace === row.authoritySpace &&
      candidate.authorityIntent === row.authorityIntent);
    if (swarmUnitCheckpointRejections(scopeRows, stage, floor, unit, batch)
      .some((rejection) => !rowAfter(row, rejection))) continue;
    const convergences = maximalAttemptEvents(scopeRows.filter(
      (candidate) =>
        candidate.event === "SWARM_UNIT_CONVERGED" &&
        auditBlockField(candidate.block, "Unit name") === unit &&
        rowAfter(candidate, creation),
    ));
    const convergence = convergences.length === 1 ? convergences[0] : null;
    if (!convergence ||
      auditBlockField(convergence.block, "Batch number") !== batch ||
      auditBlockField(convergence.block, "Stage") !== stage ||
      auditBlockField(convergence.block, "Run floor") !== floor ||
      auditBlockField(convergence.block, "Source Commit") !== sourceCommit ||
      auditBlockField(convergence.block, "Source Freshness Bypass") !== null ||
      !rowAfter(row, convergence)) continue;
    matchedSlugAuthority = true;
    const repoCwd = repo === null ? pd : repoDir(pd, repo);
    if (
      !runGit(["cat-file", "-e", `${sourceCommit}^{commit}`], repoCwd).ok ||
      !runGit(["merge-base", "--is-ancestor", mergeCommit, target], repoCwd).ok
    ) continue;
    const branch = runGit(
      ["rev-parse", "--verify", `refs/heads/${boltIdentity.branch}`],
      repoCwd,
    );
    const retained = retainedSourceRefs(repoCwd, boltIdentity);
    const cleanupEvidence =
      (branch.ok && branch.stdout.trim() === sourceCommit) ||
      (retained?.some((entry) => entry.oid === sourceCommit) ?? false);
    const authority: MergedSwarmAuthority = {
      unit,
      batch,
      stage,
      floor,
      sourceCommit,
      mergeCommit,
      repo,
      space: row.authoritySpace,
      ...(row.authorityIntent === undefined
        ? {}
        : { intent: row.authorityIntent }),
    };
    candidates.set(
      [
        authority.space,
        authority.intent ?? "",
        authority.repo ?? "",
        authority.unit,
        authority.batch,
        authority.stage,
        authority.floor,
        authority.sourceCommit,
        authority.mergeCommit,
      ].join("\0"),
      { authority, cleanupEvidence, order },
    );
  }
  const values = [...candidates.values()];
  const evidenced = values.filter((candidate) => candidate.cleanupEvidence);
  if (evidenced.length > 1) {
    errorWithSlug(
      slug,
      "refusing cleanup-only merge: multiple durable SWARM_SOURCE_MERGED authorities match this Bolt slug; retry with the original --space, --intent, and --repo selectors",
    );
  }
  const selected =
    evidenced.length === 1
      ? evidenced[0]
      : values.sort((a, b) => a.order - b.order).at(-1);
  const authority = selected?.authority;
  if (authority !== undefined) return authority;
  if (matchedSlugAuthority) {
    errorWithSlug(
      slug,
      `refusing cleanup-only merge: no matching durable source authority is reachable from target ${target}; restore the original target or pass the exact creating selectors`,
    );
  }
  return null;
}

function reconcileMergedSwarmCleanup(
  pd: string,
  identity: BoltIdentity,
  repoCwd: string,
  target: string,
  authority: MergedSwarmAuthority | null,
): boolean {
  if (authority === null) return false;
  const slug = identity.slug;
  const cleanupTag = `[merge-succeeded:${authority.mergeCommit}]`;
  assertBoltBranchOwnedHere(repoCwd, identity, cleanupTag);

  const wtPath = identity.dir;
  const branchName = identity.branch;
  const dirExists = existsSync(wtPath);
  const registered = repositoryRegistersBoltWorktree(pd, repoCwd, identity);
  if (dirExists || registered) {
    if (!dirExists) {
      errorWithSlug(
        slug,
        `${cleanupTag} worktree registration remains but its checkout directory is missing; restore the registration or prune it before retrying cleanup`,
      );
    }
    const align = runGit(["reset", "--hard", authority.sourceCommit], wtPath);
    if (!align.ok) {
      errorWithSlug(
        slug,
        `${cleanupTag} cleanup-only source alignment failed: ${align.stderr.trim() || `exit ${align.code}`}`,
      );
    }
    const removed = runGit(["worktree", "remove", "--force", wtPath], repoCwd);
    if (!removed.ok) {
      errorWithSlug(
        slug,
        `${cleanupTag} cleanup-only worktree remove failed: ${removed.stderr.trim() || `exit ${removed.code}`}`,
      );
    }
  }

  const branch = runGit(
    ["rev-parse", "--verify", `refs/heads/${branchName}`],
    repoCwd,
  );
  if (branch.ok) {
    const branchOid = branch.stdout.trim();
    if (branchOid !== authority.sourceCommit) {
      errorWithSlug(
        slug,
        `${cleanupTag} cleanup-only branch ${branchName} moved after source landing; preserve it for inspection`,
      );
    }
    assertBoltBranchOwnedHere(repoCwd, identity, cleanupTag);
    const deleted = runGit(
      ["update-ref", "-d", `refs/heads/${branchName}`, branchOid],
      repoCwd,
    );
    if (!deleted.ok) {
      errorWithSlug(
        slug,
        `${cleanupTag} cleanup-only branch deletion failed: ${deleted.stderr.trim() || `exit ${deleted.code}`}`,
      );
    }
  }
  const retained = retainedSourceRefs(repoCwd, identity);
  if (retained === null) {
    errorWithSlug(
      slug,
      `${cleanupTag} cleanup-only reviewed-source ref enumeration failed`,
    );
  }
  const refCleanupError = deleteRetainedSourceRefs(repoCwd, identity, retained, cleanupTag);
  if (refCleanupError) {
    errorWithSlug(
      slug,
      `${cleanupTag} cleanup-only reviewed-source ref deletion failed: ${refCleanupError}`,
    );
  }
  console.log(
    JSON.stringify({
      emitted: null,
      slug,
      worktree_path: wtPath,
      target,
      source_authority: authority.mergeCommit,
      cleanup_reconciled: true,
    }),
  );
  return true;
}

function refuseConfiguredMergeDrivers(
  slug: string,
  repoCwd: string,
  record: ConvergedSourceRecord | null,
): void {
  if (
    record?.kind !== "bound" ||
    process.env.AIDLC_SKIP_SOURCE_FRESHNESS === "1"
  ) {
    return;
  }
  const configured = runGit(
    [
      "config",
      "-z",
      "--name-only",
      "--get-regexp",
      "^merge\\..*\\.driver$",
    ],
    repoCwd,
  );
  if (!configured.ok && configured.code === 1) return;
  if (!configured.ok) {
    errorWithSlug(
      slug,
      "refusing to merge: cannot inspect effective repository merge-driver configuration",
    );
  }
  const keys = [
    ...new Set(
      configured.stdout
        .split("\0")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ].sort();
  errorWithSlug(
    slug,
    `refusing to merge: repository merge-driver configuration is present (${keys.join(", ")}); remove the merge.<name>.driver configuration, or retry with AIDLC_SKIP_SOURCE_FRESHNESS=1`,
  );
}

function refuseConfiguredCheckoutFilters(
  slug: string,
  repoCwd: string,
  record: ConvergedSourceRecord | null,
): void {
  if (
    record?.kind !== "bound" ||
    process.env.AIDLC_SKIP_SOURCE_FRESHNESS === "1"
  ) {
    return;
  }
  const configured = runGit(
    [
      "config",
      "-z",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(smudge|process)$",
    ],
    repoCwd,
  );
  if (!configured.ok && configured.code === 1) return;
  if (!configured.ok) {
    errorWithSlug(
      slug,
      "refusing to merge: cannot inspect effective repository checkout-filter configuration",
    );
  }
  const keys = [
    ...new Set(
      configured.stdout
        .split("\0")
        .map((key) => key.trim())
        .filter(Boolean),
    ),
  ].sort();
  errorWithSlug(
    slug,
    `refusing to merge: repository checkout-filter configuration is present (${keys.join(", ")}); remove the filter.<name>.smudge/process configuration, or retry with AIDLC_SKIP_SOURCE_FRESHNESS=1`,
  );
}

function handleMerge(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  if (!flags.target) errorWithSlug(slug, "Missing --target <branch>");
  const strategy = validateStrategy(flags.strategy);
  const message = flags.message ?? `Bolt ${slug}`;

  const pd = resolveProjectDir(projectDir);
  const selection = resolveWorkflowSelection(pd, { intent: flags.intent, space: flags.space });
  const identity = resolveCommandBoltIdentity(pd, slug, selection);
  if (selection.intent !== null) flags.intent = selection.intent;
  flags.space = selection.space;
  const recorded = recordedWorktreeSelector(identity);
  if (
    flags.repo === undefined &&
    typeof recorded?.repoSelector === "string"
  ) {
    flags.repo = recorded.repoSelector;
  }
  const worktreeIdentity = currentSwarmWorktreeIdentity(identity);
  const cleanupAuthority =
    worktreeIdentity === null
      ? null
      : mergedSwarmCleanupAuthority(
          pd,
          identity,
          selection,
          flags.target,
          flags.repo,
          worktreeIdentity,
        );
  if (recorded === null && cleanupAuthority !== null) {
    if (cleanupAuthority.repo !== null) {
      flags.repo = cleanupAuthority.repo;
    }
  }
  // P7: anchor every git op to the target sibling repo. The merge runs IN that
  // repo's main checkout (squash/merge/ff/commit/worktree-remove/branch-D); the
  // rebase still runs in the worktree (wtPath). Legacy single-repo → repoCwd=pd.
  const repoTarget = resolveRepoTarget(pd, flags, slug);
  const repoCwd = repoTarget.cwd;
  assertNotSiblingWorktree(repoCwd);
  if (
    reconcileMergedSwarmCleanup(
      pd,
      identity,
      repoCwd,
      flags.target,
      cleanupAuthority,
    )
  ) {
    return;
  }

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

  const wtPath = identity.dir;
  const branchName = identity.branch;
  const sourceRecord = convergedSourceRecord(
    pd,
    identity,
    repoCwd,
    flags.intent,
    flags.space,
    repoTarget.repo,
  );
  const frameworkPathspecs = workspaceSourceExclusionPathspecs(wtPath);
  if (frameworkPathspecs === null) {
    errorWithSlug(
      slug,
      "cannot resolve the Bolt worktree source role from its metadata",
    );
  }
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
        return workspaceSourcePathIsExcluded(wtPath, path) !== true;
      });
    if (applicationLines.length > 0) {
      const detail = applicationLines.join(", ");
      errorWithSlug(
        slug,
        `refusing to merge: the bypassed Bolt has uncommitted or ignored application paths not represented by its branch (${detail}); commit, remove, or discard those paths before retrying`,
      );
    }
  }
  refuseConfiguredMergeDrivers(slug, repoCwd, sourceRecord);
  refuseConfiguredCheckoutFilters(slug, repoCwd, sourceRecord);

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
      "Worktree path": auditWorktreePath(pd, wtPath),
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
  // object rather than the movable intent-scoped Bolt branch.
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
  const priorTargetHead = currentSha(repoCwd);
  const disabledHooksPath = join(
    tmpdir(),
    `aidlc-disabled-hooks-${process.pid}-${randomUUID()}`,
  ).replaceAll("\\", "/");
  const mutationArgs = (args: string[]): string[] =>
    sourceRecord?.kind === "bound"
      ? ["-c", `core.hooksPath=${disabledHooksPath}`, ...args]
      : args;
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
      const m = runGit(
        mutationArgs(["merge", "--squash", "--no-verify", mergeTarget]),
        repoCwd,
      );
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
      const expectedTree = stagedTreeOid(repoCwd);
      if (expectedTree === null) {
        errorWithSlug(slug, "cannot resolve the staged squash merge tree");
      }
      const c = runGit(
        mutationArgs(["commit", "--no-verify", "-m", message]),
        repoCwd,
      );
      if (!c.ok) {
        errorWithSlug(
          slug,
          `git commit failed: ${c.stderr.trim() || `exit ${c.code}`}`
        );
      }
      commitSha = currentSha(repoCwd);
      assertLandedMergeCommit(
        slug,
        repoCwd,
        priorTargetHead,
        commitSha,
        expectedTree,
        null,
      );
      break;
    }
    case "merge": {
      const m = runGit(
        mutationArgs([
          "merge",
          "--no-ff",
          "--no-commit",
          "--no-verify",
          mergeTarget,
        ]),
        repoCwd,
      );
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
      const expectedTree = stagedTreeOid(repoCwd);
      if (expectedTree === null) {
        errorWithSlug(slug, "cannot resolve the staged merge tree");
      }
      const c = runGit(
        mutationArgs([
          "commit",
          "--no-verify",
          "-m",
          `Merge bolt ${slug}`,
        ]),
        repoCwd,
      );
      if (!c.ok) {
        errorWithSlug(
          slug,
          `git commit failed: ${c.stderr.trim() || `exit ${c.code}`}`,
        );
      }
      commitSha = currentSha(repoCwd);
      assertLandedMergeCommit(
        slug,
        repoCwd,
        priorTargetHead,
        commitSha,
        expectedTree,
        sourceRecord?.kind === "bound"
          ? sourceRecord.commit
          : undefined,
      );
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
    const priorCommittedRepo = gitCommitSourceListing(
      repoCwd,
      priorTargetHead,
      repoTarget.repo === null,
    );
    const landedCommittedRepo = gitCommitSourceListing(
      repoCwd,
      commitSha,
      repoTarget.repo === null,
    );
    if (priorCommittedRepo === null || landedCommittedRepo === null) {
      errorWithSlug(
        slug,
        `${cleanupTag} cannot reconstruct the committed source delta; no SWARM_SOURCE_MERGED authority was emitted. Do not retry this merge. Preserve the worktree and restart the stage attempt.`,
      );
    }
    const expectedAfter = expectedAggregateAfterCommit(
      aggregateBefore.state.listing,
      priorCommittedRepo,
      landedCommittedRepo,
      repoTarget.repo,
    );
    const mismatchedEntries = [
      ...changedSourceListingKeys(expectedAfter, aggregateAfter.listing),
    ];
    if (mismatchedEntries.length > 0) {
      errorWithSlug(
        slug,
        `${cleanupTag} post-merge source does not match landed merge commit ${commitSha} (${renderSourcePathKeys(mismatchedEntries) || "unknown paths"}); no SWARM_SOURCE_MERGED authority was emitted. Do not retry this merge. Preserve the worktree and restart the stage attempt.`,
      );
    }
    if (currentSha(repoCwd) !== commitSha) {
      errorWithSlug(
        slug,
        `${cleanupTag} target HEAD changed after the source merge result was verified; no SWARM_SOURCE_MERGED authority was emitted. Do not retry this merge. Preserve the worktree and restart the stage attempt.`,
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
          "Previous Source Fingerprint": aggregateBefore.openingFingerprint,
          "Source Fingerprint": aggregateAfter.fingerprint,
          "Source Commit": sourceRecord.commit,
          "Merge commit": commitSha,
          Repo: repoTarget.repo ?? "-",
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
  assertBoltBranchOwnedHere(repoCwd, identity, cleanupTag);
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
    for (const frameworkPath of frameworkPathspecs) {
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
    const clean = runGit(
      ["clean", "-ffdx", "--", ...frameworkPathspecs],
      wtPath,
    );
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
        return workspaceSourcePathIsExcluded(wtPath, path) !== true;
      });
    if (remainingApplicationLines.length > 0) {
      errorWithSlug(
        slug,
        `${cleanupTag} application source changed during the bypassed merge; worktree preserved`,
      );
    }
  } else {
    // Ordinary Bolts also carry framework-owned runtime attestations under the
    // root .aidlc/ shell. Git treats that ignored directory as one cleanable
    // entry, so remove the shell as a unit; non-forced worktree removal below
    // must continue to protect every application path.
    const clean = runGit(
      ["clean", "-ffdx", "--", ...frameworkPathspecs],
      wtPath,
    );
    if (!clean.ok) {
      errorWithSlug(
        slug,
        `${cleanupTag} ordinary Bolt metadata cleanup failed: ${clean.stderr.trim() || `exit ${clean.code}`}`,
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
  assertBoltBranchOwnedHere(repoCwd, identity, cleanupTag);
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
  const retained = retainedSourceRefs(repoCwd, identity);
  if (retained === null) {
    errorWithSlug(slug, `${cleanupTag} reviewed-source ref enumeration failed`);
  }
  const refCleanupError = deleteRetainedSourceRefs(repoCwd, identity, retained, cleanupTag);
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

const PARKED_STAMP_RE = /^\d{8}T\d{6}Z(?:-[2-9]|-[1-9]\d+)?$/;

function parkedSourceRefs(repoCwd: string, identity: BoltIdentity): RetainedSourceRef[] {
  const prefix = identity.parkedRefPrefix;
  const listed = runGit(["for-each-ref", "--format=%(refname)%09%(objectname)", prefix], repoCwd);
  if (!listed.ok) throw new Error(listed.stderr.trim() || "parked ref enumeration failed");
  return listed.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [ref, oid] = line.split("\t");
    if (!ref?.startsWith(prefix) || !/^[0-9a-f]{40,64}$/.test(oid ?? "")) {
      throw new Error("invalid parked ref enumeration");
    }
    const suffix = ref.slice(prefix.length);
    const slash = suffix.indexOf("/");
    if (slash === -1 || !PARKED_STAMP_RE.test(suffix.slice(0, slash)) ||
      !/^(?:head|snapshot|branch-tip|reviewed-source\/[0-9a-f]{40,64})$/.test(suffix.slice(slash + 1))) return [];
    return [{ ref, oid }];
  });
}

function parkedStamp(ref: string, identity: BoltIdentity): string {
  return ref.slice(identity.parkedRefPrefix.length).split("/")[0];
}

function validateParkedStamp(stamp: string | undefined): void {
  if (stamp !== undefined && !PARKED_STAMP_RE.test(stamp)) {
    error(`Invalid --parked: "${stamp}". Expected YYYYMMDDTHHMMSSZ or its numbered suffix.`);
  }
}

interface ParkedAttempt {
  ref: string;
  commit: string;
  mode: "snapshot" | "branch-tip" | "evidence-only";
}

function parkAttempt(
  repoCwd: string,
  identity: BoltIdentity,
  wtPath: string,
  dirExists: boolean,
  registered: boolean,
  branchExists: boolean,
  retained: RetainedSourceRef[],
): ParkedAttempt {
  const baseStamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const occupied = new Set(parkedSourceRefs(repoCwd, identity).map(({ ref }) => parkedStamp(ref, identity)));
  let stamp = baseStamp;
  for (let suffix = 2; occupied.has(stamp); suffix++) stamp = `${baseStamp}-${suffix}`;
  const ref = `${identity.parkedRefPrefix}${stamp}`;
  const objectEnv = { GIT_NO_REPLACE_OBJECTS: "1" };
  const requireGit = (args: string[], cwd = repoCwd, env: NodeJS.ProcessEnv = objectEnv): string => {
    const result = runGit(args, cwd, env);
    if (!result.ok) throw new Error(result.stderr.trim() || `git ${args[0]} exited ${result.code}`);
    return result.stdout.trim();
  };
  let commit: string | null = null;
  let branchTip: string | null = null;
  if (dirExists) {
    if (!registered) throw new Error("worktree directory is not registered with the creating repository");
    const idx = join(tmpdir(), `aidlc-park-${process.pid}-${randomUUID()}`);
    // An internal snapshot must not depend on the user's identity or mutate the
    // live index/branch. Seed tracked paths before add so ignored tracked files survive.
    const env = {
      ...objectEnv,
      GIT_INDEX_FILE: idx,
      GIT_AUTHOR_NAME: "AI-DLC",
      GIT_AUTHOR_EMAIL: "aidlc@localhost",
      GIT_COMMITTER_NAME: "AI-DLC",
      GIT_COMMITTER_EMAIL: "aidlc@localhost",
    };
    try {
      const head = requireGit(["rev-parse", "--verify", `refs/heads/${identity.branch}^{commit}`]);
      branchTip = head;
      requireGit(["read-tree", head], wtPath, env);
      requireGit(["add", "-A"], wtPath, env);
      // Clean filters may transform dirty bytes; the park must hold the exact
      // bytes that `worktree remove --force` is about to destroy.
      // Symlinks and gitlinks stay exactly as `git add -A` staged them.
      const listed = Bun.spawnSync(["git", "ls-files", "-s", "-z"], {
        cwd: wtPath,
        env: { ...process.env, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString().trim() || `exit ${listed.exitCode}`}`);
      const includedRegularPaths = new Set<string>();
      const regularPathBytes: Buffer[] = [];
      const nonUtf8Paths: Buffer[] = [];
      for (let start = 0; start < listed.stdout.length;) {
        const end = listed.stdout.indexOf(0, start);
        if (end === -1) throw new Error("invalid parked index entry");
        const record = listed.stdout.subarray(start, end + 1);
        start = end + 1;
        if (!/^100(?:644|755) /.test(record.subarray(0, 7).toString("ascii"))) continue;
        const tab = record.indexOf(0x09);
        if (tab === -1) throw new Error("cannot parse a parked regular-file index entry");
        regularPathBytes.push(record.subarray(tab + 1));
        const pathBytes = record.subarray(tab + 1, -1);
        const path = pathBytes.toString();
        if (Buffer.from(path).equals(pathBytes)) includedRegularPaths.add(path);
        else nonUtf8Paths.push(record.subarray(tab + 1));
      }
      if (nonUtf8Paths.length > 0) {
        // String-based attribute/hash helpers cannot address these filenames.
        // Ask Git with the original NUL-terminated bytes before trusting add's blobs.
        const attrs = Bun.spawnSync(["git", "check-attr", "-z", "--stdin", "filter", "text", "eol", "ident", "working-tree-encoding"], {
          cwd: wtPath,
          env: { ...process.env, ...env },
          stdin: Buffer.concat(nonUtf8Paths),
          stdout: "pipe",
          stderr: "pipe",
        });
        if (attrs.exitCode !== 0) throw new Error(`git check-attr failed: ${attrs.stderr.toString().trim() || `exit ${attrs.exitCode}`}`);
        for (let start = 0; start < attrs.stdout.length;) {
          const pathEnd = attrs.stdout.indexOf(0, start);
          const attrEnd = pathEnd === -1 ? -1 : attrs.stdout.indexOf(0, pathEnd + 1);
          const valueEnd = attrEnd === -1 ? -1 : attrs.stdout.indexOf(0, attrEnd + 1);
          if (valueEnd === -1) throw new Error("invalid parked path attributes");
          const value = attrs.stdout.subarray(attrEnd + 1, valueEnd).toString();
          if (value !== "unspecified" && value !== "unset") {
            const attribute = attrs.stdout.subarray(pathEnd + 1, attrEnd).toString();
            const path = attrs.stdout.subarray(start, pathEnd);
            throw new Error(`cannot park file with a non-UTF-8 name and a content-transforming attribute (${attribute}=${value}): ${JSON.stringify(path.toString("latin1"))}; rename the file or unset its ${attribute} attribute`);
          }
          start = valueEnd + 1;
        }
      }
      // working-tree-encoding re-encodes on add like a clean filter but is not a
      // filter, so the shared filteredRawIndexEntries helper does not see it.
      if (regularPathBytes.length > 0) {
        const attrs = Bun.spawnSync(["git", "check-attr", "-z", "--stdin", "working-tree-encoding"], {
          cwd: wtPath,
          env: { ...process.env, ...env },
          stdin: Buffer.concat(regularPathBytes),
          stdout: "pipe",
          stderr: "pipe",
        });
        if (attrs.exitCode !== 0) throw new Error(`git check-attr failed: ${attrs.stderr.toString().trim() || `exit ${attrs.exitCode}`}`);
        const unspecified = Buffer.from("unspecified");
        const unset = Buffer.from("unset");
        for (let start = 0; start < attrs.stdout.length;) {
          const pathEnd = attrs.stdout.indexOf(0, start);
          const attrEnd = pathEnd === -1 ? -1 : attrs.stdout.indexOf(0, pathEnd + 1);
          const valueEnd = attrEnd === -1 ? -1 : attrs.stdout.indexOf(0, attrEnd + 1);
          if (valueEnd === -1) throw new Error("invalid parked path attributes");
          const pathBytes = attrs.stdout.subarray(start, pathEnd);
          const value = attrs.stdout.subarray(attrEnd + 1, valueEnd);
          start = valueEnd + 1;
          if (value.equals(unspecified) || value.equals(unset)) continue;
          const path = pathBytes.toString();
          const indexed = requireGit(["ls-files", "-s", "-z", "--", path], wtPath, env);
          const mode = indexed.slice(0, indexed.indexOf(" "));
          if (!/^100(?:644|755)$/.test(mode)) {
            throw new Error(`cannot resolve the index mode for encoded path ${path}`);
          }
          const raw = requireGit(["hash-object", "-w", "--no-filters", "--", path], wtPath, env);
          requireGit(["update-index", "--cacheinfo", mode, raw, path], wtPath, env);
        }
      }
      const rawEntries = filteredRawIndexEntries(wtPath, idx, includedRegularPaths);
      if (rawEntries === null) throw new Error("cannot compare raw bytes for filtered paths");
      for (const entry of rawEntries) {
        const indexed = requireGit(["ls-files", "-s", "-z", "--", entry.path], wtPath, env);
        const mode = indexed.slice(0, indexed.indexOf(" "));
        if (!/^100(?:644|755)$/.test(mode)) {
          throw new Error(`cannot resolve the index mode for filtered path ${entry.path}`);
        }
        const raw = requireGit(["hash-object", "-w", "--no-filters", "--", entry.path], wtPath, env);
        if (raw !== entry.sha) {
          throw new Error(`cannot materialize raw parked bytes for filtered path ${entry.path}`);
        }
        requireGit(["update-index", "--cacheinfo", mode, entry.sha, entry.path], wtPath, env);
      }
      const tree = requireGit(["write-tree"], wtPath, env);
      commit = requireGit([
        "commit-tree", tree, "-p", head, "-m",
        `aidlc: parked ${identity.name} at ${stamp} (agent-discard)`,
      ], wtPath, env);
    } finally {
      rmSync(idx, { force: true });
    }
  } else if (branchExists) {
    commit = requireGit(["rev-parse", "--verify", `refs/heads/${identity.branch}^{commit}`]);
  }
  const mode = dirExists ? "snapshot" : branchExists ? "branch-tip" : "evidence-only";
  if (commit !== null) {
    requireGit(["update-ref", `${ref}/head`, commit, ""]);
    requireGit(["update-ref", `${ref}/${mode}`, commit, ""]);
    // A retry after checkout removal must distinguish this branch from a reused legacy name.
    if (branchTip !== null) requireGit(["update-ref", `${ref}/branch-tip`, branchTip, ""]);
  }
  // Copy every source ref before audit/removal. Originals remain intact if any
  // copy fails; their compare-and-delete runs only after successful teardown.
  for (const source of retained) {
    const sourceCommit = source.ref.slice(source.ref.lastIndexOf("/") + 1);
    requireGit(["update-ref", `${ref}/reviewed-source/${sourceCommit}`, source.oid, ""]);
  }
  return { ref, commit: commit ?? "-", mode };
}

function assertNoForeignBoltDirectory(pd: string, identity: BoltIdentity, selection: WorkflowSelection): void {
  const root = worktreesDir(pd);
  if (!existsSync(root)) return;
  for (const name of readdirSync(root).sort()) {
    const parsed = parseBoltName(name);
    if (parsed === null || parsed.slug !== identity.slug || name === identity.name) continue;
    errorWithSlug(
      identity.slug,
      `no Bolt ${identity.slug} belongs to intent ${relativeRecordDirForSelection(selection)}; this checkout holds ${name} (${parsed.intentId8 === null ? "legacy" : `intent ${parsed.intentId8}`}) at ${join(root, name)} — select that intent to discard it`,
    );
  }
}

// --- Subcommand: discard ---
//
// Usage: aidlc-worktree discard --slug <slug> [--repo <name>]
//                               [--intent <dir>] [--space <name>]
//
// --repo (P7): the sibling repo the worktree was forked in — same resolution as
// `create`. Park the attempt in Git before auditing/removing the live checkout.
// With no directory, branch, or retained sources, succeed without another audit.
function handleDiscard(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  const pd = resolveProjectDir(projectDir);
  if (flags.repo !== undefined && !isValidRepoName(flags.repo)) {
    errorWithSlug(slug, `Invalid --repo "${flags.repo}": a repo name must be a single path segment matching ${REPO_NAME_REGEX}.`);
  }
  const selection = resolveWorkflowSelection(pd, { intent: flags.intent, space: flags.space });
  const identity = resolveCommandBoltIdentity(pd, slug, selection);
  if (selection.intent !== null) flags.intent = selection.intent;
  flags.space = selection.space;
  const recorded = recordedWorktreeSelector(identity);
  const authority = discardCreationAuthority(
    pd,
    identity,
    selection,
    recorded,
    flags.repo,
  );
  const wtPath = identity.dir;
  if (!authority.evidenceExists) {
    assertNoForeignBoltDirectory(pd, identity, selection);
    console.log(
      JSON.stringify({
        emitted: null,
        slug,
        worktree_path: wtPath,
        reason: "already-discarded",
      }),
    );
    return;
  }
  if (authority.space !== undefined) {
    const authorityRecord =
      authority.intent === undefined
        ? null
        : `aidlc/spaces/${authority.space}/intents/${authority.intent}`;
    if (
      relativeRecordDir(pd, flags.intent, flags.space) !== authorityRecord
    ) {
      errorWithSlug(
        slug,
        `refusing to discard: selected intent ${JSON.stringify(relativeRecordDir(pd, flags.intent, flags.space))} does not match creating intent ${JSON.stringify(authorityRecord)}`,
      );
    }
  }
  const creatingRepo =
    authority.repo !== undefined
      ? authority.repo
      : recorded?.repoSelector;
  if (flags.repo === undefined && typeof creatingRepo === "string") {
    flags.repo = creatingRepo;
  }
  if (
    flags.repo !== undefined &&
    creatingRepo !== undefined &&
    flags.repo !== creatingRepo
  ) {
    errorWithSlug(
      slug,
      `refusing to discard: selected repository ${JSON.stringify(flags.repo)} does not match creating repository ${JSON.stringify(creatingRepo ?? "-")}`,
    );
  }
  // P7: anchor every git op to the target sibling repo (or projectDir for legacy).
  const { cwd: repoCwd, repo: parkedRepo } = creatingRepo === null
    ? { cwd: pd, repo: null }
    : resolveRepoTarget(pd, flags, slug);
  assertNotSiblingWorktree(repoCwd);
  assertBoltBranchOwnedHere(repoCwd, identity, "Discard");

  const branchName = identity.branch;
  const dirExists = existsSync(wtPath);
  const registered = repositoryRegistersBoltWorktree(pd, repoCwd, identity);
  const branch = runGit([
    "rev-parse",
    "--verify",
    `refs/heads/${branchName}`,
  ], repoCwd);
  const branchExists = branch.ok;
  if (identity.legacy && !dirExists && branchExists && authority.legacyDiscardRef !== undefined) {
    const ref = authority.legacyDiscardRef;
    let recordedTip: string | null = null;
    if (ref?.startsWith(identity.parkedRefPrefix) &&
      PARKED_STAMP_RE.test(ref.slice(identity.parkedRefPrefix.length))) {
      const tip = runGit(["rev-parse", "--verify", `${ref}/branch-tip`], repoCwd);
      const head = tip.ok ? tip : runGit(["rev-parse", "--verify", `${ref}/head`], repoCwd);
      if (head.ok) recordedTip = head.stdout.trim();
    }
    if (recordedTip !== branch.stdout.trim()) {
      errorWithSlug(slug, `legacy branch ${branchName} tip does not match this intent's recorded discard; leaving it for inspection`);
    }
  }
  if (identity.legacy && !dirExists && branchExists && authority.legacyMergeRecorded) {
    errorWithSlug(
      slug,
      `legacy Bolt ${slug} recorded a merge; finish it with merge --slug ${slug} (cleanup-only) instead of discard — the leftover branch ${branchName} may belong to a later attempt`,
    );
  }
  const retained = retainedSourceRefs(repoCwd, identity);
  if (retained === null) {
    errorWithSlug(slug, "reviewed-source ref enumeration failed");
  }

  if (!dirExists && !branchExists && retained.length === 0) {
    assertNoForeignBoltDirectory(pd, identity, selection);
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

  const discardedApproval = dirExists &&
    relativeRecordDir(pd, flags.intent, flags.space) === relativeRecordDir(pd)
    ? (() => {
        const swarmIdentity = currentSwarmWorktreeIdentity(identity);
        return swarmIdentity?.stage === "code-generation"
          ? captureCodeGenerationDiscardApproval(pd, wtPath, swarmIdentity.unit) : null;
      })()
    : null;
  let parked: ParkedAttempt;
  try {
    parked = parkAttempt(repoCwd, identity, wtPath, dirExists, registered, branchExists, retained);
  } catch (e) {
    errorWithSlug(slug, `refusing to discard: parking the attempt failed: ${errorMessage(e)}`);
  }
  let auditTs: string;
  try {
    auditTs = emitAudit(pd, "WORKTREE_DISCARDED", {
      "Bolt slug": slug,
      "Worktree path": auditWorktreePath(pd, wtPath),
      Repo: parkedRepo ?? "-",
      Reason: "agent-discard",
      ...discardedApproval,
      "Parked ref": parked.ref,
      "Parked commit": parked.commit,
    }, flags.intent, flags.space);
  } catch (e) {
    errorWithSlug(slug, `Audit emission failed: ${errorMessage(e)}`);
  }

  if (dirExists || registered) {
    const rm = runGit(["worktree", "remove", "--force", wtPath], repoCwd);
    if (!rm.ok) {
      errorWithSlug(
        slug,
        `git worktree remove failed: ${rm.stderr.trim() || `exit ${rm.code}`}`
      );
    }
  }
  if (branchExists) {
    assertBoltBranchOwnedHere(repoCwd, identity, "Discard");
    const del = runGit(["branch", "-D", branchName], repoCwd);
    if (!del.ok) {
      errorWithSlug(
        slug,
        `branch -D ${branchName} failed: ${del.stderr.trim() || `exit ${del.code}`}`
      );
    }
  }
  const refCleanupError = deleteRetainedSourceRefs(repoCwd, identity, retained, "Discard");
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
      parked_ref: parked.ref,
      parked_commit: parked.commit,
      parked_stamp: parkedStamp(parked.ref, identity),
      parked_mode: parked.mode,
      parked_repo: parkedRepo,
    })
  );
}

// --- Subcommands: restore / purge ---
// Local recovery uses a separate path and branch namespace, never a live Bolt.
interface ParkedRecoveryScope {
  identity: BoltIdentity;
  stamps: ReadonlySet<string>;
}

interface ParkedRecoveryRef extends RetainedSourceRef {
  identity: BoltIdentity;
  stamp: string;
}

function parkedRecoveryScopes(
  pd: string,
  identity: BoltIdentity,
  rows: readonly WorktreeAuditRow[],
): ParkedRecoveryScope[] {
  const identities = identity.legacy
    ? [identity]
    : [identity, legacyBoltIdentity(pd, identity.intentId8, identity.slug)];
  return identities.map((parkedIdentity) => {
    const stamps = new Set<string>();
    // Namespaced refs are shared by every checkout of this repository too;
    // only this intent's recorded parks authorize their recovery or deletion.
    for (const row of rows) {
      if (row.event !== "WORKTREE_DISCARDED" || auditBlockField(row.block, "Bolt slug") !== identity.slug) continue;
      const ref = auditBlockField(row.block, "Parked ref");
      if (ref === null || !ref.startsWith(parkedIdentity.parkedRefPrefix)) continue;
      const stamp = ref.slice(parkedIdentity.parkedRefPrefix.length);
      if (PARKED_STAMP_RE.test(stamp)) stamps.add(stamp);
    }
    return { identity: parkedIdentity, stamps };
  });
}

function parkedRecoveryRefs(repoCwd: string, scopes: readonly ParkedRecoveryScope[]): ParkedRecoveryRef[] {
  return scopes.flatMap(({ identity, stamps }) =>
    parkedSourceRefs(repoCwd, identity).flatMap((entry) => {
      const stamp = parkedStamp(entry.ref, identity);
      return !stamps.has(stamp)
        ? []
        : [{ ...entry, identity, stamp }];
    }));
}

function parkedRepoCwd(
  pd: string,
  flags: Record<string, string>,
  identity: BoltIdentity,
  scopes: readonly ParkedRecoveryScope[],
  rows: readonly WorktreeAuditRow[],
): string {
  const slug = identity.slug;
  if (flags.parked !== undefined && !scopes.some(({ stamps }) => stamps.has(flags.parked))) {
    errorWithSlug(slug, `parked attempt ${flags.parked} is not recorded by intent ${relativeRecordDir(pd, flags.intent, flags.space)}`);
  }
  const candidates = worktreeRepoCandidates(pd, rows, slug);
  if (flags.repo !== undefined) {
    const repo = flags.repo === "." ? null : flags.repo;
    if (repo !== null && !candidates.has(repoSelectorKey(repo)) && isValidRepoName(repo) && lstatSync(repoDir(pd, repo), { throwIfNoEntry: false })?.isSymbolicLink()) {
      errorWithSlug(slug, `"${repo}" is a symlink, not a workspace repository`);
    }
    if (repo !== null && (!isValidRepoName(repo) || !candidates.has(repoSelectorKey(repo)))) {
      errorWithSlug(slug, `Invalid --repo "${flags.repo}": no matching recovery repository; use . for the project root or an existing sibling Git repository name.`);
    }
    const cwd = repo === null ? pd : repoDir(pd, repo);
    const root = runGit(["rev-parse", "--show-toplevel"], cwd);
    if (!existsSync(join(cwd, ".git")) || !root.ok || pathKey(root.stdout.trim()) !== pathKey(cwd)) {
      errorWithSlug(slug, `Invalid --repo "${flags.repo}": no Git repository at ${cwd}.`);
    }
    return cwd;
  }
  const parkedRepos: { cwd: string; repo: string | null; exact: boolean }[] = [];
  for (const repo of candidates.values()) {
    const cwd = repo === null ? pd : repoDir(pd, repo);
    if (!existsSync(join(cwd, ".git")) || !runGit(["rev-parse", "--git-dir"], cwd).ok) continue;
    const refs = parkedRecoveryRefs(cwd, scopes);
    if (refs.length > 0) parkedRepos.push({ cwd, repo,
      exact: flags.parked !== undefined && refs.some(({ stamp }) => stamp === flags.parked),
    });
  }
  if (flags.parked !== undefined) {
    const exact = parkedRepos.filter((candidate) => candidate.exact);
    if (exact.length === 1) return exact[0].cwd;
  }
  if (parkedRepos.length === 0) {
    errorWithSlug(slug, `no parked attempt for slug ${slug}`);
  }
  if (parkedRepos.length > 1) {
    const labels = parkedRepos
      .map(({ repo }) => repo ?? ".")
      .sort()
      .map((value) => JSON.stringify(value))
      .join(", ");
    errorWithSlug(
      slug,
      `parked attempts for slug ${slug} exist in several repositories (${labels}); pass --repo <name> or --repo . for the project root`,
    );
  }
  return parkedRepos[0].cwd;
}

/** Validate Git's relative path without decoding the bytes used for filesystem IO. */
export function restoreDestination(
  rootRealpath: Buffer,
  pathBytes: Buffer,
): { destination: Buffer; parent: Buffer } {
  // Decode only for lexical checks: filenames may contain arbitrary non-UTF-8 bytes.
  const path = pathBytes.toString();
  const root = rootRealpath.toString();
  if (!path || pathBytes.includes(0) || isAbsolute(path) ||
      path.split("/").includes("..") ||
      !resolve(root, path).startsWith(`${root}${sep}`)) {
    throw new Error(`refusing parked path outside the restore checkout: ${JSON.stringify(path)}`);
  }
  const destination = Buffer.concat([rootRealpath, Buffer.from(sep), pathBytes]);
  const slash = pathBytes.lastIndexOf(0x2f);
  const parent = slash === -1 ? rootRealpath : destination.subarray(0, rootRealpath.length + 1 + slash);
  return { destination, parent };
}

/** Check existing prefixes before recursive mkdir can follow a symlink outside the checkout. */
export function assertNoSymlinkedAncestor(rootRealpath: Buffer, parent: Buffer): void {
  for (let end = rootRealpath.length + 1; end <= parent.length; end++) {
    if (end !== parent.length && parent[end] !== 0x2f && parent[end] !== sep.charCodeAt(0)) continue;
    const ancestor = parent.subarray(0, end);
    const stat = lstatSync(ancestor, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing symlinked parked parent: ${JSON.stringify(ancestor.toString())}`);
    }
  }
}

/** Reject symlinked parents, including aliases whose targets remain inside the checkout. */
export function assertParentInsideCheckout(rootRealpath: Buffer, parent: Buffer): void {
  const isSeparator = (byte: number): boolean => byte === 0x2f || byte === sep.charCodeAt(0);
  const inside = (path: Buffer): boolean => path.equals(rootRealpath) ||
    (path.subarray(0, rootRealpath.length).equals(rootRealpath) && isSeparator(path[rootRealpath.length]));
  if (!inside(parent) || !inside(realpathSync(parent, { encoding: "buffer" }))) {
    throw new Error(`refusing parked parent outside the restore checkout: ${JSON.stringify(parent.toString())}`);
  }
  assertNoSymlinkedAncestor(rootRealpath, parent);
}

function handleRestore(args: string[]): void {
  // --raw is a bare boolean; parseFlags handles only value-bearing flags.
  const flags = parseFlags(args.filter((arg) => arg !== "--raw"));
  const slug = validateSlug(flags.slug);
  validateParkedStamp(flags.parked);
  const pd = resolveProjectDir(projectDir);
  const selection = resolveWorkflowSelection(pd, { intent: flags.intent, space: flags.space });
  const identity = resolveCommandBoltIdentity(pd, slug, selection);
  if (selection.intent !== null) flags.intent = selection.intent;
  flags.space = selection.space;
  const rows = readAuditShardEvents(pd, selection.intent ?? undefined, selection.space);
  const scopes = parkedRecoveryScopes(pd, identity, rows);
  const repoCwd = parkedRepoCwd(pd, flags, identity, scopes, rows);
  assertNotSiblingWorktree(repoCwd);
  const refs = parkedRecoveryRefs(repoCwd, scopes);
  const heads = refs.filter(({ ref, identity: parkedIdentity, stamp }) =>
    ref === `${parkedIdentity.parkedRefPrefix}${stamp}/head` &&
    PARKED_STAMP_RE.test(stamp) &&
    (flags.parked === undefined || stamp === flags.parked));
  heads.sort((a, b) => a.stamp.localeCompare(b.stamp, "en", { numeric: true }));
  const head = heads.at(-1);
  if (!head) {
    const evidence = refs.filter(({ ref, stamp }) =>
      /\/reviewed-source\/(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref) &&
      PARKED_STAMP_RE.test(stamp) &&
      (flags.parked === undefined || stamp === flags.parked));
    evidence.sort((a, b) => a.stamp.localeCompare(b.stamp, "en", { numeric: true }));
    const latestEvidence = evidence.at(-1);
    if (latestEvidence) {
      errorWithSlug(slug, `no restorable files were parked for ${slug} ${latestEvidence.stamp}; only review evidence was kept`);
    }
    errorWithSlug(slug, `no parked attempt for slug ${slug}${flags.parked ? ` at ${flags.parked}` : ""}`);
  }
  const { stamp, identity: parkedIdentity } = head;
  const parkedRef = head.ref.slice(0, -"/head".length);
  const wtPath = resolve(pd, ".aidlc", "restored", `${parkedIdentity.name}-${stamp}`);
  const branch = `restore/${parkedIdentity.name}-${stamp}`;
  if (existsSync(wtPath) || runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoCwd).ok) {
    errorWithSlug(slug, `already restored at ${wtPath}`);
  }
  let restoreMode: "snapshot" | "branch-tip" | "legacy-snapshot" | "legacy-branch-tip" | "raw-requested";
  if (args.includes("--raw")) {
    restoreMode = "raw-requested";
  } else if (refs.some(({ ref }) => ref === `${parkedRef}/snapshot`)) {
    restoreMode = "snapshot";
  } else if (refs.some(({ ref }) => ref === `${parkedRef}/branch-tip`)) {
    restoreMode = "branch-tip";
  } else {
    // Legacy parks have only /head for both shapes. Only tool-authored snapshot
    // commits contain working-tree bytes; ordinary branch tips need checkout conversions.
    const commitIdentity = runGit(["log", "-1", "--format=%an%x00%ae%x00%s", head.oid], repoCwd, { GIT_NO_REPLACE_OBJECTS: "1" });
    if (!commitIdentity.ok) errorWithSlug(slug, `cannot classify parked head: ${commitIdentity.stderr.trim() || `exit ${commitIdentity.code}`}`);
    const [author, email, subject] = commitIdentity.stdout.split("\0");
    restoreMode = author === "AI-DLC" && email === "aidlc@localhost" && subject?.startsWith(`aidlc: parked ${parkedIdentity.name} at `)
      ? "legacy-snapshot" : "legacy-branch-tip";
  }
  const raw = restoreMode !== "branch-tip" && restoreMode !== "legacy-branch-tip";
  const added = runGit(["worktree", "add", ...(raw ? ["--no-checkout"] : []), "-b", branch, wtPath, head.oid], repoCwd);
  if (!added.ok) {
    errorWithSlug(slug, `git worktree add failed: ${added.stderr.trim() || `exit ${added.code}`}${raw ? "" : "; --raw bypasses checkout filters"}`);
  }
  let materialized = 0;
  if (raw) {
    const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
    try {
      const indexed = runGit(["read-tree", head.oid], wtPath, env);
      if (!indexed.ok) throw new Error(`git read-tree failed: ${indexed.stderr.trim() || `exit ${indexed.code}`}`);
      const listed = Bun.spawnSync(["git", "ls-files", "-s", "-z"], {
        cwd: wtPath,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString().trim() || `exit ${listed.exitCode}`}`);
      const symlinkConfig = runGit(["config", "--bool", "core.symlinks"], wtPath, env);
      if (!symlinkConfig.ok && symlinkConfig.code !== 1) {
        throw new Error(`git config core.symlinks failed: ${symlinkConfig.stderr.trim() || `exit ${symlinkConfig.code}`}`);
      }
      const symlinks = symlinkConfig.stdout.trim() !== "false";
      const rootRealpath = realpathSync(Buffer.from(wtPath), { encoding: "buffer" });
      const umask = process.umask();
      for (let start = 0; start < listed.stdout.length;) {
        const end = listed.stdout.indexOf(0, start);
        if (end === -1) throw new Error("invalid parked index entry");
        const entry = listed.stdout.subarray(start, end);
        start = end + 1;
        const tab = entry.indexOf(0x09);
        const match = /^([0-7]{6}) ([0-9a-f]{40,64}) 0$/.exec(entry.subarray(0, tab).toString("ascii"));
        if (tab === -1 || !match) throw new Error("invalid parked index entry");
        const [, mode, sha] = match;
        const pathBytes = entry.subarray(tab + 1);
        const { destination, parent } = restoreDestination(rootRealpath, pathBytes);
        if (mode !== "100644" && mode !== "100755" && mode !== "120000" && mode !== "160000") {
          throw new Error(`unsupported parked index mode ${mode} for ${JSON.stringify(pathBytes.toString())}`);
        }
        assertNoSymlinkedAncestor(rootRealpath, parent);
        mkdirSync(parent, { recursive: true });
        assertParentInsideCheckout(rootRealpath, parent);
        if (mode === "160000") {
          mkdirSync(destination);
          continue;
        }
        if (mode === "120000") {
          // Only symlink targets are small enough to buffer in memory.
          const blob = Bun.spawnSync(["git", "cat-file", "blob", sha], {
            cwd: wtPath,
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          if (blob.exitCode !== 0) {
            throw new Error(`git cat-file failed for ${JSON.stringify(pathBytes.toString())}: ${blob.stderr.toString().trim() || `exit ${blob.exitCode}`}`);
          }
          if (symlinks) symlinkSync(blob.stdout, destination);
          else writeFileSync(destination, blob.stdout, { flag: "wx" });
        } else {
          const fd = openSync(destination, "wx");
          let blob: SpawnSyncReturns<Buffer>;
          try {
            blob = spawnSync("git", ["cat-file", "blob", sha], {
              cwd: wtPath,
              env,
              stdio: ["ignore", fd, "pipe"],
            });
          } finally {
            closeSync(fd);
          }
          if (blob.status !== 0) {
            rmSync(destination, { force: true });
            throw new Error(`git cat-file failed for ${JSON.stringify(pathBytes.toString())}: ${blob.stderr?.toString().trim() || blob.error?.message || `exit ${blob.status}`}`);
          }
          if (mode === "100755") chmodSync(destination, 0o777 & ~umask);
        }
        materialized++;
      }
    } catch (e) {
      errorWithSlug(slug, `raw restore failed: ${errorMessage(e)}; partial checkout left in place at ${wtPath}`);
    }
  }
  console.log(JSON.stringify({
    restored: true,
    slug,
    parked_ref: parkedRef,
    worktree_path: wtPath,
    branch,
    reviewed_source_refs: refs.filter(({ ref }) => ref.startsWith(`${parkedRef}/reviewed-source/`)).length,
    ...(raw ? { materialized } : {}),
    raw_bytes: raw,
    restore_mode: restoreMode,
  }));
}

function handlePurge(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);
  validateParkedStamp(flags.parked);
  let cutoff: number | undefined;
  if (flags["older-than"] !== undefined) {
    if (flags.parked !== undefined) error("--older-than and --parked are mutually exclusive.");
    const days = Number(flags["older-than"]);
    if (!flags["older-than"].trim() || !Number.isFinite(days) || days < 0) {
      error("Invalid --older-than: expected a non-negative finite number of days.");
    }
    cutoff = Date.now() - days * 86_400_000;
  }
  const pd = resolveProjectDir(projectDir);
  const selection = resolveWorkflowSelection(pd, { intent: flags.intent, space: flags.space });
  const identity = resolveCommandBoltIdentity(pd, slug, selection);
  if (selection.intent !== null) flags.intent = selection.intent;
  flags.space = selection.space;
  const rows = readAuditShardEvents(pd, selection.intent ?? undefined, selection.space);
  const scopes = parkedRecoveryScopes(pd, identity, rows);
  const repoCwd = parkedRepoCwd(pd, flags, identity, scopes, rows);
  assertNotSiblingWorktree(repoCwd);
  const skippedUnparseable = new Set<string>();
  const refs = parkedRecoveryRefs(repoCwd, scopes).filter(({ stamp }) => {
    if (flags.parked !== undefined && stamp !== flags.parked) return false;
    if (cutoff === undefined) return true;
    const timestamp = parseParkedStampInstant(stamp);
    if (timestamp === null) {
      skippedUnparseable.add(stamp);
      return false;
    }
    return timestamp < cutoff;
  });
  const stamps = [...new Set(refs.map(({ stamp }) => stamp))].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }));
  const listed = runGit(["worktree", "list", "--porcelain"], repoCwd);
  if (!listed.ok) errorWithSlug(slug, `git worktree list failed: ${listed.stderr.trim()}`);
  const attempts = new Map(refs.map(({ identity: parkedIdentity, stamp }) =>
    [`${parkedIdentity.name}-${stamp}`, parkedIdentity]));
  for (const [name, parkedIdentity] of attempts) {
    assertBoltBranchOwnedHere(repoCwd, parkedIdentity, "Purge");
    const wtPath = resolve(pd, ".aidlc", "restored", name);
    const branch = `refs/heads/restore/${name}`;
    // Match registrations too: a restored checkout may have been moved.
    const registeredPath = worktreeCheckedOutAt(listed.stdout, branch);
    if (existsSync(wtPath) || registeredPath) {
      errorWithSlug(slug, `restore checkout still present at ${registeredPath ?? wtPath}; remove it first`);
    }
  }
  for (const { identity: parkedIdentity } of scopes) {
    const scopedRefs = refs.filter((entry) => entry.identity === parkedIdentity);
    if (scopedRefs.length === 0) continue;
    const cleanupError = deleteRetainedSourceRefs(repoCwd, parkedIdentity, scopedRefs, "Purge");
    if (cleanupError) errorWithSlug(slug, `parked ref cleanup failed: ${cleanupError}`);
  }
  console.log(JSON.stringify({
    purged: refs.length,
    slug,
    stamps,
    skipped_unparseable: [...skippedUnparseable].sort(),
  }));
}

// --- Subcommand: list ---
//
// Usage: aidlc-worktree list
//
// Filters `git worktree list --porcelain` output to entries that are AIDLC
// Bolt worktrees: parent path is `<projectDir>/.aidlc/worktrees/` AND the
// basename parses as an intent-scoped or legacy Bolt name. Both conditions are required so an
// unrelated worktree someone happens to name `bolt-other` outside our
// namespace doesn't masquerade as a Bolt. Read-only — no audit emission.
function handleList(_args: string[]): void {
  // No assertNotSiblingWorktree here — list is read-only and useful from
  // anywhere. Run from current cwd's git context.
  const pd = resolveProjectDir(projectDir);
  const boltsDir = pathKey(worktreesDir(pd));

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

  const bolts = all.flatMap((w) => {
    const base = w.path.split(/[\\/]/).filter(Boolean).pop() ?? "";
    const parsed = parseBoltName(base);
    if (parsed === null || pathKey(dirname(w.path)) !== boltsDir) return [];
    return [{
      slug: parsed.slug,
      worktree_path: w.path,
      branch: w.branch,
      intent_id8: parsed.intentId8,
      legacy: parsed.intentId8 === null,
    }];
  });

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
  const selection = resolveWorkflowSelection(pd, { intent: flags.intent, space: flags.space });
  // Read across every per-clone audit shard (single shard in the common case).
  const audit = readAllAuditShards(pd, selection.intent ?? undefined, selection.space);
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
// Reads the latest WORKTREE_CREATED audit block for `slug`. Its Branch name and
// Worktree path are repository content, validated against the selected intent's
// canonical Bolt identity before reading worktree files. JSON carries only the
// canonical reconstruction, never raw field values. Misses/malformed rows fail.
//
// The halt-and-ask flow calls this to interpolate the worktree path and
// branch name into the AskUserQuestion prompt body. Schema pinned in
// `knowledge/aidlc-shared/worktree-info-schema.md`.
function handleInfo(args: string[]): void {
  const flags = parseFlags(args);
  const slug = validateSlug(flags.slug);

  const pd = resolveProjectDir(projectDir);
  const selection = resolveWorkflowSelection(pd, { intent: flags.intent, space: flags.space });
  // Read across every per-clone audit shard (single shard in the common case).
  const audit = readAllAuditShards(pd, selection.intent ?? undefined, selection.space);
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
  if (!AUDIT_TIMESTAMP_RE.test(match.timestamp)) {
    process.stderr.write(
      `error: malformed WORKTREE_CREATED block for Bolt ${slug}: Timestamp is not an ISO 8601 UTC instant\n`
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

  const record = relativeRecordDirForSelection(selection);
  const owner = record === null ? "the selected workspace" : `intent ${record}`;
  const parsed = parseBoltName(branchMatch[1]);
  if (parsed === null || parsed.slug !== slug) {
    process.stderr.write(
      `error: malformed WORKTREE_CREATED block at ${match.timestamp}: Branch name does not name Bolt ${slug} for ${owner}\n`
    );
    process.exit(1);
  }

  let name: string;
  let dir: string;
  let intentId8 = parsed.intentId8;
  if (parsed.intentId8 !== null) {
    const uuid = intentUuidForSelection(pd, selection);
    if (uuid === null) {
      process.stderr.write(
        `error: WORKTREE_CREATED block at ${match.timestamp} names an intent-scoped Bolt, but ${owner} has no registry identity (uuid); adopt or re-create the intent before Construction\n`
      );
      process.exit(1);
    }
    if (idSuffix(uuid) !== parsed.intentId8) {
      process.stderr.write(
        `error: malformed WORKTREE_CREATED block at ${match.timestamp}: Branch name does not name Bolt ${slug} for ${owner}\n`
      );
      process.exit(1);
    }
    name = boltName(parsed.intentId8, slug);
    dir = worktreePath(pd, parsed.intentId8, slug);
  } else {
    name = legacyBoltName(slug);
    dir = legacyWorktreePath(pd, slug);
  }
  if (pathKey(resolveAuditWorktreePath(pd, pathMatch[1])) !== pathKey(dir)) {
    process.stderr.write(
      `error: malformed WORKTREE_CREATED block at ${match.timestamp}: Worktree path is not the canonical directory ${dir} of Bolt ${name}\n`
    );
    process.exit(1);
  }

  // `info` is an audit query: after identity validation, legacy names can recover
  // the intent id from canonical-dir metadata without requiring registry identity.
  if (intentId8 === null) {
    try {
      const meta = JSON.parse(readFileSync(join(dir, ".aidlc", WORKTREE_META_FILENAME), "utf-8")) as { intentId8?: unknown };
      if (typeof meta.intentId8 === "string" && BOLT_INTENT_ID8_REGEX.test(meta.intentId8)) intentId8 = meta.intentId8;
    } catch {
      // Pre-upgrade and already-removed worktrees may have no readable metadata.
    }
  }
  // Read the per-Bolt forked state file for the Merge-Held marker if present.
  // An absent file or field means false: only actively held merges are blocked.
  let mergeHeld = false;
  const wtStatePath = worktreeStateFilePath(dir);
  if (existsSync(wtStatePath)) {
    const wtContent = readFileSync(wtStatePath, "utf-8");
    mergeHeld = getField(wtContent, "Merge-Held") === "true";
  }

  console.log(
    JSON.stringify({
      slug,
      path: dir,
      branch_name: name,
      intent_id8: intentId8,
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
    const validFlags = RECOVERY_FLAGS[subcommand];
    if (validFlags) validateRecoveryFlags(rawArgs, validFlags);
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
      case "restore":
        handleRestore(filteredArgs.slice(1));
        break;
      case "purge":
        handlePurge(filteredArgs.slice(1));
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
          `Unknown subcommand: ${subcommand}. Valid: create, merge, discard, restore, purge, list, verify, info`
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
function errorWithSlug(slug: string, msg: EmitErrorMessage): never {
  error(typeof msg === "string" ? `[slug=${slug}] ${msg}` : {
    message: `[slug=${slug}] ${msg.message}`,
    auditMessage: `[slug=${slug}] ${msg.auditMessage}`,
  });
}

function error(msg: EmitErrorMessage): never {
  const pd = resolveProjectDir(projectDir);
  const command = `aidlc-worktree ${process.argv.slice(2).join(" ")}`.trim();
  emitError(pd, "aidlc-worktree", command, msg);
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
