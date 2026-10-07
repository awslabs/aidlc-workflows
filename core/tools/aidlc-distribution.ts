import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { VERSION_ID } from "./aidlc-channel.ts";

export type ProjectionStamp = {
  schemaVersion: 1;
  frameworkVersion: string;
  distribution: string;
  harnessDir: string;
};

export type RootIntegration = {
  path: string;
  /** jsonc-settings adds each shipped top-level key that is absent and never changes a key someone else set. */
  /** json-entries adds AI-DLC's own entries (values and array strings, at any depth) to a team's JSON file. */
  policy: "managed-block" | "json-map" | "json-array" | "whole-file" | "jsonc-settings" | "json-entries";
  marker?: string;
  /** union combines shipped line sets (.gitignore); identical lets any declaring harness own byte-identical content; absent is exclusive. */
  shared?: "union" | "identical";
  jsonKey?: string;
  optional?: boolean;
  legacySignatures?: {
    wholeFileHashes?: string[];
    jsonEntryHashes?: Record<string, string[]>;
  };
};

// A 2.10.0 install checks every release it installs against its own policy
// list and refuses a policy it does not know, so `aidlc update` from 2.10.0
// would fail. A release writes a policy added since then in `extendedPolicy`,
// with "whole-file", which 2.10.0 accepts, in `policy`; reading a projection
// puts the real policy back when this release knows it, and otherwise keeps
// "whole-file", so this release can install a later one in turn.
const EXTENDED_POLICIES: readonly string[] = ["jsonc-settings", "json-entries"];

export function writtenRootIntegration<T extends { policy: string }>(
  integration: T,
): T | (Omit<T, "policy"> & { policy: "whole-file"; extendedPolicy: string }) {
  return EXTENDED_POLICIES.includes(integration.policy)
    ? { ...integration, policy: "whole-file", extendedPolicy: integration.policy }
    : integration;
}

export function readRootIntegrations(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("extendedPolicy" in item)) return item;
    const { extendedPolicy, ...integration } = item as Record<string, unknown>;
    if (typeof extendedPolicy !== "string" || !EXTENDED_POLICIES.includes(extendedPolicy)) return integration;
    return { ...integration, policy: extendedPolicy };
  });
}

export type ProjectionDescriptor = {
  schemaVersion: 1;
  distribution: string;
  productName: string;
  configNextStep: string;
  firstRunSteps?: string[];
  editorTerminalApp?: string;
  harnessDir: string;
  onboarding?: string;
  managedDirectories: string[];
  legacyManagedFileHashes?: Record<string, string[]>;
  rootIntegrations: RootIntegration[];
};

const QUOTED_OR_BARE_PATH = String.raw`(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"';&|]+)`;
const CLAUDE_AIDLC_TS_PATH =
  String.raw`(?:\$CLAUDE_PROJECT_DIR[\\/])?\.claude[\\/]tools[\\/]aidlc\.ts`;
const AIDLC_TS_PATH =
  `(?:"${CLAUDE_AIDLC_TS_PATH}"|'${CLAUDE_AIDLC_TS_PATH}'|${CLAUDE_AIDLC_TS_PATH})`;
const AIDLC_DISPATCHER = String.raw`(?:aidlc(?:\.exe|\.cmd)?|bun\s+${AIDLC_TS_PATH})`;
const AIDLC_HOOK_COMMAND = new RegExp(
  String.raw`^\s*${AIDLC_DISPATCHER}\s+engine\s+(?:hook\s+([A-Za-z0-9_-]+)|(statusline))\s*$`,
);
const AIDLC_HOOK_COMMAND_PREFIX = new RegExp(
  String.raw`^\s*${AIDLC_DISPATCHER}\s+engine\s+(?:hook\s+([A-Za-z0-9_-]+)|(statusline))(?=\s|$)`,
);
const LEGACY_AIDLC_HOOK_COMMAND = new RegExp(
  String.raw`^\s*bun\s+(${QUOTED_OR_BARE_PATH})\s*$`,
);
export const LEGACY_AIDLC_HOOK_TARGETS: ReadonlySet<string> = new Set([
  "audit-logger",
  "continue-workflow",
  "deliver-stage-rules",
  "dispatch-rules",
  "fold-usage",
  "log-subagent",
  "mint-presence",
  "plan-approval-guard",
  "rebuild-stage-graph",
  "record-human-turn",
  "review-freeze",
  "reviewer-scope",
  "run-sensors",
  "runtime-compile",
  "sensor-fire",
  "session-end",
  "session-start",
  "state-transition-guard",
  "statusline",
  "stop",
  "sync-statusline",
  "sync-workflow-state",
  "validate-state",
  "write-audit-log",
]);
export const AIDLC_HOOK_ENTRY_PREFIX = "hooksAidlc:";

export function aidlcDispatcherTarget(
  command: string,
  allowTrailingContent = false,
  projectDir?: string,
): string | null {
  const match = (allowTrailingContent ? AIDLC_HOOK_COMMAND_PREFIX : AIDLC_HOOK_COMMAND)
    .exec(command);
  const target = match?.[1] ?? match?.[2];
  if (target !== undefined) return target;
  if (projectDir === undefined) return null;
  const normalized = command.trim().replaceAll("\\", "/");
  const dispatcherPath = join(projectDir, ".claude", "tools", "aidlc.ts")
    .replaceAll("\\", "/");
  const prefixes = [
    `bun ${dispatcherPath}`,
    `bun "${dispatcherPath}"`,
    `bun '${dispatcherPath}'`,
  ];
  const prefix = prefixes.find((candidate) =>
    normalized.startsWith(`${candidate} `)
  );
  if (prefix === undefined) return null;
  const suffix = normalized.slice(prefix.length).trimStart();
  const suffixMatch = new RegExp(
    allowTrailingContent
      ? String.raw`^engine\s+(?:hook\s+([A-Za-z0-9_-]+)|(statusline))(?=\s|$)`
      : String.raw`^engine\s+(?:hook\s+([A-Za-z0-9_-]+)|(statusline))\s*$`,
  ).exec(suffix);
  return suffixMatch?.[1] ?? suffixMatch?.[2] ?? null;
}

export function aidlcHookTarget(command: string, projectDir?: string): string | null {
  const dispatcher = aidlcDispatcherTarget(command, false, projectDir);
  if (dispatcher !== null) return dispatcher;
  return legacyAidlcHookTarget(command);
}

