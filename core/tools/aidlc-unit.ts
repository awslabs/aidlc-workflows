// aidlc-unit.ts - atomic Unit claim registry and checkout-local scope binding.

import { projectDirFlag, settleClaudeTurnsFirst } from "./aidlc-claude-turn-pending.ts";
import { LAUNCHER_GLOBAL_FLAGS, UNIT_GRAMMAR, UNIT_VERBS } from "./aidlc-command.ts";
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
import { QUESTION_TYPE_FIELD } from "./aidlc-questions.ts";
import { completedUnits, scopeStampLanded, unitProgressTable, unitRowMerged } from "./aidlc-unit-landing.ts";
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
  addPendingPersonLines,
  artifactFilename,
  assertNoSymlinkInChainOrThrow,
  auditBlockField,
  auditShardBlocks,
  auditShardName,
  knownAuditShardName,
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
  filterProducesByKind,
  getField,
  loadStageGraph,
  humanPresenceGuardDisabled,
  idSuffix,
  listIntentDirs,
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
  namesSourceCheckout,
  printUsageAndExit,
  recordDir,
  parseBoltDag,
  readAppendOnlyFileNoFollowOrThrow,
  readAuditShardEvents,
  readUnitClaimRegistryCache,
  readApplicableTeamUnitScopeStamp,
  unitsWalkedWithoutClaim,
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
  AUTONOMY_MODE_FIELD,
  formatGuardPolicy,
  guardPolicyStateField,
  parseGuardPolicyStateLine,
  setGuardPolicyLine,
  shellArg,
  unattendedHumanPresenceHint,
  parseAuditShardEvents,
  parseReviewRecordBytes,
  personAskedSinceGate,
  pairedReviewRecordForCompletion,
  OPEN_QUESTION_FIELD,
  personsGateReply,
  personsWordsText,
  markPersonLinesHeard,
  personLineHeard,
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
  loadScopeMetadata,
  memorySectionBody,
  structuredField,
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
  slugify,
  sourceClaimCovers,
  sourcePathKey,
  type SourceClaimModel,
  workspaceSourceListing,
  type WorkspaceSourceListing,
} from "./aidlc-lib.js";
import { ownRemoteAmong } from "./aidlc-unit-holders.ts";
import {
  type Amendment,
  approvedInputsOf,
  artifactAt,
  CONTRACT_SUMMARY_INPUT,
  contractPartiesChanged,
  blobsAt,
  builtFromAnotherMachine,
  findUnitBuild,
  HOME_LOCATION_FIELD,
  isBuildOfUnit,
  liveBuildOf,
  homeLocation,
  inputName,
  LEAD_RULES_FIELD,
  leadRules as leadRulesOf,
  SIGN_OFF_CLAUSE,
  lastCommittedByThisPerson,
  patchIdOf,
  type Proposal,
  RESULT_FILES_ROOT,
  type RepoResult,
  sameGitAddress,
  PROJECT_TYPE_SOURCE_FIELD,
  PROJECT_TYPE_SOURCE_HOME,
  soloUnitsProgress,
  teamUnitStageApplies,
  textFingerprint,
  UNIT_BUILD_FIELD,
  UNIT_PUSH_FIELD,
  UNIT_BRANCH_FIELD,
  unitBranchOf,
  type UnitBuild,
  unitBuildOf,
  unitLikelyRepos,
  unitLikelyReposFrom,
  unitMergeVerdict,
  resultAtTip,
  mergeCandidate,
  unitMergesStanding,
  unitOutputsHomeReads,
  type UnitResult,
  workspaceHomeLocation,
  leadBuildsWithoutClaim,
  unitsAskedHere,
  unitWriteTargets,
  outputForLead,
  checkInLine,
  unitWordsArg,
  builderOf,
  spaceWords,
  clearLeadWaitsOnTeams,
  findUnitBuildOfRecord,
  isGitAddress,
  leadCopyAt,
  leadCopyRef,
  leadRecordHere,
  textAt,
} from "./aidlc-unit-teams.js";
import { submoduleLeavesProjectRepo } from "./aidlc-git.ts";
import { displayRepoPath, localUnreadableLine, readWorkspaceRepos, repoCloneable, repoCloneOfferLine, repoNotThereLine, withoutCredentials, workspaceManifestAt } from "./aidlc-workspace-manifest.js";
import { maskUserinfo, workspaceCloneUrl } from "./aidlc-workspace-sync.ts";
import { loadGraph } from "./aidlc-graph.ts";
import {
  captureStageValidationBasis,
  diffStageValidationBasis,
  latestCompletionBasesFromAudit,
  sharedInputAmendedFields,
  stageLabel,
} from "./aidlc-validity.ts";
import {
  planApprovalPromptSha256,
  parseTestingContract,
  recordedApprovalFingerprint,
  resolveTestingPosture,
} from "./aidlc-testing-posture.ts";
import { beforePerUnitBlock, memoryDirFor } from "./aidlc-graph.ts";
import { planMadeElsewhere, registryList, spacesRoot, stateFilePath } from "./aidlc-record-core.ts";
import { approvalDecidesOpenFindings, approvalOpenFindings } from "./aidlc-review-brief.ts";
import {
  aidlcEngineCommand,
  aidlcInvocation,
  aidlcToolInvocation,
  entrySkillInvocation,
  isCompiledExecutable,
  quoteCommandArgument,
  runtimeHarnessName,
  WORKSPACE_ENGINE_DIR,
} from "./aidlc-runtime-paths.ts";
import { readRequestFile } from "./aidlc-log.ts";
import { withoutLearnedDate } from "./aidlc-learned-date.ts";

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
// git never prompts and gives up after its quiet time limit. `input` is what
// git reads on its standard input.
function gitBytes(projectDir: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): GitBytesResult {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    env: { ...process.env, ...(quiet ? quietEnv(projectDir) : {}), ...env },
    maxBuffer: 512 * 1024 * 1024,
    // A quiet call is a process group of its own, so its time limit ends git's transport (ssh, the http helper) too.
    ...(quiet
      ? { timeout: args[0] === "ls-remote" ? QUIET_READ_TIMEOUT_MS : QUIET_WRITE_CEILING_MS, detached: process.platform !== "win32" }
      : {}),
    ...(input === undefined ? {} : { input }),
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

function git(projectDir: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): GitResult {
  const result = gitBytes(projectDir, args, env, input);
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
  // Who took it: their git user.name.
  taken_by?: string;
  // What the team pushed, what the home found merged, and done: a Unit whose
  // every repo merged, recorded at the home.
  result?: UnitResult;
  verdicts?: Array<{ repo: string; merged: boolean; commit?: string; how?: string }>;
  done?: true;
  // `person_reply`: the lead's own words for a turn-down, as they typed them.
  turned_down?: { repo: string; words: string; at: string; from?: "build-and-test"; person_reply?: string };
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
  /** Units a checkout walks without a claim (the lead's own, begun before the teams took the others). */
  walked?: string[];
  warning?: string;
}

function repositoryRemote(projectDir: string): string | null {
  const result = git(projectDir, ["remote"]);
  if (!result.ok) return null;
  const remotes = result.stdout.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  if (remotes.length === 0) return null;
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0];
  // The remote at the lead's recorded address, by the one rule (ownRemoteAmong).
  const own = ownRemoteAmong(projectDir, remotes);
  if (own !== null) return own;
  fail(`Multiple git remotes are configured (${remotes.join(", ")}); configure origin for Unit claims.`);
}

function currentBranch(projectDir: string): string {
  const result = git(projectDir, ["branch", "--show-current"]);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : "main";
}

const WAY_OF_WORKING = "## Way of Working";
const INTEGRATION_BRANCH_FIELD = "Integration branch";
const MEMORY_LAYERS = ["project.md", "team.md", "org.md"] as const;

// The one path both the reader (integrationBranchLayer) and the writer
// (recordIntegrationBranch) use for a memory layer.
function memoryLayerSource(projectDir: string, name: string, space = activeSpace(projectDir)): string {
  return `aidlc/spaces/${space}/memory/${name}`;
}

// The layers whose Way of Working words the agent read as naming no branch,
// each keyed to those words, so the read is not asked again for the same text.
// AI-DLC's own per-machine record, beside the sessions (git-ignored), never
// the person's file: a teammate's clone reads its words once for itself.
const BRANCH_FREE_WORDS_FILE = "integration-branch-free-words.json";

function wordsKey(section: string): string {
  return createHash("sha256").update(section.trim()).digest("hex");
}

function branchFreeWords(projectDir: string): Record<string, string> {
  try {
    const read = JSON.parse(readFileSync(join(sessionsDir(projectDir), BRANCH_FREE_WORDS_FILE), "utf-8"));
    return read !== null && typeof read === "object" ? read : {};
  } catch {
    return {};
  }
}

// The branch the team wrote down on its own `Integration branch: <name>` line
// under "## Way of Working", narrowest layer first. Only that line is read: a
// sentence naming the repos beside the branch once gave a repo's name. A layer
// whose section has words but no line stops the walk there until the agent has
// read them: they may name the team's branch, so it records the line, or that
// they name none, first; never a broader layer's line or `main` in its place
// (an update must not move a team whose team.md says `develop` in a sentence).
// A layer with no words (the shipped comment-only files), or words read as
// naming none, is passed. Nothing is checked here, so the share offers can ask
// without a refusal.
function integrationBranchLayer(
  projectDir: string,
  space = activeSpace(projectDir),
): { value: string; source: string } | { toRead: string } | null {
  let branchFree: Record<string, string> | undefined;
  for (const name of MEMORY_LAYERS) {
    const source = memoryLayerSource(projectDir, name, space);
    let body: string;
    try {
      body = readFileSync(join(projectDir, ...source.split("/")), "utf-8");
    } catch {
      continue;
    }
    const section = memorySectionBody(body, WAY_OF_WORKING);
    const value = structuredField(section, INTEGRATION_BRANCH_FIELD);
    if (value !== null) return { value, source };
    if (section.trim() === "") continue;
    branchFree ??= branchFreeWords(projectDir);
    if (branchFree[source] !== wordsKey(section)) return { toRead: source };
  }
  return null;
}

// The layer whose Way of Working words are still to be read, or null.
export function integrationBranchToRead(projectDir: string, space = activeSpace(projectDir)): string | null {
  const layer = integrationBranchLayer(projectDir, space);
  return layer !== null && "toRead" in layer ? layer.toRead : null;
}

// What the agent does before a step that needs the branch, while a layer's
// words are still to be read: every such step says these words.
function integrationBranchReadStep(source: string, then: string): string {
  const file = source.slice(source.lastIndexOf("/") + 1);
  const record = `${aidlcToolInvocation("state")} practices-branch --file ${file}`;
  return `Run these now, in this turn: read the "${WAY_OF_WORKING.slice(3)}" section of ${source} for the one ` +
    `branch the work merges into. Record it with \`${record} --branch <name>\`, or, when the words name no ` +
    `branch, with \`${record} --none\` (the broader layers then answer, and nothing is asked). Ask the person only ` +
    "when one sentence names two branches and you cannot tell which the work merges into. Say the line it prints, " +
    `if any, to the person, ${then}.`;
}

// A hand-written line may end in a full stop, which no git name ends in, and
// wrap the name in a code span, which is Markdown, not the name (`dev`.).
function integrationBranchName(value: string): string {
  return withoutLearnedDate(value).replace(/\.$/, "").replace(/^`([^`]+)`$/, "$1").trim();
}

function requireBranchName(projectDir: string, branch: string, source: string): void {
  if (!git(projectDir, ["check-ref-format", "--branch", branch]).ok) {
    fail(
      `The integration branch "${branch}", named in ${source} under "Way of Working", ` +
        "is not a valid git branch name. Correct it there and run the command again.",
    );
  }
}

// The branch team work uses, from the narrowest layer's line. Whatever it is
// called, it is used; a name git cannot use is refused with its file, never
// skipped for a broader layer's choice.
function affirmedIntegrationBranch(
  projectDir: string,
  space = activeSpace(projectDir),
): { branch: string; source: string } | null {
  const layer = integrationBranchLayer(projectDir, space);
  if (layer === null) return null;
  if ("toRead" in layer) fail(integrationBranchReadStep(layer.toRead, "then run the command again"));
  const branch = integrationBranchName(layer.value);
  requireBranchName(projectDir, branch, layer.source);
  return { branch, source: layer.source };
}

// `practices-branch` (aidlc-state.ts): what the agent read in a layer's Way of
// Working words. A branch becomes the line the reader reads, at the end of the
// section, a fixed place, so a lead and a teammate's clone that record the same
// words write the same bytes and a land merges clean. Null (`--none`) records
// that these words name no branch, in AI-DLC's own record, keyed to them.
export function recordIntegrationBranch(
  projectDir: string,
  file: string,
  given: string | null,
): { recorded: string | null; file: string; line: string | null } {
  if (!(MEMORY_LAYERS as readonly string[]).includes(file)) fail(`--file is one of ${MEMORY_LAYERS.join(", ")}.`);
  const source = memoryLayerSource(projectDir, file);
  const path = join(projectDir, ...source.split("/"));
  let body: string;
  try {
    body = readFileSync(path, "utf-8");
  } catch {
    fail(`${source} is not here.`);
  }
  if (given === null) {
    const dir = sessionsDir(projectDir);
    assertNoSymlinkInChainOrThrow(projectDir, relative(projectDir, dir));
    mkdirSync(dir, { recursive: true });
    const words = { ...branchFreeWords(projectDir), [source]: wordsKey(memorySectionBody(body, WAY_OF_WORKING)) };
    writeFileAtomic(join(dir, BRANCH_FREE_WORDS_FILE), `${JSON.stringify(words, null, 2)}\n`);
    return { recorded: null, file: source, line: null };
  }
  const branch = integrationBranchName(given);
  requireBranchName(projectDir, branch, source);
  if (structuredField(memorySectionBody(body, WAY_OF_WORKING), INTEGRATION_BRANCH_FIELD) !== null) {
    fail(`${source} already has an "${INTEGRATION_BRANCH_FIELD}:" line under "Way of Working"; change it there.`);
  }
  const crlf = body.includes("\r\n");
  const lf = body.replace(/\r\n/g, "\n");
  const recorded = `- **${INTEGRATION_BRANCH_FIELD}**: ${branch}`;
  const at = lf.search(new RegExp(`^${WAY_OF_WORKING}[ \\t]*$`, "m"));
  const next = at < 0 ? -1 : lf.slice(at + WAY_OF_WORKING.length).search(/^## /m);
  const end = at < 0 || next < 0 ? lf.length : at + WAY_OF_WORKING.length + next;
  const after = lf.slice(end);
  const written = `${lf.slice(0, end).trimEnd()}\n\n${at < 0 ? `${WAY_OF_WORKING}\n\n` : ""}${recorded}\n` +
    (after === "" ? "" : `\n${after}`);
  writeFileSync(path, crlf ? written.replace(/\n/g, "\r\n") : written);
  return {
    recorded,
    file: source,
    line: `Team work merges into ${branch}, read from ${source}, where it is now the "${INTEGRATION_BRANCH_FIELD}" ` +
      'line under "Way of Working"; change it there to use another branch.',
  };
}

// `localOnly` (checkInTarget): no ls-remote, and never the branch HEAD is on,
// which for a branch pushed with -u would make that branch its own target.
function integrationBranch(projectDir: string, remote: string | null): string;
function integrationBranch(projectDir: string, remote: string, localOnly: true): string | null;
function integrationBranch(projectDir: string, remote: string | null, localOnly = false): string | null {
  if (remote) {
    const cached = git(projectDir, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]);
    if (cached.ok && cached.stdout.trim().startsWith(`${remote}/`)) {
      return cached.stdout.trim().slice(remote.length + 1);
    }
    if (localOnly) {
      return ["main", "master"].find((name) => git(projectDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`]).ok) ?? null;
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

// The remotes that stand in for a lead's project that did not answer, while
// they did not answer either (homeTarget): a read there that fails says so.
const unansweredHomes = new Set<string>();

// The one line for a take or write that neither the lead's project nor the
// team's own remote (`other`, a remote's name or its push address) answered.
function neitherAnswered(other: string, stderr: string): string {
  const why = stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "it did not answer";
  return `Neither the lead's project nor ${other} answered just now (${why}), so nothing was taken or sent; it goes through when one answers.`;
}

