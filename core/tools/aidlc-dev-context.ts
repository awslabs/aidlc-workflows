// aidlc-dev-context.ts - the compile boundary, applied to the person editing the
// framework.
//
// The runtime never walks prose to answer "what applies here?": `aidlc-graph.ts
// compile` resolves every stage's rules, sensors, and agents once into
// stage-graph.json, and the orchestrator reads pre-resolved fields off the node
// (docs/reference/02-plane-architecture.md, "Filter evaluation never happens at
// packet rate"). Whoever EDITS a stage gets no such service. They walk the stage
// file, then guess which protocol modules apply, then the agent persona, then its
// knowledge dir, then the scope grid, then the covering tests, then the doc
// chapters - across a corpus far larger than any context window.
//
// This emits that walk as a resolved bundle. Same discipline, one plane out:
//
//   aidlc engine dev-context stage requirements-analysis
//
// It is READ-ONLY and derives almost everything from artefacts the build already
// produces - the compiled graph, the coverage registry, the shipped agent and
// sensor trees - so it stores nothing and a stale bundle means a stale build. Two
// things are NOT read from those artefacts and can therefore drift: the protocol
// module rule is mirrored from the engine (pinned by t340), and the review class is
// the stage's DECLARED value, which resolveReviewClass() in aidlc-lib.ts may lower
// per scope at runtime.
//
// Targets:
//   stage:<slug>   the resolved graph node, applicable protocol modules, persona
//                  and knowledge paths, sensors, artifact flow, covering tests
//   hook:<name>    the hook file, the harness settings that wire it, covering tests
//   tool:<name>    the tool file, its dispatcher routes, covering tests
//   agent:<name>   the persona, its knowledge dir, the stages that lead/support it
//   test:<file>    reverse lookup - the units a test file claims to cover

import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  ceremonyPolicyValues,
  harnessDir,
  loadStageGraphAll,
  type StageEntry,
} from "./aidlc-lib.js";

// --- shapes -----------------------------------------------------------------

// The compiled node carries fields StageEntry declares optional plus two the
// compile resolves per-stage (rules_in_context / sensors_applicable), which are
// the whole point of reading the graph rather than the frontmatter.
type GraphNode = StageEntry & {
  scopes?: string[];
  consumes?: Array<{ artifact: string; required?: boolean; conditional_on?: string }>;
  requires_stage?: string[];
  sensors?: string[];
  rules_in_context?: Array<{ path: string; scope: string }>;
  sensors_applicable?: Array<{ id: string; path: string; matches?: string }>;
};

type CoverageEntry = { file: string; mechanism: string };
type CoverageUnit = {
  unitClass: string;
  unitId: string;
  minMechanism?: string;
  coveredBy?: CoverageEntry[];
  status?: string;
};

export type Bundle = {
  target: string;
  kind: string;
  id: string;
  found: boolean;
  sections: Array<{ heading: string; lines: string[] }>;
  notes: string[];
};

// --- sources ----------------------------------------------------------------

/** readdir that treats an unreadable directory as empty. Every caller here is a
 *  best-effort survey, so a permission error is an absent answer, not a failure. */