export function legacyAidlcHookTarget(command: string): string | null {
  const legacy = LEGACY_AIDLC_HOOK_COMMAND.exec(command);
  if (!legacy) return null;
  const path = legacy[1].replace(/^(['"])([\s\S]*)\1$/, "$2").replaceAll("\\", "/");
  const hook =
    /^\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/aidlc-([A-Za-z0-9_-]+)\.ts$/.exec(path);
  const target = hook?.[1];
  return target !== undefined && LEGACY_AIDLC_HOOK_TARGETS.has(target) ? target : null;
}

export function isCustomClaudeStatusLine(
  value: unknown,
  projectDir?: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const statusLine = value as Record<string, unknown>;
  return statusLine.type === "command" &&
    typeof statusLine.command === "string" &&
    statusLine.command.trim() !== "" &&
    aidlcHookTarget(statusLine.command, projectDir) !== "statusline";
}

/** Keep event, matcher, and item metadata while excluding project hook entries. */
export function aidlcHookRegistrations(
  hooks: unknown,
  ownedTargets?: ReadonlySet<string>,
  projectDir?: string,
): Record<string, unknown[]> {
  const registrations: Record<string, unknown[]> = {};
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return registrations;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const owned = groups.flatMap((group: unknown) => {
      if (!group || typeof group !== "object" || Array.isArray(group)) return [];
      const entry = group as Record<string, unknown>;
      if (!Array.isArray(entry.hooks)) return [];
      const items = entry.hooks.filter((item: unknown) =>
        item !== null && typeof item === "object" && "command" in item &&
        typeof item.command === "string" &&
        (() => {
          const target = aidlcHookTarget(item.command, projectDir);
          return target !== null && (!ownedTargets || ownedTargets.has(target));
        })()
      );
      return items.length > 0 ? [{ ...entry, hooks: items }] : [];
    });
    if (owned.length > 0) registrations[event] = owned;
  }
  return registrations;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash each shipped hook target with its exact events, matchers, commands, and metadata. */
export function aidlcHookRegistrationHashes(
  hooks: unknown,
  ownedTargets?: ReadonlySet<string>,
  projectDir?: string,
): Record<string, string> {
  const registrations = new Map<string, unknown[]>();
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group)) continue;
      const entry = group as Record<string, unknown>;
      if (!Array.isArray(entry.hooks)) continue;
      const groupMetadata = Object.fromEntries(
        Object.entries(entry).filter(([key]) => key !== "hooks"),
      );
      for (const hook of entry.hooks) {
        if (!hook || typeof hook !== "object" || Array.isArray(hook)) continue;
        const command = (hook as Record<string, unknown>).command;
        if (typeof command !== "string") continue;
        const target = aidlcHookTarget(command, projectDir);
        if (target === null || (ownedTargets && !ownedTargets.has(target))) continue;
        const rows = registrations.get(target) ?? [];
        rows.push({ event, ...groupMetadata, hook });
        registrations.set(target, rows);
      }
    }
  }
  return Object.fromEntries(
    [...registrations.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([target, rows]) => [target, sha256Bytes(canonical(rows))]),
  );
}

// A JSON file saved from Windows PowerShell 5.1 or some editors starts with a
// UTF-8 byte order mark, which JSON.parse refuses. It is read past, and a file
// AI-DLC writes back keeps it.
const BOM = "\uFEFF";

export function withoutBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(withoutBom(readFileSync(path, "utf-8")));
}

// The JSON text AI-DLC writes for a file, with the byte order mark the file
// had (`like` is its text before the write).
export function jsonFileText(value: unknown, like = ""): string {
  return `${like.startsWith(BOM) ? BOM : ""}${JSON.stringify(value, null, 2)}\n`;
}

function parseJson<T>(path: string): T {
  try {
    return readJsonFile(path) as T;
  } catch (error) {
    throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function safeRelativePath(value: unknown, label: string, topLevel = false): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
    (topLevel && value.includes("/"))
  ) {
    throw new Error(`${label} is not a safe ${topLevel ? "top-level name" : "relative path"}`);
  }
  return value;
}

