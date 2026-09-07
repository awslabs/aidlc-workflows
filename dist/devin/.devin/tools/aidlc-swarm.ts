// Swarm convergence referee — the deterministic verdict surface the conductor consults.
//
// The swarm fires only under human-granted Construction autonomy, inside a live
// Claude Code session. That session — the conductor — owns the fan-out (N parallel
// Task calls, or an inline Dynamic Workflow when AIDLC_USE_SWARM=1) and the retry
// loop. A bun subprocess cannot issue Task calls, so the worker-dispatch layer is
// NOT here. What lives here is everything that must be deterministic: the
// convergence verdict, the anti-tamper guard, the serialised merge-back, the audit
// taxonomy, and the typed failure envelope.
//
// THE SPLIT (three concerns): the conductor owns fan-out + loop drive (knowledge);
// this tool owns the convergence verdict + merge + audit (determinism); the human
// grants autonomy and takes the baton on the envelope (judgement).
//
// THREE STATELESS SUBCOMMANDS (no iteration counter, no persisted state):
//   prepare  --batch <n> --units <a,b,c> [--base <branch>] [--concurrency <n>]
//            [--degraded-from <subagent|ultracode>] [--repo <name>]
//       Fork an isolated git worktree per unit (aidlc-worktree create +
//       aidlc-bolt start --worktree) and emit SWARM_STARTED once for the units
//       whose worktrees were successfully prepared.
//       --repo (P7) selects the sibling repo the batch's worktrees fork inside (a
//       multi-repo intent requires it; single-repo infers the lone repo); the
//       resolved name is forwarded to every aidlc-worktree create + bolt start.
//       The anti-tamper baseline is each worktree's OWN git fork (HEAD) — nothing
//       is stored; check/finalize re-derive the pristine bytes with `git diff
//       --quiet HEAD`. Runs before any worker, so it cannot fold into check.
//       --degraded-from records a loud downgrade (AIDLC_USE_SWARM=1 but the
//       Workflow tool was unavailable, so the conductor ran the subagent floor):
//       emits SWARM_DEGRADED. The driver-SELECTION read (AIDLC_USE_SWARM) is
//       conductor-side — this tool only learns a degrade happened via the flag.
//   check <unit> --check-cmd <cmd> [--test-file <path>]
//       Stateless single-unit verdict: the project's check command (exit 0 = green,
//       the AUTHORITATIVE signal — a worker's own success claim is never trusted)
//       plus an anti-tamper compare of the protected file against its forked-git
//       baseline. Prints {unit, converged, tampered, reason}; exits 0 iff the unit
//       is GENUINELY converged (green AND untampered), non-zero otherwise. Emits
//       no audit — it informs the conductor's retry decision (knowledge), it does
//       not commit anything. Same input → same verdict, however many times called.
//   finalize --batch <n> --units <a,b,c> --claimed <a,b> --check-cmd <cmd>
//            [--test-file <path>] [--reasons <unit>=<reason>,...]
//       The AUTHORITATIVE gate. The conductor's claimed-converged set is an
//       explicit input and the only thing finalize trusts from it. For each
//       claimed unit, RE-RUN the check (green + untampered) and, when the current
//       stage declares a reviewer, require that unit's matching post-BOLT_STARTED
//       REVIEW_COMPLETED receipt before any merge. A unit named in --claimed but
//       red or unreviewed on disk is refused the merge and lands in the failure
//       envelope (the lying-conductor guard). Serialised HOLD-MERGE merge-back of
//       the genuine passes only, then emit the full SWARM_* audit trail + the typed
//       envelope + exit 0/2. --reasons carries the conductor's
//       typed attribution for a DECLINED (unclaimed) unit — unsatisfiable /
//       budget-exhausted / cap-exhausted — recorded faithfully (the conductor
//       judges WHY a unit gave up; the tool only records it, never for a claimed
//       unit, whose reason is always the tool's own re-verify verdict).
//
// WHY STATELESS / NO CAP CONSTANT. "The cap" is three jobs on three concerns — the
// verdict (determinism -> check), the retry decision (knowledge -> the conductor,
// which judges "one more try vs unsatisfiable"), and the runaway backstop
// (determinism -> the harness 8-block Stop-hook ceiling). A per-unit counter here
// would make determinism do the knowledge job and is redundant on the other
// drivers (the ultracode script's cap is its `for`-bound; /goal's is its
// turn-clause). So this tool holds none of it: check is advisory, finalize is
// authoritative (re-verifies at the merge gate), so a red unit cannot merge even
// if the conductor lies or misremembers.
//
// COMPOSES existing tools, does NOT reimplement them:
//   - aidlc-worktree create        -> the isolated git worktree per unit
//   - aidlc-bolt start --worktree  -> state/audit/runtime-graph fork into it
//   - aidlc-bolt complete --merge  -> the AIDLC-data merge back to the base
//   - aidlc-bolt release-merge     -> release the existing per-Bolt HOLD-MERGE
//     lock before a serialised merge (idempotent — safe if never held). The merge
//     phase is serial (a one-at-a-time loop), so only one merge is ever in flight.
//   - aidlc-bolt fail              -> close a failed unit's Bolt lifecycle
//     (BOLT_FAILED paired with the BOLT_STARTED that `start --worktree` emitted).

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  assertNoSymlinkInChainOrThrow,
  auditBlockField,
  auditShardDir,
  boltSlugForUnit,
  filterProducesByKind,
  filteredRawIndexEntries,
  findAllEvents,
  getField,
  isRegularFile,
  latestMainWorkflowStageRunFloor,
  latestMainWorkflowStageRunFloorForProject,
  parseArgs,
  parseSourceListing,
  readAuditShardEvents,
  readUnitSourceManifest,
  readUnitSourceSnapshot,
  readRegularFileNoFollowOrThrow,
  readStateFile,
  recordDir,
  relativeRecordDir,
  reviewArtifactFingerprint,
  reviewArtifactBytesSnapshot,
  reviewCompletionMatchesRequest,
  reviewRequestBindingFromBlock,
  reviewedSourceRef,
  resolveAuditWorktreePath,
  resolveBoltDag,
  resolveConstructionRepo,
  resolveProjectDir,
  resolveStage,
  sourceListingSha256,
  shapeSourceSnapshotIndex,
  terminalReviewVerdict,
  sourceClaimCovers,
  sourceListingEntriesEqual,
  type SourceClaimModel,
  UNBINDABLE_FINGERPRINT,
  validateUnitName,
  worktreeAuditFilePath,
  worktreePath,
  worktreeRuntimeGraphPath,
  workspaceSourceEmbeddedGitPaths,
  workspaceSourceFingerprint as worktreeSourceFingerprint,
  workspaceSourceListing,
  workspaceSourceSnapshotPaths,
  worktreeStateFilePath,
  writeBufferAtomic,
} from "./aidlc-lib.ts";
import { compiledExecutable } from "./aidlc-runtime-paths.ts";
import {
  beginCodeGeneration,
  evaluateCodeGenerationApproval,
} from "./aidlc-testing-posture.ts";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

// The typed reason enum the conductor branches on. budget-exhausted stays valid
// for the ultracode driver's token ceiling; cap-exhausted is the loop-ended-
// without-convergence sense; error covers a tamper / lying-claim / plumbing fault.
type FailureReason = "unsatisfiable" | "budget-exhausted" | "cap-exhausted" | "error";

// The driver the conductor degraded away from (records the loud downgrade).
type DriverName = "subagent" | "ultracode";
const DRIVER_VALUES: DriverName[] = ["subagent", "ultracode"];

// The typed reasons the conductor may attribute to a DECLINED unit (one it did
// not claim converged). Judging WHICH applies is the conductor's knowledge call
// (D-I) — the tool only records it, exactly as it records --claimed and
// --degraded-from. `error` is excluded: it is the tool's OWN verdict for a
// claimed-but-red / tampered unit, never a conductor-supplied attribution.
const DECLINED_REASONS: FailureReason[] = ["unsatisfiable", "budget-exhausted", "cap-exhausted"];

interface UnitResult {
  unit: string;
  status: "converged" | "failed";
  reason?: FailureReason;
  detail?: string;
  tampered?: boolean;
}

interface SourceBinding {
  fingerprint: string;
  commit: string;
}

interface ReceiptCheck {
  error: string | null;
  artifactFingerprint?: string;
  sourceFingerprint?: string;
  unitSourceFingerprint?: string;
}

interface ReviewedRecordSnapshotEntry {
  logicalPath: string;
  bytes: Buffer | null;
}

interface ReviewedRecordSnapshot {
  entries: ReviewedRecordSnapshotEntry[];
}

interface SwarmAttemptStamp {
  stage: string;
  floor: string;
}

// --- Sibling-tool composition (synchronous; these calls are quick) ----------

