// Status line: Display aidlc workflow position in the terminal status area
// Registered via statusLine setting in settings.json
// Invoked via: {{INVOKE}} engine statusline
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SPACE = "default";
const KNOWN_HARNESS_DIRS = [
  ".claude",
  ".kiro",
  ".codex",
  ".cursor",
  ".aidlc",
] as const;

type IntentRow = {
  uuid?: unknown;
  slug?: unknown;
  status?: unknown;
  dirName?: unknown;
};

type StatuslineIntent = {
  slug: string;
  dirName: string | null;
};

function resolveStatuslineProjectDir(
  importMetaUrl: string,
  workspaceProjectDir?: string,
): string {
  for (const value of [
    process.env.AIDLC_PROJECT_DIR,
    workspaceProjectDir,
    process.env.CLAUDE_PROJECT_DIR,
  ]) {
    if (value) {
      return isAbsolute(value) ? value : resolve(process.cwd(), value);
    }
  }
  const scriptDir = dirname(fileURLToPath(importMetaUrl));
  if (basename(scriptDir) === "hooks") {
    const harnessRoot = dirname(scriptDir);
    if (basename(harnessRoot).startsWith(".")) return dirname(harnessRoot);
  }
  const cwd = process.cwd();
  for (const harness of KNOWN_HARNESS_DIRS) {
    if (existsSync(join(cwd, harness))) return cwd;
  }
  return cwd;
}

function workspaceRoot(projectDir: string): string {
  return join(projectDir, "aidlc");
}

function activeSpace(projectDir: string): string {
  try {
    const value = readFileSync(
      join(workspaceRoot(projectDir), "active-space"),
      "utf-8",
    ).trim();
    if (value) return value;
  } catch {
    // The default space is valid on a fresh shell.
  }
  return DEFAULT_SPACE;
}

function spacesRoot(projectDir: string): string {
  return join(workspaceRoot(projectDir), "spaces");
}

function intentsDir(projectDir: string, space: string): string {
  return join(spacesRoot(projectDir), space, "intents");
}

function listIntentDirs(projectDir: string, space: string): string[] {
  try {
    return readdirSync(intentsDir(projectDir, space))
      .filter((name) =>
        existsSync(join(intentsDir(projectDir, space), name, "aidlc-state.md"))
      )
      .sort();
  } catch {
    return [];
  }
}

function activeIntent(
  projectDir: string,
  space = activeSpace(projectDir),
): string | null {
  const root = intentsDir(projectDir, space);
  try {
    const value = readFileSync(join(root, "active-intent"), "utf-8").trim();
    if (value && existsSync(join(root, value, "aidlc-state.md"))) return value;
  } catch {
    // Fall through to the lone-record rule.
  }
  const dirs = listIntentDirs(projectDir, space);
  return dirs.length === 1 ? dirs[0] : null;
}

// The statusline is a read-only display on the hot path, so it carries LOCAL
// lite copies of the lib's session-selection helpers instead of importing
// aidlc-lib.ts (startup cost). Semantics mirror validSessionId /
// readSessionBinding / resolveWorkflowSelection / stateFilePathForSelection:
// a per-session binding (written by the session hooks) pins the displayed
// space/intent; anything malformed or stale degrades to the shared cursors.
type StatuslineSelection = { space: string; intent: string | null };

function validSessionId(sessionId: string | undefined): string | null {
  const raw = sessionId ?? "";
  const safe = raw
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  if (!safe || safe === "." || safe === "..") return null;
  return safe === raw ? raw : null;
}

function readSessionBinding(
  projectDir: string,
  sessionId: string,
): StatuslineSelection | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(
        join(
          workspaceRoot(projectDir),
          ".aidlc-sessions",
          `${sessionId}.binding.json`,
        ),
        "utf-8",
      ),
    );
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const space = record.space;
    const intent = record.intent;
    if (typeof space !== "string" || !/^[a-z][a-z0-9-]*$/.test(space)) {
      return null;
    }
    if (
      intent !== null &&
      (typeof intent !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(intent))
    ) {
      return null;
    }
    if (typeof record.boundAt !== "string" || record.boundAt.length === 0) {
      return null;
    }
    if (
      intent !== null &&
      !existsSync(join(intentsDir(projectDir, space), intent, "aidlc-state.md"))
    ) {
      return null;
    }
    return { space, intent: intent as string | null };
  } catch {
    return null;
  }
}

