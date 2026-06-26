// custom-harness.ts — the Harness-Engineer fixture (Phase 5).
//
// Models what a HARNESS ENGINEER does (docs/harness-engineering/00-overview.md): reshape the
// framework WITHOUT code by editing DATA — define their own workflow (a custom
// scope), the stages it runs (custom stages), HOW STAGES JOIN UP (requires_stage
// edges + a produce->consume artefact chain), what artefacts get produced (each
// stage's produces:), the custom agent that leads the work, the custom knowledge
// that agent reads, a deterministic check bound to a stage (a custom sensor), and
// a standing rule. "stages are *what*, agents are *who*". "Harness Engineer" is a
// PERSONA / reader role, NOT a scope; the custom scope this fixture seeds is a
// realistic domain workflow: `data-migration`.
//
// THE SEEDED WORKFLOW — a database migration, two stages that chain:
//
//   schema-snapshot stage  ──produces──>  source-schema artefact
//          │                                     │
//          │ requires_stage                      │ consumes
//          ▼                                     ▼
//   migration-plan stage   ──produces──>  migration-strategy artefact
//
//   • schema-snapshot (the "capture the source DB shape" activity) writes the
//     `source-schema` artefact — the inventory of tables/columns to migrate.
//   • migration-plan (the "plan the cutover" activity) READS source-schema and
//     writes the `migration-strategy` artefact — the ordered cutover plan.
//
// Note the deliberate slug≠artefact split, matching shipped convention (the
// `intent-capture` stage produces `intent-statement`, not "intent-capture"):
// the STAGE is the activity, the ARTEFACT is the named deliverable it emits.
// migration-strategy's required consume (source-schema) is satisfied by an
// ON-PATH producer (schema-snapshot), so validateScope stays clean — the "be
// accurate, seed artefacts that match the scope" requirement is met by
// construction (no orphan consume, no off-path producer).
//
// Both seeders cpSync the shipped dist/claude/.claude into <proj>/.claude FIRST;
// this module then EDITS that copy and recompiles the graph. It is shared by
// setupIntegrationProject({ customHarness: true }) (sdk) and
// setupTuiProject({ customHarness: true }) (tui) — one seeding surface, no
// duplication, so the {sdk,tui} two-driver test drives byte-identical config.
//
// EVERY shape below was verified against the shipped sources before coding
// (the "shipped shapes ARE the spec" discipline):
//   - scope metadata/routing shape .... scopes/aidlc-bugfix.md +
//     aidlc-common/stages/* `scopes:` frontmatter transposed into scope-grid
//   - stage frontmatter required set .. tools/aidlc-stage-schema.ts:75-88
//     (REQUIRED_FIELDS: slug,phase,execution,condition,lead_agent,support_agents,
//      mode,produces,consumes,requires_stage,inputs,outputs; sensors OPTIONAL at
//      :90; the presence check that emits "missing required field" is at :142)
//   - consumes[] authoring shape ...... a list of { artifact, required } maps
//     (verified against the shipped market-research.md frontmatter)
//   - sensor manifest shape ........... sensors/aidlc-required-sections.md +
//     aidlc-sensor-schema.ts (id,kind,command,default_severity,description,
//     matches?; NO applies_to — that's a fossil)
//   - stage-graph seeding ............. compileStageGraph harvests {number,name}
//     from existing JSON for known slugs; a NEW slug is AUTO-SEEDED (next free
//     per-phase index + title-cased name). This fixture still pre-seeds explicit
//     {slug,number,name} rows so the custom stages land at DETERMINISTIC numbers
//     that satisfy the edge-local invariant below, auto-seed would append them
//     at the end of their phase, which is fine for leaf stages but not for the
//     hand-chosen ordering this fixture asserts.
//   - agent lookup ................... aidlc-graph.ts compile calls loadAgents()
//     and validates lead_agent/support_agents against the copied .claude/agents/
//     directory; the custom agent must be written before stage compile.
//   - edge-local invariant ............ aidlc-graph.ts:996 (every requires_stage
//     dep must be LOWER-numbered than the stage; numericStageOrder :877-882
//     splits on "." and parseInts each part, so 2.05 sorts AFTER 2.1 —
//     parseInt("05")=5 > parseInt("1")=1. The two stages are 2.0 and 2.9; the
//     shipped inception stages 2.1-2.8 are SKIP in this scope, so the only live
//     edge is 2.0->2.9, and numericStageOrder("2.0","2.9") < 0 satisfies it.)
//   - reachability .................... aidlc-utility.ts:1995-2002 + :2179 —
//     init marks every initialization-phase stage [x] complete and
//     determineFirstPostInitStage SKIPS init-phase stages, so a custom stage
//     must be a NON-init stage AND the lowest-numbered non-init EXECUTE in its
//     scope to become Current Stage (firstPostInit) at init. schema-snapshot at
//     2.0 (inception) is the lowest non-init EXECUTE -> init writes
//     Current Stage=schema-snapshot. migration-plan (2.9) is reached after
//     schema-snapshot's gate.
//   - sensor->stage binding ........... stage frontmatter `sensors: [<id>]` only
//     (aidlc-graph.ts:497 resolveSensorsForStage); manifest `matches:` glob is
//     the fire filter (aidlc-sensor-fire.ts:198)
//
// The recipe was proven end-to-end in a throwaway project: compile succeeds,
// `aidlc-graph scope data-migration` routes exactly [workspace-scaffold,
// workspace-detection, state-init, schema-snapshot, migration-plan], a real
// `init --scope data-migration` writes Current Stage=schema-snapshot, and the
// compiled schema-snapshot node carries schema-validator in sensors_applicable +
// aidlc-project.md in rules_in_context.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The fixed identifiers the custom harness introduces. EXPORTED so the test
// asserts against these exact constants — no drift between what the fixture
// seeds and what the test checks. Named by ROLE in the chain (SNAPSHOT_* for
// the head stage + its artefact, PLAN_* for the tail) so every reference reads
// as what it is, not "custom thing #2".
// ---------------------------------------------------------------------------

