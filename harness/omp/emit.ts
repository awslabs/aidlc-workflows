// harness/omp/emit.ts — the oh-my-pi (omp) per-shell emission plugin.
//
// The unified packager copies core/ → dist/omp/.omp/ (rules → aidlc-common/rules),
// runs graph compile, then calls this emit() for everything that cannot be expressed
// as a declarative coreDirs/harnessFiles row:
//   - commands/   — one slash command per stage, per scope, plus utility commands
//   - RULES.md    — effective rule prose (merged from aidlc-common/rules/*.md)
//
// All other omp surfaces (hooks, custom tool, APPEND_SYSTEM.md, etc.) are covered by
// harnessFiles in the manifest — emit() owns only these two generated outputs.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { EmitContext, EmitResult } from "../../scripts/manifest-types.ts";

// ---------------------------------------------------------------------------
// Command templates
// ---------------------------------------------------------------------------

function aidlcCommand(harnessDir: string): string {
  return `---
description: >
  AI-DLC workflow orchestrator for oh-my-pi. Start, resume, or manage an
  AI-driven development lifecycle. Pass freeform text (the description of
  what to build) or a flag. Flags: --status, --init, --doctor, --stage,
  --phase, --scope, --depth, --test-strategy, --test-run, --version, --help.
argument-hint: "[description | --status | --stage <slug|#> | --phase <name|#> | --version | --help]"
---

# AI-DLC — Orchestrator (oh-my-pi)

This is the slash-command front door for AI-DLC inside oh-my-pi. Pass freeform text to start or resume a workflow; pass flags to manage state. All routing, scope resolution, gate status, and workflow completion lives in the engine binary — never re-derive any of that in prose.

## Two ways to invoke AI-DLC

| Path | Used for | Surface |
|---|---|---|
| This command (\`/aidlc ...\`) | Human-driven session; user types flags after \`/aidlc\` | omp discovery of \`commands/aidlc.md\` |
| The \`aidlc_orchestrate\` custom tool with \`{"subcommand": "next" \\| "report" \\| "status" \\| "init" \\| "doctor" \\| "help" \\| "version", ...}\` | Programmatic / automated workflows; model-driven | omp discovery of \`tools/aidlc-orchestrate.ts\` |

Both paths call the same TypeScript engine binary; pick whichever fits the run shape.

## Arguments

- freeform text — describe what you want to build. The engine auto-detects scope (from your command plus any \`--scope <name>\` override) and routes to the matching stage.
- \`--status\` — print the workflow status (current phase, stage, depth, test strategy).
- \`--init\` — scaffold \`aidlc-docs/\` and initialise \`aidlc-state.md\` without starting a workflow. \`--init --force\` reinitialises; \`--init --scope <name>\` seeds the initial scope (default \`poc\`).
- \`--doctor\` — validate setup (paths, tools, audit log) and print a status report.
- \`--stage <slug>\` — jump to a specific stage. \`--stage <slug> --single\` runs it in isolation.
- \`--phase <name>\` — jump to a phase; the engine picks the stage within.
- \`--scope <name>\` — change the active scope mid-workflow.
- \`--depth <level>\` — change artifact depth (\`minimal\` / \`standard\` / \`comprehensive\`).
- \`--test-strategy <level>\` — change test volume (\`minimal\` / \`standard\` / \`comprehensive\`).
- \`--test-run\` — auto-approve gates for CI / automated runs (no human in the loop).
- \`--version\` — print the framework version.
- \`--help\` — print full usage.

## Step

Call the \`aidlc_orchestrate\` custom tool:

\`\`\`json
{
  "subcommand": "next",
  "args": [<everything after /aidlc>]
}
\`\`\`

If the directive is \`print\`, do exactly what \`message\` says (run the named tool, print its output, and stop, OR run it then re-call \`next\` if it's a \`run-then-continue\` mutation).

If the directive kind is \`run-stage\`, load the lead agent's persona + knowledge per the directive, run the stage body, write the \`produces\` artifacts, branch on \`directive.gate\`, then commit via:

\`\`\`json
{
  "subcommand": "report",
  "result": "completed" | "approved" | "rejected",
  "user_input": "<answer or \\"\\\" if none>"
}
\`\`\`

Repeat until the directive's kind is \`done\` or \`error\`.
`;
}

