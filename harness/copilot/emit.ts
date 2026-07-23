// harness/copilot/emit.ts — the GitHub Copilot (VS Code agent mode) emission plugin.
//
// The unified packager copies core/ → dist/copilot/.github/ (rules land under
// .github/rules/, NO rename), compiles the stage graph, and runs the standard
// runner-gen into .github/skills/ (skipRunnerGen:false). It then calls this
// emit() for the two Copilot-only structural transforms the declarative copy
// pass cannot express:
//   1. The 14 core agent .md personas → Copilot-native .agent.md frontmatter
//      (name / description / tools / user-invocable; model OMITTED per ADR-004's
//      null projection). The packager already COPIED core/agents/*.md into
//      .github/agents/ (as the source runner-gen's loadAgents() reads to validate
//      stage lead/support slugs); emit() clean-sweeps that dir and replaces the
//      core .md with the transposed .agent.md.
//   2. A single .github/hooks/hooks.json wiring the seven lifecycle events to the
//      aidlc-copilot-adapter shim (the codex single-hooks.json pattern).
//
// Modeled on harness/codex/emit.ts (parseAgentMd + tier projection + clean-sweep).
// The ONE prose transform is ctx.substituteToken ({{HARNESS_DIR}} → .github);
// there is no rules-rename on this harness (rulesRename:null).
//
// The onboarding doc (root AGENTS.md) is rendered here too — the codex pattern —
// from the shared skeleton core/templates/onboarding.md with Copilot's fills.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmitContext } from "../../scripts/manifest-types.ts";
import { renderOnboarding } from "../../scripts/onboarding.ts";
import onboardingFills from "./onboarding.fills.ts";
import { projectTier } from "../../core/tools/aidlc-tiers.ts";

// ---------------------------------------------------------------------------
// Hook wiring — one JSON file registering the seven lifecycle events Copilot
// delivers, each dispatched to the adapter shim with its <target> arg. VS Code
// IGNORES matcher values, so no matchers are emitted: the adapter gates dispatch
// by (normalized) tool name in code (see aidlc-copilot-adapter.ts).
// ---------------------------------------------------------------------------
const HOOK_WIRING: ReadonlyArray<{ event: string; target: string }> = [
  { event: "SessionStart", target: "session-start" },
  { event: "UserPromptSubmit", target: "user-prompt-submit" },
  { event: "PreToolUse", target: "pre-tool-use" },
  { event: "PostToolUse", target: "post-tool-use" },
  { event: "PreCompact", target: "pre-compact" },
  { event: "SubagentStop", target: "subagent-stop" },
  { event: "Stop", target: "stop" },
];

const adapterCmd = (harnessDir: string, target: string) =>
  `bun ${harnessDir}/hooks/aidlc-copilot-adapter.ts ${target}`;

