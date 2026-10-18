// aidlc-unit.ts - atomic Unit claim registry and checkout-local scope binding.

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { appendAuditEntry, appendAuditEntryUnlocked, startClaimLocalRecord, takeHandedOverAuditRows } from "./aidlc-audit.ts";
import { scopeStampLanded, unitRowMerged } from "./aidlc-unit-landing.ts";
import { gitUserName, personGitNameField } from "./aidlc-git-name.ts";
import {
  managedBlockMarkers,
  markedPart,
  mergeBlock,
  mergeJsonEntries,
  onlyMarkedPartChanged,
  rootIntegrationTarget,
} from "./aidlc-distribution.ts";
import { aidlcRootParts } from "./aidlc-includes.ts";
import { KEPT_RULE_SCOPES, keptRuleFile } from "./aidlc-graph.ts";
import {
  activeIntentUuid,
  activeSpace,
  artifactFilename,
  assertNoSymlinkInChainOrThrow,
  auditBlockField,
  auditShardBlocks,
  auditShardName,
  type AuditShardEvent,
  type CachedUnitClaim,
  candidateReviewCoverageProjection,
  clearClaimGeneration,
  clearEngineAskMark,
  clearUnitScopeStamp,
  committedTextBytes,
  ENGINE_DIR,
  ensureCloneId,
  errorMessage,
  extractMarkdownSection,
  filterProducesByKind,
  getField,
  loadStageGraph,
  humanPresenceGuardDisabled,
  idSuffix,
  invalidateLiveClaimPayloadCache,
  isNonAnswer,
  isReadOnlyEngineProbe,
  isTeamUnitOwnership,
  isoTimestamp,
  loadStageGraphAll,
  engineAskMark,
  noteEngineAskMark,
  parseArgs,
  recordDir,
  parseBoltDag,
  readAppendOnlyFileNoFollowOrThrow,
  readAuditShardEvents,
  readUnitClaimRegistryCache,
  readApplicableTeamUnitScopeStamp,
  readUnitMergeTransaction,
  recordFileTargetOrThrow,
  REQUEST_TEXT_DIR,
  readStateFile,
  readUnitSourceManifest,
  recordDir,
  readUnitGateRhythm,
  readUnitScopeStamp,
  readAnswerTextFile,
  parseReviewRecordBytes,
  pairedReviewRecordForCompletion,
  personsGateReply,
  relativeRecordDir,
  REVIEW_RECORDS_DIR,
  reviewRecordDigest,
  reviewRecordRefFromBlock,
  type ReviewRecord,
  requireLiveClaimForTeamUnit,
  resolveInvokingSessionId,
  resolveProjectDir,
  resolveReviewClass,
  teamSkeletonOn,
  type UnitMergeEvidence,
  type UnitMergeTransaction,
  UNIT_MERGE_DIR,
  type UnitScopeStamp,
  unitGateStatus,
  unitLifecycleSnapshot,
  unitDependencyPath,
  unitMergedReceipts,
  unitMergeTransactions,
  unitMajorConstructionStageSlugs,
  unitParticipantPath,
  unitReleasePendingPath,
  validateUnitName,
  windowMessageIds,
  withAuditLock,
  writeUnitClaimRegistryCache,
  writeUnitMergeTransaction,
  writeStateFile,
  writeUnitScopeStamp,
  writeClaimGeneration,
  intentsDir,
  loadScopeMapping,
  parseCheckboxes,
  readActiveIntentCursor,
  readIntentRegistry,
  slugify,
  DEFAULT_SPACE,
  isGitRepoDir,
  repoDir,
  selectIntentForSession,
  setActiveSpaceCursor,
} from "./aidlc-lib.js";
import {
  blobsAt,
  findUnitBuild,
  HOME_LOCATION_FIELD,
  homeLocation,
  patchIdOf,
  RESULT_FILES_ROOT,
  type RepoResult,
  sameGitAddress,
  UNIT_BUILD_FIELD,
  UNIT_PUSH_FIELD,
  type UnitBuild,
  unitBuildOf,
  unitLikelyRepos,
  unitMergeVerdict,
  unitOutputsHomeReads,
  type UnitResult,
  unitsInPlanOrder,
  workspaceHomeLocation,
  writesByRepo,
} from "./aidlc-unit-teams.js";
import { repoNotThereLine } from "./aidlc-workspace-manifest.js";
import {
  parseTestingContract,
  recordedApprovalFingerprint,
  resolveTestingPosture,
} from "./aidlc-testing-posture.ts";
import { beforePerUnitBlock } from "./aidlc-graph.ts";
import { approvalDecidesOpenFindings, approvalOpenFindings } from "./aidlc-review-brief.ts";
import {
  aidlcEngineCommand,
  aidlcInvocation,
  aidlcToolInvocation,
  isCompiledExecutable,
  quoteCommandArgument,
} from "./aidlc-runtime-paths.ts";
import { readRequestFile } from "./aidlc-log.ts";

const CLAIM_FILE = ".aidlc-unit-claim.json";
const ZERO_OID = "0000000000000000000000000000000000000000";

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface GitBytesResult {
  ok: boolean;
  stdout: Buffer;
  stderr: string;
  code: number;
}

// Bun's spawnSync stops a pipe read at 1 MiB and hands back what it had, and a
// Unit's audit shard outgrows that in one long attempt, so the cap is lifted
// the way the other git readers lift it. A run that could not start, was killed
// or overflowed is a failed run, whatever its exit status.
function gitBytes(projectDir: string, args: string[], env?: NodeJS.ProcessEnv): GitBytesResult {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    env: { ...process.env, ...env },
    maxBuffer: 512 * 1024 * 1024,
  });
  const failure = result.error
    ? `${result.error.message}\n`
    : result.signal
      ? `git stopped by ${result.signal}\n`
      : "";
  return {
    ok: result.status === 0 && !result.error && !result.signal,
    stdout: result.stdout ?? Buffer.alloc(0),
    stderr: failure + (result.stderr?.toString("utf-8") ?? ""),
    code: result.status ?? 1,
  };
}

function git(projectDir: string, args: string[], env?: NodeJS.ProcessEnv): GitResult {
  const result = gitBytes(projectDir, args, env);
  return { ...result, stdout: result.stdout.toString("utf-8") };
}

function localGit(
  projectDir: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): GitResult {
  return git(projectDir, args, {
    GIT_NO_LAZY_FETCH: "1",
    ...env,
  });
}

function fail(message: string): never {
  throw new Error(message);
}

export interface UnitClaimPayload {
  version: 1;
  status: "claimed" | "released";
  owner: string;
  space: string;
  intent_uuid: string;
  intent_id8: string;
  unit: string;
  generation: number;
  nonce: string;
  base_oid: string;
  integration_ref: string;
  claim_ref: string;
  predecessor_oid: string | null;
  gate_rhythm: "per-stage" | "unit-end";
  audit_shard?: string;
  candidate_tree_oid?: string;
  candidate_head_oid?: string;
  // Held for this team by the lead at the home, before anyone took it.
  assigned?: true;
  // Who took it: their git user.name.
  taken_by?: string;
  // What the team pushed, what the home found merged, and done: a Unit whose
  // every repo merged, recorded at the home.
  result?: UnitResult;
  verdicts?: Array<{ repo: string; merged: boolean; commit?: string; how?: string }>;
  done?: true;
  turned_down?: { repo: string; words: string; at: string };
}

export interface UnitClaimView {
  unit: string;
  status: "claimed" | "released";
  owner: string;
  generation: number;
  nonce: string;
  oid: string;
  ref: string;
  observedAt?: string;
  movementObserved?: boolean;
  // Set by buildOverview when the Unit's row is merged: its claim, kept after
  // landing, is not one being worked.
  landed?: boolean;
  payload: UnitClaimPayload;
}

export interface UnitClaimOverview {
  claimable: string[];
  /** `blockedBy`, when present: Units a revised plan made this claimed Unit depend on that have not landed. */
  claimed: Array<{ unit: string; owner: string; generation: number; blockedBy?: string[] }>;
  waiting: Array<{ unit: string; blockedBy: string[] }>;
  claims: Map<string, UnitClaimView>;
  warning?: string;
}

function repositoryRemote(projectDir: string): string | null {
  const result = git(projectDir, ["remote"]);
  if (!result.ok) return null;
  const remotes = result.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  if (remotes.length === 0) return null;
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0];
  fail(`Multiple git remotes are configured (${remotes.join(", ")}); configure origin for Unit claims.`);
}

function currentBranch(projectDir: string): string {
  const result = git(projectDir, ["branch", "--show-current"]);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : "main";
}

// A Way of Working line names the team's branch only when it says so: "the
// integration branch", "the base branch", "the merge-target branch" or "the
// merge target", with the name in backticks in the same sentence. A line such
// as "Integration tests live in `tests/integration`" names no branch.
const INTEGRATION_BRANCH_WORDS =
  "(?:(?:base|integration|merge[ -]target) branch|merge target)";
const INTEGRATION_BRANCH_AFTER_WORDS = new RegExp(
  `\\b${INTEGRATION_BRANCH_WORDS}\\b[^\`\\n.;]*\`([^\`]+)\``,
  "i",
);
const INTEGRATION_BRANCH_BEFORE_WORDS = new RegExp(
  `\`([^\`]+)\`[^.;\\n]*\\b${INTEGRATION_BRANCH_WORDS}\\b`,
  "i",
);

// The branch the team wrote down under "## Way of Working", narrowest layer
// first. Whatever it is called, that branch is used; a name git cannot use as a
// branch is refused with its file, never skipped for a broader layer's choice.
function affirmedIntegrationBranch(
  projectDir: string,
  space = activeSpace(projectDir),
): { branch: string; source: string } | null {
  for (const name of ["project.md", "team.md", "org.md"]) {
    const source = `aidlc/spaces/${space}/memory/${name}`;
    let body: string;
    try {
      body = readFileSync(join(projectDir, ...source.split("/")), "utf-8");
    } catch {
      continue;
    }
    const section = extractMarkdownSection(body, "## Way of Working");
    const explicit =
      INTEGRATION_BRANCH_AFTER_WORDS.exec(section) ??
      INTEGRATION_BRANCH_BEFORE_WORDS.exec(section);
    if (!explicit) continue;
    const branch = explicit[1].trim();
    if (!git(projectDir, ["check-ref-format", "--branch", branch]).ok) {
      fail(
        `The integration branch "${branch}", named in ${source} under "Way of Working", ` +
          "is not a valid git branch name. Correct it there and run the command again.",
      );
    }
    return { branch, source };
  }
  return null;
}

function integrationBranch(projectDir: string, remote: string | null): string {
  if (remote) {
    const cached = git(projectDir, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
    if (cached.ok && cached.stdout.trim().startsWith(`${remote}/`)) {
      return cached.stdout.trim().slice(remote.length + 1);
    }
    const advertised = git(projectDir, ["ls-remote", "--symref", remote, "HEAD"]);
    const match = advertised.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match) return match[1];
  }
  const current = currentBranch(projectDir);
  const configured = git(projectDir, ["config", `branch.${current}.merge`]);
  if (configured.ok && configured.stdout.trim().startsWith("refs/heads/")) {
    return configured.stdout.trim().slice("refs/heads/".length);
  }
  for (const candidate of ["main", "master", current]) {
    if (
      candidate &&
      git(projectDir, ["rev-parse", "--verify", `refs/heads/${candidate}`]).ok
    ) {
      return candidate;
    }
  }
  return current || "main";
}

function fetchIntegration(projectDir: string): {
  remote: string | null;
  branch: string;
  ref: string;
  oid: string;
} {
  const remote = repositoryRemote(projectDir);
  const affirmed = affirmedIntegrationBranch(projectDir);
  const branch = affirmed?.branch ?? integrationBranch(projectDir, remote);
  const named = affirmed
    ? `The integration branch "${affirmed.branch}", named in ${affirmed.source} under "Way of Working",`
    : null;
  if (remote) {
    const fetched = git(projectDir, ["fetch", remote, branch]);
    if (!fetched.ok) {
      fail(
        named
          ? `${named} could not be fetched from ${remote}: ${fetched.stderr.trim().replace(/^fatal:\s*/i, "")}`
          : `git fetch ${remote} ${branch} failed: ${fetched.stderr.trim()}`,
      );
    }
  }
  const ref = remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`;
  const oid = git(projectDir, ["rev-parse", "--verify", ref]);
  if (!oid.ok) {
    fail(named ? `${named} does not exist in this repository.` : `Integration ref ${ref} does not exist.`);
  }
  return { remote, branch, ref, oid: oid.stdout.trim() };
}

function claimRef(intentId8: string, unit: string): string {
  return `refs/heads/claim/${intentId8}/${unit}`;
}

function fetchClaimRefs(projectDir: string, remote: string | null): void {
  if (!remote) return;
  const fetched = git(projectDir, [
    "fetch",
    "--no-filter",
    remote,
    "+refs/heads/claim/*:refs/remotes/" + remote + "/claim/*",
  ]);
  if (!fetched.ok) {
    fail(`Unit claim registry fetch failed: ${fetched.stderr.trim()}`);
  }
}

function refTip(
  projectDir: string,
  remote: string | null,
  ref: string,
): string | null {
  if (remote) {
    const found = git(projectDir, ["ls-remote", remote, ref]);
    if (!found.ok) {
      fail(`Unit claim registry read failed: ${found.stderr.trim() || found.stdout.trim()}`);
    }
    const line = found.stdout.trim().split(/\r?\n/).find(Boolean);
    return line ? line.split(/\s+/)[0] : null;
  }
  const found = git(projectDir, ["rev-parse", "--verify", ref]);
  return found.ok ? found.stdout.trim() : null;
}

function readPayload(
  projectDir: string,
  oid: string,
  options: { localOnly?: boolean } = {},
): UnitClaimPayload | null {
  const shown = options.localOnly
    ? localGit(projectDir, ["show", `${oid}:${CLAIM_FILE}`, "--"])
    : git(projectDir, ["show", `${oid}:${CLAIM_FILE}`, "--"]);
  if (!shown.ok) return null;
  try {
    const parsed = JSON.parse(shown.stdout) as UnitClaimPayload;
    if (
      parsed.version !== 1 ||
      (parsed.status !== "claimed" && parsed.status !== "released") ||
      typeof parsed.unit !== "string" ||
      !Number.isInteger(parsed.generation) ||
      typeof parsed.nonce !== "string" ||
      !/^[0-9a-f]{40}$/.test(parsed.base_oid) ||
      typeof parsed.integration_ref !== "string" ||
      typeof parsed.claim_ref !== "string" ||
      (parsed.audit_shard !== undefined &&
        (typeof parsed.audit_shard !== "string" ||
          !/^[A-Za-z0-9._-]+\.md$/.test(parsed.audit_shard))) ||
      (
        parsed.candidate_tree_oid !== undefined &&
        !/^[0-9a-f]{40}$/.test(parsed.candidate_tree_oid)
      ) ||
      (
        parsed.candidate_head_oid !== undefined &&
        !/^[0-9a-f]{40}$/.test(parsed.candidate_head_oid)
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function ensureObject(
  projectDir: string,
  remote: string | null,
  oid: string,
  ref: string,
): void {
  const hasCommit = (): boolean =>
    localGit(projectDir, ["cat-file", "-e", `${oid}^{commit}`]).ok;
  const payloadBlob = (): string | null => {
    const found = localGit(projectDir, ["rev-parse", `${oid}:${CLAIM_FILE}`]);
    return found.ok && /^[0-9a-f]{40}$/.test(found.stdout.trim())
      ? found.stdout.trim()
      : null;
  };
  const hasBlob = (blob: string | null): boolean =>
    blob !== null && localGit(projectDir, ["cat-file", "-e", blob]).ok;
  let blob = payloadBlob();
  if (hasCommit() && hasBlob(blob)) return;
  if (!remote) {
    fail(
      `Unit claim registry payload is unavailable at ${ref}; the local repository may be a partial clone with the claim payload blob missing.`,
    );
  }
  const fetched = git(projectDir, [
    "fetch",
    "--no-tags",
    "--no-filter",
    remote,
    ref,
  ]);
  if (!fetched.ok) {
    fail(
      `Unit claim registry fetch failed: ${fetched.stderr.trim()} ` +
        `(a partial clone requires a non-filtered fetch of ${ref}).`,
    );
  }
  blob = payloadBlob();
  if (blob && !hasBlob(blob)) {
    const hydrated = git(projectDir, [
      "fetch",
      "--no-tags",
      "--no-filter",
      remote,
      blob,
    ]);
    if (!hydrated.ok) {
      fail(
        `Unit claim registry fetch failed: ${hydrated.stderr.trim()} ` +
          `(the partial clone is missing payload blob ${blob} for ${ref}).`,
      );
    }
  }
  if (!hasCommit() || !hasBlob(blob)) {
    fail(
      `Unit claim registry fetch failed: payload at ${ref} is unavailable after a non-filtered fetch; ` +
        "the partial clone is missing the claim payload blob.",
    );
  }
}

function currentClaim(
  projectDir: string,
  remote: string | null,
  ref: string,
): UnitClaimView | null {
  const oid = refTip(projectDir, remote, ref);
  if (!oid) return null;
  ensureObject(projectDir, remote, oid, ref);
  const payload = readPayload(projectDir, oid, { localOnly: true });
  if (!payload) fail(`Unit claim registry payload is invalid at ${ref}.`);
  return {
    unit: payload.unit,
    status: payload.status,
    owner: payload.owner,
    generation: payload.generation,
    nonce: payload.nonce,
    oid,
    ref,
    payload,
  };
}

// git's own words when it has no author or committer identity to use.
const NO_GIT_IDENTITY =
  /identity unknown|Please tell me who you are|auto-detect email|no (?:email|name) was given/i;

// Builds a tree equal to `baseTreeOid` but with `path` replaced (or added) by
// `content`, via a scratch index so the real worktree/index is untouched.
function writeTreeWithBlob(
  projectDir: string,
  baseTreeOid: string,
  path: string,
  content: string,
): string {
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-unit-tree-"));
  const index = join(scratch, "index");
  try {
    const env = { GIT_INDEX_FILE: index };
    const read = git(projectDir, ["read-tree", baseTreeOid], env);
    if (!read.ok) fail(`git read-tree failed: ${read.stderr.trim()}`);
    const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: projectDir,
      encoding: "utf-8",
      input: content,
    });
    if (blob.status !== 0) fail(`git hash-object failed: ${(blob.stderr ?? "").trim()}`);
    const update = git(
      projectDir,
      ["update-index", "--add", "--cacheinfo", `100644,${(blob.stdout ?? "").trim()},${path}`],
      env,
    );
    if (!update.ok) fail(`git update-index failed: ${update.stderr.trim()}`);
    const tree = git(projectDir, ["write-tree"], env);
    if (!tree.ok) fail(`git write-tree failed: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function createClaimCommit(
  projectDir: string,
  parentOid: string,
  payload: UnitClaimPayload,
  sourceTreeOid?: string,
  additionalParentOid?: string,
  // More files for the commit's tree, by path: a Unit result's outputs.
  files: Record<string, string> = {},
): string {
  let tree = writeTreeWithBlob(
    projectDir,
    sourceTreeOid ?? parentOid,
    CLAIM_FILE,
    `${JSON.stringify(payload, null, 2)}\n`,
  );
  // More files for the tree, each written over the last (a Unit result's outputs).
  for (const [path, text] of Object.entries(files)) tree = writeTreeWithBlob(projectDir, tree, path, text);
  return commitAsPerson(
    projectDir,
    tree,
    [parentOid, ...(additionalParentOid ? [additionalParentOid] : [])],
    `aidlc unit ${payload.status}: ${payload.unit} generation ${payload.generation}`,
  );
}

// A claim commit, and the handover commit publish puts under it, are the
// person's own commits: their git name, email and signing settings apply as
// they do to any commit they make, so a remote that matches the committer to
// the pusher accepts them, and the claim history shows who claimed.
function commitAsPerson(
  projectDir: string,
  tree: string,
  parents: string[],
  message: string,
): string {
  // commit-tree does not read commit.gpgsign on its own; porcelain commits do.
  const signed =
    git(projectDir, ["config", "--type=bool", "commit.gpgsign"]).stdout.trim() === "true";
  const commitArgs = [
    "commit-tree",
    tree,
    ...parents.flatMap((parent) => ["-p", parent]),
    ...(signed ? ["-S"] : []),
    "-m",
    message,
  ];
  const commit = git(projectDir, commitArgs);
  if (!commit.ok) {
    if (NO_GIT_IDENTITY.test(commit.stderr)) {
      fail(
        "Git has no name and email for your commits yet. Set them with " +
          'git config --global user.name "Your Name" and git config --global user.email "you@example.com", ' +
          "then run the command again.",
      );
    }
    fail(`git commit-tree failed: ${commit.stderr.trim()}`);
  }
  return commit.stdout.trim();
}

// What the remote said when it refused a push: its own `remote:` lines, then
// git's reason in parentheses; the whole stderr when it printed neither.
function pushRefusal(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const remoteSaid = lines
    .filter((line) => line.startsWith("remote:"))
    .map((line) => line.slice("remote:".length).trim())
    .filter(Boolean);
  const reason = lines
    .map((line) => /\[(?:remote )?rejected\][^(]*\(([^)]+)\)/.exec(line)?.[1])
    .find(Boolean);
  const parts = [...remoteSaid, ...(reason ? [`(${reason})`] : [])];
  return (parts.length > 0 ? parts : lines).join(" ");
}

// The compare-and-swap: ok when the ref moved from expectedOid to commitOid.
// A stale lease, or a ref the remote could not lock because another push got
// there first, is another claimant winning; any other push failure is the
// remote refusing the commit, and `refused` carries its reason for the person.
const CLAIM_RACE_LOST = /stale info|failed to update ref|cannot lock ref/;
function updateClaimRef(
  projectDir: string,
  remote: string | null,
  ref: string,
  commitOid: string,
  expectedOid: string | null,
): { ok: boolean; refused?: string } {
  if (remote) {
    const lease = `--force-with-lease=${ref}:${expectedOid ?? ""}`;
    const pushed = git(projectDir, ["push", remote, lease, `${commitOid}:${ref}`]);
    if (pushed.ok) return { ok: true };
    if (CLAIM_RACE_LOST.test(pushed.stderr)) return { ok: false };
    return { ok: false, refused: pushRefusal(pushed.stderr) };
  }
  const updated = git(projectDir, [
    "update-ref",
    ref,
    commitOid,
    expectedOid ?? ZERO_OID,
  ]);
  return { ok: updated.ok };
}

function activeIdentity(projectDir: string): {
  space: string;
  intentUuid: string;
  intentId8: string;
} {
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space);
  if (!intentUuid) fail("No active intent UUID; switch to the workflow before claiming a Unit.");
  return { space, intentUuid, intentId8: idSuffix(intentUuid) };
}

function stateAtOid(projectDir: string, oid: string): string {
  const relative = relativeRecordDir(projectDir);
  if (!relative) fail("Cannot resolve the active intent record path.");
  const shown = git(projectDir, ["show", `${oid}:${relative}/aidlc-state.md`, "--"]);
  if (!shown.ok) fail("The fetched integration ref does not contain the active intent state.");
  return shown.stdout;
}

function dependencyBodyAtOid(projectDir: string, oid: string): string {
  const relative = relativeRecordDir(projectDir);
  if (!relative) fail("Cannot resolve the active intent record path.");
  const shown = git(
    projectDir,
    ["show", `${oid}:${relative}/inception/units-generation/unit-of-work-dependency.md`, "--"],
  );
  if (!shown.ok) fail("The fetched integration ref has no Unit dependency artifact.");
  return shown.stdout;
}

// The Unit Progress table's header and its Unit rows, each as its cells.
function unitProgressTable(state: string): { header: string[]; rows: string[][] } | null {
  const match = /^## Unit Progress\s*$/m.exec(state);
  if (!match) return null;
  const after = match.index + match[0].length;
  const next = /^## /m.exec(state.slice(after));
  const section = state.slice(after, next ? after + next.index : state.length);
  const table = section
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = table.find((cells) => cells[0]?.toLowerCase() === "unit");
  if (!header) return null;
  const rows = table.filter((cells) =>
    cells.length === header.length && cells.length >= 4 &&
    !(cells[0].toLowerCase() === "unit" && cells[1].toLowerCase() === "owner") &&
    !cells.every((cell) => /^-+$/.test(cell))
  );
  return { header, rows };
}

function completedUnits(state: string): Set<string> {
  const table = unitProgressTable(state);
  if (!table) return new Set();
  const { header } = table;
  const mergedIndex = header.findIndex(
    (cell) => cell.toLowerCase() === "merged",
  );
  const done = new Set<string>();
  for (const cells of table.rows) {
    const workCells = cells.slice(
      2,
      mergedIndex >= 0 ? mergedIndex : undefined,
    );
    if (
      workCells.every((cell) => cell === "[x]") &&
      (mergedIndex < 0 || unitRowMerged(state, cells[0]))
    ) {
      done.add(cells[0]);
    }
  }
  return done;
}

type OpeningStatus = {
  units: string[];
  blockers: Map<string, string[]>;
  completed: Set<string>;
  // Completed and merged into main. A row is complete in a team's own clone
  // once its stages are approved, before the Unit is landed.
  landed: Set<string>;
  skeleton: string;
};

function openingStatus(projectDir: string, baseOid: string): OpeningStatus {
  return openingStatusFrom(
    stateAtOid(projectDir, baseOid),
    dependencyBodyAtOid(projectDir, baseOid),
  );
}

function localOpeningStatus(projectDir: string): OpeningStatus {
  const state = readStateFile(projectDir);
  const dependencyBody = readFileSync(unitDependencyPath(projectDir), "utf-8");
  return openingStatusFrom(state, dependencyBody);
}

// Claims can open from what this checkout holds: no walking skeleton is still
// to be built on main first (openingStatusFrom, the claim's own rule). False
// when the plan cannot be read.
export function claimsOpenHere(projectDir: string): boolean {
  try {
    const opening = localOpeningStatus(resolveProjectDir(projectDir));
    return ![...opening.blockers.values()].some((blockers) => blockers.includes("walking-skeleton"));
  } catch {
    return false;
  }
}

