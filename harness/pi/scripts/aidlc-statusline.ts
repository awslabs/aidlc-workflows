// Status line: Display AI-DLC workflow position in the terminal status area
// Registered via statusLine setting in settings.json
// Invoked via: bun $PI_PROJECT_DIR/.pi/scripts/aidlc-statusline.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ── Input from Pi (piped JSON on stdin) ───────────────────────────────────────
type Input = {
  workspace?: { project_dir?: string };
  model?: { id?: string; context_window?: { used_percentage?: number } };
};

// ── Helpers ────────────────────────────────────────────────────────────────────

async function resolveProjectDir(input: Input): Promise<string> {
  // 1. stdin JSON workspace.project_dir (Pi passes this)
  if (input.workspace?.project_dir) {
    return input.workspace.project_dir;
  }
  // 2. PI_PROJECT_DIR env var
  if (process.env.PI_PROJECT_DIR) {
    return process.env.PI_PROJECT_DIR;
  }
  // 3. Derive from script location (this file lives in .pi/scripts/)
  try {
    const scriptDir = join(fileURLToPath(import.meta.url), "..");
    return join(scriptDir, "..");
  } catch {
    // fall through
  }
  // 4. CWD fallback
  return process.cwd();
}

function abbreviateModel(modelId: string): string {
  // Bedrock prefix
  if (modelId.startsWith("us.anthropic.") || modelId.startsWith("eu.anthropic.")) {
    const short = modelId.replace(/^(us|eu)\.anthropic\./, "BR:");
    return short;
  }
  // Other providers - take last segment
  const parts = modelId.split(".");
  return parts[parts.length - 1];
}

function contextColor(pct: number): string {
  if (pct >= 90) return "\x1b[31m"; // red
  if (pct >= 70) return "\x1b[33m"; // yellow
  return "\x1b[32m"; // green
}

const RESET = "\x1b[0m";

// ── Stage display names ───────────────────────────────────────────────────────
const STAGE_DISPLAY: Record<string, string> = {
  "bootstrap": "Bootstrap",
  "detect-workspace": "Detect Workspace",
  "scaffold-dirs": "Scaffold Dirs",
  "validate-intent": "Validate Intent",
  "scope-detection": "Scope Detection",
  "feasibility": "Feasibility",
  "practices-discovery": "Practices Discovery",
  "practices-promotion": "Practices Promotion",
  "requirements-analysis": "Requirements Analysis",
  "architecture-design": "Architecture Design",
  "task-planning": "Task Planning",
  "gate-1-approval": "Gate 1 Approval",
  "reverse-engineering": "Reverse Engineering",
  "unit-implementation": "Unit Implementation",
  "unit-testing": "Unit Testing",
  "code-review": "Code Review",
  "integration": "Integration",
  "ci-pipeline": "CI Pipeline",
  "gate-2-approval": "Gate 2 Approval",
  "deployment-prep": "Deployment Prep",
  "production-deploy": "Production Deploy",
  "observability": "Observability",
  "runbook": "Runbook",
  "gate-3-approval": "Gate 3 Approval",
  "data-migration": "Data Migration",
  "rollback-plan": "Rollback Plan",
  "stakeholder-signoff": "Stakeholder Signoff",
  "workflow-complete": "Workflow Complete",
};

// ── Extract field from state markdown ─────────────────────────────────────────
function extractField(text: string, label: string): string {
  const regex = new RegExp(`^-\\s*\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*:\\s*(.+)$`, "m");
  const match = text.match(regex);
  return match ? match[1].replace(/\r$/, "").trim() : "";
}

// ── Phase progress: count checkboxes under current phase heading ──────────────
function phaseProgress(text: string, phase: string): { done: number; total: number } {
  const phaseHeading = `### ${phase} PHASE`;
  const headingIdx = text.indexOf(phaseHeading);
  if (headingIdx === -1) return { done: 0, total: 0 };

  // Find the next phase heading or end of file
  const nextHeadingIdx = text.indexOf("### ", headingIdx + phaseHeading.length);
  const section = nextHeadingIdx === -1 ? text.slice(headingIdx) : text.slice(headingIdx, nextHeadingIdx);

  // Count [x] and [ ] checkboxes, excluding [S] (jump-skipped) and SKIP
  const checkboxRegex = /^\s*-\s*\[([ xS])\]\s*(?:\[S\])?\s*(?:\(SKIP\))?/gm;
  let done = 0;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = checkboxRegex.exec(section)) !== null) {
    const state = match[1];
    if (state === "x") done++;
    if (state === "x" || state === " ") total++;
  }
  return { done, total };
}

