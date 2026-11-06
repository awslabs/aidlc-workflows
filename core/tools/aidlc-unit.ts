// aidlc-unit.ts - atomic Unit claim registry and checkout-local scope binding.

import { projectDirFlag, settleClaudeTurnsFirst } from "./aidlc-claude-turn-pending.ts";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  isRequestTurn,
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
  hasAnyUnitClaimRefs,
  readAllAuditShards,
  staleStageLine,
  readUnitGateRhythm,
  readUnitScopeStamp,
  readAnswerTextFile,
  resolveBoltDag,
  setCheckbox,
  setOrInsertField,
  CEREMONY_FIELDS,
  formatCeremony,
  parseCeremonyStateLine,
  removeField,
  shellArg,
  unattendedHumanPresenceHint,
  parseAuditShardEvents,
  parseReviewRecordBytes,
  personAskedSinceGate,
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
  resolveWorkflowSelection,
  selectIntentForSession,
  sessionsDir,
  setActiveSpaceCursor,
  writeFileAtomic,
  intentRepos,
  setField,
} from "./aidlc-lib.js";
import {
  type Amendment,
  approvedInputsOf,
  artifactAt,
  blobsAt,
  findUnitBuild,
  HANDOFF_DIR,
  type HandFile,
  HOME_LOCATION_FIELD,
  homeLocation,
  inputName,
  parseHandFile,
  patchIdOf,
  type Proposal,
  renderHandFile,
  RESULT_FILES_ROOT,
  type RepoResult,
  sameGitAddress,
  PROJECT_TYPE_SOURCE_FIELD,
  PROJECT_TYPE_SOURCE_HOME,
  soloUnitsProgress,
  teamSpaceOf,
  teamUnitStageApplies,
  textFingerprint,
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
  unitWordsArg,
  TEAM_RHYTHM_OFFER,
  theTeam,
} from "./aidlc-unit-teams.js";
import { repoNotThereLine } from "./aidlc-workspace-manifest.js";
import { loadGraph } from "./aidlc-graph.ts";
import {
  captureStageValidationBasis,
  latestCompletionBasesFromAudit,
  sharedInputAmendedFields,
  stageLabel,
} from "./aidlc-validity.ts";
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
import { UNIT_VERBS } from "./aidlc-command.ts";

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
// or overflowed is a failed run, whatever its exit status. Inside `quietly`,
// git never prompts and gives up after its quiet time limit.
function gitBytes(projectDir: string, args: string[], env?: NodeJS.ProcessEnv): GitBytesResult {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    env: { ...process.env, ...(quiet ? quietEnv(projectDir) : {}), ...env },
    maxBuffer: 512 * 1024 * 1024,
    // A quiet call is a process group of its own, so its time limit ends git's transport (ssh, the http helper) too.
    ...(quiet
      ? { timeout: args[0] === "ls-remote" ? QUIET_READ_TIMEOUT_MS : QUIET_WRITE_CEILING_MS, detached: process.platform !== "win32" }
      : {}),
  });
  // At its time limit the whole group goes. Windows gives git no group of its own, and a pid there names no one
  // process (a freed pid is handed out again, and a process keeps its dead parent's), so what a stopped look started
  // there ends at its own limits: AI-DLC never ends a process it cannot show it started.
  if (process.platform !== "win32" && (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch {
      // Nothing of it is left.
    }
  }
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
  // Who took it: their git user.name.
  taken_by?: string;
  // What the team pushed, what the home found merged, and done: a Unit whose
  // every repo merged, recorded at the home.
  result?: UnitResult;
  verdicts?: Array<{ repo: string; merged: boolean; commit?: string; how?: string }>;
  done?: true;
  turned_down?: { repo: string; words: string; at: string };
  // Handed off by file; the team's progress file, when it sent one.
  by_file?: true;
  progress?: { stage: string; at: string };
  // Started early on these Units' pushed heads.
  early_on?: Array<{ unit: string; repos: Array<{ repo: string; branch: string; head: string }> }>;
  // Changes the team proposed to an input, and the home's approved ones.
  proposals?: Proposal[];
  amendments?: Amendment[];
  // The lead's sign-off of the result, when Lead Sign-off is on.
  signoff?: { words: string; at: string };
  // The lead's word that a repo merged the Unit where the check cannot see it.
  said_merged?: Array<{ repo: string; words: string; at: string }>;
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

export function namesInProse(names: string[]): string {
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
const OUTSIDE_UNIT_SUFFIX = ` (${OUTSIDE_UNIT_RECORD_TREE})`;

function outsideUnitTreePaths(violations: string[]): string[] {
  return violations
    .filter((violation) => violation.endsWith(OUTSIDE_UNIT_SUFFIX))
    .map((violation) => violation.slice(0, -OUTSIDE_UNIT_SUFFIX.length));
}

// The one text publish, pin and land give for a record outside the Unit's
// tree, so the three cannot drift apart. It starts mid-sentence: publish puts
// it after "Pin will refuse this candidate:", pin and land after their refusal.
// Pin and land run in the main checkout, so they name the owner's checkout
// where publish, run in that checkout, says "this branch".
function outsideUnitTreeNextStep(unit: string, integrationRef: string, owner?: string): string {
  const where = owner === undefined
    ? "Take these out of this branch"
    : `In the checkout where ${owner} claimed ${unit} (not this one), take these out of its branch`;
  return "a claimed Unit lands only " +
    `construction/${unit}/ and its own audit shard, and a shared record (an Inception artifact ` +
    `such as contract-summary.md, or a stage-level file) is changed on main. ${where} ` +
    "(git rm a file main does not have, or " +
    `git checkout ${integrationRef.replace(/^refs\/(remotes|heads)\//, "")} -- <path> for one it does), commit, and ` +
    "publish again.";
}

function refuseWithNextStep(
  message: string,
  violations: string[],
  unit: string,
  integrationRef: string,
  owner: string,
): string {
  if (outsideUnitTreePaths(violations).length === 0) return message;
  const step = outsideUnitTreeNextStep(unit, integrationRef, owner);
  return `${message} ${step[0].toUpperCase()}${step.slice(1)}`;
}

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
      refuseWithNextStep(
        `Pinned candidate violates claimed Unit ownership at: ${
          boundary.violations.join(", ")
        }.`,
        boundary.violations,
        claim.unit,
        claim.payload.integration_ref,
        claim.owner,
      ),
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
  const outside = outsideUnitTreePaths(candidateBoundary(
    pd, publicationBaseOid, headTree, recordPrefix, unit, current.generation, auditShard,
  ).violations);
  const outsideTree = outside.length > 0
    ? {
      records_outside_unit_tree: outside,
      records_outside_unit_tree_note:
        `Pin will refuse this candidate: ${outsideUnitTreeNextStep(unit, publicationIntegrationRef)}`,
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
    const remote = repositoryRemote(projectDir);
    fail(
      refuseWithNextStep(
        `Unit "${transaction.unit}" landing violates claimed Unit ownership at: ${
          boundary.violations.join(", ")
        }.`,
        boundary.violations,
        transaction.unit,
        remote
          ? `refs/remotes/${remote}/${transaction.integration_branch}`
          : transaction.integration_branch,
        transaction.owner,
      ),
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
// code-generation, say) for every Unit at once. `stages`: the Unit's stages, as
// its land or its home's done record names them.
function unitStagesSkippedOnMain(
  projectDir: string,
  stages: readonly string[],
): string | null {
  const state = readStateFile(projectDir);
  if (unitMajorConstructionStageSlugs(getField(state, "Scope") ?? "", state, true).length > 0) {
    return null;
  }
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
    const skipped = unitStagesSkippedOnMain(pd, transaction.evidence.stages_expected);
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
    const skipped = unitStagesSkippedOnMain(pd, transaction.evidence.stages_expected);
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

// The label a claim writes when the person gives none, as the Take question
// says it.
export function defaultTeamLabel(projectDir: string): string {
  return gitUserName(projectDir) || "team";
}

function claimOwnerLabel(projectDir: string, supplied?: string): string {
  const owner = supplied?.trim() || defaultTeamLabel(projectDir);
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

// The stage a work's Unit plan is being changed at, when its Current Stage is
// back before the per-Unit block (Units Generation open again, say); null
// otherwise. A claim, and a team's take of a Unit, go ahead on the plan as it
// stands and say so once (#3408).
function unitPlanChangingStage(state: string): string | null {
  const stage = getField(state, "Current Stage")?.trim() ?? "";
  const graph = loadStageGraph();
  return beforePerUnitBlock(graph, stage) ? graph.find((node) => node.slug === stage)?.name ?? stage : null;
}

// The same risk said at the home itself, as the lead hands Units to teams
// while it is changing the Unit plan.
function homePlanChangingLine(state: string, units: readonly string[]): string | null {
  const changing = unitPlanChangingStage(state);
  if (changing === null || units.length === 0) return null;
  return `The Unit plan is open again here (${changing}), so ${joinNames([...units])} ` +
    `${units.length === 1 ? "goes to its team" : "go to their teams"} on the plan as it stands, which may still change.`;
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
  const changing = unitPlanChangingStage(stateAtOid(pd, integration.oid));
  const planWarning = changing !== null
    ? `Main is changing the Unit plan (${changing} ` +
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

// Commits what workToCommit names (with `only`, just the paths it keeps), as
// the person, with their own git setup; nothing to commit commits nothing.
// Returns how many paths it took.
function commitWorkHere(projectDir: string, message: string, only?: (path: string) => boolean): number {
  const paths = workToCommit(projectDir).paths.filter((path) => only === undefined || only(path));
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
// `--plan`: AI-DLC's record only (the plan a team's clone takes its Unit
// from), for a home whose teams build in repos of their own; none of the
// person's other files here is committed.
function shareMain(args: string[], projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  const blocker = shareBlocker(pd);
  if (blocker !== null) fail(blocker);
  const planOnly = parseArgs(args).bareFlags.has("plan");
  const { remote, branch } = shareTarget(pd)!;
  const landed = landedNotOnRemote(pd).map((row) => row.unit);
  let committed: number;
  try {
    committed = commitWorkHere(
      pd,
      landed.length > 0 ? `Record the ${landed.join(" and ")} landing` : "Share the plan with the teams",
      planOnly ? (path) => path === "aidlc" || path.startsWith("aidlc/") : undefined,
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

// The person's words as the agent hands them: a file (`--person-words-file`) or inline.
// The person's words for a Unit command: from the request file the agent wrote
// them to (readRequestFile, spent once the command has done its work), else
// as given.
let spendWordsFile: (() => void) | null = null;
function personWordsOf(pd: string, flags: Record<string, string | undefined>): string {
  if (flags["request-file"] !== undefined) {
    const request = readRequestFile(pd, flags["request-file"]);
    if (typeof request === "string") fail(request);
    spendWordsFile = request.spend;
    return request.text.trim();
  }
  return (flags["person-words-file"] !== undefined ? readAnswerTextFile(pd, flags["person-words-file"]) : flags["person-words"] ?? "").trim();
}

// The lead's words at the home are theirs only with a turn of theirs behind
// them (personAskedSinceGate). The four that settle a team's Unit (an answer
// to a proposal, a turn-down, a merge by word, a sign-off) are refused without
// one, with the step for a reply the hooks may have missed; assign and hand-off
// go on, and record no words as the lead's.
function leadSpoke(pd: string): boolean {
  return humanPresenceGuardDisabled() || personAskedSinceGate(pd);
}

function requireLeadsWord(pd: string, what: string): void {
  if (!leadSpoke(pd)) fail(`${what} is the person's own word: ask them first, then run this with their words.${unattendedHumanPresenceHint(pd)}`);
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
  const words = leadSpoke(pd) ? personWordsOf(pd, flags) : "";
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
  let skeleton = teamSkeletonOn(state) ? local.skeleton : null;
  const lines: string[] = [];
  const named = new Map<string, string>();
  for (const { unit, team } of pairs) {
    if (!local.units.includes(unit)) fail(`${unit} is not one of this work's Units (${local.units.join(", ")}).`);
    const already = named.get(unit);
    if (already !== undefined && already !== team) fail(`${unit} can go to one team; you named ${already} and ${team}.`);
    named.set(unit, team);
  }
  // The lead's own words win over the slice built together first: the part
  // they name a team for goes to that team, and nothing is built together
  // first for this work, said once.
  if (skeleton !== null && named.has(skeleton)) {
    const [command, ...stanceArgs] = aidlcEngineCommand(
      "state",
      ["set-skeleton-stance", "off", "--project-dir", pd],
      join(dirname(fileURLToPath(import.meta.url)), "aidlc-state.ts"),
      isCompiledExecutable() ? process.execPath : null,
    );
    const set = spawnSync(command, stanceArgs, { cwd: pd, encoding: "utf-8", env: process.env });
    if (set.status !== 0) fail(`${(set.stderr || set.stdout).trim()}`);
    lines.push(`${skeleton} goes to ${named.get(skeleton)}, as you said, so nothing is built together first for this work.`);
    skeleton = null;
  }
  const identity = activeIdentity(pd);
  let integration: ReturnType<typeof fetchIntegration> | null;
  try {
    integration = fetchIntegration(pd);
  } catch {
    // Every Unit left open holds nothing at the home, so it needs no home.
    integration = null;
  }
  if (integration === null && named.size > 0) {
    // The home cannot be reached: the answer is kept, and the next step offers to hold it again.
    const kept = [...named].map(([unit, team]) => `${unit}=${team}`);
    appendAuditEntry("UNITS_ASSIGNED", {
      Assigned: kept.join(", ") || "none",
      ...(open ? { Open: "all" } : {}),
      Held: "not yet",
      ...(words ? { "Person Words": words } : {}),
    }, pd);
    console.log(JSON.stringify({
      assigned: [],
      notice: "Nothing is held for the teams yet: the home could not be reached. I've kept who builds which Unit. " +
        "Do you want me to try again?",
      offer: { choices: [{ label: "Try again", command: assignRetryCommand(kept, open) }, { label: "Not now" }] },
    }));
    return;
  }
  const assigned: Array<{ unit: string; team: string }> = [];
  const held = new Set<string>();
  for (const [unit, team] of named) {
    if (integration === null) break;
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
    (named.has(unit) || integration === null ||
      currentClaim(pd, integration.remote, claimRef(identity.intentId8, unit))?.status !== "claimed"));
  appendAuditEntry("UNITS_ASSIGNED", {
    Assigned: assigned.map((row) => `${row.unit}=${row.team}`).join(", ") || "none",
    Open: openUnits.join(", ") || "none",
    ...(words.trim() ? { "Person Words": words.trim() } : {}),
  }, pd);
  const planChanging = homePlanChangingLine(state, assigned.map((row) => row.unit));
  if (planChanging !== null) lines.push(planChanging);
  const sentence = (unit: string): string => unit.charAt(0).toUpperCase() + unit.slice(1);
  const summary = [
    ...assigned.map((row) => `${sentence(row.unit)}: ${row.team}.`),
    ...(openUnits.length > 0 ? [`Open for any team: ${openUnits.join(", ")}.`] : []),
  ];
  // The rhythm is the lead's to change: the offer says what is set, what to do
  // and why, and gives the agent the command for the other choice.
  const perStage = readUnitGateRhythm(state) !== "unit-end";
  const rhythm = perStage
    ? TEAM_RHYTHM_OFFER
    : "Each team approves its Unit once, at the end.";
  console.log(JSON.stringify({
    assigned,
    open: openUnits,
    notice: [...summary, ...lines, rhythm].join(" "),
    ...(perStage
      ? {
        offer: {
          choices: [
            { label: "Keep approvals after every stage", recommended: true },
            { label: "Approve once at the end of each Unit", command: `${aidlcToolInvocation("state")} set-unit-gate-rhythm unit-end` },
          ],
        },
      }
      : {}),
  }));
}

// The assignment the lead gave, run again.
export function assignRetryCommand(pairs: string[], open: boolean): string {
  return `${aidlcToolInvocation("unit")} assign ${pairs.length > 0 ? pairs.map(shellArg).join(" ") : ""}${open ? " --open" : ""} ` +
    unitWordsArg("assign");
}

// --- Taking a Unit: a team builds it as a piece of work of its own -----------
//
// The home is the work where Inception ran. Its claims live at its remote:
// this workspace's own when it is the home's workspace, else the address the
// home recorded, fetched into AI-DLC's own refs so no remote is added.

interface HomeWork {
  space: string;
  dirName: string;
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
  // Solo work, one Unit at a time, built from another machine.
  solo: boolean;
}

function findHomeWork(projectDir: string, dirName: string, space: string): HomeWork {
  let state: string;
  try {
    state = readStateFile(projectDir, dirName, space);
  } catch {
    fail(`No work named ${dirName} in space ${space} here.`);
  }
  // Solo work built one Unit at a time from another machine: its home is this
  // workspace's origin, and its state is never written from here.
  const solo = !isTeamUnitOwnership(state) && getField(state, "Construction Iteration")?.trim() === "unit-major";
  const workspaceOrigin = workspaceHomeLocation(projectDir);
  const location = solo ? (workspaceOrigin === "local" ? null : workspaceOrigin) : homeLocation(state);
  if ((!solo && !isTeamUnitOwnership(state)) || location === null) fail(`${dirName} is not work that teams build.`);
  const row = readIntentRegistry(projectDir, space).find((entry) => entry.dirName === dirName);
  if (!row?.uuid) fail(`${dirName} has no entry in its space's list of work.`);
  const own = workspaceHomeLocation(projectDir);
  const target = location === "local" || (own !== null && sameGitAddress(location, own))
    ? repositoryRemote(projectDir)
    : location;
  return {
    space,
    dirName,
    uuid: row.uuid,
    id8: idSuffix(row.uuid),
    label: row.slug,
    location,
    target,
    recordPrefix: `aidlc/spaces/${space}/intents/${dirName}`,
    repos: row.repos ?? [],
    solo,
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

// The home's audit as its commit has it.
function homeAuditAt(projectDir: string, home: HomeWork, oid: string): AuditShardEvent[] {
  const listed = git(projectDir, ["ls-tree", "--name-only", `${oid}:${home.recordPrefix}/audit`]);
  if (!listed.ok) return [];
  return listed.stdout.split(/\r?\n/).filter((name) => name.endsWith(".md")).flatMap((shard, index) => {
    const text = git(projectDir, ["show", `${oid}:${home.recordPrefix}/audit/${shard}`, "--"]);
    return text.ok ? parseAuditShardEvents(text.stdout, shard, index) : [];
  });
}

// The home's approvals of the stages that produced the copy, as data: when
// each was approved at the home. Never this build's own approval.
function homeApprovals(rows: readonly AuditShardEvent[], slugs: Set<string>): string[] {
  const approvals = new Map<string, string>();
  for (const row of rows) {
    if (row.event !== "GATE_APPROVED") continue;
    const stage = auditBlockField(row.block, "Stage");
    if (stage && slugs.has(stage)) approvals.set(stage, row.timestamp);
  }
  return [...approvals].sort(([a], [b]) => a.localeCompare(b)).map(([stage, when]) => `${stage} approved at the home ${when}`.trim());
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
// What a build needs to know of its home, whether it read the home by git or
// from a hand-off file.
type HomeRef = Pick<HomeWork, "location" | "uuid" | "space" | "dirName" | "label" | "repos">;

// Where a build's copy comes from: the home's commit, or a hand-off file.
interface BuildSource {
  read: (rel: string) => string | null;
  approvals: (produced: Set<string>) => string[];
}

function createUnitBuild(
  projectDir: string,
  home: HomeRef,
  plan: { state: string },
  baseOid: string,
  unit: string,
  team: string,
  attempt: number,
  source: BuildSource,
  // A build taken from solo work lives in the home's own space.
  inSpace?: string,
): { space: string; dirName: string } {
  const space = inSpace ?? teamSpaceOf(team);
  if (!listSpacesHere(projectDir).includes(space)) {
    const created = runEngineUtility(projectDir, isCompiledExecutable() ? ["space", "create", space] : ["space-create", space]);
    if (!created.ok) fail(`${theTeam(team).replace(/^the/, "The")}'s space could not be made: ${(created.stderr || created.stdout).trim()}`);
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
    // The home's repos, cloned here or not yet: the Unit's work goes where the home's plan says.
    ...(home.repos.length > 0 ? ["--repos", home.repos.join(",")] : []),
    "--keep-entry-in-record",
  ]);
  if (!created.ok) fail(`${unit}'s build could not be started: ${(created.stderr || created.stdout).trim()}`);
  const dirName = readActiveIntentCursor(projectDir, space);
  if (dirName === null) fail(`${unit}'s build was started but could not be found in space ${space}.`);
  const record = join(intentsDir(projectDir, space), dirName);
  // The copy, at the paths the Unit's stages read it.
  const inputs: Array<{ path: string; fingerprint: string }> = [];
  for (const rel of homeInputPaths(stages)) {
    const text = source.read(rel);
    if (text === null) continue;
    mkdirSync(dirname(join(record, ...rel.split("/"))), { recursive: true });
    writeFileSync(join(record, ...rel.split("/")), text, "utf-8");
    inputs.push({ path: rel, fingerprint: textFingerprint(text) });
  }
  const produced = new Set(inputs.map((input) => input.path.split("/")[1]));
  const approvals = source.approvals(produced);
  const fingerprint = textFingerprint(inputs.map((input) => `${input.path} ${input.fingerprint}`).join("\n"));
  writeFileSync(join(record, APPROVED_INPUTS_FILE), approvedInputsText(unit, home, baseOid, inputs, approvals), "utf-8");
  // Done at the home: the stages before Construction show as done, and are not
  // this build's plan.
  const homeBoxes = new Map(parseCheckboxes(plan.state).map((box) => [box.slug, box.state]));
  withAuditLock(projectDir, () => {
    let content = readStateFile(projectDir, dirName, space);
    for (const stage of graph.filter((entry) => entry.phase === "ideation" || entry.phase === "inception")) {
      if (homeBoxes.get(stage.slug) === "completed") content = setCheckbox(content, stage.slug, "completed");
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
      ["Home Label", home.label],
      ["Home Attempt", String(attempt)],
    ] as const) {
      content = setOrInsertField(content, "## Runtime State", field, value);
    }
    // The plan as the home approved it, never its scope's defaults: each
    // ceremony (Plan Approval, sensors, learnings ...), the depth, the test
    // strategy and the review class the home's plan set.
    for (const name of Object.values(CEREMONY_FIELDS)) {
      const setting = parseCeremonyStateLine(getField(plan.state, name));
      if (setting !== null) content = setOrInsertField(content, "## Runtime State", name, formatCeremony(setting.value, "the home's plan"));
    }
    for (const name of ["Depth", "Test Strategy", "Review Override"]) {
      const value = getField(plan.state, name)?.trim();
      if (value) content = setOrInsertField(content, "## Runtime State", name, value);
    }
    // The type the home settled; a later scan here does not ask about it again.
    const homeType = getField(plan.state, "Project Type")?.trim();
    if (homeType) {
      content = setOrInsertField(setField(content, "Project Type", homeType), "## Project Information", PROJECT_TYPE_SOURCE_FIELD, PROJECT_TYPE_SOURCE_HOME);
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
  recordTakeTree(projectDir, record, intentRepos(projectDir, dirName, space));
  return { space, dirName };
}

// What of the person's own was uncommitted in each of the work's repos when the
// Unit was taken, so its push never commits it: for each changed file, the
// blob of its content then (stored in that repo, never pushed), "" for one they
// had deleted, "untracked" for one git did not track. Object ids only, in the
// build's engine folder, which is never committed.
const TAKE_TREE_FILE = "take-tree.json";
type TakeTree = Record<string, Record<string, string>>;

function recordTakeTree(projectDir: string, record: string, repos: string[]): void {
  const tree: TakeTree = {};
  for (const repo of repos.length > 0 ? repos : ["."]) {
    const dir = repo === "." ? projectDir : repoDir(projectDir, repo);
    if (!isGitRepoDir(dir)) continue;
    const status = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]);
    if (!status.ok) continue;
    const own: Record<string, string> = {};
    for (const entry of status.stdout.split("\0").filter(Boolean)) {
      const path = entry.slice(3);
      if (entry.startsWith("??")) own[path] = "untracked";
      else if (!existsSync(join(dir, path))) own[path] = "";
      else own[path] = git(dir, ["hash-object", "-w", `--path=${path}`, "--", path]).stdout.trim();
    }
    if (Object.keys(own).length > 0) tree[repo] = own;
  }
  if (Object.keys(tree).length > 0) writeTakeTree(record, tree);
}

function writeTakeTree(record: string, tree: TakeTree): void {
  mkdirSync(join(record, ENGINE_DIR), { recursive: true });
  writeFileAtomic(join(record, ENGINE_DIR, TAKE_TREE_FILE), `${JSON.stringify(tree, null, 2)}\n`);
}

function readTakeTree(record: string): TakeTree {
  try {
    return JSON.parse(readFileSync(join(record, ENGINE_DIR, TAKE_TREE_FILE), "utf-8")) as TakeTree;
  } catch {
    return {};
  }
}

// The Unit's commit in one repo: built in an index of its own from HEAD, so
// nothing the person staged comes along. A file that held their own change at
// take goes in as HEAD plus the Unit's change since then; where the two cannot
// be kept apart it is left out, and the working tree is never touched. Once
// committed, such a file's take-time content becomes what was just sent, so a
// later push carries only the Unit's newer change. Returns the paths left out.
function commitUnitPaths(dir: string, paths: string[], own: Record<string, string>, unit: string, label: string, name: string): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-unit-commit-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  const leftOut: string[] = [];
  try {
    const head = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
    git(dir, head ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], env);
    const plain = paths.filter((path) => own[path] === undefined);
    if (plain.length > 0) {
      const added = git(dir, ["add", "--", ...plain], env);
      if (!added.ok) fail(`${unit}'s changes could not be added in ${name}: ${added.stderr.trim()}`);
    }
    const sent = new Map<string, string>();
    for (const path of paths.filter((path) => own[path] !== undefined)) {
      const kept = unitOwnChange(dir, path, own[path], scratch);
      if (kept === null) leftOut.push(path);
      else {
        git(dir, ["update-index", "--cacheinfo", `${kept.mode},${kept.oid},${path}`], env);
        sent.set(path, kept.now);
      }
    }
    const committed = paths.filter((path) => !leftOut.includes(path));
    if (committed.length > 0 && !git(dir, ["diff", "--cached", "--quiet", "--", ...committed], env).ok) {
      const made = git(dir, ["commit", "-q", "-m", `${unit}: ${label}`], env);
      if (!made.ok) fail(`The commit in ${name} did not go through: ${(made.stderr || made.stdout).trim()}`);
      git(dir, ["reset", "-q", "--", ...committed]);
      for (const [path, now] of sent) own[path] = now;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return leftOut;
}

// HEAD's file plus the Unit's change from the take-time file to now, as a blob;
// null when that cannot be told apart from the person's own change.
function unitOwnChange(dir: string, path: string, taken: string, scratch: string): { mode: string; oid: string; now: string } | null {
  const entry = git(dir, ["ls-tree", "HEAD", "--", path]).stdout.trim().split(/\s+/);
  if (taken === "" || taken === "untracked" || entry.length < 3 || !existsSync(join(dir, path))) return null;
  const now = git(dir, ["hash-object", "-w", `--path=${path}`, "--", path]).stdout.trim();
  const files = [entry[2], taken, now].map((oid, i) => {
    const blob = spawnSync("git", ["cat-file", "blob", oid], { cwd: dir });
    if (blob.status !== 0) return null;
    const file = join(scratch, `merge-${i}`);
    writeFileSync(file, blob.stdout);
    return file;
  });
  if (files.some((file) => file === null)) return null;
  const merged = spawnSync("git", ["merge-file", "-p", ...(files as string[])], { cwd: dir });
  if (merged.status !== 0) return null;
  writeFileSync(join(scratch, "merged"), merged.stdout);
  const oid = git(dir, ["hash-object", "-w", "--no-filters", "--", join(scratch, "merged")]).stdout.trim();
  return oid ? { mode: entry[0], oid, now } : null;
}

// Onto the Unit's existing branch the way git's own switch allows. A file of
// the Unit's changed here since the branch was written (Code Generation run
// again on the branch the person went back to) gets the branch's copy in the
// index first, and git keeps the newer file as it is, as it keeps a change to
// any file the switch does not touch. Only a file whose index holds nothing its
// working copy lacks. Anything else in the way stays theirs: git refuses, the
// index is put back, and git's words come back. A dry run does it in a copy of
// their index and moves nothing.
function switchOntoUnitBranch(dir: string, unit: string, paths: string[], dryRun = false): { ok: boolean; said: string } {
  const branch = `refs/heads/${unit}`;
  const scratch = dryRun ? mkdtempSync(join(tmpdir(), "aidlc-unit-switch-")) : null;
  try {
    const env = scratch === null ? undefined : { GIT_INDEX_FILE: join(scratch, "index") };
    const index = resolve(dir, git(dir, ["rev-parse", "--git-path", "index"]).stdout.trim());
    if (env !== undefined && existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE);
    // An empty pathspec would be every file: with no path of the Unit's, nothing is carried.
    const listed = (args: string[]): Set<string> => new Set(paths.length === 0 ? [] :
      git(dir, [args[0], "-z", ...args.slice(1), "--", ...paths], env).stdout.split("\0").filter(Boolean));
    const differs = listed(["diff", "--name-only", "--no-renames", "HEAD", branch]);
    const staged = listed(["diff", "--cached", "--name-only", "--no-renames", "HEAD"]);
    const unstaged = listed(["diff", "--name-only", "--no-renames"]);
    const carried = [...listed(["diff", "--name-only", "--no-renames", "HEAD"]), ...listed(["ls-files", "--others", "--exclude-standard"])]
      .filter((path) => differs.has(path) && !(staged.has(path) && unstaged.has(path)));
    const entries = (args: string[], mode: number, oid: number): Map<string, string> => new Map(carried.length === 0 ? [] :
      git(dir, [args[0], "-z", ...args.slice(1), "--", ...carried], env).stdout.split("\0").filter(Boolean).map((line) => {
        const [meta, path] = [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)];
        const fields = meta.split(" ");
        return [path, `${fields[mode]},${fields[oid]}`];
      }));
    const onBranch = entries(["ls-tree", branch], 0, 2);
    const before = entries(["ls-files", "--stage"], 0, 1);
    const put = (side: Map<string, string>): void => {
      for (const path of carried) {
        const at = side.get(path);
        git(dir, at ? ["update-index", "--add", "--cacheinfo", `${at},${path}`] : ["update-index", "--force-remove", "--", path], env);
      }
    };
    put(onBranch);
    const tried = dryRun ? git(dir, ["read-tree", "-n", "-m", "-u", "HEAD", branch], env) : git(dir, ["switch", "-q", unit]);
    if (!tried.ok && !dryRun) put(before);
    return { ok: tried.ok, said: tried.stderr };
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}

// The repos where the person's own changes would stop the push's switch onto
// the Unit's branch just now: the same switch, as a dry run.
export function unitBranchInTheWay(projectDir: string, unit: string, byRepo: Map<string, string[]>): string[] {
  return [...byRepo].filter(([repo, paths]) => {
    const dir = repo === "." ? projectDir : repoDir(projectDir, repo);
    return isGitRepoDir(dir) && git(dir, ["branch", "--show-current"]).stdout.trim() !== unit &&
      git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${unit}`]).ok && !switchOntoUnitBranch(dir, unit, paths, true).ok;
  }).map(([repo]) => repo);
}

// git's own words for a refusal: its first error line (past any progress
// line), with the files it lists.
function gitSaid(stderr: string): string {
  const lines = stderr.split(/\r\n|\r|\n/);
  const at = Math.max(0, lines.findIndex((line) => /^(?:error|fatal): /.test(line)));
  const files: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("\t")) break;
    files.push(line.trim());
  }
  const first = (lines[at] ?? "").replace(/^(?:error|fatal): /, "").trim().replace(/:$/, "");
  return files.length > 0 ? `${first}: ${files.join(", ")}` : first;
}

export const APPROVED_INPUTS_FILE = "approved-inputs.md";

function approvedInputsText(
  unit: string,
  home: HomeRef,
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

function listSpacesHere(projectDir: string): string[] {
  try {
    return readdirSync(join(projectDir, "aidlc", "spaces")).filter((name) =>
      existsSync(join(projectDir, "aidlc", "spaces", name, "memory"))
    );
  } catch {
    return [];
  }
}

// The Units of solo work built from another machine: the Unit plan at the
// home's commit, with what its walk started and finished read from the record
// here (git brought it with the pull).
function soloOpening(projectDir: string, home: HomeWork, plan: { state: string; dependencies: string }): OpeningStatus & { started: Set<string> } {
  const parsed = parseBoltDag(plan.dependencies);
  if (!parsed.ok) fail(`Cannot resolve Unit dependencies: ${parsed.reason}: ${parsed.detail}`);
  const scope = getField(plan.state, "Scope") ?? "";
  const finalStage = unitMajorConstructionStageSlugs(scope, plan.state, true).at(-1) ?? "code-generation";
  const progress = soloUnitsProgress(readAuditShardEvents(projectDir, home.dirName, home.space), finalStage);
  const blockers = new Map(parsed.units.map((edge) => [edge.name, edge.depends_on.filter((dep) => !progress.done.has(dep))]));
  // Solo work has no merge into main: a Unit its walk finished is landed.
  return {
    units: parsed.units.map((edge) => edge.name), blockers, completed: progress.done, landed: progress.done,
    skeleton: parsed.batches[0][0], started: progress.started,
  };
}

// Take a Unit of the home's work: hold it at the home (adopting the lead's
// claim for this team, or claiming an open Unit), then start its build in the
// team's space. A Unit held by another team stays theirs; a Unit that waits on
// another is not taken yet.
function takeUnit(args: string[], projectDir?: string): void {
  const { positional, flags, bareFlags } = parseArgs(args);
  if (flags.file !== undefined) {
    takeFromFile(resolveProjectDir(projectDir), flags.file);
    return;
  }
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
    selectIntentForSession(pd, existing.dirName, existing.space, resolveWorkflowSelection(pd).sessionId ?? undefined);
    console.log(JSON.stringify({
      taken: true,
      resumed: true,
      unit,
      space: existing.space,
      record: existing.dirName,
      notice: `Carrying on ${unit}, ${theTeam(existing.space)}'s build here.`,
    }));
    return;
  }
  const ref = claimRef(home.id8, unit);
  if (home.target !== null) ensureFetchedClaim(pd, home, ref);
  const current = currentClaim(pd, home.target, ref);
  const integration = fetchHomeIntegration(pd, home, current);
  const plan = homePlanAt(pd, home, integration.oid, integration.branch);
  const planChanging = unitPlanChangingStage(plan.state);
  const solo = home.solo ? soloOpening(pd, home, plan) : null;
  const opening = solo ?? openingStatusFrom(plan.state, plan.dependencies);
  if (!opening.units.includes(unit)) fail(`${unit} is not one of ${home.label}'s Units (${opening.units.join(", ")}).`);
  if (solo?.started.has(unit)) fail(`${unit} is being built on the other machine; take another Unit, or follow along.`);
  const openUnits = opening.units.filter((name) => name !== unit && !opening.completed.has(name));
  const me = git(pd, ["config", "user.name"]).stdout.trim() || "a teammate";
  const activeTeam = activeSpace(pd) === DEFAULT_SPACE ? null : activeSpace(pd);
  if (current?.status === "claimed") {
    if (current.payload.taken_by !== undefined) {
      fail(`${unit} is held by ${theTeam(current.owner)} (${current.payload.taken_by} took it).`);
    }
    if (activeTeam !== null && flags.team === undefined && teamSpaceOf(current.owner) !== activeTeam) {
      fail(`${unit} is held by ${theTeam(current.owner)}.${openUnits.length > 0 ? ` Open: ${openUnits.join(", ")}.` : ""}`);
    }
  }
  if (opening.completed.has(unit)) fail(`${unit} is already done at the home.`);
  const homeRows = homeAuditAt(pd, home, integration.oid);
  // A Unit no team holds that the home started is the home's.
  if (!home.solo && current?.status !== "claimed" && soloUnitsProgress(homeRows, "").started.has(unit)) {
    fail(`${unit} is being built at the home, so it is not open to take. Run \`${aidlcToolInvocation("orchestrate")} next\` for what is.`);
  }
  // A Unit the home marked done on its claim counts as done, pushed state or not.
  const depClaims = new Map<string, UnitClaimView | null>();
  const blockers = (opening.blockers.get(unit) ?? []).filter((dep) => {
    if (dep === "walking-skeleton") return true;
    const depRef = claimRef(home.id8, dep);
    if (home.target !== null) ensureFetchedClaim(pd, home, depRef);
    depClaims.set(dep, currentClaim(pd, home.target, depRef));
    return depClaims.get(dep)?.payload.done !== true;
  });
  // Starting early, on the branches its dependencies pushed (the person asked).
  const pushedDeps = blockers.every((dep) => depClaims.get(dep)?.payload.result !== undefined);
  const early = (bareFlags.has("early") || flags.early !== undefined) && blockers.length > 0 && pushedDeps;
  if (blockers.length > 0 && !early) {
    fail(
      `${unit} waits on ${blockers.join(", ")}, which ${blockers.length === 1 ? "is" : "are"} not done at the home yet. ` +
        `It opens once ${blockers.length === 1 ? "it is" : "they are"} done` +
        (pushedDeps ? `, or starts early on ${blockers.length === 1 ? "its" : "their"} pushed branches if you ask.` : "."),
    );
  }
  const earlyOn = early
    ? blockers.map((dep) => ({
      unit: dep,
      repos: (depClaims.get(dep)?.payload.result?.repos ?? []).map((repo) => ({
        repo: repo.repo,
        branch: repo.branch,
        head: repo.heads.at(-1) ?? "",
      })),
    }))
    : undefined;
  // An open Unit is taken for a team: the one the person names, or the space they are in.
  if (!home.solo && current?.status !== "claimed" && flags.team === undefined && activeTeam === null) {
    fail(`Which team builds ${unit}? Ask the person, then run this again with --team '<their team>'.`);
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
    ...(earlyOn ? { early_on: earlyOn } : {}),
  } as UnitClaimPayload;
  const commit = createClaimCommit(pd, current?.oid ?? integration.oid, payload);
  const pushed = updateClaimRef(pd, home.target, ref, commit, current?.oid ?? null);
  let resultByFile = false;
  if (!pushed.ok) {
    const winner = currentClaim(pd, home.target, ref);
    if (winner?.status === "claimed" && winner.nonce !== current?.nonce) fail(`${unit} was just taken by ${theTeam(winner.owner)}.`);
    if (winner?.status === "claimed" && winner.payload.taken_by !== undefined) fail(`${unit} was just taken by ${winner.payload.taken_by}.`);
    if (current?.status !== "claimed") {
      fail(
        `${unit} is open at the home, which takes no push from here: ${pushed.refused ?? "the claim did not take"}. ` +
          "Ask the lead to hold it for your team at the home.",
      );
    }
    // The lead holds it for this team: it is theirs to take without a push,
    // and its result goes back as a file.
    resultByFile = true;
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  const build = createUnitBuild(pd, home, plan, integration.oid, unit, team, generation, {
    read: (rel) => {
      const shown = git(pd, ["show", `${integration.oid}:${home.recordPrefix}/${rel}`, "--"]);
      return shown.ok ? shown.stdout : null;
    },
    approvals: (produced) => homeApprovals(homeRows, produced),
  }, home.solo ? home.space : undefined);
  setActiveSpaceCursor(pd, build.space);
  // Early: the Unit's branch starts at each dependency's pushed head, checked
  // out where nothing of the person's is uncommitted.
  const earlyLines: string[] = [];
  for (const dep of earlyOn ?? []) {
    for (const repo of dep.repos) {
      const dir = repo.repo === "." ? pd : repoDir(pd, repo.repo);
      const remote = isGitRepoDir(dir) ? repositoryRemote(dir) : null;
      if (remote === null || git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${unit}`]).ok) continue;
      git(dir, ["fetch", "-q", remote, `+refs/heads/${repo.branch}:refs/remotes/${remote}/${repo.branch}`]);
      const start = `${remote}/${repo.branch}`;
      const name = repo.repo === "." ? "the repo" : repo.repo;
      const clean = git(dir, ["status", "--porcelain"]).stdout.trim() === "";
      if (clean && git(dir, ["switch", "-q", "-c", unit, start]).ok) earlyLines.push(`You are on branch ${unit} in ${name} now.`);
      else if (git(dir, ["branch", unit, start]).ok) {
        earlyLines.push(`Branch ${unit} in ${name} starts there; your uncommitted changes kept you on your branch, so switch when you are ready.`);
      }
    }
  }
  if (earlyOn) {
    const names = [...new Set(earlyOn.flatMap((dep) => dep.repos.map((repo) => (repo.repo === "." ? "the repo" : repo.repo))))];
    earlyLines.unshift(
      `It starts early on the pushed branch of ${joinNames(earlyOn.map((dep) => dep.unit))} in ${joinNames(names)}. ` +
        "It may still change before it merges.",
    );
  }
  // The likely repos this workspace has no checkout of, said with the way to one.
  const likely = unitLikelyRepos(pd, home.dirName, home.space).get(unit) ?? [];
  const missing = [...new Set(likely.map((repo) => repo.split("/")[0]))]
    .filter((repo) => home.repos.includes(repo) && !isGitRepoDir(repoDir(pd, repo)));
  if (resultByFile) {
    withAuditLock(pd, () => {
      const content = readStateFile(pd, build.dirName, build.space);
      writeStateFile(pd, setOrInsertField(content, "## Runtime State", "Home Result", "by file"), build.dirName, build.space);
    });
  }
  console.log(JSON.stringify({
    taken: true,
    unit,
    team,
    space: build.space,
    record: build.dirName,
    notice: `${unit.charAt(0).toUpperCase()}${unit.slice(1)} is yours, for ${theTeam(team)}. Its build is its own ` +
      `piece of work here, under your team's rules, from what the home approved.` +
      (resultByFile
        ? ` You can read the home but not write to it, so the result of ${unit} goes back as a file when it is built.`
        : "") +
      earlyLines.map((line) => ` ${line}`).join("") +
      missing.map((repo) => ` ${repoNotThereLine(pd, repo)}`).join("") +
      (planChanging !== null
        ? ` The home is changing the Unit plan (${planChanging} is open again there), so ${unit} is taken on the plan as it stands there.`
        : ""),
  }));
}

// Git that talks to a remote nobody typed a command for (the claims fetch, the
// merge check's reads and its write of the verdict): it never asks for a
// password, a passphrase or a sign-in (git, an askpass program, Git Credential
// Manager and ssh are each told not to, for these calls only; the person's
// config is left as it is), so a step never waits on a window or a prompt. Each
// call reads the repo it runs in, so a code repo's own ssh setup (a deploy key,
// an includeIf) is the one used. A stalled transfer ends by git's own low-speed
// limit; a read gives up after a short while, and a fetch or push, which writes
// in the person's repo, only at a ceiling that keeps a step from never ending.
// The read limit: a hosted remote answers an ls-remote in well under a second
// (0.1 to 0.9 s to GitHub, GitLab and Bitbucket over https, measured), so five
// seconds sees a slow link and holds an offline step no longer than that.
const QUIET_READ_TIMEOUT_MS = 5_000;
const QUIET_WRITE_CEILING_MS = 120_000;
let quiet = false;

function quietEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    // Set and empty: git then runs no askpass program (an editor's sign-in window).
    GIT_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    GIT_HTTP_LOW_SPEED_LIMIT: "1000",
    GIT_HTTP_LOW_SPEED_TIME: "30",
  };
  // GIT_SSH alone names the person's own ssh program (plink, say): left as it is.
  if (process.env.GIT_SSH && !process.env.GIT_SSH_COMMAND) return env;
  const ssh = process.env.GIT_SSH_COMMAND ||
    spawnSync("git", ["config", "--get", "core.sshCommand"], { cwd: dir, encoding: "utf-8" }).stdout?.trim() || "ssh";
  // Only OpenSSH takes these options; another program is left as it is.
  const program = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(ssh);
  const name = (program?.[1] ?? program?.[2] ?? program?.[3] ?? "").split(/[\\/]/).at(-1)?.toLowerCase();
  if (name === "ssh" || name === "ssh.exe") env.GIT_SSH_COMMAND = `${ssh} -o BatchMode=yes -o ConnectTimeout=15`;
  return env;
}

function quietly<T>(work: () => T): T {
  if (quiet) return work();
  quiet = true;
  try {
    return work();
  } finally {
    quiet = false;
  }
}

// A fetch on a step nobody typed looks first, with an ls-remote that writes
// nothing and so may stop at the read limit, and fetches only when the remote
// has something these refs do not; the fetch then runs to the write ceiling.
function quietFetch(dir: string, args: string[]): GitResult {
  return quietly(() => {
    const [remote, ...specs] = args.filter((arg) => !arg.startsWith("-"));
    if (remote === undefined || specs.length === 0) return git(dir, ["fetch", ...args]);
    const sources = specs.map((spec) => spec.replace(/^\+/, "").split(":")[0]);
    const listed = git(dir, ["ls-remote", remote, ...sources]);
    if (!listed.ok) return listed;
    // Where each listed ref lands here: the refspec's own target, or the
    // remote-tracking branch a named remote's branch fetch updates.
    const landsAt = (ref: string): string | null => {
      for (const spec of specs) {
        const [src, dst] = spec.replace(/^\+/, "").split(":");
        if (dst === undefined) {
          if (!isGitAddress(remote) && (ref === src || ref === `refs/heads/${src}`)) return `refs/remotes/${remote}/${ref.slice("refs/heads/".length)}`;
        } else if (src.endsWith("*")) {
          if (ref.startsWith(src.slice(0, -1))) return `${dst.slice(0, -1)}${ref.slice(src.length - 1)}`;
        } else if (ref === src) return dst;
      }
      return null;
    };
    // A branch fetched by an address lands in FETCH_HEAD only: nothing here to compare.
    const unmapped = isGitAddress(remote) && specs.some((spec) => !spec.includes(":"));
    const behind = unmapped || listed.stdout.split(/\r?\n/).filter(Boolean).some((line) => {
      const [oid, ref] = line.split("\t");
      const at = landsAt(ref ?? "");
      return at !== null && git(dir, ["rev-parse", "--verify", "--quiet", at]).stdout.trim() !== oid;
    });
    return behind ? git(dir, ["fetch", ...args]) : { ok: true, stdout: "", stderr: "", code: 0 };
  });
}

// The work's claims as the home has them now, fetched into the refs the
// person's own fetch uses (through this workspace's remote, or by the home's
// address into AI-DLC's own refs), so nobody has to fetch to see what the other
// side sent. Once per chat, at every step that shows or acts on the claims
// (`now`), and with `sincePerson` again after each message of the person's
// once the last fetch reached the home (both stamps are to the second, so a
// message in the fetch's own second counts as after it). `unreached` is the
// remote or address that could not be reached: the last fetch stands.
const CLAIMS_FETCHED_FILE = "claims-fetched.json";

export function refreshHomeClaims(
  projectDir: string,
  options: { home?: { target: string | null; id8: string }; sessionId?: string; now?: boolean; sincePerson?: boolean } = {},
): { fetched: boolean; unreached: string | null } {
  const pd = resolveProjectDir(projectDir);
  const { target, id8 } = options.home ?? { target: repositoryRemote(pd), id8: activeIdentity(pd).intentId8 };
  if (target === null) return { fetched: false, unreached: null };
  const mark = join(sessionsDir(pd), CLAIMS_FETCHED_FILE);
  let chats: Record<string, string | { chat: string; at: string; reached: boolean }> = {};
  try {
    chats = JSON.parse(readFileSync(mark, "utf-8")) as typeof chats;
  } catch {
    // No fetch noted yet.
  }
  const chat = options.sessionId ?? "no chat";
  const noted = chats[id8];
  const last = typeof noted === "string" ? { chat: noted, at: "", reached: false } : noted;
  const spoke = options.sincePerson === true && last?.chat === chat && last.reached &&
    readAuditShardEvents(pd).some((row) => isRequestTurn(row) && row.timestamp >= last.at);
  if (!options.now && !spoke && last?.chat === chat) return { fetched: false, unreached: null };
  const into = isGitAddress(target) ? `refs/aidlc/home/${id8}/claim/${id8}` : `refs/remotes/${target}/claim/${id8}`;
  const at = isoTimestamp();
  const ok = quietFetch(pd, ["--no-tags", "--no-filter", "-q", target, `+refs/heads/claim/${id8}/*:${into}/*`]).ok;
  try {
    mkdirSync(dirname(mark), { recursive: true });
    writeFileAtomic(mark, `${JSON.stringify({ ...chats, [id8]: { chat, at, reached: ok } })}\n`);
  } catch {
    // Unnoted, the next step fetches again.
  }
  return { fetched: ok, unreached: ok ? null : target };
}

// The claims of a home's work listed in this workspace, fetched as
// refreshHomeClaims decides; nothing for work no team builds.
export function refreshListedHome(
  projectDir: string,
  dirName: string,
  space: string,
  options: { sessionId?: string; now?: boolean },
): { fetched: boolean; unreached: string | null } {
  try {
    return refreshHomeClaims(projectDir, { home: findHomeWork(projectDir, dirName, space), ...options });
  } catch {
    return { fetched: false, unreached: null };
  }
}

// The Units of a piece of work a teammate took, as the claims git last brought in have them.
export function unitsTaken(projectDir: string, space: string, intentUuid: string): Set<string> {
  try {
    return new Set([...cachedClaimsForIdentity(projectDir, { space, intentUuid, intentId8: idSuffix(intentUuid) }, false).values()]
      .filter((claim) => claim.status === "claimed" && claim.payload.taken_by !== undefined).map((claim) => claim.unit));
  } catch {
    return new Set();
  }
}

// A claim at the home's address: fetched so its payload can be read.
function ensureFetchedClaim(projectDir: string, home: HomeWork, ref: string): void {
  if (home.target === null || !isGitAddress(home.target)) return;
  quietFetch(projectDir, ["--no-tags", home.target, `+${ref}:refs/aidlc/home/${home.id8}/${ref.slice("refs/heads/".length)}`]);
}

// --- Sending a Unit's build home ----------------------------------------------
//
// The push the person asks for: in each repo the Unit changed, a commit of
// exactly the paths its Code Generation recorded writing, on the Unit's branch,
// pushed to that repo's own remote with their login, identity, signing and
// hooks (no force, no --no-verify); then the result on the claim at the home.
// Their other uncommitted work is never committed or lost: it comes along
// uncommitted onto the Unit's branch, as git does on a switch, and the line
// says where they are and the way back.

// A build taken by file because the home took no push then (its record is
// here, the claim held for this team, not taken): the claim taken now, or null
// when the home still takes no push or this build is a hand-off.
function takeClaimNow(projectDir: string, build: UnitBuild): UnitClaimView | null {
  try {
    const home = buildsHome(projectDir, build);
    const ref = claimRef(home.id8, build.unit);
    if (home.target !== null) ensureFetchedClaim(projectDir, home, ref);
    const current = currentClaim(projectDir, home.target, ref);
    if (current?.status !== "claimed" || current.payload.taken_by !== undefined || current.payload.by_file) return null;
    const payload: UnitClaimPayload = {
      ...current.payload,
      predecessor_oid: current.oid,
      taken_by: git(projectDir, ["config", "user.name"]).stdout.trim() || "a teammate",
    };
    if (!updateClaimRef(projectDir, home.target, ref, createClaimCommit(projectDir, current.oid, payload), current.oid).ok) return null;
    invalidateLiveClaimPayloadCache(projectDir, build.unit);
    return currentClaim(projectDir, home.target, ref);
  } catch {
    return null;
  }
}

// Whether a repo of the push holds changes of the person's beyond the Unit's.
function ownChanges(planned: ReadonlyArray<{ dir: string }>): boolean {
  return planned.some(({ dir }) => git(dir, ["status", "--porcelain"]).stdout.trim() !== "");
}

function buildsHome(projectDir: string, build: UnitBuild): HomeWork {
  const at = build.homeRecord.indexOf("/");
  return findHomeWork(projectDir, build.homeRecord.slice(at + 1), build.homeRecord.slice(0, at));
}

// The remote a push of the Unit's branch goes to, in git's own order: the
// branch's pushRemote, remote.pushDefault, the branch's remote, then origin or
// the one remote. Several remotes and none of these set: the person's pick, or
// the remotes to put to them.
function pushRemoteOf(dir: string, branch: string, picked?: string): string | { remotes: string[] } | null {
  for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`]) {
    const set = git(dir, ["config", "--get", key]).stdout.trim();
    if (set) return set;
  }
  const remotes = git(dir, ["remote"]).stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  if (picked !== undefined && remotes.includes(picked)) return picked;
  if (remotes.includes("origin")) return "origin";
  if (remotes.length <= 1) return remotes[0] ?? null;
  return { remotes };
}

// The Unit's repos whose push remote only the person can name, with each one's remotes.
export function pushRemotesToPick(projectDir: string, unit: string, repos: string[]): Array<{ repo: string; remotes: string[] }> {
  const open: Array<{ repo: string; remotes: string[] }> = [];
  for (const repo of repos) {
    const dir = repo === "." ? projectDir : repoDir(projectDir, repo);
    const found = isGitRepoDir(dir) ? pushRemoteOf(dir, unit) : null;
    if (found !== null && typeof found === "object") open.push({ repo, remotes: found.remotes });
  }
  return open;
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
    withAuditLock(pd, () => writeStateFile(pd, setOrInsertField(readStateFile(pd), "## Runtime State", UNIT_PUSH_FIELD, "later")));
    finishBuildRecord(pd);
    console.log(JSON.stringify({ pushed: false, notice: `Nothing is pushed. I'll push ${unit} when you want it to go home.` }));
    return;
  }
  // A repo the Unit changed that the home's plan did not list is fine
  // (decision 5): it is added to the build's repos, said once, and pushed.
  let manifest = readUnitSourceManifest(pd, "code-generation", unit);
  const addedRepos: string[] = [];
  while (!manifest.ok && manifest.unrecordedRepo !== undefined && !addedRepos.includes(manifest.unrecordedRepo)) {
    const repo = manifest.unrecordedRepo;
    const added = runEngineUtility(pd, ["intent", "add-repo", repo]);
    if (!added.ok) fail(`${unit} changed ${repo}, which the home's plan did not list, and it could not be added: ${(added.stderr || added.stdout).trim()}`);
    addedRepos.push(repo);
    manifest = readUnitSourceManifest(pd, "code-generation", unit);
  }
  if (!manifest.ok) fail(`${unit} has no record of what its Code Generation wrote yet (${manifest.reason}).`);
  const byRepo = writesByRepo(pd, manifest.manifest.writes);
  // The person's pick of a push remote, per repo: `--remote <repo>=<name>[,...]`.
  const picked = new Map((flags.remote ?? "").split(",").map((pair) => pair.split("=").map((part) => part.trim()))
    .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== "" && pair[1] !== ""));
  // A build by file has no home to reach; its result goes back as a file.
  let byFile = getField(state, "Home Result")?.trim() === "by file";
  const reached: string[] = [];
  // Taken from a home that took no push then: it may take one now.
  let claim = byFile ? takeClaimNow(pd, build) : null;
  if (claim !== null) {
    byFile = false;
    withAuditLock(pd, () => writeStateFile(pd, removeField(readStateFile(pd), "Home Result")));
    reached.push(`The home takes pushes from here now, so ${unit}'s result goes home by git.`);
  }
  const home = byFile ? null : buildsHome(pd, build);
  const ref = home === null ? null : claimRef(home.id8, unit);
  if (claim === null && home !== null && ref !== null) {
    if (home.target !== null) ensureFetchedClaim(pd, home, ref);
    claim = currentClaim(pd, home.target, ref);
  }
  const label = getField(state, "Home Label")?.trim() || build.homeRecord;
  const earlier = new Map((claim?.payload.result?.repos ?? []).map((repo) => [repo.repo, repo]));
  const results: RepoResult[] = [];
  const takeTree = readTakeTree(activeRecordDir(pd));
  const leftOut: string[] = [];
  // Every repo first: there, and a remote to push to.
  const planned: Array<{ repo: string; dir: string; name: string; remote: string; paths: string[] }> = [];
  for (const [repo, paths] of byRepo) {
    const dir = repo === "." ? pd : repoDir(pd, repo);
    if (!isGitRepoDir(dir)) fail(repoNotThereLine(pd, repo));
    const name = repo === "." ? "the repo" : repo;
    const remote = pushRemoteOf(dir, unit, picked.get(repo));
    if (remote === null) fail(`${name} has no remote to push ${unit} to.`);
    if (typeof remote === "object") {
      fail(`${name} has the remotes ${joinNames(remote.remotes)} and none is set for pushing: ask the person which one ${unit} goes to.`);
    }
    // Files Code Generation wrote outside the repo it named (at the workspace
    // root, say) are not in it: said in plain words, with the way back. A file
    // the manifest gives by its path from the workspace that is in the repo is
    // said as that, never as outside it; the way back is the same, since only
    // Code Generation records a new manifest for the review.
    const missing = repo === "." ? [] : paths.filter((path) => !existsSync(join(dir, path)) && existsSync(join(pd, path)));
    const inRepo = (path: string): string | null => {
      const there = relative(resolve(dir), resolve(pd, path));
      return there === "" || there.startsWith("..") || isAbsolute(there) ? null : there.split(sep).join("/");
    };
    const outside = missing.filter((path) => inRepo(path) === null);
    const fromWorkspace = missing.filter((path) => inRepo(path) !== null);
    if (outside.length === 0 && fromWorkspace.length > 0) {
      const more = fromWorkspace.length > 1 ? ` and ${fromWorkspace.length - 1} more` : "";
      const one = fromWorkspace.length === 1;
      fail(
        `${unit}'s Code Generation recorded ${fromWorkspace[0]}${more} by ${one ? "its" : "their"} path from the workspace, not from ` +
          `${name} (in ${name}, ${inRepo(fromWorkspace[0])}${more}), so nothing was pushed. Ask the person whether to take ${unit} ` +
          `back to Code Generation to record ${one ? "it" : "them"} by ${one ? "its" : "their"} path in ${name}; on their yes, run ` +
          `\`${aidlcToolInvocation("orchestrate")} report --result resumed --choice redo --target code-generation\` and follow what it returns.`,
      );
    }
    if (outside.length > 0) {
      fail(
        `${unit}'s Code Generation wrote ${outside[0]}${outside.length > 1 ? ` and ${outside.length - 1} more` : ""} outside ${name}, ` +
          `so nothing was pushed. Ask the person whether to take ${unit} back to Code Generation to write ${outside.length === 1 ? "it" : "them"} ` +
          `in ${name}; on their yes, run \`${aidlcToolInvocation("orchestrate")} report --result resumed --choice redo --target code-generation\` ` +
          "and follow what it returns.",
      );
    }
    planned.push({ repo, dir, name, remote, paths });
  }
  // Then in each, onto the Unit's branch as their own hands would and its
  // commit made with their git (hooks, signing, identity), before anything is
  // pushed: a hook that stops one pushes nothing.
  const moved: Array<{ name: string; from: string }> = [];
  const along: string[] = [];
  const whereNow = (done = false): string =>
    whereNowLine(unit, moved, done && ownChanges(planned) ? "; your other changes are still yours, uncommitted" : "");
  for (const { repo, dir, name, remote, paths } of planned) {
    const from = git(dir, ["branch", "--show-current"]).stdout.trim();
    if (from !== unit) {
      const exists = git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${unit}`]).ok;
      let switched = false;
      let said = "";
      if (exists) ({ ok: switched, said } = switchOntoUnitBranch(dir, unit, paths));
      else {
        // From the shared integration branch, fetched, when their working tree
        // allows; the workspace itself, which holds AI-DLC's record of this
        // build, and a tree that does not allow it start where they are.
        const integration = repoIntegration(dir, remote);
        if (repo !== ".") {
          git(dir, ["fetch", "-q", remote, integration.slice(remote.length + 1)]);
          switched = git(dir, ["switch", "-q", "-c", unit, integration]).ok;
        }
        if (!switched) {
          const tried = git(dir, ["switch", "-q", "-c", unit]);
          switched = tried.ok;
          said = tried.stderr;
          const subjects = git(dir, ["log", "--format=%s", `${integration}..HEAD`]).stdout.split(/\r?\n/).filter(Boolean);
          if (switched && subjects.length > 0) {
            along.push(`Branch ${unit} in ${name} starts from where you were, so your ${subjects.length === 1 ? "commit" : `${subjects.length} commits`} ` +
              `not yet on ${integration} come${subjects.length === 1 ? "s" : ""} along: ` +
              `${subjects.slice(0, 3).map((subject) => `"${subject}"`).join(", ")}${subjects.length > 3 ? " and more" : ""}.`);
          }
        }
      }
      if (!switched) {
        fail(`Branch ${unit} could not be checked out in ${name}, so nothing was pushed.${said.trim() ? ` Git says: "${gitSaid(said)}".` : ""}` +
          `${exists ? ` Your own changes there stay as they are; once they are committed or put aside, I can push ${unit}.` : ""}${whereNow()}`);
      }
      moved.push({ name, from: from || "the commit you were on" });
    }
    try {
      for (const path of commitUnitPaths(dir, paths, takeTree[repo] ?? {}, unit, label, name)) leftOut.push(`${path} in ${name}`);
    } catch (error) {
      fail(`${errorMessage(error).replace(/([^.!?])$/, "$1.")} Nothing was pushed.${whereNow()}`);
    }
    if (takeTree[repo] !== undefined) writeTakeTree(activeRecordDir(pd), takeTree);
  }
  for (const { repo, dir, name, remote, paths } of planned) {
    const pushed = git(dir, ["push", "-u", remote, unit]);
    if (!pushed.ok) fail(`The push of ${unit} in ${name} was refused: ${pushRefusal(pushed.stderr)}. Nothing was retried.${whereNow()}`);
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const base = earlier.get(repo)?.base ??
      (git(dir, ["merge-base", "HEAD", repoIntegration(dir, remote)]).stdout.trim() || head);
    const changed = git(dir, ["diff", "--name-only", "--no-renames", base, head, "--", ...paths]).stdout.split(/\r?\n/).filter(Boolean);
    const blobs = blobsAt(dir, head, changed);
    const entry: RepoResult = {
      repo,
      branch: unit,
      base,
      heads: [...new Set([...(earlier.get(repo)?.heads ?? []), head])],
      paths: Object.fromEntries(changed.map((path) => [path, blobs.get(path) ?? null])),
      ...(() => {
        const id = patchIdOf(dir, base, head, changed);
        return id ? { patch_id: id } : {};
      })(),
    };
    // For a home that cannot fetch this repo, the team's own check goes with
    // the result file, recorded at the home as the team's word.
    if (byFile) {
      git(dir, ["fetch", "-q", remote]);
      const verdict = unitMergeVerdict(dir, repoIntegration(dir, remote), entry);
      entry.reported = verdict.merged ? { merged: true, commit: verdict.commit } : { merged: false };
    }
    results.push(entry);
  }
  const names = results.map((repo) => (repo.repo === "." ? "the repo" : repo.repo));
  const lines = [`Pushed branch ${unit} in ${joinNames(names)}. Open a PR in ${names.length === 1 ? "it" : "each"} your usual way.${whereNow(true)}`];
  if (addedRepos.length > 0) {
    lines.push(`${joinNames(addedRepos)} ${addedRepos.length === 1 ? "was" : "were"} not in the home's plan; ${unit} changed ` +
      `${addedRepos.length === 1 ? "it" : "them"}, so ${addedRepos.length === 1 ? "it is" : "they are"} now among ${unit}'s repos and went with the push.`);
  }
  lines.push(...along);
  if (leftOut.length > 0) {
    lines.push(`${joinNames(leftOut)} ${leftOut.length === 1 ? "is" : "are"} not in the commit: ${leftOut.length === 1 ? "it" : "each"} ` +
      `already had a change of yours when ${unit} was taken, and ${unit}'s own change could not be kept apart from it. ` +
      `Both are still in the file, uncommitted.`);
  }
  // The result goes home on the claim, with the Unit outputs the home's later
  // stages read; a home that takes no push from here gets it as a file.
  const outputs = unitOutputsHomeReads(unit, getField(state, "Scope") ?? "")
    .filter((rel) => existsSync(join(activeRecordDir(pd), ...rel.split("/"))));
  const result: UnitResult = { by: git(pd, ["config", "user.name"]).stdout.trim() || "a teammate", repos: results, outputs };
  lines.push(...reached);
  let homeHasIt = true;
  if (claim === null || ref === null || home === null) {
    const rel = handFilePath(label, unit, "-result");
    writeHandFile(pd, rel, renderHandFile(
      "result",
      `Result: ${unit} of ${label}`,
      "Point AI-DLC at this file at the home and it takes it in.",
      {
        "Home Work": build.homeWork,
        "Home Label": label,
        Unit: unit,
        Attempt: String(build.attempt),
        Team: activeSpace(pd),
        "Built By": result.by,
        Written: isoTimestamp(),
      },
      new Map(outputs.map((rel) => [rel, readFileSync(join(activeRecordDir(pd), ...rel.split("/")), "utf-8")])),
      result,
    ));
    lines.push(`The result file is ${rel}; send it to the lead.`);
  } else {
    const files = Object.fromEntries(outputs.map((rel) => [
      `${RESULT_FILES_ROOT}/${rel}`,
      readFileSync(join(activeRecordDir(pd), ...rel.split("/")), "utf-8"),
    ]));
    // A push after a turn-down is the team's answer to it. The lead's word that
    // a repo merged holds only for a repo whose head did not change.
    const saidMerged = (claim.payload.said_merged ?? []).filter((entry) =>
      earlier.get(entry.repo)?.heads.at(-1) === results.find((repo) => repo.repo === entry.repo)?.heads.at(-1));
    const payload: UnitClaimPayload = {
      ...claim.payload,
      predecessor_oid: claim.oid,
      result,
      verdicts: undefined,
      turned_down: undefined,
      said_merged: saidMerged.length > 0 ? saidMerged : undefined,
    };
    const commit = createClaimCommit(pd, claim.oid, payload, undefined, undefined, files);
    const sent = updateClaimRef(pd, home.target, ref, commit, claim.oid);
    if (!sent.ok) lines.push(`The home did not take ${unit}'s result: ${sent.refused ?? "its claim moved meanwhile"}. Do you want me to send it again?`);
    else invalidateLiveClaimPayloadCache(pd, unit);
    homeHasIt = sent.ok;
  }
  withAuditLock(pd, () => {
    // Pushed once the result reached the home (or its file is written); until
    // then the build offers to send the result again.
    writeStateFile(pd, setOrInsertField(readStateFile(pd), "## Runtime State", UNIT_PUSH_FIELD, homeHasIt ? "pushed" : "unsent"));
    appendAuditEntryUnlocked("UNIT_PUSHED", {
      Unit: unit,
      Branch: unit,
      Repos: results.map((repo) => `${repo.repo}@${repo.heads.at(-1)}`).join(", "),
    }, pd);
  });
  if (homeHasIt) finishBuildRecord(pd);
  console.log(JSON.stringify({ pushed: true, unit, repos: results.map((repo) => repo.repo), notice: lines.join(" ") }));
}

// The build's record finishes once its push reached home or the person put it
// off (buildWaitsForPush keeps it open until then), when its last stage is
// approved; the state tool's own completion writes it. The push stands either
// way: a completion the state tool refuses leaves the build's end to `next`.
function finishBuildRecord(pd: string): void {
  const state = readStateFile(pd);
  const last = getField(state, "Current Stage")?.trim();
  if (getField(state, "Status")?.trim() === "Completed" || !last) return;
  if (!state.split(/\r?\n/).some((line) => line.startsWith(`- [x] ${last} `))) return;
  const [command, ...args] = aidlcEngineCommand(
    "state",
    ["complete-workflow", last, "--project-dir", pd],
    join(dirname(fileURLToPath(import.meta.url)), "aidlc-state.ts"),
    isCompiledExecutable() ? process.execPath : null,
  );
  spawnSync(command, args, { cwd: pd, encoding: "utf-8", env: process.env });
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
// `unreached` collects the remotes that could not be read, `unsent` the ones
// that did not take a verdict, `told` each Unit whose newly seen merge the
// teams now have on its claim (the repos it merged in, and whether it is done).
export interface ToldMerge {
  unit: string;
  repos: string[];
  done: boolean;
}

// `readOnly` (a query such as `team-board`): the same verdicts, nothing written.
export function checkTeamResults(
  projectDir: string,
  unreached?: string[],
  unsent?: string[],
  told?: ToldMerge[],
  readOnly = false,
): Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }> {
  const pd = resolveProjectDir(projectDir);
  return quietly(() => checkTeamResultsQuietly(pd, unreached, unsent, told, readOnly));
}

function checkTeamResultsQuietly(
  pd: string,
  unreached?: string[],
  unsent?: string[],
  told?: ToldMerge[],
  readOnly = false,
): Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }> {
  const found = new Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }>();
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  for (const [unit, claim] of cachedClaims(pd)) {
    if (claim.status !== "claimed" || claim.payload.result === undefined) continue;
    // Done on its claim is the home's own word, wherever it was recorded: a
    // fresh clone or another machine of the home records it here too.
    if (claim.payload.done) {
      if (!readOnly) recordUnitDone(pd, claim, claim.payload.verdicts ?? []);
      found.set(unit, { team: claim.owner, verdicts: claim.payload.verdicts ?? [], done: true });
      continue;
    }
    let live: UnitClaimView | null;
    try {
      live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
    } catch {
      unreached?.push(remote ?? "the home");
      continue;
    }
    const result = live?.payload.result;
    if (live?.status !== "claimed" || !result) continue;
    const verdicts = result.repos.map((repo) => {
      const said = live.payload.said_merged?.find((entry) => entry.repo === repo.repo);
      if (said) return { repo: repo.repo, merged: true, how: `by your word: "${said.words}"` };
      const dir = repo.repo === "." ? pd : repoDir(pd, repo.repo);
      if (!isGitRepoDir(dir)) {
        // The team's own word, kept as theirs until the home can check the repo.
        return repo.reported?.merged
          ? { repo: repo.repo, merged: true, commit: repo.reported.commit, how: `reported by ${live.owner}` }
          : { repo: repo.repo, merged: false };
      }
      const repoRemote = repositoryRemote(dir);
      const integration = repoRemote === null ? "HEAD" : repoIntegration(dir, repoRemote);
      // Only the branch the Unit merges into.
      if (repoRemote !== null && !quietFetch(dir, ["-q", repoRemote, integration.slice(repoRemote.length + 1)]).ok) {
        unreached?.push(repo.repo === "." ? repoRemote : repo.repo);
      }
      const verdict = unitMergeVerdict(dir, integration, repo);
      return verdict.merged ? { repo: repo.repo, merged: true, commit: verdict.commit, how: verdict.how } : { repo: repo.repo, merged: false };
    });
    const done = verdicts.length > 0 && verdicts.every((verdict) => verdict.merged) &&
      (!leadSignOffOn(readStateFile(pd)) || live.payload.signoff !== undefined);
    // The one thing written back is a merge the home has seen: a look at the
    // board that sees no new merge leaves the claim as the team sent it.
    const newlyMerged = verdicts.filter((verdict) => verdict.merged &&
      !(live.payload.verdicts ?? []).some((before) => before.repo === verdict.repo && before.merged)).map((verdict) => verdict.repo);
    if (done && !readOnly) recordUnitDone(pd, live, verdicts);
    if (!readOnly && (newlyMerged.length > 0 || done)) {
      const payload: UnitClaimPayload = { ...live.payload, predecessor_oid: live.oid, verdicts, ...(done ? { done: true as const } : {}) };
      const commit = createClaimCommit(pd, live.oid, payload);
      // Unwritten, the verdict stays here and the next step writes it again.
      if (updateClaimRef(pd, remote, live.ref, commit, live.oid).ok) {
        invalidateLiveClaimPayloadCache(pd, unit);
        told?.push({ unit, repos: newlyMerged, done });
      } else unsent?.push(remote ?? "the home");
    }
    found.set(unit, { team: live.owner, verdicts, done });
  }
  return found;
}

// At a home teams build for, once a forward jump skipped every Unit stage: a
// team's result that came back has nothing here to be recorded in, so it stays
// on its claim, said once in land's words; the Unit walk records it once the
// work is back on the first Unit stage (checkTeamResults runs only there). The
// claims are fetched once per chat and again after the person speaks.
export function homeResultsPastUnitStages(projectDir: string, stateContent: string, sessionId?: string): string | null {
  if (homeLocation(stateContent) === null || !hasAnyUnitClaimRefs(projectDir)) return null;
  // The Unit stages as the scope plans them: with no state, no skip is read.
  const stages = unitMajorConstructionStageSlugs(getField(stateContent, "Scope") ?? "", "", true);
  const skipped = unitStagesSkippedOnMain(projectDir, stages);
  if (skipped === null || stages.length === 0) return null;
  let back: UnitClaimView[];
  try {
    if (!isReadOnlyEngineProbe()) refreshHomeClaims(projectDir, { sessionId, sincePerson: true });
    back = [...cachedClaims(projectDir).values()]
      .filter((claim) => claim.status === "claimed" && claim.payload.result !== undefined && !claim.payload.done);
  } catch {
    return null;
  }
  if (back.length === 0) return null;
  const one = back.length === 1;
  return `${joinNames(back.map((claim) => `${claim.unit} (from ${claim.owner})`))} ${one ? "is" : "are"} back but not ` +
    `recorded yet: ${skipped}. This work takes ${one ? "it" : "them"} in once it is back on ${stages[0]}, ` +
    "and going back starts the Unit stages again here.";
}

// Once per Unit and attempt: its outputs written into the home's record, then UNIT_MERGED.
function recordUnitDone(projectDir: string, claim: UnitClaimView, verdicts: NonNullable<UnitClaimPayload["verdicts"]>): void {
  const recorded = (): boolean => readAuditShardEvents(projectDir).some((row) =>
    row.event === "UNIT_MERGED" && auditBlockField(row.block, "Unit") === claim.unit &&
    auditBlockField(row.block, "Attempt Generation") === String(claim.generation)
  );
  if (recorded()) return;
  const record = activeRecordDir(projectDir);
  const reads = new Set(unitOutputsHomeReads(claim.unit, getField(readStateFile(projectDir), "Scope") ?? ""));
  for (const rel of (claim.payload.result?.outputs ?? []).filter((output) => reads.has(output))) {
    const shown = git(projectDir, ["show", `${claim.oid}:${RESULT_FILES_ROOT}/${rel}`, "--"]);
    if (!shown.ok) continue;
    mkdirSync(dirname(join(record, ...rel.split("/"))), { recursive: true });
    writeFileSync(join(record, ...rel.split("/")), shown.stdout, "utf-8");
  }
  withAuditLock(projectDir, () => {
    if (recorded()) return;
    appendAuditEntryUnlocked("UNIT_MERGED", {
      Unit: claim.unit,
      Owner: claim.owner,
      "Built By": claim.payload.result?.by ?? claim.payload.taken_by ?? claim.owner,
      "Merged In": verdicts.map((verdict) => `${verdict.repo}${verdict.commit ? `@${verdict.commit}` : ""} (${verdict.how})`).join(", "),
      "Attempt Generation": String(claim.generation),
    }, projectDir);
  });
}

// The home's turn-down of this build's Unit, as the claims git last brought in
// have it; null when it is not turned down (or the claims are not here). A
// turned-down build is not finished: its record reads as work under way again,
// so the person's turns in it count and their way back runs.
export function reopenTurnedDownBuild(projectDir: string, stateContent: string): { repo: string } | null {
  const build = unitBuildOf(stateContent);
  if (build === null) return null;
  try {
    const space = build.homeRecord.slice(0, build.homeRecord.indexOf("/"));
    const mine = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false)
      .get(build.unit);
    if (!mine?.payload.turned_down || mine.payload.done) return null;
    if (getField(stateContent, "Status") === "Completed" && !isReadOnlyEngineProbe()) {
      withAuditLock(projectDir, () => writeStateFile(projectDir, setField(readStateFile(projectDir), "Status", "Running")));
    }
    return { repo: mine.payload.turned_down.repo };
  } catch {
    return null;
  }
}

// What the home said about this build's Unit, read from the claims git last
// brought in, each said once: a turn-down in the home's words, the home's
// answer to a proposal, a Unit it started early on that is now done or turned
// down, and an input the home amended (the copy here takes the new version,
// and the stages that used it read as current, on every Guard Policy).
export function buildClaimNotes(projectDir: string, stateContent: string, sessionId?: string): string[] {
  const build = unitBuildOf(stateContent);
  if (build === null) return [];
  const space = build.homeRecord.slice(0, build.homeRecord.indexOf("/"));
  const lines: string[] = [];
  if (!isReadOnlyEngineProbe() && getField(stateContent, "Home Result")?.trim() !== "by file") {
    let home: HomeWork | null = null;
    try {
      home = buildsHome(projectDir, build);
    } catch {
      // The home's record is not here: what this workspace has stands.
    }
    // A pushed build waits on the home's answer: each step of it fetches.
    const waits = getField(stateContent, UNIT_PUSH_FIELD)?.trim() === "pushed";
    if (home !== null && refreshHomeClaims(projectDir, { home, sessionId, now: waits }).unreached !== null) {
      lines.push("The home could not be reached just now, so news from it may be behind.");
    }
  }
  let claims: Map<string, UnitClaimView>;
  try {
    claims = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false);
  } catch {
    return lines;
  }
  const mine = claims.get(build.unit);
  if (mine === undefined) return lines;
  const unit = build.unit;
  const down = mine.payload.turned_down;
  if (down) {
    lines.push(`${unit} was turned down in ${down.repo} at the home${down.words ? `: "${down.words}"` : ""}.`);
  }
  for (const proposal of mine.payload.proposals ?? []) {
    if (proposal.answer === "approved") lines.push(`The home approved your change to the ${inputName(proposal.input)}.`);
    if (proposal.answer === "turned down") {
      lines.push(`The home turned down your change to the ${inputName(proposal.input)}` +
        `${proposal.answer_words ? `: "${proposal.answer_words}"` : ""}. I'm carrying on with the approved one.`);
    }
  }
  // A Unit it started early on that is now done is offered as the move onto
  // the integration branch (earlyBaseMerged), not as a line.
  for (const dep of mine.payload.early_on ?? []) {
    const theirs = claims.get(dep.unit)?.payload;
    if (!theirs?.done && theirs?.turned_down) {
      lines.push(`${dep.unit} was turned down at the home; ${unit} started on its branch. Nothing else changes: wait for it, ` +
        "or rebase when you are ready.");
    }
  }
  if (isReadOnlyEngineProbe()) return lines;
  const record = recordDir(projectDir);
  for (const amendment of mine.payload.amendments ?? []) {
    if (record === null) break;
    // The team's own proposed copy is theirs while the lead decides: never
    // written back while that proposal waits.
    if ((mine.payload.proposals ?? []).some((entry) => entry.input === amendment.input && entry.answer === undefined)) continue;
    const shown = git(projectDir, ["show", `${mine.oid}:${RESULT_FILES_ROOT}/amendments/${amendment.input}`, "--"]);
    const path = join(record, ...amendment.input.split("/"));
    if (!shown.ok || (existsSync(path) && textFingerprint(readFileSync(path, "utf-8")) === textFingerprint(shown.stdout))) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, shown.stdout, "utf-8");
    const renewed = renewForAmendedInput(projectDir, amendment.input, { Unit: unit, "Amended At Home": amendment.at });
    const name = inputName(amendment.input);
    if (mine.payload.done) {
      lines.push(`The ${name} changed at the home after ${unit} was done. Do you want me to start follow-up work for it?`);
    } else if (getField(stateContent, UNIT_PUSH_FIELD)?.trim() === "pushed") {
      // Pushed and waiting on the home: it hears the change and nothing of it is reopened.
      lines.push(`The ${name} changed at the home after ${unit} was pushed; ${unit} stays as you pushed it.`);
    } else if (renewed.length > 0) {
      lines.push(staleStageLine(stageLabel(loadGraph().find((stage) => stage.slug === renewed[0]), renewed[0]) ?? renewed[0]));
    } else {
      lines.push(`The ${name} changed at the home; ${unit} uses the new one from here.`);
    }
  }
  return lines;
}

// The Units this build started early on that are now done at the home, and
// in each repo it started early in and is not on the integration branch yet,
// the git that moves it there for the way that repo merged the Unit: after a
// merge that kept its commits, a plain rebase; after a squash or a host's
// rebase (new commits), only the build's own commits, from the head it
// started on. A branch the person is on with no commits of its own yet (its
// code is committed at the push) moves with `reset --keep`, which keeps their
// uncommitted work, where a rebase would refuse it. `skip` leaves out a Unit
// before anything is fetched for it; for a Unit whose move git `refused` for
// the person's own changes, nothing is fetched while those are in the way (as
// the last look saw the integration branch), nor for a repo it moved in.
export function earlyBaseMerged(
  projectDir: string,
  stateContent: string,
  skip: (unit: string) => boolean = () => false,
  refused: (unit: string) => boolean = () => false,
): Array<{ unit: string; repos: Array<{ repo: string; name: string; dir: string; remote: string; onto: string; rebase: string[] }> }> {
  const build = unitBuildOf(stateContent);
  if (build === null) return [];
  const space = build.homeRecord.slice(0, build.homeRecord.indexOf("/"));
  let claims: Map<string, UnitClaimView>;
  try {
    claims = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false);
  } catch {
    return [];
  }
  return (claims.get(build.unit)?.payload.early_on ?? []).flatMap((dep) => {
    const theirs = claims.get(dep.unit)?.payload;
    if (!theirs?.done || skip(dep.unit)) return [];
    const moves = (from: typeof dep.repos, look: boolean) => from.flatMap(({ repo, head }) => {
      const dir = repo === "." ? projectDir : repoDir(projectDir, repo);
      const remote = isGitRepoDir(dir) ? repositoryRemote(dir) : null;
      if (remote === null || !git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${build.unit}`]).ok) return [];
      const onto = repoIntegration(dir, remote);
      // The integration branch as its remote has it now, with the merge.
      if (look) quietFetch(dir, ["-q", remote, onto.slice(remote.length + 1)]);
      if (git(dir, ["merge-base", "--is-ancestor", onto, `refs/heads/${build.unit}`]).ok) return [];
      const kept = theirs.verdicts?.find((verdict) => verdict.repo === repo)?.how === "ancestry";
      const own = head === "" || git(dir, ["rev-parse", `refs/heads/${build.unit}`]).stdout.trim() !== head;
      const on = git(dir, ["branch", "--show-current"]).stdout.trim() === build.unit;
      return [{
        repo,
        name: repo === "." ? "the repo" : repo,
        dir,
        remote,
        onto,
        rebase: on && !own ? ["reset", "-q", "--keep", onto]
          : kept || head === "" ? ["rebase", onto, build.unit] : ["rebase", "--onto", onto, head, build.unit],
      }];
    });
    const waiting = refused(dep.unit) ? moves(dep.repos, false) : null;
    if (waiting?.some((repo) => moveInTheWay(repo))) return [];
    const repos = moves(waiting === null ? dep.repos : dep.repos.filter(({ repo }) => waiting.some((left) => left.repo === repo)), true);
    return repos.length > 0 ? [{ unit: dep.unit, repos }] : [];
  });
}

// A rebase git stopped in a repo, waiting for the person.
function rebaseUnderWay(dir: string): boolean {
  return ["rebase-merge", "rebase-apply"].some((name) => existsSync(resolve(dir, git(dir, ["rev-parse", "--git-path", name]).stdout.trim())));
}

// Whether something of the person's would stop the move in a repo now: a
// rebase under way, a change to a tracked file (a rebase refuses any), or a
// change to a file `reset --keep` would replace.
function moveInTheWay(repo: { dir: string; onto: string; rebase: string[] }): boolean {
  if (rebaseUnderWay(repo.dir)) return true;
  const changed = git(repo.dir, ["diff", "-z", "--name-only", "HEAD"]).stdout.split("\0").filter(Boolean);
  if (repo.rebase[0] === "rebase") return changed.length > 0;
  const replaced = new Set(git(repo.dir, ["diff", "-z", "--name-only", "HEAD", repo.onto]).stdout.split("\0").filter(Boolean));
  return changed.some((path) => replaced.has(path));
}

export const moveRefusedMark = (dep: string): string => `unit-move-refused-${dep}`;

// Where a command that switched the person onto the Unit's branch left them,
// and the way back, in one wording for the push and the move.
function whereNowLine(unit: string, moved: Array<{ name: string; from: string }>, also = ""): string {
  if (moved.length === 0) return "";
  const back = [...new Set(moved.map((entry) => entry.from))];
  return ` You're on ${unit} now in ${joinNames(moved.map((entry) => entry.name))}${also}. ` +
    `Switch back to ${back.length === 1 ? back[0] : joinNames(moved.map((entry) => `${entry.from} in ${entry.name}`))} any time.`;
}

// The person's yes to moving the build onto the integration branch: in each
// repo, the integration branch fetched, then the rebase with their own git. A
// rebase git stops (a conflict, their uncommitted changes) is said in git's
// words with the way back; the repos before it stay moved.
function rebaseUnit(args: string[], projectDir?: string): void {
  parseArgs(args);
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  const build = unitBuildOf(state);
  if (build === null) fail("rebase moves a Unit's build onto the integration branch; this work is not one.");
  const moved: string[] = [];
  const onto = new Set<string>();
  // A rebase names the Unit's branch, so git switches to it first.
  const switched: Array<{ name: string; from: string }> = [];
  let replayed = false;
  for (const dep of earlyBaseMerged(pd, state)) {
    for (const repo of dep.repos) {
      const branch = repo.onto.slice(repo.remote.length + 1);
      git(repo.dir, ["fetch", "-q", repo.remote, branch]);
      const from = git(repo.dir, ["branch", "--show-current"]).stdout.trim();
      const ran = git(repo.dir, repo.rebase);
      if (!ran.ok) {
        const stopped = rebaseUnderWay(repo.dir);
        // Refused for their own changes: offered again once they are out of the way.
        if (!stopped) noteEngineAskMark(pd, moveRefusedMark(dep.unit));
        // A stopped rebase switched to the Unit's branch first, and its abort leaves them there.
        if (stopped && from !== build.unit) switched.push({ name: repo.name, from: from || "the commit you were on" });
        fail(`${build.unit} could not be moved onto ${branch} in ${repo.name}. Git says: "${gitSaid(ran.stderr || ran.stdout)}".` +
          (stopped ? ` To go back to where ${build.unit} was there, run git rebase --abort in ${repo.name}.` : "") +
          (moved.length > 0 ? ` In ${joinNames(moved)} it is on ${joinNames([...onto])} now.` : "") + whereNowLine(build.unit, switched));
      }
      moved.push(repo.name);
      onto.add(branch);
      if (repo.rebase[0] === "rebase") replayed = true;
      if (from !== build.unit) switched.push({ name: repo.name, from: from || "the commit you were on" });
    }
  }
  const notice = moved.length === 0
    ? `${build.unit} is on the integration branch already; nothing moved.`
    : `${build.unit} is on ${joinNames([...onto])} now in ${joinNames(moved)}${replayed ? ", with its own commits on top" : ""}. ` +
      `Nothing is pushed.${whereNowLine(build.unit, switched)}`;
  console.log(JSON.stringify({ moved: moved.length > 0, unit: build.unit, repos: moved, notice }));
}

// The finished stages of this work that used an amended input read as current:
// the person who owns it approved the change, so nothing is stale and nothing
// resets. Returns the stages renewed, in the work's order.
function renewForAmendedInput(projectDir: string, rel: string, extra: Record<string, string>): string[] {
  const at = artifactAt(rel);
  if (at === null) return [];
  const state = readStateFile(projectDir);
  const graph = loadGraph();
  const receipts = latestCompletionBasesFromAudit(readAllAuditShards(projectDir));
  const renewed: string[] = [];
  withAuditLock(projectDir, () => {
    for (const [stage, basis] of receipts) {
      if (![...basis.inputs, ...basis.outputs].some((entry) => entry.artifact === at.artifact && entry.producer === at.producer)) continue;
      const node = graph.find((entry) => entry.slug === stage);
      if (node === undefined) continue;
      appendAuditEntryUnlocked("SHARED_INPUT_AMENDED", {
        ...sharedInputAmendedFields(stage, captureStageValidationBasis(projectDir, node, state, graph), rel),
        ...extra,
      }, projectDir);
      renewed.push(stage);
    }
  });
  return renewed;
}

// A build proposes a change to one input it was approved with: from the
// person's own file, or their edited copy. The build carries on meanwhile.
function proposeChange(args: string[], projectDir?: string): void {
  const { flags } = parseArgs(args);
  if (!flags.input) fail("Usage: aidlc-unit propose --input <file it was approved with> [--file <changed text>] [--request-file <file> | --person-words <text>]");
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  const build = unitBuildOf(state);
  if (build === null) fail("A change is proposed from a Unit's build; this work is not one.");
  const record = activeRecordDir(pd);
  const approved = approvedInputsOf(record).filter((entry) => !entry.path.endsWith("unit-of-work-dependency.md"));
  const match = approved.find((entry) =>
    entry.path === flags.input || entry.path.endsWith(`/${flags.input}`) || entry.path.endsWith(`/${artifactFilename(flags.input!)}`)
  );
  if (match === undefined) {
    fail(`${flags.input} is not one of the files ${build.unit} was approved with (${approved.map((entry) => entry.path.split("/").at(-1)).join(", ")}).`);
  }
  const name = inputName(match.path);
  const text = flags.file !== undefined ? readFileSync(resolve(pd, flags.file), "utf-8") : readFileSync(join(record, ...match.path.split("/")), "utf-8");
  if (textFingerprint(text) === match.fingerprint) {
    console.log(JSON.stringify({ proposed: false, notice: `The ${name} is as the home approved it, so there is no change to send.` }));
    return;
  }
  if (getField(state, "Home Result")?.trim() === "by file") {
    fail(`The home takes no push from here: send your change to the ${name} to the lead with your result file.`);
  }
  const home = buildsHome(pd, build);
  const ref = claimRef(home.id8, build.unit);
  if (home.target !== null) ensureFetchedClaim(pd, home, ref);
  const live = currentClaim(pd, home.target, ref);
  if (live?.status !== "claimed") fail(`${build.unit} is not held at the home, so there is no claim to send the change on.`);
  const proposal: Proposal = {
    input: match.path,
    by: git(pd, ["config", "user.name"]).stdout.trim() || "a teammate",
    words: personWordsOf(pd, flags),
    at: isoTimestamp(),
  };
  const payload: UnitClaimPayload = {
    ...live.payload,
    predecessor_oid: live.oid,
    proposals: [...(live.payload.proposals ?? []).filter((entry) => entry.input !== match.path || entry.answer !== undefined), proposal],
  };
  const sent = updateClaimRef(pd, home.target, ref, createClaimCommit(pd, live.oid, payload, undefined, undefined, {
    [`${RESULT_FILES_ROOT}/proposals/${match.path}`]: text,
  }), live.oid);
  if (!sent.ok) fail(`The home did not take the change: ${sent.refused ?? "its claim moved meanwhile"}. Try again.`);
  invalidateLiveClaimPayloadCache(pd, build.unit);
  console.log(JSON.stringify({
    proposed: true,
    notice: `Sent to the home: your change to the ${name}. I'm carrying on with ` +
      `${flags.file !== undefined ? `the approved ${name}` : "your version here"} until the home decides.`,
  }));
}

// The team's proposed text put onto the current one: as proposed when the
// current text is still the copy the team changed (`taken`); else a three-way
// merge of that copy, the current text and theirs, or null when the two
// changes meet.
function changeOntoCurrent(projectDir: string, path: string, taken: string | null, theirs: string): string | null {
  const current = existsSync(path) ? readFileSync(path, "utf-8") : null;
  if (current === null || taken === null || textFingerprint(taken) === textFingerprint(current)) return theirs;
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-amend-"));
  try {
    const files = [current, taken, theirs].map((content, i) => {
      const file = join(scratch, `merge-${i}`);
      writeFileSync(file, content, "utf-8");
      return file;
    });
    const merged = spawnSync("git", ["merge-file", "-p", ...files], { cwd: projectDir, encoding: "utf-8" });
    return merged.status === 0 ? merged.stdout : null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The text a team proposes for an input, written beside the home's record
// (never committed) so its owner can read it before deciding: the path, or
// null when the claim does not carry it.
export function writeProposedText(projectDir: string, claim: UnitClaimView, input: string): string | null {
  const shown = git(projectDir, ["show", `${claim.oid}:${RESULT_FILES_ROOT}/proposals/${input}`, "--"]);
  const record = recordDir(projectDir);
  if (!shown.ok || record === null) return null;
  const path = join(record, ENGINE_DIR, "proposed", claim.unit, ...input.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, shown.stdout, "utf-8");
  return relative(projectDir, path).split(sep).join("/");
}

// The Units of this work whose applicable stages read an input, by each Unit's kind.
function unitsReading(projectDir: string, input: string): Set<string> {
  const state = readStateFile(projectDir);
  const dag = resolveBoltDag(projectDir);
  if (dag.state !== "ok") return new Set();
  const graph = loadStageGraphAll();
  const stages = unitMajorConstructionStageSlugs(getField(state, "Scope") ?? "", state, true);
  return new Set(dag.units.filter((unit) => homeInputPaths(stages.filter((slug) => {
    const stage = graph.find((entry) => entry.slug === slug);
    return stage !== undefined && teamUnitStageApplies(stage, dag.unitKinds?.get(unit) ?? null);
  })).includes(input)));
}

// The inputs this build was approved with whose copy here now differs, for a
// text the home was neither sent nor answered: what the build offers to send
// home for its owner to approve (decision 10, the team's side).
export function changedInputs(projectDir: string, stateContent: string): Array<{ path: string; name: string; fingerprint: string }> {
  const build = unitBuildOf(stateContent);
  const record = recordDir(projectDir);
  if (build === null || record === null) return [];
  let mine: UnitClaimView | undefined;
  try {
    const space = build.homeRecord.slice(0, build.homeRecord.indexOf("/"));
    mine = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false).get(build.unit);
  } catch {
    // No claims here (a build by file): its own copy is the record.
  }
  const sentOrAnswered = (input: string, fingerprint: string): boolean => mine !== undefined &&
    (mine.payload.proposals?.some((entry) => entry.input === input && entry.answer === undefined) ||
      ["proposals", "amendments"].some((kind) => {
        const shown = git(projectDir, ["show", `${mine!.oid}:${RESULT_FILES_ROOT}/${kind}/${input}`, "--"]);
        return shown.ok && textFingerprint(shown.stdout) === fingerprint;
      }));
  return approvedInputsOf(record).filter((entry) => !entry.path.endsWith("unit-of-work-dependency.md")).flatMap((entry) => {
    let text: string;
    try {
      text = readFileSync(join(record, ...entry.path.split("/")), "utf-8");
    } catch {
      return [];
    }
    const fingerprint = textFingerprint(text);
    if (fingerprint === entry.fingerprint || sentOrAnswered(entry.path, fingerprint)) return [];
    return [{ path: entry.path, name: inputName(entry.path), fingerprint }];
  });
}

export function amendAskName(unit: string, input: string): string {
  return `amend-${unit}-${input.replace(/[^A-Za-z0-9.-]+/g, "_")}.json`;
}

// At the home: the owner of the shared plan answers a team's proposal, in their
// own words, under the rules for a person's answer (their reply after it was
// shown, not empty, not a cancellation, not the agent's). An approved change
// is written into the home's record, the home's stages that used it read as
// current, and every team building with it gets it on its claim (a team by
// file, a newer hand-off file).
function amendInput(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  const answer = flags.answer;
  if (!unit || !flags.input || (answer !== "approve" && answer !== "reject")) {
    fail("Usage: aidlc-unit amend <unit> --input <file> --answer <approve|reject> (--request-file <file> | --person-words <text>)");
  }
  const pd = resolveProjectDir(projectDir);
  const words = personWordsOf(pd, flags);
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  const proposal = live?.payload.proposals?.find((entry) => entry.input === flags.input && entry.answer === undefined);
  if (!live || proposal === undefined) fail(`${unit} has no change to ${flags.input} waiting for an answer.`);
  requireLeadsWord(pd, "The answer to a proposed change");
  const name = inputName(proposal.input);
  const answered: Proposal = { ...proposal, answer: answer === "approve" ? "approved" : "turned down", ...(words ? { answer_words: words } : {}) };
  const lines: string[] = [];
  if (answer === "approve") {
    const shown = git(pd, ["show", `${live.oid}:${RESULT_FILES_ROOT}/proposals/${proposal.input}`, "--"]);
    if (!shown.ok) fail(`The proposed ${name} is not on ${unit}'s claim; ask the team to send it again.`);
    const path = join(activeRecordDir(pd), ...proposal.input.split("/"));
    // Only the team's change goes in: made on the copy the team took, it is put
    // onto the text approved here since, never written over it.
    // The copy the team changed: the lead's last change it took in, else the one it took.
    const amendedBefore = git(pd, ["show", `${live.oid}:${RESULT_FILES_ROOT}/amendments/${proposal.input}`, "--"]);
    const taken = amendedBefore.ok
      ? amendedBefore
      : git(pd, ["show", `${live.payload.base_oid}:${relative(pd, path).split(sep).join("/")}`, "--"]);
    const text = changeOntoCurrent(pd, path, taken.ok ? taken.stdout : null, shown.stdout);
    if (text === null) {
      const theirs = writeProposedText(pd, live, proposal.input);
      fail(
        `${live.owner}'s change was made on an older copy of the ${name}, and it does not fit onto the ${name} as it ` +
          `stands here now, so nothing was changed. Show the lead both: their version${theirs === null ? "" : ` (${theirs})`} ` +
          `and the current one (${relative(pd, path).split(sep).join("/")}); the team can send the change again on the current one.`,
      );
    }
    writeFileSync(path, text, "utf-8");
    renewForAmendedInput(pd, proposal.input, { "Proposed By": `${proposal.by} (${live.owner})`, "Person Words": words });
    const amendment: Amendment = { input: proposal.input, at: isoTimestamp(), words };
    const readers = unitsReading(pd, proposal.input);
    const missed: string[] = [];
    for (const [other, claim] of cachedClaims(pd)) {
      // Only the Units whose stages read it hear it; the proposing team always hears its answer.
      if (claim.status !== "claimed" || (other !== unit && !readers.has(other))) continue;
      const amended = (current: UnitClaimView): ReturnType<typeof updateClaimRef> => updateClaimRef(pd, remote, current.ref, createClaimCommit(pd, current.oid, {
        ...current.payload,
        predecessor_oid: current.oid,
        amendments: [...(current.payload.amendments ?? []).filter((entry) => entry.input !== proposal.input), amendment],
        ...(other === unit ? { proposals: (current.payload.proposals ?? []).map((entry) => (entry.input === proposal.input && entry.answer === undefined ? answered : entry)) } : {}),
      }, undefined, undefined, {
        [`${RESULT_FILES_ROOT}/amendments/${proposal.input}`]: text,
      }), current.oid);
      let current = currentClaim(pd, remote, claim.ref);
      if (current?.status !== "claimed") continue;
      // A claim that moved meanwhile is read again and written once more.
      if (!amended(current).ok) {
        current = currentClaim(pd, remote, claim.ref);
        if (current?.status !== "claimed" || !amended(current).ok) {
          missed.push(claim.owner);
          continue;
        }
      }
      invalidateLiveClaimPayloadCache(pd, other);
      if (current.payload.by_file && !current.payload.taken_by) {
        lines.push(`A newer hand-off file for ${other} is at ${writeHandOffFile(pd, other, current.owner, current.generation)}: send it to ${current.owner}.`);
      }
    }
    lines.unshift(`The ${name} is changed at the home. The teams building with it hear it once and carry on; nobody approves anything again.`);
    if (missed.length > 0) {
      const teams = [...new Set(missed)];
      lines.push(`It did not reach ${joinNames(teams)} just now (${teams.length === 1 ? "its claim" : "their claims"} moved meanwhile), so ${teams.length === 1 ? "that team does" : "those teams do"} not have it yet.`);
    }
  } else {
    const payload: UnitClaimPayload = {
      ...live.payload,
      predecessor_oid: live.oid,
      proposals: (live.payload.proposals ?? []).map((entry) => (entry.input === proposal.input && entry.answer === undefined ? answered : entry)),
    };
    const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload), live.oid);
    if (!sent.ok) fail(`${unit}'s claim moved meanwhile: ${sent.refused ?? "try again"}.`);
    invalidateLiveClaimPayloadCache(pd, unit);
    lines.push(`Turned down ${live.owner}'s change to the ${name}; they hear it once, with your words.`);
  }
  appendAuditEntry("QUESTION_ANSWERED", {
    Question: `${live.owner} proposes a change to the ${name} for ${unit}`,
    Answer: answer === "approve" ? "Approve it" : "Turn it down",
    "Person Reply": words,
  }, pd);
  console.log(JSON.stringify({ answered: answered.answer, unit, notice: lines.join(" ") }));
}

// The home's person turned a Unit's repo down: their words go on the claim,
// and the team hears them, once, at its next step.
function turnedDown(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit || !flags.repo) fail("Usage: aidlc-unit turned-down <unit> --repo <repo> (--request-file <file> | --person-words <text>)");
  const pd = resolveProjectDir(projectDir);
  const words = personWordsOf(pd, flags);
  requireLeadsWord(pd, "A turn-down");
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  if (live?.status !== "claimed" || !live.payload.result) fail(`${unit} has no result from its team to turn down.`);
  const payload: UnitClaimPayload = {
    ...live.payload,
    predecessor_oid: live.oid,
    turned_down: { repo: flags.repo, words: words.trim(), at: isoTimestamp() },
  };
  const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload), live.oid);
  if (!sent.ok) fail(`The note could not be put on ${unit}'s claim: ${sent.refused ?? "it moved meanwhile"}. Try again.`);
  invalidateLiveClaimPayloadCache(pd, unit);
  console.log(JSON.stringify({ unit, notice: `${theTeam(live.owner).replace(/^the/, "The")} hears that ${flags.repo} was turned down, with your words, at its next step.` }));
}

// The lead says a repo merged the Unit where the merge check cannot see it (a
// change made again by hand, a branch merged elsewhere): their words go on the
// claim, and the home counts that repo merged at its next step.
function saidMerged(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit || !flags.repo) fail("Usage: aidlc-unit merged <unit> --repo <repo> (--request-file <file> | --person-words <text>)");
  const pd = resolveProjectDir(projectDir);
  const words = personWordsOf(pd, flags);
  requireLeadsWord(pd, "That it merged");
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  if (live?.status !== "claimed" || !live.payload.result) fail(`${unit} has no result from its team to count merged.`);
  if (!live.payload.result.repos.some((repo) => repo.repo === flags.repo)) {
    fail(`${unit} changed ${joinNames(live.payload.result.repos.map((repo) => repo.repo))}, not ${flags.repo}.`);
  }
  const payload: UnitClaimPayload = {
    ...live.payload,
    predecessor_oid: live.oid,
    said_merged: [...(live.payload.said_merged ?? []).filter((entry) => entry.repo !== flags.repo), { repo: flags.repo, words, at: isoTimestamp() }],
  };
  const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload), live.oid);
  if (!sent.ok) fail(`${unit}'s claim moved meanwhile: ${sent.refused ?? "try again"}.`);
  invalidateLiveClaimPayloadCache(pd, unit);
  console.log(JSON.stringify({ unit, notice: `${flags.repo} counts as merged for ${unit}, in your words.` }));
}

