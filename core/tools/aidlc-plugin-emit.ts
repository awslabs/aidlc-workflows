// Shared AIDLC plugin projection engine.
//
// The repository packager passes manifest-derived PluginTarget records directly.
// The shipped build CLI reads the same records from bundled
// tools/data/plugin-targets.json. This module therefore contains projection
// behavior but no framework-checkout or harness-manifest dependency.

import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  assertPluginContentHasNoSymlinks,
  assertSupportedPluginContributionPaths,
  pluginMarketplaceIssue,
  scanPluginFiles,
  walkPluginFiles,
} from "./aidlc-plugin-validate.ts";
import {
  TRUSTED_ROUTE_NAMESPACE,
  trustedCommand,
} from "./aidlc-command.ts";
import { sharedKnowledgeWithoutFormatDocs } from "./aidlc-inline-context.ts";
import { committedTextBytes, runWithOwnerStampedLock } from "./aidlc-lib.ts";
import { EXTENDED_SUBPROCESS_TIMEOUT_MS, LONG_SUBPROCESS_TIMEOUT_MS } from "./aidlc-runtime-budget.ts";

export type PluginTargetKind = "store" | "kiro" | "kiro-ide" | "cursor";

export interface PluginTarget {
  harnessName: string;
  manifestDir: string;
  marketplaceDir: string;
  hostCatalogue: boolean;
  harnessLeaf: string;
  kind: PluginTargetKind;
  installRoots: string[];
}

export type PluginTargetTable = Record<string, PluginTarget>;

export interface BuildPluginProjectionOptions {
  pluginRoot: string;
  target: PluginTarget;
  outDir: string;
  outputBoundary?: string;
  templateHooksDir: string;
  reviewerAgents?: Iterable<string>;
  lockTimeoutMs?: number;
  // Set only by the repository packager, for this repository's own plugins/.
  firstParty?: boolean;
}

export interface PluginProjectionResult {
  pluginName: string;
  harness: string;
  outDir: string;
  // The plugin inside the projection: outDir, or on Kiro its own folder.
  pluginRoot: string;
  files: string[];
}

// AI-DLC's own plugins show in the host as aidlc-<name> in this catalogue; a
// plugin anyone else builds shows under the names its author chose.
export const FIRST_PARTY_MARKETPLACE = "aidlc-plugins";
const FIRST_PARTY_OWNER = { name: "AWS AIDLC" };
const CATALOGUE_DESCRIPTION = "AIDLC plugin catalogue.";
// Kiro has no plugin store, so a plugin is dropped into the project: each one
// in its own folder in AI-DLC's part of .kiro, so a second plugin never lands
// on the first.
const DROPPED_PLUGINS_FOLDER = "aidlc-plugins";

export const PLUGIN_PROJECTION_MARKER = ".aidlc-plugin-projection.json";
const PLUGIN_PROJECTION_MARKER_SCHEMA = 1;
const PLUGIN_PROJECTION_PRODUCER = "aidlc-plugin-build";
const PLUGIN_BUILD_LOCK_TIMEOUT_MS = LONG_SUBPROCESS_TIMEOUT_MS;
const PLUGIN_BUILD_LOCK_RETRY_MS = 25;

const CONTENT_DIRS = [
  "stages",
  "sensors",
  "tools",
  "contributions",
  "scopes",
  "agents",
  "knowledge",
] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function canonicalOutputPath(path: string): string {
  let existing = resolve(path);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  try {
    existing = realpathSync.native(existing);
  } catch {
    // resolve() is still a stable fallback when no ancestor can be realpathed.
  }
  return join(existing, ...missing);
}

// The lock folder is created 0700. Linux shares one /tmp between users, so a
// folder every user shared would belong to whoever built first, and nobody
// else could take a lock in it. Windows keeps the plain name: its temp folder
// is already the user's own.
export function pluginBuildLockPath(outDir: string): string {
  const key = createHash("sha256")
    .update(canonicalOutputPath(outDir))
    .digest("hex");
  const uid = process.getuid?.();
  const folder = uid === undefined
    ? "aidlc-plugin-build-locks"
    : `aidlc-plugin-build-locks-u${uid}`;
  return join(tmpdir(), folder, key);
}