function resolveWorkflowSelection(
  projectDir: string,
  sessionId?: string,
): StatuslineSelection {
  const binding = sessionId ? readSessionBinding(projectDir, sessionId) : null;
  if (binding) return binding;
  const space = activeSpace(projectDir);
  return { space, intent: activeIntent(projectDir, space) };
}

function stateFilePathForSelection(
  projectDir: string,
  selection: StatuslineSelection,
): string {
  const root = selection.intent === null
    ? intentsDir(projectDir, selection.space)
    : join(intentsDir(projectDir, selection.space), selection.intent);
  return join(root, "aidlc-state.md");
}

function listSpaces(projectDir: string): string[] {
  const names = new Set<string>([DEFAULT_SPACE]);
  try {
    for (const name of readdirSync(spacesRoot(projectDir))) {
      if (statSync(join(spacesRoot(projectDir), name)).isDirectory()) {
        names.add(name);
      }
    }
  } catch {
    // Fresh workspace: default only.
  }
  return [...names].sort();
}

function recordDirMatches(row: IntentRow, dirName: string): boolean {
  if (typeof row.dirName === "string") return row.dirName === dirName;
  if (typeof row.slug !== "string" || typeof row.uuid !== "string") return false;
  const id = row.uuid.replace(/-/g, "").slice(-16);
  return dirName === `${row.slug}-${id}`;
}

function displaySlugFromDirName(dirName: string): string {
  const dated = /^\d{6}-(.+)$/.exec(dirName);
  return dated ? dated[1] : dirName.replace(/-[0-9a-f]+$/, "");
}

function listIntents(
  projectDir: string,
  space = activeSpace(projectDir),
): StatuslineIntent[] {
  const dirs = listIntentDirs(projectDir, space);
  let rows: IntentRow[] = [];
  try {
    const parsed = JSON.parse(
      readFileSync(join(intentsDir(projectDir, space), "intents.json"), "utf-8"),
    );
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    // Orphan directories still appear below.
  }
  const claimed = new Set<string>();
  const intents = rows.map((row): StatuslineIntent => {
    const dirName = dirs.find((dir) => recordDirMatches(row, dir)) ?? null;
    if (dirName) claimed.add(dirName);
    return {
      slug: typeof row.slug === "string"
        ? row.slug
        : dirName
        ? displaySlugFromDirName(dirName)
        : "",
      dirName,
    };
  });
  for (const dirName of dirs) {
    if (!claimed.has(dirName)) {
      intents.push({ slug: displaySlugFromDirName(dirName), dirName });
    }
  }
  return intents;
}

function agentsDir(projectDir: string): string | null {
  if (process.env.AIDLC_AGENTS_DIR) return process.env.AIDLC_AGENTS_DIR;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  if (basename(scriptDir) === "hooks") {
    const shipped = join(dirname(scriptDir), "agents");
    if (existsSync(shipped)) return shipped;
  }
  const declared = process.env.AIDLC_HARNESS_DIR;
  if (declared && existsSync(join(projectDir, declared, "agents"))) {
    return join(projectDir, declared, "agents");
  }
  for (const harness of KNOWN_HARNESS_DIRS) {
    const candidate = join(projectDir, harness, "agents");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function frontmatterScalar(body: string, key: string): string {
  const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
  return new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1].trim() ??
    "";
}

function loadAgentDisplayMap(projectDir: string): Record<string, string> {
  const dir = agentsDir(projectDir);
  if (!dir) return {};
  const map: Record<string, string> = {};
  try {
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
      const body = readFileSync(join(dir, file), "utf-8");
      const name = frontmatterScalar(body, "name");
      const display = frontmatterScalar(body, "display_name");
      if (!name || !display) continue;
      if (Object.hasOwn(map, name)) return {};
      map[name] = display;
    }
  } catch {
    return {};
  }
  return map;
}

type Input = {
  session_id?: string;
  workspace?: { project_dir?: string };
  model?: { id?: string };
  context_window?: { used_percentage?: number };
  // The live transcript path the host pipes in. Accepted for completeness -
  // costSegment reads the rolled-up ledger, not the transcript, so this is not
  // required for the cost render.
  transcript_path?: string;
};

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
  "domain-design": "Domain Design",
  "contract-design": "Contract Design",
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
function agentDisplayMap(projectDir: string): Record<string, string> {
  return {
    orchestrator: "Orchestrator",
    ...loadAgentDisplayMap(projectDir),
  };
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

// covers: function:fmtTokens
// Compact token count: 1234 -> "1.2k", 3_400_000 -> "3.4M". Sub-1000 values
// render as their integer. Negative / non-finite guarded to "0". One decimal
// place at k/M scale, trailing ".0" trimmed ("2k" not "2.0k").
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const trim = (s: string): string => s.replace(/\.0$/, "");
  if (n >= 1e6) return `${trim((n / 1e6).toFixed(1))}M`;
  if (n >= 1e3) return `${trim((n / 1e3).toFixed(1))}k`;
  return String(Math.round(n));
}

