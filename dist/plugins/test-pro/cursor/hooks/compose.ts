#!/usr/bin/env bun
// compose.ts — AIDLC plugin SessionStart compose hook and importable composer.
//
// Replaces the former compose.sh + compose-contributions.ts + compose-fragments.ts
// trio. Folding to one TS file removes the shell-portability bug class entirely:
// GNU-only `sed -i` becomes replaceAll; the `cp -rn || cp -r` no-clobber (which
// clobbers on BSD/coreutils>=9.2) becomes an existsSync guard + cpSync; every
// failure is caught and logged to the hooks-health file instead of swallowed by
// `2>/dev/null || true`.
//
// Runs on SessionStart (Claude/Codex) or via the Kiro .kiro.hook. Harness-agnostic:
//   PLUGIN_ROOT   ← CLAUDE_PLUGIN_ROOT | PLUGIN_ROOT | AIDLC_PLUGIN_ROOT
//   PROJECT_DIR   ← CLAUDE_PROJECT_DIR | AIDLC_PROJECT_DIR | PWD  (Codex unsets the first)
//   HARNESS_LEAF  ← AIDLC_HARNESS_DIR  (".claude" default)
//
// Steps: (1) copy new stages/scopes/agents/knowledge/sensors/tools with
// {{HARNESS_DIR}} substitution, no-clobber; (2) merge contributions
// (produces/consumes/sensors set-union +
// prose fragments spliced) into stage SOURCE — durable across recompiles;
// (3) recompile the graph. Idempotent + short-circuits when nothing changed.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT || process.env.AIDLC_PLUGIN_ROOT || "";
const PROJECT_DIR =
  process.env.CLAUDE_PROJECT_DIR || process.env.AIDLC_PROJECT_DIR || process.env.PWD || process.cwd();
const HARNESS_LEAF = process.env.AIDLC_HARNESS_DIR || ".claude";
const HARNESS_DIR = join(PROJECT_DIR, HARNESS_LEAF);
const STAGES_DIR = join(HARNESS_DIR, "aidlc-common", "stages");
const SKILLS_DIR = join(HARNESS_DIR, "skills");
const PHASES = ["initialization", "ideation", "inception", "construction", "operation"];
const SCOPE_TABLE_BEGIN =
  "<!-- BEGIN: compiled scope grid via `bun aidlc-utility.ts scope-table` - do NOT hand-edit -->";
const SCOPE_TABLE_END = "<!-- END: compiled scope grid -->";
const STAGE_TABLE_BEGIN =
  "<!-- BEGIN: compiled stage graph via `bun aidlc-utility.ts stage-table` - do NOT hand-edit -->";
const STAGE_TABLE_END = "<!-- END: compiled stage graph -->";
type ParseStageFrontmatter = (raw: string) => Record<string, unknown>;
interface InstalledAidlcLib {
  hooksHealthDir?: (projectDir: string) => string;
  parseStageFrontmatter?: ParseStageFrontmatter;
}
interface InstalledStageSchema {
  validateStageFrontmatter?: (
    obj: unknown,
  ) => { valid: boolean; errors?: string[] };
}

let installedLibPromise: Promise<InstalledAidlcLib | null> | null = null;
let installedSchemaPromise: Promise<InstalledStageSchema | null> | null = null;

function installedAidlcLib(): Promise<InstalledAidlcLib | null> {
  installedLibPromise ??= import(join(HARNESS_DIR, "tools", "aidlc-lib.ts"))
    .then((module) => module as InstalledAidlcLib)
    .catch(() => null);
  return installedLibPromise;
}

function installedStageSchema(): Promise<InstalledStageSchema | null> {
  installedSchemaPromise ??= import(join(HARNESS_DIR, "tools", "aidlc-stage-schema.ts"))
    .then((module) => module as InstalledStageSchema)
    .catch(() => null);
  return installedSchemaPromise;
}

function slugFromPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop()!.replace(/\.md$/, "");
}

function pluginNameFromRoot(): string {
  if (!PLUGIN_ROOT) return "plugin";
  const fromContent = firstPluginFieldInPlugin();
  if (fromContent) return fromContent;
  for (const md of [".claude-plugin", ".codex-plugin", ".kiro-plugin"]) {
    try {
      const m = JSON.parse(readFileSync(join(PLUGIN_ROOT, md, "plugin.json"), "utf-8"));
      if (typeof m?.name === "string" && m.name) return m.name;
    } catch { /* try next / fall through */ }
  }
  const parts = PLUGIN_ROOT.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 2] || parts[parts.length - 1] || "plugin";
}

function firstPluginFieldInPlugin(): string | null {
  const roots = ["stages", "scopes", "contributions"];
  const visit = (dir: string): string | null => {
    if (!existsSync(dir)) return null;
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        const nested = visit(path);
        if (nested) return nested;
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      const m = readFileSync(path, "utf-8").match(/^plugin:\s*([a-z][a-z0-9-]*)\s*$/m);
      if (m) return m[1];
    }
    return null;
  };
  for (const root of roots) {
    const found = visit(join(PLUGIN_ROOT, root));
    if (found) return found;
  }
  return null;
}

// The plugin's stable IDENTITY, computed once up front so every per-plugin
// artifact (the drops file, the retry marker) is keyed the same way — including
// on the early-exit guards, which flush drops before the main body runs. NOT the
// plugin-root basename: a projection root is `dist/plugins/<name>/<harness>`, so
// its basename is the harness leaf (claude/kiro), shared by every plugin — keying
// on it would let two plugins on one harness clobber each other's drops/retry
// files. Prefer the manifest `name`; fall back to the parent-dir <name> segment.
const PLUGIN_NAME = pluginNameFromRoot();
const PLUGIN_KEY = PLUGIN_NAME.replace(/[^\w.-]/g, "_");

// Resolve the hooks-health dir from the INSTALLED tree so compose drops land
// exactly where core hooks write theirs (hooksHealthDir under docsRoot) and where
// --doctor scans — not a bespoke flat path (round-2 major: the old path was read
// by nothing). Memoized; falls back to the workspace-level dir if the lib can't be
// loaded (e.g. a partial install), so a drop is never lost.
let _healthDir: string | null = null;
async function resolveHealthDir(): Promise<string> {
  if (_healthDir) return _healthDir;
  let dir: string;
  const lib = await installedAidlcLib();
  if (typeof lib?.hooksHealthDir === "function") {
    dir = lib.hooksHealthDir(PROJECT_DIR);
  } else {
    dir = join(PROJECT_DIR, "aidlc", "spaces", "default", "intents", ".aidlc-hooks-health");
  }
  _healthDir = dir;
  return dir;
}

// Buffer drops synchronously so callers stay sync; flush to disk once at the end
// (and eagerly on the pre-guard early exits). No silent failures. Each drop is
// tagged with a severity so --doctor can FAIL on a genuinely-degrading drop
// (a half-applied contribution, a failed compile) but treat a benign/expected one
// (a documented-deferred surface declared, a version-skew skip) as advisory. The
// severity is a leading `[degraded]`/`[advisory]` token on the reason field.
type DropSeverity = "degraded" | "advisory";
const _drops: string[] = [];
function recordDrop(reason: string, severity: DropSeverity = "degraded"): void {
  _drops.push(`${new Date().toISOString()}\t[${severity}] ${reason.replace(/\r?\n/g, " ")}`);
}
// Flush drops as the CURRENT run's complete record: OVERWRITE (not append), and
// REMOVE the file when the run had none. So the drops file always reflects only
// the latest compose — it self-clears when the cause is fixed and re-composed,
// and can't grow unboundedly on a persistent collision (round-5). Doctor reading
// it therefore sees a live signal, not accumulated history.
// The drops file is PER-PLUGIN (`plugin-compose-<PLUGIN_KEY>.drops`), not a
// single shared file: SessionStart runs one compose per installed plugin against
// the same project, and an overwrite-per-run shared file let the LAST plugin win
// — a clean plugin's compose (or an early-exit guard) deleted another plugin's
// live degraded drop, so doctor went green (round-6). Per-plugin files isolate
// each plugin's signal; doctor globs `*.drops` and aggregates them all.
async function flushDrops(): Promise<void> {
  try {
    const healthDir = await resolveHealthDir();
    const dropFile = join(healthDir, `plugin-compose-${PLUGIN_KEY}.drops`);
    if (_drops.length === 0) {
      if (existsSync(dropFile)) rmSync(dropFile, { force: true });
    } else {
      mkdirSync(healthDir, { recursive: true });
      writeFileSync(dropFile, _drops.map((l) => l + "\n").join(""), { flag: "w" });
    }
  } catch { /* truly non-fatal */ }
  _drops.length = 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function installedOrchestratorSkillPath(): string {
  const harnessSkill = join(SKILLS_DIR, "aidlc", "SKILL.md");
  if (existsSync(harnessSkill)) return harnessSkill;
  const agentsSkill = join(PROJECT_DIR, ".agents", "skills", "aidlc", "SKILL.md");
  if (existsSync(agentsSkill)) return agentsSkill;
  return harnessSkill;
}

function selectedPlugins(): Set<string> | null {
  try {
    const raw = readFileSync(join(HARNESS_DIR, "tools", "data", "harness.json"), "utf-8");
    const parsed = JSON.parse(raw) as { plugins?: unknown };
    if (!Object.hasOwn(parsed, "plugins")) return null;
    if (!Array.isArray(parsed.plugins)) return null;
    const names = parsed.plugins.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    return new Set(names.map((s) => s.trim()));
  } catch {
    return null;
  }
}

function pluginEnabledBySelection(): boolean {
  // Keep in sync with aidlc-lib.ts stageEnabledBySelection.
  const selected = selectedPlugins();
  return selected === null || selected.has(PLUGIN_NAME);
}

function selectCommandForPlugin(): string {
  const selected = selectedPlugins();
  const names = new Set<string>(selected ?? ["aidlc"]);
  names.add(PLUGIN_NAME);
  return `bun ${HARNESS_LEAF}/tools/aidlc-utility.ts select-plugins ${[...names].sort().join(",")}`;
}

function installedToolCommand(tool: "utility" | "graph" | "runner", args: string[]): string[] {
  const executable = process.env.AIDLC_COMPILED_EXECUTABLE?.trim();
  if (!executable) {
    const files = {
      utility: "aidlc-utility.ts",
      graph: "aidlc-graph.ts",
      runner: "aidlc-runner-gen.ts",
    };
    return [process.execPath, join(HARNESS_DIR, "tools", files[tool]), ...args];
  }
  if (tool === "utility") return [executable, "gen", ...args];
  if (tool === "graph") return [executable, "graph", ...args];
  if (args[0] === "write") return [executable, "gen", "runners", ...args.slice(1)];
  if (args[0] === "scopes") return [executable, "gen", "runner-scopes", ...args.slice(1)];
  if (args[0] === "list") return [executable, "gen", "runner-list", ...args.slice(1)];
  throw new Error(`No compiled dispatcher route for aidlc-runner-gen ${args.join(" ")}`);
}

function installedToolEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AIDLC_HARNESS_DIR: HARNESS_LEAF,
    AIDLC_STAGE_GRAPH: join(HARNESS_DIR, "tools", "data", "stage-graph.json"),
    AIDLC_SCOPE_GRID: join(HARNESS_DIR, "tools", "data", "scope-grid.json"),
    AIDLC_STAGES_DIR: STAGES_DIR,
    AIDLC_SENSORS_DIR: join(HARNESS_DIR, "sensors"),
    AIDLC_SCOPES_DIR: join(HARNESS_DIR, "scopes"),
    AIDLC_AGENTS_DIR: join(HARNESS_DIR, "agents"),
    AIDLC_RULES_DIR: join(PROJECT_DIR, "aidlc", "spaces", "default", "memory"),
  };
}