function refTip(
  projectDir: string,
  remote: string | null,
  ref: string,
): string | null {
  if (remote) {
    const found = git(projectDir, ["ls-remote", remote, ref]);
    if (!found.ok) {
      if (unansweredHomes.has(remote)) fail(neitherAnswered(remote, found.stderr || found.stdout));
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
  author?: NodeJS.ProcessEnv,
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
  const commit = git(projectDir, commitArgs, author);
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
): { ok: boolean; refused?: string; to?: string } {
  if (remote) {
    const lease = `--force-with-lease=${ref}:${expectedOid ?? ""}`;
    const pushed = git(projectDir, ["push", remote, lease, `${commitOid}:${ref}`]);
    // Where git sent it: its own "To <address>" line.
    const to = /^To (\S.*)$/m.exec(pushed.stderr)?.[1]?.trim();
    const at = to === undefined ? {} : { to };
    if (pushed.ok) return { ok: true, ...at };
    if (CLAIM_RACE_LOST.test(pushed.stderr)) return { ok: false, ...at };
    return { ok: false, refused: pushRefusal(pushed.stderr), ...at };
  }
  const updated = git(projectDir, [
    "update-ref",
    ref,
    commitOid,
    expectedOid ?? ZERO_OID,
  ]);
  return { ok: updated.ok };
}

// A claim written for the lead's project through home.target, read back at the
// recorded address when the target is a remote name: git may send that
// remote's pushes elsewhere (a push URL, pushInsteadOf, or a fork that copied
// the lead's claim branches standing in as the remote). A write the address
// answers without is `elsewhere`, the address git's own To line names, user
// and token masked; this clone's copy of the lead's claim, which git moved on
// the push, is put back as the lead's project has it. A race lost while the
// lead's claim did not move was lost elsewhere too. An address that does not
// answer leaves the write as git made it.
function writeHomeClaim(
  projectDir: string,
  home: { target: string | null; location: string },
  ref: string,
  commitOid: string,
  expectedOid: string | null,
  options: { outbox?: boolean } = {},
): { ok: boolean; refused?: string; elsewhere?: string; notThere?: { address: string; why: string } } {
  const sent = writeHomeClaimOnce(projectDir, home, ref, commitOid, expectedOid);
  if (sent.ok || sent.landed || options.outbox === false || (sent.refused === undefined && sent.elsewhere === undefined)) {
    const { landed: _landed, ...said } = sent;
    return said;
  }
  // The lead's project took no push from here: the same commit goes to the
  // team's own remote, where the lead's look takes it in; when that does not
  // take it either, git's reason there.
  const outbox = claimOutbox(projectDir, home);
  const there = outbox === null ? null : sendToOutbox(projectDir, outbox, ref, commitOid);
  if (outbox !== null && there?.ok === true) return { ok: false, elsewhere: maskUserinfo(outbox) };
  const notThere = outbox !== null && there !== null && !there.ok && there.why !== null ? { address: maskUserinfo(outbox), why: there.why } : undefined;
  return { ok: false, ...(sent.refused !== undefined ? { refused: sent.refused } : {}), ...(notThere !== undefined ? { notThere } : {}) };
}

function writeHomeClaimOnce(
  projectDir: string,
  home: { target: string | null; location: string },
  ref: string,
  commitOid: string,
  expectedOid: string | null,
): { ok: boolean; refused?: string; elsewhere?: string; landed?: boolean } {
  const target = home.target;
  const byName = target !== null && !isGitAddress(target) && isGitAddress(home.location);
  const tracking = byName ? `refs/remotes/${target}/${ref.slice("refs/heads/".length)}` : null;
  const before = tracking === null ? null : localGit(projectDir, ["rev-parse", "--verify", "--quiet", tracking]).stdout.trim() || null;
  // A remote that fetches from the lead's project is read back by its name, as its reads are.
  const fetchesHome = byName && sameGitAddress(git(projectDir, ["remote", "get-url", target]).stdout.trim(), home.location);
  // When it pushes to the team's own repo (a push URL), the push lands there,
  // so it leases on that repo's own tip, when this commit builds on it.
  const pushesTo = fetchesHome ? git(projectDir, ["remote", "get-url", "--push", target]).stdout.trim() : "";
  let lease = expectedOid;
  if (pushesTo !== "" && !sameGitAddress(pushesTo, home.location)) {
    const there = quietly(() => git(projectDir, ["ls-remote", pushesTo, ref]));
    const tip = there.ok ? there.stdout.trim().split(/\s+/)[0] ?? "" : null;
    if (tip === "") lease = null;
    else if (tip !== null && claimAhead(projectDir, tip, commitOid) === "ahead") lease = tip;
  }
  const { to, ...sent } = updateClaimRef(projectDir, target, ref, commitOid, lease);
  if (!byName || sent.refused !== undefined) return sent;
  const atHome = quietly(() => git(projectDir, ["ls-remote", fetchesHome ? target : home.location, ref]));
  // A remote that fetches from the lead's project and pushes to the team's own:
  // a push that went through while the lead's project does not answer is there.
  const outbox = fetchesHome && !atHome.ok && sent.ok ? claimOutbox(projectDir, home) : null;
  if (!atHome.ok && outbox === null) return sent;
  const tip = atHome.ok ? atHome.stdout.trim().split(/\s+/)[0] || null : null;
  if (atHome.ok && (sent.ok ? tip === commitOid : tip !== expectedOid)) return sent;
  if (tracking !== null && fetchesHome) {
    localGit(projectDir, before === null ? ["update-ref", "-d", tracking] : ["update-ref", tracking, before]);
  }
  const address = to ?? git(projectDir, ["remote", "get-url", "--push", target]).stdout.trim();
  return { ok: false, elsewhere: maskUserinfo(address), ...(sent.ok ? { landed: true } : {}) };
}

// Where this clone pushes the lead's project's branch, by its push address as
// git expands it (a push URL, pushInsteadOf), when that is not the lead's
// project: the team's fork or own repo, where a claim the lead's project
// refused goes. Null when this clone pushes nowhere else.
function claimOutbox(projectDir: string, home: { location: string }): string | null {
  try {
    if (!isGitAddress(home.location)) return null;
    // Only to pick the remote: a layer's Way of Working words the agent has not
    // read yet leave the remote's own default branch, never no outbox.
    const layer = integrationBranchLayer(projectDir);
    const branch = layer !== null && "value" in layer ? integrationBranchName(layer.value) : integrationBranch(projectDir, repositoryRemote(projectDir));
    const remote = pushRemoteOf(projectDir, branch);
    if (typeof remote !== "string") return null;
    const address = git(projectDir, ["remote", "get-url", "--push", remote]).stdout.trim();
    return isGitAddress(address) && !sameGitAddress(address, home.location) ? address : null;
  } catch {
    return null;
  }
}

// A claim commit sent to the team's own remote with the team's login, its
// lease on that remote's own tip of the claim branch, and only on top of it:
// what is there and not taken in yet (a proposal, a teammate's take) is never
// written over. Not ok when it does not answer or does not take it, with
// git's reason in one line (`why`; none when its claim there parted from this
// one).
function sendToOutbox(projectDir: string, outbox: string, ref: string, commitOid: string): { ok: true } | { ok: false; why: string | null } {
  return quietly(() => {
    const listed = git(projectDir, ["ls-remote", outbox, ref]);
    if (!listed.ok) return { ok: false, why: listed.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "it did not answer" };
    const tip = listed.stdout.trim().split(/\s+/)[0] ?? "";
    const stands = tip === "" ? "ahead" : claimAhead(projectDir, tip, commitOid);
    if (stands === "same") return { ok: true };
    if (stands === null) return { ok: false, why: null };
    const pushed = git(projectDir, ["push", outbox, `--force-with-lease=${ref}:${tip}`, `${commitOid}:${ref}`]);
    return pushed.ok ? { ok: true } : { ok: false, why: pushRefusal(pushed.stderr) };
  });
}

// Where a claim commit stands against a claim tip: "ahead" when the tip is in
// its history, or a commit there has the tip's tree (the lead takes a team's
// commit in as a commit of its own with the same tree, so the two histories
// part with the same claim); "same" when it holds the tip's own tree; else
// null (it parted from the tip, or is behind it). Read from this clone's own
// objects; a commit not here is null.
function claimAhead(projectDir: string, tip: string, oid: string): "ahead" | "same" | null {
  if (tip === oid) return "same";
  if (localGit(projectDir, ["merge-base", "--is-ancestor", tip, oid]).ok) return "ahead";
  const tipTree = localGit(projectDir, ["rev-parse", "--verify", "--quiet", `${tip}^{tree}`]).stdout.trim();
  const trees = localGit(projectDir, ["log", "--format=%T", "--max-count=200", oid]).stdout.split(/\r?\n/).map((tree) => tree.trim()).filter(Boolean);
  if (tipTree === "" || trees.length === 0) return null;
  if (trees[0] === tipTree) return "same";
  return trees.slice(1).includes(tipTree) ? "ahead" : null;
}

// The claim this build goes on from: its take as the team's own remote holds
// it, when that is ahead of the lead's claim (or the lead's project has none),
// so a proposal or result sent there before the lead's next look is built on;
// else the lead's claim as read.
function claimToGoOn(
  projectDir: string,
  home: { location: string },
  build: UnitBuild,
  ref: string,
  lead: UnitClaimView | null,
): { claim: UnitClaimView | null; outbox?: string } {
  const there = outboxTake(projectDir, home, build, ref);
  if (there === null || there.claim.oid === lead?.oid) return { claim: lead };
  if (lead !== null && claimAhead(projectDir, lead.oid, there.claim.oid) === null) return { claim: lead };
  return { claim: there.claim, outbox: there.outbox };
}

// This build's take as the team's own remote holds it, while the lead's
// project has not recorded it: read there, and only when it is this take's.
function outboxTake(projectDir: string, home: { location: string }, build: UnitBuild, ref: string): { outbox: string; claim: UnitClaimView } | null {
  const there = outboxClaim(projectDir, home, ref);
  const me = git(projectDir, ["config", "user.name"]).stdout.trim();
  return there?.claim.status === "claimed" && there.claim.payload.taken_by === me && there.claim.generation === build.attempt ? there : null;
}

// The claim the team's own remote holds, read there; null when there is none,
// it holds none, or it does not answer.
function outboxClaim(projectDir: string, home: { location: string }, ref: string): { outbox: string; claim: UnitClaimView } | null {
  const outbox = claimOutbox(projectDir, home);
  if (outbox === null) return null;
  try {
    const claim = quietly(() => currentClaim(projectDir, outbox, ref));
    return claim === null ? null : { outbox, claim };
  } catch {
    return null;
  }
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

// Each Unit's row in the Unit Progress table, as the board at a team home
// says it: its stage cells in order, its gate cell, and whether it is done by
// the opening rule (completedUnits), the one reading of done.
export interface UnitProgressStanding {
  stages: Array<{ stage: string; cell: string }>;
  gate: string;
  done: boolean;
}

export function unitProgressStanding(state: string): Map<string, UnitProgressStanding> {
  const table = unitProgressTable(state);
  const gateAt = table?.header.findIndex((cell) => cell.toLowerCase() === "gate") ?? -1;
  if (!table || gateAt < 2) return new Map();
  const done = completedUnits(state);
  return new Map(table.rows.map((cells) => [cells[0], {
    stages: table.header.slice(2, gateAt).map((stage, at) => ({ stage, cell: cells[2 + at] })),
    gate: cells[gateAt],
    done: done.has(cells[0]),
  }]));
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

// A Unit a checkout walks without a claim (the lead's own, begun before the
// teams took the others) is that checkout's, so it is never claimable (#3610).
function buildOverview(
  opening: ReturnType<typeof openingStatus>,
  claims: Map<string, UnitClaimView>,
  walked: ReadonlySet<string>,
  warning?: string,
  // The lead's own build-here claims (leadsOwnClaims): walked at the lead's
  // project, never a team's.
  own: ReadonlySet<string> = new Set(),
): UnitClaimOverview {
  const claimable: string[] = [];
  const claimed: UnitClaimOverview["claimed"] = [];
  const waiting: Array<{ unit: string; blockedBy: string[] }> = [];
  const walkedUnits: string[] = [];
  for (const unit of opening.units) {
    const claim = claims.get(unit);
    if (opening.completed.has(unit)) {
      if (claim?.status === "claimed" && opening.landed.has(unit)) claim.landed = true;
      continue;
    }
    if (claim?.status === "claimed" && !own.has(unit)) {
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
    if (walked.has(unit) || own.has(unit)) {
      walkedUnits.push(unit);
      continue;
    }
    const blockedBy = opening.blockers.get(unit) ?? [];
    if (blockedBy.length > 0) waiting.push({ unit, blockedBy });
    else claimable.push(unit);
  }
  return {
    claimable,
    claimed,
    waiting,
    claims,
    ...(walkedUnits.length > 0 ? { walked: walkedUnits } : {}),
    ...(warning ? { warning } : {}),
  };
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
  // The copies the caller reads: only the lead's project's own, when it says so.
  only?: (ref: string) => boolean,
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
  // A copy that descends from another is the newer one, whoever holds it.
  // Else the home's copies are read over another remote's, whatever their
  // generation: the one fetched by the lead's address first, then this
  // clone's own remote and local claim branches, so a fork's stale or
  // never-taken-in copy never hides the lead's own. Between copies of one
  // kind, the rule below.
  let ownRemote: string | null = null;
  try {
    ownRemote = repositoryRemote(projectDir);
  } catch {
    // No remote this clone calls its own: no copy ranks as one.
  }
  const homeCopy = (ref: string): number =>
    ref.startsWith("refs/aidlc/home/") ? 2
      : ref.startsWith("refs/heads/claim/") || (ownRemote !== null && ref.startsWith(`refs/remotes/${ownRemote}/`)) ? 1 : 0;
  const descends = (older: string, newer: string): boolean =>
    localGit(projectDir, ["merge-base", "--is-ancestor", older, newer]).ok;
  const readFrom = new Map<string, number>();
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [oid, ref] = line.trim().split(/\s+/, 2);
    if (!oid || !ref) continue;
    if (only !== undefined && !only(ref)) continue;
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
    const kind = homeCopy(ref);
    if (prior && prior.oid === oid) {
      prior.payload = payload;
      // Its rank too: a fork's older copy read after it never replaces it.
      readFrom.set(payload.unit, Math.max(readFrom.get(payload.unit) ?? 0, kind));
      continue;
    }
    const priorKind = readFrom.get(payload.unit);
    const newer = prior !== undefined && priorKind !== undefined && descends(prior.oid, oid);
    if (prior && priorKind !== undefined && !newer && descends(oid, prior.oid)) continue;
    if (prior && priorKind !== undefined && !newer && kind < priorKind) continue;
    if (
      prior && !newer && !(priorKind !== undefined && kind > priorKind) &&
      (prior.generation > payload.generation ||
        (prior.generation === payload.generation &&
          (
            prior.oid === oid ||
            (prior.status === "claimed" && payload.status === "released")
          )))
    ) {
      continue;
    }
    readFrom.set(payload.unit, kind);
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
  return buildOverview(opening, claims, new Set(unitsWalkedWithoutClaim(pd).keys()), cache?.warning, leadsOwnClaims(pd, state, claims));
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
  // The walked Units are read from the active work's own record.
  const active = selector.space === activeSpace(pd) && selector.intentUuid === activeIntentUuid(pd, selector.space);
  return buildOverview(opening, claims, active ? new Set(unitsWalkedWithoutClaim(pd).keys()) : new Set());
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
  return buildOverview(opening, observedClaims, new Set(unitsWalkedWithoutClaim(pd).keys()), undefined, leadsOwnClaims(pd, state, observedClaims));
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
      `aidlc/${WORKSPACE_ENGINE_DIR}/${UNIT_MERGE_DIR}`,
      // Where a candidate built by an earlier release would carry one.
      "aidlc/.aidlc-unit-merges",
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
    const promptSha256 = planApprovalPromptSha256(questions);
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

// What a Unit's publish left out of its commit, said once with its result: how
// many, the files themselves when few, else the top-level folders or files
// holding most of them (git's order breaks a tie), where to see them, and for
// the agent the command that puts any in; and an --include that named none.
function leftOutFields(unit: string, leftOut: string[], unmatched: string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (unmatched.length > 0) {
    const named = unmatched.map((path) => `\`${path}\``);
    fields.include_unmatched_note = `No new file here is at ${named.length < 2 ? named.join("") : `${named.slice(0, -1).join(", ")} or ${named.at(-1)}`}, ` +
      "so nothing from there went in.";
  }
  if (leftOut.length === 0) return fields;
  const one = leftOut.length === 1;
  let which: string;
  if (leftOut.length <= 3) {
    which = `: ${namesInProse(leftOut)}`;
  } else {
    const counts = new Map<string, number>();
    for (const path of leftOut) {
      const top = path.includes("/") ? `${path.slice(0, path.indexOf("/"))}/` : path;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    which = `, like ${namesInProse([...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([top]) => top))}`;
  }
  return {
    ...fields,
    left_out: leftOut.length,
    // The tool knows what the Unit's build listed, not what it wrote, so the
    // line says that.
    left_out_note: `I left out ${leftOut.length} new file${one ? "" : "s"} here that this Unit's build did not list as ` +
      `its own${which} (\`git status\` shows ${one ? "it" : "them"}); tell me if you want ${one ? "it" : "any of them"} in.`,
    left_out_include: "When they want any of them in, run " +
      `\`${aidlcInvocation()} unit publish ${quoteCommandArgument(unit)} --commit --include '<path>'\`` +
      ", with one --include for each file or folder they name, or `--include .` for all of them.",
  };
}

function publishUnit(args: string[], projectDir?: string): void {
  const { positional, flags, bareFlags } = parseArgs(args);
  // `--commit` takes no value; `publish --commit alpha` reads alpha as its own.
  const commitFirst = bareFlags.has("commit") || flags.commit !== undefined;
  const unit = positional[0] ?? (bareFlags.has("commit") ? undefined : flags.commit);
  if (!unit) fail(`usage: ${unitUsage("publish")}`);
  // parseArgs keeps a flag's last value; every --include counts.
  const include = args.flatMap((arg, i) =>
    arg === "--include" && i + 1 < args.length ? [args[i + 1]]
    : arg.startsWith("--include=") ? [arg.slice("--include=".length)]
    : []
  );
  const pd = resolveProjectDir(projectDir);
  const stamp = requireLiveClaimForTeamUnit(pd, unit);
  if (!stamp) fail("Unit publication requires a scoped team checkout.");
  let leftOut: Record<string, unknown> = {};
  if (commitFirst) {
    // A commit git refused leaves HEAD where it was, so the offer to publish
    // at this HEAD is due again.
    try {
      const done = commitWorkHere(pd, `Complete the ${unit} Unit`, { unit, include });
      leftOut = leftOutFields(unit, done.leftOut, done.unmatched);
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
      ...leftOut,
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
    ...leftOut,
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
  if (!unit) fail(`usage: ${unitUsage("pin")}`);
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
    fail(`usage: ${unitUsage("gate")}`);
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
    fail(`usage: ${unitUsage("land")}`);
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
  if (!unit) fail(`usage: ${unitUsage("adopt")}`);
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

function claimUnit(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail(`usage: ${unitUsage("claim")}`);
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
  // The team name in the file `next --claim` wrote for this command, so no
  // shell read it on the way; spent once the claim holds.
  let team = flags.team;
  let spend = (): void => {};
  if (flags["request-file"] !== undefined) {
    if (team !== undefined) fail("Pass either --team or --request-file, not both.");
    const read = readRequestFile(pd, flags["request-file"]);
    if (typeof read === "string") fail(read);
    team = read.text;
    spend = read.spend;
  }
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit claims require Unit Ownership: team.");
  // Where the work records its home, each team takes its Unit in its own clone
  // (take), and the lead's project is never scoped to one Unit.
  if (homeLocation(state) !== null) {
    fail(
      `Nothing is claimed here: this work's teams each take their Unit in their own clone, with ${entrySkillInvocation()} there.`,
    );
  }
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
      spend();
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
  // Another checkout was building it without a claim (#3610): the person asked
  // for it by name, so the claim is taken and they hear it once.
  const walkedIn = unitsWalkedWithoutClaim(pd).get(unit);
  const walkedWarning = walkedIn !== undefined && walkedIn !== knownAuditShardName(pd)
    ? `Unit "${unit}" was being built in the checkout that started it, before any team took a Unit; from now on ` +
      "it is yours, and that checkout sees it claimed."
    : null;
  const generation =
    current?.status === "released"
      ? current.generation
      : (current?.generation ?? 0) + 1;
  const nonce = randomUUID();
  const owner = claimOwnerLabel(pd, team);
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
  spend();
  const warning = [planWarning, walkedWarning].filter((line): line is string => !!line).join(" ");
  console.log(JSON.stringify({ claimed: true, ...stamp, ...(warning ? { warning } : {}) }));
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
  if (!unit) fail(`usage: ${unitUsage("release")}`);
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  const pd = resolveProjectDir(projectDir);
  // In the Unit's own build, release is the way back from its take.
  const build = ((): UnitBuild | null => {
    try {
      return unitBuildOf(readStateFile(pd));
    } catch {
      return null;
    }
  })();
  if (build !== null && build.unit === unit) {
    giveBack(pd, build);
    return;
  }
  if (readApplicableTeamUnitScopeStamp(pd)) {
    fail("release must run from an unscoped checkout.");
  }
  assertMainCheckout(pd);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) fail("Unit release requires Unit Ownership: team.");
  const identity = activeIdentity(pd);
  const integration = fetchIntegration(pd);
  const ref = claimRef(identity.intentId8, unit);
  const heard = takeInFirst(pd);
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
  if (current?.status !== "claimed") fail(withTakeInLines(pd, heard, `Unit "${unit}" has no live claim.`));
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
    ...(heard.length > 0 ? { notice: withTakeInLines(pd, heard, "").trim() } : {}),
  }));
}

// The way back from a take, run in the Unit's build: the claim at the lead's
// project is released, open again, and the build is set aside by the engine's
// own archive, so its record and audit stay and nothing is deleted. A claim
// that moved on since (a pushed result, a release at the lead's project) is
// left as it is. The person stays in the space they took it from.
function givenBackOn(unit: string, address: string): string {
  return `Gave ${unit} back on ${address}; the lead's project opens it again at the lead's next look.`;
}

// A taken claim given back: released, as the lead's release does, so the
// generation moves on and the build's attempt is over.
function releasedClaim(current: UnitClaimView): UnitClaimPayload {
  const { taken_by: _taker, early_on: _early, ...untaken } = current.payload;
  return {
    ...untaken, status: "released", owner: "released", nonce: randomUUID(),
    generation: current.generation + 1,
    predecessor_oid: current.oid,
  } as UnitClaimPayload;
}

function giveBack(pd: string, build: UnitBuild): void {
  const unit = build.unit;
  const home = buildsHome(pd, build);
  const ref = claimRef(home.id8, unit);
  let current: UnitClaimView | null;
  try {
    if (home.target !== null) ensureFetchedClaim(pd, home, ref);
    current = currentClaim(pd, home.target, ref);
  } catch {
    fail(`The lead's project could not be reached, so ${unit} is not given back yet and its build here stays as it is. Try again when it can be reached.`);
  }
  let said: string;
  const standing = takeStanding(pd, build).state;
  // The take the team's own remote holds, when it is ahead of the lead's claim, is the one given back.
  const on = standing === "aside" ? { claim: current } : claimToGoOn(pd, home, build, ref, current);
  const taken = on.claim;
  if (taken?.status === "claimed" && taken.payload.taken_by !== undefined && taken.generation === build.attempt &&
    taken.payload.result === undefined && (on.outbox !== undefined || standing === "recorded")) {
    const pushed = writeHomeClaim(pd, home, ref, createClaimCommit(pd, taken.oid, releasedClaim(taken)), current?.oid ?? null);
    if (pushed.elsewhere !== undefined) said = givenBackOn(unit, pushed.elsewhere);
    else if (!pushed.ok) {
      fail(`${unit} could not be given back: ${pushed.refused ?? "its claim at the lead's project moved meanwhile"}. Try again.`);
    } else {
      invalidateLiveClaimPayloadCache(pd, unit);
      said = `${unit} is given back: it is open again at the lead's project.`;
    }
  } else {
    said = `Nothing changed for ${unit} at the lead's project, which still has it as it was.`;
  }
  const dirName = resolveWorkflowSelection(pd).intent;
  const archived = dirName ? runEngineUtility(pd, ["intent", "archive", dirName, "--reason", "given back to the lead's project"]) : null;
  if (archived !== null && !archived.ok) fail(`${said} Its build here could not be set aside: ${(archived.stderr || archived.stdout).trim()}`);
  console.log(JSON.stringify({
    released: true,
    given_back: true,
    unit,
    notice: `${said} Its build here is set aside, with everything in it kept.`,
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

// A team's publish commits a Unit's own work, and the files the person named
// to put in as well (`--include`, a file or a folder).
export interface UnitWork {
  unit: string;
  include?: readonly string[];
}

export interface WorkToCommit {
  paths: string[];
  untracked: string[];
  // New files a Unit's publish leaves out, and the --include paths that named none.
  leftOut: string[];
  unmatched: string[];
}

// What a Unit's source manifests claim, as brought-files reads them: the
// stages that write source (Code Generation in core) each keep one.
function unitSourceClaims(projectDir: string, unit: string): SourceClaimModel[] {
  const record = recordDir(projectDir);
  if (record === null) return [];
  let stages: string[];
  try {
    stages = readdirSync(join(record, "construction", unit));
  } catch {
    return [];
  }
  return stages.flatMap((stage) => {
    if (!existsSync(join(record, "construction", unit, stage, "source-manifest.json"))) return [];
    const read = readUnitSourceManifest(projectDir, stage, unit);
    return read.ok ? [{ claims: read.claims, prefixes: read.prefixes }] : [];
  });
}

// What a commit of the work here takes: every change git shows, files git does
// not track included and ignored files left out, except AI-DLC's own part of a
// shared root file (publish leaves it uncommitted too). For a Unit's publish
// (`unit`), a new file outside aidlc/ is taken only when its source manifest
// claims it or an `include` path names it; the rest is left out, so AI-DLC's
// own install and an unignored node_modules stay out of the shared project. A
// Unit with no manifest that reads wrote no source this can tell, so all of
// those are left out and said. The share, publish and push questions name
// these, and commitWorkHere commits them.
export function workToCommit(projectDir: string, work?: UnitWork): WorkToCommit {
  const pd = resolveProjectDir(projectDir);
  const status = git(pd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return { paths: [], untracked: [], leftOut: [], unmatched: [] };
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
  const kept = paths.filter((path) => !own.has(path));
  const keptUntracked = untracked.filter((path) => !own.has(path));
  if (work === undefined) return { paths: kept, untracked: keptUntracked, leftOut: [], unmatched: [] };
  const claims = unitSourceClaims(pd, work.unit);
  // As the person or the agent types it, on Windows too: `\` is `/`, a folder
  // may end in `/`, and `.` is the whole project (every file left out).
  const include = [...new Set((work.include ?? [])
    .filter((path) => path.trim() !== "")
    .map((path) => path.replaceAll("\\", "/").replace(/\/+$/, "").replace(/^(\.\/)+/, "") || "."))];
  const under = (path: string, folder: string): boolean =>
    folder === "." || path === folder || path.startsWith(`${folder}/`);
  const outsideWork = keptUntracked.filter((path) =>
    !under(path, "aidlc") && !claims.some((claim) => sourceClaimCovers(sourcePathKey("", path), claim))
  );
  const leftOut = outsideWork.filter((path) => !include.some((folder) => under(path, folder)));
  const unmatched = include.filter((folder) => !outsideWork.some((path) => under(path, folder)));
  const out = new Set(leftOut);
  return {
    paths: kept.filter((path) => !out.has(path)),
    untracked: keptUntracked.filter((path) => !out.has(path)),
    leftOut,
    unmatched,
  };
}

// Commits what workToCommit names, as the person, with their own git setup;
// nothing to commit commits nothing. Returns how many paths it took, and what
// a Unit's publish left out.
function commitWorkHere(
  projectDir: string,
  message: string,
  work?: UnitWork,
): { committed: number; leftOut: string[]; unmatched: string[] } {
  const { leftOut, unmatched, paths } = workToCommit(projectDir, work);
  if (paths.length === 0) return { committed: 0, leftOut, unmatched };
  // One call whatever the count: Windows caps a command line at 32,767
  // characters, so the paths go to git on its standard input, NUL-separated,
  // each read as the same name an argument would be (git 2.25; core already
  // needs 2.29). An empty list never gets here: with -A and no path git would
  // take the whole tree.
  const added = git(
    projectDir,
    ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
    undefined,
    paths.map((path) => `${path}\0`).join(""),
  );
  if (!added.ok) shareCommitRefused(added.stderr.trim(), true);
  const committed = git(projectDir, ["commit", "-q", "-m", message]);
  if (!committed.ok) shareCommitRefused((committed.stderr || committed.stdout).trim(), false);
  return { committed: paths.length, leftOut, unmatched };
}

// What the share and publish say when git does not take their add or commit.
function shareCommitRefused(said: string, adding: boolean): never {
  if (adding) fail(`git add failed: ${said}`);
  if (NO_GIT_IDENTITY.test(said)) {
    fail(
      "Git has no name and email for your commits yet. Set them with " +
        'git config --global user.name "Your Name" and git config --global user.email "you@example.com".',
    );
  }
  fail(`git did not commit: ${said}.`);
}

// The plan's share: AI-DLC's record only (aidlc/, and a repos.json still at
// the root unless the person's .gitignore lists it), committed by pathspec
// through commitUnitPaths, so a file the person staged stays theirs, staged.
// Pathspecs, never the file list: a plan's hundreds of files would pass the
// 32,767 characters Windows allows a command line. Returns how many files the
// commit took.
function commitPlanHere(pd: string, message: string): number {
  const head = (): string => git(pd, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim();
  const before = head();
  const rootList = git(pd, ["check-ignore", "-q", "--", "repos.json"]).ok ? [] : ["repos.json"];
  commitUnitPaths(pd, ["aidlc/", ...rootList], {}, "", "", "", null, { message, refused: shareCommitRefused });
  if (head() === before) return 0;
  return git(pd, ["diff-tree", "-r", "--root", "--no-commit-id", "--name-only", "-z", "HEAD"]).stdout.split("\0").filter(Boolean).length;
}

// The remote and integration branch a share pushes to, or null with no remote.
export function shareTarget(projectDir: string): { remote: string; branch: string } | null {
  const remote = repositoryRemote(projectDir);
  if (!remote) return null;
  return { remote, branch: affirmedIntegrationBranch(projectDir)?.branch ?? integrationBranch(projectDir, remote) };
}

// Where checkInState (aidlc-unit-teams.ts) reads a record as checked in: the
// share's remote and branch, the branch named in `space`'s layers, else read
// from this clone's own refs. Null when neither names one.
export function checkInTarget(projectDir: string, space?: string): { remote: string; branch: string } | null {
  const remote = repositoryRemote(projectDir);
  if (!remote) return null;
  const branch = affirmedIntegrationBranch(projectDir, space)?.branch ?? integrationBranch(projectDir, remote, true);
  return branch === null ? null : { remote, branch };
}

// What a share or push offer names: the share target, or "the team's branch"
// while a layer's Way of Working words are still to be read (the share's own
// step reads them first, shareMain).
export function shareOfferTarget(projectDir: string): { remote: string; branch: string } | null {
  if (integrationBranchToRead(projectDir) === null) return shareTarget(projectDir);
  const remote = repositoryRemote(projectDir);
  return remote ? { remote, branch: "the team's branch" } : null;
}

// A clone that took part or holds a claim is a team's, not the lead's.
export function teamsClone(projectDir: string, stateContent: string): boolean {
  return existsSync(unitParticipantPath(projectDir)) ||
    readApplicableTeamUnitScopeStamp(projectDir, stateContent) !== null;
}

// The team's own answer on building a walking skeleton first, not read yet:
// team work whose scope runs one, no stance recorded, and the team's or the
// project's memory says something under `## Walking Skeleton` (Practices
// Discovery writes the team's). org.md's section is the framework's default,
// which reads as the scope's own answer, so it is not one. Which way the answer
// goes is the agent's to read (the classify round-trip); this reads only
// whether there is one.
export function teamSkeletonAnswerUnread(projectDir: string, stateContent: string): boolean {
  if (!isTeamUnitOwnership(stateContent) || getField(stateContent, "Skeleton Stance")) return false;
  if (loadScopeMetadata()[getField(stateContent, "Scope") ?? ""]?.skeleton !== true) return false;
  let memory: string;
  try {
    memory = memoryDirFor(projectDir);
  } catch {
    return false;
  }
  return ["team.md", "project.md"].some((file) => {
    try {
      return memorySectionBody(readFileSync(join(memory, file), "utf-8"), "## Walking Skeleton").trim() !== "";
    } catch {
      return false;
    }
  });
}

// The team's own walking-skeleton answer is read on the lead's checkout before
// any team step decides from it (the handout line, the share, a teammate's
// claim): a team's clone reads the lead's record and never writes the stance.
export function teamStanceToRead(projectDir: string, stateContent: string | null): boolean {
  return stateContent !== null && teamSkeletonAnswerUnread(projectDir, stateContent) &&
    !teamsClone(projectDir, stateContent) && !planMadeElsewhere(projectDir);
}

// The first Unit, when the plan as this checkout last shared or fetched it
// holds every Unit behind it as a walking skeleton while this checkout's own
// record opens them (its recorded answer is no thin slice first). Null when the
// two agree or the shared plan cannot be read.
export function skeletonHeldBackOnShare(projectDir: string): string | null {
  try {
    const pd = resolveProjectDir(projectDir);
    const state = readStateFile(pd);
    if (!isTeamUnitOwnership(state) || getField(state, "Skeleton Stance") === null || teamSkeletonOn(state)) return null;
    const target = shareTarget(pd);
    if (target === null) return null;
    const ref = git(pd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${target.remote}/${target.branch}`]);
    if (!ref.ok) return null;
    const shared = openingStatus(pd, ref.stdout.trim());
    return [...shared.blockers.values()].some((blockers) => blockers.includes("walking-skeleton")) ? shared.skeleton : null;
  } catch {
    return null;
  }
}

// Whether a share can run here: team work, a checkout holding no Unit claim, a
// remote, and HEAD on the integration branch. Null when it can; the reason
// otherwise. The share offer is put only where this is null.
export function shareBlocker(projectDir: string): string | null {
  const pd = resolveProjectDir(projectDir);
  try {
    if (readApplicableTeamUnitScopeStamp(pd)) return "This checkout holds a Unit claim; share main from a checkout that holds none.";
    if (!isTeamUnitOwnership(readStateFile(pd))) return "Sharing main is for work that several teams build.";
    if (!repositoryRemote(pd)) return "This repository has no remote to share main with. Add one (git remote add origin <url>), then share again.";
    // The branch is read from the Way of Working words first, by the share's own step.
    if (integrationBranchToRead(pd) !== null) return null;
    const target = shareTarget(pd)!;
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
  // The branch the share pushes, read from the team's own words before
  // anything is committed or pushed; the offers stay due in case the share
  // does not run again.
  const toRead = integrationBranchToRead(pd);
  if (toRead !== null) {
    clearTeamHandoverMarks(pd, ["share", "push"]);
    console.log(JSON.stringify({
      shared: false,
      step: integrationBranchReadStep(toRead, `then run \`${aidlcInvocation()} unit share${planOnly ? " --plan" : ""}\` again and tell the person ` +
        "in plain words what it reports"),
    }));
    return;
  }
  // The team's own answer on building a thin slice first is read before the
  // plan goes to the teams, by the rule the reading step in `next` and the
  // report go by (teamStanceToRead), so the shared plan carries it. Nothing is
  // committed or pushed until it is; the offers stay due in case the share
  // does not run again.
  if (teamStanceToRead(pd, readStateFile(pd))) {
    clearTeamHandoverMarks(pd, ["share", "push"]);
    const memory = relative(pd, memoryDirFor(pd)).replaceAll("\\", "/");
    console.log(JSON.stringify({
      shared: false,
      step: "Run these now, in this turn: read the \"## Walking Skeleton\" section of " +
        `${memory}/project.md over ${memory}/team.md and settle what the team says it does: on if the team always ` +
        "runs a walking skeleton, off if it says it does not run one, scope-dependent if it says neither. Run " +
        `\`${aidlcToolInvocation("orchestrate")} report --skeleton-stance <on|off|scope-dependent>\` with that stance, ` +
        `then run \`${aidlcInvocation()} unit share${planOnly ? " --plan" : ""}\` again and tell the person in plain words what it reports.`,
    }));
    return;
  }
  const { remote, branch } = shareTarget(pd)!;
  const landed = landedNotOnRemote(pd).map((row) => row.unit);
  const message = landed.length > 0 ? `Record the ${landed.join(" and ")} landing` : "Share the plan with the teams";
  let committed: number;
  try {
    committed = planOnly ? commitPlanHere(pd, message) : commitWorkHere(pd, message).committed;
  } catch (error) {
    clearTeamHandoverMarks(pd, ["share", "push"]);
    fail(`${errorMessage(error)} Then share again.`);
  }
  const pushed = git(pd, ["push", remote, `HEAD:refs/heads/${branch}`], { GIT_TERMINAL_PROMPT: "0" });
  // The plan's push to a home that does not answer: there is nothing to pull,
  // and its question is not put again each turn; the person asks when it can.
  if (!pushed.ok && planOnly && !quietly(() => git(pd, ["ls-remote", "--heads", remote]).ok)) {
    fail(
      `${remote} could not be reached, so the plan was not shared${committed > 0 ? " (the commit is kept here)" : ""}. ` +
        `Once it can be reached, \`${aidlcInvocation()} unit share --plan\` shares it.`,
    );
  }
  if (!pushed.ok) {
    clearTeamHandoverMarks(pd, ["share", "push"]);
    fail(
      `${remote} did not take ${branch}: ${pushRefusal(pushed.stderr)}. ` +
        `${committed > 0 ? "The commit is kept here: " : ""}pull ${branch}, then share again.`,
    );
  }
  noteTeamShared(pd);
  const claims = claimsAskedHereWithShare(pd);
  const notice = [
    ...(claims.sent.length > 0 ? [`Pushed ${branch}, and ${builtHereNote(claims.sent)}, to ${remote}.`] : []),
    ...claims.lines,
  ];
  console.log(JSON.stringify({
    shared: true,
    remote,
    branch,
    commit: gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve HEAD"),
    committed_paths: committed,
    ...(notice.length > 0 ? { notice: notice.join(" ") } : {}),
    step: "Tell the person in plain words what it reports, then end your turn.",
  }));
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
// them (personAskedSinceGate). The five that settle a team's Unit (an answer
// to a proposal, a turn-down, a merge by word, a sign-off, a send-back) are
// refused without one (leadsWord), with the step for a reply the hooks may
// have missed; assign goes on, and records no words as the lead's.
function leadSpoke(pd: string): boolean {
  return humanPresenceGuardDisabled() || personAskedSinceGate(pd);
}

function requireLeadsWord(pd: string, what: string): void {
  if (!leadSpoke(pd)) fail(`${what} is the person's own word: ask them first, then run this with their words.${unattendedHumanPresenceHint(pd)}`);
}

// The lead's word that settles a team's Unit, as the engine's other decisions
// keep the person's words: the message the agent names (`--message <id>`, proved by proveMessage's
// request form, which stands in for the turn requireLeadsWord looks for), else
// the one message the request came in: their latest reply in this chat since
// the last decision (personsGateReply's window, over a window no stage starts),
// never the chat before it, since the words go onto the claim every team reads.
// A reply sent while the engine's own question for this verb (`ask`) was on
// screen answers that question, and the window holds it aside: the turn the
// hook wrote names the question, so its message is taken as a named one, as
// `log answer` takes an inherited id. `said`
// is what they typed, from the message store, and only it goes on a row as
// theirs (`fields`); null when the store kept no words of theirs (hooks off, a
// host that passed no text), where the request file's text is all there is.
const LEAD_WORD_WINDOW = "unit-lead-word";
function leadsWord(
  pd: string,
  flags: Record<string, string | undefined>,
  what: string,
  ask?: string,
): { said: string | null; fields: Record<string, string> } {
  const { proveMessage, readMessage } = require("./aidlc-message-store.ts") as typeof import("./aidlc-message-store.ts");
  // The one message their word came in, by the first way that names it.
  let message: import("./aidlc-message-store.ts").StoredMessage | null;
  if (flags.message !== undefined) {
    const proof = proveMessage(pd, flags.message, "decision", { request: true });
    if ("refusal" in proof) fail(proof.refusal);
    message = proof.message;
  } else {
    requireLeadsWord(pd, what);
    let chat: string | null = null;
    try {
      chat = resolveInvokingSessionId(pd);
    } catch {
      // No chat to name: the window reads none as the lead's.
    }
    const reply = personsGateReply(pd, chat, LEAD_WORD_WINDOW);
    const held = new Set(reply.elsewhere.map((entry) => entry.id));
    const answered = ask === undefined || held.size === 0 ? undefined : readAuditShardEvents(pd).findLast((row) =>
      row.event === "HUMAN_TURN" && held.has(auditBlockField(row.block, "Message Id") ?? "") &&
      auditBlockField(row.block, OPEN_QUESTION_FIELD) === ask);
    const id = answered === undefined ? null : auditBlockField(answered.block, "Message Id");
    const proof = id === null ? null : proveMessage(pd, id, "decision", { request: true });
    if (proof !== null && "message" in proof) message = proof.message;
    else {
      message = reply.messageId === null ? null : readMessage(pd, reply.messageId);
      // A message the store kept only in part: named, its words left to its record.
      if (message?.cut === true) return { said: null, fields: { "Message Id": message.id } };
    }
  }
  if (message === null) return { said: null, fields: {} };
  const text = message.words === null ? "" : personsWordsText(message.words);
  const theirs = text.trim() !== "" && !isNonAnswer(text);
  return { said: theirs ? text.trim() : null, fields: { "Message Id": message.id, ...(theirs ? { "Person Reply": text } : {}) } };
}

// The lead's word to build a Unit at the lead's project (`--here <unit>`), in
// their own words: every other Unit is open for anyone to take.
function assignUnits(args: string[], projectDir?: string): void {
  const { flags } = parseArgs(args);
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state) || homeLocation(state) === null) {
    fail("Units are given to teams once teams are chosen for this work.");
  }
  if (readApplicableTeamUnitScopeStamp(pd)) fail("Units are given to teams at the lead's project, not from a checkout scoped to one Unit.");
  const words = leadSpoke(pd) ? personWordsOf(pd, flags) : "";
  buildLeftOpenHere(pd, state, (flags.here ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry && entry !== "true"), words);
}

// The lead's word to build a Unit at the lead's project after all (`assign
// --here`), a take like any other: its claim is written for the lead's project
// with the take's compare-and-swap, so no teammate takes it meanwhile, then
// the walk takes it up. A Unit someone took first stays theirs. The lead's own
// claim already there is this word again: its row is written, the same line said.
// The lead's claim on a Unit built here, written with the take's compare-and-
// swap so no teammate takes it meanwhile: assign --here once the plan is
// shared, and the share for a Unit asked here before then. One someone else
// built and merged is taken back to build here, as a new attempt (the lead's
// Build and Test asked to fix it here); one still being built stays theirs.
function writeHereClaim(
  pd: string,
  identity: ReturnType<typeof activeIdentity>,
  integration: ReturnType<typeof fetchIntegration>,
  unit: string,
  state: string,
): { kind: "here" } | { kind: "theirs"; line: string } | { kind: "unseen"; why: string } {
  validateClaimRefUnit(identity.intentId8, unit);
  const ref = claimRef(identity.intentId8, unit);
  const current = currentClaim(pd, integration.remote, ref);
  const takenBack = current?.status === "claimed" && current.payload.done === true &&
    !(current.owner === identity.space && claimIsMine(pd, current));
  if (current?.status === "claimed" && !takenBack) {
    return current.owner === identity.space && claimIsMine(pd, current) ? { kind: "here" } : { kind: "theirs", line: takenLine(unit, current) };
  }
  const payload = takenClaimPayload(current, {
    team: identity.space, home: { space: identity.space, uuid: identity.intentUuid, id8: identity.intentId8 }, unit, ref,
    generation: takenBack ? (current?.generation ?? 0) + 1 : takeGeneration(current), me: gitUserName(pd) ?? "a teammate",
    baseOid: integration.oid, integrationRef: integration.ref, gateRhythm: readUnitGateRhythm(state),
  });
  const pushed = updateClaimRef(pd, integration.remote, ref, createClaimCommit(pd, current?.oid ?? integration.oid, payload), current?.oid ?? null);
  if (!pushed.ok) {
    const winner = currentClaim(pd, integration.remote, ref);
    if (winner?.status === "claimed") return { kind: "theirs", line: takenLine(unit, winner) };
    return { kind: "unseen", why: pushed.refused?.replace(/\.+$/, "") ?? "it changed meanwhile" };
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  return { kind: "here" };
}

function hereNotSeenLine(unit: string, why: string): string {
  return `${unit} is built here now. The teams cannot see that yet (${why}), so a teammate could still take it meanwhile.`;
}

// The teams' clones see the work as a team home only once the remote's main
// (as this clone last fetched it) carries its state with the home recorded.
export function planUnshared(projectDir: string, target: { remote: string; branch: string }): boolean {
  const state = relative(projectDir, stateFilePath(projectDir)).split("\\").join("/");
  const shown = git(projectDir, ["show", `refs/remotes/${target.remote}/${target.branch}:${state}`]);
  return !shown.ok || homeLocation(shown.stdout) === null;
}

// The Units the lead asked to build here: the share writes the claim of each
// that has none, and its question names them while the plan is not shared yet
// (assign --here writes no claim then).
export function unitsAskedHereForShare(pd: string): string[] {
  return [...unitsAskedHere(readAuditShardEvents(pd))];
}

// The words for the claim of a Unit built here that a share sends: the share
// question, its choice and the share's own line say it the same way.
export function builtHereNote(units: string[]): string {
  return `the note that ${namesInProse(units)} ${units.length === 1 ? "is" : "are"} built here`;
}

// At the share, a Unit the lead asked to build here before it, with no claim
// yet, gets its claim, so a team's clone sees it taken from its first look:
// the Units whose claim went, and the lines for one that could not be written.
function claimsAskedHereWithShare(pd: string): { sent: string[]; lines: string[] } {
  const asked = unitsAskedHereForShare(pd);
  if (asked.length === 0) return { sent: [], lines: [] };
  let integration: ReturnType<typeof fetchIntegration> | null = null;
  let why = "it could not be read just now";
  try {
    integration = fetchIntegration(pd);
  } catch (e) {
    why = errorMessage(e).replace(/\.+$/, "");
  }
  const identity = activeIdentity(pd);
  const state = readStateFile(pd);
  const sent: string[] = [];
  const lines: string[] = [];
  for (const unit of asked) {
    if (integration === null) {
      lines.push(hereNotSeenLine(unit, why));
      continue;
    }
    if (currentClaim(pd, integration.remote, claimRef(identity.intentId8, unit)) !== null) continue;
    const claimed = writeHereClaim(pd, identity, integration, unit, state);
    if (claimed.kind === "here") sent.push(unit);
    else if (claimed.kind === "unseen") lines.push(hereNotSeenLine(unit, claimed.why));
    else lines.push(claimed.line);
  }
  return { sent, lines };
}

function buildLeftOpenHere(pd: string, state: string, units: string[], words: string): void {
  if (units.length === 0) fail(`usage: ${unitUsage("assign")}`);
  const local = localOpeningStatus(pd);
  for (const unit of units) {
    if (!local.units.includes(unit)) fail(`${unit} is not one of this work's Units (${local.units.join(", ")}).`);
  }
  const identity = activeIdentity(pd);
  affirmedIntegrationBranch(pd);
  // Before the plan is shared no team's clone can see its Units: nothing is
  // pushed, and the claim goes with the share (claimsAskedHereWithShare).
  let target: ReturnType<typeof shareTarget> = null;
  try {
    target = shareTarget(pd);
  } catch {
    // No remote to read: the claim's own write below says why.
  }
  const unshared = target !== null && planUnshared(pd, target);
  let integration: ReturnType<typeof fetchIntegration> | null = null;
  let unseen: string | null = null;
  if (!unshared) {
    try {
      integration = fetchIntegration(pd);
    } catch (e) {
      unseen = errorMessage(e).replace(/\.+$/, "");
    }
  }
  const lines: string[] = [];
  const here: string[] = [];
  const notSeen: string[] = [];
  for (const unit of units) {
    if (unshared) {
      here.push(unit);
      continue;
    }
    if (integration === null) {
      here.push(unit);
      notSeen.push(unit);
      continue;
    }
    const claimed = writeHereClaim(pd, identity, integration, unit, state);
    if (claimed.kind === "theirs") {
      lines.push(claimed.line);
      continue;
    }
    if (claimed.kind === "unseen") {
      unseen ??= claimed.why;
      notSeen.push(unit);
    }
    here.push(unit);
  }
  // Who merged a Unit taken back here, read before this row sets that merge aside.
  const rows = here.length > 0 ? readAuditShardEvents(pd) : [];
  const mergedBy = new Map(here.map((unit) => [unit, auditBlockField(unitMergesStanding(rows, unit).at(-1)?.block ?? "", "Built By")]));
  if (here.length > 0) {
    appendAuditEntry("UNITS_ASSIGNED", {
      Here: here.join(", "),
      ...(words.trim() ? { "Person Words": words.trim() } : {}),
    }, pd);
  }
  const notice = [
    ...here.map((unit) => notSeen.includes(unit)
      ? hereNotSeenLine(unit, unseen ?? "it changed meanwhile")
      : mergedBy.get(unit)
        ? `${unit} is built here now, on top of what ${mergedBy.get(unit)} merged.`
        : `${unit} is built here now, no longer open for the teams.`),
    ...lines,
  ].join(" ");
  // The line rides the step that follows, as the take's carry-on line does, so
  // a next run at once says it with its own; with no chat known it is printed.
  const forNextStep = notice !== "" && saidWithNextStep(pd, notice);
  console.log(JSON.stringify({ here, ...(forNextStep ? {} : { notice }) }));
}

// A take refused because the Unit is taken: who builds it, and where.
function takenLine(unit: string, claim: UnitClaimView): string {
  return `${unit} is already taken: ${builderOf(claim)} builds it${spaceWords(claim.owner)}.`;
}

// The person's own take whose build is not in this checkout but committed on
// another branch of this clone (checked in on a branch of its own for a pull
// request, the checkout back on main): where it is and the way to it, for the
// take question (unitTakeLook) and the take asked again. Local reads only,
// never a fetch or a switch: null, so the words stand as they were, when the
// take is not theirs, no other branch free to switch to has the build, or a
// git call is not ok.
export function buildOnBranchLine(projectDir: string, homeWork: string, claim: UnitClaimView): string | null {
  if (!claimIsMine(projectDir, claim)) return null;
  // Globs whatever the person's environment says (aidlc-workspace-doctor's way).
  const env = { GIT_LITERAL_PATHSPECS: "0" };
  const listed = localGit(projectDir, ["for-each-ref", "--sort=-committerdate", "--format=%(worktreepath)%00%(refname)", "refs/heads/"], env);
  if (!listed.ok) return null;
  // A branch checked out here or in another worktree is not one to switch to.
  const refs = listed.stdout.split(/\r?\n/).map((line) => line.split("\0"))
    .filter(([worktree, ref]) => worktree === "" && ref?.startsWith("refs/heads/")).map(([, ref]) => ref);
  const field = `^- \\*\\*${UNIT_BUILD_FIELD}\\*\\*:[[:blank:]]*${claim.unit.replaceAll(".", "\\.")}[[:space:]]*$`;
  // Newest branch first, a hundred a call so no command line runs too long on Windows.
  for (let at = 0; at < refs.length; at += 100) {
    const found = localGit(projectDir, ["grep", "--no-color", "-z", "-l", "-E", "-e", field, ...refs.slice(at, at + 100), "--",
      "aidlc/spaces/*/intents/*/aidlc-state.md"], env);
    if (!found.ok && found.code === 1) continue;
    if (!found.ok) return null;
    for (const hit of found.stdout.split("\0").filter(Boolean)) {
      const ref = hit.slice(0, hit.indexOf(":"));
      const shown = localGit(projectDir, ["show", `${ref}:./${hit.slice(ref.length + 1)}`], env);
      if (!shown.ok) return null;
      const build = liveBuildOf(shown.stdout);
      if (build === null || !isBuildOfUnit(build, homeWork, claim.unit)) continue;
      const branch = ref.slice("refs/heads/".length);
      // A backtick breaks the line's code marks, an apostrophe a PowerShell paste.
      return /[`']/.test(branch) ? null : `Your build of ${claim.unit} is on branch ${branch}: \`git switch ${shellArg(branch)}\` to carry it on.`;
    }
  }
  return null;
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
  // The lead's record is not in this workspace: it is read from the lead's
  // copy AI-DLC fetched by the lead's address (leadCopyRef), which comes with
  // the claims (refreshHomeClaims).
  leadCopy?: boolean;
  // The claims go to this clone's own remote because the recorded address could
  // not be reached (homeTarget): git's words, and that remote's address.
  atOrigin?: { why: string; origin: string };
}

// This clone's own remote carries the work's claims (git tracks them under
// it): it is the lead's repo, however its address is spelled (ssh beside
// https, a host's own ssh port or path, an ssh alias), so the claims are read
// and written through it with the person's own login. The refs a clone kept
// are only the hint: a clone whose origin was switched to the team's own repo
// keeps them too, and a fork can copy the lead's claim branches. So while the
// recorded address answers, the remote counts only when it lists the same
// claims there, commit for commit; when the address does not answer, the
// remote stands on the kept refs. `unanswered` names it when neither answers.
function remoteHoldsClaims(
  projectDir: string,
  id8: string,
  location: string,
): { holds: boolean; unanswered?: string } {
  try {
    const remote = repositoryRemote(projectDir);
    if (remote === null) return { holds: false };
    if (git(projectDir, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/${remote}/claim/${id8}/`]).stdout.trim() === "") return { holds: false };
    const claims = `refs/heads/claim/${id8}/*`;
    const listed = quietly(() => git(projectDir, ["ls-remote", remote, claims]));
    const atHome = isGitAddress(location) ? quietly(() => git(projectDir, ["ls-remote", location, claims])) : null;
    if (atHome === null || !atHome.ok) {
      if (listed.ok) return { holds: listed.stdout.trim() !== "" };
      return { holds: true, unanswered: remote };
    }
    const sorted = (text: string): string => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort().join("\n");
    return { holds: listed.ok && atHome.stdout.trim() !== "" && sorted(listed.stdout) === sorted(atHome.stdout) };
  } catch {
    return { holds: false };
  }
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
  refuseOptionAddress(location, recordedAddressRefusal(dirName));
  const row = readIntentRegistry(projectDir, space).find((entry) => entry.dirName === dirName);
  if (!row?.uuid) fail(`${dirName} has no entry in its space's list of work.`);
  const id8 = idSuffix(row.uuid);
  const recordPrefix = `aidlc/spaces/${space}/intents/${dirName}`;
  const { target, atOrigin } = homeTarget(projectDir, location, id8, { space, recordPrefix });
  return {
    space,
    dirName,
    uuid: row.uuid,
    id8,
    label: row.slug,
    location,
    target,
    recordPrefix,
    repos: row.repos ?? [],
    solo,
    ...(atOrigin !== undefined ? { atOrigin } : {}),
  };
}

// An address git is given as the remote to read and write: one that starts
// with "-" would be read as an option, so it is never passed on.
function refuseOptionAddress(address: string, refusal: string): void {
  if (address.startsWith("-")) fail(refusal);
}

function recordedAddressRefusal(dirName: string): string {
  return `${dirName}'s recorded lead's project address starts with "-", so git would read it as an option; nothing was ` +
    "read or written. Its Home Location in the work's state names the lead's project: correct it to the address it is cloned from.";
}

// Where the lead's claims are read and written: this workspace's own remote
// when the recorded lead's project is it, else the recorded address. Before any
// claim is there, the recorded address out of reach and this clone's own remote
// holding the lead's plan (`plan`, the lead's record here) is the lead's repo by
// another spelling (ssh beside the lead's https): the claims go there, and the
// take says so once (`atOrigin`). Once a claim is there, remoteHoldsClaims
// reads it. A team's own workspace made from the lead's reaches the lead's
// address, so it never gets here unless the lead's project is out of reach too.
function homeTarget(
  projectDir: string,
  location: string,
  id8: string,
  plan?: { space: string; recordPrefix: string },
): { target: string | null; atOrigin?: { why: string; origin: string } } {
  const own = workspaceHomeLocation(projectDir);
  if (location === "local" || (own !== null && sameGitAddress(location, own))) return { target: repositoryRemote(projectDir) };
  const held = remoteHoldsClaims(projectDir, id8, location);
  if (held.unanswered !== undefined) unansweredHomes.add(held.unanswered);
  if (held.holds) return { target: repositoryRemote(projectDir) };
  const remote = repositoryRemote(projectDir);
  if (plan === undefined || remote === null || own === null || own === "local") return { target: location };
  const reached = quietly(() => git(projectDir, ["ls-remote", "--heads", location]));
  if (reached.ok) return { target: location };
  const branch = affirmedIntegrationBranch(projectDir, plan.space)?.branch ?? integrationBranch(projectDir, remote);
  if (!git(projectDir, ["cat-file", "-e", `refs/remotes/${remote}/${branch}:${plan.recordPrefix}/aidlc-state.md`]).ok) return { target: location };
  return { target: remote, atOrigin: { why: gitSaid(reached.stderr) || "it did not answer", origin: own } };
}

// --- The lead's project by its address (a team's own workspace) -------------
//
// The person says where the lead's project is, once. Its branch is fetched
// once into AI-DLC's own ref (leadCopyRef), never a folder or a remote, and the
// lead's work teams build is read from that commit with git. After the take,
// each later step reads the lead from the build's own record (leadOfBuild).

export interface LeadWork {
  space: string;
  dirName: string;
  uuid: string;
  slug: string;
  repos: string[];
  state: string;
  dependencies: string;
}

// The lead's work teams build at a commit: each record with Home Location and
// team ownership (a Unit's build is not one), with its row in its space's list.
export function leadWorkAt(projectDir: string, oid: string): LeadWork[] {
  const listed = git(projectDir, ["ls-tree", "-r", "--name-only", oid, "--", "aidlc/spaces"]);
  const works: LeadWork[] = [];
  for (const path of listed.ok ? listed.stdout.split(/\r?\n/) : []) {
    const at = /^aidlc\/spaces\/([^/]+)\/intents\/([^/]+)\/aidlc-state\.md$/.exec(path);
    if (at === null) continue;
    const [, space, dirName] = at;
    const state = textAt(projectDir, oid, path);
    if (state === null || !isTeamUnitOwnership(state) || homeLocation(state) === null || unitBuildOf(state) !== null) continue;
    const row = registryList(textAt(projectDir, oid, `aidlc/spaces/${space}/intents/intents.json`) ?? "")?.find((entry) => entry.dirName === dirName);
    const dependencies = textAt(projectDir, oid, `aidlc/spaces/${space}/intents/${dirName}/inception/units-generation/unit-of-work-dependency.md`);
    if (!row?.uuid || dependencies === null) continue;
    works.push({ space, dirName, uuid: row.uuid, slug: row.slug || dirName, repos: row.repos ?? [], state, dependencies });
  }
  return works;
}

// The lead's project by the address the person said: refused before any git
// call when git would read it as an option, its branch fetched once, and the
// lead's work teams build there, each work's copy kept where a take and the
// later looks read it.
export function leadWorkByAddress(projectDir: string, address: string): { oid: string; branch: string; works: LeadWork[] } {
  refuseOptionAddress(address, `The lead's project address ${JSON.stringify(address)} starts with "-", so git would read it as an ` +
    "option; nothing was read or written. Ask the person for the address the lead's project is cloned from.");
  const fetched = fetchLeadBranch(projectDir, address, maskUserinfo(address));
  const works = leadWorkAt(projectDir, fetched.oid);
  for (const work of works) git(projectDir, ["update-ref", leadCopyRef(idSuffix(work.uuid)), fetched.oid]);
  return { ...fetched, works };
}

function homeByAddress(projectDir: string, address: string, dirName: string, space: string): { home: HomeWork; fetched: { branch: string; oid: string } } {
  const { works, ...fetched } = leadWorkByAddress(projectDir, address);
  const work = works.find((entry) => entry.dirName === dirName && entry.space === space);
  if (work === undefined) fail(`The lead's project at ${maskUserinfo(address)} has no work teams build named ${dirName} in space ${space}.`);
  // The build's record, which the team commits, keeps the address without a
  // sign-in, as the lead's own record does; this take reaches it as it was said.
  return {
    home: {
      space, dirName, uuid: work.uuid, id8: idSuffix(work.uuid), label: work.slug, location: withoutCredentials(address), target: address,
      recordPrefix: `aidlc/spaces/${space}/intents/${dirName}`, repos: work.repos, solo: false, leadCopy: true,
    },
    fetched,
  };
}

// The lead of a build whose lead's record is not in this workspace, read from
// the build's own record (Home Location, Home Work, Home Record, Home Label).
// Null when the lead's record is here or the build's lead is not an address.
export function leadOfBuild(projectDir: string, build: UnitBuild): HomeWork | null {
  if (leadRecordHere(projectDir, build.homeRecord) || !isGitAddress(build.homeLocation)) return null;
  const at = build.homeRecord.indexOf("/");
  const space = build.homeRecord.slice(0, at);
  const dirName = build.homeRecord.slice(at + 1);
  const here = findUnitBuild(projectDir, build.homeWork, build.unit);
  refuseOptionAddress(build.homeLocation, recordedAddressRefusal(here?.dirName ?? build.unit));
  let label = dirName;
  let repos: string[] = [];
  if (here !== null) {
    try {
      label = getField(readStateFile(projectDir, here.dirName, here.space), "Home Label")?.trim() || dirName;
      repos = intentRepos(projectDir, here.dirName, here.space);
    } catch {
      // The build's own fields stand.
    }
  }
  const id8 = idSuffix(build.homeWork);
  return {
    space, dirName, uuid: build.homeWork, id8, label, location: build.homeLocation,
    target: homeTarget(projectDir, build.homeLocation, id8).target,
    recordPrefix: `aidlc/spaces/${space}/intents/${dirName}`, repos, solo: false, leadCopy: true,
  };
}

// The lead's branch fetched by the lead's address, once, with the person's own
// login: the branch the claim names, else the one the lead's HEAD names (main
// when it names none). Into `into` when the lead's work is known; else the
// commit is the one ls-remote saw, which the fetch brought.
function fetchLeadBranch(projectDir: string, address: string, location: string, branch?: string, into?: string): { branch: string; oid: string } {
  let name = branch;
  let seen: string | undefined;
  if (!name) {
    const advertised = git(projectDir, ["ls-remote", "--symref", address, "HEAD"]);
    if (!advertised.ok) fail(`The lead's project at ${location} could not be reached: ${advertised.stderr.trim()}`);
    name = advertised.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m)?.[1] ?? "main";
    seen = advertised.stdout.match(/^([0-9a-f]{40,64})\s+HEAD$/m)?.[1];
  }
  const fetched = git(projectDir, ["fetch", "--no-tags", address, `+refs/heads/${name}${into ? `:${into}` : ""}`]);
  if (!fetched.ok) {
    const refused = localGitWriteRefused(fetched.stderr);
    if (refused !== null) throw new GitWriteRefused(refused);
    fail(`The lead's project at ${location} could not be fetched: ${fetched.stderr.trim()}`);
  }
  if (into) return { branch: name, oid: gitOutput(projectDir, ["rev-parse", "--verify", into], "The lead's project's branch is not here") };
  if (seen === undefined || !git(projectDir, ["cat-file", "-e", `${seen}^{commit}`]).ok) {
    fail(`The lead's project at ${location} could not be read: its branch ${name} moved while it was fetched. Run the same command again.`);
  }
  return { branch: name, oid: seen };
}

// The home's integration branch, fetched with the person's own login: through
// this workspace's remote, or by the home's address into AI-DLC's own ref
// (`prefetched`: the branch a take by the lead's address already fetched).
// While the push address stands in for a lead's project that did not answer
// (`standsIn`), the branch as this clone last fetched it.
function fetchHomeIntegration(
  projectDir: string,
  home: HomeWork,
  claim: UnitClaimView | null,
  prefetched?: { branch: string; oid: string },
  standsIn = false,
): { ref: string; branch: string; oid: string } {
  if (home.target === null || !isGitAddress(home.target)) {
    const remote = home.target;
    const affirmed = affirmedIntegrationBranch(projectDir, home.space);
    const branch = affirmed?.branch ?? integrationBranch(projectDir, remote);
    if (remote) {
      const fetched = git(projectDir, ["fetch", remote, branch]);
      // Where the name came from, so the person can correct it there.
      const from = affirmed ? `, named in ${affirmed.source} under Way of Working,` : "";
      const lastFetched = standsIn && localGit(projectDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]).ok;
      if (!fetched.ok && !lastFetched) fail(`The lead's project's branch ${branch}${from} could not be fetched from ${remote}: ${fetched.stderr.trim()}`);
    }
    const ref = remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`;
    return { ref, branch, oid: gitOutput(projectDir, ["rev-parse", "--verify", ref], `The lead's project's branch ${branch} is not here`) };
  }
  const fromClaim = claim?.payload.integration_ref.match(/^refs\/(?:remotes\/[^/]+|heads)\/(.+)$/)?.[1];
  const ref = leadCopyRef(home.id8);
  if (prefetched !== undefined && (!fromClaim || fromClaim === prefetched.branch)) {
    const kept = git(projectDir, ["update-ref", ref, prefetched.oid]);
    if (!kept.ok) fail(`The lead's project's branch could not be kept here: ${kept.stderr.trim()}`);
    return { ref, ...prefetched };
  }
  return { ref, ...fetchLeadBranch(projectDir, home.target, home.location, fromClaim, ref) };
}

// What the home's plan says at a commit: its state and Unit plan, read from
// git, or a line that the lead has not pushed it yet.
function homePlanAt(projectDir: string, home: HomeWork, oid: string, branch: string): { state: string; dependencies: string } {
  const read = (rel: string): string => {
    const shown = git(projectDir, ["show", `${oid}:${home.recordPrefix}/${rel}`, "--"]);
    if (!shown.ok) {
      fail(`The lead's work is not on its branch ${branch} yet, so there is nothing to take: the lead pushes it first.`);
    }
    return shown.stdout;
  };
  return { state: read("aidlc-state.md"), dependencies: read("inception/units-generation/unit-of-work-dependency.md") };
}

// The lead's approved Ideation and Inception outputs a Unit's build reads: the
// copy it starts from, at the paths the lead's own checkout holds them, plus
// the Unit plan itself. Each the Unit's planned stages read, and each output of
// a stage they stand on (requires_stage, all the way up) that the lead's plan
// ran (`state`), so what a stage reads there without naming it (the mockups
// the lead approved) is here too, and the lead's planning of the work itself
// (Delivery Planning) is not. The lead's notes of the code (Reverse
// Engineering) and of their own team's practices stay theirs.
const LEADS_OWN_STAGES = new Set(["reverse-engineering", "practices-discovery"]);
function homeInputPaths(stages: string[], state: string): string[] {
  const graph = loadStageGraphAll();
  const paths = new Set<string>(["inception/units-generation/unit-of-work-dependency.md"]);
  // A take marks the lead's completed stages completed in its own state too, so
  // the build reads the same list; a stage done with nothing written adds nothing.
  const ran = new Set(parseCheckboxes(state).filter((box) => box.state === "completed").map((box) => box.slug));
  const upstream = new Set<string>();
  const walk = [...stages];
  while (walk.length > 0) {
    const slug = walk.pop()!;
    for (const required of graph.find((entry) => entry.slug === slug)?.requires_stage ?? []) {
      if (!upstream.has(required)) {
        upstream.add(required);
        walk.push(required);
      }
    }
  }
  for (const stage of graph) {
    if ((stage.phase !== "ideation" && stage.phase !== "inception") || LEADS_OWN_STAGES.has(stage.slug) ||
      !ran.has(stage.slug) || !upstream.has(stage.slug)) continue;
    for (const name of [...(stage.produces ?? []), ...(stage.optional_produces ?? [])]) {
      paths.add(`${stage.phase}/${stage.slug}/${artifactFilename(name)}`);
    }
  }
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
  return auditRowsAt(projectDir, home.recordPrefix, oid);
}

// A record's audit as a commit holds it.
export function auditRowsAt(projectDir: string, recordPrefix: string, oid: string): AuditShardEvent[] {
  const listed = git(projectDir, ["ls-tree", "--name-only", `${oid}:${recordPrefix}/audit`]);
  if (!listed.ok) return [];
  return listed.stdout.split(/\r?\n/).filter((name) => name.endsWith(".md")).flatMap((shard, index) => {
    const text = git(projectDir, ["show", `${oid}:${recordPrefix}/audit/${shard}`, "--"]);
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
  return [...approvals].sort(([a], [b]) => a.localeCompare(b)).map(([stage, when]) => `${stage} approved by the lead ${when}`.trim());
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

// The space a take was asked to build in, by its name as space create keeps
// it; made by space create itself when it is not here yet, so its name rule
// and refusals are the same, said in its own words.
function spaceAskedFor(projectDir: string, asked: string): string {
  const name = slugify(asked);
  if (name !== "" && existsSync(join(spacesRoot(projectDir), name))) return name;
  const made = runEngineUtility(projectDir, isCompiledExecutable() ? ["space", "create", asked] : ["space-create", asked]);
  if (!made.ok) {
    let words = (made.stderr || made.stdout).trim();
    try {
      words = String((JSON.parse(words) as { error?: unknown }).error ?? words);
    } catch {
      // Not the error line: said as it is.
    }
    fail(words);
  }
  return name;
}

// The Unit's build: a piece of work of its own in the team's space, running the
// home's planned per-Unit stages from a copy of what the Unit was approved with.
// What a build needs to know of its home.
type HomeRef = Pick<HomeWork, "location" | "uuid" | "space" | "dirName" | "label" | "repos">;

// Where a build's copy comes from: the home's commit.
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
  // The space the build goes in, which the claim's owner names.
  space: string,
  attempt: number,
  source: BuildSource,
  // The lead's files the person chose to follow too (leadRules, read where they are).
  leadPaths: readonly string[] = [],
  // The person's own words of the take, when the agent handed them.
  takeRequest = "",
): { space: string; dirName: string } {
  const scope = getField(plan.state, "Scope") ?? "";
  const grid = loadScopeMapping()[scope];
  if (!grid) fail(`The lead's plan names a scope this install does not have: ${scope}.`);
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
    "--arguments", `Build ${unit} for ${home.label}, from what the lead approved`,
    // One token, so words that start with "--" are never read as a flag.
    `--take-request=${takeRequest || `Taken from the lead's plan: ${unit}`}`,
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
  for (const rel of homeInputPaths(stages, plan.state)) {
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
    if (leadPaths.length > 0) content = setOrInsertField(content, "## Runtime State", LEAD_RULES_FIELD, leadPaths.join(", "));
    // The plan as the home approved it, never its scope's defaults: each
    // ceremony (Plan Approval, sensors, learnings ...), the depth, the test
    // strategy and the review class the home's plan set.
    for (const name of Object.values(CEREMONY_FIELDS)) {
      const setting = parseCeremonyStateLine(getField(plan.state, name));
      if (setting !== null) content = setOrInsertField(content, "## Runtime State", name, formatCeremony(setting.value, "the lead's plan"));
    }
    for (const name of ["Depth", "Test Strategy", "Review Override", AUTONOMY_MODE_FIELD]) {
      const value = getField(plan.state, name)?.trim();
      // The lead's "continue automatically" was their answer for their own
      // work: the team approves its Unit itself, and its record says so.
      if (value) content = setOrInsertField(content, "## Runtime State", name, name === AUTONOMY_MODE_FIELD && value === "autonomous" ? "gated" : value);
    }
    // The Guard Policy the lead set; a lock in the team's own memory still wins where it is read.
    const policyField = guardPolicyStateField(plan.state);
    const policy = policyField === null ? null : parseGuardPolicyStateLine(getField(plan.state, policyField));
    if (policy !== null) content = setGuardPolicyLine(content, formatGuardPolicy(policy.value, "the lead's plan"));
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
      Team: space,
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
// `listed` holds the source walk's names for this repo's files (the listing
// the Code Generation review binds, keyed under `listedAs`), null when the
// walk could not be read. `share` is the plan's share (commitPlanHere): its
// own message, and its own words when git refuses the add or the commit.
function commitUnitPaths(
  dir: string,
  paths: string[],
  own: Record<string, string>,
  unit: string,
  label: string,
  name: string,
  listed: { listing: ReadonlyMap<string, string>; listedAs: string } | null,
  share?: { message: string; refused: (said: string, adding: boolean) => never },
): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-unit-commit-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  const leftOut: string[] = [];
  try {
    const head = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
    git(dir, head ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], env);
    // A file the Unit deleted whose deletion the branch already has (a redo
    // that merged the newer main, say) leaves nothing to add.
    const plain = paths.filter((path) => own[path] === undefined &&
      (existsSync(join(dir, path)) || git(dir, ["ls-files", "--error-unmatch", "--", path], env).ok));
    if (plain.length > 0) {
      const added = git(dir, ["add", "--", ...plain], env);
      if (!added.ok) {
        if (share) share.refused(added.stderr.trim(), true);
        fail(`${unit}'s changes could not be added in ${name}: ${added.stderr.trim()}`);
      }
    }
    // A folder the manifest names brings what git adds from it. A new file
    // there that the source walk leaves out (a test run's __pycache__, a
    // coverage file, a build's output, what the repo's .aidlc-source-paths.json
    // excludes) is none the build wrote and the review never saw, so it stays
    // out, theirs on disk as it was. A file the repo tracks keeps git's change.
    const folders = plain.filter((path) => path.endsWith("/"));
    if (listed !== null && folders.length > 0) {
      const raw = git(dir, ["diff", "--cached", "--raw", "-z", "--no-renames", "--diff-filter=A", "--", ...folders], env).stdout.split("\0");
      const notSource: string[] = [];
      for (let at = 0; at + 1 < raw.length; at += 2) {
        if (/^:\d{6} 10(?:0644|0755) /.test(raw[at]) && !listed.listing.has(`${listed.listedAs}${raw[at + 1]}`)) notSource.push(raw[at + 1]);
      }
      if (notSource.length > 0) git(dir, ["update-index", "-z", "--force-remove", "--stdin"], env, `${notSource.join("\0")}\0`);
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
      const made = git(dir, ["commit", "-q", "-m", share?.message ?? `${unit}: ${label}`], env);
      if (!made.ok) {
        if (share) share.refused((made.stderr || made.stdout).trim(), false);
        fail(`The commit in ${name} did not go through: ${(made.stderr || made.stdout).trim()}`);
      }
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
export function unitBranchInTheWay(projectDir: string, branch: string, byRepo: Map<string, string[]>): string[] {
  return [...byRepo].filter(([repo, paths]) => {
    const dir = repo === "." ? projectDir : repoDir(projectDir, repo);
    return isGitRepoDir(dir) && git(dir, ["branch", "--show-current"]).stdout.trim() !== branch &&
      git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok && !switchOntoUnitBranch(dir, branch, paths, true).ok;
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
    `${unit} of ${home.label}, from the lead's project at ${home.location} (space ${home.space}), copied from its commit ` +
      `${baseOid.slice(0, 12)}. These files are the lead's: approved there, read here. Change one and AI-DLC ` +
      "offers your change to the lead.",
    "",
    "| File | Fingerprint |",
    "| --- | --- |",
    ...inputs.map((input) => `| ${input.path} | ${input.fingerprint} |`),
    "",
    "## Approved by the lead",
    "",
    ...(approvals.length > 0 ? approvals.map((line) => `- ${line}`) : ["- none recorded"]),
    "",
  ].join("\n");
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

// Take a Unit of the home's work: claim it at the home, then start its build
// in the space the person is working in (solo work's in its own space). The
// first take wins; a Unit that waits on another is not taken yet.
function takeUnit(args: string[], projectDir?: string): void {
  const { positional, flags, bareFlags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail(`usage: ${unitUsage("take")}`);
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  if (!flags.home) fail("take needs --home <record>: the lead's work this Unit belongs to.");
  const pd = resolveProjectDir(projectDir);
  // The person's words of the take, read before anything is written: a request
  // that cannot be read stops the take here, never after its claim is pushed.
  const takeWords = personWordsOf(pd, flags);
  const homeSpace = flags["home-space"] ?? DEFAULT_SPACE;
  // --from: the lead's project by the address the person said, read there when
  // the lead's record is not in this workspace (in a clone of the lead's
  // workspace it is, and the take goes the local way). A build of it here is
  // carried on with nothing of the lead's project read.
  const fromAddress = flags.from !== undefined && !leadRecordHere(pd, `${homeSpace}/${flags.home}`);
  const builtHere = fromAddress ? findUnitBuildOfRecord(pd, `${homeSpace}/${flags.home}`, unit) : null;
  const byAddress = fromAddress && builtHere === null ? homeByAddress(pd, flags.from!, flags.home, homeSpace) : null;
  const home = builtHere === null ? byAddress?.home ?? findHomeWork(pd, flags.home, homeSpace) : null;
  if (home !== null) validateClaimRefUnit(home.id8, unit);
  // Taken here before (this clone or another of this workspace): carry it on.
  const existing = builtHere ?? (home === null ? null : findUnitBuild(pd, home.uuid, unit));
  if (existing !== null) {
    setActiveSpaceCursor(pd, existing.space);
    selectIntentForSession(pd, existing.dirName, existing.space, resolveWorkflowSelection(pd).sessionId ?? undefined);
    // Whose build it is, said once, from its claim as this workspace last
    // fetched it, while it is taken: a claim given back or freed names nobody.
    const claim = buildClaimHere(pd, existing);
    const whose = claim?.status !== "claimed" ? "its" : claimIsMine(pd, claim) ? "your" : `${builderOf(claim)}'s`;
    const carrying = `Carrying on ${unit}, ${whose} build${existing.space === DEFAULT_SPACE ? " here" : spaceWords(existing.space)}.`;
    console.log(JSON.stringify({
      taken: true,
      resumed: true,
      unit,
      space: existing.space,
      record: existing.dirName,
      ...(saidWithNextStep(pd, carrying) ? {} : { notice: carrying }),
    }));
    return;
  }
  if (home === null) fail(`${unit}'s build is not here.`);
  const ref = claimRef(home.id8, unit);
  if (home.target !== null) ensureFetchedClaim(pd, home, ref);
  let atLead: UnitClaimView | null;
  // A remote that fetches from the lead's project and pushes to the team's own
  // (a push URL): when the lead's project does not answer, the push address
  // stands in, as a remote holding the lead's claims does (homeTarget), and
  // both not answering is said as for that remote.
  let standsIn = false;
  try {
    atLead = currentClaim(pd, home.target, ref);
  } catch (error) {
    const read = errorMessage(error);
    const outbox = read.startsWith("Unit claim registry read failed:") ? claimOutbox(pd, home) : null;
    const answered = outbox === null ? null : quietly(() => git(pd, ["ls-remote", outbox, ref]));
    if (outbox === null || answered === null) throw error;
    if (!answered.ok) fail(neitherAnswered(maskUserinfo(outbox), read.slice("Unit claim registry read failed:".length).trim()));
    atLead = null;
    standsIn = true;
  }
  // While the lead's project has no claim of it, or a released one, the team's
  // own remote may hold a take or give back the lead has not taken in: a take
  // is said as taken, and a new take goes on top of a give back there.
  const there = atLead === null || atLead.status === "released" ? outboxClaim(pd, home, ref) : null;
  const current = there !== null && (atLead === null || claimAhead(pd, atLead.oid, there.claim.oid) === "ahead") ? there.claim : atLead;
  const integration = fetchHomeIntegration(pd, home, atLead, byAddress?.fetched, standsIn);
  const plan = homePlanAt(pd, home, integration.oid, integration.branch);
  const planChanging = unitPlanChangingStage(plan.state);
  const solo = home.solo ? soloOpening(pd, home, plan) : null;
  const opening = solo ?? openingStatusFrom(plan.state, plan.dependencies);
  if (!opening.units.includes(unit)) fail(`${unit} is not one of ${home.label}'s Units (${opening.units.join(", ")}).`);
  if (solo?.started.has(unit)) fail(`${unit} is being built on the other machine; take another Unit, or follow along.`);
  const me = git(pd, ["config", "user.name"]).stdout.trim() || "a teammate";
  if (current?.status === "claimed") fail(buildOnBranchLine(pd, home.uuid, current) ?? takenLine(unit, current));
  if (opening.completed.has(unit)) fail(`${unit} is already done at the lead's project.`);
  const homeRows = homeAuditAt(pd, home, integration.oid);
  if (!home.solo && leadBuildsWithoutClaim(homeRows, unit, current)) {
    fail(`${unit} is being built at the lead's project, so it is not open to take. Run \`${aidlcToolInvocation("orchestrate")} next\` for what is.`);
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
      `${unit} waits on ${blockers.join(", ")}, which ${blockers.length === 1 ? "is" : "are"} not done at the lead's project yet. ` +
        `It opens once ${blockers.length === 1 ? "it is" : "they are"} done` +
        (pushedDeps ? `, or starts early on ${blockers.length === 1 ? "its" : "their"} pushed branches if you ask.` : "."),
    );
  }
  // The Unit's own repos, as its Unit plan lists them (its likely repos; one
  // that lists none works in all of the work's): an early start branches only
  // these, never a repo a dependency pushed that this Unit does not use.
  const likely = (home.leadCopy ? unitLikelyReposFrom(plan.dependencies) : unitLikelyRepos(pd, home.dirName, home.space)).get(unit) ?? [];
  const ownRepos = new Set(likely.map((repo) => repo.split("/")[0]));
  const earlyOn = early
    ? blockers.map((dep) => ({
      unit: dep,
      repos: (depClaims.get(dep)?.payload.result?.repos ?? []).filter((repo) => ownRepos.size === 0 || ownRepos.has(repo.repo))
        .map((repo) => ({
          repo: repo.repo,
          branch: repo.branch,
          head: repo.heads.at(-1) ?? "",
        })),
    }))
    : undefined;
  // The build goes in the space the person asked for (--space), else the one
  // they are working in; solo work's in the lead's own space. The claim's
  // owner names that space.
  const team = flags.space?.trim() ? spaceAskedFor(pd, flags.space) : home.solo ? home.space : activeSpace(pd);
  const generation = takeGeneration(current);
  const payload = takenClaimPayload(current, {
    team, home, unit, ref, generation, me, baseOid: integration.oid, integrationRef: integration.ref,
    gateRhythm: readUnitGateRhythm(plan.state), earlyOn,
  });
  const commit = createClaimCommit(pd, current?.oid ?? integration.oid, payload);
  const pushed = writeHomeClaim(pd, home, ref, commit, atLead?.oid ?? null);
  // The lead's project took no push from here: the take goes on as the person
  // asked, and its claim is recorded there when a push next goes through
  // (recordTakeHere). An early start's claim alone holds where it started, so
  // that one waits for the lead's project to take pushes. A take that went to
  // the team's own remote instead is said with where it is.
  let notRecorded: string | null = null;
  const onRemote = pushed.elsewhere ?? null;
  if (!pushed.ok && onRemote === null) {
    const winner = currentClaim(pd, home.target, ref);
    if (winner?.status === "claimed") fail(takenLine(unit, winner));
    // Git gave no reason when the claim moved under the take.
    if (pushed.refused === undefined) fail(`${unit} was not taken: its claim at the lead's project moved meanwhile. Try again.`);
    const why = pushed.refused.replace(/\.+$/, "");
    if (earlyOn) {
      fail(`${unit} is open at the lead's project, which takes no push from here: ${why}. Ask the lead for push access to it, then take ${unit} again.`);
    }
    notRecorded = why;
  }
  if (notRecorded === null && onRemote === null) invalidateLiveClaimPayloadCache(pd, unit);
  // A build in the lead's own space reads the lead's rules as its own already.
  const withLeadRules = (bareFlags.has("lead-rules") || flags["lead-rules"] !== undefined) && (home.leadCopy || team !== home.space);
  // The lead's rules the build reads too, in the take's own words, as its choice named them.
  // In a team's own workspace the lead's files are read from the lead's commit, never this workspace's own.
  const leads = !withLeadRules ? null
    : home.leadCopy ? leadRulesOf(pd, home.space, (rel) => textAt(pd, integration.oid, rel)) : leadRulesOf(pd, home.space);
  const leadsToo = leads === null || leads.paths.length === 0 ? ""
    : ` and the lead's ${leads.practices.length > 0 && leads.project.length > 0 ? "practices and project rules"
      : leads.practices.length > 0 ? "practices" : "project rules"}`;
  const build = createUnitBuild(pd, home, plan, integration.oid, unit, team, generation, {
    read: (rel) => {
      const shown = git(pd, ["show", `${integration.oid}:${home.recordPrefix}/${rel}`, "--"]);
      return shown.ok ? shown.stdout : null;
    },
    approvals: (produced) => homeApprovals(homeRows, produced),
  }, leads?.paths ?? [], takeWords);
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
      // Without tracking: the dependency's branch is another team's, so a plain
      // git push before AI-DLC's own (which sets the Unit's upstream) never goes there.
      if (clean && git(dir, ["switch", "-q", "--no-track", "-c", unit, start]).ok) earlyLines.push(`You are on branch ${unit} in ${name} now.`);
      else if (git(dir, ["branch", "--no-track", unit, start]).ok) {
        earlyLines.push(`Branch ${unit} in ${name} starts there; your uncommitted changes kept you on your branch, so switch when you are ready.`);
      }
    }
  }
  if (earlyOn) {
    const names = [...new Set(earlyOn.flatMap((dep) => dep.repos.map((repo) => (repo.repo === "." ? "the repo" : repo.repo))))];
    const deps = joinNames(earlyOn.map((dep) => dep.unit));
    earlyLines.unshift(names.length > 0
      ? `It starts early on the pushed branch of ${deps} in ${joinNames(names)}. It may still change before it merges.`
      : `It starts early, before ${deps} ${earlyOn.length === 1 ? "is" : "are"} done; ${deps} changed none of ${unit}'s repos, ` +
        "so nothing here was switched.");
  }
  // The likely repos this workspace has no checkout of, said with the way to one.
  const notThere = likelyReposNotHere(pd, likely, home.repos, leadRepoAddresses(pd, integration.oid));
  const taken = `${unit} is yours. Its build is its own ` +
    `piece of work here,${spaceWords(build.space) === "" ? "" : `${spaceWords(build.space)},`} under your team's rules${leadsToo}, from what the lead approved.` +
    // The way back (release, run in this build), said once with the take.
    " If it is not your team's to build, say so and I give it back." +
    earlyLines.map((line) => ` ${line}`).join("") +
    notThere.lines +
    (planChanging !== null
      ? ` The lead is changing the Unit plan (${planChanging} is open again there), so ${unit} is taken on the plan as it stands there.`
      : "") +
    (home.atOrigin === undefined ? "" : ` The lead's project could not be reached at ${home.location} (${home.atOrigin.why}), so ` +
      `${unit} is recorded at ${home.atOrigin.origin}, where this clone's copy of the lead's plan comes from.`);
  const noPush = onRemote !== null
    ? `${standsIn ? "The lead's project did not answer just now" : "The lead's project takes no push from you"}, so your take of ${unit} is on ${onRemote}; the lead and the other teams ` +
      "see it once the lead adds that address to their workspace as a git remote."
    : notRecorded === null ? null : `The lead's project takes no push from here (${notRecorded}), so the lead and the other teams ` +
      `cannot see that you took ${unit} until it does; AI-DLC records it there when a push next goes through.`;
  // The take's own line waits for the build's next step, which also puts the
  // offer to clone its repos not checked out here (buildCloneOffer). The
  // no-push risk is a line of its own kept for the reply the turn ends on, so
  // the agent's own words for the take never leave it out.
  const said = saidWithNextStep(pd, taken);
  const riskKept = noPush !== null && said && saidWithNextStep(pd, noPush, { forReply: true });
  const notice = said ? (noPush !== null && !riskKept ? noPush : null) : [taken, noPush].filter((line) => line !== null).join(" ");
  console.log(JSON.stringify({
    taken: true,
    unit,
    team,
    space: build.space,
    record: build.dirName,
    ...(notice === null ? {} : { notice }),
  }));
}

// The generation a take writes: a released claim's own, else the next.
function takeGeneration(current: UnitClaimView | null): number {
  return current?.status === "claimed" || current?.status === "released" ? current.generation : (current?.generation ?? 0) + 1;
}

// The claim a take writes: the space the build goes in as its owner, taken by
// this person, at this generation.
function takenClaimPayload(
  current: UnitClaimView | null,
  take: {
    team: string; home: Pick<HomeWork, "space" | "uuid" | "id8">; unit: string; ref: string; generation: number; me: string;
    baseOid: string; integrationRef: string; gateRhythm: ReturnType<typeof readUnitGateRhythm>; earlyOn?: UnitClaimPayload["early_on"];
  },
): UnitClaimPayload {
  return {
    version: 1,
    status: "claimed",
    owner: take.team,
    space: take.home.space,
    intent_uuid: take.home.uuid,
    intent_id8: take.home.id8,
    unit: take.unit,
    nonce: randomUUID(),
    claim_ref: take.ref,
    gate_rhythm: take.gateRhythm,
    generation: take.generation,
    base_oid: take.baseOid,
    integration_ref: take.integrationRef,
    predecessor_oid: current?.oid ?? null,
    taken_by: take.me,
    ...(take.earlyOn ? { early_on: take.earlyOn } : {}),
  } as UnitClaimPayload;
}

// Whether a build's take is on its claim at the lead's project, as git last
// fetched the claim. Only the checkout that made the take can tell (its
// UNIT_TAKEN_IN row is in this checkout's own audit shard); a build taken in
// another reads as recorded, as every take did before. "pending": never
// recorded and still the person's to record; "aside": someone else's take, or
// the Unit done, is there now, and this build's take is never written over it.
// Whether a claim's take is this person's: its taken_by is their git
// user.name, or the commit that made the take is theirs by user.email (one
// person on two computers with two names). An unset name never matches.
export function claimIsMine(projectDir: string, claim: UnitClaimView): boolean {
  return claim.status === "claimed" &&
    takeIsBy(projectDir, claim.oid, claim.payload, gitUserName(projectDir), git(projectDir, ["config", "user.email"]).stdout.trim());
}

// The take on a claim commit is by this name, or by the email of the commit
// that made it (the oldest of the claim's own history with this taker; a later
// commit of theirs on someone else's take is not it).
function takeIsBy(projectDir: string, oid: string, payload: UnitClaimPayload, me: string | null, myEmail: string): boolean {
  if (payload.taken_by === undefined) return false;
  if (me !== null && payload.taken_by === me) return true;
  if (myEmail === "") return false;
  let at = oid;
  let taking = payload;
  for (let steps = 0; taking.predecessor_oid !== null && steps < 200; steps++) {
    const before = readPayload(projectDir, taking.predecessor_oid, { localOnly: true });
    if (before === null || before.taken_by !== taking.taken_by) break;
    at = taking.predecessor_oid;
    taking = before;
  }
  // The author's: a take the lead's project took in is the lead's commit, its author the taker.
  return localGit(projectDir, ["log", "-1", "--format=%ae", at]).stdout.trim() === myEmail;
}

// The lead's own build-here claims at the lead's work (Home Location, not a
// Unit's build): a Unit the lead asked to build at the lead's project (`assign
// --here`) whose claim is this person's take for the work's own space. The
// lead's walk builds it; it is no team's.
export function leadsOwnClaims(projectDir: string, stateContent: string, claims: ReadonlyMap<string, UnitClaimView>): Set<string> {
  if (homeLocation(stateContent) === null || unitBuildOf(stateContent) !== null) return new Set();
  let asked: Set<string>;
  try {
    asked = unitsAskedHere(readAuditShardEvents(projectDir));
  } catch {
    return new Set();
  }
  if (asked.size === 0) return new Set();
  const space = activeSpace(projectDir);
  return new Set([...claims].filter(([unit, claim]) =>
    asked.has(unit) && claim.status === "claimed" && claim.owner === space && claimIsMine(projectDir, claim)).map(([unit]) => unit));
}

// Whether the lead's work went to teams by a teammate's take of solo work: a
// claim on it, other than the lead's own build-here claims (`own`), was taken
// from the lead's commit while the work was still solo. The lead's walk then
// carries on with the rest, as its switch says.
const SOLO_AT_OID = new Map<string, boolean>();
export function takenFromSoloWork(projectDir: string, claims: ReadonlyMap<string, UnitClaimView>, own: ReadonlySet<string>): boolean {
  const relative = relativeRecordDir(projectDir);
  if (!relative) return false;
  return [...claims.values()].some((claim) => {
    if (own.has(claim.unit)) return false;
    const key = `${claim.payload.base_oid}:${relative}`;
    if (!SOLO_AT_OID.has(key)) {
      const shown = localGit(projectDir, ["show", `${claim.payload.base_oid}:${relative}/aidlc-state.md`, "--"]);
      SOLO_AT_OID.set(key, shown.ok && !isTeamUnitOwnership(shown.stdout));
    }
    return SOLO_AT_OID.get(key) === true;
  });
}

// A build's claim at the lead's project as this workspace last fetched it.
export function buildClaimHere(projectDir: string, built: { space: string; dirName: string }): UnitClaimView | null {
  try {
    const build = unitBuildOf(readStateFile(projectDir, built.dirName, built.space));
    if (build === null) return null;
    const homeSpace = build.homeRecord.includes("/") ? build.homeRecord.slice(0, build.homeRecord.indexOf("/")) : DEFAULT_SPACE;
    return cachedClaimsForIdentity(projectDir, { space: homeSpace, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false)
      .get(build.unit) ?? null;
  } catch {
    return null;
  }
}

type TakeStanding =
  | { state: "recorded" }
  | { state: "pending"; current: UnitClaimView | null; team: string; baseOid: string; dirName: string; space: string }
  | { state: "aside"; line: string };

// The copies of a build's claims that are the lead's project's own, as this
// clone reads them: the ones fetched by the lead's address, or through the
// remote that is the lead's. A copy the team's own remote holds (a take sent
// there, then fetched by the person's own git) is not the lead's. Read once
// per process; nothing to narrow when the lead's place cannot be told.
const leadsCopiesOf = new Map<string, ((ref: string) => boolean) | undefined>();
function leadsClaimCopies(projectDir: string, build: UnitBuild): ((ref: string) => boolean) | undefined {
  if (leadsCopiesOf.has(build.homeWork)) return leadsCopiesOf.get(build.homeWork);
  let only: ((ref: string) => boolean) | undefined;
  try {
    const target = buildsHome(projectDir, build).target;
    only = target === null ? undefined
      : isGitAddress(target) ? (ref) => ref.startsWith("refs/aidlc/home/")
      : (ref) => ref.startsWith(`refs/remotes/${target}/`) || ref.startsWith("refs/heads/claim/") || ref.startsWith("refs/aidlc/home/");
  } catch {
    only = undefined;
  }
  leadsCopiesOf.set(build.homeWork, only);
  return only;
}

function takeStanding(projectDir: string, build: UnitBuild): TakeStanding {
  const here = findUnitBuild(projectDir, build.homeWork, build.unit);
  if (here === null) return { state: "recorded" };
  const row = readAuditShardEvents(projectDir, here.dirName, here.space).findLast((entry) => entry.event === "UNIT_TAKEN_IN");
  const own = knownAuditShardName(projectDir);
  if (row === undefined || own === null || basename(row.shard) !== own) return { state: "recorded" };
  const homeSpace = build.homeRecord.slice(0, build.homeRecord.indexOf("/"));
  let current: UnitClaimView | null;
  try {
    current = cachedClaimsForIdentity(projectDir, { space: homeSpace, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false,
      leadsClaimCopies(projectDir, build)).get(build.unit) ?? null;
  } catch {
    return { state: "recorded" };
  }
  const me = gitUserName(projectDir);
  const myEmail = git(projectDir, ["config", "user.email"]).stdout.trim();
  // The build's attempt as its record has it now (a take recorded later at a
  // new attempt writes it there), never as the caller read it before.
  let attempt = build.attempt;
  try {
    attempt = unitBuildOf(readStateFile(projectDir, here.dirName, here.space))?.attempt ?? attempt;
  } catch {
    // The caller's stands.
  }
  // The claim's own history, back from what git fetched: this take there once
  // is recorded, whatever the lead did with the Unit since (takeIsBy).
  let oid = current?.oid ?? null;
  for (let steps = 0; oid !== null && steps < 200; steps++) {
    const payload = readPayload(projectDir, oid, { localOnly: true });
    if (payload === null) break;
    if (payload.generation === attempt && takeIsBy(projectDir, oid, payload, me, myEmail)) return { state: "recorded" };
    oid = payload.predecessor_oid;
  }
  const team = auditBlockField(row.block, "Team") ?? "";
  const unit = build.unit;
  if (current?.status === "claimed" && current.payload.taken_by !== undefined) {
    const by = current.payload.taken_by;
    const at = git(projectDir, ["log", "-1", "--format=%as", current.oid]).stdout.trim();
    return {
      state: "aside",
      line: `${unit} was taken at the lead's project by ${by}${at ? ` on ${at}` : ""}, before your take ` +
        `could be recorded there, so the lead and the other teams see theirs, not yours. Your build is still here: agree with ${by} ` +
        "who carries it on, or give yours back.",
    };
  }
  if (current?.payload.done === true) {
    return {
      state: "aside",
      line: `${unit}'s claim at the lead's project changed before your take could be recorded there: it is done there now, so the lead ` +
        "and the other teams do not see your take. Your build is still here: agree with the lead who carries it on, or give yours back.",
    };
  }
  return { state: "pending", current, team, baseOid: auditBlockField(row.block, "Home Commit") ?? "", dirName: here.dirName, space: here.space };
}

// A take this checkout made that the lead's project did not record then, put
// on its claim now with the same compare-and-swap, under quiet git. At a look
// nobody typed (`typed` false) it is not tried where commits are signed, which
// may ask for a passphrase. The claim's attempt is the build's from then on.
// Ok, or git's refusal (none for a race lost), and nothing is said either way.
function recordTakeHere(projectDir: string, build: UnitBuild, home: HomeWork, standing: Extract<TakeStanding, { state: "pending" }>, typed: boolean): { ok: boolean; refused?: string } {
  if (!typed && git(projectDir, ["config", "--type=bool", "commit.gpgsign"]).stdout.trim() === "true") return { ok: false };
  try {
    return quietly(() => {
      const ref = claimRef(home.id8, build.unit);
      const { current } = standing;
      const generation = takeGeneration(current);
      const record = `${home.recordPrefix}/aidlc-state.md`;
      const remote = home.target !== null && !isGitAddress(home.target) ? home.target : null;
      const integrationRef = home.target !== null && isGitAddress(home.target) ? leadCopyRef(home.id8)
        : remote !== null ? `refs/remotes/${remote}/${affirmedIntegrationBranch(projectDir, home.space)?.branch ?? integrationBranch(projectDir, remote)}`
        : `refs/heads/${affirmedIntegrationBranch(projectDir, home.space)?.branch ?? integrationBranch(projectDir, null)}`;
      const payload = takenClaimPayload(current, {
        team: standing.team, home, unit: build.unit, ref, generation,
        me: git(projectDir, ["config", "user.name"]).stdout.trim() || "a teammate",
        baseOid: standing.baseOid, integrationRef, gateRhythm: readUnitGateRhythm(textAt(projectDir, standing.baseOid, record) ?? ""),
      });
      const pushed = writeHomeClaim(projectDir, home, ref, createClaimCommit(projectDir, current?.oid ?? standing.baseOid, payload), current?.oid ?? null, { outbox: false });
      if (!pushed.ok) return pushed;
      invalidateLiveClaimPayloadCache(projectDir, build.unit);
      if (generation !== build.attempt) {
        withAuditLock(projectDir, () => {
          writeStateFile(projectDir, setOrInsertField(readStateFile(projectDir, standing.dirName, standing.space), "## Runtime State",
            "Home Attempt", String(generation)), standing.dirName, standing.space);
        });
      }
      return { ok: true };
    });
  } catch {
    return { ok: false };
  }
}

// What a build's claim says is not this build's to act on now: someone else's
// take or the Unit done, before this checkout's take was recorded. The step
// says it once (buildClaimNotes), and no look, push or give back acts on that
// claim as this build's.
export function takeAside(projectDir: string, stateContent: string): boolean {
  const build = unitBuildOf(stateContent);
  if (build === null) return false;
  try {
    return takeStanding(projectDir, build).state === "aside";
  } catch {
    return false;
  }
}

// A line of the take's for the person: it waits for the next step the agent
// speaks from in this chat (on the build it selected), as a jump's does, so it
// reaches them with that step's own lines. False when no chat can hold it, and
// the output carries it.
function saidWithNextStep(pd: string, line: string, options: { forReply?: boolean } = {}): boolean {
  try {
    const session = resolveWorkflowSelection(pd).sessionId;
    return session !== null && session !== undefined && addPendingPersonLines(pd, session, [line], options);
  } catch {
    return false;
  }
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
// message in the fetch's own second counts as after it). A look this .git
// could not take in is taken again once, at the chat's next look. `unreached`
// is the remote or address that could not be reached: the last fetch stands.
const CLAIMS_FETCHED_FILE = "claims-fetched.json";

// The lead's look: this work's claim branches on the lead's workspace's other
// git remotes (a team's fork or own repo the lead added), fetched quietly, and
// each claim commit there that is ahead of the lead's claim (a take, a result,
// a give back, a proposal) put on it with the compare-and-swap. The first
// taken in wins; a copy that is not ahead (a fork's stale copy) is left as it
// is. A remote that cannot be read is said while a Unit is open at the lead's
// project or when it held this work's claims before; an unrelated one goes
// quiet once every Unit is taken. Only the lead's own checkout runs it.
export function takeInFromRemotes(projectDir: string, options: { unitOpen: boolean }): { taken: number; lines: string[]; refused: boolean } {
  const pd = resolveProjectDir(projectDir);
  const home = repositoryRemote(pd);
  const none = { taken: 0, lines: [] as string[], refused: false };
  if (home === null) return none;
  const identity = activeIdentity(pd);
  const id8 = identity.intentId8;
  // Said once to the lead: a remote that cannot be read, a take-in refused.
  const lines: string[] = [];
  let taken = 0;
  // This .git refused the write (Codex's sandbox): its own line, not the remote's.
  let refused = false;
  for (const { remote, kept, heldBefore, fetched } of fetchTeamsClaims(pd, home, id8)) {
    if (!fetched.ok && localGitWriteRefused(fetched.stderr) !== null) {
      refused = true;
      continue;
    }
    if (!fetched.ok) {
      if (options.unitOpen || heldBefore) {
        const address = maskUserinfo(git(pd, ["remote", "get-url", remote]).stdout.trim());
        const why = fetched.stderr.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "it did not answer";
        lines.push(`${remote} (${address}) could not be read just now (${why}), so a take or result a team sent there is not taken in yet.`);
      }
      continue;
    }
    for (const line of localGit(pd, ["for-each-ref", "--format=%(objectname) %(refname)", kept]).stdout.split(/\r?\n/).filter(Boolean)) {
      const [oid, name] = line.trim().split(/\s+/, 2);
      const unit = (name ?? "").slice(kept.length);
      if (!oid || !unit || validateUnitName(unit)) continue;
      const ref = claimRef(id8, unit);
      const payload = readPayload(pd, oid, { localOnly: true });
      if (payload === null || payload.intent_uuid !== identity.intentUuid || payload.unit !== unit || payload.claim_ref !== ref) continue;
      const leadTip = localGit(pd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${home}/claim/${id8}/${unit}`]).stdout.trim() || null;
      if (leadTip !== null && claimAhead(pd, leadTip, oid) !== "ahead") continue;
      // The lead's own commit with the team commit's tree, its author the
      // team's, on the lead's claim tip: a host that takes only its pusher's
      // commits takes it, and the team's own commit never goes there.
      const notTakenIn = (why: string): string =>
        `${unit}'s take or result on ${remote} could not be taken in here (${why.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? why}), ` +
        "so the other teams do not see it yet.";
      // Under quiet git's time limit: signing that would ask for a passphrase fails, said with git's words.
      let mine: string;
      try {
        mine = quietly(() => leadsOwnClaimCommit(pd, oid, leadTip ?? payload.base_oid));
      } catch (e) {
        lines.push(notTakenIn(errorMessage(e).replace(/^git commit-tree failed:\s*/, "")));
        continue;
      }
      const put = quietly(() => updateClaimRef(pd, home, ref, mine, leadTip));
      if (put.ok) {
        taken++;
        invalidateLiveClaimPayloadCache(pd, unit);
      } else if (put.refused !== undefined) lines.push(notTakenIn(put.refused));
    }
  }
  return { taken, lines, refused };
}

// The lead's other git remotes (a team's fork or own repo the lead added), and
// this work's claim branches on each fetched quietly into the refs the
// person's own fetch of that remote uses. Only the lead's own checkout runs it.
function fetchTeamsClaims(pd: string, home: string, id8: string): Array<{ remote: string; kept: string; heldBefore: boolean; fetched: ReturnType<typeof quietFetch> }> {
  const others = git(pd, ["remote"]).stdout.split(/\r?\n/).map((name) => name.trim()).filter((name) => name !== "" && name !== home);
  return others.map((remote) => {
    const kept = `refs/remotes/${remote}/claim/${id8}/`;
    const heldBefore = localGit(pd, ["for-each-ref", "--count=1", "--format=%(refname)", kept]).stdout.trim() !== "";
    return { remote, kept, heldBefore, fetched: quietFetch(pd, ["--no-tags", "--no-filter", "-q", remote, `+refs/heads/claim/${id8}/*:${kept}*`]) };
  });
}

// status and team-board at the lead's project: what the lead's other remotes
// hold is read, never taken in, so the board shows a take a team sent there in
// its own words; the lead's next look records it.
export function readTeamsClaims(projectDir: string): void {
  try {
    const pd = resolveProjectDir(projectDir);
    const home = repositoryRemote(pd);
    if (home !== null) fetchTeamsClaims(pd, home, activeIdentity(pd).intentId8);
  } catch {
    // What the lead's project has stands.
  }
}

// A lead's command on a team's claim (merged, send-back, turned-down,
// sign-off, release) takes in first what the lead's other remotes hold, as the
// lead's look does, so it acts on a take or result a team sent there. The
// lines the take-in has for the person and not said in this chat yet come
// back for withTakeInLines.
function takeInFirst(pd: string): string[] {
  try {
    if (unitBuildOf(readStateFile(pd)) !== null) return [];
  } catch {
    return [];
  }
  if (!refreshHomeClaims(pd, { now: true }).fetched) return [];
  const back = takeInFromRemotes(pd, { unitOpen: true });
  const lines = [...back.lines, ...(back.refused ? [newsNotTakenIn("the teams")] : [])];
  const chat = takeInChat(pd);
  return chat === null ? lines : lines.filter((line) => !personLineHeard(pd, chat, line));
}

function takeInChat(pd: string): string | null {
  try {
    return resolveInvokingSessionId(pd) ?? null;
  } catch {
    return null;
  }
}

// The command's own words (its notice or its refusal) after the take-in's
// lines, which are then heard in this chat, so the look does not say them again.
function withTakeInLines(pd: string, heard: readonly string[], words: string): string {
  if (heard.length === 0) return words;
  const chat = takeInChat(pd);
  if (chat !== null) markPersonLinesHeard(pd, chat, heard);
  return [...heard, words].join(" ");
}

// A team's claim commit written again as this person's own: its tree, its
// message, its author (name, email, date), on `parent`.
function leadsOwnClaimCommit(projectDir: string, oid: string, parent: string): string {
  const [name, email, date] = localGit(projectDir, ["log", "-1", "--format=%an%x00%ae%x00%aI", oid]).stdout.trim().split("\0");
  const tree = localGit(projectDir, ["rev-parse", `${oid}^{tree}`]).stdout.trim();
  const message = localGit(projectDir, ["log", "-1", "--format=%B", oid]).stdout.trim() || "claim";
  return commitAsPerson(projectDir, tree, [parent], message, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date });
}

export function refreshHomeClaims(
  projectDir: string,
  options: { home?: { target: string | null; id8: string; leadCopy?: boolean }; sessionId?: string; now?: boolean; sincePerson?: boolean } = {},
): { fetched: boolean; unreached: string | null; refused?: string } {
  const pd = resolveProjectDir(projectDir);
  const { target, id8 } = options.home ?? { target: repositoryRemote(pd), id8: activeIdentity(pd).intentId8 };
  if (target === null) return { fetched: false, unreached: null };
  const mark = join(sessionsDir(pd), CLAIMS_FETCHED_FILE);
  let chats: Record<string, string | { chat: string; at: string; reached: boolean; refused?: boolean; again?: boolean }> = {};
  try {
    chats = JSON.parse(readFileSync(mark, "utf-8")) as typeof chats;
  } catch {
    // No fetch noted yet.
  }
  const chat = options.sessionId ?? "no chat";
  const noted = chats[id8];
  const last = typeof noted === "string" ? { chat: noted, at: "", reached: false } : noted;
  // Their message since that fetch, read by time only: a turn on the record,
  // or any message of this chat's (any chat's when none is named) the
  // human-turn hook kept, beside finished work too, where it writes no turn.
  const spoke = options.sincePerson === true && last?.chat === chat && last.reached &&
    (readAuditShardEvents(pd).some((row) => isRequestTurn(row) && row.timestamp >= last.at) ||
      ((): boolean => {
        const { listMessages } = require("./aidlc-message-store.ts") as typeof import("./aidlc-message-store.ts");
        return listMessages(pd).some((message) =>
          (options.sessionId === undefined || message.session === options.sessionId) && message.at >= last.at);
      })());
  // The look .git refused stopped the step with its way on: the same command
  // run again with write access, which looks again whether or not they spoke.
  const again = last?.chat === chat && last.refused === true && last.again !== true;
  if (!options.now && !spoke && !again && last?.chat === chat) return { fetched: false, unreached: null };
  const into = isGitAddress(target) ? `refs/aidlc/home/${id8}/claim/${id8}` : `refs/remotes/${target}/claim/${id8}`;
  const at = isoTimestamp();
  const before = claimTipsAt(pd, into);
  const fetched = quietFetch(pd, ["--no-tags", "--no-filter", "-q", target, `+refs/heads/claim/${id8}/*:${into}/*`]);
  if (fetched.ok) sayOwnBuildsMerged(pd, into, before);
  // The lead's project answered, and this repository's own .git refused the
  // write (Codex's sandbox keeps it read-only): not a project that is down.
  // The first time in a chat the step stops with its way on, which an agent in
  // that sandbox takes with the write access the session grants (AI-DLC's
  // shipped rules allow its engine commands), so the news is read rather than
  // missed; after that the step goes on and says it plainly, never a loop.
  const refused = fetched.ok ? null : localGitWriteRefused(fetched.stderr);
  const ok = fetched.ok;
  // A lead read by its address: the copy of the lead's workspace (the plan and
  // the lead's rules a build follows) comes with the claims, when the lead's
  // HEAD moved; a lead whose HEAD names no branch leaves the copy as it was.
  if (ok && options.home?.leadCopy === true && isGitAddress(target)) {
    quietFetch(pd, ["--no-tags", "-q", target, `+HEAD:${leadCopyRef(id8)}`]);
  }
  const stopped = refused !== null && last?.chat === chat && last.refused === true;
  try {
    mkdirSync(dirname(mark), { recursive: true });
    writeFileAtomic(mark, `${JSON.stringify({
      ...chats, [id8]: { chat, at, reached: ok, ...(refused !== null ? { refused: true, ...(stopped ? { again: true } : {}) } : {}) },
    })}\n`);
  } catch {
    // Unnoted, the next step fetches again.
  }
  if (refused !== null && !stopped) throw new GitWriteRefused(refused);
  if (refused !== null) return { fetched: false, unreached: null, refused };
  return { fetched: ok, unreached: ok ? null : target };
}

// A plan's claim tips under `into`, the refs a fetch of its claims writes, by Unit.
function claimTipsAt(pd: string, into: string): Map<string, string> {
  const tips = new Map<string, string>();
  for (const line of localGit(pd, ["for-each-ref", "--format=%(objectname) %(refname)", `${into}/`]).stdout.split(/\r?\n/).filter(Boolean)) {
    const [oid, ref] = line.trim().split(/\s+/, 2);
    if (oid && ref) tips.set(ref.slice(into.length + 1), oid);
  }
  return tips;
}

// A build of the person's own here whose claim this fetch brought to done:
// said once, with the step that follows. A fetch that moved nothing (their own
// pull got there first) says nothing; status's Yours line still shows it.
function sayOwnBuildsMerged(pd: string, into: string, before: ReadonlyMap<string, string>): void {
  for (const [unit, oid] of claimTipsAt(pd, into)) {
    const was = before.get(unit);
    if (was === oid) continue;
    const now = readPayload(pd, oid, { localOnly: true });
    if (now?.done !== true || (was !== undefined && readPayload(pd, was, { localOnly: true })?.done === true)) continue;
    if (findUnitBuild(pd, now.intent_uuid, unit) === null) continue;
    if (!takeIsBy(pd, oid, now, gitUserName(pd), git(pd, ["config", "user.email"]).stdout.trim())) continue;
    saidWithNextStep(pd, `Your ${unit} is merged.`);
  }
}

// Status at a team's build: its claims as the lead's project has them now,
// fetched quietly as a look does, so the build's standing is read there; it
// writes no claim. What this workspace has stands when it cannot.
export function readBuildClaims(projectDir: string, stateContent: string): void {
  try {
    const build = unitBuildOf(stateContent);
    if (build !== null) refreshHomeClaims(projectDir, { home: buildsHome(projectDir, build), now: true });
  } catch {
    // The last fetch stands.
  }
}

// The step's stop when the news could not be written into this workspace's
// .git: every caller that takes a failed look as "the claims stand" lets this
// one through, so the way on reaches the agent once in the chat.
export class GitWriteRefused extends Error {
  constructor(gitLine: string) {
    super(`The news from the lead's project reached this workspace, but its .git cannot be written in this session ` +
      `(git: ${gitLine}), so it was not taken in. Run the same command again with write access to it (on Codex, ` +
      "with escalated permissions, or with the repository's .git in writable_roots as the shipped config.toml shows); " +
      "nothing else changes.");
  }
}

// What a step says once the news could not be written into this workspace's
// .git and its way on was already given in this chat: from the lead's project
// in a team's build, from the teams at the lead's project.
export function newsNotTakenIn(from: string): string {
  return `News from ${from} could not be taken in here: this workspace's .git cannot be written in this session, ` +
    "so what you see may be behind.";
}

// git's own line when it could not write into this repository's .git (a
// read-only file system or folder), as opposed to a remote it could not read.
function localGitWriteRefused(stderr: string): string | null {
  const line = stderr.split(/\r?\n/).find((entry) =>
    /read-only file system|permission denied|operation not permitted/i.test(entry) &&
    /cannot open|cannot lock ref|unable to create|unable to write|could not write|failed to write|cannot update/i.test(entry));
  return line === undefined ? null : line.trim();
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
  } catch (e) {
    if (e instanceof GitWriteRefused) throw e;
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

// The paths a repo's own ignore rules leave out and git does not track: git
// would refuse to add them, as the person's own `git add` would.
function untrackedIgnored(dir: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const checked = spawnSync("git", ["check-ignore", "--stdin", "-z"], { cwd: dir, input: paths.join("\0"), encoding: "utf-8" });
  return checked.status === 0 ? checked.stdout.split("\0").filter(Boolean) : [];
}

// Whether a repo of the push holds changes of the person's beyond the Unit's.
function ownChanges(planned: ReadonlyArray<{ dir: string }>): boolean {
  return planned.some(({ dir }) => git(dir, ["status", "--porcelain"]).stdout.trim() !== "");
}

function buildsHome(projectDir: string, build: UnitBuild): HomeWork {
  const lead = leadOfBuild(projectDir, build);
  if (lead !== null) return lead;
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

// The Unit's repos whose push remote only the person can name, with each one's
// remotes: git is asked under the branch the push uses.
export function pushRemotesToPick(projectDir: string, branch: string, repos: string[]): Array<{ repo: string; remotes: string[] }> {
  const open: Array<{ repo: string; remotes: string[] }> = [];
  for (const repo of repos) {
    const dir = repo === "." ? projectDir : repoDir(projectDir, repo);
    const found = isGitRepoDir(dir) ? pushRemoteOf(dir, branch) : null;
    if (found !== null && typeof found === "object") open.push({ repo, remotes: found.remotes });
  }
  return open;
}

// The remote whose integration branch a Unit's branch starts from: the repo's
// own, whose main the lead's merge check reads, when the push goes to another
// (a fork, whose main may be older); else the push remote.
function startRemoteOf(dir: string, remote: string): string {
  try {
    return repositoryRemote(dir) ?? remote;
  } catch {
    return remote;
  }
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

// The person's own commits a Unit's branch made from where they were carries:
// those on no remote. Said in the line of the run that makes the branch,
// whether its push then goes or is refused, so they hear of them before
// anything is published; a later push says nothing of them again. Null with
// nothing to say.
function comesAlongLine(dir: string, name: string, branch: string, remote: string, start: string): string | null {
  const subjects = git(dir, ["log", "--format=%s", start, "--not", "--remotes"]).stdout.split(/\r?\n/).filter(Boolean);
  if (subjects.length === 0) return null;
  return `Branch ${branch} in ${name} starts from where you were, so your ${subjects.length === 1 ? "commit" : `${subjects.length} commits`} ` +
    `not yet on ${repoIntegration(dir, remote)} come${subjects.length === 1 ? "s" : ""} along: ` +
    `${subjects.slice(0, 3).map((subject) => `"${subject}"`).join(", ")}${subjects.length > 3 ? " and more" : ""}.`;
}

// Work that records a submodule of the project as its only repo, from before
// a project's own submodule stopped being recorded, while the Unit's code is
// the project's own: the submodule's name, else null. The source manifest's
// reader says so (its projectSubmodule); in a fresh clone that has not checked
// the submodule out, its Code Generation record reading whole with no repo
// recorded does. The push question and the push read this one rule; the way
// on is remove-repo's, which takes such a submodule off at any stage.
export function submoduleOverOwnCode(projectDir: string, unit: string): string | null {
  const read = readUnitSourceManifest(projectDir, "code-generation", unit);
  if (!read.ok && read.projectSubmodule !== undefined) return read.projectSubmodule;
  const only = intentRepos(projectDir);
  if (only.length !== 1 || !submoduleLeavesProjectRepo(projectDir, only[0]) || isGitRepoDir(repoDir(projectDir, only[0]))) return null;
  return readUnitSourceManifest(projectDir, "code-generation", unit, { recordedRepos: [] }).ok ? only[0] : null;
}

function pushUnit(args: string[], projectDir?: string): void {
  const { bareFlags, flags } = parseArgs(args);
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  const build = unitBuildOf(state);
  if (build === null) fail("push sends a Unit's build back to the lead's project; this work is not one.");
  const unit = build.unit;
  // The branch the person named (their team's own rule), kept for every
  // later push; else the one named before, else the Unit's name.
  if (bareFlags.has("branch")) fail(`push --branch needs the branch name the person gave. usage: ${unitUsage("push")}`);
  const before = unitBranchOf(state, unit);
  const branch = flags.branch?.trim() || before;
  const finishMerge = bareFlags.has("finish-merge") || flags["finish-merge"] !== undefined;
  if (flags.branch !== undefined) {
    const checked = git(pd, ["check-ref-format", "--branch", branch]);
    if (!checked.ok) fail(`"${branch}" is not a branch name git takes, so nothing was pushed.${checked.stderr.trim() ? ` Git says: "${gitSaid(checked.stderr)}".` : ""}`);
    withAuditLock(pd, () => writeStateFile(pd, setOrInsertField(readStateFile(pd), "## Runtime State", UNIT_BRANCH_FIELD, branch)));
  }
  if (bareFlags.has("later") || flags.later !== undefined) {
    withAuditLock(pd, () => writeStateFile(pd, setOrInsertField(readStateFile(pd), "## Runtime State", UNIT_PUSH_FIELD, "later")));
    finishBuildRecord(pd);
    const later = [`Nothing is pushed. I'll push ${unit} when you want it to go to the lead.`, checkInLine(pd)].filter((line) => line !== null);
    console.log(JSON.stringify({ pushed: false, notice: later.join(" ") }));
    return;
  }
  // A repo the Unit changed that the home's plan did not list is fine
  // (decision 5): it is added to the build's repos, said once, and pushed.
  let manifest = readUnitSourceManifest(pd, "code-generation", unit);
  const addedRepos: string[] = [];
  while (!manifest.ok && manifest.unrecordedRepo !== undefined && !addedRepos.includes(manifest.unrecordedRepo)) {
    const repo = manifest.unrecordedRepo;
    const added = runEngineUtility(pd, ["intent", "add-repo", repo]);
    if (!added.ok) fail(`${unit} changed ${repo}, which the lead's plan did not list, and it could not be added: ${(added.stderr || added.stdout).trim()}`);
    addedRepos.push(repo);
    manifest = readUnitSourceManifest(pd, "code-generation", unit);
  }
  const submodule = submoduleOverOwnCode(pd, unit);
  if (submodule !== null) {
    fail(
      `${unit}'s Code Generation wrote its code in this project's own repo, and this work records ${submodule}, a submodule ` +
        `of the project, as its only repo, so nothing was pushed. Ask the person whether to take ${submodule} off this work's ` +
        `repos, so the project's own repo is the work's repo (${submodule}'s folder stays as it is); on their yes, run ` +
        `\`${aidlcToolInvocation("utility")} intent remove-repo ${submodule}\`, then push ${unit} again.`,
    );
  }
  if (!manifest.ok) {
    // A record that is there but names writes its repos do not have (the
    // source list's own check, readUnitSourceManifest) is that, with the way back.
    const recorded = existsSync(join(activeRecordDir(pd), "construction", unit, "code-generation", "source-manifest.json"));
    fail(recorded
      ? `${unit}'s Code Generation record names what it wrote in a way its repos do not have, so nothing ` +
        `was pushed. Ask the person whether to take ${unit} back to Code Generation to write and record it again; on their yes, run ` +
        `\`${aidlcToolInvocation("orchestrate")} report --result resumed --choice redo --target code-generation\` and follow what it returns.`
      : `${unit} has no record of what its Code Generation wrote yet (${manifest.reason}).`);
  }
  const targets = unitWriteTargets(pd, manifest.manifest.writes);
  const byRepo = new Map([...targets].map(([repo, target]) => [repo, target.paths]));
  // The person's pick of a push remote, per repo: `--remote <repo>=<name>[,...]`.
  const picked = new Map((flags.remote ?? "").split(",").map((pair) => pair.split("=").map((part) => part.trim()))
    .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== "" && pair[1] !== ""));
  const home = buildsHome(pd, build);
  const ref = claimRef(home.id8, unit);
  if (home.target !== null) ensureFetchedClaim(pd, home, ref);
  // A take the lead's project did not record then is recorded first, so the
  // result goes onto this build's own claim, never onto anyone else's: read
  // against the claims as the lead's project has them now.
  let standing = takeStanding(pd, build);
  if (standing.state === "pending") {
    refreshHomeClaims(pd, { home, now: true });
    standing = takeStanding(pd, build);
  }
  const recorded = standing.state === "pending" ? recordTakeHere(pd, build, home, standing, true) : null;
  if (recorded?.ok) {
    if (home.target !== null) ensureFetchedClaim(pd, home, ref);
    standing = takeStanding(pd, build);
  }
  const claim = currentClaim(pd, home.target, ref);
  const label = getField(state, "Home Label")?.trim() || build.homeRecord;
  // What this Unit sent before keeps each repo's base and heads across pushes:
  // its claim's result, so a push again after a merge still lists the files
  // the Unit changed.
  const sentBefore = claim?.payload.result;
  const earlier = new Map((sentBefore?.repos ?? []).map((repo) => [repo.repo, repo]));
  const results: RepoResult[] = [];
  const takeTree = readTakeTree(activeRecordDir(pd));
  const leftOut: string[] = [];
  const gitIgnored: Array<{ path: string; name: string }> = [];
  // Every repo first: there, and a remote to push to.
  const planned: Array<{ repo: string; dir: string; name: string; remote: string; paths: string[] }> = [];
  for (const [repo, paths] of byRepo) {
    const dir = targets.get(repo)?.dir ?? (repo === "." ? pd : repoDir(pd, repo));
    if (!isGitRepoDir(dir)) fail(repoNotThereLine(pd, repo));
    // Written in a folder recorded as a checkout that is no repo of this work's.
    const strayCheckout = repo === "." ? paths.find((path) => namesSourceCheckout(path)) : undefined;
    if (strayCheckout !== undefined) {
      fail(`${unit}'s Code Generation wrote ${strayCheckout} in a folder recorded as a checkout that is not a checkout of any repo ` +
        `this work records, so nothing was pushed. If it is one of the repos ${unit} changes, add that repo to the work ` +
        `(\`${aidlcToolInvocation("utility")} intent add-repo <its name>\`), then push again.`);
    }
    const name = repo === "." ? "the repo" : repo;
    // A merge, rebase, cherry-pick or revert of theirs under way: a commit now
    // would be made over it, so nothing is committed until it is finished. A
    // merge on the Unit's own branch with nothing left to resolve is finished
    // first on the person's yes to the push question's choice (`--finish-merge`).
    const underWay = gitOperationUnderWay(dir);
    if (underWay !== null && finishMerge && unitMergeToFinish(dir, branch, paths)) {
      const made = git(dir, ["commit", "-q", "--no-edit"]);
      if (!made.ok) fail(`The merge in ${name} could not be finished, so nothing was pushed. Git says: "${gitSaid(made.stderr || made.stdout)}".`);
    } else if (underWay !== null) {
      fail(`${name} is in the middle of ${underWay.what}, so nothing was committed or pushed. Finish it (${underWay.finish}) ` +
        `or put it aside (${underWay.abort}), then I can push ${unit}.`);
    }
    // A redo built on a branch of its own from the newer integration branch is
    // pushed from that branch, never moved back onto the first build's.
    const own = flags.branch === undefined ? unitBuildOwnBranch(dir, branch) : null;
    if (own !== null) {
      fail(`${name} has ${unit}'s build on branch ${own}, which holds commits ${branch} does not, so nothing was switched or ` +
        `pushed. Ask the person whether to push it on ${own}, the branch it was built on; on their yes, run ` +
        `\`${aidlcToolInvocation("unit")} push --branch ${own}\`, and the lead's project follows that branch.`);
    }
    const remote = pushRemoteOf(dir, branch, picked.get(repo));
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
    // Files it recorded that are nowhere (not on disk and never committed in
    // the repo, a redo that wrote others, say): git would refuse to add them,
    // so this is said first, in plain words, with the way back. One the repo's
    // history has is a deletion, already committed or still to add.
    const gone = paths.filter((path) => !existsSync(join(dir, path)) && !git(dir, ["ls-files", "--error-unmatch", "--", path]).ok &&
      git(dir, ["log", "--all", "-1", "--format=%H", "--", path]).stdout.trim() === "");
    if (gone.length > 0) {
      const one = gone.length === 1;
      fail(
        `${unit}'s Code Generation recorded ${gone[0]}${one ? "" : ` and ${gone.length - 1} more`} in ${name}, and ${one ? "it is" : "they are"} ` +
          `not there, so nothing was pushed. Ask the person whether to take ${unit} back to Code Generation to write and record ` +
          `${one ? "it" : "them"} again; on their yes, run \`${aidlcToolInvocation("orchestrate")} report --result resumed --choice redo ` +
          "--target code-generation` and follow what it returns.",
      );
    }
    // Files their .gitignore leaves out (a build's bundle, say) stay out of
    // the commit, as their own git keeps them; a repo with nothing else to
    // send is not switched or pushed. Said once, with the rest.
    const ignored = untrackedIgnored(dir, paths);
    for (const path of ignored) gitIgnored.push({ path, name });
    const kept = paths.filter((path) => !ignored.includes(path));
    if (kept.length > 0) planned.push({ repo, dir, name, remote, paths: kept });
  }
  if (planned.length === 0 && gitIgnored.length > 0) {
    fail(`Nothing of ${unit}'s is left to push: every file its Code Generation wrote is one the repos' .gitignore leaves out ` +
      `(${joinNames(gitIgnored.map((entry) => `${entry.path} in ${entry.name}`))}). Nothing was switched or pushed.`);
  }
  // Then in each, onto the Unit's branch as their own hands would and its
  // commit made with their git (hooks, signing, identity), before anything is
  // pushed: a hook that stops one pushes nothing.
  const moved: Array<{ name: string; from: string }> = [];
  // The source walk as the Code Generation review binds it, read once when a
  // write names a folder.
  let sourceListing: WorkspaceSourceListing | null | undefined;
  // Their own commits on a branch this run made from where they were: said in
  // whatever line the run ends with.
  const along: string[] = [];
  const whereNow = (done = false): string =>
    whereNowLine(branch, moved, done && ownChanges(planned) ? "; your other changes are still yours, uncommitted" : "") +
      along.map((line) => ` ${line}`).join("");
  for (const { repo, dir, name, remote, paths } of planned) {
    // The Unit's branch under the name it had, now to go under the person's:
    // renamed as their own hands would while the remote has no copy of it.
    if (branch !== before && git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${before}`]).ok &&
      !git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) {
      const sent = git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${before}`]).ok;
      const named = git(dir, sent ? ["branch", branch, before] : ["branch", "-m", before, branch]);
      if (!named.ok) fail(`Branch ${before} in ${name} could not be named ${branch}, so nothing was pushed. Git says: "${gitSaid(named.stderr)}".${whereNow()}`);
    }
    const from = git(dir, ["branch", "--show-current"]).stdout.trim();
    if (from !== branch) {
      const start = startRemoteOf(dir, remote);
      const integration = repoIntegration(dir, start);
      // A Unit branch an earlier, refused run made from the integration branch
      // holds nothing of its own yet: it is made again, as on a first push, so
      // their commits since then are never branched past.
      const leftover = git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok &&
        !git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`]).ok &&
        git(dir, ["merge-base", "--is-ancestor", `refs/heads/${branch}`, integration]).ok;
      const exists = !leftover && git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
      const make = leftover ? "-C" : "-c";
      let switched = false;
      let said = "";
      if (exists) ({ ok: switched, said } = switchOntoUnitBranch(dir, branch, paths));
      else {
        // From the shared integration branch, fetched, when their working tree
        // allows; the workspace itself, which holds AI-DLC's record of this
        // build, a tree that does not allow it, and their own commits holding
        // the Unit's files start where they are.
        if (repo !== ".") git(dir, ["fetch", "-q", start, integration.slice(start.length + 1)]);
        const committedHere = paths.length > 0 && !git(dir, ["diff", "--quiet", integration, "HEAD", "--", ...paths]).ok;
        if (repo !== "." && !committedHere) switched = git(dir, ["switch", "-q", make, branch, integration]).ok;
        if (!switched) {
          const tried = git(dir, ["switch", "-q", make, branch]);
          switched = tried.ok;
          said = tried.stderr;
          const comesAlong = switched ? comesAlongLine(dir, name, branch, start, git(dir, ["rev-parse", "HEAD"]).stdout.trim()) : null;
          if (comesAlong !== null) along.push(comesAlong);
        }
      }
      if (!switched) {
        fail(`Branch ${branch} could not be checked out in ${name}, so nothing was pushed.${said.trim() ? ` Git says: "${gitSaid(said)}".` : ""}` +
          `${exists ? ` Your own changes there stay as they are; once they are committed or put aside, I can push ${unit}.` : ""}${whereNow()}`);
      }
      moved.push({ name, from: from || "the commit you were on" });
    }
    try {
      const listedAs = targets.get(repo)?.listedAs;
      if (sourceListing === undefined && paths.some((path) => path.endsWith("/"))) sourceListing = workspaceSourceListing(pd);
      const listed = sourceListing && listedAs !== undefined ? { listing: sourceListing, listedAs } : null;
      for (const path of commitUnitPaths(dir, paths, takeTree[repo] ?? {}, unit, label, name, listed)) leftOut.push(`${path} in ${name}`);
    } catch (error) {
      fail(`${errorMessage(error).replace(/([^.!?])$/, "$1.")} Nothing was pushed.${whereNow()}`);
    }
    if (takeTree[repo] !== undefined) writeTakeTree(activeRecordDir(pd), takeTree);
  }
  for (const { repo, dir, name, remote, paths } of planned) {
    // The branch's copy on its remote as last fetched: a commit there that
    // AI-DLC did not push and this build is on top of stays among its heads.
    const prior = git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}^{commit}`]).stdout.trim();
    const pushed = git(dir, ["push", "-u", remote, branch]);
    if (!pushed.ok) {
      // Its branch on the remote holds commits this build is not on top of (a
      // redo built from the newer main after a turn-down): replacing that
      // branch takes a force push, which AI-DLC never makes, so the way on it
      // gives is a new branch the lead's project follows from the result.
      const theirs = `refs/remotes/${remote}/${branch}`;
      git(dir, ["fetch", "-q", remote, `${branch}:${theirs}`]);
      const behind = git(dir, ["rev-parse", "--verify", "--quiet", theirs]).ok &&
        !git(dir, ["merge-base", "--is-ancestor", theirs, "HEAD"]).ok;
      if (behind) {
        const fresh = `${branch}-2`;
        fail(
          `${unit} was not pushed: its branch ${branch} on ${remote} in ${name} still holds the build pushed before, and ` +
            `this build is not on top of it. Ask the person whether to push it as a new branch, ${fresh}, which the ` +
            `lead's project then follows; on their yes, run \`${aidlcToolInvocation("unit")} push --branch ${fresh}\`. ` +
            `Replacing ${branch} itself takes a force push of their own; AI-DLC never forces a push.${whereNow()}`,
        );
      }
      fail(`The push of ${unit} in ${name} was refused: ${pushRefusal(pushed.stderr)}. Nothing was retried.${whereNow()}`);
    }
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    const base = earlier.get(repo)?.base ??
      (git(dir, ["merge-base", "HEAD", repoIntegration(dir, startRemoteOf(dir, remote))]).stdout.trim() || head);
    const changed = git(dir, ["diff", "--name-only", "--no-renames", base, head, "--", ...paths]).stdout.split(/\r?\n/).filter(Boolean);
    const blobs = blobsAt(dir, head, changed);
    const last = earlier.get(repo)?.heads.at(-1);
    const descends = (older: string, newer: string): boolean => git(dir, ["merge-base", "--is-ancestor", older, newer]).ok;
    const between = prior && last && prior !== last && prior !== head && descends(last, prior) && descends(prior, head) ? [prior] : [];
    const entry: RepoResult = {
      repo,
      branch,
      base,
      heads: [...new Set([...(earlier.get(repo)?.heads ?? []), ...between, head])],
      paths: Object.fromEntries(changed.map((path) => [path, blobs.get(path) ?? null])),
      ...(() => {
        const id = patchIdOf(dir, base, head, changed);
        return id ? { patch_id: id } : {};
      })(),
    };
    results.push(entry);
  }
  const nameOf = (repo: RepoResult): string => (repo.repo === "." ? "the repo" : repo.repo);
  const names = results.map(nameOf);
  const lines = [
    `Pushed branch ${branch} in ${joinNames(names)}. Open a PR in ${names.length === 1 ? "it" : "each"} your usual way.` +
      whereNow(true),
  ];
  if (addedRepos.length > 0) {
    lines.push(`${joinNames(addedRepos)} ${addedRepos.length === 1 ? "was" : "were"} not in the lead's plan; ${unit} changed ` +
      `${addedRepos.length === 1 ? "it" : "them"}, so ${addedRepos.length === 1 ? "it is" : "they are"} now among ${unit}'s repos and went with the push.`);
  }
  for (const name of [...new Set(gitIgnored.map((entry) => entry.name))]) {
    const files = gitIgnored.filter((entry) => entry.name === name).map((entry) => `${entry.path} in ${name}`);
    lines.push(`${joinNames(files)} ${files.length === 1 ? "is" : "are"} not in the commit: ${name}'s .gitignore leaves ` +
      `${files.length === 1 ? "it" : "them"} out.`);
  }
  if (leftOut.length > 0) {
    lines.push(`${joinNames(leftOut)} ${leftOut.length === 1 ? "is" : "are"} not in the commit: ${leftOut.length === 1 ? "it" : "each"} ` +
      `already had a change of yours when ${unit} was taken, and ${unit}'s own change could not be kept apart from it. ` +
      `Both are still in the file, uncommitted.`);
  }
  // The result goes home on the claim, with the Unit outputs the home's later
  // stages read.
  const outputs = unitOutputsHomeReads(unit, getField(state, "Scope") ?? "")
    .filter((rel) => existsSync(join(activeRecordDir(pd), ...rel.split("/"))));
  const kept = inputsKeptOverNewer(recordDir(pd) ?? "");
  const result: UnitResult = {
    by: git(pd, ["config", "user.name"]).stdout.trim() || "a teammate", repos: results, outputs,
    ...(kept.length > 0 ? { kept_edits: kept } : {}),
  };
  // The result on a claim: the Unit outputs the lead's later stages read with it.
  const resultOn = (on: UnitClaimView): string => {
    const files = Object.fromEntries(outputs.map((rel) => [
      `${RESULT_FILES_ROOT}/${rel}`,
      outputForLead(pd, rel, readFileSync(join(activeRecordDir(pd), ...rel.split("/")), "utf-8")),
    ]));
    // A push after a turn-down is the team's answer to it. The lead's word that
    // a repo merged holds only for a repo whose head did not change.
    const saidMerged = (on.payload.said_merged ?? []).filter((entry) =>
      earlier.get(entry.repo)?.heads.at(-1) === results.find((repo) => repo.repo === entry.repo)?.heads.at(-1));
    const payload: UnitClaimPayload = {
      ...on.payload,
      predecessor_oid: on.oid,
      result,
      verdicts: undefined,
      turned_down: undefined,
      said_merged: saidMerged.length > 0 ? saidMerged : undefined,
    };
    return createClaimCommit(pd, on.oid, payload, undefined, undefined, files);
  };
  const onRemote = (address: string): string =>
    `Its result is on ${address} too; the lead's project takes it in at the lead's next look.`;
  let homeHasIt = false;
  // Sent to the team's own remote, where the lead's look takes it in: nothing to send again.
  let sentElsewhere = false;
  // On the take the team's own remote holds when it is ahead of the lead's
  // claim (a proposal sent there, a take not taken in yet), else on the lead's
  // claim as read.
  const on = standing.state === "aside" ? null : claimToGoOn(pd, home, build, ref, claim);
  const base = on === null ? null : on.outbox !== undefined ? on.claim : standing.state === "pending" ? null : claim;
  if (standing.state === "aside") {
    lines.push(standing.line);
  } else if (base === null) {
    // The lead's project answered and holds no claim of this take now: the
    // code is pushed, and the result waits to be sent again.
    lines.push(standing.state === "pending"
      ? `The lead's project did not take ${unit}'s result: ${recorded?.refused ?? "its claim there changed while it was being sent"}. Do you want me to send it again?`
      : `The lead's project did not take ${unit}'s result: its claim is not there now. Do you want me to send it again?`);
  } else {
    const sent = writeHomeClaim(pd, home, ref, resultOn(base), claim?.oid ?? null);
    if (sent.elsewhere !== undefined) {
      lines.push(onRemote(sent.elsewhere));
      sentElsewhere = true;
    } else if (!sent.ok) {
      lines.push(sent.notThere !== undefined
        ? `The lead's project did not take ${unit}'s result, and ${sent.notThere.address} did not either (${sent.notThere.why}). Do you want me to send it again?`
        : `The lead's project did not take ${unit}'s result: ${sent.refused ?? "its claim there changed while it was being sent"}. Do you want me to send it again?`);
    }
    else invalidateLiveClaimPayloadCache(pd, unit);
    homeHasIt = sent.ok;
  }
  const sentOn = homeHasIt || sentElsewhere;
  withAuditLock(pd, () => {
    // Pushed once the result reached the home; until then the build offers to
    // send the result again.
    writeStateFile(pd, setOrInsertField(readStateFile(pd), "## Runtime State", UNIT_PUSH_FIELD, sentOn ? "pushed" : "unsent"));
    appendAuditEntryUnlocked("UNIT_PUSHED", {
      Unit: unit,
      Branch: branch,
      Repos: results.map((repo) => `${repo.repo}@${repo.heads.at(-1)}`).join(", "),
    }, pd);
  });
  if (sentOn) finishBuildRecord(pd);
  const checkIn = sentOn ? checkInLine(pd) : null;
  if (checkIn !== null) lines.push(checkIn);
  // Reached the lead's project or the team's own remote, so no line asks
  // anything: the lines ride the step that follows, as the take's carry-on
  // line does, so a next run at once says them with its question; with no chat
  // known they are printed here.
  const forNextStep = sentOn && saidWithNextStep(pd, lines.join(" "));
  console.log(JSON.stringify({ pushed: true, unit, repos: results.map((repo) => repo.repo), ...(forNextStep ? {} : { notice: lines.join(" ") }) }));
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
// teams now have on its claim (the repos it merged in, and whether it is done),
// `maybe` each commit that may be a merge the check cannot see.
export interface ToldMerge {
  unit: string;
  repos: string[];
  done: boolean;
  // Who was told, in words: the team holding the Unit, or the person.
  to: string;
}

// `readOnly` (a query such as `team-board`): the same verdicts, nothing written.
// `tookIn` gets each Unit whose records this look wrote into the lead's checkout.
export function checkTeamResults(
  projectDir: string,
  unreached?: string[],
  unsent?: Array<{ to: string; refused?: string }>,
  told?: ToldMerge[],
  readOnly = false,
  tookIn?: string[],
  maybe?: MaybeMerged[],
): Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }> {
  const pd = resolveProjectDir(projectDir);
  return quietly(() => checkTeamResultsQuietly(pd, unreached, unsent, told, readOnly, tookIn, maybe));
}

function checkTeamResultsQuietly(
  pd: string,
  unreached?: string[],
  unsent?: Array<{ to: string; refused?: string }>,
  told?: ToldMerge[],
  readOnly = false,
  tookIn?: string[],
  maybe?: MaybeMerged[],
): Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }> {
  const found = new Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }>();
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  for (const [unit, claim] of cachedClaims(pd)) {
    if (claim.status !== "claimed" || claim.payload.result === undefined) continue;
    // Done on its claim is the home's own word, wherever it was recorded: a
    // fresh clone or another machine of the home records it here too.
    if (claim.payload.done) {
      if (!readOnly && recordUnitDone(pd, claim, claim.payload.verdicts ?? [])) tookIn?.push(unit);
      found.set(unit, { team: claim.owner, verdicts: claim.payload.verdicts ?? [], done: true });
      continue;
    }
    let live: UnitClaimView | null;
    try {
      live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
    } catch {
      unreached?.push(remote ?? "the lead's project");
      continue;
    }
    const result = live?.payload.result;
    if (live?.status !== "claimed" || !result) continue;
    const verdicts = resultVerdicts(pd, live.payload, unreached, { id8: identity.intentId8, unit, maybe });
    const done = verdicts.length > 0 && verdicts.every((verdict) => verdict.merged) &&
      (!leadSignOffOn(readStateFile(pd)) || live.payload.signoff !== undefined);
    // The one thing written back is a merge the home has seen: a look at the
    // board that sees no new merge leaves the claim as the team sent it.
    const newlyMerged = verdicts.filter((verdict) => verdict.merged &&
      !(live.payload.verdicts ?? []).some((before) => before.repo === verdict.repo && before.merged)).map((verdict) => verdict.repo);
    if (done && !readOnly && recordUnitDone(pd, live, verdicts)) tookIn?.push(unit);
    if (!readOnly && (newlyMerged.length > 0 || done)) {
      const payload: UnitClaimPayload = { ...live.payload, predecessor_oid: live.oid, verdicts, ...(done ? { done: true as const } : {}) };
      const commit = createClaimCommit(pd, live.oid, payload);
      // Unwritten, the verdict stays here and the next step writes it again.
      const sent = updateClaimRef(pd, remote, live.ref, commit, live.oid);
      if (sent.ok) {
        invalidateLiveClaimPayloadCache(pd, unit);
        told?.push({ unit, repos: newlyMerged, done, to: builderOf(live) });
      } else unsent?.push({ to: remote ?? "the lead's project", ...(sent.refused ? { refused: sent.refused } : {}) });
    }
    found.set(unit, { team: live.owner, verdicts, done });
  }
  return found;
}

// The lead's merge rule for a Unit's result, read only: a repo the lead counted
// merged by word, else its integration branch fetched quietly (no sign-in, the
// lead's own time limits) and the result's heads looked for there. A repo whose
// fetch failed goes on `unreached`, its verdict the last fetch's. At the lead's
// look (`look`), a repo not merged as the result was sent is read again as at
// its Unit branch's later tip (keptUnitTip), and one still not merged puts the
// commit that may be its merge on `look.maybe` (mergeCandidate).
function resultVerdicts(
  pd: string,
  payload: UnitClaimPayload,
  unreached?: string[],
  look?: { id8: string; unit: string; maybe?: MaybeMerged[] },
): NonNullable<UnitClaimPayload["verdicts"]> {
  return (payload.result?.repos ?? []).map((repo) => {
    const said = payload.said_merged?.find((entry) => entry.repo === repo.repo);
    if (said) return { repo: repo.repo, merged: true, how: `by your word: "${said.words}"` };
    const dir = repo.repo === "." ? pd : repoDir(pd, repo.repo);
    if (!isGitRepoDir(dir)) return { repo: repo.repo, merged: false };
    const repoRemote = repositoryRemote(dir);
    const integration = repoRemote === null ? "HEAD" : repoIntegration(dir, repoRemote);
    // Only the branch the Unit merges into.
    if (repoRemote !== null && !quietFetch(dir, ["-q", repoRemote, integration.slice(repoRemote.length + 1)]).ok) {
      unreached?.push(repo.repo === "." ? repoRemote : repo.repo);
    }
    let verdict = unitMergeVerdict(dir, integration, repo);
    if (!verdict.merged && look !== undefined && repoRemote !== null) {
      const tip = keptUnitTip(dir, repoRemote, repo, `refs/aidlc/home/${look.id8}/unit/${look.unit}`);
      const atTip = tip === null ? null : resultAtTip(dir, integration, repo, tip);
      if (atTip !== null) verdict = unitMergeVerdict(dir, integration, atTip);
    }
    const candidate = verdict.merged || look?.maybe === undefined ? null : mergeCandidate(dir, integration, repo);
    if (candidate !== null) look?.maybe?.push({ unit: look.unit, repo: repo.repo, ...candidate });
    return verdict.merged ? { repo: repo.repo, merged: true, commit: verdict.commit, how: verdict.how } : { repo: repo.repo, merged: false };
  });
}

// A commit that may be a Unit's merge in one of its repos (mergeCandidate).
export interface MaybeMerged {
  unit: string;
  repo: string;
  commit: string;
  subject: string;
}

// The lead's own copy of a Unit branch's tip, in a ref of AI-DLC's own in that
// repo (`ref`), so a branch deleted after its merge is still known: the branch
// on the repo's remote, fetched quietly, when it descends from the copy kept
// before, else that copy. A copy from before the result's last head is no
// copy. Null with neither; a .git that takes no write keeps the tip read now
// for this look only.
function keptUnitTip(dir: string, remote: string, repo: RepoResult, ref: string): string | null {
  const head = repo.heads.at(-1);
  if (!head) return null;
  const descends = (older: string, newer: string): boolean => git(dir, ["merge-base", "--is-ancestor", older, newer]).ok;
  let kept: string | null = git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).stdout.trim() || null;
  if (kept !== null && kept !== head && !descends(head, kept)) kept = null;
  const tracking = `refs/remotes/${remote}/${repo.branch}`;
  if (quietFetch(dir, ["-q", remote, `+refs/heads/${repo.branch}:${tracking}`]).ok) {
    const tip = git(dir, ["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`]).stdout.trim();
    const since = kept ?? head;
    if (tip && tip !== since && descends(since, tip)) {
      git(dir, ["update-ref", ref, tip]);
      kept = tip;
    }
  }
  return kept;
}

// A team's own look at a build of this checkout that is pushed and waiting:
// the lead's merge rule run here, read only (nothing is written to the claim;
// the lead's project records the merge at its next look). True only when every
// repo of the result has it and each was reached now; a repo not here, offline
// or refusing reads as not merged yet, and nothing is said.
export function mergedAtTeamLook(projectDir: string, payload: UnitClaimPayload): boolean {
  return teamMergeSeen(projectDir, payload) === true;
}

// The same read, for a line that says where a pushed build stands: true when
// every repo has it, false when every repo is here and was reached and one
// does not have it yet, null when a repo is not here or was not reached now.
export function teamMergeSeen(projectDir: string, payload: UnitClaimPayload): boolean | null {
  const pd = resolveProjectDir(projectDir);
  try {
    return quietly(() => {
      const repos = payload.result?.repos ?? [];
      const notHere = repos.some((repo) => !payload.said_merged?.some((entry) => entry.repo === repo.repo) &&
        !isGitRepoDir(repo.repo === "." ? pd : repoDir(pd, repo.repo)));
      if (repos.length === 0 || notHere) return null;
      const unreached: string[] = [];
      const verdicts = resultVerdicts(pd, payload, unreached);
      if (unreached.length > 0) return null;
      return verdicts.every((verdict) => verdict.merged);
    });
  } catch {
    return null;
  }
}

// The work here is past the Unit stages: its stage comes after every Unit stage
// the scope plans, whether a forward jump skipped them all or left the stage it
// started from unchecked behind it. The Unit walk, the one place a team's
// result is recorded (checkTeamResults), runs on any Unit stage and nowhere
// else. The stage it is at, and the Unit stage it left from (the first one not
// done, a skipped one included), by name; else null.
export function pastUnitStages(stateContent: string): { at: string; back: string } | null {
  // The Unit stages as the scope plans them: with no state, no skip is read.
  const stages = unitMajorConstructionStageSlugs(getField(stateContent, "Scope") ?? "", "", true);
  const order = loadStageGraph().map((stage) => stage.slug);
  const at = order.indexOf(getField(stateContent, "Current Stage")?.trim() ?? "");
  if (stages.length === 0 || at <= Math.max(...stages.map((slug) => order.indexOf(slug)))) return null;
  const done = new Set(parseCheckboxes(stateContent).filter((entry) => entry.state === "completed").map((entry) => entry.slug));
  const name = (slug: string) => stageLabel(loadGraph().find((entry) => entry.slug === slug), slug) ?? slug;
  return { at: name(order[at]), back: name(stages.find((slug) => !done.has(slug)) ?? stages.at(-1)!) };
}

// Why a team's result back here is not recorded yet, for the step.
function notRecordedPastUnitStages(past: { at: string; back: string }, one: boolean): string {
  return `this work moved on to ${past.at} past the Unit stages, so ${one ? "it is" : "they are"} recorded once the work is ` +
    `back on ${past.back}, and ${past.at} does not have ${one ? "its" : "their"} outputs until then.`;
}

function resultsBackLine(back: UnitClaimView[], past: { at: string; back: string }): string {
  const one = back.length === 1;
  return `${joinNames(back.map((claim) => `${claim.unit} (from ${builderOf(claim)})`))} ${one ? "is" : "are"} back but not ` +
    `recorded yet: ${notRecordedPastUnitStages(past, one)}`;
}

const resultsBack = (projectDir: string): UnitClaimView[] => [...cachedClaims(projectDir).values()]
  .filter((claim) => claim.status === "claimed" && claim.payload.result !== undefined && !claim.payload.done);

// At a home teams build for, once the work moved on past the Unit stages: a
// team's result that came back stays on its claim, said once, and the Unit
// walk records it once the work is back on a Unit stage. While a team Unit is
// not done, the claims are fetched once per chat and again after the person speaks.
export function homeResultsPastUnitStages(projectDir: string, stateContent: string, sessionId?: string): string | null {
  if (homeLocation(stateContent) === null || !hasAnyUnitClaimRefs(projectDir)) return null;
  const past = pastUnitStages(stateContent);
  if (past === null) return null;
  let back: UnitClaimView[];
  try {
    const cached = cachedClaims(projectDir);
    const own = leadsOwnClaims(projectDir, stateContent, cached);
    const open = [...cached.values()].some((claim) => claim.status === "claimed" && !claim.payload.done && !own.has(claim.unit));
    if (!open) return null;
    if (!isReadOnlyEngineProbe()) refreshHomeClaims(projectDir, { sessionId, sincePerson: true });
    back = resultsBack(projectDir);
  } catch (e) {
    if (e instanceof GitWriteRefused) throw e;
    return null;
  }
  return back.length === 0 ? null : resultsBackLine(back, past);
}

// Once per Unit and attempt: its outputs written into the home's record, then UNIT_MERGED.
// True when this wrote the Unit's records here (they are the person's to check in).
function recordUnitDone(projectDir: string, claim: UnitClaimView, verdicts: NonNullable<UnitClaimPayload["verdicts"]>): boolean {
  const recorded = (): boolean => unitMergesStanding(readAuditShardEvents(projectDir), claim.unit).some((row) =>
    auditBlockField(row.block, "Attempt Generation") === String(claim.generation)
  );
  if (recorded()) return false;
  const record = activeRecordDir(projectDir);
  const reads = new Set(unitOutputsHomeReads(claim.unit, getField(readStateFile(projectDir), "Scope") ?? ""));
  for (const rel of (claim.payload.result?.outputs ?? []).filter((output) => reads.has(output))) {
    const shown = git(projectDir, ["show", `${claim.oid}:${RESULT_FILES_ROOT}/${rel}`, "--"]);
    if (!shown.ok) continue;
    mkdirSync(dirname(join(record, ...rel.split("/"))), { recursive: true });
    writeFileSync(join(record, ...rel.split("/")), shown.stdout, "utf-8");
  }
  let wrote = false;
  withAuditLock(projectDir, () => {
    if (recorded()) return;
    wrote = true;
    appendAuditEntryUnlocked("UNIT_MERGED", {
      Unit: claim.unit,
      Owner: claim.owner,
      "Built By": claim.payload.result?.by ?? claim.payload.taken_by ?? claim.owner,
      "Merged In": verdicts.map((verdict) => `${verdict.repo}${verdict.commit ? `@${verdict.commit}` : ""} (${verdict.how})`).join(", "),
      "Attempt Generation": String(claim.generation),
    }, projectDir);
  });
  return wrote;
}

// The home's turn-down of this build's Unit, as the claims git last brought in
// have it; null when it is not turned down (or the claims are not here). A
// turned-down build is not finished: its record reads as work under way again,
// so the person's turns in it count and their way back runs.
// Whether the lead's project turned this build's Unit down, read as the home
// has it now for a build that waits on it (fetched now once it is pushed).
export function buildTurnedDownNow(projectDir: string, stateContent: string, sessionId?: string): boolean {
  const build = unitBuildOf(stateContent);
  if (build === null) return false;
  if (!isReadOnlyEngineProbe()) {
    try {
      refreshHomeClaims(projectDir, { home: buildsHome(projectDir, build), sessionId, now: getField(stateContent, UNIT_PUSH_FIELD)?.trim() === "pushed" });
    } catch (e) {
      if (e instanceof GitWriteRefused) throw e;
      // The claims stand as this clone last fetched them.
    }
  }
  return reopenTurnedDownBuild(projectDir, stateContent) !== null;
}

// What the home said of a Unit it turned down or sent back, in one line.
export function turnedDownLine(unit: string, down: { repo: string; words?: string; from?: string }): string {
  const words = down.words ? `: "${down.words}"` : "";
  return down.from === "build-and-test"
    ? `${unit} was sent back from the lead's Build and Test${words}.`
    : `${unit} was turned down in ${down.repo} by the lead${words}.`;
}

export function reopenTurnedDownBuild(
  projectDir: string,
  stateContent: string,
): { repo: string; words?: string; at?: string; from?: "build-and-test" } | null {
  const build = unitBuildOf(stateContent);
  if (build === null) return null;
  try {
    const space = build.homeRecord.slice(0, build.homeRecord.indexOf("/"));
    const mine = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false)
      .get(build.unit);
    const down = mine?.payload.turned_down && !mine.payload.done ? mine.payload.turned_down : null;
    if (!down) return null;
    if (getField(stateContent, "Status") === "Completed" && !isReadOnlyEngineProbe()) {
      withAuditLock(projectDir, () => writeStateFile(projectDir, setField(readStateFile(projectDir), "Status", "Running")));
    }
    return {
      repo: down.repo,
      ...(down.words ? { words: down.words } : {}),
      ...(down.at ? { at: down.at } : {}),
      ...(down.from ? { from: down.from } : {}),
    };
  } catch {
    return null;
  }
}

// Each shared input's version as this build last took it from the home (at
// the take, then each amendment it took), and the inputs whose own edit it kept
// over a newer version: what the team's copy is told apart by, and what its
// result says to the lead. Kept in the build's engine folder, never committed.
const INPUTS_TAKEN_FILE = "inputs-taken.json";

function inputsTakenFile(record: string): { taken: Record<string, string>; kept: string[] } {
  try {
    const read = JSON.parse(readFileSync(join(record, ".aidlc-engine", INPUTS_TAKEN_FILE), "utf-8")) as {
      taken?: Record<string, string>; kept?: string[];
    };
    return { taken: read.taken ?? {}, kept: read.kept ?? [] };
  } catch {
    return { taken: {}, kept: [] };
  }
}

function inputsTaken(record: string): Map<string, string> {
  const taken = new Map(approvedInputsOf(record).map((input) => [input.path, input.fingerprint] as [string, string]));
  for (const [input, fingerprint] of Object.entries(inputsTakenFile(record).taken)) taken.set(input, fingerprint);
  return taken;
}

// `fingerprint` null: the team's own edit of `input` is kept over the new version.
function noteInputTaken(record: string, input: string, fingerprint: string | null): void {
  const file = inputsTakenFile(record);
  if (fingerprint === null) file.kept = [...new Set([...file.kept, input])];
  else {
    file.taken[input] = fingerprint;
    file.kept = file.kept.filter((entry) => entry !== input);
  }
  try {
    mkdirSync(join(record, ".aidlc-engine"), { recursive: true });
    writeFileAtomic(join(record, ".aidlc-engine", INPUTS_TAKEN_FILE), `${JSON.stringify(file)}\n`);
  } catch {
    // Unnoted: the next step reads the copy against the version taken first.
  }
}

// The inputs whose own edit this build kept over the home's newer version.
export function inputsKeptOverNewer(record: string): string[] {
  return inputsTakenFile(record).kept;
}

// A newer version of one input this build was approved with, from its claim's
// amendments: the copy here takes it, and the stages
// that used it read as current, on every Guard Policy; a copy the team edited
// since it took it, other than the text it proposed (`proposedHere`), stays as
// they left it, with the new version beside it and their result saying so to
// the lead. A version taken already is not newer: a copy that differs from it
// is the team's own edit since, which the send question asks about. The one
// line to say, or null when there is nothing new.
function takeNewerInput(
  projectDir: string,
  record: string,
  unit: string,
  input: string,
  text: string,
  how: { at: string; done: boolean; pushed: boolean; proposedHere: boolean },
  // A done Unit's changed inputs, gathered for one follow-up offer for all.
  doneNames?: string[],
): string | null {
  const path = join(record, ...input.split("/"));
  // The copy already holds it (the team's own change, approved as it was):
  // taken, so the next newer version is read against it, not as their edit.
  if (existsSync(path) && textFingerprint(readFileSync(path, "utf-8")) === textFingerprint(text)) {
    if (inputsTaken(record).get(input) !== textFingerprint(text)) noteInputTaken(record, input, textFingerprint(text));
    return null;
  }
  const name = inputName(input);
  const taken = inputsTaken(record).get(input);
  if (taken === textFingerprint(text)) return null;
  if (!how.proposedHere && existsSync(path) && taken !== undefined && textFingerprint(readFileSync(path, "utf-8")) !== taken) {
    const beside = path.replace(/\.md$/, "") + ".from-lead.md";
    if (existsSync(beside) && textFingerprint(readFileSync(beside, "utf-8")) === textFingerprint(text)) return null;
    writeFileSync(beside, text, "utf-8");
    noteInputTaken(record, input, null);
    return `The lead changed the ${name}, and your copy has your own edits, so I kept yours as you left it and put ` +
      `the new version beside it, at ${relative(projectDir, beside).split(sep).join("/")}: compare the two and keep what you want.`;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
  noteInputTaken(record, input, textFingerprint(text));
  const renewed = renewForAmendedInput(projectDir, input, { Unit: unit, "Amended At Home": how.at });
  // Said without "after": the lead may have changed it before the Unit was
  // done or pushed, and it reaches the team only now.
  if (how.done && doneNames !== undefined) {
    doneNames.push(name);
    return null;
  }
  if (how.done) return `The lead changed the ${name}, and ${unit} is already done. Do you want me to start follow-up work for it?`;
  // Pushed and waiting on the home: it hears the change and nothing of it is reopened.
  if (how.pushed) return `The lead changed the ${name}; ${unit} stays as you pushed it.`;
  if (renewed.length > 0) return staleStageLine(stageLabel(loadGraph().find((stage) => stage.slug === renewed[0]), renewed[0]) ?? renewed[0]);
  return `The lead changed the ${name}; ${unit} uses the new one from here.`;
}

// What the home said about this build's Unit, read from the claims git last
// brought in, each said once: a turn-down in the home's words, the home's
// answer to a proposal, a Unit it started early on that is now done or turned
// down, and an input the home amended (the copy here takes the new version,
// and the stages that used it read as current, on every Guard Policy).
// The home's answer to a proposal is kept heard by that proposal (`once`), so a
// second answer to the same input is heard in a chat that heard the first.
export function buildClaimNotes(projectDir: string, stateContent: string, sessionId?: string): Array<string | { line: string; once: string }> {
  const build = unitBuildOf(stateContent);
  if (build === null) return [];
  const space = build.homeRecord.slice(0, build.homeRecord.indexOf("/"));
  const lines: Array<string | { line: string; once: string }> = [];
  if (!isReadOnlyEngineProbe()) {
    let home: HomeWork | null = null;
    try {
      home = buildsHome(projectDir, build);
    } catch {
      // The home's record is not here: what this workspace has stands.
    }
    // A pushed build waits on the home's answer: each step of it fetches.
    // Building, it looks again once each time its chat reaches a new stage,
    // so a change the lead approves meanwhile is heard there.
    const waits = getField(stateContent, UNIT_PUSH_FIELD)?.trim() === "pushed";
    // Started early on a Unit that is not done yet: its merge is news this
    // build waits on before its push, so each step looks, as a pushed one does.
    const waitsOnEarly = ((): boolean => {
      try {
        const cached = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false);
        return (cached.get(build.unit)?.payload.early_on ?? []).some((dep) => dep.repos.length > 0 && cached.get(dep.unit)?.payload.done !== true);
      } catch {
        return false;
      }
    })();
    const atStage = `${recordDir(projectDir) ?? ""}:${getField(stateContent, "Current Stage")?.trim() ?? ""}`;
    const newStage = buildStageLooked(projectDir, sessionId) !== atStage;
    const refreshed = home === null ? null : refreshHomeClaims(projectDir, { home, sessionId, now: waits || newStage || waitsOnEarly });
    if (refreshed?.unreached) lines.push("The lead's project could not be reached just now, so news from it may be behind.");
    if (refreshed?.refused) lines.push(newsNotTakenIn("the lead's project"));
    if (home !== null && newStage) noteBuildStageLooked(projectDir, sessionId, atStage);
    // A take the lead's project did not record then, tried again when the claims were just fetched.
    const standing = home !== null && refreshed?.fetched ? takeStanding(projectDir, build) : null;
    if (home !== null && standing?.state === "pending") recordTakeHere(projectDir, build, home, standing, false);
    if (home !== null && waits && !refreshed?.unreached) {
      try {
        const cached = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false)
          .get(build.unit);
        if (cached !== undefined && claimIsMine(projectDir, cached)) sendBranchTipsHome(projectDir, build, home, cached);
      } catch (e) {
        if (e instanceof GitWriteRefused) throw e;
      }
    }
  }
  const aside = takeStanding(projectDir, build);
  if (aside.state === "aside") return [...lines, aside.line];
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
    lines.push(turnedDownLine(unit, down));
  }
  for (const proposal of mine.payload.proposals ?? []) {
    const once = `${proposal.input}@${proposal.at}`;
    if (proposal.answer === "approved") lines.push({ line: `The lead approved your change to the ${inputName(proposal.input)}.`, once });
    if (proposal.answer === "turned down") {
      lines.push({
        line: `The lead turned down your change to the ${inputName(proposal.input)}` +
          `${proposal.answer_words ? `: "${proposal.answer_words}"` : ""}${/[.!?]$/.test(proposal.answer_words?.trim() ?? "") ? "" : "."} I'm carrying on with the approved one.`,
        once,
      });
    }
  }
  // A Unit it started early on that is now done is offered as the move onto
  // the integration branch (earlyBaseMerged), not as a line.
  // One that changed none of this Unit's repos left nothing here on its branch.
  for (const dep of mine.payload.early_on ?? []) {
    const theirs = claims.get(dep.unit)?.payload;
    if (!theirs?.done && theirs?.turned_down && dep.repos.length > 0) {
      lines.push(`${dep.unit} was turned down by the lead; ${unit} started on its branch. Nothing else changes: wait for it, ` +
        "or rebase when you are ready.");
    }
  }
  if (isReadOnlyEngineProbe()) return lines;
  const record = recordDir(projectDir);
  const doneNames: string[] = [];
  for (const amendment of mine.payload.amendments ?? []) {
    if (record === null) break;
    // The team's own proposed copy is theirs while the lead decides: never
    // written back while that proposal waits.
    if ((mine.payload.proposals ?? []).some((entry) => entry.input === amendment.input && entry.answer === undefined)) continue;
    const shown = git(projectDir, ["show", `${mine.oid}:${RESULT_FILES_ROOT}/amendments/${amendment.input}`, "--"]);
    if (!shown.ok) continue;
    // Pushed after the change came: it was built on the older one, and its stages hear it as stale.
    // Both times are to the second, so a change of the push's own second reads as after it.
    const pushedAt = readAuditShardEvents(projectDir).filter((row) => row.event === "UNIT_PUSHED")
      .map((row) => row.timestamp).sort().at(-1);
    const line = takeNewerInput(projectDir, record, unit, amendment.input, shown.stdout, {
      at: amendment.at,
      done: mine.payload.done === true,
      pushed: getField(stateContent, UNIT_PUSH_FIELD)?.trim() === "pushed" && (pushedAt === undefined || amendment.at >= pushedAt),
      // The copy is still the text the team proposed: the lead's answer replaces it.
      proposedHere: ((): boolean => {
        const proposed = git(projectDir, ["show", `${mine.oid}:${RESULT_FILES_ROOT}/proposals/${amendment.input}`, "--"]);
        const copy = join(record, ...amendment.input.split("/"));
        return proposed.ok && existsSync(copy) && textFingerprint(readFileSync(copy, "utf-8")) === textFingerprint(proposed.stdout);
      })(),
    }, doneNames);
    if (line !== null) lines.push(line);
  }
  // One offer for everything that changed after the Unit was done, never one per file.
  if (doneNames.length > 0) {
    lines.push(`The lead changed ${joinNames(doneNames.map((name) => `the ${name}`))}, and ${unit} is already done. ` +
      `Do you want me to start follow-up work for ${doneNames.length === 1 ? "it" : "them"}?`);
  }
  return lines;
}

export const BUILD_WAITING_CLAUSE = "Its build is waiting for you; say so to go back to it.";

// A pushed build waiting for its merge: a commit on its Unit branch that
// AI-DLC did not push (a review fix by hand, a host's suggestion commit,
// Update branch) goes onto its claim as the result's last head (resultAtTip),
// so the lead's merge check reads the branch as it is, also once it is
// deleted. Nothing is said; a write the lead's project does not take is tried
// again at the next look.
function sendBranchTipsHome(pd: string, build: UnitBuild, home: HomeWork, cached: UnitClaimView): void {
  const result = cached.payload.result;
  if (cached.status !== "claimed" || cached.payload.done || cached.payload.turned_down || result === undefined) return;
  const tips = new Map<string, RepoResult>();
  for (const repo of result.repos) {
    const dir = repo.repo === "." ? pd : repoDir(pd, repo.repo);
    if (!isGitRepoDir(dir)) continue;
    const remote = pushRemoteOf(dir, repo.branch);
    if (typeof remote !== "string") continue;
    const tracking = `refs/remotes/${remote}/${repo.branch}`;
    if (!quietFetch(dir, ["-q", remote, `+refs/heads/${repo.branch}:${tracking}`]).ok) continue;
    const tip = git(dir, ["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`]).stdout.trim();
    const atTip = tip ? resultAtTip(dir, repoIntegration(dir, startRemoteOf(dir, remote)), repo, tip) : null;
    if (atTip !== null) tips.set(repo.repo, atTip);
  }
  if (tips.size === 0) return;
  const ref = claimRef(home.id8, build.unit);
  const on = claimToGoOn(pd, home, build, ref, currentClaim(pd, home.target, ref)).claim;
  if (on?.status !== "claimed" || on.payload.result === undefined || on.payload.done) return;
  const repos = on.payload.result.repos.map((repo) => {
    const atTip = tips.get(repo.repo);
    return atTip !== undefined && atTip.heads.at(-2) === repo.heads.at(-1) ? atTip : repo;
  });
  const payload: UnitClaimPayload = { ...on.payload, predecessor_oid: on.oid, result: { ...on.payload.result, repos } };
  if (writeHomeClaim(pd, home, ref, createClaimCommit(pd, on.oid, payload), on.oid).ok) invalidateLiveClaimPayloadCache(pd, build.unit);
}

// The lead's turn-down of another of this clone's Unit builds, said in a chat
// on any of its work, not only the build it is about: each line once per chat
// (the caller's), with the step that takes that build up again. The claims are
// read as this clone last fetched them, fetched once per chat; with `look`
// false (the step's follow-up, after its own look) not fetched again.
export function otherBuildsTurnedDown(
  projectDir: string,
  selected: string | null,
  sessionId?: string,
  look = true,
): Array<{ line: string; command: string }> {
  const found: Array<{ line: string; command: string }> = [];
  let spaces: string[];
  try {
    spaces = readdirSync(join(projectDir, "aidlc", "spaces"));
  } catch {
    return found;
  }
  for (const space of spaces) {
    for (const dirName of listIntentDirs(projectDir, space)) {
      if (dirName === selected) continue;
      let build: UnitBuild | null;
      try {
        build = unitBuildOf(readStateFile(projectDir, dirName, space));
      } catch {
        continue;
      }
      if (build === null) continue;
      const homeSpace = build.homeRecord.slice(0, build.homeRecord.indexOf("/"));
      const homeDir = build.homeRecord.slice(build.homeRecord.indexOf("/") + 1);
      try {
        const home = buildsHome(projectDir, build);
        // Again after each message of the person's in this chat: news that came
        // after the chat's first look is heard at their next word.
        if (look && !isReadOnlyEngineProbe()) refreshHomeClaims(projectDir, { home, sessionId, sincePerson: true });
        const mine = cachedClaimsForIdentity(projectDir, { space: homeSpace, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false)
          .get(build.unit);
        const down = mine?.payload.turned_down;
        // Offered back only to the one who took it; another's build is said in the take list.
        if (!down || mine?.payload.done || !claimIsMine(projectDir, mine!) || takeStanding(projectDir, build).state !== "recorded") continue;
        const said = turnedDownLine(build.unit, down);
        found.push({
          line: `${said} ${BUILD_WAITING_CLAUSE}`,
          command: `${aidlcToolInvocation("unit")} take ${shellArg(build.unit)} --home ${shellArg(homeDir)}` +
            (homeSpace === DEFAULT_SPACE ? "" : ` --home-space ${shellArg(homeSpace)}`),
        });
      } catch (e) {
        // The way on when this .git cannot be written stops the step, as at
        // every look; a home this clone cannot read says nothing here.
        if (e instanceof GitWriteRefused) throw e;
      }
    }
  }
  return found;
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
  const branch = unitBranchOf(stateContent, build.unit);
  const earlyOn = claims.get(build.unit)?.payload.early_on ?? [];
  if (earlyOn.length === 0 || takeStanding(projectDir, build).state !== "recorded") return [];
  return earlyOn.flatMap((dep) => {
    const theirs = claims.get(dep.unit)?.payload;
    if (!theirs?.done || skip(dep.unit)) return [];
    const moves = (from: typeof dep.repos, look: boolean) => from.flatMap(({ repo, head }) => {
      const dir = repo === "." ? projectDir : repoDir(projectDir, repo);
      const remote = isGitRepoDir(dir) ? repositoryRemote(dir) : null;
      if (remote === null || !git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) return [];
      const onto = repoIntegration(dir, remote);
      // The integration branch as its remote has it now, with the merge.
      if (look) quietFetch(dir, ["-q", remote, onto.slice(remote.length + 1)]);
      if (git(dir, ["merge-base", "--is-ancestor", onto, `refs/heads/${branch}`]).ok) return [];
      const kept = theirs.verdicts?.find((verdict) => verdict.repo === repo)?.how === "ancestry";
      const own = head === "" || git(dir, ["rev-parse", `refs/heads/${branch}`]).stdout.trim() !== head;
      const on = git(dir, ["branch", "--show-current"]).stdout.trim() === branch;
      return [{
        repo,
        name: repo === "." ? "the repo" : repo,
        dir,
        remote,
        onto,
        rebase: on && !own ? ["reset", "-q", "--keep", onto]
          : kept || head === "" ? ["rebase", onto, branch] : ["rebase", "--onto", onto, head, branch],
      }];
    });
    const waiting = refused(dep.unit) ? moves(dep.repos, false) : null;
    if (waiting?.some((repo) => moveInTheWay(repo))) return [];
    const repos = moves(waiting === null ? dep.repos : dep.repos.filter(({ repo }) => waiting.some((left) => left.repo === repo)), true);
    return repos.length > 0 ? [{ unit: dep.unit, repos }] : [];
  });
}

// The git operation of theirs under way in a repo, in plain words with git's
// own way to finish it and to put it aside; null when none is.
// A merge under way on the Unit's own branch with nothing left to resolve and
// nothing staged that the merge did not bring (a redo that merged the newer
// main, say): the push question offers to finish it, and `push --finish-merge`
// concludes it with the person's own git before the Unit's commit.
// The branch a Unit's build sits on in a repo when it is a branch of its own:
// the repo is on a branch that is neither the Unit's recorded one nor its
// integration branch, and holds commits the recorded branch lacks (a redo built
// on a new branch from the newer integration branch, say). Moving onto the
// recorded branch would leave those commits out of the push, so the push goes
// from this branch. Null otherwise.
export function unitBuildOwnBranch(dir: string, unitBranch: string): string | null {
  const current = git(dir, ["branch", "--show-current"]).stdout.trim();
  if (current === "" || current === unitBranch) return null;
  if (!git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${unitBranch}`]).ok) return null;
  const remote = repositoryRemote(dir);
  const integration = remote === null ? null : repoIntegration(dir, remote);
  if (integration !== null && current === integration.slice(remote!.length + 1)) return null;
  return git(dir, ["merge-base", "--is-ancestor", "HEAD", `refs/heads/${unitBranch}`]).ok ? null : current;
}

// `own`: the paths the Unit's Code Generation wrote in this repo (a file or a
// folder), which its build may have staged while the merge was under way;
// anything else staged is the person's own, and they finish the merge.
export function unitMergeToFinish(dir: string, branch: string, own: readonly string[] = []): boolean {
  if (gitOperationUnderWay(dir)?.what !== "a merge") return false;
  if (git(dir, ["branch", "--show-current"]).stdout.trim() !== branch) return false;
  if (git(dir, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim() !== "") return false;
  const merged = new Set(git(dir, ["diff", "--name-only", "-z", "HEAD...MERGE_HEAD"]).stdout.split("\0").filter(Boolean));
  const written = own.map((path) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  const unitsOwn = (path: string): boolean => written.some((entry) => path === entry || path.startsWith(`${entry}/`));
  return git(dir, ["diff", "--cached", "--name-only", "-z"]).stdout.split("\0").filter(Boolean)
    .every((path) => merged.has(path) || unitsOwn(path));
}

export function gitOperationUnderWay(dir: string): { what: string; finish: string; abort: string } | null {
  const at = (name: string): boolean => existsSync(resolve(dir, git(dir, ["rev-parse", "--git-path", name]).stdout.trim()));
  if (rebaseUnderWay(dir)) return { what: "a rebase", finish: "git rebase --continue", abort: "git rebase --abort" };
  if (at("MERGE_HEAD")) return { what: "a merge", finish: "git commit", abort: "git merge --abort" };
  if (at("CHERRY_PICK_HEAD")) return { what: "a cherry-pick", finish: "git cherry-pick --continue", abort: "git cherry-pick --abort" };
  if (at("REVERT_HEAD")) return { what: "a revert", finish: "git revert --continue", abort: "git revert --abort" };
  return null;
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
  const unitBranch = unitBranchOf(state, build.unit);
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
        if (stopped && from !== unitBranch) switched.push({ name: repo.name, from: from || "the commit you were on" });
        fail(`${build.unit} could not be moved onto ${branch} in ${repo.name}. Git says: "${gitSaid(ran.stderr || ran.stdout)}".` +
          (stopped ? ` To go back to where ${build.unit} was there, run git rebase --abort in ${repo.name}.` : "") +
          (moved.length > 0 ? ` In ${joinNames(moved)} it is on ${joinNames([...onto])} now.` : "") + whereNowLine(unitBranch, switched));
      }
      moved.push(repo.name);
      onto.add(branch);
      if (repo.rebase[0] === "rebase") replayed = true;
      if (from !== unitBranch) switched.push({ name: repo.name, from: from || "the commit you were on" });
    }
  }
  const notice = moved.length === 0
    ? `${build.unit} is on the integration branch already; nothing moved.`
    : `${build.unit} is on ${joinNames([...onto])} now in ${joinNames(moved)}${replayed ? ", with its own commits on top" : ""}. ` +
      `Nothing is pushed.${whereNowLine(unitBranch, switched)}`;
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
  if (!flags.input) fail(`usage: ${unitUsage("propose")}`);
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
    console.log(JSON.stringify({ proposed: false, notice: `The ${name} is as the lead approved it, so there is no change to send.` }));
    return;
  }
  const home = buildsHome(pd, build);
  const ref = claimRef(home.id8, build.unit);
  if (home.target !== null) ensureFetchedClaim(pd, home, ref);
  // Never onto a claim this build's take is not on; one the lead's project did
  // not record then is recorded first.
  let standing = takeStanding(pd, build);
  if (standing.state === "pending") {
    refreshHomeClaims(pd, { home, now: true });
    standing = takeStanding(pd, build);
    if (standing.state === "pending" && recordTakeHere(pd, build, home, standing, true).ok) standing = takeStanding(pd, build);
  }
  if (standing.state === "aside") {
    console.log(JSON.stringify({ proposed: false, notice: standing.line }));
    return;
  }
  // On the take the team's own remote holds when it is ahead of the lead's claim.
  const atLead = currentClaim(pd, home.target, ref);
  const live = claimToGoOn(pd, home, build, ref, atLead).claim;
  if (live?.status !== "claimed") fail(`${build.unit} is not held at the lead's project, so there is no claim to send the change on.`);
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
  const commit = createClaimCommit(pd, live.oid, payload, undefined, undefined, {
    [`${RESULT_FILES_ROOT}/proposals/${match.path}`]: text,
  });
  const sent = writeHomeClaim(pd, home, ref, commit, atLead?.oid ?? null);
  const carryingOn = `I'm carrying on with ${flags.file !== undefined ? `the approved ${name}` : "your version here"} until the lead decides.`;
  if (sent.elsewhere !== undefined) {
    console.log(JSON.stringify({
      proposed: true,
      notice: `Sent your change to the ${name} to ${sent.elsewhere}; the lead's project takes it in at the lead's next look. ${carryingOn}`,
    }));
    return;
  }
  if (!sent.ok) fail(`The lead's project did not take the change: ${sent.refused ?? "its claim moved meanwhile"}. Try again.`);
  invalidateLiveClaimPayloadCache(pd, build.unit);
  console.log(JSON.stringify({
    proposed: true,
    notice: `Sent to the lead: your change to the ${name}. ${carryingOn}`,
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
  }), state).includes(input)));
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
    // No claims here: its own copy is the record.
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
    // The version a claim brought, as taken, is the lead's, never a change of
    // the team's to send back.
    if (fingerprint === entry.fingerprint || inputsTaken(record).get(entry.path) === fingerprint ||
      sentOrAnswered(entry.path, fingerprint)) return [];
    return [{ path: entry.path, name: inputName(entry.path), fingerprint }];
  });
}

// One question per proposal: a second change to the same input, made after
// the first was answered, is asked about with its own text.
export function amendAskName(unit: string, input: string, at = ""): string {
  return `amend-${unit}-${input.replace(/[^A-Za-z0-9.-]+/g, "_")}${at ? `-${at.replace(/[^0-9A-Za-z]+/g, "")}` : ""}.json`;
}

// One amendment onto a team's claim, with the text it carries: a claim that
// moved meanwhile is read again and written once more. "missed" when it could
// not be written, null when the claim is no longer held; else "sent".
function amendClaim(
  pd: string,
  remote: string | null,
  claim: UnitClaimView,
  amendment: Amendment,
  text: string,
  extra?: (payload: UnitClaimPayload) => Partial<UnitClaimPayload>,
  stillNeeded: (current: UnitClaimView) => boolean = () => true,
): "sent" | "missed" | null {
  const amended = (current: UnitClaimView): ReturnType<typeof updateClaimRef> => updateClaimRef(pd, remote, current.ref, createClaimCommit(pd, current.oid, {
    ...current.payload,
    predecessor_oid: current.oid,
    amendments: [...(current.payload.amendments ?? []).filter((entry) => entry.input !== amendment.input), amendment],
    ...(extra?.(current.payload) ?? {}),
  }, undefined, undefined, {
    [`${RESULT_FILES_ROOT}/amendments/${amendment.input}`]: text,
  }), current.oid);
  let current = currentClaim(pd, remote, claim.ref);
  if (current?.status !== "claimed" || !stillNeeded(current)) return null;
  // A claim that moved meanwhile is read again, and written once more if it still needs it.
  if (!amended(current).ok) {
    current = currentClaim(pd, remote, claim.ref);
    if (current?.status !== "claimed" || !stillNeeded(current)) return null;
    if (!amended(current).ok) return "missed";
  }
  invalidateLiveClaimPayloadCache(pd, claim.unit);
  return "sent";
}

// At the home: the lead's own change to an input teams build with (a redo of
// Requirements Analysis, say), once its stage's gate approved it: each team
// building a Unit that hears it (unitsHearing) and still has an older copy
// (its last amendment of it, else the copy it took) gets it on its claim, as
// an approved proposal does, and hears it once (buildClaimNotes). Approved
// means by the record: the stage's own approval row is newer than that copy
// (not in the audit the copy was taken with, or after the amendment), and the
// text is the one its completion recorded, so an edit since then sends
// nothing. The lines for the lead, once per change.
export function sendLeadsApprovedChanges(projectDir: string): string[] {
  const pd = resolveProjectDir(projectDir);
  return quietly(() => {
    const lines: string[] = [];
    // A Unit already done hears it too, as an approved proposal reaches it:
    // once, with the offer of follow-up work, never reopened (takeNewerInput).
    // The lead's own build here reads the lead's inputs where they are.
    const cached = cachedClaims(pd);
    const own = leadsOwnClaims(pd, readStateFile(pd), cached);
    const claims = [...cached.values()].filter((claim) =>
      claim.status === "claimed" && claim.payload.taken_by !== undefined && !own.has(claim.unit)
    );
    const recordRel = relativeRecordDir(pd)?.split(sep).join("/") ?? null;
    if (claims.length === 0 || recordRel === null) return lines;
    const record = activeRecordDir(pd);
    const remote = repositoryRemote(pd);
    const state = readStateFile(pd);
    const graph = loadGraph();
    const rows = readAuditShardEvents(pd);
    const receipts = latestCompletionBasesFromAudit(readAllAuditShards(pd));
    // The lead's latest word on an input: its stage's gate, or a team's change
    // to it the lead approved (SHARED_INPUT_AMENDED), which reaches a Unit
    // taken after it too.
    const approval = (stage: string, input: string): AuditShardEvent | undefined => rows
      .filter((row) => (row.event === "GATE_APPROVED" && auditBlockField(row.block, "Stage") === stage && !auditBlockField(row.block, "Unit")) ||
        (row.event === "SHARED_INPUT_AMENDED" && auditBlockField(row.block, "Input") === input))
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)).at(-1);
    // Per commit a team took its copies from: the inputs that differ here now
    // (one diff), and the approval rows its audit already held.
    const taken = new Map<string, { changed: Set<string>; approvals: Set<string> }>();
    const takenFrom = (base: string) => {
      if (!taken.has(base)) {
        const diff = git(pd, ["diff", "--name-only", "--relative", base, "--", recordRel]);
        taken.set(base, {
          changed: new Set(diff.ok ? diff.stdout.split("\n").filter(Boolean).map((path) => path.slice(recordRel.length + 1)) : []),
          approvals: new Set(auditRowsAt(pd, recordRel, base).filter((row) => row.event === "GATE_APPROVED" || row.event === "SHARED_INPUT_AMENDED")
            .map((row) => row.block)),
        });
      }
      return taken.get(base)!;
    };
    for (const input of approvedInputPathsHere(pd)) {
      const at = artifactAt(input);
      const approved = at === null ? undefined : approval(at.producer, input);
      if (at === null || approved === undefined) continue;
      // Edited since its completion recorded it: not what the gate approved.
      const node = graph.find((entry) => entry.slug === at.producer);
      const receipt = receipts.get(at.producer);
      if (node !== undefined && receipt !== undefined &&
          diffStageValidationBasis(receipt, captureStageValidationBasis(pd, node, state, graph)).includes(`output:${at.artifact}`)) continue;
      let text: string;
      try {
        text = readFileSync(join(record, ...input.split("/")), "utf-8");
      } catch {
        continue;
      }
      const reached: string[] = [];
      for (const claim of claims) {
        // A team's own change waiting for the lead's answer is that answer's to settle.
        if ((claim.payload.proposals ?? []).some((entry) => entry.input === input && entry.answer === undefined)) continue;
        const last = (claim.payload.amendments ?? []).find((entry) => entry.input === input);
        let copy: string;
        if (last !== undefined) {
          const shown = git(pd, ["show", `${claim.oid}:${RESULT_FILES_ROOT}/amendments/${input}`, "--"]);
          if (!shown.ok || Date.parse(approved.timestamp) <= Date.parse(last.at)) continue;
          copy = shown.stdout;
        } else {
          const base = takenFrom(claim.payload.base_oid);
          if (!base.changed.has(input) || base.approvals.has(approved.block)) continue;
          const shown = git(pd, ["show", `${claim.payload.base_oid}:${recordRel}/${input}`, "--"]);
          if (!shown.ok) continue;
          copy = shown.stdout;
        }
        if (textFingerprint(copy) === textFingerprint(text) || !unitsHearing(pd, input, copy, text).has(claim.unit)) continue;
        const differs = (current: UnitClaimView): boolean => {
          const now = git(pd, ["show", `${current.oid}:${RESULT_FILES_ROOT}/amendments/${input}`, "--"]);
          return !now.ok || textFingerprint(now.stdout) !== textFingerprint(text);
        };
        const sent = amendClaim(pd, remote, claim, { input, at: isoTimestamp(), words: "" }, text, undefined, differs);
        if (sent === null || sent === "missed") continue;
        reached.push(builderOf(claim));
      }
      if (reached.length > 0) {
        const name = inputName(input);
        lines.unshift(`The ${name} you changed ${name.endsWith("s") ? "reach" : "reaches"} the teams building with it ` +
          `(${joinNames([...new Set(reached)])}): they hear it once and carry on.`);
      }
    }
    return lines;
  });
}

