// PreToolUse hook: deterministic enforcement of the §12a terminal-receipt
// ordering - the write-freeze between a terminal review receipt and the gate.
//
// The engine's completion precondition (aidlc-state.ts, via the shared
// freshReviewReceipts scan in aidlc-lib.ts) invalidates a REVIEW_COMPLETED
// receipt when a declared produces[] artifact is written after it - a
// deliberate fail-closed floor (a receipt must cover the final artifact
// bytes). Field traces showed prose losing the ordering contest: a conductor
// applied reviewer suggestions AFTER recording the terminal receipt, voided
// its own receipt, re-reviewed, re-edited, and oscillated until the live
// session wedged at the gate. Per the framework layering (determinism belongs
// in tools and hooks, knowledge in agents, judgement with humans), this hook
// is the ordering's deterministic twin: it refuses the produces[] write that
// would void a fresh terminal receipt, BEFORE the invalidation happens, with a
// reason that names the sanctioned paths: quote reviewer suggestions at the
// gate without applying them, or obtain Request Changes to reopen real defects.
//
// Freeze window - all facts read from the audit ledger and compiled graph:
//   - the target file matches a declared produces[]/optional_produces[]
//     artifact of a reviewer-bearing stage (same suffix matcher the engine
//     uses), AND
//   - that stage is not yet completed in the state file (an [x] stage's
//     artifacts are its permanent record; later stages may legitimately
//     append - e.g. a reviewer's `## Review` on a redo is a fresh attempt
//     whose floor already reset), AND
//   - a FRESH TERMINAL receipt covers the write target (stage receipt for
//     stage-level artifacts; that unit's receipt for a per-unit write).
// Everything the freeze must release on releases it automatically because
// the scan is shared with the engine: GATE_REJECTED, STAGE_JUMPED, and
// WORKFLOW_STARTED reset the floor (so post-rejection revisions are never
// frozen), a below-cap adversarial NOT-READY remains nonterminal so its repair
// loop can edit, and non-produces writes (diary, questions, contributions)
// never match. Terminal NOT-READY under the effective class freezes just like
// READY because no further review pass follows it.
//
// The block contract is the harness-native PreToolUse refuse: print a reason
// to stderr and exit 2; exit 0 allows. Fail-open everywhere: malformed stdin,
// no audit ledger, unreadable state or graph, an unknown tool, or any throw
// allows the call. The deterministic off-switch
// AIDLC_DISABLE_REVIEW_FREEZE_HOOK=1 disables enforcement entirely (the
// documented escape hatch for false-positive storms, mirroring the
// reviewer-scope hook's off-switch). Every genuine block emits a
// REVIEW_FREEZE_BLOCKED audit event; audit failures never change the decision.
//
// Bash is inspected before execution too. Shell writes do not pass through the
// Write/Edit PostToolUse audit feed, so allowing one after a terminal receipt
// would leave it fresh over different bytes. The matcher extracts output
// redirections and operands of common mutation commands; read-only shell calls
// do not produce targets and remain untouched.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  auditFilePath,
  type ClaudeCodeHookInput,
  errorMessage,
  freshReviewReceipts,
  getField,
  hooksHealthDir,
  intentRepos,
  isClaudeCodeHookInput,
  isoTimestamp,
  loadStageGraph,
  parseCheckboxes,
  producesArtifactUnit,
  readAllAuditShards,
  readStateFile,
  recordHookDrop,
  recoveryGuidance,
  releaseAuditLock,
  resolveReviewClass,
  resolveProjectDirFromHook,
  type StageEntry,
} from "../tools/aidlc-lib.ts";
import { writeTargets } from "./review-freeze-command.ts";
export {
  shellCommandAltersExecutableResolution,
  shellCommandInvocationDetails,
  shellCommandInvocations,
  shellWriteTargets,
  type ShellInvocationDetails,
  type ShellInvocation,
  writeTargets,
} from "./review-freeze-command.ts";

const HOOK_NAME = "review-freeze";

export interface FreezeVerdict {
  block: boolean;
  /** The offending path (block=true). */
  target?: string;
  /** The stage whose receipt the write would void. */
  stage?: string;
  /** The per-unit target, when the write is unit-scoped. */
  unit?: string;
}

/** The freeze decision for one write target against one stage. Pure over the
 *  supplied receipts; exported so the decision table is unit-testable. */