function refreshSkillGeneratedRegion(
  verb: "scope-table" | "stage-table",
  beginMarker: string,
  endMarker: string,
): void {
  const skillMd = installedOrchestratorSkillPath();
  if (!existsSync(skillMd)) {
    recordDrop(`${verb} refresh skipped: ${relative(PROJECT_DIR, skillMd)} not present in this install`, "advisory");
    return;
  }

  const before = readFileSync(skillMd, "utf-8").replace(/\r\n/g, "\n");
  if (!before.includes(beginMarker)) {
    recordDrop(`${verb} refresh skipped: SKILL.md missing BEGIN marker`, "advisory");
    return;
  }
  const beginIdx = before.indexOf(beginMarker);
  const endIdx = before.indexOf(endMarker, beginIdx);
  if (endIdx === -1) {
    recordDrop(`${verb} refresh failed: SKILL.md missing END marker after BEGIN marker`);
    return;
  }

  const [command, ...args] = installedToolCommand("utility", [verb]);
  const r = spawnSync(command, args, {
    cwd: PROJECT_DIR,
    encoding: "utf-8",
    env: installedToolEnv(),
  });
  if (r.status !== 0) {
    recordDrop(`aidlc-utility ${verb} failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
    return;
  }

  const region = (r.stdout || "").replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (!region.includes(beginMarker) || !region.includes(endMarker)) {
    recordDrop(`aidlc-utility ${verb} emitted an invalid generated region`);
    return;
  }

  const after =
    before.slice(0, beginIdx) +
    region +
    before.slice(endIdx + endMarker.length);
  if (after !== before) writeFileSync(skillMd, after);
}

// Does the INSTALLED engine accept a frontmatter key? Probes the installed
// validator (not our own copy) so compose never writes a key an older shipped
// engine would reject — which would permanently break that install's graph
// compile with only a drops line as evidence (round-3 blocker). Run the installed
// validateStageFrontmatter against a minimal-but-valid stage carrying the key; if
// it rejects specifically because of that key, the merge is unsafe here. Fails
// OPEN (returns true) if the lib can't be loaded — a partial install already
// can't compile, so we don't add a second failure mode.
async function installedSchemaAccepts(key: string, sampleValue: unknown): Promise<boolean> {
  const schema = await installedStageSchema();
  if (typeof schema?.validateStageFrontmatter === "function") {
    try {
      const base: Record<string, unknown> = {
        slug: "probe-stage", phase: "construction", execution: "ALWAYS", condition: "always",
        lead_agent: "aidlc-quality-agent", support_agents: [], mode: "inline",
        produces: [], consumes: [], requires_stage: [], inputs: "x", outputs: "y",
      };
      const withKey = { ...base, [key]: sampleValue };
      const res = schema.validateStageFrontmatter(withKey);
      if (res.valid) return true;
      // Rejected — is it BECAUSE of our key? (An unknown/!array error naming it.)
      const errs: string[] = res.errors ?? [];
      return !errs.some((e) => e.includes(key));
    } catch {
      return true; // probe failed → don't block (see note above)
    }
  }
  return true; // module unavailable → don't block (see note above)
}

// Guard: only compose in an AIDLC project, with a resolvable plugin root.
export async function compose(): Promise<void> {
if (!existsSync(join(HARNESS_DIR, "tools", "aidlc-graph.ts"))) {
  return; // not an AIDLC project — nothing to do (no drop: not our project)
}
if (!PLUGIN_ROOT) {
  recordDrop("plugin root env not set (CLAUDE_PLUGIN_ROOT/PLUGIN_ROOT/AIDLC_PLUGIN_ROOT)");
  await flushDrops();
  return;
}
// A set-but-wrong PLUGIN_ROOT (e.g. a mistyped path from a hand-run command)
// would otherwise pass the non-empty check and then find nothing to copy/merge —
// a silent no-op. Record it so it surfaces in --doctor rather than looking clean.
if (!existsSync(PLUGIN_ROOT)) {
  recordDrop(`plugin root does not exist: "${PLUGIN_ROOT}" — check the AIDLC_PLUGIN_ROOT path`);
  await flushDrops();
  return;
}

if (!pluginEnabledBySelection()) {
  recordDrop(
    `plugin "${PLUGIN_NAME}" composed but is not enabled by tools/data/harness.json; run \`${selectCommandForPlugin()}\` to expose its stages, scopes, and runners`,
    "advisory",
  );
}

// --- helpers ---------------------------------------------------------------

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

type CopyContext = { file: string; rel: string; content: string };
type CopyPrecheck = (ctx: CopyContext & { dest: string }) => boolean;
type CopyTransform = (ctx: CopyContext) => string;

function frontmatterName(content: string): string | null {
  const name = frontmatter(content).match(/^name:\s*(.+)$/m)?.[1].trim();
  return name || null;
}

// Read one top-level frontmatter scalar for parser-unavailable safety checks.
// Handles the quoted and unquoted forms accepted by the real YAML parser.
function frontmatterScalar(content: string, key: string): string | null {
  const match = frontmatter(content).match(
    new RegExp(`^${escapeRegExp(key)}:\\s*(.*?)\\s*$`, "m"),
  );
  if (!match) return null;
  let value = match[1].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  } else {
    value = value.replace(/\s+#.*$/, "").trim();
  }
  return value;
}

function installedNameRoster(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const path = join(dir, file);
    try {
      if (statSync(path).isDirectory()) continue;
      const name = frontmatterName(readFileSync(path, "utf-8"));
      if (name && !out.has(name)) out.set(name, path);
    } catch {
      // Installed loader owns malformed-file handling. Compose only needs the
      // parseable names for no-clobber by frontmatter name.
    }
  }
  return out;
}

function installedNameCollisionPrecheck(dst: string, kind: "agents" | "scopes"): CopyPrecheck {
  const installedByName = installedNameRoster(dst);
  return ({ file, dest, content }) => {
    if (!file.endsWith(".md")) return true;
    // `aidlc-` is core's namespace: a scope declaring an aidlc--prefixed
    // plugin: would generate a runner dir on core's `aidlc-<name>` path and
    // silently clobber it. Reject the file, mirroring the compile-side guard.
    const declaredPlugin = frontmatter(content).match(/^plugin:\s*(.+)$/m)?.[1].trim();
    if (declaredPlugin?.startsWith("aidlc-")) {
      recordDrop(
        `plugin "${PLUGIN_NAME}" ${kind} file "${relative(PLUGIN_ROOT, file)}" declares plugin "${declaredPlugin}"; the "aidlc-" prefix is reserved for core (it collides with core runner paths); not copied`,
        "degraded",
      );
      return false;
    }
    const name = frontmatterName(content);
    if (!name) return true;
    const collidingFile = installedByName.get(name);
    if (!collidingFile || collidingFile === dest) return true;
    recordDrop(
      `plugin "${PLUGIN_NAME}" ${kind} file "${relative(PLUGIN_ROOT, file)}" declares name "${name}", colliding with installed file "${relative(PROJECT_DIR, collidingFile)}"; not copied`,
      "degraded",
    );
    return false;
  };
}

function projectOpencodeAgentMemory(raw: string): string {
  return raw
    .replaceAll(".aidlc/rules/aidlc-org.md", "aidlc/spaces/default/memory/org.md")
    .replaceAll(".aidlc/rules/aidlc-team.md", "aidlc/spaces/default/memory/team.md")
    .replaceAll(".aidlc/rules/aidlc-project.md", "aidlc/spaces/default/memory/project.md")
    .replaceAll(".aidlc/rules/", "aidlc/spaces/default/memory/");
}

