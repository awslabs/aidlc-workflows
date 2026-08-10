#!/usr/bin/env bun
// Non-destructive installer for dist/cursor. It preserves project-owned files,
// structurally merges Cursor's shared JSON surfaces, and refuses ambiguous
// collisions before writing any part of the distribution.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DIST_ROOT = dirname(fileURLToPath(import.meta.url));
const AGENTS_BEGIN = "<!-- BEGIN AIDLC CURSOR -->";
const AGENTS_END = "<!-- END AIDLC CURSOR -->";
const GITIGNORE_BEGIN = "# BEGIN AIDLC CURSOR";
const GITIGNORE_END = "# END AIDLC CURSOR";
const RECEIPT_REL = ".cursor/aidlc-install.json";

type JsonObject = Record<string, unknown>;
type WriteAction =
  | { kind: "copy"; source: string; target: string }
  | { kind: "write"; target: string; content: string | Buffer };

interface InstallReceipt {
  schemaVersion: 1;
  managedFiles: Record<string, string>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(path: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`${path}: malformed JSON (${error instanceof Error ? error.message : error})`);
  }
  if (!isObject(parsed)) throw new Error(`${path}: expected a JSON object`);
  return parsed;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readReceipt(path: string): InstallReceipt | null {
  if (!existsSync(path)) return null;
  const parsed = parseObject(path);
  if (parsed.schemaVersion !== 1 || !isObject(parsed.managedFiles)) {
    throw new Error(`${path}: unsupported or malformed AI-DLC install receipt`);
  }
  const managedFiles: Record<string, string> = {};
  for (const [file, hash] of Object.entries(parsed.managedFiles)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`${path}: invalid managed-file hash for ${file}`);
    }
    managedFiles[file] = hash;
  }
  return { schemaVersion: 1, managedFiles };
}

function isLegacyAidlcInstall(targetRoot: string): boolean {
  return [
    ".cursor/tools/aidlc-version.ts",
    ".cursor/hooks/aidlc-cursor-adapter.ts",
    ".cursor/skills/aidlc/SKILL.md",
  ].every((rel) => existsSync(join(targetRoot, rel)));
}

function activeSpaceFor(targetRoot: string): string {
  const pointer = join(targetRoot, "aidlc", "active-space");
  if (!existsSync(pointer)) return "default";
  const space = readFileSync(pointer, "utf-8").trim();
  return /^[a-z0-9][a-z0-9._-]*$/.test(space) ? space : "default";
}

function parseBufferObject(content: Buffer, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.toString("utf-8"));
  } catch (error) {
    throw new Error(`${label}: malformed JSON (${error instanceof Error ? error.message : error})`);
  }
  if (!isObject(parsed)) throw new Error(`${label}: expected a JSON object`);
  return parsed;
}

function activePluginSelection(targetRoot: string): string[] | null {
  const path = join(targetRoot, ".cursor", "tools", "data", "harness.json");
  if (!existsSync(path)) return null;
  const parsed = parseObject(path);
  if (!Object.hasOwn(parsed, "plugins")) return null;
  return stringArray(parsed.plugins, `${path}: plugins`);
}

interface PluginRuntimeState {
  composed: boolean;
  modifiedStageSlugs: Set<string>;
}