function emitHooksJson(harnessDir: string): string {
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const { event, target } of HOOK_WIRING) {
    hooks[event] ??= [];
    hooks[event].push({
      hooks: [{ type: "command", command: adapterCmd(harnessDir, target) }],
    });
  }
  return JSON.stringify({ hooks }, null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Copilot tool-name allowlist. The Copilot-native tool vocabulary the core hooks
// are wired to normalize (system-architecture.md §4.1) — granting exactly this
// set keeps every agent able to read/search/edit/run while the adapter maps each
// call back to the Claude-Code name the core hooks key on. The `agent` tool is
// intentionally absent: every core persona declares `disallowedTools: Task`
// (no sub-delegation), so no agent gets a subagent roster (`agents:`) either —
// that roster is the orchestrator's, and the orchestrator is the /aidlc SKILL,
// not one of these 14 leaf agents.
const COPILOT_TOOLS: readonly string[] = [
  "runTerminalCommand",
  "editFiles",
  "createFile",
  "readFile",
  "listDirectory",
  "fileSearch",
  "textSearch",
  "applyPatch",
];

// --- Agent frontmatter parse (matches the codex/packager reader) --------------
function parseAgentMd(raw: string): { fm: Record<string, string>; body: string } {
  // BOM tolerance, matching the packager's agent reader and the rule parser.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  let current: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) {
      current = kv[1];
      fm[current] = kv[2].replace(/^>\s*$/, "");
    } else if (current && /^\s+\S/.test(line)) {
      if (!line.trim().startsWith("-")) fm[current] = `${fm[current]} ${line.trim()}`.trim();
    }
  }
  return { fm, body: raw.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// emit() — the manifest entry point.
// ---------------------------------------------------------------------------
export default function emit(ctx: EmitContext): void {
  // tierCap is pre-resolved by the packager; emit MUST NOT re-resolve it — every
  // projection (declarative and emit-owned) must use the SAME cap.
  const { coreRoot, distRoot, harnessDir, substituteToken, tierCap } = ctx;
  const GITHUB_ROOT = join(distRoot, harnessDir);
  const AGENTS_DST = join(GITHUB_ROOT, "agents");
  const HOOKS_JSON = join(GITHUB_ROOT, "hooks", "hooks.json");

  // The copilot prose transform is token substitution ONLY — no rules-rename
  // (rulesRename:null; the method rule layers land at .github/rules/ verbatim).
  const rewriteProse = (s: string): string => substituteToken(s);

  // --- Transpose one core agent .md → a Copilot .agent.md ---------------------
  // Copilot-native frontmatter: name, description, tools (allowlist),
  // user-invocable:false. The `model:` key is OMITTED (null projection, ADR-004):
  // the agent inherits the session model. The core `tier:` line is READ (so an
  // authoring bug — an agent without a tier — fails the build loudly, matching
  // codex), projected via projectTier to prove the value is a known tier, and
  // then discarded because copilot projects null for every tier.
  function emitAgentMd(mdPath: string): string {
    const raw = readFileSync(mdPath, "utf-8");
    const { fm, body } = parseAgentMd(raw);
    const name = (fm.name ?? "").trim();
    if (!name) throw new Error(`${mdPath}: agent frontmatter has no name: line.`);
    const description = (fm.description ?? "").replace(/\s+/g, " ").trim();
    const tier = fm.tier?.trim();
    if (!tier) throw new Error(`${mdPath}: agent frontmatter has no tier: line.`);
    const proj = projectTier(tier, "copilot", tierCap); // throws on unknown tier
    // model is null for every copilot tier today — assert the contract so a
    // future non-null projection surfaces here (where the field would need to be
    // emitted) rather than being silently dropped.
    const modelLine = proj.model !== null ? `model: ${JSON.stringify(proj.model)}\n` : "";
    const toolsLine = `tools: [${COPILOT_TOOLS.join(", ")}]`;
    const instructions = rewriteProse(body).trimEnd();
    return (
      `---\n` +
      `name: ${name}\n` +
      `description: ${JSON.stringify(description)}\n` +
      `${toolsLine}\n` +
      modelLine +
      `user-invocable: false\n` +
      `---\n\n` +
      `${instructions}\n`
    );
  }

  // --- AGENTS.md at the dist ROOT (the codex pattern) -------------------------
  // Rendered from the SHARED onboarding skeleton with Copilot's fills, then the
  // standard {{HARNESS_DIR}} → .github substitution. Copilot auto-reads the
  // project-root AGENTS.md as its always-on context.
  function emitAgentsMd(): string {
    const skeleton = readFileSync(join(coreRoot, "templates", "onboarding.md"), "utf-8");
    return substituteToken(renderOnboarding(skeleton, onboardingFills));
  }

  // Build the full emission list EAGERLY (Flow 4.1): a missing/malformed agent
  // (no name, no tier, unknown tier) throws HERE — before the destructive
  // clean-sweep below — so a failed build leaves the committed dist untouched.
  const agentsSrc = join(coreRoot, "agents");
  if (!existsSync(agentsSrc)) throw new Error(`copilot emission requires core agents at ${agentsSrc}.`);
  const emissions: Array<{ path: string; content: string }> = [];
  for (const f of readdirSync(agentsSrc).filter((x) => x.endsWith(".md")).sort()) {
    emissions.push({
      path: join(AGENTS_DST, f.replace(/\.md$/, ".agent.md")),
      content: emitAgentMd(join(agentsSrc, f)),
    });
  }
  emissions.push({ path: HOOKS_JSON, content: emitHooksJson(harnessDir) });
  emissions.push({ path: join(distRoot, "AGENTS.md"), content: emitAgentsMd() });

  // Clean-sweep the emitted surfaces so a removed/renamed agent or a stale
  // hooks.json cannot linger, THEN write. The packager copied core/agents/*.md
  // into AGENTS_DST during its declarative pass (runner-gen's loadAgents() reads
  // them); sweeping the whole dir replaces those source .md with the .agent.md.
  // Under --check distRoot is a temp dir; the packager byte-compares afterward.
  rmSync(AGENTS_DST, { recursive: true, force: true });
  rmSync(HOOKS_JSON, { force: true });
  for (const { path, content } of emissions) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf-8");
  }
}
