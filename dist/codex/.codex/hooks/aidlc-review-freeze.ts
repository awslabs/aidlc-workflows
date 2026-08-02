// PreToolUse hook: deterministic enforcement of the §12a terminal-receipt
// ordering - the write-freeze between a READY review receipt and the gate.
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
// would void a fresh READY receipt, BEFORE the invalidation happens, with a
// reason that names the sanctioned paths (quote suggestions at the gate; or
// reject at the gate, which lifts the freeze for a revision).
//
// Freeze window - all facts read from the audit ledger and compiled graph:
//   - the target file matches a declared produces[]/optional_produces[]
//     artifact of a reviewer-bearing stage (same suffix matcher the engine
//     uses), AND
//   - that stage is not yet completed in the state file (an [x] stage's
//     artifacts are its permanent record; later stages may legitimately
//     append - e.g. a reviewer's `## Review` on a redo is a fresh attempt
//     whose floor already reset), AND
//   - a FRESH READY receipt covers the write target (stage receipt for
//     stage-level artifacts; that unit's receipt for a per-unit write).
// Everything the freeze must release on releases it automatically because
// the scan is shared with the engine: GATE_REJECTED, STAGE_JUMPED, and
// WORKFLOW_STARTED reset the floor (so post-rejection revisions are never
// frozen), a NOT-READY verdict never freezes (the repair loop must edit),
// and non-produces writes (diary, questions, contributions) never match.
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
// Deliberately NOT matched: Bash. The audit-logger hook that feeds the
// engine's invalidation scan is itself a Write/Edit PostToolUse hook - a file
// write the harness delivers as a shell command is invisible to BOTH the
// invalidation scan and this freeze, so blocking shell here would be strictly
// tighter than the invariant it protects. The freeze and the floor share one
// blind spot by construction; symmetric coverage over asymmetric strictness.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntryUnlocked } from "../tools/aidlc-audit.ts";
import {
  acquireAuditLock,
  auditFilePath,
  type ClaudeCodeHookInput,
  errorMessage,
  freshReviewReceipts,
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
  releaseAuditLock,
  resolveProjectDirFromHook,
  type StageEntry,
} from "../tools/aidlc-lib.ts";

const HOOK_NAME = "review-freeze";

// The file-writing tools whose targets the freeze inspects. Read-only tools
// never invalidate a receipt; Bash is excluded by the symmetry argument above.
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Target paths of a write-tool call. */
export function writeTargets(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
): string[] {
  if (!WRITE_TOOLS.has(toolName)) return [];
  const ti = toolInput ?? {};
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) out.push(v);
  };
  push(ti.file_path);
  push(ti.notebook_path);
  push(ti.path);
  if (Array.isArray(ti.paths)) for (const p of ti.paths) push(p);
  return out;
}

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
  receipts: { stageVerdict: string | null; unitVerdicts: Map<string, string> },
): FreezeVerdict {
  const targetUnit = producesArtifactUnit(stage, file, recordedRepos);
  if (targetUnit === undefined) return { block: false }; // not this stage's artifact
  if (stage.for_each === "unit-of-work") {
    if (targetUnit !== null) {
      // A unit-scoped write voids that unit's receipt only.
      if (receipts.unitVerdicts.get(targetUnit) === "READY") {
        return { block: true, target: file, stage: stage.slug, unit: targetUnit };
      }
      return { block: false };
    }
    // Ambiguous per-unit path: the engine fails closed by clearing EVERY unit
    // receipt, so freeze if any unit currently holds a READY receipt.
    for (const [unit, verdict] of receipts.unitVerdicts) {
      if (verdict === "READY") {
        return { block: true, target: file, stage: stage.slug, unit };
      }
    }
    return { block: false };
  }
  if (receipts.stageVerdict === "READY") {
    return { block: true, target: file, stage: stage.slug };
  }
  return { block: false };
}

// The block reason handed back through the harness's PreToolUse error
// channel. Self-explaining and redirecting: it names the invariant, the
// sanctioned route for suggestions, and the route that legitimately reopens
// the artifact, so a blocked call is a recoverable nudge, not a halt.
export function blockReason(v: FreezeVerdict): string {
  const scope = v.unit ? `stage "${v.stage}" unit "${v.unit}"` : `stage "${v.stage}"`;
  return (
    `review-freeze: "${v.target}" is a declared produces[] artifact of ${scope}, ` +
    `which holds a fresh READY review receipt. Writing it now would invalidate ` +
    `that receipt and the engine would refuse the gate (stage-protocol §12a: the ` +
    `terminal receipt ends artifact work). Present the gate instead - quote any ` +
    `reviewer suggestions there verbatim for the human to weigh. If the artifact ` +
    `genuinely needs changes, reject at the gate (or have the human request ` +
    `changes); the recorded rejection lifts this freeze and the revision then ` +
    `re-runs the §12a reviewer for a fresh receipt.`
  );
}

// --- Main ---------------------------------------------------------------------

if (import.meta.main) {
  // Deterministic off-switch: enforcement disabled entirely.
  if (process.env.AIDLC_DISABLE_REVIEW_FREEZE_HOOK === "1") process.exit(0);

  const projectDir = resolveProjectDirFromHook(import.meta.url);

  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    writeFileSync(join(healthDir, `${HOOK_NAME}.last`), isoTimestamp(), "utf-8");
  } catch {
    // Heartbeat failure is non-fatal - never let it affect the decision.
  }

  // A TTY means no harness JSON is coming (test / debug contexts) - allow.
  if (process.stdin.isTTY) process.exit(0);

  let parsed: ClaudeCodeHookInput;
  try {
    const raw: unknown = JSON.parse(await Bun.stdin.text());
    if (!isClaudeCodeHookInput(raw)) process.exit(0);
    parsed = raw;
  } catch {
    process.exit(0); // malformed stdin - fail open
  }

  const toolName = parsed.tool_name ?? "";
  const targets = writeTargets(toolName, parsed.tool_input);
  if (targets.length === 0) process.exit(0);

  // No audit ledger means no receipts to protect - the common non-AIDLC case,
  // decided before any state/graph read so the hook stays near-free outside a
  // workflow.
  try {
    if (readAllAuditShards(projectDir).length === 0) process.exit(0);
  } catch {
    process.exit(0);
  }

  let verdict: FreezeVerdict = { block: false };
  try {
    const content = readStateFile(projectDir);
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
        receipts ??= freshReviewReceipts(projectDir, content, stage);
        verdict = judgeFreeze(stage, file, recordedRepos, receipts);
        if (verdict.block) break;
      }
      if (verdict.block) break;
    }
  } catch (e) {
    recordHookDrop(projectDir, HOOK_NAME, errorMessage(e));
    process.exit(0); // state/graph unreadable or matcher failure - fail open
  }
  if (!verdict.block) process.exit(0);

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

  process.stderr.write(`${blockReason(verdict)}\n`);
  process.exit(2); // harness PreToolUse reject contract: exit 2 + stderr blocks
}
