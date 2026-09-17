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
import { createInterface } from "node:readline/promises";
import {
  errorMessage,
  parseArgs,
  resolveProjectDir,
} from "./aidlc-lib.ts";
import {
  compiledExecutable,
  runtimeHarnessDir,
} from "./aidlc-runtime-paths.ts";
import {
  executePlan,
  transactionState,
  writeOperation,
  type TransactionOperation,
  type TransactionPlan,
} from "./aidlc-transaction.ts";

const SAFE_PLUGIN_KEY = /^[a-z][a-z0-9-]*$/;
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMPOSE_DIRS = [
  "agents",
  "contributions",
  "knowledge",
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
};

export type CompositionStamp = {
  schemaVersion: 1;
  name: string;
  version: string;
  sourceHash: string;
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
  | "inventory-unavailable";

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

export type ProjectEvidence = {
  stamps: Map<string, CompositionStamp>;
  legacy: Set<string>;
  ownership: Map<string, OwnershipRecord>;
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
  if (!existsSync(root)) return [];
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
  if (!hostName.startsWith("aidlc-")) {
    throw new Error(`${manifestPath}: owned plugin name must start with "aidlc-"`);
  }
  const key = hostName.slice("aidlc-".length);
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
  };
}

function currentRoots(): string[] {
  return [...new Set([
    process.env.CLAUDE_PLUGIN_ROOT,
    process.env.PLUGIN_ROOT,
    process.env.AIDLC_PLUGIN_ROOT,
  ].map((value) => value?.trim() ?? "").filter(Boolean).map(absolute))];
}

function harnessKind(harnessDir = runtimeHarnessDir()): PluginInventory["harness"] {
  const declared = process.env.AIDLC_HARNESS_NAME?.trim();
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
): { installed: InstalledPlugin[]; invalid: InvalidInstalledPlugin[] } {
  const byKey = new Map<string, InstalledPlugin[]>();
  for (const entry of entries) {
    const values = byKey.get(entry.key) ?? [];
    values.push(entry);
    byKey.set(entry.key, values);
  }
  const installed: InstalledPlugin[] = [];
  for (const [key, values] of byKey) {
    if (values.length === 1) {
      installed.push(values[0]);
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
  };
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
  };
}

function claudeInventory(): PluginInventory {
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
  let enabledPlugins: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    let settings: unknown;
    try {
      settings = readJson(settingsPath);
    } catch {
      return currentRootInventory("claude");
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      return currentRootInventory("claude");
    }
    const rawEnabled = (settings as Record<string, unknown>).enabledPlugins;
    if (rawEnabled !== undefined) {
      if (!rawEnabled || typeof rawEnabled !== "object" || Array.isArray(rawEnabled)) {
        return currentRootInventory("claude");
      }
      enabledPlugins = rawEnabled as Record<string, unknown>;
    }
  }
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
      if (!registryName.startsWith("aidlc-")) continue;
      if (!Array.isArray(rawEntries) || rawEntries.length === 0) {
        invalid.push({ paths: [registryPath], message: `Claude plugin "${id}" has no installed records` });
        continue;
      }
      for (const rawEntry of rawEntries) {
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
        if ("root" in normalized) installed.push(normalized);
        else invalid.push({ ...normalized, key: registryName.slice("aidlc-".length) });
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
    const safeSegment = (value: string): boolean =>
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..";
    if (!pluginName || !marketplace || !safeSegment(pluginName) ||
      !safeSegment(marketplace)) {
      invalid.push({ paths: [configPath], message: `Codex plugin id "${id}" is not name@marketplace` });
      continue;
    }
    if (!pluginName.startsWith("aidlc-")) continue;
    const pluginConfig = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? rawConfig as Record<string, unknown>
      : {};
    const enabled = pluginConfig.enabled !== false;
    const cacheRoot = join(codexHome, "plugins", "cache", marketplace, pluginName);
    if (!existsSync(cacheRoot)) {
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
    const normalized = invalidFromRoot(
      root,
      "codex",
      enabled,
      selectedVersion === "local" ? undefined : selectedVersion,
    );
    if ("root" in normalized) installed.push(normalized);
    else invalid.push({ ...normalized, key: pluginName.slice("aidlc-".length) });
  }
  const normalized = deduplicateInventory(installed, invalid);
  return {
    capability: "full-inventory",
    harness: "codex",
    source: configPath,
    installed: normalized.installed,
    invalid: normalized.invalid,
  };
}