/** The custom SCOPE key — a realistic domain workflow a harness engineer
 *  defines. Routes the 3 init stages + the 2 chained stages; SKIPs everything
 *  else (the shortest path that still reaches both custom stages). */
export const CUSTOM_SCOPE = "data-migration";

/** The custom AGENT slug. It is a real agent file under .claude/agents/ in the
 *  temp project, then the custom stages bind lead_agent to this slug. */
export const CUSTOM_AGENT_SLUG = "aidlc-data-migration-agent";
export const CUSTOM_AGENT_DISPLAY = "Data Migration Agent";

/** The custom KNOWLEDGE file the custom agent must read. The marker is present
 *  only in this knowledge file (not in the stage body), so a produced artefact
 *  containing it is an observable context-load echo. */
export const CUSTOM_KNOWLEDGE_FILE = "schema-normalization-playbook.md";
export const CUSTOM_KNOWLEDGE_REF =
  `.claude/knowledge/${CUSTOM_AGENT_SLUG}/${CUSTOM_KNOWLEDGE_FILE}`;
export const CUSTOM_KNOWLEDGE_MARKER =
  "PHASE5-DATA-MIGRATION-KNOWLEDGE-QUARTZ";

// --- HEAD stage: schema-snapshot — captures the source DB shape ------------

/** The schema-snapshot STAGE — the chain's head and the workflow's firstPostInit
 *  stage. The activity: capture the source database's schema. Lives in INCEPTION
 *  at 2.0 (sorts before reverse-engineering 2.1). Placement is load-bearing for
 *  reachability: init auto-completes every init-phase stage and
 *  determineFirstPostInitStage (aidlc-utility.ts:2179) skips them, so the custom
 *  head stage must be NON-init; as the scope's lowest-numbered non-init EXECUTE
 *  it becomes firstPostInit -> init writes `Current Stage: schema-snapshot`.
 *  Edge-local invariant holds: numericStageOrder("0.3","2.0") < 0, so requiring
 *  state-init is legal. */
export const SNAPSHOT_STAGE_SLUG = "schema-snapshot";
export const SNAPSHOT_STAGE_NUMBER = "2.0";
export const SNAPSHOT_STAGE_NAME = "Schema Snapshot";
export const SNAPSHOT_STAGE_PHASE = "inception";