export function judgeFreeze(
  stage: Pick<
    StageEntry,
    "slug" | "for_each" | "reviewer" | "produces" | "optional_produces"
  >,
  file: string,
  recordedRepos: ReadonlySet<string>,
  receipts: {
    stageVerdict: string | null;
    unitVerdicts: Map<string, string>;
    stageStale?: boolean;
    unitStale?: ReadonlySet<string>;
    sourceStale?: boolean;
    newestSourceUnit?: string | null;
    stagePending?: {
      recovery: boolean;
      suspensionActive?: boolean;
      recoveryCause?: "artifact" | "source" | "artifact+source" | null;
    } | null;
    unitPending?: ReadonlyMap<
      string,
      {
        recovery: boolean;
        suspensionActive?: boolean;
        recoveryCause?: "artifact" | "source" | "artifact+source" | null;
      }
    >;
  },
): FreezeVerdict {
  const recoveryStillStale = (
    pending: {
      recoveryCause?: "artifact" | "source" | "artifact+source" | null;
    },
    artifactStale: boolean,
    sourceStale: boolean,
  ): boolean => {
    if (pending.recoveryCause === "artifact") return artifactStale;
    if (pending.recoveryCause === "source") return sourceStale;
    if (pending.recoveryCause === "artifact+source") {
      return artifactStale || sourceStale;
    }
    return artifactStale || sourceStale;
  };
  const targetUnit = producesArtifactUnit(stage, file, recordedRepos);
  if (targetUnit === undefined) return { block: false }; // not this stage's artifact
  if (stage.for_each === "unit-of-work") {
    if (targetUnit !== null) {
      const pending = receipts.unitPending?.get(targetUnit);
      if (pending?.recovery === true) {
        const stillStale = recoveryStillStale(
          pending,
          receipts.unitStale?.has(targetUnit) === true,
          receipts.sourceStale === true &&
            receipts.newestSourceUnit === targetUnit,
        );
        if (pending.suspensionActive === true && stillStale) {
          return { block: false };
        }
        return { block: true, target: file, stage: stage.slug, unit: targetUnit };
      }
      // A unit-scoped write voids that unit's receipt only.
      if (receipts.unitVerdicts.has(targetUnit)) {
        return { block: true, target: file, stage: stage.slug, unit: targetUnit };
      }
      return { block: false };
    }
    if (receipts.stagePending?.recovery === true) {
      const stillStale = recoveryStillStale(
        receipts.stagePending,
        receipts.stageStale === true,
        receipts.sourceStale === true &&
          receipts.newestSourceUnit === null,
      );
      if (
        receipts.stagePending.suspensionActive === true &&
        stillStale
      ) {
        return { block: false };
      }
      return { block: true, target: file, stage: stage.slug };
    }
    for (const [unit, pending] of receipts.unitPending ?? []) {
      if (pending.recovery) {
        return { block: true, target: file, stage: stage.slug, unit };
      }
    }
    // Ambiguous per-unit path: the engine fails closed by clearing EVERY unit
    // receipt, so freeze if any unit currently holds a terminal receipt.
    for (const [unit, verdict] of receipts.unitVerdicts) {
      if (verdict === "READY" || verdict === "NOT-READY") {
        return { block: true, target: file, stage: stage.slug, unit };
      }
    }
    return { block: false };
  }
  if (receipts.stagePending?.recovery === true) {
    const stillStale = recoveryStillStale(
      receipts.stagePending,
      receipts.stageStale === true,
      receipts.sourceStale === true &&
        receipts.newestSourceUnit === null,
    );
    if (
      receipts.stagePending.suspensionActive === true &&
      stillStale
    ) {
      return { block: false };
    }
    return { block: true, target: file, stage: stage.slug };
  }
  if (receipts.stageVerdict !== null) {
    return { block: true, target: file, stage: stage.slug };
  }
  return { block: false };
}

// The block reason handed back through the harness's PreToolUse error
// channel. Self-explaining and redirecting: it names the invariant, restores
// the quote-at-gate route for suggestions, and names the state-correct route
// that legitimately reopens a real defect.
export const REVIEW_FREEZE_FALLBACK_GUIDANCE =
  "Ask the human what should change, then record their Request Changes " +
  "decision before editing the document; that unlocks it for revision and a " +
  "fresh review.";

export function reviewFreezeRecoveryGuidance(
  projectDir: string,
  stateContent: string,
  stageSlug: string,
  guidanceReader: typeof recoveryGuidance = recoveryGuidance,
): string {
  try {
    return guidanceReader(projectDir, stateContent, stageSlug);
  } catch {
    return REVIEW_FREEZE_FALLBACK_GUIDANCE;
  }
}

export function blockReason(
  v: FreezeVerdict,
  guidance = REVIEW_FREEZE_FALLBACK_GUIDANCE,
): string {
  const scope = v.unit ? `stage "${v.stage}" unit "${v.unit}"` : `stage "${v.stage}"`;
  return (
    `review-freeze: "${v.target}" is this stage's output document for ${scope}, ` +
    "and its latest review is final. Writing it now would make that review no " +
    "longer cover the document. If this is a reviewer suggestion, quote it at " +
    `the gate instead of applying it. ${guidance}`
  );
}