export function discoverPluginInventory(harnessDir = runtimeHarnessDir()): PluginInventory {
  const harness = harnessKind(harnessDir);
  if (harness === "claude") return claudeInventory();
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
      /^sha256:[0-9a-f]{64}$/.test(value.sourceHash)
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
  if (!existsSync(dataDir)) return { stamps, legacy, ownership };
  for (const entry of readdirSync(dataDir).sort()) {
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
  return { stamps, legacy, ownership };
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
  if (inventory.capability !== "full-inventory") {
    return [{
      key: null,
      installedVersion: null,
      composedVersion: null,
      state: "inventory-unavailable",
      action: "attention",
      message: "host inventory unavailable; run sync through the host SessionStart adapter",
    }];
  }
  const rows: PluginStatus[] = [];
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
  for (const plugin of inventory.installed) {
    installedKeys.add(plugin.key);
    const stamp = evidence.stamps.get(plugin.key);
    const enabled = plugin.enabled && (selection === null || selection.has(plugin.key));
    if (!enabled) {
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
  for (const key of [...composedKeys].sort()) {
    if (installedKeys.has(key) || invalidKeys.has(key)) continue;
    rows.push({
      key,
      installedVersion: null,
      composedVersion: evidence.stamps.get(key)?.version ?? null,
      state: "installed-missing",
      action: "attention",
      message: "installed plugin missing; reinstall via host, or sync --prune-missing",
    });
  }
  return rows.sort((left, right) =>
    (left.key ?? "").localeCompare(right.key ?? "") || left.state.localeCompare(right.state)
  );
}

export function collectPluginStatus(
  projectDir: string,
  harnessDir = runtimeHarnessDir(projectDir),
): { inventory: PluginInventory; statuses: PluginStatus[] } {
  const inventory = discoverPluginInventory(harnessDir);
  const evidence = projectEvidence(projectDir, harnessDir);
  const selection = selectedPlugins(projectDir, harnessDir);
  return {
    inventory,
    statuses: comparePluginState(inventory, evidence, selection),
  };
}

function humanAction(status: PluginStatus): string {
  if (status.action === "current") return "current";
  if (status.action === "sync") return "run: aidlc config";
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

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
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
    ? Buffer.from(bytes.toString("utf-8").replaceAll("{{HARNESS_DIR}}", harnessDir))
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
  for (const candidate of pluginPrimitiveTargets(plugin, stagedProject, harnessDir)) {
    if (claimedPaths.has(candidate.path)) continue;
    const target = join(stagedProject, candidate.path);
    if (
      !lstatSync(target).isFile() ||
      !readFileSync(target).equals(projectedSourceBytes(candidate.source, harnessDir))
    ) continue;
    const liveTarget = join(liveProject, candidate.path);
    const legacyMatch = existsSync(liveTarget) &&
      lstatSync(liveTarget).isFile() &&
      readFileSync(liveTarget).equals(projectedSourceBytes(candidate.source, harnessDir));
    if (existsSync(liveTarget) && !legacyMatch && !priorOwnedPaths.has(candidate.path)) continue;
    files.set(candidate.path, {
      path: candidate.path,
      sha256: sha256File(target),
    });
    claimedPaths.add(candidate.path);
  }
  const ownership: OwnershipRecord = {
    schemaVersion: 1,
    name: plugin.key,
    files: [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const stamp: CompositionStamp = {
    schemaVersion: 1,
    name: plugin.key,
    version: plugin.version,
    sourceHash: plugin.sourceHash,
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

export function copyProjectSurfaces(
  projectDir: string,
  stagedProject: string,
  harnessDir: string,
): void {
  mkdirSync(stagedProject, { recursive: true });
  for (const entry of [harnessDir, ".agents", ".github", ".opencode", "aidlc"]) {
    const source = join(projectDir, entry);
    if (existsSync(source)) cpSync(source, join(stagedProject, entry), { recursive: true });
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
      if (
        basename(file) === `plugin-compose-${plugin.key}.drops` &&
        readFileSync(file, "utf-8").includes("[degraded]")
      ) drops.push(file);
    }
  }
  if (drops.length > 0) {
    throw new Error(`plugin ${plugin.key} composition reported degraded drops: ${drops.join(", ")}`);
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

function removeListValues(
  content: string,
  field: string,
  values: ReadonlySet<string>,
  dropEmptyField: boolean,
): string {
  const block = new RegExp(`^${field}:\\n((?:  - .+\\n)*)`, "m");
  const match = content.match(block);
  if (!match) return content;
  const kept = [...match[1].matchAll(/^ {2}- (.+)$/gm)]
    .map((entry) => entry[1])
    .filter((value) => {
      const bare = value.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      return !values.has(bare) && !values.has(value.trim());
    });
  const replacement = kept.length > 0
    ? `${field}:\n${kept.map((value) => `  - ${value}`).join("\n")}\n`
    : dropEmptyField ? "" : `${field}: []\n`;
  return content.replace(block, replacement);
}

function removeConsumes(content: string, artifacts: ReadonlySet<string>): string {
  const block = /^consumes:\n((?: {2}- artifact:.*\n(?: {4}(?:required|conditional_on):.*\n)*)*)/m;
  const match = content.match(block);
  if (!match) return content;
  const kept = [...match[1].matchAll(/^ {2}- artifact:\s*([\w-]+).*\n(?: {4}(?:required|conditional_on):.*\n)*/gm)]
    .filter((entry) => !artifacts.has(entry[1]))
    .map((entry) => entry[0]);
  return content.replace(block, kept.length > 0 ? `consumes:\n${kept.join("")}` : "consumes: []\n");
}

function removeFragments(content: string, key: string, path: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opening = new RegExp(`<!-- plugin:${escaped}:.+?:\\d+:[0-9a-f]+ -->`, "g");
  let output = content;
  let match = opening.exec(output);
  while (match) {
    const closing = `<!-- /${match[0].slice(5)}`;
    const end = output.indexOf(closing, match.index);
    if (end === -1) throw new Error(`${path}: unpaired plugin fragment for ${key}`);
    output = `${output.slice(0, match.index)}${output.slice(end + closing.length)}`
      .replace(/\n{3,}/g, "\n\n");
    opening.lastIndex = 0;
    match = opening.exec(output);
  }
  return output;
}

function pruneContributions(stagedProject: string, harnessDir: string, key: string): void {
  const sidecar = join(harnessDataDir(stagedProject, harnessDir), `plugin-contrib-${key}.json`);
  let records: Record<string, {
    produces?: string[];
    sensors?: string[];
    consumes?: string[];
    required_sections?: string[];
    required_sections_created?: boolean;
  }> = {};
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
  const stagesRoot = join(stagedProject, harnessDir, "aidlc-common", "stages");
  if (existsSync(stagesRoot)) {
    for (const path of regularFiles(stagesRoot).filter((value) => value.endsWith(".md"))) {
      const before = readFileSync(path, "utf-8");
      let after = before;
      const record = records[basename(path, ".md")];
      if (record) {
        if (record.produces?.length) after = removeListValues(after, "produces", new Set(record.produces), false);
        if (record.sensors?.length) after = removeListValues(after, "sensors", new Set(record.sensors), false);
        if (record.consumes?.length) after = removeConsumes(after, new Set(record.consumes));
        if (record.required_sections?.length) {
          after = removeListValues(
            after,
            "required_sections",
            new Set(record.required_sections),
            record.required_sections_created === true,
          );
        }
      }
      after = removeFragments(after, key, path);
      if (after !== before) writeFileSync(path, after);
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
    if (!lstatSync(target).isFile() || sha256File(target) !== file.sha256) {
      throw new Error(`cannot prune ${key}: owned path changed since composition: ${file.path}`);
    }
  }
  pruneContributions(stagedProject, harnessDir, key);
  for (const file of ownership.files) {
    rmSync(assertOwnedPath(stagedProject, file.path), { force: true });
  }
  const dataDir = harnessDataDir(stagedProject, harnessDir);
  rmSync(join(dataDir, `plugin-owned-${key}.json`), { force: true });
  rmSync(join(dataDir, `plugin-compose-${key}.json`), { force: true });
}

function replaceOwnedPluginPrimitives(
  stagedProject: string,
  harnessDir: string,
  key: string,
  ownership: OwnershipRecord | undefined,
): Set<string> {
  const ownedPaths = new Set<string>();
  if (!ownership) return ownedPaths;
  for (const file of ownership.files) {
    const target = assertOwnedPath(stagedProject, file.path);
    ownedPaths.add(file.path);
    if (!existsSync(target)) continue;
    if (!lstatSync(target).isFile() || sha256File(target) !== file.sha256) {
      throw new Error(`cannot sync ${key}: owned path changed since composition: ${file.path}`);
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
  const skillPath = harnessDir === ".codex"
    ? join(stagedProject, ".agents", "skills", "aidlc", "SKILL.md")
    : join(stagedProject, harnessDir, "skills", "aidlc", "SKILL.md");
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
    operations.push(writeOperation(
      path,
      stagedBytes,
      current ? transactionState(current) : "absent",
      lstatSync(staged).mode & 0o777,
    ));
  }
  return { schemaVersion: 1, root: projectDir, operations };
}

function compositionIsCurrent(
  plugin: InstalledPlugin,
  evidence: ProjectEvidence,
  projectDir: string,
): boolean {
  const stamp = evidence.stamps.get(plugin.key);
  if (
    !stamp ||
    stamp.version !== plugin.version ||
    stamp.sourceHash !== plugin.sourceHash
  ) return false;
  const ownership = evidence.ownership.get(plugin.key);
  if (!ownership) return false;
  return ownership.files.every((file) => {
    const target = assertOwnedPath(projectDir, file.path);
    return existsSync(target) &&
      lstatSync(target).isFile() &&
      sha256File(target) === file.sha256;
  });
}

export async function confirmPrune(
  argv: string[],
  keys: string[],
  input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  if (keys.length === 0 || argv.includes("--yes")) return;
  if (!input.isTTY) {
    throw new Error("plugin sync --prune-missing requires --yes in non-interactive mode");
  }
  const lines = createInterface({ input, output });
  let response: string;
  try {
    response = await lines.question(
      `Prune composed content for missing plugin(s) ${keys.join(", ")}? [y/N] `,
    );
  } finally {
    lines.close();
  }
  response = response.trim().toLowerCase();
  if (response !== "y" && response !== "yes") throw new Error("plugin prune cancelled");
}

export async function syncPlugins(
  projectDir: string,
  argv: string[],
  harnessDir = runtimeHarnessDir(projectDir),
  lockRetry = 0,
): Promise<{ synced: string[]; pruned: string[]; operations: number }> {
  const harness = harnessKind(harnessDir);
  const inventory = currentRoots().length > 0
    ? currentRootInventory(harness)
    : discoverPluginInventory(harnessDir);
  const evidence = projectEvidence(projectDir, harnessDir);
  const selection = selectedPlugins(projectDir, harnessDir);
  const prune = argv.includes("--prune-missing");
  let plugins: InstalledPlugin[];
  let missing: string[] = [];
  if (inventory.capability === "full-inventory") {
    if (inventory.invalid.length > 0) {
      throw new Error(
        `plugin sync refused: ${inventory.invalid.map((item) => `${item.message}: ${item.paths.join(", ")}`).join("; ")}`,
      );
    }
    plugins = inventory.installed.filter((plugin) =>
      plugin.enabled && (selection === null || selection.has(plugin.key))
    );
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
      throw new Error("host inventory unavailable; run sync through an installed plugin's host hook");
    }
  }
  const pruned = prune ? missing : [];
  await confirmPrune(argv, pruned);
  if (
    pruned.length === 0 &&
    plugins.every((plugin) => compositionIsCurrent(plugin, evidence, projectDir))
  ) {
    return {
      synced: plugins.map((plugin) => plugin.key).sort(),
      pruned: [],
      operations: 0,
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
        ),
      );
      await runComposer(plugin, stagedProject, harnessDir);
    }
    for (const key of pruned) {
      pruneOwnedPlugin(stagedProject, harnessDir, key, evidence.ownership.get(key));
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
        error instanceof Error &&
        error.message.includes("another AI-DLC mutation holds")
      ) {
        const lockPath = join(projectDir, ".aidlc-transaction.lock");
        for (let attempt = 0; attempt < 50 && existsSync(lockPath); attempt++) {
          await Bun.sleep(50);
        }
        return syncPlugins(projectDir, argv, harnessDir, lockRetry + 1);
      }
      const refreshedEvidence = projectEvidence(projectDir, harnessDir);
      if (
        pruned.length === 0 &&
        plugins.every((plugin) =>
          compositionIsCurrent(plugin, refreshedEvidence, projectDir)
        )
      ) {
        return {
          synced: plugins.map((plugin) => plugin.key).sort(),
          pruned: [],
          operations: 0,
        };
      }
      throw error;
    }
    return {
      synced: plugins.map((plugin) => plugin.key).sort(),
      pruned,
      operations: plan.operations.length,
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
    status: code === 0 ? "ok" : "failed",
    message,
    data,
  })}\n`;
}

export async function main(argv: string[]): Promise<void> {
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
      const result = await syncPlugins(projectDir, argv);
      const message = `plugin sync complete: ${result.synced.length} plugin(s)` +
        (result.pruned.length > 0 ? `; pruned ${result.pruned.length} missing plugin(s)` : "");
      if (flags.json === "true") process.stdout.write(jsonEnvelope(0, message, result));
      else if (flags.quiet !== "true") process.stdout.write(`${message}\n`);
      return;
    }
    throw new Error("usage: aidlc engine plugin <list|sync [--prune-missing]>");
  } catch (error) {
    const message = errorMessage(error);
    if (flags.json === "true") process.stdout.write(jsonEnvelope(1, message, null));
    else process.stderr.write(`aidlc engine plugin: ${message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