/** The artefact the schema-snapshot stage PRODUCES: an inventory of the source
 *  database's tables/columns to migrate. Distinct from the stage slug (shipped
 *  convention: stage = activity, artefact = deliverable). The migration-plan
 *  stage consumes this — the join-up. Its write under aidlc-docs/ trips the
 *  custom sensor's glob. */
export const SNAPSHOT_ARTIFACT = "source-schema";

// --- TAIL stage: migration-plan — plans the cutover ------------------------

/** The migration-plan STAGE — the chain's tail. The activity: read the captured
 *  source-schema and plan the cutover. Number 2.9 (NOT 2.05: numericStageOrder
 *  parseInts the minor part, so 2.05 would sort AFTER 2.1). 2.9 sorts after 2.0
 *  and after the SKIP'd shipped 2.1-2.8; the only live edge is 2.0->2.9, and
 *  numericStageOrder("2.0","2.9") < 0 satisfies the edge-local invariant. */
export const PLAN_STAGE_SLUG = "migration-plan";
export const PLAN_STAGE_NUMBER = "2.9";
export const PLAN_STAGE_NAME = "Migration Plan";
export const PLAN_STAGE_PHASE = "inception";

/** The artefact the migration-plan stage PRODUCES: the ordered cutover plan
 *  (which tables move in which order, with what downtime). Built from the
 *  consumed source-schema. */
export const PLAN_ARTIFACT = "migration-strategy";

/** The custom SENSOR id (manifest at sensors/aidlc-<id>.md, wired via each
 *  stage's `sensors: [<id>]` frontmatter). Reuses the shipped required-sections
 *  command — a deterministic markdown-shape check that emits SENSOR_FIRED on a
 *  matching write — so the fire is provable without inventing a tool. */
export const CUSTOM_SENSOR_ID = "schema-validator";

/** A unique marker the custom rule bullet carries, so the test can prove THIS
 *  bullet (not a shipped one) reached the agent's rule context + output. */
export const CUSTOM_RULE_MARKER = "PHASE5-DATA-MIGRATION-RULE-XYZZY";

/** Where the schema-snapshot stage writes its source-schema artefact — a
 *  markdown file under the active intent's record whose write triggers the
 *  custom sensor's glob match. Relative to the project root, with a `*` for the
 *  born intent dir (the id is minted at runtime). Path layout follows the shipped
 *  per-intent convention: aidlc/spaces/<space>/intents/<slug-id8>/<phase>/<stage>/<artefact>.md.
 *  The `*` glob is honoured by tui-drive's --until-file (globs one segment). */
export const SNAPSHOT_OUTPUT_REL = join(
  "aidlc",
  "spaces",
  "default",
  "intents",
  "*",
  SNAPSHOT_STAGE_PHASE,
  SNAPSHOT_STAGE_SLUG,
  `${SNAPSHOT_ARTIFACT}.md`,
);

/** Where the migration-plan stage writes its migration-strategy artefact — the
 *  terminal artefact of the chain; the live tui journey terminates on this file
 *  appearing (both gates answered). `*` globs the born intent dir. */
export const PLAN_OUTPUT_REL = join(
  "aidlc",
  "spaces",
  "default",
  "intents",
  "*",
  PLAN_STAGE_PHASE,
  PLAN_STAGE_SLUG,
  `${PLAN_ARTIFACT}.md`,
);

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/** Seed the custom harness into <proj>/.claude (which must already hold the
 *  copied distributable) and recompile the stage graph. Logs the seeded project
 *  path to stderr so a debugging run can always locate the seed. Throws loudly
 *  on any step failure — a half-seeded fixture must not silently produce a
 *  green. */
export function seedCustomHarness(proj: string): void {
  const claude = join(proj, ".claude");
  if (!existsSync(claude)) {
    throw new Error(
      `seedCustomHarness: ${claude} missing — copy the distributable first ` +
        `(setupIntegrationProject / setupTuiProject does this before calling).`,
    );
  }

  seedCustomAgent(claude);
  seedCustomKnowledge(claude);
  seedScopeFile(claude);
  seedScopeRouting(claude);
  seedStageGraphRows(claude);
  seedStageFiles(claude);
  seedSensorManifest(claude);
  seedProjectRule(claude);
  compileGraph(proj, claude);

  // Locatability: the temp project name is a random mkdtemp suffix and the sdk
  // half cleans its project on exit, so without this line a debugging run has
  // no durable pointer at the seed. Stderr only (never stdout) — advisory.
  process.stderr.write(
    `[custom-harness] seeded ${CUSTOM_SCOPE} workflow (${SNAPSHOT_STAGE_SLUG} -> ` +
      `${PLAN_STAGE_SLUG}, artefacts ${SNAPSHOT_ARTIFACT} -> ${PLAN_ARTIFACT}, ` +
      `agent ${CUSTOM_AGENT_SLUG}, knowledge ${CUSTOM_KNOWLEDGE_FILE}, ` +
      `sensor ${CUSTOM_SENSOR_ID}) into ${proj}\n`,
  );
}