// Who hears a change to an input: each Unit whose stages read it; for the
// contract summary, only the Units party to a contract the change touches,
// when its own Contracts table can say (contractPartiesChanged).
function unitsHearing(pd: string, input: string, before: string | null, after: string): Set<string> {
  const readers = unitsReading(pd, input);
  if (input !== CONTRACT_SUMMARY_INPUT || before === null) return readers;
  const dag = resolveBoltDag(pd);
  const parties = dag.state === "ok" ? contractPartiesChanged(before, after, dag.units) : null;
  return parties === null ? readers : new Set([...readers].filter((unit) => parties.has(unit)));
}

// The inputs a team's build here is approved with: the Inception outputs the
// work's per-Unit stages read, the Unit plan left out (a plan change has its
// own way to the teams).
function approvedInputPathsHere(pd: string): string[] {
  const state = readStateFile(pd);
  return homeInputPaths(unitMajorConstructionStageSlugs(getField(state, "Scope") ?? "", state, true), state)
    .filter((rel) => !rel.endsWith("unit-of-work-dependency.md"));
}

// At the home: the owner of the shared plan answers a team's proposal, in their
// own words, under the rules for a person's answer (their reply after it was
// shown, not empty, not a cancellation, not the agent's). An approved change
// is written into the home's record, the home's stages that used it read as
// current, and every team building with it gets it on its claim.
function amendInput(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  const answer = flags.answer;
  if (!unit || !flags.input || (answer !== "approve" && answer !== "reject")) {
    fail(`usage: ${unitUsage("amend")}`);
  }
  const pd = resolveProjectDir(projectDir);
  // What the team hears stays the words the agent relays (`words`): a team's
  // notice is said once by its text, so the lead's typed words go only on the
  // lead's own records (`lead`).
  const words = personWordsOf(pd, flags);
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  const proposal = live?.payload.proposals?.find((entry) => entry.input === flags.input && entry.answer === undefined);
  if (!live || proposal === undefined) fail(`${unit} has no change to ${flags.input} waiting for an answer.`);
  const lead = leadsWord(pd, flags, "The answer to a proposed change", "unit-amend");
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
    // The lead's own text of the two put together (--file), approved as written.
    const own = flags.file !== undefined ? readFileSync(resolve(pd, flags.file), "utf-8") : null;
    const text = own ?? changeOntoCurrent(pd, path, taken.ok ? taken.stdout : null, shown.stdout);
    if (text === null) {
      const theirs = writeProposedText(pd, live, proposal.input);
      fail(
        `${builderOf(live)}'s change was made on an older copy of the ${name}, and it does not fit onto the ${name} as it ` +
          `stands here now, so nothing was changed. Show the lead both: their version${theirs === null ? "" : ` (${theirs})`} ` +
          `and the current one (${relative(pd, path).split(sep).join("/")}); the team can send the change again on the current one. ` +
          `When the lead puts the two together (or asks you to), write that text to a file and approve it as written with ` +
          `\`${aidlcInvocation()} unit amend ${shellArg(unit)} --input ${shellArg(proposal.input)} --answer approve --file <that file> ` +
          `${unitWordsArg("amend", unit)}\`.`,
      );
    }
    const before = existsSync(path) ? readFileSync(path, "utf-8") : null;
    writeFileSync(path, text, "utf-8");
    renewForAmendedInput(pd, proposal.input, {
      "Proposed By": `${proposal.by} (${live.owner})`, ...(lead.said !== null ? { "Person Words": lead.said } : {}),
    });
    const amendment: Amendment = { input: proposal.input, at: isoTimestamp(), words };
    const readers = unitsHearing(pd, proposal.input, before, text);
    const missed: string[] = [];
    const cached = cachedClaims(pd);
    const leads = leadsOwnClaims(pd, readStateFile(pd), cached);
    for (const [other, claim] of cached) {
      // Only the Units whose stages read it hear it; the proposing team always hears its answer.
      if (claim.status !== "claimed" || leads.has(other) || (other !== unit && !readers.has(other))) continue;
      const sent = amendClaim(pd, remote, claim, amendment, text, other === unit
        ? (payload) => ({ proposals: (payload.proposals ?? []).map((entry) => (entry.input === proposal.input && entry.answer === undefined ? answered : entry)) })
        : undefined);
      if (sent === "missed") missed.push(builderOf(claim));
    }
    lines.unshift(`The ${name} is changed here. The teams building with it hear it once and carry on; nobody approves anything again.`);
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
    lines.push(`Turned down ${builderOf(live)}'s change to the ${name}; they hear it once, with your words.`);
  }
  appendAuditEntry("QUESTION_ANSWERED", {
    Question: `${builderOf(live)} proposes a change to the ${name} for ${unit}`,
    Answer: answer === "approve" ? "Approve it" : "Turn it down",
    // The engine's own question this answers, which the row closes (the ledger's answered).
    [QUESTION_TYPE_FIELD]: "unit-amend",
    ...lead.fields,
  }, pd);
  console.log(JSON.stringify({ answered: answered.answer, unit, notice: lines.join(" ") }));
}