// --- Hand-off by file ------------------------------------------------------------
//
// For a team that cannot reach the home's repository: the lead holds the Unit
// for the team and writes one readable file with what it was approved with; the
// team starts its build from it and sends progress and its result back as
// files the lead takes in.

function handFilePath(label: string, unit: string, suffix = ""): string {
  return `${HANDOFF_DIR}/${slugify(label) || "work"}-${unit}${suffix}.md`;
}

function writeHandFile(projectDir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(projectDir, ...rel.split("/"))), { recursive: true });
  writeFileSync(join(projectDir, ...rel.split("/")), text, "utf-8");
}

function readHandFile(projectDir: string, path: string): HandFile | null {
  try {
    return parseHandFile(readFileSync(resolve(projectDir, path), "utf-8"));
  } catch {
    fail(`${path} could not be read.`);
  }
}

function handOff(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  const team = flags.team?.trim();
  if (!unit || !team) fail("Usage: aidlc-unit hand-off <unit> --team <team> [--request-file <file> | --person-words <text>]");
  if (/[\r\n|]/.test(team)) fail("Team labels cannot contain pipes or newlines.");
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  const location = homeLocation(state);
  if (!isTeamUnitOwnership(state) || location === null) fail("Units are handed off once teams are chosen for this work.");
  const local = localOpeningStatus(pd);
  if (!local.units.includes(unit)) fail(`${unit} is not one of this work's Units (${local.units.join(", ")}).`);
  const identity = activeIdentity(pd);
  const integration = fetchIntegration(pd);
  const ref = claimRef(identity.intentId8, unit);
  const current = currentClaim(pd, integration.remote, ref);
  if (current?.status === "claimed" && current.owner !== team) fail(`${unit} is held by ${current.owner}, so it stays with them.`);
  if (current?.payload.taken_by !== undefined) fail(`${unit} is already taken by ${current.payload.taken_by} of ${current.owner}.`);
  const payload: UnitClaimPayload = current?.status === "claimed"
    ? { ...current.payload, predecessor_oid: current.oid, by_file: true }
    : {
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
      by_file: true,
    };
  const held = updateClaimRef(pd, integration.remote, ref, createClaimCommit(pd, current?.oid ?? integration.oid, payload), current?.oid ?? null);
  if (!held.ok) fail(`${unit} could not be held for ${team}: ${held.refused ?? "its claim moved meanwhile"}. Try again.`);
  invalidateLiveClaimPayloadCache(pd, unit);
  const rel = writeHandOffFile(pd, unit, team, payload.generation);
  const words = leadSpoke(pd) ? personWordsOf(pd, flags) : "";
  const planChanging = homePlanChangingLine(state, [unit]);
  appendAuditEntry("UNITS_ASSIGNED", {
    Assigned: `${unit}=${team}`,
    "By File": rel,
    ...(words ? { "Person Words": words } : {}),
  }, pd);
  console.log(JSON.stringify({
    unit,
    team,
    file: rel,
    notice: `The hand-off file for ${unit} is ${rel}: send it to ${theTeam(team)}. They take it in by ` +
      "pointing AI-DLC at it in their own workspace, and send its result back to you as a file." +
      (planChanging === null ? "" : ` ${planChanging}`),
  }));
}

