// What the plugin sync writes and other readers read back, defined once here:
// doctor's rule reader (aidlc-graph.ts), the sync, and the opencode adapter,
// which runs inside opencode and imports only modules whose own imports are
// node built-ins, so this module imports no sibling.
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// A plugin's rules section in a rule file: its own `##` heading, then the
// opening marker on the line under it (renderRulesBlock in aidlc-plugin.ts
// writes both). The group is the plugin. Doctor's rule reader (aidlc-graph.ts)
// and the plugin sync read it from here, so the marker has one shape.
export const PLUGIN_RULES_OPENING = /^<!-- plugin:([a-z][a-z0-9-]*):rules:\d+:[0-9a-f]+ -->$/;

export const SAFE_PLUGIN_KEY = /^[a-z][a-z0-9-]*$/;

// The record the sync keeps of the files it installed for one plugin, one file
// per plugin in <harness>/tools/data/, named for the plugin's key.
export const PLUGIN_OWNERSHIP_FILE = /^plugin-owned-([a-z][a-z0-9-]*)\.json$/;

export type OwnershipFile = {
  path: string;
  sha256: string;
};

export type OwnershipRecord = {
  schemaVersion: 1;
  name: string;
  files: OwnershipFile[];
};

export function parseOwnership(path: string): OwnershipRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<OwnershipRecord>;
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
