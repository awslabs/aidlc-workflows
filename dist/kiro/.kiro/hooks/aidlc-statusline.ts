// Status line: Display aidlc workflow position in the terminal status area
// Registered via statusLine setting in settings.json
// Invoked via: bun $CLAUDE_PROJECT_DIR/.claude/hooks/aidlc-statusline.ts
import { existsSync, readFileSync } from "node:fs";
import {
  activeIntent,
  activeSpace,
  displaySlugFromDirName,
  listIntents,
  listSpaces,
  loadAgents,
  resolveProjectDirFromHook,
  stateFilePath,
} from "../tools/aidlc-lib.ts";

type Input = {
  workspace?: { project_dir?: string };
  model?: { id?: string };
  context_window?: { used_percentage?: number };
};

async function resolveProjectDir(input: Input): Promise<string> {
  // Method 1: explicit dispatcher/plugin routing.
  if (process.env.AIDLC_PROJECT_DIR) return process.env.AIDLC_PROJECT_DIR;

  // Method 2: stdin JSON (statusline-only — the host pipes workspace here).
  const fromStdin = input.workspace?.project_dir;
  if (fromStdin) return fromStdin;

  // Methods 3-5: the shared hook seam — CLAUDE_PROJECT_DIR, then script-path
  // derivation and CWD probe across ALL harness dirs (.claude/.kiro/.codex).
  // Using the seam (rather than a private .claude-hardcoded copy) keeps this
  // hook harness-neutral like the other 9 core hooks: a future kiro/codex
  // statusline resolves its own project root instead of only ever .claude.
  return resolveProjectDirFromHook(import.meta.url);
}

function abbreviateModel(modelId: string): string {
  if (!modelId) return "";
  let short = modelId;
  let prefix = "";
  // Bedrock inference-profile prefixes: regional (us./eu./apac.) or global.
  const bedrockPrefix = short.match(/^(?:us|eu|apac|global)\.anthropic\./);
  if (bedrockPrefix) {
    prefix = "BR:";
    short = short.slice(bedrockPrefix[0].length);
  }
  // Strip claude- prefix, -vN version, -YYYYMMDD date, :N suffix
  short = short
    .replace(/^claude-/, "")
    .replace(/-v\d+/, "")
    .replace(/-\d{8}/, "")
    .replace(/:\d+$/, "");
  return prefix + short;
}

function contextColor(pct: number): string {
  if (pct >= 75) return "\x1b[31m"; // red
  if (pct >= 50) return "\x1b[33m"; // yellow
  return "\x1b[32m"; // green
}

const RESET = "\x1b[0m";

const STAGE_DISPLAY: Record<string, string> = {
  "workspace-scaffold": "Workspace Scaffold",
  "workspace-detection": "Workspace Detection",
  "state-init": "State Init",
  "intent-capture": "Intent Capture",
  "market-research": "Market Research",
  feasibility: "Feasibility",
  "scope-definition": "Scope Definition",
  "team-formation": "Team Formation",
  "rough-mockups": "Rough Mockups",
  "approval-handoff": "Approval & Handoff",
  "reverse-engineering": "Reverse Engineering",
  "practices-discovery": "Practices Discovery",
  "requirements-analysis": "Requirements Analysis",
  "user-stories": "User Stories",
  "refined-mockups": "Refined Mockups",
  "application-design": "Application Design",
  "units-generation": "Units Generation",
  "delivery-planning": "Delivery Planning",
  "functional-design": "Functional Design",
  "nfr-requirements": "NFR Requirements",
  "nfr-design": "NFR Design",
  "infrastructure-design": "Infrastructure Design",
  "code-generation": "Code Generation",
  "build-and-test": "Build and Test",
  "ci-pipeline": "CI Pipeline",
  "deployment-pipeline": "Deployment Pipeline",
  "environment-provisioning": "Env Provisioning",
  "deployment-execution": "Deployment Execution",
  "observability-setup": "Observability Setup",
  "incident-response": "Incident Response",
  "performance-validation": "Performance Validation",
  "feedback-optimization": "Feedback & Optimization",
};

// Agent display names derive from `.claude/agents/*.md` frontmatter via
// loadAgents(). The `orchestrator` pseudo-entry is seeded explicitly —
// state files can carry `Active Agent: orchestrator` during orchestrator-
// driven transitions, but there's no corresponding agent file.
let _agentDisplayCache: Record<string, string> | null = null;

function agentDisplayMap(): Record<string, string> {
  if (!_agentDisplayCache) {
    const map: Record<string, string> = { orchestrator: "Orchestrator" };
    try {
      for (const a of loadAgents()) map[a.slug] = a.display_name;
    } catch {
      // Hooks fail open in this repo by design: a broken agent roster must
      // never kill the statusline.
    }
    _agentDisplayCache = map;
  }
  return _agentDisplayCache;
}