// --- Main ---------------------------------------------------------------------

export async function run(input: string): Promise<number> {
  // Deterministic off-switch: enforcement disabled entirely.
  if (process.env.AIDLC_DISABLE_REVIEW_FREEZE_HOOK === "1") return 0;

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, `${HOOK_NAME}.last`), isoTimestamp(), "utf-8");
  } catch {
    // Heartbeat failure is non-fatal - never let it affect the decision.
  }

  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(input);
    if (!isClaudeCodeHookInput(raw)) return 0;
    parsed = raw;
  } catch {
    return 0; // malformed stdin - fail open
  }

  const toolName = parsed.tool_name ?? "";
  const cwd = typeof parsed.cwd === "string" ? parsed.cwd : projectDir;
  const targets = writeTargets(toolName, parsed.tool_input, cwd);
  if (targets.length === 0) return 0;

  // No audit ledger means no receipts to protect - the common non-AIDLC case,
  // decided before any state/graph read so the hook stays near-free outside a
  // workflow.
  try {
    if (readAllAuditShards(projectDir).length === 0) return 0;
  } catch {
    return 0;
  }

  let verdict: FreezeVerdict = { block: false };
  let stateContent = "";
  try {
    const content = readStateFile(projectDir);
    stateContent = content;
    // Only NOT-completed reviewer-bearing stages can hold a receipt the gate
    // still depends on. Completed ([x]) and skipped stages are excluded: their
    // artifacts are permanent record, and a redo re-opens them via jump or
    // reject - both of which reset the shared scan's floor anyway.
    const openSlugs = new Set(
      parseCheckboxes(content)
        .filter((c) => c.state !== "completed" && c.state !== "skipped")
        .map((c) => c.slug),
    );
    const recordedRepos = new Set(intentRepos(projectDir));
    for (const stage of loadStageGraph()) {
      if (!stage.reviewer || !openSlugs.has(stage.slug)) continue;
      // Cheap suffix pre-check via producesArtifactUnit happens inside
      // judgeFreeze; the receipt scan only runs for a stage that actually
      // matched a target (freshReviewReceipts walks the whole ledger).
      let receipts: ReturnType<typeof freshReviewReceipts> | null = null;
      for (const file of targets) {
        const probe = producesArtifactUnit(stage, file, recordedRepos);
        if (probe === undefined) continue;
        const reviewClass = resolveReviewClass(
          stage.review_class ?? "adversarial",
          getField(content, "Scope") ?? "",
          content,
        );
        receipts ??= freshReviewReceipts(projectDir, content, stage, {
          reviewClass,
        });
        verdict = judgeFreeze(stage, file, recordedRepos, receipts);
        if (verdict.block) break;
      }
      if (verdict.block) break;
    }
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    return 0; // state/graph unreadable or matcher failure - fail open
  }
  if (!verdict.block) return 0;

  // Audit the refusal so the run's record shows when the freeze bit.
  // Best-effort: an audit failure never changes the block decision. The lock
  // acquisition is TIME-BOUNDED well below the standard 5s budget (5 x 50ms):
  // the block decision is already made, and a lock-starved fan-out must not
  // stretch a fast refuse into a laggy one - a dropped advisory row is
  // preferable to a slow block.
  try {
    if (existsSync(auditFilePath(projectDir))) {
      if (acquireAuditLock(projectDir, 5, 50)) {
        try {
          appendAuditEntryUnlocked(
            "REVIEW_FREEZE_BLOCKED",
            {
              Tool: toolName,
              Target: verdict.target ?? "",
              Stage: verdict.stage ?? "",
              ...(verdict.unit ? { Unit: verdict.unit } : {}),
            },
            projectDir,
          );
        } finally {
          releaseAuditLock(projectDir);
        }
      } else {
        recordHookDrop(projectDir, HOOK_NAME, "audit lock contended; REVIEW_FREEZE_BLOCKED row dropped (block still enforced)");
      }
    }
  } catch {
    // Advisory emission only.
  }

  const guidance = reviewFreezeRecoveryGuidance(
    projectDir,
    stateContent,
    verdict.stage ?? "",
  );
  process.stderr.write(`${blockReason(verdict, guidance)}\n`);
  return 2; // harness PreToolUse reject contract: exit 2 + stderr blocks
}

if (import.meta.main) {
  const input = process.stdin.isTTY ? "" : await Bun.stdin.text();
  process.exit(await run(input));
}