function opencodeNativeAgentPrecheck(dst: string): CopyPrecheck {
  const collision = installedNameCollisionPrecheck(dst, "agents");
  return (ctx) => {
    if (!collision(ctx)) return false;
    if (!ctx.content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)) {
      recordDrop(
        `plugin "${PLUGIN_NAME}" agent file "${ctx.rel}" has no closed frontmatter block; not copied to OpenCode's native roster`,
      );
      return false;
    }
    const disallowed = frontmatter(ctx.content).match(/^disallowedTools:\s*(.*?)\s*$/m)?.[1];
    if (disallowed && !/^\s*Task\s*$/i.test(disallowed)) {
      recordDrop(
        `plugin "${PLUGIN_NAME}" agent file "${ctx.rel}" cannot project disallowedTools "${disallowed}" to OpenCode; not copied`,
      );
      return false;
    }
    return true;
  };
}

function emitOpencodeNativeAgent({ file, content }: CopyContext): string {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error(`${file}: plugin agent has no closed frontmatter block`);
  let fm = m[1]
    .split(/\r?\n/)
    .filter((line) =>
      !/^disallowedTools:/.test(line) &&
      !/^mode:/.test(line) &&
      !/^tier:/.test(line) &&
      !/^effort:/.test(line)
    )
    .filter((line) => {
      const model = line.match(/^model:\s*(.*?)(?:\s+#.*)?\s*$/)?.[1];
      return model === undefined || model.includes("/");
    })
    .join("\n");
  if (/^permission:\s*$/m.test(fm)) {
    if (/^ {2}task:/m.test(fm)) {
      fm = fm.replace(/^ {2}task:.*$/m, "  task: deny");
    } else {
      fm = fm.replace(/^permission:\s*$/m, "permission:\n  task: deny");
    }
  } else {
    fm += "\npermission:\n  task: deny";
  }
  fm += "\nmode: subagent";
  return content.replace(m[0], () => `---\n${fm}\n---\n`);
}

function combinePrechecks(...checks: Array<CopyPrecheck | undefined>): CopyPrecheck {
  return (ctx) => checks.every((check) => check === undefined || check(ctx));
}

// `agent-team` is accepted by the shared schema as a reserved future mode, but
// no shipped conductor can execute it. Reject new plugin stages on every
// harness until that runtime consumer exists. Existing no-clobber copies remain
// on disk and are health-reported so an upgrade never hides the unsafe stage.
async function unsupportedRuntimeModePrecheck(): Promise<CopyPrecheck> {
  const lib = await installedAidlcLib();
  const parse = typeof lib?.parseStageFrontmatter === "function"
    ? lib.parseStageFrontmatter
    : null;
  const parsedModeAndSlug = (
    content: string,
    rel: string,
  ): { mode: string | null; slug: string } => {
    let parsed: Record<string, unknown> | null = null;
    if (parse) {
      try {
        parsed = parse(content);
      } catch {
        // The installed schema precheck owns malformed-stage diagnostics.
      }
    }
    return {
      mode: typeof parsed?.mode === "string"
        ? parsed.mode
        : frontmatterScalar(content, "mode"),
      slug: typeof parsed?.slug === "string"
        ? parsed.slug
        : slugFromPath(rel),
    };
  };

  // copyTreeNoClobber skips prechecks when the destination exists. Audit
  // installed reserved modes up front so upgrades cannot leave one silently.
  const stagesRoot = join(PLUGIN_ROOT, "stages");
  for (const file of walk(stagesRoot).filter((path) => path.endsWith(".md"))) {
    const rel = relative(stagesRoot, file).replace(/\\/g, "/");
    const dest = join(STAGES_DIR, rel);
    if (!existsSync(dest)) continue;
    let installed = "";
    try {
      installed = readFileSync(dest, "utf-8");
    } catch {
      continue;
    }
    const { mode, slug } = parsedModeAndSlug(installed, rel);
    if (mode !== "agent-team") continue;
    recordDrop(
      `plugin "${PLUGIN_NAME}" stage "${slug}" is already composed with reserved mode "agent-team", which has no runtime consumer; change it to inline, subagent, pipeline, or mob, then remove/re-compose the installed stage`,
    );
  }

  return ({ file, rel, dest, content }) => {
    if (!file.endsWith(".md")) return true;
    const { mode, slug } = parsedModeAndSlug(content, rel);
    if (mode !== "agent-team") return true;
    if (existsSync(dest)) {
      recordDrop(
        `plugin "${PLUGIN_NAME}" stage "${slug}" is already composed with reserved mode "agent-team", which has no runtime consumer; change it to inline, subagent, pipeline, or mob, then remove/re-compose the installed stage`,
      );
      return true;
    }
    composeDroppedStageSlugs.add(slugFromPath(rel));
    composeDroppedStageSlugs.add(slug);
    recordDrop(
      `plugin "${PLUGIN_NAME}" stage "${slug}" uses reserved mode "agent-team" and was not composed: the mode has no runtime consumer yet; change it to inline, subagent, pipeline, or mob`,
    );
    return false;
  };
}

interface KiroPluginAgentPrechecks {
  stage: CopyPrecheck;
  agent: CopyPrecheck;
}

// OpenCode's dispatch surface is the native roster `.opencode/agents/<a>.md`.
// Unlike Kiro/Codex surfaces (which a plugin can never ship), a plugin's own
// Markdown persona IS the source of the native twin compose emits later in
// this same pass — so a stage may reference an agent whose surface arrives
// with the plugin. Accept that only when the shipped file would survive the
// full opencodeNativeAgentPrecheck: closed frontmatter, no un-projectable
// disallowedTools, AND no name collision with a different installed native
// agent — a collision-dropped twin would leave the accepted stage without its
// dispatch target.
function pluginShipsViableOpencodeAgent(agent: string): boolean {
  const file = join(PLUGIN_ROOT, "agents", `${agent}.md`);
  if (!existsSync(file)) return false;
  let content = "";
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return false;
  }
  if (!content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/)) return false;
  const declaredPlugin = frontmatter(content).match(/^plugin:\s*(.+)$/m)?.[1].trim();
  if (declaredPlugin?.startsWith("aidlc-")) return false;
  const disallowed = frontmatter(content).match(/^disallowedTools:\s*(.*?)\s*$/m)?.[1];
  if (disallowed && !/^\s*Task\s*$/i.test(disallowed)) return false;
  const nativeAgentsDir = join(PROJECT_DIR, ".opencode", "agents");
  const name = frontmatterName(content);
  if (!name) return true;
  const collidingFile = installedNameRoster(nativeAgentsDir).get(name);
  return !collidingFile || collidingFile === join(nativeAgentsDir, `${agent}.md`);
}

