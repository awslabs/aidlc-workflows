// Where the AI-DLC project is, which harness trees it has, and which build.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform, release, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

// The engine dirs AI-DLC's harness rows install into (AI-DLC's harness table in aidlc-lib.ts).
export const ENGINE_DIRS = [".claude", ".kiro", ".codex", ".cursor", ".aidlc"] as const;

export type Tree = {
  dir: string; // ".kiro"
  row: string | null; // harness.json name: "kiro-ide", "kiro", "claude", …
  stampVersion: string | null; // tools/data/aidlc-stamp.json frameworkVersion
  buildVersion: string | null; // tools/aidlc-version.ts AIDLC_VERSION
  channel: "native" | "copy" | "unknown";
  kiroEngine: string | null; // .kiro/settings/cli.json chat.agentEngine (the project file)
};

// AI-DLC's and the tools' own JSON files, typed by the caller as far as it reads them.
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function findProjectRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "aidlc", "spaces")) || ENGINE_DIRS.some((d) => existsSync(join(dir, d, "tools", "data", "harness.json")))) {
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// Native installs register hooks as `engine hook <name>` after `aidlc`; copied ones as the same words after the
// tree's own `tools/aidlc.ts`, run by Bun.
function channelOf(project: string, dir: string): Tree["channel"] {
  const candidates: string[] = [];
  const hooksDir = join(project, dir, "hooks");
  if (existsSync(hooksDir)) {
    for (const f of readdirSync(hooksDir)) if (f.endsWith(".json")) candidates.push(join(hooksDir, f));
  }
  for (const f of ["settings.json", "hooks.json", join("agents", "aidlc.json")]) candidates.push(join(project, dir, f));
  candidates.push(join(project, ".github", "hooks", "aidlc.json"));
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    if (/\baidlc(\.cmd|\.exe)?["']?\s+engine\b/.test(text)) return "native";
    if (/tools[\\/]+aidlc\.ts/.test(text)) return "copy";
  }
  return "unknown";
}

export function readTrees(project: string): Tree[] {
  const trees: Tree[] = [];
  for (const dir of ENGINE_DIRS) {
    const data = join(project, dir, "tools", "data");
    const harness = readJson<{ name?: string }>(join(data, "harness.json"));
    if (!harness) continue;
    const stamp = readJson<{ distribution?: string; frameworkVersion?: string }>(join(data, "aidlc-stamp.json"));
    let buildVersion: string | null = null;
    const verFile = join(project, dir, "tools", "aidlc-version.ts");
    if (existsSync(verFile)) {
      const m = readFileSync(verFile, "utf8").match(/AIDLC_VERSION\s*=\s*["']([^"']+)["']/);
      buildVersion = m ? m[1] : null;
    }
    const cli = readJson<{ "chat.agentEngine"?: string }>(join(project, dir, "settings", "cli.json"));
    trees.push({
      dir,
      row: harness.name ?? stamp?.distribution ?? null,
      stampVersion: stamp?.frameworkVersion ?? null,
      buildVersion,
      channel: channelOf(project, dir),
      kiroEngine: cli?.["chat.agentEngine"] ?? null,
    });
  }
  return trees;
}

// Native machine install: active version and the source it was built from.
export function nativeInstall(): { dir: string; version: string | null; sourceRef: string | null; exe: string | null } | null {
  const base = platform() === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "aidlc")
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "aidlc");
  if (!existsSync(base)) return null;
  const active = existsSync(join(base, "active-version")) ? readFileSync(join(base, "active-version"), "utf8").trim() : null;
  const info = active ? readJson<{ version?: string; sourceRef?: string }>(join(base, "versions", active, "version.json")) : null;
  const exe = existsSync(join(base, "active-executable")) ? readFileSync(join(base, "active-executable"), "utf8").trim() : null;
  return { dir: base, version: info?.version ?? active, sourceRef: info?.sourceRef ?? null, exe };
}

