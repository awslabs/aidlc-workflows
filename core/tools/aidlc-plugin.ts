#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { DEFAULT_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";
import { projectInvocationTokens } from "./aidlc-command.ts";
import {
  acquireAuditLock,
  addPendingPersonLines,
  committedTextBytes,
  errorMessage,
  escapeRegex,
  isPlainObject,
  parseArgs,
  parseStageFrontmatter,
  pausedBySelection,
  PHASES,
  pluginsEnabled,
  releaseAuditLock,
  resolveProjectDir,
  validScopes,
} from "./aidlc-lib.ts";
import { removeOrphanProducesKinds } from "./aidlc-plugin-produces-kinds.ts";
import { policyPathWithin } from "./aidlc-install-paths.ts";
import { type PluginCommandSkip, projectPluginCommands } from "./aidlc-plugin-commands.ts";
import { markdownBlocks } from "./aidlc-markdown.ts";
import { PLUGIN_RULES_OPENING } from "./aidlc-plugin-rules.ts";
import { refreshActiveMemory } from "./aidlc-includes.ts";
import { resolveInvokingSessionId } from "./aidlc-record-core.ts";
import {
  aidlcInvocation,
  compiledExecutable,
  discoverProjectHarnesses,
  entrySkillInvocation,
  LinkedFolderError,
  pinNamedHarness,
  quoteCommandArgument,
  refuseLinkOnTheWay,
  resolveHarnessPath,
  resolveSkillsPath,
  runtimeHarnessDir,
  runtimeHarnessName,
  runtimeProjectDir,
} from "./aidlc-runtime-paths.ts";
import {
  executePlan,
  TransactionBusyError,
  withTransactionFix,
  transactionState,
  writeOperation,
  type TransactionOperation,
  type TransactionPlan,
} from "./aidlc-transaction.ts";
import {
  hostIdSegment,
  pluginStageSlugs,
  readPluginBase,
  readPluginCommands,
  scopeIncludes,
  type PluginBaseProblem,
  type PluginCommandEntry,
  type PluginDependency,
} from "./aidlc-plugin-validate.ts";

const SAFE_PLUGIN_KEY = /^[a-z][a-z0-9-]*$/;
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMPOSE_DIRS = [
  "agents",
  "contributions",
  "knowledge",
  "memory",
  "scopes",
  "sensors",
  "stages",
  "tools",
] as const;

export type InventoryCapability = "full-inventory" | "current-root-only";

export type InstalledPlugin = {
  key: string;
  hostName: string;
  version: string;
  root: string;
  manifestPath: string;
  enabled: boolean;
  sourceHash: string;
  // The one base plugin this one builds on, from its own manifest, or why that
  // manifest cannot say.
  base: PluginDependency | null;
  baseProblem: PluginBaseProblem | { kind: "unreadable"; reason: string } | null;
  // The commands its own manifest names (aidlc.commands), well-formed ones only.
  commands?: Record<string, PluginCommandEntry>;
  // The host's own id for it (name@marketplace), where the host lists plugins.
  hostId?: string;
};

export type InvalidInstalledPlugin = {
  paths: string[];
  message: string;
  key?: string;
};

export type PluginInventory = {
  capability: InventoryCapability;
  harness: "claude" | "codex" | "kiro" | "cursor" | "copilot" | "opencode";
  source?: string;
  installed: InstalledPlugin[];
  invalid: InvalidInstalledPlugin[];
  // Old aidlc-<name> copies of a plugin also installed rebuilt under its own name.
  superseded?: InstalledPlugin[];
};

export type CompositionStamp = {
  schemaVersion: 1;
  name: string;
  version: string;
  sourceHash: string;
  // The base plugin this one builds on. A host with no plugin list reads it
  // here to keep layering one level deep.
  base?: string;
  // The commands it adds whose script it installed (pluginCommandTable reads
  // them), and the names the sync that wrote this found taken, so it says each
  // once. Absent when it has none.
  commands?: Record<string, PluginCommandEntry>;
  skippedCommands?: string[];
};

export type PluginStatusName =
  | "current"
  | "version-differs"
  | "source-changed"
  | "not-composed"
  | "legacy-unstamped"
  | "installed-disabled"
  | "installed-missing"
  | "invalid-installed"
  | "inventory-unavailable"
  | "dependency-unmet"
  | "paused"
  | "installed-twice";

export type PluginStatus = {
  key: string | null;
  installedVersion: string | null;
  composedVersion: string | null;
  state: PluginStatusName;
  action: "current" | "sync" | "attention";
  message: string;
  paths?: string[];
};

type OwnershipFile = {
  path: string;
  sha256: string;
};

type OwnershipRecord = {
  schemaVersion: 1;
  name: string;
  files: OwnershipFile[];
};

// A plugin sync could not compose on its base, and the line that says why,
// for plugin list and doctor. The sync that composes the plugin removes it.
export type HeldRecord = {
  schemaVersion: 1;
  name: string;
  version: string;
  reason: string;
};

export type ProjectEvidence = {
  stamps: Map<string, CompositionStamp>;
  legacy: Set<string>;
  ownership: Map<string, OwnershipRecord>;
  held: Map<string, HeldRecord>;
};

function absolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function regularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        files.push(path);
      } else {
        throw new Error(`${path}: plugin source contains a link or special file`);
      }
    }
  };
  visit(root);
  return files;
}

function surfaceFiles(root: string): string[] {
  // A surface that is itself a link stays out of the staged copy, so it stays
  // out of the diff too.
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(path);
    }
  };
  visit(root);
  return files;
}

function normalizedSourceBytes(path: string): Buffer {
  const bytes = readFileSync(path);
  const text = bytes.toString("utf-8");
  if (Buffer.from(text, "utf-8").equals(bytes)) {
    return Buffer.from(text.replace(/\r\n?/g, "\n"), "utf-8");
  }
  return bytes;
}

export function pluginSourceHash(root: string): string {
  const files = COMPOSE_DIRS.flatMap((directory) =>
    regularFiles(join(root, directory)).map((path) => ({
      path,
      relative: relative(root, path).split(sep).join("/"),
    }))
  ).sort((left, right) => left.relative.localeCompare(right.relative));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(normalizedSourceBytes(file.path));
  }
  return `sha256:${hash.digest("hex")}`;
}

function hostManifestDirectory(harness: PluginInventory["harness"]): string {
  if (harness === "claude") return ".claude-plugin";
  if (harness === "codex") return ".codex-plugin";
  if (harness === "kiro") return ".kiro-plugin";
  if (harness === "cursor") return ".cursor-plugin";
  if (harness === "copilot") return ".plugin";
  return ".opencode-plugin";
}

// AI-DLC's own name for an installed plugin. A plugin someone else builds shows
// in the host under its author's name, so the plugin's own manifest, which every
// build carries beside the host one, says which plugin it is. A build from
// before that manifest travelled with it named its host package aidlc-<name>.
function installedPluginKey(root: string, hostName: string, manifestPath: string): string {
  const own = join(root, ".aidlc-plugin", "plugin.json");
  if (existsSync(own)) {
    let name: unknown;
    try {
      name = (readJson(own) as { name?: unknown } | null)?.name;
    } catch {
      name = undefined;
    }
    if (typeof name === "string" && name.trim()) return name.trim();
    if (!hostName.startsWith("aidlc-")) throw new Error(`${own}: the plugin's own manifest does not name it`);
  }
  if (!hostName.startsWith("aidlc-")) {
    throw new Error(
      `${manifestPath}: not an AI-DLC plugin: it has no .aidlc-plugin/plugin.json and its name does not start with "aidlc-"`,
    );
  }
  return hostName.slice("aidlc-".length);
}

// The key an invalid host entry is reported under, when its root still says.
function installedKeyHint(root: string, hostName: string): string | undefined {
  try {
    return installedPluginKey(root, hostName, root);
  } catch {
    return hostName.startsWith("aidlc-") ? hostName.slice("aidlc-".length) : undefined;
  }
}

// A host lists every vendor's plugins. A plain name is AI-DLC's only through an
// installed root that carries the plugin's own manifest; every other entry,
// broken or not, is none of AI-DLC's business.
function carriesOwnManifest(root: unknown): boolean {
  return typeof root === "string" && root !== "" &&
    existsSync(join(root, ".aidlc-plugin", "plugin.json"));
}

// An old copy of a plugin someone else built is the one its host lists under
// AI-DLC's name for it, aidlc-<name>: 2.11.0 built it that way without the
// plugin's own manifest, the 2.11.1 previews with it. A copy rebuilt by its
// author carries the author's name.
function hostListsUnderAidlcName(plugin: InstalledPlugin): boolean {
  return plugin.hostName === `aidlc-${plugin.key}`;
}

export function normalizeInstalledPlugin(
  root: string,
  harness: PluginInventory["harness"],
  enabled = true,
  expectedVersion?: string,
): InstalledPlugin {
  const canonicalRoot = absolute(root);
  const manifestPath = join(canonicalRoot, hostManifestDirectory(harness), "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath}: installed plugin manifest is missing`);
  }
  let parsed: unknown;
  try {
    parsed = readJson(manifestPath);
  } catch (error) {
    throw new Error(`${manifestPath}: invalid JSON: ${errorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${manifestPath}: manifest must be a JSON object`);
  }
  const manifest = parsed as Record<string, unknown>;
  const hostName = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const version = typeof manifest.version === "string" ? manifest.version.trim() : "";
  const key = installedPluginKey(canonicalRoot, hostName, manifestPath);
  if (!SAFE_PLUGIN_KEY.test(key)) {
    throw new Error(`${manifestPath}: plugin key "${key}" is not safe`);
  }
  if (!STRICT_SEMVER.test(version)) {
    throw new Error(`${manifestPath}: version "${version}" is not valid semver`);
  }
  if (expectedVersion !== undefined && expectedVersion !== version) {
    throw new Error(
      `${manifestPath}: manifest version ${version} does not match host inventory version ${expectedVersion}`,
    );
  }
  return {
    key,
    hostName,
    version,
    root: canonicalRoot,
    manifestPath,
    enabled,
    sourceHash: pluginSourceHash(canonicalRoot),
    ...installedBase(canonicalRoot, key),
    commands: installedCommands(canonicalRoot),
  };
}

// A projection built before the plugin's own manifest travelled with it names
// no commands; nor does a manifest that cannot be read.
function installedCommands(root: string): Record<string, PluginCommandEntry> {
  try {
    const manifest = readJson(join(root, ".aidlc-plugin", "plugin.json")) as { aidlc?: unknown } | null;
    return readPluginCommands(manifest?.aidlc).commands;
  } catch {
    return {};
  }
}

// The commands a plugin adds: those whose script is a file it installed, as its
// ownership record says, so a name never runs a file core or another plugin owns.
function ownedCommands(
  plugin: InstalledPlugin,
  ownedPaths: ReadonlySet<string>,
  harnessDir: string,
): Record<string, PluginCommandEntry> {
  const leaf = harnessDir.split(sep).join("/");
  return Object.fromEntries(
    Object.entries(plugin.commands ?? {}).filter(([, entry]) => ownedPaths.has(`${leaf}/${entry.script}`)),
  );
}

function sameCommands(
  left: Record<string, PluginCommandEntry> | undefined,
  right: Record<string, PluginCommandEntry>,
): boolean {
  return JSON.stringify(Object.entries(left ?? {}).sort()) === JSON.stringify(Object.entries(right).sort());
}

// The one line a sync says, once, for a plugin command it does not add.
export function skippedCommandLine(skip: PluginCommandSkip): string {
  const holder = skip.by.kind === "core"
    ? `AI-DLC's own ${skip.name} command has that name`
    : skip.by.kind === "plan"
      ? `the ${skip.by.name} plan has that name`
      : `the ${skip.by.plugin} plugin's command has that name`;
  return `${skip.plugin}'s command '${skip.name}' is not added: ${holder}.`;
}

// A projection built before the plugin's own manifest travelled with it
// builds on core alone, as every plugin did then.
function installedBase(root: string, key: string): Pick<InstalledPlugin, "base" | "baseProblem"> {
  const manifestPath = join(root, ".aidlc-plugin", "plugin.json");
  if (!existsSync(manifestPath)) return { base: null, baseProblem: null };
  let manifest: unknown;
  try {
    manifest = readJson(manifestPath);
  } catch {
    return { base: null, baseProblem: { kind: "unreadable", reason: "not valid JSON" } };
  }
  const read = readPluginBase((manifest as { dependencies?: unknown } | null)?.dependencies, key);
  return "problem" in read ? { base: null, baseProblem: read.problem } : { base: read.base, baseProblem: null };
}

function currentRoots(): string[] {
  return [...new Set([
    process.env.CLAUDE_PLUGIN_ROOT,
    process.env.PLUGIN_ROOT,
    process.env.AIDLC_PLUGIN_ROOT,
  ].map((value) => value?.trim() ?? "").filter(Boolean).map(absolute))];
}

function harnessKind(harnessDir = runtimeHarnessDir(), projectDir = resolveProjectDir()): PluginInventory["harness"] {
  // The install's harness.json names it where the folder does not: opencode
  // and Copilot share .aidlc.
  const declared = runtimeHarnessName(projectDir, harnessDir);
  if (
    declared === "claude" ||
    declared === "codex" ||
    declared === "kiro" ||
    declared === "kiro-ide" ||
    declared === "cursor" ||
    declared === "copilot" ||
    declared === "opencode"
  ) {
    return declared === "kiro-ide" ? "kiro" : declared;
  }
  if (harnessDir === ".codex") return "codex";
  if (harnessDir === ".kiro") return "kiro";
  if (harnessDir === ".cursor") return "cursor";
  return "claude";
}

function invalidFromRoot(
  root: string,
  harness: PluginInventory["harness"],
  enabled: boolean,
  expectedVersion?: string,
): InstalledPlugin | InvalidInstalledPlugin {
  try {
    return normalizeInstalledPlugin(root, harness, enabled, expectedVersion);
  } catch (error) {
    return { paths: [root], message: errorMessage(error) };
  }
}

function deduplicateInventory(
  entries: InstalledPlugin[],
  invalid: InvalidInstalledPlugin[],
): { installed: InstalledPlugin[]; invalid: InvalidInstalledPlugin[]; superseded: InstalledPlugin[] } {
  const byKey = new Map<string, InstalledPlugin[]>();
  for (const entry of entries) {
    const values = byKey.get(entry.key) ?? [];
    if (!values.some((value) => value.manifestPath === entry.manifestPath)) values.push(entry);
    byKey.set(entry.key, values);
  }
  const installed: InstalledPlugin[] = [];
  const superseded: InstalledPlugin[] = [];
  for (const [key, values] of byKey) {
    if (values.length === 1) {
      installed.push(values[0]);
      continue;
    }
    // A plugin rebuilt under its own name beside its old aidlc-<name> copy, as
    // an update leaves it until the old one is removed: the rebuilt one is used.
    const old = values.filter(hostListsUnderAidlcName);
    const rebuilt = values.filter((value) => !hostListsUnderAidlcName(value));
    if (values.length === 2 && rebuilt.length === 1 && old.length === 1) {
      installed.push(rebuilt[0]);
      superseded.push(old[0]);
      continue;
    }
    invalid.push({
      key,
      paths: values.map((value) => value.manifestPath).sort(),
      message: `installed plugin identity "${key}" is ambiguous across ${values.length} manifests`,
    });
  }
  const byName = new Map<string, InstalledPlugin[]>();
  for (const entry of installed) {
    const values = byName.get(entry.hostName) ?? [];
    values.push(entry);
    byName.set(entry.hostName, values);
  }
  const duplicateNames = new Set(
    [...byName].filter(([, values]) => values.length > 1).map(([name]) => name),
  );
  const unique = installed.filter((entry) => !duplicateNames.has(entry.hostName));
  for (const name of duplicateNames) {
    const values = byName.get(name) ?? [];
    invalid.push({
      paths: values.map((value) => value.manifestPath).sort(),
      message: `installed plugin name "${name}" maps to multiple identities`,
    });
  }
  return {
    installed: unique.sort((left, right) => left.key.localeCompare(right.key)),
    invalid: invalid.sort((left, right) => left.message.localeCompare(right.message)),
    superseded: superseded.sort((left, right) => left.key.localeCompare(right.key)),
  };
}