// The home's person turned a Unit's repo down: their words go on the claim,
// and the team hears them, once, at its next step.
// The lead's Build and Test found a Unit a team built wanting: it goes back to
// that team in the failure's words, a turn-down from Build and Test. Its result
// and done come off its claim, and UNIT_SENT_BACK sets aside its earlier merge
// here, so it waits for the team and its next merge is recorded again.
function sendBack(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail(`usage: ${unitUsage("send-back")}`);
  const pd = resolveProjectDir(projectDir);
  // The failure, in the words the agent showed the person, is what the team
  // hears; the lead's own word to send it back goes on the row.
  const failure = personWordsOf(pd, flags);
  const lead = leadsWord(pd, flags, "Sending a Unit back");
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const heard = takeInFirst(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  if (live?.status !== "claimed" || (!live.payload.result && !live.payload.done)) fail(withTakeInLines(pd, heard, `${unit} has no result from a team to send back.`));
  const { done: _done, verdicts: _verdicts, result: _result, ...rest } = live.payload;
  const payload: UnitClaimPayload = {
    ...rest,
    predecessor_oid: live.oid,
    turned_down: { repo: "", words: failure.trim(), at: isoTimestamp(), from: "build-and-test" },
  };
  const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload), live.oid);
  if (!sent.ok) fail(withTakeInLines(pd, heard, `${unit} could not be sent back: ${sent.refused ?? "its claim moved meanwhile"}. Try again.`));
  invalidateLiveClaimPayloadCache(pd, unit);
  appendAuditEntry("UNIT_SENT_BACK", {
    Unit: unit, Owner: live.owner, "Attempt Generation": String(live.generation), ...(failure ? { Failure: failure } : {}),
    ...lead.fields,
  }, pd);
  console.log(JSON.stringify({
    unit,
    notice: withTakeInLines(pd, heard, `Sent ${unit} back to ${builderOf(live)} with your words. It waits for them here; nothing of it is rebuilt here.`),
  }));
}