/** Add a custom agent persona to the temp framework copy. Only the frontmatter
 *  is parsed by the deterministic tools; the body is what the live conductor
 *  reads when it adopts the custom lead persona for the custom stages. */
export function seedCustomAgent(claude: string): void {
  const dir = join(claude, "agents");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${CUSTOM_AGENT_SLUG}.md`);
  const body = `---
name: ${CUSTOM_AGENT_SLUG}
display_name: ${CUSTOM_AGENT_DISPLAY}
examples:
  - ${CUSTOM_KNOWLEDGE_FILE}
description: >
  Specialist data migration persona seeded by the Harness-Engineer fixture.
  Leads the custom schema-snapshot and migration-plan stages.
disallowedTools: Task
modelOverride: opus
---

**IMPORTANT: Do NOT use the Task tool. You operate as a delegated agent and must not spawn sub-agents.**

# ${CUSTOM_AGENT_DISPLAY}

You specialize in database migration planning. You produce concise migration
artefacts from source-schema facts, with special attention to data-quality
normalization and cutover sequencing.

## Knowledge Loading

On activation, load knowledge in this order:
1. \`.claude/rules/\` -- standing guardrails and project rules
2. \`.claude/knowledge/aidlc-shared/\` -- shared methodology
3. \`${CUSTOM_KNOWLEDGE_REF}\` -- custom migration playbook for this fixture
4. \`aidlc/knowledge/${CUSTOM_AGENT_SLUG}/\` -- team-owned custom knowledge, if present

## Key Principle

Before writing a custom data-migration artefact, read the custom migration
playbook and quote its \`Knowledge marker\` value in the artefact's Origin
section.
`;
  writeFileSync(p, body);
}

/** Add the custom methodology knowledge file. The stage bodies instruct the
 *  agent to read this file and echo the marker value, but they do not contain
 *  the marker themselves. */
export function seedCustomKnowledge(claude: string): void {
  const dir = join(claude, "knowledge", CUSTOM_AGENT_SLUG);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, CUSTOM_KNOWLEDGE_FILE);
  const body = `# Schema Normalization Playbook

Knowledge marker: ${CUSTOM_KNOWLEDGE_MARKER}

When planning a data migration, normalize legacy enum values before cutover:

- \`pending_paid\` becomes \`pending\`.
- \`voided_old\` becomes \`voided\`.

Every artefact that uses this playbook must quote the Knowledge marker value in
its \`## Origin\` section so the harness can verify the custom knowledge reached
the active agent context.
`;
  writeFileSync(p, body);
}

/** Add the custom scope metadata file. Scope names are discovered from
 *  .claude/scopes/aidlc-*.md, while routing is derived from stage `scopes:`
 *  frontmatter during compile. */
function seedScopeFile(claude: string): void {
  const dir = join(claude, "scopes");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `aidlc-${CUSTOM_SCOPE}.md`);
  const body = `---
name: ${CUSTOM_SCOPE}
depth: Minimal
keywords:
  - data migration
  - schema migration
description: Custom data-migration workflow for the harness-engineer fixture
---

# ${CUSTOM_SCOPE} scope

Minimal depth for proving a harness engineer can add a synthetic workflow in a
temp project without changing the shipped framework. It runs the initialization
trio, then the custom schema-snapshot and migration-plan stages.
`;
  writeFileSync(p, body);
}

/** Add the custom scope to the three initialization stages in the temp copy.
 *  The two custom stages declare the same scope in their generated frontmatter;
 *  compile transposes those five memberships into EXECUTE cells and every other
 *  stage to SKIP. */