function initCommand(): string {
  return `---
description: >
  Scaffold an AI-DLC workspace — run the whole Initialization phase (scaffold
  the aidlc-docs/ tree, detect the workspace, initialise state) in one step,
  without starting a stage workflow. Packaging over \`/aidlc --init\`.
  Pass \`--force\` to reinitialise an existing workspace; \`--scope <name>\`
  to seed the initial scope (defaults to poc).
argument-hint: "[--force] [--scope <name>]"
---

# AI-DLC — initialize a workspace

Initialization is a PHASE, not a single stage — it scaffolds the \`aidlc-docs/\` tree, detects the workspace (greenfield/brownfield), and initialises \`aidlc-state.md\` together, in one deterministic call. There is no per-init-stage runner because an init stage has no standalone meaning.

## Step

\`\`\`json
{
  "subcommand": "init",
  "args": <$ARGUMENTS split by whitespace>
}
\`\`\`

Pass \`$ARGUMENTS\` through verbatim — \`--force\` reinitialises over an existing \`aidlc-state.md\`, and \`--scope <name>\` seeds the initial scope (defaults to \`poc\`). Print the tool's output and stop. This does not start a stage workflow; run \`/aidlc\` (or a scope runner) afterwards to begin one.
`;
}

function sessionCostCommand(): string {
  return `---
description: >
  Print per-phase and total session token/cost summary. Classified \`read-only\`: pulls every count from the aidlc runtime tool
  (no LLM-side counting). Never advances the workflow stage pointer. Never emits audit events.
argument-hint: ""
---

# AI-DLC — session cost

Opt-in packaging over \`/aidlc --session-cost\`; the same output is always reachable via that flag without this command.

## Step

\`\`\`json
{
  "subcommand": "summary",
  "mode": "aidlc-session-cost"
}
\`\`\`

Print the tool's stdout verbatim and stop.
`;
}

function replayCommand(): string {
  return `---
description: >
  Replay the AI-DLC workflow audit trail as a concise structured timeline.
  Classified \`read-only\`: never advances stage pointer, never emits audit events.
argument-hint: ""
---

# AI-DLC — replay audit trail

Opt-in packaging over \`/aidlc --replay\`; the same output is always reachable via that flag.

## Step

\`\`\`json
{
  "subcommand": "summary",
  "mode": "aidlc-replay"
}
\`\`\`

Print the tool's stdout verbatim and stop.
`;
}

function outcomesPackCommand(): string {
  return `---
description: >
  Pack the AI-DLC session outcomes into OUTCOMES.md.
  Classified \`read-only\` for workflow state (never advances stage pointer,
  never emits audit events) but does write the OUTCOMES.md output file.
argument-hint: ""
---

# AI-DLC — outcomes pack

Opt-in packaging over \`/aidlc --outcomes-pack\`; the same output is always reachable via that flag.

## Step

\`\`\`json
{
  "subcommand": "summary",
  "mode": "aidlc-outcomes-pack"
}
\`\`\`

Print the tool's stdout verbatim and stop.
`;
}