function validateHashes(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((hash) => typeof hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(hash)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must contain unique lowercase SHA-256 signatures`);
  }
  return value;
}

export function assertProjectionPathHasNoSymlinks(
  root: string,
  relativePath: string,
): void {
  let current = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`${root}: projected path traverses a symlink: ${relativePath}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${root}: projected path parent is not a directory: ${relativePath}`);
    }
  }
}

export function isSafeOnboardingPath(value: unknown, harnessDir: string): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._\/-]+$/.test(value) &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") &&
    value.startsWith(`${harnessDir}/`);
}

// A managed block names a file inside the project and a marker that is a
// plain word, so nothing read or written through it (the team's file, its copy
// in root-blocks) leaves the project. Config's projection check and the
// engine's root-file fallback both hold a managed block to this.
export function managedBlockIsSafe(integration: Pick<RootIntegration, "path" | "marker" | "policy">): boolean {
  try {
    safeRelativePath(integration.path, "root integration path");
  } catch {
    return false;
  }
  return integration.policy === "managed-block" && typeof integration.marker === "string" &&
    /^[a-z0-9-]+$/.test(integration.marker);
}

/** A json-entries integration the engine may add to: one plain file at the project root. */
export function jsonEntriesIsSafe(integration: Pick<RootIntegration, "path" | "policy">): boolean {
  try {
    safeRelativePath(integration.path, "root integration path", true);
  } catch {
    return false;
  }
  return integration.policy === "json-entries";
}

export function validateProjectionDescriptor(
  root: string,
  stamp: ProjectionStamp,
  descriptor: ProjectionDescriptor,
  options: { allowMissingRootIntegrations?: boolean } = {},
): void {
  if (!VERSION_ID.test(stamp.frameworkVersion)) {
    throw new Error(`${root}: projection stamp has an invalid framework version`);
  }
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(stamp.distribution) ||
    typeof descriptor.productName !== "string" ||
    descriptor.productName.trim().length === 0 ||
    typeof descriptor.configNextStep !== "string" ||
    descriptor.configNextStep.trim().length === 0
  ) {
    throw new Error(`${root}: projection identity is invalid`);
  }
  if (
    (descriptor.firstRunSteps !== undefined &&
      (!Array.isArray(descriptor.firstRunSteps) ||
        descriptor.firstRunSteps.length === 0 ||
        descriptor.firstRunSteps.some((line) => typeof line !== "string"))) ||
    (descriptor.editorTerminalApp !== undefined &&
      (typeof descriptor.editorTerminalApp !== "string" ||
        !/^[a-z0-9][a-z0-9 .-]*$/.test(descriptor.editorTerminalApp)))
  ) {
    throw new Error(`${root}: projection first-run guidance is invalid`);
  }
  safeRelativePath(stamp.harnessDir, "harnessDir", true);
  if (descriptor.onboarding !== undefined) {
    const safe = descriptor.onboarding;
    if (!isSafeOnboardingPath(safe, stamp.harnessDir)) {
      throw new Error(`${root}: onboarding path is invalid`);
    }
    try {
      assertProjectionPathHasNoSymlinks(root, safe);
    } catch {
      throw new Error(`${root}: onboarding path is invalid`);
    }
    if (!lstatSync(join(root, safe), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`${root}: onboarding file is missing: ${safe}`);
    }
  }
  if (!Array.isArray(descriptor.managedDirectories) || !Array.isArray(descriptor.rootIntegrations)) {
    throw new Error(`${root}: projection descriptor lists are invalid`);
  }
  const declared = new Set<string>();
  const declare = (safe: string): void => {
    if (declared.has(safe)) throw new Error(`${root}: duplicate projected path ${safe}`);
    const overlap = [...declared].find((prior) =>
      safe.startsWith(`${prior}/`) || prior.startsWith(`${safe}/`)
    );
    if (overlap) {
      throw new Error(`${root}: overlapping projected paths ${overlap} and ${safe}`);
    }
    declared.add(safe);
  };
  for (const directory of descriptor.managedDirectories) {
    const safe = safeRelativePath(directory, "managed directory", true);
    declare(safe);
    assertProjectionPathHasNoSymlinks(root, safe);
    const path = join(root, safe);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) {
      throw new Error(`${root}: managed directory is missing or invalid: ${safe}`);
    }
  }
  if (descriptor.legacyManagedFileHashes !== undefined) {
    const signatures = descriptor.legacyManagedFileHashes;
    if (
      !signatures ||
      typeof signatures !== "object" ||
      Array.isArray(signatures) ||
      Object.keys(signatures).length === 0
    ) {
      throw new Error(`${root}: legacy managed-file signatures are invalid`);
    }
    for (const [file, hashes] of Object.entries(signatures)) {
      const safe = safeRelativePath(file, "legacy managed file");
      if (
        !descriptor.managedDirectories.some((directory) =>
          safe === directory || safe.startsWith(`${directory}/`)
        )
      ) {
        throw new Error(`${root}: legacy managed file is outside managed directories: ${safe}`);
      }
      assertProjectionPathHasNoSymlinks(root, safe);
      const path = join(root, safe);
      if (!existsSync(path) || !lstatSync(path).isFile()) {
        throw new Error(`${root}: legacy managed file is missing or invalid: ${safe}`);
      }
      validateHashes(hashes, `${root}: ${safe} legacy managed-file signatures`);
    }
  }
  for (const integration of descriptor.rootIntegrations) {
    if (!integration || typeof integration !== "object") {
      throw new Error(`${root}: root integration is invalid`);
    }
    const safe = safeRelativePath(integration.path, "root integration path");
    if (
      integration.shared !== undefined &&
      integration.shared !== "union" &&
      integration.shared !== "identical"
    ) {
      throw new Error(`${root}: ${safe} has an invalid shared mode`);
    }
    declare(safe);
    assertProjectionPathHasNoSymlinks(root, safe);
    // Checked even when the file and its copy are absent: the marker names the copy.
    if (integration.policy !== "managed-block" && integration.marker !== undefined) {
      throw new Error(`${root}: ${safe} has a marker, which only a managed block takes`);
    }
    const path = shippedRootIntegrationPath(root, descriptor.harnessDir, integration);
    if (
      !existsSync(path) &&
      (integration.optional || options.allowMissingRootIntegrations)
    ) {
      continue;
    }
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error(`${root}: root integration is missing or invalid: ${safe}`);
    }
    if (!["managed-block", "json-map", "json-array", "whole-file", "jsonc-settings", "json-entries"].includes(integration.policy)) {
      throw new Error(`${root}: ${safe} has an invalid integration policy`);
    }
    if (integration.policy === "json-entries") {
      // In a project's own tree the root file is the team's, with AI-DLC's
      // entries merged in; AI-DLC's part alone is the root-blocks copy.
      const block = rootBlockPath(join(root, descriptor.harnessDir), integration);
      let shipped: unknown;
      try {
        shipped = readJsonFile(existsSync(block) ? block : path);
      } catch {
        shipped = undefined;
      }
      if (!plainObject(shipped) || Object.keys(shipped).length === 0) {
        throw new Error(`${root}: ${safe} must ship a JSON object with at least one entry`);
      }
    }
    if (integration.policy === "jsonc-settings" && !jsoncRootMembers(readFileSync(path, "utf-8"))?.members.length) {
      throw new Error(`${root}: ${safe} must ship a JSON object with at least one setting`);
    }
    if (integration.policy === "managed-block" && !managedBlockIsSafe(integration)) {
      throw new Error(`${root}: ${safe} has an invalid managed-block marker`);
    }
    if (
      (integration.policy === "json-map" || integration.policy === "json-array") &&
      (typeof integration.jsonKey !== "string" || integration.jsonKey.length === 0)
    ) {
      throw new Error(`${root}: ${safe} has an invalid JSON integration key`);
    }
    const legacy = integration.legacySignatures;
    if (legacy !== undefined) {
      if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
        throw new Error(`${root}: ${safe} has invalid legacy signatures`);
      }
      const keys = Object.keys(legacy);
      if (
        keys.length === 0 ||
        keys.some((key) => key !== "wholeFileHashes" && key !== "jsonEntryHashes")
      ) {
        throw new Error(`${root}: ${safe} has invalid legacy signature fields`);
      }
      if (legacy.wholeFileHashes !== undefined) {
        if (integration.policy !== "managed-block" && integration.policy !== "whole-file" && integration.policy !== "json-entries") {
          throw new Error(`${root}: ${safe} cannot use legacy whole-file signatures`);
        }
        validateHashes(legacy.wholeFileHashes, `${root}: ${safe} legacy whole-file signatures`);
      }
      if (legacy.jsonEntryHashes !== undefined) {
        if (
          integration.policy !== "json-map" ||
          !legacy.jsonEntryHashes ||
          typeof legacy.jsonEntryHashes !== "object" ||
          Array.isArray(legacy.jsonEntryHashes) ||
          Object.keys(legacy.jsonEntryHashes).length === 0
        ) {
          throw new Error(`${root}: ${safe} has invalid legacy JSON-entry signatures`);
        }
        for (const [entry, hashes] of Object.entries(legacy.jsonEntryHashes)) {
          if (entry.length === 0) {
            throw new Error(`${root}: ${safe} has an empty legacy JSON entry name`);
          }
          validateHashes(hashes, `${root}: ${safe} legacy JSON entry ${entry}`);
        }
      }
    }
  }
}

// The default space's memory files the team writes: Practices Discovery
// affirms practices into team.md, and practices and learnings land in
// project.md. The engine creates them from its bundled memory seed when they
// are missing (ensureWorkspaceDirs), so a copy runtime need not ship them.
export const TEAM_MEMORY_FILES = ["team.md", "project.md"] as const;

// The copy channel copies runtime/<harness>/ over the project, with no config
// step to merge anything, so its archive leaves out each file a copy would
// replace with the shipped one: a file a team's editor owns (a jsonc-settings
// integration such as .vscode/settings.json), a team file AI-DLC adds its own
// part to (a managed-block integration such as .gitignore or AGENTS.md, or a
// json-entries one such as opencode.json; its part ships in root-blocks and
// is added by config or the engine), the team's memory files, and the
// person's chosen space (aidlc/active-space; a missing one reads as "default").
export function copyChannelOmits(
  descriptor: Pick<ProjectionDescriptor, "rootIntegrations">,
): Set<string> {
  return new Set([
    ...descriptor.rootIntegrations
      .filter((integration) =>
        integration.policy === "jsonc-settings" || shipsRootBlock(integration))
      .map((integration) => integration.path),
    ...TEAM_MEMORY_FILES.map((name) => `aidlc/spaces/default/memory/${name}`),
    "aidlc/active-space",
  ]);
}

// An optional settings file a copy starts without, as `config` does by
// default: Claude Code's .mcp.json, whose servers would otherwise all be
// offered at first start. Its shipped list still travels in root-blocks.
export function copyStartsWithout(integration: Pick<RootIntegration, "policy" | "optional">): boolean {
  return integration.policy === "json-map" && integration.optional === true;
}

// Every managed-block and json-entries root file a release ships, and every
// file a copy starts without, is also copied, byte for byte, to
// <harnessDir>/tools/data/root-blocks/<marker or file name>, inside the
// harness folder a copy brings along. Only a managed block has a marker.
export function shipsRootBlock(integration: Pick<RootIntegration, "policy" | "optional">): boolean {
  return integration.policy === "managed-block" || integration.policy === "json-entries" ||
    copyStartsWithout(integration);
}

export function rootBlockPath(
  harnessRoot: string,
  integration: Pick<RootIntegration, "path" | "marker" | "policy">,
): string {
  const name = integration.policy === "managed-block" && integration.marker
    ? integration.marker
    : basename(integration.path);
  return join(harnessRoot, "tools", "data", "root-blocks", name);
}

// Where a projection holds the bytes it ships for a root integration: the root
// file, or for one the copy runtime leaves out, its root-blocks copy.
export function shippedRootIntegrationPath(
  root: string,
  harnessDir: string,
  integration: Pick<RootIntegration, "path" | "marker" | "policy" | "optional">,
): string {
  const path = join(root, integration.path);
  if (!shipsRootBlock(integration) || existsSync(path)) return path;
  const block = rootBlockPath(join(root, harnessDir), integration);
  return existsSync(block) ? block : path;
}

export function managedBlockMarkers(
  path: string,
  identity: string,
): { begin: string; end: string } {
  return path.endsWith(".md")
    ? {
        begin: `<!-- BEGIN AI-DLC:${identity} -->`,
        end: `<!-- END AI-DLC:${identity} -->`,
      }
    : {
        begin: `# BEGIN AI-DLC:${identity}`,
        end: `# END AI-DLC:${identity}`,
      };
}