// covers: function:costSegment
// The current workflow/session cost segment: `up<in> down<out> $<usd>`. Reads
// the rolled-up ledger (FAST - the fold hooks already parsed the transcript; we
// never re-parse it here). When the total USD is
// null/zero/unknown (e.g. only unknown models), render tokens only - NEVER a
// fabricated "$0". Renders ONLY when the ledger exists and carries data: an
// install without the Claude fold hook (Kiro/Codex/opencode, or an upstream
// session that never folded) sees no ledger and gets "", so the statusline is
// byte-unchanged from before this feature.
//
// The ledger advances on each fold, so this segment reflects usage through the
// last folded turn - it can lag the in-flight turn by up to one fold. That is
// acceptable for a statusline. Returns "" on ANY failure - the statusline must
// never error out of a cost read. `transcriptPath` selects the current session's
// workflow-scoped aggregate; the transcript itself is never parsed here.
export function costSegment(
  projectDir: string,
  transcriptPath?: string,
  sessionId?: string,
): string {
  try {
    if (!projectDir) return "";
    const ledger = join(
      projectDir,
      "aidlc",
      ".aidlc-sessions",
      "usage-ledger.json",
    );
    if (!existsSync(ledger)) return "";
    const require = createRequire(import.meta.url);
    const { sessionUsageAggregate } = require(
      "../tools/aidlc-usage.ts",
    ) as typeof import("../tools/aidlc-usage.ts");
    const t = sessionUsageAggregate(
      projectDir,
      transcriptPath,
      undefined,
      sessionId,
    )?.totals;
    if (!t) return "";
    const input = t.tokens?.input ?? 0;
    const output = t.tokens?.output ?? 0;
    if (input <= 0 && output <= 0 && !(t.usd > 0)) return "";
    let seg = `↑${fmtTokens(input)} ↓${fmtTokens(output)}`;
    if (typeof t.usd === "number" && Number.isFinite(t.usd) && t.usd > 0) {
      seg += ` $${t.usd.toFixed(2)}`;
    }
    return seg;
  } catch {
    return "";
  }
}

function buildRightSide(
  modelShort: string,
  ctxInt: number | null,
  cost: string,
): { plain: string; formatted: string } {
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
  if (cost) {
    parts.push(cost);
    fmtParts.push(cost);
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
//     flat-legacy / pre-auto-create layout activeIntent() returns null, so the
//     prefix is empty and the line reads exactly as it did before the workspace
//     move (a flat project is unchanged).
// The intent SLUG comes from the registry (rename-stable) when the active
// record has a registry row; otherwise it falls back to the record dir name
// minus its `-id8` disambiguator (an orphan / hand-created record).
function orientationPrefix(projectDir: string, sessionId?: string): string {
  const selection = resolveWorkflowSelection(projectDir, sessionId);
  const space = selection.space;
  const activeDir = selection.intent;
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

  const projectDir = resolveStatuslineProjectDir(
    import.meta.url,
    input.workspace?.project_dir,
  );
  const sessionId = validSessionId(input.session_id) ?? undefined;
  const modelShort = abbreviateModel(input.model?.id ?? "");
  const ctxRaw = input.model?.id ? input.context_window?.used_percentage : undefined;
  const ctxInt = typeof ctxRaw === "number" ? Math.round(ctxRaw) : null;
  const cost = costSegment(projectDir, input.transcript_path, sessionId);
  const right = buildRightSide(modelShort, ctxInt, cost);

  const selection = projectDir
    ? resolveWorkflowSelection(projectDir, sessionId)
    : null;
  const stateFile =
    projectDir && selection
      ? stateFilePathForSelection(projectDir, selection)
      : "";
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
  const agentDisplay = agentDisplayMap(projectDir)[agent] ?? agent;
  const { done, total } = phaseProgress(state, phase);
  const bar = total > 0 ? progressBar(done, total) : "";
  const phaseProg = total > 0 ? `${done}/${total}` : "";

  if (!phase) {
    printLine("[AIDLC] ready", right);
    return;
  }
  // Orientation prefix — only computed once a record is active (the state file
  // resolved above), so the empty-state "[AIDLC] ready" lines never carry it.
  const prefix = orientationPrefix(projectDir, sessionId);
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