// The hand-off file for a Unit held for a team by file, from the home's record
// as it is now. Returns its workspace-relative path.
function writeHandOffFile(pd: string, unit: string, team: string, attempt: number): string {
  const state = readStateFile(pd);
  const identity = activeIdentity(pd);
  const integration = fetchIntegration(pd);
  const record = activeRecordDir(pd);
  const files = new Map<string, string>([["aidlc-state.md", state]]);
  for (const rel of homeInputPaths(unitMajorConstructionStageSlugs(getField(state, "Scope") ?? "", state, true))) {
    if (existsSync(join(record, ...rel.split("/")))) files.set(rel, readFileSync(join(record, ...rel.split("/")), "utf-8"));
  }
  const produced = new Set([...files.keys()].map((rel) => rel.split("/")[1]));
  const approvals = readAuditShardEvents(pd).filter((row) => row.event === "GATE_APPROVED" && produced.has(auditBlockField(row.block, "Stage") ?? ""))
    .map((row) => `${auditBlockField(row.block, "Stage")} approved at the home ${auditBlockField(row.block, "Timestamp") ?? ""}`.trim());
  const row = readIntentRegistry(pd, identity.space).find((entry) => entry.uuid === identity.intentUuid);
  const label = row?.slug ?? unit;
  const rel = handFilePath(label, unit);
  writeHandFile(pd, rel, renderHandFile(
    "handoff",
    `Hand-off: ${unit} of ${label}`,
    `This file hands ${unit} to ${theTeam(team)}. Point AI-DLC at this file in your own workspace and it offers ` +
      "to start it as a piece of work of its own. It is not signed: it is bound by the work's id, the " +
      "Unit, the attempt and the fingerprints below.",
    {
      "Home Work": identity.intentUuid,
      "Home Location": homeLocation(state) ?? "",
      "Home Record": `${identity.space}/${row?.dirName ?? ""}`,
      "Home Label": label,
      Unit: unit,
      Team: team,
      Attempt: String(attempt),
      "Home Commit": integration.oid,
      "Handed Off": isoTimestamp(),
      "Home Approvals": approvals.join("; ") || "none recorded",
      Repos: (row?.repos ?? []).join(", "),
    },
    files,
  ));
  return rel;
}