function dirents(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function toolsDir(): string {
  return join(harnessDir(), "tools");
}

/** The root to build every emitted path against.
 *
 *  In a source checkout that is `core/`, NOT harnessDir(). harnessDir() names the
 *  installed harness directory, which a checkout does not have, so every emitted
 *  path would be a dead link. `core/` is also the only correct answer for a
 *  framework developer, since AGENTS.md's standing rule is "edit core/, never
 *  dist". In a real install there is no core/ and harnessDir() is right. Same
 *  query, two truthful answers. */
function surfaceRoot(): string {
  const root = sourceRepoRoot();
  if (root && existsSync(join(root, "core", "aidlc-common"))) return "core";
  return harnessDir();
}

function surfacePath(...parts: string[]): string {
  return join(surfaceRoot(), ...parts);
}

/** The compiled control-plane view, via the canonical resolver so the
 *  AIDLC_STAGE_GRAPH seam and every install layout keep working.
 *  loadStageGraphAll(), not loadStageGraph(): a developer asking about a stage
 *  wants it even when a plugin selection has disabled the node. */
function loadGraphNodes(): GraphNode[] {
  // In a source checkout harnessDir() resolves to core/, which holds the authored
  // stages but no compiled graph — that is generated into dist/. Point the
  // canonical resolver at the materialized projection rather than re-implementing
  // its lookup, so the env seam and install layouts keep their single owner.
  if (!existsSync(join(toolsDir(), "data", "stage-graph.json")) && !process.env.AIDLC_STAGE_GRAPH) {
    const root = sourceRepoRoot();
    if (root) {
      const projected = join(
        root, "dist", "claude", ".claude", "tools", "data", "stage-graph.json",
      );
      if (existsSync(projected)) process.env.AIDLC_STAGE_GRAPH = projected;
    }
  }
  try {
    return loadStageGraphAll() as GraphNode[];
  } catch {
    // No materialized projection anywhere. That is a "run bun scripts/package.ts"
    // condition, not a crash.
    return [];
  }
}

/** Walk up for the source repo root, identified by the build entry. Absent in a
 *  harness install, which is why every caller treats undefined as "this section
 *  does not apply here" rather than as an error. */
function sourceRepoRoot(): string | undefined {
  let dir = import.meta.dir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "scripts", "package.ts")) && existsSync(join(dir, "AGENTS.md"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** tests/ is not projected into a harness install, so this is present only in a
 *  source checkout. Absent is normal, not an error: a harness engineer editing a
 *  stage in their own project has no copy of this repo's suite. */
function loadCoverage(): CoverageUnit[] | undefined {
  const root = sourceRepoRoot();
  if (!root) return undefined;
  const path = join(root, "tests", ".coverage-registry.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { units?: CoverageUnit[] };
    return Array.isArray(parsed.units) ? parsed.units : undefined;
  } catch {
    return undefined;
  }
}

function coverageFor(
  units: CoverageUnit[] | undefined,
  unitClass: string,
  match: (unitId: string) => boolean,
): string[] {
  if (!units) return [];
  const out: string[] = [];
  for (const u of units) {
    if (u.unitClass !== unitClass || !match(u.unitId)) continue;
    for (const c of u.coveredBy ?? []) {
      const label = c.mechanism && c.mechanism !== "none"
        ? `${c.file} (${c.mechanism})`
        : c.file;
      if (!out.includes(label)) out.push(label);
    }
    if ((u.coveredBy ?? []).length === 0) {
      out.push(`(none - registry status: ${u.status ?? "unknown"})`);
    }
  }
  return out;
}

/** Doc chapters naming this identifier. A grep, deliberately: the docs carry no
 *  machine-readable index, and inventing one here would add a second source of
 *  truth for the tool to drift from. */
function docsMentioning(id: string, limit = 8): string[] {
  const root = sourceRepoRoot();
  if (!root) return [];
  const hits: string[] = [];
  const walk = (dir: string): void => {
    if (hits.length >= limit) return;
    for (const e of dirents(dir)) {
      if (hits.length >= limit) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith(".md")) {
        try {
          if (readFileSync(full, "utf-8").includes(id)) {
            hits.push(full.slice(root.length + 1));
          }
        } catch { /* unreadable file is not a failure of the query */ }
      }
    }
  };
  walk(join(root, "docs"));
  return hits;
}

// --- protocol modules -------------------------------------------------------

/** The modules the engine derives from the NODE alone. Mirrors three of the four
 *  conditions in aidlc-orchestrate.ts (search `protocolModules.push`); the fourth,
 *  `learnings`, depends on the active scope's ceremony policy rather than the node,
 *  so it is resolved separately by learningsScopes() below.
 *
 *  Duplicated rather than imported because the engine's version is internal to a
 *  directive build that needs live workflow state, which a developer query has
 *  none of. t340 enumerates the engine's pushes from source and fails if this file
 *  stops accounting for one - that guard is what caught `learnings` being added by
 *  the scope-owned ceremony switches. */
export function protocolModulesFor(node: GraphNode): string[] {
  const modules: string[] = [];
  if (node.reviewer && node.review_class) modules.push("reviewer");
  if (
    node.mode === "subagent" ||
    node.mode === "pipeline" ||
    node.mode === "mob" ||
    (node.support_agents?.length ?? 0) > 0
  ) {
    modules.push("ensemble");
  }
  if (node.phase === "construction") modules.push("construction");
  return modules;
}

/** Scopes executing this stage whose default ceremony policy turns the `learnings`
 *  module on. Scope-dependent, so a bundle with no selected scope reports the set
 *  rather than a yes/no. A state-level ceremony override can still change it. */
export function learningsScopes(node: GraphNode): string[] {
  return (node.scopes ?? []).filter((scope) => {
    try {
      return ceremonyPolicyValues(scope, null).learnings === "on";
    } catch {
      return false;
    }
  });
}

// --- builders ---------------------------------------------------------------

function agentPath(agent: string): string {
  return surfacePath("agents", `${agent}.md`);
}

function knowledgeDir(agent: string): string {
  return surfacePath("knowledge", agent);
}

function buildStage(slug: string): Bundle {
  const nodes = loadGraphNodes();
  const node = nodes.find((n) => n.slug === slug);
  const bundle: Bundle = {
    target: `stage:${slug}`,
    kind: "stage",
    id: slug,
    found: Boolean(node),
    sections: [],
    notes: [],
  };
  if (!node) {
    const near = nodes.map((n) => n.slug).filter((s) => s.includes(slug) || slug.includes(s));
    bundle.notes.push(
      near.length > 0
        ? `No stage "${slug}". Did you mean: ${near.join(", ")}?`
        : `No stage "${slug}" in the compiled graph. Run \`aidlc engine graph compile\` if you just added it.`,
    );
    return bundle;
  }
  const cov = loadCoverage();

  bundle.sections.push({
    heading: "Identity",
    lines: [
      `slug        ${node.slug}`,
      `number      ${node.number ?? "-"}`,
      `name        ${node.name ?? "-"}`,
      `phase       ${node.phase ?? "-"}`,
      `execution   ${node.execution ?? "-"}`,
      `mode        ${node.mode ?? "-"}`,
      ...(node.condition ? [`condition   ${node.condition}`] : []),
    ],
  });

  bundle.sections.push({
    heading: "Read these before editing the stage body",
    lines: [
      `stage file        ${surfacePath("aidlc-common", "stages", node.phase ?? "?", `${slug}.md`)}`,
      `stage protocol    ${surfacePath("aidlc-common", "protocols", "stage-protocol.md")}  (always)`,
      ...protocolModulesFor(node).map((m) =>
        `protocol module   ${surfacePath("aidlc-common", "protocols", `stage-protocol-${m}.md`)}`
      ),
      ...(() => {
        const on = learningsScopes(node);
        if (on.length === 0) return [];
        const all = (node.scopes ?? []).length;
        const where = on.length === all ? "every scope here" : on.join(", ");
        // Named without a path on purpose: §13 lives inside stage-protocol.md, which
        // is already listed above, and a second path line would just be redundant.
        return [`learnings ritual  stage-protocol.md §13 - applies under ${where}`
          + ` (scope ceremony policy)`];
      })(),
      ...(node.lead_agent ? [`lead persona      ${agentPath(node.lead_agent)}`] : []),
      ...(node.support_agents ?? []).map((a) => `support persona   ${agentPath(a)}`),
      ...(node.lead_agent ? [`lead knowledge    ${knowledgeDir(node.lead_agent)}/`] : []),
    ],
  });

  const consumes = (node.consumes ?? []).map((c) => {
    const flags = [
      c.required ? "required" : "optional",
      ...(c.conditional_on ? [`if ${c.conditional_on}`] : []),
    ].join(", ");
    return `consumes    ${c.artifact}  (${flags})`;
  });
  bundle.sections.push({
    heading: "Artifact flow",
    lines: [
      ...(node.produces ?? []).map((p) => `produces    ${p}`),
      ...consumes,
      ...(node.requires_stage ?? []).map((r) => `requires    stage ${r}`),
    ],
  });

  if (node.reviewer) {
    bundle.sections.push({
      heading: "Review",
      lines: [
        `reviewer          ${node.reviewer}`,
        `review artifact   ${node.review_artifact ?? "-"}`,
        // DECLARED, not effective. resolveReviewClass() lowers it to a scope's
        // reviewCap and honours a "Review Override" state field, so the value a run
        // actually uses depends on scope + state that a developer query has none of.
        `review class      ${node.review_class ?? "-"} (declared; a scope reviewCap`
          + ` or state override can lower it - see resolveReviewClass)`,
        `max iterations    ${node.reviewer_max_iterations ?? "-"} (declared)`,
        `reviewer persona  ${agentPath(node.reviewer)}`,
      ],
    });
  }

  // The graph stores install-layout sensor paths, so re-root them the same way every
  // other emitted path is re-rooted: verbatim they are dead links in a checkout.
  const sensorLines = (node.sensors_applicable ?? []).map((s) => {
    const path = surfacePath("sensors", basename(s.path));
    return `${s.id}  ->  ${path}${s.matches ? `  matches ${s.matches}` : ""}`;
  });
  bundle.sections.push({
    heading: "Sensors (resolved at compile)",
    lines: sensorLines.length > 0 ? sensorLines : ["(none)"],
  });

  bundle.sections.push({
    heading: "Rules in context (resolved at compile)",
    lines: (node.rules_in_context ?? []).map((r) => `${r.scope.padEnd(8)} ${r.path}`),
  });

  bundle.sections.push({
    heading: `Scopes that EXECUTE this stage (${(node.scopes ?? []).length})`,
    lines: [(node.scopes ?? []).join(", ") || "(none)"],
  });

  const tests = coverageFor(cov, "stage", (id) => id === `${node.phase}/${slug}` || id === slug);
  bundle.sections.push({
    heading: "Covering tests",
    lines: tests.length > 0 ? tests : ["(coverage registry unavailable - not a source checkout)"],
  });

  const docs = docsMentioning(slug);
  if (docs.length > 0) {
    bundle.sections.push({ heading: "Docs naming this stage", lines: docs });
  }
  if (!cov) {
    bundle.notes.push(
      "tests/.coverage-registry.json not found; covering-test lookup needs a source checkout.",
    );
  }
  return bundle;
}

function buildHook(name: string): Bundle {
  const id = name.startsWith("aidlc-") ? name : `aidlc-${name}`;
  const file = surfacePath("hooks", `${id}.ts`);
  const bundle: Bundle = {
    target: `hook:${name}`,
    kind: "hook",
    id,
    found: existsSync(file),
    sections: [],
    notes: [],
  };
  if (!bundle.found) {
    bundle.notes.push(`No hook file at ${file}.`);
    return bundle;
  }
  bundle.sections.push({ heading: "Hook", lines: [`file   ${file}`] });

  // Which harness settings actually wire it, and on which event.
  const root = sourceRepoRoot();
  const wiring: string[] = [];
  if (root) {
    const harnessRoot = join(root, "harness");
    const names = dirents(harnessRoot)
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
    for (const h of names) {
      const walk = (dir: string): void => {
        for (const e of dirents(dir)) {
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            walk(full);
          } else if (/\.(json|ts|toml|md)$/.test(e.name)) {
            try {
              if (readFileSync(full, "utf-8").includes(`${id}.ts`)) {
                wiring.push(full.slice(root.length + 1));
              }
            } catch { /* skip */ }
          }
        }
      };
      walk(join(harnessRoot, h));
    }
  }
  bundle.sections.push({
    heading: "Wired by",
    lines: wiring.length > 0 ? wiring : ["(no harness surface references it - dead hook?)"],
  });

  const cov = loadCoverage();
  const tests = coverageFor(cov, "hook", (u) => u === id || u === id.replace(/^aidlc-/, ""));
  bundle.sections.push({
    heading: "Covering tests",
    lines: tests.length > 0 ? tests : ["(none found)"],
  });
  const docs = docsMentioning(id);
  if (docs.length > 0) bundle.sections.push({ heading: "Docs naming this hook", lines: docs });
  return bundle;
}

