import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The environment the engine runs in, settled before anything else in this
// module or any module that imports it (the dispatcher, aidlc-lib and every
// adapter import this module first, so every entry evaluates this block before
// its own body). Bun loads the `.env` files of the folder a process runs in into
// process.env, and AI-DLC's hooks and tools run in the person's project. A
// repository the person clones could therefore set any name the engine reads: a
// check of theirs switched off, records pointed at another folder, a tool run
// from a directory of the repository's choosing. The installed engine is built
// with that autoload off, so nothing in its environment came from a file and
// nothing is dropped there. A Bun-run tree cannot carry a build flag, so here
// every AI-DLC or host-tool name a `.env` file in the working directory assigns
// is removed again before any read; a child Bun process loads the files again
// and runs this again on its first import.
//
// Bun never overrides a name the shell already set, and once a file names a
// variable there is no telling the two apart. So the drop is narrow: the
// engine's own namespace and the host tools' names that steer where it reads,
// writes or runs. The person's application names (an AWS profile, a database
// URL, whatever their tests need) stay as the shell had them, so a command the
// engine runs for them sees the same environment their terminal does. Two
// declarations only a host makes are kept even when the file names them: the
// unattended driver's flag (dropping it would let a driver's turns pass for a
// person's) and the dispatcher's internal tokens to its own children.
//
// ponytail: an AI-DLC name set in both the shell and the repository's .env is
// dropped too (a lost setting, never a loosened guard); the environment is the
// documented place for those names, a project .env is not.
export const BUN_DOTENV_FILES = [
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  ".env.production",
  ".env.production.local",
  ".env.test",
  ".env.test.local",
];

const DOTENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm;
// Names the engine reads as its own, or that the host tools use to tell it
// where the project, the person's settings, a plugin or a git configuration is.
const DOTENV_GUARDED = /^(?:AIDLC_|AWS_AIDLC_|CLAUDE_|KIRO_|CODEX_|CURSOR_|COPILOT_|XDG_|GIT_CONFIG)/i;
// Declarations only the host makes: kept even when a file names them.
const DOTENV_HOST_ONLY = /^AIDLC_(?:UNATTENDED$|INTERNAL_)/i;

/** Whether Bun loaded the folder's dotenv files into this process at all. */
export function dotenvLoaded(): boolean {
  return !isCompiledExecutable() && !process.execArgv.includes("--no-env-file");
}

/** Every name the folder's Bun dotenv files assign, in file order, duplicates included. */
export function dotenvAssignedNames(dir = process.cwd()): string[] {
  const names: string[] = [];
  for (const file of BUN_DOTENV_FILES) {
    let text: string;
    try {
      text = readFileSync(join(dir, file), "utf-8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(DOTENV_ASSIGNMENT)) names.push(match[1]);
  }
  return names;
}

/** Whether a dotenv file in the folder assigns the name, in any casing (Windows reads names case-insensitively). */
export function setByDotenvFile(name: string, dir = process.cwd()): boolean {
  const wanted = name.toUpperCase();
  return dotenvAssignedNames(dir).some((assigned) => assigned.toUpperCase() === wanted);
}

/**
 * Remove from `env` every AI-DLC or host-tool name the folder's dotenv files
 * assign, host-only declarations excepted; returns what was dropped. Nothing is
 * dropped when Bun loaded no file (`loaded` false): then everything present
 * came from the host.
 */
export function dropDotenvNames(env: NodeJS.ProcessEnv = process.env, dir = process.cwd(), loaded = dotenvLoaded()): string[] {
  if (!loaded) return [];
  const dropped: string[] = [];
  for (const name of dotenvAssignedNames(dir)) {
    if (!DOTENV_GUARDED.test(name) || DOTENV_HOST_ONLY.test(name) || !(name in env)) continue;
    delete env[name];
    dropped.push(name);
  }
  return dropped;
}

dropDotenvNames();

const MODULE_TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_HARNESS_ROOT = join(MODULE_TOOLS_DIR, "..");
const PROJECTED_INVOKE = "{{INVOKE}}";
// Release version grammar: stable x.y.z, or a preview id
// x.y.z-preview.YYYYMMDD.N. Literal of PREVIEW_CHANNEL / VERSION_ID in
// aidlc-channel.ts, repeated here because hooks ship this module with a closed
// set of sibling tools and must not grow that closure; t330 keeps them in step.
const FRAMEWORK_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-preview\.\d{8}\.[1-9]\d*)?$/;

export interface HarnessLocation {
  harnessDir?: string;
  distribution?: string;
  mutable?: boolean;
  projectDir?: string;
}

export interface ProjectHarness {
  root: string;
  harnessDir: string;
  distribution: string;
  frameworkVersion?: string;
}

const HARNESS_PRECEDENCE = [".claude", ".kiro", ".codex", ".cursor", ".aidlc"] as const;

function markerRecord(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `${path}: invalid harness metadata (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: harness metadata must be an object`);
  }
  return value as Record<string, unknown>;
}