// What to tell the person about an old copy of a plugin installed beside its
// rebuilt one: the host's own command removes it.
function supersededWords(harness: PluginInventory["harness"], old: InstalledPlugin): string {
  const id = old.hostId ?? old.hostName;
  const remove = harness === "codex" ? `codex plugin remove ${id}` : `/plugin uninstall ${id}`;
  return `installed twice; AI-DLC uses the rebuilt one. Remove the old copy: ${remove}`;
}

export function supersededLines(inventory: PluginInventory): string[] {
  return (inventory.superseded ?? []).map((old) => `${old.key} is ${supersededWords(inventory.harness, old)}`);
}

function currentRootInventory(harness: PluginInventory["harness"]): PluginInventory {
  const installed: InstalledPlugin[] = [];
  const invalid: InvalidInstalledPlugin[] = [];
  for (const root of currentRoots()) {
    const entry = invalidFromRoot(root, harness, true);
    if ("root" in entry) installed.push(entry);
    else invalid.push(entry);
  }
  const normalized = deduplicateInventory(installed, invalid);
  return {
    capability: "current-root-only",
    harness,
    installed: normalized.installed,
    invalid: normalized.invalid,
    superseded: normalized.superseded,
  };
}

function claudeInventory(projectDir: string): PluginInventory {
  const registryPath = absolute(
    process.env.AIDLC_CLAUDE_PLUGIN_REGISTRY ??
      join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "plugins", "installed_plugins.json"),
  );
  if (!existsSync(registryPath)) return currentRootInventory("claude");
  const settingsPath = absolute(
    process.env.AIDLC_CLAUDE_SETTINGS ??
      join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json"),
  );
  const invalid: InvalidInstalledPlugin[] = [];
  const installed: InstalledPlugin[] = [];
  let registry: unknown;
  try {
    registry = readJson(registryPath);
  } catch (error) {
    return {
      capability: "full-inventory",
      harness: "claude",
      source: registryPath,
      installed,
      invalid: [{ paths: [registryPath], message: `invalid Claude plugin registry: ${errorMessage(error)}` }],
    };
  }
  // Unreadable enablement cannot prove which plugins are on, so it falls back
  // to the current root, but it stays a named problem the person can fix.
  const unreadableSettings = (reason: string): PluginInventory => {
    const inventory = currentRootInventory("claude");
    inventory.invalid.push({ paths: [settingsPath], message: `invalid Claude settings: ${reason}` });
    return inventory;
  };
  let enabledPlugins: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    let settings: unknown;
    try {
      settings = readJson(settingsPath);
    } catch (error) {
      // Fixed wording only: a parser message can quote the file's content,
      // and this settings file can hold credentials.
      return unreadableSettings(
        error instanceof SyntaxError ? "not valid JSON" : "cannot be read",
      );
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return unreadableSettings("expected a JSON object");
    }
    const rawEnabled = (settings as Record<string, unknown>).enabledPlugins;
    if (rawEnabled !== undefined) {
      if (!rawEnabled || typeof rawEnabled !== "object" || Array.isArray(rawEnabled)) {
        return unreadableSettings("enabledPlugins must be an object");
      }
      enabledPlugins = rawEnabled as Record<string, unknown>;
    }
  }
  // Claude Code loads a project-scope plugin wherever the project's committed
  // settings enable it, so a second clone or worktree with no record of its
  // own uses the project-scope records.
  let projectEnabled: Record<string, unknown> = {};
  try {
    const raw = (readJson(join(projectDir, ".claude", "settings.json")) as Record<string, unknown> | null)
      ?.enabledPlugins;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) projectEnabled = raw as Record<string, unknown>;
  } catch {
    // A missing or unreadable project settings file enables nothing here.
  }
  const elsewhere = (raw: unknown): boolean => {
    const entry = raw as Record<string, unknown>;
    return !!raw && typeof raw === "object" && !Array.isArray(raw) &&
      (entry.scope === "local" || entry.scope === "project") &&
      typeof entry.projectPath === "string" && isAbsolute(entry.projectPath) &&
      !policyPathWithin(entry.projectPath, projectDir);
  };
  const plugins = registry && typeof registry === "object" &&
      !Array.isArray(registry) &&
      (registry as Record<string, unknown>).version === 2 &&
      typeof (registry as Record<string, unknown>).plugins === "object" &&
      (registry as Record<string, unknown>).plugins !== null
    ? (registry as { plugins: Record<string, unknown> }).plugins
    : null;
  if (plugins === null) {
    invalid.push({
      paths: [registryPath],
      message: "Claude plugin registry must use schema version 2 with a plugins object",
    });
  } else {
    for (const [id, rawEntries] of Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b))) {
      const registryName = id.split("@", 1)[0];
      const aidlcName = registryName.startsWith("aidlc-");
      const ownRecord = (raw: unknown): boolean =>
        aidlcName || carriesOwnManifest((raw as Record<string, unknown> | null)?.installPath);
      if (!aidlcName && !(Array.isArray(rawEntries) && rawEntries.some(ownRecord))) continue;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
        invalid.push({ paths: [registryPath], message: `Claude plugin "${id}" has no installed records` });
        continue;
      }
      const own = rawEntries.filter((raw) => !elsewhere(raw));
      const records = (own.length > 0 || projectEnabled[id] !== true
        ? own
        : rawEntries.filter((raw) => (raw as Record<string, unknown>).scope === "project")).filter(ownRecord);
      for (const rawEntry of records) {
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
          invalid.push({ paths: [registryPath], message: `Claude plugin "${id}" has an invalid installed record` });
          continue;
        }
        const entry = rawEntry as Record<string, unknown>;
        const root = typeof entry.installPath === "string" ? entry.installPath : "";
        const version = typeof entry.version === "string" ? entry.version : undefined;
        if (!root) {
          invalid.push({ paths: [registryPath], message: `Claude plugin "${id}" has no installPath` });
          continue;
        }
        const normalized = invalidFromRoot(root, "claude", enabledPlugins[id] !== false, version);
        if ("root" in normalized) installed.push({ ...normalized, hostId: id });
        else invalid.push({ ...normalized, key: installedKeyHint(root, registryName) });
      }
    }
  }
  const normalized = deduplicateInventory(installed, invalid);
  return {
    capability: "full-inventory",
    harness: "claude",
    source: registryPath,
    installed: normalized.installed,
    invalid: normalized.invalid,
    superseded: normalized.superseded,
  };
}

function codexInventory(): PluginInventory {
  const codexHome = absolute(process.env.AIDLC_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const configPath = absolute(process.env.AIDLC_CODEX_CONFIG ?? join(codexHome, "config.toml"));
  if (!existsSync(configPath)) return currentRootInventory("codex");
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    return {
      capability: "full-inventory",
      harness: "codex",
      source: configPath,
      installed: [],
      invalid: [{ paths: [configPath], message: `invalid Codex config: ${errorMessage(error)}` }],
    };
  }
  const plugins = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).plugins
    : undefined;
  const declared = plugins && typeof plugins === "object" && !Array.isArray(plugins)
    ? plugins as Record<string, unknown>
    : {};
  const installed: InstalledPlugin[] = [];
  const invalid: InvalidInstalledPlugin[] = [];
  for (const [id, rawConfig] of Object.entries(declared).sort(([a], [b]) => a.localeCompare(b))) {
    const at = id.lastIndexOf("@");
    const pluginName = at > 0 ? id.slice(0, at) : "";
    const marketplace = at > 0 ? id.slice(at + 1) : "";
    if (!pluginName || !marketplace || !hostIdSegment(pluginName) ||
      !hostIdSegment(marketplace)) {
      invalid.push({ paths: [configPath], message: `Codex plugin id "${id}" is not name@marketplace` });
      continue;
    }
    const aidlcName = pluginName.startsWith("aidlc-");
    const pluginConfig = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? rawConfig as Record<string, unknown>
      : {};
    const enabled = pluginConfig.enabled !== false;
    const cacheRoot = join(codexHome, "plugins", "cache", marketplace, pluginName);
    if (!existsSync(cacheRoot)) {
      if (!aidlcName) continue;
      invalid.push({
        paths: [cacheRoot],
        message: `Codex plugin "${id}" is configured but its installed cache path is missing`,
      });
      continue;
    }
    const versions = readdirSync(cacheRoot).filter((entry) => {
      const path = join(cacheRoot, entry);
      return (entry === "local" || STRICT_SEMVER.test(entry)) &&
        !lstatSync(path).isSymbolicLink() &&
        lstatSync(path).isDirectory();
    }).sort();
    if (versions.length === 0) {
      if (!aidlcName) continue;
      invalid.push({ paths: [cacheRoot], message: `Codex plugin "${id}" has no installed tree` });
      continue;
    }
    const selectedVersion = versions.includes("local")
      ? "local"
      : versions.sort((left, right) => {
        const a = left.match(STRICT_SEMVER) as RegExpMatchArray;
        const b = right.match(STRICT_SEMVER) as RegExpMatchArray;
        for (let index = 1; index <= 3; index++) {
          const difference = Number(a[index]) - Number(b[index]);
          if (difference !== 0) return difference;
        }
        return left < right ? -1 : left > right ? 1 : 0;
      }).at(-1) as string;
    const root = join(cacheRoot, selectedVersion);
    if (!aidlcName && !carriesOwnManifest(root)) continue;
    const normalized = invalidFromRoot(
      root,
      "codex",
      enabled,
      selectedVersion === "local" ? undefined : selectedVersion,
    );
    if ("root" in normalized) installed.push({ ...normalized, hostId: id });
    else invalid.push({ ...normalized, key: installedKeyHint(root, pluginName) });
  }
  const normalized = deduplicateInventory(installed, invalid);
  return {
    capability: "full-inventory",
    harness: "codex",
    source: configPath,
    installed: normalized.installed,
    invalid: normalized.invalid,
    superseded: normalized.superseded,
  };
}

export function discoverPluginInventory(
  harnessDir = runtimeHarnessDir(),
  projectDir = resolveProjectDir(),
): PluginInventory {
  const harness = harnessKind(harnessDir, projectDir);
  if (harness === "claude") return claudeInventory(projectDir);
  if (harness === "codex") return codexInventory();
  return currentRootInventory(harness);
}

function harnessDataDir(projectDir: string, harnessDir: string): string {
  return join(projectDir, harnessDir, "tools", "data");
}

function parseStamp(path: string): CompositionStamp | null {
  try {
    const value = readJson(path) as Partial<CompositionStamp>;
    if (
      value.schemaVersion === 1 &&
      typeof value.name === "string" &&
      SAFE_PLUGIN_KEY.test(value.name) &&
      typeof value.version === "string" &&
      STRICT_SEMVER.test(value.version) &&
      typeof value.sourceHash === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(value.sourceHash) &&
      (value.base === undefined || (typeof value.base === "string" && SAFE_PLUGIN_KEY.test(value.base)))
    ) {
      return value as CompositionStamp;
    }
  } catch {
    // Invalid stamps are legacy evidence. A successful sync replaces them.
  }
  return null;
}

function parseOwnership(path: string): OwnershipRecord | null {
  try {
    const value = readJson(path) as Partial<OwnershipRecord>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.name !== "string" ||
      !SAFE_PLUGIN_KEY.test(value.name) ||
      !Array.isArray(value.files)
    ) return null;
    const files: OwnershipFile[] = [];
    for (const file of value.files) {
      if (
        !file ||
        typeof file !== "object" ||
        typeof (file as OwnershipFile).path !== "string" ||
        isAbsolute((file as OwnershipFile).path) ||
        (file as OwnershipFile).path.split(/[\\/]/).includes("..") ||
        typeof (file as OwnershipFile).sha256 !== "string" ||
        !/^sha256:[0-9a-f]{64}$/.test((file as OwnershipFile).sha256)
      ) return null;
      files.push(file as OwnershipFile);
    }
    return { schemaVersion: 1, name: value.name, files };
  } catch {
    return null;
  }
}

function projectEvidence(projectDir: string, harnessDir: string): ProjectEvidence {
  const dataDir = harnessDataDir(projectDir, harnessDir);
  const stamps = new Map<string, CompositionStamp>();
  const legacy = new Set<string>();
  const ownership = new Map<string, OwnershipRecord>();
  const held = new Map<string, HeldRecord>();
  if (!existsSync(dataDir)) return { stamps, legacy, ownership, held };
  for (const entry of readdirSync(dataDir).sort()) {
    const heldMatch = entry.match(/^plugin-held-([a-z][a-z0-9-]*)\.json$/);
    if (heldMatch) {
      const record = parseHeld(join(dataDir, entry));
      if (record && record.name === heldMatch[1]) held.set(heldMatch[1], record);
      continue;
    }
    let match = entry.match(/^plugin-compose-([a-z][a-z0-9-]*)\.json$/);
    if (match) {
      const stamp = parseStamp(join(dataDir, entry));
      if (stamp && stamp.name === match[1]) stamps.set(match[1], stamp);
      else legacy.add(match[1]);
      continue;
    }
    match = entry.match(/^plugin-owned-([a-z][a-z0-9-]*)\.json$/);
    if (match) {
      const record = parseOwnership(join(dataDir, entry));
      if (record && record.name === match[1]) ownership.set(match[1], record);
      legacy.add(match[1]);
      continue;
    }
    match = entry.match(/^plugin-contrib-([a-z][a-z0-9-]*)\.json$/);
    if (match) legacy.add(match[1]);
  }
  try {
    const graph = readJson(join(dataDir, "stage-graph.json"));
    if (Array.isArray(graph)) {
      for (const node of graph) {
        if (!node || typeof node !== "object" || Array.isArray(node)) continue;
        const plugin = (node as Record<string, unknown>).plugin;
        if (typeof plugin === "string" && SAFE_PLUGIN_KEY.test(plugin)) legacy.add(plugin);
      }
    }
  } catch {
    // A missing or unreadable graph cannot prove legacy composition.
  }
  for (const key of stamps.keys()) legacy.delete(key);
  return { stamps, legacy, ownership, held };
}

function parseHeld(path: string): HeldRecord | null {
  try {
    const value = readJson(path) as Partial<HeldRecord>;
    if (
      value.schemaVersion === 1 &&
      typeof value.name === "string" &&
      SAFE_PLUGIN_KEY.test(value.name) &&
      typeof value.version === "string" &&
      STRICT_SEMVER.test(value.version) &&
      typeof value.reason === "string"
    ) {
      return value as HeldRecord;
    }
  } catch {
    // An unreadable record says nothing; the next sync writes it again.
  }
  return null;
}

function selectedPlugins(projectDir: string, harnessDir: string): Set<string> | null {
  try {
    const parsed = readJson(join(harnessDataDir(projectDir, harnessDir), "harness.json")) as {
      plugins?: unknown;
    };
    if (!Object.hasOwn(parsed, "plugins") || !Array.isArray(parsed.plugins)) return null;
    return new Set(parsed.plugins.filter((value): value is string => typeof value === "string"));
  } catch {
    return null;
  }
}

function semverDirection(installed: string, composed: string): "upgrade" | "downgrade" | null {
  const left = installed.match(STRICT_SEMVER);
  const right = composed.match(STRICT_SEMVER);
  if (!left || !right) return null;
  for (let index = 1; index <= 3; index++) {
    const comparison = Number(left[index]) - Number(right[index]);
    if (comparison > 0) return "upgrade";
    if (comparison < 0) return "downgrade";
  }
  return null;
}