function buildTool(name: string): Bundle {
  const id = name.startsWith("aidlc-") ? name : `aidlc-${name}`;
  const file = surfacePath("tools", `${id}.ts`);
  const bundle: Bundle = {
    target: `tool:${name}`,
    kind: "tool",
    id,
    found: existsSync(file),
    sections: [],
    notes: [],
  };
  if (!bundle.found) {
    bundle.notes.push(`No tool file at ${file}.`);
    return bundle;
  }
  bundle.sections.push({ heading: "Tool", lines: [`file   ${file}`] });

  // Dispatcher routes that delegate here.
  const dispatcher = surfacePath("tools", "aidlc.ts");
  const routes: string[] = [];
  if (existsSync(dispatcher)) {
    const text = readFileSync(dispatcher, "utf-8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (line.includes(`"${id}.ts"`)) routes.push(`aidlc.ts:${i + 1}  ${line.trim()}`);
    });
  }
  bundle.sections.push({
    heading: "Dispatcher wiring",
    lines: routes.length > 0 ? routes : ["(not in the route registry - direct-invoke only)"],
  });

  // Registry subcommand ids are "<tool> <verb>" — space-separated, not colon.
  const cov = loadCoverage();
  const mine = (cov ?? []).filter(
    (u) => u.unitClass === "subcommand" && u.unitId.startsWith(`${id} `),
  );
  const uncovered = mine.filter((u) => (u.coveredBy ?? []).length === 0)
    .map((u) => u.unitId.slice(id.length + 1));
  const files: string[] = [];
  for (const u of mine) {
    for (const c of u.coveredBy ?? []) if (!files.includes(c.file)) files.push(c.file);
  }
  bundle.sections.push({
    heading: `Subcommands (${mine.length}) and their covering tests (${files.length} files)`,
    lines: [
      ...(cov ? [] : ["(coverage registry unavailable - not a source checkout)"]),
      ...files.sort(),
      ...(uncovered.length > 0
        ? [`UNCOVERED subcommands: ${uncovered.join(", ")}`]
        : mine.length > 0
          ? ["all subcommands covered"]
          : []),
    ],
  });
  return bundle;
}