// A lock folder this user cannot write. The plugin build and plugin test
// commands print `fix` as the finding's Fix line in place of their generic one.
export class PluginBuildLockFolderError extends Error {
  readonly fix = "Set TMPDIR to a folder you own, then run the command again.";

  constructor(folder: string, code: string) {
    super(`cannot write the plugin build lock folder "${folder}" (${code})`);
    this.name = "PluginBuildLockFolderError";
  }
}

function withPluginBuildOutputLock<T>(
  outDir: string,
  timeoutMs: number,
  action: () => T,
): T {
  const lockDir = pluginBuildLockPath(outDir);
  const lockFolder = dirname(lockDir);
  // acquireOwnerStampedLock retries every create that fails, so a folder this
  // user cannot write would wait out the whole budget and then read as a busy
  // lock. On Windows access() does not read the ACLs that guard a folder, so it
  // is not asked there.
  try {
    mkdirSync(lockFolder, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      accessSync(lockFolder, constants.W_OK | constants.X_OK);
    }
  } catch (error) {
    if (process.platform === "win32") throw error;
    throw new PluginBuildLockFolderError(
      lockFolder,
      (error as NodeJS.ErrnoException).code ?? String(error),
    );
  }
  const result = runWithOwnerStampedLock(
    lockDir,
    Math.max(0, Math.floor(timeoutMs / PLUGIN_BUILD_LOCK_RETRY_MS)),
    PLUGIN_BUILD_LOCK_RETRY_MS,
    action,
  );
  if (!result.acquired) {
    throw new Error(
      `could not acquire plugin build output lock "${lockDir}" within ${timeoutMs}ms`,
    );
  }
  return result.value;
}

export function readPluginTargets(path: string): PluginTargetTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(
      `cannot read plugin target table ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isPlainRecord(parsed)) {
    throw new Error(`plugin target table ${path} must be a JSON object`);
  }
  const out: PluginTargetTable = {};
  for (const [harness, value] of Object.entries(parsed)) {
    if (
      !isPlainRecord(value) ||
      typeof value.harnessName !== "string" ||
      typeof value.manifestDir !== "string" ||
      (value.marketplaceDir !== undefined && typeof value.marketplaceDir !== "string") ||
      (value.hostCatalogue !== undefined && typeof value.hostCatalogue !== "boolean") ||
      typeof value.harnessLeaf !== "string" ||
      !Array.isArray(value.installRoots) ||
      value.installRoots.some((item) => typeof item !== "string") ||
      (value.kind !== "store" &&
        value.kind !== "kiro" &&
        value.kind !== "kiro-ide" &&
        value.kind !== "cursor")
    ) {
      throw new Error(
        `plugin target table ${path} has an invalid entry for "${harness}"`,
      );
    }
    out[harness] = {
      harnessName: value.harnessName,
      manifestDir: value.manifestDir,
      marketplaceDir: typeof value.marketplaceDir === "string"
        ? value.marketplaceDir
        : value.manifestDir,
      hostCatalogue: value.hostCatalogue === true,
      harnessLeaf: value.harnessLeaf,
      kind: value.kind,
      installRoots: [...value.installRoots],
    };
  }
  return out;
}

export function pluginReviewerAgents(pluginRoot: string): Set<string> {
  const reviewers = new Set<string>();
  for (const file of walkPluginFiles(join(pluginRoot, "stages")).filter((path) =>
    path.endsWith(".md"),
  )) {
    const match = readFileSync(file, "utf-8").match(
      /^reviewer:\s*(\S+)\s*$/m,
    );
    if (match) reviewers.add(match[1]);
  }
  return reviewers;
}

function absorbPluginReviewerKnowledge(
  content: string,
  agentName: string,
  pluginRoot: string,
  reviewers: ReadonlySet<string>,
): string {
  if (!reviewers.has(agentName)) return content;
  const knowledgeDir = join(pluginRoot, "knowledge", agentName);
  if (!existsSync(knowledgeDir)) return content;
  const files = readdirSync(knowledgeDir)
    .filter((file) => file.endsWith(".md"))
    .sort();
  if (files.length === 0) return content;
  const sections = files.map((file) => {
    const text = readFileSync(join(knowledgeDir, file), "utf-8").trim();
    return (
      `<!-- Absorbed at build time from knowledge/${agentName}/${file} - ` +
      `edit that file, not this generated copy. -->\n\n${text}`
    );
  });
  return `${content.trimEnd()}\n\n---\n\n${sections.join("\n\n---\n\n")}\n`;
}

function injectDelegatedKnowledgePreflight(
  content: string,
  agentName: string,
  harnessDir: string,
): string {
  const marker = "<!-- aidlc-delegated-knowledge-preflight -->";
  if (content.includes(marker)) return content;
  const block =
    `${marker}\n` +
    `**Delegated knowledge preflight (mandatory):** Before substantive work, ` +
    `ensure every readable Markdown file under these directories is loaded, in order: ` +
    `${sharedKnowledgeWithoutFormatDocs(harnessDir)}, ` +
    `\`${harnessDir}/knowledge/${agentName}/\`, ` +
    `\`aidlc/spaces/<active-space>/knowledge/aidlc-shared/\`, then ` +
    `\`aidlc/spaces/<active-space>/knowledge/${agentName}/\`. ` +
    `A native resource preload satisfies this requirement; otherwise read the files now. ` +
    `The dispatch brief supplies rules and artifact paths separately.`;
  const frontmatter = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!frontmatter) return `${block}\n\n${content.trimStart()}`;
  return (
    content.slice(0, frontmatter[0].length) +
    `${block}\n\n` +
    content.slice(frontmatter[0].length)
  );
}

