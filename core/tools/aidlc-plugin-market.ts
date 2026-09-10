#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { extractTarGz } from "./aidlc-archive.ts";
import { emitResult, EXIT, failure, globalOptions, success, usage, valueAfter } from "./aidlc-command.ts";
import type { CommandResult, GlobalOptions } from "./aidlc-command.ts";
import { errorMessage, resolveProjectDir } from "./aidlc-lib.ts";
import { resolvedReleaseSettings } from "./aidlc-machine-config.ts";
import {
  archiveUrl, CATALOG_HARNESSES, catalogUrl, executableFiles, locateProjection,
  marketplaceAllowed, normalizeMarketplaceSource, parseCatalog, projectionDigest,
  readProjectionMarker, validatePluginName,
} from "./aidlc-plugin-catalog.ts";
import type { CatalogHarness, MarketplaceSource, PluginCatalog, SupersededBy } from "./aidlc-plugin-catalog.ts";
import { collectPluginStatus, MANAGED_PLUGINS_DIR, normalizeInstalledPlugin, readInstallRecord, renderPluginStatuses } from "./aidlc-plugin.ts";
import type { PluginInstallRecord } from "./aidlc-plugin.ts";
import { downloadUrl, ReleaseUnavailableError } from "./aidlc-release.ts";
import { compiledExecutable, discoverProjectHarnesses, runtimeHarnessDir } from "./aidlc-runtime-paths.ts";
import { machineSettingsPath, readSettingsTarget, resolveAidlcSettings, updateSettingsSection, writeSettingsLayer } from "./aidlc-settings.ts";
import type { PluginsSettingsRecord, ResolvedAidlcSettings, SettingsTarget } from "./aidlc-settings.ts";
import { executePlan, transactionSourceHash, transactionState, writeOperation } from "./aidlc-transaction.ts";

const USAGE = `aidlc plugin marketplaces list [--json]
aidlc plugin marketplaces add <owner/repo|url> [--name <n>] [--project|--local|--global] [--offline]
aidlc plugin marketplaces remove <name> [--project|--local|--global]
aidlc plugin search [term] [--marketplace <name>] [--json]
aidlc plugin list [--check] [--verbose] [--json] [--project-dir <p>]
aidlc plugin install <name> [--marketplace <n>] [--harness <h>] [--yes] [--json] [--project-dir <p>]
aidlc plugin update <name> [--marketplace <n>] [--harness <h>] [--yes] [--json] [--project-dir <p>]`;
const VALUE_FLAGS: Record<string, true> = { "--name": true, "--marketplace": true, "--harness": true, "--project-dir": true };
const BOOL_FLAGS: Record<string, true> = {
  "--project": true, "--local": true, "--global": true, "--offline": true,
  "--check": true, "--verbose": true, "--yes": true, "--json": true, "--quiet": true, "--no-color": true,
};
const HARNESS_DIRS: Record<CatalogHarness, string> = {
  claude: ".claude", codex: ".codex", kiro: ".kiro", "kiro-ide": ".kiro",
  cursor: ".cursor", copilot: ".aidlc", opencode: ".aidlc",
};
type Marketplace = { name: string; source: MarketplaceSource; catalog: PluginCatalog };
type Published = { version: string; marketplace: string; supersededBy?: SupersededBy };

class MarketError extends Error {
  constructor(message: string, readonly code: number = EXIT.failure, readonly remediation?: string) {
    super(message);
  }
}

function requireNetwork(verb: string, options: GlobalOptions) {
  if (process.env.AIDLC_ROUTE_NETWORK_POLICY === "forbidden") {
    throw new MarketError(`${verb} needs the network; run it as \`aidlc plugin ${verb}\`, not under \`aidlc engine\``, EXIT.unavailable);
  }
  const settings = resolvedReleaseSettings({ ...(options.offline ? { offline: true } : {}) });
  if (settings.offline) throw new MarketError(`${verb} needs the network; unavailable while offline`, EXIT.unavailable);
  return settings;
}