export function comparePluginState(
  inventory: PluginInventory,
  evidence: ProjectEvidence,
  selection: Set<string> | null,
): PluginStatus[] {
  const rows: PluginStatus[] = [];
  // The person kept the plugin and left its base off: a plain state, not a
  // problem.
  const paused = pausedBySelection(selection, (key) => evidence.stamps.get(key)?.base ?? null);
  const pausedStatus = (key: string, installedVersion: string | null): PluginStatus => ({
    key,
    installedVersion,
    composedVersion: evidence.stamps.get(key)?.version ?? null,
    state: "paused",
    action: "current",
    message: `paused: needs ${paused.get(key)}, which is off`,
  });
  for (const invalid of inventory.invalid) {
    rows.push({
      key: invalid.key ?? null,
      installedVersion: null,
      composedVersion: invalid.key ? evidence.stamps.get(invalid.key)?.version ?? null : null,
      state: "invalid-installed",
      action: "attention",
      message: `${invalid.message}: ${invalid.paths.join(", ")}`,
      paths: invalid.paths,
    });
  }
  const installedKeys = new Set<string>();
  const oldCopies = new Map((inventory.superseded ?? []).map((old) => [old.key, old]));
  for (const plugin of inventory.installed) {
    installedKeys.add(plugin.key);
    const oldCopy = oldCopies.get(plugin.key);
    if (oldCopy) {
      rows.push({
        key: plugin.key,
        installedVersion: plugin.version,
        composedVersion: evidence.stamps.get(plugin.key)?.version ?? null,
        state: "installed-twice",
        action: "attention",
        message: supersededWords(inventory.harness, oldCopy),
      });
      continue;
    }
    const stamp = evidence.stamps.get(plugin.key);
    const enabled = plugin.enabled && (selection === null || selection.has(plugin.key));
    const held = evidence.held.get(plugin.key);
    if (enabled && paused.has(plugin.key)) {
      rows.push(pausedStatus(plugin.key, plugin.version));
    } else if (enabled && held?.version === plugin.version) {
      rows.push(heldStatus(held, stamp?.version ?? null));
    } else if (!enabled) {
      rows.push({
        key: plugin.key,
        installedVersion: plugin.version,
        composedVersion: stamp?.version ?? null,
        state: "installed-disabled",
        action: "current",
        message: "installed, disabled",
      });
    } else if (!stamp) {
      const legacy = evidence.legacy.has(plugin.key);
      rows.push({
        key: plugin.key,
        installedVersion: plugin.version,
        composedVersion: null,
        state: legacy ? "legacy-unstamped" : "not-composed",
        action: "sync",
        message: legacy ? "composed, unstamped" : "not composed",
      });
    } else if (plugin.version !== stamp.version) {
      const direction = semverDirection(plugin.version, stamp.version);
      rows.push({
        key: plugin.key,
        installedVersion: plugin.version,
        composedVersion: stamp.version,
        state: "version-differs",
        action: "sync",
        message: direction ? `version differs (${direction})` : "version differs",
      });
    } else if (plugin.sourceHash !== stamp.sourceHash) {
      rows.push({
        key: plugin.key,
        installedVersion: plugin.version,
        composedVersion: stamp.version,
        state: "source-changed",
        action: "sync",
        message: "same-version source changed",
      });
    } else {
      rows.push({
        key: plugin.key,
        installedVersion: plugin.version,
        composedVersion: stamp.version,
        state: "current",
        action: "current",
        message: "current",
      });
    }
  }
  const composedKeys = new Set([
    ...evidence.stamps.keys(),
    ...evidence.ownership.keys(),
    ...evidence.legacy,
  ]);
  const invalidKeys = new Set(inventory.invalid.flatMap((item) => item.key ? [item.key] : []));
  // Only a full host list proves a composed plugin is gone. Without one, a
  // composed plugin the host does not show is reported as not compared:
  // nothing for the person to do, so doctor does not warn about it.
  const provedMissing = inventory.capability === "full-inventory";
  // Without a host plugin list, the record is the only sign of a plugin sync
  // could not compose.
  if (!provedMissing) for (const key of evidence.held.keys()) composedKeys.add(key);
  for (const key of [...composedKeys].sort()) {
    if (installedKeys.has(key) || invalidKeys.has(key)) continue;
    const held = provedMissing ? undefined : evidence.held.get(key);
    if (!provedMissing && paused.has(key)) {
      rows.push(pausedStatus(key, null));
      continue;
    }
    if (held) {
      rows.push(heldStatus(held, evidence.stamps.get(key)?.version ?? null));
      continue;
    }
    rows.push({
      key,
      installedVersion: null,
      composedVersion: evidence.stamps.get(key)?.version ?? null,
      state: provedMissing ? "installed-missing" : "inventory-unavailable",
      action: provedMissing ? "attention" : "current",
      message: provedMissing
        ? `installed plugin missing from your host's list; if you composed it from its folder, it keeps working and needs nothing; otherwise reinstall it in your host, or run \`${aidlcInvocation()} engine plugin sync --prune-missing\` to remove it and everything it added to this project`
        : "not compared: no host plugin list",
    });
  }
  return rows.sort((left, right) =>
    (left.key ?? "").localeCompare(right.key ?? "") || left.state.localeCompare(right.state)
  );
}

function heldStatus(held: HeldRecord, composedVersion: string | null): PluginStatus {
  return {
    key: held.name,
    installedVersion: held.version,
    composedVersion,
    state: "dependency-unmet",
    action: "attention",
    message: held.reason,
  };
}

export function collectPluginStatus(
  projectDir: string,
  harnessDir = runtimeHarnessDir(projectDir),
): { inventory: PluginInventory; statuses: PluginStatus[] } {
  const inventory = discoverPluginInventory(harnessDir, projectDir);
  const evidence = projectEvidence(projectDir, harnessDir);
  const selection = selectedPlugins(projectDir, harnessDir);
  return {
    inventory,
    statuses: comparePluginState(inventory, evidence, selection),
  };
}

function humanAction(status: PluginStatus): string {
  if (status.state === "inventory-unavailable" || status.state === "paused") return status.message;
  if (status.action === "current") return "current";
  if (status.action === "sync") return `run: ${aidlcInvocation()} engine plugin sync`;
  return `needs attention: ${status.message}`;
}

export function renderPluginStatuses(statuses: PluginStatus[], verbose = false): string {
  const headings = ["PLUGIN", "INSTALLED", "COMPOSED", "STATUS"];
  const values = statuses.map((status) => [
    status.key ?? "-",
    status.installedVersion ?? "-",
    status.composedVersion ?? "-",
    `${humanAction(status)}${verbose ? ` [${status.state}]` : ""}`,
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...values.map((row) => row[index].length))
  );
  const render = (row: string[]): string =>
    row.map((value, index) => index === row.length - 1 ? value : value.padEnd(widths[index])).join("  ");
  return `${[render(headings), ...values.map(render)].join("\n")}\n`;
}