function buildAgent(name: string): Bundle {
  const id = name.startsWith("aidlc-") ? name : `aidlc-${name}-agent`;
  const file = agentPath(id);
  const bundle: Bundle = {
    target: `agent:${name}`,
    kind: "agent",
    id,
    found: existsSync(file),
    sections: [],
    notes: [],
  };
  if (!bundle.found) {
    bundle.notes.push(`No agent file at ${file}.`);
    return bundle;
  }
  bundle.sections.push({
    heading: "Agent",
    lines: [`persona     ${file}`, `knowledge   ${knowledgeDir(id)}/`],
  });
  const nodes = loadGraphNodes();
  const lead = nodes.filter((n) => n.lead_agent === id).map((n) => `${n.number ?? "?"} ${n.slug}`);
  const support = nodes.filter((n) => (n.support_agents ?? []).includes(id))
    .map((n) => `${n.number ?? "?"} ${n.slug}`);
  const reviews = nodes.filter((n) => n.reviewer === id).map((n) => `${n.number ?? "?"} ${n.slug}`);
  bundle.sections.push({
    heading: "Stages",
    lines: [
      `leads     ${lead.join(", ") || "(none)"}`,
      `supports  ${support.join(", ") || "(none)"}`,
      `reviews   ${reviews.join(", ") || "(none)"}`,
    ],
  });
  return bundle;
}

