// harness/copilot/emit.ts — the GitHub Copilot per-shell emission plugin.
//
// The unified packager copies core/ → dist/copilot/.aidlc/ and runs graph
// compile there, then calls this emit() for the .github/ shell — the project
// discovery surface BOTH Copilot surfaces read (CLI 1.0.74+ and VS Code agent
// mode 1.130+; verified by the compatibility-spike evidence):
//   - .github/hooks/aidlc.json — the hook wiring: PascalCase event names in
//     the {"version":1} envelope (the shared-recipe: BOTH surfaces then
//     deliver snake_case payloads to the adapter), matcher-FREE (VS Code
//     parses but IGNORES matchers, so every adapter target self-filters).
//   - .github/agents/aidlc-*-agent.md — the 14 personas as native Copilot
//     custom agents: NO model key (tierFlavor copilot is model-omitted by
//     type — the two surfaces disagree on model: value syntax), and the core
//     Task denial projected to a supported `tools:` allowlist that omits
//     Copilot's `agent` delegation tool. Copilot has no all-except-agent form,
//     so worker agents intentionally do not inherit arbitrary MCP tools.
//   - .github/skills/ — the COMPLETE skill tree (orchestrator + generated
//     stage/scope runners + session skills): Copilot discovers project
//     skills at .github/skills/, never inside .aidlc/, so the manifest sets
//     skipRunnerGen and emit composes runner-gen's render fns here (the
//     codex .agents/skills/ idiom).
//
// MERGE NOTE: in the dist tree .github/ is wholly AIDLC-owned (clean-swept
// each build for --check parity). A USER'S project .github/ is shared with
// real repo content — the install step merges these aidlc-named files in;
// it never replaces the directory. All emissions are aidlc-prefixed so the
// merge is collision-free.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { EmitContext } from "../../scripts/manifest-types.ts";

// ---------------------------------------------------------------------------
// Hook wiring. PascalCase events; register ONLY events with a real core-hook
// consumer (kiro-normative). One PreToolUse registration serves both guards
// (state-transition + reviewer-scope) — the adapter runs them in order.
// SessionEnd is omitted because VS Code does not document or accept that
// event. The shared manifest must be valid on both hosts, so both use the
// adapter's next-SessionStart reconciliation path for SESSION_ENDED.
// ---------------------------------------------------------------------------
const HOOK_WIRING: Array<{ event: string; target: string; timeoutSec: number }> = [
  { event: "SessionStart", target: "session-start", timeoutSec: 30 },
  { event: "UserPromptSubmit", target: "record-human-turn", timeoutSec: 30 },
  { event: "PreToolUse", target: "guard-tool-call", timeoutSec: 30 },
  { event: "PostToolUse", target: "post-tool", timeoutSec: 30 },
  { event: "PreCompact", target: "validate-state", timeoutSec: 30 },
  { event: "SubagentStart", target: "subagent-start", timeoutSec: 30 },
  { event: "SubagentStop", target: "log-subagent", timeoutSec: 30 },
  { event: "Stop", target: "continue-workflow", timeoutSec: 60 },
];

function emitHooksJson(harnessDir: string): string {
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const { event, target, timeoutSec } of HOOK_WIRING) {
    const cmd = `bun ${harnessDir}/hooks/aidlc-copilot-adapter.ts ${target}`;
    hooks[event] ??= [];
    // `bash` maps to linux+osx on the IDE and runs verbatim on the CLI;
    // `powershell` covers Windows on both (bun is cross-platform).
    hooks[event].push({ type: "command", bash: cmd, powershell: cmd, timeoutSec });
  }
  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
}

// Rewrite a core persona .md into its Copilot-native custom-agent twin.
// The frontmatter `tier:` line is DROPPED (copilot projection is model-
// omitted by type — agents inherit the session model on both surfaces), and
// the core `disallowedTools: Task` denial becomes a supported `tools:`
// allowlist without Copilot's `agent` delegation tool. An unknown
// disallowedTools value fails the build instead of silently shipping an
// unenforced denial.
const COPILOT_WORKER_TOOLS = ["read", "edit", "search", "execute", "web", "todo"] as const;

function emitAgentMd(raw: string, srcPath: string): string {
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error(`${srcPath}: agent .md has no closed frontmatter block.`);
  const fm = m[1];
  if (!/^tier:\s*\S+\s*$/m.test(fm)) {
    throw new Error(`${srcPath}: agent frontmatter has no tier: line.`);
  }
  const disallowedMatch = fm.match(/^disallowedTools:\s*(.*?)\s*$/m);
  // Exactly `Task` — a multi-valued list (e.g. "Task, WebSearch") must fail
  // the build, not silently ship the extra denial unenforced.
  if (disallowedMatch && !/^task$/i.test(disallowedMatch[1].trim())) {
    throw new Error(
      `${srcPath}: copilot emission cannot project disallowedTools: ${disallowedMatch[1]}.`,
    );
  }
  const newFm = fm
    .split(/\r?\n/)
    .flatMap((line) => {
      if (/^tier:/.test(line)) return [];
      if (/^disallowedTools:/.test(line)) {
        return [`tools: [${COPILOT_WORKER_TOOLS.map((tool) => `"${tool}"`).join(", ")}]`];
      }
      return [line];
    })
    .join("\n");
  return raw.replace(m[0], () => `---\n${newFm}\n---\n`);
}