function turnedDown(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit || !flags.repo) fail(`usage: ${unitUsage("turned-down")}`);
  const pd = resolveProjectDir(projectDir);
  // The team hears the words the agent relays; the lead's typed words, from
  // the message store, stay on the claim beside them, read by no line.
  const words = personWordsOf(pd, flags);
  const said = leadsWord(pd, flags, "A turn-down").said;
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const heard = takeInFirst(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  if (live?.status !== "claimed" || !live.payload.result) fail(withTakeInLines(pd, heard, `${unit} has no result from its team to turn down.`));
  const payload: UnitClaimPayload = {
    ...live.payload,
    predecessor_oid: live.oid,
    turned_down: { repo: flags.repo, words: words.trim(), at: isoTimestamp(), ...(said !== null ? { person_reply: said } : {}) },
  };
  const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload), live.oid);
  if (!sent.ok) fail(withTakeInLines(pd, heard, `The note could not be put on ${unit}'s claim: ${sent.refused ?? "it moved meanwhile"}. Try again.`));
  invalidateLiveClaimPayloadCache(pd, unit);
  console.log(JSON.stringify({ unit, notice: withTakeInLines(pd, heard, `${builderOf(live)} hears that ${flags.repo} was turned down, with your words, at their next step.`) }));
}

// The lead says a repo merged the Unit where the merge check cannot see it (a
// change made again by hand, a branch merged elsewhere): their words go on the
// claim, and the home counts that repo merged at its next step.
function saidMerged(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit || !flags.repo) fail(`usage: ${unitUsage("merged")}`);
  const pd = resolveProjectDir(projectDir);
  // At a team's own build there is no claim of its result to write on: the
  // lead's project checks the repos itself.
  if (unitBuildOf(readStateFile(pd)) !== null) {
    fail(`The lead's project checks at its own next step whether ${unit} merged; a merge it cannot see, the lead counts in ` +
      "their own words there. Nothing needs sending from here.");
  }
  const given = personWordsOf(pd, flags);
  const words = leadsWord(pd, flags, "That it merged").said ?? given;
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const heard = takeInFirst(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  if (live?.status !== "claimed" || !live.payload.result) fail(withTakeInLines(pd, heard, `${unit} has no result from its team to count merged.`));
  if (!live.payload.result.repos.some((repo) => repo.repo === flags.repo)) {
    fail(withTakeInLines(pd, heard, `${unit} changed ${joinNames(live.payload.result.repos.map((repo) => repo.repo))}, not ${flags.repo}.`));
  }
  const payload: UnitClaimPayload = {
    ...live.payload,
    predecessor_oid: live.oid,
    said_merged: [...(live.payload.said_merged ?? []).filter((entry) => entry.repo !== flags.repo), { repo: flags.repo, words, at: isoTimestamp() }],
  };
  const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload), live.oid);
  if (!sent.ok) fail(`${unit}'s claim moved meanwhile: ${sent.refused ?? "try again"}.`);
  invalidateLiveClaimPayloadCache(pd, unit);
  // Recorded now, by the take-in the next step runs, once every repo it
  // changed is merged by the check or by the lead's word.
  const tookIn: string[] = [];
  const checked = checkTeamResults(pd, [], [], [], false, tookIn).get(unit);
  const said = `${flags.repo} counts as merged for ${unit}, in your words.`;
  const notMerged = (checked?.verdicts ?? []).filter((verdict) => !verdict.merged).map((verdict) => verdict.repo);
  const checkIn = tookIn.includes(unit) ? checkInLine(pd) : null;
  const notice = checked?.done
    ? [`${unit} is recorded as merged here.`, checkIn].filter((line) => line !== null).join(" ")
    : notMerged.length > 0
      ? `${said} ${joinNames(notMerged)} ${notMerged.length === 1 ? "has" : "have"} not merged it yet, so nothing is recorded here.`
      : said;
  console.log(JSON.stringify({ unit, notice: withTakeInLines(pd, heard, notice) }));
}