function seedScopeRouting(claude: string): void {
  const initDir = join(claude, "aidlc-common", "stages", "initialization");
  for (const slug of ["workspace-scaffold", "workspace-detection", "state-init"]) {
    ensureStageListsCustomScope(join(initDir, `${slug}.md`));
  }
}

function ensureStageListsCustomScope(stageFile: string): void {
  const text = readFileSync(stageFile, "utf8");
  const match = text.match(/\nscopes:\n((?: {2}- .+\n)+)/);
  if (!match) {
    throw new Error(`seedCustomHarness: ${stageFile} has no scopes list to extend`);
  }
  const entries = match[1]
    .split("\n")
    .map((line) => line.trim().replace(/^- /, ""))
    .filter(Boolean);
  if (entries.includes(CUSTOM_SCOPE)) return;
  const updated = text.replace(match[0], `\nscopes:\n${match[1]}  - ${CUSTOM_SCOPE}\n`);
  writeFileSync(stageFile, updated);
}

/** Pre-seed the {slug, number, name} stage-graph rows the compiler needs to
 *  bootstrap new stages (aidlc-graph.ts:944-952). The rest of each node is
 *  recomputed from the stage YAML at compile; the rules_in_context /
 *  sensors_applicable arrays are filled by the compile resolvers. */
function seedStageGraphRows(claude: string): void {
  const p = join(claude, "tools", "data", "stage-graph.json");
  const graph = JSON.parse(readFileSync(p, "utf8")) as Array<{ slug: string }>;
  const rows: Array<Record<string, unknown>> = [
    {
      slug: SNAPSHOT_STAGE_SLUG,
      number: SNAPSHOT_STAGE_NUMBER,
      name: SNAPSHOT_STAGE_NAME,
      phase: SNAPSHOT_STAGE_PHASE,
      execution: "ALWAYS",
      condition: "Always executes (custom data-migration stage)",
      lead_agent: CUSTOM_AGENT_SLUG,
      support_agents: [],
      mode: "inline",
      produces: [SNAPSHOT_ARTIFACT],
      consumes: [],
      requires_stage: ["state-init"],
      sensors: [CUSTOM_SENSOR_ID],
      inputs: "none",
      outputs: SNAPSHOT_OUTPUT_REL,
      rules_in_context: [],
      sensors_applicable: [],
    },
    {
      slug: PLAN_STAGE_SLUG,
      number: PLAN_STAGE_NUMBER,
      name: PLAN_STAGE_NAME,
      phase: PLAN_STAGE_PHASE,
      execution: "ALWAYS",
      condition: "Always executes (custom data-migration stage)",
      lead_agent: CUSTOM_AGENT_SLUG,
      support_agents: [],
      mode: "inline",
      produces: [PLAN_ARTIFACT],
      consumes: [{ artifact: SNAPSHOT_ARTIFACT, required: true }],
      requires_stage: [SNAPSHOT_STAGE_SLUG],
      sensors: [CUSTOM_SENSOR_ID],
      inputs: SNAPSHOT_OUTPUT_REL,
      outputs: PLAN_OUTPUT_REL,
      rules_in_context: [],
      sensors_applicable: [],
    },
  ];
  for (const row of rows) {
    if (graph.some((s) => s.slug === row.slug)) continue; // idempotent
    graph.push(row as unknown as { slug: string });
  }
  writeFileSync(p, `${JSON.stringify(graph, null, 2)}\n`);
}

/** Write both custom stage files. Each frontmatter carries every REQUIRED field
 *  (aidlc-stage-schema.ts:75-88), declares the artefact it PRODUCES, joins the
 *  graph via requires_stage, and imports the custom sensor. The `## Steps` body
 *  tells the orchestrator to write the produced artefact under aidlc-docs/ — the
 *  write that trips the sensor while the stage is active — and to cite the
 *  custom rule marker in it. The migration-plan stage declares the
 *  produce->consume chain by consuming source-schema. */