export default function emit(ctx: EmitContext): void {
  const { coreRoot, harnessRoot, distRoot, harnessDir, substituteToken } = ctx;
  const SHELL = join(distRoot, ".github");
  const SKILLS_DST = join(SHELL, "skills");

  // Compose runner-gen's render fns under the manifest harnessDir, loading
  // the module FROM THE ASSEMBLED DIST TREE (the packager's compile step
  // already wrote tools/data/stage-graph.json there; core/ carries no
  // compiled JSON). The codex idiom, never reimplemented.
  process.env.AIDLC_HARNESS_DIR = harnessDir;
  process.env.AIDLC_HARNESS_NAME = "copilot";
  const gen = require(join(distRoot, harnessDir, "tools", "aidlc-runner-gen.ts")) as {
    runnableStages: () => Array<{ slug: string }>;
    renderStageRunner: (node: { slug: string }) => string;
    renderInitRunner: () => string;
    renderComposeRunner: () => string;
    defaultScopeBatch: (
      discovered?: Record<string, { name: string; description: string }>,
    ) => string[];
    discoverScopes: () => Record<string, { name: string; description: string }>;
    renderRunner: (scope: string, description: string) => string;
  };

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else out.push(full);
    }
    return out;
  }

  const emissions: Array<{ path: string; content: () => string }> = [];

  // The packager rendered AGENTS.md (onboarding) before emit runs; its
  // skeleton names skills under <harnessDir>/skills/, but Copilot discovers
  // skills ONLY at .github/skills/. Rewrite the path family in place (the
  // codex idiom: its prose rewrite maps the same skeleton lines onto
  // .agents/skills/). Anchored on the slash-suffixed form — the one
  // permitted transform class.
  const agentsMdPath = join(distRoot, "AGENTS.md");
  if (existsSync(agentsMdPath)) {
    emissions.push({
      path: agentsMdPath,
      content: () =>
        readFileSync(agentsMdPath, "utf-8").replaceAll(
          `${harnessDir}/skills/`,
          ".github/skills/",
        ),
    });
  }

  // Hook wiring.
  emissions.push({
    path: join(SHELL, "hooks", "aidlc.json"),
    content: () => emitHooksJson(harnessDir),
  });

  // Persona custom agents from core/agents/*.md (body token → .aidlc).
  const agentsDir = join(coreRoot, "agents");
  for (const f of readdirSync(agentsDir).filter((x) => x.endsWith(".md")).sort()) {
    emissions.push({
      path: join(SHELL, "agents", f),
      content: () =>
        substituteToken(
          emitAgentMd(readFileSync(join(agentsDir, f), "utf-8"), join(agentsDir, f)),
        ).replaceAll(
          "aidlc/spaces/<active-space>/memory/",
          "aidlc/spaces/default/memory/",
        ),
    });
  }

  // (a) authored orchestrator shell — token-substituted from harness/copilot/.
  for (const f of ["SKILL.md", "question-rendering.md"]) {
    emissions.push({
      path: join(SKILLS_DST, "aidlc", f),
      content: () => substituteToken(readFileSync(join(harnessRoot, "skills", "aidlc", f), "utf-8")),
    });
  }
  // (b) stage runners + init + compose, generated.
  for (const node of gen.runnableStages()) {
    emissions.push({
      path: join(SKILLS_DST, `aidlc-${node.slug}`, "SKILL.md"),
      content: () => gen.renderStageRunner(node),
    });
  }
  emissions.push({
    path: join(SKILLS_DST, "aidlc-init", "SKILL.md"),
    content: () => gen.renderInitRunner(),
  });
  emissions.push({
    path: join(SKILLS_DST, "aidlc-compose", "SKILL.md"),
    content: () => gen.renderComposeRunner(),
  });
  // (c) default-batch scope runners.
  const scopes = gen.discoverScopes();
  for (const scope of gen.defaultScopeBatch(scopes).filter((s) => s in scopes)) {
    emissions.push({
      path: join(SKILLS_DST, `aidlc-${scope}`, "SKILL.md"),
      content: () => gen.renderRunner(scope, scopes[scope].description),
    });
  }
  // (d) session skills — copied from core/ with token substitution (the
  // engine dir ships NO skills/ — Copilot never scans it).
  for (const skill of ["aidlc-session-cost", "aidlc-replay", "aidlc-outcomes-pack", "aidlc-knowledge"]) {
    const srcDir = join(coreRoot, "skills", skill);
    if (!existsSync(srcDir)) continue;
    for (const file of walk(srcDir)) {
      const rel = relative(srcDir, file);
      emissions.push({
        path: join(SKILLS_DST, skill, rel),
        content: () => substituteToken(readFileSync(file, "utf-8")),
      });
    }
  }

  // Clean-sweep the shell so a removed persona/runner cannot linger. In
  // --check mode the packager supplies an isolated distRoot, then compares
  // the complete generated tree with the committed distribution.
  rmSync(SHELL, { recursive: true, force: true });
  for (const { path, content } of emissions) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content(), "utf-8");
  }
}