// The lead's repo list at a commit of the lead's workspace, as addresses by
// repo name (workspaceManifestAt's order); empty when there is none or it does not read.
function leadRepoAddresses(projectDir: string, oid: string | null): Map<string, string> {
  const addresses = new Map<string, string>();
  if (!oid) return addresses;
  try {
    const found = workspaceManifestAt((rel) => textAt(projectDir, oid, rel));
    for (const repo of found?.manifest.repos ?? []) {
      const address = workspaceCloneUrl(repo);
      if (address !== null) addresses.set(repo.name, address);
    }
  } catch {
    // A list that does not read offers nothing.
  }
  return addresses;
}

// On Codex, which writes only inside the folder it started in unless the
// person adds others: their own step for the Unit's repos that sit outside
// the workspace (Codex's --add-dir). AI-DLC writes no sandbox setting.
function codexWritableLine(pd: string, repos: string[]): string {
  if (runtimeHarnessName(pd) !== "codex") return "";
  const local = readWorkspaceRepos(pd);
  const outside = repos.filter((repo) => {
    const there = relative(resolve(pd), resolve(repoDir(pd, repo)));
    return there.startsWith("..") || isAbsolute(there);
  }).map((repo) => displayRepoPath(local.entries.get(repo)?.path ?? repo));
  if (outside.length === 0) return "";
  return ` Codex writes only inside this folder unless you start it with the others: to let it write in ${joinNames(outside)}, ` +
    `start Codex here with \`codex ${outside.map((path) => `--add-dir ${shellArg(path)}`).join(" ")}\`.`;
}