// One harness's shipped .gitignore lines combined with each sibling's: the
// first (by name) is the base, and each other adds only the entries not seen,
// so the part keeps its one comment line.
export function unionBlocks(contributors: Array<{ distribution: string; text: string }>): string {
  contributors.sort((left, right) => left.distribution.localeCompare(right.distribution));
  let base = contributors[0].text.trim();
  const seen = new Set<string>();
  for (const line of base.split(/\r?\n/)) {
    const entry = line.trim();
    if (entry && !entry.startsWith("#")) seen.add(entry);
  }
  for (let index = 1; index < contributors.length; index++) {
    const contributor = contributors[index];
    const extras: string[] = [];
    for (const line of contributor.text.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.startsWith("#") || seen.has(entry)) continue;
      extras.push(entry);
      seen.add(entry);
    }
    if (extras.length > 0) base += `\n${extras.join("\n")}`;
  }
  return base;
}

// The ignore entries of a .gitignore part, without its comments and blank lines.
function ignoreEntries(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).sort().join("\n");
}

// Earlier releases shipped a generic template above their own "# AI-DLC"
// section of .gitignore. When that text is replaced, the template lines stay
// in the file as the project's own, so nothing they ignored is un-ignored.
function linesAboveOwnSection(text: string, nextBody: string, newline: string): string {
  const lines = text.split(/\r?\n/);
  const own = lines.findIndex((line) => line.startsWith("# AI-DLC"));
  if (own <= 0) return "";
  const above = lines.slice(0, own).join(newline).trim();
  return above && !nextBody.includes(above) ? above : "";
}

// The one rule for AI-DLC's part of a team file: replace the text between its
// markers, adopt an unmarked file that is exactly a release's, refuse unmarked
// AI-DLC text it cannot tell from the team's (except in .gitignore), and
// otherwise add the marked part after the team's content (a missing file gets
// only that part). Used by config and by the engine for a copy that was never
// configured.
export function mergeBlock(
  path: string,
  current: string,
  shipped: string,
  identity: string,
  legacyWholeFileHashes: readonly string[] = [],
  // Hashes recorded for this part: a copy that differs from one only in its
  // line endings reports that hash as its own.
  recorded: readonly (string | undefined)[] = [],
): {
  value?: string;
  currentHash?: string;
  nextHash?: string;
  adoptedLegacy?: boolean;
  /** The present part holds exactly what a release shipped. */
  currentBlockShipped?: boolean;
  /** An earlier release's template lines were kept above AI-DLC's part. */
  keptOwnLines?: boolean;
  error?: string;
} {
  const { begin, end } = managedBlockMarkers(path, identity);
  const begins = current.split(begin).length - 1;
  const ends = current.split(end).length - 1;
  if (begins > 1 || ends > 1 || (begins === 1) !== (ends === 1)) {
    return { error: "managed markers are missing, duplicated, or malformed" };
  }
  const beginAt = current.indexOf(begin);
  const endAt = current.indexOf(end);
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const body = shipped.trim().replace(/\r?\n/g, newline);
  const block = `${begin}${newline}${body}${newline}${end}`;
  if (beginAt >= 0) {
    if (endAt < beginAt) return { error: "managed end marker precedes its begin marker" };
    const currentBlock = current.slice(beginAt, endAt + end.length);
    const currentBody = current.slice(beginAt + begin.length, endAt).trim();
    const kept = path === ".gitignore" ? linesAboveOwnSection(currentBody, body, newline) : "";
    return {
      value: `${current.slice(0, beginAt)}${kept ? `${kept}${newline}${newline}` : ""}${block}${
        current.slice(endAt + end.length)
      }`,
      currentHash: sha256Matching(currentBlock, [sha256Bytes(block), ...recorded]),
      nextHash: sha256Bytes(block),
      // A .gitignore part with exactly the shipped entries is a release's own,
      // whatever notes an earlier release put between them.
      currentBlockShipped: currentBody === body ||
        legacyWholeFileHashes.includes(sha256Bytes(`${currentBody.replace(/\r\n/g, "\n")}\n`)) ||
        (path === ".gitignore" && ignoreEntries(currentBody) === ignoreEntries(body)),
      ...(kept ? { keptOwnLines: true } : {}),
    };
  }
  if (current.length > 0 && legacyWholeFileHashes.includes(sha256Matching(current, legacyWholeFileHashes))) {
    const kept = path === ".gitignore" ? linesAboveOwnSection(current.trim(), body, newline) : "";
    return {
      value: `${kept ? `${kept}${newline}${newline}` : ""}${block}${newline}`,
      nextHash: sha256Bytes(block),
      adoptedLegacy: true,
      ...(kept ? { keptOwnLines: true } : {}),
    };
  }
  // Ignore rules can remain user-owned even when they mention AI-DLC. Append
  // our marked block without claiming or rewriting that existing prefix.
  if (path !== ".gitignore" && /\baidlc\b|AI-DLC/i.test(current)) {
    return { error: "legacy root integration ambiguous; move or delete the unmarked AI-DLC content" };
  }
  const prefix = current.length === 0 || current.endsWith(newline) ? current : `${current}${newline}`;
  return {
    value: `${prefix}${prefix ? newline : ""}${block}${newline}`,
    nextHash: sha256Bytes(block),
  };
}

export function projectionFiles(root: string): {
  stamp: ProjectionStamp;
  descriptor: ProjectionDescriptor;
} {
  const candidates = readdirSync(root)
    .filter((name) => existsSync(join(root, name, "tools", "data", "aidlc-stamp.json")))
    .sort();
  if (candidates.length !== 1) {
    throw new Error(
      `${root}: expected exactly one projected harness directory, found ${candidates.length}`,
    );
  }
  const harnessDir = candidates[0];
  const data = join(root, harnessDir, "tools", "data");
  const stamp = parseJson<ProjectionStamp>(join(data, "aidlc-stamp.json"));
  const descriptor = parseJson<ProjectionDescriptor>(join(data, "aidlc-projection.json"));
  descriptor.rootIntegrations = readRootIntegrations(descriptor.rootIntegrations) as RootIntegration[];
  if (
    stamp.schemaVersion !== 1 ||
    descriptor.schemaVersion !== 1 ||
    stamp.harnessDir !== harnessDir ||
    descriptor.harnessDir !== harnessDir ||
    stamp.distribution !== descriptor.distribution
  ) {
    throw new Error(`${root}: projection stamp and descriptor do not describe one distribution`);
  }
  validateProjectionDescriptor(root, stamp, descriptor);
  const allowedTopLevel = new Set([
    ...descriptor.managedDirectories,
    ...descriptor.rootIntegrations.map((item) => item.path.split(/[\\/]/)[0]),
  ]);
  const unexpected = readdirSync(root).filter((entry) => !allowedTopLevel.has(entry));
  if (unexpected.length > 0) {
    throw new Error(`${root}: unclassified projection entries: ${unexpected.sort().join(", ")}`);
  }
  return { stamp, descriptor };
}

export function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

