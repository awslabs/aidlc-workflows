// harness/cursor/emit.ts — the Cursor IDE per-shell emission plugin.
//
// The unified packager copies core/ → dist/cursor/.cursor/ and runs graph
// compile + runner-gen there, then calls this emit() for every Cursor-native
// surface that no declarative projection can express:
//   - .cursor/rules/<name>/<name>.mdc — the folder-per-rule layers (with YAML
//     frontmatter) transposed from core/memory/ (NFR-100; not the legacy
//     single-file .cursorrules).
//   - .cursor/hooks.json — the Cursor v1 hook registry wiring the AI-DLC
//     lifecycle events onto the aidlc-cursor-adapter.ts shim.
//   - .cursor/commands/*.md — the three /aidlc-status, /aidlc-jump, /aidlc-scope
//     slash commands.
//   - .cursor/cli.json — the cursor-agent CLI permission set (safe allow/deny).
//   - .cursor-plugin/{marketplace,plugin}.json — the host plugin store manifests.
//
// Determinism (mirrors the codex emitter): no timestamps / random / UUIDs; all
// file arrays are sorted before iteration; content is lazily produced via
// `content: () => string` and flushed in a single write pass after a clean-sweep
// of the emitter-owned dirs (so a removed rule/command cannot linger in --check).
//
// Prose surfaces (rule bodies, command bodies) are authored with the
// {{HARNESS_DIR}} token and passed through ctx.substituteToken — never a literal
// `.cursor` — so the harness-dir mention stays single-sourced. JSON surfaces
// compute the harness dir programmatically from ctx.harnessDir.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmitContext } from "../../scripts/manifest-types.ts";

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

// Cursor best-practice rule cap (NFR-200): a single .mdc file over this many
// lines risks truncation. aidlc-method splits when it would exceed the cap.
const RULE_LINE_CAP = 500;

// Hook wiring (system-architecture.md §4.1 event-mapping table). Each Cursor
// lifecycle event routes to one adapter target; failClosed / matcher / loop_limit
// are Cursor-native config fields carried on the entry. beforeSubmitPrompt and
// afterFileEdit deliberately DO NOT set failClosed (advisory, fail-open).
type HookWire = {
  event: string;
  target: string;
  failClosed?: boolean;
  matcher?: string;
  loopLimit?: number;
};

const HOOK_WIRING: HookWire[] = [
  { event: "beforeSubmitPrompt", target: "session-start" },
  { event: "stop", target: "stop", loopLimit: 3 },
  { event: "beforeShellExecution", target: "state-transition-guard", failClosed: true },
  { event: "preToolUse", target: "reviewer-scope", failClosed: true, matcher: "Read|LS|Glob|Grep" },
  { event: "afterFileEdit", target: "audit-and-sensors" },
  { event: "subagentStop", target: "log-subagent" },
  { event: "preCompact", target: "validate-state" },
];

// core/memory/phases/<slug>.md → phase rule folder + agent-decided description.
const PHASE_RULES: Array<{ slug: string; description: string }> = [
  { slug: "ideation", description: "AI-DLC Ideation phase methodology" },
  { slug: "inception", description: "AI-DLC Inception phase methodology" },
  { slug: "construction", description: "AI-DLC Construction phase methodology" },
  { slug: "operation", description: "AI-DLC Operation phase methodology" },
];

// ---------------------------------------------------------------------------
// Rendering helpers.
// ---------------------------------------------------------------------------

/** Assemble a .mdc file from frontmatter lines + a body (single trailing NL). */
function renderMdc(frontmatter: string[], body: string): string {
  return `---\n${frontmatter.join("\n")}\n---\n\n${body.replace(/\n*$/, "")}\n`;
}

/** Line count of a rendered file, used for the NFR-200 size guard. */
function lineCount(s: string): number {
  return s.split("\n").length;
}

/** Read the framework version from core/tools/aidlc-version.ts (no import — the
 * emit surface's import allowlist is manifest-types + node:fs/path). */