function buildTest(file: string): Bundle {
  const bundle: Bundle = {
    target: `test:${file}`,
    kind: "test",
    id: file,
    found: false,
    sections: [],
    notes: [],
  };
  const cov = loadCoverage();
  if (!cov) {
    bundle.notes.push("Reverse lookup needs tests/.coverage-registry.json (source checkout only).");
    return bundle;
  }
  const needle = basename(file);
  const claimed: string[] = [];
  for (const u of cov) {
    for (const c of u.coveredBy ?? []) {
      if (basename(c.file) === needle || c.file === file) {
        claimed.push(`${u.unitClass.padEnd(14)} ${u.unitId}`);
      }
    }
  }

  // The file's own header is the authored claim; the registry is what it resolved
  // to. They differ legitimately: a `covers:` entry naming a class the registry
  // does not enumerate (e.g. `file:`) yields zero registry units while the header
  // is perfectly valid. Showing only the registry made that look like a missing
  // header, so show both and let the difference be visible.
  const root = sourceRepoRoot();
  const declared: string[] = [];
  if (root) {
    for (const dir of ["smoke", "unit", "integration", "e2e"]) {
      const candidate = join(root, "tests", dir, needle);
      if (!existsSync(candidate)) continue;
      for (const line of readFileSync(candidate, "utf-8").split("\n").slice(0, 20)) {
        const m = line.match(/^\/\/\s*covers:\s*(.+)$/);
        if (m) declared.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean));
      }
      break;
    }
  }

  bundle.found = claimed.length > 0 || declared.length > 0;
  bundle.sections.push({
    heading: `Declared in its covers: header (${declared.length})`,
    lines: declared.length > 0 ? declared : ["(no covers: header found)"],
  });
  bundle.sections.push({
    heading: `Registry-enumerated units it covers (${claimed.length})`,
    lines: claimed.length > 0
      ? claimed.sort()
      : ["(none — the header may name classes the registry does not enumerate)"],
  });
  return bundle;
}