// Kiro, Codex, and OpenCode cannot dispatch a Markdown-only persona from the
// engine roster. Kiro requires BOTH a hand-authored agent-v1 JSON and conductor
// trustedAgents registration; Codex requires an agent config TOML; OpenCode
// requires a native `.opencode/agents/<a>.md` subagent (installed, or viably
// shipped by this plugin — see pluginShipsViableOpencodeAgent). Reject any
// dispatched stage whose lead, support, or reviewer lacks that complete
// surface. Markdown personas remain composable for accepted inline stages.
async function kiroPluginAgentPrechecks(): Promise<KiroPluginAgentPrechecks | null> {
  if (
    HARNESS_LEAF !== ".kiro" &&
    HARNESS_LEAF !== ".codex" &&
    HARNESS_LEAF !== ".aidlc"
  ) {
    return null;
  }
  const surfaceExt = HARNESS_LEAF === ".kiro"
    ? ".json"
    : HARNESS_LEAF === ".codex"
      ? ".toml"
      : ".md";
  const surfaceDir = HARNESS_LEAF === ".aidlc"
    ? join(PROJECT_DIR, ".opencode", "agents")
    : join(HARNESS_DIR, "agents");
  const trustedAgents = new Set<string>();
  if (HARNESS_LEAF === ".kiro") {
    try {
      const conductor = JSON.parse(
        readFileSync(join(HARNESS_DIR, "agents", "aidlc.json"), "utf-8"),
      ) as {
        toolsSettings?: { subagent?: { trustedAgents?: unknown } };
      };
      const configured = conductor.toolsSettings?.subagent?.trustedAgents;
      if (Array.isArray(configured)) {
        for (const agent of configured) {
          if (typeof agent === "string") trustedAgents.add(agent);
        }
      }
    } catch {
      // Empty set is fail-closed: a broken conductor cannot dispatch any agent.
    }
  }
  interface DispatchGap {
    agent: string;
    missingSurface: boolean;
    missingTrust: boolean;
  }
  const remediationFor = (gap: DispatchGap, isReviewer: boolean): string => {
    const requirements: string[] = [];
    if (gap.missingSurface) {
      requirements.push(
        HARNESS_LEAF === ".kiro"
          ? `author ${HARNESS_LEAF}/agents/${gap.agent}.json (agent-v1 JSON)`
          : HARNESS_LEAF === ".codex"
            ? `author ${HARNESS_LEAF}/agents/${gap.agent}.toml (the shipped aidlc-*-agent.toml shape)`
            : `author .opencode/agents/${gap.agent}.md (an OpenCode subagent with closed frontmatter)`,
      );
    }
    if (gap.missingTrust) {
      requirements.push(
        `add "${gap.agent}" to toolsSettings.subagent.trustedAgents in ${HARNESS_LEAF}/agents/aidlc.json`,
      );
    }
    const alternative = isReviewer
      ? "remove the stage's reviewer: field"
      : "change the stage's mode to inline";
    return `${requirements.join(" and ")}, or ${alternative}`;
  };

  const stagesRoot = join(PLUGIN_ROOT, "stages");
  const stageFiles = walk(stagesRoot).filter((path) => path.endsWith(".md"));
  if (stageFiles.length === 0) return null;

  // Existing stages cannot be deleted by a no-clobber compose hook, but they
  // still need a degraded health row when unsafe. Otherwise an install upgraded
  // from the pre-guard composer remains silently wedged forever.
  const alreadyComposed = (rel: string): boolean => existsSync(join(STAGES_DIR, rel));
  // The self-heal probe below filters expected graph slugs by FILENAME STEM,
  // so bookkeeping must record the stem (the frontmatter slug is recorded too
  // for human-readable drop correlation, but the stem is load-bearing).
  const recordDroppedStage = (rel: string, slug: string | null): void => {
    composeDroppedStageSlugs.add(slugFromPath(rel));
    if (slug) composeDroppedStageSlugs.add(slug);
  };

  const lib = await installedAidlcLib();
  const parse = typeof lib?.parseStageFrontmatter === "function"
    ? lib.parseStageFrontmatter
    : null;
  if (!parse) {
    // Without the installed parser, accept only an explicitly inline,
    // reviewer-free stage. This scalar fallback handles quoted YAML values and
    // fails closed on reserved, unknown, or missing modes.
    const rejected = new Set<string>();
    for (const file of stageFiles) {
      let raw = "";
      try {
        raw = readFileSync(file, "utf-8");
      } catch {
        continue;
      }
      const rel = relative(stagesRoot, file).replace(/\\/g, "/");
      const mode = frontmatterScalar(raw, "mode");
      const reviewer = frontmatterScalar(raw, "reviewer");
      if (mode === "inline" && !reviewer) continue;
      if (alreadyComposed(rel)) {
        recordDrop(
          `plugin "${PLUGIN_NAME}" stage "${rel}" is already composed but its mode/reviewer dispatch safety cannot be validated because the installed stage parser is unavailable; restore tools/aidlc-lib.ts and re-run compose, then remediate or remove the installed stage`,
        );
        continue;
      }
      rejected.add(rel);
      recordDroppedStage(rel, null);
      recordDrop(
        `plugin "${PLUGIN_NAME}" stage "${rel}" is not explicitly inline and reviewer-free and was not composed: the installed stage parser is unavailable, so its agent references cannot be validated for ${HARNESS_LEAF} dispatch; re-copy your dist/<harness>/ shell (restoring tools/aidlc-lib.ts) and re-run compose — explicitly inline stages and personas composed normally`,
      );
    }
    return {
      stage: ({ rel }) => !rejected.has(rel.replace(/\\/g, "/")),
      agent: () => true,
    };
  }

  const rejectedStageFiles = new Set<string>();
  for (const file of stageFiles) {
    let parsed: Record<string, unknown>;
    try {
      parsed = parse(readFileSync(file, "utf-8"));
    } catch {
      continue;
    }
    const mode = typeof parsed.mode === "string" ? parsed.mode : "";
    const rel = relative(stagesRoot, file).replace(/\\/g, "/");
    const slug = typeof parsed.slug === "string"
      ? parsed.slug
      : slugFromPath(rel);
    const supportAgents = Array.isArray(parsed.support_agents)
      ? parsed.support_agents.filter((agent): agent is string => typeof agent === "string")
      : [];
    // Inline is the only topology that does not dispatch the stage body.
    // Treat every other parsed mode as dispatched so future schema modes
    // inherit agent surface/trust validation automatically.
    const dispatches = mode !== "inline";

    // The reviewer dispatches on EVERY gated stage — the conductor's §12a step
    // fires whenever directive.reviewer is present, independent of the stage's
    // body mode — so it is checked even on inline stages. Lead + supports
    // dispatch only under a dispatched body topology.
    const leadAgent = typeof parsed.lead_agent === "string" ? parsed.lead_agent : "";
    const reviewer = typeof parsed.reviewer === "string" ? parsed.reviewer : "";
    const dispatchedAgents = [
      ...(dispatches ? [leadAgent, ...supportAgents] : []),
      reviewer,
    ];
    const gaps = new Map<string, DispatchGap>();
    for (const agent of dispatchedAgents) {
      if (!agent || gaps.has(agent)) continue;
      const gap = {
        agent,
        missingSurface: !existsSync(join(surfaceDir, `${agent}${surfaceExt}`)) &&
          !(HARNESS_LEAF === ".aidlc" && pluginShipsViableOpencodeAgent(agent)),
        missingTrust: HARNESS_LEAF === ".kiro" && !trustedAgents.has(agent),
      };
      if (gap.missingSurface || gap.missingTrust) gaps.set(agent, gap);
    }
    if (gaps.size === 0) continue;

    const existing = alreadyComposed(rel);
    if (!existing) {
      rejectedStageFiles.add(rel);
      recordDroppedStage(rel, slug);
    }
    for (const gap of gaps.values()) {
      const agent = gap.agent;
      const isReviewerOnly =
        agent === reviewer && !(dispatches && (agent === leadAgent || supportAgents.includes(agent)));
      const role = isReviewerOnly ? "as reviewer" : `with mode "${mode}"`;
      recordDrop(
        `plugin "${PLUGIN_NAME}" stage "${slug}" references agent "${agent}" ${role} and ${existing ? "is already composed but remains undispatchable" : "was not composed"}: ${remediationFor(gap, isReviewerOnly)}`,
      );
    }
  }

  return {
    stage: ({ rel }) => !rejectedStageFiles.has(rel.replace(/\\/g, "/")),
    // Markdown personas remain useful to accepted inline stages even when a
    // different stage that references the same persona was rejected.
    agent: () => true,
  };
}

// Validate a plugin stage file against the INSTALLED engine's schema before
// copying it into the install. Compile is all-or-nothing - aidlc-graph.ts
// throws on the first schema-invalid stage file - so one bad copy (e.g. a
// stale plugin tree still authoring the renamed bundle: key) would brick the
// install's EVERY later graph compile until the file is hand-deleted.
// Skip-and-drop instead, naming the file and the validator's errors, so the
// bad stage never lands and the rest of the plugin composes normally. A
// frontmatter-only stage (empty body) is dropped the same way: it compiles
// and routes while being behaviorally dead. Fails OPEN (copies) when the
// installed lib can't be loaded - a partial install already can't compile,
// so we don't add a second failure mode.
// Slugs a compose precheck refused, so the "did my stages reach the compiled
// graph?" self-heal probe below does not see a deliberately-dropped stage as a
// failed compile and force a recompile every session.
const composeDroppedStageSlugs = new Set<string>();
async function installedStageSchemaPrecheck(): Promise<CopyPrecheck> {
  let parse: ParseStageFrontmatter | null = null;
  let validate: ((obj: unknown) => { valid: boolean; errors?: string[] }) | null = null;
  const [lib, schema] = await Promise.all([
    installedAidlcLib(),
    installedStageSchema(),
  ]);
  if (
    typeof lib?.parseStageFrontmatter === "function" &&
    typeof schema?.validateStageFrontmatter === "function"
  ) {
    parse = lib.parseStageFrontmatter;
    validate = schema.validateStageFrontmatter;
  }
  return ({ file, rel, content }) => {
    if (!file.endsWith(".md") || !parse || !validate) return true;
    let errors: string[];
    try {
      const res = validate(parse(content));
      errors = res.valid ? [] : (res.errors ?? ["schema validation failed"]);
    } catch (e) {
      errors = [e instanceof Error ? e.message : String(e)];
    }
    if (errors.length === 0) {
      const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      if (body.trim().length === 0) {
        errors = ["stage body is empty after the frontmatter fence (a behaviorally dead stage)"];
      }
    }
    // Mirror compile's ownership invariants (aidlc-graph.ts) - they are
    // compile-time THROWS, so a landed file violating them bricks the whole
    // graph compile exactly like a schema-invalid one.
    if (errors.length === 0) {
      const fmBlock = frontmatter(content);
      const declaredPlugin = fmBlock.match(/^plugin:\s*(.+)$/m)?.[1].trim();
      const declaredSlug = fmBlock.match(/^slug:\s*(.+)$/m)?.[1].trim() ?? "";
      if (declaredPlugin === "aidlc") {
        errors = ['declares plugin "aidlc"; omit plugin for core stages'];
      } else if (declaredPlugin?.startsWith("aidlc-")) {
        errors = [`declares plugin "${declaredPlugin}"; the "aidlc-" prefix is reserved for core (a plugin named aidlc-<x> collides with core runner paths)`];
      } else if (declaredPlugin && !declaredSlug.startsWith(`${declaredPlugin}-`)) {
        errors = [`slug "${declaredSlug}" does not start with "${declaredPlugin}-" (plugin-owned stage slugs must carry the plugin prefix)`];
      }
    }
    if (errors.length === 0) return true;
    composeDroppedStageSlugs.add(slugFromPath(rel));
    recordDrop(
      `plugin "${PLUGIN_NAME}" stage file "${rel}" not composed: ${errors.join("; ")} - fix the plugin's stage file and re-run compose`,
    );
    return false;
  };
}