// A file's identity is its committed text: CRLF reads as LF, so a checkout
// that turns line endings (Git for Windows' default) is no change to a plugin's
// files and never a refusal.
function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(committedTextBytes(readFileSync(path))).digest("hex")}`;
}

// Does a recorded digest still name this file? A record written before the
// committed-text rule holds the raw-bytes digest of a CRLF file (a plugin root
// that is itself a CRLF clone); identical bytes are no change either, so that
// record proves the file too. The next record is written over the committed
// text.
function recordedDigestMatches(path: string, recorded: string): boolean {
  const bytes = readFileSync(path);
  const digest = (data: Buffer): string => `sha256:${createHash("sha256").update(data).digest("hex")}`;
  return digest(committedTextBytes(bytes)) === recorded || digest(bytes) === recorded;
}

function pluginPrimitiveTargets(
  plugin: InstalledPlugin,
  projectDir: string,
  harnessDir: string,
): Array<{ path: string; source: string }> {
  const targets: Array<{ path: string; source: string }> = [];
  const mappings: Array<[string, string]> = [
    ["stages", join(harnessDir, "aidlc-common", "stages")],
    ["scopes", join(harnessDir, "scopes")],
    ["agents", join(harnessDir, "agents")],
    ["knowledge", join(harnessDir, "knowledge")],
    ["sensors", join(harnessDir, "sensors")],
    ["tools", join(harnessDir, "tools")],
  ];
  for (const [sourceDir, targetDir] of mappings) {
    const sourceRoot = join(plugin.root, sourceDir);
    for (const source of regularFiles(sourceRoot)) {
      const target = join(projectDir, targetDir, relative(sourceRoot, source));
      if (existsSync(target)) {
        targets.push({
          path: relative(projectDir, target).split(sep).join("/"),
          source,
        });
      }
    }
  }
  return targets.sort((left, right) => left.path.localeCompare(right.path));
}

function projectedSourceBytes(source: string, harnessDir: string): Buffer {
  const bytes = readFileSync(source);
  return source.endsWith(".md")
    ? Buffer.from(projectInvocationTokens(bytes.toString("utf-8"), harnessDir))
    : bytes;
}

function writeCompositionRecords(
  plugin: InstalledPlugin,
  liveProject: string,
  stagedProject: string,
  harnessDir: string,
  priorOwnedPaths: ReadonlySet<string>,
  claimedPaths: Set<string>,
): void {
  const dataDir = harnessDataDir(stagedProject, harnessDir);
  mkdirSync(dataDir, { recursive: true });
  const files = new Map<string, OwnershipFile>();
  // The compose hook records what it installed: the files it wrote, replaced,
  // or found identical to its own harness-shaped copy, with their hashes. Keep
  // that record. Rebuilding it from byte-equality with the plugin source lost
  // every file a harness reshapes at install (a Kiro, Cursor, OpenCode, or
  // Copilot agent), so the plugin's next update of that file was refused.
  const composed = parseOwnership(join(dataDir, `plugin-owned-${plugin.key}.json`));
  if (composed && composed.name === plugin.key) {
    for (const file of composed.files) {
      if (claimedPaths.has(file.path)) continue;
      const target = assertOwnedPath(stagedProject, file.path);
      if (
        !existsSync(target) ||
        !lstatSync(target).isFile() ||
        !recordedDigestMatches(target, file.sha256)
      ) continue;
      files.set(file.path, { path: file.path, sha256: sha256File(target) });
      claimedPaths.add(file.path);
    }
  } else {
    // A plugin whose vendored compose hook predates the record: prove
    // ownership from the source bytes.
    for (const candidate of pluginPrimitiveTargets(plugin, stagedProject, harnessDir)) {
      if (claimedPaths.has(candidate.path)) continue;
      const target = join(stagedProject, candidate.path);
      const projected = committedTextBytes(projectedSourceBytes(candidate.source, harnessDir));
      if (
        !lstatSync(target).isFile() ||
        !committedTextBytes(readFileSync(target)).equals(projected)
      ) continue;
      const liveTarget = join(liveProject, candidate.path);
      const legacyMatch = existsSync(liveTarget) &&
        lstatSync(liveTarget).isFile() &&
        committedTextBytes(readFileSync(liveTarget)).equals(projected);
      if (existsSync(liveTarget) && !legacyMatch && !priorOwnedPaths.has(candidate.path)) continue;
      files.set(candidate.path, {
        path: candidate.path,
        sha256: sha256File(target),
      });
      claimedPaths.add(candidate.path);
    }
  }
  const ownership: OwnershipRecord = {
    schemaVersion: 1,
    name: plugin.key,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const commands = ownedCommands(plugin, new Set(files.keys()), harnessDir);
  const stamp: CompositionStamp = {
    schemaVersion: 1,
    name: plugin.key,
    version: plugin.version,
    sourceHash: plugin.sourceHash,
    ...(plugin.base ? { base: plugin.base.name } : {}),
    ...(Object.keys(commands).length > 0 ? { commands } : {}),
  };
  writeFileSync(
    join(dataDir, `plugin-owned-${plugin.key}.json`),
    `${JSON.stringify(ownership, null, 2)}\n`,
  );
  writeFileSync(
    join(dataDir, `plugin-compose-${plugin.key}.json`),
    `${JSON.stringify(stamp, null, 2)}\n`,
  );
}

// The plugin commands this run does not add, written into each composed
// plugin's stamp, and the line for each one the previous stamp did not record:
// said once by the sync that meets it, as a held plugin is.
function recordSkippedCommands(
  plugins: InstalledPlugin[],
  stagedData: string,
  evidence: ProjectEvidence,
): string[] {
  const table = projectPluginCommands({ pluginsEnabled, validScopes }, stagedData);
  const lines: string[] = [];
  for (const plugin of plugins) {
    const path = join(stagedData, `plugin-compose-${plugin.key}.json`);
    const stamp = parseStamp(path);
    if (stamp === null) continue;
    const skips = table.skipped.filter((skip) => skip.plugin === plugin.key);
    const said = new Set(evidence.stamps.get(plugin.key)?.skippedCommands ?? []);
    for (const skip of skips) if (!said.has(skip.name)) lines.push(skippedCommandLine(skip));
    const { skippedCommands: _previous, ...rest } = stamp;
    const next: CompositionStamp = skips.length > 0 ? { ...rest, skippedCommands: skips.map((skip) => skip.name) } : rest;
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  return lines;
}

function firstLinkInside(
  directory: string,
  own: (name: string) => boolean = () => true,
): string | null {
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory).sort()) {
    if (!own(entry)) continue;
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return path;
    if (stat.isDirectory()) {
      const nested = firstLinkInside(path);
      if (nested !== null) return nested;
    }
  }
  return null;
}

// A staged run reads AI-DLC's own folders and writes them back. A link on the
// way to one, or anywhere inside one, would take what it reads or writes
// outside this project, so the command stops before anything changes.
function refuseLinkedOwnFolders(projectDir: string, harnessDir: string): void {
  const location = { mutable: true, projectDir, harnessDir };
  const refuse = (folder: string, own?: (name: string) => boolean): void => {
    refuseLinkOnTheWay(projectDir, folder);
    const inside = firstLinkInside(folder, own);
    if (inside !== null) throw new LinkedFolderError(relative(projectDir, inside));
  };
  for (const name of ["tools", "aidlc-common", "scopes", "sensors"]) {
    refuse(resolveHarnessPath([name], location));
  }
  refuse(join(projectDir, "aidlc"));
  // A person keeps their own agents and skills beside AI-DLC's.
  const aidlcNamed = (name: string): boolean => name.startsWith("aidlc");
  refuse(resolveHarnessPath(["agents"], location), aidlcNamed);
  refuse(resolveSkillsPath([], location), aidlcNamed);
}

export function copyProjectSurfaces(
  projectDir: string,
  stagedProject: string,
  harnessDir: string,
): void {
  refuseLinkedOwnFolders(projectDir, harnessDir);
  mkdirSync(stagedProject, { recursive: true });
  for (const entry of [harnessDir, ".agents", ".github", ".opencode", "aidlc"]) {
    const source = join(projectDir, entry);
    // No link reaches the staged copy, so nothing a staged step writes can
    // land outside it. A person's own link (a skill of theirs, say) stays as
    // it is, and the plan refuses a write that would go through it.
    if (existsSync(source)) {
      cpSync(source, join(stagedProject, entry), {
        recursive: true,
        filter: (path) => !lstatSync(path).isSymbolicLink(),
      });
    }
  }
}

function composeEnvironment(
  projectDir: string,
  harnessDir: string,
  plugin: InstalledPlugin,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AIDLC_PROJECT_DIR: projectDir,
    CLAUDE_PROJECT_DIR: projectDir,
    AIDLC_HARNESS_DIR: harnessDir,
    AIDLC_PLUGIN_KEY: plugin.key,
    AIDLC_PLUGIN_RULES_BY_SYNC: "1",
    AIDLC_PLUGIN_ROOT: plugin.root,
    CLAUDE_PLUGIN_ROOT: plugin.root,
    PLUGIN_ROOT: plugin.root,
  };
}

async function runComposer(
  plugin: InstalledPlugin,
  stagedProject: string,
  harnessDir: string,
): Promise<void> {
  const composePath = join(plugin.root, "hooks", "compose.ts");
  if (!existsSync(composePath)) {
    throw new Error(`${composePath}: installed plugin has no compose hook`);
  }
  const executable = compiledExecutable();
  const env = composeEnvironment(stagedProject, harnessDir, plugin);
  if (executable) {
    const keys = [
      "AIDLC_PROJECT_DIR",
      "CLAUDE_PROJECT_DIR",
      "AIDLC_HARNESS_DIR",
      "AIDLC_PLUGIN_KEY",
      "AIDLC_PLUGIN_RULES_BY_SYNC",
      "AIDLC_PLUGIN_ROOT",
      "CLAUDE_PLUGIN_ROOT",
      "PLUGIN_ROOT",
      "AIDLC_COMPILED_EXECUTABLE",
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    Object.assign(process.env, env, { AIDLC_COMPILED_EXECUTABLE: executable });
    try {
      const module = await import(`${pathToFileURL(composePath).href}?aidlc=${Date.now()}-${plugin.key}`) as {
        compose?: () => void | Promise<void>;
      };
      if (typeof module.compose !== "function") {
        throw new Error(`${composePath}: compose.ts does not export compose()`);
      }
      await module.compose();
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  } else {
    const result = spawnSync(process.execPath, [composePath], {
      cwd: stagedProject,
      encoding: "utf-8",
      env,
    });
    if (result.status !== 0) {
      throw new Error(
        `${composePath}: ${(result.stderr || result.stdout || `exit ${result.status ?? 1}`).trim()}`,
      );
    }
  }
  const retryMarker = join(stagedProject, "aidlc", `.plugin-compose-retry-${plugin.key}`);
  if (existsSync(retryMarker)) {
    throw new Error(`plugin ${plugin.key} composition did not complete; retry marker remains`);
  }
  const drops: string[] = [];
  const aidlcRoot = join(stagedProject, "aidlc");
  if (existsSync(aidlcRoot)) {
    for (const file of surfaceFiles(aidlcRoot)) {
      if (basename(file) !== `plugin-compose-${plugin.key}.drops`) continue;
      // The staged drops file is gone with the staging directory, so the
      // error carries the reasons themselves.
      for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
        const degraded = line.match(/\t\[degraded\] (.+)$/);
        if (degraded) drops.push(degraded[1]);
      }
    }
  }
  if (drops.length > 0) {
    throw new Error(`plugin ${plugin.key} composition reported degraded drops: ${drops.join("; ")}`);
  }
  if (pluginSourceHash(plugin.root) !== plugin.sourceHash) {
    throw new Error(`plugin ${plugin.key} source changed during composition`);
  }
}

function assertOwnedPath(projectDir: string, path: string): string {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`ownership record contains unsafe path: ${path}`);
  }
  const target = resolve(projectDir, path);
  const rel = relative(projectDir, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`ownership record escapes the project: ${path}`);
  }
  return target;
}

// Cuts the sentinel-marked fragment block at [start, end) together with the
// separator compose inserted with it, and nothing else, so the file's own
// whitespace survives. Compose wraps the blocks at one insertion point in a
// newline on each side and joins them with a blank line: a block owns the
// blank line to the block after it, else the one from the block before it,
// else its two surrounding newlines.
export function cutPluginFragment(content: string, start: number, end: number): string {
  if (content.startsWith("\n\n<!-- plugin:", end)) return content.slice(0, start) + content.slice(end + 2);
  const before = content.slice(0, start);
  const previousClose = before.lastIndexOf("<!-- /plugin:");
  if (previousClose !== -1 && /^<!-- \/plugin:[^\n]* -->\n\n$/.test(before.slice(previousClose))) {
    return content.slice(0, start - 2) + content.slice(end);
  }
  const from = content[start - 1] === "\n" ? start - 1 : start;
  const to = content[end] === "\n" ? end + 1 : end;
  return content.slice(0, from) + content.slice(to);
}

// The harness-native twins compose keeps in step with a core persona, as
// project-relative paths: the files a harness's own dispatch reads instead of
// the Markdown persona (the Codex agent TOML, the opencode and Copilot native
// agents), and the Kiro IDE persona without its tool permissions, which the
// inline lead reads. Kiro CLI's agent JSON loads its prompt from the Markdown
// persona, and the other harnesses dispatch from it directly.
export function personaTwinRels(harness: string, harnessDir: string, slug: string): string[] {
  if (harness === "codex") return [`${harnessDir}/agents/${slug}.toml`];
  if (harness === "opencode") return [`.opencode/agents/${slug}.md`];
  if (harness === "copilot") return [`.github/agents/${slug}.md`];
  if (harness === "kiro-ide") return [`${harnessDir}/aidlc-common/personas/${slug}.md`];
  return [];
}

// A Codex twin holds the persona in one TOML multi-line basic string
// (developer_instructions). Fragment work runs on that string's text, so every
// anchor resolves inside it; null when the file has no such string.
export function editTomlInstructions(content: string, edit: (body: string) => string): string | null {
  const open = /^developer_instructions = """\n/m.exec(content);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = content.indexOf('"""', start);
  if (end === -1 || content[end - 1] !== "\n") return null;
  const body = edit(content.slice(start, end));
  return content.slice(0, start) + (body.endsWith("\n") ? body : `${body}\n`) + content.slice(end);
}

// Fragment text inside that string as TOML reads it: compose escapes a
// backslash and a run of three quotes there.
export function tomlFragmentText(raw: string): string {
  return raw.replace(/\\(["\\])/g, "$1");
}

// --- a plugin's recorded additions -------------------------------------------
// What compose merged into core stages and personas, as its sidecar
// (tools/data/plugin-contrib-<key>.json) records it. One check reads it against
// the files: doctor's Composed plugin surface row names every gap, and sync
// composes the plugin again when an addition is gone.

export interface ConsumeContribRecord {
  artifact: string;
  required: boolean;
  conditional_on?: string;
}

export interface StageContribRecord {
  produces?: string[];
  sensors?: string[];
  consumes?: Array<string | ConsumeContribRecord>;
  scopes?: string[];
  requires_stage?: string[];
  required_sections?: string[];
  required_sections_created?: boolean;
  fragments?: Array<{ anchor: string; order: number; hash: string }>;
}

// The one strip of a record's structural adds from a stage's LF text, for a
// plugin turned off (`stripPluginsTurnedOff()` in aidlc-utility.ts), removed or
// updated (`pruneContributions`), and the config refresh's test of a composed
// file (aidlc-init.ts). Fragments carry their own markers, and each caller
// strips them in its own scope.
export function stripRecordedAdds(content: string, record: StageContribRecord): string {
  let value = content;
  for (const field of ["produces", "sensors", "scopes", "requires_stage"] as const) {
    const items = record[field];
    if (items?.length) value = removeRecordedValues(value, field, new Set(items), false);
  }
  if (record.produces?.length) value = removeOrphanProducesKinds(value, record.produces);
  if (record.consumes?.length) {
    const artifacts = record.consumes.flatMap((entry) =>
      typeof entry === "string"
        ? [entry]
        : entry && typeof entry.artifact === "string"
          ? [entry.artifact]
          : []
    );
    value = removeRecordedConsumes(value, new Set(artifacts));
  }
  if (record.required_sections?.length) {
    value = removeRecordedValues(
      value,
      "required_sections",
      new Set(record.required_sections),
      record.required_sections_created === true,
    );
  }
  return value;
}

// Remove recorded values from a `field:` block. An emptied block collapses to
// the inline `field: []` form (the shape compose's merge expanded from); a
// created-by-compose required_sections field is deleted outright.
function removeRecordedValues(content: string, field: string, values: ReadonlySet<string>, dropEmptyField: boolean): string {
  const blockRe = new RegExp(`^${field}:\\n((?:  - .+\\n)*)`, "m");
  const m = content.match(blockRe);
  if (!m) return content;
  const entries = [...m[1].matchAll(/^ {2}- (.+)$/gm)].map((x) => x[1]);
  const removeIndexes = new Set<number>();
  const remaining = new Set(values);
  // Compose renders ordinary structural additions unquoted. Prefer that exact
  // spelling so a legacy sidecar cannot remove an equivalent quoted membership
  // that predated the plugin.
  for (let i = 0; i < entries.length; i++) {
    if (remaining.delete(entries[i].trim())) removeIndexes.add(i);
  }
  // required_sections are rendered quoted while their sidecar values are bare.
  // Remove at most one canonical match for each recorded addition.
  for (const value of remaining) {
    const index = entries.findIndex((entry, i) => {
      if (removeIndexes.has(i)) return false;
      const bare = entry.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      return bare === value;
    });
    if (index !== -1) removeIndexes.add(index);
  }
  const kept = entries.filter((_, i) => !removeIndexes.has(i));
  const replacement = kept.length > 0
    ? `${field}:\n${kept.map((v) => `  - ${v}`).join("\n")}\n`
    : dropEmptyField ? "" : `${field}: []\n`;
  return content.replace(blockRe, replacement);
}

function removeRecordedConsumes(content: string, artifacts: ReadonlySet<string>): string {
  const blockRe = /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m;
  const m = content.match(blockRe);
  if (!m) return content;
  const kept = [...m[1].matchAll(/^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm)]
    .filter((entry) => !artifacts.has(entry[1]))
    .map((entry) => entry[0]);
  const replacement = kept.length > 0 ? `consumes:\n${kept.join("")}` : "consumes: []\n";
  return content.replace(blockRe, replacement);
}

// A recorded target's file, read as compose wrote it (CRLF reads as LF): a stage
// source, or a persona with the native twins compose keeps in step with it. A
// twin that is gone or unreadable keeps its entry with null content.
export interface ContributionSource {
  path: string;
  content: string;
  parsed: Record<string, unknown>;
  kind: "stage" | "agent";
  twins?: Array<{ path: string; rel: string; content: string | null; toml: boolean }>;
}

export function contributionSources(
  stagesRoot: string,
  personasRoot: string,
  projectDir: string,
  harness: string,
  harnessDir: string,
): Map<string, ContributionSource> {
  const sources = new Map<string, ContributionSource>();
  if (existsSync(personasRoot)) {
    for (const file of readdirSync(personasRoot).filter((name) => name.endsWith(".md")).sort()) {
      const slug = file.replace(/\.md$/, "");
      try {
        const twins = personaTwinRels(harness, harnessDir, slug).map((rel) => {
          const path = join(projectDir, rel);
          let content: string | null = null;
          try {
            content = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
          } catch {
            // Gone or unreadable: the twin is named when a fragment is recorded for it.
          }
          return { path, rel, content, toml: rel.endsWith(".toml") };
        });
        const path = join(personasRoot, file);
        sources.set(slug, {
          path,
          content: readFileSync(path, "utf-8").replace(/\r\n/g, "\n"),
          parsed: {},
          kind: "agent",
          twins,
        });
      } catch {
        // An unreadable persona surfaces through doctor's agent roster checks.
      }
    }
  }
  for (const phase of PHASES) {
    const dir = join(stagesRoot, phase);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md")).sort()) {
      const path = join(dir, file);
      try {
        const content = readFileSync(path, "utf-8").replace(/\r\n/g, "\n");
        const parsed = parseStageFrontmatter(content) as Record<string, unknown>;
        const slug = typeof parsed.slug === "string" ? parsed.slug : file.replace(/\.md$/, "");
        sources.set(slug, { path, content, parsed, kind: "stage" });
      } catch {
        // A stage that does not parse surfaces through doctor's compile checks.
      }
    }
  }
  return sources;
}

export function fragmentProseHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Every recorded addition missing from one file, as doctor names it, and
// whether one of them is gone: a structural value or a fragment's markers
// absent, or a fragment holding a marker of its own plugin (a release whose
// refresh merge nested the blocks that share an anchor). A fragment whose
// markers are in place but whose text differs is a person's edit: it is
// missing, but not gone, so on its own it does not make sync compose again.
// When another addition is gone, the whole-plugin compose rewrites the plugin's
// fragments, the edited one included, as a plugin update does.
export function recordedContributionGaps(
  parsed: Record<string, unknown>,
  content: string,
  plugin: string,
  record: StageContribRecord,
  // How a fragment's text reads back from this file (a Codex persona twin
  // holds it escaped inside a TOML string).
  fragmentText: (raw: string) => string = (raw) => raw,
): { missing: string[]; gone: boolean } {
  const missing: string[] = [];
  let gone = false;
  for (const field of ["produces", "sensors", "scopes", "requires_stage", "required_sections"] as const) {
    const recorded = record[field];
    if (!Array.isArray(recorded) || recorded.length === 0) continue;
    const present = new Set(
      (Array.isArray(parsed[field]) ? parsed[field] : [])
        .filter((value): value is string => typeof value === "string"),
    );
    const absent = recorded.filter((value) => !present.has(value));
    if (absent.length > 0) {
      missing.push(`${field}=[${absent.join(", ")}]`);
      gone = true;
    }
  }

  if (Array.isArray(record.consumes) && record.consumes.length > 0) {
    const present = (Array.isArray(parsed.consumes) ? parsed.consumes : [])
      .flatMap((entry): ConsumeContribRecord[] => {
        if (
          !isPlainObject(entry) ||
          typeof entry.artifact !== "string" ||
          typeof entry.required !== "boolean"
        ) {
          return [];
        }
        return [{
          artifact: entry.artifact,
          required: entry.required,
          ...(typeof entry.conditional_on === "string"
            ? { conditional_on: entry.conditional_on }
            : {}),
        }];
      });
    const absent = record.consumes.filter((expected) => {
      if (typeof expected === "string") {
        return !present.some((entry) => entry.artifact === expected);
      }
      return !present.some((entry) =>
        entry.artifact === expected.artifact &&
        entry.required === expected.required &&
        entry.conditional_on === expected.conditional_on
      );
    }).map((expected) =>
      typeof expected === "string"
        ? expected
        : `${expected.artifact}(required=${expected.required}${
          expected.conditional_on ? `, conditional_on=${expected.conditional_on}` : ""
        })`
    );
    if (absent.length > 0) {
      missing.push(`consumes=[${absent.join(", ")}]`);
      gone = true;
    }
  }
  if (Array.isArray(record.fragments) && record.fragments.length > 0) {
    // This plugin's own marker only: prose may quote the syntax or another plugin's marker.
    const ownMarker = new RegExp(`<!-- /?plugin:${escapeRegex(plugin)}:`);
    const absent = record.fragments.flatMap((fragment) => {
      const id = `${fragment.anchor}@${fragment.order}:${fragment.hash}`;
      const open =
        `<!-- plugin:${plugin}:${fragment.anchor}:${fragment.order}:${fragment.hash} -->`;
      const close =
        `<!-- /plugin:${plugin}:${fragment.anchor}:${fragment.order}:${fragment.hash} -->`;
      const openIdx = content.indexOf(open);
      const bodyStart = openIdx + open.length;
      const closeIdx = openIdx === -1 ? -1 : content.indexOf(close, bodyStart);
      if (closeIdx === -1) {
        gone = true;
        return [id];
      }
      const wrapped = content.slice(bodyStart, closeIdx);
      if (ownMarker.test(wrapped)) {
        gone = true;
        return [id];
      }
      if (!wrapped.startsWith("\n") || !wrapped.endsWith("\n")) return [id];
      return fragmentProseHash(fragmentText(wrapped.slice(1, -1))) === fragment.hash ? [] : [id];
    });
    if (absent.length > 0) missing.push(`fragments=[${absent.join(", ")}]`);
  }
  return { missing, gone };
}

export function contributionRecordError(value: unknown): string | undefined {
  if (!isPlainObject(value)) return "expected an object";
  let hasContribution = false;
  for (const field of ["produces", "sensors", "scopes", "requires_stage", "required_sections"] as const) {
    if (!(field in value)) continue;
    if (!Array.isArray(value[field])) return `${field} must be an array`;
    if (value[field].some((entry) => typeof entry !== "string" || entry.length === 0)) {
      return `${field} must contain non-empty strings`;
    }
    if (value[field].length > 0) hasContribution = true;
  }
  if ("consumes" in value) {
    if (!Array.isArray(value.consumes)) return "consumes must be an array";
    for (const [index, consume] of value.consumes.entries()) {
      if (typeof consume === "string") {
        if (consume.length === 0) return `consumes[${index}] must be a non-empty string`;
        continue;
      }
      if (!isPlainObject(consume)) {
        return `consumes[${index}] must be a legacy string or an object`;
      }
      if (typeof consume.artifact !== "string" || consume.artifact.length === 0) {
        return `consumes[${index}].artifact must be a non-empty string`;
      }
      if (typeof consume.required !== "boolean") {
        return `consumes[${index}].required must be a boolean`;
      }
      if (
        "conditional_on" in consume &&
        consume.conditional_on !== undefined &&
        consume.conditional_on !== "brownfield" &&
        consume.conditional_on !== "greenfield"
      ) {
        return `consumes[${index}].conditional_on must be brownfield or greenfield`;
      }
    }
    if (value.consumes.length > 0) hasContribution = true;
  }
  if (
    "required_sections_created" in value &&
    typeof value.required_sections_created !== "boolean"
  ) {
    return "required_sections_created must be a boolean";
  }
  if ("fragments" in value) {
    if (!Array.isArray(value.fragments)) return "fragments must be an array";
    const identities = new Set<string>();
    for (const [index, fragment] of value.fragments.entries()) {
      if (!isPlainObject(fragment)) return `fragments[${index}] must be an object`;
      if (
        typeof fragment.anchor !== "string" ||
        !/^\S+$/.test(fragment.anchor)
      ) {
        return `fragments[${index}].anchor must be a non-empty token`;
      }
      if (
        typeof fragment.order !== "number" ||
        !Number.isSafeInteger(fragment.order) ||
        fragment.order < 0
      ) {
        return `fragments[${index}].order must be a non-negative integer`;
      }
      if (typeof fragment.hash !== "string" || !/^[0-9a-f]{8}$/.test(fragment.hash)) {
        return `fragments[${index}].hash must be an 8-character lowercase hex hash`;
      }
      const identity = `${fragment.anchor}\0${fragment.order}`;
      if (identities.has(identity)) {
        return `fragments contains duplicate identity ${fragment.anchor}@${fragment.order}`;
      }
      identities.add(identity);
    }
    if (value.fragments.length > 0) hasContribution = true;
  }
  return hasContribution ? undefined : "record has no contributions";
}

// Runs a strip on the text as compose wrote it (LF) and hands it back in the
// file's own line endings. A Windows checkout (Git's core.autocrlf) turns a
// composed file to CRLF; stripping it as LF keeps that file's bytes, with no
// stray carriage return, so a later refresh still recognises it. A file that
// mixes line endings is stripped as it is.
export function withFileLineEndings(content: string, edit: (lf: string) => string): string {
  if (!content.includes("\r\n") || /(^|[^\r])\n/.test(content)) return edit(content);
  return edit(content.replace(/\r\n/g, "\n")).replace(/\n/g, "\r\n");
}

// The opening marker of a block a plugin composed into a file: a stage or
// persona fragment, or the plugin's rules section in a rule file.
function pluginMarkerPattern(key: string, anchor: string, flags = ""): RegExp {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<!-- plugin:${escaped}:${anchor}:\\d+:[0-9a-f]+ -->`, flags);
}