function seedStageFiles(claude: string): void {
  const snapshotDir = join(claude, "aidlc-common", "stages", SNAPSHOT_STAGE_PHASE);
  mkdirSync(snapshotDir, { recursive: true });
  const snapshotBody = `---
slug: ${SNAPSHOT_STAGE_SLUG}
phase: ${SNAPSHOT_STAGE_PHASE}
execution: ALWAYS
condition: Always executes (custom data-migration stage seeded by the Phase-5 harness-engineer fixture)
lead_agent: ${CUSTOM_AGENT_SLUG}
support_agents: []
mode: inline
produces:
  - ${SNAPSHOT_ARTIFACT}
consumes: []
requires_stage:
  - state-init
sensors:
  - ${CUSTOM_SENSOR_ID}
scopes:
  - ${CUSTOM_SCOPE}
inputs: ${CUSTOM_KNOWLEDGE_REF}
outputs: ${SNAPSHOT_OUTPUT_REL}
---

# ${SNAPSHOT_STAGE_NAME} (custom stage)

MANDATORY: Follow stage-protocol.md for approval gates and completion messages.

## Steps

### Step 1: Capture the ${SNAPSHOT_ARTIFACT} artefact

Before writing, read \`${CUSTOM_KNOWLEDGE_REF}\`. In the \`## Origin\` section,
quote the \`Knowledge marker\` value from that file exactly.

Write a markdown file to \`${SNAPSHOT_OUTPUT_REL}\` capturing the source
database's schema (the tables/columns to migrate). This test fixture is
self-contained: use the seeded source facts below and do NOT ask the user for
additional schema details.

Seeded source facts:
- Engine: PostgreSQL 14.
- Table \`accounts\`: \`id uuid primary key\`, \`email text not null unique\`,
  \`created_at timestamptz not null\`; approximately 12,000 rows.
- Table \`invoices\`: \`id uuid primary key\`,
  \`account_id uuid references accounts(id)\`, \`total_cents integer not null\`,
  \`status text not null\`; approximately 48,000 rows.
- Known data-quality issue: \`invoices.status\` includes legacy values
  \`pending_paid\` and \`voided_old\` that the migration plan must normalize.

Include at least two H2 headings: a \`## Summary\` section and an \`## Origin\`
section. The Origin section MUST cite this stage as its origin, per the project
rule ${CUSTOM_RULE_MARKER}, and MUST include the knowledge marker read from the
custom knowledge file.

### Step 2: Update state

Mark ${SNAPSHOT_STAGE_SLUG} as \`[x]\` completed in \`aidlc-docs/aidlc-state.md\`
and present the standard approval gate.

## Sensors

This stage imports the custom \`${CUSTOM_SENSOR_ID}\` sensor, which fires on the
artefact write in Step 1 (its \`matches:\` glob covers the aidlc-docs tree).

## Learn

(custom data-migration stage — no learning loop)
`;
  writeFileSync(join(snapshotDir, `${SNAPSHOT_STAGE_SLUG}.md`), snapshotBody);

  const planDir = join(claude, "aidlc-common", "stages", PLAN_STAGE_PHASE);
  mkdirSync(planDir, { recursive: true });
  const planBody = `---
slug: ${PLAN_STAGE_SLUG}
phase: ${PLAN_STAGE_PHASE}
execution: ALWAYS
condition: Always executes (custom data-migration stage seeded by the Phase-5 harness-engineer fixture)
lead_agent: ${CUSTOM_AGENT_SLUG}
support_agents: []
mode: inline
produces:
  - ${PLAN_ARTIFACT}
consumes:
  - artifact: ${SNAPSHOT_ARTIFACT}
    required: true
requires_stage:
  - ${SNAPSHOT_STAGE_SLUG}
sensors:
  - ${CUSTOM_SENSOR_ID}
scopes:
  - ${CUSTOM_SCOPE}
inputs: ${SNAPSHOT_OUTPUT_REL}; ${CUSTOM_KNOWLEDGE_REF}
outputs: ${PLAN_OUTPUT_REL}
---

# ${PLAN_STAGE_NAME} (custom stage)

MANDATORY: Follow stage-protocol.md for approval gates and completion messages.

## Steps

### Step 1: Read the upstream ${SNAPSHOT_ARTIFACT} artefact

This stage CONSUMES the \`${SNAPSHOT_ARTIFACT}\` artefact produced by the
${SNAPSHOT_STAGE_SLUG} stage. Read \`${SNAPSHOT_OUTPUT_REL}\` before planning.
Also read \`${CUSTOM_KNOWLEDGE_REF}\` and apply its normalization playbook.

### Step 2: Produce the ${PLAN_ARTIFACT} artefact

Write a markdown file to \`${PLAN_OUTPUT_REL}\` describing the ordered cutover
plan built from the source schema. Include at least two H2 headings: a
\`## Summary\` section and an \`## Origin\` section. The Origin section MUST cite
this stage as its origin, per the project rule ${CUSTOM_RULE_MARKER}, and MUST
include the \`Knowledge marker\` value from the custom knowledge file.

### Step 3: Update state

Mark ${PLAN_STAGE_SLUG} as \`[x]\` completed in \`aidlc-docs/aidlc-state.md\`
and present the standard approval gate.

## Sensors

This stage imports the custom \`${CUSTOM_SENSOR_ID}\` sensor, which fires on the
artefact write in Step 2 (its \`matches:\` glob covers the aidlc-docs tree).

## Learn

(custom data-migration stage — no learning loop)
`;
  writeFileSync(join(planDir, `${PLAN_STAGE_SLUG}.md`), planBody);
}