// Git rewrites line endings on checkout (Git for Windows' default
// core.autocrlf=true writes LF files back with CRLF), so a file whose only
// difference from a known one is its line endings is that file, not the
// person's change (#2057). Returns the value's own hash, or the known hash it
// equals in its LF form or that form with CRLF.
export function sha256Matching(value: string | Buffer, known: readonly (string | undefined)[]): string {
  const own = sha256Bytes(value);
  if (known.length === 0 || known.includes(own)) return own;
  const lf = Buffer.from(value).toString("latin1").replaceAll("\r\n", "\n");
  for (const form of [lf, lf.replaceAll("\n", "\r\n")]) {
    const hash = sha256Bytes(Buffer.from(form, "latin1"));
    if (known.includes(hash)) return hash;
  }
  return own;
}

export function sha256FileMatching(path: string, known: readonly (string | undefined)[]): string {
  return sha256Matching(readFileSync(path), known);
}

// What a host tool installs for itself inside a directory AI-DLC manages:
// a package manager's dependencies and their records (opencode, for one,
// installs its plugin dependencies under .opencode/ at first start), and a
// nested .gitignore it writes for them. No release ships any of these, so
// config never copies them as release files, never owns them, and never
// removes them.
const HOST_TOOL_NAMES = new Set([
  "node_modules",
  "package.json",
  "package-lock.json",
  "bun.lock",
  "bun.lockb",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

export function hostToolPath(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment, index) =>
    HOST_TOOL_NAMES.has(segment) || (segment === ".gitignore" && index > 0)
  );
}

export function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) files.push(relative(root, path));
      else throw new Error(`${path}: links and special files are not valid projection content`);
    }
  };
  visit(root);
  return files;
}

// --- JSONC settings files ----------------------------------------------------
// A settings file such as .vscode/settings.json is JSONC and belongs to the
// team: comments, trailing commas, and layout stay as they are. Edits are made
// in place on the text, one top-level member at a time, never by rewriting it.

type JsoncMember = {
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
  /** After the member's trailing comma when it has one, else valueEnd. */
  end: number;
};

function skipJsoncTrivia(text: string, at: number): number {
  let index = at;
  while (index < text.length) {
    const char = text[index];
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\uFEFF") {
      index++;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) return -1;
      index = end + 2;
    } else {
      break;
    }
  }
  return index;
}

function skipJsoncString(text: string, at: number): number {
  for (let index = at + 1; index < text.length; index++) {
    if (text[index] === "\\") index++;
    else if (text[index] === '"') return index + 1;
    else if (text[index] === "\n") return -1;
  }
  return -1;
}

function skipJsoncValue(text: string, at: number): number {
  if (text[at] === '"') return skipJsoncString(text, at);
  if (text[at] === "{" || text[at] === "[") {
    let depth = 0;
    let index = at;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index = skipJsoncString(text, index);
        if (index < 0) return -1;
        continue;
      }
      if (char === "/" && (text[index + 1] === "/" || text[index + 1] === "*")) {
        index = skipJsoncTrivia(text, index);
        if (index < 0) return -1;
        continue;
      }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) return index + 1;
      }
      index++;
    }
    return -1;
  }
  let index = at;
  while (index < text.length && !/[\s,}\]/]/.test(text[index])) index++;
  return index > at ? index : -1;
}

/** The root object's top-level members, or null when the text is not one JSONC object. */
export function jsoncRootMembers(text: string): { open: number; close: number; members: JsoncMember[] } | null {
  let index = skipJsoncTrivia(text, 0);
  if (index < 0 || text[index] !== "{") return null;
  const open = index;
  index = skipJsoncTrivia(text, index + 1);
  const members: JsoncMember[] = [];
  while (index >= 0 && index < text.length && text[index] !== "}") {
    if (text[index] !== '"') return null;
    const start = index;
    const keyEnd = skipJsoncString(text, index);
    if (keyEnd < 0) return null;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(start, keyEnd));
    } catch {
      return null;
    }
    index = skipJsoncTrivia(text, keyEnd);
    if (index < 0 || text[index] !== ":") return null;
    const valueStart = skipJsoncTrivia(text, index + 1);
    if (valueStart < 0 || valueStart >= text.length) return null;
    const valueEnd = skipJsoncValue(text, valueStart);
    if (valueEnd < 0) return null;
    index = skipJsoncTrivia(text, valueEnd);
    if (index < 0) return null;
    let end = valueEnd;
    if (text[index] === ",") {
      end = index + 1;
      index = skipJsoncTrivia(text, index + 1);
      if (index < 0) return null;
    } else if (text[index] !== "}") {
      return null;
    }
    members.push({ key: String(key), start, valueStart, valueEnd, end });
  }
  if (index < 0 || text[index] !== "}") return null;
  if (skipJsoncTrivia(text, index + 1) !== text.length) return null;
  return { open, close: index, members };
}

/** The parsed value of one top-level member, or undefined when it is absent. */
export function jsoncSettingValue(text: string, key: string): unknown {
  const root = jsoncRootMembers(text);
  const member = root?.members.findLast((candidate) => candidate.key === key);
  if (!member) return undefined;
  try {
    return Bun.JSONC.parse(text.slice(member.valueStart, member.valueEnd));
  } catch {
    return undefined;
  }
}

/** Add `key` as the root object's last member, keeping every other byte. */
export function insertJsoncSetting(text: string, key: string, valueJson: string): string | null {
  const source = text.trim() ? text : "{}\n";
  const root = jsoncRootMembers(source);
  if (!root) return null;
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lineStartOf = (position: number): number => source.lastIndexOf("\n", position - 1) + 1;
  const first = root.members[0];
  const firstPrefix = first ? source.slice(lineStartOf(first.start), first.start) : "";
  const indent = first && firstPrefix.trim() === "" && firstPrefix.length > 0 ? firstPrefix : "  ";
  const member = `${JSON.stringify(key)}: ${valueJson}`;
  const closeLine = lineStartOf(root.close);
  const closeOnOwnLine = closeLine > root.open && source.slice(closeLine, root.close).trim() === "";
  let next = closeOnOwnLine
    ? `${source.slice(0, closeLine)}${indent}${member}${eol}${source.slice(closeLine)}`
    : `${source.slice(0, root.close).trimEnd()}${eol}${indent}${member}${eol}${source.slice(root.close)}`;
  const last = root.members.at(-1);
  if (last && last.end === last.valueEnd) {
    next = `${next.slice(0, last.valueEnd)},${next.slice(last.valueEnd)}`;
  }
  return next;
}

/** Replace one top-level member's value in place. */
export function replaceJsoncSetting(text: string, key: string, valueJson: string): string | null {
  const member = jsoncRootMembers(text)?.members.findLast((candidate) => candidate.key === key);
  if (!member) return null;
  return `${text.slice(0, member.valueStart)}${valueJson}${text.slice(member.valueEnd)}`;
}

/** Remove one top-level member (and its line when it stood alone), keeping every other byte. */
export function removeJsoncSetting(text: string, key: string): string | null {
  const root = jsoncRootMembers(text);
  if (!root) return null;
  const at = root.members.findIndex((candidate) => candidate.key === key);
  if (at < 0) return text;
  const member = root.members[at];
  let start = member.start;
  let end = member.end;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  if (text.slice(lineStart, start).trim() === "") {
    start = lineStart;
    let after = end;
    while (text[after] === " " || text[after] === "\t") after++;
    if (text[after] === "\r" && text[after + 1] === "\n") end = after + 2;
    else if (text[after] === "\n") end = after + 1;
  }
  let next = `${text.slice(0, start)}${text.slice(end)}`;
  // The last member had no comma of its own: drop the one before it instead.
  const previous = root.members[at - 1];
  if (member.end === member.valueEnd && previous && previous.end !== previous.valueEnd) {
    next = `${next.slice(0, previous.end - 1)}${next.slice(previous.end)}`;
  }
  return next;
}