function removeFragments(content: string, key: string, path: string): string {
  const opening = pluginMarkerPattern(key, ".+?", "g");
  let output = content;
  let match = opening.exec(output);
  while (match) {
    const closing = `<!-- /${match[0].slice(5)}`;
    const end = output.indexOf(closing, match.index);
    if (end === -1) throw new Error(`${path}: unpaired plugin fragment for ${key}`);
    output = cutPluginFragment(output, match.index, end + closing.length);
    opening.lastIndex = 0;
    match = opening.exec(output);
  }
  return output;
}

// A plugin's house rules: one `##` section of its own at the end of a rule file
// (memory/<level>.md, memory/phases/<phase>.md in each space). The heading
// comes before the opening marker on purpose: the team's own writers
// (practices-promote's replaceSection, learnings' appendUnderHeading) stop at
// the next `## ` line, so whatever they add lands above the heading, never
// between the markers. The plugin's own headings are written one level down,
// so the section stays one section and no team heading can match inside it.
export type RulesLevel = "org" | "team" | "project";
export const RULES_LEVELS: readonly RulesLevel[] = ["org", "team", "project"];
const RULES_ANCHOR = "rules";
const ANY_RULES_OPENING = new RegExp(PLUGIN_RULES_OPENING.source.slice(1, -1), "g");

function rulesHeading(key: string): string {
  return `## Rules from the ${key} plugin`;
}

export function nestRulesHeadings(text: string): string {
  const lf = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = lf.split("\n");
  const kinds = markdownBlocks(lf).lines;
  const out: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const info = kinds[index];
    // A heading inside a quote or list never starts a line with `#`, so no
    // team writer reads it as a section.
    if (info?.kind !== "heading" || info.containers.length > 0) {
      out.push(line);
      continue;
    }
    const atx = /^( {0,3})(#{1,6})(?=[ \t]|$)(.*)$/.exec(line);
    if (atx) {
      out.push(`${atx[1]}${"#".repeat(Math.min(6, Math.max(3, atx[2].length + 1)))}${atx[3]}`);
      continue;
    }
    // A setext heading: its text lines and the underline share one block.
    let end = index;
    while (kinds[end + 1]?.kind === "heading" && kinds[end + 1].block === info.block) end++;
    out.push(`### ${lines.slice(index, Math.max(index + 1, end)).map((part) => part.trim()).join(" ")}`);
    index = end;
  }
  return out.join("\n");
}

export function renderRulesBlock(key: string, text: string): string {
  const body = nestRulesHeadings(text).replace(/^\n+/, "").replace(/\n+$/, "");
  const marker = `plugin:${key}:${RULES_ANCHOR}:0:${fragmentProseHash(body)}`;
  return `${rulesHeading(key)}\n<!-- ${marker} -->\n` +
    `<!-- The ${key} plugin owns this section and plugin sync rewrites it; ` +
    "put the team's own rules in team.md, outside this section. -->\n" +
    `${body}\n<!-- /${marker} -->\n`;
}

// Where a plugin's rules section sits in LF text: from its heading line (the
// line right above the opening marker) through the closing marker's newline.
function rulesBlockExtent(content: string, key: string, path: string): { start: number; end: number } | null {
  const open = pluginMarkerPattern(key, RULES_ANCHOR).exec(content);
  if (!open) return null;
  const closing = `<!-- /${open[0].slice(5)}`;
  const close = content.indexOf(closing, open.index);
  if (close === -1) throw new Error(`${path}: unpaired plugin fragment for ${key}`);
  let end = close + closing.length;
  if (content[end] === "\n") end++;
  const markerLine = content.lastIndexOf("\n", open.index - 1) + 1;
  let start = markerLine;
  if (markerLine > 0) {
    const headingLine = content.lastIndexOf("\n", markerLine - 2) + 1;
    if (content.slice(headingLine, markerLine - 1).startsWith("## ")) start = headingLine;
  }
  return { start, end };
}

function placeRulesLf(content: string, key: string, block: string, path: string): string {
  const extent = rulesBlockExtent(content, key, path);
  if (extent) return content.slice(0, extent.start) + block + content.slice(extent.end);
  // Sections sit in plugin-name order, so a plugin turned off and on again
  // comes back to the same bytes.
  let later: number | null = null;
  for (const match of content.matchAll(ANY_RULES_OPENING)) {
    if (match[1] <= key) continue;
    const found = rulesBlockExtent(content, match[1], path);
    if (found && (later === null || found.start < later)) later = found.start;
  }
  if (later !== null) return `${content.slice(0, later)}${block}\n${content.slice(later)}`;
  if (content === "") return block;
  return `${content}${content.endsWith("\n") ? "\n" : "\n\n"}${block}`;
}

function stripRulesLf(content: string, key: string, path: string): string {
  const extent = rulesBlockExtent(content, key, path);
  if (!extent) return content;
  const { start, end } = extent;
  // The blank line placed with it: the one after it when something follows,
  // else the one before it.
  if (content[end] === "\n") return content.slice(0, start) + content.slice(end + 1);
  if (start >= 2 && content.slice(start - 2, start) === "\n\n") return content.slice(0, start - 1) + content.slice(end);
  return content.slice(0, start) + content.slice(end);
}

export function placeRulesBlock(content: string, key: string, block: string, path = "rule file"): string {
  return withFileLineEndings(content, (lf) => placeRulesLf(lf, key, block, path));
}

export function stripRulesBlock(content: string, key: string, path = "rule file"): string {
  return withFileLineEndings(content, (lf) => stripRulesLf(lf, key, path));
}

// The section is there with exactly the plugin's bytes: a hand edit inside it
// is not current, so the next sync writes the plugin's text back, as its
// owner line says.
export function rulesBlockCurrent(content: string, key: string, block: string, path = "rule file"): boolean {
  let current = false;
  withFileLineEndings(content, (lf) => {
    const extent = rulesBlockExtent(lf, key, path);
    current = extent !== null && lf.slice(extent.start, extent.end) === block;
    return lf;
  });
  return current;
}

function rulesBlockText(content: string, key: string, path: string): string | null {
  let text: string | null = null;
  withFileLineEndings(content, (lf) => {
    const extent = rulesBlockExtent(lf, key, path);
    text = extent === null ? null : lf.slice(extent.start, extent.end);
    return lf;
  });
  return text;
}

// The level the plugin's rules sit at, chosen at install or left at the
// plugin's default, and the sections it placed (a space's memory-relative file
// and the sha256 of the section). One record per project, beside the rule files
// every harness in it shares, so each harness and each clone keep the level the
// person chose.
export type RulesRecord = { schemaVersion: 1; level: RulesLevel; files: Record<string, string> };

const RULE_PHASES = PHASES.filter((phase) => phase !== "initialization");

const RULES_RECORD_DIR = ["aidlc", "plugin-rules"] as const;

function rulesRecordPath(projectDir: string, key: string): string {
  return join(projectDir, ...RULES_RECORD_DIR, `${key}.json`);
}

// The plugins with a rules record in this project.
export function pluginRulesRecords(projectDir: string): string[] {
  const dir = join(projectDir, ...RULES_RECORD_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => /^[a-z][a-z0-9-]*\.json$/.test(file)).map((file) => file.slice(0, -5)).sort();
}

export function readRulesRecord(projectDir: string, key: string): RulesRecord | null {
  const path = rulesRecordPath(projectDir, key);
  if (!existsSync(path)) return null;
  try {
    const parsed = readJson(path);
    if (
      isPlainObject(parsed) && RULES_LEVELS.includes(parsed.level as RulesLevel) &&
      isPlainObject(parsed.files) && Object.values(parsed.files).every((value) => typeof value === "string")
    ) return parsed as RulesRecord;
  } catch {
    // An unreadable record is rebuilt by the next merge.
  }
  return null;
}

function writeRulesRecord(projectDir: string, key: string, record: RulesRecord): void {
  mkdirSync(join(projectDir, ...RULES_RECORD_DIR), { recursive: true });
  writeFileSync(rulesRecordPath(projectDir, key), `${JSON.stringify(record, null, 2)}\n`);
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// The rules a plugin ships: memory/rules.md for its level, and one file per
// phase. Null when it ships none.
function pluginRulesSource(root: string): { level: RulesLevel | null; files: Map<string, string> } | null {
  const memory = join(root, "memory");
  if (!existsSync(memory)) return null;
  const files = new Map<string, string>();
  if (existsSync(join(memory, "rules.md"))) files.set("rules.md", readFileSync(join(memory, "rules.md"), "utf-8"));
  for (const phase of RULE_PHASES) {
    const path = join(memory, "phases", `${phase}.md`);
    if (existsSync(path)) files.set(`phases/${phase}.md`, readFileSync(path, "utf-8"));
  }
  if (files.size === 0) return null;
  let level: RulesLevel | null = null;
  try {
    const manifest = readJson(join(root, ".aidlc-plugin", "plugin.json"));
    const declared = isPlainObject(manifest) && isPlainObject(manifest.aidlc) ? manifest.aidlc.rulesLevel : undefined;
    if (RULES_LEVELS.includes(declared as RulesLevel)) level = declared as RulesLevel;
  } catch {
    // Validate names a manifest it cannot read; the rules still land.
  }
  return { level, files };
}

function spaceMemoryDirs(projectDir: string): string[] {
  const spaces = join(projectDir, "aidlc", "spaces");
  if (!existsSync(spaces)) return [];
  return readdirSync(spaces).sort()
    .map((space) => join(spaces, space, "memory"))
    .filter((dir) => existsSync(dir) && lstatSync(dir).isDirectory());
}

// The rule files of one space a plugin's section can sit in, memory-relative.
function ruleFilesIn(memoryDir: string): string[] {
  return [...RULES_LEVELS.map((level) => `${level}.md`), ...RULE_PHASES.map((phase) => `phases/${phase}.md`)]
    .filter((rel) => existsSync(join(memoryDir, rel)) && lstatSync(join(memoryDir, rel)).isFile());
}

function rulesBlocks(key: string, source: { files: Map<string, string> }, level: RulesLevel): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const [rel, text] of source.files) {
    blocks.set(rel === "rules.md" ? `${level}.md` : rel, renderRulesBlock(key, text));
  }
  return blocks;
}

function placementLine(key: string, level: RulesLevel, files: string[]): string {
  const others = RULES_LEVELS.filter((other) => other !== level);
  const phases = files.filter((rel) => rel.startsWith("phases/"));
  const where = `${level}.md${phases.length > 0 ? ` (and ${phases.join(", ")})` : ""}`;
  return `${key}'s rules are in ${where}, in a section of their own at the end. ` +
    `To keep them in ${others.map((other) => `${other}.md`).join(" or ")} instead: ` +
    `${entrySkillInvocation()} plugin select --rules-level ${key}=${others[0]}`;
}

// The one place a plugin's rules are written into a project: every space's
// rule files get the plugin's section at the level the record names (or the
// one asked for now, or the plugin's default), and lose it from every other
// file. Returns the line to say once, when the rules are placed for the first
// time or moved; a restore or an unchanged merge says nothing.
export function mergePluginRules(
  projectDir: string,
  plugin: { key: string; root: string },
  requested?: RulesLevel,
): string | null {
  const source = pluginRulesSource(plugin.root);
  const record = readRulesRecord(projectDir, plugin.key);
  if (source === null) {
    if (record !== null) stripPluginRules(projectDir, plugin.key, false);
    return null;
  }
  const level = requested ?? record?.level ?? source.level ?? "project";
  const blocks = rulesBlocks(plugin.key, source, level);
  for (const memoryDir of spaceMemoryDirs(projectDir)) {
    for (const rel of ruleFilesIn(memoryDir)) {
      const path = join(memoryDir, rel);
      const before = readFileSync(path, "utf-8");
      const block = blocks.get(rel);
      const after = block === undefined
        ? stripRulesBlock(before, plugin.key, path)
        : placeRulesBlock(before, plugin.key, block, path);
      if (after !== before) writeFileSync(path, after);
    }
  }
  writeRulesRecord(projectDir, plugin.key, {
    schemaVersion: 1,
    level,
    files: Object.fromEntries([...blocks].map(([rel, block]) => [rel, sha256Text(block)])),
  });
  const said = source.files.has("rules.md") && (record === null || record.level !== level);
  return said ? placementLine(plugin.key, level, [...blocks.keys()]) : null;
}

// A sync a host hook runs (a session start) prints to the agent, not the
// person, so the line waits for the next step the agent speaks from in that
// chat. At a terminal the person reads it as it prints.
export function sayRulesPlacement(projectDir: string, lines: readonly string[]): void {
  if (lines.length === 0 || process.stdout.isTTY || process.env.AIDLC_PERSON_AT_TERMINAL === "1") return;
  try {
    const session = resolveInvokingSessionId(projectDir);
    if (session !== null) addPendingPersonLines(projectDir, session, lines);
  } catch {
    // The printed line still reaches the agent.
  }
}