// No-clobber copy of one tree into another, with {{HARNESS_DIR}} substitution on
// .md prose. NEVER overwrites an existing dest (portable no-clobber — the point
// of the former `cp -n`, done right). Returns true if anything was written.
// `kind` labels the tree for the collision drop-log: a
// dest that already exists with DIFFERENT content is a real collision (a plugin
// trying to ship a file that shadows core or another plugin) and is dropped-with-
// log — silently skipping it made a plugin "override" a no-op with no evidence
// (round-4). An identical dest is a benign idempotent re-run (no log).
function copyTreeNoClobber(
  src: string,
  dst: string,
  kind: string,
  precheck?: CopyPrecheck,
  transform?: CopyTransform,
): boolean {
  if (!existsSync(src)) return false;
  let wrote = false;
  for (const file of walk(src)) {
    const rel = relative(src, file);
    const dest = join(dst, rel);
    let buf = readFileSync(file);
    if (file.endsWith(".md")) {
      buf = Buffer.from(buf.toString("utf-8").replaceAll("{{HARNESS_DIR}}", HARNESS_LEAF));
    }
    if (existsSync(dest)) {
      // no-clobber — never replace core/another plugin. Log only a genuine
      // content collision, not an identical idempotent re-copy. The installed
      // copy was written transformed, so transform before comparing; a source
      // the transform rejects cannot equal any installed copy.
      let current: Buffer | null = buf;
      if (transform) {
        try {
          current = Buffer.from(transform({ file, rel, content: buf.toString("utf-8") }));
        } catch {
          current = null;
        }
      }
      if (current === null || !readFileSync(dest).equals(current)) {
        recordDrop(`${kind} "${rel}" collides with an existing file (core or another plugin); not overwritten — rename it to a plugin-namespaced path`);
      }
      continue;
    }
    // Precheck BEFORE transform, on the pre-transform text: the precheck is
    // the skip-and-drop gate for exactly the shapes a transform throws on
    // (emitOpencodeNativeAgent on a frontmatter-less persona), so transforming
    // first turns a one-file drop into an aborted compose. It also keeps the
    // precheck's shape checks live — the emitter strips disallowedTools, so a
    // post-transform precheck could never reject an un-projectable value.
    if (precheck && !precheck({ file, rel, dest, content: buf.toString("utf-8") })) continue;
    if (transform) {
      buf = Buffer.from(transform({ file, rel, content: buf.toString("utf-8") }));
    }
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, buf);
    wrote = true;
  }
  return wrote;
}

function findStageFile(slug: string): string | null {
  for (const phase of PHASES) {
    const p = join(STAGES_DIR, phase, `${slug}.md`);
    if (existsSync(p)) return p;
  }
  return null;
}

// Read half: a single frontmatter split (LF/CRLF tolerant) shared by every read
// in this file — after the three-file fold there is one parser here, not two, so
// a robustness fix lands once (review #8). Contribution frontmatter is a distinct
// shape (target/adds/fragments) from stage frontmatter, so it stays local rather
// than importing aidlc-lib's stage parser.
function frontmatter(content: string): string {
  return content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
}

// Append items to a top-level list field, or replace the inline-empty `field: []`
// form with a block (fixes the silent-drop asymmetry, review #5). Idempotent.
// Returns the (possibly unchanged) content; logs when a field is absent entirely.
// `added` (when given) collects the values THIS call actually wrote - the
// contribution sidecar records actually-added entries, never declared ones, so
// a later removal can't strip a value core (or another plugin) already had.
function mergeListField(content: string, field: string, items: string[], target: string, added?: string[]): string {
  if (items.length === 0) return content;
  const emptyRe = new RegExp(`^${field}:\\s*\\[\\s*\\]\\s*$`, "m");
  if (emptyRe.test(content)) {
    added?.push(...items);
    return content.replace(emptyRe, `${field}:\n` + items.map((i) => `  - ${i}`).join("\n"));
  }
  const blockRe = new RegExp(`^(${field}:\\n(?:  - .+\\n)*)`, "m");
  const m = content.match(blockRe);
  if (!m) {
    recordDrop(`contribution to ${target}: no '${field}:' field to append to (adds dropped)`);
    return content;
  }
  const existing = new Set([...m[1].matchAll(/^ {2}- (.+)$/gm)].map((x) => x[1].trim()));
  const toAdd = items.filter((i) => !existing.has(i));
  if (toAdd.length === 0) return content;
  added?.push(...toAdd);
  return content.replace(blockRe, m[1] + toAdd.map((i) => `  - ${i}`).join("\n") + "\n");
}