// The offer to clone a Unit build's likely repos that this workspace has no
// checkout of and repos.json gives an address for: put by the build's own next
// step, once, so it reaches the person whatever the agent did with the take's
// output. Null when there is none to clone.
export function buildCloneOffer(pd: string, stateContent: string): { question: string; choices: Array<{ label: string; command?: string }> } | null {
  const build = unitBuildOf(stateContent);
  if (build === null) return null;
  // The lead's list: in the lead's copy when it is here, else at the commit the Unit was taken from.
  const takenIn = readAuditShardEvents(pd).findLast((row) => row.event === "UNIT_TAKEN_IN");
  const notThere = likelyReposNotHere(pd, unitLikelyRepos(pd).get(build.unit) ?? [], intentRepos(pd),
    leadRepoAddresses(pd, leadCopyAt(pd, idSuffix(build.homeWork)) ?? (takenIn === undefined ? null : auditBlockField(takenIn.block, "Home Commit") ?? null)));
  return notThere.offer.offer === undefined ? null : { question: notThere.question.trim(), choices: notThere.offer.offer.choices };
}

// The likely repos of a taken Unit that this workspace has no checkout of: a
// line each with the way to one, and, for those repos.json gives an address,
// the offer to clone them where it puts them (add-repo's clone, on their yes).
function likelyReposNotHere(
  pd: string,
  likely: string[],
  recorded: string[],
  // The lead's repo list at the commit the Unit was taken from.
  leadAddresses: Map<string, string> = new Map(),
): { lines: string; question: string; offer: { offer?: { choices: Array<{ label: string; command?: string }> } } } {
  const missing = [...new Set(likely.map((repo) => repo.split("/")[0]))]
    .filter((repo) => recorded.includes(repo) && !isGitRepoDir(repoDir(pd, repo)));
  // Their own paths cannot be read: their copy may be elsewhere, so no clone
  // is offered until the file reads.
  const unreadable = missing.length > 0 ? localUnreadableLine(pd, missing) : null;
  if (unreadable !== null) return { lines: ` ${unreadable}`, question: "", offer: {} };
  const cloneable = missing.filter((repo) => repoCloneable(pd, repo));
  // A repo this workspace's list has no address for, that the lead's has.
  const fromLead = missing.filter((repo) => !cloneable.includes(repo) && leadAddresses.has(repo));
  const leadLine = fromLead.length === 0 ? "" : ` ${joinNames(fromLead.map((repo) => `${repo} is not here yet; the lead's list has it at ` +
    `${maskUserinfo(leadAddresses.get(repo)!)}`))}. Do you want me to clone ${fromLead.length === 1 ? "it" : "them"} here?`;
  return {
    lines: missing.filter((repo) => !cloneable.includes(repo) && !fromLead.includes(repo)).map((repo) => ` ${repoNotThereLine(pd, repo)}`).join("") +
      codexWritableLine(pd, likely.length > 0 ? [...new Set(likely.map((repo) => repo.split("/")[0]))].filter((repo) => recorded.includes(repo)) : recorded),
    question: (cloneable.length > 0 ? ` ${repoCloneOfferLine(pd, cloneable)}` : "") + leadLine,
    offer: cloneable.length === 0 && fromLead.length === 0 ? {} : {
      offer: {
        choices: [
          ...cloneable.map((repo) => ({ label: `Clone ${repo}`, command: `${aidlcToolInvocation("utility")} intent add-repo ${shellArg(repo)}` })),
          ...fromLead.map((repo) => ({
            label: `Clone ${repo}`,
            command: `${aidlcToolInvocation("utility")} intent add-repo ${shellArg(repo)} --url ${shellArg(leadAddresses.get(repo)!)}`,
          })),
          { label: "Not now" },
        ],
      },
    },
  };
}

// --- A second person on solo work -------------------------------------------------
//
// Solo work a teammate took a Unit of from another machine: this home's session
// records the switch to teams at its next step (the teammate's clone never
// writes it), through the ownership and rhythm setters: its remote as the home,
// and the approvals it had (once per Unit at its checkpoint, or after every
// stage). The Units it already built here stay done here. Nothing is asked
// again. The line for the person, or null when nothing switched.
// The stage of a Unit's build a chat last looked at its claim from (the
// workspace's sessions folder), so each new stage looks once.
const BUILD_STAGE_LOOK_FILE = "build-stage-look.json";

function buildStageLooked(projectDir: string, sessionId?: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(sessionsDir(projectDir), BUILD_STAGE_LOOK_FILE), "utf-8")) as Record<string, string>)[sessionId ?? ""] ?? null;
  } catch {
    return null;
  }
}

function noteBuildStageLooked(projectDir: string, sessionId: string | undefined, atStage: string): void {
  if (isReadOnlyEngineProbe()) return;
  const path = join(sessionsDir(projectDir), BUILD_STAGE_LOOK_FILE);
  let marks: Record<string, string> = {};
  try {
    marks = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  } catch {
    // None kept yet.
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify({ ...marks, [sessionId ?? ""]: atStage })}\n`);
  } catch {
    // Unkept: the next step looks again.
  }
}