// Best-effort: the copy is the chat's convenience, and the next session start
// or stage delivery writes it again.
export function refreshRulesCopy(projectDir: string): void {
  try {
    refreshActiveMemory(projectDir);
  } catch {
    // The rule files themselves are written.
  }
}

// The same merge for a plugin known only by its root (the utility's
// plugin-sync front, which composes in the live project): its key is the
// name in its own manifest.
export function mergePluginRulesFromRoot(
  projectDir: string,
  harnessDir: string,
  root: string,
  enabled?: (key: string) => boolean,
): string | null {
  if (!existsSync(join(root, "memory"))) return null;
  let key: unknown;
  try {
    key = (readJson(join(root, ".aidlc-plugin", "plugin.json")) as { name?: unknown }).name;
  } catch {
    return null;
  }
  if (typeof key !== "string" || !SAFE_PLUGIN_KEY.test(key)) return null;
  const selection = selectedPlugins(projectDir, harnessDir);
  if (enabled ? !enabled(key) : selection !== null && !selection.has(key)) return null;
  return mergePluginRules(projectDir, { key, root });
}

// Takes the plugin's sections out of every space. Turning it off keeps its
// record as it is (the level it sat at; its missing sections compose again once
// it is on); pruning it forgets it.
export function stripPluginRules(projectDir: string, key: string, keepLevel: boolean): boolean {
  const record = readRulesRecord(projectDir, key);
  let stripped = false;
  for (const memoryDir of spaceMemoryDirs(projectDir)) {
    for (const rel of ruleFilesIn(memoryDir)) {
      const path = join(memoryDir, rel);
      const before = readFileSync(path, "utf-8");
      const after = stripRulesBlock(before, key, path);
      if (after !== before) {
        writeFileSync(path, after);
        stripped = true;
      }
    }
  }
  if (record !== null && !keepLevel) rmSync(rulesRecordPath(projectDir, key), { force: true });
  return stripped;
}

// The same strip as writes to plan, for a refresh that commits the team's rule
// files through its own transaction: each changed file, project-relative.
export function pluginRulesStripWrites(projectDir: string, key: string): Array<{ rel: string; content: string }> {
  const writes: Array<{ rel: string; content: string }> = [];
  for (const memoryDir of spaceMemoryDirs(projectDir)) {
    for (const rel of ruleFilesIn(memoryDir)) {
      const path = join(memoryDir, rel);
      const before = readFileSync(path, "utf-8");
      const after = stripRulesBlock(before, key, path);
      if (after !== before) writes.push({ rel: relative(projectDir, path).split(sep).join("/"), content: after });
    }
  }
  return writes;
}

// The person chose another level for a plugin's rules: its section moves to
// that file in every space now, and the record keeps the choice for every
// later merge (a plugin that is off comes back there).
export function movePluginRules(projectDir: string, harnessDir: string, key: string, level: RulesLevel): string | null {
  const record = readRulesRecord(projectDir, key);
  if (record?.level === level) return null;
  const levelFile = (rel: string): boolean => RULES_LEVELS.some((other) => rel === `${other}.md`);
  const files: Record<string, string> = {};
  for (const [rel, digest] of Object.entries(record?.files ?? {})) files[levelFile(rel) ? `${level}.md` : rel] = digest;
  let moved = false;
  for (const memoryDir of spaceMemoryDirs(projectDir)) {
    for (const rel of RULES_LEVELS.map((other) => `${other}.md`)) {
      if (rel === `${level}.md`) continue;
      const from = join(memoryDir, rel);
      const to = join(memoryDir, `${level}.md`);
      if (!existsSync(from) || !existsSync(to)) continue;
      const before = readFileSync(from, "utf-8");
      const block = rulesBlockText(before, key, from);
      if (block === null) continue;
      writeFileSync(from, stripRulesBlock(before, key, from));
      writeFileSync(to, placeRulesBlock(readFileSync(to, "utf-8"), key, block.replace(/\r\n/g, "\n"), to));
      moved = true;
    }
  }
  writeRulesRecord(projectDir, key, { schemaVersion: 1, level, files });
  return moved
    ? placementLine(key, level, Object.keys(files).sort())
    : `${key}'s rules will be in ${level}.md, in a section of their own at the end, ${
      nextCompose(runtimeHarnessName(projectDir, harnessDir), key, null)
    }.`;
}

// What sync composes again for: the plugin ships rules and a space lacks its
// section with the plugin's bytes (a copy-channel refresh took it, a person
// edited inside it, or it was never placed), or it stopped shipping them.
function rulesNeedMerge(projectDir: string, plugin: InstalledPlugin, requested?: RulesLevel): boolean {
  const source = pluginRulesSource(plugin.root);
  const record = readRulesRecord(projectDir, plugin.key);
  if (source === null) return record !== null && Object.keys(record.files).length > 0;
  if (record === null || (requested !== undefined && requested !== record.level)) return true;
  const blocks = rulesBlocks(plugin.key, source, record.level);
  if (Object.keys(record.files).sort().join("\n") !== [...blocks.keys()].sort().join("\n")) return true;
  return spaceMemoryDirs(projectDir).some((memoryDir) =>
    [...blocks].some(([rel, block]) => {
      const path = join(memoryDir, rel);
      return existsSync(path) && !rulesBlockCurrent(readFileSync(path, "utf-8"), plugin.key, block, path);
    })
  );
}

// Doctor's words for a plugin's section that is not where its record says,
// from the record alone (doctor reads no plugin source).
export function rulesRecordGaps(projectDir: string, key: string): string[] {
  const record = readRulesRecord(projectDir, key);
  if (record === null) return [];
  const gaps: string[] = [];
  for (const memoryDir of spaceMemoryDirs(projectDir)) {
    for (const [rel, digest] of Object.entries(record.files).sort(([a], [b]) => a.localeCompare(b))) {
      const path = join(memoryDir, rel);
      if (!existsSync(path)) continue;
      const shown = relative(projectDir, path).split(sep).join("/");
      let text: string | null;
      try {
        text = rulesBlockText(readFileSync(path, "utf-8"), key, path);
      } catch (error) {
        gaps.push(`rules in ${shown} cannot be read (${errorMessage(error)})`);
        continue;
      }
      if (text === null) gaps.push(`rules missing from ${shown}`);
      else if (sha256Text(text) !== digest) gaps.push(`rules in ${shown} differ from the plugin's`);
    }
  }
  return gaps;
}

// A new space starts with the sections every plugin placed in the space it is
// copied from, so its next session start has nothing to compose again.
export function copyPluginRulesToSpace(projectDir: string, fromMemoryDir: string, toMemoryDir: string): void {
  for (const key of pluginRulesRecords(projectDir)) {
    const record = readRulesRecord(projectDir, key);
    if (record === null) continue;
    for (const rel of Object.keys(record.files).sort()) {
      const from = join(fromMemoryDir, rel);
      const to = join(toMemoryDir, rel);
      if (!existsSync(from) || !existsSync(to)) continue;
      const block = rulesBlockText(readFileSync(from, "utf-8"), key, from);
      if (block === null) continue;
      const before = readFileSync(to, "utf-8");
      const after = placeRulesBlock(before, key, block.replace(/\r\n/g, "\n"), to);
      if (after !== before) writeFileSync(to, after);
    }
  }
}

// `--rules-level <plugin>=<org|team|project>`, repeated or comma-joined.
export function parseRulesLevels(argv: readonly string[]): Map<string, RulesLevel> {
  const levels = new Map<string, RulesLevel>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg !== "--rules-level" && !arg.startsWith("--rules-level=")) continue;
    const value = arg === "--rules-level" ? argv[++index] : arg.slice(14);
    const pairs = value === undefined || value.startsWith("--") ? [] : value.split(",").filter(Boolean);
    if (pairs.length === 0) {
      throw new PluginUsageError("--rules-level takes <plugin>=<org|team|project>, such as --rules-level test-pro=team");
    }
    for (const pair of pairs) {
      const [key, level] = pair.split("=");
      if (!SAFE_PLUGIN_KEY.test(key ?? "") || !RULES_LEVELS.includes(level as RulesLevel)) {
        throw new PluginUsageError(
          `--rules-level takes <plugin>=<org|team|project>, such as --rules-level test-pro=team; got ${pair}`,
        );
      }
      levels.set(key, level as RulesLevel);
    }
  }
  return levels;
}

function pruneContributions(stagedProject: string, harnessDir: string, key: string): void {
  const sidecar = join(harnessDataDir(stagedProject, harnessDir), `plugin-contrib-${key}.json`);
  let records: Record<string, StageContribRecord> = {};
  if (existsSync(sidecar)) {
    try {
      const parsed = readJson(sidecar);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("sidecar is not an object");
      }
      records = parsed as typeof records;
    } catch (error) {
      throw new Error(`${sidecar}: ownership sidecar is invalid: ${errorMessage(error)}`);
    }
  }
  // Stage sources and personas both carry composed content: structural adds
  // and fragments on stages, fragments only on personas.
  const stagesRoot = join(stagedProject, harnessDir, "aidlc-common", "stages");
  const personasRoot = join(stagedProject, harnessDir, "agents");
  const composedFiles = [...regularFiles(stagesRoot), ...regularFiles(personasRoot)]
    .filter((value) => value.endsWith(".md"));
  for (const path of composedFiles) {
    const before = readFileSync(path, "utf-8");
    const after = withFileLineEndings(before, (text) => {
      const record = records[basename(path, ".md")];
      return removeFragments(record ? stripRecordedAdds(text, record) : text, key, path);
    });
    if (after !== before) writeFileSync(path, after);
  }
  // A persona's native twins carry the same fragments.
  const harness = runtimeHarnessName(stagedProject, harnessDir);
  for (const persona of regularFiles(personasRoot).filter((value) => value.endsWith(".md"))) {
    for (const rel of personaTwinRels(harness, harnessDir, basename(persona, ".md"))) {
      const twin = join(stagedProject, rel);
      if (!existsSync(twin) || !lstatSync(twin).isFile()) continue;
      const before = readFileSync(twin, "utf-8");
      const after = withFileLineEndings(before, (text) => removeFragments(text, key, twin));
      if (after !== before) writeFileSync(twin, after);
    }
  }
  rmSync(sidecar, { force: true });
}

function pruneOwnedPlugin(
  stagedProject: string,
  harnessDir: string,
  key: string,
  ownership: OwnershipRecord | undefined,
): void {
  if (!ownership) {
    throw new Error(`cannot prune ${key}: no composition ownership record proves its files`);
  }
  for (const file of ownership.files) {
    const target = assertOwnedPath(stagedProject, file.path);
    if (!existsSync(target)) continue;
    if (!lstatSync(target).isFile() || !recordedDigestMatches(target, file.sha256)) {
      throw new Error(
        `cannot prune ${key}: owned path changed since composition: ${file.path}. To keep your ` +
          `change, move that file somewhere else, then run \`${aidlcInvocation()} engine plugin sync ` +
          `--prune-missing\` again.`,
      );
    }
  }
  pruneContributions(stagedProject, harnessDir, key);
  stripPluginRules(stagedProject, key, false);
  for (const file of ownership.files) {
    rmSync(assertOwnedPath(stagedProject, file.path), { force: true });
  }
  const dataDir = harnessDataDir(stagedProject, harnessDir);
  for (const name of [`plugin-owned-${key}.json`, `plugin-compose-${key}.json`, `plugin-files-${key}.json`]) {
    rmSync(join(dataDir, name), { force: true });
  }
}

function replaceOwnedPluginPrimitives(
  stagedProject: string,
  harnessDir: string,
  key: string,
  ownership: OwnershipRecord | undefined,
  syncAgain: string,
): Set<string> {
  const ownedPaths = new Set<string>();
  if (!ownership) return ownedPaths;
  for (const file of ownership.files) {
    const target = assertOwnedPath(stagedProject, file.path);
    ownedPaths.add(file.path);
    if (!existsSync(target)) continue;
    if (!lstatSync(target).isFile() || !recordedDigestMatches(target, file.sha256)) {
      throw new Error(
        `cannot sync ${key}: owned path changed since composition: ${file.path}. To keep your ` +
          `change, move that file somewhere else, then run \`${syncAgain}\` again; it puts the plugin's own version back.`,
      );
    }
  }
  pruneContributions(stagedProject, harnessDir, key);
  for (const path of ownedPaths) {
    rmSync(assertOwnedPath(stagedProject, path), { force: true });
  }
  return ownedPaths;
}