function stageCommand(slug: string, stageNum: string, stageName: string, phase: string): string {
  return `---
description: >
  Run the AI-DLC \`${slug}\` stage (${phase} phase, ${stageNum}) in isolation via the oh-my-pi custom tool,
  without advancing the main workflow. Equivalent to \`/aidlc --stage ${slug} --single\`: the engine
  emits one run-stage directive for \`${slug}\` and the conductor runs it, then the single-stage run
  commits a synthetic-id pair and stops. The main workflow's Current Stage is never touched.
argument-hint: ""
---

# AI-DLC Stage Runner — ${slug}

Run the \`${slug}\` stage (${stageName}) on its own. This is opt-in packaging over \`/aidlc --stage ${slug} --single\`; the same stage is always reachable via that flag without this command.

## Steps

1. Ask the engine for the single-stage directive by calling the \`aidlc_orchestrate\` custom tool:

   \`\`\`json
   { "subcommand": "next", "stage_slug": "${slug}", "args": ["--single"] }
   \`\`\`

   The engine emits one \`run-stage\` directive for \`${slug}\` (carrying the lead agent, the resolved consumes/produces paths, the rules and sensors in context, and — on this first directive — the conductor persona). Run the stage exactly as the directive describes; do not load the conductor persona by hand, the engine delivers it.

2. When the stage's work is done, commit the single-stage record:

   \`\`\`json
   { "subcommand": "report", "single": true, "stage_slug": "${slug}", "result": "completed" }
   \`\`\`

   This records a \`STAGE_STARTED\` / \`STAGE_COMPLETED\` pair under a synthetic workflow id and stops. It NEVER writes the main workflow's \`Current Stage\` — a single-stage run is isolated by design (the tool refuses to advance the main workflow).
`;
}

function scopeCommand(scope: string, description: string): string {
  return `---
description: >
  Start (or continue) an AI-DLC workflow with scope \`${scope}\`. ${description}
argument-hint: "[--depth <level>] [--test-strategy <level>] [--test-run]"
---

# AI-DLC — Scope: ${scope}

## Step

\`\`\`json
{
  "subcommand": "next",
  "args": ["--scope", "${scope}"],
  "tail": <$ARGUMENTS split by whitespace>
}
\`\`\`

Print the resulting scope-resolution directive and continue the loop as the directive indicates.
`;
}

// ---------------------------------------------------------------------------
// RULES.md generation
// ---------------------------------------------------------------------------

// Section labels matching aidlc-org.md, aidlc-team.md, aidlc-project.md headings
const RULE_FILE_ORDER = [
  { file: "aidlc-org.md", label: "Org-Level Rules", note: "> Framework defaults. Read in order with aidlc-team.md and\n> aidlc-project.md; later layers override." },
  { file: "aidlc-team.md", label: "Team-Level Rules", note: "> This team's affirmed practices and corrections. Overrides aidlc-org.md.\n> Populated by practices-discovery affirmation gate. Edit at the gate,\n> not directly." },
  { file: "aidlc-project.md", label: "Project-Level Rules", note: "> Project-specific overrides and corrections. Overrides aidlc-team.md\n> and aidlc-org.md. Populated by practices-discovery and the\n> self-learning loop.\n>\n> Use sparingly: most teams don't need a project layer. Reach for it\n> only when this specific project deviates from team-wide practice in a\n> stable, durable way (e.g., \"this monorepo project rebases even though\n> our team default is squash\"; \"this legacy project skips the test\n> floor because the existing suite is unsalvageable and we accept\n> that\")." },
  { file: "aidlc-phase-construction.md", label: "Construction Phase Guardrails", note: "These rules apply to every stage whose `phase: construction` declaration\nimports them as the matching phase rule." },
  { file: "aidlc-phase-ideation.md", label: "Ideation Phase Guardrails", note: "These rules apply to every stage whose `phase: ideation` declaration\nimports them as the matching phase rule." },
  { file: "aidlc-phase-inception.md", label: "Inception Phase Guardrails", note: "These rules apply to every stage whose `phase: inception` declaration\nimports them as the matching phase rule." },
  { file: "aidlc-phase-operation.md", label: "Operation Phase Guardrails", note: "These rules apply to every stage whose `phase: operation` declaration\nimports them as the matching phase rule." },
];

// Strip YAML frontmatter from a rule file and return the body.
function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  return m ? m[2].trim() : raw.trim();
}