function legacyDistribution(harnessDir: string): string | null {
  if (!/^\.[a-z0-9][a-z0-9._-]*$/i.test(harnessDir)) return null;
  return harnessDir.slice(1);
}

function harnessIdentity(root: string, strict = false): ProjectHarness | null {
  const harnessDir = basename(root);
  const dataDir = join(root, "tools", "data");
  const harnessPath = join(dataDir, "harness.json");
  const stampPath = join(dataDir, "aidlc-stamp.json");
  if (!existsSync(harnessPath) && !existsSync(stampPath)) return null;

  try {
    // The immutable projection stamp is authoritative. harness.json is mutable
    // plugin-selection state, so malformed contents must not hide an otherwise
    // identifiable stamped install.
    const markerPath = existsSync(stampPath) ? stampPath : harnessPath;
    const marker = markerRecord(markerPath);
    if (marker.harnessDir !== harnessDir) {
      throw new Error(`${markerPath}: harness metadata identity is invalid`);
    }

    // Releases before projection stamps shipped only harnessDir + rulesSubdir.
    // Keep those trees identifiable so init can adopt and rewrite them.
    const legacy = !existsSync(stampPath) && marker.schemaVersion === undefined;
    const distribution = legacy
      ? legacyDistribution(harnessDir)
      : marker.distribution;
    if (
      (!legacy && marker.schemaVersion !== 1) ||
      typeof distribution !== "string" ||
      !/^[a-z0-9][a-z0-9-]*$/.test(distribution)
    ) {
      throw new Error(`${markerPath}: harness metadata identity is invalid`);
    }
    const frameworkVersion = marker.frameworkVersion;
    if (
      existsSync(stampPath) &&
      (typeof frameworkVersion !== "string" || !FRAMEWORK_VERSION.test(frameworkVersion))
    ) {
      throw new Error(`${stampPath}: frameworkVersion must be a release version id`);
    }
    return {
      root,
      harnessDir,
      distribution,
      ...(typeof frameworkVersion === "string" ? { frameworkVersion } : {}),
    };
  } catch (error) {
    if (strict) throw error;
    return null;
  }
}