function runStagedTool(
  stagedProject: string,
  harnessDir: string,
  tool: string,
  args: string[],
): void {
  const executable = compiledExecutable();
  const env = { ...process.env, AIDLC_PROJECT_DIR: stagedProject, AIDLC_HARNESS_DIR: harnessDir };
  const command = executable ?? process.execPath;
  const commandArgs = executable
    ? tool === "graph"
      ? ["engine", "graph", ...args]
      : args[0] === "write"
      ? ["engine", "gen", "runners", ...args.slice(1)]
      : args[0] === "scopes"
      ? ["engine", "gen", "runner-scopes", ...args.slice(1)]
      : ["engine", "gen", ...args]
    : [join(stagedProject, harnessDir, "tools", `aidlc-${tool}.ts`), ...args];
  const result = spawnSync(command, commandArgs, {
    cwd: stagedProject,
    encoding: "utf-8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `staged ${tool} ${args.join(" ")} failed: ${
        (result.stderr || result.stdout || `exit ${result.status ?? 1}`).trim()
      }`,
    );
  }
}

function regenerateAfterPrune(stagedProject: string, harnessDir: string): void {
  runStagedTool(stagedProject, harnessDir, "graph", ["compile"]);
  const skills = harnessDir === ".codex"
    ? join(stagedProject, ".agents", "skills")
    : join(stagedProject, harnessDir, "skills");
  if (existsSync(skills)) {
    runStagedTool(stagedProject, harnessDir, "runner-gen", ["write"]);
    runStagedTool(stagedProject, harnessDir, "runner-gen", ["scopes"]);
  }
  refreshGeneratedTable(stagedProject, harnessDir, "stage");
  refreshGeneratedTable(stagedProject, harnessDir, "scope");
}

function refreshGeneratedTable(
  stagedProject: string,
  harnessDir: string,
  kind: "stage" | "scope",
): void {
  const executable = compiledExecutable();
  const verb = `${kind}-table`;
  const command = executable ?? process.execPath;
  const args = executable
    ? ["engine", "gen", verb]
    : [join(stagedProject, harnessDir, "tools", "aidlc-utility.ts"), verb];
  const result = spawnSync(command, args, {
    cwd: stagedProject,
    encoding: "utf-8",
    env: {
      ...process.env,
      AIDLC_PROJECT_DIR: stagedProject,
      AIDLC_HARNESS_DIR: harnessDir,
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `staged ${verb} failed: ${
        (result.stderr || result.stdout || `exit ${result.status ?? 1}`).trim()
      }`,
    );
  }
  // The generated tables live beside the skill, out of its body.
  const skillPath = harnessDir === ".codex"
    ? join(stagedProject, ".agents", "skills", "aidlc", "tables.md")
    : join(stagedProject, harnessDir, "skills", "aidlc", "tables.md");
  if (!existsSync(skillPath)) return;
  const before = readFileSync(skillPath, "utf-8");
  const region = new RegExp(
    `<!-- BEGIN: compiled ${kind} (?:graph|grid)[^\\n]* -->[\\s\\S]*?<!-- END: compiled ${kind} (?:graph|grid) -->`,
  );
  if (!region.test(before)) {
    throw new Error(`${skillPath}: missing generated ${kind} table markers`);
  }
  const rendered = result.stdout.trim();
  writeFileSync(skillPath, before.replace(region, rendered));
}

function allSurfaceFiles(projectDir: string, harnessDir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const entry of [harnessDir, ".agents", ".github", ".opencode", "aidlc"]) {
    const root = join(projectDir, entry);
    for (const path of surfaceFiles(root)) {
      files.set(relative(projectDir, path).split(sep).join("/"), path);
    }
  }
  return files;
}

export function projectDiffPlan(
  projectDir: string,
  stagedProject: string,
  harnessDir: string,
): TransactionPlan {
  const before = allSurfaceFiles(projectDir, harnessDir);
  const after = allSurfaceFiles(stagedProject, harnessDir);
  const operations: TransactionOperation[] = [];
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const path of paths) {
    const current = before.get(path);
    const staged = after.get(path);
    if (!staged) {
      if (current) operations.push({ kind: "remove", path, expected: transactionState(current) });
      continue;
    }
    const stagedBytes = readFileSync(staged);
    if (current && readFileSync(current).equals(stagedBytes) &&
      (lstatSync(current).mode & 0o777) === (lstatSync(staged).mode & 0o777)) continue;
    refuseLinkOnTheWay(projectDir, join(projectDir, ...path.split("/")));
    operations.push(writeOperation(
      path,
      stagedBytes,
      current ? transactionState(current) : "absent",
      lstatSync(staged).mode & 0o777,
    ));
  }
  return { schemaVersion: 1, root: projectDir, operations };
}

// An upgrade can write the shipped core stages over the composed ones and keep
// the plugin's stamp and files (a copy of the new runtime over the project), or
// nest its fragments (2.11.0's own refresh merge). Only the recorded additions
// show it, so compose again. A sidecar or target that cannot be read is
// doctor's to name: composing again would not mend it.
function recordedAdditionGone(projectDir: string, harnessDir: string, key: string): boolean {
  const sidecar = join(harnessDataDir(projectDir, harnessDir), `plugin-contrib-${key}.json`);
  if (!existsSync(sidecar)) return false;
  let records: unknown;
  try {
    records = readJson(sidecar);
  } catch {
    return false;
  }
  if (!isPlainObject(records)) return false;
  const harnessRoot = join(projectDir, harnessDir);
  const sources = contributionSources(
    join(harnessRoot, "aidlc-common", "stages"),
    join(harnessRoot, "agents"),
    projectDir,
    runtimeHarnessName(projectDir, harnessDir),
    harnessDir,
  );
  return Object.entries(records).some(([target, value]) => {
    if (contributionRecordError(value) !== undefined) return false;
    const record = value as StageContribRecord;
    const source = sources.get(target);
    if (!source) return false;
    if (recordedContributionGaps(source.parsed, source.content, key, record).gone) return true;
    return (source.twins ?? []).some((twin) =>
      twin.content !== null &&
      recordedContributionGaps({}, twin.content, key, { fragments: record.fragments }, twin.toml ? tomlFragmentText : undefined)
        .gone
    );
  });
}

function compositionIsCurrent(
  plugin: InstalledPlugin,
  evidence: ProjectEvidence,
  projectDir: string,
  harnessDir: string,
  selection: ReadonlySet<string> | null,
): boolean {
  const stamp = evidence.stamps.get(plugin.key);
  if (
    !stamp ||
    stamp.version !== plugin.version ||
    stamp.sourceHash !== plugin.sourceHash ||
    (stamp.base ?? null) !== (plugin.base?.name ?? null)
  ) return false;
  // Turning a plugin off strips what it merged into core stages and removes
  // its record of that, so when it is on again its compose merges it back. A
  // plugin that is off merges nothing, so it has no record to miss.
  if (
    (selection === null || selection.has(plugin.key)) &&
    regularFiles(join(plugin.root, "contributions")).some((path) => path.endsWith(".md")) &&
    !existsSync(join(harnessDataDir(projectDir, harnessDir), `plugin-contrib-${plugin.key}.json`))
  ) return false;
  if ((selection === null || selection.has(plugin.key)) && recordedAdditionGone(projectDir, harnessDir, plugin.key)) {
    return false;
  }
  if ((selection === null || selection.has(plugin.key)) && rulesNeedMerge(projectDir, plugin)) return false;
  const ownership = evidence.ownership.get(plugin.key);
  if (!ownership) return false;
  // A project composed before a plugin's commands were recorded records them.
  if (!sameCommands(stamp.commands, ownedCommands(plugin, new Set(ownership.files.map((file) => file.path)), harnessDir))) {
    return false;
  }
  return ownership.files.every((file) => {
    const target = assertOwnedPath(projectDir, file.path);
    return existsSync(target) &&
      lstatSync(target).isFile() &&
      sha256File(target) === file.sha256;
  });
}

// The person asked for --prune-missing, so at a terminal it says what goes and
// how to get it back, then prunes. A script or an agent passes --yes.
// A command used the wrong way, which exits 2 like every other usage refusal.
class PluginUsageError extends Error {}

export function announcePrune(
  argv: string[],
  keys: string[],
  input: { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = argv.includes("--json") ? process.stderr : process.stdout,
): void {
  if (keys.length === 0 || argv.includes("--yes")) return;
  if (!input.isTTY) {
    throw new PluginUsageError("plugin sync --prune-missing requires --yes in non-interactive mode");
  }
  output.write(
    `Pruning missing plugin(s) ${keys.join(", ")}: removing the files they added to this project ` +
      "and their additions to stage files. To get them back, reinstall " +
      `the plugin(s) in your host, then run ${aidlcInvocation()} engine plugin sync.\n`,
  );
}

// A base not composed in this run: here at a version (installed, or composed
// in this project), with the base it builds on itself, if any, and its stage
// slugs when known; missing and why; or turned off for this project, which
// pauses the plugin built on it.
export type BaseView =
  | { kind: "here"; version: string; where: string; base: string | null; stages: ReadonlySet<string> | null }
  | { kind: "missing"; why: "not-installed" | "host-disabled" | "not-in-project" }
  | { kind: "off" };

export type HeldPlugin = { plugin: InstalledPlugin; reason: string };

// What a held line needs to know about the host: its name, and which harness
// this is, for when a waiting plugin composes.
export type HeldWords = { hostName: string; harnessName: string };

// Claude Code and Codex list the plugins installed in them; no other host does.
export function hostListsPlugins(harnessName: string): boolean {
  return harnessName === "claude" || harnessName === "codex";
}

// The command that composes `key` again, for every line that sends the
// person to sync. A host that lists its plugins (Claude Code, Codex) finds
// them itself; elsewhere sync needs the plugin's folder (`root`, when the
// tool knows it). A tool acts on its own harness folder and the native aidlc
// on the one whose tool runs it, else the first one installed here, so where
// the target `harnessDir` is not the first it is told which, as the plugin
// hooks do.
export function syncCommand(
  harnessName: string,
  key: string,
  root: string | null,
  harnessDir = runtimeHarnessDir(),
): string {
  const invocation = aidlcInvocation();
  const first = discoverProjectHarnesses(runtimeProjectDir())[0]?.harnessDir;
  const named = harnessDir !== runtimeHarnessDir() ||
    (invocation === "aidlc" && first !== undefined && first !== harnessDir);
  const sync = `${invocation} engine plugin sync${named ? ` --harness-dir ${harnessDir}` : ""}`;
  if (hostListsPlugins(harnessName)) return sync;
  return `${sync} --plugin-root ${root === null ? `<${key}'s folder>` : quoteCommandArgument(root)}`;
}

// The line for a sync with no plugin folder on a host with no plugin list:
// one command for each plugin composed here. Null where the host lists them.
export function noPluginListLine(projectDir: string, harnessDir: string): string | null {
  const harnessName = runtimeHarnessName(projectDir, harnessDir);
  if (hostListsPlugins(harnessName)) return null;
  const keys = [...projectEvidence(projectDir, harnessDir).stamps.keys()].sort();
  const commands = (keys.length > 0 ? keys : ["plugin"]).map((key) => `\`${syncCommand(harnessName, key, null)}\``);
  return `Nothing synced: this tool keeps no list of your plugins, so name each one's folder: ${commands.join(", ")}.`;
}

// When a plugin composes next, for every line that says so. Kiro CLI and
// opencode run no compose hook (opencode reads no hooks.json), so there it is
// when the person runs sync, after `base` when the plugin waits for one.
export function nextCompose(
  harnessName: string,
  key: string,
  root: string | null,
  base?: string,
  harnessDir?: string,
): string {
  if (harnessName !== "kiro" && harnessName !== "opencode") return "at the next session start";
  return `when you run \`${syncCommand(harnessName, key, root, harnessDir)}\`` +
    (base === undefined ? "" : ` after ${base} composes`);
}

type HeldProblem =
  | { kind: "missing"; base: PluginDependency; why: "not-installed" | "host-disabled" | "not-in-project" }
  | { kind: "deep"; base: string; baseOfBase: string }
  | { kind: "range"; base: PluginDependency; version: string; where: string }
  | { kind: "include"; base: string; version: string; missing: Array<{ scope: string; stages: string[] }> }
  | Exclude<InstalledPlugin["baseProblem"], null>;

// Every held line is built here: what happened to the plugin, why, and the
// one step that is the person's.
function heldLine(
  plugin: InstalledPlugin,
  problem: HeldProblem,
  composedVersion: string | null,
  words: HeldWords,
): string {
  const key = plugin.key;
  const needs = (base: PluginDependency): string =>
    base.range === null ? base.name : `${base.name} ${base.range}`;
  const listed = (items: string[]): string =>
    items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
  const it = problem.kind === "include" &&
      new Set(problem.missing.flatMap(({ stages }) => stages)).size > 1
    ? "them"
    : "it";
  const [why, step] = problem.kind === "missing"
    ? problem.why === "not-installed"
      ? [`needs ${needs(problem.base)}, which is not installed`, `Install ${problem.base.name} and ${key} composes at the next session start.`]
      : problem.why === "host-disabled"
        ? [`needs ${problem.base.name}, which is disabled in ${words.hostName}`, `Enable ${problem.base.name} there, or disable ${key}.`]
        : [
          `needs ${needs(problem.base)}, which this project does not have yet`,
          `If ${problem.base.name} is installed, ${key} composes ${nextCompose(words.harnessName, key, plugin.root, problem.base.name)}; if not, install ${problem.base.name}.`,
        ]
    : problem.kind === "deep"
      ? [`builds on ${problem.base}, which builds on ${problem.baseOfBase}`, "A plugin can build only on a base that builds on core alone."]
      : problem.kind === "range"
        ? [
          `needs ${needs(problem.base)}, and ${problem.base.name} ${problem.version} is ${problem.where}`,
          `Install a version of ${problem.base.name} in that range, or a version of ${key} made for ${problem.base.name} ${problem.version}.`,
        ]
        : problem.kind === "include"
        ? [
          `needs ${listed(problem.missing.map(({ scope, stages }) => `${listed(stages)} for its ${scope} scope`))}, which ${problem.base} ${problem.version} does not have`,
          `Install a version of ${problem.base} that has ${it}, or a version of ${key} made for ${problem.base} ${problem.version}.`,
        ]
        : problem.kind === "bases"
          ? [`names more than one base plugin (${problem.names.join(", ")})`, "A plugin builds on core and at most one base."]
          : [
            `has a .aidlc-plugin/plugin.json that cannot be read (${
              problem.kind === "shape" ? "dependencies must be an array of non-empty strings" : problem.reason
            })`,
            "Its author needs to fix that file.",
          ];
  if (composedVersion === null) return `${key} is not composed: it ${why}. ${step}`;
  // The composed scopes are this version's, so they run without what is missing.
  const without = problem.kind === "include"
    ? `, so ${listed(problem.missing.map(({ scope }) => scope))} run${problem.missing.length === 1 ? "s" : ""} without ${it}`
    : "";
  if (composedVersion === plugin.version) return `${key} stays as composed before, but it ${why}${without}. ${step}`;
  return `${key} stays at ${composedVersion} as composed before: ${key} ${plugin.version} ${why}. ${step}`;
}

// The stages a plugin's scopes include that its base does not have, by scope.
function missingIncludes(
  plugin: InstalledPlugin,
  baseStages: ReadonlySet<string>,
): Array<{ scope: string; stages: string[] }> {
  return scopeIncludes(plugin.root).flatMap(({ scope, stages }) => {
    const missing = stages.filter((stage) => !baseStages.has(stage));
    return missing.length > 0 ? [{ scope, stages: missing }] : [];
  });
}

// A composed base's stage slugs, from where its owned stage files are
// installed (<harness>/aidlc-common/stages/<phase>/<slug>.md).
function ownedStageSlugs(ownership: OwnershipRecord | undefined): ReadonlySet<string> | null {
  if (!ownership) return null;
  return new Set(ownership.files.flatMap((file) => {
    const match = file.path.match(/(?:^|\/)aidlc-common\/stages\/[^/]+\/([^/]+)\.md$/);
    return match ? [match[1]] : [];
  }));
}

// Layering is shallow on purpose: a plugin builds on core and at most one base
// plugin, and a base builds on core alone. So the order is the bases, then the
// plugins built on them, alphabetical within each, as sync always ran. A
// plugin whose base is missing, outside its range, built on another plugin or
// without a stage the plugin's scopes include, or whose manifest cannot say,
// is held with its line and never resolved; one whose base is turned off for
// this project is paused, and nothing is said.
export function layerOrder(
  plugins: InstalledPlugin[],
  baseView: (name: string) => BaseView,
  composedVersion: (key: string) => string | null,
  words: HeldWords,
): { ordered: InstalledPlugin[]; held: HeldPlugin[]; paused: InstalledPlugin[] } {
  const sorted = [...plugins].sort((left, right) => left.key.localeCompare(right.key));
  const inRun = new Map(sorted.map((plugin) => [plugin.key, plugin]));
  const bases: InstalledPlugin[] = [];
  const layered: InstalledPlugin[] = [];
  const held: HeldPlugin[] = [];
  const paused: InstalledPlugin[] = [];
  for (const plugin of sorted) {
    const base = plugin.base;
    if (plugin.baseProblem === null && base === null) {
      bases.push(plugin);
      continue;
    }
    let problem: HeldProblem | null = plugin.baseProblem;
    if (problem === null && base !== null) {
      const own = inRun.get(base.name);
      const view: BaseView = own
        ? {
          kind: "here",
          version: own.version,
          where: "installed",
          base: own.base?.name ?? null,
          stages: new Set(pluginStageSlugs(own.root)),
        }
        : baseView(base.name);
      if (view.kind === "off") {
        paused.push(plugin);
        continue;
      }
      problem = view.kind === "missing"
        ? { kind: "missing", base, why: view.why }
        : view.base !== null
          ? { kind: "deep", base: base.name, baseOfBase: view.base }
          : base.range !== null && !Bun.semver.satisfies(view.version, base.range)
            ? { kind: "range", base, version: view.version, where: view.where }
            : null;
      if (problem === null && view.kind === "here" && view.stages !== null) {
        const missing = missingIncludes(plugin, view.stages);
        if (missing.length > 0) problem = { kind: "include", base: base.name, version: view.version, missing };
      }
    }
    if (problem === null) layered.push(plugin);
    else held.push({ plugin, reason: heldLine(plugin, problem, composedVersion(plugin.key), words) });
  }
  return { ordered: [...bases, ...layered], held, paused };
}

// A session start runs every installed plugin's sync hook at the same time.
// Each sync copies the project, composes on the copy, then diffs the copy
// against the live project; a sync that commits in between makes the next
// diff undo its work (a lost update) or fail with "source changed after
// planning". One lock per project, held from the copy to the commit, keeps a
// sync from planning against a project another sync is about to change.
// The name sets this lock apart from the workspace and intent locks. It is
// passed as both intent and space so the lock never reads the active space.
const SYNC_LOCK_NAME = "plugin-sync";

// The audit lock is per process and not re-entrant, so syncs started from one
// process wait for each other here before they contend for it across processes.
const SYNC_QUEUE = new Map<string, Promise<unknown>>();