function pluginRuntimeState(targetRoot: string): PluginRuntimeState {
  const state: PluginRuntimeState = {
    composed: false,
    modifiedStageSlugs: new Set<string>(),
  };
  const dataDir = join(targetRoot, ".cursor", "tools", "data");
  try {
    for (const name of readdirSync(dataDir)) {
      if (!name.startsWith("plugin-contrib-") || !name.endsWith(".json")) continue;
      state.composed = true;
      try {
        const parsed = JSON.parse(readFileSync(join(dataDir, name), "utf-8")) as unknown;
        if (isObject(parsed)) {
          for (const slug of Object.keys(parsed)) state.modifiedStageSlugs.add(slug);
        }
      } catch {
        // The sidecar's presence still proves composition; collision handling
        // remains conservative when its per-stage record is unreadable.
      }
    }
  } catch {
    // Fall through to graph/source evidence.
  }
  try {
    const graph = JSON.parse(
      readFileSync(join(dataDir, "stage-graph.json"), "utf-8"),
    ) as Array<{ plugin?: unknown }>;
    if (graph.some((stage) => typeof stage.plugin === "string")) state.composed = true;
  } catch {
    // Fall through to prose-fragment evidence.
  }
  const stagesDir = join(targetRoot, ".cursor", "aidlc-common", "stages");
  try {
    for (const path of filesUnder(stagesDir)) {
      if (!path.endsWith(".md")) continue;
      if (!readFileSync(path, "utf-8").includes("<!-- plugin:")) continue;
      state.composed = true;
      state.modifiedStageSlugs.add(basename(path, ".md"));
    }
  } catch {
    // Existing sidecar/graph evidence remains usable.
  }
  return state;
}

function managedContent(
  rel: string,
  source: Buffer,
  activeSpace: string,
  existing?: Buffer,
  pluginModifiedStageSlugs: ReadonlySet<string> = new Set<string>(),
): Buffer {
  if (rel === ".cursor/tools/data/harness.json" && existing) {
    const shipped = parseBufferObject(source, rel);
    const current = parseBufferObject(existing, rel);
    if (Object.hasOwn(current, "plugins")) {
      shipped.plugins = stringArray(current.plugins, `${rel}: plugins`);
    }
    return Buffer.from(`${JSON.stringify(shipped, null, 2)}\n`, "utf-8");
  }

  if (
    pluginModifiedStageSlugs.has(basename(rel, ".md")) &&
    existing &&
    rel.startsWith(".cursor/aidlc-common/stages/")
  ) {
    return existing;
  }

  if (
    /^\.cursor\/rules\/.+\.mdc$/.test(rel) ||
    /^\.cursor\/agents\/[^/]+-agent\.md$/.test(rel)
  ) {
    return Buffer.from(
      source
        .toString("utf-8")
        .replace(
          /aidlc\/spaces\/[^/]+\/memory\//g,
          `aidlc/spaces/${activeSpace}/memory/`,
        ),
      "utf-8",
    );
  }
  return source;
}

function receiptComparableContent(rel: string, current: Buffer, activeSpace: string): Buffer {
  if (rel === ".cursor/tools/data/harness.json") {
    const parsed = parseBufferObject(current, rel);
    delete parsed.plugins;
    return Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf-8");
  }
  if (
    /^\.cursor\/rules\/.+\.mdc$/.test(rel) ||
    /^\.cursor\/agents\/[^/]+-agent\.md$/.test(rel)
  ) {
    return Buffer.from(
      current
        .toString("utf-8")
        .replaceAll(
          `aidlc/spaces/${activeSpace}/memory/`,
          "aidlc/spaces/default/memory/",
        ),
      "utf-8",
    );
  }
  return current;
}