function readVersion(coreRoot: string): string {
  const raw = readFileSync(join(coreRoot, "tools", "aidlc-version.ts"), "utf-8");
  const m = raw.match(/AIDLC_VERSION\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("cursor emit: could not read AIDLC_VERSION from core/tools/aidlc-version.ts");
  return m[1];
}

// ---------------------------------------------------------------------------
// JSON emitters (harness dir computed programmatically).
// ---------------------------------------------------------------------------

function emitHooksJson(harnessDir: string): string {
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const { event, target, failClosed, matcher, loopLimit } of HOOK_WIRING) {
    const entry: Record<string, unknown> = {
      command: `bun ${harnessDir}/hooks/aidlc-cursor-adapter.ts ${target}`,
    };
    if (failClosed) entry.failClosed = true;
    if (matcher) entry.matcher = matcher;
    if (loopLimit !== undefined) entry.loop_limit = loopLimit;
    hooks[event] ??= [];
    hooks[event].push(entry);
  }
  return JSON.stringify({ version: 1, hooks }, null, 2) + "\n";
}

// cursor-agent CLI permission set (system-architecture.md §6). Read/Write/Edit
// and the deterministic-core command prefixes are allowed; destructive,
// history-rewriting, network, and privilege-escalation commands are denied.
function emitCliJson(): string {
  const permissions = {
    allow: [
      "Read",
      "Write",
      "Edit",
      "Shell(bun *)",
      "Shell(git add *)",
      "Shell(git commit *)",
      "Shell(git status *)",
      "Shell(git log *)",
      "Shell(git diff *)",
    ],
    deny: [
      "Shell(rm -rf *)",
      "Shell(git push *)",
      "Shell(git reset --hard *)",
      "Shell(curl *)",
      "Shell(wget *)",
      "Shell(sudo *)",
    ],
  };
  return JSON.stringify({ permissions }, null, 2) + "\n";
}

const PLUGIN_DESCRIPTION =
  "AI-DLC (AI-Driven Development Life Cycle) orchestrator for Cursor - 14 agents, " +
  "32 stages across 5 phases, shipped from a single ready-to-copy distribution.";

function emitPluginJson(version: string): string {
  return (
    JSON.stringify(
      {
        name: "aidlc",
        version,
        description: PLUGIN_DESCRIPTION,
        author: { name: "AWS AIDLC" },
      },
      null,
      2,
    ) + "\n"
  );
}