export function discoverProjectHarnesses(projectDir: string): ProjectHarness[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(projectDir, { withFileTypes: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
  const priority = (name: string): number => {
    const index = HARNESS_PRECEDENCE.indexOf(name as typeof HARNESS_PRECEDENCE[number]);
    return index < 0 ? HARNESS_PRECEDENCE.length : index;
  };
  const harnesses: ProjectHarness[] = [];
  for (
    const entry of entries.sort((left, right) =>
      priority(left.name) - priority(right.name) || left.name.localeCompare(right.name)
    )
  ) {
    if (!entry.isDirectory()) continue;
    const identity = harnessIdentity(join(projectDir, entry.name));
    if (identity) harnesses.push(identity);
  }
  return harnesses;
}

export function isCompiledModuleUrl(url: string): boolean {
  return /\/(?:\$bunfs|%7ebun|~bun)\//i.test(url.replace(/\\/g, "/"));
}

export function isCompiledExecutable(
  moduleUrl = import.meta.url,
  executable = process.execPath,
): boolean {
  const executableName = basename(executable.replace(/\\/g, "/")).toLowerCase();
  return isCompiledModuleUrl(moduleUrl) || !executableName.startsWith("bun");
}

export function compiledExecutable(
  moduleUrl = import.meta.url,
  executable = process.execPath,
): string | null {
  const explicit = process.env.AIDLC_COMPILED_EXECUTABLE?.trim();
  if (explicit) return explicit;
  return isCompiledExecutable(moduleUrl, executable) ? executable : null;
}

// A package the project installed itself, as Node resolves it from cwd:
// node_modules, a link out of it, or NODE_PATH. Bun's resolver can also answer
// from its own install cache, a copy that cannot run and that the project never
// chose, so that answer is none. The code sensors run the project's own tool
// through this.
export function projectPackage(cwd: string, name: string): { root: string; major: number } | null {
  try {
    const manifestPath = createRequire(join(cwd, "package.json")).resolve(`${name}/package.json`);
    if (inBunInstallCache(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (manifest.name !== name || typeof manifest.version !== "string") return null;
    return { root: dirname(manifestPath), major: Number(manifest.version.split(".")[0]) };
  } catch {
    return null;
  }
}

function bunInstallCache(): string {
  const explicit = process.env.BUN_INSTALL_CACHE_DIR?.trim();
  if (explicit) return explicit;
  return join(process.env.BUN_INSTALL?.trim() || join(homedir(), ".bun"), "install", "cache");
}

function inBunInstallCache(path: string): boolean {
  let cache: string;
  try {
    cache = realpathSync(bunInstallCache());
  } catch {
    return false;
  }
  const rel = relative(cache, realpathSync(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

// Child calls and human-facing command rendering describe the same dispatcher
// operations. Child calls use argv and an absolute source path so neither cwd
// changes nor a native executable's process.execPath can turn a script into a
// dispatcher command.
export function aidlcEngineCommand(
  route: "orchestrate" | "log" | "state" | "bolt" | "runtime" | "sensor",
  args: readonly string[],
  sourceToolPath?: string,
  executable: string | null = compiledExecutable(),
): string[] {
  return executable
    ? [executable, "engine", route, ...args]
    : [process.execPath, sourceToolPath ?? resolveHarnessPath(["tools", `aidlc-${route}.ts`]), ...args];
}

// Control characters (line breaks, terminal escapes) in something we print.
export function hasControlCharacters(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
  return /[\u0000-\u001f\u007f]/.test(value);
}

// A repo is named by its folder directly in the workspace, as the person named
// it, so a name resolves only to an immediate child of the workspace and never
// escapes it. A name is left out only where it breaks something named here, in
// words that finish "its name ...": why a typed name is refused and a folder
// found on disk is left out of the work. Null when the name can be a repo's.
export function repoNameProblem(name: string): string | null {
  if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
    return 'is not one folder\'s name (no "/" or "\\", not "." or "..")';
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point
  if (/[\u0001-\u001f\u007f\u2028\u2029]/.test(name)) return "has a control character, which AI-DLC's records cannot keep";
  if (name.trim() !== name) return "starts or ends with a space, which AI-DLC's records cannot keep";
  // A teammate's clone on Windows could not check out the records named after it.
  const windows = /[<>:"|?*]/.exec(name);
  if (windows) return `has "${windows[0]}", which a folder name on Windows cannot have`;
  // A native Windows install runs every AI-DLC command through aidlc.cmd, whose
  // cmd.exe reads these again, however the command quotes them.
  const cmd = /[&^%]/.exec(name);
  if (cmd) return `has "${cmd[0]}", which breaks AI-DLC's commands on Windows`;
  if (name.includes(",")) return 'has ",", which AI-DLC puts between repo names';
  if (name === "-") return 'is "-", which AI-DLC\'s records use for no repo';
  if (name.startsWith("--")) return 'starts with "--", which AI-DLC\'s commands read as an option';
  if (name.endsWith("@checkout")) return 'ends with "@checkout", which names a checkout AI-DLC records';
  // On Windows the agent's shell is PowerShell or Git Bash, and only double
  // quotes read an apostrophe alike in both (quoteCommandArgument); these end
  // or act inside them.
  const apostrophe = /['\u2018-\u201b]/.exec(name);
  const alongside = /[!$`\u201c-\u201e]/.exec(name);
  if (apostrophe && alongside) {
    return `has "${apostrophe[0]}" with "${alongside[0]}", which AI-DLC cannot quote one way for both PowerShell and Git Bash on Windows`;
  }
  return null;
}

// The refusal of a typed name that cannot be a repo's, after its flag or field.
export function repoNameRefusal(what: string, name: string): string {
  return `${what} "${name}": its name ${repoNameProblem(name) ?? "cannot be a repo's"}.`;
}

// Text bash, zsh, PowerShell and cmd.exe all read as written inside double
// quotes: nothing in it expands or ends the quotes (PowerShell ends them at a
// typographic double quote too), and nothing acts in cmd.exe when PowerShell
// hands the word on without them.
export function readsAlikeInDoubleQuotes(value: string): boolean {
  return /^[^"\u201c-\u201e$`\\%!^&|<>\r\n]+$/.test(value);
}

// The characters PowerShell reads as a single quote: the apostrophe and the
// typographic ones a pasted name can hold.
const POWERSHELL_SINGLE_QUOTE = /['\u2018-\u201b]/;

// One argument of a command we print for someone to run: bare when it cannot
// expand, else single-quoted so no shell substitutes into it. It stays one
// line of plain text: a control character is shown as "?", never emitted.
// "windows" is the agent's shell on Windows, which may be PowerShell or Git Bash
// (Claude Code's).
export function quoteCommandArgument(
  value: string,
  shell: "posix" | "powershell" | "windows" = process.platform === "win32" ? "windows" : "posix",
): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing them is the point
  value = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  // PowerShell reads a bare word that starts with "@" as splatting a variable.
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value) && !(shell !== "posix" && value.startsWith("@"))) return value;
  // The two shells quote an apostrophe differently, so it is double-quoted
  // when both read that alike.
  if (shell === "windows" && POWERSHELL_SINGLE_QUOTE.test(value) && readsAlikeInDoubleQuotes(value)) return `"${value}"`;
  return shell !== "posix"
    ? `'${value.replaceAll(new RegExp(POWERSHELL_SINGLE_QUOTE.source, "g"), "$&$&")}'`
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function aidlcInvocation(): string {
  if (isCompiledExecutable()) return "aidlc";
  if (!PROJECTED_INVOKE.startsWith("{{")) return PROJECTED_INVOKE;
  return `bun ${runtimeHarnessDir()}/tools/aidlc.ts`;
}

// The Bun dispatcher of the projected tree this module runs from: the tool a
// copy-channel command ran. Null in the source tree, where the project's own
// tree stands in for a projection.
export function projectedDispatcher(): string | null {
  return PROJECTED_INVOKE.startsWith("{{") ? null : join(MODULE_TOOLS_DIR, "aidlc.ts");
}

export function entrySkillInvocation(): string {
  return runtimeHarnessDir() === ".codex" ? "$aidlc" : "/aidlc";
}

export function aidlcDispatcherInvocation(route: string): string {
  return `${aidlcInvocation()} engine ${route}`;
}

// The command a parallel batch's worker or reviewer runs for the tests the
// person approved: AI-DLC's own `swarm check` with the command's output shown,
// run from the project's main folder for the Unit's worktree. It names no
// folder, so no shell has a path to quote (cmd.exe hands a quoted one on with
// its quotes).
export function swarmUnitTestCommand(unit: string): string {
  return aidlcDispatcherInvocation(`swarm check ${quoteCommandArgument(unit)} --show-output`);
}

// The command that runs one check by hand, in the sensor tool's usage and each
// check script's: the dispatcher hands the script the stage's templates and
// inputs and records the result, which the script run bare does not.
export function sensorFireUsage(id = "<id>"): string {
  return aidlcDispatcherInvocation(`sensor fire ${id} --stage <slug> --output-path <path>`);
}

export function aidlcToolInvocation(
  route: string,
  sourceTool?: string,
  qualifiedSource = true,
): string {
  const invoke = aidlcInvocation();
  if (!invoke.startsWith("bun ")) return aidlcDispatcherInvocation(route);
  const tool = sourceTool ??
    route.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const path = qualifiedSource
    ? `${runtimeHarnessDir()}/tools/aidlc-${tool}.ts`
    : `aidlc-${tool}.ts`;
  return `bun ${path}`;
}

function explicitRuntimeProjectDir(): string | null {
  const internal = process.env.AIDLC_RUNTIME_PROJECT_DIR;
  if (internal) {
    return isAbsolute(internal) ? internal : resolve(process.cwd(), internal);
  }
  const argv = process.argv.slice(1);
  const index = argv.indexOf("--project-dir");
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return isAbsolute(argv[index + 1])
      ? argv[index + 1]
      : resolve(process.cwd(), argv[index + 1]);
  }
  const own = process.env.AIDLC_PROJECT_DIR;
  if (own) return isAbsolute(own) ? own : resolve(process.cwd(), own);
  const host = process.env.CLAUDE_PROJECT_DIR ?? process.env.KIRO_PROJECT_DIR;
  if (!host) return null;
  const hostDir = isAbsolute(host) ? host : resolve(process.cwd(), host);
  return hostWorktreeProjectDir(hostDir) ?? hostDir;
}

// A host that opens a session in a git worktree of the project may still name
// the main checkout as the project (Claude Code's desktop app sets
// CLAUDE_PROJECT_DIR that way). The hooks then run with the worktree as their
// working directory but act on the main checkout: its record, its audit, its
// claim stamp. When the working directory is inside a different checkout that
// holds the AI-DLC workspace shell itself, that checkout is the project.
export function hostWorktreeProjectDir(hostDir: string, from = process.cwd()): string | null {
  if (!existsSync(from)) return null;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: from,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (top.status !== 0) return null;
  const cwdTop = (top.stdout ?? "").trim();
  if (!cwdTop || samePath(cwdTop, hostDir)) return null;
  if (!existsSync(join(cwdTop, "aidlc"))) return null;
  if (discoverProjectHarnesses(cwdTop).length === 0) return null;
  // A worktree of the project the host named, not some other checkout that
  // happens to hold a workspace: both share one git common directory.
  const commonDir = (dir: string): string | null => {
    const result = spawnSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: dir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const out = (result.stdout ?? "").trim();
    if (result.status !== 0 || !out) return null;
    try {
      return realpathSync(resolve(dir, out));
    } catch {
      return null;
    }
  };
  const hostCommon = commonDir(hostDir);
  return hostCommon !== null && hostCommon === commonDir(cwdTop) ? cwdTop : null;
}

// The directories a host's hook payload says its session works in: the
// payload's own `cwd`, then the `cwd` the session's transcript records. Claude
// Code's desktop app runs a worktree session's hooks from the main checkout it
// names as the project, so the payload is where the worktree shows.
export function hookSessionDirectories(payload: string): string[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const dirs: string[] = [];
  if (typeof parsed.cwd === "string" && parsed.cwd) dirs.push(parsed.cwd);
  const transcript = parsed.transcript_path;
  if (typeof transcript === "string" && transcript && existsSync(transcript)) {
    try {
      // The first rows are enough: every row carries the session's cwd.
      const head = readFileSync(transcript, { encoding: "utf-8", flag: "r" }).slice(0, 262_144);
      for (const line of head.split("\n").slice(0, 200)) {
        if (!line.includes('"cwd"')) continue;
        try {
          const row = JSON.parse(line) as { cwd?: unknown };
          if (typeof row.cwd === "string" && row.cwd) {
            dirs.push(row.cwd);
            break;
          }
        } catch {
          // A partial last line; keep looking.
        }
      }
    } catch {
      // Unreadable transcript: the payload's cwd is all there is.
    }
  }
  return [...new Set(dirs)];
}

// The project a hook acts on, given the directory the host resolved and the
// hook's payload: the session's own checkout when the payload names a
// different git checkout that holds the AI-DLC workspace shell, else the
// host's directory.
export function hookSessionProjectDir(hostDir: string, payload: string): string {
  for (const dir of hookSessionDirectories(payload)) {
    const found = hostWorktreeProjectDir(hostDir, dir);
    if (found) return found;
  }
  return hostDir;
}

function samePath(left: string, right: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  return real(left) === real(right);
}

export function runtimeProjectDir(): string {
  return explicitRuntimeProjectDir() ?? process.cwd();
}

export function runtimeHarnessDir(projectDir = runtimeProjectDir()): string {
  const explicit = process.env.AIDLC_HARNESS_DIR?.trim();
  if (explicit) return explicit;

  if (basename(MODULE_TOOLS_DIR) === "tools") {
    const candidate = basename(MODULE_HARNESS_ROOT);
    if (/^\.[a-z0-9][a-z0-9._-]*$/i.test(candidate)) return candidate;
  }

  return discoverProjectHarnesses(projectDir)[0]?.harnessDir ?? ".claude";
}

function readHarnessName(root: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(root, "tools", "data", "harness.json"), "utf-8"),
    ) as { name?: unknown };
    return typeof parsed.name === "string" && parsed.name.trim()
      ? parsed.name.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * The two Kiro tree layouts. `agent-v1` is the Kiro CLI agent-JSON layout (JSON
 * agents carrying their hooks); `kas` is the one Kiro IDE 1.x and Kiro CLI v3 run
 * (Markdown agents, standalone `.kiro/hooks/*.json`). A row name says which
 * distribution shipped a tree, not its layout, so code that depends on the
 * layout asks for it here.
 */
export type KiroLayout = "agent-v1" | "kas";

/** The layout a harness.json record declares, or the one its row name implied before the field existed. */
export function kiroLayoutOf(record: unknown): KiroLayout | null {
  if (!record || typeof record !== "object") return null;
  const { kiroLayout, name, distribution } = record as Record<string, unknown>;
  if (kiroLayout === "agent-v1" || kiroLayout === "kas") return kiroLayout;
  const row = typeof name === "string" ? name : distribution;
  if (row === "kiro-ide") return "kas";
  if (row === "kiro") return "agent-v1";
  return null;
}

/**
 * The layout of the `.kiro` tree at `harnessRoot`: its harness.json first, then
 * the conductor file it ships. With both conductors present the Markdown one
 * wins, since the agent-v1 JSON is what a move to the KAS layout leaves behind.
 * Null when the tree is neither.
 */
export function kiroTreeLayout(harnessRoot: string): KiroLayout | null {
  try {
    const layout = kiroLayoutOf(
      JSON.parse(readFileSync(join(harnessRoot, "tools", "data", "harness.json"), "utf-8")),
    );
    if (layout) return layout;
  } catch {
    // A tree without readable metadata still has its conductor file.
  }
  if (existsSync(join(harnessRoot, "agents", "aidlc-aidlc.md")) || existsSync(join(harnessRoot, "agents", "aidlc.md"))) return "kas";
  if (existsSync(join(harnessRoot, "agents", "aidlc.json"))) return "agent-v1";
  return null;
}

/**
 * The harness dir for this process, or null when the working directory cannot
 * be read (a command started from a directory the user cannot list or enter).
 * Null means "not discoverable here", never a default harness: a command that
 * needs one still resolves it later and reports the error then. Other
 * discovery errors are rethrown.
 *
 * Codex sets CODEX_SESSION_ID in every shell command its model runs, so in a
 * project that also holds another tool's install, a command Codex runs reads
 * the Codex install instead of the first one found.
 */
export function discoverableRuntimeHarnessDir(projectDir = runtimeProjectDir()): string | null {
  try {
    if (!process.env.AIDLC_HARNESS_DIR?.trim() && process.env.CODEX_SESSION_ID?.trim()) {
      const codex = discoverProjectHarnesses(projectDir).find((item) => item.distribution === "codex");
      if (codex) return codex.harnessDir;
    }
    return runtimeHarnessDir(projectDir);
  } catch (error) {
    if (["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

export function runtimeHarnessName(
  projectDir = runtimeProjectDir(),
  harnessDir = runtimeHarnessDir(projectDir),
): string {
  const explicit = process.env.AIDLC_HARNESS_NAME?.trim();
  if (explicit) return explicit;

  const projectRoot =
    basename(projectDir) === harnessDir && existsSync(join(projectDir, "tools"))
      ? projectDir
      : join(projectDir, harnessDir);
  for (const root of [projectRoot, MODULE_HARNESS_ROOT]) {
    const name = readHarnessName(root);
    if (name) return name;
  }

  // Copilot and OpenCode intentionally share .aidlc. Their harness.json name
  // above is the authoritative discriminator; retain OpenCode only as the
  // metadata-unavailable compatibility fallback.
  if (harnessDir === ".aidlc") return "opencode";
  if (harnessDir === ".codex") return "codex";
  if (harnessDir === ".kiro") return "kiro";
  if (harnessDir === ".cursor") return "cursor";
  return "claude";
}

/**
 * Pin the harness a command names (`--harness-dir`) for this process and the
 * tools it loads: a compiled aidlc has already pinned the first one installed
 * here, which in a project with Claude Code beside it is .claude.
 */
export function pinNamedHarness(projectDir: string, harnessDir: string): void {
  process.env.AIDLC_HARNESS_DIR = harnessDir;
  delete process.env.AIDLC_HARNESS_NAME;
  process.env.AIDLC_HARNESS_NAME = runtimeHarnessName(projectDir, harnessDir);
}

function distributionFor(harnessDir: string, projectDir = runtimeProjectDir()): string {
  return runtimeHarnessName(projectDir, harnessDir);
}

function explicitHarnessRoot(harnessDir: string, distribution: string): string | null {
  const direct = process.env.AIDLC_RUNTIME_HARNESS_ROOT?.trim();
  if (direct) return isAbsolute(direct) ? direct : resolve(process.cwd(), direct);

  const runtimeRoot = process.env.AIDLC_RUNTIME_ROOT?.trim();
  if (!runtimeRoot) return null;
  const root = isAbsolute(runtimeRoot) ? runtimeRoot : resolve(process.cwd(), runtimeRoot);
  const distributionRoot = join(root, distribution);
  return existsSync(join(distributionRoot, harnessDir))
    ? join(distributionRoot, harnessDir)
    : join(root, harnessDir);
}

function moduleHarnessRoot(harnessDir: string): string | null {
  return existsSync(join(MODULE_HARNESS_ROOT, "tools")) &&
    (
      basename(MODULE_HARNESS_ROOT) === harnessDir ||
      !isCompiledExecutable() ||
      basename(process.execPath).startsWith("bun")
    )
    ? MODULE_HARNESS_ROOT
    : null;
}

function isAidlcHarnessRoot(root: string): boolean {
  return existsSync(join(root, "tools", "data", "harness.json"));
}

export function packagedDistributionRoot(
  harnessDir = runtimeHarnessDir(),
  distribution = distributionFor(harnessDir),
): string {
  return join(dirname(process.execPath), "runtime", distribution);
}

/**
 * The running release's own copy of a project harness's tools/data/harness.json,
 * or null. A native engine reads the project's file, which an older release may
 * have written and which stays so until the next `aidlc config`; the runtime it
 * ships beside itself holds the same harness as this release writes it. The harness is the one the project's file names. A Bun engine reads its
 * own tree already and ships no such copy. Any failure reads as no copy.
 */
export function releasedHarnessData(projectHarnessData: string): Record<string, unknown> | null {
  if (!isCompiledExecutable()) return null;
  try {
    const declared = JSON.parse(readFileSync(projectHarnessData, "utf-8")) as Record<string, unknown>;
    const { name, harnessDir } = declared;
    if (
      typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(name) ||
      typeof harnessDir !== "string" || !/^\.[a-z0-9][a-z0-9._-]*$/i.test(harnessDir)
    ) {
      return null;
    }
    const released = join(packagedDistributionRoot(harnessDir, name), harnessDir, "tools", "data", "harness.json");
    if (resolve(released) === resolve(projectHarnessData)) return null;
    const copy = JSON.parse(readFileSync(released, "utf-8")) as unknown;
    if (copy === null || typeof copy !== "object" || Array.isArray(copy)) return null;
    const data = copy as Record<string, unknown>;
    return data.name === name && data.harnessDir === harnessDir ? data : null;
  } catch {
    return null;
  }
}

/** The largest directive a host shows whole as one shell result, and that host. */
export interface DirectiveLimit {
  bytes: number;
  host: string;
}

// The host's name as the person knows it, by harness id. A harness.json is
// project-editable, so its own productName never reaches the model: the id
// only selects one of these fixed names.
const HOST_LABELS: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  kiro: "Kiro CLI",
  "kiro-ide": "Kiro",
  opencode: "opencode",
};

// A limit is a positive whole number; anything else declares none.
function declaredLimit(data: Record<string, unknown>): DirectiveLimit | null {
  const bytes = data.directiveMaxBytes;
  if (!Number.isSafeInteger(bytes) || (bytes as number) <= 0) return null;
  const host = typeof data.name === "string" && Object.hasOwn(HOST_LABELS, data.name)
    ? HOST_LABELS[data.name]
    : "this assistant";
  return { bytes: bytes as number, host };
}

function harnessDataLimit(harnessData: string): DirectiveLimit | null {
  let own: DirectiveLimit | null = null;
  try {
    own = declaredLimit(JSON.parse(readFileSync(harnessData, "utf-8")) as Record<string, unknown>);
  } catch {
    // An unreadable file declares nothing of its own.
  }
  // The running release's copy is the host's ceiling as this release knows it.
  // A project value can only tighten it, so a release that lowers a host's
  // budget reaches projects configured earlier, and no project value raises it.
  const released = releasedHarnessData(harnessData);
  const shipped = released ? declaredLimit(released) : null;
  if (own === null) return shipped;
  return shipped !== null && shipped.bytes < own.bytes ? shipped : own;
}

/**
 * The smallest directive limit declared by the engine's own harness data or by
 * any harness installed in the project, or null when none declares one. With
 * several harnesses in one project, the engine cannot tell which host prints its
 * result (Claude's `.claude` is found before Copilot's `.aidlc`), so the
 * smallest wins. Each harness's value is the smaller of its project file's and
 * its release copy's, or whichever of the two declares one.
 */
export function directiveLimitFor(harnessData: string[], projectDir?: string): DirectiveLimit | null {
  const files = [...harnessData];
  if (projectDir !== undefined) {
    try {
      for (const harness of discoverProjectHarnesses(projectDir)) {
        files.push(join(harness.root, "tools", "data", "harness.json"));
      }
    } catch {
      // An unreadable project keeps the engine's own value.
    }
  }
  let smallest: DirectiveLimit | null = null;
  for (const file of new Set(files.map((path) => resolve(path)))) {
    const limit = harnessDataLimit(file);
    if (limit && (smallest === null || limit.bytes < smallest.bytes)) smallest = limit;
  }
  return smallest;
}

// AI-DLC writes its own files only into real folders: a write through a link
// lands wherever the link points, which can be outside this project. The
// first folder (or file) on the way from the project to `target`, `target`
// included, that is a link, relative to the project, or null. A target that is
// not inside the project is not this check's to judge.
export function linkOnTheWay(projectDir: string, target: string): string | null {
  const rel = relative(projectDir, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  let path = projectDir;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    path = join(path, part);
    try {
      if (lstatSync(path).isSymbolicLink()) return relative(projectDir, path);
    } catch {
      return null;
    }
  }
  return null;
}

// The folder names AI-DLC itself gives its tree. The line shows a path only
// as far as it is made of these, so no name a repository chose reaches the
// reader: a link deeper down is named by the AI-DLC folder that holds it.
const AIDLC_FOLDER_NAMES = new Set([
  ".aidlc", ".agents", ".claude", ".codex", ".cursor", ".github", ".kiro", ".opencode",
  "agents", "aidlc", "aidlc-common", "command", "data", "hooks", "knowledge", "plugin",
  "rules", "scopes", "sensors", "settings", "skills", "spaces", "stages", "steering", "tools",
]);

export class LinkedFolderError extends Error {
  constructor(readonly folder: string) {
    const parts = folder.split(/[\\/]/);
    const known = parts.findIndex((part) => !AIDLC_FOLDER_NAMES.has(part));
    super(
      known === -1
        ? `${folder} is a link, so AI-DLC changed nothing there. ` +
          "Replace the link with a real folder or file, then run this again."
        : `${known === 0 ? "This project" : parts.slice(0, known).join(sep)} holds a link, so AI-DLC changed nothing there. ` +
          "Replace the link with a real folder or file, then run this again.",
    );
  }
}

export function refuseLinkOnTheWay(projectDir: string, target: string): void {
  const link = linkOnTheWay(projectDir, target);
  if (link !== null) throw new LinkedFolderError(link);
}

export function resolveHarnessRoot(location: HarnessLocation = {}): string {
  const projectDir = location.projectDir ?? runtimeProjectDir();
  const harnessDir = location.harnessDir ?? runtimeHarnessDir(projectDir);
  const distribution = location.distribution ?? distributionFor(harnessDir, projectDir);
  const projectRoot =
    basename(projectDir) === harnessDir &&
    existsSync(join(projectDir, "tools"))
      ? projectDir
      : join(projectDir, harnessDir);

  // Mutation goes to the project root when a project dir was named (location,
  // AIDLC_RUNTIME_PROJECT_DIR or --project-dir), else to this module's own
  // harness root when it has one, else the project root. Explicit and packaged
  // roots are read fallbacks only and must never become a write target.
  if (location.mutable) {
    const root = location.projectDir !== undefined || explicitRuntimeProjectDir()
      ? projectRoot
      : moduleHarnessRoot(harnessDir) ?? projectRoot;
    refuseLinkOnTheWay(projectDir, root);
    return root;
  }

  const explicit = explicitHarnessRoot(harnessDir, distribution);
  if (explicit) return explicit;

  const moduleRoot = moduleHarnessRoot(harnessDir);
  const packagedRoot = join(packagedDistributionRoot(harnessDir, distribution), harnessDir);

  if (moduleRoot) return moduleRoot;
  if (isAidlcHarnessRoot(projectRoot)) return projectRoot;
  if (existsSync(packagedRoot)) return packagedRoot;
  return packagedRoot;
}

export function resolveHarnessPath(
  segments: readonly string[],
  location: HarnessLocation = {},
): string {
  const path = join(resolveHarnessRoot(location), ...segments);
  if (location.mutable) refuseLinkOnTheWay(location.projectDir ?? runtimeProjectDir(), path);
  return path;
}

export function resolveSkillsPath(
  segments: readonly string[] = [],
  location: HarnessLocation = {},
): string {
  const projectDir = location.projectDir ?? runtimeProjectDir();
  const harnessDir = location.harnessDir ?? runtimeHarnessDir(projectDir);
  const harnessSkills = resolveHarnessPath(["skills", ...segments], {
    ...location,
    harnessDir,
  });
  const distribution = location.distribution ??
    runtimeHarnessName(projectDir, harnessDir);
  const distributionRoot = dirname(resolveHarnessRoot({
    ...location,
    harnessDir,
    distribution,
  }));
  const shared = distribution === "copilot"
    ? join(distributionRoot, ".github", "skills", ...segments)
    : distribution === "codex" && !existsSync(harnessSkills)
    ? join(distributionRoot, ".agents", "skills", ...segments)
    : null;
  if (shared === null) return harnessSkills;
  if (location.mutable) refuseLinkOnTheWay(projectDir, shared);
  return shared;
}

export function resolveDistributionPath(
  segments: readonly string[],
  location: HarnessLocation = {},
): string {
  const projectDir = location.projectDir ?? runtimeProjectDir();
  if (
    location.mutable ||
    isAidlcHarnessRoot(join(projectDir, runtimeHarnessDir(projectDir)))
  ) {
    return join(projectDir, ...segments);
  }
  return join(
    packagedDistributionRoot(
      location.harnessDir ?? runtimeHarnessDir(projectDir),
      location.distribution,
    ),
    ...segments,
  );
}

// A space name: one plain path segment, a lowercase letter, then lowercase
// letters, digits and hyphens (the shape `space create` gives a name).
export const SPACE_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

// The space the active-space cursor names: its text, when that is a space name
// whose folder exists under <workspace>/spaces/; anything else is the default
// space.
export function knownActiveSpace(workspaceRootDir: string, cursorText: string | null | undefined): string {
  const name = (cursorText ?? "").trim();
  if (!SPACE_NAME_REGEX.test(name)) return "default";
  try {
    return statSync(join(workspaceRootDir, "spaces", name)).isDirectory() ? name : "default";
  } catch {
    return "default";
  }
}