function takeFromFile(pd: string, path: string): void {
  const file = readHandFile(pd, path);
  if (file === null || file.kind !== "handoff") fail(`${path} is not a hand-off file.`);
  const fields = file.fields;
  const unit = fields.Unit ?? "";
  const unitError = validateUnitName(unit);
  if (unitError) fail(`${path}: ${unitError}`);
  const at = (fields["Home Record"] ?? "").indexOf("/");
  const home: HomeRef = {
    location: fields["Home Location"] ?? "",
    uuid: fields["Home Work"] ?? "",
    space: fields["Home Record"]?.slice(0, at) ?? DEFAULT_SPACE,
    dirName: fields["Home Record"]?.slice(at + 1) ?? "",
    label: fields["Home Label"] ?? unit,
    repos: (fields.Repos ?? "").split(",").map((repo) => repo.trim()).filter(Boolean),
  };
  const existing = findUnitBuild(pd, home.uuid, unit);
  if (existing !== null) {
    setActiveSpaceCursor(pd, existing.space);
    selectIntentForSession(pd, existing.dirName, existing.space, resolveWorkflowSelection(pd).sessionId ?? undefined);
    console.log(JSON.stringify({ taken: true, resumed: true, unit, space: existing.space, record: existing.dirName,
      notice: `Carrying on ${unit}, ${theTeam(existing.space)}'s build here.` }));
    return;
  }
  const state = file.files.get("aidlc-state.md");
  if (state === undefined) fail(`${path} holds no plan for ${unit}.`);
  const team = fields.Team || "a team";
  const approvals = (fields["Home Approvals"] ?? "").split("; ").filter((line) => line && line !== "none recorded");
  const build = createUnitBuild(pd, home, { state }, fields["Home Commit"] ?? "", unit, team, Number(fields.Attempt) || 1, {
    read: (rel) => file.files.get(rel) ?? null,
    approvals: () => approvals,
  });
  withAuditLock(pd, () => {
    writeStateFile(pd, setOrInsertField(readStateFile(pd, build.dirName, build.space), "## Runtime State", "Home Result", "by file"), build.dirName, build.space);
  });
  setActiveSpaceCursor(pd, build.space);
  const likely = unitLikelyRepos(pd, build.dirName, build.space).get(unit) ?? [];
  const missing = [...new Set(likely.map((repo) => repo.split("/")[0]))]
    .filter((repo) => home.repos.includes(repo) && !isGitRepoDir(repoDir(pd, repo)));
  console.log(JSON.stringify({
    taken: true,
    unit,
    team,
    space: build.space,
    record: build.dirName,
    notice: `${unit.charAt(0).toUpperCase()}${unit.slice(1)} is yours, handed off from ${home.label} by its lead on ` +
      `${(fields["Handed Off"] ?? "").slice(0, 10)}. Its build is its own piece of work here, under your team's rules, ` +
      "from what the home approved; its result goes back as a file when it is built." +
      (file.edited ? " This file was changed after the lead wrote it: it is taken in as it is." : "") +
      missing.map((repo) => ` ${repoNotThereLine(pd, repo)}`).join(""),
  }));
}