function isRuntimeOwnedManagedFile(
  rel: string,
  selectedPlugins: string[] | null,
  pluginComposition: boolean,
  pluginModifiedStageSlugs: ReadonlySet<string>,
): boolean {
  if (selectedPlugins === null && !pluginComposition) return false;
  if (
    rel === ".cursor/tools/data/stage-graph.json" ||
    rel === ".cursor/tools/data/scope-grid.json" ||
    rel === ".cursor/skills/aidlc/SKILL.md"
  ) {
    return true;
  }
  return (
    rel.startsWith(".cursor/aidlc-common/stages/") &&
    pluginModifiedStageSlugs.has(basename(rel, ".md"))
  );
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label}: expected an array of strings`);
  }
  return value as string[];
}

function mergeHooks(sourcePath: string, targetPath: string): string {
  const source = parseObject(sourcePath);
  const existing = existsSync(targetPath) ? parseObject(targetPath) : {};
  const sourceVersion = source.version;
  if (
    existing.version !== undefined &&
    sourceVersion !== undefined &&
    existing.version !== sourceVersion
  ) {
    throw new Error(
      `${targetPath}: hooks version ${String(existing.version)} conflicts with shipped version ${String(sourceVersion)}`,
    );
  }
  const sourceHooks = source.hooks;
  const existingHooks = existing.hooks;
  if (!isObject(sourceHooks)) throw new Error(`${sourcePath}: hooks must be an object`);
  if (existingHooks !== undefined && !isObject(existingHooks)) {
    throw new Error(`${targetPath}: hooks must be an object`);
  }

  const mergedHooks: JsonObject = { ...(existingHooks ?? {}) };
  for (const [event, shippedEntries] of Object.entries(sourceHooks)) {
    if (!Array.isArray(shippedEntries)) {
      throw new Error(`${sourcePath}: hooks.${event} must be an array`);
    }
    const projectEntries = mergedHooks[event];
    if (projectEntries !== undefined && !Array.isArray(projectEntries)) {
      throw new Error(`${targetPath}: hooks.${event} must be an array`);
    }
    const merged = [...((projectEntries as unknown[] | undefined) ?? [])];
    for (const entry of shippedEntries) {
      const command = isObject(entry) && typeof entry.command === "string" ? entry.command : null;
      const existingIndex =
        command === null
          ? -1
          : merged.findIndex(
              (candidate) => isObject(candidate) && candidate.command === command,
            );
      // A command match identifies an AI-DLC-owned hook entry. Replace it with
      // the refreshed shipped object so security metadata such as failClosed
      // upgrades instead of being frozen at the first installed version.
      if (existingIndex === -1) merged.push(entry);
      else merged[existingIndex] = entry;
    }
    mergedHooks[event] = merged;
  }

  const merged = {
    ...existing,
    ...(sourceVersion === undefined ? {} : { version: sourceVersion }),
    hooks: mergedHooks,
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function mergeCli(sourcePath: string, targetPath: string): string {
  const source = parseObject(sourcePath);
  const existing = existsSync(targetPath) ? parseObject(targetPath) : {};
  const sourcePermissions = source.permissions;
  const existingPermissions = existing.permissions;
  if (!isObject(sourcePermissions)) throw new Error(`${sourcePath}: permissions must be an object`);
  if (existingPermissions !== undefined && !isObject(existingPermissions)) {
    throw new Error(`${targetPath}: permissions must be an object`);
  }

  const shippedAllow = stringArray(sourcePermissions.allow, `${sourcePath}: permissions.allow`);
  const shippedDeny = stringArray(sourcePermissions.deny, `${sourcePath}: permissions.deny`);
  const projectAllow = stringArray(existingPermissions?.allow, `${targetPath}: permissions.allow`);
  const projectDeny = stringArray(existingPermissions?.deny, `${targetPath}: permissions.deny`);
  const conflicts = [
    ...shippedAllow.filter((entry) => projectDeny.includes(entry)),
    ...shippedDeny.filter((entry) => projectAllow.includes(entry)),
  ];
  if (conflicts.length > 0) {
    throw new Error(
      `${targetPath}: shipped permissions conflict with existing allow/deny entries: ${[...new Set(conflicts)].join(", ")}`,
    );
  }

  const permissions = {
    ...(existingPermissions ?? {}),
    allow: [...new Set([...projectAllow, ...shippedAllow])],
    deny: [...new Set([...projectDeny, ...shippedDeny])],
  };
  return `${JSON.stringify({ ...existing, permissions }, null, 2)}\n`;
}

function replaceOrAppendMarked(
  existing: string,
  shipped: string,
  begin: string,
  end: string,
): string {
  const start = existing.indexOf(begin);
  const finish = existing.indexOf(end);
  if ((start === -1) !== (finish === -1) || (start !== -1 && finish < start)) {
    throw new Error(`cannot merge text with an incomplete ${begin} section`);
  }
  const section = `${begin}\n${shipped.trimEnd()}\n${end}`;
  if (start !== -1) {
    return `${existing.slice(0, start)}${section}${existing.slice(finish + end.length)}`;
  }
  if (existing.length === 0) return `${section}\n`;
  return `${existing.trimEnd()}\n\n${section}\n`;
}

function* filesUnder(root: string): Generator<string> {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) yield* filesUnder(path);
    else yield path;
  }
}

async function refreshPluginRouting(targetRoot: string): Promise<void> {
  const utilityPath = join(targetRoot, ".cursor", "tools", "aidlc-utility.ts");
  const module = await import(pathToFileURL(utilityPath).href) as {
    regenerateSelectionSurfaces?: (projectDir: string) => void;
  };
  if (typeof module.regenerateSelectionSurfaces !== "function") {
    throw new Error(`${utilityPath}: missing plugin-routing regeneration export`);
  }

  const priorProject = process.env.AIDLC_PROJECT_DIR;
  const priorHarnessDir = process.env.AIDLC_HARNESS_DIR;
  const priorHarnessName = process.env.AIDLC_HARNESS_NAME;
  process.env.AIDLC_PROJECT_DIR = targetRoot;
  process.env.AIDLC_HARNESS_DIR = ".cursor";
  process.env.AIDLC_HARNESS_NAME = "cursor";
  try {
    module.regenerateSelectionSurfaces(targetRoot);
  } finally {
    if (priorProject === undefined) delete process.env.AIDLC_PROJECT_DIR;
    else process.env.AIDLC_PROJECT_DIR = priorProject;
    if (priorHarnessDir === undefined) delete process.env.AIDLC_HARNESS_DIR;
    else process.env.AIDLC_HARNESS_DIR = priorHarnessDir;
    if (priorHarnessName === undefined) delete process.env.AIDLC_HARNESS_NAME;
    else process.env.AIDLC_HARNESS_NAME = priorHarnessName;
  }
}

export async function install(targetDir: string): Promise<void> {
  const targetRoot = resolve(targetDir);
  const actions: WriteAction[] = [];
  const collisions: string[] = [];
  const sharedJson = new Set([".cursor/hooks.json", ".cursor/cli.json"]);
  const receiptTarget = join(targetRoot, RECEIPT_REL);
  const priorReceipt = readReceipt(receiptTarget);
  const legacyInstall = priorReceipt === null && isLegacyAidlcInstall(targetRoot);
  const activeSpace = activeSpaceFor(targetRoot);
  const selectedPlugins = activePluginSelection(targetRoot);
  const pluginRuntime = pluginRuntimeState(targetRoot);
  const preservedRuntimeFiles: string[] = [];
  const managedFiles: Record<string, string> = {
    ...(priorReceipt?.managedFiles ?? {}),
  };

  for (const top of [".cursor", "aidlc"]) {
    const sourceRoot = join(DIST_ROOT, top);
    for (const source of filesUnder(sourceRoot)) {
      const rel = relative(DIST_ROOT, source).replaceAll("\\", "/");
      if (sharedJson.has(rel)) continue;
      const target = join(targetRoot, rel);
      const sourceBytes = readFileSync(source);

      // Workspace memory is project-owned after seeding, and active-space is a
      // per-user runtime pointer. Seed missing files but never overwrite them.
      if (rel === "aidlc/active-space" || rel.startsWith("aidlc/spaces/")) {
        if (!existsSync(target)) actions.push({ kind: "copy", source, target });
        continue;
      }

      managedFiles[rel] = sha256(sourceBytes);
      const targetBytes = existsSync(target) ? readFileSync(target) : undefined;
      const desired = managedContent(
        rel,
        sourceBytes,
        activeSpace,
        targetBytes,
        pluginRuntime.modifiedStageSlugs,
      );
      const runtimeOwned = isRuntimeOwnedManagedFile(
        rel,
        selectedPlugins,
        pluginRuntime.composed,
        pluginRuntime.modifiedStageSlugs,
      );
      if (
        targetBytes &&
        runtimeOwned &&
        targetBytes.equals(desired) &&
        !targetBytes.equals(sourceBytes)
      ) {
        preservedRuntimeFiles.push(rel);
      }
      if (!existsSync(target)) {
        actions.push({ kind: "write", target, content: desired });
      } else if (targetBytes?.equals(desired)) {
        // Already current, including an active-space-adjusted Cursor surface.
      } else if (legacyInstall) {
        actions.push({
          kind: "write",
          target,
          content: desired,
        });
      } else if (priorReceipt?.managedFiles[rel] !== undefined) {
        const unchangedSinceInstall =
          sha256(receiptComparableContent(rel, targetBytes!, activeSpace)) ===
          priorReceipt.managedFiles[rel];
        if (
          unchangedSinceInstall ||
          runtimeOwned
        ) {
          actions.push({ kind: "write", target, content: desired });
        } else {
          collisions.push(rel);
        }
      } else {
        collisions.push(rel);
      }
    }
  }

  const hooksTarget = join(targetRoot, ".cursor", "hooks.json");
  const cliTarget = join(targetRoot, ".cursor", "cli.json");
  const hooks = mergeHooks(join(DIST_ROOT, ".cursor", "hooks.json"), hooksTarget);
  const cli = mergeCli(join(DIST_ROOT, ".cursor", "cli.json"), cliTarget);
  actions.push({ kind: "write", target: hooksTarget, content: hooks });
  actions.push({ kind: "write", target: cliTarget, content: cli });

  const agentsSource = readFileSync(join(DIST_ROOT, "AGENTS.md"), "utf-8");
  const agentsTarget = join(targetRoot, "AGENTS.md");
  const agentsExisting = existsSync(agentsTarget) ? readFileSync(agentsTarget, "utf-8") : "";
  actions.push({
    kind: "write",
    target: agentsTarget,
    content: replaceOrAppendMarked(
      agentsExisting,
      agentsSource,
      AGENTS_BEGIN,
      AGENTS_END,
    ),
  });

  const gitignoreSource = readFileSync(join(DIST_ROOT, ".gitignore"), "utf-8");
  const aidlcBlockStart = gitignoreSource.indexOf("# AI-DLC");
  if (aidlcBlockStart === -1) throw new Error("shipped .gitignore has no AI-DLC section");
  const gitignoreTarget = join(targetRoot, ".gitignore");
  const gitignoreExisting = existsSync(gitignoreTarget)
    ? readFileSync(gitignoreTarget, "utf-8")
    : "";
  actions.push({
    kind: "write",
    target: gitignoreTarget,
    content: replaceOrAppendMarked(
      gitignoreExisting || gitignoreSource.slice(0, aidlcBlockStart),
      gitignoreSource.slice(aidlcBlockStart),
      GITIGNORE_BEGIN,
      GITIGNORE_END,
    ),
  });

  if (collisions.length > 0) {
    throw new Error(
      `refusing to overwrite existing files that differ:\n${collisions.map((path) => `  ${path}`).join("\n")}`,
    );
  }

  for (const action of actions) {
    mkdirSync(dirname(action.target), { recursive: true });
    if (action.kind === "copy") cpSync(action.source, action.target);
    else writeFileSync(action.target, action.content, "utf-8");
  }
  if (preservedRuntimeFiles.length > 0) {
    console.log(
      `AI-DLC Cursor installer preserved runtime-managed files:\n${preservedRuntimeFiles
        .sort()
        .map((path) => `  ${path}`)
        .join("\n")}`,
    );
  }
  if (selectedPlugins !== null || pluginRuntime.composed) {
    await refreshPluginRouting(targetRoot);
    console.log("AI-DLC Cursor installer refreshed plugin routing against the upgraded core.");
  }
  mkdirSync(dirname(receiptTarget), { recursive: true });
  writeFileSync(
    receiptTarget,
    `${JSON.stringify(
      { schemaVersion: 1, managedFiles } satisfies InstallReceipt,
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target || target === "--help" || target === "-h") {
    console.log("Usage: bun dist/cursor/install.ts <project-directory>");
    process.exit(target ? 0 : 2);
  }
  try {
    await install(target);
    console.log(`AI-DLC Cursor harness installed into ${resolve(target)}`);
  } catch (error) {
    console.error(`Cursor install failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