// --- AI-DLC's entries in a team's JSON file (opencode.json) -----------------
// A json-entries integration is a file the team owns (opencode.json: their
// model, provider, instructions, and permission rules) that AI-DLC adds its
// own entries to. An entry is one value at a path of object keys, or one
// string in a string array. AI-DLC adds each of its entries that is absent,
// follows one it added while nobody changed it, and removes only those; every
// other key, value, comment, and layout byte stays the team's. A permission
// map's "*" rule is one more entry, so AI-DLC's is added only to a map that has
// none, and first in it: opencode applies the last matching rule, so the
// team's own rules after it still decide.

type JsoncNode = {
  kind: "object" | "array" | "value";
  start: number;
  end: number;
  members: JsoncNodeMember[];
  items: JsoncNodeItem[];
};

type JsoncNodeMember = {
  key: string;
  start: number;
  valueStart: number;
  valueEnd: number;
  /** After the member's trailing comma when it has one, else valueEnd. */
  end: number;
  node: JsoncNode;
};

type JsoncNodeItem = { start: number; valueStart: number; valueEnd: number; end: number; node: JsoncNode };

function parseJsoncNode(text: string, at: number): JsoncNode | null {
  const open = text[at];
  if (open !== "{" && open !== "[") {
    const end = skipJsoncValue(text, at);
    return end < 0 ? null : { kind: "value", start: at, end, members: [], items: [] };
  }
  const node: JsoncNode = { kind: open === "{" ? "object" : "array", start: at, end: -1, members: [], items: [] };
  const close = open === "{" ? "}" : "]";
  let index = skipJsoncTrivia(text, at + 1);
  while (index >= 0 && index < text.length && text[index] !== close) {
    let key = "";
    const start = index;
    let valueStart = index;
    if (node.kind === "object") {
      if (text[index] !== '"') return null;
      const keyEnd = skipJsoncString(text, index);
      if (keyEnd < 0) return null;
      try {
        key = String(JSON.parse(text.slice(index, keyEnd)));
      } catch {
        return null;
      }
      index = skipJsoncTrivia(text, keyEnd);
      if (index < 0 || text[index] !== ":") return null;
      valueStart = skipJsoncTrivia(text, index + 1);
      if (valueStart < 0 || valueStart >= text.length) return null;
    }
    const value = parseJsoncNode(text, valueStart);
    if (!value) return null;
    index = skipJsoncTrivia(text, value.end);
    if (index < 0) return null;
    let end = value.end;
    if (text[index] === ",") {
      end = index + 1;
      index = skipJsoncTrivia(text, index + 1);
      if (index < 0) return null;
    } else if (text[index] !== close) {
      return null;
    }
    if (node.kind === "object") node.members.push({ key, start, valueStart, valueEnd: value.end, end, node: value });
    else node.items.push({ start, valueStart, valueEnd: value.end, end, node: value });
  }
  if (index < 0 || text[index] !== close) return null;
  node.end = index + 1;
  return node;
}

/** The whole text as one JSONC value with its positions, or null when it is not one. */
function jsoncTree(text: string): JsoncNode | null {
  const at = skipJsoncTrivia(text, 0);
  if (at < 0 || at >= text.length) return null;
  const node = parseJsoncNode(text, at);
  return node && skipJsoncTrivia(text, node.end) === text.length ? node : null;
}