// A build by file sends its progress whenever the person likes; nobody has to.
function progressFile(projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  const build = unitBuildOf(state);
  if (build === null) fail("A progress file is for a Unit's build; this work is not one.");
  if (getField(state, "Home Result")?.trim() !== "by file") {
    console.log(JSON.stringify({ notice: `${build.unit}'s progress reaches the home with your pushes; no file is needed.` }));
    return;
  }
  const label = getField(state, "Home Label")?.trim() || build.unit;
  const rel = handFilePath(label, build.unit, "-progress");
  const stage = getField(state, "Current Stage")?.trim() ?? "";
  writeHandFile(pd, rel, renderHandFile(
    "progress",
    `Progress: ${build.unit}`,
    "Point AI-DLC at this file at the home and it takes it in.",
    { "Home Work": build.homeWork, "Home Label": label, Unit: build.unit, Attempt: String(build.attempt), Stage: stage, Written: isoTimestamp() },
    new Map(),
  ));
  console.log(JSON.stringify({ file: rel, notice: `The progress file is ${rel}; send it to the lead if you like.` }));
}

// A hand file already acted on here, so pointing at it again starts nothing: a
// hand-off file whose Unit's build is here, or a result or progress file whose
// content the Unit's claim carries already.
export function handFileActedOn(projectDir: string, file: HandFile): boolean {
  const unit = file.fields.Unit ?? "";
  const work = file.fields["Home Work"] ?? "";
  try {
    if (file.kind === "handoff") return findUnitBuild(projectDir, work, unit) !== null;
    const identity = activeIdentity(projectDir);
    if (work !== identity.intentUuid) return false;
    const live = currentClaim(projectDir, repositoryRemote(projectDir), claimRef(identity.intentId8, unit));
    if (live?.status !== "claimed") return false;
    if (file.kind === "progress") return live.payload.progress?.at === (file.fields.Written ?? "");
    const heads = (result: UnitResult | undefined) => JSON.stringify(result?.repos.map((repo) => repo.heads) ?? null);
    return file.result !== undefined && heads(live.payload.result) === heads(file.result);
  } catch {
    return false;
  }
}