function emitMarketplaceJson(version: string): string {
  return (
    JSON.stringify(
      {
        name: "aidlc-plugins",
        owner: { name: "AWS AIDLC" },
        description: "AIDLC plugin catalogue.",
        plugins: [
          {
            name: "aidlc",
            source: ".",
            version,
            description: PLUGIN_DESCRIPTION,
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Markdown emitters (authored with {{HARNESS_DIR}}; substituted at write time).
// ---------------------------------------------------------------------------

function commandBody(description: string, instruction: string): string {
  return `---\ndescription: ${description}\n---\n${instruction}\n`;
}

const COMMANDS: Array<{ file: string; description: string; instruction: string }> = [
  {
    file: "aidlc-status.md",
    description: "Show the current AI-DLC workflow status",
    instruction:
      "Invoke the `aidlc` skill and pass `--status` through to the orchestrator: " +
      "run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts next --status`, print its " +
      "output verbatim, and stop.",
  },
  {
    file: "aidlc-jump.md",
    description: "Jump the AI-DLC workflow to a stage or phase",
    instruction:
      "Invoke the `aidlc` skill and pass the jump target through to the orchestrator " +
      "verbatim (e.g. `--stage <slug>` or `--phase <name>`): run " +
      "`bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts next $ARGUMENTS`, then act on the " +
      "single directive it returns.\n\n$ARGUMENTS",
  },
  {
    file: "aidlc-scope.md",
    description: "Set or change the AI-DLC workflow scope",
    instruction:
      "Invoke the `aidlc` skill and pass the scope through to the orchestrator verbatim " +
      "(e.g. `--scope <name>`): run `bun {{HARNESS_DIR}}/tools/aidlc-orchestrate.ts next " +
      "$ARGUMENTS`, then act on the single directive it returns.\n\n$ARGUMENTS",
  },
];

// ---------------------------------------------------------------------------
// emit() — the manifest entry point. Assembles every Cursor-only emission as a
// {path, content} list, clean-sweeps the emitter-owned dirs, then writes once.
// ---------------------------------------------------------------------------
export default function emit(ctx: EmitContext): void {
  const { coreRoot, distRoot, harnessDir, substituteToken } = ctx;
  const CURSOR_ROOT = join(distRoot, harnessDir);
  const RULES_DIR = join(CURSOR_ROOT, "rules");
  const COMMANDS_DIR = join(CURSOR_ROOT, "commands");
  const PLUGIN_DIR = join(distRoot, ".cursor-plugin");

  const memoryDir = join(coreRoot, "memory");
  const readMemory = (rel: string) => substituteToken(readFileSync(join(memoryDir, rel), "utf-8").trim());
  const version = readVersion(coreRoot);

  const emissions: Array<{ path: string; content: () => string }> = [];

  // --- (a) Rule layers ------------------------------------------------------
  // aidlc-method: org + team + project, alwaysApply:true, no description. Split
  // into aidlc-method-core (org + team) + aidlc-method-project (project) when the
  // combined rendering would exceed the line cap (NFR-200).
  const pushRule = (name: string, mdc: string) => {
    if (lineCount(mdc) > RULE_LINE_CAP) {
      throw new Error(
        `cursor emit: rule ${name} is ${lineCount(mdc)} lines, over the ${RULE_LINE_CAP}-line cap.`,
      );
    }
    emissions.push({ path: join(RULES_DIR, name, `${name}.mdc`), content: () => mdc });
  };

  const org = readMemory("org.md");
  const team = readMemory("team.md");
  const project = readMemory("project.md");
  const methodBody = [org, team, project].join("\n\n");
  const methodMdc = renderMdc(["alwaysApply: true"], methodBody);

  if (lineCount(methodMdc) > RULE_LINE_CAP) {
    // Split: core (org + team) stays always-applied; project layer splits off.
    pushRule("aidlc-method-core", renderMdc(["alwaysApply: true"], [org, team].join("\n\n")));
    pushRule("aidlc-method-project", renderMdc(["alwaysApply: true"], project));
  } else {
    pushRule("aidlc-method", methodMdc);
  }

  for (const { slug, description } of PHASE_RULES) {
    const name = `aidlc-phase-${slug}`;
    const body = readMemory(join("phases", `${slug}.md`));
    pushRule(name, renderMdc([`description: ${description}`, "alwaysApply: false"], body));
  }

  // --- (b) hooks.json -------------------------------------------------------
  emissions.push({ path: join(CURSOR_ROOT, "hooks.json"), content: () => emitHooksJson(harnessDir) });

  // --- (c) commands/*.md ----------------------------------------------------
  for (const { file, description, instruction } of COMMANDS) {
    emissions.push({
      path: join(COMMANDS_DIR, file),
      content: () => substituteToken(commandBody(description, instruction)),
    });
  }

  // --- (d) cli.json ---------------------------------------------------------
  emissions.push({ path: join(CURSOR_ROOT, "cli.json"), content: emitCliJson });

  // --- (e) plugin store manifests -------------------------------------------
  emissions.push({ path: join(PLUGIN_DIR, "plugin.json"), content: () => emitPluginJson(version) });
  emissions.push({ path: join(PLUGIN_DIR, "marketplace.json"), content: () => emitMarketplaceJson(version) });

  // Clean-sweep the emitter-owned dirs so a removed rule/command cannot linger.
  // In --check mode distRoot is temporary; the packager compares the complete
  // generated inventory with the committed distribution after emit returns.
  for (const dir of [RULES_DIR, COMMANDS_DIR, PLUGIN_DIR]) {
    rmSync(dir, { recursive: true, force: true });
  }

  // Single write pass, deterministically ordered by path.
  emissions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const { path, content } of emissions) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content(), "utf-8");
  }
}