// ── Progress bar: 10-cell unicode ▓/░ ────────────────────────────────────────
function progressBar(completed: number, total: number): string {
  if (total === 0) return "";
  const filled = Math.floor((completed * 10) / total);
  const empty = 10 - filled;
  return "[" + "▓".repeat(filled) + "░".repeat(empty) + "]";
}

// ── Right side: model + context % ─────────────────────────────────────────────
function buildRightSide(modelShort: string, ctxInt: number | null): { plain: string; formatted: string } {
  const modelPart = modelShort ? `${modelShort}` : "";
  const ctxPart = ctxInt !== null ? `${ctxInt}%` : "";
  const parts = [modelPart, ctxPart].filter(Boolean);
  const plain = parts.join(" | ");
  const formatted = ctxInt !== null
    ? `${modelPart} | ${contextColor(ctxInt)}${ctxPart}${RESET}`
    : modelPart;
  return { plain, formatted };
}

// ── Print status line with left/right alignment ───────────────────────────────
function printLine(left: string, right: { plain: string; formatted: string }): void {
  // Pi pipes stdout, so process.stdout.columns is undefined → cols=0
  // Use the ` | ` separator fallback (same as Claude Code)
  const separator = " | ";
  const out = left + separator + right.formatted;
  console.log(out);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Skip stdin read when stdin is a TTY — Pi always pipes JSON
  const stdinText = process.stdin.isTTY ? "" : await Bun.stdin.text();
  let input: Input = {};
  try {
    input = stdinText ? JSON.parse(stdinText) : {};
  } catch {
    // ignore malformed stdin; fall through to derived project dir
  }

  const projectDir = await resolveProjectDir(input);
  const modelShort = abbreviateModel(input.model?.id ?? "");
  const ctxRaw = input.model?.id ? input.context_window?.used_percentage : undefined;
  const ctxInt = typeof ctxRaw === "number" ? Math.round(ctxRaw) : null;
  const right = buildRightSide(modelShort, ctxInt);

  const stateFile = projectDir ? join(projectDir, "aidlc-docs", "aidlc-state.md") : "";
  if (!stateFile || !existsSync(stateFile)) {
    printLine("[AIDLC] ready", right);
    return;
  }

  const state = readFileSync(stateFile, "utf-8");
  const phase = extractField(state, "Lifecycle Phase");
  const stage = extractField(state, "Current Stage");
  const agent = extractField(state, "Active Agent");
  const statusMatch = state.match(/^-\s*\*\*Status\*\*:\s*(.+)$/m);
  const status = statusMatch ? statusMatch[1].replace(/\r$/, "").trim() : "";

  const stageDisplay = STAGE_DISPLAY[stage] ?? stage;
  const agentDisplay = agent?.replace(/-agent$/, "") ?? "";
  const { done, total } = phaseProgress(state, phase);
  const bar = total > 0 ? progressBar(done, total) : "";
  const phaseProg = total > 0 ? `${done}/${total}` : "";
  const pct = total > 0 ? `${Math.round((done / total) * 100)}%` : "";

  if (!phase) {
    printLine("[AIDLC] ready", right);
    return;
  }
  if (status === "Completed" || status === "Complete") {
    const completeBar = bar || `[${"▓".repeat(10)}]`;
    printLine(`[AIDLC] COMPLETE ${completeBar} 100%`, right);
    return;
  }

  let output = `[AIDLC] ${phase}`;
  if (bar) output += ` ${bar}`;
  if (phaseProg) output += ` ${phaseProg}`;
  if (pct) output += ` ${pct}`;
  if (stageDisplay) output += ` > ${stageDisplay}`;
  if (agentDisplay) output += ` -- ${agentDisplay}`;

  printLine(output, right);
}

await main();