// The one opening rule for the claim, status, release, the picker and the
// board. The walking skeleton is the first DAG Unit, built on main; while it is
// on, every Unit waits until its Unit Progress row is complete, the same
// evidence a dependency is read from.
export function openingStatusFrom(state: string, dependencyBody: string): OpeningStatus {
  if (!isTeamUnitOwnership(state)) fail("Unit claims require Unit Ownership: team.");
  const parsed = parseBoltDag(dependencyBody);
  if (!parsed.ok) fail(`Cannot resolve Unit dependencies: ${parsed.reason}: ${parsed.detail}`);
  const completed = completedUnits(state);
  const skeleton = parsed.batches[0][0];
  const skeletonBlocked = teamSkeletonOn(state) && !completed.has(skeleton);
  const blockers = new Map<string, string[]>();
  for (const edge of parsed.units) {
    const waiting = edge.depends_on.filter((dep) => !completed.has(dep));
    if (skeletonBlocked) waiting.unshift("walking-skeleton");
    blockers.set(edge.name, [...new Set(waiting)]);
  }
  const landed = new Set([...completed].filter((unit) => unitRowMerged(state, unit)));
  return { units: parsed.units.map((edge) => edge.name), blockers, completed, landed, skeleton };
}

function allClaims(
  projectDir: string,
  remote: string | null,
  intentId8: string,
  units: string[],
): Map<string, UnitClaimView> {
  fetchClaimRefs(projectDir, remote);
  const claims = new Map<string, UnitClaimView>();
  for (const unit of units) {
    const ref = claimRef(intentId8, unit);
    const claim = currentClaim(projectDir, remote, ref);
    if (claim) claims.set(unit, claim);
  }
  return claims;
}

function buildOverview(
  opening: ReturnType<typeof openingStatus>,
  claims: Map<string, UnitClaimView>,
  warning?: string,
): UnitClaimOverview {
  const claimable: string[] = [];
  const claimed: UnitClaimOverview["claimed"] = [];
  const waiting: Array<{ unit: string; blockedBy: string[] }> = [];
  for (const unit of opening.units) {
    const claim = claims.get(unit);
    if (opening.completed.has(unit)) {
      if (claim?.status === "claimed" && opening.landed.has(unit)) claim.landed = true;
      continue;
    }
    if (claim?.status === "claimed") {
      // A claimed Unit lands after the Units it depends on; a revised plan can
      // add one that has not landed (the walking skeleton is not one).
      const blockedBy = (opening.blockers.get(unit) ?? []).filter((dep) => dep !== "walking-skeleton");
      claimed.push({
        unit,
        owner: claim.owner,
        generation: claim.generation,
        ...(blockedBy.length > 0 ? { blockedBy } : {}),
      });
      continue;
    }
    const blockedBy = opening.blockers.get(unit) ?? [];
    if (blockedBy.length > 0) waiting.push({ unit, blockedBy });
    else claimable.push(unit);
  }
  return { claimable, claimed, waiting, claims, ...(warning ? { warning } : {}) };
}

function cacheClaims(
  projectDir: string,
  claims: Map<string, UnitClaimView>,
  warning?: string,
): Map<string, UnitClaimView> {
  const identity = activeIdentity(projectDir);
  const priorCache = readUnitClaimRegistryCache(projectDir);
  const cached: Record<string, CachedUnitClaim> = {};
  for (const [unit, claim] of claims) {
    const prior =
      priorCache?.space === identity.space &&
        priorCache.intent_uuid === identity.intentUuid
        ? priorCache.claims[unit]
        : undefined;
    const movementObserved =
      prior !== undefined && prior.oid !== claim.oid;
    const observedAt = prior?.observed_at ?? isoTimestamp();
    const nextObservedAt = movementObserved ? isoTimestamp() : observedAt;
    claim.observedAt = observedAt;
    claim.movementObserved = movementObserved;
    cached[unit] = {
      status: claim.status,
      owner: claim.owner,
      generation: claim.generation,
      nonce: claim.nonce,
      ref: claim.ref,
      oid: claim.oid,
      observed_at: nextObservedAt,
    };
    if (claim.status === "claimed") {
      writeClaimGeneration(projectDir, unit, claim.generation);
    } else {
      clearClaimGeneration(projectDir, unit);
    }
  }
  writeUnitClaimRegistryCache(projectDir, {
    version: 1,
    space: identity.space,
    intent_uuid: identity.intentUuid,
    claims: cached,
    ...(warning ? { warning } : {}),
  });
  return claims;
}

interface UnitClaimIdentity {
  space: string;
  intentUuid: string;
  intentId8: string;
}

