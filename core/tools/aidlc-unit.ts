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
  rmdirSync,
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
  auditFilePath,
  auditShardBlocks,
  auditShardName,
  knownAuditShardName,
  type ActiveDirectiveMarker,
  type AuditShardEvent,
  type CachedUnitClaim,
  candidateReviewCoverageProjection,
  clearClaimGeneration,
  clearEngineAskMark,
  clearUnitScopeStamp,
  committedTextBytes,
  folderRepoName,
  UNIT_GATE_RHYTHM_FIELD,
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
  readActiveDirectiveMarker,
  parseArgs,
  namesSourceCheckout,
  printUsageAndExit,
  recordDir,
  removeRecordFileNoFollow,
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
  rowsAfterMark,
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
  discoverSiblingRepos,
  setField,
  slugify,
  sourceClaimCovers,
  sourcePathKey,
  sortAttemptEvents,
  type SourceClaimModel,
  workspaceSourceListing,
  type WorkspaceSourceListing,
  isValidRepoName,
  validGitRefName,
} from "./aidlc-lib.js";
import { classifyStateVersion, newerPlanStep, newerRecordStep, newerStateRelease, newerStateStep, recordHomeLocation, TEAM_STATE_VERSION } from "./aidlc-state-upgrade.ts";
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
  unitBuildsHere,
  homeLocation,
  claimsOnBranches,
  claimsOnBranchesFor,
  inputName,
  LEAD_RULES_FIELD,
  leadRules as leadRulesOf,
  SIGN_OFF_CLAUSE,
  lastCommittedByThisPerson,
  patchIdOf,
  type Proposal,
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
  type MergeVerdict,
  resultAtTip,
  mergeCandidate,
  pullRequestHeadRefs,
  unitMergesStanding,
  unitOutputsHomeReads,
  type UnitResult,
  workspaceHomeLocation,
  unitsStartedAtLeadsProject,
  unitsAskedHere,
  unitWriteTargets,
  outputForLead,
  unitWordsArg,
  unitWordsFile,
  RECORD_COMMIT_MESSAGE,
  builderOf,
  spaceWords,
  clearLeadWaitsOnTeams,
  findUnitBuildOfWork,
  isGitAddress,
  leadWorkHere,
  takenFromPlan,
  textAt,
  headInByContent,
  levelByContent,
  type LevelBlock,
  unitDependencies,
  copyOf,
  repoCopyKey,
  type PlanJson,
  type PlanPointer,
  planCommitOf,
  PLAN_FORMAT,
  PLAN_SETTINGS,
  planJsonOf,
  soleRemote,
} from "./aidlc-unit-teams.js";
import { gitOperationUnderWay, rebaseUnderWay, recordChanged, recordCommitBlock, recordPaths, submoduleLeavesProjectRepo } from "./aidlc-git.ts";
import { ownFilesToCommit } from "./aidlc-brought-files.ts";
import { commitOwnCommand, displayRepoPath, leftFilesNamed, UPDATE_COMMIT_MESSAGE, UPDATE_MESSAGE_KEY, reposManifestPath, localUnreadableLine, readWorkspaceRepos, repoCloneable, repoCloneOfferLine, repoNotThereLine, withoutCredentials, workspaceManifestAt } from "./aidlc-workspace-manifest.js";
import { maskUserinfo, workspaceCloneUrl } from "./aidlc-workspace-sync.ts";
import { gitAddressKey } from "./aidlc-workspace-repos.ts";
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
import { planMadeElsewhere, spacesRoot, stateFilePath } from "./aidlc-record-core.ts";
import { approvalDecidesOpenFindings, approvalOpenFindings } from "./aidlc-review-brief.ts";
import {
  aidlcEngineCommand,
  aidlcInvocation,
  aidlcToolInvocation,
  entrySkillInvocation,
  isCompiledExecutable,
  quoteCommandArgument,
  runtimeHarnessName,
  shellSingleQuote,
  WORKSPACE_ENGINE_DIR,
} from "./aidlc-runtime-paths.ts";
import { readRequestFile } from "./aidlc-log.ts";
import { withoutLearnedDate } from "./aidlc-learned-date.ts";
import {
  CLAIM_FILE,
  CLAIM_REF_FOLDERS,
  claimBlobAt,
  claimBranchRef,
  claimCopies,
  claimCopyOf,
  claimHere,
  claimPlaces,
  claimPrefixOf,
  claimRecordRef,
  claimsOnRemote,
  isClaimTreeFile,
  leadsPlanNotHere,
  PLAN_BRANCH,
  homeCopyOf,
  planRecordRef,
  saidPlans,
  writeSaidPlans,
  readClaimAt,
  RECORD_FILE,
  unitResultRootOf,
} from "./aidlc-unit-holders.ts";

const ZERO_OID = "0000000000000000000000000000000000000000";

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

interface GitBytesResult {
  // It ran out of its quiet time limit (no words of git's then).
  timedOut?: boolean;
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
// The command-scope settings a target homeTarget gave needs on every git call
// that names it: a clone's sign-in, which never goes on git's command line.
const targetEnv = new Map<string, NodeJS.ProcessEnv>();

function gitBytes(projectDir: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): GitBytesResult {
  const named = targetEnv.size === 0 ? undefined : args.find((arg) => targetEnv.has(arg));
  const result = spawnSync("git", args, {
    cwd: projectDir,
    env: { ...process.env, ...(quiet ? quietEnv(projectDir) : {}), ...(named === undefined ? {} : targetEnv.get(named)), ...env },
    maxBuffer: 512 * 1024 * 1024,
    // A quiet call is a process group of its own, so its time limit ends git's transport (ssh, the http helper) too.
    ...(quiet
      ? { timeout: quietLimitMs ?? (args[0] === "ls-remote" ? QUIET_READ_TIMEOUT_MS : QUIET_WRITE_CEILING_MS), detached: process.platform !== "win32" }
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
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
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
  input?: string,
): GitResult {
  return git(projectDir, args, {
    GIT_NO_LAZY_FETCH: "1",
    ...env,
  }, input);
}

function fail(message: string): never {
  throw new Error(message);
}

// Work a newer AI-DLC wrote is never claimed or released from here: the person
// hears the step that carries it on (newerStateStep), before anything is written.
function refuseNewerWork(projectDir: string, state: string): void {
  const verdict = classifyStateVersion(state);
  if (verdict.kind === "future") fail(newerStateStep(projectDir, verdict.version));
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
  // The pull requests the lead named as the Unit's build (in a view only, never a record's).
  pull_requests?: NamedPullRequest[];
  // The lead opened this take again, on the plan (in a view only, never a record's).
  open_again?: { at: string };
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
const CHANGES_REACH_FIELD = "Changes reach main";
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

// The value a team wrote down on its own `<field>: <value>` line under
// "## Way of Working", narrowest layer first; only that line is read, never the
// prose around it. `readWords` is the Integration branch's walk: a sentence
// naming the repos beside the branch once gave a repo's name, so a layer whose
// section has words but no line stops the walk there until the agent has read
// them: they may name the team's branch, so it records the line, or that they
// name none, first; never a broader layer's line or `main` in its place (an
// update must not move a team whose team.md says `develop` in a sentence). A
// layer with no words (the shipped comment-only files), or words read as naming
// none, is passed. Without `readWords`, words with no line are no line. Nothing
// is checked here, so the share offers can ask without a refusal.
function wayOfWorkingLayer(
  projectDir: string,
  field: string,
  readWords: boolean,
  space = activeSpace(projectDir),
  // A layer's Way of Working words in place of its file's: a draft about to be promoted there.
  sections: Partial<Record<(typeof MEMORY_LAYERS)[number], string>> = {},
): { value: string; source: string } | { toRead: string } | null {
  let branchFree: Record<string, string> | undefined;
  for (const name of MEMORY_LAYERS) {
    const source = memoryLayerSource(projectDir, name, space);
    let section = sections[name];
    if (section === undefined) {
      try {
        section = memorySectionBody(readFileSync(join(projectDir, ...source.split("/")), "utf-8"), WAY_OF_WORKING);
      } catch {
        continue;
      }
    }
    const value = structuredField(section, field);
    if (value !== null) return { value, source };
    if (!readWords || section.trim() === "") continue;
    branchFree ??= branchFreeWords(projectDir);
    if (branchFree[source] !== wordsKey(section)) return { toRead: source };
  }
  return null;
}

function integrationBranchLayer(
  projectDir: string,
  space = activeSpace(projectDir),
  sections: Partial<Record<(typeof MEMORY_LAYERS)[number], string>> = {},
): { value: string; source: string } | { toRead: string } | null {
  return wayOfWorkingLayer(projectDir, INTEGRATION_BRANCH_FIELD, true, space, sections);
}

// How the team's changes reach the branch on its Integration branch line, from
// the narrowest layer's own `Changes reach main:` line: by pull request (GitLab's
// "by merge request" too) or by direct push. With no such line anywhere it is
// by pull request, the default org.md's own line says, so a project whose
// org.md is older reads it too. A line with another value is the team's own
// way, which no tool reads: null, and the share question marks neither choice.
export function changesReachMain(projectDir: string): "pull request" | "direct push" | null {
  let layer: ReturnType<typeof wayOfWorkingLayer>;
  try {
    layer = wayOfWorkingLayer(projectDir, CHANGES_REACH_FIELD, false);
  } catch {
    layer = null;
  }
  if (layer === null || !("value" in layer)) return "pull request";
  const way = integrationBranchName(layer.value).toLowerCase();
  if (way === "by pull request" || way === "by merge request") return "pull request";
  return way === "by direct push" ? "direct push" : null;
}

// The layer whose Way of Working words are still to be read, or null.
export function integrationBranchToRead(projectDir: string, space = activeSpace(projectDir)): string | null {
  const layer = integrationBranchLayer(projectDir, space);
  return layer !== null && "toRead" in layer ? layer.toRead : null;
}

// The branch Approve at Practices Discovery names for AI-DLC's records and
// plan, read from the draft's Way of Working (the section practices-promote
// copies into team.md) through the one reader, with the branch git says this
// checkout is on, when the two differ: the gate says so. Only where the work's
// code is in repos of its own (intentRepos), so this project's repo
// holds nothing but those records. Null when the draft names none, a narrower
// layer decides, git names no branch here (a detached HEAD), or anything
// cannot be read. It says a fact and decides nothing: where the share may run
// is shareRefusal's.
export function practicesBranchOffCheckout(projectDir: string, draft: string): { branch: string; current: string } | null {
  try {
    if (intentRepos(projectDir).length === 0 || workspaceHomeLocation(projectDir) === null) return null;
    const section = memorySectionBody(draft, WAY_OF_WORKING);
    if (section.trim() === "") return null;
    const space = activeSpace(projectDir);
    const layer = integrationBranchLayer(projectDir, space, { "team.md": section });
    if (layer === null || "toRead" in layer || layer.source !== memoryLayerSource(projectDir, "team.md", space)) return null;
    const branch = integrationBranchName(layer.value);
    const shown = git(projectDir, ["branch", "--show-current"]);
    const current = shown.ok ? shown.stdout.trim() : "";
    return current === "" || current === branch ? null : { branch, current };
  } catch {
    return null;
  }
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
// wrap the name in a code span, which is Markdown, not the name (`dev`.); the
// Changes reach main line's value is cleaned the same way.
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

// A Unit's claim as the build-out keeps it, a record (aidlc-unit-holders.ts);
// main's flow's own steps name its claim branch (claimBranchRef), and a step
// that serves both takes the work's recorded flow (claimRefFor).
function claimRef(intentId8: string, unit: string): string {
  return claimRecordRef(intentId8, unit);
}

function claimRefFor(state: string | null, intentId8: string, unit: string): string {
  return claimsOnBranches(state) ? claimBranchRef(intentId8, unit) : claimRecordRef(intentId8, unit);
}

// The active work's state, or null where none is read.
function stateHere(projectDir: string): string | null {
  try {
    return readStateFile(projectDir);
  } catch {
    return null;
  }
}

// Main's flow's claim branches, fetched through the workspace's remote.
function fetchClaimRefs(projectDir: string, remote: string | null): void {
  if (!remote) return;
  const fetched = git(projectDir, [
    "fetch",
    "--no-filter",
    remote,
    `+${claimsOnRemote(true)}*:${claimCopyOf(remote, claimsOnRemote(true))}*`,
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
): UnitClaimPayload | null {
  const shown = readClaimAt(projectDir, oid, claimPrefixOf(projectDir));
  if (!shown) return null;
  try {
    const parsed = JSON.parse(shown.text) as UnitClaimPayload;
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
  const payloadBlob = (): string | null =>
    claimBlobAt(projectDir, oid, claimPrefixOf(projectDir))?.blob ?? null;
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
  const payload = readPayload(projectDir, oid);
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
// `content` and each of `dropped` left out, via a scratch index so the real
// worktree/index is untouched. Paths are from the repository's top.
function writeTreeWithBlob(
  projectDir: string,
  baseTreeOid: string,
  path: string,
  content: string,
  dropped: string[] = [],
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
    if (dropped.length > 0) {
      // Mode 0 removes an entry, and a path the index lacks is a no-op.
      const zero = "0".repeat((blob.stdout ?? "").trim().length);
      const removed = git(
        projectDir,
        ["update-index", "--index-info"],
        env,
        dropped.map((gone) => `0 ${zero}\t${gone}\n`).join(""),
      );
      if (!removed.ok) fail(`git update-index failed: ${removed.stderr.trim()}`);
    }
    const tree = git(projectDir, ["write-tree"], env);
    if (!tree.ok) fail(`git write-tree failed: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A claim keeps the place its file started in, so a team whose members run
// different releases works one claim: the place in the claim commit it builds
// on, when that is a claim of the same Unit of the intent. A claim that starts
// here (built on the integration branch) takes the last place, which every
// release reads.
function claimPlaceFor(
  projectDir: string,
  parentOid: string,
  payload: UnitClaimPayload,
): string {
  const prefix = claimPrefixOf(projectDir);
  const parent = readClaimAt(projectDir, parentOid, prefix);
  if (parent) {
    try {
      const read = JSON.parse(parent.text) as Partial<UnitClaimPayload>;
      if (read.unit === payload.unit && read.intent_uuid === payload.intent_uuid) return parent.place;
    } catch {
      // Not a claim: the place a claim starts in.
    }
  }
  return claimPlaces(prefix).at(-1) as string;
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
  const place = claimPlaceFor(projectDir, parentOid, payload);
  let tree = writeTreeWithBlob(
    projectDir,
    sourceTreeOid ?? parentOid,
    place,
    `${JSON.stringify(payload, null, 2)}\n`,
    claimPlaces(claimPrefixOf(projectDir)).filter((other) => other !== place),
  );
  // More files for the tree, each written over the last (a Unit result's outputs).
  for (const [path, text] of Object.entries(files)) tree = writeTreeWithBlob(projectDir, tree, path, text);
  return commitAsPerson(
    projectDir,
    tree,
    [parentOid, ...(additionalParentOid ? [additionalParentOid] : [])],
    unitCommitSubject(payload.status, `${payload.unit} generation ${payload.generation}`),
  );
}

// The subject of a commit on a Unit's claim or its record, "aidlc unit <x>:
// <what>", written in one place: it names the commit, never a command to run.
function unitCommitSubject(head: string, what: string): string {
  return `aidlc unit ${head}: ${what}`;
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

// The host's own words in what git printed for a push: its `remote:` lines,
// the prefix and git's padding off, in the paragraphs its blank lines make.
// None of git's own lines. The one reader of them, for a refusal and for a
// push that went through.
function hostParagraphs(stderr: string): string[][] {
  const paragraphs: string[][] = [[]];
  for (const line of stderr.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("remote:")) continue;
    const said = trimmed.slice("remote:".length).trim();
    if (said === "") paragraphs.push([]);
    else paragraphs[paragraphs.length - 1].push(said);
  }
  return paragraphs.filter((paragraph) => paragraph.length > 0);
}

// An address, by its syntax: a token that starts http:// or https://.
const HOST_ADDRESS = /^https?:\/\/\S/;
const endsInAddress = (text: string): boolean => HOST_ADDRESS.test(text.split(/\s+/).at(-1) ?? "");

// Words for the person, in order: what follows an address starts on a new line,
// so no word or full stop is taken as part of the link; else one space.
function joinSaid(parts: readonly string[]): string {
  return parts.filter((part) => part !== "")
    .reduce((text, part) => (text === "" ? part : `${text}${endsInAddress(text) ? "\n" : " "}${part}`), "");
}

// What the host said about the branch a push sent, as it printed it: each
// paragraph that holds an address and names the branch on its own, such as
// GitHub's "Create a pull request for '<branch>' on GitHub by visiting:" or
// GitLab's "To create a merge request for <branch>, visit:" with its link,
// never a notice about the whole repo (an alert, a moved repo) or progress.
// Exact structure only: an address's syntax, and the name git was given
// matched as written (never a pattern made from it: git takes `c++`), not
// inside a longer name or a path. A paragraph ending in words ends with a stop.
function hostLinkWords(stderr: string, branch: string): string {
  const inName = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_/-]/.test(char);
  const namesBranch = (text: string): boolean => {
    if (branch === "") return false;
    for (let at = text.indexOf(branch); at !== -1; at = text.indexOf(branch, at + 1)) {
      const before = text[at - 1];
      const after = text[at + branch.length];
      if (inName(before) || before === ".") continue;
      if (inName(after) || (after === "." && /[A-Za-z0-9]/.test(text[at + branch.length + 1] ?? ""))) continue;
      return true;
    }
    return false;
  };
  return joinSaid(hostParagraphs(stderr)
    .map((paragraph) => paragraph.join(" "))
    .filter((text) => text.split(/\s+/).some((token) => HOST_ADDRESS.test(token)) && namesBranch(text))
    .map((text) => (endsInAddress(text) || /[.!?]$/.test(text) ? text : `${text}.`)));
}

// The push line's words for what a repo's host said: the one place they are
// made. No repo name when the push went to one repo.
function hostSaysLine(repo: string | null, words: string): string {
  return `${repo === null ? "Its" : `${repo}'s`} host says: ${words}`;
}

// What the remote said when it refused a push: its own `remote:` lines, then
// git's reason in parentheses; the whole stderr when it printed neither.
function pushRefusal(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const remoteSaid = hostParagraphs(stderr).flat();
  const reason = lines
    .map((line) => /\[(?:remote )?rejected\][^(]*\(([^)]+)\)/.exec(line)?.[1])
    .find(Boolean);
  const parts = [...remoteSaid, ...(reason ? [`(${reason})`] : [])];
  return (parts.length > 0 ? parts : lines).join(" ");
}

// The compare-and-swap: ok when the ref moved from expectedOid to commitOid.
// A stale lease, or a ref the remote could not lock because another push got
// there first, is another claimant winning; any other push failure is the
// remote refusing the commit, and `refused` carries its reason for the person,
// with `byRule` when that is a rule of the remote's own (refusedByHostRule).
const CLAIM_RACE_LOST = /stale info|failed to update ref|cannot lock ref/;
// A ref the remote's own rule refused (its hook, a ruleset, a protected
// branch): git's per-ref status "[remote rejected]", git's own words on every
// host and in every language, and no race lost. Sending it again meets the
// same rule until the remote's owner changes it.
function refusedByHostRule(stderr: string): boolean {
  return /\[remote rejected\]/.test(stderr) && !CLAIM_RACE_LOST.test(stderr);
}
function updateClaimRef(
  projectDir: string,
  remote: string | null,
  ref: string,
  commitOid: string,
  expectedOid: string | null,
): { ok: boolean; refused?: string; byRule?: true; to?: string } {
  if (remote) {
    const lease = `--force-with-lease=${ref}:${expectedOid ?? ""}`;
    const pushed = git(projectDir, ["push", remote, lease, `${commitOid}:${ref}`]);
    // Where git sent it: its own "To <address>" line.
    const to = /^To (\S.*)$/m.exec(pushed.stderr)?.[1]?.trim();
    const at = to === undefined ? {} : { to };
    if (pushed.ok) return { ok: true, ...at };
    if (CLAIM_RACE_LOST.test(pushed.stderr)) return { ok: false, ...at };
    return { ok: false, refused: pushRefusal(pushed.stderr), ...(refusedByHostRule(pushed.stderr) ? { byRule: true as const } : {}), ...at };
  }
  const updated = git(projectDir, [
    "update-ref",
    ref,
    commitOid,
    expectedOid ?? ZERO_OID,
  ]);
  return { ok: updated.ok };
}

// --- A Unit's record, where the Unit's code goes ---------------------------
//
// The build-out keeps each Unit's record (claimRecordRef) in the repository
// the shared plan names for that Unit, a ref of AI-DLC's own whose commits hold
// only unit.json, the Unit's outputs under result/ and the team's proposed
// texts under proposals/, with no history but the record's own. Only its
// builder writes it, from the workspace's own repository by the record
// repository's address, so nothing of AI-DLC's goes into a code clone and no
// code clone's hook runs for it. Main's own team flow keeps its claim branches
// and createClaimCommit.

const RECORD_RESULT = "result/";
const RECORD_PROPOSALS = "proposals/";

// The keys a record's unit.json holds: the builder's side of a Unit. A view
// carries the lead's word too (from the plan), which never goes into a record.
const RECORD_KEYS = [
  "version", "status", "unit", "intent_uuid", "owner", "taken_by", "generation", "nonce",
  "base_oid", "integration_ref", "predecessor_oid", "early_on", "result", "proposals",
] as const;

const OID = /^[0-9a-f]{40}$/;

// A record-relative path a record may name: no climb, no absolute path, no
// backslash, so a record pushed by anyone with push access names nothing
// outside the work's record.
function recordRelativePath(path: unknown): path is string {
  return typeof path === "string" && path !== "" && !path.startsWith("/") && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

// A repository a record names, as the tools may act on it: "." or a repo
// name (never a path out of the project), a plain branch name, and commits by
// their full id only.
function recordRepoAt(repo: unknown, heads: unknown): boolean {
  if (repo === null || typeof repo !== "object") return false;
  const { repo: name, branch } = repo as { repo?: unknown; branch?: unknown };
  return typeof name === "string" && (name === "." || isValidRepoName(name)) &&
    typeof branch === "string" && !branch.startsWith("-") && validGitRefName(`refs/heads/${branch}`) &&
    Array.isArray(heads) && heads.every((head) => OID.test(String(head)));
}

// A commit's payload in either flow, for a walk back through its own history:
// main's claim file, else a build-out record's unit.json.
function payloadAt(projectDir: string, oid: string): UnitClaimPayload | null {
  return readPayload(projectDir, oid) ?? recordPayloadAt(projectDir, oid);
}

// integration_ref as AI-DLC writes it: a branch here, a remote's branch, or
// this workspace's copy of the plan. A record is written by anyone who can push
// to its repository, so any other value reads as none, and takeIntegrationRef
// then gives way to the plan's branch.
function recordIntegrationRef(value: unknown): string {
  if (typeof value !== "string") return "";
  const plain = (name: string): boolean => name !== "" && !name.startsWith("-") && validGitRefName(`refs/heads/${name}`);
  const branch = /^refs\/heads\/(.+)$/.exec(value);
  if (branch !== null) return plain(branch[1]) ? value : "";
  const tracking = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(value);
  if (tracking !== null) return plain(tracking[1]) && plain(tracking[2]) ? value : "";
  return homeCopyOf(value)?.kind === "plan" ? value : "";
}

// The payload a record commit's unit.json holds, read with no check of the
// work it is for (a walk back through the record's own history reads it so);
// null when the commit holds no record this release reads.
function recordPayloadAt(projectDir: string, oid: string): UnitClaimPayload | null {
  const shown = localGit(projectDir, ["show", `${oid}:${RECORD_FILE}`, "--"]);
  if (!shown.ok) return null;
  let read: Record<string, unknown>;
  try {
    read = JSON.parse(shown.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (read === null || typeof read !== "object" || read.version !== 1 ||
    (read.status !== "claimed" && read.status !== "released") || typeof read.unit !== "string" ||
    typeof read.intent_uuid !== "string" || typeof read.owner !== "string" || typeof read.nonce !== "string" ||
    !Number.isInteger(read.generation) || (read.generation as number) < 1 ||
    (read.predecessor_oid !== null && !OID.test(String(read.predecessor_oid)))) {
    return null;
  }
  const result = read.result as UnitResult | undefined;
  const proposals = Array.isArray(read.proposals) ? read.proposals as Proposal[] : undefined;
  const earlyOn = Array.isArray(read.early_on) ? (read.early_on as unknown[]).flatMap((dep) => {
    const { unit, repos } = (dep ?? {}) as { unit?: unknown; repos?: unknown };
    if (typeof unit !== "string" || !Array.isArray(repos)) return [];
    return [{ unit, repos: repos.filter((repo) => recordRepoAt(repo, (repo as { head?: unknown } | null)?.head === "" ? [] : [(repo as { head?: unknown }).head])) }];
  }) as UnitClaimPayload["early_on"] : undefined;
  return {
    version: 1,
    status: read.status,
    owner: read.owner,
    space: "",
    intent_uuid: read.intent_uuid,
    intent_id8: idSuffix(read.intent_uuid),
    unit: read.unit,
    generation: read.generation as number,
    nonce: read.nonce,
    base_oid: typeof read.base_oid === "string" ? read.base_oid : "",
    integration_ref: recordIntegrationRef(read.integration_ref),
    claim_ref: claimRecordRef(idSuffix(read.intent_uuid), read.unit),
    predecessor_oid: (read.predecessor_oid as string | null) ?? null,
    gate_rhythm: "per-stage",
    ...(typeof read.taken_by === "string" ? { taken_by: read.taken_by } : {}),
    ...(earlyOn !== undefined ? { early_on: earlyOn } : {}),
    // A pushed repository's address is read only where it is a git address git
    // would not take as an option, with no sign-in in it.
    ...(result !== undefined && result !== null && typeof result === "object" && Array.isArray(result.repos) ? {
      result: {
        ...result,
        repos: (result.repos as unknown[]).filter((repo) => recordRepoAt(repo, (repo as { heads?: unknown } | null)?.heads) &&
          ((repo as RepoResult).base === "" || OID.test(String((repo as RepoResult).base))))
          .map((repo) => {
            const { address, ...rest } = repo as RepoResult & { address?: unknown };
            return typeof address === "string" && isGitAddress(address) && !address.startsWith("-") ? { ...rest, address: withoutCredentials(address) } : rest;
          }),
        outputs: Array.isArray(result.outputs) ? result.outputs.filter(recordRelativePath) : [],
      },
    } : {}),
    // The lead's answer is never a record's; a proposal names a path inside the work's record only.
    ...(proposals !== undefined ? {
      proposals: proposals.filter((entry) => recordRelativePath(entry?.input))
        .map(({ input, by, words, at }) => ({ input, by, words, at })),
    } : {}),
  } as UnitClaimPayload;
}

// Where a build-out record becomes a view: its unit.json at `oid`,
// read only where it is for this Unit of this work (the ref's own name and the
// work's uuid), so a record in one repository never speaks for a Unit whose
// record is in another. Null when it is not a record this release reads.
function recordView(
  projectDir: string,
  ref: string,
  oid: string,
  work: { uuid: string; space: string; rhythm?: UnitClaimPayload["gate_rhythm"] },
): UnitClaimView | null {
  const named = /^refs\/aidlc\/claims\/([^/]+)\/([^/]+)$/.exec(ref);
  const payload = named === null ? null : recordPayloadAt(projectDir, oid);
  if (payload === null || named === null || payload.unit !== named[2] || payload.intent_uuid !== work.uuid || idSuffix(work.uuid) !== named[1]) {
    return null;
  }
  const filled: UnitClaimPayload = { ...payload, space: work.space, claim_ref: ref, gate_rhythm: work.rhythm ?? "per-stage" };
  // A proposal is for one of the plan's approved inputs exactly, where the plan is here to say.
  const inputs = (filled.proposals ?? []).length === 0 ? null : planOfWork(projectDir, named[1])?.inputs.map((input) => input.path) ?? null;
  if (inputs !== null) filled.proposals = filled.proposals!.filter((entry) => inputs.includes(entry.input));
  return withLeadsWord(projectDir, {
    unit: filled.unit, status: filled.status, owner: filled.owner, generation: filled.generation, nonce: filled.nonce, oid, ref, payload: filled,
  });
}

// The lead's word on one Unit (plan.json's units[].word): what only the lead
// writes, on the plan, never in a record. `generation` is the take it is for.
// An entry with a `head` holds while the result still ends there in that repo
// (a push clears the lead's verdicts and a turn-down; a commit added to a pushed
// branch moves the head the same way); a turn-down holds while every repo still
// ends where it was turned down. An amendment's text is the blob it names, in
// the plan's history.
export interface UnitWord {
  generation?: number;
  verdicts?: Array<{ repo: string; head?: string; merged: boolean; commit?: string; how?: string }>;
  done?: true;
  turned_down?: { repo: string; heads: Record<string, string>; words: string; at: string; from?: "build-and-test"; person_reply?: string };
  signoff?: { words: string; at: string };
  said_merged?: Array<{ repo: string; head?: string; words: string; at: string }>;
  answers?: Array<{ input: string; at: string; answer: "approved" | "turned down"; words?: string }>;
  amendments?: Array<Amendment & { blob: string }>;
  open_again?: { at: string };
  // A pull request the lead named as the Unit's build in one repository, one
  // per repository; it counts as merged once git shows its last head merged.
  pull_requests?: NamedPullRequest[];
}

export interface NamedPullRequest {
  repo: string;
  number: number;
  words: string;
  at: string;
}

export function unitWordIn(plan: PlanJson, unit: string): UnitWord {
  return (plan.units.find((entry) => entry.name === unit)?.word ?? {}) as UnitWord;
}

// Where a result ends in each of its repos.
export function resultHeads(payload: UnitClaimPayload): Record<string, string> {
  return Object.fromEntries((payload.result?.repos ?? []).map((repo) => [repo.repo, repo.heads.at(-1) ?? ""]));
}

// A record's view with the lead's word on it, where the word is for this take
// and push. A Build and Test send-back that holds leaves the view with no result
// and not done, so the lead's look does not count the old merge again; a take
// opened again reads as given back.
export function viewWithWord(view: UnitClaimView, word: UnitWord): UnitClaimView {
  if (word.generation === undefined || word.generation !== view.generation) return view;
  const heads = resultHeads(view.payload);
  const holds = (entry: { repo: string; head?: string }): boolean => entry.head === undefined || heads[entry.repo] === entry.head;
  const payload: UnitClaimPayload = { ...view.payload };
  const verdicts = (word.verdicts ?? []).filter(holds);
  if (verdicts.length > 0) payload.verdicts = verdicts;
  const said = (word.said_merged ?? []).filter(holds);
  if (said.length > 0) payload.said_merged = said;
  if ((word.pull_requests ?? []).length > 0) payload.pull_requests = word.pull_requests;
  if (word.done) payload.done = true;
  if (word.signoff) payload.signoff = word.signoff;
  if ((word.amendments ?? []).length > 0) payload.amendments = word.amendments;
  if (payload.proposals !== undefined && (word.answers ?? []).length > 0) {
    payload.proposals = payload.proposals.map((entry) => {
      const answer = word.answers!.find((given) => given.input === entry.input && given.at === entry.at);
      return answer === undefined ? entry : { ...entry, answer: answer.answer, ...(answer.words ? { answer_words: answer.words } : {}) };
    });
  }
  const down = word.turned_down;
  if (down !== undefined && turnDownHolds(down, heads)) {
    payload.turned_down = down;
    if (down.from === "build-and-test") {
      delete payload.result;
      delete payload.done;
      delete payload.verdicts;
    }
  }
  // The view reads as given back; its payload keeps the record's own status
  // and owner, which only the builder writes.
  if (word.open_again !== undefined) {
    payload.open_again = word.open_again;
    return { ...view, status: "released", owner: "released", payload };
  }
  return { ...view, payload };
}

// The lead's turn-down holds for a result that ends where it was said of, in
// each of its repositories and no other. A record's own turn-down field (one
// written by hand or by an older build) names no heads, so it holds for none.
function turnDownHolds(down: { repo: string; heads?: Record<string, string> }, heads: Record<string, string>): boolean {
  const said = down.heads ?? {};
  return Object.keys(heads).length === Object.keys(said).length && Object.entries(said).every(([repo, head]) => heads[repo] === head);
}

// A record's view with the lead's word from the plan of its work, as this
// workspace last read or wrote it.
function withLeadsWord(projectDir: string, view: UnitClaimView): UnitClaimView {
  const plan = wordPlanOf(projectDir, view.payload.intent_id8);
  if (plan !== null) return viewWithWord(view, unitWordIn(plan, view.unit));
  // No plan shared yet (solo work a teammate took): the lead's own record says
  // what it counted merged.
  return recordedMergedHere(projectDir, view) ? { ...view, payload: { ...view.payload, done: true } } : view;
}

// The lead's own record holds this take's merge (UNIT_MERGED, recordUnitDone).
function recordedMergedHere(projectDir: string, view: UnitClaimView): boolean {
  try {
    if (activeIdentity(projectDir).intentUuid !== view.payload.intent_uuid) return false;
    return unitMergesStanding(readAuditShardEvents(projectDir), view.unit).some((row) =>
      auditBlockField(row.block, "Attempt Generation") === String(view.generation));
  } catch {
    return false;
  }
}

// The text of one file at a record commit (`result/<rel>`, `proposals/<input>`).
export function recordText(projectDir: string, oid: string, path: string): string | null {
  const shown = localGit(projectDir, ["show", `${oid}:${path}`, "--"]);
  return shown.ok ? shown.stdout : null;
}

// A record commit: unit.json with the builder's keys only, whatever the
// payload it is given carries, and the files under result/ and proposals/,
// built in one scratch index so the person's worktree and index are untouched;
// its one parent is the record's tip as read (none for a record not there),
// which is its predecessor. Every write but a take keeps the parent's files it
// does not replace; a take starts with unit.json alone. The person's own
// commit: their name, email and signing apply.
function createRecordCommit(
  projectDir: string,
  parent: string | null,
  payload: UnitClaimPayload,
  what: string,
  files: { result?: Record<string, string>; proposals?: Record<string, string> } = {},
  options: { take?: boolean } = {},
): string {
  const kept: Record<string, unknown> = {};
  const given = { ...payload, predecessor_oid: parent } as unknown as Record<string, unknown>;
  for (const key of RECORD_KEYS) if (given[key] !== undefined) kept[key] = given[key];
  if (Array.isArray(kept.proposals)) {
    kept.proposals = (kept.proposals as Proposal[]).map(({ input, by, words, at }) => ({ input, by, words, at }));
  }
  const entries: Array<[string, string]> = [
    [RECORD_FILE, `${JSON.stringify(kept, null, 2)}\n`],
    ...Object.entries(files.result ?? {}).map(([rel, text]): [string, string] => [`${RECORD_RESULT}${rel}`, text]),
    ...Object.entries(files.proposals ?? {}).map(([rel, text]): [string, string] => [`${RECORD_PROPOSALS}${rel}`, text]),
  ];
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-unit-record-"));
  let tree: string;
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    if (parent !== null && options.take !== true) {
      const read = git(projectDir, ["read-tree", parent], env);
      if (!read.ok) fail(`git read-tree failed: ${read.stderr.trim()}`);
    }
    const lines = entries.map(([path, text]) => {
      const blob = git(projectDir, ["hash-object", "-w", "--stdin"], undefined, text);
      if (!blob.ok) fail(`git hash-object failed: ${blob.stderr.trim()}`);
      return `100644 ${blob.stdout.trim()}\t${path}\n`;
    });
    const indexed = git(projectDir, ["update-index", "--add", "--index-info"], env, lines.join(""));
    if (!indexed.ok) fail(`git update-index failed: ${indexed.stderr.trim()}`);
    const written = git(projectDir, ["write-tree"], env);
    if (!written.ok) fail(`git write-tree failed: ${written.stderr.trim()}`);
    tree = written.stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return commitAsPerson(projectDir, tree, parent === null ? [] : [parent], unitCommitSubject(payload.unit, what));
}

// Where a Unit's record is: the repository the plan names for it, by that
// repository's address.
export interface RecordPlace {
  repo: string;
  address: string;
}

// The push of a record commit by its repository's address, from the workspace's
// own repository, with the lease on the tip it was built on (none: the record
// is not there yet, so the first take wins). git's own refusal classes tell a
// take or write that lost (CLAIM_RACE_LOST) from a refusal, and a rule of the
// host from any other (refusedByHostRule). On ok this workspace's copy of the
// record follows, so a read before the next look sees it.
function writeUnitRecord(
  projectDir: string,
  place: RecordPlace,
  ref: string,
  commit: string,
  expected: string | null,
): { ok: true } | { ok: false; lost: true } | { ok: false; refused: string; byRule?: true } {
  const via = gitTargetFor(projectDir, place.address, "push");
  const pushed = git(projectDir, ["push", via.target, `--force-with-lease=${ref}:${expected ?? ""}`, `${commit}:${ref}`], via.env);
  if (pushed.ok) {
    localGit(projectDir, ["update-ref", copyOf(place.address, ref), commit]);
    return { ok: true };
  }
  if (CLAIM_RACE_LOST.test(pushed.stderr)) return { ok: false, lost: true };
  return { ok: false, refused: maskUserinfo(pushRefusal(pushed.stderr)), ...(refusedByHostRule(pushed.stderr) ? { byRule: true as const } : {}) };
}

// A record repository that could not be read: its name and git's own words
// (null at the look's own time limit).
export class RecordUnread extends Error {
  constructor(readonly repo: string, readonly said: string | null) {
    super(repo);
  }
}

// A Unit's record as its repository has it now: one look by its address into
// this workspace's copy, then the copy read through recordView. Null when the
// repository has no record of the Unit, or one this release does not read.
function readUnitRecord(
  projectDir: string,
  place: RecordPlace,
  work: { uuid: string; space: string; rhythm?: UnitClaimPayload["gate_rhythm"] },
  unit: string,
  options: { typed?: boolean } = {},
): UnitClaimView | null {
  const ref = claimRecordRef(idSuffix(work.uuid), unit);
  const looked = lookAt(projectDir, place.address, [ref], options);
  if (!looked.ok) {
    if ("refused" in looked) throw new GitWriteRefused(looked.refused, place.repo);
    throw new RecordUnread(place.repo, looked.firstLine);
  }
  const tip = looked.refs[ref]?.now ?? null;
  return tip === null ? null : recordView(projectDir, ref, tip, work);
}

// A record read at a step the person typed: a repository that does not answer
// stops the step with git's own words, before anything is written; at a take
// (`taking`, the Unit taken), in the take's own words.
function typedRecordRead(
  projectDir: string, place: RecordPlace, work: { uuid: string; space: string }, unit: string, taking?: string,
): UnitClaimView | null {
  try {
    return readUnitRecord(projectDir, place, work, unit, { typed: true });
  } catch (error) {
    if (!(error instanceof RecordUnread)) throw error;
    const why = error.said ?? "it did not answer in time";
    if (taking !== undefined) fail(`${taking} was not taken: ${error.repo} could not be read (${why}). Nothing was written; say when to try again.`);
    fail(`Unit claim registry read failed: ${why}`);
  }
}

// Whether this workspace's copy of a Unit's record is one a newer AI-DLC
// wrote: its unit.json names a version above this release's, so recordView
// reads nothing there and a take must not write over it.
function recordNewerHere(projectDir: string, place: RecordPlace, id8: string, unit: string): boolean {
  const tip = localGit(projectDir, ["rev-parse", "--verify", "--quiet", copyOf(place.address, claimRecordRef(id8, unit))]).stdout.trim();
  const shown = tip === "" ? null : localGit(projectDir, ["show", `${tip}:${RECORD_FILE}`, "--"]);
  if (shown === null || !shown.ok) return false;
  try {
    const version = (JSON.parse(shown.stdout) as { version?: unknown }).version;
    return typeof version === "number" && version > 1;
  } catch {
    return false;
  }
}

// A record as this workspace last read it (its copy), with no look.
function recordCopied(projectDir: string, place: RecordPlace, work: { uuid: string; space: string }, unit: string): UnitClaimView | null {
  const ref = claimRecordRef(idSuffix(work.uuid), unit);
  const tip = localGit(projectDir, ["rev-parse", "--verify", "--quiet", copyOf(place.address, ref)]).stdout.trim();
  return tip === "" ? null : recordView(projectDir, ref, tip, work);
}

// Where a claim commit stands against a claim tip: "ahead" when the tip is in
// its history, or a commit there has the tip's tree (the lead takes a team's
// commit in as a commit of its own with the same tree, so the two histories
// part with the same claim); "same" when it holds the tip's own tree; else
// null (it parted from the tip, or is behind it). Read from this clone's own
// objects; a commit not here is null. Two commits' answer never changes, so it
// is kept for the command (a step reads the claims several times, and each read
// is up to three git calls a pair, slow on Windows); one read while a commit
// was not here yet is not kept.
const claimsAhead = new Map<string, "ahead" | "same" | null>();
function claimAhead(projectDir: string, tip: string, oid: string): "ahead" | "same" | null {
  if (tip === oid) return "same";
  const pair = `${tip} ${oid}`;
  const kept = claimsAhead.get(pair);
  if (kept !== undefined) return kept;
  const keep = (answer: "ahead" | "same" | null): "ahead" | "same" | null => {
    claimsAhead.set(pair, answer);
    return answer;
  };
  if (localGit(projectDir, ["merge-base", "--is-ancestor", tip, oid]).ok) return keep("ahead");
  const tipTree = localGit(projectDir, ["rev-parse", "--verify", "--quiet", `${tip}^{tree}`]).stdout.trim();
  const trees = localGit(projectDir, ["log", "--format=%T", "--max-count=200", oid]).stdout.split(/\r?\n/).map((tree) => tree.trim()).filter(Boolean);
  if (tipTree === "" || trees.length === 0) return null;
  if (trees[0] === tipTree) return keep("same");
  return keep(trees.slice(1).includes(tipTree) ? "ahead" : null);
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
  const state = stateHere(projectDir);
  // The build-out's records: each where the plan says it is, read now.
  if (!claimsOnBranches(state)) {
    for (const place of recordPlacesOfWork(projectDir, intentId8)) {
      const looked = lookAt(projectDir, place.address, [claimsOnRemote(false, intentId8)], { typed: true });
      if (!looked.ok) fail(`Unit claim registry fetch failed: ${"refused" in looked ? looked.refused : looked.said ?? "it did not answer in time"}`);
    }
    const identity = activeIdentity(projectDir);
    const records = recordsCopied(projectDir, { space: identity.space, intentUuid: identity.intentUuid, intentId8 }, new Map());
    return new Map([...records].filter(([unit]) => units.includes(unit)));
  }
  fetchClaimRefs(projectDir, remote);
  const claims = new Map<string, UnitClaimView>();
  for (const unit of units) {
    const ref = claimRefFor(state, intentId8, unit);
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

// The build-out's records of a work as this workspace last read them: each
// Unit's copy from the one repository the plan names for its record (the
// workspace's own for the solo second person), through recordView. A copy
// read from any other repository is never this Unit's record.
function recordsCopied(
  projectDir: string,
  identity: UnitClaimIdentity,
  claims: Map<string, UnitClaimView>,
): Map<string, UnitClaimView> {
  const plan = planOfWork(projectDir, identity.intentId8);
  const own = workspaceHomeLocation(projectDir);
  const placeKey = (unit: string): string | null =>
    plan !== null ? repoCopyKey(recordPlaceIn(plan, unit).address) : own !== null && own !== "local" ? repoCopyKey(own) : null;
  const listed = localGit(projectDir, ["for-each-ref", "--format=%(objectname) %(refname)", `refs/aidlc/home/${identity.intentId8}/`]);
  for (const line of listed.ok ? listed.stdout.split(/\r?\n/).filter(Boolean) : []) {
    const [oid, ref] = line.trim().split(/\s+/, 2);
    const copy = ref === undefined ? null : homeCopyOf(ref);
    if (!oid || copy?.kind !== "record" || copy.id8 !== identity.intentId8 || placeKey(copy.unit) !== copy.key) continue;
    const view = recordView(projectDir, claimRecordRef(identity.intentId8, copy.unit), oid, { uuid: identity.intentUuid, space: identity.space });
    if (view === null) continue;
    const prior = claims.get(copy.unit);
    claims.set(copy.unit, { ...view, ...(prior?.observedAt !== undefined ? { observedAt: prior.observedAt } : {}), movementObserved: false });
  }
  return claims;
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
  const refs = localGit(projectDir, ["for-each-ref", "--format=%(objectname) %(refname)", ...CLAIM_REF_FOLDERS]);
  if (!refs.ok) return claims;
  // The work's own kind of claim, by its recorded flow: main's flow's branches,
  // or the build-out's records (claimsOnBranches).
  const onBranches = claimsOnBranchesFor(projectDir, identity.space, identity.intentUuid);
  if (!onBranches) return recordsCopied(projectDir, identity, claims);
  // A copy ahead of another is the newer one, whoever holds it (claimAhead).
  // Else this clone's own remote's copies and local claim branches are read
  // over another remote's, whatever their generation, so a fork's stale copy
  // never hides the home's own. Between copies of one kind, the rule below.
  let ownRemote: string | null = null;
  try {
    ownRemote = repositoryRemote(projectDir);
  } catch {
    // No remote this clone calls its own: no copy ranks as one.
  }
  const homeCopy = (here: NonNullable<ReturnType<typeof claimHere>>): number =>
    here.kind === "own" || (ownRemote !== null && here.remote === ownRemote) ? 1 : 0;
  const descends = (older: string, newer: string): boolean => claimAhead(projectDir, older, newer) === "ahead";
  const readFrom = new Map<string, number>();
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [oid, ref] = line.trim().split(/\s+/, 2);
    if (!oid || !ref) continue;
    const here = claimHere(ref);
    if (here === null || here.id8 !== identity.intentId8 || here.onBranches !== onBranches) continue;
    const payload = readPayload(projectDir, oid);
    if (!payload || payload.intent_uuid !== identity.intentUuid) {
      throw new Error(
        `Local Unit claim registry payload is unavailable or invalid at ${ref}; ` +
          "fetch that claim ref without a partial-clone filter before retrying.",
      );
    }
    const prior = claims.get(payload.unit);
    // The cache keeps a claim's summary only; the ref at the same commit hands
    // over its whole payload (a published candidate's commit among it).
    const kind = homeCopy(here);
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

// The claims of a plan's work as this workspace last read them, over what the
// plan says is open.
export function planClaimOverview(projectDir: string, plan: PlanJson, seen: ReadonlySet<string> = new Set()): UnitClaimOverview {
  const claims = cachedClaimsForIdentity(resolveProjectDir(projectDir), { space: plan.work.space, intentUuid: plan.work.id, intentId8: idSuffix(plan.work.id) }, true);
  return buildOverview(buildOutOpening(plan, seen), claims, new Set());
}

// A Unit this workspace's own git reads merged in every repo of its result: a
// team takes the Unit waiting on it without waiting for the lead's look. With
// the lead's sign-off on, only once the plan says signed off.
export function mergedAsReadHere(projectDir: string, view: UnitClaimView | null | undefined, plan: PlanJson): boolean {
  return view?.status === "claimed" && view.payload.result !== undefined && view.payload.done !== true &&
    countsDone(teamMergeSeen(projectDir, view.payload) === true, plan.settings[LEAD_SIGNOFF_FIELD] === "on", view.payload);
}

// The rule for a take that counts done, the lead's and a team's: merged in
// every repo of its result, and signed off where the lead's sign-off is on.
function countsDone(merged: boolean, signOffOn: boolean, payload: UnitClaimPayload): boolean {
  return merged && (!signOffOn || payload.signoff !== undefined);
}

function allMerged(verdicts: ReadonlyArray<{ merged: boolean }>): boolean {
  return verdicts.length > 0 && verdicts.every((verdict) => verdict.merged);
}

// The Units others wait on that this workspace's own git reads merged.
export function mergesSeenHere(projectDir: string, plan: PlanJson, claims: ReadonlyMap<string, UnitClaimView>): Set<string> {
  const done = buildOutOpening(plan).completed;
  const waitedOn = new Set(plan.units.filter((unit) => !done.has(unit.name)).flatMap((unit) => unit.waits_on).filter((dep) => !done.has(dep)));
  return new Set([...waitedOn].filter((dep) => mergedAsReadHere(projectDir, claims.get(dep), plan)));
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
    if (leftOffMain(projectDir, path, recordPrefix)) continue;
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
  let commitFields: Record<string, unknown> = {};
  if (commitFirst) {
    // A commit git refused leaves HEAD where it was, so the offer to publish
    // at this HEAD is due again.
    try {
      const done = commitWorkHere(pd, `Complete the ${unit} Unit`, { unit, include });
      const named = workToCommitWords(pd, unit, done.taken);
      commitFields = { ...(named === null ? {} : { committed_files: named }), ...leftOutFields(unit, done.leftOut, done.unmatched) };
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
      ...commitFields,
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
    ...commitFields,
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
  const payload = readPayload(projectDir, transaction.pinned_oid);
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
          `Inspect the landed commit, then recover explicitly with ${aidlcInvocation()} unit land ${transaction.unit} ` +
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
      `Unit "${transaction.unit}" claim ref moved or changed attempt after pin; run ${aidlcInvocation()} unit pin ${transaction.unit} again.`,
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
    transaction.claim_ref !== claimBranchRef(identity.intentId8, transaction.unit)
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
  const ref = claimBranchRef(identity.intentId8, unit);
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
        `Unit "${unit}" already has a ${inFlight.status} merge transaction; recover it with ${aidlcInvocation()} unit land ${unit} instead of re-pinning.`,
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
    fail(`Unit "${unit}" pinned evidence journal changed; run ${aidlcInvocation()} unit pin ${unit} again.`);
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

// What a landing never merges onto main: AI-DLC's engine metadata, and a
// claim's file and a Unit's results at any of their places. The metadata
// checkpoint reads isEngineMergeMetadata alone, so it never commits a claim
// file in the project's aidlc/ folder or a Unit result a checkout happens to
// hold.
function leftOffMain(
  projectDir: string,
  path: string,
  recordPrefix = relativeRecordDir(projectDir),
): boolean {
  return isEngineMergeMetadata(projectDir, path, recordPrefix) ||
    isClaimTreeFile(claimPrefixOf(projectDir), path);
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
  const prefix = claimPrefixOf(projectDir);
  for (const path of paths.filter((path) =>
    leftOffMain(projectDir, path, recordPrefix)
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
      // The result folders the merge made and this emptied go with it, up
      // to the result folder itself; a folder still holding a file stays.
      const root = unitResultRootOf(prefix, path);
      for (let dir = dirname(path); root !== null && `${dir}/`.startsWith(root); dir = dirname(dir)) {
        try {
          rmdirSync(join(projectDir, dir));
        } catch {
          break;
        }
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
      !leftOffMain(projectDir, path, recordPrefix) && !carriedOnly(path)
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
    const expectedTreeish = leftOffMain(projectDir, path, recordPrefix) || carriedOnly(path)
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
      (path) => !leftOffMain(projectDir, path),
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
          `run ${aidlcInvocation()} unit pin ${unit} again and obtain a new merge gate.`,
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
          `Run ${aidlcInvocation()} unit land ${unit} again once main is back on ${transaction.evidence.stages_expected[0]}.`,
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
  const ref = claimBranchRef(identity.intentId8, unit);
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
  const checkedOut = readPayload(pd, head);
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
  refuseNewerWork(pd, state);
  if (!isTeamUnitOwnership(state)) fail("Unit claims require Unit Ownership: team.");
  // Where the work records its home, each team takes its Unit in its own clone
  // (take), and the lead's project is never scoped to one Unit.
  if (homeLocation(state) !== null) {
    // In a teammate's clone the claim is that Unit's take from the plan, the
    // command the Units offer gives it (unitTakeLook). A team named with it
    // names no space; a rhythm typed with it is the build's.
    const selected = resolveWorkflowSelection(pd);
    const location = homeLocation(state)!;
    if (selected.intent !== null && unitBuildOf(state) === null && planMadeElsewhere(pd)) {
      takeUnit(isGitAddress(location) ? [unit, ...planTakeFlags(activeIdentity(pd).intentId8, location)]
        : [unit, "--home", selected.intent, ...(selected.space === DEFAULT_SPACE ? [] : ["--home-space", selected.space])], pd,
        flags.rhythm as UnitClaimPayload["gate_rhythm"] | undefined);
      spend();
      return;
    }
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
  const ref = claimBranchRef(identity.intentId8, unit);
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

// The lead's word that a taken Unit is open again, on the plan.
function openAgain(pd: string, unit: string): void {
  const live = leadsRecordNow(pd, unit);
  const word = unitWordOnPlan(pd, unit);
  // A pull request named as its build, or a merge counted by the lead's word, with no pushed result: taken off.
  if ((live?.status !== "claimed" || !live.payload.result) && ((word.pull_requests ?? []).length > 0 || (word.done === true && (word.said_merged ?? []).length > 0))) {
    openAgainNamed(pd, unit, live);
    return;
  }
  if (live?.status !== "claimed") {
    console.log(JSON.stringify({ released: false, unit, notice: `${unit} is not taken, so it is open already.` }));
    return;
  }
  if (live.payload.done) {
    fail(`${unit} is done, so it is not opened again as it stands. I can send it back from your Build and Test, or build it again here: say which.`);
  }
  const sent = writeUnitWord(pd, live, `${unit} open again`, (word) => ({ ...word, open_again: { at: isoTimestamp() } }));
  failUnlessWritten(pd, sent, `${unit}'s reopening`);
  console.log(JSON.stringify({
    released: true, unit, generation: live.generation, claim_ref: live.ref, claim_oid: live.oid, notice: withPlanNotes(`Written on the plan: ${unit} is open again.`),
  }));
}

// The lead's word on a Unit as the plan this computer keeps has it.
function unitWordOnPlan(pd: string, unit: string): UnitWord {
  const plan = keptPlan(pd, activeIdentity(pd).intentId8)?.plan ?? null;
  return plan === null ? {} : unitWordIn(plan, unit);
}

// Open-again on a Unit whose build is a pull request the lead named, or that
// the lead counted merged by word, with no pushed result: the naming, the word
// and done come off the plan in one write, and a merge counted that way is
// taken back (mergeTakenBack). A take not pushed yet is opened again as any
// take is. Never a refusal.
function openAgainNamed(pd: string, unit: string, live: UnitClaimView | null): void {
  let named: NamedPullRequest[] = [];
  let byWord: string[] = [];
  let wasDone = false;
  const taken = live?.status === "claimed" ? live : null;
  const sent = leadsPlanWrite(pd, {
    // The commit says what came off: a merge, or only the naming.
    what: (tip) => {
      const word = tip === null ? {} : unitWordIn(tip, unit);
      return word.done === true || (word.pull_requests ?? []).length === 0 ? `merge of ${unit} taken back`
        : `${joinNames((word.pull_requests ?? []).map((pr) => `pull request ${pr.number} in ${pr.repo}`))} no longer named as the build of ${unit}`;
    },
    words: (other, tip) => {
      if (other !== unit) return null;
      const { done, said_merged, pull_requests, verdicts: _verdicts, signoff: _signoff, ...rest } = taken === null ? tip : wordForTake(tip, taken);
      named = pull_requests ?? [];
      byWord = (said_merged ?? []).map((said) => said.repo);
      wasDone = done === true;
      return taken === null ? rest : { ...rest, open_again: { at: isoTimestamp() } };
    },
  });
  failUnlessWritten(pd, sent, `${unit}'s reopening`);
  const after = wasDone ? mergeTakenBack(pd, unit, taken?.generation ?? 0, {}) : "";
  const its = named.length === 0 ? null : joinNames(named.map((pr) => `pull request ${pr.number} in ${pr.repo}`));
  const notice = wasDone
    ? (its !== null
      ? `Taken off the plan: ${its} ${named.length === 1 ? "is" : "are"} no longer named as ${unit}'s build, and ${unit} is no longer counted merged by ${named.length === 1 ? "it" : "them"}.`
      : `Taken off the plan: ${unit} is no longer counted merged in ${joinNames(byWord)} by your word.`) + ` ${unit} is open for a team to take.${after}`
    : `Taken off the plan: ${its} ${named.length === 1 ? "is" : "are"} no longer named as ${unit}'s build. ${unit} is open for a team to take.`;
  console.log(JSON.stringify({ released: taken !== null, unit, notice: withPlanNotes(notice) }));
}

function releaseUnit(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail(`usage: ${unitUsage("release")}`);
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  const pd = resolveProjectDir(projectDir);
  refuseNewerWork(pd, readStateFile(pd));
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
  // Work teams build: the lead opens the take again on the plan, and the next
  // take writes over it; the record stays its builder's.
  if (homeLocation(state) !== null) {
    openAgain(pd, unit);
    return;
  }
  const identity = activeIdentity(pd);
  const integration = fetchIntegration(pd);
  const ref = claimRefFor(state, identity.intentId8, unit);
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
  const place = recordPlaceOf(pd, home, unit);
  let current: UnitClaimView | null;
  try {
    current = readUnitRecord(pd, place, recordWork(home), unit, { typed: true });
  } catch (error) {
    if (!(error instanceof RecordUnread)) throw error;
    fail(`${place.repo} could not be reached (${error.said ?? "it did not answer in time"}), so ${unit} is not given back yet and its build ` +
      "here stays as it is. Say when to try again.");
  }
  let said: string;
  const standing = takeStanding(pd, build).state;
  const taken = current;
  if (taken?.status === "claimed" && taken.payload.taken_by !== undefined && taken.generation === build.attempt &&
    taken.payload.result === undefined && standing === "recorded") {
    const pushed = writeUnitRecord(pd, place, ref, createRecordCommit(pd, taken.oid, releasedClaim(taken), "given back"), taken.oid);
    if (!pushed.ok) {
      fail(`${unit} could not be given back: ${"refused" in pushed ? pushed.refused : `its record in ${place.repo} changed while I was writing it`}. ` +
        "Say when to try again.");
    } else {
      invalidateLiveClaimPayloadCache(pd, unit);
      said = `${unit} is given back. Written on its record in ${place.repo}.`;
    }
  } else {
    said = `Nothing changed for ${unit}: its record in ${place.repo} is as it was.`;
  }
  const dirName = resolveWorkflowSelection(pd).intent;
  const archived = dirName ? runEngineUtility(pd, ["intent", "archive", dirName, "--reason", "given back"]) : null;
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

// What the lead's first share of team work an older AI-DLC stops at (the team
// version) says last, once: the endings that reach the host note the share.
function teammatesNeedLine(projectDir: string): string | null {
  if (teamSharedHere(projectDir)) return null;
  const verdict = classifyStateVersion(readStateFile(projectDir));
  return verdict.kind === "ok" && verdict.version === TEAM_STATE_VERSION
    ? `Taking a Unit of this work needs ${newerStateRelease(TEAM_STATE_VERSION)}.`
    : null;
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
  // What the commit does to each path, as workToCommitWords names it.
  kinds: Map<string, CommitKind>;
  // Removals git already holds staged (git rm, a rename's old name).
  removed: Set<string>;
  // New files a Unit's publish leaves out, and the --include paths that named none.
  leftOut: string[];
  unmatched: string[];
}

type CommitKind = "changed" | "new" | "deleted";

// What committing a path does, from its two-letter `git status` code. An
// unmerged path is committed as it stands; a staged new name gone from the
// disk (AD, RD, CD) commits nothing, so it has no kind.
function commitKind(code: string): CommitKind | null {
  if (/^(DD|AU|UD|UA|DU|AA|UU)$/.test(code)) return "changed";
  if (/^[ARC]D$/.test(code)) return null;
  if (code.includes("D")) return "deleted";
  return code === "??" || /^[ARC]/.test(code) || code[1] === "A" ? "new" : "changed";
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
  if (!status.ok) return { paths: [], untracked: [], kinds: new Map(), removed: new Set(), leftOut: [], unmatched: [] };
  const paths: string[] = [];
  const untracked: string[] = [];
  const kinds = new Map<string, CommitKind>();
  const removed = new Set<string>();
  const records = status.stdout.split("\u0000");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));
    if (code === "??") untracked.push(record.slice(3));
    const kind = commitKind(code);
    if (kind !== null) kinds.set(record.slice(3), kind);
    if (code === "D ") removed.add(record.slice(3));
    // A rename's old name goes; a copy's source stays as it is.
    if (/[RC]/.test(code) && records[i + 1]) {
      paths.push(records[++i]);
      if (code.includes("R")) kinds.set(records[i], "deleted");
      if (code[0] === "R") removed.add(records[i]);
    }
  }
  const own = aidlcOwnRootParts(pd, paths);
  const kept = paths.filter((path) => !own.has(path));
  const keptUntracked = untracked.filter((path) => !own.has(path));
  if (work === undefined) return { paths: kept, untracked: keptUntracked, kinds, removed, leftOut: [], unmatched: [] };
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
    kinds,
    removed,
    leftOut,
    unmatched,
  };
}

// As many files as the share, publish and push questions name before
// "and N more", as the brought-files note does.
const FILES_NAMED = 10;

// What a commit here takes, as the share, publish and push questions say it,
// or what it took (`committed`), as their results say it: the count, and each
// file outside AI-DLC's record by what the commit does to it, a handful in
// git's order. Past ten, an unignored dependency folder would make the step
// too long to send, so the words name the ten nearest the project's top,
// where an unignored key usually sits (a stable sort by depth keeps git's
// order within a depth, the same ten on every platform), and say how many
// more. For a Unit's publish (`unit`) these are its own work. Null when
// nothing, and for what was committed when it names no file.
export function workToCommitWords(projectDir: string, unit?: string, committed?: WorkToCommit): string | null {
  const pd = resolveProjectDir(projectDir);
  const work = committed ?? workToCommit(pd, unit === undefined ? undefined : { unit });
  if (work.paths.length === 0) return null;
  const outside = work.paths.filter((path) => work.kinds.has(path) && path !== "aidlc" && !path.startsWith("aidlc/"));
  if (committed !== undefined && outside.length === 0) return null;
  const depth = (path: string): number => path.split("/").length;
  const shown = outside.length <= FILES_NAMED
    ? outside
    : [...outside].sort((a, b) => depth(a) - depth(b)).slice(0, FILES_NAMED);
  const named = (["changed", "new", "deleted"] as const).flatMap((kind) => {
    const paths = shown.filter((path) => work.kinds.get(path) === kind);
    return paths.length === 0 ? [] : [`${kind}: ${paths.join(", ")}`];
  });
  const more = outside.length - shown.length;
  // Past one kind, ", and N more" would read as more of the last kind; after
  // the commit `git status` shows none of them.
  const oneKind = new Set(outside.map((path) => work.kinds.get(path))).size === 1;
  const rest = more === 0
    ? ""
    : `${oneKind ? "," : ";"} and ${more} more${committed === undefined ? "; `git status` shows the rest" : ""}`;
  const words = shown.length === 0 ? "" : ` (${named.join("; ")}${rest})`;
  // The question's own QUESTION_ASKED row (recordQuestionStep) goes into this
  // checkout's audit shard after these words, and the commit takes it unless
  // git ignores it, as a team's clone's own record is.
  const shard = relative(pd, auditFilePath(pd)).replaceAll("\\", "/");
  const asked = committed === undefined && !work.paths.includes(shard) &&
    !git(pd, ["check-ignore", "-q", "--", shard]).ok;
  const count = work.paths.length + (asked ? 1 : 0);
  const of = unit === undefined ? "" : " of its work";
  return `the ${count} changed file${count === 1 ? "" : "s"}${of} here${words}`;
}

// Commits what workToCommit names, as the person, with their own git setup;
// nothing to commit commits nothing. Returns how many paths it took and what
// they were, and what a Unit's publish left out.
function commitWorkHere(
  projectDir: string,
  message: string,
  work?: UnitWork,
): { committed: number; taken: WorkToCommit; leftOut: string[]; unmatched: string[] } {
  const taken = workToCommit(projectDir, work);
  const { paths, removed, leftOut, unmatched } = taken;
  if (paths.length === 0) return { committed: 0, taken, leftOut, unmatched };
  // One call whatever the count: Windows caps a command line at 32,767
  // characters, so the paths go to git on its standard input, NUL-separated,
  // each read as the same name an argument would be (git 2.25; core already
  // needs 2.29). A removal git already holds staged is in neither the index
  // nor the checkout, which git add refuses to be given, and the commit takes
  // it as it is. An empty list is never given: with -A and no path git would
  // take the whole tree.
  const add = paths.filter((path) => !removed.has(path) || existsSync(join(projectDir, path)));
  const added = add.length === 0 ? null : git(
    projectDir,
    ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
    undefined,
    add.map((path) => `${path}\0`).join(""),
  );
  if (added !== null && !added.ok) shareCommitRefused(added.stderr.trim(), true);
  const committed = git(projectDir, ["commit", "-q", "-m", message]);
  if (!committed.ok) shareCommitRefused((committed.stderr || committed.stdout).trim(), false);
  return { committed: paths.length, taken, leftOut, unmatched };
}

// What the share and publish say when git does not take their add or commit.
function shareCommitRefused(said: string, adding: boolean): never {
  if (adding) fail(`git add failed: ${said}${/[.!?]$/.test(said) ? "" : "."}`);
  if (NO_GIT_IDENTITY.test(said)) {
    fail(
      "Git has no name and email for your commits yet. Set them with " +
        'git config --global user.name "Your Name" and git config --global user.email "you@example.com".',
    );
  }
  throw new CommitRefused(`git did not commit: ${said}.`);
}

// The plan's share: AI-DLC's record (recordPaths: aidlc/, and a repos.json
// still at the root unless the person's .gitignore lists it), with the code
// Units built here wrote at a home whose code is this repository (builtHereCode,
// left out with `code` false, as `unit commit-record` asks), committed by pathspec
// through commitUnitPaths, so a file the person staged stays theirs, staged.
// Pathspecs, never the file list: a plan's hundreds of files would pass the
// 32,767 characters Windows allows a command line. `paths` in their place:
// what the update's own commit takes (ownFilesToCommit). Returns how many
// files the commit took.
function commitPlanHere(pd: string, message: string, code = true, paths?: readonly string[]): number {
  const head = (): string => git(pd, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim();
  const before = head();
  commitUnitPaths(pd, paths ? [...paths] : [...recordPaths(pd), ...(code ? builtHereCode(pd).paths : [])], {}, "", "", "", null, { message, refused: shareCommitRefused });
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
// two agree or the shared plan cannot be read. `repo`: the plan's repository,
// where the plan is its own ref (read from the plan there, as this computer
// last read it, never from main); null where the plan is main's.
export function skeletonHeldBackOnShare(projectDir: string): { unit: string; repo: string | null } | null {
  try {
    const pd = resolveProjectDir(projectDir);
    const state = readStateFile(pd);
    if (!isTeamUnitOwnership(state) || getField(state, "Skeleton Stance") === null || teamSkeletonOn(state)) return null;
    if (sharesPlanRef(pd)) {
      const plan = keptPlan(pd, activeIdentity(pd).intentId8)?.plan ?? null;
      if (plan === null || plan.skeleton === null) return null;
      const held = [...buildOutOpening(plan).blockers.values()].some((blockers) => blockers.includes("walking-skeleton"));
      return held ? { unit: plan.skeleton, repo: plan.plan_repo.name } : null;
    }
    const target = shareTarget(pd);
    if (target === null) return null;
    const ref = git(pd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${target.remote}/${target.branch}`]);
    if (!ref.ok) return null;
    const shared = openingStatus(pd, ref.stdout.trim());
    return [...shared.blockers.values()].some((blockers) => blockers.includes("walking-skeleton")) ? { unit: shared.skeleton, repo: null } : null;
  } catch {
    return null;
  }
}

// Taking, publishing, pinning and landing a Unit read and write the
// repository's trees at its top, with the record's paths from the project, so
// a project in a folder below the top cannot hand Units to teams yet. The line
// that says so; null at the top.
export function belowRepoTop(projectDir: string): string | null {
  const prefix = git(projectDir, ["rev-parse", "--show-prefix"]);
  const folder = prefix.ok ? prefix.stdout.trim().replace(/\/$/, "") : "";
  if (folder === "") return null;
  const top = git(projectDir, ["rev-parse", "--show-toplevel"]).stdout.trim();
  return `Team work needs this project at the top of its git repository; it sits in ${folder} of ${top}.`;
}

// Whether a share can run here: team work, a checkout holding no Unit claim, a
// project at its repository's top, a remote, and HEAD on the integration branch.
// Null when it can; the reason otherwise, with `off` when the one reason is HEAD
// on another branch (the share then commits AI-DLC's record there and pushes
// nothing, shareMain). The share offer is put only where this is null.
export function shareRefusal(projectDir: string, plan = true): { reason: string; off?: { current: string; branch: string } } | null {
  const pd = resolveProjectDir(projectDir);
  try {
    if (readApplicableTeamUnitScopeStamp(pd)) return { reason: "This checkout holds a Unit claim; share main from a checkout that holds none." };
    if (!isTeamUnitOwnership(readStateFile(pd))) return { reason: "Sharing main is for work that several teams build." };
    const below = belowRepoTop(pd);
    if (below !== null) return { reason: below };
    // The plan goes to a code repository by its address: neither this
    // repository's remote nor its branch is used. A share without --plan
    // (`plan` false) commits and pushes here, so it meets both checks.
    if (plan && sharesPlanRef(pd)) return null;
    if (!repositoryRemote(pd)) {
      return { reason: "This repository has no remote to share main with. Add one (git remote add origin <url>), then share again." };
    }
    // The branch is read from the Way of Working words first, by the share's own step.
    if (integrationBranchToRead(pd) !== null) return null;
    const target = shareTarget(pd)!;
    const current = currentBranch(pd);
    if (current !== target.branch) {
      return { reason: `This checkout is on ${current}, not ${target.branch}.`, off: { current, branch: target.branch } };
    }
    return null;
  } catch (error) {
    return { reason: errorMessage(error) };
  }
}

// The lead's own work that teams build each Unit of, with no walking
// skeleton's code built here for main: its share is the plan's ref alone.
export function sharesPlanRef(projectDir: string): boolean {
  return leadsOwnTeamWork(projectDir) && builtHereCode(projectDir).paths.length === 0;
}

// The lead's own work that teams build each Unit of (not a Unit's build).
export function leadsOwnTeamWork(projectDir: string): boolean {
  try {
    const state = readStateFile(projectDir);
    return homeLocation(state) !== null && unitBuildOf(state) === null;
  } catch {
    return false;
  }
}

export function shareBlocker(projectDir: string): string | null {
  return shareRefusal(projectDir)?.reason ?? null;
}

// How the plan reaches the teams when the share committed it here and cannot
// push it: by the person's own branch and merge.
export function planWayOn(branch: string): string {
  return `The plan is committed here: push it on a branch and get it merged your usual way; the teams can take Units once it is in ${branch}.`;
}

// The plan's own branch when the integration branch takes no direct push:
// `aidlc-plan-<work>`, the work's record folder name with its id left off,
// then `-2`, `-3` while a name is taken here or on the remote.
function planBranchNames(pd: string): string[] {
  const work = (resolveWorkflowSelection(pd).intent ?? "").replace(/-[0-9a-f]{16}$/, "");
  const base = work !== "" && git(pd, ["check-ref-format", "--branch", `${PLAN_BRANCH}-${work}`]).ok ? `${PLAN_BRANCH}-${work}` : PLAN_BRANCH;
  return [base, ...Array.from({ length: 19 }, (_, at) => `${base}-${at + 2}`)];
}

// This work's plan branches here that `unit share --branch` pushed (its push
// set their upstream), in name order.
export function planBranchesHere(pd: string): string[] {
  const names = planBranchNames(pd);
  const listed = git(pd, ["for-each-ref", "--format=%(refname:short) %(upstream)", "refs/heads/"]);
  if (!listed.ok) return [];
  const pushed = new Set(listed.stdout.split("\n").map((row) => row.trim().split(" "))
    .filter(([, upstream]) => upstream !== undefined && upstream !== "").map(([name]) => name));
  return names.filter((name) => pushed.has(name));
}

// The name the plan's branch gets now: one already at HEAD and pushed (a run
// cut short), else the first free one.
function planBranchFor(pd: string, remote: string, head: string): { name: string; made: boolean } | null {
  for (const name of planBranchNames(pd)) {
    const here = git(pd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    const there = git(pd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`]);
    if (here.ok && there.ok && here.stdout.trim() === head && there.stdout.trim() === head) return { name, made: false };
  }
  return null;
}

// A plan branch name is taken when this clone has it or knows it on the remote.
function planBranchTaken(pd: string, remote: string, name: string): boolean {
  return git(pd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).ok ||
    git(pd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${name}`]).ok;
}

function firstFreePlanBranch(pd: string, remote: string): string {
  return planBranchNames(pd).find((name) => !planBranchTaken(pd, remote, name)) ?? planBranchNames(pd)[0];
}

// What the choice to share by pull request does, in the share question and
// in the offer after a host refused the push.
export function planByPullRequestDetail(projectDir: string): string {
  const pd = resolveProjectDir(projectDir);
  const branch = shareOfferTarget(pd)?.branch ?? "main";
  return `I put ${planShareName(pd)} on ${skeletonCodeName(pd) === null ? "its" : "their"} own branch, ${planBranchOffered(pd)}, ` +
    "push it and give you the host's link to open the pull request. You work on that branch until it is merged; " +
    `${branch} stays as it is.`;
}

// The branch `unit share --branch` would put the share's commit on.
export function planBranchOffered(projectDir: string): string {
  const pd = resolveProjectDir(projectDir);
  const target = shareOfferTarget(pd);
  return target === null ? planBranchNames(pd)[0] : firstFreePlanBranch(pd, target.remote);
}

// The share's own commits, noted when the host refused their push and the
// integration branch had nothing else the remote lacked: the ones
// `unit share --branch` may move.
const shareCommitMark = (oid: string): string => teamHandoverMarkName("plan-commit", oid.slice(0, 12));

// The commits the remote's branch, as last fetched, lacks from `from`, and
// whether every one is a noted share commit. Null when this clone does not
// know the remote's branch.
function shareCommitsAhead(pd: string, remote: string, branch: string, from: string): { oids: string[]; noted: boolean } | null {
  const listed = git(pd, ["rev-list", `refs/remotes/${remote}/${branch}..${from}`]);
  if (!listed.ok) return null;
  const oids = listed.stdout.split("\n").map((row) => row.trim()).filter(Boolean);
  return { oids, noted: oids.every((oid) => engineAskMark(pd, shareCommitMark(oid)) !== null) };
}

// The plan's branch `name`, checked out here, is in the integration branch:
// everything it changed is there by content, as HEAD has it or as the
// remote's copy of the branch has it (a suggestion committed on the pull
// request), or the host deleted that branch once the plan was in. Both
// branches are read quietly first.
function planBranchMerged(pd: string, target: { remote: string; branch: string }, name: string): boolean {
  const into = `refs/remotes/${target.remote}/${target.branch}`;
  let gone = false;
  if (!isReadOnlyEngineProbe()) {
    const there = quietly(() => git(pd, ["ls-remote", "--heads", target.remote, `refs/heads/${name}`]));
    gone = there.ok && there.stdout.trim() === "";
    quietFetch(pd, ["--no-tags", "-q", target.remote, target.branch, ...(gone ? [] : [name])]);
  }
  if (headInByContent(pd, into) === true) return true;
  const theirs = `refs/remotes/${target.remote}/${name}`;
  const known = git(pd, ["rev-parse", "--verify", "--quiet", theirs]).ok;
  const pushedAll = !known || git(pd, ["merge-base", "--is-ancestor", "HEAD", theirs]).ok;
  if (known && pushedAll && headInByContent(pd, into, theirs) === true) return true;
  return gone && pushedAll && !planUnshared(pd, target);
}

// Where the plan's share stands at a checkout that asked for it here
// (teamSharedHere): its commits noted on the integration branch and not in the
// remote's by content, or the checkout on the plan's branch; null otherwise.
// Only then is the remote read, quietly, so its merge is seen with no fetch of
// the person's. The waiting states hold while a team's clone cannot take
// Units yet (planUnshared): a later share's offer is put, and the board stays.
// `offer` is the once-mark of the offer due now, if any.
export type PlanWait =
  | { state: "committed"; offer: string | null }
  | { state: "branch"; name: string }
  | { state: "merged"; name: string; offer: string | null };

export function planWait(projectDir: string): PlanWait | null {
  // At the lead's own work teams build, the branch waits for the skeleton's
  // code to reach main, whatever the plan's ref says.
  const codeWaits = (pd: string, target: { remote: string; branch: string }): boolean =>
    skeletonCodeName(pd) !== null || planUnshared(pd, target);
  try {
    const pd = resolveProjectDir(projectDir);
    if (!teamSharedHere(pd)) return null;
    const target = shareTarget(pd);
    if (target === null) return null;
    const head = git(pd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
    const pushed = planBranchesHere(pd);
    if (pushed.includes(head)) {
      if (!planBranchMerged(pd, target, head)) return codeWaits(pd, target) ? { state: "branch", name: head } : null;
      const mark = teamHandoverMarkName("plan-back", head);
      return { state: "merged", name: head, offer: engineAskMark(pd, mark) === null ? mark : null };
    }
    if (head !== target.branch) return null;
    const noted = (): string[] | null => {
      const ahead = shareCommitsAhead(pd, target.remote, target.branch, "HEAD");
      return ahead?.noted && ahead.oids.length > 0 ? ahead.oids : null;
    };
    const waitsOnBranch = (): boolean => pushed.length > 0 && codeWaits(pd, target);
    if (noted() === null && !waitsOnBranch()) return null;
    if (!isReadOnlyEngineProbe()) CHECKOUT_STEPS.fetch.run(pd, target.remote, target.branch);
    const ahead = noted();
    if (ahead !== null && headInByContent(pd, `refs/remotes/${target.remote}/${target.branch}`) !== true) {
      const due = teamHandoverMarkName("plan-branch", ahead[0].slice(0, 12));
      const offer = engineAskMark(pd, due) === null ? due : null;
      return offer === null && !codeWaits(pd, target) ? null : { state: "committed", offer };
    }
    return waitsOnBranch() ? { state: "branch", name: pushed[pushed.length - 1] } : null;
  } catch {
    return null;
  }
}

// The one line while the plan waits, in place of the board (a look and status).
export function planWaitLine(wait: PlanWait, branch: string, projectDir?: string): string | null {
  const code = projectDir === undefined ? null : skeletonCodeName(projectDir);
  if (wait.state === "committed") {
    return code === null
      ? "The plan is committed here and not shared yet: say when you want me to put it on its own branch and push that."
      : `${code.name} ${code.is} committed here and not pushed yet: say when you want me to put it on its own branch and push that.`;
  }
  if (wait.state === "branch") {
    return code === null
      ? `The plan is on its own branch, ${wait.name}, waiting for its pull request; teams can take Units once it is in ${branch}.`
      : `${code.name} ${code.is} on its own branch, ${wait.name}, and not in ${branch} yet. The other Units wait on ${code.units} until it is.`;
  }
  return null;
}

// At the lead's own work teams build, what the plan's branch carries for main
// is a walking skeleton's code built here, never the plan: its words. Null elsewhere.
export function skeletonCodeName(projectDir: string): { name: string; is: string; units: string } | null {
  if (!leadsOwnTeamWork(projectDir)) return null;
  const { units } = builtHereCode(projectDir);
  if (units.length === 0) return null;
  return { name: namesInProse(units.map((unit) => `${unit}'s code`)), is: units.length === 1 ? "is" : "are", units: namesInProse(units) };
}

// `unit share --branch`: the commits the integration branch has and the
// remote's lacks, all the share's own (made just now, or noted when the host
// refused them), go on the plan's branch: made at HEAD and pushed with its
// upstream while the checkout is still on the integration branch, and only
// once the host took it, the checkout goes onto it and the integration branch
// back to where it left the remote's, each a compare-and-swap. The index and
// the files are never touched. A branch the host does not take is deleted
// again, so nothing changed. False when there is nothing to move.
function putPlanOnItsBranch(pd: string, remote: string, branch: string, madeNow: string | null, planOnly: boolean, needs: string | null): boolean {
  const into = `refs/remotes/${remote}/${branch}`;
  // Not done: main's share comes before a Unit starts here, so its offers are
  // due again, never a build here (as after a refused push).
  const stays: (line: string) => never = (line) => {
    if (!planOnly) clearTeamHandoverMarks(pd, ["share", "push"]);
    return fail(line);
  };
  if (madeNow !== null) noteEngineAskMark(pd, shareCommitMark(madeNow));
  const ahead = shareCommitsAhead(pd, remote, branch, "HEAD");
  if (ahead === null) {
    stays(`This clone knows of no ${branch} on ${remote} for a pull request to go into, so the plan stays committed here; ` +
      `sharing it with the teams pushes ${branch} itself.`);
  }
  if (ahead.oids.length === 0) return false;
  if (!ahead.noted) stays(`Your ${branch} has commits of yours that ${remote} lacks, so the plan stays committed here.`);
  const head = ahead.oids[0];
  const base = gitOutput(pd, ["merge-base", "HEAD", into], "Cannot read where the plan left the remote's branch");
  let plan = planBranchFor(pd, remote, head);
  let words = "";
  if (plan === null) {
    const free = planBranchNames(pd).find((name) =>
      !planBranchTaken(pd, remote, name) && git(pd, ["update-ref", "--stdin"], undefined, `create refs/heads/${name} ${head}\n`).ok
    );
    if (free === undefined) stays(`${remote} takes no direct push to ${branch}. ${planWayOn(branch)}`);
    plan = { name: free, made: true };
    const pushed = git(pd, ["push", "-u", remote, free], { GIT_TERMINAL_PROMPT: "0" });
    if (!pushed.ok) {
      git(pd, ["update-ref", "--stdin"], undefined, `delete refs/heads/${free} ${head}\n`);
      stays(
        `${remote} did not take the branch ${free} (${pushRefusal(pushed.stderr)}), so ` +
          `${madeNow === null ? "nothing changed: the plan is still committed here." : "nothing is pushed: the plan is committed here."}`,
      );
    }
    words = hostLinkWords(pushed.stderr, free);
  }
  const moved = git(pd, ["symbolic-ref", "-m", "share: the plan on its own branch", "HEAD", `refs/heads/${plan.name}`]);
  if (!moved.ok) fail(`The plan is on ${plan.name} on ${remote}, and your checkout stayed on ${branch}: git says ${gitWords(moved.stderr)}`);
  git(pd, ["update-ref", "-m", `share: ${branch} back to where it was`, "--stdin"], undefined, `update refs/heads/${branch} ${base} ${head}\n`);
  noteTeamShared(pd);
  // A Unit the lead asked to build here gets its record with the plan's branch, as with a push of main.
  const claims = claimsAskedHereWithShare(pd);
  console.log(JSON.stringify({
    shared: false,
    branch: plan.name,
    remote,
    notice: [
      skeletonCodeName(pd) === null
        ? `The plan is on its own branch, ${plan.name}, pushed to ${remote}, and your checkout is on it; ${branch} is as it was.`
        : `${planShareName(pd)} are on their own branch, ${plan.name}, pushed to ${remote}, and your checkout is on it; ${branch} is as it was.`,
      words === "" ? "Get it merged your usual way." : hostSaysLine(null, words),
      ...claims.lines,
      ...(needs === null ? [] : [needs]),
    ].join(" "),
    step: "Tell the person in plain words what it reports, then end your turn.",
  }));
  return true;
}

// Git's own words for the person, on one line.
function gitWords(said: string): string {
  return said.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(" ");
}

// Brings `branch` in `dir` level with `remote`'s copy as this clone last
// fetched it, never a stash, a merge commit or a force, and never over an
// ignored file of theirs: the move is tried first in a copy of the index ("dry
// run"), so one git refuses changes nothing; then the branch moves, fetched
// into while another branch is checked out ("fetch"), fast-forwarded in place
// while it is ("fast-forward"). A checked-out branch a squash or rebase merge
// left ahead and behind, with all of its work in that copy (levelByContent),
// is reset to the copy's commit by `git reset --keep` ("reset", `was` the
// commit it was at), never without that proof (`block`: why not). The result
// names the step that ran last, with git's own words when it refused. The one
// way AI-DLC brings a checkout level (the plan's way back, Build and Test's
// catch-up, the take of a merged build).
export type BranchLevelStep = "dry run" | "fetch" | "fast-forward" | "reset";
export function bringBranchLevel(dir: string, remote: string, branch: string):
  { ok: true; ran: BranchLevelStep; was?: string } | { ok: false; ran: BranchLevelStep; said: string; block?: LevelBlock } {
  const theirs = `refs/remotes/${remote}/${branch}`;
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-level-"));
  try {
    const index = resolve(dir, gitOutput(dir, ["rev-parse", "--git-path", "index"], "Cannot find the index"));
    if (existsSync(index)) copyFileSync(index, join(scratch, "index"));
    const tried = git(dir, ["read-tree", "-n", "-m", "-u", "HEAD", theirs], { GIT_INDEX_FILE: join(scratch, "index") });
    if (!tried.ok) return { ok: false, ran: "dry run", said: tried.stderr || tried.stdout };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const ran: BranchLevelStep = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() === branch ? "fast-forward" : "fetch";
  const moved = ran === "fast-forward"
    ? git(dir, ["merge", "-q", "--ff-only", "--no-overwrite-ignore", theirs])
    : git(dir, ["fetch", remote, `${branch}:${branch}`], { GIT_TERMINAL_PROMPT: "0" });
  if (moved.ok) return { ok: true, ran };
  const said = moved.stderr || moved.stdout;
  const level = ran === "fast-forward" ? levelByContent(dir, remote, branch) : null;
  if (level === null) return { ok: false, ran, said };
  if (level.block !== null) return { ok: false, ran, said, block: level.block };
  const was = git(dir, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  const reset = git(dir, ["reset", "-q", "--keep", level.theirs]);
  return reset.ok ? { ok: true, ran: "reset", was } : { ok: false, ran: "reset", said: reset.stderr || reset.stdout };
}

// Said by whichever command brought a branch level by its reset: level, with
// all of their work, and the commit it was at, the way back.
export function levelledLine(remote: string, branch: string, was: string): string {
  return `Your ${branch} is level with ${remote}/${branch} now, with all your work in it. ${CHECKOUT_STEPS.level.undo(was)}`;
}

// Why a branch stays as it was when the yes to bring it level was refused:
// the proof's reason (levelByContent), else git's own words; in a teammate's
// clone the lead's plan has not reached, with what waits on their own work.
function levelRefusedLine(remote: string, branch: string, moved: { said: string; ownWork: boolean; block?: LevelBlock }, planNotHere: boolean): string {
  const stays = `Your ${branch} stays as it was`;
  const theirs = `${remote}/${branch}`;
  const block = moved.block;
  if (planNotHere || block === undefined) {
    return `${stays}: git says "${gitSaid(moved.said)}".` + (planNotHere && moved.ownWork
      ? ` Your ${branch} has work of yours that ${theirs} does not; once that is in ${theirs}, I can bring the plan in.`
      : "");
  }
  return block.why === "staged" ? `${stays}: you have staged changes, and bringing it level would unstage them.`
    : block.why === "changed" ? `${stays}: your changes to ${block.path} are on a file ${theirs} changes.`
    : block.why === "replaced" ? `${stays}: ${block.path} is a file of yours that ${theirs} would replace.`
    : `${stays}: it has work of yours that ${theirs} does not.`;
}

// The steps AI-DLC runs in the person's own checkout, so no line makes them
// the hands for one. Each step's safety check lives in its runner, never here.
// A line naming the command an offer's choice runs (`via`), or the way back
// once a step ran (`undo`), takes it from this table; the sentence around it,
// and when it is said or asked, stay the caller's.
export const CHECKOUT_STEPS = {
  // The clone's own remote, into refs/remotes only, never a prompt: nothing of theirs moves, so nothing is said.
  fetch: {
    run: (dir: string, remote: string, branch?: string): GitResult =>
      quietFetch(dir, ["--no-tags", "-q", remote, ...(branch === undefined ? [] : [branch])]),
  },
  // A fast-forward behind a dry run (bringBranchLevel): their own commits all stay.
  forward: { run: bringBranchLevel, via: (): string => `${aidlcInvocation()} unit share --back` },
  // git's own refusal keeps a change of theirs in the way; one it can carry rides along.
  switch: {
    run: (dir: string, branch: string): GitResult => git(dir, ["switch", "-q", "--no-overwrite-ignore", branch]),
    undo: (from: string): string => `Switch back to ${from} any time.`,
  },
  // Main left ahead and behind with all of its work in the remote's copy: reset --keep behind levelByContent (bringBranchLevel).
  level: {
    run: bringBranchLevel,
    terminal: (): string => `${aidlcInvocation()} unit share --back`,
    via: (): string => `${aidlcInvocation()} unit share --back`,
    undo: (was: string): string => `It was at ${was} before, if you ever want that back.`,
  },
  // The branch a pushed Unit merges into, merged into its branch with their git on their yes (mergeMainIn); a clash is left
  // under way for them, and the undo takes that merge back out on their word.
  merge: {
    run: (dir: string, into: string, message: readonly string[] = []): GitResult => git(dir, ["merge", "-q", "--no-edit", ...message, into]),
    via: (): string => `${aidlcInvocation()} unit push --merge-main`,
    undoVia: (): string => `${aidlcInvocation()} unit push --undo-merge`,
  },
  // AI-DLC's own files only; at the person's own terminal, git's own command (aidlc config's line for the repo list's move).
  "commit-own": { run: commitRecord, terminal: commitOwnCommand, via: (): string => `${aidlcInvocation()} unit commit-record` },
} as const;

// --- Build and Test at the lead's project, once every Unit is merged ---------

// Each repo of this checkout that does not have every Unit merged on its
// remote yet, by the same content check the look makes against the remote,
// here against HEAD; `branch` is the one that brings it level, when its
// checkout is on the branch the Units merged into (null on another).
export interface ReposBehind {
  repo: string;
  dir: string;
  remote: string;
  into: string;
  branch: string | null;
  units: string[];
}

export function reposBehindMergedUnits(projectDir: string): ReposBehind[] {
  const pd = resolveProjectDir(projectDir);
  const behind = new Map<string, ReposBehind>();
  try {
    for (const claim of cachedClaims(pd).values()) {
      if (claim.status !== "claimed" || !claim.payload.done) continue;
      for (const result of claim.payload.result?.repos ?? []) {
        const dir = result.repo === "." ? pd : repoDir(pd, result.repo);
        if (!isGitRepoDir(dir) || unitMergeVerdict(dir, "HEAD", result).merged) continue;
        const remote = repositoryRemote(dir);
        if (remote === null) continue;
        const into = (result.repo === "." ? homeIntegrationBranch(pd) : null) ?? repoIntegration(dir, remote).slice(remote.length + 1);
        // Everything its remote's branch has is here already (the Unit merged in a form of its own, a fix on its
        // pull request say): there is nothing to bring.
        const theirs = `refs/remotes/${remote}/${into}`;
        if (!git(dir, ["rev-parse", "--verify", "--quiet", theirs]).ok || git(dir, ["merge-base", "--is-ancestor", theirs, "HEAD"]).ok) continue;
        const on = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
        const entry = behind.get(result.repo) ?? { repo: result.repo, dir, remote, into, branch: on === into ? into : null, units: [] };
        if (!entry.units.includes(claim.unit)) entry.units.push(claim.unit);
        behind.set(result.repo, entry);
      }
    }
  } catch {
    // Claims that cannot be read here ask nothing; the stage runs as it is.
    return [];
  }
  return [...behind.values()];
}

// The question before that stage, in one place: put once per set of Units
// (its mark), or, once put or with no branch to move, the stage's own line.
export function catchUpOffer(projectDir: string, stageName: string): {
  said: string;
  ask: { mark: string; question: string; choice: { label: string; detail: string; command: string }; notNow: string } | null;
} | null {
  const behind = reposBehindMergedUnits(projectDir);
  if (behind.length === 0) return null;
  const units = [...new Set(behind.flatMap((repo) => repo.units))].sort();
  const said = `${stageName} runs on this checkout as it is, without ${joinNames(units)}.`;
  if (behind.every((repo) => repo.branch === null)) return { said, ask: null };
  const one = behind.length === 1 && behind[0].repo === "." ? behind[0] : null;
  const names = behind.map((repo) => (repo.repo === "." ? "the repo" : repo.repo));
  return { said, ask: {
    mark: units.join("-"),
    question: one !== null
      ? `Every Unit is merged, and your ${one.into} does not have ${joinNames(units)} yet. Bring it up to date with ` +
        `${one.remote}/${one.into} first, so ${stageName} runs on the merged code?`
      : `Every Unit is merged, and ${joinNames(names)} here ${names.length === 1 ? "does" : "do"} not have ${joinNames(units)} yet. ` +
        `Bring ${names.length === 1 ? "it" : "them"} up to date first, so ${stageName} runs on the merged code?`,
    choice: {
      label: one !== null ? `Bring ${one.into} up to date` : `Bring ${names.length === 1 ? "it" : "them"} up to date`,
      detail: one !== null
        ? `Moves ${one.into} forward to ${one.remote}/${one.into}; nothing of yours changes.`
        : `Moves ${names.length === 1 ? "it" : "each"} forward to its remote's branch; nothing of yours changes.`,
      command: `${aidlcInvocation()} unit catch-up`,
    },
    notNow: `Run ${stageName} on what is here`,
  } };
}

// `aidlc unit catch-up`: each repo of this checkout that lacks a merged Unit,
// on the branch the Units merged into, brought level with its remote
// (bringBranchLevel); nothing else moves.
function catchUp(projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  const behind = reposBehindMergedUnits(pd).filter((repo) => repo.branch !== null);
  const level: string[] = [];
  const lines: string[] = [];
  // A repo brought level by its reset names the commit it was at.
  const levelled: string[] = [];
  const nameOf = (repo: ReposBehind): string => (repo.repo === "." ? repo.into : repo.repo);
  for (const repo of behind) {
    git(repo.dir, ["fetch", "-q", repo.remote, repo.into]);
    const moved = bringBranchLevel(repo.dir, repo.remote, repo.into);
    if (moved.ok) {
      level.push(nameOf(repo));
      if (moved.was !== undefined) levelled.push(levelledLine(repo.remote, repo.into, moved.was));
    } else lines.push(`${nameOf(repo)} could not be brought up to date: git says "${gitSaid(moved.said)}". Build and Test runs on what is here.`);
  }
  const one = behind.length === 1 && behind[0].repo === "." ? behind[0] : null;
  if (level.length > 0) {
    lines.unshift(one !== null
      ? `${one.into} is up to date with ${one.remote}/${one.into} now, with every merged Unit.`
      : `${joinNames(level)} ${level.length === 1 ? "is" : "are"} up to date now, with every merged Unit.`);
    lines.splice(1, 0, ...levelled);
  }
  console.log(JSON.stringify({
    caught_up: level.length === behind.length,
    notice: lines.join(" "),
    step: "Tell the person in plain words what it reports, then run next.",
  }));
}

// The code Units built at the lead's project wrote in this repository (their
// Code Generation records here, in the workspace's own repo): the plan's share
// carries it, so the plan and what the teams build on reach the branch the
// work merges into together. None across repos, where that code is in repos of
// its own.
export function builtHereCode(projectDir: string): { units: string[]; paths: string[] } {
  const pd = resolveProjectDir(projectDir);
  const units: string[] = [];
  const paths: string[] = [];
  try {
    const state = readStateFile(pd);
    if (homeLocation(state) === null || unitBuildOf(state) !== null || intentRepos(pd).length > 0) return { units, paths };
  } catch {
    return { units, paths };
  }
  for (const unit of unitDependencies(pd).keys()) {
    const manifest = readUnitSourceManifest(pd, "code-generation", unit);
    if (!manifest.ok) continue;
    const here = unitWriteTargets(pd, manifest.manifest.writes).get(".")?.paths ?? [];
    if (here.length === 0) continue;
    units.push(unit);
    paths.push(...here);
  }
  return { units, paths };
}

// What the plan's share commits, as its question and its pull request choice
// name it: the plan, and the code of Units built here when that is in the
// commit (the files it changes, as workToCommitWords says them), or the plan
// alone, AI-DLC's record.
function planShareName(pd: string): string {
  const code = skeletonCodeName(pd);
  if (code !== null) return `${code.name} and AI-DLC's record`;
  const { units } = builtHereCode(pd);
  return planShareWork(pd) === null ? "the plan" : `the plan and ${units.length === 1 ? `${units[0]}'s code` : `the code of ${joinNames(units)}`}`;
}

export function planShareWork(pd: string): string | null {
  const { paths } = builtHereCode(pd);
  if (paths.length === 0) return null;
  const all = workToCommit(pd);
  const inShare = (path: string): boolean => path === "repos.json" || path.startsWith("aidlc/") ||
    paths.some((code) => path === code || (code.endsWith("/") && path.startsWith(code)));
  const work = { ...all, paths: all.paths.filter(inShare) };
  return work.paths.some((path) => !path.startsWith("aidlc/") && path !== "repos.json") ? workToCommitWords(pd, undefined, work) : null;
}

// Whether the plan's share would make a commit here: AI-DLC's record changed,
// or a Unit's code built here goes with it.
export function planToCommit(projectDir: string): boolean {
  const pd = resolveProjectDir(projectDir);
  return planShareWork(pd) !== null || recordChanged(pd) === true;
}

export function planShareWords(projectDir: string): string {
  const pd = resolveProjectDir(projectDir);
  const files = planShareWork(pd);
  return files === null ? "the plan here (AI-DLC's record, nothing else of yours)" : `${planShareName(pd)}, ${files},`;
}

// `branch` brought level with `remote`'s (bringBranchLevel), then this
// checkout put on it when it is on another, never over an ignored file of
// theirs; git's own words when either refused, nothing changed by the step
// that refused. `ownWork`: the branch has commits its remote's copy does not.
// The plan's way back and the take of the person's own merged build.
function levelAndSwitch(pd: string, remote: string, branch: string):
  { ok: true; from: string | null; was?: string } | { ok: false; at: "level" | "switch"; said: string; ownWork: boolean; block?: LevelBlock } {
  const here = git(pd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  const level = bringBranchLevel(pd, remote, branch);
  if (!level.ok) {
    // Work of theirs the remote's copy lacks by content, never by commits a squash merge left behind.
    const ownWork = level.block !== undefined ? level.block.why === "own-work"
      : headInByContent(pd, `refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`) === false;
    return { ok: false, at: "level", said: level.said, ownWork, ...(level.block === undefined ? {} : { block: level.block }) };
  }
  const was = level.was === undefined ? {} : { was: level.was };
  if (here === branch) return { ok: true, from: null, ...was };
  const switched = CHECKOUT_STEPS.switch.run(pd, branch);
  return switched.ok ? { ok: true, from: here || "the commit you were on", ...was } : { ok: false, at: "switch", said: switched.stderr, ownWork: false };
}

// The branch brought level, and the switch onto it refused.
function switchRefusedLine(branch: string, remote: string, here: string, said: string): string {
  return `Your ${branch} is level with ${remote} now, and you stay on ${here}: git says ${gitWords(said)}`;
}

// `unit share --back`: from the plan's branch onto the integration branch once
// the plan is in it: tried first in a copy of the index, then the branch
// brought level with the remote's (fast-forward only) and switched to. Never a
// reset, a stash, a force or a merge; when git refuses, nothing changed.
function planBranchBack(pd: string): void {
  const target = shareTarget(pd);
  if (target === null) fail("This repository has no remote to share main with. Add one (git remote add origin <url>), then share again.");
  const { remote, branch } = target;
  const here = git(pd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || "HEAD";
  // The plan's way back from its own branch keeps its words; a main left ahead
  // and behind, or a teammate's clone the lead's plan has not reached, hears
  // what happened to that main.
  const planBack = planBranchesHere(pd).includes(here);
  const planNotHere = !planBack && leadsPlanNotHere(pd);
  const moved = levelAndSwitch(pd, remote, branch);
  if (!moved.ok && moved.at === "level") {
    fail(planBack ? `You stay on ${here} and nothing changed: git says ${gitWords(moved.said)}` : levelRefusedLine(remote, branch, moved, planNotHere));
  }
  if (!moved.ok) fail(switchRefusedLine(branch, remote, here, moved.said));
  // The lead's plan is here now: the step goes on to the Units to take.
  const broughtPlan = planNotHere && !leadsPlanNotHere(pd);
  console.log(JSON.stringify({
    switched: true,
    branch,
    notice: moved.was !== undefined ? levelledLine(remote, branch, moved.was)
      : broughtPlan ? `Your ${branch} is up to date with ${remote}/${branch} now, with the lead's plan.`
      : `You are on ${branch} now, level with ${remote}.`,
    step: broughtPlan ? "Tell the person in plain words what it reports, then run next and follow what it returns."
      : "Tell the person in plain words what it reports, then end your turn.",
  }));
}

// The repo list, when its content differs from what HEAD has at either of
// its places (new, or changed; a pure move is the update's own question), git
// does not ignore it, and AI-DLC's record could be committed now
// (recordCommitBlock): the repos it lists and its blob, the offer's once. Null
// otherwise. Hashes, so a CRLF checkout of an unchanged list reads as unchanged.
export function reposListToCommit(pd: string, unitBuild: boolean): { names: string[]; blob: string } | null {
  const list = reposManifestPath(pd);
  if (!existsSync(list)) return null;
  const rel = relative(pd, list).replaceAll("\\", "/");
  if (git(pd, ["check-ignore", "-q", "--", rel]).ok) return null;
  const blob = git(pd, ["hash-object", "--", rel]).stdout.trim();
  if (blob === "") return null;
  const at = (path: string): string => git(pd, ["rev-parse", "--verify", "--quiet", `HEAD:./${path}`]).stdout.trim();
  if (blob === at("aidlc/repos.json") || blob === at("repos.json")) return null;
  if (recordCommitBlock(pd, unitBuild) !== null) return null;
  // The list's own reader, which keeps its comments; one it cannot read names no repo.
  const names = readWorkspaceRepos(pd).manifest?.repos.map((repo) => repo.name) ?? [];
  return names.length === 0 ? null : { names, blob };
}

// The question for that list, once for its blob, which also keys the file its
// commit message is drafted in; null when not due.
export function reposCommitOffer(pd: string, unitBuild: boolean): { mark: string; key: string; question: string } | null {
  const due = reposListToCommit(pd, unitBuild);
  if (due === null) return null;
  const key = due.blob.slice(0, 12);
  return {
    mark: teamHandoverMarkName("repos-commit", key),
    key,
    question: `repos.json now lists ${joinNames(due.names)}. Want me to commit AI-DLC's record in aidlc/, with the list, using this commit message?`,
  };
}

// `aidlc unit commit-record`: AI-DLC's own record (recordPaths) committed
// here, on the person's yes to an offer, through the share's one commit path
// (commitPlanHere), never the code Units built here. It takes no argument, so
// nothing else of theirs can be committed through it. recordCommitBlock's
// reason refuses it with nothing changed; nothing to commit is no failure. The
// commit it made is in its output. `--update`: AI-DLC's own files after an
// update in its place (ownFilesToCommit), in a Unit's build too. A settings
// file config merges goes in only where the session start's offer for this
// release drafted its message; asked any other way, it is left. `--leave`,
// once per file the session start saw changed before the refresh (it writes the
// whole command), leaves that file; a path that is not one inside the project
// is refused before git is asked anything.
function commitRecord(args: string[], projectDir?: string): void {
  const update = parseArgs(args).bareFlags.has("update");
  const leave: string[] = [];
  for (let at = 0; at < args.length && args[at] !== "--"; at++) {
    if (args[at] === "--leave") leave.push(args[++at] ?? "");
    else if (args[at].startsWith("--leave=")) leave.push(args[at].slice("--leave=".length));
  }
  const outside = leave.find((path) => path === "" || path.startsWith("-") || isAbsolute(path) || /^[A-Za-z]:/.test(path) ||
    path.split(/[\\/]/).includes(".."));
  // The agent's line, as checkUnitWords' is: met only when the command was not run as the session start wrote it.
  if (outside !== undefined) {
    console.error(JSON.stringify({
      error: `unit commit-record --leave takes a path inside this project, as the session start wrote it (such as ` +
        `.claude/settings.json), not ${JSON.stringify(outside)}: run the command exactly as it was written. Nothing was committed.`,
      usage: unitUsage("commit-record"),
    }));
    process.exit(2);
  }
  const pd = resolveProjectDir(projectDir);
  let state: string | null = null;
  try {
    state = readStateFile(pd);
  } catch {
    // No work selected: nothing here is a Unit's build.
  }
  const build = state === null ? null : unitBuildOf(state);
  // A Unit's build in the team's own workspace commits its own record there, as
  // its push does; where the lead's work is in this workspace too, aidlc/ holds
  // the lead's record, so it is not committed from here.
  const buildOwn = build !== null && !update && leadWorkHere(pd, build.homeWork) === null ? buildRecordPaths(pd) : undefined;
  const offered = existsSync(join(pd, ...unitWordsFile("record-message", UPDATE_MESSAGE_KEY).split("/")));
  const found = update ? ownFilesToCommit(pd, offered ? () => false : null) : null;
  const own = found && {
    commit: found.commit.filter((path) => !leave.includes(path)),
    left: [...found.left, ...found.commit.filter((path) => leave.includes(path))].sort(),
  };
  const block = recordCommitBlock(pd, build !== null, own?.commit ?? buildOwn);
  const what = own ? "AI-DLC's own files" : "AI-DLC's record";
  const left = own && own.left.length > 0 ? ` I left ${leftFilesNamed(own.left)} for you to look over and commit.` : "";
  if (block?.why === "nothing") {
    console.log(JSON.stringify({ committed: false, notice: own ? `AI-DLC's own files here have nothing new to commit.${left}` : "AI-DLC's record in aidlc/ has nothing new to commit." }));
    return;
  }
  if (block !== null) {
    fail(block.why === "under-way" ? underWayLine("This checkout", block.underWay, "nothing was committed", `commit ${what}`)
      : block.why === "detached" ? `This checkout is not on a branch, so nothing was committed. Switch to a branch, then I can commit ${what}.`
      : block.why === "unit-build" ? "This checkout builds a Unit, so I don't commit aidlc/ from here: it holds the lead's record too."
      : "This folder is not in a git repository, so nothing was committed.");
  }
  const given = givenCommitMessage(pd, args, "commit-record");
  let files: number;
  try {
    files = commitPlanHere(pd, given?.text ?? (own ? UPDATE_COMMIT_MESSAGE : RECORD_COMMIT_MESSAGE), false, own?.commit ?? buildOwn);
  } catch (error) {
    if (error instanceof CommitRefused) fail(`${error.message} ${messageWayOn(false)}`);
    throw error;
  }
  // The build's own record with nothing new in it: its paths are its folders, so git is the one to tell.
  if (files === 0) {
    console.log(JSON.stringify({ committed: false, notice: "AI-DLC's record in aidlc/ has nothing new to commit." }));
    return;
  }
  given?.spend();
  const branch = git(pd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  const commit = git(pd, ["rev-parse", "--short", "HEAD"]).stdout.trim();
  console.log(JSON.stringify({
    committed: true,
    commit,
    notice: `${own ? "AI-DLC's own files are" : "AI-DLC's record in aidlc/ is"} committed on ${branch} as ${commit} (${files} file${files === 1 ? "" : "s"}); nothing is pushed.${left}`,
  }));
}

// `unit share --plan` for the lead's own work teams build: the plan's ref,
// pushed to its repository; nothing is committed here and no branch is pushed.
function sharePlanRef(pd: string, given: ReturnType<typeof givenCommitMessage>, needs: string | null, named?: string): void {
  const plan = writeSharedPlan(pd, given?.text, named);
  if ("notShared" in plan) {
    console.log(JSON.stringify({ shared: false, ...plan.notShared }));
    return;
  }
  noteTeamShared(pd);
  given?.spend();
  const claims = claimsAskedHereWithShare(pd);
  const notice = [plan.said, ...claims.lines, ...(needs === null ? [] : [needs])];
  console.log(JSON.stringify({
    shared: true,
    plan: { repo: plan.repo, address: plan.address, commit: plan.commit },
    notice: notice.join(" "),
    step: "Tell the person in plain words what it reports, then end your turn.",
  }));
}

// The plan's repository has no address here: said once, with the way on
// (another repository only before the plan is shared).
export const planNoRemoteLine = (repo: string, later = false): string =>
  `${repo} has no remote here, so there is nowhere to put the plan yet. ` +
  (later ? "Give me its address and I'll share it." : "Give me its address, or name another repository the teams can read, and I'll share it there.");
export const PLAN_NOT_NOW = "Nothing is pushed; say when you want it shared.";

// The share's write of the plan: where it goes, written on its tip, and what
// the share says of it; a write that did not go stops the share with its line.
type SharedPlan = { repo: string; address: string; commit: string; said: string } | { notShared: { notice: string; step: string } };
function writeSharedPlan(pd: string, message?: string, named?: string): SharedPlan {
  const place = planPlaceForShare(pd, named);
  if ("refused" in place) {
    fail(place.refused === "option"
      ? `${JSON.stringify(place.named)} starts with "-", so git would read it as an option; nothing was pushed.`
      : `${place.named} is not a repository of this work or of repos.json, and not a git address, so nothing was pushed. ` +
        "Give me its address and I'll share the plan there.");
  }
  // Once the plan is shared, the way on is where it is.
  const later = planUnitsKept(pd) !== null;
  if (!("ref" in place)) fail(planNoRemoteLine(place.repo, later));
  // Once the plan is shared, naming another repository is the move, so the
  // way on is the same at every share.
  const retry = "Say when to try again, or name another repository the teams can read.";
  // Another repository named once the plan is shared: the plan moves there.
  const kept = named === undefined ? null : keptPlan(pd, place.id8);
  if (kept !== null && repoCopyKey(kept.plan.plan_repo.address) !== repoCopyKey(place.address)) {
    return movePlan(pd, { ...place, repo: kept.plan.plan_repo.name, address: kept.plan.plan_repo.address,
      copy: copyOf(kept.plan.plan_repo.address, place.ref) }, place, message);
  }
  // Another repository named where Home Location holds what a newer AI-DLC
  // wrote (a plan or its note): this one never shares beside it, as the plain
  // share there gives the update step.
  const home = named === undefined || kept !== null ? null : homeLocation(stateHere(pd) ?? "");
  if (home !== null && isGitAddress(home) && repoCopyKey(home) !== repoCopyKey(place.address)) {
    const at = { ...place, address: home, copy: copyOf(home, place.ref) };
    // This computer's copy first; with none here, one look there.
    if (!localGit(pd, ["rev-parse", "--verify", "--quiet", at.copy]).ok) {
      try {
        lookAtPlan(pd, at);
      } catch {
        // Not read there: the share goes on as it would.
      }
    }
    if (planAtCopy(pd, at.copy).kind === "newer") fail(newerPlanStep(pd));
  }
  let added: string[] = [];
  // The walking skeleton the plan held that the answer here takes out.
  let released: string | null = null;
  const skeletonHere = teamSkeletonOn(readStateFile(pd));
  const what = (tip: PlanJson | null): string => {
    added = tip === null ? [] : unitsNotIn(pd, tip.units.map((unit) => unit.name));
    released = tip !== null && tip.skeleton !== null && !skeletonHere ? tip.skeleton : null;
    return tip === null ? "shared" : added.length > 0 ? `${added.join(", ")} added` : "shared again";
  };
  // The share is the lead's own yes, so a tip that is not a plan is written
  // over as a commit on top, nothing lost; one of a newer AI-DLC never is.
  // Named: the place a note of this work at Home Location says the plan went,
  // which holds no plan now: the plan goes back there, from the plan under the note.
  const under = named === undefined ? null : planUnderNoteFor(pd, place);
  const written = writePlan(pd, place, {
    what, ...(message === undefined ? {} : { message }), overUnreadable: true, ...(named === undefined ? {} : { onNote: true as const }),
    ...(under === null ? {} : { regainFrom: under }),
    // A change this computer did not write is asked about before the share lands on it.
    stopIf: (tip) => tip === null ? undefined : planChangeAt(pd, tip.commit, tip.plan).change ?? undefined,
  });
  if (written.kind === "unfollowed") {
    if (written.follow.kind === "unread") fail(planNotFollowedLine(written.follow, "the plan is not shared", "Say when to try again."));
    return planNotHeldWay(pd, written.follow, place, "the plan is not shared");
  }
  // A write that followed the plan to where it moved went there, with the line said once for it.
  const went = (written.kind === "written" || written.kind === "unchanged") && written.followed !== undefined ? written.followed : null;
  const repo = went?.place.repo ?? place.repo;
  const address = maskUserinfo(went?.place.address ?? place.address);
  const followedLine = went === null ? [] : [went.line];
  // The work's Home Location is the plan's repository, where the lead put it.
  if (written.kind === "written" || written.kind === "unchanged") planHomeHere(pd, went?.place.address ?? place.address);
  if (written.kind === "unchanged") {
    return { repo, address, commit: written.commit, said: [...followedLine, `The plan in ${repo} already has everything here.`].join(" ") };
  }
  if (written.kind === "written") {
    // A Unit of the plan as written that still lists `unit` in what it waits on.
    const stillWaitedOn = (unit: string): boolean => keptPlan(pd, place.id8)?.plan.units.some((entry) => entry.waits_on.includes(unit)) ?? false;
    const said = written.underNote
      ? `The plan was no longer in ${repo}, so I shared it again, with what was decided on each Unit as the plan had it when it moved.`
      : written.regained
      ? `The plan was no longer in ${repo}, so I shared it again, with what you decided on each Unit as this computer last had it.`
      : written.over?.onNote
        ? `The plan is shared again in ${repo}, over the note that it moved, with what was decided on each Unit as the plan had it when it moved.`
      : written.over !== undefined
        ? `The plan in ${repo} is shared again over what was there, ` + (written.over.carried
          ? "with what was decided on each Unit as the plan last had it."
          : "from your own record here. What you had decided on its Units was not there to carry, so it is not on the plan now.")
      : written.created
        ? `The plan is shared in ${repo}. AI-DLC sends no notice of it: the teams hear it from you. A team whose workspace has no ` +
          `${repo} needs this address: ${address}`
        : added.length > 0 || released !== null
          ? [...(added.length > 0 ? [`The plan in ${repo} has ${namesInProse(added)} now.`] : []),
            ...(released !== null ? [`The plan in ${repo} has your answer now${stillWaitedOn(released) ? "." : `: no Unit in it waits on ${released}.`}`] : [])].join(" ")
          : `The plan is shared in ${repo}.`;
    const told = written.back === undefined ? said : `${said} ${planBackLine(repo, written.back)}`;
    return { repo, address, commit: written.commit, said: [...followedLine, told].join(" ") };
  }
  if (written.kind === "unreached") {
    fail(`${repo} could not be reached, so the plan is not shared${written.words === null ? "." : `: git says "${written.words}".`} Say when to try again.`);
  }
  if (written.kind === "stale") fail(`The plan in ${repo} kept changing while I wrote on it, so nothing was written. Say when to try again.`);
  // Only a plan of a newer AI-DLC is never written over: the update step.
  if (written.kind === "unreadable") fail(newerPlanStep(pd));
  // The lead's question first: once they answer, the same share again.
  if (written.kind === "stopped") {
    const ask = planChangeQuestion(written.detail as PlanChange);
    const question = written.followed === undefined ? ask.question : `${written.followed.line} ${ask.question}`;
    throw new LeadWordUnwritten(question, [aidlcToolInvocation("unit"), ...invokedArgs.map(shellArg)].join(" "), ask);
  }
  // A rule of the host's (a message rule among them): the person's own
  // message has a way in, though the share asked for none.
  // The person's own message is asked for once: with theirs refused too, the
  // way on is another repository, never the same question.
  if (written.byRule && message === undefined) {
    return messageWayIn(pd, `${repo} did not take the plan: ${written.words}. If it is the commit message, tell me the one to use, and I will share it with that.`,
      named);
  }
  fail(`${repo} did not take the plan: ${written.words}. ${retry}`);
}

// A host rule that may be on the commit message: the person's own message is
// the way in, written to the share's message file and passed with the same
// command (`named`, its --repo).
function messageWayIn(pd: string, notice: string, named?: string): SharedPlan {
  const file = commitMessageFile(pd, "share", "plan");
  return { notShared: {
    notice,
    step: "Tell the person in plain words what it reports, then end your turn. When they give the commit message, write it to " +
      `${file} with your file tool, exactly as they gave it, then run ` +
      `\`${aidlcInvocation()} unit share --plan${named === undefined ? "" : ` --repo ${shellArg(named)}`} --commit-message-file ${file}\` ` +
      "and tell them in plain words what it reports.",
  } };
}

// The way on at this work's note whose place does not hold the plan: the share
// again where the note says, when that place holds nothing; else on top of the
// note where it is. `then`: the move asked for, run after the share's yes in
// the same step, so the person never asks for it twice.
function planNotHeldWay(pd: string, follow: Extract<PlanFollow, { kind: "not-followed" }>, place: PlanPlace, tail: string,
  then?: string): SharedPlan {
  const yes = planShareAgainRepo(pd, follow, place);
  return { notShared: {
    notice: planNotFollowedLine(follow, tail, planShareAgainOffer(follow, place.repo)),
    step: "Tell the person in plain words what it reports, then end your turn. " + (then === undefined
      ? `When they say yes, run \`${aidlcInvocation()} unit share --plan --repo ${shellArg(yes)}\` and tell them in plain words what it reports.`
      : shareThenWord(then, yes, "the move's")),
  } };
}

// What a place's tip is to a move: nothing, this work's plan, this work's note,
// a plan of a newer AI-DLC, or something else.
type MoveTip = { kind: "none" } | { kind: "plan"; commit: string; plan: PlanJson } | { kind: "note"; commit: string } |
  { kind: "newer" } | { kind: "other"; commit: string };
function moveTipAt(pd: string, place: PlanPlace, tip: string | null): MoveTip {
  if (tip === null) return { kind: "none" };
  const read = planAtCopy(pd, place.copy, { commit: tip });
  return read.kind === "read" ? { kind: "plan", commit: tip, plan: read.plan } : read.kind === "moved" ? { kind: "note", commit: tip }
    : read.kind === "newer" ? { kind: "newer" } : { kind: "other", commit: tip };
}

// The note a moved plan leaves: plan.json alone, the pointer, on `parent`.
function pointerCommit(pd: string, parent: string | null, pointer: PlanPointer, message: string): string {
  const blob = git(pd, ["hash-object", "-w", "--no-filters", "--stdin"], undefined, `${JSON.stringify(pointer, null, 2)}\n`);
  if (!blob.ok) fail(`git hash-object failed: ${blob.stderr.trim()}`);
  const tree = git(pd, ["mktree"], undefined, `100644 blob ${blob.stdout.trim()}\tplan.json\n`);
  if (!tree.ok) fail(`git mktree failed: ${tree.stderr.trim()}`);
  return commitAsPerson(pd, tree.stdout.trim(), parent === null ? [] : [parent], message);
}

// The plan just written at a place taken back, only while nothing came on top:
// what was there before (`was`, this work's note at a move back) goes back,
// and where nothing was, the ref goes.
function takeBackPlan(pd: string, place: PlanPlace, commit: string, was: string | null): boolean {
  const via = gitTargetFor(pd, place.address, "push");
  const back = git(pd, ["push", via.target, `--force-with-lease=${place.ref}:${commit}`, `${was ?? ""}:${place.ref}`],
    { ...via.env, GIT_TERMINAL_PROMPT: "0" });
  if (back.ok) localGit(pd, was === null ? ["update-ref", "-d", place.copy] : ["update-ref", place.copy, was]);
  return back.ok;
}

// The once-mark of the plan's share question: the first share, or the Units added since.
export function planShareMarkName(added: readonly string[] | null): string {
  return teamHandoverMarkName("share", added === null ? "plan" : `plan-${[...added].sort().join("-")}`);
}

// The share question for the Units the plan does not have yet is the step this
// work last handed out: a share run now is its yes.
// `marker` is the step read before the move wrote anything here: Home
// Location is in the state the marker is bound to.
function shareQuestionOpen(pd: string, marker: ActiveDirectiveMarker | null, added: readonly string[]): boolean {
  if (added.length === 0) return false;
  return marker?.kind === "ask" && marker.ask_type === "team-handover" && engineAskMark(pd, planShareMarkName(added)) !== null;
}

// The person's request to put the shared plan in another repository: the plan
// at the new place as one commit on the old tip (its history with it, only
// where it lives and its version changed), then the note at the old place on
// that same tip; a note the old place does not take leaves no second plan (the
// one just written is taken back). Then the lead's Home Location is the new
// place, and what the share question it answers asked for is shared there.
function movePlan(pd: string, start: PlanPlace, to: PlanPlace, message: string | undefined): SharedPlan {
  const address = maskUserinfo(to.address);
  const step = readActiveDirectiveMarker(pd, readStateFile(pd));
  let from = start;
  let kept = planShared(pd, from);
  // Said first when the plan had moved already, on another computer: its
  // Home Location is changed by then, so no later step says it.
  const followedLines: string[] = [];
  const end: (line: string) => never = (line) => fail([...followedLines, line].join(" "));
  const tries = 3;
  for (let attempt = 1; ; attempt++) {
    const lookOld = lookAtPlan(pd, from);
    // Not reached: the move goes on from this computer's copy of the old place
    // only to a new place that holds a copy of the plan or nothing, and writes
    // nothing at the old one.
    const gone = lookOld.unreached;
    const notReached = `${from.repo} could not be reached, so the plan was not moved${gone === null || gone === undefined ? "." : `: git says "${gone}".`} ` +
      "Say when to try again.";
    if (gone !== undefined && lookOld.tip === null) end(notReached);
    const old = moveTipAt(pd, from, lookOld.tip);
    if (old.kind === "newer") end(newerPlanStep(pd));
    // Moved already from there, on another computer: followed, then moved from where it is.
    if (old.kind === "note") {
      const met = followMoved(pd, from.id8, from.address, true, { say: false });
      const follow = met?.follow ?? null;
      if (follow === null || follow.kind === "newer") end(newerPlanStep(pd));
      if (follow.kind === "unread") end(planNotFollowedLine(follow, `it was not moved on to ${to.repo}`, "Say when to try again."));
      if (follow.kind === "not-followed") {
        const named = planRepos(pd).some((entry) => entry.name === to.repo) ? to.repo : to.address;
        return planNotHeldWay(pd, follow, from, `it was not moved on to ${to.repo}`, `${aidlcInvocation()} unit share --plan --repo ${shellArg(named)}`);
      }
      const line = met?.leadLine ?? null;
      if (line !== null) followedLines.push(line);
      from = { ...from, repo: follow.repo, address: follow.address, copy: follow.copy };
      kept = planShared(pd, from);
      if (repoCopyKey(from.address) === repoCopyKey(to.address)) {
        const shared = writeSharedPlan(pd, message);
        return "said" in shared ? { ...shared, said: [...followedLines, shared.said].join(" ") } : shared;
      }
      attempt--;
      continue;
    }
    // What moves: the old tip's plan, the plan under what is there now, or
    // this computer's copy of a plan that is no longer there.
    const below = old.kind === "other" ? planBelow(pd, old.commit, from.uuid) : null;
    const fromCopy = old.kind === "none" || (old.kind === "other" && below === null);
    const base = old.kind === "plan" ? old : below ?? kept;
    // No copy here either: the plan from the lead's own record, as a first share builds it.
    const fromRecord = base === null ? planFilesNow(pd, null, to) : null;
    if (old.kind === "plan") {
      const change = planChangeAt(pd, old.commit, old.plan).change;
      if (change !== null) {
        const ask = planChangeQuestion(change);
        throw new LeadWordUnwritten([...followedLines, `Before I write the plan's move to ${to.repo}: ${ask.question}`].join(" "),
          [aidlcToolInvocation("unit"), ...invokedArgs.map(shellArg)].join(" "), ask);
      }
    }
    const lookNew = lookAtPlan(pd, to);
    if (lookNew.unreached !== undefined) {
      end(`${to.repo} could not be reached, so the plan stays in ${from.repo}${lookNew.unreached === null ? "." : `: git says "${lookNew.unreached}".`} Say when to try again.`);
    }
    const there = moveTipAt(pd, to, lookNew.tip);
    if (there.kind === "newer") end(newerPlanStep(pd));
    const elsewhere = `${to.repo} already holds something else where the plan would go, so nothing was moved: the plan stays in ${from.repo}.`;
    // This work's plan there naming the old place: a copy of it (a mirror made
    // to move hosts), or the same repository under another name, which only
    // the old place can tell after the write below. It is taken over only on
    // the old tip read here, when that holds it.
    const copyThere = there.kind === "plan" && repoCopyKey(there.plan.plan_repo.address) === repoCopyKey(from.address);
    // With the old place not reached, the copy there may be newer than this
    // computer's: the plan is then written on it.
    const copyNewer = gone !== undefined && copyThere && old.kind === "plan" && there.commit !== old.commit &&
      localGit(pd, ["merge-base", "--is-ancestor", old.commit, there.commit]).ok;
    if (copyThere && !copyNewer && (old.kind !== "plan" || !localGit(pd, ["merge-base", "--is-ancestor", there.commit, old.commit]).ok)) {
      end(gone === undefined ? elsewhere : notReached);
    }
    if (copyNewer && there.kind === "plan") {
      const change = planChangeAt(pd, there.commit, there.plan).change;
      if (change !== null) {
        const ask = planChangeQuestion(change);
        throw new LeadWordUnwritten([...followedLines, `Before I write the plan's move to ${to.repo}: ${ask.question}`].join(" "),
          [aidlcToolInvocation("unit"), ...invokedArgs.map(shellArg)].join(" "), ask);
      }
    }
    // This work's plan there naming that place, with the old tip under it: the
    // plan is there already (taken over from another computer of the lead's),
    // and written again it would lose what was written there since.
    const already = there.kind === "plan" && !copyThere && repoCopyKey(there.plan.plan_repo.address) === repoCopyKey(to.address) &&
      old.kind === "plan" && localGit(pd, ["merge-base", "--is-ancestor", old.commit, there.commit]).ok;
    if (there.kind === "other" || (there.kind === "plan" && !copyThere && repoCopyKey(there.plan.plan_repo.address) !== repoCopyKey(to.address))) {
      end(elsewhere);
    }
    // Where the plan is now, followed as a note is: Home Location there, the
    // builds here re-keyed, said once; nothing written over it.
    const followThere = (now: PlanJson, oid: string): SharedPlan => {
      const line = leadFollowsPlan(pd, undefined, { kind: "followed", label: now.work.label, repo: to.repo, address: to.address, copy: to.copy, oid, plan: now });
      const read = planAt(pd, to);
      if (read.kind === "read") followBuildsTo(pd, read.plan, from.address);
      return { repo: to.repo, address, commit: oid, said: [...followedLines, line ?? ""].join(" ").trim() };
    };
    // Written there by another computer and parted from the old tip (each
    // holds what the other does not): a write on the old tip would replace the
    // living plan there.
    if (there.kind === "plan" && !copyThere && !already && old.kind === "plan" && engineAskMark(pd, planMark("here", there.commit)) === null &&
      !localGit(pd, ["merge-base", "--is-ancestor", there.commit, old.commit]).ok) {
      return followThere(there.plan, there.commit);
    }
    // The old place not reached: the plan already there is followed; past
    // that, only a copy of it or nothing there lets the move go on.
    if (gone !== undefined && already && there.kind === "plan") return followThere(there.plan, there.commit);
    if (gone !== undefined && !copyThere && there.kind !== "none") end(notReached);
    // At the new place: nothing, a move that stopped there before, this work's note (a move back), or a copy.
    const lease = there.kind === "none" ? null : there.commit;
    // A copy taken over names the plan's repositories as the lead's workspace
    // spells them now: a Unit's record resolves by them, so a build's record
    // push would otherwise still go to the old host.
    const spelled = (repos: PlanJson["repos"]): PlanJson["repos"] => repos.map((repo) =>
      ({ ...repo, address: planRepos(pd).find((entry) => entry.name === repo.name && entry.address !== null)?.address ?? repo.address }));
    const source = copyNewer && there.kind === "plan" ? { commit: there.commit, plan: there.plan } : base;
    // The repository the plan was in stays listed: a Unit's record may be
    // there, read by the list once the plan names another place, and the
    // work's list may not name it (a first share outside it).
    const listed = (repos: PlanJson["repos"], was: PlanJson["plan_repo"]): PlanJson["repos"] =>
      repos.some((repo) => repo.name === was.name) ? repos : [...repos, { name: was.name, address: was.address, branch: null }];
    const plan: PlanJson = source === null ? fromRecord!.plan
      : { ...source.plan, plan_repo: { name: to.repo, address: to.address }, version: source.plan.version + 1,
        repos: listed(copyThere || gone !== undefined ? spelled(source.plan.repos) : source.plan.repos, source.plan.plan_repo) };
    // From this computer's copy, the plan goes on that copy, so nothing that
    // stood in its place at the old place is carried into the new repository.
    const moved = already && there.kind === "plan" ? there.commit : base === null ? planCommit(pd, null, plan, fromRecord!.files, "shared", message)
      : planCommit(pd, copyNewer && there.kind === "plan" ? there.commit : fromCopy ? base.commit : old.commit, plan, {}, "shared again", message);
    const placed = already ? { ok: true as const } : pushPlan(pd, to, moved, lease);
    if (!placed.ok) {
      const after = placed.timedOut ? { unreached: null } : lookAtPlan(pd, to);
      if (after.unreached !== undefined) {
        end(`${to.repo} could not be reached, so the plan stays in ${from.repo}${after.unreached === null ? "." : `: git says "${after.unreached}".`} Say when to try again.`);
      }
      if (placed.lost && attempt < tries) continue;
      end(placed.lost ? `The plan in ${from.repo} kept changing while I moved it, so nothing was moved. Say when to try again.`
        : `${to.repo} did not take the plan, so it stays in ${from.repo}: ${placed.words}. Say when to try again.`);
    }
    if (!already) noteEngineAskMark(pd, planMark("here", moved));
    // One repository under two names shows the plan just written at the old
    // name too: taken back, as the teams read it. Any other change there since
    // the look is another writer's: taken back, and the next try.
    if (copyThere && old.kind === "plan" && gone === undefined) {
      const shown = lookAtPlan(pd, from);
      if (shown.unreached !== undefined || shown.tip !== old.commit) {
        const back = takeBackPlan(pd, to, moved, lease);
        localGit(pd, ["update-ref", from.copy, old.commit]);
        if (shown.tip === moved) end(`${to.repo} is the same repository as ${from.repo} under another name, so the plan stays in ${from.repo}.`);
        if (shown.unreached !== undefined) {
          end(`${from.repo} could not be reached, so the plan was not moved${shown.unreached === null ? "." : `: git says "${shown.unreached}".`} Say when to try again.`);
        }
        if (back && attempt < tries) continue;
        break;
      }
    }
    const pointer: PlanPointer = { format: PLAN_FORMAT, work: plan.work, moved_to: { name: to.repo, address: to.address } };
    const noteOid = pointerCommit(pd, old.kind === "none" ? null : old.commit, pointer, message ?? `aidlc plan ${plan.work.label}: moved to ${to.repo}`);
    const noted = gone !== undefined ? { ok: true as const } : pushPlan(pd, from, noteOid, old.kind === "none" ? null : old.commit);
    let overLine: string | null = gone === undefined ? null :
      `The plan is in ${to.repo} now, with what you decided on each Unit as this computer last had it. ${from.repo} could not be reached` +
      `${gone === null ? "" : ` (git says "${gone}")`}, so nothing was written there and ${from.repo} does not say where the plan went. Give each team ` +
      `${to.repo}'s address: until a team's AI-DLC has it, its builds look for the plan in ${from.repo}. Its earlier versions are readable in ${to.repo}.`;
    if (!noted.ok) {
      const after = noted.timedOut ? { unreached: null } : lookAtPlan(pd, from);
      // The old place refusing the note, still as it was: it refuses the lead's
      // other writes too, so the plan stays where it is now, and the lead hears
      // that the old place does not say so.
      const keep = !noted.lost && !noted.timedOut && after.unreached === undefined && after.tip === (old.kind === "none" ? null : old.commit);
      // Where the old place took the plan under the person's own message, a
      // rule on the message is likely: their message is the way in first.
      if (keep && !already && message === undefined && old.kind === "plan" &&
        !/^aidlc plan /.test(localGit(pd, ["log", "-1", "--format=%s", old.commit]).stdout.trim())) {
        takeBackPlan(pd, to, moved, lease);
        const named = planRepos(pd).some((entry) => entry.name === to.repo) ? to.repo : to.address;
        return messageWayIn(pd, `${from.repo} did not take the note that the plan moved, so the plan stays in ${from.repo}: ${noted.words}. ` +
          "If it is the commit message, tell me the one to use, and I will move the plan with that.", named);
      }
      if (keep && already && there.kind === "plan") return followThere(there.plan, moved);
      if (keep) {
        overLine = `The plan is in ${to.repo} now, with what was decided on each Unit. ${from.repo} did not take the note that the plan moved ` +
          `(${noted.words}), so nothing was written there and ${from.repo} does not say where the plan went. Give each team ${to.repo}'s address: ` +
          `until a team's AI-DLC has it, its builds read the plan in ${from.repo} as it was. Its earlier versions stay readable in both.`;
      }
    }
    if (!noted.ok && overLine === null) {
      const after = noted.timedOut ? { unreached: null } : lookAtPlan(pd, from);
      if (noted.lost && after.unreached === undefined && attempt < tries) {
        if (!takeBackPlan(pd, to, moved, lease)) break;
        continue;
      }
      const copyLeft = takeBackPlan(pd, to, moved, lease) ? "" :
        ` A copy of it is still in ${to.repo} and is not kept up to date; trying again finishes the move or takes the copy back.`;
      end((noted.lost ? `The plan in ${from.repo} kept changing while I moved it, so nothing was moved.`
        : after.unreached !== undefined
          ? `${from.repo} could not be reached to write the note that the plan moved, so the plan stays in ${from.repo}` +
            `${after.unreached === null ? "." : `: git says "${after.unreached}".`}`
          : `${from.repo} did not take the note that the plan moved, so the plan stays in ${from.repo}: ${noted.words}.`) +
        `${copyLeft} Say when to try again.`);
    }
    if (overLine === null) noteEngineAskMark(pd, planMark("here", noteOid));
    planHomeHere(pd, to.address);
    if (overLine !== null) {
      const read = planAt(pd, to);
      if (read.kind === "read") followBuildsTo(pd, read.plan, from.address);
    }
    const added = unitsNotIn(pd, plan.units.map((unit) => unit.name));
    const moveLine = overLine ?? (base === null
      ? `The plan was no longer in ${from.repo}, and this computer had no copy of it; it is in ${to.repo} now from your own record here, and ` +
        `${from.repo} says where it went. What was decided on its Units before was not there to carry, so it is not on the plan now.`
      : fromCopy
      ? `The plan was no longer in ${from.repo}; it is in ${to.repo} now, with what you decided on each Unit as this computer last had it, and ${from.repo} says where it went. ` +
        `Its earlier versions are readable in ${to.repo}.`
      : `The plan is in ${to.repo} now, with what was decided on each Unit, and ${from.repo} says where it went. ` +
        // Its history is under the note there and under the plan here; a
        // plan moved from this computer's copy has none under the note.
        "Its earlier versions stay readable in both.");
    const readAccess = `Each team needs read access to ${to.repo}; AI-DLC sends no notice of the move.`;
    const addressLine = `${to.repo}'s address: ${address}`;
    // The share rides the move only as the yes of the open share question.
    if (!shareQuestionOpen(pd, step, added)) {
      const notYet = added.length === 0 ? [] : [`${namesInProse(added)} ${added.length === 1 ? "is" : "are"} not on it yet: say when to share it.`];
      return { repo: to.repo, address, commit: moved, said: [...followedLines, moveLine, readAccess, ...notYet, addressLine].join(" ") };
    }
    const shared = writePlan(pd, to, {
      what: `${added.join(", ")} added`, ...(message === undefined ? {} : { message }),
      stopIf: (tip) => tip === null ? undefined : planChangeAt(pd, tip.commit, tip.plan).change ?? undefined,
    });
    const said = [...followedLines, moveLine, readAccess, addressLine];
    // The lead's question first, with the move said: once they answer, the same command shares.
    if (shared.kind === "stopped") {
      const ask = planChangeQuestion(shared.detail as PlanChange);
      throw new LeadWordUnwritten([...said, ask.question].join(" "), [aidlcToolInvocation("unit"), ...invokedArgs.map(shellArg)].join(" "), ask);
    }
    const names = namesInProse(added);
    const shareLine = shared.kind === "written" || shared.kind === "unchanged" ? `The plan in ${to.repo} has ${names} now.`
      : shared.kind === "unreached"
        ? `${to.repo} could not be reached, so ${names} ${added.length === 1 ? "is" : "are"} not on the plan yet` +
          `${shared.words === null ? "." : `: git says "${shared.words}".`} Say when to try again.`
      : shared.kind === "refused" ? `${to.repo} did not take ${names} onto the plan: ${shared.words}. Say when to try again.`
      : null;
    // Any other end (the plan kept changing, a note or a plan of a newer
    // AI-DLC there by now): the move-only line, which says the Units are not on it.
    if (shareLine === null) {
      return { repo: to.repo, address, commit: moved,
        said: [...followedLines, moveLine, readAccess, `${names} ${added.length === 1 ? "is" : "are"} not on it yet: say when to share it.`, addressLine].join(" ") };
    }
    return { repo: to.repo, address, commit: shared.kind === "written" || shared.kind === "unchanged" ? shared.commit : moved, said: [...said, shareLine].join(" ") };
  }
  end(`The plan in ${from.repo} kept changing while I moved it, so nothing was moved. A copy of it is still in ${to.repo} and is not kept ` +
    "up to date; trying again finishes the move or takes the copy back. Say when to try again.");
}

// The Units of the lead's Unit plan here that `listed` does not name.
function unitsNotIn(pd: string, listed: readonly string[]): string[] {
  return [...unitDependencies(pd).keys()].filter((unit) => !listed.includes(unit));
}

// Where the plan is its own ref, a share without --plan committed AI-DLC's record and shared no plan: the line that
// says so with the offer, and the agent's step for the yes.
function planNotSharedByThis(pd: string): { line: string; onYes: string } | null {
  const place = sharesPlanRef(pd) ? planPlaceForShare(pd) : null;
  if (place === null || !("repo" in place)) return null;
  const yes = `${aidlcInvocation()} unit share --plan`;
  return {
    line: `The plan was not shared by this: I can share it in ${place.repo} when you say so, or you can run \`${yes}\`.`,
    onYes: ` When they say yes, run \`${yes}\` and tell them in plain words what it reports.`,
  };
}

// `aidlc unit share`: commit the work here and push the integration branch to
// the remote, so the teams can take Units (after Inception) or see a landed
// one. A plain push, never forced. A share that did not happen (a commit git
// refused, a push the remote refused) keeps what it committed and leaves both
// offers due again (their marks cleared), so the next step asks again instead
// of building here; a plan's share a host's rule refuses is said once instead,
// and the next step offers to put it on a branch of its own. `--branch`: the
// plan on that branch, pushed for a pull request (putPlanOnItsBranch);
// `--back`: from that branch onto the integration branch once the plan is in
// it (planBranchBack).
// `--plan`: AI-DLC's record (the plan a team's clone takes its Unit from), for
// a home whose teams take Units by pull request, with the code of Units built
// here on the workspace's own repository; none of the person's other files
// here is committed. A share without --plan at the lead's own team work commits
// the same, then pushes the integration branch.
function shareMain(args: string[], projectDir?: string): void {
  const pd = resolveProjectDir(projectDir);
  const parsed = parseArgs(args);
  const flags = parsed.bareFlags;
  const repoNamed = parsed.flags.repo;
  if (flags.has("back")) {
    planBranchBack(pd);
    return;
  }
  const refused = shareRefusal(pd, flags.has("plan"));
  // On a branch of the person's own, the share goes on to commit AI-DLC's
  // record there and pushes nothing (below).
  if (refused !== null && refused.off === undefined) fail(refused.reason);
  const needs = teammatesNeedLine(pd);
  const planOnly = flags.has("plan");
  const given = givenCommitMessage(pd, args, "share");
  const again = `${aidlcInvocation()} unit share${flags.has("branch") ? " --branch" : ""}${planOnly ? " --plan" : ""}` +
    (repoNamed === undefined ? "" : ` --repo ${shellArg(repoNamed)}`) +
    (given === null ? "" : ` --commit-message-file ${shellArg(given.file)}`);
  // The branch the share pushes, read from the team's own words before
  // anything is committed or pushed; the offers stay due in case the share
  // does not run again.
  const toRead = integrationBranchToRead(pd);
  if (toRead !== null) {
    clearTeamHandoverMarks(pd, ["share", "push"]);
    console.log(JSON.stringify({
      shared: false,
      step: integrationBranchReadStep(toRead, `then run \`${again}\` again and tell the person in plain words what it reports`),
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
        `then run \`${again}\` again and tell the person in plain words what it reports.`,
    }));
    return;
  }
  if (planOnly && sharesPlanRef(pd)) {
    sharePlanRef(pd, given, needs, repoNamed);
    return;
  }
  // A walking skeleton's code built here goes to main with the lead's record,
  // after the plan's own ref, so the teams' plan never waits on main.
  const planFirst = planOnly && leadsOwnTeamWork(pd) ? writeSharedPlan(pd, undefined, repoNamed) : null;
  // Named before the commit takes them out of what is built here.
  const codeHere = planFirst === null ? null : skeletonCodeName(pd);
  if (planFirst !== null && "notShared" in planFirst) {
    console.log(JSON.stringify({ shared: false, ...planFirst.notShared }));
    return;
  }
  const { remote, branch } = shareTarget(pd)!;
  const landed = landedNotOnRemote(pd).map((row) => row.unit);
  const message = given?.text ?? shareDefaultMessage(pd);
  const before = git(pd, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim();
  // The share's own commits a host refused earlier, the only ones on the
  // branch the remote lacks: `--branch` moves them as they are, so a refused
  // branch push changes nothing.
  const ahead = landed.length === 0 && before !== "" ? shareCommitsAhead(pd, remote, branch, before) : null;
  const earlier = ahead?.noted ? ahead.oids : null;
  // The plan's own branch takes a typed share while its pull request is open.
  const own = refused?.off !== undefined && planBranchesHere(pd).includes(refused.off.current) &&
    !planBranchMerged(pd, { remote, branch }, refused.off.current) ? refused.off.current : null;
  let committed = 0;
  let named: string | null = null;
  if (!(flags.has("branch") && earlier !== null && earlier.length > 0)) {
    try {
      if (planOnly || refused !== null || leadsOwnTeamWork(pd)) {
        committed = commitPlanHere(pd, message);
      } else {
        const done = commitWorkHere(pd, message);
        committed = done.committed;
        named = workToCommitWords(pd, undefined, done.taken);
      }
    } catch (error) {
      clearTeamHandoverMarks(pd, ["share", "push"]);
      // A commit git or their hook turned away: the one way on, which pushes too unless the share stops at the commit here.
      fail(`${errorMessage(error)} ${error instanceof CommitRefused ? messageWayOn(!(refused !== null && own === null)) : "Then share again."}`);
    }
  }
  const head = git(pd, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim();
  const madeNow = head !== before ? head : null;
  // Their branch reaches the integration branch their own way: never pushed
  // from here. The plan's own branch, which its push gave an upstream, takes
  // the share, so its pull request carries the newer plan.
  if (refused !== null) {
    // Committed on a branch of their own, which reaches main their own way: done.
    if (own === null) {
      given?.spend();
      // The plan went to its own repository first: its line, then what is committed on their branch.
      const sharedFirst = planFirst !== null && "said" in planFirst && codeHere !== null && refused.off !== undefined
        ? `${planFirst.said} ${codeHere.name} and AI-DLC's record are committed on ${refused.off.current} and not ` +
          `pushed: push ${refused.off.current} and get it merged your usual way. The other Units wait on ${codeHere.units} until ` +
          `${codeHere.is === "is" ? "it is" : "they are"} in ${branch}.`
        : null;
      const notShared = sharedFirst !== null || refused.off === undefined ? null : planNotSharedByThis(pd);
      console.log(JSON.stringify({
        shared: sharedFirst !== null,
        notice: sharedFirst ?? (notShared === null
          ? `${refused.reason} ${planWayOn(branch)}`
          : `This checkout is on ${refused.off!.current}, not ${branch}, so AI-DLC's record of this work is committed here and nothing ` +
            `is pushed. ${notShared.line}`),
        step: `Tell the person in plain words what it reports, then end your turn.${notShared?.onYes ?? ""}`,
      }));
      return;
    }
    const sent = git(pd, ["push", remote, `HEAD:refs/heads/${own}`], { GIT_TERMINAL_PROMPT: "0" });
    if (!sent.ok) fail(`${remote} did not take ${own}: ${pushRefusal(sent.stderr)}.`);
    given?.spend();
    console.log(JSON.stringify({
      shared: false,
      branch: own,
      remote,
      committed_paths: committed,
      notice: `The plan's newer changes are pushed on ${own}, so its pull request has them.`,
      step: "Tell the person in plain words what it reports, then end your turn.",
    }));
    return;
  }
  if (flags.has("branch") && putPlanOnItsBranch(pd, remote, branch, madeNow, planOnly, needs)) {
    given?.spend();
    return;
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
  // A host's rule on the branch (a protected branch, a ruleset, a hook), not
  // a push behind it or a lost race for its lock. The plan's offer keeps its
  // mark, so it is not put again; main's share comes before a Unit starts here,
  // so its offers are due again, never a build here. The plan's share, on a
  // branch that had nothing else the remote lacked, is noted with its commit
  // and counts as done here: the next step offers once to put it on a branch
  // of its own (planWait); otherwise the person's own way on.
  if (!pushed.ok && refusedByHostRule(pushed.stderr)) {
    if (!planOnly) clearTeamHandoverMarks(pd, ["share", "push"]);
    if (earlier === null || (madeNow === null && earlier.length === 0)) fail(`${remote} takes no direct push to ${branch} (${pushRefusal(pushed.stderr)}). ${planWayOn(branch)}`);
    if (madeNow !== null) noteEngineAskMark(pd, shareCommitMark(madeNow));
    noteTeamShared(pd);
    given?.spend();
    console.log(JSON.stringify({
      shared: false,
      notice: (planFirst === null
        ? `${remote} takes no direct push to ${branch} (${pushRefusal(pushed.stderr)}), so the plan is not shared yet.`
        : `The plan is shared in ${planFirst.repo}, and ${remote} takes no direct push to ${branch} (${pushRefusal(pushed.stderr)}), so ` +
          `${namesInProse(builtHereCode(pd).units.map((unit) => `${unit}'s code`))} is not in ${branch} yet.`) + (needs === null ? "" : ` ${needs}`),
      step: `Tell the person in plain words what it reports, then run \`${aidlcToolInvocation("orchestrate")} next\` and follow what it returns.`,
    }));
    return;
  }
  if (!pushed.ok) {
    clearTeamHandoverMarks(pd, ["share", "push"]);
    fail(
      `${remote} did not take ${branch}: ${pushRefusal(pushed.stderr)}. ` +
        `${committed > 0 ? "The commit is kept here: " : ""}pull ${branch}, then share again.`,
    );
  }
  noteTeamShared(pd);
  given?.spend();
  const claims = claimsAskedHereWithShare(pd);
  const notShared = planOnly ? null : planNotSharedByThis(pd);
  const notice = [
    ...(planFirst === null ? [] : [planFirst.said]),
    ...claims.lines,
    ...(needs === null ? [] : [needs]),
    ...(notShared === null ? [] : [notShared.line]),
  ];
  console.log(JSON.stringify({
    shared: true,
    remote,
    branch,
    commit: gitOutput(pd, ["rev-parse", "HEAD"], "Cannot resolve HEAD"),
    committed_paths: committed,
    ...(planFirst === null ? {} : { plan: { repo: planFirst.repo, address: planFirst.address, commit: planFirst.commit } }),
    ...(notice.length > 0 ? { notice: notice.join(" ") } : {}),
    ...(named === null ? {} : { committed_files: named }),
    step: `Tell the person in plain words what it reports, then end your turn.${notShared?.onYes ?? ""}`,
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
    const payload = readPayload(pd, stamp.claim_oid);
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
  unit: string,
  state: string,
  options: { onlyIfNone?: boolean } = {},
): { kind: "here"; repo: string } | { kind: "kept" } | { kind: "theirs"; line: string } | { kind: "unseen"; why: string; repo: string } {
  validateClaimRefUnit(identity.intentId8, unit);
  const ref = claimRef(identity.intentId8, unit);
  // Every caller returns first while the plan is not shared.
  const kept = keptPlan(pd, identity.intentId8)!;
  const place = recordPlaceIn(kept.plan, unit);
  const work = { uuid: identity.intentUuid, space: identity.space };
  const read = (): UnitClaimView | null => readUnitRecord(pd, place, work, unit, { typed: true });
  let current: UnitClaimView | null;
  try {
    current = read();
  } catch (error) {
    if (error instanceof RecordUnread) return { kind: "unseen", why: error.said ?? "it did not answer in time", repo: place.repo };
    throw error;
  }
  if (current !== null && options.onlyIfNone === true) return { kind: "kept" };
  const takenBack = current?.status === "claimed" && current.payload.done === true &&
    !(current.owner === identity.space && claimIsMine(pd, current));
  if (current?.status === "claimed" && !takenBack) {
    return current.owner === identity.space && claimIsMine(pd, current) ? { kind: "here", repo: place.repo } : { kind: "theirs", line: takenLine(unit, current) };
  }
  const payload = takenClaimPayload(current, {
    team: identity.space, home: { space: identity.space, uuid: identity.intentUuid, id8: identity.intentId8 }, unit, ref,
    generation: takenBack ? (current?.generation ?? 0) + 1 : takeGeneration(current), me: gitUserName(pd) ?? "a teammate",
    baseOid: kept.commit, integrationRef: kept.ref, gateRhythm: readUnitGateRhythm(state),
  });
  const pushed = writeUnitRecord(pd, place, ref, createRecordCommit(pd, current?.oid ?? null, payload, "taken", {}, { take: true }), current?.oid ?? null);
  if (!pushed.ok) {
    let winner: UnitClaimView | null = null;
    try {
      winner = read();
    } catch {
      // The refusal's own words below.
    }
    if (winner?.status === "claimed") return { kind: "theirs", line: takenLine(unit, winner) };
    return { kind: "unseen", why: "refused" in pushed ? pushed.refused.replace(/\.+$/, "") : "it changed meanwhile", repo: place.repo };
  }
  invalidateLiveClaimPayloadCache(pd, unit);
  // A done Unit taken back to build here is not done on the plan any more.
  if (takenBack) {
    try {
      leadsPlanWrite(pd, { what: `${unit} taken back`, words: (name) => name === unit ? { generation: payload.generation } : null });
    } catch {
      // The record says the new take; the plan's done no longer holds for it.
    }
  }
  return { kind: "here", repo: place.repo };
}

// At the lead's shared work, the walk's first start of a Unit (its one
// UNIT_STARTED row, just written) that nobody holds writes that Unit's record
// as the lead's project's own take, as `assign --here` does, over a record
// given back too, so no team takes a Unit being built here; nothing is said
// unless it cannot be written. A later stage's start writes nothing.
export function recordLeadsOwnStart(projectDir: string, unit: string): void {
  try {
    const state = readStateFile(projectDir);
    if (homeLocation(state) === null || unitBuildOf(state) !== null || !isTeamUnitOwnership(state)) return;
    const identity = activeIdentity(projectDir);
    const kept = keptPlan(projectDir, identity.intentId8);
    if (kept === null || !kept.plan.units.some((entry) => entry.name === unit)) return;
    const starts = readAuditShardEvents(projectDir).filter((row) => row.event === "UNIT_STARTED" && auditBlockField(row.block, "Unit") === unit);
    if (starts.length !== 1) return;
    if (recordCopied(projectDir, recordPlaceIn(kept.plan, unit), { uuid: identity.intentUuid, space: identity.space }, unit)?.status === "claimed") return;
    const claimed = quietly(() => writeHereClaim(projectDir, identity, unit, state));
    if (claimed.kind === "unseen") saidWithNextStep(projectDir, hereNotSeenLine(unit, claimed.repo, claimed.why));
    else if (claimed.kind === "theirs") saidWithNextStep(projectDir, claimed.line);
  } catch {
    // The walk goes on; a look reads the record as it is.
  }
}

function hereNotSeenLine(unit: string, repo: string, why: string): string {
  return `${unit} is built here now. Its record in ${repo} could not be written (${why}), so a teammate could still take it meanwhile.`;
}

// The teams' clones see the work as a team home only once the remote's main
// (as this clone last fetched it) carries its state with the home recorded,
// and work the teams build on this repo once that state is team work.
export function planUnshared(projectDir: string, target: { remote: string; branch: string }): boolean {
  // The lead's own work teams build: shared once its plan's ref is written or read here.
  const own = readStateFile(projectDir);
  if (homeLocation(own) !== null && unitBuildOf(own) === null) return keptPlan(projectDir, activeIdentity(projectDir).intentId8) === null;
  const state = relative(projectDir, stateFilePath(projectDir)).split("\\").join("/");
  const shown = git(projectDir, ["show", `refs/remotes/${target.remote}/${target.branch}:${state}`]);
  if (!shown.ok) return true;
  // Work with no home (teams on this repo) is theirs once its state there is team work.
  return homeLocation(own) !== null ? homeLocation(shown.stdout) === null : !isTeamUnitOwnership(shown.stdout);
}

// The Units the lead asked to build here: the share writes the claim of each
// that has none, and its question names them while the plan is not shared yet
// (assign --here writes no claim then).
export function unitsAskedHereForShare(pd: string): string[] {
  return [...unitsAskedHere(readAuditShardEvents(pd))];
}

// Where the record of each Unit built here goes, said the same way by the
// share question ("I'd also record ...") and the share's own line ("Recorded
// ..."): "in <repo> that <X> is built here", one part a repository.
export function builtHereWords(records: ReadonlyArray<{ unit: string; repo: string }>): string {
  const byRepo = new Map<string, string[]>();
  for (const { unit, repo } of records) byRepo.set(repo, [...(byRepo.get(repo) ?? []), unit]);
  return [...byRepo].map(([repo, units]) => `in ${repo} that ${namesInProse(units)} ${units.length === 1 ? "is" : "are"} built here`)
    .join(", and ");
}

// The share question's words for the Units built here: where their records
// will go, by the plan the share writes. Null with none, or no plan place yet.
export function builtHereRecordClause(projectDir: string, units: readonly string[]): string | null {
  if (units.length === 0) return null;
  const pd = resolveProjectDir(projectDir);
  const place = planPlaceForShare(pd);
  if (!("ref" in place)) return null;
  try {
    const plan = planFilesNow(pd, keptPlan(pd, place.id8)?.plan ?? null, place).plan;
    return `I'd also record ${builtHereWords(units.map((unit) => ({ unit, repo: recordPlaceIn(plan, unit).repo })))}.`;
  } catch {
    // The plan cannot be put together yet: the share itself says what stops it.
    return null;
  }
}

// At the share, a Unit the lead asked to build here before it, with no claim
// yet, gets its claim, so a team's clone sees it taken from its first look:
// the Units whose claim went, and the lines for one that could not be written.
function claimsAskedHereWithShare(pd: string): { sent: Array<{ unit: string; repo: string }>; lines: string[] } {
  const identity = activeIdentity(pd);
  const kept = keptPlan(pd, identity.intentId8);
  if (kept === null) return { sent: [], lines: [] };
  let rows: AuditShardEvent[] = [];
  try {
    rows = readAuditShardEvents(pd);
  } catch {
    // No audit to read: the Units asked here are none either.
  }
  const builds = unitsLeadsProjectBuilds(rows, kept.plan.skeleton);
  const state = readStateFile(pd);
  const sent: Array<{ unit: string; repo: string }> = [];
  const lines: string[] = [];
  for (const unit of kept.plan.units.map((entry) => entry.name).filter((name) => builds.has(name))) {
    // A Unit with a record already is left as it is: whoever holds it, or gave it back.
    const claimed = writeHereClaim(pd, identity, unit, state, { onlyIfNone: true });
    if (claimed.kind === "here") sent.push({ unit, repo: claimed.repo });
    else if (claimed.kind === "unseen") lines.push(hereNotSeenLine(unit, claimed.repo, claimed.why));
    else if (claimed.kind === "theirs") lines.push(claimed.line);
  }
  // What this share wrote, and where, said first.
  if (sent.length > 0) lines.unshift(`Recorded ${builtHereWords(sent)}.`);
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
  // Before the plan is shared no team can see its Units: nothing is written,
  // and the record goes with the share (claimsAskedHereWithShare).
  const unshared = keptPlan(pd, identity.intentId8) === null;
  const lines: string[] = [];
  const here: string[] = [];
  const notSeen = new Map<string, { repo: string; why: string }>();
  for (const unit of units) {
    if (unshared) {
      here.push(unit);
      continue;
    }
    const claimed = writeHereClaim(pd, identity, unit, state);
    if (claimed.kind === "theirs") {
      lines.push(claimed.line);
      continue;
    }
    if (claimed.kind === "unseen") notSeen.set(unit, { repo: claimed.repo, why: claimed.why });
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
    ...here.map((unit) => notSeen.has(unit)
      ? hereNotSeenLine(unit, notSeen.get(unit)!.repo, notSeen.get(unit)!.why)
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

// The branch a switch reaches holding the person's own build of the home's
// Unit, for the take question's Carry on choice (unitTakeLook). Null when the
// take is not theirs, or no such branch has it.
export function ownBuildBranch(projectDir: string, homeWork: string, claim: UnitClaimView): string | null {
  if (!claimIsMine(projectDir, claim)) return null;
  const place = branchWithBuild(projectDir, homeWork, claim.unit);
  return place !== null && place !== "" && "switchTo" in place ? place.switchTo : null;
}

// The person's own take whose build is not in this checkout, brought here as
// they asked: a switch to the branch that holds it, or their branch brought up
// to date where the record merged (this clone's own remote fetched first when
// no branch here has it). Where it is somewhere only they can reach (another
// computer, another worktree) the take stops with that line. Returns what is
// said before the carry-on line and after it.
function bringOwnBuildHere(pd: string, homeWork: string, claim: UnitClaimView): { before: string; after: string } {
  const unit = claim.unit;
  const remote = repositoryRemote(pd);
  let place = branchWithBuild(pd, homeWork, unit);
  if (place === null && remote !== null) {
    if (!CHECKOUT_STEPS.fetch.run(pd, remote).ok) {
      fail(`You took ${unit} on another computer, and its build is not in this clone yet. ${remote} could not be reached just now ` +
        "to look for it, so push it from that computer if you have not, then ask me again.");
    }
    place = branchWithBuild(pd, homeWork, unit);
  }
  if (place === "") fail(takenLine(unit, claim));
  if (place === null) {
    fail(remote === null
      ? `You took ${unit} on another computer, and its build is not in this clone: carry on with it on that computer.`
      : `You took ${unit} on another computer, and its build is not on ${remote} yet: push it from that computer, then ask me to carry it on here.`);
  }
  if ("checkedOut" in place) {
    fail(`Your build of ${unit} is on branch ${place.checkedOut.branch}, which is checked out in ${place.checkedOut.path}: carry it on there.`);
  }
  const here = git(pd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim();
  if ("switchTo" in place) {
    const switched = CHECKOUT_STEPS.switch.run(pd, place.switchTo);
    if (!switched.ok) {
      fail(`Your build of ${unit} is on branch ${place.switchTo}, and you stay on ${here || "the commit you were on"}: git says ` +
        `"${gitSaid(switched.stderr || switched.stdout)}".`);
    }
    return { before: `You're on ${place.switchTo} now, where your build of ${unit} is. `, after: ` ${CHECKOUT_STEPS.switch.undo(here || "the commit you were on")}` };
  }
  const { remote: from, branch } = place.level;
  const moved = levelAndSwitch(pd, from, branch);
  if (!moved.ok && moved.at === "switch") fail(switchRefusedLine(branch, from, here || "HEAD", moved.said));
  if (!moved.ok) {
    fail(`Your build of ${unit} is in ${from}/${branch}, and your ${branch} stays as it was: git says "${gitSaid(moved.said)}".` +
      (moved.ownWork ? ` Your ${branch} has work of yours that ${from}/${branch} does not; once that is in ${from}/${branch}, ask me to carry ${unit} on here.` : ""));
  }
  return {
    before: moved.was !== undefined ? `${levelledLine(from, branch, moved.was)} `
      : `Your ${branch} is up to date with ${from}/${branch} now, with your build of ${unit} in it. `,
    after: moved.from === null ? "" : ` You're on ${branch} now. ${CHECKOUT_STEPS.switch.undo(moved.from)}`,
  };
}

// Where the person's own build of the home's Unit is in this clone, when it is
// not in this checkout: a branch a switch reaches (its own, or one it fetched,
// which `git switch <branch>` makes its own); a branch of its own whose fetched
// copy has it, the record merged where this clone has not pulled (`level`); a
// branch checked out in another worktree of this clone. Its own branches
// first, then those checked out elsewhere, then the fetched copies of its own
// (read before the rest: once the record's pull request merged, main holds the
// build, and so does every branch cut from it since), then the other fetched
// ones. Local reads only, never a fetch or a switch. Null when no branch has
// it; "" when a git call is not ok, so nobody is sent anywhere for nothing.
type BuildPlace =
  | { switchTo: string }
  | { level: { remote: string; branch: string } }
  | { checkedOut: { branch: string; path: string } };

function branchWithBuild(projectDir: string, homeWork: string, unit: string): BuildPlace | null | "" {
  // Globs whatever the person's environment says (aidlc-workspace-doctor's way).
  const env = { GIT_LITERAL_PATHSPECS: "0" };
  const listed = localGit(projectDir, ["for-each-ref", "--sort=-committerdate", "--format=%(worktreepath)%00%(refname)", "refs/heads/",
    "refs/remotes/"], env);
  const remotes = localGit(projectDir, ["remote"], env);
  if (!listed.ok || !remotes.ok) return "";
  // The branch checked out here: its build would be on disk, so it is not read.
  const head = localGit(projectDir, ["symbolic-ref", "--quiet", "HEAD"], env).stdout.trim();
  const rows = listed.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.split("\0"));
  const ownNames = new Set(rows.flatMap(([, ref]) => ref?.startsWith("refs/heads/") ? [ref.slice("refs/heads/".length)] : []));
  const prefixes = remotes.stdout.split(/\r?\n/).filter(Boolean).map((remote) => `refs/remotes/${remote}/`)
    .sort((a, b) => b.length - a.length);
  const places = new Map<string, BuildPlace>();
  const [own, elsewhere, shadowed, fetched]: string[][] = [[], [], [], []];
  for (const [worktree, ref] of rows) {
    if (ref === undefined) continue;
    if (ref.startsWith("refs/heads/")) {
      const branch = ref.slice("refs/heads/".length);
      if (worktree === "") {
        own.push(ref);
        places.set(ref, { switchTo: branch });
      } else if (ref !== head) {
        elsewhere.push(ref);
        places.set(ref, { checkedOut: { branch, path: worktree } });
      }
      continue;
    }
    // A fetched branch by its remote's name for it, the longest remote name
    // first, never AI-DLC's claims or the remote's HEAD.
    const prefix = prefixes.find((start) => ref.startsWith(start));
    const name = prefix === undefined ? "" : ref.slice(prefix.length);
    if (prefix === undefined || name === "" || name === "HEAD" || name.startsWith("claim/")) continue;
    if (ownNames.has(name)) {
      shadowed.push(ref);
      places.set(ref, { level: { remote: prefix.slice("refs/remotes/".length, -1), branch: name } });
    } else {
      fetched.push(ref);
      places.set(ref, { switchTo: name });
    }
  }
  const field = `^- \\*\\*${UNIT_BUILD_FIELD}\\*\\*:[[:blank:]]*${unit.replaceAll(".", "\\.")}[[:space:]]*$`;
  // Newest branch first, a hundred a call so no command line runs too long on
  // Windows; a fetched branch never shares a call with this clone's own, so
  // one git cannot read (a partial clone's) loses no hint of theirs.
  for (const refs of [own, elsewhere, shadowed, fetched]) {
    for (let at = 0; at < refs.length; at += 100) {
      const found = localGit(projectDir, ["grep", "--no-color", "-z", "-l", "-E", "-e", field, ...refs.slice(at, at + 100), "--",
        "aidlc/spaces/*/intents/*/aidlc-state.md"], env);
      if (!found.ok && found.code === 1) continue;
      if (!found.ok) return "";
      for (const hit of found.stdout.split("\0").filter(Boolean)) {
        const ref = hit.slice(0, hit.indexOf(":"));
        const shown = localGit(projectDir, ["show", `${ref}:./${hit.slice(ref.length + 1)}`], env);
        if (!shown.ok) return "";
        const build = liveBuildOf(shown.stdout);
        if (build === null || !isBuildOfUnit(build, homeWork, unit)) continue;
        return places.get(ref) ?? null;
      }
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
  // A take from the plan: what it builds is read from this workspace's copy of
  // the plan (copyOf the plan's ref at `location`), not from a record here.
  leadCopy?: boolean;
  // The plan as this take read it, which names each Unit's record repository.
  plan?: PlanJson;
}

// Where a Unit of `home`'s work keeps its record: the repository the plan
// names for it (units[].record), by its address as the plan carries it; for the
// solo second person, the workspace's own repository, where a teammate's take
// of solo work is recorded. With no copy of the plan here, the plan is looked
// for at the work's Home Location before a record is written there; work not
// shared yet keeps its records there. A look of all the work's records reads
// the places this workspace knows of (recordPlacesOfWork).
function recordPlaceOf(projectDir: string, home: HomeWork, unit: string): RecordPlace {
  if (home.solo) return { repo: workspaceRepoEntry(projectDir).name, address: home.location };
  const plan = home.plan ?? planOfWork(projectDir, home.id8, home.location) ?? planLookedFor(projectDir, home.location, home.id8);
  return plan === null ? { repo: repoNameOf(home.location), address: home.location } : recordPlaceIn(plan, unit, home.location);
}

// The plan at `location` as this workspace's copy of it holds it, looked at
// once a command when there is no copy yet (a clone that never read it: solo
// work a teammate took, shared since). Null when it is not there or the
// repository did not answer.
const plansLookedFor = new Set<string>();
function planLookedFor(projectDir: string, location: string, id8: string): PlanJson | null {
  if (!isGitAddress(location)) return null;
  const copy = copyOf(location, planRecordRef(id8));
  const kept = planAtCopy(projectDir, copy);
  if (kept.kind === "read") return kept.plan;
  const key = `${projectDir}\0${location}\0${id8}`;
  if (plansLookedFor.has(key)) return null;
  plansLookedFor.add(key);
  lookAt(projectDir, location, [planRecordRef(id8)]);
  const met = followMoved(projectDir, id8, location, false);
  if (met?.follow.kind === "followed") return met.follow.plan;
  const read = planAtCopy(projectDir, copy);
  return read.kind === "read" ? read.plan : null;
}

// The repository a plan names for a Unit's record; a Unit it names none for,
// the plan's own.
//
// `readAt`, the address this workspace read the plan at: a record in that same
// repository is reached by it, the person's own spelling with no clone of it
// here; one in another repository by the plan's, or the person's own clone.
function recordPlaceIn(plan: PlanJson, unit: string, readAt?: string): RecordPlace {
  const named = plan.units.find((entry) => entry.name === unit)?.record;
  const entry = [plan.plan_repo, ...plan.repos].find((repo) => repo.name === named && repo.address !== null);
  const place = entry !== undefined ? { repo: entry.name, address: entry.address! } : { repo: plan.plan_repo.name, address: plan.plan_repo.address };
  return readAt !== undefined && isGitAddress(readAt) && sameGitAddress(place.address, readAt) ? { ...place, address: readAt } : place;
}

// The work a record of `home`'s is read for.
function recordWork(home: HomeWork): { uuid: string; space: string } {
  return { uuid: home.uuid, space: home.space };
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
  const target = homeTarget(projectDir, location);
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
  };
}

// An address git is given as the remote to read and write: one that starts
// with "-" would be read as an option, so it is never passed on.
function refuseOptionAddress(address: string, refusal: string): void {
  if (address.startsWith("-")) fail(refusal);
}

function recordedAddressRefusal(dirName: string): string {
  return `${dirName}'s recorded plan address starts with "-", so git would read it as an option; nothing was read or ` +
    "written. Its Home Location in the work's state names the plan's repository: correct it to that repository's address.";
}

// Where a work's claims are read and written: this workspace's own remote when
// the work's recorded place is this repository, else that place's address, as
// a clone here spells it when that clone's URL carries a sign-in (gitTargetFor,
// its sign-in going with every git call that names it: targetEnv).
export function homeTarget(projectDir: string, location: string): string | null {
  const own = workspaceHomeLocation(projectDir);
  if (location === "local" || (own !== null && sameGitAddress(location, own))) return repositoryRemote(projectDir);
  const known = `${projectDir}\0${location}`;
  if (!spelledTargets.has(known)) {
    const via = gitTargetFor(projectDir, location, "push");
    if (Object.keys(via.env).length > 0) targetEnv.set(via.target, via.env);
    spelledTargets.set(known, Object.keys(via.env).length > 0 ? via.target : location);
  }
  return spelledTargets.get(known)!;
}

// Each work address homeTarget spelled in this command, so a clone's URLs are read once.
const spelledTargets = new Map<string, string>();

// The lead of a build whose lead's work is not in this workspace: the plan's
// place, from the build's own record (Home Location, Home Work, Home Label) and
// its copy of the plan. Null when the lead's work is here or the build's
// lead is not an address.
export function planHomeOfBuild(projectDir: string, build: UnitBuild): HomeWork | null {
  if (leadWorkHere(projectDir, build.homeWork) !== null || !isGitAddress(build.homeLocation)) return null;
  return planHomeAt(projectDir, build);
}

// The plan's place a build was taken from, by its own Home Location.
function planHomeAt(projectDir: string, build: UnitBuild): HomeWork {
  const here = findUnitBuild(projectDir, build.homeWork, build.unit);
  refuseOptionAddress(build.homeLocation, recordedAddressRefusal(here?.dirName ?? build.unit));
  const id8 = idSuffix(build.homeWork);
  let label = id8;
  let repos: string[] = [];
  if (here !== null) {
    try {
      label = getField(readStateFile(projectDir, here.dirName, here.space), "Home Label")?.trim() || id8;
      repos = intentRepos(projectDir, here.dirName, here.space);
    } catch {
      // The build's own fields stand.
    }
  }
  const copy = copyOf(build.homeLocation, planRecordRef(id8));
  const kept = planAtCopy(projectDir, copy, { commit: planCommitOf(projectDir, copy) });
  return {
    space: kept.kind === "read" ? kept.plan.work.space : DEFAULT_SPACE, dirName: "", uuid: build.homeWork, id8, label,
    location: build.homeLocation, target: homeTarget(projectDir, build.homeLocation), recordPrefix: "", repos, solo: false,
    leadCopy: true,
  };
}

// The space a build's lead's work lives in: where it is here, else as its
// plan names it; the claim cache and the Way of Working lines read it.
function buildHomeSpace(projectDir: string, build: UnitBuild): string {
  const here = leadWorkHere(projectDir, build.homeWork);
  if (here !== null) return here.space;
  if (!isGitAddress(build.homeLocation)) return DEFAULT_SPACE;
  const copy = copyOf(build.homeLocation, planRecordRef(idSuffix(build.homeWork)));
  const kept = planAtCopy(projectDir, copy, { commit: planCommitOf(projectDir, copy) });
  return kept.kind === "read" ? kept.plan.work.space || DEFAULT_SPACE : DEFAULT_SPACE;
}

// A take's flags for a Unit of the plan shared at `address`: the one spelling
// the look's offer, a build's own way back and a claim use.
export function planTakeFlags(id8: string, address: string): string[] {
  return ["--plan", id8, "--from", address];
}

// The same flags as a printed command writes them, the address always quoted.
export function planTakeWords(id8: string, address: string): string {
  return planTakeFlags(id8, address).map((word) => (word === address ? shellSingleQuote(word) : word)).join(" ");
}

// The command that takes (or carries on) a Unit of a build's lead's work:
// from the plan where it is shared, or, for solo work here, from it.
function takeCommandOf(projectDir: string, build: UnitBuild): string {
  const here = leadWorkHere(projectDir, build.homeWork);
  const unit = shellArg(build.unit);
  if (here !== null && !takenFromPlan(projectDir, build)) {
    return `${aidlcToolInvocation("unit")} take ${unit} --home ${shellArg(here.dirName)}` +
      (here.space === DEFAULT_SPACE ? "" : ` --home-space ${shellArg(here.space)}`);
  }
  return `${aidlcToolInvocation("unit")} take ${unit} ${planTakeWords(idSuffix(build.homeWork), build.homeLocation)}`;
}

// The home's integration branch for the solo second person's take, fetched with
// the person's own login through this workspace's remote.
function fetchHomeIntegration(
  projectDir: string,
  home: HomeWork,
): { ref: string; branch: string; oid: string } {
  const remote = home.target;
  const affirmed = affirmedIntegrationBranch(projectDir, home.space);
  const branch = affirmed?.branch ?? integrationBranch(projectDir, remote);
  if (remote) {
    const fetched = git(projectDir, ["fetch", remote, branch]);
    // Where the name came from, so the person can correct it there.
    const from = affirmed ? `, named in ${affirmed.source} under Way of Working,` : "";
    if (!fetched.ok) fail(`The lead's project's branch ${branch}${from} could not be fetched from ${remote}: ${fetched.stderr.trim()}`);
  }
  const ref = remote ? `refs/remotes/${remote}/${branch}` : `refs/heads/${branch}`;
  return { ref, branch, oid: gitOutput(projectDir, ["rev-parse", "--verify", ref], `The lead's project's branch ${branch} is not here`) };
}

// What the home's plan says at a commit: its state and Unit plan, read from
// git, or a line that the lead has not pushed it yet.
function homePlanAt(projectDir: string, home: HomeWork, oid: string, branch: string): { state: string; dependencies: string } {
  const read = (rel: string): string => {
    const shown = git(projectDir, ["show", `${oid}:${home.recordPrefix}/${rel}`, "--"]);
    if (!shown.ok) {
      fail(`The lead's work is not on its branch ${branch} yet, so there is nothing to take.`);
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
  return approvalWords(approvalTimes(rows, slugs));
}

// The same, as the plan carries them: each input's stage, approved when.
export function planApprovals(plan: PlanJson, produced: Set<string>): string[] {
  const times = new Map<string, string>();
  for (const input of plan.inputs) {
    const stage = input.path.split("/")[1];
    if (stage !== undefined && produced.has(stage) && input.approved !== undefined) times.set(stage, input.approved);
  }
  return approvalWords(times);
}

function approvalWords(times: ReadonlyMap<string, string>): string[] {
  return [...times].sort(([a], [b]) => a.localeCompare(b)).map(([stage, when]) => `${stage} approved by the lead ${when}`.trim());
}

// When each of these stages was last approved, by its GATE_APPROVED row.
function approvalTimes(rows: readonly AuditShardEvent[], slugs: Set<string>): Map<string, string> {
  const approvals = new Map<string, string>();
  for (const row of rows) {
    if (row.event !== "GATE_APPROVED") continue;
    const stage = auditBlockField(row.block, "Stage");
    if (stage && slugs.has(stage)) approvals.set(stage, row.timestamp);
  }
  return approvals;
}

// --- The plan, shared as a ref of AI-DLC's own in one code repository -------
//
// Built from the lead's own record, as a team's build reads it, so no team
// reads the lead's workspace. Every git call runs in the workspace's own
// repository by the code repository's address: nothing of AI-DLC's goes into a
// code clone, no remote is added, and the person's own hooks in the workspace
// run as for any push of theirs.

export interface PlanPlace {
  // As recorded: never with a sign-in in it.
  address: string;
  repo: string;
  id8: string;
  uuid: string;
  work: string;
  ref: string;
  copy: string;
}

// A repository of the work as the plan names it: its address as the lead's own
// clone spells its remote, else repos.json's url, with no sign-in; its branch as
// the lead's merge check reads it.
function planRepoEntry(pd: string, name: string): PlanJson["repos"][number] {
  const dir = repoDir(pd, name);
  const remote = isGitRepoDir(dir) ? soleRemote(dir) : null;
  const listed = readWorkspaceRepos(pd).entries.get(name);
  const url = (remote === null ? "" : git(dir, ["remote", "get-url", remote]).stdout.trim()) || listed?.url || "";
  return {
    name,
    address: url === "" ? null : withoutCredentials(url),
    branch: remote !== null ? repoIntegration(dir, remote).slice(remote.length + 1) : listed?.branch ?? null,
  };
}

// The name a plain git clone gives a repository, from its address.
function repoNameOf(address: string): string {
  return folderRepoName(address.replace(/[\\/]+$/, "").replace(/\.git$/i, "").split(/[\\/:]/).at(-1) ?? "");
}

// The work's repositories as the plan lists them, in the work's own order; the
// workspace's own repository, named as its clone would be, when the work names none.
function planRepos(pd: string, dirName?: string, space?: string): PlanJson["repos"] {
  const names = intentRepos(pd, dirName, space);
  return names.length > 0 ? names.map((name) => planRepoEntry(pd, name)) : [workspaceRepoEntry(pd, space)];
}

function workspaceRepoEntry(pd: string, space?: string): PlanJson["repos"][number] {
  // The workspace's own remote by the rule its claims use (origin, its one
  // remote, else the one at its recorded address).
  let remote: string | null = null;
  try {
    remote = repositoryRemote(pd);
  } catch {
    // Several remotes and none of them the work's: no address.
  }
  const url = remote === null ? "" : git(pd, ["remote", "get-url", remote]).stdout.trim();
  return {
    name: (url === "" ? "" : repoNameOf(url)) || folderRepoName(basename(pd)) || "project",
    address: url === "" ? null : withoutCredentials(url),
    branch: affirmedIntegrationBranch(pd, space)?.branch ?? (remote === null ? null : integrationBranch(pd, remote)),
  };
}

// Where the plan goes when the lead names nowhere else: the first repository
// of the work's own list, else the workspace's own; null with no address.
export function planHomeAddress(projectDir: string, dirName: string, space: string): string | null {
  return planRepos(projectDir, dirName, space)[0]?.address ?? null;
}

// This workspace's copy of its own work's plan, as last written or read: the
// one at the work's Home Location, never another repository's copy of the ref.
function keptPlan(pd: string, id8: string): { ref: string; commit: string; plan: PlanJson } | null {
  const location = homeLocation(stateHere(pd) ?? "");
  if (location === null || !isGitAddress(location)) return null;
  const ref = copyOf(location, planRecordRef(id8));
  const read = planAtCopy(pd, ref);
  return read.kind === "read" ? { ref, commit: read.oid, plan: read.plan } : null;
}

// A work's plan by its id as this workspace last read it, from a place it was
// given: the copy at `at` (the address a look or a take is for), else the copy
// at the work here's Home Location (keptPlan), else, for a workspace whose
// active work is another or none, the one copy here read from the repository
// its plan.json names as its own (planAtCopy's `found`). A copy of the ref
// pushed into any other repository is no plan, and two that pass leave none:
// never the newer by date.
function planOfWork(pd: string, id8: string, at?: string): PlanJson | null {
  if (at !== undefined && isGitAddress(at)) {
    const read = planAtCopy(pd, copyOf(at, planRecordRef(id8)));
    if (read.kind === "read") return read.plan;
  }
  const kept = keptPlan(pd, id8);
  if (kept !== null) return kept.plan;
  // A build of this work whose plan moved and is not followed yet reads the plan under the note.
  const build = unitBuildOf(stateHere(pd) ?? "");
  if (build !== null && idSuffix(build.homeWork) === id8 && isGitAddress(build.homeLocation)) {
    const copy = copyOf(build.homeLocation, planRecordRef(id8));
    const under = planAtCopy(pd, copy, { commit: planCommitOf(pd, copy) });
    if (under.kind === "read") return under.plan;
  }
  const listed = localGit(pd, ["for-each-ref", "--format=%(refname)", `refs/aidlc/home/${id8}/`]);
  const found: PlanJson[] = [];
  for (const ref of listed.ok ? listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : []) {
    const copy = homeCopyOf(ref);
    if (copy?.kind !== "plan" || copy.id8 !== id8) continue;
    const read = planAtCopy(pd, ref, { found: true });
    if (read.kind === "read") found.push(read.plan);
  }
  return found.length === 1 ? found[0] : null;
}

// The Units the plan as this computer last wrote or read it lists, or null
// when it has no copy of this work's plan.
export function planUnitsKept(projectDir: string): string[] | null {
  return keptPlan(projectDir, activeIdentity(projectDir).intentId8)?.plan.units.map((unit) => unit.name) ?? null;
}

// Where a share writes: the repository the lead named (by its name in the
// work or repos.json, else an address), else where this computer's copy says
// the plan is, else the place rule's. `refused` when the name cannot be one.
export function planPlaceForShare(projectDir: string, named?: string):
  PlanPlace | { repo: string; address: null } | { refused: "option" | "unknown"; named: string } {
  const pd = resolveProjectDir(projectDir);
  const { space, intentUuid, intentId8 } = activeIdentity(pd);
  const work = readIntentRegistry(pd, space).find((entry) => entry.uuid === intentUuid)?.slug ?? intentId8;
  const ref = planRecordRef(intentId8);
  const at = (repo: string, address: string | null): PlanPlace | { repo: string; address: null } | { refused: "option"; named: string } =>
    address === null ? { repo, address: null }
    : address.startsWith("-") ? { refused: "option", named: address }
    : { address, repo, id8: intentId8, uuid: intentUuid, work, ref, copy: copyOf(address, ref) };
  if (named !== undefined) {
    if (named.startsWith("-")) return { refused: "option", named };
    const known = planRepos(pd).find((entry) => entry.name === named) ??
      (readWorkspaceRepos(pd).entries.has(named) ? planRepoEntry(pd, named) : null);
    if (known !== null) return at(known.name, known.address);
    return isGitAddress(named) ? at(repoNameOf(named) || folderRepoName(withoutCredentials(named)) || "plan", withoutCredentials(named)) : { refused: "unknown", named };
  }
  const kept = keptPlan(pd, intentId8)?.plan.plan_repo;
  if (kept !== undefined) return at(kept.name, kept.address);
  // A copy at the work's Home Location that reads as no plan (a pointer, after a
  // move made on another computer): the write looks there first, and follows it.
  const home = homeLocation(stateHere(pd) ?? "");
  if (home !== null && isGitAddress(home) && localGit(pd, ["rev-parse", "--verify", "--quiet", copyOf(home, ref)]).ok) {
    const listed = planRepos(pd).find((entry) => entry.address !== null && sameGitAddress(entry.address, home));
    return at(listed?.name ?? (repoNameOf(home) || folderRepoName(home) || "plan"), home);
  }
  const first = planRepos(pd)[0];
  return at(first.name, first.address);
}

// What git is given for an address, for a fetch or a push, so the person's own
// sign-in and spelling are used and never stored, and never a fork: a remote of
// the workspace's own repository whose URL for that direction has the
// address's key, by its name; else that URL as one of the workspace's clones
// spells it (a relative one read from that clone); else the address. A sign-in
// in a clone's URL never goes on git's command line, where anyone on the
// machine can read it while git runs: the URL goes there without it, and `env`
// holds the command-scope setting (url.<theirs>.insteadOf) that hands git
// theirs; so does a sign-in in the address itself, with no clone of it. An
// address that starts with "-" would be read as an option and is never
// passed on.
export function gitTargetFor(projectDir: string, address: string, use: "fetch" | "push"): { target: string; env: NodeJS.ProcessEnv } {
  refuseOptionAddress(address, optionAddressRefusal(address));
  const spelled = cloneSpelling(projectDir, address, use);
  if (spelled?.remote !== undefined) return { target: spelled.remote, env: {} };
  const url = spelled?.url ?? address;
  const shown = withoutCredentials(url);
  if (shown === url) return { target: url, env: {} };
  const configured = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isSafeInteger(configured) && configured > 0 ? configured : 0;
  return {
    target: shown,
    env: { GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: `url.${url}.insteadOf`, [`GIT_CONFIG_VALUE_${index}`]: shown },
  };
}

// The address as a record keeps it (Home Location; the said list): the
// person's own clone's spelling where they have one, a path made absolute
// against the project, never a sign-in.
export function recordedAddress(projectDir: string, address: string): string {
  return withoutCredentials(absoluteAddress(projectDir, cloneSpelling(projectDir, address, "fetch")?.url ?? address));
}

// A path address read from `dir` (a URL or an scp-style address is as it is).
function absoluteAddress(dir: string, address: string): string {
  const path = !/^[a-z][a-z0-9+.-]*:\/\//i.test(address) && !/^(?:[^@/\\]+@)?[^/\\:]{2,}:(?!\/\/)/.test(address);
  return path && !isAbsolute(address) ? resolve(dir, address) : address;
}

function optionAddressRefusal(address: string): string {
  return `The address ${JSON.stringify(address)} starts with "-", so git would read it as an option; nothing was ` +
    "read or written. Ask the person for the address of the repository the plan is shared in.";
}

// The workspace's own remote at that address (by name), else a clone's URL
// for it, as the clone spells it.
function cloneSpelling(projectDir: string, address: string, use: "fetch" | "push"): { remote?: string; url: string } | null {
  const key = gitAddressKey(absoluteAddress(projectDir, address));
  const remotes = (dir: string): string[] => git(dir, ["remote"]).stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  const urlOf = (dir: string, remote: string): string => {
    const url = git(dir, ["remote", "get-url", ...(use === "push" ? ["--push"] : []), remote]).stdout.trim();
    // A clone's relative URL is relative to that clone.
    return url === "" ? url : absoluteAddress(dir, url);
  };
  for (const remote of remotes(projectDir)) {
    const url = urlOf(projectDir, remote);
    if (url !== "" && gitAddressKey(url) === key) return { remote, url };
  }
  for (const name of workspaceRepoNames(projectDir)) {
    const dir = repoDir(projectDir, name);
    if (resolve(dir) === resolve(projectDir) || !isGitRepoDir(dir)) continue;
    for (const remote of remotes(dir)) {
      const url = urlOf(dir, remote);
      if (url !== "" && gitAddressKey(url) === key) return { url };
    }
  }
  return null;
}

// --- The look: what a workspace reads by an address ------------------------
//
// One `git fetch --no-tags` of exact refs per repository, in the workspace's own
// repository, into its copies (homeCopyName): never ls-remote with a pattern,
// which receives every ref name the repository has. Each ref is fetched as a
// glob whose star sits where a longer name would go on, on both sides, so a ref
// the remote lacks is no error (an exact one is fatal) and a longer name lands
// at its own copy, never this one's; --prune, passed every time so the
// person's fetch.prune never decides, takes away the copy of a ref the remote
// no longer has, and a plan's copy it took is put back, so a build keeps the
// rules and the commit it took from.
export type LookResult =
  | { ok: true; refs: Record<string, { now: string | null; was: string | null }> }
  // git's own words, sign-in masked, and its first line for a line that says
  // why in a parenthesis; both null when it did not answer in time.
  | { ok: false; said: string | null; firstLine: string | null }
  // This repository's own .git could not be written (Codex's sandbox).
  | { ok: false; refused: string };

function lookRefspec(address: string, ref: string): string {
  const key = repoCopyKey(address);
  const plan = /^refs\/aidlc\/plans\/([^/*]+)$/.exec(ref);
  if (plan !== null) return `+${ref}*:refs/aidlc/home/${plan[1]}*/${key}/plan`;
  if (/^refs\/aidlc\/plans\/$/.test(ref)) return `+refs/aidlc/plans/*:refs/aidlc/home/*/${key}/plan`;
  return `+${ref}*:${copyOf(address, ref)}*`;
}

// The copies this repository's look keeps, by name, with their commits.
function copiesAt(pd: string, key: string): Map<string, string> {
  const listed = localGit(pd, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/aidlc/home/"]);
  const copies = new Map<string, string>();
  for (const line of listed.ok ? listed.stdout.split(/\r?\n/) : []) {
    const [oid, ref] = line.trim().split(" ");
    if (oid && ref && homeCopyOf(ref)?.key === key) copies.set(ref, oid);
  }
  return copies;
}

// `refs`: the plan's ref, a record's ref, a work's records folder
// ("refs/aidlc/claims/<id8>/"), or every plan there ("refs/aidlc/plans/"), all
// at one address. `typed`: the person named this address now, so no ceiling of
// ours cuts it short and their credential helper may ask them to sign in (the
// agent's shell has no terminal for git's own prompt). Otherwise quietly, with
// the look's own ceiling.
export function lookAt(projectDir: string, address: string, refs: readonly string[], options: { typed?: boolean } = {}): LookResult {
  const via = gitTargetFor(projectDir, address, "fetch");
  const key = repoCopyKey(address);
  const before = copiesAt(projectDir, key);
  const args = ["fetch", "--no-tags", "--no-filter", "--no-write-fetch-head", "--prune", "-q", via.target, ...refs.map((ref) => lookRefspec(address, ref))];
  const fetch = (): GitBytesResult => gitBytes(projectDir, args, { ...via.env, GIT_TERMINAL_PROMPT: "0" });
  const fetched = options.typed ? fetch() : quietly(() => {
    quietLimitMs = QUIET_LOOK_CEILING_MS;
    try {
      return fetch();
    } finally {
      quietLimitMs = null;
    }
  });
  if (!fetched.ok) {
    const stderr = fetched.stderr;
    const refused = localGitWriteRefused(stderr);
    if (refused !== null) return { ok: false, refused };
    if (fetched.timedOut) return { ok: false, said: null, firstLine: null };
    const said = maskUserinfo(gitWords(stderr));
    return { ok: false, said, firstLine: maskUserinfo(stderr.trim().split(/\r?\n/)[0]?.trim() ?? "") || said };
  }
  const after = copiesAt(projectDir, key);
  const found: Record<string, { now: string | null; was: string | null }> = {};
  const copyName = (ref: string): string => (/^refs\/aidlc\/plans\/[^/]+$/.test(ref) || /^refs\/aidlc\/claims\/[^/]+\/[^/]+$/.test(ref) ? copyOf(address, ref) : "");
  for (const ref of refs) {
    const copy = copyName(ref);
    if (copy !== "") {
      found[ref] = { now: after.get(copy) ?? null, was: before.get(copy) ?? null };
      continue;
    }
    // A folder: each copy in it, before or after.
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const at = homeCopyOf(name);
      if (at === null) continue;
      const remote = at.kind === "plan" ? planRecordRef(at.id8) : claimRecordRef(at.id8, at.unit);
      if (!remote.startsWith(ref)) continue;
      found[remote] = { now: after.get(name) ?? null, was: before.get(name) ?? null };
    }
  }
  // A plan the remote no longer has keeps its copy here.
  for (const [ref, seen] of Object.entries(found)) {
    if (seen.now === null && seen.was !== null && /^refs\/aidlc\/plans\//.test(ref)) {
      localGit(projectDir, ["update-ref", copyOf(address, ref), seen.was]);
    }
  }
  return { ok: true, refs: found };
}

// The plan's tip at its repository, read by the look into this workspace's
// copy: null when the remote has none. `unreached` holds git's words when it
// could not be read, null at a time limit; the tip is then the copy.
export function lookAtPlan(projectDir: string, place: PlanPlace): { tip: string | null; unreached?: string | null } {
  const looked = lookAt(projectDir, place.address, [place.ref], { typed: true });
  if (looked.ok) return { tip: looked.refs[place.ref]?.now ?? null };
  if ("refused" in looked) throw new GitWriteRefused(looked.refused);
  const tip = localGit(projectDir, ["rev-parse", "--verify", "--quiet", place.copy]).stdout.trim() || null;
  return { tip, unreached: looked.said };
}

// The plan as read: at a commit of its copy (default: the copy's tip, the
// snapshot the last look read), with its files' texts. `newer`: plan.json's
// format is above this release's, so nothing of it is read or written over;
// `unreadable`: no copy, the commit is not here, or plan.json does not read.
export interface PlanSnapshot {
  place: PlanPlace;
  oid: string;
  plan: PlanJson;
  text: (path: string) => string | null;
}
export type PlanRead = { kind: "read"; plan: PlanSnapshot } | { kind: "newer"; format: number; place: PlanPlace } | { kind: "unreadable"; place: PlanPlace };

export function planAt(projectDir: string, place: PlanPlace, commit?: string): PlanRead {
  const read = planAtCopy(projectDir, place.copy, { commit: commit ?? planCommitOf(projectDir, place.copy) });
  if (read.kind === "newer") return { kind: "newer", format: read.format, place };
  if (read.kind !== "read") return { kind: "unreadable", place };
  const oid = read.oid;
  return {
    kind: "read",
    plan: {
      place, oid, plan: read.plan,
      text: (path) => {
        const shown = localGit(projectDir, ["show", `${oid}:${path}`, "--"]);
        return shown.ok ? shown.stdout : null;
      },
    },
  };
}

// The plan at a copy here (at `commit` when given), the one reader of a copy.
// It is this work's plan only when plan.json names the work its copy's name
// does. One AI-DLC found by itself (`found`: the --units sweep) counts only
// when it was read from the repository plan.json names as its own: a copy of
// the ref anywhere else (a mirror, a fork, a push by anyone who can push there)
// is no plan. One at a place the person named is the plan as read there,
// however they spelled the address (an ssh host alias, a port). `moved`: this
// work's plan moved, and its pointer says where (followPlan reads it).
export function planAtCopy(pd: string, copy: string, options: { commit?: string; found?: boolean } = {}):
  { kind: "read"; oid: string; plan: PlanJson } | { kind: "moved"; oid: string; pointer: PlanPointer } | { kind: "newer"; format: number } |
  { kind: "unreadable"; format: number } {
  if (homeCopyOf(copy)?.kind !== "plan") return { kind: "unreadable", format: 0 };
  const oid = options.commit ?? localGit(pd, ["rev-parse", "--verify", "--quiet", copy]).stdout.trim();
  const shown = oid === "" ? null : localGit(pd, ["show", `${oid}:plan.json`, "--"]);
  return planReadOf(copy, oid, shown?.ok ? shown.stdout : null, options.found);
}

// plan.json's text at `oid` of `copy`, read as planAtCopy reads it.
function planReadOf(copy: string, oid: string, text: string | null, found?: boolean): ReturnType<typeof planAtCopy> {
  const named = homeCopyOf(copy);
  if (named?.kind !== "plan" || text === null) return { kind: "unreadable", format: 0 };
  const parsed = planJsonOf(text);
  if (parsed.moved !== undefined && idSuffix(parsed.moved.work.id) === named.id8) return { kind: "moved", oid, pointer: parsed.moved };
  if (parsed.plan === null) return parsed.format > PLAN_FORMAT ? { kind: "newer", format: parsed.format } : { kind: "unreadable", format: parsed.format };
  if (idSuffix(parsed.plan.work.id) !== named.id8) return { kind: "unreadable", format: parsed.format };
  if (found === true && repoCopyKey(parsed.plan.plan_repo.address) !== named.key) return { kind: "unreadable", format: parsed.format };
  return { kind: "read", oid, plan: parsed.plan };
}

// A plan this workspace had a copy of that is no longer where it was shared.
export function planGoneLine(plan: PlanJson): string {
  return `The plan of ${plan.work.label || idSuffix(plan.work.id)} is no longer in ${plan.plan_repo.name}.`;
}

// A plan whose plan.json this AI-DLC does not read, or that names another work.
export function planUnreadableLine(repo: string): string {
  return `The plan in ${repo} could not be read: what is there is not a plan this AI-DLC can read.`;
}

// Where a moved plan is now, from its pointer at `from`, the one reader of a
// move for every caller (a build, a teammate, the lead's other computer). Each
// place it names is looked at, quietly unless typed, and counts only when the
// plan there names this work and that repository as its own, so a pointer
// leads only to the plan itself. At most three pointers in one look, never back
// to a repository already passed; `repo` is then the last one read. It re-keys
// nothing and says nothing: Home Location, writes and lines are the caller's.
export type PlanFollow =
  | { kind: "followed"; label: string; repo: string; address: string; copy: string; oid: string; plan: PlanJson }
  | { kind: "unread"; label: string; repo: string; address: string; said: string | null }
  // `holds`: the last place answered and holds nothing at the plan's ref, or something not this work's plan.
  | { kind: "not-followed"; label: string; repo: string; address: string; holds: "nothing" | "other" }
  | { kind: "newer"; format: number };

export function followPlan(pd: string, from: string, id8: string, pointer: PlanPointer, typed: boolean): PlanFollow {
  const label = pointer.work.label || id8;
  const ref = planRecordRef(id8);
  const passed = new Set([repoCopyKey(from)]);
  let to = pointer.moved_to;
  let last = to;
  for (let hops = 0; hops < 3 && !passed.has(repoCopyKey(to.address)); hops++) {
    passed.add(repoCopyKey(to.address));
    last = to;
    const looked = lookAt(pd, to.address, [ref], { typed });
    if (!looked.ok) {
      if ("refused" in looked) throw new GitWriteRefused(looked.refused);
      return { kind: "unread", label, repo: to.name, address: to.address, said: typed ? looked.said : looked.firstLine };
    }
    // Nothing there now: a copy kept here from before is never followed.
    if ((looked.refs[ref]?.now ?? null) === null) return { kind: "not-followed", label, repo: to.name, address: to.address, holds: "nothing" };
    const copy = copyOf(to.address, ref);
    const read = planAtCopy(pd, copy, { found: true });
    if (read.kind === "read") return { kind: "followed", label, repo: to.name, address: recordedAddress(pd, to.address), copy, oid: read.oid, plan: read.plan };
    if (read.kind === "newer") return { kind: "newer", format: read.format };
    if (read.kind !== "moved") break;
    to = read.pointer.moved_to;
  }
  return { kind: "not-followed", label, repo: last.name, address: last.address, holds: "other" };
}

// What the person reads where a moved plan was met: at a build's look, at a
// look with no build, or as a typed take's answer for `unit`.
export function planMovedLine(follow: Exclude<PlanFollow, { kind: "newer" }>, at: "build" | "look" | "take", unit = ""): string {
  const address = maskUserinfo(follow.address);
  const its = at === "take" ? `${unit} was not taken: the plan of ${follow.label}` : `The plan of ${follow.label}`;
  if (follow.kind === "followed") {
    return at === "build" ? `${its} moved to ${follow.repo} (${address}); this build reads it there now.` : `${its} moved to ${follow.repo}.`;
  }
  if (follow.kind === "unread") {
    const said = `${its} moved to ${follow.repo} (${address}), which could not be read (${follow.said ?? "it did not answer in time"})`;
    const tail = at === "take" ? ". Say when to try again." : at === "build" ? ", so this build carries on from the copy here; no other Unit of it can be taken until it can be read." : ".";
    return `${said}${tail} If you reach ${follow.repo} by another address, tell me which.`;
  }
  const said = `${its} says it moved, but ${follow.repo} does not hold it`;
  const mended = "until the lead's project has put that right.";
  return at === "build" ? `${said}, so this build carries on from the copy here; no other Unit of it can be taken ${mended}`
    : `${said}; no Unit of it can be taken ${mended}`;
}

// A build here of the work `id8` that reads its plan at `from`, re-keyed to
// where the plan is now, with its line for the next step. The work is matched
// as the copy reader matches a note to its copy: by the work id's suffix.
function buildsFollow(pd: string, id8: string, from: string, follow: Exclude<PlanFollow, { kind: "newer" }>, parted = false): boolean {
  const builds = unitBuildsHere(pd, (build) => idSuffix(build.homeWork) === id8 && sameGitAddress(build.homeLocation, from));
  if (builds.length === 0) return false;
  if (follow.kind === "followed") {
    withAuditLock(pd, () => {
      for (const { space, dirName } of builds) writeStateFile(pd, recordHomeLocation(readStateFile(pd, dirName, space), follow.address), dirName, space);
    });
    // A plan that parted from the build's: the line for a plan shared again over its history, in place of the moved
    // line, said at the move whatever was said before.
    if (parted) {
      for (const { build } of builds) {
        saidWithNextStep(pd, planSharedOverWords(follow.plan, build.unit));
        noteEngineAskMark(pd, planSharedOverMark(build.unit));
      }
      return true;
    }
  }
  const line = planMovedLine(follow, "build");
  const chat = resolveWorkflowSelection(pd).sessionId ?? null;
  // Followed, it is said once by itself (the next look reads the new place); not followed, once a chat.
  if (follow.kind === "followed" || chat === null || !personLineHeard(pd, chat, line)) {
    saidWithNextStep(pd, line);
    if (chat !== null && follow.kind !== "followed") markPersonLinesHeard(pd, chat, [line]);
  }
  return true;
}

// The builds here that read this work's plan at `from`, re-keyed to where it
// was read now (`plan`, read by the one reader), with their line: a plan that
// `parted` from theirs is said as a plan shared again.
export function followBuildsTo(pd: string, plan: PlanSnapshot, from: string, parted = false): boolean {
  return buildsFollow(pd, plan.place.id8, from, {
    kind: "followed", label: plan.plan.work.label || plan.place.id8, repo: plan.plan.plan_repo.name, address: plan.place.address,
    copy: plan.place.copy, oid: plan.oid, plan: plan.plan,
  }, parted);
}

// Where a plan read in another repository stands against `own`, this
// computer's plan of the same work: "holds" when its history holds `own` (a
// take-over at the new place is one commit on the old tip), "parted" when
// neither history holds the other; null where it names the same repository or
// is behind `own`, so a look never goes back to the plan that is behind.
export function planAgainst(pd: string, there: PlanSnapshot, own: PlanSnapshot): "holds" | "parted" | null {
  if (there.oid === own.oid || repoCopyKey(there.plan.plan_repo.address) === repoCopyKey(own.plan.plan_repo.address)) return null;
  if (localGit(pd, ["merge-base", "--is-ancestor", own.oid, there.oid]).ok) return "holds";
  return localGit(pd, ["merge-base", "--is-ancestor", there.oid, own.oid]).ok ? null : "parted";
}

// The one act after each fetch of a plan's ref at `from`: null when the copy
// there is no pointer; else where it leads (followPlan), every build here that
// reads it at `from` re-keyed and told, and the lead's own work here that reads
// it at `from` handed to the lead's side (leadFollowsPlan), its line queued for
// the next step unless the caller says it itself (`say: false`, the writer and
// the lead's offer). `built`: a build here was told, so a look says nothing more.
export function followMoved(pd: string, id8: string, from: string, typed: boolean, options: { say?: boolean } = {}):
  { follow: PlanFollow; built: boolean; leadLine: string | null } | null {
  const at = planAtCopy(pd, copyOf(from, planRecordRef(id8)));
  if (at.kind !== "moved") return null;
  const follow = followPlan(pd, from, id8, at.pointer, typed);
  if (follow.kind === "newer") return { follow, built: false, leadLine: null };
  const lead = leadWorkHere(pd, at.pointer.work.id);
  const leadState = lead === null ? "" : (() => {
    try {
      return readStateFile(pd, lead.dirName, lead.space);
    } catch {
      return "";
    }
  })();
  // The lead's side only where this checkout leads the work by the one rule (planMadeElsewhere, lifted by
  // `unit lead-here`): a teammate's clone of the team's workspace has the lead's record on disk and is not the lead.
  const leads = lead !== null && isTeamUnitOwnership(leadState) && unitBuildOf(leadState) === null &&
    sameGitAddress(homeLocation(leadState) ?? "", from) && !planMadeElsewhere(pd, readAuditShardEvents(pd, lead.dirName, lead.space));
  const leadLine = leads ? leadFollowsPlan(pd, lead, follow) : null;
  if (leadLine !== null && options.say !== false) saidWithNextStep(pd, leadLine);
  return { follow, built: buildsFollow(pd, id8, from, follow), leadLine };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Who last changed the plan at `commit`, as its commit says, for every line
// that names the plan's last change: the author's name as git wrote it, the
// author date's day and month ("16 Nov"), and what the change was (the words
// after AI-DLC's own "aidlc plan <label> <version>: ", else the first line of
// the message the person gave). Null when the commit is not here.
export function planLastChange(projectDir: string, commit: string): { what: string; name: string; day: string } | null {
  const shown = localGit(projectDir, ["show", "-s", "--format=%an%x00%aI%x00%s", commit, "--"]);
  const [name, date, subject] = shown.ok ? shown.stdout.trim().split("\0") : [];
  const at = /^\d{4}-(\d{2})-(\d{2})T/.exec(date ?? "");
  if (name === undefined || subject === undefined || at === null) return null;
  const what = /^aidlc plan .* \d+: (.+)$/.exec(subject)?.[1] ?? subject;
  return { what, name, day: `${Number(at[2])} ${MONTHS[Number(at[1]) - 1]}` };
}

// What this computer has of the plan's history, kept with the question's own
// marks in the work's engine folder: a plan commit it wrote, or one the lead
// kept or carried on from (`here`); a change the lead said to take out at the
// next write (`out`); the question put about a tip (`asked`).
export function planMark(kind: "here" | "out" | "asked", commit: string): string {
  return `plan-${kind}-${commit}.json`;
}

// The plan commits this computer wrote or said yes to, newest first by when it
// marked each.
function planCommitsHere(projectDir: string): string[] {
  const root = recordDir(projectDir);
  let names: string[] = [];
  try {
    names = root === null ? [] : readdirSync(join(root, ENGINE_DIR));
  } catch {
    // No engine folder: none marked.
  }
  return names.flatMap((name) => {
    const commit = /^plan-here-([0-9a-f]+)\.json$/.exec(name)?.[1];
    const mark = commit === undefined ? null : engineAskMark(projectDir, name);
    return commit === undefined || mark === null ? [] : [{ commit, at: mark.at ?? "", offset: mark.offset }];
  }).sort((a, b) => (a.at === b.at ? b.offset - a.offset : a.at < b.at ? 1 : -1)).map((entry) => entry.commit);
}

// The plan commits on `tip` outside the history of every one this computer
// wrote or said yes to, oldest first, and the newest of those it has (`base`):
// a history put in place of the plan's, or merged under someone else's, is
// listed whole. Null when it has none (a computer that never wrote on the plan
// or answered about it).
function planChangesNotHere(projectDir: string, tip: string): { commits: string[]; base: string } | null {
  const here = planCommitsHere(projectDir);
  if (here.length === 0) return null;
  // On standard input, as many as there are; one git no longer has is left out.
  const listed = localGit(projectDir, ["rev-list", "--ignore-missing", "--stdin"], undefined, `${tip}\n${here.map((commit) => `^${commit}\n`).join("")}`);
  const commits = listed.ok ? listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  // The baseline is the marked plan commit nearest the tip in its history, so
  // two marks made in one second (a move marks its plan and its note) never
  // read in the wrong order; the note, which is not a plan, is never it.
  const marked = new Set(here);
  const isPlan = (commit: string): boolean => planJsonOf(localGit(projectDir, ["show", `${commit}:plan.json`, "--"]).stdout).plan !== null;
  const history = localGit(projectDir, ["rev-list", tip]).stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const base = history.find((commit) => marked.has(commit) && isPlan(commit)) ?? here.find(isPlan) ?? here[0];
  return { commits: commits.filter((commit) => !onlyMovedThePlan(projectDir, commit)).reverse(), base };
}

// A commit that only moved the plan (its tree is its parent's but for
// plan.json, which names another place and the next version, nothing else):
// nobody's decision, so this computer's baseline steps over it.
function onlyMovedThePlan(projectDir: string, commit: string): boolean {
  const changed = localGit(projectDir, ["diff", "--name-only", "--no-renames", `${commit}^`, commit, "--"]);
  if (!changed.ok || changed.stdout.trim() !== "plan.json") return false;
  const [before, after] = [`${commit}^`, commit].map((at) => planJsonOf(localGit(projectDir, ["show", `${at}:plan.json`, "--"]).stdout).plan);
  if (before === null || after === null) return false;
  const rest = (plan: PlanJson): string => JSON.stringify({ ...plan, plan_repo: null, version: null });
  return JSON.stringify(before.plan_repo) !== JSON.stringify(after.plan_repo) && rest(before) === rest(after);
}

// A change on the plan this computer did not write, waiting for the lead's
// answer: the tip asked about and each commit's name, day and words, oldest first.
export type PlanChange = { tip: string; work: string; repo: string; changes: Array<{ name: string; day: string; what: string }> };

// The plan at `tip`, read at the lead's project: a change someone else wrote
// since this computer's last write or yes, unanswered; on a computer with
// no baseline, the plan as it stands is where it carries on from, said once
// (`first`), and nothing is asked.
function planChangeAt(pd: string, tip: string, plan: PlanJson): { change: PlanChange | null; first: string | null } {
  const found = planChangesNotHere(pd, tip);
  if (found === null) {
    noteEngineAskMark(pd, planMark("here", tip));
    const last = planLastChange(pd, tip);
    return {
      change: null,
      first: last === null ? null : `The plan of ${plan.work.label} in ${plan.plan_repo.name} was last changed by ${last.name}, ${last.day}. ` +
        `Its commit says "${last.what}". This computer carries on from it.`,
    };
  }
  if (found.commits.length === 0 || engineAskMark(pd, planMark("out", tip)) !== null) return { change: null, first: null };
  const changes = found.commits.map((commit) => planLastChange(pd, commit)).filter((entry) => entry !== null);
  return { change: { tip, work: plan.work.label, repo: plan.plan_repo.name, changes }, first: null };
}

// The plan a view's lead word is read from: as this workspace last read it;
// at the lead's project, while a change someone else wrote on it waits for the
// lead's answer (or for the write that takes it out), as this computer had it
// before that change, so nothing is read as the lead's own word before they say.
function wordPlanOf(pd: string, id8: string): PlanJson | null {
  const plan = planOfWork(pd, id8);
  if (plan === null) return null;
  try {
    if (unitBuildOf(stateHere(pd) ?? "") !== null || activeIdentity(pd).intentId8 !== id8) return plan;
    const kept = keptPlan(pd, id8);
    if (kept === null) return plan;
    const key = `${pd}\0${kept.commit}`;
    let base = planBaselines.get(key);
    if (base === undefined) {
      const found = planChangesNotHere(pd, kept.commit);
      base = found === null || found.commits.length === 0 || engineAskMark(pd, planMark("here", kept.commit)) !== null ? null : found.base;
      planBaselines.set(key, base);
    }
    if (base === null) return plan;
    const read = planAtCopy(pd, kept.ref, { commit: base });
    return read.kind === "read" ? read.plan : plan;
  } catch {
    return plan;
  }
}

// A view is read many times a step: the baseline of a plan tip, once per command.
const planBaselines = new Map<string, string | null>();

// The lead's own work, as this computer last read its plan (the look reads it first).
export function leadPlanChange(projectDir: string): { change: PlanChange | null; first: string | null } {
  const pd = resolveProjectDir(projectDir);
  try {
    const kept = keptPlan(pd, activeIdentity(pd).intentId8);
    return kept === null ? { change: null, first: null } : planChangeAt(pd, kept.commit, kept.plan);
  } catch {
    return { change: null, first: null };
  }
}

// The lead's question about a change on the plan this computer did not write,
// with its two answers (`unit plan-change`); several changes are listed, oldest
// first, the ten newest past ten.
export function planChangeQuestion(change: PlanChange): { question: string; choices: Array<{ label: string; detail: string; command: string }> } {
  const answer = (verb: string): string => `${aidlcToolInvocation("unit")} plan-change ${verb} --tip ${change.tip}`;
  const keep = { detail: "The plan stays as it is, and what you decide next goes on top.", command: answer("keep") };
  const put = (it: string, stays: string): string => `At my next write to the plan I put it back as you last had it, in a new commit on top. ` +
    `Until then ${it} ${stays} in ${change.repo}, and ${it} ${stays} in the plan's history after.`;
  const line = (entry: { name: string; day: string; what: string }): string => `${entry.name}, ${entry.day}. Its commit says "${entry.what}".`;
  if (change.changes.length === 1) {
    return {
      question: `The plan of ${change.work} in ${change.repo} has a change this computer did not write, by ${line(change.changes[0])} Keep it on the plan?`,
      choices: [{ label: "Keep it", ...keep }, { label: "Take it out", detail: put("it", "stays"), command: answer("take-out") }],
    };
  }
  const shown = change.changes.slice(-10);
  const earlier = change.changes.length - shown.length;
  return {
    question: `The plan of ${change.work} in ${change.repo} has ${change.changes.length} changes this computer did not write:\n` +
      `${shown.map(line).join("\n")}${earlier > 0 ? `\nand ${earlier} earlier` : ""}\nKeep them on the plan?`,
    choices: [{ label: "Keep them", ...keep }, { label: "Take them out", detail: put("they", "stay"), command: answer("take-out") }],
  };
}

// The lead's answer about a change on the plan: kept on this computer only,
// for the next write; nothing is written and nothing is said.
function planChangeAnswer(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const answer = positional[0];
  const tip = flags.tip ?? "";
  if ((answer !== "keep" && answer !== "take-out") || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(tip)) fail(`usage: ${unitUsage("plan-change")}`);
  const pd = resolveProjectDir(projectDir);
  noteEngineAskMark(pd, planMark(answer === "keep" ? "here" : "out", tip));
  console.log(JSON.stringify({ answered: answer, tip }));
}

// Lines a lead's plan write leaves for the person beside its own: the plan put
// back as they last had it, or where a computer with no baseline carries on from.
let planNotes: string[] = [];

export function takePlanNotes(): string[] {
  const notes = planNotes;
  planNotes = [];
  return notes;
}

// A notice with the plan's lines that came with its write.
function withPlanNotes(notice: string): string {
  return [notice, ...takePlanNotes()].join(" ");
}

// This computer's copy of the plan, as last written or read.
export function planShared(projectDir: string, place: PlanPlace): { commit: string; plan: PlanJson } | null {
  const read = planAt(projectDir, place);
  return read.kind === "read" ? { commit: read.plan.oid, plan: read.plan.plan } : null;
}

// The plan's place for a work's state: a Unit's build (its Home Location, Home
// Work and Home Label) or the lead's own work (its Home Location and its row in
// the space's list, `at`). Null with no Home Location, or "local" (no
// repository has an address yet).
export function planPlace(projectDir: string, state: string, at?: { dirName: string; space: string }): PlanPlace | null {
  const address = homeLocation(state);
  if (address === null || address === "local") return null;
  const build = unitBuildOf(state);
  refuseOptionAddress(address, recordedAddressRefusal(at?.dirName ?? build?.unit ?? address));
  let uuid = build?.homeWork ?? "";
  let work = build === null ? "" : getField(state, "Home Label")?.trim() ?? "";
  if (build === null && at !== undefined) {
    const row = readIntentRegistry(projectDir, at.space).find((entry) => entry.dirName === at.dirName);
    uuid = row?.uuid ?? "";
    work = row?.slug || at.dirName;
  }
  if (uuid === "") return null;
  const id8 = idSuffix(uuid);
  const ref = planRecordRef(id8);
  const copy = copyOf(address, ref);
  const kept = planAtCopy(projectDir, copy);
  return { address, repo: kept.kind === "read" ? kept.plan.plan_repo.name : repoNameOf(address), id8, uuid, work: work || id8, ref, copy };
}

// The addresses a person said a plan is in, kept until a build holds one.
export function keepSaidPlan(projectDir: string, address: string): void {
  const said = saidPlans(projectDir).filter((entry) => !sameGitAddress(entry.address, address));
  writeSaidPlans(projectDir, [...said, { address: recordedAddress(projectDir, address), at: isoTimestamp() }]);
}

export function dropSaidPlan(projectDir: string, address: string): void {
  const said = saidPlans(projectDir);
  const kept = said.filter((entry) => !sameGitAddress(entry.address, address));
  if (kept.length !== said.length) writeSaidPlans(projectDir, kept);
}

// The repositories this workspace has, by address: its own remotes, each
// repos.json entry's, and each clone on disk by its own remote; then each
// address the person said. One entry per repository.
function workspaceAddresses(pd: string): Array<{ name: string; address: string }> {
  const found: Array<{ name: string; address: string }> = [];
  const add = (name: string, address: string): void => {
    if (address !== "" && !found.some((entry) => sameGitAddress(entry.address, address))) found.push({ name, address });
  };
  const urlOf = (dir: string, remote: string | null): string =>
    remote === null ? "" : absoluteAddress(dir, git(dir, ["remote", "get-url", remote]).stdout.trim());
  const own = soleRemote(pd);
  add(repoNameOf(urlOf(pd, own)) || basename(pd), urlOf(pd, own));
  for (const [name, entry] of readWorkspaceRepos(pd).entries) add(name, entry.url ? absoluteAddress(pd, entry.url) : "");
  for (const name of workspaceRepoNames(pd)) {
    const dir = repoDir(pd, name);
    if (isGitRepoDir(dir) && resolve(dir) !== resolve(pd)) add(name, urlOf(dir, soleRemote(dir)));
  }
  return found;
}

// The repositories this workspace has by name, the one list the sweep and
// gitTargetFor read: the work's, repos.json's, and each clone found on disk.
function workspaceRepoNames(pd: string): Set<string> {
  return new Set([...intentRepos(pd), ...discoverSiblingRepos(pd), ...readWorkspaceRepos(pd).entries.keys()]);
}

// Each pointer a look for plans met, from where: whether a build here was told
// of it (`built`) and whether the said list already held where it went (`held`).
export type PlansMoved = Array<{ from: string; built: boolean; held: boolean; follow: Exclude<PlanFollow, { kind: "newer" }> }>;

// The plans this workspace can read with nothing said but the person's ask:
// one look per repository it has and per address said (one fetch of every plan
// ref there, by prefix), a host that did not answer not asked again in the same
// sweep. The address said now is read first, as the person's own typed step
// (their sign-in, git's own limits), and never skipped. Only a copy whose work
// id part is a work id and whose plan.json names that work is a plan; one found
// in a repository nobody named is a plan only when plan.json names that
// repository as its own (a mirror, a fork or a push of the ref elsewhere is
// passed by). `read` names the repositories read, for the ask; `saidUnread` is
// git's words when the address said now could not be read (null at the limit).
export function lookForPlans(projectDir: string, said?: string): {
  plans: PlanRead[]; read: string[]; unread: Array<{ name: string; address: string; said: string | null }>; refused?: string;
  saidUnread?: string | null; saidGone?: PlanJson[]; moved: PlansMoved;
} {
  const pd = resolveProjectDir(projectDir);
  if (said !== undefined) refuseOptionAddress(said, optionAddressRefusal(said));
  type Place = { name: string; address: string; named?: true; now?: true };
  const places: Place[] = [];
  const add = (place: Place): void => {
    const known = places.find((entry) => sameGitAddress(entry.address, place.address));
    if (known === undefined) places.push(place);
    else if (place.named) known.named = true;
  };
  if (said !== undefined) add({ name: repoNameOf(said) || said, address: said, named: true, now: true });
  for (const kept of saidPlans(pd)) add({ name: repoNameOf(kept.address) || kept.address, address: kept.address, named: true });
  for (const place of workspaceAddresses(pd)) add(place);
  const plans: PlanRead[] = [];
  const read: string[] = [];
  const unread: Array<{ name: string; address: string; said: string | null }> = [];
  let saidUnread: string | null | undefined;
  // Plans the address said now had (a copy here) and has no longer.
  const saidGone: PlanJson[] = [];
  const moved: PlansMoved = [];
  const silentHosts = new Set<string>();
  const hostOf = (address: string): string => gitAddressKey(absoluteAddress(pd, address)).split("/")[0] ?? "";
  for (const { named, now, ...place } of places) {
    if (place.address.startsWith("-")) continue;
    if (!now && silentHosts.has(hostOf(place.address))) {
      unread.push({ ...place, said: null });
      continue;
    }
    const looked = lookAt(pd, place.address, ["refs/aidlc/plans/"], now ? { typed: true } : {});
    if (!looked.ok) {
      if ("refused" in looked) return { plans, read, unread, moved, refused: looked.refused };
      if (looked.said === null && !now) silentHosts.add(hostOf(place.address));
      if (now) saidUnread = looked.said;
      unread.push({ ...place, said: looked.said });
      continue;
    }
    read.push(place.name);
    for (const [ref, seen] of Object.entries(looked.refs)) {
      const id8 = /^refs\/aidlc\/plans\/([0-9a-f]{8})$/.exec(ref)?.[1];
      if (id8 === undefined) continue;
      const copy = copyOf(place.address, ref);
      const at = planAtCopy(pd, copy, { found: !named });
      if (seen.now === null) {
        if (now && at.kind === "read") saidGone.push(at.plan);
        continue;
      }
      if (at.kind === "moved") {
        const met = followMoved(pd, id8, place.address, now === true);
        if (met === null || met.follow.kind === "newer") continue;
        const follow = met.follow;
        moved.push({ from: place.address, built: met.built, follow,
          held: follow.kind === "followed" && saidPlans(pd).some((entry) => sameGitAddress(entry.address, follow.address)) });
        if (follow.kind === "followed") {
          plans.push(planAt(pd, { address: follow.address, repo: follow.repo, id8, uuid: follow.plan.work.id, work: follow.label, ref, copy: follow.copy }));
        }
        continue;
      }
      const kept: PlanPlace = { address: recordedAddress(pd, place.address), repo: place.name, id8, uuid: "", work: id8, ref, copy };
      if (at.kind === "newer") plans.push({ kind: "newer", format: at.format, place: kept });
      // At a place the person named, a plan that is there and does not read is said; one found is passed by.
      if (at.kind === "unreadable" && named && textAt(pd, copy, "plan.json") !== null) plans.push({ kind: "unreadable", place: kept });
      if (at.kind !== "read") continue;
      const placed: PlanPlace = { ...kept, repo: at.plan.plan_repo.name, uuid: at.plan.work.id, work: at.plan.work.label || id8 };
      plans.push(planAt(pd, placed));
    }
  }
  return { plans, read, unread, moved, ...(saidUnread !== undefined ? { saidUnread } : {}), ...(saidGone.length > 0 ? { saidGone } : {}) };
}

// Each setting a build copies, as plan.json holds it: the ceremonies' and the
// Guard Policy's parsed value, the gate rhythm as the build reads it, the rest
// as the lead's state has it.
function planSettings(state: string): Record<string, string> {
  const ceremonies = new Set<string>(Object.values(CEREMONY_FIELDS));
  const settings: Record<string, string> = {};
  for (const name of PLAN_SETTINGS) {
    const policyField = name === "Guard Policy" ? guardPolicyStateField(state) : null;
    const value = name === "Guard Policy" ? (policyField === null ? null : parseGuardPolicyStateLine(getField(state, policyField))?.value ?? null)
      : ceremonies.has(name) ? parseCeremonyStateLine(getField(state, name))?.value ?? null
      : name === UNIT_GATE_RHYTHM_FIELD ? readUnitGateRhythm(state)
      : getField(state, name)?.trim() || null;
    if (value !== null) settings[name] = String(value);
  }
  return settings;
}

// A file of the lead's record as the plan carries it: CRLF read as LF, so two
// computers write the same plan.
function planText(path: string): string | null {
  try {
    return committedTextBytes(readFileSync(path)).toString("utf-8");
  } catch {
    return null;
  }
}

// The plan as a share builds it from the lead's record now: plan.json and each
// file of its commit (null for one the tip has that this plan no longer does).
// The lead's word and every key the tip has that this does not own are taken
// from the tip as it is, so a second computer of the lead's keeps them.
export function planFilesNow(projectDir: string, tip: PlanJson | null, place: PlanPlace):
  { plan: PlanJson; files: Record<string, string | null> } {
  const pd = resolveProjectDir(projectDir);
  const { space } = activeIdentity(pd);
  const state = readStateFile(pd);
  const record = recordDir(pd);
  if (record === null) fail("Cannot resolve the active intent record path.");
  const dependencies = readFileSync(unitDependencyPath(pd), "utf-8");
  const parsed = parseBoltDag(dependencies);
  if (!parsed.ok) fail(`Cannot resolve Unit dependencies: ${parsed.reason}: ${parsed.detail}`);
  const likely = unitLikelyReposFrom(dependencies);
  const skeleton = teamSkeletonOn(state) ? parsed.batches[0]?.[0] ?? null : null;
  const done = completedUnits(state);
  const unitStages = unitMajorConstructionStageSlugs(getField(state, "Scope") ?? "", state, true);
  const files: Record<string, string | null> = {};
  const inputs: PlanJson["inputs"] = [];
  const paths = homeInputPaths(unitStages, state);
  const times = approvalTimes(readAuditShardEvents(pd), new Set(paths.map((path) => path.split("/")[1])));
  for (const path of paths) {
    const text = planText(join(record, ...path.split("/")));
    if (text === null) continue;
    files[`inputs/${path}`] = text;
    const approved = times.get(path.split("/")[1]);
    inputs.push({ path, fingerprint: textFingerprint(text), ...(approved === undefined ? {} : { approved }) });
  }
  for (const gone of tip?.inputs ?? []) if (!(`inputs/${gone.path}` in files)) files[`inputs/${gone.path}`] = null;
  const rules = leadRulesOf(pd, space).paths;
  for (const file of ["team.md", "project.md"]) {
    const path = rules.find((rule) => rule.endsWith(`/${file}`));
    files[`rules/${file}`] = path === undefined ? null : planText(join(pd, ...path.split("/")));
  }
  // A Unit a teammate took while the work was solo keeps its record where it
  // is, in the workspace's own repository, which the plan then lists.
  let claims = new Map<string, UnitClaimView>();
  try {
    claims = cachedClaims(pd);
  } catch {
    // No claims read here: none taken from solo work.
  }
  const own = leadsOwnClaims(pd, state, claims);
  const soloTaken = new Set([...claims.values()]
    .filter((claim) => claim.status === "claimed" && !own.has(claim.unit) && takenWhileSolo(pd, claim)).map((claim) => claim.unit));
  const repos = planRepos(pd);
  const workspace = soloTaken.size > 0 ? workspaceRepoEntry(pd, space) : null;
  if (workspace !== null && !repos.some((repo) => repo.name === workspace.name)) repos.push(workspace);
  const unitRepos = new Map<string, string[]>(parsed.units.map((edge) =>
    [edge.name, [...new Set((likely.get(edge.name) ?? []).map((repo) => repo.split("/")[0]))]]));
  // A repository a Unit names that the work's list lacks is listed too, with
  // what the lead has of it, so every name in the plan reads there.
  for (const name of new Set([...unitRepos.values()].flat())) {
    if (!repos.some((repo) => repo.name === name)) repos.push(planRepoEntry(pd, name));
  }
  // A record goes where it can be written: the first of the Unit's
  // repositories with an address, else the plan's own. A Unit the plan lists
  // keeps the record place it has, wherever the plan is now (a move, a later
  // share), so a take recorded there is never looked for elsewhere; its
  // repository stays listed as the plan had it.
  const addressed = (name: string): boolean => repos.some((repo) => repo.name === name && repo.address !== null);
  for (const unit of tip?.units ?? []) {
    if (repos.some((repo) => repo.name === unit.record)) continue;
    // A record at the plan's own repository, which the work's list may not name.
    const listed = tip?.repos.find((repo) => repo.name === unit.record) ??
      (tip?.plan_repo.name === unit.record ? { name: tip.plan_repo.name, address: tip.plan_repo.address, branch: null } : undefined);
    if (listed !== undefined) repos.push(listed);
  }
  const plan: PlanJson = {
    format: PLAN_FORMAT,
    version: (tip?.version ?? 0) + 1,
    work: { id: place.uuid, label: place.work, space },
    plan_repo: { name: place.repo, address: place.address },
    repos,
    units: parsed.units.map((edge) => {
      const named = unitRepos.get(edge.name) ?? [];
      const word = tip === null
        ? (done.has(edge.name) && edge.name !== skeleton ? { done: true } : {})
        : tip.units.find((unit) => unit.name === edge.name)?.word ?? {};
      const record = tip?.units.find((unit) => unit.name === edge.name)?.record ??
        (workspace !== null && soloTaken.has(edge.name) ? workspace.name : named.find(addressed) ?? place.repo);
      return { name: edge.name, waits_on: [...edge.depends_on], repos: named, record, word };
    }),
    skeleton,
    settings: planSettings(state),
    stages: Object.fromEntries(parseCheckboxes(state).map((box) => [box.slug, box.state])),
    unit_stages: unitStages,
    inputs,
  };
  for (const [key, value] of Object.entries(tip ?? {})) if (!(key in plan)) plan[key] = value;
  return { plan, files };
}

// The plan's tree: `parent`'s (none when null) with each file written, or
// taken out when null, and plan.json from `plan`, built in an index of its own
// so the person's index and files are never touched. Every path goes to git on
// standard input, never the command line, so a plan with many inputs stays
// inside the length Windows allows a command.
function planTree(pd: string, parent: string | null, plan: PlanJson, files: Record<string, string | null>): string {
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-plan-"));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    if (parent !== null) {
      const read = git(pd, ["read-tree", parent], env);
      if (!read.ok) fail(`git read-tree failed: ${read.stderr.trim()}`);
    }
    const all: Record<string, string | null> = { ...files, "plan.json": `${JSON.stringify(plan, null, 2)}\n` };
    const written = Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null);
    for (const [at, [, text]] of written.entries()) writeFileSync(join(scratch, `${at}.blob`), text, "utf-8");
    const blobs = git(pd, ["hash-object", "-w", "--no-filters", "--stdin-paths"], env,
      written.map((_, at) => `${join(scratch, `${at}.blob`)}\n`).join(""));
    if (!blobs.ok) fail(`git hash-object failed: ${blobs.stderr.trim()}`);
    const oids = blobs.stdout.split(/\r?\n/).filter(Boolean);
    const zero = "0".repeat(oids[0].length);
    const entries = [
      ...written.map(([path], at) => `100644 ${oids[at]}\t${path}\n`),
      ...Object.entries(all).filter(([, text]) => text === null).map(([path]) => `0 ${zero}\t${path}\n`),
    ];
    const updated = git(pd, ["update-index", "--index-info"], env, entries.join(""));
    if (!updated.ok) fail(`git update-index failed: ${updated.stderr.trim()}`);
    const tree = git(pd, ["write-tree"], env);
    if (!tree.ok) fail(`git write-tree failed: ${tree.stderr.trim()}`);
    return tree.stdout.trim();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The plan's commit on `parent` (none at the first), as the person's own commit.
export function planCommit(projectDir: string, parent: string | null, plan: PlanJson, files: Record<string, string | null>,
  what: string, message?: string): string {
  return commitAsPerson(projectDir, planTree(projectDir, parent, plan, files), parent === null ? [] : [parent],
    message ?? `aidlc plan ${plan.work.label} ${plan.version}: ${what}`);
}

// The push of the plan's commit with a lease on exactly `lease` (the tip read;
// null: none there). `lost` is git's own race classes, `byRule` a rule of the
// remote's; `words` are git's and the host's own.
export function pushPlan(projectDir: string, place: PlanPlace, commit: string, lease: string | null):
  { ok: true } | { ok: false; lost: boolean; byRule: boolean; words: string; timedOut: boolean } {
  const via = gitTargetFor(projectDir, place.address, "push");
  const pushed = git(projectDir, [
    "push", via.target, `--force-with-lease=${place.ref}:${lease ?? ""}`, `${commit}:${place.ref}`,
  ], { ...via.env, GIT_TERMINAL_PROMPT: "0" });
  if (pushed.ok) {
    localGit(projectDir, ["update-ref", place.copy, commit]);
    return { ok: true };
  }
  return {
    ok: false,
    lost: CLAIM_RACE_LOST.test(pushed.stderr),
    byRule: refusedByHostRule(pushed.stderr),
    words: maskUserinfo(pushRefusal(pushed.stderr)),
    timedOut: /ETIMEDOUT/.test(pushed.stderr),
  };
}

export type PlanFollowed = { place: PlanPlace; line: string };

export type PlanWrite =
  // `over`: written over a tip that was not a plan; `carried`, the lead's
  // decisions on its Units were found to carry. `back`: the changes the lead
  // said to take out, put back under it (planPutBack).
  // `followed`: written where the plan moved to, with the line said once for it.
  // `over.onNote`: written on top of this work's own note; `underNote`: put
  // back where a note says it went, on the plan under that note.
  | { kind: "written"; commit: string; version: number; created: boolean; regained?: true; over?: { carried: boolean; onNote?: true }; back?: { count: number; name: string }; followed?: PlanFollowed; underNote?: true }
  | { kind: "unchanged"; commit: string; followed?: PlanFollowed }
  | { kind: "unreached"; words: string | null }
  | { kind: "refused"; words: string; byRule: boolean }
  | { kind: "stale"; words: string }
  | { kind: "unreadable"; format: number }
  | { kind: "stopped"; detail: unknown; followed?: PlanFollowed }
  // The tip is this work's pointer and followPlan did not reach the plan.
  | { kind: "unfollowed"; follow: Extract<PlanFollow, { kind: "unread" | "not-followed" }> };

// The lead's look at its own work: a copy at its Home Location that is this
// work's note is followed (as a write follows it), so no question is put on the
// note itself. `line` is the line to say once; `unfollowed` when the note could not
// be followed (the lead's writers say why when one is asked for).
export function leadFollowsHere(pd: string): { line: string } | { unfollowed: true } | null {
  const home = homeLocation(stateHere(pd) ?? "");
  if (home === null || !isGitAddress(home) || unitBuildOf(stateHere(pd) ?? "") !== null) return null;
  const met = followMoved(pd, activeIdentity(pd).intentId8, home, false, { say: false });
  if (met === null) return null;
  return met.leadLine === null ? { unfollowed: true } : { line: met.leadLine };
}

// The plan under this work's note at the lead's Home Location, when the note
// says the plan went to `place`: what a share that puts it back there carries.
function planUnderNoteFor(pd: string, place: PlanPlace): { commit: string; plan: PlanJson } | null {
  const home = homeLocation(stateHere(pd) ?? "");
  if (home === null || !isGitAddress(home)) return null;
  const copy = copyOf(home, place.ref);
  const at = planAtCopy(pd, copy);
  if (at.kind !== "moved" || repoCopyKey(at.pointer.moved_to.address) !== repoCopyKey(place.address)) return null;
  const commit = planCommitOf(pd, copy);
  const read = commit === "" ? null : planAtCopy(pd, copy, { commit });
  return read?.kind === "read" ? { commit, plan: read.plan } : null;
}

// The lead's half of a plan that moved, on the lead's other computer or a
// co-lead's (a clone of a shared workspace counts), whose Home Location still
// names the old place: on `followed`, that work's Home Location goes where
// followPlan found the plan, and the line to say once for it comes back (the
// caller says it: a look with its step, a write in its notice; Home Location
// then names the new place, so no later look finds the note). Null otherwise:
// what is not followed is said by the caller, in its own terms.
// `lead`: the lead's work it is (the active work when absent).
export function leadFollowsPlan(pd: string, lead: { dirName: string; space: string } | undefined, follow: PlanFollow): string | null {
  if (follow.kind !== "followed") return null;
  planHomeHere(pd, follow.address, lead);
  return `The plan of ${follow.label} moved to ${follow.repo} (${maskUserinfo(follow.address)}); this computer writes it there now.`;
}

// The lead's Home Location is the repository the plan is in (the active work, or `work`).
function planHomeHere(pd: string, address: string, work?: { dirName: string; space: string }): void {
  withAuditLock(pd, () => {
    const state = readStateFile(pd, work?.dirName, work?.space);
    const recorded = homeLocation(state);
    if (recorded !== null && !sameGitAddress(recorded, address)) {
      writeStateFile(pd, recordHomeLocation(state, address), work?.dirName, work?.space);
    }
  }, work?.dirName, work?.space);
}

// What a write builds on: the tip's commit and plan, null at the first write.
export type PlanTip = { commit: string; plan: PlanJson } | null;

// The one write of the plan: on the remote's tip, never over it. A first write
// with nothing kept here goes create-only with no look first; a lost lease is
// another writer only when the look after it shows another tip, and is tried
// again on that tip, three writes in all; a plan that would hold what the tip
// holds is not written. A write nobody asked for runs quietly.
export function writePlan(
  projectDir: string,
  place: PlanPlace,
  // `what` may be worked out from the tip's plan (null at the first write).
  // `overUnreadable`: the person's yes to share again over a tip that is not a
  // plan (never one of a newer format): a commit on that tip, with the lease.
  // `edit` changes what the share would build (null: nothing to write);
  // `stopIf` stops the write before anything is built when it gives a reason.
  change: {
    what: string | ((tip: PlanJson | null) => string);
    message?: string;
    unasked?: true;
    overUnreadable?: true;
    edit?: (built: { plan: PlanJson; files: Record<string, string | null> }, tip: PlanTip) =>
      { plan: PlanJson; files: Record<string, string | null> } | null;
    stopIf?: (tip: PlanTip) => unknown;
    // A write already sent on from a moved plan's pointer: it follows no further.
    followed?: true;
    // The person named the repository holding this work's pointer, whose plan
    // is not where it points: the plan is written on top of the pointer there.
    onNote?: true;
    // The plan a first write here carries, and builds on, when it is put back
    // where a note says it went (the plan under that note).
    regainFrom?: { commit: string; plan: PlanJson };
  },
): PlanWrite {
  const write = (): PlanWrite => {
    let tip: string | null = null;
    // A plan this computer had that is gone from its repository is written
    // again with what this computer last read on it, so no word on it is lost.
    let gone: PlanJson | null = null;
    const last = planShared(projectDir, place);
    if (localGit(projectDir, ["rev-parse", "--verify", "--quiet", place.copy]).ok) {
      const look = lookAtPlan(projectDir, place);
      if (look.unreached !== undefined) return { kind: "unreached", words: look.unreached };
      tip = look.tip;
      if (tip === null && last !== null) gone = last.plan;
    }
    if (tip === null && gone === null && change.regainFrom !== undefined) gone = change.regainFrom.plan;
    for (let writes = 1; ; writes++) {
      // This work's pointer is never written over: the write goes where the plan moved.
      const pointer = tip === null || change.followed ? null : planAtCopy(projectDir, place.copy, { commit: tip });
      const met = pointer?.kind === "moved" ? followMoved(projectDir, place.id8, place.address, change.unasked !== true, { say: false }) : null;
      if (met !== null) {
        const follow = met.follow;
        if (follow.kind === "newer") return { kind: "unreadable", format: follow.format };
        if (follow.kind === "followed") {
          const line = met.leadLine ?? "";
          const to: PlanPlace = { ...place, repo: follow.repo, address: follow.address, copy: follow.copy };
          const there = writePlan(projectDir, to, { ...change, followed: true });
          return there.kind === "written" || there.kind === "unchanged" || there.kind === "stopped" ? { ...there, followed: { place: to, line } } : there;
        }
        if (follow.kind === "unread" || change.onNote !== true) return { kind: "unfollowed", follow };
      }
      // The one reader of a copy: a plan of another work is no plan, and only a newer AI-DLC's is never written over.
      const read = tip === null ? null : planAtCopy(projectDir, place.copy, { commit: tip });
      const over = read !== null && ((read.kind === "unreadable" && change.overUnreadable === true) || (read.kind === "moved" && change.onNote === true));
      if (read !== null && read.kind !== "read" && !over) return { kind: "unreadable", format: read.kind === "moved" ? read.pointer.format : read.format };
      // Over a tip that is not a plan, what is carried: the newest plan in its history, else this computer's copy.
      const carried = over && tip !== null ? planBelow(projectDir, tip, place.uuid) ?? last : null;
      const before = read?.kind === "read" ? read.plan : tip === null ? gone : carried?.plan ?? null;
      // `stopIf` reads the plan the write builds on: the tip, or what is carried over it.
      const at: PlanTip = read?.kind === "read" && tip !== null ? { commit: tip, plan: read.plan } : carried;
      const stop = change.stopIf?.(at);
      if (stop !== undefined && stop !== null) return { kind: "stopped", detail: stop };
      // Changes the lead said to take out: the write builds on the plan as this
      // computer last had it, every file they touched as it was then.
      const back = at === null ? null : planPutBack(projectDir, place, at.commit);
      const fresh = planFilesNow(projectDir, back?.plan ?? before, place);
      if (back !== null && at !== null) fresh.plan.version = at.plan.version + 1;
      // Its version follows the tip's history, which has no plan to read it from.
      if (over && tip !== null) fresh.plan.version = Number(localGit(projectDir, ["rev-list", "--count", tip]).stdout.trim()) + 1;
      const edited = change.edit === undefined ? fresh : change.edit(fresh, back === null || at === null ? at : { commit: at.commit, plan: back.plan });
      if (edited === null) return { kind: "unchanged", commit: tip ?? "" };
      const built = back === null ? edited : { plan: edited.plan, files: { ...back.files, ...edited.files } };
      if (tip !== null && before !== null &&
        planTree(projectDir, tip, { ...built.plan, version: before.version }, built.files) ===
          localGit(projectDir, ["rev-parse", `${tip}^{tree}`]).stdout.trim()) {
        return { kind: "unchanged", commit: tip };
      }
      const what = typeof change.what === "string" ? change.what : change.what(before);
      // Put back where a note says it went, the plan builds on the history under that note.
      const parent = tip ?? (gone !== null && change.regainFrom !== undefined ? change.regainFrom.commit : null);
      const commit = planCommit(projectDir, parent, built.plan, built.files, what, change.message);
      const pushed = pushPlan(projectDir, place, commit, tip);
      if (pushed.ok) {
        noteEngineAskMark(projectDir, planMark("here", commit));
        return {
          kind: "written", commit, version: built.plan.version, created: tip === null && gone === null,
          ...(tip === null && gone !== null ? { regained: true as const } : {}),
          ...(over ? { over: { carried: before !== null, ...(read?.kind === "moved" ? { onNote: true as const } : {}) } } : {}),
          ...(parent !== null && tip === null ? { underNote: true as const } : {}),
          ...(back === null ? {} : { back: { count: back.count, name: back.name } }),
        };
      }
      if (pushed.timedOut) return { kind: "unreached", words: null };
      const look = lookAtPlan(projectDir, place);
      // git ends a push with one fatal exit whether the host was not reached or
      // answered with no push access or no sign-in: the read after it tells.
      if (!pushed.lost) {
        return look.unreached !== undefined ? { kind: "unreached", words: pushed.words } : { kind: "refused", words: pushed.words, byRule: pushed.byRule };
      }
      if (look.unreached !== undefined) return { kind: "unreached", words: look.unreached };
      if (look.tip === tip) return { kind: "refused", words: pushed.words, byRule: false };
      if (writes === 3) return { kind: "stale", words: pushed.words };
      tip = look.tip;
    }
  };
  return change.unasked ? quietly(write) : write();
}

// The plan as this computer last had it, under a tip whose changes the lead
// said to take out (`unit plan-change take-out`): its plan.json whole and
// every other file those changes touched as it had them (null: not there),
// with how many changes there were and whose the first was. Null when there is
// nothing to put back.
function planPutBack(projectDir: string, place: PlanPlace, tip: string):
  { plan: PlanJson; files: Record<string, string | null>; count: number; name: string } | null {
  if (engineAskMark(projectDir, planMark("out", tip)) === null) return null;
  const out = planChangesNotHere(projectDir, tip);
  const base = out === null || out.commits.length === 0 ? null : planAtCopy(projectDir, place.copy, { commit: out.base });
  if (out === null || base?.kind !== "read") return null;
  const files: Record<string, string | null> = {};
  const changed = localGit(projectDir, ["diff", "--name-only", "--no-renames", out.base, tip, "--"]).stdout.split(/\r?\n/).map((path) => path.trim());
  for (const path of changed.filter((entry) => entry !== "" && entry !== "plan.json")) {
    const shown = localGit(projectDir, ["show", `${out.base}:${path}`, "--"]);
    files[path] = shown.ok ? shown.stdout : null;
  }
  // The plan's own place stays as the tip has it, so a put-back never moves the plan back.
  const at = planAtCopy(projectDir, place.copy, { commit: tip });
  const plan = at.kind === "read" ? { ...base.plan, plan_repo: at.plan.plan_repo } : base.plan;
  return { plan, files, count: out.commits.length, name: planLastChange(projectDir, out.commits[0])?.name ?? "" };
}

// The line after a write that put the plan back.
function planBackLine(repo: string, back: { count: number; name: string }): string {
  return `The plan in ${repo} is back as you last had it. ` +
    (back.count === 1 ? `The change by ${back.name} stays in its history.` : `The ${back.count} changes stay in its history.`);
}

// The newest plan of this work (`id`) that reads under a tip that does not:
// what was pushed on top of the plan keeps it in its history, so the lead's
// decisions on its Units are carried over it. Null when the history holds none.
// ponytail: the 50 newest commits only; a longer history of non-plans carries nothing.
function planBelow(projectDir: string, tip: string, id: string): { commit: string; plan: PlanJson } | null {
  for (const commit of localGit(projectDir, ["rev-list", "--max-count=50", `${tip}^@`]).stdout.split("\n").filter(Boolean)) {
    const shown = localGit(projectDir, ["show", `${commit}:plan.json`]);
    const plan = shown.ok ? planJsonOf(shown.stdout).plan : null;
    if (plan !== null && plan.work.id === id) return { commit, plan };
  }
  return null;
}

// A lead's step writing on the plan, on the plan as its tip has it (as this
// computer last had it, under changes the lead said to take out): its word on
// the Units (`words`, from each Unit's word there; null leaves a Unit's as it
// is) and only what the step is for of the lead's record now (`take`: an
// input's text it approved, a setting, the rules). Everything else stays as
// the share left it, so a Unit added or an input edited since is shared only by
// the share. Work whose plan is not shared, or whose plan is not there, has
// nowhere for it, and nothing is written: a lead's step never shares the plan.
// `gone`: the plan this computer had is not in its repository now.
export type LeadWrite = PlanWrite | { kind: "unshared"; gone?: PlanJson };

export function leadsPlanWrite(projectDir: string, change: {
  what: string | ((tip: PlanJson | null) => string);
  unasked?: true;
  words?: (unit: string, word: UnitWord) => UnitWord | null;
  take?: { inputs?: Record<string, string>; settings?: readonly string[]; rules?: true };
}): LeadWrite {
  const pd = resolveProjectDir(projectDir);
  const write = (): LeadWrite => {
    const place = planPlaceForShare(pd);
    if (!("ref" in place)) return { kind: "unshared" };
    const had = keptPlan(pd, place.id8);
    if (had === null) {
      const look = lookAtPlan(pd, place);
      if (look.tip === null) return look.unreached === undefined ? { kind: "unshared" } : { kind: "unreached", words: look.unreached };
    }
    let gone = false;
    const written = writePlan(pd, place, {
      what: change.what,
      ...(change.unasked ? { unasked: true as const } : {}),
      // A change this computer did not write, unanswered: the lead's question
      // first, and nothing is written.
      stopIf: (tip) => {
        if (tip === null) return undefined;
        const read = planChangeAt(pd, tip.commit, tip.plan);
        if (read.first !== null) planNotes.push(read.first);
        return read.change ?? undefined;
      },
      edit: (built, tip) => {
        gone = tip === null;
        if (tip === null) return null;
        const files: Record<string, string | null> = {};
        const plan: PlanJson = { ...tip.plan, version: built.plan.version };
        if (change.words !== undefined) {
          plan.units = plan.units.map((entry) => {
            const word = change.words!(entry.name, entry.word as UnitWord);
            return word === null ? entry : { ...entry, word: word as Record<string, unknown> };
          });
        }
        for (const [path, text] of Object.entries(change.take?.inputs ?? {})) {
          files[`inputs/${path}`] = planFileText(text);
          const was = built.plan.inputs.find((entry) => entry.path === path) ?? tip.plan.inputs.find((entry) => entry.path === path);
          const entry = { ...(was ?? {}), path, fingerprint: textFingerprint(text) };
          plan.inputs = plan.inputs.some((input) => input.path === path)
            ? plan.inputs.map((input) => (input.path === path ? entry : input))
            : [...plan.inputs, entry];
        }
        {
          // The lead's sign-off setting goes with every write of theirs: one set
          // while a write did not go reaches the plan with the next.
          const settings = { ...plan.settings };
          for (const key of new Set([LEAD_SIGNOFF_FIELD, ...(change.take?.settings ?? [])])) {
            if (built.plan.settings[key] === undefined) delete settings[key];
            else settings[key] = built.plan.settings[key];
          }
          plan.settings = settings;
        }
        if (change.take?.rules) for (const file of ["rules/team.md", "rules/project.md"]) files[file] = built.files[file] ?? null;
        return { plan, files };
      },
    });
    if (written.kind === "written" && written.back !== undefined) planNotes.push(planBackLine(place.repo, written.back));
    if (!gone) return written;
    return had === null ? { kind: "unshared" } : { kind: "unshared", gone: had.plan };
  };
  return change.unasked ? quietly(write) : write();
}

// A text as the plan keeps it (the plan byte rule: CRLF as LF), and the blob it is kept as.
function planFileText(text: string): string {
  return committedTextBytes(Buffer.from(text, "utf-8")).toString("utf-8");
}

// git's words for a write of the lead's that did not go, for the lines that
// name why (none when the tip only kept moving).
export function leadWriteWords(written: LeadWrite): string | undefined {
  return written.kind === "refused" ? written.words : written.kind === "unreached" ? written.words ?? undefined : undefined;
}

// The blob a plan file's text is kept as, so a word can name it.
function planBlobOf(pd: string, text: string): string {
  return git(pd, ["hash-object", "--no-filters", "--stdin"], undefined, planFileText(text)).stdout.trim();
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

// What a Unit's build copies of the lead's plan, one shape whatever it is read
// from: the plan's settings (PLAN_SETTINGS, as planSettings reads a state), the
// per-Unit stages it runs, the stages done at the lead, and the inputs' paths.
interface BuildPlan {
  settings: Record<string, string>;
  stages: string[];
  completed: Set<string>;
  inputs: string[];
  // The plan's repository, as plan.json names it; null for the lead's record.
  planRepo: string | null;
}

// The lead's record in this clone (the solo second person's take), as a plan.
function buildPlanOfState(state: string): BuildPlan {
  const settings = planSettings(state);
  const stages = unitMajorConstructionStageSlugs(settings.Scope ?? "", state, true);
  const completed = new Set(parseCheckboxes(state).filter((box) => box.state === "completed").map((box) => box.slug));
  return { settings, stages, completed, inputs: homeInputPaths(stages, state), planRepo: null };
}

// The plan as shared (a team's take).
function buildPlanOf(plan: PlanJson): BuildPlan {
  return {
    settings: plan.settings,
    stages: [...plan.unit_stages],
    completed: new Set(Object.entries(plan.stages).filter(([, box]) => box === "completed").map(([slug]) => slug)),
    inputs: plan.inputs.map((input) => input.path),
    planRepo: plan.plan_repo.name,
  };
}

// Where a build's copy comes from: the home's commit.
interface BuildSource {
  read: (rel: string) => string | null;
  approvals: (produced: Set<string>) => string[];
}

function createUnitBuild(
  projectDir: string,
  home: HomeRef,
  plan: BuildPlan,
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
  // The gate rhythm the person picked for this build, else the lead's plan's.
  gateRhythm?: UnitClaimPayload["gate_rhythm"],
  // An early take's starts (its row's Early On), which its record holds once written.
  earlyOn?: UnitClaimPayload["early_on"],
): { space: string; dirName: string } {
  const scope = plan.settings.Scope ?? "";
  const grid = loadScopeMapping()[scope];
  if (!grid) fail(`The lead's plan names a scope this install does not have: ${scope}.`);
  const stages = plan.stages;
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
  for (const rel of plan.inputs) {
    const text = source.read(rel);
    if (text === null) continue;
    mkdirSync(dirname(join(record, ...rel.split("/"))), { recursive: true });
    writeFileSync(join(record, ...rel.split("/")), text, "utf-8");
    inputs.push({ path: rel, fingerprint: textFingerprint(text) });
  }
  const produced = new Set(inputs.map((input) => input.path.split("/")[1]));
  const approvals = source.approvals(produced);
  const fingerprint = textFingerprint(inputs.map((input) => `${input.path} ${input.fingerprint}`).join("\n"));
  writeFileSync(join(record, APPROVED_INPUTS_FILE), approvedInputsText(unit, home, baseOid, inputs, approvals, plan.planRepo), "utf-8");
  // Done at the home: the stages before Construction show as done, and are not
  // this build's plan.
  withAuditLock(projectDir, () => {
    let content = readStateFile(projectDir, dirName, space);
    for (const stage of graph.filter((entry) => entry.phase === "ideation" || entry.phase === "inception")) {
      if (plan.completed.has(stage.slug)) content = setCheckbox(content, stage.slug, "completed");
    }
    const rhythm = gateRhythm ?? (plan.settings[UNIT_GATE_RHYTHM_FIELD] === "unit-end" ? "unit-end" : "per-stage");
    for (const [field, value] of [
      ["Construction Iteration", rhythm === "unit-end" ? "unit-major" : "stage-major"],
      ["Construction Execution", "serial"],
      ["Construction Checkpoints", rhythm === "unit-end" ? "enabled" : "disabled"],
      ["Skeleton Stance", "off"],
      [UNIT_BUILD_FIELD, unit],
      [HOME_LOCATION_FIELD, home.location],
      ["Home Work", home.uuid],
      ["Home Label", home.label],
      ["Home Attempt", String(attempt)],
    ] as const) {
      // The build records its home, and with it the version an older AI-DLC stops at.
      content = field === HOME_LOCATION_FIELD ? recordHomeLocation(content, value) : setOrInsertField(content, "## Runtime State", field, value);
    }
    if (leadPaths.length > 0) content = setOrInsertField(content, "## Runtime State", LEAD_RULES_FIELD, leadPaths.join(", "));
    // The plan as the home approved it, never its scope's defaults: each
    // ceremony (Plan Approval, sensors, learnings ...), the depth, the test
    // strategy and the review class the home's plan set.
    for (const name of Object.values(CEREMONY_FIELDS)) {
      const setting = plan.settings[name];
      if (setting === "on" || setting === "off") content = setOrInsertField(content, "## Runtime State", name, formatCeremony(setting, "the lead's plan"));
    }
    for (const name of ["Depth", "Test Strategy", "Review Override", AUTONOMY_MODE_FIELD]) {
      const value = plan.settings[name]?.trim();
      // The lead's "continue automatically" was their answer for their own
      // work: the team approves its Unit itself, and its record says so.
      if (value) content = setOrInsertField(content, "## Runtime State", name, name === AUTONOMY_MODE_FIELD && value === "autonomous" ? "gated" : value);
    }
    // The Guard Policy the lead set; a lock in the team's own memory still wins where it is read.
    const policy = plan.settings["Guard Policy"];
    if (policy === "strict" || policy === "relaxed" || policy === "off") content = setGuardPolicyLine(content, formatGuardPolicy(policy, "the lead's plan"));
    // The type the home settled; a later scan here does not ask about it again.
    const homeType = plan.settings["Project Type"]?.trim();
    if (homeType) {
      content = setOrInsertField(setField(content, "Project Type", homeType), "## Project Information", PROJECT_TYPE_SOURCE_FIELD, PROJECT_TYPE_SOURCE_HOME);
    }
    writeStateFile(projectDir, content, dirName, space);
    appendAuditEntry("UNIT_TAKEN_IN", {
      "Home Location": home.location,
      "Home Work": home.uuid,
      Unit: unit,
      Team: space,
      "Home Attempt": String(attempt),
      "Home Commit": baseOid,
      "Copy Fingerprint": fingerprint,
      "Home Approvals": approvals.join("; ") || "none recorded",
      ...(earlyOn ? { "Early On": earlyOnField(earlyOn) } : {}),
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

// The work a Unit's build belongs to, as its commit message names it.
function homeLabelOf(stateContent: string, build: UnitBuild): string {
  return getField(stateContent, "Home Label")?.trim() || idSuffix(build.homeWork);
}

// The message a Unit's commit carries when the person gives none.
export function unitDefaultMessage(stateContent: string): string {
  const build = unitBuildOf(stateContent);
  return build === null ? "" : `${build.unit}: ${homeLabelOf(stateContent, build)}`;
}

// The file a commit's message is drafted in, in the request-text folder the
// agent writes the person's words to. A Unit's push has one per build (its
// record), so a file left by another build is never this one's; the share's
// and the record's commits have one per offer (`key`, the offer's own once),
// so a draft is only ever shown for the change it was written for.
export type CommitMessageKind = "push" | "share" | "record";
export function commitMessageFile(projectDir: string, kind: CommitMessageKind = "push", key?: string): string | null {
  if (kind !== "push") return key === undefined ? null : unitWordsFile(`${kind}-message`, key);
  const record = recordDir(projectDir);
  return record === null ? null : unitWordsFile("push-message", basename(record));
}

// A message as git commits it (`git stripspace`, its own whitespace cleanup):
// what the push question shows, and what two messages are compared as.
function messageAsGitTakesIt(dir: string, text: string): string {
  const cleaned = git(dir, ["stripspace"], undefined, text);
  return cleaned.ok ? cleaned.stdout.replace(/\n$/, "") : text.trim();
}

const messageHash = (dir: string, text: string): string =>
  createHash("sha256").update(messageAsGitTakesIt(dir, text)).digest("hex");

// Whether HEAD already carries this message, as git takes it.
const messageOnHead = (dir: string, text: string): boolean =>
  messageAsGitTakesIt(dir, git(dir, ["log", "-1", "--format=%B", "HEAD"]).stdout) === messageAsGitTakesIt(dir, text);

// The message as its question shows it, read as its command reads it (a plain
// file directly in the request-text folder, through no link), or null when
// there is none to show: absent, empty, a link, unreadable.
export function heldCommitMessage(projectDir: string, file: string | null): { file: string; text: string } | null {
  if (file === null || !existsSync(join(projectDir, ...file.split("/")))) return null;
  const read = readRequestFile(projectDir, file);
  if (typeof read === "string") return null;
  const text = messageAsGitTakesIt(projectDir, read.text);
  return text === "" ? null : { file, text };
}

// The message the share's own commit carries when no draft was given.
export function shareDefaultMessage(projectDir: string): string {
  const landed = landedNotOnRemote(projectDir).map((row) => row.unit);
  return landed.length > 0 ? `Record the ${landed.join(" and ")} landing` : "Share the plan with the teams";
}

// The push's own commits that did not go yet, by repo: each commit's id and
// the hash of the message it was given (never of what a hook made of it).
// Written as each commit is made and at each refusal, removed once a push
// goes: while it is there, the last push did not go through.
// Said once for a build whose take its record's repository never took (pushUnit).
const takeNotWrittenMark = (unit: string): string => `unit-take-not-written-${unit}.json`;
const PUSH_REFUSED_MARK = "unit-push-refused.json";
type PushRefusedMark = Record<string, { commit: string; message: string }>;

function readPushRefused(record: string): PushRefusedMark | null {
  const path = join(record, ENGINE_DIR, PUSH_REFUSED_MARK);
  if (!existsSync(path)) return null;
  try {
    const read = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (read === null || typeof read !== "object" || Array.isArray(read)) return {};
    return Object.fromEntries(Object.entries(read as Record<string, unknown>).filter((entry): entry is [string, { commit: string; message: string }] => {
      const value = entry[1] as { commit?: unknown; message?: unknown } | null;
      return typeof value?.commit === "string" && typeof value.message === "string";
    }));
  } catch {
    return {};
  }
}

function writePushRefused(record: string, mark: PushRefusedMark): void {
  mkdirSync(join(record, ENGINE_DIR), { recursive: true });
  writeFileAtomic(join(record, ENGINE_DIR, PUSH_REFUSED_MARK), `${JSON.stringify(mark, null, 2)}\n`);
}

// Whether the last push of this build did not go through.
export function unitPushRefused(projectDir: string): boolean {
  const record = recordDir(projectDir);
  return record !== null && readPushRefused(record) !== null;
}

// Whether a commit went nowhere: no remote-tracking ref holds it, and the push
// remote's branch does not either, by git's own answer (ls-remote's status 2 is
// "no such branch"; else the branch's copy, fetched as a refused push fetches
// it). "unknown" for any other answer: offline, sign-in, a fetch that fails.
function wentNowhere(dir: string, remote: string, branch: string, oid: string): "nowhere" | "went" | "unknown" {
  const unheld = git(dir, ["rev-list", "-n", "1", oid, "--not", "--remotes"]);
  if (!unheld.ok) return "unknown";
  if (unheld.stdout.trim() !== oid) return "went";
  const listed = git(dir, ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]);
  if (listed.code === 2) return "nowhere";
  if (!listed.ok) return "unknown";
  if (!git(dir, ["fetch", "-q", remote, `${branch}:refs/remotes/${remote}/${branch}`]).ok) return "unknown";
  const held = git(dir, ["merge-base", "--is-ancestor", oid, `refs/remotes/${remote}/${branch}`]);
  return held.code === 0 ? "went" : held.code === 1 ? "nowhere" : "unknown";
}

// A commit their hook did not let through: told apart from the push's other
// failures by its kind, never by its words.
class CommitRefused extends Error {}

// The one way on after their hook or host refuses a commit AI-DLC makes for
// them; "and push again" only where the command pushes.
function messageWayOn(pushes = true): string {
  return `If it is the commit message, tell me the one to use, and I will commit with it${pushes ? " and push again" : ""}.`;
}

function commitMessageUnread(verb: "push" | "share" | "commit-record"): string {
  return `${verb} --commit-message-file needs the commit message in a file directly inside ` +
    `${REQUEST_TEXT_DIR}/ in this project, written with your file tool. ` +
    (verb === "commit-record" ? "Nothing was committed." : "Nothing was committed or pushed.");
}

// The commit message the person gave, from the file the agent wrote it to,
// taken whole; spent once the command is done, so until then the same command
// runs again as written.
function givenCommitMessage(pd: string, args: string[], verb: "push" | "share" | "commit-record"):
  { file: string; text: string; spend(): void } | null {
  const { flags, bareFlags } = parseArgs(args);
  const file = flags["commit-message-file"];
  if (bareFlags.has("commit-message-file")) fail(commitMessageUnread(verb));
  if (file === undefined) return null;
  const read = readRequestFile(pd, file);
  if (typeof read === "string") fail(commitMessageUnread(verb));
  return { file, text: read.text, spend: read.spend };
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
// `given` is the message the person gave the push: the commit takes it whole,
// through git's own cleanup; `amend` puts it on HEAD, the commit this push
// made and could not push, unless `same` (HEAD was given that message) and
// there is no newer change of the Unit's. An amend of the message alone that
// their hook refuses leaves HEAD as it was, with their hook's words in
// `refused`; any other refused commit stops the push.
function commitUnitPaths(
  dir: string,
  paths: string[],
  own: Record<string, string>,
  unit: string,
  label: string,
  name: string,
  listed: { listing: ReadonlyMap<string, string>; listedAs: string } | null,
  share?: { message: string; refused: (said: string, adding: boolean) => never },
  given?: { message: string; amend: boolean; same: boolean; refused?: string },
): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "aidlc-unit-commit-"));
  const env = { GIT_INDEX_FILE: join(scratch, "index") };
  const leftOut: string[] = [];
  // The paths go to git on its standard input, NUL-separated and read as names, never patterns: Windows caps a
  // command line at 32,767 characters, and an update's own commit names hundreds of AI-DLC's files.
  const named = (list: readonly string[]): string => list.map((path) => `${path}\0`).join("");
  const fromInput = ["--pathspec-from-file=-", "--pathspec-file-nul"];
  try {
    const head = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
    git(dir, head ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], env);
    // A file the Unit deleted whose deletion the branch already has (a redo
    // that merged the newer main, say) leaves nothing to add.
    const plain = paths.filter((path) => own[path] === undefined &&
      (existsSync(join(dir, path)) || git(dir, ["ls-files", "--error-unmatch", "--", path], env).ok));
    if (plain.length > 0) {
      const added = git(dir, ["--literal-pathspecs", "add", ...fromInput], env, named(plain));
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
    // The index started at HEAD and only these paths changed in it, so all of it is theirs to compare.
    const changed = committed.length > 0 && !git(dir, ["diff", "--cached", "--quiet"], env).ok;
    const amend = given?.amend === true && (changed || !given.same);
    if (changed || amend) {
      const made = given === undefined
        ? git(dir, ["commit", "-q", "-m", share?.message ?? `${unit}: ${label}`], env)
        : git(dir, ["commit", "-q", ...(amend ? ["--amend"] : []), "-F", "-"], env, given.message);
      if (!made.ok) {
        const said = (made.stderr || made.stdout).trim();
        if (share) share.refused(said, false);
        if (amend && !changed && given !== undefined) {
          given.refused = said;
          return leftOut;
        }
        throw new CommitRefused(`The commit in ${name} did not go through: ${said}`);
      }
      if (committed.length > 0) git(dir, ["--literal-pathspecs", "reset", "-q", ...fromInput], undefined, named(committed));
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
  planRepo: string | null,
): string {
  return [
    "# What this Unit was approved with",
    "",
    planRepo !== null
      ? `${unit} of ${home.label}, from the plan shared in ${planRepo} (${home.location}), copied from its commit ` +
        `${baseOid.slice(0, 12)}. These files are the lead's: approved there, read here. Change one and AI-DLC asks ` +
        "whether to put your change on the Unit's record, for the lead to decide."
      : `${unit} of ${home.label}, from the lead's project at ${home.location} (space ${home.space}), copied from its commit ` +
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

// What a take builds from, one shape whatever it reads: the lead's plan as
// shared (a team's take), or the lead's record in this clone (the solo second
// person's take).
interface TakeSource {
  home: HomeWork;
  // The commit the take read, and the ref it sits under here.
  integration: { ref: string; branch: string; oid: string };
  build: BuildPlan;
  opening: OpeningStatus;
  solo: (OpeningStatus & { started: Set<string> }) | null;
  planChanging: string | null;
  // The lead's audit rows (the solo take's); a plan carries none.
  rows: AuditShardEvent[];
  likely: Map<string, string[]>;
  rhythm: UnitClaimPayload["gate_rhythm"];
  rules: () => ReturnType<typeof leadRulesOf>;
  copy: BuildSource;
  addresses: Map<string, string>;
  // The plan moved: the take read it where it went, and says so with its line.
  moved?: string;
}

// The solo second person's take: the lead's record in this clone.
function recordTakeSource(pd: string, home: HomeWork): TakeSource {
  const integration = fetchHomeIntegration(pd, home);
  const plan = homePlanAt(pd, home, integration.oid, integration.branch);
  // A plan a newer AI-DLC wrote is never taken here: the step that carries it on, before anything is written.
  refuseNewerWork(pd, plan.state);
  const solo = home.solo ? soloOpening(pd, home, plan) : null;
  const rows = homeAuditAt(pd, home, integration.oid);
  return {
    home,
    integration,
    build: buildPlanOfState(plan.state),
    opening: solo ?? openingStatusFrom(plan.state, plan.dependencies),
    solo,
    planChanging: unitPlanChangingStage(plan.state),
    rows,
    likely: unitLikelyRepos(pd, home.dirName, home.space),
    rhythm: readUnitGateRhythm(plan.state),
    rules: () => leadRulesOf(pd, home.space),
    copy: {
      read: (rel) => {
        const shown = git(pd, ["show", `${integration.oid}:${home.recordPrefix}/${rel}`, "--"]);
        return shown.ok ? shown.stdout : null;
      },
      approvals: (produced) => homeApprovals(rows, produced),
    },
    addresses: leadRepoAddresses(pd, integration.oid),
  };
}

// A team's take: the plan as shared at `from`, read now with the person's own
// login into this workspace's copy, and nothing else of the lead's.
function planTakeSource(pd: string, id8: string, from: string, unit: string): TakeSource {
  refuseOptionAddress(from, optionAddressRefusal(from));
  const address = recordedAddress(pd, from);
  const ref = planRecordRef(id8);
  let place: PlanPlace = { address, repo: repoNameOf(address), id8, uuid: "", work: id8, ref, copy: copyOf(address, ref) };
  const looked = lookAtPlan(pd, place);
  if (looked.unreached !== undefined) fail(`${maskUserinfo(address)} could not be read: ${looked.unreached ?? "it did not answer in time"}`);
  if (looked.tip === null) {
    // The copy a look kept when the plan went from there names it.
    const kept = planAtCopy(pd, place.copy);
    fail(kept.kind === "read" ? planGoneLine(kept.plan) : `${maskUserinfo(address)} does not have this plan now.`);
  }
  let tip = looked.tip;
  const met = followMoved(pd, id8, address, true);
  if (met !== null && met.follow.kind === "newer") fail(newerPlanStep(pd));
  if (met !== null && met.follow.kind !== "newer") {
    if (met.follow.kind !== "followed") fail(planMovedLine(met.follow, "take", unit));
    place = { ...place, address: met.follow.address, repo: met.follow.repo, copy: met.follow.copy };
    tip = met.follow.oid;
  }
  const read = planAt(pd, place, tip);
  if (read.kind === "newer") fail(newerPlanStep(pd));
  if (read.kind === "unreadable") fail(planUnreadableLine(place.repo));
  const snapshot = read.plan;
  const plan = snapshot.plan;
  // The work's repositories are the plan's with an address (a Unit may name a
  // folder, or a repository the lead has no copy of); the workspace's own
  // repository is "." to a build made in it, never a repo of its own.
  const own = workspaceHomeLocation(pd);
  const home: HomeWork = {
    space: plan.work.space, dirName: "", uuid: plan.work.id, id8, label: plan.work.label || id8, location: place.address,
    target: homeTarget(pd, place.address), recordPrefix: "",
    repos: plan.repos.filter((repo) => repo.address !== null && !(own !== null && own !== "local" && sameGitAddress(repo.address, own)))
      .map((repo) => repo.name),
    solo: false, leadCopy: true, plan,
  };
  return {
    home,
    integration: { ref: place.copy, branch: "", oid: snapshot.oid },
    build: buildPlanOf(plan),
    opening: buildOutOpening(plan),
    solo: null,
    planChanging: null,
    rows: [],
    likely: new Map(plan.units.map((unit) => [unit.name, [...unit.repos]])),
    rhythm: plan.settings[UNIT_GATE_RHYTHM_FIELD] === "unit-end" ? "unit-end" : "per-stage",
    rules: () => leadRulesOf(pd, home.space, (rel) => snapshot.text(rel), (file) => `rules/${file}`),
    copy: { read: (rel) => snapshot.text(`inputs/${rel}`), approvals: (produced) => planApprovals(plan, produced) },
    addresses: new Map(plan.repos.flatMap((repo) => (repo.address === null ? [] : [[repo.name, repo.address] as [string, string]]))),
    ...(met?.follow.kind === "followed" && !met.built ? { moved: planMovedLine(met.follow, "look") } : {}),
  };
}

// What is open in a plan as shared: its Units in its order, what each waits on
// that the plan does not say is done, and the walking skeleton every Unit
// waits on until the plan says it is done. A Unit is done when the lead's word
// on the plan says so, or, for the Units waiting on it, when this workspace's
// own git reads its merge (`seen`, mergedAsReadHere).
export function buildOutOpening(plan: PlanJson, seen: ReadonlySet<string> = new Set()): OpeningStatus {
  const units = plan.units.map((unit) => unit.name);
  const completed = new Set(plan.units.filter((unit) => (unit.word as { done?: unknown }).done === true || seen.has(unit.name))
    .map((unit) => unit.name));
  const skeletonBlocked = plan.skeleton !== null && !completed.has(plan.skeleton);
  const blockers = new Map(plan.units.map((unit) => {
    const waiting = unit.waits_on.filter((dep) => !completed.has(dep));
    if (skeletonBlocked) waiting.unshift("walking-skeleton");
    return [unit.name, [...new Set(waiting)]] as [string, string[]];
  }));
  return { units, blockers, completed, landed: new Set(), skeleton: plan.skeleton ?? units[0] ?? "" };
}

// Take a Unit of the home's work: claim it at the home, then start its build
// in the space the person is working in (solo work's in its own space). The
// first take wins; a Unit that waits on another is not taken yet.
// `rhythm`: the gate rhythm the person typed with a claim (claimUnit), else the lead's plan's.
function takeUnit(args: string[], projectDir?: string, rhythm?: UnitClaimPayload["gate_rhythm"]): void {
  const { positional, flags, bareFlags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail(`usage: ${unitUsage("take")}`);
  const unitError = validateUnitName(unit);
  if (unitError) fail(unitError);
  // A team's take reads the plan where it is shared (--plan, --from); the solo
  // second person's reads the lead's record in this clone (--home).
  const fromPlan = flags.plan !== undefined;
  if (!fromPlan && !flags.home) fail("take needs --plan <work id> with --from <the plan's repository address>, or --home <record>.");
  if (fromPlan && (!/^[0-9a-f]{8}$/.test(flags.plan!) || !flags.from)) fail("take --plan needs the plan's work id and --from <the plan's repository address>.");
  const pd = resolveProjectDir(projectDir);
  // The person's words of the take, read before anything is written: a request
  // that cannot be read stops the take here, never after its claim is pushed.
  const takeWords = personWordsOf(pd, flags);
  const homeSpace = flags["home-space"] ?? DEFAULT_SPACE;
  // A build of it here is carried on with nothing of the plan read.
  const builtHere = fromPlan ? findUnitBuildOfWork(pd, flags.plan!, unit) : null;
  const source = builtHere !== null ? null : fromPlan ? planTakeSource(pd, flags.plan!, flags.from!, unit) : null;
  const home = builtHere === null ? source?.home ?? findHomeWork(pd, flags.home!, homeSpace) : null;
  // Work teams build is taken from its plan, never from the lead's record here,
  // whether or not the plan has a place yet: with none, the ask for its address
  // is next --units's step.
  if (!fromPlan && home !== null && !home.solo) {
    const step = isGitAddress(home.location) ? "next" : "next --units";
    fail(`${flags.home} is built by teams: its Units are taken from the plan. Run \`${aidlcInvocation()} ${step}\` for what is ready to take.`);
  }
  if (home !== null) validateClaimRefUnit(home.id8, unit);
  // Taken here before (this clone or another of this workspace): carry it on.
  const existing = builtHere ?? (home === null ? null : findUnitBuild(pd, home.uuid, unit));
  // Carried on, with what bringing it here said before and after the line.
  const carryOn = (found: NonNullable<typeof existing>, before = "", after = ""): void => {
    setActiveSpaceCursor(pd, found.space);
    selectIntentForSession(pd, found.dirName, found.space, resolveWorkflowSelection(pd).sessionId ?? undefined);
    // Whose build it is, said once, from its claim as this workspace last
    // fetched it, while it is taken: a claim given back or freed names nobody.
    const claim = buildClaimHere(pd, found);
    const whose = claim?.status !== "claimed" ? "its" : claimIsMine(pd, claim) ? "your" : `${builderOf(claim)}'s`;
    const carrying = `${before}Carrying on ${unit}, ${whose} build${found.space === DEFAULT_SPACE ? " here" : spaceWords(found.space)}.${after}`;
    console.log(JSON.stringify({
      taken: true,
      resumed: true,
      unit,
      space: found.space,
      record: found.dirName,
      ...(saidWithNextStep(pd, carrying) ? {} : { notice: carrying }),
    }));
  };
  if (existing !== null) {
    carryOn(existing);
    return;
  }
  if (home === null) fail(`${unit}'s build is not here.`);
  const ref = claimRef(home.id8, unit);
  const place = recordPlaceOf(pd, home, unit);
  const current = typedRecordRead(pd, place, recordWork(home), unit, unit);
  if (current === null && recordNewerHere(pd, place, home.id8, unit)) fail(newerRecordStep(pd, unit, place.repo));
  const src = source ?? recordTakeSource(pd, home);
  const { integration, build: plan } = src;
  const planChanging = src.planChanging;
  const solo = src.solo;
  const opening = src.opening;
  if (!opening.units.includes(unit)) fail(`${unit} is not one of ${home.label}'s Units (${opening.units.join(", ")}).`);
  if (solo?.started.has(unit)) fail(`${unit} is being built on the other machine; take another Unit, or follow along.`);
  const me = git(pd, ["config", "user.name"]).stdout.trim() || "a teammate";
  if (current?.status === "claimed" && current.payload.open_again === undefined) {
    if (!claimIsMine(pd, current)) fail(takenLine(unit, current));
    const said = bringOwnBuildHere(pd, home.uuid, current);
    const found = findUnitBuild(pd, home.uuid, unit);
    if (found === null) fail(`${unit}'s build is not here.`);
    carryOn(found, said.before, said.after);
    return;
  }
  if (opening.completed.has(unit)) fail(`${unit} is already done.`);
  // A Unit the home marked done on its claim counts as done, pushed state or not.
  // A dependency's record stops the take when it cannot be read only where the
  // person asked to start early on it; otherwise it is read as last seen here.
  const askedEarly = bareFlags.has("early") || flags.early !== undefined;
  const depRecord = (dep: string): UnitClaimView | null => {
    const at = recordPlaceOf(pd, home, dep);
    if (askedEarly) return typedRecordRead(pd, at, recordWork(home), dep, unit);
    try {
      return readUnitRecord(pd, at, recordWork(home), dep);
    } catch {
      return recordCopied(pd, at, recordWork(home), dep);
    }
  };
  const depClaims = new Map<string, UnitClaimView | null>();
  const blockers = (opening.blockers.get(unit) ?? []).filter((dep) => {
    if (dep === "walking-skeleton") return true;
    depClaims.set(dep, depRecord(dep));
    return depClaims.get(dep)?.payload.done !== true && !(home.plan !== undefined && mergedAsReadHere(pd, depClaims.get(dep), home.plan));
  });
  // Starting early, on the branches its dependencies pushed (the person asked).
  const pushedDeps = blockers.every((dep) => depClaims.get(dep)?.payload.result !== undefined);
  const early = askedEarly && blockers.length > 0 && pushedDeps;
  if (blockers.length > 0 && !early) {
    // The walking skeleton by its Unit's name, never the engine's token for it.
    const named = [...new Set(blockers.map((dep) => (dep === "walking-skeleton" ? opening.skeleton : dep)))];
    fail(
      `${unit} waits on ${named.join(", ")}, which ${named.length === 1 ? "is" : "are"} not done yet. ` +
        `It opens once ${named.length === 1 ? "it is" : "they are"} done` +
        (pushedDeps ? `, or starts early on ${named.length === 1 ? "its" : "their"} pushed branches if you ask.` : "."),
    );
  }
  // The Unit's own repos, as its Unit plan lists them (its likely repos; one
  // that lists none works in all of the work's): an early start branches only
  // these, never a repo a dependency pushed that this Unit does not use.
  const likely = src.likely.get(unit) ?? [];
  const ownRepos = new Set(likely.map((repo) => repo.split("/")[0]));
  const earlyOn = early
    ? blockers.map((dep) => ({
      unit: dep,
      repos: (depClaims.get(dep)?.payload.result?.repos ?? []).filter((repo) => ownRepos.size === 0 || (repo.repo === "." && home.repos.length === 0) || ownRepos.has(repo.repo))
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
    gateRhythm: rhythm ?? src.rhythm, earlyOn,
  });
  const commit = createRecordCommit(pd, current?.oid ?? null, payload, earlyOn ? "taken early" : "taken", {}, { take: true });
  const pushed = writeUnitRecord(pd, place, ref, commit, current?.oid ?? null);
  // The record's repository took no push from here: the take goes on as the
  // person asked, and its record is written there when a push next goes
  // through (recordTakeHere). An early take too: its take row's Early On holds
  // where it started until then.
  let notRecorded: string | null = null;
  if (!pushed.ok) {
    const winner = typedRecordRead(pd, place, recordWork(home), unit, unit);
    if (winner?.status === "claimed") fail(takenLine(unit, winner));
    // Git gave no reason when the record moved under the take.
    if ("lost" in pushed) fail(`${unit} was not taken: its record in ${place.repo} changed while I was writing it. Say when to try again.`);
    notRecorded = pushed.refused.replace(/\.+$/, "");
  }
  if (notRecorded === null) invalidateLiveClaimPayloadCache(pd, unit);
  // A build in the lead's own space, beside the lead's work (a clone of a
  // workspace several teams share), reads the lead's rules as its own already.
  const ownSpace = team === home.space && (!home.leadCopy || leadWorkHere(pd, home.uuid) !== null);
  const withLeadRules = (bareFlags.has("lead-rules") || flags["lead-rules"] !== undefined) && !ownSpace;
  // The lead's rules the build reads too, in the take's own words, as its choice named them.
  // In a team's own workspace the lead's files are read from the lead's commit, never this workspace's own.
  const leads = !withLeadRules ? null : src.rules();
  const leadsToo = leads === null || leads.paths.length === 0 ? ""
    : ` and the lead's ${leads.practices.length > 0 && leads.project.length > 0 ? "practices and project rules"
      : leads.practices.length > 0 ? "practices" : "project rules"}`;
  const build = createUnitBuild(pd, home, plan, integration.oid, unit, team, generation, src.copy, leads?.paths ?? [], takeWords, rhythm, earlyOn);
  // The build's Home Location holds the plan's address from now on.
  if (fromPlan) dropSaidPlan(pd, home.location);
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
      const clean = !ownChanges(pd, [{ repo: repo.repo, dir }]);
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
  const notThere = likelyReposNotHere(pd, likely, home.repos, src.addresses);
  const taken = `${src.moved === undefined ? "" : `${src.moved} `}${unit} is yours. You build it${spaceWords(build.space)} under your team's rules${leadsToo}, from what the lead approved.` +
    // The way back (release, run in this build), said once with the take.
    " If it is not your team's to build, tell me and I will hand it back." +
    earlyLines.map((line) => ` ${line}`).join("") +
    notThere.lines +
    (planChanging !== null
      ? ` The lead is changing the Unit plan (${planChanging} is open again there), so ${unit} is taken on the plan as it stands there.`
      : "");
  const noPush = notRecorded === null ? null
    : `${place.repo} takes no push from you (${notRecorded}), so your take of ${unit} is not written there, and someone else could still take it.`;
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

// An early take's row field Early On: each Unit it started on, "; " between
// them, as "<unit>: <repo> <branch> <head>, ..." with each repository it started
// from there (a head not known is left off); a Unit that changed none of the
// take's repositories is its name alone. Read back exactly by earlyOnFrom.
function earlyOnField(earlyOn: NonNullable<UnitClaimPayload["early_on"]>): string {
  return earlyOn.map((dep) => dep.repos.length === 0 ? dep.unit
    : `${dep.unit}: ${dep.repos.map((repo) => [repo.repo, repo.branch, repo.head].filter(Boolean).join(" ")).join(", ")}`).join("; ");
}

function earlyOnFrom(field: string | null): UnitClaimPayload["early_on"] {
  if (!field || field.trim() === "") return undefined;
  return field.split("; ").map((part) => {
    const at = part.indexOf(": ");
    if (at === -1) return { unit: part.trim(), repos: [] };
    return {
      unit: part.slice(0, at).trim(),
      repos: part.slice(at + 2).split(", ").map((entry) => {
        const [repo = "", branch = "", head = ""] = entry.trim().split(" ");
        return { repo, branch, head };
      }),
    };
  });
}

// The Units a build started early on, by its own take row (read in any clone
// of the workspace it was committed in), else, for a build taken before the
// row carried them, by its record.
export function buildEarlyOn(projectDir: string, build: UnitBuild, record?: UnitClaimView | null): NonNullable<UnitClaimPayload["early_on"]> {
  const here = findUnitBuild(projectDir, build.homeWork, build.unit);
  const row = here === null ? undefined
    : readAuditShardEvents(projectDir, here.dirName, here.space).findLast((entry) => entry.event === "UNIT_TAKEN_IN");
  const field = row === undefined ? null : auditBlockField(row.block, "Early On");
  return earlyOnFrom(field) ?? record?.payload.early_on ?? [];
}

// The generation a take writes: one more over a take the lead opened again
// (its view reads released while the lead's word applies), a released claim's
// own, else the next.
function takeGeneration(current: UnitClaimView | null): number {
  if (current?.payload.open_again !== undefined) return current.generation + 1;
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
  // The author's: the commit that made the take, by its author's email.
  return localGit(projectDir, ["log", "-1", "--format=%ae", takeCommit(projectDir, oid, payload)]).stdout.trim() === myEmail;
}

// The commit that made a take: the oldest of the claim's own history with this
// taker, and with `sameGeneration` this take's generation too, so the same
// person's take again after the lead opened it starts anew.
function takeCommit(projectDir: string, oid: string, payload: UnitClaimPayload, sameGeneration = false): string {
  let at = oid;
  let taking = payload;
  for (let steps = 0; taking.predecessor_oid !== null && steps < 200; steps++) {
    const before = payloadAt(projectDir, taking.predecessor_oid);
    if (before === null || before.taken_by !== taking.taken_by || (sameGeneration && before.generation !== taking.generation)) break;
    at = taking.predecessor_oid;
    taking = before;
  }
  return at;
}

// The day a take was made ("14 Nov"), its commit's author date, so the board
// shows a take gone quiet; null where that commit cannot be read here.
export function takeDayOf(projectDir: string, claim: UnitClaimView): string | null {
  return planLastChange(projectDir, takeCommit(projectDir, claim.oid, claim.payload, true))?.day ?? null;
}

// The lead's own takes at the lead's work (Home Location, not a Unit's
// build): a Unit the lead's project builds (asked here with `assign --here`,
// the walking skeleton, one its walk started) has a record like any builder's,
// whose take is this person's for the work's own space. The lead's walk builds
// it; it is no team's.
export function leadsOwnClaims(projectDir: string, stateContent: string, claims: ReadonlyMap<string, UnitClaimView>): Set<string> {
  if (homeLocation(stateContent) === null || unitBuildOf(stateContent) !== null) return new Set();
  let builds: Set<string>;
  try {
    builds = unitsLeadsProjectBuilds(readAuditShardEvents(projectDir), keptPlan(projectDir, activeIdentity(projectDir).intentId8)?.plan.skeleton ?? null);
  } catch {
    return new Set();
  }
  const space = activeSpace(projectDir);
  return new Set([...claims].filter(([unit, claim]) =>
    builds.has(unit) && claim.status === "claimed" && claim.owner === space && claimIsMine(projectDir, claim)).map(([unit]) => unit));
}

// The Units the lead's project builds in its own walk: asked here, the plan's
// walking skeleton, and one its walk started. A take of this person's that made
// a build of its own is that build's, never the walk's.
function unitsLeadsProjectBuilds(rows: readonly AuditShardEvent[], skeleton: string | null): Set<string> {
  const builds = new Set([...unitsAskedHere(rows), ...unitsStartedAtLeadsProject(rows)]);
  if (skeleton !== null) builds.add(skeleton);
  return builds;
}

// Whether the lead's work went to teams by a teammate's take of solo work: a
// claim on it, other than the lead's own build-here claims (`own`), was taken
// from the lead's commit while the work was still solo. The lead's walk then
// carries on with the rest, as its switch says.
const SOLO_AT_OID = new Map<string, boolean>();
export function takenFromSoloWork(projectDir: string, claims: ReadonlyMap<string, UnitClaimView>, own: ReadonlySet<string>): boolean {
  return [...claims.values()].some((claim) => !own.has(claim.unit) && takenWhileSolo(projectDir, claim));
}

// A claim taken from the lead's commit while the work was still solo.
function takenWhileSolo(projectDir: string, claim: UnitClaimView): boolean {
  const relative = relativeRecordDir(projectDir);
  if (!relative) return false;
  const key = `${claim.payload.base_oid}:${relative}`;
  if (!SOLO_AT_OID.has(key)) {
    const shown = localGit(projectDir, ["show", `${claim.payload.base_oid}:${relative}/aidlc-state.md`, "--"]);
    SOLO_AT_OID.set(key, shown.ok && !isTeamUnitOwnership(shown.stdout));
  }
  return SOLO_AT_OID.get(key) === true;
}

// A build's claim at the lead's project as this workspace last fetched it.
export function buildClaimHere(projectDir: string, built: { space: string; dirName: string }): UnitClaimView | null {
  try {
    const build = unitBuildOf(readStateFile(projectDir, built.dirName, built.space));
    if (build === null) return null;
    const homeSpace = buildHomeSpace(projectDir, build);
    return cachedClaimsForIdentity(projectDir, { space: homeSpace, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false)
      .get(build.unit) ?? null;
  } catch {
    return null;
  }
}

type TakeStanding =
  | { state: "recorded" }
  | { state: "pending"; current: UnitClaimView | null; team: string; baseOid: string; dirName: string; space: string; earlyOn?: UnitClaimPayload["early_on"] }
  | { state: "aside"; line: string };

function takeStanding(projectDir: string, build: UnitBuild): TakeStanding {
  const here = findUnitBuild(projectDir, build.homeWork, build.unit);
  if (here === null) return { state: "recorded" };
  const row = readAuditShardEvents(projectDir, here.dirName, here.space).findLast((entry) => entry.event === "UNIT_TAKEN_IN");
  const own = knownAuditShardName(projectDir);
  if (row === undefined || own === null || basename(row.shard) !== own) return { state: "recorded" };
  let current: UnitClaimView | null;
  let repo: string;
  let planRepo: string;
  try {
    const home = buildsHome(projectDir, build);
    const place = recordPlaceOf(projectDir, home, build.unit);
    repo = place.repo;
    planRepo = planOfWork(projectDir, home.id8, home.location)?.plan_repo.name ?? repo;
    current = recordCopied(projectDir, place, recordWork(home), build.unit);
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
  // Only a Unit's builder writes its record, so a take of someone else's at
  // its tip is the record's take now, even over this build's own once there.
  const theirs = current?.status === "claimed" && current.payload.taken_by !== undefined &&
    !(current.generation === attempt && takeIsBy(projectDir, current.oid, current.payload, me, myEmail));
  // The record's own history, back from what was read: this take there once is
  // recorded, whatever happened to the Unit since (takeIsBy).
  let oid = theirs ? null : current?.oid ?? null;
  for (let steps = 0; oid !== null && steps < 200; steps++) {
    const payload = payloadAt(projectDir, oid);
    if (payload === null) break;
    if (payload.generation === attempt && takeIsBy(projectDir, oid, payload, me, myEmail)) return { state: "recorded" };
    oid = payload.predecessor_oid;
  }
  const team = auditBlockField(row.block, "Team") ?? "";
  const unit = build.unit;
  if (current?.status === "claimed" && current.payload.taken_by !== undefined) {
    const by = current.payload.taken_by;
    const at = git(projectDir, ["log", "-1", "--format=%as", current.oid]).stdout.trim();
    const on = at ? ` on ${at}` : "";
    const after = "Your build is still here: agree with " + by + " who carries it on, or give yours back.";
    // This build's own take under the tip: the lead opened it again, and a take after that is on top now.
    let under = current.payload.predecessor_oid;
    for (let steps = 0; under !== null && steps < 200; steps++) {
      const payload = payloadAt(projectDir, under);
      if (payload === null) break;
      if (payload.generation === attempt && takeIsBy(projectDir, under, payload, me, myEmail)) {
        return { state: "aside", line: `${unit} was taken by ${by}${on} after the lead opened it again, so its record in ${repo} has their take now, not yours. ${after}` };
      }
      under = payload.predecessor_oid;
    }
    return {
      state: "aside",
      line: `${unit} was taken by ${by}${on}, written on its record in ${repo} before your take could be, so the record has theirs, not yours. ${after}`,
    };
  }
  if (current?.payload.done === true) {
    return {
      state: "aside",
      line: `${unit} is done on the plan in ${planRepo} now, and your take of it was never written on its record in ${repo}. ` +
        "Your build is still here: agree with the lead who carries it on, or give yours back.",
    };
  }
  return {
    state: "pending", current, team, baseOid: auditBlockField(row.block, "Home Commit") ?? "", dirName: here.dirName, space: here.space,
    earlyOn: earlyOnFrom(auditBlockField(row.block, "Early On")),
  };
}

// The gate rhythm a take read at its commit: the plan's, or the lead's record's.
function takeRhythmAt(projectDir: string, home: HomeWork, oid: string, record: string): UnitClaimPayload["gate_rhythm"] {
  if (home.leadCopy !== true) return readUnitGateRhythm(textAt(projectDir, oid, record) ?? "");
  const read = planAtCopy(projectDir, copyOf(home.location, planRecordRef(home.id8)), { commit: oid });
  return read.kind === "read" && read.plan.settings[UNIT_GATE_RHYTHM_FIELD] === "unit-end" ? "unit-end" : "per-stage";
}

// A take this checkout made that the lead's project did not record then, put
// on its claim now with the same compare-and-swap, under quiet git. At a look
// nobody typed (`typed` false) it is not tried where commits are signed, which
// may ask for a passphrase. The claim's attempt is the build's from then on.
// Ok, or git's refusal (none for a race lost), and nothing is said either way.
function recordTakeHere(projectDir: string, build: UnitBuild, home: HomeWork, standing: Extract<TakeStanding, { state: "pending" }>, typed: boolean): { ok: boolean; refused?: string; byRule?: true } {
  if (!typed && git(projectDir, ["config", "--type=bool", "commit.gpgsign"]).stdout.trim() === "true") return { ok: false };
  try {
    return quietly(() => {
      const ref = claimRef(home.id8, build.unit);
      const { current } = standing;
      const generation = takeGeneration(current);
      const record = `${home.recordPrefix}/aidlc-state.md`;
      const remote = home.target !== null && !isGitAddress(home.target) ? home.target : null;
      const integrationRef = home.leadCopy === true ? copyOf(home.location, planRecordRef(home.id8))
        : remote !== null ? `refs/remotes/${remote}/${affirmedIntegrationBranch(projectDir, home.space)?.branch ?? integrationBranch(projectDir, remote)}`
        : `refs/heads/${affirmedIntegrationBranch(projectDir, home.space)?.branch ?? integrationBranch(projectDir, null)}`;
      const payload = takenClaimPayload(current, {
        team: standing.team, home, unit: build.unit, ref, generation,
        me: git(projectDir, ["config", "user.name"]).stdout.trim() || "a teammate",
        baseOid: standing.baseOid, integrationRef, gateRhythm: takeRhythmAt(projectDir, home, standing.baseOid, record),
        earlyOn: standing.earlyOn,
      });
      const pushed = writeUnitRecord(projectDir, recordPlaceOf(projectDir, home, build.unit), ref,
        createRecordCommit(projectDir, current?.oid ?? null, payload, standing.earlyOn ? "taken early" : "taken", {}, { take: true }), current?.oid ?? null);
      if (!pushed.ok) return "lost" in pushed ? { ok: false } : { ok: false, refused: pushed.refused, ...(pushed.byRule ? { byRule: true as const } : {}) };
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

// Where the take a build's result goes on stands, for the offer to send that
// result again: "aside" (takeAside); "waits" when the take is not on its record
// yet, so the result has nothing to go on until a look or a push records the
// take (recordTakeHere); else null.
export function resultTakeHold(projectDir: string, stateContent: string): "aside" | "waits" | null {
  const build = unitBuildOf(stateContent);
  if (build === null) return null;
  try {
    const standing = takeStanding(projectDir, build).state;
    if (standing === "aside") return "aside";
    return standing === "pending" ? "waits" : null;
  } catch {
    return null;
  }
}

// The offer to send a Unit's result again (unitPushAsk puts it): one text, so a
// push a rule of its record's repository refused counts it as put in its chat.
export function resendQuestion(unit: string, repo: string): string {
  return `${unit} is pushed, but ${repo} did not take its result just now. Do you want me to send it again?`;
}

// The build's end while its result waits on its record's repository: said once
// per chat (unitPushAsk), never in the chat whose push just said why.
export function resultWaitsLine(unit: string, repo: string): string {
  return `${repo} has not taken the result of ${unit} yet; ask me to send it again once its owner lets your pushes through.`;
}

// The push's line when a rule of the record's repository's host refused the
// result (refusedByHostRule): the host's words, and what to ask its owner for.
function resultRefusedByRuleLine(unit: string, repo: string, refused: string): string {
  return `${repo} did not take the result of ${unit}: ${refused}. A rule on its host refuses it: ask whoever owns ${repo} to let ` +
    "your pushes to refs/aidlc/claims/ through, then ask me to send it again.";
}

// The repository a build's record is in, by its name in the plan.
export function buildRecordRepo(projectDir: string, build: UnitBuild): string {
  return recordPlaceOf(projectDir, buildsHome(projectDir, build), build.unit).repo;
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
// A look nobody typed is one fetch with no first read, so it gives up at the
// read limit: an offline step waits no longer than that, and a look with
// nothing new took 0.3 to 0.5 s on GitHub.com. The person's own take and the
// address they said read with git's limits.
const QUIET_LOOK_CEILING_MS = QUIET_READ_TIMEOUT_MS;
let quiet = false;
let quietLimitMs: number | null = null;

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
// lists each repository that could not be read: the last look stands for it.
const CLAIMS_FETCHED_FILE = "claims-fetched.json";

// The homes whose claims an earlier step of this command fetched (refreshHomeClaims).
const homesFetchedThisCommand = new Set<string>();

// A repository a look could not read: its name, its address, git's own words.
export interface RecordRepoUnread {
  repo: string;
  address: string;
  said: string;
}

export function refreshHomeClaims(
  projectDir: string,
  options: {
    home?: { id8: string; location?: string; solo?: boolean; plan?: PlanJson; space?: string };
    sessionId?: string; now?: boolean; sincePerson?: boolean;
  } = {},
): {
  fetched: boolean; unreached: RecordRepoUnread[]; planGone?: true; refused?: string; lookedThisCommand?: true;
  // The plan moved: read where it went now (`followed`), or not followed, so none of its Units is offered.
  followed?: string; planMoved?: true;
} {
  const pd = resolveProjectDir(projectDir);
  const id8 = options.home?.id8 ?? activeIdentity(pd).intentId8;
  // A home named is the build-out's; the work here, by its recorded flow:
  // main's flow reads its claim branches through this workspace's remote; the
  // build-out each record where the plan says it is.
  const onBranches = options.home === undefined && claimsOnBranches(stateHere(pd));
  const target = onBranches ? repositoryRemote(pd) : null;
  const places = onBranches ? [] : recordPlacesOfWork(pd, id8, options.home);
  if (onBranches ? target === null : places.length === 0) return { fetched: false, unreached: [] };
  const home = `${pd}\0${onBranches ? target : places.map((place) => place.address).join("\0")}\0${id8}`;
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
  // Already looked in this chat: said with whether this command's own earlier step looked, so what reads the
  // look still runs in the step that made it.
  if (!options.now && !spoke && !again && last?.chat === chat) {
    return { fetched: false, unreached: [], ...(homesFetchedThisCommand.has(home) ? { lookedThisCommand: true as const } : {}) };
  }
  const at = isoTimestamp();
  const unreached: RecordRepoUnread[] = [];
  // A repository that answered, and this repository's own .git refused the
  // write (Codex's sandbox keeps it read-only): not a repository that is down.
  // The first time in a chat the step stops with its way on, which an agent in
  // that sandbox takes with the write access the session grants (AI-DLC's
  // shipped rules allow its engine commands), so the news is read rather than
  // missed; after that the step goes on and says it plainly, never a loop.
  let refused: string | null = null;
  let refusedFrom: string | undefined;
  if (onBranches && target !== null) {
    const into = claimCopies(target, id8).slice(0, -1);
    const fetched = quietFetch(pd, ["--no-tags", "--no-filter", "-q", target, `+${claimsOnRemote(true, id8)}*:${into}/*`]);
    refused = fetched.ok ? null : localGitWriteRefused(fetched.stderr);
    if (!fetched.ok && refused === null) {
      unreached.push({ repo: target, address: target, said: maskUserinfo(fetched.stderr.trim().split(/\r?\n/)[0]?.trim() ?? "") });
    }
  }
  // A build's look reads the plan where it is shared too, whether or not every
  // record repository answered: its copy holds the Units, the lead's rules a
  // build follows and the lead's word on its Unit, whichever step looked first
  // in the chat, and its look counts as theirs does. Solo work has no plan.
  // The lead's own look reads it as well. A look with no copy of the plan yet
  // (another computer of the lead's, a fresh clone of a shared workspace, a
  // builder's second computer) reads it first, so the records are read where
  // the plan names them.
  const leadState = options.home === undefined && !onBranches ? stateHere(pd) ?? "" : "";
  const planAddress = options.home !== undefined
    ? options.home.solo !== true ? options.home.location : undefined
    : isTeamUnitOwnership(leadState) && unitBuildOf(leadState) === null ? homeLocation(leadState) ?? undefined : undefined;
  const planBefore = planOfWork(pd, id8, planAddress);
  let recordPlaces = places;
  let planFirst = false;
  let planMoved = false;
  // A plan the lead moved: this look reads it where it went instead.
  const moved = (from: string): ReturnType<typeof refreshHomeClaims> | null => {
    const met = followMoved(pd, id8, from, false);
    if (met === null || met.follow.kind === "newer") return null;
    if (met.follow.kind !== "followed" || options.home === undefined) {
      planMoved = met.follow.kind !== "followed";
      return null;
    }
    return { ...refreshHomeClaims(pd, { ...options, home: { ...options.home, location: met.follow.address, plan: undefined }, now: true }), followed: met.follow.address };
  };
  if (refused === null && planBefore === null && planAddress !== undefined && isGitAddress(planAddress)) {
    planFirst = true;
    const plan = lookAt(pd, planAddress, [planRecordRef(id8)]);
    const there = plan.ok ? moved(planAddress) : null;
    if (there !== null) return there;
    if (plan.ok) recordPlaces = recordPlacesOfWork(pd, id8, options.home);
    else if ("refused" in plan) {
      refused = plan.refused;
      refusedFrom = repoNameOf(planAddress);
    } else unreached.push({ repo: repoNameOf(planAddress), address: planAddress, said: plan.firstLine ?? "it did not answer in time" });
  }
  for (const place of refused === null ? recordPlaces : []) {
    if (unreached.some((entry) => sameGitAddress(entry.address, place.address))) continue;
    const looked = lookAt(pd, place.address, [claimsOnRemote(false, id8)]);
    if (looked.ok) continue;
    if ("refused" in looked) {
      refused = looked.refused;
      refusedFrom = place.repo;
      break;
    } else {
      unreached.push({ repo: place.repo, address: place.address, said: looked.firstLine ?? "it did not answer in time" });
    }
  }
  let planGone = false;
  if (refused === null && planAddress !== undefined && isGitAddress(planAddress) && !planFirst) {
    const plan = lookAt(pd, planAddress, [planRecordRef(id8)]);
    if (plan.ok) {
      // A plan gone from its repository (its copy here kept): the chat is not
      // noted, so each step looks again, quietly, until the plan is back, and a
      // plan that is gone is never offered from its copy.
      const seen = plan.refs[planRecordRef(id8)];
      planGone = seen !== undefined && seen.now === null && seen.was !== null;
      const there = moved(planAddress);
      if (there !== null) return there;
    } else if ("refused" in plan) {
      refused = plan.refused;
      refusedFrom = repoNameOf(planAddress);
    } else if (!unreached.some((entry) => sameGitAddress(entry.address, planAddress))) {
      unreached.push({ repo: repoNameOf(planAddress), address: planAddress, said: plan.firstLine ?? "it did not answer in time" });
    }
  }
  if (refused === null) sayOwnBuildsMerged(pd, id8, planBefore, planAddress, options.home);
  const ok = refused === null && unreached.length === 0;
  if (ok) homesFetchedThisCommand.add(home);
  const stopped = refused !== null && last?.chat === chat && last.refused === true;
  if (!planGone) {
    try {
      mkdirSync(dirname(mark), { recursive: true });
      writeFileAtomic(mark, `${JSON.stringify({
        ...chats, [id8]: { chat, at, reached: ok, ...(refused !== null ? { refused: true, ...(stopped ? { again: true } : {}) } : {}) },
      })}\n`);
    } catch {
      // Unnoted, the next step fetches again.
    }
  }
  if (refused !== null && !stopped) throw new GitWriteRefused(refused, refusedFrom);
  if (refused !== null) return { fetched: false, unreached: [], refused };
  return { fetched: ok, unreached, ...(planGone ? { planGone: true as const } : {}), ...(planMoved ? { planMoved: true as const } : {}) };
}

// The plan as this build's copy has it now, when it was shared again over the
// history the build took from (`taken`, its take's Home Commit): a new history
// (`taken` is not in it, or no longer here), or written over a tip that was not
// a plan (a commit since `taken` reads as none). Null for a plan that moved on
// top of what was taken, or that does not read now. The commits since the take
// are read in one git call, the last 200 of them.
function planSharedOver(pd: string, copy: string, taken: string): PlanJson | null {
  const tip = localGit(pd, ["rev-parse", "--verify", "--quiet", copy]).stdout.trim();
  if (tip === "" || tip === taken) return null;
  const now = planAtCopy(pd, copy, { commit: tip });
  if (now.kind !== "read") return null;
  if (!localGit(pd, ["merge-base", "--is-ancestor", taken, tip]).ok) return now.plan;
  const since = localGit(pd, ["rev-list", "--first-parent", "--max-count=200", `${taken}..${tip}`]).stdout.split(/\r?\n/)
    .filter((commit) => commit !== "" && commit !== tip);
  return plansAtCommits(pd, copy, since).some((read) => read.kind !== "read") ? now.plan : null;
}

// plan.json at each of `commits`, read as planAtCopy reads it, in one git call.
function plansAtCommits(pd: string, copy: string, commits: readonly string[]): Array<ReturnType<typeof planAtCopy>> {
  if (commits.length === 0) return [];
  const out = gitBytes(pd, ["cat-file", "--batch"], { GIT_NO_LAZY_FETCH: "1" }, commits.map((commit) => `${commit}:plan.json\n`).join("")).stdout;
  const reads: Array<ReturnType<typeof planAtCopy>> = [];
  let at = 0;
  for (const commit of commits) {
    const end = out.indexOf(0x0a, at);
    if (end < 0) break;
    const header = out.subarray(at, end).toString("utf-8").split(" ");
    at = end + 1;
    if (header[1] !== "blob") {
      reads.push(planReadOf(copy, commit, null));
      continue;
    }
    const size = Number(header[2]);
    reads.push(planReadOf(copy, commit, out.subarray(at, at + size).toString("utf-8")));
    at += size + 1;
  }
  return reads;
}

const planSharedOverMark = (unit: string): string => `unit-plan-shared-over-${unit}.json`;

// The line for a build whose plan was shared again over its history since its
// take, said once for the build (its engine ask mark); null otherwise. Read
// from the take's Home Commit against the copy as it is now, whichever look
// moved the copy.
export function planSharedOverLine(projectDir: string, stateContent: string): string | null {
  const build = unitBuildOf(stateContent);
  if (build === null || !takenFromPlan(projectDir, build) || engineAskMark(projectDir, planSharedOverMark(build.unit)) !== null) return null;
  const taken = auditBlockField(readAuditShardEvents(projectDir).findLast((row) => row.event === "UNIT_TAKEN_IN")?.block ?? "", "Home Commit");
  if (!taken) return null;
  const copy = copyOf(build.homeLocation, planRecordRef(idSuffix(build.homeWork)));
  const over = planSharedOver(projectDir, copy, taken);
  if (over === null) return null;
  noteEngineAskMark(projectDir, planSharedOverMark(build.unit));
  return planSharedOverWords(over, build.unit);
}

function planSharedOverWords(plan: PlanJson, unit: string): string {
  return `The plan of ${plan.work.label || idSuffix(plan.work.id)} in ${plan.plan_repo.name} was shared again since you took ${unit}; ` +
    "what you took stays as it was.";
}

// The repositories that hold a work's records, each once: the ones the plan
// names (units[].record); for the solo second person, or work with no plan
// here, the place recordPlaceOf gives.
function recordPlacesOfWork(
  projectDir: string,
  id8: string,
  home?: { location?: string; solo?: boolean; plan?: PlanJson },
): RecordPlace[] {
  const plan = home?.solo === true ? null : home?.plan ?? planOfWork(projectDir, id8, home?.location);
  if (plan === null) {
    const address = home?.location ?? workspaceHomeLocation(projectDir);
    return address === null || address === "local" ? [] : [{ repo: repoNameOf(address), address }];
  }
  const seen = new Map<string, RecordPlace>();
  for (const unit of plan.units) {
    const place = recordPlaceIn(plan, unit.name, home?.location);
    if (!seen.has(gitAddressKey(place.address))) seen.set(gitAddressKey(place.address), place);
  }
  return [...seen.values()];
}

// A build of the person's own here, in this checkout or on another branch of
// this clone (its record checked in for a pull request, the checkout back on
// main), that the plan this look read says done and the copy before it did
// not: said once, with the step that follows. A look that moved nothing says
// nothing; with the build in this checkout, status's Yours line still shows it.
function sayOwnBuildsMerged(pd: string, id8: string, before: PlanJson | null, at: string | undefined, home?: { space?: string }): void {
  const after = planOfWork(pd, id8, at);
  if (after === null) return;
  for (const entry of after.units) {
    if ((entry.word as UnitWord).done !== true || (before !== null && unitWordIn(before, entry.name).done === true)) continue;
    const ref = claimRecordRef(id8, entry.name);
    const oid = localGit(pd, ["rev-parse", "--verify", "--quiet", copyOf(recordPlaceIn(after, entry.name).address, ref)]).stdout.trim();
    const view = oid === "" ? null : recordView(pd, ref, oid, { uuid: after.work.id, space: home?.space ?? "" });
    if (view?.payload.done !== true) continue;
    if (!takeIsBy(pd, oid, view.payload, gitUserName(pd), git(pd, ["config", "user.email"]).stdout.trim())) continue;
    if (findUnitBuild(pd, after.work.id, entry.name) === null && !branchWithBuild(pd, after.work.id, entry.name)) continue;
    saidWithNextStep(pd, `Your ${entry.name} is merged.`);
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
  // `from`: the repository a look read, where it is known.
  constructor(gitLine: string, from?: string) {
    super(`${from === undefined ? "What was read" : `What was read from ${from}`} reached this workspace, but its .git cannot be written in this session ` +
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
    (/read-only file system|permission denied|operation not permitted/i.test(entry) &&
      /cannot open|cannot lock ref|unable to create|unable to write|could not write|failed to write|cannot update/i.test(entry)) ||
    // A fetch that writes no FETCH_HEAD meets the object store first.
    /insufficient permission for adding an object to repository database/i.test(entry));
  return line === undefined ? null : line.trim();
}

// The claims of a home's work listed in this workspace, fetched as
// refreshHomeClaims decides; nothing for work no team builds.
export function refreshListedHome(
  projectDir: string,
  dirName: string,
  space: string,
  options: { sessionId?: string; now?: boolean },
): { fetched: boolean; unreached: RecordRepoUnread[] } {
  try {
    return refreshHomeClaims(projectDir, { home: findHomeWork(projectDir, dirName, space), ...options });
  } catch (e) {
    if (e instanceof GitWriteRefused) throw e;
    return { fetched: false, unreached: [] };
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

// Whether a repo holds changes of the person's, beyond the Unit's and, on the
// workspace's own repository, beyond AI-DLC's record of the build: the push
// commits it next (sendBuildRecord), and an early take has just written it.
function ownChanges(pd: string, planned: ReadonlyArray<{ repo: string; dir: string }>): boolean {
  return planned.some(({ repo, dir }) => {
    const record = repo === "." ? ["--", ...buildRecordPaths(pd).map((path) => `:(exclude)${path}`)] : [];
    return git(dir, ["status", "--porcelain", ...record]).stdout.trim() !== "";
  });
}

function buildsHome(projectDir: string, build: UnitBuild): HomeWork {
  const here = leadWorkHere(projectDir, build.homeWork);
  if (here !== null) {
    // The home is where the take was made: a build taken from the plan at an
    // address the lead's work here does not record (a clone made before the
    // lead's share reached it) reads that plan, so its writes go where its take went.
    let found: HomeWork | null = null;
    try {
      found = findHomeWork(projectDir, here.dirName, here.space);
    } catch (error) {
      if (!isGitAddress(build.homeLocation)) throw error;
    }
    if (found !== null && (!isGitAddress(build.homeLocation) || sameGitAddress(found.location, build.homeLocation))) return found;
    return planHomeAt(projectDir, build);
  }
  const lead = planHomeOfBuild(projectDir, build);
  if (lead === null) fail(`${build.unit}'s build names no plan to read.`);
  return lead;
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

// Where a Unit's branch on the workspace's own repository starts: the branch
// its take read the plan from (fetchHomeIntegration, recorded on the claim),
// fetched again when it is a remote's branch (a lead read by address keeps the
// take's copy), so the branch, its base and the lead's merge check read one
// branch, and a fork's clone starts from the lead's. Null when it is not here.
function takeIntegrationRef(dir: string, claim: UnitClaimView | null): string | null {
  const ref = claim?.payload.integration_ref ?? "";
  // A take from the plan read no branch of this repository (planBranchStart).
  if (!/^refs\/(?:remotes|heads)\//.test(ref)) return null;
  const tracking = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(ref);
  if (tracking !== null) git(dir, ["fetch", "-q", tracking[1], tracking[2]]);
  return ref !== "" && git(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok ? ref : null;
}

// Where a Unit's branch on the workspace's own repository starts for a take
// from the plan: the branch the plan names for this repository, fetched. Null
// when the plan names none here or it cannot be read.
function planBranchStart(pd: string, build: UnitBuild): string | null {
  const own = workspaceHomeLocation(pd);
  const remote = repositoryRemote(pd);
  if (!isGitAddress(build.homeLocation) || own === null || own === "local" || remote === null) return null;
  const copy = copyOf(build.homeLocation, planRecordRef(idSuffix(build.homeWork)));
  const read = planAtCopy(pd, copy, { commit: planCommitOf(pd, copy) });
  const branch = read.kind === "read" ? read.plan.repos.find((repo) => repo.address !== null && sameGitAddress(repo.address, own))?.branch : null;
  if (!branch) return null;
  git(pd, ["fetch", "-q", remote, branch]);
  const ref = `refs/remotes/${remote}/${branch}`;
  return git(pd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).ok ? ref : null;
}

// The branch work merges into on the workspace's own repository, as the take
// and the share read it (the home's Way of Working line), in the home's space,
// a build's too; null where no layer names one, and the remote's own answers.
function homeIntegrationBranch(pd: string): string | null {
  try {
    const build = unitBuildOf(readStateFile(pd));
    const space = build === null ? undefined : buildHomeSpace(pd, build);
    return affirmedIntegrationBranch(pd, space)?.branch ?? null;
  } catch {
    return null;
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

// The branch a Unit's branch in a code repository starts from and merges
// into: its remote's main, read through the repository's own remote when the
// push goes to a fork.
function unitBranchInto(dir: string, remote: string): string {
  return repoIntegration(dir, startRemoteOf(dir, remote));
}

// The Unit's own files (`paths`) that `into` changed since the Unit's branch
// at `head` left it, where both sides now differ: what its pull request has
// to bring together. Nothing when the branch has `into` already. Local reads
// only: no fetch, so it never stands in for the person's own look at main.
export function mainChangedUnder(dir: string, head: string, into: string, paths: readonly string[]): string[] {
  if (paths.length === 0 || git(dir, ["merge-base", "--is-ancestor", into, head]).ok) return [];
  const base = git(dir, ["merge-base", head, into]).stdout.trim();
  if (base === "") return [];
  const blob = (at: string, path: string): string => git(dir, ["rev-parse", "--verify", "--quiet", `${at}:${path}`]).stdout.trim();
  return git(dir, ["diff", "-z", "--name-only", "--no-renames", base, into, "--", ...paths]).stdout.split("\0").filter(Boolean)
    .filter((path) => blob(head, path) !== blob(base, path) && blob(head, path) !== blob(into, path));
}

// The push that made a Unit's branch from where the person was, while the
// branch it merges into changed the Unit's own files, keeps this for the head
// it pushed: the step after it offers to bring that branch in, once.
export const mainMovedMark = (unit: string, head: string): string => `unit-main-moved-${unit}-${head.slice(0, 12)}`;

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

// AI-DLC's record of the build this workspace holds, as the Unit's pull
// request carries it: the build's own folder, and its space's own folders
// outside its works while git has none of that space yet (a team's new space).
// Never another work's folder, the lead's record, or a path git ignores.
function buildRecordPaths(pd: string): string[] {
  const own = relative(pd, activeRecordDir(pd)).split(sep).join("/");
  const space = own.split("/").slice(0, 3).join("/");
  if (git(pd, ["ls-files", "--", space]).stdout.trim() !== "") return [own];
  const works = own.split("/").slice(0, 4).join("/");
  const folders = readdirSync(join(pd, ...space.split("/")), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => `${space}/${entry.name}`).filter((path) => path !== works);
  const ignored = untrackedIgnored(pd, folders);
  return [own, ...folders.filter((path) => !ignored.includes(path))];
}

// The record commit's message: the Unit's own commit message with its first
// line marked as the record, so a rule the code commit meets (a ticket key, a
// sign-off) the record meets too; AI-DLC's own when the person gave none.
function buildRecordMessage(unit: string, given: string | null): string {
  if (given === null) return `${unit}: AI-DLC's record`;
  const [subject, ...rest] = given.replace(/\r\n/g, "\n").split("\n");
  return [`${subject} (AI-DLC's record)`, ...rest].join("\n");
}

// After the Unit's code is pushed on the workspace's own repository, AI-DLC's
// record of the build goes with it on the same branch, as a second commit made
// with the person's own git and pushed the same plain way. A commit or push
// that does not go leaves the branch where the code's push left it, and the
// record the person's to check in. Its commit never joins the Unit's result
// (resultAtTip leaves the record out). The line to say; nothing new to send
// says nothing.
function sendBuildRecord(pd: string, remote: string, branch: string, unit: string, given: string | null): { line: string | null; went: boolean } {
  const notSent = (said: string) => ({ line: `AI-DLC's record of ${unit} did not go with it: ${gitSaid(said).replace(/([^.!?])$/, "$1.")}`, went: false });
  const paths = buildRecordPaths(pd);
  const before = git(pd, ["rev-parse", "HEAD"]).stdout.trim();
  try {
    commitUnitPaths(pd, paths, {}, unit, "", "the repo", null, { message: buildRecordMessage(unit, given), refused: (said) => fail(said) });
  } catch (error) {
    return notSent(errorMessage(error));
  }
  const head = git(pd, ["rev-parse", "HEAD"]).stdout.trim();
  if (head === before) return { line: null, went: false };
  const pushed = git(pd, ["push", remote, branch]);
  if (pushed.ok) return { line: `AI-DLC's record of ${unit} went with it, in a commit of its own.`, went: true };
  git(pd, ["update-ref", `refs/heads/${branch}`, before, head]);
  git(pd, ["reset", "-q", "--", ...paths]);
  return notSent(pushRefusal(pushed.stderr));
}

function pushUnit(args: string[], projectDir?: string): void {
  const { bareFlags, flags } = parseArgs(args);
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  const build = unitBuildOf(state);
  if (build === null) fail("push is for a Unit's build; this work is not one.");
  const unit = build.unit;
  const mergeMain = bareFlags.has("merge-main") || flags["merge-main"] !== undefined;
  if (mergeMain || bareFlags.has("undo-merge") || flags["undo-merge"] !== undefined) {
    mergeMainIn(pd, args, unit, unitBranchOf(state, unit), !mergeMain);
    return;
  }
  // The branch the person named (their team's own rule), kept for every
  // later push; else the one named before, else the Unit's name.
  if (bareFlags.has("branch")) fail(`push --branch needs the branch name the person gave. usage: ${unitUsage("push")}`);
  const before = unitBranchOf(state, unit);
  const branch = flags.branch?.trim() || before;
  const finishMerge = bareFlags.has("finish-merge") || flags["finish-merge"] !== undefined;
  const replace = bareFlags.has("replace") || flags.replace !== undefined;
  if (flags.branch !== undefined) {
    const checked = git(pd, ["check-ref-format", "--branch", branch]);
    if (!checked.ok) fail(`"${branch}" is not a branch name git takes, so nothing was pushed.${checked.stderr.trim() ? ` Git says: "${gitSaid(checked.stderr)}".` : ""}`);
    withAuditLock(pd, () => writeStateFile(pd, setOrInsertField(readStateFile(pd), "## Runtime State", UNIT_BRANCH_FIELD, branch)));
  }
  if (bareFlags.has("later") || flags.later !== undefined) {
    withAuditLock(pd, () => writeStateFile(pd, setOrInsertField(readStateFile(pd), "## Runtime State", UNIT_PUSH_FIELD, "later")));
    finishBuildRecord(pd);
    console.log(JSON.stringify({ pushed: false, notice: `Nothing is pushed. I'll push ${unit} when you ask.` }));
    return;
  }
  // The commit message the person gave, from the file the agent wrote it to:
  // the Unit's commit takes it whole.
  const given = givenCommitMessage(pd, args, "push");
  // A way on this push names carries the message on.
  const messageFlag = given === null ? "" : ` --commit-message-file ${shellArg(given.file)}`;
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
  // A plan the lead moved is followed before the push reads it, so the take
  // and the result go where the plan is now.
  if (takenFromPlan(pd, build)) {
    lookAt(pd, build.homeLocation, [planRecordRef(idSuffix(build.homeWork))]);
    const met = followMoved(pd, idSuffix(build.homeWork), build.homeLocation, false);
    if (met?.follow.kind === "followed") build.homeLocation = met.follow.address;
  }
  const home = buildsHome(pd, build);
  const ref = claimRef(home.id8, unit);
  const place = recordPlaceOf(pd, home, unit);
  // A take its record's repository did not take then is recorded first, so
  // the result goes onto this build's own take, never onto anyone else's: read
  // against the record as its repository has it now, and the lead's word on it
  // as the plan has it now (an open-again since the take).
  typedRecordRead(pd, place, recordWork(home), unit);
  if (!home.solo && isGitAddress(home.location)) lookAt(pd, home.location, [planRecordRef(home.id8)]);
  let standing = takeStanding(pd, build);
  const recorded = standing.state === "pending" ? recordTakeHere(pd, build, home, standing, true) : null;
  if (recorded?.ok) standing = takeStanding(pd, build);
  const claim = recordCopied(pd, place, recordWork(home), unit);
  const label = homeLabelOf(state, build);
  const dotStart = byRepo.has(".") ? takeIntegrationRef(pd, claim) ?? planBranchStart(pd, build) : null;
  const integrationOf = (repo: string, dir: string, remote: string): string =>
    (repo === "." ? dotStart : null) ?? unitBranchInto(dir, remote);
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
      fail(underWayLine(name, underWay, "nothing was committed or pushed", `push ${unit}`));
    }
    // A redo built on a branch of its own from the newer integration branch is
    // pushed from that branch, never moved back onto the first build's.
    const own = flags.branch === undefined ? unitBuildOwnBranch(dir, branch) : null;
    if (own !== null) {
      fail(`${name} has ${unit}'s build on branch ${own}, which holds commits ${branch} does not, so nothing was switched or ` +
        `pushed. Ask the person whether to push it on ${own}, the branch it was built on; on their yes, run ` +
        `\`${aidlcToolInvocation("unit")} push --branch ${own}${messageFlag}\`.`);
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
  // The code repositories whose Unit branch this run made from where they were.
  const startedHere = new Set<string>();
  const whereNow = (done = false): string =>
    whereNowLine(branch, moved, done && ownChanges(pd, planned) ? "; your other changes are still yours, uncommitted" : "") +
      along.map((line) => ` ${line}`).join("");
  // Each commit this push makes, by repo, as it is made; saved at a refusal
  // too, so the next push question says the last push did not go through.
  const buildRecord = activeRecordDir(pd);
  const mark: PushRefusedMark = { ...(readPushRefused(buildRecord) ?? {}) };
  const saveMark = (): void => writePushRefused(buildRecord, mark);
  const textHash = messageHash(pd, given?.text ?? `${unit}: ${label}`);
  // The repos whose commit did not take the message the person gave, and why.
  const messageKept = { went: [] as string[], notOurs: [] as string[], unknown: [] as string[], hook: [] as Array<{ name: string; words: string }> };
  const keptLines = (only?: string): string[] => {
    const pick = (names: string[]): string[] => names.filter((entry) => only === undefined || entry === only);
    const keeps = (names: string[]): string => `${joinNames(names)} keep${names.length === 1 ? "s" : ""}`;
    const went = pick(messageKept.went);
    const notOurs = pick(messageKept.notOurs);
    const unknown = pick(messageKept.unknown);
    return [
      ...(went.length === 0 ? [] : [`${keeps(went)} ${unit}'s commit as it went before, so your message is not on it there.`]),
      ...(notOurs.length === 0 ? [] : [`${keeps(notOurs)} ${notOurs.length === 1 ? "its" : "their"} last commit as it is, so your ` +
        `message is not on it there: it is not the commit AI-DLC made for ${unit} and could not push.`]),
      ...(unknown.length === 0 ? [] : [`${keeps(unknown)} ${unit}'s commit as it is for now, so your message is not on it there: ` +
        "AI-DLC could not check whether it went."]),
      ...messageKept.hook.filter((entry) => only === undefined || entry.name === only).map((entry) =>
        `${entry.name} keeps ${unit}'s commit as it was, so your message is not on it there: its hook did not take your message (${entry.words}).`),
    ];
  };
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
      const integration = integrationOf(repo, dir, remote);
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
        // allows; the workspace itself from the branch its take read the plan
        // from when nothing of theirs is left behind (every change on their
        // branch is in it already). A tree that does not allow it, and their
        // own commits holding the Unit's files, start where they are.
        if (repo !== ".") git(dir, ["fetch", "-q", start, integration.slice(start.length + 1)]);
        const committedHere = paths.length > 0 && !git(dir, ["diff", "--quiet", integration, "HEAD", "--", ...paths]).ok;
        const leavesNothing = repo !== "." || (dotStart !== null && headInByContent(dir, integration) === true);
        if (leavesNothing && !committedHere) switched = git(dir, ["switch", "-q", make, branch, integration]).ok;
        if (!switched) {
          const tried = git(dir, ["switch", "-q", make, branch]);
          switched = tried.ok;
          said = tried.stderr;
          if (switched && repo !== ".") startedHere.add(repo);
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
      // Their message goes on the commit this push made and could not push,
      // and on nothing else that is there.
      const headBefore = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim();
      const ours = headBefore !== "" && mark[repo]?.commit === headBefore;
      const where = given !== null && ours ? wentNowhere(dir, remote, branch, headBefore) : null;
      const offer = given === null ? undefined : { message: given.text, amend: where === "nowhere", same: ours && mark[repo]?.message === textHash } as
        { message: string; amend: boolean; same: boolean; refused?: string };
      for (const path of commitUnitPaths(dir, paths, takeTree[repo] ?? {}, unit, label, name, listed, undefined, offer)) leftOut.push(`${path} in ${name}`);
      const headAfter = git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim();
      if (headAfter !== headBefore) {
        mark[repo] = { commit: headAfter, message: textHash };
        saveMark();
      } else if (offer !== undefined && !offer.same && !messageOnHead(dir, offer.message)) {
        // Their message is on no commit there: why, by git's own answer.
        const at = where ?? wentNowhere(dir, remote, branch, headBefore);
        if (offer.refused !== undefined) messageKept.hook.push({ name, words: offer.refused });
        else if (at === "went") messageKept.went.push(name);
        else if (at === "unknown") messageKept.unknown.push(name);
        else messageKept.notOurs.push(name);
      }
    } catch (error) {
      saveMark();
      fail(`${errorMessage(error).replace(/([^.!?])$/, "$1.")} Nothing was pushed.${whereNow()}` +
        (error instanceof CommitRefused ? ` ${messageWayOn()}` : ""));
    }
    if (takeTree[repo] !== undefined) writeTakeTree(activeRecordDir(pd), takeTree);
  }
  // What each repo's host said about the branch, for the line; never recorded.
  const hostSaid: Array<{ name: string; words: string }> = [];
  // The repos a replace went in, with the commit their branch was at before.
  const replacedFrom = new Map<string, string>();
  const newBranchWay = (fresh: string): string =>
    `Ask the person whether to push it as a new branch, ${fresh}; on their yes, run \`${aidlcToolInvocation("unit")} push --branch ${fresh}${messageFlag}\`.`;
  // The branch each repository merges into is never replaced: the way on is a new branch.
  const intoNames = (repo: string, dir: string, remote: string): string[] =>
    [...[integrationOf(repo, dir, remote), unitBranchInto(dir, remote)]
      .map((ref) => (ref.startsWith("refs/") ? ref.replace(/^refs\/(?:heads|remotes\/[^/]+)\//, "") : ref.replace(/^[^/]+\//, ""))),
    ...(repo === "." ? [homeIntegrationBranch(pd) ?? ""] : [])].filter(Boolean);
  const intoRefused = (name: string, dir: string, remote: string): never => {
    const free = !git(dir, ["ls-remote", "--exit-code", remote, `refs/heads/${unit}`]).ok;
    return fail(`${unit} was not pushed: it goes on ${branch} in ${name}, the branch ${name} merges into, and AI-DLC never replaces ` +
      `that branch. ${newBranchWay(free ? unit : `${unit}-2`)}${whereNow()}`);
  };
  // With --replace, every repository's branch on its remote is read before any
  // push and leased on what this build last pushed there, so a commit anyone
  // else put there, in any repository, pushes nothing anywhere.
  const leases = new Map<string, string>();
  if (replace) {
    const last = lastPushedHeads(pd, unit, branch);
    for (const { repo, dir, name, remote } of planned) {
      if (intoNames(repo, dir, remote).includes(branch)) intoRefused(name, dir, remote);
      const listed = git(dir, ["ls-remote", remote, `refs/heads/${branch}`]);
      if (!listed.ok) fail(`${branch} on ${remote} in ${name} could not be read: git says "${gitSaid(listed.stderr)}". Nothing was pushed. Say when to try again.${whereNow()}`);
      const tip = listed.stdout.trim().split(/\s+/)[0] ?? "";
      if (tip === "" || tip === git(dir, ["rev-parse", "HEAD"]).stdout.trim()) continue;
      const lease = last.get(repo);
      if (lease !== undefined && tip !== lease) git(dir, ["fetch", "-q", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);
      if (lease !== undefined && (tip === lease || onlyOnLastPush(dir, lease, tip, integrationOf(repo, dir, remote), repo === "."))) {
        leases.set(repo, tip);
        continue;
      }
      fail(`${unit} was not pushed: its branch ${branch} on ${remote} in ${name} is not where this build's last push left it, so it ` +
        `was not replaced, and nothing was pushed. ${newBranchWay(`${branch}-2`)}${whereNow()}`);
    }
  }
  for (const { repo, dir, name, remote, paths } of planned) {
    // The branch's copy on its remote as last fetched: a commit there that
    // AI-DLC did not push and this build is on top of stays among its heads.
    const prior = git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}^{commit}`]).stdout.trim();
    const lease = leases.get(repo);
    const pushed = git(dir, ["push", "-u", ...(lease === undefined ? [] : [`--force-with-lease=refs/heads/${branch}:${lease}`]), remote, branch]);
    if (!pushed.ok && replace) {
      saveMark();
      fail(`The push of ${unit} in ${name} was refused: ${pushRefusal(pushed.stderr)}. Nothing was retried. ${newBranchWay(`${branch}-2`)}${whereNow()}`);
    }
    if (!pushed.ok) {
      // Its branch on the remote holds commits this build is not on top of (a
      // redo built from the newer main after a turn-down, a build moved onto
      // what merged): the way on is the replace of that branch, or a new one.
      const theirs = `refs/remotes/${remote}/${branch}`;
      git(dir, ["fetch", "-q", remote, `${branch}:${theirs}`]);
      const behind = git(dir, ["rev-parse", "--verify", "--quiet", theirs]).ok &&
        !git(dir, ["merge-base", "--is-ancestor", theirs, "HEAD"]).ok;
      saveMark();
      if (behind && intoNames(repo, dir, remote).includes(branch)) intoRefused(name, dir, remote);
      if (behind) {
        const fresh = `${branch}-2`;
        const unitTool = aidlcToolInvocation("unit");
        fail(
          `${unit} was not pushed: its branch ${branch} on ${remote} in ${name} still holds the build pushed before, and ` +
            `this build is not on top of it. Ask the person whether to replace ${branch} there with this build (the build ` +
            "pushed before leaves that branch; a pull request open from it stays the same one), or to push it as a new branch, " +
            `${fresh} (it needs a pull request of its own); run \`${unitTool} push --replace${messageFlag}\` for the replace, or ` +
            `\`${unitTool} push --branch ${fresh}${messageFlag}\` for the new branch.${whereNow()}`,
        );
      }
      // The way on is said only where a message the person gives could change
      // what this host refuses: the commit this push made is the one commit it
      // sends that the remote lacks.
      const tip = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
      const alone = git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).stdout.trim() === "1";
      const wayOn = mark[repo]?.commit === tip && alone ? ` ${messageWayOn()}` : "";
      fail(`The push of ${unit} in ${name} was refused: ${pushRefusal(pushed.stderr)}. Nothing was retried.${whereNow()}` +
        keptLines(name).map((line) => ` ${line}`).join("") + wayOn);
    }
    const head = git(dir, ["rev-parse", "HEAD"]).stdout.trim();
    if (startedHere.has(repo) && mainChangedUnder(dir, head, integrationOf(repo, dir, remote), paths).length > 0) {
      noteEngineAskMark(pd, mainMovedMark(unit, head));
    }
    // A replace took the build pushed before off the branch: its base is read again.
    const replaced = lease !== undefined && !git(dir, ["merge-base", "--is-ancestor", lease, head]).ok;
    if (replaced) replacedFrom.set(name, git(dir, ["rev-parse", "--short", lease]).stdout.trim());
    const base = (replaced ? undefined : earlier.get(repo)?.base) ??
      (git(dir, ["merge-base", "HEAD", integrationOf(repo, dir, remote)]).stdout.trim() || head);
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
      // A repository the plan does not list: the lead reaches it by this address, with no sign-in in it.
      ...(addedRepos.includes(repo) ? { address: recordedAddress(dir, git(dir, ["remote", "get-url", remote]).stdout.trim()) } : {}),
    };
    results.push(entry);
    hostSaid.push({ name, words: hostLinkWords(pushed.stderr, branch) });
  }
  const nameOf = (repo: RepoResult): string => (repo.repo === "." ? "the repo" : repo.repo);
  const names = results.map(nameOf);
  const plain = names.filter((name) => !replacedFrom.has(name));
  // A host's own words stand in for ours (GitLab's say "merge request"):
  // "Open a PR" is said only for the repos whose host said nothing about it,
  // and never for a replaced branch, whose pull request is the same one.
  const quiet = hostSaid.filter((said) => said.words === "" && !replacedFrom.has(said.name)).map((said) => said.name);
  const lines = [
    joinSaid([
      plain.length === 0 ? "" : `Pushed branch ${branch} in ${joinNames(plain)}.`,
      ...[...replacedFrom].map(([name, was]) => `Pushed branch ${branch} in ${name} in place of the build pushed there before (it was at ${was}).`),
      ...hostSaid.filter((said) => said.words !== "").map((said) => hostSaysLine(names.length === 1 ? null : said.name, said.words)),
      quiet.length === 0 ? "" : `Open a PR in ${quiet.length < names.length ? joinNames(quiet) : names.length === 1 ? "it" : "each"} your usual way.`,
      whereNow(true).trimStart(),
    ]),
  ];
  // The lead's turn-down is about the commits it was said of: a push of those
  // very commits again keeps it, said once here.
  const down = claim?.payload.turned_down;
  if (down !== undefined && down.from !== "build-and-test" &&
    turnDownHolds(down, Object.fromEntries(results.map((repo) => [repo.repo, repo.heads.at(-1) ?? ""])))) {
    lines.push(`These are the commits that were turned down in ${down.repo}, so ${unit} stays turned down there.`);
  }
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
  lines.push(...keptLines());
  // The code went: the last push went through.
  rmSync(join(buildRecord, ENGINE_DIR, PUSH_REFUSED_MARK), { force: true });
  // The result goes home on the claim, with the Unit outputs the home's later
  // stages read.
  const outputs = unitOutputsHomeReads(unit, getField(state, "Scope") ?? "")
    .filter((rel) => existsSync(join(activeRecordDir(pd), ...rel.split("/"))));
  const kept = inputsKeptOverNewer(recordDir(pd) ?? "");
  const result: UnitResult = {
    by: git(pd, ["config", "user.name"]).stdout.trim() || "a teammate", repos: results, outputs,
    ...(kept.length > 0 ? { kept_edits: kept } : {}),
  };
  // The result on the Unit's record, with the Unit outputs the lead's later
  // stages read under result/.
  const resultOn = (on: UnitClaimView): string => {
    const files = Object.fromEntries(outputs.map((rel) => [
      rel,
      outputForLead(pd, rel, readFileSync(join(activeRecordDir(pd), ...rel.split("/")), "utf-8")),
    ]));
    return createRecordCommit(pd, on.oid, { ...on.payload, result }, "pushed", { result: files });
  };
  let homeHasIt = false;
  // On this build's take as its record holds it.
  const base = standing.state === "aside" || standing.state === "pending" ? null : claim;
  // The result not taken is said here once. A rule of its host meets a send
  // again the same way, so its line asks nothing and this chat is not
  // offered the send again (resendQuestion); nor does it hear the build's end
  // line about it (resultWaitsLine) right after this one.
  let notTaken: { byRule: boolean } | null = null;
  if (standing.state === "aside") {
    lines.push(standing.line);
  } else if (standing.state === "pending") {
    // The take was never written there, and is not now: said once for the
    // build, and nothing is asked; a later push the repository takes writes both.
    notTaken = { byRule: true };
    if (engineAskMark(pd, takeNotWrittenMark(unit)) === null) {
      lines.push(`${place.repo} still takes no push of ${unit}'s record from you (${recorded?.refused ?? "it changed while I was writing it"}), ` +
        "so neither your take nor this result is written there.");
      noteEngineAskMark(pd, takeNotWrittenMark(unit));
    }
  } else if (base === null) {
    // The record's repository answered and holds no record of this take now:
    // the code is pushed, and the result waits to be sent again.
    notTaken = { byRule: false };
    lines.push(`${place.repo} did not take ${unit}'s result: its record is not there now. Do you want me to send it again?`);
  } else {
    const sent = writeUnitRecord(pd, place, ref, resultOn(base), base.oid);
    if (!sent.ok) {
      const refused = "refused" in sent ? sent : null;
      notTaken = { byRule: refused?.byRule === true };
      lines.push(notTaken.byRule ? resultRefusedByRuleLine(unit, place.repo, refused!.refused)
        : `${place.repo} did not take ${unit}'s result: ${refused?.refused ?? "its record there changed while it was being sent"}. Do you want me to send it again?`);
    }
    else invalidateLiveClaimPayloadCache(pd, unit);
    homeHasIt = sent.ok;
  }
  if (notTaken !== null) {
    try {
      const chat = resolveWorkflowSelection(pd).sessionId;
      if (chat) markPersonLinesHeard(pd, chat, [resultWaitsLine(unit, place.repo), ...(notTaken.byRule ? [resendQuestion(unit, place.repo)] : [])]);
    } catch {
      // No chat known: the next step says and asks as it would.
    }
  }
  const sentOn = homeHasIt;
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
  // The push is done once its result went too: the build's message is spent,
  // and until then the same command runs again as written.
  if (sentOn) {
    given?.spend();
    const buildMessage = commitMessageFile(pd);
    if (buildMessage !== null && existsSync(join(pd, ...buildMessage.split("/")))) {
      try {
        removeRecordFileNoFollow(pd, buildMessage);
      } catch {
        // Left in its ignored folder; the next push question shows it.
      }
    }
  }
  // The build's record as this push leaves it goes with the code on the
  // workspace's own repository.
  const dot = planned.find((entry) => entry.repo === ".");
  const record = dot === undefined ? null : sendBuildRecord(pd, dot.remote, branch, unit, given?.text ?? null);
  if (record?.line) lines.push(record.line);
  // With the result on the Unit's record no line asks anything: the lines ride
  // the step that follows, as the take's carry-on line does, so a next run at
  // once says them with its question; with no chat known they are printed here.
  const told = joinSaid(lines);
  const forNextStep = sentOn && saidWithNextStep(pd, told);
  console.log(JSON.stringify({ pushed: true, unit, repos: results.map((repo) => repo.repo), ...(forNextStep ? {} : { notice: told }) }));
}

// What the build's last push of `unit` on `branch` left in each repository, by
// its own UNIT_PUSHED row, written once every repository's push went: the head
// it pushed, per repository. Empty with no such row.
export function lastPushedHeads(pd: string, unit: string, branch: string): Map<string, string> {
  const row = sortAttemptEvents(readAuditShardEvents(pd)).findLast((entry) => entry.event === "UNIT_PUSHED" &&
    auditBlockField(entry.block, "Unit") === unit && auditBlockField(entry.block, "Branch") === branch);
  const pairs = (row === undefined ? "" : auditBlockField(row.block, "Repos") ?? "").split(",").map((pair) => pair.trim()).filter(Boolean);
  return new Map(pairs.map((pair) => [pair.slice(0, pair.lastIndexOf("@")), pair.slice(pair.lastIndexOf("@") + 1)]));
}

// Whether `tip`, on a Unit's branch on its remote, is still what AI-DLC left
// on its last push there (`lease`) plus only what AI-DLC added on top: on the
// workspace's own repository the one record commit (one parent, the lease, and
// every change under aidlc/), or a merge of the branch it merges into with
// nothing of its own (first parent the lease, the second in `into`, no change
// beyond its two sides). A merge whose clash someone resolved has a change of
// its own, so it is never this.
function onlyOnLastPush(dir: string, lease: string, tip: string, into: string, own: boolean): boolean {
  const parents = git(dir, ["rev-list", "--parents", "-n", "1", tip]).stdout.trim().split(/\s+/).slice(1);
  if (parents[0] !== lease) return false;
  if (parents.length === 1) {
    return own && git(dir, ["diff-tree", "--no-commit-id", "-r", "--name-only", "-z", tip]).stdout.split("\0").filter(Boolean)
      .every((path) => path.startsWith("aidlc/"));
  }
  return parents.length === 2 && git(dir, ["merge-base", "--is-ancestor", parents[1], into]).ok &&
    git(dir, ["diff-tree", "--cc", "--no-commit-id", "-r", tip]).stdout.trim() === "";
}

// The code repositories of that push whose head kept mainMovedMark, with the
// branch each merges into and its remote, read here with no fetch, and the
// Unit's own files there that it changed and the pushed branch lacks (none
// once that branch has it).
export function mainMovedRepos(pd: string, unit: string, branch: string):
  Array<{ repo: string; dir: string; remote: string; into: string; head: string; paths: string[]; files: string[] }> {
  const manifest = readUnitSourceManifest(pd, "code-generation", unit);
  const targets = manifest.ok ? unitWriteTargets(pd, manifest.manifest.writes) : new Map<string, { dir: string; paths: string[] }>();
  return [...lastPushedHeads(pd, unit, branch)].flatMap(([repo, head]) => {
    const dir = targets.get(repo)?.dir ?? repoDir(pd, repo);
    if (repo === "." || engineAskMark(pd, mainMovedMark(unit, head)) === null || !isGitRepoDir(dir)) return [];
    const remote = pushRemoteOf(dir, branch);
    if (typeof remote !== "string") return [];
    const into = unitBranchInto(dir, remote);
    const paths = targets.get(repo)?.paths ?? [];
    const pushedTip = git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}^{commit}`]).stdout.trim() || head;
    return [{ repo, dir, remote, into, head, paths, files: mainChangedUnder(dir, pushedTip, into, paths) }];
  });
}

// `unit push --merge-main`: the person's yes to bringing the branch the Unit
// merges into into its pushed branch, in each code repository whose push kept
// mainMovedMark: fetched, merged and pushed with their own git, every
// repository checked before any is merged. A clash is left for them to
// resolve, and the same command then finishes it; a merge they committed
// themselves is pushed. Nothing of the Unit's is committed, sent to its record
// or written in its audit. `undo` takes a merge of it waiting there back out.
function mergeMainIn(pd: string, args: string[], unit: string, branch: string, undo: boolean): void {
  const given = undo ? null : givenCommitMessage(pd, args, "push");
  const repos = mainMovedRepos(pd, unit, branch).map((entry) => ({ ...entry, name: entry.repo }));
  const moved: Array<{ name: string; from: string }> = [];
  const lines: string[] = [];
  const has = (dir: string, older: string, newer: string): boolean => git(dir, ["merge-base", "--is-ancestor", older, newer]).ok;
  // A merge of `into` under way on the Unit's branch: the one this command left for them.
  const merging = (dir: string, into: string): boolean => gitOperationUnderWay(dir)?.what === "a merge" &&
    git(dir, ["branch", "--show-current"]).stdout.trim() === branch && has(dir, "MERGE_HEAD", into);
  if (repos.length === 0) {
    console.log(JSON.stringify({ pushed: false, unit, notice: undo
      ? `No merge of the branch ${unit} merges into is waiting, so nothing was undone.`
      : `${unit} has nothing to bring in from the branch it merges into; nothing was merged or pushed.` }));
    return;
  }
  if (undo) {
    for (const { dir, name, into } of repos) {
      const aborted = merging(dir, into) ? git(dir, ["merge", "--abort"]) : null;
      if (aborted?.ok) lines.push(`I undid the merge of ${into} into ${unit} in ${name}; ${unit} is as it was there, and nothing was pushed.`);
      else if (aborted !== null) {
        lines.push(`The merge of ${into} into ${unit} in ${name} could not be undone: git says "${gitSaid(aborted.stderr || aborted.stdout)}". ` +
          "It is still waiting there.");
      } else if (has(dir, into, `refs/heads/${branch}`)) lines.push(`The merge of ${into} is already committed on ${unit} in ${name}, so I left it.`);
      else lines.push(`No merge of ${into} is waiting in ${name}, so nothing was undone.`);
    }
    console.log(JSON.stringify({ undone: lines.some((line) => line.startsWith("I undid")), unit, notice: joinSaid(lines) }));
    return;
  }
  const whereNow = (): string => whereNowLine(branch, moved);
  // Merged here and not pushed yet, for a line that stops after it.
  const mergedHere: string[] = [];
  const stop = (line: string): never =>
    fail(line + (mergedHere.length > 0 ? ` In ${joinNames(mergedHere)}, it is merged into ${unit}, not pushed yet.` : "") + whereNow());
  const plan: Array<(typeof repos)[number] & { step: "merge" | "finish" | "push" | "level" }> = [];
  for (const entry of repos) {
    const { dir, name, into } = entry;
    const start = startRemoteOf(dir, entry.remote);
    const fetched = git(dir, ["fetch", "-q", start, into.slice(start.length + 1)]);
    if (!fetched.ok) stop(`${into} could not be fetched in ${name}: git says "${gitSaid(fetched.stderr)}". Nothing was merged or pushed. Say when to try again.`);
    if (merging(dir, into)) {
      plan.push({ ...entry, step: "finish" });
      continue;
    }
    const theirs = gitOperationUnderWay(dir);
    if (theirs !== null) stop(underWayLine(name, theirs, "nothing was merged or pushed", `bring ${into} in`));
    const tip = git(dir, ["rev-parse", `refs/heads/${branch}`]).stdout.trim();
    const pushedTip = git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/${entry.remote}/${branch}`]).stdout.trim();
    if (has(dir, into, tip)) {
      plan.push({ ...entry, step: pushedTip !== "" && has(dir, tip, pushedTip) ? "level" : "push" });
      continue;
    }
    const mergeChanges = new Set(git(dir, ["diff", "-z", "--name-only", `${tip}...${into}`]).stdout.split("\0").filter(Boolean));
    const ownChanged = git(dir, ["diff", "-z", "--name-only", "HEAD"]).stdout.split("\0").filter(Boolean);
    const ownUnit = ownChanged.find((path) => entry.paths.some((own) => path === own || (own.endsWith("/") && path.startsWith(own))));
    if (ownUnit !== undefined) {
      stop(`${unit}'s ${ownUnit} in ${name} has a change that is not committed, so nothing was merged or pushed. Once it is pushed with ` +
        `${unit}, or put aside, I can bring ${into} in.`);
    }
    const inTheWay = ownChanged.find((path) => mergeChanges.has(path));
    if (inTheWay !== undefined) {
      stop(`Your change to ${inTheWay} in ${name} is in a file ${into} changes, so nothing was merged or pushed. Once it is committed ` +
        `or put aside, I can bring ${into} in.`);
    }
    const added = git(dir, ["diff", "-z", "--name-only", "--diff-filter=A", `${tip}...${into}`]).stdout.split("\0").filter(Boolean);
    const replaced = added.find((path) => existsSync(join(dir, ...path.split("/"))) && !git(dir, ["ls-files", "--error-unmatch", "--", path]).ok);
    if (replaced !== undefined) {
      stop(`${into} adds ${replaced} in ${name}, where you have a file of your own, so nothing was merged or pushed. Once it is moved ` +
        `or put aside, I can bring ${into} in.`);
    }
    plan.push({ ...entry, step: "merge" });
  }
  for (const entry of plan) {
    const { dir, name, into } = entry;
    const from = git(dir, ["branch", "--show-current"]).stdout.trim();
    if (from !== branch) {
      const switched = CHECKOUT_STEPS.switch.run(dir, branch);
      if (!switched.ok) stop(`${unit} could not be checked out in ${name}, so nothing was merged or pushed. Git says: "${gitSaid(switched.stderr)}".`);
      moved.push({ name, from: from || "the commit you were on" });
    }
    const message = given === null ? [] : ["-m", given.text];
    if (entry.step === "finish" || entry.step === "merge") {
      const clashed = (): void => {
        const clash = conflictFiles(dir);
        if (clash.length === 0) return;
        stop(`${into} and ${unit} both change ${joinNames(clash)} in ${name} in ways git cannot put together, so the merge is waiting ` +
          `for you there: resolve ${clash.length === 1 ? clash[0] : "them"}, and I can finish it and push ${unit}; or say if you want ` +
          "me to undo it. Nothing was pushed.");
      };
      if (entry.step === "finish") clashed();
      const made = entry.step === "finish" ? git(dir, ["commit", "-q", "--no-edit", ...message]) : CHECKOUT_STEPS.merge.run(dir, into, message);
      if (!made.ok) {
        const said = gitSaid(made.stderr || made.stdout);
        clashed();
        // Their own resolution is in a merge they finish: it waits as they left it, never undone.
        if (entry.step === "finish") {
          stop(`Your hook in ${name} did not take the merge of ${into} into ${unit} (${said}), so the merge is still waiting there as ` +
            "you resolved it, and nothing was pushed. If it is the merge's message, tell me the one to use, and I will finish it with that.");
        }
        // A merge this step just began holds nothing of theirs: it is undone.
        if (gitOperationUnderWay(dir)?.what === "a merge") {
          git(dir, ["merge", "--abort"]);
          stop(`Your hook in ${name} did not take the merge of ${into} into ${unit} (${said}), so I undid it, and nothing was pushed. ` +
            "If it is the merge's message, tell me the one to use, and I will merge with that.");
        }
        stop(`${into} could not be merged into ${unit} in ${name}: git says "${said}". Nothing was merged or pushed.`);
      }
      mergedHere.push(name);
    } else if (entry.step === "push" && given !== null && git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).stdout.trim() === "1" &&
      git(dir, ["rev-parse", "--verify", "--quiet", "HEAD^2"]).ok) {
      // The merge made here that its host refused, for its message.
      const amended = git(dir, ["commit", "-q", "--amend", ...message]);
      if (!amended.ok) {
        stop(`Your hook in ${name} did not take the merge of ${into} into ${unit} (${gitSaid(amended.stderr || amended.stdout)}), so ` +
          "nothing was pushed. If it is the merge's message, tell me the one to use, and I will merge with that.");
      }
    }
  }
  for (const entry of plan) {
    const { dir, name, into } = entry;
    if (entry.step === "level") {
      lines.push(`${unit} already has ${into}'s changes to its files in ${name}; nothing was merged or pushed.`);
      continue;
    }
    const before = git(dir, ["rev-parse", "--short", `refs/remotes/${entry.remote}/${branch}`]).stdout.trim();
    const pushed = git(dir, ["push", "-q", entry.remote, branch]);
    if (mergedHere.includes(name)) mergedHere.splice(mergedHere.indexOf(name), 1);
    if (!pushed.ok) {
      const alone = git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).stdout.trim() === "1";
      stop(`Merged ${into} into ${unit} in ${name}, and the push was refused: ${pushRefusal(pushed.stderr)}. The merge stays here; ` +
        `${unit} was at ${before} before it. ` +
        (alone ? "If it is the merge's message, tell me the one to use, and I will merge with that and push again." : "Say when to push again."));
    }
    // A merge already on the branch here (theirs, or one made here whose push was refused) is pushed as it is.
    lines.push(entry.step === "push" ? `Pushed ${unit} in ${name}, with ${into} merged into it.` : `Merged ${into} into ${unit} in ${name} and pushed ${unit}.`);
  }
  given?.spend();
  console.log(JSON.stringify({ pushed: plan.some((entry) => entry.step !== "level"), unit, notice: joinSaid([...lines, whereNow().trim()]) }));
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
// For each Unit a team holds with a result in its record and not yet done:
// fetch each repo's integration branch with the person's own login, check
// whether the Unit's part is merged, and once every repo merged record the
// Unit done (UNIT_MERGED, under the per-intent lock) and write the Unit outputs
// the home's later stages read into its record; the verdicts and done go on the
// plan in one write, so the Units waiting on it open everywhere. A repo the home
// has no checkout of keeps the team's result as theirs until the home can check
// it. `unreached` collects the remotes that could not be read, `unsent` the ones
// that did not take the write, `told` each Unit whose newly seen merge is now on
// the plan (the repos it merged in, and whether it is done), `maybe` each commit
// that may be a merge the check cannot see.
export interface ToldMerge {
  unit: string;
  repos: string[];
  done: boolean;
  // Who built it, in words: the team holding the Unit, or the person.
  to: string;
}

// `readOnly` (a query such as `team-board`): the same verdicts, nothing written.
// `tookIn` gets each Unit whose records this look wrote into the lead's checkout.
export function checkTeamResults(
  projectDir: string,
  unreached?: string[],
  unsent?: Array<{ line: string; shareAgain?: true; repo?: string }>,
  told?: ToldMerge[],
  readOnly = false,
  tookIn?: string[],
  maybe?: MaybeMerged[],
  // Record repositories the look could not read: their Units are not checked.
  unread: ReadonlySet<string> = new Set(),
  // A pull request the lead named whose head the host does not keep, in a line each.
  noHead?: string[],
): Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }> {
  const pd = resolveProjectDir(projectDir);
  return quietly(() => checkTeamResultsQuietly(pd, unreached, unsent, told, readOnly, tookIn, maybe, unread, noHead));
}

function checkTeamResultsQuietly(
  pd: string,
  unreached?: string[],
  unsent?: Array<{ line: string; shareAgain?: true; repo?: string }>,
  told?: ToldMerge[],
  readOnly = false,
  tookIn?: string[],
  maybe?: MaybeMerged[],
  unread: ReadonlySet<string> = new Set(),
  noHead?: string[],
): Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }> {
  const found = new Map<string, { team: string; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean }>();
  const identity = activeIdentity(pd);
  const state = readStateFile(pd);
  const claims = cachedClaims(pd);
  const plan = keptPlan(pd, identity.intentId8)?.plan ?? null;
  const notRead = (unit: string): boolean => unread.size > 0 && plan !== null && unread.has(recordPlaceIn(plan, unit).repo);
  // The merges seen this look, written on the plan in one write.
  const seen = new Map<string, { view: UnitClaimView; verdicts: NonNullable<UnitClaimPayload["verdicts"]>; done: boolean; told: ToldMerge }>();
  for (const [unit, claim] of claims) {
    if (claim.status !== "claimed" || claim.payload.result === undefined || notRead(unit)) continue;
    // Done on the plan is the lead's own word, wherever it was written: a
    // fresh clone or another machine of the lead's records it here too.
    if (claim.payload.done) {
      if (!readOnly && recordUnitDone(pd, claim, claim.payload.verdicts ?? [])) tookIn?.push(unit);
      found.set(unit, { team: claim.owner, verdicts: claim.payload.verdicts ?? [], done: true });
      continue;
    }
    // The record as the look before this read it: its builder's, with the lead's word from the plan.
    const verdicts = resultVerdicts(pd, claim.payload, unreached, { unit, maybe });
    const done = countsDone(allMerged(verdicts), leadSignOffOn(state), claim.payload);
    // The one thing written unasked is a merge the lead's project has seen: a
    // look that sees no new merge writes nothing.
    const newlyMerged = verdicts.filter((verdict) => verdict.merged &&
      !(claim.payload.verdicts ?? []).some((before) => before.repo === verdict.repo && before.merged)).map((verdict) => verdict.repo);
    if (done && !readOnly && recordUnitDone(pd, claim, verdicts)) tookIn?.push(unit);
    if (!readOnly && (newlyMerged.length > 0 || done)) {
      const repos = done ? verdicts.filter((verdict) => verdict.merged).map((verdict) => verdict.repo) : newlyMerged;
      seen.set(unit, { view: claim, verdicts, done, told: { unit, repos, done, to: builderOf(claim) } });
    }
    found.set(unit, { team: claim.owner, verdicts, done });
  }
  // A Unit the lead named a pull request as the build of, with no pushed
  // result: each named head read now, except one already written merged (a
  // host may drop a merged pull request's head). Done when every named one is
  // merged and, with the lead's sign-off on, signed off.
  const namedSeen = new Map<string, { verdicts: NonNullable<UnitWord["verdicts"]>; done: boolean; repos: string[] }>();
  for (const entry of plan?.units ?? []) {
    const word = entry.word as UnitWord;
    const claim = claims.get(entry.name);
    const taken = claim?.status === "claimed" ? claim : undefined;
    if ((word.pull_requests ?? []).length === 0 || taken?.payload.result !== undefined || notRead(entry.name)) continue;
    if (word.done === true) {
      // Done on the plan, written by another computer of the lead's: recorded here too.
      if (!readOnly) recordNamedDone(pd, entry.name, (word.verdicts ?? []).filter((verdict) => verdict.merged), taken?.generation ?? 0);
      found.set(entry.name, { team: "", verdicts: word.verdicts ?? [], done: true });
      continue;
    }
    const verdicts = (word.pull_requests ?? []).map((pr): NonNullable<UnitWord["verdicts"]>[number] => {
      const had = word.verdicts?.find((verdict) => verdict.repo === pr.repo && verdict.merged);
      if (had !== undefined) return had;
      const read = namedPullRequestVerdict(pd, pr.repo, pr.number);
      if (read.kind === "unreached") unreached?.push(pr.repo);
      if (read.kind === "none") {
        noHead?.push(`${pr.repo} has no pull request ${pr.number} that git can read, so ${entry.name} is not counted merged by it. ` +
          `If the number is wrong, give me the right one; if ${entry.name} is merged some other way, say so.`);
      }
      return read.kind === "merged" ? { repo: pr.repo, merged: true, commit: read.commit, how: read.how } : { repo: pr.repo, merged: false };
    });
    const done = verdicts.every((verdict) => verdict.merged) && (!leadSignOffOn(state) || word.signoff !== undefined);
    const newly = verdicts.filter((verdict) => verdict.merged && !(word.verdicts ?? []).some((before) => before.repo === verdict.repo && before.merged))
      .map((verdict) => verdict.repo);
    if (!readOnly && (newly.length > 0 || done)) {
      namedSeen.set(entry.name, { verdicts, done, repos: done ? verdicts.map((verdict) => verdict.repo) : newly });
    }
    found.set(entry.name, { team: "", verdicts, done });
  }
  const ownDone = readOnly ? new Set<string>() : leadsOwnDone(pd, state, claims);
  // The plan's own repository not read this look: nothing is written to it now.
  const planUnread = plan !== null && unread.has(plan.plan_repo.name);
  // A write the plan's repository refused, or a plan that does not read, is
  // not tried again in the chat that heard it.
  const chat = ((): string | null => {
    try {
      return resolveWorkflowSelection(pd).sessionId ?? null;
    } catch {
      return null;
    }
  })();
  const held = `${identity.intentId8}\u0000the merge write waits for the next chat`;
  if ((seen.size > 0 || ownDone.size > 0 || namedSeen.size > 0) && !planUnread && !(chat !== null && personLineHeard(pd, chat, held))) {
    const named = [...seen.keys(), ...namedSeen.keys(), ...ownDone];
    const to = plan?.plan_repo.name ?? "the plan's repository";
    let sent: LeadWrite;
    try {
      sent = leadsPlanWrite(pd, {
        what: `${joinNames(named)} merged`,
        unasked: true,
        words: (unit, word) => {
          const merge = seen.get(unit);
          if (merge !== undefined) {
            return { ...wordForTake(word, merge.view), verdicts: wordVerdicts(merge.view, merge.verdicts), ...(merge.done ? { done: true as const } : {}) };
          }
          const byNaming = namedSeen.get(unit);
          if (byNaming !== undefined) return { ...word, verdicts: byNaming.verdicts, ...(byNaming.done ? { done: true as const } : {}) };
          return ownDone.has(unit) && word.done !== true ? { ...word, done: true } : null;
        },
      });
    } catch (error) {
      // A commit that could not be made here (a key that wants its passphrase, no git identity): unsent, in git's words.
      if (error instanceof GitWriteRefused) throw error;
      sent = { kind: "refused", words: errorMessage(error), byRule: false };
    }
    // Unwritten, the merge is seen again at the next step, which writes it then.
    if (sent.kind === "written" || sent.kind === "unchanged") {
      told?.push(...[...seen.values()].map((merge) => merge.told));
      for (const [unit, merge] of namedSeen) {
        told?.push({ unit, repos: merge.repos, done: merge.done, to: "" });
        if (merge.done) recordNamedDone(pd, unit, merge.verdicts, claims.get(unit)?.status === "claimed" ? claims.get(unit)!.generation : 0);
      }
    }
    else if (sent.kind === "unshared" && sent.gone !== undefined) {
      unsent?.push({ shareAgain: true, line: planGoneOffer(sent.gone) });
      if (chat !== null) markPersonLinesHeard(pd, chat, [held]);
    } else if (sent.kind === "unfollowed") {
      const said = planUnfollowedSay(pd, sent.follow, `the merge of ${joinNames(named)}`, false);
      unsent?.push({ line: said.line, ...(said.repo === undefined ? {} : { shareAgain: true as const, repo: said.repo }) });
      if (chat !== null) markPersonLinesHeard(pd, chat, [held]);
    }
    // A change on the plan this computer did not write: the step's question comes first, and the merge waits for it.
    else if (sent.kind !== "unshared" && sent.kind !== "stopped") {
      const merge = `The merge of ${joinNames(named)} could not be written on the plan in ${to}`;
      const words = (said: string): string => said.trim().replace(/[.!?]+$/, "");
      const over = sent.kind === "unreadable" && sent.format <= PLAN_FORMAT;
      unsent?.push({
        ...(over ? { shareAgain: true as const } : {}),
        line: sent.kind === "unreadable" ? `${unreadablePlanLine(pd, sent.format)}${over ? ` ${SHARE_AGAIN_OVER}` : ""}`
          : sent.kind === "refused" && sent.byRule
            ? `${merge}: ${words(sent.words)}. If it is the commit message, tell me the one to use, and I will write it with that.`
          : sent.kind === "refused" ? `${merge}: ${words(sent.words)}. I'll try again in your next chat.`
          : `${merge} just now. The next step tries again.`,
      });
      if (chat !== null && (sent.kind === "refused" || sent.kind === "unreadable")) markPersonLinesHeard(pd, chat, [held]);
    }
  }
  return found;
}

// The Units the lead's own project built that its state has done and the
// plan does not say so yet: the plan says done for them, so the Units that
// wait on them open for every team. The walking skeleton only once its code is
// in main (skeletonCodeInMain).
function leadsOwnDone(pd: string, state: string, claims: ReadonlyMap<string, UnitClaimView>): Set<string> {
  const plan = keptPlan(pd, activeIdentity(pd).intentId8)?.plan ?? null;
  if (plan === null) return new Set();
  const own = leadsOwnClaims(pd, state, claims);
  const completed = completedUnits(state);
  return new Set(plan.units.filter((entry) => completed.has(entry.name) && (entry.word as UnitWord).done !== true &&
    (own.has(entry.name) || claims.get(entry.name)?.status !== "claimed") &&
    (entry.name !== plan.skeleton || skeletonCodeInMain(pd, entry.name))).map((entry) => entry.name));
}

// The walking skeleton's code is in main: it wrote nothing in the workspace's
// own repository here (no code of it waits to go there), or every file it
// wrote there is on the share's branch as it is here, read after a quiet
// fetch of that branch. A pull request still open has it on its own branch only.
export function skeletonCodeInMain(pd: string, skeleton: string): boolean {
  const manifest = readUnitSourceManifest(pd, "code-generation", skeleton);
  const paths = manifest.ok ? unitWriteTargets(pd, manifest.manifest.writes).get(".")?.paths ?? [] : [];
  if (paths.length === 0) return true;
  const target = shareTarget(pd);
  if (target === null) return false;
  quietFetch(pd, ["-q", "--no-tags", target.remote, target.branch]);
  const blob = (at: string, path: string): string => git(pd, ["rev-parse", "--verify", "--quiet", `${at}:${path}`]).stdout.trim();
  return paths.every((path) => blob("HEAD", path) !== "" && blob(`refs/remotes/${target.remote}/${target.branch}`, path) === blob("HEAD", path));
}

// The lead's merge rule for a Unit's result, read only: a repo the lead counted
// merged by word, else its integration branch fetched quietly (no sign-in, the
// lead's own time limits) and the result's heads looked for there. A repo whose
// fetch failed goes on `unreached`, its verdict the last fetch's. At the lead's
// look (`look`), a repo its project already proved merged at the result's last
// head (its verdict on the plan, which the view carries) stays merged with no
// read, since nothing in a code clone keeps the tip it was proved at; a repo
// not merged as the result was sent is read again as at its Unit branch's
// later tip (keptUnitTip), then, reached this look, as at its pull request's
// last head on the host (mergedAtPullRequestHead), and one still not merged
// puts the commit that may be its merge on `look.maybe` (mergeCandidate). A
// team's own look reads with its own git only.
function resultVerdicts(
  pd: string,
  payload: UnitClaimPayload,
  unreached?: string[],
  look?: { unit: string; maybe?: MaybeMerged[] },
): NonNullable<UnitClaimPayload["verdicts"]> {
  return (payload.result?.repos ?? []).map((repo) => {
    const said = payload.said_merged?.find((entry) => entry.repo === repo.repo);
    if (said) return { repo: repo.repo, merged: true, how: `by your word: "${said.words}"` };
    const proved = look === undefined ? undefined : (payload.verdicts as UnitWord["verdicts"])?.find((entry) =>
      entry.repo === repo.repo && entry.merged && entry.head !== undefined && entry.head === repo.heads.at(-1));
    if (proved !== undefined) {
      return { repo: repo.repo, merged: true, ...(proved.commit ? { commit: proved.commit } : {}), ...(proved.how ? { how: proved.how } : {}) };
    }
    const dir = repo.repo === "." ? pd : repoDir(pd, repo.repo);
    if (!isGitRepoDir(dir)) return { repo: repo.repo, merged: false };
    const repoRemote = repositoryRemote(dir);
    const own = repo.repo === "." && repoRemote !== null ? homeIntegrationBranch(pd) : null;
    const integration = repoRemote === null ? "HEAD" : own !== null ? `${repoRemote}/${own}` : repoIntegration(dir, repoRemote);
    // Only the branch the Unit merges into.
    const reached = repoRemote !== null && quietFetch(dir, ["-q", repoRemote, integration.slice(repoRemote.length + 1)]).ok;
    if (repoRemote !== null && !reached) unreached?.push(repo.repo === "." ? repoRemote : repo.repo);
    let verdict = unitMergeVerdict(dir, integration, repo);
    if (!verdict.merged && look !== undefined && repoRemote !== null) {
      const tip = keptUnitTip(dir, repoRemote, repo);
      const atTip = tip === null ? null : resultAtTip(dir, integration, repo, tip);
      if (atTip !== null) verdict = unitMergeVerdict(dir, integration, atTip);
      const named = payload.pull_requests?.find((entry) => entry.repo === repo.repo)?.number;
      if (!verdict.merged && reached) verdict = mergedAtPullRequestHead(dir, repoRemote, integration, repo, named) ?? verdict;
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

// A Unit branch's later tip as git's own copy of the branch in that repo has
// it: fetched quietly first, and still there after the branch is deleted on
// the host until the person's own prune takes it (a fetch with prune on), so
// nothing of AI-DLC's is kept in a code clone for it. Read whatever the fetch
// gave: a branch no longer there fetches nothing. Null when git has no copy;
// whether the tip is the Unit's (it holds the result's last head) is
// resultAtTip's.
function keptUnitTip(dir: string, remote: string, repo: RepoResult): string | null {
  const tracking = `refs/remotes/${remote}/${repo.branch}`;
  quietFetch(dir, ["-q", remote, `+refs/heads/${repo.branch}:${tracking}`]);
  return git(dir, ["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`]).stdout.trim() || null;
}

// A squash of review commits whose branch was gone before a look saw them: the
// pull request's last head as the host keeps it (GitHub at refs/pull/<n>/head,
// GitLab at refs/merge-requests/<n>/head for 14 days after the merge), for the
// number the commit that may be the merge names (mergeCandidate). Both refs are
// listed quietly in one read of the repo's own remote, and the one there is
// fetched into FETCH_HEAD only when its commit is not here; nothing is kept.
// Merged only when it holds the result's last head (resultAtTip) and the
// integration branch has its content (unitMergeVerdict). Null otherwise, and
// the board asks the lead as before.
// With `named`, the number the lead named for this repository is read in
// place of the one a squash names.
function mergedAtPullRequestHead(dir: string, remote: string, integration: string, repo: RepoResult, named?: number): MergeVerdict | null {
  const candidate = named === undefined ? mergeCandidate(dir, integration, repo) : null;
  const refs = named !== undefined ? numberedHeadRefs(named)
    : candidate === null ? [] : pullRequestHeadRefs(git(dir, ["log", "-1", "--format=%B", candidate.commit]).stdout);
  if (refs.length === 0) return null;
  const found = pullRequestHead(dir, remote, refs);
  const head = found === "none" || found === "unreached" ? null : found;
  const atHead = head === null ? null : resultAtTip(dir, integration, repo, head);
  const verdict = atHead === null ? null : unitMergeVerdict(dir, integration, atHead);
  return verdict?.merged ? verdict : null;
}

// Both hosts' refs for a pull request's last head by its number.
function numberedHeadRefs(number: number): string[] {
  return [`refs/pull/${number}/head`, `refs/merge-requests/${number}/head`];
}

// A pull request's last head as the host keeps it at one of `refs`, listed
// quietly in one read of the repo's own remote and fetched into FETCH_HEAD only
// when its commit is not here; nothing is kept. "none": the host keeps no such
// head; "unreached": the remote did not answer.
function pullRequestHead(dir: string, remote: string, refs: readonly string[]): string | "none" | "unreached" {
  return quietly(() => {
    const listed = git(dir, ["ls-remote", remote, ...refs]);
    if (!listed.ok) return "unreached";
    const [oid = "", ref = ""] = listed.stdout.split(/\r?\n/)[0].split("\t");
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid)) return "none";
    return git(dir, ["cat-file", "-e", `${oid}^{commit}`]).ok || git(dir, ["fetch", "-q", "--no-tags", remote, ref]).ok ? oid : "unreached";
  });
}

type NamedVerdict =
  | { kind: "merged"; commit: string; how: "ancestry" | "same content" | "same change"; subject: string }
  | { kind: "open" | "not-cloned" | "none" | "unreached" };

// The lead's merge rule for a pull request the lead named as a Unit's build,
// read by its number only: its last head merged into the repository's
// integration branch by ancestry (a merge commit), or by content or patch-id
// from where the head leaves that branch (a squash, a rebase), as resultAtTip
// reads a later tip. "." is the workspace's own repository.
function namedPullRequestVerdict(pd: string, repo: string, number: number): NamedVerdict {
  const dir = repo === "." ? pd : repoDir(pd, repo);
  if (!isGitRepoDir(dir)) return { kind: "not-cloned" };
  const remote = repositoryRemote(dir);
  if (remote === null) return { kind: "none" };
  const own = repo === "." ? homeIntegrationBranch(pd) : null;
  const integration = own !== null ? `${remote}/${own}` : repoIntegration(dir, remote);
  if (!quietFetch(dir, ["-q", remote, integration.slice(remote.length + 1)]).ok) return { kind: "unreached" };
  const head = pullRequestHead(dir, remote, numberedHeadRefs(number));
  if (head === "none" || head === "unreached") return { kind: head };
  const merged = (verdict: MergeVerdict): NamedVerdict => verdict.merged
    ? { kind: "merged", commit: verdict.commit, how: verdict.how, subject: git(dir, ["log", "-1", "--format=%s", verdict.commit]).stdout.trim() }
    : { kind: "open" };
  const byAncestry = unitMergeVerdict(dir, integration, { repo, branch: "", base: "", heads: [head], paths: {} });
  if (byAncestry.merged) return merged(byAncestry);
  // Where the head leaves the integration branch stands for the earlier head resultAtTip reads from.
  const base = git(dir, ["merge-base", head, integration]).stdout.trim();
  const atHead = base === "" ? null : resultAtTip(dir, integration, { repo, branch: "", base, heads: [base], paths: {} }, head);
  return atHead === null ? { kind: "open" } : merged(unitMergeVerdict(dir, integration, atHead));
}

// A merge counted by the lead's word or by a pull request they named, taken
// back: the earlier merge no longer stands (UNIT_MERGE_TAKEN_BACK, which
// unitMergesStanding reads), one row with the lead's words where they gave
// some. Nothing else moves. What is said after the step's own line: each Unit
// that waited on this one and was taken since the merge was counted (its take
// commit is later than the merge's row), which stays taken; and, past the
// Unit stages, that Build and Test already started.
function mergeTakenBack(pd: string, unit: string, generation: number, fields: Record<string, string>): string {
  const since = unitMergesStanding(readAuditShardEvents(pd), unit).at(-1)?.timestamp ?? "";
  appendAuditEntry("UNIT_MERGE_TAKEN_BACK", { Unit: unit, "Attempt Generation": String(generation), ...fields }, pd);
  const claims = cachedClaims(pd);
  const meanwhile = since === "" ? [] : (keptPlan(pd, activeIdentity(pd).intentId8)?.plan.units ?? [])
    .filter((entry) => entry.waits_on.includes(unit))
    .flatMap((entry) => {
      const claim = claims.get(entry.name);
      if (claim?.status !== "claimed") return [];
      const at = localGit(pd, ["show", "-s", "--format=%aI", takeCommit(pd, claim.oid, claim.payload, true), "--"]).stdout.trim();
      return at !== "" && Date.parse(at) > Date.parse(since) ? [entry.name] : [];
    });
  return meanwhile.map((name) => ` ${name}, which waited on ${unit}, was taken meanwhile and stays taken.`).join("") +
    (pastUnitStages(readStateFile(pd)) !== null ? ` Build and Test already started with ${unit} counted merged. Say if you want to go back to it.` : "");
}

// A Unit done through the lead's naming or word, with no pushed result: its
// UNIT_MERGED row, once, with the take's generation where it was taken and not
// pushed (so the lead's walk counts it merged), else 0.
function recordNamedDone(pd: string, unit: string, verdicts: ReadonlyArray<{ repo: string; commit?: string; how?: string }>, generation: number): void {
  withAuditLock(pd, () => {
    if (unitMergesStanding(readAuditShardEvents(pd), unit).length > 0) return;
    appendAuditEntryUnlocked("UNIT_MERGED", {
      Unit: unit, Owner: "", "Built By": "",
      "Merged In": verdicts.map((verdict) => `${verdict.repo}${verdict.commit ? `@${verdict.commit}` : ""} (${verdict.how ?? "by your word"})`).join(", "),
      "Attempt Generation": String(generation),
    }, pd);
  });
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
  if (homeLocation(stateContent) === null) return null;
  const past = pastUnitStages(stateContent);
  if (past === null) return null;
  let back: UnitClaimView[];
  try {
    let cached = cachedClaims(projectDir);
    // A clone that holds no copy of the teams' records yet (a fresh clone of the
    // home: a plain clone brings none) looks first, the same once-a-chat look.
    const looked = cached.size === 0 && !isReadOnlyEngineProbe();
    if (looked) {
      refreshHomeClaims(projectDir, { sessionId, sincePerson: true });
      cached = cachedClaims(projectDir);
    }
    const own = leadsOwnClaims(projectDir, stateContent, cached);
    const open = [...cached.values()].some((claim) => claim.status === "claimed" && !claim.payload.done && !own.has(claim.unit));
    if (!open) return null;
    if (!looked && !isReadOnlyEngineProbe()) refreshHomeClaims(projectDir, { sessionId, sincePerson: true });
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
  const recorded = (): boolean => recordedMergedHere(projectDir, claim);
  if (recorded()) return false;
  const record = activeRecordDir(projectDir);
  const reads = new Set(unitOutputsHomeReads(claim.unit, getField(readStateFile(projectDir), "Scope") ?? ""));
  for (const rel of (claim.payload.result?.outputs ?? []).filter((output) => reads.has(output))) {
    const shown = recordText(projectDir, claim.oid, `result/${rel}`);
    if (shown === null) continue;
    mkdirSync(dirname(join(record, ...rel.split("/"))), { recursive: true });
    writeFileSync(join(record, ...rel.split("/")), shown, "utf-8");
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

// A turn-down as this build has heard it, kept with the engine's own once-marks
// in the build's engine folder: where the record stood when it was first heard
// here (`heard`), and that the build was opened again for it (`reopened`).
function turnDownMarkName(down: { at?: string }, kind: "heard" | "reopened"): string {
  return `unit-turned-down-${kind}-${(down.at ?? "").replace(/[^0-9A-Za-z]+/g, "")}.json`;
}

// The lead's turn-down still open at this build: heard here (`note` keeps
// where), and not answered by a push of the build after that, even of the
// commits that were turned down; the plan keeps the lead's word for the lead
// to read. A mark this record cannot place a push against keeps it open.
function turnDownOpen(projectDir: string, down: { at?: string }, note: boolean): boolean {
  const heard = engineAskMark(projectDir, turnDownMarkName(down, "heard"));
  if (heard === null) {
    if (note && !isReadOnlyEngineProbe()) noteEngineAskMark(projectDir, turnDownMarkName(down, "heard"));
    return true;
  }
  const after = rowsAfterMark(projectDir, heard);
  return after === null || !readAuditShardEvents(projectDir).some((row) => row.event === "UNIT_PUSHED" && after(row));
}

export function reopenTurnedDownBuild(
  projectDir: string,
  stateContent: string,
): { repo: string; words?: string; at?: string; from?: "build-and-test" } | null {
  const build = unitBuildOf(stateContent);
  if (build === null) return null;
  try {
    const space = buildHomeSpace(projectDir, build);
    const mine = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false)
      .get(build.unit);
    const down = mine?.payload.turned_down && !mine.payload.done ? mine.payload.turned_down : null;
    if (!down) return null;
    if (!turnDownOpen(projectDir, down, true)) return null;
    // Opened again once for this turn-down.
    const reopened = turnDownMarkName(down, "reopened");
    if (engineAskMark(projectDir, reopened) === null && getField(stateContent, "Status") === "Completed" && !isReadOnlyEngineProbe()) {
      withAuditLock(projectDir, () => writeStateFile(projectDir, setField(readStateFile(projectDir), "Status", "Running")));
      noteEngineAskMark(projectDir, reopened);
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
  const space = buildHomeSpace(projectDir, build);
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
        return buildEarlyOn(projectDir, build, cached.get(build.unit)).some((dep) => dep.repos.length > 0 && cached.get(dep.unit)?.payload.done !== true);
      } catch {
        return false;
      }
    })();
    const atStage = `${recordDir(projectDir) ?? ""}:${getField(stateContent, "Current Stage")?.trim() ?? ""}`;
    const newStage = buildStageLooked(projectDir, sessionId) !== atStage;
    const refreshed = home === null ? null : refreshHomeClaims(projectDir, { home, sessionId, now: waits || newStage || waitsOnEarly });
    // Its plan moved and it reads it where it went now: the rest is read from its state as it is now, once, only
    // when its Home Location did change, so a look that followed and re-keyed nothing never goes round again.
    if (refreshed?.followed !== undefined) {
      const moved = readStateFile(projectDir);
      if (!sameGitAddress(unitBuildOf(moved)?.homeLocation ?? "", build.homeLocation)) return buildClaimNotes(projectDir, moved, sessionId);
    }
    if (refreshed !== null && refreshed.unreached.length > 0) {
      const names = [...new Set(refreshed.unreached.map((unread) => unread.repo))];
      // The plan's own repository among them: the way on for a plan that moved, the new address the builder can give.
      const plan = refreshed.unreached.find((unread) => sameGitAddress(unread.address, build.homeLocation));
      lines.push(`${joinNames(names)} could not be read just now (${refreshed.unreached[0].said}), so news from ` +
        `${names.length === 1 ? "it" : "them"} may be behind.` + (plan === undefined ? ""
          : ` If the plan of ${homeLabelOf(stateContent, build)} has moved from ${plan.repo}, tell me its new address and this build will read it there.`));
    }
    const over = planSharedOverLine(projectDir, stateContent);
    if (over !== null) lines.push(over);
    if (refreshed?.refused && home !== null) {
      lines.push(newsNotTakenIn(joinNames([...new Set(recordPlacesOfWork(projectDir, home.id8, home).map((place) => place.repo))])));
    }
    if (home !== null && newStage) noteBuildStageLooked(projectDir, sessionId, atStage);
    // A take its record's repository did not take then, tried again when the records were just read.
    const standing = home !== null && (refreshed?.fetched || refreshed?.lookedThisCommand === true) ? takeStanding(projectDir, build) : null;
    if (home !== null && standing?.state === "pending") recordTakeHere(projectDir, build, home, standing, false);
    if (home !== null && waits && (refreshed?.unreached.length ?? 0) === 0) {
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
  if (down && turnDownOpen(projectDir, down, true)) {
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
  for (const dep of buildEarlyOn(projectDir, build, mine)) {
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
    const shown = amendmentText(projectDir, amendment);
    if (shown === null) continue;
    // Pushed after the change came: it was built on the older one, and its stages hear it as stale.
    // Both times are to the second, so a change of the push's own second reads as after it.
    const pushedAt = readAuditShardEvents(projectDir).filter((row) => row.event === "UNIT_PUSHED")
      .map((row) => row.timestamp).sort().at(-1);
    const line = takeNewerInput(projectDir, record, unit, amendment.input, shown, {
      at: amendment.at,
      done: mine.payload.done === true,
      pushed: getField(stateContent, UNIT_PUSH_FIELD)?.trim() === "pushed" && (pushedAt === undefined || amendment.at >= pushedAt),
      // The copy is still the text the team proposed: the lead's answer replaces it.
      proposedHere: ((): boolean => {
        const proposed = recordText(projectDir, mine.oid, `proposals/${amendment.input}`);
        const copy = join(record, ...amendment.input.split("/"));
        return proposed !== null && existsSync(copy) && textFingerprint(readFileSync(copy, "utf-8")) === textFingerprint(proposed);
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
  const place = recordPlaceOf(pd, home, build.unit);
  let on: UnitClaimView | null;
  try {
    on = readUnitRecord(pd, place, recordWork(home), build.unit);
  } catch (error) {
    if (error instanceof RecordUnread) return;
    throw error;
  }
  if (on?.status !== "claimed" || on.payload.result === undefined || on.payload.done) return;
  const repos = on.payload.result.repos.map((repo) => {
    const atTip = tips.get(repo.repo);
    return atTip !== undefined && atTip.heads.at(-2) === repo.heads.at(-1) ? atTip : repo;
  });
  const payload: UnitClaimPayload = { ...on.payload, result: { ...on.payload.result, repos } };
  if (writeUnitRecord(pd, place, ref, createRecordCommit(pd, on.oid, payload, "branch moved"), on.oid).ok) invalidateLiveClaimPayloadCache(pd, build.unit);
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
      const homeSpace = buildHomeSpace(projectDir, build);
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
          command: takeCommandOf(projectDir, build),
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
  const space = buildHomeSpace(projectDir, build);
  let claims: Map<string, UnitClaimView>;
  try {
    claims = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false);
  } catch {
    return [];
  }
  const branch = unitBranchOf(stateContent, build.unit);
  const earlyOn = buildEarlyOn(projectDir, build, claims.get(build.unit));
  if (earlyOn.length === 0 || takeStanding(projectDir, build).state === "aside") return [];
  return earlyOn.flatMap((dep) => {
    const theirs = claims.get(dep.unit)?.payload;
    if (!theirs?.done || skip(dep.unit)) return [];
    const moves = (from: typeof dep.repos, look: boolean) => from.flatMap(({ repo, head }) => {
      const dir = repo === "." ? projectDir : repoDir(projectDir, repo);
      const remote = isGitRepoDir(dir) ? repositoryRemote(dir) : null;
      if (remote === null || !git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok) return [];
      const workBranch = repo === "." ? homeIntegrationBranch(projectDir) : null;
      const onto = workBranch !== null ? `${remote}/${workBranch}` : repoIntegration(dir, remote);
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

// The person's own git operation under way in a repo, never touched by
// AI-DLC: what did not happen, git's own way to finish it and to put it aside,
// and what AI-DLC can do once it is done. The push and the move say it alike.
function underWayLine(name: string, underWay: { what: string; finish: string; abort: string }, outcome: string, then: string): string {
  return `${name} is in the middle of ${underWay.what}, so ${outcome}. Finish it (${underWay.finish}) ` +
    `or put it aside (${underWay.abort}), then I can ${then}.`;
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
    CHECKOUT_STEPS.switch.undo(back.length === 1 ? back[0] : joinNames(moved.map((entry) => `${entry.from} in ${entry.name}`)));
}

// The person's yes to moving the build onto the integration branch: in each
// repo, the integration branch fetched, then the rebase with their own git. A
// rebase git stops on a conflict is AI-DLC's own, so it is undone at once and
// said in git's words; one git refuses (their uncommitted changes) is said the
// same way; a git operation of theirs already under way there is never touched,
// and the move is offered again once it is done. The repos before it stay moved.
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
      const movedTail = (): string => (moved.length > 0 ? ` In ${joinNames(moved)} it is on ${joinNames([...onto])} now.` : "") +
        whereNowLine(unitBranch, switched);
      const theirs = gitOperationUnderWay(repo.dir);
      if (theirs !== null) {
        // Offered again once it is done (moveInTheWay reads it).
        noteEngineAskMark(pd, moveRefusedMark(dep.unit));
        fail(underWayLine(repo.name, theirs, `${build.unit} was not moved there`, `move ${build.unit}`) + movedTail());
      }
      git(repo.dir, ["fetch", "-q", repo.remote, branch]);
      const from = git(repo.dir, ["branch", "--show-current"]).stdout.trim();
      const ran = git(repo.dir, repo.rebase);
      if (!ran.ok) {
        const stopped = rebaseUnderWay(repo.dir);
        // Refused for their own changes: offered again once they are out of the way.
        if (!stopped) noteEngineAskMark(pd, moveRefusedMark(dep.unit));
        const undone = stopped && git(repo.dir, ["rebase", "--abort"]).ok;
        // A stopped rebase switched to the Unit's branch first, and its abort leaves them there.
        if (stopped && from !== unitBranch) switched.push({ name: repo.name, from: from || "the commit you were on" });
        fail(`${build.unit} could not be moved onto ${branch} in ${repo.name}. Git says: "${gitSaid(ran.stderr || ran.stdout)}".` +
          (undone ? ` I undid the move there, so ${build.unit} is where it was in ${repo.name}.`
            : stopped ? ` To go back to where ${build.unit} was there, run git rebase --abort in ${repo.name}.` : "") + movedTail());
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
  const place = recordPlaceOf(pd, home, build.unit);
  // Never onto a record this build's take is not on; one its repository did
  // not take then is recorded first.
  typedRecordRead(pd, place, recordWork(home), build.unit);
  let standing = takeStanding(pd, build);
  if (standing.state === "pending" && recordTakeHere(pd, build, home, standing, true).ok) standing = takeStanding(pd, build);
  if (standing.state === "aside") {
    console.log(JSON.stringify({ proposed: false, notice: standing.line }));
    return;
  }
  const live = recordCopied(pd, place, recordWork(home), build.unit);
  if (live?.status !== "claimed") fail(`Your take of ${build.unit} is not on its record in ${place.repo}, so there is nowhere to put the change.`);
  const proposal: Proposal = {
    input: match.path,
    by: git(pd, ["config", "user.name"]).stdout.trim() || "a teammate",
    words: personWordsOf(pd, flags),
    at: isoTimestamp(),
  };
  const payload: UnitClaimPayload = {
    ...live.payload,
    proposals: [...(live.payload.proposals ?? []).filter((entry) => entry.input !== match.path), proposal],
  };
  const commit = createRecordCommit(pd, live.oid, payload, `proposed a change to ${match.path}`, { proposals: { [match.path]: text } });
  const sent = writeUnitRecord(pd, place, ref, commit, live.oid);
  const carryingOn = `I'm carrying on with ${flags.file !== undefined ? `the approved ${name}` : "your version here"} until the lead decides.`;
  if (!sent.ok) {
    fail(`${place.repo} did not take the change: ${"refused" in sent ? sent.refused : "its record changed while I was writing it"}. Say when to try again.`);
  }
  invalidateLiveClaimPayloadCache(pd, build.unit);
  // Nobody is told of it: said the first time in a chat.
  const chat = resolveWorkflowSelection(pd).sessionId;
  const noNotice = chat !== null && chat !== undefined && personLineHeard(pd, chat, NO_NOTICE) ? "" : ` ${NO_NOTICE}`;
  if (noNotice !== "" && chat) markPersonLinesHeard(pd, chat, [NO_NOTICE]);
  console.log(JSON.stringify({
    proposed: true,
    notice: `Your change to the ${name} is on ${build.unit}'s record in ${place.repo}.${noNotice} ${carryingOn}`,
  }));
}

// What a proposal's line says once in a chat: the lead hears of it at their own look.
const NO_NOTICE = "AI-DLC sends no notice of it.";

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
  const shown = recordText(projectDir, claim.oid, `proposals/${input}`);
  const record = recordDir(projectDir);
  if (shown === null || record === null) return null;
  const path = join(record, ENGINE_DIR, "proposed", claim.unit, ...input.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, shown, "utf-8");
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
    const space = buildHomeSpace(projectDir, build);
    mine = cachedClaimsForIdentity(projectDir, { space, intentUuid: build.homeWork, intentId8: idSuffix(build.homeWork) }, false).get(build.unit);
  } catch {
    // No claims here: its own copy is the record.
  }
  const sentOrAnswered = (input: string, fingerprint: string): boolean => mine !== undefined &&
    (mine.payload.proposals?.some((entry) => entry.input === input && entry.answer === undefined) ||
      [recordText(projectDir, mine.oid, `proposals/${input}`),
        ...(mine.payload.amendments ?? []).filter((entry) => entry.input === input).map((entry) => amendmentText(projectDir, entry))]
        .some((shown) => shown !== null && textFingerprint(shown) === fingerprint));
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

// At the home: the lead's own change to an input teams build with (a redo of
// Requirements Analysis, say), once its stage's gate approved it: each team
// building a Unit that hears it (unitsHearing) and still has an older copy
// (its last amendment of it, else the copy it took) gets it on the plan, as
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
    if (claims.length === 0) return lines;
    const record = activeRecordDir(pd);
    const recordRel = relativeRecordDir(pd)?.split(sep).join("/") ?? null;
    const texts: Record<string, string> = {};
    const state = readStateFile(pd);
    const graph = loadGraph();
    const rows = readAuditShardEvents(pd);
    const receipts = latestCompletionBasesFromAudit(readAllAuditShards(pd));
    const kept = keptPlan(pd, activeIdentity(pd).intentId8);
    // The lead's latest word on an input: its stage's gate, or a team's change
    // to it the lead approved (SHARED_INPUT_AMENDED), which reaches a Unit
    // taken after it too.
    const approval = (stage: string, input: string): AuditShardEvent | undefined => rows
      .filter((row) => (row.event === "GATE_APPROVED" && auditBlockField(row.block, "Stage") === stage && !auditBlockField(row.block, "Unit")) ||
        (row.event === "SHARED_INPUT_AMENDED" && auditBlockField(row.block, "Input") === input))
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)).at(-1);
    // Each input changed and approved since a team's copy, by Unit: what the
    // one write puts on the plan.
    const reaches = new Map<string, { view: UnitClaimView; inputs: string[] }>();
    const changed: string[] = [];
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
      let any = false;
      for (const claim of claims) {
        // A team's own change waiting for the lead's answer is that answer's to settle.
        if ((claim.payload.proposals ?? []).some((entry) => entry.input === input && entry.answer === undefined)) continue;
        const last = (claim.payload.amendments ?? []).find((entry) => entry.input === input) as (Amendment & { blob?: string }) | undefined;
        let copy: string | null;
        if (last !== undefined) {
          if (Date.parse(approved.timestamp) <= Date.parse(last.at)) continue;
          copy = amendmentText(pd, last);
        } else {
          // The copy the take read: the plan at the commit it was taken from;
          // a take of solo work read the lead's own record at that commit.
          const taken = kept === null ? null : planAtCopy(pd, kept.ref, { commit: claim.payload.base_oid });
          if (taken?.kind === "read") {
            const then = taken.plan.inputs.find((entry) => entry.path === input)?.approved;
            if (then !== undefined && Date.parse(approved.timestamp) <= Date.parse(then)) continue;
            copy = recordText(pd, claim.payload.base_oid, `inputs/${input}`);
          } else {
            if (recordRel === null || auditRowsAt(pd, recordRel, claim.payload.base_oid).some((row) => row.block === approved.block)) continue;
            copy = recordText(pd, claim.payload.base_oid, `${recordRel}/${input}`);
          }
        }
        if (copy === null || textFingerprint(copy) === textFingerprint(text) || !unitsHearing(pd, input, copy, text).has(claim.unit)) continue;
        const entry = reaches.get(claim.unit) ?? { view: claim, inputs: [] };
        entry.inputs.push(input);
        reaches.set(claim.unit, entry);
        any = true;
      }
      if (any) {
        changed.push(input);
        texts[input] = text;
      }
    }
    if (reaches.size === 0) return lines;
    const reached = new Map<string, string[]>();
    let sent: LeadWrite;
    try {
      sent = leadsPlanWrite(pd, {
      what: `${joinNames(changed.map(inputName))} changed`,
      take: { inputs: texts },
      words: (unit, word) => {
        const entry = reaches.get(unit);
        if (entry === undefined) return null;
        const next = wordForTake(word, entry.view);
        for (const input of entry.inputs) {
          const blob = planBlobOf(pd, texts[input]);
          if ((next.amendments ?? []).some((amendment) => amendment.input === input && amendment.blob === blob)) continue;
          next.amendments = [...(next.amendments ?? []).filter((amendment) => amendment.input !== input), { input, at: isoTimestamp(), words: "", blob }];
          reached.set(input, [...(reached.get(input) ?? []), entry.view.unit]);
        }
        return next;
      },
    });
    } catch (error) {
      // A commit that could not be made here: not written, in git's words.
      if (error instanceof GitWriteRefused) throw error;
      sent = { kind: "refused", words: errorMessage(error), byRule: false };
    }
    if (sent.kind !== "written") {
      // The step's question comes first when a change this computer did not write stopped it.
      if (sent.kind === "unchanged" || sent.kind === "unshared" || sent.kind === "stopped") return lines;
      // A moved plan not followed: said when its place could not be read; the
      // offer to share it again, which needs its command, is the merge write's.
      if (sent.kind === "unfollowed" && sent.follow.kind === "not-followed") return lines;
      const what = changed.length === 1 ? `the change to the ${inputName(changed[0])}` : `the changes to the ${joinNames(changed.map(inputName))}`;
      return [sent.kind === "unreadable" ? unreadablePlanLine(pd, sent.format)
        : sent.kind === "unfollowed" ? planUnfollowedSay(pd, sent.follow, what, false).line : planWriteRefusedLine(pd, sent, what, false)];
    }
    for (const input of changed) {
      const units = reached.get(input);
      if (units === undefined) continue;
      const name = inputName(input);
      // In the plan's order, as the board lists them.
      const order = kept?.plan.units.map((entry) => entry.name) ?? [];
      const listed = [...new Set(units)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      lines.unshift(`The ${name} you changed ${name.endsWith("s") ? "are" : "is"} on the plan now, for ${joinNames(listed)}.`);
    }
    return lines;
  });
}

// The text of a change the lead approved to an input, as the plan keeps it.
function amendmentText(pd: string, amendment: Amendment & { blob?: string }): string | null {
  if (amendment.blob === undefined || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(amendment.blob)) return null;
  const shown = localGit(pd, ["cat-file", "blob", amendment.blob]);
  return shown.ok ? shown.stdout : null;
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
// current, and every team building with it gets it on the plan, in one write
// made before anything here changes.
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
  const live = leadsRecordNow(pd, unit);
  const proposal = live?.payload.proposals?.find((entry) => entry.input === flags.input && entry.answer === undefined);
  if (!live || proposal === undefined) fail(`${unit} has no change to ${flags.input} waiting for an answer.`);
  const lead = leadsWord(pd, flags, "The answer to a proposed change", "unit-amend");
  const name = inputName(proposal.input);
  const reply: NonNullable<UnitWord["answers"]>[number] = {
    input: proposal.input, at: proposal.at, answer: answer === "approve" ? "approved" : "turned down", ...(words ? { words } : {}),
  };
  const answered = { ...proposal, answer: reply.answer };
  const lines: string[] = [];
  // The proposer's answer on the plan, beside the word already there for it.
  const withAnswer = (word: UnitWord): UnitWord => ({
    ...word, answers: [...(word.answers ?? []).filter((entry) => !(entry.input === reply.input && entry.at === reply.at)), reply],
  });
  if (answer === "approve") {
    const proposed = recordText(pd, live.oid, `proposals/${proposal.input}`);
    if (proposed === null) fail(`The proposed ${name} is not on ${unit}'s claim; ask the team to send it again.`);
    const path = join(activeRecordDir(pd), ...proposal.input.split("/"));
    // Only the team's change goes in: made on the copy the team took, it is put
    // onto the text approved here since, never written over it.
    // The copy the team changed: the lead's last change it took in, else the one it took.
    const last = (live.payload.amendments ?? []).find((entry) => entry.input === proposal.input);
    // A take reads the plan at its commit; a take of solo work, the lead's own record there.
    const recordRel = relativeRecordDir(pd)?.split(sep).join("/") ?? null;
    const taken = last !== undefined ? amendmentText(pd, last)
      : recordText(pd, live.payload.base_oid, `inputs/${proposal.input}`) ??
        (recordRel === null ? null : recordText(pd, live.payload.base_oid, `${recordRel}/${proposal.input}`));
    // The lead's own text of the two put together (--file), approved as written.
    const own = flags.file !== undefined ? readFileSync(resolve(pd, flags.file), "utf-8") : null;
    const text = own ?? changeOntoCurrent(pd, path, taken, proposed);
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
    const readers = unitsHearing(pd, proposal.input, before, text);
    const cached = cachedClaims(pd);
    const leads = leadsOwnClaims(pd, readStateFile(pd), cached);
    // Only the Units whose stages read it hear it; the proposing team always hears its answer.
    const hearing = new Map([...cached].filter(([other, claim]) =>
      claim.status === "claimed" && !leads.has(other) && (other === unit || readers.has(other))));
    const blob = planBlobOf(pd, text);
    // The plan first: until it holds the change and the answer, nothing here is changed.
    const sent = leadsPlanWrite(pd, {
      what: `${name} changed, from ${unit}`,
      take: { inputs: { [proposal.input]: text } },
      words: (other, word) => {
        const claim = hearing.get(other);
        if (claim === undefined) return null;
        const next = wordForTake(word, claim);
        next.amendments = [...(next.amendments ?? []).filter((entry) => entry.input !== proposal.input),
          { input: proposal.input, at: isoTimestamp(), words, blob }];
        return other === unit ? withAnswer(next) : next;
      },
    });
    failUnlessWritten(pd, sent, `your answer on ${builderOf(live)}'s change to the ${name}`, lead.fields["Message Id"]);
    writeFileSync(path, text, "utf-8");
    renewForAmendedInput(pd, proposal.input, {
      "Proposed By": `${proposal.by} (${live.owner})`, ...(lead.said !== null ? { "Person Words": lead.said } : {}),
    });
    // In the plan's order, as the board lists them.
    const order = keptPlan(pd, activeIdentity(pd).intentId8)?.plan.units.map((entry) => entry.name) ?? [];
    const units = [...hearing.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    lines.unshift(`The ${name} ${name.endsWith("s") ? "are" : "is"} changed here and on the plan, for ${joinNames(units)}.`);
  } else {
    const sent = writeUnitWord(pd, live, `${name} change from ${unit} turned down`, withAnswer);
    failUnlessWritten(pd, sent, `your answer on ${builderOf(live)}'s change to the ${name}`, lead.fields["Message Id"]);
    lines.push(`Turned down ${builderOf(live)}'s change to the ${name}. Written on the plan, with your words.${noNoticeOnce(pd)}`);
  }
  appendAuditEntry("QUESTION_ANSWERED", {
    Question: `${builderOf(live)} proposes a change to the ${name} for ${unit}`,
    Answer: answer === "approve" ? "Approve it" : "Turn it down",
    // The engine's own question this answers, which the row closes (the ledger's answered).
    [QUESTION_TYPE_FIELD]: "unit-amend",
    ...lead.fields,
  }, pd);
  console.log(JSON.stringify({ answered: answered.answer, unit, notice: withPlanNotes(lines.join(" ")) }));
}

// A Unit's record as its repository has it now, with the lead's word on it,
// at a lead's step the person asked for: in the repository the plan names for
// it, or, before a plan is shared, in the workspace's own (a Unit a teammate
// took of solo work).
function leadsRecordNow(pd: string, unit: string): UnitClaimView | null {
  const identity = activeIdentity(pd);
  const plan = keptPlan(pd, identity.intentId8)?.plan ?? null;
  const address = workspaceHomeLocation(pd);
  const place = plan !== null ? recordPlaceIn(plan, unit)
    : address === null || address === "local" ? null : { repo: repoNameOf(address), address };
  return place === null ? null : typedRecordRead(pd, place, { uuid: identity.intentUuid, space: identity.space }, unit);
}

// The word on the plan for this take of a Unit: a word about an earlier take
// starts again.
function wordForTake(word: UnitWord, view: UnitClaimView): UnitWord {
  return word.generation === view.generation ? { ...word } : { generation: view.generation };
}

// The lead's merge verdicts as a word keeps them: each with the head it was read at.
function wordVerdicts(view: UnitClaimView, verdicts: NonNullable<UnitClaimPayload["verdicts"]>): NonNullable<UnitWord["verdicts"]> {
  const heads = resultHeads(view.payload);
  return verdicts.map(({ repo, merged, commit, how }) => ({
    repo, merged, ...(commit ? { commit } : {}), ...(how ? { how } : {}), ...(heads[repo] ? { head: heads[repo] } : {}),
  }));
}

// The arguments this command was run with, for the same command again.
let invokedArgs: string[] = [];

// A lead's word not written, with the same command naming the message their
// words came in (`again`), so trying again never asks for them twice; with the
// lead's question first (`ask`), the command to run once they answer it.
class LeadWordUnwritten extends Error {
  constructor(message: string, readonly again: string, readonly ask?: ReturnType<typeof planChangeQuestion>, readonly onYes?: string) {
    super(message);
  }
}

// A lead's write that did not go stops the step: on a plan a newer AI-DLC
// wrote, the update offer; on a tip that is not a plan, that; on work whose
// plan is not shared yet, that `what` (the word, "refunds's sign-off") waits
// for the share; else why, in git's or the host's words, and that `what` is
// not written. `message`: the message the lead's words came in, kept for the
// same command.
function failUnlessWritten(pd: string, written: LeadWrite, what: string, message?: string): void {
  if (written.kind === "written" || written.kind === "unchanged") return;
  const same = [aidlcToolInvocation("unit"), ...invokedArgs.filter((arg, at, all) => arg !== "--message" && all[at - 1] !== "--message").map(shellArg)];
  const again = message === undefined ? null : [...same, "--message", shellArg(message)].join(" ");
  const stop = (said: string): never => {
    if (again === null) fail(said);
    throw new LeadWordUnwritten(said, again);
  };
  // A change on the plan this computer did not write: the lead's question again, never silence.
  if (written.kind === "stopped") {
    const ask = planChangeQuestion(written.detail as PlanChange);
    throw new LeadWordUnwritten(`Before I write ${what}: ${ask.question}`, again ?? same.join(" "), ask);
  }
  // A plan to share again first (a tip that is not a plan, or a plan gone
  // from its repository): the share, then this word, on the lead's yes.
  const shareFirst = (said: string, repo?: string): never => {
    const word = again ?? same.join(" ");
    throw new LeadWordUnwritten(said, word, undefined, shareThenWord(word, repo));
  };
  if (written.kind === "unfollowed") {
    const said = planUnfollowedSay(pd, written.follow, what, again !== null);
    if (said.repo === undefined) stop(said.line);
    shareFirst(said.line, said.repo);
  }
  if (written.kind === "unreadable") {
    if (written.format > PLAN_FORMAT) stop(unreadablePlanLine(pd, written.format));
    shareFirst(`${unreadablePlanLine(pd, written.format)} ${SHARE_AGAIN_OVER}`);
  }
  if (written.kind === "unshared") {
    if (written.gone !== undefined) shareFirst(planGoneOffer(written.gone));
    const { space, intentUuid, intentId8 } = activeIdentity(pd);
    const work = readIntentRegistry(pd, space).find((entry) => entry.uuid === intentUuid)?.slug ?? intentId8;
    stop(`The plan of ${work} is not shared yet, so ${what} is not written. Once the plan is shared, ask me again and I'll write it ` +
      "with the words you gave.");
  }
  stop(planWriteRefusedLine(pd, written, what, again !== null));
}

// A lead's write the plan's repository did not take, said for every lead
// writer the same way: why, what is not written, and the way on.
function planWriteRefusedLine(pd: string, written: LeadWrite, what: string, kept: boolean): string {
  const place = planPlaceForShare(pd);
  const repo = keptPlan(pd, activeIdentity(pd).intentId8)?.plan.plan_repo.name ?? ("repo" in place ? place.repo : "the plan's repository");
  const way = `Say when to try again${kept ? "; I have your words" : ""}.`;
  const words = (said: string): string => said.trim().replace(/[.!?]+$/, "");
  if (written.kind === "unreached") {
    return `${repo} could not be reached, so ${what} is not written: ` +
      `${written.words === null ? "it did not answer in time" : `git says "${words(written.words)}"`}. ${way}`;
  }
  if (written.kind === "refused") {
    return `${repo} did not take the change to the plan (${words(written.words)}), so ${what} is not written. Say when to try again, or name another ` +
      `repository the teams can read and I will move the plan there${kept ? "; I have your words" : ""}.`;
  }
  return `The plan in ${repo} kept changing while I wrote on it, so ${what} is not written. ${way}`;
}

// A moved plan whose note cannot be followed here, in the one shape every lead
// writer and the share say it: what was not done (`undone`: "<what> is not
// written", "the plan is not shared") and the caller's own way on (`way`).
// Where the place the note names does not hold the plan, the way on is
// planShareAgainOffer's: a share there when it holds nothing at the plan's ref,
// else on top of the note at `old`, the place the note is at.
export function planShareAgainOffer(follow: Extract<PlanFollow, { kind: "not-followed" }>, old: string): string {
  return follow.holds === "nothing"
    ? `I can share the plan again in ${follow.repo} from your own record here: say if you want that.`
    : `I can share the plan again in ${old}, over the note that it moved, from your own record here: say if you want that.`;
}

// A moved plan whose note cannot be followed at the lead's project, as every
// lead writer says it: its place not read (say when to try again, with the
// lead's words kept when the command has them), or not holding the plan (the
// offer to share it again, and `repo`, the share's --repo for the lead's yes).
function planUnfollowedSay(pd: string, follow: Extract<PlanFollow, { kind: "unread" | "not-followed" }>, what: string, kept: boolean):
  { line: string; repo?: string } {
  const place = planPlaceForShare(pd);
  if (follow.kind === "unread" || !("ref" in place)) {
    return { line: planNotFollowedLine(follow, `${what} is not written`, `Say when to try again${kept ? "; I have your words" : ""}.`) };
  }
  return { line: planNotFollowedLine(follow, `${what} is not written`, planShareAgainOffer(follow, place.repo)), repo: planShareAgainRepo(pd, follow, place) };
}

// What the share that answers planShareAgainOffer names with --repo: where the
// note says when that holds nothing, else where the note is; by the name the
// work's repositories list, else by its address.
export function planShareAgainRepo(pd: string, follow: Extract<PlanFollow, { kind: "not-followed" }>, place: PlanPlace): string {
  const there = follow.holds === "nothing" ? { repo: follow.repo, address: follow.address } : place;
  return planRepos(pd).some((entry) => entry.name === there.repo) ? there.repo : there.address;
}

export function planNotFollowedLine(follow: Extract<PlanFollow, { kind: "unread" | "not-followed" }>, undone: string, way: string): string {
  if (follow.kind === "not-followed") return `The plan of ${follow.label} says it moved, but ${follow.repo} does not hold it, so ${undone}. ${way}`;
  const said = follow.said === null ? "it did not answer in time" : follow.said.trim().replace(/[.!?]+$/, "");
  return `The plan of ${follow.label} moved to ${follow.repo} (${maskUserinfo(follow.address)}), which could not be read (${said}), so ${undone}. ${way}`;
}

// A plan this computer had that is gone from its repository, at the lead's
// project: their yes runs the share, which writes it again.
const planGoneOffer = (plan: PlanJson): string => `${planGoneLine(plan)} I can share it again from your own record here: say if you want that.`;

// The way on over a plan tip that is not a plan, at the lead's project: their
// yes runs the share, which writes over it.
const SHARE_AGAIN_OVER = "I can share the plan again from your own record here, as a new commit over what is there: say if you want that.";

// The agent's step for a lead's word that waits on the share again: one
// instruction for one turn, the share first, then the word with the lead's own
// words; a share that does not go is the answer.
function shareThenWord(word: string, repo?: string, whose = "the word's"): string {
  return `When the person says yes, run \`${aidlcInvocation()} unit share --plan${repo === undefined ? "" : ` --repo ${shellArg(repo)}`}\`; once it shares the plan, run \`${word}\` in the same turn, ` +
    `and tell them in plain words what each reports. If the share does not go, its own line is the answer: leave ${whose} command unrun.`;
}

// A lead write that carries no word of theirs (the learnings choice) and did
// not go: its line, once, and the command that writes it when tried again (the
// share carries the rules); the lead's question first when a change this
// computer did not write stopped it. Null when it went, or there is no plan.
export function planWriteNote(
  projectDir: string,
  written: LeadWrite,
  what: string,
): { line: string; again: string; ask?: ReturnType<typeof planChangeQuestion> } | null {
  const pd = resolveProjectDir(projectDir);
  const again = `${aidlcInvocation()} unit share --plan`;
  if (written.kind === "written" || written.kind === "unchanged" || written.kind === "unshared") return null;
  if (written.kind === "stopped") {
    const ask = planChangeQuestion(written.detail as PlanChange);
    return { line: ask.question, again, ask };
  }
  if (written.kind === "unreadable") {
    return { line: written.format > PLAN_FORMAT ? newerPlanStep(pd) : `${unreadablePlanLine(pd, written.format)} ${SHARE_AGAIN_OVER}`, again };
  }
  if (written.kind === "unfollowed") {
    const said = planUnfollowedSay(pd, written.follow, what, false);
    return { line: said.line, again: said.repo === undefined ? again : `${again} --repo ${shellArg(said.repo)}` };
  }
  return { line: planWriteRefusedLine(pd, written, what, false), again };
}

// A plan tip that does not read: written by a newer AI-DLC (the update
// offer), or not a plan at all.
function unreadablePlanLine(pd: string, format: number): string {
  if (format > PLAN_FORMAT) return newerPlanStep(pd);
  const place = planPlaceForShare(pd);
  return `The plan in ${"repo" in place ? place.repo : "the plan's repository"} could not be read: what is there is not a plan this AI-DLC can read.`;
}

const NO_NOTICE_LINE = "AI-DLC sends no notice of it.";

// The lead's word for a team goes on the plan and nowhere else: said the first
// time in a chat, then left out.
function noNoticeOnce(pd: string): string {
  try {
    const chat = resolveWorkflowSelection(pd).sessionId;
    if (chat) {
      if (personLineHeard(pd, chat, NO_NOTICE_LINE)) return "";
      markPersonLinesHeard(pd, chat, [NO_NOTICE_LINE]);
    }
  } catch {
    // No chat known: said.
  }
  return ` ${NO_NOTICE_LINE}`;
}

// One Unit's word changed by a lead's step, on the plan.
function writeUnitWord(pd: string, view: UnitClaimView, what: string, change: (word: UnitWord) => UnitWord): LeadWrite {
  return leadsPlanWrite(pd, { what, words: (unit, word) => unit === view.unit ? change(wordForTake(word, view)) : null });
}

// The lead's Build and Test found a Unit a team built wanting: it goes back to
// that team in the failure's words, a turn-down from Build and Test, on the
// plan. While it holds, the Unit reads with no result and not done, and
// UNIT_SENT_BACK sets aside its earlier merge here, so it waits for the team and
// its next merge is recorded again.
function sendBack(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit) fail(`usage: ${unitUsage("send-back")}`);
  const pd = resolveProjectDir(projectDir);
  // The failure, in the words the agent showed the person, is what the team
  // hears; the lead's own word to send it back goes on the row.
  const failure = personWordsOf(pd, flags);
  const lead = leadsWord(pd, flags, "Sending a Unit back");
  const live = leadsRecordNow(pd, unit);
  if (live?.status !== "claimed" || (!live.payload.result && !live.payload.done)) fail(`${unit} has no result from a team to send back.`);
  const heads = resultHeads(live.payload);
  const sent = writeUnitWord(pd, live, `${unit} sent back`, ({ done: _done, verdicts: _verdicts, ...word }) => ({
    ...word, turned_down: { repo: "", heads, words: failure.trim(), at: isoTimestamp(), from: "build-and-test" },
  }));
  failUnlessWritten(pd, sent, `${unit}'s send-back`, lead.fields["Message Id"]);
  appendAuditEntry("UNIT_SENT_BACK", {
    Unit: unit, Owner: live.owner, "Attempt Generation": String(live.generation), ...(failure ? { Failure: failure } : {}),
    ...lead.fields,
  }, pd);
  console.log(JSON.stringify({
    unit,
    notice: withPlanNotes(`${unit} is sent back from your Build and Test, with your words. Written on the plan.${noNoticeOnce(pd)} ` +
      `Build and Test waits here for a new push of ${unit}; nothing of it is rebuilt here.`),
  }));
}

// The lead turned a Unit's repo down: their words go on the plan, and the team
// reads them at its next step.
function turnedDown(args: string[], projectDir?: string): void {
  const { positional, flags } = parseArgs(args);
  const unit = positional[0];
  if (!unit || !flags.repo) fail(`usage: ${unitUsage("turned-down")}`);
  const pd = resolveProjectDir(projectDir);
  // The team hears the words the agent relays; the lead's typed words, from
  // the message store, stay on the plan beside them, read by no line.
  const words = personWordsOf(pd, flags);
  const lead = leadsWord(pd, flags, "A turn-down");
  const said = lead.said;
  const live = leadsRecordNow(pd, unit);
  if (live?.status !== "claimed" || !live.payload.result) fail(`${unit} has no result from its team to turn down.`);
  const heads = resultHeads(live.payload);
  const sent = writeUnitWord(pd, live, `${unit} turned down in ${flags.repo}`, (word) => ({
    ...word,
    turned_down: { repo: flags.repo!, heads, words: words.trim(), at: isoTimestamp(), ...(said !== null ? { person_reply: said } : {}) },
  }));
  failUnlessWritten(pd, sent, `${unit}'s turn-down in ${flags.repo}`, lead.fields["Message Id"]);
  console.log(JSON.stringify({ unit, notice: withPlanNotes(`Written on the plan: ${unit} turned down in ${flags.repo}, with your words.${noNoticeOnce(pd)}`) }));
}

// The lead says a repo merged the Unit where the merge check cannot see it (a
// change made again by hand, a branch merged elsewhere): their words go on the
// plan with the verdicts and done they make, in one write.
function saidMerged(args: string[], projectDir?: string): void {
  const { positional, flags, bareFlags, blankFlags } = parseArgs(args);
  const unit = positional[0];
  if (!unit || !flags.repo) fail(`usage: ${unitUsage("merged")}`);
  const pd = resolveProjectDir(projectDir);
  // At a team's own build there is no claim of its result to write on: the
  // lead's project checks the repos itself.
  if (unitBuildOf(readStateFile(pd)) !== null) {
    fail("Only the lead can count a merge git cannot see: it is their word on the plan. Nothing was written here.");
  }
  // A pull request named as the Unit's build: a whole number, or nothing is
  // written or counted (never the word that it merged).
  const asked = flags["pull-request"] !== undefined || bareFlags.has("pull-request") || blankFlags.has("pull-request");
  const number = !asked ? null : /^[1-9]\d*$/.test(String(flags["pull-request"] ?? "")) ? Number(flags["pull-request"]) : 0;
  if (number === 0) fail(`usage: ${unitUsage("merged")}`);
  const given = personWordsOf(pd, flags);
  const lead = leadsWord(pd, flags, "That it merged");
  const words = lead.said ?? given;
  if (number !== null) {
    saidPullRequest(pd, unit, flags.repo, number, words, lead.fields);
    return;
  }
  const live = leadsRecordNow(pd, unit);
  if (live?.status !== "claimed" || !live.payload.result) {
    saidMergedWithNoRecord(pd, unit, flags.repo, words, lead.fields["Message Id"]);
    return;
  }
  if (!live.payload.result.repos.some((repo) => repo.repo === flags.repo)) {
    fail(`${unit} changed ${joinNames(live.payload.result.repos.map((repo) => repo.repo))}, not ${flags.repo}.`);
  }
  const said_merged = [...(live.payload.said_merged ?? []).filter((entry) => entry.repo !== flags.repo),
    { repo: flags.repo, words, at: isoTimestamp(), ...(resultHeads(live.payload)[flags.repo] ? { head: resultHeads(live.payload)[flags.repo] } : {}) }];
  // The merge check with the lead's word in it, so the word, the verdicts and
  // done go on the plan in one write.
  const counted: UnitClaimView = { ...live, payload: { ...live.payload, said_merged } };
  const verdicts = quietly(() => resultVerdicts(pd, counted.payload, [], { unit }));
  const done = countsDone(allMerged(verdicts), leadSignOffOn(readStateFile(pd)), live.payload);
  const entry = said_merged.at(-1)!;
  // On the word as the tip has it, so a word another computer of the lead's wrote since stays.
  const sent = writeUnitWord(pd, live, `${flags.repo} counted merged for ${unit}`, (word) => ({
    ...word, said_merged: [...(word.said_merged ?? []).filter((said) => said.repo !== entry.repo), entry],
    verdicts: wordVerdicts(live, verdicts), ...(done ? { done: true as const } : {}),
  }));
  failUnlessWritten(pd, sent, `${unit}'s merge in ${flags.repo}`, lead.fields["Message Id"]);
  if (done) recordUnitDone(pd, counted, verdicts);
  const said = `${flags.repo} counts as merged for ${unit}, in your words.`;
  const notMerged = verdicts.filter((verdict) => !verdict.merged).map((verdict) => verdict.repo);
  const notice = done
    ? `${unit} is recorded as merged here.`
    : notMerged.length > 0
      ? `${said} ${joinNames(notMerged)} ${notMerged.length === 1 ? "has" : "have"} not merged it yet, so nothing is recorded here.`
      : said;
  console.log(JSON.stringify({ unit, notice: withPlanNotes(notice) }));
}

// The lead names a pull request as a Unit's build in one repository: the
// number goes on the plan (the Unit's word, one per repository), and the
// Unit counts as merged once git shows that pull request's last head merged
// there; AI-DLC reads no other pull request. With no pushed result it is read
// now and at each later look (namedPullRequestVerdict); a Unit with a pushed
// result keeps its merge check, which then reads that number's head too.
function saidPullRequest(pd: string, unit: string, repo: string, number: number, words: string, fields: Record<string, string>): void {
  const message = fields["Message Id"];
  const entry: NamedPullRequest = { repo, number, words, at: isoTimestamp() };
  const what = `pull request ${number} in ${repo} named as the build of ${unit}`;
  const written = `Written on the plan: pull request ${number} in ${repo} is the build of ${unit}.`;
  const counts = `${unit} counts as merged once git shows that pull request merged in ${repo}.`;
  const named = (word: UnitWord): UnitWord => {
    const next: UnitWord = { ...word, pull_requests: [...(word.pull_requests ?? []).filter((other) => other.repo !== repo), entry] };
    const said = (word.said_merged ?? []).filter((other) => other.repo !== repo);
    if (said.length > 0) next.said_merged = said;
    else delete next.said_merged;
    return next;
  };
  const live = leadsRecordNow(pd, unit);
  if (live?.status === "claimed" && live.payload.result) {
    const sent = writeUnitWord(pd, live, what, (word) => ({ ...named(word), verdicts: (word.verdicts ?? []).filter((verdict) => verdict.repo !== repo) }));
    failUnlessWritten(pd, sent, `${unit}'s pull request in ${repo}`, message);
    console.log(JSON.stringify({ unit, notice: withPlanNotes(`${written} ${counts}`) }));
    return;
  }
  const read = namedPullRequestVerdict(pd, repo, number);
  const signOffOn = leadSignOffOn(readStateFile(pd));
  let waiting: NamedPullRequest[] = [];
  let done = false;
  let verdicts: NonNullable<UnitWord["verdicts"]> = [];
  // What this naming takes the place of, where the Unit was counted merged.
  let wasDone = false;
  let before: { number?: number; byWord: boolean } = { byWord: false };
  const sent = leadsPlanWrite(pd, {
    what,
    words: (other, tip) => {
      if (other !== unit) return null;
      // A take not pushed yet: the word is for that take, as every word of the lead's on it is.
      const word = live?.status === "claimed" ? wordForTake(tip, live) : tip;
      const { done: had, verdicts: _before, signoff, ...next } = named(word);
      wasDone = had === true;
      const was = word.pull_requests?.find((pr) => pr.repo === repo)?.number;
      before = { number: was === number ? undefined : was, byWord: (word.said_merged ?? []).some((said) => said.repo === repo) };
      verdicts = [...(word.verdicts ?? []).filter((verdict) => verdict.repo !== repo),
        ...(read.kind === "merged" ? [{ repo, merged: true, commit: read.commit, how: read.how }] : [])];
      waiting = (next.pull_requests ?? []).filter((pr) => !verdicts.some((verdict) => verdict.repo === pr.repo && verdict.merged));
      // A sign-off was given for the build it counted; a merge taken back takes it with it, as open-again does.
      const kept = wasDone && (before.number !== undefined || before.byWord || waiting.length > 0) ? undefined : signoff;
      done = waiting.length === 0 && (!signOffOn || kept !== undefined);
      return { ...next, ...(kept === undefined ? {} : { signoff: kept }), ...(verdicts.length > 0 ? { verdicts } : {}), ...(done ? { done: true as const } : {}) };
    },
  });
  failUnlessWritten(pd, sent, `${unit}'s pull request in ${repo}`, message);
  const generation = live?.status === "claimed" ? live.generation : 0;
  // The right number in place of a counted merge: that merge no longer stands, and this one counts once git shows it.
  const takenBack = wasDone && (!done || before.number !== undefined || before.byWord);
  const after = takenBack ? mergeTakenBack(pd, unit, generation, fields) : "";
  if (done) recordNamedDone(pd, unit, verdicts.filter((verdict) => verdict.merged), generation);
  const plan = keptPlan(pd, activeIdentity(pd).intentId8)?.plan ?? null;
  const address = repoCloneable(pd, repo) || (plan?.repos.find((entry) => entry.name === repo)?.address ?? null) !== null;
  const prs = (list: NamedPullRequest[]): string => joinNames(list.map((pr) => `pull request ${pr.number} in ${pr.repo}`));
  const instead = before.number !== undefined ? `, in place of pull request ${before.number}`
    : before.byWord ? `, in place of your word that ${repo} merged it` : "";
  const notice = takenBack
    ? (read.kind === "merged"
      ? `Written on the plan: pull request ${number} in ${repo} is the build of ${unit}${instead}, and git shows pull request ${number} merged ` +
        `in ${repo} at ${read.commit.slice(0, 7)} "${read.subject}".${done ? ` ${unit} is recorded as merged here.` : ""}`
      : `Written on the plan: pull request ${number} in ${repo} is the build of ${unit}${instead}, and ${unit} is no longer counted merged. ` +
        `${unit} counts as merged once git shows pull request ${number} merged in ${repo}.`) + after
    : read.kind === "merged"
    ? `Written on the plan: pull request ${number} in ${repo} is the build of ${unit}, and git shows it merged in ${repo} at ` +
      `${read.commit.slice(0, 7)} "${read.subject}".` +
      (done ? ` ${unit} is recorded as merged here.`
        : waiting.length > 0 ? ` P${prs(waiting).slice(1)} ${waiting.length === 1 ? "is" : "are"} not merged yet, so nothing is recorded here.` : "")
    : read.kind === "not-cloned"
      ? `${written} ${repo} is not cloned in this workspace, so I cannot read that pull request yet` +
        (address ? `. Say if you want me to clone ${repo} here; the next step then reads it.` : "; once it is cloned here, the next step reads it.")
    : read.kind === "none"
      ? `${written} But ${repo} has no pull request ${number} that git can read, so ${unit} is not counted merged by it. ` +
        `If the number is wrong, give me the right one; if ${unit} is merged some other way, say so.`
    : `${written} ${counts}`;
  console.log(JSON.stringify({ unit, notice: withPlanNotes(notice) }));
}

// The pull requests the lead named as each Unit's build, as the plan this
// computer keeps has them; empty where the plan is not here.
export function namedPullRequests(projectDir: string): Map<string, NamedPullRequest[]> {
  const named = new Map<string, NamedPullRequest[]>();
  try {
    for (const entry of keptPlan(projectDir, activeIdentity(projectDir).intentId8)?.plan.units ?? []) {
      const list = (entry.word as UnitWord).pull_requests ?? [];
      if (list.length > 0) named.set(entry.name, list);
    }
  } catch {
    // No work selected here: nothing named.
  }
  return named;
}

// The Units done through a pull request the lead named, with no pushed result
// of a team's: their own outputs (a code summary, test instructions) are in
// no record here.
export function namedOnlyDone(projectDir: string): Array<{ unit: string; pulls: NamedPullRequest[] }> {
  try {
    const claims = cachedClaims(projectDir);
    return (keptPlan(projectDir, activeIdentity(projectDir).intentId8)?.plan.units ?? []).flatMap((entry) => {
      const word = entry.word as UnitWord;
      const claim = claims.get(entry.name);
      const pushed = claim?.status === "claimed" && claim.payload.result !== undefined;
      return word.done === true && (word.pull_requests ?? []).length > 0 && !pushed ? [{ unit: entry.name, pulls: word.pull_requests! }] : [];
    });
  } catch {
    return [];
  }
}

// The offer to clone a repository the lead named a pull request in that this
// workspace has no checkout of: a build's own clone offer (likelyReposNotHere),
// with the address this workspace's list or the plan gives. Null with none.
export function namedCloneOffer(projectDir: string): { question: string; choices: Array<{ label: string; command?: string }> } | null {
  const pd = resolveProjectDir(projectDir);
  const repos = [...new Set([...namedPullRequests(pd).values()].flat().map((pr) => pr.repo))].filter((repo) => repo !== ".");
  if (repos.length === 0) return null;
  const plan = keptPlan(pd, activeIdentity(pd).intentId8)?.plan ?? null;
  const addresses = new Map((plan?.repos ?? []).flatMap((repo) => (repo.address === null ? [] : [[repo.name, repo.address] as [string, string]])));
  const notThere = likelyReposNotHere(pd, repos, repos, addresses);
  return notThere.offer.offer === undefined ? null : { question: notThere.question.trim(), choices: notThere.offer.offer.choices };
}

// A Unit whose record holds no result (its take or its push never reached its
// record repository): the lead's word alone counts it, against its
// repositories on the plan, and it is done once each of them is counted.
function saidMergedWithNoRecord(pd: string, unit: string, repo: string, words: string, message?: string): void {
  const plan = keptPlan(pd, activeIdentity(pd).intentId8)?.plan ?? null;
  const repos = plan?.units.find((entry) => entry.name === unit)?.repos ?? [];
  if (repos.length === 0) fail(`${unit} has no result from its team to count merged.`);
  if (!repos.includes(repo)) fail(`${unit} changed ${joinNames(repos)}, not ${repo}.`);
  const signOffOn = leadSignOffOn(readStateFile(pd));
  let counted: string[] = [];
  let done = false;
  const sent = leadsPlanWrite(pd, {
    what: `${repo} counted merged for ${unit}`,
    words: (other, word) => {
      if (other !== unit) return null;
      const said_merged = [...(word.said_merged ?? []).filter((said) => said.repo !== repo), { repo, words, at: isoTimestamp() }];
      counted = said_merged.map((said) => said.repo);
      done = repos.every((name) => counted.includes(name)) && (!signOffOn || word.signoff !== undefined);
      return { ...word, said_merged, ...(done ? { done: true as const } : {}) };
    },
  });
  failUnlessWritten(pd, sent, `${unit}'s merge in ${repo}`, message);
  if (done) {
    withAuditLock(pd, () => {
      if (unitMergesStanding(readAuditShardEvents(pd), unit).length > 0) return;
      appendAuditEntryUnlocked("UNIT_MERGED", {
        Unit: unit, Owner: "", "Built By": "", "Merged In": counted.map((name) => `${name} (by your word)`).join(", "), "Attempt Generation": "0",
      }, pd);
    });
  }
  const notMerged = repos.filter((name) => !counted.includes(name));
  const said = `${repo} counts as merged for ${unit}, in your words.`;
  const notice = done ? `${unit} is recorded as merged here.`
    : notMerged.length > 0 ? `${said} ${joinNames(notMerged)} ${notMerged.length === 1 ? "has" : "have"} not merged it yet, so nothing is recorded here.`
    : said;
  console.log(JSON.stringify({ unit, notice: withPlanNotes(notice) }));
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
  // The lead's list: the plan's, as this workspace's copy has it; the lead's own repos.json where its work is here.
  const copy = isGitAddress(build.homeLocation) ? copyOf(build.homeLocation, planRecordRef(idSuffix(build.homeWork))) : null;
  const kept = copy === null ? null : planAtCopy(pd, copy, { commit: planCommitOf(pd, copy) });
  const addresses = kept?.kind === "read"
    ? new Map(kept.plan.repos.flatMap((repo) => (repo.address === null ? [] : [[repo.name, repo.address] as [string, string]])))
    : leadRepoAddresses(pd, auditBlockField(readAuditShardEvents(pd).findLast((row) => row.event === "UNIT_TAKEN_IN")?.block ?? "", "Home Commit"));
  const notThere = likelyReposNotHere(pd, unitLikelyRepos(pd).get(build.unit) ?? [], intentRepos(pd), addresses);
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
            command: `${aidlcToolInvocation("utility")} intent add-repo ${shellArg(repo)} --url ${shellSingleQuote(leadAddresses.get(repo)!)}`,
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
  // No remote is the work's (none, or several and none of them origin): no
  // take can switch it, so nothing is looked at, as soloElsewhereAsk offers none.
  const location = workspaceHomeLocation(projectDir);
  if (location === null || location === "local") return null;
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
    refreshHomeClaims(projectDir, { home: { id8: activeIdentity(projectDir).intentId8 }, sessionId, now: fresh });
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
  if (taken.length === 0) return null;
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
  // Teams read the setting from the plan: once it is shared, the plan carries
  // it now. A write that does not go leaves the setting here, and every lead
  // write after it carries it (leadsPlanWrite).
  let unwritten: string | null = null;
  if (homeLocation(readStateFile(pd)) !== null) {
    let sent: LeadWrite;
    try {
      sent = leadsPlanWrite(pd, { what: `lead sign-off ${value}`, take: { settings: [LEAD_SIGNOFF_FIELD] } });
    } catch (error) {
      if (error instanceof GitWriteRefused) throw error;
      sent = { kind: "refused", words: errorMessage(error), byRule: false };
    }
    if (sent.kind === "stopped" || (sent.kind === "unfollowed" && sent.follow.kind === "not-followed")) failUnlessWritten(pd, sent, "the sign-off setting");
    if (sent.kind === "unreadable") unwritten = unreadablePlanLine(pd, sent.format);
    else if (sent.kind === "unfollowed") {
      unwritten = `${planUnfollowedSay(pd, sent.follow, "the sign-off setting", false).line} The sign-off setting is changed here only; the plan gets it with my next write to it.`;
    } else if (sent.kind !== "written" && sent.kind !== "unchanged" && sent.kind !== "unshared") {
      unwritten = `${planWriteRefusedLine(pd, sent, "the sign-off setting", false)} The sign-off setting is changed here only; the plan gets it with my next write to it.`;
    }
  }
  console.log(JSON.stringify({
    lead_sign_off: value,
    notice: withPlanNotes(unwritten ?? (value === "on"
      ? "Each team's result now waits for your sign-off before its Unit counts as done."
      : "A team's Unit counts as done once every repo it changed has merged; no sign-off is asked.")),
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
  const live = leadsRecordNow(pd, unit);
  if ((live?.status !== "claimed" || !live.payload.result) && (namedPullRequests(pd).get(unit) ?? []).length > 0) {
    signOffNamed(pd, unit, flags, given);
    return;
  }
  if (live?.status !== "claimed" || !live.payload.result) fail(`${unit} has no result from its team to sign off.`);
  const lead = leadsWord(pd, flags, "The sign-off", "unit-signoff");
  const words = lead.said ?? given;
  const sent = writeUnitWord(pd, live, `${unit} signed off`, (word) => ({ ...word, signoff: { words, at: isoTimestamp() } }));
  failUnlessWritten(pd, sent, `${unit}'s sign-off`, lead.fields["Message Id"]);
  appendAuditEntry("QUESTION_ANSWERED", {
    Question: `Sign off ${unit} from ${builderOf(live)}`, Answer: "Sign it off", [QUESTION_TYPE_FIELD]: "unit-signoff", ...lead.fields,
  }, pd);
  const merged = (live.payload.verdicts ?? []).length > 0 && live.payload.verdicts!.every((verdict) => verdict.merged);
  console.log(JSON.stringify({
    unit,
    notice: withPlanNotes(merged
      ? `Signed off ${unit}; every repo it changed has merged, so it is done.`
      : `Signed off ${unit}; it counts as done once every repo it changed has merged.`),
  }));
}

// The lead's sign-off of a Unit whose build is a pull request they named: on
// its word on the plan, done there at once when every named one is merged.
function signOffNamed(pd: string, unit: string, flags: Record<string, string>, given: string): void {
  const lead = leadsWord(pd, flags, "The sign-off", "unit-signoff");
  const words = lead.said ?? given;
  let merged = false;
  let verdicts: NonNullable<UnitWord["verdicts"]> = [];
  const sent = leadsPlanWrite(pd, {
    what: `${unit} signed off`,
    words: (other, word) => {
      if (other !== unit) return null;
      verdicts = (word.verdicts ?? []).filter((verdict) => verdict.merged);
      merged = (word.pull_requests ?? []).every((pr) => verdicts.some((verdict) => verdict.repo === pr.repo));
      return { ...word, signoff: { words, at: isoTimestamp() }, ...(merged ? { done: true as const } : {}) };
    },
  });
  failUnlessWritten(pd, sent, `${unit}'s sign-off`, lead.fields["Message Id"]);
  appendAuditEntry("QUESTION_ANSWERED", {
    Question: `Sign off ${unit}`, Answer: "Sign it off", [QUESTION_TYPE_FIELD]: "unit-signoff", ...lead.fields,
  }, pd);
  const live = leadsRecordNow(pd, unit);
  if (merged) recordNamedDone(pd, unit, verdicts, live?.status === "claimed" ? live.generation : 0);
  console.log(JSON.stringify({
    unit,
    notice: withPlanNotes(merged
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
  invokedArgs = [...argv];
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
    else if (command === "plan-change") planChangeAnswer(args, projectDir);
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
    else if (command === "commit-record") commitRecord(args, projectDir);
    else if (command === "catch-up") catchUp(projectDir);
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
      // The claims are a Map, which JSON would write as {}: the nonce a release
      // takes (--expect-nonce) is read from here.
      const overview = unitClaimOverview(resolveProjectDir(projectDir));
      console.log(JSON.stringify({ ...overview, claims: Object.fromEntries(overview.claims) }, null, 2));
    } else {
      fail(`Usage: ${aidlcInvocation()} unit <${[...UNIT_VERBS.keys()].join("|")}> ...`);
    }
    // The command did its work: the request file its words came in is spent.
    spendWordsFile?.();
  } catch (error) {
    console.error(JSON.stringify({
      error: errorMessage(error),
      ...(error instanceof CandidateExactPolicyError ? { candidate_exact: error.details } : {}),
      ...(error instanceof LeadWordUnwritten
        ? error.onYes !== undefined ? { on_yes: error.onYes }
        : error.ask === undefined ? { again: error.again } : { ask_type: "lead-plan-change", choices: error.ask.choices, after_answer: error.again }
        : {}),
    }));
    process.exit(1);
  }
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