function extractField(text: string, label: string): string {
  // Match the Markdown list field pattern used throughout aidlc-state.md:
  //   - **Lifecycle Phase**: IDEATION
  // Anchoring on "^-\s*\*\*LABEL\*\*:" prevents prose lines that happen to contain
  // the label (e.g. "> The Lifecycle Phase: OPERATION was added in v2.") from
  // hijacking the displayed value.
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^-\\s*\\*\\*${escaped}\\*\\*:[^\\S\\n]*([^\\n]*)`, "m");
  const m = text.match(re);
  return m ? m[1].replace(/\r$/, "").trim() : "";
}

function phaseProgress(text: string, phase: string): { done: number; total: number } {
  if (!phase) return { done: 0, total: 0 };
  // Normalize: take the first whitespace-delimited token and uppercase it, so
  // values like "INCEPTION (finalizing)" or mixed-case headings still match.
  const phaseToken = phase.trim().split(/\s+/)[0].toUpperCase();
  if (!phaseToken) return { done: 0, total: 0 };
  const lines = text.split(/\r?\n/);
  let inPhase = false;
  let total = 0;
  let done = 0;
  for (const line of lines) {
    if (line.startsWith("### ") && line.toUpperCase().includes(`${phaseToken} PHASE`)) {
      inPhase = true;
      continue;
    }
    if (line.startsWith("### ")) {
      inPhase = false;
    }
    if (!inPhase) continue;
    if (!line.startsWith("- [")) continue;
    if (line.includes("SKIP") || line.includes("[S]")) continue;
    total++;
    if (line.startsWith("- [x]")) done++;
  }
  return { done, total };
}

function progressBar(completed: number, total: number): string {
  if (!total || total <= 0) return "";
  let filled = Math.floor((completed * 10) / total);
  if (filled > 10) filled = 10;
  const empty = 10 - filled;
  return `[${"\u2593".repeat(filled)}${"\u2591".repeat(empty)}]`;
}

function buildRightSide(modelShort: string, ctxInt: number | null): { plain: string; formatted: string } {
  const parts: string[] = [];
  const fmtParts: string[] = [];
  if (modelShort) {
    parts.push(modelShort);
    fmtParts.push(modelShort);
  }
  if (ctxInt !== null) {
    parts.push(`ctx:${ctxInt}%`);
    const color = contextColor(ctxInt);
    fmtParts.push(`${color}ctx:${ctxInt}%${RESET}`);
  }
  return { plain: parts.join(" "), formatted: fmtParts.join(" ") };
}

// The "<space> · <intent-slug> · " orientation prefix (vision §3 / §11.2): the
// statusline always tells the user which world they're in. Two invisibility
// rules keep it out of the single-team user's face:
//   - the "<space> ·" segment renders ONLY when more than one space exists
//     (listSpaces() always reports at least the always-present "default", so a
//     single-team user — exactly one space — never sees the word "space");
//   - the intent slug renders whenever a per-intent record is active. On the
//     flat-legacy / pre-auto-birth layout activeIntent() returns null, so the
//     prefix is empty and the line reads exactly as it did before the workspace
//     move (a flat project is unchanged).
// The intent SLUG comes from the registry (rename-stable) when the active
// record has a registry row; otherwise it falls back to the record dir name
// minus its `-id8` disambiguator (an orphan / hand-created record).
function orientationPrefix(projectDir: string): string {
  const space = activeSpace(projectDir);
  const activeDir = activeIntent(projectDir, space);
  if (activeDir === null) return ""; // flat-legacy / no record → no prefix
  const intents = listIntents(projectDir, space);
  const match = intents.find((i) => i.dirName === activeDir);
  const slug = match?.slug || displaySlugFromDirName(activeDir);
  const segments: string[] = [];
  if (listSpaces(projectDir).length > 1) segments.push(space);
  segments.push(slug);
  return `${segments.join(" · ")} · `;
}

function printLine(left: string, right: { plain: string; formatted: string }): void {
  if (!right.formatted) {
    process.stdout.write(`${left}\n`);
    return;
  }
  const cols = process.stdout.columns ?? 0;
  if (cols > 0) {
    let pad = cols - left.length - right.plain.length;
    if (pad < 2) pad = 2;
    process.stdout.write(`${left}${" ".repeat(pad)}${right.formatted}\n`);
  } else {
    process.stdout.write(`${left} | ${right.formatted}\n`);
  }
}

async function main(stdinText: string): Promise<void> {
  // Skip stdin read when stdin is a TTY — Claude Code always pipes JSON,
  // never runs the statusline with a terminal attached. Without this guard
  // a direct run / test / debug-mode pipeline would block on terminal input.
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

  const stateFile = projectDir ? stateFilePath(projectDir) : "";
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
  const agentDisplay = agentDisplayMap()[agent] ?? agent;
  const { done, total } = phaseProgress(state, phase);
  const bar = total > 0 ? progressBar(done, total) : "";
  const phaseProg = total > 0 ? `${done}/${total}` : "";

  if (!phase) {
    printLine("[AIDLC] ready", right);
    return;
  }
  // Orientation prefix — only computed once a record is active (the state file
  // resolved above), so the empty-state "[AIDLC] ready" lines never carry it.
  const prefix = orientationPrefix(projectDir);
  if (status === "Completed" || status === "Complete") {
    // At workflow completion, show a full bar even if Lifecycle Phase no longer
    // resolves to a real heading (e.g. a future caller writes a "COMPLETE"
    // sentinel or leaves the phase stale). Keep the natural bar when phaseProgress
    // could resolve it so tests that seed a real terminal phase still see 10/10.
    const completeBar = bar || `[${"▓".repeat(10)}]`;
    printLine(`[AIDLC] ${prefix}COMPLETE ${completeBar}`, right);
    return;
  }

  let output = `[AIDLC] ${prefix}${phase}`;
  if (bar) output += ` ${bar}`;
  if (phaseProg) output += ` ${phaseProg}`;
  if (stageDisplay) output += ` > ${stageDisplay}`;
  if (agentDisplay) output += ` -- ${agentDisplay}`;

  printLine(output, right);
}

export async function run(input: string): Promise<number> {
  await main(process.stdin.isTTY ? "" : input);
  return 0;
}

if (import.meta.main) {
  process.exit(await run(await Bun.stdin.text()));
}