// The Unit boundary a chat last looked for a teammate's take at, kept in the
// workspace's sessions folder (the look runs before any work is selected).
const SOLO_LOOK_FILE = "solo-take-look.json";

function soloBoundaryLooked(projectDir: string, sessionId?: string): string | null {
  try {
    const marks = JSON.parse(readFileSync(join(sessionsDir(projectDir), SOLO_LOOK_FILE), "utf-8")) as Record<string, string>;
    return marks[sessionId ?? ""] ?? null;
  } catch {
    return null;
  }
}

function noteSoloBoundaryLooked(projectDir: string, sessionId: string | undefined, boundary: string): void {
  if (isReadOnlyEngineProbe()) return;
  const path = join(sessionsDir(projectDir), SOLO_LOOK_FILE);
  let marks: Record<string, string> = {};
  try {
    marks = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  } catch {
    // None kept yet.
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify({ ...marks, [sessionId ?? ""]: boundary })}\n`);
  } catch {
    // Unkept: the next step at this boundary looks again.
  }
}

export function switchSoloToTeams(projectDir: string, sessionId?: string): string | null {
  let state: string;
  try {
    state = readStateFile(projectDir);
  } catch {
    return null;
  }
  if (isTeamUnitOwnership(state) || homeLocation(state) !== null || isReadOnlyEngineProbe()) return null;
  if (getField(state, "Construction Iteration")?.trim() !== "unit-major") return null;
  // Only the machine building the work, or its builder's other machine, is its
  // home: a teammate's clone (their second one too) never switches the work.
  const elsewhere = builtFromAnotherMachine(state, readAuditShardEvents(projectDir), auditShardName(projectDir));
  if (elsewhere !== null && !lastCommittedByThisPerson(projectDir, elsewhere.shard)) return null;
  // A teammate's take changes what this session does next once its Unit walk
  // has begun (or its first Unit is next): the claims are looked at once when
  // a chat starts and before each next Unit starts, never after each message
  // inside a Unit and never at an Inception step.
  // A boundary (the Units done so far) is looked at once in a chat, however
  // many steps it takes, and once every Unit of the plan is built here nothing
  // is left for a teammate to take, so no step looks.
  const remote = repositoryRemote(projectDir);
  const stages = unitMajorConstructionStageSlugs(getField(state, "Scope") ?? "", state, true);
  const progress = soloUnitsProgress(readAuditShardEvents(projectDir), stages.at(-1) ?? "code-generation");
  let planUnits: string[] = [];
  try {
    const dag = resolveBoltDag(projectDir);
    planUnits = dag.state === "ok" ? dag.units : [];
  } catch {
    planUnits = [];
  }
  const allBuilt = planUnits.length > 0 && planUnits.every((unit) => progress.done.has(unit));
  if (remote !== null && !allBuilt && (progress.started.size > 0 || stages.includes(getField(state, "Current Stage")?.trim() ?? ""))) {
    const between = progress.started.size > 0 && [...progress.started].every((unit) => progress.done.has(unit));
    const boundary = [...progress.done].sort().join(",");
    const fresh = between && soloBoundaryLooked(projectDir, sessionId) !== boundary;
    refreshHomeClaims(projectDir, { home: { target: remote, id8: activeIdentity(projectDir).intentId8 }, sessionId, now: fresh });
    if (fresh) noteSoloBoundaryLooked(projectDir, sessionId, boundary);
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
  // The lead's sign-off is theirs to ask for; the line says so once, and the
  // step that carries the line carries its setter (SIGN_OFF_CLAUSE), never only the board.
  const signOff = leadSignOffOn(readStateFile(projectDir)) ? "" : `, ${SIGN_OFF_CLAUSE}`;
  return `Your teammate ${who} took ${units}; this session carries on with the rest, one Unit at a time${signOff}.`;
}

// --- The lead's sign-off ------------------------------------------------------------
//
// Off by default, switched on per piece of work at the home: a team's result
// then waits for the lead's own word before the Unit counts as done.
export const LEAD_SIGNOFF_FIELD = "Lead Sign-off";

export function leadSignOffOn(stateContent: string | null): boolean {
  return getField(stateContent ?? "", LEAD_SIGNOFF_FIELD)?.trim() === "on";
}

// `aidlc unit lead-here`: the person's own word that they lead this work, in
// a checkout that did not make its plan (the lead on another machine). It is
// recorded with their words in this checkout's own audit, and from then on the
// lead's own questions are put here (planMadeElsewhere reads it); a teammate
// never says it, so the lead's questions never reach their clone.
function leadHere(args: string[], projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state) || homeLocation(state) === null || unitBuildOf(state) !== null) {
    fail("lead-here is for the lead's work built by teams, selected in this checkout.");
  }
  const lead = leadsWord(pd, parseArgs(args).flags, "Carrying this work on here as its lead");
  appendAuditEntry("LEAD_HERE_SET", { ...(lead.said !== null ? { "Person Words": lead.said } : {}), ...lead.fields }, pd);
  console.log(JSON.stringify({ lead_here: true, notice: "This checkout carries the work on as yours, the lead's, from here." }));
}

function leadSignOffSetting(args: string[], projectDir?: string): void {
  const value = args[0];
  if (value !== "on" && value !== "off") fail(`usage: ${unitUsage("lead-sign-off")}`);
  const pd = resolveProjectDir(projectDir);
  if (!isTeamUnitOwnership(readStateFile(pd))) fail("The lead's sign-off is for work that teams build.");
  // The lead's own words for it, recorded whole beside the setting.
  const words = personWordsOf(pd, parseArgs(args.slice(1)).flags);
  withAuditLock(pd, () => {
    writeStateFile(pd, setOrInsertField(readStateFile(pd), "## Runtime State", LEAD_SIGNOFF_FIELD, value));
    appendAuditEntryUnlocked("LEAD_SIGN_OFF_SET", { Mode: value, ...(words ? { "Person Words": words } : {}) }, pd);
  });
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
  if (!unit) fail(`usage: ${unitUsage("sign-off")}`);
  const pd = resolveProjectDir(projectDir);
  const given = personWordsOf(pd, flags);
  const identity = activeIdentity(pd);
  const remote = repositoryRemote(pd);
  const heard = takeInFirst(pd);
  const live = currentClaim(pd, remote, claimRef(identity.intentId8, unit));
  if (live?.status !== "claimed" || !live.payload.result) fail(withTakeInLines(pd, heard, `${unit} has no result from its team to sign off.`));
  const lead = leadsWord(pd, flags, "The sign-off", "unit-signoff");
  const words = lead.said ?? given;
  const payload: UnitClaimPayload = { ...live.payload, predecessor_oid: live.oid, signoff: { words, at: isoTimestamp() } };
  const sent = updateClaimRef(pd, remote, live.ref, createClaimCommit(pd, live.oid, payload), live.oid);
  if (!sent.ok) fail(`${unit}'s claim moved meanwhile: ${sent.refused ?? "try again"}.`);
  invalidateLiveClaimPayloadCache(pd, unit);
  appendAuditEntry("QUESTION_ANSWERED", {
    Question: `Sign off ${unit} from ${builderOf(live)}`, Answer: "Sign it off", [QUESTION_TYPE_FIELD]: "unit-signoff", ...lead.fields,
  }, pd);
  const merged = (live.payload.verdicts ?? []).length > 0 && live.payload.verdicts!.every((verdict) => verdict.merged);
  console.log(JSON.stringify({
    unit,
    notice: withTakeInLines(pd, heard, merged
      ? `Signed off ${unit}; every repo it changed has merged, so it is done.`
      : `Signed off ${unit}; it counts as done once every repo it changed has merged.`),
  }));
}

function participate(projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  writeFileSync(unitParticipantPath(pd), "participant\n", "utf-8");
  console.log(JSON.stringify({ participant: true }));
}

// The command a person types for a Unit verb, as its usage shows it.
function unitUsage(verb: string): string {
  return `${aidlcInvocation()} ${UNIT_GRAMMAR[verb].usage}`;
}

// A Unit command's words, read as its verb reads them (parseArgs) before
// anything is read or written: `--help` or `-h` prints the verb's usage, and a
// word the verb does not take is named with that usage, so a request to read
// the usage never commits, pushes or claims. `-h` as an option's value stays
// that option's. A switch takes no value, so each is read here as `--x=true`
// and the word after it stays a word: `-h` after `--commit` is still the
// request for the usage. Every verb also takes --project-dir and the launcher's
// own flags, switches the dispatcher hands on after the words.
function checkUnitWords(verb: string, args: readonly string[]): void {
  if (!Object.hasOwn(UNIT_GRAMMAR, verb)) return;
  const grammar = UNIT_GRAMMAR[verb];
  const switches = new Set([...(grammar.switches ?? []), ...[...LAUNCHER_GLOBAL_FLAGS].map((flag) => flag.slice(2)), "help"]);
  const end = args.indexOf("--");
  const { positional, flags } = parseArgs(args.map((token, index) =>
    (end < 0 || index < end) && token.startsWith("--") && switches.has(token.slice(2)) ? `${token}=true` : token
  ));
  if (Object.hasOwn(flags, "help") || positional.includes("-h")) printUsageAndExit(`usage: ${unitUsage(verb)}`);
  const option = Object.keys(flags).find((key) =>
    key !== "project-dir" && !grammar.options.includes(key) && !switches.has(key)
  );
  // Past the one word it takes (the Unit's name, or its own word), no word is the verb's.
  const extra = positional[grammar.name || grammar.word !== undefined ? 1 : 0];
  if (option === undefined && extra === undefined) return;
  const word = option !== undefined ? `--${option}` : JSON.stringify(extra);
  console.error(JSON.stringify({ error: `unit ${verb} does not take ${word}`, usage: unitUsage(verb) }));
  process.exit(2);
}

let projectDir: string | undefined;

// The verbs that end the wait on the teams (main).
const UNIT_LEAD_WAIT_ENDS = new Set(["assign", "merged", "sign-off", "release", "lead-here"]);

export function main(argv: string[]): void {
  const args = [...argv];
  const projectIdx = args.indexOf("--project-dir");
  if (projectIdx !== -1 && projectIdx + 1 < args.length) {
    projectDir = args[projectIdx + 1];
    args.splice(projectIdx, 2);
  }
  const command = args.shift();
  if (command !== undefined) checkUnitWords(command, args);
  // A turn Claude Code started itself is settled before this command reads a turn.
  settleClaudeTurnsFirst(resolveProjectDir(projectDirFlag(argv)));
  // What can give the lead's project a Unit to build, or count one merged, ends
  // the wait the last board recorded: the next `next` decides it again.
  if (command !== undefined && UNIT_LEAD_WAIT_ENDS.has(command)) {
    clearLeadWaitsOnTeams(resolveProjectDir(projectDirFlag(argv)));
  }
  try {
    if (command === "assign") assignUnits(args, projectDir);
    else if (command === "take") takeUnit(args, projectDir);
    else if (command === "push") pushUnit(args, projectDir);
    else if (command === "propose") proposeChange(args, projectDir);
    else if (command === "rebase") rebaseUnit(args, projectDir);
    else if (command === "amend") amendInput(args, projectDir);
    else if (command === "lead-sign-off") leadSignOffSetting(args, projectDir);
    else if (command === "lead-here") leadHere(args, projectDir);
    else if (command === "sign-off") signOff(args, projectDir);
    else if (command === "turned-down") turnedDown(args, projectDir);
    else if (command === "send-back") sendBack(args, projectDir);
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
      if (!unit) fail(`usage: ${unitUsage("merge-status")}`);
      console.log(JSON.stringify(
        readUnitMergeTransaction(resolveProjectDir(projectDir), unit),
        null,
        2,
      ));
    }
    else if (command === "status") {
      console.log(JSON.stringify(unitClaimOverview(resolveProjectDir(projectDir)), null, 2));
    } else {
      fail(`Usage: aidlc-unit <${[...UNIT_VERBS.keys()].join("|")}> ...`);
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
