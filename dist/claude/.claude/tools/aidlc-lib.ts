import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, appendFileSync, chmodSync, closeSync, constants as fsConstants, cpSync, type Dirent, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, opendirSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { inflateSync } from "node:zlib";
import { dlopen, FFIType, type Pointer } from "bun:ffi";
import {
  resolveHarnessPath,
} from "./aidlc-runtime-paths.ts";
import {
  artifactFilename,
  KNOWN_CODEKB_STAGES,
} from "./aidlc-artifact-vocabulary.ts";
export {
  artifactFilename,
  KNOWN_CODEKB_STAGES,
} from "./aidlc-artifact-vocabulary.ts";
// Type-only import for the lazy-loaded aidlc-graph.ts dependency. The
// runtime require() below avoids the circular import (aidlc-graph.ts
// imports loadScopeMapping/loadStageGraph from this file). Type-only
// imports are erased at runtime so they don't create the cycle.
import type { subgraphForScope as SubgraphForScope } from "./aidlc-graph.ts";

// --- Types ---

export interface StageEntry {
  slug: string;
  number: string;
  name: string;
  phase: string;
  // Present only when a plugin selection has disabled this node. Enabled nodes
  // omit the key so an install with no selection keeps byte-identical compiled
  // data.
  enabled?: false;
  execution: "ALWAYS" | "CONDITIONAL";
  lead_agent: string;
  support_agents: string[];
  mode: string;
  // Optional fields populated by aidlc-graph compile from YAML sources.
  // Existing callers read only the 8 required fields above; optional
  // additions are source-compatible. Library code that needs these
  // fields uses the GraphStage type in aidlc-graph.ts (required there).
  plugin?: string;
  condition?: string;
  reviewer?: string;
  review_artifact?: string;
  reviewer_max_iterations?: number;
  review_class?: "adversarial" | "advisory";
  // Summary-confirmation policy for stages using the unified question flow.
  // `required` means every execution owes a questions file and receipt;
  // `if-present` enforces a receipt only when the conditional flow created one.
  summary_confirmation?: "required" | "if-present";
  produces?: string[];
  // Artifacts the stage MAY write per unit; exempt from the per-unit
  // coverage check in aidlc-orchestrate.ts unitCovered. See GraphStage in
  // aidlc-graph.ts.
  optional_produces?: string[];
  // Per-kind applicability map: artifact name to the unit kinds it applies to.
  // An unlisted artifact applies to all kinds; a listed one is pruned out of a
  // unit whose kind is not in its list (both directive paths and coverage).
  // Absent map = full matrix (every produces entry applies to every unit).
  produces_kinds?: Record<string, string[]>;
  consumes?: Array<{ artifact: string; required: boolean; conditional_on?: string }>;
  requires_stage?: string[];
  scopes?: string[];
  inputs?: string;
  outputs?: string;
  for_each?: string;
  // True for stages that must write source code to the workspace root (not just
  // planning docs under the per-intent record dir). The stage-completion artifact
  // guard (aidlc-state.ts) uses this to require a non-doc workspace file before
  // approve/advance: a code-generation stage that wrote only its markdown
  // produces[] docs but no actual code must not pass (issue #366).
  workspace_requires?: boolean;
  // Compile-resolved sensor bindings. Runtime dispatchers consume the detailed
  // graph shape; user-facing directives intentionally project only sensor ids.
  sensors_applicable?: Array<{
    id: string;
    path: string;
    fire_on: "write" | "gate";
    default_severity: "advisory" | "blocking";
    category?: string;
    matches?: string;
  }>;
}

// The per-unit marker carried by the Construction stages that run once per
// Unit of Work. It lives on the stage's `for_each` field (stage frontmatter,
// compiled onto the GraphStage and into stage-graph.json). The canonical
// 5-stage set (nfr-requirements, nfr-design, functional-design,
// infrastructure-design, code-generation) is the defensive cross-check; the
// node's own `for_each` is the source of truth so a future per-unit stage is
// picked up without editing this file. Exported so both the runtime resolver
// (isPerUnit in aidlc-orchestrate.ts) and the cost summary (gridCostSummary
// below) resolve per-unit identically.
export const PER_UNIT_FOR_EACH = "unit-of-work";
export const KNOWN_PER_UNIT_STAGES: ReadonlySet<string> = new Set([
  "nfr-requirements",
  "nfr-design",
  "functional-design",
  "infrastructure-design",
  "code-generation",
]);

// True when a stage runs once per Unit of Work. Reads the node's own
// `for_each` marker (source of truth); the known-set membership is a defensive
// cross-check so a typo'd marker on one of the five canonical stages still
// resolves per-unit. Structural param so both a GraphStage and a bare
// {slug, for_each} record satisfy it.
export function isPerUnitStage(e: { slug: string; for_each?: string }): boolean {
  return e.for_each === PER_UNIT_FOR_EACH || KNOWN_PER_UNIT_STAGES.has(e.slug);
}

export interface ScopeDefinition {
  depth: string;
  stages: Record<string, "EXECUTE" | "SKIP">;
  // Optional fields from scope-mapping.json. `testStrategy` can override
  // the depth-derived default; `keywords` drives NL scope inference (see
  // aidlc-utility.ts inferScopeFromText); `description` is a one-line
  // scope summary rendered into HELP_TEXT.
  testStrategy?: string;
  keywords?: string[];
  description?: string;
  plugin?: string;
  runner?: boolean;
  skeleton?: boolean;
}

export type CheckboxState = "pending" | "in-progress" | "awaiting-approval" | "revising" | "completed" | "skipped";

export const CHECKBOX_MAP: Record<CheckboxState, string> = {
  pending: "[ ]",
  "in-progress": "[-]",
  "awaiting-approval": "[?]",
  revising: "[R]",
  completed: "[x]",
  skipped: "[S]",
};

export const CHECKBOX_REVERSE: Record<string, CheckboxState> = {
  "[ ]": "pending",
  "[-]": "in-progress",
  "[?]": "awaiting-approval",
  "[R]": "revising",
  "[x]": "completed",
  "[S]": "skipped",
};

export const PHASES = [
  "initialization",
  "ideation",
  "inception",
  "construction",
  "operation",
] as const;

export type Phase = (typeof PHASES)[number];

export const PHASE_NUMBERS: Record<string, Phase> = {
  "0": "initialization",
  "1": "ideation",
  "2": "inception",
  "3": "construction",
  "4": "operation",
};

// --- Harness dir resolution (.claude vs .kiro vs .codex) ---

// The deterministic core ships in multiple harness trees: Claude Code reads
// it from <project>/.claude/, Kiro CLI from <project>/.kiro/, Codex CLI from
// <project>/.codex/, and ANY future harness from <project>/<its-dir>/. Every
// runtime path that names the harness directory flows through harnessDir() so
// the SAME tool sources work in every tree. Resolution order mirrors
// resolveProjectDir: env seam (tests/fixtures) → script-path derivation (this
// module ships at <project>/<harness>/tools/aidlc-lib.ts, so the harness dir is
// simply the directory two levels up — derived OPEN-SET, not matched against a
// fixed list, so harness #N needs no edit here) → CWD probe → ".claude"
// fallback.
//
// KNOWN_HARNESS_DIRS is NOT the source of truth for which harnesses exist — the
// script-path derivation handles any dir. It is only a probe-ORDER hint for the
// dev-repo CWD rung, where more than one harness dir can coexist and the Claude
// tree is canonical (".claude" must win). A real single-harness install never
// reaches the probe; it resolves by script path.
export const KNOWN_HARNESS_DIRS = [".claude", ".kiro", ".codex", ".aidlc", ".cursor"] as const;

// True for a plausible harness dir name: a dot-prefixed segment, e.g. ".claude"
// / ".kiro" / ".gemini". Guards the script-path derivation so an unexpected
// layout (lib copied loose in a test, a non-dotted parent) falls through to the
// CWD probe instead of returning a bogus harness dir.
function isHarnessDirName(name: string): boolean {
  return /^\.[a-z0-9][a-z0-9._-]*$/i.test(name);
}

function deriveHarnessDir(): string {
  // Script-path derivation (open-set): the module ships at
  // <project>/<harness>/tools/aidlc-lib.ts, so the harness dir is the basename
  // of the grandparent of this file — whatever it is named.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  if (basename(scriptDir) === "tools") {
    const candidate = basename(dirname(scriptDir));
    if (isHarnessDirName(candidate)) return candidate;
  }
  // CWD probe (dev repo, multiple trees coexist): known dirs in canonical order.
  const cwd = process.cwd();
  for (const h of KNOWN_HARNESS_DIRS) {
    if (existsSync(join(cwd, h))) return h;
  }
  return ".claude";
}

let _harnessDir: string | null = null;

export function harnessDir(): string {
  // Env read at call time (not cached) so tests can flip it between bun
  // invocations — same pattern as stageGraphPath() below.
  if (process.env.AIDLC_HARNESS_DIR) return process.env.AIDLC_HARNESS_DIR;
  if (_harnessDir === null) _harnessDir = deriveHarnessDir();
  return _harnessDir;
}

// The AIDLC markdown rule layers (aidlc-org/team/project/phase .md) live under
// a per-harness subdirectory of the harness dir: `.claude/rules/`,
// `.kiro/steering/` (Kiro reads steering files as its native rule surface),
// `.codex/aidlc-rules/` (Codex's native `.codex/rules/` is Starlark permission
// rules — D-10). The packager renames the SHIPPED directory and the prose/JSON
// that names it (transform()/applyRulesRename + renameRulesInCompiledData), but
// the .ts tools are byte-copied across all trees, so any runtime path a tool
// builds to a rule file MUST go through rulesSubdir() — a hardcoded "rules"
// segment targets a directory that does not exist on a rename-rules harness.
//
// The rename is a fact only the harness MANIFEST knows, so the packager emits
// it per-tree into tools/data/harness.json (alongside the manifest name used
// by runtime path resolution) — the open-set source of truth: a new harness
// ships its own harness.json and needs no edit here. Resolution:
// AIDLC_RULES_SUBDIR env seam (fixtures) →
// AIDLC_HARNESS_DIR test-seam map (so "pretend to be .kiro" yields "steering"
// without a .kiro tree on disk) → the shipped harness.json (the real-install
// rung) → KNOWN_RULES_SUBDIR dev-fallback map → "rules". Returns the LAST path
// segment only (e.g. "steering"); callers join it under harnessDir().
const KNOWN_RULES_SUBDIR: Record<string, string> = {
  ".claude": "rules",
  ".kiro": "steering",
  ".codex": "aidlc-rules",
  // opencode: the ENGINE dir is .aidlc (opencode auto-imports .opencode/tools/
  // *.ts as custom tools, so the engine cannot live there); no rename needed.
  ".aidlc": "rules",
  ".cursor": "rules",
};

/** One MIME type's text extractor, as configured in harness.json. */
export interface DocumentExtractorSpec {
  argv: readonly string[];
  timeoutMs?: number;
}

interface ShippedHarnessData {
  rulesSubdir: string | null;
  plugins: ReadonlySet<string> | null;
  documentExtractors: ReadonlyMap<string, DocumentExtractorSpec> | null;
  runnerFrontmatterAdditions: readonly string[];
}

let _shippedHarnessData: ShippedHarnessData | null = null;

export function harnessDataPath(): string {
  return join(resolveDataDir(), "harness.json");
}

function readShippedHarnessData(): ShippedHarnessData {
  if (_shippedHarnessData !== null) return _shippedHarnessData;
  // tools/data/harness.json sits beside the compiled stage-graph.json in the
  // shipped tree (DATA_DIR). Absent in a dev checkout's core/ (authored source
  // carries no compiled data) → defaults, and the caller falls through.
  const p = harnessDataPath();
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as {
      rulesSubdir?: unknown;
      plugins?: unknown;
      runnerFrontmatterAdditions?: unknown;
    };
    let plugins: ReadonlySet<string> | null = null;
    if (Object.hasOwn(parsed, "plugins")) {
      if (!Array.isArray(parsed.plugins)) {
        throw new Error(`${p}: harness.json field "plugins" must be an array of non-empty strings.`);
      }
      const names: string[] = [];
      for (const [idx, value] of parsed.plugins.entries()) {
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new Error(`${p}: harness.json field "plugins" entry ${idx} must be a non-empty string.`);
        }
        names.push(value.trim());
      }
      plugins = new Set(names);
    }
    // documentExtractors: strict, and fail-closed. The value becomes a PROCESS
    // INVOCATION, so a half-understood block must never reach spawn: `argv` is an
    // array of non-empty strings, never a shell string that gets helpfully split.
    let documentExtractors: ReadonlyMap<string, DocumentExtractorSpec> | null = null;
    if (Object.hasOwn(parsed, "documentExtractors")) {
      const raw = (parsed as { documentExtractors?: unknown }).documentExtractors;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error(
          `${p}: harness.json field "documentExtractors" must be an object keyed by MIME type.`,
        );
      }
      const map = new Map<string, DocumentExtractorSpec>();
      for (const [mime, spec] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
          throw new Error(
            `${p}: harness.json field "documentExtractors" entry "${mime}" must be an object.`,
          );
        }
        const argv = (spec as { argv?: unknown }).argv;
        if (typeof argv === "string") {
          throw new Error(
            `${p}: harness.json field "documentExtractors" entry "${mime}" argv must be an ARRAY ` +
              `of strings, not a shell string — it is spawned without a shell, so a string ` +
              `cannot be split safely.`,
          );
        }
        if (!Array.isArray(argv) || argv.length === 0) {
          throw new Error(
            `${p}: harness.json field "documentExtractors" entry "${mime}" argv must be a ` +
              `non-empty array of strings.`,
          );
        }
        for (const [idx, part] of argv.entries()) {
          if (typeof part !== "string" || part.length === 0) {
            throw new Error(
              `${p}: harness.json field "documentExtractors" entry "${mime}" argv[${idx}] must ` +
                `be a non-empty string.`,
            );
          }
        }
        // argv[0] is the EXECUTABLE, never substituted: `extractDocument`'s
        // spawn is `spawnSync(argv[0], argv.slice(1).map(sub))` -- index 0
        // names the program, so a "$IN" placeholder there is NEVER replaced
        // and the tool literally tries to spawn a program called `$IN`.
        // Measured against the shipped tool: `argv: ["$IN"]` passed the OLD
        // validator (it counted `$IN` across the WHOLE array and accepted
        // exactly one, wherever it fell) and every document routed to it
        // reported `extractor_unavailable` with `extractor.name === "$IN"` --
        // no extraction ever ran, silently, for a config an author might
        // reasonably believe was valid ("one $IN, as required").
        if (argv[0] === "$IN") {
          throw new Error(
            `${p}: harness.json field "documentExtractors" entry "${mime}" argv[0] must be a ` +
              `real executable name, not the "$IN" placeholder -- argv[0] is never substituted ` +
              `(only argv[1..] receives the document's path), so "$IN" there spawns a program ` +
              `literally named "$IN".`,
          );
        }
        // Exactly one `$IN`, and only among the ARGUMENTS (argv[1..], the
        // slice that is actually substituted). Zero means the spawned process
        // never receives the document path at all -- whatever it prints on
        // stdout would be recorded as the extraction of EVERY document routed
        // to this entry, silently. More than one is equally a config error the
        // author almost certainly did not intend (e.g. a copy-paste), and
        // there is no stdin-input mode today for a config that wants zero --
        // so both directions fail closed rather than one being treated as
        // advisory.
        const inCount = argv.slice(1).filter((a) => a === "$IN").length;
        if (inCount !== 1) {
          throw new Error(
            `${p}: harness.json field "documentExtractors" entry "${mime}" argv must contain ` +
              `exactly one "$IN" placeholder among its arguments, argv[1..] (found ${inCount}) ` +
              `-- that is how the document's path reaches the spawned process; without it the ` +
              `process never receives the file.`,
          );
        }
        const timeoutMs = (spec as { timeoutMs?: unknown }).timeoutMs;
        if (timeoutMs !== undefined &&
            (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
          throw new Error(
            `${p}: harness.json field "documentExtractors" entry "${mime}" timeoutMs must be a ` +
              `positive number of milliseconds.`,
          );
        }
        map.set(mime, {
          argv: argv as string[],
          ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
        });
      }
      documentExtractors = map;
    }
    const rulesSubdir =
      typeof parsed.rulesSubdir === "string" && parsed.rulesSubdir.length > 0
        ? parsed.rulesSubdir
        : null;
    let runnerFrontmatterAdditions: string[] = [];
    if (Object.hasOwn(parsed, "runnerFrontmatterAdditions")) {
      if (
        !Array.isArray(parsed.runnerFrontmatterAdditions) ||
        parsed.runnerFrontmatterAdditions.some(
          (line) => typeof line !== "string" || !/^[A-Za-z_][\w-]*\s*:/.test(line),
        )
      ) {
        throw new Error(
          `${p}: harness.json field "runnerFrontmatterAdditions" must be an array of YAML key lines.`,
        );
      }
      runnerFrontmatterAdditions = [...parsed.runnerFrontmatterAdditions];
    }
    _shippedHarnessData = {
      rulesSubdir,
      plugins,
      documentExtractors,
      runnerFrontmatterAdditions,
    };
    return _shippedHarnessData;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${p}:`)) throw err;
    // no harness.json (dev core/, or a tree built before this landed) → fall through
  }
  _shippedHarnessData = {
    rulesSubdir: null,
    plugins: null,
    documentExtractors: null,
    runnerFrontmatterAdditions: [],
  };
  return _shippedHarnessData;
}

function shippedRulesSubdir(): string | null {
  try {
    return readShippedHarnessData().rulesSubdir;
  } catch (err) {
    // rulesSubdir() has historically tolerated malformed/missing harness data.
    // pluginsEnabled() and documentExtractors() are the strict readers for their
    // own fields.
    //
    // The blast radius matters here: this catch STRING-MATCHES, so any validation
    // error it does not recognise rethrows OUT of a function whose only job is to
    // name the rules dir. A malformed documentExtractors block would otherwise
    // break rules resolution -- an unrelated caller crashing on a field it never
    // reads. Extraction itself still fails closed; the strict accessor below is
    // where that throw belongs.
    if (err instanceof Error &&
        (err.message.includes('field "plugins"') ||
         err.message.includes('field "documentExtractors"'))) {
      return null;
    }
    throw err;
  }
}

/**
 * The configured DocumentKB extractors, or null when none are configured.
 *
 * STRICT: a malformed block throws here rather than being silently ignored,
 * because the value becomes a process invocation and a half-parsed extractor is
 * worse than none. Absent is the normal case — the tool then probes `pdftotext`
 * on PATH and degrades to `extractor_unavailable`.
 */
export function documentExtractors(): ReadonlyMap<string, DocumentExtractorSpec> | null {
  return readShippedHarnessData().documentExtractors;
}

export function pluginsEnabled(): ReadonlySet<string> | null {
  return readShippedHarnessData().plugins;
}

export function runnerFrontmatterAdditions(): readonly string[] {
  return readShippedHarnessData().runnerFrontmatterAdditions;
}

export function isPluginEnabled(plugin: string): boolean {
  const selected = pluginsEnabled();
  return selected === null || selected.has(plugin);
}

export function stageEnabledBySelection(stage: { plugin?: string; phase?: string }): boolean {
  if (stage.phase === "initialization") return true;
  return isPluginEnabled(stage.plugin ?? "aidlc");
}

export function _resetHarnessDataForTests(): void {
  _shippedHarnessData = null;
}

export function rulesSubdir(): string {
  if (process.env.AIDLC_RULES_SUBDIR) return process.env.AIDLC_RULES_SUBDIR;
  // Test seam: AIDLC_HARNESS_DIR pins the harness without a tree on disk, so it
  // must out-rank the physically-shipped harness.json (which reflects THIS lib
  // copy's tree). Real installs don't set it and fall to the shipped value.
  if (process.env.AIDLC_HARNESS_DIR) {
    return KNOWN_RULES_SUBDIR[process.env.AIDLC_HARNESS_DIR] ?? "rules";
  }
  return shippedRulesSubdir() ?? KNOWN_RULES_SUBDIR[harnessDir()] ?? "rules";
}

// --- Project dir resolution ---

export function resolveProjectDir(explicitDir?: string): string {
  // 1. Explicit --project-dir argument
  if (explicitDir) {
    return isAbsolute(explicitDir) ? explicitDir : resolvePath(process.cwd(), explicitDir);
  }

  // 2. Dispatcher/plugin explicit project environment
  if (process.env.AIDLC_PROJECT_DIR) {
    return isAbsolute(process.env.AIDLC_PROJECT_DIR)
      ? process.env.AIDLC_PROJECT_DIR
      : resolvePath(process.cwd(), process.env.AIDLC_PROJECT_DIR);
  }

  // 3. CLAUDE_PROJECT_DIR env var
  if (process.env.CLAUDE_PROJECT_DIR) {
    return isAbsolute(process.env.CLAUDE_PROJECT_DIR)
      ? process.env.CLAUDE_PROJECT_DIR
      : resolvePath(process.cwd(), process.env.CLAUDE_PROJECT_DIR);
  }

  // 4. Script path derivation (open-set): this module ships at
  //    <project>/<harness>/tools/, so strip "<harness>/tools" for ANY harness
  //    dir name — the project root is the dir two levels up.
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fromScript = stripHarnessLeaf(scriptDir, "tools");
  if (fromScript) return fromScript;

  // 5. CWD has a known harness directory (dev repo).
  const cwd = process.cwd();
  for (const h of KNOWN_HARNESS_DIRS) {
    if (existsSync(join(cwd, h))) {
      return cwd;
    }
  }

  // Fallback to CWD
  return cwd;
}

// If `dir` is "<root>/<harness>/<leaf>" with <harness> a harness-dir name and
// <leaf> the given segment (tools | hooks), return <root>; else null. Open-set:
// the harness segment is validated by SHAPE (isHarnessDirName), not membership
// in a fixed list, so a new harness needs no edit here.
function stripHarnessLeaf(dir: string, leaf: string): string | null {
  if (basename(dir) !== leaf) return null;
  const harnessDirPath = dirname(dir);
  if (!isHarnessDirName(basename(harnessDirPath))) return null;
  return dirname(harnessDirPath);
}

// --- Hook project dir resolution ---

export function resolveProjectDirFromHook(importMetaUrl: string): string {
  // 1. Dispatcher/plugin explicit project environment
  if (process.env.AIDLC_PROJECT_DIR) {
    return isAbsolute(process.env.AIDLC_PROJECT_DIR)
      ? process.env.AIDLC_PROJECT_DIR
      : resolvePath(process.cwd(), process.env.AIDLC_PROJECT_DIR);
  }

  // 2. CLAUDE_PROJECT_DIR env var
  if (process.env.CLAUDE_PROJECT_DIR) {
    return isAbsolute(process.env.CLAUDE_PROJECT_DIR)
      ? process.env.CLAUDE_PROJECT_DIR
      : resolvePath(process.cwd(), process.env.CLAUDE_PROJECT_DIR);
  }

  // 3. Script path derivation (open-set): hooks ship at
  //    <project>/<harness>/hooks/, so strip "<harness>/hooks" for ANY harness.
  const scriptDir = dirname(fileURLToPath(importMetaUrl));
  const fromScript = stripHarnessLeaf(scriptDir, "hooks");
  if (fromScript) return fromScript;

  // 4. CWD has a known harness directory (dev repo).
  const cwd = process.cwd();
  for (const h of KNOWN_HARNESS_DIRS) {
    if (existsSync(join(cwd, h))) {
      return cwd;
    }
  }

  return cwd;
}

// --- File paths ---

export function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

// --- Workspace selectors: space + intent ---------------------------------------
//
// The record (state · audit · artifacts · diary) re-roots per INTENT under a
// per-team SPACE: `aidlc/spaces/<space>/intents/<slug>-<id8>/…`. Two cursors
// pick the active space/intent, both GITIGNORED (per-user, not shared truth):
//   - `aidlc/active-space`                            → the active space
//   - `aidlc/spaces/<space>/intents/active-intent`    → that space's active intent
//
// Resolution precedence (vision §5):
//   space:  explicit arg > active-space pointer > "default" (NEVER errors).
//   intent: explicit arg > active-intent pointer > lone-intent > null.
//
// NULL RESOLUTION (P9 end state — no flat root). When NO intent record resolves
// (activeIntent() → null: a fresh SEED shell before auto-create, or a flat project
// still awaiting migration), the absolute path helpers resolve to the bare SPACE
// record root (aidlc/spaces/<space>/intents/ — see spaceRecordRoot). No
// aidlc-state.md ever lives directly there, so existence-gated consumers
// (loadStateFileIfPresent) read "no workflow yet" and the orchestrator either
// creates an intent or reports an error. The ONLY surviving flat `aidlc-docs`
// read is the one-time
// migration's SOURCE (flatStateSource/flatMigrationSource below).
// activeIntent() returning null IS that "no record yet" signal.

export const ACTIVE_SPACE_POINTER = "active-space";
export const ACTIVE_INTENT_POINTER = "active-intent";
export const DEFAULT_SPACE = "default";

// --- Terminal-command classification (the deterministic-dispatch seam) ---
//
// A small set of `/aidlc` commands are TERMINAL: they map 1:1 to an
// `aidlc-utility.ts` subcommand that runs a tool, prints its output, and stops —
// they carry NO workflow work and never advance an intent. The orchestration
// engine's `next` already routes these to a terminal `print` directive
// (handleNext Branch 1 + 1b). They are exported HERE so a pre-LLM harness seam
// (e.g. the Kiro userPromptSubmit hook) can dispatch them deterministically off
// the SAME classification the engine uses — never a divergent hardcoded list.
//
//   - read-only utility flags: matched ANYWHERE in the args (mirrors the engine's
//     parseNextFlags, which sets `readOnly` on any matching token). Each maps to
//     its subcommand by stripping the leading `--` (--status→status, …).
//   - workspace commands: parsed ONLY when the LEADING token is a workspace
//     noun/legacy verb, so freeform prose merely containing "space"/"intent"
//     stays intent text. A leading workspace noun wins over later read-only
//     flags because those tokens belong to that command's argv.
export const READ_ONLY_FLAGS: ReadonlySet<string> = new Set([
  "--status",
  "--help",
  "--doctor",
  "--version",
]);
export const WORKSPACE_VERBS: ReadonlySet<string> = new Set([
  "space",
  "space-create",
  "intent",
]);

export type WorkspaceNoun = "intent" | "space";

export const INTENT_VERBS: ReadonlySet<string> = new Set([
  "list",
  "switch",
  "create",
]);

export const SPACE_VERBS: ReadonlySet<string> = new Set([
  "list",
  "switch",
  "create",
]);

export const RESERVED_FUTURE: ReadonlySet<string> = new Set([
  "archive",
  "rename",
  "show",
  // Retired verb, still reserved: `intent birth` was the create verb before it
  // was renamed, so a record named "birth" could not exist in an install made
  // while it was grammar. Keeping it reserved means such a record stays
  // switch-reachable and doctor keeps flagging it, instead of the name silently
  // becoming creatable and colliding.
  "birth",
]);

export type WorkspaceCommand =
  | { kind: "list"; noun: WorkspaceNoun; json: boolean }
  | { kind: "switch"; noun: WorkspaceNoun; name: string; explicit: boolean }
  | { kind: "create"; noun: "space"; name: string }
  | { kind: "create-intent"; noun: "intent"; rest: string[] }
  | { kind: "help"; noun: WorkspaceNoun }
  | {
      kind: "error";
      noun: WorkspaceNoun;
      code: "missing-name";
      verb: "switch" | "create" | "space-create";
      message: string;
    }
  | {
      kind: "error";
      noun: WorkspaceNoun;
      code: "reserved-future-verb";
      verb: string;
      message: string;
    }
  | { kind: "not-workspace" };

function missingWorkspaceName(
  noun: WorkspaceNoun,
  verb: "switch" | "create" | "space-create",
): WorkspaceCommand {
  const usage =
    verb === "space-create"
      ? "space-create <name>"
      : `${noun} ${verb} <name>`;
  return {
    kind: "error",
    noun,
    code: "missing-name",
    verb,
    message: `Usage: aidlc ${usage}`,
  };
}

function reservedFutureWorkspaceVerb(noun: WorkspaceNoun, verb: string): WorkspaceCommand {
  return {
    kind: "error",
    noun,
    code: "reserved-future-verb",
    verb,
    message: `${noun} ${verb} is reserved for a future workspace verb and is not implemented yet. Use ${noun} switch ${verb} to select an existing record with that name.`,
  };
}

function isWorkspaceNoun(token: string | undefined): token is WorkspaceNoun {
  return token === "intent" || token === "space";
}

function isReservedFutureWorkspaceVerb(token: string | undefined): token is string {
  return token !== undefined && RESERVED_FUTURE.has(token);
}

function explicitWorkspaceList(noun: WorkspaceNoun, tokens: string[]): WorkspaceCommand {
  return { kind: "list", noun, json: tokens[2] === "--json" };
}

export function parseWorkspaceCommand(tokens: string[]): WorkspaceCommand {
  const head = tokens[0];

  if (head === "space-create") {
    const name = tokens[1];
    if (name === undefined) return missingWorkspaceName("space", "space-create");
    return { kind: "create", noun: "space", name };
  }

  if (!isWorkspaceNoun(head)) return { kind: "not-workspace" };

  const noun = head;
  const verbOrName = tokens[1];

  if (verbOrName === undefined) {
    return { kind: "list", noun, json: false };
  }

  if (verbOrName === "--json") {
    return { kind: "list", noun, json: true };
  }

  if (verbOrName === "help" || verbOrName === "-h") {
    return { kind: "help", noun };
  }

  if (isReservedFutureWorkspaceVerb(verbOrName)) {
    return reservedFutureWorkspaceVerb(noun, verbOrName);
  }

  if (noun === "intent") {
    if (verbOrName === "list") return explicitWorkspaceList(noun, tokens);
    if (verbOrName === "switch") {
      const name = tokens[2];
      if (name === undefined) return missingWorkspaceName(noun, "switch");
      return { kind: "switch", noun, name, explicit: true };
    }
    if (verbOrName === "create") {
      return { kind: "create-intent", noun, rest: tokens.slice(2) };
    }
  }

  if (noun === "space") {
    if (verbOrName === "list") return explicitWorkspaceList(noun, tokens);
    if (verbOrName === "switch") {
      const name = tokens[2];
      if (name === undefined) return missingWorkspaceName(noun, "switch");
      return { kind: "switch", noun, name, explicit: true };
    }
    if (verbOrName === "create") {
      const name = tokens[2];
      if (name === undefined) return missingWorkspaceName(noun, "create");
      return { kind: "create", noun, name };
    }
  }

  return { kind: "switch", noun, name: verbOrName, explicit: false };
}

export function workspaceCommandUtilityArgv(command: WorkspaceCommand): string[] | null {
  switch (command.kind) {
    case "list":
      return command.json ? [command.noun, "--json"] : [command.noun];
    case "switch":
      // Explicit `switch <name>` must forward the literal "switch" token so
      // the utility reads <name> as the switch target even when it shadows a
      // verb (e.g. `intent switch create` reaching a pre-existing intent named
      // "create" instead of re-reading "create" as the create verb). Bare-name
      // sugar (`space teamB`, explicit: false) is unaffected by that bug and
      // must keep the original 2-token shape: the utility's bare
      // `[noun, name]` form IS the switch (see handleIntent/handleSpace's
      // "verbOrTarget = name when not a recognized verb" branch), and every
      // downstream consumer (the classifier's terminal print, the Kiro
      // adapter, t114/t178/t198) pins that shape as still-desired behavior.
      return command.explicit
        ? [command.noun, "switch", command.name]
        : [command.noun, command.name];
    case "create":
      return ["space-create", command.name];
    case "create-intent":
      return ["intent-create", ...command.rest];
    case "help":
      return ["help"];
    case "error":
    case "not-workspace":
      return null;
  }
}

export function splitDoubleQuotedArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && raw[i + 1] === "\"") {
      current += "\"";
      i++;
      continue;
    }
    if (ch === "\"") {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

// Kiro prompt/hook arguments are shell-like but may contain native Windows
// paths before any shell parses them. Preserve backslashes literally unless
// one escapes whitespace or a shell separator outside quotes, or the active
// quote delimiter. In particular, do not collapse `C:\path`, quoted Windows
// paths, or UNC `\\host` prefixes while still accepting `one\ argument`,
// `one\;two`, and `\"`/`\'` literals.
export function splitKiroCommandArgs(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\") {
      const next = raw[i + 1];
      const outputValueToken = tokens[tokens.length - 1] === "--output";
      const windowsPathToken =
        /^[A-Za-z]:$/.test(current) ||
        current.includes("\\");
      let followingToken = "";
      if (next !== undefined && /\s/.test(next)) {
        let start = i + 1;
        while (start < raw.length && /\s/.test(raw[start])) start++;
        let end = start;
        while (end < raw.length && !/\s/.test(raw[end])) end++;
        followingToken = raw.slice(start, end);
      }
      const endsOutputPathBeforeOption =
        outputValueToken &&
        quote === null &&
        (followingToken === "--export" || followingToken === "--output");
      const closesQuotedOutputPath =
        outputValueToken &&
        quote !== null &&
        next === quote &&
        (
          raw[i + 2] === undefined ||
          /\s/.test(raw[i + 2])
        );
      const escapesWhitespace =
        quote === null &&
        !windowsPathToken &&
        !endsOutputPathBeforeOption &&
        next !== undefined &&
        /\s/.test(next);
      const escapesShellSeparator =
        quote === null &&
        !windowsPathToken &&
        next === ";";
      const escapesQuote =
        next !== undefined &&
        !windowsPathToken &&
        !closesQuotedOutputPath &&
        (
          (quote === null && (next === "'" || next === '"')) ||
          (quote !== null && next === quote)
        );
      if (escapesWhitespace || escapesShellSeparator || escapesQuote) {
        current += next;
        i++;
      } else {
        current += "\\";
      }
      started = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

export const RESERVED_RECORD_NAME_LIST = Object.freeze(
  [...new Set(["help", ...INTENT_VERBS, ...SPACE_VERBS, ...RESERVED_FUTURE])],
);

// Slugs a record (intent or space) may never take. These names are grammar:
// help, current workspace verbs, and reserved future verbs all change how the
// router reads `intent <token>` / `space <token>`. Refusing them at the
// creation chokepoints keeps new records reachable. Pre-existing records with
// these names remain reachable via explicit `switch`; doctor flags them as an
// advisory so humans can rename them deliberately.
export const RESERVED_RECORD_NAMES: ReadonlySet<string> = new Set(RESERVED_RECORD_NAME_LIST);

// A classified terminal command: the aidlc-utility.ts subcommand to run, plus an
// optional positional arg (the <name> for a workspace verb). `source` records
// which family matched, for diagnostics.
export interface TerminalCommand {
  subcommand: string;
  arg?: string;
  args?: string[];
  error?: string;
  display?: string;
  source: "read-only-flag" | "workspace-verb" | "plugin-verb" | "knowledge-verb";
}

export type PluginCommand =
  | { kind: "not-plugin" }
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "run"; argv: string[] };

// Parse the public `plugin` noun once for every entrypoint. The slash
// orchestrator, Kiro's pre-LLM interceptor, and the binary dispatcher must all
// agree that these are terminal utilities rather than freeform workflow text.
export function parsePluginCommand(args: string[]): PluginCommand {
  if (args[0] !== "plugin") return { kind: "not-plugin" };
  const verb = args[1];
  if (verb === "help" || verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }
  const target = verb === "select"
    ? "select-plugins"
    : verb === "list"
      ? "plugin-list"
      : verb === "sync"
        ? "plugin-sync"
        : verb === "validate"
          ? "plugin-validate"
          : verb === "build"
            ? "plugin-build"
        : undefined;
  if (target !== undefined) {
    return { kind: "run", argv: [target, ...args.slice(2)] };
  }
  const detail = verb ? `unknown verb '${verb}'` : "missing verb";
  return {
    kind: "error",
    message: `aidlc: ${detail} for noun 'plugin'; try 'aidlc help --all'`,
  };
}

function terminalCommandFromPluginCommand(
  command: PluginCommand,
  originalArgs: string[],
): TerminalCommand | null {
  if (command.kind === "not-plugin") return null;
  if (command.kind === "help") {
    return { subcommand: "help", display: originalArgs.join(" "), source: "plugin-verb" };
  }
  if (command.kind === "error") {
    return {
      subcommand: "error",
      error: command.message,
      display: originalArgs.join(" "),
      source: "plugin-verb",
    };
  }
  const [subcommand, ...tail] = command.argv;
  return {
    subcommand,
    ...(tail.length > 0 ? { args: tail } : {}),
    display: originalArgs.join(" "),
    source: "plugin-verb",
  };
}

// The DocumentKB verbs, in the order `aidlc knowledge help` lists them. A frozen
// array rather than a switch so the dispatcher, the docs pin, and the skill can
// all enumerate the same surface instead of three hand-kept copies drifting.
// `remove` is deliberately absent: deletion stays "delete your own original,
// then sync", so the tool never holds a destructive verb over user-owned files.
//
// `summarize` (S3b) is a deliberate EIGHTH verb, not a flag riding on an
// existing one. It is not the same case the design rejected for an extractor-
// config verb (§7's option (b), which had a strictly better packager-owned
// alternative): a summary is LLM-authored text with no other entry point into
// the tool, so persisting it needs its own verb exactly as `associate`/
// `dissociate` needed theirs. The tool stays deterministic -- it validates,
// bounds, digests and persists the text a caller supplies; it never generates
// or judges content itself (design §6's execution model).
export const KNOWLEDGE_VERBS: readonly string[] = Object.freeze([
  "onboard",
  "sync",
  "list",
  "show",
  "associate",
  "dissociate",
  "rebind",
  "summarize",
]);

export type KnowledgeCommand =
  | { kind: "not-knowledge" }
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "run"; argv: string[] };

// Parse the public `knowledge` noun once for every entrypoint, mirroring
// parsePluginCommand. The slash orchestrator, Kiro's pre-LLM interceptor, and
// the binary dispatcher must all agree that these are terminal utilities rather
// than freeform workflow text -- an unrecognized noun does not error, it falls
// through to the LLM conductor as intent prose, which is how a command can
// appear to exist and then behave like a prompt.
//
// Unlike `plugin`, the verb IS the subcommand: the DocumentKB tool owns its own
// verb names, so there is no translation table to keep in sync.
export function parseKnowledgeCommand(args: string[]): KnowledgeCommand {
  if (args[0] !== "knowledge") return { kind: "not-knowledge" };
  const verb = args[1];
  if (verb === "help" || verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }
  if (verb !== undefined && KNOWLEDGE_VERBS.includes(verb)) {
    return { kind: "run", argv: [verb, ...args.slice(2)] };
  }
  const detail = verb ? `unknown verb '${verb}'` : "missing verb";
  return {
    kind: "error",
    message: `aidlc: ${detail} for noun 'knowledge'; try 'aidlc help --all'`,
  };
}

function terminalCommandFromKnowledgeCommand(
  command: KnowledgeCommand,
  originalArgs: string[],
): TerminalCommand | null {
  if (command.kind === "not-knowledge") return null;
  if (command.kind === "help") {
    return { subcommand: "help", display: originalArgs.join(" "), source: "knowledge-verb" };
  }
  if (command.kind === "error") {
    return {
      subcommand: "error",
      error: command.message,
      display: originalArgs.join(" "),
      source: "knowledge-verb",
    };
  }
  const [subcommand, ...tail] = command.argv;
  return {
    subcommand,
    ...(tail.length > 0 ? { args: tail } : {}),
    display: originalArgs.join(" "),
    source: "knowledge-verb",
  };
}

// The allowlisted trailing flags `--doctor` accepts (diagnostic export). Kept
// as a set here so the engine (parseNextFlags) and this classifier — the two
// terminal-command deciders — stay byte-for-byte in agreement. A fixed
// allowlist, so an arbitrary token can never ride the read-only path into the
// tool.
export const DOCTOR_EXPORT_FLAGS: ReadonlySet<string> = new Set(["--export", "--output"]);

// Collect the allowlisted `--doctor` export args (`--export`, `--output <dir>`)
// from the token stream after the `--doctor` match, so the seam runs the same
// command the engine's directive names. Mirrors parseNextFlags in the engine.
function collectDoctorExportArgs(args: string[], doctorIdx: number): string[] {
  const extra: string[] = [];
  for (let j = doctorIdx + 1; j < args.length; j++) {
    const t = args[j];
    if (!DOCTOR_EXPORT_FLAGS.has(t)) continue;
    extra.push(t);
    if (t === "--output") {
      const val = args[j + 1];
      if (val !== undefined && !val.startsWith("--")) {
        extra.push(val);
        j++;
      }
    }
  }
  return extra;
}

function terminalCommandFromWorkspaceCommand(
  command: WorkspaceCommand,
  originalArgs: string[],
): TerminalCommand | null {
  if (command.kind === "not-workspace") return null;
  if (command.kind === "help") {
    return { subcommand: "help", source: "read-only-flag" };
  }
  if (command.kind === "error") {
    return {
      subcommand: "error",
      error: command.message,
      display: originalArgs.join(" "),
      source: "workspace-verb",
    };
  }
  const argv = workspaceCommandUtilityArgv(command);
  if (argv === null) return null;
  const [subcommand, ...tail] = argv;
  const terminal: TerminalCommand = { subcommand, source: "workspace-verb" };
  if (tail.length === 1 && !tail[0].startsWith("--")) {
    terminal.arg = tail[0];
  }
  if (tail.length > 1 || (tail.length === 1 && tail[0].startsWith("--"))) {
    terminal.args = tail;
  }
  return terminal;
}

// Classify the post-`/aidlc` argument tokens. Returns the terminal command to run
// deterministically, or null when the input is NOT a terminal command (freeform
// intent text, a --scope/--stage/--phase jump, a config/scope change, creation - all
// of which carry workflow work and MUST go through the engine + conductor). The
// matching rules are byte-for-byte the engine's parseNextFlags terminal branches
// (read-only flag anywhere; workspace verb only at index 0) so the seam and the
// engine can never disagree about what is terminal.
export function classifyTerminalCommand(args: string[]): TerminalCommand | null {
  // A SOLE bare `help` / `-h` token is a help REQUEST (terminal, read-only);
  // mirrors parseNextFlags in the engine. Without this the token reads as
  // freeform intent text and the funnel offers to create an intent named
  // "help". Sole-token only: `help` inside a longer description stays freeform.
  if (args.length === 1 && (args[0] === "help" || args[0] === "-h")) {
    return { subcommand: "help", source: "read-only-flag" };
  }
  const pluginCommand = parsePluginCommand(args);
  if (pluginCommand.kind !== "not-plugin") {
    return terminalCommandFromPluginCommand(pluginCommand, args);
  }
  const knowledgeCommand = parseKnowledgeCommand(args);
  if (knowledgeCommand.kind !== "not-knowledge") {
    return terminalCommandFromKnowledgeCommand(knowledgeCommand, args);
  }
  // Leading workspace nouns own the command. Any later read-only-looking token
  // is part of that workspace command's argv, not a mode switch, because the
  // public grammar promises leading-token semantics.
  const workspaceCommand = parseWorkspaceCommand(args);
  if (workspaceCommand.kind !== "not-workspace") {
    // Intent creation mutates workflow state and must remain on the normal
    // engine/conductor/shell path. In particular, Kiro's prompt interceptor has
    // no session_id, while the shell PostToolUse event does; executing creation
    // off-band would make exact session ownership impossible.
    if (workspaceCommand.kind === "create-intent") return null;
    return terminalCommandFromWorkspaceCommand(workspaceCommand, args);
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (READ_ONLY_FLAGS.has(a)) {
      const subcommand = a.replace(/^--/, "");
      // --doctor carries allowlisted export args (--export, --output <dir>) so
      // the documented export surface reaches the tool through the Kiro/Codex
      // seam too, not only a direct invocation. Carried via `args` (v2's
      // forwarded-args field), mirrored by the engine's parseNextFlags.
      if (a === "--doctor") {
        const extra = collectDoctorExportArgs(args, i);
        if (extra.length > 0) return { subcommand, source: "read-only-flag", args: extra };
      }
      return { subcommand, source: "read-only-flag" };
    }
  }
  return null;
}

// Kiro's plain-text hook channel must carry UTF-8 without terminal protocol
// bytes. Keep this transform narrowly scoped to adapter output that is
// explicitly plain text: structured hook JSON and refusal payloads must retain
// their exact bytes and exit semantics.
export function sanitizeHarnessPlainText(value: string): string {
  let out = "";
  let i = 0;

  const csiEnd = (start: number): number => {
    for (let j = start; j < value.length; j++) {
      const code = value.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) return j;
    }
    return -1;
  };
  const stringControlEnd = (start: number): number => {
    for (let j = start; j < value.length; j++) {
      const code = value.charCodeAt(j);
      if (code === 0x07 || code === 0x9c) return j;
      if (
        code === 0x1b &&
        j + 1 < value.length &&
        value.charCodeAt(j + 1) === 0x5c
      ) {
        return j + 1;
      }
    }
    return -1;
  };

  while (i < value.length) {
    const code = value.charCodeAt(i);

    if (code === 0x1b) {
      const next = value.charCodeAt(i + 1);
      if (next === 0x5b) {
        const end = csiEnd(i + 2);
        i = end >= 0 ? end + 1 : value.length;
        continue;
      }
      if (
        next === 0x50 ||
        next === 0x58 ||
        next === 0x5d ||
        next === 0x5e ||
        next === 0x5f
      ) {
        const end = stringControlEnd(i + 2);
        i = end >= 0 ? end + 1 : value.length;
        continue;
      }
      if (
        next === 0x28 ||
        next === 0x29 ||
        next === 0x2a ||
        next === 0x2b ||
        next === 0x2d ||
        next === 0x2e ||
        next === 0x2f
      ) {
        i = Math.min(value.length, i + 3);
        continue;
      }
      if (next >= 0x40 && next <= 0x5f) {
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (code === 0x9b) {
      const end = csiEnd(i + 1);
      i = end >= 0 ? end + 1 : value.length;
      continue;
    }
    if (
      code === 0x90 ||
      code === 0x98 ||
      code === 0x9d ||
      code === 0x9e ||
      code === 0x9f
    ) {
      const end = stringControlEnd(i + 1);
      i = end >= 0 ? end + 1 : value.length;
      continue;
    }
    if (
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      i++;
      continue;
    }

    out += value[i];
    i++;
  }

  return out;
}

export function decodeHarnessPlainText(
  bytes: Uint8Array | undefined,
): string {
  return sanitizeHarnessPlainText(
    new TextDecoder("utf-8").decode(bytes ?? new Uint8Array()),
  );
}

// --- Engine command detectors (hook classifier seam) ---
//
// These raw command-string classifiers are shared by hooks and tests. They do
// not attempt shell parsing: English-prose mentions and quoted echoes of command
// strings match, which is a pre-existing class shared with the old detectors.
// That direction fails closed: over-detection nudges, never releases.

// A workflow-engine tool call: a Bash invocation of legacy
// aidlc-orchestrate/aidlc-state, a new-grammar `aidlc ...` engine command, or a
// tool whose name itself references aidlc. These are the calls that mean "the
// conductor engaged the workflow this turn"; their presence in the turn that
// answered the human disqualifies the turn from the conversational carve-out (a
// conductor that ran the engine and then quit mid-loop must still be nudged).
export function isEngineToolCall(name: string, input: unknown): boolean {
  const cmd =
    input !== null && typeof input === "object"
      ? String((input as Record<string, unknown>).command ?? "")
      : "";
  // The command text to inspect: a Bash/Shell command, or (for harnesses that
  // surface the tool by name) the tool name itself.
  const text = /^(bash|shell|execute_bash)$/i.test(name) ? cmd : name;
  // Fast reject: no AIDLC engine/state/workspace tool named at all -> not a
  // workflow engagement (a chat turn that ran git/cat/ls etc.).
  if (
    !/aidlc-(orchestrate|state|jump|bolt|swarm|unit)\b/.test(text) &&
    !/\baidlc\s+(?:next|report|park|orchestrate|state|jump|bolt|swarm|unit)\b/.test(text)
  ) {
    return false;
  }
  // Split on shell separators so a CHAINED command is judged per sub-command,
  // not as one blob. Otherwise a read-only flag anywhere in the line
  // (`... --status && aidlc-orchestrate report ...`) would wrongly exempt a
  // mutating call elsewhere in the same line. Each segment is judged on its own.
  const segments = text.split(/&&|\|\||[;|\n]/);
  for (const seg of segments) {
    if (isEngineEngagementSegment(seg)) return true;
  }
  return false;
}

// Current legacy-shape engagement rules. Kept as a helper so the exported
// classifier can preserve every old-shape result while adding the new grammar.
function legacyEngineEngagementSegment(seg: string): boolean {
  if (!/aidlc-(orchestrate|state|jump|bolt|swarm|unit)\b/.test(seg)) return false;
  // A PURE read-only query: a read-only flag present AND no mutating/advancing
  // verb in the SAME segment. `next --status` is read-only; `report --status`
  // (nonsensical, but) still has `report` so is engagement.
  const hasReadOnlyFlag = /--status\b|--doctor\b|--help\b|--version\b/.test(seg);
  if (/aidlc-orchestrate\b/.test(seg)) {
    const advances = /\bnext\b|\breport\b/.test(seg);
    if (!advances) return false; // e.g. an orchestrate invocation with only a read-only flag
    // `next --status` is the read-only status query; a bare `next` (or any
    // `report`) advances. So: advancing verb present -> engagement UNLESS the
    // ONLY advancing token is `next` and it carries a read-only flag.
    if (hasReadOnlyFlag && /\bnext\b/.test(seg) && !/\breport\b/.test(seg)) return false;
    return true;
  }
  if (/aidlc-state\b/.test(seg)) {
    // The mutating / completing subcommands. (Read-only aidlc-state reads like
    // `get`/`show` are not here, so they fall through to non-engagement.)
    return /\b(approve|advance|finalize|complete-workflow|gate-start|checkbox|park|unpark|set|skip|reject|revise|resume)\b/.test(seg);
  }
  if (/aidlc-unit\b/.test(seg)) {
    return !/\b(status|merge-status)\b/.test(seg);
  }
  // aidlc-jump / aidlc-bolt / aidlc-swarm: a read-only query (--help/--status)
  // is not engagement; anything else mutates (jump moves the pointer, bolt forks/
  // merges, swarm runs Construction) so counts as engagement.
  if (hasReadOnlyFlag) return false;
  return true;
}

// One shell sub-command. True when it ENGAGES the forwarding loop or MUTATES
// workflow state, false for a read-only query. A human chatting may legitimately
// ask "what stage am I on?" answered with `--status` / `next --status` /
// `--doctor` / `--help` / `--version` or a read-only utility call: those must
// NOT disqualify the conversational carve-out. Anything that advances the loop
// (`next` fetching a directive, `report` committing a transition) or mutates
// state (aidlc-state completing/transition verbs; a checkbox/jump/bolt/swarm
// move) DOES count as engagement. Fail-toward-engagement: an aidlc-orchestrate/
// state/jump/bolt/swarm verb we do not specifically recognise is treated as
// engagement (BLOCK), so an unrecognised mutating verb can never leak through as
// "chat" - the conservative direction for loop integrity.
export function isEngineEngagementSegment(seg: string): boolean {
  if (
    /aidlc-(orchestrate|state|jump|bolt|swarm|unit)\b/.test(seg) &&
    legacyEngineEngagementSegment(seg)
  ) {
    return true;
  }

  if (!/\baidlc\s+(?:next|report|park|orchestrate|state|jump|bolt|swarm|unit)\b/.test(seg)) {
    return false;
  }

  const hasReadOnlyFlag = /--status\b|--doctor\b|--help\b|--version\b/.test(seg);
  const hasTopNext = /\baidlc\s+next\b/.test(seg);
  const hasTopReport = /\baidlc\s+report\b/.test(seg);
  const hasTopPark = /\baidlc\s+park\b/.test(seg);
  const hasNounNext = /\baidlc\s+orchestrate\s+next\b/.test(seg);
  const hasNounReport = /\baidlc\s+orchestrate\s+report\b/.test(seg);
  const hasNounPark = /\baidlc\s+orchestrate\s+park\b/.test(seg);
  const hasOrchestrateNoun = /\baidlc\s+orchestrate\b/.test(seg);
  const hasNext = hasTopNext || hasNounNext;
  const hasReport = hasTopReport || hasNounReport;
  const hasPark = hasTopPark || hasNounPark;

  if (hasNext || hasReport || hasPark || hasOrchestrateNoun) {
    // Deliberate grammar delta: new-shape `aidlc park` counts as engagement.
    // The old orchestrate branch did not count `aidlc-orchestrate.ts park`
    // because legacy orchestrate engagement recognized only next/report.
    if (!hasNext && !hasReport && !hasPark) return false;
    if (hasReadOnlyFlag && hasNext && !hasReport && !hasPark) return false;
    return true;
  }

  if (/\baidlc\s+state\b/.test(seg)) {
    return /\b(approve|advance|finalize|complete-workflow|gate-start|checkbox|park|unpark|set|set-status|skip|reject|revise|resume|init)\b/.test(seg);
  }

  if (/\baidlc\s+(?:jump|bolt|swarm)\b/.test(seg)) {
    if (hasReadOnlyFlag) return false;
    return true;
  }
  if (/\baidlc\s+unit\b/.test(seg)) {
    return !/\baidlc\s+unit\s+(?:status|merge-status)\b/.test(seg);
  }

  return false;
}

function shellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    const separatorWidth =
      char === "&" && command[i + 1] === "&"
        ? 2
        : char === "|" || char === ";" || char === "\n" ? 1 : 0;
    if (separatorWidth === 0) continue;
    segments.push(command.slice(start, i));
    i += separatorWidth - 1;
    start = i + 1;
  }

  segments.push(command.slice(start));
  return segments;
}

// Classify commands for the rebuild-stage-graph hook's cheap PostToolUse gate.
// Transition matching stays intentionally lexical, but the recursion guard
// only examines real unquoted shell-command segments.
const runtimeCompileHarnessPattern = KNOWN_HARNESS_DIRS
  .map((dir) => dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");
const runtimeCompileTool = new RegExp(
  `\\bbun\\b.*(?:${runtimeCompileHarnessPattern})/tools/aidlc-(state|jump|bolt|unit|utility)\\.ts\\b`,
);
const runtimeCompileReport = new RegExp(
  `\\bbun\\b.*(?:${runtimeCompileHarnessPattern})/tools/aidlc-orchestrate\\.ts\\b.*\\breport\\b`,
);
const runtimeCompileSelf = new RegExp(
  `\\bbun\\b.*(?:${runtimeCompileHarnessPattern})/tools/aidlc-runtime\\.ts\\b`,
);

export function classifyRuntimeCompileCommand(
  command: string,
): "reject" | "fire" | "pass" {
  const invokesRuntime = shellCommandSegments(command)
    .some((segment) => /^\s*aidlc\s+runtime\b/.test(segment));
  if (runtimeCompileSelf.test(command) || invokesRuntime) {
    return "reject";
  }
  if (
    runtimeCompileTool.test(command) ||
    runtimeCompileReport.test(command) ||
    /\baidlc\s+(?:state|jump|bolt|unit)\b|\baidlc\s+(?:status|doctor|version|help)\b|\baidlc\s+scope\s+change\b|\baidlc\s+config\s+set\b/.test(command) ||
    /\baidlc\s+report\b|\baidlc\s+orchestrate\s+report\b|\baidlc\s+next\b.*\breport\b/.test(command)
  ) {
    // Utility split rationale: the new grammar keeps D2 parity for the public
    // one-shots (status/doctor/version/help fire, because the old regex catches
    // ANY aidlc-utility.ts call), but deliberately does NOT fire for the new
    // workspace/gen/sensor/intent/space nouns. Old-shape utility calls keep
    // firing via the retained old regex.
    return "fire";
  }
  return "pass";
}

// `aidlc/` — the harness-neutral workspace roof (memory · codekb · knowledge ·
// intents live under spaces/<space>/ here; the engine stays in <harness>/).
function workspaceRoot(projectDir: string): string {
  return join(projectDir, "aidlc");
}

function canonicalPathKey(path: string): string {
  const resolved = resolvePath(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// The active space for this project. Reads the `aidlc/active-space` cursor;
// defaults to "default". NEVER throws — the default space is always valid even
// when nothing is on disk yet (the resolver tolerates an absent space dir).
export function activeSpace(projectDir: string): string {
  const ptr = join(workspaceRoot(projectDir), ACTIVE_SPACE_POINTER);
  try {
    const raw = readFileSync(ptr, "utf-8").trim();
    if (raw.length > 0) return raw;
  } catch {
    // no cursor → default
  }
  return DEFAULT_SPACE;
}

// `aidlc/spaces/<space>/intents` — the intent registry + record root.
export function intentsDir(projectDir: string, space?: string): string {
  const sp = space ?? activeSpace(projectDir);
  return join(workspaceRoot(projectDir), "spaces", sp, "intents");
}

// `aidlc/spaces/<space>/knowledge` — SPACE DOMAIN knowledge (durable, free-form,
// team-authored, empty at bootstrap). A space-level sibling of memory/codekb/
// intents (vision §"Spaces": "its own memory, codekb, knowledge, and intent
// record") — NOT per-intent: domain knowledge accumulates across every intent in
// the space, so it must not live inside one intent's record. Distinct from the
// engine's per-agent METHODOLOGY knowledge at <harness>/knowledge/ (shipped,
// untouched). Created lazily by ensure-exists, never by SEED.
export function knowledgeDir(projectDir: string, space?: string): string {
  const sp = resolveWorkflowSelection(projectDir, { space }).space;
  return join(workspaceRoot(projectDir), "spaces", sp, "knowledge");
}

// A `--space <name>` flag names an EXISTING space; it is a path SEGMENT, so it
// must never reach a join() raw — `--space ../../../outside` would otherwise
// escape the workspace. `space create` slugifies at the creation chokepoint, so
// any tool accepting the flag has to enforce the same shape on the way back in.
// Returns the validated name, or null when it is not a bare slug (the caller
// owns the exit code and the message).
//
// The shape is slugify()'s own output shape — a name `space create` could have
// produced. A separate constant from BOLT_SLUG_REGEX despite the identical
// pattern today, following the convention that comment states: Bolt slugs,
// stage/artifact slugs, and space names are distinct domains that must be free
// to tighten independently.
export const SPACE_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

export function validSpaceFlag(raw: string): string | null {
  return SPACE_NAME_REGEX.test(raw) ? raw : null;
}

// Enumerate the intent RECORD directories in a space (each `<slug>-<id8>/`
// holding an aidlc-state.md). Returns the bare directory names, sorted; [] when
// the space has no intents dir or no records yet. The intents.json registry is
// the canonical list for humans/ordering — this on-disk scan is the cheap
// "does any record exist?" signal the path resolver and migration detector need
// (it must not depend on the registry being present).
export function listIntentDirs(projectDir: string, space?: string): string[] {
  const dir = intentsDir(projectDir, space);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const records: string[] = [];
  for (const name of entries) {
    // A record dir holds aidlc-state.md; skip the active-intent cursor,
    // intents.json, and any stray files.
    if (existsSync(join(dir, name, "aidlc-state.md"))) records.push(name);
  }
  return records.sort();
}

// The active intent's RECORD directory NAME (`<slug>-<id8>`) for a space, or
// null when no record resolves (→ the path helpers resolve the bare space record
// root). Precedence: explicit > active-intent cursor (if it names a real record)
// > lone intent. Returns null rather than throwing on ambiguity so the path
// helpers stay total; the verb/handler layer (P4) owns the error/prompt for the
// >1-intent-no-cursor case.
export function activeIntent(
  projectDir: string,
  space?: string,
  explicit?: string,
): string | null {
  const sp = space ?? activeSpace(projectDir);
  const dir = intentsDir(projectDir, sp);
  if (explicit) return explicit;
  // Cursor: a real record the pointer names.
  try {
    const raw = readFileSync(join(dir, ACTIVE_INTENT_POINTER), "utf-8").trim();
    if (raw.length > 0 && existsSync(join(dir, raw, "aidlc-state.md"))) return raw;
  } catch {
    // no cursor → fall through to lone-intent
  }
  const records = listIntentDirs(projectDir, sp);
  if (records.length === 1) return records[0];
  // 0 records → null (bare space root); >1 with no cursor → null (the handler
  // layer prompts; a path helper cannot guess which intent the caller meant).
  return null;
}

// The absolute RECORD directory for an intent:
// `aidlc/spaces/<space>/intents/<slug>-<id8>/`. Returns null when no intent
// resolves, signalling the bare-space-root resolution in the path helpers.
function resolveRecordDir(
  projectDir: string,
  intent?: string,
  space?: string,
): { dir: string | null; space: string } {
  const selection = resolveWorkflowSelection(projectDir, { space, intent });
  return {
    dir:
      selection.intent === null
        ? null
        : join(intentsDir(projectDir, selection.space), selection.intent),
    space: selection.space,
  };
}

export function recordDir(
  projectDir: string,
  intent?: string,
  space?: string,
): string | null {
  return resolveRecordDir(projectDir, intent, space).dir;
}

// Relative record-dir prefix for the engine's agent-consumed artifact/diary
// paths: `aidlc/spaces/<space>/intents/<slug>-<id8>` with forward slashes
// regardless of host OS (portable across worktrees). Returns null → the engine
// resolvers resolve the bare space-relative record prefix
// (relativeSpaceRecordPrefix). The space + intent come from the active cursors
// unless passed explicitly; the engine threads the active intent's record-dir
// name in (it knows projectDir but the resolvers themselves take no projectDir —
// see aidlc-orchestrate.ts).
export function relativeRecordDir(
  projectDir: string,
  intent?: string,
  space?: string,
): string | null {
  const selection = resolveWorkflowSelection(projectDir, { space, intent });
  const sp = selection.space;
  const slug = selection.intent;
  if (slug === null) return null;
  return `aidlc/spaces/${sp}/intents/${slug}`;
}

// `aidlc/spaces/<space>/codekb/<repo>/` — the durable per-repo code
// knowledge base, a space-level sibling of memory/knowledge/intents (vision
// §Spaces; committed glob aidlc/spaces/*/codekb/**). NOT per-intent: it is keyed
// by repo and shared across every intent in the space, so it must NOT carry the
// intents/<slug> tail. Mirrors knowledgeDir's space-aware shape.
export function codekbDir(projectDir: string, repo: string, space?: string): string {
  const sp = resolveWorkflowSelection(projectDir, { space }).space;
  return join(workspaceRoot(projectDir), "spaces", sp, "codekb", repo);
}

// Relative analog of codekbDir (posix slashes), the engine-emitted form
// the conductor/subagent reads. Mirrors relativeRecordDir (takes projectDir so it
// can read the active-space cursor — NOT relativeSpaceRecordPrefix, which is
// pinned to the default space).
export function relativeCodekbDir(projectDir: string, repo: string, space?: string): string {
  const sp = resolveWorkflowSelection(projectDir, { space }).space;
  return `aidlc/spaces/${sp}/codekb/${repo}`;
}

// The deterministic repo NAME for codekb keying (NOT the intent slug):
//   1 recorded repo  -> that name
//   0 recorded repos (workspace root IS the repo) -> basename(projectDir)
//   >1 recorded      -> caller loops per repo (this returns basename as a safe
//                       default; callers that know the repo pass --repo explicitly).
// basename done here (lib has basename imported) so callers never inline it.
export function codekbRepoName(
  projectDir: string,
  space?: string,
  intent?: string,
): string {
  const selection = resolveWorkflowSelection(projectDir, { space, intent });
  const repos = intentRepos(
    projectDir,
    selection.intent ?? undefined,
    selection.space,
  );
  return repos.length === 1 ? repos[0] : basename(projectDir);
}

// --- Codekb scope of analysis -------------------------------------------------
//
// The reverse-engineering stage records WHAT its scan covered in a fenced yaml
// block inside reverse-engineering-timestamp.md (the store's freshness marker).
// The parser + fingerprint here are the deterministic half of the rerun
// guard: `codekb-scope-diff` compares a store's recorded scope against the
// live working tree (status) or an incoming run's scope (compare), so the
// human at the RE gate decides reuse/rescan/replace on evidence instead of
// silently losing a prior intent's knowledge to a narrower overwrite.
//
// Block shape (scope_version 1 - authored by the architect at synthesis,
// behind the RE approval gate):
//
//   ```yaml
//   scope_version: 1
//   kind: partial            # or: full
//   intent: fix-payment-timeout
//   fingerprint: 3f2a9c...   # codekbScopeFingerprint over analyzed.paths
//   analyzed:
//     paths:
//       - src/payments/
//     components:
//       - payment-gateway
//   shallow:
//     paths:
//       - src/
//   ```
//
// Pure data - no model call. Same idiom as parseBoltDag: a constrained
// line-walker, no YAML dependency.

export type ReScope = {
  kind: "full" | "partial";
  intent: string;
  fingerprint: string | null;
  analyzedPaths: string[];
  analyzedComponents: string[];
  shallowPaths: string[];
};

export type ReScopeParse =
  | { ok: true; scope: ReScope }
  | { ok: false; reason: "absent" | "malformed"; detail: string };

// Find the fenced yaml block carrying `scope_version:` anywhere in the body
// (keyed on the version line, not a heading, so prose edits around the block
// don't break parsing). Returns the inner lines, or null when no block exists.
function extractScopeBlock(body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^```ya?ml\s*$/.test(lines[i].trim())) {
      const inner: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^```\s*$/.test(lines[j].trim())) break;
        inner.push(lines[j]);
      }
      const block = inner.join("\n");
      if (/^\s*scope_version\s*:/m.test(block)) return block;
      i = j; // not the scope block - resume past its close fence
    }
  }
  return null;
}

// Parse the scope block out of a reverse-engineering-timestamp.md body.
// Unknown scope_version parses as malformed (a future writer must not be
// half-read by an old reader); a missing block is "absent" (legacy store).
export function parseReScope(body: string): ReScopeParse {
  const block = extractScopeBlock(body);
  if (block === null) {
    return { ok: false, reason: "absent", detail: "no fenced yaml scope_version block found" };
  }
  const scope: ReScope = {
    kind: "partial",
    intent: "",
    fingerprint: null,
    analyzedPaths: [],
    analyzedComponents: [],
    shallowPaths: [],
  };
  let section: "analyzed" | "shallow" | null = null;
  let list: "paths" | "components" | null = null;
  let sawKind = false;
  for (const raw of block.split("\n")) {
    const t = raw.trim();
    if (t === "" || t.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      section = null;
      list = null;
      if (t.startsWith("scope_version:")) {
        const v = t.slice("scope_version:".length).trim();
        if (v !== "1") {
          return { ok: false, reason: "malformed", detail: `unknown scope_version: ${v}` };
        }
      } else if (t.startsWith("kind:")) {
        const k = t.slice("kind:".length).trim();
        if (k !== "full" && k !== "partial") {
          return { ok: false, reason: "malformed", detail: `kind must be full|partial, got: ${k}` };
        }
        scope.kind = k;
        sawKind = true;
      } else if (t.startsWith("intent:")) {
        scope.intent = t.slice("intent:".length).trim();
      } else if (t.startsWith("fingerprint:")) {
        const f = t.slice("fingerprint:".length).trim();
        scope.fingerprint = f === "" || f === "unknown" ? null : f;
      } else if (t === "analyzed:") {
        section = "analyzed";
      } else if (t === "shallow:") {
        section = "shallow";
      }
    } else if (section !== null && !t.startsWith("-") && t.endsWith(":")) {
      list = t === "paths:" ? "paths" : t === "components:" ? "components" : null;
    } else if (section !== null && list !== null && t.startsWith("-")) {
      const item = t.slice(1).trim();
      if (item === "") continue;
      if (section === "analyzed" && list === "paths") scope.analyzedPaths.push(item);
      else if (section === "analyzed" && list === "components") scope.analyzedComponents.push(item);
      else if (section === "shallow" && list === "paths") scope.shallowPaths.push(item);
    }
  }
  if (!sawKind) {
    return { ok: false, reason: "malformed", detail: "missing kind: line" };
  }
  if (scope.kind === "partial" && scope.analyzedPaths.length === 0) {
    return { ok: false, reason: "malformed", detail: "kind: partial requires analyzed.paths entries" };
  }
  if (scope.kind === "partial" && scope.analyzedPaths.includes("./")) {
    return {
      ok: false,
      reason: "malformed",
      detail: "repository-root coverage (./) requires kind: full",
    };
  }
  if (scope.kind === "full" && !scope.analyzedPaths.includes("./")) {
    return {
      ok: false,
      reason: "malformed",
      detail: "kind: full requires repository-root coverage (analyzed.paths must include ./)",
    };
  }
  return { ok: true, scope };
}

// Content fingerprint of the WORKING TREE restricted to the scope's analyzed
// paths: `git write-tree` over a temporary index populated by `git add -A --
// <paths>`. Hashes what is actually on disk (uncommitted edits included), so
// rebases/squashes/amends that vaporise a recorded commit hash cannot break
// the comparison, and reverting an edit restores the original fingerprint.
// Ignored files stay excluded (git add semantics). Callers may exclude generated
// paths that live inside an analyzed root, such as the codekb being fingerprinted;
// exclusions outside every analyzed root are omitted before invoking git.
// Returns null when repoDir is not a git work tree, git is unavailable, or any
// pathspec is invalid/unmatched or stages zero paths (callers report UNVERIFIED,
// never a false verdict or the empty-tree fingerprint).
export function codekbScopeFingerprint(
  repoDir: string,
  paths: string[],
  excludedPaths: string[] = [],
): string | null {
  if (paths.length === 0) return null;
  const normalizePath = (path: string): string => {
    let normalized = path.replaceAll("\\", "/");
    normalized = normalized.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    return normalized === "." ? "" : normalized;
  };
  const normalizedExclusions = excludedPaths.map(normalizePath);
  const survivingPaths = paths
    .map((original) => ({ original, normalized: normalizePath(original) }))
    .filter(
      ({ normalized: positive }) =>
        !normalizedExclusions.some(
          (exclusion) =>
            exclusion === positive || positive.startsWith(`${exclusion}/`),
        ),
    );
  if (survivingPaths.length === 0) return null;
  const exclusions = normalizedExclusions
    .filter((exclusion) =>
      survivingPaths.some(
        ({ normalized: positive }) =>
          positive === "" || exclusion.startsWith(`${positive}/`),
      ),
    )
    .map((exclusion) => `:(exclude,literal)${exclusion}`);

  const inTree = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoDir,
    encoding: "utf-8",
  });
  if (inTree.status !== 0 || inTree.stdout.trim() !== "true") return null;
  const indexFile = join(tmpdir(), `.aidlc-scope-index-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const add = spawnSync(
      "git",
      ["add", "-A", "--", ...survivingPaths.map(({ original }) => original), ...exclusions],
      {
        cwd: repoDir,
        env,
        encoding: "utf-8",
      },
    );
    if (add.status !== 0) return null;
    const staged = spawnSync("git", ["ls-files", "-z"], {
      cwd: repoDir,
      env,
      encoding: "utf-8",
    });
    if (staged.status !== 0 || staged.stdout.length === 0) return null;
    const wt = spawnSync("git", ["write-tree"], { cwd: repoDir, env, encoding: "utf-8" });
    if (wt.status !== 0) return null;
    const hash = wt.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(hash) ? hash : null;
  } finally {
    try {
      unlinkSync(indexFile);
    } catch {
      // best-effort cleanup - a leaked temp index is inert
    }
  }
}

function normalizeGenerationPath(path: string): string | null {
  const portable = path.trim().replaceAll("\\", "/");
  if (
    portable === "" ||
    portable.startsWith("/") ||
    /^[A-Za-z]:\//.test(portable) ||
    /[*?[\]]/.test(portable)
  ) {
    return null;
  }
  const segments = portable.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  return segments.length === 0 ? "." : segments.join("/");
}

function treeGeneration(
  rootDir: string,
  paths: string[],
  excludedPaths: string[] = [],
): string | null {
  const normalizedPaths = [...new Set(paths.map(normalizeGenerationPath))];
  if (normalizedPaths.includes(null) || normalizedPaths.length === 0) return null;
  const normalizedExcludes = new Set(
    [".git", ...excludedPaths]
      .map(normalizeGenerationPath)
      .filter((path): path is string => path !== null),
  );
  const root = resolvePath(rootDir);
  const seen = new Set<string>();
  const hash = createHash("sha256");
  const excluded = (portable: string): boolean =>
    [...normalizedExcludes].some(
      (entry) => portable === entry || portable.startsWith(`${entry}/`),
    );

  const visit = (absPath: string, portable: string): boolean => {
    if (portable !== "." && excluded(portable)) return true;
    if (seen.has(portable)) return true;
    seen.add(portable);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absPath);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      hash.update(`L\0${portable}\0${readlinkSync(absPath)}\0`, "utf-8");
      return true;
    }
    if (stat.isDirectory()) {
      hash.update(`D\0${portable}\0`, "utf-8");
      let names: string[];
      try {
        names = readdirSync(absPath).sort();
      } catch {
        return false;
      }
      for (const name of names) {
        const childPortable = portable === "." ? name : `${portable}/${name}`;
        if (!visit(join(absPath, name), childPortable)) return false;
      }
      return true;
    }
    if (!stat.isFile()) return false;
    hash.update(`F\0${portable}\0${stat.size}\0`, "utf-8");
    hash.update(readFileSync(absPath));
    hash.update("\0", "utf-8");
    return true;
  };

  for (const portable of normalizedPaths as string[]) {
    const absPath = portable === "." ? root : resolvePath(root, ...portable.split("/"));
    const rel = relative(root, absPath);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return null;
    hash.update(`S\0${portable}\0`, "utf-8");
    if (!visit(absPath, portable)) return null;
  }
  return hash.digest("hex");
}

// A generation token for the source paths that informed one CodeKB candidate.
// Prefer the existing git-aware fingerprint (ignored files excluded); fall back
// to a byte-exact tree hash so non-git workspaces still receive a real CAS token.
export function codekbSourceFingerprint(
  repoDir: string,
  paths: string[],
  excludedPaths: string[] = [],
): string | null {
  const git = codekbScopeFingerprint(repoDir, paths, excludedPaths);
  if (git !== null) return `git:${git}`;
  const tree = treeGeneration(repoDir, paths, excludedPaths);
  return tree === null ? null : `tree:${tree}`;
}

// Hash the complete on-disk CodeKB directory, not only its timestamp. This is
// the compare-and-swap generation for cumulative merges: any concurrent edit to
// any artifact changes the token and makes a stale publish refuse.
export function codekbStoreGeneration(storeDir: string): string {
  if (!existsSync(storeDir)) return "none";
  const generation = treeGeneration(storeDir, ["./"]);
  if (generation === null) {
    throw new Error(`cannot compute CodeKB store generation for ${storeDir}`);
  }
  return `sha256:${generation}`;
}

// True only when the durable CodeKB store for `repo` carries a valid scope
// block whose recorded fingerprint still matches the current source tree.
// This is the programmatic form of `codekb-scope-diff`'s CURRENT verdict, used
// by authority-bearing reuse receipts so freshness is checked both when the
// receipt is minted and when pipeline completion consumes it.
export function codekbStoreIsCurrent(
  projectDir: string,
  requestedRepo?: string,
  space?: string,
): boolean {
  const sp = space ?? activeSpace(projectDir);
  const repo = requestedRepo ?? codekbRepoName(projectDir, sp);
  const timestamp = join(
    codekbDir(projectDir, repo, sp),
    "reverse-engineering-timestamp.md",
  );
  if (!existsSync(timestamp)) return false;
  let parsed: ReScopeParse;
  try {
    parsed = parseReScope(readFileSync(timestamp, "utf-8"));
  } catch {
    return false;
  }
  if (!parsed.ok || parsed.scope.fingerprint === null) return false;
  const sibling = repoDir(projectDir, repo);
  const sourceRoot =
    existsSync(sibling) && statSync(sibling).isDirectory()
      ? sibling
      : projectDir;
  const current = codekbScopeFingerprint(
    sourceRoot,
    parsed.scope.analyzedPaths,
    sourceRoot === projectDir ? ["aidlc"] : [],
  );
  return current !== null && current === parsed.scope.fingerprint;
}

// Coverage test for the compare mode: does the incoming run's analyzed set
// cover a store entry? Literal match, or an incoming DIRECTORY prefix (entry
// ending "/") subsuming the store path. Deliberately prefix-only - scope
// paths are authored as repo-relative dirs/files, not globs.
export function scopePathCovered(incoming: string[], storePath: string): boolean {
  return incoming.some(
    (p) => p === storePath || (p.endsWith("/") && storePath.startsWith(p)),
  );
}

// The bare SPACE record root: `aidlc/spaces/<space>/intents/`. The absolute path
// helpers resolve here when no intent record exists (activeIntent → null) — a
// fresh SEED shell before auto-create, or a flat project still awaiting migration.
// No aidlc-state.md ever lives directly here, so existence-gated readers
// (loadStateFileIfPresent) see "no workflow yet" and the orchestrator
// creates an intent or reports an error. This is the P9 end state; there is no
// flat `aidlc-docs/` root.
function spaceRecordRoot(projectDir: string, space?: string): string {
  return intentsDir(projectDir, space);
}

// The bare space-RELATIVE record prefix (posix slashes) — the relative analog of
// spaceRecordRoot, used by the engine/worktree resolvers when no per-intent
// record prefix is threaded. The relative resolvers take no projectDir, so they
// cannot read the active-space cursor and default to `default` (the same
// single-string limitation the old flat relative prefix had — not a regression;
// a non-default space threads relativeRecordDir explicitly).
export function relativeSpaceRecordPrefix(space: string = DEFAULT_SPACE): string {
  return `aidlc/spaces/${space}/intents`;
}

// --- Intent identity: UUIDv7 + slugify ----------------------------------------
//
// The canonical intent id is a UUIDv7 (time-ordered, globally unique, merge-safe,
// stable across a slug rename). The dir name is `<slug>-<id8>` where id8 is the
// trailing 8 hex of the uuid (a derived disambiguator). A within-space clash
// resolves by the next-longer prefix of the SAME uuid (id8→id10→…), never a
// re-mint.

// Generate a UUIDv7: a 48-bit Unix-ms timestamp prefix + version 7 nibble +
// random/variant tail. Sorting by uuid string is creation order. Date.now()
// supplies the timestamp; randomUUID() supplies the random + variant bits (no
// Math.random): take the v4 uuid's 32 hex digits,
// overwrite the first 12 (the timestamp) and the 13th (the version nibble → 7),
// and keep digits 13..31 (which include the v4 variant nibble) cryptographically
// sourced.
export function uuidv7(): string {
  const hex = randomUUID().replace(/-/g, ""); // 32 hex chars, v4
  const ms = Date.now();
  const tsHex = ms.toString(16).padStart(12, "0").slice(-12); // 48 bits = 12 hex
  const body = `${tsHex}7${hex.slice(13)}`; // ts(12) + version(1) + tail(19)
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}`;
}

// The id8 disambiguator: trailing 8 hex chars of the uuid (digits only, dashes
// stripped). Used in the `<slug>-<id8>` dir name.
export function idSuffix(uuid: string, length = 8): string {
  const hex = uuid.replace(/-/g, "");
  return hex.slice(-length);
}

// Deterministic free-text → SLUG_RE-valid kebab: lowercase; non-alphanumerics →
// hyphens; collapse + trim hyphens; cap length; ensure a leading letter. Pure +
// idempotent (slugify(slugify(x)) === slugify(x)). Falls back to "intent" when
// the input reduces to empty.
export function slugify(text: string, maxLength = 48): string {
  let s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  // Ensure a leading LETTER (SLUG_RE = /^[a-z][a-z0-9-]*$/).
  if (!/^[a-z]/.test(s)) s = `intent-${s}`.replace(/-+$/g, "");
  if (s.length === 0) s = "intent";
  return s;
}

// --- Intent record dir name: <YYMMDD>-<short-label> ---------------------------
//
// SPIKE (date-prefix). The record dir name leads with a compact UTC date so the
// records sort CHRONOLOGICALLY in any file browser / `ls` (the time token is a
// PREFIX, where lexicographic sort = creation order — a suffix would sort by the
// label). The label is a SHORT human slug (cap 24, vs the old 48) — the
// orchestrator is expected to pass a 2-3 word essence ("simple calc"), not the
// full request sentence. Uniqueness within the space is the caller's collision
// loop (a -N counter), NOT this name: the canonical, collision-proof id stays the
// UUIDv7 in the registry row, and the row now stores this dirName verbatim (so the
// readers never reconstruct it from slug+uuid).

// The human-readable LABEL for a record dir name, for display/orphan rows when
// no registry row supplies a slug. SPIKE (date-prefix): strip a leading `YYMMDD-`
// date prefix; else strip a legacy trailing `-<hex>` id8. Falls back to the whole
// name if neither shape matches.
export function displaySlugFromDirName(dirName: string): string {
  const dated = /^\d{6}-(.+)$/.exec(dirName);
  if (dated) return dated[1];
  return dirName.replace(/-[0-9a-f]+$/, "");
}

// Compact UTC date stamp YYMMDD. UTC (not local) so the stamp is reproducible
// regardless of the clone's timezone — matches isoTimestamp's UTC basis.
export function dateStamp(date: Date = new Date()): string {
  const yy = String(date.getUTCFullYear()).slice(-2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

// Build the BASE record dir name `<YYMMDD>-<short-label>` (pre-collision). The
// label is slugified with the tighter 24-char cap. Starts with a DIGIT — legal,
// since no SLUG_RE validates the intent dir name (those guard the bolt/stage/
// artifact slugs). The collision loop appends `-2`, `-3`, … to this base.
export function intentDirNameBase(label: string, date: Date = new Date()): string {
  return `${dateStamp(date)}-${slugify(label, 24)}`;
}

// Resolve a within-space dir clash by appending a numeric counter: `<base>`,
// `<base>-2`, `<base>-3`, … (the date prefix has no hex tail to extend, unlike the
// pre-spike scheme). Two intents created on the same day with the same short
// label are the only collision case; the counter keeps the readable name AND
// uniqueness, and
// the canonical id is still the row's UUIDv7. Returns the first free name.
//
// Bounded by MAX_DIR_COLLISIONS: 998 same-day same-label intents is not a real
// workflow - it is a bug or a pathological caller (e.g. a script creating intents in a
// loop with a constant label). Fail LOUD with a diagnostic rather than spin, so
// the cause surfaces. Safe to throw here: the caller holds the workspace lock via
// withAuditLock, which releases in its `finally` (and an on-exit net), so the
// throw unwinds without leaking the lock.
export function resolveUniqueIntentDir(intentsRoot: string, base: string): string {
  if (!existsSync(join(intentsRoot, base))) return base;
  const MAX_DIR_COLLISIONS = 1000;
  for (let n = 2; n < MAX_DIR_COLLISIONS; n++) {
    const candidate = `${base}-${n}`;
    if (!existsSync(join(intentsRoot, candidate))) return candidate;
  }
  throw new Error(
    `Could not find a free intent record dir for "${base}" after ${MAX_DIR_COLLISIONS} attempts in ${intentsRoot}. ` +
      `This many same-day intents with the same label indicates a bug or a runaway caller — pass a distinct --label.`,
  );
}

// --- Flat-layout migration (one-time, lock-guarded, crash-safe) ---------------
//
// A pre-workspace project keeps its record at the flat `aidlc-docs/` root. This
// moves it ONCE into a per-intent record dir under spaces/default/. Two review
// blockers shaped the design (vision plan P1 migration box):
//
//  (1) DETECTION keys on a signal SEED does NOT ship: a flat `aidlc-docs/
//      aidlc-state.md` present AND no `aidlc/spaces/*/intents/*/aidlc-state.md`
//      record yet AND no `.migrated` marker. (SEED ships `aidlc/spaces/default/`,
//      so "no spaces dir" would never fire and would orphan the legacy tree.)
//  (2) IDEMPOTENCY keys on the `.migrated` marker ALONE (written LAST), never on
//      `aidlc/spaces/` existence — a crash after the parent mkdir but before the
//      move completes must re-detect and re-stage from the untouched original.
//
// MECHANISM (all inside withAuditLock on the WORKSPACE bucket): mint a UUIDv7;
// slug from existing state or "default"; (1) stage a COPY of the whole aidlc-docs/
// tree into a temp dir UNDER the workspace root (same filesystem — NOT tmpdir(),
// or a cross-device rename degrades to non-atomic); (2) mkdir the intent dir's
// PARENT chain; (3) ONE atomic rename of the staged tree into the leaf
// <slug>-<id8>/ (the leaf is created BY this rename); (4) append to intents.json
// + set active-intent; (5) write the `.migrated` marker LAST. The flat tree is
// git-rm'd post-move (the data MOVED, not deleted); the source is NEVER rmSync'd.
//
// THE ONE SURVIVING `aidlc-docs` READ. P9 removed the transitional dual-layout
// fallback — the record tree is now a SINGLE per-intent layout. The ONLY place
// the legacy flat `aidlc-docs/` root is still read is this one-time migration:
// needsFlatMigration() probes flatStateSource() and migrateFlatLayout() moves
// flatMigrationSource(). These two private helpers localise that read so the
// grep gate's `aidlc-docs` allowlist in core code is exactly this constant.
const FLAT_MIGRATION_ROOT = "aidlc-docs";

function flatMigrationSource(projectDir: string): string {
  return join(projectDir, FLAT_MIGRATION_ROOT);
}

function flatStateSource(projectDir: string): string {
  return join(flatMigrationSource(projectDir), "aidlc-state.md");
}

export const MIGRATED_MARKER = ".migrated";

// The marker path: `aidlc/.migrated` (workspace-level, committed, idempotency key).
export function migratedMarkerPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), MIGRATED_MARKER);
}

// Does this project need a flat→per-intent migration? Detection per blocker (1).
export function needsFlatMigration(projectDir: string): boolean {
  // Marker present → already migrated (idempotency key, blocker 2).
  if (existsSync(migratedMarkerPath(projectDir))) return false;
  // No flat state → nothing to migrate (a fresh SEED shell, or already moved).
  // This is the migration DETECTION trigger — the sole legitimate read of the
  // legacy flat state path (allowlisted in the grep gate).
  const flatState = flatStateSource(projectDir);
  if (!existsSync(flatState)) return false;
  // Any new-layout intent RECORD already present → migration ran (or a fresh
  // created intent exists); do not move a second tree on top of it.
  if (anyIntentRecordExists(projectDir)) return false;
  return true;
}

// True iff any space already holds an intent record (a `<dir>/aidlc-state.md`).
// Scans aidlc/spaces/*/intents/*/aidlc-state.md WITHOUT relying on the registry.
export function anyIntentRecordExists(projectDir: string): boolean {
  const spacesRoot = join(workspaceRoot(projectDir), "spaces");
  let spaces: string[];
  try {
    spaces = readdirSync(spacesRoot);
  } catch {
    return false;
  }
  for (const sp of spaces) {
    if (listIntentDirs(projectDir, sp).length > 0) return true;
  }
  return false;
}

// Append an intent to the space's intents.json registry (creating it if absent).
// MUST be called under the WORKSPACE lock bucket (invariant 2) — the registry is
// shared workspace-level truth. Each row: {uuid, slug, scope, repos, status}.
export interface IntentRegistryEntry {
  uuid: string;
  slug: string;
  // The on-disk record dir name. SPIKE (date-prefix): stored verbatim at creation so
  // readers join a row to its dir DIRECTLY, never reconstructing it from slug+uuid
  // (the date-prefixed name `<YYMMDD>-<label>` is not derivable from {slug,uuid}).
  // Optional for back-compat: pre-spike rows (and hand-written fixtures) omit it,
  // and recordDirMatches() falls back to the legacy `<slug>-<id8>` hex match.
  dirName?: string;
  scope?: string;
  repos?: string[];
  status: string;
}

// Does record dir `dirName` belong to registry row `entry`? The single shared
// join rule for every row→dir matcher (listIntents/updateIntentStatus/intentRepos).
// SPIKE (date-prefix): prefer the stored `entry.dirName` (exact match); fall back
// to the legacy `<slug>-<id8>` shape (slug prefix + trailing hex that is a prefix
// of the uuid's id-suffix) so pre-spike rows and fixtures still resolve.
export function recordDirMatches(entry: IntentRegistryEntry, dirName: string): boolean {
  if (entry.dirName) return entry.dirName === dirName;
  if (!dirName.startsWith(`${entry.slug}-`)) return false;
  const suffix = dirName.slice(entry.slug.length + 1);
  return /^[0-9a-f]+$/.test(suffix) && idSuffix(entry.uuid, suffix.length) === suffix;
}

export function intentsRegistryPath(projectDir: string, space?: string): string {
  return join(intentsDir(projectDir, space), "intents.json");
}

export function appendIntentToRegistry(
  projectDir: string,
  entry: IntentRegistryEntry,
  space?: string,
): void {
  const path = intentsRegistryPath(projectDir, space);
  let list: IntentRegistryEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(parsed)) list = parsed as IntentRegistryEntry[];
  } catch {
    // absent / malformed → start a fresh list
  }
  list.push(entry);
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(list, null, 2)}\n`);
}

// The `aidlc/spaces` root — the parent of every space dir. Sole helper so the
// "what spaces exist?" scan and the intent-record scan agree on one location.
export function spacesRoot(projectDir: string): string {
  return join(workspaceRoot(projectDir), "spaces");
}

// Read a space's intents.json registry as a typed list. Returns [] when the
// file is absent or malformed (same tolerance as appendIntentToRegistry). The
// canonical "what intents exist" record for humans/ordering/status — the cheap
// on-disk listIntentDirs() scan is the path-resolver's record-presence signal,
// but the registry carries the uuid/status/scope/repos a human or the --json
// consumer needs.
export function readIntentRegistry(projectDir: string, space?: string): IntentRegistryEntry[] {
  const path = intentsRegistryPath(projectDir, space);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(parsed)) return parsed as IntentRegistryEntry[];
  } catch {
    // absent / malformed → empty
  }
  return [];
}

// --- The deterministic query layer: "what exists" (one source, two modes) ----
//
// listSpaces()/listIntents() are the single shared readers the verb handlers,
// the auto-create gate, the resume-rebind, and the statusline all call (P4
// query-layer box). Pure reads — they never mutate. A space exists iff its dir
// is present under aidlc/spaces/; an intent's authoritative row is the
// registry, joined with the on-disk record presence.

export interface SpaceInfo {
  name: string;
  active: boolean;
}

// Enumerate the spaces (dir names under aidlc/spaces/), sorted, each flagged
// active per the active-space cursor. "default" is always reported even when no
// spaces dir exists yet (the resolver treats it as always-valid — activeSpace()
// returns it), so the listing never claims zero spaces on a fresh shell.
export function listSpaces(projectDir: string, activeOverride?: string): SpaceInfo[] {
  const active = activeOverride ?? activeSpace(projectDir);
  const names = new Set<string>([DEFAULT_SPACE]);
  try {
    for (const name of readdirSync(spacesRoot(projectDir))) {
      if (statSync(join(spacesRoot(projectDir), name)).isDirectory()) names.add(name);
    }
  } catch {
    // no spaces dir → just the always-present default
  }
  return [...names].sort().map((name) => ({ name, active: name === active }));
}

export interface IntentInfo {
  uuid: string;
  slug: string;
  status: string;
  scope?: string;
  repos?: string[];
  dirName: string | null; // the on-disk <slug>-<id8> record dir, or null if registry-only
  active: boolean;
}

// Enumerate a space's intents from the registry, joined with the on-disk record
// dirs, each flagged active per the active-intent cursor. The registry is the
// ordering/identity source; the dir-name is matched by the id8 disambiguator
// suffix so a registry row resolves to its record dir even when the slug was
// later renamed. A record dir with no registry row (a hand-created or migrated
// orphan) is appended so the listing never hides an on-disk intent.
export function listIntents(
  projectDir: string,
  space?: string,
  activeIntentOverride?: string | null,
): IntentInfo[] {
  const sp = space ?? activeSpace(projectDir);
  const registry = readIntentRegistry(projectDir, sp);
  const dirs = listIntentDirs(projectDir, sp);
  // activeIntent() returns the record DIR NAME of the active intent (or null).
  const activeDir =
    activeIntentOverride === undefined
      ? activeIntent(projectDir, sp)
      : activeIntentOverride;
  const claimedDirs = new Set<string>();
  const infos: IntentInfo[] = registry.map((entry) => {
    // Match the row to its record dir via the shared join rule (stored dirName,
    // else the legacy `<slug>-<id8>` shape).
    const dirName = dirs.find((d) => recordDirMatches(entry, d)) ?? null;
    if (dirName) claimedDirs.add(dirName);
    return {
      uuid: entry.uuid,
      slug: entry.slug,
      status: entry.status,
      scope: entry.scope,
      repos: entry.repos,
      dirName,
      active: dirName !== null && dirName === activeDir,
    };
  });
  // On-disk records with no registry row (orphans) — surface them too.
  for (const d of dirs) {
    if (claimedDirs.has(d)) continue;
    infos.push({
      uuid: "",
      slug: displaySlugFromDirName(d),
      status: "unknown",
      dirName: d,
      active: d === activeDir,
    });
  }
  return infos;
}

// Materialize the active-space cursor without overwriting a concurrent explicit
// switch. A clone does not carry this gitignored file, so SessionStart and any
// active-intent write recreate the resolved pointer on first use. Publish a
// fully-written staged file with link(), whose no-replace install is atomic: if
// a space switch wins the race, its value stays untouched.
export function ensureActiveSpaceCursor(projectDir: string): void {
  const space = activeSpace(projectDir);
  const root = workspaceRoot(projectDir);
  const cursor = join(root, ACTIVE_SPACE_POINTER);
  const staged = join(root, `.aidlc-active-space-${process.pid}-${randomUUID()}.tmp`);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(staged, `${space}\n`, { encoding: "utf-8", flag: "wx" });
    linkSync(staged, cursor);
  } catch {
    /* existing cursor won, or per-user state is unwritable */
  } finally {
    try {
      unlinkSync(staged);
    } catch {
      /* staging file was never created or is already gone */
    }
  }
}

// Write the active-intent cursor for a space (gitignored per-user pointer).
// Best-effort: the cursor dirs are created if absent; a write failure is
// swallowed (the cursors are per-user state, never the source of truth).
export function setActiveIntentCursor(projectDir: string, dirName: string, space?: string): void {
  ensureActiveSpaceCursor(projectDir);
  const dir = intentsDir(projectDir, space);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ACTIVE_INTENT_POINTER), `${dirName}\n`, "utf-8");
  } catch {
    /* per-user cursor; best-effort */
  }
}

// Write the active-space cursor (gitignored per-user pointer). Best-effort.
export function setActiveSpaceCursor(projectDir: string, name: string): void {
  try {
    mkdirSync(workspaceRoot(projectDir), { recursive: true });
    writeFileSync(join(workspaceRoot(projectDir), ACTIVE_SPACE_POINTER), `${name}\n`, "utf-8");
  } catch {
    /* per-user cursor; best-effort */
  }
}

// --- Per-conversation session→intent record (resume rebind, P8) --------------
//
// A conversation (one Claude Code `session_id`) works ONE intent at a time, but
// the active-intent CURSOR is per-user, durable, and shared across sessions — so
// resuming an A-chat after the cursor moved to B would otherwise silently inject
// B's context (the central multi-space hazard, vision §3). The fix is a tiny
// per-user, machine-local map: at session START stamp the working intent's UUID
// keyed by session_id; on RESUME, compare the stamped UUID to the live cursor
// and OFFER a rebind on mismatch. The map lives at `aidlc/.aidlc-sessions/`
// (gitignored — see dot-gitignore `aidlc/.aidlc-sessions/`): it is per-user
// runtime state, never shared truth. The intent record itself is the durable,
// harness-neutral artifact; the session merely enriches the cursor on resume.
export const SESSIONS_DIR = ".aidlc-sessions";

// The gitignored runtime scratch dir `aidlc/.aidlc-sessions/`. Exported because
// aidlc-usage.ts writes the usage ledger and the persisted-transcript-path
// pointers here, and the statusline/state consumers read the ledger back.
export function sessionsDir(projectDir: string): string {
  return join(workspaceRoot(projectDir), SESSIONS_DIR);
}

// The per-session record file: `aidlc/.aidlc-sessions/<session-id>`. Session
// ids must already match the canonical safe shape; normalization-changing
// values are rejected so distinct raw identities cannot alias one record.
function safeSessionId(sessionId: string): string {
  const safe = sessionId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);
  if (!safe || safe === "." || safe === "..") return "";
  return safe;
}

export function validSessionId(sessionId: string | undefined): string | null {
  const raw = sessionId ?? "";
  return raw && safeSessionId(raw) === raw ? raw : null;
}

export class SessionResolutionConflictError extends Error {
  constructor(
    readonly overrideSessionId: string,
    readonly ancestrySessionId: string,
  ) {
    super(
      `Session override "${overrideSessionId}" conflicts with the owning conversation ` +
        `"${ancestrySessionId}". Work from the owning conversation, or rebind this ` +
        "session with the intent/space switch verbs.",
    );
    this.name = "SessionResolutionConflictError";
  }
}

const PLAN_APPROVAL_RUNTIME_DIR = "plan-approval";

export interface PlanApprovalRuntimeIdentity {
  targetId: string;
  intentId: string;
  directiveEpoch: string;
  runFloor: string;
  fingerprint: string;
  questionsFile: string;
  promptSha256: string;
  sourceFloor: string;
  markerRevision: number;
}

export interface PlanApprovalRuntimeChallenge extends PlanApprovalRuntimeIdentity {
  version: 1;
  session: string;
  challengeId: string;
  options: [string, string];
  requireExactOptionLabels: boolean;
  hashedOptionLabels: boolean;
}

export interface PlanApprovalRuntimeResponse {
  version: 1;
  session: string;
  challengeId: string;
  choice: "Approve Plan" | "Request Changes";
  responseSha256: string;
}

export interface PlanApprovalRuntimeReceipt extends PlanApprovalRuntimeIdentity {
  version: 1;
  session: string;
  challengeId: string;
  choice: "Approve Plan";
  questionsSha256: string;
  certifiedSourceSha256: string;
  status: "approved" | "generation";
}

export interface PlanApprovalRuntimeViolation {
  version: 1;
  markerRevision: number;
  reason: string;
  target: string;
}

export interface PlanApprovalLegacyWindow {
  version: 1;
  session: string;
  toolName: string;
  markerRevision: number;
  targetId: string;
  unit: string | null;
}

export interface PlanApprovalLegacyOfferCandidate {
  session: string;
  optionHashes: [string, string];
}

export interface PlanApprovalLegacyOffer {
  version: 1;
  session: string;
  intentId: string;
  markerRevision: number;
  allowedUnits: Array<string | null>;
  options: [string, string];
}

export const LEGACY_PLAN_APPROVAL_RECOVERY_CHOICE =
  "Recover Plan Approval";

export interface PlanApprovalLegacyRecoveryChallenge {
  version: 1;
  session: string;
  intentId: string;
  markerRevision: number;
  challengeId: string;
}

export interface PlanApprovalLegacyRecoveryResponse {
  version: 1;
  session: string;
  challengeId: string;
  responseSha256: string;
}

export interface KiroIdeLegacyPlanApprovalHost {
  version: 1;
  session: string;
  pid: string;
  ipc: string;
}

function planApprovalRuntimeDir(projectDir: string): string {
  return join(sessionsDir(projectDir), PLAN_APPROVAL_RUNTIME_DIR);
}

function runtimeSessionSegment(session: string): string {
  return session
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function planApprovalChallengePath(projectDir: string, session: string): string {
  const segment = runtimeSessionSegment(session);
  return segment
    ? join(planApprovalRuntimeDir(projectDir), `challenge-${segment}.json`)
    : "";
}

function planApprovalResponsePath(projectDir: string, session: string): string {
  const segment = runtimeSessionSegment(session);
  return segment
    ? join(planApprovalRuntimeDir(projectDir), `response-${segment}.json`)
    : "";
}

function planApprovalReceiptPath(
  projectDir: string,
  identity: Pick<PlanApprovalRuntimeIdentity, "targetId" | "directiveEpoch">,
): string {
  const key = createHash("sha256")
    .update(`${identity.targetId}\n${identity.directiveEpoch}`, "utf-8")
    .digest("hex");
  return join(planApprovalRuntimeDir(projectDir), `receipt-${key}.json`);
}

function planApprovalViolationPath(projectDir: string): string {
  return join(planApprovalRuntimeDir(projectDir), "violation.json");
}

function planApprovalLegacyWindowPath(projectDir: string, session: string): string {
  const segment = runtimeSessionSegment(session);
  return segment
    ? join(planApprovalRuntimeDir(projectDir), `legacy-window-${segment}.json`)
    : "";
}

function planApprovalLegacyOfferPath(
  projectDir: string,
  session: string,
): string {
  const segment = runtimeSessionSegment(session);
  return segment
    ? join(planApprovalRuntimeDir(projectDir), `legacy-offer-${segment}.json`)
    : "";
}

function planApprovalLegacyRecoveryChallengePath(
  projectDir: string,
  session: string,
): string {
  const segment = runtimeSessionSegment(session);
  return segment
    ? join(
      planApprovalRuntimeDir(projectDir),
      `legacy-recovery-${segment}.json`,
    )
    : "";
}

function planApprovalLegacyRecoveryResponsePath(
  projectDir: string,
  session: string,
): string {
  const segment = runtimeSessionSegment(session);
  return segment
    ? join(
      planApprovalRuntimeDir(projectDir),
      `legacy-recovery-response-${segment}.json`,
    )
    : "";
}

function ensurePlanApprovalRuntimeDir(projectDir: string): string {
  const dir = planApprovalRuntimeDir(projectDir);
  assertNoSymlinkInChainOrThrow(projectDir, relative(projectDir, dir));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function readPlanApprovalRuntimeJson<T>(path: string, what: string): T | null {
  if (!path) return null;
  try {
    return JSON.parse(
      readAtomicReplacedFileNoFollowOrThrow(path, what).toString("utf-8"),
    ) as T;
  } catch {
    return null;
  }
}

export function resetPlanApprovalRuntime(projectDir: string): void {
  try {
    const dir = planApprovalRuntimeDir(projectDir);
    assertNoSymlinkInChainOrThrow(projectDir, relative(projectDir, dir));
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A stale or redirected authority store is equivalent to no authority.
  }
}

export function writePlanApprovalChallenge(
  projectDir: string,
  challenge: PlanApprovalRuntimeChallenge,
): void {
  ensurePlanApprovalRuntimeDir(projectDir);
  const path = planApprovalChallengePath(projectDir, challenge.session);
  if (!path) throw new Error("Plan Approval challenge requires a nonblank session");
  writeFileAtomic(path, `${JSON.stringify(challenge, null, 2)}\n`);
  try {
    unlinkSync(planApprovalResponsePath(projectDir, challenge.session));
  } catch {
    // A prior response is optional and one-shot.
  }
}

export function readPlanApprovalChallenge(
  projectDir: string,
  session: string,
): PlanApprovalRuntimeChallenge | null {
  const value = readPlanApprovalRuntimeJson<PlanApprovalRuntimeChallenge>(
    planApprovalChallengePath(projectDir, session),
    "Plan Approval challenge",
  );
  return value?.version === 1 && value.session === session ? value : null;
}

export function writePlanApprovalResponse(
  projectDir: string,
  response: PlanApprovalRuntimeResponse,
): void {
  ensurePlanApprovalRuntimeDir(projectDir);
  const path = planApprovalResponsePath(projectDir, response.session);
  if (!path) throw new Error("Plan Approval response requires a nonblank session");
  writeFileAtomic(path, `${JSON.stringify(response, null, 2)}\n`);
}

export function readPlanApprovalResponse(
  projectDir: string,
  session: string,
): PlanApprovalRuntimeResponse | null {
  const value = readPlanApprovalRuntimeJson<PlanApprovalRuntimeResponse>(
    planApprovalResponsePath(projectDir, session),
    "Plan Approval response",
  );
  return value?.version === 1 && value.session === session ? value : null;
}

export function clearPlanApprovalChallenge(
  projectDir: string,
  session: string,
): void {
  for (const path of [
    planApprovalChallengePath(projectDir, session),
    planApprovalResponsePath(projectDir, session),
  ]) {
    if (!path) continue;
    try {
      unlinkSync(path);
    } catch {
      // Missing runtime state is already clear.
    }
  }
}

export function writePlanApprovalReceipt(
  projectDir: string,
  receipt: PlanApprovalRuntimeReceipt,
): void {
  ensurePlanApprovalRuntimeDir(projectDir);
  writeFileAtomic(
    planApprovalReceiptPath(projectDir, receipt),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

export function readPlanApprovalReceipt(
  projectDir: string,
  identity: Pick<PlanApprovalRuntimeIdentity, "targetId" | "directiveEpoch">,
): PlanApprovalRuntimeReceipt | null {
  const value = readPlanApprovalRuntimeJson<PlanApprovalRuntimeReceipt>(
    planApprovalReceiptPath(projectDir, identity),
    "Plan Approval receipt",
  );
  return value?.version === 1 ? value : null;
}

export function clearPlanApprovalReceipt(
  projectDir: string,
  identity: Pick<PlanApprovalRuntimeIdentity, "targetId" | "directiveEpoch">,
): void {
  try {
    unlinkSync(planApprovalReceiptPath(projectDir, identity));
  } catch {
    // Missing runtime authority is already clear.
  }
}

export function planApprovalRuntimeHasReceiptForMarker(
  projectDir: string,
  marker: Pick<
    ActiveDirectiveMarker,
    | "revision"
    | "active_attempt"
    | "code_generation_source_sha256"
    | "code_generation_authority_revision"
  >,
): boolean {
  const revision =
    marker.code_generation_authority_revision ??
    marker.active_attempt?.result_revision ??
    marker.revision;
  const sourceFloor = marker.code_generation_source_sha256;
  if (!Number.isInteger(revision) || !sourceFloor) return false;
  let names: string[];
  try {
    names = readdirSync(planApprovalRuntimeDir(projectDir))
      .filter((name) => name.startsWith("receipt-") && name.endsWith(".json"));
  } catch {
    return false;
  }
  return names.some((name) => {
    const receipt = readPlanApprovalRuntimeJson<PlanApprovalRuntimeReceipt>(
      join(planApprovalRuntimeDir(projectDir), name),
      "Plan Approval receipt",
    );
    return (
      receipt?.version === 1 &&
      receipt.markerRevision === revision &&
      receipt.sourceFloor === sourceFloor &&
      receipt.status === "generation"
    );
  });
}

export function writePlanApprovalViolation(
  projectDir: string,
  violation: PlanApprovalRuntimeViolation,
): void {
  ensurePlanApprovalRuntimeDir(projectDir);
  writeFileAtomic(
    planApprovalViolationPath(projectDir),
    `${JSON.stringify(violation, null, 2)}\n`,
  );
}

export function readPlanApprovalViolation(
  projectDir: string,
): PlanApprovalRuntimeViolation | null {
  const value = readPlanApprovalRuntimeJson<PlanApprovalRuntimeViolation>(
    planApprovalViolationPath(projectDir),
    "Plan Approval violation",
  );
  return value?.version === 1 &&
    Number.isInteger(value.markerRevision) &&
    value.markerRevision >= 0 &&
    typeof value.reason === "string" &&
    value.reason.trim().length > 0 &&
    typeof value.target === "string" &&
    (
      isAbsolute(value.target) ||
      value.target === "(unresolved write target)"
    )
    ? value
    : null;
}

export function clearPlanApprovalViolation(projectDir: string): void {
  try {
    unlinkSync(planApprovalViolationPath(projectDir));
  } catch {
    // Missing violation authority is already clear.
  }
}

export function writePlanApprovalLegacyWindow(
  projectDir: string,
  window: PlanApprovalLegacyWindow,
): void {
  ensurePlanApprovalRuntimeDir(projectDir);
  const path = planApprovalLegacyWindowPath(projectDir, window.session);
  if (!path) throw new Error("legacy Plan Approval write window requires a session");
  writeFileAtomic(
    path,
    `${JSON.stringify(window, null, 2)}\n`,
  );
}

export function readPlanApprovalLegacyWindow(
  projectDir: string,
  session: string,
): PlanApprovalLegacyWindow | null {
  const value = readPlanApprovalRuntimeJson<PlanApprovalLegacyWindow>(
    planApprovalLegacyWindowPath(projectDir, session),
    "legacy Plan Approval write window",
  );
  return value?.version === 1 && value.session === session ? value : null;
}

export function readPlanApprovalLegacyWindows(
  projectDir: string,
): PlanApprovalLegacyWindow[] {
  try {
    return readdirSync(planApprovalRuntimeDir(projectDir))
      .filter((name) => name.startsWith("legacy-window-") && name.endsWith(".json"))
      .map((name) =>
        readPlanApprovalRuntimeJson<PlanApprovalLegacyWindow>(
          join(planApprovalRuntimeDir(projectDir), name),
          "legacy Plan Approval write window",
        )
      )
      .filter((value): value is PlanApprovalLegacyWindow =>
        value?.version === 1 && Boolean(value.session)
      );
  } catch {
    return [];
  }
}

export function clearPlanApprovalLegacyWindow(projectDir: string, session: string): void {
  const path = planApprovalLegacyWindowPath(projectDir, session);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // Missing window is already clear.
  }
}

export function writePlanApprovalLegacyOffer(
  projectDir: string,
  offer: PlanApprovalLegacyOffer,
): void {
  ensurePlanApprovalRuntimeDir(projectDir);
  const path = planApprovalLegacyOfferPath(projectDir, offer.session);
  if (!path) throw new Error("legacy Plan Approval offer requires a nonblank session");
  writeFileAtomic(path, `${JSON.stringify(offer, null, 2)}\n`);
}

export function readPlanApprovalLegacyOffer(
  projectDir: string,
  session: string,
): PlanApprovalLegacyOffer | null {
  const value = readPlanApprovalRuntimeJson<PlanApprovalLegacyOffer>(
    planApprovalLegacyOfferPath(projectDir, session),
    "legacy Plan Approval directive offer",
  );
  return value?.version === 1 && value.session === session ? value : null;
}

export function clearPlanApprovalLegacyOffer(
  projectDir: string,
  session: string,
): void {
  const path = planApprovalLegacyOfferPath(projectDir, session);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // Missing offer is already clear.
  }
}

export function writePlanApprovalLegacyRecoveryChallenge(
  projectDir: string,
  challenge: PlanApprovalLegacyRecoveryChallenge,
): void {
  ensurePlanApprovalRuntimeDir(projectDir);
  const path = planApprovalLegacyRecoveryChallengePath(
    projectDir,
    challenge.session,
  );
  if (!path) {
    throw new Error("legacy Plan Approval recovery requires a nonblank session");
  }
  writeFileAtomic(path, `${JSON.stringify(challenge, null, 2)}\n`);
  try {
    unlinkSync(
      planApprovalLegacyRecoveryResponsePath(projectDir, challenge.session),
    );
  } catch {
    // A prior recovery response is optional and one-shot.
  }
}

export function readPlanApprovalLegacyRecoveryChallenge(
  projectDir: string,
  session: string,
): PlanApprovalLegacyRecoveryChallenge | null {
  const value = readPlanApprovalRuntimeJson<PlanApprovalLegacyRecoveryChallenge>(
    planApprovalLegacyRecoveryChallengePath(projectDir, session),
    "legacy Plan Approval recovery challenge",
  );
  return value?.version === 1 && value.session === session ? value : null;
}

export function writePlanApprovalLegacyRecoveryResponse(
  projectDir: string,
  response: PlanApprovalLegacyRecoveryResponse,
): void {
  ensurePlanApprovalRuntimeDir(projectDir);
  const path = planApprovalLegacyRecoveryResponsePath(
    projectDir,
    response.session,
  );
  if (!path) {
    throw new Error("legacy Plan Approval recovery response requires a session");
  }
  writeFileAtomic(path, `${JSON.stringify(response, null, 2)}\n`);
}

export function readPlanApprovalLegacyRecoveryResponse(
  projectDir: string,
  session: string,
): PlanApprovalLegacyRecoveryResponse | null {
  const value = readPlanApprovalRuntimeJson<PlanApprovalLegacyRecoveryResponse>(
    planApprovalLegacyRecoveryResponsePath(projectDir, session),
    "legacy Plan Approval recovery response",
  );
  return value?.version === 1 && value.session === session ? value : null;
}

export function clearPlanApprovalLegacyRecovery(
  projectDir: string,
  session: string,
): void {
  for (const path of [
    planApprovalLegacyRecoveryChallengePath(projectDir, session),
    planApprovalLegacyRecoveryResponsePath(projectDir, session),
  ]) {
    if (!path) continue;
    try {
      unlinkSync(path);
    } catch {
      // Missing recovery authority is already clear.
    }
  }
}

export function kiroIdeLegacyPlanApprovalSessionId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const ipc = env.VSCODE_IPC_HOOK?.trim() ?? "";
  const pid = env.VSCODE_PID?.trim() ?? "";
  if (!ipc && !pid) return null;
  return `kiro-ide-legacy-${
    createHash("sha256")
      .update(`${ipc}\n${pid}`, "utf-8")
      .digest("hex")
      .slice(0, 24)
  }`;
}

function kiroIdeLegacyPlanApprovalHostPath(
  projectDir: string,
  session: string,
): string {
  const segment = runtimeSessionSegment(session);
  return segment
    ? join(
      sessionsDir(projectDir),
      `.kiro-ide-legacy-plan-approval-${segment}.json`,
    )
    : "";
}

export function markKiroIdeLegacyPlanApprovalHost(
  projectDir: string,
  session: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!session.trim()) {
    throw new Error("legacy Kiro IDE host marker requires a nonblank session");
  }
  const dir = sessionsDir(projectDir);
  assertNoSymlinkInChainOrThrow(projectDir, relative(projectDir, dir));
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(
    kiroIdeLegacyPlanApprovalHostPath(projectDir, session),
    `${JSON.stringify({
      version: 1,
      session,
      pid: env.VSCODE_PID?.trim() ?? "",
      ipc: env.VSCODE_IPC_HOOK?.trim() ?? "",
    }, null, 2)}\n`,
  );
}

export function readKiroIdeLegacyPlanApprovalHost(
  projectDir: string,
  session: string,
): KiroIdeLegacyPlanApprovalHost | null {
  const path = kiroIdeLegacyPlanApprovalHostPath(projectDir, session);
  if (!path) return null;
  const value = readPlanApprovalRuntimeJson<KiroIdeLegacyPlanApprovalHost>(
    path,
    "legacy Kiro IDE host marker",
  );
  return value?.version === 1 &&
      value.session === session &&
      typeof value.pid === "string" &&
      typeof value.ipc === "string"
    ? value
    : null;
}

export function clearKiroIdeLegacyPlanApprovalHost(
  projectDir: string,
  session: string,
): void {
  const path = kiroIdeLegacyPlanApprovalHostPath(projectDir, session);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // Missing legacy host marker is already clear.
  }
}

// The per-session record file: `aidlc/.aidlc-sessions/<session-id>`. The
// session id is normalised to the slug shape so a host-supplied id can never
// escape the sessions dir (path traversal / separators); an empty id yields "".
function sessionRecordPath(projectDir: string, sessionId: string): string {
  const valid = validSessionId(sessionId);
  if (!valid) return "";
  return join(sessionsDir(projectDir), valid);
}

export interface SessionBinding {
  space: string;
  intent: string | null;
  boundAt: string;
}

function sessionBindingPath(projectDir: string, sessionId: string): string {
  const recordPath = sessionRecordPath(projectDir, sessionId);
  return recordPath ? `${recordPath}.binding.json` : "";
}

function safeIntentRecordName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..";
}

// Read a session's pinned workflow selection. Malformed, unsafe, or stale
// records degrade to no binding so cursor behavior remains the fallback.
export function readSessionBinding(projectDir: string, sessionId: string): SessionBinding | null {
  const path = sessionBindingPath(projectDir, sessionId);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<SessionBinding>;
    if (
      typeof candidate.space !== "string" ||
      !SPACE_NAME_REGEX.test(candidate.space) ||
      (candidate.intent !== null &&
        (typeof candidate.intent !== "string" || !safeIntentRecordName(candidate.intent))) ||
      typeof candidate.boundAt !== "string" ||
      candidate.boundAt.length === 0
    ) {
      return null;
    }
    if (
      candidate.intent !== null &&
      !existsSync(join(intentsDir(projectDir, candidate.space), candidate.intent, "aidlc-state.md"))
    ) {
      return null;
    }
    return candidate as SessionBinding;
  } catch {
    return null;
  }
}

// Pin a session to one space and optional intent record. This is machine-local
// runtime state, so any write failure silently falls back to shared cursors.
export function writeSessionBinding(
  projectDir: string,
  sessionId: string,
  space: string,
  intent: string | null,
): void {
  const path = sessionBindingPath(projectDir, sessionId);
  if (
    !path ||
    !SPACE_NAME_REGEX.test(space) ||
    (intent !== null && !safeIntentRecordName(intent))
  ) {
    return;
  }
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
    const binding: SessionBinding = { space, intent, boundAt: isoTimestamp() };
    writeFileSync(path, `${JSON.stringify(binding)}\n`, "utf-8");
  } catch {
    /* per-user runtime state; best-effort */
  }
}

function sessionRebindOfferPath(projectDir: string, sessionId: string): string {
  const recordPath = sessionRecordPath(projectDir, sessionId);
  return recordPath ? `${recordPath}.rebind-offer` : "";
}

export function readSessionRebindOffer(
  projectDir: string,
  sessionId: string,
): string | null {
  const path = sessionRebindOfferPath(projectDir, sessionId);
  if (!path) return null;
  try {
    return readFileSync(path, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export function writeSessionRebindOffer(
  projectDir: string,
  sessionId: string,
  signature: string,
): void {
  const path = sessionRebindOfferPath(projectDir, sessionId);
  if (!path || !signature) return;
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
    writeFileSync(path, `${signature}\n`, "utf-8");
  } catch {
    /* per-user runtime state; best-effort */
  }
}

export function clearSessionRebindOffer(
  projectDir: string,
  sessionId: string,
): void {
  const path = sessionRebindOfferPath(projectDir, sessionId);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    /* absent runtime receipt */
  }
}

interface SessionPidEntry {
  sessionId: string;
  startTime: string | null;
}

interface ProcessIdentity {
  ppid: number;
  startTime: string | null;
}

const SESSION_ANCESTRY_BUDGET_MS = 50;
const SESSION_ANCESTRY_MAX_DEPTH = 64;
const SESSION_ANCESTRY_CACHE_MS = 1000;
const sessionAncestryCache = new Map<
  string,
  { sessionId: string | null; expiresAt: number }
>();

function sessionProcessPlatform(): NodeJS.Platform {
  const testPlatform = process.env.AIDLC_TEST_SESSION_PLATFORM;
  if (
    testPlatform === "linux" ||
    testPlatform === "darwin" ||
    testPlatform === "win32"
  ) {
    return testPlatform;
  }
  return process.platform;
}

export function sessionPidMapDir(projectDir: string): string {
  return join(sessionsDir(projectDir), "pids");
}

function sessionPidEntryPath(projectDir: string, pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 1) return "";
  return join(sessionPidMapDir(projectDir), String(pid));
}

function linuxProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    const startTime = fields[19] ?? "";
    if (!Number.isSafeInteger(ppid) || ppid < 0 || startTime.length === 0) return null;
    return { ppid, startTime };
  } catch {
    return null;
  }
}

function macProcessIdentity(pid: number, deadlineMs: number): ProcessIdentity | null {
  if (process.env.AIDLC_TEST_PS_DENIED === "1") return null;
  const timeout = Math.max(1, deadlineMs - Date.now());
  if (timeout <= 1) return null;
  try {
    const result = spawnSync("ps", ["-o", "ppid=,lstart=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout,
    });
    if (result.status !== 0) return null;
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(result.stdout ?? "");
    if (!match) return null;
    const ppid = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(ppid) ? { ppid, startTime: match[2] } : null;
  } catch {
    return null;
  }
}

function processIdentity(pid: number, deadlineMs: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 1 || Date.now() >= deadlineMs) return null;
  const platform = sessionProcessPlatform();
  if (platform === "linux") return linuxProcessIdentity(pid);
  if (platform === "darwin") return macProcessIdentity(pid, deadlineMs);
  // Windows process ancestry is optional in this increment. Returning null
  // preserves cursor behavior without paying for a PowerShell process.
  return null;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readSessionPidEntry(projectDir: string, pid: number): SessionPidEntry | null {
  const path = sessionPidEntryPath(projectDir, pid);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<SessionPidEntry>;
    if (
      typeof candidate.sessionId !== "string" ||
      validSessionId(candidate.sessionId) === null ||
      (candidate.startTime !== null && typeof candidate.startTime !== "string")
    ) {
      return null;
    }
    return candidate as SessionPidEntry;
  } catch {
    return null;
  }
}

// Write one PID ownership record. Exported for deterministic ancestry tests;
// production callers normally use writeSessionPidAncestry().
export function writeSessionPidEntry(
  projectDir: string,
  pid: number,
  sessionId: string,
  deadlineMs: number = Date.now() + SESSION_ANCESTRY_BUDGET_MS,
): void {
  sessionAncestryCache.delete(projectDir);
  const path = sessionPidEntryPath(projectDir, pid);
  if (
    Date.now() >= deadlineMs ||
    !path ||
    validSessionId(sessionId) === null ||
    !processIsAlive(pid)
  ) {
    return;
  }
  const identity = processIdentity(pid, deadlineMs);
  try {
    mkdirSync(sessionPidMapDir(projectDir), { recursive: true });
    const entry: SessionPidEntry = {
      sessionId,
      startTime: identity?.startTime ?? null,
    };
    writeFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    /* per-user runtime state; best-effort */
  }
}

function gcSessionPidEntries(projectDir: string, deadlineMs: number): void {
  let names: string[];
  try {
    names = readdirSync(sessionPidMapDir(projectDir));
  } catch {
    return;
  }
  for (const name of names) {
    if (Date.now() >= deadlineMs || !/^\d+$/.test(name)) continue;
    const pid = Number.parseInt(name, 10);
    const entry = readSessionPidEntry(projectDir, pid);
    const identity = processIdentity(pid, deadlineMs);
    const stale =
      !entry ||
      !processIsAlive(pid) ||
      (entry.startTime !== null &&
        (identity?.startTime === null ||
          identity?.startTime === undefined ||
          identity.startTime !== entry.startTime));
    if (!stale) continue;
    try {
      unlinkSync(join(sessionPidMapDir(projectDir), name));
    } catch {
      /* raced with another hook or cleanup */
    }
  }
}

// Map the harness process and each ancestor to the current session. The hook
// process itself is intentionally excluded because later tool subprocesses are
// siblings, not descendants, of that short-lived hook.
export function writeSessionPidAncestry(projectDir: string, sessionId: string): void {
  sessionAncestryCache.delete(projectDir);
  if (validSessionId(sessionId) === null || sessionProcessPlatform() === "win32") return;
  const deadline = Date.now() + SESSION_ANCESTRY_BUDGET_MS;
  gcSessionPidEntries(projectDir, deadline);
  const seen = new Set<number>();
  let pid = process.ppid;
  for (let depth = 0; depth < SESSION_ANCESTRY_MAX_DEPTH; depth++) {
    if (pid <= 1 || seen.has(pid) || Date.now() >= deadline) break;
    seen.add(pid);
    const identity = processIdentity(pid, deadline);
    if (!identity) break;
    writeSessionPidEntry(projectDir, pid, sessionId, deadline);
    pid = identity.ppid;
  }
}

// Resolve the nearest mapped ancestor of the calling process. Every failure is
// a silent miss so tools retain cursor behavior when process metadata is absent.
export function resolveSessionIdFromAncestry(projectDir: string): string | null {
  const cached = sessionAncestryCache.get(projectDir);
  if (cached && cached.expiresAt > Date.now()) return cached.sessionId;
  const resolved = resolveSessionIdFromAncestryUncached(projectDir);
  if (resolved === null) {
    sessionAncestryCache.set(projectDir, {
      sessionId: null,
      expiresAt: Date.now() + SESSION_ANCESTRY_CACHE_MS,
    });
  } else {
    sessionAncestryCache.delete(projectDir);
  }
  return resolved;
}

// Build a hook-spawned child's environment from authoritative payload identity.
// A valid divergent payload carries a private source marker so the selection
// chokepoint can let payload identity win without weakening bare env refusal.
export function hookChildEnv(
  projectDir: string,
  payloadSessionId: string | undefined,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...extra,
  };
  const payloadSession = validSessionId(payloadSessionId);
  if (!payloadSession) return env;
  env.AIDLC_SESSION_OVERRIDE = payloadSession;
  const ancestrySession = resolveSessionIdFromAncestry(projectDir);
  if (ancestrySession !== null && ancestrySession !== payloadSession) {
    env.AIDLC_SESSION_OVERRIDE_SOURCE = "payload";
  } else {
    delete env.AIDLC_SESSION_OVERRIDE_SOURCE;
  }
  return env;
}

function resolveSessionIdFromAncestryUncached(projectDir: string): string | null {
  if (sessionProcessPlatform() === "win32") return null;
  if (!existsSync(sessionPidMapDir(projectDir))) return null;
  const deadline = Date.now() + SESSION_ANCESTRY_BUDGET_MS;
  const seen = new Set<number>();
  let pid = process.ppid;
  for (let depth = 0; depth < SESSION_ANCESTRY_MAX_DEPTH; depth++) {
    if (pid <= 1 || seen.has(pid) || Date.now() >= deadline) return null;
    seen.add(pid);
    const identity = processIdentity(pid, deadline);
    if (!identity || !processIsAlive(pid)) return null;
    const entry = readSessionPidEntry(projectDir, pid);
    if (
      entry &&
      (entry.startTime === null || entry.startTime === identity.startTime)
    ) {
      return entry.sessionId;
    }
    pid = identity.ppid;
  }
  return null;
}

export interface WorkflowSelection {
  space: string;
  intent: string | null;
  sessionId: string | null;
  binding: SessionBinding | null;
}

export interface WorkflowSelectionOptions {
  space?: string;
  intent?: string;
  sessionId?: string;
}

// Resolve one stable workflow target for an operation. Explicit selectors win,
// then the session binding, then the legacy cursor and lone-intent rules.
export function resolveWorkflowSelection(
  projectDir: string,
  options: WorkflowSelectionOptions = {},
): WorkflowSelection {
  const explicitSession = validSessionId(options.sessionId);
  let sessionId: string | null;
  if (explicitSession) {
    sessionId = explicitSession;
  } else {
    const envSession = validSessionId(process.env.AIDLC_SESSION_OVERRIDE);
    // This refusal is a footgun guard against stale exported overrides, not a
    // security boundary. The SOURCE marker is an internal hookChildEnv contract.
    // Deliberately setting both variables is an intentional same-user act
    // equivalent to a sanctioned session switch; no privilege boundary exists
    // between callers that could authenticate it.
    const payloadOverride =
      envSession !== null &&
      process.env.AIDLC_SESSION_OVERRIDE_SOURCE === "payload";
    const ancestrySession = resolveSessionIdFromAncestry(projectDir);
    if (
      envSession &&
      ancestrySession &&
      envSession !== ancestrySession &&
      !payloadOverride
    ) {
      throw new SessionResolutionConflictError(envSession, ancestrySession);
    }
    sessionId = envSession ?? ancestrySession;
  }
  const binding = sessionId ? readSessionBinding(projectDir, sessionId) : null;
  const space = options.space ?? binding?.space ?? activeSpace(projectDir);
  let intent: string | null;
  if (options.intent !== undefined) {
    intent = options.intent;
  } else if (binding && binding.space === space) {
    intent = binding.intent;
  } else {
    intent = activeIntent(projectDir, space);
  }
  return { space, intent, sessionId, binding };
}

export function stateFilePathForSelection(
  projectDir: string,
  selection: WorkflowSelection,
): string {
  const root =
    selection.intent === null
      ? intentsDir(projectDir, selection.space)
      : join(intentsDir(projectDir, selection.space), selection.intent);
  return join(root, "aidlc-state.md");
}

export function relativeRecordDirForSelection(selection: WorkflowSelection): string | null {
  if (selection.intent === null) return null;
  return `aidlc/spaces/${selection.space}/intents/${selection.intent}`;
}

export function intentUuidForSelection(
  projectDir: string,
  selection: WorkflowSelection,
): string | null {
  if (selection.intent === null) return null;
  return (
    listIntents(projectDir, selection.space).find(
      (entry) => entry.dirName === selection.intent,
    )?.uuid ?? null
  );
}

// Read the intent UUID this conversation last stamped, or null. Best-effort.
export function readSessionIntentUuid(projectDir: string, sessionId: string): string | null {
  const path = sessionRecordPath(projectDir, sessionId);
  if (!path) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

// Stamp the intent UUID this conversation is working into its session record.
// Best-effort (per-user runtime state; a write failure degrades to "no offer on
// the next resume", never breaks the hook). A blank uuid clears nothing — the
// caller only stamps when an intent actually resolves.
export function writeSessionIntentUuid(projectDir: string, sessionId: string, uuid: string): void {
  const path = sessionRecordPath(projectDir, sessionId);
  if (!path || !uuid) return;
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
    writeFileSync(path, `${uuid}\n`, "utf-8");
  } catch {
    /* per-user runtime state; best-effort */
  }
}

// Clear a conversation's intent stamp when it deliberately continues on a
// UUID-less legacy/orphan record. Without this, the old UUID keeps winning
// usage ownership even though the live cursor no longer resolves to that
// workflow.
export function clearSessionIntentUuid(projectDir: string, sessionId: string): void {
  const path = sessionRecordPath(projectDir, sessionId);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    /* absent/unwritable per-user runtime state; best-effort */
  }
}

export const SESSION_INTENT_HANDOFF_TTL_MS = 5 * 60 * 1000;

export interface SessionIntentHandoff {
  fromIntentUuid: string;
  toIntentUuid: string;
  issuedAtMs: number;
}

function sessionIntentHandoffPath(projectDir: string, sessionId: string): string {
  const recordPath = sessionRecordPath(projectDir, sessionId);
  return recordPath ? `${recordPath}.handoff.json` : "";
}

// Record the exact second-intent boundary for the session that created it.
// This receipt is transient and one-shot: the Stop hook validates both UUIDs
// before allowing the old conversation to end, then clears it.
export function writeSessionIntentHandoff(
  projectDir: string,
  sessionId: string,
  fromIntentUuid: string,
  toIntentUuid: string,
): void {
  const path = sessionIntentHandoffPath(projectDir, sessionId);
  if (!path || !fromIntentUuid || !toIntentUuid || fromIntentUuid === toIntentUuid) return;
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        fromIntentUuid,
        toIntentUuid,
        issuedAtMs: Date.now(),
      } satisfies SessionIntentHandoff)}\n`,
      "utf-8",
    );
  } catch {
    /* per-user runtime state; best-effort */
  }
}

export function readSessionIntentHandoff(
  projectDir: string,
  sessionId: string,
): SessionIntentHandoff | null {
  const path = sessionIntentHandoffPath(projectDir, sessionId);
  if (!path) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "fromIntentUuid" in parsed &&
      typeof (parsed as { fromIntentUuid?: unknown }).fromIntentUuid === "string" &&
      "toIntentUuid" in parsed &&
      typeof (parsed as { toIntentUuid?: unknown }).toIntentUuid === "string" &&
      "issuedAtMs" in parsed &&
      typeof (parsed as { issuedAtMs?: unknown }).issuedAtMs === "number"
    ) {
      const handoff = parsed as SessionIntentHandoff;
      if (
        handoff.fromIntentUuid.length > 0 &&
        handoff.toIntentUuid.length > 0 &&
        handoff.fromIntentUuid !== handoff.toIntentUuid &&
        Number.isFinite(handoff.issuedAtMs)
      ) {
        return handoff;
      }
    }
  } catch {
    // Missing or malformed runtime receipt.
  }
  return null;
}

export function clearSessionIntentHandoff(projectDir: string, sessionId: string): void {
  const path = sessionIntentHandoffPath(projectDir, sessionId);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    /* absent/unwritable per-user runtime state; best-effort */
  }
}

// The "current session" marker: a FIXED-name file inside the sessions dir naming
// the most-recently-active session id. The per-session STAMP above is keyed by
// session_id (which only the hook sees); a CLI tool like `/aidlc intent <slug>`
// has no session_id, so it cannot re-stamp the live session's record on its own.
// This marker is the bridge: the hook writes it on EVERY fire (so it always names
// the live conversation), and the switch tool reads it to learn which session to
// re-stamp. Lives beside the per-session records under `aidlc/.aidlc-sessions/`
// (gitignored — dot-gitignore `aidlc/.aidlc-sessions/`): per-user runtime state.
export const CURRENT_SESSION_FILE = ".current-session";

function currentSessionPath(projectDir: string): string {
  return join(sessionsDir(projectDir), CURRENT_SESSION_FILE);
}

// Read the most-recently-active session id, or null. Best-effort.
export function readCurrentSessionId(projectDir: string): string | null {
  try {
    const raw = readFileSync(currentSessionPath(projectDir), "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

// Record the most-recently-active session id. Best-effort; no-op on a blank id
// (a TTY/empty hook invocation has no session to record).
export function writeCurrentSessionId(projectDir: string, sessionId: string): void {
  if (validSessionId(sessionId) === null) return;
  try {
    mkdirSync(sessionsDir(projectDir), { recursive: true });
    writeFileSync(currentSessionPath(projectDir), `${sessionId}\n`, "utf-8");
  } catch {
    /* per-user runtime state; best-effort */
  }
}

// The UUID of the active intent in a space (the cursor's / lone intent's
// registry row), or null when no new-layout intent resolves (flat-legacy) or
// the active record has no registry row (an orphan — no stable uuid to stamp).
export function activeIntentUuid(projectDir: string, space?: string): string | null {
  const sp = space ?? activeSpace(projectDir);
  const activeDir = activeIntent(projectDir, sp);
  if (activeDir === null) return null;
  const match = listIntents(projectDir, sp).find((i) => i.dirName === activeDir);
  return match?.uuid ? match.uuid : null;
}

// Resolve an intent UUID to its record across EVERY space (a conversation may
// have been working an intent in a different space than the active one).
// Returns the logical slug plus the exact on-disk record dir. The latter is
// required by explicit path/audit selectors: modern record dirs are date-
// prefixed and cannot be reconstructed from the slug alone.
export function findIntentByUuid(
  projectDir: string,
  uuid: string,
): { space: string; slug: string; dirName: string } | null {
  if (!uuid) return null;
  for (const sp of listSpaces(projectDir)) {
    const intent = listIntents(projectDir, sp.name).find(
      (entry) => entry.uuid === uuid && entry.dirName !== null,
    );
    if (intent?.dirName) {
      return { space: sp.name, slug: intent.slug, dirName: intent.dirName };
    }
  }
  return null;
}

// --- Intent creation: the deterministic mutation behind the engine's directive ---
//
// createIntent() is the single deterministic primitive the `intent-create` tool
// handler calls: mint a UUIDv7, create the record dir, append the registry row,
// set the active-intent cursor. It does NOT emit audit events or write the
// aidlc-state.md body (the handler owns those, since they need the scope graph)
// — it owns only the identity + dir + registry + cursor, the parts that must be
// crash-safe and clash-free. The CALLER MUST already hold the WORKSPACE lock
// (invariant 2: every intents.json mutation takes the workspace bucket); a
// concurrent creation is serialized by that lock, so the within-space dir-clash
// disambiguation here only ever resolves a same-uuid id8 collision, never a
// cross-process race.
export interface CreatedIntent {
  uuid: string;
  slug: string;
  dirName: string;
  recordDir: string;
  space: string;
}

export function createIntent(
  projectDir: string,
  label: string,
  space: string,
  scope?: string,
  repos?: string[],
  sessionId?: string,
): CreatedIntent {
  const uuid = uuidv7();
  const intentsRoot = intentsDir(projectDir, space);
  // SPIKE (date-prefix): the dir name is `<YYMMDD>-<short-label>`, the `label` arg
  // being the orchestrator's 2-3 word essence. Normalize it ONCE to the slug shape
  // so the stored row `slug`, the dir-name label, and the display all agree even
  // when the caller passes raw text (cap 24). A same-day same-label clash resolves
  // by a numeric counter (never re-mints).
  const slug = slugify(label, 24);
  if (RESERVED_RECORD_NAMES.has(slug)) {
    throw new Error(
      `"${slug}" is a reserved name and cannot be an intent label. Pick a label that describes the work.`
    );
  }
  const dirName = resolveUniqueIntentDir(intentsRoot, `${dateStamp()}-${slug}`);
  const recordPath = join(intentsRoot, dirName);
  mkdirSync(recordPath, { recursive: true });
  // BIND the record so the resolvers recognize it immediately: activeIntent()
  // only treats a record dir as real once it holds an aidlc-state.md (the cursor
  // + lone-intent checks both gate on existsSync(<dir>/aidlc-state.md)). createIntent()
  // creates the dir, but the full state body is written AFTER creation by the
  // caller (handleIntentCreate, via the default-resolving writeStateFile). Write
  // a header-only stub here so the cursor resolves to THIS record between mint
  // and the full write — without it, activeIntent() returns null and the
  // post-creation state/audit writes leak to the flat fallback (a bootstrap gap).
  const statePath = join(recordPath, "aidlc-state.md");
  if (!existsSync(statePath)) {
    writeFileSync(statePath, "# AI-DLC State Tracking\n", "utf-8");
  }
  appendIntentToRegistry(
    projectDir,
    // An empty repo set (no --repos, no sibling discovery — the legacy single-repo
    // or fresh-greenfield case) records NO repos row; the lone repo is inferred on
    // the construction path (resolveConstructionRepo). Only a non-empty set is
    // persisted, so existing single-repo + flat-legacy intents stay byte-identical.
    { uuid, slug, dirName, scope, repos: repos && repos.length > 0 ? repos : undefined, status: "in-flight" },
    space,
  );
  setActiveIntentCursor(projectDir, dirName, space);
  const creatingSession =
    validSessionId(sessionId) ??
    resolveSessionIdFromAncestry(projectDir);
  if (creatingSession) {
    writeSessionBinding(projectDir, creatingSession, space, dirName);
  }
  return { uuid, slug, dirName, recordDir: recordPath, space };
}

// Flip an intent's registry row to a terminal/other status (e.g. "complete").
// Matches the row by record DIR NAME (the stable identity the cursor/state use),
// rewriting intents.json in place. MUST be called under the WORKSPACE lock
// (invariant 2). Returns true iff a row matched and was updated. No-op (false)
// when the intent is the legacy flat record (dirName null) or no row matches.
export function updateIntentStatus(
  projectDir: string,
  dirName: string,
  status: string,
  space?: string,
): boolean {
  const sp = space ?? activeSpace(projectDir);
  const path = intentsRegistryPath(projectDir, sp);
  const list = readIntentRegistry(projectDir, sp);
  let changed = false;
  for (const entry of list) {
    // Match the active dirName via the shared join rule listIntents() uses.
    if (!recordDirMatches(entry, dirName)) continue;
    if (entry.status !== status) {
      entry.status = status;
      changed = true;
    }
    break;
  }
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(list, null, 2)}\n`);
  }
  return changed;
}

// Run the flat→per-intent migration if needed. Idempotent. Returns the new
// intent dir name on a migration, or null when none was needed. The caller owns
// the git-rm of the flat tree (a tool can shell out to git; lib stays
// git-agnostic) — migrateFlatLayout returns the moved-from path so the caller
// can untrack it. NEVER rmSync's the source: the staged COPY is renamed into the
// leaf, leaving the original aidlc-docs/ for the git-rm step.
export interface FlatMigrationResult {
  intentDirName: string;
  uuid: string;
  slug: string;
  movedFrom: string; // the flat aidlc-docs/ path, for the caller's git-rm
}

export function migrateFlatLayout(projectDir: string): FlatMigrationResult | null {
  // Whole operation under the WORKSPACE lock bucket (intent omitted → sentinel).
  return withAuditLock(projectDir, () => {
    // Re-check inside the lock (another clone may have migrated while we waited).
    if (!needsFlatMigration(projectDir)) return null;

    const flatRoot = flatMigrationSource(projectDir);
    const flatState = join(flatRoot, "aidlc-state.md");

    // Slug from the existing state's most slug-worthy field, else "default".
    // Prefer an explicit intent/workflow name, then the human project name; the
    // bare scope token (feature/bugfix/…) is the last resort before "default".
    let slug = "default";
    try {
      const content = readFileSync(flatState, "utf-8");
      const name =
        getField(content, "Workflow") ??
        getField(content, "Intent") ??
        getField(content, "Project") ??
        getField(content, "Scope") ??
        "";
      if (name.trim().length > 0) slug = slugify(name);
    } catch {
      // unreadable state → keep "default"
    }

    const uuid = uuidv7();
    const space = DEFAULT_SPACE;
    const intentsRoot = intentsDir(projectDir, space);
    // SPIKE (date-prefix): same `<YYMMDD>-<short-label>` shape as createIntent, with
    // a numeric-counter collision resolve.
    const intentDirName = resolveUniqueIntentDir(intentsRoot, intentDirNameBase(slug));
    const leaf = join(intentsRoot, intentDirName);

    // (1) Stage a COPY of the whole flat tree into a temp dir UNDER the workspace
    // root (same filesystem → the rename in step 3 is atomic, not a cross-device
    // copy+unlink). A unique per-process staging name avoids a concurrent clash.
    const staging = join(workspaceRoot(projectDir), `.migrate-staging-${process.pid}-${reapSuffix()}`);
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* no prior staging */
    }
    cpSync(flatRoot, staging, { recursive: true });

    // ── Shape the staged tree to the target layout BEFORE the atomic rename ──
    // CRASH-SAFETY INVARIANT: the rename in step (3) is the SOLE commit point.
    // Everything below operates on the staging tree (or the idempotent, intent-
    // independent space-knowledge move), so the ONLY "partial" window is steps
    // 1-2b — which produce no `aidlc-state.md` under intents/ and no `.migrated`
    // marker, so needsFlatMigration() stays true and a crash re-fires cleanly
    // (step 1 rmSync's any half-built staging first; the flat source is never
    // mutated). Doing these relocations AFTER the rename would strand them in a
    // window where anyIntentRecordExists() has already flipped the detector off.

    // (2a) RELOCATE the staged `audit.md` into the per-clone SHARD layout the
    // readers glob. The blind copy in step 1 lands the flat `aidlc-docs/audit.md`
    // FILE at `<staging>/audit.md`, but auditShards()/readAllAuditShards() read
    // the `<record>/audit/*.md` DIR (auditShardDir), and the flat-fallback fires
    // ONLY when the record dir is absent — which it never is post-migration. Left
    // as a top-level file, the pre-migration WORKFLOW_STARTED/STAGE/PHASE history
    // would be on disk but INVISIBLE to runtime-graph compile, summary/replay, and
    // every hook. Move it INTO the shard set as `audit/<host>-<clone>.md` so it
    // joins the shards the readers already merge-sort (honours decision #1: a
    // per-clone shard, NOT a single committed audit.md + merge=union). Guard the
    // no-audit case (a flat tree with no audit.md) — skip silently.
    const stagedAudit = join(staging, "audit.md");
    if (existsSync(stagedAudit)) {
      const shardDir = join(staging, "audit");
      mkdirSync(shardDir, { recursive: true });
      renameSync(stagedAudit, join(shardDir, auditShardName(projectDir)));
    }

    // (2b) RELOCATE the staged `knowledge/` tree to the SPACE level. The old flat
    // layout kept team domain knowledge at `aidlc-docs/knowledge/` (the former
    // scaffold stage seeded `knowledge/README.md` + `knowledge/aidlc-shared/`);
    // the blind copy in step 1 lands it at `<staging>/knowledge/`, but the
    // per-intent record is the WRONG home — knowledge is a space-level concern (a
    // sibling of intents) so it compounds across every intent, and the agent
    // personas read it from `spaces/<space>/knowledge/`. Left in the record, a
    // migrating team's accumulated knowledge would be silently invisible to every
    // agent. Move it up to the space dir (merge into any existing space knowledge,
    // entry-by-entry so a pre-existing dir is preserved) and empty it out of the
    // staging tree so the rename carries no `knowledge/` into the record. This is
    // intent-independent and idempotent — safe to re-apply on a crash re-fire; the
    // flat source is untouched, so the caller's gitRmFlatTree(flatRoot) is intact.
    const stagedKnowledge = join(staging, "knowledge");
    if (existsSync(stagedKnowledge)) {
      const spaceKnowledge = knowledgeDir(projectDir, space);
      mkdirSync(spaceKnowledge, { recursive: true });
      for (const entry of readdirSync(stagedKnowledge)) {
        const from = join(stagedKnowledge, entry);
        const to = join(spaceKnowledge, entry);
        if (existsSync(to)) {
          cpSync(from, to, { recursive: true });
        } else {
          renameSync(from, to);
        }
      }
      rmSync(stagedKnowledge, { recursive: true, force: true });
    }

    // (2c) mkdir the intent dir's PARENT chain (the leaf is created by the rename).
    mkdirSync(intentsRoot, { recursive: true });

    // (3) ONE atomic rename of the now-target-shaped staged tree into the leaf —
    // the single commit point (see the crash-safety invariant above).
    renameSync(staging, leaf);

    // (4) Append to intents.json + set the active-intent cursor (workspace bucket).
    appendIntentToRegistry(
      projectDir,
      { uuid, slug, dirName: intentDirName, scope: undefined, repos: undefined, status: "in-flight" },
      space,
    );
    setActiveIntentCursor(projectDir, intentDirName, space);

    // (5) Write the `.migrated` marker LAST (the sole idempotency key).
    mkdirSync(workspaceRoot(projectDir), { recursive: true });
    writeFileSync(migratedMarkerPath(projectDir), `migrated ${isoTimestamp()} → ${intentDirName}\n`, "utf-8");

    return { intentDirName, uuid, slug, movedFrom: flatRoot };
  });
}

// --- Per-intent record resolution (P9 end state — no flat fallback) -----------
//
// Each absolute path helper resolves the per-intent record dir when an intent
// exists (explicit arg, active cursor, or a lone intent), else the bare SPACE
// record root (spaceRecordRoot). There is NO flat `aidlc-docs/` fallback any more
// — the transitional bridge was retired in P9 once the fixtures migrated. The
// only place the legacy flat root is still touched is the one-time migration
// SOURCE (flatStateSource/flatMigrationSource above).

export function stateFilePath(projectDir: string, intent?: string, space?: string): string {
  const resolved = resolveRecordDir(projectDir, intent, space);
  if (resolved.dir === null) {
    return join(
      spaceRecordRoot(projectDir, resolved.space),
      "aidlc-state.md",
    );
  }
  return join(resolved.dir, "aidlc-state.md");
}

// The engine's final validated run-stage is the active execution cursor. Most
// stages match aidlc-state.md's Current Stage, but unit-major Construction can
// interleave later stages while the durable cursor stays on the first block
// stage. Persist that transient fact per intent so path-only PostToolUse hooks
// can attribute diagnostics to the directive the conductor is actually running.
const ACTIVE_DIRECTIVE_MARKER = ".aidlc-active-directive.json";

export type ActiveDirectiveKind =
  | "load-steering" | "run-stage" | "ask" | "print" | "error"
  | "done" | "parked" | "notice" | "dispatch-subagent" | "invoke-swarm" | "present-gate";
export type ResumeAction = "resume" | "redo" | "jump" | "start-fresh";

interface ActiveDirectiveAttempt {
  id?: string; command_kind: "next" | "continue" | "report" | "park";
  command_sha256: string; issued_state_sha256: string; session_id: string;
  owner_epoch: number; context_epoch: number; status: "pending" | "settled" | "failed";
  claim_revision?: number;
  shared_attempt?: boolean;
  cursor_input_sha256?: string; result_sha256?: string; result_revision?: number;
  resume_request?: boolean; resume_action?: ResumeAction;
  resume_gate_revision?: number;
}

interface ActiveDirectiveResume {
  status: "waiting" | "selected" | "superseded"; issuing_stage: string; issuing_state_sha256: string;
  issuing_session: string; issuing_intent_uuid: string | null; action?: ResumeAction;
}

export interface ActiveDirectiveMarker {
  version: 1 | 2; stage: string; unit?: string; state_sha256: string;
  units?: string[];
  revision?: number; project_sha256?: string; intent_uuid?: string | null; state_present?: boolean;
  code_generation_source_sha256?: string;
  code_generation_authority_revision?: number;
  cursor_harness?: string;
  owner_session?: string; owner_epoch?: number; context_epoch?: number; kind?: ActiveDirectiveKind;
  part?: number; parts?: number; continue_token?: string; continue_token_sha256?: string;
  delivery?: "issued" | "delivered" | "consumed" | "superseded"; needs_rehydrate?: boolean;
  active_attempt?: ActiveDirectiveAttempt; resume?: ActiveDirectiveResume;
  event_sequence?: number; human_sequence?: number; engine_sequence?: number; conversation_sequence?: number;
  stop_fingerprint?: string; stop_count?: number;
}

export interface CopilotDirectiveMetadata {
  kind: ActiveDirectiveKind; stage?: string; unit?: string;
  part?: number; parts?: number; continueToken?: string;
  resultSha256?: string;
}

export interface CopilotCommandClaim {
  sessionId: string; attemptId?: string; commandKind: "next" | "continue" | "report" | "park";
  commandSha256: string; continueToken?: string; resumeRequest?: boolean; resumeAction?: ResumeAction;
  jumpRequest?: boolean; startFreshRequest?: boolean; plainNext?: boolean; skipRecovery?: boolean; reportStage?: string;
}

export type CopilotClaimResult = { allowed: true; attemptId: string } |
  { allowed: false; reason: "duplicate" | "foreign" | "state" | "resume" | "recovery" };

export type ActiveDirectiveWriteResult =
  | "copilot-committed"
  | "generic-committed"
  | "legacy-plan-approval-owned"
  | "legacy-plan-approval-recovery-required"
  | "legacy-plan-approval-reissued"
  | "legacy-plan-approval-transport"
  | "preserved"
  | "stale-attempt";

export type CopilotStopEvidence =
  | { status: "foreign" | "resume" | "contended" }
  | { status: "directive" | "recovery"; directive?: CopilotDirectiveMetadata;
      stateSha256: string; tokenSha256: string; resumeStatus: string; resumeAction: string; ownerSession: string; ownerEpoch: number };

const ACTIVE_DIRECTIVE_MAX_BYTES = 64 * 1024;
const ACTIVE_DIRECTIVE_LOCK = ".aidlc-active-directive.lock";

export interface ActiveDirectiveTarget {
  canonicalProjectDir: string; space: string; recordDirName: string | null;
  intentUuid: string | null; statePath: string; markerPath: string; lockDir: string; bucket: string;
}

export class ActiveDirectiveLockContendedError extends Error {
  constructor(message = "Active-directive coordination is busy") {
    super(message);
    this.name = "ActiveDirectiveLockContendedError";
  }
}

function validPlanApprovalLegacyOfferCandidate(
  candidate: PlanApprovalLegacyOfferCandidate | undefined,
): candidate is PlanApprovalLegacyOfferCandidate {
  return Boolean(
    candidate?.session.trim() &&
      candidate.optionHashes.length === 2 &&
      candidate.optionHashes.every((value) => /^[0-9a-f]{64}$/.test(value)),
  );
}

type PlanApprovalLegacyOwner =
  | { status: "none" }
  | { status: "ambiguous" }
  | {
    status: "owned";
    session: string;
    live: boolean;
    offer: PlanApprovalLegacyOffer | null;
    challenge: PlanApprovalRuntimeChallenge | null;
  };

function legacyKiroHostIsLive(
  host: KiroIdeLegacyPlanApprovalHost | null,
): boolean {
  if (!host) return true;
  const pid = Number.parseInt(host.pid, 10);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  return host.ipc.trim() ? existsSync(host.ipc) : true;
}

function planApprovalAuthorityRevision(
  marker: ActiveDirectiveMarker | null,
): number | null {
  return marker?.version === 2
    ? marker.code_generation_authority_revision ??
      marker.active_attempt?.result_revision ??
      marker.revision ??
      null
    : null;
}

function planApprovalLegacyViolationMatches(
  projectDir: string,
  marker: ActiveDirectiveMarker | null,
): boolean {
  const markerRevision = planApprovalAuthorityRevision(marker);
  const violation = readPlanApprovalViolation(projectDir);
  return (
    markerRevision !== null &&
    violation?.version === 1 &&
    violation.markerRevision === markerRevision
  );
}

function planApprovalLegacyWindowMatches(
  projectDir: string,
  marker: ActiveDirectiveMarker | null,
): boolean {
  const markerRevision = planApprovalAuthorityRevision(marker);
  let windows: PlanApprovalLegacyWindow[] = [];
  try {
    windows = readdirSync(planApprovalRuntimeDir(projectDir))
      .filter((name) => name.startsWith("legacy-window-") && name.endsWith(".json"))
      .map((name) =>
        readPlanApprovalRuntimeJson<PlanApprovalLegacyWindow>(
          join(planApprovalRuntimeDir(projectDir), name),
          "legacy Plan Approval write window",
        )
      )
      .filter((value): value is PlanApprovalLegacyWindow =>
        value?.version === 1 && Boolean(value.session)
      );
  } catch {
    return false;
  }
  return windows.some((window) => {
  if (
    marker?.version !== 2 ||
    marker.stage !== "code-generation" ||
    markerRevision === null ||
    window?.version !== 1 ||
    window.markerRevision !== markerRevision
  ) {
    return false;
  }
  if (
    (marker.kind === "invoke-swarm" || marker.kind === "load-steering") &&
    (marker.units?.length ?? 0) > 0
  ) {
    return (
      window.unit !== null &&
      (marker.units ?? []).includes(window.unit)
    );
  }
  return window.unit === (marker.unit?.trim() || null);
  });
}

function clearPlanApprovalLegacyWindowsForMarker(
  projectDir: string,
  marker: ActiveDirectiveMarker | null,
): void {
  const markerRevision = planApprovalAuthorityRevision(marker);
  if (markerRevision === null) return;
  let names: string[];
  try {
    names = readdirSync(planApprovalRuntimeDir(projectDir))
      .filter((name) => name.startsWith("legacy-window-") && name.endsWith(".json"));
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(planApprovalRuntimeDir(projectDir), name);
    const window = readPlanApprovalRuntimeJson<PlanApprovalLegacyWindow>(
      path,
      "legacy Plan Approval write window",
    );
    if (window?.version === 1 && window.markerRevision === markerRevision) {
      try { unlinkSync(path); } catch { /* already clear */ }
    }
  }
}

function findPlanApprovalLegacyOwner(
  projectDir: string,
  intentId: string,
  marker: ActiveDirectiveMarker | null,
): PlanApprovalLegacyOwner {
  const markerRevision = planApprovalAuthorityRevision(marker);
  if (markerRevision === null) return { status: "none" };
  let names: string[];
  try {
    names = readdirSync(planApprovalRuntimeDir(projectDir));
  } catch {
    return { status: "none" };
  }
  const owners = new Map<
    string,
    {
      offer: PlanApprovalLegacyOffer | null;
      challenge: PlanApprovalRuntimeChallenge | null;
    }
  >();
  for (const name of names) {
    if (
      !name.startsWith("legacy-offer-") &&
      !name.startsWith("challenge-")
    ) {
      continue;
    }
    const path = join(planApprovalRuntimeDir(projectDir), name);
    if (name.startsWith("legacy-offer-")) {
      const offer = readPlanApprovalRuntimeJson<PlanApprovalLegacyOffer>(
        path,
        "legacy Plan Approval directive offer",
      );
      if (
        offer?.version !== 1 ||
        offer.intentId !== intentId ||
        offer.markerRevision !== markerRevision ||
        !offer.session
      ) {
        continue;
      }
      const owner = owners.get(offer.session) ?? {
        offer: null,
        challenge: null,
      };
      owner.offer = offer;
      owners.set(offer.session, owner);
      continue;
    }
    const challenge = readPlanApprovalRuntimeJson<PlanApprovalRuntimeChallenge>(
      path,
      "Plan Approval challenge",
    );
    if (
      challenge?.version !== 1 ||
      challenge.intentId !== intentId ||
      challenge.markerRevision !== markerRevision ||
      !challenge.session
    ) {
      continue;
    }
    const owner = owners.get(challenge.session) ?? {
      offer: null,
      challenge: null,
    };
    owner.challenge = challenge;
    owners.set(challenge.session, owner);
  }
  if (owners.size === 0) return { status: "none" };
  if (owners.size !== 1) return { status: "ambiguous" };
  const [session, owner] = [...owners.entries()][0];
  return {
    status: "owned",
    session,
    live: legacyKiroHostIsLive(
      readKiroIdeLegacyPlanApprovalHost(projectDir, session),
    ),
    ...owner,
  };
}

function rotatePlanApprovalLegacyOwner(
  projectDir: string,
  candidate: PlanApprovalLegacyOfferCandidate,
  owner: Extract<PlanApprovalLegacyOwner, { status: "owned" }>,
): void {
  if (owner.challenge) {
    const challenge: PlanApprovalRuntimeChallenge = {
      ...owner.challenge,
      session: candidate.session,
      options: candidate.optionHashes,
      hashedOptionLabels: true,
      challengeId: createHash("sha256")
        .update(JSON.stringify({
          previous: owner.challenge.challengeId,
          session: candidate.session,
          options: candidate.optionHashes,
        }), "utf-8")
        .digest("hex"),
    };
    if (owner.session !== candidate.session) {
      clearPlanApprovalChallenge(projectDir, owner.session);
    }
    writePlanApprovalChallenge(projectDir, challenge);
    return;
  }
  if (!owner.offer) {
    throw new Error("legacy Plan Approval owner has no recoverable authority");
  }
  if (owner.session !== candidate.session) {
    clearPlanApprovalLegacyOffer(projectDir, owner.session);
  }
  writePlanApprovalLegacyOffer(projectDir, {
    ...owner.offer,
    session: candidate.session,
    options: candidate.optionHashes,
  });
}

function legacyPlanApprovalRecoveryChallengeId(
  session: string,
  intentId: string,
  markerRevision: number,
): string {
  return createHash("sha256")
    .update(
      `${session}\n${intentId}\n${markerRevision}\n${LEGACY_PLAN_APPROVAL_RECOVERY_CHOICE}`,
      "utf-8",
    )
    .digest("hex");
}

function planApprovalLegacyRecoverySatisfied(
  projectDir: string,
  session: string,
  intentId: string,
  markerRevision: number,
): boolean {
  const challenge = readPlanApprovalLegacyRecoveryChallenge(
    projectDir,
    session,
  );
  const response = readPlanApprovalLegacyRecoveryResponse(projectDir, session);
  const challengeId = legacyPlanApprovalRecoveryChallengeId(
    session,
    intentId,
    markerRevision,
  );
  return Boolean(
    challenge &&
      response &&
      challenge.intentId === intentId &&
      challenge.markerRevision === markerRevision &&
      challenge.challengeId === challengeId &&
      response.challengeId === challengeId &&
      response.responseSha256 ===
        createHash("sha256")
          .update(LEGACY_PLAN_APPROVAL_RECOVERY_CHOICE, "utf-8")
          .digest("hex"),
  );
}

function ensurePlanApprovalLegacyRecoveryChallenge(
  projectDir: string,
  session: string,
  intentId: string,
  markerRevision: number,
): void {
  const challengeId = legacyPlanApprovalRecoveryChallengeId(
    session,
    intentId,
    markerRevision,
  );
  const existing = readPlanApprovalLegacyRecoveryChallenge(
    projectDir,
    session,
  );
  if (
    existing?.intentId === intentId &&
    existing.markerRevision === markerRevision &&
    existing.challengeId === challengeId
  ) {
    return;
  }
  writePlanApprovalLegacyRecoveryChallenge(projectDir, {
    version: 1,
    session,
    intentId,
    markerRevision,
    challengeId,
  });
}

function installPlanApprovalLegacyOffer(
  projectDir: string,
  candidate: PlanApprovalLegacyOfferCandidate,
  marker: ActiveDirectiveMarker,
): void {
  const intentId = marker.intent_uuid?.trim() ?? "";
  const markerRevision = marker.code_generation_authority_revision;
  if (!intentId || marker.stage !== "code-generation" || markerRevision === undefined) {
    throw new Error("legacy Plan Approval offer requires active Code Generation authority");
  }
  const allowedUnits = marker.kind === "invoke-swarm"
    ? [...new Set(marker.units ?? [])]
    : [marker.unit?.trim() || null];
  if (allowedUnits.length === 0) {
    throw new Error("legacy Plan Approval offer requires an authoritative target");
  }
  writePlanApprovalLegacyOffer(projectDir, {
    version: 1,
    session: candidate.session,
    intentId,
    markerRevision,
    allowedUnits,
    options: candidate.optionHashes,
  });
}

function resolveActiveDirectiveTarget(
  projectDir: string,
  intent?: string,
  space?: string,
): ActiveDirectiveTarget {
  const canonicalProjectDir = realpathSync(resolvePath(projectDir));
  const selection = resolveWorkflowSelection(canonicalProjectDir, {
    space,
    intent,
  });
  const resolvedSpace = selection.space;
  const recordDirName = selection.intent;
  const recordsRoot = intentsDir(canonicalProjectDir, resolvedSpace);
  const root = recordDirName === null
    ? spaceRecordRoot(canonicalProjectDir, resolvedSpace)
    : join(recordsRoot, recordDirName);
  const rel = relative(recordDirName === null ? spaceRecordRoot(canonicalProjectDir, resolvedSpace) : recordsRoot, root);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Active-directive record resolves outside its space");
  }
  const intentUuid = recordDirName === null
    ? null
    : listIntents(canonicalProjectDir, resolvedSpace).find((entry) => entry.dirName === recordDirName)?.uuid ?? null;
  const markerPath = join(root, ACTIVE_DIRECTIVE_MARKER);
  return {
    canonicalProjectDir,
    space: resolvedSpace,
    recordDirName,
    intentUuid,
    statePath: join(root, "aidlc-state.md"),
    markerPath,
    lockDir: join(root, ACTIVE_DIRECTIVE_LOCK),
    bucket: recordDirName === null ? `${resolvedSpace}/bare-space` : `${resolvedSpace}/${recordDirName}`,
  };
}

function activeDirectiveMarkerPath(
  projectDir: string,
  intent?: string,
  space?: string,
): string {
  return resolveActiveDirectiveTarget(projectDir, intent, space).markerPath;
}

function stateContentSha256(stateContent: string): string {
  return createHash("sha256").update(stateContent, "utf-8").digest("hex");
}

function activeDirectiveContext(target: ActiveDirectiveTarget, stateContent: string | null) {
  return {
    projectSha256: createHash("sha256").update(target.canonicalProjectDir, "utf-8").digest("hex"),
    intentUuid: target.intentUuid,
    statePresent: stateContent !== null,
    stateSha256: stateContentSha256(stateContent ?? ""),
  };
}

function parseActiveDirectiveMarker(parsed: unknown): ActiveDirectiveMarker | null {
  if (!isPlainObject(parsed)) return null;
  const stage = typeof parsed.stage === "string" ? parsed.stage.trim() : "";
  const unit = typeof parsed.unit === "string" ? parsed.unit.trim() : undefined;
  const stateSha256 = typeof parsed.state_sha256 === "string" ? parsed.state_sha256 : "";
  if (!/^[a-z][a-z0-9-]*$/.test(stage) || ("unit" in parsed && !unit) || !/^[0-9a-f]{64}$/.test(stateSha256)) return null;
  if (parsed.version === 1) return { version: 1, stage, ...(unit ? { unit } : {}), state_sha256: stateSha256 };
  const integer = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;
  const attempt = isPlainObject(parsed.active_attempt) ? parsed.active_attempt : null;
  const resume = isPlainObject(parsed.resume) ? parsed.resume : null;
  const kinds: ActiveDirectiveKind[] = ["load-steering", "run-stage", "ask", "print", "error", "done", "parked", "notice", "dispatch-subagent", "invoke-swarm", "present-gate"];
  if (
    parsed.version !== 2 || !/^[0-9a-f]{64}$/.test(String(parsed.project_sha256 ?? "")) ||
    (parsed.intent_uuid !== null && typeof parsed.intent_uuid !== "string") || typeof parsed.state_present !== "boolean" ||
    ("code_generation_source_sha256" in parsed &&
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64}|unbindable)$/.test(
        String(parsed.code_generation_source_sha256 ?? ""),
      )) ||
    ("code_generation_authority_revision" in parsed &&
      !integer(parsed.code_generation_authority_revision)) ||
    ("units" in parsed &&
      (
        !Array.isArray(parsed.units) ||
        parsed.units.length === 0 ||
        parsed.units.some(
          (unit) =>
            typeof unit !== "string" ||
            validateUnitName(unit.trim()) !== null,
        )
      )) ||
    ("cursor_harness" in parsed &&
      (typeof parsed.cursor_harness !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(parsed.cursor_harness))) ||
    typeof parsed.owner_session !== "string" || parsed.owner_session.length === 0 ||
    !integer(parsed.revision) || !integer(parsed.owner_epoch) || !integer(parsed.context_epoch) ||
    !integer(parsed.event_sequence) || !integer(parsed.human_sequence) || !integer(parsed.engine_sequence) ||
    !integer(parsed.conversation_sequence) || !integer(parsed.stop_count) ||
    !kinds.includes(parsed.kind as ActiveDirectiveKind) ||
    !["issued", "delivered", "consumed", "superseded"].includes(String(parsed.delivery)) ||
    typeof parsed.needs_rehydrate !== "boolean" || !attempt || ("id" in attempt && typeof attempt.id !== "string") ||
    !["next", "continue", "report", "park"].includes(String(attempt.command_kind)) ||
    !/^[0-9a-f]{64}$/.test(String(attempt.command_sha256 ?? "")) ||
    !/^[0-9a-f]{64}$/.test(String(attempt.issued_state_sha256 ?? "")) || typeof attempt.session_id !== "string" ||
    !integer(attempt.owner_epoch) || !integer(attempt.context_epoch) || !["pending", "settled", "failed"].includes(String(attempt.status)) ||
    ("claim_revision" in attempt && !integer(attempt.claim_revision)) ||
    ("shared_attempt" in attempt && typeof attempt.shared_attempt !== "boolean") ||
    ("cursor_input_sha256" in attempt && !/^[0-9a-f]{64}$/.test(String(attempt.cursor_input_sha256 ?? ""))) ||
    ("result_sha256" in attempt && !/^[0-9a-f]{64}$/.test(String(attempt.result_sha256 ?? ""))) ||
    ("result_revision" in attempt && !integer(attempt.result_revision)) ||
    ("resume_gate_revision" in attempt && !integer(attempt.resume_gate_revision)) ||
    (resume !== null &&
      (!["waiting", "selected", "superseded"].includes(String(resume.status)) ||
        typeof resume.issuing_stage !== "string" || !/^[0-9a-f]{64}$/.test(String(resume.issuing_state_sha256 ?? "")) ||
        typeof resume.issuing_session !== "string" ||
        (resume.issuing_intent_uuid !== null && typeof resume.issuing_intent_uuid !== "string")))
  ) return null;
  if (parsed.continue_token !== undefined) {
    if (typeof parsed.continue_token !== "string" || Buffer.byteLength(parsed.continue_token, "utf-8") > 16 * 1024) return null;
    if (stateContentSha256(parsed.continue_token) !== parsed.continue_token_sha256) return null;
  }
  if (parsed.kind === "load-steering" &&
    (!Number.isInteger(parsed.part) || !Number.isInteger(parsed.parts) || (parsed.part as number) < 1 ||
      (parsed.part as number) > (parsed.parts as number) || parsed.continue_token === undefined)) return null;
  return { ...(parsed as unknown as ActiveDirectiveMarker), stage, ...(unit ? { unit } : {}) };
}

function readActiveDirectiveMarkerRaw(path: string): ActiveDirectiveMarker | null {
  return readActiveDirectiveMarkerSnapshot(path).marker;
}

function readActiveDirectiveMarkerSnapshot(path: string): {
  marker: ActiveDirectiveMarker | null;
  bytesSha256: string | null;
} {
  // Single-descriptor snapshot bounded to ACTIVE_DIRECTIVE_MAX_BYTES + 1: an
  // oversized or corrupt marker is rejected without allocating its full size,
  // and parse + hash always come from the same bytes. The descriptor pins one
  // inode, so a concurrent rename-publish cannot mix two marker versions.
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const bounded = Buffer.alloc(ACTIVE_DIRECTIVE_MAX_BYTES + 1);
    let length = 0;
    while (length < bounded.byteLength) {
      const read = readSync(fd, bounded, length, bounded.byteLength - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > ACTIVE_DIRECTIVE_MAX_BYTES) {
      return { marker: null, bytesSha256: null };
    }
    const bytes = bounded.subarray(0, length);
    return {
      marker: parseActiveDirectiveMarker(JSON.parse(bytes.toString("utf-8"))),
      bytesSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return { marker: null, bytesSha256: null };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* read-only descriptor; close is best-effort */ }
    }
  }
}

function transactActiveDirective<T>(
  projectDir: string,
  update: (
    marker: ActiveDirectiveMarker | null,
    target: ActiveDirectiveTarget,
  ) => { marker: ActiveDirectiveMarker | null; result: T; preserve?: boolean },
  intent?: string,
  space?: string,
): T {
  const target = resolveActiveDirectiveTarget(projectDir, intent, space);
  return transactActiveDirectiveTarget(target, update);
}

export function withActiveDirectiveLock<T>(
  projectDir: string,
  operation: (
    marker: ActiveDirectiveMarker | null,
    target: ActiveDirectiveTarget,
  ) => T,
): T {
  return transactActiveDirective(projectDir, (marker, target) => ({
    marker,
    result: operation(marker, target),
    preserve: true,
  }));
}

function transactActiveDirectiveTarget<T>(
  target: ActiveDirectiveTarget,
  update: (
    marker: ActiveDirectiveMarker | null,
    target: ActiveDirectiveTarget,
  ) => { marker: ActiveDirectiveMarker | null; result: T; preserve?: boolean },
): T {
  if (ACTIVE_DIRECTIVE_TRANSACTIONS.has(target.markerPath)) {
    throw new Error(`Nested active-directive transaction for ${target.bucket}`);
  }
  const pendingRelease = ACTIVE_DIRECTIVE_EXIT_HANDLERS.get(target.markerPath);
  if (pendingRelease) {
    const outcome = releaseCanonicalOwnerStampedLock(pendingRelease.receipt);
    if (outcome === "retryable") {
      throw new ActiveDirectiveLockContendedError(
        "Active-directive lock release is still pending",
      );
    }
    process.off("exit", pendingRelease.handler);
    ACTIVE_DIRECTIVE_EXIT_HANDLERS.delete(target.markerPath);
  }
  mkdirSync(dirname(target.markerPath), { recursive: true });
  const receipt = acquireActiveDirectiveLock(target.lockDir);
  if (!receipt) throw new ActiveDirectiveLockContendedError();
  ACTIVE_DIRECTIVE_TRANSACTIONS.add(target.markerPath);
  const onExit = () => releaseCanonicalOwnerStampedLock(receipt);
  ACTIVE_DIRECTIVE_EXIT_HANDLERS.set(target.markerPath, {
    token: receipt.owner.token ?? "",
    handler: onExit,
    receipt,
  });
  process.on("exit", onExit);
  try {
    const current = readActiveDirectiveMarkerRaw(target.markerPath);
    const next = update(current, target);
    if (!next.preserve && next.marker === null) {
      const removed = join(receipt.tokenDir, "removed.json");
      try {
        renameSync(target.markerPath, removed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !ownerReceiptMatches(receipt)) throw error;
      }
    } else if (!next.preserve) {
      const serialized = `${JSON.stringify(next.marker, null, 2)}\n`;
      if (Buffer.byteLength(serialized, "utf-8") > ACTIVE_DIRECTIVE_MAX_BYTES) {
        throw new Error("Active-directive marker exceeds its size limit");
      }
      const candidate = join(receipt.tokenDir, "next.json");
      let fd: number | undefined;
      try {
        fd = openSync(candidate, "wx", 0o600);
        writeFileSync(fd, serialized, "utf-8");
        closeSync(fd);
        fd = undefined;
        renameSync(candidate, target.markerPath);
      } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* preserve the write error */ }
      }
    }
    return next.result;
  } catch (error) {
    if (!ownerReceiptMatches(receipt)) {
      throw new ActiveDirectiveLockContendedError("Active-directive lock ownership changed before commit");
    }
    throw error;
  } finally {
    ACTIVE_DIRECTIVE_TRANSACTIONS.delete(target.markerPath);
    const outcome = releaseCanonicalOwnerStampedLock(receipt);
    const registered = ACTIVE_DIRECTIVE_EXIT_HANDLERS.get(target.markerPath);
    if (
      outcome !== "retryable" &&
      registered?.token === receipt.owner.token
    ) {
      process.off("exit", registered.handler);
      ACTIVE_DIRECTIVE_EXIT_HANDLERS.delete(target.markerPath);
    }
  }
}

const ACTIVE_DIRECTIVE_TRANSACTIONS = new Set<string>();
const ACTIVE_DIRECTIVE_EXIT_HANDLERS = new Map<string, {
  token: string;
  handler: () => void;
  receipt: OwnerStampedLockReceipt;
}>();

function freshActiveDirectiveMarker(
  target: ActiveDirectiveTarget,
  stateContent: string | null,
  stage: string,
): ActiveDirectiveMarker {
  const context = activeDirectiveContext(target, stateContent);
  const cursorHarness = installedHarnessNameForTarget(target);
  const owner = `sessionless:${context.projectSha256.slice(0, 16)}`;
  return {
    version: 2, revision: 0, project_sha256: context.projectSha256,
    intent_uuid: context.intentUuid, state_present: context.statePresent, state_sha256: context.stateSha256,
    ...(cursorHarness ? { cursor_harness: cursorHarness } : {}),
    owner_session: owner, owner_epoch: 0, context_epoch: 0, kind: "error", stage,
    delivery: "superseded", needs_rehydrate: true,
    active_attempt: {
      id: "sessionless", command_kind: "next", command_sha256: context.stateSha256,
      issued_state_sha256: context.stateSha256, session_id: owner,
      owner_epoch: 0, context_epoch: 0, status: "settled",
    },
    event_sequence: 0, human_sequence: 0, engine_sequence: 0, conversation_sequence: 0, stop_count: 0,
  };
}

function invalidateActiveDirectiveDelivery(marker: ActiveDirectiveMarker): ActiveDirectiveMarker {
  return { ...marker, revision: (marker.revision ?? 0) + 1, delivery: "superseded", needs_rehydrate: true };
}

function crossActiveDirectiveBoundary(
  marker: ActiveDirectiveMarker, stateSha256: string, intentUuid: string | null, statePresent: boolean,
): ActiveDirectiveMarker {
  const stateChanged = marker.state_sha256 !== stateSha256;
  const intentChanged = marker.intent_uuid !== intentUuid;
  const supersedeResume = (marker.resume?.status === "waiting" || marker.resume?.status === "selected") &&
    (stateChanged || intentChanged);
  return { ...invalidateActiveDirectiveDelivery(marker), state_sha256: stateSha256,
    intent_uuid: intentUuid, state_present: statePresent,
    kind: "error",
    part: undefined, parts: undefined, continue_token: undefined, continue_token_sha256: undefined,
    ...(supersedeResume && marker.resume ? { resume: { ...marker.resume, status: "superseded" } } : {}),
  };
}

function codeGenerationSourceFloorForPublication(
  target: ActiveDirectiveTarget,
  base: ActiveDirectiveMarker,
  stage: string,
  rotate: boolean,
): string | undefined {
  if (stage !== "code-generation") return undefined;
  if (
    !rotate &&
    base.stage === "code-generation" &&
    base.code_generation_source_sha256 !== undefined
  ) {
    return base.code_generation_source_sha256;
  }
  return workspaceSourceFingerprint(target.canonicalProjectDir) ??
    UNBINDABLE_FINGERPRINT;
}

export function writeActiveDirectiveMarker(
  projectDir: string,
  marker: Omit<CopilotDirectiveMetadata, "continueToken" | "stage"> & {
    stage: string;
    continue_token?: string;
    state_sha256: string;
    units?: string[];
  },
  invocation?: {
    attemptId?: string;
    commandKind?: CopilotCommandClaim["commandKind"];
    commandSha256?: string;
    legacyPlanApprovalOffer?: PlanApprovalLegacyOfferCandidate;
    legacyPlanApprovalSession?: string;
    resultSha256?: string;
  },
): ActiveDirectiveWriteResult {
  if (!/^[a-z][a-z0-9-]*$/.test(marker.stage)) {
    throw new Error(`Invalid active-directive stage: ${marker.stage}`);
  }
  if (marker.unit !== undefined && marker.unit.trim().length === 0) {
    throw new Error("Invalid active-directive unit: empty");
  }
  if (!/^[0-9a-f]{64}$/.test(marker.state_sha256)) {
    throw new Error("Invalid active-directive state digest");
  }
  if (
    invocation?.legacyPlanApprovalOffer !== undefined &&
    !validPlanApprovalLegacyOfferCandidate(invocation.legacyPlanApprovalOffer)
  ) {
    throw new Error("Invalid legacy Plan Approval offer candidate");
  }
  if (
    invocation?.legacyPlanApprovalSession !== undefined &&
    !invocation.legacyPlanApprovalSession.trim()
  ) {
    throw new Error("Invalid legacy Plan Approval ownership session");
  }
  if (
    invocation?.legacyPlanApprovalOffer &&
    invocation.legacyPlanApprovalSession !==
      invocation.legacyPlanApprovalOffer.session
  ) {
    throw new Error("Legacy Plan Approval offer/session mismatch");
  }
  let shouldResetRuntime = false;
  const result = transactActiveDirective(projectDir, (current, target) => {
    const stateContent = existsSync(target.statePath) ? readFileSync(target.statePath, "utf-8") : null;
    const context = activeDirectiveContext(target, stateContent);
    const legacyOffer = invocation?.legacyPlanApprovalOffer;
    const legacySession = invocation?.legacyPlanApprovalSession;
    if (legacySession && context.intentUuid) {
      const owner = findPlanApprovalLegacyOwner(
        target.canonicalProjectDir,
        context.intentUuid,
        current,
      );
      if (owner.status === "ambiguous") {
        return {
          marker: current,
          result: "legacy-plan-approval-owned" as const,
          preserve: true,
        };
      }
      if (owner.status === "owned") {
        const sameOwner = owner.session === legacySession;
        if (!sameOwner && owner.live) {
          return {
            marker: current,
            result: "legacy-plan-approval-owned" as const,
            preserve: true,
          };
        }
        const markerRevision = planApprovalAuthorityRevision(current);
        if (
          markerRevision === null ||
          !planApprovalLegacyRecoverySatisfied(
            target.canonicalProjectDir,
            legacySession,
            context.intentUuid,
            markerRevision,
          )
        ) {
          if (markerRevision !== null) {
            ensurePlanApprovalLegacyRecoveryChallenge(
              target.canonicalProjectDir,
              legacySession,
              context.intentUuid,
              markerRevision,
            );
          }
          return {
            marker: current,
            result: "legacy-plan-approval-recovery-required" as const,
            preserve: true,
          };
        }
        if (legacyOffer) {
          clearPlanApprovalLegacyRecovery(
            target.canonicalProjectDir,
            legacySession,
          );
          if (owner.session !== legacySession) {
            clearPlanApprovalLegacyRecovery(
              target.canonicalProjectDir,
              owner.session,
            );
          }
          clearPlanApprovalViolation(target.canonicalProjectDir);
          clearPlanApprovalLegacyWindowsForMarker(target.canonicalProjectDir, current);
          rotatePlanApprovalLegacyOwner(
            target.canonicalProjectDir,
            legacyOffer,
            owner,
          );
          return {
            marker: current,
            result: "legacy-plan-approval-reissued" as const,
            preserve: true,
          };
        }
        return {
          marker: current,
          result: "legacy-plan-approval-transport" as const,
          preserve: true,
        };
      }
      if (
        owner.status === "none" &&
        (
          planApprovalLegacyViolationMatches(
            target.canonicalProjectDir,
            current,
          ) ||
          planApprovalLegacyWindowMatches(
            target.canonicalProjectDir,
            current,
          )
        )
      ) {
        const markerRevision = planApprovalAuthorityRevision(current);
        if (
          markerRevision === null ||
          !planApprovalLegacyRecoverySatisfied(
            target.canonicalProjectDir,
            legacySession,
            context.intentUuid,
            markerRevision,
          )
        ) {
          if (markerRevision !== null) {
            ensurePlanApprovalLegacyRecoveryChallenge(
              target.canonicalProjectDir,
              legacySession,
              context.intentUuid,
              markerRevision,
            );
          }
          return {
            marker: current,
            result: "legacy-plan-approval-recovery-required" as const,
            preserve: true,
          };
        }
        if (!legacyOffer) {
          return {
            marker: current,
            result: "legacy-plan-approval-transport" as const,
            preserve: true,
          };
        }
        clearPlanApprovalLegacyRecovery(
          target.canonicalProjectDir,
          legacySession,
        );
        clearPlanApprovalViolation(target.canonicalProjectDir);
        clearPlanApprovalLegacyWindowsForMarker(target.canonicalProjectDir, current);
        if (current?.version !== 2) {
          return {
            marker: current,
            result: "legacy-plan-approval-owned" as const,
            preserve: true,
          };
        }
        installPlanApprovalLegacyOffer(
          target.canonicalProjectDir,
          legacyOffer,
          current,
        );
        return {
          marker: current,
          result: "legacy-plan-approval-reissued" as const,
          preserve: true,
        };
      }
    }
    const cursorHarness = installedHarnessNameForTarget(target);
    const copilotOwned = exactCopilotMarker(current, target, context);
    const attempt = current?.version === 2 ? current.active_attempt : undefined;
    const matchingAttempt = copilotOwned && attempt?.status === "pending" && invocation?.attemptId !== undefined &&
      attempt.id === invocation.attemptId && attempt.command_kind === invocation.commandKind &&
      attempt.command_sha256 === invocation.commandSha256 && attempt.session_id === current.owner_session &&
      attempt.owner_epoch === current.owner_epoch && attempt.context_epoch === current.context_epoch &&
      attempt.issued_state_sha256 === context.stateSha256 && attempt.claim_revision === current.revision &&
      attempt.result_sha256 === undefined && attempt.result_revision === undefined;
    const trackedFreshNext = invocation?.commandKind === "next" && invocation.attemptId !== undefined;
    if (copilotOwned && trackedFreshNext && !matchingAttempt) {
      return { marker: current, result: "stale-attempt" as const, preserve: true };
    }
    if (copilotOwned && (current.resume?.status === "waiting" || current.resume?.status === "selected") && !matchingAttempt) {
      return { marker: current, result: "preserved" as const, preserve: true };
    }
    const base = current?.version === 2 && current.project_sha256 === context.projectSha256 && current.intent_uuid === context.intentUuid
      ? current
      : freshActiveDirectiveMarker(target, stateContent, marker.stage);
    const token = marker.continue_token;
    const nextRevision = (base.revision ?? 0) + 1;
    const rotateCodeGenerationFloor =
      marker.stage === "code-generation" &&
      base.stage === "code-generation" &&
      planApprovalRuntimeHasReceiptForMarker(
        target.canonicalProjectDir,
        base,
      );
    const codeGenerationSourceSha256 =
      codeGenerationSourceFloorForPublication(
        target,
        base,
        marker.stage,
        rotateCodeGenerationFloor,
      );
    const priorAuthorityRevision =
      base.code_generation_authority_revision ??
      base.active_attempt?.result_revision ??
      base.revision ??
      nextRevision;
    const baseSwarmPlanning =
      (base.kind === "invoke-swarm" || base.kind === "load-steering") &&
      (base.units?.length ?? 0) > 0;
    const nextSwarmPlanning =
      marker.kind === "invoke-swarm" || marker.kind === "load-steering";
    const requestedUnits = marker.units ?? base.units ?? [];
    const preserveCodeGenerationAuthority =
      marker.stage === "code-generation" &&
      base.stage === "code-generation" &&
      baseSwarmPlanning &&
      nextSwarmPlanning &&
      JSON.stringify(requestedUnits) === JSON.stringify(base.units ?? []) &&
      !rotateCodeGenerationFloor &&
      base.code_generation_source_sha256 !== undefined;
    const codeGenerationAuthorityRevision =
      marker.stage === "code-generation"
        ? preserveCodeGenerationAuthority
          ? priorAuthorityRevision
          : nextRevision
        : undefined;
    shouldResetRuntime = !preserveCodeGenerationAuthority;
    const nextAttempt = matchingAttempt && attempt
      ? {
          ...attempt,
          ...(invocation?.commandKind === "continue" && token
            ? { cursor_input_sha256: attempt.cursor_input_sha256 }
            : {}),
          ...(invocation?.resultSha256
            ? { result_sha256: invocation.resultSha256, result_revision: nextRevision }
            : {}),
        }
      : attempt?.status === "pending"
        ? { ...attempt, status: "failed" as const }
        : attempt;
    const next: ActiveDirectiveMarker = {
      ...base,
      revision: nextRevision,
      ...(cursorHarness ? { cursor_harness: cursorHarness } : {}),
      state_present: context.statePresent,
      state_sha256: marker.state_sha256,
      kind: marker.kind,
      stage: marker.stage,
      ...(codeGenerationSourceSha256
        ? { code_generation_source_sha256: codeGenerationSourceSha256 }
        : { code_generation_source_sha256: undefined }),
      ...(codeGenerationAuthorityRevision !== undefined
        ? {
            code_generation_authority_revision:
              codeGenerationAuthorityRevision,
          }
        : { code_generation_authority_revision: undefined }),
      ...(marker.unit ? { unit: marker.unit } : { unit: undefined }),
      ...(requestedUnits.length > 0
        ? { units: requestedUnits }
        : { units: undefined }),
      ...(marker.part ? { part: marker.part } : { part: undefined }),
      ...(marker.parts ? { parts: marker.parts } : { parts: undefined }),
      ...(token ? { continue_token: token, continue_token_sha256: stateContentSha256(token) } : { continue_token: undefined, continue_token_sha256: undefined }),
      delivery: "issued",
      needs_rehydrate: copilotOwned,
      ...(nextAttempt ? { active_attempt: nextAttempt } : {}),
    };
    if (legacyOffer) {
      if (shouldResetRuntime) {
        resetPlanApprovalRuntime(target.canonicalProjectDir);
        shouldResetRuntime = false;
      }
      installPlanApprovalLegacyOffer(
        target.canonicalProjectDir,
        legacyOffer,
        next,
      );
    }
    return { marker: next, result: copilotOwned ? "copilot-committed" as const : "generic-committed" as const };
  });
  if (
    (result === "generic-committed" || result === "copilot-committed") &&
    shouldResetRuntime
  ) {
    resetPlanApprovalRuntime(projectDir);
  }
  return result;
}

export function clearActiveDirectiveMarker(projectDir: string): void {
  transactActiveDirective(projectDir, (marker) =>
    marker?.version === 2 && !marker.owner_session?.startsWith("sessionless:") && marker.active_attempt?.status === "pending"
      ? { marker, result: true, preserve: true } : { marker: null, result: true });
  resetPlanApprovalRuntime(projectDir);
}

export function refreshActiveDirectiveMarker(
  projectDir: string,
  stage: string,
  previousStateContent: string,
  nextStateContent: string,
): boolean {
  const refreshed = transactActiveDirective(projectDir, (marker) => {
    if (!marker || marker.stage !== stage || marker.state_sha256 !== stateContentSha256(previousStateContent)) {
      return { marker, result: false, preserve: true };
    }
    if (marker.version === 1) {
      return { marker: { ...marker, state_sha256: stateContentSha256(nextStateContent) }, result: true };
    }
    return {
      marker: {
        ...crossActiveDirectiveBoundary(marker, stateContentSha256(nextStateContent), marker.intent_uuid ?? null, true),
      },
      result: true,
    };
  });
  if (refreshed) resetPlanApprovalRuntime(projectDir);
  return refreshed;
}

export function readActiveDirectiveMarker(
  projectDir: string,
  stateContent: string,
): ActiveDirectiveMarker | null {
  try {
    const marker = readActiveDirectiveMarkerRaw(activeDirectiveMarkerPath(projectDir));
    return marker?.state_sha256 === stateContentSha256(stateContent) ? marker : null;
  } catch {
    return null;
  }
}

// Read the shared/sessionless resume wait under the active-directive lock. The
// marker is read before state while refreshActiveDirectiveMarker uses the same
// lock after writing state, so a concurrent state transition either linearizes
// after this evidence or makes the marker/state digest mismatch and fails closed.
export function hasCurrentSharedResumeWait(projectDir: string): boolean {
  return transactActiveDirective(projectDir, (marker, target) => {
    let stateContent: string;
    try {
      stateContent = readFileSync(target.statePath, "utf-8");
    } catch {
      return { marker, result: false, preserve: true };
    }
    const waiting =
      marker?.version === 2 &&
      marker.owner_session?.startsWith("sessionless:") === true &&
      marker.state_sha256 === stateContentSha256(stateContent) &&
      marker.kind === "ask" &&
      marker.resume?.status === "waiting" &&
      getField(stateContent, "Construction Autonomy Mode")?.trim() !== "autonomous";
    return { marker, result: waiting, preserve: true };
  });
}

export interface ContinuationCursorSnapshot {
  target: ActiveDirectiveTarget;
  stateSha256: string;
  statePresent: boolean;
  cursorHarness: string | null;
}

function exactCopilotMarker(
  marker: ActiveDirectiveMarker | null,
  target: ActiveDirectiveTarget,
  context: ReturnType<typeof activeDirectiveContext>,
): marker is ActiveDirectiveMarker & { version: 2 } {
  return installedHarnessNameForTarget(target) === "copilot" && marker?.version === 2 &&
    (marker.cursor_harness === undefined || marker.cursor_harness === "copilot") &&
    !marker.owner_session?.startsWith("sessionless:") &&
    marker.project_sha256 === context.projectSha256 && marker.intent_uuid === context.intentUuid &&
    marker.state_sha256 === context.stateSha256 && marker.state_present === context.statePresent;
}

function installedHarnessNameForTarget(target: ActiveDirectiveTarget): string | null {
  const explicit = process.env.AIDLC_HARNESS_NAME?.trim();
  if (explicit && /^[a-z0-9][a-z0-9._-]*$/i.test(explicit)) return explicit;
  try {
    const parsed = JSON.parse(readFileSync(
      join(target.canonicalProjectDir, harnessDir(), "tools", "data", "harness.json"),
      "utf-8",
    )) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : null;
  } catch {
    const dir = harnessDir();
    if (dir === ".aidlc") return "opencode";
    if (dir === ".kiro") return "kiro";
    return /^\.[a-z0-9][a-z0-9._-]*$/i.test(dir) ? dir.slice(1) : null;
  }
}

export function installedHarnessName(projectDir: string): string | null {
  return installedHarnessNameForTarget(resolveActiveDirectiveTarget(projectDir));
}

export function inspectContinuationCursor(
  projectDir: string,
  stateContent: string | null,
): ContinuationCursorSnapshot {
  const target = resolveActiveDirectiveTarget(projectDir);
  const context = activeDirectiveContext(target, stateContent);
  return {
    target,
    stateSha256: context.stateSha256,
    statePresent: context.statePresent,
    cursorHarness: installedHarnessNameForTarget(target),
  };
}

export function advanceContinuationCursor(
  snapshot: ContinuationCursorSnapshot,
  presentedToken: string,
  successor: Omit<CopilotDirectiveMetadata, "continueToken" | "stage"> & {
    stage: string;
    continue_token?: string;
    state_sha256: string;
    units?: string[];
  },
  resultSha256: string,
  attemptId?: string,
  legacyPlanApprovalOffer?: PlanApprovalLegacyOfferCandidate,
  legacyPlanApprovalSession?: string,
):
  | "advanced"
  | "legacy-plan-approval-owned"
  | "legacy-plan-approval-recovery-required"
  | "legacy-plan-approval-reissued"
  | "legacy-plan-approval-transport"
  | "superseded"
  | "drift" {
  if (!/^[0-9a-f]{64}$/.test(resultSha256) || successor.state_sha256 !== snapshot.stateSha256) {
    return "drift";
  }
  if (
    legacyPlanApprovalOffer !== undefined &&
    !validPlanApprovalLegacyOfferCandidate(legacyPlanApprovalOffer)
  ) {
    return "drift";
  }
  if (legacyPlanApprovalSession !== undefined && !legacyPlanApprovalSession.trim()) {
    return "drift";
  }
  if (
    legacyPlanApprovalOffer &&
    legacyPlanApprovalSession !== legacyPlanApprovalOffer.session
  ) {
    return "drift";
  }
  let shouldResetRuntime = true;
  const result = transactActiveDirectiveTarget(snapshot.target, (current, target) => {
    const currentTarget = resolveActiveDirectiveTarget(target.canonicalProjectDir);
    if (currentTarget.markerPath !== target.markerPath || currentTarget.intentUuid !== target.intentUuid) {
      return { marker: current, result: "drift" as const, preserve: true };
    }
    const stateContent = existsSync(target.statePath) ? readFileSync(target.statePath, "utf-8") : null;
    const context = activeDirectiveContext(target, stateContent);
    if (context.stateSha256 !== snapshot.stateSha256 || context.statePresent !== snapshot.statePresent) {
      return { marker: current, result: "drift" as const, preserve: true };
    }
    if (legacyPlanApprovalSession && context.intentUuid) {
      const owner = findPlanApprovalLegacyOwner(
        target.canonicalProjectDir,
        context.intentUuid,
        current,
      );
      if (owner.status === "ambiguous") {
        return {
          marker: current,
          result: "legacy-plan-approval-owned" as const,
          preserve: true,
        };
      }
      if (owner.status === "owned") {
        const sameOwner = owner.session === legacyPlanApprovalSession;
        if (!sameOwner && owner.live) {
          return {
            marker: current,
            result: "legacy-plan-approval-owned" as const,
            preserve: true,
          };
        }
        const markerRevision = planApprovalAuthorityRevision(current);
        if (
          markerRevision === null ||
          !planApprovalLegacyRecoverySatisfied(
            target.canonicalProjectDir,
            legacyPlanApprovalSession,
            context.intentUuid,
            markerRevision,
          )
        ) {
          if (markerRevision !== null) {
            ensurePlanApprovalLegacyRecoveryChallenge(
              target.canonicalProjectDir,
              legacyPlanApprovalSession,
              context.intentUuid,
              markerRevision,
            );
          }
          return {
            marker: current,
            result: "legacy-plan-approval-recovery-required" as const,
            preserve: true,
          };
        }
        if (legacyPlanApprovalOffer) {
          clearPlanApprovalLegacyRecovery(
            target.canonicalProjectDir,
            legacyPlanApprovalSession,
          );
          if (owner.session !== legacyPlanApprovalSession) {
            clearPlanApprovalLegacyRecovery(
              target.canonicalProjectDir,
              owner.session,
            );
          }
          clearPlanApprovalViolation(target.canonicalProjectDir);
          clearPlanApprovalLegacyWindowsForMarker(target.canonicalProjectDir, current);
          rotatePlanApprovalLegacyOwner(
            target.canonicalProjectDir,
            legacyPlanApprovalOffer,
            owner,
          );
          return {
            marker: current,
            result: "legacy-plan-approval-reissued" as const,
            preserve: true,
          };
        }
        return {
          marker: current,
          result: "legacy-plan-approval-transport" as const,
          preserve: true,
        };
      }
      if (
        owner.status === "none" &&
        (
          planApprovalLegacyViolationMatches(
            target.canonicalProjectDir,
            current,
          ) ||
          planApprovalLegacyWindowMatches(
            target.canonicalProjectDir,
            current,
          )
        )
      ) {
        const markerRevision = planApprovalAuthorityRevision(current);
        if (
          markerRevision === null ||
          !planApprovalLegacyRecoverySatisfied(
            target.canonicalProjectDir,
            legacyPlanApprovalSession,
            context.intentUuid,
            markerRevision,
          )
        ) {
          if (markerRevision !== null) {
            ensurePlanApprovalLegacyRecoveryChallenge(
              target.canonicalProjectDir,
              legacyPlanApprovalSession,
              context.intentUuid,
              markerRevision,
            );
          }
          return {
            marker: current,
            result: "legacy-plan-approval-recovery-required" as const,
            preserve: true,
          };
        }
        if (!legacyPlanApprovalOffer) {
          return {
            marker: current,
            result: "legacy-plan-approval-transport" as const,
            preserve: true,
          };
        }
        clearPlanApprovalLegacyRecovery(
          target.canonicalProjectDir,
          legacyPlanApprovalSession,
        );
        clearPlanApprovalViolation(target.canonicalProjectDir);
        clearPlanApprovalLegacyWindowsForMarker(target.canonicalProjectDir, current);
        if (current?.version !== 2) {
          return {
            marker: current,
            result: "legacy-plan-approval-owned" as const,
            preserve: true,
          };
        }
        installPlanApprovalLegacyOffer(
          target.canonicalProjectDir,
          legacyPlanApprovalOffer,
          current,
        );
        return {
          marker: current,
          result: "legacy-plan-approval-reissued" as const,
          preserve: true,
        };
      }
    }
    const cursorHarness = installedHarnessNameForTarget(target);
    if (!cursorHarness || cursorHarness !== snapshot.cursorHarness) {
      return { marker: current, result: "drift" as const, preserve: true };
    }
    const exactContext = current?.version === 2 &&
      current.project_sha256 === context.projectSha256 &&
      current.intent_uuid === context.intentUuid &&
      current.state_sha256 === context.stateSha256 &&
      current.state_present === context.statePresent;
    const inputSha256 = stateContentSha256(presentedToken);
    if (exactContext && (current.kind !== "load-steering" ||
      current.continue_token_sha256 !== inputSha256)) {
      return { marker: current, result: "superseded" as const, preserve: true };
    }
    const base = exactContext && current
      ? current
      : freshActiveDirectiveMarker(target, stateContent, successor.stage);
    const nextRevision = (base.revision ?? 0) + 1;
    const pending = exactContext && current ? current.active_attempt : undefined;
    const matchingAttempt = pending?.status === "pending" && attemptId !== undefined && pending.id === attemptId &&
      pending.command_kind === "continue" && pending.cursor_input_sha256 === inputSha256 &&
      pending.owner_epoch === base.owner_epoch && pending.context_epoch === base.context_epoch;
    const token = successor.continue_token;
    const codeGenerationSourceSha256 =
      codeGenerationSourceFloorForPublication(
        target,
        base,
        successor.stage,
        false,
      );
    const requestedUnits = successor.units ?? base.units ?? [];
    const preserveCodeGenerationAuthority =
      successor.stage === "code-generation" &&
      base.stage === "code-generation" &&
      (base.kind === "load-steering" || base.kind === "invoke-swarm") &&
      (successor.kind === "load-steering" ||
        successor.kind === "invoke-swarm") &&
      requestedUnits.length > 0 &&
      base.code_generation_source_sha256 !== undefined &&
      !planApprovalRuntimeHasReceiptForMarker(
        target.canonicalProjectDir,
        base,
      );
    const codeGenerationAuthorityRevision =
      successor.stage === "code-generation"
        ? preserveCodeGenerationAuthority
          ? base.code_generation_authority_revision ??
            base.active_attempt?.result_revision ??
            base.revision ??
            nextRevision
          : nextRevision
        : undefined;
    shouldResetRuntime = !preserveCodeGenerationAuthority;
    const next: ActiveDirectiveMarker = {
      ...base,
      revision: nextRevision,
      cursor_harness: cursorHarness,
      state_present: context.statePresent,
      state_sha256: successor.state_sha256,
      kind: successor.kind,
      stage: successor.stage,
      ...(codeGenerationSourceSha256
        ? { code_generation_source_sha256: codeGenerationSourceSha256 }
        : { code_generation_source_sha256: undefined }),
      ...(codeGenerationAuthorityRevision !== undefined
        ? {
            code_generation_authority_revision:
              codeGenerationAuthorityRevision,
          }
        : { code_generation_authority_revision: undefined }),
      ...(successor.unit ? { unit: successor.unit } : { unit: undefined }),
      ...(requestedUnits.length > 0
        ? { units: requestedUnits }
        : { units: undefined }),
      ...(successor.part ? { part: successor.part } : { part: undefined }),
      ...(successor.parts ? { parts: successor.parts } : { parts: undefined }),
      ...(token ? { continue_token: token, continue_token_sha256: stateContentSha256(token) } : { continue_token: undefined, continue_token_sha256: undefined }),
      delivery: "issued",
      needs_rehydrate: !base.owner_session?.startsWith("sessionless:"),
      ...(pending ? { active_attempt: matchingAttempt
        ? { ...pending, result_sha256: resultSha256, result_revision: nextRevision }
        : pending.status === "pending" ? { ...pending, status: "failed" } : pending } : {}),
    };
    if (legacyPlanApprovalOffer) {
      if (shouldResetRuntime) {
        resetPlanApprovalRuntime(target.canonicalProjectDir);
        shouldResetRuntime = false;
      }
      installPlanApprovalLegacyOffer(
        target.canonicalProjectDir,
        legacyPlanApprovalOffer,
        next,
      );
    }
    return { marker: next, result: "advanced" as const };
  });
  if (result === "advanced" && shouldResetRuntime) {
    resetPlanApprovalRuntime(snapshot.target.canonicalProjectDir);
  }
  return result;
}

export function invalidateActiveDirectiveContext(
  projectDir: string,
  stateContent: string,
  sessionId: string,
): boolean {
  if (!sessionId) return false;
  const invalidated = transactActiveDirective(projectDir, (marker, target) => {
    const context = activeDirectiveContext(target, stateContent);
    if (
      marker?.version !== 2 || marker.owner_session !== sessionId ||
      marker.project_sha256 !== context.projectSha256 || marker.intent_uuid !== context.intentUuid ||
      marker.state_sha256 !== context.stateSha256
    ) return { marker, result: false, preserve: true };
    return {
      marker: {
        ...invalidateActiveDirectiveDelivery(marker),
        context_epoch: (marker.context_epoch ?? 0) + 1,
        kind: "error",
        part: undefined,
        parts: undefined,
        continue_token: undefined,
        continue_token_sha256: undefined,
      },
      result: true,
    };
  });
  if (invalidated) resetPlanApprovalRuntime(projectDir);
  return invalidated;
}

export function recordCopilotHumanSequence(
  projectDir: string,
  stateContent: string,
  sessionId: string,
): boolean {
  if (!sessionId || Buffer.byteLength(sessionId) > 512) return false;
  return transactActiveDirective(projectDir, (current, target) => {
    const context = activeDirectiveContext(target, stateContent);
    let marker = current;
    if (marker?.version !== 2 || marker.project_sha256 !== context.projectSha256 ||
      marker.intent_uuid !== context.intentUuid || marker.state_sha256 !== context.stateSha256 ||
      marker.state_present !== context.statePresent) {
      const stage = getField(stateContent, "Current Stage")?.trim() || "coordination";
      const fresh = freshActiveDirectiveMarker(target, stateContent, stage);
      marker = {
        ...fresh,
        owner_session: sessionId,
        owner_epoch: 1,
        active_attempt: {
          ...fresh.active_attempt!,
          id: undefined,
          session_id: sessionId,
          owner_epoch: 1,
        },
      };
    } else if (marker.owner_session !== sessionId) {
      return { marker: current, result: false, preserve: true };
    }
    const sequence = (marker.event_sequence ?? 0) + 1;
    return {
      marker: { ...marker, revision: (marker.revision ?? 0) + 1, event_sequence: sequence, human_sequence: sequence },
      result: true,
    };
  });
}

export function claimCopilotCommand(
  projectDir: string,
  stateContent: string | null,
  input: CopilotCommandClaim,
): CopilotClaimResult {
  if (!input.sessionId || Buffer.byteLength(input.sessionId) > 512 ||
    (input.attemptId !== undefined && Buffer.byteLength(input.attemptId) > 512) ||
    (input.continueToken !== undefined && Buffer.byteLength(input.continueToken) > 16 * 1024) ||
    !/^[0-9a-f]{64}$/.test(input.commandSha256)) return { allowed: false, reason: "recovery" };
  const initialTarget = resolveActiveDirectiveTarget(projectDir);
  const context = activeDirectiveContext(initialTarget, stateContent);
  const boundIntent = readSessionIntentUuid(projectDir, input.sessionId);
  if (boundIntent && boundIntent !== context.intentUuid) supersedeCopilotResumeForIntent(projectDir, input.sessionId, boundIntent);
  return transactActiveDirective<CopilotClaimResult>(projectDir, (current, target) => {
    const context = activeDirectiveContext(target, stateContent);
    let marker = current?.version === 2 && current.project_sha256 === context.projectSha256 && current.intent_uuid === context.intentUuid
      ? current
      : null;
    if (marker && (marker.state_sha256 !== context.stateSha256 || marker.state_present !== context.statePresent)) {
      if (input.commandKind !== "next") {
        return { marker: current, result: { allowed: false, reason: "state" }, preserve: true };
      }
      marker = crossActiveDirectiveBoundary(marker, context.stateSha256, context.intentUuid, context.statePresent);
    }
    const currentStage = stateContent ? (getField(stateContent, "Current Stage")?.trim() || "coordination") : "coordination";
    const liveResume = marker?.resume?.status === "waiting" || marker?.resume?.status === "selected";
    const waitingExact = marker?.resume?.status === "waiting" && marker.owner_session === input.sessionId &&
      marker.resume.issuing_session === input.sessionId && marker.resume.issuing_stage === currentStage &&
      marker.resume.issuing_state_sha256 === context.stateSha256 && marker.resume.issuing_intent_uuid === context.intentUuid;
    const selectedSkip = marker?.resume?.status === "selected" && marker.resume.action === "resume" && input.skipRecovery === true &&
      marker.owner_session === input.sessionId && marker.resume.issuing_session === input.sessionId && marker.resume.issuing_stage === currentStage && input.reportStage === currentStage && marker.resume.issuing_state_sha256 === context.stateSha256 && marker.resume.issuing_intent_uuid === context.intentUuid && marker.kind === "print" && marker.active_attempt?.status === "settled" && marker.active_attempt.command_kind === "next";
    if (input.resumeAction && !waitingExact) {
      return { marker, result: { allowed: false, reason: "resume" }, preserve: marker === current };
    }
    const pending = marker?.active_attempt;
    const tokenSha256 = input.continueToken ? stateContentSha256(input.continueToken) : "";
    const duplicateContinue = marker && pending?.status === "pending" && pending.command_kind === "continue" &&
      input.commandKind === "continue" && marker.kind === "load-steering" && marker.continue_token === input.continueToken &&
      marker.continue_token_sha256 === tokenSha256 && pending.cursor_input_sha256 === tokenSha256 &&
      pending.command_sha256 === input.commandSha256 && pending.session_id === input.sessionId &&
      marker.owner_session === input.sessionId && pending.owner_epoch === marker.owner_epoch &&
      pending.context_epoch === marker.context_epoch && pending.issued_state_sha256 === context.stateSha256 &&
      pending.claim_revision === marker.revision && pending.result_sha256 === undefined && pending.result_revision === undefined;
    if (duplicateContinue && marker?.version === 2 && pending?.id) {
      const reusable = input.attemptId === undefined || input.attemptId === pending.id;
      if (!reusable) return { marker, result: { allowed: false, reason: "duplicate" }, preserve: true };
      if (pending.shared_attempt) return { marker, result: { allowed: true, attemptId: pending.id }, preserve: true };
      const revision = (marker.revision ?? 0) + 1;
      return { marker: { ...marker, revision,
        active_attempt: { ...pending, claim_revision: revision, shared_attempt: true } },
        result: { allowed: true, attemptId: pending.id } };
    }
    if (marker && pending?.status === "pending" && input.attemptId && input.attemptId === pending.id) {
      const reusable = pending.command_sha256 === input.commandSha256 && pending.session_id === input.sessionId &&
        marker.owner_session === input.sessionId && pending.owner_epoch === marker.owner_epoch &&
        pending.context_epoch === marker.context_epoch && pending.issued_state_sha256 === context.stateSha256 && marker.project_sha256 === context.projectSha256 && marker.intent_uuid === context.intentUuid;
      return { marker, result: reusable ? { allowed: true, attemptId: input.attemptId } : { allowed: false, reason: "recovery" }, preserve: true };
    }
    if (input.commandKind === "next") {
      if (liveResume && !input.resumeRequest) {
        const action = marker?.resume?.action;
        const actionFollowup = marker?.owner_session === input.sessionId && marker.resume?.status === "selected" &&
          (action === "resume" && input.plainNext === true ||
            action === "jump" && input.jumpRequest === true ||
            action === "start-fresh" && input.startFreshRequest === true);
        if (!actionFollowup) return { marker, result: { allowed: false, reason: "resume" }, preserve: marker === current };
      }
      marker ??= freshActiveDirectiveMarker(target, stateContent, currentStage);
    } else {
      if (!marker) {
        return { marker: current, result: { allowed: false, reason: "recovery" }, preserve: true };
      }
      if (marker.owner_session !== input.sessionId) {
        return { marker: current, result: { allowed: false, reason: "foreign" }, preserve: true };
      }
      if (liveResume && !(input.commandKind === "report" && (waitingExact && input.resumeAction || selectedSkip)))
        return { marker, result: { allowed: false, reason: "resume" }, preserve: true };
    }
    const takeover = input.commandKind === "next" && marker.owner_session !== input.sessionId;
    const ownerEpoch = takeover ? (marker.owner_epoch ?? 0) + 1 : (marker.owner_epoch ?? 0);
    const sequence = (marker.event_sequence ?? 0) + 1;
    const nextRevision = (marker.revision ?? 0) + 1;
    const attemptId = input.attemptId ?? randomUUID();
      const attempt: ActiveDirectiveAttempt = {
      id: attemptId,
      command_kind: input.commandKind,
      command_sha256: input.commandSha256,
      issued_state_sha256: context.stateSha256,
      session_id: input.sessionId,
      owner_epoch: ownerEpoch,
        context_epoch: marker.context_epoch ?? 0,
        claim_revision: nextRevision,
        status: "pending",
      ...(input.commandKind === "continue" && input.continueToken
        ? { cursor_input_sha256: stateContentSha256(input.continueToken) }
        : {}),
      ...(input.resumeRequest ? { resume_request: true } : {}),
      ...(input.resumeAction ? { resume_action: input.resumeAction } : {}),
      ...(waitingExact ? { resume_gate_revision: nextRevision } : {}),
    };
    return {
      marker: {
        ...marker,
        revision: nextRevision,
        project_sha256: context.projectSha256,
        intent_uuid: context.intentUuid,
        state_present: context.statePresent,
        state_sha256: context.stateSha256,
        owner_session: input.sessionId,
        owner_epoch: ownerEpoch,
        delivery: marker.delivery,
        needs_rehydrate: true,
        active_attempt: attempt,
        event_sequence: sequence,
        engine_sequence: sequence,
        ...(takeover ? { stop_fingerprint: undefined, stop_count: 0 } : {}),
        ...(input.resumeRequest && marker.resume
          ? { resume: { ...marker.resume, status: "superseded" as const } }
          : {}),
      },
      result: { allowed: true, attemptId },
    };
  });
}

export function settleCopilotCommand(
  projectDir: string,
  stateContent: string | null,
  input: CopilotCommandClaim,
  directive: CopilotDirectiveMetadata | null,
): "settled" | "duplicate" | "stale" {
  return transactActiveDirective(projectDir, (marker, target) => {
    const context = activeDirectiveContext(target, stateContent);
    if (marker?.version !== 2) return { marker, result: "stale" as const, preserve: true };
    const attempt = marker.active_attempt;
    if (!attempt) return { marker, result: "stale" as const, preserve: true };
    const exact = attempt.session_id === input.sessionId && attempt.command_kind === input.commandKind &&
      attempt.command_sha256 === input.commandSha256 && attempt.owner_epoch === marker.owner_epoch &&
      attempt.context_epoch === marker.context_epoch && attempt.id === input.attemptId;
    if (!exact) return { marker, result: "stale" as const, preserve: true };
    if (attempt.status === "settled") return { marker, result: "duplicate" as const, preserve: true };
    if (attempt.status !== "pending") return { marker, result: "stale" as const, preserve: true };
    const stateChanged = attempt.issued_state_sha256 !== context.stateSha256 || marker.intent_uuid !== context.intentUuid;
    const base = stateChanged
      ? crossActiveDirectiveBoundary(marker, context.stateSha256, context.intentUuid, context.statePresent)
      : marker;
    if (!directive) {
      if (input.commandKind === "continue" && (attempt.shared_attempt || attempt.result_sha256))
        return { marker, result: "stale" as const, preserve: true };
      return {
        marker: {
          ...(stateChanged ? base : invalidateActiveDirectiveDelivery(base)),
          active_attempt: { ...attempt, status: "failed" },
        },
        result: "settled" as const,
      };
    }
    if (input.commandKind === "continue" && directive.kind === "error") {
      if (attempt.shared_attempt || attempt.result_sha256)
        return { marker, result: "stale" as const, preserve: true };
      return { marker: {
        ...base, revision: (base.revision ?? 0) + 1,
        needs_rehydrate: base.delivery === "delivered" ? false : base.needs_rehydrate,
        active_attempt: { ...attempt, status: "failed" },
      }, result: "settled" as const };
    }
    const retainedKind = ["load-steering", "run-stage", "ask", "done", "parked", "notice"].includes(directive.kind);
    const enginePublished = (input.commandKind === "next" || input.commandKind === "continue") &&
      (directive.kind === "load-steering" || directive.kind === "run-stage");
    const resultBound = !enginePublished ||
      typeof directive.resultSha256 === "string" && directive.resultSha256 === attempt.result_sha256 &&
      Number.isInteger(attempt.result_revision) && (attempt.result_revision ?? 0) <= (marker.revision ?? 0) &&
      marker.kind === directive.kind && marker.stage === (directive.stage ?? marker.stage) &&
      marker.continue_token_sha256 === (directive.continueToken ? stateContentSha256(directive.continueToken) : undefined);
    if (!resultBound) {
      return {
        marker: { ...invalidateActiveDirectiveDelivery(base), active_attempt: { ...attempt, status: "failed" } },
        result: "settled" as const,
      };
    }
    const canDeliver = (input.commandKind === "next" || input.commandKind === "continue") && !stateChanged && retainedKind ||
      input.commandKind === "park" || input.commandKind === "report" && (directive.kind === "done" || directive.kind === "parked");
    let resume = base.resume;
    const canSelectResume = input.commandKind === "report" && attempt.resume_action !== undefined &&
      marker.resume?.status === "waiting" && attempt.resume_gate_revision === marker.revision &&
      marker.resume.issuing_session === input.sessionId && marker.resume.issuing_state_sha256 === context.stateSha256 &&
      marker.resume.issuing_intent_uuid === context.intentUuid &&
      marker.resume.issuing_stage === (stateContent ? getField(stateContent, "Current Stage")?.trim() : marker.stage);
    if (input.commandKind === "report" && attempt.resume_action && (!canSelectResume || directive.kind === "error")) {
      return { marker: { ...invalidateActiveDirectiveDelivery(base), active_attempt: { ...attempt, status: "failed" } }, result: "settled" as const };
    }
    if (canSelectResume) {
      resume = {
        status: "selected",
        action: attempt.resume_action,
        issuing_stage: marker.resume?.issuing_stage ?? marker.stage,
        issuing_state_sha256: marker.resume?.issuing_state_sha256 ?? attempt.issued_state_sha256,
        issuing_session: input.sessionId,
        issuing_intent_uuid: marker.resume?.issuing_intent_uuid ?? context.intentUuid,
      };
    } else if (resume?.status === "selected") {
      const closesResume = resume.action === "resume" && input.commandKind === "next";
      if (closesResume && (directive.kind === "load-steering" || directive.kind === "run-stage")) {
        resume = { ...resume, status: "superseded" };
      }
    }
    if (enginePublished) {
      return {
        marker: {
          ...base,
          revision: (base.revision ?? 0) + 1,
          delivery: canDeliver ? "delivered" : "superseded",
          needs_rehydrate: !canDeliver,
          active_attempt: { ...attempt, status: "settled" },
          ...(resume ? { resume } : {}),
        },
        result: "settled" as const,
      };
    }
    const token = directive.continueToken;
    const unit = directive.kind === "load-steering" ? (directive.unit ?? marker.unit) : directive.unit;
    const next: ActiveDirectiveMarker = {
      ...base,
      revision: (base.revision ?? 0) + 1,
      intent_uuid: context.intentUuid,
      state_present: context.statePresent,
      state_sha256: context.stateSha256,
      kind: directive.kind,
      stage: directive.stage ?? marker.stage,
      ...(unit ? { unit } : { unit: undefined }),
      ...(directive.part ? { part: directive.part } : { part: undefined }),
      ...(directive.parts ? { parts: directive.parts } : { parts: undefined }),
      ...(token ? { continue_token: token, continue_token_sha256: stateContentSha256(token) } : { continue_token: undefined, continue_token_sha256: undefined }),
      delivery: canDeliver ? "delivered" : "superseded",
      needs_rehydrate: !canDeliver,
      active_attempt: { ...attempt, status: "settled" },
      ...(resume ? { resume } : {}),
    };
    return { marker: next, result: "settled" as const };
  });
}

export function copilotStopEvidence(
  projectDir: string,
  stateContent: string,
  sessionId: string,
): CopilotStopEvidence {
  const initialTarget = resolveActiveDirectiveTarget(projectDir);
  const context = activeDirectiveContext(initialTarget, stateContent);
  const boundIntent = readSessionIntentUuid(projectDir, sessionId);
  if (boundIntent && boundIntent !== context.intentUuid) supersedeCopilotResumeForIntent(projectDir, sessionId, boundIntent);
  try {
    return transactActiveDirective<CopilotStopEvidence>(projectDir, (current, target) => {
      const context = activeDirectiveContext(target, stateContent);
      let marker = current;
      if (marker?.version !== 2) {
        const stage = getField(stateContent, "Current Stage")?.trim() || "coordination";
        const fresh = freshActiveDirectiveMarker(target, stateContent, stage);
        marker = {
          ...fresh,
          revision: 1,
          owner_session: sessionId,
          owner_epoch: 1,
          active_attempt: { ...fresh.active_attempt!, id: undefined, session_id: sessionId, owner_epoch: 1 },
        };
      }
      if (marker.owner_session !== sessionId) return { marker, result: { status: "foreign" }, preserve: true };
      if (marker.project_sha256 !== context.projectSha256 || marker.intent_uuid !== context.intentUuid || marker.state_sha256 !== context.stateSha256) {
        marker = crossActiveDirectiveBoundary(marker, context.stateSha256, context.intentUuid, true);
      }
      if (marker.resume?.issuing_session && marker.resume.issuing_session !== sessionId) {
        marker = {
          ...invalidateActiveDirectiveDelivery(marker),
          resume: { ...marker.resume, status: "superseded" },
        };
      }
      if (marker.resume?.status === "waiting" || marker.resume?.status === "selected") {
        return { marker, result: { status: "resume" }, preserve: true };
      }
      const status = marker.delivery === "delivered" && !marker.needs_rehydrate && marker.kind
        ? "directive" as const
        : "recovery" as const;
      return {
        marker,
        result: {
          status,
          ...(status === "directive" ? { directive: {
            kind: marker.kind,
            stage: marker.stage,
            ...(marker.unit ? { unit: marker.unit } : {}),
            ...(marker.part ? { part: marker.part } : {}),
            ...(marker.parts ? { parts: marker.parts } : {}),
            ...(marker.continue_token ? { continueToken: marker.continue_token } : {}),
          } as CopilotDirectiveMetadata } : {}),
          stateSha256: marker.state_sha256,
          tokenSha256: marker.continue_token_sha256 ?? "",
          resumeStatus: marker.resume?.status ?? "none",
          resumeAction: marker.resume?.action ?? "none",
          ownerSession: marker.owner_session ?? sessionId,
          ownerEpoch: marker.owner_epoch ?? 0,
        },
        preserve: marker === current,
      };
    });
  } catch (error) {
    if (error instanceof ActiveDirectiveLockContendedError) return { status: "contended" };
    throw error;
  }
}

export function consumeCopilotConversation(
  projectDir: string,
  stateContent: string,
  sessionId: string,
): boolean {
  return transactActiveDirective(projectDir, (marker, target) => {
    const context = activeDirectiveContext(target, stateContent);
    if (
      marker?.version !== 2 || marker.owner_session !== sessionId || marker.state_sha256 !== context.stateSha256 ||
      (marker.human_sequence ?? 0) <= (marker.engine_sequence ?? 0) ||
      (marker.human_sequence ?? 0) <= (marker.conversation_sequence ?? 0)
    ) return { marker, result: false, preserve: true };
    return {
      marker: {
        ...marker,
        revision: (marker.revision ?? 0) + 1,
        conversation_sequence: marker.human_sequence ?? 0,
      },
      result: true,
    };
  });
}

function supersedeCopilotResumeForIntent(
  projectDir: string, sessionId: string, intentUuid: string, action?: ResumeAction,
): boolean {
  const prior = findIntentByUuid(projectDir, intentUuid);
  if (!prior) return false;
  return transactActiveDirective(projectDir, (marker) => {
    if (marker?.version !== 2 || marker.owner_session !== sessionId ||
      (marker.resume?.status !== "selected" && marker.resume?.status !== "waiting") ||
      (action && marker.resume.action !== action) || marker.resume.issuing_intent_uuid !== intentUuid)
      return { marker, result: false, preserve: true };
    return {
      marker: {
        ...invalidateActiveDirectiveDelivery(marker),
        resume: { ...marker.resume, status: "superseded" },
      },
      result: true,
    };
  }, prior.dirName, prior.space);
}

export function settleCopilotIntentBoundary(projectDir: string, sessionId: string): boolean {
  const handoff = readSessionIntentHandoff(projectDir, sessionId);
  return !!handoff && activeIntentUuid(projectDir) === handoff.toIntentUuid &&
    supersedeCopilotResumeForIntent(projectDir, sessionId, handoff.fromIntentUuid, "start-fresh");
}

export function updateCopilotStopCount(
  projectDir: string,
  stateContent: string,
  sessionId: string,
  fingerprint: string,
  seedAtTwo: boolean,
  cap: number,
): { shouldBlock: boolean; count: number } | null {
  return transactActiveDirective(projectDir, (marker, target) => {
    const context = activeDirectiveContext(target, stateContent);
    if (marker?.version !== 2 || marker.owner_session !== sessionId || marker.project_sha256 !== context.projectSha256 ||
      marker.intent_uuid !== context.intentUuid || marker.state_sha256 !== context.stateSha256) {
      return { marker, result: null, preserve: true };
    }
    const count = marker.stop_fingerprint === fingerprint
      ? (marker.stop_count ?? 0) + 1
      : marker.stop_fingerprint === undefined && seedAtTwo ? 2 : 1;
    return {
      marker: { ...marker, revision: (marker.revision ?? 0) + 1, stop_fingerprint: fingerprint, stop_count: count },
      result: { shouldBlock: count < cap, count },
    };
  });
}

// Per-clone audit SHARD path: `…/intents/<slug>-<id8>/audit/<host>-<clone>.md`.
// The audit trail is committed (vision §5.1) but each clone writes its OWN
// shard so git never merge-conflicts concurrent appends (merge=union was proven
// to corrupt the multi-line blocks). Readers glob `audit/*.md` and merge-sort by
// timestamp — see auditShards()/readAllAuditShards(). With no intent resolved the
// shard lands under the bare space record root (no flat audit.md any more).
export function auditFilePath(projectDir: string, intent?: string, space?: string): string {
  const resolved = resolveRecordDir(projectDir, intent, space);
  if (resolved.dir === null) {
    return join(
      spaceRecordRoot(projectDir, resolved.space),
      "audit",
      auditShardName(projectDir),
    );
  }
  return join(resolved.dir, "audit", auditShardName(projectDir));
}

// The clone-id token file: `aidlc/.aidlc-clone-id`. Workspace-level,
// machine-local, GITIGNORED (see the `aidlc/.aidlc-*` rule) so it never travels
// in a commit — that is what makes the token DISTINCT across clones (a fresh
// checkout has no token file and mints its own). The shard name below embeds
// this token, so every process IN one clone resolves the SAME shard while two
// different clones get DIFFERENT shards (no git merge-conflict on concurrent
// appends — the whole point of per-clone sharding).
export const CLONE_ID_FILE = ".aidlc-clone-id";

export function cloneIdPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), CLONE_ID_FILE);
}

// The stable per-CLONE token (not per-process). Read from the gitignored
// `aidlc/.aidlc-clone-id` file when present; minted (12 hex chars from a v4
// uuid — no Math.random) and persisted on first use otherwise. Stable WITHIN a
// clone across processes (the fork subprocess and the merge subprocess both
// read the same file → the same shard), DISTINCT across clones (each clone
// mints its own; the file is gitignored so it doesn't travel). A read/mint race
// between two first-run processes converges on whichever write lands last; both
// then read that single file on every subsequent call, so the clone settles on
// ONE token (a transient duplicate shard on the very first concurrent mint is
// harmless — readers glob `audit/*.md`). Memoized per process. Best-effort: an
// unwritable workspace degrades to an in-memory token for this process (still
// stable within the process, still distinct from other clones).
const CLONE_IDS = new Map<string, string>();
function cloneId(projectDir: string): string {
  const key = canonicalPathKey(projectDir);
  const cached = CLONE_IDS.get(key);
  if (cached) return cached;
  const path = cloneIdPath(projectDir);
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (/^[a-z0-9]{1,32}$/.test(raw)) {
      CLONE_IDS.set(key, raw);
      return raw;
    }
  } catch {
    // no token yet → mint one below
  }
  const minted = randomUUID().replace(/-/g, "").slice(0, 12);
  try {
    mkdirSync(workspaceRoot(projectDir), { recursive: true });
    writeFileSync(path, `${minted}\n`, "utf-8");
    // Re-read so a concurrent first-run mint that landed first wins for ALL
    // processes in this clone (converge on one on-disk token).
    const settled = readFileSync(path, "utf-8").trim();
    CLONE_IDS.set(
      key,
      /^[a-z0-9]{1,32}$/.test(settled) ? settled : minted,
    );
  } catch {
    CLONE_IDS.set(key, minted); // unwritable workspace → in-memory token
  }
  return CLONE_IDS.get(key)!;
}

export function ensureCloneId(projectDir: string): string {
  return cloneId(projectDir);
}

// --- Human presence at an approval/interview gate ---
//
// Ledger-event presence check (the marker-free design). A real human
// is present for THIS gate-commit iff a HUMAN_TURN event appears AFTER the LAST
// GATE RESOLUTION (GATE_APPROVED / GATE_REJECTED / QUESTION_ANSWERED) in ledger
// append order. The prior resolution is the freshness boundary - this is the
// consume-once semantics expressed as event order instead of a flag.
//
// Why the boundary is the prior RESOLUTION, not this gate's STAGE_AWAITING_APPROVAL
// (the live Kiro IDE spike, 2026-06-30, caught this): in the real flow ONE human
// prompt drives the agent to BOTH open the gate AND approve it, so the human turn
// PRECEDES this gate-open. A "human turn after gate-open" rule false-refuses every
// legitimate approval. But a human turn after the prior gate's resolution still
// proves a fresh human acted this turn, while a fabricated cascade (gate2 approved
// right after gate1 committed, no new human turn) has its only human turn BEFORE
// the gate1 GATE_APPROVED -> refused. Stale (human turn long ago, then a fabricated
// approve) likewise has the last resolution after the human turn -> refused.
//
// Ordering is CHRONOLOGICAL (Timestamp, then per-shard position as the SAME-SHARD
// tiebreak): shards are per-clone files enumerated in FILENAME order (a second
// shard appears after a re-clone or on another machine), so cross-shard position
// carries no execution-order information. Within one shard the timestamps are
// non-decreasing and the position tiebreak preserves append order, which is what
// makes same-second events (the common case: one human turn drives mint + gate +
// resolution inside one second) resolve by execution order. When a candidate
// latest human turn shares one second-precision timestamp with ANY latest
// resolution in a DIFFERENT shard, execution order is unknowable and the check
// fails CLOSED (require a fresh turn) rather than let shard-filename order pick
// a winner. Fail-open when no ledger exists (no presence tracking yet on this
// harness).
//
// The resolution boundary is workflow-global (the most recent gate approval,
// rejection, answered question, summary confirmation, or autonomous grant).
// This makes a same-turn cascade across DIFFERENT stages refuse correctly;
// there is no per-stage scoping. AUTONOMY_MODE_SET only counts when its Mode is
// autonomous because that grant consumes the human turn that unlocks downstream
// presence carve-outs.
export const BLOCKING_SENSOR_OVERRIDE_CHOICE = "Override blocking sensors";
export const BLOCKING_SENSOR_OVERRIDE_DECISION = "Blocking gate sensor failure";
export const BLOCKING_SENSOR_OVERRIDE_OPTIONS = [
  "Fix findings",
  BLOCKING_SENSOR_OVERRIDE_CHOICE,
] as const;

const GATE_RESOLUTION_EVENTS = new Set([
  "GATE_APPROVED",
  "GATE_REJECTED",
  "QUESTION_ANSWERED",
  "SUMMARY_CONFIRMATION_RECORDED",
  "PLAN_APPROVAL_RECORDED",
]);
const DOCUMENT_AUDIT_EVENTS = new Set([
  "DOCUMENT_INDEXED",
  "DOCUMENT_UPDATED",
  "DOCUMENT_REMOVED",
]);
export function humanActedSinceGate(projectDir: string): boolean {
  // Per-shard reads (not the concatenated buffer): buffer position across
  // shards is FILENAME order, not execution order, so it can only serve as an
  // ordering tiebreak WITHIN one shard. Cross-shard same-second ties are
  // genuinely unordered (isoTimestamp is second-precision) and fail closed
  // below.
  const shards = auditShards(projectDir);
  const events: { ts: string; shard: number; pos: number; human: boolean }[] = [];
  let sawPresenceTrackingEvent = false;
  for (let s = 0; s < shards.length; s++) {
    let content: string;
    try {
      content = readAppendOnlyFileNoFollowOrThrow(shards[s], "audit shard").toString("utf-8");
      assertNoSymlinkInChainOrThrow(realpathSync(projectDir), relative(projectDir, shards[s]));
    } catch (e) {
      // ONLY a vanished shard may be skipped. Anything else fails CLOSED:
      // this function feeds gate resolutions and the autonomous-mode
      // escalation, and an unreadable shard may hold the only presence
      // evidence — or the only proof there is none. Treating "could not
      // read" as "was empty" once inverted this gate to fail-open: the
      // space shard (document rows only, exempt from presence tracking)
      // read fine while the intent shard was dropped, `events` came back
      // empty, and the empty-ledger carve-out below answered "a human
      // acted" from a ledger nobody had read.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
    const blocks = content.replace(/\r\n/g, "\n").split(/\n---\n/);
    for (let i = 0; i < blocks.length; i++) {
      const ev = auditBlockField(blocks[i], "Event");
      if (!ev) continue;
      if (!DOCUMENT_AUDIT_EVENTS.has(ev)) sawPresenceTrackingEvent = true;
      const isResolution =
        GATE_RESOLUTION_EVENTS.has(ev) ||
        (ev === "AUTONOMY_MODE_SET" &&
          auditBlockField(blocks[i], "Mode") === "autonomous");
      if (!isResolution && ev !== "HUMAN_TURN") continue;
      events.push({
        ts: auditBlockField(blocks[i], "Timestamp") ?? "",
        shard: s,
        pos: i,
        human: ev === "HUMAN_TURN",
      });
    }
  }
  // DocumentKB provenance does not activate human-presence tracking. Any other
  // audit event does, so a workflow ledger without HUMAN_TURN fails closed.
  if (events.length === 0) return !sawPresenceTrackingEvent;
  const humans = events.filter((event) => event.human);
  if (humans.length === 0) return false; // no human turn on record
  const resolutions = events.filter((event) => !event.human);
  if (resolutions.length === 0) return true;

  const latestHumanTimestamp = humans.reduce(
    (latest, event) => (event.ts > latest ? event.ts : latest),
    "",
  );
  const latestResolutionTimestamp = resolutions.reduce(
    (latest, event) => (event.ts > latest ? event.ts : latest),
    "",
  );
  if (latestHumanTimestamp > latestResolutionTimestamp) return true;
  if (latestHumanTimestamp < latestResolutionTimestamp) return false;

  // At equal second-precision timestamps, one turn must be provably after EVERY
  // latest resolution. A same-shard append position proves that order; a
  // resolution in any other shard remains unordered and therefore consumes the
  // candidate turn fail-closed.
  const latestHumans = humans.filter(
    (event) => event.ts === latestHumanTimestamp,
  );
  const latestResolutions = resolutions.filter(
    (event) => event.ts === latestResolutionTimestamp,
  );
  return latestHumans.some((human) =>
    latestResolutions.every(
      (resolution) =>
        resolution.shard === human.shard && resolution.pos < human.pos,
    )
  );
}

// A cancelled / auto-resolved structured-question widget is NOT a human
// answer. Harnesses that auto-complete a dismissed question hand the conductor
// a completed-looking object whose answer text is cancellation boilerplate
// ("Cancelled", "user dismissed", a timeout marker) — logging that as
// QUESTION_ANSWERED or passing it as an approval choice would launder a
// non-decision into human authority AND consume the turn's HUMAN_TURN. The
// vocabulary is deliberately tight (cancellation/dismissal/timeout semantics
// only): a substantive answer that merely CONTAINS these words ("cancel the
// standing order") does not match, because the whole trimmed string must be
// the cancellation phrase.
const NON_ANSWER_RE =
  /^(?:cancel(?:led|ed)?|cancellation|dismiss(?:ed)?|abort(?:ed)?|timed?[ -]?out|timeout|no (?:answer|response)|(?:user|question) (?:cancel(?:led|ed)|dismissed))[.!]?$/i;
export function isNonAnswer(text: string | undefined | null): boolean {
  const t = (text ?? "").trim();
  return t.length === 0 || NON_ANSWER_RE.test(t);
}

const RECEIVED_REPLY_DISPLAY_LIMIT = 120;
export function formatReceivedReply(text: string | undefined | null): string {
  const normalized = (text ?? "").trim().replace(/\s+/g, " ") || "(empty)";
  const display =
    normalized.length <= RECEIVED_REPLY_DISPLAY_LIMIT
      ? normalized
      : `${normalized.slice(0, RECEIVED_REPLY_DISPLAY_LIMIT - 3)}...`;
  return JSON.stringify(display);
}

// HUMAN_TURN proves only that a prompt-submit seam fired after the previous
// resolution. Several harnesses do not expose trusted prompt text, so the
// framework cannot prove that --user-input/--feedback/--details came from the
// human. This helper enforces the narrower property that IS mechanically
// available: reject recognized, explicit statements that attribute THIS
// authority-bearing decision to the conductor/model. Unlabelled or unknown
// wording deliberately fails open; this is a defense-in-depth tripwire, not an
// authorship boundary.
export type DecisionKind = "approval" | "rejection" | "answer";

export interface SelfAttributionMarker {
  category: "non-human-decision" | "model-authored-decision" | "conductor-default";
  phrase: string;
}

function maskQuotedDecisionExamples(text: string): string {
  const mask = (value: string): string => value.replace(/[^\n]/g, " ");
  return text
    .replace(/(```|~~~)[\s\S]*?\1/g, mask)
    .replace(/(^|\n)[ \t]*(?:```|~~~)[^\n]*(?:\n[\s\S]*|$)/g, mask)
    .replace(/``[^`\n]*``|`[^`\n]*`/g, mask)
    .replace(/^ {0,3}>[^\n]*(?:\n(?!\s*$)[^>\n][^\n]*)*/gm, mask)
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, mask)
    .replace(/(^|[\s([{:])'[^'\n]+'(?=$|[\s)\]},.;:!?])/gm, mask);
}

export function selfAttributedDecisionMarker(
  text: string | undefined | null,
  kind: DecisionKind,
): SelfAttributionMarker | null {
  const original = text ?? "";
  const candidate = maskQuotedDecisionExamples(original);
  const actor = "(?:agent|assistant|conductor|model|ai)";
  const noun = kind === "approval"
    ? "(?:approval|approve|decision|choice|confirmation)"
    : kind === "rejection"
      ? "(?:rejection|reject|decision|choice|change[ -]request|request changes)"
      : "(?:answer|decision|choice|confirmation)";
  const verb = kind === "approval"
    ? "(?:approv(?:e|ed|ing)|choos(?:e|en|ing)|select(?:ed|ing))"
    : kind === "rejection"
      ? "(?:reject(?:ed|ing)?|request(?:ed|ing)? changes|choos(?:e|en|ing)|select(?:ed|ing))"
      : "(?:answer(?:ed|ing)?|respond(?:ed|ing)?|choos(?:e|en|ing)|select(?:ed|ing))";
  const decisionTail = String.raw`(?=(?:\s*(?:[,.;:!?。！？；：，、)）]|$|\b(?:to|because|so|for)\b)|\s+[-–—]))`;
  const categories: Array<{
    category: SelfAttributionMarker["category"];
    regex: RegExp;
  }> = [
    {
      category: "non-human-decision",
      regex: new RegExp(
        String.raw`\b(?:not|isn['’]t)\s+(?:(?:a|the)\s+)?human(?:['’]s)?\s+${noun}\b${decisionTail}`,
        "i",
      ),
    },
    {
      category: "model-authored-decision",
      regex: new RegExp(
        String.raw`(?:^|\n)\s*(?:[A-Z]\.\s*)?${actor}[-\s]+initiated\s+(?:(?:this|the|an?)\s+)?${noun}\b${decisionTail}`,
        "i",
      ),
    },
    {
      category: "model-authored-decision",
      regex: new RegExp(
        String.raw`(?:^|\n)\s*(?:[A-Z]\.\s*)?${actor}[-\s]+(?:authored|generated|recorded|written)\s+(?:(?:this|the|an?)\s+)?${noun}\b${decisionTail}`,
        "i",
      ),
    },
    {
      category: "model-authored-decision",
      regex: new RegExp(
        String.raw`\b${noun}\s+(?:was|is)\s+(?:generated|authored|written|supplied|entered|selected|chosen|made)\s+by\s+(?:(?:an?|the)\s+)?${actor}\b${decisionTail}`,
        "i",
      ),
    },
    {
      category: "model-authored-decision",
      regex: new RegExp(
        String.raw`\bi\s*,?\s+(?:as\s+)?(?:the\s+)?${actor}\s*,?\s+(?:am|have)\s+${verb}\b`,
        "i",
      ),
    },
    {
      category: "model-authored-decision",
      regex: new RegExp(
        String.raw`\b${actor}\s+(?:chose|selected)\s+(?:this\s+)?${noun}\b${decisionTail}`,
        "i",
      ),
    },
    ...(kind === "rejection"
      ? [{
          category: "model-authored-decision" as const,
          regex: new RegExp(String.raw`\b${actor}\s+rejected\s+this\b${decisionTail}`, "i"),
        }]
      : []),
    {
      category: "conductor-default",
      regex: /(?:^|\n)\s*(?:[A-Z]\.\s*)?(?:[^\n]{1,80}?\s[-–—:]\s*)?conductor(?:['’]s)?[ -]+default(?=(?:\s*(?:[,.?!;:。！？；：，、()[\]]|$)|\s+[-–—]))/i,
    },
  ];

  for (const { category, regex } of categories) {
    const match = regex.exec(candidate);
    if (match?.index !== undefined) {
      return {
        category,
        phrase: original.slice(match.index, match.index + match[0].length),
      };
    }
  }
  return null;
}

export function isAutonomousConstructionDecision(
  stateContent: string | null,
  stagePhase: string | null | undefined,
): boolean {
  return stagePhase === "construction" && isAutonomousMode(stateContent);
}

// True when any stage sits at [?] (awaiting-approval) in the state file: the
// "a gate is actually OPEN" predicate for the per-harness preToolUse floors.
// Without it a floor would keep refusing tool calls AFTER a legitimate approval
// (the resolution then follows the turn's only HUMAN_TURN), blocking the
// same-turn continuation the stage protocol mandates.
export function hasOpenGate(stateContent: string | null): boolean {
  if (!stateContent) return false;
  return parseCheckboxes(stateContent).some((c) => c.state === "awaiting-approval");
}

// The interview path (handleAnswer) uses the SAME resolution-boundary check: a
// QUESTION_ANSWERED is itself a gate resolution, so "a human turn since the last
// resolution" gives one-answer-per-human-turn for free. Thin alias for call-site
// readability; both paths share one definition so the predicate cannot drift.
export function humanActedSinceLastAnswer(projectDir: string): boolean {
  return humanActedSinceGate(projectDir);
}

// --- Consolidated-summary confirmation evidence ---
//
// The summary checkpoint is a human judgement that authorizes artifact
// generation. Its markdown answer is useful context, but is not evidence by
// itself: the conductor can write that text. The durable evidence is a
// SUMMARY_CONFIRMATION_RECORDED row carrying this canonical Checkpoint field,
// emitted by `aidlc-log.ts answer --checkpoint summary-confirmation` only after
// a matching prompt record and a fresh HUMAN_TURN. The public audit CLI reserves
// this event, so the conductor cannot mint it through `aidlc-audit append`.
export const SUMMARY_CONFIRMATION_CHECKPOINT =
  "Consolidated Summary Confirmation";
export const SUMMARY_CONFIRMATION_HASH_SCOPE = "confirmed-content-v1";

// Keep an opaque marker where an HTML comment was removed. It preserves the
// required whitespace boundary in `##<!-- comment --> Heading` while allowing
// comments inside a valid heading title.
const INVISIBLE_COMMENT_MARKER = "\u0000";
const INVISIBLE_LINE_MARKER = "\u0001";
const RAW_INVISIBLE_COMMENT_MARKER_ESCAPE = "\u0002";

function stripInvisibleCommentMarkers(line: string): string {
  return line.replaceAll(INVISIBLE_COMMENT_MARKER, "");
}

function restoreVisibleMarkdownMarkers(line: string): string {
  if (line.startsWith(INVISIBLE_LINE_MARKER)) return "";
  return line
    .replaceAll(INVISIBLE_COMMENT_MARKER, "")
    .replaceAll(INVISIBLE_LINE_MARKER, "")
    .replaceAll(RAW_INVISIBLE_COMMENT_MARKER_ESCAPE, INVISIBLE_COMMENT_MARKER);
}

function isEscapedAt(line: string, offset: number): boolean {
  let escapes = 0;
  for (let cursor = offset - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) {
    escapes++;
  }
  return escapes % 2 === 1;
}

type MarkdownContainerSegment =
  | { type: "blockquote" }
  | { type: "list"; indent: number };

function markdownIndentWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    width = character === "\t" ? width + (4 - width % 4) : width + 1;
  }
  return width;
}

function markdownContainerLine(line: string): {
  content: string;
  segments: MarkdownContainerSegment[];
} {
  let candidate = line;
  const segments: MarkdownContainerSegment[] = [];
  while (true) {
    const before = candidate;
    const blockquote = /^ {0,3}>[ \t]?/.exec(candidate);
    if (blockquote) {
      candidate = candidate.slice(blockquote[0].length);
      segments.push({ type: "blockquote" });
      continue;
    }
    const list = /^( {0,3})(?:[*+-]|\d{1,9}[.)])([ \t]+)/.exec(candidate);
    if (list) {
      candidate = candidate.slice(list[0].length);
      segments.push({
        type: "list",
        indent: markdownIndentWidth(list[0]),
      });
      continue;
    }
    if (candidate === before) break;
  }
  return { content: candidate, segments };
}

function stripMarkdownContainerPrefix(line: string): string {
  return markdownContainerLine(line).content;
}

function markdownContainerContinuation(
  line: string,
  segments: MarkdownContainerSegment[],
): string | null {
  let candidate = line;
  for (const segment of segments) {
    if (segment.type === "blockquote") {
      const blockquote = /^ {0,3}>[ \t]?/.exec(candidate);
      if (!blockquote) return null;
      candidate = candidate.slice(blockquote[0].length);
      continue;
    }

    let offset = 0;
    let width = 0;
    while (offset < candidate.length && width < segment.indent) {
      const character = candidate[offset];
      if (character !== " " && character !== "\t") return null;
      width = character === "\t" ? width + (4 - width % 4) : width + 1;
      offset++;
    }
    if (width < segment.indent) return null;
    candidate = candidate.slice(offset);
  }
  return candidate;
}

function isMarkdownBlockBoundary(line: string): boolean {
  return /^ {0,3}(?:#{1,6}(?:[ \t]|$)|[`~]{3,}|(?:=+|-+)[ \t]*$|(?:(?:\*|_|-)[ \t]*){3,}$)/.test(
    line,
  );
}

interface RawHtmlBlockStart {
  end: RegExp;
}

function rawHtmlBlockStart(line: string): RawHtmlBlockStart | null {
  const literal = /^ {0,3}<(script|pre|style|textarea)(?:[ \t>]|$)/i.exec(line);
  if (literal) {
    return {
      end: new RegExp(`</${escapeRegex(literal[1])}>`, "i"),
    };
  }
  return null;
}

function stripInlineCodeSpans(line: string): string {
  const visible: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const start = line.indexOf("`", cursor);
    if (start < 0) {
      visible.push(line.slice(cursor));
      break;
    }
    visible.push(line.slice(cursor, start));
    const end = inlineCodeSpanEnd(line, start);
    if (end === null) {
      // An unclosed inline-code span consumes the rest of this line. Do not
      // inspect its literal HTML-looking text as a raw tag.
      break;
    }
    cursor = end;
  }
  return visible.join("");
}

function inlineCodeSpanEnd(line: string, start: number): number | null {
  let length = 1;
  while (line[start + length] === "`") length++;
  let cursor = start + length;
  while (cursor < line.length) {
    const candidate = line.indexOf("`", cursor);
    if (candidate < 0) return null;
    let candidateLength = 1;
    while (line[candidate + candidateLength] === "`") candidateLength++;
    if (candidateLength === length) return candidate + candidateLength;
    cursor = candidate + candidateLength;
  }
  return null;
}

interface VisibleMarkdownHeading {
  title: string;
  level: number;
  style: "atx" | "setext" | "html";
  nested: boolean;
}

function visibleAtxHeading(line: string): VisibleMarkdownHeading | null {
  const atx = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(line);
  return atx
    ? {
        title: stripInvisibleCommentMarkers(atx[2])
          .replace(/[ \t]+#+[ \t]*$/, "")
        .trim(),
        level: atx[1].length,
        style: "atx",
        nested: false,
      }
    : null;
}

function visibleSetextHeading(
  lines: string[],
  line: number,
): VisibleMarkdownHeading | null {
  const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(
    stripMarkdownContainerPrefix(lines[line]),
  );
  if (line === 0 || !underline) return null;
  const previous = lines[line - 1];
  const visiblePrevious = stripMarkdownContainerPrefix(
    stripInvisibleCommentMarkers(previous),
  );
  if (
    visiblePrevious.trim() === "" ||
    visibleAtxHeading(visiblePrevious) !== null
  ) {
    return null;
  }
  return {
    title: visiblePrevious.trim(),
    level: underline[1][0] === "=" ? 1 : 2,
    style: "setext",
    nested:
      stripMarkdownContainerPrefix(lines[line]) !== lines[line] ||
      stripMarkdownContainerPrefix(previous) !== previous,
  };
}

function isMarkdownAngleLinkDestination(line: string, tagOffset: number): boolean {
  const before = line.slice(0, tagOffset);
  const destination = before.lastIndexOf("](");
  if (destination < 0 || !/^[ \t]*$/.test(before.slice(destination + 2))) {
    return false;
  }
  if (isEscapedAt(before, destination)) return false;
  const label = before.lastIndexOf("[", destination);
  if (label < 0) return false;
  if (isEscapedAt(before, label)) return false;
  const closing = line.indexOf(">", tagOffset + 1);
  return (
    closing >= 0 &&
    /^[ \t]*\)/.test(line.slice(closing + 1))
  );
}

function visibleHtmlHeading(line: string): VisibleMarkdownHeading | null {
  const htmlLine = stripMarkdownContainerPrefix(stripInvisibleCommentMarkers(line));
  // A four-space or tab indentation starts a Markdown code block, so its
  // HTML-looking contents are literal rather than visible headings.
  if (/^(?: {4}|\t)/.test(htmlLine)) return null;
  const codeFreeLine = stripInlineCodeSpans(htmlLine);
  for (let cursor = 0; cursor < codeFreeLine.length; cursor++) {
    if (codeFreeLine[cursor] !== "<") continue;
    if (isMarkdownAngleLinkDestination(codeFreeLine, cursor)) continue;
    if (isEscapedAt(codeFreeLine, cursor)) continue;
    const tagStart = cursor + 1;
    const match = /^h([1-6])\b/i.exec(codeFreeLine.slice(tagStart));
    if (match) {
      return {
        title: `<h${match[1]}>`,
        level: Number(match[1]),
        style: "html",
        nested: !/^\s*<h[1-6]\b/i.test(codeFreeLine),
      };
    }
    // Skip the rest of a non-heading HTML tag, respecting quoted attributes,
    // so `<h2>` in `data-example="<h2>"` is not mistaken for a heading.
    let inQuote: '"' | "'" | null = null;
    for (let end = tagStart; end < codeFreeLine.length; end++) {
      const character = codeFreeLine[end];
      if (inQuote !== null) {
        if (character === inQuote) inQuote = null;
      } else if (character === "'" || character === '"') {
        inQuote = character;
      } else if (character === ">") {
        cursor = end;
        break;
      }
    }
  }
  return null;
}

function visibleH2Title(line: string): string | null {
  const heading = visibleAtxHeading(line);
  return heading?.level === 2 ? heading.title : null;
}

function visibleQuestionId(title: string): string | null {
  const match = /^Q([1-9][0-9]*)(?:[.:](?:[ \t]+.*)?)?$/.exec(title);
  return match ? `Q${match[1]}` : null;
}

function visibleHeading(
  lines: string[],
  line: number,
): VisibleMarkdownHeading | null {
  const candidate = stripMarkdownContainerPrefix(lines[line]);
  const nested = candidate !== lines[line];
  const atx = visibleAtxHeading(candidate);
  if (atx) return { ...atx, nested };
  const setext = visibleSetextHeading(lines, line);
  if (setext) return setext;
  const html = visibleHtmlHeading(candidate);
  return html ? { ...html, nested: nested || html.nested } : null;
}

// Hash the normalized semantic questions content the human confirmed. The
// shared protocol does not impose names on pre-checkpoint sections, while
// follow-up Q<n> sections after an assumption decision remain hashable.
export function summaryConfirmationContentHash(content: string): string {
  const normalized = content.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const visibleLines = visibleMarkdownLines(normalized, {
    preserveCommentBoundaries: true,
  });
  let sawSummary = false;
  let postSummaryAssumptionSeen = false;
  let openExcludedAssumption: number | null = null;
  const excludedRanges: Array<[number, number]> = [];
  const questionIds = new Set<string>();

  const closeExcludedAssumption = (line: number): void => {
    if (openExcludedAssumption !== null) {
      excludedRanges.push([openExcludedAssumption, line]);
      openExcludedAssumption = null;
    }
  };

  for (let line = 0; line < visibleLines.length; line++) {
    const heading = visibleHeading(visibleLines, line);
    if (heading === null) continue;
    const { title } = heading;
    const atxH2 =
      heading.style === "atx" && heading.level === 2 && !heading.nested;

    if (title === SUMMARY_CONFIRMATION_CHECKPOINT && atxH2) {
      if (sawSummary) {
        throw new Error(
          `duplicate H2 section "${SUMMARY_CONFIRMATION_CHECKPOINT}"`,
        );
      }
      sawSummary = true;
      continue;
    }

    if (!sawSummary) {
      if (atxH2) {
        const questionId = visibleQuestionId(title);
        if (questionId !== null) {
          if (questionIds.has(questionId)) {
            throw new Error(`duplicate H2 section "${questionId}"`);
          }
          questionIds.add(questionId);
        }
      }
      continue;
    }

    if (title === "Assumption Confirmation" && atxH2 && sawSummary) {
      if (postSummaryAssumptionSeen) {
        throw new Error('duplicate H2 section "Assumption Confirmation"');
      }
      postSummaryAssumptionSeen = true;
      openExcludedAssumption = line;
      continue;
    }

    const questionId = atxH2 ? visibleQuestionId(title) : null;
    if (
      atxH2 &&
      (title === "Requested Changes Feedback" || questionId !== null)
    ) {
      if (questionId !== null) {
        if (questionIds.has(questionId)) {
          throw new Error(`duplicate H2 section "${questionId}"`);
        }
        questionIds.add(questionId);
      }
      // Follow-up questions may be added after an assumption decision. They
      // are included in a later receipt's digest; only the assumption section
      // itself remains outside the scope.
      closeExcludedAssumption(line);
      continue;
    }

    if (sawSummary) {
      const boundary = !postSummaryAssumptionSeen
        ? 'after the consolidated summary; only Q<n>, "Requested Changes Feedback", or one "Assumption Confirmation" section may follow'
        : 'after "Assumption Confirmation"; only Q<n> or "Requested Changes Feedback" sections may follow';
      const headingKind = heading.style === "html"
        ? `HTML H${heading.level}`
        : heading.style === "setext"
          ? `Setext H${heading.level}`
          : `H${heading.level}`;
      throw new Error(
        `unsupported ${headingKind} heading "${title}" ` +
          boundary,
      );
    }
  }

  if (!sawSummary) {
    throw new Error(
      `missing required H2 section "${SUMMARY_CONFIRMATION_CHECKPOINT}"`,
    );
  }

  closeExcludedAssumption(lines.length);
  const excluded = new Set<number>();
  for (const [start, end] of excludedRanges) {
    for (let line = start; line < end; line++) excluded.add(line);
  }
  const confirmedContent = lines
    .filter((_, line) => !excluded.has(line))
    .join("\n")
    .trimEnd();
  return createHash("sha256")
    .update(confirmedContent, "utf-8")
    .digest("hex");
}

// Read the persisted choice through the same visibility model as the hash
// contract. The generic section extractor intentionally retains comments for
// other callers, so it cannot safely validate this checkpoint.
export function summaryConfirmationAnswer(content: string): string | null {
  const visibleLines = visibleMarkdownLines(content, {
    preserveCommentBoundaries: true,
  });
  let inSummary = false;
  const answers: string[] = [];

  for (const line of visibleLines) {
    const heading = visibleH2Title(line);
    if (heading !== null) {
      if (inSummary) break;
      if (heading === SUMMARY_CONFIRMATION_CHECKPOINT) inSummary = true;
      continue;
    }
    if (!inSummary) continue;
    const answer = /^\[Answer\]:[ \t]*(.*)$/.exec(
      stripInvisibleCommentMarkers(line),
    );
    if (answer) answers.push(answer[1].trim());
  }

  return inSummary && answers.length === 1 ? answers[0] : null;
}

export function summaryConfirmationGuardDisabled(): boolean {
  return process.env.AIDLC_SKIP_SUMMARY_CONFIRMATION_GUARD === "1";
}

// Test-only bypass for synthetic gate-transition fixtures that intentionally
// omit reviewer evidence. Completion paths never honor this variable.
export function reviewerGateGuardDisabled(): boolean {
  return process.env.AIDLC_SKIP_REVIEWER_GATE_GUARD === "1";
}

type SummaryConfirmationStage = Pick<
  StageEntry,
  | "slug"
  | "name"
  | "phase"
  | "outputs"
  | "produces"
  | "optional_produces"
  | "produces_kinds"
  | "for_each"
  | "summary_confirmation"
>;

export type SummaryConfirmationEvidence =
  | { ok: true; required: boolean }
  | { ok: false; message: string };

interface SummaryQuestionFile {
  path: string;
  dir: string;
  unit: string | null;
}

function stageDeclaresSummaryQuestions(
  stage: SummaryConfirmationStage,
): boolean {
  return stage.summary_confirmation === "required";
}

function questionFilesInDir(
  dir: string,
  unit: string | null,
): SummaryQuestionFile[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith("-questions.md"))
      .sort()
      .map((name) => ({ path: join(dir, name), dir, unit }));
  } catch {
    return [];
  }
}

function summaryQuestionFiles(
  projectDir: string,
  stage: SummaryConfirmationStage,
): SummaryQuestionFile[] {
  const rec = recordDir(projectDir);
  if (rec === null) return [];
  if (!isPerUnitStage(stage)) {
    return questionFilesInDir(join(rec, stage.phase, stage.slug), null);
  }

  const constructionDir = join(rec, "construction");
  if (!existsSync(constructionDir)) return [];
  const files: SummaryQuestionFile[] = [];
  try {
    for (const unit of readdirSync(constructionDir).sort()) {
      files.push(
        ...questionFilesInDir(
          join(constructionDir, unit, stage.slug),
          unit,
        ),
      );
    }
  } catch {
    return [];
  }
  return files;
}

function summaryAnswerFromFile(path: string): string | null {
  try {
    return summaryConfirmationAnswer(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function summaryArtifactPaths(
  stage: SummaryConfirmationStage,
  question: SummaryQuestionFile,
): string[] {
  const names = [
    ...(stage.produces ?? []),
    ...(stage.optional_produces ?? []),
  ].filter((name) => !name.endsWith("-questions"));
  return names
    .map((name) => join(question.dir, artifactFilename(name)))
    .filter((path) => existsSync(path));
}

// Verify that every question-bearing iteration has a fresh human-backed
// consolidated-summary receipt and that generated artifacts postdate it.
// `workflow` identifies an isolated run; main-workflow callers omit it.
export function checkSummaryConfirmationEvidence(
  projectDir: string,
  stage: SummaryConfirmationStage,
  options: {
    workflow?: string;
    stateContent?: string | null;
    unit?: string;
  } = {},
): SummaryConfirmationEvidence {
  if (summaryConfirmationGuardDisabled()) {
    return { ok: true, required: false };
  }
  if (
    stage.phase === "initialization" ||
    (
      stage.phase === "construction" &&
      options.stateContent &&
      isAutonomousMode(options.stateContent)
    )
  ) {
    return { ok: true, required: false };
  }
  if (stage.summary_confirmation === undefined) {
    return { ok: true, required: false };
  }

  let questions = summaryQuestionFiles(projectDir, stage);
  if (options.unit !== undefined) {
    questions = questions.filter(
      (question) => question.unit === options.unit,
    );
  }
  const declared = stageDeclaresSummaryQuestions(stage);
  if (questions.length === 0) {
    if (!declared) return { ok: true, required: false };
    const unitText = options.unit ? ` for unit "${options.unit}"` : "";
    return {
      ok: false,
      message:
        `Refusing to complete "${stage.slug}"${unitText}: its question flow has no ` +
        `${stage.slug}-questions.md file. Create and answer the stage questions, ` +
        `then record the consolidated summary checkpoint before generating artifacts.`,
    };
  }
  if (
    declared &&
    isPerUnitStage(stage) &&
    !(
      options.stateContent !== undefined &&
      usesStageLevelPerUnitArtifacts(
        getField(options.stateContent ?? "", "Scope"),
        options.stateContent,
      )
    ) &&
    options.workflow === undefined &&
    options.unit === undefined
  ) {
    const resolution = resolveBoltDag(projectDir);
    if (resolution.state === "malformed") {
      return {
        ok: false,
        message:
          `Refusing to complete "${stage.slug}": its summary-confirmation unit ` +
          `set cannot be resolved because unit-of-work-dependency.md is ${resolution.reason} ` +
          `(${resolution.detail}).`,
      };
    }
    if (resolution.state === "ok") {
      const requiredUnits = resolution.units.filter((unit) =>
        filterProducesByKind(
          stage.produces_kinds,
          stage.produces ?? [],
          resolution.unitKinds?.get(unit) ?? null,
        ).length > 0
      );
      const presentUnits = new Set(
        questions
          .map((question) => question.unit)
          .filter((unit): unit is string => unit !== null),
      );
      const missing = requiredUnits.filter((unit) => !presentUnits.has(unit));
      if (missing.length > 0) {
        return {
          ok: false,
          message:
            `Refusing to complete "${stage.slug}": ${missing.length} applicable ` +
          `units have no questions file or summary confirmation (${missing.join(", ")}).`,
        };
      }
      const requiredUnitSet = new Set(requiredUnits);
      questions = questions.filter(
        (question) =>
          question.unit !== null && requiredUnitSet.has(question.unit),
      );
    }
  }

  const relevant = new Set([
    "WORKFLOW_STARTED",
    "STAGE_STARTED",
    "STAGE_JUMPED",
    "STAGE_COMPLETED",
    "SUMMARY_CONFIRMATION_RECORDED",
    "ARTIFACT_CREATED",
    "ARTIFACT_UPDATED",
  ]);
  const events = readAuditShardEvents(projectDir)
    .filter((entry) => relevant.has(entry.event));
  if (events.length === 0) {
    return {
      ok: false,
      message:
        `Refusing to complete "${stage.slug}": no human-backed consolidated ` +
        "summary confirmation receipt is recorded.",
    };
  }

  const latestFrontier = (candidates: AuditShardEvent[]): AuditShardEvent[] => {
    const byShard = new Map<string, AuditShardEvent>();
    for (const entry of candidates) {
      const previous = byShard.get(entry.shard);
      if (!previous || entry.pos > previous.pos) byShard.set(entry.shard, entry);
    }
    const latestTimestamp = [...byShard.values()].reduce(
      (latest, entry) =>
        entry.timestamp > latest ? entry.timestamp : latest,
      "",
    );
    return [...byShard.values()].filter(
      (entry) => entry.timestamp === latestTimestamp,
    );
  };
  const latestEvent = (
    candidates: AuditShardEvent[],
  ): { event: AuditShardEvent | null; ambiguousTimestamp?: string } => {
    const latest = latestFrontier(candidates);
    if (latest.length > 1) {
      return { event: null, ambiguousTimestamp: latest[0].timestamp };
    }
    return { event: latest[0] ?? null };
  };
  const orderingFailure = (
    evidence: string,
    timestamp: string,
    reconfirm = true,
  ): SummaryConfirmationEvidence => ({
    ok: false,
    message:
      `Refusing to complete "${stage.slug}": ${evidence} share audit Timestamp ` +
      `"${timestamp}" across different shards, so their causal order cannot be ` +
      "proven. " +
      (reconfirm
        ? `Repeat the ${options.workflow === undefined ? "summary" : "isolated summary"} ` +
          "confirmation after that second, then regenerate or re-save each artifact " +
          "so the audit records a strictly later write."
        : "Regenerate or re-save the artifact after that second so the audit " +
          "records a strictly later write."),
  });

  const workflow = options.workflow;
  const unitMajor =
    isPerUnitStage(stage) &&
    getField(options.stateContent ?? "", "Construction Iteration")?.trim() ===
      "unit-major";
  const floorCandidates = events.filter((entry) => {
    const eventWorkflow = auditBlockField(entry.block, "Workflow");
    if (workflow !== undefined) {
      return (
        entry.event === "STAGE_COMPLETED" &&
        eventWorkflow === workflow &&
        auditBlockField(entry.block, "Stage") === stage.slug
      );
    }
    if (eventWorkflow?.startsWith("single-stage:")) return false;
    if (
      entry.event === "WORKFLOW_STARTED" ||
      entry.event === "STAGE_JUMPED"
    ) {
      return true;
    }
    return (
      auditBlockField(entry.block, "Stage") === stage.slug &&
      entry.event === "STAGE_STARTED" &&
      !unitMajor
    );
  });
  const floors = latestFrontier(floorCandidates);
  const afterFloor = (entry: AuditShardEvent): true | false | null => {
    if (floors.length === 0) return true;
    const relations = floors.map((floor): true | false | null => {
      if (entry.shard === floor.shard) return entry.pos > floor.pos;
      if (entry.timestamp !== floor.timestamp) {
        return entry.timestamp > floor.timestamp;
      }
      return null;
    });
    if (relations.every((relation) => relation === true)) return true;
    if (relations.some((relation) => relation === false)) return false;
    return null;
  };

  if (workflow !== undefined && isPerUnitStage(stage)) {
    const candidates = events.filter((entry) =>
      entry.event === "SUMMARY_CONFIRMATION_RECORDED" &&
      auditBlockField(entry.block, "Stage") === stage.slug &&
      auditBlockField(entry.block, "Workflow") === workflow
    );
    const ordered = candidates.filter((entry) => afterFloor(entry) === true);
    const receiptSelection = latestEvent(ordered);
    if (receiptSelection.ambiguousTimestamp !== undefined) {
      return orderingFailure(
        "isolated summary receipts",
        receiptSelection.ambiguousTimestamp,
      );
    }
    const unordered = candidates.filter((entry) => afterFloor(entry) === null);
    if (
      unordered.some((entry) =>
        receiptSelection.event === null ||
        entry.timestamp >= receiptSelection.event.timestamp
      )
    ) {
      return orderingFailure(
        "the isolated-run boundary and summary receipt",
        floors[0]?.timestamp ?? unordered[0].timestamp,
      );
    }
    const receiptFile = receiptSelection.event === null
      ? null
      : auditBlockField(receiptSelection.event.block, "Questions File");
    if (receiptFile !== null) {
      const matched = questions.find(
        (question) =>
          toPosix(relative(projectDir, question.path)) === receiptFile,
      );
      if (matched) questions = [{ ...matched, unit: null }];
    } else if (questions.length === 1) {
      questions = [{ ...questions[0], unit: null }];
    }
  }

  for (const question of questions) {
    const fileAnswer = summaryAnswerFromFile(question.path);
    if (fileAnswer !== "Looks correct") {
      return {
        ok: false,
        message:
          `Refusing to complete "${stage.slug}": ${question.path} must contain ` +
          "exactly one `[Answer]: Looks correct` in its Consolidated Summary " +
          "Confirmation section.",
      };
    }

    const questionRelative = toPosix(relative(projectDir, question.path));
    const receiptCandidates = events.filter((entry) => {
      if (entry.event !== "SUMMARY_CONFIRMATION_RECORDED") return false;
      if (auditBlockField(entry.block, "Stage") !== stage.slug) return false;
      if (
        auditBlockField(entry.block, "Checkpoint") !==
          SUMMARY_CONFIRMATION_CHECKPOINT
      ) {
        return false;
      }
      const eventWorkflow = auditBlockField(entry.block, "Workflow");
      if (workflow !== undefined) {
        if (eventWorkflow !== workflow) return false;
      } else if (eventWorkflow?.startsWith("single-stage:")) {
        return false;
      }
      const eventUnit = auditBlockField(entry.block, "Unit");
      if ((eventUnit ?? null) !== question.unit) return false;
      if (
        eventUnit &&
        !eventMatchesClaimAttempt(projectDir, entry.block, eventUnit)
      ) {
        return false;
      }
      return auditBlockField(entry.block, "Questions File") === questionRelative;
    });
    const orderedReceipts = receiptCandidates.filter(
      (entry) => afterFloor(entry) === true,
    );
    const receiptSelection = latestEvent(orderedReceipts);
    if (receiptSelection.ambiguousTimestamp !== undefined) {
      return orderingFailure(
        "matching summary receipts",
        receiptSelection.ambiguousTimestamp,
      );
    }
    const unorderedReceipts = receiptCandidates.filter(
      (entry) => afterFloor(entry) === null,
    );
    if (
      unorderedReceipts.some((entry) =>
        receiptSelection.event === null ||
        entry.timestamp >= receiptSelection.event.timestamp
      )
    ) {
      return orderingFailure(
        "the current-attempt boundary and matching summary receipt",
        floors[0]?.timestamp ?? unorderedReceipts[0].timestamp,
      );
    }
    const receipt = receiptSelection.event;
    if (
      receipt === null ||
      auditBlockField(receipt.block, "Details") !== "Looks correct"
    ) {
      const unitText = question.unit ? ` for unit "${question.unit}"` : "";
      return {
        ok: false,
        message:
          `Refusing to complete "${stage.slug}"${unitText}: no fresh human-backed ` +
          "consolidated summary confirmation is recorded. Present the summary, " +
          "then run `aidlc-log.ts answer --checkpoint summary-confirmation " +
          `--stage ${stage.slug}${question.unit ? ` --unit "${question.unit}"` : ""}` +
          `${workflow ? " --single" : ""} --details "Looks correct"` +
          " after the human responds.",
      };
    }

    const hashScope = auditBlockField(receipt.block, "Hash Scope");
    const recovery = workflow === undefined
      ? (
        "First repair the questions file: reset the existing consolidated-summary " +
        "`[Answer]:` tag to blank and remove or repair every invalid or duplicate " +
        "post-summary section named by the validation error. Only then re-present the " +
        "consolidated summary and record a fresh confirmation with " +
        `\`aidlc-log.ts decision --checkpoint summary-confirmation --stage "${stage.slug}" ` +
        `${question.unit ? `--unit "${question.unit}" ` : ""}` +
        "--questions-file \"<path>\" --decision \"Does this all look correct?\"`; " +
        "end the turn, wait for the human's response, update the recorded answer, then run " +
        `\`aidlc-log.ts answer --checkpoint summary-confirmation --stage "${stage.slug}" ` +
        `${question.unit ? `--unit "${question.unit}" ` : ""}` +
        "--questions-file \"<path>\" --details \"Looks correct\"`. Re-save each generated " +
        "artifact, rerun the section-12a reviewer when this stage declares one, then retry " +
        "the stage completion command. If a completion gate is already open or a terminal " +
        "section-12a receipt freezes artifact writes, instead present Request Changes and " +
        "end the turn. After a fresh human turn choosing it, run " +
        `\`aidlc-orchestrate.ts report --stage "${stage.slug}" --result rejected ` +
        "--user-input \"Request Changes\" --reason \"<requested changes>\"`; then revise and re-confirm the summary, " +
        "re-save the artifacts, rerun the reviewer, and report `--result revised`."
      )
      : (
        "First repair the questions file: reset the existing consolidated-summary " +
        "`[Answer]:` tag to blank and remove or repair every invalid or duplicate " +
        "post-summary section named by the validation error. Only then re-present the " +
        "consolidated summary in the isolated run and record a fresh confirmation with " +
        `\`aidlc-log.ts decision --checkpoint summary-confirmation --stage "${stage.slug}" ` +
        "--questions-file \"<path>\" --single --decision \"Does this all look correct?\"`; " +
        "end the turn, wait for the human's response, update the recorded answer, then run " +
        `\`aidlc-log.ts answer --checkpoint summary-confirmation --stage "${stage.slug}" ` +
        "--questions-file \"<path>\" --single --details \"Looks correct\"`. Regenerate or " +
        "re-save each generated artifact, rerun the section-12a reviewer when this stage " +
        "declares one, then run `aidlc-orchestrate.ts report --single " +
        `--stage "${stage.slug}" --result completed\`.`
      );
    if (
      hashScope !== null &&
      hashScope !== SUMMARY_CONFIRMATION_HASH_SCOPE
    ) {
      return {
        ok: false,
        message:
          `Refusing to complete "${stage.slug}": unsupported summary-confirmation ` +
          `Hash Scope "${hashScope}". ${recovery}`,
      };
    }
    const legacyRecovery =
      hashScope === null
        ? "This is a legacy unscoped receipt, so it still verifies the whole " +
          "questions file; an allowed post-confirmation append therefore requires " +
          "reconfirmation to create a new scoped receipt. "
        : "";
    const recoveryMessage = legacyRecovery + recovery;
    // A receipt verifies the questions file under the scope IT recorded:
    // unscoped legacy receipts cover the whole file, scoped ones cover the
    // confirmed content. Resolve per receipt so a duplicate-confirmation check
    // never compares one receipt's digest against another's scope. Returns
    // null for an unreadable file or an unknown scope, which fails closed at
    // every call site.
    const scopeHashes = new Map<string, string | null>();
    const questionHashForScope = (scope: string | null): string | null => {
      const key = scope ?? "";
      const cached = scopeHashes.get(key);
      if (cached !== undefined) return cached;
      let value: string | null = null;
      try {
        if (scope === null) {
          value = createHash("sha256")
            .update(readFileSync(question.path))
            .digest("hex");
        } else if (scope === SUMMARY_CONFIRMATION_HASH_SCOPE) {
          value = summaryConfirmationContentHash(
            readFileSync(question.path, "utf-8"),
          );
        }
      } catch {
        value = null;
      }
      scopeHashes.set(key, value);
      return value;
    };
    let currentHash: string;
    try {
      currentHash = hashScope === null
        ? createHash("sha256").update(readFileSync(question.path)).digest("hex")
        : summaryConfirmationContentHash(
          readFileSync(question.path, "utf-8"),
        );
    } catch (e) {
      return {
        ok: false,
        message:
          `Refusing to complete "${stage.slug}": ${question.path} cannot be ` +
          `validated against its summary confirmation: ${errorMessage(e)}. ${recoveryMessage}`,
      };
    }
    if (
      auditBlockField(receipt.block, "Questions SHA-256") !== currentHash
    ) {
      return {
        ok: false,
        message:
          `Refusing to complete "${stage.slug}": ${question.path} changed after ` +
          `the human confirmed its summary. ${recoveryMessage}`,
      };
    }

    for (const artifact of summaryArtifactPaths(stage, question)) {
      const artifactAbs = resolvePath(artifact);
      const artifactSuffix = "/" + toPosix(relative(projectDir, artifactAbs));
      const writes = events.filter((entry) => {
        if (
          entry.event !== "ARTIFACT_CREATED" &&
          entry.event !== "ARTIFACT_UPDATED"
        ) {
          return false;
        }
        const file = auditBlockField(entry.block, "File");
        if (file === null) return false;
        const norm = file.replace(/\\/g, "/");
        return (
          resolveAuditProjectPath(projectDir, file) === artifactAbs ||
          // #863: preserve writes across workspace moves. The leading slash
          // and full space/intent/phase/stage tail prevent partial matches.
          norm.endsWith(artifactSuffix)
        );
      });
      const strictlyAfter = (
        later: AuditShardEvent,
        earlier: AuditShardEvent,
      ): boolean => {
        if (later.shard === earlier.shard) return later.pos > earlier.pos;
        if (later.timestamp !== earlier.timestamp) {
          return later.timestamp > earlier.timestamp;
        }
        return false;
      };
      const writeAfterReceipt = writes.some((entry) =>
        strictlyAfter(entry, receipt)
      );
      // Re-confirming the SAME answers does not revoke the authorization an
      // earlier identical confirmation already exercised. A re-record made
      // only to repair the prompt/turn handshake would otherwise demand that
      // an already-reviewed document be written again, which the review freeze
      // forbids - the deadlock this guard is not allowed to create. The
      // candidate must sit in this attempt window, precede both the selected
      // receipt and a real write, carry the positive choice, and cover the
      // answers as they are NOW under its own Hash Scope.
      const earlierIdenticalConfirmationAuthorizesWrite = !writeAfterReceipt &&
        orderedReceipts.some((candidate) => {
          if (candidate === receipt) return false;
          if (!strictlyAfter(receipt, candidate)) return false;
          if (auditBlockField(candidate.block, "Details") !== "Looks correct") {
            return false;
          }
          const candidateHash = questionHashForScope(
            auditBlockField(candidate.block, "Hash Scope"),
          );
          if (
            candidateHash === null ||
            auditBlockField(candidate.block, "Questions SHA-256") !==
              candidateHash
          ) {
            return false;
          }
          return writes.some((entry) => strictlyAfter(entry, candidate));
        });
      if (!writeAfterReceipt && !earlierIdenticalConfirmationAuthorizesWrite) {
        const unorderedWrite = writes.find((entry) =>
          entry.timestamp === receipt.timestamp && entry.shard !== receipt.shard
        );
        if (unorderedWrite !== undefined) {
          return orderingFailure(
            "the summary receipt and artifact write",
            receipt.timestamp,
            false,
          );
        }
        return {
          ok: false,
          message:
            `Refusing to continue "${stage.slug}": this stage's output document ` +
            `${artifact} was not saved after the confirmed answers. Save the ` +
            "document after confirmation, then continue.",
        };
      }
    }
  }

  return { ok: true, required: true };
}

// Read the FIRST `**Field**: value` line from one audit block (tolerates an
// optional leading `- ` so it serves both audit blocks and the state file).
// IMPORTANT: a duplicated field still returns only its first value. Do not
// build authenticate-then-re-read flows on this helper: a verifier and consumer
// can otherwise disagree about which occurrence, and therefore which bytes,
// they mean. Callers that require uniqueness must reject duplicates separately.
// Mirrors the per-tool private auditField readers; shared here for
// humanActedSinceGate.
export function auditBlockField(block: string, fieldName: string): string | null {
  const prefix = `**${fieldName}**:`;
  for (const raw of block.split("\n")) {
    const line = raw.startsWith("- ") ? raw.slice(2) : raw;
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

// A DECISION_RECORDED / QUESTION_ANSWERED pair is the durable handshake for a
// non-gate question. Return true when the named stage has an open decision in
// chronological audit order. `afterEvent` scopes the scan to the most recent
// matching main-workflow boundary; synthetic `--single` rows do not reset that
// window. This distinguishes questions opened in the current stage attempt or
// after an approval gate from earlier interactions.
export function hasPendingDecision(
  projectDir: string,
  stage: string,
  afterEvent?: string,
  unit?: string,
  workflowAttempt = false,
): boolean {
  if (!workflowAttempt) {
    const audit = readAllAuditShards(projectDir);
    if (audit.length === 0) return false;
    const relevant = new Set([
      "DECISION_RECORDED",
      "QUESTION_ANSWERED",
      ...(afterEvent ? [afterEvent] : []),
    ]);
    const events = audit
      .replace(/\r\n/g, "\n")
      .split(/\n---\n/)
      .map((block, position) => ({
        event: auditBlockField(block, "Event") ?? "",
        stage: auditBlockField(block, "Stage"),
        workflow: auditBlockField(block, "Workflow"),
        timestamp: auditBlockField(block, "Timestamp") ?? "",
        position,
      }))
      .filter((event) => relevant.has(event.event))
      .sort((a, b) => {
        if (a.timestamp !== b.timestamp) {
          return a.timestamp < b.timestamp ? -1 : 1;
        }
        return a.position - b.position;
      });
    let start = 0;
    if (afterEvent) {
      const boundary = events.findLastIndex(
        (event) =>
          event.event === afterEvent &&
          event.stage === stage &&
          !event.workflow?.startsWith("single-stage:"),
      );
      if (boundary === -1) return false;
      start = boundary + 1;
    }
    let pending = false;
    for (const event of events.slice(start)) {
      if (event.stage !== stage) continue;
      if (event.event === "DECISION_RECORDED") {
        pending = true;
      } else if (event.event === "QUESTION_ANSWERED") {
        pending = false;
      }
    }
    return pending;
  }

  const relevant = new Set([
    "DECISION_RECORDED",
    "QUESTION_ANSWERED",
    ...(afterEvent ? [afterEvent] : []),
    ...(workflowAttempt ? ["WORKFLOW_STARTED", "STAGE_JUMPED"] : []),
  ]);
  const events = readAuditShardEvents(projectDir)
    .filter((row) => relevant.has(row.event))
    .map((row) => ({
      ...row,
      stage: auditBlockField(row.block, "Stage"),
      unit: auditBlockField(row.block, "Unit"),
      workflow: auditBlockField(row.block, "Workflow"),
    }))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    });
  if (events.length === 0) return false;
  const lastAtTimestamp = new Map<string, number>();
  const shardsAtTimestamp = new Map<string, Set<string>>();
  for (let i = 0; i < events.length; i++) {
    lastAtTimestamp.set(events[i].timestamp, i);
    const shards = shardsAtTimestamp.get(events[i].timestamp) ?? new Set();
    shards.add(events[i].shard);
    shardsAtTimestamp.set(events[i].timestamp, shards);
  }
  const afterBoundary = (index: number): number =>
    (shardsAtTimestamp.get(events[index].timestamp)?.size ?? 0) > 1
      ? (lastAtTimestamp.get(events[index].timestamp) ?? index) + 1
      : index + 1;

  let start = 0;
  if (workflowAttempt) {
    const boundary = events.findLastIndex(
      (event) =>
        event.event === "WORKFLOW_STARTED" || event.event === "STAGE_JUMPED",
    );
    if (boundary >= 0) start = afterBoundary(boundary);
  } else if (afterEvent) {
    const boundary = events.findLastIndex(
      (event) =>
        event.event === afterEvent &&
        event.stage === stage &&
        !event.workflow?.startsWith("single-stage:"),
    );
    if (boundary === -1) return false;
    start = afterBoundary(boundary);
  }

  let pending = false;
  for (let groupStart = start; groupStart < events.length;) {
    let groupEnd = groupStart + 1;
    while (
      groupEnd < events.length &&
      events[groupEnd].timestamp === events[groupStart].timestamp
    ) {
      groupEnd++;
    }
    const matching = events
      .slice(groupStart, groupEnd)
      .filter(
        (event) =>
          event.stage === stage &&
          (unit === undefined || event.unit === unit) &&
          (
            event.event === "DECISION_RECORDED" ||
            event.event === "QUESTION_ANSWERED"
          ),
      );
    const matchingShards = new Set(matching.map((event) => event.shard));
    const matchingEvents = new Set(matching.map((event) => event.event));
    if (matchingShards.size > 1 && matchingEvents.size > 1) {
      pending = false;
    } else {
      for (const event of matching) {
        pending = event.event === "DECISION_RECORDED";
      }
    }
    groupStart = groupEnd;
  }
  return pending;
}

// This clone's audit shard filename: `<host>-<clone-id>.md`. The clone-id token
// (not the PID) is the cross-clone disambiguator — stable across every process
// in a clone (so the fork process and the merge process resolve ONE shard) and
// distinct across clones (so concurrent clones never collide / git-conflict).
// hostname() is a human-readable hint only; it can carry dots/uppercase, so
// normalise it to the slug shape it never escapes the audit dir.
const AUDIT_SHARD_NAMES = new Map<string, string>();
export function auditShardName(projectDir: string): string {
  const key = canonicalPathKey(projectDir);
  const scoped = applicableTeamUnitScopeStamp(projectDir);
  if (scoped?.audit_shard && /^[A-Za-z0-9._-]+\.md$/.test(scoped.audit_shard)) {
    return scoped.audit_shard;
  }
  const cached = AUDIT_SHARD_NAMES.get(key);
  if (cached) return cached;
  const host = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "host";
  const name = `${host}-${cloneId(projectDir)}.md`;
  AUDIT_SHARD_NAMES.set(key, name);
  return name;
}

// `…/intents/<slug>-<id8>/audit/` — the shard directory, or null when no intent
// resolves (the bare space root has no audit dir, so an enumerator gets []).
export function auditShardDir(projectDir: string, intent?: string, space?: string): string | null {
  const dir = recordDir(projectDir, intent, space);
  if (dir === null) return null;
  return join(dir, "audit");
}

// Every audit shard selected by the caller (sorted). Normal intent readers stay
// intent-only, whether the intent is explicit or resolved from the active cursor.
// The deliberate `undefined intent + explicit space` form adds the space-level
// shard before the resolved intent shards; DocumentKB recovery and doctor/export
// use that form because space-level provenance is part of their read model.
// PRE-CREATION PARITY: when NO intent resolves at all, the space shard IS the
// ledger — the append side's auditFilePath falls back to it, so the read side
// must too, or a project with no intents yet reads an empty ledger where its
// own appends just landed (that broke 10 fixture suites when this narrowing
// first shipped without the fallback; base v2 always read the space shard in
// that state).
// Readers merge-sort parsed events by **Timestamp**.
export function auditShards(
  projectDir: string,
  intent?: string,
  space?: string,
  unreadableLocations?: string[],
): string[] {
  const dirs: string[] = [];
  if (intent === undefined && space !== undefined) {
    dirs.push(join(spaceRecordRoot(projectDir, space), "audit"));
  }
  const resolved = resolveRecordDir(projectDir, intent, space);
  const intentDir =
    resolved.dir === null ? null : join(resolved.dir, "audit");
  if (intentDir !== null && !dirs.includes(intentDir)) dirs.push(intentDir);
  if (intentDir === null && dirs.length === 0) {
    dirs.push(join(spaceRecordRoot(projectDir, resolved.space), "audit"));
  }
  const paths: string[] = [];
  for (const shardDir of dirs) {
    try {
      assertNoSymlinkInChainOrThrow(projectDir, relative(projectDir, shardDir));
    } catch {
      unreadableLocations?.push(shardDir);
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(shardDir);
    } catch {
      if (existsSync(shardDir)) unreadableLocations?.push(shardDir);
      continue;
    }
    for (const file of entries.sort()) {
      if (file.endsWith(".md")) paths.push(join(shardDir, file));
    }
  }
  // Explicit-space aggregation keeps the resolved intent last for the few
  // diagnostic paths that inspect the raw audit tail.
  return paths;
}

// Concatenate every audit shard's content for an intent into one buffer the
// existing block-parsers (findAllEvents / findLatestEvent — both split on
// `\n---\n`) can walk as if it were one file. Each shard is a self-contained
// sequence of `\n---\n`-separated blocks, so concatenation preserves block
// boundaries; cross-shard ordering by timestamp is the parsers' job (they read
// **Timestamp** per block). Returns "" when no shard exists.
export function readAllAuditShards(projectDir: string, intent?: string, space?: string): string {
  const shards = auditShards(projectDir, intent, space);
  if (shards.length === 0) return "";
  const parts: string[] = [];
  for (const path of shards) {
    try {
      const content = readAppendOnlyFileNoFollowOrThrow(path, "audit shard").toString("utf-8");
      assertNoSymlinkInChainOrThrow(realpathSync(projectDir), relative(projectDir, path));
      parts.push(content);
    } catch {
      // A vanished shard (ENOENT race) or a refused one (symlinked chain,
      // wrong kind) — skip it. Growth during the read is NOT a failure here:
      // the append-only reader tolerates it, so a live ledger being appended
      // to no longer drops its whole shard from this merge.
    }
  }
  return parts.join("\n");
}

export interface AuditShardEvent {
  block: string;
  event: string;
  pos: number;
  shard: string;
  shardIndex: number;
  timestamp: string;
}

// Preserve shard identity while parsing audit rows. A concatenated audit buffer
// can preserve append order only within one shard; equal second-precision
// timestamps across shards are causally unordered and must not be resolved by
// filename position when authority or attempt freshness depends on the result.
export function readAuditShardEvents(
  projectDir: string,
  intent?: string,
  space?: string,
  unreadableShards?: string[],
): AuditShardEvent[] {
  const rows: AuditShardEvent[] = [];
  const shards = auditShards(
    projectDir,
    intent,
    space,
    unreadableShards,
  );
  for (let shardIndex = 0; shardIndex < shards.length; shardIndex++) {
    let content: string;
    try {
      content = readAppendOnlyFileNoFollowOrThrow(
        shards[shardIndex],
        "audit shard",
      ).toString("utf-8");
      assertNoSymlinkInChainOrThrow(
        realpathSync(projectDir),
        relative(projectDir, shards[shardIndex]),
      );
    } catch {
      unreadableShards?.push(shards[shardIndex]);
      continue; // vanished or refused shard; growth during read is tolerated
    }
    const blocks = content.replace(/\r\n/g, "\n").split(/\n---\n/);
    for (let pos = 0; pos < blocks.length; pos++) {
      const event = auditBlockField(blocks[pos], "Event");
      const timestamp = auditBlockField(blocks[pos], "Timestamp");
      if (!event || !timestamp) continue;
      rows.push({
        block: blocks[pos],
        event,
        pos,
        shard: shards[shardIndex],
        shardIndex,
        timestamp,
      });
    }
  }
  return rows;
}

export function worktreePath(projectDir: string, boltSlug: string): string {
  return join(projectDir, ".aidlc", "worktrees", `bolt-${boltSlug}`);
}

export function resolveAuditProjectPath(
  projectDir: string,
  recordedPath: string,
): string {
  if (recordedPath === "<project-dir>") return resolvePath(projectDir);
  if (
    recordedPath.startsWith("<project-dir>/") ||
    recordedPath.startsWith("<project-dir>\\")
  ) {
    return resolvePath(
      projectDir,
      recordedPath.slice("<project-dir>".length + 1),
    );
  }
  return isAbsolute(recordedPath)
    ? recordedPath
    : resolvePath(projectDir, recordedPath);
}

export function resolveAuditWorktreePath(
  projectDir: string,
  recordedPath: string,
): string {
  return resolveAuditProjectPath(projectDir, recordedPath);
}

// --- Fresh review receipts (the §12a completion precondition's scan) -----------
//
// ONE implementation, TWO consumers with opposite polarities:
//   - aidlc-state.ts verifyReviewerPrecondition (approve/advance/finalize/
//     complete-workflow) REFUSES completion when no fresh terminal receipt
//     covers the stage/unit;
//   - hooks/aidlc-review-freeze.ts REFUSES a produces[] write while a fresh
//     READY receipt covers it (the write would invalidate the receipt and
//     re-open the completion refusal - the receipt-invalidation loop).
// Sharing the scan is load-bearing: if the two ever diverged, the hook could
// block writes the engine would accept, or miss writes the engine will refuse.

// True when a written File path (from an ARTIFACT_CREATED/ARTIFACT_UPDATED audit
// row, or a PreToolUse file_path) is one of the stage's declared produces[]
// artifacts. Matches on the path suffix `/<slug>/<artifact filename>` rather than
// resolving one absolute dir, so it covers BOTH the standard
// <record>/<phase>/<slug>/ layout AND the per-unit construction/<unit>/<slug>/
// layout without needing to know the {unit} segment. Codekb stages get their
// own arm: their produces live DIRECTLY under a per-repo dir beneath the space
// codekb root (codekb/<repo>/<name>.md) with no <slug> segment anywhere, so the
// suffix idiom matches the codekb marker + one repo segment instead. When the
// active intent records repos, that segment must belong to the recorded set so
// a write to one repo's durable codekb cannot revise an unrelated intent. The
// audit File field is stored forward-slash-normalised (aidlc-write-audit-log.ts),
// so the forward-slash matching is harness-neutral; we still normalise
// defensively in case a caller passes a raw OS path.
export function producesArtifactFile(
  stage: { slug: string; produces?: string[] },
  file: string,
  recordedRepos: ReadonlySet<string>
): boolean {
  const produces = stage.produces ?? [];
  if (produces.length === 0) return false;
  const norm = file.replace(/\\/g, "/");
  if (KNOWN_CODEKB_STAGES.has(stage.slug)) {
    return produces.some((name) => {
      const filename = artifactFilename(name);
      const idx = norm.lastIndexOf(`/${filename}`);
      if (idx === -1 || idx + `/${filename}`.length !== norm.length) return false;
      // Exactly one <repo> segment between /codekb/ and /<name>.md.
      const head = norm.slice(0, idx);
      const repoSlash = head.lastIndexOf("/");
      if (repoSlash === -1 || !head.slice(0, repoSlash).endsWith("/codekb")) return false;
      const repo = head.slice(repoSlash + 1);
      if (repo.length === 0) return false;
      // An empty registry is the legacy projectDir-is-the-repo case. Keep the
      // historical any-repo match: codekbRepoName's basename is a write-path
      // default, not ownership evidence for durable files that may predate repo
      // recording or have been written with an explicit repo target.
      return recordedRepos.size === 0 || recordedRepos.has(repo);
    });
  }
  return produces.some((name) =>
    norm.endsWith(`/${stage.slug}/${artifactFilename(name)}`)
  );
}

// Resolve the unit targeted by a declared produces[] write. `undefined` means
// the file does not belong to this stage, `null` means a matching stage-level
// artifact (or an ambiguous per-unit path), and a string names the per-unit
// Construction target.
export function producesArtifactUnit(
  stage: {
    slug: string;
    for_each?: string;
    produces?: string[];
    optional_produces?: string[];
  },
  file: string,
  recordedRepos: ReadonlySet<string>,
): string | null | undefined {
  const reviewedArtifacts = [
    ...(stage.produces ?? []),
    ...(stage.optional_produces ?? []),
  ];
  if (
    !producesArtifactFile(
      { slug: stage.slug, produces: reviewedArtifacts },
      file,
      recordedRepos,
    )
  ) {
    return undefined;
  }
  if (stage.for_each !== "unit-of-work") return null;

  const norm = file.replace(/\\/g, "/");
  for (const name of reviewedArtifacts) {
    const suffix = `/${stage.slug}/${artifactFilename(name)}`;
    if (!norm.endsWith(suffix)) continue;
    const parent = norm.slice(0, -suffix.length);
    const marker = "/construction/";
    const markerIdx = parent.lastIndexOf(marker);
    if (markerIdx === -1) return null;
    const unit = parent.slice(markerIdx + marker.length);
    return unit.length > 0 && !unit.includes("/") ? unit : null;
  }
  return null;
}

export type ReviewVerdict = "READY" | "NOT-READY";
export type ReviewRecoveryCause = "artifact" | "source" | "artifact+source";

export function terminalReviewVerdict(
  verdict: string | null,
  iteration: string | null,
  reviewClass: ReviewClass,
  maxIterations = 2,
): ReviewVerdict | null {
  if (reviewClass === "none") return null;
  if (verdict === "READY") return verdict;
  if (
    verdict === "NOT-READY" &&
    iteration !== null &&
    /^[1-9][0-9]*$/.test(iteration) &&
    (reviewClass === "advisory" || Number(iteration) >= maxIterations)
  ) {
    return verdict;
  }
  return null;
}

export interface PendingReviewProgress {
  state: "outstanding" | "retry-required" | "repair-required";
  iteration: number;
  recovery: boolean;
  suspensionActive: boolean;
  recoveryCause?: ReviewRecoveryCause | null;
}

export interface StaleReviewProgress {
  nextIteration: number;
  recoverySpent: boolean;
}

export type SourceBaselineResult =
  | { state: "legacy" }
  | { state: "unbindable" }
  | { state: "invalid" }
  | { state: "ready"; listing: WorkspaceSourceListing };

export interface FreshReviewReceipts {
  /** Verdict of the last fresh terminal receipt without a Unit field, or null
   *  when none survives. Per-unit receipts live only in unitVerdicts. */
  stageVerdict: ReviewVerdict | null;
  /** A terminal stage-level receipt existed in the current attempt but was
   *  invalidated by a later declared-artifact write or fingerprint mismatch. */
  stageStale: boolean;
  /** Last fresh verdict per unit. A later write to that unit's declared
   *  artifacts deletes the entry; an ambiguous matching path fails closed by
   *  clearing every unit entry. */
  unitVerdicts: Map<string, ReviewVerdict>;
  /** Newest Source Fingerprint carried by a receipt with a syntactically valid
   *  Artifact Fingerprint. Current artifact equality still controls verdict
   *  freshness independently; fieldless migration receipts do not erase an
   *  earlier fingerprinted receipt. */
  newestSourceFingerprint: string | null;
  /** Unit on the newest terminal source-bound receipt, or null for stage-level. */
  newestSourceUnit: string | null;
  /** The newest modern source binding no longer proves the current workspace. */
  sourceStale: boolean;
  /** Recovery ordinal/budget state associated with the newest source binding. */
  sourceStaleProgress: StaleReviewProgress | null;
  /** A workspace-global source-staleness recovery request has been emitted in
   *  this attempt. Source binding is global even when receipts are per-unit. */
  sourceRecoverySpent: boolean;
  /** Units whose terminal receipt was invalidated in the current attempt. */
  unitStale: Set<string>;
  /** Validated modern claim model for every unit whose receipt remains fresh. */
  freshUnitClaims: Map<string, SourceClaimModel>;
  /** Effective stage-entry source baseline for unclaimed-path verification. */
  sourceBaseline: SourceBaselineResult;
  /** Current source listing from the guard's single workspace walk, when needed. */
  currentSourceListing: WorkspaceSourceListing | null;
  /** Next request ordinal and recovery availability for a stale stage receipt. */
  stageStaleProgress: StaleReviewProgress | null;
  /** Next request ordinal and recovery availability for stale unit receipts. */
  unitStaleProgress: Map<string, StaleReviewProgress>;
  stageIteration: number | null;
  unitIterations: Map<string, number>;
  stagePending: PendingReviewProgress | null;
  unitPending: Map<string, PendingReviewProgress>;
  /**
   * Units with a merge-confirmed Bolt attempt. A name-only attempt is
   * confirmed by its BOLT_COMPLETED row; a slug-backed (worktree) attempt is
   * confirmed only when a matching later AUDIT_MERGED proves the state and
   * audit merge sequence landed.
   */
  mergedBoltUnits: Set<string>;
  /**
   * Units whose latest paired Bolt attempt is still open or completed but
   * awaiting merge evidence.
   */
  openBoltUnits: Set<string>;
}

export interface ReviewFingerprintStage {
  slug: string;
  phase: string;
  for_each?: string;
  reviewer?: string;
  review_artifact?: string;
  workspace_requires?: boolean;
  produces?: string[];
  optional_produces?: string[];
  produces_kinds?: Record<string, string[]>;
}

export interface ReviewArtifactEntry {
  logicalPath: string;
  path: string | null;
  boundary: string;
  required: boolean;
  reviewAppendixTarget: boolean;
}

export interface ReviewArtifactBytesEntry extends ReviewArtifactEntry {
  state: "file" | "missing" | "not-file";
  bytes?: Buffer;
}

export interface ReviewArtifactBytesSnapshot {
  fingerprint: string;
  entries: ReviewArtifactBytesEntry[];
}

export function reviewArtifactEntries(
  projectDir: string,
  stage: ReviewFingerprintStage,
  unit?: string,
  options: {
    boltDag?: BoltDagResolution;
    stateContent?: string | null;
    mergedBoltUnits?: ReadonlySet<string>;
  } = {},
): ReviewArtifactEntry[] | null {
  const artifactsForKind = (kind: string | null) => {
    const required = filterProducesByKind(
      stage.produces_kinds,
      stage.produces ?? [],
      kind,
    );
    return [
      ...required.map((name) => ({
        name,
        required: true,
        reviewAppendixTarget: name === stage.review_artifact,
      })),
      ...filterProducesByKind(
        stage.produces_kinds,
        stage.optional_produces ?? [],
        kind,
      ).map((name) => ({
        name,
        required: false,
        reviewAppendixTarget: false,
      })),
    ];
  };
  const allArtifacts = artifactsForKind(null);

  if (KNOWN_CODEKB_STAGES.has(stage.slug)) {
    const root = dirname(codekbDir(projectDir, "_"));
    let repos = intentRepos(projectDir);
    if (repos.length === 0 && existsSync(root)) {
      repos = readdirSync(root).filter((name) => {
        try {
          return statSync(join(root, name)).isDirectory();
        } catch {
          return false;
        }
      });
    }
    if (repos.length === 0) {
      return allArtifacts.map((artifact) => ({
        logicalPath: `codekb/*/${artifactFilename(artifact.name)}`,
        path: null,
        boundary: root,
        required: artifact.required,
        reviewAppendixTarget: artifact.reviewAppendixTarget,
      }));
    }
    return repos.flatMap((repo) =>
      allArtifacts.map((artifact) => ({
        logicalPath: `codekb/${repo}/${artifactFilename(artifact.name)}`,
        path: join(codekbDir(projectDir, repo), artifactFilename(artifact.name)),
        boundary: root,
        required: artifact.required,
        reviewAppendixTarget: artifact.reviewAppendixTarget,
      })),
    );
  }

  const record = recordDir(projectDir);
  if (record === null) return null;
  if (stage.for_each !== "unit-of-work") {
    return allArtifacts.map((artifact) => ({
      logicalPath: `${stage.phase}/${stage.slug}/${artifactFilename(artifact.name)}`,
      path: join(record, stage.phase, stage.slug, artifactFilename(artifact.name)),
      boundary: record,
      required: artifact.required,
      reviewAppendixTarget: artifact.reviewAppendixTarget,
    }));
  }

  const stageLevelEntries = (): ReviewArtifactEntry[] =>
    allArtifacts.map((artifact) => ({
      logicalPath: `${stage.phase}/${stage.slug}/${artifactFilename(artifact.name)}`,
      path: join(record, stage.phase, stage.slug, artifactFilename(artifact.name)),
      boundary: record,
      required: artifact.required,
      reviewAppendixTarget: artifact.reviewAppendixTarget,
    }));
  const stageLevelPresent = allArtifacts.some((artifact) =>
    existsSync(
      join(record, stage.phase, stage.slug, artifactFilename(artifact.name)),
    )
  );
  const construction = join(record, "construction");
  const discoveredUnits = existsSync(construction)
    ? readdirSync(construction).filter((name) => {
        try {
          return (
            statSync(join(construction, name)).isDirectory() &&
            existsSync(join(construction, name, stage.slug))
          );
        } catch {
          return false;
        }
      })
    : [];

  let stateContent = options.stateContent;
  if (stateContent === undefined) {
    try {
      stateContent = readStateFile(projectDir);
    } catch {
      stateContent = null;
    }
  }
  if (
    unit === undefined &&
    stateContent !== null &&
    usesStageLevelPerUnitArtifacts(
      getField(stateContent, "Scope"),
      stateContent,
    ) &&
    (stageLevelPresent || discoveredUnits.length === 0)
  ) {
    return stageLevelEntries();
  }

  let units: string[];
  let unitKinds = new Map<string, string>();
  const resolution = options.boltDag ?? resolveBoltDag(projectDir);
  if (unit) {
    units = [unit];
    if (resolution.state === "ok" && resolution.unitKinds !== null) {
      unitKinds = resolution.unitKinds;
    }
  } else if (resolution.state === "ok") {
    units = resolution.units;
    unitKinds = resolution.unitKinds ?? new Map();
  } else {
    if (
      options.mergedBoltUnits !== undefined &&
      options.mergedBoltUnits.size > 0
    ) {
      units = [...options.mergedBoltUnits].sort();
    } else {
      if (stageLevelPresent) return stageLevelEntries();
      units = discoveredUnits;
    }
  }
  if (units.length === 0) {
    return allArtifacts.map((artifact) => ({
      logicalPath: `construction/*/${stage.slug}/${artifactFilename(artifact.name)}`,
      path: null,
      boundary: record,
      required: artifact.required,
      reviewAppendixTarget: artifact.reviewAppendixTarget,
    }));
  }
  return units.flatMap((name) =>
    artifactsForKind(unitKinds.get(name) ?? null).map((artifact) => ({
      logicalPath: `construction/${name}/${stage.slug}/${artifactFilename(artifact.name)}`,
      path: join(record, "construction", name, stage.slug, artifactFilename(artifact.name)),
      boundary: record,
      required: artifact.required,
      reviewAppendixTarget: artifact.reviewAppendixTarget,
    })),
  );
}

type StableArtifactStat = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
};

type ReviewArtifactContent =
  | (ReviewArtifactEntry & { state: "missing" })
  | (ReviewArtifactEntry & {
      state: "not-file";
      identity: StableArtifactStat;
    })
  | (ReviewArtifactEntry & {
      state: "file";
      body: Buffer;
      identity: StableArtifactStat;
      fd: number;
    });

function artifactFdStat(fd: number): StableArtifactStat {
  return fstatSync(fd, { bigint: true }) as unknown as StableArtifactStat;
}

function sameArtifactIdentity(
  left: StableArtifactStat,
  right: StableArtifactStat,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function pathContainedBy(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function inspectArtifactPath(
  boundary: string,
  path: string,
): { state: "missing" } | { state: "present"; boundaryReal: string } | null {
  const lexicalBoundary = resolvePath(boundary);
  const lexicalPath = resolvePath(path);
  if (!pathContainedBy(lexicalBoundary, lexicalPath)) return null;

  let boundaryReal: string;
  try {
    boundaryReal = realpathSync(lexicalBoundary);
  } catch {
    return null;
  }

  const rel = relative(lexicalBoundary, lexicalPath);
  let cursor = lexicalBoundary;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: "missing" };
      }
      return null;
    }
  }
  return { state: "present", boundaryReal };
}

function readStableReviewArtifacts(
  entries: ReviewArtifactEntry[],
  observer?: (event: {
    phase: "after-read";
    logicalPath: string;
    path: string;
  }) => void,
): ReviewArtifactContent[] | null {
  const contents: ReviewArtifactContent[] = [];
  const opened: number[] = [];
  try {
    for (const entry of [...entries].sort((a, b) =>
      a.logicalPath.localeCompare(b.logicalPath),
    )) {
      if (entry.path === null) {
        contents.push({ ...entry, state: "missing" });
        continue;
      }

      const inspected = inspectArtifactPath(entry.boundary, entry.path);
      if (inspected === null) return null;
      if (inspected.state === "missing") {
        contents.push({ ...entry, state: "missing" });
        continue;
      }
      const before = lstatSync(entry.path, {
        bigint: true,
      }) as unknown as StableArtifactStat;
      if (!before.isFile()) {
        contents.push({ ...entry, state: "not-file", identity: before });
        continue;
      }
      if (before.nlink !== 1n) return null;

      const noFollow =
        typeof fsConstants.O_NOFOLLOW === "number"
          ? fsConstants.O_NOFOLLOW
          : 0;
      const nonBlock =
        typeof fsConstants.O_NONBLOCK === "number"
          ? fsConstants.O_NONBLOCK
          : 0;
      const fd = openSync(
        entry.path,
        fsConstants.O_RDONLY | noFollow | nonBlock,
      );
      opened.push(fd);
      const openedIdentity = artifactFdStat(fd);
      if (
        !openedIdentity.isFile() ||
        openedIdentity.nlink !== 1n ||
        !sameArtifactIdentity(before, openedIdentity)
      ) return null;
      const openedReal = realpathSync(entry.path);
      if (!pathContainedBy(inspected.boundaryReal, openedReal)) return null;
      const body = readFileSync(fd);
      const afterReadIdentity = artifactFdStat(fd);
      if (!sameArtifactIdentity(openedIdentity, afterReadIdentity)) return null;
      contents.push({
        ...entry,
        state: "file",
        body,
        identity: openedIdentity,
        fd,
      });
      observer?.({
        phase: "after-read",
        logicalPath: entry.logicalPath,
        path: entry.path,
      });
    }

    for (const entry of contents) {
      if (entry.path === null) continue;
      if (entry.state === "missing") {
        if (inspectArtifactPath(entry.boundary, entry.path)?.state !== "missing") {
          return null;
        }
        continue;
      }
      const inspected = inspectArtifactPath(entry.boundary, entry.path);
      if (inspected?.state !== "present") return null;
      const currentPath = lstatSync(entry.path, {
        bigint: true,
      }) as unknown as StableArtifactStat;
      if (!sameArtifactIdentity(entry.identity, currentPath)) return null;
      if (
        !pathContainedBy(inspected.boundaryReal, realpathSync(entry.path))
      ) return null;
      if (
        entry.state === "file" &&
        !sameArtifactIdentity(entry.identity, artifactFdStat(entry.fd))
      ) {
        return null;
      }
    }
    return contents;
  } catch {
    return null;
  } finally {
    for (const fd of opened) {
      try {
        closeSync(fd);
      } catch {
        // The snapshot has already failed closed if a descriptor is unusable.
      }
    }
  }
}

function reviewArtifactContentsFingerprint(
  contents: ReviewArtifactContent[],
  options: {
    requireRequiredArtifacts?: boolean;
    appendixArtifact?: string;
    appendixOffset?: number;
  } = {},
): string | null {
  const manifest: Array<[string, string]> = [];
  let matchedAppendix = options.appendixArtifact === undefined;
  for (const entry of contents) {
    if (entry.state === "missing") {
      if (entry.required && options.requireRequiredArtifacts === true) return null;
      manifest.push([entry.logicalPath, "missing"]);
      continue;
    }
    if (entry.state === "not-file") {
      if (entry.required && options.requireRequiredArtifacts === true) return null;
      manifest.push([entry.logicalPath, "not-file"]);
      continue;
    }

    let fingerprintedBody = entry.body;
    if (entry.logicalPath === options.appendixArtifact) {
      if (
        !entry.reviewAppendixTarget ||
        options.appendixOffset === undefined ||
        options.appendixOffset < 0 ||
        options.appendixOffset > entry.body.length
      ) {
        return null;
      }
      fingerprintedBody = entry.body.subarray(0, options.appendixOffset);
      matchedAppendix = true;
    }
    const digest = createHash("sha256").update(fingerprintedBody).digest("hex");
    manifest.push([entry.logicalPath, `sha256:${digest}`]);
  }
  if (!matchedAppendix) return null;
  return `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
}

export interface ReviewArtifactSnapshot {
  fingerprint: string;
  requestFingerprint: string;
  appendixArtifact: string;
  appendixOffset: number;
  appendix: Buffer;
}

/**
 * Exclude permitted blank separator lines from the reviewer-owned evidence.
 * This keeps the stale-appendix binding anchored at the canonical
 * `## Review` heading instead of letting an extra blank line shift old
 * authority past the request-time prefix check.
 */
export function reviewAppendixEvidenceBytes(appendix: Buffer): Buffer {
  let offset = 0;
  while (offset < appendix.length) {
    const lineStart = offset;
    while (appendix[offset] === 0x20 || appendix[offset] === 0x09) offset++;
    if (appendix[offset] === 0x0d) {
      offset++;
      if (appendix[offset] === 0x0a) offset++;
      continue;
    }
    if (appendix[offset] === 0x0a) {
      offset++;
      continue;
    }
    return appendix.subarray(lineStart);
  }
  return appendix.subarray(offset);
}

/**
 * Canonical audit binding for the reviewer evidence after an appendix offset.
 * `none` pins the verified absence of any pre-request appendix; a sha256
 * digest pins the exact section that already existed when REVIEW_REQUESTED
 * was recorded. Its recorded byte length lets completion reject both an
 * unchanged section and one that merely extends those same pre-request bytes,
 * so a `## Review` section that predates the request (for example one
 * surviving an attempt reset) cannot be replayed as fresh reviewer evidence.
 */
export function reviewAppendixDigest(appendix: Buffer): string {
  const evidence = reviewAppendixEvidenceBytes(appendix);
  return evidence.length === 0
    ? "none"
    : `sha256:${createHash("sha256").update(evidence).digest("hex")}`;
}

function existingReviewAppendixOffset(body: Buffer): number | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  const lineStarts = [0];
  for (let offset = 0; offset < text.length; offset++) {
    if (text[offset] === "\r") {
      if (text[offset + 1] === "\n") offset++;
      lineStarts.push(offset + 1);
    } else if (text[offset] === "\n") {
      lineStarts.push(offset + 1);
    }
  }

  const candidates: Array<{ start: number; end: number }> = [];
  for (let line = 0; line < lineStarts.length; line++) {
    const start = lineStarts[line];
    const lineEnd = lineStarts[line + 1] ?? text.length;
    const rawLine = text
      .slice(start, lineEnd)
      .replace(/(?:\r\n|\n|\r)$/, "");
    if (/^## Review[ \t]*$/.test(rawLine)) {
      candidates.push({ start, end: start + rawLine.length });
    }
  }
  if (candidates.length === 0 || typeof Bun.markdown?.render !== "function") {
    return null;
  }

  let marker = "AIDLCREVIEWAPPENDIXBOUNDARY";
  while (text.includes(marker)) marker += "X";
  let marked = text;
  for (let index = candidates.length - 1; index >= 0; index--) {
    const candidate = candidates[index];
    const rawLine = marked.slice(candidate.start, candidate.end);
    marked =
      marked.slice(0, candidate.start) +
      `## ${marker}${index}${rawLine.slice("## Review".length)}` +
      marked.slice(candidate.end);
  }

  let sawRenderedH1H2 = false;
  let terminalCandidate: number | null = null;
  try {
    Bun.markdown.render(marked, {
      heading: (children, { level }) => {
        if (level <= 2) {
          sawRenderedH1H2 = true;
          const match =
            level === 2
              ? new RegExp(`^${marker}([0-9]+)$`).exec(children)
              : null;
          terminalCandidate = match ? Number(match[1]) : null;
        }
        return "";
      },
      html: (children) => {
        if (renderedHtmlCarriesH1H2(children)) {
          sawRenderedH1H2 = true;
          terminalCandidate = null;
        }
        return "";
      },
    });
  } catch {
    return null;
  }
  if (!sawRenderedH1H2 || terminalCandidate === null) return null;

  const headingStart = candidates[terminalCandidate]?.start;
  if (headingStart === undefined) return null;

  const prefix = text.slice(0, headingStart);
  const trailing = /\s+$/.exec(prefix);
  if (!trailing) return Buffer.byteLength(prefix, "utf-8");
  const contentEnd = prefix.length - trailing[0].length;
  const retainedLineEnd = /^[ \t]*(?:\r\n|\n|\r)/.exec(
    prefix.slice(contentEnd),
  );
  const offset =
    contentEnd + (retainedLineEnd?.[0].length ?? 0);
  return Buffer.byteLength(text.slice(0, offset), "utf-8");
}

/**
 * Snapshot the exact review input and the explicit review_artifact byte
 * boundary after which the reviewer may append `## Review`.
 */
export function reviewArtifactSnapshot(
  projectDir: string,
  stage: ReviewFingerprintStage,
  unit?: string,
  options: {
    requireRequiredArtifacts?: boolean;
    boltDag?: BoltDagResolution;
    mergedBoltUnits?: ReadonlySet<string>;
    appendixBinding?: {
      artifact: string;
      offset: number;
    };
    snapshotObserver?: (event: {
      phase: "after-read";
      logicalPath: string;
      path: string;
    }) => void;
  } = {},
): ReviewArtifactSnapshot | null {
  let entries: ReviewArtifactEntry[] | null;
  try {
    entries = reviewArtifactEntries(projectDir, stage, unit, {
      boltDag: options.boltDag,
      mergedBoltUnits: options.mergedBoltUnits,
    });
  } catch {
    return null;
  }
  if (entries === null) return null;
  const contents = readStableReviewArtifacts(entries, options.snapshotObserver);
  if (contents === null) return null;
  const fingerprint = reviewArtifactContentsFingerprint(contents, options);
  if (fingerprint === null) return null;

  const target = contents
    .filter((entry) => entry.reviewAppendixTarget)
    .sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))[0];
  if (target?.state !== "file") return null;

  const binding = options.appendixBinding ?? {
    artifact: target.logicalPath,
    offset: existingReviewAppendixOffset(target.body) ?? target.body.length,
  };
  if (
    binding.artifact !== target.logicalPath ||
    !Number.isSafeInteger(binding.offset) ||
    binding.offset < 0 ||
    binding.offset > target.body.length
  ) {
    return null;
  }
  const requestFingerprint = reviewArtifactContentsFingerprint(contents, {
    ...options,
    appendixArtifact: binding.artifact,
    appendixOffset: binding.offset,
  });
  if (requestFingerprint === null) return null;
  return {
    fingerprint,
    requestFingerprint,
    appendixArtifact: binding.artifact,
    appendixOffset: binding.offset,
    appendix: target.body.subarray(binding.offset),
  };
}

/**
 * Content identity covered by a terminal review receipt. Paths are logical
 * record-relative names, so an identical Bolt worktree survives merge/re-root;
 * missing declared artifacts are explicit manifest entries, so creating one
 * after review also invalidates the receipt.
 */
export function reviewArtifactFingerprint(
  projectDir: string,
  stage: ReviewFingerprintStage,
  unit?: string,
  options: {
    requireRequiredArtifacts?: boolean;
    boltDag?: BoltDagResolution;
    stateContent?: string | null;
    mergedBoltUnits?: ReadonlySet<string>;
  } = {},
): string | null {
  let entries: ReviewArtifactEntry[] | null;
  try {
    entries = reviewArtifactEntries(projectDir, stage, unit, {
      boltDag: options.boltDag,
      stateContent: options.stateContent,
      mergedBoltUnits: options.mergedBoltUnits,
    });
  } catch {
    return null;
  }
  if (entries === null) return null;
  const contents = readStableReviewArtifacts(entries);
  if (contents === null) return null;
  return reviewArtifactContentsFingerprint(contents, options);
}

export function validateReviewAppendix(
  appendix: Buffer,
  expected: {
    verdict: ReviewVerdict;
    reviewer: string;
    iteration: number;
    reviewChallenge: string | null;
  },
): { valid: true } | { valid: false; reason: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(appendix);
  } catch {
    return { valid: false, reason: "the reviewer appendix is not valid UTF-8" };
  }
  const normalized = text.replace(/\r\n?/g, "\n");
  const opening = /^(?:[ \t]*\n)*## Review[ \t]*\n/.exec(normalized);
  if (!opening) {
    return {
      valid: false,
      reason:
        "the appended bytes must begin with only blank lines followed by an exact `## Review` heading",
    };
  }
  const section = normalized.slice(opening[0].length);
  const authority = renderReviewMarkdownAuthority(section);
  if (authority === null) {
    return {
      valid: false,
      reason: "the reviewer appendix could not be parsed as Markdown",
    };
  }
  if (authority.markdownH1H2) {
    return {
      valid: false,
      reason:
        "the reviewer appendix must be terminal and contain no later rendered H1 or H2 heading",
    };
  }
  if (authority.htmlH1H2) {
    return {
      valid: false,
      reason:
        "the reviewer appendix must be terminal and contain no rendered HTML H1 or H2 heading",
    };
  }

  if (
    authority.verdicts.length !== 1 ||
    authority.verdicts[0] !== expected.verdict
  ) {
    return {
      valid: false,
      reason:
        "the reviewer appendix must contain exactly one canonical verdict line matching --verdict",
    };
  }
  if (
    authority.reviewers.length !== 1 ||
    authority.reviewers[0] !== expected.reviewer
  ) {
    return {
      valid: false,
      reason:
        "the reviewer appendix must contain exactly one Reviewer line matching the requested reviewer",
    };
  }
  if (
    authority.iterations.length !== 1 ||
    authority.iterations[0] !== String(expected.iteration)
  ) {
    return {
      valid: false,
      reason:
        "the reviewer appendix must contain exactly one Iteration line matching the request",
    };
  }
  if (
    expected.reviewChallenge === null
      ? authority.requestChallenges.length !== 0
      : authority.requestChallenges.length !== 1 ||
        authority.requestChallenges[0] !== expected.reviewChallenge
  ) {
    return {
      valid: false,
      reason:
        expected.reviewChallenge === null
          ? "the reviewer appendix must omit Request Challenge when the request did not issue one"
          : "the reviewer appendix must contain exactly one Request Challenge line matching the request",
    };
  }
  return { valid: true };
}

type RenderedReviewAuthority = {
  markdownH1H2: boolean;
  htmlH1H2: boolean;
  verdicts: string[];
  reviewers: string[];
  iterations: string[];
  requestChallenges: string[];
};

const REVIEW_MARK_OPEN = "\u0001";
const REVIEW_MARK_CLOSE = "\u0002";
const REVIEW_NON_AUTHORITY = "\u0003";

function renderedReviewFields(rendered: string, label: string): string[] {
  const pattern = new RegExp(
    `^${REVIEW_MARK_OPEN}${label}:${REVIEW_MARK_CLOSE}[ \\t]+(.+?)[ \\t]*$`,
    "gm",
  );
  return [...rendered.matchAll(pattern)].map((match) => match[1]);
}

function renderedHtmlCarriesH1H2(html: string): boolean {
  const visible = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(
      /<(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext|template)\b[\s\S]*?(?:<\/\1\s*>|$)/gi,
      "",
    );
  return /<h[12](?=[\s/>]|$)/i.test(visible);
}

function escapeReviewRendererText(text: string): string {
  let escaped = "";
  for (const character of text) {
    const code = character.charCodeAt(0);
    escaped +=
      code >= 1 && code <= 3
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : character;
  }
  return escaped;
}

function renderReviewMarkdownAuthority(
  section: string,
): RenderedReviewAuthority | null {
  if (typeof Bun.markdown?.render !== "function") return null;
  let markdownH1H2 = false;
  let htmlH1H2 = false;
  let rendered: string;
  try {
    rendered = Bun.markdown.render(section, {
      heading: (_children, { level }) => {
        if (level <= 2) markdownH1H2 = true;
        return `${REVIEW_NON_AUTHORITY}\n`;
      },
      html: (children) => {
        if (renderedHtmlCarriesH1H2(children)) htmlH1H2 = true;
        return children.endsWith("\n")
          ? `${REVIEW_NON_AUTHORITY}\n`
          : REVIEW_NON_AUTHORITY;
      },
      code: () => `${REVIEW_NON_AUTHORITY}\n`,
      codespan: () => REVIEW_NON_AUTHORITY,
      text: escapeReviewRendererText,
      strong: (children) =>
        `${REVIEW_MARK_OPEN}${children}${REVIEW_MARK_CLOSE}`,
      paragraph: (children) => `${children}\n`,
      blockquote: () => "",
      list: () => "",
      table: () => "",
      emphasis: (children) =>
        `${REVIEW_NON_AUTHORITY}${children}${REVIEW_NON_AUTHORITY}`,
      strikethrough: (children) =>
        `${REVIEW_NON_AUTHORITY}${children}${REVIEW_NON_AUTHORITY}`,
      link: (children) =>
        `${REVIEW_NON_AUTHORITY}${children}${REVIEW_NON_AUTHORITY}`,
      image: () => REVIEW_NON_AUTHORITY,
      hr: () => `${REVIEW_NON_AUTHORITY}\n`,
    });
  } catch {
    return null;
  }
  return {
    markdownH1H2,
    htmlH1H2,
    verdicts: renderedReviewFields(rendered, "Verdict"),
    reviewers: renderedReviewFields(rendered, "Reviewer"),
    iterations: renderedReviewFields(rendered, "Iteration"),
    requestChallenges: renderedReviewFields(rendered, "Request Challenge"),
  };
}

const REVIEW_FINGERPRINT_RE = /^sha256:[0-9a-f]{64}$/;
const REVIEW_APPENDIX_DIGEST_RE = /^(?:none|sha256:[0-9a-f]{64})$/;
const REVIEW_CHALLENGE_RE = /^review:[0-9a-f]{32}$/;
const SOURCE_FINGERPRINT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|unbindable)$/;
const UNIT_SOURCE_FINGERPRINT_RE = /^(?:sha256:[0-9a-f]{64}|unbindable)$/;

export interface ReviewRequestBinding {
  artifactFingerprint: string;
  appendixArtifact: string | null;
  appendixOffset: number | null;
  priorAppendixDigest: string | null;
  priorAppendixLength: number | null;
  reviewChallenge: string | null;
  sourceFingerprint: string | null;
  unitSourceFingerprint: string | null;
  recoveryCause: ReviewRecoveryCause | null;
}

export function reviewRequestBindingFromBlock(
  block: string,
): ReviewRequestBinding | null {
  const artifactFingerprint = auditBlockField(block, "Artifact Fingerprint");
  if (
    artifactFingerprint === null ||
    !REVIEW_FINGERPRINT_RE.test(artifactFingerprint)
  ) {
    return null;
  }
  const appendixArtifact = auditBlockField(
    block,
    "Review Appendix Artifact",
  );
  const rawOffset = auditBlockField(block, "Review Appendix Offset");
  if ((appendixArtifact === null) !== (rawOffset === null)) return null;
  let appendixOffset: number | null = null;
  if (rawOffset !== null) {
    if (!/^[0-9]+$/.test(rawOffset)) return null;
    appendixOffset = Number(rawOffset);
    if (!Number.isSafeInteger(appendixOffset)) return null;
  }
  const priorAppendixDigest = auditBlockField(
    block,
    "Review Appendix Prior Digest",
  );
  if (
    priorAppendixDigest !== null &&
    (appendixArtifact === null ||
      !REVIEW_APPENDIX_DIGEST_RE.test(priorAppendixDigest))
  ) {
    return null;
  }
  const rawPriorAppendixLength = auditBlockField(
    block,
    "Review Appendix Prior Length",
  );
  let priorAppendixLength: number | null = null;
  if (rawPriorAppendixLength !== null) {
    if (!/^[0-9]+$/.test(rawPriorAppendixLength)) return null;
    priorAppendixLength = Number(rawPriorAppendixLength);
    if (!Number.isSafeInteger(priorAppendixLength)) return null;
    if (
      appendixArtifact === null ||
      priorAppendixDigest === null ||
      (priorAppendixDigest === "none") !== (priorAppendixLength === 0)
    ) {
      return null;
    }
  }
  const reviewChallenge = auditBlockField(block, "Review Challenge");
  if (
    reviewChallenge !== null &&
    (!REVIEW_CHALLENGE_RE.test(reviewChallenge) ||
      priorAppendixLength === null ||
      priorAppendixLength === 0)
  ) {
    return null;
  }
  const sourceFingerprint = auditBlockField(block, "Source Fingerprint");
  if (
    sourceFingerprint !== null &&
    !SOURCE_FINGERPRINT_RE.test(sourceFingerprint)
  ) {
    return null;
  }
  const unitSourceFingerprint = auditBlockField(
    block,
    "Unit Source Fingerprint",
  );
  if (
    unitSourceFingerprint !== null &&
    !UNIT_SOURCE_FINGERPRINT_RE.test(unitSourceFingerprint)
  ) {
    return null;
  }
  const rawRecoveryCause = auditBlockField(block, "Recovery Cause");
  const recoveryCause =
    rawRecoveryCause === "artifact" ||
      rawRecoveryCause === "source" ||
      rawRecoveryCause === "artifact+source"
      ? rawRecoveryCause
      : null;
  if (rawRecoveryCause !== null && recoveryCause === null) return null;
  return {
    artifactFingerprint,
    appendixArtifact,
    appendixOffset,
    priorAppendixDigest,
    priorAppendixLength,
    reviewChallenge,
    sourceFingerprint,
    unitSourceFingerprint,
    recoveryCause,
  };
}

export function reviewCompletionMatchesRequest(
  request: ReviewRequestBinding,
  completionBlock: string,
): boolean {
  const verdict = auditBlockField(completionBlock, "Verdict");
  if (verdict !== "READY" && verdict !== "NOT-READY") return false;
  const recordedFingerprint = auditBlockField(
    completionBlock,
    "Artifact Fingerprint",
  );
  if (
    recordedFingerprint === null ||
    !REVIEW_FINGERPRINT_RE.test(recordedFingerprint)
  ) {
    return false;
  }
  const completedRequestFingerprint =
    auditBlockField(completionBlock, "Request Fingerprint") ??
    recordedFingerprint;
  if (completedRequestFingerprint !== request.artifactFingerprint) return false;

  const completionAppendixArtifact = auditBlockField(
    completionBlock,
    "Review Appendix Artifact",
  );
  const completionAppendixOffset = auditBlockField(
    completionBlock,
    "Review Appendix Offset",
  );
  if (
    completionAppendixArtifact !== request.appendixArtifact ||
    (completionAppendixOffset === null
      ? request.appendixOffset !== null
      : !/^[0-9]+$/.test(completionAppendixOffset) ||
        Number(completionAppendixOffset) !== request.appendixOffset)
  ) {
    return false;
  }

  if (
    request.priorAppendixDigest !== null &&
    auditBlockField(completionBlock, "Review Appendix Prior Digest") !==
      request.priorAppendixDigest
  ) {
    return false;
  }
  if (
    request.priorAppendixDigest !== null &&
    request.priorAppendixLength === null
  ) {
    return false;
  }
  if (request.priorAppendixLength !== null) {
    const completionPriorLength = auditBlockField(
      completionBlock,
      "Review Appendix Prior Length",
    );
    if (
      completionPriorLength === null ||
      !/^[0-9]+$/.test(completionPriorLength) ||
      Number(completionPriorLength) !== request.priorAppendixLength
    ) {
      return false;
    }
  }
  if (
    auditBlockField(completionBlock, "Review Challenge") !==
    request.reviewChallenge
  ) {
    return false;
  }

  if (request.sourceFingerprint !== null) {
    const requestSource = auditBlockField(
      completionBlock,
      "Request Source Fingerprint",
    );
    const completedSource = auditBlockField(
      completionBlock,
      "Source Fingerprint",
    );
    if (
      requestSource !== request.sourceFingerprint ||
      completedSource !== request.sourceFingerprint
    ) {
      return false;
    }
  }
  if (
    request.unitSourceFingerprint !== null &&
    auditBlockField(completionBlock, "Unit Source Fingerprint") !==
      request.unitSourceFingerprint
  ) {
    return false;
  }
  return true;
}

/**
 * Byte-capture snapshot of the declared artifact set, sharing the sorted
 * logical-path manifest fingerprint scheme review receipts record. Swarm
 * finalize reads converged Bolt worktree records through it and merges the
 * exact reviewed bytes into main.
 */
export function reviewArtifactBytesSnapshot(
  projectDir: string,
  stage: ReviewFingerprintStage,
  unit?: string,
  options: {
    requireRequiredArtifacts?: boolean;
    boltDag?: BoltDagResolution;
    stateContent?: string | null;
    captureBytes?: boolean;
    mergedBoltUnits?: ReadonlySet<string>;
  } = {},
): ReviewArtifactBytesSnapshot | null {
  let entries: ReviewArtifactEntry[] | null;
  try {
    entries = reviewArtifactEntries(projectDir, stage, unit, {
      boltDag: options.boltDag,
      stateContent: options.stateContent,
      mergedBoltUnits: options.mergedBoltUnits,
    });
  } catch {
    return null;
  }
  if (entries === null) return null;

  const manifest: Array<[string, string]> = [];
  const snapshot: ReviewArtifactBytesEntry[] = [];
  let anchorReal: string;
  try {
    anchorReal = realpathSync(projectDir);
  } catch {
    return null;
  }
  for (const entry of entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath))) {
    if (entry.path === null) {
      if (entry.required && options.requireRequiredArtifacts === true) return null;
      manifest.push([entry.logicalPath, "missing"]);
      snapshot.push({ ...entry, state: "missing" });
      continue;
    }
    try {
      const safePath = assertNoSymlinkInChainOrThrow(
        anchorReal,
        relative(projectDir, entry.path),
      );
      const bytes = readRegularFileNoFollowOrThrow(
        safePath,
        `review artifact ${entry.logicalPath}`,
      );
      const digest = createHash("sha256").update(bytes).digest("hex");
      manifest.push([entry.logicalPath, `sha256:${digest}`]);
      snapshot.push({
        ...entry,
        state: "file",
        ...(options.captureBytes === true ? { bytes } : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (entry.required && options.requireRequiredArtifacts === true) return null;
        manifest.push([entry.logicalPath, "missing"]);
        snapshot.push({ ...entry, state: "missing" });
        continue;
      }
      if (entry.required && options.requireRequiredArtifacts === true) return null;
      manifest.push([entry.logicalPath, "not-file"]);
      snapshot.push({ ...entry, state: "not-file" });
    }
  }
  return {
    fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`,
    entries: snapshot,
  };
}

type SwarmConvergenceSourceKind = "legacy" | "bypass" | "bound" | "invalid";

function swarmConvergenceSourceKind(block: string): SwarmConvergenceSourceKind {
  const fingerprint = auditBlockField(block, "Source Fingerprint");
  const commit = auditBlockField(block, "Source Commit");
  const bypass = auditBlockField(block, "Source Freshness Bypass");
  if (fingerprint === null && commit === null && bypass === null) return "legacy";
  if (fingerprint === null && commit === null && bypass === "true") return "bypass";
  if (
    bypass === null &&
    fingerprint !== null &&
    commit !== null &&
    /^[0-9a-f]{40,64}$/.test(fingerprint) &&
    /^[0-9a-f]{40,64}$/.test(commit)
  ) {
    return "bound";
  }
  return "invalid";
}


// Collect the fresh terminal review receipts for a stage from the audit
// ledger. Builds ONE position-tiebroken event stream (the same interleave
// idiom unrecordedRevisionSinceGateOpen uses) - a timestamp-only floor is
// unsafe because isoTimestamp() is second-precision, so a review and the
// reject that should invalidate it can share a timestamp and a `<` compare
// would keep the stale review. Ordering by (timestamp, buffer position)
// breaks that tie.
//
// The attempt floor: WORKFLOW_STARTED and STAGE_JUMPED floor deliberately
// stage-AGNOSTIC - any jump invalidates every stage's reviews, including
// stages the jump never re-opens. That over-invalidation is harmless (a stage
// that stays [x] never re-completes, so its stale floor is never consulted)
// and it is what closes the redo-jump hole: a backward jump re-opens stages
// WITHOUT emitting their GATE_REJECTED or (until re-entry) STAGE_STARTED, so
// a stage-scoped floor would accept the prior attempt's reviews. Fail-closed
// over precise. Unit-major construction may author a later stage's per-unit
// artifacts before that stage's STAGE_STARTED row exists, so its floor
// ignores STAGE_STARTED; stage-major and non-per-unit flows floor on it.
function hasDurableSourceBindingEvidence(
  projectDir: string,
  intent?: string,
  space?: string,
): boolean {
  const record = recordDir(projectDir, intent, space);
  if (record !== null) {
    const snapshots = join(record, ".aidlc-source-review");
    const hasSnapshot = (dir: string): boolean => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      return entries.some((entry) =>
        entry.isFile() && entry.name.endsWith(".tsv")
          ? true
          : entry.isDirectory() && hasSnapshot(join(dir, entry.name))
      );
    };
    if (hasSnapshot(snapshots)) return true;
    const construction = join(record, "construction");
    let units: string[] = [];
    try {
      units = readdirSync(construction);
    } catch {
      // No construction artifacts.
    }
    if (
      units.some((unit) =>
        existsSync(
          join(
            construction,
            unit,
            "code-generation",
            "source-manifest.json",
          ),
        )
      )
    ) {
      return true;
    }
  }

  const expectedIntent = relativeRecordDir(projectDir, intent, space);
  if (expectedIntent === null) return false;
  const candidates = [
    join(projectDir, ".aidlc", "worktree-meta.json"),
  ];
  const worktrees = join(projectDir, ".aidlc", "worktrees");
  try {
    for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(
          join(worktrees, entry.name, ".aidlc", "worktree-meta.json"),
        );
      }
    }
  } catch {
    // No worktree metadata.
  }
  return candidates.some((path) => {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        intentRecord?: unknown;
      };
      return parsed.intentRecord === expectedIntent;
    } catch {
      return false;
    }
  });
}

function hasModernSourceBindingEvidence(
  projectDir: string,
  rows: ReadonlyArray<{ event: string; block: string }>,
  intent?: string,
  space?: string,
): boolean {
  if (rows.some((row) => {
    if (auditBlockField(row.block, "Source Baseline") !== null) return true;
    if (
      row.event === "REVIEW_COMPLETED" &&
      auditBlockField(row.block, "Unit") !== null &&
      (auditBlockField(row.block, "Unit Source Fingerprint") !== null ||
        auditBlockField(row.block, "Unit Source Binding Bypass") !== null)
    ) {
      return true;
    }
    if (
      (row.event === "WORKTREE_CREATED" || row.event === "BOLT_STARTED") &&
      (auditBlockField(row.block, "Base commit") !== null ||
        auditBlockField(row.block, "Base Source Listing") !== null)
    ) {
      return true;
    }
    if (
      row.event === "SWARM_UNIT_CONVERGED" &&
      (auditBlockField(row.block, "Source Commit") !== null ||
        auditBlockField(row.block, "Source Freshness Bypass") !== null)
    ) {
      return true;
    }
    return row.event === "SWARM_SOURCE_MERGED";
  })) return true;
  return hasDurableSourceBindingEvidence(projectDir, intent, space);
}

function sourceBaselineBoundaryValue(
  event: Pick<AuditShardEvent, "event" | "block">,
  stageSlug: string,
  unitMajor: boolean,
): string | null | undefined {
  if (auditBlockField(event.block, "Workflow")?.startsWith("single-stage:")) {
    return undefined;
  }
  const qualifies =
    event.event === "WORKFLOW_STARTED" ||
    event.event === "STAGE_JUMPED" ||
    (
    event.event === "STAGE_STARTED" &&
    !unitMajor &&
    auditBlockField(event.block, "Stage") === stageSlug
  );
  return qualifies
    ? auditBlockField(event.block, "Source Baseline")
    : undefined;
}

function auditEventIsCrossShardTied<
  T extends Pick<AuditShardEvent, "timestamp" | "shard">,
>(
  events: ReadonlyArray<T>,
  index: number,
  boundaryValue?: (event: T) => string | null | undefined,
): boolean {
  const event = events[index];
  const eventValue = boundaryValue?.(event);
  return events.some(
    (candidate, otherIndex) =>
      otherIndex !== index &&
      candidate.timestamp === event.timestamp &&
      candidate.shard !== event.shard &&
      (boundaryValue === undefined ||
        (
          boundaryValue(candidate) !== undefined &&
          boundaryValue(candidate) !== eventValue
        )),
  );
}

const REVIEW_RECEIPT_EVENTS = new Set([
  "WORKFLOW_STARTED",
  "STAGE_STARTED",
  "STAGE_JUMPED",
  "GATE_REJECTED",
  "SESSION_STARTED",
  "SESSION_RESUMED",
  "BOLT_STARTED",
  "BOLT_COMPLETED",
  "BOLT_FAILED",
  "AUDIT_MERGED",
  "ARTIFACT_CREATED",
  "ARTIFACT_UPDATED",
  "REVIEW_REQUESTED",
  "REVIEW_COMPLETED",
]);

export interface ReviewAttemptWindow {
  allEvents: AuditShardEvent[];
  events: AuditShardEvent[];
  floorIdx: number;
  mergedBoltUnits: Set<string>;
  openBoltUnits: Set<string>;
}

function boltEventUnits(event: AuditShardEvent): string[] {
  const field =
    event.event === "BOLT_FAILED"
      ? auditBlockField(event.block, "Failed Bolt")
      : auditBlockField(event.block, "Bolt names");
  return (field ?? "")
    .split(",")
    .map((unit) => unit.trim())
    .filter((unit) => unit.length > 0);
}

/**
 * One audit snapshot supplies review freshness, no-DAG artifact enumeration,
 * request admission, and gate coverage. Bolt terminal rows pair by slug when
 * both rows carry one, and otherwise by Unit name. BOLT_COMPLETED alone is
 * terminal only for a name-only, non-worktree attempt; a completion that
 * involves a slug on either row is completion-pending-merge and becomes
 * merged only when a matching later AUDIT_MERGED proves the state and audit
 * merge sequence landed on main.
 */
export function reviewAttemptWindow(
  projectDir: string,
  stateContent: string,
  stage: { slug: string; for_each?: string },
): ReviewAttemptWindow {
  const allEvents = readAuditShardEvents(projectDir);
  const events = allEvents
    .filter((row) => REVIEW_RECEIPT_EVENTS.has(row.event))
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shard === b.shard) return a.pos - b.pos;
      return a.shardIndex - b.shardIndex;
    });
  const perUnit = stage.for_each === "unit-of-work";
  const artifactPerUnit =
    perUnit &&
    !usesStageLevelPerUnitArtifacts(
      getField(stateContent, "Scope"),
      stateContent,
    );
  const unitMajor =
    artifactPerUnit &&
    getField(stateContent, "Construction Iteration")?.trim() === "unit-major";
  const teamOwnership = artifactPerUnit && isTeamUnitOwnership(stateContent);
  let floorIdx = -1;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    let boundary =
      event.event === "WORKFLOW_STARTED" || event.event === "STAGE_JUMPED";
    if (!boundary && auditBlockField(event.block, "Stage") === stage.slug) {
      boundary =
        (event.event === "GATE_REJECTED" &&
          !(teamOwnership && auditBlockField(event.block, "Unit"))) ||
        (event.event === "STAGE_STARTED" &&
          !unitMajor &&
          !auditBlockField(event.block, "Workflow")?.startsWith(
            "single-stage:",
          ));
    }
    if (!boundary) continue;
    const tiedCrossShard = events.some(
      (candidate, index) =>
        index !== i &&
        candidate.timestamp === event.timestamp &&
        candidate.shard !== event.shard,
    );
    // Team-owned attempts fail closed across a same-second cross-shard
    // boundary by flooring the entire unordered timestamp group. Solo mode
    // retains its legacy merged-shard ordering for compatibility.
    if (tiedCrossShard && teamOwnership) {
      let end = i;
      while (
        end + 1 < events.length &&
        events[end + 1].timestamp === event.timestamp
      ) {
        end++;
      }
      floorIdx = end;
      i = end;
    } else {
      floorIdx = i;
    }
  }

  const attempts: Array<{
    unit: string;
    slug: string | null;
    state: "open" | "completed" | "merged" | "failed";
  }> = [];
  const applyBoltEvent = (event: AuditShardEvent): void => {
    if (event.event === "AUDIT_MERGED") {
      // Merge evidence: audit-merge emits AUDIT_MERGED only after the state
      // merge succeeded and the worktree delta landed on main. It confirms
      // the newest completion-pending attempt for its slug; it cannot
      // resurrect a failed attempt or invent one that never completed.
      const slug = auditBlockField(event.block, "Bolt slug");
      if (slug === null) return;
      const attemptIndex = attempts.findLastIndex(
        (attempt) =>
          attempt.slug === slug && attempt.state === "completed",
      );
      if (attemptIndex !== -1) attempts[attemptIndex].state = "merged";
      return;
    }
    const units = boltEventUnits(event);
    const slug = auditBlockField(event.block, "Bolt slug");
    if (event.event === "BOLT_STARTED") {
      for (const unit of units) {
        attempts.push({ unit, slug, state: "open" });
      }
      return;
    }
    const completion = event.event === "BOLT_COMPLETED";
    for (const unit of units) {
      let attemptIndex = -1;
      if (slug !== null) {
        attemptIndex = attempts.findIndex(
          (attempt) =>
            attempt.state === "open" && attempt.slug === slug,
        );
        if (attemptIndex === -1) {
          // A confirmed merge is final for its attempt: a duplicate
          // completion replay must not demote it back to pending, and a
          // later fragment-cleanup BOLT_FAILED must not erase it.
          attemptIndex = attempts.findLastIndex(
            (attempt) =>
              attempt.slug === slug && attempt.state !== "merged",
          );
        }
      }
      if (attemptIndex === -1) {
        // A slugless completion pairs only name-only attempts: it must not
        // close a slug-backed (worktree) attempt whose merge sequence never
        // ran. A slugless failure still closes the newest open attempt,
        // covering discard/abort rows emitted with --name only.
        attemptIndex = attempts.findIndex(
          (attempt) =>
            attempt.state === "open" &&
            attempt.unit === unit &&
            ((slug === null && !completion) || attempt.slug === null),
        );
      }
      if (attemptIndex === -1 && slug === null) {
        attemptIndex = attempts.findLastIndex(
          (attempt) =>
            attempt.unit === unit &&
            attempt.state !== "merged" &&
            (!completion || attempt.slug === null),
        );
      }
      if (attemptIndex === -1) continue;
      const attempt = attempts[attemptIndex];
      if (!completion) {
        attempt.state = "failed";
        continue;
      }
      if (attempt.slug === null && slug !== null) {
        // A slug-carrying completion of a name-only start binds the merge
        // slug to the attempt so the later AUDIT_MERGED can confirm it.
        attempt.slug = slug;
      }
      attempt.state = attempt.slug !== null ? "completed" : "merged";
    }
  };
  if (perUnit) {
    for (let start = floorIdx + 1; start < events.length;) {
      let end = start + 1;
      while (
        end < events.length &&
        events[end].timestamp === events[start].timestamp
      ) {
        end++;
      }
      const group = events.slice(start, end);
      const boltEvents = group.filter(
        (event) =>
          event.event === "BOLT_STARTED" ||
          event.event === "BOLT_COMPLETED" ||
          event.event === "BOLT_FAILED" ||
          event.event === "AUDIT_MERGED",
      );
      const byShard = new Map<string, AuditShardEvent[]>();
      for (const event of boltEvents) {
        const rows = byShard.get(event.shard) ?? [];
        rows.push(event);
        byShard.set(event.shard, rows);
      }
      const queues = [...byShard.values()];
      const eventPriority = (event: AuditShardEvent): number =>
        event.event === "BOLT_STARTED"
          ? 0
          : event.event === "BOLT_FAILED"
            ? 1
            : event.event === "BOLT_COMPLETED"
              ? 2
              : 3;
      while (queues.length > 0) {
        let selected = 0;
        for (let index = 1; index < queues.length; index++) {
          const priority =
            eventPriority(queues[index][0]) -
            eventPriority(queues[selected][0]);
          if (
            priority < 0 ||
            (priority === 0 &&
              queues[index][0].shardIndex <
                queues[selected][0].shardIndex)
          ) {
            selected = index;
          }
        }
        applyBoltEvent(queues[selected].shift()!);
        if (queues[selected].length === 0) queues.splice(selected, 1);
      }
      start = end;
    }
  }

  const mergedBoltUnits = new Set<string>();
  const openBoltUnits = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.state === "merged") mergedBoltUnits.add(attempt.unit);
    else if (attempt.state === "open" || attempt.state === "completed") {
      openBoltUnits.add(attempt.unit);
    }
  }
  return {
    allEvents,
    events,
    floorIdx,
    mergedBoltUnits,
    openBoltUnits,
  };
}

export function freshReviewReceipts(
  projectDir: string,
  stateContent: string,
  stage: {
    slug: string;
    phase: string;
    for_each?: string;
    reviewer?: string;
    review_artifact?: string;
    reviewer_max_iterations?: number;
    review_class?: "adversarial" | "advisory";
    workspace_requires?: boolean;
    produces?: string[];
    optional_produces?: string[];
    produces_kinds?: Record<string, string[]>;
  },
  options: {
    boltDag?: BoltDagResolution;
    reviewClass?: ReviewClass;
    attemptWindow?: ReviewAttemptWindow;
  } = {},
): FreshReviewReceipts {
  const empty: FreshReviewReceipts = {
    stageVerdict: null,
    stageStale: false,
    unitVerdicts: new Map(),
    newestSourceFingerprint: null,
    newestSourceUnit: null,
    sourceStale: false,
    sourceStaleProgress: null,
    sourceRecoverySpent: false,
    unitStale: new Set(),
    freshUnitClaims: new Map(),
    sourceBaseline: { state: "legacy" },
    currentSourceListing: null,
    stageStaleProgress: null,
    unitStaleProgress: new Map(),
    stageIteration: null,
    unitIterations: new Map(),
    stagePending: null,
    unitPending: new Map(),
    mergedBoltUnits: new Set(),
    openBoltUnits: new Set(),
  };
  const reviewer = stage.reviewer;
  if (!reviewer) return empty;
  const reviewClass = options.reviewClass ?? stage.review_class ?? "adversarial";
  if (reviewClass === "none") return empty;
  const maxIterations =
    reviewClass === "advisory" ? 1 : stage.reviewer_max_iterations ?? 2;
  const perUnit =
    stage.for_each === "unit-of-work" &&
    !usesStageLevelPerUnitArtifacts(
      getField(stateContent, "Scope"),
      stateContent,
    );
  const unitMajor =
    perUnit && getField(stateContent, "Construction Iteration")?.trim() === "unit-major";
  const teamOwnership = perUnit && isTeamUnitOwnership(stateContent);
  const attemptWindow =
    options.attemptWindow ??
    reviewAttemptWindow(projectDir, stateContent, stage);
  const { allEvents, events, floorIdx, mergedBoltUnits, openBoltUnits } =
    attemptWindow;
  empty.mergedBoltUnits = mergedBoltUnits;
  empty.openBoltUnits = openBoltUnits;
  const modernSourceBindingEvidence =
    hasModernSourceBindingEvidence(projectDir, allEvents);
  if (events.length === 0) {
    if (stage.workspace_requires === true && modernSourceBindingEvidence) {
      empty.sourceBaseline = { state: "invalid" };
    }
    return empty;
  }
  const eventIsCrossShardTied = (index: number): boolean => {
    // AUDIT_MERGED is referee merge plumbing (main-emitted, merge-protected)
    // with no reviewer authority: a same-second row in another shard must
    // not make a receipt, request, or boundary in this window ambiguous.
    const event = events[index];
    return events.some(
      (candidate, other) =>
        other !== index &&
        candidate.event !== "AUDIT_MERGED" &&
        candidate.timestamp === event.timestamp &&
        candidate.shard !== event.shard,
    );
  };
  const requestTieIsSessionBoundaryOnly = (index: number): boolean => {
    const event = events[index];
    let sawSessionBoundary = false;
    for (let other = 0; other < events.length; other++) {
      if (
        other === index ||
        events[other].timestamp !== event.timestamp ||
        events[other].shard === event.shard ||
        events[other].event === "AUDIT_MERGED"
      ) {
        continue;
      }
      if (
        events[other].event !== "SESSION_STARTED" &&
        events[other].event !== "SESSION_RESUMED"
      ) {
        return false;
      }
      sawSessionBoundary = true;
    }
    return sawSessionBoundary;
  };

  const dag = perUnit ? options.boltDag ?? resolveBoltDag(projectDir) : null;
  const observedBoltUnits = new Set([
    ...mergedBoltUnits,
    ...openBoltUnits,
  ]);
  const applicableUnits: Set<string> | null =
    dag?.state === "ok"
      ? new Set()
      : dag?.state === "none" && observedBoltUnits.size > 0
        ? observedBoltUnits
        : null;
  if (dag?.state === "ok" && applicableUnits !== null) {
    for (const unit of dag.units) {
      if (
        filterProducesByKind(
          stage.produces_kinds,
          stage.produces ?? [],
          dag.unitKinds?.get(unit) ?? null,
        ).length > 0
      ) applicableUnits.add(unit);
    }
  }

  // Collect fresh matching terminal reviews after the attempt floor. A later
  // declared-artifact write clears the matching receipt. For per-unit stages,
  // the path's construction/<unit>/ segment scopes invalidation to that unit;
  // an ambiguous matching path fails closed by clearing every unit receipt.
  const recordedRepos = new Set(intentRepos(projectDir));
  const unitVerdicts = new Map<string, ReviewVerdict>();
  const unitStale = new Set<string>();
  const unitStaleProgress = new Map<string, StaleReviewProgress>();
  const unitIterations = new Map<string, number>();
  const unitReceiptRecovery = new Map<string, boolean>();
  const unitPending = new Map<string, PendingReviewProgress>();
  const pendingRequests = new Map<
    string,
    {
      unit: string | undefined;
      iteration: number;
      recovery: boolean;
      binding: ReviewRequestBinding | null;
      timestamp: string;
      shard: string;
      suspensionActive: boolean;
    }
  >();
  const modernUnitReceipts = new Map<
    string,
    {
      fingerprint: string | null;
      bypass: boolean;
      order: number;
      timestamp: string;
      shard: string;
      iteration: number;
      recovery: boolean;
    }
  >();
  let stageVerdict: ReviewVerdict | null = null;
  let newestSourceFingerprint: string | null = null;
  let newestSourceUnit: string | null = null;
  let newestSourceProgress: StaleReviewProgress | null = null;
  let sourceRecoverySpent = false;
  let stageStale = false;
  let stageStaleProgress: StaleReviewProgress | null = null;
  let stageIteration: number | null = null;
  let stageReceiptRecovery = false;
  let stagePending: PendingReviewProgress | null = null;
  const resetUnitReviewState = (unit: string): void => {
    for (const [key, request] of pendingRequests) {
      if (request.unit === unit) pendingRequests.delete(key);
    }
    unitVerdicts.delete(unit);
    unitStale.delete(unit);
    unitStaleProgress.delete(unit);
    unitIterations.delete(unit);
    unitReceiptRecovery.delete(unit);
    unitPending.delete(unit);
    if (newestSourceUnit === unit) {
      newestSourceFingerprint = null;
      newestSourceUnit = null;
      newestSourceProgress = null;
      sourceRecoverySpent = false;
    }
  };
  let groupTimestamp: string | null = null;
  let deferredSessionBoundary = false;
  const deferredBoltUnits = new Set<string>();
  const applyDeferredBoundaries = (): void => {
    if (deferredSessionBoundary) {
      for (const request of pendingRequests.values()) {
        request.suspensionActive = false;
      }
    }
    for (const unit of deferredBoltUnits) resetUnitReviewState(unit);
    deferredSessionBoundary = false;
    deferredBoltUnits.clear();
  };
  for (let i = floorIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (groupTimestamp !== null && e.timestamp !== groupTimestamp) {
      applyDeferredBoundaries();
    }
    groupTimestamp = e.timestamp;
    const eventUnit = auditBlockField(e.block, "Unit");
    if (
      eventUnit &&
      !eventMatchesClaimAttempt(projectDir, e.block, eventUnit)
    ) {
      continue;
    }
    if (
      teamOwnership &&
      eventUnit &&
      (e.event === "REVIEW_REQUESTED" || e.event === "REVIEW_COMPLETED") &&
      events.some(
        (candidate) =>
          candidate.event === "GATE_REJECTED" &&
          candidate.timestamp === e.timestamp &&
          candidate.shard !== e.shard &&
          auditBlockField(candidate.block, "Unit") === eventUnit &&
          gateStagesFromBlock(candidate.block).includes(stage.slug),
      )
    ) {
      continue;
    }
    if (teamOwnership && e.event === "GATE_REJECTED") {
      const rejectedUnit = auditBlockField(e.block, "Unit");
      if (!rejectedUnit || !gateStagesFromBlock(e.block).includes(stage.slug)) {
        continue;
      }
      if (unitVerdicts.delete(rejectedUnit)) {
        unitStale.add(rejectedUnit);
        unitStaleProgress.set(rejectedUnit, {
          nextIteration: (unitIterations.get(rejectedUnit) ?? 0) + 1,
          recoverySpent: unitReceiptRecovery.get(rejectedUnit) ?? false,
        });
      }
      unitIterations.delete(rejectedUnit);
      unitReceiptRecovery.delete(rejectedUnit);
      unitPending.delete(rejectedUnit);
      for (const [key, request] of pendingRequests) {
        if (request.unit === rejectedUnit) pendingRequests.delete(key);
      }
      continue;
    }
    if (e.event === "SESSION_STARTED" || e.event === "SESSION_RESUMED") {
      if (eventIsCrossShardTied(i)) {
        deferredSessionBoundary = true;
        continue;
      }
      for (const request of pendingRequests.values()) {
        request.suspensionActive = false;
      }
      continue;
    }
    if (e.event === "BOLT_STARTED" && perUnit) {
      const units = (auditBlockField(e.block, "Bolt names") ?? "")
        .split(",")
        .map((unit) => unit.trim())
        .filter((unit) => unit.length > 0);
      if (eventIsCrossShardTied(i)) {
        for (const unit of units) deferredBoltUnits.add(unit);
        continue;
      }
      for (const unit of units) {
        resetUnitReviewState(unit);
      }
      continue;
    }
    if (e.event === "ARTIFACT_CREATED" || e.event === "ARTIFACT_UPDATED") {
      const file = auditBlockField(e.block, "File");
      if (!file) continue;
      const targetUnit = producesArtifactUnit(stage, file, recordedRepos);
      if (targetUnit === undefined) continue;
      if (!perUnit) {
        if (stageVerdict !== null) {
          stageStale = true;
          stageStaleProgress = {
            nextIteration: (stageIteration ?? 0) + 1,
            recoverySpent: stageReceiptRecovery,
          };
        }
        stageVerdict = null;
        stageIteration = null;
        stageReceiptRecovery = false;
      } else if (targetUnit === null) {
        for (const unit of unitVerdicts.keys()) {
          unitStale.add(unit);
          unitStaleProgress.set(unit, {
            nextIteration: (unitIterations.get(unit) ?? 0) + 1,
            recoverySpent: unitReceiptRecovery.get(unit) ?? false,
          });
        }
        unitVerdicts.clear();
        unitIterations.clear();
        unitReceiptRecovery.clear();
        modernUnitReceipts.clear();
      } else {
        if (unitVerdicts.delete(targetUnit)) {
          unitStale.add(targetUnit);
          unitStaleProgress.set(targetUnit, {
            nextIteration: (unitIterations.get(targetUnit) ?? 0) + 1,
            recoverySpent: unitReceiptRecovery.get(targetUnit) ?? false,
          });
        }
        unitIterations.delete(targetUnit);
        unitReceiptRecovery.delete(targetUnit);
        modernUnitReceipts.delete(targetUnit);
      }
      continue;
    }
    if (
      e.event !== "REVIEW_REQUESTED" &&
      e.event !== "REVIEW_COMPLETED"
    ) {
      continue;
    }
    if (auditBlockField(e.block, "Workflow")?.startsWith("single-stage:")) continue;
    if (auditBlockField(e.block, "Stage") !== stage.slug) continue;
    if (auditBlockField(e.block, "Reviewer") !== reviewer) continue;
    const iterationField = auditBlockField(e.block, "Iteration");
    if (!iterationField || !/^[1-9][0-9]*$/.test(iterationField)) continue;
    const iteration = Number(iterationField);
    const unit = auditBlockField(e.block, "Unit") || undefined;
    if (
      perUnit &&
      dag?.state === "ok" &&
      (unit === undefined || applicableUnits === null || !applicableUnits.has(unit))
    ) continue;
    if (
      perUnit &&
      dag?.state === "none" &&
      applicableUnits !== null &&
      unit !== undefined &&
      !applicableUnits.has(unit)
    ) continue;
    const requestKey = `${unit ?? ""}\u0000${iterationField}`;
    if (e.event === "REVIEW_REQUESTED") {
      const tiedAcrossShards = eventIsCrossShardTied(i);
      const sessionBoundaryOnlyTie =
        tiedAcrossShards && requestTieIsSessionBoundaryOnly(i);
      if (
        tiedAcrossShards &&
        !sessionBoundaryOnlyTie &&
        teamOwnership
      ) continue;
      const binding = reviewRequestBindingFromBlock(e.block);
      if (binding === null) continue;
      const previous = pendingRequests.get(requestKey);
      const recovery =
        previous?.recovery === true ||
        auditBlockField(e.block, "Recovery") === "stale-receipt";
      if (recovery) sourceRecoverySpent = true;
      pendingRequests.set(requestKey, {
        unit,
        iteration,
        recovery,
        binding,
        timestamp: e.timestamp,
        shard: e.shard,
        suspensionActive:
          recovery &&
          !sessionBoundaryOnlyTie &&
          /^sha256:[0-9a-f]{64}$/.test(binding.artifactFingerprint),
      });
      continue;
    }
    const verdict = auditBlockField(e.block, "Verdict");
    if (verdict !== "READY" && verdict !== "NOT-READY") continue;
    if (teamOwnership && eventIsCrossShardTied(i)) {
      pendingRequests.delete(requestKey);
      continue;
    }
    const request = pendingRequests.get(requestKey);
    if (
      !request ||
      (request.timestamp === e.timestamp && request.shard !== e.shard) ||
      !request.binding ||
      !reviewCompletionMatchesRequest(request.binding, e.block)
    ) {
      continue;
    }
    pendingRequests.delete(requestKey);
    const recordedFingerprint = auditBlockField(e.block, "Artifact Fingerprint");
    const artifactFingerprintUsable = recordedFingerprint !== null;
    const currentFingerprint = reviewArtifactFingerprint(
      projectDir,
      stage,
      unit,
      {
        boltDag: options.boltDag,
        stateContent,
        mergedBoltUnits,
      },
    );
    const fingerprintUsable =
      artifactFingerprintUsable && currentFingerprint !== null;
    const fingerprintMatches =
      fingerprintUsable && recordedFingerprint === currentFingerprint;
    const terminalVerdict = request.recovery
      ? verdict
      : terminalReviewVerdict(
          verdict,
          iterationField,
          reviewClass,
          maxIterations,
        );
    if (artifactFingerprintUsable && terminalVerdict !== null) {
      // A syntactically valid artifact binding on a TERMINAL receipt makes this
      // real post-migration source evidence, even if artifacts later changed.
      // A below-cap NOT-READY is repair progress, not a freshness boundary;
      // otherwise the expected repair edit would consume recovery prematurely.
      const sourceFingerprint = auditBlockField(e.block, "Source Fingerprint");
      if (sourceFingerprint && !eventIsCrossShardTied(i)) {
        newestSourceFingerprint = sourceFingerprint;
        newestSourceUnit = unit ?? null;
        newestSourceProgress = {
          nextIteration: iteration + 1,
          recoverySpent: request.recovery,
        };
      }
    }
    if (terminalVerdict === null) {
      if (verdict !== "NOT-READY" || !fingerprintUsable) continue;
      const pending: PendingReviewProgress = fingerprintMatches
        ? {
            state: "repair-required",
            iteration,
            recovery: request.recovery,
            suspensionActive: false,
            recoveryCause: request.binding?.recoveryCause ?? null,
          }
        : {
            state: "outstanding",
            iteration: iteration + 1,
            recovery: request.recovery,
            suspensionActive: false,
            recoveryCause: request.binding?.recoveryCause ?? null,
          };
      if (unit) {
        unitVerdicts.delete(unit);
        unitIterations.delete(unit);
        unitPending.set(unit, pending);
      } else {
        stageVerdict = null;
        stageIteration = null;
        stagePending = pending;
      }
      continue;
    }
    if (!fingerprintMatches) {
      if (fingerprintUsable) {
        if (unit) {
          unitStale.add(unit);
          unitStaleProgress.set(unit, {
            nextIteration: iteration + 1,
            recoverySpent: request.recovery,
          });
        } else {
          stageStale = true;
          stageStaleProgress = {
            nextIteration: iteration + 1,
            recoverySpent: request.recovery,
          };
        }
      }
      continue;
    }
    if (unit) {
      unitVerdicts.set(unit, terminalVerdict);
      unitStale.delete(unit);
      unitStaleProgress.delete(unit);
      unitIterations.set(unit, iteration);
      unitReceiptRecovery.set(unit, request.recovery);
      unitPending.delete(unit);
      modernUnitReceipts.set(unit, {
        fingerprint: auditBlockField(e.block, "Unit Source Fingerprint"),
        bypass: auditBlockField(e.block, "Unit Source Binding Bypass") === "true",
        order: i,
        timestamp: e.timestamp,
        shard: e.shard,
        iteration,
        recovery: request.recovery,
      });
    } else {
      stageVerdict = terminalVerdict;
      stageIteration = iteration;
      stageReceiptRecovery = request.recovery;
      stagePending = null;
      stageStale = false;
      stageStaleProgress = null;
    }
  }
  applyDeferredBoundaries();

  for (const request of pendingRequests.values()) {
    const pending: PendingReviewProgress = {
      state: "retry-required",
      iteration: request.iteration,
      recovery: request.recovery,
      suspensionActive: request.suspensionActive,
      recoveryCause: request.binding?.recoveryCause ?? null,
    };
    if (request.unit) {
      if (!request.recovery) unitVerdicts.delete(request.unit);
      unitIterations.delete(request.unit);
      unitPending.set(request.unit, pending);
    } else {
      if (!request.recovery) stageVerdict = null;
      stageIteration = null;
      stagePending = pending;
    }
  }

  const sourceFreshnessApplies =
    stage.workspace_requires === true &&
    process.env.AIDLC_SKIP_SOURCE_FRESHNESS !== "1";
  const needsCurrentSource =
    stage.workspace_requires === true &&
    (newestSourceFingerprint !== null || modernUnitReceipts.size > 0);
  // One shared temp-index pass supplies BOTH global reconciliation and every
  // per-unit comparison. Never recompute inside the unit loop.
  const currentSourceState = needsCurrentSource
    ? workspaceSourceState(projectDir)
    : null;
  const currentSourceFingerprint = currentSourceState?.fingerprint ?? null;
  const currentSourceListing = currentSourceState?.listing ?? null;
  const sourceStale =
    newestSourceFingerprint !== null &&
    (newestSourceFingerprint === UNBINDABLE_FINGERPRINT ||
      currentSourceFingerprint === null ||
      currentSourceFingerprint !== newestSourceFingerprint);

  const freshUnitClaims = new Map<string, SourceClaimModel>();
  if (sourceFreshnessApplies && currentSourceListing !== null) {
    const newerFreshClaims: SourceClaimModel[] = [];
    const receiptsNewestFirst = [...modernUnitReceipts.entries()]
      .filter(([unit]) => unitVerdicts.has(unit))
      .sort((a, b) => b[1].order - a[1].order);
    const ambiguousReceiptTimes = new Set(
      receiptsNewestFirst
        .filter(([, receipt], index, all) =>
          all.some(
            ([, other], otherIndex) =>
              otherIndex !== index &&
              other.timestamp === receipt.timestamp &&
              other.shard !== receipt.shard,
          ),
        )
        .map(([, receipt]) => receipt.timestamp),
    );
    for (const [unit, receipt] of receiptsNewestFirst) {
      // Shielding needs a real newest claimant. Equal-second receipts from
      // different shards are causally unordered, so invalidate that tied set
      // rather than let shard filename order choose authority.
      if (ambiguousReceiptTimes.has(receipt.timestamp)) {
        unitVerdicts.delete(unit);
        unitStale.add(unit);
        unitStaleProgress.set(unit, {
          nextIteration: receipt.iteration + 1,
          recoverySpent: receipt.recovery,
        });
        continue;
      }
      // No modern binding marker at all is migration evidence: keep the #629
      // global policy for this unit and do not invent claims from current bytes.
      if (receipt.fingerprint === null && !receipt.bypass) continue;
      let stale = receipt.bypass;
      let claimModel: SourceClaimModel | null = null;
      let reviewedListing: WorkspaceSourceListing | null = null;
      if (!stale && receipt.fingerprint === UNBINDABLE_FINGERPRINT) stale = true;
      if (!stale && receipt.fingerprint !== null) {
        const snapshot = readUnitSourceSnapshot(
          projectDir,
          stage.slug,
          unit,
          receipt.fingerprint,
        );
        const manifest = readUnitSourceManifest(projectDir, stage.slug, unit);
        if (snapshot === null || !manifest.ok || snapshot.manifestSha256 !== manifest.rawBytesSha256) {
          stale = true;
        } else {
          claimModel = { claims: manifest.claims, prefixes: manifest.prefixes };
          reviewedListing = snapshot.listing;
          for (const [pathKey, reviewedOid] of reviewedListing) {
            if (newerFreshClaims.some((claims) => sourceClaimCovers(pathKey, claims))) continue;
            if (
              !sourceListingEntriesEqual(
                currentSourceListing.get(pathKey),
                reviewedOid,
              )
            ) {
              stale = true;
              break;
            }
          }
          if (!stale) {
            // Both exact and directory claims bind future additions. An exact
            // claim that was absent at review cannot launder a later-created
            // path; over-claiming therefore invalidates more receipts, never
            // fewer. A newer validated claimant may still shield the path.
            for (const [pathKey] of currentSourceListing) {
              const newlyPresentExact = manifest.claims.has(pathKey) && !reviewedListing.has(pathKey);
              const newlyPresentUnderPrefix =
                manifest.prefixes.some((prefix) => pathKey.startsWith(prefix)) &&
                !reviewedListing.has(pathKey);
              if (!newlyPresentExact && !newlyPresentUnderPrefix) continue;
              if (newerFreshClaims.some((claims) => sourceClaimCovers(pathKey, claims))) continue;
              stale = true;
              break;
            }
          }
        }
      }
      if (stale) {
        unitVerdicts.delete(unit);
        unitStale.add(unit);
        unitStaleProgress.set(unit, {
          nextIteration: receipt.iteration + 1,
          recoverySpent: receipt.recovery,
        });
        continue;
      }
      if (claimModel !== null) {
        freshUnitClaims.set(unit, claimModel);
        newerFreshClaims.push(claimModel);
      }
    }
  } else if (sourceFreshnessApplies && modernUnitReceipts.size > 0) {
    for (const [unit, receipt] of modernUnitReceipts) {
      if (!unitVerdicts.has(unit)) continue;
      if (receipt.fingerprint === null && !receipt.bypass) continue;
      unitVerdicts.delete(unit);
      unitStale.add(unit);
      unitStaleProgress.set(unit, {
        nextIteration: receipt.iteration + 1,
        recoverySpent: receipt.recovery,
      });
    }
  }

  // Anchor the unclaimed-path baseline to the stage's real entry. Unit-major
  // NEVER trusts STAGE_STARTED because shell/generator source writes can precede
  // that row without ARTIFACT_* evidence. GATE_REJECTED resets review accounting
  // but never re-anchors cumulative manifests: doing so would grandfather any
  // unclaimed source present when the human requested changes. Synthetic
  // single-stage rows cannot affect the floor.
  let sourceBaseline: SourceBaselineResult = { state: "legacy" };
  if (stage.workspace_requires === true) {
    let boundary = -1;
    for (let i = 0; i < events.length; i++) {
      if (auditBlockField(events[i].block, "Workflow")?.startsWith("single-stage:")) continue;
      if (
        events[i].event === "WORKFLOW_STARTED" ||
        events[i].event === "STAGE_JUMPED"
      ) {
        boundary = i;
      }
    }
    let firstWork = events.length;
    for (let i = Math.max(boundary, 0); i < events.length; i++) {
      const event = events[i];
      if (auditBlockField(event.block, "Workflow")?.startsWith("single-stage:")) continue;
      if (auditBlockField(event.block, "Stage") !== stage.slug) continue;
      if (event.event === "REVIEW_REQUESTED") {
        firstWork = i;
        break;
      }
      if (event.event === "ARTIFACT_CREATED" || event.event === "ARTIFACT_UPDATED") {
        const file = auditBlockField(event.block, "File");
        if (file && producesArtifactUnit(stage, file, recordedRepos) !== undefined) {
          firstWork = i;
          break;
        }
      }
    }
    let baselineField: string | null = null;
    for (let i = Math.max(boundary, 0); i < firstWork; i++) {
      const event = events[i];
      const field = sourceBaselineBoundaryValue(
        event,
        stage.slug,
        unitMajor,
      );
      if (field === undefined) continue;
      if (
        field !== null &&
        auditEventIsCrossShardTied(
          events,
          i,
          (candidate) =>
            sourceBaselineBoundaryValue(
              candidate,
              stage.slug,
              unitMajor,
            ),
        )
      ) {
        baselineField = UNBINDABLE_FINGERPRINT;
      } else {
        baselineField = field;
      }
    }
    if (baselineField === UNBINDABLE_FINGERPRINT) sourceBaseline = { state: "unbindable" };
    else if (baselineField !== null) {
      const listing = readBaselineSourceSnapshot(projectDir, stage.slug, baselineField);
      sourceBaseline = listing === null ? { state: "invalid" } : { state: "ready", listing };
    } else if (modernSourceBindingEvidence) {
      sourceBaseline = { state: "invalid" };
    }
  }

  return {
    stageVerdict,
    stageStale,
    unitVerdicts,
    newestSourceFingerprint,
    newestSourceUnit,
    sourceStale,
    sourceStaleProgress: sourceStale
      ? newestSourceProgress === null
        ? null
        : {
            ...newestSourceProgress,
            recoverySpent: sourceRecoverySpent,
          }
      : null,
    sourceRecoverySpent,
    unitStale,
    freshUnitClaims,
    sourceBaseline,
    currentSourceListing: sourceFreshnessApplies ? currentSourceListing : null,
    stageStaleProgress,
    unitStaleProgress,
    stageIteration,
    unitIterations,
    stagePending,
    unitPending,
    mergedBoltUnits,
    openBoltUnits,
  };
}

// Private refs keep reviewed-source commits reachable until the Bolt is merged
// or discarded. The commit suffix matters: a later finalize retry must not move
// the only ref away from an earlier commit already named by an audit row.
export function reviewedSourceRefPrefix(boltSlug: string): string {
  return `refs/aidlc/reviewed-source/${boltSlug}/`;
}

export function reviewedSourceRef(boltSlug: string, commit: string): string {
  return `${reviewedSourceRefPrefix(boltSlug)}${commit}`;
}

// --- Multi-repo: repos are siblings of the workspace ----------------------------
//
// In the workspace model the projectDir is the WORKSPACE roof (`my-workspace/`),
// which is NOT itself a git repo. Code repos are its immediate children
// (`my-workspace/repo-a/`, `my-workspace/repo-b/`) — siblings of `aidlc/` and the
// engine dir (vision §7). An intent records the repos it touches in its
// intents.json row (`repos`); construction targets a specific one. P7 decouples
// "the repo to operate on" from "the single projectDir": before P7 the worktree
// tool ran `git worktree add` in the projectDir's own cwd (assuming projectDir IS
// the repo); now `--repo <name>` anchors it to the sibling repo dir instead.
//
// repoDir resolves the on-disk dir for a repo name; it does NOT validate that the
// dir exists or is a git repo (the caller does, where the git op runs).

// A repo name is a single path segment (no separators, no `..`) so it can only
// resolve to an immediate child of the workspace — never escape it.
export const REPO_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRepoName(name: string): boolean {
  return REPO_NAME_REGEX.test(name) && name !== "." && name !== "..";
}

// The on-disk dir for a sibling repo: an immediate child of the workspace root.
export function repoDir(projectDir: string, repoName: string): string {
  return join(projectDir, repoName);
}

// --- Workspace source fingerprint (#629) -----------------------------------
//
// A reviewer receipt for a `workspace_requires` stage (code-generation) must be
// bound to the SOURCE STATE the reviewer actually inspected: workspace writes
// deliberately emit no audit events (aidlc-audit-logger.ts excludes them), so
// without a binding a post-review source edit leaves the receipt satisfying the
// completion guard for code nobody re-reviewed. The binding is one canonical,
// bounded filesystem identity, independent of repository metadata and Git
// executable availability. It makes supported non-Git and missing-Git
// workspaces bindable, includes ignored application bytes, and excludes only
// explicit framework/dependency/cache and generated-output boundaries.
// Reverting an edit restores the original fingerprint
// (content-addressed), so an undone change does not strand a receipt.
//
// Multi-repo: the intent's recorded repo set (intentRepos), each resolved via
// repoDir(); no recorded repos = the legacy single-repo default (projectDir).
// The workspace roof is a separate source boundary: top-level files such as
// compose manifests remain covered, while top-level directories stay outside
// unless .aidlc-source-paths.json explicitly re-includes one. That stable
// partition prevents unrelated siblings from entering when their `.git`
// metadata disappears. Missing registered repos carry a stable marker and
// change the identity when they appear. Null now means the bounded scan itself
// was unreadable, unstable, over budget, or misconfigured, not merely that Git
// or a repository is absent.

// The record tree and the CLI/IDE workspace shell are anchored at the top level
// of the dir that CARRIES the shell: the workspace roof, or a Bolt worktree
// (which holds its own record mirror). For a multi-repo intent `aidlc/` is a
// SIBLING of the repo dirs (resolveConstructionRepo / repoDir) and
// `.aidlc/worktrees/` (worktreePath) hangs off the roof - neither is ever
// legitimately inside a fingerprinted repo or submodule, where a directory of
// those names is application source (#646 review). Files with these names stay
// source; the walker and Git snapshot shape exclude only directory/symlink
// entries at the shell-carrying root.
const AIDLC_SHELL_PATHS = ["aidlc", ".aidlc"];

// The sensor-cache exclusion remains depth-tolerant for legacy and worktree
// paths. Before 2.6.94, the type-check sensor anchored
// `.aidlc-sensors/.tsbuildinfo` at the nearest tsconfig directory, so monorepo
// package caches could appear anywhere under repoDir. Those stray trees persist
// in upgraded repositories, and Bolt worktree record mirrors can also sit below
// the workspace roof, while the shell names stay root-anchored.
//
// #646 review - the shell/any-depth split is deliberate, not an oversight: an
// earlier fix applied `**/<name>/**` to ALL four names to close a *reported*
// nested-.aidlc-sensors leak, but that pathspec matches the literal directory
// name at ANY depth - including a directory that is genuinely part of the
// application, coincidentally named `aidlc`/`.aidlc` for reasons unrelated to
// this framework's own shell (e.g. `src/aidlc/parser.ts`, a real feature named
// after the methodology). That silently dropped real source from the
// fingerprint - reproduced: `workspaceSourceFingerprint` was unchanged after
// adding tracked content under `src/aidlc/`.
//
// Depth tolerance is NOT permission to match the leaf name alone (#646 review,
// later round): a bare `**/.aidlc-sensors/**` excludes ANY directory of that
// name, so an application tracking source under a dot-prefixed,
// framework-named directory (`src/.aidlc-sensors/shipped.ts`) could be edited
// or deleted without moving the fingerprint. Match the cache by the path the
// engine actually writes instead of by its leaf. Every writer resolves through
// `sensorsDir()` -> `docsRoot()` -> `intentsDir()` -> `workspaceRoot()`, so the
// cache is always `<anchor>/aidlc/spaces/<space>/intents[/<record>]/
// .aidlc-sensors/`. The `<anchor>` can be the roof, a Bolt worktree, or a
// legacy pre-2.6.94 monorepo package tsconfig directory, which is exactly what
// the leading `**/` absorbs. The inner `/**/` also matches zero directories,
// covering the flat (no active record) form.
const AIDLC_SENSOR_CACHE_GLOBS = [
  ":(glob)**/aidlc/spaces/*/intents/**/.aidlc-sensors/**",
];

interface WorkspaceSourceExclusionContext {
  carriesWorkspaceShell: boolean;
  exactPaths: string[];
}

function worktreeSourceExclusionContext(
  projectDir: string,
): WorkspaceSourceExclusionContext | null {
  const metaPath = join(projectDir, ".aidlc", "worktree-meta.json");
  if (!existsSync(metaPath)) {
    return { carriesWorkspaceShell: true, exactPaths: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
  if (
    !isPlainObject(parsed) ||
    !("repoSelector" in parsed) ||
    (
      parsed.repoSelector !== null &&
      (typeof parsed.repoSelector !== "string" ||
        parsed.repoSelector.length === 0)
    )
  ) {
    return null;
  }
  if (parsed.repoSelector === null) {
    return { carriesWorkspaceShell: true, exactPaths: [] };
  }
  const exactPaths = [
    ".aidlc/worktree-meta.json",
    ".aidlc/base-source-listing.tsv",
    "aidlc/.aidlc-clone-id",
  ];
  if ("intentRecord" in parsed) {
    if (
      typeof parsed.intentRecord !== "string" ||
      !/^aidlc\/spaces\/[^/]+\/intents\/[^/]+$/.test(parsed.intentRecord)
    ) {
      return null;
    }
    exactPaths.push(`${parsed.intentRecord}/`);
  }
  return { carriesWorkspaceShell: false, exactPaths };
}

function sourceGitExclusionPathspecs(
  carriesWorkspaceShell: boolean,
  repoDir?: string,
): string[] {
  let exactPaths: string[] = [];
  if (!carriesWorkspaceShell && repoDir !== undefined) {
    const context = worktreeSourceExclusionContext(repoDir);
    if (context !== null && !context.carriesWorkspaceShell) {
      exactPaths = context.exactPaths;
    }
  }
  return [
    ...(carriesWorkspaceShell
      ? AIDLC_SHELL_PATHS.map((path) => `${path}/`)
      : []),
    ...exactPaths.map((path) => `:(top)${path}`),
    ...AIDLC_SENSOR_CACHE_GLOBS,
  ];
}

export function workspaceSourceExclusionPathspecs(
  projectDir: string,
): string[] | null {
  const context = worktreeSourceExclusionContext(projectDir);
  return context === null
    ? null
    : sourceGitExclusionPathspecs(
        context.carriesWorkspaceShell,
        projectDir,
      );
}

// Dependency and machine-local cache trees are never application source. These
// names are excluded at every depth in both Git and filesystem modes so a
// missing Git executable cannot turn a normal dependency install into a
// multi-gigabyte freshness walk.
const SOURCE_FINGERPRINT_HARD_EXCLUDED_NAMES = [
  ".cache",
  ".git",
  ".gradle",
  ".mypy_cache",
  ".next",
  ".nuxt",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "node_modules",
  "venv",
] as const;
const SOURCE_FINGERPRINT_HARD_EXCLUDED_DIRS = new Set<string>(
  SOURCE_FINGERPRINT_HARD_EXCLUDED_NAMES,
);
const SOURCE_FINGERPRINT_HARD_EXCLUDED_GLOBS =
  SOURCE_FINGERPRINT_HARD_EXCLUDED_NAMES.map(
    (name) => `:(glob)**/${name}/**`,
  );

// These names commonly hold generated output, but can also hold real source.
// They are always outside the default identity so repository/Git availability
// cannot change the boundary. Real source beneath them must be named explicitly
// in .aidlc-source-paths.json; registered paths are content-bound regardless of
// extension or binary/text encoding.
const SOURCE_FINGERPRINT_CONDITIONAL_NAMES = [
  "build",
  "coverage",
  "dist",
  "logs",
  "target",
  "tmp",
] as const;
const SOURCE_FINGERPRINT_CONDITIONAL_DIRS = new Set<string>(
  SOURCE_FINGERPRINT_CONDITIONAL_NAMES,
);
const SOURCE_FINGERPRINT_CONDITIONAL_GLOBS =
  SOURCE_FINGERPRINT_CONDITIONAL_NAMES.map(
    (name) => `:(glob)**/${name}/**`,
  );
const SOURCE_FINGERPRINT_REGISTRY = ".aidlc-source-paths.json";

// Git runs a configured `clean` filter as content enters a swarm snapshot index.
// The canonical fingerprint already hashes the raw filesystem bytes, so the
// immutable Source Commit must replace filtered index blobs with those same raw
// bytes. A lossy filter must not make the later merge differ from the source the
// reviewer inspected.
//
// Scoped by attribute AND configured driver, because both are required for a
// filter to run at all: a `.gitattributes` naming `filter=tidy` is inert unless
// `filter.tidy.clean` exists in the reader's own config (probed - the trees
// differ once the driver is removed). That is also why this is not injectable
// by someone pushing to the repository, and why the scan costs one `check-attr`
// on a repo that filters nothing. `hash-object` runs WITHOUT `-w`: the oid is
// computed, never written into the caller's object store.
//
// Not covered, deliberately: end-of-line conversion (`core.autocrlf`, `text`,
// `eol`). It is the one lossy transform that is ubiquitous, and the bytes it
// hides are line terminators - a semantically null delta - so paying a raw hash
// for every text file in the tree to bind it is not a trade worth making here.
function cleanFilteredRawLines(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  paths: string[],
): { lines: string[]; entries: { path: string; sha: string }[] } | null {
  if (paths.length === 0) return { lines: [], entries: [] };
  // Ask Git directly for the effective attributes of every indexed path. A
  // filesystem pre-scan cannot be authoritative: `.gitattributes` may itself
  // be ignored while still affecting the worktree, and info/global attributes
  // live outside the indexed path list. The large buffer matches `ls-files`
  // below; failure is unbindable, never "no filtered paths".
  const attr = spawnSync(
    "git",
    ["-C", repoDir, "check-attr", "-z", "--stdin", "filter", "ident"],
    {
      env,
      input: paths.join("\0"),
      encoding: "utf-8",
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  if (attr.status !== 0) return null;
  // `-z` output is a flat NUL-separated stream of <path> <attr> <value> triples.
  const fields = attr.stdout.split("\0");
  const driverRuns = new Map<string, boolean>();
  const converted = new Set<string>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const path = fields[i];
    const name = fields[i + 1];
    const value = fields[i + 2];
    if (!path) continue;
    if (name === "ident") {
      // Git's built-in `$Id$` conversion. There is no driver to configure, so
      // `set` alone means two worktree values collapse onto one indexed blob.
      if (value === "set") converted.add(path);
      continue;
    }
    // `unspecified`/`unset` mean no driver; `set` is `filter` with no name, so
    // it names no driver either. Anything else is a driver name.
    if (value === "unspecified" || value === "unset" || value === "set") continue;
    let runs = driverRuns.get(value);
    if (runs === undefined) {
      const configured = (key: "clean" | "process"): boolean | null => {
        const cfg = spawnSync(
          "git",
          ["-C", repoDir, "config", "--get", `filter.${value}.${key}`],
          { env, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
        );
        if (cfg.status === 0) return cfg.stdout.trim().length > 0;
        if (cfg.status === 1) return false; // key is simply absent
        return null;
      };
      const clean = configured("clean");
      const processDriver = configured("process");
      if (clean === null || processDriver === null) return null;
      runs = clean || processDriver;
      driverRuns.set(value, runs);
    }
    if (runs) converted.add(path);
  }
  const filtered = [...converted];
  if (filtered.length === 0) return { lines: [], entries: [] };
  // `--stdin-paths` is newline-delimited with no `-z` counterpart, so a path
  // containing a newline cannot go through the batch. Those hash one at a time
  // rather than being dropped - dropping one would restore the very blind spot
  // this closes.
  const batch = filtered.filter((p) => !p.includes("\n"));
  const lines: string[] = [];
  const entries: { path: string; sha: string }[] = [];
  if (batch.length > 0) {
    const raw = spawnSync(
      "git",
      ["-C", repoDir, "hash-object", "--no-filters", "--stdin-paths"],
      {
        env,
        input: `${batch.join("\n")}\n`,
        encoding: "utf-8",
        maxBuffer: 512 * 1024 * 1024,
      },
    );
    if (raw.status !== 0) return null;
    const shas = raw.stdout.split("\n").filter((l) => l.length > 0);
    // A short read means the pairing is ambiguous; binding the wrong sha to a
    // path is worse than the mismatch a null fingerprint produces.
    if (shas.length !== batch.length) return null;
    for (let i = 0; i < batch.length; i++) {
      lines.push(`raw:${batch[i]}=${shas[i]}`);
      entries.push({ path: batch[i], sha: shas[i] });
    }
  }
  for (const p of filtered) {
    if (!p.includes("\n")) continue;
    const one = spawnSync(
      "git",
      ["-C", repoDir, "hash-object", "--no-filters", "--", p],
      { env, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (one.status !== 0) return null;
    const sha = one.stdout.trim();
    if (sha.length === 0) return null;
    lines.push(`raw:${p}=${sha}`);
    entries.push({ path: p, sha });
  }
  return { lines, entries };
}

// Return the effective filtered paths and their raw worktree blob ids for a
// caller-owned temporary index. The swarm snapshot uses this to replace the
// filtered index blobs with the exact bytes the reviewer saw before creating
// its immutable Source Commit.
export function filteredRawIndexEntries(
  repoDir: string,
  indexFile: string,
  includedRegularPaths: ReadonlySet<string>,
): { path: string; sha: string }[] | null {
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const listed = spawnSync("git", ["-C", repoDir, "ls-files", "-s", "-z"], {
    env,
    encoding: "utf-8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (listed.status !== 0) return null;
  const paths: string[] = [];
  for (const record of listed.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    // Clean/process filters transform regular file content only. Passing a
    // symlink through `hash-object --no-filters -- <path>` follows its target,
    // replacing Git's mode-120000 link-text blob with the target file's bytes.
    // Leave symlinks (and gitlinks) exactly as `git add -A` staged them.
    if (tab === -1 || !/^100(?:644|755) /.test(record)) continue;
    const path = record.slice(tab + 1);
    if (path && includedRegularPaths.has(path)) paths.push(path);
  }
  return cleanFilteredRawLines(repoDir, env, paths)?.entries ?? null;
}

const GIT_OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_OBJECT_ID_CASE_INSENSITIVE_RE =
  /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

function normalizeGitObjectId(value: string): string | null {
  return GIT_OBJECT_ID_CASE_INSENSITIVE_RE.test(value)
    ? value.toLowerCase()
    : null;
}

function sourceListingEntry(mode: string, oid: string): string | null {
  if (!/^\d{6}$/.test(mode) || !GIT_OBJECT_ID_RE.test(oid)) return null;
  return `${mode} ${oid}`;
}

export type WorkspaceSourceListing = Map<string, string>;

export interface WorkspaceSourceState {
  fingerprint: string;
  listing: WorkspaceSourceListing;
}

function prefixedSourceListing(
  listing: ReadonlyMap<string, string>,
  repo = "",
): WorkspaceSourceListing {
  return new Map(
    [...listing].map(([path, entry]) => [`${repo}\0${path}`, entry]),
  );
}

interface GitTreeLeafEntry {
  mode: "100644" | "100755" | "120000" | "160000";
  oid: string;
  path: string;
}

interface SyncBufferedReader {
  buffer: Buffer;
  end: number;
  fd: number;
  offset: number;
  position: number;
}

function refillSyncBufferedReader(reader: SyncBufferedReader): boolean {
  const count = readSync(
    reader.fd,
    reader.buffer,
    0,
    reader.buffer.length,
    reader.position,
  );
  reader.offset = 0;
  reader.end = count;
  reader.position += count;
  return count > 0;
}

function readSyncBufferedLine(
  reader: SyncBufferedReader,
  maxBytes: number,
): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    if (
      reader.offset >= reader.end &&
      !refillSyncBufferedReader(reader)
    ) {
      return null;
    }
    const newline = reader.buffer.indexOf(0x0a, reader.offset);
    if (newline !== -1 && newline < reader.end) {
      const chunk = reader.buffer.subarray(reader.offset, newline);
      chunks.push(chunk);
      total += chunk.length;
      reader.offset = newline + 1;
      if (total > maxBytes) return null;
      return chunks.length === 1
        ? Buffer.from(chunks[0])
        : Buffer.concat(chunks, total);
    }
    const chunk = reader.buffer.subarray(reader.offset, reader.end);
    chunks.push(chunk);
    total += chunk.length;
    reader.offset = reader.end;
    if (total > maxBytes) return null;
  }
}

function copySyncBufferedBytes(
  reader: SyncBufferedReader,
  size: number,
  outputFd: number,
): boolean {
  let remaining = size;
  while (remaining > 0) {
    if (
      reader.offset >= reader.end &&
      !refillSyncBufferedReader(reader)
    ) {
      return false;
    }
    const count = Math.min(remaining, reader.end - reader.offset);
    if (
      writeSync(
        outputFd,
        reader.buffer,
        reader.offset,
        count,
      ) !== count
    ) {
      return false;
    }
    reader.offset += count;
    remaining -= count;
  }
  if (
    reader.offset >= reader.end &&
    !refillSyncBufferedReader(reader)
  ) {
    return false;
  }
  if (reader.buffer[reader.offset] !== 0x0a) return false;
  reader.offset += 1;
  return true;
}

function readSyncBufferedBytes(
  reader: SyncBufferedReader,
  size: number,
  maxBytes: number,
): Buffer | null {
  if (size > maxBytes) return null;
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    if (
      reader.offset >= reader.end &&
      !refillSyncBufferedReader(reader)
    ) {
      return null;
    }
    const count = Math.min(size - offset, reader.end - reader.offset);
    reader.buffer.copy(bytes, offset, reader.offset, reader.offset + count);
    reader.offset += count;
    offset += count;
  }
  if (
    reader.offset >= reader.end &&
    !refillSyncBufferedReader(reader)
  ) {
    return null;
  }
  if (reader.buffer[reader.offset] !== 0x0a) return null;
  reader.offset += 1;
  return bytes;
}

function gitTreeLeafEntries(
  repoDir: string,
  commit: string,
): GitTreeLeafEntry[] | null {
  const objectType = spawnSync(
    "git",
    ["-C", repoDir, "cat-file", "-t", commit],
    { encoding: "utf-8", maxBuffer: 1024 * 1024 },
  );
  if (objectType.status !== 0 || objectType.stdout.trim() !== "commit") {
    return null;
  }
  const listed = spawnSync(
    "git",
    ["-C", repoDir, "ls-tree", "-r", "-z", "--full-tree", commit],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  if (listed.status !== 0 || !Buffer.isBuffer(listed.stdout)) return null;
  const maxEntries = sourceIdentityBudget(
    "AIDLC_TEST_SOURCE_MAX_ENTRIES",
    250_000,
  );
  const entries: GitTreeLeafEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset < listed.stdout.length) {
    const nul = listed.stdout.indexOf(0, offset);
    if (nul === -1) return null;
    if (nul === offset) {
      offset += 1;
      continue;
    }
    const record = listed.stdout.subarray(offset, nul);
    offset = nul + 1;
    const tab = record.indexOf(0x09);
    if (tab === -1) return null;
    const header = record.subarray(0, tab).toString("ascii");
    const match =
      /^(100644|100755|120000|160000) (blob|commit) ([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/
        .exec(header);
    if (match === null) return null;
    const mode = match[1] as GitTreeLeafEntry["mode"];
    if (
      (mode === "160000" && match[2] !== "commit") ||
      (mode !== "160000" && match[2] !== "blob")
    ) {
      return null;
    }
    const pathBytes = record.subarray(tab + 1);
    const path = pathBytes.toString("utf-8");
    if (
      path.length === 0 ||
      !Buffer.from(path, "utf-8").equals(pathBytes) ||
      isAbsolute(path) ||
      /^[A-Za-z]:\//.test(path) ||
      path.startsWith("//") ||
      path
        .split("/")
        .some((part) => part.length === 0 || part === "." || part === "..") ||
      seen.has(path)
    ) {
      return null;
    }
    const oid = normalizeGitObjectId(match[3]);
    if (oid === null) return null;
    seen.add(path);
    entries.push({ mode, oid, path });
    if (entries.length > maxEntries) return null;
  }
  return entries;
}

function materializeRawGitTree(
  repoDir: string,
  root: string,
  entries: readonly GitTreeLeafEntry[],
): boolean {
  const blobs = entries.filter((entry) => entry.mode !== "160000");
  const batchPath = join(dirname(root), "cat-file.batch");
  let batchFd: number | undefined;
  try {
    batchFd = openSync(batchPath, "w+");
    const batch = spawnSync(
      "git",
      ["-C", repoDir, "cat-file", "--batch"],
      {
        input: Buffer.from(
          blobs.map((entry) => entry.oid).join("\n") +
            (blobs.length > 0 ? "\n" : ""),
        ),
        stdio: ["pipe", batchFd, "pipe"],
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (batch.status !== 0) return false;
    const reader: SyncBufferedReader = {
      buffer: Buffer.allocUnsafe(64 * 1024),
      end: 0,
      fd: batchFd,
      offset: 0,
      position: 0,
    };
    for (const entry of blobs) {
      const header = readSyncBufferedLine(reader, 8192);
      if (header === null) return false;
      const parsed =
        /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64}) blob ([0-9]+)$/
          .exec(header.toString("ascii"));
      const size =
        parsed === null || parsed[2].length > 16
          ? Number.NaN
          : Number(parsed[2]);
      if (
        parsed === null ||
        normalizeGitObjectId(parsed[1]) !== entry.oid ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 4 * 1024 * 1024 * 1024
      ) {
        return false;
      }
      const target = join(root, entry.path);
      mkdirSync(dirname(target), { recursive: true });
      if (entry.mode === "120000") {
        const linkBytes = readSyncBufferedBytes(reader, size, 64 * 1024);
        if (linkBytes === null) return false;
        const linkText = linkBytes.toString("utf-8");
        if (!Buffer.from(linkText, "utf-8").equals(linkBytes)) return false;
        symlinkSync(linkText, target);
        continue;
      }
      let outputFd: number | undefined;
      try {
        outputFd = openSync(
          target,
          "wx",
          entry.mode === "100755" ? 0o755 : 0o644,
        );
        if (!copySyncBufferedBytes(reader, size, outputFd)) return false;
      } finally {
        if (outputFd !== undefined) closeSync(outputFd);
      }
      chmodSync(target, entry.mode === "100755" ? 0o755 : 0o644);
    }
    for (const entry of entries) {
      if (entry.mode !== "160000") continue;
      mkdirSync(join(root, entry.path), { recursive: true });
    }
    return true;
  } catch {
    return false;
  } finally {
    if (batchFd !== undefined) closeSync(batchFd);
  }
}

/**
 * Reconstruct a source listing from immutable tree/blob bytes without
 * registering a Git worktree or touching the caller's index/worktree. Raw
 * materialization deliberately avoids checkout filters, EOL conversion, and
 * working-tree encodings. The opt-in live-target mode is used only for the
 * one-time worktree base snapshot.
 */
export function gitCommitSourceListing(
  repoDir: string,
  commit: string,
  carriesWorkspaceShell: boolean,
  followExternalTargets = false,
): WorkspaceSourceListing | null {
  if (!isGitRepoDir(repoDir) || !GIT_OBJECT_ID_RE.test(commit)) return null;
  const root = join(tmpdir(), `aidlc-commit-listing-${process.pid}-${randomUUID().slice(0, 8)}`);
  const checkoutDir = join(root, "checkout");
  try {
    mkdirSync(checkoutDir, { recursive: true });
    const entries = gitTreeLeafEntries(repoDir, commit);
    if (entries === null) return null;
    if (!materializeRawGitTree(repoDir, checkoutDir, entries)) return null;
    const source = filesystemSourceIdentity(
      checkoutDir,
      carriesWorkspaceShell,
      new Set(),
      followExternalTargets ? "follow" : "tree-only",
      false,
    );
    if (source === null) return null;
    return prefixedSourceListing(source.listing);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * New listings bind mode/type plus OID. Three-column snapshots from the
 * immediately preceding format carry only an OID; they migrate by content
 * equality while every newly written snapshot remains mode-aware.
 */
export function sourceListingEntriesEqual(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const leftModern =
    /^\d{6} ((?:[0-9a-f]{40}|[0-9a-f]{64}))$/.exec(left);
  const rightModern =
    /^\d{6} ((?:[0-9a-f]{40}|[0-9a-f]{64}))$/.exec(right);
  if (leftModern !== null && rightModern !== null) return false;
  const leftOid = leftModern?.[1] ?? (GIT_OBJECT_ID_RE.test(left) ? left : null);
  const rightOid =
    rightModern?.[1] ?? (GIT_OBJECT_ID_RE.test(right) ? right : null);
  return leftOid !== null && leftOid === rightOid;
}

function sourceSnapshotPathBatches(
  repoDir: string,
  paths: string[],
): string[][] | null {
  // CreateProcess accepts at most 32,767 UTF-16 command-line code units.
  // Reserve ample room for the executable, `-C <repo> add -f -A --`, quoting,
  // and Bun/Node launcher behavior. The 256-path cap also bounds POSIX argv.
  const maxEstimatedUnits = 20_000;
  const maxPaths = 256;
  const baseUnits = 512 + repoDir.length * 2;
  const batches: string[][] = [];
  let batch: string[] = [];
  let units = baseUnits;
  for (const path of paths) {
    // Windows quoting can double backslashes before a quote. Doubling every
    // code unit is deliberately conservative and keeps one path independently
    // bounded before it reaches spawnSync.
    const pathUnits = path.length * 2 + 4;
    if (baseUnits + pathUnits > maxEstimatedUnits) return null;
    if (
      batch.length > 0 &&
      (batch.length >= maxPaths || units + pathUnits > maxEstimatedUnits)
    ) {
      batches.push(batch);
      batch = [];
      units = baseUnits;
    }
    batch.push(path);
    units += pathUnits;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

// Shape a caller-owned temporary index to the same source boundary used by the
// fingerprint. The caller seeds and overlays the index first; this helper then
// restores framework/dependency/cache/generated paths to HEAD and force-adds
// ignored source candidates plus every explicitly registered path (including
// binary source). Swarm uses the same helper before writing its immutable
// Source Commit.
export interface SourceSnapshotIndexShape {
  externalSymlinkPaths: string[];
  includedRegularPaths: Set<string>;
}

export function shapeSourceSnapshotIndex(
  repoDir: string,
  indexFile: string,
  carriesWorkspaceShell: boolean,
): SourceSnapshotIndexShape | null {
  const hasWorktreeContext = existsSync(
    join(repoDir, ".aidlc", "worktree-meta.json"),
  );
  const worktreeContext = hasWorktreeContext
    ? worktreeSourceExclusionContext(repoDir)
    : null;
  if (hasWorktreeContext && worktreeContext === null) return null;
  const effectiveCarriesWorkspaceShell =
    worktreeContext?.carriesWorkspaceShell ?? carriesWorkspaceShell;
  const sourceIdentity = filesystemSourceIdentity(
    repoDir,
    effectiveCarriesWorkspaceShell,
  );
  if (sourceIdentity === null) return null;
  const harnessShellDirs = new Set(sourceIdentity.harnessShellDirs);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const staticExcluded = [
    ...sourceGitExclusionPathspecs(
      effectiveCarriesWorkspaceShell,
      repoDir,
    ),
    ...[...harnessShellDirs].sort().map((path) => `${path}/`),
    ...SOURCE_FINGERPRINT_HARD_EXCLUDED_GLOBS,
    ...SOURCE_FINGERPRINT_CONDITIONAL_GLOBS,
  ];
  if (staticExcluded.length > 0) {
    const restored = spawnSync(
      "git",
      [
        "-C",
        repoDir,
        "reset",
        "-q",
        "HEAD",
        "--",
        ...staticExcluded,
      ],
      { env, encoding: "utf-8" },
    );
    if (restored.status !== 0) return null;
  }
  const symlinkBatches = sourceSnapshotPathBatches(
    repoDir,
    sourceIdentity.excludedSymlinkPathspecs,
  );
  if (symlinkBatches === null) return null;
  for (const batch of symlinkBatches) {
    const restored = spawnSync(
      "git",
      ["-C", repoDir, "reset", "-q", "HEAD", "--", ...batch],
      { env, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (restored.status !== 0) return null;
  }

  const forcePaths = new Set(sourceIdentity.snapshotPaths);
  for (const path of sourceIdentity.registeredSnapshotPaths) {
    if (existsSync(join(repoDir, path))) {
      forcePaths.add(path);
      continue;
    }
    const tracked = spawnSync(
      "git",
      ["-C", repoDir, "ls-tree", "-r", "-z", "--name-only", "HEAD", "--", path],
      { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (tracked.status !== 0) return null;
    if (tracked.stdout.length > 0) forcePaths.add(path);
  }
  const sortedForcePaths = [...forcePaths].sort();
  const forceBatches = sourceSnapshotPathBatches(repoDir, sortedForcePaths);
  if (forceBatches === null) return null;
  for (const batch of forceBatches) {
    const restored = spawnSync(
      "git",
      [
        "-C",
        repoDir,
        "add",
        "-f",
        "-A",
        "--",
        ...batch,
      ],
      { env, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (restored.status !== 0) return null;
  }
  return {
    externalSymlinkPaths: sourceIdentity.externalSymlinkPaths,
    includedRegularPaths: new Set(sourceIdentity.includedRegularPaths),
  };
}

// Recorded in place of a fingerprint when one cannot be computed, so a receipt
// written against an unbindable workspace stays distinguishable from a
// pre-#629 receipt that carries no field at all (#646 review).
export const UNBINDABLE_FINGERPRINT = "unbindable";

function sourceIdentityBudget(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw && /^[1-9][0-9]*$/.test(raw)) return Number(raw);
  return fallback;
}

function isSourceHarnessShellDir(root: string, name: string): boolean {
  if (!isHarnessDirName(name)) return false;
  try {
    const manifestPath = join(root, name, "tools", "data", "harness.json");
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.size > 64 * 1024) return false;
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      name?: unknown;
    };
    return typeof parsed.name === "string" && parsed.name.trim().length > 0;
  } catch {
    return false;
  }
}

function sourceHarnessShellDirs(root: string): Set<string> | null {
  const dirs = new Set<string>();
  const maxEntries = sourceIdentityBudget(
    "AIDLC_TEST_SOURCE_MAX_ENTRIES",
    250_000,
  );
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(root);
    let entriesSeen = 0;
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      entriesSeen += 1;
      if (entriesSeen > maxEntries) return null;
      if (
        (entry.isDirectory() || entry.isSymbolicLink()) &&
        isSourceHarnessShellDir(root, entry.name)
      ) {
        dirs.add(entry.name);
      }
    }
    return dirs;
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        handle.closeSync();
      } catch {
        // The bounded scan already fails closed on earlier read errors.
      }
    }
  }
}

function sourceFingerprintRegistryPaths(
  root: string,
  carriesWorkspaceShell: boolean,
  suppliedHarnessShellDirs?: ReadonlySet<string>,
): Set<string> | null {
  const harnessShellDirs = suppliedHarnessShellDirs ??
    (
      carriesWorkspaceShell
        ? sourceHarnessShellDirs(root)
        : new Set<string>()
    );
  if (harnessShellDirs === null) return null;
  const registryPath = join(root, SOURCE_FINGERPRINT_REGISTRY);
  let registryLinkStat: ReturnType<typeof lstatSync>;
  try {
    registryLinkStat = lstatSync(registryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    return null;
  }
  try {
    if (
      registryLinkStat.isSymbolicLink() ||
      !registryLinkStat.isFile() ||
      registryLinkStat.size > 1024 * 1024
    ) return null;
    const parsed = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      version?: unknown;
      paths?: unknown;
    };
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.paths) ||
      parsed.paths.length > 10_000 ||
      parsed.paths.some((path) => typeof path !== "string")
    ) {
      return null;
    }
    const paths = new Set<string>();
    for (const raw of parsed.paths) {
      const path = String(raw)
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, "");
      if (
        path.length === 0 ||
        path.length > 4096 ||
        path === "." ||
        path.includes("\0") ||
        isAbsolute(path) ||
        /^[A-Za-z]:\//.test(path) ||
        path.startsWith("//") ||
        path
          .split("/")
          .some((part) => part.length === 0 || part === "." || part === "..")
      ) {
        return null;
      }
      const parts = path.split("/");
      if (
        (
          carriesWorkspaceShell &&
          (
            parts[0] === "aidlc" ||
            parts[0] === ".aidlc" ||
            (KNOWN_HARNESS_DIRS as readonly string[]).includes(parts[0]) ||
            harnessShellDirs.has(parts[0])
          )
        ) ||
        parts.some((part) => SOURCE_FINGERPRINT_HARD_EXCLUDED_DIRS.has(part)) ||
        isAidlcSensorCachePath(path)
      ) {
        return null;
      }
      paths.add(path);
    }
    return paths;
  } catch {
    return null;
  }
}

function sourcePathPhysicallyExcluded(
  path: string,
  carriesWorkspaceShell: boolean,
  harnessShellDirs: ReadonlySet<string>,
): boolean {
  const parts = path.split("/");
  return (
    (
      carriesWorkspaceShell &&
      (
        parts[0] === "aidlc" ||
        parts[0] === ".aidlc" ||
        (KNOWN_HARNESS_DIRS as readonly string[]).includes(parts[0]) ||
        harnessShellDirs.has(parts[0])
      )
    ) ||
    parts.some((part) => SOURCE_FINGERPRINT_HARD_EXCLUDED_DIRS.has(part)) ||
    isAidlcSensorCachePath(path)
  );
}

function pathIsWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel === "" ||
    (
      !isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${sep}`)
    )
  );
}

interface SourceSymlinkResolution {
  externalHop: boolean;
  target: string | null;
}

function resolveSourceSymlinkTarget(
  rootReal: string,
  linkPath: string,
  stopOnExternalHop = false,
): SourceSymlinkResolution | null {
  let current = linkPath;
  let externalHop = false;
  const visited = new Set<string>();
  for (let hop = 0; hop < 40; hop++) {
    const key = resolvePath(current);
    if (visited.has(key)) return null;
    visited.add(key);

    let currentDir: string;
    try {
      currentDir = realpathSync(dirname(current));
    } catch {
      return null;
    }
    if (!pathIsWithinRoot(rootReal, currentDir)) {
      externalHop = true;
      if (stopOnExternalHop) return { externalHop, target: null };
    }
    let linkText: string;
    try {
      linkText = readlinkSync(current);
    } catch {
      return null;
    }
    const next = isAbsolute(linkText)
      ? resolvePath(linkText)
      : resolvePath(currentDir, linkText);
    if (!pathIsWithinRoot(rootReal, next)) {
      externalHop = true;
      if (stopOnExternalHop) return { externalHop, target: null };
    }

    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(next);
    } catch {
      return { externalHop, target: null };
    }
    if (stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    let target: string;
    try {
      target = realpathSync(next);
    } catch {
      return { externalHop, target: null };
    }
    if (!pathIsWithinRoot(rootReal, target)) externalHop = true;
    return { externalHop, target };
  }
  return null;
}

interface RegisteredPhysicalSourceResolution {
  externalHop: boolean;
  path: string | null;
}

function registeredPhysicalSourcePath(
  rootReal: string,
  logicalPath: string,
  stopOnExternalHop: boolean,
): RegisteredPhysicalSourceResolution | null {
  const parts = logicalPath.split("/");
  let current = rootReal;
  let externalHop = false;
  for (let index = 0; index < parts.length; index++) {
    const candidate = join(current, parts[index]);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      const unresolved = join(current, ...parts.slice(index));
      return {
        externalHop:
          externalHop || !pathIsWithinRoot(rootReal, unresolved),
        path: unresolved,
      };
    }
    if (stat.isSymbolicLink()) {
      const resolution = resolveSourceSymlinkTarget(
        rootReal,
        candidate,
        stopOnExternalHop,
      );
      if (resolution === null) return null;
      externalHop = externalHop || resolution.externalHop;
      if (resolution.target === null) {
        return { externalHop, path: null };
      }
      current = resolution.target;
    } else {
      current = candidate;
    }
    if (!pathIsWithinRoot(rootReal, current)) externalHop = true;
  }
  return { externalHop, path: current };
}

function isAidlcSensorCachePath(path: string): boolean {
  const parts = path.split("/");
  for (let i = 0; i + 4 < parts.length; i++) {
    if (
      parts[i] === "aidlc" &&
      parts[i + 1] === "spaces" &&
      parts[i + 3] === "intents" &&
      parts.slice(i + 4).includes(".aidlc-sensors")
    ) {
      return true;
    }
  }
  return false;
}

function stableFileSha256(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    if (!before.isFile()) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    const after = fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      position !== after.size
    ) {
      return null;
    }
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The fingerprint already fails closed on any earlier read error.
      }
    }
  }
}

interface FilesystemSourceIdentity {
  embeddedGitPaths: string[];
  excludedSymlinkPathspecs: string[];
  externalSymlinkPaths: string[];
  fingerprint: string;
  harnessShellDirs: string[];
  includedRegularPaths: string[];
  listing: WorkspaceSourceListing;
  registeredSnapshotPaths: string[];
  snapshotPaths: string[];
}

type SourceSymlinkTargetMode = "follow" | "tree-only";

function boundedGitMetadataText(path: string, maxBytes: number): string | null {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (!pathStat.isFile() || pathStat.size > maxBytes) return null;
    fd = openSync(path, "r");
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) return null;
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (count === 0) return null;
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      return null;
    }
    return bytes.toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The metadata read already fails closed on any earlier error.
      }
    }
  }
}

function singleGitMetadataLine(raw: string): string | null {
  const line = raw.replace(/\r?\n$/, "");
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) {
    return null;
  }
  return line;
}

function gitMetadataDirectory(worktreeDir: string): string | null {
  const marker = join(worktreeDir, ".git");
  try {
    const markerStat = lstatSync(marker);
    if (markerStat.isDirectory()) return realpathSync(marker);
    if (!markerStat.isFile()) return null;
  } catch {
    return null;
  }
  const pointerRaw = boundedGitMetadataText(marker, 8192);
  const pointerLine =
    pointerRaw === null ? null : singleGitMetadataLine(pointerRaw);
  if (pointerLine === null || !pointerLine.startsWith("gitdir: ")) {
    return null;
  }
  const pointer = pointerLine.slice("gitdir: ".length);
  if (pointer.length === 0 || pointer.includes("\0")) return null;
  const target = isAbsolute(pointer)
    ? pointer
    : resolvePath(worktreeDir, pointer);
  try {
    if (!lstatSync(target).isDirectory()) return null;
    return realpathSync(target);
  } catch {
    return null;
  }
}

function gitCommonDirectory(gitDir: string): string | null {
  const marker = join(gitDir, "commondir");
  try {
    if (!lstatSync(marker).isFile()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return gitDir;
    return null;
  }
  const pointerRaw = boundedGitMetadataText(marker, 8192);
  const pointerLine =
    pointerRaw === null ? null : singleGitMetadataLine(pointerRaw);
  if (
    pointerLine === null ||
    pointerLine.length === 0 ||
    pointerLine.includes("\0")
  ) {
    return null;
  }
  const target = isAbsolute(pointerLine)
    ? pointerLine
    : resolvePath(gitDir, pointerLine);
  try {
    if (!lstatSync(target).isDirectory()) return null;
    return realpathSync(target);
  } catch {
    return null;
  }
}

type GitObjectType = "commit" | "other";

function gitObjectDirectories(
  _gitDir: string,
  commonDir: string,
): string[] | null {
  const queue = [join(commonDir, "objects")];
  const directories: string[] = [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    if (directories.length >= 64) return null;
    const candidate = queue.shift()!;
    let objectDir: string;
    try {
      if (!lstatSync(candidate).isDirectory()) return null;
      objectDir = realpathSync(candidate);
    } catch {
      return null;
    }
    if (seen.has(objectDir)) continue;
    seen.add(objectDir);
    directories.push(objectDir);

    const alternatesPath = join(objectDir, "info", "alternates");
    try {
      const alternatesStat = lstatSync(alternatesPath);
      if (!alternatesStat.isFile()) return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    const alternates = boundedGitMetadataText(
      alternatesPath,
      1024 * 1024,
    );
    if (alternates === null) return null;
    const lines = alternates.split(/\r?\n/).filter(Boolean);
    if (lines.length > 64) return null;
    for (const line of lines) {
      if (
        line.length > 4096 ||
        line.includes("\0") ||
        line.startsWith("#")
      ) {
        return null;
      }
      queue.push(
        isAbsolute(line) ? resolvePath(line) : resolvePath(objectDir, line),
      );
    }
  }
  return directories;
}

function looseGitObjectType(
  objectDir: string,
  oid: string,
): GitObjectType | null {
  const path = join(objectDir, oid.slice(0, 2), oid.slice(2));
  let compressed: Buffer;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return null;
    compressed = readFileSync(path);
  } catch {
    return null;
  }
  let inflated: Buffer;
  try {
    inflated = inflateSync(compressed, {
      maxOutputLength: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  const separator = inflated.indexOf(0);
  if (separator <= 0 || separator > 128) return null;
  const header = inflated.subarray(0, separator).toString("ascii");
  const match = /^(commit|tree|blob|tag) ([0-9]+)$/.exec(header);
  if (match === null) return null;
  const declaredSize = Number(match[2]);
  if (
    !Number.isSafeInteger(declaredSize) ||
    declaredSize !== inflated.length - separator - 1
  ) {
    return null;
  }
  return match[1] === "commit" ? "commit" : "other";
}

interface PackedGitObjectLocation {
  offset: number;
  packPath: string;
}

function packedGitObjectLocation(
  objectDir: string,
  oid: string,
): PackedGitObjectLocation | null {
  const packDir = join(objectDir, "pack");
  let indexes: string[];
  try {
    indexes = readdirSync(packDir)
      .filter((name) => /^pack-[0-9a-f]+\.idx$/.test(name))
      .sort();
  } catch {
    return null;
  }
  if (indexes.length > 256) return null;
  const oidBytes = Buffer.from(oid, "hex");
  let totalIndexBytes = 0;
  for (const indexName of indexes) {
    const indexPath = join(packDir, indexName);
    let index: Buffer;
    try {
      const stat = lstatSync(indexPath);
      if (!stat.isFile() || stat.size > 128 * 1024 * 1024) return null;
      totalIndexBytes += stat.size;
      if (totalIndexBytes > 256 * 1024 * 1024) return null;
      index = readFileSync(indexPath);
    } catch {
      return null;
    }
    if (index.length < 1024) {
      return null;
    }
    const versionTwo = index.readUInt32BE(0) === 0xff744f63;
    if (!versionTwo) {
      const count = index.readUInt32BE(255 * 4);
      const table = 256 * 4;
      const entrySize = 4 + oidBytes.length;
      if (
        table + count * entrySize + oidBytes.length * 2 > index.length
      ) {
        return null;
      }
      let low = 0;
      let high = count;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const start = table + mid * entrySize + 4;
        const comparison = Buffer.compare(
          index.subarray(start, start + oidBytes.length),
          oidBytes,
        );
        if (comparison < 0) low = mid + 1;
        else high = mid;
      }
      if (low >= count) continue;
      const entry = table + low * entrySize;
      if (
        !index
          .subarray(entry + 4, entry + 4 + oidBytes.length)
          .equals(oidBytes)
      ) {
        continue;
      }
      const packPath = join(
        packDir,
        `${indexName.slice(0, -".idx".length)}.pack`,
      );
      try {
        if (!lstatSync(packPath).isFile()) return null;
      } catch {
        return null;
      }
      return { offset: index.readUInt32BE(entry), packPath };
    }
    if (index.length < 1032 || index.readUInt32BE(4) !== 2) return null;
    const count = index.readUInt32BE(8 + 255 * 4);
    const oidTable = 8 + 256 * 4;
    const crcTable = oidTable + count * oidBytes.length;
    const offsetTable = crcTable + count * 4;
    if (
      !Number.isSafeInteger(offsetTable) ||
      offsetTable + count * 4 > index.length
    ) {
      return null;
    }
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const start = oidTable + mid * oidBytes.length;
      const comparison = Buffer.compare(
        index.subarray(start, start + oidBytes.length),
        oidBytes,
      );
      if (comparison < 0) low = mid + 1;
      else high = mid;
    }
    if (low >= count) continue;
    const foundStart = oidTable + low * oidBytes.length;
    if (
      !index
        .subarray(foundStart, foundStart + oidBytes.length)
        .equals(oidBytes)
    ) {
      continue;
    }
    const rawOffset = index.readUInt32BE(offsetTable + low * 4);
    let offset: number;
    if ((rawOffset & 0x80000000) === 0) {
      offset = rawOffset;
    } else {
      const largeOffset =
        offsetTable + count * 4 + (rawOffset & 0x7fffffff) * 8;
      if (largeOffset + 8 > index.length) return null;
      const value = index.readBigUInt64BE(largeOffset);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      offset = Number(value);
    }
    const packPath = join(
      packDir,
      `${indexName.slice(0, -".idx".length)}.pack`,
    );
    try {
      if (!lstatSync(packPath).isFile()) return null;
    } catch {
      return null;
    }
    return { offset, packPath };
  }
  return null;
}

function packedGitObjectType(
  location: PackedGitObjectLocation,
  objectDirs: readonly string[],
  oidLength: number,
  seen: Set<string>,
  depth: number,
): GitObjectType | null {
  if (depth > 64) return null;
  const visitKey = `${location.packPath}\0${location.offset}`;
  if (seen.has(visitKey)) return null;
  seen.add(visitKey);

  let fd: number | undefined;
  try {
    fd = openSync(location.packPath, "r");
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      location.offset < 12 ||
      location.offset >= stat.size
    ) {
      return null;
    }
    const packHeader = Buffer.alloc(12);
    if (readSync(fd, packHeader, 0, 12, 0) !== 12) return null;
    if (
      packHeader.subarray(0, 4).toString("ascii") !== "PACK" ||
      ![2, 3].includes(packHeader.readUInt32BE(4))
    ) {
      return null;
    }
    const available = Math.min(96, stat.size - location.offset);
    const header = Buffer.alloc(available);
    if (
      readSync(
        fd,
        header,
        0,
        available,
        location.offset,
      ) !== available
    ) {
      return null;
    }
    let cursor = 0;
    let byte = header[cursor++];
    const packedType = (byte >> 4) & 0x07;
    while ((byte & 0x80) !== 0) {
      if (cursor >= header.length) return null;
      byte = header[cursor++];
    }
    if (packedType === 1) return "commit";
    if ([2, 3, 4].includes(packedType)) return "other";
    if (packedType === 6) {
      if (cursor >= header.length) return null;
      let offsetByte = header[cursor++];
      let distance = offsetByte & 0x7f;
      while ((offsetByte & 0x80) !== 0) {
        if (cursor >= header.length) return null;
        offsetByte = header[cursor++];
        distance = ((distance + 1) * 128) + (offsetByte & 0x7f);
        if (!Number.isSafeInteger(distance)) return null;
      }
      const baseOffset = location.offset - distance;
      if (baseOffset < 12) return null;
      return packedGitObjectType(
        { offset: baseOffset, packPath: location.packPath },
        objectDirs,
        oidLength,
        seen,
        depth + 1,
      );
    }
    if (packedType === 7) {
      if (cursor + oidLength > header.length) return null;
      const baseOid = header
        .subarray(cursor, cursor + oidLength)
        .toString("hex");
      return gitObjectTypeByOid(
        objectDirs,
        baseOid,
        seen,
        depth + 1,
      );
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The object proof already fails closed on any earlier read error.
      }
    }
  }
}

function gitObjectTypeByOid(
  objectDirs: readonly string[],
  oid: string,
  seen: Set<string>,
  depth = 0,
): GitObjectType | null {
  if (depth > 64 || !GIT_OBJECT_ID_RE.test(oid)) return null;
  const oidKey = `oid\0${oid}`;
  if (seen.has(oidKey)) return null;
  seen.add(oidKey);
  for (const objectDir of objectDirs) {
    const loosePath = join(objectDir, oid.slice(0, 2), oid.slice(2));
    if (existsSync(loosePath)) {
      return looseGitObjectType(objectDir, oid);
    }
  }
  for (const objectDir of objectDirs) {
    const packed = packedGitObjectLocation(objectDir, oid);
    if (packed === null) continue;
    return packedGitObjectType(
      packed,
      objectDirs,
      oid.length / 2,
      seen,
      depth + 1,
    );
  }
  return null;
}

function validGitRefName(ref: string): boolean {
  const forbiddenCharacter = [...ref].some((character) => {
    const code = character.charCodeAt(0);
    return (
      code <= 0x20 ||
      code === 0x7f ||
      "~^:?*[\\]".includes(character)
    );
  });
  if (
    !ref.startsWith("refs/") ||
    ref.endsWith("/") ||
    ref.includes("//") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    forbiddenCharacter
  ) {
    return false;
  }
  return ref
    .split("/")
    .every((part) =>
      part.length > 0 &&
      part !== "." &&
      part !== ".." &&
      !part.startsWith(".") &&
      !part.endsWith(".") &&
      !part.endsWith(".lock")
    );
}

function gitRepositoryObjectIdLength(commonDir: string): 40 | 64 | null {
  const raw = boundedGitMetadataText(join(commonDir, "config"), 1024 * 1024);
  if (raw === null) return null;
  let section = "";
  let hasSubsection = false;
  let repositoryFormatVersion = 0;
  let repositoryFormatVersionSet = false;
  let objectFormat: 40 | 64 = 40;
  let explicitlySet = false;
  let sawExtension = false;
  const supportedExtensions = new Set([
    "compatobjectformat",
    "noop",
    "objectformat",
    "partialclone",
    "preciousobjects",
    "relativeworktrees",
    "refstorage",
    "worktreeconfig",
  ]);
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    const sectionMatch =
      /^\[\s*([A-Za-z0-9.-]+)(?:\s+"(?:[^"\\]|\\.)*")?\s*\]$/.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1].toLowerCase();
      hasSubsection = /\s+"/.test(line);
      continue;
    }
    if (hasSubsection || (section !== "core" && section !== "extensions")) {
      continue;
    }
    const keyValue = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (keyValue === null) return null;
    const key = keyValue[1].toLowerCase();
    const value = keyValue[2].replace(/^"(.*)"$/, "$1").toLowerCase();
    if (section === "core") {
      if (key !== "repositoryformatversion") continue;
      if (!/^[0-9]+$/.test(value)) return null;
      const parsed = Number(value);
      if (
        !Number.isSafeInteger(parsed) ||
        ![0, 1].includes(parsed) ||
        (repositoryFormatVersionSet && parsed !== repositoryFormatVersion)
      ) {
        return null;
      }
      repositoryFormatVersion = parsed;
      repositoryFormatVersionSet = true;
      continue;
    }
    sawExtension = true;
    if (!supportedExtensions.has(key)) return null;
    if (key === "refstorage" && value !== "files") return null;
    if (key !== "objectformat") continue;
    const parsed = value === "sha1" ? 40 : value === "sha256" ? 64 : null;
    if (parsed === null || (explicitlySet && parsed !== objectFormat)) {
      return null;
    }
    objectFormat = parsed;
    explicitlySet = true;
  }
  if (sawExtension && repositoryFormatVersion !== 1) return null;
  if (objectFormat === 64 && repositoryFormatVersion !== 1) return null;
  return objectFormat;
}

function gitOidFromRef(
  gitDir: string,
  commonDir: string,
  ref: string,
  seen: Set<string>,
  depth: number,
): string | null {
  if (depth > 8 || !validGitRefName(ref) || seen.has(ref)) return null;
  seen.add(ref);
  const looseCandidates = [...new Set([
    ...(
      ref.startsWith("refs/bisect/") ||
        ref.startsWith("refs/worktree/") ||
        ref.startsWith("refs/rewritten/")
        ? [join(gitDir, ...ref.split("/"))]
        : [join(commonDir, ...ref.split("/"))]
    ),
  ])];
  for (const candidate of looseCandidates) {
    if (!existsSync(candidate)) continue;
    const raw = boundedGitMetadataText(candidate, 8192);
    const line = raw === null ? null : singleGitMetadataLine(raw);
    if (line === null) return null;
    const oid = normalizeGitObjectId(line);
    if (oid !== null) return oid;
    if (!line.startsWith("ref: ")) return null;
    return gitOidFromRef(
      gitDir,
      commonDir,
      line.slice("ref: ".length),
      seen,
      depth + 1,
    );
  }

  const packedPath = join(commonDir, "packed-refs");
  if (!existsSync(packedPath)) return null;
  const packed = boundedGitMetadataText(packedPath, 16 * 1024 * 1024);
  if (packed === null) return null;
  for (const line of packed.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#") || line.startsWith("^")) {
      continue;
    }
    const separator = line.indexOf(" ");
    if (separator === -1 || line.slice(separator + 1) !== ref) continue;
    const oid = line.slice(0, separator);
    return normalizeGitObjectId(oid);
  }
  return null;
}

function gitHeadOid(worktreeDir: string): string | null {
  const gitDir = gitMetadataDirectory(worktreeDir);
  if (gitDir === null) return null;
  const commonDir = gitCommonDirectory(gitDir);
  if (commonDir === null) return null;
  const objectIdLength = gitRepositoryObjectIdLength(commonDir);
  if (objectIdLength === null) return null;
  const raw = boundedGitMetadataText(join(gitDir, "HEAD"), 8192);
  const line = raw === null ? null : singleGitMetadataLine(raw);
  if (line === null) return null;
  const detached = normalizeGitObjectId(line);
  const oid = detached ?? (
    line.startsWith("ref: ")
      ? gitOidFromRef(
          gitDir,
          commonDir,
          line.slice("ref: ".length),
          new Set(),
          0,
        )
      : null
  );
  if (oid === null || oid.length !== objectIdLength) return null;
  const objectDirs = gitObjectDirectories(gitDir, commonDir);
  if (objectDirs === null) return null;
  return gitObjectTypeByOid(objectDirs, oid, new Set()) === "commit"
    ? oid
    : null;
}

function filesystemSourceIdentity(
  root: string,
  carriesWorkspaceShell: boolean,
  excludedTopLevel: ReadonlySet<string> = new Set(),
  symlinkTargetMode: SourceSymlinkTargetMode = "follow",
  useWorktreeContext = true,
): FilesystemSourceIdentity | null {
  const maxEntries = sourceIdentityBudget(
    "AIDLC_TEST_SOURCE_MAX_ENTRIES",
    250_000,
  );
  const maxDirectories = sourceIdentityBudget(
    "AIDLC_TEST_SOURCE_MAX_DIRECTORIES",
    100_000,
  );
  const maxSymlinks = sourceIdentityBudget(
    "AIDLC_TEST_SOURCE_MAX_SYMLINKS",
    100_000,
  );
  const maxFiles = 250_000;
  const maxBytes = 4 * 1024 * 1024 * 1024;
  const sourceOnlyMaxFiles = 10_000;
  const sourceOnlyMaxBytes = 64 * 1024 * 1024;
  const sourceExtension =
    /\.(?:astro|c|cc|cmake|cpp|cs|css|dart|erl|ex|exs|go|gql|graphql|h|hcl|hpp|hrl|html|java|js|jsx|json|kt|kts|lua|m|mm|php|proto|ps1|psd1|psm1|py|r|rb|rs|scala|sh|sol|sql|svelte|swift|tf|tfvars|toml|ts|tsx|vue|xml|ya?ml|zig)$/i;
  const sourceBasename =
    /^(?:BUILD|CMakeLists\.txt|Dockerfile(?:\..+)?|Gemfile|Justfile|Makefile|Procfile|Tiltfile|WORKSPACE)$/i;
  const lines: string[] = [];
  const embeddedGitPaths = new Set<string>();
  const excludedSymlinkPathspecs = new Set<string>();
  const externalSymlinkPaths = new Set<string>();
  const includedRegularPaths = new Set<string>();
  const listing: WorkspaceSourceListing = new Map();
  const registeredSnapshotPaths = new Set<string>();
  const snapshotPaths = new Set<string>();
  const visited = new Map<string, boolean>();
  const active = new Set<string>();
  let entriesSeen = 0;
  let directoriesSeen = 0;
  let symlinksSeen = 0;
  let totalFiles = 0;
  let totalBytes = 0;
  let sourceOnlyFiles = 0;
  let sourceOnlyBytes = 0;
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return null;
  }
  const hasWorktreeContext =
    useWorktreeContext &&
    existsSync(join(rootReal, ".aidlc", "worktree-meta.json"));
  const worktreeContext = hasWorktreeContext
    ? worktreeSourceExclusionContext(rootReal)
    : null;
  if (hasWorktreeContext && worktreeContext === null) {
    return null;
  }
  const harnessShellDirs = carriesWorkspaceShell
    ? sourceHarnessShellDirs(rootReal)
    : new Set<string>();
  if (harnessShellDirs === null) return null;
  const exactExcludedPaths =
    worktreeContext !== null && !worktreeContext.carriesWorkspaceShell
      ? worktreeContext.exactPaths
      : [];
  const exactPathExcluded = (path: string): boolean => {
    const normalizedPath = path.replace(/\/+$/, "");
    return exactExcludedPaths.some((excluded) => {
      const normalizedExcluded = excluded.replace(/\/+$/, "");
      return normalizedPath === normalizedExcluded ||
        (
          excluded.endsWith("/") &&
          normalizedPath.startsWith(`${normalizedExcluded}/`)
        );
    });
  };
  const registeredSources = sourceFingerprintRegistryPaths(
    rootReal,
    carriesWorkspaceShell,
    harnessShellDirs,
  );
  if (registeredSources === null) return null;
  const effectiveRegisteredSources = new Set(registeredSources);
  for (const logicalPath of registeredSources) {
    if (exactPathExcluded(logicalPath)) return null;
    const physical = registeredPhysicalSourcePath(
      rootReal,
      logicalPath,
      symlinkTargetMode === "tree-only",
    );
    if (physical === null) return null;
    if (
      physical.externalHop &&
      symlinkTargetMode === "tree-only"
    ) {
      continue;
    }
    if (physical.path === null) return null;
    const physicalPath = physical.path;
    const physicalInside = pathIsWithinRoot(rootReal, physicalPath);
    if (physical.externalHop && physicalInside) return null;
    if (!physicalInside) continue;
    const physicalRel = relative(rootReal, physicalPath);
    if (physicalRel !== "") {
      const physicalPosix = physicalRel.split(sep).join("/");
      if (
        sourcePathPhysicallyExcluded(
          physicalPosix,
          carriesWorkspaceShell,
          harnessShellDirs,
        )
      ) {
        return null;
      }
      registeredSnapshotPaths.add(physicalPosix);
      effectiveRegisteredSources.add(physicalPosix);
    }
  }
  const registeredList = [...effectiveRegisteredSources].sort();
  const registeredPathIncludes = (rel: string): boolean => {
    if (effectiveRegisteredSources.has(rel)) return true;
    let slash = rel.lastIndexOf("/");
    while (slash !== -1) {
      if (effectiveRegisteredSources.has(rel.slice(0, slash))) return true;
      slash = rel.lastIndexOf("/", slash - 1);
    }
    return false;
  };
  const registeredDescendantExists = (rel: string): boolean => {
    const prefix = `${rel}/`;
    let low = 0;
    let high = registeredList.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (registeredList[mid] < prefix) low = mid + 1;
      else high = mid;
    }
    return registeredList[low]?.startsWith(prefix) ?? false;
  };
  const registeredPathRelevant = (rel: string): boolean =>
    registeredPathIncludes(rel) || registeredDescendantExists(rel);
  const textLike = (path: string, size: number): boolean => {
    if (size === 0) return true;
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const sample = Buffer.alloc(Math.min(size, 8192));
      const count = readSync(fd, sample, 0, sample.byteLength, 0);
      return !sample.subarray(0, count).includes(0);
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The later full read remains fail-closed.
        }
      }
    }
  };
  const hasShebang = (path: string, size: number): boolean => {
    if (size < 2) return false;
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const sample = Buffer.alloc(2);
      return readSync(fd, sample, 0, 2, 0) === 2 &&
        sample[0] === 0x23 &&
        sample[1] === 0x21;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // The later full read remains fail-closed.
        }
      }
    }
  };
  const snapshotCandidate = (
    path: string,
    rel: string,
    name: string,
    size: number,
  ): boolean =>
    registeredPathIncludes(rel) ||
    sourceExtension.test(name) ||
    sourceBasename.test(name) ||
    hasShebang(path, size);
  const recordFile = (
    path: string,
    rel: string,
    size: number,
    executable: boolean,
    sourceOnly: boolean,
    listingPath = rel,
  ): boolean => {
    totalFiles += 1;
    totalBytes += size;
    if (totalFiles > maxFiles || totalBytes > maxBytes) return false;
    if (sourceOnly) {
      sourceOnlyFiles += 1;
      sourceOnlyBytes += size;
      if (
        sourceOnlyFiles > sourceOnlyMaxFiles ||
        sourceOnlyBytes > sourceOnlyMaxBytes
      ) {
        return false;
      }
    }
    const sha = stableFileSha256(path);
    if (sha === null) return false;
    lines.push(`file:${rel}:${executable ? "x" : "-"}=${sha}`);
    const entry = sourceListingEntry(executable ? "100755" : "100644", sha);
    if (entry === null) return false;
    listing.set(listingPath, entry);
    return true;
  };
  const walk = (
    dir: string,
    rel = "",
    sourceOnly = false,
    registeredOnly = false,
    snapshotEligible = true,
    registryRel = rel,
    snapshotRel = rel,
    listingRel = rel,
  ): boolean => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return false;
    }
    if (active.has(real)) return true;
    const identityMode = registeredOnly
      ? `registered:${registryRel}`
      : sourceOnly
        ? "source-only"
        : "full";
    const visitKey = `${real}\0${identityMode}`;
    const priorSnapshotEligibility = visited.get(visitKey);
    if (
      priorSnapshotEligibility === true ||
      (priorSnapshotEligibility === false && !snapshotEligible)
    ) {
      return true;
    }
    const recordIdentity = priorSnapshotEligibility === undefined;
    visited.set(
      visitKey,
      (priorSnapshotEligibility ?? false) || snapshotEligible,
    );
    active.add(real);
    try {
      directoriesSeen += 1;
      if (directoriesSeen > maxDirectories) return false;
      const entries: import("node:fs").Dirent[] = [];
      let handle: ReturnType<typeof opendirSync> | undefined;
      try {
        handle = opendirSync(dir);
        while (true) {
          const entry = handle.readSync();
          if (entry === null) break;
          entriesSeen += 1;
          if (entriesSeen > maxEntries) return false;
          entries.push(entry);
        }
      } catch {
        return false;
      } finally {
        if (handle !== undefined) {
          try {
            handle.closeSync();
          } catch {
            // The read path already fails closed.
          }
        }
      }
      entries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      );
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const childRegistryRel = registryRel
          ? `${registryRel}/${entry.name}`
          : entry.name;
        const childSnapshotRel = snapshotRel
          ? `${snapshotRel}/${entry.name}`
          : entry.name;
        const childListingRel = listingRel
          ? `${listingRel}/${entry.name}`
          : entry.name;
        if (entry.isSymbolicLink()) {
          symlinksSeen += 1;
          if (symlinksSeen > maxSymlinks) return false;
        }
        if (
          registeredOnly &&
          !registeredPathRelevant(childRegistryRel)
        ) {
          continue;
        }
        if (exactPathExcluded(childRel)) continue;
        if (
          rel === "" &&
          excludedTopLevel.has(entry.name) &&
          !registeredPathRelevant(childRegistryRel)
        ) {
          continue;
        }
        if (entry.name === ".git") {
          if (entry.isSymbolicLink()) {
            excludedSymlinkPathspecs.add(`:(top,literal)${childSnapshotRel}`);
          }
          continue;
        }
        if (
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          SOURCE_FINGERPRINT_HARD_EXCLUDED_DIRS.has(entry.name)
        ) {
          if (entry.isSymbolicLink()) {
            excludedSymlinkPathspecs.add(`:(top,literal)${childSnapshotRel}`);
          }
          continue;
        }
        if (
          rel === "" &&
          carriesWorkspaceShell &&
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          (
            entry.name === "aidlc" ||
            entry.name === ".aidlc" ||
            harnessShellDirs.has(entry.name)
          )
        ) {
          if (entry.isSymbolicLink()) {
            excludedSymlinkPathspecs.add(`:(top,literal)${childSnapshotRel}`);
          }
          continue;
        }
        if (
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          isAidlcSensorCachePath(childRel)
        ) {
          if (entry.isSymbolicLink()) {
            excludedSymlinkPathspecs.add(`:(top,literal)${childSnapshotRel}`);
          }
          continue;
        }
        const conditionalBoundary =
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          SOURCE_FINGERPRINT_CONDITIONAL_DIRS.has(entry.name);
        if (
          conditionalBoundary &&
          !registeredPathRelevant(childRegistryRel)
        ) {
          if (entry.isSymbolicLink()) {
            excludedSymlinkPathspecs.add(`:(top,literal)${childSnapshotRel}`);
          }
          continue;
        }
        const childRegisteredOnly =
          registeredOnly || conditionalBoundary;
        const child = join(dir, entry.name);
        let stat: ReturnType<typeof lstatSync>;
        try {
          stat = lstatSync(child);
        } catch {
          return false;
        }
        if (stat.isSymbolicLink()) {
          let linkText: string;
          try {
            linkText = readlinkSync(child);
          } catch {
            return false;
          }
          if (recordIdentity) lines.push(`link:${childRel}=${linkText}`);
          if (recordIdentity) {
            const linkSha = createHash("sha256")
              .update(linkText, "utf-8")
              .digest("hex");
            const linkEntry = sourceListingEntry("120000", linkSha);
            if (linkEntry === null) return false;
            listing.set(childListingRel, linkEntry);
          }
          if (snapshotEligible) snapshotPaths.add(childSnapshotRel);
          if (symlinkTargetMode === "tree-only") continue;
          const resolution = resolveSourceSymlinkTarget(rootReal, child);
          if (resolution === null) return false;
          if (resolution.externalHop) {
            externalSymlinkPaths.add(childSnapshotRel);
          }
          if (resolution.target === null) {
            if (recordIdentity) {
              lines.push(`link-target:${childRel}=missing`);
              const missingEntry = sourceListingEntry(
                "000000",
                createHash("sha256").update("missing").digest("hex"),
              );
              if (missingEntry === null) return false;
              listing.set(`${childListingRel}@target`, missingEntry);
            }
            continue;
          }
          const target = resolution.target;
          const targetRelNative = relative(rootReal, target);
          const internal = pathIsWithinRoot(rootReal, target);
          let targetStat: ReturnType<typeof statSync>;
          try {
            targetStat = statSync(target);
          } catch {
            return false;
          }
          if (targetStat.isFile()) {
            if (
              childRegisteredOnly &&
              !registeredPathIncludes(childRegistryRel)
            ) {
              continue;
            }
            if (
              sourceOnly &&
              !childRegisteredOnly &&
              !sourceExtension.test(entry.name) &&
              !sourceBasename.test(entry.name) &&
              !textLike(target, targetStat.size)
            ) {
              continue;
            }
            const targetListingRel = internal
              ? targetRelNative.split(sep).join("/")
              : `${childListingRel}@target`;
            if (
              recordIdentity &&
              !recordFile(
                target,
                `${childRel}@target`,
                targetStat.size,
                (targetStat.mode & 0o111) !== 0,
                sourceOnly,
                targetListingRel,
              )
            ) {
              return false;
            }
          } else if (targetStat.isDirectory()) {
            const targetSnapshotRel = internal
              ? targetRelNative.split(sep).join("/")
              : childSnapshotRel;
            const targetSnapshotEligible =
              snapshotEligible &&
              internal &&
              !existsSync(join(target, ".git"));
            const targetListingRel = internal
              ? targetSnapshotRel
              : `${childListingRel}@target`;
            if (
              !walk(
                target,
                `${childRel}@target`,
                sourceOnly || !internal,
                childRegisteredOnly,
                targetSnapshotEligible,
                childRegistryRel,
                targetSnapshotRel,
                targetListingRel,
              )
            ) {
              return false;
            }
          } else if (recordIdentity) {
            const special = `special:${targetStat.mode}`;
            lines.push(`link-target:${childRel}=${special}`);
            const specialEntry = sourceListingEntry(
              "000000",
              createHash("sha256").update(special).digest("hex"),
            );
            if (specialEntry === null) return false;
            listing.set(`${childListingRel}@target`, specialEntry);
          }
          continue;
        }
        if (stat.isDirectory()) {
          if (conditionalBoundary) {
            if (
              !walk(
                child,
                childRel,
                false,
                true,
                snapshotEligible,
                childRegistryRel,
                childSnapshotRel,
                childListingRel,
              )
            ) {
              return false;
            }
            continue;
        }
        const nestedGitRepo = existsSync(join(child, ".git"));
        if (nestedGitRepo && snapshotEligible) {
          embeddedGitPaths.add(childSnapshotRel);
          snapshotPaths.add(childSnapshotRel);
          const oid = gitHeadOid(child);
          if (oid === null) return false;
          const gitlinkEntry = sourceListingEntry("160000", oid);
          if (gitlinkEntry === null) return false;
          listing.set(childListingRel, gitlinkEntry);
        }
        if (
          !walk(
              child,
              childRel,
              sourceOnly,
              registeredOnly,
              snapshotEligible && !nestedGitRepo,
              childRegistryRel,
              childSnapshotRel,
              childListingRel,
            )
          ) {
            return false;
          }
          continue;
        }
        if (stat.isFile()) {
          if (
            sourceOnly &&
            !childRegisteredOnly &&
            !sourceExtension.test(entry.name) &&
            !sourceBasename.test(entry.name) &&
            !textLike(child, stat.size)
          ) {
            continue;
          }
          if (
            childRegisteredOnly &&
            !registeredPathIncludes(childRegistryRel)
          ) {
            continue;
          }
          if (snapshotEligible) {
            includedRegularPaths.add(childSnapshotRel);
          }
          if (
            recordIdentity &&
            !recordFile(
              child,
              childRel,
              stat.size,
              (stat.mode & 0o111) !== 0,
              sourceOnly,
              childListingRel,
            )
          ) {
            return false;
          }
          if (
            snapshotEligible &&
            snapshotCandidate(
              child,
              childRegistryRel,
              entry.name,
              stat.size,
            )
          ) {
            snapshotPaths.add(childSnapshotRel);
          }
          continue;
        }
        if (recordIdentity) {
          const special = `special:${stat.mode}`;
          lines.push(`${special}:${childRel}`);
          const specialEntry = sourceListingEntry(
            "000000",
            createHash("sha256").update(special).digest("hex"),
          );
          if (specialEntry === null) return false;
          listing.set(childListingRel, specialEntry);
        }
      }
      return true;
    } finally {
      active.delete(real);
    }
  };
  if (!walk(rootReal)) return null;
  return {
    embeddedGitPaths: [...embeddedGitPaths].sort(),
    excludedSymlinkPathspecs: [...excludedSymlinkPathspecs].sort(),
    externalSymlinkPaths: [...externalSymlinkPaths].sort(),
    fingerprint: createHash("sha256")
      .update(["aidlc-filesystem-source-v2", ...lines].join("\n"))
      .digest("hex"),
    harnessShellDirs: [...harnessShellDirs].sort(),
    includedRegularPaths: [...includedRegularPaths].sort(),
    listing,
    registeredSnapshotPaths: [...registeredSnapshotPaths].sort(),
    snapshotPaths: [...snapshotPaths].sort(),
  };
}

function multiRepoRoofExcludedTopLevel(
  projectDir: string,
  repos: readonly string[],
): Set<string> | null {
  const excluded = new Set(repos);
  const maxEntries = sourceIdentityBudget(
    "AIDLC_TEST_SOURCE_MAX_ENTRIES",
    250_000,
  );
  let handle: ReturnType<typeof opendirSync> | undefined;
  try {
    handle = opendirSync(projectDir);
    let entriesSeen = 0;
    while (true) {
      const entry = handle.readSync();
      if (entry === null) break;
      entriesSeen += 1;
      if (entriesSeen > maxEntries) return null;
      if (entry.isDirectory()) {
        excluded.add(entry.name);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      try {
        if (statSync(join(projectDir, entry.name)).isDirectory()) {
          excluded.add(entry.name);
        }
      } catch {
        // A broken roof symlink is fingerprinted as a roof file unless the
        // source registry or another explicit boundary says otherwise.
      }
    }
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        handle.closeSync();
      } catch {
        // The bounded read path already fails closed.
      }
    }
  }
  return excluded;
}

export function workspaceSourceSnapshotPaths(
  projectDir: string,
  carriesWorkspaceShell = false,
): string[] | null {
  return (
    filesystemSourceIdentity(projectDir, carriesWorkspaceShell)
      ?.snapshotPaths ?? null
  );
}

export function workspaceSourceEmbeddedGitPaths(
  projectDir: string,
  carriesWorkspaceShell = false,
): string[] | null {
  return (
    filesystemSourceIdentity(projectDir, carriesWorkspaceShell)
      ?.embeddedGitPaths ?? null
  );
}

// Compute the opaque #629 source fingerprint and the #662 canonical per-path
// listing in the same bounded filesystem pass. Keys are `<repo>\0<path>`;
// single-repo/Bolt worktrees use an empty repo component.
export function workspaceSourceState(
  projectDir: string,
  intent?: string,
  space?: string,
): WorkspaceSourceState | null {
  const repos = intentRepos(projectDir, intent, space);
  if (repos.length === 0) {
    const hasWorktreeContext = existsSync(
      join(projectDir, ".aidlc", "worktree-meta.json"),
    );
    const worktreeContext = hasWorktreeContext
      ? worktreeSourceExclusionContext(projectDir)
      : null;
    if (hasWorktreeContext && worktreeContext === null) return null;
    const source = filesystemSourceIdentity(
      projectDir,
      worktreeContext?.carriesWorkspaceShell ?? true,
    );
    if (source === null) return null;
    return {
      fingerprint: createHash("sha256")
        .update(
          [
            "aidlc-workspace-source-v2",
            `filesystem=${source.fingerprint}`,
          ].join("\n"),
        )
        .digest("hex"),
      listing: prefixedSourceListing(source.listing),
    };
  }
  const lines: string[] = [];
  const listing: WorkspaceSourceListing = new Map();
  const roofExcluded = multiRepoRoofExcludedTopLevel(projectDir, repos);
  if (roofExcluded === null) return null;
  const roof = filesystemSourceIdentity(projectDir, true, roofExcluded);
  if (roof === null) return null;
  lines.push(`roof=filesystem:${roof.fingerprint}`);
  for (const [key, entry] of prefixedSourceListing(roof.listing)) {
    listing.set(key, entry);
  }
  for (const name of [...repos].sort()) {
    // A sibling repo is a child of the roof; the shell is its SIBLING, never
    // nested inside it, so nothing there belongs to the framework.
    const dir = repoDir(projectDir, name);
    if (!existsSync(dir)) {
      lines.push(`${name}=missing`);
      continue;
    }
    const source = filesystemSourceIdentity(dir, false);
    if (source === null) return null;
    lines.push(`${name}=filesystem:${source.fingerprint}`);
    for (const [key, entry] of prefixedSourceListing(source.listing, name)) {
      listing.set(key, entry);
    }
  }
  return {
    fingerprint: createHash("sha256")
      .update(["aidlc-workspace-source-v2", ...lines].join("\n"))
      .digest("hex"),
    listing,
  };
}

export function workspaceSourceFingerprint(
  projectDir: string,
  intent?: string,
  space?: string,
): string | null {
  return workspaceSourceState(projectDir, intent, space)?.fingerprint ?? null;
}

export function workspaceSourceListing(
  projectDir: string,
  intent?: string,
  space?: string,
): WorkspaceSourceListing | null {
  return workspaceSourceState(projectDir, intent, space)?.listing ?? null;
}

export interface UnitSourceManifestWrite {
  path: string;
  repo?: string;
}

export interface UnitSourceManifest {
  stage: string;
  unit: string;
  version: 1;
  writes: UnitSourceManifestWrite[];
}

export interface SourceClaimModel {
  claims: Set<string>;
  prefixes: string[];
}

export type ReadUnitSourceManifestResult =
  | {
      ok: true;
      manifest: UnitSourceManifest;
      claims: Set<string>;
      prefixes: string[];
      rawBytesSha256: string;
    }
  | { ok: false; reason: string };

function sourceListingFieldEncode(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

function sourceListingFieldDecode(value: string): string | null {
  let decoded = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "\\") {
      decoded += value[i];
      continue;
    }
    i++;
    if (i >= value.length) return null;
    if (value[i] === "\\") decoded += "\\";
    else if (value[i] === "t") decoded += "\t";
    else if (value[i] === "n") decoded += "\n";
    else if (value[i] === "r") decoded += "\r";
    else return null;
  }
  return decoded;
}

function splitSourcePathKey(key: string): { repo: string; path: string } | null {
  const separator = key.indexOf("\0");
  if (separator === -1 || key.indexOf("\0", separator + 1) !== -1) return null;
  const repo = key.slice(0, separator);
  const path = key.slice(separator + 1);
  if (path.length === 0 || (repo.length > 0 && !isValidRepoName(repo))) return null;
  return { repo, path };
}

/** Canonical key shared by listings and manifest claims: `<repo>\0<path>`. */
export function sourcePathKey(repo: string, path: string): string {
  if (repo.includes("\0") || path.includes("\0")) {
    throw new Error("Source path keys cannot contain NUL bytes");
  }
  return `${repo}\0${path}`;
}

/**
 * Stable snapshot representation. Ordinary paths remain readable TSV; the four
 * characters that can make a TSV row ambiguous are backslash-escaped so Git
 * paths containing tabs/newlines still round-trip without weakening the NUL-
 * safe index enumeration that produced them.
 */
export function serializeSourceListing(listing: ReadonlyMap<string, string>): string {
  const rows: Array<{ key: string; line: string }> = [];
  for (const [key, entry] of listing) {
    const parsed = splitSourcePathKey(key);
    if (parsed === null) throw new Error("Invalid canonical source-listing path key");
    const modern =
      /^(\d{6}) ((?:[0-9a-f]{40}|[0-9a-f]{64}))$/.exec(entry);
    const legacy = GIT_OBJECT_ID_RE.test(entry);
    if (modern === null && !legacy) {
      throw new Error(`Invalid source-listing entry for ${JSON.stringify(parsed.path)}`);
    }
    const suffix = modern === null ? entry : `${modern[1]}\t${modern[2]}`;
    rows.push({
      key,
      line: `${sourceListingFieldEncode(parsed.repo)}\t${sourceListingFieldEncode(parsed.path)}\t${suffix}`,
    });
  }
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows.length === 0 ? "" : `${rows.map((row) => row.line).join("\n")}\n`;
}

export function parseSourceListing(serialized: string): WorkspaceSourceListing | null {
  if (serialized === "") return new Map();
  if (!serialized.endsWith("\n")) return null;
  const listing: WorkspaceSourceListing = new Map();
  for (const line of serialized.slice(0, -1).split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== 3 && fields.length !== 4) return null;
    const repo = sourceListingFieldDecode(fields[0]);
    const path = sourceListingFieldDecode(fields[1]);
    const mode = fields.length === 4 ? fields[2] : null;
    const oid = fields.at(-1) ?? "";
    if (
      repo === null ||
      path === null ||
      path.length === 0 ||
      (repo.length > 0 && !isValidRepoName(repo)) ||
      (mode !== null && !/^\d{6}$/.test(mode)) ||
      !GIT_OBJECT_ID_RE.test(oid)
    ) return null;
    const key = sourcePathKey(repo, path);
    if (listing.has(key)) return null;
    listing.set(key, mode === null ? oid : `${mode} ${oid}`);
  }
  return listing;
}

export function sourceListingSha256(serialized: string): string {
  return createHash("sha256").update(serialized, "utf-8").digest("hex");
}

function normalizeManifestSourcePath(path: string): { path: string; prefix: boolean } | { reason: string } {
  if (path.length === 0) return { reason: "writes[].path must be non-empty" };
  if (path.includes("\0")) return { reason: "writes[].path cannot contain a NUL byte" };
  if (path.includes("\\")) return { reason: "writes[].path must use POSIX '/' separators, not backslashes" };
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
    return { reason: "writes[].path must be relative, not absolute" };
  }
  if (/[*?[\]{}]/.test(path)) return { reason: "writes[].path cannot contain glob syntax" };
  const inputSegments = path.split("/");
  if (inputSegments.includes("..")) return { reason: "writes[].path cannot contain '..' segments" };
  const prefix = path.endsWith("/");
  const segments = inputSegments.filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return { reason: "writes[].path must name a path below the repository root" };
  return { path: `${segments.join("/")}${prefix ? "/" : ""}`, prefix };
}

function sourcePathIsExcluded(
  path: string,
  carriesWorkspaceShell: boolean,
  projectDir?: string,
): boolean {
  const withoutTrailingSlash = path.replace(/\/+$/, "");
  const segments = withoutTrailingSlash.split("/");
  if (
    carriesWorkspaceShell &&
    (
      path === "aidlc/" ||
      path === ".aidlc/" ||
      path.startsWith("aidlc/") ||
      path.startsWith(".aidlc/") ||
      (
        projectDir !== undefined &&
        isSourceHarnessShellDir(projectDir, segments[0])
      )
    )
  ) return true;

  if (!carriesWorkspaceShell && projectDir !== undefined) {
    const context = worktreeSourceExclusionContext(projectDir);
    if (
      context !== null &&
      !context.carriesWorkspaceShell &&
      context.exactPaths.some((excluded) => {
        const normalized = excluded.replace(/\/+$/, "");
        return withoutTrailingSlash === normalized ||
          (excluded.endsWith("/") &&
            withoutTrailingSlash.startsWith(`${normalized}/`));
      })
    ) {
      return true;
    }
  }

  for (let i = 0; i + 4 < segments.length; i++) {
    if (segments[i] !== "aidlc" || segments[i + 1] !== "spaces" || segments[i + 3] !== "intents") continue;
    if (segments[i + 2].length === 0) continue;
    if (segments.slice(i + 4).includes(".aidlc-sensors")) return true;
  }
  return false;
}

export function workspaceSourcePathIsExcluded(
  projectDir: string,
  path: string,
): boolean | null {
  const context = worktreeSourceExclusionContext(projectDir);
  if (context === null) return null;
  return sourcePathIsExcluded(
    path,
    context.carriesWorkspaceShell,
    projectDir,
  );
}

export interface ReadUnitSourceManifestOptions {
  /** Bolt worktrees fingerprint exactly one selected repo even if their forked
   * record still names the parent multi-repo intent. */
  worktreeRelative?: boolean;
}

interface GitPathModeIndex {
  env: NodeJS.ProcessEnv;
  indexFile: string;
}

type GitPathModeIndexCache = Map<string, GitPathModeIndex | null>;

function currentGitPathMode(
  sourceRepoDir: string,
  literalPath: string,
  indexes: GitPathModeIndexCache,
): { ok: boolean; mode: string | null } {
  let repoKey: string;
  try {
    repoKey = realpathSync(sourceRepoDir);
  } catch {
    repoKey = resolvePath(sourceRepoDir);
  }
  if (!indexes.has(repoKey)) {
    const indexFile = join(
      tmpdir(),
      `aidlc-claim-mode-${process.pid}-${randomUUID().slice(0, 8)}`,
    );
    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    const seeded = spawnSync("git", ["-C", sourceRepoDir, "read-tree", "HEAD"], {
      env,
      encoding: "utf-8",
      maxBuffer: 512 * 1024 * 1024,
    });
    if (seeded.status !== 0) {
      const empty = spawnSync(
        "git",
        ["-C", sourceRepoDir, "read-tree", "--empty"],
        { env, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
      );
      if (empty.status !== 0) {
        rmSync(indexFile, { force: true });
        indexes.set(repoKey, null);
      } else {
        indexes.set(repoKey, { env, indexFile });
      }
    } else {
      indexes.set(repoKey, { env, indexFile });
    }
  }
  const index = indexes.get(repoKey);
  if (index === null || index === undefined) {
    return { ok: false, mode: null };
  }
  // The cache accumulates prior single-path additions, but each probe stages
  // and reads only its exact literal path. An earlier path cannot create or
  // change that exact index entry; ordinary directories still have no exact
  // entry, while embedded repositories remain mode 160000.
  const added = spawnSync(
    "git",
    ["-C", sourceRepoDir, "add", "--", `./${literalPath}`],
    {
      env: index.env,
      encoding: "utf-8",
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  if (added.status !== 0) return { ok: false, mode: null };
  const listed = spawnSync(
    "git",
    ["-C", sourceRepoDir, "ls-files", "-s", "-z", "--", `./${literalPath}`],
    {
      env: index.env,
      encoding: "utf-8",
      maxBuffer: 512 * 1024 * 1024,
    },
  );
  if (listed.status !== 0) return { ok: false, mode: null };
  for (const record of listed.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1 || record.slice(tab + 1) !== literalPath) continue;
    const mode = /^(\d{6}) /.exec(record.slice(0, tab))?.[1] ?? null;
    return { ok: mode !== null, mode };
  }
  return { ok: true, mode: null };
}

function symlinkedParentComponent(
  sourceRepoDir: string,
  literalPath: string,
): string | null {
  const segments = literalPath.split("/");
  let current = sourceRepoDir;
  for (let index = 0; index < segments.length - 1; index++) {
    current = join(current, segments[index]);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        return segments.slice(0, index + 1).join("/");
      }
      if (!stat.isDirectory()) return null;
    } catch {
      return null;
    }
  }
  return null;
}

function sourcePathIsRegistered(
  sourceRepoDir: string,
  carriesWorkspaceShell: boolean,
  path: string,
): boolean {
  const harnessShellDirs = carriesWorkspaceShell
    ? sourceHarnessShellDirs(sourceRepoDir)
    : new Set<string>();
  if (harnessShellDirs === null) return false;
  const registered = sourceFingerprintRegistryPaths(
    sourceRepoDir,
    carriesWorkspaceShell,
    harnessShellDirs,
  );
  if (registered === null) return false;
  const effective = new Set(registered);
  let rootReal: string;
  try {
    rootReal = realpathSync(sourceRepoDir);
  } catch {
    return false;
  }
  for (const logicalPath of registered) {
    const physical = registeredPhysicalSourcePath(
      rootReal,
      logicalPath,
      false,
    );
    if (physical === null || physical.path === null) return false;
    const physicalPath = physical.path;
    const physicalInside = pathIsWithinRoot(rootReal, physicalPath);
    if (physical.externalHop && physicalInside) return false;
    if (!physicalInside) continue;
    const physicalRel = relative(rootReal, physicalPath)
      .split(sep)
      .join("/");
    if (
      physicalRel.length > 0 &&
      !sourcePathPhysicallyExcluded(
        physicalRel,
        carriesWorkspaceShell,
        harnessShellDirs,
      )
    ) {
      effective.add(physicalRel);
    }
  }
  const normalized = path.replace(/\/+$/, "");
  if (effective.has(normalized)) return true;
  let slash = normalized.lastIndexOf("/");
  while (slash !== -1) {
    if (effective.has(normalized.slice(0, slash))) return true;
    slash = normalized.lastIndexOf("/", slash - 1);
  }
  return false;
}

function ignoredSourceClaimReason(
  sourceRepoDir: string,
  path: string,
  prefix: boolean,
  pathModeIndexes: GitPathModeIndexCache,
  carriesWorkspaceShell: boolean,
): string | null {
  if (!isGitRepoDir(sourceRepoDir)) return null;
  const literalPath = path.replace(/\/+$/, "");
  const literalPathspec = `./${literalPath}`;
  const symlinkedParent = symlinkedParentComponent(
    sourceRepoDir,
    literalPath,
  );
  if (symlinkedParent !== null) {
    return `${JSON.stringify(path)} traverses symlinked directory ${JSON.stringify(symlinkedParent)}. Source claims bind link text, not target bytes; claim the real target path instead, or restructure the link.`;
  }

  let currentExists = false;
  let currentIsDirectory = false;
  try {
    const current = lstatSync(join(sourceRepoDir, literalPath));
    currentExists = true;
    currentIsDirectory = current.isDirectory();
  } catch {
    // An absent exact path is valid and becomes stale if it appears later.
  }

  let headTracked = false;
  const head = spawnSync(
    "git",
    ["-C", sourceRepoDir, "rev-parse", "--verify", "HEAD^{commit}"],
    { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (head.status === 0 && head.stdout.trim()) {
    const listed = spawnSync(
      "git",
      [
        "-C",
        sourceRepoDir,
        "ls-tree",
        "-z",
        "--full-tree",
        head.stdout.trim(),
        "--",
        literalPathspec,
      ],
      { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (listed.status !== 0) {
      return `Git could not verify HEAD membership for ${JSON.stringify(path)}`;
    }
    const entry = listed.stdout.split("\0").find(Boolean);
    if (entry) {
      const headIsDirectory = /^040000 /.test(entry);
      if (!prefix && !currentExists && headIsDirectory) {
        return `${JSON.stringify(path)} is a directory; directory claims must end with "/"`;
      }
      headTracked = !headIsDirectory;
    }
  }

  const ignored = spawnSync(
    "git",
    [
      "-C",
      sourceRepoDir,
      "check-ignore",
      "-q",
      "--no-index",
      "--",
      literalPathspec,
    ],
    { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (ignored.status === 0) {
    if (
      sourcePathIsRegistered(
        sourceRepoDir,
        carriesWorkspaceShell,
        literalPath,
      )
    ) {
      return null;
    }
    if (!prefix && headTracked && !currentIsDirectory) return null;
    return `${JSON.stringify(path)} is ignored by Git and cannot be source-review evidence`;
  }
  if (ignored.status !== 1) {
    return `Git could not verify ignore rules for ${JSON.stringify(path)}`;
  }
  if (!prefix && currentIsDirectory) {
    const currentMode = currentGitPathMode(
      sourceRepoDir,
      literalPath,
      pathModeIndexes,
    );
    if (!currentMode.ok) {
      return `Git could not verify the current path type for ${JSON.stringify(path)}`;
    }
    if (currentMode.mode !== "160000") {
      return `${JSON.stringify(path)} is a directory; directory claims must end with "/"`;
    }
  }
  if (!prefix) return null;

  const indexFile = join(
    tmpdir(),
    `aidlc-ignored-claims-${process.pid}-${randomUUID().slice(0, 8)}`,
  );
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  try {
    const seeded = spawnSync(
      "git",
      [
        "-C",
        sourceRepoDir,
        "read-tree",
        ...(head.status === 0 && head.stdout.trim()
          ? [head.stdout.trim()]
          : ["--empty"]),
      ],
      { env, encoding: "utf-8", maxBuffer: 512 * 1024 * 1024 },
    );
    if (seeded.status !== 0) {
      return `Git could not seed ignore verification for ${JSON.stringify(path)}`;
    }
    const ignoredDescendants = spawnSync(
      "git",
      [
        "-C",
        sourceRepoDir,
        "ls-files",
        "-z",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        literalPathspec,
      ],
      {
        env,
        encoding: "utf-8",
        maxBuffer: 512 * 1024 * 1024,
      },
    );
    if (ignoredDescendants.status !== 0) {
      return `Git could not enumerate ignored source below ${JSON.stringify(path)}`;
    }
    const firstIgnored = ignoredDescendants.stdout.split("\0").find(Boolean);
    return firstIgnored
      ? `${JSON.stringify(path)} contains ignored application source ${JSON.stringify(firstIgnored)}`
      : null;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function manifestClaimSymlinkPaths(
  sourceRepoDir: string,
  literalPath: string,
  prefix: boolean,
): string[] | null {
  const root = join(sourceRepoDir, literalPath);
  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink()) return [literalPath];
    if (!prefix) return [];
    if (!rootStat.isDirectory()) return [];
  } catch {
    return [];
  }
  const links: string[] = [];
  const walk = (dir: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch {
        return false;
      }
      if (stat.isSymbolicLink()) {
        links.push(relative(sourceRepoDir, path).replaceAll("\\", "/"));
      } else if (stat.isDirectory() && !walk(path)) {
        return false;
      }
    }
    return true;
  };
  return walk(root) ? links.sort() : null;
}

function symlinkClaimTargetReason(
  sourceRepoDir: string,
  claimPath: string,
  prefix: boolean,
  carriesWorkspaceShell: boolean,
  pathModeIndexes: GitPathModeIndexCache,
): string | null {
  const links = manifestClaimSymlinkPaths(
    sourceRepoDir,
    claimPath.replace(/\/+$/, ""),
    prefix,
  );
  if (links === null) {
    return `could not enumerate symlinks below ${JSON.stringify(claimPath)}`;
  }
  let repoRoot: string;
  try {
    repoRoot = realpathSync(sourceRepoDir);
  } catch (error) {
    return `cannot resolve repository root (${errorMessage(error)})`;
  }
  const remedy =
    "Source claims bind link text, not target bytes; claim the target path instead, or restructure the link.";
  for (const link of links) {
    let current = join(sourceRepoDir, link);
    const visited = new Set<string>();
    let targetDisplay = "";
    for (let hop = 0; hop < 40; hop++) {
      const key = resolvePath(current);
      if (visited.has(key)) {
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose target contains a cycle. ${remedy}`;
      }
      visited.add(key);
      let target: string;
      try {
        target = readlinkSync(current);
      } catch (error) {
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose target cannot be read (${errorMessage(error)}). ${remedy}`;
      }
      let currentDir: string;
      try {
        currentDir = realpathSync(dirname(current));
      } catch (error) {
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose containing directory cannot be resolved (${errorMessage(error)}). ${remedy}`;
      }
      const currentDirRelative = relative(repoRoot, currentDir);
      if (
        currentDirRelative === ".." ||
        currentDirRelative.startsWith(`..${sep}`) ||
        isAbsolute(currentDirRelative)
      ) {
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose fully resolved hop ${JSON.stringify(join(currentDir, basename(current)))} is outside the repository. ${remedy}`;
      }
      const next = isAbsolute(target)
        ? resolvePath(target)
        : resolvePath(currentDir, target);
      targetDisplay = relative(repoRoot, next).replaceAll("\\", "/") || ".";
      const hopRelative = relative(repoRoot, next);
      if (
        hopRelative === ".." ||
        hopRelative.startsWith(`..${sep}`) ||
        isAbsolute(hopRelative)
      ) {
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose fully resolved target ${JSON.stringify(next)} is outside the repository. ${remedy}`;
      }
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(next);
      } catch {
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose fully resolved target ${JSON.stringify(targetDisplay)} does not exist. ${remedy}`;
      }
      if (stat.isSymbolicLink()) {
        current = next;
        continue;
      }
      let resolved: string;
      try {
        resolved = realpathSync(next);
      } catch {
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose fully resolved target ${JSON.stringify(targetDisplay)} does not exist. ${remedy}`;
      }
      const resolvedRelative = relative(repoRoot, resolved);
      if (
        resolvedRelative === ".." ||
        resolvedRelative.startsWith(`..${sep}`) ||
        isAbsolute(resolvedRelative)
      ) {
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose fully resolved target ${JSON.stringify(resolved)} is outside the repository. ${remedy}`;
      }
      const repoRelative = resolvedRelative.replaceAll("\\", "/");
      if (
        !prefix &&
        link === claimPath.replace(/\/+$/, "") &&
        stat.isDirectory()
      ) {
        targetDisplay = "";
        break;
      }
      if (
        sourcePathIsExcluded(
          repoRelative,
          carriesWorkspaceShell,
          sourceRepoDir,
        )
      ) {
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose fully resolved target ${JSON.stringify(repoRelative)} is excluded from source evidence. ${remedy}`;
      }
      const ignored = ignoredSourceClaimReason(
        sourceRepoDir,
        repoRelative,
        false,
        pathModeIndexes,
        carriesWorkspaceShell,
      );
      if (ignored !== null) {
        const targetReason = prefix && stat.isDirectory()
          ? `${JSON.stringify(repoRelative)} is a directory and cannot be bound through a symlinked directory claim`
          : ignored;
        return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose fully resolved target is not bindable: ${targetReason}. ${remedy}`;
      }
      targetDisplay = "";
      break;
    }
    if (targetDisplay !== "") {
      return `${JSON.stringify(claimPath)} contains symlink ${JSON.stringify(link)} whose target exceeds 40 symlink hops. ${remedy}`;
    }
  }
  return null;
}

/** Strictly read and validate a unit's engine-required source-manifest.json. */
export function readUnitSourceManifest(
  projectDir: string,
  stageSlug: string,
  unit: string,
  options: ReadUnitSourceManifestOptions = {},
): ReadUnitSourceManifestResult {
  if (!/^[a-z][a-z0-9-]*$/.test(stageSlug)) return { ok: false, reason: `invalid stage slug ${JSON.stringify(stageSlug)}` };
  const unitError = validateUnitName(unit);
  if (unitError !== null) return { ok: false, reason: unitError };
  const record = recordDir(projectDir);
  if (record === null) return { ok: false, reason: "no active intent record resolves" };
  const manifestPath = join(record, "construction", unit, stageSlug, "source-manifest.json");

  let rawBytes: Buffer;
  let value: unknown;
  try {
    rawBytes = readFileSync(manifestPath);
  } catch (error) {
    return { ok: false, reason: `cannot read source-manifest.json (${errorMessage(error)})` };
  }
  try {
    value = JSON.parse(rawBytes.toString("utf-8")) as unknown;
  } catch (error) {
    return { ok: false, reason: `source-manifest.json is not valid JSON (${errorMessage(error)})` };
  }
  if (!isPlainObject(value)) return { ok: false, reason: "source-manifest.json must contain a JSON object" };

  const allowedTopLevel = new Set(["stage", "unit", "version", "writes"]);
  const unknownTopLevel = Object.keys(value).filter((key) => !allowedTopLevel.has(key));
  if (unknownTopLevel.length > 0) {
    return { ok: false, reason: `source-manifest.json has unknown field(s): ${unknownTopLevel.sort().join(", ")}` };
  }
  if (value.stage !== stageSlug) return { ok: false, reason: `stage must equal ${JSON.stringify(stageSlug)}` };
  if (value.unit !== unit) return { ok: false, reason: `unit must equal ${JSON.stringify(unit)}` };
  if (value.version !== 1) return { ok: false, reason: "version must equal 1" };
  if (!Array.isArray(value.writes)) return { ok: false, reason: "writes must be an array" };

  const worktreeContext =
    options.worktreeRelative ||
      existsSync(join(projectDir, ".aidlc", "worktree-meta.json"))
      ? worktreeSourceExclusionContext(projectDir)
      : null;
  if (
    (
      options.worktreeRelative ||
      existsSync(join(projectDir, ".aidlc", "worktree-meta.json"))
    ) &&
    worktreeContext === null
  ) {
    return {
      ok: false,
      reason: "worktree metadata is missing or malformed",
    };
  }
  const worktreeRelative = worktreeContext !== null;
  const recordedRepos = worktreeRelative ? [] : intentRepos(projectDir);
  const recordedRepoSet = new Set(recordedRepos);
  const carriesWorkspaceShell =
    worktreeContext?.carriesWorkspaceShell ?? recordedRepos.length === 0;
  const claims = new Set<string>();
  const prefixes: string[] = [];
  const seen = new Set<string>();
  const writes: UnitSourceManifestWrite[] = [];
  const pathModeIndexes: GitPathModeIndexCache = new Map();

  try {
  for (let index = 0; index < value.writes.length; index++) {
    const write = value.writes[index];
    if (!isPlainObject(write)) return { ok: false, reason: `writes[${index}] must be an object` };
    const allowedWriteFields = new Set(["repo", "path"]);
    const unknownWriteFields = Object.keys(write).filter((key) => !allowedWriteFields.has(key));
    if (unknownWriteFields.length > 0) {
      return { ok: false, reason: `writes[${index}] has unknown field(s): ${unknownWriteFields.sort().join(", ")}` };
    }
    if (typeof write.path !== "string") return { ok: false, reason: `writes[${index}].path must be a string` };
    if ("repo" in write && typeof write.repo !== "string") {
      return { ok: false, reason: `writes[${index}].repo must be a string when present` };
    }

    const declaredRepo = typeof write.repo === "string" ? write.repo : undefined;
    let canonicalRepo = declaredRepo;
    if (canonicalRepo !== undefined) {
      if (!isValidRepoName(canonicalRepo)) return { ok: false, reason: `writes[${index}].repo is not a valid recorded-repo name` };
      if (!recordedRepoSet.has(canonicalRepo)) return { ok: false, reason: `writes[${index}].repo ${JSON.stringify(canonicalRepo)} is not recorded for this intent` };
    } else if (recordedRepos.length > 1) {
      return { ok: false, reason: `writes[${index}].repo is required for a multi-repo intent` };
    } else if (recordedRepos.length === 1) {
      canonicalRepo = recordedRepos[0];
    }

    const normalized = normalizeManifestSourcePath(write.path);
    if ("reason" in normalized) return { ok: false, reason: `writes[${index}].path: ${normalized.reason}` };
    if (
      sourcePathIsExcluded(
        normalized.path,
        carriesWorkspaceShell,
        worktreeRelative ? projectDir : undefined,
      )
    ) {
      return { ok: false, reason: `writes[${index}].path is inside the framework record/shell exclusions` };
    }
    const sourceRepoDir =
      worktreeRelative
        ? projectDir
        : canonicalRepo === undefined
          ? projectDir
          : repoDir(projectDir, canonicalRepo);
    const ignoredReason = ignoredSourceClaimReason(
      sourceRepoDir,
      normalized.path,
      normalized.prefix,
      pathModeIndexes,
      carriesWorkspaceShell,
    );
    if (ignoredReason !== null) {
      return { ok: false, reason: `writes[${index}].path: ${ignoredReason}` };
    }
    const symlinkReason = symlinkClaimTargetReason(
      sourceRepoDir,
      normalized.path,
      normalized.prefix,
      carriesWorkspaceShell,
      pathModeIndexes,
    );
    if (symlinkReason !== null) {
      return { ok: false, reason: `writes[${index}].path: ${symlinkReason}` };
    }
    const key = sourcePathKey(canonicalRepo ?? "", normalized.path);
    if (seen.has(key)) return { ok: false, reason: `writes[${index}] duplicates a normalized source claim` };
    seen.add(key);
    if (normalized.prefix) prefixes.push(key);
    else claims.add(key);
    writes.push({ ...(declaredRepo === undefined ? {} : { repo: declaredRepo }), path: normalized.path });
  }

  prefixes.sort();
  return {
    ok: true,
    manifest: { stage: stageSlug, unit, version: 1, writes },
    claims,
    prefixes,
    rawBytesSha256: createHash("sha256").update(rawBytes).digest("hex"),
  };
  } finally {
    for (const index of pathModeIndexes.values()) {
      if (index !== null) rmSync(index.indexFile, { force: true });
    }
  }
}

/** True when a canonical path is claimed exactly or by a directory prefix. */
export function sourceClaimCovers(pathKey: string, claimModel: SourceClaimModel): boolean {
  if (claimModel.claims.has(pathKey)) return true;
  return claimModel.prefixes.some((prefix) => pathKey.startsWith(prefix));
}

/** Expand exact/directory claims against one current source listing. */
export function restrictSourceListing(
  listing: ReadonlyMap<string, string>,
  claimModel: SourceClaimModel,
): WorkspaceSourceListing {
  const restricted: WorkspaceSourceListing = new Map();
  for (const [key, oid] of listing) {
    if (sourceClaimCovers(key, claimModel)) restricted.set(key, oid);
  }
  return restricted;
}

function serializeUnitSourceListing(
  listing: ReadonlyMap<string, string>,
  claimModel: SourceClaimModel,
  manifestSha256: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) throw new Error("Invalid source-manifest sha256");
  return `manifest\t${manifestSha256}\t-\n${serializeSourceListing(restrictSourceListing(listing, claimModel))}`;
}

/** Audit-field value binding manifest bytes plus every currently claimed path. */
export function unitSourceFingerprint(
  listing: ReadonlyMap<string, string>,
  claimModel: SourceClaimModel,
  manifestSha256: string,
): string {
  return `sha256:${sourceListingSha256(serializeUnitSourceListing(listing, claimModel, manifestSha256))}`;
}

function validSourceSnapshotFingerprint(fingerprint: string): string | null {
  const matched = /^sha256:([0-9a-f]{64})$/.exec(fingerprint);
  return matched?.[1] ?? null;
}

function sourceSnapshotDir(
  projectDir: string,
  stageSlug: string,
  intent?: string,
  space?: string,
): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(stageSlug)) return null;
  const record = recordDir(projectDir, intent, space);
  return record === null ? null : join(record, ".aidlc-source-review", stageSlug);
}

function writeSourceSnapshot(path: string, serialized: string): string {
  const hash = sourceListingSha256(serialized);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (existing.equals(Buffer.from(serialized, "utf-8"))) return `sha256:${hash}`;
    // A different payload at the same 12-hex address is either corruption or
    // a prefix collision. Never destroy evidence already referenced by audit.
    throw new Error(`Source snapshot address collision or corruption at ${path}`);
  }
  writeFileAtomic(path, serialized);
  return `sha256:${hash}`;
}

/** Write a content-addressed stage-entry baseline listing snapshot. */
export function writeBaselineSourceSnapshot(
  projectDir: string,
  stageSlug: string,
  listing: ReadonlyMap<string, string>,
  intent?: string,
  space?: string,
): string {
  const dir = sourceSnapshotDir(projectDir, stageSlug, intent, space);
  if (dir === null) throw new Error("Cannot write source baseline without a valid active record and stage slug");
  const serialized = serializeSourceListing(listing);
  const hash = sourceListingSha256(serialized);
  return writeSourceSnapshot(join(dir, `baseline-${hash.slice(0, 12)}.tsv`), serialized);
}

/** Build the modern source-baseline audit field for any workflow/stage boundary. */
export function sourceBaselineAuditFields(
  projectDir: string,
  stageSlug: string,
  intent?: string,
  space?: string,
): Record<string, string> {
  const repos = intentRepos(projectDir, intent, space);
  const hasGitCheckout =
    repos.length === 0
      ? isGitRepoDir(projectDir)
      : repos.some((name) => isGitRepoDir(repoDir(projectDir, name)));
  const sourceState = workspaceSourceState(projectDir, intent, space);
  if (sourceState === null) {
    if (hasGitCheckout) {
      return { "Source Baseline": UNBINDABLE_FINGERPRINT };
    }
    return {
      "Source Baseline": writeBaselineSourceSnapshot(
        projectDir,
        stageSlug,
        new Map(),
        intent,
        space,
      ),
    };
  }
  return {
    "Source Baseline": writeBaselineSourceSnapshot(
      projectDir,
      stageSlug,
      sourceState.listing,
      intent,
      space,
    ),
  };
}

/** Write a content-addressed unit listing snapshot including its manifest header. */
export function writeUnitSourceSnapshot(
  projectDir: string,
  stageSlug: string,
  unit: string,
  listing: ReadonlyMap<string, string>,
  claimModel: SourceClaimModel,
  manifestSha256: string,
): string {
  const dir = sourceSnapshotDir(projectDir, stageSlug);
  const unitError = validateUnitName(unit);
  if (dir === null || unitError !== null) throw new Error("Cannot write unit source snapshot without a valid active record, stage slug, and unit");
  const serialized = serializeUnitSourceListing(listing, claimModel, manifestSha256);
  const hash = sourceListingSha256(serialized);
  return writeSourceSnapshot(join(dir, `unit-${unit}-${hash.slice(0, 12)}.tsv`), serialized);
}

function readSourceSnapshot(path: string, fingerprint: string): string | null {
  const expected = validSourceSnapshotFingerprint(fingerprint);
  if (expected === null) return null;
  try {
    const bytes = readFileSync(path);
    if (createHash("sha256").update(bytes).digest("hex") !== expected) return null;
    return bytes.toString("utf-8");
  } catch {
    return null;
  }
}

/** Read a baseline only after exact verification against the full audit hash. */
export function readBaselineSourceSnapshot(
  projectDir: string,
  stageSlug: string,
  fingerprint: string,
  intent?: string,
  space?: string,
): WorkspaceSourceListing | null {
  const dir = sourceSnapshotDir(projectDir, stageSlug, intent, space);
  const hash = validSourceSnapshotFingerprint(fingerprint);
  if (dir === null || hash === null) return null;
  const serialized = readSourceSnapshot(join(dir, `baseline-${hash.slice(0, 12)}.tsv`), fingerprint);
  return serialized === null ? null : parseSourceListing(serialized);
}

export function currentStageSourceBaseline(
  projectDir: string,
  stageSlug: string,
  unitMajor: boolean,
  intent?: string,
  space?: string,
): SourceBaselineResult {
  const allEvents = readAuditShardEvents(projectDir, intent, space);
  const modernSourceBindingEvidence =
    hasModernSourceBindingEvidence(projectDir, allEvents, intent, space);
  const events = allEvents
    .filter((row) =>
      row.event === "WORKFLOW_STARTED" ||
      row.event === "STAGE_STARTED" ||
      row.event === "STAGE_JUMPED" ||
      row.event === "ARTIFACT_CREATED" ||
      row.event === "ARTIFACT_UPDATED" ||
      row.event === "REVIEW_REQUESTED"
    )
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    });
  let boundary = -1;
  for (let index = 0; index < events.length; index++) {
    if (
      events[index].event === "WORKFLOW_STARTED" ||
      events[index].event === "STAGE_JUMPED"
    ) {
      boundary = index;
    }
  }
  let firstWork = events.length;
  for (let index = Math.max(boundary, 0); index < events.length; index++) {
    const event = events[index];
    if (auditBlockField(event.block, "Workflow")?.startsWith("single-stage:")) {
      continue;
    }
    if (auditBlockField(event.block, "Stage") !== stageSlug) continue;
    if (
      event.event === "REVIEW_REQUESTED" ||
      event.event === "ARTIFACT_CREATED" ||
      event.event === "ARTIFACT_UPDATED"
    ) {
      firstWork = index;
      break;
    }
  }
  let field: string | null = null;
  for (let index = Math.max(boundary, 0); index < firstWork; index++) {
    const event = events[index];
    const candidate = sourceBaselineBoundaryValue(
      event,
      stageSlug,
      unitMajor,
    );
    if (candidate === undefined) continue;
    if (
      candidate !== null &&
      auditEventIsCrossShardTied(
        events,
        index,
        (other) =>
          sourceBaselineBoundaryValue(
            other,
            stageSlug,
            unitMajor,
          ),
      )
    ) {
      field = UNBINDABLE_FINGERPRINT;
    } else {
      field = candidate;
    }
  }
  if (field === null) {
    return modernSourceBindingEvidence
      ? { state: "invalid" }
      : { state: "legacy" };
  }
  if (field === UNBINDABLE_FINGERPRINT) return { state: "unbindable" };
  const listing = readBaselineSourceSnapshot(
    projectDir,
    stageSlug,
    field,
    intent,
    space,
  );
  return listing === null ? { state: "invalid" } : { state: "ready", listing };
}

export interface UnitSourceSnapshot {
  listing: WorkspaceSourceListing;
  manifestSha256: string;
}

/** Read a unit snapshot only after full-hash verification and strict parsing. */
export function readUnitSourceSnapshot(
  projectDir: string,
  stageSlug: string,
  unit: string,
  fingerprint: string,
): UnitSourceSnapshot | null {
  const dir = sourceSnapshotDir(projectDir, stageSlug);
  const hash = validSourceSnapshotFingerprint(fingerprint);
  if (dir === null || hash === null || validateUnitName(unit) !== null) return null;
  const serialized = readSourceSnapshot(join(dir, `unit-${unit}-${hash.slice(0, 12)}.tsv`), fingerprint);
  if (serialized === null) return null;
  const newline = serialized.indexOf("\n");
  if (newline === -1) return null;
  const header = /^manifest\t([0-9a-f]{64})\t-$/.exec(serialized.slice(0, newline));
  if (header === null) return null;
  const listing = parseSourceListing(serialized.slice(newline + 1));
  return listing === null ? null : { listing, manifestSha256: header[1] };
}


// True iff `dir` looks like a git checkout: it holds a `.git` (a directory for a
// normal clone, OR a file for a submodule / linked worktree). Workspace-internal
// dirs that are never code repos are excluded by the discovery scan, not here.
export function isGitRepoDir(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

// Workspace-internal child dirs that are never code repos — excluded from sibling
// auto-discovery so the engine dir / the aidlc roof / VCS metadata never count as
// a repo. The harness dirs are open-set (isHarnessDirName), checked separately.
const NON_REPO_WORKSPACE_DIRS = new Set([
  "aidlc",
  ".git",
  ".aidlc",
  "node_modules",
]);

// Auto-discover the code repos that are immediate children of the workspace root:
// any child dir holding a `.git`, excluding the workspace's own internal dirs and
// the harness engine dir. Sorted + deduped. Returns [] when the workspace root is
// unreadable or holds no sibling repos (the legacy single-repo / fresh-greenfield
// case — the caller records no repos row and the lone repo is inferred later).
export function discoverSiblingRepos(projectDir: string): string[] {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(projectDir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (NON_REPO_WORKSPACE_DIRS.has(name)) continue;
    if (isHarnessDirName(name)) continue; // .claude / .kiro / .codex
    const dir = join(projectDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (isGitRepoDir(dir)) found.push(name);
  }
  return [...new Set(found)].sort();
}

// Resolve the repo set for a new intent at creation: an explicit `--repos a,b` set
// wins (authoritative when the user names them); absent it, sibling auto-discovery
// supplies the default. Each name is validated. Returns [] when neither yields a
// repo (→ no repos row → lone-repo inference). Throws on an invalid explicit name.
export function resolveIntentRepoSet(
  projectDir: string,
  explicitReposCsv?: string,
): string[] {
  if (explicitReposCsv && explicitReposCsv.trim().length > 0) {
    const names = explicitReposCsv
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
    for (const name of names) {
      if (!isValidRepoName(name)) {
        throw new Error(
          `Invalid --repos entry "${name}": a repo name must be a single path segment matching ${REPO_NAME_REGEX} (no separators or "..").`,
        );
      }
    }
    return [...new Set(names)].sort();
  }
  return discoverSiblingRepos(projectDir);
}

// The recorded repo set for an intent (its intents.json row's `repos`), or [] when
// none was recorded (legacy single-repo / projectDir-is-the-repo). The lookup
// follows the SAME row→record-dir match listIntents() uses, then falls back to the
// active intent's row when no explicit dirName is given.
export function intentRepos(
  projectDir: string,
  intentDirName?: string | null,
  space?: string,
): string[] {
  if (intentDirName === null) return [];
  const selection = resolveWorkflowSelection(projectDir, {
    space,
    intent: intentDirName,
  });
  const sp = selection.space;
  const dirName = selection.intent;
  if (!dirName) return [];
  for (const entry of readIntentRegistry(projectDir, sp)) {
    if (!recordDirMatches(entry, dirName)) continue;
    return entry.repos ?? [];
  }
  return [];
}

export interface RepoResolution {
  // The repo NAME to operate on, or null when the intent records NO repos (the
  // legacy single-repo case → git runs in the projectDir cwd, today's behaviour).
  repo: string | null;
  // The cwd the git op must run in: the sibling repo dir when `repo` is set, else
  // the projectDir (back-compat). The caller passes this as the git invocation cwd.
  cwd: string;
}

// Resolve which repo a CONSTRUCTION op targets, decoupling "the repo to operate
// on" from "the single projectDir":
//   - no recorded repos (legacy / projectDir-is-the-repo): with no --repo, null
//     → cwd=projectDir (back-compat); an explicit --repo is HONOURED as a sibling
//     anchor (cwd = the named sibling dir, repoDir(projectDir, requestedRepo)),
//     for multi-repo ops on an unrecorded intent — not errored.
//   - exactly one recorded repo: inferred (the lone repo); --repo optional but, if
//     given, must match.
//   - multiple recorded repos: --repo is REQUIRED to disambiguate; it must name one
//     of the set.
// Throws (string message) on any disambiguation failure so the tool can surface it.
export function resolveConstructionRepo(
  projectDir: string,
  requestedRepo: string | undefined,
  intentDirName?: string | null,
  space?: string,
): RepoResolution {
  const repos = intentRepos(projectDir, intentDirName, space);
  if (requestedRepo !== undefined) {
    if (!isValidRepoName(requestedRepo)) {
      throw new Error(
        `Invalid --repo "${requestedRepo}": a repo name must be a single path segment matching ${REPO_NAME_REGEX}.`,
      );
    }
    if (repos.length > 0 && !repos.includes(requestedRepo)) {
      throw new Error(
        `--repo "${requestedRepo}" is not in this intent's repo set: ${repos.join(", ")}.`,
      );
    }
    // repos.length === 0 (legacy) AND an explicit --repo: honour it as a sibling
    // anchor (the caller may be operating multi-repo on an unrecorded intent),
    // resolving cwd to the named sibling dir.
    return { repo: requestedRepo, cwd: repoDir(projectDir, requestedRepo) };
  }
  if (repos.length === 0) {
    // Legacy single-repo / projectDir-is-the-repo: run git in projectDir's cwd.
    return { repo: null, cwd: projectDir };
  }
  if (repos.length === 1) {
    return { repo: repos[0], cwd: repoDir(projectDir, repos[0]) };
  }
  throw new Error(
    `This intent spans ${repos.length} repos (${repos.join(", ")}); pass --repo <name> to disambiguate which to operate on.`,
  );
}

// --- Record-tree data-path family ---------------------------------------------
//
// Single chokepoint for every path under the project's record tree. Each helper
// resolves the per-intent RECORD dir (aidlc/spaces/<sp>/intents/<slug>-<id8>/)
// when an intent exists, else the bare space record root (spaceRecordRoot) — the
// P9 end state has no flat `aidlc-docs/` root, so the whole tree stays on ONE
// root per intent (state split across two roots is meaningless). The
// state/audit/worktree helpers above are the load-bearing pair; these cover the
// rest of the family (runtime graph, hook health, recovery breadcrumb, plan,
// stop-hook guard, the bare docs dir, and a stage's per-run directory) plus the
// per-worktree mirror copies.
//
// NOT funnelled here (deliberately): the two engine artifact/diary resolvers in
// aidlc-orchestrate.ts (resolveArtifactPath / memoryPathFor) build RELATIVE,
// agent-consumed paths from backtick templates and take no projectDir — the
// absolute, projectDir-keyed shape here is incompatible with them. They re-root
// via relativeRecordDir() threaded from the engine instead.

// The record-tree ROOT for a project: the per-intent record dir when an intent
// resolves, else the bare space record root (aidlc/spaces/<sp>/intents/). Every
// family helper below joins under this so the whole tree moves with the intent in
// lockstep. Stays total (never throws) so the hooks that call the family at
// module top on a pre-creation shell don't crash.
export function docsRoot(projectDir: string, intent?: string, space?: string): string {
  const resolved = resolveRecordDir(projectDir, intent, space);
  return resolved.dir ?? spaceRecordRoot(projectDir, resolved.space);
}

// The bare record-tree root (doctor's existence check, the init scaffolder's
// base dir).
export function docsDir(projectDir: string, intent?: string, space?: string): string {
  return docsRoot(projectDir, intent, space);
}

// `<root>/runtime-graph.json` — the compiled runtime graph.
export function runtimeGraphPath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), "runtime-graph.json");
}

// `<root>/.aidlc-hooks-health` — per-hook heartbeat + drop counters surfaced by
// `--doctor`.
export function hooksHealthDir(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-hooks-health");
}

// `<root>/.aidlc-recovery.md` — the validate-state breadcrumb the orchestrator
// reads on resume.
export function recoveryFilePath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-recovery.md");
}

// `<root>/.aidlc-plan.json` — `aidlc-graph resolve` output.
export function planFilePath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-plan.json");
}

// `<root>/.aidlc-stop-hook` — the Stop hook's durable no-progress guard counter
// directory.
export function stopHookDir(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-stop-hook");
}

// --- The turn-shape markers (the transcript-free conversational carve-out) ----
//
// The Stop hook's tier-3 conversational carve-out asks one question: "was the
// ending turn the human's last prompt answered with NO workflow-engine
// engagement?". On Claude and Codex the Stop payload carries `transcript_path`
// and the hook reads that question straight off the transcript. Kiro (IDE and
// CLI) and opencode deliver NO transcript and expose no per-turn history to a
// hook at all, so the carve-out was inert there: every purely conversational
// turn mid-stage fell through to the cap-bounded block and earned a spurious
// forwarding-loop nudge.
//
// These two mtime markers reconstruct the same predicate from the filesystem:
//
//   .aidlc-human-turn   — touched by the UserPromptSubmit mint, once per human
//                         prompt, alongside the HUMAN_TURN ledger event.
//   .aidlc-engine-touch — touched by aidlc-orchestrate on every ADVANCING
//                         invocation (`next` / `report` / `park`).
//
//   conversational  <=>  mtime(.aidlc-human-turn) > mtime(.aidlc-engine-touch)
//
// Why markers and not the audit ledger: `next` is read-only and emits NO audit
// event, so a ledger-only predicate is BLIND to the exact failure the forwarding
// loop exists to catch — a conductor that consulted the engine and then bailed
// mid-loop. The engine marker sees it.
//
// THE LOAD-BEARING SUBTLETY: the Stop hook consults the engine ITSELF (it runs
// `aidlc-orchestrate next` to learn whether work is pending). If that probe
// touched the engine marker, the engine mtime would ALWAYS be newer than the
// human mtime and the predicate would be false forever — the carve-out would
// look implemented and do nothing. The probe is therefore marked with
// STOP_HOOK_PROBE_ENV and the engine skips the touch when it sees it.
//
// Per-intent (under docsRoot), matching .aidlc-stop-hook/block-count.json — the
// markers describe one workflow's turn shape, so they travel with the intent.
// Already covered by the shipped `aidlc/spaces/*/intents/*/.aidlc-*` gitignore
// rule, so neither marker is ever committed.
export function humanTurnMarkerPath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-human-turn");
}
export function engineTouchMarkerPath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-engine-touch");
}

// The env marker that identifies the Stop hook's OWN read-only `next` probe.
// Set by aidlc-continue-workflow.ts on its spawn; read by aidlc-orchestrate.ts
// to suppress the engine touch. Without this the carve-out can never fire (see
// above).
export const STOP_HOOK_PROBE_ENV = "AIDLC_STOP_HOOK_PROBE";

// Touch a turn-shape marker. Only the mtime carries meaning, so the body is a
// timestamp purely as a debugging affordance. The CALL never throws: these
// markers are an advisory optimisation of the Stop hook's block decision, and a
// write failure must never block a human's turn nor fail an engine invocation.
//
// BUT A FAILED WRITE MUST NOT LEAVE A STALE MARKER BEHIND, because the two
// markers fail in OPPOSITE directions and only one of them is harmless:
//   - human marker missing  -> the predicate reads "no evidence" -> the stop is
//     blocked. Costs at most one spurious nudge. Safe.
//   - engine marker STALE   -> the human marker keeps advancing past it, so
//     EVERY subsequent engaged-then-bailed turn reads as conversational and is
//     released. A silent, persistent fail-OPEN in exactly the direction the
//     forwarding loop exists to catch.
// That second case is reachable: an engine run under sudo leaves the file
// root-owned, after which every user-mode writeFileSync fails EACCES while the
// stale file persists. So on any failure we DELETE the marker — a missing marker
// fails closed on the read side, and the unlink succeeds in the root-owned case
// because the containing directory stays user-writable. If even the unlink
// fails there is nothing further to do; the block cap remains the backstop.
function touchTurnMarker(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${isoTimestamp()}\n`, "utf-8");
  } catch {
    // Degrade to "no evidence" rather than leaving a stale mtime that would
    // silently relax the carve-out from here on. `recursive` so a directory
    // squatting on the path (an unlikely but possible way for the write to fail
    // while the path survives) is cleared too, not just a stale file.
    try {
      rmSync(path, { force: true, recursive: true });
    } catch {
      /* nothing left to try - the cap-bounded block is the backstop */
    }
  }
}

// NO WORKFLOW => NO MARKER. Both markers describe one workflow's turn shape, so
// with nothing created there is nothing to describe. This self-gate is load-bearing
// for more than tidiness: without it a marker write on a FRESH workspace would
// create the record tree as a side effect (touchTurnMarker mkdir -p's the parent,
// and docsRoot falls back to the bare space record root before creation), which
// would break the invariant that `aidlc-orchestrate next` is a PURE READ that
// creates nothing. Mirrors the mint hooks' own `existsSync(stateFilePath(...))`
// self-gate, so all four write sites agree.
function workflowIsCreated(projectDir: string, intent?: string, space?: string): boolean {
  try {
    return existsSync(stateFilePath(projectDir, intent, space));
  } catch {
    return false;
  }
}

// Record that a human just submitted a prompt. Called from the UserPromptSubmit
// seam of every harness: the core aidlc-record-human-turn.ts hook (Claude,
// opencode) and both Kiro adapters' inlined `record-human-turn` targets.
export function markHumanTurn(projectDir: string, intent?: string, space?: string): void {
  if (!workflowIsCreated(projectDir, intent, space)) return;
  touchTurnMarker(humanTurnMarkerPath(projectDir, intent, space));
}

// Record that the workflow engine was ADVANCED (not merely probed). Called from
// aidlc-orchestrate.ts's `next` / `report` / `park` entry points. A no-op in three
// cases: when STOP_HOOK_PROBE_ENV is set (the Stop hook's own probe — see above),
// for read-only utility routing (excluded at the call site), and before creation.
//
// KNOWN COVERAGE GAP — the marker sees LESS than the transcript predicate does.
// isEngineToolCall (below) counts as engagement any non-read-only aidlc-jump /
// aidlc-bolt / aidlc-swarm invocation and the mutating aidlc-state verbs
// (approve, advance, skip, set, …). NONE of those tools touch this marker: the
// only writers are orchestrate's three subcommands. So on a transcript-free
// harness a conductor that runs, say, `aidlc-jump` — mutating the stage pointer
// and emitting audit — and then ends its turn without consulting the engine
// reads as CONVERSATIONAL here, while the same turn BLOCKS on Claude/Codex where
// the transcript is parsed. Those turns were always nudged before the marker
// path existed, so this is a real (if narrow) relaxation on Kiro and opencode,
// not merely an unimplemented nicety.
//
// It is documented rather than closed deliberately: closing it means touching
// the marker from a seam all four tools cross (the audit-emission path, or
// writeStateFile), which widens the blast radius well past this carve-out. If
// that is ever done, delete this paragraph and the matching note in
// docs/reference/06-hooks-and-tools.md rather than leaving a stale promise of
// parity behind.
export function markEngineTouch(projectDir: string, intent?: string, space?: string): void {
  if (process.env[STOP_HOOK_PROBE_ENV] === "1") return;
  if (!workflowIsCreated(projectDir, intent, space)) return;
  touchTurnMarker(engineTouchMarkerPath(projectDir, intent, space));
}

// The transcript-free reading of "the ending turn was conversational": the last
// human prompt is NEWER than the last engine advance. FAIL-CLOSED on every miss
// — a missing marker (a pre-upgrade workspace, a workflow that has not yet
// advanced once since the markers shipped), an unreadable stat, or an engine
// touch at-or-after the human turn all return false, so the caller falls through
// to the cap-bounded block. It can only ever ALLOW a stop, never cause one to
// block, exactly like every other carve-out in the Stop hook.
export function turnMarkersShowConversational(
  projectDir: string,
  intent?: string,
  space?: string,
): boolean {
  try {
    const humanPath = humanTurnMarkerPath(projectDir, intent, space);
    const enginePath = engineTouchMarkerPath(projectDir, intent, space);
    // Both markers must be present AND be regular files. An absent engine
    // marker is NOT read as "the engine was never touched, therefore chat": it
    // is read as "no evidence", because that is also the shape of a fresh
    // install and of a wiped record dir. The isFile() check matters for the same
    // fail-closed reason: anything else squatting on the path (a directory, a
    // dangling symlink) would otherwise contribute a meaningless mtime to the
    // comparison, and on the engine side a meaningless-but-old mtime reads as
    // "chat" and releases the stop.
    const humanStat = statSync(humanPath, { throwIfNoEntry: false });
    const engineStat = statSync(enginePath, { throwIfNoEntry: false });
    if (!humanStat?.isFile() || !engineStat?.isFile()) return false;
    return humanStat.mtimeMs > engineStat.mtimeMs;
  } catch {
    return false; // unreadable markers: fall through to the cap
  }
}

// `<root>/.aidlc-reviewer-dispatch.json` — the per-unit reviewer dispatch
// record. The conductor writes it at stage-protocol-reviewer.md §12a step 1 (per-unit
// stages only) before invoking the reviewer sub-agent, and deletes it at step
// 3 the moment the verdict is read. The reviewer-scope PreToolUse hook reads
// it back to learn WHICH unit is under review and which contract paths are
// exempt — the two facts no harness payload carries. Lives under the intent's
// record root (the same transient family as .aidlc-stop-hook/), already
// covered by the shipped `aidlc/spaces/*/intents/*/.aidlc-*` gitignore rule.
export function reviewerDispatchPath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), ".aidlc-reviewer-dispatch.json");
}

// Freshness window for the reviewer dispatch record. The scope hook honours a
// record only while its mtime is younger than this; an older record is an
// orphan (a session that crashed between dispatch and verdict) and is ignored
// plus best-effort cleaned up — the same staleness discipline as the compose
// marker. 6h: the worst observed pre-fix review ran ~3h, so the window covers
// the pathological case with margin while still bounding a crashed review.
export const REVIEWER_DISPATCH_TTL_MS = 6 * 60 * 60 * 1000;

// `<projectDir>/aidlc/.aidlc-compose-pending`: the in-flight compose gate
// marker the conductor writes before presenting the approve/edit/reject gate
// and deletes on resolve. It lives at the WORKSPACE level (not a per-intent
// record) so a single spelling is shared by the Stop-hook carve-out (which
// honours it as a turn-stop signal) and the doctor probe (which flags an
// orphaned one). Hoisted here so the path is spelled once.
export function composeMarkerPath(projectDir: string): string {
  return join(projectDir, "aidlc", ".aidlc-compose-pending");
}

export const UNIT_SCOPE_FILE = ".aidlc-unit-scope.json";
export const UNIT_PARKED_FILE = ".aidlc-unit-parked";
export const CLAIM_GENERATIONS_FILE = ".aidlc-claim-generations.json";
export const UNIT_PARTICIPANT_FILE = ".aidlc-unit-participant";
export const CLAIM_REGISTRY_CACHE_FILE = ".aidlc-claim-registry.json";
export const UNIT_RELEASE_PENDING_FILE = ".aidlc-unit-releases";
export const UNIT_MERGE_DIR = ".aidlc-unit-merges";

export interface UnitScopeStamp {
  version: 1;
  space: string;
  intent_uuid: string;
  intent_id8: string;
  unit: string;
  owner: string;
  generation: number;
  nonce: string;
  claim_ref: string;
  claim_oid: string;
  claimed_from_oid: string;
  integration_ref: string;
  gate_rhythm: "per-stage" | "unit-end";
  audit_shard?: string;
}

export interface CachedUnitClaim {
  status: "claimed" | "released";
  owner: string;
  generation: number;
  nonce: string;
  ref: string;
  oid: string;
  observed_at?: string;
}

export interface UnitClaimRegistryCache {
  version: 1;
  space: string;
  intent_uuid: string;
  claims: Record<string, CachedUnitClaim>;
  warning?: string;
}

export interface UnitMergeEvidence {
  stages_expected: string[];
  stages_completed: string[];
  gates_expected: string[];
  gates_approved: string[];
  reviewers_expected: string[];
  reviewers_ready: string[];
  plan_fingerprint: string | null;
  artifact_paths: string[];
  audit_shards: string[];
  outside_unit_record_paths: string[];
  merge_held: boolean;
}

export interface UnitMergeTransaction {
  version: 1;
  status:
    | "pinned"
    | "approved"
    | "rejected"
    | "git-landed"
    | "state-folded"
    | "complete";
  space: string;
  intent_uuid: string;
  intent_id8: string;
  unit: string;
  owner: string;
  generation: number;
  nonce: string;
  claim_ref: string;
  pinned_oid: string;
  candidate_tree_oid: string;
  candidate_base_oid: string;
  integration_oid: string;
  integration_branch: string;
  main_before_oid: string;
  pinned_at: string;
  pin_id?: string;
  audit_shard?: string;
  evidence: UnitMergeEvidence;
  decision?: string;
  user_input?: string;
  target_branch?: string;
  strategy?: "merge";
  live_stage_columns?: string[];
  checkpoint_parent_oid?: string;
  checkpoint_commit_oid?: string;
  git_commit_oid?: string;
  conflict_files?: string[];
  released_after_git?: {
    accepted_at: string;
    user_input: string;
    tombstone_oid: string;
    tombstone_generation: number;
  };
  state_fold_authorized?: {
    authorized_at: string;
    mode: "live-claim" | "released-after-git";
    observed_oid: string;
    owner: string;
  };
}

export function unitScopePath(projectDir: string): string {
  return join(workspaceRoot(projectDir), UNIT_SCOPE_FILE);
}

export function unitParkedPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), UNIT_PARKED_FILE);
}

export function claimGenerationsPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), CLAIM_GENERATIONS_FILE);
}

export function unitParticipantPath(projectDir: string): string {
  return join(workspaceRoot(projectDir), UNIT_PARTICIPANT_FILE);
}

export function claimRegistryCachePath(projectDir: string): string {
  return join(workspaceRoot(projectDir), CLAIM_REGISTRY_CACHE_FILE);
}

function identityScopedUnitPath(
  projectDir: string,
  root: string,
  unit: string,
  space?: string,
  intentUuid?: string,
): string {
  const resolvedSpace = space ?? activeSpace(projectDir);
  const resolvedIntent = intentUuid ?? activeIntentUuid(projectDir, resolvedSpace);
  if (!resolvedIntent) {
    throw new Error("Cannot resolve the active intent for Unit recovery state.");
  }
  for (const [label, value] of [
    ["space", resolvedSpace],
    ["intent UUID", resolvedIntent],
    ["Unit", unit],
  ] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
      throw new Error(`Invalid ${label} path segment "${value}".`);
    }
  }
  return join(workspaceRoot(projectDir), root, resolvedSpace, resolvedIntent, `${unit}.json`);
}

export function unitReleasePendingPath(
  projectDir: string,
  unit: string,
  space?: string,
  intentUuid?: string,
): string {
  return identityScopedUnitPath(
    projectDir,
    UNIT_RELEASE_PENDING_FILE,
    unit,
    space,
    intentUuid,
  );
}

export function unitMergeTransactionPath(
  projectDir: string,
  unit: string,
  space?: string,
  intentUuid?: string,
): string {
  return identityScopedUnitPath(
    projectDir,
    UNIT_MERGE_DIR,
    unit,
    space,
    intentUuid,
  );
}

export function readUnitMergeTransaction(
  projectDir: string,
  unit: string,
  space?: string,
  intentUuid?: string,
): UnitMergeTransaction | null {
  try {
    const resolvedSpace = space ?? activeSpace(projectDir);
    const resolvedIntent = intentUuid ?? activeIntentUuid(projectDir, resolvedSpace);
    if (!resolvedIntent) return null;
    const parsed = JSON.parse(
      readFileSync(
        unitMergeTransactionPath(
          projectDir,
          unit,
          resolvedSpace,
          resolvedIntent,
        ),
        "utf-8",
      ),
    ) as UnitMergeTransaction;
    const oid = (value: unknown): value is string =>
      typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
    if (
      parsed.version !== 1 ||
      ![
        "pinned",
        "approved",
        "rejected",
        "git-landed",
        "state-folded",
        "complete",
      ].includes(parsed.status) ||
      typeof parsed.space !== "string" ||
      parsed.space !== resolvedSpace ||
      typeof parsed.intent_uuid !== "string" ||
      parsed.intent_uuid !== resolvedIntent ||
      typeof parsed.intent_id8 !== "string" ||
      typeof parsed.unit !== "string" ||
      parsed.unit !== unit ||
      typeof parsed.owner !== "string" ||
      !Number.isInteger(parsed.generation) ||
      parsed.generation < 1 ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.claim_ref !== "string" ||
      !parsed.claim_ref.endsWith(`/${unit}`) ||
      !oid(parsed.pinned_oid) ||
      !oid(parsed.candidate_tree_oid) ||
      !oid(parsed.candidate_base_oid) ||
      !oid(parsed.integration_oid) ||
      typeof parsed.integration_branch !== "string" ||
      !oid(parsed.main_before_oid) ||
      typeof parsed.pinned_at !== "string" ||
      (parsed.audit_shard !== undefined &&
        (typeof parsed.audit_shard !== "string" ||
          !/^[A-Za-z0-9._-]+\.md$/.test(parsed.audit_shard))) ||
      parsed.evidence === null ||
      typeof parsed.evidence !== "object" ||
      !Array.isArray(parsed.evidence.stages_expected) ||
      !Array.isArray(parsed.evidence.stages_completed) ||
      !Array.isArray(parsed.evidence.gates_expected) ||
      !Array.isArray(parsed.evidence.gates_approved) ||
      !Array.isArray(parsed.evidence.reviewers_expected) ||
      !Array.isArray(parsed.evidence.reviewers_ready) ||
      !Array.isArray(parsed.evidence.artifact_paths) ||
      !Array.isArray(parsed.evidence.audit_shards) ||
      !Array.isArray(parsed.evidence.outside_unit_record_paths) ||
      (parsed.live_stage_columns !== undefined &&
        !Array.isArray(parsed.live_stage_columns)) ||
      (parsed.checkpoint_parent_oid !== undefined &&
        !oid(parsed.checkpoint_parent_oid)) ||
      (parsed.checkpoint_commit_oid !== undefined &&
        !oid(parsed.checkpoint_commit_oid)) ||
      (parsed.git_commit_oid !== undefined && !oid(parsed.git_commit_oid))
      ||
      (
        parsed.released_after_git !== undefined &&
        (
          typeof parsed.released_after_git.accepted_at !== "string" ||
          typeof parsed.released_after_git.user_input !== "string" ||
          !oid(parsed.released_after_git.tombstone_oid) ||
          !Number.isInteger(
            parsed.released_after_git.tombstone_generation,
          ) ||
          parsed.released_after_git.tombstone_generation < 2
        )
      )
      ||
      (
        parsed.state_fold_authorized !== undefined &&
        (
          typeof parsed.state_fold_authorized.authorized_at !== "string" ||
          (
            parsed.state_fold_authorized.mode !== "live-claim" &&
            parsed.state_fold_authorized.mode !== "released-after-git"
          ) ||
          !oid(parsed.state_fold_authorized.observed_oid) ||
          typeof parsed.state_fold_authorized.owner !== "string" ||
          parsed.state_fold_authorized.owner.length === 0
        )
      )
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeUnitMergeTransaction(
  projectDir: string,
  transaction: UnitMergeTransaction,
): void {
  const path = unitMergeTransactionPath(
    projectDir,
    transaction.unit,
    transaction.space,
    transaction.intent_uuid,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, `${JSON.stringify(transaction, null, 2)}\n`);
}

export function unitMergeTransactionsForIdentity(
  projectDir: string,
  space: string,
  intentUuid: string,
): UnitMergeTransaction[] {
  const dir = join(
    workspaceRoot(projectDir),
    UNIT_MERGE_DIR,
    space,
    intentUuid,
  );
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort();
  } catch {
    return [];
  }
  const transactions: UnitMergeTransaction[] = [];
  for (const file of files) {
    const unit = file.slice(0, -".json".length);
    const transaction = readUnitMergeTransaction(
      projectDir,
      unit,
      space,
      intentUuid,
    );
    if (transaction) {
      transactions.push(transaction);
    }
  }
  return transactions;
}

export function unitMergeTransactions(
  projectDir: string,
): UnitMergeTransaction[] {
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space);
  return intentUuid
    ? unitMergeTransactionsForIdentity(projectDir, space, intentUuid)
    : [];
}

export function hasAnyUnitMergeTransactions(projectDir: string): boolean {
  return unitMergeTransactions(projectDir).length > 0;
}

export function readClaimGenerations(
  projectDir: string,
): Record<string, number> {
  try {
    const parsed = JSON.parse(
      readFileSync(claimGenerationsPath(projectDir), "utf-8"),
    ) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          Number.isInteger(entry[1]) && (entry[1] as number) > 0,
      ),
    );
  } catch {
    return {};
  }
}

function claimGenerationKey(projectDir: string, unit: string): string {
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space) ?? "legacy";
  return `${space}/${intentUuid}/${unit}`;
}

export function writeClaimGeneration(
  projectDir: string,
  unit: string,
  generation: number,
): void {
  const generations = readClaimGenerations(projectDir);
  generations[claimGenerationKey(projectDir, unit)] = generation;
  writeFileAtomic(
    claimGenerationsPath(projectDir),
    `${JSON.stringify(generations, null, 2)}\n`,
  );
}

export function clearClaimGeneration(projectDir: string, unit: string): void {
  const generations = readClaimGenerations(projectDir);
  delete generations[claimGenerationKey(projectDir, unit)];
  writeFileAtomic(
    claimGenerationsPath(projectDir),
    `${JSON.stringify(generations, null, 2)}\n`,
  );
}

export function readUnitClaimRegistryCache(
  projectDir: string,
): UnitClaimRegistryCache | null {
  try {
    const parsed = JSON.parse(
      readFileSync(claimRegistryCachePath(projectDir), "utf-8"),
    ) as Partial<UnitClaimRegistryCache>;
    if (
      parsed.version !== 1 ||
      typeof parsed.space !== "string" ||
      typeof parsed.intent_uuid !== "string" ||
      parsed.claims === null ||
      typeof parsed.claims !== "object" ||
      Array.isArray(parsed.claims)
    ) {
      return null;
    }
    const claims: Record<string, CachedUnitClaim> = {};
    for (const [unit, value] of Object.entries(parsed.claims)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const claim = value as Partial<CachedUnitClaim>;
      if (
        (claim.status !== "claimed" && claim.status !== "released") ||
        typeof claim.owner !== "string" ||
        !Number.isInteger(claim.generation) ||
        (claim.generation ?? 0) < 1 ||
        typeof claim.nonce !== "string" ||
        typeof claim.ref !== "string" ||
        typeof claim.oid !== "string" ||
        (
          claim.observed_at !== undefined &&
          typeof claim.observed_at !== "string"
        )
      ) {
        return null;
      }
      claims[unit] = claim as CachedUnitClaim;
    }
    return {
      version: 1,
      space: parsed.space,
      intent_uuid: parsed.intent_uuid,
      claims,
      ...(typeof parsed.warning === "string" && parsed.warning
        ? { warning: parsed.warning }
        : {}),
    };
  } catch {
    return null;
  }
}

export function writeUnitClaimRegistryCache(
  projectDir: string,
  cache: UnitClaimRegistryCache,
): void {
  writeFileAtomic(
    claimRegistryCachePath(projectDir),
    `${JSON.stringify(cache, null, 2)}\n`,
  );
}

interface ClaimRegistryPayload {
  status: "claimed" | "released";
  intent_uuid: string;
  unit: string;
  generation: number;
  nonce: string;
}

const LIVE_CLAIM_PAYLOADS = new Map<string, ClaimRegistryPayload | null>();

function claimRegistryGit(
  projectDir: string,
  args: string[],
  options: { localOnly?: boolean } = {},
): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf-8",
    env: options.localOnly
      ? { ...process.env, GIT_NO_LAZY_FETCH: "1" }
      : process.env,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function claimRegistryRemote(projectDir: string): string | null {
  const remoteResult = claimRegistryGit(projectDir, ["remote"]);
  if (!remoteResult.ok) {
    throw new Error(`Unit claim registry read failed: ${remoteResult.stderr.trim()}`);
  }
  const remotes = remoteResult.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 0) return null;
  if (remotes.length === 1) return remotes[0];
  throw new Error(
    `Unit claim registry read failed: multiple remotes (${remotes.join(", ")}) and no origin.`,
  );
}

function claimRegistryTips(
  projectDir: string,
  intentUuid: string,
): Array<{ oid: string; ref: string }> {
  const prefix = `refs/heads/claim/${idSuffix(intentUuid)}/`;
  const remote = claimRegistryRemote(projectDir);
  const found = remote
    ? claimRegistryGit(projectDir, ["ls-remote", remote, `${prefix}*`])
    : claimRegistryGit(
        projectDir,
        ["for-each-ref", "--format=%(objectname) %(refname)", prefix],
      );
  if (!found.ok) {
    throw new Error(
      `Unit claim registry read failed: ${found.stderr.trim() || found.stdout.trim()}`,
    );
  }
  return found.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
    .map(([oid, ref]) => ({ oid, ref }));
}

function claimPayloadAtTip(
  projectDir: string,
  intentUuid: string,
  tip: { oid: string; ref: string },
): ClaimRegistryPayload {
  const remote = claimRegistryRemote(projectDir);
  const localOnly = { localOnly: true };
  const hasCommit = (): boolean =>
    claimRegistryGit(
      projectDir,
      ["cat-file", "-e", `${tip.oid}^{commit}`],
      localOnly,
    ).ok;
  const payloadBlob = (): string | null => {
    const found = claimRegistryGit(
      projectDir,
      ["rev-parse", `${tip.oid}:.aidlc-unit-claim.json`],
      localOnly,
    );
    return found.ok && /^[0-9a-f]{40}$/.test(found.stdout.trim())
      ? found.stdout.trim()
      : null;
  };
  const hasBlob = (blob: string | null): boolean =>
    blob !== null &&
    claimRegistryGit(projectDir, ["cat-file", "-e", blob], localOnly).ok;
  let blob = payloadBlob();
  if ((!hasCommit() || !hasBlob(blob)) && remote) {
    const fetched = claimRegistryGit(
      projectDir,
      ["fetch", "--no-tags", "--no-filter", remote, tip.ref],
    );
    if (!fetched.ok) {
      throw new Error(
        `Unit claim registry fetch failed: ${fetched.stderr.trim()} ` +
          `(a partial clone requires a non-filtered fetch of ${tip.ref}).`,
      );
    }
    blob = payloadBlob();
  }
  if (blob && !hasBlob(blob) && remote) {
    const hydrated = claimRegistryGit(
      projectDir,
      ["fetch", "--no-tags", "--no-filter", remote, blob],
    );
    if (!hydrated.ok) {
      throw new Error(
        `Unit claim registry fetch failed: ${hydrated.stderr.trim()} ` +
          `(the partial clone is missing payload blob ${blob} for ${tip.ref}).`,
      );
    }
  }
  if (!hasCommit() || !hasBlob(blob)) {
    throw new Error(
      `Unit claim registry fetch failed: payload at ${tip.ref} is unavailable after a non-filtered fetch; ` +
        "the partial clone is missing the claim payload blob.",
    );
  }
  const shown = claimRegistryGit(
    projectDir,
    ["show", `${tip.oid}:.aidlc-unit-claim.json`],
    localOnly,
  );
  if (!shown.ok) {
    throw new Error(`Unit claim registry payload is unreadable at ${tip.ref}.`);
  }
  try {
    const payload = JSON.parse(shown.stdout) as Record<string, unknown>;
    if (
      (payload.status !== "claimed" && payload.status !== "released") ||
      payload.intent_uuid !== intentUuid ||
      typeof payload.unit !== "string" ||
      !Number.isInteger(payload.generation) ||
      (payload.generation as number) < 1 ||
      typeof payload.nonce !== "string"
    ) {
      throw new Error("invalid payload");
    }
    return payload as unknown as ClaimRegistryPayload;
  } catch {
    throw new Error(`Unit claim registry payload is invalid at ${tip.ref}.`);
  }
}

function liveClaimPayload(
  projectDir: string,
  unit: string,
): ClaimRegistryPayload | null {
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space);
  if (!intentUuid) return null;
  const cacheKey = `${canonicalPathKey(projectDir)}:${space}:${intentUuid}:${unit}`;
  if (LIVE_CLAIM_PAYLOADS.has(cacheKey)) {
    return LIVE_CLAIM_PAYLOADS.get(cacheKey) ?? null;
  }
  const ref = `refs/heads/claim/${idSuffix(intentUuid)}/${unit}`;
  const tip = claimRegistryTips(projectDir, intentUuid).find(
    (candidate) => candidate.ref === ref,
  );
  if (!tip) {
    LIVE_CLAIM_PAYLOADS.set(cacheKey, null);
    return null;
  }
  const payload = claimPayloadAtTip(projectDir, intentUuid, tip);
  if (payload.unit !== unit) {
    throw new Error(`Unit claim registry payload is invalid at ${ref}.`);
  }
  LIVE_CLAIM_PAYLOADS.set(cacheKey, payload);
  return payload;
}

export function invalidateLiveClaimPayloadCache(
  projectDir: string,
  unit?: string,
): void {
  const prefix = `${canonicalPathKey(projectDir)}:`;
  for (const key of LIVE_CLAIM_PAYLOADS.keys()) {
    if (
      key.startsWith(prefix) &&
      (unit === undefined || key.endsWith(`:${unit}`))
    ) {
      LIVE_CLAIM_PAYLOADS.delete(key);
    }
  }
}

export function hasAnyUnitClaimRefs(projectDir: string): boolean {
  const localOnly = { localOnly: true };
  if (!claimRegistryGit(projectDir, ["rev-parse", "--git-dir"], localOnly).ok) {
    return false;
  }
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space);
  if (!intentUuid) return false;
  const id8 = idSuffix(intentUuid);
  const local = claimRegistryGit(
    projectDir,
    [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/claim/",
      "refs/remotes/",
    ],
    localOnly,
  );
  if (!local.ok) return false;
  if (
    local.stdout
      .split(/\r?\n/)
      .some((ref) =>
        ref.startsWith(`refs/heads/claim/${id8}/`) ||
        new RegExp(`^refs/remotes/[^/]+/claim/${escapeRegex(id8)}/`).test(ref)
      )
  ) {
    return true;
  }
  const cache = readUnitClaimRegistryCache(projectDir);
  return !!cache &&
    cache.space === space &&
    cache.intent_uuid === intentUuid &&
    Object.keys(cache.claims).length > 0;
}

export function readUnitScopeStamp(projectDir: string): UnitScopeStamp | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(unitScopePath(projectDir), "utf-8"),
    );
    if (parsed === null || typeof parsed !== "object") return null;
    const stamp = parsed as Partial<UnitScopeStamp>;
    if (
      stamp.version !== 1 ||
      typeof stamp.space !== "string" ||
      typeof stamp.intent_uuid !== "string" ||
      typeof stamp.intent_id8 !== "string" ||
      typeof stamp.unit !== "string" ||
      typeof stamp.owner !== "string" ||
      !Number.isInteger(stamp.generation) ||
      (stamp.generation ?? 0) < 1 ||
      typeof stamp.nonce !== "string" ||
      typeof stamp.claim_ref !== "string" ||
      typeof stamp.claim_oid !== "string" ||
      typeof stamp.claimed_from_oid !== "string" ||
      typeof stamp.integration_ref !== "string" ||
      (stamp.gate_rhythm !== "per-stage" && stamp.gate_rhythm !== "unit-end") ||
      (stamp.audit_shard !== undefined &&
        (typeof stamp.audit_shard !== "string" ||
          !/^[A-Za-z0-9._-]+\.md$/.test(stamp.audit_shard)))
    ) {
      return null;
    }
    return stamp as UnitScopeStamp;
  } catch {
    return null;
  }
}

export function writeUnitScopeStamp(
  projectDir: string,
  stamp: UnitScopeStamp,
): void {
  writeFileAtomic(
    unitScopePath(projectDir),
    `${JSON.stringify(stamp, null, 2)}\n`,
  );
}

export function clearUnitScopeStamp(projectDir: string): void {
  try {
    unlinkSync(unitScopePath(projectDir));
  } catch {
    // Already absent.
  }
}

function applicableTeamUnitScopeStamp(
  projectDir: string,
  stateContent?: string,
): UnitScopeStamp | null {
  let state = stateContent;
  try {
    state ??= readStateFile(projectDir);
  } catch {
    return null;
  }
  if (!isTeamUnitOwnership(state)) return null;
  const stamp = readUnitScopeStamp(projectDir);
  if (!stamp) return null;
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space);
  if (
    !intentUuid ||
    stamp.space !== space ||
    stamp.intent_uuid !== intentUuid
  ) {
    return null;
  }
  return stamp;
}

export function readApplicableTeamUnitScopeStamp(
  projectDir: string,
  stateContent?: string,
): UnitScopeStamp | null {
  return applicableTeamUnitScopeStamp(projectDir, stateContent);
}

export function worktreeClaimBoundaryMatches(
  projectDir: string,
  worktreeDir: string,
  unit: string,
): UnitScopeStamp | null {
  const main = applicableTeamUnitScopeStamp(projectDir);
  const forked = applicableTeamUnitScopeStamp(worktreeDir);
  if (
    !main ||
    !forked ||
    main.unit !== unit ||
    forked.unit !== unit ||
    main.intent_uuid !== forked.intent_uuid ||
    main.generation !== forked.generation ||
    main.nonce !== forked.nonce ||
    main.claim_oid !== forked.claim_oid
  ) {
    return null;
  }
  return main;
}

function cachedClaimFanoutActive(projectDir: string): boolean {
  const cache = readUnitClaimRegistryCache(projectDir);
  const space = activeSpace(projectDir);
  const intentUuid = activeIntentUuid(projectDir, space);
  if (!intentUuid) return false;
  if (
    cache &&
    cache.space === space &&
    cache.intent_uuid === intentUuid &&
    Object.values(cache.claims).some((claim) => claim.status === "claimed")
  ) {
    return true;
  }
  const id8 = idSuffix(intentUuid);
  const refs = claimRegistryGit(projectDir, [
    "for-each-ref",
    "--format=%(objectname) %(refname)",
    "refs/heads/claim/",
    "refs/remotes/",
  ], { localOnly: true });
  if (!refs.ok) return false;
  for (const line of refs.stdout.split(/\r?\n/).filter(Boolean)) {
    const [oid, ref] = line.trim().split(/\s+/, 2);
    if (
      !oid ||
      !ref ||
      (
        !ref.startsWith(`refs/heads/claim/${id8}/`) &&
        !new RegExp(`^refs/remotes/[^/]+/claim/${escapeRegex(id8)}/`).test(ref)
      )
    ) {
      continue;
    }
    const shown = claimRegistryGit(
      projectDir,
      ["show", `${oid}:.aidlc-unit-claim.json`],
      { localOnly: true },
    );
    if (!shown.ok) continue;
    try {
      const payload = JSON.parse(shown.stdout) as Record<string, unknown>;
      if (
        payload.intent_uuid === intentUuid &&
        payload.status === "claimed"
      ) {
        return true;
      }
    } catch {
      // Malformed local claim refs are handled by notice composition.
    }
  }
  return false;
}

export function validateLiveUnitScope(
  projectDir: string,
  requestedUnit?: string,
): UnitScopeStamp | null {
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (!isTeamUnitOwnership(state)) return null;
  const stamp = applicableTeamUnitScopeStamp(pd, state);
  if (!stamp) {
    if (cachedClaimFanoutActive(pd)) {
      throw new Error(
        "Team Unit fan-out is active in an unscoped checkout; claim a Unit before lifecycle or report work.",
      );
    }
    return null;
  }
  if (requestedUnit && requestedUnit !== stamp.unit) {
    throw new Error(
      `This checkout is scoped to Unit "${stamp.unit}"; refusing foreign Unit "${requestedUnit}".`,
    );
  }
  return stamp;
}

export function isWalkingSkeletonUnitOnMain(
  projectDir: string,
  unit: string,
): boolean {
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd);
  if (
    !isTeamUnitOwnership(state) ||
    applicableTeamUnitScopeStamp(pd, state)
  ) {
    return false;
  }
  const scope = getField(state, "Scope") ?? "";
  if (loadScopeMetadata()[scope]?.skeleton !== true) return false;
  const dag = resolveBoltDag(pd);
  if (dag.state !== "ok" || dag.batches[0]?.[0] !== unit) return false;
  const top = claimRegistryGit(
    pd,
    ["rev-parse", "--show-toplevel"],
    { localOnly: true },
  );
  const common = claimRegistryGit(
    pd,
    ["rev-parse", "--git-common-dir"],
    { localOnly: true },
  );
  if (!top.ok || !common.ok) return false;
  try {
    const topReal = realpathSync(top.stdout.trim());
    const commonAbs = resolvePath(topReal, common.stdout.trim());
    return topReal === realpathSync(dirname(commonAbs));
  } catch {
    return false;
  }
}

const CLAIM_BOUNDARY_WARNINGS = new Set<string>();

function warnOfflineClaimBoundaryOnce(
  projectDir: string,
  unit: string,
  message: string,
): void {
  const key = `${canonicalPathKey(projectDir)}:${unit}:${message}`;
  if (CLAIM_BOUNDARY_WARNINGS.has(key)) return;
  CLAIM_BOUNDARY_WARNINGS.add(key);
  process.stderr.write(
    `[aidlc] warning: Unit "${unit}" claim registry is unavailable (${message}); ` +
      "proceeding from the checkout stamp for this claim-sensitive boundary.\n",
  );
}

export function requireLiveClaimForTeamUnit(
  projectDir: string,
  unit: string,
  selector: {
    intent?: string;
    space?: string;
    walkingSkeletonMain?: boolean;
  } = {},
): UnitScopeStamp | null {
  const pd = resolveProjectDir(projectDir);
  const state = readStateFile(pd, selector.intent, selector.space);
  if (!isTeamUnitOwnership(state)) return null;
  if (
    selector.walkingSkeletonMain &&
    isWalkingSkeletonUnitOnMain(pd, unit)
  ) {
    return null;
  }
  const stamp = applicableTeamUnitScopeStamp(pd, state);
  if (!stamp) {
    throw new Error(
      `Unit Ownership: team requires a live claim for Unit "${unit}" before fork or lifecycle work.`,
    );
  }
  if (selector.space && selector.space !== stamp.space) {
    throw new Error(
      `Claimed Unit "${stamp.unit}" belongs to space "${stamp.space}", not "${selector.space}".`,
    );
  }
  if (
    selector.intent &&
    selector.intent !== stamp.intent_uuid &&
    !selector.intent.endsWith(stamp.intent_id8)
  ) {
    throw new Error(
      `Claimed Unit "${stamp.unit}" belongs to intent "${stamp.intent_uuid}", not "${selector.intent}".`,
    );
  }
  validateLiveUnitScope(pd, unit);
  try {
    invalidateLiveClaimPayloadCache(pd, stamp.unit);
    const current = liveClaimPayload(pd, stamp.unit);
    if (
      current?.status !== "claimed" ||
      current.intent_uuid !== stamp.intent_uuid ||
      current.unit !== stamp.unit ||
      current.generation !== stamp.generation ||
      current.nonce !== stamp.nonce
    ) {
      throw new Error(
        `The Unit "${stamp.unit}" claim attempt is stale or released; re-claim before continuing.`,
      );
    }
  } catch (error) {
    const message = errorMessage(error);
    if (
      message.startsWith("Unit claim registry read failed:") ||
      message.startsWith("Unit claim registry fetch failed:")
    ) {
      warnOfflineClaimBoundaryOnce(pd, unit, message);
    } else {
      throw error;
    }
  }
  return stamp;
}

export function claimAttemptFields(
  projectDir: string,
  unit?: string,
): Record<string, string> {
  const stamp = applicableTeamUnitScopeStamp(projectDir);
  if (!stamp || (unit !== undefined && stamp.unit !== unit)) return {};
  return { "Attempt Generation": String(stamp.generation) };
}

export function eventMatchesClaimAttempt(
  projectDir: string,
  block: string,
  unit?: string,
): boolean {
  let state: string;
  try {
    state = readStateFile(projectDir);
  } catch {
    return true;
  }
  if (!isTeamUnitOwnership(state)) return true;
  const stamp = applicableTeamUnitScopeStamp(projectDir, state);
  if (!stamp) {
    if (!unit) return true;
    const eventGeneration = auditBlockField(block, "Attempt Generation");
    if (eventGeneration === null) return true;
    const generation =
      readClaimGenerations(projectDir)[claimGenerationKey(projectDir, unit)];
    return generation === undefined
      ? true
      : eventGeneration === String(generation);
  }
  const eventUnit = auditBlockField(block, "Unit");
  if (unit !== undefined && unit !== stamp.unit) return false;
  if (eventUnit !== null && eventUnit !== stamp.unit) return false;
  return (
    auditBlockField(block, "Attempt Generation") === String(stamp.generation)
  );
}

export function unitMergedReceipts(
  projectDir: string,
  auditRows?: readonly AuditShardEvent[],
): Set<string> {
  const rows = auditRows ?? readAuditShardEvents(projectDir);
  const merged = new Set<string>();
  for (const row of rows) {
    if (row.event !== "UNIT_MERGED") continue;
    const unit = auditBlockField(row.block, "Unit");
    if (!unit || !eventMatchesClaimAttempt(projectDir, row.block, unit)) continue;
    merged.add(unit);
  }
  return merged;
}

export function effectiveUnitGateRhythm(
  projectDir: string,
  stateContent: string,
): UnitGateRhythm {
  return applicableTeamUnitScopeStamp(projectDir, stateContent)?.gate_rhythm ??
    readUnitGateRhythm(stateContent);
}

// Freshness window for the compose marker. The Stop hook honours the carve-out
// only while the marker's mtime is younger than this; an older marker is an
// orphan (a session that crashed between write and gate-resolve) and is ignored
// plus best-effort cleaned up, so it cannot silently disable forwarding-loop
// enforcement forever. 24h is generous enough to cover a long human pause at an
// open gate while still catching a stranded marker.
export const COMPOSE_MARKER_TTL_MS = 24 * 60 * 60 * 1000;

// `<projectDir>/aidlc/.aidlc-subagent-inflight`: the workspace-level background
// dispatch ledger. Entries are session-scoped and reference-counted so
// overlapping workers cannot clear or authorize each other. The file remains
// workspace-level because dispatch and completion hooks can run outside an
// intent record, while each entry carries the session identity needed by Stop.
export function subagentInflightMarkerPath(projectDir: string): string {
  return join(projectDir, "aidlc", ".aidlc-subagent-inflight");
}

// Freshness window for each background-subagent entry. The Stop hook honours
// only matching fresh entries; older entries are orphaned dispatches and are
// pruned under the workspace lock. 2h covers long-running agents while bounding
// how long a crashed dispatch can relax forwarding-loop enforcement.
export const SUBAGENT_INFLIGHT_TTL_MS = 2 * 60 * 60 * 1000;

interface SubagentInflightEntry {
  sessionId: string | null;
  startedAtMs: number;
}

interface SubagentInflightLedger {
  version: 1;
  entries: SubagentInflightEntry[];
}

interface SubagentInflightRead {
  exists: boolean;
  malformed: boolean;
  entries: SubagentInflightEntry[];
}

export interface SubagentInflightSummary {
  exists: boolean;
  malformed: boolean;
  freshCount: number;
  staleCount: number;
  oldestAgeMs: number | null;
}

export interface SubagentInflightMatch {
  active: boolean;
  staleRemoved: number;
  malformed: boolean;
  invalidSession: boolean;
}

function subagentSessionIdentity(
  sessionId: unknown,
): { valid: true; sessionId: string | null } | { valid: false } {
  if (sessionId === undefined || sessionId === "") {
    return { valid: true, sessionId: null };
  }
  if (typeof sessionId !== "string") return { valid: false };
  const valid = validSessionId(sessionId);
  return valid ? { valid: true, sessionId: valid } : { valid: false };
}

function readSubagentInflightLedger(projectDir: string): SubagentInflightRead {
  const path = subagentInflightMarkerPath(projectDir);
  if (!existsSync(path)) return { exists: false, malformed: false, entries: [] };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object") {
      return { exists: true, malformed: true, entries: [] };
    }
    const candidate = parsed as Partial<SubagentInflightLedger>;
    if (candidate.version !== 1 || !Array.isArray(candidate.entries)) {
      return { exists: true, malformed: true, entries: [] };
    }
    const entries: SubagentInflightEntry[] = [];
    for (const value of candidate.entries) {
      if (value === null || typeof value !== "object") {
        return { exists: true, malformed: true, entries: [] };
      }
      const entry = value as Partial<SubagentInflightEntry>;
      const validIdentity =
        entry.sessionId === null ||
        (typeof entry.sessionId === "string" &&
          validSessionId(entry.sessionId) === entry.sessionId);
      if (
        !validIdentity ||
        typeof entry.startedAtMs !== "number" ||
        !Number.isFinite(entry.startedAtMs) ||
        entry.startedAtMs <= 0
      ) {
        return { exists: true, malformed: true, entries: [] };
      }
      entries.push({
        sessionId: entry.sessionId ?? null,
        startedAtMs: entry.startedAtMs,
      });
    }
    return { exists: true, malformed: false, entries };
  } catch {
    return existsSync(path)
      ? { exists: true, malformed: true, entries: [] }
      : { exists: false, malformed: false, entries: [] };
  }
}

function writeSubagentInflightLedger(
  projectDir: string,
  entries: SubagentInflightEntry[],
): void {
  const path = subagentInflightMarkerPath(projectDir);
  if (entries.length === 0) {
    try {
      unlinkSync(path);
    } catch {
      // Already absent or unreadable: callers retain fail-closed behavior.
    }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const ledger: SubagentInflightLedger = { version: 1, entries };
  writeFileAtomic(path, `${JSON.stringify(ledger)}\n`);
}

function freshSubagentEntries(
  entries: SubagentInflightEntry[],
  nowMs: number,
): SubagentInflightEntry[] {
  return entries.filter(
    (entry) => nowMs - entry.startedAtMs <= SUBAGENT_INFLIGHT_TTL_MS,
  );
}

export function markSubagentInflight(
  projectDir: string,
  sessionId?: unknown,
): boolean {
  const identity = subagentSessionIdentity(sessionId);
  if (!identity.valid) return false;
  return withAuditLock(projectDir, () => {
    const current = readSubagentInflightLedger(projectDir);
    if (current.malformed) {
      throw new Error(
        "background-subagent in-flight ledger is malformed; remove aidlc/.aidlc-subagent-inflight",
      );
    }
    const nowMs = Date.now();
    const entries = freshSubagentEntries(current.entries, nowMs);
    entries.push({ sessionId: identity.sessionId, startedAtMs: nowMs });
    writeSubagentInflightLedger(projectDir, entries);
    return true;
  });
}

export function completeSubagentInflight(
  projectDir: string,
  sessionId?: unknown,
): boolean {
  const identity = subagentSessionIdentity(sessionId);
  if (!identity.valid) return false;
  return withAuditLock(projectDir, () => {
    const current = readSubagentInflightLedger(projectDir);
    if (!current.exists) return false;
    if (current.malformed) {
      throw new Error(
        "background-subagent in-flight ledger is malformed; remove aidlc/.aidlc-subagent-inflight",
      );
    }
    const entries = freshSubagentEntries(current.entries, Date.now());
    const index = entries.findIndex(
      (entry) => entry.sessionId === identity.sessionId,
    );
    if (index >= 0) entries.splice(index, 1);
    writeSubagentInflightLedger(projectDir, entries);
    return index >= 0;
  });
}

export function matchSubagentInflight(
  projectDir: string,
  sessionId?: unknown,
): SubagentInflightMatch {
  const identity = subagentSessionIdentity(sessionId);
  if (!identity.valid) {
    return {
      active: false,
      staleRemoved: 0,
      malformed: false,
      invalidSession: true,
    };
  }
  return withAuditLock(projectDir, () => {
    const current = readSubagentInflightLedger(projectDir);
    if (!current.exists) {
      return {
        active: false,
        staleRemoved: 0,
        malformed: false,
        invalidSession: false,
      };
    }
    if (current.malformed) {
      return {
        active: false,
        staleRemoved: 0,
        malformed: true,
        invalidSession: false,
      };
    }
    const entries = freshSubagentEntries(current.entries, Date.now());
    const staleRemoved = current.entries.length - entries.length;
    if (staleRemoved > 0) writeSubagentInflightLedger(projectDir, entries);
    return {
      active: entries.some(
        (entry) => entry.sessionId === identity.sessionId,
      ),
      staleRemoved,
      malformed: false,
      invalidSession: false,
    };
  });
}

export function inspectSubagentInflight(
  projectDir: string,
): SubagentInflightSummary {
  const current = readSubagentInflightLedger(projectDir);
  if (!current.exists || current.malformed) {
    return {
      exists: current.exists,
      malformed: current.malformed,
      freshCount: 0,
      staleCount: 0,
      oldestAgeMs: null,
    };
  }
  const nowMs = Date.now();
  let freshCount = 0;
  let staleCount = 0;
  let oldestAgeMs: number | null = null;
  for (const entry of current.entries) {
    const ageMs = Math.max(0, nowMs - entry.startedAtMs);
    oldestAgeMs = Math.max(oldestAgeMs ?? 0, ageMs);
    if (ageMs <= SUBAGENT_INFLIGHT_TTL_MS) freshCount++;
    else staleCount++;
  }
  return {
    exists: true,
    malformed: false,
    freshCount,
    staleCount,
    oldestAgeMs,
  };
}

// `<baseDir>/.aidlc-sensors` — the sensor detail-output / tsbuildinfo directory.
// `baseDir` is the project dir for current dispatcher and type-check callers;
// callers append a stage slug as needed. Before 2.6.94, type-check passed a
// tsconfig directory instead, creating legacy package-local record trees. With
// no explicit intent/space, `docsRoot` follows the active-intent cursor (or lone
// record) when one resolves, so caches and failure details share the manifest's
// per-intent location; only pre-intent does it fall back to the flat space root.
export function sensorsDir(baseDir: string, intent?: string, space?: string): string {
  if (intent === undefined && space === undefined) {
    return join(docsRoot(baseDir), ".aidlc-sensors");
  }
  return join(docsRoot(baseDir, intent, space), ".aidlc-sensors");
}

// `<root>/<phase>/<slug>` — a stage's per-run artifact directory (the Stop hook
// scans it for unanswered question files).
export function stageDir(projectDir: string, phase: string, slug: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), phase, slug);
}

// Relative diary path recorded on a runtime-graph row — forward slashes
// regardless of host OS so the schema stays portable across worktrees. Mirrors
// the engine's memoryPathFor. `recordPrefix` is the relative per-intent record
// dir (relativeRecordDir) when one resolves, else null → the bare space record
// prefix (relativeSpaceRecordPrefix). Kept here so the prefix decision funnels
// with the rest of the family.
export function relativeMemoryPath(phase: string, stageSlug: string, recordPrefix?: string | null): string {
  const prefix = recordPrefix ?? relativeSpaceRecordPrefix();
  return `${prefix}/${phase}/${stageSlug}/memory.md`;
}

// `<root>/<phase>/<stageSlug>/memory.md` — the absolute diary path for a stage.
export function memoryFilePath(projectDir: string, phase: string, stageSlug: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), phase, stageSlug, "memory.md");
}

// `<root>/inception/units-generation/unit-of-work-dependency.md` — the fenced
// edge block the Bolt-DAG node is computed from.
export function unitDependencyPath(projectDir: string, intent?: string, space?: string): string {
  return join(docsRoot(projectDir, intent, space), "inception", "units-generation", "unit-of-work-dependency.md");
}

// --- Per-worktree mirror copies -----------------------------------------------
//
// A Bolt worktree is a git worktree of the project, so it carries its OWN mirror
// of the record tree at the SAME relative layout as the main checkout: the
// per-intent record dir (aidlc/spaces/<sp>/intents/<slug>-<id8>/) when the Bolt
// forks from an intent, else the bare space record root. These take an
// ALREADY-RESOLVED worktree base dir (the output of worktreePath, or an
// audit-recorded path), not projectDir, plus an optional `recordPrefix` — the
// RELATIVE per-intent record dir (relativeRecordDir) the fork inherited from the
// main intent. When omitted (a caller without intent context yet), the prefix
// falls back to the bare space record root (relativeSpaceRecordPrefix). Fork and
// merge MUST pass the SAME prefix or they read the wrong mirror file.

function worktreeRecordRoot(wtPath: string, recordPrefix?: string | null): string {
  const prefix = recordPrefix ?? relativeSpaceRecordPrefix();
  // recordPrefix is a posix-relative path (forward slashes); split so join
  // produces native separators under wtPath.
  return join(wtPath, ...prefix.split("/"));
}

export function worktreeDocsDir(wtPath: string, recordPrefix?: string | null): string {
  return worktreeRecordRoot(wtPath, recordPrefix);
}

export function worktreeStateFilePath(wtPath: string, recordPrefix?: string | null): string {
  return join(worktreeRecordRoot(wtPath, recordPrefix), "aidlc-state.md");
}

export function worktreeAuditFilePath(wtPath: string, recordPrefix?: string | null, projectDir?: string): string {
  // A worktree clone writes its own audit shard inside the worktree mirror.
  // The shard name embeds the MAIN clone's stable token (projectDir), NOT the
  // worktree's own — the fork and merge subprocesses are both spawned from the
  // main checkout, so threading the main clone-id makes them resolve the SAME
  // worktree shard across the two PIDs. A git worktree is a separate working dir
  // and would otherwise mint its own (ungitignored, untracked) clone-id, so the
  // token MUST come from the main checkout. Fall back to wtPath only when no
  // projectDir is threaded (legacy callers without main context).
  return join(worktreeRecordRoot(wtPath, recordPrefix), "audit", auditShardName(projectDir ?? wtPath));
}

export function worktreeRuntimeGraphPath(wtPath: string, recordPrefix?: string | null): string {
  return join(worktreeRecordRoot(wtPath, recordPrefix), "runtime-graph.json");
}

// Bolt slug shape: lowercase letter, then lowercase letters / digits / hyphens.
// Centralised here (previously duplicated as SLUG_RE in aidlc-worktree.ts and
// SLUG_REGEX in aidlc-audit.ts) so a future tightening lands once. Stage and
// artifact slugs in stage-schema.ts are a separate domain and keep their own
// regex.
export const BOLT_SLUG_REGEX = /^[a-z][a-z0-9-]*$/;
export const BOLT_SLUG_MAX_LENGTH = 64;
// New workflows author lowercase kebab-case names, but pre-lifecycle DAGs
// accepted other filesystem-safe names. Keep those existing identifiers
// routable while still excluding separators, traversal, whitespace, and
// control characters.
export const UNIT_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const UNIT_NAME_MAX_LENGTH = 64;

// --- Error helpers (catch-block discipline) ---
//
// TypeScript 4.4+ types `catch (e)` as `unknown` under --useUnknownInCatchVariables.
// These two helpers replace the old `e as Error` pattern in throw-sites and
// log-sites uniformly. Use:
//
//   try { ... } catch (e) {
//     throw new Error(`failed: ${errorMessage(e)}`);
//   }
//
// Both helpers are total (never throw) and stable on any thrown value
// — string throws, plain objects, Error instances, primitives.

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === "string") {
    return e;
  }
  // TS 4.9+ narrows `e.message` to `unknown` after the `in` check — no cast needed.
  if (typeof e === "object" && e !== null && "message" in e) {
    const msg: unknown = e.message;
    return typeof msg === "string" ? msg : String(msg);
  }
  return String(e);
}

export function errorStack(e: unknown): string | undefined {
  if (e instanceof Error) {
    return e.stack;
  }
  if (typeof e === "object" && e !== null && "stack" in e) {
    const stack: unknown = e.stack;
    return typeof stack === "string" ? stack : undefined;
  }
  return undefined;
}

// --- JSON.parse type guards ---
//
// JSON.parse returns `any` (TypeScript design choice). These guards narrow
// `unknown` to a concrete shape so consumers don't need property-access
// casts. Each guard is structural and total — it returns false for malformed
// input rather than throwing, so callers can decide how to fail.

/**
 * Generic "is plain object" predicate. After this guard, the value is typed
 * `Record<string, unknown>` so caller can do `if ("x" in v) { v.x ... }`
 * with TS narrowing carrying through.
 */
export function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Minimal package.json shape. Only fields the framework reads are listed —
 * the type-coverage layer needs declared shapes for JSON.parse outputs to
 * count as typed.
 */
export interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  main?: string;
  module?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/** Type guard for package.json. Permissive — accepts any plain object. */
export function isPackageJson(x: unknown): x is PackageJson {
  return isPlainObject(x);
}

/**
 * Claude Code hook event payload. Hooks receive JSON on stdin with a
 * shape that varies by event type. Fields below are the union of what
 * the framework's hooks actually read — see
 * https://docs.anthropic.com/en/docs/claude-code/hooks for the canonical
 * reference. All fields are optional because the hook code defensively
 * coalesces with `?? ""`.
 */
export interface ClaudeCodeHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    command?: string;
    status?: string;
    activeForm?: string;
    [key: string]: unknown;
  };
  reason?: string;
  source?: string;
  session_id?: string;
  prompt?: string;
  agent_type?: string;
  agent_id?: string;
  last_assistant_message?: string;
  [key: string]: unknown;
}

/** Type guard for Claude Code hook input JSON. */
export function isClaudeCodeHookInput(x: unknown): x is ClaudeCodeHookInput {
  return isPlainObject(x);
}

// --- Map / collection access helpers ---
//
// Replace Map.get(k)! / Array.pop()! / Array.shift()! patterns where the
// caller has algorithmic certainty the value exists. Throws on nullish
// instead of leaving a runtime undefined to leak silently — strictly
// safer than the bang assertion.

/** Get a Map value that the algorithm guarantees is set. Throws if absent. */
export function mustGet<K, V>(m: Map<K, V>, k: K, ctx: string): V {
  const v = m.get(k);
  if (v === undefined) {
    throw new Error(`Internal: mustGet(${ctx}) returned undefined; map invariant violated`);
  }
  return v;
}

/** Pop from an array the caller guarantees is non-empty. Throws if empty. */
export function mustPop<T>(arr: T[], ctx: string): T {
  const v = arr.pop();
  if (v === undefined) {
    throw new Error(`Internal: mustPop(${ctx}) on empty array`);
  }
  return v;
}

/** Shift from an array the caller guarantees is non-empty. Throws if empty. */
export function mustShift<T>(arr: T[], ctx: string): T {
  const v = arr.shift();
  if (v === undefined) {
    throw new Error(`Internal: mustShift(${ctx}) on empty array`);
  }
  return v;
}

// Validate a Bolt slug against shape + length. Returns null on success or a
// human-readable error string on failure. Pure — callers route through their
// preferred error mechanism (jsonError, throw, etc.).
export function validateBoltSlug(slug: string): string | null {
  if (!slug) {
    return "Bolt slug is empty";
  }
  if (slug.length > BOLT_SLUG_MAX_LENGTH) {
    return `Bolt slug "${slug.slice(0, 32)}..." is ${slug.length} chars; max is ${BOLT_SLUG_MAX_LENGTH}`;
  }
  if (!BOLT_SLUG_REGEX.test(slug)) {
    return `Invalid Bolt slug "${slug}" — must match ${BOLT_SLUG_REGEX} (lowercase letter, then lowercase letters/digits/hyphens)`;
  }
  return null;
}

// Unit names become path components under construction/<unit>/ and are also
// mirrored into single-line state fields. Keep one canonical validator for the
// authored DAG, cached runtime graph, and lifecycle CLI. Lowercase kebab-case is
// the authoring convention; leading digits, uppercase letters, underscores,
// and dots remain accepted for safe legacy DAG names.
export function validateUnitName(name: string): string | null {
  if (!name) return "Unit name is empty";
  if (name.length > UNIT_NAME_MAX_LENGTH) {
    return `Unit name "${name.slice(0, 32)}..." is ${name.length} chars; max is ${UNIT_NAME_MAX_LENGTH}`;
  }
  if (!UNIT_NAME_REGEX.test(name)) {
    return (
      `Invalid Unit name "${name}" - must match ${UNIT_NAME_REGEX} ` +
      "(ASCII letter/digit, then ASCII letters/digits/dot/underscore/hyphen)"
    );
  }
  return null;
}

// The autonomous swarm composes Bolt/worktree primitives whose slug contract is
// deliberately narrower than the legacy Unit-name contract. Preserve modern
// lowercase kebab names byte-for-byte; map any other safe legacy Unit name to a
// deterministic, readable, collision-resistant internal slug. The original
// Unit name remains the user/audit identity.
export function boltSlugForUnit(name: string): string {
  const unitNameError = validateUnitName(name);
  if (unitNameError) throw new Error(unitNameError);
  if (validateBoltSlug(name) === null) return name;

  const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
  let stem = name
    .toLowerCase()
    .replace(/[._]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(stem)) stem = `unit-${stem}`;
  stem = stem.slice(0, BOLT_SLUG_MAX_LENGTH - digest.length - 1).replace(/-+$/g, "");
  return `${stem}-${digest}`;
}

export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function hasUnsafeSingleLineCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return true;
    }
  }
	return false;
}

export function authoritativeProjectDescription(raw: string): {
  description: string;
  pastedDocumentPresent: boolean;
  error?: string;
} {
  const open = "<document>";
  const close = "</document>";
  const start = raw.indexOf(open);
  const strayClose = raw.indexOf(close);
  if (start < 0) {
    if (strayClose >= 0) {
      return {
        description: "",
        pastedDocumentPresent: false,
        error: `project description has ${close} without a matching ${open}`,
      };
    }
    return {
      description: raw.trim(),
      pastedDocumentPresent: false,
    };
  }
  if (strayClose >= 0 && strayClose < start) {
    return {
      description: "",
      pastedDocumentPresent: false,
      error: `project description has ${close} before the next ${open}`,
    };
  }

  const end = raw.indexOf(close, start + open.length);
  if (end < 0) {
    return {
      description: "",
      pastedDocumentPresent: false,
      error: `project description has ${open} without a matching ${close}`,
    };
  }
  const nested = raw.indexOf(open, start + open.length);
  if (nested >= 0 && nested < end) {
    return {
      description: "",
      pastedDocumentPresent: false,
      error: "project description has nested <document> blocks",
    };
  }

  const trailing = raw.slice(end + close.length);
  if (trailing.includes(open) || trailing.includes(close)) {
    return {
      description: "",
      pastedDocumentPresent: true,
      error: "project description has repeated or additional <document> markers",
    };
  }
  if (trailing.trim().length > 0) {
    return {
      description: "",
      pastedDocumentPresent: true,
      error: `project description has content after terminal ${close}`,
    };
  }

  return {
    description: raw.slice(0, start).trim(),
    pastedDocumentPresent: true,
  };
}

// --- State file I/O ---

export function readStateFile(projectDir: string, intent?: string, space?: string): string {
  const path = stateFilePath(projectDir, intent, space);
  if (!existsSync(path)) {
    throw new Error(`State file not found: ${path}`);
  }
  return readFileSync(path, "utf-8");
}

export const PROJECT_DESCRIPTION_FILE = "project-description.json";
export const DOCUMENT_INPUT_REQUEST_FILE = ".aidlc-document-input-path";
const LEGACY_PROJECT_DESCRIPTION_SOURCE = "aidlc-state.md#Project";

export interface ProjectDescriptionAuthority {
  description: string;
  source: typeof PROJECT_DESCRIPTION_FILE | typeof LEGACY_PROJECT_DESCRIPTION_SOURCE;
}

/**
 * Load the exact initial description for one workflow record.
 *
 * A source marker makes the JSON sidecar mandatory. Records without the marker
 * retain the pre-sidecar Project-field fallback; a malformed marked record never
 * silently degrades to the preview.
 */
export function readProjectDescriptionAuthority(
  recordRoot: string,
  stateContent?: string,
): ProjectDescriptionAuthority {
  const state =
    stateContent ?? readFileSync(join(recordRoot, "aidlc-state.md"), "utf-8");
  const source = getField(state, "Project Description Source") ?? "";
  if (source === "") {
    const description = getField(state, "Project");
    if (description === null) {
      throw new Error("legacy aidlc-state.md is missing the Project field");
    }
    return { description, source: LEGACY_PROJECT_DESCRIPTION_SOURCE };
  }
  if (source !== PROJECT_DESCRIPTION_FILE) {
    throw new Error(`unsupported Project Description Source ${source}`);
  }

  const path = join(recordRoot, PROJECT_DESCRIPTION_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `${PROJECT_DESCRIPTION_FILE} is required by aidlc-state.md but missing`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(
      readRegularFileNoFollowOrThrow(path, "project description").toString(
        "utf-8",
      ),
    );
    if (typeof parsed !== "string") {
      throw new Error("project description JSON must contain one string");
    }
    return { description: parsed, source: PROJECT_DESCRIPTION_FILE };
  } catch (error) {
    throw new Error(
      `failed to read ${PROJECT_DESCRIPTION_FILE}: ${errorMessage(error)}`,
    );
  }
}

export function projectDescriptionFilePath(
  projectDir: string,
  intent?: string,
  space?: string,
): string {
  return join(dirname(stateFilePath(projectDir, intent, space)), PROJECT_DESCRIPTION_FILE);
}

export function documentInputRequestFilePath(
  projectDir: string,
  intent?: string,
  space?: string,
): string {
  return join(dirname(stateFilePath(projectDir, intent, space)), DOCUMENT_INPUT_REQUEST_FILE);
}

export function writeStateFile(projectDir: string, content: string, intent?: string, space?: string): void {
  const path = stateFilePath(projectDir, intent, space);
  // A read-only aidlc-state.md is a deliberate write barrier the state tool
  // must honour (a corrupt/locked workspace must fail loud, not silently
  // advance — see the t47/t77/t137 read-only-state failure-injection tests).
  // writeFileAtomic uses tmp+rename, and POSIX rename overwrites a read-only
  // TARGET (it only needs directory-write permission), so it would bypass that
  // barrier. Preserve the bare-writeFileSync EACCES semantics by refusing up
  // front when the target exists but is not writable.
  if (existsSync(path)) accessSync(path, fsConstants.W_OK);
  // Ensure the record dir's parent chain exists before the atomic write — a
  // per-intent record dir's parents (aidlc/spaces/<sp>/intents/<slug>-<id8>/)
  // may not exist yet on first write; the flat fallback's aidlc-docs/ is created
  // by the init scaffolder, but mkdir-recursive is idempotent so it's safe for
  // both layouts.
  else mkdirSync(dirname(path), { recursive: true });
  // Atomic write (tmp + rename) so a crash mid-write can never leave a
  // half-written state file a concurrent reader would see torn. Lost-update
  // safety for the read-modify-write handlers (withAuditLock wrapping) is a
  // separate, larger change tracked as a follow-up; this reroute is the
  // torn-write half and benefits every caller unconditionally.
  writeFileAtomic(path, content);
}

// --- Field reading/writing ---

export function getField(content: string, field: string): string | null {
  // Match: - **Field Name**: value
  // Use [ \t]* instead of \s* so a field with an empty value returns "" (not
  // the next bullet line — \s matches \n in JS regex, which would let the
  // pattern cross into the next line).
  const regex = new RegExp(
    `^- \\*\\*${escapeRegex(field)}\\*\\*:[ \\t]*(.*)$`,
    "m"
  );
  const match = content.match(regex);
  return match ? match[1].trim() : null;
}

// --- Autonomy mode ---
//
// The state-file field that distinguishes autonomous Construction (swarm/Bolt)
// from interactive flow. Promoted to ONE exported predicate so the human-
// presence gate's carve-out and the existing open-coded `=== "autonomous"`
// sites cannot drift. (This PR uses the helper only at the NEW gate sites;
// refactoring the existing open-coded sites is a tracked follow-up.)
export const AUTONOMY_MODE_FIELD = "Construction Autonomy Mode";
export const UNIT_OWNERSHIP_FIELD = "Unit Ownership";
export const UNIT_GATE_RHYTHM_FIELD = "Unit Gate Rhythm";

export type UnitGateRhythm = "per-stage" | "unit-end";

export function isAutonomousMode(stateContent: string | null): boolean {
  return !!stateContent && getField(stateContent, AUTONOMY_MODE_FIELD)?.trim() === "autonomous";
}

export function isTeamUnitOwnership(stateContent: string | null): boolean {
  return !!stateContent && getField(stateContent, UNIT_OWNERSHIP_FIELD)?.trim() === "team";
}

export function readUnitGateRhythm(stateContent: string | null): UnitGateRhythm {
  if (!isTeamUnitOwnership(stateContent)) return "per-stage";
  return getField(stateContent!, UNIT_GATE_RHYTHM_FIELD)?.trim() === "unit-end"
    ? "unit-end"
    : "per-stage";
}

// True only for the topology the engine can dispatch as an autonomous swarm.
// A truthy `--unit` is not proof: the four inline Construction design stages
// are also per-unit. Keep this predicate shared by receipt and budget guards so
// scope/run review caps are bypassed only for a real Bolt-capable stage.
export function isAutonomousSwarmStage(
  projectDir: string,
  stateContent: string | null,
  stage: {
    slug: string;
    phase: string;
    for_each?: string;
    mode?: string;
  },
): boolean {
  if (stage.phase !== "construction") return false;
  if (stage.for_each !== "unit-of-work" || stage.mode !== "subagent") return false;
  if (!isAutonomousMode(stateContent)) return false;
  const scope = stateContent ? getField(stateContent, "Scope") : null;
  if (!scope) return false;
  if (usesStageLevelPerUnitArtifacts(scope, stateContent)) return false;
  const first = firstInScopeStageOfPhase("construction", scope);
  if (first !== null && first.slug === stage.slug) return false;
  const resolution = resolveBoltDag(projectDir);
  return resolution.state === "ok" && resolution.units.length > 0;
}

// Deterministic off-switch for the human-presence gate (mirrors
// artifactGuardDisabled in aidlc-state.ts). The suite sets this globally (the
// dedicated guard test clears it), and it is the documented bypass for
// synthetic CI runs that drive approve/answer against bare fixtures.
export function humanPresenceGuardDisabled(): boolean {
  return process.env.AIDLC_SKIP_HUMAN_PRESENCE_GUARD === "1";
}

// An unattended driver is the only component that knows its prompt-submit
// event did not originate from a person. Withhold the authority-bearing ledger
// mint while retaining non-authority turn markers used by forwarding hooks.
export function humanTurnMintAllowed(): boolean {
  return process.env.AIDLC_UNATTENDED !== "1";
}

export function unattendedHumanPresenceHint(): string {
  return humanTurnMintAllowed()
    ? ""
    : " AIDLC_UNATTENDED=1 is set, so automated prompt submissions cannot count " +
      "as a human reply. Unset AIDLC_UNATTENDED before returning to interactive " +
      "mode, then submit a new human response.";
}

export function setField(content: string, field: string, value: string): string {
  // [ \t]* instead of \s* so an empty value doesn't let the regex eat the
  // following line. .* with the m flag does not cross lines on its own, but
  // \s* preceding it would consume the trailing \n.
  const regex = new RegExp(
    `^(- \\*\\*${escapeRegex(field)}\\*\\*:)[ \\t]*.*$`,
    "m"
  );
  if (regex.test(content)) {
    return content.replace(regex, `$1 ${value}`);
  }
  return content;
}

// setFieldStrict: like setField but throws when the field is absent. Use this
// in state-machine transitions where a silent no-op would cause undetected
// drift (e.g., bolt set-autonomy updating Construction Autonomy Mode — if the
// field is missing, we want to know immediately, not ship a lie to the caller).
export function setFieldStrict(content: string, field: string, value: string): string {
  // [ \t]* instead of \s* — see setField comment for the line-crossing rationale.
  const regex = new RegExp(
    `^(- \\*\\*${escapeRegex(field)}\\*\\*:)[ \\t]*.*$`,
    "m"
  );
  if (!regex.test(content)) {
    throw new Error(
      `Field not found in state file: "${field}". Cannot update — refusing to silently no-op.`
    );
  }
  return content.replace(regex, `$1 ${value}`);
}

// setPhaseProgress: flip one `- **<Phase>**: <status>` row in the state
// file's `## Phase Progress` section. The row label is the capitalized phase
// slug ("ideation" -> "Ideation"), and each label appears exactly once in the
// state template (only inside that section), so the plain setField match
// cannot collide with another field. A no-op when the row is absent (an older
// or hand-edited state file): the section is display-only, so a missing row
// must never fail a transition.
export function setPhaseProgress(
  content: string,
  phase: string,
  status: "Pending" | "Active" | "Verified" | "Skipped",
): string {
  const label = phase.charAt(0).toUpperCase() + phase.slice(1);
  return setField(content, label, status);
}

// setOrInsertField: update field if present; otherwise insert a new
// `- **Field**: value` bullet at the end of the named `## Heading` section.
// Intended for optional fields that don't ship in the current state-template
// but may be added at runtime (e.g., the `Merge-Held` per-Bolt marker —
// added only when a multi-failure halt-and-ask sequence opens).
export function setOrInsertField(
  content: string,
  heading: string,
  field: string,
  value: string,
): string {
  const regex = new RegExp(
    `^(- \\*\\*${escapeRegex(field)}\\*\\*:)[ \\t]*.*$`,
    "m"
  );
  if (regex.test(content)) {
    return content.replace(regex, `$1 ${value}`);
  }
  return appendUnderHeading(content, heading, `- **${field}**: ${value}\n`);
}

// removeField: delete the `- **Field**: ...` bullet line if present; a no-op
// otherwise. The inverse of setOrInsertField, for runtime-only fields that are
// cleared rather than reset (e.g. the `Parked` / `Parked At Stage` markers an
// `unpark` removes). Matches the bullet at line start and drops the whole line
// including its trailing newline so no blank line is left behind.
export function removeField(content: string, field: string): string {
  const regex = new RegExp(
    `^- \\*\\*${escapeRegex(field)}\\*\\*:[ \\t]*.*(?:\\r?\\n)?`,
    "m"
  );
  return content.replace(regex, "");
}

// --- Refs-list field operations (Bolt Refs in v7 state template) ---
//
// `Bolt Refs` is a list-shaped single-line value with a literal `[empty list]`
// placeholder when empty (state-template.md:11) — `aidlc-utility.ts`'s init
// emitter at line 1391 also produces a bare-empty shape (no value after the
// colon). Both are tolerated on parse; emit always produces `[empty list]`
// when empty for round-trip determinism.
export function parseRefsList(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "[empty list]") return [];
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function emitRefsList(slugs: string[]): string {
  if (slugs.length === 0) return "[empty list]";
  const sorted = [...slugs].sort();
  return `[${sorted.join(", ")}]`;
}

export function appendSlug(currentValue: string, slug: string): string {
  const list = parseRefsList(currentValue);
  if (list.includes(slug)) {
    throw new Error(`slug already present in refs list: "${slug}"`);
  }
  list.push(slug);
  return emitRefsList(list);
}

export function removeSlug(currentValue: string, slug: string): string {
  const list = parseRefsList(currentValue);
  if (!list.includes(slug)) {
    throw new Error(`slug not present in refs list: "${slug}"`);
  }
  return emitRefsList(list.filter((s) => s !== slug));
}

// --- Checkbox operations ---

export interface CheckboxLine {
  slug: string;
  state: CheckboxState;
  suffix: string; // e.g., "EXECUTE" or "SKIP: reason"
}

export function parseCheckboxes(content: string): CheckboxLine[] {
  const results: CheckboxLine[] = [];
  const regex = /^- \[([ xSR?-])\] (\S+)\s*—\s*(.*)$/gm;
  let match: RegExpExecArray | null = regex.exec(content);
  while (match !== null) {
    const marker = match[1];
    let state: CheckboxState;
    switch (marker) {
      case " ":
        state = "pending";
        break;
      case "-":
        state = "in-progress";
        break;
      case "?":
        state = "awaiting-approval";
        break;
      case "R":
        state = "revising";
        break;
      case "x":
        state = "completed";
        break;
      case "S":
        state = "skipped";
        break;
      default:
        state = "pending";
    }
    results.push({ slug: match[2], state, suffix: match[3].trim() });
    match = regex.exec(content);
  }
  return results;
}

export function recoveryGuidance(
  _projectDir: string,
  stateContent: string,
  stageSlug: string,
): string {
  const stage = parseCheckboxes(stateContent).find(
    (entry) => entry.slug === stageSlug,
  );
  if (stage?.suffix.startsWith("SKIP")) {
    return (
      "This stage is excluded from the current plan; change to a scope that " +
      `includes it with /aidlc --scope <scope>, then restart ${stageSlug}.`
    );
  }
  if (!stage || stage.state === "pending") {
    return (
      `Restart this stage with /aidlc --stage ${stageSlug}; the recorded ` +
      "answers survive, and the stage will ask for confirmation again."
    );
  }
  if (stage.state === "skipped") {
    return (
      `Restart this stage with /aidlc --stage ${stageSlug}; the recorded ` +
      "answers survive, and the stage will ask for confirmation again."
    );
  }
  if (
    stage.state === "in-progress" ||
    stage.state === "awaiting-approval"
  ) {
    return (
      "To change this document, tell me what should change and I'll record your " +
      "Request Changes decision (this works before the gate opens); that unlocks " +
      "the file for revision and a fresh review."
    );
  }
  if (stage.state === "revising") {
    return (
      "This stage is mid-revision; the way to restart it cleanly is a redo jump: " +
      `/aidlc --stage ${stageSlug} (your recorded answers survive; you will ` +
      "re-confirm the summary once)."
    );
  }
  if (stage.state === "completed") {
    return (
      "This stage is already approved; restore the reviewed source state, or " +
      `jump back with /aidlc --stage ${stageSlug} to redo it.`
    );
  }
  return (
    `Restart this stage with /aidlc --stage ${stageSlug}; the recorded answers ` +
    "survive, and the stage will ask for confirmation again."
  );
}

export function setCheckbox(
  content: string,
  slug: string,
  newState: CheckboxState
): string {
  const marker = CHECKBOX_MAP[newState];
  // Match any checkbox state for this slug
  const regex = new RegExp(
    `^(- )\\[[ xSR?-]\\]( ${escapeRegex(slug)} —)`,
    "m"
  );
  return content.replace(regex, `$1${marker}$2`);
}

// The suffix-setter twin of setCheckbox: flips ONE stage line's plan suffix
// (the em-dash EXECUTE/SKIP tail the router's override channel reads)
// in either direction, leaving the checkbox marker untouched. setCheckbox owns
// the marker (run-state); this owns the suffix (the plan) - the two edit
// disjoint fields of the same line, so recompose and jump compose cleanly.
// Returns the content unchanged when the slug has no stage line.
export function setStageSuffix(
  content: string,
  slug: string,
  action: "EXECUTE" | "SKIP"
): string {
  const regex = new RegExp(
    `^(- \\[[ xSR?-]\\] ${escapeRegex(slug)}\\s*—\\s*)(EXECUTE|SKIP)\\b`,
    "m"
  );
  return content.replace(regex, `$1${action}`);
}

export function countCheckboxes(
  content: string,
  state: CheckboxState
): number {
  const checkboxes = parseCheckboxes(content);
  return checkboxes.filter((c) => c.state === state).length;
}

// --- Audit locking (per-intent, reaper-guarded) -------------------------------
//
// The audit lock is a cross-process mutex: a bare mkdir-EEXIST dir in tmpdir().
// It is keyed PER INTENT so two intents (or two Bolts in different intents) run
// truly in parallel without false serialization. Two keying invariants (P4's
// auto-create depends on them):
//
//  (1) intent-OMITTED hashes a RESERVED sentinel `__workspace__` bucket, distinct
//      from every per-intent bucket, and does NOT resolve activeIntent() (during
//      intent creation there is no active intent; resolving would throw or bucket on
//      "default", and two concurrent first-runs would key different/empty
//      buckets and both create intents). EVERY intents.json mutation takes this
//      workspace
//      bucket; only intent-scoped state/audit writes take a per-intent bucket.
//  (2) the composite identity (projectDir + space + intent | sentinel) keys the
//      lock dir. In-process receipt/depth/handler maps use a stable lexical
//      request key, while each receipt retains the acquisition-bound identity.
//
// REAPER: acquire stamps owner PID + acquisition generation + a random token
// into owner.json. Automatic recovery is fail-closed: malformed/unreadable
// stamps and live owners are never reaped. A recoverable owner-stamped reap
// gate blocks acquisition while a provably-dead generation (or an old genuinely
// missing stamp) is moved, verified, deleted, or restored.

// The reserved bucket for workspace-level mutations (intents.json, intent creation).
export const WORKSPACE_LOCK_SENTINEL = "__workspace__";

// Default stale-lock age threshold (ms). Doctor uses this to surface a
// live-but-old owner for manual diagnosis; automatic acquisition never reaps a
// live stamped owner. Tunable via AIDLC_LOCK_STALE_MS for tests/ops.
export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

function lockStaleMs(): number {
  const raw = process.env.AIDLC_LOCK_STALE_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_LOCK_STALE_MS;
}

// The composite lock IDENTITY string — keys the dir hash AND the in-process
// maps. intent-omitted → the workspace sentinel (invariant 1). When intent is
// given, the space is default-resolved (a per-intent lock is meaningless without
// its space) but activeIntent() is NEVER consulted here.
export function auditLockIdentity(projectDir: string, intent?: string, space?: string): string {
  let canonicalProjectDir = resolvePath(projectDir);
  try {
    canonicalProjectDir = realpathSync(canonicalProjectDir);
  } catch {
    // Creation and diagnostics can lock before the project exists. The absolute
    // lexical path is stable until realpath can resolve filesystem aliases.
  }
  if (process.platform === "win32") {
    canonicalProjectDir = canonicalProjectDir.toLowerCase();
  }
  if (intent === undefined) {
    return `${canonicalProjectDir}\x00${WORKSPACE_LOCK_SENTINEL}`;
  }
  const sp = space ?? activeSpace(projectDir);
  return `${canonicalProjectDir}\x00${sp}\x00${intent}`;
}

// Stable call-site key for process-local receipt/depth/handler maps. Unlike the
// filesystem identity, it deliberately does not read realpath or active-space,
// so release remains bound to the acquisition even if a previously-missing path
// becomes a symlink/real directory or the active-space cursor changes.
function auditLockRequestKey(projectDir: string, intent?: string, space?: string): string {
  const lexicalProjectDir = process.platform === "win32"
    ? resolvePath(projectDir).toLowerCase()
    : resolvePath(projectDir);
  if (intent === undefined) {
    return JSON.stringify([lexicalProjectDir, "workspace"]);
  }
  return JSON.stringify([
    lexicalProjectDir,
    "intent",
    space === undefined ? null : space,
    intent,
  ]);
}

export function auditLockDir(projectDir: string, intent?: string, space?: string): string {
  const identity = auditLockIdentity(projectDir, intent, space);
  const hash = createHash("md5").update(identity).digest("hex").slice(0, 8);
  return join(tmpdir(), `.aidlc-audit-${hash}.lock`);
}

// Owner stamp written into the lock dir on acquire. The random token identifies
// the lock generation; processGeneration binds the PID to its OS creation time
// where the platform exposes one (Linux procfs and Windows GetProcessTimes).
interface LockOwner {
  pid: number;
  startedAtMs: number;
  reapLiveOwnerAfterStale: boolean;
  token?: string;
  processGeneration?: string;
}

type OwnerStampRead =
  | { status: "ok"; owner: LockOwner }
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "unreadable"; code: string };

export interface AuditLockFaultHooksForTests {
  afterReleaseOwnerCheck?: (lockDir: string) => void;
  beforeReleaseRename?: (retiredPath: string, attempt: number) => void;
  failReleaseRename?: (retiredPath: string, attempt: number) => boolean;
  afterSuccessfulReap?: (lockDir: string) => void;
  afterReapFinalCheck?: (lockDir: string) => void;
  failReapRename?: (privatePath: string, attempt: number) => boolean;
  beforeAcquirerOwnerStamp?: (lockDir: string, token: string) => void;
  beforeGateOwnerStamp?: (
    candidateDir: string,
    canonicalDir: string,
    token: string,
  ) => void;
  failGateReleaseRename?: (retiredPath: string, attempt: number) => boolean;
  afterReleasableGateCheck?: (gateDir: string) => void;
  posixGateLibraryCandidates?: string[];
  processProbe?: (pid: number) => { alive: boolean; generation: string | null };
  selfProcessGeneration?: () => string | null;
}

let AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS: AuditLockFaultHooksForTests | null = null;

export function _setAuditLockFaultHooksForTests(
  hooks: AuditLockFaultHooksForTests | null,
): void {
  AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS = hooks;
  POSIX_GATE_API = undefined;
}

function ownerStampPath(lockDir: string): string {
  return join(lockDir, "owner.json");
}

const LOCK_GENERATION_TOKEN_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function lockGenerationTokenDir(lockDir: string, token: string): string | null {
  if (!LOCK_GENERATION_TOKEN_REGEX.test(token)) return null;
  const root = resolvePath(lockDir);
  const tokenDir = resolvePath(root, token);
  const lexicalChild = relative(root, tokenDir);
  if (
    lexicalChild === "" ||
    lexicalChild === ".." ||
    lexicalChild.startsWith(`..${sep}`) ||
    isAbsolute(lexicalChild)
  ) return null;
  try {
    const rootStat = lstatSync(root);
    const tokenStat = lstatSync(tokenDir);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      !tokenStat.isDirectory() ||
      tokenStat.isSymbolicLink()
    ) return null;
    const realChild = relative(realpathSync(root), realpathSync(tokenDir));
    if (
      realChild === "" ||
      realChild === ".." ||
      realChild.startsWith(`..${sep}`) ||
      isAbsolute(realChild)
    ) return null;
    return tokenDir;
  } catch {
    return null;
  }
}

function loadWindowsProcessApi() {
  return dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.ptr,
    },
    LockFileEx: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.bool,
    },
    UnlockFileEx: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.bool,
    },
    OpenProcess: {
      args: [FFIType.u32, FFIType.bool, FFIType.u32],
      returns: FFIType.ptr,
    },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.bool,
    },
    CloseHandle: {
      args: [FFIType.ptr],
      returns: FFIType.bool,
    },
  });
}

function muslArchitecture(): string {
  const mapping: Record<string, string> = {
    arm64: "aarch64",
    ia32: "i386",
    ppc64: "powerpc64le",
    x64: "x86_64",
  };
  return mapping[process.arch] ?? process.arch;
}

function posixGateLibraryCandidates(): string[] {
  if (AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.posixGateLibraryCandidates) {
    return AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS.posixGateLibraryCandidates;
  }
  if (process.platform === "darwin") {
    return ["/usr/lib/libSystem.B.dylib"];
  }
  const arch = muslArchitecture();
  const candidates = [
    "libc.so.6",
    `/lib/ld-musl-${arch}.so.1`,
    `/usr/lib/ld-musl-${arch}.so.1`,
    `/lib/libc.musl-${arch}.so.1`,
    `/usr/lib/libc.musl-${arch}.so.1`,
    `libc.musl-${arch}.so.1`,
    "libc.so",
  ];
  for (const dir of ["/lib", "/usr/lib", "/lib64", "/usr/lib64"]) {
    try {
      for (const entry of readdirSync(dir)) {
        if (/^(?:ld-musl-|libc\.musl-).+\.so\.1$/.test(entry)) {
          candidates.push(join(dir, entry));
        }
      }
    } catch {
      // Directory absent or unreadable; explicit candidates still apply.
    }
  }
  return [...new Set(candidates)];
}

export function _posixGateLibraryCandidatesForTests(): string[] {
  return posixGateLibraryCandidates();
}

function loadPosixGateApi() {
  let lastError: unknown;
  for (const library of posixGateLibraryCandidates()) {
    try {
      return dlopen(library, {
      flock: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No POSIX flock library candidate could be loaded");
}

function loadMacProcessApi() {
  return dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: {
      args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
      returns: FFIType.i32,
    },
  });
}

let WINDOWS_PROCESS_API:
  | ReturnType<typeof loadWindowsProcessApi>
  | null
  | undefined;
let MAC_PROCESS_API:
  | ReturnType<typeof loadMacProcessApi>
  | null
  | undefined;
let POSIX_GATE_API:
  | ReturnType<typeof loadPosixGateApi>
  | null
  | undefined;
let SELF_PROCESS_GENERATION: string | null | undefined;

function windowsProcessGeneration(pid: number): string | null {
  try {
    if (WINDOWS_PROCESS_API === undefined) {
      WINDOWS_PROCESS_API = loadWindowsProcessApi();
    }
    if (WINDOWS_PROCESS_API === null) return null;
    const handle = WINDOWS_PROCESS_API.symbols.OpenProcess(0x1000, false, pid);
    if (!handle) return null;
    const creation = new Uint32Array(2);
    const exit = new Uint32Array(2);
    const kernel = new Uint32Array(2);
    const user = new Uint32Array(2);
    try {
      if (!WINDOWS_PROCESS_API.symbols.GetProcessTimes(
        handle,
        creation,
        exit,
        kernel,
        user,
      )) return null;
      return `${creation[1].toString(16)}:${creation[0].toString(16)}`;
    } finally {
      WINDOWS_PROCESS_API.symbols.CloseHandle(handle);
    }
  } catch {
    WINDOWS_PROCESS_API = null;
    return null;
  }
}

function linuxProcessGeneration(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 1).trim().split(/\s+/);
    return fields[19] || null; // procfs field 22: process start time in ticks
  } catch {
    return null;
  }
}

function macProcessGeneration(pid: number): string | null {
  try {
    if (MAC_PROCESS_API === undefined) {
      MAC_PROCESS_API = loadMacProcessApi();
    }
    if (MAC_PROCESS_API === null) return null;
    const PROC_PIDTBSDINFO = 3;
    const buffer = new Uint8Array(136);
    const read = MAC_PROCESS_API.symbols.proc_pidinfo(
      pid,
      PROC_PIDTBSDINFO,
      0n,
      buffer,
      buffer.byteLength,
    );
    if (read < 136) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`;
  } catch {
    MAC_PROCESS_API = null;
    return null;
  }
}

type NativeGateMutexReceipt =
  | { kind: "posix"; fd: number }
  | {
      kind: "windows";
      handle: Pointer;
      overlapped: Uint8Array;
    };

function nativeGateMutexPath(lockDir: string): string {
  return `${lockDir}.gate-mutex`;
}

function invalidWindowsHandle(handle: Pointer | bigint | null): boolean {
  if (handle === null) return true;
  return BigInt.asIntN(64, BigInt(handle)) === -1n;
}

function tryAcquireNativeGateMutex(
  lockDir: string,
): NativeGateMutexReceipt | null {
  const path = nativeGateMutexPath(lockDir);
  if (process.platform === "win32") {
    try {
      if (WINDOWS_PROCESS_API === undefined) {
        WINDOWS_PROCESS_API = loadWindowsProcessApi();
      }
      if (WINDOWS_PROCESS_API === null) return null;
      const widePath = Buffer.from(`${path}\0`, "utf16le");
      const rawHandle = WINDOWS_PROCESS_API.symbols.CreateFileW(
        widePath,
        0xc0000000,
        3,
        null,
        4,
        0x80,
        null,
      );
      if (invalidWindowsHandle(rawHandle)) return null;
      const handle = rawHandle as Pointer;
      const overlapped = new Uint8Array(32);
      if (!WINDOWS_PROCESS_API.symbols.LockFileEx(
        handle,
        3,
        0,
        1,
        0,
        overlapped,
      )) {
        WINDOWS_PROCESS_API.symbols.CloseHandle(handle);
        return null;
      }
      return {
        kind: "windows",
        handle,
        overlapped,
      };
    } catch {
      return null;
    }
  }
  try {
    if (POSIX_GATE_API === undefined) {
      POSIX_GATE_API = loadPosixGateApi();
    }
    if (POSIX_GATE_API === null) return null;
    const fd = openSync(path, "a+", 0o600);
    if (POSIX_GATE_API.symbols.flock(fd, 2 | 4) !== 0) {
      closeSync(fd);
      return null;
    }
    return { kind: "posix", fd };
  } catch {
    POSIX_GATE_API = null;
    return null;
  }
}

function acquireNativeGateMutex(
  lockDir: string,
  maxRetries = 100,
  retryMs = 5,
): NativeGateMutexReceipt | null {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const receipt = tryAcquireNativeGateMutex(lockDir);
    if (receipt) return receipt;
    if (attempt < maxRetries) Bun.sleepSync(retryMs);
  }
  return null;
}

function releaseNativeGateMutex(receipt: NativeGateMutexReceipt): void {
  if (receipt.kind === "posix") {
    try { POSIX_GATE_API?.symbols.flock(receipt.fd, 8); } catch { /* closing also unlocks */ }
    try { closeSync(receipt.fd); } catch { /* already closed */ }
    return;
  }
  try {
    WINDOWS_PROCESS_API?.symbols.UnlockFileEx(
      receipt.handle,
      0,
      1,
      0,
      receipt.overlapped,
    );
  } catch { /* closing also unlocks */ }
  try { WINDOWS_PROCESS_API?.symbols.CloseHandle(receipt.handle); } catch { /* already closed */ }
}

function processGeneration(pid: number): string | null {
  if (pid === process.pid && AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.selfProcessGeneration) {
    return AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS.selfProcessGeneration();
  }
  if (pid === process.pid && SELF_PROCESS_GENERATION !== undefined) {
    return SELF_PROCESS_GENERATION;
  }
  const generation = process.platform === "win32"
    ? windowsProcessGeneration(pid)
    : process.platform === "linux"
      ? linuxProcessGeneration(pid)
      : process.platform === "darwin"
        ? macProcessGeneration(pid)
        : null;
  if (pid === process.pid) SELF_PROCESS_GENERATION = generation;
  return generation;
}

function writeOwnerStamp(
  lockDir: string,
  reapLiveOwnerAfterStale = true,
  token?: string,
): LockOwner | null {
  const generation = processGeneration(process.pid);
  const owner: LockOwner = {
    pid: process.pid,
    startedAtMs: lockAcquireEpochMs(),
    reapLiveOwnerAfterStale,
    ...(token ? { token } : {}),
    ...(generation ? { processGeneration: generation } : {}),
  };
  try {
    writeFileSync(ownerStampPath(lockDir), JSON.stringify(owner), {
      encoding: "utf-8",
      mode: 0o600,
      ...(token ? { flag: "wx" } : {}),
    });
    return owner;
  } catch {
    // Acquisition treats a missing stamp as failure and abandons its directory.
    return null;
  }
}

function inspectOwnerStamp(lockDir: string): OwnerStampRead {
  let raw: string;
  try {
    raw = readFileSync(ownerStampPath(lockDir), "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    return code === "ENOENT"
      ? { status: "missing" }
      : { status: "unreadable", code };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "invalid" };
  }
  if (!isPlainObject(parsed) || typeof parsed.pid !== "number" || typeof parsed.startedAtMs !== "number") {
    return { status: "invalid" };
  }
  let token: string | undefined;
  if (parsed.token !== undefined) {
    if (
      typeof parsed.token !== "string" ||
      lockGenerationTokenDir(lockDir, parsed.token) === null
    ) return { status: "invalid" };
    token = parsed.token;
  }
  return {
    status: "ok",
    owner: {
      pid: parsed.pid,
      startedAtMs: parsed.startedAtMs,
      reapLiveOwnerAfterStale: parsed.reapLiveOwnerAfterStale !== false,
      ...(token ? { token } : {}),
      ...(typeof parsed.processGeneration === "string" && parsed.processGeneration.length > 0
        ? { processGeneration: parsed.processGeneration }
        : {}),
    },
  };
}

function readOwnerStamp(lockDir: string): LockOwner | null {
  const result = inspectOwnerStamp(lockDir);
  return result.status === "ok" ? result.owner : null;
}

// A monotonic-ish epoch for the owner stamp. performance.timeOrigin + now()
// gives a wall-clock-equivalent without the bare `Date.now()` the lint forbids;
// it is used only for AGE comparison (a relative delta), so origin drift is
// irrelevant — both stamps come from the same clock family across processes
// because timeOrigin is anchored to the unix epoch by the runtime.
function lockAcquireEpochMs(): number {
  return Math.floor(performance.timeOrigin + performance.now());
}

// Is a PID still alive? signal 0 probes liveness without delivering a signal:
// ESRCH ⇒ gone, EPERM ⇒ alive-but-not-ours (still alive), success ⇒ alive.
// EXPORTED so a caller outside the lock mechanism
// (e.g. a staged-transaction collector distinguishing a live writer's staging
// dir from a crashed one's) can ask the same question this module already
// answers for the lock reaper, rather than re-deriving it.
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM ⇒ the process exists but is owned by another user → still alive.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

type OwnerProcessState = "dead" | "same" | "different" | "unknown";

function ownerProcessState(owner: LockOwner): OwnerProcessState {
  const injected = AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.processProbe?.(owner.pid);
  const alive = injected?.alive ?? isPidAlive(owner.pid);
  if (!alive) return "dead";
  const observedGeneration = injected
    ? injected.generation
    : processGeneration(owner.pid);
  if (!owner.processGeneration || !observedGeneration) return "unknown";
  return owner.processGeneration === observedGeneration ? "same" : "different";
}

// A monotonic per-process counter for the steal-rename suffix (no Math.random /
// Date.now — scripts/forbid). Combined with the PID it is unique enough that two
// waiters never collide on the same `.dead.<suffix>` name, and only one wins the
// rename anyway (the second gets ENOENT).
let _reapCounter = 0;
function reapSuffix(): string {
  _reapCounter += 1;
  return `${process.pid}-${_reapCounter}`;
}

// Grace window (ms) for an UNSTAMPED lock dir. acquireAuditLock mkdirs the lock
// dir THEN writes owner.json, so there is a brief window where a live holder's
// dir has no stamp yet. A waiter must NOT steal an unstamped dir younger than
// this grace (it is a live process mid-acquire) — only an unstamped dir OLDER
// than the grace is treated as a genuine leak (e.g. a SIGKILL between mkdir and
// stamp). Generous relative to the mkdir→write gap, tiny relative to the stale
// threshold. Tunable via AIDLC_LOCK_UNSTAMPED_GRACE_MS.
function unstampedGraceMs(): number {
  const raw = process.env.AIDLC_LOCK_UNSTAMPED_GRACE_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5000;
}

// The lock dir's own mtime epoch (ms), or null if it can't be stat'd. Used as the
// age anchor for an UNSTAMPED dir (no owner.json yet / ever). statSync mtime is a
// wall-clock ms, comparable to lockAcquireEpochMs()'s epoch family.
function lockDirMtimeMs(lockDir: string): number | null {
  try {
    return statSync(lockDir).mtimeMs;
  } catch {
    return null;
  }
}

function ownerStampsEqual(now: LockOwner, judged: LockOwner): boolean {
  return (
    now.pid === judged.pid &&
    now.startedAtMs === judged.startedAtMs &&
    now.reapLiveOwnerAfterStale === judged.reapLiveOwnerAfterStale &&
    now.token === judged.token &&
    now.processGeneration === judged.processGeneration
  );
}

function stampMatches(dir: string, judged: LockOwner): boolean {
  const current = inspectOwnerStamp(dir);
  return current.status === "ok" && ownerStampsEqual(current.owner, judged);
}

interface ReapCandidate {
  owner: LockOwner | null;
  unstampedIdentity: string | null;
}

function unstampedIdentity(lockDir: string): string | null {
  try {
    const stat = statSync(lockDir);
    return createHash("sha256")
      .update(`${stat.dev}\x00${stat.ino}\x00${stat.birthtimeMs}\x00${stat.mtimeMs}`)
      .digest("hex")
      .slice(0, 24);
  } catch {
    return null;
  }
}

function reapCandidate(lockDir: string): ReapCandidate | null {
  const inspected = inspectOwnerStamp(lockDir);
  if (inspected.status === "invalid" || inspected.status === "unreadable") {
    return null;
  }
  if (inspected.status === "missing") {
    const mtime = lockDirMtimeMs(lockDir);
    if (mtime === null || lockAcquireEpochMs() - mtime <= unstampedGraceMs()) {
      return null;
    }
    const identity = unstampedIdentity(lockDir);
    return identity === null
      ? null
      : {
          owner: null,
          unstampedIdentity: identity,
        };
  }
  const processState = ownerProcessState(inspected.owner);
  if (processState === "same" || processState === "unknown") {
    // Integrity first: automatic acquisition never reaps the same or
    // generation-unknown live process.
    return null;
  }
  return {
    owner: inspected.owner,
    unstampedIdentity: null,
  };
}

function reapCandidateStillMatches(lockDir: string, candidate: ReapCandidate): boolean {
  if (candidate.owner !== null) {
    const current = inspectOwnerStamp(lockDir);
    const state = current.status === "ok"
      ? ownerProcessState(current.owner)
      : "unknown";
    return (
      current.status === "ok" &&
      ownerStampsEqual(current.owner, candidate.owner) &&
      (state === "dead" || state === "different")
    );
  }
  return (
    inspectOwnerStamp(lockDir).status === "missing" &&
    unstampedIdentity(lockDir) === candidate.unstampedIdentity
  );
}

function reapClaimDir(lockDir: string): string {
  return `${lockDir}.reap`;
}

function reapPrivateDir(lockDir: string, claimToken: string): string {
  return `${lockDir}.dead.${claimToken}`;
}

function tryCreateOwnerStampedDir(
  dir: string,
  reapLiveOwnerAfterStale = true,
): OwnerStampedLockReceipt | null {
  const candidate = `${dir}.candidate.${randomUUID()}`;
  try {
    mkdirSync(candidate, { mode: 0o700 });
  } catch {
    return null;
  }
  const token = randomUUID();
  const candidateTokenDir = join(candidate, token);
  try {
    mkdirSync(candidateTokenDir, { mode: 0o700 });
    AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.beforeGateOwnerStamp?.(
      candidate,
      dir,
      token,
    );
    const owner = writeOwnerStamp(candidate, reapLiveOwnerAfterStale, token);
    if (!owner?.token) throw new Error("owner stamp failed");
    renameSync(candidate, dir);
    return {
      lockDir: dir,
      tokenDir: join(dir, token),
      owner: owner as LockOwner & { token: string },
    };
  } catch {
    try { rmSync(candidate, { recursive: true, force: true }); } catch { /* private debris */ }
    return null;
  }
}

function restoreReapPrivate(
  lockDir: string,
  privateDir: string,
): boolean {
  if (!existsSync(privateDir)) return true;
  if (existsSync(lockDir)) return false;
  for (let attempt = 0; attempt <= 100; attempt++) {
    try {
      renameSync(privateDir, lockDir);
      return true;
    } catch {
      if (existsSync(lockDir)) return false;
      if (!existsSync(privateDir)) return true;
      if (attempt < 100) Bun.sleepSync(5);
    }
  }
  return false;
}

function retireReapClaim(claimDir: string): boolean {
  for (let attempt = 0; attempt <= 100; attempt++) {
    const retired = `${claimDir}.retired.${randomUUID()}`;
    try {
      renameSync(claimDir, retired);
      try { rmSync(retired, { recursive: true, force: true }); } catch { /* private debris */ }
      return true;
    } catch {
      if (!existsSync(claimDir)) return true;
      if (attempt < 100) Bun.sleepSync(5);
    }
  }
  return false;
}

function recoverReapClaim(lockDir: string, owner: LockOwner): boolean {
  const claimDir = reapClaimDir(lockDir);
  const privateDir = owner.token ? reapPrivateDir(lockDir, owner.token) : "";
  if (privateDir && existsSync(privateDir) && !existsSync(lockDir)) {
    // The stale gate still excludes every canonical mutation. Restore first,
    // regardless of whether the displaced generation is dead, live, or
    // unreadable; the next gate owner will classify it from the canonical path.
    if (!restoreReapPrivate(lockDir, privateDir)) return false;
  }
  return retireReapClaim(claimDir);
}

const PENDING_REAP_GATE_RELEASES = new Map<string, {
  receipt: OwnerStampedLockReceipt;
  handler: () => void;
}>();

type ReapGateReleaseState = "held" | "releasable" | "invalid";

function reapGateReleasablePath(
  claimDir: string,
  owner: LockOwner & { token: string },
): string | null {
  const tokenDir = lockGenerationTokenDir(claimDir, owner.token);
  return tokenDir === null ? null : join(tokenDir, "releasable");
}

function reapGateReleaseState(
  claimDir: string,
  owner: LockOwner,
): ReapGateReleaseState {
  if (typeof owner.token !== "string") return "invalid";
  const path = reapGateReleasablePath(
    claimDir,
    owner as LockOwner & { token: string },
  );
  if (path === null) return "invalid";
  try {
    return lstatSync(path).isFile() ? "releasable" : "invalid";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "held"
      : "invalid";
  }
}

function markReapGateReleasable(receipt: OwnerStampedLockReceipt): boolean {
  const path = reapGateReleasablePath(receipt.lockDir, receipt.owner);
  if (path === null) return false;
  for (let attempt = 0; attempt <= 100; attempt++) {
    try {
      writeFileSync(path, "", { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        return reapGateReleaseState(receipt.lockDir, receipt.owner) === "releasable";
      }
      if (!ownerReceiptMatches(receipt)) return false;
      if (attempt < 100) Bun.sleepSync(5);
    }
  }
  return false;
}

function clearPendingReapGateRelease(claimDir: string): void {
  const pending = PENDING_REAP_GATE_RELEASES.get(claimDir);
  if (!pending) return;
  process.off("exit", pending.handler);
  PENDING_REAP_GATE_RELEASES.delete(claimDir);
}

function retryPendingReapGateRelease(claimDir: string): boolean {
  const pending = PENDING_REAP_GATE_RELEASES.get(claimDir);
  if (!pending) return true;
  if (!existsSync(claimDir)) {
    clearPendingReapGateRelease(claimDir);
    return true;
  }
  if (!markReapGateReleasable(pending.receipt)) return false;
  const outcome = releaseOwnerStampedLock(pending.receipt, false, true);
  if (outcome === "retryable") return false;
  clearPendingReapGateRelease(claimDir);
  return true;
}

function acquireReapClaim(lockDir: string): OwnerStampedLockReceipt | null {
  const claimDir = reapClaimDir(lockDir);
  const mutex = acquireNativeGateMutex(lockDir);
  if (!mutex) return null;
  try {
    if (!retryPendingReapGateRelease(claimDir)) return null;
    for (let attempt = 0; attempt <= 3; attempt++) {
      const created = tryCreateOwnerStampedDir(claimDir, false);
      if (created) return created;
      const inspected = inspectOwnerStamp(claimDir);
      if (inspected.status === "ok") {
        const releaseState = reapGateReleaseState(claimDir, inspected.owner);
        if (releaseState === "invalid") return null;
        if (releaseState === "releasable") {
          AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterReleasableGateCheck?.(
            claimDir,
          );
          if (!retireReapClaim(claimDir)) return null;
          continue;
        }
        const state = ownerProcessState(inspected.owner);
        if (state === "same" || state === "unknown") return null;
        if (!recoverReapClaim(lockDir, inspected.owner)) return null;
      } else if (inspected.status === "missing") {
        const mtime = lockDirMtimeMs(claimDir);
        if (mtime === null || lockAcquireEpochMs() - mtime <= unstampedGraceMs()) return null;
        if (!retireReapClaim(claimDir)) return null;
      } else {
        // Invalid/unreadable claim ownership is ambiguous and remains fail-closed.
        return null;
      }
    }
    return null;
  } finally {
    releaseNativeGateMutex(mutex);
  }
}

function releaseReapClaim(receipt: OwnerStampedLockReceipt): boolean {
  const lockDir = receipt.lockDir.endsWith(".reap")
    ? receipt.lockDir.slice(0, -".reap".length)
    : receipt.lockDir;
  const mutex = acquireNativeGateMutex(lockDir);
  let outcome: LockReleaseOutcome = "retryable";
  if (mutex) {
    try {
      const marked = markReapGateReleasable(receipt);
      outcome = marked
        ? releaseOwnerStampedLock(receipt, false, true)
        : "retryable";
    } finally {
      releaseNativeGateMutex(mutex);
    }
  }
  if (outcome !== "retryable") {
    clearPendingReapGateRelease(receipt.lockDir);
    return true;
  }
  if (!PENDING_REAP_GATE_RELEASES.has(receipt.lockDir)) {
    const handler = () => {
      releaseReapClaim(receipt);
    };
    PENDING_REAP_GATE_RELEASES.set(receipt.lockDir, { receipt, handler });
    process.on("exit", handler);
  }
  return false;
}

// Reclaim only a provably-dead stamped owner, a generation-mismatched reused
// PID, or a genuinely old missing-stamp directory. The fixed owner-stamped reap
// gate blocks acquisition while canonical ownership is moved or restored.
function reapStaleLock(lockDir: string, reapUnstamped = true): boolean {
  const claim = acquireReapClaim(lockDir);
  if (!claim) return false;
  let releaseClaim = true;
  const dead = reapPrivateDir(lockDir, claim.owner.token);
  let moved = false;
  try {
    const candidate = reapCandidate(lockDir);
    if (
      candidate === null ||
      (!reapUnstamped && candidate.owner === null)
    ) return false;
    if (!reapCandidateStillMatches(lockDir, candidate)) return false;
    AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterReapFinalCheck?.(lockDir);
    for (let attempt = 0; attempt <= 100; attempt++) {
      if (AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.failReapRename?.(dead, attempt)) {
        if (attempt < 100) Bun.sleepSync(5);
        continue;
      }
      try {
        renameSync(lockDir, dead);
        moved = true;
        break;
      } catch {
        if (!reapCandidateStillMatches(lockDir, candidate)) return false;
        if (attempt < 100) Bun.sleepSync(5);
      }
    }
    if (!moved) return false;
    if (!reapCandidateStillMatches(dead, candidate)) {
      if (!restoreReapPrivate(lockDir, dead)) releaseClaim = false;
      return false;
    }
    try {
      rmSync(dead, { recursive: true, force: true });
    } catch {
      // Private dead-generation debris never aliases the canonical lock path.
    }
    AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterSuccessfulReap?.(lockDir);
    return true;
  } finally {
    if (releaseClaim && !releaseReapClaim(claim)) {
      // A valid claim left behind is recoverable by a later contender.
    }
  }
}

interface OwnerStampedLockReceipt {
  lockDir: string; tokenDir: string; owner: LockOwner & { token: string };
}

interface AuditLockReceipt extends OwnerStampedLockReceipt {
  identityKey: string;
  releasePending: boolean;
}

function ownerReceiptMatches(receipt: OwnerStampedLockReceipt): boolean {
  return stampMatches(receipt.lockDir, receipt.owner);
}

type LockReleaseOutcome = "released" | "not-owner" | "retryable";

function releaseOwnerStampedLock(
  receipt: OwnerStampedLockReceipt,
  applyFaultHooks = true,
  applyGateFaultHooks = false,
): LockReleaseOutcome {
  let checked = false;
  for (let attempt = 0; attempt <= 100; attempt++) {
    const current = inspectOwnerStamp(receipt.lockDir);
    if (current.status === "missing" && !existsSync(receipt.lockDir)) return "not-owner";
    if (current.status !== "ok") {
      if (attempt < 100) Bun.sleepSync(5);
      continue;
    }
    if (!ownerStampsEqual(current.owner, receipt.owner)) return "not-owner";
    if (!checked && applyFaultHooks) {
      checked = true;
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterReleaseOwnerCheck?.(receipt.lockDir);
    }
    const retired = `${receipt.lockDir}.released.${receipt.owner.token}.${randomUUID()}`;
    if (applyFaultHooks) {
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.beforeReleaseRename?.(retired, attempt);
    }
    if (
      applyFaultHooks &&
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.failReleaseRename?.(retired, attempt)
    ) {
      if (attempt < 100) Bun.sleepSync(5);
      continue;
    }
    if (
      applyGateFaultHooks &&
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.failGateReleaseRename?.(
        retired,
        attempt,
      )
    ) {
      if (attempt < 100) Bun.sleepSync(5);
      continue;
    }
    try {
      renameSync(receipt.lockDir, retired);
      try { rmSync(retired, { recursive: true, force: true }); } catch { /* private debris */ }
      return "released";
    } catch {
      if (attempt < 100) Bun.sleepSync(5);
    }
  }
  return "retryable";
}

function releaseCanonicalOwnerStampedLock(
  receipt: OwnerStampedLockReceipt,
): LockReleaseOutcome {
  const gate = acquireReapClaim(receipt.lockDir);
  if (!gate) return "retryable";
  try {
    return releaseOwnerStampedLock(receipt);
  } finally {
    releaseReapClaim(gate);
  }
}

function abandonUnstampedUnderGate(lockDir: string, token: string): void {
  // Only a successfully-created token directory proves this process owns the
  // unstamped generation. The caller holds the coordination gate throughout.
  if (!existsSync(join(lockDir, token))) return;
  const retired = `${lockDir}.failed.${randomUUID()}`;
  let moved = false;
  for (let attempt = 0; attempt <= 100; attempt++) {
    try {
      renameSync(lockDir, retired);
      moved = true;
      break;
    } catch {
      if (!existsSync(join(lockDir, token))) return;
      if (attempt < 100) Bun.sleepSync(5);
    }
  }
  if (!moved) return;
  if (!existsSync(join(retired, token))) {
    restoreReapPrivate(lockDir, retired);
    return;
  }
  try { rmSync(retired, { recursive: true, force: true }); } catch { /* private debris */ }
}

function acquireOwnerStampedLock(
  lockDir: string,
  maxRetries: number,
  retryMs: number,
  reapLiveOwnerAfterStale = true,
): OwnerStampedLockReceipt | null {
  const create = (): OwnerStampedLockReceipt | null => {
    const gate = acquireReapClaim(lockDir);
    if (!gate) return null;
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      const token = randomUUID();
      const tokenDir = join(lockDir, token);
      try {
        mkdirSync(tokenDir, { mode: 0o700 });
      } catch {
        abandonUnstampedUnderGate(lockDir, token);
        return null;
      }
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.beforeAcquirerOwnerStamp?.(
        lockDir,
        token,
      );
      const owner = writeOwnerStamp(lockDir, reapLiveOwnerAfterStale, token);
      if (!owner?.token) {
        abandonUnstampedUnderGate(lockDir, token);
        return null;
      }
      const receipt: OwnerStampedLockReceipt = {
        lockDir,
        tokenDir,
        owner: owner as LockOwner & { token: string },
      };
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      return null;
    } finally {
      releaseReapClaim(gate);
    }
  };
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const acquired = create();
    if (acquired) return acquired;
    if (reapStaleLock(lockDir)) {
      const afterReap = create();
      if (afterReap) return afterReap;
    }
    if (attempt < maxRetries) Bun.sleepSync(retryMs);
  }
  return null;
}

export type OwnerStampedLockRun<T> =
  | { acquired: false }
  | { acquired: true; value: T };

export function runWithOwnerStampedLock<T>(
  lockDir: string,
  maxRetries: number,
  retryMs: number,
  action: () => T,
): OwnerStampedLockRun<T> {
  const receipt = acquireOwnerStampedLock(lockDir, maxRetries, retryMs);
  if (!receipt) return { acquired: false };
  const onExit = () => {
    releaseCanonicalOwnerStampedLock(receipt);
  };
  process.on("exit", onExit);
  try {
    return { acquired: true, value: action() };
  } finally {
    const outcome = releaseCanonicalOwnerStampedLock(receipt);
    if (outcome !== "retryable") process.off("exit", onExit);
  }
}

function acquireActiveDirectiveLock(lockDir: string): OwnerStampedLockReceipt | null {
  return acquireOwnerStampedLock(lockDir, 100, 10);
}

// Receipts, reentrancy, and exit handlers are keyed by the acquisition-bound
// canonical lock identity. Stable lexical request bindings preserve that
// identity across path materialization/active-space changes, while an
// equivalent existing symlink or Windows-case alias resolves directly to the
// same canonical identity.
const AUDIT_LOCK_RECEIPTS = new Map<string, AuditLockReceipt>();
const AUDIT_LOCK_REQUEST_BINDINGS = new Map<string, string>();

function unregisterAuditLockHandler(identityKey: string): void {
  const handler = AUDIT_LOCK_EXIT_HANDLERS.get(identityKey);
  if (!handler) return;
  process.off("exit", handler);
  AUDIT_LOCK_EXIT_HANDLERS.delete(identityKey);
}

function removeAuditRequestBindings(identityKey: string): void {
  for (const [requestKey, boundIdentity] of AUDIT_LOCK_REQUEST_BINDINGS) {
    if (boundIdentity === identityKey) AUDIT_LOCK_REQUEST_BINDINGS.delete(requestKey);
  }
}

function releaseAuditReceipt(identityKey: string): boolean {
  const receipt = AUDIT_LOCK_RECEIPTS.get(identityKey);
  if (!receipt) {
    unregisterAuditLockHandler(identityKey);
    removeAuditRequestBindings(identityKey);
    return true;
  }
  const outcome = releaseCanonicalOwnerStampedLock(receipt);
  if (outcome === "retryable") {
    receipt.releasePending = true;
    return false;
  }
  AUDIT_LOCK_RECEIPTS.delete(identityKey);
  unregisterAuditLockHandler(identityKey);
  removeAuditRequestBindings(identityKey);
  return true;
}

function auditLockBoundIdentity(
  projectDir: string,
  intent?: string,
  space?: string,
): { requestKey: string; identityKey: string } {
  const requestKey = auditLockRequestKey(projectDir, intent, space);
  return {
    requestKey,
    identityKey:
      AUDIT_LOCK_REQUEST_BINDINGS.get(requestKey) ??
      auditLockIdentity(projectDir, intent, space),
  };
}

export function acquireAuditLock(
  projectDir: string,
  maxRetries = 50,
  retryMs = 100,
  intent?: string,
  space?: string,
  reapLiveOwnerAfterStale = true,
): boolean {
  const { requestKey, identityKey } = auditLockBoundIdentity(
    projectDir,
    intent,
    space,
  );
  const existing = AUDIT_LOCK_RECEIPTS.get(identityKey);
  if (existing) {
    if (!existing.releasePending || !releaseAuditReceipt(identityKey)) return false;
  }
  const lockDir = auditLockDir(projectDir, intent, space);
  const receipt = acquireOwnerStampedLock(
    lockDir,
    maxRetries,
    retryMs,
    reapLiveOwnerAfterStale,
  );
  if (!receipt) return false;
  AUDIT_LOCK_RECEIPTS.set(identityKey, {
    ...receipt,
    identityKey,
    releasePending: false,
  });
  AUDIT_LOCK_REQUEST_BINDINGS.set(requestKey, identityKey);
  return true;
}

export function releaseAuditLock(projectDir: string, intent?: string, space?: string): void {
  const { requestKey, identityKey } = auditLockBoundIdentity(
    projectDir,
    intent,
    space,
  );
  if (AUDIT_LOCK_RECEIPTS.has(identityKey)) {
    AUDIT_LOCK_REQUEST_BINDINGS.set(requestKey, identityKey);
  }
  releaseAuditReceipt(identityKey);
}

/** True only while `ownerPid` is the live process stamped into this lock.
 *  Used by synchronous child tools whose parent deliberately keeps the
 *  workspace lock held across the child's work. */
export function auditLockOwnedByProcess(
  projectDir: string,
  ownerPid: number,
  intent?: string,
  space?: string,
): boolean {
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return false;
  const owner = readOwnerStamp(auditLockDir(projectDir, intent, space));
  if (owner?.pid !== ownerPid) return false;
  const state = ownerProcessState(owner);
  return state === "same" || state === "unknown";
}

// Tracks per-identity exit handlers that release the audit lock if a caller
// process.exit()s while still holding it. Bun's process.exit skips `finally`
// blocks, so a tool that wraps locked work in try/finally and then calls
// errorWithSlug → emitError → process.exit will leak the lock dir without
// this safety net. Lock acquire registers a handler; release deregisters.
// Keyed on the canonical acquisition identity; lexical request bindings route
// path/active-space drift back to that identity.
const AUDIT_LOCK_EXIT_HANDLERS = new Map<string, () => void>();

// Per-IDENTITY reentrancy depth. Equivalent aliases therefore share depth while
// a materialized-path request remains bound to the identity it acquired.
// Same-process nested withAuditLock calls would otherwise self-deadlock — the inner mkdir hits
// EEXIST against the lock the outer caller already holds, and burns the
// retry budget (50 × 100ms = 5s) before throwing. The depth counter makes the
// primitive reentrant: the outer call performs the OS-level lock acquire/release;
// inner calls just bump depth and return. Cross-process locking is unaffected —
// different processes still serialise via mkdir EEXIST. Keyed on the composite
// identity so two intents/explicit spaces in one process don't share a depth.
const AUDIT_LOCK_DEPTH = new Map<string, number>();

// writeFileAtomic — non-corrupting variant of writeFileSync. Writes to a
// writer-unique sibling temp then POSIX-renames into place atomically. Readers
// of <path> see either the previous version or the new one — never a
// half-written file. Pair with withAuditLock when concurrent writers
// must serialise (rename alone defeats half-writes but not lost updates).
//
// Sibling temp keeps the rename on the same filesystem so it's a true
// atomic rename (cross-fs renames degrade to copy-then-unlink). A unique,
// exclusively-created temp prevents concurrent unlocked writers from
// truncating or renaming each other's in-flight data. Cleans up only the temp
// owned by this invocation on write/rename failure.
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let ownsTmp = false;
  try {
    fd = openSync(tmp, "wx");
    ownsTmp = true;
    writeFileSync(fd, data, "utf-8");
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    ownsTmp = false;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original error */ }
    }
    if (ownsTmp) {
      try { unlinkSync(tmp); } catch { /* temp may already be gone */ }
    }
    throw err;
  }
}

// writeBufferAtomic — the byte-exact twin of writeFileAtomic for binary
// payloads: a captured PDF, an image, any non-text source. Same exclusive-create
// sibling-temp-then-rename discipline, deliberately sharing writeFileAtomic's
// shape so the two cannot drift; the only difference is no utf-8 coercion, so
// the bytes round-trip identical to the source and stay sha256-verifiable.
export function writeBufferAtomic(path: string, data: Buffer | Uint8Array): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let ownsTmp = false;
  try {
    fd = openSync(tmp, "wx");
    ownsTmp = true;
    writeFileSync(fd, data);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    ownsTmp = false;
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original error */ }
    }
    if (ownsTmp) {
      try { unlinkSync(tmp); } catch { /* temp may already be gone */ }
    }
    throw err;
  }
}

// ensureDirSync / renameIntoPlace / removeTreeSync — the three raw
// mkdir/rename/rm primitives, re-exported so a caller that has NO reason to
// import node:fs's mutating names directly still can. This module already
// calls mkdirSync/renameSync/rmSync internally (its own lock/atomic-write
// mechanism has no funnel above it — it IS the funnel); these thin wrappers
// exist for callers like aidlc-knowledge.ts, whose linter override forbids
// binding any node:fs name outside the small read-only allowlist, so every
// directory-create, rename, and recursive-remove in that file must come from
// here instead. No added behavior beyond the raw primitive — the point is the
// IMPORT BOUNDARY, not a new atomicity guarantee (mkdir/rename/rm already are
// what they are).
export function ensureDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function renameIntoPlace(from: string, to: string): void {
  renameSync(from, to);
}

export function removeTreeSync(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

// Parse an anchor-relative boundary path into components without first
// normalizing away `..`. win32.parse recognises both slash families on every
// host and preserves Windows drive/UNC roots, so a POSIX slash cannot hide a
// component from a native Windows walk and a Windows root cannot become a
// relative filename on POSIX.
function boundaryRelativePartsOrThrow(anchorReal: string, rel: string): string[] {
  if (win32.parse(rel).root !== "") {
    throw new Error(`path escapes its anchor lexically: ${rel}`);
  }

  const parts: string[] = [];
  let cursor = rel;
  while (cursor !== "" && cursor !== ".") {
    const parsed = win32.parse(cursor);
    if (parsed.root !== "") {
      throw new Error(`path escapes its anchor lexically: ${rel}`);
    }
    if (parsed.base !== "" && parsed.base !== ".") {
      parts.unshift(parsed.base);
    }
    if (parsed.dir === "" || parsed.dir === ".") break;
    if (parsed.dir === cursor) {
      throw new Error(`path escapes its anchor lexically: ${rel}`);
    }
    cursor = parsed.dir;
  }

  if (parts.some((part) => part === "..")) {
    throw new Error(`path component ".." escapes its anchor ${anchorReal}: ${rel}`);
  }
  return parts;
}

// Walk `rel` one component at a time from a REAL anchor and refuse if ANY
// component is a symlink or junction, returning the joined native path when the
// whole chain is clean. Both slash families delimit components. Throws (does
// not exit) so each caller attaches its own message and code.
//
// Why per-COMPONENT rather than one realpath of the leaf: a containment check on
// the fully-resolved leaf answers "does this land inside?" but not "did we travel
// through something that could be repointed later". Checking each component is
// what makes the guard hold for a directory that does not exist yet, too — a
// missing component cannot redirect anything, so it is skipped rather than failed.
//
// This is the primitive behind "every leaf is checked, not just the dir": a walk
// that validates the container and then trusts its contents will happily read a
// symlinked file inside an already-trusted directory. Callers must run this for
// each leaf they touch, not once for the parent.
export function assertNoSymlinkInChainOrThrow(anchorReal: string, rel: string): string {
  if (rel === "") return anchorReal;
  const parts = boundaryRelativePartsOrThrow(anchorReal, rel);
  let current = anchorReal;
  for (const part of parts) {
    if (part.length === 0) continue;
    const child = join(current, part);
    let isSymlink = false;
    try {
      isSymlink = lstatSync(child).isSymbolicLink();
    } catch {
      // Does not exist yet — nothing to redirect through.
    }
    if (isSymlink) {
      throw new Error(
        `${child} is a symlink, and no path component may be a symlink here. ` +
          `A redirected container directory is refused exactly like a symlink found ` +
          `INSIDE an already-trusted one.`,
      );
    }
    current = child;
  }
  return current;
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function sameFileIdentity(
  left: FileIdentity,
  right: FileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

// THE read boundary for any path that came from OUTSIDE the workspace — a CLI
// flag, a value-transport file, a committed ledger row. Returns the contents of a
// REGULAR file or throws; it never blocks indefinitely and never follows a link.
//
// It lives here, shared, because scoping this check to one tool is what let the
// same defect ship twice. Two properties, both load-bearing:
//
//   TYPE. Only a regular file is read. Rejecting symlinks alone is a denylist
//   that admits every other kind: a FIFO with no writer blocks forever (and if
//   the caller holds a lock, it blocks the whole workspace with it), and a
//   character device such as /dev/zero never reaches EOF, so the read grows a
//   buffer until the process dies of ENOMEM.
//
//   TIME. `lstat(path)` then `readFileSync(path)` validates one file and reads
//   another if something swapped the name in between — and readFileSync follows
//   symlinks, so the swap can redirect the read to any file this process can
//   read. Opening ONCE with O_NOFOLLOW and fstat-ing THAT descriptor makes the
//   final-component identity checked the identity read. A caller that validated
//   parent-chain containment first passes an expected identity or real path as
//   well, binding the opened descriptor to the file observed while that
//   containment held.
//
// Throws (does not exit) so each caller can attach its own flag name and exit
// code. `what` names the thing in the message: "--text-file", "source", ….
export function readRegularFileNoFollowOrThrow(
  path: string,
  what: string,
  maxBytes?: number,
  expected?: FileIdentity | string,
): Buffer;

export function readRegularFileNoFollowOrThrow(
  path: string,
  what: string,
  maxBytes: number | undefined,
  expected: FileIdentity | string | undefined,
  withSnapshot: true,
): { bytes: Buffer; mtimeMs: number };

export function readRegularFileNoFollowOrThrow(
  path: string,
  what: string,
  maxBytes?: number,
  expected?: FileIdentity | string,
  withSnapshot = false,
): Buffer | { bytes: Buffer; mtimeMs: number } {
  const expectedIdentity = typeof expected === "object" ? expected : undefined;
  const expectedRealPath = typeof expected === "string" ? expected : undefined;
  let fd: number;
  try {
    // O_NONBLOCK matters as much as O_NOFOLLOW here, and for a non-obvious
    // reason: opening a FIFO for reading BLOCKS IN open() until a writer appears,
    // so without it the process hangs before fstat can report the kind and reject
    // it. (Measured: the fix looked complete while a FIFO still hung, and a stack
    // sample showed the process parked in open(), not read().) O_NONBLOCK is
    // harmless for a regular file — it does not make reads short — and the
    // descriptor is rejected below anyway if it is not a regular file.
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | fsConstants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error(`${what} is a symlink, which is not followed: ${path}`);
    }
    // Preserve the errno so callers (the atomic-replace retry wrapper, shard
    // readers distinguishing a vanished file) can dispatch on it.
    const err = new Error(`${what} could not be opened: ${path} (${errorMessage(e)})`);
    (err as NodeJS.ErrnoException).code = code;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (
      expectedIdentity !== undefined &&
      !sameFileIdentity(st, expectedIdentity)
    ) {
      throw changedDuringReadError(
        `${what} changed after project-containment validation: ${path}`,
      );
    }
    if (!st.isFile()) {
      const kind = st.isFIFO()
        ? "a FIFO / named pipe"
        : st.isSocket()
          ? "a socket"
          : st.isCharacterDevice()
            ? "a character device"
            : st.isBlockDevice()
              ? "a block device"
              : st.isDirectory()
                ? "a directory"
                : "not a regular file";
      throw new Error(
        `${what} is not a regular file (${kind}): ${path}. ` +
          `Only regular files are read — a FIFO, socket, or device file can block ` +
          `forever or never reach EOF, so it is refused before any read.`,
      );
    }
    if (st.nlink !== 1) {
      throw new Error(
        `${what} is multiply linked (a hardlink) and is not trusted: ${path}. ` +
          `A hardlink can alias content from elsewhere on the filesystem into this ` +
          `directory. Replace it with an independent copy — ` +
          `cp <file> <file>.copy && mv <file>.copy <file> — and re-run.`,
      );
    }
    if (maxBytes !== undefined && st.size > maxBytes) {
      throw new Error(
        `${what} is ${st.size} bytes, above the ${maxBytes}-byte limit: ${path}. ` +
          `Reduce the file before retrying.`,
      );
    }
    // Fallback for platforms without O_NOFOLLOW, and a pathname/descriptor
    // identity check for races on every platform.
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${what} is a symlink, which is not followed: ${path}`);
    }
    const currentRealPath = realpathSync(path);
    if (
      expectedRealPath !== undefined &&
      currentRealPath !== expectedRealPath
    ) {
      throw new Error(
        `${what} resolved outside its prevalidated path: ${path} -> ${currentRealPath}. ` +
          `No path component may be replaced by a symlink while the file is read.`,
      );
    }
    const current = statSync(currentRealPath);
    if (current.dev !== st.dev || current.ino !== st.ino) {
      throw changedDuringReadError(`${what} changed while opening: ${path}`);
    }
    let bytes: Buffer;
    if (maxBytes === undefined) {
      bytes = readFileSync(fd);
    } else {
      // The stat check rejects files already over the cap. Bound the descriptor
      // read as well so a file that grows concurrently cannot force an
      // allocation beyond its original size plus one detection byte.
      const bounded = Buffer.alloc(Math.min(maxBytes + 1, st.size + 1));
      let length = 0;
      while (length < bounded.length) {
        const count = readSync(
          fd,
          bounded,
          length,
          bounded.length - length,
          length,
        );
        if (count === 0) break;
        length += count;
      }
      if (length > maxBytes) {
        const currentSize = fstatSync(fd).size;
        throw new Error(
          `${what} is ${currentSize} bytes, above the ${maxBytes}-byte limit: ${path}. ` +
            "Reduce the file before retrying.",
        );
      }
      bytes = bounded.subarray(0, length);
    }
    const afterRealPath = realpathSync(path);
    if (
      expectedRealPath !== undefined &&
      afterRealPath !== expectedRealPath
    ) {
      throw new Error(
        `${what} resolved outside its prevalidated path while being read: ${path} -> ${afterRealPath}. ` +
          `No path component may be replaced by a symlink while the file is read.`,
      );
    }
    const after = statSync(afterRealPath);
    const afterFd = fstatSync(fd);
    if (after.dev !== st.dev || after.ino !== st.ino ||
        afterFd.nlink !== 1 || afterFd.size !== st.size ||
        afterFd.mtimeMs !== st.mtimeMs || afterFd.ctimeMs !== st.ctimeMs ||
        bytes.length !== st.size) {
      throw changedDuringReadError(`${what} changed while reading: ${path}`);
    }
    return withSnapshot ? { bytes, mtimeMs: st.mtimeMs } : bytes;
  } finally {
    closeSync(fd);
  }
}

/** The identity/equality throws above carry a typed code so callers can tell
 *  "the name changed inodes under me" (retryable when the writer is a known
 *  atomic-replacer) from a symlink/kind/permission refusal (never retried). */
export const FILE_CHANGED_DURING_READ = "AIDLC_FILE_CHANGED_DURING_READ";
function changedDuringReadError(message: string): Error {
  const err = new Error(message);
  (err as NodeJS.ErrnoException).code = FILE_CHANGED_DURING_READ;
  return err;
}

// The read boundary for FRAMEWORK-OWNED files whose ONLY writer is
// writeFileAtomic/writeBufferAtomic (tmp + rename) — documentkb/index.json,
// per-document metadata.json, derived content.md, the sources alias map.
//
// An atomic replace swaps the inode behind the name, which the strict
// reader's identity check cannot distinguish from a hostile name-swap — so a
// read racing a legitimate concurrent writer threw "changed while opening"
// and killed the whole command (measured: 2-3 of 24 concurrent onboards
// under load). The swap is instantaneous, so the fix is a bounded retry:
// each attempt re-runs the FULL boundary check from open, a hostile swap
// (symlink, wrong kind) throws a NON-retryable refusal on its next attempt,
// and a replace-storm that outlasts every retry propagates the original
// error honestly.
export function readAtomicReplacedFileNoFollowOrThrow(
  path: string,
  what: string,
  attempts = 8,
): Buffer {
  for (let attempt = 1; ; attempt++) {
    try {
      return readRegularFileNoFollowOrThrow(path, what);
    } catch (e) {
      // ENOENT is retryable here too, not only the identity code: mid-swap,
      // realpath of the just-unlinked inode can surface as a transient
      // ENOENT (measured on Bun as a literal "<path> (deleted)" statx). For
      // a file whose writer is atomic-replace, "briefly absent" IS the swap
      // window; a file that is genuinely gone still propagates once the
      // retries are exhausted.
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== FILE_CHANGED_DURING_READ && code !== "ENOENT") ||
          attempt >= attempts) {
        throw e;
      }
      // 5ms × attempt backoff: the rename itself is instantaneous; the wait
      // only needs to outlast the writer's tmp-write + rename window.
      Bun.sleepSync(5 * attempt);
    }
  }
}

// The read boundary for FRAMEWORK-OWNED APPEND-ONLY files — audit shards.
// Same open-once O_NOFOLLOW|O_NONBLOCK discipline as
// readRegularFileNoFollowOrThrow (TYPE and TIME both hold: only a regular
// file is read, and the identity fstat-ed is the identity read), with two
// deliberate relaxations the strict reader must not make and a shard reader
// must:
//
//   GROWTH IS NORMAL. A live ledger is being appended to by hooks and verbs
//   while readers scan it. The strict reader's size/mtime/ctime equality
//   check therefore threw on the ledger's NORMAL state — measured: under a
//   concurrent appender ~88% of strict reads failed — and every consumer's
//   catch then dropped the ENTIRE shard, silently erasing history from
//   graph rebuilds, review-budget counts, receipt freshness, and the
//   human-presence gate. A torn TAIL block is harmless by construction:
//   every audit parser requires a complete block (Event + Timestamp + the
//   `\n---\n` terminator) and discards a partial one.
//
//   NLINK IS NOT A TRUST SIGNAL HERE. rsync --link-dest and cp -al backup
//   snapshots leave live project files with nlink 2; refusing them made one
//   backup run brick every later audit read. Hardlinks cannot redirect a
//   contained, symlink-chain-checked path — they alias the same inode — so
//   the strict reader keeps its nlink refusal only where the CONTENT is
//   untrusted (customer documents) or the operation is an explicit
//   fork/merge snapshot.
export function readAppendOnlyFileNoFollowOrThrow(path: string, what: string): Buffer {
  let fd: number;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | fsConstants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new Error(`${what} is a symlink, which is not followed: ${path}`);
    }
    const err = new Error(`${what} could not be opened: ${path} (${errorMessage(e)})`);
    (err as NodeJS.ErrnoException).code = code;
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) {
      throw new Error(`${what} is not a regular file: ${path}`);
    }
    // Fallback for platforms without O_NOFOLLOW, and a pathname/descriptor
    // identity check for races on every platform.
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`${what} is a symlink, which is not followed: ${path}`);
    }
    const current = statSync(realpathSync(path));
    if (current.dev !== st.dev || current.ino !== st.ino) {
      throw new Error(`${what} changed while opening: ${path}`);
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

// withAuditLock — atomic locked-section helper. Acquires the audit lock,
// installs an exit-handler safety net (so a process.exit inside `fn` still
// releases the lock dir), runs `fn`, releases the lock. Use this when you
// need to hold the lock across multiple reads/writes (e.g., audit-first
// state mutations that emit audit + write state atomically).
//
// Reentrant within a single process for the same projectDir: nested calls
// just bump depth and run `fn`; only the outermost call performs OS-level
// acquire/release. Cross-process locking is unchanged.
//
// SYNC ONLY. The return type excludes Promise so a caller can't pass an
// async function that releases the lock before its work settles. Today's
// callers are all sync (compile, state.ts fork/merge); future async-locked
// transactions need a separate `withAuditLockAsync` that awaits before
// release. The compile-time guard catches the footgun at the call site.
export function withAuditLock<T>(
  projectDir: string,
  fn: () => T extends Promise<unknown> ? never : T,
  intent?: string,
  space?: string,
  // Acquire budget (default ~5s). A caller that legitimately waits behind a
  // long-lived holder (select-plugins behind a full plugin compose: compile +
  // runner regeneration) passes a larger budget; dead holders are reaped
  // immediately regardless, so a big budget only ever waits on live work.
  maxRetries = 50,
  retryMs = 100,
  // Long external operations can opt out of over-age doctor classification.
  // Automatic acquisition never reaps a live owner regardless of this flag;
  // provably-dead owners remain immediately reclaimable.
  reapLiveOwnerAfterStale = true,
): T extends Promise<unknown> ? never : T {
  const requestKey = auditLockRequestKey(projectDir, intent, space);
  let key =
    AUDIT_LOCK_REQUEST_BINDINGS.get(requestKey) ??
    auditLockIdentity(projectDir, intent, space);
  const currentDepth = AUDIT_LOCK_DEPTH.get(key) ?? 0;
  if (currentDepth === 0) {
    if (
      !acquireAuditLock(
        projectDir,
        maxRetries,
        retryMs,
        intent,
        space,
        reapLiveOwnerAfterStale,
      )
    ) {
      throw new Error(`Failed to acquire audit lock for ${key} after retries`);
    }
    key = AUDIT_LOCK_REQUEST_BINDINGS.get(requestKey) ?? key;
    const receipt = AUDIT_LOCK_RECEIPTS.get(key);
    if (!receipt) {
      throw new Error(`Audit lock receipt missing after acquire for ${key}`);
    }
    // Safety net: if the body calls process.exit (Bun skips `finally` in that
    // case), the on-exit handler releases the lock dir so the project isn't
    // poisoned for ~5s on the next invocation.
    const onExit = () => { releaseCanonicalOwnerStampedLock(receipt); };
    AUDIT_LOCK_EXIT_HANDLERS.set(key, onExit);
    process.on("exit", onExit);
  }
  AUDIT_LOCK_DEPTH.set(key, currentDepth + 1);
  try {
    return fn();
  } finally {
    const depth = AUDIT_LOCK_DEPTH.get(key) ?? 0;
    if (depth <= 1) {
      AUDIT_LOCK_DEPTH.delete(key);
      releaseAuditLock(projectDir, intent, space);
    } else {
      AUDIT_LOCK_DEPTH.set(key, depth - 1);
    }
  }
}

// True iff THIS process currently holds the audit lock for the given request
// via an outer withAuditLock. The lock-acquire path registers a per-request exit
// handler and the release path removes it (see
// AUDIT_LOCK_EXIT_HANDLERS), so the handler's presence is the in-lock signal.
// emitError (below) already branches on this to pick appendAuditEntryUnlocked
// vs appendAuditEntry; the state tool's emitAudit helper uses it for the same
// reason — an audit emit issued from inside a held lock MUST use the unlocked
// variant or it self-deadlocks against the lock it is already holding
// (appendAuditEntry calls acquireAuditLock, which is NOT reentrant — only
// withAuditLock's depth counter is — so it would burn the full 50×100ms retry
// budget and then throw).
export function holdsAuditLock(projectDir: string, intent?: string, space?: string): boolean {
  const { identityKey } = auditLockBoundIdentity(projectDir, intent, space);
  return AUDIT_LOCK_EXIT_HANDLERS.has(identityKey);
}

// --- Doctor probe: leaked audit locks ----------------------------------------
//
// Doctor surfaces provably-dead, old missing-stamp, over-age live, malformed,
// and unreadable locks. Automatic clear is restricted to dead valid owners and
// old genuinely-missing stamps; every ambiguous/live case remains fail-closed.
// We can't enumerate tmpdir() hashes back to
// projects, so we probe the buckets THIS project would use: the workspace
// sentinel bucket + every intent record across every space (the same identities
// the writers key on). A leaked lock is reported with its bucket + owner PID.

export interface LeakedLock {
  bucket: string; // "__workspace__" or "<space>/<intent>"
  lockDir: string; ownerPid: number | null;
  reason:
    | "dead-owner"
    | "over-age"
    | "unstamped"
    | "invalid-owner"
    | "unreadable-owner"
    | "generation-unavailable"
    | "released-gate"
    | "legacy-transaction";
  kind:
    | "audit"
    | "active-directive"
    | "coordination-gate"
    | "legacy-active-directive-transaction";
  cleared: boolean;
}

function clearCoordinationGate(
  lockDir: string,
  expectedOwner: LockOwner,
  reason: "released-gate" | "dead-owner",
): boolean {
  const mutex = acquireNativeGateMutex(lockDir);
  if (!mutex) return false;
  try {
    const gateDir = reapClaimDir(lockDir);
    const current = inspectOwnerStamp(gateDir);
    if (
      current.status !== "ok" ||
      !ownerStampsEqual(current.owner, expectedOwner)
    ) return false;
    if (reason === "released-gate") {
      AUDIT_LOCK_FAULT_HOOKS_FOR_TESTS?.afterReleasableGateCheck?.(gateDir);
      return (
        reapGateReleaseState(gateDir, current.owner) === "releasable" &&
        retireReapClaim(gateDir)
      );
    }
    const state = ownerProcessState(current.owner);
    return (
      (state === "dead" || state === "different") &&
      recoverReapClaim(lockDir, current.owner)
    );
  } finally {
    releaseNativeGateMutex(mutex);
  }
}

// Detect (and safely clear eligible) leaked locks for this project. Returns the
// findings and whether each was cleared. Pure-read when clear=false.
export function detectLeakedLocks(projectDir: string, clear = false): LeakedLock[] {
  const leaks: LeakedLock[] = [];
  const probeCoordinationGate = (
    bucketLabel: string,
    lockDir: string,
  ): void => {
    const gateDir = reapClaimDir(lockDir);
    if (!existsSync(gateDir)) return;
    const inspected = inspectOwnerStamp(gateDir);
    if (inspected.status === "invalid" || inspected.status === "unreadable") {
      leaks.push({
        bucket: bucketLabel,
        lockDir: gateDir,
        ownerPid: null,
        reason: inspected.status === "invalid" ? "invalid-owner" : "unreadable-owner",
        kind: "coordination-gate",
        cleared: false,
      });
      return;
    }
    if (inspected.status === "ok") {
      const releaseState = reapGateReleaseState(gateDir, inspected.owner);
      if (releaseState === "invalid") {
        leaks.push({
          bucket: bucketLabel,
          lockDir: gateDir,
          ownerPid: inspected.owner.pid,
          reason: "invalid-owner",
          kind: "coordination-gate",
          cleared: false,
        });
        return;
      }
      if (releaseState !== "releasable") {
        const state = ownerProcessState(inspected.owner);
        if (state === "dead" || state === "different") {
          const cleared = clear
            ? clearCoordinationGate(lockDir, inspected.owner, "dead-owner")
            : false;
          leaks.push({
            bucket: bucketLabel,
            lockDir: gateDir,
            ownerPid: inspected.owner.pid,
            reason: "dead-owner",
            kind: "coordination-gate",
            cleared,
          });
        }
        return;
      }
      const cleared = clear
        ? clearCoordinationGate(lockDir, inspected.owner, "released-gate")
        : false;
      leaks.push({
        bucket: bucketLabel,
        lockDir: gateDir,
        ownerPid: inspected.owner.pid,
        reason: "released-gate",
        kind: "coordination-gate",
        cleared,
      });
      return;
    }
  };
  const probe = (bucketLabel: string, intent?: string, space?: string): void => {
    const lockDir = auditLockDir(projectDir, intent, space);
    probeCoordinationGate(bucketLabel, lockDir);
    if (!existsSync(lockDir)) return;
    const inspected = inspectOwnerStamp(lockDir);
    const owner = inspected.status === "ok" ? inspected.owner : null;
    let reason: LeakedLock["reason"] | null = null;
    if (inspected.status === "invalid") {
      reason = "invalid-owner";
    } else if (inspected.status === "unreadable") {
      reason = "unreadable-owner";
    } else if (inspected.status === "missing") {
      // Unstamped: only a leak if older than the mid-acquire grace window (else
      // a live process is between mkdir and stamp).
      const mtime = lockDirMtimeMs(lockDir);
      if (mtime !== null && lockAcquireEpochMs() - mtime > unstampedGraceMs()) {
        reason = "unstamped";
      }
    } else if (inspected.status === "ok") {
      const state = ownerProcessState(inspected.owner);
      if (state === "dead" || state === "different") {
        reason = "dead-owner";
      } else if (state === "unknown") {
        reason = "generation-unavailable";
      } else if (
        inspected.owner.reapLiveOwnerAfterStale &&
        lockAcquireEpochMs() - inspected.owner.startedAtMs > lockStaleMs()
      ) {
        reason = "over-age";
      }
    }
    if (reason === null) return; // a live, fresh, stamped lock is legitimately held
    const cleared = clear && (reason === "dead-owner" || reason === "unstamped")
      ? reapStaleLock(lockDir)
      : false;
    leaks.push({ bucket: bucketLabel, lockDir, ownerPid: owner?.pid ?? null, reason, kind: "audit", cleared });
  };
  const probeActiveDirective = (bucketLabel: string, root: string): void => {
    const lockDir = join(root, ACTIVE_DIRECTIVE_LOCK);
    probeCoordinationGate(bucketLabel, lockDir);
    if (existsSync(lockDir)) {
      const inspected = inspectOwnerStamp(lockDir);
      const owner = inspected.status === "ok" ? inspected.owner : null;
      let reason: LeakedLock["reason"] | null = null;
      if (inspected.status === "invalid") {
        reason = "invalid-owner";
      } else if (inspected.status === "unreadable") {
        reason = "unreadable-owner";
      } else if (inspected.status === "missing") {
        const mtime = lockDirMtimeMs(lockDir);
        if (mtime !== null && lockAcquireEpochMs() - mtime > unstampedGraceMs()) reason = "unstamped";
      } else if (inspected.status === "ok") {
        const state = ownerProcessState(inspected.owner);
        if (state === "dead" || state === "different") {
          reason = "dead-owner";
        } else if (state === "unknown") {
          reason = "generation-unavailable";
        } else if (
          inspected.owner.reapLiveOwnerAfterStale &&
          lockAcquireEpochMs() - inspected.owner.startedAtMs > lockStaleMs()
        ) {
          reason = "over-age";
        }
      }
      if (reason !== null) {
        const cleared = clear && (reason === "dead-owner" || reason === "unstamped")
          ? reapStaleLock(lockDir)
          : false;
        leaks.push({ bucket: bucketLabel, lockDir, ownerPid: owner?.pid ?? null, reason,
          kind: "active-directive", cleared });
      }
    }
    const legacy = join(root, `${ACTIVE_DIRECTIVE_MARKER}.transaction`);
    if (existsSync(legacy)) {
      leaks.push({ bucket: bucketLabel, lockDir: legacy, ownerPid: null, reason: "legacy-transaction",
        kind: "legacy-active-directive-transaction", cleared: false });
    }
  };
  // Workspace sentinel bucket.
  probe(WORKSPACE_LOCK_SENTINEL);
  // Every intent record across every space.
  const spacesRoot = join(workspaceRoot(projectDir), "spaces");
  let spaces: string[] = [];
  try { spaces = readdirSync(spacesRoot); } catch { /* no spaces dir */ }
  spaces = [...new Set([...spaces, activeSpace(projectDir)])];
  for (const sp of spaces) {
    probeActiveDirective(`${sp}/bare-space`, spaceRecordRoot(projectDir, sp));
    for (const intent of listIntentDirs(projectDir, sp)) {
      probe(`${sp}/${intent}`, intent, sp);
      probeActiveDirective(`${sp}/${intent}`, join(intentsDir(projectDir, sp), intent));
    }
  }
  // The flat-legacy project also keys on the workspace bucket for its writes, so
  // the sentinel probe above already covers it.
  return leaks;
}

// --- Audit event correlation ---
//
// Doctor (and future sensors / observers) need to walk audit blocks and
// correlate ERROR_LOGGED rows back to the operation that emitted them.
// The three regexes below match the slug-bearing tags shipped by the
// worktree primitive (`[slug=...]`), the audit fork/merge subcommands
// (`[fork-emitted:<ts>]`), and post-merge cleanup (`[merge-succeeded:<sha>]`).
// Promoted from inline literals so consumers reuse one definition.

export const SLUG_TAG_REGEX = /\[slug=([a-z0-9-]+)\]/;
export const FORK_EMITTED_TAG_REGEX = /\[fork-emitted:([^\]]+)\]/;
export const MERGE_SUCCEEDED_TAG_REGEX = /\[merge-succeeded:([^\]]+)\]/;

// findAllEvents — multi-match analogue of findLatestEvent (which lives
// tool-local in aidlc-worktree.ts and returns at most one match). Optional
// slug filter mirrors findLatestEvent's signature. Walks audit blocks from
// start; collects every block where **Event**: <event> matches (and
// **Bolt slug**: <slug> if slug provided). Returns [] on no match.
//
// Block separator is the same `\n---\n` aidlc-audit.ts uses on emit.
// Normalises CRLF → LF before splitting so audits authored or edited on
// Windows (Bun's PRE_REQ env per dist/claude/.claude/CLAUDE.md) parse
// the same as Unix audits. Without this, `\r\n---\r\n` doesn't match the
// `\n---\n` separator and every block past the first looks merged into one
// — silently masking every drift class.
export function findAllEvents(
  audit: string,
  event: string,
  slug?: string,
): { timestamp: string; block: string }[] {
  const results: { timestamp: string; block: string; pos: number }[] = [];
  const blocks = audit.replace(/\r\n/g, "\n").split(/\n---\n/);
  const eventRegex = new RegExp(`^\\*\\*Event\\*\\*:\\s*${escapeRegex(event)}\\s*$`, "m");
  const slugRegex = slug
    ? new RegExp(`^\\*\\*Bolt slug\\*\\*:\\s*${escapeRegex(slug)}\\s*$`, "m")
    : null;
  const tsRegex = /^\*\*Timestamp\*\*:\s*(\S+)/m;
  let pos = 0;
  for (const block of blocks) {
    if (!eventRegex.test(block)) {
      pos++;
      continue;
    }
    if (slugRegex && !slugRegex.test(block)) {
      pos++;
      continue;
    }
    const tsMatch = block.match(tsRegex);
    if (!tsMatch) {
      pos++;
      continue;
    }
    results.push({ timestamp: tsMatch[1], block, pos });
    pos++;
  }
  // CHRONOLOGICAL, not buffer-order. readAllAuditShards concatenates per-clone
  // shards in FILENAME order, so the raw buffer is NOT time-ordered across
  // shards — a `[len-1]` "newest" reader (buildWorkflowHeader, hasStageAuditEvent)
  // could otherwise pick an OLDER event from a lexically-later shard. ISO-8601
  // timestamps sort lexicographically; ties (same-ms events, or a single shard's
  // already-ordered blocks) break by buffer position to keep the within-shard
  // order stable. This makes the readAllAuditShards "ordering by timestamp is the
  // parsers' job" contract TRUE for every findAllEvents consumer.
  results.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.pos - b.pos;
  });
  return results.map(({ timestamp, block }) => ({ timestamp, block }));
}

// The freshness floor for one stage's swarm evidence: the timestamp of the
// stage's latest MAIN-WORKFLOW STAGE_STARTED row ("" when none). Rows from a
// `--single` stage-runner carry `Workflow: single-stage:<slug>` and never move
// the floor. Every (re-)entry into a stage lands a fresh STAGE_STARTED naming
// the slug (advance and jump both emit it). Retained as the secondary
// timestamp-order guard for attempt-scoped readers; exact identity comes from
// latestMainWorkflowStageRunFloor below.
export function latestMainWorkflowStageStarted(
  audit: string,
  slug: string,
): string {
  let since = "";
  for (const ev of findAllEvents(audit, "STAGE_STARTED")) {
    if (auditBlockField(ev.block, "Workflow")?.startsWith("single-stage:")) {
      continue;
    }
    if (auditBlockField(ev.block, "Stage") !== slug) continue;
    // findAllEvents returns chronological order; keep the latest.
    since = ev.timestamp;
  }
  return since;
}

export interface PipelineLinkReceipt {
  link: string;
  repo: string | null;
  position: string | null;
  timestamp: string;
  artifactPath: string | null;
  artifactSha256: string | null;
  artifactMtimeMs: number | null;
}

export interface PipelineLinkEvidence {
  links: string[];
  repos: string[];
  receipts: PipelineLinkReceipt[];
  reusedRepos: string[];
  completed: string[];
  missing: Array<{ link: string; repo: string | null }>;
}

export function pipelineLinks(
  stage: Pick<StageEntry, "lead_agent" | "support_agents">,
): string[] {
  return [stage.lead_agent, ...(stage.support_agents ?? [])];
}

type OrderedPipelineEvidenceEvent = AuditShardEvent;

function orderedPipelineEvidenceEvents(
  projectDir: string,
): OrderedPipelineEvidenceEvent[] {
  return readAuditShardEvents(projectDir).sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp < b.timestamp ? -1 : 1;
    }
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
}

interface PipelineAttemptFloor {
  timestamp: string;
  rows: OrderedPipelineEvidenceEvent[];
}

function pipelineAttemptFloor(
  events: OrderedPipelineEvidenceEvent[],
  stageSlug: string,
  singleRun: boolean,
): PipelineAttemptFloor | null {
  const workflow = `single-stage:${stageSlug}`;
  const boundaries = events.filter((entry) => {
    const eventWorkflow = auditBlockField(entry.block, "Workflow");
    if (
      !singleRun &&
      (
        entry.event === "WORKFLOW_STARTED" ||
        entry.event === "STAGE_JUMPED" ||
        (
          entry.event === "GATE_REJECTED" &&
          auditBlockField(entry.block, "Stage") === stageSlug
        )
      ) &&
      !eventWorkflow?.startsWith("single-stage:")
    ) {
      return true;
    }
    return (
      entry.event === "STAGE_STARTED" &&
      auditBlockField(entry.block, "Stage") === stageSlug &&
      (
        singleRun
          ? eventWorkflow === workflow
          : !eventWorkflow?.startsWith("single-stage:")
      )
    );
  });
  if (boundaries.length === 0) return null;
  const timestamp = boundaries[boundaries.length - 1].timestamp;
  return {
    timestamp,
    rows: boundaries.filter((entry) => entry.timestamp === timestamp),
  };
}

function pipelineEventAfterFloor(
  entry: OrderedPipelineEvidenceEvent,
  floor: PipelineAttemptFloor | null,
): boolean {
  if (floor === null) return true;
  if (entry.timestamp !== floor.timestamp) {
    return entry.timestamp > floor.timestamp;
  }
  const shards = new Set(floor.rows.map((row) => row.shard));
  if (shards.size !== 1) return false;
  const shard = floor.rows[0].shard;
  if (entry.shard !== shard) return false;
  const maxPos = Math.max(...floor.rows.map((row) => row.pos));
  return entry.pos > maxPos;
}

export function pipelineAttemptStartedAt(
  projectDir: string,
  stageSlug: string,
  options: { singleRun?: boolean } = {},
): string {
  const events = orderedPipelineEvidenceEvents(projectDir);
  const floor = pipelineAttemptFloor(
    events,
    stageSlug,
    options.singleRun === true,
  );
  return floor?.timestamp ?? "";
}

export function singleStageAttemptIsOpen(
  projectDir: string,
  stageSlug: string,
): boolean {
  const workflow = `single-stage:${stageSlug}`;
  const events = orderedPipelineEvidenceEvents(projectDir);
  const floor = pipelineAttemptFloor(events, stageSlug, true);
  if (floor === null) return false;
  const floorShards = new Set(floor.rows.map((row) => row.shard));
  if (floorShards.size !== 1) return false;
  const floorShard = floor.rows[0].shard;
  const floorPos = Math.max(...floor.rows.map((row) => row.pos));
  for (const entry of events) {
    if (
      entry.event !== "STAGE_COMPLETED" ||
      auditBlockField(entry.block, "Stage") !== stageSlug ||
      auditBlockField(entry.block, "Workflow") !== workflow
    ) {
      continue;
    }
    if (pipelineEventAfterFloor(entry, floor)) return false;
    if (
      entry.timestamp === floor.timestamp &&
      entry.shard !== floorShard
    ) {
      return false;
    }
    if (
      entry.timestamp === floor.timestamp &&
      entry.shard === floorShard &&
      entry.pos > floorPos
    ) {
      return false;
    }
  }
  return true;
}

// Current-attempt pipeline receipts are scoped to either the main workflow or
// one isolated `--single` stream. A later matching STAGE_STARTED resets that
// scope; main runs also reset on workflow starts, jumps, and gate rejection.
// Same-shard timestamp ties retain append order, while cross-shard ties fail
// closed because their causal order cannot be proven.
export function currentPipelineLinkReceipts(
  projectDir: string,
  stageSlug: string,
  options: { singleRun?: boolean } = {},
): PipelineLinkReceipt[] {
  const events = orderedPipelineEvidenceEvents(projectDir);
  const singleRun = options.singleRun === true;
  const workflow = `single-stage:${stageSlug}`;
  const floor = pipelineAttemptFloor(events, stageSlug, singleRun);
  const receipts: PipelineLinkReceipt[] = [];
  for (const entry of events) {
    if (!pipelineEventAfterFloor(entry, floor)) continue;
    const eventWorkflow = auditBlockField(entry.block, "Workflow");
    if (
      entry.event !== "PIPELINE_LINK_COMPLETED" ||
      auditBlockField(entry.block, "Stage") !== stageSlug ||
      (
        singleRun
          ? eventWorkflow !== workflow
          : eventWorkflow?.startsWith("single-stage:") === true
      )
    ) {
      continue;
    }
    const link = auditBlockField(entry.block, "Link");
    if (!link) continue;
    receipts.push({
      link,
      repo: auditBlockField(entry.block, "Repo"),
      position: auditBlockField(entry.block, "Position"),
      timestamp: entry.timestamp,
      artifactPath: auditBlockField(entry.block, "Artifact Path"),
      artifactSha256: auditBlockField(entry.block, "Artifact SHA256"),
      artifactMtimeMs: (() => {
        const value = auditBlockField(entry.block, "Artifact Mtime Ms");
        return value && /^[0-9]+(?:\.[0-9]+)?$/.test(value)
          ? Number(value)
          : null;
      })(),
    });
  }
  return receipts;
}

export function latestPipelineLinkArtifactMtime(
  projectDir: string,
  stageSlug: string,
  link: string,
  repo: string | null,
  options: { singleRun?: boolean } = {},
): number | null {
  const workflow = `single-stage:${stageSlug}`;
  const singleRun = options.singleRun === true;
  const events = orderedPipelineEvidenceEvents(projectDir);
  let latest: number | null = null;
  for (const entry of events) {
    const eventWorkflow = auditBlockField(entry.block, "Workflow");
    if (
      entry.event !== "PIPELINE_LINK_COMPLETED" ||
      auditBlockField(entry.block, "Stage") !== stageSlug ||
      auditBlockField(entry.block, "Link") !== link ||
      auditBlockField(entry.block, "Repo") !== repo ||
      (
        singleRun
          ? eventWorkflow !== workflow
          : eventWorkflow?.startsWith("single-stage:") === true
      )
    ) {
      continue;
    }
    const value = auditBlockField(entry.block, "Artifact Mtime Ms");
    if (!value || !/^[0-9]+(?:\.[0-9]+)?$/.test(value)) continue;
    latest = Math.max(latest ?? Number.NEGATIVE_INFINITY, Number(value));
  }
  return latest;
}

function pipelineReceiptArtifactIsCurrent(
  projectDir: string,
  stage: Pick<StageEntry, "slug" | "lead_agent">,
  receipt: PipelineLinkReceipt,
): boolean {
  if (
    stage.slug !== "reverse-engineering" ||
    receipt.link !== stage.lead_agent
  ) {
    return true;
  }
  if (
    !receipt.artifactPath ||
    !receipt.artifactSha256 ||
    receipt.artifactMtimeMs === null ||
    !/^sha256:[0-9a-f]{64}$/.test(receipt.artifactSha256)
  ) {
    return false;
  }
  const root = recordDir(projectDir);
  if (root === null) return false;
  const path = resolvePath(projectDir, receipt.artifactPath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) return false;
  try {
    const guardedPath = assertNoSymlinkInChainOrThrow(
      realpathSync(projectDir),
      relative(projectDir, path),
    );
    const snapshot = readRegularFileNoFollowOrThrow(
      guardedPath,
      "reverse-engineering developer handoff",
      undefined,
      guardedPath,
      true,
    );
    if (
      Math.abs(snapshot.mtimeMs - receipt.artifactMtimeMs) > 0.01
    ) {
      return false;
    }
    const digest = createHash("sha256")
      .update(snapshot.bytes)
      .digest("hex");
    return receipt.artifactSha256 === `sha256:${digest}`;
  } catch {
    return false;
  }
}

function currentPipelineReuseEvidence(
  projectDir: string,
  stageSlug: string,
  singleRun: boolean,
): Set<string | null> {
  const events = orderedPipelineEvidenceEvents(projectDir);
  const floor = pipelineAttemptFloor(events, stageSlug, singleRun);
  const workflow = `single-stage:${stageSlug}`;
  const reused = new Set<string | null>();
  for (const entry of events) {
    if (!pipelineEventAfterFloor(entry, floor)) continue;
    const eventWorkflow = auditBlockField(entry.block, "Workflow");
    if (
      entry.event !== "ARTIFACT_REUSED" ||
      auditBlockField(entry.block, "Stage") !== stageSlug ||
      auditBlockField(entry.block, "Decision") !== "keep" ||
      (
        singleRun
          ? eventWorkflow !== workflow
          : eventWorkflow?.startsWith("single-stage:") === true
      )
    ) {
      continue;
    }
    reused.add(auditBlockField(entry.block, "Repo"));
  }
  return reused;
}

// Every recorded repo identity runs one independent, repo-qualified receipt
// chain, including an intent with exactly one registered repo. A current-attempt
// per-repo reuse row satisfies that repo without dispatch. Only an unrecorded
// project-root repo uses the null/unqualified chain.
export function pipelineLinkEvidence(
  projectDir: string,
  stage: Pick<StageEntry, "slug" | "lead_agent" | "support_agents">,
  options: { singleRun?: boolean } = {},
): PipelineLinkEvidence {
  const links = pipelineLinks(stage);
  const registeredRepos = intentRepos(projectDir);
  const repos = registeredRepos;
  const singleRun = options.singleRun === true;
  const rawReceipts = currentPipelineLinkReceipts(
    projectDir,
    stage.slug,
    { singleRun },
  );
  const receipts: PipelineLinkReceipt[] = [];
  const chainRepos = repos.length > 0 ? repos : [null];
  for (const repo of chainRepos) {
    const chain: PipelineLinkReceipt[] = [];
    for (const receipt of rawReceipts) {
      if (receipt.repo !== repo) continue;
      if (receipt.link === links[0]) {
        chain.length = 0;
        if (pipelineReceiptArtifactIsCurrent(projectDir, stage, receipt)) {
          chain.push(receipt);
        }
        continue;
      }
      if (
        chain.length > 0 &&
        chain.length < links.length &&
        receipt.link === links[chain.length]
      ) {
        chain.push(receipt);
      }
    }
    receipts.push(...chain);
  }
  const reuseEvidence = currentPipelineReuseEvidence(
    projectDir,
    stage.slug,
    singleRun,
  );
  const reusedRepos = repos.filter((repo) =>
    reuseEvidence.has(repo) &&
    (!singleRun || codekbStoreIsCurrent(projectDir, repo))
  );
  const unrecordedRepoReused =
    repos.length === 0 &&
    reuseEvidence.has(null) &&
    (!singleRun || codekbStoreIsCurrent(projectDir));
  const missing: Array<{ link: string; repo: string | null }> = [];

  if (repos.length > 0) {
    for (const repo of repos) {
      if (reusedRepos.includes(repo)) continue;
      for (const link of links) {
        if (!receipts.some((receipt) =>
          receipt.repo === repo && receipt.link === link
        )) {
          missing.push({ link, repo });
        }
      }
    }
  } else {
    if (!unrecordedRepoReused) {
      for (const link of links) {
        if (!receipts.some((receipt) => receipt.link === link)) {
          missing.push({ link, repo: null });
        }
      }
    }
  }

  // Recorded repo identities qualify every completed entry so the handoff,
  // receipt, codekb destination, and resume lookup all use the same key. Only
  // an unrecorded project-root repo keeps the compact link-name form.
  const completed = repos.length > 0
    ? repos.flatMap((repo) =>
        reusedRepos.includes(repo)
          ? links.map((link) => `${repo}:${link}`)
          : links
            .filter((link) =>
              receipts.some((receipt) =>
                receipt.repo === repo && receipt.link === link
              )
            )
            .map((link) => `${repo}:${link}`)
      )
    : unrecordedRepoReused
      ? [...links]
      : links.filter((link) =>
          receipts.some((receipt) => receipt.link === link)
        );

  return { links, repos, receipts, reusedRepos, completed, missing };
}

export type UnitGateScope = "per-stage" | "unit-end";
export type UnitGateStatus =
  | "pending"
  | "awaiting-approval"
  | "revising"
  | "approved";

function gateStagesFromBlock(block: string): string[] {
  const explicit = auditBlockField(block, "Gate Stages");
  if (explicit) {
    return explicit
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  const stage = auditBlockField(block, "Stage");
  return stage ? [stage] : [];
}

function gateEventMatchesUnit(
  block: string,
  slug: string,
  unit: string | undefined,
): boolean {
  if (!gateStagesFromBlock(block).includes(slug)) return false;
  const eventUnit = auditBlockField(block, "Unit");
  return unit === undefined ? eventUnit === null : eventUnit === unit;
}

function gateRejectionMatchesAttempt(
  block: string,
  slug: string,
  unit: string | undefined,
): boolean {
  if (!gateStagesFromBlock(block).includes(slug)) return false;
  const eventUnit = auditBlockField(block, "Unit");
  if (eventUnit === null) return true;
  return unit !== undefined && eventUnit === unit;
}

export function unitGateStatus(
  projectDir: string,
  stage: string,
  unit: string,
  scope: UnitGateScope,
  auditRows?: readonly AuditShardEvent[],
): UnitGateStatus {
  const rows = auditRows ?? readAuditShardEvents(projectDir).sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
  let status: UnitGateStatus = "pending";
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    while (
      end < rows.length &&
      rows[end].timestamp === rows[start].timestamp
    ) {
      end++;
    }
    const relevant = rows.slice(start, end).filter((row) => {
      if (row.event === "WORKFLOW_STARTED" || row.event === "STAGE_JUMPED") {
        return true;
      }
      if (
        row.event !== "STAGE_AWAITING_APPROVAL" &&
        row.event !== "STAGE_REVISING" &&
        row.event !== "GATE_APPROVED" &&
        row.event !== "GATE_REJECTED"
      ) {
        return false;
      }
      return (
        gateEventMatchesUnit(row.block, stage, unit) &&
        eventMatchesClaimAttempt(projectDir, row.block, unit) &&
        (auditBlockField(row.block, "Gate Scope") ?? "per-stage") === scope
      );
    });
    if (relevant.length > 0) {
      const relevantShards = new Set(relevant.map((row) => row.shard));
      const hasBoundary = relevant.some(
        (row) =>
          row.event === "WORKFLOW_STARTED" || row.event === "STAGE_JUMPED",
      );
      if (relevantShards.size > 1) {
        if (hasBoundary) {
          status = "pending";
        } else {
          const statuses = new Set(
            relevant.map((row): UnitGateStatus =>
              row.event === "GATE_APPROVED"
                ? "approved"
                : row.event === "GATE_REJECTED" ||
                    row.event === "STAGE_REVISING"
                  ? "revising"
                  : "awaiting-approval",
            ),
          );
          status = statuses.has("revising")
            ? "revising"
            : statuses.has("awaiting-approval")
              ? "awaiting-approval"
              : statuses.size === 1
                ? "approved"
                : "pending";
        }
      } else {
        for (const row of relevant) {
          if (
            row.event === "WORKFLOW_STARTED" ||
            row.event === "STAGE_JUMPED"
          ) {
            status = "pending";
          } else if (row.event === "GATE_APPROVED") {
            status = "approved";
          } else if (
            row.event === "GATE_REJECTED" ||
            row.event === "STAGE_REVISING"
          ) {
            status = "revising";
          } else {
            status = "awaiting-approval";
          }
        }
      }
    }
    start = end;
  }
  return status;
}

// Exact identity for the current main-workflow attempt of one stage. The token
// names the latest relevant boundary plus its matching-event ordinal, so two
// boundaries emitted in the same second still receive different floors.
//
// Unit-major Construction can run a later stage before that stage's own
// STAGE_STARTED row exists. For that walk, a stage attempt begins at the latest
// workflow creation, jump, or stage rejection and deliberately ignores
// STAGE_STARTED. This matches the reviewer-receipt floor: the later stage start
// must not invalidate work legitimately completed earlier in the same
// unit-major block.
//
// The no-boundary sentinel keeps fixture/recovery flows deterministic while
// unstamped legacy rows still fail closed.
export function latestMainWorkflowStageRunFloor(
  audit: string,
  slug: string,
  unitMajor = false,
  unit?: string,
): string {
  let floor = "unstarted#0";
  const ordinals = new Map<string, number>();
  const relevant = new Set([
    "WORKFLOW_STARTED",
    "STAGE_STARTED",
    "STAGE_JUMPED",
    "GATE_REJECTED",
  ]);
  const events = audit
    .replace(/\r\n/g, "\n")
    .split(/\n---\n/)
    .map((block, pos) => ({
      block,
      event: auditBlockField(block, "Event"),
      pos,
      timestamp: auditBlockField(block, "Timestamp") ?? "",
    }))
    .filter(
      (row): row is { block: string; event: string; pos: number; timestamp: string } =>
        row.event !== null && relevant.has(row.event) && row.timestamp !== "",
    )
    .sort((a, b) =>
      a.timestamp !== b.timestamp
        ? a.timestamp < b.timestamp
          ? -1
          : 1
        : a.pos - b.pos,
    );

  for (const row of events) {
    const stage = auditBlockField(row.block, "Stage");
    let matches = false;
    if (row.event === "WORKFLOW_STARTED" || row.event === "STAGE_JUMPED") {
      matches = true;
    } else if (row.event === "GATE_REJECTED") {
      matches = gateRejectionMatchesAttempt(row.block, slug, unit);
    } else if (row.event === "STAGE_STARTED" && !unitMajor) {
      matches =
        stage === slug &&
        !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:");
    }
    if (!matches) continue;
    const ordinal = (ordinals.get(row.event) ?? 0) + 1;
    ordinals.set(row.event, ordinal);
    floor = `${row.event}:${row.timestamp}#${ordinal}`;
  }
  return floor;
}

// Shard-aware attempt identity for live project readers. Same-shard timestamp
// ties retain append order. If the latest relevant boundary is tied across
// different shards, execution order is unknowable: mint a deterministic
// ambiguity floor from the complete tied set. Existing receipts cannot match
// it, so the boundary fails closed; receipts emitted after the ambiguity use
// the same stable token until another boundary arrives.
export function latestMainWorkflowStageRunFloorForProject(
  projectDir: string,
  slug: string,
  unitMajor = false,
  unit?: string,
  auditRows?: readonly AuditShardEvent[],
  intent?: string,
  space?: string,
): string {
  return latestMainWorkflowStageRunFloorFromRows(
    auditRows ?? readAuditShardEvents(projectDir, intent, space),
    slug,
    unitMajor,
    unit,
    auditRows !== undefined,
  );
}

function latestMainWorkflowStageRunFloorFromRows(
  rowsInput: readonly AuditShardEvent[],
  slug: string,
  unitMajor = false,
  unit?: string,
  preSorted = false,
): string {
  const relevant = new Set([
    "WORKFLOW_STARTED",
    "STAGE_STARTED",
    "STAGE_JUMPED",
    "GATE_REJECTED",
  ]);
  const rows = rowsInput
    .filter((row) => {
      if (!relevant.has(row.event)) return false;
      const stage = auditBlockField(row.block, "Stage");
      if (row.event === "WORKFLOW_STARTED" || row.event === "STAGE_JUMPED") {
        return true;
      }
      if (row.event === "GATE_REJECTED") {
        return gateRejectionMatchesAttempt(row.block, slug, unit);
      }
      return (
        !unitMajor &&
        stage === slug &&
        !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:")
      );
    });
  if (!preSorted) {
    rows.sort((a, b) => {
      if (a.timestamp !== b.timestamp) {
        return a.timestamp < b.timestamp ? -1 : 1;
      }
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    });
  }
  if (rows.length === 0) return "unstarted#0";

  const latestTimestamp = rows[rows.length - 1].timestamp;
  const tied = rows.filter((row) => row.timestamp === latestTimestamp);
  if (new Set(tied.map((row) => row.shard)).size > 1) {
    const identity = tied
      .map((row) => {
        const fields = [
          basename(row.shard),
          row.pos,
          row.event,
          auditBlockField(row.block, "Stage") ?? "",
        ];
        if (unit !== undefined) {
          fields.push(
            auditBlockField(row.block, "Unit") ?? "",
            auditBlockField(row.block, "Gate Stages") ?? "",
          );
        }
        return fields.join(":");
      })
      .sort()
      .join("|");
    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
    return `AMBIGUOUS:${latestTimestamp}#${digest}`;
  }

  const ordinals = new Map<string, number>();
  let floor = "unstarted#0";
  for (const row of rows) {
    const ordinal = (ordinals.get(row.event) ?? 0) + 1;
    ordinals.set(row.event, ordinal);
    floor = `${row.event}:${row.timestamp}#${ordinal}`;
  }
  return floor;
}

// The set of units the CURRENT attempt of `slug` has genuinely converged and
// merged, from the `SWARM_UNIT_CONVERGED` rows `aidlc-swarm.ts finalize`
// writes. A row counts only when its `Stage` names this slug AND its
// `Run floor` equals the stage's current attempt floor (exact field match) —
// a row minted by a late finalize retry against a PRIOR attempt's preserved
// worktree carries the prior floor and is rejected regardless of its emission
// timestamp, and another swarm stage's rows fail the Stage match even when
// the floor is the no-boundary sentinel. Rows without the two
// fields (pre-2.5.0 audit logs) fail closed: the affected units re-fan on the
// next swarm pass, which finalize's re-verify makes safe. The timestamp check
// stays as belt-and-braces.
export function swarmConvergedUnits(
  projectDir: string,
  slug: string,
): Set<string> {
  const unreadableShards: string[] = [];
  const auditRows = readAuditShardEvents(
    projectDir,
    undefined,
    undefined,
    unreadableShards,
  );
  if (unreadableShards.length > 0 || auditRows.length === 0) return new Set();
  const stageStarts = auditRows
    .filter(
      (row) =>
        row.event === "STAGE_STARTED" &&
        auditBlockField(row.block, "Stage") === slug &&
        !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:"),
    )
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    });
  const startedAt = stageStarts.at(-1)?.timestamp ?? null;
  const floor = latestMainWorkflowStageRunFloorFromRows(auditRows, slug);
  const sourceChain = currentSwarmSourceMergeChain(projectDir, slug);
  const rowsByUnit = new Map<string, AuditShardEvent[]>();
  for (const row of auditRows) {
    if (row.event !== "SWARM_UNIT_CONVERGED") continue;
    if (auditBlockField(row.block, "Stage") !== slug) continue;
    if ((auditBlockField(row.block, "Run floor") ?? "") !== floor) continue;
    if (startedAt && row.timestamp < startedAt) continue;
    const unit = auditBlockField(row.block, "Unit name");
    if (!unit) continue;
    const rows = rowsByUnit.get(unit) ?? [];
    rows.push(row);
    rowsByUnit.set(unit, rows);
  }
  const converged = new Set<string>();
  for (const [unit, rows] of rowsByUnit) {
    rows.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    });
    const latestTimestamp = rows.at(-1)?.timestamp;
    if (!latestTimestamp) continue;
    const latest = rows.filter((row) => row.timestamp === latestTimestamp);
    const identities = new Set(
      latest.map((row) =>
        [
          auditBlockField(row.block, "Batch number") ?? "",
          auditBlockField(row.block, "Source Fingerprint") ?? "",
          auditBlockField(row.block, "Source Commit") ?? "",
          auditBlockField(row.block, "Source Freshness Bypass") ?? "",
        ].join("\0")
      ),
    );
    if (
      new Set(latest.map((row) => row.shard)).size > 1 &&
      identities.size !== 1
    ) continue;
    const block = latest.at(-1)?.block;
    if (!block) continue;
    const sourceKind = swarmConvergenceSourceKind(block);
    if (sourceKind === "invalid") continue;
    if (
      sourceKind === "bound" &&
      (sourceChain.state !== "ready" || !sourceChain.units.has(unit))
    ) continue;
    converged.add(unit);
  }
  return converged;
}

export type SwarmAttemptObligations =
  | { state: "none" }
  | { state: "invalid"; reason: string }
  | { state: "ready"; units: Set<string> };

export function currentSwarmAttemptObligations(
  projectDir: string,
  slug: string,
  intent?: string,
  space?: string,
): SwarmAttemptObligations {
  const floor = latestMainWorkflowStageRunFloorForProject(
    projectDir,
    slug,
    false,
    undefined,
    undefined,
    intent,
    space,
  );
  const rows = readAuditShardEvents(projectDir, intent, space);
  const modernCurrentAttempt = rows.some(
    (row) =>
      auditBlockField(row.block, "Stage") === slug &&
      auditBlockField(row.block, "Run floor") === floor &&
      ((row.event === "SWARM_UNIT_CONVERGED" &&
        swarmConvergenceSourceKind(row.block) !== "legacy") ||
        row.event === "SWARM_SOURCE_MERGED"),
  );
  const missingObligations = (): SwarmAttemptObligations =>
    modernCurrentAttempt
      ? {
          state: "invalid",
          reason:
            "modern current-attempt swarm evidence exists without SWARM_STARTED Unit obligations",
        }
      : { state: "none" };
  const starts = rows.filter(
    (row) =>
      row.event === "SWARM_STARTED" &&
      auditBlockField(row.block, "Stage") === slug &&
      auditBlockField(row.block, "Run floor") === floor,
  );
  if (starts.length === 0) {
    return missingObligations();
  }

  const obligationFields = starts.map((row) =>
    auditBlockField(row.block, "Unit obligations")
  );
  const fieldBearing = obligationFields.filter(
    (field): field is string => field !== null,
  );
  if (fieldBearing.length === 0) return missingObligations();
  if (fieldBearing.length !== starts.length) {
    return {
      state: "invalid",
      reason:
        "current-attempt SWARM_STARTED mixes fieldless and field-bearing Unit obligations",
    };
  }

  let canonical: string | null = null;
  let units: Set<string> | null = null;
  for (const raw of fieldBearing) {
    const parsed = raw
      .split(",")
      .map((unit) => unit.trim())
      .filter(Boolean);
    if (
      parsed.length === 0 ||
      parsed.some((unit) => validateUnitName(unit) !== null) ||
      new Set(parsed).size !== parsed.length
    ) {
      return {
        state: "invalid",
        reason: "current-attempt SWARM_STARTED has malformed Unit obligations",
      };
    }
    const nextCanonical = [...parsed].sort().join("\0");
    if (canonical !== null && canonical !== nextCanonical) {
      return {
        state: "invalid",
        reason:
          "current-attempt SWARM_STARTED rows disagree on Unit obligations",
      };
    }
    canonical = nextCanonical;
    units = new Set(parsed);
  }
  return units === null ? { state: "none" } : { state: "ready", units };
}

export type SwarmSourceMergeChain =
  | { state: "none" }
  | { state: "invalid"; reason: string }
  | {
      state: "ready";
      fingerprint: string;
      units: Set<string>;
    };

export type SwarmSourceOpeningFingerprint =
  | { state: "invalid"; reason: string }
  | {
      state: "ready";
      fingerprint: string;
      source: "stage-baseline" | "prior-accepted";
      listing?: WorkspaceSourceListing;
    };

/**
 * Resolve the trusted predecessor for the current attempt's first aggregate
 * source merge. A rejection may carry only the final validated aggregate from
 * the prior attempt; it never replaces the stage-entry completion baseline.
 */
export function currentSwarmSourceOpeningFingerprint(
  projectDir: string,
  slug: string,
  intent?: string,
  space?: string,
): SwarmSourceOpeningFingerprint {
  const floor = latestMainWorkflowStageRunFloorForProject(
    projectDir,
    slug,
    false,
    undefined,
    undefined,
    intent,
    space,
  );
  if (floor.startsWith("AMBIGUOUS:")) {
    return {
      state: "invalid",
      reason: "current stage attempt boundary is cross-shard ambiguous",
    };
  }
  const rejected = /^GATE_REJECTED:(.+)#([1-9][0-9]*)$/.exec(floor);
  if (rejected !== null) {
    const ordinal = Number(rejected[2]);
    const rows = readAuditShardEvents(projectDir, intent, space)
      .filter(
        (row) =>
          row.event === "GATE_REJECTED" &&
          auditBlockField(row.block, "Stage") === slug,
      )
      .sort((a, b) => {
        if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
        if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
        return a.pos - b.pos;
      });
    const row = rows[ordinal - 1];
    if (!row || row.timestamp !== rejected[1]) {
      return {
        state: "invalid",
        reason: "current rejection boundary cannot be correlated to its audit row",
      };
    }
    const prior = auditBlockField(
      row.block,
      "Prior Accepted Source Fingerprint",
    );
    if (prior !== null) {
      if (!/^[0-9a-f]{40,64}$/.test(prior)) {
        return {
          state: "invalid",
          reason: "current rejection carries malformed prior accepted source authority",
        };
      }
      return {
        state: "ready",
        fingerprint: prior,
        source: "prior-accepted",
      };
    }
  }

  let stateContent: string;
  try {
    stateContent = readStateFile(projectDir, intent, space);
  } catch {
    return {
      state: "invalid",
      reason: "current state is unavailable for the opening aggregate link",
    };
  }
  const baseline = currentStageSourceBaseline(
    projectDir,
    slug,
    getField(stateContent, "Construction Iteration")?.trim() === "unit-major",
    intent,
    space,
  );
  if (baseline.state !== "ready") {
    return {
      state: "invalid",
      reason: "current source baseline is unavailable for the opening aggregate link",
    };
  }
  return {
    state: "ready",
    fingerprint: sourceListingSha256(serializeSourceListing(baseline.listing)),
    source: "stage-baseline",
    listing: baseline.listing,
  };
}

/**
 * Validate the current attempt's post-source-merge aggregate chain. Each row
 * links the main checkout state before one immutable reviewed-source merge to
 * the state after it. Cross-shard same-second rows are causally unordered and
 * therefore cannot form an authority chain.
 */
export function currentSwarmSourceMergeChain(
  projectDir: string,
  slug: string,
  intent?: string,
  space?: string,
): SwarmSourceMergeChain {
  const floor = latestMainWorkflowStageRunFloorForProject(
    projectDir,
    slug,
    false,
    undefined,
    undefined,
    intent,
    space,
  );
  const allRows = readAuditShardEvents(projectDir, intent, space);
  const rows = allRows
    .filter(
      (row) =>
        row.event === "SWARM_SOURCE_MERGED" &&
        auditBlockField(row.block, "Stage") === slug &&
        auditBlockField(row.block, "Run floor") === floor,
    )
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
      return a.pos - b.pos;
    });
  if (rows.length === 0) return { state: "none" };

  const units = new Set<string>();
  let priorFingerprint: string | null = null;
  let openingPrevious: string | null = null;
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    while (end < rows.length && rows[end].timestamp === rows[start].timestamp) end++;
    const tied = rows.slice(start, end);
    if (new Set(tied.map((row) => row.shard)).size > 1) {
      return {
        state: "invalid",
        reason: `same-second cross-shard SWARM_SOURCE_MERGED rows are causally ambiguous at ${rows[start].timestamp}`,
      };
    }
    for (const row of tied) {
      const unit = auditBlockField(row.block, "Unit name");
      const batch = auditBlockField(row.block, "Batch number");
      const previous = auditBlockField(row.block, "Previous Source Fingerprint");
      const fingerprint = auditBlockField(row.block, "Source Fingerprint");
      const sourceCommit = auditBlockField(row.block, "Source Commit");
      const mergeCommit = auditBlockField(row.block, "Merge commit");
      if (
        !unit ||
        !batch ||
        !/^[1-9][0-9]*$/.test(batch) ||
        !previous ||
        !/^[0-9a-f]{40,64}$/.test(previous) ||
        !fingerprint ||
        !/^[0-9a-f]{40,64}$/.test(fingerprint) ||
        !sourceCommit ||
        !/^[0-9a-f]{40,64}$/.test(sourceCommit) ||
        !mergeCommit ||
        !/^[0-9a-f]{40,64}$/.test(mergeCommit)
      ) {
        return {
          state: "invalid",
          reason: `malformed SWARM_SOURCE_MERGED authority for unit ${JSON.stringify(unit ?? "")}`,
        };
      }
      if (units.has(unit)) {
        return {
          state: "invalid",
          reason: `duplicate SWARM_SOURCE_MERGED authority for unit ${JSON.stringify(unit)}`,
        };
      }
      if (priorFingerprint !== null && previous !== priorFingerprint) {
        return {
          state: "invalid",
          reason: `broken SWARM_SOURCE_MERGED aggregate link before unit ${JSON.stringify(unit)}`,
        };
      }
      if (openingPrevious === null) openingPrevious = previous;
      const convergenceRows = allRows
        .filter(
          (candidate) =>
            candidate.event === "SWARM_UNIT_CONVERGED" &&
            auditBlockField(candidate.block, "Unit name") === unit &&
            auditBlockField(candidate.block, "Stage") === slug &&
            auditBlockField(candidate.block, "Run floor") === floor,
        )
        .sort((a, b) => {
          if (a.timestamp !== b.timestamp) {
            return a.timestamp < b.timestamp ? -1 : 1;
          }
          if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
          return a.pos - b.pos;
        });
      const latestConvergenceTimestamp =
        convergenceRows.at(-1)?.timestamp ?? null;
      const latestConvergences =
        latestConvergenceTimestamp === null
          ? []
          : convergenceRows.filter(
              (candidate) =>
                candidate.timestamp === latestConvergenceTimestamp,
            );
      if (
        latestConvergences.length === 0 ||
        (new Set(latestConvergences.map((candidate) => candidate.shard)).size >
          1 &&
          new Set(
            latestConvergences.map((candidate) =>
              [
                auditBlockField(candidate.block, "Batch number") ?? "",
                auditBlockField(candidate.block, "Source Commit") ?? "",
              ].join("\0")
            ),
          ).size !== 1)
      ) {
        return {
          state: "invalid",
          reason: `missing or ambiguous current convergence authority for unit ${JSON.stringify(unit)}`,
        };
      }
      const latestConvergence =
        latestConvergences[latestConvergences.length - 1];
      if (
        auditBlockField(latestConvergence.block, "Batch number") !== batch ||
        auditBlockField(latestConvergence.block, "Source Commit") !==
          sourceCommit
      ) {
        return {
          state: "invalid",
          reason: `SWARM_SOURCE_MERGED authority for unit ${JSON.stringify(unit)} does not match its latest convergence`,
        };
      }
      units.add(unit);
      priorFingerprint = fingerprint;
    }
    start = end;
  }
  const opening = currentSwarmSourceOpeningFingerprint(
    projectDir,
    slug,
    intent,
    space,
  );
  if (opening.state === "invalid") {
    return opening;
  }
  if (openingPrevious !== opening.fingerprint) {
    return {
      state: "invalid",
      reason: `opening SWARM_SOURCE_MERGED link does not match the current ${opening.source === "prior-accepted" ? "prior accepted aggregate" : "stage baseline"}`,
    };
  }
  return priorFingerprint === null
    ? { state: "none" }
    : { state: "ready", fingerprint: priorFingerprint, units };
}

// The set of units the CURRENT attempt of an INLINE per-unit stage has
// completion receipts for, from the UNIT_COMPLETED rows `aidlc-state.ts unit
// complete` writes — the interactive-path twin of swarmConvergedUnits, with
// the same attempt-floor discipline: a row counts only when its Stage names
// this slug AND its exact Run floor equals the current main-workflow attempt.
// The floor includes a boundary-event ordinal, so same-second re-entry still
// invalidates every receipt from the prior attempt. Unit-major uses its
// workflow/jump/rejection boundary so a later STAGE_STARTED does not erase
// receipts legitimately emitted earlier in that block.
// Serial receipts are the transition: artifacts are evidence the writer
// checked at emit time. Wave receipts additionally bind that transition to
// the final artifact fingerprint so a later write reopens the entry for
// review, memory fan-in, and completion. A paused or partially-written unit
// has artifacts but no receipt, so it stays uncovered.
type UnitLifecycleRow = {
  ts: string;
  pos: number;
  shard: string;
  shardIndex: number;
  event: string;
  block: string;
  unit: string;
};

function currentUnitLifecycleRows(
  projectDir: string,
  audit: string,
  slug: string,
  unitMajor: boolean,
  auditRows?: readonly AuditShardEvent[],
  stateContent?: string,
): UnitLifecycleRow[] {
  const sourceRows = auditRows ?? readAuditShardEvents(projectDir);
  const startedAt = auditRows
    ? sourceRows
        .filter(
          (row) =>
            row.event === "STAGE_STARTED" &&
            auditBlockField(row.block, "Stage") === slug &&
            !auditBlockField(row.block, "Workflow")?.startsWith("single-stage:"),
        )
        .sort((a, b) => {
          if (a.timestamp !== b.timestamp) {
            return a.timestamp < b.timestamp ? -1 : 1;
          }
          if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
          return a.pos - b.pos;
        })
        .at(-1)?.timestamp ?? ""
    : latestMainWorkflowStageStarted(audit, slug);
  let teamOwnership = false;
  try {
    teamOwnership = isTeamUnitOwnership(
      stateContent ?? readStateFile(projectDir),
    );
  } catch {
    // No readable state means legacy stage-scoped flooring.
  }
  const floorByUnit = new Map<string, string>();
  const floorFor = (unit: string): string => {
    const key = teamOwnership ? unit : "";
    const existing = floorByUnit.get(key);
    if (existing) return existing;
    const floor = latestMainWorkflowStageRunFloorForProject(
      projectDir,
      slug,
      unitMajor,
      teamOwnership ? unit : undefined,
      sourceRows,
    );
    floorByUnit.set(key, floor);
    return floor;
  };
  const unitEvents = new Set([
    "UNIT_STARTED",
    "UNIT_PAUSED",
    "UNIT_RESUMED",
    "UNIT_COMPLETED",
  ]);
  const rows: UnitLifecycleRow[] = [];
  for (const row of sourceRows) {
    if (!unitEvents.has(row.event)) continue;
    if (auditBlockField(row.block, "Stage") !== slug) continue;
    const unit = auditBlockField(row.block, "Unit");
    if (!unit) continue;
    if (!eventMatchesClaimAttempt(projectDir, row.block, unit)) continue;
    if (auditBlockField(row.block, "Run floor") !== floorFor(unit)) continue;
    if (!unitMajor && startedAt && row.timestamp < startedAt) continue;
    rows.push({
      ts: row.timestamp,
      pos: row.pos,
      shard: row.shard,
      shardIndex: row.shardIndex,
      event: row.event,
      block: row.block,
      unit,
    });
  }
  rows.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });

  const reduced: UnitLifecycleRow[] = [];
  for (let start = 0; start < rows.length;) {
    let end = start + 1;
    while (end < rows.length && rows[end].ts === rows[start].ts) end++;
    const byUnit = new Map<string, UnitLifecycleRow[]>();
    for (const row of rows.slice(start, end)) {
      const unitRows = byUnit.get(row.unit) ?? [];
      unitRows.push(row);
      byUnit.set(row.unit, unitRows);
    }
    for (const unitRows of byUnit.values()) {
      const latestByShard = new Map<string, UnitLifecycleRow>();
      for (const row of unitRows) latestByShard.set(row.shard, row);
      const candidates = [...latestByShard.values()];
      if (candidates.length === 1) {
        reduced.push(candidates[0]);
        continue;
      }
      // Cross-shard rows in one second are causally unordered. Preserve the
      // safest possible checkpoint: a possible pause blocks all progress; a
      // possible start/resume keeps the unit unsettled; only unanimous terminal
      // candidates settle it.
      const rank = (event: string): number =>
        event === "UNIT_PAUSED"
          ? 2
          : event === "UNIT_COMPLETED"
            ? 0
            : 1;
      candidates.sort((a, b) => {
        const rankDiff = rank(a.event) - rank(b.event);
        if (rankDiff !== 0) return rankDiff;
        if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
        return a.pos - b.pos;
      });
      reduced.push(candidates[candidates.length - 1]);
    }
    start = end;
  }
  reduced.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    if (a.shardIndex !== b.shardIndex) return a.shardIndex - b.shardIndex;
    return a.pos - b.pos;
  });
  return reduced;
}

function unitMajorLifecycleMode(projectDir: string): boolean {
  try {
    return (
      getField(readStateFile(projectDir), "Construction Iteration")?.trim() ===
      "unit-major"
    );
  } catch {
    return false;
  }
}

export interface UnitLifecycleSnapshot {
  receipts: Set<string>;
  checkpoint: {
    unit: string;
    state: "in-progress" | "paused";
    reason: string | null;
    nextAction: string | null;
  } | null;
  inUse: boolean;
  mode: UnitLifecycleMode;
}

export function unitLifecycleSnapshot(
  projectDir: string,
  slug: string,
  auditRows: readonly AuditShardEvent[],
  stateContent: string,
  options: {
    artifactFingerprint?: (
      stage: StageEntry,
      unit: string,
    ) => string | null;
  } = {},
): UnitLifecycleSnapshot {
  const unitMajor =
    getField(stateContent, "Construction Iteration")?.trim() === "unit-major";
  const rows = currentUnitLifecycleRows(
    projectDir,
    "",
    slug,
    unitMajor,
    auditRows,
    stateContent,
  );
  const stage = resolveStage(slug);
  const receipts = new Set<string>();
  let sawSerial = false;
  let sawWave = false;
  for (const row of rows) {
    if (auditBlockField(row.block, "Mode") === "wave") sawWave = true;
    else sawSerial = true;
    if (row.event !== "UNIT_COMPLETED") {
      receipts.delete(row.unit);
      continue;
    }
    if (auditBlockField(row.block, "Mode") !== "wave") {
      receipts.add(row.unit);
      continue;
    }
    const recorded = auditBlockField(row.block, "Artifact Fingerprint");
    const current =
      stage === undefined
        ? null
        : options.artifactFingerprint
          ? options.artifactFingerprint(stage, row.unit)
          : reviewArtifactFingerprint(projectDir, stage, row.unit, {
              requireRequiredArtifacts: true,
            });
    if (
      recorded !== null &&
      /^sha256:[0-9a-f]{64}$/.test(recorded) &&
      current === recorded
    ) {
      receipts.add(row.unit);
    } else {
      receipts.delete(row.unit);
    }
  }
  const latest = new Map<string, { event: string; block: string }>();
  for (const row of rows) {
    latest.set(row.unit, { event: row.event, block: row.block });
  }
  let checkpoint: UnitLifecycleSnapshot["checkpoint"] = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const final = latest.get(rows[i].unit);
    if (!final || final.event === "UNIT_COMPLETED") continue;
    checkpoint = {
      unit: rows[i].unit,
      state: final.event === "UNIT_PAUSED" ? "paused" : "in-progress",
      reason: auditBlockField(final.block, "Reason"),
      nextAction: auditBlockField(final.block, "Next Action"),
    };
    break;
  }
  const unitEvents = new Set([
    "UNIT_STARTED",
    "UNIT_PAUSED",
    "UNIT_RESUMED",
    "UNIT_COMPLETED",
  ]);
  const inUse = auditRows.some(
    (row) =>
      unitEvents.has(row.event) &&
      auditBlockField(row.block, "Stage") === slug,
  );
  const mode: UnitLifecycleMode =
    sawSerial && sawWave
      ? "mixed"
      : sawWave
        ? "wave"
        : sawSerial
          ? "serial"
          : "none";
  return { receipts, checkpoint, inUse, mode };
}

export function unitCompletedReceipts(
  projectDir: string,
  slug: string,
): Set<string> {
  const audit = readAllAuditShards(projectDir);
  if (!audit) return new Set();
  const unitMajor = unitMajorLifecycleMode(projectDir);
  const done = new Set<string>();
  const stage = resolveStage(slug);
  for (const row of currentUnitLifecycleRows(projectDir, audit, slug, unitMajor)) {
    if (row.event !== "UNIT_COMPLETED") {
      done.delete(row.unit);
      continue;
    }
    if (auditBlockField(row.block, "Mode") !== "wave") {
      done.add(row.unit);
      continue;
    }
    const recorded = auditBlockField(row.block, "Artifact Fingerprint");
    const current =
      stage === undefined
        ? null
        : reviewArtifactFingerprint(projectDir, stage, row.unit, {
            requireRequiredArtifacts: true,
          });
    if (
      recorded !== null &&
      /^sha256:[0-9a-f]{64}$/.test(recorded) &&
      current === recorded
    ) {
      done.add(row.unit);
    } else {
      done.delete(row.unit);
    }
  }
  return done;
}

export type UnitLifecycleMode = "none" | "serial" | "wave" | "mixed";

export function currentUnitLifecycleMode(
  projectDir: string,
  slug: string,
): UnitLifecycleMode {
  const audit = readAllAuditShards(projectDir);
  if (!audit) return "none";
  const rows = currentUnitLifecycleRows(
    projectDir,
    audit,
    slug,
    unitMajorLifecycleMode(projectDir),
  );
  let sawSerial = false;
  let sawWave = false;
  for (const row of rows) {
    if (auditBlockField(row.block, "Mode") === "wave") sawWave = true;
    else sawSerial = true;
  }
  if (sawSerial && sawWave) return "mixed";
  if (sawWave) return "wave";
  if (sawSerial) return "serial";
  return "none";
}

// Receipt mode is sticky across attempts. Once a stage has emitted any
// lifecycle row, a later attempt with no current receipts must remain
// unsettled rather than silently falling back to artifact-only coverage.
export function unitLifecycleReceiptsInUse(
  projectDir: string,
  slug: string,
): boolean {
  const audit = readAllAuditShards(projectDir);
  if (!audit) return false;
  const unitEvents = new Set([
    "UNIT_STARTED",
    "UNIT_PAUSED",
    "UNIT_RESUMED",
    "UNIT_COMPLETED",
  ]);
  for (const block of audit.replace(/\r\n/g, "\n").split(/\n---\n/)) {
    const event = auditBlockField(block, "Event");
    if (
      event &&
      unitEvents.has(event) &&
      auditBlockField(block, "Stage") === slug
    ) {
      return true;
    }
  }
  return false;
}

// The active unit-lifecycle checkpoint for a stage: the LATEST UNIT_STARTED /
// UNIT_PAUSED / UNIT_RESUMED / UNIT_COMPLETED checkpoint per unit (current
// attempt only, same floor as unitCompletedReceipts), reduced to the unit whose
// latest checkpoint is a non-terminal state. Same-shard ties retain append
// order; unordered same-second cross-shard ties conservatively preserve pause,
// then any other non-terminal state, before completion. Returns the paused unit
// with its recorded
// Reason / Next Action (for the resume path and the paused-first routing), or
// the in-flight unit (started/resumed, not yet completed), or null when no
// unit is mid-lifecycle. At most one unit can be non-terminal on the inline
// path (the engine emits one unit at a time); if a corrupted ledger carries
// several, the LATEST row wins — deterministic, and `unit start` refuses to
// open a second active unit anyway.
export function activeUnitCheckpoint(
  projectDir: string,
  slug: string,
): { unit: string; state: "in-progress" | "paused"; reason: string | null; nextAction: string | null } | null {
  const audit = readAllAuditShards(projectDir);
  if (!audit) return null;
  const unitMajor = unitMajorLifecycleMode(projectDir);
  const rows = currentUnitLifecycleRows(projectDir, audit, slug, unitMajor);
  const latest = new Map<string, { event: string; block: string }>();
  for (const row of rows) {
    latest.set(row.unit, { event: row.event, block: row.block });
  }
  // Most recently touched unit whose FINAL row is non-terminal wins (walk the
  // chronological rows backwards; a unit completed by a later row is skipped).
  for (let i = rows.length - 1; i >= 0; i--) {
    const { unit } = rows[i];
    const final = latest.get(unit);
    if (!final || final.event === "UNIT_COMPLETED") continue;
    return {
      unit,
      state: final.event === "UNIT_PAUSED" ? "paused" : "in-progress",
      reason: auditBlockField(final.block, "Reason"),
      nextAction: auditBlockField(final.block, "Next Action"),
    };
  }
  return null;
}

// Latest STAGE_STARTED slug in an audit buffer, or null if none. findAllEvents
// returns events in chronological order (timestamp, then buffer position), so
// the last STAGE_STARTED block is the most recent transition. The slug lives in
// the block's `**Stage**:` field (appendAuditEntry writes the fields verbatim).
// Payload-free derivation of "what stage are we on" — used by the Kiro IDE
// sync-workflow-state path, where the hook receives no task payload and must read
// the current stage from the audit tail instead.
//
// EXCLUDES synthetic `--single` stage-runner rows (Workflow: single-stage:<slug>)
// — those belong to no main workflow and must never rewrite the main pointer
// (mirrors the filter in aidlc-state.ts hasStageAuditEvent). Without this a
// single-stage run's STAGE_STARTED would become the "latest" and the IDE
// sync would repoint the main Current Stage at it.
export function latestStartedStageSlug(audit: string): string | null {
  const started = findAllEvents(audit, "STAGE_STARTED").filter(
    (ev) => !/^\*\*Workflow\*\*:\s*single-stage:/m.test(ev.block),
  );
  if (started.length === 0) return null;
  const last = started[started.length - 1];
  const m = last.block.match(/^\*\*Stage\*\*:\s*([a-z][a-z0-9-]*)\s*$/m);
  return m ? m[1] : null;
}

// --- Data loaders ---

function resolveDataDir(): string {
  return resolveHarnessPath(["tools", "data"]);
}

let _stageGraph: StageEntry[] | null = null;
let _stageGraphAll: StageEntry[] | null = null;
let _scopeMapping: Record<string, ScopeDefinition> | null = null;

// Override paths for fixture injection in tests. Read at call time (not
// module load) so tests can mutate env vars between bun invocations
// while still sharing a process in rare cases. AIDLC_STAGE_GRAPH pattern
// matches AIDLC_PROJECT_DIR in resolveProjectDir() above.
function stageGraphPath(): string {
  return process.env.AIDLC_STAGE_GRAPH ?? join(resolveDataDir(), "stage-graph.json");
}

// Exported so the read-only `detect` verb can TELL the composer agent where
// the runtime scope registry lives (the paths are module-relative to the
// installed tool, which a prose agent cannot derive itself).
export function scopeGridPath(): string {
  return process.env.AIDLC_SCOPE_GRID ?? join(resolveDataDir(), "scope-grid.json");
}

// The SHIPPED framework-default model-rates table read by aidlc-usage.ts:
// `tools/data/model-rates.json`, beside the compiled stage-graph. This is the
// default layer only - the AIDLC_MODEL_RATES override is read separately by
// aidlc-usage.ts loadRates and layered ON TOP, so an install can both edit the
// shipped file AND point AIDLC_MODEL_RATES at another. Absent in a dev checkout
// (authored core/ carries no path resolution failure - the caller falls back to
// the hardcoded DEFAULT_RATES).
export function modelRatesPath(): string {
  return join(resolveDataDir(), "model-rates.json");
}

// scope-mapping.json is retired. It survives ONLY as a test
// fixture seam: when AIDLC_SCOPE_MAPPING is set, loadScopeMapping() reads
// that JSON file verbatim (preserving fixture-injection tests + the
// designer-export env-seam). With the var unset there is no JSON on disk —
// the mapping is derived from the compiled scope-grid.json (the EXECUTE/SKIP
// transpose) + the .claude/scopes/*.md frontmatter (depth/keywords/etc.).
function scopeMappingPath(): string | null {
  return process.env.AIDLC_SCOPE_MAPPING ?? null;
}

// .claude/scopes/ holds one aidlc-<name>.md per scope. AIDLC_SCOPES_DIR
// env-var seam mirrors AIDLC_SENSORS_DIR / AIDLC_RULES_DIR so fixture tests
// can point the scope-metadata loader at an isolated tree. Evaluated at call
// time so tests that set/unset mid-process see the change.
// Exported for the same reason as scopeGridPath: `detect --json` prints it so
// the composer agent is told the authoritative write target per harness.
export function scopesDir(): string {
  return process.env.AIDLC_SCOPES_DIR
    ?? resolveHarnessPath(["scopes"]);
}

export function loadStageGraph(): StageEntry[] {
  if (_stageGraph !== null) return _stageGraph;
  _stageGraph = loadStageGraphAll().filter((s) => s.enabled !== false);
  return _stageGraph;
}

export function loadStageGraphAll(): StageEntry[] {
  if (_stageGraphAll !== null) return _stageGraphAll;
  const p = stageGraphPath();
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch (err) {
    const hint = process.env.AIDLC_STAGE_GRAPH
      ? `AIDLC_STAGE_GRAPH points to ${p}; unset it to use the default.`
      : "Reinstall the framework or re-run setup to restore the data file.";
    throw new Error(
      `Stage graph not readable at ${p}: ${errorMessage(err)}. ${hint}`
    );
  }
  let parsed: StageEntry[];
  try {
    // JSON.parse returns `any`; we trust the on-disk schema (project-controlled
    // data file written by the framework, not user input). Phase E will
    // replace this trust boundary with an isStageEntryArray() type guard.
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Stage graph at ${p} is not valid JSON: ${errorMessage(err)}`
    );
  }
  _stageGraphAll = parsed;
  return parsed;
}

// Per-scope metadata read from each .claude/scopes/*.md frontmatter: identity,
// defaults, routing metadata, and the optional review cap. Core scopes use
// aidlc-<name>.md; plugin scopes use <plugin>-<name>.md, with the frontmatter
// name matching the filename stem. The EXECUTE/SKIP `.stages` half of a
// ScopeDefinition comes from the compiled grid. Cached.
interface ScopeMetadata {
  name: string;
  plugin?: string;
  depth: string;
  description: string;
  keywords: string[];
  testStrategy?: string;
  runner?: boolean;
  skeleton: boolean;
  /** Ceiling on how heavyweight stage reviews run under this scope:
   *  "adversarial" (no cap - stages run as declared), "advisory" (adversarial
   *  stages degrade to a single advisory pass), or "none" (no reviewer
   *  dispatch at all). Absent = adversarial (no cap). Resolution lives in
   *  resolveReviewClass. */
  reviewCap?: "adversarial" | "advisory" | "none";
  /** When true, this scope is the enabled plugin's freeform/default fallback
   *  (plugin-only installs where the core `classic` default is
   *  deselected). At most one enabled scope should set this. */
  freeformDefault?: boolean;
}

let _scopeMetadata: Record<string, ScopeMetadata> | null = null;
let _scopeMetadataAll: Record<string, ScopeMetadata> | null = null;

type ScopeGridForMapping = Record<string, { stages: Record<string, "EXECUTE" | "SKIP"> }>;

function transposeScopeGridForMapping(stages: StageEntry[]): ScopeGridForMapping {
  const scopeNames = new Set<string>();
  for (const stage of stages) {
    for (const name of stage.scopes ?? []) scopeNames.add(name);
  }
  const grid: ScopeGridForMapping = {};
  for (const scope of [...scopeNames].sort()) {
    const stagesMap: Record<string, "EXECUTE" | "SKIP"> = {};
    for (const stage of stages) {
      stagesMap[stage.slug] = (stage.scopes ?? []).includes(scope) ? "EXECUTE" : "SKIP";
    }
    grid[scope] = { stages: stagesMap };
  }
  return grid;
}

function loadScopeGridForMapping(): ScopeGridForMapping {
  const p = scopeGridPath();
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ScopeGridForMapping;
  } catch {
    return transposeScopeGridForMapping(loadStageGraph());
  }
}

export function loadScopeMetadataAll(): Record<string, ScopeMetadata> {
  if (_scopeMetadataAll !== null) return _scopeMetadataAll;
  const dir = scopesDir();
  const out: Record<string, ScopeMetadata> = {};
  const nameToFile = new Map<string, string>();
  let files: string[];
  try {
    // Sort so readdirSync order is platform-independent — the derived
    // scope set + the designer-export `scopes` key order stay deterministic
    // across machines (same discipline as loadAgents()).
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    files = [];
  }
  for (const f of files) {
    const filePath = join(dir, f);
    const body = readFileSync(filePath, "utf-8");
    const fm = frontmatterBlock(body);
    if (fm === null) throw new Error(`Scope file missing frontmatter: ${filePath}`);
    const name = scalarField(fm, "name");
    if (!name) throw new Error(`Scope file ${filePath} missing required frontmatter: name`);
    const previousFile = nameToFile.get(name);
    if (previousFile) {
      throw new Error(
        `Duplicate scope name "${name}" in ${filePath}: already declared in ${previousFile}. Rename one of them.`
      );
    }
    nameToFile.set(name, filePath);
    const meta: ScopeMetadata = {
      name,
      depth: scalarField(fm, "depth"),
      description: scalarField(fm, "description"),
      keywords: listField(fm, "keywords"),
      skeleton: false,
    };
    const plugin = scalarField(fm, "plugin");
    if (plugin) {
      // `aidlc-` is core's namespace: scope-runner dirs are `aidlc-<name>` for
      // core scopes but the bare name for plugin scopes, so an aidlc--prefixed
      // plugin would land its runner on a core path and silently clobber it
      // (same invariant compile enforces for stage frontmatter).
      if (plugin.startsWith("aidlc-")) {
        throw new Error(
          `Scope file ${filePath} declares plugin "${plugin}"; the "aidlc-" prefix is reserved for core (it collides with core runner paths). Rename the plugin.`
        );
      }
      meta.plugin = plugin;
    }
    const ts = scalarField(fm, "testStrategy");
    if (ts) meta.testStrategy = ts;
    const runner = scalarField(fm, "runner");
    if (runner === "true" || runner === "false") meta.runner = runner === "true";
    const skeleton = scalarField(fm, "skeleton");
    if (skeleton) {
      if (skeleton !== "on" && skeleton !== "off") {
        throw new Error(
          `Scope file ${filePath} has invalid skeleton value "${skeleton}". Expected "on" or "off".`
        );
      }
      meta.skeleton = skeleton === "on";
    }
    if (scalarField(fm, "freeform_default") === "true") meta.freeformDefault = true;
    const reviewCap = scalarField(fm, "review_cap");
    if (reviewCap) {
      if (
        reviewCap !== "adversarial" &&
        reviewCap !== "advisory" &&
        reviewCap !== "none"
      ) {
        throw new Error(
          `Scope file ${filePath} has invalid review_cap value "${reviewCap}". Expected "adversarial", "advisory", or "none".`
        );
      }
      meta.reviewCap = reviewCap;
    }
    out[name] = meta;
  }
  _scopeMetadataAll = out;
  return out;
}

// --- Review-class resolution (stage-protocol-reviewer §12a) ---
//
// Three inputs, one effective class, resolved LOW-WINS along the same
// precedence idea as the tier cap (aidlc-tiers.ts): the stage declares its
// default, the scope may cap it, and a per-run override (state field
// `Review Override`, written by `aidlc-utility config-change --review`)
// beats both. Ordering: none < advisory < adversarial. A stage with no
// reviewer is always "none" - no cap or override can conjure a reviewer.
export const REVIEW_CLASSES = ["none", "advisory", "adversarial"] as const;
export type ReviewClass = (typeof REVIEW_CLASSES)[number];

const REVIEW_RANK: Record<ReviewClass, number> = {
  none: 0,
  advisory: 1,
  adversarial: 2,
};

function asReviewClass(v: string | null | undefined): ReviewClass | null {
  return v === "none" || v === "advisory" || v === "adversarial" ? v : null;
}

/** The effective review class for one stage run. `stageClass` is the compiled
 *  node's review_class (undefined when the stage declares no reviewer -
 *  resolves to "none"). `scope` names the active scope (its review_cap is
 *  read from scope metadata; unknown scope or absent cap = no cap).
 *  `stateContent` supplies the per-run `Review Override` field when present.
 *  An override or cap can only LOWER the stage's declared class, never raise
 *  it: min() everywhere, so `--review adversarial` on an advisory stage keeps
 *  advisory, and neither can revive a reviewer the stage never declared. */
export function resolveReviewClass(
  stageClass: string | undefined,
  scope: string,
  stateContent?: string | null
): ReviewClass {
  const declared = asReviewClass(stageClass);
  if (declared === null) return "none"; // no reviewer on the stage
  let effective: ReviewClass = declared;
  const cap = loadScopeMetadata()[scope]?.reviewCap;
  if (cap && REVIEW_RANK[cap] < REVIEW_RANK[effective]) effective = cap;
  const override = asReviewClass(
    stateContent ? getField(stateContent, "Review Override") : null
  );
  if (override && REVIEW_RANK[override] < REVIEW_RANK[effective]) {
    effective = override;
  }
  return effective;
}

export function loadScopeMetadata(): Record<string, ScopeMetadata> {
  if (_scopeMetadata !== null) return _scopeMetadata;
  const all = loadScopeMetadataAll();
  const selected = pluginsEnabled();
  const enabled: Record<string, ScopeMetadata> = {};
  for (const [name, meta] of Object.entries(all)) {
    const owner = meta.plugin ?? "aidlc";
    if (selected === null || selected.has(owner)) enabled[name] = meta;
  }
  const nominated = Object.values(enabled)
    .filter((meta) => meta.freeformDefault === true)
    .map((meta) => meta.name)
    .sort();
  if (nominated.length > 1) {
    throw new Error(
      `Multiple enabled scopes declare freeform_default: true (${nominated.join(", ")}). ` +
        "At most one enabled scope may nominate the freeform default."
    );
  }
  _scopeMetadata = enabled;
  return enabled;
}

// loadScopeMapping reconstructs the legacy `Record<scope, ScopeDefinition>`
// shape so every existing consumer (the EXECUTE/SKIP `.stages` map, the
// keyword/depth/description reads) keeps working unchanged after the JSON
// source-of-truth is retired. Two sources:
//   - AIDLC_SCOPE_MAPPING set  → read that JSON file verbatim (test seam).
//   - unset (the shipped path) → merge the compiled scope-grid.json
//     (.stages) with the .claude/scopes/*.md frontmatter (depth/keywords/
//     description/testStrategy). Scope set = the .md files present.
export function loadScopeMapping(): Record<string, ScopeDefinition> {
  if (_scopeMapping !== null) return _scopeMapping;

  const jsonPath = scopeMappingPath();
  if (jsonPath !== null) {
    // Test-seam path: an injected scope-mapping.json fixture.
    let raw: string;
    try {
      raw = readFileSync(jsonPath, "utf-8");
    } catch (err) {
      throw new Error(
        `Scope mapping not readable at ${jsonPath}: ${errorMessage(err)}. ` +
          `AIDLC_SCOPE_MAPPING points to ${jsonPath}; unset it to derive from .claude/scopes/.`
      );
    }
    let parsed: Record<string, ScopeDefinition>;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Scope mapping at ${jsonPath} is not valid JSON: ${errorMessage(err)}`);
    }
    _scopeMapping = parsed;
    return parsed;
  }

  // Shipped path: derive from the compiled grid + per-scope .md metadata.
  // Keep the grid read local to avoid a circular aidlc-lib -> aidlc-graph
  // require while aidlc-graph's CLI is still initialising under native Windows
  // Bun.
  const grid = loadScopeGridForMapping();
  const metadata = loadScopeMetadata();

  const out: Record<string, ScopeDefinition> = {};
  for (const name of Object.keys(metadata)) {
    const meta = metadata[name];
    const def: ScopeDefinition = {
      depth: meta.depth,
      stages: grid[name]?.stages ?? {},
      keywords: meta.keywords,
      description: meta.description,
    };
    if (meta.testStrategy !== undefined) def.testStrategy = meta.testStrategy;
    if (meta.plugin !== undefined) def.plugin = meta.plugin;
    if (meta.runner !== undefined) def.runner = meta.runner;
    def.skeleton = meta.skeleton;
    out[name] = def;
  }
  _scopeMapping = out;
  return out;
}

// Reset caches so fixture-swapping tests can reload from a different
// AIDLC_SCOPE_MAPPING / AIDLC_STAGE_GRAPH path within the same bun
// process. Mirrors the precedent set by aidlc-graph.ts __resetGraphCache.
export function _resetScopeMappingForTests(): void {
  _scopeMapping = null;
  _scopeMetadata = null;
  _scopeMetadataAll = null;
  _validScopes = null;
}

export function _resetStageGraphForTests(): void {
  _stageGraph = null;
  _stageGraphAll = null;
}

// Canonical scope names derived from .claude/scopes/*.md presence (via
// loadScopeMapping's metadata source). Dropping a new core aidlc-<name>.md file
// or plugin <plugin>-<name>.md file automatically flows through every tool that
// validates scope arguments — no code change. Sorted alphabetically so
// error-message enumeration is deterministic regardless of file-read order.
// (Under the AIDLC_SCOPE_MAPPING test seam the names come from the injected JSON
// keys instead.)
let _validScopes: ReadonlySet<string> | null = null;

export function validScopes(): ReadonlySet<string> {
  if (!_validScopes) {
    _validScopes = new Set(Object.keys(loadScopeMapping()).sort());
  }
  return _validScopes;
}

export interface DefaultScopeResolution {
  scope: string;
  error?: string;
  note?: string;
}

// The framework's single hard-coded default scope — the bottom of every
// default ladder (the engine's scope resolution, `/aidlc-init`, the low-level
// `intent-create` fallback, and the help-text "(default)" marker). Exactly two
// things control the implicit default: the AWS_AIDLC_DEFAULT_SCOPE env var
// (which overrides when set) and this constant (when the var is unset).
export const DEFAULT_SCOPE = "classic";

// AWS_AIDLC_DEFAULT_SCOPE resolved with the engine ladder's semantics: unset →
// null; a valid scope → itself; an installed-but-disabled scope → the
// selection-aware rescue; an unknown value → returned verbatim so the caller's
// own validation owns the canonical `Unknown scope` error.
export function envDefaultScope(): string | null {
  const envScope = (process.env.AWS_AIDLC_DEFAULT_SCOPE || "").trim();
  if (envScope.length === 0) return null;
  if (validScopes().has(envScope)) return envScope;
  if (loadScopeMetadataAll()[envScope] === undefined) return envScope;
  return selectionAwareDefaultScope(envScope).scope;
}

export function selectionAwareDefaultScope(preferred: string = DEFAULT_SCOPE): DefaultScopeResolution {
  const scopes = [...validScopes()];
  if (scopes.includes(preferred)) return { scope: preferred };

  // An explicit nomination wins whenever `preferred` is not enabled, regardless
  // of plugin bucketing: a scope with frontmatter `freeform_default: true` is
  // the install's declared lean default (e.g. a plugin's lightweight scope over
  // its heavier full-lifecycle scope). Checked before the sole-plugin heuristic
  // below so it also holds in mixed installs.
  const meta = loadScopeMetadata();
  const nominatedGlobal = scopes.find((s) => meta[s]?.freeformDefault === true);
  if (nominatedGlobal) {
    return {
      scope: nominatedGlobal,
      note: `scope "${preferred}" is not an enabled scope; using "${nominatedGlobal}" (nominated freeform default)`,
    };
  }

  const mapping = loadScopeMapping();
  const scopesByPlugin = new Map<string, string[]>();
  for (const scope of scopes) {
    const owner = mapping[scope]?.plugin ?? "aidlc";
    const bucket = scopesByPlugin.get(owner) ?? [];
    bucket.push(scope);
    scopesByPlugin.set(owner, bucket);
  }

  const coreScopes = scopesByPlugin.get("aidlc") ?? [];
  const pluginOwners = [...scopesByPlugin.keys()].filter((owner) => owner !== "aidlc").sort();

  if (coreScopes.length === 0 && pluginOwners.length === 1) {
    const only = [...(scopesByPlugin.get(pluginOwners[0]) ?? [])].sort();
    if (only.length > 0) {
      return {
        scope: only[0],
        note: `scope "${preferred}" is not an enabled scope; using "${only[0]}" (sole enabled plugin's first scope)`,
      };
    }
  }

  return {
    scope: preferred,
    error:
      scopes.length === 0
        ? `No default scope is available: core scope "${preferred}" is disabled or absent and no plugin scopes are enabled. Pass --scope explicitly.`
        : coreScopes.length > 0
          ? `No default scope is available: scope "${preferred}" is disabled or absent while core scopes are enabled. Pass --scope explicitly.`
          : `No default scope is available: core scope "${preferred}" is disabled or absent and multiple plugin scope owners are enabled (${pluginOwners.join(", ")}). Pass --scope explicitly.`,
  };
}

/**
 * Thin string-returning wrapper over {@link selectionAwareDefaultScope} for
 * callers that just need the resolved scope name. `preferred` is the caller's
 * core-era literal (DEFAULT_SCOPE, "classic", for both freeform inference and
 * intent creation).
 * When `preferred` is enabled it wins (stock behaviour preserved); otherwise
 * the nominated freeform default (or the sole enabled plugin's first scope) is
 * returned, falling back to `preferred` when nothing can be chosen.
 */
export function resolveDefaultScope(preferred: string): string {
  return selectionAwareDefaultScope(preferred).scope;
}

// Agent metadata derived from `.claude/agents/*.md` frontmatter. Adding a
// new agent means dropping in an `.md` file with the required fields; the
// loader discovers it at next invocation. Sorted alphabetically by slug
// so readdirSync order is platform-independent.

export interface AgentMetadata {
  slug: string;
  display_name: string;
  examples: string[];
}

// .claude/agents/ holds one <slug>.md per persona. AIDLC_AGENTS_DIR env-var
// seam mirrors AIDLC_SCOPES_DIR / AIDLC_SENSORS_DIR so fixture tests can point
// the agent-metadata loader at an isolated tree. Evaluated at call time so
// tests that set/unset mid-process see the change.
export function agentsDir(): string {
  return process.env.AIDLC_AGENTS_DIR
    ?? resolveHarnessPath(["agents"]);
}

let _agents: AgentMetadata[] | null = null;

export function loadAgents(): AgentMetadata[] {
  if (!_agents) {
    const dir = agentsDir();
    const slugToFile = new Map<string, string>();
    const agents: AgentMetadata[] = [];
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md") && f !== "aidlc.md")
      .sort();
    for (const f of files) {
      const filePath = join(dir, f);
      const agent = parseAgentFrontmatter(filePath);
      const previousFile = slugToFile.get(agent.slug);
      if (previousFile) {
        throw new Error(
          `Duplicate agent slug "${agent.slug}" in ${filePath}: already declared in ${previousFile}. Rename one of them.`
        );
      }
      slugToFile.set(agent.slug, filePath);
      agents.push(agent);
    }
    _agents = agents.sort((a, b) => a.slug.localeCompare(b.slug));
  }
  return _agents;
}

export function _resetAgentsForTests(): void {
  _agents = null;
}

function parseAgentFrontmatter(path: string): AgentMetadata {
  const body = readFileSync(path, "utf-8");
  const fm = frontmatterBlock(body);
  if (fm === null) throw new Error(`Agent file missing frontmatter: ${path}`);

  const slug = scalarField(fm, "name");
  const display_name = scalarField(fm, "display_name");
  const examples = listField(fm, "examples");

  const missing: string[] = [];
  if (!slug) missing.push("name");
  if (!display_name) missing.push("display_name");
  if (missing.length > 0) {
    throw new Error(
      `Agent file ${path} missing required frontmatter: ${missing.join(", ")}`
    );
  }
  return { slug, display_name, examples };
}

export function frontmatterBlock(body: string): string | null {
  const m = body.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m?.[1] ?? null;
}

// Scalar field parser. Rejects YAML folded/literal block markers
// (`>`, `|`) so `description: >` on the next line can't be silently
// captured as the value. Strips surrounding quotes so
// `display_name: "Foo"` renders as `Foo` in user-facing output.
//
// Exported so aidlc-rule-schema.ts can reuse the zero-dep YAML primitive
// (rule frontmatter has the same scalar/list shape as agent frontmatter).
export function scalarField(fm: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m");
  const m = fm.match(re);
  if (!m) return "";
  const raw = m[1].trim();
  if (raw === ">" || raw === "|" || raw === ">-" || raw === "|-") return "";
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

// List field parser. Accepts block sequences and single-line flow sequences.
// Bounds block list items strictly to indented `- ` lines so a following
// `description: >` folded block cannot leak its continuation lines into this
// list. Requires at least one space after the dash — YAML syntax demands it,
// and accepting `-foo` silently as `foo` masks user error when adding new
// agents.
//
// Exported so aidlc-rule-schema.ts can reuse the zero-dep YAML primitive
// (rule frontmatter's `paths:` is a YAML list of strings).
export function listField(fm: string, key: string): string[] {
  const re = new RegExp(
    `^${key}:\\s*\\n((?:[ \\t]+-[ \\t]+[^\\r\\n]+\\r?\\n?)+)`,
    "m"
  );
  const m = fm.match(re);
  if (m) {
    return m[1]
      .split(/\r?\n/)
      .map((l) => {
        const match = l.match(/^\s*-[ \t]+(.+?)\s*$/);
        return match ? match[1].replace(/^["']|["']$/g, "") : "";
      })
      .filter(Boolean);
  }

  const flowRe = new RegExp(
    `^${key}:[ \\t]*(\\[[^\\r\\n]*)$`,
    "m"
  );
  const flow = fm.match(flowRe);
  return flow ? parseInlineDepsList(flow[1]) : [];
}

// --- Stage frontmatter parse / emit ---

// parseStageFrontmatter reads a stage `.md` file body and extracts the
// YAML frontmatter block into a plain object shaped like the
// StageFrontmatter interface in stage-schema.ts. Pure — no I/O, no
// validation. Callers wanting schema checks pipe the result through
// validateStageFrontmatter() from stage-schema.ts.
//
// Extends the hand-rolled zero-dep parser pattern from loadAgents()
// above: scalarField for scalars, listField for string lists, and the
// new objectListField below for the consumes[] nested-object shape.
export function parseStageFrontmatter(
  raw: string
): Record<string, unknown> {
  if (typeof raw !== "string") {
    throw new Error(
      `parseStageFrontmatter expected string, got ${typeof raw}`
    );
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) {
    throw new Error("Stage file missing YAML frontmatter (---...---)");
  }
  const fm = m[1];

  const obj: Record<string, unknown> = {};

  // Discover every top-level key in the frontmatter block. Passing
  // unknown keys through (rather than silently dropping them) is what
  // lets stage-schema.ts's validator reject reserved names like
  // `when:` / `on_failure:` with target-release messages. Scalar keys
  // parse via scalarField, list keys via listField, and `consumes:`
  // goes through objectListField.
  const topLevelKeys = new Set<string>();
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([a-z_][a-z0-9_]*)\s*:/);
    if (m) topLevelKeys.add(m[1]);
  }

  const ARRAY_KEYS = new Set([
    "support_agents",
    "produces",
    "requires_stage",
    "sensors",
    "scopes",
  ]);
  const CONSUMES_KEY = "consumes";

  // `when` is a nested single-key map (when:\n  producer-in-plan: <slug>), not a
  // scalar — parse it separately below. Skip it in the scalar loop so it isn't
  // captured as an empty string.
  const WHEN_KEY = "when";

  for (const key of topLevelKeys) {
    if (key === CONSUMES_KEY) continue;
    if (key === WHEN_KEY) continue;
    if (key === "produces_kinds") continue; // parsed below; the scalar loop would stamp it ""
    if (ARRAY_KEYS.has(key)) continue;
    // optional_produces and required_sections are presence-gated array fields
    // parsed below; skip them here so the scalar loop does not stamp them with
    // an empty-string value.
    if (key === "optional_produces") continue;
    if (key === "required_sections") continue;
    // The key was discovered at the start of some line, so it IS
    // present. scalarField returns "" for both absent AND empty-quoted
    // ("") — since we know it's present, assign the result
    // unconditionally. An empty-string value reaches the validator
    // (which will flag condition: "" as an invalid required-field
    // value if the field should be non-empty — that's a schema
    // concern, not a parser concern).
    obj[key] = scalarField(fm, key);
  }

  // Required string-array fields must be PRESENT in the object even
  // when empty — stage-schema.ts rejects absent required fields with
  // "missing required field". listField returns [] when its block
  // regex doesn't match, so unconditional assignment is safe.
  for (const key of ARRAY_KEYS) {
    obj[key] = listField(fm, key);
  }

  obj.consumes = objectListField(fm, CONSUMES_KEY);

  // optional_produces is an OPTIONAL array field: an absent key yields an
  // absent property (mirrors for_each), so only annotated stages carry it
  // through compile and the stage-graph JSON stays minimal. listField's regex
  // anchors `^optional_produces:` (multiline), so it cannot cross-match the
  // `produces:` block and vice versa.
  if (topLevelKeys.has("optional_produces")) {
    obj.optional_produces = listField(fm, "optional_produces");
  }

  // produces_kinds is presence-gated: only assigned when the top-level key
  // exists, so an unannotated stage compiles with the property ABSENT (not an
  // empty object), preserving byte-identical emit for every stage that does
  // not use the map.
  if (topLevelKeys.has("produces_kinds")) {
    obj.produces_kinds = mapOfListsField(fm, "produces_kinds");
  }

  // required_sections is an OPTIONAL array field (plugin contribution mechanism
  // §6): named `## ` H2 sections a stage's output must contain. Absent key ->
  // absent property, so core stages that don't author it stay byte-identical.
  // Without this, an authored `required_sections:` block list would fall to the
  // scalar loop and parse as the string "- ...", failing schema validation with
  // "required_sections must be array, got string".
  if (topLevelKeys.has("required_sections")) {
    obj.required_sections = listField(fm, "required_sections");
  }

  // reviewer_max_iterations is the one numeric scalar field. The generic
  // scalar loop above captured it as a string ("2"); coerce it to a real
  // number when the raw value is an integer literal so the type is correct
  // end-to-end — the schema validator, the directive contract, and the
  // conductor's `iterations < max` comparison all want a number, not "2".
  // A non-integer-literal value (e.g. "two", "2.5") is left as the string so
  // validateStageFrontmatter rejects it loudly rather than the parser
  // silently coercing to NaN. `reviewer` stays a string (handled by the loop).
  if (typeof obj.reviewer_max_iterations === "string") {
    const raw = obj.reviewer_max_iterations;
    if (/^-?\d+$/.test(raw)) {
      obj.reviewer_max_iterations = Number(raw);
    }
  }

  // workspace_requires is the one boolean scalar field. The generic scalar loop
  // above captured it as a string ("true"/"false"); coerce to a real boolean so
  // StageEntry/GraphStage and the schema validator see the typed value (mirrors
  // consumes.required's "true"/"false" coercion in objectListField). A non-boolean
  // token is left as the string so validateStageFrontmatter rejects it loudly.
  if (typeof obj.workspace_requires === "string") {
    const raw = obj.workspace_requires;
    if (raw === "true" || raw === "false") {
      obj.workspace_requires = raw === "true";
    }
  }

  // `when` — nested single-key predicate map. Present only on plugin stages
  // (plugin mechanism, Layer 4). Parse the one indented `<predicate>: <value>`
  // line into an object so the schema validator sees the map it expects; absent
  // means the key never appears. Only assigned when the key was discovered.
  if (topLevelKeys.has(WHEN_KEY)) {
    // Match the `when:` line and the immediately-following indented child line.
    const whenMatch = fm.match(/^when:\s*\n\s+([a-z][a-z0-9-]*)\s*:\s*(.+?)\s*$/m);
    if (whenMatch) {
      obj.when = { [whenMatch[1]]: whenMatch[2] };
    } else {
      // inline form `when: {producer-in-plan: X}` or malformed — capture the raw
      // scalar so the validator can reject a non-map shape loudly.
      const inline = fm.match(/^when:\s*\{\s*([a-z][a-z0-9-]*)\s*:\s*([^}]+?)\s*\}\s*$/m);
      obj.when = inline ? { [inline[1]]: inline[2].trim() } : scalarField(fm, WHEN_KEY);
    }
  }

  return obj;
}

// parseMemoryHeadings counts entries under each of the four canonical
// §13 H2 headings in a memory.md file and returns the per-heading
// breakdown plus the total. Pure function — no I/O, no validation.
// Single source of truth for runtime-graph compile, gate-ritual
// candidate surfacing, and memory.md lifecycle.
//
// Canonical headings (case-sensitive, exact match, no leading
// whitespace): "## Interpretations", "## Deviations", "## Tradeoffs",
// "## Open questions". Pinned by tests/smoke/t86-stage-protocol-section-13.sh.
//
// Counting rule: a non-blank, non-excluded line under a canonical
// heading counts as one entry. Bullets, prose paragraphs, and
// ISO-timestamped lines all count one each.
//
// Excluded (do NOT count): blank/whitespace-only lines, blockquote-only
// lines (`>` with no other content), HTML-comment-only lines
// (`<!-- ... -->`), code-fence delimiters (```), the canonical heading
// lines themselves, and any line inside a fenced code block.
//
// Section termination: any non-canonical H2 (`## X` not in the four
// anchors) below a canonical heading stops counting for the prior
// section; lines beneath it are ignored entirely.
//
// Missing canonical heading returns 0 for that key — never throws.
// Silent-skip detection is the consumer's concern; failing the parse
// because the orchestrator wrote three of four headings under context
// pressure would be the wrong move.
export function parseMemoryHeadings(raw: string): {
  interpretations: number;
  deviations: number;
  tradeoffs: number;
  open_questions: number;
  total: number;
} {
  if (typeof raw !== "string") {
    throw new Error(
      `parseMemoryHeadings expected string, got ${typeof raw}`
    );
  }

  const counts = {
    interpretations: 0,
    deviations: 0,
    tradeoffs: 0,
    open_questions: 0,
  };

  const HEADING_TO_KEY: Record<string, keyof typeof counts> = {
    "## Interpretations": "interpretations",
    "## Deviations": "deviations",
    "## Tradeoffs": "tradeoffs",
    "## Open questions": "open_questions",
  };

  const normalized = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let current: keyof typeof counts | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (line in HEADING_TO_KEY) {
      current = HEADING_TO_KEY[line];
      continue;
    }
    if (/^## /.test(line)) {
      current = null;
      continue;
    }

    if (current === null) continue;

    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^>/.test(trimmed)) continue;
    if (/^<!--.*-->\s*$/.test(trimmed)) continue;

    counts[current]++;
  }

  const total =
    counts.interpretations +
    counts.deviations +
    counts.tradeoffs +
    counts.open_questions;
  return { ...counts, total };
}

// parseMemoryEntries — the per-entry companion to parseMemoryHeadings (used
// by the learning-gate surface step, which needs each entry's ts /
// summary / context, not just counts). It reuses parseMemoryHeadings' exact
// skip logic (in-fence toggle, four canonical-heading anchors, non-canonical
// H2 section termination, blockquote/comment/blank skip) so the invariant
// `parseMemoryEntries(raw).length === parseMemoryHeadings(raw).total` holds
// for ANY input — ONE entry per counted line, NO multi-line merging. A
// wrapped/continuation line that does not match the canonical
// `- <ISO> — <summary>; <context>` shape degrades into its own degenerate
// entry (summary = the raw line, ts/context empty) rather than merging into
// the preceding entry, preserving the count invariant.
export function parseMemoryEntries(raw: string): Array<{
  heading: "Interpretations" | "Deviations" | "Tradeoffs" | "Open questions";
  ts: string;
  summary: string;
  context: string;
  raw: string;
}> {
  if (typeof raw !== "string") {
    throw new Error(`parseMemoryEntries expected string, got ${typeof raw}`);
  }

  const HEADING_TO_DISPLAY: Record<
    string,
    "Interpretations" | "Deviations" | "Tradeoffs" | "Open questions"
  > = {
    "## Interpretations": "Interpretations",
    "## Deviations": "Deviations",
    "## Tradeoffs": "Tradeoffs",
    "## Open questions": "Open questions",
  };

  const normalized = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const entries: Array<{
    heading: "Interpretations" | "Deviations" | "Tradeoffs" | "Open questions";
    ts: string;
    summary: string;
    context: string;
    raw: string;
  }> = [];

  let current:
    | "Interpretations"
    | "Deviations"
    | "Tradeoffs"
    | "Open questions"
    | null = null;
  let inFence = false;

  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (line in HEADING_TO_DISPLAY) {
      current = HEADING_TO_DISPLAY[line];
      continue;
    }
    if (/^## /.test(line)) {
      current = null;
      continue;
    }

    if (current === null) continue;

    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^>/.test(trimmed)) continue;
    if (/^<!--.*-->\s*$/.test(trimmed)) continue;

    // Counted line → one entry. Parse the canonical bullet shape; degrade to
    // raw on any deviation (never throw).
    const { ts, summary, context } = parseMemoryEntryLine(trimmed);
    entries.push({ heading: current, ts, summary, context, raw: trimmed });
  }

  return entries;
}

// Split a single counted memory line into ts / summary / context. The
// canonical shape is `- <ISO> — <summary>; <context>` (stage-protocol.md
// :876-879). Tolerates a missing `;` (tail → summary, context empty) and a
// missing ts/em-dash (degrade to summary = the whole line, ts empty).
function parseMemoryEntryLine(trimmed: string): {
  ts: string;
  summary: string;
  context: string;
} {
  // Strip a leading list bullet ("- " or "* ").
  const body = trimmed.replace(/^[-*]\s+/, "");
  // Pull an ISO-8601 timestamp prefix followed by an em-dash separator.
  const tsMatch = body.match(/^(\S+)\s+—\s+(.*)$/);
  if (!tsMatch) {
    return { ts: "", summary: body, context: "" };
  }
  const ts = tsMatch[1];
  const rest = tsMatch[2];
  const semi = rest.indexOf(";");
  if (semi === -1) {
    return { ts, summary: rest.trim(), context: "" };
  }
  return {
    ts,
    summary: rest.slice(0, semi).trim(),
    context: rest.slice(semi + 1).trim(),
  };
}

// emitStageFrontmatter is the inverse — turns a StageFrontmatter-shaped
// object back into YAML bytes. Symmetric with parseStageFrontmatter:
// parse → emit → parse yields the same object. Field order is pinned
// to stage-definition.md:84-110's worked example so diffs stay stable.
export function emitStageFrontmatter(obj: Record<string, unknown>): string {
  const needsQuote = (v: string): boolean => /[:#]|^\s|\s$/.test(v);
  const emitScalar = (v: string): string =>
    needsQuote(v) ? `"${v.replace(/"/g, '\\"')}"` : v;

  const FIELD_ORDER = [
    "slug",
    "number",
    "name",
    "plugin",
    "phase",
    "execution",
    "condition",
    "lead_agent",
    "support_agents",
    "mode",
    "summary_confirmation",
    "reviewer",
    "review_artifact",
    "reviewer_max_iterations",
    "review_class",
    "for_each",
    "workspace_requires",
    "produces",
    "optional_produces",
    "produces_kinds",
    "consumes",
    "requires_stage",
    "sensors",
    "scopes",
    "inputs",
    "outputs",
  ] as const;

  const lines: string[] = ["---"];

  for (const key of FIELD_ORDER) {
    const v: unknown = obj[key];
    if (v === undefined) continue;

    if (key === "produces_kinds") {
      // A map of artifact-name to inline kind list. Emit in insertion order
      // (the parse order the record preserves) so parse, emit, parse
      // round-trips (t65's contract).
      if (!isPlainObject(v)) continue;
      const entries = Object.entries(v);
      if (entries.length === 0) continue;
      lines.push("produces_kinds:");
      for (const [name, kinds] of entries) {
        if (!Array.isArray(kinds)) continue;
        lines.push(`  ${name}: [${(kinds as unknown[]).map((k) => String(k)).join(", ")}]`);
      }
    } else if (key === "consumes") {
      if (!Array.isArray(v)) continue;
      const consumes: unknown[] = v;
      if (consumes.length === 0) {
        lines.push("consumes: []");
      } else {
        lines.push("consumes:");
        for (const entry of consumes) {
          if (!isPlainObject(entry)) continue;
          const e = entry;
          if (typeof e.artifact === "string") {
            lines.push(`  - artifact: ${emitScalar(e.artifact)}`);
          }
          if (typeof e.required === "boolean") {
            lines.push(`    required: ${e.required}`);
          }
          if (typeof e.conditional_on === "string") {
            lines.push(`    conditional_on: ${emitScalar(e.conditional_on)}`);
          }
        }
      }
    } else if (Array.isArray(v)) {
      const arr: unknown[] = v;
      if (arr.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of arr) {
          lines.push(`  - ${typeof item === "string" ? emitScalar(item) : String(item)}`);
        }
      }
    } else if (typeof v === "string") {
      lines.push(`${key}: ${emitScalar(v)}`);
    } else if (typeof v === "number") {
      // reviewer_max_iterations round-trips as an unquoted number, matching
      // how stages author it on disk (`reviewer_max_iterations: 2`). Without
      // this branch the numeric value the parser now returns (V1) would be
      // dropped on emit, breaking the parse -> emit -> parse contract (t65).
      lines.push(`${key}: ${v}`);
    } else if (typeof v === "boolean") {
      // workspace_requires round-trips as an unquoted boolean (the parser
      // coerces the "true"/"false" token to a real boolean), so emit it
      // unquoted to preserve the parse -> emit -> parse contract.
      lines.push(`${key}: ${v}`);
    }
  }

  lines.push("---");
  return `${lines.join("\n")}\n`;
}

// Map-of-lists parser for the produces_kinds: frontmatter block. Matches an
// indented block of `artifact-name: [kind, kind]` lines under the top-level
// key, each value an INLINE list only (mirrors listField's strictness: a
// block-list value is rejected, not silently mis-parsed):
//
//   produces_kinds:
//     frontend-components: [ui]
//     scalability-requirements: [service]
//
// Returns an insertion-ordered record (parse order), so emitStageFrontmatter
// can round-trip it byte-identically. Each value is split with the same
// bracket logic parseInlineDepsList uses for depends_on. An empty inline list
// (`[]`) yields an empty array; the schema validator rejects that as a
// non-empty-list violation. Throws on a non-inline value so a mistaken
// block-list author error fails loud rather than dropping the entry.
function mapOfListsField(fm: string, key: string): Record<string, string[]> {
  const blockRe = new RegExp(
    `^${key}:\\s*\\n((?:[ \\t]+[a-z][a-z0-9-]*\\s*:\\s*[^\\n]*(?:\\r?\\n|$))+)`,
    "m"
  );
  const m = fm.match(blockRe);
  if (!m) return {};
  const out: Record<string, string[]> = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const entry = line.match(/^\s+([a-z][a-z0-9-]*)\s*:\s*(.+?)\s*$/);
    if (!entry) {
      throw new Error(`Malformed ${key} entry in frontmatter: ${line.trim()}`);
    }
    const value = entry[2].trim();
    if (!(value.startsWith("[") && value.endsWith("]"))) {
      throw new Error(
        `${key}.${entry[1]} must be an inline list (e.g. [service, ui]), got: ${value}`
      );
    }
    out[entry[1]] = parseInlineDepsList(value);
  }
  return out;
}

// Nested-object list parser. Matches the specific shape stage-definition.md
// uses for consumes[]:
//
//   consumes:
//     - artifact: intent-statement
//       required: true
//     - artifact: feasibility-assessment
//       required: false
//       conditional_on: brownfield
//
// Each `- ` item starts a new object; indented `k: v` lines add fields
// to the current object. Booleans coerce from "true"/"false"; quoted
// strings have their quotes stripped. Rejects deeper nesting, anchors,
// and block scalars — same strictness philosophy as listField above.
//
// The trailing alternation `(?:\r?\n|$)` is required because the
// enclosing frontmatter extractor strips the newline before the
// closing `---`, so the last line of a consumes[] block often has no
// trailing `\n` at match time. Without `|$` the regex silently drops
// it.
function objectListField(
  fm: string,
  key: string
): Array<Record<string, unknown>> {
  const blockRe = new RegExp(
    `^${key}:\\s*\\n((?:[ \\t]+-[ \\t]+[^\\n]+(?:\\r?\\n|$)(?:[ \\t]+[^- \\t\\n][^\\n]*(?:\\r?\\n|$))*)+)`,
    "m"
  );
  const m = fm.match(blockRe);
  if (!m) return [];

  // Detect blank lines inside the block — the outer regex stops at the
  // first blank line, so a blank between items would silently drop the
  // second item. Rather than skip quietly, look ahead past the captured
  // block: if the next lines are still indented with `- ` items, the
  // author wrote a blank separator — reject it.
  const blockEnd = (m.index ?? 0) + m[0].length;
  const rest = fm.slice(blockEnd).split(/\r?\n/);
  for (const line of rest) {
    if (line === "" || /^[ \t]+$/.test(line)) continue;
    if (/^[ \t]+-[ \t]/.test(line)) {
      throw new Error(
        `Blank line not allowed inside ${key}[] block — list items must be consecutive`
      );
    }
    break;
  }

  const lines = m[1].split(/\r?\n/).filter((l) => l.trim() !== "");
  const items: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | null = null;

  for (const line of lines) {
    const itemMatch = line.match(/^\s*-\s+([a-z_]+):\s*(.+?)\s*$/);
    const subMatch = line.match(/^\s+([a-z_]+):\s*(.+?)\s*$/);

    if (itemMatch) {
      if (current) items.push(current);
      current = {};
      current[itemMatch[1]] = coerceScalar(itemMatch[2]);
    } else if (subMatch && current) {
      current[subMatch[1]] = coerceScalar(subMatch[2]);
    } else {
      throw new Error(
        `Malformed ${key}[] entry in frontmatter: ${line.trim()}`
      );
    }
  }
  if (current) items.push(current);
  return items;
}

// Scalar coercion for objectListField values. Quoted scalars always
// return as strings (the quote-strip happens AFTER the boolean check),
// so unquoted `true` → boolean, quoted `"true"` → string "true".
// Matches scalarField's quote-stripping rules.
function coerceScalar(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

// --- Stage graph queries ---

export function findStageBySlug(slug: string): StageEntry | undefined {
  return loadStageGraph().find((s) => s.slug === slug);
}

export function findStageByNumber(num: string): StageEntry | undefined {
  return loadStageGraph().find((s) => s.number === num);
}

export function resolveStage(slugOrNumber: string): StageEntry | undefined {
  return findStageBySlug(slugOrNumber) || findStageByNumber(slugOrNumber);
}

export function stageIndex(slug: string): number {
  return loadStageGraph().findIndex((s) => s.slug === slug);
}

// When stateContent is provided, the state file's per-stage EXECUTE/SKIP
// suffix and checkbox state override the scope-mapping.json defaults. This
// matters for Greenfield bugfix flows where handleInit stamps
// reverse-engineering SKIP (even though scope-mapping.json maps it EXECUTE)
// and for jumps that skipped stages via `[S]`. Without the override the
// state tool would try to activate a stage the state file said was done.
export function nextInScopeStage(
  afterSlug: string,
  scope: string,
  stateContent?: string
): StageEntry | null {
  const mapping = loadScopeMapping()[scope];
  if (!mapping) return null;

  const stateOverrides = stateContent
    ? parseStateStageSuffixes(stateContent)
    : null;
  const checkboxStates = stateContent ? parseCheckboxes(stateContent) : [];

  // Walk the full graph forward from afterSlug, applying the same action-
  // resolution rule the pre-rewire implementation used: state overrides
  // take precedence over scope-mapping. The common case (no overrides,
  // or only SKIP overrides) produces byte-identical output to
  // subgraphForScope-based iteration — proven by t66 walk parity across
  // all 11 scopes. The uncommon case (a hand-edited state file promoting
  // a scope-SKIP stage to EXECUTE) is the power-user escape hatch
  // aidlc-state.ts:276-284's explicit-advance path also honours; keeping
  // both callers consistent on the same input.
  const graph = loadStageGraph();
  const currentIdx = graph.findIndex((s) => s.slug === afterSlug);
  if (currentIdx === -1) return null;

  for (let i = currentIdx + 1; i < graph.length; i++) {
    const slug = graph[i].slug;

    // Already completed or skipped via jump — keep walking.
    const cb = checkboxStates.find((c) => c.slug === slug);
    if (cb && (cb.state === "completed" || cb.state === "skipped")) continue;

    // State override wins over scope-mapping. A SKIP override drops an
    // EXECUTE stage; an EXECUTE override promotes a SKIP stage.
    const effectiveAction = stateOverrides?.get(slug) ?? mapping.stages[slug];
    if (effectiveAction === "EXECUTE") return graph[i];
  }
  return null;
}

// Resolve one stage's action in the approved workflow plan. State suffixes
// include recomposition and project-type overrides, so they take precedence
// over the stock scope grid.
export function effectivePlanAction(
  slug: string,
  scope: string | null | undefined,
  stateContent: string | null,
): "EXECUTE" | "SKIP" | undefined {
  const stateAction = stateContent
    ? parseStateStageSuffixes(stateContent).get(slug)
    : undefined;
  if (stateAction !== undefined) return stateAction;
  return scope ? loadScopeMapping()[scope]?.stages[slug] : undefined;
}

// A per-unit stage uses one stage-level artifact set when the approved plan
// excludes the Unit DAG producer.
export function usesStageLevelPerUnitArtifacts(
  scope: string | null | undefined,
  stateContent: string | null,
): boolean {
  return effectivePlanAction("units-generation", scope, stateContent) !== "EXECUTE";
}

// Parse each stage's EXECUTE or SKIP suffix from Stage Progress. The suffix is
// the approved plan action, independent of the checkbox run state.
export function parseStateStageSuffixes(
  content: string
): Map<string, "EXECUTE" | "SKIP"> {
  const out = new Map<string, "EXECUTE" | "SKIP">();
  const regex = /^- \[[ xSR?-]\] (\S+)\s*—\s*(EXECUTE|SKIP)\b/gm;
  let m: RegExpExecArray | null = regex.exec(content);
  while (m !== null) {
    // The regex's second capture group only matches "EXECUTE" or "SKIP";
    // narrow via predicate so the Map.set call is fully typed.
    const action = m[2];
    if (action === "EXECUTE" || action === "SKIP") {
      out.set(m[1], action);
    }
    m = regex.exec(content);
  }
  return out;
}

export function unitMajorConstructionStageSlugs(
  scope: string,
  stateContent: string,
  includeCompleted = false,
): string[] {
  const mapping = loadScopeMapping()[scope];
  if (!mapping) return [];
  const stateOverrides = parseStateStageSuffixes(stateContent);
  const checkboxStates = new Map(
    parseCheckboxes(stateContent).map((entry) => [entry.slug, entry.state]),
  );
  return loadStageGraph()
    .filter((stage) => {
      if (
        stage.phase !== "construction" ||
        stage.for_each !== "unit-of-work"
      ) {
        return false;
      }
      const checkbox = checkboxStates.get(stage.slug);
      if (checkbox === "skipped") return false;
      if (checkbox === "completed" && !includeCompleted) return false;
      return (
        stateOverrides.get(stage.slug) ?? mapping.stages[stage.slug]
      ) === "EXECUTE";
    })
    .map((stage) => stage.slug);
}

export function firstInScopeStageOfPhase(
  phase: string,
  scope: string
): StageEntry | null {
  const mapping = loadScopeMapping()[scope];
  if (!mapping) return null;

  // Lazy require to avoid circular import (aidlc-graph imports from us).
  // Type-only import at top of file pins the signature.
  const { subgraphForScope } = require("./aidlc-graph.ts") as {
    subgraphForScope: typeof SubgraphForScope;
  };
  const path = subgraphForScope(scope);

  const phaseLower = phase.toLowerCase();
  for (const stage of path) {
    if (stage.phase === phaseLower) return stage;
  }
  return null;
}

export function stagesInScope(
  scope: string
): Array<{ slug: string; phase: string; action: "EXECUTE" | "SKIP" }> {
  const graph = loadStageGraph();
  if (!loadScopeMapping()[scope]) return [];

  // Lazy require to avoid circular import (aidlc-graph imports from us).
  const { subgraphForScope } = require("./aidlc-graph.ts") as {
    subgraphForScope: typeof SubgraphForScope;
  };
  const onPath = new Set(
    subgraphForScope(scope).map((s) => s.slug)
  );

  return graph.map((s) => ({
    slug: s.slug,
    phase: s.phase,
    action: onPath.has(s.slug) ? ("EXECUTE" as const) : ("SKIP" as const),
  }));
}

// --- Scope cost summary ---
//
// One source of truth for the ceremony a scope (or an arbitrary composer grid)
// carries: stage counts, approval-gate count, and per-unit fan-out. The routing
// strings, the creation print, the scope-change output, and the composer validator
// all read these numbers instead of recomputing them, so the confirm the user
// sees agrees with the grid the engine runs.

export interface ScopeCostSummary {
  total: number;         // stages in the grid (32 today, never hardcoded)
  execute: number;       // EXECUTE count
  skip: number;          // total - execute
  gates: number;         // EXECUTE stages outside initialization; mirrors
                         // computeGate() in aidlc-orchestrate.ts - change together
  perUnitStages: number; // EXECUTE stages that repeat per Unit of Work when
                         // units-generation EXECUTEs; otherwise they run once
}

// Cost of an arbitrary EXECUTE/SKIP grid (the composer-proposal shape). Indexes
// the compiled graph by slug once, then walks the grid entries. The gate rule
// (EXECUTE stage whose phase is not initialization) is the closed form of
// computeGate() in aidlc-orchestrate.ts - if a per-stage gate flag ever lands,
// change both. Grid slugs missing from the graph contribute to total/execute
// but not gates/perUnit (defensive; validate-grid already rejects unknown slugs
// for a real proposal, so this only matters for a stale composed scope).
export function gridCostSummary(
  stages: Record<string, "EXECUTE" | "SKIP">,
): ScopeCostSummary {
  const byslug = new Map<string, StageEntry>();
  for (const s of loadStageGraph()) byslug.set(s.slug, s);
  const total = Object.keys(stages).length;
  const hasUnitDag = stages["units-generation"] === "EXECUTE";
  let execute = 0;
  let gates = 0;
  let perUnitStages = 0;
  for (const [slug, action] of Object.entries(stages)) {
    if (action !== "EXECUTE") continue;
    execute++;
    const node = byslug.get(slug);
    if (!node) continue;
    if (node.phase !== "initialization") gates++;
    // Without units-generation there is no Unit DAG, so per-unit stages
    // degrade to one stage-level pass (aidlc-orchestrate.ts).
    if (hasUnitDag && isPerUnitStage(node)) perUnitStages++;
  }
  return { total, execute, skip: total - execute, gates, perUnitStages };
}

// Cost of a named scope's grid. Returns null for an unknown scope.
export function scopeCostSummary(scope: string): ScopeCostSummary | null {
  const def = loadScopeMapping()[scope];
  if (!def) return null;
  return gridCostSummary(def.stages);
}

// --- Timestamp ---

export function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- Hook drop counter ---
//
// Hooks swallow audit emission errors to avoid breaking the user's tool call,
// but silent failure was the whole point of the state-machine refactor.
// Record drops to a per-hook counter file so `--doctor` can surface them.
// File format: one drop per line (ISO timestamp, TAB, one-line reason),
// most recent drop last. Doctor's advisory probe reads the count and the
// last line's timestamp.

export function recordHookDrop(
  projectDir: string,
  hookName: string,
  reason: string
): void {
  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    const dropFile = join(healthDir, `${hookName}.drops`);
    const line = `${isoTimestamp()}\t${reason.replace(/\r?\n/g, " ")}\n`;
    appendFileSync(dropFile, line, "utf-8");
  } catch {
    // Drop-log failure is truly non-fatal — we're already in a failure path.
  }
}

// --- Hook debug log ---
//
// Append a structured debug line to `<health>/hook-debug.log` so a hook's
// decision path can be inspected after a run WITHOUT re-deriving it by
// hypothesis. OPT-IN ONLY, off by default (zero log growth / zero write cost on
// a normal run). Two independent switches, either enables it:
//   1. Env var `AIDLC_HOOK_DEBUG` — best for the CLI/Claude/Codex:
//      `AIDLC_HOOK_DEBUG=1 <command>` or export it.
//   2. Filesystem marker `aidlc/.aidlc-hook-debug` — best for Kiro IDE, where
//      the hook subprocesses are spawned by the IDE and an env var needs an IDE
//      restart to take effect. `touch aidlc/.aidlc-hook-debug` turns logging on
//      for the very next hook fire (no restart); `rm` it to turn off. When
//      projectDir cannot be resolved (rare), only the env var is consulted.
// Never throws; logging must never break a hook's advisory exit-0 contract.
export function hookDebugEnabled(projectDir?: string): boolean {
  if (process.env.AIDLC_HOOK_DEBUG) return true;
  if (projectDir) {
    try {
      return existsSync(join(workspaceRoot(projectDir), ".aidlc-hook-debug"));
    } catch {
      return false;
    }
  }
  return false;
}

export function hookDebug(
  projectDir: string,
  hookName: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (!hookDebugEnabled(projectDir)) return;
  try {
    const healthDir = hooksHealthDir(projectDir);
    mkdirSync(healthDir, { recursive: true });
    const logFile = join(healthDir, "hook-debug.log");
    const parts = [isoTimestamp(), hookName, message];
    if (fields && Object.keys(fields).length > 0) {
      const flat = Object.entries(fields)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      parts.push(flat);
    }
    appendFileSync(logFile, `${parts.join("\t").replace(/\r?\n/g, " ")}\n`, "utf-8");
  } catch {
    // Debug-log failure is non-fatal — observability is best-effort.
  }
}

// Recursion guard: if emitError is entered while emitting ERROR_LOGGED fails,
// do not re-enter. The guard is process-local (one flag) — tools exit after
// one error(), so nested error() calls inside a single process are bugs.
let _errorEmitInProgress = false;

// Centralised error-exit used by all tool CLIs. Emits ERROR_LOGGED (best-
// effort, no-op if no workflow in cwd, swallows any audit failure), prints
// JSON error to stderr, exits 1.
//
// `tool`    — tool name (e.g. "aidlc-state", "aidlc-jump")
// `command` — the failing subcommand + args (typically process.argv.slice(2).join(" "))
// `msg`     — human-readable error shown to the caller and recorded in audit
//
// Uses appendAuditEntry (the canonical audit emitter) so the drift test's
// forward/reverse check sees ERROR_LOGGED as a standard emission call site.
// Type-only import for the lazy-loaded aidlc-audit.ts dependency. Same
// pattern as aidlc-graph.ts above — the runtime cycle is broken by
// require() below; type erases at compile time.
import type {
  appendAuditEntry as AppendAuditEntry,
  appendAuditEntryUnlocked as AppendAuditEntryUnlocked,
} from "./aidlc-audit.ts";

export function redactProjectDirPrefix(
  value: string,
  projectDir: string,
): string {
  const variants = new Set<string>([resolvePath(projectDir)]);
  try {
    variants.add(realpathSync(projectDir));
  } catch {
    // The caller still gets lexical-prefix redaction when the root vanished.
  }
  for (const variant of [...variants]) {
    variants.add(variant.replaceAll("\\", "/"));
    variants.add(variant.replaceAll("/", "\\"));
  }
  let redacted = value;
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    let offset = 0;
    while (offset < redacted.length) {
      const index = redacted.indexOf(variant, offset);
      if (index === -1) break;
      const next = redacted[index + variant.length];
      if (
        next !== undefined &&
        next !== "/" &&
        next !== "\\" &&
        !/\s/.test(next)
      ) {
        offset = index + variant.length;
        continue;
      }
      redacted =
        `${redacted.slice(0, index)}<project-dir>${redacted.slice(index + variant.length)}`;
      offset = index + "<project-dir>".length;
    }
  }
  return redacted;
}

// Failures are swallowed — we're already exiting, the caller gets the JSON
// error on stderr regardless.
export function emitError(
  projectDir: string,
  tool: string,
  command: string,
  msg: string,
  intent?: string,
  space?: string
): never {
  const auditCommand = redactProjectDirPrefix(command, projectDir);
  const auditMessage = redactProjectDirPrefix(msg, projectDir);
  if (!_errorEmitInProgress) {
    _errorEmitInProgress = true;
    try {
      if (existsSync(stateFilePath(projectDir))) {
        // Lazy import to break the lib.ts ↔ aidlc-audit.ts cycle at load time.
        // aidlc-audit.ts imports from lib.ts, and importing it at top of lib.ts
        // would create a circular dependency. Dynamic import is synchronous via
        // require under Bun and keeps the dependency one-way at module-init time.
        const audit = require("./aidlc-audit.ts") as {
          appendAuditEntry: typeof AppendAuditEntry;
          appendAuditEntryUnlocked: typeof AppendAuditEntryUnlocked;
        };
        // If we're inside a withAuditLock-held critical section (e.g., the
        // caller is aidlc-state.ts fork/merge mid-transaction), the audit
        // lock is already held by us. Use the unlocked variant directly so
        // the ERROR_LOGGED row lands without the 5s acquire timeout. The
        // exit-handler safety net releases the lock dir on process.exit.
        // NOTE: holdsAuditLock keys on the COMPOSITE lock identity (per-intent
        // keying, P3) — a bare `AUDIT_LOCK_EXIT_HANDLERS.has(projectDir)` would
        // miss the workspace-bucket / per-intent handler keys and re-introduce
        // the 5s self-deadlock on every in-transaction error emit.
        //
        // The caller threads its RESOLVED intent+space (fork/merge hold a
        // PER-INTENT lock — aidlc-state.ts error()/lockIntent). We MUST probe and
        // emit on the SAME bucket: a bare holdsAuditLock(projectDir) keys the
        // __workspace__ sentinel, returns false mid per-intent transaction, takes
        // the 5s blocking-acquire branch, and writes ERROR_LOGGED to the wrong
        // shard. Omitted intent/space -> sentinel, which is correct for every
        // sentinel-locked caller (the common case).
        if (holdsAuditLock(projectDir, intent, space)) {
          audit.appendAuditEntryUnlocked("ERROR_LOGGED", {
            Tool: tool,
            Command: auditCommand,
            Error: auditMessage,
          }, projectDir, intent, space);
        } else {
          audit.appendAuditEntry("ERROR_LOGGED", {
            Tool: tool,
            Command: auditCommand,
            Error: auditMessage,
          }, projectDir, intent, space);
        }
      }
    } catch {
      // Audit write failed — we're already in an error path, swallow.
    }
  }
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

// --- Helpers ---

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- CLI argument parsing ---

export function parseArgs(args: string[]): {
  positional: string[];
  flags: Record<string, string>;
  bareFlags: Set<string>;
  blankFlags: Set<string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const bareFlags = new Set<string>();
  const blankFlags = new Set<string>();
  let i = 0;
  while (i < args.length) {
    if (args[i].startsWith("--")) {
      const token = args[i].slice(2);
      const equals = token.indexOf("=");
      if (equals >= 0) {
        const key = token.slice(0, equals);
        const value = token.slice(equals + 1);
        flags[key] = value;
        if (value.trim().length === 0) blankFlags.add(key);
        i++;
        continue;
      }
      const key = token;
      if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        flags[key] = args[i + 1];
        if (args[i + 1].trim().length === 0) blankFlags.add(key);
        i += 2;
      } else {
        flags[key] = "true";
        bareFlags.add(key);
        i++;
      }
    } else {
      positional.push(args[i]);
      i++;
    }
  }
  return { positional, flags, bareFlags, blankFlags };
}

// --- Repeated field collection for --field key=value ---

export function parseFieldArgs(args: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--field" && i + 1 < args.length) {
      const eqIdx = args[i + 1].indexOf("=");
      if (eqIdx > 0) {
        fields[args[i + 1].slice(0, eqIdx)] = args[i + 1].slice(eqIdx + 1);
      }
      i++;
    }
  }
  return fields;
}

// --- Markdown section helpers ---
// Used by practices-discovery affirmation (copy under ## Mandated /
// ## Forbidden) and the orchestrator (reads aidlc-team.md sections for
// stance lookup). Pure string operations against well-formed markdown.
// Caller is responsible for code-fence-free input — rules/aidlc-*.md
// never contain fenced ## lines per spec.
//
// Heading-match rules:
//   - Pass the full marker form ("## Walking Skeleton") as `heading`.
//   - Trailing whitespace on the actual heading line is tolerated.
//   - Sub-headings (`### Walking Skeleton`) never match `## Walking Skeleton`.
//   - On multiple matches of the same heading, the first wins.
//   - When the heading is absent, extract returns "" and append throws.

export function extractMarkdownSection(content: string, heading: string): string {
  // Returns the prose between `heading` (e.g. "## Walking Skeleton") and the
  // next `## ` heading at the same level (or end of file). The heading line
  // itself is not included in the output. Returns "" if heading is absent.
  // Headings inside fenced code blocks (```) are skipped — a teaching example
  // that contains `## Walking Skeleton` should not be mistaken for the actual
  // section.
  const stripped = stripFencedCodeBlocks(content);
  const headingRegex = new RegExp(
    `^${escapeRegex(heading)}[ \\t]*$`,
    "m",
  );
  const startMatch = headingRegex.exec(stripped);
  if (!startMatch) return "";
  const afterHeading = startMatch.index + startMatch[0].length;
  // Skip the newline immediately after the heading line, if any.
  const bodyStart = stripped[afterHeading] === "\n" ? afterHeading + 1 : afterHeading;
  // Find the next `## ` heading at the same level (not `### ` or deeper).
  const nextHeading = /^## [^\n]*$/m;
  nextHeading.lastIndex = bodyStart;
  const remainder = stripped.slice(bodyStart);
  const nextMatch = nextHeading.exec(remainder);
  const bodyEnd = nextMatch ? bodyStart + nextMatch.index : stripped.length;
  return stripped.slice(bodyStart, bodyEnd);
}

// Replace fenced-code contents with blank lines while preserving all other
// text. This is the long-standing extraction contract: HTML comments remain
// part of the returned section for callers that inspect them directly.
function stripFencedCodeBlocks(content: string): string {
  const lines = content.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) {
      inFence = !inFence;
      lines[i] = "";
      continue;
    }
    if (inFence) lines[i] = "";
  }
  return lines.join("\n");
}

function multilineInlineCodeSpanEnd(
  lines: string[],
  startLine: number,
  start: number,
): { line: number; offset: number } | null {
  let length = 1;
  while (lines[startLine][start + length] === "`") length++;
  const sameLine = inlineCodeSpanEnd(lines[startLine], start);
  if (sameLine !== null) return { line: startLine, offset: sameLine };

  // Inline parsing cannot carry through a blank or a new heading-like block.
  // Stopping conservatively also prevents an unmatched delimiter from hiding a
  // later question heading while still supporting ordinary soft line breaks.
  const startCandidate = stripMarkdownContainerPrefix(lines[startLine]);
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(startCandidate)) return null;
  for (let line = startLine + 1; line < lines.length; line++) {
    const candidate = stripMarkdownContainerPrefix(lines[line]);
    if (
      candidate.trim() === "" ||
      isMarkdownBlockBoundary(candidate) ||
      rawHtmlBlockStart(candidate) !== null
    ) {
      return null;
    }
    let cursor = 0;
    while (cursor < lines[line].length) {
      const tick = lines[line].indexOf("`", cursor);
      if (tick < 0) break;
      let candidateLength = 1;
      while (lines[line][tick + candidateLength] === "`") candidateLength++;
      if (candidateLength === length) {
        return { line, offset: tick + candidateLength };
      }
      cursor = tick + candidateLength;
    }
  }
  return null;
}

// Replace invisible Markdown (HTML comments, code spans, and block code) with
// blank lines while preserving line positions. Literal contexts are resolved
// before comment state so a `<!--` example cannot hide later visible headings.
export function visibleMarkdownLines(
  content: string,
  options: {
    preserveIndentedCode?: boolean;
    preserveCommentBoundaries?: boolean;
  } = {},
): string[] {
  const lines = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    // NUL is the internal marker used below for removed comments. Escape a
    // literal NUL first so hostile input cannot manufacture a reserved heading.
    .map((line) =>
      line.replaceAll(
        INVISIBLE_COMMENT_MARKER,
        RAW_INVISIBLE_COMMENT_MARKER_ESCAPE,
      ),
    );
  const visible: string[] = [];
  let inComment = false;
  let commentContainer: MarkdownContainerSegment[] = [];
  let fence: {
    marker: "`" | "~";
    length: number;
    container: MarkdownContainerSegment[];
  } | null = null;
  let codeSpanEnd: { line: number; offset: number } | null = null;
  let rawHtmlBlock: {
    end: RegExp;
    container: MarkdownContainerSegment[];
  } | null = null;
  let htmlTagOpen = false;
  let htmlAttributeQuote: '"' | "'" | null = null;
  let activeContainer: {
    segments: MarkdownContainerSegment[];
    hadBlank: boolean;
  } | null = null;

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const rawLine = lines[lineNumber];
    const explicitContainerLine = markdownContainerLine(rawLine);
    let containerLine = explicitContainerLine;
    if (activeContainer !== null) {
      const blank = rawLine.trim() === "";
      const continuation = blank
        ? ""
        : markdownContainerContinuation(rawLine, activeContainer.segments);
      const hasBlockquote = activeContainer.segments.some(
        (segment) => segment.type === "blockquote",
      );
      const lazyBlockStart = hasBlockquote &&
        /^(?: {0,3})(?:[`~]{3,}|<!--)/.test(rawLine);
      if (blank) {
        containerLine = { content: "", segments: activeContainer.segments };
        activeContainer = {
          segments: activeContainer.segments,
          hadBlank: true,
        };
      } else if (continuation !== null) {
        const nested = markdownContainerLine(continuation);
        containerLine = {
          content: nested.content,
          segments: [...activeContainer.segments, ...nested.segments],
        };
        activeContainer = { segments: containerLine.segments, hadBlank: false };
      } else if (
        explicitContainerLine.segments.some(
          (segment) => segment.type === "list" || segment.type === "blockquote",
        )
      ) {
        containerLine = explicitContainerLine;
        activeContainer = null;
      } else if (
        lazyBlockStart ||
        (!activeContainer.hadBlank && !isMarkdownBlockBoundary(rawLine))
      ) {
        // A paragraph may continue lazily after a list or blockquote marker.
        // Keep the container alive so a later indented fence/comment cannot
        // be reinterpreted as a top-level excluded span.
        containerLine = {
          content: rawLine,
          segments: activeContainer.segments,
        };
        activeContainer = {
          segments: activeContainer.segments,
          hadBlank: false,
        };
      } else {
        activeContainer = null;
      }
    }
    if (
      containerLine.segments.some(
        (segment) => segment.type === "list" || segment.type === "blockquote",
      )
    ) {
      activeContainer = {
        segments: containerLine.segments,
        hadBlank: rawLine.trim() === "",
      };
    }
    if (rawHtmlBlock) {
      const continuation = rawHtmlBlock.container.length === 0
        ? rawLine
        : rawLine.trim() === ""
          ? ""
          : markdownContainerContinuation(rawLine, rawHtmlBlock.container);
      if (continuation === null) {
        rawHtmlBlock = null;
      } else {
        if (rawHtmlBlock.end.test(continuation)) {
          rawHtmlBlock = null;
        }
        visible.push("");
        continue;
      }
    }

    if (fence) {
      const continuation = fence.container.length === 0
        ? rawLine
        : rawLine.trim() === ""
          ? ""
          : markdownContainerContinuation(rawLine, fence.container);
      if (continuation === null) {
        // CommonMark ends a fenced block when the list item or blockquote that
        // owns it ends. Reprocess this line outside the old container so a
        // following top-level heading cannot be hidden by an unclosed fence.
        fence = null;
      }
      if (fence === null) {
        // Fall through and parse the boundary line normally.
      } else {
        // A list item can indent its fenced-code continuation by the marker's
        // full content offset (more than three columns). Accepting broader
        // closing indentation here is conservative: if a renderer treats an
        // over-indented marker as literal code, exposing the following lines can
        // only fail closed on a visible heading; leaving a real close hidden
        // would let an appended heading remain inside the excluded span.
        const closing = /^[ \t]*([`~]+)[ \t]*$/.exec(continuation ?? "");
        const closingMarker = closing?.[1];
        if (closingMarker === undefined) {
          visible.push("");
          continue;
        }
        if (
          closingMarker.split("").every((marker) => marker === fence!.marker) &&
          closingMarker.length >= fence.length
        ) {
          fence = null;
        }
        visible.push("");
        continue;
      }
    }

    if (
      inComment &&
      commentContainer.length > 0 &&
      rawLine.trim() !== "" &&
      markdownContainerContinuation(rawLine, commentContainer) === null
    ) {
      // HTML comment blocks are scoped to their Markdown container just like
      // fenced blocks. A line outside that container is visible again.
      inComment = false;
      commentContainer = [];
    }

    if (htmlTagOpen) {
      const candidate = stripMarkdownContainerPrefix(rawLine);
      if (
        candidate.trim() === "" ||
        /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:=+|-+)[ \t]*$|<h[1-6]\b)/i.test(
          candidate,
        ) ||
        (htmlAttributeQuote === null && /^\[Answer\]:/.test(candidate))
      ) {
        // A malformed, unclosed tag must not mask a later block heading. A
        // renderer that keeps this inside the attribute only gets a fail-closed
        // rejection; a real closing tag is still tracked normally below.
        htmlTagOpen = false;
        htmlAttributeQuote = null;
      }
    }
    const continuedHtmlTag = htmlTagOpen;
    let line = continuedHtmlTag ? INVISIBLE_LINE_MARKER : "";
    let cursor = 0;
    let continuedCodeSpan = false;
    if (codeSpanEnd !== null) {
      if (lineNumber < codeSpanEnd.line) {
        visible.push("");
        continue;
      }
      cursor = codeSpanEnd.offset;
      codeSpanEnd = null;
      continuedCodeSpan = true;
      // This line is still paragraph continuation even after the delimiter.
      // Keep it ineligible for block-heading recognition.
      line = INVISIBLE_LINE_MARKER;
    }

    const rawOpening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(
      containerLine.content,
    );
    if (
      !inComment &&
      !continuedCodeSpan &&
      !htmlTagOpen &&
      rawOpening &&
      (rawOpening[1][0] === "~" || !rawOpening[2].includes("`"))
    ) {
      fence = {
        marker: rawOpening[1][0] as "`" | "~",
        length: rawOpening[1].length,
        container: containerLine.segments,
      };
      visible.push("");
      continue;
    }

    if (
      !options.preserveIndentedCode &&
      !inComment &&
      !continuedCodeSpan &&
      !htmlTagOpen &&
      /^(?: {4}|\t)/.test(stripMarkdownContainerPrefix(rawLine))
    ) {
      visible.push("");
      continue;
    }

    const rawHtmlOpening = !inComment &&
        !continuedCodeSpan &&
        !htmlTagOpen
      ? rawHtmlBlockStart(containerLine.content)
      : null;
    if (rawHtmlOpening !== null) {
      rawHtmlBlock = {
        ...rawHtmlOpening,
        container: containerLine.segments,
      };
      if (rawHtmlOpening.end.test(containerLine.content)) {
        rawHtmlBlock = null;
      }
      visible.push("");
      continue;
    }

    while (cursor < rawLine.length) {
      if (inComment) {
        const end = rawLine.indexOf("-->", cursor);
        if (end < 0) {
          cursor = rawLine.length;
          break;
        }
        inComment = false;
        commentContainer = [];
        line += INVISIBLE_COMMENT_MARKER;
        cursor = end + 3;
        continue;
      }

      if (
        rawLine[cursor] === "`" &&
        !htmlTagOpen &&
        !isEscapedAt(rawLine, cursor)
      ) {
        const end = multilineInlineCodeSpanEnd(lines, lineNumber, cursor);
        if (end === null) {
          line += rawLine.slice(cursor);
          break;
        }
        if (end.line === lineNumber) {
          line += rawLine.slice(cursor, end.offset);
          cursor = end.offset;
          continue;
        }
        line += INVISIBLE_LINE_MARKER;
        codeSpanEnd = end;
        cursor = rawLine.length;
        continue;
      }

      if (rawLine.startsWith("<!--", cursor)) {
        const candidate = containerLine.content;
        const blockStart = /^ {0,3}<!--/.exec(candidate);
        const candidateOffset = rawLine.length - candidate.length;
        const atBlockStart = blockStart !== null &&
          candidateOffset + blockStart[0].length - 4 === cursor;
        const closesOnLine = rawLine.indexOf("-->", cursor + 4) >= 0;
        if (
          isEscapedAt(rawLine, cursor) ||
          (!closesOnLine && (!atBlockStart || htmlTagOpen))
        ) {
          line += "<!--";
          cursor += 4;
          continue;
        }
        line += INVISIBLE_COMMENT_MARKER;
        inComment = true;
        commentContainer = containerLine.segments;
        cursor += 4;
        continue;
      }

      const character = rawLine[cursor];
      line += character;
      if (htmlTagOpen) {
        if (htmlAttributeQuote !== null) {
          if (character === htmlAttributeQuote) htmlAttributeQuote = null;
        } else if (character === '"' || character === "'") {
          htmlAttributeQuote = character;
        } else if (character === ">") {
          htmlTagOpen = false;
        }
      } else if (
        character === "<" &&
        /[A-Za-z!/]/.test(rawLine[cursor + 1] ?? "")
      ) {
        htmlTagOpen = true;
      }
      cursor++;
    }

    visible.push(
      options.preserveCommentBoundaries
        ? line
        : restoreVisibleMarkdownMarkers(line),
    );
  }

  return visible;
}

export function appendUnderHeading(
  content: string,
  heading: string,
  newContent: string,
): string {
  // Inserts `newContent` immediately before the next `## ` heading after
  // `heading` (or at end-of-file when `heading` is the last `## ` section).
  // Throws if `heading` is not present in `content`.
  const headingRegex = new RegExp(
    `^${escapeRegex(heading)}[ \\t]*$`,
    "m",
  );
  const startMatch = headingRegex.exec(content);
  if (!startMatch) {
    throw new Error(`appendUnderHeading: heading not found: ${heading}`);
  }
  const afterHeading = startMatch.index + startMatch[0].length;
  const bodyStart = content[afterHeading] === "\n" ? afterHeading + 1 : afterHeading;
  const nextHeading = /^## [^\n]*$/m;
  const remainder = content.slice(bodyStart);
  const nextMatch = nextHeading.exec(remainder);
  const insertAt = nextMatch ? bodyStart + nextMatch.index : content.length;
  return content.slice(0, insertAt) + newContent + content.slice(insertAt);
}

export function replaceSection(
  content: string,
  heading: string,
  newContent: string,
): string {
  // Replaces the prose between `heading` and the next `## ` heading (or EOF)
  // with `newContent`. The heading line itself is preserved. Throws if
  // `heading` is not present. Used by practices-discovery affirmation:
  // re-runs overwrite aidlc-team.md sections rather than accumulating duplicates.
  const headingRegex = new RegExp(
    `^${escapeRegex(heading)}[ \\t]*$`,
    "m",
  );
  const startMatch = headingRegex.exec(content);
  if (!startMatch) {
    throw new Error(`replaceSection: heading not found: ${heading}`);
  }
  const afterHeading = startMatch.index + startMatch[0].length;
  const bodyStart = content[afterHeading] === "\n" ? afterHeading + 1 : afterHeading;
  const nextHeading = /^## [^\n]*$/m;
  const remainder = content.slice(bodyStart);
  const nextMatch = nextHeading.exec(remainder);
  const bodyEnd = nextMatch ? bodyStart + nextMatch.index : content.length;
  return content.slice(0, bodyStart) + newContent + content.slice(bodyEnd);
}

// --- Bolt/unit dependency DAG (units-generation 2.7 → runtime compile) ---

// The unit-kind enum: what a Unit of Work IS, so the engine can prune the
// per-unit construction design matrix to the artifacts that actually apply.
// A spec unit owes no scalability doc, a packaging unit no business-logic
// model. Authored once at the 2.7 gate on the units-generation edge block and
// confirmed by the human; consumed by the stage-schema validator (which shares
// this constant) and the engine's produces filter. Missing kind = full matrix
// (conservative default, zero behaviour change for untagged units).
export const UNIT_KINDS = ["service", "spec", "ui", "packaging", "library"] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export interface UnitDependencyEdge {
  name: string;
  depends_on: string[];
  // Optional per-unit kind (UNIT_KINDS). Absent = full design-artifact matrix.
  kind?: UnitKind;
}

// Discriminated result so the two consumers — the required-sections sensor
// (gate-time validation) and aidlc-runtime compile (DAG emission) — branch on
// one single source of truth:
//   - absent    : no fenced ```yaml units: block in the body
//   - malformed : block present but structurally invalid (duplicate name,
//                 dangling dependency, self-dependency, non-list value, no units)
//   - cyclic    : structurally valid edges that contain a dependency cycle
//   - ok        : units + batches (topological levels; each level sorted
//                 lexicographically; units with satisfied, non-mutual deps
//                 share a batch)
export type BoltDagParse =
  | { ok: true; units: UnitDependencyEdge[]; batches: string[][] }
  | { ok: false; reason: "absent" | "malformed" | "cyclic"; detail: string };

// Locate the first fenced ```yaml block whose body declares a top-level
// `units:` key. Returns the inner block text, or null when no such fence
// exists. Other fenced blocks (mermaid diagrams, prose examples) are skipped.
function extractYamlUnitsBlock(body: string): string | null {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^```ya?ml\s*$/.test(lines[i].trim())) {
      const inner: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^```\s*$/.test(lines[j].trim())) break;
        inner.push(lines[j]);
      }
      const block = inner.join("\n");
      if (/^\s*units\s*:/m.test(block)) {
        return block;
      }
      i = j; // not the units block — resume scanning past its close fence
    }
  }
  return null;
}

function unquoteScalar(s: string): string {
  const t = s.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

function parseInlineDepsList(raw: string): string[] {
  const t = raw.trim();
  if (t === "" || t === "[]") return [];
  if (t.startsWith("[")) {
    let close = -1;
    let quote: "\"" | "'" | null = null;
    for (let i = 1; i < t.length; i++) {
      const char = t[i];
      if (quote !== null) {
        if (quote === "\"" && char === "\\") {
          i++;
        } else if (char === quote) {
          quote = null;
        }
      } else if (char === "\"" || char === "'") {
        quote = char;
      } else if (char === "]") {
        close = i;
        break;
      }
    }
    if (quote !== null || close === -1) return [];
    if (!/^[ \t]*(?:#[^\r\n]*)?$/.test(t.slice(close + 1))) return [];

    const body = t.slice(1, close);
    const items: string[] = [];
    let start = 0;
    quote = null;
    for (let i = 0; i < body.length; i++) {
      const char = body[i];
      if (quote !== null) {
        if (quote === "\"" && char === "\\") {
          i++;
        } else if (char === quote) {
          quote = null;
        }
      } else if (char === "\"" || char === "'") {
        quote = char;
      } else if (char === ",") {
        items.push(body.slice(start, i));
        start = i + 1;
      }
    }
    if (quote !== null) return [];
    items.push(body.slice(start));
    return items.map((item) => unquoteScalar(item)).filter((item) => item !== "");
  }
  // Bare scalar (rare) — treat as a one-item list.
  return [unquoteScalar(t)];
}

// Hand-rolled zero-dep scanner for the `units:` block list. Mirrors the
// scalarField / listField primitives above (the framework ships no YAML
// dependency). Throws on a structurally unparseable block; the caller maps
// the throw to a `malformed` result.
function parseUnitsBlock(block: string): UnitDependencyEdge[] {
  const lines = block.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^\s*units\s*:/.test(lines[i])) {
      const after = lines[i].replace(/^\s*units\s*:/, "").trim();
      if (after !== "") {
        throw new Error("units: must be a block list, not an inline value");
      }
      break;
    }
  }
  if (i >= lines.length) throw new Error("missing units: key");
  i++; // step past the `units:` line

  const edges: UnitDependencyEdge[] = [];
  let current: UnitDependencyEdge | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const nameMatch = line.match(/^\s*-\s+name\s*:\s*(.+?)\s*$/);
    if (nameMatch) {
      if (current) edges.push(current);
      current = { name: unquoteScalar(nameMatch[1]), depends_on: [] };
      continue;
    }

    const depMatch = line.match(/^\s*depends_on\s*:\s*(.*)$/);
    if (depMatch) {
      if (!current) throw new Error("depends_on: before any - name: entry");
      current.depends_on = parseInlineDepsList(depMatch[1]);
      continue;
    }

    // Optional per-unit kind. Mirrors the depends_on guard: a kind: line
    // before any - name: is malformed. The value must be one of UNIT_KINDS;
    // a typo fails loud here (mapped to reason "malformed" by parseBoltDag)
    // rather than silently falling back to the full matrix. Last-write-wins
    // on a duplicate kind: line, matching depends_on:'s posture.
    const kindMatch = line.match(/^\s*kind\s*:\s*(.+?)\s*$/);
    if (kindMatch) {
      if (!current) throw new Error("kind: before any - name: entry");
      const value = unquoteScalar(kindMatch[1]);
      if (!(UNIT_KINDS as readonly string[]).includes(value)) {
        throw new Error(
          `unit "${current.name}" has invalid kind "${value}" ` +
            `(expected ${UNIT_KINDS.join("|")})`
        );
      }
      current.kind = value as UnitKind;
      continue;
    }

    // Block-form dependency item (a bare `- dep` under `depends_on:`).
    const itemMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (itemMatch && current) {
      current.depends_on.push(unquoteScalar(itemMatch[1]));
      continue;
    }

    throw new Error(`unrecognised line in units block: ${line.trim()}`);
  }
  if (current) edges.push(current);

  for (const e of edges) {
    const nameError = validateUnitName(e.name);
    if (nameError) throw new Error(nameError);
  }
  return edges;
}

// Kahn's algorithm by level. Each level is a batch — the units whose
// dependencies are all already placed (satisfied, non-mutual). Levels are
// sorted lexicographically before emission so the output is deterministic
// regardless of input order or Set iteration order. Returns null when a
// cycle remains (no unit has all dependencies satisfied).
function computeBatches(edges: UnitDependencyEdge[]): string[][] | null {
  const deps = new Map<string, string[]>();
  for (const e of edges) deps.set(e.name, e.depends_on);
  const remaining = new Set(edges.map((e) => e.name));
  const batches: string[][] = [];
  while (remaining.size > 0) {
    const level: string[] = [];
    for (const name of remaining) {
      const satisfied = deps.get(name)!.every((dep) => !remaining.has(dep));
      if (satisfied) level.push(name);
    }
    if (level.length === 0) return null; // cycle
    level.sort();
    for (const name of level) remaining.delete(name);
    batches.push(level);
  }
  return batches;
}

// Parse the required fenced ```yaml edge block out of a
// unit-of-work-dependency.md body and compute the topological batch DAG.
//
// The block shape — authored once at the 2.7 gate (knowledge work by the
// LLM, behind a human approval gate):
//
//   ```yaml
//   units:
//     - name: auth
//       kind: service
//       depends_on: []
//     - name: api
//       depends_on: [auth]
//   ```
//
// The optional `kind:` line (UNIT_KINDS) drives the per-unit construction
// design-artifact pruning; omitting it keeps a unit on the full matrix.
//
// Pure data — no model call, no NLP. A given body always parses to the same
// result, so a hook-fired re-compile of runtime-graph.json stays
// byte-identical (no model in the path; the determinism invariant holds).
export function parseBoltDag(body: string): BoltDagParse {
  const block = extractYamlUnitsBlock(body);
  if (block === null) {
    return {
      ok: false,
      reason: "absent",
      detail: "no fenced ```yaml units: block found",
    };
  }

  let edges: UnitDependencyEdge[];
  try {
    edges = parseUnitsBlock(block);
  } catch (e) {
    return { ok: false, reason: "malformed", detail: errorMessage(e) };
  }

  if (edges.length === 0) {
    return { ok: false, reason: "malformed", detail: "units: block has no entries" };
  }

  const names = new Set<string>();
  const foldedNames = new Map<string, string>();
  for (const u of edges) {
    if (names.has(u.name)) {
      return { ok: false, reason: "malformed", detail: `duplicate unit name: ${u.name}` };
    }
    names.add(u.name);
    const folded = u.name.toLowerCase();
    const existing = foldedNames.get(folded);
    if (existing !== undefined && existing !== u.name) {
      return {
        ok: false,
        reason: "malformed",
        detail: `case-folding unit name collision: "${existing}" and "${u.name}"`,
      };
    }
    foldedNames.set(folded, u.name);
  }
  for (const u of edges) {
    for (const dep of u.depends_on) {
      if (dep === u.name) {
        return { ok: false, reason: "malformed", detail: `unit "${u.name}" depends on itself` };
      }
      if (!names.has(dep)) {
        return {
          ok: false,
          reason: "malformed",
          detail: `unit "${u.name}" depends on unknown unit "${dep}"`,
        };
      }
    }
  }

  const batches = computeBatches(edges);
  if (batches === null) {
    return { ok: false, reason: "cyclic", detail: "dependency cycle detected" };
  }
  return { ok: true, units: edges, batches };
}

export type BoltDagResolution =
  | {
      state: "ok";
      batches: string[][];
      units: string[];
      unitKinds: Map<string, string> | null;
      healed: boolean;
    }
  | { state: "none" }
  | { state: "malformed"; reason: string; detail: string };

type ResolvedBoltDag = Extract<BoltDagResolution, { state: "ok" }>;

function boltDagMatches(a: ResolvedBoltDag, b: ResolvedBoltDag): boolean {
  if (JSON.stringify(a.batches) !== JSON.stringify(b.batches)) return false;
  const aKinds = a.unitKinds ?? new Map<string, string>();
  const bKinds = b.unitKinds ?? new Map<string, string>();
  if (aKinds.size !== bKinds.size) return false;
  for (const [unit, kind] of aKinds) {
    if (bKinds.get(unit) !== kind) return false;
  }
  return true;
}

// Resolve the selected intent's unit DAG (the active intent when no selectors
// are supplied). The authored dependency artifact is authoritative whenever it
// exists: a valid cache is accepted only when its batches and unit kinds still
// match that artifact. Callers must keep the three states distinct: "none" is a
// real no-DAG workflow, while "malformed" means the unit set is unknowable and
// must fail closed.
export function resolveBoltDag(
  projectDir: string,
  intent?: string,
  space?: string,
): BoltDagResolution {
  let cached: ResolvedBoltDag | null = null;
  const graphPath = runtimeGraphPath(projectDir, intent, space);
  if (existsSync(graphPath)) {
    try {
      const graph: unknown = JSON.parse(readFileSync(graphPath, "utf-8"));
      const boltDag =
        graph !== null && typeof graph === "object" && "bolt_dag" in graph
          ? (graph as { bolt_dag?: { batches?: unknown; units?: unknown } }).bolt_dag
          : undefined;
      const batches = boltDag?.batches;
      if (
        Array.isArray(batches) &&
        batches.every(
          (batch) =>
            Array.isArray(batch) &&
            batch.every(
              (unit) =>
                typeof unit === "string" &&
                validateUnitName(unit) === null,
            ),
        )
      ) {
        const typedBatches = batches as string[][];
        const units = typedBatches.flat();
        if (units.length > 0 && new Set(units).size === units.length) {
          const unitKinds = new Map<string, string>();
          if (Array.isArray(boltDag?.units)) {
            for (const unit of boltDag.units) {
              if (
                unit !== null &&
                typeof unit === "object" &&
                typeof (unit as { name?: unknown }).name === "string" &&
                typeof (unit as { kind?: unknown }).kind === "string"
              ) {
                unitKinds.set(
                  (unit as { name: string }).name,
                  (unit as { kind: string }).kind,
                );
              }
            }
          }
          cached = {
            state: "ok",
            batches: typedBatches,
            units,
            unitKinds: unitKinds.size > 0 ? unitKinds : null,
            healed: false,
          };
        }
      }
    } catch {
      // Fall through to the authored dependency artifact.
    }
  }

  const dependencyPath = unitDependencyPath(projectDir, intent, space);
  if (!existsSync(dependencyPath)) return cached ?? { state: "none" };

  let body: string;
  try {
    body = readFileSync(dependencyPath, "utf-8");
  } catch (e) {
    return { state: "malformed", reason: "unreadable", detail: errorMessage(e) };
  }
  const parsed = parseBoltDag(body);
  if (!parsed.ok) {
    return { state: "malformed", reason: parsed.reason, detail: parsed.detail };
  }
  const unitKinds = new Map(
    parsed.units
      .filter((unit) => unit.kind !== undefined)
      .map((unit) => [unit.name, unit.kind!]),
  );
  const authored: ResolvedBoltDag = {
    state: "ok",
    batches: parsed.batches,
    units: parsed.batches.flat(),
    unitKinds: unitKinds.size > 0 ? unitKinds : null,
    healed: true,
  };
  return cached !== null && boltDagMatches(cached, authored) ? cached : authored;
}

// Prune a produces name list to the artifacts that apply to `unitKind`. Returns
// `names` unchanged when the stage has no produces_kinds map or `unitKind` is
// null (an untagged unit stays on the full matrix). For a kind-tagged unit, an
// artifact NOT in the map applies to all kinds (authors annotate only the
// kind-specific entries); a mapped artifact is kept only when its kind list
// includes `unitKind`. Takes the raw map (not a node) so both the orchestrator
// GraphStage and the state-tool StageEntry callers share one implementation.
export function filterProducesByKind(
  producesKinds: Record<string, string[]> | undefined,
  names: string[],
  unitKind: string | null
): string[] {
  if (unitKind === null || producesKinds === undefined) return names;
  return names.filter((name) => {
    const kinds = producesKinds[name];
    return kinds === undefined || kinds.includes(unitKind);
  });
}

// -----------------------------------------------------------------------------
// State-schema-version classification (shared by runtime + doctor)
// -----------------------------------------------------------------------------
// The persisted `aidlc-state.md` carries a `- **State Version**: N` line naming
// the state-graph schema the workflow was created under. v8 renamed the Inception
// `application-design` stage to `domain-design` and inserted `contract-design`,
// so a pre-v8 state file's stage rows no longer match the compiled graph. An
// incompatible state must be refused up front by BOTH runtime commands
// (aidlc-orchestrate.ts `next`/`report`) and by `aidlc --doctor`, and both
// callers must classify the state identically — otherwise the doctor and the
// runtime disagree on whether a state is "malformed" vs "future" vs "past".
// classifyStateVersion() is the single source of truth for that classification,
// so a new schema bump only touches CURRENT_STATE_VERSION in this file.

/** The current state-graph schema version. Bump when the graph adds/renames/removes rows. */
export const CURRENT_STATE_VERSION = "8";

export type StateVersionClassification =
  | { kind: "ok" }
  | { kind: "unparseable"; message: string }
  | { kind: "past"; version: string; message: string }
  | { kind: "future"; version: string; message: string };

/**
 * Classify a state-file's `State Version` field.
 *
 * `unparseable` covers: missing field, empty value, non-numeric token, or
 * trailing content after the numeric token (e.g. `State Version: 8 garbage`).
 * `past`/`future` cover explicit numeric versions on either side of the current
 * one. `ok` is the current version with no trailing content.
 *
 * The parser uses horizontal whitespace only (`[ \t]*`) to avoid a `\s*` regex
 * that would span the newline after an empty value and capture the leading `-`
 * of the next state bullet as a bogus version. The tail is anchored to the end
 * of the line, so trailing content on the value line is rejected — a schema
 * token must be a bare integer on its own line.
 */
export function classifyStateVersion(stateContent: string): StateVersionClassification {
  const unparseableMessage =
    "Incompatible workflow state: the State Version field is missing, empty, " +
    "or unparseable in aidlc-state.md, so this state cannot be matched to the " +
    `current v${CURRENT_STATE_VERSION} stage graph and cannot be advanced safely. ` +
    "Archive your workspace ('mv aidlc aidlc.archive') and start a fresh " +
    "workflow (describe what to build), or finish this workflow on the prior " +
    "shell. Run `/aidlc --doctor` for the full diagnosis.";
  // Anchor the tail with `[ \t]*$`: the schema token is a bare integer with
  // no trailing content on the line, so `State Version: 8 garbage` fails to
  // match and falls into the unparseable branch.
  const versionMatch = stateContent.match(/^- \*\*State Version\*\*:[ \t]*(\S+)[ \t]*$/m);
  if (versionMatch === null) return { kind: "unparseable", message: unparseableMessage };
  const v = versionMatch[1];
  if (!/^\d+$/.test(v)) return { kind: "unparseable", message: unparseableMessage };
  if (v === CURRENT_STATE_VERSION) return { kind: "ok" };
  if (Number(v) > Number(CURRENT_STATE_VERSION)) {
    return {
      kind: "future",
      version: v,
      message:
        `Incompatible workflow state: State Version ${v} is newer than the ` +
        `current v${CURRENT_STATE_VERSION} stage graph this build understands, so ` +
        "it cannot be advanced safely. Upgrade the framework to a build that ships " +
        `state schema v${v} (or newer), or finish this workflow on the shell that ` +
        "produced it. Run `/aidlc --doctor` for the full diagnosis.",
    };
  }
  return {
    kind: "past",
    version: v,
    message:
      `Incompatible workflow state: State Version ${v} predates the current ` +
      `v${CURRENT_STATE_VERSION} stage graph. v8 renamed the Inception ` +
      "`application-design` stage to `domain-design` and inserted " +
      "`contract-design`, so this state's stage rows no longer match the graph " +
      "and cannot be advanced safely. Archive your workspace " +
      `('mv aidlc aidlc.v${v}-archive') and start a fresh workflow (describe what ` +
      "to build), or finish this workflow on the prior shell. Run `/aidlc --doctor` " +
      "for the full diagnosis.",
  };
}