export function syncPlugins(
  projectDir: string,
  argv: string[],
  harnessDir = runtimeHarnessDir(projectDir),
): ReturnType<typeof syncPluginsLocked> {
  const key = resolve(projectDir);
  const run = (SYNC_QUEUE.get(key) ?? Promise.resolve()).then(() =>
    syncPluginsExclusive(projectDir, argv, harnessDir)
  );
  const tail = run.catch(() => undefined);
  SYNC_QUEUE.set(key, tail);
  void tail.then(() => {
    if (SYNC_QUEUE.get(key) === tail) SYNC_QUEUE.delete(key);
  });
  return run;
}

async function syncPluginsExclusive(
  projectDir: string,
  argv: string[],
  harnessDir: string,
): ReturnType<typeof syncPluginsLocked> {
  if (!acquireAuditLock(projectDir, undefined, undefined, SYNC_LOCK_NAME, SYNC_LOCK_NAME)) {
    throw new Error("plugin sync could not acquire the project plugin-sync lock");
  }
  try {
    return await syncPluginsLocked(projectDir, argv, harnessDir);
  } finally {
    releaseAuditLock(projectDir, SYNC_LOCK_NAME, SYNC_LOCK_NAME);
  }
}

async function syncPluginsLocked(
  projectDir: string,
  argv: string[],
  harnessDir: string,
  lockRetry = 0,
): Promise<{
  synced: string[];
  pruned: string[];
  operations: number;
  held: HeldRecord[];
  newlyHeld: HeldRecord[];
  paused: string[];
  superseded: string[];
  skippedCommands: string[];
  rules: string[];
}> {
  const harness = harnessKind(harnessDir, projectDir);
  const inventory = currentRoots().length > 0
    ? currentRootInventory(harness)
    : discoverPluginInventory(harnessDir, projectDir);
  const evidence = projectEvidence(projectDir, harnessDir);
  const selection = selectedPlugins(projectDir, harnessDir);
  const prune = argv.includes("--prune-missing");
  const requestedLevels = parseRulesLevels(argv);
  const rules: string[] = [];
  let plugins: InstalledPlugin[];
  let missing: string[] = [];
  let hostList: InstalledPlugin[] | null = null;
  const superseded = supersededLines(inventory);
  if (inventory.capability === "full-inventory") {
    if (inventory.invalid.length > 0) {
      throw new Error(
        `plugin sync refused: ${inventory.invalid.map((item) => `${item.message}: ${item.paths.join(", ")}`).join("; ")}`,
      );
    }
    plugins = inventory.installed.filter((plugin) =>
      plugin.enabled && (selection === null || selection.has(plugin.key))
    );
    hostList = inventory.installed;
    const installed = new Set(inventory.installed.map((plugin) => plugin.key));
    missing = [...new Set([
      ...evidence.stamps.keys(),
      ...evidence.ownership.keys(),
      ...evidence.legacy,
    ])].filter((key) => !installed.has(key)).sort();
  } else {
    if (prune) {
      throw new Error("plugin sync --prune-missing requires a proved full host inventory");
    }
    if (inventory.invalid.length > 0) {
      throw new Error(
        `plugin sync refused: ${inventory.invalid.map((item) => item.message).join("; ")}`,
      );
    }
    plugins = inventory.installed;
    if (plugins.length === 0) {
      throw new Error(
        noPluginListLine(projectDir, harnessDir) ?? "host inventory unavailable; run sync through an installed plugin's host hook",
      );
    }
    // An old aidlc-<name> copy's own hook leaves the composing to the rebuilt
    // copy the host also lists, so the two never take turns.
    if (plugins.some(hostListsUnderAidlcName)) {
      const host = discoverPluginInventory(harnessDir, projectDir);
      const rebuilt = new Set((host.superseded ?? []).map((old) => old.key));
      plugins = plugins.filter((plugin) => !hostListsUnderAidlcName(plugin) || !rebuilt.has(plugin.key));
    }
    // A host hook names only its own plugin. Where the host lists its
    // plugins, the installed base that plugin builds on composes first in the
    // same run, so the order of the hosts' hooks does not matter.
    if (plugins.some((plugin) => plugin.base !== null)) {
      const host = discoverPluginInventory(harnessDir, projectDir);
      if (host.capability === "full-inventory") {
        hostList = host.installed;
        const run = new Map(plugins.map((plugin) => [plugin.key, plugin]));
        for (const plugin of plugins) {
          const found = host.installed.find((candidate) =>
            candidate.key === plugin.base?.name && candidate.enabled &&
            (selection === null || selection.has(candidate.key))
          );
          if (found && !run.has(found.key)) run.set(found.key, found);
        }
        plugins = [...run.values()];
      }
    }
  }
  const harnessName = runtimeHarnessName(projectDir, harnessDir);
  const order = layerOrder(
    plugins,
    (name) => {
      if (selection !== null && !selection.has(name)) return { kind: "off" };
      const stamp = evidence.stamps.get(name);
      const composed: BaseView | null = stamp
        ? {
          kind: "here",
          version: stamp.version,
          where: "composed in this project",
          base: stamp.base ?? null,
          stages: ownedStageSlugs(evidence.ownership.get(name)),
        }
        : null;
      if (hostList === null) return composed ?? { kind: "missing", why: "not-in-project" };
      const found = hostList.find((plugin) => plugin.key === name);
      if (!found) return { kind: "missing", why: "not-installed" };
      return composed ?? { kind: "missing", why: "host-disabled" };
    },
    (key) => evidence.stamps.get(key)?.version ?? null,
    {
      hostName: harness === "codex" ? "Codex" : "Claude Code",
      harnessName,
    },
  );
  plugins = order.ordered;
  const held: HeldRecord[] = order.held.map(({ plugin, reason }) => ({
    schemaVersion: 1,
    name: plugin.key,
    version: plugin.version,
    reason,
  }));
  const heldNow = new Set(held.map((record) => record.name));
  // A record goes once its plugin composes; where the host lists its plugins,
  // also once the plugin is gone or no longer held.
  const staleHeld = [...evidence.held.keys()].filter((key) =>
    plugins.some((plugin) => plugin.key === key) ||
    (inventory.capability === "full-inventory" && !heldNow.has(key))
  );
  // Said once: sync says a held plugin when its record is new or changed;
  // plugin list and doctor keep showing it.
  const newlyHeld = held.filter((record) => {
    const recorded = evidence.held.get(record.name);
    return recorded?.version !== record.version || recorded.reason !== record.reason;
  });
  const paused = order.paused.map((plugin) => plugin.key);
  // A level asked for a plugin this project does not have is said, never dropped.
  const knownKeys = new Set([
    ...inventory.installed.map((plugin) => plugin.key),
    ...evidence.stamps.keys(),
    ...pluginRulesRecords(projectDir),
  ]);
  const unknownLevels = [...requestedLevels.keys()].filter((key) => !knownKeys.has(key));
  if (unknownLevels.length > 0) {
    throw new PluginUsageError(
      `--rules-level names ${unknownLevels.join(", ")}, which ${unknownLevels.length === 1 ? "is" : "are"} not installed in this project` +
        (knownKeys.size > 0 ? `; installed: ${[...knownKeys].sort().join(", ")}` : ""),
    );
  }
  const pruned = prune ? missing : [];
  announcePrune(argv, pruned);
  if (
    pruned.length === 0 &&
    staleHeld.length === 0 &&
    newlyHeld.length === 0 &&
    plugins.every((plugin) => compositionIsCurrent(plugin, evidence, projectDir, harnessDir, selection)) &&
    [...requestedLevels].every(([key, level]) => readRulesRecord(projectDir, key)?.level === level)
  ) {
    return {
      synced: plugins.map((plugin) => plugin.key).sort(),
      pruned: [],
      operations: 0,
      held,
      newlyHeld,
      paused,
      superseded,
      skippedCommands: [],
      rules: [],
    };
  }
  const stagingRoot = mkdtempSync(join(tmpdir(), "aidlc-plugin-sync-"));
  const stagedProject = join(stagingRoot, "project");
  try {
    copyProjectSurfaces(projectDir, stagedProject, harnessDir);
    const priorOwnedPaths = new Map<string, Set<string>>();
    for (const plugin of plugins) {
      priorOwnedPaths.set(
        plugin.key,
        replaceOwnedPluginPrimitives(
          stagedProject,
          harnessDir,
          plugin.key,
          evidence.ownership.get(plugin.key),
          syncCommand(harnessName, plugin.key, plugin.root),
        ),
      );
      // The staged copy carries the previous record. A current compose hook
      // writes a fresh one; a hook from before the record would leave the
      // previous one in place and it would pass for this run's. Remove it, so
      // that hook falls back to the source-bytes proof below.
      rmSync(
        join(harnessDataDir(stagedProject, harnessDir), `plugin-owned-${plugin.key}.json`),
        { force: true },
      );
      await runComposer(plugin, stagedProject, harnessDir);
      if (selection === null || selection.has(plugin.key)) {
        const line = mergePluginRules(stagedProject, plugin, requestedLevels.get(plugin.key));
        if (line !== null) rules.push(line);
      }
    }
    // A plugin that is off or paused merges nothing now: its level is kept for
    // when it is on again, and the line says so.
    const merged = new Set(plugins.filter((plugin) => selection === null || selection.has(plugin.key)).map((plugin) => plugin.key));
    for (const [key, level] of requestedLevels) {
      if (merged.has(key)) continue;
      const line = movePluginRules(stagedProject, harnessDir, key, level);
      if (line !== null) rules.push(line);
    }
    for (const key of pruned) {
      // The staged copy holds no link, so a plugin file behind one is checked
      // where it really is.
      for (const file of evidence.ownership.get(key)?.files ?? []) {
        refuseLinkOnTheWay(projectDir, assertOwnedPath(projectDir, file.path));
      }
      pruneOwnedPlugin(stagedProject, harnessDir, key, evidence.ownership.get(key));
    }
    const stagedData = harnessDataDir(stagedProject, harnessDir);
    for (const key of staleHeld) rmSync(join(stagedData, `plugin-held-${key}.json`), { force: true });
    for (const record of held) {
      mkdirSync(stagedData, { recursive: true });
      writeFileSync(join(stagedData, `plugin-held-${record.name}.json`), `${JSON.stringify(record, null, 2)}\n`);
    }
    const claimedPaths = new Set<string>();
    for (const plugin of plugins) {
      writeCompositionRecords(
        plugin,
        projectDir,
        stagedProject,
        harnessDir,
        priorOwnedPaths.get(plugin.key) ?? new Set(),
        claimedPaths,
      );
    }
    const skippedCommands = recordSkippedCommands(plugins, stagedData, evidence);
    if (pruned.length > 0) regenerateAfterPrune(stagedProject, harnessDir);
    const plan = projectDiffPlan(projectDir, stagedProject, harnessDir);
    const failAfter = Number(process.env.AIDLC_PLUGIN_SYNC_FAIL_AFTER ?? "0");
    try {
      executePlan(plan, {
        failAfter: Number.isInteger(failAfter) && failAfter > 0 ? failAfter : undefined,
      });
    } catch (error) {
      if (
        lockRetry < 3 &&
        error instanceof TransactionBusyError
      ) {
        const lockPath = join(projectDir, ".aidlc-transaction.lock");
        for (
          let attempt = 0;
          attempt < Math.ceil(DEFAULT_SUBPROCESS_TIMEOUT_MS / 50) && existsSync(lockPath);
          attempt++
        ) {
          await Bun.sleep(50);
        }
        return syncPluginsLocked(projectDir, argv, harnessDir, lockRetry + 1);
      }
      const refreshedEvidence = projectEvidence(projectDir, harnessDir);
      if (
        pruned.length === 0 &&
        plugins.every((plugin) =>
          compositionIsCurrent(plugin, refreshedEvidence, projectDir, harnessDir, selection)
        )
      ) {
        return {
          synced: plugins.map((plugin) => plugin.key).sort(),
          pruned: [],
          operations: 0,
          held,
          newlyHeld: [],
          paused,
          superseded,
          skippedCommands: [],
          rules: [],
        };
      }
      throw error;
    }
    // The chat's copy of the rules follows the rule files a plugin changed.
    if (plan.operations.some((operation) => operation.path.startsWith("aidlc/spaces/"))) refreshRulesCopy(projectDir);
    // A sync that exits 0 must leave its plugins composed; a silent miss would
    // leave a blocking gate sensor absent with nothing to tell the user.
    if (pruned.length === 0) {
      const committed = projectEvidence(projectDir, harnessDir);
      const uncomposed = plugins
        .filter((plugin) => !compositionIsCurrent(plugin, committed, projectDir, harnessDir, selection));
      if (uncomposed.length > 0) {
        const again = [...new Set(uncomposed.map((plugin) => syncCommand(harnessName, plugin.key, plugin.root)))];
        throw new Error(
          `plugin sync finished but ${uncomposed.map((plugin) => plugin.key).join(", ")} ` +
            `${uncomposed.length === 1 ? "is" : "are"} not composed; run ${again.join(", then ")} again`,
        );
      }
    }
    return {
      synced: plugins.map((plugin) => plugin.key).sort(),
      pruned,
      operations: plan.operations.length,
      held,
      newlyHeld,
      paused,
      superseded,
      skippedCommands,
      rules,
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function jsonEnvelope(
  code: number,
  message: string,
  data: unknown,
): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    ok: code === 0,
    code,
    status: code === 0 ? "ok" : code === 2 ? "usage" : "failed",
    message,
    data,
  })}\n`;
}

const PLUGIN_USAGE = "usage: aidlc engine plugin <list|sync [--prune-missing] [--rules-level <plugin>=<org|team|project>]>";

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${PLUGIN_USAGE}\n`);
    return;
  }
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  const projectDir = resolveProjectDir(flags["project-dir"]);
  try {
    if (command === "list") {
      const result = collectPluginStatus(projectDir);
      if (flags.json === "true") {
        process.stdout.write(jsonEnvelope(0, `${result.statuses.length} plugin state(s)`, result));
      } else if (flags.quiet !== "true") {
        process.stdout.write(renderPluginStatuses(result.statuses, flags.verbose === "true"));
      }
      return;
    }
    if (command === "sync") {
      // Kiro IDE's folder-dropped hook names its root here: /bin/sh and
      // cmd.exe, the shells Kiro runs hooks in, set a variable differently.
      if (flags["plugin-root"]) process.env.AIDLC_PLUGIN_ROOT = resolve(flags["plugin-root"]);
      // A plugin hook names its harness too.
      if (flags["harness-dir"]) pinNamedHarness(projectDir, flags["harness-dir"]);
      const result = await syncPlugins(projectDir, argv);
      sayRulesPlacement(projectDir, result.rules);
      const message = `plugin sync complete: ${result.synced.length} plugin(s)` +
        (result.pruned.length > 0 ? `; pruned ${result.pruned.length} missing plugin(s)` : "") +
        result.newlyHeld.map((record) => `\n${record.reason}`).join("") +
        result.skippedCommands.map((line) => `\n${line}`).join("") +
        result.superseded.map((line) => `\n${line}`).join("") +
        result.rules.map((line) => `\n${line}`).join("");
      if (flags.json === "true") process.stdout.write(jsonEnvelope(0, message, result));
      else if (flags.quiet !== "true") process.stdout.write(`${message}\n`);
      return;
    }
    // A compose hook run without sync asks the engine to write its plugin's
    // rules, the same merge sync runs.
    if (command === "rules" && flags["plugin-root"]) {
      if (flags["harness-dir"]) pinNamedHarness(projectDir, flags["harness-dir"]);
      const line = mergePluginRulesFromRoot(projectDir, runtimeHarnessDir(projectDir), resolve(flags["plugin-root"]));
      if (line !== null) {
        process.stdout.write(`${line}\n`);
        sayRulesPlacement(projectDir, [line]);
      }
      refreshRulesCopy(projectDir);
      return;
    }
    throw new Error(PLUGIN_USAGE);
  } catch (error) {
    const message = withTransactionFix(error, errorMessage(error));
    const code = error instanceof PluginUsageError ? 2 : 1;
    if (flags.json === "true") process.stdout.write(jsonEnvelope(code, message, null));
    else process.stderr.write(`aidlc engine plugin: ${message}\n`);
    process.exitCode = code;
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