/** Write the custom sensor manifest. Reuses the shipped required-sections
 *  command (a deterministic markdown-shape check) so the fire is real without
 *  inventing a tool. Manifest shape matches sensors/aidlc-required-sections.md:
 *  id/kind/command/default_severity/description/matches — NO applies_to. */
function seedSensorManifest(claude: string): void {
  const p = join(claude, "sensors", `aidlc-${CUSTOM_SENSOR_ID}.md`);
  const body = `---
id: ${CUSTOM_SENSOR_ID}
kind: deterministic
command: bun .claude/tools/aidlc-sensor-required-sections.ts
default_severity: advisory
description: Phase-5 custom sensor — validates the data-migration artefact's section shape on every write under the intent record while a custom stage is active
matches: "**/{aidlc-docs,intents}/**"
input_schema:
  output_path: string
  stage_slug: string
output_schema:
  pass: boolean
  h2_count: integer
  headings: string[]
  findings_count: integer
timeout_seconds: 5
---

# ${CUSTOM_SENSOR_ID} sensor (custom)

A custom sensor seeded by the Phase-5 harness-engineer fixture. Wired to the
${SNAPSHOT_STAGE_SLUG} and ${PLAN_STAGE_SLUG} stages via each stage's
\`sensors: [${CUSTOM_SENSOR_ID}]\` frontmatter import (resolved at compile into
sensors_applicable).
`;
  writeFileSync(p, body);
}

/** Add the custom rule bullet to the project method layer under ## Mandated. The
 *  rule FILE path is already in every stage's rules_in_context (project rules
 *  attach universally); this seeds the unique-marker CONTENT the agent reads.
 *  The method relocated (P5) from <harness>/rules/aidlc-project.md to the
 *  workspace-root aidlc/spaces/default/memory/project.md (neutral name), so seed
 *  it there — `claude` is <proj>/.claude, the method sits beside it. */
function seedProjectRule(claude: string): void {
  const p = join(claude, "..", "aidlc", "spaces", "default", "memory", "project.md");
  let text = readFileSync(p, "utf8");
  const bullet = `\n- ${CUSTOM_RULE_MARKER}: every data-migration artefact must cite its origin stage.\n`;
  if (text.includes(CUSTOM_RULE_MARKER)) return; // idempotent
  if (text.includes("## Mandated\n")) {
    text = text.replace("## Mandated\n", `## Mandated\n${bullet}`);
  } else {
    text += `\n## Mandated\n${bullet}`;
  }
  writeFileSync(p, text);
}

/** Run the project's own copied aidlc-graph.ts compile so the runtime graph
 *  picks up the custom stages/scope/sensor/rule. Runs the COPIED tool (not the
 *  source) so resolveProjectDir derives the temp project from the script path
 *  — exactly the path a real install takes. Throws on non-zero exit. */
function compileGraph(proj: string, claude: string): void {
  const tool = join(claude, "tools", "aidlc-graph.ts");
  const res = spawnSync("bun", [tool, "compile"], {
    cwd: proj,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: proj },
  });
  if (res.status !== 0) {
    throw new Error(
      `seedCustomHarness: aidlc-graph compile failed (exit ${res.status}).\n` +
        `stdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
}