function buildRulesMd(rulesDir: string): string {
  const header = `# AI-DLC sticky rules (always-apply)

> Generated by \`bun .omp/tools/aidlc-graph.ts compile\` from the layered
> rule chain in \`.omp/aidlc-common/rules/\` (org → team → project → phase →
> stage). Edit the source layers, not this file.\n`;

  const sections: string[] = [header];

  for (const { file, label, note } of RULE_FILE_ORDER) {
    const filePath = join(rulesDir, file);
    if (!existsSync(filePath)) continue;
    const body = stripFrontmatter(readFileSync(filePath, "utf-8"));
    sections.push(`\n## ${label}\n\n${note}\n\n${body}`);
  }

  return sections.join("") + "\n";
}

// ---------------------------------------------------------------------------
// emit() — the manifest entry point
// ---------------------------------------------------------------------------
export default function emit(ctx: EmitContext): EmitResult {
  const { distRoot, harnessDir, harnessRoot, check } = ctx;
  const DOMP = join(distRoot, harnessDir); // dist/omp/.omp
  const CMD_DST = join(DOMP, "commands");
  const RULES_DST = join(DOMP, "RULES.md");
  const RULES_SRC = join(DOMP, "aidlc-common", "rules");

  // Load runner-gen from the assembled tree (graph compile already ran).
  process.env.AIDLC_HARNESS_DIR = harnessDir;
  const gen = require(join(DOMP, "tools", "aidlc-runner-gen.ts")) as {
    runnableStages: () => Array<{ slug: string; number: string; name: string; phase: string }>;
    discoverScopes: () => Record<string, { description: string }>;
  };

  const emissions: Array<{ path: string; content: () => string }> = [];

  // --- utility commands (static content) ------------------------------------
  emissions.push({ path: join(CMD_DST, "aidlc.md"), content: () => aidlcCommand(harnessDir) });
  emissions.push({ path: join(CMD_DST, "aidlc-init.md"), content: initCommand });
  emissions.push({ path: join(CMD_DST, "aidlc-session-cost.md"), content: sessionCostCommand });
  emissions.push({ path: join(CMD_DST, "aidlc-replay.md"), content: replayCommand });
  emissions.push({ path: join(CMD_DST, "aidlc-outcomes-pack.md"), content: outcomesPackCommand });

  // --- stage commands (generated from stage graph) --------------------------
  for (const node of gen.runnableStages()) {
    const slug = node.slug;
    const num = node.number ?? "";
    const name = node.name ?? slug;
    const phase = (node.phase ?? "").toLowerCase();
    emissions.push({
      path: join(CMD_DST, `aidlc-${slug}.md`),
      content: () => stageCommand(slug, num, name, phase),
    });
  }

  // --- scope commands (generated from scope grid) ---------------------------
  const scopes = gen.discoverScopes();
  for (const [scope, meta] of Object.entries(scopes)) {
    const description = meta.description ?? "";
    emissions.push({
      path: join(CMD_DST, `aidlc-${scope}.md`),
      content: () => scopeCommand(scope, description),
    });
  }

  // --- RULES.md (compiled from rule files in aidlc-common/rules/) -----------
  emissions.push({
    path: RULES_DST,
    content: () => buildRulesMd(RULES_SRC),
  });

  // --- write or check -------------------------------------------------------
  const written: string[] = [];
  const problems: string[] = [];

  if (check) {
    for (const { path, content } of emissions) {
      const want = content();
      if (!existsSync(path)) problems.push(`MISSING emission: ${relative(distRoot, path)}`);
      else if (readFileSync(path, "utf-8") !== want) problems.push(`DIFFERS emission: ${relative(distRoot, path)}`);
      written.push(path);
    }
  } else {
    // Clean-sweep commands/ so removed commands don't linger.
    if (existsSync(CMD_DST)) {
      for (const entry of readdirSync(CMD_DST)) {
        const p = join(CMD_DST, entry);
        try { writeFileSync(p, ""); } catch { /* ignore */ }
      }
    }
    for (const { path, content } of emissions) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content(), "utf-8");
      written.push(path);
    }
  }

  return { written, problems };
}