// At the home: a team's result or progress file, onto the Unit's claim.
function takeIn(args: string[], projectDir?: string): void {
  const { positional } = parseArgs(args);
  const path = positional[0];
  if (!path) fail("Usage: aidlc-unit take-in <file>");
  const pd = resolveProjectDir(projectDir);
  const file = readHandFile(pd, path);
  if (file === null || file.kind === "handoff") fail(`${path} is not a result or progress file.`);
  const identity = activeIdentity(pd);
  const unit = file.fields.Unit ?? "";
  if (file.fields["Home Work"] !== identity.intentUuid) {
    const other = file.fields["Home Label"]?.trim();
    const here = readIntentRegistry(pd, identity.space).find((entry) => entry.uuid === identity.intentUuid)?.slug;
    const named = other && other !== here ? ` (${other})` : "";
    console.log(JSON.stringify({ taken_in: false, notice: `${path} is for other work${named}, not this one, so nothing changed.` }));
    return;
  }
  const remote = repositoryRemote(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  if (live?.status !== "claimed") fail(`${unit} is not held for a team here, so this file has nothing to go into.`);
  const lines: string[] = [];
  if ((Number(file.fields.Attempt) || 0) < live.generation) lines.push(`This file is from an earlier attempt of ${unit}; it is taken in as the team's latest word.`);
  if (file.edited) lines.push("This file was changed after the team wrote it: it is taken in as it is, and the result says so.");
  const payload: UnitClaimPayload = { ...live.payload, predecessor_oid: live.oid };
  const files: Record<string, string> = {};
  if (file.kind === "progress") {
    payload.progress = { stage: file.fields.Stage ?? "", at: file.fields.Written ?? "" };
    const stage = file.fields.Stage ? stageLabel(loadGraph().find((entry) => entry.slug === file.fields.Stage), file.fields.Stage) : null;
    lines.unshift(`Took in ${unit}'s progress from ${live.owner}: ${stage ?? "under way"}.`);
  } else {
    if (!file.result) fail(`${path} holds no result.`);
    // A result brings home only the Unit outputs the home's later stages read.
    const reads = new Set(unitOutputsHomeReads(unit, getField(readStateFile(pd), "Scope") ?? ""));
    const kept = [...file.files.keys()].filter((rel) => reads.has(rel));
    const other = [...file.files.keys(), ...(file.result.outputs ?? [])].filter((rel, i, all) => !reads.has(rel) && all.indexOf(rel) === i);
    payload.result = { ...file.result, outputs: (file.result.outputs ?? []).filter((rel) => reads.has(rel)), ...(file.edited ? { edited: true as const } : {}) };
    payload.verdicts = undefined;
    for (const rel of kept) files[`${RESULT_FILES_ROOT}/${rel}`] = file.files.get(rel)!;
    lines.unshift(`Took in ${unit}'s result from ${live.owner}.`);
    if (other.length > 0) {
      lines.push(`${joinNames(other)} ${other.length === 1 ? "is" : "are"} not ${other.length === 1 ? "an output" : "outputs"} the home reads of ${unit}, so ${other.length === 1 ? "it was" : "they were"} left out.`);
    }
  }
  const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload, undefined, undefined, files), live.oid);
  if (!sent.ok) fail(`${unit}'s claim moved while the file was taken in: ${sent.refused ?? "try again"}.`);
  invalidateLiveClaimPayloadCache(pd, unit);
  console.log(JSON.stringify({ taken_in: true, unit, kind: file.kind, notice: lines.join(" ") }));
}

