// The commands plugins add (`aidlc.commands`): which one runs, read from the
// plugins' composition stamps, and how a `next` line names one. aidlc-lib.ts
// reads a line with this module and hands in the readers it owns (the plugin
// selection, the plan names, its Kiro line splitter), so this module never
// imports aidlc-lib.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_COMMAND_WORDS, PLUGIN_COMMAND_NAME_RE, PLUGIN_COMMAND_SCRIPT_RE } from "./aidlc-command.ts";
import { resolveHarnessPath } from "./aidlc-runtime-paths.ts";

/** A command a plugin adds: `aidlc <name>` runs `script` from the plugin's tools/. */
export type PluginCommandRow = { name: string; plugin: string; script: string; description: string };

/** A plugin command that is not added, and who already has its name. */
export type PluginCommandSkip = {
  plugin: string;
  name: string;
  by: { kind: "core" } | { kind: "plan"; name: string } | { kind: "plugin"; plugin: string };
};

export type PluginCommandTable = {
  commands: ReadonlyMap<string, PluginCommandRow>;
  /** The names a plugin that is installed but off would add, each with that plugin. */
  off: ReadonlyMap<string, string>;
  skipped: readonly PluginCommandSkip[];
};

const NO_COMMANDS: PluginCommandTable = { commands: new Map(), off: new Map(), skipped: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Which plugin command runs, the one owner of it: the commands each plugin
 * composed into `dataDir` declares in its stamp (plugin sync writes them), in
 * plugin name order. A name AI-DLC's own commands or a plan already has, or an
 * earlier plugin took, is skipped with who has it, so core always keeps its
 * names and the winner never depends on which sync ran first. A plugin that is
 * off keeps its free names as off. `enabled` null: every plugin is on.
 */
export function pluginCommandTable(
  dataDir: string,
  enabled: ReadonlySet<string> | null,
  plans: ReadonlySet<string>,
): PluginCommandTable {
  const declared: Array<{ plugin: string; rows: PluginCommandRow[] }> = [];
  let files: string[] = [];
  try {
    files = readdirSync(dataDir).sort();
  } catch {
    files = [];
  }
  for (const file of files) {
    const plugin = file.match(/^plugin-compose-([a-z][a-z0-9-]*)\.json$/)?.[1];
    if (plugin === undefined || plugin === "aidlc") continue;
    let stamp: unknown;
    try {
      stamp = JSON.parse(readFileSync(join(dataDir, file), "utf-8"));
    } catch {
      continue;
    }
    if (!isRecord(stamp) || stamp.name !== plugin || !isRecord(stamp.commands)) continue;
    const rows: PluginCommandRow[] = [];
    for (const [name, value] of Object.entries(stamp.commands).sort(([left], [right]) => left.localeCompare(right))) {
      if (
        !PLUGIN_COMMAND_NAME_RE.test(name) || !isRecord(value) ||
        typeof value.script !== "string" || !PLUGIN_COMMAND_SCRIPT_RE.test(value.script) ||
        typeof value.description !== "string"
      ) continue;
      rows.push({ name, plugin, script: value.script, description: value.description });
    }
    declared.push({ plugin, rows });
  }
  const isOn = (plugin: string): boolean => enabled === null || enabled.has(plugin);
  const commands = new Map<string, PluginCommandRow>();
  const off = new Map<string, string>();
  const skipped: PluginCommandSkip[] = [];
  const holder = (name: string): PluginCommandSkip["by"] | null => {
    if (CORE_COMMAND_WORDS.has(name)) return { kind: "core" };
    if (plans.has(name)) return { kind: "plan", name };
    const taken = commands.get(name);
    return taken ? { kind: "plugin", plugin: taken.plugin } : null;
  };
  for (const { plugin, rows } of declared) {
    if (!isOn(plugin)) continue;
    for (const row of rows) {
      const by = holder(row.name);
      if (by === null) commands.set(row.name, row);
      else skipped.push({ plugin, name: row.name, by });
    }
  }
  for (const { plugin, rows } of declared) {
    if (isOn(plugin)) continue;
    for (const row of rows) if (holder(row.name) === null && !off.has(row.name)) off.set(row.name, plugin);
  }
  return { commands, off, skipped };
}

/**
 * The command table of the project this process runs for (or of `dataDir`, a
 * sync's staged copy of it), from the readers aidlc-lib.ts owns; none when its
 * plugin selection cannot be read, and no plan names in a tree with no stage
 * graph.
 */
export function projectPluginCommands(
  reads: {
    pluginsEnabled: () => ReadonlySet<string> | null;
    validScopes: () => ReadonlySet<string>;
  },
  dataDir = resolveHarnessPath(["tools", "data"]),
): PluginCommandTable {
  let enabled: ReadonlySet<string> | null;
  try {
    enabled = reads.pluginsEnabled();
  } catch {
    return NO_COMMANDS;
  }
  let plans: ReadonlySet<string> = new Set();
  try {
    plans = reads.validScopes();
  } catch {
    // No stage graph: no plan names.
  }
  return pluginCommandTable(dataDir, enabled, plans);
}

/**
 * A plugin command leading a `next` line (an off plugin's included, so the
 * person hears that it is off): its name, its own arguments, and whether a
 * sentence follows the name, which, as for a noun of the engine's own, only the
 * agent can read. Kiro IDE hands the whole line over as one argument, which
 * `split` reads as a shell would. The table is read only for a word shaped like
 * a plugin command. Null for any other line.
 */
export function pluginCommandOnLine(
  args: readonly string[],
  split: (line: string) => string[],
  table: () => PluginCommandTable,
): { name: string; plugin: string; args: string[]; sentence: boolean } | null {
  const tokens = args.length === 1 && /\s/.test(args[0].trim()) ? split(args[0]) : [...args];
  const name = tokens[0];
  if (name === undefined || !PLUGIN_COMMAND_NAME_RE.test(name) || CORE_COMMAND_WORDS.has(name)) return null;
  const read = table();
  const plugin = read.commands.get(name)?.plugin ?? read.off.get(name);
  if (plugin === undefined) return null;
  const rest = tokens.slice(1);
  return { name, plugin, args: rest, sentence: rest.length > 1 && !rest[0].startsWith("-") };
}