// A tool's version and where it came from: `path` (the command on PATH), `known-location` (a usual
// install folder the skill's shell PATH missed), `app` (the IDE's package.json), `person` (read off the
// screen by the person, recorded by set-version.ts). `version: null` = not found on this machine.
export const TOOL_KEYS = ["kiro-ide", "kiro-cli", "claude", "codex", "copilot"] as const;
export type ToolKey = (typeof TOOL_KEYS)[number];
export type ToolVersion = { version: string | null; source: "path" | "known-location" | "app" | "person" | null };

const WIN = platform() === "win32";

function versionOf(cmd: string, args: string[]): string | null {
  // npm shims on Windows are .cmd files, which only run through a shell: the path is quoted, and one holding a sign the
  // shell reads even in quotes (`%NAME%`, `!`) or that a folder name can carry (`&`) is not run; its version is then asked.
  if (WIN && /[&|^%!<>()"]/.test(cmd)) return null;
  try {
    const file = WIN ? `"${cmd}"` : cmd;
    const out = execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000, shell: WIN });
    return out.trim().split("\n")[0].slice(0, 80) || null;
  } catch {
    return null;
  }
}

// The AI tool may start the skill's shell with a shorter PATH than the person's terminal.
function knownBinDirs(): string[] {
  const h = homedir();
  if (WIN) return [join(process.env.APPDATA ?? join(h, "AppData", "Roaming"), "npm"), join(h, ".local", "bin"), join(h, ".bun", "bin")];
  return [
    join(h, ".local", "bin"), join(h, ".claude", "local"), join(h, ".bun", "bin"), join(h, ".npm-global", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/Applications/Kiro CLI.app/Contents/MacOS",
  ];
}

function cliVersion(cmd: string): ToolVersion {
  const onPath = versionOf(cmd, ["--version"]);
  if (onPath) return { version: onPath, source: "path" };
  for (const dir of knownBinDirs()) {
    for (const name of WIN ? [`${cmd}.cmd`, `${cmd}.exe`] : [cmd]) {
      const file = join(dir, name);
      if (!existsSync(file)) continue;
      const v = versionOf(file, ["--version"]);
      if (v) return { version: v, source: "known-location" };
    }
  }
  return { version: null, source: null };
}

// Kiro IDE has no version command, and its macOS Info.plist is a binary plist. Every platform ships
// resources/app/package.json, whose `version` is the IDE's (macOS 1.4.13: equal to
// CFBundleShortVersionString). macOS paths are measured; Windows and Linux follow the VS Code layout.
function kiroIdeVersion(): ToolVersion {
  const h = homedir();
  const apps = platform() === "darwin"
    ? ["/Applications/Kiro.app", join(h, "Applications", "Kiro.app")].map((a) => join(a, "Contents", "Resources", "app"))
    : WIN
      ? [join(process.env.LOCALAPPDATA ?? join(h, "AppData", "Local"), "Programs", "Kiro"), join(process.env.ProgramFiles ?? "C:\\Program Files", "Kiro")]
        .map((a) => join(a, "resources", "app"))
      : ["/usr/share/kiro", "/opt/Kiro", "/opt/kiro", join(h, ".local", "share", "kiro")].map((a) => join(a, "resources", "app"));
  for (const app of apps) {
    const v = readJson<{ version?: unknown }>(join(app, "package.json"))?.version;
    if (typeof v === "string" && v) return { version: v.slice(0, 40), source: "app" };
  }
  return { version: null, source: null };
}

// Kiro CLI also reads ~/.kiro/settings/cli.json. Which of the two decides the engine has changed across
// Kiro CLI versions (2.21.1: the project's; 2.33.1: only the home one, measured 2026-10-22), so both are
// recorded and signals.md says which wins for which version.
function kiroHomeEngine(): { file: boolean; agentEngine: string | null } {
  const path = join(homedir(), ".kiro", "settings", "cli.json");
  const engine = readJson<{ "chat.agentEngine"?: unknown }>(path)?.["chat.agentEngine"];
  return { file: existsSync(path), agentEngine: typeof engine === "string" ? engine : null };
}

// `used`: the tools whose version is looked up; the others are not started and read as not looked up.
export function environment(project: string, used: readonly ToolKey[] = TOOL_KEYS) {
  const pinFile = join(project, ".aidlc-version");
  const look = (k: ToolKey, f: () => ToolVersion): ToolVersion => (used.includes(k) ? f() : { version: null, source: null });
  const tools: Record<ToolKey, ToolVersion> = {
    "kiro-ide": look("kiro-ide", kiroIdeVersion),
    "kiro-cli": look("kiro-cli", () => cliVersion("kiro-cli")),
    claude: look("claude", () => cliVersion("claude")),
    codex: look("codex", () => cliVersion("codex")),
    copilot: look("copilot", () => cliVersion("copilot")),
  };
  return {
    os: `${platform()} ${release()} ${arch()}`,
    bun: typeof Bun !== "undefined" ? Bun.version : null,
    pin: existsSync(pinFile) ? readFileSync(pinFile, "utf8").trim().slice(0, 60) : null,
    native: nativeInstall(),
    tools,
    kiroHomeEngine: kiroHomeEngine(),
  };
}

// Transcript `tool` labels (lib-transcripts.ts) -> the tool whose version matters for this run.
const USED_BY_LABEL: [RegExp, ToolKey][] = [
  [/^claude-code$/, "claude"],
  [/^codex$/, "codex"],
  [/Kiro IDE/, "kiro-ide"],
  [/Kiro CLI|^kiro-cli/, "kiro-cli"],
  [/^copilot-cli$/, "copilot"],
];

// A tool whose only sessions made this report is not a tool the run used.
export function toolsUsed(transcripts: { tool?: string; sessions?: number; reportSessions?: number; mixedSessions?: number }[]): ToolKey[] {
  const used = new Set<ToolKey>();
  for (const t of transcripts) {
    if (!t.tool || (t.sessions ?? 0) - (t.reportSessions ?? 0) + (t.mixedSessions ?? 0) <= 0) continue;
    for (const [re, key] of USED_BY_LABEL) if (re.test(t.tool)) used.add(key);
  }
  return TOOL_KEYS.filter((k) => used.has(k));
}

// Intent record dirs: aidlc/spaces/<space>/intents/<YYMMDD>-<slug>/
export type Intent = { space: string; dir: string; path: string };

// A dangling link (a sync tool's, an interrupted move) is not a folder and stops nothing.
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function listIntents(project: string): Intent[] {
  const spacesDir = join(project, "aidlc", "spaces");
  const out: Intent[] = [];
  if (!existsSync(spacesDir)) return out;
  for (const space of readdirSync(spacesDir)) {
    const intentsDir = join(spacesDir, space, "intents");
    if (!isDir(intentsDir)) continue;
    for (const dir of readdirSync(intentsDir)) {
      const path = join(intentsDir, dir);
      if (dir.startsWith(".") || dir === "audit" || !isDir(path)) continue;
      out.push({ space, dir, path });
    }
  }
  return out;
}

// The environment for the doctor run collect.ts starts. The scripts may run as
// `BUN_BE_BUN=1 aidlc <script>` (a native install has no other Bun), and a
// nested `aidlc` that inherits the switch starts Bun instead of AI-DLC. So the
// switch is dropped, and set again only to run a copied tree's `aidlc.ts` with
// the aidlc executable itself.
// The project doctor checks is the one on its command line: a project folder the AI tool set for its own session
// (CLAUDE_PROJECT_DIR, AIDLC_PROJECT_DIR, maybe a parent folder) is not passed on.
export function doctorEnv(cmd: string[], execPath: string, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { BUN_BE_BUN: _inherited, CLAUDE_PROJECT_DIR: _claude, AIDLC_PROJECT_DIR: _aidlc, ...env } = base;
  const isBun = /(^|[\\/])bun(\.exe)?$/i.test(execPath);
  if (cmd[0] === execPath && cmd.length > 1 && !isBun) env.BUN_BE_BUN = "1";
  return env;
}

// AI-DLC's own secret rules: `redactSecretPatterns`, which its doctor export applies, from the AI-DLC
// this project has installed. AI-DLC owns what a secret looks like, so a key looks the same to this
// report as to AI-DLC's record and export. null when no tree of the project carries them.
export function secretRulesFile(project: string): string | null {
  for (const dir of ENGINE_DIRS) {
    const file = join(project, dir, "tools", "aidlc-doctor-bundle.ts");
    if (existsSync(file)) return file;
  }
  return null;
}

// From the same file, doctor's own finding ids: findingIdFromLabel, so a finding id in safe.json is checked
// against the ids this AI-DLC makes. From the same tools folder, two more of AI-DLC's own rules, so the skill
// keeps no second copy of them: whether a file still holds what the install recorded for it, line endings aside
// (holdsRecordedWrite, the rule doctor's changed-files rows use), and which audit rows a copied shard file (a sync
// tool's `<shard> 2.md`) repeats (copiedAuditBlocks), how one field of an audit row is read (auditBlockField) and
// which rows a doctor run writes about itself (DOCTOR_RUN_AUDIT_EVENTS), and how a state field is read (getField).
export type AuditShardText = { shard: string; content: string };
export type AidlcTools = {
  secretRules: ((text: string) => string) | null;
  findingId: ((label: string) => string) | undefined;
  holdsRecordedWrite?: (content: Buffer, hash: string) => boolean;
  auditCopies?: { blocks: (content: string) => string[]; copied: (shards: AuditShardText[]) => ReadonlySet<number>[] };
  auditField?: (block: string, name: string) => string | null;
  stateField?: (content: string, field: string) => string | null;
  doctorRunEvents?: ReadonlySet<string>;
};

async function importFrom(file: string): Promise<Record<string, unknown>> {
  try {
    return existsSync(file) ? await import(pathToFileURL(file).href) : {};
  } catch {
    return {};
  }
}

export async function importAidlcTools(file: string | null | undefined): Promise<AidlcTools> {
  if (!file || !existsSync(file)) return { secretRules: null, findingId: undefined };
  const mod = await importFrom(file);
  const rules = mod.redactSecretPatterns;
  const id = mod.findingIdFromLabel;
  const tools: AidlcTools = {
    secretRules: typeof rules === "function" ? (text: string) => String(rules(text)) : null,
    findingId: typeof id === "function" ? (label: string) => String(id(label)) : undefined,
  };
  const dist = await importFrom(join(dirname(file), "aidlc-distribution.ts"));
  const holds = dist.holdsRecordedWrite;
  if (typeof holds === "function") tools.holdsRecordedWrite = (content, hash) => holds(content, hash) === true;
  const lib = await importFrom(join(dirname(file), "aidlc-lib.ts"));
  const { auditShardBlocks, copiedAuditBlocks, auditBlockField, DOCTOR_RUN_AUDIT_EVENTS, getField } = lib;
  if (typeof getField === "function") tools.stateField = (content, field) => getField(content, field) as string | null;
  if (typeof auditBlockField === "function") tools.auditField = (block, name) => auditBlockField(block, name) as string | null;
  if (DOCTOR_RUN_AUDIT_EVENTS instanceof Set) tools.doctorRunEvents = DOCTOR_RUN_AUDIT_EVENTS as ReadonlySet<string>;
  if (typeof auditShardBlocks === "function" && typeof copiedAuditBlocks === "function") {
    tools.auditCopies = {
      blocks: (content) => auditShardBlocks(content) as string[],
      // Which file of a copy pair is this clone's own shard only decides where a row is read from; the
      // report reads every row once either way, so the question (which can bind a session) is not asked.
      copied: (shards) => copiedAuditBlocks(shards, () => null) as ReadonlySet<number>[],
    };
  }
  return tools;
}

export async function importSecretRules(file: string | null | undefined): Promise<((text: string) => string) | null> {
  return (await importAidlcTools(file)).secretRules;
}