function githubHeaders(url: string, catalog = false): Record<string, string> {
  if (new URL(url).hostname !== "api.github.com") return {};
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    ...(catalog ? { Accept: "application/vnd.github.raw+json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchCatalog(source: MarketplaceSource, verb: string, options: GlobalOptions): Promise<PluginCatalog> {
  const settings = requireNetwork(verb, options);
  const temporary = mkdtempSync(join(tmpdir(), "aidlc-plugin-catalog-"));
  const url = catalogUrl(source);
  try {
    const path = join(temporary, "catalog.json");
    await downloadUrl(url, path, { timeoutMs: 30_000, caBundle: settings.caBundle, maxBytes: 4 * 1024 * 1024, headers: githubHeaders(url, true) });
    return parseCatalog(readFileSync(path, "utf-8"), source.url);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function fetchMarketplaces(
  settings: ResolvedAidlcSettings, selected: string | undefined, verb: string, options: GlobalOptions, tolerateFailures = false,
): Promise<Marketplace[]> {
  requireNetwork(verb, options);
  const registered = Object.entries(settings.plugins?.marketplaces ?? {});
  if (!registered.length) throw new MarketError("no marketplaces registered", EXIT.failure, "aidlc plugin marketplaces add <owner/repo|url>");
  if (selected && !registered.some(([name]) => name === selected)) throw new MarketError(`marketplace ${selected} is not registered`);
  const allowlist = settings.plugins?.allowedMarketplaces ?? [];
  const marketplaces: Marketplace[] = [];
  for (const [name, entry] of registered) {
    if (selected && name !== selected) continue;
    const source = normalizeMarketplaceSource(entry.url);
    if (!marketplaceAllowed(source.url, allowlist)) {
      const message = `marketplace ${name} is blocked by machine allowlist in ${machineSettingsPath()}`;
      if (selected) throw new MarketError(message);
      process.stderr.write(`warning: ${message}\n`);
      continue;
    }
    try {
      marketplaces.push({ name, source, catalog: await fetchCatalog(source, verb, options) });
    } catch (error) {
      if (!tolerateFailures) throw new MarketError(`marketplace ${name}: ${errorMessage(error)}`, EXIT.unavailable);
      process.stderr.write(`warning: marketplace ${name}: ${errorMessage(error)}\n`);
    }
  }
  if (!marketplaces.length) throw new MarketError("no registered marketplace could be fetched", EXIT.unavailable);
  return marketplaces;
}

function table(headings: string[], rows: string[][]): string {
  const widths = headings.map((heading, index) => Math.max(heading.length, ...rows.map((row) => row[index].length)));
  return [headings, ...rows].map((row) => row.map((cell, index) => index === row.length - 1 ? cell : cell.padEnd(widths[index])).join("  ")).join("\n");
}

async function marketplacesCommand(
  args: string[], argv: string[], projectDir: string, settings: ResolvedAidlcSettings, options: GlobalOptions,
): Promise<CommandResult> {
  const [verb, input] = args;
  const targets = (["project", "local", "global"] as const).filter((target) => argv.includes(`--${target}`));
  if (targets.length > 1) return usage("choose only one of --project, --local, --global");
  const target: SettingsTarget = targets[0] ?? "project";
  const layer = target === "global" ? "machine" : target;
  const allowlist = settings.plugins?.allowedMarketplaces ?? [];
  if (verb === "list" && args.length === 1) {
    const rows = Object.entries(settings.plugins?.marketplaces ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, entry]) => ({
      name, url: entry.url, layer: settings.sources[`plugins.marketplaces.${name}`], blocked: !marketplaceAllowed(entry.url, allowlist),
    }));
    const message = table(["NAME", "URL", "LAYER"], rows.map((row) => [row.name, row.url, `${row.layer}${row.blocked ? " (blocked by machine allowlist)" : ""}`])) +
      (allowlist.length ? `\nallowlist (machine): ${allowlist.length} entr(ies)` : "");
    return success(message, { marketplaces: rows, allowedMarketplaces: allowlist });
  }
  if (args.length !== 2 || !input || (verb !== "add" && verb !== "remove")) return usage("expected marketplaces list, add <source>, or remove <name>", USAGE);
  if (verb === "add") {
    const source = normalizeMarketplaceSource(input);
    const name = valueAfter(argv, "--name") ?? source.defaultName;
    if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) return usage("marketplace needs a kebab-case name; pass --name <name>");
    if (!marketplaceAllowed(source.url, allowlist)) throw new MarketError(`marketplace ${source.url} is blocked by machine allowlist in ${machineSettingsPath()}`);
    const registered = readSettingsTarget(projectDir, target)?.plugins?.marketplaces?.[name];
    if (registered && registered.url !== source.url) throw new MarketError(`marketplace ${name} is already registered with a different URL in ${layer}`);
    // Explicit --offline is registration-only: no catalog bytes are trusted or installed.
    if (!argv.includes("--offline")) {
      try { await fetchCatalog(source, "marketplaces add", options); }
      catch (error) { throw new MarketError(errorMessage(error), EXIT.unavailable); }
    }
    writeSettingsLayer(projectDir, target, (current) => {
      const existing = current?.plugins?.marketplaces?.[name];
      if (existing && existing.url !== source.url) throw new MarketError(`marketplace ${name} is already registered with a different URL in ${layer}`);
      return updateSettingsSection(current, "plugins", {
        ...current?.plugins, schemaVersion: 1,
        marketplaces: { ...current?.plugins?.marketplaces, [name]: { url: source.url } },
      });
    });
    return success(`registered ${name} → ${source.url} (${layer})`, { name, url: source.url, layer });
  }
  writeSettingsLayer(projectDir, target, (current) => {
    if (!current?.plugins?.marketplaces || !Object.hasOwn(current.plugins.marketplaces, input)) throw new MarketError(`marketplace ${input} is not registered in ${layer}`);
    const marketplaces = { ...current.plugins.marketplaces };
    delete marketplaces[input];
    const plugins: PluginsSettingsRecord = { ...current.plugins, marketplaces };
    if (!Object.keys(marketplaces).length) delete plugins.marketplaces;
    return updateSettingsSection(current, "plugins", plugins.allowedMarketplaces !== undefined || plugins.marketplaces ? plugins : null);
  });
  return success(`removed ${input} (${layer})`, { name: input, layer });
}

async function listCommand(projectDir: string, argv: string[], settings: ResolvedAidlcSettings, options: GlobalOptions): Promise<CommandResult> {
  if (argv.includes("--check")) requireNetwork("list --check", options);
  const harnessDir = runtimeHarnessDir(projectDir);
  const result = collectPluginStatus(projectDir, harnessDir);
  if (!argv.includes("--check")) return success(options.mode === "quiet" ? "" : renderPluginStatuses(result.statuses, options.verbose).trimEnd(), result);
  const markets = await fetchMarketplaces(settings, undefined, "list --check", options, true);
  const statuses = result.statuses.map((status) => {
    const record = status.key ? readInstallRecord(projectDir, harnessDir, status.key) : null;
    const candidates = markets.flatMap((market) => market.catalog.plugins.filter((plugin) => plugin.name === status.key).map((plugin) => ({ plugin, market })));
    candidates.sort((left, right) => {
      const preference = Number(right.market.name === record?.marketplace.name) - Number(left.market.name === record?.marketplace.name);
      return preference || Bun.semver.order(right.plugin.version, left.plugin.version) || left.market.name.localeCompare(right.market.name);
    });
    const latest = candidates[0];
    const published: Published | null = latest ? {
      version: latest.plugin.version, marketplace: latest.market.name,
      ...(latest.plugin.supersededBy ? { supersededBy: latest.plugin.supersededBy } : {}),
    } : null;
    const message = published?.supersededBy
      ? `superseded by core v${published.supersededBy.core} - remove the plugin after upgrading`
      : published && status.installedVersion && Bun.semver.order(published.version, status.installedVersion) > 0
      ? `update available: aidlc plugin update ${status.key}`
      : status.action === "current" ? "current" : status.action === "sync" ? "run: aidlc config" : `needs attention: ${status.message}`;
    return { ...status, message, published };
  });
  return success(table(["PLUGIN", "INSTALLED", "COMPOSED", "PUBLISHED", "STATUS"], statuses.map((status) => [
    status.key ?? "-", status.installedVersion ?? "-", status.composedVersion ?? "-", status.published?.version ?? "-",
    status.message + (options.verbose ? ` [${status.state}]` : ""),
  ])), { ...result, statuses });
}

/**
 * The host-store commands a Claude/Codex user runs after verification. Store
 * hosts clone a git repository and read the aggregate host catalog at its
 * root, so the marketplace must be a repository source and the `@` suffix is
 * the catalog's published `name` — never the local registration alias.
 */
export function hostHandoffCommands(
  harness: "claude" | "codex", verb: "install" | "update", pluginName: string, source: MarketplaceSource, catalog: PluginCatalog,
): string[] {
  if (source.kind !== "github") {
    throw new MarketError(
      `${harness === "claude" ? "Claude Code" : "Codex"} installs plugins from a git marketplace repository, but this marketplace is registered by direct catalog URL (${source.url})`,
      EXIT.failure,
      "register the repository instead (owner/repo or https://github.com/owner/repo), or install on a managed harness: kiro, kiro-ide, opencode, cursor, copilot",
    );
  }
  const host = `aidlc-${pluginName}@${catalog.name}`;
  return harness === "claude"
    ? [`/plugin marketplace add ${source.owner}/${source.repo}`, `/plugin ${verb} ${host}`]
    : [`codex plugin marketplace add ${source.url}`, `codex plugin add ${host}`];
}

async function installCommand(
  verb: "install" | "update", name: string, argv: string[], projectDir: string, settings: ResolvedAidlcSettings, options: GlobalOptions,
): Promise<CommandResult> {
  const releaseSettings = requireNetwork(verb, options);
  validatePluginName(name, "plugin name");
  const harnesses = discoverProjectHarnesses(projectDir);
  const selectedHarness = valueAfter(argv, "--harness");
  const harnessName = selectedHarness ?? (harnesses.length === 1 ? harnesses[0].distribution : undefined);
  if (!harnessName || !CATALOG_HARNESSES.includes(harnessName as CatalogHarness)) return usage("select an installed harness with --harness <name>");
  const harness = harnessName as CatalogHarness;
  const installedHarness = harnesses.find((item) => item.distribution === harness);
  const hostStore = harness === "claude" || harness === "codex";
  if (!hostStore && !installedHarness) throw new MarketError(`harness ${harness} is not installed in ${projectDir}; run aidlc config first`);
  const harnessDir = installedHarness?.harnessDir ?? HARNESS_DIRS[harness];
  const record = readInstallRecord(projectDir, harnessDir, name);
  const inventory = collectPluginStatus(projectDir, harnessDir).inventory;
  const installed = inventory.installed.find((plugin) => plugin.key === name);
  const oldVersion = installed?.version ?? record?.version;
  if (verb === "update" && !oldVersion) throw new MarketError(`plugin ${name} is not installed; run aidlc plugin install ${name}`);
  const selected = valueAfter(argv, "--marketplace") ?? (verb === "update" ? record?.marketplace.name : undefined);
  const markets = await fetchMarketplaces(settings, selected, verb, options);
  const candidates = markets.flatMap((market) => market.catalog.plugins.filter((plugin) => plugin.name === name).map((plugin) => ({ plugin, market })));
  if (!candidates.length) throw new MarketError(`plugin ${name} is not published by any registered marketplace; try: aidlc plugin search`);
  if (candidates.length > 1) throw new MarketError(`plugin ${name} is published by multiple marketplaces; choose --marketplace <name>`);
  const { plugin, market } = candidates[0];
  if (verb === "update" && oldVersion && Bun.semver.order(plugin.version, oldVersion) <= 0) return success(`already current: ${name} ${oldVersion}`);
  if (verb === "install" && !hostStore && installed?.version === plugin.version) return success(`already installed: ${name} ${plugin.version}`);
  const projection = plugin.harnesses[harness];
  if (!projection) throw new MarketError(`plugin ${name} does not ship ${harness}; available harnesses: ${Object.keys(plugin.harnesses).join(", ")}`);
  const handoff = hostStore ? hostHandoffCommands(harness as "claude" | "codex", verb, name, market.source, market.catalog) : null;
  const temporary = mkdtempSync(join(tmpdir(), "aidlc-plugin-install-"));
  try {
    const url = archiveUrl(market.source, plugin);
    const archive = join(temporary, "plugin.tar.gz");
    await downloadUrl(url, archive, { timeoutMs: 120_000, caBundle: releaseSettings.caBundle, headers: githubHeaders(url) });
    const extracted = join(temporary, "extracted");
    let root: string;
    try {
      extractTarGz(archive, extracted);
      root = locateProjection(extracted, projection.path);
      const marker = readProjectionMarker(root);
      if (marker.plugin !== name || marker.harness !== harness || marker.version !== plugin.version) throw new Error("projection identity does not match the catalog");
      normalizeInstalledPlugin(root, harness === "kiro-ide" ? "kiro" : harness, true, plugin.version);
      if (projectionDigest(root) !== projection.sha256) throw new Error("digest mismatch");
    } catch (error) {
      throw new MarketError(`integrity: fetched ${name}@${plugin.version} does not match the catalog digest; nothing was installed (${errorMessage(error)})`, EXIT.integrity);
    }
    const fetched = `fetched ${name} ${plugin.version} (${plugin.tag}), checksum verified`;
    if (options.mode === "human") process.stdout.write(`${fetched}\n`);
    if (handoff) {
      const note = `${harness === "claude" ? "Claude Code" : "Codex"} installs plugins through its own store; its trust prompt gates the hooks.`;
      return { ok: false, code: EXIT.actionNeeded, status: "handoff", message: `${handoff.join("\n")}\n${note}`, data: { harness, commands: handoff } };
    }
    const executables = executableFiles(root);
    const consent = [`this plugin installs ${executables.hooks.length} hook file(s) that run in your shell:`, ...executables.hooks.map((file) => `  ${file}`)];
    if (executables.tools.length) consent.push(`and ${executables.tools.length} tool script(s) run by sensors/doctor:`, ...executables.tools.map((file) => `  ${file}`));
    (options.mode === "human" ? process.stdout : process.stderr).write(`${consent.join("\n")}\n`);
    if (!options.yes) {
      if (!process.stdin.isTTY) return usage("refusing to install without confirmation; rerun with --yes");
      const lines = createInterface({ input: process.stdin, output: process.stderr });
      let response: string;
      try { response = await lines.question("Install? [y/N] "); }
      finally { lines.close(); }
      if (!["y", "yes"].includes(response.trim().toLowerCase())) throw new MarketError("plugin install cancelled");
    }
    const path = `${harnessDir}/${MANAGED_PLUGINS_DIR}/${name}`;
    const recordPath = `${harnessDir}/tools/data/plugin-install-${name}.json`;
    const marketplace = { name: market.name, url: market.source.url };
    const nextRecord: PluginInstallRecord = {
      schemaVersion: 1, plugin: name, version: plugin.version, harness, marketplace, tag: plugin.tag, sha256: projection.sha256,
    };
    executePlan({
      schemaVersion: 1, root: projectDir, operations: [
        { kind: "tree", path, source: root, sourceHash: transactionSourceHash(root), expected: transactionState(join(projectDir, path)) },
        writeOperation(recordPath, `${JSON.stringify(nextRecord, null, 2)}\n`, transactionState(join(projectDir, recordPath)), 0o644),
      ],
    });
    const childArgs = ["engine", "plugin", "sync", "--project-dir", projectDir];
    const executable = compiledExecutable();
    const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_HARNESS_DIR: harnessDir, AIDLC_HARNESS_NAME: harness };
    delete env.CLAUDE_PLUGIN_ROOT;
    delete env.PLUGIN_ROOT;
    delete env.AIDLC_PLUGIN_ROOT;
    const child = spawnSync(executable ?? process.execPath, executable ? childArgs : [fileURLToPath(new URL("./aidlc.ts", import.meta.url)), ...childArgs], {
      cwd: projectDir, env, encoding: "utf-8", input: "", timeout: 120_000,
    });
    if (child.status !== 0) throw new MarketError(`plugin installed but composition failed: ${(child.stderr || child.stdout || child.error?.message || "unknown child failure").trim()}`, EXIT.failure, "aidlc engine plugin sync");
    return success(verb === "update" ? `updated ${oldVersion} -> ${plugin.version}; composed` : `installed ${name} ${plugin.version} into ${path}; composed`, {
      plugin: name, version: plugin.version, harness, path, composed: true, marketplace,
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function main(argv: string[]): Promise<void> {
  const options = globalOptions(argv);
  if (argv.includes("--help") || argv.includes("-h")) {
    emitResult(success(USAGE), options);
    return;
  }
  try {
    const positional: string[] = [];
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      if (Object.hasOwn(VALUE_FLAGS, arg)) {
        if (!valueAfter(argv, arg)) throw new MarketError(`${arg} requires a value`, EXIT.usage);
        index++;
      } else if (arg.startsWith("-")) {
        if (!Object.hasOwn(BOOL_FLAGS, arg)) throw new MarketError(`unknown option ${arg}`, EXIT.usage);
      } else positional.push(arg);
    }
    const [verb, ...args] = positional;
    const projectDir = resolveProjectDir(valueAfter(argv, "--project-dir"));
    const settings = resolveAidlcSettings(projectDir);
    let result: CommandResult;
    if (verb === "marketplaces") result = await marketplacesCommand(args, argv, projectDir, settings, options);
    else if (verb === "list" && !args.length) result = await listCommand(projectDir, argv, settings, options);
    else if (verb === "search" && args.length <= 1) {
      const markets = await fetchMarketplaces(settings, valueAfter(argv, "--marketplace"), verb, options, true);
      const term = (args[0] ?? "").toLowerCase();
      const rows = markets.flatMap((market) => market.catalog.plugins.filter((plugin) => `${plugin.name} ${plugin.description}`.toLowerCase().includes(term)).map((plugin) => ({
        plugin: plugin.name, version: plugin.version, marketplace: market.name,
        description: plugin.description + (plugin.supersededBy ? ` (superseded by core v${plugin.supersededBy.core})` : ""),
      }))).sort((left, right) => left.plugin.localeCompare(right.plugin) || left.marketplace.localeCompare(right.marketplace));
      result = success(table(["PLUGIN", "VERSION", "MARKETPLACE", "DESCRIPTION"], rows.map((row) => [row.plugin, row.version, row.marketplace, row.description])), { plugins: rows });
    } else if ((verb === "install" || verb === "update") && args.length === 1) result = await installCommand(verb, args[0], argv, projectDir, settings, options);
    else result = usage("expected a plugin marketplace verb", USAGE);
    emitResult(result, options);
  } catch (error) {
    emitResult(failure(errorMessage(error), error instanceof MarketError ? error.code : error instanceof ReleaseUnavailableError ? EXIT.unavailable : EXIT.failure, error instanceof MarketError ? error.remediation : undefined), options);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