// --- A second person on solo work -------------------------------------------------
//
// Solo work a teammate took a Unit of from another machine: this home's session
// records the switch to teams at its next step (the teammate's clone never
// writes it), through the ownership and rhythm setters: its remote as the home,
// and the approvals it had (once per Unit at its checkpoint, or after every
// stage). The Units it already built here stay done here. Nothing is asked
// again. The line for the person, or null when nothing switched.
export function switchSoloToTeams(projectDir: string, sessionId?: string): string | null {
  let state: string;
  try {
    state = readStateFile(projectDir);
  } catch {
    return null;
  }
  if (isTeamUnitOwnership(state) || homeLocation(state) !== null || isReadOnlyEngineProbe()) return null;
  if (getField(state, "Construction Iteration")?.trim() !== "unit-major") return null;
  // A teammate's take changes what this session does next once its Unit walk
  // has begun (or its first Unit is next): the claims are looked at once when
  // a chat starts and before each next Unit starts, never after each message
  // inside a Unit and never at an Inception step.
  const remote = repositoryRemote(projectDir);
  const stages = unitMajorConstructionStageSlugs(getField(state, "Scope") ?? "", state, true);
  const progress = soloUnitsProgress(readAuditShardEvents(projectDir), stages.at(-1) ?? "code-generation");
  if (remote !== null && (progress.started.size > 0 || stages.includes(getField(state, "Current Stage")?.trim() ?? ""))) {
    refreshHomeClaims(projectDir, {
      home: { target: remote, id8: activeIdentity(projectDir).intentId8 },
      sessionId,
      now: progress.started.size > 0 && [...progress.started].every((unit) => progress.done.has(unit)),
    });
  }
  if (!hasAnyUnitClaimRefs(projectDir)) return null;
  let taken: UnitClaimView[];
  try {
    taken = [...cachedClaimsForIdentity(projectDir, activeIdentity(projectDir), false).values()]
      .filter((claim) => claim.status === "claimed" && claim.payload.taken_by !== undefined);
  } catch {
    return null;
  }
  const location = workspaceHomeLocation(projectDir);
  if (taken.length === 0 || location === null || location === "local") return null;
  const who = joinNames([...new Set(taken.map((claim) => claim.payload.taken_by!))]);
  const units = joinNames(taken.map((claim) => claim.unit));
  const rhythm = readUnitGateRhythm(state);
  for (const setter of [["set-unit-ownership", "team", "--teammate-took"], ...(rhythm === "unit-end" ? [["set-unit-gate-rhythm", "unit-end"]] : [])]) {
    const [command, ...args] = aidlcEngineCommand(
      "state",
      [...setter, "--project-dir", projectDir],
      join(dirname(fileURLToPath(import.meta.url)), "aidlc-state.ts"),
      isCompiledExecutable() ? process.execPath : null,
    );
    const set = spawnSync(command, args, { cwd: projectDir, encoding: "utf-8", env: process.env });
    if (set.status !== 0) return null;
  }
  return `Your teammate ${who} took ${units}; this session carries on with the rest, one Unit at a time.`;
}