interface ToolRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runTool(toolFile: string, args: string[], projectDir: string): ToolRun {
  const executable = compiledExecutable();
  const noun = toolFile.replace(/^aidlc-/, "").replace(/\.ts$/, "");
  const command = executable
    ? [executable, noun, ...args, "--project-dir", projectDir]
    : [process.execPath, join(TOOLS_DIR, toolFile), "--project-dir", projectDir, ...args];
  const result = spawnSync(command[0], command.slice(1), {
    encoding: "utf-8",
    cwd: projectDir,
    timeout: 60_000,
    env: { ...process.env, AIDLC_PROJECT_DIR: projectDir },
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// --- The deterministic verdict primitives -----------------------------------

// Tool-owned convergence signal. Running the project's check command in the
// worktree (exit 0 = green) is the AUTHORITATIVE green check — a worker's own
// claim of success is never trusted (it could fake a pass).
//
// Run via a shell rather than a hardcoded `bash` argv, because `bash` is ENOENT
// on native Windows PowerShell — the old form launched bash with a -c argument
// and made every convergence check spuriously fail there. We pick the shell so the
// command runs on every platform AND keeps its original interpreter on POSIX:
//   - win32: shell:true → cmd.exe (bash is unavailable; there is no other
//     choice, and a Construction check command on Windows is written for it).
//   - POSIX with /bin/bash present: shell:"/bin/bash" → preserves the exact
//     bash interpreter the old code used, so a bash-only check command
//     (`[[ ]]`, process substitution, arrays) keeps working. Bare shell:true
//     would route through /bin/sh, which on dash-default distros (Debian/Ubuntu)
//     would regress those bashisms — so we keep bash where it exists.
//   - POSIX without /bin/bash: shell:true → /bin/sh (best available).
// Exit-code semantics (0 = converged) and the 60s timeout are unchanged across
// all three.
//
// checkCmd is shell-interpreted, so shell metacharacters in it are honoured —
// that is acceptable here: the swarm only fires under human-granted
// Construction autonomy inside a live session, and checkCmd is the user's own
// project check command (a trusted input), not attacker-controlled. (It was
// already shell-interpreted under the old `bash -c` form — no new surface.)
function checkConverged(cwd: string, checkCmd: string): boolean {
  const shell =
    process.platform !== "win32" && existsSync("/bin/bash")
      ? "/bin/bash"
      : true;
  const result = spawnSync(checkCmd, {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
    shell,
  });
  return result.status === 0;
}

// Anti-tamper, re-derived from the worktree's own git fork (stateless): the
// protected file's pristine bytes are its content at HEAD (the fork point), so a
// worker edit shows as a working-tree change. `git diff --quiet HEAD -- <path>`
// exits 0 when unchanged, 1 when changed; any other status (e.g. 128 — path not
// tracked at HEAD) is not a confirmed tamper, so only status 1 trips the guard.
function fileTampered(cwd: string, relPath: string): boolean {
  const result = spawnSync("git", ["diff", "--quiet", "HEAD", "--", relPath], {
    cwd,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return result.status === 1;
}

interface Verdict {
  exists: boolean;
  converged: boolean;
  tampered: boolean;
  confineError?: string;
}

// Compute a unit's stateless verdict from on-disk state alone. Re-derives the
// worktree path from (projectDir, unit) — no stored handle — so check and
// finalize agree without sharing state.
function verdictFor(
  unit: string,
  projectDir: string,
  checkCmd: string,
  testFile?: string
): Verdict {
  const wt = worktreePath(projectDir, swarmBoltSlug(unit));
  if (!existsSync(wt)) {
    return { exists: false, converged: false, tampered: false };
  }
  const converged = checkConverged(wt, checkCmd);
  let tampered = false;
  let confineError: string | undefined;
  if (testFile) {
    // Confine the path inside the unit's worktree — a `../` escape would point
    // the guard at a file the worker never touched and silently DISABLE it, so
    // reject it as a configuration error rather than ship a false "untampered".
    const candidate = resolve(wt, testFile);
    const root = resolve(wt) + sep;
    if (!candidate.startsWith(root)) {
      confineError = `--test-file resolves outside the unit worktree: ${testFile}`;
    } else {
      tampered = fileTampered(wt, testFile);
    }
  }
  return { exists: true, converged, tampered, confineError };
}

interface ReviewerRequirement {
  stage: string;
  reviewer: string | null;
  reviewClass: "adversarial" | "advisory";
  maxIterations: number;
  error?: string;
}

function reviewerRequirement(projectDir: string): ReviewerRequirement {
  try {
    const stage = getField(readStateFile(projectDir), "Current Stage")?.trim() ?? "";
    if (!stage) {
      return {
        stage: "",
        reviewer: null,
        reviewClass: "adversarial",
        maxIterations: 2,
        error: "cannot resolve reviewer requirement: Current Stage is empty",
      };
    }
    const definition = resolveStage(stage);
    if (!definition) {
      return {
        stage,
        reviewer: null,
        reviewClass: "adversarial",
        maxIterations: 2,
        error: `cannot resolve reviewer requirement: stage "${stage}" is absent from the stage graph`,
      };
    }
    const reviewClass = definition.review_class ?? "adversarial";
    return {
      stage,
      reviewer: definition.reviewer?.trim() || null,
      reviewClass,
      maxIterations:
        reviewClass === "advisory"
          ? 1
          : definition.reviewer_max_iterations ?? 2,
    };
  } catch (e) {
    return {
      stage: "",
      reviewer: null,
      reviewClass: "adversarial",
      maxIterations: 2,
      error: `cannot resolve reviewer requirement: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// A claimed autonomous unit must prove its configured review happened inside
// this Bolt attempt. BOLT_STARTED is a stronger floor than STAGE_STARTED here:
// it excludes a matching receipt inherited from main when prepare forked the
// worktree, while preserving a receipt across a merge retry on that worktree.
function reviewerReceiptError(
  projectDir: string,
  unit: string,
  stage: string,
  reviewer: string,
  reviewClass: "adversarial" | "advisory",
  maxIterations: number,
): ReceiptCheck {
  const boltSlug = swarmBoltSlug(unit);
  const wt = worktreePath(projectDir, boltSlug);
  const creationRows = readAuditShardEvents(projectDir)
    .filter(
      (row) =>
        row.event === "WORKTREE_CREATED" &&
        auditBlockField(row.block, "Bolt slug") === boltSlug &&
        (
          auditBlockField(row.block, "Worktree path") !== null &&
          resolveAuditWorktreePath(
            projectDir,
            auditBlockField(row.block, "Worktree path") as string,
          ) === wt
        ),
    )
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shard === b.shard) return a.pos - b.pos;
      return a.shard < b.shard ? -1 : 1;
    });
  const creationBlock = creationRows.at(-1)?.block ?? null;
  const creationBaseCommit = creationBlock === null
    ? null
    : auditBlockField(creationBlock, "Base commit");
  const creationBaseListing = creationBlock === null
    ? null
    : auditBlockField(creationBlock, "Base Source Listing");
  const creationModern = creationBaseCommit !== null || creationBaseListing !== null;

  const relevant = new Set([
    "BOLT_STARTED",
    "REVIEW_REQUESTED",
    "REVIEW_COMPLETED",
  ]);
  const events = readAuditShardEvents(wt)
    .filter((event) => relevant.has(event.event))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shard === b.shard) return a.pos - b.pos;
      return a.shard < b.shard ? -1 : 1;
    });
  const crossShardTied = (index: number): boolean =>
    events.some(
      (candidate, other) =>
        other !== index &&
        candidate.timestamp === events[index].timestamp &&
        candidate.shard !== events[index].shard,
    );

  let boltStart = -1;
  for (let i = 0; i < events.length; i++) {
    if (
      events[i].event === "BOLT_STARTED" &&
      auditBlockField(events[i].block, "Bolt slug") === boltSlug
    ) {
      if (crossShardTied(i)) {
        let end = i;
        while (end + 1 < events.length && events[end + 1].timestamp === events[i].timestamp) end++;
        boltStart = end;
        i = end;
      } else {
        boltStart = i;
      }
    }
  }
  if (boltStart === -1) {
    return {
      error: `claimed converged but worktree audit has no BOLT_STARTED boundary for unit "${unit}"`,
    };
  }

  const boltStartBlock = events[boltStart].block;
  const baseCommit = auditBlockField(boltStartBlock, "Base commit");
  const baseSourceListing = auditBlockField(boltStartBlock, "Base Source Listing");
  if (
    creationModern &&
    (baseCommit !== creationBaseCommit || baseSourceListing !== creationBaseListing)
  ) {
    return {
      error: `claimed converged but modern WORKTREE_CREATED attestation was not propagated to BOLT_STARTED for unit "${unit}"`,
    };
  }
  let verifiedBaseListing: Map<string, string> | null = null;
  if (baseCommit !== null) {
    const metaPath = join(wt, ".aidlc", "worktree-meta.json");
    let meta: unknown;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    } catch {
      return { error: `claimed converged but worktree base-commit metadata is missing or malformed for unit "${unit}"` };
    }
    if (
      typeof meta !== "object" || meta === null || Array.isArray(meta) ||
      (meta as Record<string, unknown>).baseCommit !== baseCommit ||
      baseSourceListing === null ||
      (meta as Record<string, unknown>).baseSourceListing !== baseSourceListing
    ) {
      return { error: `claimed converged but worktree Base commit/source listing does not match its BOLT_STARTED attestation for unit "${unit}"` };
    }
    const listingPath = join(wt, ".aidlc", "base-source-listing.tsv");
    let serialized: string;
    try {
      serialized = readFileSync(listingPath, "utf-8");
    } catch {
      return { error: `claimed converged but worktree base source listing is missing for unit "${unit}"` };
    }
    if (`sha256:${sourceListingSha256(serialized)}` !== baseSourceListing) {
      return { error: `claimed converged but worktree base source listing hash does not match for unit "${unit}"` };
    }
    verifiedBaseListing = parseSourceListing(serialized);
    if (verifiedBaseListing === null) {
      return { error: `claimed converged but worktree base source listing is malformed for unit "${unit}"` };
    }
  }

  const pendingRequests = new Map<
    string,
    {
      binding: ReturnType<typeof reviewRequestBindingFromBlock>;
      recovery: boolean;
      timestamp: string;
      shard: string;
    }
  >();
  let latestTerminal:
    | {
        block: string;
        binding: NonNullable<
          ReturnType<typeof reviewRequestBindingFromBlock>
        >;
      }
    | null = null;
  for (let i = boltStart + 1; i < events.length; i++) {
    const event = events[i];
    if (
      event.event !== "REVIEW_REQUESTED" &&
      event.event !== "REVIEW_COMPLETED"
    ) {
      continue;
    }
    if (auditBlockField(event.block, "Workflow")?.startsWith("single-stage:")) continue;
    if (auditBlockField(event.block, "Stage") !== stage) continue;
    if (auditBlockField(event.block, "Reviewer") !== reviewer) continue;
    if (auditBlockField(event.block, "Unit") !== unit) continue;
    const iteration = auditBlockField(event.block, "Iteration");
    if (!iteration || !/^[1-9][0-9]*$/.test(iteration)) continue;
    const requestKey = `${unit}\u0000${iteration}`;
    if (event.event === "REVIEW_REQUESTED") {
      if (crossShardTied(i)) continue;
      const binding = reviewRequestBindingFromBlock(event.block);
      if (binding === null) continue;
      pendingRequests.set(requestKey, {
        binding,
        recovery: auditBlockField(event.block, "Recovery") === "stale-receipt",
        timestamp: event.timestamp,
        shard: event.shard,
      });
      continue;
    }
    if (crossShardTied(i)) {
      pendingRequests.delete(requestKey);
      continue;
    }
    const request = pendingRequests.get(requestKey);
    if (
      request === undefined ||
      (request.timestamp === event.timestamp && request.shard !== event.shard) ||
      !request.binding ||
      !reviewCompletionMatchesRequest(request.binding, event.block)
    ) {
      continue;
    }
    pendingRequests.delete(requestKey);
    const rawVerdict = auditBlockField(event.block, "Verdict");
    const verdict = request.recovery
      ? rawVerdict === "READY" || rawVerdict === "NOT-READY"
        ? rawVerdict
        : null
      : terminalReviewVerdict(rawVerdict, iteration, reviewClass, maxIterations);
    if (verdict !== null) {
      latestTerminal = {
        block: event.block,
        binding: request.binding,
      };
    }
  }

  if (latestTerminal === null) {
    return {
      error:
        `claimed converged but no terminal REVIEW_COMPLETED for stage "${stage}", ` +
        `unit "${unit}", reviewer "${reviewer}" exists after this Bolt started`,
    };
  }

  const definition = resolveStage(stage);
  const recordedArtifactFp = auditBlockField(latestTerminal.block, "Artifact Fingerprint");
  const currentArtifactFp = definition
    ? reviewArtifactFingerprint(wt, definition, unit, {
        requireRequiredArtifacts: true,
      })
    : null;
  if (
    recordedArtifactFp === null ||
    !/^sha256:[0-9a-f]{64}$/.test(recordedArtifactFp) ||
    currentArtifactFp === null ||
    recordedArtifactFp !== currentArtifactFp
  ) {
    return {
      error:
        `claimed converged but no terminal REVIEW_COMPLETED for stage "${stage}", ` +
        `unit "${unit}", reviewer "${reviewer}" with a current artifact fingerprint exists after this Bolt started`,
    };
  }

  if (!definition?.workspace_requires) {
    return { error: null, artifactFingerprint: recordedArtifactFp };
  }
  const recordedSourceFp = auditBlockField(latestTerminal.block, "Source Fingerprint");
  if (process.env.AIDLC_SKIP_SOURCE_FRESHNESS === "1") {
    return { error: null, artifactFingerprint: recordedArtifactFp };
  }
  if (recordedSourceFp === null) {
    if (baseCommit === null) {
      return { error: null, artifactFingerprint: recordedArtifactFp };
    }
    return {
      error:
        `claimed converged but modern worktree unit "${unit}" has no Source Fingerprint; ` +
        `re-run the reviewer in the worktree and record a fresh verdict before finalizing`,
    };
  }
  const currentSourceFp = worktreeSourceFingerprint(wt);
  if (
    recordedSourceFp === UNBINDABLE_FINGERPRINT ||
    currentSourceFp === null ||
    currentSourceFp !== recordedSourceFp
  ) {
    return {
      error:
        `claimed converged but the reviewed source no longer matches its worktree's ` +
        `fingerprint for stage "${stage}", unit "${unit}" (source-fingerprint mismatch); ` +
        `re-invoke the reviewer against the current worktree source and record a fresh ` +
        `verdict before finalizing`,
    };
  }

  // Pre-upgrade worktrees have no attested base commit and retain migration
  // fail-open behavior. Modern worktrees must validate the exact unit binding
  // that the reviewer saw before trusting its claims for footprint coverage.
  let unitSourceFingerprint: string | undefined;
  if (baseCommit !== null) {
    const recordedUnitFp = auditBlockField(
      latestTerminal.block,
      "Unit Source Fingerprint",
    );
    const bindingBypass =
      auditBlockField(latestTerminal.block, "Unit Source Binding Bypass") ===
      "true";
    if (bindingBypass || recordedUnitFp === null || recordedUnitFp === UNBINDABLE_FINGERPRINT) {
      return {
        error:
          `claimed converged but unit "${unit}" has no verifiable modern Unit Source Fingerprint; ` +
          `re-run the reviewer in the worktree and record a fresh verdict before finalizing`,
      };
    }
    unitSourceFingerprint = recordedUnitFp;
    const manifest = readUnitSourceManifest(wt, stage, unit, {
      worktreeRelative: true,
    });
    const snapshot = readUnitSourceSnapshot(wt, stage, unit, recordedUnitFp);
    if (
      !manifest.ok ||
      snapshot === null ||
      snapshot.manifestSha256 !== manifest.rawBytesSha256
    ) {
      return {
        error:
          `claimed converged but unit "${unit}"'s reviewed source manifest binding is missing, ` +
          `corrupt, or no longer matches its review; re-run the reviewer in the worktree and ` +
          `record a fresh verdict before finalizing`,
      };
    }
    const reviewedClaims: SourceClaimModel = {
      claims: manifest.claims,
      prefixes: manifest.prefixes,
    };
    const idx = join(tmpdir(), `aidlc-swarm-footprint-${process.pid}-${randomUUID().slice(0, 8)}`);
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    const git = (args: string[]) => spawnSync("git", ["-C", wt, ...args], {
      env,
      encoding: "utf-8",
      maxBuffer: 512 * 1024 * 1024,
    });
    try {
      if (git(["read-tree", "HEAD"]).status !== 0 || git(["add", "-A"]).status !== 0) {
        return { error: `claimed converged but the worktree footprint could not be computed for unit "${unit}"` };
      }
      if (shapeSourceSnapshotIndex(wt, idx, true) === null) {
        return {
          error:
            `claimed converged but the reviewed source boundary could not be applied to unit "${unit}"'s footprint`,
        };
      }
      const tree = git(["write-tree"]);
      if (tree.status !== 0 || !tree.stdout.trim()) return { error: `claimed converged but the worktree footprint tree could not be written for unit "${unit}"` };
      const diff = git([
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        baseCommit,
        tree.stdout.trim(),
      ]);
      if (diff.status !== 0) return { error: `claimed converged but the worktree footprint could not be compared for unit "${unit}"` };
      const outside = new Set(
        diff.stdout
          .split("\0")
          .filter(Boolean),
      );
      const currentListing = workspaceSourceListing(wt);
      if (verifiedBaseListing === null || currentListing === null) {
        return { error: `claimed converged but raw-aware worktree footprint evidence is unavailable for unit "${unit}"` };
      }
      for (const [path, oid] of verifiedBaseListing) {
        if (!sourceListingEntriesEqual(currentListing.get(path), oid)) {
          outside.add(path.slice(path.indexOf("\0") + 1));
        }
      }
      for (const path of currentListing.keys()) {
        if (!verifiedBaseListing.has(path)) outside.add(path.slice(path.indexOf("\0") + 1));
      }
      const outsideClaims = [...outside]
        .filter((path) => !sourceClaimCovers(`\0${path}`, reviewedClaims));
      if (outsideClaims.length > 0) {
        const rendered = outsideClaims.slice(0, 10).join(", ") +
          (outsideClaims.length > 10 ? ` … and ${outsideClaims.length - 10} more` : "");
        return {
          error:
            `claimed converged but the worktree wrote application-source paths outside unit "${unit}"'s ` +
            `source manifest (${rendered}); update construction/${unit}/code-generation/source-manifest.json ` +
            `in the worktree, re-run the reviewer there, and record a fresh verdict before finalizing`,
        };
      }
    } finally {
      rmSync(idx, { force: true });
    }
  }
  return {
    error: null,
    artifactFingerprint: recordedArtifactFp,
    sourceFingerprint: recordedSourceFp,
    unitSourceFingerprint,
  };
}

function captureReviewedRecordSnapshot(
  projectDir: string,
  unit: string,
  stage: NonNullable<ReturnType<typeof resolveStage>>,
  receipt: ReceiptCheck,
): { snapshot?: ReviewedRecordSnapshot; error?: string } {
  const wt = worktreePath(projectDir, swarmBoltSlug(unit));
  const artifacts = reviewArtifactBytesSnapshot(wt, stage, unit, {
    requireRequiredArtifacts: true,
    captureBytes: true,
  });
  if (artifacts === null) {
    return { error: `cannot snapshot required record artifacts for unit "${unit}"` };
  }
  if (
    receipt.artifactFingerprint !== undefined &&
    artifacts.fingerprint !== receipt.artifactFingerprint
  ) {
    return {
      error:
        `record artifacts changed while finalizing unit "${unit}"; ` +
        `re-run the reviewer against the current artifacts`,
    };
  }

  const entries: ReviewedRecordSnapshotEntry[] = [];
  for (const artifact of artifacts.entries) {
    if (artifact.state === "not-file") {
      return {
        error:
          `record artifact ${artifact.logicalPath} for unit "${unit}" is not a regular file`,
      };
    }
    if (artifact.state === "file" && artifact.bytes === undefined) {
      return {
        error: `cannot capture record artifact ${artifact.logicalPath} for unit "${unit}"`,
      };
    }
    entries.push({
      logicalPath: artifact.logicalPath,
      bytes: artifact.state === "file" ? artifact.bytes! : null,
    });
  }

  if (receipt.unitSourceFingerprint !== undefined) {
    const wtRecord = recordDir(wt);
    if (wtRecord === null) {
      return { error: `cannot resolve reviewed source evidence for unit "${unit}"` };
    }
    const manifest = readUnitSourceManifest(wt, stage.slug, unit, {
      worktreeRelative: true,
    });
    const snapshot = readUnitSourceSnapshot(
      wt,
      stage.slug,
      unit,
      receipt.unitSourceFingerprint,
    );
    if (
      !manifest.ok ||
      snapshot === null ||
      snapshot.manifestSha256 !== manifest.rawBytesSha256
    ) {
      return {
        error:
          `reviewed source evidence changed while finalizing unit "${unit}"; ` +
          `re-run the reviewer`,
      };
    }

    const manifestPath = join(
      wtRecord,
      "construction",
      unit,
      stage.slug,
      "source-manifest.json",
    );
    let manifestBytes: Buffer;
    try {
      manifestBytes = readRegularFileNoFollowOrThrow(
        assertNoSymlinkInChainOrThrow(
          realpathSync(wt),
          relative(wt, manifestPath),
        ),
        `source manifest for unit ${unit}`,
      );
    } catch {
      return { error: `cannot capture reviewed source evidence for unit "${unit}"` };
    }
    if (
      createHash("sha256").update(manifestBytes).digest("hex") !==
        manifest.rawBytesSha256
    ) {
      return {
        error:
          `reviewed source evidence changed while finalizing unit "${unit}"; ` +
          `re-run the reviewer`,
      };
    }
    entries.push(
      {
        logicalPath:
          `construction/${unit}/${stage.slug}/source-manifest.json`,
        bytes: manifestBytes,
      },
    );
  }

  return { snapshot: { entries } };
}

function mergeReviewedRecordSnapshot(
  projectDir: string,
  unit: string,
  snapshot: ReviewedRecordSnapshot,
): string | null {
  const record = recordDir(projectDir);
  if (record === null) return `cannot resolve the main record directory for unit "${unit}"`;
  let root: string;
  try {
    root = assertNoSymlinkInChainOrThrow(
      realpathSync(projectDir),
      relative(projectDir, record),
    );
    if (!lstatSync(root).isDirectory()) {
      return `main record path is not a directory for unit "${unit}"`;
    }
  } catch (error) {
    return (
      `cannot validate the main record directory for unit "${unit}": ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }

  const operations: Array<{
    target: string;
    logicalPath: string;
    next: Buffer | null;
    previous: Buffer | null;
  }> = [];
  for (const entry of snapshot.entries) {
    try {
      const target = assertNoSymlinkInChainOrThrow(root, entry.logicalPath);
      const previous = existsSync(target)
        ? readRegularFileNoFollowOrThrow(
            target,
            `existing record artifact ${entry.logicalPath}`,
          )
        : null;
      operations.push({
        target,
        logicalPath: entry.logicalPath,
        next: entry.bytes,
        previous,
      });
    } catch (error) {
      return (
        `record artifact preflight failed for ${entry.logicalPath}: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const applied: typeof operations = [];
  try {
    for (const operation of operations) {
      if (operation.next === null) {
        rmSync(operation.target, { force: true });
        applied.push(operation);
      } else {
        mkdirSync(dirname(operation.target), { recursive: true });
        writeBufferAtomic(operation.target, operation.next);
        applied.push(operation);
        if (
          process.env.AIDLC_TEST === "1" &&
          process.env.AIDLC_TEST_RECORD_VERIFY_FAIL === operation.logicalPath
        ) {
          throw new Error(
            `injected verification failure for ${operation.logicalPath}`,
          );
        }
        if (
          !readRegularFileNoFollowOrThrow(
            operation.target,
            `landed record artifact ${operation.logicalPath}`,
          ).equals(operation.next)
        ) {
          throw new Error(`verification failed for ${operation.logicalPath}`);
        }
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const operation of [...applied].reverse()) {
      try {
        if (operation.previous === null) {
          rmSync(operation.target, { force: true });
        } else {
          mkdirSync(dirname(operation.target), { recursive: true });
          writeBufferAtomic(operation.target, operation.previous);
        }
      } catch (rollbackError) {
        rollbackErrors.push(
          `${operation.logicalPath}: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        );
      }
    }
    return (
      `record artifact transaction failed for unit "${unit}": ` +
      `${error instanceof Error ? error.message : String(error)}` +
      (rollbackErrors.length > 0
        ? `; rollback failed for ${rollbackErrors.join(", ")}`
        : "")
    );
  }
  return null;
}

// Materialize the reviewed application bytes as an immutable commit without
// moving the Bolt branch. The temporary index starts from HEAD, overlays the
// worktree, then restores framework-owned paths from HEAD so the later source
// merge carries application source only. Recompute the fingerprint after the
// object is written to close a concurrent-edit window; the validated value is
// the one carried to the convergence row.
function recoverableSubmoduleUrls(
  repoDir: string,
): Map<string, string> | null {
  const modulesPath = join(repoDir, ".gitmodules");
  if (!existsSync(modulesPath)) return new Map();
  const paths = spawnSync(
    "git",
    [
      "-C",
      repoDir,
      "config",
      "-f",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ],
    { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (paths.status === 1) return new Map();
  if (paths.status !== 0) return null;
  const recoverable = new Map<string, string>();
  for (const line of paths.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(" ");
    if (separator <= 0) return null;
    const key = line.slice(0, separator);
    const path = line.slice(separator + 1).trim().replace(/\\/g, "/");
    if (!key.endsWith(".path") || !path) return null;
    const urlKey = `${key.slice(0, -".path".length)}.url`;
    const url = spawnSync(
      "git",
      ["-C", repoDir, "config", "-f", ".gitmodules", "--get", urlKey],
      { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (url.status !== 0 || !url.stdout.trim()) continue;
    recoverable.set(path, url.stdout.trim());
  }
  return recoverable;
}

function configuredParentRemoteUrl(repoDir: string): string | null {
  const branch = spawnSync(
    "git",
    ["-C", repoDir, "symbolic-ref", "--quiet", "--short", "HEAD"],
    { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (branch.status === 0 && branch.stdout.trim()) {
    const remoteName = spawnSync(
      "git",
      [
        "-C",
        repoDir,
        "config",
        "--get",
        `branch.${branch.stdout.trim()}.remote`,
      ],
      { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (
      remoteName.status === 0 &&
      remoteName.stdout.trim() &&
      remoteName.stdout.trim() !== "."
    ) {
      const remoteUrl = spawnSync(
        "git",
        [
          "-C",
          repoDir,
          "config",
          "--get",
          `remote.${remoteName.stdout.trim()}.url`,
        ],
        { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
      );
      if (remoteUrl.status === 0 && remoteUrl.stdout.trim()) {
        return remoteUrl.stdout.trim();
      }
    }
  }
  const origin = spawnSync(
    "git",
    ["-C", repoDir, "config", "--get", "remote.origin.url"],
    { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
  );
  return origin.status === 0 && origin.stdout.trim()
    ? origin.stdout.trim()
    : null;
}

function resolveRelativeSubmoduleUrl(
  repoDir: string,
  metadataUrl: string,
): string | null {
  if (!metadataUrl.startsWith("./") && !metadataUrl.startsWith("../")) {
    return metadataUrl;
  }
  const parentUrl = configuredParentRemoteUrl(repoDir);
  if (!parentUrl) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(parentUrl)) {
    try {
      const base = parentUrl.endsWith("/") ? parentUrl : `${parentUrl}/`;
      return new URL(metadataUrl, base).toString();
    } catch {
      return null;
    }
  }
  if (
    !/^[A-Za-z]:[\\/]/.test(parentUrl) &&
    /^[^/\\:]+:.+/.test(parentUrl)
  ) {
    const colon = parentUrl.indexOf(":");
    const host = parentUrl.slice(0, colon);
    const remotePath = parentUrl.slice(colon + 1);
    return `${host}:${posix.normalize(`${remotePath}/${metadataUrl}`)}`;
  }
  return resolve(parentUrl, metadataUrl);
}

const NEW_GITLINK_RECOVERY_BUDGET_MS = 30_000;
const NEW_GITLINK_RECOVERY_COMMAND_TIMEOUT_MS = 15_000;
const NEW_GITLINK_RECOVERY_PROOF_CAP = 32;

interface NewGitlinkRecoveryBudget {
  budgetMs: number;
  commandTimeoutMs: number;
  deadlineMs: number | null;
  proofCap: number;
  proofsStarted: number;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  return value && /^[1-9][0-9]*$/.test(value) ? Number(value) : fallback;
}

function newGitlinkRecoveryBudget(): NewGitlinkRecoveryBudget {
  return {
    budgetMs: positiveIntegerEnv(
      "AIDLC_TEST_NEW_GITLINK_RECOVERY_BUDGET_MS",
      NEW_GITLINK_RECOVERY_BUDGET_MS,
    ),
    commandTimeoutMs: positiveIntegerEnv(
      "AIDLC_TEST_NEW_GITLINK_RECOVERY_COMMAND_TIMEOUT_MS",
      NEW_GITLINK_RECOVERY_COMMAND_TIMEOUT_MS,
    ),
    deadlineMs: null,
    proofCap: positiveIntegerEnv(
      "AIDLC_TEST_NEW_GITLINK_RECOVERY_PROOF_CAP",
      NEW_GITLINK_RECOVERY_PROOF_CAP,
    ),
    proofsStarted: 0,
  };
}

function remainingNewGitlinkRecoveryMs(
  budget: NewGitlinkRecoveryBudget,
): number | null {
  if (budget.deadlineMs === null) {
    budget.deadlineMs = Date.now() + budget.budgetMs;
  }
  const remaining = budget.deadlineMs - Date.now();
  return remaining <= 0
    ? null
    : Math.min(budget.commandTimeoutMs, remaining);
}

function newGitlinkRecoveryError(
  repoDir: string,
  subDir: string,
  path: string,
  metadataUrl: string,
  commit: string,
  budget: NewGitlinkRecoveryBudget,
): string | null {
  if (budget.proofsStarted >= budget.proofCap) {
    return `new submodule recovery proof cap exceeded (${budget.proofCap} per finalize)`;
  }
  const lsRemoteTimeout = remainingNewGitlinkRecoveryMs(budget);
  if (lsRemoteTimeout === null) {
    return `new submodule recovery deadline exceeded (${budget.budgetMs}ms cumulative per finalize)`;
  }
  budget.proofsStarted += 1;
  const endpoint = resolveRelativeSubmoduleUrl(repoDir, metadataUrl);
  if (!endpoint) {
    return `cannot resolve .gitmodules recovery URL for new submodule ${path}`;
  }
  if (metadataUrl.startsWith("./") || metadataUrl.startsWith("../")) {
    const origin = spawnSync(
      "git",
      ["-C", subDir, "remote", "get-url", "origin"],
      { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    const normalize = (value: string): string =>
      value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    if (
      origin.status !== 0 ||
      normalize(origin.stdout) !== normalize(endpoint)
    ) {
      return `new submodule ${path} origin does not match its resolved .gitmodules recovery URL`;
    }
  }
  const advertised = spawnSync(
    "git",
    ["ls-remote", endpoint, "HEAD", "refs/heads/*", "refs/tags/*"],
    {
      encoding: "utf-8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 512 * 1024 * 1024,
      timeout: lsRemoteTimeout,
    },
  );
  if (advertised.status !== 0) {
    if (
      budget.deadlineMs !== null &&
      Date.now() >= budget.deadlineMs
    ) {
      return `new submodule recovery deadline exceeded (${budget.budgetMs}ms cumulative per finalize)`;
    }
    return `new submodule ${path} recovery endpoint is unavailable`;
  }
  const advertisedRefs = new Set<string>();
  for (const line of advertised.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [oid, ref] = line.split(/\s+/, 2);
    if (!/^[0-9a-f]{40,64}$/.test(oid) || !ref) continue;
    const baseRef = ref.endsWith("^{}") ? ref.slice(0, -3) : ref;
    if (
      baseRef !== "HEAD" &&
      !baseRef.startsWith("refs/heads/") &&
      !baseRef.startsWith("refs/tags/")
    ) {
      continue;
    }
    if (!ref.endsWith("^{}")) advertisedRefs.add(ref);
  }
  if (advertisedRefs.size === 0) {
    return `new submodule ${path} recovery endpoint advertises no cloneable refs`;
  }
  if (advertisedRefs.size > 10_000) {
    return `new submodule ${path} recovery endpoint advertises too many refs`;
  }
  const recoveryRefspecs = [...advertisedRefs].sort().map((ref) => {
    if (ref === "HEAD") return "+HEAD:refs/aidlc/recovery/HEAD";
    if (ref.startsWith("refs/heads/")) {
      return `+${ref}:refs/aidlc/recovery/heads/${ref.slice("refs/heads/".length)}`;
    }
    return `+${ref}:refs/aidlc/recovery/tags/${ref.slice("refs/tags/".length)}`;
  });
  const recoveryRefspecInput = `${recoveryRefspecs.join("\n")}\n`;
  if (Buffer.byteLength(recoveryRefspecInput, "utf-8") > 1024 * 1024) {
    return `new submodule ${path} recovery endpoint refspecs exceed the size budget`;
  }

  const recoveryRepo = mkdtempSync(
    join(tmpdir(), `aidlc-submodule-recovery-${process.pid}-`),
  );
  try {
    const initialized = spawnSync(
      "git",
      ["-C", recoveryRepo, "init", "--bare", "-q"],
      { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (initialized.status !== 0) {
      return `cannot initialize recovery proof for new submodule ${path}`;
    }
    const fetchTimeout = remainingNewGitlinkRecoveryMs(budget);
    if (fetchTimeout === null) {
      return `new submodule recovery deadline exceeded (${budget.budgetMs}ms cumulative per finalize)`;
    }
    const fetched = spawnSync(
      "git",
      [
        "-C",
        recoveryRepo,
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--filter=blob:none",
        "--stdin",
        endpoint,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        input: recoveryRefspecInput,
        maxBuffer: 512 * 1024 * 1024,
        timeout: fetchTimeout,
      },
    );
    if (fetched.status !== 0) {
      if (
        budget.deadlineMs !== null &&
        Date.now() >= budget.deadlineMs
      ) {
        return `new submodule recovery deadline exceeded (${budget.budgetMs}ms cumulative per finalize)`;
      }
      return `cannot fetch advertised recovery history for new submodule ${path}`;
    }
    const recovered = spawnSync(
      "git",
      ["-C", recoveryRepo, "cat-file", "-e", `${commit}^{commit}`],
      { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (recovered.status === 0) return null;
  } finally {
    rmSync(recoveryRepo, { recursive: true, force: true });
  }
  return `new submodule ${path} commit ${commit} is not reachable from an advertised recovery ref`;
}

function initializedSubmoduleSourceError(
  subDir: string,
  displayPath: string,
  visited: Set<string>,
  depth = 1,
): string | null {
  if (depth > 64) {
    return `cannot verify initialized submodule ${displayPath}: nesting exceeds 64 levels`;
  }
  let real: string;
  try {
    real = realpathSync(subDir);
  } catch {
    return `cannot resolve initialized submodule ${displayPath}`;
  }
  if (visited.has(real)) return null;
  visited.add(real);
  if (visited.size > 10_000) {
    return "cannot verify initialized submodules: more than 10000 checkouts are materialized";
  }

  const status = spawnSync(
    "git",
    [
      "-C",
      subDir,
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ],
    { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (status.status !== 0) {
    return `cannot verify reviewed submodule state for ${displayPath}`;
  }
  if (status.stdout.length > 0) {
    return (
      `cannot bind dirty initialized submodule ${displayPath}; commit or discard its reviewed ` +
      "changes, then re-run the reviewer before finalizing"
    );
  }

  const sourcePaths = workspaceSourceSnapshotPaths(subDir, false);
  if (sourcePaths === null) {
    return `cannot resolve the reviewed source boundary for initialized submodule ${displayPath}`;
  }
  if (sourcePaths.length > 0) {
    const ignored = spawnSync(
      "git",
      ["-C", subDir, "check-ignore", "-z", "--stdin"],
      {
        input: `${sourcePaths.join("\0")}\0`,
        encoding: "utf-8",
        maxBuffer: 512 * 1024 * 1024,
      },
    );
    if (ignored.status !== 0 && ignored.status !== 1) {
      return `cannot verify ignored reviewed source for initialized submodule ${displayPath}`;
    }
    if (ignored.status === 0 && ignored.stdout.length > 0) {
      return (
        `cannot bind dirty initialized submodule ${displayPath}; ignored application source ` +
        "is part of the reviewed fingerprint but cannot be represented by the parent gitlink"
      );
    }
  }

  const gitlinks = spawnSync(
    "git",
    ["-C", subDir, "ls-files", "-s", "-z"],
    { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (gitlinks.status !== 0) {
    return `cannot enumerate nested submodules for ${displayPath}`;
  }
  const trackedNestedPaths = new Set<string>();
  for (const record of gitlinks.stdout.split("\0")) {
    if (!record.startsWith("160000 ")) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) {
      return `cannot parse a nested submodule gitlink under ${displayPath}`;
    }
    const nestedPath = record.slice(tab + 1);
    trackedNestedPaths.add(nestedPath.replace(/\\/g, "/"));
    const nestedDir = join(subDir, nestedPath);
    if (!existsSync(join(nestedDir, ".git"))) continue;
    const nestedError = initializedSubmoduleSourceError(
      nestedDir,
      `${displayPath}/${nestedPath.replace(/\\/g, "/")}`,
      visited,
      depth + 1,
    );
    if (nestedError) return nestedError;
  }
  const embeddedPaths = workspaceSourceEmbeddedGitPaths(subDir, false);
  if (embeddedPaths === null) {
    return `cannot resolve embedded Git checkouts under initialized submodule ${displayPath}`;
  }
  for (const embeddedPath of embeddedPaths) {
    if (trackedNestedPaths.has(embeddedPath)) continue;
    const embeddedDir = join(subDir, embeddedPath);
    if (!existsSync(join(embeddedDir, ".git"))) continue;
    const embeddedDisplayPath = `${displayPath}/${embeddedPath}`;
    const embeddedError = initializedSubmoduleSourceError(
      embeddedDir,
      embeddedDisplayPath,
      visited,
      depth + 1,
    );
    if (embeddedError) return embeddedError;
    return (
      `cannot bind embedded Git checkout ${embeddedDisplayPath}: it is not a tracked submodule. ` +
      "Use git submodule add so the parent records a gitlink and .gitmodules recovery metadata, " +
      "or flatten/remove the embedded checkout before re-running review."
    );
  }
  return null;
}

function bindReviewedSource(
  projectDir: string,
  unit: string,
  fingerprint: string,
  recoveryBudget: NewGitlinkRecoveryBudget,
): { binding?: SourceBinding; error?: string } {
  const wt = worktreePath(projectDir, unit);
  const idx = join(tmpdir(), `aidlc-swarm-source-${process.pid}-${randomUUID().slice(0, 8)}`);
  // commit-tree is an internal snapshot operation, not a user-authored commit.
  // Give it a framework-owned identity so finalize does not depend on ambient
  // user.name/user.email configuration (CI and fresh automation often have none).
  const env = {
    ...process.env,
    GIT_INDEX_FILE: idx,
    GIT_AUTHOR_NAME: "AI-DLC",
    GIT_AUTHOR_EMAIL: "aidlc@localhost",
    GIT_COMMITTER_NAME: "AI-DLC",
    GIT_COMMITTER_EMAIL: "aidlc@localhost",
  };
  const git = (args: string[]) => spawnSync("git", ["-C", wt, ...args], {
    env,
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
  });
  try {
    const head = git(["rev-parse", "HEAD^{commit}"]);
    if (head.status !== 0 || !head.stdout.trim()) return { error: "cannot resolve the Bolt HEAD commit" };
    if (git(["read-tree", "HEAD"]).status !== 0) return { error: "cannot seed the source snapshot index" };
    const initialSubmodules = git(["ls-files", "-s", "-z"]);
    if (initialSubmodules.status !== 0) {
      return { error: "cannot enumerate pre-shape submodule state" };
    }
    const initialGitlinkPaths = new Set<string>();
    for (const record of initialSubmodules.stdout.split("\0")) {
      if (!record.startsWith("160000 ")) continue;
      const tab = record.indexOf("\t");
      if (tab === -1) {
        return { error: "cannot parse a pre-shape submodule gitlink" };
      }
      initialGitlinkPaths.add(record.slice(tab + 1).replace(/\\/g, "/"));
    }
    if (git(["add", "-A"]).status !== 0) return { error: "cannot stage the reviewed source snapshot" };
    const shape = shapeSourceSnapshotIndex(wt, idx, true);
    if (shape === null) {
      return { error: "cannot apply the reviewed source boundary to the snapshot" };
    }
    if (shape.externalSymlinkPaths.length > 0) {
      const rendered = shape.externalSymlinkPaths.slice(0, 10).join(", ") +
        (
          shape.externalSymlinkPaths.length > 10
            ? ` ... and ${shape.externalSymlinkPaths.length - 10} more`
            : ""
        );
      return {
        error:
          `cannot bind external source symlink target${shape.externalSymlinkPaths.length === 1 ? "" : "s"} ` +
          `(${rendered}); a Source Commit records link text but cannot represent external target bytes. ` +
          "Move the target into the worktree or replace the link before re-running review.",
      };
    }
    const modulesIndexed = git([
      "ls-files",
      "--error-unmatch",
      "--",
      ".gitmodules",
    ]);
    let recoverableNewGitlinks = new Map<string, string>();
    if (modulesIndexed.status === 0) {
      const recoverable = recoverableSubmoduleUrls(wt);
      if (recoverable === null) {
        return { error: "cannot parse .gitmodules recovery metadata" };
      }
      recoverableNewGitlinks = recoverable;
    } else if (modulesIndexed.status !== 1) {
      return { error: "cannot verify .gitmodules snapshot state" };
    }
    // The parent tree can represent only a submodule's checked-out commit
    // (mode 160000), never dirty bytes inside that checkout. The fingerprint
    // deliberately includes those bytes, so accepting them here would produce
    // a Source Commit different from what the reviewer inspected. Fail closed
    // rather than silently retaining the old gitlink. A clean submodule checked
    // out at another commit remains representable: `git add -A` staged its new
    // gitlink above.
    const submodules = git(["ls-files", "-s", "-z"]);
    if (submodules.status !== 0) return { error: "cannot verify reviewed submodule state" };
    const visitedSubmodules = new Set<string>();
    for (const record of submodules.stdout.split("\0")) {
      if (!record.startsWith("160000 ")) continue;
      const tab = record.indexOf("\t");
      if (tab === -1) return { error: "cannot parse a reviewed submodule gitlink" };
      const commit = record.slice(0, tab).split(" ")[1] ?? "";
      if (!/^[0-9a-f]{40,64}$/.test(commit)) {
        return { error: "cannot parse a reviewed submodule commit" };
      }
      const path = record.slice(tab + 1);
      const subDir = join(wt, path);
      if (!existsSync(join(subDir, ".git"))) continue; // uninitialized: no reviewed bytes to carry
      const submoduleError = initializedSubmoduleSourceError(
        subDir,
        path.replace(/\\/g, "/"),
        visitedSubmodules,
      );
      if (submoduleError) return { error: submoduleError };
      const normalizedPath = path.replace(/\\/g, "/");
      if (!initialGitlinkPaths.has(normalizedPath)) {
        const recoveryUrl = recoverableNewGitlinks.get(normalizedPath);
        if (recoveryUrl) {
          const recoveryError = newGitlinkRecoveryError(
            wt,
            subDir,
            normalizedPath,
            recoveryUrl,
            commit,
            recoveryBudget,
          );
          if (recoveryError) return { error: recoveryError };
          continue;
        }
        return {
          error:
            `cannot bind embedded Git checkout ${normalizedPath}: it is not a tracked submodule. ` +
            "Use git submodule add so the parent records a gitlink and .gitmodules recovery metadata, " +
            "or flatten/remove the embedded checkout before re-running review.",
        };
      }
    }
    const rawEntries = filteredRawIndexEntries(
      wt,
      idx,
      shape.includedRegularPaths,
    );
    if (rawEntries === null) return { error: "cannot bind raw bytes for filtered source paths" };
    for (const entry of rawEntries) {
      const indexed = git(["ls-files", "-s", "-z", "--", entry.path]);
      const mode = indexed.status === 0 ? indexed.stdout.slice(0, indexed.stdout.indexOf(" ")) : "";
      if (!/^100(?:644|755)$/.test(mode)) {
        return { error: `cannot resolve the index mode for filtered path ${entry.path}` };
      }
      const raw = git(["hash-object", "-w", "--no-filters", "--", entry.path]);
      if (raw.status !== 0 || raw.stdout.trim() !== entry.sha) {
        return { error: `cannot materialize raw reviewed bytes for filtered path ${entry.path}` };
      }
      if (git(["update-index", "--cacheinfo", mode, entry.sha, entry.path]).status !== 0) {
        return { error: `cannot bind raw reviewed bytes for filtered path ${entry.path}` };
      }
    }
    const tree = git(["write-tree"]);
    if (tree.status !== 0 || !tree.stdout.trim()) return { error: "cannot write the reviewed source tree" };
    const commit = git(["commit-tree", tree.stdout.trim(), "-p", head.stdout.trim(), "-m", `Reviewed source for Bolt ${unit}`]);
    if (commit.status !== 0 || !commit.stdout.trim()) return { error: "cannot create the immutable reviewed-source commit" };
    const after = worktreeSourceFingerprint(wt);
    if (after === null || after !== fingerprint) {
      return { error: "source-fingerprint mismatch while binding the reviewed source; re-run the reviewer" };
    }
    const commitSha = commit.stdout.trim();
    const retained = git(["update-ref", reviewedSourceRef(unit, commitSha), commitSha]);
    if (retained.status !== 0) {
      return { error: "cannot retain the immutable reviewed-source commit" };
    }
    return { binding: { fingerprint, commit: commitSha } };
  } finally {
    rmSync(idx, { force: true });
  }
}

// --- Audit emission (this tool owns the whole swarm taxonomy) ---------------
//
// The engine is read-only and the conductor (prose) never emits audit events, so
// the deterministic tool is the sole emitter. SWARM_STARTED fires once per batch
// in `prepare`; SWARM_DEGRADED fires there too when the conductor reports a loud
// downgrade. The per-unit pair, the per-failed-unit baton row, and the batch
// tally all fire from `finalize`, the authoritative gate.

function emitSwarmStarted(
  pd: string,
  batch: string,
  units: string[],
  obligations: string[],
  concurrency: string,
  attempt: SwarmAttemptStamp,
): void {
  appendAuditEntry(
    "SWARM_STARTED",
    {
      "Batch number": batch,
      "Unit names": units.join(","),
      "Unit obligations": obligations.join(","),
      "Concurrency cap": concurrency,
      Stage: attempt.stage,
      "Run floor": attempt.floor,
    },
    pd
  );
}

// Loud-degrade: AIDLC_USE_SWARM=1 was requested but the Workflow tool was
// unavailable, so the conductor ran the subagent floor. The referee makes the
// substrate difference invisible to convergence, but the downgrade is recorded.
function emitSwarmDegraded(pd: string, batch: string, requested: DriverName): void {
  appendAuditEntry(
    "SWARM_DEGRADED",
    {
      "Batch number": batch,
      "Requested driver": requested,
      "Fallback driver": "subagent",
    },
    pd
  );
}

// Each converged row carries the exact attempt stamp captured by prepare.
// Finalize must never recompute this from current state: a late retry against a
// preserved prior-attempt worktree would otherwise be mislabeled as current.
function emitUnitConverged(
  pd: string,
  batch: string,
  unit: string,
  attempt: SwarmAttemptStamp,
  binding?: SourceBinding,
  sourceFreshnessBypassed = false,
): void {
  appendAuditEntry(
    "SWARM_UNIT_CONVERGED",
    {
      "Batch number": batch,
      "Unit name": unit,
      Stage: attempt.stage,
      "Run floor": attempt.floor,
      ...(binding
        ? {
            "Source Fingerprint": binding.fingerprint,
            "Source Commit": binding.commit,
          }
        : sourceFreshnessBypassed
          ? { "Source Freshness Bypass": "true" }
          : {}),
    },
    pd
  );
}

function emitUnitFailed(
  pd: string,
  batch: string,
  unit: string,
  reason: FailureReason
): void {
  appendAuditEntry(
    "SWARM_UNIT_FAILED",
    { "Batch number": batch, "Unit name": unit, Reason: reason },
    pd
  );
}

function emitBatonReturned(
  pd: string,
  batch: string,
  unit: string,
  reason: FailureReason
): void {
  appendAuditEntry(
    "SWARM_BATON_RETURNED",
    { "Batch number": batch, "Unit name": unit, Reason: reason },
    pd
  );
}

function emitSwarmCompleted(
  pd: string,
  batch: string,
  convergedCount: number,
  failedCount: number
): void {
  appendAuditEntry(
    "SWARM_COMPLETED",
    {
      "Batch number": batch,
      "Converged count": String(convergedCount),
      "Failed count": String(failedCount),
    },
    pd
  );
}

// Close a failed unit's per-Bolt lifecycle by composing `aidlc-bolt fail` (emits
// BOLT_FAILED paired with the BOLT_STARTED that `start --worktree` emitted).
// Preserves the worktree per the halt-and-ask contract. Best-effort: the swarm's
// own SWARM_UNIT_FAILED is the authoritative swarm signal, so a failure to emit
// BOLT_FAILED must not mask it.
function emitBoltFailed(pd: string, unit: string, errorSummary: string): void {
  runTool(
    "aidlc-bolt.ts",
    ["fail", "--name", unit, "--slug", swarmBoltSlug(unit), "--error", errorSummary],
    pd
  );
}

// --- prepare ----------------------------------------------------------------

function handlePrepare(rest: string[]): void {
  const { flags } = parseArgs(rest);
  const projectDir = resolveProjectDir(flags["project-dir"]);

  if (!flags.batch || !/^[1-9][0-9]*$/.test(flags.batch)) {
    fail("prepare requires --batch <positive integer>");
  }
  if (!flags.units) {
    fail("prepare requires --units <comma-separated unit names>");
  }
  const units = splitCsv(flags.units);
  if (units.length === 0) {
    fail("--units resolved to an empty list");
  }
  if (flags["degraded-from"]) {
    const requested = flags["degraded-from"] as DriverName;
    if (!DRIVER_VALUES.includes(requested)) {
      fail(`--degraded-from must be one of: ${DRIVER_VALUES.join(", ")}`);
    }
  }
  const state = readStateFile(projectDir);
  const stage = (getField(state, "Current Stage") ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  const autonomy = (getField(state, "Construction Autonomy Mode") ?? "").trim();
  if (stage === "code-generation" && autonomy === "autonomous") {
    const invalid = units
      .map((unit) => evaluateCodeGenerationApproval(projectDir, { unit }))
      .filter((approval) => !approval.ok);
    if (invalid.length > 0) {
      fail(
        "prepare requires a current, explicitly approved Code Generation plan for every autonomous " +
          `unit before worktrees are forked: ${invalid
            .map((approval) => `${approval.unit} (${approval.reason})`)
            .join("; ")}`,
      );
    }
    try {
      for (const unit of units) {
        beginCodeGeneration(projectDir, { unit });
      }
    } catch (error) {
      fail(
        `prepare could not start protected Code Generation authority: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const dag = resolveBoltDag(projectDir, flags.intent, flags.space);
  if (dag.state === "malformed") {
    fail(
      `prepare cannot resolve the authoritative unit DAG: ${dag.reason} ` +
        `(${dag.detail}). Fix unit-of-work-dependency.md before starting the swarm.`,
    );
  }
  const stageDefinition = resolveStage(stage);
  if (dag.state !== "ok") {
    fail("prepare requires a current resolved Unit DAG");
  }
  for (const unit of units) {
    if (!dag.units.includes(unit)) {
      fail(`prepare unit "${unit}" is not in the current resolved Unit DAG`);
    }
    if (
      stageDefinition &&
      filterProducesByKind(
        stageDefinition.produces_kinds,
        stageDefinition.produces ?? [],
        dag.unitKinds?.get(unit) ?? null,
      ).length === 0
    ) {
      fail(`prepare unit "${unit}" has no applicable required outputs for stage "${stage}"`);
    }
  }
  assertUniqueSwarmBoltSlugs(dag.units);

  // P7: the construction repo this batch targets. resolveConstructionRepo errors
  // on a multi-repo intent with no --repo (forwarded as the batch failure), infers
  // the lone repo for a single-repo intent, and yields cwd=projectDir for a legacy
  // intent (today's behaviour). The repoCwd is where `--base` is derived from and
  // is forwarded to every `aidlc-worktree create` so the worktree forks in-repo.
  let repoCwd: string;
  let repoName: string | null;
  try {
    const resolved = resolveConstructionRepo(projectDir, flags.repo, flags.intent, flags.space);
    repoCwd = resolved.cwd;
    repoName = resolved.repo;
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  const base = flags.base ?? currentBranch(repoCwd);
  const concurrency =
    flags.concurrency && /^[1-9][0-9]*$/.test(flags.concurrency)
      ? flags.concurrency
      : String(units.length);
  const attempt = currentSwarmAttempt(projectDir);
  if (!attempt) {
    fail(
      "prepare could not resolve the current stage attempt from state and audit",
    );
  }

  // Record a loud downgrade BEFORE the batch-start row, if the conductor reports
  // one. The driver-selection read (AIDLC_USE_SWARM) is conductor-side; the tool
  // only learns a degrade happened via this flag.
  if (flags["degraded-from"]) {
    emitSwarmDegraded(
      projectDir,
      flags.batch,
      flags["degraded-from"] as DriverName,
    );
  }

  const prepared: {
    unit: string;
    ok: boolean;
    worktree_path?: string;
    error?: string;
  }[] = [];
  // Forward the RESOLVED repo name (not the raw flag) so every sibling primitive
  // anchors to the same repo — an inferred lone repo is passed explicitly too, so
  // create/merge/discard never re-resolve to a different repo than prepare chose.
  const repoArgs = repoName ? ["--repo", repoName] : [];
  for (const unit of units) {
    const boltSlug = swarmBoltSlug(unit);
    const created = runTool(
      "aidlc-worktree.ts",
      [
        "create",
        "--slug",
        boltSlug,
        "--base",
        base,
        "--swarm-unit",
        unit,
        "--swarm-batch",
        flags.batch,
        "--swarm-stage",
        attempt.stage,
        "--swarm-floor",
        attempt.floor,
        ...repoArgs,
      ],
      projectDir
    );
    if (!created.ok) {
      prepared.push({
        unit,
        ok: false,
        error: `worktree create failed: ${created.stderr.trim() || created.stdout.trim()}`,
      });
      continue;
    }
    let worktreeDir: string;
    try {
      worktreeDir = JSON.parse(created.stdout).worktree_path;
    } catch {
      prepared.push({
        unit,
        ok: false,
        error: "could not parse worktree_path from aidlc-worktree create",
      });
      continue;
    }
    const started = runTool(
      "aidlc-bolt.ts",
      ["start", "--worktree", "--slug", boltSlug, "--batch", flags.batch, "--name", unit, ...repoArgs],
      projectDir
    );
    if (!started.ok) {
      prepared.push({
        unit,
        ok: false,
        worktree_path: worktreeDir,
        error: `bolt start failed: ${started.stderr.trim() || started.stdout.trim()}`,
      });
      continue;
    }
    prepared.push({ unit, ok: true, worktree_path: worktreeDir });
  }

  // Stamp only worktrees this invocation actually created and started. Emitting
  // before creation would let a failed re-prepare in a later stage attempt
  // relabel an old preserved worktree with the current attempt, allowing stale
  // data to pass finalize's exact-attempt check.
  const readyUnits = prepared.filter((unit) => unit.ok).map((unit) => unit.unit);
  if (readyUnits.length > 0) {
    emitSwarmStarted(
      projectDir,
      flags.batch,
      readyUnits,
      dag.units,
      concurrency,
      attempt,
    );
  }

  console.log(
    JSON.stringify(
      { batch: flags.batch, base, concurrency: Number(concurrency), units: prepared },
      null,
      2
    )
  );
  // Exit 2 if any worktree failed to fork — the conductor must take the baton.
  process.exit(prepared.some((p) => !p.ok) ? 2 : 0);
}

// --- check ------------------------------------------------------------------

function handleCheck(rest: string[]): void {
  const { positional, flags } = parseArgs(rest);
  const projectDir = resolveProjectDir(flags["project-dir"]);

  const unit = positional[0] ?? flags.unit;
  if (!unit) {
    fail("check requires a unit name (positional `check <unit>` or --unit <unit>)");
  }
  swarmBoltSlug(unit);
  if (!flags["check-cmd"]) {
    fail("check requires --check-cmd <shell command; exit 0 = converged>");
  }

  const verdict = verdictFor(unit, projectDir, flags["check-cmd"], flags["test-file"]);
  if (!verdict.exists) {
    fail(`no worktree for unit "${unit}" — run \`prepare\` first`);
  }
  if (verdict.confineError) {
    console.log(
      JSON.stringify({
        unit,
        converged: false,
        tampered: false,
        reason: "error",
        detail: verdict.confineError,
      })
    );
    process.exit(1);
  }

  const genuine = verdict.converged && !verdict.tampered;
  const out: Record<string, unknown> = {
    unit,
    converged: verdict.converged,
    tampered: verdict.tampered,
    reason: verdict.tampered ? "error" : null,
  };
  if (verdict.tampered) out.detail = "protected test file was modified";
  console.log(JSON.stringify(out));
  // Exit 0 ONLY for a genuine convergence — the seam the ultracode script and
  // the conductor gate on (a worker's self-claim is never read).
  process.exit(genuine ? 0 : 1);
}

// --- finalize ---------------------------------------------------------------

function handleFinalize(rest: string[]): void {
  const { positional, flags } = parseArgs(rest);
  const projectDir = resolveProjectDir(flags["project-dir"]);

  const batch = flags.batch ?? positional[0];
  if (!batch || !/^[1-9][0-9]*$/.test(batch)) {
    fail("finalize requires --batch <positive integer>");
  }
  if (!flags["check-cmd"]) {
    fail("finalize requires --check-cmd <shell command; exit 0 = converged>");
  }
  const claimed = flags.claimed ? splitCsv(flags.claimed) : [];
  // The universe of units in the batch; defaults to the claimed set when the
  // conductor passes only --claimed (then declined-unit accounting is a no-op).
  const allUnits = flags.units ? splitCsv(flags.units) : claimed.slice();
  const dag = resolveBoltDag(projectDir, flags.intent, flags.space);
  if (dag.state !== "ok") fail("finalize requires a current resolved Unit DAG");
  const currentStage = (getField(readStateFile(projectDir), "Current Stage") ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  const stageDefinition = resolveStage(currentStage);
  for (const unit of new Set([...allUnits, ...claimed])) {
    swarmBoltSlug(unit);
    if (!dag.units.includes(unit)) {
      fail(`finalize unit "${unit}" is not in the current resolved Unit DAG`);
    }
    if (
      stageDefinition &&
      filterProducesByKind(
        stageDefinition.produces_kinds,
        stageDefinition.produces ?? [],
        dag.unitKinds?.get(unit) ?? null,
      ).length === 0
    ) {
      fail(`finalize unit "${unit}" has no applicable required outputs for stage "${currentStage}"`);
    }
  }
  const claimedSet = new Set(claimed);
  const testFile = flags["test-file"];
  const checkCmd = flags["check-cmd"];
  const review = reviewerRequirement(projectDir);
  const currentAttempt = currentSwarmAttempt(projectDir);

  // Optional per-declined-unit typed reasons: `--reasons a=unsatisfiable,b=budget-exhausted`.
  // The conductor judged WHY each unclaimed unit gave up (knowledge → conductor,
  // D-I); the tool records that attribution faithfully (determinism → tool),
  // mirroring how --claimed / --degraded-from carry conductor decisions. Applies
  // ONLY to declined units — a claimed unit's reason is always the tool's own
  // re-verify verdict, so the lying-conductor guard cannot be talked out of an
  // `error`. Unparseable / out-of-enum entries are rejected loudly rather than
  // silently downgraded; an unlisted declined unit defaults to `cap-exhausted`.
  const declinedReasons: Record<string, FailureReason> = {};
  if (flags.reasons) {
    for (const pair of splitCsv(flags.reasons)) {
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        fail(`--reasons entry must be <unit>=<reason>: "${pair}"`);
      }
      const unit = pair.slice(0, eq).trim();
      swarmBoltSlug(unit);
      const reason = pair.slice(eq + 1).trim() as FailureReason;
      if (!DECLINED_REASONS.includes(reason)) {
        fail(`--reasons reason for "${unit}" must be one of: ${DECLINED_REASONS.join(", ")}`);
      }
      declinedReasons[unit] = reason;
    }
  }

  // Re-verify every claimed unit (the lying-conductor guard) and account for any
  // declined unit the conductor did not claim.
  const results: UnitResult[] = [];
  const genuine: string[] = [];
  const preparedAttempts = new Map<string, SwarmAttemptStamp>();
  const sourceBindings = new Map<string, SourceBinding>();
  const recordSnapshots = new Map<string, ReviewedRecordSnapshot>();
  const sourceFreshnessBypassed =
    process.env.AIDLC_SKIP_SOURCE_FRESHNESS === "1";
  const recoveryBudget = newGitlinkRecoveryBudget();
  for (const unit of allUnits) {
    if (claimedSet.has(unit)) {
      const verdict = verdictFor(unit, projectDir, checkCmd, testFile);
      const preparedAttempt = preparedSwarmAttempt(
        projectDir,
        batch,
        unit,
      );
      if (!preparedAttempt) {
        results.push({
          unit,
          status: "failed",
          reason: "error",
          detail:
            "no stamped SWARM_STARTED boundary for this unit and batch; run prepare in the current attempt",
        });
      } else if (
        !currentAttempt ||
        preparedAttempt.stage !== currentAttempt.stage ||
        preparedAttempt.floor !== currentAttempt.floor
      ) {
        results.push({
          unit,
          status: "failed",
          reason: "error",
          detail:
            `prepared swarm attempt ${preparedAttempt.stage}/${preparedAttempt.floor} ` +
            `does not match the current attempt ` +
            `${currentAttempt ? `${currentAttempt.stage}/${currentAttempt.floor}` : "(unresolved)"}`,
        });
      } else if (!verdict.exists) {
        results.push({
          unit,
          status: "failed",
          reason: "error",
          detail: "no worktree on re-verify (prepare not run?)",
        });
      } else if (verdict.confineError) {
        results.push({ unit, status: "failed", reason: "error", detail: verdict.confineError });
      } else if (verdict.tampered) {
        results.push({
          unit,
          status: "failed",
          reason: "error",
          detail: "convergence rejected: protected test file was modified",
          tampered: true,
        });
      } else if (verdict.converged) {
        const receipt: ReceiptCheck = review.error
          ? { error: review.error }
          : review.reviewer
            ? reviewerReceiptError(
                projectDir,
                unit,
                review.stage,
                review.reviewer,
                review.reviewClass,
                review.maxIterations,
              )
            : { error: null };
        if (receipt.error) {
          results.push({
            unit,
            status: "failed",
            reason: "error",
            detail: receipt.error,
          });
        } else {
          const captured = stageDefinition
            ? captureReviewedRecordSnapshot(
                projectDir,
                unit,
                stageDefinition,
                receipt,
              )
            : { error: `cannot resolve stage "${currentStage}"` };
          const bound = receipt.sourceFingerprint
            ? bindReviewedSource(
                projectDir,
                swarmBoltSlug(unit),
                receipt.sourceFingerprint,
                recoveryBudget,
              )
            : {};
          if (captured.error || !captured.snapshot) {
            results.push({
              unit,
              status: "failed",
              reason: "error",
              detail: captured.error ?? `cannot snapshot record artifacts for unit "${unit}"`,
            });
          } else if (bound.error) {
            results.push({
              unit,
              status: "failed",
              reason: "error",
              detail: bound.error,
            });
          } else {
            if (bound.binding) sourceBindings.set(unit, bound.binding);
            recordSnapshots.set(unit, captured.snapshot);
            genuine.push(unit);
            preparedAttempts.set(unit, preparedAttempt);
            results.push({ unit, status: "converged" });
          }
        }
      } else {
        // Claimed converged, but the check command does not pass on re-verify —
        // the lying / misremembering conductor. Refuse the merge.
        results.push({
          unit,
          status: "failed",
          reason: "error",
          detail: "claimed converged but the check command did not pass on re-verify",
        });
      }
    } else {
      // The conductor did not claim this unit: its driver loop ended without
      // convergence. The conductor may attribute a typed reason via --reasons
      // (e.g. `unsatisfiable` when it judged the unit fundamentally unbuildable,
      // `budget-exhausted` when the ultracode token ceiling stopped it); absent
      // an attribution, `cap-exhausted` is the catch-all (the loop ended without
      // convergence and the conductor offered no finer classification).
      const reason = declinedReasons[unit] ?? "cap-exhausted";
      results.push({
        unit,
        status: "failed",
        reason,
        detail:
          reason === "cap-exhausted"
            ? "unit not claimed converged by the conductor"
            : `unit not claimed converged; conductor attributed: ${reason}`,
      });
    }
  }

  // Serialised HOLD-MERGE merge-back of the genuine passes only (sorted for a
  // deterministic merge order). release-merge is idempotent — safe whether or not
  // the lock was ever held; complete --merge reaches the add/add-conflict abort
  // pinned at the composed surface by the worktree-merge tests.
  const mergeFailures: { unit: string; detail: string }[] = [];
  for (const unit of [...genuine].sort()) {
    const boltSlug = swarmBoltSlug(unit);
    const recordSnapshot = recordSnapshots.get(unit);
    const recordMergeError = recordSnapshot
      ? mergeReviewedRecordSnapshot(projectDir, unit, recordSnapshot)
      : `reviewed record snapshot is missing for unit "${unit}"`;
    if (recordMergeError !== null) {
      mergeFailures.push({ unit, detail: recordMergeError });
      continue;
    }
    runTool("aidlc-bolt.ts", ["release-merge", "--slug", boltSlug], projectDir);
    const merged = runTool(
      "aidlc-bolt.ts",
      ["complete", "--merge", "--slug", boltSlug, "--batch", batch, "--name", unit],
      projectDir
    );
    if (!merged.ok) {
      mergeFailures.push({ unit, detail: merged.stderr.trim() || merged.stdout.trim() });
    }
  }

  // Authoritative audit trail: one row per unit, the baton per failed unit, the
  // batch tally to close. A converged unit whose merge-back FAILED gets no
  // SWARM_UNIT_CONVERGED row: that row is the engine's batch-advance signal, and
  // emitting it for a unit whose metadata never landed on main would advance the
  // run past an unmerged unit. It gets no SWARM_UNIT_FAILED row either - the
  // unit did converge; the failure envelope + exit 2 carry the merge outcome.
  // The row lands when a finalize retry scoped to that unit merges cleanly (the
  // worktree is preserved and release-merge is idempotent, so the retry is a
  // pure re-invocation - no prepare).
  const mergeFailed = new Set(mergeFailures.map((f) => f.unit));
  for (const r of results) {
    if (r.status === "converged") {
      if (!mergeFailed.has(r.unit)) {
        const attempt = preparedAttempts.get(r.unit);
        if (attempt) {
          emitUnitConverged(
            projectDir,
            batch,
            r.unit,
            attempt,
            sourceBindings.get(r.unit),
            sourceFreshnessBypassed,
          );
        }
      }
    } else {
      emitUnitFailed(projectDir, batch, r.unit, r.reason ?? "error");
      emitBoltFailed(projectDir, r.unit, r.detail ?? `unit "${r.unit}" failed: ${r.reason}`);
    }
  }
  const failedResults = results.filter((r) => r.status === "failed");
  for (const r of failedResults) {
    emitBatonReturned(projectDir, batch, r.unit, r.reason ?? "error");
  }

  const convergedCount = genuine.length;
  const failedCount = failedResults.length;
  emitSwarmCompleted(projectDir, batch, convergedCount, failedCount);

  const envelope = {
    batch,
    units: results.map((result) => ({
      ...result,
      bolt_slug: swarmBoltSlug(result.unit),
    })),
    converged: convergedCount,
    failed: failedCount,
    merge_failures: mergeFailures,
  };
  console.log(JSON.stringify(envelope, null, 2));
  // Exit 2 signals "the conductor must take the baton" (a unit failed or a merge
  // failed); exit 0 means every claimed unit was genuinely converged and merged.
  process.exit(failedCount > 0 || mergeFailures.length > 0 ? 2 : 0);
}

// --- shared helpers ---------------------------------------------------------

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((u) => u.trim())
    .filter((u) => u !== "");
}

function swarmBoltSlug(unit: string): string {
  const unitNameError = validateUnitName(unit);
  if (unitNameError) fail(unitNameError);
  return boltSlugForUnit(unit);
}

function assertUniqueSwarmBoltSlugs(units: string[]): void {
  const owners = new Map<string, string>();
  for (const unit of units) {
    const boltSlug = swarmBoltSlug(unit);
    const existing = owners.get(boltSlug);
    if (existing && existing !== unit) {
      fail(
        `Units "${existing}" and "${unit}" resolve to the same internal Bolt slug ` +
          `"${boltSlug}". Rename one Unit before starting the autonomous swarm.`,
      );
    }
    owners.set(boltSlug, unit);
  }
}

function currentSwarmAttempt(projectDir: string): SwarmAttemptStamp | null {
  try {
    const stage =
      getField(readStateFile(projectDir), "Current Stage")?.trim() ?? "";
    if (!stage) return null;
    return {
      stage,
      floor: latestMainWorkflowStageRunFloorForProject(projectDir, stage),
    };
  } catch {
    return null;
  }
}

function preparedSwarmAttempt(
  projectDir: string,
  batch: string,
  unit: string,
): SwarmAttemptStamp | null {
  const matching = readAuditShardEvents(projectDir).filter((event) => {
    if (event.event !== "SWARM_STARTED") return false;
    if (auditBlockField(event.block, "Batch number") !== batch) return false;
    const units = splitCsv(auditBlockField(event.block, "Unit names") ?? "");
    return units.includes(unit);
  });
  const stamped = matching.filter(
    (event) =>
      auditBlockField(event.block, "Stage") !== null &&
      auditBlockField(event.block, "Run floor") !== null,
  );
  if (stamped.length > 0) {
    stamped.sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp < b.timestamp ? -1 : 1;
      }
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    });
    const timestamp = stamped[stamped.length - 1].timestamp;
    const latest = stamped.filter((event) => event.timestamp === timestamp);
    const stamps = new Map<string, SwarmAttemptStamp>();
    for (const event of latest) {
      const stage = auditBlockField(event.block, "Stage");
      const floor = auditBlockField(event.block, "Run floor");
      if (!stage || !floor) continue;
      stamps.set(`${stage}\0${floor}`, { stage, floor });
    }
    // Same-second starts in different shards are unordered. A shared stamp is
    // harmless; differing stamps fail closed instead of picking by filename.
    if (
      new Set(latest.map((event) => event.shard)).size > 1 &&
      stamps.size !== 1
    ) {
      return null;
    }
    return stamps.values().next().value ?? null;
  }
  return legacyPreparedSwarmAttempt(projectDir, batch, unit);
}

function legacyPreparedSwarmAttempt(
  projectDir: string,
  batch: string,
  unit: string,
): SwarmAttemptStamp | null {
  const boltSlug = swarmBoltSlug(unit);
  const wt = worktreePath(projectDir, boltSlug);
  const recordPrefix = relativeRecordDir(projectDir);
  const wtState = worktreeStateFilePath(wt, recordPrefix);
  const wtAudit = worktreeAuditFilePath(wt, recordPrefix, projectDir);
  const wtRuntime = worktreeRuntimeGraphPath(wt, recordPrefix);
  if (
    !existsSync(wt) ||
    !isRegularFile(wtState) ||
    !isRegularFile(wtAudit) ||
    !isRegularFile(wtRuntime)
  ) {
    return null;
  }

  let worktreeAudit: string;
  let state: string;
  try {
    worktreeAudit = readFileSync(wtAudit, "utf-8");
    state = readFileSync(wtState, "utf-8");
  } catch {
    return null;
  }
  const fork = findAllEvents(worktreeAudit, "AUDIT_FORKED")
    .filter((event) => auditBlockField(event.block, "Bolt slug") === boltSlug)
    .at(-1);
  const boundaryRaw = fork ? auditBlockField(fork.block, "Fork Boundary") : null;
  const sourceHash = fork ? auditBlockField(fork.block, "Source Audit Hash") : null;
  if (!boundaryRaw || !sourceHash || !/^[0-9]+$/.test(boundaryRaw)) return null;

  const mainDir = auditShardDir(projectDir);
  if (!mainDir) return null;
  const mainShard = join(mainDir, basename(wtAudit));
  let mainBytes: Buffer;
  try {
    mainBytes = readFileSync(mainShard);
  } catch {
    return null;
  }
  const boundary = Number(boundaryRaw);
  if (!Number.isSafeInteger(boundary) || boundary < 0 || mainBytes.length < boundary) {
    return null;
  }
  const frozenBytes = mainBytes.subarray(0, boundary);
  if (createHash("sha256").update(frozenBytes).digest("hex") !== sourceHash) {
    return null;
  }
  const frozenAudit = frozenBytes.toString("utf-8");
  const frozenBlocks = frozenAudit.replace(/\r\n/g, "\n").split(/\n---\n/);
  const legacyStarts: number[] = [];
  const boltStarts: number[] = [];
  const stateForks: number[] = [];
  for (let index = 0; index < frozenBlocks.length; index++) {
    const block = frozenBlocks[index];
    const event = auditBlockField(block, "Event");
    if (
      event === "SWARM_STARTED" &&
      auditBlockField(block, "Batch number") === batch &&
      !auditBlockField(block, "Stage") &&
      !auditBlockField(block, "Run floor") &&
      splitCsv(auditBlockField(block, "Unit names") ?? "").includes(unit)
    ) {
      legacyStarts.push(index);
    }
    if (
      event === "BOLT_STARTED" &&
      auditBlockField(block, "Batch number") === batch &&
      auditBlockField(block, "Bolt slug") === boltSlug
    ) {
      boltStarts.push(index);
    }
    if (
      event === "STATE_FORKED" &&
      auditBlockField(block, "Bolt slug") === boltSlug
    ) {
      stateForks.push(index);
    }
  }
  const hasPreparationSequence = legacyStarts.some((started) =>
    boltStarts.some((bolt) =>
      bolt > started && stateForks.some((forked) => forked > bolt),
    ),
  );
  if (!hasPreparationSequence) return null;

  const stage = getField(state, "Current Stage")?.trim() ?? "";
  if (!stage) return null;
  return {
    stage,
    floor: latestMainWorkflowStageRunFloor(frozenAudit, stage),
  };
}

function currentBranch(projectDir: string): string {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: projectDir,
    encoding: "utf-8",
  });
  return (r.stdout ?? "main").trim() || "main";
}

function fail(msg: string): never {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

export function main(argv: string[]): void {
  // The subcommand is the first bare token that is NOT a flag NOR a flag's value.
  // Walk argv skipping `--flag value` / `--flag=value` pairs so
  // `--project-dir <path> check ...` and `check --project-dir <path> ...` both
  // resolve to `check`. The handlers re-read every flag from `rest`, and a
  // positional unit (e.g. `check <unit>`) survives in rest.
  let subcommand: string | undefined;
  let subIndex = -1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!a.includes("=") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        i++;
      }
      continue;
    }
    subcommand = a;
    subIndex = i;
    break;
  }
  const rest = subIndex >= 0 ? [...argv.slice(0, subIndex), ...argv.slice(subIndex + 1)] : argv;
  switch (subcommand) {
    case "prepare":
      handlePrepare(rest);
      break;
    case "check":
      handleCheck(rest);
      break;
    case "finalize":
      handleFinalize(rest);
      break;
    default:
      console.error(
        JSON.stringify({
          error: `Unknown subcommand: ${subcommand ?? "(none)"}. Valid: prepare, check, finalize`,
        })
      );
      process.exit(1);
  }
}

if (import.meta.main) main(process.argv.slice(2));
