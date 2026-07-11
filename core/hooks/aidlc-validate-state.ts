// PreCompact hook: Validate workflow state structure and emit SESSION_COMPACTED
// before Claude Code compacts the conversation context. The audit event here
// (and not in SessionStart source=compact) ensures a single, timestamped record
// of compaction — fired at the real compaction moment, with full state-file
// context available.
//
// Also writes aidlc-docs/.aidlc-recovery.md as a breadcrumb for the orchestrator
// to detect compaction-related state corruption on the next turn.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAuditEntry } from "../tools/aidlc-audit.ts";
import {
  auditFilePath,
  errorMessage,
  getField,
  hooksHealthDir,
  isoTimestamp,
  recordHookDrop,
  recoveryFilePath,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";

export async function run(_input: string): Promise<number> {
const projectDir = resolveProjectDirFromHook(import.meta.url);
const stateFile = stateFilePath(projectDir);

// Write health heartbeat
const healthDir = hooksHealthDir(projectDir);
mkdirSync(healthDir, { recursive: true });
writeFileSync(join(healthDir, "validate-state.last"), isoTimestamp(), "utf-8");

if (!existsSync(stateFile)) return 0;

const content = readFileSync(stateFile, "utf-8");

// Validate state file has required sections
const missing: string[] = [];
if (!content.includes("## Stage Progress")) missing.push("Stage Progress");
if (!content.includes("## Current Status")) missing.push("Current Status");

if (missing.length > 0) {
  console.error(`WARNING: aidlc-state.md missing sections: ${missing.join(", ")}`);
}

const stateStatus = missing.length > 0
  ? `INVALID — missing sections: ${missing.join(", ")}`
  : "valid (all required sections present)";

// Write recovery breadcrumb so the orchestrator can detect compaction-related state corruption
const currentStage = getField(content, "Current Stage") ?? "";
const timestamp = isoTimestamp();
const recoveryFile = recoveryFilePath(projectDir);
writeFileSync(
  recoveryFile,
  `# AIDLC Recovery Breadcrumb\n**Last validated**: ${timestamp}\n**Current stage**: ${currentStage}\n**State file**: ${stateStatus}\n`,
  "utf-8"
);

// Emit SESSION_COMPACTED if an audit file exists for this workflow.
const auditFile = auditFilePath(projectDir);
if (existsSync(auditFile)) {
  try {
    appendAuditEntry(
      "SESSION_COMPACTED",
      {
        "Current Stage": currentStage,
        "State Validity": missing.length > 0 ? "invalid" : "valid",
      },
      projectDir
    );
  } catch (e) {
    recordHookDrop(projectDir, "validate-state", errorMessage(e));
    // Non-fatal — recovery breadcrumb is the primary signal.
  }
}
return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