// --- render -----------------------------------------------------------------

export function buildBundle(target: string): Bundle {
  const idx = target.indexOf(":");
  if (idx < 0) {
    throw new Error(
      `Target must be <kind>:<id> - got "${target}". Kinds: stage, hook, tool, agent, test.`,
    );
  }
  const kind = target.slice(0, idx);
  const id = target.slice(idx + 1);
  if (!id) throw new Error(`Target "${target}" names no id.`);
  switch (kind) {
    case "stage": return buildStage(id);
    case "hook": return buildHook(id);
    case "tool": return buildTool(id);
    case "agent": return buildAgent(id);
    case "test": return buildTest(id);
    default:
      throw new Error(
        `Unknown target kind "${kind}". Valid: stage, hook, tool, agent, test.`,
      );
  }
}

export function renderHuman(bundle: Bundle): string {
  const out: string[] = [`# ${bundle.target}`, ""];
  for (const s of bundle.sections) {
    out.push(`## ${s.heading}`);
    out.push(...(s.lines.length > 0 ? s.lines : ["(none)"]));
    out.push("");
  }
  if (bundle.notes.length > 0) {
    out.push("## Notes");
    out.push(...bundle.notes);
    out.push("");
  }
  return out.join("\n");
}

const KINDS = ["stage", "hook", "tool", "agent", "test"] as const;

// Every namespaced invocation in shipped prose is rewritten for the native channel
// and must resolve to a declared verb, so each example below names a KIND — which
// is exactly what this route declares as its verbs. Writing the namespaced form
// followed by a flag instead of a verb fails that projection guard in
// scripts/package.ts (it scans comments too, so this note avoids spelling it).
// Keep flag-only spellings unprefixed.
const USAGE = `Usage: aidlc engine dev-context <kind> <id> [--json]

Resolved context for editing one piece of the framework, assembled from the
compiled graph and the coverage registry instead of a walk through the prose.

  aidlc engine dev-context stage requirements-analysis
  aidlc engine dev-context hook aidlc-run-sensors
  aidlc engine dev-context tool aidlc-graph
  aidlc engine dev-context agent aidlc-architect-agent
  aidlc engine dev-context test t243-install-mechanism.test.ts

Kinds: ${KINDS.join(", ")}
Also accepted: "--for <kind>:<id>" and a bare "<kind>:<id>".
  --json                machine-readable form
`;

/** Delegates signal failure through `process.exitCode`, which the dispatcher reads
 *  after awaiting main() — a returned number is ignored on the compiled channel, so
 *  an exit code returned instead of set would always surface as 0 from the native
 *  binary. Returns void to match the DelegateModule contract in aidlc.ts. */
export function main(argv: string[]): void {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  // Three accepted spellings, because the dispatcher hands the verb through as a
  // positional while a human typing the tool directly reaches for --for:
  //   dev-context stage requirements-analysis   (the route's grammar)
  //   dev-context --for stage:requirements-analysis
  //   dev-context stage:requirements-analysis
  const forIdx = argv.findIndex((a) => a === "--for");
  const positional = argv.filter((a) => !a.startsWith("-"));
  let target: string | undefined;
  if (forIdx >= 0) {
    target = argv[forIdx + 1];
  } else if (
    positional.length >= 2 &&
    (KINDS as readonly string[]).includes(positional[0]) &&
    !positional[0].includes(":")
  ) {
    target = `${positional[0]}:${positional[1]}`;
  } else {
    target = positional.find((a) => a.includes(":"));
  }
  if (!target) {
    process.stderr.write(`Missing <kind> <id>.\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const bundle = buildBundle(target);
  process.stdout.write(
    argv.includes("--json")
      ? `${JSON.stringify(bundle, null, 2)}\n`
      : renderHuman(bundle),
  );
  if (!bundle.found) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
    process.exit(process.exitCode ?? 0);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
}