// --- The lead's sign-off ------------------------------------------------------------
//
// Off by default, switched on per piece of work at the home: a team's result
// then waits for the lead's own word before the Unit counts as done.
export const LEAD_SIGNOFF_FIELD = "Lead Sign-off";

export function leadSignOffOn(stateContent: string | null): boolean {
  return getField(stateContent ?? "", LEAD_SIGNOFF_FIELD)?.trim() === "on";
}

function leadSignOffSetting(args: string[], projectDir?: string): void {
  const value = args[0];
  if (value !== "on" && value !== "off") fail("Usage: aidlc-unit lead-sign-off on|off");
  const pd = resolveProjectDir(projectDir);
  if (!isTeamUnitOwnership(readStateFile(pd))) fail("The lead's sign-off is for work that teams build.");
  withAuditLock(pd, () => writeStateFile(pd, setOrInsertField(readStateFile(pd), "## Runtime State", LEAD_SIGNOFF_FIELD, value)));
  console.log(JSON.stringify({
    lead_sign_off: value,
    notice: value === "on"
      ? "Each team's result now waits for your sign-off before its Unit counts as done."
      : "A team's Unit counts as done once every repo it changed has merged; no sign-off is asked.",
  }));
}

export function signOffAskName(unit: string): string {
  return `signoff-${unit}.json`;
}

// The lead signs a team's result off, in their own words, under the rules for
// a person's answer.
function signOff(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail("Usage: aidlc-unit sign-off <unit> (--request-file <file> | --person-words <text>)");
  const pd = resolveProjectDir(projectDir);
  const words = personWordsOf(pd, flags);
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  if (live?.status !== "claimed" || !live.payload.result) fail(`${unit} has no result from its team to sign off.`);
  requireLeadsWord(pd, "The sign-off");
  const payload: UnitClaimPayload = { ...live.payload, predecessor_oid: live.oid, signoff: { words, at: isoTimestamp() } };
  const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload), live.oid);
  if (!sent.ok) fail(`${unit}'s claim moved meanwhile: ${sent.refused ?? "try again"}.`);
  invalidateLiveClaimPayloadCache(pd, unit);
  appendAuditEntry("QUESTION_ANSWERED", { Question: `Sign off ${unit} from ${live.owner}`, Answer: "Sign it off", "Person Reply": words }, pd);
  console.log(JSON.stringify({ unit, notice: `Signed off ${unit}; it counts as done once every repo it changed has merged.` }));
}

function participate(projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  writeFileSync(unitParticipantPath(pd), "participant\n", "utf-8");
  console.log(JSON.stringify({ participant: true }));
}

let projectDir: string | undefined;

export function main(argv: string[]): void {
  // A turn Claude Code started itself is settled before this command reads a turn.
  settleClaudeTurnsFirst(resolveProjectDir(projectDirFlag(argv)));
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
    else if (command === "hand-off") handOff(args, projectDir);
    else if (command === "progress") progressFile(projectDir);
    else if (command === "take-in") takeIn(args, projectDir);
    else if (command === "propose") proposeChange(args, projectDir);
    else if (command === "rebase") rebaseUnit(args, projectDir);
    else if (command === "amend") amendInput(args, projectDir);
    else if (command === "lead-sign-off") leadSignOffSetting(args, projectDir);
    else if (command === "sign-off") signOff(args, projectDir);
    else if (command === "turned-down") turnedDown(args, projectDir);
    else if (command === "merged") saidMerged(args, projectDir);
    else if (command === "adopt") adoptUnit(args, projectDir);
    else if (command === "claim") claimUnit(args, projectDir);
    else if (command === "release") releaseUnit(args, projectDir);
    else if (command === "participate") participate(projectDir);
    else if (command === "share") shareMain(args, projectDir);
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
        `Usage: aidlc-unit <${[...UNIT_VERBS.keys()].join("|")}> ...`,
      );
    }
    // The command did its work: the request file its words came in is spent.
    spendWordsFile?.();
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