function cachedClaimsForIdentity(
  projectDir: string,
  identity: UnitClaimIdentity,
  includeCache: boolean,
): Map<string, UnitClaimView> {
  const cache = readUnitClaimRegistryCache(projectDir);
  const claims = new Map<string, UnitClaimView>();
  if (
    includeCache &&
    cache &&
    cache.space === identity.space &&
    cache.intent_uuid === identity.intentUuid
  ) {
    for (const [unit, claim] of Object.entries(cache.claims)) {
      claims.set(unit, {
        unit,
        status: claim.status,
        owner: claim.owner,
        generation: claim.generation,
        nonce: claim.nonce,
        oid: claim.oid,
        ref: claim.ref,
        observedAt: claim.observed_at,
        movementObserved: false,
        payload: {
          version: 1,
          status: claim.status,
          owner: claim.owner,
          space: identity.space,
          intent_uuid: identity.intentUuid,
          intent_id8: identity.intentId8,
          unit,
          generation: claim.generation,
          nonce: claim.nonce,
          base_oid: "",
          integration_ref: "",
          claim_ref: claim.ref,
          predecessor_oid: null,
          gate_rhythm: "per-stage",
        },
      });
    }
  }
  const refs = localGit(projectDir, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads/claim/",
    "refs/remotes/",
    // Another workspace's copy of a home's claims (aidlc-unit take).
    `refs/aidlc/home/${identity.intentId8}/`,
  ]);
  if (!refs.ok) return claims;
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [oid, ref] = line.trim().split(/\s+/, 2);
    if (!oid || !ref) continue;
    if (
      !ref.startsWith(`refs/heads/claim/${identity.intentId8}/`) &&
      !ref.startsWith(`refs/aidlc/home/${identity.intentId8}/claim/`) &&
      !new RegExp(
        `^refs/remotes/[^/]+/claim/${identity.intentId8.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
      ).test(ref)
    ) {
      continue;
    }
    const payload = readPayload(projectDir, oid, { localOnly: true });
    if (!payload || payload.intent_uuid !== identity.intentUuid) {
      throw new Error(
        `Local Unit claim registry payload is unavailable or invalid at ${ref}; ` +
          "fetch that claim ref without a partial-clone filter before retrying.",
      );
    }
    const prior = claims.get(payload.unit);
    // The cache keeps a claim's summary only; the ref at the same commit hands
    // over its whole payload (a published candidate's commit among it).
    if (prior && prior.oid === oid) {
      prior.payload = payload;
      continue;
    }
    if (
      prior &&
      (prior.generation > payload.generation ||
        (prior.generation === payload.generation &&
          (
            prior.oid === oid ||
            (prior.status === "claimed" && payload.status === "released")
          )))
    ) {
      continue;
    }
    claims.set(payload.unit, {
      unit: payload.unit,
      status: payload.status,
      owner: payload.owner,
      generation: payload.generation,
      nonce: payload.nonce,
      oid,
      ref: payload.claim_ref,
      observedAt:
        cache?.space === identity.space &&
          cache.intent_uuid === identity.intentUuid
          ? cache.claims[payload.unit]?.observed_at
          : undefined,
      movementObserved:
        cache?.space === identity.space &&
          cache.intent_uuid === identity.intentUuid &&
          cache.claims[payload.unit] !== undefined &&
          cache.claims[payload.unit]?.oid !== oid,
      payload,
    });
  }
  return claims;
}

function cachedClaims(projectDir: string): Map<string, UnitClaimView> {
  return cachedClaimsForIdentity(projectDir, activeIdentity(projectDir), true);
}

export function cachedUnitClaimOverview(
  projectDir: string,
  options: { writeCache?: boolean } = {},
): UnitClaimOverview {
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) {
    return { claimable: [], claimed: [], waiting: [], claims: new Map() };
  }
  const opening = localOpeningStatus(pd);
  const cache = readUnitClaimRegistryCache(pd);
  let claims = cachedClaims(pd);
  if (options.writeCache !== false && !isReadOnlyEngineProbe()) {
    claims = cacheClaims(pd, claims, cache?.warning);
  }
  return buildOverview(opening, claims, cache?.warning);
}

export function localUnitClaimOverviewForIntent(
  projectDir: string,
  selector: {
    space: string;
    intentUuid: string;
    stateContent: string;
    dependencyBody: string;
  },
): UnitClaimOverview {
  const pd = resolveProjectDir(projectDir);
  if (!isTeamUnitOwnership(selector.stateContent)) {
    return { claimable: [], claimed: [], waiting: [], claims: new Map() };
  }
  const opening = openingStatusFrom(
    selector.stateContent,
    selector.dependencyBody,
  );
  const claims = cachedClaimsForIdentity(
    pd,
    {
      space: selector.space,
      intentUuid: selector.intentUuid,
      intentId8: idSuffix(selector.intentUuid),
    },
    true,
  );
  return buildOverview(opening, claims);
}

export function unitClaimOverview(projectDir: string): UnitClaimOverview {
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) {
    return { claimable: [], claimed: [], waiting: [], claims: new Map() };
  }
  const identity = activeIdentity(pd);
  const integration = fetchIntegration(pd);
  const opening = openingStatus(pd, integration.oid);
  const claims = allClaims(pd, integration.remote, identity.intentId8, opening.units);
  const observedClaims = cacheClaims(pd, claims);
  return buildOverview(opening, observedClaims);
}

function updateCachedClaim(
  projectDir: string,
  claim: UnitClaimView,
): void {
  const claims = cachedClaims(projectDir);
  claims.set(claim.unit, claim);
  cacheClaims(projectDir, claims);
}

function gitOutput(projectDir: string, args: string[], label: string): string {
  const result = git(projectDir, args);
  if (!result.ok) {
    fail(`${label}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.trim();
}

function gitPathExistsAt(
  projectDir: string,
  oid: string,
  path: string,
): boolean {
  return git(projectDir, ["cat-file", "-e", `${oid}:${path}`]).ok;
}

export function gitTextAt(
  projectDir: string,
  oid: string,
  path: string,
): string {
  // `cat-file` takes oid:path as an object name only, never a worktree path,
  // so Git does not stat it (which could exceed Windows' path limit). The
  // blob's recorded size is checked against the bytes read: a short read
  // never stands in for the file.
  const object = `${oid}:${path}`;
  const size = git(projectDir, ["cat-file", "-s", object]);
  if (!size.ok) fail(`Pinned candidate is missing ${path}.`);
  const expected = Number(size.stdout.trim());
  const shown = gitBytes(projectDir, ["cat-file", "blob", object]);
  if (!shown.ok || shown.stdout.length !== expected) {
    fail(
      `Could not read all of ${path} from the pinned candidate: ` +
        `${shown.stdout.length} of ${expected} bytes${shown.ok ? "" : ` (${shown.stderr.trim()})`}.`,
    );
  }
  return shown.stdout.toString("utf-8");
}

type CandidateAuditEvent = AuditShardEvent;

function candidateAuditEvents(
  projectDir: string,
  oid: string,
  shards: string[],
): CandidateAuditEvent[] {
  const events = shards.flatMap((path, shardIndex) =>
    auditShardBlocks(gitTextAt(projectDir, oid, path))
      .filter((block) => block.trim().length > 0)
      .map((block, pos): CandidateAuditEvent | null => {
        const event = auditBlockField(block, "Event");
        if (!event) return null;
        return {
          event,
          block,
          timestamp: auditBlockField(block, "Timestamp") ?? "",
          shard: path,
          shardIndex,
          pos,
        };
      })
      .filter((event): event is CandidateAuditEvent => event !== null)
  );
  return events.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
}

function auditBlockMatchesStage(block: string, stage: string): boolean {
  const gateStages = auditBlockField(block, "Gate Stages");
  if (gateStages) {
    return gateStages
      .split(",")
      .map((value) => value.trim())
      .includes(stage);
  }
  return auditBlockField(block, "Stage") === stage;
}

function attemptEventMatches(
  event: CandidateAuditEvent,
  unit: string,
  generation: number,
  stage: string,
): boolean {
  return (
    auditBlockField(event.block, "Unit") === unit &&
    auditBlockField(event.block, "Attempt Generation") ===
      String(generation) &&
    auditBlockMatchesStage(event.block, stage)
  );
}

function candidateReviewFingerprint(
  projectDir: string,
  oid: string,
  recordPrefix: string,
  unit: string,
  stage: {
    slug: string;
    produces?: string[];
    optional_produces?: string[];
    produces_kinds?: Record<string, string[]>;
  },
  unitKind: string | null,
): string {
  const names = filterProducesByKind(
    stage.produces_kinds,
    [...(stage.produces ?? []), ...(stage.optional_produces ?? [])],
    unitKind,
  );
  const manifest: Array<[string, string]> = names.map((name) => {
    const logicalPath =
      `construction/${unit}/${stage.slug}/${artifactFilename(name)}`;
    const path = `${recordPrefix}/${logicalPath}`;
    if (!gitPathExistsAt(projectDir, oid, path)) {
      return [logicalPath, "missing"];
    }
    // CRLF text reads as LF, as the review's fingerprint read it.
    const digest = createHash("sha256")
      .update(committedTextBytes(Buffer.from(gitTextAt(projectDir, oid, path), "utf-8")))
      .digest("hex");
    return [logicalPath, `sha256:${digest}`];
  });
  manifest.sort(([a], [b]) => a.localeCompare(b));
  return `sha256:${
    createHash("sha256").update(JSON.stringify(manifest)).digest("hex")
  }`;
}

function candidateReviewCoverage(
  events: CandidateAuditEvent[],
  projectDir: string,
  oid: string,
  recordPrefix: string,
  unit: string,
  generation: number,
  stage: {
    slug: string;
    reviewer?: string;
    produces?: string[];
    optional_produces?: string[];
    produces_kinds?: Record<string, string[]>;
  },
  unitKind: string | null,
): { coverage: "ready" | "approved"; findings: ReturnType<typeof approvalOpenFindings> } | null {
  const expectedFingerprint = candidateReviewFingerprint(
    projectDir,
    oid,
    recordPrefix,
    unit,
    stage,
    unitKind,
  );
  const completionRecord = (block: string): ReviewRecord | null =>
    pairedReviewRecordForCompletion(projectDir, block, (_projectDir, ref) => {
      const path = `${recordPrefix}/${ref.path}`;
      if (!gitPathExistsAt(projectDir, oid, path)) return null;
      const bytes = gitTextAt(projectDir, oid, path);
      if (reviewRecordDigest(bytes) !== ref.digest) return null;
      return parseReviewRecordBytes(bytes);
    });
  const artifactPrefix = `construction/${unit}/${stage.slug}/`;
  const covered = candidateReviewCoverageProjection(events, {
    unit,
    generation,
    stage: stage.slug,
    reviewer: stage.reviewer,
    artifactPrefix,
    expectedFingerprint,
    completionRecord,
    approvalAccepts: (block) => approvalDecidesOpenFindings(block, artifactPrefix),
  });
  return covered && {
    coverage: covered.coverage,
    findings: covered.approval ? approvalOpenFindings(covered.approval, artifactPrefix) : [],
  };
}

function namesInProse(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function validateCandidateUnitProgress(
  state: string,
  claim: UnitClaimView,
  stages: string[],
): void {
  const heading = /^## Unit Progress\s*$/m.exec(state);
  if (!heading) fail("Pinned candidate state has no Unit Progress projection.");
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(state.slice(after));
  const section = state.slice(after, next ? after + next.index : state.length);
  const rows = section
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = rows.find((cells) => cells[0]?.toLowerCase() === "unit");
  if (!header) fail("Pinned candidate Unit Progress projection has no header.");
  const row = rows.find((cells) => cells[0] === claim.unit);
  if (!row || row.length !== header.length) {
    fail(`Pinned candidate Unit Progress has no valid row for "${claim.unit}".`);
  }
  const ownerIndex = header.findIndex((cell) => cell.toLowerCase() === "owner");
  if (ownerIndex < 0 || row[ownerIndex] !== claim.owner) {
    fail(`Pinned candidate Unit Progress owner does not match "${claim.owner}".`);
  }
  for (const stage of stages) {
    const stageIndex = header.indexOf(stage);
    if (stageIndex < 0 || row[stageIndex] !== "[x]") {
      fail(`Pinned candidate Unit Progress stage "${stage}" is not complete.`);
    }
  }
  const gateIndex = header.findIndex((cell) => cell.toLowerCase() === "gate");
  if (gateIndex < 0 || row[gateIndex] !== "[x]") {
    fail("Pinned candidate Unit Progress gate is not approved.");
  }
}

function mainUnitRowMerged(
  projectDir: string,
  transaction: UnitMergeTransaction,
): boolean {
  const state = readStateFile(projectDir);
  const heading = /^## Unit Progress\s*$/m.exec(state);
  if (!heading) return false;
  const after = heading.index + heading[0].length;
  const next = /^## /m.exec(state.slice(after));
  const rows = state
    .slice(after, next ? after + next.index : state.length)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const header = rows.find((cells) => cells[0]?.toLowerCase() === "unit");
  const row = rows.find((cells) => cells[0] === transaction.unit);
  if (!header || !row || row.length !== header.length) return false;
  const expected = [
    "owner",
    ...(transaction.live_stage_columns ?? transaction.evidence.stages_expected),
    "gate",
    "merged",
  ];
  return expected.every((name) => {
    const index = header.findIndex((cell) => cell.toLowerCase() === name);
    if (index < 0) return false;
    return name === "owner"
      ? row[index] === transaction.owner
      : row[index] === "[x]";
  });
}

interface CandidateBoundary {
  changedAudit: string[];
  outsideUnitRecordPaths: string[];
  violations: string[];
}

const TRANSPORTED_ATTEMPT_EVENTS = new Set([
  "UNIT_STARTED",
  "UNIT_PAUSED",
  "UNIT_RESUMED",
  "UNIT_COMPLETED",
  "UNIT_SKIPPED",
  "STAGE_AWAITING_APPROVAL",
  "STAGE_REVISING",
  "GATE_APPROVED",
  "GATE_REJECTED",
  "PLAN_APPROVAL_RECORDED",
  "PLAN_APPROVAL_SKIPPED",
  "REVIEW_REQUESTED",
  "REVIEW_COMPLETED",
]);
const TRANSPORTED_DATA_EVENTS = new Set([
  "ARTIFACT_CREATED",
  "ARTIFACT_UPDATED",
]);

function isTransportedMainAuthority(event: CandidateAuditEvent): boolean {
  if (
    event.event === "HUMAN_TURN" ||
    event.event === "QUESTION_ANSWERED" ||
    event.event === "SUMMARY_CONFIRMATION_RECORDED" ||
    event.event === "AUTONOMY_MODE_SET" ||
    event.event === "UNIT_MERGED" ||
    event.event.startsWith("MERGE_DISPATCH_")
  ) {
    return true;
  }
  return (
    (event.event === "GATE_APPROVED" || event.event === "GATE_REJECTED") &&
    (
      auditBlockField(event.block, "Stage") === "unit-merge" ||
      auditBlockField(event.block, "Gate Scope") === "unit-merge"
    )
  );
}

function transportedAuditViolation(
  event: CandidateAuditEvent,
  unit: string,
  generation: number,
): string | null {
  if (isTransportedMainAuthority(event)) {
    return `${event.event} is main-authority evidence`;
  }
  if (TRANSPORTED_ATTEMPT_EVENTS.has(event.event)) {
    const eventUnit = auditBlockField(event.block, "Unit");
    const eventGeneration = auditBlockField(
      event.block,
      "Attempt Generation",
    );
    if (eventUnit !== unit) {
      return `${event.event} receipt belongs to Unit ${eventUnit ?? "(unitless)"}`;
    }
    if (eventGeneration !== String(generation)) {
      return (
        `${event.event} receipt belongs to attempt generation ` +
        `${eventGeneration ?? "(missing)"}, expected ${generation}`
      );
    }
    return null;
  }
  if (TRANSPORTED_DATA_EVENTS.has(event.event)) {
    const eventUnit = auditBlockField(event.block, "Unit");
    const eventGeneration = auditBlockField(
      event.block,
      "Attempt Generation",
    );
    if (eventUnit !== null && eventUnit !== unit) {
      return `${event.event} row belongs to Unit ${eventUnit}`;
    }
    if (
      eventGeneration !== null &&
      eventGeneration !== String(generation)
    ) {
      return `${event.event} row belongs to attempt generation ${eventGeneration}`;
    }
    const file = (auditBlockField(event.block, "File") ?? "")
      .replace(/\\/g, "/");
    const unitArtifactRoot = `construction/${unit}/`;
    if (
      !file.startsWith(unitArtifactRoot) &&
      !file.includes(`/${unitArtifactRoot}`)
    ) {
      return `${event.event} row is outside claimed Unit artifacts`;
    }
    return null;
  }
  return `${event.event} is not in the transported Unit evidence allowlist`;
}

// What a claimed checkout's audit writer asks of its claim (appendAuditBlockAtPath,
// aidlc-audit.ts): whether a block of the checkout's log also goes to the claim's
// tracked shard, the one publish ships and pin reads, which is exactly whether pin
// takes it (transportedAuditViolation, the one owner; a block with no event, a
// note or the header alone, stays in the local record), and whether the claim's
// base commit already holds a path, so a shard main has is never rewritten.
export function claimAuditRules(
  projectDir: string,
  claim: { unit: string; generation: number; claimed_from_oid: string },
): { takes(block: string): boolean; baseHolds(path: string): boolean } {
  return {
    takes: (block) => {
      const event = auditBlockField(block, "Event");
      return event !== null && transportedAuditViolation(
        { event, block, timestamp: auditBlockField(block, "Timestamp") ?? "", shard: "", shardIndex: 0, pos: 0 },
        claim.unit,
        claim.generation,
      ) === null;
    },
    baseHolds: (path) => gitPathExistsAt(projectDir, claim.claimed_from_oid, path),
  };
}

// The record's shared files as `baseOid` has them: every audit shard but the
// claim's own, and the stages' shared diaries (`<phase>/<stage>/memory.md`,
// outside any Unit's folder). Pin refuses a change to either
// (candidateBoundary), and `git add -A` commits both: a checkout
// whose own shard was on main before the claim still recorded its pre-claim
// rows there. They stay in the clone's history and working copy, as the
// projected rows do.
function sharedRecordFilesAsBase(
  projectDir: string,
  treeOid: string,
  baseOid: string,
  recordPrefix: string,
  auditShard: string,
): { tree: string; withheld: number } {
  const auditRoot = `${recordPrefix}/audit`;
  const paths = gitOutput(
    projectDir,
    [
      "diff", "--no-renames", "--name-only", baseOid, treeOid, "--",
      auditRoot, `:(glob)${recordPrefix}/*/*/memory.md`,
    ],
    "Cannot compare candidate audit shards",
  )
    .split(/\r?\n/)
    .filter((path) => path && path !== `${auditRoot}/${auditShard}`);
  if (paths.length === 0) return { tree: treeOid, withheld: 0 };
  const rows = (oid: string, path: string) =>
    gitPathExistsAt(projectDir, oid, path)
      ? auditShardBlocks(gitTextAt(projectDir, oid, path))
        .filter((block) => auditBlockField(block, "Event")).length
      : 0;
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-unit-tree-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    const read = git(projectDir, ["read-tree", treeOid], env);
    if (!read.ok) fail(`git read-tree failed: ${read.stderr.trim()}`);
    let withheld = 0;
    for (const path of paths) {
      withheld += Math.max(0, rows(treeOid, path) - rows(baseOid, path));
      const [mode, , oid] = gitOutput(
        projectDir,
        ["ls-tree", baseOid, "--", path],
        "Cannot read the base audit shard",
      ).split(/\s+/);
      const update = git(
        projectDir,
        oid
          ? ["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]
          : ["update-index", "--force-remove", "--", path],
        env,
      );
      if (!update.ok) fail(`git update-index failed: ${update.stderr.trim()}`);
    }
    const tree = git(projectDir, ["write-tree"], env);
    if (!tree.ok) fail(`git write-tree failed: ${tree.stderr.trim()}`);
    return { tree: tree.stdout.trim(), withheld };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The review record each REVIEW_COMPLETED row of the claim's shard names, from
// this clone's disk: AI-DLC keeps them under the record's engine folder, which
// its own .gitignore keeps out of every commit, and pin reads each one from
// the candidate (candidateReviewCoverage). Only a record whose digest matches
// its row is added; nothing else under the engine folder travels. A record
// that is gone or changed is named back, since pin will refuse without it.
function withClaimReviewRecords(
  projectDir: string,
  treeOid: string,
  recordPrefix: string,
  auditShard: string,
): { tree: string; missing: string[] } {
  const shardPath = `${recordPrefix}/audit/${auditShard}`;
  const missing: string[] = [];
  if (!gitPathExistsAt(projectDir, treeOid, shardPath)) return { tree: treeOid, missing };
  let tree = treeOid;
  for (const block of auditShardBlocks(gitTextAt(projectDir, treeOid, shardPath))) {
    if (auditBlockField(block, "Event") !== "REVIEW_COMPLETED") continue;
    const ref = reviewRecordRefFromBlock(block);
    if (!ref) continue;
    const path = `${recordPrefix}/${ref.path}`;
    if (gitPathExistsAt(projectDir, tree, path)) continue;
    let bytes = "";
    try {
      bytes = readFileSync(join(projectDir, path), "utf-8");
    } catch {
      // gone: named below
    }
    if (bytes && reviewRecordDigest(bytes) === ref.digest) {
      tree = writeTreeWithBlob(projectDir, tree, path, bytes);
    } else {
      missing.push(path);
    }
  }
  return { tree, missing };
}

const OUTSIDE_UNIT_RECORD_TREE = "outside claimed Unit record tree";

// `candidateOid` may be a tree: publish asks before it has a commit to ask about.
function candidateBoundary(
  projectDir: string,
  baseOid: string,
  candidateOid: string,
  recordPrefix: string,
  unit: string,
  generation: number,
  expectedAuditShard?: string,
): CandidateBoundary {
  const auditRoot = `${recordPrefix}/audit`;
  const auditChanges = gitOutput(
    projectDir,
    [
      "diff",
      "--no-renames",
      "--name-status",
      baseOid,
      candidateOid,
      "--",
      auditRoot,
    ],
    "Cannot compare candidate audit shards",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const addedAudit = auditChanges
    .filter((line) => line.startsWith("A\t"))
    .map((line) => line.split("\t").at(-1) ?? "")
    .filter(Boolean);
  const changedAudit = addedAudit.filter((path) =>
    isActiveIntentAuditPath(path, recordPrefix)
  );
  const violations = auditChanges
    .filter((line) => !line.startsWith("A\t"))
    .map((line) => `${line.split("\t").at(-1) ?? line} (inherited audit shard)`);
  for (const path of addedAudit.filter((path) =>
    !isActiveIntentAuditPath(path, recordPrefix)
  )) {
    violations.push(`${path} (invalid active-intent audit shard path)`);
  }
  if (changedAudit.length !== 1) {
    violations.push(
      `${auditRoot}/ (expected exactly one newly added team audit shard; found ${changedAudit.length})`,
    );
  }
  if (
    expectedAuditShard &&
    (
      changedAudit.length !== 1 ||
      changedAudit[0] !== `${auditRoot}/${expectedAuditShard}`
    )
  ) {
    violations.push(
      `${auditRoot}/ (expected claim-bound audit shard ${expectedAuditShard})`,
    );
  }

  const changedPaths = gitOutput(
    projectDir,
    ["diff", "--no-renames", "--name-only", baseOid, candidateOid],
    "Cannot inspect pinned candidate diff",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const unitRoot = `${recordPrefix}/construction/${unit}/`;
  const constructionRoot = `${recordPrefix}/construction/`;
  const reviewUnitMarker = `/${REVIEW_RECORDS_DIR}/`;
  const unitRootKey = unitRoot.toLowerCase();
  const constructionRootKey = constructionRoot.toLowerCase();
  const recordPrefixKey = `${recordPrefix}/`.toLowerCase();
  // A rule the person kept while working the Unit is written to the space's
  // project.md or team.md, not the Unit's folder; it travels with the Unit as
  // its source does, named at the merge gate.
  const space = activeSpace(projectDir);
  const keptRules = new Set(KEPT_RULE_SCOPES.map((scope) => keptRuleFile(space, scope)));
  const outsideUnitRecordPaths: string[] = [];
  for (const path of changedPaths) {
    if (isEngineMergeMetadata(projectDir, path, recordPrefix)) continue;
    const pathKey = path.toLowerCase();
    const reviewMarkerIndex = path.indexOf(reviewUnitMarker);
    if (reviewMarkerIndex !== -1) {
      const reviewParts = path.slice(reviewMarkerIndex + reviewUnitMarker.length).split("/");
      if (
        reviewParts.length === 5 &&
        reviewParts[1] === "units" &&
        reviewParts[2] === unit
      ) continue;
    }
    if (pathKey.startsWith(unitRootKey)) continue;
    if (changedAudit.includes(path)) continue;
    if (keptRules.has(path)) {
      outsideUnitRecordPaths.push(path);
      continue;
    }
    if (
      pathKey.startsWith(constructionRootKey) ||
      pathKey.startsWith(recordPrefixKey) ||
      pathKey.startsWith("aidlc/")
    ) {
      violations.push(`${path} (${OUTSIDE_UNIT_RECORD_TREE})`);
      continue;
    }
    outsideUnitRecordPaths.push(path);
  }

  for (const event of candidateAuditEvents(
    projectDir,
    candidateOid,
    changedAudit,
  )) {
    const violation = transportedAuditViolation(event, unit, generation);
    if (violation) {
      violations.push(
        `${event.shard} (${violation})`,
      );
    }
  }

  return {
    changedAudit: [...new Set(changedAudit)].sort(),
    outsideUnitRecordPaths: [...new Set(outsideUnitRecordPaths)].sort(),
    violations: [...new Set(violations)].sort(),
  };
}

function candidateEvidence(
  projectDir: string,
  claim: UnitClaimView,
  candidateBaseOid: string,
  liveIntegrationOid = candidateBaseOid,
): UnitMergeEvidence {
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) fail("Cannot resolve the active intent record for candidate evidence.");
  const statePath = `${recordPrefix}/aidlc-state.md`;
  const state = gitTextAt(projectDir, claim.oid, statePath);
  if (!isTeamUnitOwnership(state)) {
    fail("Pinned candidate state does not record Unit Ownership: team.");
  }
  const integrationState = stateAtOid(projectDir, liveIntegrationOid);
  if (!isTeamUnitOwnership(integrationState)) {
    fail("Pinned integration state does not record Unit Ownership: team.");
  }
  const scope = getField(integrationState, "Scope") ?? "";
  const stages = unitMajorConstructionStageSlugs(
    scope,
    integrationState,
    true,
  );
  if (stages.length === 0) fail("Pinned candidate has no active per-unit Construction stages.");
  validateCandidateUnitProgress(state, claim, stages);
  const graph = loadStageGraphAll();
  const baseState = stateAtOid(projectDir, candidateBaseOid);
  const baseStages = unitMajorConstructionStageSlugs(
    getField(baseState, "Scope") ?? "",
    baseState,
    true,
  );
  const baseDag = parseBoltDag(dependencyBodyAtOid(projectDir, candidateBaseOid));
  const dagBody = dependencyBodyAtOid(projectDir, liveIntegrationOid);
  const dag = parseBoltDag(dagBody);
  if (!baseDag.ok) {
    fail(`Pinned candidate base Unit DAG is ${baseDag.reason}: ${baseDag.detail}.`);
  }
  if (!dag.ok) {
    fail(`Pinned integration Unit DAG is ${dag.reason}: ${dag.detail}.`);
  }
  // The contract a candidate is built against is its own Unit's entry (kind,
  // dependencies) and the per-Unit stage columns: a Unit the plan adds, drops or
  // changes elsewhere does not make this Unit's work stale.
  const contract = (
    units: typeof dag.units,
    stageColumns: string[],
  ): string => JSON.stringify({
    stage_columns: stageColumns,
    unit: units.filter((entry) => entry.name === claim.unit).map((entry) => ({
      name: entry.name,
      kind: entry.kind ?? null,
      depends_on: [...entry.depends_on].sort(),
    })),
  });
  if (contract(baseDag.units, baseStages) !== contract(dag.units, stages)) {
    fail(
      `Unit "${claim.unit}" candidate is based on a stale Construction contract; ` +
        "rebase onto the current integration branch and publish again.",
    );
  }
  const unit = dag.units.find((entry) => entry.name === claim.unit);
  if (!unit) fail(`Pinned integration Unit DAG has no Unit "${claim.unit}".`);
  // A Unit lands after every Unit it depends on, read by the claim's own
  // opening rule. A revised plan can give a Unit already claimed a dependency
  // that has not landed yet (the walking skeleton is not one).
  const notLanded = (openingStatusFrom(integrationState, dagBody).blockers.get(claim.unit) ?? [])
    .filter((dep) => dep !== "walking-skeleton").sort();
  if (notLanded.length > 0) {
    const names = notLanded.map((dep) => `"${dep}"`).join(" and ");
    fail(
      `Unit "${claim.unit}" now depends on ${names}, which ${notLanded.length === 1 ? "has" : "have"} not landed on ` +
        `main yet; it lands after ${notLanded.length === 1 ? "it does" : "they do"}. Nothing was pinned or landed.`,
    );
  }
  const unitKind = unit.kind ?? null;
  const forcedMergeJournals = gitOutput(
    projectDir,
    [
      "diff",
      "--name-only",
      `${candidateBaseOid}..${claim.oid}`,
      "--",
      `aidlc/${UNIT_MERGE_DIR}`,
    ],
    "Cannot inspect candidate merge journals",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  if (forcedMergeJournals.length > 0) {
    fail(
      `Pinned candidate contains engine merge journals: ${forcedMergeJournals.join(", ")}.`,
    );
  }
  const boundary = candidateBoundary(
    projectDir,
    candidateBaseOid,
    claim.oid,
    recordPrefix,
    claim.unit,
    claim.generation,
    claim.payload.audit_shard,
  );
  if (!claim.payload.audit_shard) {
    fail(
      `Pinned candidate claim has no bound audit shard; release and re-claim Unit "${claim.unit}" before publishing again.`,
    );
  }
  if (boundary.violations.length > 0) {
    fail(
      `Pinned candidate violates claimed Unit ownership at: ${
        boundary.violations.join(", ")
      }.`,
    );
  }
  const changedAudit = boundary.changedAudit;
  const transportedEvents = candidateAuditEvents(
    projectDir,
    claim.oid,
    changedAudit,
  );
  const authorityRows = transportedEvents.filter((event) =>
    TRANSPORTED_ATTEMPT_EVENTS.has(event.event) ||
    TRANSPORTED_DATA_EVENTS.has(event.event)
  );
  const events = authorityRows;
  // A stage whose documents all belong to other kinds of Unit applies to this
  // one no more than it does to the walk: it settles with no directive, so it
  // earns no receipt, review or gate.
  const notApplicable = new Set(stages.filter((slug) => {
    const stage = graph.find((entry) => entry.slug === slug);
    return (stage?.produces ?? []).length > 0 &&
      filterProducesByKind(stage?.produces_kinds, stage?.produces ?? [], unitKind).length === 0;
  }));
  // The clone stamped each receipt with the run floor it read from the whole
  // audit record (the workflow's own rows plus its own). Read the candidate's
  // receipts against the same floor: main's rows that are not Unit attempt
  // rows, as the commit this evidence is read against holds them, with the
  // transported rows on top. Transported rows alone hold no WORKFLOW_STARTED,
  // so every real receipt would miss the floor; a file in this checkout that
  // was never committed does not move it.
  const mainShards = gitOutput(
    projectDir,
    ["ls-tree", "--name-only", liveIntegrationOid, "--", `${recordPrefix}/audit/`],
    "Cannot list the integration audit shards",
  )
    .split(/\r?\n/)
    .filter((path) => isActiveIntentAuditPath(path, recordPrefix));
  const floorRows = candidateAuditEvents(projectDir, liveIntegrationOid, mainShards).filter((row) =>
    !TRANSPORTED_ATTEMPT_EVENTS.has(row.event) &&
    !TRANSPORTED_DATA_EVENTS.has(row.event)
  );
  const snapshotRows = [...floorRows, ...authorityRows];
  const snapshots = new Map(stages.map((stage) => [
    stage,
    unitLifecycleSnapshot(
      projectDir,
      stage,
      snapshotRows,
      integrationState,
      {
        artifactFingerprint: (stageNode, unitName) =>
          candidateReviewFingerprint(
            projectDir,
            claim.oid,
            recordPrefix,
            unitName,
            stageNode,
            unitKind,
          ),
      },
    ),
  ]));
  // A stage the Unit skipped in this attempt owes, like one its kind writes
  // nothing for, no documents, review, receipt or per-stage gate; the merge
  // question says it was skipped, with the reason recorded.
  const skipped = new Map<string, string>();
  for (const stage of stages) {
    const reason = snapshots.get(stage)?.skipped.get(claim.unit);
    if (!notApplicable.has(stage) && reason !== undefined) skipped.set(stage, reason);
  }
  const owesNothing = (stage: string): boolean => notApplicable.has(stage) || skipped.has(stage);
  const stagesCompleted = stages.filter((stage) =>
    notApplicable.has(stage) || snapshots.get(stage)?.receipts.has(claim.unit) === true
  );
  const gatesExpected =
    claim.payload.gate_rhythm === "unit-end"
      ? [stages[stages.length - 1]]
      : stages.filter((stage) => !owesNothing(stage));
  const gatesApproved = gatesExpected.filter((stage) =>
    unitGateStatus(
      projectDir,
      stage,
      claim.unit,
      claim.payload.gate_rhythm,
      authorityRows,
    ) === "approved"
  );
  const reviewersExpected: string[] = [];
  const reviewersReady: string[] = [];
  const reviewersApprovedOverConcerns: NonNullable<UnitMergeEvidence["reviewers_approved_over_concerns"]> = [];
  const unreviewed: string[] = [];
  const artifactPaths: string[] = [];
  for (const stageSlug of stages) {
    if (owesNothing(stageSlug)) continue;
    const stage = graph.find((entry) => entry.slug === stageSlug);
    if (!stage) fail(`Pinned candidate references unknown stage "${stageSlug}".`);
    const names = filterProducesByKind(
      stage.produces_kinds,
      stage.produces ?? [],
      unitKind,
    );
    for (const name of names) {
      const path = `${recordPrefix}/construction/${claim.unit}/${stageSlug}/${artifactFilename(name)}`;
      if (!gitPathExistsAt(projectDir, claim.oid, path)) {
        fail(`Pinned candidate is missing required artifact ${path}.`);
      }
      artifactPaths.push(path);
    }
    if (stage.reviewer) {
      const reviewClass = resolveReviewClass(
        stage.review_class ?? "adversarial",
        scope,
        integrationState,
      );
      if (reviewClass !== "none") {
        reviewersExpected.push(stageSlug);
        const coverage = candidateReviewCoverage(
          events,
          projectDir,
          claim.oid,
          recordPrefix,
          claim.unit,
          claim.generation,
          stage,
          unitKind,
        );
        // A stage reads as clean only when its approval left no finding open.
        if (coverage === null) unreviewed.push(stage.name ?? stageSlug);
        else if (coverage.coverage === "ready" && coverage.findings.length === 0) reviewersReady.push(stageSlug);
        else reviewersApprovedOverConcerns.push({ stage: stageSlug, findings: coverage.findings });
      }
    }
  }
  const questionsPath =
    `${recordPrefix}/construction/${claim.unit}/code-generation/code-generation-questions.md`;
  let planFingerprint: string | null = null;
  // A Unit that skipped Code Generation wrote no plan, so none is read or owed.
  const buildsCode = stages.includes("code-generation") && !skipped.has("code-generation");
  if (buildsCode) {
    const plan = gitTextAt(
      projectDir,
      claim.oid,
      `${recordPrefix}/construction/${claim.unit}/code-generation/code-generation-plan.md`,
    );
    const instructions = gitTextAt(
      projectDir,
      claim.oid,
      `${recordPrefix}/construction/${claim.unit}/code-generation/unit-test-instructions.md`,
    );
    const questions = gitTextAt(projectDir, claim.oid, questionsPath);
    const fingerprint = recordedApprovalFingerprint(questions);
    const embedded = parseTestingContract(plan);
    const currentContract = resolveTestingPosture(projectDir);
    // A plan built with plan approval off carries the engine's own record of
    // that instead of the person's approval; both bind the same content.
    const approvalEvent = events.findLast((event) =>
      (event.event === "PLAN_APPROVAL_RECORDED" || event.event === "PLAN_APPROVAL_SKIPPED") &&
      attemptEventMatches(
        event,
        claim.unit,
        claim.generation,
        "code-generation",
      )
    );
    const questionsSha256 = createHash("sha256")
      .update(questions, "utf-8")
      .digest("hex");
    const promptSha256 = createHash("sha256")
      .update(
        `${questions
          .replace(/^\[Answer\]:[ \t]*.*$/gm, "[Answer]:")
          .trimEnd()}\n`,
        "utf-8",
      )
      .digest("hex");
    if (
      fingerprint &&
      instructions.trim().length > 0 &&
      embedded?.contract_sha256 === currentContract.contract_sha256 &&
      approvalEvent &&
      auditBlockField(approvalEvent.block, "Details") ===
        (approvalEvent.event === "PLAN_APPROVAL_SKIPPED" ? "Plan approval off" : "Approve Plan") &&
      auditBlockField(approvalEvent.block, "Plan Target") ===
        `unit:${claim.unit}` &&
      auditBlockField(approvalEvent.block, "Intent") ===
        claim.payload.intent_uuid &&
      auditBlockField(approvalEvent.block, "Approval Fingerprint") ===
        fingerprint &&
      auditBlockField(approvalEvent.block, "Questions File") ===
        questionsPath &&
      auditBlockField(approvalEvent.block, "Questions SHA-256") ===
        questionsSha256 &&
      auditBlockField(approvalEvent.block, "Prompt SHA-256") ===
        promptSha256 &&
      (auditBlockField(approvalEvent.block, "Directive Epoch") ?? "").length >
        0 &&
      (auditBlockField(approvalEvent.block, "Run floor") ?? "").length > 0 &&
      // The approval row pins the questions file's bytes (Questions SHA-256
      // above); no label on its `[Answer]:` line is read.
      (approvalEvent.event === "PLAN_APPROVAL_SKIPPED"
        ? (auditBlockField(approvalEvent.block, "Source") ?? "").length > 0
        : (auditBlockField(approvalEvent.block, "Session") ?? "").length > 0)
    ) {
      planFingerprint = fingerprint;
    }
  }
  const mergeHeld = (getField(state, "Merge-Held") ?? "").trim() === "true";
  const evidence: UnitMergeEvidence = {
    stages_expected: stages,
    stages_completed: stagesCompleted,
    // Only when there is one, so a Unit pinned before this field compares the same.
    ...(skipped.size > 0
      ? { stages_skipped: [...skipped].map(([stage, reason]) => ({ stage, reason })) }
      : {}),
    gates_expected: gatesExpected,
    gates_approved: gatesApproved,
    reviewers_expected: reviewersExpected,
    reviewers_ready: reviewersReady,
    ...(reviewersApprovedOverConcerns.length > 0
      ? { reviewers_approved_over_concerns: reviewersApprovedOverConcerns }
      : {}),
    plan_fingerprint: planFingerprint,
    artifact_paths: artifactPaths,
    audit_shards: changedAudit,
    outside_unit_record_paths: boundary.outsideUnitRecordPaths,
    merge_held: mergeHeld,
  };
  const incomplete: string[] = [];
  if (stagesCompleted.length + skipped.size !== stages.length) incomplete.push("UNIT_COMPLETED receipts");
  if (gatesApproved.length !== gatesExpected.length) incomplete.push("team gate approvals");
  if (buildsCode && !planFingerprint) {
    incomplete.push("Plan Approval fingerprint");
  }
  if (changedAudit.length === 0) {
    incomplete.push("transportable audit shard");
  }
  // A stage's review is the person's to have done again, where the Unit is
  // claimed; pin runs only in a checkout that holds no claim.
  const reviewStep = unreviewed.length === 0
    ? ""
    : `${namesInProse(unreviewed)} ${unreviewed.length === 1 ? "has" : "have"} no review that stands for ` +
      `${unreviewed.length === 1 ? "it" : "them"} as published: in the checkout where ${claim.owner} claimed ` +
      `${claim.unit} (not this one), have ${unreviewed.length === 1 ? "it" : "them"} reviewed again, then publish ` +
      `${claim.unit} again.`;
  if (incomplete.length > 0 || reviewStep) {
    fail(
      [
        incomplete.length > 0 ? `Pinned candidate evidence is incomplete: ${incomplete.join(", ")}.` : "",
        reviewStep,
      ].filter(Boolean).join(" "),
    );
  }
  return evidence;
}

function publishUnit(args: string[], projectDir?: string): void {
  const { positional, flags, bareFlags } = parseArgs(args);
  // `--commit` takes no value; `publish --commit alpha` reads alpha as its own.
  const commitFirst = bareFlags.has("commit") || flags.commit !== undefined;
  const unit = positional[0] ?? (bareFlags.has("commit") ? undefined : flags.commit);
  if (!unit) fail("Usage: aidlc-unit publish <unit> [--commit]");
  const pd = resolveProjectDir(projectDir);
  const stamp = requireLiveClaimForTeamUnit(pd, unit);
  if (!stamp) fail("Unit publication requires a scoped team checkout.");
  if (commitFirst) {
    // A commit git refused leaves HEAD where it was, so the offer to publish
    // at this HEAD is due again.
    try {
      commitWorkHere(pd, `Complete the ${unit} Unit`);
    } catch (error) {
      clearTeamHandoverMarks(pd, ["publish"]);
      fail(`${errorMessage(error)} Then publish again.`);
    }
  }
  const changed = worktreeChanges(pd, "no", "Cannot inspect candidate worktree");
  const own = aidlcOwnRootParts(pd, changed);
  if (changed.some((path) => !own.has(path))) {
    fail("Unit publication requires a clean tracked worktree; commit the candidate first.");
  }
  const remote = repositoryRemote(pd);
  const current = currentClaim(pd, remote, stamp.claim_ref);
  if (
    current?.status !== "claimed" ||
    current.nonce !== stamp.nonce ||
    current.generation !== stamp.generation
  ) {
    fail(`Unit "${unit}" claim is stale or released; publication refused.`);
  }
  const headOid = gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve candidate HEAD");
  const rawHeadTree = gitOutput(
    pd,
    ["rev-parse", "HEAD^{tree}"],
    "Cannot resolve candidate tree",
  );
  const recordPrefix = relativeRecordDir(pd);
  if (!recordPrefix) fail("Cannot resolve the active intent record for publication.");
  // The shard the claim bound at claim time, which is the one pin inspects
  // (candidateEvidence fails without it). Reading it from the claim rather
  // than resolving a name here keeps one owner for the shard's identity.
  const auditShard = current.payload.audit_shard;
  if (!auditShard || !/^[A-Za-z0-9._-]+\.md$/.test(auditShard)) {
    fail(
      `Unit "${unit}" claim has no bound audit shard; release and re-claim it before publishing again.`,
    );
  }
  const integration = fetchIntegration(pd);
  const integrationIsAncestor = localGit(
    pd,
    ["merge-base", "--is-ancestor", integration.oid, headOid],
  ).ok;
  const publicationBaseOid = integrationIsAncestor
    ? integration.oid
    : current.payload.base_oid;
  const publicationIntegrationRef = integrationIsAncestor
    ? integration.ref
    : current.payload.integration_ref;
  const asBase = sharedRecordFilesAsBase(
    pd,
    rawHeadTree,
    publicationBaseOid,
    recordPrefix,
    auditShard,
  );
  const reviews = withClaimReviewRecords(pd, asBase.tree, recordPrefix, auditShard);
  const headTree = reviews.tree;
  const missingReviews = reviews.missing.length > 0
    ? { review_records_missing: reviews.missing }
    : {};
  // Pin refuses any other record outside the Unit's tree, so publish names
  // them now, beside the review records, rather than leaving the team to learn
  // it at pin; the change is theirs to take out, so publish still publishes.
  const outsideSuffix = ` (${OUTSIDE_UNIT_RECORD_TREE})`;
  const outside = candidateBoundary(
    pd, publicationBaseOid, headTree, recordPrefix, unit, current.generation, auditShard,
  ).violations.filter((violation) => violation.endsWith(outsideSuffix))
    .map((violation) => violation.slice(0, -outsideSuffix.length));
  const outsideTree = outside.length > 0
    ? {
      records_outside_unit_tree: outside,
      records_outside_unit_tree_note:
        "Pin will refuse this candidate: a claimed Unit lands only " +
        `construction/${unit}/ and its own audit shard, and a shared record (an Inception artifact ` +
        "such as contract-summary.md, or a stage-level file) is changed on main. Take these out of " +
        "this branch (git rm a file main does not have, or " +
        `git checkout ${publicationIntegrationRef.replace(/^refs\/(remotes|heads)\//, "")} -- <path> for one it does), commit, and ` +
        "publish again.",
    }
    : {};
  if (
    current.payload.candidate_tree_oid === headTree &&
    current.payload.candidate_head_oid === headOid &&
    current.payload.base_oid === publicationBaseOid &&
    current.payload.integration_ref === publicationIntegrationRef
  ) {
    const recoveredStamp = { ...stamp, claim_oid: current.oid };
    finalizeClaimCheckout(pd, recoveredStamp, current);
    console.log(JSON.stringify({
      published: true,
      recovered: true,
      unit,
      candidate_oid: current.oid,
      generation: current.generation,
      ...missingReviews,
      ...outsideTree,
    }));
    return;
  }
  const payload: UnitClaimPayload = {
    ...current.payload,
    predecessor_oid: current.oid,
    base_oid: publicationBaseOid,
    integration_ref: publicationIntegrationRef,
    candidate_tree_oid: headTree,
    candidate_head_oid: headOid,
  };
  // The claim's second parent hands this checkout's local record over with its
  // commit: reachable from the claim ref for a teammate's adopt, never in the
  // candidate tree main lands.
  const localPath = `${recordPrefix}/${ENGINE_DIR}/audit/${auditShard}`;
  const localRecord = readLocalRecord(pd, localPath);
  const handover = localRecord === null
    ? headOid
    : commitAsPerson(
      pd,
      writeTreeWithBlob(pd, headTree, localPath, localRecord),
      [headOid],
      `aidlc unit handover: ${unit} generation ${current.generation}`,
    );
  const commit = createClaimCommit(
    pd,
    current.oid,
    payload,
    headTree,
    handover,
  );
  const pushed = updateClaimRef(pd, remote, stamp.claim_ref, commit, current.oid);
  if (!pushed.ok) {
    if (pushed.refused) {
      fail(`Unit "${unit}" publication was rejected by ${remote}: ${pushed.refused}`);
    }
    fail(`Unit "${unit}" publication compare-and-swap failed; refresh the claim and retry.`);
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  const published = currentClaim(pd, remote, stamp.claim_ref);
  if (!published || published.oid !== commit || published.nonce !== stamp.nonce) {
    fail(`Unit "${unit}" publication verification failed.`);
  }
  const updatedStamp = { ...stamp, claim_oid: published.oid };
  finalizeClaimCheckout(pd, updatedStamp, published);
  console.log(JSON.stringify({
    published: true,
    unit,
    candidate_oid: published.oid,
    candidate_head_oid: headOid,
    generation: published.generation,
    ...missingReviews,
    ...outsideTree,
  }));
}

// A claimed checkout's local record as it stands (auditFilePath names it), or
// null when it has none or it is not a plain file inside the project.
function readLocalRecord(projectDir: string, path: string): string | null {
  try {
    assertNoSymlinkInChainOrThrow(realpathSync(projectDir), path);
    return readAppendOnlyFileNoFollowOrThrow(join(projectDir, ...path.split("/")), "audit shard").toString("utf-8");
  } catch {
    return null;
  }
}

interface PinnedClaimCheck {
  claim: UnitClaimView;
  releasedTombstone?: UnitClaimView;
}

function pinnedClaimFromTransaction(
  projectDir: string,
  transaction: UnitMergeTransaction,
): UnitClaimView {
  const payload = readPayload(projectDir, transaction.pinned_oid, {
    localOnly: true,
  });
  if (
    payload?.status !== "claimed" ||
    payload.unit !== transaction.unit ||
    payload.intent_uuid !== transaction.intent_uuid ||
    payload.generation !== transaction.generation ||
    payload.nonce !== transaction.nonce ||
    payload.owner !== transaction.owner ||
    payload.base_oid !== transaction.candidate_base_oid ||
    payload.candidate_tree_oid !== transaction.candidate_tree_oid
  ) {
    fail(`Pinned Unit "${transaction.unit}" claim payload is unavailable or invalid.`);
  }
  return {
    unit: payload.unit,
    status: payload.status,
    owner: payload.owner,
    generation: payload.generation,
    nonce: payload.nonce,
    oid: transaction.pinned_oid,
    ref: transaction.claim_ref,
    payload,
  };
}

function currentPinnedClaim(
  projectDir: string,
  transaction: UnitMergeTransaction,
  options: { acceptReleasedAttempt?: boolean } = {},
): PinnedClaimCheck {
  invalidateLiveClaimPayloadCache(projectDir, transaction.unit);
  let current: UnitClaimView | null;
  try {
    current = currentClaim(
      projectDir,
      repositoryRemote(projectDir),
      transaction.claim_ref,
    );
  } catch (error) {
    const message = errorMessage(error);
    if (
      !message.startsWith("Unit claim registry read failed:") &&
      !message.startsWith("Unit claim registry fetch failed:")
    ) {
      throw error;
    }
    fail(
      `Unit "${transaction.unit}" claim registry is unavailable (${message}); ` +
        "merge gate and landing fail closed because the pinned attempt may have been tombstoned. Restore registry access and retry.",
    );
  }
  if (
    current?.status === "released" &&
    current.payload.predecessor_oid === transaction.pinned_oid &&
    current.generation === transaction.generation + 1
  ) {
    const accepted =
      transaction.released_after_git?.tombstone_oid === current.oid &&
      transaction.released_after_git.tombstone_generation ===
        current.generation;
    if (
      (!options.acceptReleasedAttempt && !accepted) ||
      transaction.status !== "git-landed"
    ) {
      fail(
        `Unit "${transaction.unit}" was released after its merge commit landed. ` +
          `Inspect the landed commit, then recover explicitly with aidlc unit land ${transaction.unit} ` +
          "--accept-released-attempt --user-input '<human acknowledgment>'.",
      );
    }
    return {
      claim: pinnedClaimFromTransaction(projectDir, transaction),
      releasedTombstone: current,
    };
  }
  if (
    current?.status === "claimed" &&
    current.oid === transaction.pinned_oid &&
    current.generation === transaction.generation &&
    current.nonce === transaction.nonce &&
    current.owner !== transaction.owner
  ) {
    fail(
      `Unit "${transaction.unit}" merge journal owner does not match the pinned claim payload owner.`,
    );
  }
  if (
    current?.status !== "claimed" ||
    current.oid !== transaction.pinned_oid ||
    current.generation !== transaction.generation ||
    current.nonce !== transaction.nonce ||
    current.owner !== transaction.owner ||
    current.payload.base_oid !== transaction.candidate_base_oid ||
    current.payload.candidate_tree_oid !== transaction.candidate_tree_oid
  ) {
    fail(
      `Unit "${transaction.unit}" claim ref moved or changed attempt after pin; run aidlc-unit pin ${transaction.unit} again.`,
    );
  }
  return { claim: current };
}

function orderedAuditRows(projectDir: string): ReturnType<typeof readAuditShardEvents> {
  return readAuditShardEvents(projectDir).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
}

function mainAuthorityAuditRows(
  projectDir: string,
): ReturnType<typeof readAuditShardEvents> {
  const mainShard = auditShardName(projectDir);
  return orderedAuditRows(projectDir).filter(
    (row) => basename(row.shard) === mainShard,
  );
}

function assertTransactionIdentity(
  projectDir: string,
  transaction: UnitMergeTransaction,
): void {
  const identity = activeIdentity(projectDir);
  if (
    transaction.space !== identity.space ||
    transaction.intent_uuid !== identity.intentUuid ||
    transaction.intent_id8 !== identity.intentId8 ||
    transaction.claim_ref !== claimRef(identity.intentId8, transaction.unit)
  ) {
    fail(
      `Unit "${transaction.unit}" merge transaction belongs to another active space or intent.`,
    );
  }
}

// A pinned Unit lands with a regular merge, so the reviewed pinned OID stays a
// direct parent, into the integration branch pin fetched (fetchIntegration,
// which reads the team's Way of Working). Neither is a lookup's or the
// person's to choose: the team's own default (squash) holds for every other
// merge. Pin prints these terms with the gate's question; the gate records them.
function pinnedMergeGate(
  transaction: UnitMergeTransaction,
): { strategy: "merge"; target: string } {
  return { strategy: "merge", target: transaction.integration_branch };
}

// The merge gate as pin hands it to the agent: one question for the person,
// asked in the pin's own turn, and the command that records each answer. Their
// reply goes in a request file the agent writes with its file tool and the
// gate reads (readRequestFile), so no shell reads it on the way: PowerShell and
// Git Bash quote an apostrophe differently. Pin makes the file's folder, since
// some hosts' file tools make none, and removes a reply left there from an
// earlier gate of this Unit (one a refused gate kept), which answers nothing
// this pin asks.
function pinMergeGateStep(pd: string, transaction: UnitMergeTransaction): Record<string, string> {
  const terms = pinnedMergeGate(transaction);
  const file = `${REQUEST_TEXT_DIR}/gate-${transaction.unit.replace(/[^A-Za-z0-9._-]+/g, "-")}.txt`;
  try {
    const target = recordFileTargetOrThrow(pd, file);
    mkdirSync(dirname(target), { recursive: true });
    rmSync(target, { force: true });
  } catch {
    // A file tool that makes folders still writes it; the command is the same.
  }
  const record = (decision: "approve" | "reject") =>
    `${aidlcInvocation()} unit gate ${quoteCommandArgument(transaction.unit)} --decision ${decision} --request-file ${file}`;
  return {
    strategy: terms.strategy,
    target_branch: terms.target,
    ask:
      `Ask the person now, as one question, whether to merge Unit "${transaction.unit}" into ${terms.target}` +
      " (Approve or Reject), with the pinned commit and the files outside the Unit's folder above, then end your" +
      ` turn. Write their reply, as they typed it, to \`${file}\` with your file tool, not a shell, and record it` +
      " with the command for their choice.",
    approve: record("approve"),
    reject: record("reject"),
    ...skippedStepsLine(transaction),
  };
}

// A step the Unit skipped is said once in the merge question, with its reason.
function skippedStepsLine(transaction: UnitMergeTransaction): Record<string, string> {
  const skipped = transaction.evidence.stages_skipped ?? [];
  if (skipped.length === 0) return {};
  const graph = loadStageGraphAll();
  const steps = skipped.map(({ stage, reason }) =>
    `${graph.find((entry) => entry.slug === stage)?.name || stage} (${reason})`
  );
  return {
    skipped_steps: `Unit "${transaction.unit}" skipped ${steps.join(" and ")}. Say so in the question, in one line.`,
  };
}

// After the person's Approve, the land is the next step, as their Approve is
// the go to merge: the gate hands it out so the same turn lands it.
function approvedLandStep(transaction: UnitMergeTransaction): Record<string, string> {
  return {
    command: `${aidlcInvocation()} unit land ${quoteCommandArgument(transaction.unit)} --target ${quoteCommandArgument(pinnedMergeGate(transaction).target)}`,
    step: "Run it now, in this turn, and tell the person in plain words what it reports.",
  };
}

// The person's reply to the gate the pin showed: a typed turn in main's own
// shard stamped after the pin, so the turn that ran the pin is not it, and
// after the last gate decision, which spent the turns before it. Returns the
// messages those turns came in; null with the human-presence guard off.
function requireReplyAfterPin(
  projectDir: string,
  transaction: UnitMergeTransaction,
): ReadonlySet<string> | null {
  if (humanPresenceGuardDisabled()) return null;
  const all = mainAuthorityAuditRows(projectDir);
  const previousGateIndex = all.findLastIndex(
    (row) =>
      (row.event === "GATE_APPROVED" || row.event === "GATE_REJECTED") &&
      auditBlockField(row.block, "Stage") !== null,
  );
  const turns = all
    .slice(previousGateIndex + 1)
    .filter(
      (row) =>
        row.event === "HUMAN_TURN" && row.timestamp > transaction.pinned_at,
    );
  if (turns.length === 0) {
    fail(
      `Unit "${transaction.unit}" merge gate requires a typed human turn after the pin.`,
    );
  }
  return new Set(
    turns.flatMap((row) => auditBlockField(row.block, "Message Id") ?? []),
  );
}

// What the person said at the merge gate, for its row as a stage gate's row
// keeps it (personsGateReply, in this chat): their words, the message they
// came in and, when several, every message. Only a message sent after the pin
// answers it. Pin writes no stage start to bound the window, so when it
// reaches back past the pin its words are not all the gate's: the row names
// the messages after the pin and leaves the words to their records. A record
// or a chat the engine cannot read leaves the row as it was, never a refusal.
function mergeGateReplyFields(
  projectDir: string,
  afterPin: ReadonlySet<string>,
): Record<string, string> {
  try {
    const reply = personsGateReply(
      projectDir,
      resolveInvokingSessionId(projectDir),
      "unit-merge",
    );
    const replies = reply.replies.filter((entry) => afterPin.has(entry.id));
    const latest = replies.at(-1)?.id;
    return {
      ...(reply.words && replies.length === reply.replies.length
        ? { "Person Reply": reply.words }
        : {}),
      ...(latest ? { "Message Id": latest } : {}),
      ...windowMessageIds({ replies }),
    };
  } catch {
    return {};
  }
}

function mergeGateRecord(
  projectDir: string,
  transaction: UnitMergeTransaction,
): {
  decision: "approve" | "reject";
  strategy: string | null;
  target: string | null;
} | null {
  const decisions = mainAuthorityAuditRows(projectDir).filter(
    (row) =>
      (row.event === "GATE_APPROVED" || row.event === "GATE_REJECTED") &&
      auditBlockField(row.block, "Stage") === "unit-merge" &&
      auditBlockField(row.block, "Unit") === transaction.unit &&
      auditBlockField(row.block, "Pinned OID") === transaction.pinned_oid &&
      auditBlockField(row.block, "Attempt Generation") ===
        String(transaction.generation) &&
      auditBlockField(row.block, "Gate Scope") === "unit-merge",
  );
  const latest = decisions.at(-1);
  if (!latest) return null;
  return {
    decision: latest.event === "GATE_APPROVED" ? "approve" : "reject",
    strategy: auditBlockField(latest.block, "Strategy"),
    target: auditBlockField(latest.block, "Target branch"),
  };
}

function pinUnit(args: string[], projectDir?: string): void {
  const { positional } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit pin <unit>");
  const pd = resolveProjectDir(projectDir);
  if (readApplicableTeamUnitScopeStamp(pd)) {
    fail("Unit pinning must run from an unscoped main checkout.");
  }
  assertMainCheckout(pd);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit pinning requires Unit Ownership: team.");
  const identity = activeIdentity(pd);
  const inFlight = readUnitMergeTransaction(pd, unit);
  const integration = fetchIntegration(pd);
  const ref = claimRef(identity.intentId8, unit);
  const claim = currentClaim(pd, integration.remote, ref);
  let superseded: UnitMergeTransaction | null = null;
  if (
    inFlight &&
    inFlight.space === identity.space &&
    inFlight.intent_uuid === identity.intentUuid &&
    ["approved", "git-landed", "state-folded", "complete"].includes(
      inFlight.status,
    )
  ) {
    if (!approvalOutlivedByRepublish(pd, inFlight, claim)) {
      fail(
        `Unit "${unit}" already has a ${inFlight.status} merge transaction; recover it with aidlc unit land ${unit} instead of re-pinning.`,
      );
    }
    superseded = inFlight;
  }
  if (
    claim?.status !== "claimed" ||
    claim.payload.intent_uuid !== identity.intentUuid ||
    !claim.payload.candidate_tree_oid
  ) {
    fail(`Unit "${unit}" has no published live candidate to pin.`);
  }
  writeClaimGeneration(pd, unit, claim.generation);
  const evidence = candidateEvidence(
    pd,
    claim,
    claim.payload.base_oid,
    integration.oid,
  );
  const mainBefore = gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve main HEAD");
  const transaction: UnitMergeTransaction = {
    version: 1,
    status: "pinned",
    space: identity.space,
    intent_uuid: identity.intentUuid,
    intent_id8: identity.intentId8,
    unit,
    owner: claim.owner,
    generation: claim.generation,
    nonce: claim.nonce,
    claim_ref: ref,
    pinned_oid: claim.oid,
    candidate_tree_oid: claim.payload.candidate_tree_oid,
    candidate_base_oid: claim.payload.base_oid,
    integration_oid: integration.oid,
    integration_branch: integration.branch,
    main_before_oid: mainBefore,
    pinned_at: isoTimestamp(),
    pin_id: randomUUID(),
    audit_shard: claim.payload.audit_shard,
    evidence,
  };
  updateCachedClaim(pd, claim);
  writeUnitMergeTransaction(pd, transaction);
  console.log(JSON.stringify({
    pinned: true,
    unit,
    pinned_oid: claim.oid,
    pin_id: transaction.pin_id,
    generation: claim.generation,
    evidence,
    gate_required: true,
    merge_gate: pinMergeGateStep(pd, transaction),
    ...(superseded
      ? { superseded: { pinned_oid: superseded.pinned_oid, status: superseded.status } }
      : {}),
  }));
}

// An approved merge that git never landed, whose Unit was republished since
// (a refused landing, then a reopened stage): the approval was for a candidate
// the claim no longer holds, and gate and land both send the person back to
// pin. Pin replaces it. The approval stays bound to its own Pinned OID and
// Attempt Generation, so it never counts for the new candidate.
function approvalOutlivedByRepublish(
  projectDir: string,
  transaction: UnitMergeTransaction,
  claim: UnitClaimView | null,
): boolean {
  if (
    transaction.status !== "approved" ||
    transaction.git_commit_oid ||
    transaction.checkpoint_commit_oid ||
    claim?.status !== "claimed" ||
    claim.payload.intent_uuid !== transaction.intent_uuid ||
    (
      claim.oid === transaction.pinned_oid &&
      claim.generation === transaction.generation &&
      claim.nonce === transaction.nonce
    )
  ) {
    return false;
  }
  if (git(projectDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) return false;
  return firstParentMergeOf(projectDir, transaction) === null;
}

function gateUnitMerge(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  const decision = flags.decision;
  const pd = resolveProjectDir(projectDir);
  // The person's words in the file the engine wrote for this command, so no
  // shell reads them on the way (an apostrophe beside a ! or a $ is quoted one
  // way for PowerShell and another for Git Bash); spent once recorded.
  let userInput = flags["user-input"]?.trim();
  let spend = (): void => {};
  if (flags["request-file"] !== undefined) {
    if (userInput) fail("Pass either --user-input or --request-file, not both.");
    const read = readRequestFile(pd, flags["request-file"]);
    if (typeof read === "string") fail(read);
    userInput = read.text.trim();
    spend = read.spend;
  }
  if (!unit || (decision !== "approve" && decision !== "reject") || !userInput) {
    fail(
      "Usage: aidlc-unit gate <unit> --decision <approve|reject> (--user-input <text> | --request-file <file>)",
    );
  }
  if (
    !humanPresenceGuardDisabled() &&
    isNonAnswer(userInput)
  ) {
    fail(
      `Refusing Unit "${unit}" merge approval: --user-input "${userInput}" is cancellation boilerplate, not a human decision.`,
    );
  }
  const transaction = readUnitMergeTransaction(pd, unit);
  if (!transaction || !["pinned", "approved", "rejected"].includes(transaction.status)) {
    fail(`Unit "${unit}" has no pinned merge transaction.`);
  }
  assertTransactionIdentity(pd, transaction);
  const claim = currentPinnedClaim(pd, transaction).claim;
  const liveIntegration = fetchIntegration(pd);
  const evidence = candidateEvidence(
    pd,
    claim,
    transaction.candidate_base_oid,
    liveIntegration.oid,
  );
  if (JSON.stringify(evidence) !== JSON.stringify(transaction.evidence)) {
    fail(`Unit "${unit}" pinned evidence journal changed; run aidlc-unit pin ${unit} again.`);
  }
  if (transaction.evidence.merge_held) {
    fail(
      `Unit "${unit}" merge is held. Resolve the existing HOLD-MERGE flow in the team checkout, publish, and re-pin.`,
    );
  }
  const existingDecision = mergeGateRecord(pd, transaction)?.decision;
  if (
    (
      (transaction.status === "approved" && decision === "approve") ||
      (transaction.status === "rejected" && decision === "reject")
    ) &&
    existingDecision === decision
  ) {
    spend();
    console.log(JSON.stringify({
      gated: true,
      recovered: true,
      unit,
      decision,
      pinned_oid: transaction.pinned_oid,
      ...(decision === "approve" ? { land: approvedLandStep(transaction) } : {}),
    }));
    return;
  }
  const afterPin = requireReplyAfterPin(pd, transaction);
  const terms = pinnedMergeGate(transaction);
  appendAuditEntry(
    decision === "approve" ? "GATE_APPROVED" : "GATE_REJECTED",
    {
      Stage: "unit-merge",
      Unit: unit,
      "Pinned OID": transaction.pinned_oid,
      "Attempt Generation": String(transaction.generation),
      "Gate Scope": "unit-merge",
      Strategy: terms.strategy,
      "Target branch": terms.target,
      "Outside the unit record tree":
        transaction.evidence.outside_unit_record_paths.join(", ") || "none",
      ...(decision === "approve"
        ? { "User Input": userInput }
        : { Feedback: userInput }),
      ...(afterPin ? mergeGateReplyFields(pd, afterPin) : {}),
      ...personGitNameField(pd),
    },
    pd,
  );
  writeUnitMergeTransaction(pd, {
    ...transaction,
    status: decision === "approve" ? "approved" : "rejected",
    decision,
    user_input: userInput,
    target_branch: terms.target,
    strategy: terms.strategy,
  });
  spend();
  console.log(JSON.stringify({
    gated: true,
    unit,
    decision,
    pinned_oid: transaction.pinned_oid,
    generation: transaction.generation,
    outside_unit_record_paths:
      transaction.evidence.outside_unit_record_paths,
    outside_unit_record_tree_note:
      "These paths are outside the unit's record tree and require human overlap judgment.",
    ...(decision === "approve" ? { land: approvedLandStep(transaction) } : {}),
  }));
}

function isActiveIntentAuditPath(
  path: string,
  recordPrefix: string,
): boolean {
  const root = `${recordPrefix}/audit/`;
  if (!path.startsWith(root)) return false;
  const leaf = path.slice(root.length);
  return /^[A-Za-z0-9._-]+\.md$/.test(leaf);
}

function isEngineMergeMetadata(
  projectDir: string,
  path: string,
  recordPrefix = relativeRecordDir(projectDir),
): boolean {
  if (!recordPrefix) return path === CLAIM_FILE;
  const activeIntentPointer = `${dirname(recordPrefix)}/active-intent`;
  return new Set([
    CLAIM_FILE,
    "aidlc/active-space",
    activeIntentPointer,
    `${recordPrefix}/aidlc-state.md`,
    `${recordPrefix}/runtime-graph.json`,
  ]).has(path);
}

// A review record the candidate carries for pin (withClaimReviewRecords) that
// this checkout's .gitignore ignores, as AI-DLC's own does for its engine
// folder, and that main does not hold: the landing keeps it out of the merge
// commit, so main never tracks a file its own .gitignore ignores.
function isCarriedReviewRecord(
  projectDir: string,
  path: string,
  recordPrefix: string | null,
  mainTreeish: string,
): boolean {
  return recordPrefix !== null &&
    path.startsWith(`${recordPrefix}/${REVIEW_RECORDS_DIR}/`) &&
    !gitPathExistsAt(projectDir, mainTreeish, path) &&
    git(projectDir, ["check-ignore", "-q", "--no-index", "--", path]).ok;
}

// The paths `git status` lists as changed: tracked changes, and with
// `untracked: "all"` every untracked file Git does not ignore.
function worktreeChanges(projectDir: string, untracked: "no" | "all", label: string): string[] {
  const status = git(projectDir, ["status", "--porcelain=v1", "-z", `--untracked-files=${untracked}`]);
  if (!status.ok) fail(`${label}: ${status.stderr.trim() || `exit ${status.code}`}`);
  const paths: string[] = [];
  const records = status.stdout.split("\u0000");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    if (/[RC]/.test(code) && records[i + 1]) {
      paths.push(records[++i]);
    }
  }
  return paths;
}

// What AI-DLC's own write in a shared root file is: its marked part (.gitignore,
// AGENTS.md) or its entries in a JSON file (opencode.json), as aidlcRootParts
// reads them from what the project's harnesses ship.
type OwnRootPart = { marker: string; legacy: string[] } | { entries: string };

// The changed paths that hold only AI-DLC's own write, which the session-start
// hook adds in a checkout config never ran in and a release brings up to date:
// in a shared root file, its marked part as a release shipped it with the
// person's part around it as HEAD holds it, or exactly what the hook writes
// over HEAD's copy (an unmarked copy a release shipped whole taken over as its
// part, or its entries merged in; no copy when HEAD has none). A change
// of the person's in that file, inside the part too (the hook and config then
// leave the part as theirs), a file they staged, or a part that does not read,
// leaves it theirs.
function aidlcOwnRootParts(projectDir: string, paths: readonly string[]): Map<string, OwnRootPart> {
  const own = new Map<string, OwnRootPart>();
  if (paths.length === 0) return own;
  const { blocks, entries } = aidlcRootParts(projectDir);
  const entriesAt = new Map([...entries].map(([key, part]) => [rootIntegrationTarget(projectDir, key), part.text]));
  for (const path of paths) {
    const block = blocks.get(path);
    const shippedEntries = entriesAt.get(path);
    if (!block && shippedEntries === undefined) continue;
    if (!git(projectDir, ["diff", "--cached", "--quiet", "--", path]).ok) continue;
    let text: string;
    try {
      if (!lstatSync(join(projectDir, path)).isFile()) continue;
      text = readFileSync(join(projectDir, path), "utf-8");
    } catch {
      continue;
    }
    const committed = gitPathExistsAt(projectDir, "HEAD", path) ? gitTextAt(projectDir, "HEAD", path) : "";
    // Git's copy holds the line endings the repository stores, the file the
    // checkout's own (core.autocrlf on Windows), so they are left aside.
    const lf = (value: string) => value.replace(/\r\n/g, "\n");
    const written = block ? mergeBlock(path, committed, block.shipped, block.marker, block.legacy).value : undefined;
    if (
      block && (
        (onlyMarkedPartChanged(path, text, committed, block.marker) &&
          mergeBlock(path, text, block.shipped, block.marker, block.legacy).currentBlockShipped) ||
        (written !== undefined && lf(written) === lf(text))
      )
    ) {
      own.set(path, { marker: block.marker, legacy: block.legacy });
    } else if (shippedEntries !== undefined) {
      const merged = mergeJsonEntries(committed, shippedEntries, { kind: "none" });
      if (!("conflict" in merged) && lf(merged.text) === lf(text)) own.set(path, { entries: shippedEntries });
    }
  }
  return own;
}

interface YieldedRootPart {
  path: string;
  part: OwnRootPart;
  bytes: Buffer;
}

// Git refuses to merge over a local change to a file the merge writes, the
// same bytes included. So before the merge, AI-DLC's own write in a shared
// root file the candidate also changes is set aside: the file goes back to
// HEAD's copy (or, AI-DLC's whole, away), and its bytes are kept in `yielded`
// first, so a stop part way still gives each one back. They are kept in memory
// only: a landing killed between the merge and its commit leaves the merge's
// copy, and the next session start writes AI-DLC's part again.
function yieldOwnRootParts(projectDir: string, candidatePaths: readonly string[], yielded: YieldedRootPart[]): void {
  const touched = worktreeChanges(projectDir, "all", "Cannot inspect main worktree")
    .filter((path) => candidatePaths.includes(path));
  for (const [path, part] of aidlcOwnRootParts(projectDir, touched)) {
    yielded.push({ path, part, bytes: readFileSync(join(projectDir, path)) });
    if (gitPathExistsAt(projectDir, "HEAD", path)) {
      const restored = git(projectDir, ["checkout", "HEAD", "--", path]);
      if (!restored.ok) fail(`Failed to restore ${path} before the Unit merge: ${restored.stderr.trim()}.`);
    } else {
      git(projectDir, ["rm", "-f", "--cached", "--ignore-unmatch", "--", path]);
      unlinkSync(join(projectDir, path));
    }
  }
}

// After the merge, what was set aside goes back onto the merged file, still
// uncommitted: AI-DLC's marked part as the landing checkout had it, or its
// entries merged as the hook merges them, around the person's part as the
// merge made it. When the landing stopped and rolled back, each file gets its
// bytes back as they were.
function returnOwnRootParts(projectDir: string, yielded: readonly YieldedRootPart[], landed: boolean): void {
  for (const { path, part, bytes } of yielded) {
    const file = join(projectDir, path);
    if (!landed) {
      writeFileSync(file, bytes);
      continue;
    }
    let merged: string;
    try {
      merged = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let next: string | undefined;
    if ("entries" in part) {
      const withEntries = mergeJsonEntries(merged, part.entries, { kind: "none" });
      next = "conflict" in withEntries ? undefined : withEntries.text;
    } else {
      const kept = markedPart(path, bytes.toString("utf-8"), part.marker)?.block;
      const now = markedPart(path, merged, part.marker);
      if (!kept || now === null) continue;
      if (now.block === null) {
        const { begin, end } = managedBlockMarkers(path, part.marker);
        next = mergeBlock(path, merged, kept.slice(begin.length, kept.length - end.length), part.marker, part.legacy).value;
      } else {
        const at = merged.indexOf(now.block);
        next = `${merged.slice(0, at)}${kept}${merged.slice(at + now.block.length)}`;
      }
    }
    if (next !== undefined && next !== merged) writeFileSync(file, next);
  }
}

function conflictFiles(projectDir: string): string[] {
  const listed = git(projectDir, ["diff", "--name-only", "--diff-filter=U"]);
  return listed.ok
    ? listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
    : [];
}

function checkpointMainMetadata(
  projectDir: string,
  message: string,
): { parentOid: string; commitOid?: string } {
  const parentOid = gitOutput(
    projectDir,
    ["rev-parse", "HEAD"],
    "Cannot resolve metadata checkpoint parent",
  );
  const changed = worktreeChanges(projectDir, "all", "Cannot inspect main worktree");
  if (changed.length === 0) return { parentOid };
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) {
    fail("Cannot resolve active intent metadata for Unit landing.");
  }
  // AI-DLC's own part of a shared root file stays as it is, uncommitted.
  const own = aidlcOwnRootParts(projectDir, changed);
  const paths = changed.filter((path) => !own.has(path));
  const unsafe = paths.filter(
    (path) =>
      !isEngineMergeMetadata(projectDir, path, recordPrefix) &&
      path !== `${recordPrefix}/audit/${auditShardName(projectDir)}`,
  );
  if (unsafe.length > 0) {
    fail(
      `Unit landing requires a clean source worktree; commit or stash: ${unsafe.join(", ")}.`,
    );
  }
  if (paths.length === 0) return { parentOid };
  const added = git(projectDir, ["add", "-A", "--", ...paths]);
  if (!added.ok) {
    fail(
      `Failed to stage main engine metadata checkpoint: ${added.stderr.trim() || added.stdout.trim()}.`,
    );
  }
  const committed = git(projectDir, [
    "commit",
    "-m",
    message,
  ]);
  if (!committed.ok) {
    fail(`Failed to checkpoint main engine metadata: ${committed.stderr.trim() || committed.stdout.trim() || `exit ${committed.code}`}.`);
  }
  return {
    parentOid,
    commitOid: gitOutput(
      projectDir,
      ["rev-parse", "HEAD"],
      "Cannot resolve metadata checkpoint commit",
    ),
  };
}

function restoreMainMetadata(
  projectDir: string,
  paths: string[],
): void {
  const recordPrefix = relativeRecordDir(projectDir);
  for (const path of paths.filter((path) =>
    isEngineMergeMetadata(projectDir, path, recordPrefix)
  )) {
    if (gitPathExistsAt(projectDir, "HEAD", path)) {
      const restored = git(projectDir, ["checkout", "HEAD", "--", path]);
      if (!restored.ok) fail(`Failed to retain main metadata path ${path}.`);
      const added = git(projectDir, ["add", "--", path]);
      if (!added.ok) fail(`Failed to stage retained metadata path ${path}.`);
    } else {
      git(projectDir, ["rm", "-f", "--cached", "--ignore-unmatch", "--", path]);
      try {
        unlinkSync(join(projectDir, path));
      } catch {
        // Candidate-only metadata may already be absent.
      }
    }
  }
}

interface GitObjectRead {
  oid: string | null;
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  error?: string;
}

interface CandidateExactDetails {
  version: 1;
  phase: "pending-index" | "merge-commit";
  unit: string;
  generation: number;
  treeish: string;
  passed_pending_tree_oid?: string;
  main_parent_oid: string;
  pinned_oid: string;
  candidate_base_oid: string;
  violations: string[];
  boundary_violations: string[];
  unexpected_changes: string[];
  object_mismatches: Array<{
    path: string;
    expected_treeish: string;
    actual: GitObjectRead;
    expected: GitObjectRead;
  }>;
}

class CandidateExactPolicyError extends Error {
  constructor(message: string, readonly details: CandidateExactDetails) {
    super(message);
  }
}

function gitObjectAt(
  projectDir: string,
  oid: string,
  path: string,
): GitObjectRead {
  // Preserve the original lookup outcome: a later diagnostic read may succeed
  // after the failure, and must not replace what the policy actually compared.
  const result = spawnSync("git", ["rev-parse", "--verify", `${oid}:${path}`], {
    cwd: projectDir,
    encoding: "utf-8",
    env: { ...process.env },
  });
  return {
    oid: result.status === 0 ? (result.stdout ?? "").trim() : null,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message,
  };
}

function candidateChangedPaths(
  projectDir: string,
  transaction: UnitMergeTransaction,
): string[] {
  return gitOutput(
    projectDir,
    [
      "diff",
      "--name-only",
      `${transaction.candidate_base_oid}..${transaction.pinned_oid}`,
    ],
    "Cannot inspect pinned candidate diff",
  )
    .split(/\r?\n/)
    .filter(Boolean);
}

function mergeCommitParents(projectDir: string, commitOid: string): string[] {
  return gitOutput(
    projectDir,
    ["show", "-s", "--format=%P", commitOid],
    `Cannot inspect merge commit ${commitOid}`,
  )
    .split(/\s+/)
    .filter(Boolean);
}

function inspectLandedTree(
  projectDir: string,
  transaction: UnitMergeTransaction,
  treeish: string,
  mainParent: string,
): Omit<CandidateExactDetails, "phase"> {
  const candidatePaths = candidateChangedPaths(projectDir, transaction);
  const recordPrefix = relativeRecordDir(projectDir);
  const boundary = recordPrefix
    ? candidateBoundary(
        projectDir,
        transaction.candidate_base_oid,
        transaction.pinned_oid,
        recordPrefix,
        transaction.unit,
        transaction.generation,
        transaction.audit_shard,
      )
    : {
        violations: ["active intent record is unavailable"],
      };
  const carriedOnly = (path: string): boolean =>
    isCarriedReviewRecord(projectDir, path, recordPrefix, mainParent);
  const allowedCommitChanges = new Set(
    candidatePaths.filter((path) =>
      !isEngineMergeMetadata(projectDir, path, recordPrefix) && !carriedOnly(path)
    ),
  );
  const actualCommitChanges = gitOutput(
    projectDir,
    ["diff", "--name-only", `${mainParent}..${treeish}`],
    "Cannot inspect landed merge tree",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const unexpectedChanges = actualCommitChanges.filter((path) => !allowedCommitChanges.has(path));
  const violations = [...boundary.violations, ...unexpectedChanges];
  const objectMismatches: CandidateExactDetails["object_mismatches"] = [];
  for (const path of candidatePaths) {
    const actual = gitObjectAt(projectDir, treeish, path);
    const expectedTreeish = isEngineMergeMetadata(projectDir, path, recordPrefix) || carriedOnly(path)
      ? mainParent
      : transaction.pinned_oid;
    const expected = gitObjectAt(projectDir, expectedTreeish, path);
    if (actual.oid !== expected.oid) {
      violations.push(path);
      objectMismatches.push({ path, expected_treeish: expectedTreeish, actual, expected });
    }
  }
  return {
    version: 1,
    unit: transaction.unit,
    generation: transaction.generation,
    treeish,
    main_parent_oid: mainParent,
    pinned_oid: transaction.pinned_oid,
    candidate_base_oid: transaction.candidate_base_oid,
    violations: [...new Set(violations)].sort(),
    boundary_violations: boundary.violations,
    unexpected_changes: unexpectedChanges,
    object_mismatches: objectMismatches,
  };
}

function assertLandCandidateBoundary(
  projectDir: string,
  transaction: UnitMergeTransaction,
): void {
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) {
    fail("Cannot resolve the active intent record for Unit landing.");
  }
  const boundary = candidateBoundary(
    projectDir,
    transaction.candidate_base_oid,
    transaction.pinned_oid,
    recordPrefix,
    transaction.unit,
    transaction.generation,
    transaction.audit_shard,
  );
  if (boundary.violations.length > 0) {
    fail(
      `Unit "${transaction.unit}" landing violates claimed Unit ownership at: ${
        boundary.violations.join(", ")
      }.`,
    );
  }
}

function validateLandedMerge(
  projectDir: string,
  transaction: UnitMergeTransaction,
  commitOid: string,
  target: string,
): void {
  const branch = gitOutput(
    projectDir,
    ["branch", "--show-current"],
    "Cannot resolve landing branch",
  );
  if (branch !== target) {
    fail(`Unit landing expected branch "${target}", found "${branch}".`);
  }
  if (
    !git(
      projectDir,
      ["merge-base", "--is-ancestor", commitOid, "HEAD"],
    ).ok
  ) {
    fail(`Recorded Unit merge commit ${commitOid} is not on ${target}.`);
  }
  const parents = mergeCommitParents(projectDir, commitOid);
  if (parents.length < 2 || parents[1] !== transaction.pinned_oid) {
    fail(
      `Unit "${transaction.unit}" landing is not a controlled merge of pinned OID ${transaction.pinned_oid}.`,
    );
  }
  const mainParent = parents[0];
  const inspection = inspectLandedTree(
    projectDir,
    transaction,
    commitOid,
    mainParent,
  );
  if (inspection.violations.length > 0) {
    throw new CandidateExactPolicyError(
      `Unit "${transaction.unit}" merge commit violates candidate-exact policy at: ${inspection.violations.join(", ")}.`,
      { ...inspection, phase: "merge-commit" },
    );
  }
}

// The merge commit of the pinned candidate on HEAD's first-parent line since
// pin, or null when there is none. Undefined when the history cannot be read.
function firstParentMergeOf(
  projectDir: string,
  transaction: UnitMergeTransaction,
): string | null | undefined {
  const history = git(
    projectDir,
    [
      "log",
      "--first-parent",
      "--format=%H%x00%P",
      `${transaction.main_before_oid}..HEAD`,
    ],
  );
  if (!history.ok) return undefined;
  for (const line of history.stdout.split(/\r?\n/).filter(Boolean)) {
    const [commitOid, parentText = ""] = line.split("\u0000");
    const parents = parentText.split(/\s+/).filter(Boolean);
    if (parents[1] === transaction.pinned_oid) return commitOid;
  }
  return null;
}

function recoveredMergeCommit(
  projectDir: string,
  transaction: UnitMergeTransaction,
  target: string,
): string | null {
  const commitOid = firstParentMergeOf(projectDir, transaction);
  if (!commitOid) return null;
  validateLandedMerge(projectDir, transaction, commitOid, target);
  return commitOid;
}

function metadataCheckpointAtHead(
  projectDir: string,
  unit: string,
): { parentOid: string; commitOid: string } | null {
  const commitOid = gitOutput(
    projectDir,
    ["rev-parse", "HEAD"],
    "Cannot inspect metadata checkpoint",
  );
  const subject = gitOutput(
    projectDir,
    ["show", "-s", "--format=%s", commitOid],
    "Cannot inspect metadata checkpoint subject",
  );
  if (subject !== `Checkpoint Unit ${unit} merge gate`) return null;
  const parents = mergeCommitParents(projectDir, commitOid);
  if (parents.length !== 1) return null;
  const paths = gitOutput(
    projectDir,
    ["diff", "--name-only", `${parents[0]}..${commitOid}`],
    "Cannot inspect metadata checkpoint paths",
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const recordPrefix = relativeRecordDir(projectDir);
  if (!recordPrefix) return null;
  if (
    paths.length === 0 ||
    paths.some(
      (path) =>
        !isEngineMergeMetadata(projectDir, path, recordPrefix) &&
        !isActiveIntentAuditPath(path, recordPrefix),
    )
  ) {
    return null;
  }
  return { parentOid: parents[0], commitOid };
}

function validateMetadataCheckpoint(
  projectDir: string,
  transaction: UnitMergeTransaction,
): void {
  if (!transaction.checkpoint_commit_oid) return;
  const checkpoint = metadataCheckpointAtHead(projectDir, transaction.unit);
  if (
    !checkpoint ||
    checkpoint.commitOid !== transaction.checkpoint_commit_oid ||
    checkpoint.parentOid !== transaction.checkpoint_parent_oid
  ) {
    fail(`Unit "${transaction.unit}" metadata checkpoint is invalid.`);
  }
}

function rollbackMetadataCheckpoint(
  projectDir: string,
  transaction: UnitMergeTransaction,
): UnitMergeTransaction {
  if (
    transaction.checkpoint_commit_oid &&
    transaction.checkpoint_parent_oid &&
    gitOutput(projectDir, ["rev-parse", "HEAD"], "Cannot inspect checkpoint HEAD") ===
      transaction.checkpoint_commit_oid
  ) {
    validateMetadataCheckpoint(projectDir, transaction);
    const reset = git(
      projectDir,
      ["reset", "--mixed", transaction.checkpoint_parent_oid],
    );
    if (!reset.ok) {
      fail(`Failed to restore pre-merge metadata checkpoint: ${reset.stderr.trim()}.`);
    }
  }
  return {
    ...transaction,
    checkpoint_parent_oid: undefined,
    checkpoint_commit_oid: undefined,
  };
}

function landGit(
  projectDir: string,
  transaction: UnitMergeTransaction,
  target: string,
): UnitMergeTransaction {
  assertLandCandidateBoundary(projectDir, transaction);
  if (transaction.git_commit_oid) {
    validateLandedMerge(
      projectDir,
      transaction,
      transaction.git_commit_oid,
      target,
    );
    return transaction;
  }
  const recovered = recoveredMergeCommit(projectDir, transaction, target);
  if (recovered) {
    return {
      ...transaction,
      status: "git-landed",
      target_branch: target,
      strategy: "merge",
      git_commit_oid: recovered,
    };
  }
  currentPinnedClaim(projectDir, transaction);
  const branch = gitOutput(
    projectDir,
    ["branch", "--show-current"],
    "Cannot resolve main branch",
  );
  if (branch !== target) {
    fail(`Unit landing expected branch "${target}", found "${branch}".`);
  }
  let working = transaction;
  if (!working.checkpoint_commit_oid) {
    const recoveredCheckpoint = metadataCheckpointAtHead(
      projectDir,
      transaction.unit,
    );
    if (recoveredCheckpoint) {
      working = {
        ...working,
        checkpoint_parent_oid: recoveredCheckpoint.parentOid,
        checkpoint_commit_oid: recoveredCheckpoint.commitOid,
      };
      writeUnitMergeTransaction(projectDir, working);
    }
  } else {
    validateMetadataCheckpoint(projectDir, working);
  }
  const existingMergeHead = git(
    projectDir,
    ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
  );
  if (!existingMergeHead.ok) {
    if (working.checkpoint_commit_oid) {
      const head = gitOutput(
        projectDir,
        ["rev-parse", "HEAD"],
        "Cannot inspect metadata checkpoint",
      );
      if (head !== working.checkpoint_commit_oid) {
        fail("Unit merge metadata checkpoint no longer matches HEAD.");
      }
    } else {
      const checkpoint = checkpointMainMetadata(
        projectDir,
        `Checkpoint Unit ${transaction.unit} merge gate`,
      );
      working = {
        ...working,
        checkpoint_parent_oid: checkpoint.parentOid,
        checkpoint_commit_oid: checkpoint.commitOid,
      };
      writeUnitMergeTransaction(projectDir, working);
    }
  } else if (existingMergeHead.stdout.trim() !== transaction.pinned_oid) {
    fail("Another git merge is already in progress.");
  }
  const changed = candidateChangedPaths(projectDir, transaction);
  const yielded: YieldedRootPart[] = [];
  let landed = false;
  try {
    if (!existingMergeHead.ok) yieldOwnRootParts(projectDir, changed, yielded);
    const merged = existingMergeHead.ok
      ? { ok: true, stdout: "", stderr: "", code: 0 }
      : git(
        projectDir,
        ["merge", "--no-commit", "--no-ff", transaction.pinned_oid],
      );
    restoreMainMetadata(projectDir, changed);
    const landingRecordPrefix = relativeRecordDir(projectDir);
    for (const path of changed.filter((path) =>
      isCarriedReviewRecord(projectDir, path, landingRecordPrefix, "HEAD")
    )) {
      const dropped = git(projectDir, ["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
      if (!dropped.ok) fail(`Failed to leave the review record ${path} out of the merge: ${dropped.stderr.trim()}.`);
    }
    const conflicts = conflictFiles(projectDir).filter(
      (path) => !isEngineMergeMetadata(projectDir, path),
    );
    if (conflicts.length > 0) {
      git(projectDir, ["merge", "--abort"]);
      working = rollbackMetadataCheckpoint(projectDir, working);
      writeUnitMergeTransaction(projectDir, {
        ...working,
        conflict_files: conflicts,
      });
      fail(`Unit "${transaction.unit}" source conflicts: ${conflicts.join(", ")}.`);
    }
    if (!merged.ok && !git(projectDir, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).ok) {
      working = rollbackMetadataCheckpoint(projectDir, working);
      writeUnitMergeTransaction(projectDir, working);
      fail(`Pinned git merge failed: ${merged.stderr.trim() || merged.stdout.trim()}.`);
    }
    const pendingTree = gitOutput(
      projectDir,
      ["write-tree"],
      "Cannot materialize pending Unit merge tree",
    );
    const mainParent = gitOutput(
      projectDir,
      ["rev-parse", "HEAD"],
      "Cannot resolve pending Unit merge parent",
    );
    const inspection = inspectLandedTree(
      projectDir,
      working,
      pendingTree,
      mainParent,
    );
    if (inspection.violations.length > 0) {
      git(projectDir, ["merge", "--abort"]);
      working = rollbackMetadataCheckpoint(projectDir, working);
      writeUnitMergeTransaction(projectDir, {
        ...working,
        conflict_files: inspection.violations,
      });
      throw new CandidateExactPolicyError(
        `Unit "${transaction.unit}" candidate-exact merge policy refused auto-merged paths: ` +
          `${inspection.violations.join(", ")}. Rebase onto the current target and republish.`,
        { ...inspection, phase: "pending-index" },
      );
    }
    const committed = git(projectDir, [
      "commit",
      "--no-edit",
      "-m",
      `Merge Unit ${transaction.unit} @ ${transaction.pinned_oid.slice(0, 12)}`,
    ]);
    if (!committed.ok) {
      git(projectDir, ["merge", "--abort"]);
      working = rollbackMetadataCheckpoint(projectDir, working);
      writeUnitMergeTransaction(projectDir, working);
      fail(`Pinned git merge commit failed: ${committed.stderr.trim() || committed.stdout.trim() || `exit ${committed.code}`}.`);
    }
    const commitOid = gitOutput(
      projectDir,
      ["rev-parse", "HEAD"],
      "Cannot resolve landed merge commit",
    );
    try {
      validateLandedMerge(projectDir, working, commitOid, target);
    } catch (error) {
      if (error instanceof CandidateExactPolicyError) {
        error.details.passed_pending_tree_oid = pendingTree;
      }
      const reset = git(projectDir, ["reset", "--hard", mainParent]);
      if (!reset.ok) {
        fail(
          `Unit merge validation failed and rollback also failed: ${errorMessage(error)}; ${reset.stderr.trim()}.`,
        );
      }
      working = rollbackMetadataCheckpoint(projectDir, working);
      writeUnitMergeTransaction(projectDir, working);
      throw error;
    }
    landed = true;
    return {
      ...working,
      status: "git-landed",
      target_branch: target,
      strategy: "merge",
      git_commit_oid: commitOid,
      conflict_files: undefined,
    };
  } finally {
    returnOwnRootParts(projectDir, yielded, landed);
  }
}

// Why main has no Unit stages left to record a landed Unit in, or null while
// it has: a forward jump on main skips every Unit stage (functional-design to
// code-generation, say) for every Unit at once.
function unitStagesSkippedOnMain(
  projectDir: string,
  transaction: UnitMergeTransaction,
): string | null {
  const state = readStateFile(projectDir);
  if (unitMajorConstructionStageSlugs(getField(state, "Scope") ?? "", state, true).length > 0) {
    return null;
  }
  const stages = transaction.evidence.stages_expected;
  const span = stages.length > 1 ? `${stages[0]} to ${stages[stages.length - 1]}` : stages.join("");
  const at = getField(state, "Current Stage")?.trim();
  return `main skipped the Unit stages (${span})${at ? ` when it moved on to ${at}` : ""}, ` +
    "so there is nothing on main to record the Unit in";
}

function runStateFold(
  projectDir: string,
  transaction: UnitMergeTransaction,
): void {
  // A compiled install has no aidlc-state.ts beside this module: its URL is
  // inside the bundle, and process.execPath is the aidlc binary, which reads a
  // script path as an unknown command. Route the fold through `engine state`
  // there, as the orchestrator's spawnState does, and like it use only this
  // process's own identity, never an executable supplied through the
  // environment, since the child inherits the unit-merge owner token (#1286).
  const [command, ...args] = aidlcEngineCommand(
    "state",
    [
      "fold-unit-merge",
      "--unit",
      transaction.unit,
      "--pinned-oid",
      transaction.pinned_oid,
      "--generation",
      String(transaction.generation),
      "--project-dir",
      projectDir,
    ],
    join(dirname(fileURLToPath(import.meta.url)), "aidlc-state.ts"),
    isCompiledExecutable() ? process.execPath : null,
  );
  const result = spawnSync(
    command,
    args,
    {
      cwd: projectDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        AIDLC_STATE_TRANSITION_OWNER: `unit-merge:${process.pid}`,
      },
    },
  );
  if (result.status !== 0) {
    fail(`Unit state fold failed: ${(result.stderr || result.stdout).trim()}.`);
  }
}

function validateMergeRiskAcknowledgment(
  projectDir: string,
  unit: string,
  userInput: string | undefined,
): string {
  const answer = userInput?.trim();
  if (!answer) {
    fail(
      `Unit "${unit}" released-attempt recovery requires --user-input <human acknowledgment>.`,
    );
  }
  if (!humanPresenceGuardDisabled() && isNonAnswer(answer)) {
    fail(
      `Refusing Unit "${unit}" released-attempt recovery: --user-input "${answer}" is cancellation boilerplate.`,
    );
  }
  if (!humanPresenceGuardDisabled()) {
    const all = mainAuthorityAuditRows(projectDir);
    const floor = all.findLastIndex(
      (row) =>
        row.event === "GATE_APPROVED" ||
        row.event === "GATE_REJECTED" ||
        (
          row.event === "RECOVERY_COMPLETED" &&
          auditBlockField(row.block, "Recovery") ===
            "unit-merge-released-attempt"
        ),
    );
    if (!all.slice(floor + 1).some((row) => row.event === "HUMAN_TURN")) {
      fail(
        `Unit "${unit}" released-attempt recovery requires a fresh typed human turn from main's audit shard.`,
      );
    }
  }
  return answer;
}

function recordReleasedAfterGitAcceptance(
  projectDir: string,
  transaction: UnitMergeTransaction,
  tombstone: UnitClaimView,
  userInput: string,
): UnitMergeTransaction {
  if (
    transaction.released_after_git?.tombstone_oid === tombstone.oid &&
    transaction.released_after_git.tombstone_generation ===
      tombstone.generation
  ) {
    return transaction;
  }
  appendAuditEntry(
    "RECOVERY_COMPLETED",
    {
      Recovery: "unit-merge-released-attempt",
      Unit: transaction.unit,
      "Pinned OID": transaction.pinned_oid,
      "Attempt Generation": String(transaction.generation),
      "Tombstone OID": tombstone.oid,
      "Tombstone Generation": String(tombstone.generation),
      "User Input": userInput,
      Details:
        "Human accepted completion of the already-landed merge after the exact claim attempt was tombstoned.",
    },
    projectDir,
  );
  const updated: UnitMergeTransaction = {
    ...transaction,
    released_after_git: {
      accepted_at: isoTimestamp(),
      user_input: userInput,
      tombstone_oid: tombstone.oid,
      tombstone_generation: tombstone.generation,
    },
  };
  writeUnitMergeTransaction(projectDir, updated);
  updateCachedClaim(projectDir, tombstone);
  return updated;
}

function landUnit(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  const step = flags.step ?? "all";
  const acceptReleasedAttempt =
    flags["accept-released-attempt"] === "true";
  if (
    !unit ||
    !["git", "state", "audit", "all"].includes(step) ||
    (flags.strategy !== undefined && flags.strategy !== "merge")
  ) {
    fail(
      "Usage: aidlc-unit land <unit> [--step git|state|audit|all] [--target <branch>] " +
        "[--strategy merge] [--accept-released-attempt --user-input <human acknowledgment>]",
    );
  }
  const pd = resolveProjectDir(projectDir);
  assertMainCheckout(pd);
  const existing = readUnitMergeTransaction(pd, unit);
  if (!existing || !["approved", "git-landed", "state-folded", "complete"].includes(existing.status)) {
    fail(`Unit "${unit}" merge is not approved.`);
  }
  let transaction: UnitMergeTransaction = existing;
  let claimCheck: PinnedClaimCheck | null = null;
  assertTransactionIdentity(pd, transaction);
  if (acceptReleasedAttempt && transaction.status !== "git-landed") {
    fail(
      `Unit "${unit}" --accept-released-attempt applies only after the git step landed and before state folding.`,
    );
  }
  if (
    transaction.status === "approved" ||
    transaction.status === "git-landed"
  ) {
    claimCheck = currentPinnedClaim(pd, transaction, {
      acceptReleasedAttempt,
    });
    if (
      claimCheck.releasedTombstone &&
      !transaction.released_after_git
    ) {
      const userInput = validateMergeRiskAcknowledgment(
        pd,
        unit,
        flags["user-input"],
      );
      transaction = recordReleasedAfterGitAcceptance(
        pd,
        transaction,
        claimCheck.releasedTombstone,
        userInput,
      );
    }
  }
  const gate = mergeGateRecord(pd, transaction);
  if (gate?.decision !== "approve") {
    fail(`Unit "${unit}" has no current approved merge-gate receipt.`);
  }
  if (gate.strategy !== "merge" || !gate.target) {
    fail(`Unit "${unit}" approved merge gate has invalid strategy or target evidence.`);
  }
  const target =
    flags.target ?? gate.target;
  if (
    target !== gate.target
  ) {
    fail(
      `Unit "${unit}" merge gate approved target "${gate.target}", not "${target}".`,
    );
  }
  transaction = {
    ...transaction,
    target_branch: gate.target,
    strategy: "merge",
  };
  if (transaction.evidence.merge_held) {
    fail(
      `Unit "${unit}" merge is held. Resolve the existing HOLD-MERGE flow in the team checkout, publish, and re-pin.`,
    );
  }
  const runGitStep = step === "git" || step === "all";
  const runStateStep = step === "state" || step === "all";
  const runAuditStep = step === "audit" || step === "all";
  if (step === "state" && transaction.status === "approved") {
    fail(`Unit "${unit}" git step has not landed.`);
  }
  if (
    step === "audit" &&
    !["state-folded", "complete"].includes(transaction.status)
  ) {
    fail(`Unit "${unit}" state step has not folded.`);
  }
  if (runGitStep && transaction.status === "approved") {
    // The state step records the Unit in main's Unit stages; with none left
    // (a forward jump on main skipped them), merging would leave a merge on
    // main that nothing records, so nothing is merged.
    const skipped = unitStagesSkippedOnMain(pd, transaction);
    if (skipped) {
      fail(
        `Unit "${unit}" was not merged: ${skipped}. Its pin and your merge approval stay as they are; ` +
          `main takes Units in again once it is back on ${transaction.evidence.stages_expected[0]}, ` +
          "and going back starts the Unit stages again on main.",
      );
    }
    if (!claimCheck) {
      fail(`Unit "${unit}" git landing has no current pinned-claim evidence.`);
    }
    const liveIntegration = fetchIntegration(pd);
    const landingBranch = currentBranch(pd);
    if (landingBranch !== target) {
      fail(`Unit landing expected branch "${target}", found "${landingBranch}".`);
    }
    const landingHead = gitOutput(
      pd,
      ["rev-parse", "HEAD"],
      "Cannot resolve local landing target",
    );
    if (
      !git(
        pd,
        ["merge-base", "--is-ancestor", liveIntegration.oid, landingHead],
      ).ok
    ) {
      fail(
        `Unit "${unit}" local target "${target}" is stale: fetched ` +
          `${liveIntegration.ref} at ${liveIntegration.oid}, but local HEAD is ` +
          `${landingHead}. Fast-forward or rebase "${target}", then re-run landing.`,
      );
    }
    const liveEvidence = candidateEvidence(
      pd,
      claimCheck.claim,
      transaction.candidate_base_oid,
      landingHead,
    );
    if (JSON.stringify(liveEvidence) !== JSON.stringify(transaction.evidence)) {
      fail(
        `Unit "${unit}" live integration evidence changed after merge approval; ` +
          `run aidlc unit pin ${unit} again and obtain a new merge gate.`,
      );
    }
    transaction = landGit(pd, transaction, target);
    writeUnitMergeTransaction(pd, transaction);
  }
  if (
    runStateStep &&
    ["git-landed", "state-folded"].includes(transaction.status)
  ) {
    if (!transaction.git_commit_oid) {
      fail(`Unit "${unit}" has no validated git landing commit.`);
    }
    validateLandedMerge(
      pd,
      transaction,
      transaction.git_commit_oid,
      target,
    );
    const skipped = unitStagesSkippedOnMain(pd, transaction);
    if (skipped) {
      fail(
        `Unit "${unit}" is merged into main at ${transaction.git_commit_oid}, but not recorded yet: ${skipped}. ` +
          `Run aidlc unit land ${unit} again once main is back on ${transaction.evidence.stages_expected[0]}.`,
      );
    }
    const liveState = readStateFile(pd);
    const liveStageColumns = unitMajorConstructionStageSlugs(
      getField(liveState, "Scope") ?? "",
      liveState,
      true,
    );
    transaction = {
      ...transaction,
      live_stage_columns: liveStageColumns,
      state_fold_authorized:
        transaction.state_fold_authorized ??
          (
            claimCheck
              ? {
                  authorized_at: isoTimestamp(),
                  mode: claimCheck.releasedTombstone
                    ? "released-after-git"
                    : "live-claim",
                  observed_oid:
                    claimCheck.releasedTombstone?.oid ??
                    claimCheck.claim.oid,
                  owner: claimCheck.claim.owner,
                }
              : transaction.state_fold_authorized
          ),
    };
    if (!transaction.state_fold_authorized) {
      fail(
        `Unit "${unit}" state fold has no current land-bound claim authorization.`,
      );
    }
    writeUnitMergeTransaction(pd, transaction);
    runStateFold(pd, transaction);
    transaction = { ...transaction, status: "state-folded" };
    writeUnitMergeTransaction(pd, transaction);
  }
  if (runAuditStep && transaction.status !== "complete") {
    if (!unitMergedReceipts(pd).has(unit)) {
      fail(`Unit "${unit}" state fold has no current-generation UNIT_MERGED receipt.`);
    }
    if (!mainUnitRowMerged(pd, transaction)) {
      fail(`Unit "${unit}" state fold has not applied the authoritative merged row.`);
    }
    checkpointMainMetadata(
      pd,
      `Finalize Unit ${unit} merge metadata`,
    );
    transaction = { ...transaction, status: "complete" };
    writeUnitMergeTransaction(pd, transaction);
  }
  // A landing the remote does not have yet: the next step offers the push, in
  // this turn, so the other teams see it (landedNotOnRemote owns when).
  const pushDue = transaction.status === "complete" &&
    landedNotOnRemote(pd).some((landed) => landed.unit === unit);
  console.log(JSON.stringify({
    landed: transaction.status === "complete",
    status: transaction.status,
    unit,
    pinned_oid: transaction.pinned_oid,
    git_commit_oid: transaction.git_commit_oid ?? null,
    ...(pushDue
      ? { next_step: `Then run \`${aidlcToolInvocation("orchestrate")} next\` and follow the step it returns.` }
      : {}),
  }));
}

function assertMainCheckout(projectDir: string): void {
  const top = git(projectDir, ["rev-parse", "--show-toplevel"]);
  const common = git(projectDir, ["rev-parse", "--git-common-dir"]);
  if (!top.ok || !common.ok) fail("Cannot resolve the main git checkout.");
  const topReal = realpathSync(top.stdout.trim());
  const commonAbs = resolve(topReal, common.stdout.trim());
  const mainReal = realpathSync(dirname(commonAbs));
  if (topReal !== mainReal) {
    fail(`This command must run from the unscoped main checkout, not sibling worktree ${topReal}.`);
  }
}

function validateClaimRefUnit(intentId8: string, unit: string): void {
  const ref = claimRef(intentId8, unit);
  const checked = spawnSync("git", ["check-ref-format", ref], {
    encoding: "utf-8",
  });
  if (checked.status !== 0) {
    fail(
      `Unit "${unit}" is not claim-ref safe; avoid '..', '.lock' endings, ` +
        "leading dots, and other git-ref-reserved forms.",
    );
  }
}

// A team's revised Unit plan (Units Generation's units block) against what the
// team already did. Every name must be able to be a claim ref, and with the
// walking skeleton on the built skeleton stays the Unit built first: a plan that
// breaks either is repaired. A Unit that landed or is claimed keeps its name,
// since its receipts, row and claim are read by name; dropping or renaming one is
// the person's call, so their own request (personAsked) lifts that check, and
// `lifted` says it did. The first problem as the step that fixes the plan
// (`liftable` when the person's request would lift it); message null when the
// plan holds.
export function unitPlanRefusal(
  projectDir: string,
  personAsked = false,
): { message: string | null; liftable: boolean; lifted: boolean } {
  let lifted = false;
  const refuse = (message: string, liftable = false) => ({ message, liftable, lifted });
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) return { message: null, liftable: false, lifted };
  const parsed = parseBoltDag(readFileSync(unitDependencyPath(pd), "utf-8"));
  if (!parsed.ok) return { message: null, liftable: false, lifted };
  const planned = new Set(parsed.units.map((edge) => edge.name));
  const identity = activeIdentity(pd);
  for (const unit of planned) {
    try {
      validateClaimRefUnit(identity.intentId8, unit);
    } catch (e) {
      return refuse(`${errorMessage(e)} Rename it in the units block.`);
    }
  }
  const completed = completedUnits(state);
  const leftOut = (unitProgressTable(state)?.rows.map((cells) => cells[0]) ?? [])
    .filter((name) => !planned.has(name)).sort();
  for (const unit of leftOut) {
    if (!completed.has(unit)) continue;
    if (personAsked) {
      lifted = true;
      continue;
    }
    return refuse(
      `Unit "${unit}" has landed on main, and the revised plan leaves it out. A landed Unit's work, row and ` +
        `receipts are read by its name, so keep "${unit}" in the units block under that name.`,
      true,
    );
  }
  // The claims are read only for a Unit the plan leaves out: a plan that keeps
  // every Unit asks nothing of the claim registry.
  let claims: Map<string, UnitClaimView> = new Map();
  if (leftOut.length > 0) {
    try {
      claims = allClaims(pd, repositoryRemote(pd), identity.intentId8, leftOut);
    } catch {
      // Claims that cannot be read here are read again at the next claim.
    }
  }
  for (const [unit, claim] of [...claims].sort(([a], [b]) => a.localeCompare(b))) {
    if (claim.status !== "claimed") continue;
    if (personAsked) {
      lifted = true;
      continue;
    }
    return refuse(
      `Unit "${unit}" is claimed by ${claim.owner} (attempt ${claim.generation}), and the revised plan leaves ` +
        `it out. Keep "${unit}" in the units block under that name while it is claimed, or release the claim ` +
        `first from main, which ends ${claim.owner}'s claim on it: ` +
        `\`${aidlcInvocation()} unit release ${quoteCommandArgument(unit)}\`.`,
      true,
    );
  }
  const roots = parsed.batches[0] ?? [];
  const built = roots.find((name) => completed.has(name));
  if (teamSkeletonOn(state) && built !== undefined && roots[0] !== built) {
    return refuse(
      `Unit "${roots[0]}" depends on nothing and its name sorts before "${built}", so it would take over as the ` +
        `walking skeleton, which "${built}" already is and has built. Add "${built}" to "${roots[0]}"'s depends_on: ` +
        "every Unit waits on the walking skeleton anyway.",
    );
  }
  return { message: null, liftable: false, lifted };
}

function claimOwnerLabel(projectDir: string, supplied?: string): string {
  const owner =
    supplied?.trim() ||
    gitUserName(projectDir) ||
    "team";
  if (/[\r\n|]/.test(owner)) {
    fail("Team labels cannot contain pipes or newlines.");
  }
  return owner;
}

function finalizeClaimCheckout(
  projectDir: string,
  stamp: UnitScopeStamp,
  claim: UnitClaimView,
): void {
  stamp.claim_oid = claim.oid;
  stamp.audit_shard = claim.payload.audit_shard;
  writeUnitScopeStamp(projectDir, stamp);
  writeClaimGeneration(projectDir, stamp.unit, stamp.generation);
  ensureCloneId(projectDir);
  updateCachedClaim(projectDir, claim);
  startClaimLocalRecord(projectDir);
}

interface PendingRelease {
  version: 1;
  status: "pending" | "released";
  intent_uuid: string;
  unit: string;
  claim_generation: number;
  claim_nonce: string;
  release_nonce: string;
  released_generation?: number;
  released_oid?: string;
}

function readPendingRelease(
  projectDir: string,
  unit: string,
  identity: ReturnType<typeof activeIdentity>,
): PendingRelease | null {
  try {
    const parsed = JSON.parse(
      readFileSync(
        unitReleasePendingPath(
          projectDir,
          unit,
          identity.space,
          identity.intentUuid,
        ),
        "utf-8",
      ),
    ) as Partial<PendingRelease>;
    if (
      parsed.version !== 1 ||
      (parsed.status !== "pending" && parsed.status !== "released") ||
      typeof parsed.intent_uuid !== "string" ||
      typeof parsed.unit !== "string" ||
      !Number.isInteger(parsed.claim_generation) ||
      typeof parsed.claim_nonce !== "string" ||
      typeof parsed.release_nonce !== "string"
    ) {
      return null;
    }
    return parsed as PendingRelease;
  } catch {
    return null;
  }
}

function writePendingRelease(
  projectDir: string,
  identity: ReturnType<typeof activeIdentity>,
  pending: PendingRelease,
): void {
  const path = unitReleasePendingPath(
    projectDir,
    pending.unit,
    identity.space,
    identity.intentUuid,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(pending, null, 2)}\n`,
    "utf-8",
  );
}

function adoptUnit(args: string[], projectDir?: string): void {
  const { positional } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit adopt <unit>");
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit adoption requires Unit Ownership: team.");
  const identity = activeIdentity(pd);
  const ref = claimRef(identity.intentId8, unit);
  const branch = gitOutput(
    pd,
    ["symbolic-ref", "--quiet", "HEAD"],
    "Unit adoption requires the checked-out local claim branch",
  );
  if (branch !== ref) {
    fail(`Unit adoption requires checked-out branch "${ref}", found "${branch}".`);
  }
  const existing = readUnitScopeStamp(pd);
  if (existing && existing.unit !== unit && !scopeStampLanded(pd, state, existing)) {
    fail(`This checkout is already scoped to Unit "${existing.unit}".`);
  }
  const claim = currentClaim(pd, repositoryRemote(pd), ref);
  if (
    claim?.status !== "claimed" ||
    claim.payload.space !== identity.space ||
    claim.payload.intent_uuid !== identity.intentUuid ||
    claim.payload.intent_id8 !== identity.intentId8 ||
    claim.payload.unit !== unit ||
    claim.payload.claim_ref !== ref ||
    !claim.payload.audit_shard ||
    !/^[A-Za-z0-9._-]+\.md$/.test(claim.payload.audit_shard)
  ) {
    fail(`Unit "${unit}" checked-out claim identity or audit shard is invalid.`);
  }
  const head = gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve checked-out claim");
  if (head !== claim.oid) {
    fail(`Unit adoption requires HEAD at live claim OID ${claim.oid}.`);
  }
  const checkedOut = readPayload(pd, head, { localOnly: true });
  if (
    !checkedOut ||
    checkedOut.nonce !== claim.nonce ||
    checkedOut.generation !== claim.generation ||
    checkedOut.audit_shard !== claim.payload.audit_shard
  ) {
    fail(`Unit "${unit}" checked-out claim payload does not match the live claim ref.`);
  }
  const stamp: UnitScopeStamp = {
    version: 1,
    space: identity.space,
    intent_uuid: identity.intentUuid,
    intent_id8: identity.intentId8,
    unit,
    owner: claim.owner,
    generation: claim.generation,
    nonce: claim.nonce,
    claim_ref: ref,
    claim_oid: claim.oid,
    claimed_from_oid: claim.payload.base_oid,
    integration_ref: claim.payload.integration_ref,
    gate_rhythm: claim.payload.gate_rhythm,
    audit_shard: claim.payload.audit_shard,
  };
  // The owner's local record comes over with the claim: the claim's second
  // parent (the handover publish built) carries it beside the owner's commit,
  // never in the candidate tree. A claim published before the local record
  // existed carries the owner's whole shard there instead. This checkout's own
  // rows stay, and the handed-over rows it lacks join them.
  const recordPrefix = relativeRecordDir(pd);
  if (claim.payload.candidate_head_oid && recordPrefix) {
    const localPath = `${recordPrefix}/${ENGINE_DIR}/audit/${claim.payload.audit_shard}`;
    for (const path of [localPath, `${recordPrefix}/audit/${claim.payload.audit_shard}`]) {
      const handedOver = git(pd, ["show", `${claim.oid}^2:${path}`, "--"]);
      if (!handedOver.ok) continue;
      takeHandedOverAuditRows(pd, join(pd, ...localPath.split("/")), handedOver.stdout);
      break;
    }
  }
  finalizeClaimCheckout(pd, stamp, claim);
  console.log(JSON.stringify({ adopted: true, ...stamp }));
}

function claimUnit(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit claim <unit> [--team <label>] [--rhythm per-stage|unit-end]");
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  if (
    flags.rhythm !== undefined &&
    flags.rhythm !== "per-stage" &&
    flags.rhythm !== "unit-end"
  ) {
    fail(`Invalid --rhythm "${flags.rhythm}"; expected per-stage or unit-end.`);
  }
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit claims require Unit Ownership: team.");
  const identity = activeIdentity(pd);
  validateClaimRefUnit(identity.intentId8, unit);
  const existingStamp = readUnitScopeStamp(pd);
  if (existingStamp && scopeStampLanded(pd, state, existingStamp)) {
    clearUnitScopeStamp(pd);
  } else if (existingStamp) {
    if (existingStamp.unit !== unit) {
      fail(`This checkout is already scoped to Unit "${existingStamp.unit}".`);
    }
    const recovered = currentClaim(
      pd,
      repositoryRemote(pd),
      existingStamp.claim_ref,
    );
    if (
      recovered?.status === "claimed" &&
      recovered.payload.intent_uuid === identity.intentUuid &&
      recovered.unit === unit &&
      recovered.generation === existingStamp.generation &&
      recovered.nonce === existingStamp.nonce
    ) {
      finalizeClaimCheckout(pd, existingStamp, recovered);
      console.log(JSON.stringify({ claimed: true, recovered: true, ...existingStamp }));
      return;
    }
    clearUnitScopeStamp(pd);
  }
  const integration = fetchIntegration(pd);
  // Main back before the per-Unit block is changing the Unit plan: the claim
  // goes ahead on the plan as it stands there, and its result says the risk once.
  const integrationStage = getField(stateAtOid(pd, integration.oid), "Current Stage")?.trim() ?? "";
  const graph = loadStageGraph();
  const planWarning = beforePerUnitBlock(graph, integrationStage)
    ? `Main is changing the Unit plan (${graph.find((node) => node.slug === integrationStage)?.name ?? integrationStage} ` +
      `is open again on ${integration.remote ? `${integration.remote}/${integration.branch}` : integration.branch}), ` +
      `so "${unit}" is claimed on the plan as it stands there: if the approved plan changes "${unit}"'s own entry, ` +
      "pin asks this checkout to rebase onto main and publish again."
    : null;
  const opening = openingStatus(pd, integration.oid);
  if (!opening.units.includes(unit)) fail(`Unit "${unit}" is not in the authoritative Unit DAG.`);
  if (opening.completed.has(unit)) {
    fail(`Unit "${unit}" is already complete on the integration ref.`);
  }
  const blockers = opening.blockers.get(unit) ?? [];
  if (blockers.length > 0) {
    const where = integration.remote ? `${integration.remote}/${integration.branch}` : integration.branch;
    const named = blockers.map((dep) =>
      dep === "walking-skeleton"
        ? `the walking skeleton, Unit "${opening.skeleton}", is not complete on ${where} yet`
        : `${unit} waits on ${dep}`
    );
    fail(named.join("; "));
  }
  const ref = claimRef(identity.intentId8, unit);
  const current = currentClaim(pd, integration.remote, ref);
  if (current?.status === "claimed") {
    fail(`Unit "${unit}" is already claimed by "${current.owner}".`);
  }
  const generation =
    current?.status === "released"
      ? current.generation
      : (current?.generation ?? 0) + 1;
  const nonce = randomUUID();
  const owner = claimOwnerLabel(pd, flags.team);
  // Pin takes exactly one newly added team shard (candidateBoundary). A
  // checkout whose own shard main already has (the lead's own checkout, or a
  // copy of it) keeps the claim's evidence in a shard of the claim's own: the
  // clone shard's shape, its token from the nonce.
  const ownShard = auditShardName(pd);
  const recordPrefix = relativeRecordDir(pd);
  const auditShard = recordPrefix &&
      gitPathExistsAt(pd, integration.oid, `${recordPrefix}/audit/${ownShard}`)
    ? ownShard.replace(/-[a-z0-9]+\.md$/, `-${nonce.replaceAll("-", "").slice(0, 12)}.md`)
    : ownShard;
  const rhythm =
    flags.rhythm === "unit-end" || flags.rhythm === "per-stage"
      ? flags.rhythm
      : readUnitGateRhythm(state);
  const payload: UnitClaimPayload = {
    version: 1,
    status: "claimed",
    owner,
    space: identity.space,
    intent_uuid: identity.intentUuid,
    intent_id8: identity.intentId8,
    unit,
    generation,
    nonce,
    base_oid: integration.oid,
    integration_ref: integration.ref,
    claim_ref: ref,
    predecessor_oid: current?.oid ?? null,
    gate_rhythm: rhythm,
    audit_shard: auditShard,
  };
  const commit = createClaimCommit(pd, current?.oid ?? integration.oid, payload);
  const stamp: UnitScopeStamp = {
    version: 1,
    space: identity.space,
    intent_uuid: identity.intentUuid,
    intent_id8: identity.intentId8,
    unit,
    owner,
    generation,
    nonce,
    claim_ref: ref,
    claim_oid: commit,
    claimed_from_oid: integration.oid,
    integration_ref: integration.ref,
    gate_rhythm: rhythm,
    audit_shard: auditShard,
  };
  // Persist the intended claim before the CAS. A process killed after the push
  // can validate this nonce on retry and finish without creating a new attempt.
  writeUnitScopeStamp(pd, stamp);
  const pushed = updateClaimRef(pd, integration.remote, ref, commit, current?.oid ?? null);
  if (!pushed.ok) {
    clearUnitScopeStamp(pd);
    const winner = currentClaim(pd, integration.remote, ref);
    if (winner?.status === "claimed") fail(`Unit "${unit}" claim lost to "${winner.owner}".`);
    if (pushed.refused) {
      fail(`Unit "${unit}" claim was rejected by ${integration.remote}: ${pushed.refused}`);
    }
    fail(`Unit "${unit}" claim compare-and-swap failed.`);
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  const winner = currentClaim(pd, integration.remote, ref);
  if (!winner || winner.nonce !== nonce) {
    clearUnitScopeStamp(pd);
    fail(`Unit "${unit}" claim verification failed; current holder is "${winner?.owner ?? "unknown"}".`);
  }
  finalizeClaimCheckout(pd, stamp, winner);
  if (recordPrefix && auditShard !== ownShard) {
    moveClaimTurnRows(pd, `${recordPrefix}/audit/${ownShard}`, `${recordPrefix}/${ENGINE_DIR}/audit/${auditShard}`, integration.oid);
  }
  console.log(JSON.stringify({ claimed: true, ...stamp, ...(planWarning ? { warning: planWarning } : {}) }));
}

// A checkout whose own shard main already holds claims into a shard of the
// claim's own, so the claim turn's rows (and any others not yet committed)
// sit in the older shard, which publish carries as main has it. They join the
// claim's local record and the shard goes back to its committed bytes: a
// commit then takes nothing of them, and the pull after the landing finds the
// shard as main has it. Only when the shard is main's as committed and the
// file is that plus rows after it; anything else is left as it is.
function moveClaimTurnRows(projectDir: string, shardPath: string, localPath: string, baseOid: string): void {
  const head = git(projectDir, ["rev-parse", `HEAD:${shardPath}`]);
  if (!head.ok || head.stdout.trim() !== git(projectDir, ["rev-parse", `${baseOid}:${shardPath}`]).stdout.trim()) return;
  const committed = git(projectDir, ["show", `HEAD:${shardPath}`, "--"]).stdout.replace(/\r\n/g, "\n");
  const working = readLocalRecord(projectDir, shardPath);
  if (working === null) return;
  const text = working.replace(/\r\n/g, "\n");
  if (!text.startsWith(committed) || text.length === committed.length) return;
  takeHandedOverAuditRows(projectDir, join(projectDir, ...localPath.split("/")), text.slice(committed.length));
  if (readLocalRecord(projectDir, shardPath) !== working) return;
  git(projectDir, ["checkout", "HEAD", "--", shardPath]);
}

function releaseUnit(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit release <unit> [--expect-nonce <claim-nonce>]");
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  const pd = resolveProjectDir(projectDir);
  if (readApplicableTeamUnitScopeStamp(pd)) {
    fail("release must run from an unscoped checkout.");
  }
  assertMainCheckout(pd);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit release requires Unit Ownership: team.");
  const identity = activeIdentity(pd);
  const integration = fetchIntegration(pd);
  const ref = claimRef(identity.intentId8, unit);
  const current = currentClaim(pd, integration.remote, ref);
  if (current?.status === "released") {
    const pending = readPendingRelease(pd, unit, identity);
    if (
      pending &&
      (
        pending.intent_uuid !== identity.intentUuid ||
        pending.unit !== unit ||
        pending.release_nonce !== current.nonce ||
        pending.claim_generation + 1 !== current.generation ||
        (
          pending.status === "released" &&
          pending.released_generation !== current.generation
        )
      )
    ) {
      fail(
        `Unit "${unit}" release recovery does not match the recorded attempt; ` +
          "refusing to acknowledge a different tombstone.",
      );
    }
    clearClaimGeneration(pd, unit);
    updateCachedClaim(pd, current);
    clearUnitOwner(pd, unit);
    if (pending?.status === "pending") {
      writePendingRelease(pd, identity, {
        ...pending,
        status: "released",
        released_generation: current.generation,
        released_oid: current.oid,
      });
    }
    console.log(JSON.stringify({
      released: true,
      recovered: true,
      unit,
      generation: current.generation,
      claim_ref: ref,
      claim_oid: current.oid,
    }));
    return;
  }
  if (current?.status !== "claimed") fail(`Unit "${unit}" has no live claim.`);
  if (flags["expect-nonce"] && flags["expect-nonce"] !== current.nonce) {
    fail(
      `Unit "${unit}" current claim nonce does not match --expect-nonce; refusing release.`,
    );
  }
  const opening = openingStatus(pd, integration.oid);
  if (opening.completed.has(unit)) {
    fail(
      `Unit "${unit}" is already complete/merged on the integration ref; release is refused.`,
    );
  }
  const priorPending = readPendingRelease(pd, unit, identity);
  if (
    priorPending?.status === "released" &&
    !flags["expect-nonce"]
  ) {
    fail(
      `Unit "${unit}" was released previously and may now be a successor claim. ` +
        `Re-run with --expect-nonce ${current.nonce} to release this exact attempt.`,
    );
  }
  if (
    priorPending?.status === "pending" &&
    (
      priorPending.intent_uuid !== identity.intentUuid ||
      priorPending.unit !== unit ||
      priorPending.claim_generation !== current.generation ||
      priorPending.claim_nonce !== current.nonce
    )
  ) {
    fail(
      `Unit "${unit}" now belongs to a different claim attempt; refusing to ` +
        "tombstone the successor during release recovery.",
    );
  }
  const pending: PendingRelease = priorPending ?? {
    version: 1,
    status: "pending",
    intent_uuid: identity.intentUuid,
    unit,
    claim_generation: current.generation,
    claim_nonce: current.nonce,
    release_nonce: randomUUID(),
  };
  const activePending = pending.status === "pending"
    ? pending
    : {
        version: 1 as const,
        status: "pending" as const,
        intent_uuid: identity.intentUuid,
        unit,
        claim_generation: current.generation,
        claim_nonce: current.nonce,
        release_nonce: randomUUID(),
      };
  writePendingRelease(pd, identity, activePending);
  const payload: UnitClaimPayload = {
    ...current.payload,
    status: "released",
    owner: "released",
    generation: current.generation + 1,
    nonce: activePending.release_nonce,
    predecessor_oid: current.oid,
  };
  const commit = createClaimCommit(pd, current.oid, payload);
  const pushed = updateClaimRef(pd, integration.remote, ref, commit, current.oid);
  if (!pushed.ok) {
    if (pushed.refused) {
      fail(`Unit "${unit}" release was rejected by ${integration.remote}: ${pushed.refused}`);
    }
    fail(`Unit "${unit}" release compare-and-swap failed.`);
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  const released = currentClaim(pd, integration.remote, ref);
  if (released?.status !== "released" || released.nonce !== payload.nonce) {
    fail(`Unit "${unit}" release verification failed.`);
  }
  clearUnitScopeStamp(pd);
  clearClaimGeneration(pd, unit);
  updateCachedClaim(pd, released);
  clearUnitOwner(pd, unit);
  writePendingRelease(pd, identity, {
    ...activePending,
    status: "released",
    released_generation: released.generation,
    released_oid: released.oid,
  });
  console.log(JSON.stringify({
    released: true,
    unit,
    generation: released.generation,
    claim_ref: ref,
    claim_oid: released.oid,
  }));
}

function clearUnitOwner(projectDir: string, unit: string): void {
  withAuditLock(projectDir, () => {
    const stateContent = readStateFile(projectDir);
    const lines = stateContent.split("\n");
    let changed = false;
    const updated = lines.map((line) => {
      if (!line.startsWith("|")) return line;
      const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
      if (
        cells.length < 2 ||
        (cells[0].toLowerCase() === "unit" &&
          cells[1].toLowerCase() === "owner") ||
        cells.every((cell) => /^-+$/.test(cell)) ||
        cells[0] !== unit
      ) {
        return line;
      }
      cells[1] = "-";
      changed = true;
      return `| ${cells.join(" | ")} |`;
    }).join("\n");
    if (changed) writeStateFile(projectDir, updated);
  });
}

// A team hand-over question (share, join, publish, review, push) is put once in
// the state it is due in: its mark names the offer and that state, so a new
// state is a new mark and the reply that does not take it never meets it again.
export function teamHandoverMarkName(kind: string, key: string): string {
  return `team-handover-${kind}-${key.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120)}.json`;
}

const TEAM_SHARED = "team-shared.json";

// This checkout shared the plan with the teams (`aidlc unit share`), so it
// shows the board from then on, not the walk that builds the Units here.
function noteTeamShared(projectDir: string): void {
  noteEngineAskMark(projectDir, TEAM_SHARED);
}

export function teamSharedHere(projectDir: string): boolean {
  return engineAskMark(projectDir, TEAM_SHARED) !== null;
}

// A hand-over that did not happen (a commit or a push refused) is due again.
function clearTeamHandoverMarks(projectDir: string, kinds: readonly string[]): void {
  const root = recordDir(projectDir);
  if (root === null) return;
  let names: string[];
  try {
    names = readdirSync(join(root, ".aidlc-engine"));
  } catch {
    return;
  }
  for (const name of names) {
    if (kinds.some((kind) => name.startsWith(`team-handover-${kind}-`))) clearEngineAskMark(projectDir, name);
  }
}

// What a commit of the work here takes: every change git shows, files git does
// not track included and ignored files left out, except AI-DLC's own part of a
// shared root file (publish leaves it uncommitted too). The share and publish
// questions name these, and commitWorkHere commits them.
export function workToCommit(projectDir: string): { paths: string[]; untracked: string[] } {
  const pd = resolveProjectDir(projectDir);
  const status = git(pd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return { paths: [], untracked: [] };
  const paths: string[] = [];
  const untracked: string[] = [];
  const records = status.stdout.split("\u0000");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    if (code === "??") untracked.push(record.slice(3));
    if (/[RC]/.test(code) && records[i + 1]) paths.push(records[++i]);
  }
  const own = aidlcOwnRootParts(pd, paths);
  return { paths: paths.filter((path) => !own.has(path)), untracked: untracked.filter((path) => !own.has(path)) };
}

// Commits what workToCommit names, as the person, with their own git setup;
// nothing to commit commits nothing. Returns how many paths it took.
function commitWorkHere(projectDir: string, message: string): number {
  const { paths } = workToCommit(projectDir);
  if (paths.length === 0) return 0;
  const added = git(projectDir, ["add", "-A", "--", ...paths]);
  if (!added.ok) fail(`git add failed: ${added.stderr.trim()}`);
  const committed = git(projectDir, ["commit", "-q", "-m", message]);
  if (!committed.ok) {
    if (NO_GIT_IDENTITY.test(committed.stderr)) {
      fail(
        "Git has no name and email for your commits yet. Set them with " +
          'git config --global user.name "Your Name" and git config --global user.email "you@example.com".',
      );
    }
    fail(`git did not commit: ${(committed.stderr || committed.stdout).trim()}.`);
  }
  return paths.length;
}

// The remote and integration branch a share pushes to, or null with no remote.
export function shareTarget(projectDir: string): { remote: string; branch: string } | null {
  const remote = repositoryRemote(projectDir);
  if (!remote) return null;
  return { remote, branch: affirmedIntegrationBranch(projectDir)?.branch ?? integrationBranch(projectDir, remote) };
}

// Whether a share can run here: team work, a checkout holding no Unit claim, a
// remote, and HEAD on the integration branch. Null when it can; the reason
// otherwise. The share offer is put only where this is null.
export function shareBlocker(projectDir: string): string | null {
  const pd = resolveProjectDir(projectDir);
  try {
    if (readApplicableTeamUnitScopeStamp(pd)) return "This checkout holds a Unit claim; share main from a checkout that holds none.";
    if (!isTeamUnitOwnership(readStateFile(pd))) return "Sharing main is for work that several teams build.";
    const target = shareTarget(pd);
    if (!target) return "This repository has no remote to share main with. Add one (git remote add origin <url>), then share again.";
    const current = currentBranch(pd);
    if (current !== target.branch) {
      return `This checkout is on ${current}, not ${target.branch}. Switch to ${target.branch}, then share again.`;
    }
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

// `aidlc unit share`: commit the work here and push the integration branch to
// the remote, so the teams can take Units (after Inception) or see a landed
// one. A plain push, never forced. A share that did not happen (a commit git
// refused, a push the remote refused) keeps what it committed and leaves both
// offers due again (their marks cleared), so the next step asks again instead
// of building here.
function shareMain(projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  const blocker = shareBlocker(pd);
  if (blocker !== null) fail(blocker);
  const { remote, branch } = shareTarget(pd)!;
  const landed = landedNotOnRemote(pd).map((row) => row.unit);
  let committed: number;
  try {
    committed = commitWorkHere(
      pd,
      landed.length > 0 ? `Record the ${landed.join(" and ")} landing` : "Share the plan with the teams",
    );
  } catch (error) {
    clearTeamHandoverMarks(pd, ["share", "push"]);
    fail(`${errorMessage(error)} Then share again.`);
  }
  const pushed = git(pd, ["push", remote, `HEAD:refs/heads/${branch}`], { GIT_TERMINAL_PROMPT: "0" });
  if (!pushed.ok) {
    clearTeamHandoverMarks(pd, ["share", "push"]);
    fail(
      `${remote} did not take ${branch}: ${pushRefusal(pushed.stderr)}. ` +
        `${committed > 0 ? "The commit is kept here: " : ""}pull ${branch}, then share again.`,
    );
  }
  noteTeamShared(pd);
  console.log(JSON.stringify({
    shared: true,
    remote,
    branch,
    commit: gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve HEAD"),
    committed_paths: committed,
    step: "Tell the person in plain words what it reports, then end your turn.",
  }));
}

const CLAIM_REFRESH_TIMEOUT_MS = 3000;

// Each team's claim refs as the remote has them now, for the board and the
// offers on a checkout that has fetched nothing since: one fetch of the claim
// refs only, no prompt, a few seconds at most. Best effort: false when the
// remote did not answer, and the caller shows what this clone last saw.
export function refreshClaimRefs(projectDir: string): boolean {
  const pd = resolveProjectDir(projectDir);
  let remote: string | null;
  try {
    remote = repositoryRemote(pd);
  } catch {
    return false;
  }
  if (!remote) return true;
  const result = spawnSync("git", [
    "fetch", "--quiet", "--no-tags", "--no-filter", remote,
    `+refs/heads/claim/*:refs/remotes/${remote}/claim/*`,
  ], {
    cwd: pd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CLAIM_REFRESH_TIMEOUT_MS,
  });
  return result.status === 0 && !result.error && !result.signal;
}

// Units landed here that the remote's integration branch, as last fetched,
// does not have yet: the push after a land is due for them.
export function landedNotOnRemote(projectDir: string): Array<{ unit: string; commit: string }> {
  const pd = resolveProjectDir(projectDir);
  let remote: string | null;
  try {
    remote = repositoryRemote(pd);
  } catch {
    return [];
  }
  if (!remote) return [];
  const landed: Array<{ unit: string; commit: string }> = [];
  for (const transaction of unitMergeTransactions(pd)) {
    const commit = transaction.git_commit_oid;
    if (transaction.status !== "complete" || !commit) continue;
    const ref = `refs/remotes/${remote}/${transaction.integration_branch}`;
    if (!localGit(pd, ["rev-parse", "--verify", "--quiet", ref]).ok) continue;
    if (localGit(pd, ["merge-base", "--is-ancestor", commit, ref]).ok) continue;
    if (!localGit(pd, ["merge-base", "--is-ancestor", commit, "HEAD"]).ok) continue;
    landed.push({ unit: transaction.unit, commit });
  }
  return landed;
}

// The claimed checkout's Unit is published at what it holds now: the claim's
// latest commit here names this HEAD as its candidate.
export function publishedAtHead(projectDir: string): boolean {
  const pd = resolveProjectDir(projectDir);
  try {
    const stamp = readApplicableTeamUnitScopeStamp(pd);
    if (!stamp?.claim_oid) return false;
    const payload = readPayload(pd, stamp.claim_oid, { localOnly: true });
    const head = localGit(pd, ["rev-parse", "HEAD"]);
    return payload?.candidate_head_oid !== undefined && head.ok && payload.candidate_head_oid === head.stdout.trim();
  } catch {
    return false;
  }
}

// Who builds which Unit, in the lead's own words at the home: one claim per
// Unit they named, held for that team by the claim's compare-and-swap, with no
// scope stamp, so the lead's checkout stays the home's. A Unit they left out
// stays open. The walking skeleton, when on, is built here first.
function assignUnits(args: string[], projectDir?: string): void {
  const { positional, flags, bareFlags } = parseArgs(args);
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state) || homeLocation(state) === null) {
    fail("Units are given to teams once teams are chosen for this work.");
  }
  if (readApplicableTeamUnitScopeStamp(pd)) fail("Units are given to teams at the home, not from a checkout scoped to one Unit.");
  const words = flags["person-words-file"] !== undefined
    ? readAnswerTextFile(pd, flags["person-words-file"])
    : flags["person-words"] ?? "";
  const open = bareFlags.has("open") || flags.open !== undefined;
  const pairs: Array<{ unit: string; team: string }> = [];
  for (const token of positional) {
    const at = token.indexOf("=");
    const unit = at > 0 ? token.slice(0, at).trim() : "";
    const team = at > 0 ? token.slice(at + 1).trim() : "";
    if (!unit || !team) fail(`"${token}" is not <unit>=<team>.`);
    const unitError = validateUnitName(unit);
    if (unitError) fail(unitError);
    if (/[\r\n|]/.test(team)) fail("Team labels cannot contain pipes or newlines.");
    pairs.push({ unit, team });
  }
  if (pairs.length === 0 && !open) fail("Usage: aidlc-unit assign <unit>=<team> [<unit>=<team> ...] | --open");
  const local = localOpeningStatus(pd);
  const skeleton = teamSkeletonOn(state) ? local.skeleton : null;
  const lines: string[] = [];
  const named = new Map<string, string>();
  for (const { unit, team } of pairs) {
    if (!local.units.includes(unit)) fail(`${unit} is not one of this work's Units (${local.units.join(", ")}).`);
    const already = named.get(unit);
    if (already !== undefined && already !== team) fail(`${unit} can go to one team; you named ${already} and ${team}.`);
    named.set(unit, team);
  }
  if (skeleton !== null && named.has(skeleton)) {
    lines.push(`${skeleton} is the walking skeleton, built here before the teams take their Units.`);
    named.delete(skeleton);
  }
  const identity = activeIdentity(pd);
  const integration = fetchIntegration(pd);
  const assigned: Array<{ unit: string; team: string }> = [];
  const held = new Set<string>();
  for (const [unit, team] of named) {
    validateClaimRefUnit(identity.intentId8, unit);
    const ref = claimRef(identity.intentId8, unit);
    const current = currentClaim(pd, integration.remote, ref);
    if (current?.status === "claimed") {
      held.add(unit);
      if (current.owner === team) assigned.push({ unit, team });
      else lines.push(`${unit} is held by ${current.owner}, so it stays with them.`);
      continue;
    }
    const payload: UnitClaimPayload = {
      version: 1,
      status: "claimed",
      owner: team,
      space: identity.space,
      intent_uuid: identity.intentUuid,
      intent_id8: identity.intentId8,
      unit,
      generation: current?.status === "released" ? current.generation : (current?.generation ?? 0) + 1,
      nonce: randomUUID(),
      base_oid: integration.oid,
      integration_ref: integration.ref,
      claim_ref: ref,
      predecessor_oid: current?.oid ?? null,
      gate_rhythm: readUnitGateRhythm(state),
      assigned: true,
    };
    const commit = createClaimCommit(pd, current?.oid ?? integration.oid, payload);
    const pushed = updateClaimRef(pd, integration.remote, ref, commit, current?.oid ?? null);
    if (!pushed.ok) {
      const winner = currentClaim(pd, integration.remote, ref);
      if (winner?.status === "claimed") held.add(unit);
      lines.push(
        winner?.status === "claimed"
          ? `${unit} is held by ${winner.owner}, so it stays with them.`
          : `${unit} could not be held for ${team}: ${pushed.refused ?? "the claim did not take"}. It stays open.`,
      );
      continue;
    }
    invalidateLiveClaimPayloadCache(pd, unit);
    held.add(unit);
    assigned.push({ unit, team });
  }
  // Open: no team holds it, whether named now, earlier, or never.
  const openUnits = unitsInPlanOrder(pd, local.units).filter((unit) =>
    unit !== skeleton && !held.has(unit) &&
    (named.has(unit) || currentClaim(pd, integration.remote, claimRef(identity.intentId8, unit))?.status !== "claimed"));
  appendAuditEntry("UNITS_ASSIGNED", {
    Assigned: assigned.map((row) => `${row.unit}=${row.team}`).join(", ") || "none",
    Open: openUnits.join(", ") || "none",
    ...(words.trim() ? { "Person Words": words.trim() } : {}),
  }, pd);
  const sentence = (unit: string): string => unit.charAt(0).toUpperCase() + unit.slice(1);
  const summary = [
    ...assigned.map((row) => `${sentence(row.unit)}: ${row.team}.`),
    ...(openUnits.length > 0 ? [`Open for any team: ${openUnits.join(", ")}.`] : []),
  ];
  const rhythm = readUnitGateRhythm(state) === "unit-end"
    ? "Each team approves its Unit once, at the end."
    : "Each team approves its Unit after every stage; to approve once at the end of each Unit, say so before the first Unit is built.";
  console.log(JSON.stringify({
    assigned,
    open: openUnits,
    notice: [...summary, ...lines, rhythm].join(" "),
  }));
}

// --- Taking a Unit: a team builds it as a piece of work of its own -----------
//
// The home is the work where Inception ran. Its claims live at its remote:
// this workspace's own when it is the home's workspace, else the address the
// home recorded, fetched into AI-DLC's own refs so no remote is added.

interface HomeWork {
  space: string;
  dirName: string;
  state: string;
  uuid: string;
  id8: string;
  label: string;
  location: string;
  // A remote name, a git address, or null for this repo's own refs.
  target: string | null;
  // Where the home's record is in its repo, with forward slashes.
  recordPrefix: string;
  // The repos the home's work records.
  repos: string[];
}

function findHomeWork(projectDir: string, dirName: string, space: string): HomeWork {
  let state: string;
  try {
    state = readStateFile(projectDir, dirName, space);
  } catch {
    fail(`No work named ${dirName} in space ${space} here.`);
  }
  const location = homeLocation(state);
  if (!isTeamUnitOwnership(state) || location === null) fail(`${dirName} is not work that teams build.`);
  const row = readIntentRegistry(projectDir, space).find((entry) => entry.dirName === dirName);
  if (!row?.uuid) fail(`${dirName} has no entry in its space's list of work.`);
  const own = workspaceHomeLocation(projectDir);
  const target = location === "local" || (own !== null && sameGitAddress(location, own))
    ? repositoryRemote(projectDir)
    : location;
  return {
    space,
    dirName,
    state,
    uuid: row.uuid,
    id8: idSuffix(row.uuid),
    label: row.slug,
    location,
    target,
    recordPrefix: `aidlc/spaces/${space}/intents/${dirName}`,
    repos: row.repos ?? [],
  };
}

// The home's integration branch, fetched with the person's own login: through
// this workspace's remote, or by the home's address into AI-DLC's own ref.
function fetchHomeIntegration(
  projectDir: string,
  home: HomeWork,
  claim: UnitClaimView | null,
): { ref: string; branch: string; oid: string } {
  if (home.target === null || !isGitAddress(home.target)) {
    const remote = home.target;
    const affirmed = affirmedIntegrationBranch(projectDir, home.space);
    const branch = affirmed?.branch ?? integrationBranch(projectDir, remote);
    if (remote) {
      const fetched = git(projectDir, ["fetch", remote, branch]);
      if (!fetched.ok) fail(`The home's branch ${branch} could not be fetched from ${remote}: ${fetched.stderr.trim()}`);
    }
    const ref = remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`;
    return { ref, branch, oid: gitOutput(projectDir, ["rev-parse", "--verify", ref], `The home's branch ${branch} is not here`) };
  }
  const fromClaim = claim?.payload.integration_ref.match(/^refs\/(?:remotes\/[^/]+|heads)\/(.+)$/)?.[1];
  let branch = fromClaim;
  if (!branch) {
    const advertised = git(projectDir, ["ls-remote", "--symref", home.target, "HEAD"]);
    if (!advertised.ok) fail(`The home at ${home.location} could not be reached: ${advertised.stderr.trim()}`);
    branch = advertised.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m)?.[1] ?? "main";
  }
  const ref = `refs/aidlc/home/${home.id8}/integration`;
  const fetched = git(projectDir, ["fetch", "--no-tags", home.target, `+refs/heads/${branch}:${ref}`]);
  if (!fetched.ok) fail(`The home at ${home.location} could not be fetched: ${fetched.stderr.trim()}`);
  return { ref, branch, oid: gitOutput(projectDir, ["rev-parse", "--verify", ref], "The home's branch is not here") };
}

function isGitAddress(target: string): boolean {
  return /[:/\\]/.test(target);
}

// What the home's plan says at a commit: its state and Unit plan, read from
// git, or a line that the lead has not pushed it yet.
function homePlanAt(projectDir: string, home: HomeWork, oid: string, branch: string): { state: string; dependencies: string } {
  const read = (rel: string): string => {
    const shown = git(projectDir, ["show", `${oid}:${home.recordPrefix}/${rel}`, "--"]);
    if (!shown.ok) {
      fail(`The home's work is not on its branch ${branch} yet, so there is nothing to take: the lead pushes it first.`);
    }
    return shown.stdout;
  };
  return { state: read("aidlc-state.md"), dependencies: read("inception/units-generation/unit-of-work-dependency.md") };
}

// The Inception outputs a Unit's planned stages read: the copy its build starts
// from, at the paths those stages read them, plus the Unit plan itself.
function homeInputPaths(stages: string[]): string[] {
  const graph = loadStageGraphAll();
  const paths = new Set<string>(["inception/units-generation/unit-of-work-dependency.md"]);
  for (const slug of stages) {
    const stage = graph.find((entry) => entry.slug === slug);
    for (const consume of stage?.consumes ?? []) {
      const producer = graph.find((entry) =>
        (entry.phase === "ideation" || entry.phase === "inception") &&
        [...(entry.produces ?? []), ...(entry.optional_produces ?? [])].includes(consume.artifact)
      );
      if (producer && producer.slug !== "reverse-engineering") {
        paths.add(`${producer.phase}/${producer.slug}/${artifactFilename(consume.artifact)}`);
      }
    }
  }
  return [...paths].sort();
}

// The home's approvals of the stages that produced the copy, as data: when
// each was approved at the home. Never this build's own approval.
function homeApprovals(projectDir: string, home: HomeWork, oid: string, slugs: Set<string>): string[] {
  const listed = git(projectDir, ["ls-tree", "--name-only", `${oid}:${home.recordPrefix}/audit`]);
  if (!listed.ok) return [];
  const approvals = new Map<string, string>();
  for (const shard of listed.stdout.split(/\r?\n/).filter((name) => name.endsWith(".md"))) {
    const text = git(projectDir, ["show", `${oid}:${home.recordPrefix}/audit/${shard}`, "--"]);
    if (!text.ok) continue;
    for (const block of text.stdout.replace(/\r\n/g, "\n").split(/\n---\n/)) {
      if (auditBlockField(block, "Event") !== "GATE_APPROVED") continue;
      const stage = auditBlockField(block, "Stage");
      if (stage && slugs.has(stage)) approvals.set(stage, auditBlockField(block, "Timestamp") ?? "");
    }
  }
  return [...approvals].sort(([a], [b]) => a.localeCompare(b)).map(([stage, when]) => `${stage} approved at the home ${when}`.trim());
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(committedTextBytes(Buffer.from(text, "utf-8"))).digest("hex")}`;
}

// Another AI-DLC tool, run as this install runs its tools.
function runEngineUtility(projectDir: string, args: string[]): GitResult {
  const command = isCompiledExecutable()
    ? [process.execPath, "engine", ...args]
    : [process.execPath, fileURLToPath(new URL("./aidlc-utility.ts", import.meta.url)), ...args];
  const result = spawnSync(command[0], [...command.slice(1), "--project-dir", projectDir], {
    encoding: "utf-8",
    env: process.env,
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? 1 };
}

// The Unit's build: a piece of work of its own in the team's space, running the
// home's planned per-Unit stages from a copy of what the Unit was approved with.
function createUnitBuild(
  projectDir: string,
  home: HomeWork,
  plan: { state: string },
  baseOid: string,
  unit: string,
  team: string,
  attempt: number,
): { space: string; dirName: string } {
  const space = slugify(team);
  if (!listSpacesHere(projectDir).includes(space)) {
    const created = runEngineUtility(projectDir, isCompiledExecutable() ? ["space", "create", space] : ["space-create", space]);
    if (!created.ok) fail(`The ${team} team's space could not be made: ${(created.stderr || created.stdout).trim()}`);
  }
  const scope = getField(plan.state, "Scope") ?? "";
  const grid = loadScopeMapping()[scope];
  if (!grid) fail(`The home's plan names a scope this install does not have: ${scope}.`);
  const stages = unitMajorConstructionStageSlugs(scope, plan.state, true);
  const wanted = new Set(stages);
  const graph = loadStageGraphAll();
  const skip = graph
    .filter((stage) => stage.phase !== "initialization" && grid.stages[stage.slug] === "EXECUTE" && !wanted.has(stage.slug))
    .map((stage) => stage.slug);
  const add = stages.filter((slug) => grid.stages[slug] !== "EXECUTE");
  const created = runEngineUtility(projectDir, [
    ...(isCompiledExecutable() ? ["intent", "create"] : ["intent-create"]),
    "--scope", scope,
    "--label", unit,
    "--arguments", `Build ${unit} for ${home.label}, from what the home approved`,
    "--space", space,
    ...(skip.length > 0 ? ["--skip", skip.join(",")] : []),
    ...(add.length > 0 ? ["--add", add.join(",")] : []),
    "--keep-entry-in-record",
  ]);
  if (!created.ok) fail(`${unit}'s build could not be started: ${(created.stderr || created.stdout).trim()}`);
  const dirName = readActiveIntentCursor(projectDir, space);
  if (dirName === null) fail(`${unit}'s build was started but could not be found in space ${space}.`);
  const record = join(intentsDir(projectDir, space), dirName);
  // The copy, at the paths the Unit's stages read it.
  const inputs: Array<{ path: string; fingerprint: string }> = [];
  for (const rel of homeInputPaths(stages)) {
    const shown = git(projectDir, ["show", `${baseOid}:${home.recordPrefix}/${rel}`, "--"]);
    if (!shown.ok) continue;
    mkdirSync(dirname(join(record, ...rel.split("/"))), { recursive: true });
    writeFileSync(join(record, ...rel.split("/")), shown.stdout, "utf-8");
    inputs.push({ path: rel, fingerprint: sha256(shown.stdout) });
  }
  const produced = new Set(inputs.map((input) => input.path.split("/")[1]));
  const approvals = homeApprovals(projectDir, home, baseOid, produced);
  const fingerprint = sha256(inputs.map((input) => `${input.path} ${input.fingerprint}`).join("\n"));
  writeFileSync(join(record, APPROVED_INPUTS_FILE), approvedInputsText(unit, home, baseOid, inputs, approvals), "utf-8");
  // Done at the home: the stages before Construction show as done, and are not
  // this build's plan.
  const homeBoxes = new Map(parseCheckboxes(plan.state).map((box) => [box.slug, box.state]));
  withAuditLock(projectDir, () => {
    let content = readStateFile(projectDir, dirName, space);
    for (const stage of graph.filter((entry) => entry.phase === "ideation" || entry.phase === "inception")) {
      if (homeBoxes.get(stage.slug) !== "completed") continue;
      content = content.replace(new RegExp(`^- \\[[ xSR?-]\\] ${stage.slug}(\\s)`, "m"), `- [x] ${stage.slug}$1`);
    }
    const rhythm = readUnitGateRhythm(plan.state);
    for (const [field, value] of [
      ["Construction Iteration", rhythm === "unit-end" ? "unit-major" : "stage-major"],
      ["Construction Execution", "serial"],
      ["Construction Checkpoints", rhythm === "unit-end" ? "enabled" : "disabled"],
      ["Skeleton Stance", "off"],
      [UNIT_BUILD_FIELD, unit],
      [HOME_LOCATION_FIELD, home.location],
      ["Home Work", home.uuid],
      ["Home Record", `${home.space}/${home.dirName}`],
      ["Home Attempt", String(attempt)],
    ] as const) {
      content = setRuntimeField(content, field, value);
    }
    writeStateFile(projectDir, content, dirName, space);
    appendAuditEntry("UNIT_TAKEN_IN", {
      "Home Location": home.location,
      "Home Work": home.uuid,
      "Home Record": `${home.space}/${home.dirName}`,
      Unit: unit,
      Team: team,
      "Home Attempt": String(attempt),
      "Home Commit": baseOid,
      "Copy Fingerprint": fingerprint,
      "Home Approvals": approvals.join("; ") || "none recorded",
    }, projectDir, dirName, space);
  });
  return { space, dirName };
}

export const APPROVED_INPUTS_FILE = "approved-inputs.md";

function approvedInputsText(
  unit: string,
  home: HomeWork,
  baseOid: string,
  inputs: Array<{ path: string; fingerprint: string }>,
  approvals: string[],
): string {
  return [
    "# What this Unit was approved with",
    "",
    `${unit} of ${home.label}, from the home at ${home.location} (space ${home.space}), copied from its commit ` +
      `${baseOid.slice(0, 12)}. These files are the home's: approved there, read here. Change one and AI-DLC ` +
      "offers your change to the home.",
    "",
    "| File | Fingerprint |",
    "| --- | --- |",
    ...inputs.map((input) => `| ${input.path} | ${input.fingerprint} |`),
    "",
    "## Approved at the home",
    "",
    ...(approvals.length > 0 ? approvals.map((line) => `- ${line}`) : ["- none recorded"]),
    "",
  ].join("\n");
}

function setRuntimeField(content: string, field: string, value: string): string {
  const line = new RegExp(`^- \\*\\*${field}\\*\\*:.*$`, "m");
  if (line.test(content)) return content.replace(line, `- **${field}**: ${value}`);
  return content.replace(/^## Runtime State\s*$/m, (heading) => `${heading}\n- **${field}**: ${value}`);
}

function listSpacesHere(projectDir: string): string[] {
  try {
    return readdirSync(join(projectDir, "aidlc", "spaces")).filter((name) =>
      existsSync(join(projectDir, "aidlc", "spaces", name, "memory"))
    );
  } catch {
    return [];
  }
}

// Take a Unit of the home's work: hold it at the home (adopting the lead's
// claim for this team, or claiming an open Unit), then start its build in the
// team's space. A Unit held by another team stays theirs; a Unit that waits on
// another is not taken yet.
function takeUnit(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit take <unit> --home <record> [--home-space <space>] [--team <label>]");
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  if (!flags.home) fail("take needs --home <record>: the home's work this Unit belongs to.");
  const pd = resolveProjectDir(projectDir);
  const home = findHomeWork(pd, flags.home, flags["home-space"] ?? DEFAULT_SPACE);
  validateClaimRefUnit(home.id8, unit);
  // Taken here before (this clone or another of this workspace): carry it on.
  const existing = findUnitBuild(pd, home.uuid, unit);
  if (existing !== null) {
    setActiveSpaceCursor(pd, existing.space);
    selectIntentForSession(pd, existing.dirName, existing.space);
    console.log(JSON.stringify({
      taken: true,
      resumed: true,
      unit,
      space: existing.space,
      record: existing.dirName,
      notice: `Carrying on ${unit}, the ${existing.space} team's build here.`,
    }));
    return;
  }
  const ref = claimRef(home.id8, unit);
  if (home.target !== null) ensureFetchedClaim(pd, home, ref);
  const current = currentClaim(pd, home.target, ref);
  const integration = fetchHomeIntegration(pd, home, current);
  const plan = homePlanAt(pd, home, integration.oid, integration.branch);
  const opening = openingStatusFrom(plan.state, plan.dependencies);
  if (!opening.units.includes(unit)) fail(`${unit} is not one of ${home.label}'s Units (${opening.units.join(", ")}).`);
  const openUnits = opening.units.filter((name) => name !== unit && !opening.completed.has(name));
  const me = git(pd, ["config", "user.name"]).stdout.trim() || "a teammate";
  const activeTeam = activeSpace(pd) === DEFAULT_SPACE ? null : activeSpace(pd);
  if (current?.status === "claimed") {
    if (current.payload.taken_by !== undefined) {
      fail(`${unit} is held by the ${current.owner} team (${current.payload.taken_by} took it).`);
    }
    if (activeTeam !== null && flags.team === undefined && current.owner !== activeTeam) {
      fail(`${unit} is held by the ${current.owner} team.${openUnits.length > 0 ? ` Open: ${openUnits.join(", ")}.` : ""}`);
    }
  }
  if (opening.completed.has(unit)) fail(`${unit} is already done at the home.`);
  // A Unit the home marked done on its claim counts as done, pushed state or not.
  const blockers = (opening.blockers.get(unit) ?? []).filter((dep) => {
    if (dep === "walking-skeleton") return true;
    const depRef = claimRef(home.id8, dep);
    if (home.target !== null) ensureFetchedClaim(pd, home, depRef);
    return currentClaim(pd, home.target, depRef)?.payload.done !== true;
  });
  if (blockers.length > 0) {
    fail(
      `${unit} waits on ${blockers.join(", ")}, which ${blockers.length === 1 ? "is" : "are"} not done at the home yet. ` +
        `It opens once ${blockers.length === 1 ? "it is" : "they are"} done.`,
    );
  }
  const team = current?.status === "claimed" ? current.owner : flags.team ?? activeTeam ?? me;
  if (/[\r\n|]/.test(team)) fail("Team labels cannot contain pipes or newlines.");
  const generation = current?.status === "claimed"
    ? current.generation
    : current?.status === "released" ? current.generation : (current?.generation ?? 0) + 1;
  const payload: UnitClaimPayload = {
    ...(current?.status === "claimed" ? current.payload : {
      version: 1,
      status: "claimed",
      owner: team,
      space: home.space,
      intent_uuid: home.uuid,
      intent_id8: home.id8,
      unit,
      nonce: randomUUID(),
      claim_ref: ref,
      gate_rhythm: readUnitGateRhythm(plan.state),
    }),
    generation,
    base_oid: integration.oid,
    integration_ref: integration.ref,
    predecessor_oid: current?.oid ?? null,
    taken_by: me,
  } as UnitClaimPayload;
  const commit = createClaimCommit(pd, current?.oid ?? integration.oid, payload);
  const pushed = updateClaimRef(pd, home.target, ref, commit, current?.oid ?? null);
  let resultByFile = false;
  if (!pushed.ok) {
    const winner = currentClaim(pd, home.target, ref);
    if (winner?.status === "claimed" && winner.nonce !== current?.nonce) fail(`${unit} was just taken by the ${winner.owner} team.`);
    if (winner?.status === "claimed" && winner.payload.taken_by !== undefined) fail(`${unit} was just taken by ${winner.payload.taken_by}.`);
    if (current?.status !== "claimed") {
      fail(
        `${unit} is open at the home, which takes no push from here: ${pushed.refused ?? "the claim did not take"}. ` +
          `Ask the lead to hold it for your team: at the home they run /aidlc unit assign ${unit}=${team}.`,
      );
    }
    // The lead holds it for this team: it is theirs to take without a push,
    // and its result goes back as a file.
    resultByFile = true;
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  const build = createUnitBuild(pd, home, plan, integration.oid, unit, team, generation);
  setActiveSpaceCursor(pd, build.space);
  // The likely repos this workspace has no checkout of, said with the way to one.
  const likely = unitLikelyRepos(pd, home.dirName, home.space).get(unit) ?? [];
  const missing = [...new Set(likely.map((repo) => repo.split("/")[0]))]
    .filter((repo) => home.repos.includes(repo) && !isGitRepoDir(repoDir(pd, repo)));
  if (resultByFile) {
    withAuditLock(pd, () => {
      const content = readStateFile(pd, build.dirName, build.space);
      writeStateFile(pd, setRuntimeField(content, "Home Result", "by file"), build.dirName, build.space);
    });
  }
  console.log(JSON.stringify({
    taken: true,
    unit,
    team,
    space: build.space,
    record: build.dirName,
    notice: `${unit.charAt(0).toUpperCase()}${unit.slice(1)} is yours, for the ${team} team. Its build is its own ` +
      `piece of work here, under your team's rules, from what the home approved.` +
      (resultByFile
        ? ` You can read the home but not write to it, so the result of ${unit} goes back as a file when it is built.`
        : "") +
      missing.map((repo) => ` ${repoNotThereLine(pd, repo)}`).join(""),
  }));
}

// A claim at the home's address: fetched so its payload can be read.
function ensureFetchedClaim(projectDir: string, home: HomeWork, ref: string): void {
  if (home.target === null || !isGitAddress(home.target)) return;
  git(projectDir, ["fetch", "--no-tags", home.target, `+${ref}:refs/aidlc/home/${home.id8}/${ref.slice("refs/heads/".length)}`]);
}

// --- Sending a Unit's build home ----------------------------------------------
//
// The push the person asks for: in each repo the Unit changed, a commit of
// exactly the paths its Code Generation recorded writing, on the Unit's branch,
// pushed to that repo's own remote with their login, identity, signing and
// hooks (no force, no --no-verify); then the result on the claim at the home.
// Their other uncommitted work is never committed or touched. When the Unit's
// branch is not the one they are on, it is switched to (their work comes along
// as it is) and the line says which branch they are on.

function buildsHome(projectDir: string, build: UnitBuild): HomeWork {
  const at = build.homeRecord.indexOf("/");
  return findHomeWork(projectDir, build.homeRecord.slice(at + 1), build.homeRecord.slice(0, at));
}

// A code repo's integration branch: where its remote's HEAD points.
function repoIntegration(dir: string, remote: string): string {
  const head = git(dir, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]).stdout.trim();
  if (head) return head;
  for (const name of ["main", "master"]) {
    if (git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`]).ok) return `${remote}/${name}`;
  }
  return `${remote}/main`;
}

function pushUnit(args: string[], projectDir?: string): void {
  const { bareFlags, flags } = parseArgs(args);
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  const build = unitBuildOf(state);
  if (build === null) fail("push sends a Unit's build home; this work is not one.");
  const unit = build.unit;
  if (bareFlags.has("later") || flags.later !== undefined) {
    withAuditLock(pd, () => writeStateFile(pd, setRuntimeField(readStateFile(pd), UNIT_PUSH_FIELD, "later")));
    console.log(JSON.stringify({ pushed: false, notice: `Nothing is pushed. Say push when ${unit} is ready to go home.` }));
    return;
  }
  const manifest = readUnitSourceManifest(pd, "code-generation", unit);
  if (!manifest.ok) fail(`${unit} has no record of what its Code Generation wrote yet (${manifest.reason}).`);
  const byRepo = writesByRepo(pd, manifest.manifest.writes);
  const home = buildsHome(pd, build);
  const ref = claimRef(home.id8, unit);
  if (home.target !== null) ensureFetchedClaim(pd, home, ref);
  const claim = currentClaim(pd, home.target, ref);
  const earlier = new Map((claim?.payload.result?.repos ?? []).map((repo) => [repo.repo, repo]));
  const results: RepoResult[] = [];
  const switched: string[] = [];
  for (const [repo, paths] of byRepo) {
    const dir = repo === "." ? pd : repoDir(pd, repo);
    if (!isGitRepoDir(dir)) fail(repoNotThereLine(pd, repo));
    const name = repo === "." ? "the repo" : repo;
    if (git(dir, ["branch", "--show-current"]).stdout.trim() !== unit) {
      const exists = git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${unit}`]).ok;
      const moved = git(dir, exists ? ["switch", unit] : ["switch", "-c", unit]);
      if (!moved.ok) fail(`Branch ${unit} could not be checked out in ${name}: ${moved.stderr.trim()}`);
      switched.push(name);
    }
    const added = git(dir, ["add", "--", ...paths]);
    if (!added.ok) fail(`${unit}'s changes could not be added in ${name}: ${added.stderr.trim()}`);
    if (!git(dir, ["diff", "--cached", "--quiet", "--", ...paths]).ok) {
      const committed = git(dir, ["commit", "-q", "-m", `${unit}: ${home.label}`, "--", ...paths]);
      if (!committed.ok) fail(`The commit in ${name} did not go through: ${(committed.stderr || committed.stdout).trim()}`);
    }
    const remote = git(dir, ["config", "--get", `branch.${unit}.remote`]).stdout.trim() || repositoryRemote(dir);
    if (remote === null) fail(`${name} has no remote to push ${unit} to.`);
    const pushed = git(dir, ["push", "-u", remote, unit]);
    if (!pushed.ok) fail(`The push of ${unit} in ${name} was refused: ${pushRefusal(pushed.stderr)}. Nothing was retried.`);
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const base = earlier.get(repo)?.base ??
      (git(dir, ["merge-base", "HEAD", repoIntegration(dir, remote)]).stdout.trim() || head);
    const changed = git(dir, ["diff", "--name-only", "--no-renames", base, head, "--", ...paths]).stdout.split(/\r?\n/).filter(Boolean);
    const blobs = blobsAt(dir, head, changed);
    const url = git(dir, ["remote", "get-url", remote]).stdout.trim();
    results.push({
      repo,
      ...(url ? { url } : {}),
      branch: unit,
      base,
      heads: [...new Set([...(earlier.get(repo)?.heads ?? []), head])],
      paths: Object.fromEntries(changed.map((path) => [path, blobs.get(path) ?? null])),
      ...(() => {
        const id = patchIdOf(dir, base, head, changed);
        return id ? { patch_id: id } : {};
      })(),
    });
  }
  const names = results.map((repo) => (repo.repo === "." ? "the repo" : repo.repo));
  const lines = [`Pushed branch ${unit} in ${joinNames(names)}. Open a PR in ${names.length === 1 ? "it" : "each"} your usual way.`];
  if (switched.length > 0) lines.push(`You are on branch ${unit} in ${joinNames(switched)} now.`);
  // The result goes home on the claim, with the Unit outputs the home's later
  // stages read; a home that takes no push from here gets it as a file.
  const outputs = unitOutputsHomeReads(unit, getField(state, "Scope") ?? "")
    .filter((rel) => existsSync(join(activeRecordDir(pd), ...rel.split("/"))));
  const result: UnitResult = { by: git(pd, ["config", "user.name"]).stdout.trim() || "a teammate", repos: results, outputs };
  if (getField(state, "Home Result")?.trim() === "by file" || claim === null) {
    lines.push(`The home takes no push from here, so ${unit}'s result goes back as a file.`);
  } else {
    const files = Object.fromEntries(outputs.map((rel) => [
      `${RESULT_FILES_ROOT}/${rel}`,
      readFileSync(join(activeRecordDir(pd), ...rel.split("/")), "utf-8"),
    ]));
    const payload: UnitClaimPayload = { ...claim.payload, predecessor_oid: claim.oid, result, verdicts: undefined };
    const commit = createClaimCommit(pd, claim.oid, payload, undefined, undefined, files);
    const sent = updateClaimRef(pd, home.target, ref, commit, claim.oid);
    if (!sent.ok) lines.push(`The home did not take ${unit}'s result: ${sent.refused ?? "its claim moved meanwhile"}. Say push to send it again.`);
    else invalidateLiveClaimPayloadCache(pd, unit);
  }
  withAuditLock(pd, () => {
    writeStateFile(pd, setRuntimeField(readStateFile(pd), UNIT_PUSH_FIELD, "pushed"));
    appendAuditEntryUnlocked("UNIT_PUSHED", {
      Unit: unit,
      Branch: unit,
      Repos: results.map((repo) => `${repo.repo}@${repo.heads.at(-1)}`).join(", "),
    }, pd);
  });
  console.log(JSON.stringify({ pushed: true, unit, repos: results.map((repo) => repo.repo), notice: lines.join(" ") }));
}

function activeRecordDir(projectDir: string): string {
  const record = recordDir(projectDir);
  if (record === null) fail("No piece of work is selected here.");
  return record;
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// --- At the home: what came back, and what merged -----------------------------
//
// For each Unit a team holds with a result on its claim and not yet done: fetch
// each repo's integration branch with the person's own login, check whether
// the Unit's part is merged, put the verdicts on the claim, and once every repo
// merged record the Unit done (UNIT_MERGED, under the per-intent lock), write
// the Unit outputs the home's later stages read into its record, and mark the
// claim done so the Units waiting on it open everywhere. A repo the home has
// no checkout of keeps the team's result as theirs until the home can check it.
export function checkTeamResults(projectDir: string): Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }> {
  const pd = resolveProjectDir(projectDir);
  const found = new Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }>();
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  for (const [unit, claim] of cachedClaims(pd)) {
    if (claim.status !== "claimed" || claim.payload.result === undefined) continue;
    if (claim.payload.done) {
      found.set(unit, { team: claim.owner, verdicts: claim.payload.verdicts ?? [], done: true });
      continue;
    }
    const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
    const result = live?.payload.result;
    if (!live || live.status !== "claimed" || !result) continue;
    const verdicts = result.repos.map((repo) => {
      const dir = repo.repo === "." ? pd : repoDir(pd, repo.repo);
      if (!isGitRepoDir(dir)) return { repo: repo.repo, merged: false };
      const repoRemote = repositoryRemote(dir);
      if (repoRemote !== null) git(dir, ["fetch", "-q", repoRemote]);
      const verdict = unitMergeVerdict(dir, repoRemote === null ? "HEAD" : repoIntegration(dir, repoRemote), repo);
      return verdict.merged ? { repo: repo.repo, merged: true, commit: verdict.commit, how: verdict.how } : { repo: repo.repo, merged: false };
    });
    const done = verdicts.length > 0 && verdicts.every((verdict) => verdict.merged);
    const same = JSON.stringify(live.payload.verdicts ?? []) === JSON.stringify(verdicts);
    if (done) recordUnitDone(pd, live, verdicts);
    if (!same || done) {
      const payload: UnitClaimPayload = { ...live.payload, predecessor_oid: live.oid, verdicts, ...(done ? { done: true as const } : {}) };
      const commit = createClaimCommit(pd, live.oid, payload);
      if (updateClaimRef(pd, remote, live.ref, commit, live.oid).ok) invalidateLiveClaimPayloadCache(pd, unit);
    }
    found.set(unit, { team: live.owner, verdicts, done });
  }
  return found;
}

function recordUnitDone(projectDir: string, claim: UnitClaimView, verdicts: NonNullable<UnitClaimPayload["verdicts"]>): void {
  const record = activeRecordDir(projectDir);
  for (const rel of claim.payload.result?.outputs ?? []) {
    const shown = git(projectDir, ["show", `${claim.oid}:${RESULT_FILES_ROOT}/${rel}`, "--"]);
    if (!shown.ok) continue;
    mkdirSync(dirname(join(record, ...rel.split("/"))), { recursive: true });
    writeFileSync(join(record, ...rel.split("/")), shown.stdout, "utf-8");
  }
  withAuditLock(projectDir, () => {
    const already = readAuditShardEvents(projectDir).some((row) =>
      row.event === "UNIT_MERGED" && auditBlockField(row.block, "Unit") === claim.unit &&
      auditBlockField(row.block, "Attempt Generation") === String(claim.generation)
    );
    if (already) return;
    appendAuditEntryUnlocked("UNIT_MERGED", {
      Unit: claim.unit,
      Owner: claim.owner,
      "Built By": claim.payload.result?.by ?? claim.payload.taken_by ?? claim.owner,
      "Merged In": verdicts.map((verdict) => `${verdict.repo}@${verdict.commit} (${verdict.how})`).join(", "),
      "Attempt Generation": String(claim.generation),
    }, projectDir);
  });
}

// What the home said about this build's Unit, read from the claim git last
// brought in: a turn-down, in the home's person's own words. Null for none.
export function buildClaimNote(projectDir: string, stateContent: string): string | null {
  const build = unitBuildOf(stateContent);
  if (build === null) return null;
  const space = build.homeRecord.slice(0, build.homeRecord.indexOf("/"));
  let claim: UnitClaimView | undefined;
  try {
    claim = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false)
      .get(build.unit);
  } catch {
    return null;
  }
  const down = claim?.payload.turned_down;
  if (!down) return null;
  return `${build.unit} was turned down in ${down.repo} at the home${down.words ? `: "${down.words}"` : ""}. ` +
    "Say go back to Code Generation to change it, then push again.";
}

// The home's person turned a Unit's repo down: their words go on the claim,
// and the team hears them, once, at its next step.
function turnedDown(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit || !flags.repo) fail("Usage: aidlc-unit turned-down <unit> --repo <repo> --person-words '<their words>'");
  const pd = resolveProjectDir(projectDir);
  const words = flags["person-words-file"] !== undefined
    ? readAnswerTextFile(pd, flags["person-words-file"])
    : flags["person-words"] ?? "";
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  if (!live || live.status !== "claimed" || !live.payload.result) fail(`${unit} has no result from its team to turn down.`);
  const payload: UnitClaimPayload = {
    ...live.payload,
    predecessor_oid: live.oid,
    turned_down: { repo: flags.repo, words: words.trim(), at: isoTimestamp() },
  };
  const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload), live.oid);
  if (!sent.ok) fail(`The note could not be put on ${unit}'s claim: ${sent.refused ?? "it moved meanwhile"}. Try again.`);
  invalidateLiveClaimPayloadCache(pd, unit);
  console.log(JSON.stringify({ unit, notice: `The ${live.owner} team hears that ${flags.repo} was turned down, with your words, at its next step.` }));
}

function participate(projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  writeFileSync(unitParticipantPath(pd), "participant\n", "utf-8");
  console.log(JSON.stringify({ participant: true }));
}

let projectDir: string | undefined;

export function main(argv: string[]): void {
  const args = [...argv];
  const projectIdx = args.indexOf("--project-dir");
  if (projectIdx !== -1 && projectIdx + 1 < args.length) {
    projectDir = args[projectIdx + 1];
    args.splice(projectIdx, 2);
  }
  const command = args.shift();
  try {
    if (command === "assign") assignUnits(args, projectDir);
    else if (command === "take") takeUnit(args, projectDir);
    else if (command === "push") pushUnit(args, projectDir);
    else if (command === "turned-down") turnedDown(args, projectDir);
    else if (command === "adopt") adoptUnit(args, projectDir);
    else if (command === "claim") claimUnit(args, projectDir);
    else if (command === "release") releaseUnit(args, projectDir);
    else if (command === "participate") participate(projectDir);
    else if (command === "share") shareMain(projectDir);
    else if (command === "publish") publishUnit(args, projectDir);
    else if (command === "pin") pinUnit(args, projectDir);
    else if (command === "gate") gateUnitMerge(args, projectDir);
    else if (command === "land") landUnit(args, projectDir);
    else if (command === "merge-status") {
      const unit = args[0];
      if (!unit) fail("Usage: aidlc-unit merge-status <unit>");
      console.log(JSON.stringify(
        readUnitMergeTransaction(resolveProjectDir(projectDir), unit),
        null,
        2,
      ));
    }
    else if (command === "status") {
      console.log(JSON.stringify(unitClaimOverview(resolveProjectDir(projectDir)), null, 2));
    } else {
      fail(
        "Usage: aidlc-unit <assign|take|push|turned-down|adopt|claim|release|participate|share|publish|pin|gate|land|merge-status|status> ...",
      );
    }
  } catch (error) {
    console.error(JSON.stringify({
      error: errorMessage(error),
      ...(error instanceof CandidateExactPolicyError ? { candidate_exact: error.details } : {}),
    }));
    process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