function projectCursorPluginAgent(
  source: string,
  sourcePath: string,
): string {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    throw new Error(
      `${sourcePath}: plugin agent has no closed frontmatter block.`,
    );
  }
  const frontmatter = match[1]
    .split(/\r?\n/)
    .filter((line) => !/^(?:model|tier|effort|variant):/.test(line))
    .join("\n");
  return source
    .replace(match[0], () => `---\n${frontmatter}\n---\n`)
    .replaceAll("{{HARNESS_DIR}}", ".cursor");
}

function readPluginManifest(pluginRoot: string): Record<string, unknown> {
  const manifestPath = join(
    pluginRoot,
    ".aidlc-plugin",
    "plugin.json",
  );
  try {
    const parsed = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as unknown;
    if (!isPlainRecord(parsed)) {
      throw new Error("manifest root must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${pluginRoot}: cannot parse ${manifestPath}: ${error instanceof Error ? error.message : String(error)}. Fix the manifest JSON.`,
    );
  }
}

function pluginHostNames(
  pluginName: string,
  manifest: Record<string, unknown>,
  firstParty: boolean,
): { plugin: string; marketplace: string } {
  if (firstParty) {
    return { plugin: `aidlc-${pluginName}`, marketplace: FIRST_PARTY_MARKETPLACE };
  }
  const declared = isPlainRecord(manifest.aidlc) ? manifest.aidlc.marketplace : undefined;
  return {
    plugin: pluginName,
    marketplace: typeof declared === "string" ? declared : pluginName,
  };
}

function droppedIntoProject(kind: PluginTargetKind): boolean {
  return kind === "kiro" || kind === "kiro-ide";
}

// The plugin's folder in a Kiro projection, as the drop puts it in the project.
// Forward slashes: the Kiro IDE hook command names it.
function droppedPluginFolder(harnessLeaf: string, hostName: string): string {
  return `${harnessLeaf}/${DROPPED_PLUGINS_FOLDER}/${hostName}`;
}

type CatalogueEntry = { name: string; source: string; version: unknown; description: unknown };

function catalogueText(name: string, owner: unknown, plugins: CatalogueEntry[]): string {
  return `${JSON.stringify({ name, owner, description: CATALOGUE_DESCRIPTION, plugins }, null, 2)}\n`;
}

// A plugin someone else builds carries its own catalogue; AI-DLC's own share
// one per host format at the root of the tree that holds them (dist/plugins,
// the release runtime's plugins/), so a person adds that folder once and
// installs any of them, and a second plugin of ours never brings a second
// catalogue of the same name. Only the given hosts' catalogues are rewritten.
export function writeFirstPartyCatalogues(
  root: string,
  targets: Iterable<PluginTarget>,
): string[] {
  const plugins = existsSync(root)
    ? readdirSync(root)
      .filter((name) => !name.startsWith(".") && statSync(join(root, name)).isDirectory())
      .sort()
    : [];
  const written: string[] = [];
  for (const target of targets) {
    if (!target.hostCatalogue) continue;
    const entries = plugins.flatMap((plugin): CatalogueEntry[] => {
      const projection = join(root, plugin, target.harnessName);
      if (!existsSync(join(projection, ".aidlc-plugin", "plugin.json"))) return [];
      const manifest = readPluginManifest(projection);
      const name = pluginNameFromManifest(projection, manifest);
      return [{
        name: pluginHostNames(name, manifest, true).plugin,
        source: `./${plugin}/${target.harnessName}`,
        version: manifest.version || "0.0.1",
        description: manifest.description || "",
      }];
    });
    const rel = `${target.marketplaceDir}/marketplace.json`;
    if (entries.length === 0) {
      rmSync(join(root, rel), { force: true });
      continue;
    }
    mkdirSync(join(root, target.marketplaceDir), { recursive: true });
    writeFileSync(join(root, rel), catalogueText(FIRST_PARTY_MARKETPLACE, FIRST_PARTY_OWNER, entries));
    written.push(rel);
  }
  return written;
}

export function projectionPluginRoot(
  outDir: string,
  target: Pick<PluginTarget, "kind" | "harnessLeaf">,
): string {
  if (!droppedIntoProject(target.kind)) return outDir;
  const folder = join(outDir, target.harnessLeaf, DROPPED_PLUGINS_FOLDER);
  const names = existsSync(folder) ? readdirSync(folder) : [];
  if (names.length !== 1) {
    throw new Error(
      `${outDir}: a ${target.kind} projection holds exactly one plugin folder in ${target.harnessLeaf}/${DROPPED_PLUGINS_FOLDER}/`,
    );
  }
  return join(folder, names[0]);
}

function pluginNameFromManifest(
  pluginRoot: string,
  manifest: Record<string, unknown>,
): string {
  if (typeof manifest.name === "string" && manifest.name.trim()) {
    return manifest.name.trim();
  }
  return basename(pluginRoot);
}

function copyHookTemplates(
  pluginRoot: string,
  outDir: string,
  templateHooksDir: string,
  target: PluginTarget,
): void {
  const hooksDir = join(outDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const vendoredCompose = join(pluginRoot, "hooks", "compose.ts");
  const referenceCompose = join(templateHooksDir, "compose.ts");
  if (
    existsSync(vendoredCompose) &&
    !readFileSync(vendoredCompose).equals(readFileSync(referenceCompose))
  ) {
    throw new Error(
      `${vendoredCompose} differs from bundled compose template ${referenceCompose}`,
    );
  }
  for (const file of readdirSync(templateHooksDir).sort()) {
    if (
      file === "aidlc-plugin-compose.ts" &&
      target.kind !== "cursor" &&
      target.kind !== "kiro-ide"
    ) {
      continue;
    }
    const source =
      file === "compose.ts" && existsSync(vendoredCompose)
        ? vendoredCompose
        : join(templateHooksDir, file);
    cpSync(source, join(hooksDir, file));
  }
}

// Cursor and Kiro run a plugin hook in the platform's shell (Cursor: the
// person's shell, or PowerShell on Windows; Kiro: /bin/sh, or cmd.exe), so
// their commands carry no sh -c. The native release runs this, the copy
// channel the Bun launcher. It names its harness: a compiled aidlc otherwise
// takes the first one installed in the project, .claude before the others.
function nativePluginSync(target: PluginTarget): string {
  return `aidlc ${TRUSTED_ROUTE_NAMESPACE} plugin sync --harness-dir ${target.harnessLeaf}`;
}

// The Bun launcher a Kiro IDE registration runs, from the plugin's folder in
// the workspace ("" for the workspace root).
function kiroIdeLauncher(target: PluginTarget, pluginDir: string): string {
  return `bun ./${pluginDir}hooks/aidlc-plugin-compose.ts ${target.harnessLeaf} ${target.harnessName}`;
}

function composeCommand(target: PluginTarget, hostName: string): string {
  const rootExpr =
    target.harnessName === "claude"
      ? `\${CLAUDE_PLUGIN_ROOT}`
      : `\${PLUGIN_ROOT}`;
  if (target.kind === "cursor") {
    return `bun ./hooks/aidlc-plugin-compose.ts ${target.harnessLeaf}`;
  }
  if (target.kind === "kiro-ide") {
    // One entry, as Kiro IDE shows a card for each hook; || reads the same in
    // /bin/sh and cmd.exe. Kiro gives a hook no plugin root, but runs it in the
    // workspace the plugin was dropped into, where the plugin has its own folder.
    const folder = droppedPluginFolder(target.harnessLeaf, hostName);
    return `${nativePluginSync(target)} --plugin-root ./${folder} || ${kiroIdeLauncher(target, `${folder}/`)}`;
  }
  const composePath = `${rootExpr}/hooks/compose.ts`;
  // Probe aidlc on PATH first, then bun on PATH / ~/.bun/bin. If neither is
  // executable, exit 0 with a note rather than running a non-existent binary.
  const aidlcExpr =
    "AIDLC=$(command -v aidlc 2>/dev/null || true); " +
    `[ -n "$AIDLC" ] && { AIDLC_HARNESS_DIR=${target.harnessLeaf} ` +
    `AIDLC_HARNESS_NAME=${target.harnessName} "$AIDLC" ${TRUSTED_ROUTE_NAMESPACE} plugin sync; exit $?; }; `;
  const bunExpr =
    "BUN=$(command -v bun 2>/dev/null || true); " +
    '[ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"; ' +
    `[ -z "$BUN" ] && { echo "${trustedCommand("plugin compose")}: aidlc and bun not found, skipping" >&2; exit 0; }`;
  // Source/tree installs without an aidlc binary still prefer the project's
  // shared plugin tool over the vendored compose fallback.
  const sharedToolExpr =
    `PROJECT_ROOT="\${CLAUDE_PROJECT_DIR:-\${AIDLC_PROJECT_DIR:-$PWD}}"; ` +
    `PLUGIN_TOOL="$PROJECT_ROOT/${target.harnessLeaf}/tools/aidlc-plugin.ts"; ` +
    `[ -f "$PLUGIN_TOOL" ] && { AIDLC_HARNESS_DIR=${target.harnessLeaf} AIDLC_HARNESS_NAME=${target.harnessName} "$BUN" "$PLUGIN_TOOL" sync; exit $?; }; `;
  return (
    `sh -c '${aidlcExpr}${bunExpr}; ${sharedToolExpr}AIDLC_HARNESS_DIR=${target.harnessLeaf} ` +
    `AIDLC_HARNESS_NAME=${target.harnessName} "$BUN" "${composePath}"'`
  );
}

// The Kiro IDE session-start registration a build writes beside the plugin's
// folder. It keeps the AI-DLC name, so a rebuilt plugin's drop replaces its
// own earlier registration instead of running beside it.
export function kiroIdeComposeRegistration(
  target: PluginTarget,
  pluginName: string,
  hostName: string,
): { path: string; text: string } {
  return composeRegistration(target, pluginName, composeCommand(target, hostName));
}

function composeRegistration(
  target: PluginTarget,
  pluginName: string,
  command: string,
): { path: string; text: string } {
  return {
    path: `${target.harnessLeaf}/hooks/aidlc-${pluginName}-compose.json`,
    text: `${JSON.stringify(
      {
        version: "v1",
        hooks: [
          {
            name: `aidlc-${pluginName}-compose`,
            trigger: "SessionStart",
            description: `Composes the ${pluginName} AIDLC plugin at session start.`,
            action: { type: "command", command },
          },
        ],
      },
      null,
      2,
    )}\n`,
  };
}

// The session-start commands Kiro IDE builds have written into a plugin's
// registration, so a drop from an earlier build still reads as the plugin's.
// For a plugin in its own folder: this build's, then the launcher alone, which
// 2.11.1-preview.20261018.1 wrote. With no folder (null): the launcher from the
// workspace root, which 2.11.0 and the 2.11.1 previews before that one wrote,
// as their projection was dropped whole into the workspace.
function writtenComposeCommands(target: PluginTarget, hostName: string | null): string[] {
  if (hostName === null) return [kiroIdeLauncher(target, "")];
  return [
    composeCommand(target, hostName),
    kiroIdeLauncher(target, `${droppedPluginFolder(target.harnessLeaf, hostName)}/`),
  ];
}

// The hook files in a project that are exactly the registrations the builds of
// its dropped plugins wrote, so config can tell them from hook files a person
// added. An edited one is not the plugin's any more; a CRLF checkout is the
// same file.
export function droppedPluginRegistrations(
  projectDir: string,
  harnessLeaf: string,
): string[] {
  const target: PluginTarget = {
    harnessName: "kiro-ide",
    manifestDir: "",
    marketplaceDir: "",
    hostCatalogue: false,
    harnessLeaf,
    kind: "kiro-ide",
    installRoots: [],
  };
  const owned: string[] = [];
  const ownIfWritten = (pluginName: unknown, hostName: string | null): void => {
    if (typeof pluginName !== "string" || !/^[a-z][a-z0-9-]*$/.test(pluginName)) return;
    const written = writtenComposeCommands(target, hostName)
      .map((command) => composeRegistration(target, pluginName, command));
    let onDisk: Buffer;
    try {
      onDisk = committedTextBytes(readFileSync(join(projectDir, written[0].path)));
    } catch {
      // No registration: a Kiro CLI projection writes none.
      return;
    }
    if (written.some(({ text }) => onDisk.equals(Buffer.from(text, "utf-8")))) {
      owned.push(written[0].path);
    }
  };
  const folder = join(projectDir, harnessLeaf, DROPPED_PLUGINS_FOLDER);
  for (const hostName of existsSync(folder) ? readdirSync(folder).sort() : []) {
    let pluginName: unknown;
    try {
      pluginName = (JSON.parse(
        readFileSync(join(folder, hostName, ".aidlc-plugin", "plugin.json"), "utf-8"),
      ) as { name?: unknown }).name;
    } catch {
      continue;
    }
    ownIfWritten(pluginName, hostName);
  }
  const marker = readProjectionMarker(projectDir);
  if (marker?.harness === target.harnessName) ownIfWritten(marker.plugin, null);
  return owned;
}

function writeHookWiring(
  pluginName: string,
  hostName: string,
  outDir: string,
  pluginDir: string,
  target: PluginTarget,
): void {
  if (target.kind === "kiro") return;
  if (target.kind === "kiro-ide") {
    const registration = kiroIdeComposeRegistration(target, pluginName, hostName);
    mkdirSync(join(outDir, target.harnessLeaf, "hooks"), { recursive: true });
    writeFileSync(join(outDir, registration.path), registration.text);
    return;
  }
  const command = composeCommand(target, hostName);
  if (target.kind === "cursor") {
    writeFileSync(
      join(pluginDir, "hooks", "hooks.json"),
      `${JSON.stringify(
        {
          version: 1,
          // Cursor starts every entry on its own and gives a plugin hook its
          // root and workspace in the environment; the one whose runtime is
          // absent fails without stopping the other.
          hooks: { sessionStart: [{ command: nativePluginSync(target) }, { command }] },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  writeFileSync(
    join(pluginDir, "hooks", "hooks.json"),
    `${JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command,
                  // These hosts use seconds on command hooks. Other store
                  // schemas must keep their native fields until verified.
                  ...(["claude", "codex"].includes(target.harnessName)
                    ? { timeout: EXTENDED_SUBPROCESS_TIMEOUT_MS / 1000 }
                    : {}),
                  statusMessage: `AIDLC ${pluginName}: composing plugin`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
}

function copyPluginContent(
  pluginRoot: string,
  outDir: string,
  target: PluginTarget,
  reviewers: ReadonlySet<string>,
): void {
  for (const dir of CONTENT_DIRS) {
    const sourceDir = join(pluginRoot, dir);
    if (!existsSync(sourceDir)) continue;
    for (const file of walkPluginFiles(sourceDir)) {
      const outputDir =
        target.kind === "cursor" && dir === "agents"
          ? join(outDir, "aidlc", "agents")
          : join(outDir, dir);
      const outPath = join(outputDir, relative(sourceDir, file));
      mkdirSync(dirname(outPath), { recursive: true });
      let content = readFileSync(file);
      if (dir === "agents" && file.endsWith("-agent.md")) {
        let projected = absorbPluginReviewerKnowledge(
          content.toString("utf-8"),
          basename(file, ".md"),
          pluginRoot,
          reviewers,
        );
        projected = injectDelegatedKnowledgePreflight(
          projected,
          basename(file, ".md"),
          target.harnessLeaf,
        );
        if (target.kind === "cursor") {
          projected = projectCursorPluginAgent(projected, file);
        }
        content = Buffer.from(projected, "utf-8");
      }
      writeFileSync(outPath, content);
    }
  }
}

function assertBuildPathHasNoSymlinks(
  outDir: string,
  resolvedOut: string,
  outputBoundary: string,
): void {
  const boundary = resolve(outputBoundary);
  const boundaryRelative = relative(boundary, resolvedOut);
  if (
    isAbsolute(boundaryRelative) ||
    boundaryRelative === ".." ||
    boundaryRelative.startsWith(`..${sep}`)
  ) {
    throw new Error(
      `refusing to build into "${outDir}" - output escapes trusted boundary "${boundary}".`,
    );
  }

  let current = boundary;
  for (const segment of boundaryRelative
    .split(sep)
    .filter(Boolean)) {
    current = join(current, segment);
    let currentStat: ReturnType<typeof lstatSync>;
    try {
      currentStat = lstatSync(current);
    } catch {
      return;
    }
    if (!currentStat.isSymbolicLink()) continue;
    if (current === resolvedOut) {
      throw new Error(
        `refusing to build into "${outDir}" - it is a symlink; point at a real directory path.`,
      );
    }
    throw new Error(
      `refusing to build into "${outDir}" - parent path component "${current}" is a symlink; point at a real directory path.`,
    );
  }

  const linked = scanPluginFiles(resolvedOut).symlinks[0];
  if (!linked) return;
  if (linked === resolvedOut) {
    throw new Error(
      `refusing to build into "${outDir}" - it is a symlink; point at a real directory path.`,
    );
  }
  throw new Error(
    `refusing to build into "${outDir}" - existing output contains symlink "${linked}"; remove the link before rebuilding.`,
  );
}

// The marker a build writes at the root of its output, naming the plugin and
// the harness it was built for; null when the folder holds none.
function readProjectionMarker(dir: string): { plugin: string; harness: string } | null {
  try {
    const marker = JSON.parse(readFileSync(join(dir, PLUGIN_PROJECTION_MARKER), "utf-8")) as unknown;
    if (
      isPlainRecord(marker) &&
      marker.schema === PLUGIN_PROJECTION_MARKER_SCHEMA &&
      marker.producer === PLUGIN_PROJECTION_PRODUCER &&
      typeof marker.plugin === "string" &&
      typeof marker.harness === "string"
    ) {
      return { plugin: marker.plugin, harness: marker.harness };
    }
  } catch {
    // No marker, or not JSON.
  }
  return null;
}

export function assertPluginBuildOutput(
  outDir: string,
  target: PluginTarget,
  pluginName: string,
  outputBoundary = outDir,
): void {
  const outArg = outDir.replace(/[/\\]+$/, "") || outDir;
  const resolvedOut = isAbsolute(outArg)
    ? outArg
    : resolve(process.cwd(), outArg);
  assertBuildPathHasNoSymlinks(
    outDir,
    resolvedOut,
    outputBoundary,
  );
  if (!existsSync(resolvedOut)) return;
  if (!statSync(resolvedOut).isDirectory()) {
    throw new Error(
      `refusing to build into "${outDir}" - it is a file, not a directory.`,
    );
  }
  if (readdirSync(resolvedOut).length === 0) return;
  const marker = readProjectionMarker(resolvedOut);
  if (!marker) {
    throw new Error(
      `refusing to build into non-empty "${outDir}" - it has no valid ${PLUGIN_PROJECTION_MARKER} ownership marker. ` +
        "Point at a fresh/empty directory.",
    );
  }
  if (
    marker.plugin !== pluginName ||
    marker.harness !== target.harnessName
  ) {
    throw new Error(
      `refusing to replace "${outDir}" - its ${PLUGIN_PROJECTION_MARKER} belongs to ` +
        `plugin "${marker.plugin}" for harness "${marker.harness}", not plugin "${pluginName}" ` +
        `for harness "${target.harnessName}".`,
    );
  }
}

export function buildPluginProjection(
  options: BuildPluginProjectionOptions,
): PluginProjectionResult {
  const pluginRoot = resolve(options.pluginRoot);
  const outDir = resolve(options.outDir);
  assertBuildPathHasNoSymlinks(
    options.outDir,
    outDir,
    options.outputBoundary ?? outDir,
  );
  assertPluginContentHasNoSymlinks(pluginRoot);
  const manifest = readPluginManifest(pluginRoot);
  const pluginName = pluginNameFromManifest(pluginRoot, manifest);
  assertSupportedPluginContributionPaths(manifest);
  const firstParty = options.firstParty === true;
  const marketplaceIssue = firstParty ? null : pluginMarketplaceIssue(manifest.aidlc);
  if (marketplaceIssue) {
    throw new Error(`.aidlc-plugin/plugin.json: ${marketplaceIssue.message}`);
  }
  const host = pluginHostNames(pluginName, manifest, firstParty);
  const version = manifest.version || "0.0.1";
  const author = manifest.author || { name: "AIDLC" };
  const description = manifest.description || "";
  const reviewers = new Set(
    options.reviewerAgents ?? pluginReviewerAgents(pluginRoot),
  );

  return withPluginBuildOutputLock(
    outDir,
    options.lockTimeoutMs ?? PLUGIN_BUILD_LOCK_TIMEOUT_MS,
    () => {
      assertPluginBuildOutput(
        options.outDir,
        options.target,
        pluginName,
        options.outputBoundary ?? outDir,
      );

      rmSync(outDir, { recursive: true, force: true });
      mkdirSync(outDir, { recursive: true });
      const pluginDir = droppedIntoProject(options.target.kind)
        ? join(outDir, droppedPluginFolder(options.target.harnessLeaf, host.plugin))
        : outDir;
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(outDir, PLUGIN_PROJECTION_MARKER),
        `${JSON.stringify(
          {
            schema: PLUGIN_PROJECTION_MARKER_SCHEMA,
            producer: PLUGIN_PROJECTION_PRODUCER,
            plugin: pluginName,
            harness: options.target.harnessName,
          },
          null,
          2,
        )}\n`,
      );

      // The plugin's own manifest travels with every projection, because
      // plugin sync reads the base it builds on from there. A host manifest
      // cannot carry it: Claude Code reads a `dependencies` key there as host
      // plugins to enable.
      mkdirSync(join(pluginDir, ".aidlc-plugin"), { recursive: true });
      cpSync(
        join(pluginRoot, ".aidlc-plugin", "plugin.json"),
        join(pluginDir, ".aidlc-plugin", "plugin.json"),
      );

      const hostManifestDir = join(pluginDir, options.target.manifestDir);
      mkdirSync(hostManifestDir, { recursive: true });
      writeFileSync(
        join(hostManifestDir, "plugin.json"),
        `${JSON.stringify(
          {
            name: host.plugin,
            version,
            description,
            author,
          },
          null,
          2,
        )}\n`,
      );
      if (!firstParty) {
        const marketplaceDir = join(pluginDir, options.target.marketplaceDir);
        mkdirSync(marketplaceDir, { recursive: true });
        writeFileSync(
          join(marketplaceDir, "marketplace.json"),
          catalogueText(host.marketplace, author, [
            { name: host.plugin, source: ".", version, description },
          ]),
        );
      }

      copyHookTemplates(
        pluginRoot,
        pluginDir,
        options.templateHooksDir,
        options.target,
      );
      writeHookWiring(pluginName, host.plugin, outDir, pluginDir, options.target);
      copyPluginContent(pluginRoot, pluginDir, options.target, reviewers);

      return {
        pluginName,
        harness: options.target.harnessName,
        outDir,
        pluginRoot: pluginDir,
        files: walkPluginFiles(outDir).map((file) =>
          relative(outDir, file).split(sep).join("/"),
        ),
      };
    },
  );
}