// Append consumes objects (artifact + required + optional conditional_on).
// Handles block + `consumes: []`.
type ConsumeEntry = { artifact: string; required: boolean; conditional_on?: string };
function mergeConsumes(content: string, entries: ConsumeEntry[], target: string, added?: string[]): string {
  if (entries.length === 0) return content;
  const render = (e: ConsumeEntry) =>
    `  - artifact: ${e.artifact}\n    required: ${e.required}` +
    (e.conditional_on ? `\n    conditional_on: ${e.conditional_on}` : "");
  const emptyRe = /^consumes:\s*\[\s*\]\s*$/m;
  if (emptyRe.test(content)) {
    added?.push(...entries.map((e) => e.artifact));
    return content.replace(emptyRe, "consumes:\n" + entries.map(render).join("\n"));
  }
  // Each entry is `- artifact:` plus every following indented continuation line
  // (`required:`, `conditional_on:`). Matching those continuations is what keeps
  // an append AFTER the last core entry — omit `conditional_on` and the block
  // ends early, splicing the new entry INSIDE a core entry and stealing its
  // brownfield gate (round-2 major). The new entries land past the whole block.
  const blockRe = /^(consumes:\n(?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m;
  const m = content.match(blockRe);
  if (!m) {
    recordDrop(`contribution to ${target}: no 'consumes:' field to append to`);
    return content;
  }
  const existing = new Set([...m[1].matchAll(/- artifact:\s*([\w-]+)/g)].map((x) => x[1]));
  const toAdd = entries.filter((e) => !existing.has(e.artifact));
  if (toAdd.length === 0) return content;
  added?.push(...toAdd.map((e) => e.artifact));
  return content.replace(blockRe, m[1] + toAdd.map(render).join("\n") + "\n");
}

// Merge required_sections (quoted-string values, e.g. "Branch Coverage"). Unlike
// produces/sensors, a core stage often has NO required_sections field, so this
// ADDS the field (before the closing frontmatter `---`) when absent, appends to
// the block form, and replaces the inline-empty `[]` form. Idempotent by value.
// `meta.created` is set when this call ADDED the field itself, so a later
// removal knows to delete the whole field rather than leave an empty block.
function mergeRequiredSections(content: string, items: string[], target: string, added?: string[], meta?: { created?: boolean }): string {
  if (items.length === 0) return content;
  const render = (list: string[]) => list.map((s) => `  - "${s}"`).join("\n");
  const emptyRe = /^required_sections:\s*\[\s*\]\s*$/m;
  if (emptyRe.test(content)) {
    added?.push(...items);
    return content.replace(emptyRe, "required_sections:\n" + render(items));
  }
  const blockRe = /^(required_sections:\n(?: {2}- .+\n)*)/m;
  const m = content.match(blockRe);
  if (m) {
    const existing = new Set([...m[1].matchAll(/^ {2}- (.+?)\s*$/gm)].map((x) => x[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")));
    const toAdd = items.filter((s) => !existing.has(s));
    if (toAdd.length === 0) return content;
    added?.push(...toAdd);
    return content.replace(blockRe, m[1] + render(toAdd) + "\n");
  }
  // Field absent — insert it just before the closing frontmatter `---`. The
  // closing fence may be followed by a newline OR sit at EOF (a stage file with
  // no trailing newline is valid) — `(?:\n|$)` tolerates both; requiring `\r?\n`
  // after `---` silently dropped the whole merge on a newline-less file (round-4).
  const fmClose = content.match(/^---\r?\n[\s\S]*?\n(---)(?:\r?\n|$)/);
  if (!fmClose) {
    recordDrop(`contribution to ${target}: cannot add required_sections (no frontmatter block)`);
    return content;
  }
  added?.push(...items);
  if (meta) meta.created = true;
  const insertAt = fmClose.index! + fmClose[0].lastIndexOf("---");
  return content.slice(0, insertAt) + "required_sections:\n" + render(items) + "\n" + content.slice(insertAt);
}

// Resolve a fragment anchor to a char offset. Anchors are validated + escaped
// (review #6) — a malformed anchor is skipped-with-log, never a thrown regex. A
// valid anchor whose target heading is ABSENT also returns -1 but logs a distinct
// "not found" drop (round-4: the not-found case was silent, so a contribution's
// frontmatter `adds` landed while its prose vanished — a half-applied merge).
function locateAnchor(content: string, anchor: string, target: string): number {
  const stepAnchor = (kind: "after" | "before"): number => {
    const n = anchor.slice(anchor.indexOf(":") + 1);
    if (!/^\d+$/.test(n)) { recordDrop(`contribution to ${target}: bad ${kind}-step anchor "${anchor}" (step must be an integer)`); return -1; }
    const want = Number(n);
    // Match a plain `### Step 7` OR a range heading `### Step 4-8:` that CONTAINS
    // `want` — core ships combined headings (e.g. build-and-test's `### Step 4-8:`),
    // and `^### Step 8\b` would never match "Step 4-8". Scan all step headings.
    let hit: { index: number; length: number } | null = null;
    for (const m of content.matchAll(/^### Step (\d+)(?:-(\d+))?\b.*$/gm)) {
      const lo = Number(m[1]); const hi = m[2] ? Number(m[2]) : lo;
      if (want >= lo && want <= hi) { hit = { index: m.index!, length: m[0].length }; break; }
    }
    if (!hit) { recordDrop(`contribution to ${target}: ${kind}-step anchor "${anchor}" — no "### Step ${n}" heading found (a range like "### Step 4-8" counts); prose dropped`); return -1; }
    if (kind === "before") return hit.index;
    const from = hit.index + hit.length;
    const next = content.slice(from).search(/^#{2,3} /m);
    return next === -1 ? content.length : from + next;
  };
  if (anchor.startsWith("after-step:")) return stepAnchor("after");
  if (anchor.startsWith("before-step:")) return stepAnchor("before");
  if (anchor === "end-of-steps") {
    const s = content.match(/^## Steps\b.*$/m);
    if (!s) { recordDrop(`contribution to ${target}: anchor "end-of-steps" — no "## Steps" section found; prose dropped`); return -1; }
    const from = s.index! + s[0].length;
    const next = content.slice(from).search(/^## /m);
    return next === -1 ? content.length : from + next;
  }
  if (anchor.startsWith("in:")) {
    const comp = anchor.slice(3);
    if (!/^[\w -]+$/.test(comp)) { recordDrop(`contribution to ${target}: bad in: anchor "${anchor}"`); return -1; }
    const m = content.match(new RegExp(`^## ${escapeRegExp(comp)}\\b.*$`, "m"));
    if (!m) { recordDrop(`contribution to ${target}: in: anchor "${anchor}" — no "## ${comp}" section found; prose dropped`); return -1; }
    const from = m.index! + m[0].length;
    const next = content.slice(from).search(/^## /m);
    return next === -1 ? content.length : from + next;
  }
  recordDrop(`contribution to ${target}: unknown anchor "${anchor}"`);
  return -1;
}

// FNV-1a 32-bit hex — a dependency-free content fingerprint. Embedded in a
// fragment's sentinel so a plugin UPGRADE (rewritten prose) is detected and the
// old block replaced, rather than filtered as already-present forever.
function hashProse(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

interface Fragment { plugin: string; anchor: string; order: number; prose: string; }

// Splice ONE fragment into stage source, idempotently and order-deterministically.
// Each spliced block is delimited by an open sentinel carrying (plugin, anchor,
// order, content-hash) and a matching close sentinel. Because blocks are
// self-delimiting we can (a) skip when the same block is already present, (b)
// replace it when only the hash changed (upgrade), and (c) insert a NEW block at
// its correct (order, plugin) slot among peer plugin blocks at the same anchor —
// so plugins composing in separate hook runs still interleave by (order, plugin),
// never by hook-firing order. Never relies on "the next heading" to bound a block.
function spliceFragment(content: string, f: Fragment, target: string): string {
  const hash = hashProse(f.prose);
  const pE = escapeRegExp(f.plugin), aE = escapeRegExp(f.anchor);
  // The close marker carries the SAME content hash as the open, so the block's
  // boundary is content-specific: a close-marker-lookalike line inside the prose
  // (which lacks the exact hash) can't be mistaken for the real close on an
  // upgrade re-splice (round-5 — the old hashless close matched the first
  // occurrence, so prose containing the marker corrupted the block).
  const closeOf = (h: string) => `<!-- /plugin:${f.plugin}:${f.anchor}:${f.order}:${h} -->`;
  const block = `<!-- plugin:${f.plugin}:${f.anchor}:${f.order}:${hash} -->\n${f.prose}\n${closeOf(hash)}`;

  // Present already? Skip on hash match; replace the whole block on hash change.
  const mine = content.match(new RegExp(`<!-- plugin:${pE}:${aE}:${f.order}:([0-9a-f]+) -->`));
  if (mine) {
    if (mine[1] === hash) return content;
    const start = mine.index!;
    const oldClose = closeOf(mine[1]); // the OLD block's own hash-qualified close
    const end = content.indexOf(oldClose, start);
    if (end === -1) { recordDrop(`contribution to ${target}: fragment block for "${f.anchor}" order ${f.order} missing close marker; left as-is`); return content; }
    return content.slice(0, start) + block + content.slice(end + oldClose.length);
  }

  // Insert at the ordered slot among peer plugin blocks at this anchor (any plugin).
  const peers: Array<{ order: number; plugin: string; start: number; end: number }> = [];
  for (const m of content.matchAll(new RegExp(`<!-- plugin:([^:]+):${aE}:(\\d+):([0-9a-f]+) -->`, "g"))) {
    const peerPlugin = m[1], pOrder = Number(m[2]), pHash = m[3];
    const close = `<!-- /plugin:${peerPlugin}:${f.anchor}:${pOrder}:${pHash} -->`;
    const cIdx = content.indexOf(close, m.index!);
    if (cIdx === -1) continue;
    peers.push({ order: pOrder, plugin: peerPlugin, start: m.index!, end: cIdx + close.length });
  }
  if (peers.length > 0) {
    const after = peers.find((p) => p.order > f.order || (p.order === f.order && p.plugin.localeCompare(f.plugin) > 0));
    if (after) return content.slice(0, after.start) + block + "\n\n" + content.slice(after.start);
    const lastEnd = Math.max(...peers.map((p) => p.end));
    return content.slice(0, lastEnd) + "\n\n" + block + content.slice(lastEnd);
  }

  // Virgin anchor — use the structural locator for the base insertion point.
  const base = locateAnchor(content, f.anchor, target);
  if (base === -1) return content;
  return content.slice(0, base) + "\n" + block + "\n" + content.slice(base);
}

// --- main compose ----------------------------------------------------------

let changed = false;
try {
  const pluginKeySafe = await installedSchemaAccepts("plugin", "probe-name");

  // 1. Copy NEW primitives (no-clobber, token-substituted).
  // Plugin scopes and agents use the plugin prefix in place of core's `aidlc-`
  // prefix: scopes/<plugin>-<name>.md and agents/<plugin>-<role>-agent.md, with
  // the filename stem equal to frontmatter `name`.
  if (!pluginKeySafe) {
    recordDrop(
      "plugin-owned stages/scopes/agents not composed: installed engine predates the plugin: ownership key - re-copy your dist/<harness>/ shell, then re-run compose",
    );
  } else {
    const kiroAgentPrechecks = await kiroPluginAgentPrechecks();
    const stagePrecheck = combinePrechecks(
      await unsupportedRuntimeModePrecheck(),
      kiroAgentPrechecks?.stage,
      await installedStageSchemaPrecheck(),
    );
    changed = copyTreeNoClobber(join(PLUGIN_ROOT, "stages"), STAGES_DIR, "stage", stagePrecheck) || changed;
    const scopesDir = join(HARNESS_DIR, "scopes");
    const agentsDir = join(HARNESS_DIR, "agents");
    changed = copyTreeNoClobber(join(PLUGIN_ROOT, "scopes"), scopesDir, "scopes", installedNameCollisionPrecheck(scopesDir, "scopes")) || changed;
    changed = copyTreeNoClobber(
      join(PLUGIN_ROOT, "agents"),
      agentsDir,
      "agents",
      combinePrechecks(
        kiroAgentPrechecks?.agent,
        installedNameCollisionPrecheck(agentsDir, "agents"),
      ),
      HARNESS_LEAF === ".aidlc"
        ? ({ content }) => projectOpencodeAgentMemory(content)
        : undefined,
    ) || changed;
    if (HARNESS_LEAF === ".aidlc") {
      const nativeAgentsDir = join(PROJECT_DIR, ".opencode", "agents");
      changed = copyTreeNoClobber(
        join(PLUGIN_ROOT, "agents"),
        nativeAgentsDir,
        "OpenCode native agents",
        opencodeNativeAgentPrecheck(nativeAgentsDir),
        (ctx) => projectOpencodeAgentMemory(emitOpencodeNativeAgent(ctx)),
      ) || changed;
    }
  }
  changed = copyTreeNoClobber(join(PLUGIN_ROOT, "knowledge"), join(HARNESS_DIR, "knowledge"), "knowledge") || changed;
  changed = copyTreeNoClobber(join(PLUGIN_ROOT, "sensors"), join(HARNESS_DIR, "sensors"), "sensor") || changed;
  changed = copyTreeNoClobber(join(PLUGIN_ROOT, "tools"), join(HARNESS_DIR, "tools"), "tool") || changed;

  // 2. Merge contributions into stage SOURCE (structural + prose fragments).
  // Probe ONCE whether the installed engine accepts required_sections — writing
  // it into a stage an older engine can't parse would break every later compile.
  const requiredSectionsSafe = await installedSchemaAccepts("required_sections", ["Probe Section"]);
  const contribRoot = join(PLUGIN_ROOT, "contributions");
  // Per-plugin sidecar of what compose ACTUALLY merged into core stage source
  // (structural adds carry no in-file provenance, unlike the sentinel-marked
  // prose fragments), keyed by target stage. select-plugins reads it to strip
  // a disabled plugin's merged entries - without it, disable left the plugin's
  // produces/sensors/consumes welded into enabled core stages. Accumulated
  // across re-runs: entries this run added are unioned into any prior record
  // (an idempotent re-compose adds nothing and must not erase the record).
  type StageContribRecord = { produces?: string[]; sensors?: string[]; consumes?: string[]; required_sections?: string[]; required_sections_created?: boolean };
  const contribManifestPath = join(HARNESS_DIR, "tools", "data", `plugin-contrib-${PLUGIN_KEY}.json`);
  const contribManifest: Record<string, StageContribRecord> = (() => {
    try {
      const parsed = JSON.parse(readFileSync(contribManifestPath, "utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  })();
  const recordContrib = (target: string, field: keyof StageContribRecord, values: string[]): void => {
    if (values.length === 0) return;
    contribManifest[target] ??= {};
    const rec = contribManifest[target];
    if (field === "required_sections_created") return; // set directly, not via list
    const prior = new Set((rec[field] as string[] | undefined) ?? []);
    for (const v of values) prior.add(v);
    (rec[field] as string[]) = [...prior].sort();
  };
  let contribManifestDirty = false;
  // Fragment keys seen across ALL contribution files this run, so a same
  // (target, plugin, anchor, order) arriving from a SECOND file drops-with-log
  // rather than silently last-writer-winning via the hash-upgrade path (round-3).
  const seenFragKeys = new Set<string>();
  // Contributions merge ONLY for an enabled plugin. Stage/scope/agent copies
  // are safe under a disabling selection (runtime loaders filter them), but
  // merged contributions land in CORE stage source where no selection filter
  // reaches - so composing them while disabled would weld a disabled plugin's
  // produces/sensors/prose into enabled stages (and undo select-plugins'
  // disable-time strip on the very next session start). The advisory drop at
  // the top of this run already names the select-plugins command to enable.
  const contribPhases = pluginEnabledBySelection() && existsSync(contribRoot) ? readdirSync(contribRoot) : [];
  for (const phase of contribPhases) {
    const phaseDir = join(contribRoot, phase);
    let files: string[];
    try { files = readdirSync(phaseDir); } catch { continue; }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      // Normalize CRLF once so every downstream block/list regex is newline-safe;
      // strip a leading UTF-8 BOM and any leading blank lines so the `^---`
      // frontmatter anchor still matches a file saved with a BOM (common on
      // Windows) or a stray blank first line — otherwise the whole contribution
      // was silently skipped with no drop (round-5).
      const content = readFileSync(join(phaseDir, file), "utf-8")
        .replace(/\r\n/g, "\n").replace(/^﻿/, "").replace(/^\n+/, "");
      const fm = frontmatter(content);
      const target = fm.match(/^target:\s*(.+)$/m)?.[1].trim();
      // A .md in contributions/ with no parseable `target:` is a malformed
      // contribution — log it (a present-but-unknown target is already logged
      // below; a missing one was a silent bare continue).
      if (!target) { recordDrop(`contribution "${file}" has no parseable frontmatter target: — skipped (check for a BOM, a leading blank line, or a missing target: key)`); continue; }
      const plugin = fm.match(/^plugin:\s*(.+)$/m)?.[1].trim() ?? "";
      // `bundle:` was the pre-rename ownership key. It is dead, not aliased —
      // drop-log with the fix named so a stale plugin tree fails visibly
      // instead of composing under wrong or ambiguous ownership.
      if (/^bundle:\s*\S/m.test(fm)) {
        recordDrop(`contribution "${file}" uses the renamed bundle: key; write plugin: instead — skipped`);
        continue;
      }
      // `:` is the fragment-sentinel delimiter (<!-- plugin:<plugin>:anchor:order -->),
      // so a plugin containing `:` would break the peer-block scan's `[^:]+` and
      // silently misorder splices. Reject it up front (round-6).
      if (plugin.includes(":")) { recordDrop(`contribution "${file}" has an invalid plugin "${plugin}" (must not contain ':'); skipped`); continue; }
      const stageFile = findStageFile(target);
      if (!stageFile) { recordDrop(`contribution "${file}" targets missing stage "${target}"`); continue; }

      // structural: adds.produces / adds.sensors / adds.consumes
      const addsBlock = fm.match(/^adds:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? "";
      // Drop-log a parse shortfall, mirroring the consumes parser: the block
      // regex stops at the first non-4-space entry, so a mis-indented line
      // silently truncated the list (entries after it vanished with no log).
      const listOf = (f: string): string[] => {
        const s = addsBlock.match(new RegExp(`^ {2}${f}:\\n((?: {4}- [\\w-]+\\n?)*)`, "m"));
        const parsed = s ? [...s[1].matchAll(/^ {4}- ([\w-]+)/gm)].map((x) => x[1]) : [];
        const declaredBlock = addsBlock.match(new RegExp(`^ {2}${f}:\\n((?:\\s+- .*\\n?)*)`, "m"))?.[1] ?? "";
        const declared = (declaredBlock.match(/^\s+- /gm) ?? []).length;
        if (declared > parsed.length) {
          recordDrop(`contribution to ${target}: parsed ${parsed.length} of ${declared} adds.${f} entries (check indentation - entries must be 4-space "    - kebab-name"); some dropped`);
        }
        return parsed;
      };
      const consumes = (() => {
        // Parse consumes per-entry, NOT by zipping two independent artifact/required
        // scans: a dash-less `required:`/`conditional_on:` continuation line must
        // bind to the artifact above it, or entry 2+ is dropped and required flips
        // (round-2 blocker). Each entry starts at `- artifact:` and owns every
        // following indented non-dash line until the next `- artifact:`.
        const block = addsBlock.match(/^ {2}consumes:\n((?: {4}-? .*\n?)*)/m)?.[1];
        if (!block) return [];
        const out: Array<{ artifact: string; required: boolean; conditional_on?: string }> = [];
        // Split on ANY-indent `- artifact:` (a YAML-legal 6-space list must still
        // yield one chunk per entry; a fixed 4-space anchor silently merged them —
        // round-3). Drop-log if entries outnumber chunks (a split that failed).
        for (const chunk of block.split(/^(?=\s*- artifact:)/m)) {
          const artifact = chunk.match(/-\s*artifact:\s*([\w-]+)/)?.[1];
          if (!artifact) continue;
          // `required` defaults to true ONLY when the key is genuinely absent;
          // an explicit `required: false` must survive.
          const reqRaw = chunk.match(/^\s*required:\s*(true|false)\b/m)?.[1];
          const conditional_on = chunk.match(/^\s*conditional_on:\s*(\w+)/m)?.[1];
          out.push({ artifact, required: reqRaw !== "false", ...(conditional_on ? { conditional_on } : {}) });
        }
        const declared = (block.match(/-\s*artifact:/g) ?? []).length;
        if (declared > out.length) {
          recordDrop(`contribution to ${target}: parsed ${out.length} of ${declared} consumes entries (check indentation); some dropped`);
        }
        return out;
      })();

      // Drop-log any adds.* key compose does not implement — no silent no-op.
      // Implemented merge surfaces: produces / sensors / consumes / required_sections.
      // A documented-but-deferred surface (e.g. scopes) is recorded as a drop so an
      // author sees it had no effect, per the no-silent-failures contract. (When a
      // surface graduates, add it to IMPLEMENTED_ADDS + a merge call below.)
      const IMPLEMENTED_ADDS = new Set(["produces", "sensors", "consumes", "required_sections"]);
      for (const km of addsBlock.matchAll(/^ {2}([a-z_]+):/gm)) {
        if (!IMPLEMENTED_ADDS.has(km[1])) {
          recordDrop(`contribution to ${target}: adds.${km[1]} is not yet an implemented merge surface (only produces/sensors/consumes/required_sections); ignored`, "advisory");
        }
      }

      // required_sections values are quoted strings ("Branch Coverage"), unlike
      // the kebab slugs in produces/sensors. Capture the whole value then strip
      // only a MATCHED pair of outer quotes — a `[^"]` class dropped any value
      // with an interior quote (`"Say "Hi" Section"`) silently (round-5).
      const requiredSections = (() => {
        const s = addsBlock.match(/^ {2}required_sections:\n((?: {4}- .*\n?)*)/m)?.[1];
        if (!s) return [];
        const out: string[] = [];
        for (const x of s.matchAll(/^ {4}- (.+?)\s*$/gm)) {
          const v = x[1].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
          // An empty (or quote-only) value would merge a useless `- ""` into the
          // stage with no signal — drop-log it instead (round-6).
          if (v === "") { recordDrop(`contribution to ${target}: empty required_sections value; dropped`); continue; }
          out.push(v);
        }
        return out;
      })();

      // Normalize CRLF up front so a merge never inserts LF lines into a CRLF
      // stage (mixed endings). Contribution content is already normalized above.
      let stageContent = readFileSync(stageFile, "utf-8").replace(/\r\n/g, "\n");
      const before = stageContent;
      const addedProduces: string[] = [], addedSensors: string[] = [], addedConsumes: string[] = [], addedSections: string[] = [];
      const sectionsMeta: { created?: boolean } = {};
      stageContent = mergeListField(stageContent, "produces", listOf("produces"), target, addedProduces);
      stageContent = mergeListField(stageContent, "sensors", listOf("sensors"), target, addedSensors);
      stageContent = mergeConsumes(stageContent, consumes, target, addedConsumes);
      // Only merge required_sections if the installed engine accepts the key —
      // otherwise skip + drop-log rather than break the install's next compile.
      if (requiredSections.length > 0 && !requiredSectionsSafe) {
        recordDrop(`contribution to ${target}: installed engine does not accept 'required_sections' (older dist); skipped its merge — re-copy your dist/<harness> shell to enable it`, "advisory");
      } else {
        stageContent = mergeRequiredSections(stageContent, requiredSections, target, addedSections, sectionsMeta);
      }
      recordContrib(target, "produces", addedProduces);
      recordContrib(target, "sensors", addedSensors);
      recordContrib(target, "consumes", addedConsumes);
      recordContrib(target, "required_sections", addedSections);
      if (sectionsMeta.created) {
        contribManifest[target] ??= {};
        contribManifest[target].required_sections_created = true;
      }
      if (addedProduces.length || addedSensors.length || addedConsumes.length || addedSections.length) {
        contribManifestDirty = true;
      }

      // prose fragments — paired to their `## fragment: <anchor>` body block BY
      // ANCHOR LABEL, not array index. Positional pairing silently mismatched
      // prose to anchors when the body order differed from the frontmatter order
      // (round-4). Multiple fragments may target the same anchor (test-pro has 3×
      // after-step:9), so pair per-anchor FIFO: the i-th frontmatter entry for
      // anchor A takes the i-th body block labelled A. A frontmatter entry with no
      // matching body block (or vice versa) is dropped-with-log, not silently
      // cross-paired to some other anchor's prose.
      const body = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)?.[1] ?? "";
      const fragMeta = [...(fm.match(/^fragments:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1] ?? "")
        .matchAll(/-\s*anchor:\s*(\S+)\s*\n\s*order:\s*(\d+)/g)].map((m) => ({ anchor: m[1], order: Number(m[2]) }));
      // Split the body into `## fragment: <anchor>` blocks with a FENCE-AWARE line
      // scanner, not a global regex: a `## fragment:` line INSIDE a ``` code fence
      // (exactly how an author documents the fragment format) must NOT be treated
      // as a delimiter — the regex form truncated the block there and spawned
      // phantom blocks, silently dropping trailing real prose (round-5).
      const blocksByAnchor = new Map<string, string[]>();
      {
        let curAnchor: string | null = null; let curLines: string[] = [];
        let inFence = false; let fenceChar = ""; let fenceLen = 0;
        const flush = () => { if (curAnchor !== null) (blocksByAnchor.get(curAnchor) ?? blocksByAnchor.set(curAnchor, []).get(curAnchor)!).push(curLines.join("\n").trim()); };
        for (const line of body.split("\n")) {
          // CommonMark fence rules: a closing fence is the SAME char, length >=
          // the opener, and carries no info string. Tracking only the char (not
          // the length) let an inner ``` close an outer ```` — so documenting the
          // fragment format with a nested fence corrupted the block (round-6).
          const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
          if (fence) {
            const ch = fence[2][0]; const len = fence[2].length; const info = fence[3].trim();
            if (!inFence) { inFence = true; fenceChar = ch; fenceLen = len; }
            else if (ch === fenceChar && len >= fenceLen && info === "") { inFence = false; fenceChar = ""; fenceLen = 0; }
          }
          const hdr = !inFence && line.match(/^## fragment:\s*(\S+)\s*$/);
          if (hdr) { flush(); curAnchor = hdr[1]; curLines = []; continue; }
          if (curAnchor !== null) curLines.push(line);
        }
        flush();
      }
      const frags: Fragment[] = [];
      for (const meta of fragMeta) {
        const queue = blocksByAnchor.get(meta.anchor);
        const prose = (queue && queue.length > 0 ? queue.shift()! : "").replaceAll("{{HARNESS_DIR}}", HARNESS_LEAF);
        if (!prose) { recordDrop(`contribution to ${target}: fragment anchor "${meta.anchor}" order ${meta.order} has no matching "## fragment: ${meta.anchor}" prose block; dropped`); continue; }
        frags.push({ ...meta, plugin, prose });
      }
      // Leftover body blocks with no matching frontmatter entry are dropped-with-
      // log — the "or vice versa" half the prior comment promised but never did
      // (round-5). An empty leftover (blank prose) is ignored, not logged.
      for (const [anchor, remaining] of blocksByAnchor) {
        for (const leftover of remaining) {
          if (leftover) recordDrop(`contribution to ${target}: "## fragment: ${anchor}" prose block has no matching frontmatter fragments entry; dropped`);
        }
      }

      // Splice each fragment at its ordered (order, plugin) slot. A same
      // (target, plugin, anchor, order) collision — whether within this file OR
      // from an earlier contribution file this run — drops-with-log rather than
      // silently overwriting (the hash-upgrade path would otherwise let a second
      // file replace the first, winner decided by readdir order). Aligned with
      // the "collision is an error" doc claim.
      const ordered = [...frags].sort((a, b) => a.order - b.order || a.plugin.localeCompare(b.plugin));
      for (const f of ordered) {
        const key = `${target}:${f.plugin}:${f.anchor}:${f.order}`;
        if (seenFragKeys.has(key)) { recordDrop(`contribution to ${target}: duplicate fragment ${f.plugin}:${f.anchor}:${f.order} (same plugin/anchor/order, possibly across files); dropped`); continue; }
        seenFragKeys.add(key);
        stageContent = spliceFragment(stageContent, f, target);
      }

      if (stageContent !== before) { // compare-before-write (review #11)
        writeFileSync(stageFile, stageContent);
        changed = true;
      }
    }
  }

  // Persist the contribution sidecar so select-plugins can strip this
  // plugin's merged structural adds on disable. Written only when this run
  // added something (idempotent re-runs leave the prior record untouched).
  if (contribManifestDirty) {
    try {
      mkdirSync(join(HARNESS_DIR, "tools", "data"), { recursive: true });
      writeFileSync(contribManifestPath, `${JSON.stringify(contribManifest, null, 2)}\n`);
    } catch (e) {
      recordDrop(`could not write the contribution sidecar ${relative(PROJECT_DIR, contribManifestPath)}: ${e instanceof Error ? e.message : String(e)} - disabling this plugin will not strip its merged contributions`, "advisory");
    }
  }

  // 3. Recompile when something changed OR when a prior compile did not land —
  //    a transient failure (disk full, killed mid-session-start) must self-heal
  //    next session. Under the no-clobber + sentinel + compare-before-write gates
  //    `changed` stays false on reruns, so gating on `changed` alone would make a
  //    failed compile permanent (round-2 major). Detect it by checking the
  //    compiled graph actually contains this plugin's stage slugs.
  const pluginStages: Array<{ slug: string; phase: string }> = [];
  for (const phase of PHASES) {
    const dir = join(PLUGIN_ROOT, "stages", phase);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".md")) pluginStages.push({ slug: f.slice(0, -3), phase });
  }
  // A compose-dropped stage never landed on disk, so it can never reach the
  // graph - expecting it there would force a futile recompile every session.
  const pluginSlugs = pluginStages.map((s) => s.slug).filter((s) => !composeDroppedStageSlugs.has(s));
  const graphPath = join(HARNESS_DIR, "tools", "data", "stage-graph.json");
  const readGraph = (): Array<{ slug?: string; plugin?: string; phase?: string; enabled?: boolean }> | null => {
    try {
      return JSON.parse(readFileSync(graphPath, "utf-8")) as Array<{ slug?: string; plugin?: string; phase?: string; enabled?: boolean }>;
    } catch { return null; }
  };
  const graphMissingPluginStage = (() => {
    if (!pluginEnabledBySelection()) return false;
    if (pluginSlugs.length === 0) return false;
    const graph = readGraph();
    if (graph === null) return true; // unreadable/absent graph — compile
    const present = new Set(
      graph
        .filter((s) => s.enabled !== false)
        .map((s) => s.slug),
    );
    return pluginSlugs.some((s) => !present.has(s));
  })();
  const skillsDirExists = existsSync(SKILLS_DIR);
  const missingPluginStageRunner = (() => {
    if (!skillsDirExists || pluginSlugs.length === 0 || graphMissingPluginStage) return false;
    const graph = readGraph();
    if (graph === null) return false;
    const pluginSlugSet = new Set(pluginSlugs);
    return graph.some((s) =>
      typeof s.slug === "string" &&
      pluginSlugSet.has(s.slug) &&
      typeof s.plugin === "string" &&
      s.plugin.length > 0 &&
      s.enabled !== false &&
      s.phase !== "initialization" &&
      !existsSync(join(SKILLS_DIR, s.slug, "SKILL.md"))
    );
  })();
  // A contributions-only plugin has no stage slug to detect a missing compile, so
  // the graph-slug check can't see its failed recompile. A persisted retry marker
  // covers that case: written on compile failure, deleted on success, and any
  // presence forces a retry next run — so a transient failure self-heals for
  // stage-carrying AND contributions-only plugins alike (round-3). The marker is
  // PROJECT-side (never in PLUGIN_ROOT, which may be read-only / under dist/), and
  // keyed by the plugin's identity (PLUGIN_KEY, computed up front) so two plugins
  // on one harness never share a marker.
  const retryMarker = join(PROJECT_DIR, "aidlc", `.plugin-compose-retry-${PLUGIN_KEY}`);
  const retryPending = existsSync(retryMarker);
  let recompiled = false;
  if (changed || graphMissingPluginStage || retryPending) {
    const [command, ...args] = installedToolCommand("graph", ["compile"]);
    const r = spawnSync(command, args, {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      env: installedToolEnv(),
    });
    if (r.status !== 0) {
      recordDrop(`aidlc-graph compile failed: ${(r.stderr || "").slice(0, 400)}`);
      if (pluginKeySafe) {
        try { mkdirSync(join(PROJECT_DIR, "aidlc"), { recursive: true }); writeFileSync(retryMarker, new Date().toISOString() + "\n"); } catch { /* best-effort */ }
      }
    } else {
      recompiled = true;
      if (retryPending) {
        try { rmSync(retryMarker, { force: true }); } catch { /* best-effort */ }
      }
      refreshSkillGeneratedRegion("stage-table", STAGE_TABLE_BEGIN, STAGE_TABLE_END);
      refreshSkillGeneratedRegion("scope-table", SCOPE_TABLE_BEGIN, SCOPE_TABLE_END);
    }
  }

  const pluginShipsScopes = existsSync(join(PLUGIN_ROOT, "scopes"));
  if (recompiled || missingPluginStageRunner) {
    if (!skillsDirExists) {
      recordDrop(`runner regeneration skipped: ${HARNESS_LEAF}/skills not present in this install`, "advisory");
    } else {
      const runnerEnv = installedToolEnv();
      const runRunnerGen = (args: string[], label: string): boolean => {
        const [command, ...commandArgs] = installedToolCommand("runner", args);
        const r = spawnSync(command, commandArgs, {
          cwd: PROJECT_DIR,
          encoding: "utf-8",
          env: runnerEnv,
        });
        if (r.status !== 0) {
          recordDrop(`aidlc-runner-gen ${label} failed: ${(r.stderr || r.stdout || "").slice(0, 400)}`);
          return false;
        }
        return true;
      };
      runRunnerGen(["write"], "write");
      if (pluginShipsScopes) runRunnerGen(["scopes"], "scopes");
    }
  }
} catch (e) {
  recordDrop(`compose threw: ${e instanceof Error ? e.message : String(e)}`);
  // Non-fatal: never break the user's session over a compose failure.
}

// Flush any recorded drops to the installed hooks-health dir (--doctor surfaces
// them). Best-effort — flushDrops swallows its own errors.
await flushDrops();
}

if (import.meta.main) await compose();