function jsoncNodeValue(text: string, node: JsoncNode): unknown {
  try {
    return Bun.JSONC.parse(text.slice(node.start, node.end));
  } catch {
    return undefined;
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type JsonLayout = { eol: string; unit: string };

function lineStartOf(text: string, position: number): number {
  return text.lastIndexOf("\n", position - 1) + 1;
}

function lineIndentOf(text: string, position: number): string {
  return /^[ \t]*/.exec(text.slice(lineStartOf(text, position)))?.[0] ?? "";
}

function startsItsLine(text: string, position: number): boolean {
  return text.slice(lineStartOf(text, position), position).trim() === "";
}

function singleLine(text: string, node: JsoncNode): boolean {
  return !text.slice(node.start, node.end).includes("\n");
}

function jsonLayout(text: string, root: JsoncNode): JsonLayout {
  const first = root.members[0];
  const indent = first && startsItsLine(text, first.start) ? lineIndentOf(text, first.start) : "";
  return { eol: text.includes("\r\n") ? "\r\n" : "\n", unit: indent || "  " };
}

function jsonValueText(value: unknown, indent: string, layout: JsonLayout, inline: boolean): string {
  return inline
    ? JSON.stringify(value)
    : JSON.stringify(value, null, layout.unit).split("\n").join(`${layout.eol}${indent}`);
}

// Add one member to an object (first, or after the last), or one string to an
// array, in the layout around it, keeping every other byte.
function insertJsoncEntry(
  text: string,
  layout: JsonLayout,
  container: JsoncNode,
  parentInline: boolean,
  key: string | undefined,
  value: unknown,
  first: boolean,
): string {
  const entries = container.kind === "object" ? container.members : container.items;
  const close = container.end - 1;
  const inline = singleLine(text, container) && (entries.length > 0 || parentInline || container.kind === "array");
  const entryText = (indent: string) =>
    `${key === undefined ? "" : `${JSON.stringify(key)}: `}${jsonValueText(value, indent, layout, inline)}`;
  if (inline) {
    if (entries.length === 0) return `${text.slice(0, container.start + 1)}${entryText("")}${text.slice(close)}`;
    if (first) return `${text.slice(0, entries[0].start)}${entryText("")}, ${text.slice(entries[0].start)}`;
    const last = entries[entries.length - 1];
    return last.end !== last.valueEnd
      ? `${text.slice(0, last.end)} ${entryText("")}${text.slice(last.end)}`
      : `${text.slice(0, last.valueEnd)}, ${entryText("")}${text.slice(last.valueEnd)}`;
  }
  const outer = lineIndentOf(text, container.start);
  const head = entries[0];
  const indent = head && startsItsLine(text, head.start) ? lineIndentOf(text, head.start) : `${outer}${layout.unit}`;
  if (head && first) {
    return startsItsLine(text, head.start)
      ? `${text.slice(0, lineStartOf(text, head.start))}${indent}${entryText(indent)},${layout.eol}${text.slice(lineStartOf(text, head.start))}`
      : `${text.slice(0, head.start)}${entryText(indent)},${layout.eol}${indent}${text.slice(head.start)}`;
  }
  const closeLine = lineStartOf(text, close);
  let next = closeLine > container.start && text.slice(closeLine, close).trim() === ""
    ? `${text.slice(0, closeLine)}${indent}${entryText(indent)}${layout.eol}${text.slice(closeLine)}`
    : `${text.slice(0, close).trimEnd()}${layout.eol}${indent}${entryText(indent)}${layout.eol}${outer}${text.slice(close)}`;
  const last = entries[entries.length - 1];
  if (last && last.end === last.valueEnd) next = `${next.slice(0, last.valueEnd)},${next.slice(last.valueEnd)}`;
  return next;
}

function replaceJsoncNode(text: string, layout: JsonLayout, node: JsoncNode, value: unknown): string {
  return `${text.slice(0, node.start)}${jsonValueText(value, lineIndentOf(text, node.start), layout, singleLine(text, node) && !plainObject(value))}${text.slice(node.end)}`;
}

// Take one member or item out (with its line when it stood alone), keeping
// every other byte.
function removeJsoncEntry(text: string, entries: Array<{ start: number; valueEnd: number; end: number }>, at: number): string {
  const entry = entries[at];
  const previous = entries[at - 1];
  const following = entries[at + 1];
  const lineStart = lineStartOf(text, entry.start);
  let after = entry.end;
  while (text[after] === " " || text[after] === "\t") after++;
  const lineEnd = text[after] === "\r" && text[after + 1] === "\n" ? after + 2 : text[after] === "\n" ? after + 1 : -1;
  if (startsItsLine(text, entry.start) && lineEnd >= 0) {
    let next = `${text.slice(0, lineStart)}${text.slice(lineEnd)}`;
    // The last one had no comma of its own: drop the one before it instead.
    if (!following && entry.end === entry.valueEnd && previous && previous.end !== previous.valueEnd) {
      next = `${next.slice(0, previous.end - 1)}${next.slice(previous.end)}`;
    }
    return next;
  }
  if (following) return `${text.slice(0, entry.start)}${text.slice(following.start)}`;
  if (previous) return `${text.slice(0, previous.valueEnd)}${text.slice(entry.end)}`;
  return `${text.slice(0, entry.start)}${text.slice(entry.end)}`;
}

// `/aidlc space <name>` points the method glob at the chosen space, so any
// space's glob fills AI-DLC's one method entry.
const METHOD_INSTRUCTION = /^aidlc\/spaces\/[^/"]+\/memory\/\*\*\/\*\.md$/;
const METHOD_SLOT = "aidlc/spaces/*/memory/**/*.md";

function itemSlot(path: readonly string[], item: string): string {
  return path.length === 1 && path[0] === "instructions" && METHOD_INSTRUCTION.test(item) ? METHOD_SLOT : item;
}

type JsonEntry = { id: string; path: string[]; item?: string; value: unknown; hash: string };

function jsonEntriesOf(value: Record<string, unknown>, path: string[] = []): JsonEntry[] {
  const entries: JsonEntry[] = [];
  const seen = new Set<string>();
  const add = (entry: JsonEntry) => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(entry);
  };
  for (const [key, child] of Object.entries(value)) {
    const at = [...path, key];
    if (plainObject(child) && Object.keys(child).length > 0) {
      for (const entry of jsonEntriesOf(child, at)) add(entry);
    } else if (Array.isArray(child) && child.length > 0 && child.every((item) => typeof item === "string")) {
      for (const item of child as string[]) {
        const slot = itemSlot(at, item);
        add({ id: JSON.stringify({ path: at, item: slot }), path: at, item, value: item, hash: sha256Bytes(canonical(slot)) });
      }
    } else {
      add({ id: JSON.stringify({ path: at }), path: at, value: child, hash: sha256Bytes(canonical(child)) });
    }
  }
  return entries;
}

function entryAddress(id: string): { path: string[]; item?: string } | null {
  try {
    const parsed = JSON.parse(id) as unknown;
    if (
      !plainObject(parsed) || !Array.isArray(parsed.path) || parsed.path.length === 0 ||
      !parsed.path.every((part) => typeof part === "string") ||
      (parsed.item !== undefined && typeof parsed.item !== "string")
    ) {
      return null;
    }
    return { path: parsed.path as string[], ...(typeof parsed.item === "string" ? { item: parsed.item } : {}) };
  } catch {
    return null;
  }
}

// Entries only AI-DLC writes: they name its own folders or commands.
function aidlcOwnEntry(entry: Pick<JsonEntry, "path" | "item">): boolean {
  return [...entry.path, ...(entry.item === undefined ? [] : [entry.item])].some((part) =>
    part.includes(".aidlc/") || part.startsWith("aidlc/spaces/") || part.startsWith("aidlc ")
  );
}

/** Who owns the entries already in the file before this merge. */
export type JsonEntriesOwnership =
  /** The entries AI-DLC recorded, with the value hash it wrote. */
  | { kind: "recorded"; entries: Record<string, string> }
  /** The whole file is one AI-DLC wrote (a whole-file record or signature that matches). */
  | { kind: "whole" }
  /** AI-DLC wrote the whole file once and the team has edited it since. */
  | { kind: "matching" }
  /** No record: only an entry naming AI-DLC's own folders or commands is AI-DLC's. */
  | { kind: "none" };

export type JsonEntriesResult =
  | { conflict: string }
  | { text: string; entries: Record<string, string>; whole: boolean };

function containerAt(
  text: string,
  root: JsoncNode,
  path: readonly string[],
): { node: JsoncNode; parentInline: boolean; member: JsoncNodeMember } | undefined {
  let node = root;
  let parentInline = false;
  let member: JsoncNodeMember | undefined;
  for (const key of path) {
    if (node.kind !== "object") return undefined;
    member = node.members.findLast((candidate) => candidate.key === key);
    if (!member) return undefined;
    parentInline = singleLine(text, node);
    node = member.node;
  }
  return member ? { node, parentInline, member } : undefined;
}

function valueAt(value: Record<string, unknown>, path: readonly string[]): unknown {
  let at: unknown = value;
  for (const key of path) at = plainObject(at) ? at[key] : undefined;
  return at;
}

function sameItem(text: string, node: JsoncNode, path: readonly string[], slot: string): boolean {
  const value = jsoncNodeValue(text, node);
  return typeof value === "string" && itemSlot(path, value) === slot;
}

// One shipped entry, added, followed, or left as the team has it. A key
// missing on the way is added with everything AI-DLC ships under it.
function applyJsonEntry(
  text: string,
  layout: JsonLayout,
  entry: JsonEntry,
  shippedValue: Record<string, unknown>,
  shipped: readonly JsonEntry[],
  prior: Record<string, string>,
  force: boolean,
  next: Record<string, string>,
): { text: string } | { conflict: string } {
  for (let attempt = 0; attempt < 2; attempt++) {
    const root = jsoncTree(text);
    if (root?.kind !== "object") return { conflict: "malformed JSON" };
    const containerPath = entry.item === undefined ? entry.path.slice(0, -1) : entry.path;
    let node = root;
    let parentInline = false;
    let converted = false;
    for (let depth = 0; depth < containerPath.length; depth++) {
      const key = containerPath[depth];
      const prefix = containerPath.slice(0, depth + 1);
      const member = node.members.findLast((candidate) => candidate.key === key);
      if (!member) {
        for (const other of shipped) {
          if (prefix.every((part, index) => other.path[index] === part)) next[other.id] = other.hash;
        }
        return { text: insertJsoncEntry(text, layout, node, parentInline, key, valueAt(shippedValue, prefix), false) };
      }
      const wantArray = entry.item !== undefined && depth === containerPath.length - 1;
      if (wantArray ? member.node.kind !== "array" : member.node.kind !== "object") {
        const value = jsoncNodeValue(text, member.node);
        // opencode reads `"bash": "ask"` as the map `{"*": "ask"}`.
        if (!wantArray && prefix.length === 2 && prefix[0] === "permission" && typeof value === "string") {
          text = replaceJsoncNode(text, layout, member.node, { "*": value });
          converted = true;
          break;
        }
        return { conflict: `${prefix.join(".")} must be a JSON ${wantArray ? "array" : "object"}` };
      }
      parentInline = singleLine(text, node);
      node = member.node;
    }
    if (converted) continue;
    if (entry.item !== undefined) {
      const slot = itemSlot(entry.path, entry.item);
      if (node.items.some((item) => sameItem(text, item.node, entry.path, slot))) {
        if (prior[entry.id] !== undefined) next[entry.id] = entry.hash;
        return { text };
      }
      next[entry.id] = entry.hash;
      return { text: insertJsoncEntry(text, layout, node, parentInline, undefined, entry.item, false) };
    }
    const key = entry.path[entry.path.length - 1];
    const member = node.members.findLast((candidate) => candidate.key === key);
    if (!member) {
      next[entry.id] = entry.hash;
      return { text: insertJsoncEntry(text, layout, node, parentInline, key, entry.value, key === "*") };
    }
    const currentHash = sha256Bytes(canonical(jsoncNodeValue(text, member.node)));
    const priorHash = prior[entry.id];
    if (priorHash !== undefined && (currentHash === priorHash || force)) {
      next[entry.id] = entry.hash;
      return { text: currentHash === entry.hash ? text : replaceJsoncNode(text, layout, member.node, entry.value) };
    }
    if (priorHash !== undefined && currentHash === entry.hash) next[entry.id] = entry.hash;
    return { text };
  }
  return { conflict: "malformed JSON" };
}

// Remove one recorded entry while it still has the value AI-DLC wrote (any
// value with force), then any object or array that removal left empty.
function removeRecordedJsonEntry(text: string, id: string, hash: string, force: boolean): string {
  const address = entryAddress(id);
  const root = jsoncTree(text);
  if (!address || !root || root.kind !== "object") return text;
  const containerPath = address.item === undefined ? address.path.slice(0, -1) : address.path;
  const container = containerPath.length === 0 ? { node: root } : containerAt(text, root, containerPath);
  if (!container) return text;
  let next = text;
  if (address.item !== undefined) {
    if (container.node.kind !== "array") return text;
    const at = container.node.items.findIndex((item) => sameItem(text, item.node, address.path, address.item as string));
    if (at < 0 || (sha256Bytes(canonical(address.item)) !== hash && !force)) return text;
    next = removeJsoncEntry(text, container.node.items, at);
  } else {
    if (container.node.kind !== "object") return text;
    const key = address.path[address.path.length - 1];
    const at = container.node.members.findLastIndex((member) => member.key === key);
    if (at < 0) return text;
    if (sha256Bytes(canonical(jsoncNodeValue(text, container.node.members[at].node))) !== hash && !force) return text;
    next = removeJsoncEntry(text, container.node.members, at);
  }
  for (let depth = containerPath.length; depth > 0; depth--) {
    const tree = jsoncTree(next);
    const emptied = tree && containerAt(next, tree, containerPath.slice(0, depth));
    if (!tree || !emptied || emptied.node.members.length + emptied.node.items.length > 0) break;
    const parent = depth === 1 ? { node: tree } : containerAt(next, tree, containerPath.slice(0, depth - 1));
    if (parent?.node.kind !== "object") break;
    const at = parent.node.members.findLastIndex((member) => member.key === containerPath[depth - 1]);
    if (at < 0) break;
    next = removeJsoncEntry(next, parent.node.members, at);
  }
  return next;
}

/**
 * Merge AI-DLC's part (the shipped file) into the team's file. The result
 * records each entry AI-DLC owns afterwards, with the value hash it wrote.
 * A file that holds only AI-DLC's unchanged entries (or none) becomes the
 * shipped file as it is. A shape AI-DLC cannot add to is a conflict, never a
 * guess.
 */
export function mergeJsonEntries(
  current: string,
  shippedText: string,
  ownership: JsonEntriesOwnership,
  force = false,
): JsonEntriesResult {
  let shippedValue: unknown;
  try {
    // A project's own file read as the source may hold comments.
    shippedValue = Bun.JSONC.parse(withoutBom(shippedText));
  } catch {
    return { conflict: "shipped JSON is malformed" };
  }
  if (!plainObject(shippedValue)) return { conflict: "shipped JSON root must be an object" };
  const shipped = jsonEntriesOf(shippedValue);
  const all = Object.fromEntries(shipped.map((entry) => [entry.id, entry.hash]));
  const bom = current.startsWith(BOM) ? BOM : "";
  const asShipped = `${bom}${withoutBom(shippedText)}`;
  if (current.trim() === "") return { text: asShipped, entries: all, whole: true };
  const root = jsoncTree(current);
  const currentValue = root ? jsoncNodeValue(current, root) : undefined;
  if (!root || currentValue === undefined) return { conflict: "malformed JSON" };
  if (root.kind !== "object" || !plainObject(currentValue)) return { conflict: "JSON root must be an object" };
  const present = jsonEntriesOf(currentValue);
  const presentHashes = new Map(present.map((entry) => [entry.id, entry.hash]));
  const prior: Record<string, string> = ownership.kind === "recorded"
    ? ownership.entries
    : ownership.kind === "whole"
    ? Object.fromEntries(presentHashes)
    : Object.fromEntries(
      shipped
        .filter((entry) => presentHashes.get(entry.id) === entry.hash && (ownership.kind === "matching" || aidlcOwnEntry(entry)))
        .map((entry) => [entry.id, entry.hash]),
    );
  let plain = true;
  try {
    JSON.parse(withoutBom(current));
  } catch {
    plain = false;
  }
  // An empty object, or only AI-DLC's unchanged entries with no comments and
  // no method glob pointed at another space: the shipped file itself.
  const shippedItems = new Set(shipped.flatMap((entry) => entry.item === undefined ? [] : [entry.item]));
  const repointed = (entry: JsonEntry) =>
    entry.item !== undefined && itemSlot(entry.path, entry.item) !== entry.item && !shippedItems.has(entry.item);
  if (
    plain && (present.length > 0 || root.members.length === 0) &&
    present.every((entry) => prior[entry.id] === entry.hash && !repointed(entry))
  ) {
    return { text: asShipped, entries: all, whole: true };
  }
  const layout = jsonLayout(current, root);
  const next: Record<string, string> = {};
  let text = current;
  for (const entry of shipped) {
    if (next[entry.id] !== undefined) continue;
    const step = applyJsonEntry(text, layout, entry, shippedValue, shipped, prior, force, next);
    if ("conflict" in step) return step;
    text = step.text;
  }
  // AI-DLC's entries this release no longer ships go, unless someone changed them.
  for (const [id, hash] of Object.entries(prior)) {
    if (all[id] === undefined) text = removeRecordedJsonEntry(text, id, hash, force);
  }
  return { text, entries: next, whole: false };
}

/** Remove every recorded entry that still has the value AI-DLC wrote; null when the file is unreadable. */
export function removeJsonEntries(current: string, entries: Record<string, string>, force = false): string | null {
  if (jsoncTree(current)?.kind !== "object") return null;
  let text = current;
  for (const [id, hash] of Object.entries(entries)) text = removeRecordedJsonEntry(text, id, hash, force);
  return text;
}

/** True when the text is an object with no members (whitespace and a byte order mark aside). */
export function emptyJsonObject(text: string): boolean {
  return withoutBom(text).replace(/\s/g, "") === "{}";
}

/**
 * The shipped entries under the given top-level keys that the team's file
 * lacks (any value counts as present); null when the file is unreadable.
 */
export function missingJsonEntries(current: string, shippedText: string, under: readonly string[]): string[] | null {
  let shippedValue: unknown;
  try {
    shippedValue = JSON.parse(withoutBom(shippedText));
  } catch {
    return null;
  }
  const root = jsoncTree(current);
  if (!plainObject(shippedValue) || !root || root.kind !== "object") return null;
  return jsonEntriesOf(shippedValue)
    .filter((entry) => under.includes(entry.path[0]))
    .filter((entry) => {
      const containerPath = entry.item === undefined ? entry.path.slice(0, -1) : entry.path;
      const container = containerPath.length === 0 ? { node: root } : containerAt(current, root, containerPath);
      if (!container) return true;
      if (entry.item !== undefined) {
        const slot = itemSlot(entry.path, entry.item);
        return !container.node.items.some((item) => sameItem(current, item.node, entry.path, slot));
      }
      return !container.node.members.some((member) => member.key === entry.path[entry.path.length - 1]);
    })
    .map((entry) => entry.id);
}
