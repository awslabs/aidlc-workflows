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
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { appendAuditEntry } from "./aidlc-audit.ts";
import {
  auditBlockField,
  auditShardDir,
  boltSlugForUnit,
  findAllEvents,
  getField,
  isRegularFile,
  latestMainWorkflowStageRunFloor,
  latestMainWorkflowStageRunFloorForProject,
  parseArgs,
  readAuditShardEvents,
  readAllAuditShards,
  readStateFile,
  relativeRecordDir,
  reviewArtifactFingerprint,
  resolveBoltDag,
  resolveConstructionRepo,
  resolveProjectDir,
  resolveStage,
  terminalReviewVerdict,
  validateUnitName,
  worktreeAuditFilePath,
  worktreePath,
  worktreeRuntimeGraphPath,
  worktreeStateFilePath,
} from "./aidlc-lib.ts";
import { compiledExecutable } from "./aidlc-runtime-paths.ts";

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
): string | null {
  const boltSlug = swarmBoltSlug(unit);
  const audit = readAllAuditShards(worktreePath(projectDir, boltSlug));
  if (!audit) {
    return `claimed converged but worktree audit is missing; expected a terminal review by ${reviewer}`;
  }

  const relevant = new Set([
    "BOLT_STARTED",
    "REVIEW_REQUESTED",
    "REVIEW_COMPLETED",
  ]);
  const events = audit
    .replace(/\r\n/g, "\n")
    .split(/\n---\n/)
    .map((block, position) => ({
      block,
      position,
      event: auditBlockField(block, "Event") ?? "",
      timestamp: auditBlockField(block, "Timestamp") ?? "",
    }))
    .filter((event) => relevant.has(event.event))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      return a.position - b.position;
    });

  let boltStart = -1;
  for (let i = 0; i < events.length; i++) {
    if (
      events[i].event === "BOLT_STARTED" &&
      auditBlockField(events[i].block, "Bolt slug") === boltSlug
    ) {
      boltStart = i;
    }
  }
  if (boltStart === -1) {
    return `claimed converged but worktree audit has no BOLT_STARTED boundary for unit "${unit}"`;
  }

  const pendingRequests = new Set<string>();
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
      pendingRequests.add(requestKey);
      continue;
    }
    if (!pendingRequests.delete(requestKey)) continue;
    const verdict = terminalReviewVerdict(
      auditBlockField(event.block, "Verdict"),
      iteration,
      reviewClass,
      maxIterations,
    );
    if (verdict === null) continue;
    const definition = resolveStage(stage);
    if (!definition) continue;
    const recordedFingerprint = auditBlockField(event.block, "Artifact Fingerprint");
    const currentFingerprint = reviewArtifactFingerprint(
      worktreePath(projectDir, boltSlug),
      definition,
      unit,
      { requireRequiredArtifacts: true },
    );
    if (
      recordedFingerprint !== null &&
      /^sha256:[0-9a-f]{64}$/.test(recordedFingerprint) &&
      currentFingerprint !== null &&
      recordedFingerprint === currentFingerprint
    ) {
      return null;
    }
  }

  return (
    `claimed converged but no terminal REVIEW_COMPLETED for stage "${stage}", ` +
    `unit "${unit}", reviewer "${reviewer}" with a current artifact fingerprint exists after this Bolt started`
  );
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
  concurrency: string,
  attempt: SwarmAttemptStamp,
): void {
  appendAuditEntry(
    "SWARM_STARTED",
    {
      "Batch number": batch,
      "Unit names": units.join(","),
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
): void {
  appendAuditEntry(
    "SWARM_UNIT_CONVERGED",
    {
      "Batch number": batch,
      "Unit name": unit,
      Stage: attempt.stage,
      "Run floor": attempt.floor,
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
  const dag = resolveBoltDag(projectDir);
  if (dag.state === "malformed") {
    fail(
      `prepare cannot resolve the authoritative unit DAG: ${dag.reason} ` +
        `(${dag.detail}). Fix unit-of-work-dependency.md before starting the swarm.`,
    );
  }
  const slugUniverse =
    dag.state === "ok"
      ? [...new Set([...dag.units, ...units])]
      : units;
  assertUniqueSwarmBoltSlugs(slugUniverse);

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
    const requested = flags["degraded-from"] as DriverName;
    if (!DRIVER_VALUES.includes(requested)) {
      fail(`--degraded-from must be one of: ${DRIVER_VALUES.join(", ")}`);
    }
    emitSwarmDegraded(projectDir, flags.batch, requested);
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
      ["create", "--slug", boltSlug, "--base", base, ...repoArgs],
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
    emitSwarmStarted(projectDir, flags.batch, readyUnits, concurrency, attempt);
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
  for (const unit of new Set([...allUnits, ...claimed])) swarmBoltSlug(unit);
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
        const reviewError = review.error ?? (
          review.reviewer
            ? reviewerReceiptError(
                projectDir,
                unit,
                review.stage,
                review.reviewer,
                review.reviewClass,
                review.maxIterations,
              )
            : null
        );
        if (reviewError) {
          results.push({
            unit,
            status: "failed",
            reason: "error",
            detail: reviewError,
          });
        } else {
          genuine.push(unit);
          preparedAttempts.set(unit, preparedAttempt);
          results.push({ unit, status: "converged" });
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
        if (attempt) emitUnitConverged(projectDir, batch, r.unit, attempt);
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
    units: results,
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
